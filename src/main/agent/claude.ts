import { app } from 'electron';
import { basename, resolve } from 'node:path';
import type { AgentEvent, AgentProvider, SendInput } from './types.js';
import { mcpUrl } from '../mcp/server.js';
import { TOOL_NAMES } from '../mcp/tools/index.js';
import { settings } from '../settings.js';
import { store } from '../store.js';
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
 * The only built-in the agent keeps: Read, for the screenshots this server
 * writes (capture_screen returns a path, and Read is how a PNG reaches the
 * model as an image), and only for those; see panelMayRead. Bash, Write, Glob,
 * Grep and the rest are not even offered. The chat panel is for guiding the
 * user around the windows they share, not for looking through their disk:
 * a file listing or a browser history says what they watch as plainly as a
 * screenshot of the video would.
 */
const BUILTINS = ['Read'];

/**
 * Only what is specific to the panel. How to use the tools -- read the tree
 * before screenshotting, anchor rather than use coordinates -- arrives with the
 * MCP server's own instructions, so repeating it here would cost tokens and,
 * as an earlier version of this prompt showed, drift out of step with them.
 * Fixed text by construction: nothing about the desktop ever goes into it.
 */
const SYSTEM_APPEND =
    `You are the chat panel of a screen overlay on the user's desktop. You see only the windows the user has shared with the overlay, and draw on their screen with the ${SERVER_NAME} tools; follow that server's instructions for how. ` +
    'Nothing else on their screen exists for you, so never guess at window titles or what else is open: if the window you need is not shared, ask for it with list_windows {ask: "<why you need it>"} and the user picks it. ' +
    'Read opens only the screenshots those tools return. ' +
    'Show rather than tell: a circle anchored to the right control beats a paragraph describing where it is.';

/**
 * Whether the panel's agent may Read this file: a capture this server wrote
 * and still holds, at the path it was given, and nothing else on disk. Not
 * "anything in the capture folder": that folder also holds intermediate
 * renders, and a capture the store has let go of may show a window the user
 * has since stopped sharing.
 */
export function panelMayRead(file: unknown, cwd: string): boolean {
    if (typeof file !== 'string' || !file.trim()) return false;
    const asked = resolve(cwd, file);
    const name = basename(asked);
    const id = name.replace(/\.png$/i, '');
    if (id === name) return false;
    const record = store.capture(id);
    if (!record?.path) return false;
    const held = resolve(record.path);
    // Windows paths are case-insensitive, so "CAP_3.png" is the same file.
    return process.platform === 'win32' ? held.toLowerCase() === asked.toLowerCase() : held === asked;
}

type Verdict = { allowed: true } | { allowed: false; why: string };

/** The one rule, applied twice below: by the PreToolUse hook and by canUseTool. */
function judge(toolName: string, input: unknown, cwd: string): Verdict {
    if (OVERLAY_TOOLS.includes(toolName)) return { allowed: true };
    if (toolName === 'Read') {
        const file = (input as { file_path?: unknown } | null)?.file_path;
        return panelMayRead(file, cwd)
            ? { allowed: true }
            : { allowed: false, why: 'The overlay panel may Read only the screenshots its own tools returned.' };
    }
    return { allowed: false, why: `${toolName} is not available in the overlay panel; it may only see the windows the user shared and draw on the screen.` };
}

// The Agent SDK is ESM-only and this file compiles to CJS, so the type-only
// import needs an explicit resolution mode.
type QueryFn = SdkModule['query'];
type QueryHandle = ReturnType<QueryFn>;
type UserMessage = Exclude<Parameters<QueryFn>[0]['prompt'], string> extends AsyncIterable<infer M> ? M : never;

async function loadQuery(): Promise<QueryFn> {
    return (await loadSdk()).query;
}

/**
 * What the user types, handed to the agent's process as it arrives. The
 * process stays up between turns, so the conversation lives in it and nowhere
 * on disk (see persistSession); ending the inbox ends the conversation.
 */
class Inbox implements AsyncIterable<UserMessage> {
    private queue: UserMessage[] = [];
    private waiting: ((r: IteratorResult<UserMessage>) => void) | null = null;
    private ended = false;

    push(text: string): void {
        if (this.ended) return;
        const message: UserMessage = { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null };
        if (this.waiting) {
            this.waiting({ value: message, done: false });
            this.waiting = null;
        } else {
            this.queue.push(message);
        }
    }

    end(): void {
        this.ended = true;
        this.waiting?.({ value: undefined, done: true });
        this.waiting = null;
    }

    [Symbol.asyncIterator](): AsyncIterator<UserMessage> {
        return {
            next: () => {
                const message = this.queue.shift();
                if (message) return Promise.resolve({ value: message, done: false });
                if (this.ended) return Promise.resolve({ value: undefined, done: true });
                return new Promise(resolve => (this.waiting = resolve));
            }
        };
    }
}

/** One conversation: its process, what it is sent, and its session id once known. */
interface Conversation {
    handle: QueryHandle;
    inbox: Inbox;
    sessionId?: string;
    /** Resolves once the conversation is ended from this side, so a turn waiting on it stops waiting. */
    ended: Promise<void>;
    end: () => void;
}

export class ClaudeProvider implements AgentProvider {
    readonly id = 'claude';
    readonly label = 'Claude (Agent SDK)';

    private conversation: Conversation | null = null;

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
        // A conversation lives as long as its process. A session id this
        // provider does not hold (none at all after New) starts a new one:
        // there is nothing on disk to resume it from.
        let conv = this.conversation;
        if (!conv || !input.sessionId || input.sessionId !== conv.sessionId) {
            this.end();
            conv = this.start(query);
        }
        conv.inbox.push(input.prompt);

        const stopped = conv.ended.then(() => ({ done: true, value: undefined }) as const);
        let textId: string | null = null;
        let thinking = false;

        try {
            for (;;) {
                // One message at a time rather than for-await: leaving a
                // for-await loop would end the conversation with the turn.
                const pending = conv.handle.next();
                // Ended from this side (New) while waiting: the read may still
                // fail once the process is gone, and nobody is listening then.
                pending.catch(() => undefined);
                const next = await Promise.race([pending, stopped]);
                if (next.done) {
                    if (thinking) emit({ type: 'thinking', active: false });
                    if (textId) emit({ type: 'text-end', id: textId });
                    if (this.conversation === conv) {
                        // The process went away on its own; what it held went with it.
                        this.end(conv);
                        emit({ type: 'error', message: 'The conversation ended. The next message starts a new one.' });
                    }
                    emit({ type: 'done' });
                    break;
                }
                const msg = next.value;
                if ('session_id' in msg && typeof msg.session_id === 'string') conv.sessionId = msg.session_id;

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
                    // The turn is over; the conversation waits for the next message.
                    break;
                }
            }
        } catch (err) {
            // A process that failed mid-turn is not trusted with another.
            this.end(conv);
            emit({ type: 'error', message: (err as Error).message });
            emit({ type: 'done' });
        }

        return { sessionId: conv.sessionId };
    }

    /** Start a conversation: one agent process, fed what the user types. */
    private start(query: QueryFn): Conversation {
        const cwd = process.env.SCREEN_OVERLAY_CWD || app.getPath('home');
        const inbox = new Inbox();
        let end!: () => void;
        const ended = new Promise<void>(resolve => (end = resolve));

        const handle = query({
            prompt: inbox,
            options: {
                model: process.env.SCREEN_OVERLAY_MODEL || 'claude-opus-5',
                cwd,
                includePartialMessages: true,
                maxTurns: 24,
                systemPrompt: { type: 'preset', preset: 'claude_code', append: SYSTEM_APPEND },
                // None of the user's own Claude Code setup. Their settings
                // files would bring hooks, permission rules that skip
                // canUseTool, plugins and CLAUDE.md (text from their disk about
                // other work); their MCP servers would bring tools of their
                // own; auto-memory would bring notes from other sessions, and
                // keep notes on this one. The panel runs on this file alone.
                settingSources: [],
                strictMcpConfig: true,
                settings: { autoMemoryEnabled: false },
                // No transcript on disk: what the agent saw of the shared
                // windows would otherwise stay in ~/.claude/projects after the
                // user stopped sharing them, and after New.
                persistSession: false,
                mcpServers: {
                    [SERVER_NAME]: {
                        type: 'http',
                        url: mcpUrl(),
                        // The endpoint refuses a request without the token. A
                        // header rather than ?key= keeps the token out of the
                        // URL, which the SDK may log.
                        headers: { Authorization: `Bearer ${settings().token}` },
                        // The overlay tools must be in the turn-1 prompt; without
                        // this they can be deferred behind tool search and the
                        // agent will not know it can draw.
                        alwaysLoad: true
                    }
                },
                // The built-ins offered at all; everything else is absent.
                tools: BUILTINS,
                // Auto-approves our tools only. Read is left to the gates below,
                // which look at the path.
                allowedTools: OVERLAY_TOOLS,
                // The gate that always runs. canUseTool is asked only when a
                // tool would otherwise prompt, and Claude Code lets Read inside
                // the working directory (the home folder) through without
                // asking; a hook sees every call, Read of any path included.
                hooks: {
                    PreToolUse: [
                        {
                            hooks: [
                                async input => {
                                    if (input.hook_event_name !== 'PreToolUse') return {};
                                    const verdict = judge(input.tool_name, input.tool_input, cwd);
                                    return verdict.allowed
                                        ? {}
                                        : {
                                              hookSpecificOutput: {
                                                  hookEventName: 'PreToolUse' as const,
                                                  permissionDecision: 'deny' as const,
                                                  permissionDecisionReason: verdict.why
                                              }
                                          };
                                }
                            ]
                        }
                    ]
                },
                // The same rule again, for whatever does reach a prompt.
                canUseTool: async (toolName, input) => {
                    const verdict = judge(toolName, input, cwd);
                    // Return no updatedInput: supplying one would REPLACE the
                    // tool's arguments rather than approve them as-is.
                    return verdict.allowed
                        ? { behavior: 'allow' as const }
                        : { behavior: 'deny' as const, message: verdict.why };
                }
            }
        });

        const conv: Conversation = { handle, inbox, ended, end };
        this.conversation = conv;
        return conv;
    }

    /** End a conversation (the current one by default): its process goes, and what it held with it. */
    private end(conv: Conversation | null = this.conversation): void {
        if (!conv) return;
        if (this.conversation === conv) this.conversation = null;
        conv.end();
        conv.inbox.end();
        try {
            conv.handle.close();
        } catch {
            // Already gone.
        }
    }

    async interrupt(): Promise<void> {
        const conv = this.conversation;
        if (!conv) return;
        try {
            // The turn ends with a result, and the conversation carries on.
            await conv.handle.interrupt();
        } catch {
            // One that cannot be interrupted is ended; the next message starts afresh.
            this.end(conv);
        }
    }

    async reset(): Promise<void> {
        this.end();
    }
}
