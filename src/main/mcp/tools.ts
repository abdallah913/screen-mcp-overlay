import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type {
    Annotation,
    AnchorSelector,
    CaptureRecord,
    CoordSpace,
    DisplayInfo,
    Point,
    Rect,
    ShapeType
} from '../../shared/types.js';
import {
    clampRectToDisplay,
    physicalToDipPoint,
    physicalToDipRect,
    toPhysicalPoint,
    toPhysicalRect
} from '../../shared/geometry.js';
import { listDisplays, resolveDisplay } from '../displays.js';
import { captureDisplay, captureWindow } from '../capture.js';
import { store } from '../store.js';
import { requestClicks } from '../clicks.js';
import { postToHud, speak } from '../hud.js';
import {
    findElements,
    focusWindow,
    listWindows,
    occlusionOf,
    ocrImage,
    resolveRefs,
    scrollWindow
} from '../uia.js';
import { geometryFor, toDisplayLocal, wakeAnchorTracking } from '../anchors.js';
import { waitForElement } from '../waits.js';
import { describeWindowAsText } from '../describe.js';

type Text = { type: 'text'; text: string };
const text = (t: string): { content: Text[] } => ({ content: [{ type: 'text', text: t }] });
const fail = (t: string): { content: Text[]; isError: true } => ({
    content: [{ type: 'text', text: t }],
    isError: true
});

const SHAPE_TYPES = ['box', 'highlight', 'circle', 'arrow', 'label', 'spotlight', 'step'] as const;

const DEFAULT_COLORS: Record<ShapeType, string> = {
    box: '#ff3b30',
    highlight: '#ffd60a',
    circle: '#ff3b30',
    arrow: '#ff3b30',
    label: '#ffffff',
    spotlight: '#000000',
    step: '#0a84ff'
};

/** Resolve which coordinate space and reference capture a call is working in. */
function resolveSpace(
    space: CoordSpace | undefined,
    captureId: string | undefined,
    displayRef: string | undefined,
    displays: DisplayInfo[]
): { space: CoordSpace; capture?: CaptureRecord; display: DisplayInfo } {
    const explicit = captureId ? store.capture(captureId) : undefined;
    if (captureId && !explicit) {
        throw new Error(`unknown captureId "${captureId}". Take a screenshot first with capture_screen.`);
    }

    // Default to image space when there is a screenshot to anchor against, since
    // that is the space an agent is actually reading numbers off.
    const chosen: CoordSpace =
        space ?? (explicit || (!displayRef && store.latestCapture()) ? 'image' : 'physical');

    if (chosen === 'image') {
        const capture = explicit ?? store.latestCapture();
        if (!capture) {
            throw new Error(
                'space "image" needs a screenshot to reference; call capture_screen first, or pass space:"physical".'
            );
        }
        const display = displays.find(d => d.id === capture.displayId);
        if (!display) throw new Error(`the display for capture ${capture.id} is no longer connected`);
        return { space: chosen, capture, display };
    }
    return { space: chosen, display: resolveDisplay(displayRef, displays) };
}

interface ShapeInput {
    type: ShapeType;
    x: number;
    y: number;
    width?: number;
    height?: number;
    toX?: number;
    toY?: number;
    text?: string;
    color?: string;
    thickness?: number;
    dim?: number;
    pulse?: boolean;
    fit?: boolean;
    pad?: number;
}

/**
 * Anchored shapes take a different path from fixed ones: rather than resolving
 * coordinates once, they store offsets from a live target and let the tracker
 * recompute their position every tick. That is what stops a box drifting off the
 * button it was drawn around the moment the user moves the window.
 */
async function createAnchored(
    anchor: {
        kind: 'window' | 'element' | 'name';
        ref?: string;
        window?: string;
        name?: string;
        role?: string;
        automationId?: string;
    },
    shapes: ShapeInput[],
    opts: { replace: boolean; ttlMs: number }
): Promise<{ content: Text[]; isError?: true }> {
    let kind: 'window' | 'element' = anchor.kind === 'window' ? 'window' : 'element';
    let ref = anchor.ref ?? '';
    let selector: AnchorSelector | undefined;
    let anchorRect: Rect | undefined;

    if (anchor.kind === 'name') {
        // Resolve the selector here so pointing at a control is one call rather
        // than find_ui_elements, read the result, then annotate.
        if (!anchor.window || !(anchor.name || anchor.role || anchor.automationId)) {
            return fail('anchor kind "name" needs window plus name, role or automationId');
        }
        selector = {
            window: anchor.window,
            name: anchor.name,
            role: anchor.role,
            automationId: anchor.automationId
        };
        const [found] = await findElements({
            window: selector.window,
            name: selector.name,
            role: selector.role,
            automationId: selector.automationId,
            limit: 1
        });
        if (!found) {
            return fail(
                `no control matching ${JSON.stringify({ name: anchor.name, role: anchor.role })} in that window. ` +
                    'Use describe_window to see what is actually there.'
            );
        }
        ref = found.ref;
        anchorRect = found.rect;
        kind = 'element';
    } else {
        if (!ref) return fail(`anchor kind "${anchor.kind}" needs a ref`);
        const [resolved] = await resolveRefs([ref]);
        if (!resolved?.rect) {
            return fail(
                `anchor ${ref} could not be resolved — the ${anchor.kind} may have closed, ` +
                    'been minimised, or the layout changed. Re-run list_windows or find_ui_elements.'
            );
        }
        anchorRect = resolved.rect;
    }
    const expiresAt = opts.ttlMs > 0 ? Date.now() + opts.ttlMs : undefined;
    const created: Annotation[] = [];
    let stepNumber = 0;

    for (const s of shapes) {
        const fit = s.fit ?? false;
        const needsRect = s.type !== 'arrow' && s.type !== 'label';
        if (!fit && needsRect && (s.width === undefined || s.height === undefined)) {
            return fail(`shape "${s.type}" needs width and height, or fit:true to match the target`);
        }
        if (s.type === 'arrow' && (s.toX === undefined || s.toY === undefined)) {
            return fail('shape "arrow" requires toX and toY');
        }
        if (s.type === 'step') stepNumber += 1;

        const spec = {
            kind,
            ref,
            label: selector?.name ?? ref,
            fit,
            pad: s.pad ?? 4,
            offset: fit
                ? undefined
                : { x: s.x, y: s.y, width: s.width ?? 0, height: s.height ?? 0 },
            toOffset: s.type === 'arrow' ? { x: s.toX!, y: s.toY! } : undefined,
            selector
        };

        const partial: Annotation = {
            id: store.nextId('ann'),
            displayId: '',
            type: s.type,
            rect: { x: 0, y: 0, width: 0, height: 0 },
            text: s.type === 'step' ? s.text ?? String(stepNumber) : s.text,
            color: s.color ?? DEFAULT_COLORS[s.type],
            thickness: s.thickness ?? 3,
            dim: s.dim ?? 0.6,
            pulse: s.pulse ?? false,
            expiresAt,
            createdAt: Date.now(),
            anchor: spec
        };

        // Place it immediately so it appears without waiting for a tracker tick.
        const geom = geometryFor(partial, anchorRect);
        created.push({ ...partial, displayId: geom.displayId, rect: geom.rect, to: geom.to });
    }

    if (opts.replace) store.clear();
    store.add(created);
    // A fresh anchor is usually about to be dragged or watched; do not make it
    // wait out a backed-off poll interval.
    wakeAnchorTracking();

    return text(
        `Drew ${created.length} shape(s) anchored to ${kind} ${selector?.name ?? ref}. ` +
            `Ids: ${created.map(a => a.id).join(', ')}. ` +
            (selector
                ? 'They follow the target as it moves or resizes, and are re-found by name if it is recreated.'
                : 'They follow the target as it moves or resizes, and hide themselves if it goes away.')
    );
}

export function registerTools(server: McpServer): void {
    // ----------------------------------------------------------------- capture
    server.registerTool(
        'capture_screen',
        {
            title: 'Capture the screen',
            description:
                'Screenshot to disk; returns a path for your file-reading tool. EXPENSIVE (~1.8k tokens) -- prefer ' +
                'describe_window. Use when you must SEE: colours, layout, images, rendering bugs, or when the ' +
                'accessibility tree is empty (canvas, games, browser page content). The overlay excludes itself. ' +
                'Read coordinates off the image and pass them back with space:"image".',
            inputSchema: {
                display: z.string().optional().describe('Display id, 1-based index, or "primary".'),
                window: z
                    .string()
                    .optional()
                    .describe(
                        'Window ref from list_windows. Renders that window itself, so the image is correct even ' +
                            'when other windows are on top. More detail per token than a full-screen capture.'
                    ),
                asRendered: z
                    .boolean()
                    .default(false)
                    .describe(
                        'With window: crop the screen instead of rendering the window, i.e. show what the user ' +
                            'actually sees including anything covering it. Reports how much is occluded.'
                    ),
                region: z
                    .object({
                        x: z.number(),
                        y: z.number(),
                        width: z.number(),
                        height: z.number()
                    })
                    .optional()
                    .describe('Sub-region in display physical px.'),
                maxDimension: z
                    .number()
                    .int()
                    .min(256)
                    .max(4096)
                    .default(1568)
                    .describe('Longest edge of the PNG.'),
                grid: z
                    .boolean()
                    .default(false)
                    .describe('Burn a coordinate grid into the image for precise aiming.'),
                returnImage: z
                    .boolean()
                    .default(false)
                    .describe('Inline base64 too. Off by default: some clients render it as text at 10-20x cost.')
            },
            annotations: { readOnlyHint: true }
        },
        async args => {
            try {
                // Rendering the window is the default: cropping the screen to its
                // rectangle returns whatever is drawn there, which is the topmost
                // window, not necessarily the one that was asked for.
                if (args.window && !args.asRendered) {
                    const record = await captureWindow({
                        windowRef: args.window,
                        maxDimension: args.maxDimension,
                        grid: args.grid
                    });
                    const body =
                        `Rendered window ${args.window}: ${record.imageSize.width}x${record.imageSize.height}.\n` +
                        `captureId: ${record.id}\npath: ${record.path}\n\n` +
                        'This is the window\'s own content, so anything on top of it does not appear. ' +
                        'Annotate with space:"image" and this captureId.';
                    if (!args.returnImage) return text(body);
                    const { readFileSync } = await import('node:fs');
                    return {
                        content: [
                            { type: 'text' as const, text: body },
                            {
                                type: 'image' as const,
                                data: readFileSync(record.path).toString('base64'),
                                mimeType: 'image/png'
                            }
                        ]
                    };
                }

                const displays = listDisplays();
                let display = resolveDisplay(args.display, displays);
                let region = args.region;
                let occludedNote = '';

                if (args.window) {
                    // A window rect arrives in virtual-screen physical pixels, which
                    // can be negative across monitors. Route it through the same
                    // conversion the anchor tracker uses, then scale the resulting
                    // display-local DIPs back to that display's physical pixels.
                    const occ = await occlusionOf(args.window).catch(() => null);
                    if (occ && occ.covered > 0.02) {
                        occludedNote =
                            `\nWARNING: about ${Math.round(occ.covered * 100)}% of this window is covered by ` +
                            `${occ.by.slice(0, 3).join(', ')}. Those pixels belong to the covering window, not ` +
                            'this one. Drop asRendered, or call focus_window first.';
                    }
                    const [resolved] = await resolveRefs([args.window]);
                    if (!resolved?.rect) {
                        return fail(
                            `window ${args.window} could not be resolved; it may have closed or been minimised.`
                        );
                    }
                    const placed = toDisplayLocal(resolved.rect);
                    const onDisplay = displays.find(d => d.id === placed.displayId);
                    if (!onDisplay) return fail('that window is on a display that is no longer connected');
                    display = onDisplay;
                    region = {
                        x: Math.round(placed.rect.x * display.scaleFactor),
                        y: Math.round(placed.rect.y * display.scaleFactor),
                        width: Math.round(placed.rect.width * display.scaleFactor),
                        height: Math.round(placed.rect.height * display.scaleFactor)
                    };
                }

                const record = await captureDisplay({
                    display,
                    region,
                    maxDimension: args.maxDimension,
                    grid: args.grid
                });

                const scaleNote =
                    record.imageScale === 1
                        ? 'Image pixels map 1:1 to display pixels.'
                        : `Image is downscaled ${record.imageScale.toFixed(3)}x from the display.`;

                const body =
                    `Captured ${record.imageSize.width}x${record.imageSize.height} from display ${display.id} (${display.label}).\n` +
                    `captureId: ${record.id}\n` +
                    `path: ${record.path}\n\n` +
                    `Read that path with your file-reading tool to view it. ${scaleNote}\n` +
                    `To annotate what you see, call annotate with space:"image" and captureId:"${record.id}", using the ` +
                    `pixel coordinates of this image directly -- the conversion back to screen space is handled for you.` +
                    occludedNote;

                if (!args.returnImage) return text(body);

                const { readFileSync } = await import('node:fs');
                return {
                    content: [
                        { type: 'text' as const, text: body },
                        {
                            type: 'image' as const,
                            data: readFileSync(record.path).toString('base64'),
                            mimeType: 'image/png'
                        }
                    ]
                };
            } catch (err) {
                return fail(`capture_screen failed: ${(err as Error).message}`);
            }
        }
    );

    // ---------------------------------------------------------------- annotate
    server.registerTool(
        'annotate',
        {
            title: 'Draw on the screen',
            description:
                'Draw on the real screen, click-through so the user keeps working. ' +
                'box|highlight|circle|spotlight|step take x,y,width,height (or fit:true with an anchor); ' +
                'arrow takes x,y and toX,toY; label takes x,y,text. box/circle/step also accept text as a caption; ' +
                'step auto-numbers by list position; spotlight dims everything else. Replaces existing drawings ' +
                'unless replace:false.',
            inputSchema: {
                space: z
                    .enum(['image', 'physical', 'dip', 'normalized'])
                    .optional()
                    .describe(
                        '"image" = pixels of a capture_screen PNG (default when one exists), "physical" = display ' +
                            'px, "dip" = logical px, "normalized" = 0..1.'
                    ),
                captureId: z
                    .string()
                    .optional()
                    .describe('Defaults to the most recent capture.'),
                display: z.string().optional().describe('Display for non-image spaces.'),
                replace: z.boolean().default(true).describe('Clear existing first.'),
                ttlMs: z
                    .number()
                    .int()
                    .min(0)
                    .default(0)
                    .describe('Auto-clear after ms. 0 = keep.'),
                anchor: z
                    .object({
                        kind: z.enum(['window', 'element', 'name']),
                        ref: z.string().optional().describe('For kind window/element: ref from list_windows or find_ui_elements.'),
                        window: z.string().optional().describe('For kind "name": the window ref to search.'),
                        name: z.string().optional().describe('For kind "name": substring of the control name.'),
                        role: z.string().optional().describe('For kind "name": control type filter.'),
                        automationId: z
                            .string()
                            .optional()
                            .describe('For kind "name": exact AutomationId. The most durable selector.')
                    })
                    .optional()
                    .describe(
                        'Attach shapes to a live window or control so they follow it. kind "name" resolves a ' +
                            'selector in one call and survives the control being recreated. Prefer this over fixed coordinates.'
                    ),
                shapes: z
                    .array(
                        z.object({
                            type: z.enum(SHAPE_TYPES),
                            x: z.number().default(0),
                            y: z.number().default(0),
                            fit: z.boolean().optional().describe('Snap to the anchor rect, ignoring x/y/width/height.'),
                            pad: z.number().optional().describe('Grow a fitted shape by N px. Default 4.'),
                            width: z.number().optional(),
                            height: z.number().optional(),
                            toX: z.number().optional(),
                            toY: z.number().optional(),
                            text: z.string().optional(),
                            color: z.string().optional().describe('CSS color.'),
                            thickness: z.number().optional(),
                            dim: z.number().min(0).max(1).optional().describe('Spotlight dim, 0..1.'),
                            pulse: z.boolean().optional().describe('Pulse to draw the eye.')
                        })
                    )
                    .min(1)
            }
        },
        async args => {
            try {
                if (args.anchor) {
                    return await createAnchored(args.anchor, args.shapes, {
                        replace: args.replace,
                        ttlMs: args.ttlMs
                    });
                }

                const displays = listDisplays();
                const { space, capture, display } = resolveSpace(
                    args.space,
                    args.captureId,
                    args.display,
                    displays
                );

                const expiresAt = args.ttlMs > 0 ? Date.now() + args.ttlMs : undefined;
                const created: Annotation[] = [];
                let stepNumber = 0;

                for (const s of args.shapes) {
                    const needsRect = s.type !== 'arrow' && s.type !== 'label';
                    if (needsRect && (s.width === undefined || s.height === undefined)) {
                        return fail(`shape "${s.type}" requires width and height`);
                    }
                    if (s.type === 'arrow' && (s.toX === undefined || s.toY === undefined)) {
                        return fail('shape "arrow" requires toX and toY');
                    }
                    if (s.type === 'label' && !s.text) {
                        return fail('shape "label" requires text');
                    }

                    let rectDip: Rect;
                    let toDip: Point | undefined;

                    if (needsRect) {
                        const raw: Rect = { x: s.x, y: s.y, width: s.width!, height: s.height! };
                        const phys = clampRectToDisplay(toPhysicalRect(raw, space, display, capture), display);
                        rectDip = physicalToDipRect(phys, display);
                    } else {
                        const phys = toPhysicalPoint({ x: s.x, y: s.y }, space, display, capture);
                        const dip = physicalToDipPoint(phys, display);
                        rectDip = { x: dip.x, y: dip.y, width: 0, height: 0 };
                        if (s.type === 'arrow') {
                            const headPhys = toPhysicalPoint({ x: s.toX!, y: s.toY! }, space, display, capture);
                            toDip = physicalToDipPoint(headPhys, display);
                        }
                    }

                    if (s.type === 'step') stepNumber += 1;

                    created.push({
                        id: store.nextId('ann'),
                        displayId: display.id,
                        type: s.type,
                        rect: rectDip,
                        to: toDip,
                        text: s.type === 'step' ? s.text ?? String(stepNumber) : s.text,
                        color: s.color ?? DEFAULT_COLORS[s.type],
                        thickness: s.thickness ?? 3,
                        dim: s.dim ?? 0.6,
                        pulse: s.pulse ?? false,
                        expiresAt,
                        createdAt: Date.now()
                    });
                }

                if (args.replace) store.clear();
                store.add(created);

                const spaceNote = space === 'image' && capture ? ` (mapped from capture ${capture.id})` : '';
                return text(
                    `Drew ${created.length} shape(s) on display ${display.id}${spaceNote}. ` +
                        `Ids: ${created.map(a => a.id).join(', ')}.` +
                        (expiresAt ? ` They clear automatically in ${args.ttlMs}ms.` : '')
                );
            } catch (err) {
                return fail(`annotate failed: ${(err as Error).message}`);
            }
        }
    );

    // ------------------------------------------------------------------- clear
    server.registerTool(
        'clear_annotations',
        {
            title: 'Clear annotations',
            description:
                'Remove drawings. Pass ids, or nothing to clear all.',
            inputSchema: {
                ids: z.array(z.string()).optional()
            }
        },
        async args => {
            const n = store.clear(args.ids);
            return text(`Cleared ${n} annotation(s). ${store.list().length} remain.`);
        }
    );

    // --------------------------------------------------------------- ask user
    server.registerTool(
        'wait_for_user_click',
        {
            title: 'Ask the user to point at something',
            description:
                'Ask the user to click something; returns where they clicked in every coordinate space. Use it ' +
                'instead of guessing which element they mean. Escape cancels.',
            inputSchema: {
                prompt: z.string().describe('Shown on their screen.'),
                count: z.number().int().min(1).max(10).default(1),
                timeoutMs: z
                    .number()
                    .int()
                    .min(1000)
                    .max(600000)
                    .default(60000),
                captureId: z.string().optional().describe('Map results into this capture. Defaults to the latest.')
            }
        },
        async args => {
            try {
                const results = await requestClicks({
                    prompt: args.prompt,
                    count: args.count,
                    timeoutMs: args.timeoutMs,
                    captureId: args.captureId ?? store.latestCapture()?.id
                });
                const lines = results.map((r, i) => {
                    const img = r.image ? `, image=(${r.image.x}, ${r.image.y})` : '';
                    return (
                        `${i + 1}. display=${r.displayId} physical=(${r.physical.x}, ${r.physical.y})${img}, ` +
                        `normalized=(${r.normalized.x}, ${r.normalized.y})`
                    );
                });
                return text(`The user clicked ${results.length} point(s):\n${lines.join('\n')}`);
            } catch (err) {
                return fail((err as Error).message);
            }
        }
    );

    // ----------------------------------------------------------------- windows
    server.registerTool(
        'list_windows',
        {
            title: 'List windows and displays',
            description:
                'Windows and monitors: refs, titles, rects in physical pixels. Start here. Pass a window ref to ' +
                'describe_window, find_ui_elements, wait_for_element, or annotate as an anchor.',
            inputSchema: {},
            annotations: { readOnlyHint: true }
        },
        async () => {
            try {
                const windows = await listWindows();
                const displayLines = listDisplays().map(
                    d =>
                        `- display ${d.id}${d.primary ? ' (primary)' : ''} ` +
                        `${d.physicalSize.width}x${d.physicalSize.height} scale ${d.scaleFactor}`
                );
                if (windows.length === 0) {
                    return text(`No visible windows.\n${displayLines.join('\n')}`);
                }
                const lines = windows.map(
                    w =>
                        `- ref=${w.ref}${w.foreground ? ' [foreground]' : ''}
` +
                        `    title: ${w.title}
` +
                        `    rect: ${w.rect.width}x${w.rect.height} at (${w.rect.x}, ${w.rect.y})  class=${w.class}`
                );
                return text(
                    `${windows.length} window(s):\n${lines.join('\n')}\n${displayLines.join('\n')}`
                );
            } catch (err) {
                return fail(`list_windows failed: ${(err as Error).message}`);
            }
        }
    );

    // ---------------------------------------------------------------- elements
    server.registerTool(
        'find_ui_elements',
        {
            title: 'Find UI controls by name',
            description:
                'Find controls by name substring and/or role; returns refs and rects. To point at one, prefer ' +
                'annotate with anchor {kind:"name", window, name} -- that resolves and draws in one call.',
            inputSchema: {
                window: z
                    .string()
                    .optional()
                    .describe('Window ref. Omit to search the desktop (seconds slower).'),
                name: z
                    .string()
                    .optional()
                    .describe('Case-insensitive substring of the accessible name, for example "Save".'),
                automationId: z
                    .string()
                    .optional()
                    .describe('Exact AutomationId. Beats name: unaffected by relabelling or translation.'),
                role: z
                    .string()
                    .optional()
                    .describe(
                        'button|checkbox|combobox|edit|link|listitem|menuitem|tab|text|toolbar|treeitem|group|document|pane|window'
                    ),
                limit: z.number().int().min(1).max(200).default(25)
            },
            annotations: { readOnlyHint: true }
        },
        async args => {
            try {
                const found = await findElements({
                    window: args.window,
                    name: args.name,
                    role: args.role,
                    automationId: args.automationId,
                    limit: args.limit
                });
                if (found.length === 0) {
                    return text(
                        'No matching controls. The app may not expose an accessibility tree (common for browser page ' +
                            'content and canvas UIs) -- take a screenshot and use image coordinates instead.'
                    );
                }
                const lines = found.map(
                    e =>
                        `- ref=${e.ref}  [${e.role}]${e.enabled ? '' : ' (disabled)'}  "${e.name}"` +
                        `${e.automation_id ? `  id=${e.automation_id}` : ''}
` +
                        `    rect: ${e.rect.width}x${e.rect.height} at (${e.rect.x}, ${e.rect.y})`
                );
                return text(
                    `${found.length} control(s):\n${lines.join('\n')}\n\n` +
                        'To frame one: annotate with anchor {kind:"element", ref:"<ref>"} and fit:true on the shape.'
                );
            } catch (err) {
                return fail(`find_ui_elements failed: ${(err as Error).message}`);
            }
        }
    );

    // ---------------------------------------------------------------- describe
    server.registerTool(
        'describe_window',
        {
            title: 'Read a window as text',
            description:
                'Window contents as an indented tree: name, role, value, disabled state, anchorable ref per line. ' +
                'The default way to answer "what is on screen" -- a few hundred tokens versus ~1.8k for a ' +
                'screenshot. Empty for canvas, games and some browser content; try read_text, then capture_screen. ' +
                'Returns a snapshotId; pass it back as since= on a later call to get only what changed. ' +
                'Rows showing id=... carry an AutomationId, the most durable thing to anchor to.',
            inputSchema: {
                window: z.string().describe('Window ref from list_windows.'),
                maxNodes: z.number().int().min(1).max(1000).default(120),
                maxDepth: z
                    .number()
                    .int()
                    .min(1)
                    .max(40)
                    .default(25)
                    .describe('Chromium apps nest ~19 deep.'),
                includeRects: z.boolean().default(false),
                since: z
                    .string()
                    .optional()
                    .describe('snapshotId from an earlier call: returns only what changed since then.')
            },
            annotations: { readOnlyHint: true }
        },
        async args => {
            try {
                return text(
                    await describeWindowAsText({
                        window: args.window,
                        maxNodes: args.maxNodes,
                        maxDepth: args.maxDepth,
                        includeRects: args.includeRects,
                        since: args.since
                    })
                );
            } catch (err) {
                return fail(`describe_window failed: ${(err as Error).message}`);
            }
        }
    );

    // -------------------------------------------------------------- wait on UI
    server.registerTool(
        'wait_for_element',
        {
            title: 'Wait for the UI to reach a state',
            description:
                'Block until a control appears, disappears or becomes enabled. One call covers the whole wait, so ' +
                'use it instead of screenshotting in a loop. timeoutMs:0 checks once and returns immediately, which ' +
                'is how you assert state cheaply. Always pass window: unscoped costs ~7s per check. Returns ' +
                'met:false on timeout rather than erroring.',
            inputSchema: {
                condition: z
                    .enum(['appears', 'disappears', 'enabled'])
                    .describe('appears | disappears (spinner done, dialog closed) | enabled (exists and not greyed).'),
                name: z.string().optional().describe('Substring of the accessible name.'),
                role: z.string().optional().describe('Control type, as in find_ui_elements.'),
                window: z.string().optional().describe('Window ref. Strongly preferred.'),
                timeoutMs: z
                    .number()
                    .int()
                    .min(0)
                    .max(900000)
                    .default(60000)
                    .describe('Give up after this long. 0 = check once and return (assertion mode).'),
                pollMs: z
                    .number()
                    .int()
                    .min(150)
                    .max(5000)
                    .default(500)
                    .describe('Re-check interval. CPU only, never tokens.')
            }
        },
        async args => {
            if (!args.name && !args.role) {
                return fail('wait_for_element needs at least a name or a role to match against');
            }
            try {
                const outcome = await waitForElement({
                    condition: args.condition,
                    window: args.window,
                    name: args.name,
                    role: args.role,
                    timeoutMs: args.timeoutMs,
                    pollMs: args.pollMs
                });
                const secs = (outcome.waitedMs / 1000).toFixed(1);
                // An unscoped control search walks every window on the desktop,
                // which costs seconds per check. A single slow check can also
                // overshoot the deadline, so say so rather than look broken.
                const slow =
                    !args.window && args.role !== 'window'
                        ? '\nNote: this search was not scoped to a window, so each check walked the whole ' +
                          'desktop (seconds per check, and the timeout can overshoot). Pass window from ' +
                          'list_windows to make it near-instant.'
                        : '';

                if (!outcome.met) {
                    return text(
                        `Condition "${args.condition}" was NOT met within ${secs}s (${outcome.polls} checks). ` +
                            'The app may be stuck, or the control may be named differently. Take a screenshot to look.' +
                            slow
                    );
                }
                if (outcome.element) {
                    const e = outcome.element;
                    return text(
                        `Condition "${args.condition}" met after ${secs}s (${outcome.polls} checks).\n` +
                            `- ref=${e.ref}  [${e.role}]  "${e.name}"\n` +
                            `    rect: ${e.rect.width}x${e.rect.height} at (${e.rect.x}, ${e.rect.y})\n` +
                            'That ref is ready to use as an annotate anchor.' +
                            slow
                    );
                }
                return text(`Condition "${args.condition}" met after ${secs}s (${outcome.polls} checks).${slow}`);
            } catch (err) {
                return fail(`wait_for_element failed: ${(err as Error).message}`);
            }
        }
    );

    // ------------------------------------------------------------------- focus
    server.registerTool(
        'focus_window',
        {
            title: 'Bring a window to the front',
            description:
                'Raise a window and give it focus. Do this before guiding someone through an application so the ' +
                'window they need is actually visible and accepting keystrokes. It changes which window is in ' +
                'front; it does not click or type.',
            inputSchema: { window: z.string().describe('Window ref from list_windows.') }
        },
        async args => {
            try {
                await focusWindow(args.window);
                return text(`Window ${args.window} is now in front.`);
            } catch (err) {
                return fail((err as Error).message);
            }
        }
    );

    // ------------------------------------------------------------------ scroll
    server.registerTool(
        'scroll_window',
        {
            title: 'Scroll a window',
            description:
                'Scroll a window by wheel notches so you can reach content that is off screen. Negative scrolls ' +
                'down, positive up. Sends the wheel message straight to the window, so the pointer does not move. ' +
                'Re-read with describe_window afterwards: refs and rectangles change once content moves.',
            inputSchema: {
                window: z.string().describe('Window ref from list_windows.'),
                notches: z
                    .number()
                    .int()
                    .min(-30)
                    .max(30)
                    .default(-3)
                    .describe('Wheel notches. Negative scrolls down.')
            }
        },
        async args => {
            try {
                await scrollWindow(args.window, args.notches);
                return text(
                    `Scrolled ${args.notches} notch(es). Some apps ignore wheel messages that arrive without ` +
                        'the pointer over them; re-read the window to confirm it moved.'
                );
            } catch (err) {
                return fail((err as Error).message);
            }
        }
    );

    // --------------------------------------------------------- point and wait
    server.registerTool(
        'highlight_and_wait',
        {
            title: 'Point at something and wait for the user',
            description:
                'Draw attention to one control and wait for the user to click it. The basic walkthrough step: it ' +
                'annotates, waits, then clears, in a single call. Give it either an anchor target (window + name) ' +
                'or nothing, in which case it just waits.',
            inputSchema: {
                window: z.string().describe('Window ref containing the control.'),
                name: z.string().optional().describe('Substring of the control name.'),
                automationId: z.string().optional().describe('Exact AutomationId. Preferred when available.'),
                role: z.string().optional().describe('Control type filter.'),
                prompt: z.string().describe('What to tell the user to do.'),
                timeoutMs: z.number().int().min(1000).max(600000).default(120000),
                keep: z.boolean().default(false).describe('Leave the highlight up after the click.')
            }
        },
        async args => {
            try {
                const drew = await createAnchored(
                    {
                        kind: 'name',
                        window: args.window,
                        name: args.name,
                        role: args.role,
                        automationId: args.automationId
                    },
                    [{ type: 'circle', x: 0, y: 0, fit: true, pad: 8, pulse: true, text: args.prompt }],
                    { replace: true, ttlMs: 0 }
                );
                if (drew.isError) return drew;

                const results = await requestClicks({
                    prompt: args.prompt,
                    count: 1,
                    timeoutMs: args.timeoutMs,
                    captureId: undefined
                });
                if (!args.keep) store.clear();
                const r = results[0]!;
                return text(
                    `The user clicked at physical (${r.physical.x}, ${r.physical.y}) on display ${r.displayId}.` +
                        (args.keep ? '' : ' Highlight cleared.')
                );
            } catch (err) {
                if (!args.keep) store.clear();
                return fail((err as Error).message);
            }
        }
    );

    // --------------------------------------------------------------- read text
    server.registerTool(
        'read_text',
        {
            title: 'Read text off the screen',
            description:
                'Recognise text in a window or region and return it with the rectangle of each line. The fallback ' +
                'for surfaces with no accessibility tree -- canvas apps, games, remote desktop -- where ' +
                'describe_window comes back empty. Line rectangles are image coordinates of the capture it takes, ' +
                'so you can point at any line with annotate using space:"image" and the returned captureId.',
            inputSchema: {
                window: z.string().optional().describe('Window ref from list_windows. Preferred.'),
                display: z.string().optional().describe('Display, when not scoping to a window.'),
                region: z
                    .object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })
                    .optional()
                    .describe('Sub-region in display physical px.'),
                contains: z
                    .string()
                    .optional()
                    .describe('Only return lines containing this text, case-insensitive.')
            },
            annotations: { readOnlyHint: true }
        },
        async args => {
            try {
                const displays = listDisplays();
                let display = resolveDisplay(args.display, displays);
                let region = args.region;

                if (args.window) {
                    const [resolved] = await resolveRefs([args.window]);
                    if (!resolved?.rect) return fail(`window ${args.window} could not be resolved`);
                    const placed = toDisplayLocal(resolved.rect);
                    const onDisplay = displays.find(d => d.id === placed.displayId);
                    if (!onDisplay) return fail('that window is on a disconnected display');
                    display = onDisplay;
                    region = {
                        x: Math.round(placed.rect.x * display.scaleFactor),
                        y: Math.round(placed.rect.y * display.scaleFactor),
                        width: Math.round(placed.rect.width * display.scaleFactor),
                        height: Math.round(placed.rect.height * display.scaleFactor)
                    };
                }

                // Capture at native resolution deliberately. Downscaling is how a
                // screenshot saves tokens, but OCR returns text rather than
                // pixels, so shrinking the image only costs accuracy -- measured
                // as badly garbled output on a 1568px-wide full-screen shot.
                const record = await captureDisplay({
                    display,
                    region,
                    maxDimension: 4096,
                    grid: false
                });

                const lines = await ocrImage(record.path);
                const needle = args.contains?.toLowerCase();
                const kept = needle
                    ? lines.filter(l => l.text.toLowerCase().includes(needle))
                    : lines;

                if (kept.length === 0) {
                    return text(
                        needle
                            ? `No line containing "${args.contains}" was recognised.`
                            : 'No text was recognised in that area.'
                    );
                }

                const body = kept
                    .map(l => `${l.rect.x},${l.rect.y} ${l.rect.width}x${l.rect.height}  ${l.text}`)
                    .join('\n');
                return text(
                    `${kept.length} line(s), captureId: ${record.id} (${record.imageSize.width}x${record.imageSize.height}).\n` +
                        `Coordinates are image pixels; annotate with space:"image" and this captureId.\n${body}`
                );
            } catch (err) {
                return fail(`read_text failed: ${(err as Error).message}`);
            }
        }
    );

    // ------------------------------------------------------------------- speak
    server.registerTool(
        'speak',
        {
            title: 'Say something out loud',
            description:
                'Speak text through the system voice. For hands-free guidance: the user can keep their hands in ' +
                'the app and their eyes on what you highlighted instead of reading the panel. Keep it to a ' +
                'sentence, and pair it with an annotation rather than describing positions in words.',
            inputSchema: {
                text: z.string().max(500),
                rate: z.number().min(0.5).max(2).default(1).describe('Speech rate, 1 is normal.')
            }
        },
        async args => {
            const ok = speak(args.text, args.rate);
            return ok
                ? text('Spoken.')
                : fail('nothing is available to speak through: the overlay panel is not running');
        }
    );

    // ------------------------------------------------------------------ notify
    server.registerTool(
        'show_message',
        {
            title: 'Show a message to the user',
            description:
                'Show a line in the overlay panel. The only way to put text on screen for clients with no UI of their own.',
            inputSchema: {
                text: z.string().max(2000),
                level: z.enum(['info', 'warn', 'error']).default('info')
            }
        },
        async args => {
            postToHud(args.text, args.level);
            return text('Message shown in the overlay panel.');
        }
    );
}
