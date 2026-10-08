import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { elementLine } from '../../../shared/uitree.js';
import { windowBlocker } from '../../../shared/windows.js';
import { postToHud, speak } from '../../hud.js';
import { beginStep } from '../../steps.js';
import { focusWindow, resolveWindowInfo, scrollIntoView, scrollWindow } from '../../uia.js';
import { answerText } from './answers.js';
import { WINDOW, guarded, text } from './common.js';

/** Acting on windows and talking to the user: focus_window, scroll_window, show_message. */

/**
 * How long a question waits for an answer. Long enough for someone who stepped
 * away to come back and read it; short enough that an agent is not left
 * blocked indefinitely by a user who has gone for the day.
 */
const CHOICE_TIMEOUT_MS = 300_000;

export function registerAct(server: McpServer): void {
    // ------------------------------------------------------------------- focus
    server.registerTool(
        'focus_window',
        {
            title: 'Bring a window to the front',
            description: 'Raise a window and focus it, so what you guide the user through is visible. Does not click or type.',
            inputSchema: { window: z.string().describe(WINDOW) }
        },
        args =>
            guarded('focus_window', async () => {
                const w = await resolveWindowInfo(args.window);
                await focusWindow(w.ref);
                // Restoring a minimised window, or fetching one from another
                // desktop, is the usual reason to call this; say it happened.
                const how = w.window?.minimized ? ' (restored from minimized)' : w.window?.cloaked ? ' (from another desktop)' : '';
                return text(`Window ${w.ref} is in front${how}.`);
            })
    );

    // ------------------------------------------------------------------ scroll
    server.registerTool(
        'scroll_window',
        {
            title: 'Scroll a window',
            description:
                'Scroll a window by wheel notches without moving the pointer, or bring the control named by ' +
                'name/automationId/role into view. Refs and rects change afterwards.',
            inputSchema: {
                window: z.string().describe(WINDOW),
                notches: z.number().int().min(-30).max(30).default(-3).describe('Negative scrolls down.'),
                name: z.string().optional(),
                automationId: z.string().optional(),
                role: z.string().optional()
            }
        },
        args =>
            guarded('scroll_window', async () => {
                const w = await resolveWindowInfo(args.window);
                const blocker = w.window && windowBlocker(w.window, 'scroll');
                if (blocker) throw new Error(blocker);

                if (args.name || args.automationId || args.role) {
                    // UIA's ScrollItemPattern scrolls the right pane by exactly
                    // enough, which wheel notches at the window centre cannot.
                    // It moves the view, like the wheel; it never clicks.
                    const selector = { name: args.name, automationId: args.automationId, role: args.role };
                    const r = await scrollIntoView(w.ref, selector).catch((err: Error) => {
                        throw new Error(
                            `could not scroll ${JSON.stringify(selector)} into view: ${err.message}. Wheel ` +
                                'notches (omit name) may still work, or ask the user to scroll.'
                        );
                    });
                    const line = elementLine(r.element);
                    if (r.element.offscreen) {
                        return text(`Tried, but it still reports as out of view: ${line}. Ask the user to scroll to it.`);
                    }
                    return text(r.scrolled ? `Scrolled into view: ${line}` : `Already in view: ${line}`);
                }

                await scrollWindow(w.ref, args.notches);
                return text(
                    `Scrolled ${args.notches} notch(es). Re-read to see the new content; some apps ignore ` +
                        'wheel messages unless the pointer is over them.'
                );
            })
    );

    // ------------------------------------------------------------------ notify
    server.registerTool(
        'show_message',
        {
            title: 'Tell the user something',
            description:
                'Post a line in the overlay panel, the only way to show text for clients with no UI of their ' +
                'own. speak:true also says it aloud, for hands-free guidance; keep spoken lines to a sentence.',
            inputSchema: {
                text: z.string().max(2000),
                level: z.enum(['info', 'warn', 'error']).default('info'),
                speak: z.boolean().default(false),
                options: z.array(z.string().max(40)).max(4).optional().describe('Buttons; blocks until one is picked.')
            }
        },
        async (args, extra) => {
            postToHud(args.text, args.level);
            const unspoken = args.speak && !speak(args.text, 1);
            if (!args.options?.length) {
                if (unspoken) return text('Shown, but not spoken: the overlay panel is not running.');
                return text(args.speak ? 'Shown and spoken.' : 'Shown.');
            }

            // A question the user answers on screen, for agents (a terminal CLI
            // especially) that otherwise have to end their turn to ask and get
            // free text back a turn later. The answer always comes back as text
            // in the tool result, so it works with no UI on the client side.
            const started = Date.now();
            const step = beginStep({
                prompt: args.text,
                mode: 'choice',
                options: args.options,
                timeoutMs: CHOICE_TIMEOUT_MS,
                signal: extra.signal
            });
            const answer = await step.answer;
            const said = answerText(answer, Date.now() - started) ?? 'The question ended without an answer.';
            return text(unspoken ? `${said}\n(Not spoken: the overlay panel is not running.)` : said);
        }
    );
}
