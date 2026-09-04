#!/usr/bin/env node
/**
 * Exercises describe_window and the one-call selector anchor, and reports what
 * the tree costs against a screenshot of the same window.
 */

import { connectOverlay, textOf } from './lib/client.mjs';
import { statSync } from 'node:fs';
import { join } from 'node:path';

const c = await connectOverlay('dev-script');

const wins = textOf(await c.callTool({ name: 'list_windows', arguments: {} }));
const m = /- ref=(\d+)[^\n]*\n\s+title: ([^\n]+)/.exec(wins);
const [, ref, title] = m;
console.log(`window: ${title.slice(0, 55)}  ref=${ref}\n`);

const tree = textOf(await c.callTool({ name: 'describe_window', arguments: { window: ref, maxNodes: 60 } }));
console.log('--- describe_window (first 18 lines) ---');
console.log(tree.split('\n').slice(0, 18).join('\n'));

const treeTokens = Math.round(tree.length / 3.7);
console.log(`\ntree: ${tree.length} chars  =>  ~${treeTokens} tokens`);

const cap = textOf(await c.callTool({ name: 'capture_screen', arguments: { maxDimension: 1568 } }));
const png = statSync(/path: (.+)/.exec(cap)[1].trim()).size;
// Anthropic vision cost is roughly (w*h)/750 tokens; 1568px longest edge on a
// 16:9 display is about 1568x882.
const imgTokens = Math.round((1568 * 882) / 750);
console.log(`screenshot: ${(png / 1024).toFixed(0)} KB  =>  ~${imgTokens} tokens`);
console.log(`ratio: describe_window is ~${(imgTokens / treeTokens).toFixed(1)}x cheaper`);

// --- one-call selector anchor ---------------------------------------------
console.log('\n--- annotate with anchor kind "name" (single call) ---');
console.log(
    t(
        await c.callTool({
            name: 'annotate',
            arguments: {
                anchor: { kind: 'name', window: ref, name: 'Close', role: 'button' },
                shapes: [{ type: 'circle', fit: true, pad: 10, color: '#ff2d55', text: 'Close' }]
            }
        })
    )
);

console.log('\n--- assertion mode: wait_for_element timeoutMs 0 ---');
console.log(
    t(
        await c.callTool({
            name: 'wait_for_element',
            arguments: { condition: 'appears', window: ref, name: 'Close', role: 'button', timeoutMs: 0 }
        })
    )
);

await new Promise(r => setTimeout(r, 2500));
await c.callTool({ name: 'clear_annotations', arguments: {} });
await c.close();
