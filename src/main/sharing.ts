import { listAllWindows, setHelperShared, type WindowInfo } from './uia.js';
import { settings, updateSettings } from './settings.js';
import { beginStep } from './steps.js';

/**
 * Which windows the AI may see.
 *
 * Nothing is shared until the user shares it. A window that is not shared
 * does not exist as far as the agent can tell: no title, no pixels, no text,
 * no control names, and no answer that differs from the one a window that is
 * not open gets. Someone getting help in a spreadsheet while a video plays on
 * the side should not have the video reach the AI.
 *
 * The user shares one window (for this session, or until it closes) or a whole
 * app (kept in settings). A shared window brings the windows it owns: its
 * menus, dialogs and the file picker another process opens for it, which every
 * walkthrough needs and which the user can see came from the app they shared.
 * Other top-level windows of the same process are not shared with it: a
 * second browser window is a different thing to the user, and may be the
 * video. Whole-app sharing is not offered for such hosts (see MULTI_WINDOW_HOSTS).
 *
 * The full window list is still read internally, because deciding what is
 * covered, what opened and what a pixel belongs to needs every window. What
 * is derived from an unshared window may decide behaviour, but never wording:
 * it is "another window" at most.
 */

/** A window the user shared, bound to its process so a recycled handle does not inherit the share. */
export interface WindowGrant {
    ref: string;
    pid: number;
    title: string;
    exe?: string;
    since: number;
}

type Identity = Pick<WindowInfo, 'ref' | 'pid'> & Partial<Pick<WindowInfo, 'exe' | 'owner' | 'root_owner'>>;

/**
 * Processes whose windows are unrelated things to the user: every browser
 * window, every Explorer window, every packaged app (ApplicationFrameHost),
 * every app on a shared runtime. "All windows of this app" would share the
 * video along with the web app the user wanted help with.
 */
const MULTI_WINDOW_HOSTS = new Set([
    'chrome.exe',
    'msedge.exe',
    'firefox.exe',
    'brave.exe',
    'opera.exe',
    'opera_gx.exe',
    'vivaldi.exe',
    'arc.exe',
    'chromium.exe',
    'iexplore.exe',
    'librewolf.exe',
    'waterfox.exe',
    'zen.exe',
    'explorer.exe',
    'applicationframehost.exe',
    'electron.exe',
    'java.exe',
    'javaw.exe',
    'python.exe',
    'pythonw.exe',
    'dllhost.exe',
    'rundll32.exe'
]);

/** How deep an owner chain is followed; real ones are one or two links. */
const OWNER_HOPS = 8;

const grants = new Map<string, WindowGrant>();
let apps: Set<string> | undefined;
const listeners = new Set<() => void>();

function appSet(): Set<string> {
    apps ??= new Set(settings().sharedApps);
    return apps;
}

/** Whether the user can share every window of this app at once (see MULTI_WINDOW_HOSTS). */
export function canShareWholeApp(exe: string | undefined): exe is string {
    return Boolean(exe) && !MULTI_WINDOW_HOSTS.has(exe!.toLowerCase());
}

/** "excel.exe" as the user knows it: "Excel". */
export function appLabel(exe: string): string {
    const base = exe.replace(/\.exe$/i, '');
    return base.charAt(0).toUpperCase() + base.slice(1);
}

function granted(ref: string | undefined, pid: number | undefined): boolean {
    if (!ref) return false;
    const g = grants.get(ref);
    // An owner missing from the list is taken at its handle's word: owners are
    // the app's own windows, listed whenever they are visible.
    return Boolean(g) && (pid === undefined || g!.pid === pid);
}

/**
 * Whether the agent may see this window: shared itself, part of a shared app,
 * or owned by a shared window (its dialogs and menus). `all` is the full list
 * the window came from, to follow owners through.
 */
export function isShared(w: Identity, all: readonly Identity[]): boolean {
    const shared = appSet();
    const byRef = new Map(all.map(x => [x.ref, x]));
    const sharedOne = (ref: string | undefined): boolean => {
        if (!ref) return false;
        const known = byRef.get(ref);
        if (granted(ref, known?.pid)) return true;
        return Boolean(known?.exe && shared.has(known.exe.toLowerCase()));
    };
    if (granted(w.ref, w.pid) || (w.exe && shared.has(w.exe.toLowerCase()))) return true;
    let owner = w.owner;
    for (let hop = 0; owner && hop < OWNER_HOPS; hop += 1) {
        if (sharedOne(owner)) return true;
        owner = byRef.get(owner)?.owner;
    }
    return sharedOne(w.root_owner);
}

/** The shared windows of a full list, in its order. */
export function sharedOf<T extends Identity>(all: readonly T[]): T[] {
    return all.filter(w => isShared(w, all));
}

/** The windows the agent may see, now. Forgets shares whose window has closed. */
export async function sharedWindows(): Promise<WindowInfo[]> {
    const all = await listAllWindows();
    forgetClosed(all);
    return sharedOf(all);
}

/** The full list, plus which of it is shared: for callers that decide on both. */
export async function windowsWithSharing(): Promise<{ all: WindowInfo[]; shared: WindowInfo[] }> {
    const all = await listAllWindows();
    forgetClosed(all);
    return { all, shared: sharedOf(all) };
}

/**
 * How the agent may refer to a window: its title when shared, or a phrase
 * that says nothing about it. Use this for every window named in a response.
 */
export function windowName(w: Identity & { title?: string }, all: readonly Identity[]): string {
    return isShared(w, all) && w.title ? w.title : 'another window';
}

/** Drop shares whose window closed or whose handle now belongs to another process. */
function forgetClosed(all: readonly Identity[]): void {
    const live = new Map(all.map(w => [w.ref, w.pid]));
    let changed = false;
    for (const [ref, g] of grants) {
        // A minimised or other-desktop window is still in the full list, so
        // only a window that is really gone (or reused) loses its share.
        if (live.get(ref) !== g.pid) {
            grants.delete(ref);
            changed = true;
        }
    }
    if (changed) announce();
}

export function shareWindow(w: Pick<WindowInfo, 'ref' | 'pid' | 'title' | 'exe'>): void {
    grants.set(w.ref, { ref: w.ref, pid: w.pid, title: w.title, exe: w.exe, since: Date.now() });
    announce();
}

export function stopSharingWindow(ref: string): void {
    if (grants.delete(ref)) announce();
}

export function shareApp(exe: string): void {
    const name = exe.toLowerCase();
    if (!canShareWholeApp(name) || appSet().has(name)) return;
    appSet().add(name);
    updateSettings({ sharedApps: [...appSet()] });
    announce();
}

export function stopSharingApp(exe: string): void {
    if (!appSet().delete(exe.toLowerCase())) return;
    updateSettings({ sharedApps: [...appSet()] });
    announce();
}

/** The panic switch: nothing is shared afterwards, apps included. */
export function stopSharingEverything(): void {
    if (grants.size === 0 && appSet().size === 0) return;
    grants.clear();
    appSet().clear();
    updateSettings({ sharedApps: [] });
    announce();
}

/** What is shared, for the tray and the panel. */
export function sharingSummary(): { windows: WindowGrant[]; apps: string[] } {
    return { windows: [...grants.values()], apps: [...appSet()] };
}

/** The share set as the helper enforces it. */
export function helperShareState(): { windows: string[]; apps: string[] } {
    return { windows: [...grants.keys()], apps: [...appSet()] };
}

/** Hear when what is shared changes: to refresh the tray, and to forget what was read from an unshared window. */
export function onSharingChanged(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

function announce(): void {
    const state = helperShareState();
    // The helper refuses unshared windows on its own as well; a failed push
    // leaves it with the older (smaller or larger) set until the next change
    // or restart, and the TypeScript checks still apply meanwhile.
    setHelperShared(state.windows, state.apps).catch(() => undefined);
    for (const fn of listeners) {
        try {
            fn();
        } catch {
            // A broken listener must not stop the others hearing it.
        }
    }
}

const refusedListeners = new Set<(what: string) => void>();

/**
 * An agent asked for a window that is not shared (or not open: the agent is
 * told the same either way). The user hears about it in the panel, so a
 * request for an app they did not share is never silent. Never echoed back
 * to any agent.
 */
export function noteRefused(what: string): void {
    for (const fn of refusedListeners) {
        try {
            fn(what);
        } catch {
            // The panel being unavailable must not change what the agent is told.
        }
    }
}

export function onRefused(fn: (what: string) => void): () => void {
    refusedListeners.add(fn);
    return () => refusedListeners.delete(fn);
}

/** For tests: nothing shared, and nothing written to settings. */
export function resetSharing(): void {
    grants.clear();
    apps = new Set();
}

// ------------------------------------------------------------------ asking

/** While the user picks a window, how often the window in front is read. */
const FRONT_POLL_MS = 500;

/**
 * Ask the user to share the window the agent needs, without the agent naming
 * it: the user clicks into the window and presses Done, then confirms what is
 * about to be shared. The agent learns only what the user chose; a title it
 * guessed never reaches the screen, so it cannot probe for an app by watching
 * whether a prompt appears. Resolves with the window shared, or null.
 */
export async function askToShare(opts: {
    reason?: string;
    timeoutMs: number;
    signal?: AbortSignal;
}): Promise<WindowInfo | null> {
    const why = opts.reason?.trim();
    const pick = beginStep({
        prompt:
            `The AI asks to see the window you need help with${why ? ` (${why})` : ''}. ` +
            'Click into that window, then press Done. Nothing else on your screen is shared.',
        mode: 'watch',
        timeoutMs: opts.timeoutMs,
        signal: opts.signal
    });

    // The window in front when Done is pressed, or before the user clicked our
    // own panel to press it: the panel is ours and never in the list.
    let front: WindowInfo | undefined;
    let all: WindowInfo[] = [];
    let open = true;
    let wake: (() => void) | undefined;
    const look = async (): Promise<void> => {
        try {
            all = await listAllWindows();
            front = all.find(w => w.foreground && !w.minimized && !w.cloaked) ?? front;
        } catch {
            // Keep the last window seen; a busy helper is not a reason to fail.
        }
    };
    const watching = (async () => {
        while (open) {
            await look();
            if (!open) break;
            await new Promise<void>(r => {
                wake = r;
                setTimeout(r, FRONT_POLL_MS);
            });
        }
    })();
    const answer = await pick.answer;
    open = false;
    wake?.();
    await watching;
    await look();
    if (answer.kind !== 'done' || !front) return null;

    const candidate = front;
    if (isShared(candidate, all)) return candidate;
    const whole = canShareWholeApp(candidate.exe) ? `All ${appLabel(candidate.exe)} windows` : undefined;
    const options = ['This window', ...(whole ? [whole] : []), "Don't share"];
    const confirm = beginStep({
        prompt: `Share “${candidate.title}” with the AI? It will see this window and the dialogs it opens.`,
        mode: 'choice',
        options,
        timeoutMs: Math.min(opts.timeoutMs, 60_000),
        signal: opts.signal
    });
    const choice = await confirm.answer;
    if (choice.kind !== 'choice') return null;
    if (choice.label === 'This window') shareWindow(candidate);
    else if (whole && choice.label === whole) shareApp(candidate.exe!);
    else return null;
    return candidate;
}

/**
 * The share key: share the window in front, or stop sharing it if it is.
 * Returns what to tell the user in the panel. Never reaches the agent.
 */
export async function toggleFrontWindow(keyLabel: string): Promise<string> {
    const all = await listAllWindows();
    forgetClosed(all);
    const front = all.find(w => w.foreground && !w.minimized && !w.cloaked);
    if (!front) return 'Click into the window you want to share first, then press the share key.';
    if (grants.has(front.ref) && granted(front.ref, front.pid)) {
        stopSharingWindow(front.ref);
        return `Stopped sharing “${front.title}” with the AI.`;
    }
    if (isShared(front, all)) {
        const how = front.exe && appSet().has(front.exe.toLowerCase()) ? `all ${appLabel(front.exe)} windows are` : 'the window it belongs to is';
        return `“${front.title}” is already shared, because ${how}. Stop that from the tray menu.`;
    }
    shareWindow(front);
    return `Shared “${front.title}” with the AI${keyLabel ? `. Press ${keyLabel} in it again to stop` : ''}.`;
}

/** For tests and the share key: the share state is pushed to a helper that just started. */
export function syncHelper(): void {
    const state = helperShareState();
    setHelperShared(state.windows, state.apps).catch(() => undefined);
}

/** Exposed for the tray: the configured share key, so the menu can name it. */
export function shareKey(): string {
    return settings().shareKey;
}
