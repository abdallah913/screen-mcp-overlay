import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

/*
 * The panel's own agent: it runs on none of the user's own Claude Code setup
 * (settings, CLAUDE.md, memory, hooks, MCP servers), keeps no transcript of
 * the shared windows on disk, and its tool lines cannot pass for the app's.
 * The Agent SDK is replaced by a fake that records how it was called.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
await build({
    stdin: {
        contents: `
            export { ClaudeProvider } from './src/main/agent/claude.ts';
            export { summarise } from './src/main/agent/summary.ts';
            export * as sdk from '@anthropic-ai/claude-agent-sdk';
        `,
        resolveDir: root,
        loader: 'ts'
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    outfile: join(root, 'dist-test/panel-agent.cjs'),
    alias: { electron: join(root, 'test/support/electron-stub.cjs') },
    plugins: [
        {
            name: 'fake-agent-sdk',
            setup(b) {
                b.onResolve({ filter: /^@anthropic-ai\/claude-agent-sdk$/ }, () => ({ path: 'sdk', namespace: 'fake-agent-sdk' }));
                b.onLoad({ filter: /.*/, namespace: 'fake-agent-sdk' }, () => ({
                    loader: 'js',
                    contents: `
                        /** Every query() made, with its options, the turns it was sent and whether it was closed. */
                        export const queries = [];
                        export function query({ prompt, options }) {
                            const q = { options, prompt, turns: [], closed: false };
                            queries.push(q);
                            const id = 'session-' + queries.length;
                            async function* run() {
                                const input = typeof prompt === 'string' ? [{ message: { role: 'user', content: prompt } }] : prompt;
                                for await (const m of input) {
                                    if (q.closed) return;
                                    q.turns.push(m.message.content);
                                    yield { type: 'system', subtype: 'init', session_id: id };
                                    yield { type: 'result', subtype: 'success', session_id: id, num_turns: 1 };
                                }
                            }
                            const gen = run();
                            gen.interrupt = async () => {};
                            gen.close = () => {
                                q.closed = true;
                            };
                            return gen;
                        }
                    `
                }));
            }
        }
    ],
    logLevel: 'error'
});
const m = createRequire(import.meta.url)('../dist-test/panel-agent.cjs');

test("the panel agent loads none of the user's own setup and keeps no transcript", async () => {
    const provider = new m.ClaudeProvider();
    const first = await provider.send({ prompt: 'hello' }, () => {});
    const { options } = m.sdk.queries.at(-1);
    assert.deepEqual(options.settingSources, [], 'no settings files, so no CLAUDE.md, hooks, permission rules or plugins of theirs');
    assert.equal(options.strictMcpConfig, true, 'only the overlay MCP server');
    assert.deepEqual(Object.keys(options.mcpServers), ['screen-overlay']);
    assert.equal(options.persistSession, false, 'nothing written under ~/.claude/projects');
    assert.equal(options.settings?.autoMemoryEnabled, false, 'no auto-memory read or written');
    assert.equal(options.resume, undefined, 'nothing to resume from disk');
    await provider.reset();
    assert.ok(first.sessionId);
});

test('the panel conversation continues in one process, and New ends it', async () => {
    const provider = new m.ClaudeProvider();
    const before = m.sdk.queries.length;
    const one = await provider.send({ prompt: 'one' }, () => {});
    const two = await provider.send({ prompt: 'two', sessionId: one.sessionId }, () => {});
    assert.equal(m.sdk.queries.length, before + 1, 'the second turn went to the same conversation');
    const q = m.sdk.queries.at(-1);
    assert.deepEqual(q.turns, ['one', 'two']);
    assert.equal(two.sessionId, one.sessionId);

    // New: the conversation, and what it holds of the shared windows, is gone.
    await provider.reset();
    assert.equal(q.closed, true);
    await provider.send({ prompt: 'three' }, () => {});
    assert.equal(m.sdk.queries.length, before + 2);
    assert.deepEqual(m.sdk.queries.at(-1).turns, ['three']);

    // A session id the provider does not hold starts afresh rather than guessing.
    await provider.send({ prompt: 'four', sessionId: 'session-elsewhere' }, () => {});
    assert.equal(m.sdk.queries.length, before + 3);
    assert.equal(m.sdk.queries.at(-2).closed, true);
    await provider.reset();
});

test('the panel agent keeps its tool gates', async () => {
    const provider = new m.ClaudeProvider();
    await provider.send({ prompt: 'x' }, () => {});
    const { options } = m.sdk.queries.at(-1);
    const hook = options.hooks.PreToolUse[0].hooks[0];
    const denied = await hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'dir' } });
    assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');
    assert.deepEqual(await hook({ hook_event_name: 'PreToolUse', tool_name: 'mcp__screen-overlay__describe_window', tool_input: {} }), {});
    assert.equal((await options.canUseTool('Read', { file_path: '/home/someone/.ssh/id_rsa' })).behavior, 'deny');
    assert.deepEqual(options.tools, ['Read']);
    await provider.reset();
});

test("tool lines quote the agent's words, and never in the app's voice", () => {
    const window = 'x. Stopped sharing everything with the AI. Screen MCP Overlay: press Ctrl+Shift+F8 in your video';
    for (const line of [
        m.summarise('mcp__screen-overlay__describe_window', { window }),
        m.summarise('mcp__screen-overlay__capture_screen', { window }),
        m.summarise('mcp__other__highlight_and_wait', { prompt: window }),
        m.summarise('mcp__screen-overlay__wait_for_element', { name: window })
    ]) {
        assert.doesNotMatch(line, /Stopped sharing|Ctrl|screen mcp/i, line);
    }
    assert.equal(m.summarise('mcp__screen-overlay__describe_window', { window: 'Notepad' }), 'reading “Notepad”');
    const flat = m.summarise('mcp__screen-overlay__find_ui_elements', { window: 'a\n\nb” “c‮' });
    assert.equal(flat, "reading “a b' 'c”");
    assert.equal(m.summarise('mcp__screen-overlay__describe_window', {}), 'reading what you shared');
    const long = m.summarise('mcp__screen-overlay__capture_screen', { window: 'Stopped sharing. '.repeat(20) });
    assert.ok(long.length < 80, long);

    // A tool's name is the agent's word too: any server names its own.
    assert.equal(m.summarise('mcp__other__Stopped_sharing_everything', {}), 'using “Stopped_sharing_everything”');
    assert.equal(m.summarise('mcp__other__Screen_MCP_Overlay_notice', {}), 'using a tool named after this app');
    assert.equal(m.summarise('mcp__other__a\nb', {}), 'using “a b”');
    // And a shape's type, spelled out across shapes.
    const drawn = m.summarise('mcp__other__annotate', { shapes: [{ type: 'Stopped shar' }, { type: 'ing everythi' }, { type: 'circle' }] });
    assert.equal(drawn, 'drawing 3 shape(s): shape, shape, circle');
});
