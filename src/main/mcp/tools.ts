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
    DEFAULT_CAPTURE,
    clampRectToDisplay,
    physicalToDipPoint,
    physicalToDipRect,
    rectContains,
    toPhysicalPoint,
    toPhysicalRect
} from '../../shared/geometry.js';
import { elementLine, rectText } from '../../shared/uitree.js';
import { windowLine } from '../../shared/windows.js';
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
    resolveWindow,
    scrollWindow
} from '../uia.js';
import { geometryFor, toDisplayLocal, wakeAnchorTracking } from '../anchors.js';
import { waitForElement, type WaitCondition, type WaitOutcome } from '../waits.js';
import { describeWindowAsText } from '../describe.js';

/**
 * Every tool this server registers, in the order clients list them.
 *
 * The built-in chat panel allow-lists tools by name, so it imports this rather
 * than keeping a copy. Its copy went stale once: it named a tool that no longer
 * existed and silently denied the panel nine that did, describe_window among
 * them. A test checks this list against what registerTools actually registers.
 */
export const TOOL_NAMES = [
    'list_windows',
    'describe_window',
    'find_ui_elements',
    'read_text',
    'capture_screen',
    'annotate',
    'clear_annotations',
    'highlight_and_wait',
    'wait_for_element',
    'wait_for_user_click',
    'focus_window',
    'scroll_window',
    'show_message'
] as const;

/*
 * Token discipline. The tool list is resent on every turn of every
 * conversation, while a tool's response is paid only when the tool is used. So
 * descriptions say what a tool does and when to reach for it, and caveats that
 * only matter in the moment (an occluded window, an unscoped search, an app that
 * ignores wheel messages) live in the responses that trigger them.
 */

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
type Result = { content: Content[]; isError?: true };

const text = (t: string): Result => ({ content: [{ type: 'text', text: t }] });
const fail = (t: string): Result => ({ content: [{ type: 'text', text: t }], isError: true });

/** Run a handler, turning anything it throws into an error the agent can read. */
async function guarded(tool: string, fn: () => Promise<Result>): Promise<Result> {
    try {
        return await fn();
    } catch (err) {
        return fail(`${tool}: ${(err as Error).message}`);
    }
}

const WINDOW = 'Ref, title substring, or "foreground".';
const CONDITIONS = ['appears', 'disappears', 'enabled'] as const;
const SHAPE_TYPES = ['box', 'highlight', 'circle', 'arrow', 'label', 'spotlight', 'step'] as const;
/** Shapes drawn from a rectangle, as opposed to a point (arrow, label). */
const RECT_SHAPES = new Set<ShapeType>(['box', 'highlight', 'circle', 'spotlight', 'step']);

const DEFAULT_COLORS: Record<ShapeType, string> = {
    box: '#ff3b30',
    highlight: '#ffd60a',
    circle: '#ff3b30',
    arrow: '#ff3b30',
    label: '#ffffff',
    spotlight: '#000000',
    step: '#0a84ff'
};

/**
 * Schema fragments shared by every tool that finds a control. Nested copies
 * (an anchor, an until) go undescribed: the model has already read the same
 * three fields at the top level of the tool, and every description is resent
 * on every turn.
 */
const selectorFields = (described = true) => ({
    name: described ? z.string().optional().describe('Name substring.') : z.string().optional(),
    automationId: described
        ? z.string().optional().describe('Exact AutomationId; beats name.')
        : z.string().optional(),
    role: described ? z.string().optional().describe('Control type.') : z.string().optional()
});
const regionField = () =>
    z
        .object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })
        .optional()
        .describe('Display-physical px.');

/** "window" and its alias "dialog" mean a top-level window, found via the window list. */
function isWindowRole(role: string | undefined): boolean {
    return role !== undefined && ['window', 'dialog'].includes(role.trim().toLowerCase());
}

// ------------------------------------------------------------------ geometry

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

// ------------------------------------------------------------------- shapes

interface ShapeInput {
    type: ShapeType;
    x?: number;
    y?: number;
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
 * Whether a shape snaps to its anchor's rectangle. Explicit `fit` wins;
 * otherwise an anchored rectangle shape with no size fits its target, because
 * that is what "circle the Export button" means, and erroring on it only cost a
 * round trip.
 */
function fits(s: ShapeInput): boolean {
    return s.fit ?? (RECT_SHAPES.has(s.type) && s.width === undefined && s.height === undefined);
}

function checkShape(s: ShapeInput, anchored: boolean): void {
    if (s.type === 'arrow' && (s.toX === undefined || s.toY === undefined)) {
        throw new Error('shape "arrow" needs toX and toY');
    }
    if (s.type === 'label' && !s.text) throw new Error('shape "label" needs text');
    const sized = s.width !== undefined && s.height !== undefined;
    if (RECT_SHAPES.has(s.type) && !sized && !(anchored && fits(s))) {
        throw new Error(
            anchored
                ? `shape "${s.type}" needs both width and height, or neither to fit the anchor`
                : `shape "${s.type}" needs width and height`
        );
    }
}

/** Everything about an annotation that does not depend on where it lands. */
function baseAnnotation(s: ShapeInput, step: number, expiresAt: number | undefined): Annotation {
    return {
        id: store.nextId('ann'),
        displayId: '',
        type: s.type,
        rect: { x: 0, y: 0, width: 0, height: 0 },
        text: s.type === 'step' ? s.text ?? String(step) : s.text,
        color: s.color ?? DEFAULT_COLORS[s.type],
        thickness: s.thickness ?? 3,
        dim: s.dim ?? 0.6,
        pulse: s.pulse ?? false,
        expiresAt,
        createdAt: Date.now()
    };
}

// ------------------------------------------------------------------ anchors

interface AnchorInput {
    kind?: 'window' | 'element' | 'name';
    ref?: string;
    window?: string;
    name?: string;
    role?: string;
    automationId?: string;
}

interface ResolvedAnchor {
    kind: 'window' | 'element';
    ref: string;
    rect: Rect;
    /** How to find the control again if its ref stops resolving. */
    selector?: AnchorSelector;
    /** What to call the target in a response. */
    label: string;
}

/**
 * Work out what an anchor points at and where it is right now.
 *
 * `kind` is optional: a name, role or automationId means a control, a ref from
 * a tree means that element, and otherwise it is a window. Spelling out a kind
 * the inputs already imply was one more thing for an agent to get wrong.
 */
async function resolveAnchor(a: AnchorInput): Promise<ResolvedAnchor> {
    const hasSelector = Boolean(a.name || a.role || a.automationId);
    if (a.kind === 'name' || (a.kind === undefined && hasSelector)) {
        if (!a.window || !hasSelector) {
            throw new Error('a control anchor needs window plus name, automationId or role');
        }
        const selector: AnchorSelector = {
            window: await resolveWindow(a.window),
            name: a.name,
            role: a.role,
            automationId: a.automationId
        };
        // Resolving here makes pointing at a control one call rather than
        // find_ui_elements, read the result, then annotate.
        const [found] = await findElements({ ...selector, limit: 1 });
        if (!found) {
            const wanted = JSON.stringify({ name: a.name, automationId: a.automationId, role: a.role });
            throw new Error(
                `no control matching ${wanted} in window ${selector.window}. describe_window shows what is there.`
            );
        }
        return {
            kind: 'element',
            ref: found.ref,
            rect: found.rect,
            selector,
            label: `"${found.name || found.ref}" [${found.role}] ${found.ref}`
        };
    }

    const raw = a.ref ?? a.window;
    if (!raw) throw new Error('anchor needs a window, a ref, or window plus name');
    const kind = a.kind === 'window' || a.kind === 'element' ? a.kind : raw.startsWith('el_') ? 'element' : 'window';
    const ref = kind === 'window' ? await resolveWindow(raw) : raw;
    const [resolved] = await resolveRefs([ref]);
    if (!resolved?.rect) {
        throw new Error(
            `anchor ${ref} could not be resolved: the ${kind} may have closed, been minimised or been ` +
                'rebuilt. Look it up again, or anchor by name so it is re-found automatically.'
        );
    }
    return { kind, ref, rect: resolved.rect, label: `${kind} ${ref}` };
}

/**
 * Anchored shapes take a different path from fixed ones: rather than resolving
 * coordinates once, they store offsets from a live target and let the tracker
 * recompute their position every tick. That is what stops a box drifting off the
 * button it was drawn around the moment the user moves the window.
 */
function placeAnchored(
    anchor: ResolvedAnchor,
    shapes: ShapeInput[],
    opts: { replace: boolean; ttlMs: number }
): Annotation[] {
    for (const s of shapes) checkShape(s, true);
    const expiresAt = opts.ttlMs > 0 ? Date.now() + opts.ttlMs : undefined;
    let step = 0;

    const created = shapes.map(s => {
        if (s.type === 'step') step += 1;
        const fit = fits(s);
        const partial: Annotation = {
            ...baseAnnotation(s, step, expiresAt),
            anchor: {
                kind: anchor.kind,
                ref: anchor.ref,
                label: anchor.selector?.name ?? anchor.ref,
                fit,
                pad: s.pad ?? 4,
                offset: fit
                    ? undefined
                    : { x: s.x ?? 0, y: s.y ?? 0, width: s.width ?? 0, height: s.height ?? 0 },
                toOffset: s.type === 'arrow' ? { x: s.toX!, y: s.toY! } : undefined,
                selector: anchor.selector
            }
        };
        // Place it immediately so it appears without waiting for a tracker tick.
        const geom = geometryFor(partial, anchor.rect);
        return { ...partial, displayId: geom.displayId, rect: geom.rect, to: geom.to };
    });

    if (opts.replace) store.clear();
    store.add(created);
    // A fresh anchor is usually about to be dragged or watched; do not make it
    // wait out a backed-off poll interval.
    wakeAnchorTracking();
    return created;
}

/** Shapes at fixed coordinates in one of the agent-facing spaces. */
function placeFixed(
    args: { space?: CoordSpace; captureId?: string; display?: string; replace: boolean; ttlMs: number },
    shapes: ShapeInput[]
): { created: Annotation[]; display: DisplayInfo; capture?: CaptureRecord } {
    for (const s of shapes) checkShape(s, false);
    const { space, capture, display } = resolveSpace(args.space, args.captureId, args.display, listDisplays());
    const expiresAt = args.ttlMs > 0 ? Date.now() + args.ttlMs : undefined;
    let step = 0;

    const created = shapes.map(s => {
        if (s.type === 'step') step += 1;
        const at = { x: s.x ?? 0, y: s.y ?? 0 };
        let rect: Rect;
        let to: Point | undefined;
        if (RECT_SHAPES.has(s.type)) {
            const phys = toPhysicalRect({ ...at, width: s.width!, height: s.height! }, space, display, capture);
            rect = physicalToDipRect(clampRectToDisplay(phys, display), display);
        } else {
            const dip = physicalToDipPoint(toPhysicalPoint(at, space, display, capture), display);
            rect = { x: dip.x, y: dip.y, width: 0, height: 0 };
            if (s.type === 'arrow') {
                to = physicalToDipPoint(toPhysicalPoint({ x: s.toX!, y: s.toY! }, space, display, capture), display);
            }
        }
        return { ...baseAnnotation(s, step, expiresAt), displayId: display.id, rect, to };
    });

    if (args.replace) store.clear();
    store.add(created);
    return { created, display, capture };
}

const ids = (list: Annotation[]): string => list.map(a => a.id).join(', ');

// --------------------------------------------------------------- responses

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

function waitSummary(condition: WaitCondition, o: WaitOutcome): string {
    const secs = (o.waitedMs / 1000).toFixed(1);
    if (!o.met) {
        return (
            `NOT met: "${condition}" did not happen within ${secs}s (${o.polls} checks). ` +
            'The control may be named differently; describe_window shows what is there.'
        );
    }
    return `Met: "${condition}" after ${secs}s.${o.element ? `\n${elementLine(o.element)}` : ''}`;
}

const UNSCOPED_NOTE =
    '\nNote: not scoped to a window, so every check walked the whole desktop (seconds each, and the ' +
    'timeout can overshoot). Pass window to make it near-instant.';

// ------------------------------------------------------------------- tools

export function registerTools(server: McpServer): void {
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

    // ---------------------------------------------------------------- annotate
    server.registerTool(
        'annotate',
        {
            title: 'Draw on the screen',
            description:
                'Draw on the real screen; click-through, so the user keeps working. box, highlight, circle, ' +
                'step (numbered) and spotlight (dims the rest) take x,y,width,height; arrow takes x,y to ' +
                'toX,toY; label takes x,y,text. text captions any shape. Anchor to a control so drawings ' +
                'follow it: fixed coordinates go stale when a window moves. Replaces earlier drawings unless ' +
                'replace:false.',
            inputSchema: {
                // No `kind` and no per-shape `fit`: both are inferred (see
                // resolveAnchor and fits), and still honoured internally.
                anchor: z
                    .object({
                        window: z.string().optional(),
                        name: z.string().optional().describe('Name substring.'),
                        automationId: z.string().optional().describe('Exact AutomationId; beats name.'),
                        role: z.string().optional().describe('Control type.'),
                        ref: z.string().optional()
                    })
                    .optional()
                    .describe(
                        'Follow a target: {window, name|automationId|role} for a control (re-found if rebuilt), ' +
                            '{window} for a window, {ref} for a ref. x,y become px offsets from its top-left; ' +
                            'shapes without width/height fit it.'
                    ),
                shapes: z
                    .array(
                        z.object({
                            type: z.enum(SHAPE_TYPES),
                            x: z.number().optional(),
                            y: z.number().optional(),
                            width: z.number().optional(),
                            height: z.number().optional(),
                            toX: z.number().optional(),
                            toY: z.number().optional(),
                            text: z.string().optional(),
                            pad: z.number().optional().describe('Px around a fitted shape. Default 4.'),
                            color: z.string().optional().describe('CSS color.'),
                            thickness: z.number().optional(),
                            dim: z.number().min(0).max(1).optional().describe('Spotlight darkness.'),
                            pulse: z.boolean().optional()
                        })
                    )
                    .min(1),
                space: z
                    .enum(['image', 'physical', 'dip', 'normalized'])
                    .optional()
                    .describe(
                        'Unanchored coordinates: "image" = pixels of a capture (default when one exists), ' +
                            '"physical"/"dip" = display px, "normalized" = 0..1.'
                    ),
                captureId: z.string().optional().describe('Default: the latest capture.'),
                display: z.string().optional().describe('For non-image spaces.'),
                replace: z.boolean().default(true),
                ttlMs: z.number().int().min(0).default(0).describe('Auto-clear after ms; 0 keeps.')
            }
        },
        args =>
            guarded('annotate', async () => {
                const ttl = args.ttlMs > 0 ? ` They clear in ${args.ttlMs}ms.` : '';
                if (args.anchor) {
                    const target = await resolveAnchor(args.anchor);
                    const created = placeAnchored(target, args.shapes, { replace: args.replace, ttlMs: args.ttlMs });
                    return text(`Drew ${ids(created)} on ${target.label}; they follow it.${ttl}`);
                }
                const { created, display, capture } = placeFixed(args, args.shapes);
                const from = capture ? ` (from ${capture.id})` : '';
                return text(`Drew ${ids(created)} on display ${display.id}${from}.${ttl}`);
            })
    );

    // ------------------------------------------------------------------- clear
    server.registerTool(
        'clear_annotations',
        {
            title: 'Clear annotations',
            description: 'Remove drawings: the given ids, or all.',
            inputSchema: { ids: z.array(z.string()).optional() }
        },
        async args => {
            const n = store.clear(args.ids);
            return text(`Cleared ${n}; ${store.list().length} remain.`);
        }
    );

    // ------------------------------------------------------- walkthrough step
    server.registerTool(
        'highlight_and_wait',
        {
            title: 'Point at something and wait',
            description:
                'One walkthrough step in one call: circle a control with your prompt, wait, then clear it. ' +
                'With until, the user operates the app normally and this returns once the UI reaches that ' +
                'state (a dialog opens, a button enables). Without until, it waits for a confirming click, ' +
                'which the overlay captures: the app does not receive it.',
            inputSchema: {
                window: z.string().describe(WINDOW),
                ...selectorFields(),
                prompt: z.string().describe('What the user should do; captions the circle.'),
                until: z
                    .object({
                        condition: z.enum(CONDITIONS),
                        ...selectorFields(false),
                        window: z.string().optional()
                    })
                    .optional()
                    .describe(
                        'The state that proves the step is done. Searched in the step\'s window unless window ' +
                            'is given; role "window" alone waits for a new top-level window.'
                    ),
                timeoutMs: z.number().int().min(1000).max(900000).default(120000),
                keep: z.boolean().default(false).describe('Leave the circle up afterwards.')
            }
        },
        args =>
            guarded('highlight_and_wait', async () => {
                const u = args.until;
                if (u && !(u.name || u.role || u.automationId)) {
                    throw new Error('until needs name, automationId or role');
                }
                const window = await resolveWindow(args.window);
                let drawn: Annotation[] = [];
                if (args.name || args.automationId || args.role) {
                    const target = await resolveAnchor({
                        window,
                        name: args.name,
                        role: args.role,
                        automationId: args.automationId
                    });
                    drawn = placeAnchored(
                        target,
                        [{ type: 'circle', fit: true, pad: 8, pulse: true, text: args.prompt }],
                        { replace: true, ttlMs: 0 }
                    );
                } else {
                    // Nothing to caption, so the prompt still needs to reach the user.
                    postToHud(args.prompt, 'info');
                }

                try {
                    if (u) {
                        const topLevel = isWindowRole(u.role) && !u.window && !u.automationId;
                        const outcome = await waitForElement({
                            condition: u.condition,
                            window: u.window ? await resolveWindow(u.window) : topLevel ? undefined : window,
                            name: u.name,
                            role: topLevel ? 'window' : u.role,
                            automationId: u.automationId,
                            timeoutMs: args.timeoutMs,
                            pollMs: 400
                        });
                        return text(waitSummary(u.condition, outcome));
                    }

                    const [click] = await requestClicks({ prompt: args.prompt, count: 1, timeoutMs: args.timeoutMs });
                    const where = `${click!.physical.x},${click!.physical.y} on display ${click!.displayId}`;
                    // Read the live annotation: the tracker may have moved it since it was drawn.
                    const circle = drawn[0] && store.list().find(a => a.id === drawn[0]!.id);
                    if (!circle) return text(`The user clicked at ${where}.`);
                    const onTarget = circle.displayId === click!.displayId && rectContains(circle.rect, click!.dip);
                    return text(
                        onTarget
                            ? `The user clicked the target (${where}).`
                            : `The user clicked OUTSIDE the target, at ${where}. They may mean something else.`
                    );
                } finally {
                    if (!args.keep && drawn.length > 0) store.clear(drawn.map(a => a.id));
                }
            })
    );

    // -------------------------------------------------------------- wait on UI
    server.registerTool(
        'wait_for_element',
        {
            title: 'Wait for the UI to reach a state',
            description:
                'Block until a control appears, disappears or becomes enabled, in one call instead of polling ' +
                'with screenshots. timeoutMs:0 checks once, which is how to assert state cheaply. role ' +
                '"window" without window waits for a top-level window. Returns NOT met on timeout.',
            inputSchema: {
                condition: z.enum(CONDITIONS),
                ...selectorFields(),
                window: z.string().optional().describe(`${WINDOW} Pass it: unscoped searches take seconds.`),
                timeoutMs: z.number().int().min(0).max(900000).default(60000)
            }
        },
        args =>
            guarded('wait_for_element', async () => {
                if (!args.name && !args.role && !args.automationId) {
                    throw new Error('needs name, automationId or role to match against');
                }
                const role = isWindowRole(args.role) ? 'window' : args.role;
                const outcome = await waitForElement({
                    condition: args.condition,
                    window: args.window ? await resolveWindow(args.window) : undefined,
                    name: args.name,
                    role,
                    automationId: args.automationId,
                    timeoutMs: args.timeoutMs,
                    pollMs: 500
                });
                // A top-level window wait uses the window list and is fast anyway.
                const slow = !args.window && !(role === 'window' && !args.automationId) ? UNSCOPED_NOTE : '';
                return text(waitSummary(args.condition, outcome) + slow);
            })
    );

    // --------------------------------------------------------------- ask user
    server.registerTool(
        'wait_for_user_click',
        {
            title: 'Ask the user to point at something',
            description:
                'Ask the user to click a point; returns it in every coordinate space. Use it instead of ' +
                'guessing what they mean. The overlay captures the click, so the app does not receive it. ' +
                'Escape cancels.',
            inputSchema: {
                prompt: z.string().describe('Shown on their screen.'),
                count: z.number().int().min(1).max(10).default(1),
                timeoutMs: z.number().int().min(1000).max(600000).default(60000),
                captureId: z.string().optional().describe('Map clicks into this capture. Default: the latest.')
            }
        },
        args =>
            guarded('wait_for_user_click', async () => {
                const results = await requestClicks({
                    prompt: args.prompt,
                    count: args.count,
                    timeoutMs: args.timeoutMs,
                    captureId: args.captureId ?? store.latestCapture()?.id
                });
                const lines = results.map((r, i) => {
                    const img = r.image ? `, image ${r.image.x},${r.image.y}` : '';
                    return (
                        `${i + 1}. display ${r.displayId}: physical ${r.physical.x},${r.physical.y}${img}, ` +
                        `normalized ${r.normalized.x},${r.normalized.y}`
                    );
                });
                return text(`The user clicked:\n${lines.join('\n')}`);
            })
    );

    // ------------------------------------------------------------------- focus
    server.registerTool(
        'focus_window',
        {
            title: 'Bring a window to the front',
            description: 'Raise a window and focus it, so what you guide the user through is visible. Does not click or type.',
            inputSchema: { window: z.string().describe(WINDOW) }
        },
        args =>
            guarded('focus_window', async () => {
                const window = await resolveWindow(args.window);
                await focusWindow(window);
                return text(`Window ${window} is in front.`);
            })
    );

    // ------------------------------------------------------------------ scroll
    server.registerTool(
        'scroll_window',
        {
            title: 'Scroll a window',
            description: 'Scroll a window by wheel notches, without moving the pointer. Refs and rects change afterwards.',
            inputSchema: {
                window: z.string().describe(WINDOW),
                notches: z.number().int().min(-30).max(30).default(-3).describe('Negative scrolls down.')
            }
        },
        args =>
            guarded('scroll_window', async () => {
                await scrollWindow(await resolveWindow(args.window), args.notches);
                return text(
                    `Scrolled ${args.notches} notch(es). Re-read to see the new content; some apps ignore ` +
                        'wheel messages unless the pointer is over them.'
                );
            })
    );

    // ------------------------------------------------------------------ notify
    server.registerTool(
        'show_message',
        {
            title: 'Tell the user something',
            description:
                'Post a line in the overlay panel, the only way to show text for clients with no UI of their ' +
                'own. speak:true also says it aloud, for hands-free guidance; keep spoken lines to a sentence.',
            inputSchema: {
                text: z.string().max(2000),
                level: z.enum(['info', 'warn', 'error']).default('info'),
                speak: z.boolean().default(false)
            }
        },
        async args => {
            postToHud(args.text, args.level);
            if (args.speak && !speak(args.text, 1)) {
                return text('Shown, but not spoken: the overlay panel is not running.');
            }
            return text(args.speak ? 'Shown and spoken.' : 'Shown.');
        }
    );
}
