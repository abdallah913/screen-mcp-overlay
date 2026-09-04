#!/usr/bin/env node
/**
 * End-to-end check against a running overlay: connects as a real MCP client,
 * lists the tools, captures the screen, draws every shape type, then clears.
 * Run `npm start` in another terminal first.
 */

import { connectOverlay, textOf } from './lib/client.mjs';
import { statSync } from 'node:fs';


const client = await connectOverlay('dev-script');
console.log('connected to the overlay');

const { tools } = await client.listTools();
console.log(`\ntools (${tools.length}):`);
for (const t of tools) console.log(`  ${t.name} - ${(t.description ?? '').split('\n')[0]}`);


console.log('\n--- list_displays ---');
console.log(textOf(await client.callTool({ name: 'list_displays', arguments: {} })));

console.log('\n--- capture_screen (with grid) ---');
const cap = await client.callTool({ name: 'capture_screen', arguments: { grid: true } });
const capText = textOf(cap);
console.log(capText);

const captureId = /captureId: (\S+)/.exec(capText)?.[1];
const path = /path: (.+)/.exec(capText)?.[1]?.trim();
if (!captureId || !path) throw new Error('capture_screen did not return a captureId and path');
console.log(`PNG on disk: ${statSync(path).size} bytes`);

console.log('\n--- annotate: every shape type, in image coordinates ---');
console.log(
    textOf(
        await client.callTool({
            name: 'annotate',
            arguments: {
                space: 'image',
                captureId,
                shapes: [
                    { type: 'spotlight', x: 80, y: 80, width: 620, height: 380, dim: 0.55 },
                    { type: 'box', x: 120, y: 120, width: 260, height: 90, text: 'box + caption', pulse: true },
                    { type: 'highlight', x: 120, y: 240, width: 260, height: 60, text: 'highlight' },
                    { type: 'circle', x: 430, y: 120, width: 180, height: 180, text: 'circle' },
                    { type: 'arrow', x: 700, y: 500, toX: 480, toY: 300 },
                    { type: 'label', x: 710, y: 512, text: 'arrow points here' },
                    { type: 'step', x: 120, y: 340, width: 200, height: 80, text: '1' },
                    { type: 'step', x: 360, y: 340, width: 200, height: 80, text: '2' }
                ]
            }
        })
    )
);

console.log('\n--- annotate: normalized coordinates on the primary display ---');
console.log(
    textOf(
        await client.callTool({
            name: 'annotate',
            arguments: {
                space: 'normalized',
                display: 'primary',
                replace: false,
                ttlMs: 4000,
                shapes: [{ type: 'box', x: 0.7, y: 0.7, width: 0.25, height: 0.2, text: 'normalized, 4s ttl' }]
            }
        })
    )
);

console.log('\n--- show_message ---');
console.log(textOf(await client.callTool({ name: 'show_message', arguments: { text: 'Smoke test running.' } })));

console.log('\n--- error handling: bad captureId ---');
const bad = await client.callTool({ name: 'annotate', arguments: { captureId: 'cap_nope', shapes: [{ type: 'box', x: 0, y: 0, width: 10, height: 10 }] } });
console.log(`isError=${bad.isError} :: ${textOf(bad)}`);

console.log('\n--- error handling: missing width/height ---');
const bad2 = await client.callTool({ name: 'annotate', arguments: { space: 'physical', shapes: [{ type: 'box', x: 0, y: 0 }] } });
console.log(`isError=${bad2.isError} :: ${textOf(bad2)}`);

const keepMs = Number(process.env.SMOKE_HOLD_MS ?? 6000);
console.log(`\nleaving annotations up for ${keepMs}ms so you can look at them…`);
await new Promise(r => setTimeout(r, keepMs));

console.log('\n--- clear_annotations ---');
console.log(textOf(await client.callTool({ name: 'clear_annotations', arguments: {} })));

await client.close();
console.log('\nsmoke test passed');
