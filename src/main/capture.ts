import { app, desktopCapturer, screen, type NativeImage } from 'electron';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { CaptureRecord, DisplayInfo, Rect } from '../shared/types.js';
import { clampRectToDisplay, fitScale } from '../shared/geometry.js';
import { captureLayers, keptInFrame, nearlyUniform } from '../shared/windows.js';
import { maskBitmap, type Layer } from '../shared/visible.js';
import { store } from './store.js';
import { compositeGrid } from './imageWorker.js';
import { hudWindowRef, listAllWindows, printWindow, windowStack } from './uia.js';
import { isShared } from './sharing.js';
import { toDisplayLocal } from './anchors.js';
import { nativeImage } from 'electron';
import { listDisplays } from './displays.js';
import { pushMessage } from './hud.js';

/**
 * Screenshots are written here rather than returned as base64. Claude Code
 * passes MCP ImageContent through as *text* (see docs/RESEARCH.md finding 3),
 * which costs 10-20x the tokens of a native image block; handing back a path
 * lets the agent's own Read tool ingest the PNG natively instead.
 *
 * Anything written here can be read by the agent's file tools (the panel's
 * agent included), so only masked images are ever written here, under names
 * nobody can guess. A window's own render, before it is known to be safe,
 * goes to `privateDir` and is deleted as soon as it is read.
 */
let captureDir = '';
let privateDir = '';

/** A file name nobody can guess, so one capture's path says nothing about another's. */
function unguessable(): string {
    return randomBytes(16).toString('hex');
}

export function initCaptureDir(): string {
    captureDir = join(app.getPath('temp'), 'screen-mcp-overlay', String(process.pid));
    mkdirSync(captureDir, { recursive: true });
    return captureDir;
}

function rawDir(): string {
    if (!privateDir) {
        privateDir = join(captureDir || initCaptureDir(), unguessable());
        mkdirSync(privateDir, { recursive: true, mode: 0o700 });
    }
    return privateDir;
}

/**
 * The screen as layers for masking: which window is on top where, and whether
 * the agent may see it. Null when the stack cannot be read, which masks the
 * whole capture rather than letting it through.
 */
async function screenLayers(): Promise<Layer[] | null> {
    try {
        const [stack, all] = await Promise.all([windowStack(), listAllWindows()]);
        // A shared window on another virtual desktop or minimised is not what
        // the screen shows where it would be: counting it as shown would keep
        // whatever really is there.
        const away = new Set(all.filter(w => w.cloaked || w.minimized).map(w => w.ref));
        const onScreen = stack.filter(w => !away.has(w.ref));
        return captureLayers(onScreen, { pid: process.pid, panel: hudWindowRef() }, w => isShared(w, stack));
    } catch {
        return null;
    }
}

/**
 * `image` with everything outside `keep` (its own pixels) painted one flat
 * colour, at full resolution: before any resize, whose filtering would bleed
 * hidden pixels into the edges of what is kept. A bitmap that is not the shape
 * expected is blanked whole.
 */
function masked(image: NativeImage, keep: Rect[]): NativeImage {
    const { width, height } = image.getSize();
    const bitmap = image.toBitmap();
    const ok = bitmap.length === width * height * 4;
    const out = maskBitmap(ok ? bitmap : new Uint8Array(width * height * 4), width, height, ok ? keep : []);
    return nativeImage.createFromBitmap(Buffer.from(out.buffer, out.byteOffset, out.byteLength), { width, height });
}

export function cleanupCaptureDir(): void {
    if (!captureDir) return;
    try {
        rmSync(captureDir, { recursive: true, force: true });
    } catch {
        // Best effort; the OS will reclaim the temp dir anyway.
    }
}

export interface WindowCapture {
    record: CaptureRecord;
    /** The raw window rect the image covers, virtual-screen physical, invisible resize border included. */
    rect: Rect;
    /** The render is one flat colour: how PrintWindow sees GPU and DirectX surfaces. */
    blank: boolean;
}

/**
 * Capture one window's own content, whatever is sitting on top of it.
 *
 * Cropping a screen grab to a window's rectangle returns whatever is *rendered*
 * there, so a window behind another silently yields the wrong application's
 * pixels -- which looks correct and gets annotated over confidently. PrintWindow
 * asks the window to draw itself instead, so the result is always the window
 * that was asked for.
 *
 * Two ways that can still go wrong are reported rather than hidden: the window
 * refused to render, so the helper copied the screen (`record.fallback`), or
 * it rendered blank. A screen copy is masked like any screen capture: only
 * what a shared window shows on top survives, so whatever covers the window
 * and the strips of desktop around its frame are blanked.
 */
export async function captureWindow(opts: {
    windowRef: string;
    maxDimension: number;
    maxPixels?: number;
    grid: boolean;
}): Promise<WindowCapture> {
    const id = store.nextId('cap');
    // Read before the render as well as after: a fallback is only known once
    // it happened, and windows can move while it does.
    const before = await screenLayers();
    const raw = join(rawDir(), `${unguessable()}.png`);
    let rect: Rect;
    let fallback: boolean;
    let image: NativeImage;
    try {
        ({ rect, fallback } = await printWindow(opts.windowRef, raw));
        image = nativeImage.createFromPath(raw);
    } finally {
        try {
            rmSync(raw, { force: true });
        } catch {
            // The temp dir is cleaned on exit anyway.
        }
    }
    if (image.isEmpty()) throw new Error('the window rendered an empty image');
    if (fallback) image = masked(image, keptInFrame(before, await screenLayers(), rect, image.getSize()));

    const size = image.getSize();
    const downscale = fitScale(size, opts.maxDimension, opts.maxPixels);
    if (downscale < 1) {
        image = image.resize({
            width: Math.max(1, Math.round(size.width * downscale)),
            height: Math.max(1, Math.round(size.height * downscale)),
            quality: 'good'
        });
    }

    const finalSize = image.getSize();
    const blank = nearlyUniform(image.toBitmap(), finalSize.width, finalSize.height);
    const path = join(captureDir, `${unguessable()}.png`);
    let png = image.toPNG();
    if (opts.grid) png = await compositeGrid(png, gridStep(finalSize));
    writeFileSync(path, png);

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
        windowRef: opts.windowRef,
        fallback
    };
    store.recordCapture(record);
    pushMessage('system', `Window captured: ${finalSize.width}x${finalSize.height}.`);
    return { record, rect, blank };
}

export interface CaptureOptions {
    display: DisplayInfo;
    /** Sub-region in display-local physical px. Omit for the whole display. */
    region?: Rect;
    /** Longest edge of the written PNG. Caps token cost. */
    maxDimension: number;
    /** Area cap, so a model API never has to rescale the image. */
    maxPixels?: number;
    /** Burn a labelled coordinate grid into the image to help agents aim. */
    grid: boolean;
}

/**
 * A grab of one display, with everything that is not a shared window on top
 * painted over before anything else happens to it.
 *
 * The frame holds every window the user has open, the taskbar, notifications
 * and the desktop. The windows are read before and after the grab, and only
 * what showed a shared window on top both times is kept, so a window that
 * moved mid-grab cannot slip through. Masking happens on the full frame, ahead
 * of the crop, the resize, the grid, OCR and the write.
 */
export async function captureDisplay(opts: CaptureOptions): Promise<CaptureRecord> {
    const { display } = opts;
    const before = await screenLayers();

    // Ask for the full physical resolution; Electron scales the thumbnail to
    // whatever we request, so anything smaller loses detail irreversibly.
    // Screens only: a 'window' source would carry window titles as its name.
    const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: display.physicalSize.width, height: display.physicalSize.height },
        fetchWindowIcons: false
    });

    const source =
        sources.find(s => s.display_id === display.id) ??
        (sources.length === 1 ? sources[0] : undefined);

    if (!source) throw new Error(`could not capture display ${display.id}`);

    let image = source.thumbnail;
    if (image.isEmpty()) throw new Error('screen capture returned an empty image');

    // The captured frame can differ from the requested size by a pixel or two on
    // fractional scale factors; trust the frame and scale the region to match.
    const actual = image.getSize();
    const frameScaleX = actual.width / display.physicalSize.width;
    const frameScaleY = actual.height / display.physicalSize.height;

    // Window rects are virtual-screen physical; the frame is this display's
    // physical pixels from its own top-left.
    const origin = screen.dipToScreenPoint({ x: display.dipBounds.x, y: display.dipBounds.y });
    const frame = { x: origin.x, y: origin.y, width: display.physicalSize.width, height: display.physicalSize.height };
    image = masked(image, keptInFrame(before, await screenLayers(), frame, actual));

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
    const downscale = fitScale(cropped, opts.maxDimension, opts.maxPixels);
    if (downscale < 1) {
        image = image.resize({
            width: Math.max(1, Math.round(cropped.width * downscale)),
            height: Math.max(1, Math.round(cropped.height * downscale)),
            quality: 'good'
        });
    }

    const finalSize = image.getSize();
    const id = store.nextId('cap');
    const path = join(captureDir, `${unguessable()}.png`);

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
