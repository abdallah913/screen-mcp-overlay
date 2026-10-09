import test from 'node:test';
import assert from 'node:assert/strict';
import { call, connect, fakeHelper, harness, rect } from './support/fake-helper.mjs';

/*
 * The MCP tools end to end: the real server and every handler, with Electron
 * stubbed and the UI Automation helper answered in-process. This is the layer an
 * agent actually sees, so it is where the token budget and the response
 * formats are pinned down.
 */

const { stripSchemaNoise, TOOL_NAMES, store } = harness;

/**
 * Model-visible size of the tool list (name + description + input schema per
 * tool), which is resent on every turn of every conversation. Raise it only
 * deliberately, and record why in docs/DESIGN.md: it was 12,673 characters
 * before the tool surface was tightened, 10,153 after, and 10,863 once
 * walkthrough plans, value and change waits, multiple-choice questions and
 * scrolling to a named control were added.
 */
const TOOL_LIST_BUDGET = 11_000;

/**
 * The server instructions, sent once per connection and usually placed in the
 * system prompt. They carry the strategy no single tool description can.
 */
const INSTRUCTIONS_BUDGET = 1_400;

test.beforeEach(() => store.clear());

// --- the tool list ------------------------------------------------------------

test('the registered tools are exactly TOOL_NAMES, in order', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    await client.close();
    assert.deepEqual(tools.map(t => t.name), [...TOOL_NAMES]);
});

test(`the tool list stays within its ${TOOL_LIST_BUDGET}-character budget`, async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    await client.close();
    const size = tools.reduce(
        (n, t) => n + JSON.stringify({ name: t.name, description: t.description, input_schema: t.inputSchema }).length,
        0
    );
    assert.ok(size <= TOOL_LIST_BUDGET, `tool list is ${size} chars`);
});

test(`the server instructions stay within ${INSTRUCTIONS_BUDGET} characters`, async () => {
    const client = await connect();
    const size = client.getInstructions().length;
    await client.close();
    assert.ok(size <= INSTRUCTIONS_BUDGET, `instructions are ${size} chars`);
});

test('the tool list carries no schema noise', async () => {
    const client = await connect();
    const listed = JSON.stringify((await client.listTools()).tools);
    await client.close();
    assert.equal(listed.includes('$schema'), false);
    assert.equal(listed.includes(String(Number.MAX_SAFE_INTEGER)), false);
});

test('stripSchemaNoise keeps real bounds', () => {
    const out = stripSchemaNoise({
        $schema: 'x',
        properties: { a: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER }, b: { minimum: -Number.MAX_SAFE_INTEGER, maximum: 5 } }
    });
    assert.deepEqual(out, { properties: { a: { type: 'integer', minimum: 0 }, b: { maximum: 5 } } });
});

// --- windows by title ---------------------------------------------------------

test('list_windows prints one compact line per window, without our own or minimised ones', async () => {
    fakeHelper();
    const { text } = await call('list_windows');
    const lines = text.split('\n');
    assert.equal(lines[0], '2 window(s), ref WxH@x,y title:');
    assert.equal(lines[1], '100 800x600@100,100 Untitled - Notepad [foreground]');
    assert.equal(lines[2], '200 320x500@1000,100 Calculator');
    assert.match(lines[3], /^displays: 1 primary 1920x1080 scale 1$/);
});

test('describe_window resolves a title and prunes echo rows', async () => {
    const { calls } = fakeHelper();
    const { text, isError } = await call('describe_window', { window: 'notepad' });
    assert.equal(isError, false);
    assert.deepEqual(calls.find(c => c.op === 'describe').params.window, '100');
    assert.match(text, /^Untitled - Notepad \[window\] {2}800x600@100,100$/m);
    assert.match(text, /^ {2}Save \[button\] {2}el_11$/m);
    assert.equal(/Save \[text\]/.test(text), false, 'the text echo of the button is dropped');
    assert.match(text, /Text editor \[document\] "hello" {2}el_13/);
    assert.match(text, /snapshotId: snap_\d+/);
});

test('a numeric ref skips the window list entirely', async () => {
    const { calls } = fakeHelper();
    await call('describe_window', { window: '100' });
    assert.equal(calls.some(c => c.op === 'list_windows'), false);
});

test('an unknown title is an error that lists what is open', async () => {
    fakeHelper();
    const { text, isError } = await call('describe_window', { window: 'Photoshop' });
    assert.equal(isError, true);
    assert.match(text, /no window title contains "Photoshop"/);
    assert.match(text, /100 "Untitled - Notepad"/);
});

test('"foreground" names the foreground window', async () => {
    const { calls } = fakeHelper();
    await call('focus_window', { window: 'foreground' });
    assert.equal(calls.find(c => c.op === 'focus_window').params.window, '100');
});

// --- finding and drawing --------------------------------------------------------

test('find_ui_elements answers in describe-row format', async () => {
    fakeHelper();
    const { text } = await call('find_ui_elements', { window: 'Notepad', name: 'export' });
    assert.equal(text, '1 match(es):\nExport [button] disabled  80x24@250,150  el_2');
});

test('annotate anchors to a control by window title and name, in one call', async () => {
    const { calls } = fakeHelper();
    const { text, isError } = await call('annotate', {
        anchor: { window: 'Notepad', name: 'Save' },
        shapes: [{ type: 'circle', text: 'here' }]
    });
    assert.equal(isError, false, text);
    assert.match(text, /^Drew ann_\d+ on "Save" \[button\] el_1, top-left of "Untitled - Notepad"; they follow it\.$/);
    assert.equal(calls.find(c => c.op === 'find_elements').params.window, '100');

    const [a] = store.list();
    assert.equal(a.anchor.fit, true, 'an unsized circle fits its target');
    assert.deepEqual(a.anchor.selector, { window: '100', name: 'Save', role: undefined, automationId: undefined });
    assert.deepEqual(a.rect, rect(146, 146, 88, 32), 'fitted with the default 4px pad');
});

test('annotate infers a window anchor and fits an unsized box to it', async () => {
    fakeHelper();
    const { text } = await call('annotate', { anchor: { window: 'Calculator' }, shapes: [{ type: 'box', pad: 0 }] });
    assert.match(text, /on window 200/);
    assert.deepEqual(store.list()[0].rect, rect(1000, 100, 320, 500));
});

test('annotate still honours the legacy kind and fit fields', async () => {
    fakeHelper();
    const { isError } = await call('annotate', {
        anchor: { kind: 'name', window: '100', name: 'Save' },
        shapes: [{ type: 'box', fit: true }]
    });
    assert.equal(isError, false);
    assert.equal(store.list()[0].anchor.fit, true);
});

test('an anchored shape with only one dimension is rejected', async () => {
    fakeHelper();
    const { text, isError } = await call('annotate', {
        anchor: { window: 'Notepad' },
        shapes: [{ type: 'box', width: 40 }]
    });
    assert.equal(isError, true);
    assert.match(text, /needs both width and height, or neither/);
    assert.equal(store.list().length, 0);
});

test('a fixed shape without a size is rejected', async () => {
    fakeHelper();
    const { text, isError } = await call('annotate', { space: 'physical', shapes: [{ type: 'box', x: 0, y: 0 }] });
    assert.equal(isError, true);
    assert.match(text, /needs width and height/);
});

test('a missing control is an error that points at describe_window', async () => {
    fakeHelper();
    const { text, isError } = await call('annotate', { anchor: { window: 'Notepad', name: 'Nope' }, shapes: [{ type: 'box' }] });
    assert.equal(isError, true);
    assert.match(text, /no control matching .*describe_window/);
});

// --- waiting ----------------------------------------------------------------------

test('wait_for_element passes automationId through and reports NOT met', async () => {
    const { calls } = fakeHelper();
    const { text } = await call('wait_for_element', { condition: 'appears', automationId: 'Missing', window: 'Notepad', timeoutMs: 0 });
    assert.match(text, /^NOT met: "appears" did not happen within/);
    const find = calls.find(c => c.op === 'find_elements').params;
    assert.equal(find.automation_id, 'Missing');
    assert.equal(find.window, '100');
});

test('wait_for_element returns the matching control', async () => {
    fakeHelper();
    const { text } = await call('wait_for_element', { condition: 'appears', name: 'Save', window: 'Notepad', timeoutMs: 0 });
    assert.match(text, /^Met: "appears" after \d+\.\ds\.\nSave \[button\] id=SaveBtn {2}80x24@150,150 {2}el_1$/);
});

test('an unscoped control wait warns about its cost; a top-level window wait does not', async () => {
    fakeHelper();
    assert.match((await call('wait_for_element', { condition: 'appears', name: 'Save', timeoutMs: 0 })).text, /not scoped/);
    const dialog = await call('wait_for_element', { condition: 'appears', name: 'Calc', role: 'dialog', timeoutMs: 0 });
    assert.match(dialog.text, /^Met:/);
    assert.equal(/not scoped/.test(dialog.text), false);
});

test('highlight_and_wait with until: waits for the UI, then swaps its circle for a check mark', async () => {
    let checks = 0;
    fakeHelper({
        // "Saved" shows up on the second check, as if the user clicked Save.
        find_elements: p => {
            if (p.name === 'Save') return [{ ref: 'el_1', name: 'Save', role: 'button', rect: rect(150, 150, 80, 24), enabled: true }];
            checks += 1;
            return checks >= 2 ? [{ ref: 'el_5', name: 'Saved', role: 'text', rect: rect(0, 0, 10, 10), enabled: true }] : [];
        }
    });
    const { text, isError } = await call('highlight_and_wait', {
        window: 'Notepad',
        name: 'Save',
        prompt: 'Click Save',
        until: { condition: 'appears', name: 'Saved' },
        timeoutMs: 5000
    });
    assert.equal(isError, false, text);
    assert.match(text, /^Met: "appears" after/);
    assert.equal(checks, 2);
    // The circle is gone; a one-second check mark confirms the step on screen.
    assert.deepEqual(store.list().map(a => a.type), ['done']);
});

test('highlight_and_wait rejects an empty until before drawing anything', async () => {
    fakeHelper();
    const { text, isError } = await call('highlight_and_wait', {
        window: 'Notepad',
        name: 'Save',
        prompt: 'x',
        until: { condition: 'appears' }
    });
    assert.equal(isError, true);
    assert.match(text, /until needs name, automationId or role/);
    assert.equal(store.list().length, 0);
});

// --- talking --------------------------------------------------------------------

test('show_message says when it could not speak', async () => {
    fakeHelper();
    assert.equal((await call('show_message', { text: 'hi' })).text, 'Shown.');
    assert.equal((await call('show_message', { text: 'hi', speak: true })).text, 'Shown, but not spoken: the overlay panel is not running.');
});
