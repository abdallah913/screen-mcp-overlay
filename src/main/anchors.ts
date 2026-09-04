import { screen } from 'electron';
import type { Annotation, Point, Rect } from '../shared/types.js';
import { store } from './store.js';
import { findElements, resolveRefs } from './uia.js';

/**
 * Keeps anchored annotations glued to the window or control they point at.
 *
 * Without this, a box drawn around a button is only correct until the user nudges
 * the window: the coordinates were captured once and never revisited. The tracker
 * re-reads each anchor's live rectangle and recomputes the annotation's geometry.
 */

const FAST_TICK_MS = 120;
/**
 * Windows sit still most of the time. Polling at 120ms regardless cost about 7%
 * of a core for a single anchor; backing off when nothing moves removes that
 * while keeping drag latency imperceptible, because any change snaps the
 * interval straight back to fast.
 */
const SLOW_TICK_MS = 600;
const CALM_TICKS_BEFORE_SLOWING = 8;
/** Re-resolving by selector costs a tree search, so retry slowly, not every tick. */
const RECOVER_EVERY_MS = 2000;
let timer: NodeJS.Timeout | null = null;
let inFlight = false;
let calmTicks = 0;
let running = false;
const lastRecovery = new Map<string, number>();

/**
 * Physical virtual-screen pixels -> a display id plus display-local DIPs.
 *
 * Goes through `screenToDipPoint` rather than dividing by a scale factor: with
 * two monitors at different scaling the DIP layout is not a uniform scaling of
 * the physical layout, and arithmetic that assumes it is puts annotations on the
 * wrong monitor.
 */
export function toDisplayLocal(phys: Rect): { displayId: string; rect: Rect; to?: Point } {
    const tl = screen.screenToDipPoint({ x: phys.x, y: phys.y });
    const br = screen.screenToDipPoint({ x: phys.x + phys.width, y: phys.y + phys.height });
    const display = screen.getDisplayNearestPoint(tl);
    return {
        displayId: String(display.id),
        rect: {
            x: tl.x - display.bounds.x,
            y: tl.y - display.bounds.y,
            width: Math.max(1, br.x - tl.x),
            height: Math.max(1, br.y - tl.y)
        }
    };
}

function physToDisplayLocalPoint(phys: Point, displayId: string): Point {
    const dip = screen.screenToDipPoint(phys);
    const display = screen.getAllDisplays().find(d => String(d.id) === displayId);
    if (!display) return dip;
    return { x: dip.x - display.bounds.x, y: dip.y - display.bounds.y };
}

/** Absolute physical geometry for one annotation given its anchor's live rect. */
export function geometryFor(
    a: Annotation,
    anchorRect: Rect
): { displayId: string; rect: Rect; to?: Point } {
    const spec = a.anchor!;

    if (spec.fit) {
        const pad = spec.pad ?? 0;
        const phys: Rect = {
            x: anchorRect.x - pad,
            y: anchorRect.y - pad,
            width: anchorRect.width + pad * 2,
            height: anchorRect.height + pad * 2
        };
        return toDisplayLocal(phys);
    }

    const off = spec.offset ?? { x: 0, y: 0, width: 0, height: 0 };
    const phys: Rect = {
        x: anchorRect.x + off.x,
        y: anchorRect.y + off.y,
        width: off.width,
        height: off.height
    };
    const placed = toDisplayLocal(phys);

    if (spec.toOffset) {
        placed.to = physToDisplayLocalPoint(
            { x: anchorRect.x + spec.toOffset.x, y: anchorRect.y + spec.toOffset.y },
            placed.displayId
        );
    }
    return placed;
}

async function tick(): Promise<void> {
    if (inFlight) return;
    const anchored = store.anchored();
    if (anchored.length === 0) return;

    inFlight = true;
    try {
        const refs = [...new Set(anchored.map(a => a.anchor!.ref))];
        let byRef = new Map<string, Rect | null>();
        try {
            const resolved = await resolveRefs(refs);
            byRef = new Map(resolved.map(r => [r.ref, r.rect]));
        } catch {
            // Stale refs after a helper restart: treat every one as missing so
            // the selector recovery below gets its chance.
            byRef = new Map(refs.map(r => [r, null]));
        }

        // Anything unresolved that carries a selector gets looked up again.
        await recoverBySelector(anchored, byRef);

        const updates = anchored.map(a => {
            const anchorRect = byRef.get(a.anchor!.ref) ?? null;
            if (!anchorRect) {
                // Target gone (closed, minimised, navigated away). Hide rather
                // than delete so it reappears if the window comes back.
                return { id: a.id, displayId: a.displayId, rect: a.rect, to: a.to, hidden: true };
            }
            const g = geometryFor(a, anchorRect);
            return { id: a.id, displayId: g.displayId, rect: g.rect, to: g.to, hidden: false };
        });

        const moved = store.applyTracking(updates);
        calmTicks = moved ? 0 : calmTicks + 1;
    } catch {
        // A helper hiccup should not kill tracking; the next tick retries.
    } finally {
        inFlight = false;
    }
}

/**
 * Re-find controls whose ref stopped resolving.
 *
 * An element ref is only meaningful while the helper that issued it is alive and
 * the control still exists. A selector survives both, so an anchored drawing can
 * come back on its own after a helper restart or an app relaunch instead of
 * silently staying hidden.
 */
async function recoverBySelector(
    anchored: Annotation[],
    byRef: Map<string, Rect | null>
): Promise<void> {
    const now = Date.now();
    for (const a of anchored) {
        const spec = a.anchor!;
        if (!spec.selector || byRef.get(spec.ref)) continue;
        if (now - (lastRecovery.get(a.id) ?? 0) < RECOVER_EVERY_MS) continue;
        lastRecovery.set(a.id, now);

        try {
            const [found] = await findElements({
                window: spec.selector.window,
                name: spec.selector.name,
                role: spec.selector.role,
                automationId: spec.selector.automationId,
                limit: 1
            });
            if (found) {
                spec.ref = found.ref;
                byRef.set(found.ref, found.rect);
            }
        } catch {
            // The window may be gone too; the next pass will try again.
        }
    }
}

function schedule(): void {
    if (!running) return;
    const delay = calmTicks >= CALM_TICKS_BEFORE_SLOWING ? SLOW_TICK_MS : FAST_TICK_MS;
    timer = setTimeout(() => {
        void tick().finally(schedule);
    }, delay);
    timer.unref?.();
}

export function startAnchorTracking(): void {
    if (running) return;
    running = true;
    schedule();
}

export function stopAnchorTracking(): void {
    running = false;
    if (timer) clearTimeout(timer);
    timer = null;
}

/** Return to fast polling immediately, e.g. when a new anchor is created. */
export function wakeAnchorTracking(): void {
    calmTicks = 0;
}

/** Resolve once, immediately, so a new annotation appears without waiting a tick. */
export async function resolveNow(): Promise<void> {
    await tick();
}
