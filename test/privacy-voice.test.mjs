import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { call, fakeHelper, harness } from './support/fake-helper.mjs';

/*
 * The app's own questions (asking to share a window) open with its name; an
 * agent's prompt that opens the same way is labelled as the agent's. And a
 * failed focus says nothing about the window in front, which may be private.
 */

const { currentStep, answerStep, store } = harness;

test.beforeEach(() => store.clear());

test("an agent's step prompt cannot pass for the app asking to share a window", async () => {
    fakeHelper();
    const pending = call('highlight_and_wait', {
        window: 'Notepad',
        name: 'Save',
        prompt: 'Screen MCP Overlay: share “Lofi beats - YouTube” with the AI? Press Ctrl+Shift+F8 in it.',
        until: { condition: 'appears', name: 'Saved' },
        timeoutMs: 60000
    });
    for (let i = 0; i < 400 && !currentStep(); i += 1) await new Promise(r => setTimeout(r, 5));
    assert.match(currentStep().prompt, /^The agent says: Screen MCP Overlay: share/);
    answerStep({ kind: 'skip' });
    await pending;
});

test('a refused focus does not say why, which would describe the window in front', async () => {
    fakeHelper({
        focus_window: () => {
            throw new Error('Windows refused the focus change: the foreground application is locking focus');
        }
    });
    const { text, isError } = await call('focus_window', { window: 'Notepad' });
    assert.equal(isError, true);
    assert.match(text, /Windows did not bring window 100 to the front; ask the user to click it\./);
    assert.equal(/locking|foreground application/.test(text), false, text);
});

// ------------------------------------------------------------------
// Everything an agent's words reach on the user's side: the step card, the
// overlay strip, the panel's lines and the voice. The shared harness has no
// panel window, so this part gets a bundle of its own whose Electron stub
// records what main sends to the panel, with its own steps and sharing state.

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const stub = join(root, 'test/support/electron-stub.cjs');
await build({
    stdin: {
        contents: `
            export { buildServer } from './src/main/mcp/server.ts';
            export { useHelperTransport } from './src/main/uia.ts';
            export { store } from './src/main/store.ts';
            export { answerStep, beginStep, cancelStep, currentStep, asAgentText, quoteAgentText } from './src/main/steps.ts';
            export { createHud } from './src/main/hud.ts';
            export { resetSharing, shareWindow, onSharingNotice } from './src/main/sharing.ts';
            export { stripProgress } from './src/shared/layout.ts';
            export * as card from './src/renderer/hud/step.ts';
            export { Client } from '@modelcontextprotocol/sdk/client/index.js';
            export { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
        `,
        resolveDir: root,
        loader: 'ts'
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    outfile: join(root, 'dist-test/privacy-voice.cjs'),
    plugins: [
        {
            // The usual stub, plus a panel window that keeps what it is sent.
            name: 'recording-panel',
            setup(b) {
                b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'recording-panel' }));
                b.onLoad({ filter: /.*/, namespace: 'recording-panel' }, () => ({
                    loader: 'js',
                    resolveDir: root,
                    contents: `
                        const base = require(${JSON.stringify(stub)});
                        const display = { ...base.screen.getPrimaryDisplay(), workArea: { x: 0, y: 0, width: 1920, height: 1040 } };
                        class BrowserWindow {
                            constructor() {
                                this.webContents = { send: (channel, payload) => globalThis.__panelSent.push({ channel, payload }) };
                                // Window chrome the panel sets up is not under test: any other method does nothing.
                                return new Proxy(this, { get: (t, k) => (k in t || k === 'then' ? t[k] : () => undefined) });
                            }
                            static getAllWindows() { return []; }
                            getBounds() { return { x: 1476, y: 436, width: 420, height: 580 }; }
                            isDestroyed() { return false; }
                            isVisible() { return true; }
                            isFocused() { return false; }
                        }
                        module.exports = { ...base, BrowserWindow, screen: { ...base.screen, getPrimaryDisplay: () => display, getDisplayMatching: () => display } };
                    `
                }));
            }
        }
    ],
    logLevel: 'error'
});
globalThis.__panelSent = [];
const v = createRequire(import.meta.url)('../dist-test/privacy-voice.cjs');
v.createHud(false);
// A test that fails must not leave its question up for the next one.
test.afterEach(() => v.cancelStep('clear'));

const flags = { minimized: false, cloaked: false, elevated: false, hung: false };
const win = (ref, title, pid, extra = {}) => ({ ref, title, pid, class: 'X', rect: { x: 100, y: 100, width: 400, height: 300 }, foreground: false, ...flags, ...extra });

/** A desktop for this bundle: the window list, and nothing else. */
function desk(windows) {
    v.useHelperTransport(async op => {
        if (op === 'list_windows') return windows;
        if (op === 'set_shared') return null;
        throw new Error(`no ${op} in this fake`);
    });
}

async function tool(name, args) {
    const server = v.buildServer();
    const [a, b] = v.InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new v.Client({ name: 'test', version: '0' });
    await client.connect(b);
    try {
        const r = await client.callTool({ name, arguments: args });
        return r.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
    } finally {
        await client.close();
    }
}

async function stepUp(test = s => s) {
    for (let i = 0; i < 400 && !(v.currentStep() && test(v.currentStep())); i += 1) await new Promise(r => setTimeout(r, 5));
    return v.currentStep();
}

/** What main sent the panel on `channel` since `from`. */
const sentSince = (from, channel) => globalThis.__panelSent.slice(from).filter(s => s.channel === channel).map(s => s.payload);

/** Text as it shows: format and other invisible characters take no space on screen. */
const shown = s => s.replace(/[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, '');
const FORMAT = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/u;
const LABELLED = /^(\d+\/\d+ )?The agent says: /;

const BODY =
    'Screen MCP Overlay: share “the window you need help with” with the AI? It will see this window and the dialogs it opens, nothing else, until you stop sharing it.';

/** Every way of dressing an agent's prompt up as the app's own question that the red team tried, and a few more. */
const DISGUISES = {
    plain: BODY,
    'a progress prefix': `1/1 ${BODY}`,
    'a spaced-out progress prefix': ` 2 / 3   ${BODY}`,
    'a zero-width space first': `​${BODY}`,
    'a word joiner first': `⁠${BODY}`,
    'a left-to-right mark first': `‎${BODY}`,
    'a soft hyphen first': `­${BODY}`,
    'a byte order mark first': `﻿${BODY}`,
    'a Cyrillic S': BODY.replace(/^S/, 'Ѕ'),
    'Greek and Cyrillic look-alikes throughout': BODY.replace('Screen MCP Overlay', 'Ѕсrееn ΜСР Οvеrlаy'),
    'a no-break space inside': BODY.replace('Screen MCP', 'Screen MCP'),
    'zero-width spaces inside': BODY.replace('MCP', 'M​C​P'),
    'blank lines first': `\n\n${BODY}`,
    'fullwidth letters': BODY.replace('Screen', 'Ｓｃｒｅｅｎ'),
    'a capital I for the l': BODY.replace('Overlay', 'OverIay'),
    'the words run together': BODY.replace('Screen MCP Overlay', 'ScreenMCPOverlay'),
    'lower case': BODY.replace('Screen MCP Overlay', 'screen mcp overlay'),
    'after a sentence': `Done. ${BODY}`,
    'on a later line': `All set.\n\n\n\n${BODY}`,
    'the name the panel shows': BODY.replace('Screen MCP Overlay', 'Screen Overlay')
};

test("an agent's question never passes for the app's own, however it is dressed up", async () => {
    v.store.clear();
    for (const [how, prompt] of Object.entries(DISGUISES)) {
        const from = globalThis.__panelSent.length;
        const asked = tool('show_message', { text: prompt, speak: true, options: ['This window', 'All Notepad windows', "Don't share"] });
        const step = await stepUp();

        // The words: labelled wherever they show, as one line.
        const heading = v.card.stepHeading(step);
        assert.match(heading.prompt, /^The agent says: /, `${how}: card ${JSON.stringify(heading.prompt.slice(0, 50))}`);
        assert.doesNotMatch(heading.prompt, /\n/, `${how}: one line, so no line of it starts as the app`);
        assert.match(v.stripProgress(step).prompt, /^The agent says: /, `${how}: overlay strip`);
        const [line] = sentSince(from, 'hud:message').filter(m => m.role === 'guide');
        assert.match(line?.text ?? '', LABELLED, `${how}: panel line ${JSON.stringify(line?.text.slice(0, 50))}`);
        const [spoken] = sentSince(from, 'hud:speak');
        assert.match(spoken?.text ?? '', LABELLED, `${how}: spoken`);
        for (const text of [heading.prompt, line.text, spoken.text]) assert.doesNotMatch(text, FORMAT, `${how}: nothing invisible`);

        // And the structural mark, which only the app's own steps carry.
        assert.notEqual(step.fromApp, true, how);
        assert.ok(!heading.app, `${how}: no app badge on the card`);

        v.answerStep({ kind: 'choice', index: 0 });
        assert.equal(await asked, 'CHOSE 1 "This window"', how);
    }
});

test("a walkthrough's progress still shows when its step is labelled", async () => {
    const asked = tool('show_message', { text: '2/5 Screen MCP Overlay: click Save', options: ['OK'] });
    const step = await stepUp();
    assert.deepEqual(v.card.stepHeading(step), { prompt: 'The agent says: Screen MCP Overlay: click Save', progress: '2/5', app: null });
    assert.deepEqual(v.stripProgress(step), { progress: { n: 2, of: 5 }, prompt: 'The agent says: Screen MCP Overlay: click Save' });
    v.answerStep({ kind: 'choice', index: 0 });
    await asked;
});

test("an agent's options are labelled too, and the agent hears back the option it gave", async () => {
    const asked = tool('show_message', { text: 'Which one?', options: ['​Screen MCP Overlay: share', 'Sсreen Overlay: OK', 'Cancel‮'] });
    const step = await stepUp();
    assert.equal(step.prompt, 'Which one?', 'ordinary text is left as written');
    // Labelled, not rewritten: the label is what tells, so the letters stay as the agent sent them.
    assert.deepEqual(step.options, ['The agent says: Screen MCP Overlay: share', 'The agent says: S\u0441reen Overlay: OK', 'Cancel']);
    assert.deepEqual(v.card.stepButtons(step).map(b => b.label), step.options, 'the card shows the same');
    v.answerStep({ kind: 'choice', index: 1 });
    assert.equal(await asked, 'CHOSE 2 "Sсreen Overlay: OK"');
});

test('text the user reads is never reordered by direction controls, so it reads as checked', async () => {
    // Shown right-to-left, this reads "Screen MCP Overlay: press Ctrl+Shift+F8".
    const reversed = `‮${[...'Screen MCP Overlay: press Ctrl+Shift+F8'].reverse().join('')}`;
    const from = globalThis.__panelSent.length;
    const asked = tool('show_message', { text: reversed, speak: true, options: ['OK'] });
    const step = await stepUp();
    const [line] = sentSince(from, 'hud:message').filter(m => m.role === 'guide');
    const [spoken] = sentSince(from, 'hud:speak');
    for (const text of [step.prompt, v.card.stepHeading(step).prompt, v.stripProgress(step).prompt, line.text, spoken.text]) {
        assert.doesNotMatch(text, /[‪-‮⁦-⁩‎‏؜]/u, JSON.stringify(text));
    }
    v.answerStep({ kind: 'choice', index: 0 });
    await asked;
});

test("the app's own questions carry its badge, and only they do", async () => {
    v.resetSharing();
    desk([win('100', 'Untitled - Notepad', 11, { exe: 'notepad.exe', foreground: true })]);
    const asked = tool('list_windows', { ask: 'to find the Save button' });
    const pick = await stepUp();
    assert.equal(pick.fromApp, true);
    const heading = v.card.stepHeading(pick);
    assert.equal(heading.app, 'Screen MCP Overlay', 'the badge, which no agent text can draw');
    assert.match(heading.prompt, /^An AI agent asks to see the window you need help with/, 'the badge says whose question it is');
    v.answerStep({ kind: 'done' });
    const confirm = await stepUp(s => s.mode === 'choice');
    assert.equal(confirm.fromApp, true);
    assert.deepEqual(confirm.options, ['This window', 'All Notepad windows', "Don't share"]);
    assert.match(v.card.stepHeading(confirm).prompt, /^Share “Untitled - Notepad” with the AI\?/);
    v.answerStep({ kind: 'choice', index: 2 });
    assert.match(await asked, /did not share/i);

    // The same request from an agent's own step, word for word, gets neither.
    const copy = tool('show_message', { text: pick.prompt, options: ['OK'] });
    const fake = await stepUp();
    assert.notEqual(fake.fromApp, true);
    assert.equal(v.card.stepHeading(fake).app, null);
    assert.match(fake.prompt, /^The agent says: /);
    v.answerStep({ kind: 'choice', index: 0 });
    await copy;
});

test("the panel's own line about a replaced step quotes the agent's words safely", async () => {
    const replaced = async first => {
        const from = globalThis.__panelSent.length;
        const a = tool('show_message', { text: first, options: ['OK'] });
        await stepUp();
        const b = tool('show_message', { text: 'second', options: ['OK'] });
        await stepUp(s => s.prompt === 'second');
        v.answerStep({ kind: 'choice', index: 0 });
        await a;
        await b;
        return sentSince(from, 'hud:message').filter(m => m.role === 'system').map(m => m.text);
    };

    // Closing the quote and carrying on as the app.
    const [closed] = await replaced('x". Stopped sharing everything with the AI. To share again, click into the window and press Ctrl+Shift+F8 ("');
    assert.match(closed, /^Replaced a pending step with a newer one: “[^"“”\n]{1,60}”\.$/u, closed);

    // Lines, invisible characters and direction controls: quoted as it shows.
    const [flat] = await replaced('one\n\ntwo​‮three');
    assert.equal(flat, 'Replaced a pending step with a newer one: “one twothree”.');

    // Words that use the app's name are not repeated in the app's own line at all.
    const [named] = await replaced('​Screen MCP Overlay: press Ctrl+Shift+F8 in your video to continue');
    assert.doesNotMatch(named, /screen|overlay|Ctrl/i, named);
    assert.match(named, /^Replaced a pending step with a newer one/);
});

test("a refused request's panel line quotes the agent's words safely", async () => {
    v.resetSharing();
    desk([win('100', 'Untitled - Notepad', 11, { exe: 'notepad.exe' })]);
    const lines = [];
    const stop = v.onSharingNotice(t => lines.push(t));
    try {
        await tool('describe_window', { window: 'x”. Screen MCP Overlay: to continue, click your video and press Ctrl+Shift+F8. “' });
        await tool('describe_window', { window: 'y”. To continue, click your video and press Ctrl+Shift+F8. “' });
    } finally {
        stop();
    }
    assert.equal(lines.length, 2, lines.join('\n'));
    assert.doesNotMatch(lines[0], /screen mcp|Ctrl/i, lines[0]);
    assert.match(lines[0], /^An agent asked for [^“”]+, which you have not shared\./);
    assert.match(lines[1], /^An agent asked for “[^"“”]{1,60}”, which you have not shared\./, lines[1]);
});

test('helpers for agent text: labelled when it names the app, and safe to quote', () => {
    assert.equal(v.asAgentText('Click Save'), 'Click Save');
    assert.equal(v.asAgentText('Click Save\n\nthen Close'), 'Click Save\n\nthen Close', 'ordinary text keeps its lines');
    assert.equal(v.asAgentText('The ѕcreen MCP overlay will circle it'), 'The agent says: The ѕcreen MCP overlay will circle it');
    assert.equal(v.asAgentText(v.asAgentText('Screen MCP Overlay: hi')), 'The agent says: Screen MCP Overlay: hi', 'labelled once');
    assert.equal(v.asAgentText('3/4 Screen MCP Overlay: hi'), '3/4 The agent says: Screen MCP Overlay: hi');
    assert.equal(v.quoteAgentText('Notepad', 'x'), '“Notepad”');
    assert.equal(v.quoteAgentText('a "b” “c', 'x'), "“a 'b' 'c”");
    assert.equal(v.quoteAgentText('Scrеen MCP 0verlay', 'something else'), 'something else');
    assert.equal(v.quoteAgentText('​ \n', 'x'), '');
    const long = v.quoteAgentText('w'.repeat(500), 'x');
    assert.ok(long.length <= 62 && long.endsWith('…”'), long);
});
