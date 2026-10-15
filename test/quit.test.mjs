import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

/*
 * Quit from the tray must end the app. Electron's quit emits before-quit,
 * then closes every window, and gives up (the app keeps running, in the tray)
 * at a window that cannot be closed or whose close is prevented; only when
 * all have closed does it go on to will-quit and quit. The stub below plays
 * that out against the real index.ts, with the real overlay windows (made
 * `closable: false`) and the real chat panel (which hides on a close).
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const base = join(root, 'test/support/electron-stub.cjs');

await build({
    stdin: {
        contents: `
            import './src/main/index.ts';
            export { initOverlay } from './src/main/overlay.ts';
            export { createHud } from './src/main/hud.ts';
            export * as electron from 'electron';
        `,
        resolveDir: root,
        loader: 'ts'
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    outfile: join(root, 'dist-test/quit.cjs'),
    external: ['@anthropic-ai/claude-agent-sdk'],
    plugins: [
        {
            name: 'quitting-electron',
            setup(b) {
                b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'quitting-electron' }));
                b.onLoad({ filter: /.*/, namespace: 'quitting-electron' }, () => ({
                    loader: 'js',
                    resolveDir: root,
                    contents: `
                        const { EventEmitter } = require('node:events');
                        const base = require(${JSON.stringify(base)});
                        const display = { ...base.screen.getPrimaryDisplay(), workArea: { x: 0, y: 0, width: 1920, height: 1040 } };
                        const screenEvents = new EventEmitter();
                        const windows = [];
                        const noop = () => undefined;
                        /** Anything a window is asked to do that is not under test does nothing. */
                        const quiet = target => new Proxy(target, { get: (t, k) => (k in t || k === 'then' ? t[k] : noop) });
                        class BrowserWindow extends EventEmitter {
                            constructor(options = {}) {
                                super();
                                this.closable = options.closable !== false;
                                this.destroyed = false;
                                this.webContents = quiet(Object.assign(new EventEmitter(), { send: noop }));
                                windows.push(this);
                                return quiet(this);
                            }
                            static getAllWindows() { return windows.filter(w => !w.destroyed); }
                            isDestroyed() { return this.destroyed; }
                            isVisible() { return false; }
                            getBounds() { return { x: 1476, y: 436, width: 420, height: 580 }; }
                            getNativeWindowHandle() { return Buffer.alloc(8); }
                            loadFile() { return Promise.resolve(); }
                            loadURL() { return Promise.resolve(); }
                            destroy() { if (!this.destroyed) { this.destroyed = true; this.emit('closed'); } }
                        }
                        const app = new EventEmitter();
                        const event = () => ({ defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } });
                        Object.assign(app, {
                            quitOutcome: null,
                            // Electron's order, and its two ways of giving up.
                            quit() {
                                const before = event();
                                app.emit('before-quit', before);
                                if (before.defaultPrevented) return (app.quitOutcome = 'before-quit was prevented');
                                for (const w of windows) {
                                    if (w.destroyed) continue;
                                    if (!w.closable) return (app.quitOutcome = 'a window cannot be closed');
                                    const close = event();
                                    w.emit('close', close);
                                    if (close.defaultPrevented) return (app.quitOutcome = 'a window refused to close');
                                    w.destroy();
                                }
                                const will = event();
                                app.emit('will-quit', will);
                                if (will.defaultPrevented) return (app.quitOutcome = 'will-quit was prevented');
                                app.emit('quit');
                                app.quitOutcome = 'quit';
                            },
                            // Lose the lock, so loading index.ts registers its handlers but does not start the app.
                            requestSingleInstanceLock: () => false,
                            whenReady: () => new Promise(noop),
                            commandLine: { appendSwitch: noop },
                            getPath: base.app.getPath,
                            getAppPath: base.app.getAppPath,
                            setLoginItemSettings: noop,
                            getLoginItemSettings: () => ({ openAtLogin: false })
                        });
                        module.exports = {
                            ...base,
                            app,
                            BrowserWindow,
                            screen: { ...base.screen, getPrimaryDisplay: () => display, getDisplayMatching: () => display, on: (name, fn) => screenEvents.on(name, fn) },
                            globalShortcut: { register: () => true, unregister: noop, unregisterAll: noop, isRegistered: () => false },
                            Menu: { buildFromTemplate: () => ({}) },
                            Tray: class { constructor() { this.destroyed = false; } on() {} setToolTip() {} setContextMenu() {} destroy() { this.destroyed = true; } },
                            dialog: { showMessageBox: async () => ({ response: 0 }) },
                            __windows: windows,
                            __screenEvents: screenEvents
                        };
                    `
                }));
            }
        }
    ],
    logLevel: 'error'
});

const q = createRequire(import.meta.url)('../dist-test/quit.cjs');

test('Quit ends the app with the overlay and the chat panel open, and nothing comes back while it goes', () => {
    const { app, __windows: windows, __screenEvents: screenEvents } = q.electron;
    // Loading index.ts without the single-instance lock quit at once, before any window.
    assert.equal(app.quitOutcome, 'quit');
    app.quitOutcome = null;

    q.initOverlay();
    q.createHud(false, true);
    const overlays = windows.filter(w => !w.closable);
    assert.ok(overlays.length >= 1, 'the overlay windows cannot be closed, as in the app');
    assert.ok(windows.some(w => w.closable && w.listenerCount('close') > 0), 'the panel hides on a close, as in the app');

    app.quit();
    assert.equal(app.quitOutcome, 'quit');
    assert.deepEqual(windows.filter(w => !w.destroyed), [], 'every window is gone');

    // A monitor plugged in, or a scaling change, while quitting makes no new window.
    const before = windows.length;
    screenEvents.emit('display-added');
    screenEvents.emit('display-metrics-changed');
    assert.equal(windows.length, before);
});
