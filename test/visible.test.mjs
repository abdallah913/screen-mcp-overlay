import test from 'node:test';
import assert from 'node:assert/strict';

import {
    visibleRegions,
    both,
    toImage,
    maskBitmap,
    composeLayers,
    coveredFraction,
    unsharedOver,
    MASK_BGRA,
    SHARED_INSET_PX,
    OCCLUDER_SHADOW_PX
} from '../dist-test/visible.js';

const r = (x, y, width, height) => ({ x, y, width, height });
const area = rects => rects.reduce((s, x) => s + x.width * x.height, 0);

test('only a shared window on top is shown, minus what covers it', () => {
    // Front first: a video window over the right half of the shared editor.
    const stack = [
        { rect: r(500, 0, 500, 400), shared: false },
        { rect: r(0, 0, 1000, 400), shared: true }
    ];
    const shown = visibleRegions(stack, 0, 0);
    assert.equal(area(shown), 500 * 400);
    assert.ok(shown.every(s => s.x + s.width <= 500), 'nothing of the covered half');
});

test('nothing is shown when nothing is shared, and an unshared window over the desktop stays hidden', () => {
    assert.deepEqual(visibleRegions([{ rect: r(0, 0, 800, 600), shared: false }]), []);
    assert.deepEqual(visibleRegions([]), []);
});

test('the margins cover a Windows 11 corner and a drop shadow', () => {
    assert.ok(SHARED_INSET_PX >= 10, `shared windows pulled in by ${SHARED_INSET_PX}px`);
    assert.ok(OCCLUDER_SHADOW_PX >= 20, `other windows pushed out by ${OCCLUDER_SHADOW_PX}px`);
});

test('a shared window is pulled in at its edges, and an unshared one pushed out over it', () => {
    const alone = visibleRegions([{ rect: r(100, 100, 200, 100), shared: true }]);
    const k = SHARED_INSET_PX;
    assert.deepEqual(alone, [r(100 + k, 100 + k, 200 - 2 * k, 100 - 2 * k)]);
    // The shadow spilling from an unshared window above is masked with it.
    const covered = visibleRegions([{ rect: r(0, 0, 150, 300), shared: false }, { rect: r(100, 100, 200, 100), shared: true }]);
    assert.ok(covered.length > 0);
    assert.ok(covered.every(s => s.x >= 150 + OCCLUDER_SHADOW_PX), JSON.stringify(covered));
});

/** BGRA colours for the masking tests: a private window, a shared one, a shadow on it. */
const PRIVATE = [0, 0, 255, 255];
const SHARED = [0, 200, 0, 255];
const SHADOW = [40, 40, 40, 255];

function paint(buf, w, rect, colour, keep = () => true) {
    for (let y = rect.y; y < rect.y + rect.height; y += 1) {
        for (let x = rect.x; x < rect.x + rect.width; x += 1) if (keep(x, y)) buf.set(colour, (y * w + x) * 4);
    }
}
function count(buf, colour) {
    let n = 0;
    for (let i = 0; i < buf.length; i += 4) if (buf[i] === colour[0] && buf[i + 1] === colour[1] && buf[i + 2] === colour[2]) n += 1;
    return n;
}

test("what shows through a shared window's rounded corners is masked", () => {
    // The private window fills the screen behind a shared one whose 8px
    // corners show it, as Windows 11 draws them.
    const W = 200, H = 200, R = 8;
    const screen = new Uint8Array(W * H * 4);
    paint(screen, W, r(0, 0, W, H), PRIVATE);
    const s = r(40, 40, 120, 120);
    const outside = (x, y) => {
        const cx = x < s.x + R ? s.x + R : x >= s.x + s.width - R ? s.x + s.width - R - 1 : null;
        const cy = y < s.y + R ? s.y + R : y >= s.y + s.height - R ? s.y + s.height - R - 1 : null;
        return cx !== null && cy !== null && (x - cx) ** 2 + (y - cy) ** 2 > R * R;
    };
    paint(screen, W, s, SHARED, (x, y) => !outside(x, y));
    const keep = toImage(visibleRegions([{ rect: s, shared: true }, { rect: r(0, 0, W, H), shared: false }]), { x: 0, y: 0 }, 1);
    const out = maskBitmap(screen, W, H, keep);
    assert.equal(count(out, PRIVATE), 0);
    assert.ok(count(out, SHARED) > 0);
});

test("an unshared window's drop shadow on a shared window is masked with it", () => {
    const W = 240, H = 180;
    const screen = new Uint8Array(W * H * 4);
    paint(screen, W, r(0, 0, W, H), SHARED);
    const p = r(20, 20, 80, 80);
    paint(screen, W, p, PRIVATE);
    // A 16px shadow right of and below it.
    paint(screen, W, r(p.x + p.width, p.y + 8, 16, p.height + 8), SHADOW);
    paint(screen, W, r(p.x + 8, p.y + p.height, p.width, 16), SHADOW);
    const keep = toImage(visibleRegions([{ rect: p, shared: false }, { rect: r(0, 0, W, H), shared: true }]), { x: 0, y: 0 }, 1);
    const out = maskBitmap(screen, W, H, keep);
    assert.equal(count(out, PRIVATE), 0);
    assert.equal(count(out, SHADOW), 0, 'the shadow outlines the private window');
    assert.ok(count(out, SHARED) > 0);
});
test('our see-through overlay neither shows nor hides anything', () => {
    const stack = [
        { rect: r(0, 0, 1920, 1080), shared: false, ignore: true },
        { rect: r(10, 10, 100, 100), shared: true }
    ];
    assert.equal(area(visibleRegions(stack, 0, 0)), 100 * 100);
});

test('unsharedOver: anything not shared in front of a window, or its shadow, counts; behind it or shared does not', () => {
    const win = r(100, 100, 800, 600);
    const at = (layer, clip = win) => unsharedOver([layer, { rect: win, shared: true }], 1, clip);
    assert.equal(at({ rect: r(600, 120, 900, 600), shared: false }), true, 'over part of it');
    assert.equal(at({ rect: r(910, 100, 100, 100), shared: false }), true, 'its shadow falls on it');
    assert.equal(at({ rect: r(100 + 800 + OCCLUDER_SHADOW_PX, 100, 100, 100), shared: false }), false, 'beyond its shadow');
    assert.equal(at({ rect: r(600, 120, 900, 600), shared: true }), false, 'a shared window');
    assert.equal(at({ rect: r(0, 0, 1920, 1080), shared: false, ignore: true }), false, 'our see-through overlay');
    assert.equal(at({ rect: r(600, 120, 900, 600), shared: false }, r(100, 100, 300, 600)), false, 'outside the part painted');
    // Behind it: what is there does not show through it on screen.
    assert.equal(unsharedOver([{ rect: win, shared: true }, { rect: r(0, 0, 1920, 1080), shared: false }], 0, win), false);
});

test('a shared window behind another shared window shows only where it is not covered', () => {
    const stack = [
        { rect: r(0, 0, 100, 100), shared: true },
        { rect: r(50, 50, 100, 100), shared: true }
    ];
    assert.equal(area(visibleRegions(stack, 0, 0)), 100 * 100 + (100 * 100 - 50 * 50));
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
