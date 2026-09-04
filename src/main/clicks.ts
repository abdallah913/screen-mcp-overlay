import { ipcMain } from 'electron';
import type { ClickResult, Point } from '../shared/types.js';
import { physicalToImagePoint } from '../shared/geometry.js';
import { listDisplays } from './displays.js';
import { store } from './store.js';

/**
 * Human-in-the-loop pointing. `wait_for_user_click` turns the overlay
 * interactive, collects N clicks, and hands their coordinates back to the agent
 * in every space it might need — including back into the screenshot it was
 * looking at when it asked.
 *
 * Implemented as a long-running tool call rather than MCP elicitation on
 * purpose: elicitation is form/URL-shaped and unsupported by several clients,
 * while a blocking tool call works everywhere.
 */

interface Pending {
    id: string;
    captureId?: string;
    want: number;
    got: ClickResult[];
    resolve: (r: ClickResult[]) => void;
    reject: (e: Error) => void;
    timer: NodeJS.Timeout;
}

let pending: Pending | null = null;

export function initClicks(): void {
    ipcMain.on('overlay:click', (_e, payload: { displayId: string; dip: Point }) => {
        if (!pending) return;
        const display = listDisplays().find(d => d.id === payload.displayId);
        if (!display) return;

        const physical: Point = {
            x: payload.dip.x * display.scaleFactor,
            y: payload.dip.y * display.scaleFactor
        };
        const result: ClickResult = {
            displayId: display.id,
            physical: round(physical),
            dip: round(payload.dip),
            normalized: {
                x: +(physical.x / display.physicalSize.width).toFixed(4),
                y: +(physical.y / display.physicalSize.height).toFixed(4)
            }
        };

        const capture = pending.captureId ? store.capture(pending.captureId) : undefined;
        if (capture && capture.displayId === display.id) {
            result.image = round(physicalToImagePoint(physical, capture));
        }

        pending.got.push(result);
        if (pending.got.length >= pending.want) finish(p => p.resolve(p.got));
    });

    ipcMain.on('overlay:cancel-click', () => {
        finish(p => p.reject(new Error('the user cancelled the click request')));
    });
}

function round(p: Point): Point {
    return { x: Math.round(p.x), y: Math.round(p.y) };
}

function finish(action: (p: Pending) => void): void {
    if (!pending) return;
    const p = pending;
    pending = null;
    clearTimeout(p.timer);
    store.setClickRequest(null);
    action(p);
}

export function requestClicks(opts: {
    prompt: string;
    count: number;
    timeoutMs: number;
    captureId?: string;
}): Promise<ClickResult[]> {
    if (pending) {
        return Promise.reject(new Error('another click request is already waiting; only one can be active at a time'));
    }

    return new Promise<ClickResult[]>((resolve, reject) => {
        const id = store.nextId('click');
        const timer = setTimeout(() => {
            finish(p =>
                p.got.length > 0
                    ? p.resolve(p.got)
                    : p.reject(new Error(`timed out after ${opts.timeoutMs}ms with no click`))
            );
        }, opts.timeoutMs);
        timer.unref?.();

        pending = {
            id,
            captureId: opts.captureId,
            want: opts.count,
            got: [],
            resolve,
            reject,
            timer
        };
        store.setClickRequest({ id, prompt: opts.prompt, count: opts.count });
    });
}

export function cancelClicks(): void {
    finish(p => p.reject(new Error('the click request was cancelled')));
}

export function hasPendingClick(): boolean {
    return pending !== null;
}
