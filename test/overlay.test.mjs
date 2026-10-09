import test from 'node:test';
import assert from 'node:assert/strict';
import { call, fakeHelper, harness } from './support/fake-helper.mjs';
import { waitingNote } from '../dist-test/layout.js';

/*
 * What the overlay is told about drawings made through the real tools. The
 * layout tests feed the strip hand-made anchors; these check that what
 * annotate actually stores names things the way the user sees them.
 */

const { store } = harness;

test.beforeEach(() => store.clear());

/** The strip's note once the one drawing on screen has lost its target. */
function noteWhenHidden(hiddenReason) {
    const [a] = store.list();
    return waitingNote({ targetIds: [a.id] }, [{ ...a, hidden: true, hiddenReason }]);
}

test('a drawing by name tells the strip which app and which control it waits for', async () => {
    fakeHelper();
    const { isError, text } = await call('annotate', { anchor: { window: 'Notepad', name: 'Save' }, shapes: [{ type: 'circle' }] });
    assert.equal(isError, false, text);
    const { anchor } = store.list()[0];
    assert.deepEqual([anchor.label, anchor.app], ['Save', 'Untitled - Notepad']);
    assert.equal(noteWhenHidden('minimized'), 'Waiting for “Untitled - Notepad” to come back: it was minimised. Restore it to carry on.');
    assert.equal(noteWhenHidden('gone'), 'Waiting for “Save” to come back: it is no longer on screen.');
});

test('a drawing by ref or by window never shows the user a ref', async () => {
    fakeHelper();
    // The search records an automationId selector, which carries no name.
    await call('find_ui_elements', { window: 'Notepad', name: 'Save' });
    await call('annotate', { anchor: { ref: 'el_1' }, shapes: [{ type: 'box' }] });
    assert.equal(store.list()[0].anchor.label, 'Save', 'the control is named, not "el_1"');
    assert.match(noteWhenHidden('closed'), /^Waiting for “Untitled - Notepad” to come back: it was closed/);

    store.clear();
    await call('annotate', { anchor: { window: 'Calculator' }, shapes: [{ type: 'box' }] });
    const { anchor } = store.list()[0];
    assert.deepEqual([anchor.ref, anchor.label, anchor.app], ['200', 'Calculator', 'Calculator']);
    assert.match(noteWhenHidden('minimized'), /^Waiting for “Calculator”/);
});
