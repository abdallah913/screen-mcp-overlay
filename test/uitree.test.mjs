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
    assert.match(lines[0], /^~ Text editor \[document\] "abc" -> "abcdef" {2}el_/);
});

test('a state change names the old and new state words', () => {
    const t = checked => [n(0, 'window', 'Settings'), n(1, 'checkbox', 'Dark mode', { state: checked ? 'checked' : 'unchecked' })];
    const lines = diffLines(toSnapshotNodes(t(false)), toSnapshotNodes(t(true)));
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^~ Dark mode \[checkbox\] unchecked -> checked {2}el_/);
});

test('a state word that goes away reads as "not"', () => {
    const t = state => [n(0, 'window', 'W'), n(1, 'tabitem', 'Advanced', { state })];
    const [line] = diffLines(toSnapshotNodes(t('selected')), toSnapshotNodes(t(undefined)));
    assert.match(line, /^~ Advanced \[tabitem\] selected -> not selected/);
});

test('focus moving is not a change', () => {
    // Every click moves focus; reporting it would make every diff noisy.
    const t = state => [n(0, 'window', 'W'), n(1, 'edit', 'Name', { state })];
    assert.equal(diffLines(toSnapshotNodes(t(undefined)), toSnapshotNodes(t('focused'))), null);
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

test('rows carry state words, offscreen and popup marks', () => {
    const nodes = toSnapshotNodes([
        n(0, 'window', 'Paint'),
        n(1, 'checkbox', 'Rulers', { state: 'checked,focused' }),
        n(1, 'listitem', 'Layer 9', { offscreen: true }),
        n(1, 'menu', 'File', { popup: true })
    ]);
    assert.match(row(nodes[1], false), /^ {2}Rulers \[checkbox\] checked focused {2}el_/);
    assert.match(row(nodes[2], false), /^ {2}Layer 9 \[listitem\] offscreen {2}el_/);
    assert.match(row(nodes[3], false), /^ {2}\(popup\) File \[menu\] {2}el_/);
});

test('element lines carry state words and the offscreen mark', () => {
    const line = elementLine({
        ref: 'el_3',
        name: 'Dark mode',
        role: 'checkbox',
        enabled: true,
        state: 'checked',
        offscreen: true,
        rect: { x: 1, y: 2, width: 3, height: 4 }
    });
    assert.equal(line, 'Dark mode [checkbox] checked offscreen  3x4@1,2  el_3');
});

// --- collapsing long lists ----------------------------------------------------

import { collapseRuns } from '../dist-test/uitree.js';

const list = (count, extra = () => ({})) => [
    n(0, 'window', 'Files'),
    n(1, 'list', 'Items'),
    ...Array.from({ length: count }, (_, i) => n(2, 'listitem', `File ${i + 1}`, extra(i))),
    n(1, 'button', 'Save')
];
const shown = raw => collapseRuns(toSnapshotNodes(raw));
const marker = rows => rows.find(x => x.more !== undefined);

test('a long run of list items prints as a few rows and a marker', () => {
    const rows = shown(list(20)).map(x => row(x, false).trim());
    assert.deepEqual(rows.slice(2, 7).map(r => r.split(' [')[0]), ['File 1', 'File 2', 'File 3', 'File 4', 'File 5']);
    assert.equal(rows[7], '… +15 more [listitem]; find_ui_elements role:listitem name:…');
    // The point of collapsing: what comes after the list is still there.
    assert.match(rows[8], /^Save \[button\]/);
});

test('a short run is left alone', () => {
    assert.equal(marker(shown(list(8))), undefined);
});

test('a selected or focused item is never collapsed away', () => {
    const rows = shown(list(20, i => (i === 11 ? { state: 'selected' } : {})));
    assert.ok(rows.some(x => x.name === 'File 12'));
    assert.equal(marker(rows).more, 14);
});

test('a collapsed item takes its children with it', () => {
    const raw = list(10);
    raw.splice(10, 0, n(3, 'text', 'size 4 KB'));
    assert.equal(shown(raw).some(x => x.name === 'size 4 KB'), false);
});

/** Explorer's navigation pane: "This PC" is the 10th top-level item and holds the selection. */
const navPane = (selected, checked) => [
    n(0, 'window', 'Explorer'),
    n(1, 'tree', 'Navigation'),
    ...['Home', 'Gallery', 'Desktop', 'Downloads', 'Documents', 'Pictures', 'Music', 'Videos', 'OneDrive'].map((name, i) =>
        n(2, 'treeitem', name, i === 7 && checked ? { state: 'checked' } : {})
    ),
    n(2, 'treeitem', 'This PC', { state: 'expanded' }),
    n(3, 'treeitem', 'Local Disk (C:)', selected === 'C' ? { state: 'selected,focused' } : {}),
    n(3, 'treeitem', 'Data (D:)', selected === 'D' ? { state: 'selected,focused' } : {})
];

test('a run item holding the selected row keeps it, and the path to it', () => {
    const rows = shown(navPane('C'));
    assert.ok(rows.some(x => x.name === 'This PC'));
    assert.ok(rows.some(x => x.name === 'Local Disk (C:)'));
    assert.equal(marker(rows).more, 4, 'Pictures, Music, Videos and OneDrive');
});

test('a nested run inside a collapsed row leaves no marker behind', () => {
    const raw = list(10);
    raw.splice(11, 0, ...Array.from({ length: 12 }, (_, i) => n(3, 'listitem', `Child ${i}`)));
    const rows = shown(raw);
    assert.equal(rows.filter(x => x.more !== undefined).length, 1);
    assert.equal(rows.some(x => x.name.startsWith('Child')), false);
});

test('a change inside a collapsed row still shows in the diff', () => {
    // Snapshots keep every row; only the printed text collapses.
    const moved = diffLines(toSnapshotNodes(navPane('C')), toSnapshotNodes(navPane('D')));
    assert.ok(moved?.some(l => l.startsWith('~ Local Disk (C:) [treeitem] selected -> not selected')), String(moved));
    assert.ok(moved?.some(l => l.startsWith('~ Data (D:) [treeitem] not selected -> selected')), String(moved));
    const toggled = diffLines(toSnapshotNodes(navPane('C')), toSnapshotNodes(navPane('C', true)));
    assert.match(toggled?.join('\n') ?? '', /~ Videos \[treeitem\] not checked -> checked/);
});

test('rows added past the fifth item are reported', () => {
    const lines = diffLines(toSnapshotNodes(list(20)), toSnapshotNodes(list(22)));
    assert.deepEqual(lines?.map(l => l.split('  ')[0]), ['+ File 21 [listitem]', '+ File 22 [listitem]']);
});

test('rows the helper did not read print as a marker, and a change in their count is a change', () => {
    const cut = unread => [
        n(0, 'window', 'Files'),
        n(1, 'list', 'Items'),
        ...Array.from({ length: 5 }, (_, i) => n(2, 'listitem', `File ${i + 1}`, i === 4 ? { more: unread } : {})),
        n(1, 'button', 'Save')
    ];
    const rows = shown(cut(40)).map(x => row(x, false).trim());
    assert.equal(rows[7], '… +40 more [listitem] not read; find_ui_elements role:listitem name:…');
    assert.match(rows[8], /^Save \[button\]/);
    const [line] = diffLines(toSnapshotNodes(cut(40)), toSnapshotNodes(cut(42)));
    assert.match(line, /^~ File 5 \[listitem\] \+40 unread -> \+42 unread/);
    assert.equal(diffLines(toSnapshotNodes(cut(40)), toSnapshotNodes(cut(40))), null);
});

test('a long run cut short by the helper says how many of the rest were not read', () => {
    const raw = list(10);
    raw[11] = { ...raw[11], more: 30 };
    const rows = shown(raw).map(x => row(x, false).trim());
    assert.equal(rows[7], '… +35 more [listitem] (30 not read); find_ui_elements role:listitem name:…');
});

test('an open popup does not renumber the window\'s own children', () => {
    const base = [n(0, 'window', 'App'), n(1, 'pane', 'Main'), n(2, 'button', 'OK'), n(2, 'edit', 'Name')];
    const withPopup = [base[0], n(1, 'pane', 'Suggestions', { popup: true }), n(2, 'listitem', 'One'), ...base.slice(1)];
    const lines = diffLines(toSnapshotNodes(base), toSnapshotNodes(withPopup));
    assert.deepEqual(lines?.map(l => l.split('  ')[0]), ['+ (popup) Suggestions [pane]', '+ One [listitem]']);
});

// --- elevated windows ---------------------------------------------------------

test('a thin tree from an elevated window blames UIPI, not the provider', () => {
    const d = diagnoseTree([snap(0, 'Task Manager', 'window'), snap(1, 'Close', 'button')], { elevated: true });
    assert.match(d, /administrator/);
    assert.match(d, /UIPI/);
    assert.equal(/no accessibility provider/.test(d), false);
});

test('a full tree from an elevated window needs no diagnosis', () => {
    const d = diagnoseTree([snap(0, 'Regedit', 'window'), snap(1, 'HKEY_CURRENT_USER', 'treeitem')], { elevated: true });
    assert.equal(d, null);
});

// --- ranking name matches -----------------------------------------------------

import { rankMatches, isAmbiguous, labelKey, nameTier, whereIn } from '../dist-test/uitree.js';

const m = (name, extra = {}) => ({ name, enabled: true, rect: { x: 0, y: 0, width: 10, height: 10 }, ...extra });

test('labels compare without case, mnemonics, ellipses or shortcuts', () => {
    assert.equal(labelKey('&Save As...\tCtrl+Shift+S'), 'save as');
    assert.equal(labelKey('Export…'), 'export');
    assert.equal(nameTier('Save', 'save'), 0);
    assert.equal(nameTier('Save as…', 'Save'), 1);
    assert.equal(nameTier('Autosave', 'Save'), 2);
});

test('an exact label beats one that starts with it, which beats one that contains it', () => {
    const ranked = rankMatches([m('Autosave'), m('Save as…'), m('Save')], { name: 'Save' });
    assert.deepEqual(ranked.map(x => x.name), ['Save', 'Save as…', 'Autosave']);
});

test('an AutomationId match comes first', () => {
    const ranked = rankMatches([m('Save'), m('Store', { automation_id: 'SaveBtn' })], { name: 'Save', automationId: 'SaveBtn' });
    assert.equal(ranked[0].name, 'Store');
});

test('ties go to the enabled, visible, smaller control inside the window', () => {
    const win = { x: 0, y: 0, width: 100, height: 100 };
    const big = m('OK', { rect: { x: 0, y: 0, width: 90, height: 90 } });
    const disabled = m('OK', { enabled: false });
    const off = m('OK', { offscreen: true });
    const outside = m('OK', { rect: { x: 500, y: 500, width: 5, height: 5 } });
    const small = m('OK');
    assert.equal(rankMatches([disabled, off, outside, big, small], { name: 'OK' }, win)[0], small);
});

test('a unique exact match is not ambiguous; partial or repeated matches are', () => {
    assert.equal(isAmbiguous(rankMatches([m('Save as'), m('Save')], { name: 'Save' }), { name: 'Save' }), false);
    assert.equal(isAmbiguous([m('Save as'), m('Save all')], { name: 'Save' }), true);
    assert.equal(isAmbiguous([m('Save'), m('Save')], { name: 'Save' }), true);
    assert.equal(isAmbiguous([m('Save')], { name: 'Save' }), false);
});

import { recoveredMatch } from '../dist-test/uitree.js';

const at = (y, extra = {}) => m('Remove', { rect: { x: 100, y, width: 80, height: 24 }, ...extra });

test('a re-found control with no look-alike is taken wherever it is now', () => {
    const only = at(500);
    assert.equal(recoveredMatch([only], { name: 'Remove' }, { x: 100, y: 40, width: 80, height: 24 }), only);
    assert.equal(recoveredMatch([only], { name: 'Remove' }), only);
    assert.equal(recoveredMatch([], { name: 'Remove' }), undefined);
});

test('among look-alikes only the one where the drawing was is taken', () => {
    const rows = [at(40), at(80), at(120)];
    assert.equal(recoveredMatch(rows, { name: 'Remove' }, { x: 100, y: 82, width: 80, height: 24 }), rows[1]);
    // Nowhere near any of them, or no idea where it was: not guessed.
    assert.equal(recoveredMatch(rows, { name: 'Remove' }, { x: 100, y: 300, width: 80, height: 24 }), undefined);
    assert.equal(recoveredMatch(rows, { name: 'Remove' }), undefined);
});

test('a shared AutomationId is a tie too', () => {
    const rows = [at(40, { automation_id: 'RemoveBtn' }), at(80, { automation_id: 'RemoveBtn' })];
    const wanted = { automationId: 'RemoveBtn' };
    assert.equal(recoveredMatch(rows, wanted), undefined);
    assert.equal(recoveredMatch(rows, wanted, { x: 100, y: 80, width: 80, height: 24 }), rows[1]);
});

test('an exact label beside partial matches is not a tie', () => {
    const ranked = rankMatches([m('Save as…'), m('Save')], { name: 'Save' });
    assert.equal(recoveredMatch(ranked, { name: 'Save' }).name, 'Save');
});

test('where a control sits is said in thirds of its window', () => {
    const win = { x: 100, y: 100, width: 900, height: 600 };
    assert.equal(whereIn({ x: 110, y: 110, width: 20, height: 20 }, win), 'top-left');
    assert.equal(whereIn({ x: 540, y: 390, width: 20, height: 20 }, win), 'centre');
    assert.equal(whereIn({ x: 540, y: 650, width: 20, height: 20 }, win), 'bottom');
    assert.equal(whereIn({ x: 950, y: 390, width: 20, height: 20 }, win), 'right');
    assert.equal(whereIn({ x: 2000, y: 390, width: 20, height: 20 }, win), null);
});
