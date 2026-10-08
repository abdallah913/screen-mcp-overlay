import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { postToHud, speak } from '../../hud.js';
import { focusWindow, resolveWindow, scrollWindow } from '../../uia.js';
import { WINDOW, guarded, text } from './common.js';

/** Acting on windows and talking to the user: focus_window, scroll_window, show_message. */

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
                const window = await resolveWindow(args.window);
                await focusWindow(window);
                return text(`Window ${window} is in front.`);
            })
    );

    // ------------------------------------------------------------------ scroll
    server.registerTool(
        'scroll_window',
        {
            title: 'Scroll a window',
            description: 'Scroll a window by wheel notches, without moving the pointer. Refs and rects change afterwards.',
            inputSchema: {
                window: z.string().describe(WINDOW),
                notches: z.number().int().min(-30).max(30).default(-3).describe('Negative scrolls down.')
            }
        },
        args =>
            guarded('scroll_window', async () => {
                await scrollWindow(await resolveWindow(args.window), args.notches);
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
                speak: z.boolean().default(false)
            }
        },
        async args => {
            postToHud(args.text, args.level);
            if (args.speak && !speak(args.text, 1)) {
                return text('Shown, but not spoken: the overlay panel is not running.');
            }
            return text(args.speak ? 'Shown and spoken.' : 'Shown.');
        }
    );
}
