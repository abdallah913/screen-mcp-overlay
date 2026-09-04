#!/usr/bin/env node
/**
 * Draws a known set of shapes at known coordinates, then captures the screen
 * and reports where the PNG landed, so the placement can be eyeballed.
 * Only meaningful when the overlay is running with
 * SCREEN_OVERLAY_SHOW_IN_CAPTURE=1, otherwise it excludes itself from capture.
 */

import { connectOverlay, textOf } from './lib/client.mjs';

const client = await connectOverlay('dev-script');


// A reference capture first, so we can address the screen in image coordinates.
const first = textOf(await client.callTool({ name: 'capture_screen', arguments: { maxDimension: 1200 } }));
const captureId = /captureId: (\S+)/.exec(first)[1];
const size = /Captured (\d+)x(\d+)/.exec(first);
const W = Number(size[1]);
const H = Number(size[2]);
console.log(`reference capture ${captureId}: ${W}x${H}`);

// Shapes placed at exact fractions of the image so misplacement is obvious.
await client.callTool({
    name: 'annotate',
    arguments: {
        space: 'image',
        captureId,
        shapes: [
            { type: 'box', x: 0, y: 0, width: 200, height: 100, text: 'top-left 0,0', color: '#ff3b30' },
            {
                type: 'box',
                x: W - 200,
                y: 0,
                width: 199,
                height: 100,
                text: 'top-right',
                color: '#32d74b'
            },
            { type: 'box', x: 0, y: H - 100, width: 200, height: 99, text: 'bottom-left', color: '#0a84ff' },
            {
                type: 'box',
                x: W - 200,
                y: H - 100,
                width: 199,
                height: 99,
                text: 'bottom-right',
                color: '#ffd60a'
            },
            {
                type: 'circle',
                x: W / 2 - 90,
                y: H / 2 - 90,
                width: 180,
                height: 180,
                text: 'dead centre',
                color: '#ff2d55',
                pulse: true
            },
            { type: 'arrow', x: W / 2 - 300, y: H / 2 - 220, toX: W / 2 - 92, toY: H / 2 - 92 },
            { type: 'highlight', x: W / 2 - 200, y: H - 200, width: 400, height: 60, text: 'highlight band' },
            { type: 'step', x: 260, y: 160, width: 150, height: 70, text: '1' },
            { type: 'step', x: 440, y: 160, width: 150, height: 70, text: '2' },
            { type: 'step', x: 620, y: 160, width: 150, height: 70, text: '3' }
        ]
    }
});
console.log('drew corner markers, centre circle, arrow, highlight and 3 steps');

// Give the compositor a moment, then capture what is actually on screen.
await new Promise(r => setTimeout(r, 700));
const after = textOf(await client.callTool({ name: 'capture_screen', arguments: { maxDimension: 1200 } }));
console.log(`\n${after}`);

await client.close();
