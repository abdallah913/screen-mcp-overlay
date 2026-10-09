import test from 'node:test';
import assert from 'node:assert/strict';
import { call, connect, fakeDesktop, fakeHelper, harness, rect } from './support/fake-helper.mjs';

/*
 * The guidance tools (src/main/mcp/tools/guide.ts, src/main/waits.ts) end to
 * end: how a step starts, every way it can end, and what the agent is told.
 * A step's answer comes from the user through answerStep/addClick/cancelStep,
 * which is what the overlay strip, the panel and the hotkeys call.
 */

const { store, answerStep, addClick, cancelStep, currentStep } = harness;

test.beforeEach(() => store.clear());
test.afterEach(() => cancelStep('clear'));

/** Resolve once `cond()` holds, polling briefly. */
async function eventually(cond, ms = 3000) {
    const started = Date.now();
    while (!cond()) {
        if (Date.now() - started > ms) throw new Error('condition never held');
        await new Promise(r => setTimeout(r, 5));
    }
}

/** Start a tool call, wait until its step is on screen, and hand both back. */
async function pending(name, args) {
    const result = call(name, args);
    await eventually(() => currentStep() !== null);
    return { result, step: currentStep() };
}

const click = (x, y) => ({ displayId: '1', physical: { x, y }, dip: { x, y }, normalized: { x: 0, y: 0 } });
const saved = { ref: 'el_5', name: 'Saved', role: 'text', rect: rect(0, 0, 10, 10), enabled: true };
const save = { ref: 'el_1', name: 'Save', role: 'button', automation_id: 'SaveBtn', rect: rect(150, 150, 80, 24), enabled: true };

/** find_elements that knows Save, plus whatever `extra()` returns for anything else. */
const finder = extra => p => (p.name === 'Save' ? [save] : extra(p));

// --- until is edge-triggered ------------------------------------------------------

test('a window-only until is not met by windows that were already open', async () => {
    fakeHelper();
    const { text, isError } = await call('highlight_and_wait', {
        window: 'Notepad',
        name: 'Save',
        prompt: 'Click Save',
        until: { condition: 'appears', role: 'window', name: 'Calculator' },
        timeoutMs: 1000
    });
    assert.equal(isError, false, text);
    assert.match(text, /^NOT met: "appears" did not happen/);
    assert.match(text, /already open before the step \(200 "Calculator"\)/);
});

test('an unnamed window until that times out does not blame a window that was already open', async () => {
    fakeHelper();
    const { text } = await call('highlight_and_wait', {
        window: 'Notepad',
        name: 'Save',
        prompt: 'Click Save',
        until: { condition: 'appears', role: 'window' },
        timeoutMs: 1000
    });
    assert.match(text, /^NOT met: "appears" did not happen/);
    assert.equal(/already open/.test(text), false, text);
});

test('a window that opens during the step meets a window-only until', async () => {
    const desktop = fakeDesktop();
    let lists = 0;
    fakeHelper(
        {
            list_windows: () => {
                lists += 1;
                // Two lists happen before drawing (resolving the window, the baseline).
                return lists > 3
                    ? [{ ...desktop.windows[0], foreground: false }, { ...desktop.windows[1], ref: '500', title: 'Export As', foreground: true }, ...desktop.windows.slice(1)]
                    : desktop.windows;
            }
        },
        desktop
    );
    const { text } = await call('highlight_and_wait', {
        window: 'Notepad',
        name: 'Save',
        prompt: 'Click Save',
        until: { condition: 'appears', role: 'window' },
        timeoutMs: 5000
    });
    assert.match(text, /^Met: "appears" after/);
    assert.match(text, /Export As \[window\]/);
    assert.match(text, /After:\n\+ window 500 "Export As" \[foreground\]/);
});

test('an until that already holds does not start the step', async () => {
    fakeHelper({ find_elements: finder(() => [saved]) });
    const { text, isError } = await call('highlight_and_wait', {
        window: 'Notepad',
        name: 'Save',
        prompt: 'Click Save',
        until: { condition: 'appears', name: 'Saved' }
    });
    assert.equal(isError, false);
    assert.match(text, /^NOT started: until is already true \("appears" \{"name":"Saved"\}: Saved \[text\]/);
    assert.equal(store.list().length, 0, 'nothing is drawn');
    assert.equal(currentStep(), null);
});

test('a user who is already past the step is reported as done', async () => {
    fakeHelper({ find_elements: p => (p.name === 'Saved' ? [saved] : []) });
    const { text, isError } = await call('highlight_and_wait', {
        window: 'Notepad',
        name: 'Save',
        prompt: 'Click Save',
        until: { condition: 'appears', name: 'Saved' }
    });
    assert.equal(isError, false);
    assert.match(text, /^Already done \(the user was ahead\): "appears" \{"name":"Saved"\} already holds\./);
});

test('a missing target with an unmet until is still an error naming describe_window', async () => {
    fakeHelper({ find_elements: () => [] });
    const { text, isError } = await call('highlight_and_wait', {
        window: 'Notepad',
        name: 'Nope',
        prompt: 'x',
        until: { condition: 'appears', name: 'Saved' }
    });
    assert.equal(isError, true);
    assert.match(text, /no control matching/);
});

// --- what was circled, and where ------------------------------------------------

test('every outcome says what was circled and where', async () => {
    let checks = 0;
    fakeHelper({ find_elements: finder(() => (++checks >= 2 ? [saved] : [])) });
    const { text } = await call('highlight_and_wait', {
        window: 'Notepad',
        name: 'Save',
        prompt: 'Click Save',
        until: { condition: 'appears', name: 'Saved' },
        timeoutMs: 5000
    });
    assert.match(text, /^Met: "appears" after \d+\.\ds\.\nSaved \[text\]/);
    assert.match(text, /^Circled "Save" \[button\] el_1, top-left of "Untitled - Notepad"\.$/m);
});

test('a met step swaps its circle for a brief check mark', async () => {
    let checks = 0;
    fakeHelper({ find_elements: finder(() => (++checks >= 2 ? [saved] : [])) });
    await call('highlight_and_wait', {
        window: 'Notepad',
        name: 'Save',
        prompt: 'Click Save',
        until: { condition: 'appears', name: 'Saved' },
        timeoutMs: 5000
    });
    const left = store.list();
    assert.equal(left.length, 1);
    assert.equal(left[0].type, 'done');
    assert.ok(left[0].expiresAt - Date.now() <= 1000, 'it expires on its own');
});

test('a covered target is drawn with a warning; an untitled popup on top is not a cover', async () => {
    fakeHelper({
        find_elements: finder(() => [saved]),
        covered: () => ({ fraction: 0.85, centre_covered: true, by: ['Google Chrome'] })
    });
    let r = await call('highlight_and_wait', { window: 'Notepad', name: 'Save', prompt: 'p', until: { condition: 'disappears', name: 'Saved' }, timeoutMs: 1000 });
    assert.match(r.text, /WARNING: "Save" \[button\] el_1 is 85% behind "Google Chrome"; focus_window \{window:"Untitled - Notepad"\}/);

    fakeHelper({
        find_elements: finder(() => [saved]),
        covered: () => ({ fraction: 0.9, centre_covered: true, by: [''] })
    });
    r = await call('highlight_and_wait', { window: 'Notepad', name: 'Save', prompt: 'p', until: { condition: 'disappears', name: 'Saved' }, timeoutMs: 1000 });
    assert.equal(/WARNING/.test(r.text), false);
});

test('a scrolled-out target is not drawn', async () => {
    fakeHelper({ resolve: p => p.refs.map(ref => ({ ref, rect: save.rect, offscreen: true })) });
    const { text, isError } = await call('highlight_and_wait', { window: 'Notepad', name: 'Save', prompt: 'p' });
    assert.equal(isError, false);
    assert.match(text, /^NOT started: "Save" \[button\] el_1 is scrolled out of view in "Untitled - Notepad"; call scroll_window/);
    assert.equal(store.list().length, 0);
});

// --- the user answers a watched step -----------------------------------------

const watched = { window: 'Notepad', name: 'Save', prompt: '2/5 Click Save', until: { condition: 'appears', name: 'Saved' }, timeoutMs: 60000 };

test('a watched step carries its prompt, target and progress', async () => {
    fakeHelper({ find_elements: finder(() => []) });
    const { result, step } = await pending('highlight_and_wait', watched);
    assert.equal(step.mode, 'watch');
    assert.deepEqual(step.progress, { n: 2, of: 5 });
    assert.equal(step.targetIds.length, 1);
    assert.equal(store.list()[0].id, step.targetIds[0]);
    answerStep({ kind: 'skip' });
    assert.match((await result).text, /^SKIPPED after \d+s/);
});

test('Done re-checks the until: met', async () => {
    let met = false;
    fakeHelper({ find_elements: finder(() => (met ? [saved] : [])) });
    const { result } = await pending('highlight_and_wait', watched);
    met = true;
    answerStep({ kind: 'done' });
    const { text, isError } = await result;
    assert.equal(isError, false);
    assert.match(text, /^Met: "appears" after \d+\.\ds \(checked when the user pressed Done\)\./);
});

test('Done re-checks the until: not met, with the digest', async () => {
    fakeHelper({ find_elements: finder(() => []) });
    const { result } = await pending('highlight_and_wait', watched);
    answerStep({ kind: 'done' });
    const { text } = await result;
    assert.match(text, /^DONE after \d+s, but the until is NOT met: "appears" \{"name":"Saved"\}\./);
    assert.match(text, /Nothing changed: the user may still be working/);
    assert.match(text, /Circle ann_\d+ left up/);
});

test('Stuck says what the user can see of the target', async () => {
    fakeHelper({ find_elements: finder(() => []) });
    const { result } = await pending('highlight_and_wait', watched);
    answerStep({ kind: 'stuck', text: 'no save button here' });
    const { text, isError } = await result;
    assert.equal(isError, false);
    assert.match(text, /^STUCK after \d+s: the user can't find it\. They said: "no save button here"/);
    assert.match(text, /The circled control is visible and uncovered/);
    assert.equal(store.list().length, 0, 'the circle goes');
});

test('a typed reply ends the step with the user\'s words', async () => {
    fakeHelper({ find_elements: finder(() => []) });
    const { result } = await pending('highlight_and_wait', watched);
    answerStep({ kind: 'reply', text: 'it is greyed out' });
    assert.match((await result).text, /^REPLIED after \d+s: "it is greyed out"/);
});

test('a client that goes away ends the step and stops polling', async () => {
    let probes = 0;
    fakeHelper({ find_elements: finder(() => (probes++, [])) });
    const client = await connect();
    const ac = new AbortController();
    const result = client.callTool({ name: 'highlight_and_wait', arguments: watched }, undefined, { signal: ac.signal });
    await eventually(() => currentStep() !== null);
    ac.abort();
    await assert.rejects(result);
    await eventually(() => currentStep() === null);
    const after = probes;
    await new Promise(r => setTimeout(r, 900));
    assert.equal(probes, after, 'no checks after the abort');
    await eventually(() => store.list().length === 0);
    await client.close();
});

test('wait_for_element stops at once when its request is cancelled', async () => {
    let probes = 0;
    fakeHelper({ find_elements: () => (probes++, []) });
    const client = await connect();
    const ac = new AbortController();
    const result = client.callTool(
        { name: 'wait_for_element', arguments: { condition: 'appears', name: 'Saved', window: 'Notepad', timeoutMs: 60000 } },
        undefined,
        { signal: ac.signal }
    );
    await eventually(() => probes > 0);
    ac.abort();
    await assert.rejects(result);
    const after = probes;
    await new Promise(r => setTimeout(r, 1100));
    assert.equal(probes, after);
    await client.close();
});

// --- a wait that ends early, truthfully --------------------------------------

test('a failed check never reads as "disappears: met"', async () => {
    let n = 0;
    fakeHelper({
        find_elements: () => {
            n += 1;
            if (n === 1) throw new Error('UI Automation helper timed out after 8000ms');
            return n < 3 ? [saved] : [];
        }
    });
    const { text } = await call('wait_for_element', { condition: 'disappears', name: 'Saved', window: 'Notepad', timeoutMs: 5000 });
    assert.match(text, /^Met: "disappears"/);
    assert.equal(n, 3, 'the failed check did not count');
});

test('persistent check failures are reported as the error they are', async () => {
    fakeHelper({ find_elements: () => { throw new Error('UI Automation helper timed out after 8000ms'); } });
    const { text, isError } = await call('wait_for_element', { condition: 'disappears', name: 'Saved', window: 'Notepad', timeoutMs: 60000 });
    assert.equal(isError, true);
    assert.match(text, /timed out/);
});

test('a closed window ends the wait: disappears is met, appears is not', async () => {
    const gone = () => { throw new Error("no window for ref '100': element not found"); };
    fakeHelper({ find_elements: gone });
    const d = await call('wait_for_element', { condition: 'disappears', name: 'Saved', window: '100', timeoutMs: 60000 });
    assert.match(d.text, /^Met: "disappears" after \d+\.\ds \(the window itself closed\)\./);
    const a = await call('wait_for_element', { condition: 'appears', name: 'Saved', window: '100', timeoutMs: 60000 });
    assert.equal(a.isError, false);
    assert.match(a.text, /^NOT met: the window closed after/);
});

test('a circled control gone for a while ends the step unmet', async () => {
    fakeHelper({ find_elements: finder(() => []) });
    const { result, step } = await pending('highlight_and_wait', watched);
    const circle = store.list().find(a => a.id === step.targetIds[0]);
    circle.hidden = true;
    circle.hiddenSince = Date.now() - 11_000;
    const { text, isError } = await result;
    assert.equal(isError, false);
    assert.match(text, /^NOT met yet: the circled control went away 1\ds ago\./);
    assert.match(text, /not on screen now/);
});

// --- NOT met says what happened ------------------------------------------------

test('NOT met names a window that opened instead, and leaves the circle up', async () => {
    const desktop = fakeDesktop();
    let asked = 0;
    fakeHelper(
        {
            // The dialog pops up once the step is under way.
            find_elements: finder(() => (asked++, [])),
            list_windows: () =>
                asked > 1 ? [...desktop.windows, { ...desktop.windows[1], ref: '500', title: 'Save changes?', foreground: true }] : desktop.windows
        },
        desktop
    );
    const { text, isError } = await call('highlight_and_wait', { ...watched, timeoutMs: 1000 });
    assert.equal(isError, false);
    assert.match(text, /^NOT met: "appears" did not happen within/);
    assert.match(text, /\+ window 500 "Save changes\?" \[foreground\]/);
    assert.match(text, /A new window "Save changes\?" appeared; if the control is in it, pass until\.window:"Save changes\?"/);
    assert.match(text, /Circle ann_\d+ left up; your next highlight_and_wait replaces it\./);
    assert.equal(store.list().length, 1);
});

test('NOT met lists what changed in the step window', async () => {
    const desktop = fakeDesktop();
    let describes = 0;
    fakeHelper(
        {
            find_elements: finder(() => []),
            describe: () => ({
                nodes: ++describes > 1 ? [...desktop.tree, { depth: 2, ref: 'el_20', name: 'Bold', role: 'checkbox', enabled: true, rect: rect(1, 1, 1, 1) }] : desktop.tree,
                truncated: false
            })
        },
        desktop
    );
    const { text } = await call('highlight_and_wait', { ...watched, timeoutMs: 1000 });
    assert.match(text, /Changes in "Untitled - Notepad":\n\+ Bold \[checkbox\]/);
});

// --- changes and values ----------------------------------------------------------

test('until "changes" on a control fires when its value or state changes', async () => {
    let state = 'unchecked';
    let probes = 0;
    fakeHelper({
        find_elements: finder(p => {
            if (++probes >= 3) state = 'checked';
            return p.name === 'Dark mode' ? [{ ref: 'el_7', name: 'Dark mode', role: 'checkbox', state, rect: rect(1, 1, 1, 1), enabled: true }] : [];
        })
    });
    const { text } = await call('highlight_and_wait', { ...watched, until: { condition: 'changes', name: 'Dark mode' }, timeoutMs: 5000 });
    assert.match(text, /^Met: "changes" after/);
});

test('until "changes" without a selector fires on a dialog opening', async () => {
    const desktop = fakeDesktop();
    let lists = 0;
    fakeHelper(
        {
            find_elements: finder(() => []),
            // Notepad's own dialog: the step window's app.
            list_windows: () => (++lists > 3 ? [...desktop.windows, { ...desktop.windows[0], ref: '600', title: 'Font', foreground: false }] : desktop.windows)
        },
        desktop
    );
    const { text } = await call('highlight_and_wait', { ...watched, until: { condition: 'changes' }, timeoutMs: 5000 });
    assert.match(text, /^Met: "changes" after [\d.]+s\.\nFont \[window\]/);
});

test('until.value matches a whole state word, or a value substring', async () => {
    const box = state => [{ ref: 'el_7', name: 'Bold', role: 'checkbox', state, rect: rect(1, 1, 1, 1), enabled: true }];
    fakeHelper({ find_elements: () => box('unchecked,focused') });
    let r = await call('wait_for_element', { condition: 'appears', name: 'Bold', value: 'checked', window: 'Notepad', timeoutMs: 0 });
    assert.match(r.text, /^NOT met/);
    assert.match(r.text, /Closest: Bold \[checkbox\].*\(unchecked,focused\)/);
    fakeHelper({ find_elements: () => box('checked') });
    r = await call('wait_for_element', { condition: 'appears', name: 'Bold', value: 'Checked', window: 'Notepad', timeoutMs: 0 });
    assert.match(r.text, /^Met/);
    fakeHelper({ find_elements: () => [{ ...save, role: 'edit', name: 'File name', value: 'report-final.png' }] });
    r = await call('wait_for_element', { condition: 'appears', name: 'File name', value: 'FINAL', window: 'Notepad', timeoutMs: 0 });
    assert.match(r.text, /^Met/);
});

test('enabled reports a control that is there but disabled', async () => {
    fakeHelper();
    const { text } = await call('wait_for_element', { condition: 'enabled', name: 'Export', window: 'Notepad', timeoutMs: 0 });
    assert.match(text, /^NOT met[^\n]*\nIt is there but disabled: Export \[button\] disabled/);
});

// --- click mode ----------------------------------------------------------------

const pointed = { window: 'Notepad', name: 'Save', prompt: 'Click Save', timeoutMs: 60000 };

test('a click on the circle is the target, and leaves a check mark', async () => {
    fakeHelper();
    const { result, step } = await pending('highlight_and_wait', pointed);
    assert.equal(step.mode, 'click');
    addClick(click(160, 160));
    const { text, isError } = await result;
    assert.equal(isError, false);
    assert.match(text, /^The user clicked the target \(160,160 on display 1\)\./);
    assert.deepEqual(store.list().map(a => a.type), ['done']);
});

test('a click off the circle says where it was and that the app did not get it', async () => {
    fakeHelper();
    const { result } = await pending('highlight_and_wait', pointed);
    addClick(click(160, 300));
    const { text } = await result;
    // The point is named too: here it is plain window background, no control.
    assert.match(text, /^The user clicked OUTSIDE the target, at 160,300 on display 1, on the window "Untitled - Notepad", 118px below the circle\. The app did not receive that click/);
    assert.equal(store.list().length, 0);
});

test('a click where the target is, but covered, is not a hit', async () => {
    fakeHelper({ covered: p => (p.rect ? { fraction: 0.6, centre_covered: true, by: ['Google Chrome'] } : { fraction: 0, centre_covered: false, by: [] }) });
    const { result } = await pending('highlight_and_wait', pointed);
    addClick(click(160, 160));
    assert.match((await result).text, /^The user clicked where the target is \(160,160 on display 1\), but it was covered by "Google Chrome"/);
});

test('Escape in click mode is an answer, not an error', async () => {
    fakeHelper();
    const { result } = await pending('highlight_and_wait', pointed);
    cancelStep('esc');
    const { text, isError } = await result;
    assert.equal(isError, false);
    assert.match(text, /^CANCELLED: the user pressed Escape/);
});

// --- wait_for_user_click ----------------------------------------------------------

test('wait_for_user_click: complete, and which drawing each click hit', async () => {
    fakeHelper();
    store.add([{ id: 'ann_x', displayId: '1', type: 'box', rect: rect(100, 100, 50, 50), createdAt: 0 }]);
    const { result } = await pending('wait_for_user_click', { prompt: 'Point at it', count: 2 });
    addClick(click(120, 120));
    addClick(click(500, 500));
    const { text, isError } = await result;
    assert.equal(isError, false);
    assert.match(
        text,
        /^The user clicked:\n1\. display 1: physical 120,120, normalized 0,0 -> the window "Untitled - Notepad"; inside ann_x\n2\. display 1: physical 500,500, normalized 0,0 -> the window "Untitled - Notepad"$/
    );
});

test('a click on a control comes back named and anchorable', async () => {
    fakeHelper();
    const { result } = await pending('wait_for_user_click', { prompt: 'Which button?' });
    addClick(click(160, 160));
    const { text } = await result;
    assert.match(text, /-> "Save" \[button\] el_1 in "Untitled - Notepad"/);
});

test('wait_for_user_click: partial clicks then silence lead with the status word', async () => {
    fakeHelper();
    const keepAlive = setTimeout(() => {}, 3000);
    const { result } = await pending('wait_for_user_click', { prompt: 'p', count: 3, timeoutMs: 1000 });
    addClick(click(1, 1));
    addClick(click(2, 2));
    const { text, isError } = await result;
    clearTimeout(keepAlive);
    assert.equal(isError, false);
    assert.match(text, /^NO RESPONSE in 1s: .* PARTIAL: 2 click\(s\) came in first\.\nThe user clicked:\n1\. .*\n2\. /);
});

test('wait_for_user_click: Escape keeps the clicks already made; silence is not an error', async () => {
    fakeHelper();
    let { result } = await pending('wait_for_user_click', { prompt: 'p', count: 3 });
    addClick(click(1, 1));
    cancelStep('esc');
    let r = await result;
    assert.equal(r.isError, false);
    assert.match(r.text, /^CANCELLED: the user pressed Escape.*PARTIAL: 1 click\(s\)[^\n]*\nThe user clicked:\n1\. /);

    const keepAlive = setTimeout(() => {}, 3000);
    ({ result } = await pending('wait_for_user_click', { prompt: 'p', timeoutMs: 1000 }));
    r = await result;
    clearTimeout(keepAlive);
    assert.equal(r.isError, false);
    assert.match(r.text, /^NO RESPONSE in 1s: the user may be away or unsure\.$/);
});

// --- drawings left behind --------------------------------------------------------

test('a met step mentions other drawings still up', async () => {
    let checks = 0;
    fakeHelper({
        find_elements: finder(() => {
            checks += 1;
            if (checks === 2) store.add([{ id: 'ann_other', displayId: '1', type: 'box', rect: rect(0, 0, 5, 5), createdAt: 0 }]);
            return checks >= 3 ? [saved] : [];
        })
    });
    const { text } = await call('highlight_and_wait', { ...watched, timeoutMs: 5000 });
    assert.match(text, /\n1 other drawing\(s\) still up \(ann_other\); clear_annotations when the task is done\.$/);
});

// --- plans -------------------------------------------------------------------------

test('then runs the steps in order with n/N progress, one line per step', async () => {
    const met = new Set();
    const prompts = [];
    fakeHelper({
        find_elements: p => {
            if (['File', 'Save as'].includes(p.name)) {
                if (currentStep()) prompts.push(currentStep().prompt);
                return [{ ...save, name: p.name, role: 'menuitem' }];
            }
            // Each until turns true one check after it is first asked.
            if (met.has(p.name)) return [saved];
            met.add(p.name);
            return [];
        }
    });
    const { text, isError } = await call('highlight_and_wait', {
        window: 'Notepad',
        name: 'File',
        prompt: 'Open the File menu',
        until: { condition: 'appears', name: 'Menu open' },
        then: [{ name: 'Save as', prompt: 'Click Save as', until: { condition: 'appears', name: 'Dialog open' } }],
        timeoutMs: 5000
    });
    assert.equal(isError, false, text);
    const lines = text.split('\n');
    assert.match(lines[0], /^Step 1\/2: Met: "appears" after [\d.]+s\. Circled "File" \[menuitem\]/);
    assert.match(lines[1], /^Step 2\/2: Met: "appears" after/);
    assert.equal(store.list().filter(a => a.type === 'circle').length, 0);
});

test('then stops at the first step that is not met', async () => {
    fakeHelper({
        find_elements: p => (['File', 'Save as'].includes(p.name) ? [{ ...save, name: p.name, role: 'menuitem' }] : [])
    });
    const { text } = await call('highlight_and_wait', {
        window: 'Notepad',
        name: 'File',
        prompt: '1/4 Open the File menu',
        until: { condition: 'appears', name: 'Menu open' },
        then: [{ name: 'Save as', prompt: 'Click Save as', until: { condition: 'appears', name: 'Dialog open' } }],
        timeoutMs: 1000
    });
    assert.match(text, /^Step 1\/4: NOT met: "appears" did not happen/);
    assert.match(text, /\nStopped at step 1\/4; the steps after it were not shown\.$/);
});

test('then needs an until everywhere', async () => {
    fakeHelper();
    let r = await call('highlight_and_wait', { window: 'Notepad', name: 'Save', prompt: 'p', then: [{ prompt: 'q', until: { condition: 'changes' } }] });
    assert.equal(r.isError, true);
    assert.match(r.text, /then needs until on this step too/);
    r = await call('highlight_and_wait', {
        window: 'Notepad',
        prompt: 'p',
        until: { condition: 'changes' },
        then: [{ prompt: 'q', until: { condition: 'sometime' } }]
    });
    assert.equal(r.isError, true);
    assert.match(r.text, /then\[0\]\.until/);
    assert.equal(store.list().length, 0);
});

// --- focus is not a change -----------------------------------------------------------

test('until "changes" on a control ignores focus moving into it', async () => {
    let probes = 0;
    fakeHelper({
        find_elements: finder(p => {
            probes += 1;
            if (p.name !== 'File name') return [];
            // The user clicks into the field: focus arrives, nothing is typed.
            const state = probes > 2 ? 'focused' : undefined;
            return [{ ref: 'el_8', name: 'File name', role: 'edit', value: '', state, rect: rect(1, 1, 1, 1), enabled: true }];
        })
    });
    const { text } = await call('highlight_and_wait', { ...watched, until: { condition: 'changes', name: 'File name', role: 'edit' }, timeoutMs: 1500 });
    assert.match(text, /^NOT met: "changes" did not happen/);
});

test('an unselected "changes" ignores focus moving around the window', async () => {
    const desktop = fakeDesktop();
    let describes = 0;
    const list = n =>
        Array.from({ length: 12 }, (_, i) => ({
            depth: 2,
            ref: `el_${30 + i}`,
            name: `Row ${i}`,
            role: 'listitem',
            enabled: true,
            rect: rect(1, 1, 1, 1),
            state: i === n ? 'focused' : undefined
        }));
    fakeHelper(
        {
            find_elements: finder(() => []),
            // Focus walks down a long list: it changes which rows a collapsed list keeps.
            describe: () => ({ nodes: [...desktop.tree, ...list(++describes > 2 ? 9 : 0)], truncated: false })
        },
        desktop
    );
    const { text } = await call('highlight_and_wait', { ...watched, until: { condition: 'changes' }, timeoutMs: 2500 });
    assert.match(text, /^NOT met: "changes" did not happen/);
});

// --- Done is judged on what the last look actually saw -------------------------------

test('Done right after a change meets an unselected "changes" without the debounce', async () => {
    const desktop = fakeDesktop();
    let changed = false;
    fakeHelper(
        {
            find_elements: finder(() => []),
            describe: () => ({
                nodes: changed
                    ? [...desktop.tree, { depth: 2, ref: 'el_20', name: 'Bold', role: 'checkbox', enabled: true, rect: rect(1, 1, 1, 1) }]
                    : desktop.tree,
                truncated: false
            })
        },
        desktop
    );
    const { result } = await pending('highlight_and_wait', { ...watched, until: { condition: 'changes' } });
    changed = true;
    answerStep({ kind: 'done' });
    const { text } = await result;
    assert.match(text, /^Met: "changes" after [\d.]+s \(checked when the user pressed Done\)\./);
});

test('a last check that keeps failing says the until is unknown, not unmet', async () => {
    let failing = false;
    let failed = 0;
    fakeHelper({
        find_elements: finder(() => {
            if (!failing) return [];
            failed += 1;
            throw new Error('UI Automation helper timed out after 8000ms');
        })
    });
    const { result } = await pending('highlight_and_wait', watched);
    await new Promise(r => setTimeout(r, 100));
    failing = true;
    answerStep({ kind: 'done' });
    const { text, isError } = await result;
    assert.equal(isError, false);
    assert.match(
        text,
        /^DONE after \d+s; the until could not be checked \(helper error: UI Automation helper timed out after 8000ms\): "appears" \{"name":"Saved"\}\./
    );
    assert.equal(/NOT met|Closest/.test(text), false, text);
    assert.ok(failed >= 3, 'the last check was retried');
});

test('a last check that fails once and then succeeds is judged on the retry', async () => {
    let done = false;
    let thrown = false;
    fakeHelper({
        find_elements: finder(() => {
            if (!done) return [];
            if (!thrown) {
                thrown = true;
                throw new Error('UI Automation helper timed out after 8000ms');
            }
            return [saved];
        })
    });
    const { result } = await pending('highlight_and_wait', watched);
    await new Promise(r => setTimeout(r, 100));
    done = true;
    answerStep({ kind: 'done' });
    assert.match((await result).text, /^Met: "appears" after [\d.]+s \(checked when the user pressed Done\)\./);
});

// --- the window list: minimise and restore are not the user's action -----------------

test('an unselected "changes" ignores a window minimised, and windows of other apps', async () => {
    const desktop = fakeDesktop();
    let lists = 0;
    fakeHelper(
        {
            find_elements: finder(() => []),
            list_windows: () =>
                ++lists > 3
                    ? [
                          desktop.windows[0],
                          { ...desktop.windows[1], minimized: true },
                          ...desktop.windows.slice(2),
                          { ...desktop.windows[1], ref: '700', pid: 99, title: 'Reminder' }
                      ]
                    : desktop.windows
        },
        desktop
    );
    const { text } = await call('highlight_and_wait', { ...watched, until: { condition: 'changes' }, timeoutMs: 2500 });
    assert.match(text, /^NOT met: "changes" did not happen/);
    assert.match(text, /\+ window 700 "Reminder"/);
    assert.match(text, /~ window 200 "Calculator" minimised/);
    assert.equal(/- window 200/.test(text), false, 'a minimised window is not reported closed');
});

/** Run an unselected "changes" step while `extra` opens in front of Notepad. */
async function changesWith(extra, timeoutMs) {
    const desktop = fakeDesktop();
    let lists = 0;
    fakeHelper(
        {
            find_elements: finder(() => []),
            list_windows: () =>
                ++lists > 3 ? [{ ...desktop.windows[0], foreground: false }, ...desktop.windows.slice(1), extra] : desktop.windows
        },
        desktop
    );
    return (await call('highlight_and_wait', { ...watched, until: { condition: 'changes' }, timeoutMs })).text;
}

test('an unselected "changes" counts a dialog another process opens for the app', async () => {
    // A packaged app's file picker belongs to PickerHost, but Notepad's window owns it.
    const picker = { ...fakeDesktop().windows[1], ref: '800', title: 'Open', pid: 98, rect: rect(300, 250, 400, 300), foreground: true, owner: '100' };
    assert.match(await changesWith(picker, 5000), /^Met: "changes" after [\d.]+s\.\nOpen \[window\]/);
});

test('an unselected "changes" ignores another app the user brings up in front', async () => {
    // Win+E over a maximised Notepad: in front, but nobody's dialog.
    const explorer = { ...fakeDesktop().windows[1], ref: '810', title: 'File Explorer', pid: 97, rect: rect(300, 250, 400, 300), foreground: true };
    assert.match(await changesWith(explorer, 2500), /^NOT met: "changes" did not happen/);
});

test('a window that never stops changing does not meet "changes" when the step times out', async () => {
    const desktop = fakeDesktop();
    let reads = 0;
    // A playing track's position, say: different on every read.
    const ticking = () => [...desktop.tree.slice(0, 3), { ...desktop.tree[3], value: `at ${++reads}s` }];
    fakeHelper({ find_elements: finder(() => []), describe: () => ({ nodes: ticking(), truncated: false }) }, desktop);
    const { text } = await call('highlight_and_wait', { ...watched, until: { condition: 'changes' }, timeoutMs: 2500 });
    assert.match(text, /^NOT met: "changes" did not happen/);
});

test('a describe the app stopped answering partway is not a change', async () => {
    const desktop = fakeDesktop();
    let reads = 0;
    fakeHelper(
        {
            find_elements: finder(() => []),
            // Every read after the first two comes back cut short, every time.
            describe: () => (++reads > 2 ? { nodes: desktop.tree.slice(0, 1), truncated: false, unanswered: true } : { nodes: desktop.tree, truncated: false })
        },
        desktop
    );
    const { text } = await call('highlight_and_wait', { ...watched, until: { condition: 'changes' }, timeoutMs: 2500 });
    assert.equal(/^Met/.test(text), false, text);
});

test('restoring a minimised window does not meet a window until', async () => {
    const desktop = fakeDesktop();
    let lists = 0;
    fakeHelper(
        {
            find_elements: finder(() => []),
            list_windows: () => (++lists > 3 ? desktop.windows.map(w => (w.ref === '300' ? { ...w, minimized: false } : w)) : desktop.windows)
        },
        desktop
    );
    const { text } = await call('highlight_and_wait', { ...watched, until: { condition: 'appears', role: 'window' }, timeoutMs: 1500 });
    assert.match(text, /^NOT met: "appears" did not happen/);
});

test('"changes" on a named window waits for that window, not any', async () => {
    const desktop = fakeDesktop();
    let lists = 0;
    const font = { ...desktop.windows[1], ref: '600', title: 'Font' };
    const saveAs = { ...desktop.windows[1], ref: '601', title: 'Save As' };
    fakeHelper(
        {
            list_windows: () => (++lists > 4 ? [...desktop.windows, font, saveAs] : lists > 2 ? [...desktop.windows, font] : desktop.windows)
        },
        desktop
    );
    const { text } = await call('wait_for_element', { condition: 'changes', role: 'window', name: 'Save As', timeoutMs: 5000 });
    assert.match(text, /^Met: "changes" after [\d.]+s\.\nSave As \[window\] .*601$/m);
});

// --- plans: the precheck and the next step's window ----------------------------------

test('a step whose target is missing is not "already done" just because a disappears holds', async () => {
    fakeHelper({ find_elements: () => [] });
    const { text, isError } = await call('highlight_and_wait', {
        window: 'Notepad',
        name: 'OK',
        prompt: 'Click OK',
        until: { condition: 'disappears', name: 'OK' }
    });
    assert.equal(isError, true, text);
    assert.match(text, /no control matching/);
});

test('a step in a dialog that is still filling in waits for its target before the precheck', async () => {
    const desktop = fakeDesktop();
    const exportDialog = { ...desktop.windows[0], ref: '500', title: 'Export', foreground: true };
    const ok = { ref: 'el_40', name: 'OK', role: 'button', rect: rect(400, 400, 60, 24), enabled: true };
    let open = false;
    let okFinds = 0;
    fakeHelper(
        {
            list_windows: () =>
                open ? [{ ...desktop.windows[0], foreground: false }, exportDialog, ...desktop.windows.slice(1)] : desktop.windows,
            find_elements: p => {
                if (p.name === 'File') {
                    open = true;
                    return [{ ...save, name: 'File', role: 'menuitem' }];
                }
                if (p.name === 'OK') {
                    okFinds += 1;
                    // An empty tree for the first looks, then the button, which
                    // goes once the user has clicked it.
                    return okFinds <= 2 || okFinds > 6 ? [] : [ok];
                }
                return [];
            }
        },
        desktop
    );
    const { text, isError } = await call('highlight_and_wait', {
        window: 'Notepad',
        name: 'File',
        prompt: 'Export',
        until: { condition: 'appears', role: 'window', name: 'Export' },
        then: [{ name: 'OK', prompt: 'Click OK', until: { condition: 'disappears', name: 'OK' } }],
        timeoutMs: 8000
    });
    assert.equal(isError, false, text);
    assert.match(text, /\nStep 2\/2: Met: "disappears"/);
});

test('after a dialog closes, the plan carries on in its app\'s other window', async () => {
    const desktop = fakeDesktop();
    const dialog = { ...desktop.windows[0], ref: '500', title: 'Options', foreground: true };
    const ok = { ref: 'el_40', name: 'OK', role: 'button', rect: rect(400, 400, 60, 24), enabled: true };
    let closed = false;
    let okFinds = 0;
    let savedFinds = 0;
    const { calls } = fakeHelper(
        {
            list_windows: () =>
                closed ? desktop.windows : [{ ...desktop.windows[0], foreground: false }, dialog, ...desktop.windows.slice(1)],
            find_elements: p => {
                if (p.window === '500' && closed) throw new Error("no window for ref '500': element not found");
                if (p.name === 'OK') {
                    if (++okFinds > 3) closed = true;
                    return closed ? [] : [ok];
                }
                if (p.name === 'Save') return [save];
                if (p.name === 'Saved') return ++savedFinds > 2 ? [saved] : [];
                return [];
            }
        },
        desktop
    );
    const { text, isError } = await call('highlight_and_wait', {
        window: '500',
        name: 'OK',
        prompt: 'Click OK',
        until: { condition: 'disappears', name: 'OK' },
        then: [{ name: 'Save', prompt: 'Click Save', until: { condition: 'appears', name: 'Saved' } }],
        timeoutMs: 8000
    });
    assert.equal(isError, false, text);
    assert.match(text, /\nStep 2\/2: Met: "appears"/);
    const saveFinds = calls.filter(c => c.op === 'find_elements' && c.params.name === 'Save');
    assert.ok(saveFinds.length > 0 && saveFinds.every(c => c.params.window === '100'), JSON.stringify(saveFinds));
});

test('"already done" hands the next step the window its until named', async () => {
    const desktop = fakeDesktop();
    const saveAs = { ...desktop.windows[0], ref: '500', title: 'Save As', foreground: false };
    const fileName = { ref: 'el_41', name: 'File name', role: 'edit', rect: rect(400, 400, 60, 24), enabled: true };
    let savedFinds = 0;
    const { calls } = fakeHelper(
        {
            list_windows: () => [...desktop.windows, saveAs],
            find_elements: p => {
                if (p.name === 'File name' && p.window === '500') return [fileName];
                if (p.name === 'Save' && p.window === '500') return [save];
                if (p.name === 'Saved') return ++savedFinds > 2 ? [saved] : [];
                return [];
            }
        },
        desktop
    );
    const { text, isError } = await call('highlight_and_wait', {
        window: 'Notepad',
        name: 'Save as',
        prompt: 'Click Save as',
        until: { condition: 'appears', name: 'File name', window: 'Save As' },
        then: [{ name: 'Save', prompt: 'Click Save', until: { condition: 'appears', name: 'Saved' } }],
        timeoutMs: 8000
    });
    assert.equal(isError, false, text);
    assert.match(text, /^Step 1\/2: Already done \(the user was ahead\)/);
    assert.match(text, /\nStep 2\/2: Met: "appears"/);
    assert.ok(calls.some(c => c.op === 'find_elements' && c.params.name === 'Save' && c.params.window === '500'));
});

// --- what the response says about the target ----------------------------------------

test('an ambiguous name says what else it matched', async () => {
    fakeHelper({
        find_elements: p => (p.name === 'Save' ? [save, { ...save, ref: 'el_9', automation_id: undefined, rect: rect(150, 400, 80, 24) }] : [])
    });
    const { text } = await call('highlight_and_wait', { ...watched, timeoutMs: 1000 });
    assert.match(text, /^Also matched "Save" \[button\]: anchor by automationId or the full name/m);
});

test('a target mostly past the edge of the screen is called out', async () => {
    const edge = { ...save, rect: rect(1900, 150, 80, 24) };
    fakeHelper({ find_elements: p => (p.name === 'Save' ? [edge] : []) });
    const { text } = await call('highlight_and_wait', { ...watched, timeoutMs: 1000 });
    assert.match(text, /^Note: the target is partly off-screen \(25% visible\); ask the user to move its window into view\.$/m);
});

test('the panel card gets what was circled and where', async () => {
    fakeHelper({ find_elements: finder(() => []) });
    const { result, step } = await pending('highlight_and_wait', watched);
    assert.equal(step.target, '"Save" [button] el_1, top-left of "Untitled - Notepad"');
    answerStep({ kind: 'skip' });
    await result;
});

// --- a target that leaves the screen during a step -----------------------------------

test('a circled control gone for a while says why, from the tracker', async () => {
    fakeHelper({ find_elements: finder(() => []) });
    const { result, step } = await pending('highlight_and_wait', watched);
    const circle = store.list().find(a => a.id === step.targetIds[0]);
    Object.assign(circle, { hidden: true, hiddenSince: Date.now() - 11_000, hiddenReason: 'minimized' });
    const { text } = await result;
    assert.match(text, /^NOT met yet: the circled control went away 1\ds ago \("Untitled - Notepad" was minimised\)\./);
    assert.match(text, /The circled control is not on screen now: "Untitled - Notepad" was minimised\./);
});

test('a target off screen for 5s is mentioned in the result', async () => {
    fakeHelper({ find_elements: finder(() => []) });
    const { result, step } = await pending('highlight_and_wait', watched);
    const circle = store.list().find(a => a.id === step.targetIds[0]);
    Object.assign(circle, { hidden: true, hiddenSince: Date.now() - 6_000, hiddenReason: 'minimized' });
    store.emit('annotations');
    answerStep({ kind: 'skip' });
    const { text } = await result;
    assert.match(text, /^Note: the circled control has been off screen for 6s: "Untitled - Notepad" was minimised\.$/m);
});

test('click mode: a target that went away ends the step and says so', async () => {
    fakeHelper();
    const { result, step } = await pending('highlight_and_wait', pointed);
    const circle = store.list().find(a => a.id === step.targetIds[0]);
    Object.assign(circle, { hidden: true, hiddenSince: Date.now() - 11_000, hiddenReason: 'closed' });
    store.emit('annotations');
    const { text, isError } = await result;
    assert.equal(isError, false);
    assert.match(text, /^NOT done: the circled control went away 1\ds ago \("Untitled - Notepad" closed\), so the user could not click it\./);
});

test('click mode: a click while the target is off screen is not on target', async () => {
    fakeHelper();
    const { result, step } = await pending('highlight_and_wait', pointed);
    const circle = store.list().find(a => a.id === step.targetIds[0]);
    Object.assign(circle, { hidden: true, hiddenSince: Date.now(), hiddenReason: 'minimized' });
    addClick(click(160, 160));
    const { text } = await result;
    assert.match(
        text,
        /^The user clicked at 160,160 on display 1.*, but the circled control was not on screen then \("Untitled - Notepad" was minimised\)\./
    );
});

// --- the end of a walkthrough ------------------------------------------------------

test('the last step of a walkthrough puts up "All N steps done"', async () => {
    let checks = 0;
    fakeHelper({ find_elements: finder(() => (++checks >= 2 ? [saved] : [])) });
    await call('highlight_and_wait', { ...watched, prompt: '5/5 Click Save', timeoutMs: 5000 });
    const label = store.list().find(a => a.type === 'label');
    assert.equal(label?.text, 'All 5 steps done');
    const left = label.expiresAt - Date.now();
    assert.ok(left <= 3000 && left > 2000, String(left));
});

test('an earlier step does not', async () => {
    let checks = 0;
    fakeHelper({ find_elements: finder(() => (++checks >= 2 ? [saved] : [])) });
    await call('highlight_and_wait', { ...watched, timeoutMs: 5000 });
    assert.equal(store.list().some(a => a.type === 'label'), false);
});

// --- progress keeps a long wait alive ---------------------------------------------

test('a blocked step reports progress to a client that asked for it', async () => {
    fakeHelper({ find_elements: finder(() => []) });
    const client = await connect();
    const seen = [];
    const result = client.callTool({ name: 'highlight_and_wait', arguments: watched }, undefined, {
        onprogress: p => seen.push(p),
        resetTimeoutOnProgress: true
    });
    await eventually(() => currentStep() !== null && seen.length > 0);
    assert.equal(seen[0].progress, 0);
    assert.equal(seen[0].message, 'Waiting for the user: 2/5 Click Save');
    answerStep({ kind: 'skip' });
    assert.match((await result).content[0].text, /^SKIPPED/);
    await client.close();
});

// --- coverage is measured where the target lives ---------------------------------

test('a menu item is measured against its own open menu, not the app window under it', async () => {
    const asked = [];
    const inMenu = { ...save, window: '500' };
    fakeHelper({
        find_elements: p => (p.name === 'Save' ? [inMenu] : []),
        covered: p => {
            asked.push(p.window);
            return { fraction: 0, centre_covered: false, by: [] };
        }
    });
    await call('highlight_and_wait', { window: 'Notepad', name: 'Save', prompt: 'p', until: { condition: 'appears', name: 'Saved' }, timeoutMs: 1000 });
    assert.ok(asked.length > 0, 'coverage was checked');
    assert.ok(asked.every(w => w === '500'), `measured against ${asked.join(', ')}`);
});

test('when the chat panel is what covers the target, the advice is to move the panel', async () => {
    fakeHelper({
        find_elements: finder(() => [saved]),
        covered: () => ({ fraction: 0.9, centre_covered: true, by: ["the overlay's chat panel"] })
    });
    const { text } = await call('highlight_and_wait', { window: 'Notepad', name: 'Save', prompt: 'p', until: { condition: 'disappears', name: 'Saved' }, timeoutMs: 1000 });
    assert.match(text, /behind "the overlay's chat panel"; ask the user to drag the chat panel aside or hide it with Ctrl\+Shift\+O\./);
    assert.equal(/focus_window \{window/.test(text), false);
});
