import type { CaptureRecord, CoordSpace, DisplayInfo, Point, Rect } from './types.js';

/**
 * Coordinate conversion. This module is the single place where display scaling
 * is reasoned about; if an arrow lands in the wrong place, the bug is here.
 *
 * The canonical space is display-local *physical* pixels. Everything the agent
 * sends is converted into it, and the renderer converts once more into
 * display-local DIPs (which is what a canvas sized to the display's DIP bounds
 * actually draws in).
 */

export function scalePoint(p: Point, k: number): Point {
    return { x: p.x * k, y: p.y * k };
}

export function scaleRect(r: Rect, k: number): Rect {
    return { x: r.x * k, y: r.y * k, width: r.width * k, height: r.height * k };
}

export function translatePoint(p: Point, dx: number, dy: number): Point {
    return { x: p.x + dx, y: p.y + dy };
}

/**
 * Convert a point from `space` into display-local physical pixels.
 *
 * Window renders rebase their region to display-local before storing it, so
 * every capture kind converts identically here.
 */
export function toPhysicalPoint(p: Point, space: CoordSpace, display: DisplayInfo, capture?: CaptureRecord): Point {
    switch (space) {
        case 'physical':
            return { ...p };
        case 'dip':
            return scalePoint(p, display.scaleFactor);
        case 'normalized':
            return { x: p.x * display.physicalSize.width, y: p.y * display.physicalSize.height };
        case 'image': {
            if (!capture) throw new Error('space "image" requires a captureId');
            const unscaled = scalePoint(p, 1 / capture.imageScale);
            return translatePoint(unscaled, capture.regionPhysical.x, capture.regionPhysical.y);
        }
    }
}

/** Convert a rect from `space` into display-local physical pixels. */
export function toPhysicalRect(r: Rect, space: CoordSpace, display: DisplayInfo, capture?: CaptureRecord): Rect {
    const origin = toPhysicalPoint({ x: r.x, y: r.y }, space, display, capture);
    let w = r.width;
    let h = r.height;
    switch (space) {
        case 'physical':
            break;
        case 'dip':
            w *= display.scaleFactor;
            h *= display.scaleFactor;
            break;
        case 'normalized':
            w *= display.physicalSize.width;
            h *= display.physicalSize.height;
            break;
        case 'image':
            if (!capture) throw new Error('space "image" requires a captureId');
            w /= capture.imageScale;
            h /= capture.imageScale;
            break;
    }
    return { x: origin.x, y: origin.y, width: w, height: h };
}

/** Display-local physical pixels -> display-local DIPs, which is what we render in. */
export function physicalToDipPoint(p: Point, display: DisplayInfo): Point {
    return scalePoint(p, 1 / display.scaleFactor);
}

export function physicalToDipRect(r: Rect, display: DisplayInfo): Rect {
    return scaleRect(r, 1 / display.scaleFactor);
}

/** Display-local physical pixels -> pixels inside a given capture's PNG. */
export function physicalToImagePoint(p: Point, capture: CaptureRecord): Point {
    const local = translatePoint(p, -capture.regionPhysical.x, -capture.regionPhysical.y);
    return scalePoint(local, capture.imageScale);
}

/** Clamp a rect so it stays inside the display. Keeps stray annotations visible. */
export function clampRectToDisplay(r: Rect, display: DisplayInfo): Rect {
    const maxW = display.physicalSize.width;
    const maxH = display.physicalSize.height;
    // Normalise negative width/height (agents sometimes send x2/y2 by mistake).
    let { x, y, width, height } = r;
    if (width < 0) {
        x += width;
        width = -width;
    }
    if (height < 0) {
        y += height;
        height = -height;
    }
    x = Math.max(0, Math.min(x, maxW));
    y = Math.max(0, Math.min(y, maxH));
    width = Math.max(1, Math.min(width, maxW - x));
    height = Math.max(1, Math.min(height, maxH - y));
    return { x, y, width, height };
}

/**
 * Pick the downscale factor for a capture. Large screenshots cost a lot of
 * tokens for no extra accuracy, so cap the long edge.
 */
export function fitScale(size: { width: number; height: number }, maxDimension: number): number {
    const longest = Math.max(size.width, size.height);
    if (longest <= maxDimension) return 1;
    return maxDimension / longest;
}
