import { app } from 'electron';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Rect } from '../shared/types.js';

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
}

export interface ElementInfo {
    ref: string;
    name: string;
    role: string;
    /** The app's own stable id, when it sets one. Makes a selector exact. */
    automation_id?: string;
    rect: Rect;
    enabled: boolean;
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
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

let child: ChildProcessWithoutNullStreams | null = null;
let nextId = 1;
let carry = '';
let unavailable: string | null = null;
const pending = new Map<number, Pending>();

/**
 * Element refs live in the helper's memory. If it dies they all become
 * meaningless, and the old code silently respawned and returned "not found" --
 * indistinguishable from an element that had merely gone away. Tracking which
 * refs the current helper issued lets callers give a real answer instead.
 */
const liveElementRefs = new Set<string>();

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

function helperPath(): string {
    // Packaged: alongside the app under resources. Development: the cargo build.
    const packaged = join(process.resourcesPath ?? '', 'uia-helper.exe');
    if (existsSync(packaged)) return packaged;
    return join(app.getAppPath(), 'native', 'uia-helper', 'target', 'release', 'uia-helper.exe');
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
    if (msg.ok) entry.resolve(msg.result);
    else entry.reject(new Error(msg.error ?? 'helper error'));
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
    try {
        child = spawn(exe, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (err) {
        unavailable = `could not start the UI Automation helper: ${(err as Error).message}`;
        return false;
    }

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
        carry += chunk;
        const lines = carry.split('\n');
        carry = lines.pop() ?? '';
        for (const l of lines) handleLine(l);
    });
    child.on('exit', () => {
        // Fail every in-flight request rather than let callers hang.
        for (const [, p] of pending) {
            clearTimeout(p.timer);
            p.reject(new Error('the UI Automation helper exited'));
        }
        pending.clear();
        // Every el_* ref died with it. Forget them so callers get a clear
        // "re-run find_ui_elements" rather than a silent empty result.
        liveElementRefs.clear();
        child = null;
        carry = '';
    });
    child.on('error', err => {
        unavailable = `UI Automation helper error: ${err.message}`;
    });
    unavailable = null;
    return true;
}

function send<T>(op: string, params: Record<string, unknown> = {}, timeoutMs = 8000): Promise<T> {
    if (!start()) return Promise.reject(new Error(unavailable ?? 'helper unavailable'));
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error(`UI Automation helper timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        timer.unref?.();
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
        child!.stdin.write(`${JSON.stringify({ id, op, ...params })}\n`);
    });
}

/** Top-level windows, our own excluded — pointing at the overlay is never useful. */
export async function listWindows(): Promise<WindowInfo[]> {
    const all = await send<WindowInfo[]>('list_windows');
    return all.filter(w => w.pid !== process.pid && !w.minimized);
}

export async function findElements(opts: {
    window?: string;
    name?: string;
    role?: string;
    automationId?: string;
    limit?: number;
}): Promise<ElementInfo[]> {
    // A full-tree search can take ~100ms on a large app; allow generous headroom.
    const { automationId, ...rest } = opts;
    const found = await send<ElementInfo[]>(
        'find_elements',
        { ...rest, automation_id: automationId },
        15000
    );
    for (const e of found) liveElementRefs.add(e.ref);
    return found;
}

/** The whole accessible tree of one window, bounded. */
export async function describeWindow(opts: {
    window: string;
    maxNodes?: number;
    maxDepth?: number;
}): Promise<DescribedNode[]> {
    const nodes = await send<DescribedNode[]>(
        'describe',
        { window: opts.window, max_nodes: opts.maxNodes, max_depth: opts.maxDepth },
        20000
    );
    for (const n of nodes) liveElementRefs.add(n.ref);
    return nodes;
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
 * that list_windows trims.
 */
export function printWindow(ref: string, path: string): Promise<Rect> {
    return send<Rect>('print_window', { window: ref, path }, 20000);
}

/** Send wheel notches to a window. Negative scrolls down, as a wheel does. */
export function scrollWindow(ref: string, notches: number): Promise<{ scrolled: boolean }> {
    return send<{ scrolled: boolean }>('scroll_window', { window: ref, notches }, 6000);
}

/** Recognise text in a PNG. Coordinates come back in that image's pixels. */
export function ocrImage(path: string): Promise<OcrLine[]> {
    return send<OcrLine[]>('ocr', { path }, 30000);
}

/** Re-read current rectangles. The tracker's hot path — keep the timeout short. */
export function resolveRefs(refs: string[]): Promise<ResolvedRef[]> {
    if (refs.length === 0) return Promise.resolve([]);
    const stale = refs.find(r => !isElementRefLive(r));
    if (stale) return Promise.reject(new StaleRefError(stale));
    return send<ResolvedRef[]>('resolve', { refs }, 3000);
}

export function uiaUnavailableReason(): string | null {
    return unavailable;
}

export function stopUia(): void {
    if (child && !child.killed) child.kill();
    child = null;
}
