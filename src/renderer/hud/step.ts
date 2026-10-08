import type { StepView, UserAnswer } from '../../shared/types.js';
import { parseProgress } from '../../shared/progress.js';

/**
 * What the panel's step card shows, kept apart from the DOM so it can be
 * tested. The card is the same pending step the overlay strip shows, with the
 * same answers, for someone who would rather look at the panel than at a strip
 * floating over their app -- and the only place a terminal agent's question
 * can be answered with more than a button.
 */

export interface StepButton {
    label: string;
    answer: UserAnswer;
    /** Shown as a key hint; also what the key does while the panel has focus. */
    key?: string;
    primary?: boolean;
}

/** At most this many options get number keys, matching show_message's limit. */
const MAX_KEYED = 4;

export function stepButtons(step: StepView): StepButton[] {
    switch (step.mode) {
        case 'watch':
            return [
                { label: 'Done', answer: { kind: 'done' }, primary: true },
                { label: "Can't find it", answer: { kind: 'stuck' } },
                { label: 'Skip', answer: { kind: 'skip' } }
            ];
        case 'click':
            // The overlay is capturing the click; this is the way out that does
            // not involve knowing about Escape.
            return [{ label: 'Cancel', answer: { kind: 'skip' } }];
        case 'choice':
            return (step.options ?? []).map((label, index) => ({
                label,
                answer: { kind: 'choice', index },
                key: index < MAX_KEYED ? String(index + 1) : undefined
            }));
    }
}

/** The option a number key picks, or null. */
export function choiceForKey(step: StepView, key: string): number | null {
    if (step.mode !== 'choice' || !/^[1-9]$/.test(key)) return null;
    const index = Number(key) - 1;
    return index < Math.min(MAX_KEYED, step.options?.length ?? 0) ? index : null;
}

/** The prompt without its "n/N " prefix, and the progress it carried. */
export function stepHeading(step: StepView): { prompt: string; progress: string | null } {
    const parsed = parseProgress(step.prompt);
    const progress = step.progress ?? parsed;
    return {
        prompt: parsed?.rest ?? step.prompt,
        progress: progress ? `${progress.n}/${progress.of}` : null
    };
}

export function timeLeft(deadline: number, now: number): string {
    const secs = Math.max(0, Math.ceil((deadline - now) / 1000));
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m}:${String(s).padStart(2, '0')} left`;
}

/** "1 of 3 points" for a multi-click step; nothing for a single click. */
export function clickProgress(step: StepView): string | null {
    if (step.mode !== 'click' || step.count <= 1) return null;
    return `${step.collected} of ${step.count} points`;
}

/** The global keys that answer this step, for a line under the buttons. */
export function keysHint(step: StepView): string | null {
    const parts: string[] = [];
    if (step.keys.done) parts.push(`${step.keys.done} done`);
    if (step.keys.stuck) parts.push(`${step.keys.stuck} can't find it`);
    if (step.keys.cancel) parts.push(`${step.keys.cancel} cancel`);
    return parts.length > 0 ? `From any app: ${parts.join(' · ')}` : null;
}

/** The same instruction posted twice (show_message, then the step) is logged once. */
export function sameText(a: string, b: string): boolean {
    const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();
    return norm(a) === norm(b);
}
