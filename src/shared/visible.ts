import type { Rect } from './types.js';

/**
 * What a capture may show, composed from shared windows' own renders
 * (composeLayers): each shared window painted from its own render onto a
 * blank canvas, so nothing about any other window, its outline included, is
 * in it. Nothing is ever taken from the screen, which holds every window the
 * user has open: a shared window that will not render itself is left blank.
 */

/** A window in z-order, front first, and whether it is shared. */
export interface Layer {
    rect: Rect;
    shared: boolean;
}

const right = (r: Rect): number => r.x + r.width;
const bottom = (r: Rect): number => r.y + r.height;

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

/** How much of `target` the rects in `above` hide between them, 0..1: overlapping ones count once. */
export function coveredFraction(target: Rect, above: readonly Rect[]): number {
    const whole = target.width * target.height;
    if (whole <= 0) return 0;
    let open = [target];
    for (const a of above) open = open.flatMap(p => minus(p, a));
    const left = open.reduce((sum, r) => sum + r.width * r.height, 0);
    return 1 - left / whole;
}

/** A BGRA bitmap, rows packed. */
export interface Bitmap {
    data: Uint8Array;
    width: number;
    height: number;
}

/** One image to paint into a composed capture. */
export interface PaintLayer {
    image: Bitmap;
    /** Where the image lies, virtual-screen physical; it is stretched over this rect. */
    rect: Rect;
    /** The only parts painted, virtual-screen physical: nothing of the image outside them is read. */
    clip: readonly Rect[];
}

/**
 * A capture composed from images rather than masked from the screen: a canvas
 * of `size` physical pixels whose top-left is `origin` (virtual-screen
 * physical, so negative left of or above the primary display), blank in the
 * mask colour, with each layer painted over it in order, back to front,
 * inside its clip and the canvas only.
 *
 * Each shared window is painted from its own render, so the canvas holds the
 * shared windows whole and in their order, and nothing else at all: no window
 * the user did not share, not even the outline of one, since where it sits on
 * screen is never consulted. A layer is sampled by nearest pixel, which keeps
 * a 1:1 render exact and lets a screen frame of a slightly different size
 * land on the same physical pixels. A layer whose buffer is not the size it
 * claims paints nothing.
 */
export function composeLayers(
    size: { width: number; height: number },
    origin: { x: number; y: number },
    layers: readonly PaintLayer[]
): Uint8Array {
    const { width, height } = size;
    const out = new Uint8Array(Math.max(0, width * height * 4));
    for (let i = 0; i < out.length; i += 4) out.set(MASK_BGRA, i);
    const canvas = { x: origin.x, y: origin.y, width, height };
    for (const layer of layers) {
        const { image, rect } = layer;
        if (image.width <= 0 || image.height <= 0 || image.data.length !== image.width * image.height * 4) continue;
        if (rect.width <= 0 || rect.height <= 0) continue;
        const kx = image.width / rect.width;
        const ky = image.height / rect.height;
        const exact = kx === 1 && ky === 1;
        for (const c of layer.clip) {
            const part = intersect(c, rect);
            const area = part && intersect(part, canvas);
            if (!area) continue;
            for (let y = area.y; y < bottom(area); y += 1) {
                const sy = Math.min(image.height - 1, Math.floor((y - rect.y) * ky));
                const to = ((y - origin.y) * width + (area.x - origin.x)) * 4;
                if (exact) {
                    const from = (sy * image.width + (area.x - rect.x)) * 4;
                    out.set(image.data.subarray(from, from + area.width * 4), to);
                    continue;
                }
                for (let x = 0; x < area.width; x += 1) {
                    const sx = Math.min(image.width - 1, Math.floor((area.x + x - rect.x) * kx));
                    const from = (sy * image.width + sx) * 4;
                    out.set(image.data.subarray(from, from + 4), to + x * 4);
                }
            }
        }
    }
    return out;
}
