import { app } from 'electron';
import type { AgentEvent, AgentProvider, SendInput } from './types.js';
import { mcpUrl } from '../mcp/server.js';
import { TOOL_NAMES } from '../mcp/tools/index.js';
import { loadSdk, sdkUnavailable, type SdkModule } from './sdk.js';
import { summarise } from './summary.js';

/**
 * The built-in provider: Claude, via the Claude Agent SDK.
 *
 * The SDK is ESM-only and pulls in a bundled CLI, so it is imported lazily --
 * the overlay starts and serves MCP without ever loading it if the user only
 * drives the app from their own terminal.
 */

const SERVER_NAME = 'screen-overlay';

/**
 * Our own MCP tools, in the mcp__<server>__<tool> form the agent sees them as.
 * Derived from the server's own list: a hand-kept copy here once named a tool
 * that no longer existed and left out nine that did, so canUseTool denied the
 * panel describe_window and every other cheap way of reading the screen.
 */
const OVERLAY_TOOLS = TOOL_NAMES.map(t => `mcp__${SERVER_NAME}__${t}`);

/**
 * Read-only built-ins the agent may use unprompted. Everything else -- Bash,
 * Write, Edit and friends -- is refused by canUseTool below. The chat panel is
 * for guiding the user around their screen, not for editing their machine.
 */
const ALLOWED_BUILTINS = ['Read', 'Glob', 'Grep'];

/**
 * Only what is specific to the panel. How to use the tools -- read the tree
 * before screenshotting, anchor rather than use coordinates -- arrives with the
 * MCP server's own instructions, so repeating it here would cost tokens and,
 * as an earlier version of this prompt showed, drift out of step with them.
 */
const SYSTEM_APPEND = `You are the chat panel of a screen overlay on the user's desktop. You see their screen and draw on it with the ${SERVER_NAME} tools; follow that server's instructions for how. Show rather than tell: a circle anchored to the right control beats a paragraph describing where it is.`;

// The Agent SDK is ESM-only and this file compiles to CJS, so the type-only
// import needs an explicit resolution mode.
type QueryFn = SdkModule['query'];
type QueryHandle = ReturnType<QueryFn>;

async function loadQuery(): Promise<QueryFn> {
    return (await loadSdk()).query;
}

export class ClaudeProvider implements AgentProvider {
    readonly id = 'claude';
    readonly label = 'Claude (Agent SDK)';

    private active: QueryHandle | null = null;

    async check(): Promise<string | null> {
        try {
            await loadQuery();
        } catch (err) {
            return sdkUnavailable(err);
        }
        if (!mcpUrl()) return 'The MCP server has not started yet.';
        return null;
    }

    async send(input: SendInput, emit: (e: AgentEvent) => void): Promise<{ sessionId?: string }> {
        const query = await loadQuery();

        const handle = query({
            prompt: input.prompt,
            options: {
                model: process.env.SCREEN_OVERLAY_MODEL || 'claude-opus-5',
                cwd: process.env.SCREEN_OVERLAY_CWD || app.getPath('home'),
                resume: input.sessionId,
                includePartialMessages: true,
                maxTurns: 24,
                systemPrompt: { type: 'preset', preset: 'claude_code', append: SYSTEM_APPEND },
                mcpServers: {
                    [SERVER_NAME]: {
                        type: 'http',
                        url: mcpUrl(),
                        // The overlay tools must be in the turn-1 prompt; without
                        // this they can be deferred behind tool search and the
                        // agent will not know it can draw.
                        alwaysLoad: true
                    }
                },
                allowedTools: [...OVERLAY_TOOLS, ...ALLOWED_BUILTINS],
                // allowedTools only auto-approves. This is the actual gate.
                canUseTool: async toolName => {
                    const permitted =
                        OVERLAY_TOOLS.includes(toolName) || ALLOWED_BUILTINS.includes(toolName);
                    // Return no updatedInput: supplying one would REPLACE the
                    // tool's arguments rather than approve them as-is.
                    return permitted
                        ? { behavior: 'allow' as const }
                        : {
                              behavior: 'deny' as const,
                              message: `${toolName} is not available in the overlay panel; it may only see the screen and draw on it.`
                          };
                }
            }
        });

        this.active = handle;
        let sessionId = input.sessionId;
        let textId: string | null = null;
        let thinking = false;

        try {
            for await (const msg of handle) {
                if ('session_id' in msg && typeof msg.session_id === 'string') sessionId = msg.session_id;

                if (msg.type === 'stream_event') {
                    const ev = msg.event as { type: string; [k: string]: unknown };

                    if (ev.type === 'content_block_start') {
                        const block = ev.content_block as { type?: string } | undefined;
                        if (block?.type === 'text') {
                            textId = `t_${msg.uuid}`;
                            emit({ type: 'text-start', id: textId });
                        } else if (block?.type === 'thinking' && !thinking) {
                            thinking = true;
                            emit({ type: 'thinking', active: true });
                        }
                    } else if (ev.type === 'content_block_delta') {
                        const delta = ev.delta as { type?: string; text?: string } | undefined;
                        if (delta?.type === 'text_delta' && delta.text) {
                            if (!textId) {
                                textId = `t_${msg.uuid}`;
                                emit({ type: 'text-start', id: textId });
                            }
                            if (thinking) {
                                thinking = false;
                                emit({ type: 'thinking', active: false });
                            }
                            emit({ type: 'text-delta', id: textId, delta: delta.text });
                        }
                    } else if (ev.type === 'content_block_stop') {
                        if (textId) {
                            emit({ type: 'text-end', id: textId });
                            textId = null;
                        }
                    }
                    continue;
                }

                if (msg.type === 'assistant') {
                    for (const block of msg.message.content) {
                        if (block.type === 'tool_use') {
                            emit({ type: 'tool', name: block.name, summary: summarise(block.name, block.input) });
                        }
                    }
                    continue;
                }

                if (msg.type === 'result') {
                    if (thinking) emit({ type: 'thinking', active: false });
                    if (textId) emit({ type: 'text-end', id: textId });
                    if (msg.subtype !== 'success') {
                        emit({ type: 'error', message: `The turn ended early (${msg.subtype}).` });
                    }
                    emit({
                        type: 'done',
                        costUsd: 'total_cost_usd' in msg ? (msg.total_cost_usd as number) : undefined,
                        turns: msg.num_turns
                    });
                }
            }
        } catch (err) {
            emit({ type: 'error', message: (err as Error).message });
            emit({ type: 'done' });
        } finally {
            this.active = null;
        }

        return { sessionId };
    }

    async interrupt(): Promise<void> {
        const handle = this.active;
        if (!handle) return;
        try {
            await handle.interrupt();
        } catch {
            handle.close();
        }
        this.active = null;
    }
}
