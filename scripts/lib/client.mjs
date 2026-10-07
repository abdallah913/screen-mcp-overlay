import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Shared connection for the dev scripts.
 *
 * The MCP endpoint requires a token, and the token lives in the app's settings
 * file. Every script needed the same lookup, so it lives here rather than being
 * copied five times and going stale four of them.
 */
export function overlayToken() {
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
            if (token) return token;
        } catch {
            // Not this one; keep looking.
        }
    }
    throw new Error(
        'No access token found. Start the overlay once so it mints one, then re-run this script.'
    );
}

export function overlayUrl() {
    const port = process.env.SCREEN_OVERLAY_PORT ?? 7777;
    return `http://127.0.0.1:${port}/mcp?key=${overlayToken()}`;
}

/** Connect an MCP client to the running overlay. */
export async function connectOverlay(name) {
    const client = new Client({ name, version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(overlayUrl())));
    return client;
}

/** Flatten a tool result to its text content. */
export const textOf = r => r.content.filter(c => c.type === 'text').map(c => c.text).join('\n');

/**
 * Windows from a list_windows response, one `ref WxH@x,y title` line each.
 * Parsed here once so a format change breaks one function, not every script.
 */
export function parseWindows(text) {
    return [...text.matchAll(/^(-?\d+) (\d+)x(\d+)@(-?\d+),(-?\d+) (.*?)( \[foreground\])?$/gm)].map(m => ({
        ref: m[1],
        w: +m[2],
        h: +m[3],
        x: +m[4],
        y: +m[5],
        title: m[6],
        foreground: Boolean(m[7])
    }));
}

/** The captureId a capture_screen or read_text response names. */
export const captureIdOf = text => /\b(cap_\d+)\b/.exec(text)?.[1];

/** The PNG path a capture_screen response names. */
export const pathOf = text => /^path: (.+)$/m.exec(text)?.[1]?.trim();

/** [width, height] of the image a capture response describes. */
export const captureSizeOf = text => /\bcap_\d+: (\d+)x(\d+)/.exec(text)?.slice(1, 3).map(Number);
