import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CaptureRecord, DisplayInfo, Rect } from '../../../shared/types.js';
import { DEFAULT_CAPTURE } from '../../../shared/geometry.js';
import { clean, elementLine, rectText } from '../../../shared/uitree.js';
import { windowFlags, windowLine, windowOffsets } from '../../../shared/windows.js';
import { listDisplays, resolveDisplay } from '../../displays.js';
import { captureDisplay, captureWindow, type WindowCapture } from '../../capture.js';
import {
    findElements,
    listAllWindows,
    occlusionOf,
    ocrImage,
    resolveRefs,
    resolveWindowInfo,
    type OcrLine
} from '../../uia.js';
import { toDisplayLocal } from '../../anchors.js';
import { describeWindowAsText } from '../../describe.js';
import { missHint } from './anchoring.js';
import { WINDOW, guarded, regionField, selectorFields, text, type Result } from './common.js';

/** Reading the screen: list_windows, describe_window, find_ui_elements, read_text, capture_screen. */

/**
 * OCR wants every pixel, with no area cap: downscaling is how a screenshot
 * saves tokens, but OCR returns text rather than pixels, so shrinking only
 * costs accuracy -- measured as badly garbled output on a 1568px-wide
 * full-screen shot. The edge limit only bites beyond a 4K display.
 */
const NATIVE = 4096;

/**
 * A window's rectangle as a capture region: its display, and the region in that
 * display's physical pixels.
 *
 * Window rects arrive in virtual-screen physical pixels, which can be negative
 * across monitors. They go through the same conversion the anchor tracker uses,
 * then back out to the display's physical pixels.
 */
async function windowRegion(ref: string): Promise<{ display: DisplayInfo; region: Rect }> {
    const [resolved] = await resolveRefs([ref]);
    if (!resolved?.rect) throw new Error(`window ${ref} could not be resolved; it may have closed or been minimised`);
    const placed = toDisplayLocal(resolved.rect);
    const display = listDisplays().find(d => d.id === placed.displayId);
    if (!display) throw new Error('that window is on a display that is no longer connected');
    const k = display.scaleFactor;
    return {
        display,
        region: {
            x: Math.round(placed.rect.x * k),
            y: Math.round(placed.rect.y * k),
            width: Math.round(placed.rect.width * k),
            height: Math.round(placed.rect.height * k)
        }
    };
}

/**
 * Resolve a window for reading its pixels. A minimised window has none to read,
 * so that is an error saying how to get it back rather than a blank image.
 */
async function readableWindow(query: string): Promise<{ ref: string; note?: string }> {
    const w = await resolveWindowInfo(query);
    if (w.window?.minimized) throw new Error(w.note ?? `window ${w.ref} is minimized: focus_window restores it.`);
    return w;
}

/**
 * Say when "the window's pixels" are really the screen's: then anything on top
 * of the window is in them, labelled as the window. That is the confident wrong
 * read that rendering the window itself exists to prevent.
 */
async function screenPixelsWarning(window: string, why: string): Promise<string> {
    const occ = await occlusionOf(window).catch(() => null);
    if (occ && occ.covered > 0.02) {
        return (
            `\nWARNING: ${why}, so this is the screen there, and about ${Math.round(occ.covered * 100)}% of the ` +
            `window is covered by ${occ.by.slice(0, 3).join(', ')}; those pixels are theirs. focus_window first.`
        );
    }
    return `\nNote: ${why}, so this is the screen there; nothing covered the window.`;
}

function captureBody(record: CaptureRecord, source: string): string {
    // Worth a few tokens: a downscaled image is the usual reason small text is
    // unreadable, and the fix (a window or region capture) is cheap.
    const scaled = record.imageScale < 0.999 ? `, downscaled ${record.imageScale.toFixed(3)}x` : '';
    return (
        `${record.id}: ${record.imageSize.width}x${record.imageSize.height} of ${source}${scaled}\n` +
        `path: ${record.path}\n` +
        'Coordinates read off it work as-is in annotate, which defaults to the latest capture.'
    );
}

async function withImage(body: string, record: CaptureRecord, inline: boolean): Promise<Result> {
    if (!inline) return text(body);
    const { readFileSync } = await import('node:fs');
    return {
        content: [
            { type: 'text', text: body },
            { type: 'image', data: readFileSync(record.path).toString('base64'), mimeType: 'image/png' }
        ]
    };
}

/**
 * OCR one window, as lines whose rects are offsets from the window's visible
 * top-left: exactly what an anchor {window} takes, so a drawing on a line
 * follows the window instead of going stale in screen space.
 *
 * Reads the window's own render first, so a window behind another is still
 * read correctly. A render that failed, fell back to the screen, or came back
 * blank (GPU surfaces) is replaced by, or treated as, a screen crop, with a
 * warning naming whatever covers the window.
 */
async function readWindow(ref: string): Promise<{ record: CaptureRecord; lines: OcrLine[]; warning: string }> {
    const shot: WindowCapture | null = await captureWindow({ windowRef: ref, maxDimension: NATIVE, grid: false }).catch(
        () => null
    );
    if (shot && !shot.blank) {
        const [visible] = await resolveRefs([ref]);
        const origin = visible?.rect ?? shot.rect;
        const lines = (await ocrImage(shot.record.path)).map(l => ({
            text: l.text,
            rect: windowOffsets(l.rect, shot.record.imageScale, shot.rect, origin)
        }));
        const warning = shot.record.fallback
            ? await screenPixelsWarning(ref, 'the window refused to render itself')
            : '';
        return { record: shot.record, lines, warning };
    }

    const why = shot
        ? 'the window rendered blank (a GPU surface, which only the screen shows)'
        : 'the window could not render itself';
    const { display, region } = await windowRegion(ref);
    const record = await captureDisplay({ display, region, maxDimension: NATIVE, grid: false });
    // The crop starts at the window's visible top-left unless the display edge
    // clipped it, so offset by wherever it really starts.
    const lines = (await ocrImage(record.path)).map(l => ({
        text: l.text,
        rect: windowOffsets(l.rect, record.imageScale, record.regionPhysical, region)
    }));
    return { record, lines, warning: await screenPixelsWarning(ref, why) };
}

export function registerRead(server: McpServer): void {
    // ----------------------------------------------------------------- windows
    server.registerTool(
        'list_windows',
        {
            title: 'List windows and displays',
            description:
                'Visible windows (ref, size@position, title) and displays. Usually unnecessary: every window ' +
                'parameter also takes a title substring or "foreground".',
            inputSchema: {},
            annotations: { readOnlyHint: true }
        },
        () =>
            guarded('list_windows', async () => {
                const all = await listAllWindows();
                const windows = all.filter(w => !w.minimized && !w.cloaked);
                // Listed apart, because the user cannot see them: answering "not
                // open" for a minimised app sent agents planning around a closed one.
                const unseen = all.filter(w => w.minimized || w.cloaked);
                const displays = listDisplays()
                    .map(
                        d =>
                            `${d.id}${d.primary ? ' primary' : ''} ` +
                            `${d.physicalSize.width}x${d.physicalSize.height} scale ${d.scaleFactor}`
                    )
                    .join('; ');
                const list = windows.length
                    ? `${windows.length} window(s), ref WxH@x,y title:\n${windows.map(windowLine).join('\n')}`
                    : 'No visible windows.';
                const hidden = unseen.length
                    ? `\nnot visible (focus_window shows one): ${unseen
                          .slice(0, 8)
                          .map(w => `${w.ref} "${clean(w.title).slice(0, 50)}"${windowFlags(w)}`)
                          .join(', ')}${unseen.length > 8 ? ', …' : ''}`
                    : '';
                return text(`${list}\ndisplays: ${displays}${hidden}`);
            })
    );

    // ---------------------------------------------------------------- describe
    server.registerTool(
        'describe_window',
        {
            title: 'Read a window as text',
            description:
                'A window\'s controls as an indented tree, one per line: name [role] "value", disabled, ' +
                'id=AutomationId, ref. The cheap way to see a screen (a few hundred tokens vs ~1.5k for a ' +
                'screenshot) and every ref is anchorable. Pass since=<snapshotId> for only what changed. ' +
                'Empty for canvas, games and some web content: then read_text, then capture_screen.',
            inputSchema: {
                window: z.string().describe(WINDOW),
                since: z.string().optional().describe('snapshotId from an earlier call.'),
                maxNodes: z.number().int().min(1).max(1000).default(120),
                maxDepth: z.number().int().min(1).max(40).default(25),
                includeRects: z.boolean().default(false)
            },
            annotations: { readOnlyHint: true }
        },
        args =>
            guarded('describe_window', async () => {
                const w = await resolveWindowInfo(args.window);
                const body = await describeWindowAsText({
                    window: w.ref,
                    maxNodes: args.maxNodes,
                    maxDepth: args.maxDepth,
                    includeRects: args.includeRects,
                    since: args.since,
                    info: w.window
                });
                // A minimised window's describe already says so in its own words.
                return text(w.note && !w.window?.minimized ? `Note: ${w.note}\n${body}` : body);
            })
    );

    // ---------------------------------------------------------------- elements
    server.registerTool(
        'find_ui_elements',
        {
            title: 'Find UI controls',
            description:
                'Search a window\'s controls by name substring, role or AutomationId; returns rects and refs. ' +
                'To draw on a match, skip this and anchor annotate to {window, name} directly.',
            inputSchema: {
                window: z.string().optional().describe(`${WINDOW} Omit to search the whole desktop (slow).`),
                ...selectorFields(),
                role: z
                    .string()
                    .optional()
                    .describe('Control type: button, edit, checkbox, combobox, menuitem, listitem, tabitem, link, text…'),
                limit: z.number().int().min(1).max(200).default(25)
            },
            annotations: { readOnlyHint: true }
        },
        args =>
            guarded('find_ui_elements', async () => {
                const w = args.window ? await resolveWindowInfo(args.window) : undefined;
                const selector = { name: args.name, role: args.role, automationId: args.automationId };
                const found = await findElements({ window: w?.ref, ...selector, limit: args.limit });
                const note = w?.note ? `Note: ${w.note}\n` : '';
                if (found.length === 0) {
                    // A scoped miss can say where the control is hiding, or what
                    // it is probably called, instead of sending for a describe.
                    const hint =
                        w && (args.name || args.automationId)
                            ? await missHint({ window: w.ref, ...selector }, w.window)
                            : '';
                    const fallback =
                        ' If describe_window is empty here too, the app exposes no accessibility tree: use ' +
                        'read_text or capture_screen.';
                    return text(`${note}No matching controls.${hint || fallback}`);
                }
                return text(`${note}${found.length} match(es):\n${found.map(elementLine).join('\n')}`);
            })
    );

    // --------------------------------------------------------------- read text
    server.registerTool(
        'read_text',
        {
            title: 'Read text off the screen',
            description:
                'OCR a window or region; returns each line with a rect annotate can point at. For canvas, ' +
                'games and remote desktops, where describe_window is empty.',
            inputSchema: {
                window: z.string().optional().describe(WINDOW),
                display: z.string().optional().describe('Display, when not using window.'),
                region: regionField(),
                contains: z.string().optional().describe('Only lines containing this, case-insensitive.')
            },
            annotations: { readOnlyHint: true }
        },
        args =>
            guarded('read_text', async () => {
                const needle = args.contains?.toLowerCase();
                const keep = (l: OcrLine): boolean => !needle || l.text.toLowerCase().includes(needle);
                const none = needle
                    ? `No line containing "${args.contains}" was recognised.`
                    : 'No text was recognised there.';

                if (args.window) {
                    const w = await readableWindow(args.window);
                    const { record, lines, warning } = await readWindow(w.ref);
                    const note = w.note ? `\nNote: ${w.note}` : '';
                    const hits = lines.filter(keep);
                    // The warning matters most here: "no text" from the wrong pixels is not "no text".
                    if (hits.length === 0) return text(none + warning + note);
                    return text(
                        `${hits.length} line(s) in window ${w.ref} (${record.id}). x,y are offsets from the window's ` +
                            `top-left: annotate with anchor {window:"${w.ref}"} and these numbers so drawings follow it.\n` +
                            hits.map(l => `${rectText(l.rect)}  ${l.text}`).join('\n') +
                            warning +
                            note
                    );
                }

                const display = resolveDisplay(args.display, listDisplays());
                const record = await captureDisplay({ display, region: args.region, maxDimension: NATIVE, grid: false });
                const lines = (await ocrImage(record.path)).filter(keep);
                if (lines.length === 0) return text(none);
                return text(
                    `${lines.length} line(s) in ${record.id} (${record.imageSize.width}x${record.imageSize.height}; ` +
                        'annotate in these pixels):\n' +
                        lines.map(l => `${rectText(l.rect)}  ${l.text}`).join('\n')
                );
            })
    );

    // ----------------------------------------------------------------- capture
    server.registerTool(
        'capture_screen',
        {
            title: 'Capture the screen',
            description:
                'Screenshot to a PNG; returns its path for your file-reading tool. Costs ~1.5k tokens to view, ' +
                'so use it to SEE colours, layout, images or a rendering bug, not to read text or find controls. ' +
                'With window, renders just that window, correct even if covered. Excludes the overlay itself.',
            inputSchema: {
                window: z.string().optional().describe(WINDOW),
                display: z.string().optional().describe('Display id, 1-based index, or "primary".'),
                region: regionField(),
                asRendered: z
                    .boolean()
                    .default(false)
                    .describe('With window: crop the screen instead, including whatever covers it.'),
                maxDimension: z
                    .number()
                    .int()
                    .min(256)
                    .max(4096)
                    .optional()
                    .describe(
                        'Longest edge. Default 1568 within 1.15MP, which no Claude model rescales; high-res ' +
                            'models take 2576.'
                    ),
                grid: z.boolean().default(false).describe('Burn in a labelled coordinate grid.'),
                returnImage: z
                    .boolean()
                    .default(false)
                    .describe('Also inline the image. Some clients bill inline images as text, at ~10x.')
            },
            annotations: { readOnlyHint: true }
        },
        args =>
            guarded('capture_screen', async () => {
                // An explicit size is a deliberate choice for a model that takes
                // larger images, so only the default carries the area cap.
                const maxDimension = args.maxDimension ?? DEFAULT_CAPTURE.maxDimension;
                const maxPixels = args.maxDimension === undefined ? DEFAULT_CAPTURE.maxPixels : undefined;

                // Rendering the window is the default: cropping the screen to its
                // rectangle returns whatever is drawn there, which is the topmost
                // window, not necessarily the one that was asked for.
                if (args.window && !args.asRendered) {
                    const w = await readableWindow(args.window);
                    const shot = await captureWindow({ windowRef: w.ref, maxDimension, maxPixels, grid: args.grid });
                    let warning = shot.record.fallback
                        ? await screenPixelsWarning(w.ref, 'the window refused to render itself')
                        : '';
                    if (shot.blank) {
                        warning +=
                            '\nNote: the window rendered as one flat colour, which is how GPU and DirectX ' +
                            'surfaces render; asRendered:true crops the screen instead.';
                    }
                    const note = w.note ? `\nNote: ${w.note}` : '';
                    const body = captureBody(shot.record, `window ${w.ref}`) + warning + note;
                    return withImage(body, shot.record, args.returnImage);
                }

                let display = resolveDisplay(args.display, listDisplays());
                let region = args.region;
                let warning = '';
                if (args.window) {
                    const window = (await readableWindow(args.window)).ref;
                    const occ = await occlusionOf(window).catch(() => null);
                    if (occ && occ.covered > 0.02) {
                        warning =
                            `\nWARNING: about ${Math.round(occ.covered * 100)}% of this window is covered by ` +
                            `${occ.by.slice(0, 3).join(', ')}; those pixels are theirs. Drop asRendered, or ` +
                            'focus_window first.';
                    }
                    ({ display, region } = await windowRegion(window));
                }

                const record = await captureDisplay({ display, region, maxDimension, maxPixels, grid: args.grid });
                return withImage(captureBody(record, `display ${display.id}`) + warning, record, args.returnImage);
            })
    );
}
