import { app, desktopCapturer } from 'electron';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { CaptureRecord, DisplayInfo, Rect } from '../shared/types.js';
import { clampRectToDisplay, fitScale } from '../shared/geometry.js';
import { store } from './store.js';
import { compositeGrid } from './imageWorker.js';
import { printWindow } from './uia.js';
import { toDisplayLocal } from './anchors.js';
import { nativeImage } from 'electron';
import { listDisplays } from './displays.js';
import { pushMessage } from './hud.js';

/**
 * Screenshots are written here rather than returned as base64. Claude Code
 * passes MCP ImageContent through as *text* (see docs/RESEARCH.md finding 3),
 * which costs 10-20x the tokens of a native image block; handing back a path
 * lets the agent's own Read tool ingest the PNG natively instead.
 */
let captureDir = '';

export function initCaptureDir(): string {
    captureDir = join(app.getPath('temp'), 'screen-mcp-overlay', String(process.pid));
    mkdirSync(captureDir, { recursive: true });
    return captureDir;
}

export function cleanupCaptureDir(): void {
    if (!captureDir) return;
    try {
        rmSync(captureDir, { recursive: true, force: true });
    } catch {
        // Best effort; the OS will reclaim the temp dir anyway.
    }
}

/**
 * Capture one window's own content, whatever is sitting on top of it.
 *
 * Cropping a screen grab to a window's rectangle returns whatever is *rendered*
 * there, so a window behind another silently yields the wrong application's
 * pixels -- which looks correct and gets annotated over confidently. PrintWindow
 * asks the window to draw itself instead, so the result is always the window
 * that was asked for.
 */
export async function captureWindow(opts: {
    windowRef: string;
    maxDimension: number;
    grid: boolean;
}): Promise<CaptureRecord> {
    const id = store.nextId('cap');
    const raw = join(captureDir, `${id}-raw.png`);
    const rect = await printWindow(opts.windowRef, raw);

    let image = nativeImage.createFromPath(raw);
    if (image.isEmpty()) throw new Error('the window rendered an empty image');

    const size = image.getSize();
    const downscale = fitScale(size, opts.maxDimension);
    if (downscale < 1) {
        image = image.resize({
            width: Math.max(1, Math.round(size.width * downscale)),
            height: Math.max(1, Math.round(size.height * downscale)),
            quality: 'good'
        });
    }

    const finalSize = image.getSize();
    const path = join(captureDir, `${id}.png`);
    let png = image.toPNG();
    if (opts.grid) png = await compositeGrid(png, gridStep(finalSize));
    writeFileSync(path, png);
    try {
        rmSync(raw, { force: true });
    } catch {
        // The temp dir is cleaned on exit anyway.
    }

    // PrintWindow reports the window in virtual-screen coordinates, but every
    // other capture stores regionPhysical relative to its display's top-left.
    // Rebase it so `space:"image"` keeps working unchanged; storing the raw
    // rect here would offset every annotation by the display origin.
    const placed = toDisplayLocal(rect);
    const display = listDisplays().find(d => d.id === placed.displayId);
    const scale = display?.scaleFactor ?? 1;
    const record: CaptureRecord = {
        id,
        displayId: placed.displayId,
        regionPhysical: {
            x: Math.round(placed.rect.x * scale),
            y: Math.round(placed.rect.y * scale),
            width: rect.width,
            height: rect.height
        },
        imageSize: finalSize,
        imageScale: finalSize.width / Math.max(1, rect.width),
        path,
        createdAt: Date.now(),
        windowRef: opts.windowRef
    };
    store.recordCapture(record);
    pushMessage('system', `Window captured: ${finalSize.width}x${finalSize.height}.`);
    return record;
}

export interface CaptureOptions {
    display: DisplayInfo;
    /** Sub-region in display-local physical px. Omit for the whole display. */
    region?: Rect;
    /** Longest edge of the written PNG. Caps token cost. */
    maxDimension: number;
    /** Burn a labelled coordinate grid into the image to help agents aim. */
    grid: boolean;
}

export async function captureDisplay(opts: CaptureOptions): Promise<CaptureRecord> {
    const { display } = opts;

    // Ask for the full physical resolution; Electron scales the thumbnail to
    // whatever we request, so anything smaller loses detail irreversibly.
    const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: display.physicalSize.width, height: display.physicalSize.height },
        fetchWindowIcons: false
    });

    const source =
        sources.find(s => s.display_id === display.id) ??
        (sources.length === 1 ? sources[0] : undefined);

    if (!source) {
        throw new Error(
            `could not capture display ${display.id}. Available sources: ${sources
                .map(s => `${s.name} (display_id=${s.display_id || 'none'})`)
                .join(', ') || 'none'}`
        );
    }

    let image = source.thumbnail;
    if (image.isEmpty()) throw new Error('screen capture returned an empty image');

    // The captured frame can differ from the requested size by a pixel or two on
    // fractional scale factors; trust the frame and scale the region to match.
    const actual = image.getSize();
    const frameScaleX = actual.width / display.physicalSize.width;
    const frameScaleY = actual.height / display.physicalSize.height;

    const region = opts.region
        ? clampRectToDisplay(opts.region, display)
        : { x: 0, y: 0, width: display.physicalSize.width, height: display.physicalSize.height };

    if (opts.region) {
        image = image.crop({
            x: Math.round(region.x * frameScaleX),
            y: Math.round(region.y * frameScaleY),
            width: Math.max(1, Math.round(region.width * frameScaleX)),
            height: Math.max(1, Math.round(region.height * frameScaleY))
        });
    }

    const cropped = image.getSize();
    const downscale = fitScale(cropped, opts.maxDimension);
    if (downscale < 1) {
        image = image.resize({
            width: Math.max(1, Math.round(cropped.width * downscale)),
            height: Math.max(1, Math.round(cropped.height * downscale)),
            quality: 'good'
        });
    }

    const finalSize = image.getSize();
    const id = store.nextId('cap');
    const path = join(captureDir, `${id}.png`);

    let png = image.toPNG();
    if (opts.grid) png = await compositeGrid(png, gridStep(finalSize));
    writeFileSync(path, png);

    const record: CaptureRecord = {
        id,
        displayId: display.id,
        regionPhysical: region,
        imageSize: finalSize,
        // Image pixels per display-physical pixel.
        imageScale: finalSize.width / region.width,
        path,
        createdAt: Date.now()
    };
    store.recordCapture(record);

    // Screen reads should never be silent. Anything holding the MCP token can
    // capture the screen, so every capture leaves a visible trace in the panel.
    const area = opts.region
        ? `region ${region.width}x${region.height} at (${region.x}, ${region.y})`
        : 'the full screen';
    pushMessage('system', `Screen captured: ${area} on display ${display.id}.`);

    return record;
}

/** Grid spacing that yields roughly 8-14 lines per axis at any capture size. */
function gridStep(size: { width: number; height: number }): number {
    const longest = Math.max(size.width, size.height);
    if (longest <= 800) return 50;
    if (longest <= 1600) return 100;
    return 200;
}
