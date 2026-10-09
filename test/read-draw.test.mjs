import test from 'node:test';
import assert from 'node:assert/strict';
import { call, fakeDesktop, fakeHelper, harness, rect } from './support/fake-helper.mjs';

/*
 * Reading, drawing and acting tools against the fake helper: what an agent is
 * told when a name is ambiguous or missing, when a window is minimised or
 * elevated, when a target is covered or scrolled away, and how a question with
 * options comes back.
 */

const { store, answerStep, currentStep } = harness;

test.beforeEach(() => store.clear());

const control = (ref, name, extra = {}) => ({ ref, name, role: 'button', rect: rect(150, 150, 80, 24), enabled: true, ...extra });

// --- choosing the control a name means ---------------------------------------

test('annotate circles the exact label, not the first substring match', async () => {
    const desktop = fakeDesktop();
    desktop.controls = [control('el_1', 'Autosave'), control('el_2', 'Save as…'), control('el_3', 'Save')];
    const { calls } = fakeHelper({}, desktop);
    const { text, isError } = await call('annotate', { anchor: { window: 'Notepad', name: 'Save' }, shapes: [{ type: 'circle' }] });
    assert.equal(isError, false, text);
    assert.match(text, /on "Save" \[button\] el_3, top-left of "Untitled - Notepad";/);
    assert.equal(/Also matched/.test(text), false, 'a unique exact match is not ambiguous');
    assert.ok(calls.find(c => c.op === 'find_elements').params.limit > 1, 'asks for more than the first hit');
});

test('an ambiguous name says what else it matched', async () => {
    const desktop = fakeDesktop();
    desktop.controls = [control('el_1', 'Save as…'), control('el_2', 'Save all', { rect: rect(150, 150, 60, 24) })];
    fakeHelper({}, desktop);
    const { text } = await call('annotate', { anchor: { window: 'Notepad', name: 'Save' }, shapes: [{ type: 'circle' }] });
    assert.match(text, /on "Save all" \[button\] el_2, top-left of "Untitled - Notepad";/, 'ties go to the smaller control');
    assert.match(text, /Also matched "Save as…" \[button\]/);
});

test('a miss lists the closest names, labelled as not drawn', async () => {
    fakeHelper({ suggest: () => [{ name: 'Save As', role: 'menuitem' }] });
    const { text, isError } = await call('annotate', { anchor: { window: 'Notepad', name: 'Sav As' }, shapes: [{ type: 'box' }] });
    assert.equal(isError, true);
    assert.match(text, /no control matching .* "Untitled - Notepad"\. Closest names \(not drawn\): "Save As" \[menuitem\]\. describe_window/);
    assert.equal(store.list().length, 0);
});

test('a miss on a control inside a collapsed container says to open it first', async () => {
    const desktop = fakeDesktop();
    desktop.controls.push(
        control('el_8', 'Large', {
            role: 'listitem',
            hidden: 'collapsed',
            container: { ref: 'el_9', name: 'Size', role: 'combobox' }
        })
    );
    fakeHelper({}, desktop);
    const { text, isError } = await call('annotate', { anchor: { window: 'Notepad', name: 'Large' }, shapes: [{ type: 'box' }] });
    assert.equal(isError, true);
    assert.match(text, /"Large" is inside collapsed "Size" \[combobox\] el_9: point the user at that first/);
});

test('a scoped find that misses gives the same hints', async () => {
    fakeHelper({ suggest: () => [{ name: 'Export', role: 'button' }] });
    const { text } = await call('find_ui_elements', { window: 'Notepad', name: 'Exprt' });
    assert.equal(text, 'No matching controls. Closest names (not drawn): "Export" [button].');
});

// --- what the user can actually see -------------------------------------------

test('a covered target is drawn, marked and warned about', async () => {
    fakeHelper({ covered: () => ({ fraction: 0.85, centre_covered: true, by: ['Google Chrome'] }) });
    const { text, isError } = await call('annotate', { anchor: { window: 'Notepad', name: 'Save' }, shapes: [{ type: 'circle' }] });
    assert.equal(isError, false);
    assert.match(text, /WARNING: "Save" \[button\] el_1 is behind "Google Chrome".*focus_window \{"window":"100"\}/);
    assert.equal(store.list()[0].covered, 'Google Chrome');
});

test('a scrolled-out target is marked offscreen and the response says how to bring it in', async () => {
    const desktop = fakeDesktop();
    desktop.controls[0].offscreen = true;
    const { calls } = fakeHelper({}, desktop);
    const { text } = await call('annotate', { anchor: { window: 'Notepad', name: 'Save' }, shapes: [{ type: 'circle' }] });
    assert.match(text, /WARNING: .* is scrolled out of view; scroll_window \{"window":"100","name":"Save"\} brings it into view/);
    assert.equal(store.list()[0].offscreen, true);
    assert.equal(calls.some(c => c.op === 'covered'), false, 'coverage of an offscreen rect means nothing');
});

test('scroll_window with a name scrolls that control into view', async () => {
    const { calls } = fakeHelper();
    const { text, isError } = await call('scroll_window', { window: 'Notepad', name: 'Export' });
    assert.equal(isError, false, text);
    assert.equal(text, 'Scrolled into view: Export [button] disabled  80x24@250,150  el_2');
    assert.deepEqual(calls.find(c => c.op === 'scroll_into_view').params, {
        window: '100',
        name: 'Export',
        role: undefined,
        automation_id: undefined
    });
    assert.equal(calls.some(c => c.op === 'scroll_window'), false);
});

test('scroll_window says when a control cannot be scrolled into view', async () => {
    fakeHelper({
        scroll_into_view: () => {
            throw new Error('the control does not support ScrollItemPattern');
        }
    });
    const { text, isError } = await call('scroll_window', { window: 'Notepad', name: 'Save' });
    assert.equal(isError, true);
    assert.match(text, /could not scroll .* into view: the control does not support ScrollItemPattern\. Wheel notches/);
});

// --- window-level blockers ----------------------------------------------------

test('list_windows marks admin and hung windows and lists the ones the user cannot see', async () => {
    const desktop = fakeDesktop();
    desktop.windows[1].elevated = true;
    desktop.windows.push({ ...desktop.windows[0], ref: '500', title: 'Settings', cloaked: true, foreground: false });
    fakeHelper({}, desktop);
    const { text } = await call('list_windows');
    assert.match(text, /^200 320x500@1000,100 Calculator \[admin\]$/m);
    assert.match(text, /^not visible \(focus_window shows one\): 300 "Minimised thing" \[minimized\], 500 "Settings" \[other desktop\]$/m);
});

test('a minimised window is found by title and named as minimised', async () => {
    fakeHelper({ describe: () => ({ nodes: [], truncated: false }) });
    const described = await call('describe_window', { window: 'Minimised' });
    assert.equal(described.isError, false);
    assert.match(described.text, /^"Minimised thing" is minimized, so its controls have no place on screen\. focus_window restores it/);

    const drawn = await call('annotate', { anchor: { window: 'Minimised', name: 'Save' }, shapes: [{ type: 'box' }] });
    assert.equal(drawn.isError, true);
    assert.match(drawn.text, /"Minimised thing" is minimized: focus_window restores it, then draw\./);

    const focused = await call('focus_window', { window: 'Minimised' });
    assert.equal(focused.text, 'Window 300 is in front (restored from minimized).');
});

test('an elevated window\'s thin tree is blamed on UIPI', async () => {
    const desktop = fakeDesktop();
    desktop.windows[0].elevated = true;
    desktop.tree = [desktop.tree[0]];
    fakeHelper({}, desktop);
    const { text } = await call('describe_window', { window: 'Notepad' });
    assert.match(text, /NOTE: This window runs as administrator .*UIPI/);
});

test('a hung window is named when its tree cannot be read', async () => {
    const desktop = fakeDesktop();
    desktop.windows[0].hung = true;
    fakeHelper(
        {
            describe: () => {
                throw new Error('UI Automation helper timed out after 20000ms');
            }
        },
        desktop
    );
    const { text, isError } = await call('describe_window', { window: '100' });
    assert.equal(isError, true);
    assert.match(text, /"Untitled - Notepad" is not responding/);
});

// --- describe output ------------------------------------------------------------

test('a truncated describe names the subtrees it never reached', async () => {
    const desktop = fakeDesktop();
    fakeHelper({ describe: () => ({ nodes: desktop.tree, truncated: true, unvisited: ['File name', 'Buttons'] }) }, desktop);
    const { text } = await call('describe_window', { window: 'Notepad' });
    assert.match(text, /\(truncated: the walk stopped at maxNodes before reaching "File name", "Buttons"\./);
});

test('a describe the app stopped answering says so, not "raise maxNodes"', async () => {
    const desktop = fakeDesktop();
    fakeHelper({ describe: () => ({ nodes: desktop.tree.slice(0, 2), truncated: false, unanswered: true }) }, desktop);
    const { text } = await call('describe_window', { window: 'Notepad' });
    assert.match(text, /\(the app stopped answering partway, so this is only part of the window: describe it again once it responds\)/);
    assert.equal(/maxNodes/.test(text), false, text);
});

test('coverage of a list row tells the helper it is a row', async () => {
    const desktop = fakeDesktop();
    desktop.controls = [control('el_4', 'PDF', { role: 'listitem' }), control('el_5', 'Export')];
    const { calls } = fakeHelper({}, desktop);
    await call('annotate', { anchor: { window: 'Notepad', name: 'PDF' }, shapes: [{ type: 'circle' }] });
    await call('annotate', { anchor: { window: 'Notepad', name: 'Export' }, shapes: [{ type: 'circle' }] });
    const rows = calls.filter(c => c.op === 'covered').map(c => c.params.row);
    // A dropdown's option is drawn in its popup; a button under that popup is covered by it.
    assert.deepEqual(rows, [true, false]);
});

test('describe rows show state, popups and offscreen rows', async () => {
    const desktop = fakeDesktop();
    desktop.tree.push(
        { depth: 2, ref: 'el_20', name: 'Word wrap', role: 'checkbox', state: 'checked', enabled: true, rect: rect(0, 0, 9, 9) },
        { depth: 1, ref: 'el_21', name: 'Format', role: 'menu', popup: true, enabled: true, rect: rect(0, 0, 9, 9) },
        { depth: 2, ref: 'el_22', name: 'Font…', role: 'menuitem', offscreen: true, enabled: true, rect: rect(0, 0, 9, 9) }
    );
    fakeHelper({}, desktop);
    const { text } = await call('describe_window', { window: 'Notepad' });
    assert.match(text, /Word wrap \[checkbox\] checked {2}el_20/);
    assert.match(text, /\(popup\) Format \[menu\] {2}el_21/);
    assert.match(text, /Font… \[menuitem\] offscreen {2}el_22/);
});

// --- refs that outlive their helper ---------------------------------------------

test('a ref from a window-scoped search anchors with a selector to recover by', async () => {
    fakeHelper();
    await call('find_ui_elements', { window: 'Notepad', name: 'Save' });
    const { text, isError } = await call('annotate', { anchor: { ref: 'el_1' }, shapes: [{ type: 'box' }] });
    assert.equal(isError, false, text);
    assert.match(text, /on "Save" \[button\] el_1, top-left of "Untitled - Notepad";/);
    assert.deepEqual(store.list()[0].anchor.selector, { window: '100', role: 'button', automationId: 'SaveBtn' });
});

test('a ref no helper issued is reported as stale, not as a missing control', async () => {
    fakeHelper();
    const { text, isError } = await call('annotate', { anchor: { ref: 'el_404' }, shapes: [{ type: 'box' }] });
    assert.equal(isError, true);
    assert.match(text, /el_404" is no longer valid/);
});

// --- step numbering ---------------------------------------------------------------

test('steps added with replace:false carry on numbering', async () => {
    fakeHelper();
    const first = await call('annotate', {
        space: 'physical',
        shapes: [{ type: 'step', x: 0, y: 0, width: 30, height: 30 }, { type: 'step', x: 50, y: 0, width: 30, height: 30 }]
    });
    assert.match(first.text, /\(steps 1-2\)/);
    const more = await call('annotate', {
        anchor: { window: 'Notepad', name: 'Save' },
        replace: false,
        shapes: [{ type: 'step' }, { type: 'step', x: 90, y: 0, width: 30, height: 30 }]
    });
    assert.match(more.text, /\(steps 3-4\)/);
    assert.deepEqual(store.list().map(a => a.text), ['1', '2', '3', '4']);
});

test('captioned steps added with replace:false carry on numbering', async () => {
    fakeHelper();
    const first = await call('annotate', {
        space: 'physical',
        shapes: [{ type: 'step', x: 0, y: 0, width: 30, height: 30, text: 'Open the File menu' }]
    });
    assert.match(first.text, /\(step 1\)/);
    const more = await call('annotate', {
        space: 'physical',
        replace: false,
        shapes: [
            { type: 'step', x: 50, y: 0, width: 30, height: 30, text: 'Click Save' },
            { type: 'step', x: 90, y: 0, width: 30, height: 30, text: '3/3 Name the file' }
        ]
    });
    assert.match(more.text, /\(steps 2-3\)/);
    assert.deepEqual(store.list().map(a => a.text), ['1. Open the File menu', '2. Click Save', '3/3 Name the file']);
});

// --- misses, popups and dead refs ---------------------------------------------------

test('a miss with nothing hidden names the closed menus and lists it may be in', async () => {
    fakeHelper({
        suggest: () => [],
        collapsed: () => [
            control('el_30', 'File', { role: 'menuitem', state: 'collapsed' }),
            control('el_31', 'Font size', { role: 'combobox', state: 'collapsed' })
        ]
    });
    const { text, isError } = await call('annotate', { anchor: { window: 'Notepad', name: 'Page setup' }, shapes: [{ type: 'box' }] });
    assert.equal(isError, true);
    assert.match(text, /It may be inside a closed menu or list: "File" \[menuitem\] el_30, "Font size" \[combobox\] el_31\. describe_window/);
});

test('a row from an open popup is measured against the popup, not covered by it', async () => {
    const desktop = fakeDesktop();
    desktop.tree.push(
        { depth: 1, ref: 'el_21', name: 'File', role: 'menu', popup: true, window: '900', enabled: true, rect: rect(100, 120, 200, 300) },
        { depth: 2, ref: 'el_22', name: 'Save As', role: 'menuitem', enabled: true, rect: rect(110, 200, 180, 24) }
    );
    desktop.controls.push({ ref: 'el_22', name: 'Save As', role: 'menuitem', enabled: true, rect: rect(110, 200, 180, 24) });
    const { calls } = fakeHelper(
        {
            covered: p =>
                p.window === '900'
                    ? { fraction: 0, centre_covered: false, by: [] }
                    : { fraction: 1, centre_covered: true, by: ['a popup of Notepad'] }
        },
        desktop
    );
    await call('describe_window', { window: 'Notepad' });
    const { text, isError } = await call('annotate', { anchor: { ref: 'el_22' }, shapes: [{ type: 'circle' }] });
    assert.equal(isError, false, text);
    assert.match(text, /"Save As" \[menuitem\] el_22, in a popup of "Untitled - Notepad"/);
    assert.equal(/WARNING/.test(text), false, text);
    assert.equal(calls.filter(c => c.op === 'covered').at(-1).params.window, '900');
});

test('a dead ref whose selector now matches several look-alikes is not guessed', async () => {
    const desktop = fakeDesktop();
    desktop.controls = [control('el_40', 'Remove'), control('el_52', 'Remove', { rect: rect(150, 190, 80, 24) })];
    fakeHelper({}, desktop);
    await call('find_ui_elements', { window: 'Notepad', name: 'Remove' });
    // The app rebuilt its rows: the old refs name nothing, and two new look-alikes exist.
    desktop.controls.splice(0, 2, control('el_60', 'Remove'), control('el_61', 'Remove', { rect: rect(150, 190, 80, 24) }));
    const { text, isError } = await call('annotate', { anchor: { ref: 'el_52' }, shapes: [{ type: 'circle' }] });
    assert.equal(isError, true);
    assert.match(text, /anchor el_52 no longer resolves, and 2 controls now match "Remove": look it up again/);
    assert.equal(store.list().length, 0);
});

// --- scrolling and hidden drawings ---------------------------------------------------

test('scroll_window takes role only to narrow a name', async () => {
    const { calls } = fakeHelper();
    const { text, isError } = await call('scroll_window', { window: 'Notepad', role: 'button' });
    assert.equal(isError, true);
    assert.match(text, /role only narrows name or automationId/);
    assert.equal(calls.some(c => c.op === 'scroll_into_view' || c.op === 'scroll_window'), false);
    const narrowed = await call('scroll_window', { window: 'Notepad', name: 'Export', role: 'button' });
    assert.match(narrowed.text, /^Scrolled into view: Export \[button\]/);
    assert.equal(calls.find(c => c.op === 'scroll_into_view').params.role, 'button');
});

test('scroll_window says how far the view moved', async () => {
    fakeHelper({ scroll_window: () => ({ scrolled: true, before: 0, after: 31.4 }) });
    const { text } = await call('scroll_window', { window: 'Notepad', notches: -3 });
    assert.equal(text, 'Scrolled -3 notch(es): moved 0%->31%. Re-read to see the new content.');
});

test('scroll_window tells a small move in a long document from none', async () => {
    fakeHelper({ scroll_window: () => ({ scrolled: true, before: 12.2, after: 12.3 }) });
    const { text } = await call('scroll_window', { window: 'Notepad', notches: -3 });
    assert.equal(text, 'Scrolled -3 notch(es): moved 12.2%->12.3%. Re-read to see the new content.');
});

test('scroll_window says when nothing moved', async () => {
    fakeHelper({ scroll_window: () => ({ scrolled: true, before: 100, after: 100 }) });
    const { text } = await call('scroll_window', { window: 'Notepad', notches: -3 });
    assert.match(text, /^Scrolled -3 notch\(es\), but nothing moved \(still at 100%\): it is already at the end, or the app ignores wheel messages/);
});

test('scroll_window without a position to compare keeps the plain report', async () => {
    fakeHelper();
    const { text } = await call('scroll_window', { window: 'Notepad', notches: 2 });
    assert.match(text, /^Scrolled 2 notch\(es\)\. Re-read to see the new content; some apps ignore wheel messages/);
});

test('a drawing hidden for a while is reported with why', async () => {
    fakeHelper();
    await call('annotate', {
        anchor: { window: 'Notepad', name: 'Save' },
        shapes: [{ type: 'circle' }, { type: 'arrow', x: 0, y: 0, toX: 9, toY: 9 }]
    });
    const [circle, arrow] = store.list();
    store.applyTracking([
        { id: circle.id, displayId: circle.displayId, rect: circle.rect, hidden: true, hiddenReason: 'minimized' },
        { id: arrow.id, displayId: arrow.displayId, rect: arrow.rect, hidden: true, hiddenReason: 'gone' }
    ]);
    for (const a of store.list()) a.hiddenSince = Date.now() - 12_000;
    const { text } = await call('clear_annotations', { ids: ['ann_none'] });
    assert.match(text, new RegExp(`Note: ${circle.id} not showing for 12s: its window is minimised \\(focus_window restores it\\)\\.`));
    assert.match(text, new RegExp(`Note: ${arrow.id} not showing for 12s: the control is gone`));
});

test('a hidden drawing takes a new reason while it stays hidden', async () => {
    fakeHelper();
    await call('annotate', { anchor: { window: 'Notepad', name: 'Save' }, shapes: [{ type: 'circle' }] });
    const [circle] = store.list();
    const hide = hiddenReason => ({ id: circle.id, displayId: circle.displayId, rect: circle.rect, hidden: true, hiddenReason });
    store.applyTracking([hide('minimized')]);
    // The user closes the window they had minimised: "restore it" is wrong now.
    assert.equal(store.applyTracking([hide('closed')]), true);
    assert.equal(store.list()[0].hiddenReason, 'closed');
    // A tick that cannot say why keeps the reason it had.
    assert.equal(store.applyTracking([hide(undefined)]), false);
    assert.equal(store.list()[0].hiddenReason, 'closed');
});

// --- questions ---------------------------------------------------------------------

/** Answer the pending step once a tool has opened one. */
async function answerWhenAsked(answer) {
    for (let i = 0; i < 200 && !currentStep(); i += 1) await new Promise(r => setTimeout(r, 5));
    const step = currentStep();
    assert.ok(step, 'the tool opened a step');
    assert.equal(step.mode, 'choice');
    assert.deepEqual(step.options, ['Light', 'Dark']);
    answerStep(answer, step.id);
}

test('show_message with options blocks until the user picks one', async () => {
    fakeHelper();
    const [result] = await Promise.all([
        call('show_message', { text: 'Which theme?', options: ['Light', 'Dark'] }),
        answerWhenAsked({ kind: 'choice', index: 1 })
    ]);
    assert.equal(result.isError, false);
    assert.equal(result.text, 'CHOSE 2 "Dark"');
    assert.equal(currentStep(), null);
});

test('a typed reply to a question comes back as REPLIED', async () => {
    fakeHelper();
    const [result] = await Promise.all([
        call('show_message', { text: 'Which theme?', options: ['Light', 'Dark'] }),
        answerWhenAsked({ kind: 'reply', text: 'the blue one' })
    ]);
    assert.match(result.text, /^REPLIED after \d+s: "the blue one"$/);
});
