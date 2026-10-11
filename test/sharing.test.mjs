import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeDesktop, fakeHelper, harness, rect } from './support/fake-helper.mjs';

/*
 * What the AI may see: nothing until the user shares it, then that window and
 * the windows it owns, never a recycled handle, and never every window of a
 * browser at once.
 */

const { isShared, shareWindow, shareApp, resetSharing, sharingSummary, stopSharingEverything, answerStep, currentStep, askToShare } = harness;

const notepad = { ref: '100', pid: 11, title: 'Untitled - Notepad', exe: 'notepad.exe' };
const saveAs = { ref: '101', pid: 11, title: 'Save As', exe: 'notepad.exe', owner: '100', root_owner: '100' };
const picker = { ref: '102', pid: 98, title: 'Open', exe: 'pickerhost.exe', owner: '100', root_owner: '100' };
const video = { ref: '500', pid: 40, title: 'Lofi beats - YouTube - Google Chrome', exe: 'chrome.exe' };
const otherChrome = { ref: '501', pid: 40, title: 'Inbox - Gmail - Google Chrome', exe: 'chrome.exe' };
const all = [notepad, saveAs, picker, video, otherChrome];

test.beforeEach(() => resetSharing());

test('nothing is shared until the user shares it', () => {
    for (const w of all) assert.equal(isShared(w, all), false, w.title);
});

test('a shared window brings the windows it owns, even another process\'s', () => {
    shareWindow(notepad);
    assert.equal(isShared(notepad, all), true);
    assert.equal(isShared(saveAs, all), true, 'its dialog');
    assert.equal(isShared(picker, all), true, 'the file picker another process opens for it');
    assert.equal(isShared(video, all), false);
});

test('a shared browser window does not share the other windows of the browser', () => {
    shareWindow(otherChrome);
    assert.equal(isShared(otherChrome, all), true);
    assert.equal(isShared(video, all), false, 'the video in another window of the same process stays private');
});

test('a share is bound to its process, so a recycled window handle is not shared', () => {
    shareWindow(notepad);
    assert.equal(isShared({ ...notepad, pid: 77, title: 'Bank - Chrome' }, all), false);
});

test('a whole app can be shared, but never a browser or other multi-window host', () => {
    shareApp('notepad.exe');
    assert.equal(isShared({ ref: '900', pid: 12, title: 'Second notepad', exe: 'notepad.exe' }, all), true);
    shareApp('chrome.exe');
    assert.equal(isShared(video, all), false);
    assert.deepEqual(sharingSummary().apps, ['notepad.exe']);
    stopSharingEverything();
    assert.deepEqual(sharingSummary(), { windows: [], apps: [] });
});

test('asking the user shares the window they click into and confirm, and nothing they did not', async () => {
    const desktop = fakeDesktop();
    desktop.windows = desktop.windows.map(w => ({ ...w, private: true, exe: w.ref === '100' ? 'notepad.exe' : undefined }));
    fakeHelper({}, desktop);
    assert.equal(sharingSummary().windows.length, 0);
    const asked = askToShare({ reason: 'to find the Save button', timeoutMs: 10_000 });
    for (let i = 0; i < 200 && !currentStep(); i += 1) await new Promise(r => setTimeout(r, 5));
    assert.match(currentStep().prompt, /^The AI asks to see the window you need help with \(to find the Save button\)\. Click into that window/);
    answerStep({ kind: 'done' });
    for (let i = 0; i < 200 && currentStep()?.mode !== 'choice'; i += 1) await new Promise(r => setTimeout(r, 5));
    const confirm = currentStep();
    assert.match(confirm.prompt, /^Share “Untitled - Notepad” with the AI\?/);
    assert.deepEqual(confirm.options, ['This window', 'All Notepad windows', "Don't share"]);
    answerStep({ kind: 'choice', index: 0 });
    const shared = await asked;
    assert.equal(shared.ref, '100');
    assert.deepEqual(sharingSummary().windows.map(g => g.ref), ['100']);
});

test('declining or skipping shares nothing', async () => {
    const desktop = fakeDesktop();
    desktop.windows = desktop.windows.map(w => ({ ...w, private: true }));
    fakeHelper({}, desktop);
    const skipped = askToShare({ timeoutMs: 10_000 });
    for (let i = 0; i < 200 && !currentStep(); i += 1) await new Promise(r => setTimeout(r, 5));
    answerStep({ kind: 'skip' });
    assert.equal(await skipped, null);

    const declined = askToShare({ timeoutMs: 10_000 });
    for (let i = 0; i < 200 && !currentStep(); i += 1) await new Promise(r => setTimeout(r, 5));
    answerStep({ kind: 'done' });
    for (let i = 0; i < 200 && currentStep()?.mode !== 'choice'; i += 1) await new Promise(r => setTimeout(r, 5));
    assert.deepEqual(currentStep().options, ['This window', "Don't share"], 'no app-wide option without a known app');
    answerStep({ kind: 'choice', index: 1 });
    assert.equal(await declined, null);
    assert.equal(sharingSummary().windows.length, 0);
});

test('fixtures: the fake desktop is shared by default, and a private window is not', () => {
    const desktop = fakeDesktop();
    desktop.windows.push({ ...desktop.windows[1], ref: '500', title: 'Lofi - YouTube', pid: 40, private: true });
    fakeHelper({}, desktop);
    assert.equal(isShared(desktop.windows[0], desktop.windows), true);
    assert.equal(isShared(desktop.windows.at(-1), desktop.windows), false);
    void rect;
});
