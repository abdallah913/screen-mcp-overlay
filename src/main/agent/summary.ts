/**
 * Tool calls as the panel shows them: a line a person can read ("reading
 * Notepad") rather than a tool name. Shared by the built-in agent and by Follow
 * mode, which mirrors an editor session's transcript.
 */

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

    switch (short) {
        case 'list_windows':
            return 'listing your windows';
        case 'describe_window':
        case 'find_ui_elements':
            return `reading ${args.window ? String(args.window) : 'the screen'}`;
        case 'read_text':
            return 'reading text off the screen';
        case 'capture_screen':
            return `looking at ${args.window ? String(args.window) : args.display ? `display ${String(args.display)}` : 'the screen'}`;
        case 'annotate': {
            const shapes = Array.isArray(args.shapes) ? args.shapes : [];
            const kinds = shapes.map(s => String((s as { type?: unknown }).type ?? '?'));
            return `drawing ${kinds.length} shape(s): ${kinds.join(', ')}`;
        }
        case 'clear_annotations':
            return 'clearing the screen';
        case 'wait_for_user_click':
        case 'highlight_and_wait':
            return `asking you: ${String(args.prompt ?? '')}`;
        case 'wait_for_element':
            return `waiting for ${String(args.name ?? args.automationId ?? args.role ?? 'the UI')}`;
        case 'show_message':
            return 'posting a message';
        case 'Read':
            return `reading ${String(args.file_path ?? '')}`;
        default:
            return short;
    }
}
