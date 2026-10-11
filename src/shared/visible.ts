import type { Rect } from './types.js';

/**
 * Which parts of the screen show a shared window, for masking captures.
 *
 * A screen grab holds every window the user has open. Before any of it reaches
 * the agent (as an image, or as text read from one), everything that is not a
 * shared window on top is painted over with one flat colour, so the desktop,
 * the taskbar, a notification and a video playing on the side all look alike:
 * a hole says nothing about what is in it.
 */

/** A window in z-order, front first. */
export interface Layer {
    rect: Rect;
    shared: boolean;
    /** Ours and see-through (the overlay): neither shown nor hiding anything. */
    ignore?: boolean;
}

/**
 * How far a shared window is pulled in at its edges, and every other window
 * pushed out: Windows 11 rounds window corners, so the corners inside a
 * window's frame show what is behind it, and drop shadows spill a few pixels
 * onto the windows below.
 */
export const EDGE_PX = 2;

const right = (r: Rect): number => r.x + r.width;
const bottom = (r: Rect): number => r.y + r.height;

function grow(r: Rect, by: number): Rect {
    return { x: r.x - by, y: r.y - by, width: Math.max(0, r.width + 2 * by), height: Math.max(0, r.height + 2 * by) };
}

export function intersect(a: Rect, b: Rect): Rect | null {
    const x = Math.max(a.x, b.x);
    const y = Math.max(a.y, b.y);
    const w = Math.min(right(a), right(b)) - x;
    const h = Math.min(bottom(a), bottom(b)) - y;
    return w > 0 && h > 0 ? { x, y, width: w, height: h } : null;
}

/** `a` with `b` cut out of it: up to four rects. */
function minus(a: Rect, b: Rect): Rect[] {
    const i = intersect(a, b);
    if (!i) return [a];
    const out: Rect[] = [];
    if (i.y > a.y) out.push({ x: a.x, y: a.y, width: a.width, height: i.y - a.y });
    if (bottom(i) < bottom(a)) out.push({ x: a.x, y: bottom(i), width: a.width, height: bottom(a) - bottom(i) });
    if (i.x > a.x) out.push({ x: a.x, y: i.y, width: i.x - a.x, height: i.height });
    if (right(i) < right(a)) out.push({ x: right(i), y: i.y, width: right(a) - right(i), height: i.height });
    return out;
}

/**
 * The parts of shared windows that are on top, in the stack's coordinates.
 * Everything not covered by the result is to be masked.
 */
export function visibleRegions(stack: readonly Layer[], edge = EDGE_PX): Rect[] {
    const covering: Rect[] = [];
    const shown: Rect[] = [];
    for (const layer of stack) {
        if (layer.ignore || layer.rect.width <= 0 || layer.rect.height <= 0) continue;
        if (layer.shared) {
            let parts = [grow(layer.rect, -edge)].filter(r => r.width > 0 && r.height > 0);
            for (const c of covering) parts = parts.flatMap(p => minus(p, c));
            shown.push(...parts);
        }
        // A shared window hides what is behind it too, without spilling.
        covering.push(layer.shared ? layer.rect : grow(layer.rect, edge));
    }
    return shown;
}

/**
 * The parts shown in both of two readings of the screen. Windows can move
 * between listing them and the capture landing, so only what was a shared
 * window's both before and after is kept.
 */
export function both(a: readonly Rect[], b: readonly Rect[]): Rect[] {
    const out: Rect[] = [];
    for (const x of a) for (const y of b) {
        const i = intersect(x, y);
        if (i) out.push(i);
    }
    return out;
}

/** Rects moved by (-dx, -dy) and scaled by k: virtual-screen physical into an image's pixels. */
export function toImage(rects: readonly Rect[], origin: { x: number; y: number }, kx: number, ky = kx): Rect[] {
    return rects.map(r => {
        const x = Math.floor((r.x - origin.x) * kx);
        const y = Math.floor((r.y - origin.y) * ky);
        return {
            x,
            y,
            width: Math.ceil((right(r) - origin.x) * kx) - x,
            height: Math.ceil((bottom(r) - origin.y) * ky) - y
        };
    });
}

/** The flat colour hidden areas are painted, BGRA: a dark grey that reads as "nothing here". */
export const MASK_BGRA = [32, 32, 32, 255] as const;

/**
 * A copy of a BGRA bitmap with everything outside `keep` painted MASK_BGRA.
 * `keep` is in the bitmap's own pixels and is clipped to it.
 */
export function maskBitmap(bitmap: Uint8Array, width: number, height: number, keep: readonly Rect[]): Uint8Array {
    const out = new Uint8Array(width * height * 4);
    for (let i = 0; i < out.length; i += 4) {
        out[i] = MASK_BGRA[0];
        out[i + 1] = MASK_BGRA[1];
        out[i + 2] = MASK_BGRA[2];
        out[i + 3] = MASK_BGRA[3];
    }
    const frame = { x: 0, y: 0, width, height };
    for (const r of keep) {
        const k = intersect(r, frame);
        if (!k) continue;
        for (let y = k.y; y < k.y + k.height; y += 1) {
            const start = (y * width + k.x) * 4;
            out.set(bitmap.subarray(start, start + k.width * 4), start);
        }
    }
    return out;
}
