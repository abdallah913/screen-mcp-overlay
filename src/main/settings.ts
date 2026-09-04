import { app } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

/**
 * A tiny preferences file in userData. Deliberately not electron-store: there
 * are three booleans and adding a dependency for them is not worth it.
 */

export interface Settings {
    /** Launch the overlay when the user signs in. */
    openAtLogin: boolean;
    /** Start with the chat panel hidden (tray only). */
    startHidden: boolean;
    /** false hides the overlay from screen recording and from its own captures. */
    showInCapture: boolean;
    /**
     * Shared secret every MCP request must present. Generated once and persisted
     * so the URLs written into agent configs keep working across restarts.
     */
    token: string;
}

const DEFAULTS: Settings = {
    openAtLogin: false,
    startHidden: false,
    showInCapture: process.env.SCREEN_OVERLAY_SHOW_IN_CAPTURE === '1',
    token: ''
};

let cache: Settings | undefined;

function file(): string {
    return join(app.getPath('userData'), 'settings.json');
}

export function settings(): Settings {
    if (cache) return cache;
    let loaded: Settings;
    try {
        loaded = { ...DEFAULTS, ...JSON.parse(readFileSync(file(), 'utf8')) };
    } catch {
        loaded = { ...DEFAULTS };
    }
    // An env var always wins over the stored preference for this run.
    if (process.env.SCREEN_OVERLAY_SHOW_IN_CAPTURE === '1') loaded.showInCapture = true;

    // Mint the auth token on first run. Without it the MCP endpoint would be
    // open to anything that can reach loopback -- including a web page in the
    // user's browser, which is why the server also refuses cross-origin requests.
    if (!loaded.token) {
        loaded.token = randomBytes(24).toString('base64url');
        cache = loaded;
        updateSettings({ token: loaded.token });
        return loaded;
    }
    cache = loaded;
    return loaded;
}

export function updateSettings(patch: Partial<Settings>): Settings {
    const next = { ...settings(), ...patch };
    cache = next;
    try {
        writeFileSync(file(), `${JSON.stringify(next, null, 2)}\n`);
    } catch {
        // A read-only profile should not stop the app from running.
    }
    return next;
}

/**
 * Register or clear the login item.
 *
 * `--hidden` keeps a login launch out of the user's face: the tray icon appears
 * and the MCP server starts, but the chat panel stays closed until asked for.
 */
export function applyOpenAtLogin(enabled: boolean): void {
    app.setLoginItemSettings({
        openAtLogin: enabled,
        path: process.execPath,
        args: enabled ? ['--hidden'] : []
    });
}

/** True when this launch should keep the panel closed. */
export function startedHidden(): boolean {
    return process.argv.includes('--hidden') || settings().startHidden;
}
