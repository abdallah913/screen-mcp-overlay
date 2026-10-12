import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, rmSync, writeFileSync } from 'node:fs';
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

const BLANK = [32, 32, 32, 255];

/** Every pixel of `r` (in the image's own pixels) is the blank colour. */
function allBlank(img, r) {
    for (let y = r.y; y < r.y + r.height; y += 1) {
        for (let x = r.x; x < r.x + r.width; x += 1) {
            if (at(img, x, y).join() !== BLANK.join()) return false;
        }
    }
    return true;
}

/** The desktop with the video at `where` (in front of everything), or with it closed when null. */
function videoAt(where) {
    const desktop = captureDesktop(where !== null);
    if (where) desktop.windows[0].rect = where;
    return desktop;
}

/** Over part of Notepad, at two places: anything that follows it would differ between them. */
const OVER_NOTEPAD = [rect(600, 120, 900, 600), rect(300, 400, 400, 200)];
/** Over Calculator, more than a shadow's width from Notepad. */
const BESIDE_NOTEPAD = rect(1000, 650, 300, 200);

/**
 * OCR that also keeps the image it was given, so a test can compare what
 * read_text read and not only the lines it found.
 */
function recordingOcr(seen) {
    return p => {
        const img = readImage(p.path);
        seen.push(img);
        const colours = coloursIn(img);
        const lines = [];
        if (colours.has('notepad')) lines.push({ text: 'notepad text', rect: rect(10, 40, 100, 12) });
        if (colours.has('private') || colours.has('privateBar')) lines.push({ text: 'private text', rect: rect(10, 80, 100, 12) });
        return lines;
    };
}

/** The Note lines of a response: what it says about where its pixels came from. */
const notes = text => text.split('\n').filter(l => l.startsWith('Note:'));

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

test('a shared window that cannot render itself is left blank, and the screen is never read', async () => {
    captureHelper(videoAt(BESIDE_NOTEPAD), { renders: { 100: 'blank' } });
    const r = await call('capture_screen', { display: 'primary', maxDimension: 4096 });
    assert.equal(r.isError, false, r.text);
    const img = imageOf(r.text);
    // A screen copy holds whatever is in front of the window or shows through it.
    assert.equal(stub.__state.grabs, 0);
    assertNothingPrivate(img, 'no screen copy');
    assert.ok(allBlank(img, rect(100, 100, 800, 600)), 'Notepad is blank whole');
    assert.deepEqual(at(img, 1100, 400), COLOURS.calculator, 'Calculator still renders itself');
});

for (const how of ['fallback', 'blank']) {
    test(`a shared window that renders ${how} with the video over part of it is blank whole, wherever the video is`, async () => {
        const images = [];
        for (const where of OVER_NOTEPAD) {
            captureHelper(videoAt(where), { renders: { 100: how } });
            const r = await call('capture_screen', { display: 'primary', maxDimension: 4096 });
            assert.equal(r.isError, false, r.text);
            images.push(imageOf(r.text));
        }
        // A hole cut around the video would trace where it is and follow it.
        assert.ok(Buffer.from(images[0].data).equals(Buffer.from(images[1].data)), 'the image follows the video');
        assert.ok(allBlank(images[0], rect(100, 100, 800, 600)), 'Notepad is blank whole');
        assertNothingPrivate(images[0], 'screen copy under the video');
        assert.deepEqual(at(images[0], 1100, 400), COLOURS.calculator, 'Calculator still renders itself');
    });
}

for (const how of ['fallback', 'blank']) {
    for (const [tool, args] of [
        ['capture_screen', { window: 'Notepad', asRendered: true, maxDimension: 4096 }],
        ['capture_screen', { window: 'Notepad', maxDimension: 4096 }],
        ['read_text', { window: 'Notepad' }]
    ]) {
        test(`${tool} ${JSON.stringify(args)} of a window that renders ${how} reads the same wherever the video is over it`, async () => {
            const results = [];
            for (const where of OVER_NOTEPAD) {
                const read = [];
                captureHelper(videoAt(where), { renders: { 100: how }, overrides: { ocr: recordingOcr(read) } });
                const r = await call(tool, args);
                assert.equal(r.isError, false, r.text);
                results.push({ text: normal(r.text), image: imageOf(r.text) ?? read.at(-1) });
            }
            assert.equal(results[0].text, results[1].text);
            assert.doesNotMatch(results[0].text, /private text|\d+%/);
            const [a, b] = results.map(x => x.image);
            assert.deepEqual({ width: a.width, height: a.height }, { width: b.width, height: b.height });
            assert.ok(Buffer.from(a.data).equals(Buffer.from(b.data)), 'the pixels follow the video');
            assertNothingPrivate(a, `${tool} under the video`);
        });
    }
}

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
    assert.match(text, /This window cannot render itself \(a GPU or video surface\), so it is left blank; nothing is read from the screen in its place\./);
});

test('whether a refusing window reads as blank depends on its own render, never on what covers it', async () => {
    // The video over all of Notepad leaves its screen copy one flat colour.
    const whole = rect(50, 50, 1000, 800);
    captureHelper(videoAt(whole), { renders: { 100: 'fallback' } });
    const covered = await call('capture_screen', { window: 'Notepad' });
    captureHelper(videoAt(null), { renders: { 100: 'fallback' } });
    const open = await call('capture_screen', { window: 'Notepad' });
    assert.equal(normal(covered.text), normal(open.text));
    assert.doesNotMatch(covered.text, /flat colour/);

    captureHelper(videoAt(whole), { renders: { 100: 'fallback' } });
    const read = await call('read_text', { window: 'Notepad' });
    captureHelper(videoAt(null), { renders: { 100: 'fallback' } });
    const readOpen = await call('read_text', { window: 'Notepad' });
    // What it found may differ (nothing at all under the video), but never why.
    assert.deepEqual(notes(read.text), notes(readOpen.text));
    assert.doesNotMatch(read.text, /rendered blank|flat colour/);
});

// --- read_text of a window --------------------------------------------------------------

for (const how of ['fallback', 'blank']) {
    test(`read_text of a window that renders ${how} reads the same with the video beside it or closed`, async () => {
        captureHelper(videoAt(BESIDE_NOTEPAD), { renders: { 100: how } });
        const beside = await call('read_text', { window: 'Notepad' });
        captureHelper(videoAt(null), { renders: { 100: how } });
        const closed = await call('read_text', { window: 'Notepad' });
        assert.equal(normal(beside.text), normal(closed.text));
        // Nothing is read from the screen in its place, so there is nothing to find.
        assert.doesNotMatch(beside.text, /notepad text|private text|shadow|\d+%|nothing covered/);
        assert.match(beside.text, /This window cannot render itself \(a GPU or video surface\), so it is left blank; nothing is read from the screen in its place\./);
        // Over it, the note is the same word for word.
        captureHelper(videoAt(OVER_NOTEPAD[1]), { renders: { 100: how } });
        const over = await call('read_text', { window: 'Notepad' });
        assert.deepEqual(notes(over.text), notes(closed.text));
        assert.doesNotMatch(over.text, /private text|shadow|\d+%/);
    });
}

// --- renders that fail, and our own overlay ---------------------------------------------

test('captures after the capture dir was emptied (as when the user stops sharing something) are still composed', async () => {
    const dir = join(tmpdir(), 'screen-mcp-overlay', String(process.pid));
    captureHelper(captureDesktop(true));
    await call('capture_screen', { display: 'primary' });
    // What index.ts does on every revocation: the private render dir goes too.
    for (const name of readdirSync(dir)) rmSync(join(dir, name), { recursive: true, force: true });
    const { image } = await sameWithAndWithout('capture_screen', { display: 'primary', maxDimension: 4096 });
    assert.equal(stub.__state.grabs, 0, 'the screen was grabbed');
    assert.deepEqual(at(image, 700, 400), COLOURS.notepad);
    assertNothingPrivate(image, 'capture after a purge');
    captureHelper(captureDesktop(true));
    const window = await call('capture_screen', { window: 'Notepad' });
    assert.equal(window.isError, false, window.text);
});

test('a shared window whose render fails is left blank, and the screen is never read for it', async () => {
    const { image } = await sameWithAndWithout('capture_screen', { display: 'primary', maxDimension: 4096 }, { 100: 'error' });
    assert.equal(stub.__state.grabs, 0, 'the screen was grabbed');
    assert.ok(allBlank(image, rect(100, 100, 800, 600)), 'Notepad is blank');
    assert.deepEqual(at(image, 1100, 400), COLOURS.calculator);
});

/** Our own full-screen overlay, in front, with a step strip over Notepad (say, a window title being confirmed). */
const STRIP = [7, 77, 177, 255];
function withOverlay(desktop) {
    desktop.windows.unshift({
        ref: '900', title: '', class: 'Chrome_WidgetWin_1', pid: process.pid, rect: rect(0, 0, 1920, 1080),
        foreground: false, minimized: false, cloaked: false, elevated: false, hung: false
    });
    return desktop;
}
/** The overlay is see-through, so the fake screen does not paint it: only its strip, here. */
function paintStrip() {
    const s = stub.__state.screen[1];
    for (let y = 600; y < 640; y += 1) for (let x = 150; x < 550; x += 1) s.data.set(STRIP, (y * s.width + x) * 4);
}
function stripPixels(img) {
    let n = 0;
    for (let i = 0; i < img.data.length; i += 4) if (img.data[i] === 7 && img.data[i + 1] === 77 && img.data[i + 2] === 177) n += 1;
    return n;
}

test('with content protection off, our overlay is cut from screen copies like any window on top', async () => {
    harness.setContentProtection(false);
    try {
        for (const [tool, args] of [
            ['capture_screen', { display: 'primary', maxDimension: 4096 }],
            ['capture_screen', { window: 'Notepad', asRendered: true, maxDimension: 4096 }],
            ['capture_screen', { window: 'Notepad', maxDimension: 4096 }],
            ['read_text', { window: 'Notepad' }]
        ]) {
            const read = [];
            captureHelper(withOverlay(captureDesktop(false)), { renders: { 100: 'fallback' }, overrides: { ocr: recordingOcr(read) } });
            paintStrip();
            const r = await call(tool, args);
            assert.equal(r.isError, false, r.text);
            const img = imageOf(r.text) ?? read.at(-1);
            assert.equal(stripPixels(img), 0, `${tool} ${JSON.stringify(args)} kept the overlay's strip`);
        }
    } finally {
        harness.setContentProtection(true);
    }
});

test('with content protection on, our overlay is not in the grab, so it hides nothing', async () => {
    captureHelper(withOverlay(captureDesktop(false)));
    const r = await call('capture_screen', { display: 'primary', maxDimension: 4096 });
    assert.deepEqual(at(imageOf(r.text), 300, 400), COLOURS.notepad);
});

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
