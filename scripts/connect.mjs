#!/usr/bin/env node
/**
 * Registers the running overlay with local MCP clients.
 *
 * The endpoint requires an access token. Without one it would be reachable by
 * anything that can talk to loopback -- including a web page in the user's
 * browser -- on a service that reads the screen. The token is minted on first
 * run and stored in the app's settings file; this script reads it from there and
 * writes the full URL into each client's config.
 *
 * Usage:
 *   node scripts/connect.mjs [targetDir] [--port 7777] [--name screen-overlay]
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);

const flags = new Map();
const positional = [];
for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a.startsWith('--')) {
        flags.set(a.slice(2), args[i + 1]);
        i += 1;
    } else {
        positional.push(a);
    }
}

const port = Number(flags.get('port') ?? process.env.SCREEN_OVERLAY_PORT ?? 7777);
const name = flags.get('name') ?? 'screen-overlay';
const targetDir = resolve(positional[0] ?? '.');
const endpoint = `http://127.0.0.1:${port}/mcp`;

/**
 * Electron derives userData from the productName when packaged and from the
 * package name in development, so both locations are worth checking.
 */
function readToken() {
    const roaming = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming');
    const candidates = [
        join(roaming, 'Screen MCP Overlay', 'settings.json'),
        join(roaming, 'screen-mcp-overlay', 'settings.json'),
        join(homedir(), '.config', 'Screen MCP Overlay', 'settings.json'),
        join(homedir(), '.config', 'screen-mcp-overlay', 'settings.json')
    ];
    for (const path of candidates) {
        try {
            const token = JSON.parse(readFileSync(path, 'utf8')).token;
            if (token) return { token, path };
        } catch {
            // Missing or unreadable; try the next location.
        }
    }
    return { token: null, path: null };
}

const { token, path: tokenPath } = readToken();
const url = token ? `${endpoint}?key=${token}` : endpoint;

async function probe() {
    try {
        const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
        return res.ok ? await res.json() : null;
    } catch {
        return null;
    }
}

function mergeJson(path, key, entry) {
    let doc = {};
    if (existsSync(path)) {
        try {
            doc = JSON.parse(readFileSync(path, 'utf8'));
        } catch (err) {
            return { path, ok: false, note: `existing file is not valid JSON (${err.message}); left untouched` };
        }
    }
    const existing = doc[key]?.[name];
    doc[key] = { ...doc[key], [name]: entry };
    mkdirSync(resolve(path, '..'), { recursive: true });
    writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`);
    return { path, ok: true, note: existing ? 'updated existing entry' : 'added' };
}

const health = await probe();
console.log(
    health
        ? `Overlay is running on ${endpoint}`
        : `Warning: nothing is answering on port ${port}. Start the overlay, then re-run this.`
);

if (!token) {
    console.error(`
Could not find the access token. The overlay mints it on first run and stores it
in its settings file; start the app once, then re-run this script. You can also
copy the full URL from the tray menu: "Copy MCP URL (includes access token)".
`);
    process.exit(1);
}
console.log(`Token read from ${tokenPath}`);
console.log();

const results = [
    mergeJson(join(targetDir, '.mcp.json'), 'mcpServers', { type: 'http', url }),
    mergeJson(join(targetDir, '.vscode', 'mcp.json'), 'servers', { type: 'http', url })
];

console.log(`Wrote config into ${targetDir}:`);
for (const r of results) {
    console.log(`  ${r.ok ? 'ok  ' : 'skip'} ${r.path}  (${r.note})`);
}

console.log(`
Make it available everywhere, not just this folder:

  Claude Code CLI (all projects)
    claude mcp add --transport http ${name} "${url}" --scope user

  Claude Code VS Code extension
    Run the same command in VS Code's integrated terminal, then reload the window
    (Ctrl+Shift+P -> Developer: Reload Window) and check /mcp.

  Cursor
    ~/.cursor/mcp.json:
      { "mcpServers": { "${name}": { "type": "http", "url": "${url}" } } }

  Codex CLI
    ~/.codex/config.toml:
      [mcp_servers.${name}]
      url = "${url}"

The token in that URL is a credential: it grants read access to your screen.
Treat those config files accordingly and do not commit .mcp.json to a public repo.
`);
