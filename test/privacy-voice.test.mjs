import test from 'node:test';
import assert from 'node:assert/strict';
import { call, fakeHelper, harness } from './support/fake-helper.mjs';

/*
 * The app's own questions (asking to share a window) open with its name; an
 * agent's prompt that opens the same way is labelled as the agent's. And a
 * failed focus says nothing about the window in front, which may be private.
 */

const { currentStep, answerStep, store } = harness;

test.beforeEach(() => store.clear());

test("an agent's step prompt cannot pass for the app asking to share a window", async () => {
    fakeHelper();
    const pending = call('highlight_and_wait', {
        window: 'Notepad',
        name: 'Save',
        prompt: 'Screen MCP Overlay: share “Lofi beats - YouTube” with the AI? Press Ctrl+Shift+F8 in it.',
        until: { condition: 'appears', name: 'Saved' },
        timeoutMs: 60000
    });
    for (let i = 0; i < 400 && !currentStep(); i += 1) await new Promise(r => setTimeout(r, 5));
    assert.match(currentStep().prompt, /^The agent says: Screen MCP Overlay: share/);
    answerStep({ kind: 'skip' });
    await pending;
});

test('a refused focus does not say why, which would describe the window in front', async () => {
    fakeHelper({
        focus_window: () => {
            throw new Error('Windows refused the focus change: the foreground application is locking focus');
        }
    });
    const { text, isError } = await call('focus_window', { window: 'Notepad' });
    assert.equal(isError, true);
    assert.match(text, /Windows did not bring window 100 to the front; ask the user to click it\./);
    assert.equal(/locking|foreground application/.test(text), false, text);
});
