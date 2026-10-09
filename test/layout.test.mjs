import test from 'node:test';
import assert from 'node:assert/strict';
import {
    classify,
    dockStrip,
    edgeArrow,
    elsewhereText,
    leadDisplay,
    localPart,
    nearestIsHere,
    opensDownward,
    overStrip,
    overlapArea,
    parseUserAnswer,
    placeCaptions,
    reportsHover,
    ringShape,
    routeTo,
    shapeBounds,
    showsStrip,
    stepBadge,
    stepCues,
    stripProgress,
    takesMouse,
    timeLeft,
    visibleFraction,
    waitingNote,
    wrapText
} from '../dist-test/layout.js';
import { DEFAULT_COLORS, contrastRatio, parseColor, relativeLuminance, textOn } from '../dist-test/palette.js';

/**
 * The overlay's placement rules, checked without a window. The renderer only
 * measures text and paints what these return, so a caption landing on its
 * target or a strip covering a menu bar is caught here.
 */

const VIEW = { width: 1920, height: 1080 };
/** 8 DIP per character: close enough to a 14px UI font for layout purposes. */
const measure = s => s.length * 8;

const ann = (over = {}) => ({
    id: 'a1',
    displayId: 'd1',
    type: 'circle',
    rect: { x: 100, y: 100, width: 80, height: 30 },
    createdAt: 1,
    ...over
});

// ------------------------------------------------------------------ captions

test('a caption for a target at the top edge goes beside it, never onto it', () => {
    // A "File" menu at y=0, padded by 8 the way highlight_and_wait pads it.
    const target = { x: 2, y: -8, width: 60, height: 40 };
    const [c] = placeCaptions([{ id: 'c', size: { width: 120, height: 30 }, target, opensDown: true }], VIEW, []);
    assert.equal(overlapArea(c.box, target), 0, 'the old fallback put the chip at y+6, inside the tab');
    assert.ok(c.box.x >= target.x + target.width, 'right of it, not below the menu it opens');
});

test('captions are placed above first and never pile onto each other', () => {
    const t1 = { x: 500, y: 500, width: 100, height: 30 };
    const t2 = { x: 520, y: 540, width: 100, height: 30 };
    const boxes = placeCaptions(
        [
            { id: 'one', size: { width: 140, height: 30 }, target: t1 },
            { id: 'two', size: { width: 140, height: 30 }, target: t2 }
        ],
        VIEW,
        []
    );
    assert.ok(boxes[0].box.y + boxes[0].box.height <= t1.y, 'first caption sits above its target');
    assert.equal(overlapArea(boxes[0].box, boxes[1].box), 0);
    for (const b of boxes) {
        assert.equal(overlapArea(b.box, t1), 0);
        assert.equal(overlapArea(b.box, t2), 0);
    }
});

test('captions keep off obstacles such as the step strip and the chat panel', () => {
    const target = { x: 900, y: 120, width: 100, height: 30 };
    const strip = { x: 700, y: 60, width: 500, height: 56 };
    const [c] = placeCaptions([{ id: 'c', size: { width: 140, height: 30 }, target }], VIEW, [strip]);
    assert.equal(overlapArea(c.box, strip), 0);
    assert.equal(overlapArea(c.box, target), 0);
});

test('below is the last resort for something that opens a menu', () => {
    // No room above, right or left: a full-width ribbon tab row.
    const target = { x: 0, y: 0, width: 1920, height: 40 };
    const free = placeCaptions([{ id: 'c', size: { width: 140, height: 30 }, target }], VIEW, []);
    assert.ok(free[0].box.y >= 40, 'an ordinary target falls back to below');
    const menu = placeCaptions([{ id: 'c', size: { width: 140, height: 30 }, target, opensDown: true }], VIEW, []);
    assert.ok(menu[0].box.y >= 40, 'still below when every other spot covers the target');
});

test('a caption stays on the display and gets a leader when pushed away from its target', () => {
    // A control hanging off the bottom of the display: the chip is clamped
    // back on screen, away from it, so a leader shows what it belongs to.
    const target = { x: 500, y: 1100, width: 50, height: 50 };
    const [c] = placeCaptions([{ id: 'c', size: { width: 200, height: 30 }, target }], VIEW, []);
    assert.ok(c.box.y >= 0 && c.box.y + c.box.height <= VIEW.height);
    assert.ok(c.leader, 'leader drawn');
    const [near] = placeCaptions([{ id: 'c', size: { width: 200, height: 30 }, target: { ...target, y: 500 } }], VIEW, []);
    assert.equal(near.leader, undefined, 'no leader when it sits right next to it');
});

test('a label keeps its centred spot above its point', () => {
    const [c] = placeCaptions(
        [{ id: 'l', size: { width: 100, height: 30 }, target: { x: 400, y: 300, width: 0, height: 0 }, mode: 'above-point' }],
        VIEW,
        []
    );
    assert.deepEqual(c.box, { x: 350, y: 264, width: 100, height: 30 });
    assert.equal(c.leader, undefined);
});

test('long prompts wrap into at most three lines and end in an ellipsis', () => {
    const long = 'Open the File menu, then choose Export, then pick PNG from the list of formats and press Save';
    const lines = wrapText(long, 160, measure);
    assert.equal(lines.length, 3);
    for (const l of lines) assert.ok(measure(l) <= 160, l);
    assert.ok(lines[2].endsWith('\u2026'));
    assert.deepEqual(wrapText('Click Save', 160, measure), ['Click Save']);
    const path = wrapText('C:\\Users\\someone\\AppData\\Roaming\\thing', 80, measure);
    for (const l of path) assert.ok(measure(l) <= 80, 'an unbreakable word is split');
});

test('menus, tabs and dropdowns open downward', () => {
    for (const r of ['menuitem', 'menu item', 'tabitem', 'menubar', 'combobox', 'splitbutton']) assert.ok(opensDownward(r), r);
    for (const r of ['button', 'edit', undefined]) assert.equal(opensDownward(r), false, String(r));
});

// --------------------------------------------------------------------- ring

test('wide targets get a rounded rect whose corners still enclose the control', () => {
    assert.deepEqual(ringShape({ x: 0, y: 0, width: 60, height: 50 }, 8), { kind: 'ellipse' });
    // The 400x24 field padded by 8: radius is half the padded height.
    assert.deepEqual(ringShape({ x: 0, y: 0, width: 416, height: 40 }, 8), { kind: 'rounded', radius: 20 });
    // A tall-wide control: a full stadium would cut its corners, so the radius is capped.
    const pad = 8;
    const ring = ringShape({ x: 0, y: 0, width: 416, height: 76 }, pad);
    assert.equal(ring.kind, 'rounded');
    assert.ok(ring.radius < 38);
    // The control's corner sits at (pad, pad) from the padded corner; the arc's
    // centre is at (r, r). Inside the arc means within r of that centre.
    const d = Math.hypot(ring.radius - pad, ring.radius - pad);
    assert.ok(d <= ring.radius, `corner ${d.toFixed(1)} outside radius ${ring.radius}`);
});

// ------------------------------------------------------------ step badges

test('short step text is the badge; longer text is a caption beside a number', () => {
    assert.deepEqual(stepBadge('2', 5), { badge: '2' });
    assert.deepEqual(stepBadge('A', 1), { badge: 'A' });
    assert.deepEqual(stepBadge(undefined, 4), { badge: '4' });
    assert.deepEqual(stepBadge('Click Save', 3), { badge: '3', caption: 'Click Save' });
    assert.deepEqual(stepBadge('3. Click Save', 1), { badge: '3', caption: 'Click Save' });
    assert.deepEqual(stepBadge('2/5 Click Export', 1), { badge: '2', caption: '2/5 Click Export' });
});

test('the strip shows progress from the step or from the prompt prefix', () => {
    const step = { id: 's', prompt: '2/5 Click Export', mode: 'watch', count: 0, collected: 0, startedAt: 0, deadline: 0, targetIds: [], keys: {} };
    assert.deepEqual(stripProgress(step), { progress: { n: 2, of: 5 }, prompt: 'Click Export' });
    assert.deepEqual(stripProgress({ ...step, prompt: 'Click Export', progress: { n: 1, of: 3 } }), {
        progress: { n: 1, of: 3 },
        prompt: 'Click Export'
    });
    assert.deepEqual(stripProgress({ ...step, prompt: 'Click Export' }), { progress: undefined, prompt: 'Click Export' });
});

test('time left reads as minutes and seconds', () => {
    assert.equal(timeLeft(78_000, 0), '1:18 left');
    assert.equal(timeLeft(500, 0), '0:01 left');
    assert.equal(timeLeft(0, 5000), '0:00 left');
});

// -------------------------------------------------------------------- strip

test('the strip docks away from a target in the menu bar', () => {
    const wa = { x: 0, y: 0, width: 1920, height: 1040 };
    const size = { width: 520, height: 70 };
    const free = dockStrip(size, wa, [{ x: 1500, y: 600, width: 80, height: 30 }], []);
    assert.equal(free.y, 24, 'top centre when nothing is there');
    const menu = { x: 900, y: 30, width: 80, height: 30 };
    const moved = dockStrip(size, wa, [menu], []);
    assert.equal(overlapArea(moved, menu), 0);
    assert.equal(moved.y, 1040 - 70 - 24, 'bottom centre next, inset from the work area');
});

test('the strip respects a taskbar on any edge', () => {
    const wa = { x: 0, y: 48, width: 1920, height: 1032 };
    const box = dockStrip({ width: 400, height: 60 }, wa, [], []);
    assert.equal(box.y, 72);
});

// ------------------------------------------------------------------ routing

test('every display gets every drawing, in its own coordinates', () => {
    const origins = new Map([
        ['d1', { x: 0, y: 0 }],
        ['d2', { x: 1920, y: 0 }]
    ]);
    const a = ann({ displayId: 'd1', rect: { x: 1880, y: 100, width: 80, height: 30 } });
    const arrow = ann({ id: 'a2', type: 'arrow', displayId: 'd2', rect: { x: 10, y: 10, width: 0, height: 0 }, to: { x: 50, y: 60 } });
    const onD2 = routeTo([a, arrow, ann({ id: 'gone', displayId: 'd9' })], origins, { x: 1920, y: 0 });
    assert.equal(onD2.length, 2, 'a drawing whose display is gone is dropped');
    assert.deepEqual(onD2[0].rect, { x: -40, y: 100, width: 80, height: 30 }, 'straddles onto d2 from the left');
    assert.equal(onD2[0].displayId, 'd1', 'keeps its home display');
    assert.deepEqual(onD2[1].to, { x: 50, y: 60 });
    assert.equal(classify(shapeBounds(onD2[0]), VIEW, [{ x: -1920, y: 0, width: 1920, height: 1080 }]), 'here');
});

test('a level or upright arrow crossing onto another display is drawn there too', () => {
    const side = new Map([
        ['d1', { x: 0, y: 0 }],
        ['d2', { x: 1920, y: 0 }]
    ]);
    const level = ann({ id: 'h', type: 'arrow', displayId: 'd1', rect: { x: 1800, y: 500, width: 0, height: 0 }, to: { x: 2100, y: 500 } });
    const [onD2] = routeTo([level], side, { x: 1920, y: 0 });
    assert.equal(classify(shapeBounds(onD2), VIEW, [{ x: -1920, y: 0, width: 1920, height: 1080 }]), 'here');
    const [onD1] = routeTo([level], side, { x: 0, y: 0 });
    assert.equal(classify(shapeBounds(onD1), VIEW, [{ x: 1920, y: 0, width: 1920, height: 1080 }]), 'here');

    const stacked = new Map([
        ['d1', { x: 0, y: 0 }],
        ['d2', { x: 0, y: 1080 }]
    ]);
    const upright = ann({ id: 'v', type: 'arrow', displayId: 'd1', rect: { x: 500, y: 1000, width: 0, height: 0 }, to: { x: 500, y: 1200 } });
    const [below] = routeTo([upright], stacked, { x: 0, y: 1080 });
    assert.equal(classify(shapeBounds(below), VIEW, [{ x: 0, y: -1080, width: 1920, height: 1080 }]), 'here');
});

test('a shape mostly off every display is "off"; one on another monitor is "elsewhere"', () => {
    const others = [{ x: 1920, y: 0, width: 1920, height: 1080 }];
    assert.equal(classify({ x: 2000, y: 100, width: 50, height: 50 }, VIEW, others), 'elsewhere');
    assert.equal(classify({ x: 100, y: -200, width: 50, height: 210 }, VIEW, others), 'off', 'under a quarter visible');
    assert.equal(classify({ x: 100, y: 100, width: 50, height: 50 }, VIEW, others), 'here');
    assert.equal(visibleFraction({ x: 1900, y: 0, width: 40, height: 10 }, [{ x: 0, y: 0, ...VIEW }, ...others]), 1);
    assert.ok(nearestIsHere({ x: 100, y: -500, width: 50, height: 50 }, VIEW, others));
    assert.equal(nearestIsHere({ x: 3000, y: -500, width: 50, height: 50 }, VIEW, others), false);
});

test('edge pointers sit inside the view and point out toward the target', () => {
    const { tip, tail, side } = edgeArrow({ x: 2500, y: 500, width: 40, height: 40 }, VIEW);
    assert.equal(side, 'right');
    assert.ok(tip.x <= VIEW.width && tip.x > tail.x);
    assert.match(elsewhereText('right'), /right-hand screen/);
    assert.match(elsewhereText('top'), /screen above/);
});

test('the lead display holds the step target, else the primary', () => {
    const step = { targetIds: ['a1'] };
    const live = new Set(['d1', 'd2']);
    assert.equal(leadDisplay(step, [ann({ displayId: 'd2', hidden: true })], 'd1', live), 'd2', 'a hidden target still leads');
    assert.equal(leadDisplay(step, [], 'd1', live), 'd1');
    assert.equal(leadDisplay(null, [ann()], 'd1', live), 'd1');
});

test('a target whose display was unplugged does not take the strip with it', () => {
    const step = { targetIds: ['a1', 'a2'] };
    const gone = ann({ displayId: 'd2', hidden: true });
    assert.equal(leadDisplay(step, [gone], 'd1', new Set(['d1'])), 'd1', 'back to the primary');
    const second = ann({ id: 'a2', displayId: 'd3' });
    assert.equal(leadDisplay(step, [gone, second], 'd1', new Set(['d1', 'd3'])), 'd3', 'or the next target that is still on a display');
});

test('the strip shows on the lead, and on every display for a click with no target', () => {
    const watch = { mode: 'watch', targetIds: ['a1'] };
    assert.equal(showsStrip(watch, true), true);
    assert.equal(showsStrip(watch, false), false);
    assert.equal(showsStrip({ mode: 'click', targetIds: ['a1'] }, false), false, 'a circled click points from the other displays');
    assert.equal(showsStrip({ mode: 'click', targetIds: [] }, false), true, 'every display takes the click, so every one explains it');
    assert.equal(showsStrip(null, true), false);
});

test('while every step target is hidden, the strip says what it is waiting for', () => {
    const step = { targetIds: ['a1'] };
    // Shaped like what placeAnchored stores: a name or nothing as the label, the window's title as app.
    const anchored = (anchor, over = {}) => ann({ hidden: true, anchor: { kind: 'element', ref: 'el_3', fit: true, pad: 8, ...anchor }, ...over });
    const save = { label: 'Save', app: 'Untitled - Notepad', selector: { window: '0x1A2B', name: 'Save' } };

    assert.equal(
        waitingNote(step, [anchored(save, { hiddenReason: 'minimized' })]),
        'Waiting for “Untitled - Notepad” to come back: it was minimised. Restore it to carry on.'
    );
    assert.match(waitingNote(step, [anchored(save, { hiddenReason: 'closed' })]), /“Untitled - Notepad”.*closed/);
    assert.match(waitingNote(step, [anchored(save, { hiddenReason: 'other-desktop' })]), /another virtual desktop/);
    assert.match(
        waitingNote(step, [anchored({ kind: 'window', ref: '0x1A2B', label: 'Paint', app: 'Paint' }, { hiddenReason: 'minimized' })]),
        /^Waiting for “Paint”/,
        'a window anchor names its own title'
    );
    // A menu that closed: the window is still there, so the control is named.
    const menuItem = { ref: 'el_9', label: 'Save As…', app: 'Notepad' };
    assert.match(waitingNote(step, [anchored(menuItem)]), /^Waiting for “Save As…” to come back: it is no longer on screen/);
    assert.equal(
        waitingNote(step, [anchored({ ...menuItem, label: '' })]),
        'Waiting for the target in “Notepad” to come back: it is no longer on screen.',
        'a control with no name: where it was, not as if the window had gone'
    );
    const row = { ref: 'el_5', label: `Alice Smith, Re: Q3 budget, ${'attached is the draft '.repeat(10)}2:14 PM`, app: 'Mail' };
    const note = waitingNote(step, [anchored(row)]);
    assert.ok(note.length < 120, note);
    assert.match(note, /^Waiting for “Alice Smith, Re: Q3 budget, attached is.*…” to come back/);
    // A bare ref nothing was known about: no name, no title, and never the ref.
    assert.equal(waitingNote(step, [anchored({ ref: 'el_4', label: '' }, { hiddenReason: 'closed' })]), 'Waiting for the app to come back: it was closed.');
    assert.match(waitingNote(step, [anchored({ ref: 'el_4', label: '' })]), /^Waiting for the target/);

    assert.equal(waitingNote(step, [ann()]), undefined, 'a visible target needs no note');
    assert.equal(waitingNote({ targetIds: ['a1', 'a2'] }, [anchored(save), ann({ id: 'a2' })]), undefined, 'one target still showing is enough');
    assert.equal(waitingNote({ targetIds: [] }, [anchored(save)]), undefined, 'a step without a target');
    assert.equal(waitingNote(null, [anchored(save)]), undefined);
});

test('an overlay takes the mouse only with a live page, while picking or hovered', () => {
    assert.equal(takesMouse({ live: true, picking: false, hovered: false }), false, 'click-through by default');
    assert.equal(takesMouse({ live: true, picking: true, hovered: false }), true);
    assert.equal(takesMouse({ live: true, picking: false, hovered: true }), true);
    // A crashed or hung page would be an invisible sheet swallowing the click step's clicks.
    assert.equal(takesMouse({ live: false, picking: true, hovered: true }), false);
});

test('the pointer is over a strip given in its display local DIPs, with slack', () => {
    const origin = { x: 1920, y: 0 };
    const strip = { x: 700, y: 24, width: 500, height: 80 };
    assert.equal(overStrip({ x: 2700, y: 60 }, origin, strip), true);
    assert.equal(overStrip({ x: 2617, y: 60 }, origin, strip), true, 'within the slack of its left edge');
    assert.equal(overStrip({ x: 700 + 20, y: 60 }, origin, strip), false, 'the same local point on another display');
    assert.equal(overStrip({ x: 2700, y: 200 }, origin, strip), false);
    assert.equal(overStrip({ x: 2700, y: 60 }, origin, null), false, 'no strip shown');
    // What main hovers by itself when a strip docks under a still pointer: the rect alone.
    assert.equal(overStrip({ x: 2617, y: 60 }, origin, strip, 0), false, 'beside the strip is the app');
    assert.equal(overStrip({ x: 2620, y: 60 }, origin, strip, 0), true, 'its edge is the strip');
});

test('after a new strip rect the renderer reports the pointer whichever way it lies', () => {
    // Main may have hovered the new strip by itself; leaving it must be heard.
    assert.equal(reportsHover(null, false, 0), true);
    assert.equal(reportsHover(null, true, 0), true);
    assert.equal(reportsHover(false, false, 1000), false, 'nothing new to say');
    assert.equal(reportsHover(true, false, 0), true, 'leaving');
    assert.equal(reportsHover(true, true, 50), false);
    assert.equal(reportsHover(true, true, 250), true, 'over is repeated for main\'s failsafe');
});

test('the chat panel is excluded only where it overlaps a display', () => {
    const display = { x: 1920, y: 0, width: 1920, height: 1080 };
    assert.deepEqual(localPart({ x: 3400, y: 500, width: 420, height: 580 }, display), { x: 1480, y: 500, width: 420, height: 580 });
    assert.equal(localPart({ x: 100, y: 100, width: 420, height: 580 }, display), null);
});

test('only well-formed answers from a renderer are accepted', () => {
    assert.deepEqual(parseUserAnswer({ kind: 'done' }), { kind: 'done' });
    assert.deepEqual(parseUserAnswer({ kind: 'choice', index: 1 }), { kind: 'choice', index: 1 });
    assert.deepEqual(parseUserAnswer({ kind: 'stuck' }), { kind: 'stuck' });
    assert.equal(parseUserAnswer({ kind: 'choice', index: -1 }), null);
    assert.equal(parseUserAnswer({ kind: 'clicks' }), null);
    assert.equal(parseUserAnswer(null), null);
    assert.equal(parseUserAnswer({ kind: 'reply' }), null);
});

// --------------------------------------------------------------- sound cues

test('a fresh page only notes the step and check marks already on screen', () => {
    const frame = (over = {}) => ({ displayId: 'd1', cues: true, lead: true, step: { id: 's1' }, annotations: [], ...over });
    const tick = ann({ id: 'done1', type: 'done' });

    // A page reloaded mid-step, possibly every 10 s: no start tone, no done tone.
    const first = stepCues(null, frame({ annotations: [tick] }));
    assert.deepEqual([first.start, first.done], [false, false]);
    const again = stepCues(first.heard, frame({ annotations: [tick] }));
    assert.deepEqual([again.start, again.done], [false, false], 'nothing new');

    const next = stepCues(again.heard, frame({ step: { id: 's2' }, annotations: [tick, ann({ id: 'done2', type: 'done' })] }));
    assert.deepEqual([next.start, next.done], [true, true], 'a new step and a new check mark still chime');
    assert.equal(stepCues(again.heard, frame({ step: { id: 's2' }, lead: false })).start, false, 'only the lead starts a step');
    assert.equal(stepCues(again.heard, frame({ step: { id: 's2' }, cues: false })).start, false, 'cues switched off');
    const elsewhere = stepCues(again.heard, frame({ annotations: [tick, ann({ id: 'done3', type: 'done', displayId: 'd2' })] }));
    assert.equal(elsewhere.done, false, 'a check mark chimes on its own display only');
});

// ------------------------------------------------------------------ palette

test('badge text is whichever of dark or light reads better on the fill', () => {
    assert.equal(textOn('#ffd60a'), '#111111', 'yellow');
    assert.equal(textOn('#ffffff'), '#111111');
    assert.equal(textOn(DEFAULT_COLORS.step), '#ffffff');
    assert.equal(textOn('rgba(0, 0, 0, 1)'), '#ffffff');
    assert.equal(textOn('not a colour'), '#ffffff');
});

test('colour parsing and contrast follow WCAG', () => {
    assert.deepEqual(parseColor('#f0a'), [255, 0, 170]);
    assert.deepEqual(parseColor('#ff2d95cc'), [255, 45, 149]);
    assert.deepEqual(parseColor('rgb(10, 20, 30)'), [10, 20, 30]);
    assert.equal(parseColor('red'), null);
    const white = relativeLuminance([255, 255, 255]);
    const black = relativeLuminance([0, 0, 0]);
    assert.equal(contrastRatio(white, black), 21);
    // White badge text on the default step colour clears AA for large text.
    assert.ok(contrastRatio(white, relativeLuminance(parseColor(DEFAULT_COLORS.step))) >= 4.5);
});
