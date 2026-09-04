#!/usr/bin/env node
/**
 * The regression this exists for: capture_screen(window) used to crop the
 * screen, so a covered window silently returned the covering window's pixels.
 *
 * Deliberately puts a window on top of the target, then captures the target
 * both ways. The rendered capture must show the target; the asRendered capture
 * must warn that it does not.
 */

import { connectOverlay, textOf } from './lib/client.mjs';

const c = await connectOverlay('occlusion-check');

const wins = textOf(await c.callTool({ name: 'list_windows', arguments: {} }));
const entries = [
    ...wins.matchAll(/- ref=(\d+)[^\n]*\n\s+title: ([^\n]+)\n\s+rect: (\d+)x(\d+)/g)
].map(m => ({ ref: m[1], title: m[2], w: +m[3], h: +m[4] }));

if (entries.length < 2) {
    console.log('need at least two windows open for this test');
    process.exit(0);
}
const target = entries[0];
const cover = entries.find(e => e.ref !== target.ref);
console.log(`target : ${target.title.slice(0, 55)}`);
console.log(`cover  : ${cover.title.slice(0, 55)}\n`);

// Put the other window on top of the target.
console.log(textOf(await c.callTool({ name: 'focus_window', arguments: { window: cover.ref } })));
await new Promise(r => setTimeout(r, 900));

console.log('\n--- capture_screen(window) : renders the window itself ---');
const rendered = textOf(
    await c.callTool({ name: 'capture_screen', arguments: { window: target.ref, maxDimension: 1100 } })
);
console.log(rendered.split('\n').slice(0, 4).join('\n'));

console.log('\n--- capture_screen(window, asRendered) : what is actually on screen ---');
const asRendered = textOf(
    await c.callTool({
        name: 'capture_screen',
        arguments: { window: target.ref, asRendered: true, maxDimension: 1100 }
    })
);
console.log(asRendered.split('\n').filter(l => /WARNING|Captured|path:/.test(l)).join('\n'));

console.log('\n--- focus the target, then re-check occlusion ---');
console.log(textOf(await c.callTool({ name: 'focus_window', arguments: { window: target.ref } })));
await new Promise(r => setTimeout(r, 900));
const after = textOf(
    await c.callTool({
        name: 'capture_screen',
        arguments: { window: target.ref, asRendered: true, maxDimension: 1100 }
    })
);
console.log(`warns now: ${/WARNING/.test(after)}`);

console.log('\nRENDERED=' + /path: (.+)/.exec(rendered)[1].trim());
console.log('ASRENDERED=' + /path: (.+)/.exec(asRendered)[1].trim());

await c.close();
