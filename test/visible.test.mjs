import test from 'node:test';
import assert from 'node:assert/strict';

import { maskBitmap, composeLayers, coveredFraction, MASK_BGRA } from '../dist-test/visible.js';

const r = (x, y, width, height) => ({ x, y, width, height });

test('maskBitmap keeps only the given rects and paints the rest one colour', () => {
    const w = 4, h = 2;
    const src = new Uint8Array(w * h * 4).fill(200);
    const out = maskBitmap(src, w, h, [r(1, 0, 2, 1), r(-5, -5, 1, 1)]);
    const px = (x, y) => [...out.subarray((y * w + x) * 4, (y * w + x) * 4 + 4)];
    assert.deepEqual(px(1, 0), [200, 200, 200, 200]);
    assert.deepEqual(px(2, 0), [200, 200, 200, 200]);
    assert.deepEqual(px(0, 0), [...MASK_BGRA]);
    assert.deepEqual(px(3, 1), [...MASK_BGRA]);
    assert.equal(src[0], 200, 'the source is untouched');
});

// --- composing a capture from window renders ------------------------------------------------

/** A flat image of one colour, as a layer's BGRA buffer. */
const flat = (width, height, colour) => {
    const data = new Uint8Array(width * height * 4);
    for (let i = 0; i < data.length; i += 4) data.set(colour, i);
    return { data, width, height };
};
const px = (img, w, x, y) => [...img.subarray((y * w + x) * 4, (y * w + x) * 4 + 4)];
const BLUE = [200, 0, 0, 255];
const GREEN = [0, 200, 0, 255];
const BLACK = [0, 0, 0, 255];

test('a composed capture starts blank and paints each layer, back to front, inside its clip only', () => {
    // A render covers the raw window rect, invisible 7px border included
    // (black here); the clip is the visible rect.
    const raw = r(93, 100, 214, 207);
    const render = flat(raw.width, raw.height, BLACK);
    for (let y = 0; y < 200; y += 1) for (let x = 7; x < 207; x += 1) render.data.set(GREEN, (y * raw.width + x) * 4);
    const front = { image: flat(50, 50, BLUE), rect: r(250, 250, 50, 50), clip: [r(250, 250, 50, 50)] };
    const out = composeLayers({ width: 400, height: 400 }, { x: 0, y: 0 }, [
        { image: render, rect: raw, clip: [r(100, 100, 200, 200)] },
        front
    ]);
    assert.equal(out.length, 400 * 400 * 4);
    assert.deepEqual(px(out, 400, 0, 0), [...MASK_BGRA], 'blank where nothing is shared');
    assert.deepEqual(px(out, 400, 99, 150), [...MASK_BGRA], 'the invisible border is not painted');
    assert.deepEqual(px(out, 400, 100, 100), GREEN);
    assert.deepEqual(px(out, 400, 299, 299), BLUE, 'the later layer is on top');
    assert.deepEqual(px(out, 400, 249, 249), GREEN);
    assert.deepEqual(px(out, 400, 300, 150), [...MASK_BGRA]);
});

test('composition is exact at a negative display origin, with two displays side by side', () => {
    // Display 2 sits left of the primary: its physical origin is (-1920, 0).
    // A window spanning both is painted on each, split where they meet.
    const win = r(-100, 50, 300, 100);
    const image = flat(300, 100, GREEN);
    for (let y = 0; y < 100; y += 1) image.data.set(BLUE, (y * 300 + 100) * 4); // column 100 is x = 0
    const layer = { image, rect: win, clip: [win] };
    const left = composeLayers({ width: 1920, height: 1080 }, { x: -1920, y: 0 }, [layer]);
    const right = composeLayers({ width: 1920, height: 1080 }, { x: 0, y: 0 }, [layer]);
    assert.deepEqual(px(left, 1920, 1820, 50), GREEN, 'the window starts 100px before the left display ends');
    assert.deepEqual(px(left, 1920, 1819, 50), [...MASK_BGRA]);
    assert.deepEqual(px(left, 1920, 1919, 149), GREEN);
    assert.deepEqual(px(left, 1920, 1919, 150), [...MASK_BGRA]);
    assert.deepEqual(px(right, 1920, 0, 50), BLUE, 'x = 0 is the first column of the primary');
    assert.deepEqual(px(right, 1920, 199, 149), GREEN);
    assert.deepEqual(px(right, 1920, 200, 50), [...MASK_BGRA]);
});

test('a region canvas is offset by the region, and a layer is stretched over its rect', () => {
    // The screen frame came back at half size: 960x540 pixels for a 1920x1080
    // display. Its layer still lands on physical pixels.
    const frame = flat(960, 540, GREEN);
    for (let y = 0; y < 540; y += 1) for (let x = 480; x < 960; x += 1) frame.data.set(BLUE, (y * 960 + x) * 4);
    const out = composeLayers({ width: 200, height: 100 }, { x: 900, y: 500 }, [
        { image: frame, rect: r(0, 0, 1920, 1080), clip: [r(0, 0, 1920, 1080)] }
    ]);
    assert.deepEqual(px(out, 200, 59, 0), GREEN, 'x = 959 is the left half');
    assert.deepEqual(px(out, 200, 60, 0), BLUE, 'x = 960 is the right half');
});

test('a layer whose buffer is not its stated size paints nothing', () => {
    const out = composeLayers({ width: 10, height: 10 }, { x: 0, y: 0 }, [
        { image: { data: new Uint8Array(12), width: 10, height: 10 }, rect: r(0, 0, 10, 10), clip: [r(0, 0, 10, 10)] }
    ]);
    assert.deepEqual(px(out, 10, 5, 5), [...MASK_BGRA]);
});

test('coveredFraction counts overlapping covers once', () => {
    assert.equal(coveredFraction(r(0, 0, 100, 100), []), 0);
    assert.equal(coveredFraction(r(0, 0, 100, 100), [r(0, 0, 50, 100), r(0, 0, 50, 100)]), 0.5);
    assert.equal(coveredFraction(r(0, 0, 100, 100), [r(-50, -50, 300, 300)]), 1);
    assert.equal(coveredFraction(r(0, 0, 100, 100), [r(0, 0, 50, 50), r(25, 0, 50, 50)]), 0.375);
});
