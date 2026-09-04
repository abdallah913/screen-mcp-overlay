import { findElements, listWindows, type ElementInfo } from './uia.js';

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
 */

export type WaitCondition = 'appears' | 'disappears' | 'enabled';

export interface WaitRequest {
    condition: WaitCondition;
    window?: string;
    name?: string;
    role?: string;
    timeoutMs: number;
    pollMs: number;
}

export interface WaitOutcome {
    met: boolean;
    waitedMs: number;
    /** The control that satisfied the condition, for `appears` and `enabled`. */
    element?: ElementInfo;
    /** How many times the tree was searched, so cost is visible. */
    polls: number;
}

function satisfied(condition: WaitCondition, matches: ElementInfo[]): ElementInfo | null | false {
    switch (condition) {
        case 'appears':
            return matches[0] ?? false;
        case 'enabled': {
            const usable = matches.find(m => m.enabled);
            return usable ?? false;
        }
        case 'disappears':
            // Nothing to return: success is the absence of a match.
            return matches.length === 0 ? null : false;
    }
}

/**
 * One check of the current state.
 *
 * Waiting on a top-level window goes through the window list rather than the
 * accessibility tree. An unscoped UIA descendant search costs seconds across a
 * busy desktop, which made detection latency worse than the thing being waited
 * for; EnumWindows answers the same question in milliseconds.
 */
async function probe(req: WaitRequest): Promise<ElementInfo[]> {
    const wantsWindow = req.role === 'window' && !req.window;
    if (wantsWindow) {
        const needle = req.name?.toLowerCase();
        return (await listWindows())
            .filter(w => !needle || w.title.toLowerCase().includes(needle))
            .map(w => ({ ref: w.ref, name: w.title, role: 'window', rect: w.rect, enabled: true }));
    }
    return findElements({
        window: req.window,
        name: req.name,
        role: req.role,
        // Without a name filter the helper can short-circuit on the first match,
        // which turns a whole-tree walk into an early exit.
        limit: req.condition === 'disappears' || req.name ? 10 : 1
    });
}

export async function waitForElement(req: WaitRequest): Promise<WaitOutcome> {
    const started = Date.now();
    let polls = 0;

    for (;;) {
        polls += 1;
        let matches: ElementInfo[] = [];
        try {
            matches = await probe(req);
        } catch (err) {
            // A transient helper failure should not end the wait early, but a
            // permanent one (missing binary) would spin forever, so surface it.
            if (Date.now() - started > req.timeoutMs) {
                throw err;
            }
        }

        const result = satisfied(req.condition, matches);
        if (result !== false) {
            return {
                met: true,
                waitedMs: Date.now() - started,
                element: result ?? undefined,
                polls
            };
        }

        if (Date.now() - started >= req.timeoutMs) {
            return { met: false, waitedMs: Date.now() - started, polls };
        }
        await new Promise(r => setTimeout(r, req.pollMs));
    }
}
