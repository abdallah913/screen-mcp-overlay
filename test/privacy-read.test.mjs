import test from 'node:test';
import assert from 'node:assert/strict';
import { call, connect, fakeDesktop, fakeHelper, harness, rect } from './support/fake-helper.mjs';
import { captureLayers, keptInFrame } from '../dist-test/windows.js';
import { MASK_BGRA, SHARED_INSET_PX, maskBitmap } from '../dist-test/visible.js';

/*
 * A window the user has not shared must be indistinguishable, through every
 * reading tool, from a window that is not open: no title, no ref, no state,
 * no count, the same refusal word for word, and the same helper round trips.
 * The private window here is a video playing on the side while the user gets
 * help in Notepad; it is in front, so "foreground" would have meant it.
 */

const { store, answerStep, addClick, cancelStep, currentStep } = harness;

test.beforeEach(() => store.clear());
test.afterEach(() => cancelStep('clear'));

const VIDEO = 'Lofi beats - YouTube - Google Chrome';
const video = {
    ref: '500',
    title: VIDEO,
    class: 'Chrome_WidgetWin_1',
    pid: 40,
    exe: 'chrome.exe',
    rect: rect(600, 120, 900, 600),
    foreground: true,
    minimized: false,
    cloaked: false,
    elevated: false,
    hung: false,
    private: true
};

/** The fake desktop with the video open in front of everything, or without it. */
function desktopWith(open) {
    const desktop = fakeDesktop();
    desktop.windows[0].foreground = false;
    if (open) desktop.windows.unshift({ ...video });
    return desktop;
}

/** Nothing of the private window: not its title or any part of it, its ref, or its app. */
function assertNoLeak(text, what = '') {
    assert.doesNotMatch(text, /youtube|lofi|chrome/i, `${what} leaked the private window: ${text}`);
    assert.doesNotMatch(text, /\b500\b/, `${what} leaked the private window's ref: ${text}`);
}

/** Ids that differ between two otherwise identical calls. */
const normal = t => t.replace(/\b(snap|ann|cap)_\d+/g, '$1_N');

/** Helper ops that name a window or element, so a test can tell what was asked about. */
const touched = calls => calls.filter(c => !['list_windows', 'zorder', 'set_shared'].includes(c.op));

/**
 * Run the same tool call with the private window open and with it closed, and
 * require the same answer and the same helper round trips: then nothing in
 * the response, and nothing in its timing beyond noise, can say it is open.
 */
async function sameWithAndWithout(tool, args, overrides = {}) {
    const open = fakeHelper(overrides, desktopWith(true));
    const withIt = await call(tool, args);
    // Sharing pushes its state to the helper; that is not about this call.
    const ops = calls => calls.filter(c => c.op !== 'set_shared');
    const asked = ops(open.calls);
    const closed = fakeHelper(overrides, desktopWith(false));
    const without = await call(tool, args);
    // The agent's own words come back in a refusal; anything else may not.
    const echoed = Object.values(args).filter(v => typeof v === 'string');
    const own = t => echoed.reduce((s, v) => s.split(`"${v}"`).join('"<query>"'), t);
    assertNoLeak(own(withIt.text), tool);
    assert.equal(normal(withIt.text), normal(without.text), `${tool} ${JSON.stringify(args)} differs`);
    assert.equal(withIt.isError, without.isError);
    assert.deepEqual(asked.map(c => c.op), ops(closed.calls).map(c => c.op), `${tool} made different helper calls`);
    for (const c of asked) assertNoLeak(JSON.stringify(c.params), `${tool} asked the helper about it`);
    return withIt;
}

// --- listing --------------------------------------------------------------------

test('list_windows lists shared windows only, with no count or flag for the private one', async () => {
    const { text } = await sameWithAndWithout('list_windows', {});
    assert.match(text, /^2 shared window\(s\)/);
    assert.equal(/\[foreground\]/.test(text), false, 'the window in front is not shared, so nothing is marked');
});

test('with nothing shared, list_windows says so in fixed words', async () => {
    const desktop = desktopWith(true);
    for (const w of desktop.windows) w.private = true;
    fakeHelper({}, desktop);
    const { text } = await call('list_windows');
    assertNoLeak(text);
    assert.match(text, /^No windows are shared with you\. Windows stay private until the user shares them; call list_windows with ask:"<why>" to ask\.\ndisplays: /);
    assert.doesNotMatch(text, /Notepad|Calculator/);
});

test('the screen://windows resource lists shared windows only', async () => {
    const read = async open => {
        fakeHelper({}, desktopWith(open));
        const client = await connect();
        try {
            return (await client.readResource({ uri: 'screen://windows' })).contents[0].text;
        } finally {
            await client.close();
        }
    };
    const withIt = await read(true);
    assertNoLeak(withIt);
    assert.equal(withIt, await read(false));
    assert.match(withIt, /^2 shared window\(s\), ref WxH@x,y title:\n100 800x600@100,100 Untitled - Notepad\n200 /);
});

// --- one refusal for everything not shared ------------------------------------------

const QUERIES = ['500', 'YouTube', 'Lofi', VIDEO, 'chrome'];

for (const tool of ['describe_window', 'find_ui_elements', 'read_text', 'capture_screen']) {
    test(`${tool} refuses the private window exactly as a window that is not open`, async () => {
        for (const window of QUERIES) {
            const extra = tool === 'find_ui_elements' ? { name: 'Save' } : {};
            const r = await sameWithAndWithout(tool, { window, ...extra });
            assert.equal(r.isError, true);
            assert.ok(r.text.startsWith(`${tool}: no shared window matches "${window}". Shared: 100 "Untitled - Notepad"`), r.text);
        }
    });
}

test('the refusal for a private ref and a made-up one differ only in the echoed query', async () => {
    fakeHelper({}, desktopWith(true));
    const privateRef = await call('describe_window', { window: '500' });
    const bogus = await call('describe_window', { window: '999999' });
    assert.equal(privateRef.text.replace('"500"', '"Q"'), bogus.text.replace('"999999"', '"Q"'));
    assert.equal(privateRef.isError, bogus.isError);
});

// --- "foreground" -------------------------------------------------------------------

test('"foreground" means the frontmost shared window, not the private one in front', async () => {
    const { calls } = fakeHelper({}, desktopWith(true));
    const { text, isError } = await call('describe_window', { window: 'foreground' });
    assert.equal(isError, false, text);
    assertNoLeak(text);
    assert.equal(calls.find(c => c.op === 'describe').params.window, '100');
    await sameWithAndWithout('describe_window', { window: 'foreground' });
    await sameWithAndWithout('find_ui_elements', { window: 'active', name: 'Save' });
});

test('"foreground" with nothing shared is the same refusal as any other window', async () => {
    const desktop = desktopWith(true);
    for (const w of desktop.windows) w.private = true;
    const { calls } = fakeHelper({}, desktop);
    const { text, isError } = await call('describe_window', { window: 'foreground' });
    assert.equal(isError, true);
    assertNoLeak(text);
    assert.equal(
        text,
        'describe_window: no shared window matches "foreground". Windows stay private until the user shares them; ' +
            'list_windows with ask:"<why you need it>" asks the user to share one.'
    );
    assert.deepEqual(touched(calls), [], 'refused before the helper was asked about any window');
});

// --- searching without a window -------------------------------------------------------

test('find_ui_elements without a window searches each shared window, never the desktop', async () => {
    const { calls } = fakeHelper(
        {
            find_elements: p =>
                p.window === '500' || p.window === undefined
                    ? [{ ref: 'el_77', name: 'Lofi beats video', role: 'button', rect: rect(700, 300, 50, 20), enabled: true }]
                    : [{ ref: p.window === '100' ? 'el_1' : 'el_3', name: 'Save', role: 'button', rect: rect(150, 150, 80, 24), enabled: true }]
        },
        desktopWith(true)
    );
    const { text } = await call('find_ui_elements', { name: 'Save', limit: 25 });
    assertNoLeak(text);
    const windows = calls.filter(c => c.op === 'find_elements').map(c => c.params.window);
    assert.deepEqual(windows, ['100', '200'], 'visible shared windows only, front first');
    assert.match(text, /^2 match\(es\):/);
});

test('an unscoped search keeps to its limit across windows', async () => {
    const { calls } = fakeHelper({}, desktopWith(true));
    const { text } = await call('find_ui_elements', { name: 'Save', limit: 1 });
    assert.match(text, /^1 match\(es\):/);
    assert.deepEqual(calls.filter(c => c.op === 'find_elements').map(c => c.params.window), ['100']);
});

// --- covering windows, clicks and refs ------------------------------------------------

test('a private window covering a shared target is "another window", however the helper names it', async () => {
    for (const by of [[VIDEO], ['Chrome_WidgetWin_1'], [`a popup of ${VIDEO}`], ['500']]) {
        fakeHelper({ covered: () => ({ fraction: 0.9, centre_covered: true, by }) }, desktopWith(true));
        const { text } = await call('annotate', { anchor: { window: 'Notepad', name: 'Save' }, shapes: [{ type: 'circle' }] });
        assertNoLeak(text, JSON.stringify(by));
        assert.match(text, /is behind another window/);
        assertNoLeak(String(store.list()[0].covered), 'the stored cover');
    }
});

test('the chat panel and shared windows keep their names as covers', async () => {
    fakeHelper({ covered: () => ({ fraction: 0.9, centre_covered: true, by: ["the overlay's chat panel", VIDEO, 'Calculator'] }) }, desktopWith(true));
    const { text } = await call('annotate', { anchor: { window: 'Notepad', name: 'Save' }, shapes: [{ type: 'circle' }] });
    assertNoLeak(text);
    assert.match(text, /behind "the overlay's chat panel, another window"/);
});

test('a click on the private window names nothing and issues no ref', async () => {
    const hitVideo = p =>
        p.x >= 600 && p.y >= 120
            ? { element: { ref: 'el_77', name: 'Lofi beats video', role: 'button', rect: rect(700, 300, 50, 20), enabled: true }, window: { ref: '500', title: VIDEO } }
            : { element: null, window: { ref: '100', title: 'Untitled - Notepad' } };
    fakeHelper({ element_at_point: hitVideo, zorder: () => [] }, desktopWith(true));
    const pendingClick = call('wait_for_user_click', { prompt: 'Point at it' });
    for (let i = 0; i < 400 && !currentStep(); i += 1) await new Promise(r => setTimeout(r, 5));
    addClick({ displayId: '1', physical: { x: 700, y: 300 }, dip: { x: 700, y: 300 }, normalized: { x: 0, y: 0 } });
    const { text } = await pendingClick;
    assertNoLeak(text);
    assert.doesNotMatch(text, /el_77/);

    const reused = await call('annotate', { anchor: { ref: 'el_77' }, shapes: [{ type: 'box' }] });
    const neverIssued = await call('annotate', { anchor: { ref: 'el_404' }, shapes: [{ type: 'box' }] });
    assertNoLeak(reused.text);
    assert.equal(reused.text.replaceAll('el_77', 'el_N'), neverIssued.text.replaceAll('el_404', 'el_N'));
});

test('refs found in a window stop working once it is no longer shared', async () => {
    fakeHelper();
    await call('find_ui_elements', { window: 'Notepad', name: 'Save' });
    assert.equal((await call('annotate', { anchor: { ref: 'el_1' }, shapes: [{ type: 'box' }] })).isError, false);
    harness.stopSharingWindow('100');
    const after = await call('annotate', { anchor: { ref: 'el_1' }, shapes: [{ type: 'box' }] });
    const never = await call('annotate', { anchor: { ref: 'el_404' }, shapes: [{ type: 'box' }] });
    assert.equal(after.isError, true);
    assert.equal(after.text.replaceAll('el_1', 'el_N'), never.text.replaceAll('el_404', 'el_N'));
});

// --- errors and defence in depth ---------------------------------------------------------

test('a helper error naming an unshared window reads as the refusal', async () => {
    for (const message of ['no window for ref 500: element not available', 'window 500 is not responding']) {
        fakeHelper({ describe: () => { throw new Error(message); } }, desktopWith(true));
        const { text, isError } = await call('describe_window', { window: 'Notepad' });
        assert.equal(isError, true);
        assertNoLeak(text.replace('"500"', '"Q"'));
        assert.match(text, /^describe_window: no shared window matches "500"\. Shared: 100 /);
    }
});

/** Notepad's document reads `doc`; a private window titled `title` is open in front when `open`. */
function mentioning(doc, title, open) {
    const desktop = desktopWith(false);
    desktop.tree = desktop.tree.map(n => (n.role === 'document' ? { ...n, value: doc } : n));
    desktop.controls = [...desktop.controls, { ref: 'el_3', name: doc, role: 'text', rect: rect(100, 180, 800, 20), enabled: true }];
    if (open) desktop.windows.unshift({ ...video, title });
    return desktop;
}

test("shared content that mentions a private window's title reads as it is, whether or not that window is open", async () => {
    const jazz = 'Relaxing Jazz Piano Music for Work and Study - 3 Hours';
    for (const [title, doc] of [
        [VIDEO, `Things to watch later: ${VIDEO}`],
        [`${jazz} - YouTube - Google Chrome`, `Up next: ${jazz} (1.2M views)`],
        ['Task Manager', 'Open Task Manager and click Apply'],
        ['Settings', 'Open Settings and click Apply']
    ]) {
        for (const [tool, args] of [
            ['describe_window', { window: 'Notepad' }],
            ['find_ui_elements', { window: 'Notepad', name: 'Apply' }],
            ['find_ui_elements', { window: 'Notepad', name: 'later' }],
            ['find_ui_elements', { window: 'Notepad', name: 'Up next' }]
        ]) {
            fakeHelper({}, mentioning(doc, title, true));
            const open = await call(tool, args);
            fakeHelper({}, mentioning(doc, title, false));
            const closed = await call(tool, args);
            assert.equal(normal(open.text), normal(closed.text), `${tool} ${JSON.stringify(args)} with "${title}" open`);
            assert.doesNotMatch(open.text, /another window/, open.text);
        }
    }
    fakeHelper({}, mentioning(`Things to watch later: ${VIDEO}`, VIDEO, true));
    assert.match((await call('describe_window', { window: 'Notepad' })).text, new RegExp(`"Things to watch later: ${VIDEO}"`));
});

test('a title guess is echoed the same whether or not a window with that title is open, however it is spaced', async () => {
    const guesses = [
        VIDEO,
        'Lofi  beats - YouTube - Google Chrome',
        'Lofi\tbeats - YouTube - Google Chrome',
        ' Lofi beats -\nYouTube - Google Chrome',
        'Lofi beats  - YouTube - Google Chrome',
        'Task  Manager',
        'Spotify  Premium'
    ];
    const titles = { 'Task  Manager': 'Task Manager', 'Spotify  Premium': 'Spotify Premium' };
    const tools = [
        ['describe_window', q => ({ window: q })],
        ['find_ui_elements', q => ({ window: q, name: 'Save' })],
        ['read_text', q => ({ window: q })],
        ['capture_screen', q => ({ window: q })],
        ['focus_window', q => ({ window: q })],
        ['scroll_window', q => ({ window: q })],
        ['annotate', q => ({ anchor: { window: q }, shapes: [{ type: 'circle' }] })],
        ['wait_for_element', q => ({ condition: 'appears', name: 'x', window: q, timeoutMs: 0 })]
    ];
    for (const q of guesses) {
        const title = titles[q] ?? VIDEO;
        for (const [tool, args] of tools) {
            const desktop = desktopWith(true);
            desktop.windows[0].title = title;
            fakeHelper({}, desktop);
            const open = await call(tool, args(q));
            fakeHelper({}, desktopWith(false));
            const closed = await call(tool, args(q));
            assert.equal(open.text, closed.text, `${tool} ${JSON.stringify(q)}`);
            assert.doesNotMatch(open.text, /another window/, `${tool} ${JSON.stringify(q)}: ${open.text}`);
        }
    }
});

// --- the user stops sharing while a read is in flight ----------------------------------------

const STOPPED =
    'The user stopped sharing a window while this ran, so nothing from it is returned. list_windows shows what is shared now.';

test('a read that finishes after the user stopped sharing returns nothing of what it read', async () => {
    for (const [tool, args, op] of [
        ['describe_window', { window: 'Notepad' }, 'describe'],
        ['find_ui_elements', { window: 'Notepad', name: 'Save' }, 'find_elements'],
        ['find_ui_elements', { name: 'Save' }, 'find_elements'],
        ['list_windows', {}, 'list_windows']
    ]) {
        // Which window stopped being shared does not show: the answer is the same for either.
        for (const ref of ['100', '200']) {
            const desktop = fakeDesktop();
            desktop.tree = desktop.tree.map(n => (n.role === 'document' ? { ...n, value: 'my bank PIN is 1234' } : n));
            const answers = {
                describe: () => ({ nodes: desktop.tree, truncated: false }),
                find_elements: () => desktop.controls,
                list_windows: () => desktop.windows
            };
            let stopped = false;
            fakeHelper(
                {
                    [op]: p => {
                        if (!stopped) harness.stopSharingWindow(ref, { byUser: true });
                        stopped = true;
                        return answers[op](p);
                    }
                },
                desktop
            );
            const r = await call(tool, args);
            assert.equal(r.isError, true, `${tool} after ${ref} stopped: ${r.text}`);
            assert.equal(r.text, `${tool}: ${STOPPED}`);
        }
    }
});

test('a read with no share withdrawn while it ran is answered as usual', async () => {
    fakeHelper();
    harness.stopSharingWindow('200', { byUser: true });
    const r = await call('describe_window', { window: 'Notepad' });
    assert.equal(r.isError, false, r.text);
    assert.match(r.text, /Text editor \[document\] "hello"/);
});

// --- asking to share ------------------------------------------------------------------------

/** Answer the share prompts: Done in the window in front, then a choice. */
async function answerShare(choice) {
    for (let i = 0; i < 400 && !currentStep(); i += 1) await new Promise(r => setTimeout(r, 5));
    const ask = currentStep();
    assert.equal(ask.mode, 'watch');
    assert.match(ask.prompt, /an AI agent asks to see the window you need help with \(it says: “to read the video title”\)/);
    answerStep({ kind: 'done' }, ask.id);
    if (choice === undefined) return;
    for (let i = 0; i < 400 && currentStep()?.mode !== 'choice'; i += 1) await new Promise(r => setTimeout(r, 5));
    const confirm = currentStep();
    assert.deepEqual(confirm.options, ['This window', "Don't share"], 'no whole-app share for a browser');
    answerStep({ kind: 'choice', index: choice }, confirm.id);
}

test('list_windows with ask shares the window the user picks, and then it is readable', async () => {
    const { calls } = fakeHelper({}, desktopWith(true));
    const [result] = await Promise.all([call('list_windows', { ask: 'to read the video title' }), answerShare(0)]);
    assert.equal(result.isError, false, result.text);
    assert.match(result.text, new RegExp(`^3 shared window\\(s\\)[^]*\\n500 900x600@600,120 ${VIDEO}\\n`));
    assert.doesNotMatch(result.text, /\[foreground\]/);
    const described = await call('describe_window', { window: '500' });
    assert.equal(described.isError, false, described.text);
    assert.equal(calls.filter(c => c.op === 'describe').at(-1).params.window, '500');
});

test('a declined ask reads the same as one nobody answered, and shares nothing', async () => {
    fakeHelper({}, desktopWith(true));
    const [declined] = await Promise.all([call('list_windows', { ask: 'to read the video title' }), answerShare(1)]);
    assert.equal(declined.text, 'The user did not share a window.');
    const { text } = await call('list_windows');
    assertNoLeak(text);
});

// --- masking captures (pure) ------------------------------------------------------------

const r = (x, y, width, height) => ({ x, y, width, height });

test('capture layers: our overlay is see-through, the chat panel hides, sharing decides the rest', () => {
    const stack = [
        { ref: 'hud', pid: 1, rect: r(1500, 600, 400, 400) },
        { ref: 'overlay', pid: 1, rect: r(0, 0, 1920, 1080) },
        { ref: '500', pid: 40, rect: r(600, 120, 900, 600) },
        { ref: '100', pid: 11, rect: r(100, 100, 800, 600) }
    ];
    const layers = captureLayers(stack, { pid: 1, panel: 'hud' }, w => w.ref === '100');
    assert.deepEqual(
        layers.map(l => [l.shared, Boolean(l.ignore)]),
        [[false, false], [false, true], [false, false], [true, false]]
    );
    const kept = keptInFrame(layers, layers, r(0, 0, 1920, 1080), { width: 1920, height: 1080 });
    const inside = (x, y) => kept.some(k => x >= k.x && x < k.x + k.width && y >= k.y && y < k.y + k.height);
    assert.equal(inside(300, 300), true, 'Notepad where nothing covers it');
    assert.equal(inside(700, 300), false, 'the video over Notepad');
    assert.equal(inside(1200, 300), false, 'the video beside it');
    assert.equal(inside(50, 50), false, 'the desktop');
});

test('a capture whose windows could not be read keeps nothing', () => {
    const layers = [{ rect: r(0, 0, 100, 100), shared: true }];
    assert.deepEqual(keptInFrame(null, layers, r(0, 0, 100, 100), { width: 100, height: 100 }), []);
    assert.deepEqual(keptInFrame(layers, null, r(0, 0, 100, 100), { width: 100, height: 100 }), []);
});

test('only what was shared both before and after the grab is kept, in the frame\'s own pixels', () => {
    const before = [{ rect: r(1000, 0, 400, 400), shared: true }];
    // The window moved 100px right while the grab was in flight.
    const after = [{ rect: r(1100, 0, 400, 400), shared: true }];
    // A second display whose frame starts at x=1000, captured at half scale.
    const kept = keptInFrame(before, after, r(1000, 0, 800, 600), { width: 400, height: 300 });
    assert.equal(kept.length, 1);
    const [k] = kept;
    // The later position, pulled in at the edge, at half scale.
    assert.equal(k.x, Math.floor((100 + SHARED_INSET_PX) / 2), `left edge at the later position: ${k.x}`);
    assert.ok(k.x + k.width <= 200, 'right edge at the earlier position');

    const frame = new Uint8Array(400 * 300 * 4).fill(200);
    const out = maskBitmap(frame, 400, 300, kept);
    assert.deepEqual([...out.subarray(0, 4)], [...MASK_BGRA], 'outside is painted over');
    const i = (100 * 400 + 100) * 4;
    assert.deepEqual([...out.subarray(i, i + 4)], [200, 200, 200, 200], 'inside is the frame');
});
