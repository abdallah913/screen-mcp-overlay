import { app } from 'electron';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AnchorSelector, Rect } from '../shared/types.js';
import { isWindowRef, pickWindow } from '../shared/windows.js';

/**
 * Client for the Rust UI Automation helper.
 *
 * One long-lived process, JSON lines both ways. It has to be long-lived: the
 * anchor tracker re-reads rectangles several times a second, and a process spawn
 * per query would cost far more than the query itself.
 *
 * Everything it returns is in **physical pixels** in Windows' virtual-screen
 * space, whose origin can be negative when a second monitor sits left of or
 * above the primary one.
 */

export interface WindowInfo {
    ref: string;
    title: string;
    class: string;
    pid: number;
    rect: Rect;
    foreground: boolean;
    minimized: boolean;
    /** On another virtual desktop: Windows lists it, the user cannot see it. */
    cloaked: boolean;
    /** Runs elevated, so UIPI blocks UI Automation and window messages. */
    elevated: boolean;
    /** Not responding. */
    hung: boolean;
}

export interface ElementInfo {
    ref: string;
    name: string;
    role: string;
    /** The app's own stable id, when it sets one. Makes a selector exact. */
    automation_id?: string;
    rect: Rect;
    enabled: boolean;
    /** The control's value (an edit's text, a slider's position); never a password. */
    value?: string;
    /** Scrolled out of view: the rect is real but not visible. */
    offscreen?: boolean;
    /** Comma-joined: checked, unchecked, mixed, selected, expanded, collapsed, focused. */
    state?: string;
    /** Set when the match is in a popup (menu, dropdown) of the window's process: that popup's ref. */
    window?: string;
    /** Only with includeHidden: why the match has no usable rect. */
    hidden?: 'collapsed' | 'unselected-tab' | 'no-rect';
    /** Only with includeHidden: what to open to reveal it. */
    container?: { ref: string; name: string; role: string };
}

export interface DescribedNode {
    depth: number;
    ref: string;
    name: string;
    role: string;
    automation_id?: string;
    value?: string;
    enabled: boolean;
    rect: Rect;
    state?: string;
    offscreen?: boolean;
    /** Top node of an open popup belonging to the window. */
    popup?: boolean;
    /** Last kept item of a long same-role run: how many more siblings the walk skipped. */
    more?: number;
}

export interface Described {
    nodes: DescribedNode[];
    /** The node budget ran out before the walk finished. */
    truncated: boolean;
    /** Names of the first subtrees the walk never reached. */
    unvisited?: string[];
}

export interface PointHit {
    element: ElementInfo | null;
    window: { ref: string; title: string } | null;
}

export interface Coverage {
    /** Fraction of the area whose topmost window is not the target, 0..1. */
    fraction: number;
    centre_covered: boolean;
    /** Titles of the covering windows, nearest first. */
    by: string[];
}

export interface Occlusion {
    /** Rough fraction of the window hidden behind windows above it, 0..1. */
    covered: number;
    /** Titles of the windows on top, nearest first. */
    by: string[];
}

export interface OcrLine {
    text: string;
    rect: Rect;
}

export interface ResolvedRef {
    ref: string;
    rect: Rect | null;
    offscreen?: boolean;
    /** Why rect is null, when the helper can tell. */
    reason?: 'minimized' | 'closed' | 'other-desktop' | 'gone';
    /** An element ref from a helper that has since restarted: it names nothing now. */
    stale?: boolean;
}

type Pending = {
    resolve: (v: unknown) => void;
    reject: (e: Error) => void;
    timer: NodeJS.Timeout;
    sentAt: number;
};

let child: ChildProcessWithoutNullStreams | null = null;
let nextId = 1;
let carry = '';
let unavailable: string | null = null;
const pending = new Map<number, Pending>();
/** When the helper last wrote anything, to tell a wedged helper from a slow queue. */
let lastOutputAt = 0;
let lastKillAt = 0;
/** A wedged helper is restarted at most this often, so a broken app cannot cause a respawn loop. */
const KILL_INTERVAL_MS = 10_000;

/**
 * Element refs live in the helper's memory. If it dies they all become
 * meaningless, and the old code silently respawned and returned "not found" --
 * indistinguishable from an element that had merely gone away. Tracking which
 * refs the current helper issued lets callers give a real answer instead.
 */
const liveElementRefs = new Set<string>();

/**
 * Each helper numbers its refs from el_1, so after a restart an old el_5 and a
 * new el_5 would be different controls under one name, and a stale anchor
 * would silently land on whatever the new helper called el_5. Refs are rebased
 * on the way through so that every ref this process ever handed out is unique:
 * the helper's el_N is the client's el_{N + refBase}.
 */
let refBase = 0;
let highestRef = 0;

/**
 * How to find a control again from its ref: the window it was found in plus
 * its role and either its AutomationId or its name. Filled from every
 * window-scoped search and describe, so an anchor given as a bare {ref} can be
 * re-found after a helper restart or a relayout instead of staying hidden.
 * Bounded, oldest first out.
 */
const refSelectors = new Map<string, KnownControl>();
const SELECTOR_LIMIT = 5000;

/** What was recorded about a ref: how to find it again, and what it was called. */
export interface KnownControl {
    selector: AnchorSelector & { role: string };
    name: string;
    /**
     * The top-level window the control actually sits in, when that is a popup
     * of the searched window (an open menu): what coverage must be measured
     * against, or the popup would count as covering its own items.
     */
    top?: string;
}

export class StaleRefError extends Error {
    constructor(ref: string) {
        super(
            `element ref "${ref}" is no longer valid: the UI Automation helper restarted, which ` +
                'clears every element it had found. Call find_ui_elements again to get fresh refs.'
        );
        this.name = 'StaleRefError';
    }
}

/** True for refs this process handed out that are still backed by a live helper. */
export function isElementRefLive(ref: string): boolean {
    return !ref.startsWith('el_') || liveElementRefs.has(ref);
}

function remember(
    e: { ref: string; name: string; role: string; automation_id?: string; window?: string },
    window: string
): void {
    liveElementRefs.add(e.ref);
    const name = e.name.trim();
    if (!e.automation_id && !name) return;
    refSelectors.delete(e.ref);
    refSelectors.set(e.ref, {
        // An AutomationId alone, when there is one: it is exact, and a name
        // alongside it would stop the control being found after a relabel.
        selector: e.automation_id
            ? { window, role: e.role, automationId: e.automation_id }
            : { window, role: e.role, name },
        name,
        top: e.window
    });
    if (refSelectors.size > SELECTOR_LIMIT) {
        const oldest = refSelectors.keys().next().value;
        if (oldest !== undefined) refSelectors.delete(oldest);
    }
}

/**
 * What is known about the control behind a ref, if it was ever seen in a
 * window-scoped search or describe. Survives helper restarts, unlike the ref.
 */
export function knownControl(ref: string): KnownControl | undefined {
    return refSelectors.get(ref);
}

/** How to re-find the control behind a ref (see knownControl). */
export function selectorForRef(ref: string): (AnchorSelector & { role: string }) | undefined {
    return refSelectors.get(ref)?.selector;
}

function helperPath(): string {
    // Packaged: alongside the app under resources. Development: the cargo build.
    const packaged = join(process.resourcesPath ?? '', 'uia-helper.exe');
    if (existsSync(packaged)) return packaged;
    return join(app.getAppPath(), 'native', 'uia-helper', 'target', 'release', 'uia-helper.exe');
}

/** Rewrite every `ref: "el_N"` in a helper response into the client's numbering. */
function rebase(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(rebase);
    if (!value || typeof value !== 'object') return value;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
        const m = k === 'ref' && typeof v === 'string' ? /^el_(\d+)$/.exec(v) : null;
        if (m) {
            const n = Number(m[1]) + refBase;
            highestRef = Math.max(highestRef, n);
            out[k] = `el_${n}`;
        } else {
            out[k] = rebase(v);
        }
    }
    return out;
}

/** The helper's own name for a client ref. Only live refs are ever sent, so they are this helper's. */
function toHelperRef(ref: string): string {
    const m = /^el_(\d+)$/.exec(ref);
    return m ? `el_${Number(m[1]) - refBase}` : ref;
}

function handleLine(line: string): void {
    if (!line.trim()) return;
    let msg: { id: number; ok: boolean; result?: unknown; error?: string };
    try {
        msg = JSON.parse(line);
    } catch {
        return;
    }
    // id 0 is the unsolicited ready banner (or a parse error on our side).
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    clearTimeout(entry.timer);
    if (msg.ok) entry.resolve(rebase(msg.result));
    else entry.reject(new Error(msg.error ?? 'helper error'));
}

/**
 * Forget a helper: fail what it still owes, and drop every ref it issued.
 * Only acts for the current helper, so a killed one exiting late cannot tear
 * down its replacement.
 */
function teardown(proc: ChildProcessWithoutNullStreams, reason: string): void {
    if (child !== proc) return;
    // Fail every in-flight request rather than let callers hang.
    for (const [, p] of pending) {
        clearTimeout(p.timer);
        p.reject(new Error(reason));
    }
    pending.clear();
    // Every el_* ref died with it. Forget them so callers get a clear
    // "re-run find_ui_elements" rather than a silent empty result.
    liveElementRefs.clear();
    child = null;
    carry = '';
}

function start(): boolean {
    if (child && !child.killed) return true;
    if (process.platform !== 'win32') {
        unavailable = 'window and UI Automation queries are Windows-only';
        return false;
    }
    const exe = helperPath();
    if (!existsSync(exe)) {
        unavailable =
            `the UI Automation helper is missing (${exe}). ` +
            'Build it with: cargo build --release --manifest-path native/uia-helper/Cargo.toml';
        return false;
    }
    let proc: ChildProcessWithoutNullStreams;
    try {
        proc = spawn(exe, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (err) {
        unavailable = `could not start the UI Automation helper: ${(err as Error).message}`;
        return false;
    }
    child = proc;
    refBase = highestRef;

    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', chunk => {
        if (child !== proc) return;
        lastOutputAt = Date.now();
        carry += chunk;
        const lines = carry.split('\n');
        carry = lines.pop() ?? '';
        for (const l of lines) handleLine(l);
    });
    proc.on('exit', () => teardown(proc, 'the UI Automation helper exited'));
    proc.on('error', err => {
        unavailable = `UI Automation helper error: ${err.message}`;
    });
    unavailable = null;
    return true;
}

/**
 * Called when a request times out. The helper is single-threaded, so one call
 * into a hung application blocks everything queued behind it and every drawing
 * on screen hides. Restart it, but only when this is the oldest request in
 * flight and the helper has said nothing since it was sent: a resolve queued
 * behind a legitimately slow describe times out too, and must not kill it.
 */
function maybeRestart(sentAt: number, isOldest: boolean): void {
    const proc = child;
    if (!proc || !isOldest || lastOutputAt >= sentAt) return;
    if (Date.now() - lastKillAt < KILL_INTERVAL_MS) return;
    lastKillAt = Date.now();
    teardown(proc, 'the UI Automation helper stopped responding and was restarted');
    proc.kill();
}

export type HelperTransport = (op: string, params: Record<string, unknown>) => Promise<unknown>;
let transport: HelperTransport | null = null;

/**
 * Answer helper requests in-process instead of spawning the helper. Tests use
 * this to drive every tool through the real code above the helper on machines
 * that cannot run it.
 */
export function useHelperTransport(fn: HelperTransport | null): void {
    transport = fn;
}

function send<T>(op: string, params: Record<string, unknown> = {}, timeoutMs = 8000): Promise<T> {
    if (transport) return transport(op, params) as Promise<T>;
    if (!start()) return Promise.reject(new Error(unavailable ?? 'helper unavailable'));
    const id = nextId++;
    const sentAt = Date.now();
    const wire = Array.isArray(params.refs) ? { ...params, refs: (params.refs as string[]).map(toHelperRef) } : params;
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
            const isOldest = Math.min(...pending.keys()) === id;
            pending.delete(id);
            reject(new Error(`UI Automation helper timed out after ${timeoutMs}ms`));
            maybeRestart(sentAt, isOldest);
        }, timeoutMs);
        timer.unref?.();
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer, sentAt });
        child!.stdin.write(`${JSON.stringify({ id, op, ...wire })}\n`);
    });
}

/**
 * Windows the user can see: our own excluded (pointing at the overlay is never
 * useful), and minimised or other-desktop ones left out.
 */
export async function listWindows(): Promise<WindowInfo[]> {
    return (await listAllWindows()).filter(w => !w.minimized && !w.cloaked);
}

/** Every top-level window but our own, minimised and other-desktop ones included. */
export async function listAllWindows(): Promise<WindowInfo[]> {
    const all = await send<WindowInfo[]>('list_windows');
    return all.filter(w => w.pid !== process.pid);
}

/** One window's details (title, flags), or undefined if it is gone. */
export async function windowInfo(ref: string): Promise<WindowInfo | undefined> {
    return (await listAllWindows()).find(w => w.ref === ref);
}

/**
 * Turn whatever an agent passed as a window into a ref: a ref as-is (no helper
 * round trip), otherwise a title substring or "foreground", resolved against
 * the live window list. When no visible window matches, a minimised one and
 * then one on another virtual desktop still count, and `note` says so, so the
 * agent hears "minimized" rather than "not open". Throws with the open windows
 * listed when nothing matches, so the agent can correct itself without a
 * separate list_windows.
 */
export async function resolveWindowInfo(query: string): Promise<{ ref: string; window?: WindowInfo; note?: string }> {
    if (isWindowRef(query)) return { ref: query.trim() };
    const found = pickWindow(query, await listAllWindows());
    if (typeof found === 'string') throw new Error(found);
    return { ref: found.window.ref, window: found.window, note: found.note };
}

/** resolveWindowInfo for callers that only need the ref. */
export async function resolveWindow(query: string): Promise<string> {
    return (await resolveWindowInfo(query)).ref;
}

export async function findElements(opts: {
    window?: string;
    name?: string;
    role?: string;
    automationId?: string;
    limit?: number;
    /** Also return matches with no usable rect, marked with why and their container. */
    includeHidden?: boolean;
}): Promise<ElementInfo[]> {
    // A full-tree search can take ~100ms on a large app; allow generous headroom.
    const { automationId, includeHidden, ...rest } = opts;
    const found = await send<ElementInfo[]>(
        'find_elements',
        { ...rest, automation_id: automationId, include_hidden: includeHidden ?? false },
        15000
    );
    for (const e of found) {
        if (opts.window) remember(e, opts.window);
        else liveElementRefs.add(e.ref);
        // A hidden match names the container to open first; the agent may
        // anchor to it, so its ref must count as live too.
        if (e.container) liveElementRefs.add(e.container.ref);
    }
    return found;
}

/** The whole accessible tree of one window, bounded. */
export async function describeWindow(opts: {
    window: string;
    maxNodes?: number;
    maxDepth?: number;
}): Promise<Described> {
    const described = await send<Described>(
        'describe',
        { window: opts.window, max_nodes: opts.maxNodes, max_depth: opts.maxDepth },
        20000
    );
    // The root row is the window itself, already addressable by its own ref.
    for (const n of described.nodes) {
        if (n.depth > 0) remember(n, opts.window);
        else liveElementRefs.add(n.ref);
    }
    return described;
}

/** Bring a window to the front and give it focus. */
export function focusWindow(ref: string): Promise<{ focused: boolean }> {
    return send<{ focused: boolean }>('focus_window', { window: ref }, 6000);
}

/**
 * How much of a window is hidden behind others.
 *
 * Our own pid is excluded: the overlay windows span the whole screen, so
 * counting them would report every window as fully covered.
 */
export function occlusionOf(ref: string): Promise<Occlusion> {
    return send<Occlusion>('occlusion', { window: ref, ignore_pid: process.pid }, 6000);
}

/**
 * Render a window's own pixels to a PNG, occluded or not. Returns the raw window
 * rectangle the image corresponds to, which includes the invisible resize border
 * that list_windows trims, and whether the window refused so the screen was
 * copied instead (then anything covering it is in the image).
 */
export function printWindow(ref: string, path: string): Promise<{ rect: Rect; fallback: boolean }> {
    return send<{ rect: Rect; fallback: boolean }>('print_window', { window: ref, path }, 20000);
}

/** The control under a virtual-screen physical point, and its top-level window. Never the overlay. */
export async function elementAtPoint(x: number, y: number): Promise<PointHit> {
    const hit = await send<PointHit>('element_at_point', { x: Math.round(x), y: Math.round(y), ignore_pid: process.pid }, 4000);
    if (hit.element) {
        if (hit.window) remember(hit.element, hit.window.ref);
        else liveElementRefs.add(hit.element.ref);
    }
    return hit;
}

/**
 * How much of a window, or of a rect in it (virtual-screen physical), is hidden
 * behind other top-level windows. Our own windows never count as covering.
 */
/**
 * The chat panel's window ref. Our own windows never count as covering a
 * target -- the overlay is click-through and drawn for the user -- except the
 * panel, which is opaque and really can sit on top of what they need to click.
 */
let hudRef: string | undefined;

export function setHudWindowRef(ref: string | undefined): void {
    hudRef = ref;
}

export function coverage(window: string, rect?: Rect): Promise<Coverage> {
    return send<Coverage>('covered', { window, rect, ignore_pid: process.pid, hud: hudRef }, 4000);
}

/** Collapsed expandable controls in a window: where a control that matched nothing may be. */
export async function collapsedControls(window: string, limit = 8): Promise<ElementInfo[]> {
    const found = await send<ElementInfo[]>('collapsed', { window, limit }, 15000);
    for (const e of found) liveElementRefs.add(e.ref);
    return found;
}

/** Scroll a control into view (UIA ScrollItemPattern): a view change, not input. */
export async function scrollIntoView(
    window: string,
    selector: { name?: string; role?: string; automationId?: string }
): Promise<{ scrolled: boolean; element: ElementInfo }> {
    const r = await send<{ scrolled: boolean; element: ElementInfo }>(
        'scroll_into_view',
        { window, name: selector.name, role: selector.role, automation_id: selector.automationId },
        8000
    );
    remember(r.element, window);
    return r;
}

/** The names in a window closest to one that matched nothing. */
export function suggestNames(
    window: string,
    name: string,
    role?: string,
    limit = 3
): Promise<{ name: string; role: string }[]> {
    return send<{ name: string; role: string }[]>('suggest', { window, name, role, limit }, 15000);
}

/** Send wheel notches to a window. Negative scrolls down, as a wheel does. */
/**
 * Send wheel notches to a window. before/after are the vertical scroll
 * position (0..100) of the nearest scrollable element, when one reports it,
 * so a scroll that moved nothing can say so.
 */
export function scrollWindow(
    ref: string,
    notches: number
): Promise<{ scrolled: boolean; before?: number; after?: number }> {
    return send<{ scrolled: boolean; before?: number; after?: number }>('scroll_window', { window: ref, notches }, 6000);
}

/** Recognise text in a PNG. Coordinates come back in that image's pixels. */
export function ocrImage(path: string): Promise<OcrLine[]> {
    return send<OcrLine[]>('ocr', { path }, 30000);
}

/**
 * Re-read current rectangles. The tracker's hot path — keep the timeout short.
 *
 * Refs from a helper that has since restarted are answered locally as stale
 * rather than sent: the helper would reject the whole batch for one of them,
 * and one orphaned anchor used to hide every drawing on screen that way.
 */
export async function resolveRefs(refs: string[]): Promise<ResolvedRef[]> {
    const live = refs.filter(isElementRefLive);
    const answered = live.length > 0 ? await send<ResolvedRef[]>('resolve', { refs: live }, 3000) : [];
    const byRef = new Map(answered.map(r => [r.ref, r]));
    return refs.map(ref => byRef.get(ref) ?? { ref, rect: null, stale: !isElementRefLive(ref) || undefined });
}

export function uiaUnavailableReason(): string | null {
    return unavailable;
}

export function stopUia(): void {
    const proc = child;
    if (!proc) return;
    teardown(proc, 'the UI Automation helper was stopped');
    if (!proc.killed) proc.kill();
}
