import type { StepAnswer } from '../../../shared/types.js';

/**
 * The one vocabulary every tool uses to report how a user step ended.
 *
 * Each line leads with a status word an agent can branch on, and none of them
 * is an error: Escape, silence and "I can't find it" are the user's answer,
 * and reporting them as tool failures made models retry the same instruction
 * at a user who had just said no. The server instructions list these words, so
 * change them in both places.
 *
 * Returns null for answers the caller formats itself: completed clicks, and a
 * step the tool ended on its own (`ended`).
 */
export function answerText(a: StepAnswer, waitedMs: number): string | null {
    const secs = `${Math.round(waitedMs / 1000)}s`;
    switch (a.kind) {
        case 'done':
            return `DONE after ${secs}: the user says they did it.`;
        case 'stuck':
            return `STUCK after ${secs}: the user can't find it.${a.text ? ` They said: "${a.text}"` : ''}`;
        case 'skip':
            return `SKIPPED after ${secs}: the user chose to skip this step.`;
        case 'reply':
            return `REPLIED after ${secs}: "${a.text}"`;
        case 'choice':
            return `CHOSE ${a.index + 1} "${a.label}"`;
        case 'timeout':
            return `NO RESPONSE in ${secs}: the user may be away or unsure.${partial(a.partial.length)}`;
        case 'cancelled':
            switch (a.by) {
                case 'esc':
                    return `CANCELLED: the user pressed Escape after ${secs}; ask what is wrong before repeating the step.${partial(a.partial.length)}`;
                case 'clear':
                    return `CANCELLED: the user cleared the screen after ${secs}; ask before drawing again.`;
                case 'client':
                    return 'CANCELLED: the request was cancelled before the user answered.';
                case 'superseded':
                    return 'CANCELLED: a newer step replaced this one before the user answered.';
            }
            break;
        case 'clicks':
        case 'ended':
            return null;
    }
    return null;
}

function partial(n: number): string {
    return n > 0 ? ` PARTIAL: ${n} click(s) came in first.` : '';
}
