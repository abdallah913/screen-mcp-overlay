#!/usr/bin/env node
/**
 * Compares a window-cropped capture against a full-screen one, and checks
 * whether any AutomationIds are being surfaced.
 */

import { connectOverlay, textOf } from './lib/client.mjs';
import { join } from 'node:path';

const c = await connectOverlay('dev-script');

const wins = textOf(await c.callTool({ name: 'list_windows', arguments: {} }));
console.log(wins.split('\n').slice(0, 4).join('\n'));
const m = /- ref=(\d+)[^\n]*\n\s+title: ([^\n]+)\n\s+rect: (\d+)x(\d+)/.exec(wins);
const [, ref, title, w, h] = m;
console.log(`\ntarget: ${title.slice(0, 50)}  (${w}x${h})\n`);

const full = textOf(await c.callTool({ name: 'capture_screen', arguments: { maxDimension: 1568 } }));
const cropped = textOf(await c.callTool({ name: 'capture_screen', arguments: { window: ref, maxDimension: 1568 } }));

const dims = s => /Captured (\d+)x(\d+)/.exec(s).slice(1, 3).map(Number);
const [fw, fh] = dims(full);
const [cw, ch] = dims(cropped);
const scale = s => Number(/downscaled ([\d.]+)x/.exec(s)?.[1] ?? 1);

console.log(`full screen : ${fw}x${fh}, source scale ${scale(full).toFixed(3)}`);
console.log(`window crop : ${cw}x${ch}, source scale ${scale(cropped).toFixed(3)}`);
console.log(
    `effective detail on the window: ${(scale(cropped) / scale(full)).toFixed(2)}x more source pixels per output pixel`
);
console.log(`cropped image path: ${/path: (.+)/.exec(cropped)[1].trim()}`);

// --- AutomationId coverage --------------------------------------------------
const tree = textOf(await c.callTool({ name: 'describe_window', arguments: { window: ref, maxNodes: 120 } }));
const rows = tree.split('\n').filter(l => /\bel_\d+/.test(l));
const withId = rows.filter(l => / id=/.test(l));
console.log(`\nAutomationIds: ${withId.length}/${rows.length} rows carry one`);
for (const l of withId.slice(0, 4)) console.log('   ' + l.trim().slice(0, 90));

await c.close();
