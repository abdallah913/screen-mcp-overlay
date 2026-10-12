import test from 'node:test';
import assert from 'node:assert/strict';
import { call, fakeDesktop, fakeHelper, harness, rect } from './support/fake-helper.mjs';

/*
 * What the guidance tools could still tell an agent about windows it may not
 * see (src/main/mcp/tools/guide.ts, anchoring.ts, common.ts, waits.ts), each
 * found by trying it:
 *
 * - A walkthrough step or a wait answered in its own words after the user
 *   stopped sharing something during it, and what it read after its last
 *   look at the shares (an unscoped wait's search, the After block, the
 *   digest, a STUCK's look at the target, a click's verdict) went back with
 *   them. Now any such call answers in the one fixed sentence.
 * - Whether a target was "behind another window" followed a private window
 *   as the user moved it, so asking about one control after another mapped
 *   where it was, and a click on that window inside a shared one read as
 *   "outside the shared windows". Now a private window anywhere on top reads
 *   as nothing on top, in the same words and helper round trips; the user
 *   still sees the overlay's note.
 * - What a step said about the window in front (a Foreground line, a
 *   [foreground] mark, where a plan went next) was there only while the user
 *   was in a shared window, and so was a control's "focused" state, which
 *   also met a wait on value "focused". Now nothing depends on either.
 */

const { store, answerStep, addClick, cancelStep, currentStep, stopSharingWindow } = harness;

test.beforeEach(() => store.clear());
test.afterEach(() => cancelStep('clear'));

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function eventually(cond, ms = 3000) {
    const started = Date.now();
    while (!cond()) {
        if (Date.now() - started > ms) throw new Error('condition never held');
        await sleep(5);
    }
}

/** What any call hears when the user stopped sharing something while it ran (common.ts). */
const STOPPED =
    'The user stopped sharing a window while this ran, so nothing from it is returned. list_windows shows what is shared now.';

const flags = { minimized: false, cloaked: false, elevated: false, hung: false };
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
const save = { ref: 'el_1', name: 'Save', role: 'button', automation_id: 'SaveBtn', rect: rect(150, 150, 80, 24), enabled: true };
const saved = { ref: 'el_5', name: 'Saved', role: 'text', rect: rect(0, 0, 10, 10), enabled: true };
const secret = { ref: 'el_99', name: 'my bank PIN is 1234', role: 'text', rect: rect(120, 400, 300, 20), enabled: true };
const click = (x, y) => ({ displayId: '1', physical: { x, y }, dip: { x, y }, normalized: { x: 0, y: 0 } });
const watched = { window: 'Notepad', name: 'Save', prompt: 'Click Save', until: { condition: 'appears', name: 'Saved' }, timeoutMs: 60000 };

/** Times, check counts and ids depend on scheduling and on earlier tests, not on what the user did. */
const steady = t =>
    t
        .replace(/\(\d+ checks\)/g, '(N checks)')
        .replace(/\d+(\.\d+)?s\b/g, 'Ts')
        .replace(/\b(ann|snap)_\d+/g, '$1_N');

/** Notepad's tree before the user acts, and after: its editor now holds the secret. */
const before = [
    { depth: 0, ref: 'el_10', name: 'Untitled - Notepad', role: 'window', enabled: true, rect: rect(100, 100, 800, 600) },
    { depth: 2, ref: 'el_11', name: 'Save', role: 'button', enabled: true, rect: rect(150, 150, 80, 24) },
    { depth: 2, ref: 'el_13', name: 'Text editor', role: 'edit', value: 'hello', enabled: true, rect: rect(100, 180, 800, 500) }
];
const after = [before[0], before[1], { ...before[2], value: 'my bank PIN is 1234' }];

/**
 * Every snapshot recorded, whatever its id looks like: one taken of a window
 * as the user took it back must never be kept, even for a moment, since
 * describe_window since= replays it to whoever holds its id.
 */
const recorded = [];
const recordSnapshot = store.recordSnapshot.bind(store);
store.recordSnapshot = snap => {
    recorded.push(snap);
    return recordSnapshot(snap);
};

/** Whether any snapshot recorded since `from` carries the secret. */
const snapshotsHoldSecret = (from = 0) => recorded.slice(from).some(s => JSON.stringify(s.nodes).includes('PIN'));

// --- a share ending during a call ---------------------------------------------------

test('an unscoped wait whose search races the user unsharing a window returns nothing it read', async () => {
    const racing = () =>
        fakeHelper({
            find_elements: p => {
                if (p.window !== '100') return [];
                stopSharingWindow('100', { byUser: true });
                return [secret];
            }
        });
    for (const args of [
        { condition: 'appears', name: 'PIN', timeoutMs: 0 },
        { condition: 'appears', name: 'PIN', timeoutMs: 5000 },
        { condition: 'appears', name: 'PIN', window: 'Notepad', timeoutMs: 0 }
    ]) {
        racing();
        const r = await call('wait_for_element', args);
        assert.equal(r.isError, true, JSON.stringify(args));
        assert.equal(r.text, `wait_for_element: ${STOPPED}`, JSON.stringify(args));
    }
});

test('a met step whose After block races the unshare returns nothing, and keeps no snapshot of it', async () => {
    let phase = 'start';
    fakeHelper({
        find_elements: p => (p.name === 'Save' ? [save] : phase === 'met' && p.name === 'Saved' ? [saved] : []),
        describe: () => {
            if (phase !== 'met') return { nodes: before, truncated: false };
            // The After block's read: the user stops sharing as it runs.
            stopSharingWindow('100', { byUser: true });
            return { nodes: after, truncated: false };
        }
    });
    const from = recorded.length;
    const pending = call('highlight_and_wait', watched);
    await eventually(() => currentStep() !== null);
    phase = 'met';
    const r = await pending;
    assert.equal(r.text, `highlight_and_wait: ${STOPPED}`);
    // Recorded, it would outlive the share: describe_window since= reads it back.
    assert.equal(snapshotsHoldSecret(from), false, 'a snapshot of the unshared window was kept');
});

test('a DONE step whose digest races the unshare returns nothing', async () => {
    let phase = 'start';
    fakeHelper({
        find_elements: p => (p.name === 'Save' ? [save] : []),
        describe: () => {
            if (phase !== 'digest') return { nodes: before, truncated: false };
            stopSharingWindow('100', { byUser: true });
            return { nodes: after, truncated: false };
        }
    });
    const from = recorded.length;
    const pending = call('highlight_and_wait', watched);
    await eventually(() => currentStep() !== null);
    await sleep(100);
    phase = 'digest';
    answerStep({ kind: 'done' });
    assert.equal((await pending).text, `highlight_and_wait: ${STOPPED}`);
    assert.equal(snapshotsHoldSecret(from), false);
});

/** Notepad's dialog, shared with it; reading its controls races the user unsharing Notepad. */
function dialogRace() {
    const desktop = fakeDesktop();
    const dialog = { ...desktop.windows[0], ref: '600', title: 'Export As', owner: '100', rect: rect(300, 200, 400, 300) };
    let lists = 0;
    fakeHelper(
        {
            find_elements: p => (p.name === 'Save' ? [save] : []),
            list_windows: () => (++lists > 3 ? [dialog, ...desktop.windows] : desktop.windows),
            describe: p => {
                if (p.window !== '600') return { nodes: before, truncated: false };
                stopSharingWindow('100', { byUser: true });
                return { nodes: [{ ...before[0], ref: 'el_60', name: 'Export As' }, { ...secret, depth: 2, role: 'edit', value: 'PIN' }], truncated: false };
            }
        },
        desktop
    );
}

test("a dialog's controls read as the user unshares its window return nothing, and keep no snapshot", async () => {
    const from = recorded.length;
    dialogRace();
    const step = await call('highlight_and_wait', { ...watched, until: { condition: 'appears', role: 'window' }, timeoutMs: 5000 });
    assert.equal(step.text, `highlight_and_wait: ${STOPPED}`);
    dialogRace();
    const wait = await call('wait_for_element', { condition: 'appears', role: 'window', name: 'Export', timeoutMs: 5000 });
    assert.equal(wait.text, `wait_for_element: ${STOPPED}`);
    assert.equal(snapshotsHoldSecret(from), false);
});

test('a STUCK step whose look at the target races the unshare returns nothing', async () => {
    let stuck = false;
    fakeHelper({
        find_elements: p => (p.name === 'Save' ? [save] : []),
        // The step's look at what covers the target reads the z-order.
        zorder: () => {
            if (stuck) stopSharingWindow('100', { byUser: true });
            return [];
        }
    });
    const pending = call('highlight_and_wait', watched);
    await eventually(() => currentStep() !== null);
    stuck = true;
    answerStep({ kind: 'stuck', text: 'cannot see it' });
    assert.equal((await pending).text, `highlight_and_wait: ${STOPPED}`);
});

test("a click's verdict that races the unshare returns nothing", async () => {
    fakeHelper({
        element_at_point: () => {
            stopSharingWindow('100', { byUser: true });
            return { element: secret, window: { ref: '100', title: 'Untitled - Notepad' } };
        }
    });
    const pending = call('highlight_and_wait', { window: 'Notepad', name: 'Save', prompt: 'Click Save', timeoutMs: 60000 });
    await eventually(() => currentStep() !== null);
    addClick(click(300, 410));
    assert.equal((await pending).text, `highlight_and_wait: ${STOPPED}`);
});

test('the user ending another share ends a step or a wait at once, with nothing of it', async () => {
    // Calculator is shared alongside Notepad; the user stops sharing it
    // while a step in Notepad is up, and while an unscoped wait runs.
    fakeHelper({ find_elements: p => (p.name === 'Save' ? [save] : []) });
    let started = Date.now();
    const step = call('highlight_and_wait', { ...watched, timeoutMs: 4000 });
    await eventually(() => currentStep() !== null);
    stopSharingWindow('200', { byUser: true });
    assert.equal((await step).text, `highlight_and_wait: ${STOPPED}`);
    assert.ok(Date.now() - started < 2500, 'the step did not run on to its timeout');
    assert.equal(currentStep(), null, 'and is gone from the screen');

    fakeHelper({ find_elements: () => [] });
    started = Date.now();
    const wait = call('wait_for_element', { condition: 'appears', name: 'Saved', timeoutMs: 4000 });
    await sleep(300);
    stopSharingWindow('200', { byUser: true });
    assert.equal((await wait).text, `wait_for_element: ${STOPPED}`);
    assert.ok(Date.now() - started < 2500, 'the wait did not run on to its timeout');

    // Asking the user to point at something: the prompt goes at once too.
    fakeHelper();
    started = Date.now();
    const point = call('wait_for_user_click', { prompt: 'Point at it', timeoutMs: 4000 });
    await eventually(() => currentStep() !== null);
    stopSharingWindow('200', { byUser: true });
    assert.equal((await point).text, `wait_for_user_click: ${STOPPED}`);
    assert.ok(Date.now() - started < 2500, 'the prompt did not stay up to its timeout');
    assert.equal(currentStep(), null, 'and is gone from the screen');
});

// --- a private window over a shared target -------------------------------------------

/**
 * The fake desktop with the video at `videoRect`, in front of everything.
 * "covered" answers as the helper does (winops.rs covered: the centre test,
 * the fraction, the cover named "another window" when it is not shared), and
 * element_at_point names the topmost window at the point, as the helper does.
 */
function videoAt(videoRect) {
    const desktop = fakeDesktop();
    desktop.windows.unshift({ ...video, rect: videoRect });
    const inside = (r, x, y) => x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height;
    const covered = p => {
        const t = p.rect ?? desktop.windows.find(w => w.ref === p.window).rect;
        const ix = Math.max(0, Math.min(t.x + t.width, videoRect.x + videoRect.width) - Math.max(t.x, videoRect.x));
        const iy = Math.max(0, Math.min(t.y + t.height, videoRect.y + videoRect.height) - Math.max(t.y, videoRect.y));
        const fraction = (ix * iy) / (t.width * t.height);
        const centre = inside(videoRect, t.x + t.width / 2, t.y + t.height / 2);
        return { fraction, centre_covered: centre, by: fraction > 0 ? ['another window'] : [] };
    };
    return fakeHelper(
        {
            find_elements: p => (p.name === 'Save' ? [save] : []),
            covered,
            element_at_point: p => {
                const win = desktop.windows.find(w => !w.minimized && inside(w.rect, p.x, p.y));
                const element = win?.ref === '100' && inside(save.rect, p.x, p.y) ? save : null;
                return { element, window: win ? { ref: win.ref, title: win.title } : null };
            }
        },
        desktop
    ).calls;
}

/**
 * The helper ops a run asked for, in order: what its timing is made of. A
 * run of the same op counts once: how many polls fit in a step depends on
 * scheduling, not on what is on screen.
 */
const opsOf = calls =>
    calls
        .filter(c => c.op !== 'set_shared')
        .map(c => c.op)
        .filter((op, i, all) => op !== all[i - 1])
        .join(' ');

/** Everything the agent hears about Save while the video is at `videoRect`, and the helper ops it took. */
async function aboutSave(videoRect) {
    const calls = videoAt(videoRect);
    const control = await call('annotate', { anchor: { window: 'Notepad', name: 'Save' }, shapes: [{ type: 'circle' }] });
    const window = await call('annotate', { anchor: { window: 'Notepad' }, shapes: [{ type: 'box' }] });
    store.clear();
    const clicked = call('highlight_and_wait', { window: 'Notepad', name: 'Save', prompt: 'Click Save', timeoutMs: 60000 });
    await eventually(() => currentStep() !== null);
    addClick(click(160, 160));
    const step = await clicked;
    const stuck = call('highlight_and_wait', { ...watched, until: { condition: 'appears', name: 'Nothing' } });
    await eventually(() => currentStep() !== null);
    answerStep({ kind: 'stuck', text: 'cannot see it' });
    const said = [control.text, window.text, step.text, (await stuck).text].map(steady).join('\n---\n');
    return `${said}\n---\n${opsOf(calls)}`;
}

test('a private window over a shared target reads as nothing on top, wherever the user moves it', async () => {
    // The same words, and the same helper round trips.
    const away = await aboutSave(rect(1400, 100, 480, 360));
    assert.match(away, /The user clicked the target \(160,160 on display 1\)\./);
    assert.match(away, /The circled control is visible and uncovered/);
    for (const [where, r] of Object.entries({
        'over its centre': rect(140, 140, 120, 60),
        'grazing it': rect(200, 140, 120, 60),
        'over all of Notepad': rect(50, 50, 1000, 800)
    })) {
        assert.equal(await aboutSave(r), away, `video ${where}`);
    }
});

/** What wait_for_user_click says of a click at (x, y) while the video is at `videoRect`. */
async function pointAt(videoRect, x, y) {
    const calls = videoAt(videoRect);
    const pending = call('wait_for_user_click', { prompt: 'Point at it', timeoutMs: 5000 });
    await eventually(() => currentStep() !== null);
    addClick(click(x, y));
    const { text } = await pending;
    return { text, ops: opsOf(calls) };
}

test('a click on a private window over a shared one is a click on the shared window, never "outside"', async () => {
    // Notepad's bare background at 500,500: with the video over it or away,
    // the click reads the same.
    const away = await pointAt(rect(1400, 100, 480, 360), 500, 500);
    assert.match(away.text, /-> the window "Untitled - Notepad"$/);
    assert.deepEqual(await pointAt(rect(450, 450, 120, 60), 500, 500), away);
    // On Save, under the video: inside Notepad's listed rect, so not "outside the shared windows".
    const onSave = await pointAt(rect(140, 140, 120, 60), 160, 160);
    assert.match(onSave.text, /-> the window "Untitled - Notepad"$/);
    assert.equal(/outside|YouTube|500/.test(onSave.text.replace(/\d+,\d+/g, '')), false, onSave.text);
    assert.equal(onSave.ops, (await pointAt(rect(1400, 100, 480, 360), 160, 160)).ops, 'the same helper round trips');
    // Outside every shared window it is outside, whatever is there.
    assert.match((await pointAt(rect(1400, 100, 480, 360), 1500, 200)).text, /-> outside the shared windows$/);
    assert.match((await pointAt(rect(1400, 100, 480, 360), 1500, 900)).text, /-> outside the shared windows$/);
});

// --- where the user is -------------------------------------------------------------

/** A desktop with the video, where `front` is in front once `switch()` is called. */
function frontDesk(front, overrides = {}) {
    const desktop = fakeDesktop();
    desktop.windows.push({ ...video });
    let switched = false;
    fakeHelper(
        {
            find_elements: p => (p.name === 'Save' ? [save] : []),
            list_windows: () => (switched ? desktop.windows.map(w => ({ ...w, foreground: w.ref === front })) : desktop.windows),
            ...overrides
        },
        desktop
    );
    return () => (switched = true);
}

test('a step digest reads the same wherever the user is, shared window or not', async () => {
    const digests = [];
    for (const front of ['100', '200', '500']) {
        const go = frontDesk(front);
        const pending = call('highlight_and_wait', watched);
        await eventually(() => currentStep() !== null);
        go();
        answerStep({ kind: 'done' });
        digests.push(steady((await pending).text));
    }
    assert.equal(/Foreground|foreground/.test(digests[0]), false, digests[0]);
    assert.equal(digests[1], digests[0], 'the user in Calculator');
    assert.equal(digests[2], digests[0], 'the user in the video');
});

test('a dialog that opens reads the same whether the user is in it or in a private window', async () => {
    const opened = async userIn => {
        const desktop = fakeDesktop();
        desktop.windows.push({ ...video });
        const dialog = { ...desktop.windows[1], ref: '600', title: 'Export As', owner: '100', foreground: userIn === 'dialog' };
        let lists = 0;
        fakeHelper(
            {
                list_windows: () => {
                    lists += 1;
                    if (lists <= 3) return desktop.windows;
                    return [dialog, ...desktop.windows.map(w => ({ ...w, foreground: userIn === 'video' && w.ref === '500' }))];
                }
            },
            desktop
        );
        const { text } = await call('highlight_and_wait', { ...watched, until: { condition: 'appears', role: 'window' }, timeoutMs: 5000 });
        return steady(text);
    };
    const inDialog = await opened('dialog');
    assert.match(inDialog, /After:\n\+ window 600 "Export As"\n/);
    assert.equal(await opened('video'), inDialog);
});

test('a plan goes on to the frontmost shared window whether the user is in it or in a private one', async () => {
    const eq = { ref: 'el_7', name: 'Equals', role: 'button', rect: rect(1100, 400, 60, 40), enabled: true };
    const run = async front => {
        const desktop = fakeDesktop();
        desktop.windows.push({ ...video });
        let closed = false;
        fakeHelper(
            {
                find_elements: p => (p.name === 'Save' ? [save] : p.name === 'Equals' ? [eq] : []),
                list_windows: () =>
                    closed ? desktop.windows.filter(w => w.ref !== '200').map(w => ({ ...w, foreground: w.ref === front })) : desktop.windows
            },
            desktop
        );
        const pending = call('highlight_and_wait', {
            window: 'Calculator',
            name: 'Equals',
            prompt: 'Close the calculator',
            until: { condition: 'disappears', role: 'window', name: 'Calculator' },
            then: [{ name: 'Save', prompt: 'Now click Save', until: { condition: 'appears', name: 'Saved' } }],
            timeoutMs: 3000
        });
        await eventually(() => currentStep() !== null);
        closed = true;
        return steady((await pending).text);
    };
    const inNotepad = await run('100');
    assert.match(inNotepad, /\nStep 2\/2: NOT met: "appears" did not happen/);
    assert.equal(await run('500'), inNotepad, 'the user in the video');
});

/**
 * Everything a wait or a step says about Notepad's controls, with the user in
 * `userIn`. As the real helper: a search marks the control with focus when
 * the user is in its window, and a describe does so too unless told to read
 * no focus.
 */
async function focusRun(userIn) {
    const desktop = fakeDesktop();
    desktop.windows.push({ ...video });
    for (const w of desktop.windows) w.foreground = w.ref === userIn;
    const focus = n => ({ ...n, state: [n.state, 'focused'].filter(Boolean).join(',') });
    const bold = { ref: 'el_7', name: 'Bold', role: 'checkbox', state: 'unchecked', rect: rect(300, 150, 20, 20), enabled: true };
    const field = { depth: 2, ref: 'el_14', name: 'File name', role: 'edit', value: '', enabled: true, rect: rect(100, 600, 300, 20) };
    const dialog = { ...desktop.windows[0], ref: '600', title: 'Export As', owner: '100', rect: rect(300, 200, 400, 300), foreground: userIn === '600' };
    let met = false;
    let opened = false;
    let lists = 0;
    fakeHelper(
        {
            find_elements: p => {
                if (p.name === 'Save') return [save];
                if (p.name === 'Saved') return met ? [saved] : [];
                if (p.name === 'Bold') return [userIn === '100' ? focus(bold) : bold];
                return [];
            },
            list_windows: () => (opened && ++lists > 3 ? [dialog, ...desktop.windows] : desktop.windows),
            describe: p => {
                const mark = n => (!p.ignore_focus && p.window === userIn && n.role === 'edit' ? focus(n) : n);
                const nodes = p.window === '600' ? [{ ...before[0], ref: 'el_60', name: 'Export As' }, field] : met ? [...before, field] : before;
                return { nodes: nodes.map(mark), truncated: false };
            }
        },
        desktop
    );
    const out = [];
    for (const args of [
        { condition: 'appears', name: 'Bold', window: 'Notepad', timeoutMs: 0 },
        { condition: 'appears', name: 'Bold', value: 'focused', window: 'Notepad', timeoutMs: 0 },
        { condition: 'appears', name: 'Bold', value: 'checked', window: 'Notepad', timeoutMs: 0 },
        { condition: 'disappears', name: 'Bold', window: 'Notepad', timeoutMs: 0 }
    ]) {
        out.push((await call('wait_for_element', args)).text);
    }
    // A step met in Notepad, whose After block lists the field that appeared.
    const step = call('highlight_and_wait', watched);
    await eventually(() => currentStep() !== null);
    met = true;
    out.push((await step).text);
    // A dialog opening, whose controls are listed.
    opened = true;
    out.push((await call('highlight_and_wait', { ...watched, until: { condition: 'appears', role: 'window' }, timeoutMs: 5000 })).text);
    return out.map(steady);
}

test('nothing a wait or a step says depends on which control has focus', async () => {
    const inNotepad = await focusRun('100');
    const inDialog = await focusRun('600');
    const inVideo = await focusRun('500');
    for (const t of inNotepad) assert.doesNotMatch(t, /focused/);
    assert.match(inNotepad[1], /^NOT met/, 'focus never meets value:"focused"');
    assert.match(inNotepad[4], /\+ File name \[edit\]/);
    assert.match(inNotepad[5], /File name \[edit\]/);
    assert.deepEqual(inNotepad, inVideo, 'the user in Notepad reads as the user in the video');
    assert.deepEqual(inDialog, inVideo, 'and so does the user in the dialog');
});
