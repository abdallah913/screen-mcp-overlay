import type { Point, Rect } from './types.js';
import { clean, rectText } from './uitree.js';
import type { Layer } from './visible.js';

/**
 * Naming a window without a round trip.
 *
 * Every tool used to need a numeric ref, so the first move of almost every task
 * was list_windows: a call, plus a response that grows by a line per open
 * window, just to learn a number. Accepting a title substring, or
 * "foreground", lets an agent go straight to describe_window("Notepad").
 *
 * Pure so it can be unit tested; the caller supplies the live window list,
 * which is only ever the windows the user shared: a window that is not shared
 * must read exactly like one that is not open (see sharing.ts).
 */

export interface WindowLike {
    ref: string;
    title: string;
    rect: Rect;
    foreground: boolean;
    minimized?: boolean;
    /** On another virtual desktop, or a suspended app's frame. */
    cloaked?: boolean;
    /** Runs as administrator, so UIPI blocks reading it. */
    elevated?: boolean;
    hung?: boolean;
}

/** Words that mean "the window in front": the frontmost shared one (see matchWindow). */
const FOREGROUND = new Set(['foreground', 'active', 'focused', 'current']);

/** True for a ref as list_windows prints it: a stringified HWND. */
export function isWindowRef(query: string): boolean {
    return /^-?\d+$/.test(query.trim());
}

/**
 * Why a window query found nothing, worded the same whether the window is not
 * open, is open but not shared, or the ref was made up: any difference would
 * tell the agent that an app it guessed is running. Lists the shared windows
 * only, so a wrong guess among them is cheap to correct, and says how to get
 * one shared. Echoes nothing but the agent's own query, tidied (whitespace
 * collapsed, cut at 80 characters) by the query alone: nothing downstream may
 * rewrite it depending on what is open, or a guess that comes back changed
 * would say a window with that title exists.
 */
export function notShared(query: string, shared: readonly Pick<WindowLike, 'ref' | 'title'>[]): string {
    const listed = shared
        .slice(0, 8)
        .map(w => `${w.ref} "${clean(w.title).slice(0, 50)}"`)
        .join(', ');
    return (
        `no shared window matches "${clean(query).slice(0, 80)}".` +
        (listed ? ` Shared: ${listed}${shared.length > 8 ? ', …' : ''}.` : '') +
        ' Windows stay private until the user shares them; list_windows with ask:"<why you need it>" asks the ' +
        'user to share one.'
    );
}

/**
 * Pick the window a query means, or explain why none matches.
 *
 * An exact title beats a substring, and among several matches the frontmost
 * wins: the window list arrives in z-order, and the one in front is nearly
 * always the one the user means. Guessing beats an "ambiguous" error here
 * because the chosen window's title is in every response, so a wrong guess is
 * visible and cheap to correct.
 *
 * Given only shared windows, "foreground" is the frontmost shared one. Which
 * window has focus is never consulted, here or in a tie: when the user is in
 * a window they did not share, no shared window has it, so any choice made by
 * focus would come out differently and say where they are.
 */
export function matchWindow<W extends WindowLike>(query: string, windows: W[]): W | string {
    const q = query.trim();
    if (windows.length === 0) return notShared(q, windows);

    if (FOREGROUND.has(q.toLowerCase())) return windows[0]!;

    const needle = q.toLowerCase();
    const exact = windows.find(w => w.title.trim().toLowerCase() === needle);
    if (exact) return exact;
    const partial = windows.find(w => w.title.toLowerCase().includes(needle));
    if (partial) return partial;
    return notShared(q, windows);
}

/**
 * Like matchWindow, but a window the user cannot currently see still counts
 * when no visible one matches: minimised first, then one on another virtual
 * desktop. Answering "no window contains Notepad" for a minimised Notepad made
 * agents conclude the app was closed and plan around that. Visible windows
 * still win, because suspended UWP frames are cloaked too and would otherwise
 * shadow the real one. The note says what the user would have to do.
 * `all` is the shared windows only, so a note never names anything else, and a
 * miss lists them all, minimised ones included.
 */
export function pickWindow<W extends WindowLike>(query: string, all: W[]): { window: W; note?: string } | string {
    const visible = all.filter(w => !w.minimized && !w.cloaked);
    const found = matchWindow(query, visible);
    if (typeof found !== 'string') return { window: found };
    if (FOREGROUND.has(query.trim().toLowerCase())) return found;

    const minimized = matchWindow(query, all.filter(w => w.minimized));
    if (typeof minimized !== 'string') {
        return {
            window: minimized,
            note: `"${clean(minimized.title)}" is minimized: focus_window restores it; until then nothing in it can be drawn on.`
        };
    }
    const cloaked = matchWindow(query, all.filter(w => w.cloaked && !w.minimized));
    if (typeof cloaked !== 'string') {
        return {
            window: cloaked,
            note:
                `"${clean(cloaked.title)}" is on another virtual desktop (or suspended), so the user cannot see it; ` +
                'focus_window brings it to them.'
        };
    }
    return notShared(query, all);
}

/**
 * Why a window cannot be drawn on or scrolled right now (`next` names the
 * action), or null when it can. A minimised window's controls are parked
 * offscreen, one on another desktop is not where the user is looking, and a
 * hung one answers no queries; each needs a different next step, and none of
 * them is "the control does not exist".
 */
export function windowBlocker(w: WindowLike, next: string): string | null {
    const name = `"${clean(w.title)}"`;
    if (w.minimized) return `${name} is minimized: focus_window restores it, then ${next}.`;
    if (w.cloaked) return `${name} is on another virtual desktop: focus_window brings it to the user, then ${next}.`;
    if (w.hung) return `${name} is not responding, so its controls cannot be read; wait for it to recover.`;
    return null;
}

/** Why a window cannot be used as it is, in a few words for a list line. */
export function windowFlags(w: WindowLike): string {
    return (
        (w.minimized ? ' [minimized]' : '') +
        (w.cloaked && !w.minimized ? ' [other desktop]' : '') +
        (w.elevated ? ' [admin]' : '') +
        (w.hung ? ' [not responding]' : '')
    );
}

/**
 * One window per line: `ref WxH@x,y title`, the same shape everywhere. Only
 * ever for a shared window. Which one has focus is left out: when the user is
 * working in a window they did not share, no shared window has it, so a mark
 * on the focused one would say so by being missing.
 */
export function windowLine(w: WindowLike): string {
    return `${w.ref} ${rectText(w.rect)} ${clean(w.title)}${windowFlags(w)}`;
}

/**
 * Whether a target counts as covered, and by what: the names of the windows on
 * top (already made safe to show: a shared window's title, the chat panel, or
 * "another window"), or null when it is visible enough to act on. The centre point decides
 * most cases, since that is where a user clicks; a target more than half hidden
 * counts even with its centre clear. A sliver under a topmost utility window
 * does not, or nearly every drawing would carry a warning.
 */
export function coverVerdict(c: { fraction: number; centre_covered: boolean; by: string[] }): string | null {
    if (!c.centre_covered && c.fraction < 0.5) return null;
    const by = c.by.map(clean).filter(Boolean).slice(0, 2);
    return by.length > 0 ? by.join(', ') : 'another window';
}

/**
 * True when an image is one flat colour, give or take noise.
 *
 * PrintWindow renders GPU and DirectX surfaces (games, canvas apps, video) as
 * black, which is exactly the content read_text exists for, so a flat render is
 * treated as a failed one. Samples a grid rather than every pixel: a real
 * window has a title bar, text or edges somewhere on a 64x64 grid.
 *
 * `data` is BGRA or RGBA, four bytes per pixel, rows packed.
 */
export function nearlyUniform(data: Uint8Array, width: number, height: number): boolean {
    if (width <= 0 || height <= 0 || data.length < width * height * 4) return true;
    const steps = 64;
    const first = [data[0]!, data[1]!, data[2]!];
    let off = 0;
    let total = 0;
    for (let sy = 0; sy < steps; sy += 1) {
        const y = Math.min(height - 1, Math.floor(((sy + 0.5) * height) / steps));
        for (let sx = 0; sx < steps; sx += 1) {
            const x = Math.min(width - 1, Math.floor(((sx + 0.5) * width) / steps));
            const i = (y * width + x) * 4;
            total += 1;
            if (Math.abs(data[i]! - first[0]!) + Math.abs(data[i + 1]! - first[1]!) + Math.abs(data[i + 2]! - first[2]!) > 24) {
                off += 1;
            }
        }
    }
    return off / total < 0.01;
}

/**
 * A rect in a window render's pixels, as an offset from the window's visible
 * top-left: the numbers an anchor {window} takes, so a drawing follows the
 * window instead of going stale in screen space.
 *
 * The render covers the raw window rect, which on Windows 10 and 11 includes an
 * invisible resize border (~7px left, right and bottom) that the window list
 * trims off; `raw` and `visible` are those two origins, in the same pixels.
 */
export function windowOffsets(r: Rect, imageScale: number, raw: Point, visible: Point): Rect {
    const k = imageScale > 0 ? imageScale : 1;
    return {
        x: Math.round(r.x / k + raw.x - visible.x),
        y: Math.round(r.y / k + raw.y - visible.y),
        width: Math.round(r.width / k),
        height: Math.round(r.height / k)
    };
}

/** A window of the full z-ordered stack, as the helper's zorder op lists it. */
export interface StackLike {
    ref: string;
    pid: number;
    rect: Rect;
}

/**
 * The stack as layers for composing a capture: which windows are painted.
 * Our own windows (the overlay with its step strip, and the chat panel, which
 * carries the user's conversation) never are, whatever `shared` says.
 */
export function captureLayers<S extends StackLike>(
    stack: readonly S[],
    own: { pid: number; panel?: string },
    shared: (w: S) => boolean
): Layer[] {
    return stack.map(w => ({ rect: w.rect, shared: w.ref !== own.panel && w.pid !== own.pid && shared(w) }));
}
