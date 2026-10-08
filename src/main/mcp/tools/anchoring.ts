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
import { listDisplays, resolveDisplay } from '../../displays.js';
import { store } from '../../store.js';
import { findElements, resolveRefs, resolveWindow } from '../../uia.js';
import { geometryFor, wakeAnchorTracking } from '../../anchors.js';
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
export async function resolveAnchor(a: AnchorInput): Promise<ResolvedAnchor> {
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
export function placeAnchored(
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
export function placeFixed(
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

export const ids = (list: Annotation[]): string => list.map(a => a.id).join(', ');
