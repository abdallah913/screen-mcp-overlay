#!/usr/bin/env node
/**
 * Launches the overlay.
 *
 * This exists to strip ELECTRON_RUN_AS_NODE from the environment. VS Code (and
 * anything else hosted in Electron, including a terminal opened inside it) sets
 * that variable for its own child processes. If it leaks through, Electron
 * boots as plain Node, `require('electron')` returns a path string instead of
 * the API, and the app dies on `app.requestSingleInstanceLock is not a
 * function`. Launching through this script makes `npm start` work from any
 * terminal.
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

// The electron package's main export is the path to its binary.
const electronBinary = require('electron');

const child = spawn(electronBinary, [root, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env,
    windowsHide: false
});

child.on('close', code => process.exit(code ?? 0));
child.on('error', err => {
    console.error(`Could not launch Electron: ${err.message}`);
    process.exit(1);
});
