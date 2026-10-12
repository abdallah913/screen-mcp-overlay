import test from 'node:test';
import assert from 'node:assert/strict';
import { call, connect, fakeDesktop, fakeHelper, harness, rect } from './support/fake-helper.mjs';

/*
 * The guidance tools never tell the agent about a window the user did not
 * share (src/main/mcp/tools/guide.ts, anchoring.ts, draw.ts, act.ts,
 * src/main/waits.ts, anchors.ts). The user watches a video on the side while
 * getting help in Notepad: whatever they do with the video, the agent hears
 * nothing of it, not its title, its ref, that it opened, that it is in front,
 * or what was clicked in it. A refusal for it reads exactly like one for a
 * window that is not open, and costs the same.
 */

const { store, answerStep, addClick, cancelStep, currentStep, stopSharingWindow } = harness;

test.beforeEach(() => store.clear());
test.afterEach(() => cancelStep('clear'));

const flags = { minimized: false, cloaked: false, elevated: false, hung: false };

/** The private window: in the full list, never shared. */
const video = {
    ref: '500',
    title: 'Lofi beats - YouTube - Google Chrome',
    class: 'Chrome_WidgetWin_1',
    pid: 40,
    exe: 'chrome.exe',
    rect: rect(1400, 100, 480, 360),
    foreground: false,
    private: true,
    ...flags
};

/** Anything that would tell the agent the video exists. `500` alone, not inside a size like 320x500. */
const LEAK = /YouTube|Lofi|Google Chrome|Chrome_WidgetWin|el_77|(?<![\w@,.])500(?![\w@,])/;

function noLeak(text) {
    assert.equal(LEAK.test(text), false, `leaked the private window:\n${text}`);
}

/** The fake desktop plus the video, which fakeHelper leaves unshared. */
function withVideo(v = video) {
    const desktop = fakeDesktop();
    desktop.windows.push(v);
    return desktop;
}

async function eventually(cond, ms = 3000) {
    const started = Date.now();
    while (!cond()) {
        if (Date.now() - started > ms) throw new Error('condition never held');
        await new Promise(r => setTimeout(r, 5));
    }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function pending(name, args) {
    const result = call(name, args);
    await eventually(() => currentStep() !== null);
    return { result, step: currentStep() };
}

const click = (x, y) => ({ displayId: '1', physical: { x, y }, dip: { x, y }, normalized: { x: 0, y: 0 } });
const saved = { ref: 'el_5', name: 'Saved', role: 'text', rect: rect(0, 0, 10, 10), enabled: true };
const save = { ref: 'el_1', name: 'Save', role: 'button', automation_id: 'SaveBtn', rect: rect(150, 150, 80, 24), enabled: true };
const finder = extra => p => (p.name === 'Save' ? [save] : extra(p));
const watched = { window: 'Notepad', name: 'Save', prompt: 'Click Save', until: { condition: 'appears', name: 'Saved' }, timeoutMs: 60000 };
const shapes = [{ type: 'circle' }];

/**
 * Ask for the video (`query`) and for something not open (`missing`), the
 * same way. The answers must be the same once the agent's own words are
 * taken out, and both must be decided on window listings alone, the same
 * number of them: nothing is asked of the video itself.
 */
async function sameAsMissing(calls, tool, argsFor, query, missing) {
    const ask = async q => {
        const n = calls.length;
        const r = await call(tool, argsFor(q));
        return { isError: r.isError, text: r.text.split(q).join('<query>'), ops: calls.slice(n).map(c => c.op) };
    };
    const asked = await ask(query);
    const absent = await ask(missing);
    noLeak(asked.text);
    assert.equal(asked.isError, true, asked.text);
    assert.deepEqual(asked, absent);
    assert.ok(asked.ops.every(op => op === 'list_windows'), asked.ops.join(','));
    return asked.text;
}

// --- naming the private window ------------------------------------------------

test('drawing on the private window by title or ref is refused like a missing window; "foreground" never means it', async () => {
    const desktop = withVideo({ ...video, foreground: true });
    desktop.windows[0].foreground = false;
    const { calls } = fakeHelper({}, desktop);
    const text = await sameAsMissing(calls, 'annotate', q => ({ anchor: { window: q }, shapes }), 'YouTube', 'Zzzqq');
    assert.match(text, /no shared window matches "<query>"\. Shared: 100 "Untitled - Notepad", 200 "Calculator"/);
    assert.match(text, /list_windows with ask:/);
    await sameAsMissing(calls, 'annotate', q => ({ anchor: { window: q }, shapes }), '500', '987654');
    await sameAsMissing(calls, 'annotate', q => ({ anchor: { ref: q }, shapes }), '500', '987654');
    await sameAsMissing(calls, 'annotate', q => ({ anchor: { window: q, name: 'Save' }, shapes }), 'Lofi', 'Zzzqq');

    assert.equal(store.list().length, 0, 'nothing was drawn');

    // The video is in front: "foreground" is not it. It is the frontmost
    // shared window, as in the reading tools, and reads exactly as it does
    // with Notepad in front: refusing it would say a private window is.
    const front = await call('annotate', { anchor: { window: 'foreground' }, shapes });
    noLeak(front.text);
    assert.match(front.text, /^Drew ann_\d+ on window 100 "Untitled - Notepad"/);
    desktop.windows[0].foreground = true;
    desktop.windows.find(w => w.ref === video.ref).foreground = false;
    const notepad = await call('annotate', { anchor: { window: 'foreground' }, shapes });
    assert.equal(front.text.replace(/ann_\d+/g, 'ann_N'), notepad.text.replace(/ann_\d+/g, 'ann_N'));
    assert.equal(calls.some(c => c.params?.window === '500' || c.params?.refs?.includes('500')), false);
});

test('a step in the private window, or waiting on it, is refused like a missing window', async () => {
    const { calls } = fakeHelper({}, withVideo());
    const step = q => ({ window: q, name: 'Save', prompt: 'Click Save', timeoutMs: 1000 });
    await sameAsMissing(calls, 'highlight_and_wait', step, 'YouTube', 'Zzzqq');
    await sameAsMissing(calls, 'highlight_and_wait', step, '500', '987654');
    const until = q => ({ ...watched, until: { condition: 'appears', name: 'Saved', window: q } });
    const a = await call('highlight_and_wait', until('YouTube'));
    const b = await call('highlight_and_wait', until('Zzzqq'));
    // The refusal echoes the agent's own word for it, which tells it nothing.
    const asked = a.text.split('YouTube').join('<query>');
    noLeak(asked);
    assert.equal(a.isError, true);
    assert.equal(asked, b.text.split('Zzzqq').join('<query>'));
    const wait = q => ({ condition: 'appears', name: 'Saved', window: q, timeoutMs: 0 });
    await sameAsMissing(calls, 'wait_for_element', wait, 'YouTube', 'Zzzqq');
    await sameAsMissing(calls, 'wait_for_element', wait, '500', '987654');
});

test('focus_window and scroll_window refuse the private window without touching it', async () => {
    const { calls } = fakeHelper({}, withVideo());
    await sameAsMissing(calls, 'focus_window', q => ({ window: q }), 'YouTube', 'Zzzqq');
    await sameAsMissing(calls, 'focus_window', q => ({ window: q }), '500', '987654');
    await sameAsMissing(calls, 'scroll_window', q => ({ window: q, notches: -3 }), 'Lofi', 'Zzzqq');
    await sameAsMissing(calls, 'scroll_window', q => ({ window: q, name: 'Comments' }), '500', '987654');
    assert.equal(calls.some(c => ['focus_window', 'scroll_window', 'scroll_into_view'].includes(c.op)), false);
});

// --- waits that would learn of it ---------------------------------------------

test('a window wait answers the same for the private window as for no window at all', async () => {
    fakeHelper({}, withVideo());
    for (const condition of ['appears', 'disappears', 'enabled', 'changes']) {
        const ask = async q => {
            const r = await call('wait_for_element', { condition, role: 'window', name: q, timeoutMs: 0 });
            return { isError: r.isError, text: r.text.split(q).join('<query>') };
        };
        const a = await ask('YouTube');
        noLeak(a.text);
        assert.deepEqual(a, await ask('Zzzqq'), condition);
    }
});

test('a wait with no window searches the shared windows only', async () => {
    const lofi = { ref: 'el_77', name: 'Lofi beats to study to', role: 'link', rect: rect(1500, 200, 200, 20), enabled: true };
    const { calls } = fakeHelper(
        // As the desktop-wide search used to: the video's controls come back.
        { find_elements: p => (p.window === undefined || p.window === '500' ? [lofi] : []) },
        withVideo()
    );
    const { text } = await call('wait_for_element', { condition: 'appears', name: 'Lofi', timeoutMs: 0 });
    noLeak(text);
    assert.match(text, /^NOT met/);
    const searched = calls.filter(c => c.op === 'find_elements').map(c => c.params.window);
    assert.deepEqual(searched, ['100', '200'], 'Notepad and Calculator; not minimised windows, not the video');
});

/**
 * The fake desktop, whose window list becomes `later(windows)` once `change()`
 * is called: the user doing something while a step is up.
 */
function changingDesktop(start, later, overrides = {}) {
    const desktop = fakeDesktop();
    desktop.windows.push(...start);
    let changed = false;
    fakeHelper(
        { find_elements: finder(() => []), list_windows: () => (changed ? later(desktop.windows) : desktop.windows), ...overrides },
        desktop
    );
    return () => {
        changed = true;
    };
}

test('the user switching to the private window leaves no Foreground line', async () => {
    const toVideo = changingDesktop([video], windows => windows.map(w => ({ ...w, foreground: w.ref === video.ref })));
    const { result } = await pending('highlight_and_wait', watched);
    toVideo();
    answerStep({ kind: 'done' });
    const { text } = await result;
    noLeak(text);
    assert.match(text, /^DONE after/);
    assert.equal(/Foreground/.test(text), false, text);
    // Nothing shared opened or closed, and that is all that is said.
    assert.match(text, /Nothing changed: the user may still be working/);

    // The same switch to a shared window is reported.
    const toCalculator = changingDesktop([video], windows => windows.map(w => ({ ...w, foreground: w.ref === '200' })));
    const other = await pending('highlight_and_wait', watched);
    toCalculator();
    answerStep({ kind: 'done' });
    assert.match((await other.result).text, /\nForeground: "Calculator"\./);
});

/** The video opening in front of Notepad. */
const videoOpens = windows => [{ ...windows[0], foreground: false }, ...windows.slice(1), { ...video, foreground: true }];

test('the private window opening during a step meets nothing and is not mentioned', async () => {
    for (const until of [{ condition: 'changes' }, { condition: 'appears', role: 'window' }, { condition: 'changes', role: 'window' }]) {
        const open = changingDesktop([], videoOpens);
        const { result } = await pending('highlight_and_wait', { ...watched, until, timeoutMs: 2500 });
        open();
        const { text } = await result;
        noLeak(text);
        assert.match(text, /^NOT met/, JSON.stringify(until));
        assert.equal(/A new window|\+ window|After:|Since the step began/.test(text), false, text);
        // The same words as when nothing at all happened.
        assert.match(text, /\n(No window opened or closed|Nothing changed): the user may still be working/);
    }

    const open = changingDesktop([], videoOpens);
    const waiting = call('wait_for_element', { condition: 'changes', timeoutMs: 2000 });
    await sleep(300);
    open();
    const { text } = await waiting;
    noLeak(text);
    assert.match(text, /^NOT met: "changes" did not happen/);
});

test('a second, unshared window of the step app does not meet "changes" either', async () => {
    // Same process as Notepad, owned by nothing: another window of the app, not its dialog.
    const sibling = { ...video, pid: 11, exe: 'notepad.exe' };
    const open = changingDesktop([], windows => [...windows, sibling]);
    const { result } = await pending('highlight_and_wait', { ...watched, until: { condition: 'changes' }, timeoutMs: 2500 });
    open();
    const { text } = await result;
    noLeak(text);
    assert.match(text, /^NOT met: "changes" did not happen/);
});

// --- plans ----------------------------------------------------------------------

test('a plan never moves into the private window, even one of the same app in front', async () => {
    // A shared Docs window of Chrome, its Print dialog, and the video: all chrome.exe.
    const docs = { ...video, ref: '510', title: 'Quarterly report - Docs', rect: rect(100, 100, 800, 600), private: false };
    const print = { ...docs, ref: '520', title: 'Print', owner: '510', foreground: true };
    const ok = { ref: 'el_40', name: 'OK', role: 'button', rect: rect(400, 400, 60, 24), enabled: true };
    let closed = false;
    let okFinds = 0;
    let savedFinds = 0;
    const { calls } = fakeHelper(
        {
            list_windows: () =>
                // The dialog closes and the user goes to the video, in front of Docs.
                closed ? [{ ...video, foreground: true }, docs] : [print, docs, video],
            find_elements: p => {
                if (p.window === '520' && closed) throw new Error("no window for ref '520': element not found");
                if (p.name === 'OK') {
                    if (++okFinds > 3) closed = true;
                    return closed ? [] : [ok];
                }
                if (p.name === 'Save') return [save];
                if (p.name === 'Saved') return ++savedFinds > 2 ? [saved] : [];
                return [];
            }
        },
        { ...fakeDesktop(), windows: [print, docs, video] }
    );
    const { text, isError } = await call('highlight_and_wait', {
        window: 'Print',
        name: 'OK',
        prompt: 'Click OK',
        until: { condition: 'disappears', name: 'OK' },
        then: [{ name: 'Save', prompt: 'Click Save', until: { condition: 'appears', name: 'Saved' } }],
        timeoutMs: 8000
    });
    assert.equal(isError, false, text);
    noLeak(text);
    assert.match(text, /\nStep 2\/2: Met: "appears"/);
    const saves = calls.filter(c => c.op === 'find_elements' && c.params.name === 'Save');
    assert.ok(saves.length > 0 && saves.every(c => c.params.window === '510'), JSON.stringify(saves));
    assert.equal(calls.some(c => c.params?.window === '500'), false, 'nothing was asked of the video');
});

test('a plan whose next window stopped being shared stops there, without naming it', async () => {
    // Step 1 runs in Calculator and settles in Notepad's Find dialog; the user
    // stops sharing Notepad, and so its dialog, as the step is met.
    const find = { ...fakeDesktop().windows[0], ref: '600', title: 'Find', owner: '100', foreground: true };
    const desktop = withVideo();
    let finds = 0;
    const { calls } = fakeHelper(
        { find_elements: p => (p.name === 'Find what' ? (++finds > 1 ? [{ ...save, name: 'Find what', role: 'edit' }] : []) : p.name === 'Save' ? [save] : []) },
        desktop
    );
    // Opened after the user shared Notepad: shared only through its owner.
    desktop.windows.push(find);
    const stopOnTick = () => {
        if (store.list().some(a => a.type === 'done')) stopSharingWindow('100');
    };
    store.on('annotations', stopOnTick);
    const { text } = await call('highlight_and_wait', {
        window: 'Calculator',
        name: 'Save',
        prompt: 'Open Find',
        until: { condition: 'appears', name: 'Find what', window: 'Find' },
        then: [{ name: 'Save', prompt: 'Click Save', until: { condition: 'appears', name: 'Saved' } }],
        timeoutMs: 5000
    });
    store.off('annotations', stopOnTick);
    noLeak(text);
    assert.match(text, /^Step 1\/2: Met/);
    assert.match(text, /\nStep 2\/2: could not start: the window it would run in is not shared \(or has closed\); list_windows with ask/);
    assert.equal(/600|Find"/.test(text.split('\n').slice(1).join('\n')), false, text);
    const n = calls.findIndex(c => c.op === 'find_elements' && c.params.name === 'Save' && c.params.window === '600');
    assert.equal(n, -1, 'step 2 did not search the unshared dialog');
});

// --- clicks ------------------------------------------------------------------------

/** element_at_point that names the video's controls, as the helper did before it refused them. */
const videoHit = p =>
    p.x >= 1400 && p.x <= 1880 && p.y >= 100 && p.y <= 460
        ? {
              element: { ref: 'el_77', name: 'Lofi beats to study to', role: 'link', rect: rect(1500, 200, 200, 20), enabled: true },
              window: { ref: '500', title: video.title }
          }
        : p.x > 2000
          ? { element: null, window: null }
          : { element: null, window: { ref: '100', title: 'Untitled - Notepad' } };

test('a click on the private window is a point and nothing more', async () => {
    fakeHelper({ element_at_point: videoHit }, withVideo());
    const { result } = await pending('wait_for_user_click', { prompt: 'Point at it', count: 2 });
    addClick(click(1500, 200));
    // The bare desktop, for comparison.
    addClick(click(2100, 200));
    const { text } = await result;
    noLeak(text);
    const [, first, second] = text.split('\n');
    assert.match(first, /^1\. display 1: physical 1500,200, normalized 0,0 -> outside the shared windows$/);
    assert.equal(second.replace(/^2\. .* -> /, ''), first.replace(/^1\. .* -> /, ''), 'the same as the desktop');

    // The control the helper named there is not the agent's to anchor to: it
    // is answered like a ref never handed out.
    const ask = async q => {
        const r = await call('annotate', { anchor: { ref: q }, shapes });
        return { isError: r.isError, text: r.text.split(q).join('<ref>') };
    };
    const a = await ask('el_77');
    assert.equal(a.isError, true);
    assert.deepEqual(a, await ask('el_99999'));
});

test('a click-mode step clicked on the private window names nothing', async () => {
    fakeHelper({ element_at_point: videoHit }, withVideo());
    const { result } = await pending('highlight_and_wait', { window: 'Notepad', name: 'Save', prompt: 'Click Save', timeoutMs: 60000 });
    addClick(click(1500, 200));
    const { text } = await result;
    noLeak(text);
    assert.match(text, /^The user clicked OUTSIDE the target, at 1500,200 on display 1, outside the shared windows, /);
});

// --- covers ----------------------------------------------------------------------

test('a target covered by the private window says "another window", on screen too', async () => {
    fakeHelper(
        { find_elements: finder(() => [saved]), covered: () => ({ fraction: 0.85, centre_covered: true, by: [video.title] }) },
        withVideo()
    );
    const drawn = await call('annotate', { anchor: { window: 'Notepad', name: 'Save' }, shapes });
    noLeak(drawn.text);
    assert.match(drawn.text, /WARNING: "Save" \[button\] el_1 is behind another window, so the user cannot see it/);
    // The overlay draws this caption, where a screen capture could read it.
    assert.equal(store.list()[0].covered, 'another window');

    const window = await call('annotate', { anchor: { window: 'Notepad' }, shapes: [{ type: 'box' }] });
    noLeak(window.text);
    assert.equal(store.list()[0].covered, 'another window');

    const step = await call('highlight_and_wait', { ...watched, until: { condition: 'disappears', name: 'Saved' }, timeoutMs: 1000 });
    noLeak(step.text);
    assert.match(step.text, /is behind another window;/);
    assert.equal(/\d+%|mostly|partly|almost/.test(step.text), false, step.text);
});

test('a click where the target is, under the private window, does not name it', async () => {
    fakeHelper(
        { covered: p => (p.rect ? { fraction: 0.6, centre_covered: true, by: [video.title] } : { fraction: 0, centre_covered: false, by: [] }) },
        withVideo()
    );
    const { result } = await pending('highlight_and_wait', { window: 'Notepad', name: 'Save', prompt: 'Click Save', timeoutMs: 60000 });
    addClick(click(160, 160));
    const { text } = await result;
    noLeak(text);
    assert.match(text, /but it was covered by another window, so/);
});

// --- the user stops sharing --------------------------------------------------------

test('drawings and readings of a window go when the user stops sharing it', async () => {
    fakeHelper({}, withVideo());
    await call('annotate', { anchor: { window: 'Notepad', name: 'Save' }, shapes });
    await call('annotate', { anchor: { window: 'Calculator' }, shapes: [{ type: 'box' }], replace: false });
    store.recordSnapshot({ id: 'snap_notepad', windowRef: '100', at: Date.now(), nodes: [] });
    store.recordSnapshot({ id: 'snap_calc', windowRef: '200', at: Date.now(), nodes: [] });
    assert.equal(store.list().length, 2);
    stopSharingWindow('100');
    await eventually(() => store.list().length === 1);
    assert.equal(store.list()[0].anchor.ref, '200', "Calculator's drawing stays");
    assert.equal(store.snapshot('snap_notepad'), undefined);
    assert.ok(store.snapshot('snap_calc'));
});

test('a step ends when the user stops sharing its window, saying only that', async () => {
    fakeHelper({}, withVideo());
    const clicked = await pending('highlight_and_wait', { window: 'Notepad', name: 'Save', prompt: 'Click Save', timeoutMs: 60000 });
    stopSharingWindow('100');
    const { text, isError } = await clicked.result;
    assert.equal(isError, false);
    assert.match(text, /^NOT done: the user stopped sharing the window this step was in, so the step ended\./);
    assert.equal(/Notepad|Circled|clicked/.test(text), false, text);

    fakeHelper({ find_elements: finder(() => []) }, withVideo());
    const watching = await pending('highlight_and_wait', watched);
    stopSharingWindow('100');
    assert.match((await watching.result).text, /^NOT done: the user stopped sharing the window this step was in/);
});

test('a wait on a window ends when the user stops sharing it', async () => {
    let probes = 0;
    fakeHelper({ find_elements: () => (++probes === 2 && stopSharingWindow('100'), []) }, withVideo());
    const { text } = await call('wait_for_element', { condition: 'appears', name: 'Saved', window: 'Notepad', timeoutMs: 60000 });
    assert.match(text, /^NOT met yet: the user stopped sharing the window it was watching\./);
});

test("progress messages carry only the agent's own words", async () => {
    fakeHelper({ find_elements: finder(() => []) }, withVideo({ ...video, foreground: true }));
    const client = await connect();
    const seen = [];
    const result = client.callTool({ name: 'highlight_and_wait', arguments: watched }, undefined, {
        onprogress: p => seen.push(p),
        resetTimeoutOnProgress: true
    });
    await eventually(() => currentStep() !== null && seen.length > 0);
    answerStep({ kind: 'skip' });
    await result;
    await client.close();
    for (const p of seen) noLeak(p.message ?? '');
});
