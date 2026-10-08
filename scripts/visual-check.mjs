#!/usr/bin/env node
/**
 * Draws a known set of shapes at known coordinates, then captures the screen
 * and reports where the PNG landed, so the placement can be eyeballed.
 * Only meaningful when the overlay is running with
 * SCREEN_OVERLAY_SHOW_IN_CAPTURE=1, otherwise it excludes itself from capture.
 */

import { captureIdOf, captureSizeOf, connectOverlay, textOf } from './lib/client.mjs';

const client = await connectOverlay('dev-script');

// A reference capture first, so we can address the screen in image coordinates.
const first = textOf(await client.callTool({ name: 'capture_screen', arguments: { maxDimension: 1200 } }));
const captureId = captureIdOf(first);
const [W, H] = captureSizeOf(first);
console.log(`reference capture ${captureId}: ${W}x${H}`);

// Shapes placed at exact fractions of the image so misplacement is obvious.
// Corner boxes keep explicit colours so each corner is identifiable; the rest
// use the default palette, which is what agents usually get.
await client.callTool({
    name: 'annotate',
    arguments: {
        space: 'image',
        captureId,
        shapes: [
            { type: 'box', x: 0, y: 0, width: 200, height: 100, text: 'top-left 0,0', color: '#ff2d95' },
            { type: 'box', x: W - 200, y: 0, width: 199, height: 100, text: 'top-right', color: '#32d74b' },
            { type: 'box', x: 0, y: H - 100, width: 200, height: 99, text: 'bottom-left', color: '#7a3cff' },
            { type: 'box', x: W - 200, y: H - 100, width: 199, height: 99, text: 'bottom-right', color: '#ffd60a' },
            // A menu-bar target touching the top edge: its caption must sit beside
            // it, never on it and never below it where the menu would open.
            { type: 'circle', x: 230, y: 0, width: 60, height: 24, text: '1/4 File menu at the top edge', pulse: true },
            { type: 'circle', x: W / 2 - 90, y: H / 2 - 90, width: 180, height: 180, text: 'dead centre' },
            // Wide target: a rounded ring, not an ellipse cutting its ends.
            {
                type: 'circle',
                x: W / 2 - 220,
                y: H / 2 + 130,
                width: 440,
                height: 34,
                text:
                    'A deliberately long prompt that should wrap into a compact block of at most three lines ' +
                    'beside its target instead of running across the display, ending in an ellipsis when cut'
            },
            { type: 'arrow', x: W / 2 - 300, y: H / 2 - 220, toX: W / 2 - 92, toY: H / 2 - 92, text: 'arrow tail' },
            { type: 'highlight', x: W / 2 - 200, y: H - 200, width: 400, height: 60, text: 'highlight band' },
            // Short step text is the badge; long text is a caption beside it.
            { type: 'step', x: 260, y: 160, width: 150, height: 70, text: '1' },
            { type: 'step', x: 440, y: 160, width: 150, height: 70, text: '2' },
            { type: 'step', x: 620, y: 160, width: 150, height: 70, text: 'Pick the format' },
            // Two spotlights: both holes lit by one scrim, and the caption shown.
            { type: 'spotlight', x: W - 520, y: H / 2 - 60, width: 140, height: 90, text: 'spotlight A' },
            { type: 'spotlight', x: W - 340, y: H / 2 - 60, width: 140, height: 90 }
        ]
    }
});
console.log('drew corners, a top-edge menu target, a wide ring, a wrapped caption, steps and two spotlights');

// Give the compositor a moment, then capture what is actually on screen.
await new Promise(r => setTimeout(r, 700));
const after = textOf(await client.callTool({ name: 'capture_screen', arguments: { maxDimension: 1200 } }));
console.log(`\n${after}`);

await client.close();
