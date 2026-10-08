import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Annotation } from '../../../shared/types.js';
import { rectContains } from '../../../shared/geometry.js';
import { elementLine } from '../../../shared/uitree.js';
import { store } from '../../store.js';
import { requestClicks } from '../../clicks.js';
import { postToHud } from '../../hud.js';
import { resolveWindow } from '../../uia.js';
import { waitForElement, type WaitCondition, type WaitOutcome } from '../../waits.js';
import { CONDITIONS, WINDOW, guarded, isWindowRole, selectorFields, text } from './common.js';
import { placeAnchored, resolveAnchor } from './anchoring.js';

/** Waiting on the user and the UI: highlight_and_wait, wait_for_element, wait_for_user_click. */

function waitSummary(condition: WaitCondition, o: WaitOutcome): string {
    const secs = (o.waitedMs / 1000).toFixed(1);
    if (!o.met) {
        return (
            `NOT met: "${condition}" did not happen within ${secs}s (${o.polls} checks). ` +
            'The control may be named differently; describe_window shows what is there.'
        );
    }
    return `Met: "${condition}" after ${secs}s.${o.element ? `\n${elementLine(o.element)}` : ''}`;
}

const UNSCOPED_NOTE =
    '\nNote: not scoped to a window, so every check walked the whole desktop (seconds each, and the ' +
    'timeout can overshoot). Pass window to make it near-instant.';


export function registerGuide(server: McpServer): void {
    // ------------------------------------------------------- walkthrough step
    server.registerTool(
        'highlight_and_wait',
        {
            title: 'Point at something and wait',
            description:
                'One walkthrough step in one call: circle a control with your prompt, wait, then clear it. ' +
                'With until, the user operates the app normally and this returns once the UI reaches that ' +
                'state (a dialog opens, a button enables). Without until, it waits for a confirming click, ' +
                'which the overlay captures: the app does not receive it.',
            inputSchema: {
                window: z.string().describe(WINDOW),
                ...selectorFields(),
                prompt: z.string().describe('What the user should do; captions the circle.'),
                until: z
                    .object({
                        condition: z.enum(CONDITIONS),
                        ...selectorFields(false),
                        window: z.string().optional()
                    })
                    .optional()
                    .describe(
                        'The state that proves the step is done. Searched in the step\'s window unless window ' +
                            'is given; role "window" alone waits for a new top-level window.'
                    ),
                timeoutMs: z.number().int().min(1000).max(900000).default(120000),
                keep: z.boolean().default(false).describe('Leave the circle up afterwards.')
            }
        },
        args =>
            guarded('highlight_and_wait', async () => {
                const u = args.until;
                if (u && !(u.name || u.role || u.automationId)) {
                    throw new Error('until needs name, automationId or role');
                }
                const window = await resolveWindow(args.window);
                let drawn: Annotation[] = [];
                if (args.name || args.automationId || args.role) {
                    const target = await resolveAnchor({
                        window,
                        name: args.name,
                        role: args.role,
                        automationId: args.automationId
                    });
                    drawn = placeAnchored(
                        target,
                        [{ type: 'circle', fit: true, pad: 8, pulse: true, text: args.prompt }],
                        { replace: true, ttlMs: 0 }
                    );
                } else {
                    // Nothing to caption, so the prompt still needs to reach the user.
                    postToHud(args.prompt, 'info');
                }

                try {
                    if (u) {
                        const topLevel = isWindowRole(u.role) && !u.window && !u.automationId;
                        const outcome = await waitForElement({
                            condition: u.condition,
                            window: u.window ? await resolveWindow(u.window) : topLevel ? undefined : window,
                            name: u.name,
                            role: topLevel ? 'window' : u.role,
                            automationId: u.automationId,
                            timeoutMs: args.timeoutMs,
                            pollMs: 400
                        });
                        return text(waitSummary(u.condition, outcome));
                    }

                    const [click] = await requestClicks({ prompt: args.prompt, count: 1, timeoutMs: args.timeoutMs });
                    const where = `${click!.physical.x},${click!.physical.y} on display ${click!.displayId}`;
                    // Read the live annotation: the tracker may have moved it since it was drawn.
                    const circle = drawn[0] && store.list().find(a => a.id === drawn[0]!.id);
                    if (!circle) return text(`The user clicked at ${where}.`);
                    const onTarget = circle.displayId === click!.displayId && rectContains(circle.rect, click!.dip);
                    return text(
                        onTarget
                            ? `The user clicked the target (${where}).`
                            : `The user clicked OUTSIDE the target, at ${where}. They may mean something else.`
                    );
                } finally {
                    if (!args.keep && drawn.length > 0) store.clear(drawn.map(a => a.id));
                }
            })
    );

    // -------------------------------------------------------------- wait on UI
    server.registerTool(
        'wait_for_element',
        {
            title: 'Wait for the UI to reach a state',
            description:
                'Block until a control appears, disappears or becomes enabled, in one call instead of polling ' +
                'with screenshots. timeoutMs:0 checks once, which is how to assert state cheaply. role ' +
                '"window" without window waits for a top-level window. Returns NOT met on timeout.',
            inputSchema: {
                condition: z.enum(CONDITIONS),
                ...selectorFields(),
                window: z.string().optional().describe(`${WINDOW} Pass it: unscoped searches take seconds.`),
                timeoutMs: z.number().int().min(0).max(900000).default(60000)
            }
        },
        args =>
            guarded('wait_for_element', async () => {
                if (!args.name && !args.role && !args.automationId) {
                    throw new Error('needs name, automationId or role to match against');
                }
                const role = isWindowRole(args.role) ? 'window' : args.role;
                const outcome = await waitForElement({
                    condition: args.condition,
                    window: args.window ? await resolveWindow(args.window) : undefined,
                    name: args.name,
                    role,
                    automationId: args.automationId,
                    timeoutMs: args.timeoutMs,
                    pollMs: 500
                });
                // A top-level window wait uses the window list and is fast anyway.
                const slow = !args.window && !(role === 'window' && !args.automationId) ? UNSCOPED_NOTE : '';
                return text(waitSummary(args.condition, outcome) + slow);
            })
    );

    // --------------------------------------------------------------- ask user
    server.registerTool(
        'wait_for_user_click',
        {
            title: 'Ask the user to point at something',
            description:
                'Ask the user to click a point; returns it in every coordinate space. Use it instead of ' +
                'guessing what they mean. The overlay captures the click, so the app does not receive it. ' +
                'Escape cancels.',
            inputSchema: {
                prompt: z.string().describe('Shown on their screen.'),
                count: z.number().int().min(1).max(10).default(1),
                timeoutMs: z.number().int().min(1000).max(600000).default(60000),
                captureId: z.string().optional().describe('Map clicks into this capture. Default: the latest.')
            }
        },
        args =>
            guarded('wait_for_user_click', async () => {
                const results = await requestClicks({
                    prompt: args.prompt,
                    count: args.count,
                    timeoutMs: args.timeoutMs,
                    captureId: args.captureId ?? store.latestCapture()?.id
                });
                const lines = results.map((r, i) => {
                    const img = r.image ? `, image ${r.image.x},${r.image.y}` : '';
                    return (
                        `${i + 1}. display ${r.displayId}: physical ${r.physical.x},${r.physical.y}${img}, ` +
                        `normalized ${r.normalized.x},${r.normalized.y}`
                    );
                });
                return text(`The user clicked:\n${lines.join('\n')}`);
            })
    );

}
