import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerRead } from './read.js';
import { registerDraw } from './draw.js';
import { registerGuide } from './guide.js';
import { registerAct } from './act.js';

/**
 * Every tool this server registers, in the order clients list them.
 *
 * The built-in chat panel allow-lists tools by name, so it imports this rather
 * than keeping a copy. Its copy went stale once: it named a tool that no longer
 * existed and silently denied the panel nine that did, describe_window among
 * them. A test checks this list against what registerTools actually registers.
 */
export const TOOL_NAMES = [
    'list_windows',
    'describe_window',
    'find_ui_elements',
    'read_text',
    'capture_screen',
    'annotate',
    'clear_annotations',
    'highlight_and_wait',
    'wait_for_element',
    'wait_for_user_click',
    'focus_window',
    'scroll_window',
    'show_message'
] as const;

/** Register every tool, in TOOL_NAMES order: clients list them in registration order. */
export function registerTools(server: McpServer): void {
    registerRead(server);
    registerDraw(server);
    registerGuide(server);
    registerAct(server);
}
