import { app } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

/**
 * A tiny preferences file in userData. Deliberately not electron-store: there
 * are a handful of flags and adding a dependency for them is not worth it.
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
    /** Read each step's instruction aloud when it appears. */
    readStepsAloud: boolean;
    /** Speech rate for steps read aloud, 0.5 to 2. */
    speechRate: number;
    /** A short sound when a step starts and when it is done. */
    soundCues: boolean;
    /**
     * Global accelerators (Electron syntax) for answering a pending step,
     * registered only while one is pending. Empty string disables one.
     */
    stepKeys: { done: string; stuck: string };
}

const DEFAULTS: Settings = {
    openAtLogin: false,
    startHidden: false,
    showInCapture: process.env.SCREEN_OVERLAY_SHOW_IN_CAPTURE === '1',
    token: '',
    readStepsAloud: false,
    speechRate: 1,
    soundCues: false,
    // Chords nothing common claims. Ctrl+Shift+H is VS Code's Replace in Files,
    // Ctrl+Shift+Enter is an array formula in Excel, and Ctrl+Alt chords are
    // AltGr on many European layouts, where they type characters.
    stepKeys: { done: 'Control+Shift+F9', stuck: 'Control+Shift+F10' }
};

let cache: Settings | undefined;

function file(): string {
    return join(app.getPath('userData'), 'settings.json');
}

export function settings(): Settings {
    if (cache) return cache;
    let loaded: Settings;
    try {
        loaded = normalizeSettings(JSON.parse(readFileSync(file(), 'utf8')));
    } catch {
        loaded = normalizeSettings(undefined);
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

/**
 * Settings as stored, checked field by field. The file is edited by hand, and
 * a value of the wrong type used to reach code that trusted it: a chord written
 * as null to switch it off (the documented way is an empty string) threw from
 * the tray and from step-key registration, which left steps that could never
 * be answered. A field that is missing or of the wrong type gets its default,
 * the rest of the file still counts, and a file that sets only one chord keeps
 * the default for the other.
 */
export function normalizeSettings(stored: unknown): Settings {
    const s = stored && typeof stored === 'object' ? (stored as Record<string, unknown>) : {};
    const keys = s.stepKeys && typeof s.stepKeys === 'object' ? (s.stepKeys as Record<string, unknown>) : {};
    const flag = (name: 'openAtLogin' | 'startHidden' | 'showInCapture' | 'readStepsAloud' | 'soundCues'): boolean =>
        typeof s[name] === 'boolean' ? (s[name] as boolean) : DEFAULTS[name];
    // null is what someone writes to switch a key off, so it counts as "".
    const chord = (name: 'done' | 'stuck'): string =>
        typeof keys[name] === 'string' ? (keys[name] as string) : keys[name] === null ? '' : DEFAULTS.stepKeys[name];
    const rate = typeof s.speechRate === 'number' && Number.isFinite(s.speechRate) ? s.speechRate : DEFAULTS.speechRate;
    return {
        openAtLogin: flag('openAtLogin'),
        startHidden: flag('startHidden'),
        showInCapture: flag('showInCapture'),
        token: typeof s.token === 'string' ? s.token : DEFAULTS.token,
        readStepsAloud: flag('readStepsAloud'),
        speechRate: Math.min(2, Math.max(0.5, rate)),
        soundCues: flag('soundCues'),
        stepKeys: { done: chord('done'), stuck: chord('stuck') }
    };
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
