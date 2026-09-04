#!/usr/bin/env node
/**
 * Exercises wait_for_element against a real UI state change.
 *
 * Opens Notepad on a delay and waits for its window to appear, then closes it
 * and waits for it to disappear. Proves the tool actually blocks and releases on
 * the transition rather than just sleeping.
 */

import { connectOverlay, textOf } from './lib/client.mjs';
import { spawn, execFileSync } from 'node:child_process';

const c = await connectOverlay('dev-script');

// --- appears ---------------------------------------------------------------
console.log('launching Notepad in 3s; waiting for it to appear (timeout 30s)…');
setTimeout(() => spawn('notepad.exe', [], { detached: true, stdio: 'ignore' }).unref(), 3000);

let started = Date.now();
console.log('\n' + textOf(await c.callTool({
    name: 'wait_for_element',
    arguments: { condition: 'appears', name: 'Notepad', role: 'window', timeoutMs: 30000, pollMs: 400 }
})));
console.log(`(client-side elapsed: ${((Date.now() - started) / 1000).toFixed(1)}s)`);

// --- disappears ------------------------------------------------------------
console.log('\nclosing Notepad in 3s; waiting for it to disappear (timeout 30s)…');
setTimeout(() => {
    try {
        execFileSync('powershell', ['-NoProfile', '-Command',
            "Get-Process notepad -ErrorAction SilentlyContinue | Stop-Process -Force"], { stdio: 'pipe' });
    } catch {}
}, 3000);

started = Date.now();
console.log('\n' + textOf(await c.callTool({
    name: 'wait_for_element',
    arguments: { condition: 'disappears', name: 'Notepad', role: 'window', timeoutMs: 30000, pollMs: 400 }
})));
console.log(`(client-side elapsed: ${((Date.now() - started) / 1000).toFixed(1)}s)`);

// --- timeout path ----------------------------------------------------------
started = Date.now();
console.log('\n' + textOf(await c.callTool({
    name: 'wait_for_element',
    arguments: { condition: 'appears', name: 'ThisControlDoesNotExist', timeoutMs: 4000, pollMs: 500 }
})));
console.log(`(client-side elapsed: ${((Date.now() - started) / 1000).toFixed(1)}s)`);

await c.close();
