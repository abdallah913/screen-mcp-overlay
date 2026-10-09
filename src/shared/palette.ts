import type { ShapeType } from './types.js';

/**
 * Default colour per shape. Shared by the tool layer, which stamps a colour on
 * every annotation it creates, and the renderer, which chooses legible text
 * for whatever colour a badge ends up with.
 *
 * The defaults are picked against real Windows UI rather than a white page.
 * Red read as "error", sat at ~1.1:1 against mid-grey chrome, and is the hue
 * protan and deutan users lose most; magenta occurs almost nowhere in app UI.
 * The step colour used to be a blue within a hair of the Windows accent, so a
 * step box around a primary button or a selected row all but vanished; violet
 * keeps a white badge number readable while staying clear of the accent. Every
 * stroke is also drawn over a dark and a light halo band, so legibility does
 * not rest on the hue alone.
 */
export const DEFAULT_COLORS: Record<ShapeType, string> = {
    box: '#ff2d95',
    highlight: '#ffd60a',
    circle: '#ff2d95',
    arrow: '#ff2d95',
    label: '#ffffff',
    spotlight: '#000000',
    step: '#7a3cff',
    done: '#30d158'
};

/** Dark and light text for a filled chip; whichever reads better on the fill wins. */
export const DARK_TEXT = '#111111';
export const LIGHT_TEXT = '#ffffff';

/**
 * Parse the colour forms the renderer works with: #rgb, #rgba, #rrggbb,
 * #rrggbbaa, rgb() and rgba(). Named colours are not handled here; the
 * renderer normalises any CSS colour through its canvas first, which returns
 * one of these forms. Returns 0..255 channels, or null when unreadable.
 */
export function parseColor(css: string): [number, number, number] | null {
    const s = css.trim().toLowerCase();
    const hex = /^#([0-9a-f]{3,8})$/.exec(s);
    if (hex) {
        const h = hex[1]!;
        if (h.length === 3 || h.length === 4) {
            return [0, 1, 2].map(i => parseInt(h[i]! + h[i]!, 16)) as [number, number, number];
        }
        if (h.length === 6 || h.length === 8) {
            return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
        }
        return null;
    }
    const fn = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(s);
    if (fn) {
        const ch = [fn[1], fn[2], fn[3]].map(v => Math.max(0, Math.min(255, Number(v))));
        return ch.some(Number.isNaN) ? null : (ch as [number, number, number]);
    }
    return null;
}

/** WCAG relative luminance, 0 (black) .. 1 (white). */
export function relativeLuminance([r, g, b]: [number, number, number]): number {
    const lin = (c: number): number => {
        const v = c / 255;
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function contrastRatio(a: number, b: number): number {
    const [hi, lo] = a > b ? [a, b] : [b, a];
    return (hi + 0.05) / (lo + 0.05);
}

/**
 * Text colour for a badge filled with `fill`. Badge text used to be white on
 * every fill, which is 3.6:1 on a mid blue and unreadable on a light colour an
 * agent picked. Choosing by contrast keeps the number legible on any fill; an
 * unreadable colour string keeps the old white.
 */
export function textOn(fill: string): string {
    const rgb = parseColor(fill);
    if (!rgb) return LIGHT_TEXT;
    const l = relativeLuminance(rgb);
    const dark = relativeLuminance(parseColor(DARK_TEXT)!);
    return contrastRatio(l, dark) > contrastRatio(l, 1) ? DARK_TEXT : LIGHT_TEXT;
}
