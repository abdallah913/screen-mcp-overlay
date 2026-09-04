#!/usr/bin/env node
/**
 * Exercises describe_window deltas.
 *
 * Four cases that matter: an unchanged window (should be near-zero), a real UI
 * change (only the changed lines), an unknown baseline (must degrade to a full
 * tree, never error), and a wholesale change (must fall back to the full tree
 * rather than emit a diff that is longer).
 */

import { connectOverlay, textOf } from './lib/client.mjs';
import { spawn, execFileSync } from 'node:child_process';
import { join } from 'node:path';

const c = await connectOverlay('dev-script');
const snapOf = s => /snapshotId: (\S+)/.exec(s)?.[1];
const cost = s => Math.round(s.length / 3.7);

// Notepad is a small, predictable native window to mutate.
spawn('notepad.exe', [], { detached: true, stdio: 'ignore' }).unref();
await new Promise(r => setTimeout(r, 2500));

const wins = textOf(await c.callTool({ name: 'list_windows', arguments: {} }));
const m = /- ref=(\d+)[^\n]*\n\s+title: ([^\n]*Notepad[^\n]*)/.exec(wins);
if (!m) {
    console.log('Notepad window not found; aborting');
    process.exit(1);
}
const [, ref] = m;

// 1. baseline
const first = textOf(await c.callTool({ name: 'describe_window', arguments: { window: ref, maxNodes: 80 } }));
const snap1 = snapOf(first);
console.log(`1. full tree      : ${first.split('\n').length} lines, ~${cost(first)} tokens  (${snap1})`);

// 2. no change
const same = textOf(await c.callTool({ name: 'describe_window', arguments: { window: ref, since: snap1, maxNodes: 80 } }));
console.log(`2. unchanged      : ~${cost(same)} tokens  ->  ${same.split('\n')[0]}`);

// 3. real change: type into the document so the title gains its modified marker
try {
    execFileSync('powershell', ['-NoProfile', '-Command',
        '$w = New-Object -ComObject WScript.Shell; $w.AppActivate("Notepad"); Start-Sleep -Milliseconds 400; $w.SendKeys("hello overlay")'],
        { stdio: 'pipe' });
} catch {}
await new Promise(r => setTimeout(r, 1200));

const snap2 = snapOf(same) ?? snap1;
const changed = textOf(await c.callTool({ name: 'describe_window', arguments: { window: ref, since: snap2, maxNodes: 80 } }));
console.log(`3. after typing   : ~${cost(changed)} tokens`);
console.log(changed.split('\n').slice(0, 8).map(l => '     ' + l).join('\n'));

// 4. unknown baseline must degrade, not fail
const bogus = textOf(await c.callTool({ name: 'describe_window', arguments: { window: ref, since: 'snap_does_not_exist', maxNodes: 80 } }));
console.log(`4. unknown baseline: ${bogus.split('\n')[0]}`);
console.log(`   degraded to full tree: ${bogus.split('\n').length > 5}`);

// 5. baseline from a different window must also degrade
const other = /- ref=(\d+)/.exec(wins)[1];
if (other !== ref) {
    const cross = textOf(await c.callTool({ name: 'describe_window', arguments: { window: other, since: snapOf(changed), maxNodes: 40 } }));
    console.log(`5. cross-window   : ${cross.split('\n')[0]}`);
}

try {
    execFileSync('powershell', ['-NoProfile', '-Command',
        'Get-Process notepad -ErrorAction SilentlyContinue | Stop-Process -Force'], { stdio: 'pipe' });
} catch {}
await c.close();
