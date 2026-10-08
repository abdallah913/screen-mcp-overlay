import { ipcMain } from 'electron';
import type { ClickResult, Point } from '../shared/types.js';
import { physicalToImagePoint, rectContains } from '../shared/geometry.js';
import { listDisplays } from './displays.js';
import { hudBounds } from './hud.js';
import { store } from './store.js';
import { addClick, cancelStep, currentCaptureId } from './steps.js';

/**
 * Human-in-the-loop pointing. While a click-mode step is pending the overlay
 * turns interactive, and each click it reports is converted here into every
 * coordinate space the agent might need -- including back into the screenshot
 * it was looking at when it asked -- and handed to the step (steps.ts).
 *
 * Implemented as a long-running tool call rather than MCP elicitation on
 * purpose: elicitation is form/URL-shaped and unsupported by several clients,
 * while a blocking tool call works everywhere.
 */

export function initClicks(): void {
    ipcMain.on('overlay:click', (_e, payload: { displayId: string; dip: Point }) => {
        const display = listDisplays().find(d => d.id === payload.displayId);
        if (!display) return;
        // The panel is raised above the overlay while a click is pending, so a
        // click on it should never get here; if the z-order lost that race, a
        // press meant for the panel's own buttons is still not the answer.
        const panel = hudBounds();
        const global = { x: display.dipBounds.x + payload.dip.x, y: display.dipBounds.y + payload.dip.y };
        if (panel && rectContains(panel, global)) return;

        const physical: Point = {
            x: payload.dip.x * display.scaleFactor,
            y: payload.dip.y * display.scaleFactor
        };
        const result: ClickResult = {
            displayId: display.id,
            physical: round(physical),
            dip: round(payload.dip),
            normalized: {
                x: +(physical.x / display.physicalSize.width).toFixed(4),
                y: +(physical.y / display.physicalSize.height).toFixed(4)
            }
        };

        const captureId = currentCaptureId();
        const capture = captureId ? store.capture(captureId) : undefined;
        if (capture && capture.displayId === display.id) {
            result.image = round(physicalToImagePoint(physical, capture));
        }
        addClick(result);
    });

    ipcMain.on('overlay:cancel-click', () => {
        cancelStep('esc');
    });
}

function round(p: Point): Point {
    return { x: Math.round(p.x), y: Math.round(p.y) };
}
