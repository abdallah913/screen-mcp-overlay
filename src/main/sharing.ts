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
/** The last full window list seen, and which of it was shared then. */
let lastAll: Identity[] = [];
let sharedThen = new Set<string>();
/**
 * Windows the user stopped sharing this session, while still open. They read
 * as not open from then on, so nothing may report them later, not even that
 * they closed: a wait started while one was shared would otherwise tell the
 * agent when it closed.
 */
const revokedRefs = new Set<string>();
/** Bumped whenever the user stops sharing something: a read in flight when it moves must not be returned. */
let revocations = 0;
let apps: Set<string> | undefined;
const listeners = new Set<() => void>();
const revokedListeners = new Set<() => void>();
const noticeListeners = new Set<(text: string) => void>();

/**
 * Said whenever the user stops a share. Nothing can be taken back from an
 * agent's conversation, and pretending otherwise would be the worst kind of
 * privacy promise: one the user relies on and that is false.
 */
const ALREADY_SEEN = 'What an agent already saw stays in its conversation; the panel’s New button starts its conversation afresh.';

/** Who changed a share: only what the user did is told back to them in the panel. */
export interface ShareChange {
    byUser?: boolean;
}

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
    lastAll = [...all];
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
    sharedThen = new Set(sharedOf(lastAll).map(w => w.ref));
}

/** Whether the user stopped sharing this window while it was open (see revokedRefs). */
export function wasRevoked(ref: string): boolean {
    return revokedRefs.has(ref);
}

/** How many times the user has stopped sharing something; compare before and after a read. */
export function revocationCount(): number {
    return revocations;
}

export function shareWindow(w: Pick<WindowInfo, 'ref' | 'pid' | 'title' | 'exe'>, how: ShareChange = {}): void {
    grants.set(w.ref, { ref: w.ref, pid: w.pid, title: w.title, exe: w.exe, since: Date.now() });
    announce();
    if (how.byUser) tell(`Now sharing “${w.title}” with the AI, and the dialogs it opens. ${howToStop()}`);
}

export function stopSharingWindow(ref: string, how: ShareChange = {}): void {
    const g = grants.get(ref);
    if (!g) return;
    grants.delete(ref);
    // Known even before any window list was read.
    revokedRefs.add(ref);
    revoked();
    if (how.byUser) tell(`Stopped sharing “${g.title}” with the AI. ${ALREADY_SEEN}`);
}

export function shareApp(exe: string, how: ShareChange = {}): void {
    const name = exe.toLowerCase();
    if (!canShareWholeApp(name) || appSet().has(name)) return;
    appSet().add(name);
    updateSettings({ sharedApps: [...appSet()] });
    announce();
    if (how.byUser) tell(`Now sharing every ${appLabel(name)} window with the AI, now and after a restart. ${howToStop()}`);
}

export function stopSharingApp(exe: string, how: ShareChange = {}): void {
    const name = exe.toLowerCase();
    if (!appSet().delete(name)) return;
    updateSettings({ sharedApps: [...appSet()] });
    revoked();
    if (how.byUser) tell(`Stopped sharing ${appLabel(name)} windows with the AI. ${ALREADY_SEEN}`);
}

/** The panic switch: nothing is shared afterwards, apps included. */
export function stopSharingEverything(how: ShareChange = {}): void {
    if (grants.size === 0 && appSet().size === 0) return;
    grants.clear();
    appSet().clear();
    updateSettings({ sharedApps: [] });
    revoked();
    if (how.byUser) tell(`Stopped sharing everything with the AI. ${ALREADY_SEEN}`);
}

function howToStop(): string {
    return keyInUse
        ? `Press ${keyInUse} in a shared window, or use the tray menu, to stop.`
        : 'The tray menu stops it.';
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

/**
 * Hear when the user stops sharing something (not when a shared window
 * closes): files already written from it, such as captures, are to go, so
 * an agent cannot read them back after the user said no.
 */
export function onSharingRevoked(fn: () => void): () => void {
    revokedListeners.add(fn);
    return () => revokedListeners.delete(fn);
}

/**
 * Lines for the user in the panel: what was shared or stopped, and what an
 * agent asked for that is not shared. Never sent to any agent.
 */
export function onSharingNotice(fn: (text: string) => void): () => void {
    noticeListeners.add(fn);
    return () => noticeListeners.delete(fn);
}

function tell(text: string): void {
    for (const fn of noticeListeners) {
        try {
            fn(text);
        } catch {
            // The panel being unavailable must not stop a share changing.
        }
    }
}

function revoked(): void {
    revocations += 1;
    const still = new Set(sharedOf(lastAll).map(w => w.ref));
    for (const ref of sharedThen) if (!still.has(ref)) revokedRefs.add(ref);
    announce();
    for (const fn of revokedListeners) {
        try {
            fn();
        } catch {
            // One cleanup failing must not stop the others.
        }
    }
}

/** The share key as the user presses it ("Ctrl+Shift+F8"), once it is registered; '' when there is none. */
let keyInUse = '';

/** Set by the app once the share key is registered, so panel lines name a key that works. */
export function setShareKeyInUse(label: string): void {
    keyInUse = label;
}

function announce(): void {
    sharedThen = new Set(sharedOf(lastAll).map(w => w.ref));
    // Shared again: it is the user's to show once more.
    for (const ref of sharedThen) revokedRefs.delete(ref);
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

/** One panel line per name this often at most: an agent retrying in a loop must not flood the panel. */
const REFUSED_REPEAT_MS = 30_000;
const refusedAt = new Map<string, number>();

/**
 * An agent asked for a window that is not shared (or not open: the agent is
 * told the same either way). The user hears about it in the panel, so a
 * request for an app they did not share is never silent. Never echoed back
 * to any agent.
 */
export function noteRefused(what: string): void {
    // The agent's own words, shown to the user: one line, and short, so it
    // cannot pass for the app's own text or push the panel's history away.
    const flat = String(what).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').trim();
    const shown = flat.length > 80 ? `${flat.slice(0, 79)}…` : flat;
    const now = Date.now();
    const key = shown.toLowerCase();
    if (shown && now - (refusedAt.get(key) ?? -Infinity) >= REFUSED_REPEAT_MS) {
        refusedAt.set(key, now);
        if (refusedAt.size > 200) refusedAt.delete(refusedAt.keys().next().value!);
        tell(
            `An agent asked for “${shown}”, which you have not shared. ` +
                (keyInUse
                    ? `To share a window, click into it and press ${keyInUse}.`
                    : 'To share a window, let the agent ask you for it.')
        );
    }
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
    lastAll = [];
    sharedThen = new Set();
    revokedRefs.clear();
    refusedAt.clear();
}

// ------------------------------------------------------------------ asking

/** While the user picks a window, how often the window in front is read. */
const FRONT_POLL_MS = 500;

/** How much of the agent's reason is shown: enough to say why, too little to pass for instructions. */
const REASON_CHARS = 160;

/**
 * The window the user is in, as they see it: not minimised or on another
 * desktop, and never one of ours (the panel, where Done was pressed).
 */
function frontOf(all: readonly WindowInfo[]): WindowInfo | undefined {
    return all.find(w => w.foreground && !w.minimized && !w.cloaked && w.pid !== process.pid);
}

/**
 * Ask the user to share the window the agent needs, without the agent naming
 * it: the user clicks into the window and presses Done, then confirms what is
 * about to be shared. The agent learns only what the user chose; a title it
 * guessed never reaches the screen, so it cannot probe for an app by watching
 * whether a prompt appears. Resolves with the window shared, or null.
 *
 * Both steps say they come from the overlay rather than the agent, and the
 * agent's reason is quoted as its words: the agent can draw a look-alike
 * question with show_message, so the wording is what tells them apart. Only
 * Done and then one of the buttons share anything; a typed reply, Skip, a
 * timeout or another step taking over all share nothing.
 */
export async function askToShare(opts: {
    reason?: string;
    timeoutMs: number;
    signal?: AbortSignal;
}): Promise<WindowInfo | null> {
    // Its quotes go too, so the reason cannot close the quote and carry on as if the overlay said it.
    const flat = (opts.reason ?? '').replace(/[“”"]/g, "'").replace(/\s+/g, ' ').trim();
    const why = flat.length > REASON_CHARS ? `${flat.slice(0, REASON_CHARS - 1)}…` : flat;
    const pick = beginStep({
        prompt:
            `Screen MCP Overlay: an AI agent asks to see the window you need help with${why ? ` (it says: “${why}”)` : ''}. ` +
            'Click into that window, then press Done. Nothing else on your screen is shared; Skip shares nothing.',
        mode: 'watch',
        timeoutMs: opts.timeoutMs,
        signal: opts.signal
    });

    // The window in front when Done is pressed, or before the user clicked our
    // own panel to press it: the panel is ours and never counts.
    let front: WindowInfo | undefined;
    let all: WindowInfo[] = [];
    let open = true;
    let wake: (() => void) | undefined;
    const look = async (): Promise<void> => {
        try {
            all = await listAllWindows();
            front = frontOf(all) ?? front;
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
        prompt:
            `Screen MCP Overlay: share “${candidate.title}” with the AI? ` +
            'It will see this window and the dialogs it opens, nothing else, until you stop sharing it.',
        mode: 'choice',
        options,
        timeoutMs: Math.min(opts.timeoutMs, 60_000),
        signal: opts.signal
    });
    const choice = await confirm.answer;
    if (choice.kind !== 'choice') return null;
    if (choice.label === 'This window') shareWindow(candidate, { byUser: true });
    else if (whole && choice.label === whole) shareApp(candidate.exe!, { byUser: true });
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
    const front = frontOf(all);
    if (!front) return `Click into the window you want to share first, then press ${keyLabel || 'the share key'}.`;
    if (granted(front.ref, front.pid)) {
        stopSharingWindow(front.ref);
        return `Stopped sharing “${front.title}” with the AI. ${ALREADY_SEEN}`;
    }
    if (isShared(front, all)) {
        const how = front.exe && appSet().has(front.exe.toLowerCase()) ? `all ${appLabel(front.exe)} windows are` : 'the window it belongs to is';
        return `“${front.title}” is already shared, because ${how}. Stop that from the tray menu.`;
    }
    shareWindow(front);
    return `Now sharing “${front.title}” with the AI, and the dialogs it opens${keyLabel ? `. Press ${keyLabel} in it again to stop` : ''}.`;
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
