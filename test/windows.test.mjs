import test from 'node:test';
import assert from 'node:assert/strict';

import { isWindowRef, matchWindow, windowLine } from '../dist-test/windows.js';

const R = { x: 0, y: 0, width: 800, height: 600 };
const w = (ref, title, foreground = false) => ({ ref, title, rect: R, foreground });

// list_windows order is z-order: the first entry is frontmost.
const desktop = [
    w('100', 'Untitled - Notepad'),
    w('200', 'Inbox - Outlook', true),
    w('300', 'Notepad++'),
    w('400', 'notepad')
];

test('numeric refs are recognised, titles are not', () => {
    assert.equal(isWindowRef('330312'), true);
    assert.equal(isWindowRef(' -42 '), true);
    assert.equal(isWindowRef('Notepad'), false);
    assert.equal(isWindowRef('3 windows'), false);
});

test('"foreground" picks the foreground window', () => {
    assert.equal(matchWindow('foreground', desktop).ref, '200');
    assert.equal(matchWindow('Active', desktop).ref, '200');
});

test('"foreground" falls back to the frontmost window when none has focus', () => {
    // e.g. the overlay's own panel is focused, and it is excluded from the list.
    assert.equal(matchWindow('foreground', [w('1', 'A'), w('2', 'B')]).ref, '1');
});

test('an exact title beats a substring match', () => {
    assert.equal(matchWindow('notepad', desktop).ref, '400');
});

test('a substring match prefers the frontmost window', () => {
    assert.equal(matchWindow('NOTEPAD ', desktop.slice(0, 3)).ref, '100');
});

test('a substring match prefers the foreground window', () => {
    const list = [w('1', 'Chrome - A'), w('2', 'Chrome - B', true)];
    assert.equal(matchWindow('chrome', list).ref, '2');
});

test('no match explains itself and lists what is open', () => {
    const err = matchWindow('Photoshop', desktop);
    assert.equal(typeof err, 'string');
    assert.match(err, /no window title contains "Photoshop"/);
    assert.match(err, /200 "Inbox - Outlook"/);
});

test('an empty desktop says so', () => {
    assert.equal(matchWindow('x', []), 'no visible windows');
});

test('window lines are one compact line each', () => {
    assert.equal(
        windowLine({ ref: '7', title: 'A\nB', rect: { x: -8, y: 0, width: 10, height: 20 }, foreground: true }),
        '7 10x20@-8,0 A B [foreground]'
    );
});

import { pickWindow, windowBlocker, coverVerdict, nearlyUniform, windowOffsets } from '../dist-test/windows.js';

const flagged = (ref, title, flags) => ({ ...w(ref, title), ...flags });

test('window lines name what stops a window being used', () => {
    assert.equal(windowLine(flagged('1', 'Task Manager', { elevated: true })), '1 800x600@0,0 Task Manager [admin]');
    assert.equal(windowLine(flagged('2', 'Paint', { hung: true })), '2 800x600@0,0 Paint [not responding]');
    assert.equal(windowLine(flagged('3', 'Notes', { minimized: true })), '3 800x600@0,0 Notes [minimized]');
    assert.equal(windowLine(flagged('4', 'Mail', { cloaked: true })), '4 800x600@0,0 Mail [other desktop]');
});

test('a visible window wins over a minimised or other-desktop one', () => {
    const r = pickWindow('notepad', [flagged('1', 'Notepad', { minimized: true }), w('2', 'Notepad')]);
    assert.equal(r.window.ref, '2');
    assert.equal(r.note, undefined);
});

test('a minimised window is found, and says it is minimised', () => {
    const r = pickWindow('notepad', [w('1', 'Calculator'), flagged('2', 'Untitled - Notepad', { minimized: true })]);
    assert.equal(r.window.ref, '2');
    assert.match(r.note, /is minimized: focus_window restores it/);
});

test('minimised beats other-desktop, which still beats "not open"', () => {
    const both = [flagged('1', 'Notepad', { cloaked: true }), flagged('2', 'Notepad', { minimized: true })];
    assert.equal(pickWindow('notepad', both).window.ref, '2');
    const cloaked = pickWindow('notepad', [flagged('1', 'Notepad', { cloaked: true })]);
    assert.equal(cloaked.window.ref, '1');
    assert.match(cloaked.note, /another virtual desktop/);
});

test('"foreground" never falls back to a window the user cannot see', () => {
    assert.equal(typeof pickWindow('foreground', [flagged('1', 'A', { minimized: true })]), 'string');
});

test('no match anywhere lists the visible windows', () => {
    const r = pickWindow('Photoshop', [w('1', 'Calculator'), flagged('2', 'Notepad', { minimized: true })]);
    assert.match(r, /no window title contains "Photoshop". Open windows: 1 "Calculator"/);
});

test('window blockers name the next step', () => {
    assert.equal(
        windowBlocker(flagged('1', 'Notes', { minimized: true }), 'draw'),
        '"Notes" is minimized: focus_window restores it, then draw.'
    );
    assert.match(windowBlocker(flagged('1', 'Notes', { hung: true }), 'draw'), /not responding/);
    assert.equal(windowBlocker(w('1', 'Notes'), 'draw'), null);
});

test('a target counts as covered when its centre is, or more than half of it', () => {
    assert.equal(coverVerdict({ fraction: 0.2, centre_covered: true, by: ['Google Chrome'] }), 'Google Chrome');
    assert.equal(coverVerdict({ fraction: 0.6, centre_covered: false, by: ['A', 'B', 'C'] }), 'A, B');
    assert.equal(coverVerdict({ fraction: 0.3, centre_covered: false, by: ['Toolbar'] }), null);
    assert.equal(coverVerdict({ fraction: 1, centre_covered: true, by: [] }), 'another window');
});

test('a flat render is recognised, a real one is not', () => {
    const black = new Uint8Array(200 * 100 * 4);
    assert.equal(nearlyUniform(black, 200, 100), true);
    const withTitleBar = new Uint8Array(black);
    for (let i = 0; i < 200 * 20 * 4; i += 1) withTitleBar[i] = 230;
    assert.equal(nearlyUniform(withTitleBar, 200, 100), false);
    assert.equal(nearlyUniform(new Uint8Array(0), 0, 0), true);
});

test("OCR rects become offsets from the window's visible top-left", () => {
    // A render that includes a 7px invisible border on the left, at half scale.
    const r = windowOffsets({ x: 50, y: 20, width: 40, height: 10 }, 0.5, { x: 93, y: 100 }, { x: 100, y: 100 });
    assert.deepEqual(r, { x: 93, y: 40, width: 80, height: 20 });
});
