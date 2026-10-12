import type { SnapshotNode } from '../shared/types.js';
import { toSnapshotNodes, type TreeRow } from '../shared/uitree.js';
import { isShared, onSharingChanged, sharedOf, wasRevoked, windowsWithSharing } from './sharing.js';
import {
    describeWindow,
    findElements,
    listAllWindows,
    type DescribedNode,
    type ElementInfo,
    type WindowInfo
} from './uia.js';

/**
 * Blocking waits on UI state.
 *
 * This is the sequencing primitive walkthroughs need. Without it an agent has to
 * poll — capture, look, reason, capture again — and every one of those cycles
 * costs tokens. Here the agent makes a single call that returns only once the
 * application is actually ready, and pays for one request no matter how long the
 * wait was.
 *
 * The polling happens here rather than inside the helper on purpose: the helper
 * is single-threaded, and a blocking wait in it would freeze the anchor tracker,
 * so annotations would stop following their targets for the duration. Polling
 * from this side keeps the helper free between checks. It costs CPU, not tokens
 * — the event-driven version (UIA AddAutomationEventHandler) would remove even
 * that, but it changes nothing about the token cost this exists to solve.
 *
 * Only shared windows are watched (see sharing.ts). A window the user did not
 * share opening, closing or carrying a matching control never meets a wait,
 * never ends one and is never reported, so a wait cannot tell the agent what
 * else is open. The full window list is still read, to tell a window opening
 * from one being shared, and closing from being unshared. A window the user
 * stops sharing during a wait is one of those from then on (wasRevoked): its
 * closing later is not news either.
 */

export type WaitCondition = 'appears' | 'disappears' | 'enabled' | 'changes';

export interface WaitRequest {
    condition: WaitCondition;
    window?: string;
    name?: string;
    role?: string;
    automationId?: string;
    /** A value substring or a state word (checked, expanded, …) the match must carry. */
    value?: string;
    timeoutMs: number;
    pollMs: number;
    /**
     * Top-level windows that were already open when the step began, minimised
     * and other-desktop ones included. A window wait counts only windows
     * outside it: otherwise "a window appeared" is true the moment any window is
     * open, and the step confirms before the user acts. Restoring a minimised
     * window is not a window appearing either.
     */
    baseline?: WindowInfo[];
    /** Stop at once: the request went away, or the user answered the step. */
    signal?: AbortSignal;
    /**
     * Check once more right now, then return. Aborted with reason 'done' when
     * the user says they are done, which a debounce may take at their word.
     */
    lastCheck?: AbortSignal;
    /** Asked between checks; a reason ends the wait unmet. */
    giveUp?: () => string | null;
    /**
     * For "changes" on a control or a window's tree: what it looked like
     * before the user was shown the step (see changesBaseline). Without it
     * the first poll sets the baseline, which may already hold the change.
     */
    since?: string;
}

export interface WaitOutcome {
    met: boolean;
    waitedMs: number;
    /** The control that satisfied the condition, for `appears`, `enabled` and `changes`. */
    element?: ElementInfo;
    /** How many times the tree was searched, so cost is visible. */
    polls: number;
    /**
     * Why an unmet wait ended before its timeout: the window it searched
     * closed, the caller stopped it, the user asked for a last check, `giveUp`
     * said so (`reason`), or the final check kept failing, so nothing is known
     * about the condition (`unchecked`, with the helper's error as `reason`).
     */
    ended?: 'window-closed' | 'aborted' | 'last-check' | 'gave-up' | 'unchecked';
    reason?: string;
    /** Met because the searched window itself closed (a `disappears` or `changes` wait). */
    windowClosed?: boolean;
    /**
     * Unmet: the closest the last check came. A control that is there but
     * disabled, or lacks the value; a window that was already open.
     */
    seen?: ElementInfo;
}

/**
 * Whether a control carries the wanted value. A state word must match a whole
 * word, or "checked" would match "unchecked"; a value matches as a
 * case-insensitive substring, which is how typing steps are confirmed.
 */
export function valueMatches(e: Pick<ElementInfo, 'value' | 'state'>, want: string | undefined): boolean {
    const w = want?.trim().toLowerCase();
    if (!w) return true;
    if (e.state?.split(',').some(s => s.trim().toLowerCase() === w)) return true;
    return (e.value ?? '').toLowerCase().includes(w);
}

function satisfied(req: WaitRequest, all: ElementInfo[]): ElementInfo | null | false {
    const matches = all.filter(m => valueMatches(m, req.value));
    switch (req.condition) {
        case 'appears':
            return matches[0] ?? false;
        case 'enabled':
            return matches.find(m => m.enabled) ?? false;
        case 'disappears':
            // Nothing to return: success is the absence of a match.
            return matches.length === 0 ? null : false;
        case 'changes':
            return false;
    }
}

/**
 * Waiting on a top-level window goes through the window list rather than the
 * accessibility tree. An unscoped UIA descendant search costs seconds across a
 * busy desktop, which made detection latency worse than the thing being waited
 * for; EnumWindows answers the same question in milliseconds. With no selector
 * and no window, "changes" means the window list too: something opened or closed.
 */
export function isTopLevelWait(
    req: Pick<WaitRequest, 'condition' | 'window' | 'name' | 'role' | 'automationId'>
): boolean {
    if (req.window || req.automationId) return false;
    return req.role === 'window' || (req.condition === 'changes' && !req.name && !req.role);
}

function hasSelector(req: Pick<WaitRequest, 'name' | 'role' | 'automationId'>): boolean {
    return Boolean(req.name || req.role || req.automationId);
}

const asElement = (w: WindowInfo): ElementInfo => ({
    ref: w.ref,
    name: w.title,
    role: 'window',
    rect: w.rect,
    enabled: true
});

type Selected = Pick<WaitRequest, 'condition' | 'window' | 'name' | 'role' | 'automationId' | 'value'>;

async function controlMatches(req: Selected): Promise<ElementInfo[]> {
    // "Any control of this role appeared" can short-circuit on the first match,
    // which turns a whole-tree walk into an early exit. "enabled" cannot: the
    // first match may be a disabled one while an enabled one exists, and nor
    // can a value filter, which is applied here rather than in the helper.
    const firstWillDo = req.condition === 'appears' && !req.name && !req.automationId && !req.value;
    const limit = firstWillDo ? 1 : 10;
    const selector = { name: req.name, role: req.role, automationId: req.automationId };
    if (req.window) return findElements({ window: req.window, ...selector, limit });

    // No window: each shared window the user can see, front first, never the
    // desktop as a whole, which would read every app's controls.
    const { shared } = await windowsWithSharing();
    const found: ElementInfo[] = [];
    let failed: unknown;
    let answered = false;
    for (const w of shared.filter(onScreen)) {
        try {
            found.push(...(await findElements({ window: w.ref, ...selector, limit: limit - found.length })));
            answered = true;
        } catch (err) {
            // One window closing or hanging between the listing and its
            // search is not the whole check failing.
            failed = err;
        }
        if (found.length >= limit) break;
    }
    if (!answered && failed !== undefined) throw failed;
    return found;
}

/** A window the user can see: minimised and other-desktop ones are not searched or counted. */
const onScreen = (w: WindowInfo): boolean => !w.minimized && !w.cloaked;

/**
 * State words without "focused". Focus moves the moment the user clicks into
 * the app, before they have done anything the step asked for, so a "changes"
 * wait that saw it would confirm a typing step on the click into the field.
 */
export function withoutFocus(state: string | undefined): string | undefined {
    const kept = (state ?? '')
        .split(',')
        .map(w => w.trim())
        .filter(w => w && w !== 'focused');
    return kept.length > 0 ? kept.join(',') : undefined;
}

type Looks = Pick<ElementInfo, 'name' | 'value' | 'enabled' | 'state'>;

const controlKey = (m: Looks): string => JSON.stringify([m.name, m.value ?? '', m.enabled, withoutFocus(m.state) ?? '']);

/**
 * What the selected controls look like, for "changes": every match, since
 * `role: "checkbox"` selects them all and the user may tick any one. Sorted,
 * so the helper ranking them differently (after a scroll or a resize) is not
 * a change; gone counts as one.
 */
export function controlSignature(matches: Looks[]): string {
    return matches.length ? JSON.stringify(matches.map(controlKey).sort()) : '';
}

/** The match that is not as it was, to report as the one that changed. */
function changedMatch(matches: ElementInfo[], before: string | undefined): ElementInfo | null {
    const was = new Set<string>(before ? (JSON.parse(before) as string[]) : []);
    return matches.find(m => !was.has(controlKey(m))) ?? matches[0] ?? null;
}

/**
 * Rows of a window that a user action changes, for an unselected "changes".
 * Text rows and anything in a status bar or progress bar are left out: clocks,
 * caret positions and progress churn constantly with no user action, and
 * would end the wait before the user did anything.
 */
export function treeSignature(nodes: SnapshotNode[]): string {
    return nodes
        .filter(n => n.role !== 'text' && !/(^|\/)(statusbar|progressbar)\[/.test(n.key))
        // A list growing past the helper's cut changes only the count of rows
        // it skipped, so that count is part of the signature.
        .map(n => `${n.key}|${n.enabled ? 1 : 0}|${n.state ?? ''}|${n.value ?? ''}|${(n as TreeRow).unread ?? ''}`)
        .join('\n');
}

/**
 * A window's rows as an unselected "changes" compares them. Focus is taken out
 * before the rows are built, not just from the signature: a long list keeps its
 * focused row when it collapses, so focus moving down a list would otherwise
 * change which rows are kept.
 */
export function windowSignature(nodes: DescribedNode[]): string {
    return treeSignature(toSnapshotNodes(nodes.map(n => ({ ...n, state: withoutFocus(n.state) }))));
}

/** Small: a "changes" check re-reads the window every poll, and the tracker shares the helper. */
const CHANGES_MAX_NODES = 80;
const CHANGES_MIN_POLL_MS = 1000;

/**
 * One check: `hit` is the satisfying control (null when success has no
 * control, false when unmet); `seen` is the closest an unmet check came.
 */
interface Probe {
    hit: ElementInfo | null | false;
    seen?: ElementInfo;
}

/**
 * `final` is the check whose answer stands, and why: the user pressed Done,
 * or time ran out. A debounce that wants a second look cannot have one then.
 */
type Check = ((final: false | 'done' | 'timeout') => Promise<Probe>) & { slow?: boolean };

/**
 * Watches a set of shared windows for one opening or closing. `pick` chooses
 * the windows that count from the shared ones (those with a title, those of
 * the step's app). The user sharing a window that was already open is not a
 * window opening, and unsharing one is not a window closing: either would
 * end a wait on something the agent cannot see, at a moment that says what
 * the user did elsewhere. Without a baseline the first look is the start.
 *
 * A window counts as closing only if it was shared when last seen open. One
 * the user stopped sharing leaves the count as soon as that is known
 * (wasRevoked, or a look that finds it open and not shared), so its closing
 * later, even before the next look, does not end the wait: that would tell
 * the agent whether and when a window it was denied closed.
 */
function windowWatch(
    pick: (shared: WindowInfo[], all: WindowInfo[]) => WindowInfo[],
    baseline: WindowInfo[] | undefined
): (all: WindowInfo[], shared: WindowInfo[]) => Probe {
    let counted: Set<string> | undefined;
    let hidden: Set<string> | undefined;
    const begin = (all: WindowInfo[], shared: WindowInfo[]): void => {
        const visible = new Set(shared.map(w => w.ref));
        counted = new Set(pick(shared, all).map(w => w.ref));
        hidden = new Set(all.filter(w => !visible.has(w.ref)).map(w => w.ref));
    };
    if (baseline) begin(baseline, sharedOf(baseline));
    return (all, shared) => {
        if (!counted || !hidden) begin(all, shared);
        const open = new Set(all.map(w => w.ref));
        const visible = new Set(shared.map(w => w.ref));
        for (const ref of [...counted!]) {
            // Unshared from now on: never counted again, and not a window
            // opening if the user shares it once more.
            if (wasRevoked(ref) || (open.has(ref) && !visible.has(ref))) {
                counted!.delete(ref);
                hidden!.add(ref);
            }
        }
        const now = pick(shared, all);
        const fresh = now.find(w => !counted!.has(w.ref) && !hidden!.has(w.ref));
        if (fresh) return { hit: asElement(fresh) };
        const still = new Set(now.map(w => w.ref));
        // Gone because it closed (or its title no longer matches) while it was still shared.
        const gone = [...counted!].some(ref => !still.has(ref));
        return { hit: gone ? null : false };
    };
}

/**
 * A window another process opened for the step's app, if one came up: a
 * packaged app's file picker or "Open with" is not the app's own process, but
 * the app's window owns it. A window the user opens from the taskbar has no
 * such owner, so it is not the step done. Only shared windows are given, and
 * an owned window of a shared one is shared with it.
 */
function openedFor(shared: WindowInfo[], before: Set<string>, home: string): WindowInfo | undefined {
    const pid = shared.find(w => w.ref === home)?.pid;
    if (pid === undefined) return undefined;
    const app = new Set(shared.filter(w => w.pid === pid).map(w => w.ref));
    return shared.find(w => w.pid !== pid && w.owner !== undefined && app.has(w.owner) && !before.has(w.ref));
}

/** A window's tree, as a whole-window "changes" compares it. */
async function treeChangesSignature(window: string): Promise<string> {
    // Focus is left out: the user switching into the app moves it, and so
    // would decide which rows of a long list the helper keeps.
    const d = await describeWindow({ window, maxNodes: CHANGES_MAX_NODES, ignoreFocus: true });
    // Part of a tree differs from the whole one without anything changing:
    // a check that could not run, not a change.
    if (d.unanswered) throw new Error('the app stopped answering');
    return windowSignature(d.nodes);
}

/**
 * What a "changes" wait compares against, read before the step is shown: a
 * user quick to act on a slow app would otherwise have their change folded
 * into the first poll's baseline, and the step would wait for a second one.
 * Undefined when there is nothing to read, or the read failed (the first poll
 * sets it then, as before).
 */
export async function changesBaseline(req: Selected): Promise<string | undefined> {
    if (req.condition !== 'changes' || isTopLevelWait(req) || (!req.window && !hasSelector(req))) return undefined;
    try {
        return hasSelector(req) ? controlSignature(await controlMatches(req)) : await treeChangesSignature(req.window!);
    } catch {
        return undefined;
    }
}

/** Windows whose title contains `needle`, or all of them. */
const titled = (windows: WindowInfo[], needle: string | undefined): WindowInfo[] =>
    needle ? windows.filter(w => w.title.toLowerCase().includes(needle)) : windows;

/**
 * Build the per-poll check for a request. "changes" needs memory between polls
 * (what things looked like at the start), so a check is a closure, not a pure
 * function of one probe.
 *
 * Window lists are compared by ref across every window, minimised and
 * other-desktop ones included, so minimising or restoring a window, or
 * switching desktops, is not a window opening or closing.
 */
function makeCheck(req: WaitRequest): Check {
    const needle = req.name?.toLowerCase();
    if (req.condition !== 'changes') {
        if (isTopLevelWait(req)) {
            const counted = req.condition === 'appears' || req.condition === 'enabled';
            // Every window open at the start, shared or not: one the user
            // shares during the step was already open, so it has not appeared.
            const known = new Set(req.baseline?.map(w => w.ref));
            return async () => {
                const { shared } = await windowsWithSharing();
                // A minimised window has not appeared, and has not gone either:
                // the user can bring it back with one click.
                const named = counted
                    ? titled(shared.filter(onScreen), needle)
                    : titled(shared, needle).filter(w => !w.cloaked);
                // A window that was hidden when the step began is not in the
                // baseline, so it still counts as new when it is shown.
                const fresh = counted ? named.filter(w => !known.has(w.ref)) : named;
                const hit = satisfied(req, fresh.map(asElement));
                // Only a named window that was already open explains a miss;
                // with no name every window would, and none of them is the point.
                const stale = !counted ? named[0] : needle ? named.find(w => known.has(w.ref)) : undefined;
                return { hit, seen: hit === false && stale ? asElement(stale) : undefined };
            };
        }
        return async () => {
            const all = await controlMatches(req);
            const hit = satisfied(req, all);
            return { hit, seen: hit === false ? all[0] : undefined };
        };
    }

    if (isTopLevelWait(req) || (!req.window && !hasSelector(req))) {
        const watch = windowWatch(shared => titled(shared, needle), req.baseline);
        return async () => {
            const { all, shared } = await windowsWithSharing();
            return watch(all, shared);
        };
    }

    if (hasSelector(req)) {
        let before = req.since;
        return async () => {
            const matches = await controlMatches(req);
            const now = controlSignature(matches);
            before ??= now;
            return { hit: now === before ? false : changedMatch(matches, before) };
        };
    }

    // A whole window, unselected: a debounced diff of its tree, plus its
    // app's shared windows so a dialog it opens counts. Other apps' windows
    // are left out: a reminder popping up elsewhere is not the user doing the
    // step. So is another window of the same app that the user did not share
    // (a second browser window): it is not theirs to report. The debounce
    // wants the same changed tree twice in a row, so a redraw in progress
    // does not count.
    let sameApp: ((w: WindowInfo) => boolean) | undefined;
    const appWindows = (shared: WindowInfo[], all: WindowInfo[]): WindowInfo[] => {
        if (!sameApp) {
            const pid = all.find(w => w.ref === req.window)?.pid;
            sameApp = pid === undefined ? () => true : w => w.pid === pid;
        }
        return shared.filter(sameApp);
    };
    let tree = req.since;
    let pending: string | undefined;
    const watch = windowWatch(appWindows, req.baseline);
    let everyWindow = req.baseline ? new Set(req.baseline.map(w => w.ref)) : undefined;
    const signature = (): Promise<string> => treeChangesSignature(req.window!);
    const check: Check = async final => {
        const { all, shared } = await windowsWithSharing();
        everyWindow ??= new Set(all.map(w => w.ref));
        const opened = watch(all, shared);
        if (opened.hit !== false) return opened;
        const fronted = openedFor(shared, everyWindow, req.window!);
        if (fronted) return { hit: asElement(fronted) };
        const sig = await signature();
        tree ??= sig;
        if (sig === tree) {
            pending = undefined;
            return { hit: false };
        }
        // Done a moment after the change is the normal case, so the user's word
        // stands in for the second sighting. Time running out says nothing of
        // the kind: a window that never stops changing (a playing track's
        // slider, a live log) must not read as the step done.
        if (pending === sig || final === 'done') return { hit: null };
        pending = sig;
        return { hit: false };
    };
    check.slow = true;
    return check;
}

/** A closed window fails every scoped search with this; anything else is a hiccup. */
function isWindowGone(err: unknown): boolean {
    return /no window for ref/i.test((err as Error | undefined)?.message ?? '');
}

/** Consecutive failed checks after which the failure is the answer. */
const MAX_FAILURES = 3;
/** Between retries of a failed final check: long enough for a busy app to answer. */
const FINAL_RETRY_MS = 250;

/** Resolve after `ms`, or as soon as any of the signals fires. */
function pause(ms: number, signals: (AbortSignal | undefined)[]): Promise<void> {
    const live = signals.filter((s): s is AbortSignal => Boolean(s));
    if (live.some(s => s.aborted)) return Promise.resolve();
    return new Promise(resolve => {
        const done = (): void => {
            clearTimeout(timer);
            for (const s of live) s.removeEventListener('abort', done);
            resolve();
        };
        const timer = setTimeout(done, ms);
        for (const s of live) s.addEventListener('abort', done, { once: true });
    });
}

/** Settle with `p`, or with `undefined` as soon as `signal` fires. */
function unlessAborted<T>(p: Promise<T>, signal: AbortSignal | undefined): Promise<T | undefined> {
    if (!signal) return p;
    // The helper call cannot be withdrawn; if the signal wins, let it finish unobserved.
    p.catch(() => {});
    if (signal.aborted) return Promise.resolve(undefined);
    let onAbort!: () => void;
    const aborted = new Promise<undefined>(r => {
        onAbort = () => r(undefined);
        signal.addEventListener('abort', onAbort, { once: true });
    });
    return Promise.race([p, aborted]).finally(() => signal.removeEventListener('abort', onAbort));
}

/** Why a wait on a window ends when the user stops sharing it. */
export const NO_LONGER_SHARED = 'the user stopped sharing the window it was watching';

/**
 * Whether the user stopped sharing this window. One that closed while shared
 * is not that, and the waits and steps answer it the way they always have;
 * one the user stopped sharing and then closed is, however soon it closed:
 * it must not read as closed. False when the window list cannot be read and
 * nothing else says so: that is no news either way.
 */
export async function unsharedNow(ref: string): Promise<boolean> {
    if (wasRevoked(ref)) return true;
    try {
        // Not windowsWithSharing: this runs from sharing listeners, which
        // judge what changed and must not prune shares themselves.
        const all = await listAllWindows();
        const w = all.find(x => x.ref === ref);
        return w !== undefined && !isShared(w, all);
    } catch {
        return false;
    }
}

/**
 * Keep an eye on a waited-on window's share: once the user stops sharing it,
 * nothing more is read from it or reported about it, however the polls go.
 */
function watchShare(window: string | undefined): { revoked: () => boolean; stop: () => void } {
    if (!window) return { revoked: () => false, stop: () => undefined };
    let revoked = false;
    const stop = onSharingChanged(() => {
        void unsharedNow(window).then(gone => {
            revoked ||= gone;
        });
    });
    // Asked directly as well: a check that failed because the window closed
    // right after the user stopped sharing it must not read as it closing
    // while the listing above is still in flight.
    return { revoked: () => revoked || wasRevoked(window), stop: () => void stop() };
}

export async function waitForElement(req: WaitRequest): Promise<WaitOutcome> {
    const share = watchShare(req.window);
    try {
        return await waitLoop(req, share.revoked);
    } finally {
        share.stop();
    }
}

async function waitLoop(req: WaitRequest, revoked: () => boolean): Promise<WaitOutcome> {
    const started = Date.now();
    const check = makeCheck(req);
    const pollMs = check.slow ? Math.max(req.pollMs, CHANGES_MIN_POLL_MS) : req.pollMs;
    const elapsed = (): number => Date.now() - started;
    let polls = 0;
    let failures = 0;
    let succeeded = 0;
    let seen: ElementInfo | undefined;

    for (;;) {
        if (req.signal?.aborted) return { met: false, waitedMs: elapsed(), polls, ended: 'aborted' };
        const last = Boolean(req.lastCheck?.aborted);
        const final = last || elapsed() >= req.timeoutMs;
        polls += 1;

        let hit: ElementInfo | null | false = false;
        try {
            const why = !final ? false : last && req.lastCheck?.reason === 'done' ? 'done' : 'timeout';
            const probe = await unlessAborted(check(why), req.signal);
            if (probe === undefined) return { met: false, waitedMs: elapsed(), polls, ended: 'aborted' };
            hit = probe.hit;
            seen = probe.seen;
            failures = 0;
            succeeded += 1;
        } catch (err) {
            if (revoked()) return { met: false, waitedMs: elapsed(), polls, ended: 'gave-up', reason: NO_LONGER_SHARED };
            // Never judge a condition on a failed check: an empty result from
            // a helper timeout used to read as "disappears: met".
            if (req.window && isWindowGone(err)) {
                return req.condition === 'disappears' || req.condition === 'changes'
                    ? { met: true, waitedMs: elapsed(), polls, windowClosed: true }
                    : { met: false, waitedMs: elapsed(), polls, ended: 'window-closed' };
            }
            failures += 1;
            if (final && succeeded > 0) {
                // The answer rests on this check, and the app is busiest right
                // after the user acted: look again, and if it still fails say
                // the state is unknown rather than judge it on an older check.
                if (failures < MAX_FAILURES) {
                    await pause(FINAL_RETRY_MS, [req.signal]);
                    continue;
                }
                return { met: false, waitedMs: elapsed(), polls, ended: 'unchecked', reason: (err as Error).message };
            }
            // A transient helper failure should not end the wait, but a
            // persistent one (a hung app, a missing binary) is the answer.
            if (failures >= MAX_FAILURES || (succeeded === 0 && elapsed() >= req.timeoutMs)) throw err;
            await pause(Math.min(pollMs, Math.max(0, req.timeoutMs - elapsed())), [req.signal, req.lastCheck]);
            continue;
        }

        // A check that ran as the user stopped sharing the window says nothing.
        if (revoked()) return { met: false, waitedMs: elapsed(), polls, ended: 'gave-up', reason: NO_LONGER_SHARED };
        if (hit !== false) return { met: true, waitedMs: elapsed(), element: hit ?? undefined, polls };
        if (last) return { met: false, waitedMs: elapsed(), polls, ended: 'last-check', seen };
        if (elapsed() >= req.timeoutMs) return { met: false, waitedMs: elapsed(), polls, seen };
        const reason = req.giveUp?.();
        if (reason) return { met: false, waitedMs: elapsed(), polls, ended: 'gave-up', reason, seen };
        await pause(Math.min(pollMs, req.timeoutMs - elapsed()), [req.signal, req.lastCheck]);
    }
}
