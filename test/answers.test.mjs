import test from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './support/fake-helper.mjs';

const { answerText, store } = harness;

test('every user outcome leads with a status word and none is an error', () => {
    const cases = [
        [{ kind: 'done' }, /^DONE after 4s/],
        [{ kind: 'stuck', text: 'no such menu' }, /^STUCK after 4s: .*"no such menu"/],
        [{ kind: 'skip' }, /^SKIPPED/],
        [{ kind: 'reply', text: 'it says Error 5' }, /^REPLIED after 4s: "it says Error 5"/],
        [{ kind: 'choice', index: 1, label: 'JPEG' }, /^CHOSE 2 "JPEG"/],
        [{ kind: 'timeout', partial: [] }, /^NO RESPONSE in 4s/],
        [{ kind: 'cancelled', by: 'esc', partial: [{}, {}] }, /^CANCELLED: the user pressed Escape.* PARTIAL: 2 click/],
        [{ kind: 'cancelled', by: 'client', partial: [] }, /^CANCELLED: the request was cancelled/],
        [{ kind: 'cancelled', by: 'superseded', partial: [] }, /^CANCELLED: a newer step/]
    ];
    for (const [answer, re] of cases) assert.match(answerText(answer, 4000), re);
    assert.equal(answerText({ kind: 'ended' }, 0), null);
    assert.equal(answerText({ kind: 'clicks', clicks: [], complete: true }, 0), null);
});

test('stale marking fades only drawings without an expiry', () => {
    store.clear();
    const base = { displayId: '1', type: 'box', rect: { x: 0, y: 0, width: 1, height: 1 }, createdAt: 0 };
    store.add([{ ...base, id: 'a' }, { ...base, id: 'b', expiresAt: Date.now() + 60_000 }]);
    assert.equal(store.markStale(true), 1);
    assert.equal(store.list().find(a => a.id === 'a').stale, true);
    assert.equal(store.markStale(false), 1);
    store.clear();
});

test('tracking records when a target went missing, and retires long-gone ones', () => {
    store.clear();
    const r = { x: 0, y: 0, width: 1, height: 1 };
    store.add([{ id: 'h', displayId: '1', type: 'box', rect: r, createdAt: 0 }]);
    store.applyTracking([{ id: 'h', displayId: '1', rect: r, hidden: true }]);
    assert.ok(store.list()[0].hiddenSince > 0);
    assert.equal(store.retireHidden(60_000), 0, 'not gone long enough');
    store.list()[0].hiddenSince = Date.now() - 120_000;
    assert.equal(store.retireHidden(60_000), 1);
});
