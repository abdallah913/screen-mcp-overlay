import type { ClickResult, StepAnswer, StepView, UserAnswer } from '../shared/types.js';
import { store } from './store.js';

/**
 * The step the user is being asked to take, and every way it can end.
 *
 * There is one pending step at a time, shared by every client: a click request
 * (wait_for_user_click), a watched step (highlight_and_wait with until), or a
 * multiple-choice question (show_message with options). The overlay strip, the
 * panel card and the global hotkeys all answer it through answerStep(), so a
 * user can say "done", "I can't find it" or "skip" to an agent running in a
 * terminal, which has no other way to hear them while a tool call blocks.
 *
 * A step always resolves, never rejects. Escape, silence, a typed reply and a
 * client that went away are answers for the agent to act on, not errors to
 * retry; reporting them as errors made models repeat the same instruction to a
 * user who had just said no.
 */

export interface StepRequest {
    prompt: string;
    mode: StepView['mode'];
    /** Click mode: how many points to collect. */
    count?: number;
    /** Choice mode: the buttons. */
    options?: string[];
    /** Click mode: map click coordinates back into this capture. */
    captureId?: string;
    timeoutMs: number;
    /**
     * The MCP request's abort signal. It fires when the client cancels the tool
     * call (Esc in Claude Code, Stop in the panel) or its connection drops, and
     * the step then ends instead of holding the screen until it times out.
     */
    signal?: AbortSignal;
    /** Annotations marking the step's target, so the UI can dock out of their way. */
    targetIds?: string[];
    progress?: { n: number; of: number };
}

export interface StepHandle {
    id: string;
    /** Resolves when the step ends, however it ends. Never rejects. */
    answer: Promise<StepAnswer>;
    /**
     * End the step from the tool's side, e.g. because the awaited UI state
     * arrived. `answer` then resolves with `{kind: 'ended'}`. No-op if the step
     * already ended.
     */
    end(): void;
}

interface Pending {
    view: StepView;
    captureId?: string;
    got: ClickResult[];
    resolve: (a: StepAnswer) => void;
    timer: NodeJS.Timeout;
    signal?: AbortSignal;
    onAbort?: () => void;
}

let pending: Pending | null = null;

/** Labels for the keys that answer a step; set by whoever registers them. */
let keys: StepView['keys'] = {};

export function setStepKeys(next: StepView['keys']): void {
    keys = next;
    if (pending) {
        pending.view.keys = keys;
        publish();
    }
}

function publish(): void {
    store.setStep(pending ? { ...pending.view, collected: pending.got.length } : null);
}

function settle(p: Pending, answer: StepAnswer): void {
    if (pending !== p) return;
    pending = null;
    clearTimeout(p.timer);
    if (p.onAbort) p.signal?.removeEventListener('abort', p.onAbort);
    publish();
    p.resolve(answer);
}

/**
 * Start a step. A step already pending is superseded: it resolves as
 * `cancelled by superseded`, because the newest instruction is the one on
 * screen and two clients share one overlay.
 */
export function beginStep(req: StepRequest): StepHandle {
    if (pending) settle(pending, { kind: 'cancelled', by: 'superseded', partial: pending.got });

    const id = store.nextId('step');
    const now = Date.now();
    let resolve!: (a: StepAnswer) => void;
    const answer = new Promise<StepAnswer>(r => (resolve = r));

    const p: Pending = {
        view: {
            id,
            prompt: req.prompt,
            mode: req.mode,
            count: req.mode === 'click' ? Math.max(1, req.count ?? 1) : 0,
            collected: 0,
            options: req.options,
            startedAt: now,
            deadline: now + req.timeoutMs,
            progress: req.progress,
            targetIds: req.targetIds ?? [],
            keys
        },
        captureId: req.captureId,
        got: [],
        resolve,
        timer: setTimeout(() => settle(p, { kind: 'timeout', partial: p.got }), req.timeoutMs),
        signal: req.signal
    };
    p.timer.unref?.();
    pending = p;

    if (req.signal) {
        if (req.signal.aborted) {
            settle(p, { kind: 'cancelled', by: 'client', partial: [] });
        } else {
            p.onAbort = () => settle(p, { kind: 'cancelled', by: 'client', partial: p.got });
            req.signal.addEventListener('abort', p.onAbort, { once: true });
        }
    }
    if (pending === p) publish();

    return {
        id,
        answer,
        end: () => settle(p, { kind: 'ended' })
    };
}

/**
 * Answer the pending step from the user's side. `id` guards against answering a
 * newer step with a click meant for an older one. Returns whether it applied.
 */
export function answerStep(answer: UserAnswer, id?: string): boolean {
    const p = pending;
    if (!p || (id !== undefined && id !== p.view.id)) return false;
    switch (answer.kind) {
        case 'choice': {
            const label = p.view.options?.[answer.index];
            if (label === undefined) return false;
            settle(p, { kind: 'choice', index: answer.index, label });
            return true;
        }
        case 'stuck':
            settle(p, { kind: 'stuck', text: answer.text?.trim() || undefined });
            return true;
        case 'reply': {
            const text = answer.text.trim();
            if (!text) return false;
            settle(p, { kind: 'reply', text });
            return true;
        }
        default:
            settle(p, answer);
            return true;
    }
}

/** A click from the overlay, for a click-mode step. Returns whether it was used. */
export function addClick(result: ClickResult): boolean {
    const p = pending;
    if (!p || p.view.mode !== 'click') return false;
    p.got.push(result);
    if (p.got.length >= p.view.count) settle(p, { kind: 'clicks', clicks: p.got, complete: true });
    else publish();
    return true;
}

/**
 * End the pending step on the user's behalf: Escape, or "clear everything".
 * Clicks already collected are kept in the answer.
 */
export function cancelStep(by: 'esc' | 'clear'): boolean {
    const p = pending;
    if (!p) return false;
    settle(p, { kind: 'cancelled', by, partial: p.got });
    return true;
}

export function currentStep(): StepView | null {
    return pending ? { ...pending.view, collected: pending.got.length } : null;
}

/** The capture a click-mode step maps clicks into, if any. */
export function currentCaptureId(): string | undefined {
    return pending?.captureId;
}
