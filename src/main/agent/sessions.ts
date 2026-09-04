import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadSdk } from './sdk.js';

/**
 * Attaching the overlay's chat panel to a Claude Code session you already have
 * open in VS Code.
 *
 * There is no way to share a *live* conversation. The VS Code extension hosts an
 * MCP server for the CLI (openFile, getCurrentSelection, getDiagnostics and so
 * on) but exposes nothing that injects a prompt into its chat, and two processes
 * appending to one transcript JSONL would interleave and corrupt it.
 *
 * This module only discovers what is mirrorable: which folders are open in an
 * editor, and which sessions each one has. The following itself lives in
 * mirror.ts.
 */

export interface IdeWorkspace {
    /** Absolute path of the folder open in the editor. */
    dir: string;
    label: string;
    ideName: string;
    pid: number;
}

export interface SessionChoice {
    sessionId: string;
    summary: string;
    lastModified: number;
    dir: string;
}

const load = loadSdk;

function isAlive(pid: number): boolean {
    try {
        // Signal 0 tests for existence without touching the process.
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

/**
 * Folders currently open in an IDE that has Claude Code running.
 *
 * Each editor window drops a lock file in ~/.claude/ide naming its workspace
 * folders and pid. Stale files are left behind when an editor exits, so entries
 * whose process is gone are filtered out.
 */
export function listIdeWorkspaces(): IdeWorkspace[] {
    const dir = join(homedir(), '.claude', 'ide');
    let files: string[];
    try {
        files = readdirSync(dir).filter(f => f.endsWith('.lock'));
    } catch {
        return [];
    }

    const seen = new Map<string, IdeWorkspace>();
    for (const f of files) {
        try {
            const lock = JSON.parse(readFileSync(join(dir, f), 'utf8')) as {
                pid: number;
                workspaceFolders?: string[];
                ideName?: string;
            };
            if (!isAlive(lock.pid)) continue;
            for (const folder of lock.workspaceFolders ?? []) {
                if (seen.has(folder)) continue;
                seen.set(folder, {
                    dir: folder,
                    label: folder.split(/[\\/]/).filter(Boolean).pop() ?? folder,
                    ideName: lock.ideName ?? 'editor',
                    pid: lock.pid
                });
            }
        } catch {
            // A half-written or malformed lock file is not worth failing over.
        }
    }
    return [...seen.values()].sort((a, b) => a.label.localeCompare(b.label));
}

/** Recent Claude Code sessions for one project directory, newest first. */
export async function listSessionsForDir(dir: string, limit = 8): Promise<SessionChoice[]> {
    const { listSessions } = await load();
    const sessions = await listSessions({ dir, limit });
    return sessions
        .map(s => ({
            sessionId: s.sessionId,
            summary: s.customTitle || s.summary || '(no title)',
            lastModified: s.lastModified,
            dir
        }))
        .sort((a, b) => b.lastModified - a.lastModified);
}
