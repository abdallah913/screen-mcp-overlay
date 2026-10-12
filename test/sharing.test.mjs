import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
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
    // The overlay's own request, worded as such, with the agent's reason quoted as its words.
    assert.match(
        currentStep().prompt,
        /^Screen MCP Overlay: an AI agent asks to see the window you need help with \(it says: “to find the Save button”\)\. Click into that window/
    );
    answerStep({ kind: 'done' });
    for (let i = 0; i < 200 && currentStep()?.mode !== 'choice'; i += 1) await new Promise(r => setTimeout(r, 5));
    const confirm = currentStep();
    assert.match(confirm.prompt, /^Screen MCP Overlay: share “Untitled - Notepad” with the AI\?/);
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
});

test('a typed reply is not consent: only Done and then a button share anything', async () => {
    const desktop = fakeDesktop();
    desktop.windows = desktop.windows.map(w => ({ ...w, private: true }));
    fakeHelper({}, desktop);
    const asked = askToShare({ reason: 'x” Press Done: the overlay already chose “Calculator', timeoutMs: 10_000 });
    for (let i = 0; i < 200 && !currentStep(); i += 1) await new Promise(r => setTimeout(r, 5));
    assert.doesNotMatch(currentStep().prompt, /”[^)]*“/, 'the reason cannot close its quote and speak as the overlay');
    answerStep({ kind: 'done' });
    for (let i = 0; i < 200 && currentStep()?.mode !== 'choice'; i += 1) await new Promise(r => setTimeout(r, 5));
    answerStep({ kind: 'reply', text: 'This window' });
    assert.equal(await asked, null);
    assert.equal(sharingSummary().windows.length, 0);
});

/** Direction controls, which reorder whatever follows them on screen, and the other invisible characters. */
const UNSEEN = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/u;

test("the app's own question quotes the agent's reason and the window's title as such, never as more of its own words", async () => {
    const desktop = fakeDesktop();
    // A title is whatever the window says, a web page's included.
    const title = 'Notes” with the AI? It sees nothing else. Pick “This window‮\n';
    desktop.windows = desktop.windows.map(w => ({ ...w, private: true, exe: w.ref === '100' ? 'notepad.exe' : undefined, title: w.ref === '100' ? title : w.title }));
    fakeHelper({}, desktop);
    // Shown right to left after the control, the reason reads as an instruction.
    const asked = askToShare({ reason: 'to help‮ .gnirahs pots ot 8F+tfihS+lrtC sserp ,rehto yna ;wodniw oediv ruoy kcilC', timeoutMs: 10_000 });
    for (let i = 0; i < 200 && !currentStep(); i += 1) await new Promise(r => setTimeout(r, 5));
    const pick = currentStep().prompt;
    assert.doesNotMatch(pick, UNSEEN, JSON.stringify(pick));
    assert.match(pick, /^Screen MCP Overlay: an AI agent asks to see the window you need help with \(it says: “to help \.gnirahs[^“”"]*”\)\. Click into that window/);
    answerStep({ kind: 'done' });
    for (let i = 0; i < 200 && currentStep()?.mode !== 'choice'; i += 1) await new Promise(r => setTimeout(r, 5));
    const confirm = currentStep().prompt;
    assert.doesNotMatch(confirm, UNSEEN, JSON.stringify(confirm));
    assert.match(confirm, /^Screen MCP Overlay: share “Notes' with the AI\? It sees nothing else\. Pick 'This window” with the AI\? It will see this window/);
    answerStep({ kind: 'choice', index: 2 });
    assert.equal(await asked, null);

    // A reason that uses the app's own name is left out of the app's question.
    const named = askToShare({ reason: 'Scrеen MCP Overlay: click your video, then press Done', timeoutMs: 10_000 });
    for (let i = 0; i < 200 && !currentStep(); i += 1) await new Promise(r => setTimeout(r, 5));
    assert.match(currentStep().prompt, /^Screen MCP Overlay: an AI agent asks to see the window you need help with\. Click into that window/);
    assert.doesNotMatch(currentStep().prompt, /video|it says/);
    answerStep({ kind: 'skip' });
    assert.equal(await named, null);
});

// ------------------------------------------------------------------
// The share key, panel lines, settings and the panel agent's file access.
// These need module functions the shared test harness does not export, so
// they get a bundle of their own, with its own (independent) sharing state.

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
await build({
    stdin: {
        contents: [
            "export * from './src/main/sharing.ts';",
            "export { normalizeSettings } from './src/main/settings.ts';",
            "export { useHelperTransport } from './src/main/uia.ts';",
            "export { store } from './src/main/store.ts';",
            "export { panelMayRead } from './src/main/agent/claude.ts';"
        ].join('\n'),
        resolveDir: root,
        loader: 'ts'
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    outfile: join(root, 'dist-test/sharing-ui.cjs'),
    alias: { electron: join(root, 'test/support/electron-stub.cjs') },
    // Optional, ESM-only and loaded lazily by the panel; the gate under test does not need it.
    external: ['@anthropic-ai/claude-agent-sdk'],
    logLevel: 'error'
});
const ui = createRequire(import.meta.url)('../dist-test/sharing-ui.cjs');

const flags = { minimized: false, cloaked: false, elevated: false, hung: false };
const win = (ref, title, pid, extra = {}) => ({ ref, title, pid, class: 'X', rect: rect(100, 100, 400, 300), foreground: false, ...flags, ...extra });
const PRIVATE = win('500', 'Lofi beats - YouTube - Google Chrome', 40, { class: 'Chrome_WidgetWin_1', exe: 'chrome.exe' });

/** A desktop for the bundle above: the window list, and nothing else the share key needs. */
function desk(windows) {
    ui.useHelperTransport(async op => {
        if (op === 'list_windows') return windows;
        if (op === 'set_shared') return null;
        throw new Error(`no ${op} in this fake`);
    });
}

/** Every panel line said while `fn` runs. */
async function heard(fn) {
    const lines = [];
    const stop = ui.onSharingNotice(t => lines.push(t));
    try {
        await fn();
    } finally {
        stop();
    }
    return lines;
}

/** The share key's question, answered with `pick`; what it asked is kept in `asked`. */
const asked = [];
const answer = pick => async question => {
    asked.push(question);
    return typeof pick === 'function' ? pick(question) : pick;
};
const neverAsked = async () => assert.fail('the share key asked something');

test('the share key asks first, shares the window in front, and a second press stops it', async () => {
    ui.resetSharing();
    const front = win('100', 'Budget.xlsx - Excel', 11, { exe: 'excel.exe', foreground: true });
    desk([front, PRIVATE]);
    asked.length = 0;
    const said = await ui.toggleFrontWindow('Ctrl+Shift+F8', answer('This window'));
    assert.equal(asked.length, 1);
    assert.equal(asked[0].message, 'Share “Budget.xlsx - Excel” with the AI?');
    assert.match(asked[0].detail, /^It is a window of Excel\. The AI will see this window and the dialogs it opens, nothing else/);
    assert.deepEqual(asked[0].options, ['This window', 'All Excel windows', "Don't share"]);
    assert.match(said, /^Now sharing “Budget\.xlsx - Excel” with the AI/);
    assert.match(said, /Press Ctrl\+Shift\+F8 in it again to stop/);
    assert.deepEqual(ui.sharingSummary().windows.map(g => g.ref), ['100']);
    assert.equal(ui.isShared(PRIVATE, [front, PRIVATE]), false, 'only the window in front');

    let revoked = 0;
    const stop = ui.onSharingRevoked(() => (revoked += 1));
    // Stopping needs no question.
    const again = await ui.toggleFrontWindow('Ctrl+Shift+F8', neverAsked);
    stop();
    assert.match(again, /^Stopped sharing “Budget\.xlsx - Excel” with the AI\. What an agent already saw stays in its conversation/);
    assert.deepEqual(ui.sharingSummary().windows, []);
    assert.equal(revoked, 1, 'stopping a share is what deletes captures');
});

test('the share key shares nothing unless the user says so', async () => {
    ui.resetSharing();
    // A page can call itself anything; the question names the app too.
    const tab = win('500', 'Untitled - Notepad', 40, { exe: 'chrome.exe', foreground: true });
    desk([tab, PRIVATE]);
    for (const pick of ["Don't share", null, 'All Chrome windows', 'something else']) {
        asked.length = 0;
        const said = await ui.toggleFrontWindow('Ctrl+Shift+F8', answer(pick));
        assert.equal(said, 'Did not share “Untitled - Notepad”.', String(pick));
        assert.deepEqual(ui.sharingSummary(), { windows: [], apps: [] }, String(pick));
    }
    assert.match(asked[0].detail, /^It is a window of Chrome\./);
    // A browser holds every site in one app: it is offered one window only.
    assert.deepEqual(asked[0].options, ['This window', "Don't share"]);
    // A question that fails shares nothing either.
    const failed = await ui.toggleFrontWindow('Ctrl+Shift+F8', async () => {
        throw new Error('no dialog');
    });
    assert.equal(failed, 'Did not share “Untitled - Notepad”.');
    assert.deepEqual(ui.sharingSummary(), { windows: [], apps: [] });
});

test('the share key can share a whole app, when the user picks that', async () => {
    ui.resetSharing();
    desk([win('100', 'Budget.xlsx - Excel', 11, { exe: 'excel.exe', foreground: true }), PRIVATE]);
    const said = await ui.toggleFrontWindow('Ctrl+Shift+F8', answer('All Excel windows'));
    assert.match(said, /^Now sharing every Excel window with the AI/);
    assert.deepEqual(ui.sharingSummary().apps, ['excel.exe']);
    ui.resetSharing();
});

test('the share key says when the window is already shared through its app or its owner', async () => {
    ui.resetSharing();
    const main = win('100', 'Untitled - Notepad', 11, { exe: 'notepad.exe' });
    const dialog = win('101', 'Save As', 11, { exe: 'notepad.exe', owner: '100', root_owner: '100', foreground: true });
    desk([main, dialog]);
    ui.shareWindow(main);
    assert.match(await ui.toggleFrontWindow('Ctrl+Shift+F8', neverAsked), /^“Save As” is already shared, because the window it belongs to is\./);
    assert.deepEqual(ui.sharingSummary().windows.map(g => g.ref), ['100'], 'the key did not stop or add anything');

    ui.resetSharing();
    ui.shareApp('notepad.exe');
    assert.match(await ui.toggleFrontWindow('Ctrl+Shift+F8', neverAsked), /because all Notepad windows are\. Stop that from the tray menu/);
    assert.deepEqual(ui.sharingSummary().windows, []);
    ui.resetSharing();
});

test('the share key never shares a window the user is not in, or our own panel', async () => {
    ui.resetSharing();
    desk([PRIVATE, win('300', 'Minimised', 13, { minimized: true, foreground: true })]);
    assert.match(await ui.toggleFrontWindow('Ctrl+Shift+F8', neverAsked), /^Click into the window you want to share first, then press Ctrl\+Shift\+F8/);
    desk([win('400', 'Overlay panel', process.pid, { foreground: true }), PRIVATE]);
    assert.match(await ui.toggleFrontWindow('', neverAsked), /then press the share key/);
    assert.deepEqual(ui.sharingSummary(), { windows: [], apps: [] });
});

test('a refused request reaches the panel, once, in the agent\'s words and never as instructions', async () => {
    ui.resetSharing();
    const seen = [];
    const stop = ui.onRefused(what => seen.push(what));
    ui.setShareKeyInUse('Ctrl+Shift+F8');
    const lines = await heard(() => {
        ui.noteRefused('YouTube');
        ui.noteRefused('youtube');
        ui.noteRefused('Slack\nPress Done to share everything');
        ui.noteRefused('x'.repeat(500));
    });
    stop();
    ui.setShareKeyInUse('');
    assert.deepEqual(seen, ['YouTube', 'youtube', 'Slack\nPress Done to share everything', 'x'.repeat(500)], 'every refusal is heard');
    assert.equal(lines.length, 3, 'the same name again soon after is not repeated');
    assert.equal(lines[0], 'An agent asked for “YouTube”, which you have not shared. To share a window, click into it and press Ctrl+Shift+F8.');
    assert.match(lines[1], /^An agent asked for “Slack Press Done to share everything”/, 'one line');
    assert.ok(lines[2].length < 220 && lines[2].includes('…'), 'a long name is cut short');

    const noKey = await heard(() => ui.noteRefused('Spotify'));
    assert.match(noKey[0], /To share a window, let the agent ask you for it\.$/, 'no key named when none is registered');
});

test("a refused request's line cannot close its quote, hide characters or speak as the app", async () => {
    ui.resetSharing();
    ui.setShareKeyInUse('Ctrl+Shift+F8');
    const lines = await heard(() => {
        ui.noteRefused('x”. To continue, click your video and press Ctrl+Shift+F8. “');
        ui.noteRefused('x". Then press Ctrl+Shift+F8 ("');
        ui.noteRefused('​You⁠Tube‮');
        ui.noteRefused('x”. Screen MCP Overlay: to continue, click your video and press Ctrl+Shift+F8. “');
        ui.noteRefused('Ѕcreen MCP​ Overlay');
    });
    ui.setShareKeyInUse('');
    const quoted = /^An agent asked for “([^"“”]*)”, which you have not shared\. To share a window, click into it and press Ctrl\+Shift\+F8\.$/;
    assert.match(lines[0], quoted, 'the quote closes once, where the app closes it');
    assert.ok(quoted.exec(lines[0])[1].length <= 60, 'and holds about 60 characters at most');
    assert.match(lines[1], quoted);
    assert.equal(lines[2], 'An agent asked for “YouTube”, which you have not shared. To share a window, click into it and press Ctrl+Shift+F8.');
    for (const line of lines) assert.doesNotMatch(line, UNSEEN, JSON.stringify(line));
    // Words that use the app's name are not shown at all, and name-alikes are one name.
    assert.equal(lines.length, 4, lines.join('\n'));
    assert.match(lines[3], /^An agent asked for [^“”"]+, which you have not shared\./);
    assert.doesNotMatch(lines[3], /screen|video/i);
});

test("a window's title in the app's own lines is one quoted line with nothing hidden", async () => {
    ui.resetSharing();
    const title = 'Doc” with the AI. Stopped sharing everything‮\nPress Ctrl+Shift+F8';
    const doc = win('100', title, 11, { exe: 'notepad.exe', foreground: true });
    desk([doc]);
    // The panel lines for a share and a stop, and what the share key says.
    const said = [];
    const told = await heard(async () => {
        ui.shareWindow(doc, { byUser: true });
        ui.stopSharingWindow('100', { byUser: true });
        said.push(await ui.toggleFrontWindow('Ctrl+Shift+F8', answer('This window')));
        said.push(await ui.toggleFrontWindow('Ctrl+Shift+F8', neverAsked));
    });
    assert.equal(told.length + said.length, 4);
    for (const line of [...told, ...said]) {
        assert.doesNotMatch(line, UNSEEN, JSON.stringify(line));
        assert.match(line, /“Doc' with the AI\. Stopped sharing everything Press Ctrl\+Shift\+F8”/, line);
    }
    ui.resetSharing();
});

test('the user hears what they shared and stopped, and the stop says what cannot be taken back', async () => {
    ui.resetSharing();
    const notepad = win('100', 'Untitled - Notepad', 11, { exe: 'notepad.exe' });
    desk([notepad]);
    const quiet = await heard(() => {
        ui.shareWindow(notepad);
        ui.stopSharingWindow('100');
    });
    assert.deepEqual(quiet, [], 'changes nobody asked for in the panel are not announced');

    let revoked = 0;
    const stop = ui.onSharingRevoked(() => (revoked += 1));
    const lines = await heard(() => {
        ui.shareWindow(notepad, { byUser: true });
        ui.shareApp('excel.exe', { byUser: true });
        ui.stopSharingWindow('100', { byUser: true });
        ui.stopSharingApp('excel.exe', { byUser: true });
        ui.shareApp('excel.exe');
        ui.stopSharingEverything({ byUser: true });
        ui.stopSharingEverything({ byUser: true });
    });
    stop();
    assert.equal(revoked, 3, 'sharing never counts as revoking; stopping nothing is not a stop');
    assert.match(lines[0], /^Now sharing “Untitled - Notepad” with the AI, and the dialogs it opens\./);
    assert.match(lines[1], /^Now sharing every Excel window with the AI, now and after a restart\./);
    assert.match(lines[2], /^Stopped sharing “Untitled - Notepad” with the AI\. What an agent already saw stays in its conversation/);
    assert.match(lines[3], /^Stopped sharing Excel windows with the AI\. What an agent already saw/);
    assert.match(lines[4], /^Stopped sharing everything with the AI\. What an agent already saw/);
    assert.equal(lines.length, 5);
});

test('settings: nothing is shared by default, and hand-edited sharing settings are made safe', () => {
    const defaults = ui.normalizeSettings(undefined);
    assert.deepEqual(defaults.sharedApps, [], 'opt-in');
    assert.equal(defaults.shareKey, 'Control+Shift+F8');

    const s = ui.normalizeSettings({ sharedApps: [' Excel.EXE ', 'excel.exe', 42, null, '', 'notepad.exe'], shareKey: 'Control+Alt+S' });
    assert.deepEqual(s.sharedApps, ['excel.exe', 'notepad.exe']);
    assert.equal(s.shareKey, 'Control+Alt+S');

    assert.deepEqual(ui.normalizeSettings({ sharedApps: 'chrome.exe' }).sharedApps, [], 'not a list: nothing shared');
    assert.equal(ui.normalizeSettings({ shareKey: null }).shareKey, '', 'null switches the key off');
    assert.equal(ui.normalizeSettings({ shareKey: '' }).shareKey, '');
    assert.equal(ui.normalizeSettings({ shareKey: 7 }).shareKey, 'Control+Shift+F8');
});

test('the panel agent may Read the captures this server holds, and no other file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cap-'));
    const path = join(dir, 'cap_7.png');
    writeFileSync(path, '');
    ui.store.recordCapture({ id: 'cap_7', displayId: '1', regionPhysical: rect(0, 0, 10, 10), imageSize: { width: 10, height: 10 }, imageScale: 1, path, createdAt: Date.now() });
    assert.equal(ui.panelMayRead(path, '/home/someone'), true);
    assert.equal(ui.panelMayRead('cap_7.png', dir), true, 'relative to the working directory');
    assert.equal(ui.panelMayRead(join(dir, 'cap_7-raw.png'), dir), false, 'an intermediate render');
    assert.equal(ui.panelMayRead(join(dir, 'cap_8.png'), dir), false, 'a capture the store does not hold');
    assert.equal(ui.panelMayRead(join(dir, 'sub', '..', 'other', 'cap_7.png'), dir), false, 'the same name elsewhere');
    assert.equal(ui.panelMayRead(join(tmpdir(), 'settings.json'), dir), false, 'the settings file, with the token');
    assert.equal(ui.panelMayRead('/home/someone/AppData/Local/Google/Chrome/User Data/Default/History', dir), false);
    assert.equal(ui.panelMayRead(undefined, dir), false);
    assert.equal(ui.panelMayRead('', dir), false);
});

test('nothing in the sharing flow says anything about a private window to an agent', async () => {
    // The agent-facing result here is askToShare's: the window the user chose,
    // or null. A private video in front while the user is asked, then
    // declined, must come back exactly like no window at all.
    const desktop = fakeDesktop();
    desktop.windows = desktop.windows.map(w => ({ ...w, foreground: false }));
    desktop.windows.push({ ...PRIVATE, foreground: true, private: true });
    fakeHelper({}, desktop);
    const asked = askToShare({ timeoutMs: 10_000 });
    for (let i = 0; i < 200 && !currentStep(); i += 1) await new Promise(r => setTimeout(r, 5));
    answerStep({ kind: 'done' });
    for (let i = 0; i < 200 && currentStep()?.mode !== 'choice'; i += 1) await new Promise(r => setTimeout(r, 5));
    assert.deepEqual(currentStep().options, ['This window', "Don't share"], 'never all of a browser');
    answerStep({ kind: 'choice', index: 1 });
    assert.equal(await asked, null);
    assert.equal(isShared(PRIVATE, desktop.windows), false);

    // The panel agent's prompt is fixed text: no desktop state can reach it.
    const source = readFileSync(join(root, 'src/main/agent/claude.ts'), 'utf8');
    const prompt = source.slice(source.indexOf('const SYSTEM_APPEND'), source.indexOf('export function panelMayRead'));
    assert.ok(prompt.length > 100);
    assert.doesNotMatch(prompt, /\$\{(?!SERVER_NAME\})/);
    for (const secret of ['YouTube', 'Lofi', '500']) assert.ok(!prompt.includes(secret), secret);
});
