import test from 'node:test';
import assert from 'node:assert/strict';
import { call, fakeDesktop, fakeHelper, harness, rect } from './support/fake-helper.mjs';

/*
 * A window the user stops sharing reads as not open from that moment on
 * (sharing.ts wasRevoked): no wait, step report, plan or note may say later
 * that it closed, was minimised or is still there. Otherwise a wait started
 * while it was shared, or a step that runs for minutes, tells the agent
 * whether and when a window it was denied closed. The guidance tools also
 * answer "foreground" and refuse a window exactly as the reading tools do,
 * and say how much of a target a private window hides in one fixed phrase.
 */

const { store, answerStep, cancelStep, currentStep, stopSharingWindow, wasRevoked } = harness;

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
const shapes = [{ type: 'circle' }];

/** Check counts, times and ids depend on scheduling and on earlier tests, not on what the user did. */
const steady = t =>
    t
        .replace(/\(\d+ checks\)/g, '(N checks)')
        .replace(/\d+(\.\d+)?s\b/g, 'Ts')
        .replace(/\b(ann|snap)_\d+/g, '$1_N');

/**
 * The fake desktop, with Notepad (100) shared. `close()` takes Notepad out of
 * the window list, as the user closing it; the helper then refuses it the way
 * it refuses any window that is gone.
 */
function closable(overrides = {}) {
    const desktop = fakeDesktop();
    let closed = false;
    const gone = p => closed && (p.window === '100' || p.refs?.includes('100'));
    const { calls } = fakeHelper(
        {
            list_windows: () => (closed ? desktop.windows.filter(w => w.ref !== '100') : desktop.windows),
            find_elements: p => {
                if (gone(p)) throw new Error("no window for ref '100': element not found");
                return overrides.find_elements ? overrides.find_elements(p) : p.name === 'Save' ? [save] : [];
            },
            describe: p => {
                if (gone(p)) throw new Error("no window for ref '100': element not found");
                return { nodes: desktop.tree, truncated: false };
            },
            resolve: p => p.refs.map(r => ({ ref: r, rect: gone({ refs: [r] }) ? null : (desktop.windows.find(w => w.ref === r)?.rect ?? save.rect), reason: gone({ refs: [r] }) ? 'closed' : undefined })),
            ...Object.fromEntries(Object.entries(overrides).filter(([k]) => k !== 'find_elements'))
        },
        desktop
    );
    return { calls, desktop, close: () => (closed = true) };
}

/** Run `go` twice: Notepad unshared and kept open, then unshared and closed. Both answers must read the same. */
async function sameOpenOrClosed(go) {
    const out = [];
    for (const closes of [false, true]) {
        const env = closable();
        out.push(steady(await go(env, closes)));
    }
    assert.equal(out[1], out[0], 'closing a window after it was unshared must not change the answer');
    for (const t of out) assert.equal(/window 100|Untitled - Notepad/.test(t), false, t);
    return out[0];
}

// --- waits ------------------------------------------------------------------------

test('a window "changes" wait is not met by a window closing after the user stopped sharing it', async () => {
    const text = await sameOpenOrClosed(async ({ close }, closes) => {
        const waiting = call('wait_for_element', { condition: 'changes', role: 'window', name: 'Notepad', timeoutMs: 2000 });
        await sleep(400);
        stopSharingWindow('100', { byUser: true });
        await sleep(400);
        if (closes) close();
        return (await waiting).text;
    });
    assert.match(text, /^NOT met: "changes" did not happen/);
});

test('an unselected "changes" wait is not met by a window closing after the user stopped sharing it', async () => {
    const text = await sameOpenOrClosed(async ({ close }, closes) => {
        const waiting = call('wait_for_element', { condition: 'changes', timeoutMs: 2000 });
        await sleep(400);
        stopSharingWindow('100', { byUser: true });
        await sleep(400);
        if (closes) close();
        return (await waiting).text;
    });
    assert.match(text, /^NOT met: "changes" did not happen/);
});

test('unsharing and closing between two checks is not a window closing either', async () => {
    // The close lands before any check sees the window open and unshared.
    const text = await sameOpenOrClosed(async ({ close }, closes) => {
        const waiting = call('wait_for_element', { condition: 'changes', timeoutMs: 1500 });
        await sleep(300);
        if (closes) close();
        stopSharingWindow('100', { byUser: true });
        return (await waiting).text;
    });
    assert.match(text, /^NOT met/);
});

test('a wait on a window the user unshares and closes at once ends as unshared, not as closed', async () => {
    const out = [];
    for (const closes of [false, true]) {
        let probes = 0;
        const env = closable({
            find_elements: () => {
                if (++probes === 2) {
                    // Closed before anything reads the window list again.
                    if (closes) env.close();
                    stopSharingWindow('100', { byUser: true });
                }
                return [save];
            }
        });
        out.push(steady((await call('wait_for_element', { condition: 'disappears', name: 'Save', window: 'Notepad', timeoutMs: 5000 })).text));
    }
    assert.match(out[0], /^NOT met yet: the user stopped sharing the window it was watching\./);
    assert.equal(out[1], out[0]);
});

// --- steps ------------------------------------------------------------------------

test('a step digest does not list a window that closed after the user stopped sharing it', async () => {
    const text = await sameOpenOrClosed(async ({ close }, closes) => {
        const waiting = call('highlight_and_wait', {
            window: 'Calculator',
            prompt: 'do it',
            until: { condition: 'appears', name: 'Nothing here' },
            timeoutMs: 60000
        });
        await eventually(() => currentStep() !== null);
        stopSharingWindow('100', { byUser: true });
        await sleep(200);
        if (closes) close();
        await sleep(200);
        answerStep({ kind: 'done' });
        return (await waiting).text;
    });
    assert.match(text, /^DONE after/);
    assert.equal(/Since the step began/.test(text), false, text);
    assert.match(text, /Nothing changed: the user may still be working/);
});

test('a met "changes" step does not list it in After either', async () => {
    // Calculator's own tree changes and meets the step; Notepad, unshared
    // during it and then closed, is not in what changed.
    const text = await sameOpenOrClosed(async ({ close, desktop }, closes) => {
        const waiting = call('highlight_and_wait', { window: 'Calculator', prompt: 'do it', until: { condition: 'changes' }, timeoutMs: 60000 });
        await eventually(() => currentStep() !== null);
        stopSharingWindow('100', { byUser: true });
        await sleep(200);
        if (closes) close();
        desktop.tree = [...desktop.tree, { depth: 2, ref: 'el_30', name: 'Result', role: 'edit', value: '42', enabled: true, rect: rect(1000, 150, 80, 24) }];
        answerStep({ kind: 'done' });
        return (await waiting).text;
    });
    assert.match(text, /^Met: "changes"/);
});

test('a step whose window the user unshares and closes at once ends as unshared', async () => {
    for (const mode of ['click', 'watch']) {
        await sameOpenOrClosed(async ({ close }, closes) => {
            const args = { window: 'Notepad', name: 'Save', prompt: 'Click Save', timeoutMs: 3000 };
            const waiting = call('highlight_and_wait', mode === 'watch' ? { ...args, until: { condition: 'disappears', name: 'Save' } } : args);
            await eventually(() => currentStep() !== null);
            // Closed before anything reads the window list again.
            if (closes) close();
            stopSharingWindow('100', { byUser: true });
            const { text } = await waiting;
            assert.match(text, /^NOT done: the user stopped sharing the window this step was in/, `${mode}: ${text}`);
            return text;
        });
    }
});

test('a plan stops at a window the user unshared, whether it then closed or not', async () => {
    // Step 1 settles in Notepad's Find dialog. The user stops sharing Notepad
    // (and so its dialog) as the step is met; in one run the dialog closes too
    // and Calculator is in front, where the plan would otherwise carry on.
    const out = [];
    for (const closes of [false, true]) {
        const desktop = fakeDesktop();
        const find = { ...desktop.windows[0], ref: '600', title: 'Find', owner: '100', foreground: true };
        let finds = 0;
        let ended = false;
        const listed = () => {
            const all = [...desktop.windows, find];
            if (!ended || !closes) return all;
            return all.filter(w => w.ref !== '600').map(w => ({ ...w, foreground: w.ref === '200' }));
        };
        fakeHelper(
            {
                list_windows: listed,
                find_elements: p => (p.name === 'Find what' ? (++finds > 1 ? [{ ...save, name: 'Find what', role: 'edit' }] : []) : p.name === 'Save' ? [save] : [])
            },
            // Opened after the user shared Notepad: shared only through its owner.
            desktop
        );
        const onTick = () => {
            if (!ended && store.list().some(a => a.type === 'done')) {
                ended = true;
                stopSharingWindow('100', { byUser: true });
            }
        };
        store.on('annotations', onTick);
        const { text } = await call('highlight_and_wait', {
            window: 'Calculator',
            name: 'Save',
            prompt: 'Open Find',
            until: { condition: 'appears', name: 'Find what', window: 'Find' },
            then: [{ name: 'Save', prompt: 'Click Save', until: { condition: 'appears', name: 'Saved' } }],
            timeoutMs: 3000
        });
        store.off('annotations', onTick);
        out.push(steady(text));
    }
    assert.match(out[0], /\nStep 2\/2: could not start: the window it would run in is not shared \(or has closed\)/);
    assert.equal(out[1], out[0]);
});

// --- drawings ---------------------------------------------------------------------

test('drawings and readings of a window go when the user unshares and closes it at once', async () => {
    const { close } = closable();
    await call('annotate', { anchor: { window: 'Notepad', name: 'Save' }, shapes });
    await call('annotate', { anchor: { window: 'Calculator' }, shapes: [{ type: 'box' }], replace: false });
    store.recordSnapshot({ id: 'snap_notepad', windowRef: '100', at: Date.now(), nodes: [] });
    assert.equal(store.list().length, 2);
    close();
    stopSharingWindow('100', { byUser: true });
    assert.ok(wasRevoked('100'));
    // Kept, the tracker would hide Notepad's circle as "its window was closed".
    await eventually(() => store.list().length === 1);
    assert.equal(store.list()[0].anchor.ref, '200');
    assert.equal(store.snapshot('snap_notepad'), undefined);
});

// --- "foreground" and refusals ------------------------------------------------------

/** Ids and refs a drawing call hands out differ between runs; nothing else may. */
const same = t => steady(t.replace(/ann_\d+/g, 'ann_N'));

test('"foreground" is the frontmost shared window here as in the reading tools, whatever is really in front', async () => {
    const run = async inFront => {
        const desktop = fakeDesktop();
        desktop.windows.push({ ...video, foreground: inFront === 'video' });
        desktop.windows[0].foreground = inFront === 'notepad';
        fakeHelper({ find_elements: p => (p.name === 'Save' ? [save] : []) }, desktop);
        const read = await call('describe_window', { window: 'foreground' });
        const results = {
            read: read.text.split('\n')[0],
            annotate: (await call('annotate', { anchor: { window: 'foreground' }, shapes })).text,
            control: (await call('annotate', { anchor: { window: 'foreground', name: 'Save' }, shapes })).text,
            wait: (await call('wait_for_element', { condition: 'appears', name: 'Save', window: 'foreground', timeoutMs: 0 })).text,
            focus: (await call('focus_window', { window: 'foreground' })).text,
            scroll: (await call('scroll_window', { window: 'foreground', notches: -1 })).text
        };
        const step = call('highlight_and_wait', { window: 'foreground', name: 'Save', prompt: 'Click Save', timeoutMs: 60000 });
        await eventually(() => currentStep() !== null);
        answerStep({ kind: 'skip' });
        results.step = (await step).text;
        return Object.fromEntries(Object.entries(results).map(([k, v]) => [k, same(v)]));
    };
    const video_ = await run('video');
    const notepad = await run('notepad');
    const nothing = await run('none');
    assert.match(video_.read, /Untitled - Notepad/);
    assert.match(video_.annotate, /^Drew ann_N on window 100 "Untitled - Notepad"/);
    for (const [k, v] of Object.entries(video_)) assert.equal(/YouTube|Lofi|500/.test(v), false, `${k}: ${v}`);
    assert.deepEqual(video_, notepad, 'the video in front reads the same as Notepad in front');
    assert.deepEqual(video_, nothing, 'and the same as nothing in front');
});

test('a refusal reads byte for byte as the reading tools word it', async () => {
    const desktop = fakeDesktop();
    desktop.windows.push(video);
    fakeHelper({}, desktop);
    const long = `A window title much longer than eighty characters, ${'x'.repeat(60)} and more`;
    for (const q of ['YouTube', '987654', '500', 'Zzzqq', long, 'Lofi beats  - YouTube']) {
        const read = (await call('describe_window', { window: q })).text.replace(/^describe_window: /, '');
        const guided = {
            annotate: await call('annotate', { anchor: { window: q }, shapes }),
            control: await call('annotate', { anchor: { window: q, name: 'Save' }, shapes }),
            focus: await call('focus_window', { window: q }),
            wait: await call('wait_for_element', { condition: 'appears', name: 'Save', window: q, timeoutMs: 0 }),
            step: await call('highlight_and_wait', { window: q, name: 'Save', prompt: 'p', timeoutMs: 1000 })
        };
        for (const [tool, r] of Object.entries(guided)) {
            assert.equal(r.isError, true, `${tool} ${q}`);
            assert.equal(r.text.replace(/^[a-z_]+: /, ''), read, `${tool} for ${JSON.stringify(q)}`);
        }
    }

    // Nothing shared to fall back on: "foreground" is refused as the reading tools refuse it.
    const hidden = fakeDesktop();
    for (const w of hidden.windows) w.minimized = true;
    fakeHelper({}, hidden);
    const read = (await call('describe_window', { window: 'foreground' })).text.replace(/^describe_window: /, '');
    const drawn = (await call('annotate', { anchor: { window: 'foreground' }, shapes })).text.replace(/^annotate: /, '');
    assert.equal(drawn, read);
});

// --- covers -----------------------------------------------------------------------

const savedText = { ref: 'el_5', name: 'Saved', role: 'text', rect: rect(0, 0, 10, 10), enabled: true };
const finds = p => (p.name === 'Save' ? [save] : p.name === 'Saved' ? [savedText] : []);

/** The warning a step starts with, and what a STUCK says of the target, with `cover` on top of it. */
async function coverWords(cover) {
    const desktop = fakeDesktop();
    desktop.windows.push(video);
    fakeHelper({ find_elements: finds, covered: () => cover }, desktop);
    const started = await call('highlight_and_wait', { window: 'Notepad', name: 'Save', prompt: 'p', until: { condition: 'disappears', name: 'Saved' }, timeoutMs: 1000 });
    const stuck = call('highlight_and_wait', { window: 'Notepad', name: 'Save', prompt: 'p', until: { condition: 'appears', name: 'Nothing' }, timeoutMs: 60000 });
    await eventually(() => currentStep() !== null);
    answerStep({ kind: 'stuck', text: 'cannot see it' });
    return `${steady(started.text)}\n---\n${steady((await stuck).text)}`;
}

test('how much of a target a private window hides is one phrase, whatever the overlap', async () => {
    // The private window moves over the target: while it covers it, the words stay the same.
    const covering = [];
    for (const [fraction, centre] of [[0.55, true], [0.75, true], [0.95, true], [1, true], [0.3, true], [0.6, false]]) {
        covering.push(await coverWords({ fraction, centre_covered: centre, by: [video.title] }));
    }
    for (const t of covering) assert.equal(t, covering[0]);
    assert.match(covering[0], /WARNING: "Save" \[button\] el_1 is behind another window; focus_window/);
    assert.equal(/\d+%|partly|mostly|almost|YouTube/.test(covering[0]), false, covering[0]);
    // While it only grazes it, the answer is the one with nothing on top.
    const grazing = [];
    for (const fraction of [0, 0.1, 0.3, 0.45]) {
        grazing.push(await coverWords({ fraction, centre_covered: false, by: fraction ? [video.title] : [] }));
    }
    for (const t of grazing) assert.equal(t, grazing[0]);
    assert.match(grazing[0], /The circled control is visible and uncovered/);
});

test('a shared cover is still named and measured', async () => {
    fakeHelper({ find_elements: finds, covered: () => ({ fraction: 0.3, centre_covered: false, by: ['Calculator'] }) });
    const stuck = call('highlight_and_wait', { window: 'Notepad', name: 'Save', prompt: 'p', until: { condition: 'appears', name: 'Nothing' }, timeoutMs: 60000 });
    await eventually(() => currentStep() !== null);
    answerStep({ kind: 'stuck', text: 'cannot see it' });
    assert.match((await stuck).text, /The circled control is 30% covered by "Calculator"\./);
});
