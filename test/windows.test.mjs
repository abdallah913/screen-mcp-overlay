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
