import test from 'node:test';
import assert from 'node:assert/strict';

import {
    toPhysicalPoint,
    toPhysicalRect,
    physicalToDipPoint,
    physicalToDipRect,
    physicalToImagePoint,
    clampRectToDisplay,
    fitScale
} from '../dist-test/geometry.js';

/**
 * Every coordinate bug in this project has been in this module or in something
 * that fed it: DPI-virtualised rectangles, dividing by a scale factor instead of
 * using screenToDipPoint, an unscoped search returning the wrong thing. Those
 * were all caught by eye, and one was asserted wrongly before it was measured.
 * These lock down the arithmetic that the eye cannot check quickly.
 *
 * The display below mirrors the real test machine: 2560x1440 at 1.25x, which is
 * where fractional scaling actually bites.
 */
const display = {
    id: '1',
    label: 'test',
    primary: true,
    scaleFactor: 1.25,
    dipBounds: { x: 0, y: 0, width: 2048, height: 1152 },
    physicalSize: { width: 2560, height: 1440 }
};

/** A 2560x1440 display captured down to 1200 on the long edge. */
const capture = {
    id: 'cap_1',
    displayId: '1',
    regionPhysical: { x: 0, y: 0, width: 2560, height: 1440 },
    imageSize: { width: 1200, height: 675 },
    imageScale: 1200 / 2560,
    path: '',
    createdAt: 0
};

test('image coordinates scale back to physical', () => {
    const p = toPhysicalPoint({ x: 600, y: 337.5 }, 'image', display, capture);
    assert.equal(Math.round(p.x), 1280);
    assert.equal(Math.round(p.y), 720);
});

test('image round-trips through physical without drift', () => {
    const original = { x: 431, y: 222 };
    const phys = toPhysicalPoint(original, 'image', display, capture);
    const back = physicalToImagePoint(phys, capture);
    assert.equal(Math.round(back.x), original.x);
    assert.equal(Math.round(back.y), original.y);
});

test('a cropped region offsets image coordinates by its origin', () => {
    const cropped = {
        ...capture,
        regionPhysical: { x: 400, y: 200, width: 800, height: 600 },
        imageSize: { width: 800, height: 600 },
        imageScale: 1
    };
    const p = toPhysicalPoint({ x: 10, y: 20 }, 'image', display, cropped);
    assert.deepEqual(p, { x: 410, y: 220 });
});

test('normalized coordinates map to the physical extent', () => {
    assert.deepEqual(toPhysicalPoint({ x: 0, y: 0 }, 'normalized', display), { x: 0, y: 0 });
    assert.deepEqual(toPhysicalPoint({ x: 1, y: 1 }, 'normalized', display), { x: 2560, y: 1440 });
});

test('dip coordinates scale by the display factor, not the image scale', () => {
    assert.deepEqual(toPhysicalPoint({ x: 100, y: 80 }, 'dip', display), { x: 125, y: 100 });
});

test('physical converts back to dip', () => {
    assert.deepEqual(physicalToDipPoint({ x: 125, y: 100 }, display), { x: 100, y: 80 });
});

test('rect conversion scales size as well as origin', () => {
    const r = toPhysicalRect({ x: 10, y: 20, width: 100, height: 50 }, 'dip', display);
    assert.deepEqual(r, { x: 12.5, y: 25, width: 125, height: 62.5 });
    assert.deepEqual(physicalToDipRect(r, display), { x: 10, y: 20, width: 100, height: 50 });
});

test('image rect conversion divides size by the image scale', () => {
    const r = toPhysicalRect({ x: 0, y: 0, width: 600, height: 300 }, 'image', display, capture);
    assert.equal(Math.round(r.width), 1280);
    assert.equal(Math.round(r.height), 640);
});

test('image space without a capture is rejected rather than guessed', () => {
    assert.throws(() => toPhysicalPoint({ x: 1, y: 1 }, 'image', display), /captureId/);
});

test('negative width and height are normalised, not clamped away', () => {
    // Agents sometimes send x2/y2 in the width/height slots.
    const r = clampRectToDisplay({ x: 500, y: 400, width: -200, height: -100 }, display);
    assert.deepEqual(r, { x: 300, y: 300, width: 200, height: 100 });
});

test('rects are clamped inside the display', () => {
    const r = clampRectToDisplay({ x: 2500, y: 1400, width: 400, height: 400 }, display);
    assert.equal(r.x + r.width <= display.physicalSize.width, true);
    assert.equal(r.y + r.height <= display.physicalSize.height, true);
});

test('a rect entirely off-screen still yields a usable rect', () => {
    const r = clampRectToDisplay({ x: -500, y: -500, width: 100, height: 100 }, display);
    assert.equal(r.width >= 1, true);
    assert.equal(r.height >= 1, true);
});

test('fitScale only shrinks, never enlarges', () => {
    assert.equal(fitScale({ width: 2560, height: 1440 }, 1568), 1568 / 2560);
    assert.equal(fitScale({ width: 800, height: 600 }, 1568), 1);
});

test('fitScale measures the long edge whichever way the display is oriented', () => {
    assert.equal(fitScale({ width: 600, height: 2000 }, 1000), 0.5);
});
