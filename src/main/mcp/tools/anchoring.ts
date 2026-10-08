import type {
    Annotation,
    AnchorSelector,
    CaptureRecord,
    CoordSpace,
    DisplayInfo,
    Point,
    Rect,
    ShapeType
} from '../../../shared/types.js';
import {
    clampRectToDisplay,
    physicalToDipPoint,
    physicalToDipRect,
    toPhysicalPoint,
    toPhysicalRect
} from '../../../shared/geometry.js';
import { clean, isAmbiguous, whereIn } from '../../../shared/uitree.js';
import { coverVerdict, windowBlocker } from '../../../shared/windows.js';
import { listDisplays, resolveDisplay } from '../../displays.js';
import { store } from '../../store.js';
import {
    StaleRefError,
    coverage,
    findElements,
    knownControl,
    resolveRefs,
    resolveWindowInfo,
    suggestNames,
    windowInfo,
    type ElementInfo,
    type WindowInfo
} from '../../uia.js';
import { findRanked, geometryFor, wakeAnchorTracking } from '../../anchors.js';
import { DEFAULT_COLORS, RECT_SHAPES } from './common.js';

/**
 * Turning an agent's shapes into annotations: coordinate spaces, anchors, and
 * the validation both share. Used by annotate and by highlight_and_wait.
 */

// ------------------------------------------------------------------ geometry

/** Resolve which coordinate space and reference capture a call is working in. */
export function resolveSpace(
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

// ------------------------------------------------------------------- shapes

export interface ShapeInput {
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
export function fits(s: ShapeInput): boolean {
    return s.fit ?? (RECT_SHAPES.has(s.type) && s.width === undefined && s.height === undefined);
}

export function checkShape(s: ShapeInput, anchored: boolean): void {
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
export function baseAnnotation(s: ShapeInput, step: number, expiresAt: number | undefined): Annotation {
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

export interface AnchorInput {
    kind?: 'window' | 'element' | 'name';
    ref?: string;
    window?: string;
    name?: string;
    role?: string;
    automationId?: string;
}

export interface ResolvedAnchor {
    kind: 'window' | 'element';
    ref: string;
    rect: Rect;
    /** How to find the control again if its ref stops resolving. */
    selector?: AnchorSelector;
    /** What and where, for a response: `"Save" [button] el_1, top-left of "Untitled - Notepad"`. */
    label: string;
    /** Just what: `"Save" [button] el_1`, or `window 100 "Untitled - Notepad"`. */
    what: string;
    /** Where it sits in its window, in words: `top-left of "Untitled - Notepad"`. */
    where?: string;
    /** Other controls the name also matched, when the choice was not clear-cut. */
    also?: string[];
    /** Scrolled out of view: drawn as a pointer toward it, not at its rect. */
    offscreen?: boolean;
    /** Titles of the windows covering it, when it is mostly hidden behind them. */
    covered?: string;
    /** The window it was found in, for the hints a response gives. */
    window?: string;
    /** A note about the window itself, e.g. that it was found on another desktop. */
    windowNote?: string;
}

/**
 * The warnings a drawing response owes the agent about its target, one per
 * line, or '' when there is nothing to say. Shared with highlight_and_wait so
 * both tools report a covered or scrolled-out target the same way.
 */
export function anchorNotes(t: ResolvedAnchor): string {
    const lines: string[] = [];
    if (t.windowNote) lines.push(`Note: ${t.windowNote}`);
    if (t.also?.length) {
        lines.push(`Also matched ${t.also.join(', ')}: anchor by automationId or the full name if this is the wrong one.`);
    }
    if (t.offscreen && t.window && t.selector) {
        const { name, automationId, role } = t.selector;
        const args = JSON.stringify({ window: t.window, name, automationId, role });
        lines.push(`WARNING: ${t.what} is scrolled out of view; scroll_window ${args} brings it into view.`);
    }
    if (t.covered) {
        const front = t.window ? `focus_window {"window":"${t.window}"} brings it forward` : 'focus its window first';
        lines.push(`WARNING: ${t.what} is behind "${t.covered}", so the user cannot see it; ${front}.`);
    }
    return lines.length > 0 ? `\n${lines.join('\n')}` : '';
}

/**
 * Work out what an anchor points at and where it is right now.
 *
 * `kind` is optional: a name, role or automationId means a control, a ref from
 * a tree means that element, and otherwise it is a window. Spelling out a kind
 * the inputs already imply was one more thing for an agent to get wrong.
 */
export async function resolveAnchor(a: AnchorInput): Promise<ResolvedAnchor> {
    const hasSelector = Boolean(a.name || a.role || a.automationId);
    if (a.kind === 'name' || (a.kind === undefined && hasSelector)) {
        if (!a.window || !hasSelector) {
            throw new Error('a control anchor needs window plus name, automationId or role');
        }
        const resolved = await resolveWindowInfo(a.window);
        const info = await usableWindow(resolved.ref, resolved.window);
        const selector: AnchorSelector = {
            window: resolved.ref,
            name: a.name,
            role: a.role,
            automationId: a.automationId
        };
        // Resolving here makes pointing at a control one call rather than
        // find_ui_elements, read the result, then annotate.
        const ranked = await findRanked(selector, info?.rect);
        const found = ranked[0];
        if (!found) throw new Error(await missMessage(selector, info));
        const also = isAmbiguous(ranked, selector)
            ? ranked.slice(1, 3).map(m => `"${clean(m.name)}" [${m.role}]`)
            : undefined;
        return described(found, selector, info, { also, windowNote: resolved.note });
    }

    const raw = a.ref ?? a.window;
    if (!raw) throw new Error('anchor needs a window, a ref, or window plus name');
    const kind = a.kind === 'window' || a.kind === 'element' ? a.kind : raw.startsWith('el_') ? 'element' : 'window';
    if (kind === 'window') return windowAnchor(raw);

    // A bare ref carries no selector of its own, but the search or describe
    // that produced it recorded one, so it can be re-found when the ref dies.
    const known = knownControl(raw);
    const [live] = await resolveRefs([raw]);
    if (live?.rect) {
        const info = known ? await windowInfo(known.selector.window).catch(() => undefined) : undefined;
        const element = {
            ref: raw,
            name: known?.name ?? '',
            role: known?.selector.role ?? '',
            rect: live.rect,
            offscreen: live.offscreen,
            window: known?.top
        };
        return described(element, known?.selector, info, {});
    }
    if (known) {
        const info = await usableWindow(known.selector.window);
        const [found] = await findRanked(known.selector, info?.rect);
        if (found) return described(found, known.selector, info, {});
    }
    if (live?.stale) throw new StaleRefError(raw);
    throw new Error(
        `anchor ${raw} could not be resolved: the control may have closed or been rebuilt. Look it up ` +
            'again, or anchor by name so it is re-found automatically.'
    );
}

/**
 * The window's details, or an error naming why nothing can be drawn on it
 * (minimised, another desktop, hung) instead of a misleading "no control".
 */
async function usableWindow(ref: string, known?: WindowInfo): Promise<WindowInfo | undefined> {
    const info = known ?? (await windowInfo(ref).catch(() => undefined));
    const blocker = info && windowBlocker(info, 'draw');
    if (blocker) throw new Error(blocker);
    return info;
}

async function windowAnchor(query: string): Promise<ResolvedAnchor> {
    const resolved = await resolveWindowInfo(query);
    const ref = resolved.ref;
    const info = await usableWindow(ref, resolved.window);
    const [live] = await resolveRefs([ref]);
    if (!live?.rect) {
        throw new Error(
            `window ${ref} could not be resolved: it may have closed. list_windows shows what is open.`
        );
    }
    const what = `window ${ref}${info ? ` "${clean(info.title)}"` : ''}`;
    const covered = await coverage(ref).then(coverVerdict).catch(() => null);
    return {
        kind: 'window',
        ref,
        rect: live.rect,
        label: what,
        what,
        window: ref,
        covered: covered ?? undefined,
        windowNote: resolved.note
    };
}

/** A found control as an anchor: what, where, and whether the user can actually see it. */
async function described(
    found: Pick<ElementInfo, 'ref' | 'name' | 'role' | 'rect' | 'offscreen' | 'window'>,
    selector: AnchorSelector | undefined,
    info: WindowInfo | undefined,
    extra: { also?: string[]; windowNote?: string }
): Promise<ResolvedAnchor> {
    const name = clean(found.name);
    const kind = found.role ? `[${found.role}] ` : '';
    const what = name ? `"${name}" ${kind}${found.ref}` : kind ? `${kind}${found.ref}` : `element ${found.ref}`;
    // Where it is, in the words the agent should pass on to the user: rows
    // carry no rects by default, so the agent has nothing else to say it with.
    const title = info ? `"${clean(info.title)}"` : undefined;
    const spot = info && !found.window ? whereIn(found.rect, info.rect) : null;
    const where = !title ? undefined : found.window ? `in a popup of ${title}` : spot ? `${spot} of ${title}` : undefined;

    // The overlay draws above every window, so a circle around a covered
    // control sits on whatever covers it, and that is what the user clicks.
    const window = selector?.window ?? info?.ref;
    const covered =
        window && !found.offscreen
            ? await coverage(found.window ?? window, found.rect).then(coverVerdict).catch(() => null)
            : null;

    return {
        kind: 'element',
        ref: found.ref,
        rect: found.rect,
        selector,
        what,
        label: where ? `${what}, ${where}` : what,
        where,
        also: extra.also,
        offscreen: found.offscreen || undefined,
        covered: covered ?? undefined,
        window,
        windowNote: extra.windowNote
    };
}

/**
 * Why a selector found nothing, and what to try instead, on one line.
 *
 * Every miss used to send the agent back to describe_window. A control inside
 * a closed menu or on another tab usually exists but has no rect, and a near
 * miss on the name usually has an obvious correct spelling; saying either here
 * saves that round trip. Closest names are only suggestions, never drawn.
 */
async function missMessage(selector: AnchorSelector, info: WindowInfo | undefined): Promise<string> {
    const wanted = JSON.stringify({ name: selector.name, automationId: selector.automationId, role: selector.role });
    const head = `no control matching ${wanted} in window ${selector.window}${info ? ` "${clean(info.title)}"` : ''}.`;
    return `${head}${await missHint(selector, info)} describe_window shows what is there.`;
}

/** The part of a miss message that says what to try instead, with a leading space, or ''. */
export async function missHint(selector: AnchorSelector, info: WindowInfo | undefined): Promise<string> {
    if (info?.elevated) {
        return (
            ' The window runs as administrator, so Windows blocks reading its controls (UIPI); anchor to ' +
            'the window itself, with offsets from read_text.'
        );
    }
    const [hidden, closest] = await Promise.all([
        findElements({ ...selector, includeHidden: true, limit: 3 })
            .then(list => list.find(e => e.hidden))
            .catch(() => undefined),
        selector.name
            ? suggestNames(selector.window, selector.name, selector.role, 3).catch(() => [])
            : Promise.resolve([])
    ]);
    if (hidden) return ` ${hiddenHint(hidden)}`;
    if (closest.length > 0) {
        return ` Closest names (not drawn): ${closest.map(s => `"${clean(s.name)}" [${s.role}]`).join(', ')}.`;
    }
    return '';
}

/** What must be opened first to reveal a match that exists but has no place on screen. */
function hiddenHint(e: ElementInfo): string {
    const name = `"${clean(e.name)}"`;
    const c = e.container ? `"${clean(e.container.name)}" [${e.container.role}] ${e.container.ref}` : null;
    switch (e.hidden) {
        case 'collapsed':
            return c
                ? `${name} is inside collapsed ${c}: point the user at that first, and wait for ${name} to appear.`
                : `${name} is inside a collapsed menu, list or tree node: have the user open it first.`;
        case 'unselected-tab':
            return c
                ? `${name} is on the unselected tab ${c}: point the user at that tab first.`
                : `${name} is on a tab that is not selected: have the user open that tab first.`;
        default:
            return `${name} exists but is not shown on screen right now.`;
    }
}

/**
 * The highest numbered step badge on screen, so steps added with replace:false
 * carry on from it instead of starting again at 1.
 */
function highestStep(list: Annotation[]): number {
    return list.reduce(
        (max, a) => (a.type === 'step' && /^\d{1,3}$/.test(a.text ?? '') ? Math.max(max, Number(a.text)) : max),
        0
    );
}

/** " (steps 3-4)" for the numbered badges among new drawings, or ''. */
export function stepRange(created: Annotation[]): string {
    const nums = created.filter(a => a.type === 'step' && /^\d{1,3}$/.test(a.text ?? '')).map(a => Number(a.text));
    if (nums.length === 0) return '';
    return nums.length === 1 ? ` (step ${nums[0]})` : ` (steps ${nums[0]}-${nums[nums.length - 1]})`;
}

/**
 * Anchored shapes take a different path from fixed ones: rather than resolving
 * coordinates once, they store offsets from a live target and let the tracker
 * recompute their position every tick. That is what stops a box drifting off the
 * button it was drawn around the moment the user moves the window.
 */
export function placeAnchored(
    anchor: ResolvedAnchor,
    shapes: ShapeInput[],
    opts: { replace: boolean; ttlMs: number }
): Annotation[] {
    for (const s of shapes) checkShape(s, true);
    const expiresAt = opts.ttlMs > 0 ? Date.now() + opts.ttlMs : undefined;
    let step = opts.replace ? 0 : highestStep(store.list());

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
            },
            // Known at draw time, so the first frame already shows the target
            // as covered or scrolled away; the tracker keeps both current.
            covered: anchor.covered,
            offscreen: anchor.offscreen
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
export function placeFixed(
    args: { space?: CoordSpace; captureId?: string; display?: string; replace: boolean; ttlMs: number },
    shapes: ShapeInput[]
): { created: Annotation[]; display: DisplayInfo; capture?: CaptureRecord } {
    for (const s of shapes) checkShape(s, false);
    const { space, capture, display } = resolveSpace(args.space, args.captureId, args.display, listDisplays());
    const expiresAt = args.ttlMs > 0 ? Date.now() + args.ttlMs : undefined;
    let step = args.replace ? 0 : highestStep(store.list());

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

export const ids = (list: Annotation[]): string => list.map(a => a.id).join(', ');
