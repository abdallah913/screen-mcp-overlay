import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    BORDER,
    COLOURS,
    call,
    captureDesktop,
    captureHelper,
    coloursIn,
    harness,
    imageOf,
    readImage,
    rect,
    stub
} from './support/capture-desktop.mjs';

/*
 * Captures, with real pixels: a private video plays over the shared Notepad
 * and over all of the shared Calculator. Whatever a capture shows or says
 * must be the same whether the video is open or not: no hole the shape of it,
 * no shadow along its edges, no percentage of what it covers, no warning that
 * only appears while it is there.
 */

const { store, cancelStep } = harness;

test.beforeEach(() => {
    store.clear();
    stub.__state.displays = [{ id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 }];
});
test.afterEach(() => cancelStep('clear'));

/** Ids and paths that differ between two otherwise identical calls. */
const normal = t => t.replace(/\b(snap|ann|cap)_\d+/g, '$1_N').replace(/path: .*/g, 'path: P');

const PRIVATE = ['private', 'privateBar', 'shadow', 'desktop'];

function assertNothingPrivate(img, what) {
    const seen = coloursIn(img);
    for (const c of PRIVATE) assert.equal(seen.has(c), false, `${what}: ${c} pixels reached the image`);
}

/**
 * The same call with the video open and closed: same text, and the same
 * pixels unless `pixels` is false (a window that would not render itself
 * shows the screen, masked, which has a hole wherever anything else is on top).
 */
async function sameWithAndWithout(tool, args, renders = {}, pixels = true) {
    captureHelper(captureDesktop(true), { renders });
    const withIt = await call(tool, args);
    const imageWith = imageOf(withIt.text);
    captureHelper(captureDesktop(false), { renders });
    const without = await call(tool, args);
    const imageWithout = imageOf(without.text);
    assert.equal(withIt.isError, false, withIt.text);
    assert.doesNotMatch(withIt.text, /youtube|lofi|chrome|\b500\b|private|shadow/i, withIt.text);
    assert.equal(normal(withIt.text), normal(without.text), `${tool} ${JSON.stringify(args)} reads differently`);
    if (imageWith && pixels) {
        assert.deepEqual(
            { width: imageWith.width, height: imageWith.height },
            { width: imageWithout.width, height: imageWithout.height }
        );
        assert.ok(Buffer.from(imageWith.data).equals(Buffer.from(imageWithout.data)), `${tool} ${JSON.stringify(args)}: the pixels differ`);
    }
    return { text: withIt.text, image: imageWith };
}

const at = (img, x, y) => [...img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4)];

// --- display and region captures -----------------------------------------------------

test('a display capture is drawn from the shared windows themselves: nothing traces the private window', async () => {
    const { image } = await sameWithAndWithout('capture_screen', { display: 'primary', maxDimension: 4096 });
    assertNothingPrivate(image, 'display capture');
    assert.deepEqual({ width: image.width, height: image.height }, { width: 1920, height: 1080 });
    // Notepad's own pixels where the video covers it on screen.
    assert.deepEqual(at(image, 700, 400), COLOURS.notepad);
    assert.deepEqual(at(image, 1100, 400), COLOURS.calculator);
    assert.deepEqual(at(image, 650, 110), COLOURS.notepadBar);
    // Its invisible resize border is not painted: that is the desktop, blank.
    assert.deepEqual(at(image, 100 - BORDER + 1, 400), [32, 32, 32, 255]);
    assert.deepEqual(at(image, 50, 50), [32, 32, 32, 255]);
});

test('a display capture never reads the screen when every shared window renders itself', async () => {
    captureHelper(captureDesktop(true));
    const r = await call('capture_screen', { display: 'primary' });
    assert.equal(r.isError, false, r.text);
    assert.equal(stub.__state.grabs, 0, 'the screen was grabbed');
});

test('a region capture and read_text of a region read the same with the video open or closed', async () => {
    const region = { x: 500, y: 100, width: 600, height: 400 };
    const { image } = await sameWithAndWithout('capture_screen', { region, maxDimension: 4096 });
    assertNothingPrivate(image, 'region capture');
    assert.deepEqual(at(image, 200, 300), COLOURS.notepad, 'Notepad under the video, at region offset');
    const { text } = await sameWithAndWithout('read_text', { region });
    assert.match(text, /notepad text/);
    assert.doesNotMatch(text, /private text|shadow/);
});

test('shared windows keep their order: the one in front covers the one behind', async () => {
    const desktop = captureDesktop(true);
    // Calculator dragged over Notepad's right edge, in front of it.
    const calc = desktop.windows.find(w => w.ref === '200');
    calc.rect = rect(800, 150, 320, 500);
    desktop.windows.splice(desktop.windows.indexOf(calc), 1);
    desktop.windows.splice(1, 0, calc);
    captureHelper(desktop);
    const r = await call('capture_screen', { display: 'primary', maxDimension: 4096 });
    const img = imageOf(r.text);
    assert.deepEqual(at(img, 850, 400), COLOURS.calculator, 'Calculator is in front');
    assert.deepEqual(at(img, 700, 400), COLOURS.notepad);
    assertNothingPrivate(img, 'two shared windows');
});

test('a shared window that cannot render itself falls back to the masked screen, with wide margins', async () => {
    captureHelper(captureDesktop(true), { renders: { 100: 'blank' } });
    const r = await call('capture_screen', { display: 'primary', maxDimension: 4096 });
    assert.equal(r.isError, false, r.text);
    const img = imageOf(r.text);
    assert.equal(stub.__state.grabs, 1);
    // Neither the video's shadow nor the corners around Notepad survive.
    assertNothingPrivate(img, 'masked fallback');
    assert.deepEqual(at(img, 300, 400), COLOURS.notepad, 'the uncovered part is the screen there');
    assert.deepEqual(at(img, 700, 400), [32, 32, 32, 255], 'under the video is blank');
});

test('a capture on a display left of the primary one, at a negative origin and another scale', async () => {
    stub.__state.displays = [
        { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 },
        // 2560x1440 physical at 1.5, to the left: its physical origin is -2560.
        { id: 2, bounds: { x: -2560, y: 0, width: 2560 / 1.5, height: 1440 / 1.5 }, scaleFactor: 1.5 }
    ];
    const desktop = captureDesktop(true);
    desktop.windows.find(w => w.ref === '100').rect = rect(-2400, 200, 800, 600);
    captureHelper(desktop);
    const r = await call('capture_screen', { display: '2', maxDimension: 4096 });
    assert.equal(r.isError, false, r.text);
    const img = imageOf(r.text);
    assert.deepEqual({ width: img.width, height: img.height }, { width: 2560, height: 1440 });
    assert.deepEqual(at(img, 160, 200), COLOURS.notepadBar, "Notepad's top-left at its display-local position");
    assert.deepEqual(at(img, 159, 400), [32, 32, 32, 255]);
    assert.deepEqual(at(img, 959, 799), COLOURS.notepad);
    assert.deepEqual(at(img, 960, 400), [32, 32, 32, 255]);
    assertNothingPrivate(img, 'second display');
});

// --- a window as rendered -------------------------------------------------------------

test('asRendered is the window and the shared windows above it, the same with the video open or closed', async () => {
    const { text, image } = await sameWithAndWithout('capture_screen', { window: 'Notepad', asRendered: true, maxDimension: 4096 });
    assertNothingPrivate(image, 'asRendered');
    assert.deepEqual({ width: image.width, height: image.height }, { width: 800, height: 600 });
    assert.deepEqual(at(image, 600, 300), COLOURS.notepad, 'under the video is Notepad itself');
    assert.doesNotMatch(text, /\d+%/);
});

test('asRendered names a shared window on top, worded the same with the video open or closed', async () => {
    const run = async open => {
        const desktop = captureDesktop(open);
        const calc = desktop.windows.find(w => w.ref === '200');
        calc.rect = rect(700, 150, 320, 500);
        desktop.windows.splice(desktop.windows.indexOf(calc), 1);
        desktop.windows.splice(open ? 1 : 0, 0, calc);
        captureHelper(desktop);
        return call('capture_screen', { window: 'Notepad', asRendered: true, maxDimension: 4096 });
    };
    const withIt = await run(true);
    const without = await run(false);
    assert.equal(normal(withIt.text), normal(without.text));
    assert.match(withIt.text, /"Calculator"/);
    const img = imageOf(withIt.text);
    assert.deepEqual(at(img, 650, 300), COLOURS.calculator, 'Calculator is drawn over it');
});

test('capture_screen of a window that refused to render says the same with the video open or closed', async () => {
    const { text } = await sameWithAndWithout('capture_screen', { window: 'Notepad' }, { 100: 'fallback' }, false);
    assert.doesNotMatch(text, /\d+%/);
    assert.match(text, /Parts of this window that are not on top show only shared windows; the rest is blank\./);
});

// --- read_text of a window --------------------------------------------------------------

for (const how of ['fallback', 'blank']) {
    test(`read_text of a window that renders ${how} reads the same with the video open or closed`, async () => {
        const { text } = await sameWithAndWithout('read_text', { window: 'Notepad' }, { 100: how });
        assert.match(text, /notepad text/);
        assert.doesNotMatch(text, /private text|shadow|\d+%|nothing covered/);
        assert.match(text, /Parts of this window that are not on top show only shared windows; the rest is blank\./);
    });
}

// --- the user stops sharing mid-capture ---------------------------------------------------

test('a capture that finishes after the user stopped sharing returns nothing of it, and writes nothing', async () => {
    const dir = join(tmpdir(), 'screen-mcp-overlay', String(process.pid));
    const pngs = () => new Set(readdirSync(dir).filter(f => f.endsWith('.png')));
    const before = pngs();
    for (const [tool, args] of [
        ['capture_screen', { display: 'primary' }],
        ['capture_screen', { window: 'Notepad' }],
        ['read_text', { window: 'Notepad' }]
    ]) {
        const desktop = captureDesktop(true);
        let stopped = false;
        const { calls } = captureHelper(desktop, {
            overrides: {
                print_window: p => {
                    if (!stopped) harness.stopSharingWindow('100', { byUser: true });
                    stopped = true;
                    const w = desktop.windows.find(x => x.ref === p.window);
                    writeFileSync(p.path, stub.__encode(1, 1, new Uint8Array([0, 200, 0, 255])));
                    return { rect: w.rect, fallback: false };
                }
            }
        });
        const r = await call(tool, args);
        assert.ok(calls.some(c => c.op === 'print_window'), `${tool} rendered`);
        assert.equal(r.isError, true, r.text);
        assert.equal(
            r.text,
            `${tool}: The user stopped sharing a window while this ran, so nothing from it is returned. list_windows shows what is shared now.`
        );
    }
    // A capture started after the stop may be written, of what is shared then.
    for (const f of [...pngs()].filter(f => !before.has(f))) {
        const seen = coloursIn(readImage(join(dir, f)));
        assert.equal(seen.has('notepad') || seen.has('notepadBar'), false, `${f} holds the window the user took back`);
    }
});
