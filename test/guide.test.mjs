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
        until: { condition: 'appears', role: 'window' },
        timeoutMs: 1000
    });
    assert.equal(isError, false, text);
    assert.match(text, /^NOT met: "appears" did not happen/);
    assert.match(text, /already open before the step/);
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
            list_windows: () => (++lists > 3 ? [...desktop.windows, { ...desktop.windows[1], ref: '600', title: 'Font' }] : desktop.windows)
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
