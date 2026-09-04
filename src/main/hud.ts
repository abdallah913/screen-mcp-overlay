import { BrowserWindow, screen } from 'electron';
import { join } from 'node:path';
import type { AppStatus, HudMessage, HudRole } from '../shared/types.js';
import { raiseOverlays } from './overlay.js';

/**
 * The chat panel. Unlike the overlay windows this one is focusable and
 * interactive -- it is where the user types. It is a separate window so the
 * overlay can stay strictly click-through at all times.
 */

let hud: BrowserWindow | null = null;
let queued: HudMessage[] = [];
let seq = 0;

function nextId(): string {
    seq += 1;
    return `msg_${seq}`;
}

export function createHud(contentProtection: boolean): BrowserWindow {
    const primary = screen.getPrimaryDisplay();
    const width = 420;
    const height = 580;
    const margin = 24;

    hud = new BrowserWindow({
        width,
        height,
        x: primary.workArea.x + primary.workArea.width - width - margin,
        y: primary.workArea.y + primary.workArea.height - height - margin,
        minWidth: 320,
        minHeight: 260,
        frame: false,
        transparent: true,
        backgroundColor: '#00000000',
        resizable: true,
        skipTaskbar: true,
        hasShadow: true,
        show: false,
        webPreferences: {
            preload: join(__dirname, '../preload/hud.js'),
            contextIsolation: true,
            nodeIntegration: false
        }
    });

    hud.setAlwaysOnTop(true, 'floating');
    hud.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    hud.setContentProtection(contentProtection);

    void hud.loadFile(join(__dirname, '../renderer/hud/index.html'));
    hud.once('ready-to-show', () => {
        hud?.show();
        // Anything the MCP server posted before the window existed.
        for (const m of queued) hud?.webContents.send('hud:message', m);
        queued = [];
    });
    hud.on('closed', () => {
        hud = null;
    });
    // Focusing or showing the panel raises it within the topmost band; put the
    // annotations back above it so nothing the agent drew gets hidden.
    hud.on('focus', raiseOverlays);
    hud.on('show', raiseOverlays);

    return hud;
}

export function hudWindow(): BrowserWindow | null {
    return hud && !hud.isDestroyed() ? hud : null;
}

export function toggleHud(): void {
    const win = hudWindow();
    if (!win) return;
    if (win.isVisible()) win.hide();
    else win.show();
}

export function setHudContentProtection(on: boolean): void {
    hudWindow()?.setContentProtection(on);
}

function send(channel: string, payload: unknown): void {
    const win = hudWindow();
    if (win) win.webContents.send(channel, payload);
}

/** Push a complete message into the transcript. */
export function pushMessage(role: HudRole, textBody: string): HudMessage {
    const msg: HudMessage = { id: nextId(), role, text: textBody, at: Date.now() };
    const win = hudWindow();
    if (win) win.webContents.send('hud:message', msg);
    else queued.push(msg);
    return msg;
}

/** Create or extend a streaming assistant message. */
export function streamMessage(id: string, delta: string, done = false): void {
    send('hud:stream', { id, delta, done });
}

export function setStatus(status: AppStatus): void {
    send('hud:status', status);
}

export function setBusy(busy: boolean): void {
    send('hud:busy', busy);
}

/** Wipe the transcript, e.g. before replaying a mirrored session's history. */
export function clearLog(): void {
    send('hud:clear', null);
}

/** Tell the panel it is following an editor session (or no longer is). */
export function setMirror(label: string | null): void {
    send('hud:mirror', label);
}

/**
 * Speak through the panel's renderer.
 *
 * Chromium ships speechSynthesis and it uses the installed Windows voices, so
 * this needs no extra dependency and no network. Returns false when the panel is
 * not around to speak through, rather than pretending it worked.
 */
export function speak(text: string, rate: number): boolean {
    const win = hudWindow();
    if (!win) return false;
    win.webContents.send('hud:speak', { text, rate });
    return true;
}

/** Called by the show_message MCP tool so an external agent can talk to the user. */
export function postToHud(textBody: string, level: 'info' | 'warn' | 'error'): void {
    pushMessage(level === 'error' ? 'error' : level === 'warn' ? 'system' : 'tool', textBody);
    const win = hudWindow();
    if (win && !win.isVisible()) win.showInactive();
}
