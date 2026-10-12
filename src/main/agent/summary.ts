import { quoteAgentText } from '../steps.js';

/**
 * Tool calls as the panel shows them: a line a person can read ("reading
 * “Notepad”") rather than a tool name. Shared by the built-in agent and by
 * Follow mode, which mirrors an editor session's transcript.
 *
 * The arguments are the agent's words, and so is a tool's name (any MCP
 * server the agent uses names its own), and these lines sit among the app's
 * own notices, so each is quoted the way the app quotes an agent: one short
 * line that cannot close its quote, and never the app's name. The panel also
 * marks every one of them as the agent's (hud.css), which no words can undo.
 */

/** The shapes annotate draws; anything else in a call is "shape", not the agent's word for it. */
const SHAPES = new Set(['box', 'highlight', 'circle', 'arrow', 'label', 'spotlight', 'step']);

/**
 * The overlay's own step tools put their prompt in the panel as a step card or
 * a guidance line, so a summary line for them would say the same thing twice.
 * Matched on this server's registered name only, so another server's tool of
 * the same name is still listed.
 */
export const SELF_LOGGING = /^mcp__screen-overlay__(highlight_and_wait|wait_for_user_click|show_message)$/;

/** A one-line, human-readable version of a tool call for the transcript. */
export function summarise(name: string, input: unknown): string {
    const short = name.replace(/^mcp__[^_]+__/, '');
    const args = (input ?? {}) as Record<string, unknown>;
    /** One of the agent's arguments, quoted; '' when it gave none. */
    const quoted = (value: unknown, instead: string, max?: number): string =>
        value === undefined || value === null ? '' : quoteAgentText(String(value), instead, max);
    const window = quoted(args.window, 'a window it named after this app');

    switch (short) {
        case 'list_windows':
            // With ask, the call puts a sharing request on screen; the line
            // says so, so it is not mistaken for the agent looking around.
            return args.ask ? 'asking you to share a window' : 'listing the windows you shared';
        case 'describe_window':
        case 'find_ui_elements':
            return `reading ${window || 'what you shared'}`;
        case 'read_text':
            return 'reading text off the screen';
        case 'capture_screen': {
            const display = quoted(args.display, 'a display it named after this app');
            const which = display.startsWith('“') ? `display ${display}` : display;
            return `looking at ${window || which || 'what you shared'}`;
        }
        case 'annotate': {
            const shapes = Array.isArray(args.shapes) ? args.shapes : [];
            const kinds = shapes.map(s => {
                const type = (s as { type?: unknown } | null)?.type;
                return typeof type === 'string' && SHAPES.has(type) ? type : 'shape';
            });
            const more = kinds.length > 4 ? ', …' : '';
            return `drawing ${kinds.length} shape(s): ${kinds.slice(0, 4).join(', ')}${more}`;
        }
        case 'clear_annotations':
            return 'clearing the screen';
        case 'wait_for_user_click':
        case 'highlight_and_wait':
            return `asking you: ${quoted(args.prompt, 'a step that used this app’s name')}`;
        case 'wait_for_element':
            return `waiting for ${quoted(args.name ?? args.automationId ?? args.role, 'something it named after this app') || 'the UI'}`;
        case 'show_message':
            return 'posting a message';
        case 'Read':
            // Room for a whole path, which says what the agent tried to open.
            return `reading ${quoted(args.file_path, 'a file it named after this app', 120)}`;
        default:
            // Another server's tool, named whatever it likes.
            return `using ${quoted(short, 'a tool named after this app', 40) || 'a tool'}`;
    }
}
