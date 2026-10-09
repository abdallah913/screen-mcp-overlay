import { store } from './store.js';
import { currentStep } from './steps.js';
import { pushMessage } from './hud.js';

/**
 * When an MCP client was last heard from, and what to do about silence.
 *
 * The MCP layer is stateless, so "the agent has gone away" can only be inferred
 * from silence. Drawings left by a client whose conversation ended otherwise
 * stay on screen forever, pointing at things that no longer matter, and an
 * anchored one whose window closed comes back whenever that window does, even
 * hours later.
 *
 * So after a quiet spell the leftovers are faded, not deleted: a slow agent may
 * still be relying on them, and the user decides with Ctrl+Shift+X. The next
 * request from any client restores them.
 */

/** Silence after which drawings count as left over. */
export const IDLE_MS = 10 * 60 * 1000;
/** A drawing whose target has been gone this long is retired, not resurrected. */
export const HIDDEN_RETIRE_MS = 10 * 60 * 1000;
const CHECK_MS = 30 * 1000;

let lastRequestAt = Date.now();
let faded = false;
let timer: NodeJS.Timeout | null = null;

/** Called by the MCP server on every request. */
export function noteRequest(): void {
    lastRequestAt = Date.now();
    if (faded) {
        faded = false;
        store.markStale(false);
    }
}

export function msSinceLastRequest(): number {
    return Date.now() - lastRequestAt;
}

/**
 * Whether to fade now. Not while a step is pending (the agent is waiting on
 * the user, not gone) or while a request is still running (a long wait is
 * activity even though no new request arrived).
 */
export function shouldFade(s: { quietMs: number; stepPending: boolean; activeRequests: number; faded: boolean }): boolean {
    return !s.faded && !s.stepPending && s.activeRequests === 0 && s.quietMs >= IDLE_MS;
}

/** One pass of the idle check; exported so it can be driven without waiting. */
export function idleTick(activeRequests: () => number): void {
    store.retireHidden(HIDDEN_RETIRE_MS);
    const fade = shouldFade({
        quietMs: msSinceLastRequest(),
        stepPending: currentStep() !== null,
        activeRequests: activeRequests(),
        faded
    });
    if (!fade) return;
    faded = true;
    const n = store.markStale(true);
    if (n === 0) return;
    pushMessage(
        'system',
        `${n === 1 ? 'A drawing has' : `${n} drawings have`} been up for 10 minutes with no agent activity, ` +
            'so they are faded. Press Ctrl+Shift+X to clear them.'
    );
}

/** Start checking. `activeRequests` reports MCP requests still in flight. */
export function startIdleWatch(activeRequests: () => number): void {
    if (timer) return;
    timer = setInterval(() => idleTick(activeRequests), CHECK_MS);
    timer.unref?.();
}

export function stopIdleWatch(): void {
    if (timer) clearInterval(timer);
    timer = null;
}
