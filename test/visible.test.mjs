import test from 'node:test';
import assert from 'node:assert/strict';

import { visibleRegions, both, toImage, maskBitmap, MASK_BGRA } from '../dist-test/visible.js';

const r = (x, y, width, height) => ({ x, y, width, height });
const area = rects => rects.reduce((s, x) => s + x.width * x.height, 0);

test('only a shared window on top is shown, minus what covers it', () => {
    // Front first: a video window over the right half of the shared editor.
    const stack = [
        { rect: r(500, 0, 500, 400), shared: false },
        { rect: r(0, 0, 1000, 400), shared: true }
    ];
    const shown = visibleRegions(stack, 0);
    assert.equal(area(shown), 500 * 400);
    assert.ok(shown.every(s => s.x + s.width <= 500), 'nothing of the covered half');
});

test('nothing is shown when nothing is shared, and an unshared window over the desktop stays hidden', () => {
    assert.deepEqual(visibleRegions([{ rect: r(0, 0, 800, 600), shared: false }]), []);
    assert.deepEqual(visibleRegions([]), []);
});

test('a shared window is pulled in at its edges, and an unshared one pushed out over it', () => {
    const alone = visibleRegions([{ rect: r(100, 100, 200, 100), shared: true }], 2);
    assert.deepEqual(alone, [r(102, 102, 196, 96)]);
    // A shadow spilling from an unshared window above eats two more pixels.
    const covered = visibleRegions([{ rect: r(0, 0, 150, 300), shared: false }, { rect: r(100, 100, 200, 100), shared: true }], 2);
    assert.ok(covered.every(s => s.x >= 152), JSON.stringify(covered));
});

test('our see-through overlay neither shows nor hides anything', () => {
    const stack = [
        { rect: r(0, 0, 1920, 1080), shared: false, ignore: true },
        { rect: r(10, 10, 100, 100), shared: true }
    ];
    assert.equal(area(visibleRegions(stack, 0)), 100 * 100);
});

test('a shared window behind another shared window shows only where it is not covered', () => {
    const stack = [
        { rect: r(0, 0, 100, 100), shared: true },
        { rect: r(50, 50, 100, 100), shared: true }
    ];
    assert.equal(area(visibleRegions(stack, 0)), 100 * 100 + (100 * 100 - 50 * 50));
});

test('only what was shown in both readings is kept', () => {
    const before = [r(0, 0, 100, 100)];
    const after = [r(50, 0, 100, 100)];
    assert.deepEqual(both(before, after), [r(50, 0, 50, 100)]);
    assert.deepEqual(both(before, []), []);
});

test('rects are moved into an image and scaled outward to whole pixels', () => {
    assert.deepEqual(toImage([r(1930, 10, 100, 50)], { x: 1920, y: 0 }, 0.5), [r(5, 5, 50, 25)]);
    assert.deepEqual(toImage([r(1, 1, 3, 3)], { x: 0, y: 0 }, 0.5), [r(0, 0, 2, 2)]);
});

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
