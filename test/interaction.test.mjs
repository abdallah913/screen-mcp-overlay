import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

/*
 * The user's side of a step: the global keys that answer it, the panel's card
 * and reply box, the panel dodging drawings, and fading what an idle agent left
 * behind. These modules live in the Electron main process and the panel, so
 * this file bundles them itself against the same Electron stub the tool tests
 * use, with its own store instance.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outfile = join(root, 'dist-test', 'interaction.cjs');

await build({
    stdin: {
        contents: `
            export { bindStepKeys, keyLabel, onStepEnded, beginStep, answerStep, cancelStep, addClick, currentStep } from './src/main/steps.ts';
            export { dodgePlacement, outcomeLabel, panelAnswer, capReply, targetWindowRef, replyToStep, pointerNear, REPLY_LIMIT } from './src/main/hud.ts';
            export { shouldFade, idleTick, noteRequest, IDLE_MS } from './src/main/idle.ts';
            export { normalizeSettings } from './src/main/settings.ts';
            export { startMcpServer, mcpActiveRequests } from './src/main/mcp/server.ts';
            export { sendPrompt } from './src/main/agent/host.ts';
            export { store } from './src/main/store.ts';
            export * as card from './src/renderer/hud/step.ts';
        `,
        resolveDir: root,
        loader: 'ts'
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    outfile,
    alias: { electron: join(root, 'test/support/electron-stub.cjs') },
    external: ['@anthropic-ai/claude-agent-sdk'],
    logLevel: 'error'
});

const m = createRequire(import.meta.url)(outfile);
const { store, card } = m;

test.afterEach(() => {
    m.cancelStep('clear');
    store.clear();
});

/** A stand-in for Electron's globalShortcut that can be told which chords are taken. */
function fakeShortcuts(taken = []) {
    const held = new Map();
    return {
        held,
        register(accel, cb) {
            if (taken.includes(accel)) return false;
            if (accel === 'Bogus+') throw new Error('conversion failure');
            held.set(accel, cb);
            return true;
        },
        unregister(accel) {
            held.delete(accel);
        },
        isRegistered(accel) {
            return held.has(accel);
        }
    };
}

const chords = { done: 'Control+Shift+F9', stuck: 'Control+Shift+F10' };

// ------------------------------------------------------------- step keys

test('step keys are held only while a step is pending, and answer it', async () => {
    const api = fakeShortcuts();
    const unbind = m.bindStepKeys(api, () => chords);
    try {
        assert.equal(api.held.size, 0, 'nothing held between steps');
        const step = m.beginStep({ prompt: 'Open File', mode: 'watch', timeoutMs: 5000 });
        assert.deepEqual([...api.held.keys()].sort(), ['Control+Shift+F10', 'Control+Shift+F9']);
        assert.deepEqual(m.currentStep().keys, { done: 'Ctrl+Shift+F9', stuck: 'Ctrl+Shift+F10' });
        assert.equal(api.held.has('Escape'), false, 'Escape stays with the app in watch mode');

        api.held.get('Control+Shift+F9')();
        assert.deepEqual(await step.answer, { kind: 'done' });
        assert.equal(api.held.size, 0, 'released when the step ends');
    } finally {
        unbind();
    }
});

test('only chords that registered are published, and Escape only in click mode', async () => {
    const api = fakeShortcuts(['Control+Shift+F9']);
    const unbind = m.bindStepKeys(api, () => ({ done: 'Control+Shift+F9', stuck: 'Bogus+' }));
    try {
        const step = m.beginStep({ prompt: 'Point at it', mode: 'click', timeoutMs: 5000 });
        assert.deepEqual(m.currentStep().keys, { cancel: 'Esc' }, 'a taken chord and a bad one are not offered');
        api.held.get('Escape')();
        const a = await step.answer;
        assert.deepEqual([a.kind, a.by], ['cancelled', 'esc']);
    } finally {
        unbind();
    }
});

test('a choice is answered by its options, not by done/stuck keys', () => {
    const api = fakeShortcuts();
    const unbind = m.bindStepKeys(api, () => chords);
    try {
        m.beginStep({ prompt: 'Which?', mode: 'choice', options: ['A', 'B'], timeoutMs: 5000 });
        assert.equal(api.held.size, 0);
        assert.deepEqual(m.currentStep().keys, {});
    } finally {
        unbind();
    }
});

test('a step key never takes over a chord the app already holds', () => {
    const api = fakeShortcuts();
    api.held.set('Control+Shift+X', () => {});
    const unbind = m.bindStepKeys(api, () => ({ done: 'Control+Shift+X', stuck: '' }));
    try {
        m.beginStep({ prompt: 'p', mode: 'watch', timeoutMs: 5000 });
        assert.deepEqual(m.currentStep().keys, {});
        m.cancelStep('clear');
        assert.equal(api.held.has('Control+Shift+X'), true, 'the panic button survives the step');
    } finally {
        unbind();
    }
});

test('a superseding step re-binds the keys to the new step', async () => {
    const api = fakeShortcuts();
    const unbind = m.bindStepKeys(api, () => chords);
    try {
        m.beginStep({ prompt: 'first', mode: 'watch', timeoutMs: 5000 });
        const second = m.beginStep({ prompt: 'second', mode: 'watch', timeoutMs: 5000 });
        api.held.get('Control+Shift+F10')();
        assert.equal((await second.answer).kind, 'stuck');
    } finally {
        unbind();
    }
});

test('a click step is answered by pointing or Escape, not by done/stuck keys', () => {
    const api = fakeShortcuts();
    const unbind = m.bindStepKeys(api, () => chords);
    try {
        m.beginStep({ prompt: 'Point at it', mode: 'click', timeoutMs: 5000 });
        assert.deepEqual([...api.held.keys()], ['Escape']);
        assert.deepEqual(m.currentStep().keys, { cancel: 'Esc' });
    } finally {
        unbind();
    }
});

test('a chord that is not a string disables that key instead of breaking the step', async () => {
    const api = fakeShortcuts();
    const unbind = m.bindStepKeys(api, () => ({ done: null, stuck: 'Control+Shift+F10' }));
    try {
        const step = m.beginStep({ prompt: 'Open File', mode: 'watch', timeoutMs: 5000 });
        assert.deepEqual(m.currentStep().keys, { stuck: 'Ctrl+Shift+F10' });
        api.held.get('Control+Shift+F10')();
        assert.equal((await step.answer).kind, 'stuck');
    } finally {
        unbind();
    }
});

test('a step listener that throws cannot break a step or keep its answer from the agent', async () => {
    const boom = () => {
        throw new Error('tray exploded');
    };
    store.on('step', boom);
    const heard = [];
    const off = m.onStepEnded((_view, answer) => heard.push(answer.kind));
    try {
        const step = m.beginStep({ prompt: 'Which?', mode: 'choice', options: ['A', 'B'], timeoutMs: 5000 });
        assert.equal(m.answerStep({ kind: 'choice', index: 1 }), true);
        assert.deepEqual(await step.answer, { kind: 'choice', index: 1, label: 'B' });
        assert.deepEqual(heard, ['choice']);
        assert.equal(m.currentStep(), null);
    } finally {
        store.off('step', boom);
        off();
    }
});

test('settings of the wrong type fall back instead of reaching code that trusts them', () => {
    const s = m.normalizeSettings({
        stepKeys: { done: null, stuck: 42 },
        readStepsAloud: 'yes',
        soundCues: true,
        speechRate: 9,
        token: 7
    });
    assert.deepEqual(s.stepKeys, { done: '', stuck: 'Control+Shift+F10' }, 'null switches a key off');
    assert.equal(s.readStepsAloud, false);
    assert.equal(s.soundCues, true);
    assert.equal(s.speechRate, 2);
    assert.equal(s.token, '');
    assert.deepEqual(m.normalizeSettings({ stepKeys: { stuck: '' } }).stepKeys, {
        done: 'Control+Shift+F9',
        stuck: ''
    });
    assert.deepEqual(m.normalizeSettings('garbage').stepKeys, { done: 'Control+Shift+F9', stuck: 'Control+Shift+F10' });
});

test('accelerators read the way Windows users write them', () => {
    assert.equal(m.keyLabel('Control+Shift+F9'), 'Ctrl+Shift+F9');
    assert.equal(m.keyLabel('CommandOrControl+Alt+k'), 'Ctrl+Alt+K');
    assert.equal(m.keyLabel('Escape'), 'Esc');
});

// --------------------------------------------------------- how steps end

test('step-ended listeners hear the answer with the step it answered', async () => {
    const heard = [];
    const off = m.onStepEnded((view, answer) => heard.push([view.prompt, answer.kind, answer.by]));
    try {
        m.beginStep({ prompt: 'old', mode: 'watch', timeoutMs: 5000 });
        m.beginStep({ prompt: 'new', mode: 'watch', timeoutMs: 5000 });
        m.cancelStep('clear');
    } finally {
        off();
    }
    assert.deepEqual(heard, [
        ['old', 'cancelled', 'superseded'],
        ['new', 'cancelled', 'clear']
    ]);
});

test('outcome labels name what happened in a word or two', () => {
    const view = { count: 3 };
    assert.equal(m.outcomeLabel(view, { kind: 'clicks', clicks: [1, 2], complete: false }), '2 of 3 clicks');
    assert.equal(m.outcomeLabel({ count: 1 }, { kind: 'clicks', clicks: [1], complete: true }), 'Clicked');
    assert.equal(m.outcomeLabel(view, { kind: 'choice', index: 0, label: 'PNG' }), 'Chose "PNG"');
    assert.equal(m.outcomeLabel(view, { kind: 'cancelled', by: 'superseded', partial: [] }), 'Replaced');
    assert.equal(m.outcomeLabel(view, { kind: 'stuck' }), "Couldn't find it");
});

// ------------------------------------------------------- the panel's reply

test('typing in the panel while a step is pending answers the step', async () => {
    const step = m.beginStep({ prompt: 'Open File', mode: 'watch', timeoutMs: 5000 });
    // The built-in agent's send path: it must not start a second conversation.
    await m.sendPrompt('  there is no File menu, only a hamburger  ');
    assert.deepEqual(await step.answer, { kind: 'reply', text: 'there is no File menu, only a hamburger' });
});

test('a reply is capped so a paste cannot flood the agent', async () => {
    const step = m.beginStep({ prompt: 'p', mode: 'watch', timeoutMs: 5000 });
    assert.equal(m.replyToStep('x'.repeat(5000), step.id), true);
    const a = await step.answer;
    assert.equal(a.text.length, m.REPLY_LIMIT);
    assert.ok(a.text.endsWith('…'));
});

test('a reply aimed at an older step does not answer the new one', () => {
    const first = m.beginStep({ prompt: 'a', mode: 'watch', timeoutMs: 5000 });
    m.beginStep({ prompt: 'b', mode: 'watch', timeoutMs: 5000 });
    assert.equal(m.replyToStep('hello', first.id), false);
    assert.equal(m.currentStep().prompt, 'b');
});

test('answers from the panel are validated before they reach the step', () => {
    assert.deepEqual(m.panelAnswer({ kind: 'done', extra: 1 }), { kind: 'done' });
    assert.deepEqual(m.panelAnswer({ kind: 'choice', index: 2 }), { kind: 'choice', index: 2 });
    assert.equal(m.panelAnswer({ kind: 'choice', index: '2' }), null);
    assert.equal(m.panelAnswer({ kind: 'reply', text: '   ' }), null);
    assert.equal(m.panelAnswer({ kind: 'explode' }), null);
    assert.equal(m.panelAnswer(null), null);
    assert.deepEqual(m.panelAnswer({ kind: 'stuck', text: 42 }), { kind: 'stuck' });
    assert.deepEqual(m.panelAnswer({ kind: 'cancel' }), { kind: 'cancel' });
});

test('the card sends what was typed only where it was meant to go', () => {
    const s1 = view({ id: 'step_1' });
    const idle = { busy: false, mirroring: false };
    assert.equal(card.heldReplyNote('step_1', s1, idle), null, 'same step: send it');
    assert.equal(card.heldReplyNote(null, null, idle), null, 'no step before or after: a message');
    assert.match(card.heldReplyNote('step_1', null, idle), /ended.*new message/);
    assert.match(card.heldReplyNote('step_1', null, { busy: true, mirroring: false }), /still working/);
    assert.match(card.heldReplyNote('step_1', null, { busy: false, mirroring: true }), /type it there/);
    assert.match(card.heldReplyNote('step_1', view({ id: 'step_2' }), idle), /replaced.*new step/);
    assert.match(card.heldReplyNote(null, s1, idle), /started a step/);
});

test("a step's window comes from its drawing's anchor", () => {
    const anns = [
        { id: 'ann_1', anchor: { kind: 'element', ref: 'el_5', selector: { window: '100' } } },
        { id: 'ann_2', anchor: { kind: 'window', ref: '200' } },
        { id: 'ann_3' }
    ];
    assert.equal(m.targetWindowRef(['ann_1'], anns), '100');
    assert.equal(m.targetWindowRef(['ann_2'], anns), '200');
    assert.equal(m.targetWindowRef(['ann_3'], anns), undefined);
});

// ------------------------------------------------------------ step card

const view = over => ({
    id: 'step_1',
    prompt: '2/5 Click Export',
    mode: 'watch',
    count: 0,
    collected: 0,
    startedAt: 0,
    deadline: 78_000,
    targetIds: [],
    keys: {},
    ...over
});

test('the card offers the answers that fit the mode', () => {
    assert.deepEqual(
        card.stepButtons(view()).map(b => [b.label, b.answer.kind]),
        [
            ['Done', 'done'],
            ["Can't find it", 'stuck'],
            ['Skip', 'skip']
        ]
    );
    // Cancel ends a click step like Escape (keeping placed points), not as a skip.
    assert.deepEqual(
        card.stepButtons(view({ mode: 'click', count: 1 })).map(b => [b.label, b.answer.kind]),
        [['Cancel', 'cancel']]
    );
    const choice = view({ mode: 'choice', options: ['PNG', 'JPEG'] });
    assert.deepEqual(
        card.stepButtons(choice).map(b => [b.label, b.key, b.answer.index]),
        [
            ['PNG', '1', 0],
            ['JPEG', '2', 1]
        ]
    );
});

test('number keys pick only options that exist', () => {
    const choice = view({ mode: 'choice', options: ['PNG', 'JPEG'] });
    assert.equal(card.choiceForKey(choice, '2'), 1);
    assert.equal(card.choiceForKey(choice, '3'), null);
    assert.equal(card.choiceForKey(choice, 'a'), null);
    assert.equal(card.choiceForKey(view(), '1'), null, 'not outside a choice');
});

test('the card shows progress apart from the prompt, and the time left', () => {
    assert.deepEqual(card.stepHeading(view()), { prompt: 'Click Export', progress: '2/5' });
    assert.deepEqual(card.stepHeading(view({ prompt: 'Open it', progress: { n: 1, of: 3 } })), {
        prompt: 'Open it',
        progress: '1/3'
    });
    assert.deepEqual(card.stepHeading(view({ prompt: 'Open it' })), { prompt: 'Open it', progress: null });
    assert.equal(card.timeLeft(78_000, 0), '1:18 left');
    assert.equal(card.timeLeft(0, 5000), '0:00 left');
    assert.equal(card.clickProgress(view({ mode: 'click', count: 3, collected: 1 })), '1 of 3 points');
    assert.equal(card.clickProgress(view({ mode: 'click', count: 1 })), null);
});

test('the key hint lists only keys that work', () => {
    assert.equal(card.keysHint(view()), null);
    assert.equal(
        card.keysHint(view({ keys: { done: 'Ctrl+Shift+F9', cancel: 'Esc' } })),
        "From any app: Ctrl+Shift+F9 done · Esc cancel"
    );
    assert.equal(card.sameText(' Click  Export\n', 'Click Export'), true);
});

// ------------------------------------------------------ panel dodging

const area = { x: 0, y: 0, width: 1920, height: 1040 };
const home = { x: 1476, y: 436, width: 420, height: 580 };

test('the panel stays home while nothing is drawn under it', () => {
    assert.deepEqual(m.dodgePlacement(home, area, [{ x: 100, y: 100, width: 50, height: 20 }]), {
        bounds: home,
        collapsed: false
    });
});

test('a drawing under the panel moves it to the nearest clear corner', () => {
    const okButton = { x: 1700, y: 980, width: 80, height: 24 };
    const r = m.dodgePlacement(home, area, [okButton]);
    assert.equal(r.collapsed, false);
    assert.deepEqual(r.bounds, { x: 1476, y: 24, width: 420, height: 580 }, 'up the same side is the shortest move');
    const tall = { x: 1460, y: 0, width: 40, height: 1040 };
    assert.deepEqual(m.dodgePlacement(home, area, [tall]).bounds, { x: 24, y: 436, width: 420, height: 580 });
});

test('a drawing just outside the panel still counts: strokes and captions spill', () => {
    const r = m.dodgePlacement(home, area, [{ x: 1460, y: 500, width: 10, height: 10 }]);
    assert.notDeepEqual(r.bounds, home);
});

test('with every corner taken the panel collapses to a pill on its own side', () => {
    const corners = [
        { x: 1800, y: 1000, width: 10, height: 10 },
        { x: 100, y: 1000, width: 10, height: 10 },
        { x: 1800, y: 100, width: 10, height: 10 },
        { x: 100, y: 100, width: 10, height: 10 }
    ];
    const r = m.dodgePlacement(home, area, corners);
    assert.equal(r.collapsed, true);
    assert.equal(r.bounds.x + r.bounds.width, home.x + home.width);
    assert.equal(r.bounds.y + r.bounds.height, home.y + home.height);
});

test('the pointer on or next to the panel holds it still', () => {
    assert.equal(m.pointerNear(home, { x: home.x + 10, y: home.y + 10 }), true);
    assert.equal(m.pointerNear(home, { x: home.x - 20, y: home.y + 10 }), true, 'reaching for an edge');
    assert.equal(m.pointerNear(home, { x: home.x - 60, y: home.y + 10 }), false);
    assert.equal(m.pointerNear(home, { x: 10, y: 10 }), false);
});

// --------------------------------------------------------- idle clients

test('a client parked on GET /mcp is turned away and does not count as busy', async () => {
    const server = await m.startMcpServer(0);
    try {
        const status = await new Promise((resolve, reject) => {
            const req = request(`${server.url}`, { method: 'GET', headers: { accept: 'text/event-stream' } }, res => {
                res.resume();
                resolve(res.statusCode);
            });
            req.on('error', reject);
            req.end();
        });
        assert.equal(status, 405, 'the SDK client reads 405 as "no standalone stream"');
        assert.equal(m.mcpActiveRequests(), 0);
    } finally {
        await server.close();
    }
});

test('fading waits for real silence', () => {
    const base = { quietMs: m.IDLE_MS, stepPending: false, activeRequests: 0, faded: false };
    assert.equal(m.shouldFade(base), true);
    assert.equal(m.shouldFade({ ...base, quietMs: m.IDLE_MS - 1 }), false);
    assert.equal(m.shouldFade({ ...base, stepPending: true }), false, 'the agent is waiting on the user');
    assert.equal(m.shouldFade({ ...base, activeRequests: 1 }), false, 'a long wait is still activity');
    assert.equal(m.shouldFade({ ...base, faded: true }), false, 'once');
});

test('an idle client’s drawings fade, and the next request brings them back', t => {
    t.mock.timers.enable({ apis: ['Date'], now: 0 });
    m.noteRequest();
    store.add([
        { id: 'a1', displayId: '1', type: 'circle', rect: { x: 0, y: 0, width: 10, height: 10 }, createdAt: 0 },
        { id: 'a2', displayId: '1', type: 'label', rect: { x: 0, y: 0, width: 10, height: 10 }, createdAt: 0, expiresAt: 10 ** 12 }
    ]);
    m.idleTick(() => 0);
    assert.equal(store.list().find(a => a.id === 'a1').stale, undefined, 'not yet');

    t.mock.timers.tick(m.IDLE_MS);
    m.idleTick(() => 0);
    assert.equal(store.list().find(a => a.id === 'a1').stale, true);
    assert.equal(store.list().find(a => a.id === 'a2').stale, undefined, 'a drawing with its own expiry is left alone');

    m.noteRequest();
    assert.equal(store.list().find(a => a.id === 'a1').stale, undefined);
});

test('a drawing whose target has been gone ten minutes is retired', t => {
    t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
    m.noteRequest();
    store.add([{ id: 'h1', displayId: '1', type: 'circle', rect: { x: 0, y: 0, width: 1, height: 1 }, createdAt: 0 }]);
    store.applyTracking([{ id: 'h1', displayId: '1', rect: { x: 0, y: 0, width: 1, height: 1 }, hidden: true }]);
    t.mock.timers.tick(10 * 60 * 1000 + 1);
    m.idleTick(() => 1);
    assert.equal(store.list().length, 0);
});
