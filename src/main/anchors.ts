import { screen } from 'electron';
import type { AnchorSelector, AnchorSpec, Annotation, Point, Rect } from '../shared/types.js';
import { rankMatches } from '../shared/uitree.js';
import { coverVerdict } from '../shared/windows.js';
import { store } from './store.js';
import {
    coverage,
    findElements,
    knownControl,
    resolveRefs,
    selectorForRef,
    type ElementInfo,
    type ResolvedRef
} from './uia.js';

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
/** Re-resolving by selector costs a tree search, so a search that found nothing is retried slowly. */
const RECOVER_EVERY_MS = 2000;
/**
 * Whether something covers a target changes when the user switches windows,
 * which is human-speed; checking every tick would put a helper round trip per
 * anchor on the 120ms hot path for no visible gain.
 */
const COVER_EVERY_MS = 1000;
let timer: NodeJS.Timeout | null = null;
let inFlight = false;
let calmTicks = 0;
let running = false;
/** When a selector last searched and found nothing, keyed by the selector. */
const failedSearches = new Map<string, number>();
/** When each annotation's coverage was last checked. */
const coverChecked = new Map<string, number>();

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

/**
 * Find a control by selector, best match first (see rankMatches).
 *
 * Asks for more than one match because the helper returns substring matches in
 * tree order: with limit 1, "Save" stopped at whichever of "Autosave" or "Save
 * as…" came first, and an exact label further down was never seen.
 */
export async function findRanked(selector: AnchorSelector, within?: Rect): Promise<ElementInfo[]> {
    const found = await findElements({
        window: selector.window,
        name: selector.name,
        role: selector.role,
        automationId: selector.automationId,
        limit: 50
    });
    return rankMatches(found, selector, within);
}

/** The top-level window a target lives in, when known: what coverage is measured against. */
function targetWindow(spec: AnchorSpec): string | undefined {
    if (spec.kind === 'window') return spec.ref;
    const known = knownControl(spec.ref);
    return known?.top ?? spec.selector?.window ?? known?.selector.window;
}

async function tick(): Promise<void> {
    if (inFlight) return;
    const anchored = store.anchored();
    if (anchored.length === 0) {
        failedSearches.clear();
        coverChecked.clear();
        return;
    }

    inFlight = true;
    try {
        const refs = [...new Set(anchored.map(a => a.anchor!.ref))];
        let byRef = new Map<string, ResolvedRef>();
        try {
            byRef = new Map((await resolveRefs(refs)).map(r => [r.ref, r]));
        } catch {
            // The helper failed or timed out: every target is unknown this
            // tick, and the selector recovery below gets its chance.
        }

        // Anything unresolved that can be found again gets looked up.
        await recoverBySelector(anchored, byRef);
        const covered = await refreshCoverage(anchored, byRef);

        const updates = anchored.map(a => {
            const live = byRef.get(a.anchor!.ref);
            if (!live?.rect) {
                // Target gone (closed, minimised, navigated away). Hide rather
                // than delete so it reappears if the window comes back.
                return { id: a.id, displayId: a.displayId, rect: a.rect, to: a.to, hidden: true };
            }
            const g = geometryFor(a, live.rect);
            return {
                id: a.id,
                displayId: g.displayId,
                rect: g.rect,
                to: g.to,
                hidden: false,
                // Scrolled out of view: the rect is real, but drawing there would
                // point at whatever now occupies it, so the renderer points
                // toward the target instead.
                offscreen: Boolean(live.offscreen),
                covered: covered.get(a.id)
            };
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
 * silently staying hidden. A {ref} anchor uses the selector recorded when its
 * ref was first seen.
 *
 * Only a search that found nothing is throttled. Throttling every attempt hid a
 * drawing for up to two seconds each time a toolkit rebuilt its controls, which
 * Chromium does often enough to make drawings flicker.
 */
async function recoverBySelector(anchored: Annotation[], byRef: Map<string, ResolvedRef>): Promise<void> {
    const now = Date.now();
    const thisTick = new Map<string, ElementInfo | null>();
    for (const a of anchored) {
        const spec = a.anchor!;
        if (spec.kind === 'window' || byRef.get(spec.ref)?.rect) continue;
        const known = selectorForRef(spec.ref);
        const selector = spec.selector ?? known;
        if (!selector) continue;

        // Re-finding by name alone can land on a sibling ("Save" vs "Save As"),
        // so the control must also be the same kind it was when first found.
        const role = selector.role ?? (known?.role !== 'other' ? known?.role : undefined);
        const key = JSON.stringify([selector.window, selector.name, selector.automationId, role]);
        if (!thisTick.has(key)) {
            if (now - (failedSearches.get(key) ?? 0) < RECOVER_EVERY_MS) continue;
            const [best] = await findRanked({ ...selector, role }).catch(() => []);
            thisTick.set(key, best ?? null);
            if (best) failedSearches.delete(key);
            else failedSearches.set(key, now);
        }
        const best = thisTick.get(key);
        if (!best) continue;
        // The store hands out its own objects, so this updates the annotation.
        spec.ref = best.ref;
        spec.selector ??= selector;
        byRef.set(best.ref, { ref: best.ref, rect: best.rect, offscreen: best.offscreen });
    }
}

/**
 * Which visible targets are hidden behind another window, re-checked at most
 * once a second per annotation. The overlay is topmost, so a circle drawn over
 * a covered "Save" sits on top of whatever covers it, and the user clicks that.
 * Returns a verdict only for annotations checked this tick; the rest keep theirs.
 */
async function refreshCoverage(
    anchored: Annotation[],
    byRef: Map<string, ResolvedRef>
): Promise<Map<string, string | null>> {
    const now = Date.now();
    const ids = new Set(anchored.map(a => a.id));
    for (const id of coverChecked.keys()) if (!ids.has(id)) coverChecked.delete(id);

    const out = new Map<string, string | null>();
    const byTarget = new Map<string, Promise<string | null | undefined>>();
    for (const a of anchored) {
        const spec = a.anchor!;
        const live = byRef.get(spec.ref);
        const window = targetWindow(spec);
        if (!live?.rect || live.offscreen || !window) continue;
        if (now - (coverChecked.get(a.id) ?? 0) < COVER_EVERY_MS) continue;
        coverChecked.set(a.id, now);

        const key = `${window}|${spec.ref}`;
        let verdict = byTarget.get(key);
        if (!verdict) {
            verdict = coverage(window, spec.kind === 'window' ? undefined : live.rect)
                .then(coverVerdict)
                .catch(() => undefined);
            byTarget.set(key, verdict);
        }
        const v = await verdict;
        if (v !== undefined) out.set(a.id, v);
    }
    return out;
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
