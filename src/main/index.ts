import { app, clipboard, globalShortcut, ipcMain, Menu, nativeImage, Tray, type MenuItemConstructorOptions } from 'electron';
import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupCaptureDir, initCaptureDir } from './capture.js';
import { initClicks } from './clicks.js';
import { answerStep, bindStepKeys, cancelStep, currentStep, keyLabel } from './steps.js';
import {
    allowHudClose,
    createHud,
    hasLocalVoice,
    hudWindow,
    onVoicesKnown,
    pushMessage,
    setHudContentProtection,
    setStatus,
    stopSpeaking,
    toggleHud
} from './hud.js';
import { startIdleWatch, stopIdleWatch } from './idle.js';
import { disposeImageWorker } from './imageWorker.js';
import {
    startMcpServer,
    displacedPort,
    mcpActiveRequests,
    mcpAuthedUrl,
    mcpUrl,
    type McpServerHandle
} from './mcp/server.js';
import {
    destroyOverlay,
    initOverlay,
    isContentProtected,
    pushState,
    setContentProtection
} from './overlay.js';
import { store } from './store.js';
import { startAnchorTracking, stopAnchorTracking } from './anchors.js';
import { stopUia } from './uia.js';
import { currentProviderLabel, initAgentHost, isBusy } from './agent/host.js';
import { applyOpenAtLogin, settings, startedHidden, updateSettings } from './settings.js';
import {
    appLabel,
    onSharingChanged,
    onSharingNotice,
    onSharingRevoked,
    setShareKeyInUse,
    sharingSummary,
    stopSharingApp,
    stopSharingEverything,
    stopSharingWindow,
    syncHelper,
    toggleFrontWindow,
    windowsWithSharing
} from './sharing.js';

const DEFAULT_PORT = Number(process.env.SCREEN_OVERLAY_PORT || 7777);

let tray: Tray | null = null;
let mcp: McpServerHandle | null = null;
let captureDir = '';
/** The share key as the user presses it, once it registered; '' when there is none. */
let shareKeyLabel = '';

// A second instance would fight the first for global shortcuts and bind the
// same port, so hand focus back to the running one instead.
if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    app.on('second-instance', () => hudWindow()?.show());
    void main();
}

async function main(): Promise<void> {
    // X11 composites transparent windows only with this switch. Windows and
    // macOS handle transparency natively and the switch is a no-op there.
    if (process.platform === 'linux') {
        app.commandLine.appendSwitch('enable-transparent-visuals');
    }

    await app.whenReady();

    const prefs = settings();
    setContentProtection(!prefs.showInCapture);
    applyOpenAtLogin(prefs.openAtLogin);

    captureDir = initCaptureDir();
    initOverlay();
    initClicks();
    initAgentHost();
    createHud(isContentProtected(), startedHidden());
    registerIpc();
    registerShortcuts();
    initSharing();

    try {
        mcp = await startMcpServer(DEFAULT_PORT);
        const moved = displacedPort();
        pushMessage(
            'system',
            `Overlay ready on ${mcp.url}. Access requires a token — use "Copy MCP URL" in the tray ` +
                'menu, or run scripts/connect.mjs, to get the full URL.' +
                (moved
                    ? ` NOTE: port ${moved} was already in use, so this moved to ${mcp.port}. ` +
                      'Any agent configured with the old port needs updating.'
                    : '')
        );
    } catch (err) {
        pushMessage('error', `Could not start the MCP server on port ${DEFAULT_PORT}: ${(err as Error).message}`);
    }
    pushMessage('system', sharingAtStartup());

    // Keeps anchored annotations glued to the windows and controls they point at.
    startAnchorTracking();

    // Fades what an agent that went quiet left on screen.
    startIdleWatch(mcpActiveRequests);

    buildTray();
    publishStatus();
    setInterval(publishStatus, 2000).unref?.();

    // This is a tray app; closing the panel should not exit.
    app.on('window-all-closed', () => {
        /* keep running */
    });
}

function publishStatus(): void {
    setStatus({
        mcpUrl: mcpUrl(),
        mcpConnected: mcpActiveRequests(),
        contentProtection: isContentProtected(),
        provider: currentProviderLabel(),
        busy: isBusy()
    });
}

function registerIpc(): void {
    // The panel's Clear button is the same panic button as Ctrl+Shift+X: a
    // click step left without its circle would take the next click anywhere.
    ipcMain.handle('app:clear-annotations', () => {
        cancelStep('clear');
        store.clear();
    });
    ipcMain.handle('app:copy-mcp-url', () => {
        // The authed form, otherwise pasting it anywhere yields 401.
        clipboard.writeText(mcpAuthedUrl());
        pushMessage('system', 'MCP URL copied to the clipboard.');
    });
    ipcMain.on('app:hide-hud', () => hudWindow()?.hide());
}

function registerShortcuts(): void {
    // Toggle the chat panel.
    globalShortcut.register('Control+Shift+O', () => toggleHud(true));
    // Panic button: wipe everything drawn on screen and end the pending step.
    globalShortcut.register('Control+Shift+X', () => {
        cancelStep('clear');
        store.clear();
    });

    // Done, Stuck and (in click mode) Escape, held only while a step is
    // pending; see bindStepKeys for why.
    bindStepKeys(globalShortcut, () => settings().stepKeys);
    // The tray lists the keys that answer the current step.
    store.on('step', refreshTrayMenu);
    registerShareKey();
}

/** Two accelerators for the same keys, however they are spelt ("Control+Shift+X", "shift+ctrl+x"). */
function sameChord(a: string, b: string): boolean {
    const norm = (c: string): string =>
        keyLabel(c)
            .toLowerCase()
            .split('+')
            .sort()
            .join('+');
    return norm(a) === norm(b);
}

/**
 * The share key shares the window in front, or stops sharing it. Held for
 * the whole session, unlike the step keys: sharing is something the user
 * does before an agent asks. Never one of our own chords, which it would
 * silently take over (a step key equal to it would then never register).
 */
function registerShareKey(): void {
    const prefs = settings();
    const accel = prefs.shareKey;
    if (!accel.trim()) return;
    const ours = ['Control+Shift+O', 'Control+Shift+X', 'Escape', prefs.stepKeys.done, prefs.stepKeys.stuck];
    if (ours.some(c => c && sameChord(c, accel))) {
        pushMessage(
            'error',
            `The share key ${keyLabel(accel)} is one of the overlay's own keys, so it is off. ` +
                'Set shareKey in settings.json to another chord.'
        );
        return;
    }
    let taken = false;
    try {
        taken = !globalShortcut.isRegistered(accel) && globalShortcut.register(accel, onShareKey);
    } catch {
        // Not a valid accelerator: the setting is hand-edited.
    }
    if (!taken) {
        pushMessage(
            'error',
            `Could not register the share key ${keyLabel(accel)}; another app may be using it, or it is not a valid key. ` +
                'An agent can still ask you to share a window. Set shareKey in settings.json to another chord.'
        );
        return;
    }
    shareKeyLabel = keyLabel(accel);
    setShareKeyInUse(shareKeyLabel);
}

let toggling = false;

function onShareKey(): void {
    // A held key repeats; one press is one toggle.
    if (toggling) return;
    toggling = true;
    toggleFrontWindow(shareKeyLabel)
        .then(
            text => pushMessage('system', text),
            err => pushMessage('error', `Could not share the window in front: ${(err as Error).message}`)
        )
        .finally(() => {
            toggling = false;
        });
}

function initSharing(): void {
    // User-only lines: what was shared or stopped, and what an agent asked
    // for that is not shared. The panel's log never reaches an agent.
    onSharingNotice(text => pushMessage('system', text));
    onSharingChanged(refreshTrayMenu);
    onSharingRevoked(purgeCaptures);
    // Whole-app shares are kept in settings; the helper enforces them too.
    syncHelper();
}

/** The first thing the panel says about sharing, so nobody wonders why the agent sees nothing. */
function sharingAtStartup(): string {
    const how = shareKeyLabel
        ? `To share a window, click into it and press ${shareKeyLabel}, or let the agent ask you.`
        : 'To share a window, let the agent ask you; it asks you to click into the window and confirm.';
    const { apps } = sharingSummary();
    const kept = apps.length
        ? ` Still shared from before: every ${apps.map(appLabel).join(', every ')} window; the tray menu stops that.`
        : '';
    return `Nothing on your screen is shared with the AI until you share it. ${how}${kept}`;
}

/**
 * Captures already on disk show what was shared when they were taken. Once
 * the user stops sharing something, an agent that kept a path must not be
 * able to read it back, so every capture goes: the next one is a call away.
 */
function purgeCaptures(): void {
    if (!captureDir) return;
    let names: string[];
    try {
        names = readdirSync(captureDir);
    } catch {
        return;
    }
    for (const name of names) {
        try {
            rmSync(join(captureDir, name), { force: true, recursive: true });
        } catch {
            // Locked by a reader right now; the exit cleanup removes it.
        }
    }
}

function buildTray(): void {
    // Generated by scripts/make-icon.mjs and copied into dist by the build.
    const icon = nativeImage.createFromPath(join(__dirname, '..', 'tray.png'));
    tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
    tray.on('click', () => toggleHud());
    // The menu lists what is shared; a shared window that closed since must
    // not linger in it. Hovering the icon comes before opening its menu, and
    // a change found rebuilds the menu through onSharingChanged.
    tray.on('mouse-move', sweepShares);
    tray.on('right-click', sweepShares);
    onVoicesKnown(refreshTrayMenu);
    refreshTrayMenu();
}

let lastSweep = 0;

function sweepShares(): void {
    const now = Date.now();
    if (now - lastSweep < 2000) return;
    lastSweep = now;
    windowsWithSharing().catch(() => undefined);
}

/** A window title as a menu label: Windows reads & as a mnemonic and a tab as the key column. */
function menuText(text: string): string {
    const flat = text.replace(/\s+/g, ' ').trim() || 'Untitled window';
    const short = flat.length > 60 ? `${flat.slice(0, 59)}…` : flat;
    return process.platform === 'win32' ? short.replace(/&/g, '&&') : short;
}

/** What is shared with the AI, each item a click away from not being. */
function sharingMenu(): MenuItemConstructorOptions {
    const { windows, apps } = sharingSummary();
    const items: MenuItemConstructorOptions[] = [
        ...windows.map(
            (g): MenuItemConstructorOptions => ({
                label: menuText(g.title),
                type: 'checkbox',
                checked: true,
                click: () => stopSharingWindow(g.ref, { byUser: true })
            })
        ),
        ...apps.map(
            (exe): MenuItemConstructorOptions => ({
                label: menuText(`All ${appLabel(exe)} windows`),
                type: 'checkbox',
                checked: true,
                click: () => stopSharingApp(exe, { byUser: true })
            })
        )
    ];
    const count = items.length;
    if (!count) items.push({ label: 'Nothing is shared', enabled: false });
    items.push(
        { type: 'separator' },
        { label: 'Stop sharing everything', enabled: count > 0, click: () => stopSharingEverything({ byUser: true }) },
        {
            label: shareKeyLabel
                ? `To share a window, click into it and press ${shareKeyLabel}`
                : 'To share a window, let the agent ask you',
            enabled: false
        }
    );
    return { label: count ? `Shared with the AI (${count})` : 'Shared with the AI: nothing', submenu: items };
}

/** A menu label with its key shown at the right, when there is one. */
function withKey(label: string, key: string | undefined): string {
    return key ? `${label}\t${key}` : label;
}

function refreshTrayMenu(): void {
    if (!tray) return;
    const prefs = settings();
    const step = currentStep();
    // A step lists only the keys that actually registered; between steps the
    // configured ones are shown, so the user can learn them in advance.
    const keys = step?.keys ?? { done: keyLabel(prefs.stepKeys.done), stuck: keyLabel(prefs.stepKeys.stuck) };
    // Done and stuck answer a watched step only; see bindStepKeys.
    const answerable = step?.mode === 'watch';
    const noVoice = hasLocalVoice() === false;
    tray.setToolTip(
        noVoice && prefs.readStepsAloud
            ? 'Screen MCP Overlay (no local voice installed, so steps are not read aloud)'
            : 'Screen MCP Overlay'
    );
    tray.setContextMenu(
        Menu.buildFromTemplate([
            { label: mcpUrl() || 'MCP server not running', enabled: false },
            { type: 'separator' },
            sharingMenu(),
            { type: 'separator' },
            { label: 'Show / hide panel\tCtrl+Shift+O', click: () => toggleHud() },
            {
                label: 'Clear and stop the current step\tCtrl+Shift+X',
                click: () => {
                    cancelStep('clear');
                    store.clear();
                }
            },
            {
                label: withKey('I did the current step', keys.done || undefined),
                enabled: answerable,
                click: () => {
                    if (step) answerStep({ kind: 'done' }, step.id);
                }
            },
            {
                label: withKey("I can't find it", keys.stuck || undefined),
                enabled: answerable,
                click: () => {
                    if (step) answerStep({ kind: 'stuck' }, step.id);
                }
            },
            {
                label: 'Copy MCP URL (includes access token)',
                click: () => {
                    clipboard.writeText(mcpAuthedUrl());
                }
            },
            { type: 'separator' },
            {
                label: 'Hide overlay from screen recording',
                type: 'checkbox',
                checked: isContentProtected(),
                click: menuItem => {
                    setContentProtection(menuItem.checked);
                    setHudContentProtection(menuItem.checked);
                    updateSettings({ showInCapture: !menuItem.checked });
                    refreshTrayMenu();
                    publishStatus();
                }
            },
            {
                label: noVoice ? 'Read steps aloud (no local voice installed)' : 'Read steps aloud',
                type: 'checkbox',
                checked: prefs.readStepsAloud,
                click: menuItem => {
                    updateSettings({ readStepsAloud: menuItem.checked });
                    if (!menuItem.checked) stopSpeaking();
                    refreshTrayMenu();
                }
            },
            {
                label: 'Sound cues',
                type: 'checkbox',
                checked: prefs.soundCues,
                click: menuItem => {
                    updateSettings({ soundCues: menuItem.checked });
                    // The overlay plays the cues and reads the preference from its state.
                    pushState();
                    refreshTrayMenu();
                }
            },
            {
                label: 'Start automatically at login',
                type: 'checkbox',
                checked: prefs.openAtLogin,
                click: menuItem => {
                    updateSettings({ openAtLogin: menuItem.checked });
                    applyOpenAtLogin(menuItem.checked);
                    refreshTrayMenu();
                }
            },
            { type: 'separator' },
            { label: 'Quit', click: () => app.quit() }
        ])
    );
}

// The panel ignores a close (Alt+F4) by hiding instead; quitting must still close it.
app.on('before-quit', allowHudClose);

app.on('will-quit', () => {
    globalShortcut.unregisterAll();
});

app.on('quit', () => {
    stopIdleWatch();
    stopAnchorTracking();
    stopUia();
    void mcp?.close();
    destroyOverlay();
    disposeImageWorker();
    cleanupCaptureDir();
});
