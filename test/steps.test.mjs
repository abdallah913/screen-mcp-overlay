import test from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './support/fake-helper.mjs';

/*
 * The pending-step core (src/main/steps.ts): one step at a time, and every way
 * it can end resolves -- never rejects -- with a kind the agent can act on.
 */

const { beginStep, answerStep, addClick, cancelStep, currentStep, store } = harness;

const click = (x, y) => ({ displayId: '1', physical: { x, y }, dip: { x, y }, normalized: { x: 0, y: 0 } });

test.afterEach(() => cancelStep('clear'));

test('a click step resolves once enough clicks are in', async () => {
    const step = beginStep({ prompt: 'p', mode: 'click', count: 2, timeoutMs: 5000 });
    assert.equal(currentStep().collected, 0);
    addClick(click(1, 1));
    assert.equal(currentStep().collected, 1, 'progress is published');
    addClick(click(2, 2));
    const a = await step.answer;
    assert.equal(a.kind, 'clicks');
    assert.equal(a.complete, true);
    assert.equal(a.clicks.length, 2);
    assert.equal(currentStep(), null);
});

test('Escape keeps the clicks already collected', async () => {
    const step = beginStep({ prompt: 'p', mode: 'click', count: 3, timeoutMs: 5000 });
    addClick(click(1, 1));
    cancelStep('esc');
    const a = await step.answer;
    assert.deepEqual([a.kind, a.by, a.partial.length], ['cancelled', 'esc', 1]);
});

test('a timeout is an answer, not a rejection', async () => {
    // The step's timer is unref'd (Electron keeps the process alive); under
    // plain Node something must hold the event loop open while it runs.
    const keepAlive = setTimeout(() => {}, 1000);
    const step = beginStep({ prompt: 'p', mode: 'watch', timeoutMs: 20 });
    const a = await step.answer;
    clearTimeout(keepAlive);
    assert.equal(a.kind, 'timeout');
});

test('a new step supersedes the pending one', async () => {
    const first = beginStep({ prompt: 'a', mode: 'watch', timeoutMs: 5000 });
    const second = beginStep({ prompt: 'b', mode: 'watch', timeoutMs: 5000 });
    const a = await first.answer;
    assert.deepEqual([a.kind, a.by], ['cancelled', 'superseded']);
    assert.equal(currentStep().id, second.id);
});

test('the client aborting ends the step', async () => {
    const ac = new AbortController();
    const step = beginStep({ prompt: 'p', mode: 'watch', timeoutMs: 5000, signal: ac.signal });
    ac.abort();
    const a = await step.answer;
    assert.deepEqual([a.kind, a.by], ['cancelled', 'client']);
    assert.equal(currentStep(), null);
});

test('an already-aborted signal never leaves a step pending', async () => {
    const ac = new AbortController();
    ac.abort();
    const step = beginStep({ prompt: 'p', mode: 'watch', timeoutMs: 5000, signal: ac.signal });
    assert.equal((await step.answer).kind, 'cancelled');
    assert.equal(currentStep(), null);
});

test('user answers map to step answers, choices carry their label', async () => {
    const step = beginStep({ prompt: 'which?', mode: 'choice', options: ['PNG', 'JPEG'], timeoutMs: 5000 });
    assert.equal(answerStep({ kind: 'choice', index: 5 }), false, 'out of range is ignored');
    assert.equal(answerStep({ kind: 'choice', index: 1 }), true);
    assert.deepEqual(await step.answer, { kind: 'choice', index: 1, label: 'JPEG' });
});

test('an answer for an older step id is ignored', async () => {
    const step = beginStep({ prompt: 'p', mode: 'watch', timeoutMs: 5000 });
    assert.equal(answerStep({ kind: 'done' }, 'step_nope'), false);
    assert.equal(answerStep({ kind: 'stuck', text: '  cannot see it ' }, step.id), true);
    assert.deepEqual(await step.answer, { kind: 'stuck', text: 'cannot see it' });
});

test('an empty reply is not an answer', () => {
    beginStep({ prompt: 'p', mode: 'watch', timeoutMs: 5000 });
    assert.equal(answerStep({ kind: 'reply', text: '   ' }), false);
    assert.notEqual(currentStep(), null);
});

test('the tool ending a step resolves it as ended and clears it', async () => {
    const step = beginStep({ prompt: 'p', mode: 'watch', timeoutMs: 5000 });
    step.end();
    step.end();
    assert.deepEqual(await step.answer, { kind: 'ended' });
    assert.equal(store.getStep(), null);
});

test('clicks are ignored outside click mode', () => {
    beginStep({ prompt: 'p', mode: 'watch', timeoutMs: 5000 });
    assert.equal(addClick(click(1, 1)), false);
});
