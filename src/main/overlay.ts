import { BrowserWindow, ipcMain, screen, type WebContents } from 'electron';
import { join } from 'node:path';
import type { DisplayInfo, Point, Rect } from '../shared/types.js';
import { leadDisplay, localPart, parseUserAnswer, routeTo, type OverlayFrame } from '../shared/layout.js';
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
}

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

    const entry: OverlayWindow = { display, win, strip: null };
    void win.loadFile(join(__dirname, '../renderer/overlay/index.html'));
    win.once('ready-to-show', () => {
        win.showInactive();
        pushTo(entry);
    });

    return entry;
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

    return {
        displayId: display.id,
        // Every display gets every drawing, in its own coordinates: a control
        // straddling two monitors is drawn on both, and a monitor with nothing
        // on it can still point at the step. Anchored annotations whose target
        // vanished stay in the store but are not drawn; they come back if the
        // window reappears.
        annotations: routeTo(all.filter(a => !a.hidden), origins, here),
        step,
        // The chat panel is where the user types: a spotlight's scrim must
        // never dim it, and captions and the strip keep off it.
        exclude: hudHere ? [hudHere] : [],
        cues: settings().soundCues,
        others: displays.filter(d => d.id !== display.id).map(d => toLocal(d.dipBounds)),
        workArea: toLocal(workArea),
        lead: leadDisplay(step, all, primary) === display.id
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
            windows.set(d.id, createOverlayWindow(d));
            continue;
        }
        // Geometry can change under us (resolution, scaling, monitor arrangement).
        existing.display = d;
        existing.win.setBounds(d.dipBounds);
    }

    for (const [id, entry] of windows) {
        if (seen.has(id)) continue;
        if (hovered === entry) hovered = null;
        if (!entry.win.isDestroyed()) entry.win.destroy();
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
        if (!rect && hovered === entry) setHovered(null);
    });
}

/**
 * Click-through is the default: the overlay must never intercept the user's
 * mouse. Two exceptions: every overlay while a click-mode step is pending, and
 * the one overlay whose step strip is under the pointer, so its buttons can be
 * pressed.
 */
function applyMouse(entry: OverlayWindow): void {
    if (entry.win.isDestroyed()) return;
    entry.win.setIgnoreMouseEvents(!(picking || hovered === entry), { forward: true });
}

function setPicking(on: boolean): void {
    if (picking === on) return;
    picking = on;
    for (const entry of windows.values()) {
        applyMouse(entry);
        if (entry.win.isDestroyed()) continue;
        entry.win.setFocusable(on);
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
 * the real cursor restores click-through as soon as it is off the strip.
 */
function setHovered(entry: OverlayWindow | null): void {
    if (hovered === entry) return;
    const previous = hovered;
    hovered = entry;
    if (previous) applyMouse(previous);
    if (entry) applyMouse(entry);

    if (entry && !hoverFailsafe) {
        hoverFailsafe = setInterval(() => {
            const h = hovered;
            if (!h || h.win.isDestroyed() || !h.strip || !cursorOver(h)) setHovered(null);
        }, 250);
        hoverFailsafe.unref?.();
    } else if (!entry && hoverFailsafe) {
        clearInterval(hoverFailsafe);
        hoverFailsafe = null;
    }
}

function cursorOver(entry: OverlayWindow): boolean {
    const p = screen.getCursorScreenPoint();
    const b = entry.display.dipBounds;
    const s = entry.strip!;
    const slack = 6;
    return (
        p.x >= b.x + s.x - slack &&
        p.x <= b.x + s.x + s.width + slack &&
        p.y >= b.y + s.y - slack &&
        p.y <= b.y + s.y + s.height + slack
    );
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
    if (hoverFailsafe) clearInterval(hoverFailsafe);
    hoverFailsafe = null;
    hovered = null;
    for (const { win } of windows.values()) if (!win.isDestroyed()) win.destroy();
    windows.clear();
}
