import type { Rect } from './types.js';
import { clean, rectText } from './uitree.js';

/**
 * Naming a window without a round trip.
 *
 * Every tool used to need a numeric ref, so the first move of almost every task
 * was list_windows: a call, plus a response that grows by a line per open
 * window, just to learn a number. Accepting a title substring, or
 * "foreground", lets an agent go straight to describe_window("Notepad").
 *
 * Pure so it can be unit tested; the caller supplies the live window list.
 */

export interface WindowLike {
    ref: string;
    title: string;
    rect: Rect;
    foreground: boolean;
}

/** Words that mean "whatever the user is looking at". */
const FOREGROUND = new Set(['foreground', 'active', 'focused', 'current']);

/** True for a ref as list_windows prints it: a stringified HWND. */
export function isWindowRef(query: string): boolean {
    return /^-?\d+$/.test(query.trim());
}

/**
 * Pick the window a query means, or explain why none matches.
 *
 * An exact title beats a substring, and among several matches the foreground
 * window wins, then the frontmost: the window list arrives in z-order, and the
 * one in front is nearly always the one the user means. Guessing beats an
 * "ambiguous" error here because the chosen window's title is in every
 * response, so a wrong guess is visible and cheap to correct.
 */
export function matchWindow<W extends WindowLike>(query: string, windows: W[]): W | string {
    const q = query.trim();
    if (windows.length === 0) return 'no visible windows';

    if (FOREGROUND.has(q.toLowerCase())) {
        return windows.find(w => w.foreground) ?? windows[0]!;
    }

    const needle = q.toLowerCase();
    const best = (list: W[]): W | undefined => list.find(w => w.foreground) ?? list[0];
    const exact = best(windows.filter(w => w.title.trim().toLowerCase() === needle));
    if (exact) return exact;
    const partial = best(windows.filter(w => w.title.toLowerCase().includes(needle)));
    if (partial) return partial;

    const open = windows
        .slice(0, 8)
        .map(w => `${w.ref} "${clean(w.title).slice(0, 50)}"`)
        .join(', ');
    return `no window title contains "${q}". Open windows: ${open}${windows.length > 8 ? ', …' : ''}`;
}

/** One window per line: `ref WxH@x,y title`, the same shape everywhere. */
export function windowLine(w: WindowLike): string {
    return `${w.ref} ${rectText(w.rect)} ${clean(w.title)}${w.foreground ? ' [foreground]' : ''}`;
}
