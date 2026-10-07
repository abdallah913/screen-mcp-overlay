import test from 'node:test';
import assert from 'node:assert/strict';

import { structuralKeys, displayDepths, diffLines, toSnapshotNodes, clean } from '../dist-test/uitree.js';

const R = { x: 0, y: 0, width: 10, height: 10 };
const n = (depth, role, name, extra = {}) => ({
    depth,
    role,
    name,
    ref: `el_${Math.random()}`,
    enabled: true,
    rect: R,
    ...extra
});

/**
 * A window whose title carries document state, which is the case that broke the
 * first implementation: Notepad renames its root on every edit.
 */
const tree = title => [
    n(0, 'window', title),
    n(1, 'document', 'Text editor', { value: 'abc' }),
    n(2, 'text', 'abc'),
    n(1, 'toolbar', 'Menu'),
    n(2, 'menuitem', 'File'),
    n(2, 'menuitem', 'Edit')
];

test('identical trees produce identical keys', () => {
    assert.deepEqual(structuralKeys(tree('Untitled')), structuralKeys(tree('Untitled')));
});

test('renaming the root does not re-key its descendants', () => {
    // The whole point: ancestor names are excluded from the path, so a title
    // change costs one row rather than the entire subtree.
    const before = structuralKeys(tree('Untitled - Notepad'));
    const after = structuralKeys(tree('*hello - Notepad'));
    assert.notEqual(before[0], after[0], 'the root itself should be re-keyed');
    assert.deepEqual(before.slice(1), after.slice(1), 'descendants must be untouched');
});

test('same-role siblings get distinct keys', () => {
    const keys = structuralKeys(tree('x'));
    assert.notEqual(keys[4], keys[5]);
    assert.equal(new Set(keys).size, keys.length);
});

test('identically named siblings stay distinct', () => {
    const dup = [n(0, 'list', 'Items'), n(1, 'listitem', 'Row'), n(1, 'listitem', 'Row')];
    const keys = structuralKeys(dup);
    assert.equal(new Set(keys).size, 3);
});

test('a node keeps its key when a sibling subtree changes elsewhere', () => {
    const a = structuralKeys(tree('x'));
    const withExtra = [...tree('x')];
    withExtra.splice(3, 0, n(2, 'text', 'extra'));
    const b = structuralKeys(withExtra);
    // The toolbar branch is unaffected by an insertion in the document branch.
    assert.equal(a[3], b[4]);
});

test('names containing newlines are flattened', () => {
    assert.equal(clean('Line 1,\nColumn 27'), 'Line 1, Column 27');
    const keys = structuralKeys([n(0, 'text', 'Line 1,\nColumn 27')]);
    assert.equal(keys[0].includes('\n'), false);
});

test('display depth follows the retained ancestor chain', () => {
    // Sparse raw depths, as produced once unnamed containers are dropped.
    assert.deepEqual(displayDepths([{ depth: 0 }, { depth: 5 }, { depth: 9 }, { depth: 5 }]), [0, 1, 2, 1]);
});

test('an unchanged tree diffs to null', () => {
    const a = toSnapshotNodes(tree('x'));
    const b = toSnapshotNodes(tree('x'));
    assert.equal(diffLines(a, b), null);
});

test('a value change is reported as a modification, not add plus remove', () => {
    const before = toSnapshotNodes(tree('x'));
    const changed = tree('x');
    changed[1].value = 'abcdef';
    const after = toSnapshotNodes(changed);

    const lines = diffLines(before, after);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^~ Text editor \[document\] "abc" enabled -> "abcdef" enabled/);
});

test('an enable/disable flip is reported as a modification', () => {
    const before = toSnapshotNodes(tree('x'));
    const changed = tree('x');
    changed[4].enabled = false;
    const lines = diffLines(before, toSnapshotNodes(changed));
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^~ File \[menuitem\] enabled -> disabled/);
});

test('additions and removals are reported separately', () => {
    const before = toSnapshotNodes(tree('x'));
    const shorter = tree('x').slice(0, 5);
    const lines = diffLines(before, toSnapshotNodes(shorter));
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^- Edit \[menuitem\]/);
});

test('a title-only edit yields one change, not a whole-tree diff', () => {
    // The regression that matters: before the key fix this produced six lines.
    const lines = diffLines(toSnapshotNodes(tree('Untitled')), toSnapshotNodes(tree('*edited')));
    assert.equal(lines.length, 2, 'one add for the new title, one remove for the old');
    assert.equal(lines.some(l => l.includes('menuitem')), false, 'menu items must not appear');
});

// --- tree diagnosis --------------------------------------------------------

import { diagnoseTree } from '../dist-test/uitree.js';

const snap = (indent, name, role = 'pane') => ({
    key: `${role}[1]:${name}`, indent, name, role, enabled: true, ref: 'el_1', rect: R
});

test('a window with no children is reported as having no provider', () => {
    const d = diagnoseTree([snap(0, 'Studio', 'window')]);
    assert.match(d, /no accessibility provider/);
});

test('a window exposing only title-bar buttons is reported as frame-only', () => {
    // Exactly what VS Code and Qt apps return when the toolkit is not publishing.
    const d = diagnoseTree([
        snap(0, 'Studio', 'window'),
        snap(1, 'Minimize', 'button'),
        snap(1, 'Maximize', 'button'),
        snap(1, 'Close', 'button')
    ]);
    assert.match(d, /Only the window frame/);
    assert.match(d, /read_text/);
});

test('a wrapper echoing the window title does not count as content', () => {
    // The regression: Chromium nests a pane named after the window, and treating
    // that as real content stopped the diagnosis firing on the very tree it was
    // written for.
    const d = diagnoseTree([snap(0, 'Studio', 'window'), snap(1, 'Studio', 'pane')]);
    assert.match(d, /Only the window frame/);
});

test('a real tree produces no diagnosis', () => {
    const d = diagnoseTree([
        snap(0, 'Studio', 'window'),
        snap(1, 'Studio', 'pane'),
        snap(2, 'Run', 'button'),
        snap(2, 'Stop', 'button')
    ]);
    assert.equal(d, null);
});

// --- echo pruning and row formats -----------------------------------------

import { pruneEchoes, row, elementLine } from '../dist-test/uitree.js';

test('a text child repeating its container name is dropped', () => {
    // Chromium's shape: every button and link carries a text child with its label.
    const nodes = toSnapshotNodes([
        n(0, 'window', 'App'),
        n(3, 'button', 'Save'),
        n(5, 'text', 'Save'),
        n(3, 'link', 'Help'),
        n(4, 'text', 'Help')
    ]);
    assert.deepEqual(nodes.map(x => `${x.role}:${x.name}`), ['window:App', 'button:Save', 'link:Help']);
});

test('text that says something new is kept', () => {
    const kept = pruneEchoes([
        n(0, 'window', 'App'),
        n(1, 'button', 'Save'),
        n(2, 'text', 'Save all'),
        n(2, 'text', 'Save', { value: 'x' }),
        n(2, 'text', 'Save', { automation_id: 'lbl' })
    ]);
    assert.equal(kept.length, 5);
});

test('only text roles are pruned, and never a direct child of the window', () => {
    // The Chromium wrapper that repeats the window title must survive, or
    // diagnoseTree reports "no provider" instead of "frame only".
    const kept = pruneEchoes([n(0, 'window', 'Studio'), n(1, 'text', 'Studio'), n(1, 'pane', 'Studio')]);
    assert.equal(kept.length, 3);
    const nested = pruneEchoes([n(0, 'window', 'W'), n(1, 'group', 'Tools'), n(2, 'group', 'Tools')]);
    assert.equal(nested.length, 3);
});

test('pruning keys and diffs consistently across snapshots', () => {
    const t = () => [n(0, 'window', 'App'), n(1, 'button', 'Go'), n(2, 'text', 'Go'), n(1, 'button', 'Stop')];
    assert.equal(diffLines(toSnapshotNodes(t()), toSnapshotNodes(t())), null);
});

test('a value equal to the name is not printed twice', () => {
    const [, node] = toSnapshotNodes([n(0, 'window', 'W'), n(1, 'text', 'Ready', { value: 'Ready' })]);
    assert.equal(row(node, false).includes('"Ready"'), false);
});

test('element lines match describe rows, plus the rect', () => {
    const line = elementLine({
        ref: 'el_7',
        name: 'Export',
        role: 'button',
        automation_id: 'ExportBtn',
        enabled: false,
        rect: { x: 100, y: 200, width: 80, height: 24 }
    });
    assert.equal(line, 'Export [button] disabled id=ExportBtn  80x24@100,200  el_7');
});
