import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CaptureRecord, DisplayInfo, Rect } from '../../../shared/types.js';
import { DEFAULT_CAPTURE } from '../../../shared/geometry.js';
import { elementLine, rectText } from '../../../shared/uitree.js';
import { windowLine } from '../../../shared/windows.js';
import { listDisplays, resolveDisplay } from '../../displays.js';
import { captureDisplay, captureWindow } from '../../capture.js';
import { findElements, listWindows, occlusionOf, ocrImage, resolveRefs, resolveWindow } from '../../uia.js';
import { toDisplayLocal } from '../../anchors.js';
import { describeWindowAsText } from '../../describe.js';
import { WINDOW, guarded, regionField, selectorFields, text, type Result } from './common.js';

/** Reading the screen: list_windows, describe_window, find_ui_elements, read_text, capture_screen. */

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
                const windows = await listWindows();
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
                return text(`${list}\ndisplays: ${displays}`);
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
            guarded('describe_window', async () =>
                text(
                    await describeWindowAsText({
                        window: await resolveWindow(args.window),
                        maxNodes: args.maxNodes,
                        maxDepth: args.maxDepth,
                        includeRects: args.includeRects,
                        since: args.since
                    })
                )
            )
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
                const found = await findElements({
                    window: args.window ? await resolveWindow(args.window) : undefined,
                    name: args.name,
                    role: args.role,
                    automationId: args.automationId,
                    limit: args.limit
                });
                if (found.length === 0) {
                    return text(
                        'No matching controls. If describe_window is empty here too, the app exposes no ' +
                            'accessibility tree: use read_text or capture_screen.'
                    );
                }
                return text(`${found.length} match(es):\n${found.map(elementLine).join('\n')}`);
            })
    );

    // --------------------------------------------------------------- read text
    server.registerTool(
        'read_text',
        {
            title: 'Read text off the screen',
            description:
                'OCR a window or region; returns each line with its rect in the pixels of the capture it ' +
                'takes, so annotate can point at any line. For canvas, games and remote desktops, where ' +
                'describe_window is empty.',
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
                let display = resolveDisplay(args.display, listDisplays());
                let region = args.region;
                if (args.window) ({ display, region } = await windowRegion(await resolveWindow(args.window)));

                // Native resolution on purpose. Downscaling is how a screenshot
                // saves tokens, but OCR returns text rather than pixels, so
                // shrinking only costs accuracy -- measured as badly garbled
                // output on a 1568px-wide full-screen shot.
                const record = await captureDisplay({ display, region, maxDimension: 4096, grid: false });

                const needle = args.contains?.toLowerCase();
                const lines = (await ocrImage(record.path)).filter(
                    l => !needle || l.text.toLowerCase().includes(needle)
                );
                if (lines.length === 0) {
                    return text(
                        needle
                            ? `No line containing "${args.contains}" was recognised.`
                            : 'No text was recognised there.'
                    );
                }
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
                        'Longest edge. Default 1568 within 1.15MP, the most any Claude model takes without ' +
                            'rescaling; high-res models take 2576.'
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
                    const window = await resolveWindow(args.window);
                    const record = await captureWindow({ windowRef: window, maxDimension, maxPixels, grid: args.grid });
                    return withImage(captureBody(record, `window ${window}`), record, args.returnImage);
                }

                let display = resolveDisplay(args.display, listDisplays());
                let region = args.region;
                let warning = '';
                if (args.window) {
                    const window = await resolveWindow(args.window);
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
