import { BrowserWindow, ipcMain, screen, type WebContents } from 'electron';
import { join } from 'node:path';
import type { DisplayInfo, Point, Rect } from '../shared/types.js';
import {
    leadDisplay,
    localPart,
    overStrip,
    parseUserAnswer,
    routeTo,
    showsStrip,
    takesMouse,
    waitingNote,
    type OverlayFrame
} from '../shared/layout.js';
import { listDisplays } from './displays.js';
import { hudBounds, hudWindow } from './hud.js';
import { settings } from './settings.js';
import { answerStep } from './steps.js';
import { store } from './store.js';

/**
 * One transparent, always-on-top, click-through window per display. Windows are
 * sized in DIPs to exactly cover their display, so the renderer's canvas
 * coordinate space *is* display-local DIPs and no further mapping is needed
 * inside the renderer.
 */

interface OverlayWindow {
    display: DisplayInfo;
    win: BrowserWindow;
    /** The step strip's rect on this display (local DIPs) while it is shown. */
    strip: Rect | null;
    /**
     * The page is loaded and answering. A crashed, hung or failed page never
     * takes the mouse (see takesMouse) and is reloaded.
     */
    live: boolean;
    /** What setFocusable was last told, so hover changes don't restyle the window. */
    focusable: boolean;
    /** When the page was last (re)loaded, to slow down one that keeps dying. */
    loadedAt: number;
    reload: NodeJS.Timeout | null;
    /** Grace period for a hung page to recover before it is restarted. */
    hang: NodeJS.Timeout | null;
}

const PAGE = join(__dirname, '../renderer/overlay/index.html');
/** How long a hung page gets to answer again before its renderer is killed and reloaded. */
const HANG_GRACE_MS = 5000;
/** A page that dies this soon after loading is crashing in a loop: retry that slowly. */
const CRASH_LOOP_MS = 10_000;

const windows = new Map<string, OverlayWindow>();
// On by default so the overlay never appears in its own screenshots. Set
// SCREEN_OVERLAY_SHOW_IN_CAPTURE=1 when you *want* annotations to show up in a
// screen recording or share, which is the point of drawing them for an audience.
let contentProtection = process.env.SCREEN_OVERLAY_SHOW_IN_CAPTURE !== '1';
/** A click-mode step is pending: every overlay captures clicks. */
let picking = false;
/** The overlay whose step strip is under the pointer, which alone takes mouse input. */
let hovered: OverlayWindow | null = null;
let hoverFailsafe: NodeJS.Timeout | null = null;
/** The panel window whose moves we follow, to keep the spotlight scrim off it. */
let watchedHud: BrowserWindow | null = null;
let hudPush: NodeJS.Timeout | null = null;

export function setContentProtection(on: boolean): void {
    contentProtection = on;
    for (const { win } of windows.values()) {
        if (!win.isDestroyed()) win.setContentProtection(on);
    }
}

export function isContentProtected(): boolean {
    return contentProtection;
}

function createOverlayWindow(display: DisplayInfo): OverlayWindow {
    const win = new BrowserWindow({
        x: display.dipBounds.x,
        y: display.dipBounds.y,
        width: display.dipBounds.width,
        height: display.dipBounds.height,
        transparent: true,
        frame: false,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        closable: false,
        // Never steal focus from whatever the user is actually working in.
        focusable: false,
        skipTaskbar: true,
        hasShadow: false,
        enableLargerThanScreen: true,
        show: false,
        webPreferences: {
            preload: join(__dirname, '../preload/overlay.js'),
            contextIsolation: true,
            nodeIntegration: false,
            backgroundThrottling: false,
            // The step cues play as a step starts, which is never right after
            // a user gesture in this window.
            autoplayPolicy: 'no-user-gesture-required'
        }
    });

    // 'screen-saver' floats above ordinary always-on-top windows so the overlay
    // stays visible over things like Task Manager and most fullscreen apps.
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    win.setIgnoreMouseEvents(true, { forward: true });

    // WDA_EXCLUDEFROMCAPTURE on Win10 2004+: DWM draws the overlay on the
    // physical display but omits it from every capture pipeline, so our own
    // screenshots never contain our own annotations. No hide/capture/show race.
    win.setContentProtection(contentProtection);

    const entry: OverlayWindow = {
        display,
        win,
        strip: null,
        live: false,
        focusable: false,
        loadedAt: 0,
        reload: null,
        hang: null
    };
    watchPage(entry);
    load(entry);
    win.once('ready-to-show', () => {
        if (win.isDestroyed()) return;
        applyMouse(entry);
        win.showInactive();
    });

    return entry;
}

function load(entry: OverlayWindow): void {
    // A fresh page has no strip until it says so, and it only reports one
    // that differs from the last it sent, which for a new page is none.
    entry.strip = null;
    entry.loadedAt = Date.now();
    entry.win.loadFile(PAGE).catch(() => {
        // did-fail-load has already marked the page dead and scheduled a retry.
    });
}

/**
 * Keep a broken page from leaving a blank window on screen. A full-screen
 * overlay with no running page draws nothing; during a click step it would
 * also swallow every click on its monitor with no crosshair and no report. So
 * a crashed, hung or failed page goes click-through at once and is reloaded,
 * and takes the mouse again only once it is back.
 */
function watchPage(entry: OverlayWindow): void {
    const wc = entry.win.webContents;
    wc.on('did-finish-load', () => revive(entry));
    wc.on('responsive', () => revive(entry));
    wc.on('render-process-gone', () => {
        markDead(entry);
        scheduleReload(entry);
    });
    wc.on('did-fail-load', (_e, code, _description, _url, isMainFrame) => {
        // -3 is a load aborted by the next one (our own reload), not a failure.
        if (!isMainFrame || code === -3) return;
        markDead(entry);
        scheduleReload(entry);
    });
    wc.on('unresponsive', () => {
        markDead(entry);
        if (entry.hang) return;
        entry.hang = setTimeout(() => {
            entry.hang = null;
            // Still hung: killing the renderer emits render-process-gone, which reloads it.
            if (!entry.win.isDestroyed() && !entry.live) entry.win.webContents.forcefullyCrashRenderer();
        }, HANG_GRACE_MS);
    });
}

function revive(entry: OverlayWindow): void {
    if (entry.hang) clearTimeout(entry.hang);
    entry.hang = null;
    if (entry.win.isDestroyed()) return;
    entry.live = true;
    applyMouse(entry);
    pushTo(entry);
}

function markDead(entry: OverlayWindow): void {
    entry.live = false;
    if (hovered === entry) setHovered(null);
    applyMouse(entry);
}

function scheduleReload(entry: OverlayWindow): void {
    if (entry.reload || entry.win.isDestroyed()) return;
    const delay = Date.now() - entry.loadedAt < CRASH_LOOP_MS ? CRASH_LOOP_MS : 500;
    entry.reload = setTimeout(() => {
        entry.reload = null;
        if (!entry.win.isDestroyed()) load(entry);
    }, delay);
}

function dispose(entry: OverlayWindow): void {
    if (hovered === entry) setHovered(null);
    if (entry.reload) clearTimeout(entry.reload);
    if (entry.hang) clearTimeout(entry.hang);
    entry.reload = entry.hang = null;
    if (!entry.win.isDestroyed()) entry.win.destroy();
}

function currentState(entry: OverlayWindow): OverlayFrame {
    const display = entry.display;
    const displays = listDisplays();
    const origins = new Map<string, Point>(displays.map(d => [d.id, { x: d.dipBounds.x, y: d.dipBounds.y }]));
    const here = { x: display.dipBounds.x, y: display.dipBounds.y };
    const toLocal = (r: Rect): Rect => ({ ...r, x: r.x - here.x, y: r.y - here.y });
    const all = store.list();
    const step = store.getStep();
    const primary = displays.find(d => d.primary)?.id ?? display.id;
    const workArea = screen.getAllDisplays().find(d => String(d.id) === display.id)?.workArea ?? display.dipBounds;
    const hud = hudBounds();
    const hudHere = hud ? localPart(hud, display.dipBounds) : null;
    const lead = leadDisplay(step, all, primary, origins) === display.id;

    return {
        displayId: display.id,
        // Every display gets every drawing, in its own coordinates: a control
        // straddling two monitors is drawn on both, and a monitor with nothing
        // on it can still point at the step. Anchored annotations whose target
        // vanished stay in the store but are not drawn; they come back if the
        // window reappears, and meanwhile the strip says what it is waiting for.
        annotations: routeTo(all.filter(a => !a.hidden), origins, here),
        step,
        // The chat panel is where the user types: a spotlight's scrim must
        // never dim it, and captions and the strip keep off it.
        exclude: hudHere ? [hudHere] : [],
        cues: settings().soundCues,
        others: displays.filter(d => d.id !== display.id).map(d => toLocal(d.dipBounds)),
        workArea: toLocal(workArea),
        lead,
        showStrip: showsStrip(step, lead),
        waiting: waitingNote(step, all)
    };
}

function pushTo(entry: OverlayWindow): void {
    if (entry.win.isDestroyed()) return;
    entry.win.webContents.send('overlay:state', currentState(entry));
}

export function pushState(): void {
    watchHud();
    for (const entry of windows.values()) pushTo(entry);
}

/** Replay the attention ping on these annotations, e.g. for the panel's "Show me". */
export function pingTargets(ids: string[]): void {
    for (const { win } of windows.values()) {
        if (!win.isDestroyed()) win.webContents.send('overlay:ping', ids);
    }
}

/**
 * Follow the chat panel so the exclusion rect tracks it. Hooked lazily from
 * here rather than from hud.ts, which imports this module; the panel exists
 * long before anything is drawn, which is the first time it can matter.
 * Moves arrive continuously during a drag, so they are coalesced.
 */
function watchHud(): void {
    const hud = hudWindow();
    if (!hud || hud === watchedHud) return;
    watchedHud = hud;
    const later = (): void => {
        if (hudPush) return;
        hudPush = setTimeout(() => {
            hudPush = null;
            for (const entry of windows.values()) pushTo(entry);
        }, 60);
    };
    hud.on('move', later);
    hud.on('resize', later);
    hud.on('show', later);
    hud.on('hide', later);
}

/** Rebuild windows to match the current display topology. */
export function syncDisplays(): void {
    const displays = listDisplays();
    const seen = new Set<string>();

    for (const d of displays) {
        seen.add(d.id);
        const existing = windows.get(d.id);
        if (!existing || existing.win.isDestroyed()) {
            // Click-through until its page is up; then revive() applies a
            // click step that is already pending, crosshair and all.
            windows.set(d.id, createOverlayWindow(d));
            continue;
        }
        // Geometry can change under us (resolution, scaling, monitor arrangement).
        existing.display = d;
        existing.win.setBounds(d.dipBounds);
    }

    for (const [id, entry] of windows) {
        if (seen.has(id)) continue;
        dispose(entry);
        windows.delete(id);
    }
    // Every display's view of the others changed, not just the resized one.
    pushState();
}

function entryFor(sender: WebContents): OverlayWindow | undefined {
    for (const entry of windows.values()) {
        if (!entry.win.isDestroyed() && entry.win.webContents === sender) return entry;
    }
    return undefined;
}

export function initOverlay(): void {
    syncDisplays();
    screen.on('display-added', syncDisplays);
    screen.on('display-removed', syncDisplays);
    screen.on('display-metrics-changed', syncDisplays);

    store.on('annotations', pushState);
    store.on('step', () => {
        const step = store.getStep();
        setPicking(step?.mode === 'click');
        if (!step) setHovered(null);
        pushState();
    });

    ipcMain.on('overlay:step-answer', (_e, payload: { id?: unknown; answer?: unknown }) => {
        const answer = parseUserAnswer(payload?.answer);
        if (answer && typeof payload.id === 'string') answerStep(answer, payload.id);
    });
    ipcMain.on('overlay:hover-ui', (e, over: boolean) => {
        const entry = entryFor(e.sender);
        if (!entry) return;
        if (over) setHovered(entry);
        else if (hovered === entry) setHovered(null);
    });
    ipcMain.on('overlay:strip', (e, rect: Rect | null) => {
        const entry = entryFor(e.sender);
        if (!entry) return;
        entry.strip = rect;
        // A strip that appears or re-docks under a pointer at rest gets no
        // mousemove, so the renderer never reports the hover: the next step's
        // strip often docks exactly where the last one's Done was pressed.
        // Without this the click meant for it would fall through to the app.
        // Only the strip's own rect counts, as in the renderer: a pointer in
        // the failsafe's slack is beside the strip, and its clicks are the
        // app's. One the strip moved away from goes click-through at once.
        if (rect && cursorOver(entry, 0)) setHovered(entry);
        else if (hovered === entry) setHovered(null);
    });
}

function applyMouse(entry: OverlayWindow): void {
    if (entry.win.isDestroyed()) return;
    const take = takesMouse({ live: entry.live, picking, hovered: hovered === entry });
    entry.win.setIgnoreMouseEvents(!take, { forward: true });
    const focusable = picking && entry.live;
    if (focusable !== entry.focusable) {
        entry.focusable = focusable;
        entry.win.setFocusable(focusable);
    }
}

function setPicking(on: boolean): void {
    if (picking === on) return;
    picking = on;
    for (const entry of windows.values()) {
        if (entry.win.isDestroyed()) continue;
        applyMouse(entry);
        if (on) entry.win.showInactive();
    }
}

/**
 * Make one overlay take the mouse while the pointer is over its strip. It is
 * never made focusable for this: the app the user is operating keeps keyboard
 * focus, and the strip's buttons work without activation.
 *
 * A missed mouseleave (the pointer jumping to another monitor, a renderer that
 * stalls) would leave a full-screen window eating clicks, so a 250 ms poll of
 * the real cursor restores click-through as soon as it is off the strip. The
 * poll stops whenever nothing is hovered, however that came about.
 */
function setHovered(entry: OverlayWindow | null): void {
    if (hovered !== entry) {
        const previous = hovered;
        hovered = entry;
        if (previous) applyMouse(previous);
        if (entry) applyMouse(entry);
    }

    if (entry && !hoverFailsafe) {
        hoverFailsafe = setInterval(() => {
            const h = hovered;
            if (!h || h.win.isDestroyed() || !cursorOver(h)) setHovered(null);
        }, 250);
        hoverFailsafe.unref?.();
    } else if (!entry && hoverFailsafe) {
        clearInterval(hoverFailsafe);
        hoverFailsafe = null;
    }
}

function cursorOver(entry: OverlayWindow, slack?: number): boolean {
    const b = entry.display.dipBounds;
    return overStrip(screen.getCursorScreenPoint(), { x: b.x, y: b.y }, entry.strip, slack);
}

/**
 * Push the overlay windows back to the top of the z-order.
 *
 * Windows collapses every Electron alwaysOnTop level into a single topmost
 * band, so relative order there is decided by activation -- the moment the user
 * clicks the chat panel it rises above the overlay and occludes any annotation
 * behind it. Re-raising keeps drawings on top; the overlay stays click-through,
 * so the panel underneath is still fully usable.
 */
export function raiseOverlays(): void {
    for (const { win } of windows.values()) {
        if (!win.isDestroyed() && win.isVisible()) win.moveTop();
    }
}

export function destroyOverlay(): void {
    for (const entry of windows.values()) dispose(entry);
    windows.clear();
    setHovered(null);
}
