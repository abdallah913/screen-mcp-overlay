import { BrowserWindow, screen } from 'electron';
import { join } from 'node:path';
import type { DisplayInfo, OverlayState } from '../shared/types.js';
import { listDisplays } from './displays.js';
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
}

const windows = new Map<string, OverlayWindow>();
// On by default so the overlay never appears in its own screenshots. Set
// SCREEN_OVERLAY_SHOW_IN_CAPTURE=1 when you *want* annotations to show up in a
// screen recording or share, which is the point of drawing them for an audience.
let contentProtection = process.env.SCREEN_OVERLAY_SHOW_IN_CAPTURE !== '1';
let interactive = false;

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
            backgroundThrottling: false
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

    void win.loadFile(join(__dirname, '../renderer/overlay/index.html'));
    win.once('ready-to-show', () => {
        win.showInactive();
        pushTo(win, display);
    });

    return { display, win };
}

function currentState(display: DisplayInfo): OverlayState {
    const req = store.getClickRequest();
    return {
        // Anchored annotations whose target vanished are kept in the store but
        // must not be drawn; they come back if the window reappears.
        annotations: store.forDisplay(display.id).filter(a => !a.hidden),
        // Only the display under the cursor prompts for a click, but every
        // display needs the banner so the user sees the request wherever they
        // are looking.
        click: req
    };
}

function pushTo(win: BrowserWindow, display: DisplayInfo): void {
    if (win.isDestroyed()) return;
    win.webContents.send('overlay:state', currentState(display));
}

export function pushState(): void {
    for (const { win, display } of windows.values()) pushTo(win, display);
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
        pushTo(existing.win, d);
    }

    for (const [id, entry] of windows) {
        if (seen.has(id)) continue;
        if (!entry.win.isDestroyed()) entry.win.destroy();
        windows.delete(id);
    }
}

export function initOverlay(): void {
    syncDisplays();
    screen.on('display-added', syncDisplays);
    screen.on('display-removed', syncDisplays);
    screen.on('display-metrics-changed', syncDisplays);

    store.on('annotations', pushState);
    store.on('click-request', () => {
        setInteractive(store.getClickRequest() !== null);
        pushState();
    });
}

/**
 * Click-through is the default: the overlay must never intercept the user's
 * mouse. It becomes interactive only while a `wait_for_user_click` is pending.
 */
function setInteractive(on: boolean): void {
    if (interactive === on) return;
    interactive = on;
    for (const { win } of windows.values()) {
        if (win.isDestroyed()) continue;
        win.setIgnoreMouseEvents(!on, { forward: true });
        win.setFocusable(on);
        if (on) win.showInactive();
    }
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
    for (const { win } of windows.values()) if (!win.isDestroyed()) win.destroy();
    windows.clear();
}

