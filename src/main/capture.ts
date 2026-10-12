import { app, screen, type NativeImage } from 'electron';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { CaptureRecord, DisplayInfo, Rect } from '../shared/types.js';
import { clampRectToDisplay, fitScale } from '../shared/geometry.js';
import { captureLayers, nearlyUniform } from '../shared/windows.js';
import { composeLayers, intersect, maskBitmap, type Bitmap, type Layer, type PaintLayer } from '../shared/visible.js';
import { store } from './store.js';
import { compositeGrid } from './imageWorker.js';
import { hudWindowRef, listAllWindows, printWindow, windowStack } from './uia.js';
import { isShared, revocationCount } from './sharing.js';
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
 * agent included), so only composed or masked images are ever written here,
 * under names nobody can guess. A window's own render, before it is known to
 * be safe, goes to `privateDir` and is deleted as soon as it is read.
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

/** Where captures go; never the working directory, even before the app set it up. */
function outDir(): string {
    return captureDir || initCaptureDir();
}

function rawDir(): string {
    if (!privateDir) privateDir = join(outDir(), unguessable());
    // On every use: when the user stops sharing anything, the capture dir is
    // emptied, this dir included (index.ts purgeCaptures). Every render after
    // that would fail for want of it.
    mkdirSync(privateDir, { recursive: true, mode: 0o700 });
    return privateDir;
}

/** One window of the stack, front first, with what masking and composing need of it. */
interface OnScreen extends Layer {
    ref: string;
}

/**
 * The windows on screen, front first: which window is on top where, and
 * whether the agent may see it. Null when the stack cannot be read, which
 * blanks the whole capture rather than letting anything through.
 */
async function readScreen(): Promise<OnScreen[] | null> {
    try {
        const [stack, all] = await Promise.all([windowStack(), listAllWindows()]);
        // A shared window on another virtual desktop or minimised is not what
        // the screen shows where it would be: counting it as shown would keep
        // whatever really is there.
        const away = new Set(all.filter(w => w.cloaked || w.minimized).map(w => w.ref));
        const onScreen = stack.filter(w => !away.has(w.ref));
        const own = { pid: process.pid, panel: hudWindowRef() };
        const layers = captureLayers(onScreen, own, w => isShared(w, stack));
        return layers.map((layer, i) => ({ ...layer, ref: onScreen[i]!.ref }));
    } catch {
        return null;
    }
}

/** A bitmap the size of `image`, all the mask colour: nothing of `image` is read. */
function blankLike(image: NativeImage): Bitmap {
    const { width, height } = image.getSize();
    return { data: maskBitmap(new Uint8Array(width * height * 4), width, height, []), width, height };
}

function fromBitmap(b: Bitmap): NativeImage {
    return nativeImage.createFromBitmap(Buffer.from(b.data.buffer, b.data.byteOffset, b.data.byteLength), {
        width: b.width,
        height: b.height
    });
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
 * Stop before anything is written when the user stopped sharing something
 * since `since`: what was rendered may be the window they just took back, and
 * a file written now would outlive the clean-up that ran when they did.
 * The tool layer answers such a call in fixed words (guarded).
 */
function stillAllowed(since: number): void {
    if (revocationCount() !== since) throw new Error('the user stopped sharing a window while this ran');
}

/**
 * Ask a window to render itself into the private dir, and read the render
 * back, deleting the file at once. Helper errors can carry that file's path,
 * which names the private dir, so they come back without it.
 */
async function printToPrivate(ref: string): Promise<{ rect: Rect; fallback: boolean; image: NativeImage }> {
    const raw = join(rawDir(), `${unguessable()}.png`);
    try {
        const { rect, fallback } = await printWindow(ref, raw);
        return { rect, fallback, image: nativeImage.createFromPath(raw) };
    } catch (err) {
        const message = (err as Error).message ?? String(err);
        throw new Error(message.includes(privateDir) ? 'the window could not be rendered' : message);
    } finally {
        try {
            rmSync(raw, { force: true });
        } catch {
            // The temp dir is cleaned on exit anyway.
        }
    }
}

export interface WindowCapture {
    record: CaptureRecord;
    /** The raw window rect the image covers, virtual-screen physical, invisible resize border included. */
    rect: Rect;
    /**
     * The window's own render is one flat colour: how PrintWindow sees GPU and
     * DirectX surfaces. Not set when it would not render at all (`fallback`),
     * which is left blank on purpose.
     */
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
 * refused to render (`record.fallback`), so the image is left blank, or it
 * rendered blank. The screen is never copied in its place.
 */
export async function captureWindow(opts: {
    windowRef: string;
    maxDimension: number;
    maxPixels?: number;
    grid: boolean;
}): Promise<WindowCapture> {
    const revocations = revocationCount();
    const id = store.nextId('cap');
    let { rect, fallback, image } = await printToPrivate(opts.windowRef);
    if (image.isEmpty()) throw new Error('the window rendered an empty image');
    // Judged on the window's own render: what covers it never enters into it.
    const own = image.getSize();
    const blank = !fallback && nearlyUniform(image.toBitmap(), own.width, own.height);
    // A window that would not render itself is left blank rather than taken
    // from the screen. A screen copy holds whatever is in front of it, behind
    // it where it is see-through, and whatever passes over it meanwhile; even
    // blanked whenever something unshared was near, it said that something was.
    if (fallback) image = fromBitmap(blankLike(image));

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
    const path = join(outDir(), `${unguessable()}.png`);
    let png = image.toPNG();
    if (opts.grid) png = await compositeGrid(png, gridStep(finalSize));
    stillAllowed(revocations);
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
    /**
     * Only this shared window and the shared windows above it, as the screen
     * shows them stacked: a window "as rendered". Omit for every shared window.
     */
    upTo?: string;
    /** Longest edge of the written PNG. Caps token cost. */
    maxDimension: number;
    /** Area cap, so a model API never has to rescale the image. */
    maxPixels?: number;
    /** Burn a labelled coordinate grid into the image to help agents aim. */
    grid: boolean;
}

/**
 * How a shared window goes into a composed capture: its own render; or not
 * at all, blank, when it refused or rendered one flat colour (a GPU surface)
 * ('screen': it would have needed the screen, which is never read), or when
 * the render failed (it closed, or the render could not be written or read).
 */
type Rendered = { image: Bitmap; rect: Rect } | 'screen' | 'none';

async function renderLayer(ref: string): Promise<Rendered> {
    let shot: Awaited<ReturnType<typeof printToPrivate>>;
    try {
        shot = await printToPrivate(ref);
    } catch {
        return 'none';
    }
    const { rect, fallback, image } = shot;
    if (fallback) return 'screen';
    if (image.isEmpty()) return 'none';
    const { width, height } = image.getSize();
    const data = new Uint8Array(image.toBitmap());
    if (data.length !== width * height * 4) return 'none';
    if (nearlyUniform(data, width, height)) return 'screen';
    return { image: { data, width, height }, rect };
}

/**
 * Part of a display, composed from the shared windows on it: a blank canvas
 * with each shared window painted on from its own render, back to front, so
 * the order among shared windows is the screen's, and nothing of any other
 * window is read at all: not its pixels, its shadow or rounded corners, and
 * not even where it is, so nothing in the image traces it. The taskbar, the
 * desktop, our overlay and the chat panel are not shared and are not there.
 *
 * A shared window that will not render itself, or whose render failed, is
 * left blank: the screen is never read.
 *
 * `area` and `frame` are virtual-screen physical: the canvas and the whole
 * display; nothing outside the display is painted, whatever a window spans.
 * `fromScreen` is the windows that did not render themselves and were left
 * blank: decided by how they render, never by what is on top of them.
 */
async function compose(
    display: DisplayInfo,
    frame: Rect,
    area: Rect,
    upTo?: string
): Promise<{ bitmap: Bitmap; fromScreen: Set<string> }> {
    const size = { width: area.width, height: area.height };
    const fromScreen = new Set<string>();
    const before = await readScreen();
    if (!before) return { bitmap: { data: composeLayers(size, area, []), ...size }, fromScreen };
    let stack = before;
    if (upTo !== undefined) {
        const at = stack.findIndex(w => w.ref === upTo);
        if (at < 0) throw new Error(`window ${upTo} could not be resolved; it may have closed or been minimised`);
        stack = stack.slice(0, at + 1);
    }
    const shown = stack.filter(w => w.shared && intersect(w.rect, area)).reverse();

    // One at a time: the helper is single-threaded, and a burst of renders
    // would queue the anchor tracker behind them.
    const rendered: { ref: string; clip: Rect; render: Rendered }[] = [];
    for (const w of shown) {
        const clip = intersect(w.rect, frame);
        if (clip) rendered.push({ ref: w.ref, clip, render: await renderLayer(w.ref) });
    }

    // A window that will not render itself stays blank: the screen is never
    // read, so nothing of any other window can come with it (see captureWindow).
    const layers: PaintLayer[] = [];
    for (const { ref, clip, render } of rendered) {
        if (typeof render === 'object') layers.push({ image: render.image, rect: render.rect, clip: [clip] });
        else fromScreen.add(ref);
    }
    return { bitmap: { data: composeLayers(size, area, layers), ...size }, fromScreen };
}

/**
 * A capture of one display, or a region of it, composed from the shared
 * windows on it (see compose), before anything else happens to it: the crop,
 * the resize, the grid, OCR and the write all see only that.
 */
export async function captureDisplay(opts: CaptureOptions): Promise<CaptureRecord> {
    const { display } = opts;
    const revocations = revocationCount();
    const full = { x: 0, y: 0, width: display.physicalSize.width, height: display.physicalSize.height };
    const clamped = opts.region ? clampRectToDisplay(opts.region, display) : full;
    // Whole pixels, inside the display.
    const x = Math.min(full.width - 1, Math.max(0, Math.round(clamped.x)));
    const y = Math.min(full.height - 1, Math.max(0, Math.round(clamped.y)));
    const region = {
        x,
        y,
        width: Math.max(1, Math.min(full.width - x, Math.round(clamped.width))),
        height: Math.max(1, Math.min(full.height - y, Math.round(clamped.height)))
    };

    // Window rects are virtual-screen physical; the display's own pixels start
    // at its physical origin, which is negative left of or above the primary.
    const origin = screen.dipToScreenPoint({ x: display.dipBounds.x, y: display.dipBounds.y });
    const frame = { x: origin.x, y: origin.y, width: full.width, height: full.height };
    const area = { x: frame.x + region.x, y: frame.y + region.y, width: region.width, height: region.height };
    const { bitmap, fromScreen } = await compose(display, frame, area, opts.upTo);
    let image = fromBitmap(bitmap);

    const composed = image.getSize();
    const downscale = fitScale(composed, opts.maxDimension, opts.maxPixels);
    if (downscale < 1) {
        image = image.resize({
            width: Math.max(1, Math.round(composed.width * downscale)),
            height: Math.max(1, Math.round(composed.height * downscale)),
            quality: 'good'
        });
    }

    const finalSize = image.getSize();
    const id = store.nextId('cap');
    const path = join(outDir(), `${unguessable()}.png`);

    let png = image.toPNG();
    if (opts.grid) png = await compositeGrid(png, gridStep(finalSize));
    stillAllowed(revocations);
    writeFileSync(path, png);

    const record: CaptureRecord = {
        id,
        displayId: display.id,
        regionPhysical: region,
        imageSize: finalSize,
        // Image pixels per display-physical pixel.
        imageScale: finalSize.width / region.width,
        path,
        createdAt: Date.now(),
        // A window as rendered that did not render itself, said in fixed words.
        fallback: opts.upTo !== undefined && fromScreen.has(opts.upTo) ? true : undefined
    };
    store.recordCapture(record);

    // Screen reads should never be silent. Anything holding the MCP token can
    // capture the screen, so every capture leaves a visible trace in the panel.
    const where = opts.region
        ? `region ${region.width}x${region.height} at (${region.x}, ${region.y})`
        : 'the full screen';
    pushMessage('system', `Screen captured: ${where} on display ${display.id}.`);

    return record;
}

/** Grid spacing that yields roughly 8-14 lines per axis at any capture size. */
function gridStep(size: { width: number; height: number }): number {
    const longest = Math.max(size.width, size.height);
    if (longest <= 800) return 50;
    if (longest <= 1600) return 100;
    return 200;
}
