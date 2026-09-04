import { readdirSync, statSync, unwatchFile, watchFile, createReadStream } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { HudRole } from '../../shared/types.js';

/**
 * Live-mirrors a Claude Code session from an editor into the overlay panel.
 *
 * Read-only by design. There is no supported way to push a message *into* a
 * running session: the VS Code extension exposes no send-prompt command, the
 * IDE socket carries only editor tools, and the peer-messaging pipe's protocol
 * lives in the compiled CLI. Resuming the same id would not help either -- the
 * extension holds its conversation in memory and never re-reads the transcript,
 * and two writers on one JSONL risks corrupting it.
 *
 * So the panel follows along instead: read the history, then tail the file for
 * appends. You type in your editor; everything shows up here, and the agent can
 * still draw on screen because that session has the overlay's MCP tools.
 */

export interface MirroredMessage {
    role: HudRole;
    text: string;
}

export interface MirrorTarget {
    sessionId: string;
    dir: string;
    label: string;
}

type Listener = (messages: MirroredMessage[]) => void;

let active: MirrorTarget | undefined;
let watchedPath: string | undefined;
let offset = 0;
let carry = '';

/**
 * Locate a session's transcript. Scanning beats deriving the project slug from
 * the path: the slug encoding is an implementation detail, the ids are unique.
 */
export function findTranscript(sessionId: string): string | undefined {
    const projects = join(homedir(), '.claude', 'projects');
    let slugs: string[];
    try {
        slugs = readdirSync(projects);
    } catch {
        return undefined;
    }
    for (const slug of slugs) {
        const candidate = join(projects, slug, `${sessionId}.jsonl`);
        try {
            statSync(candidate);
            return candidate;
        } catch {
            // Not in this project; keep looking.
        }
    }
    return undefined;
}

/** Flatten one transcript entry into the lines the panel should show. */
export function renderEntry(entry: unknown): MirroredMessage[] {
    const e = entry as {
        type?: string;
        message?: { role?: string; content?: unknown };
        isMeta?: boolean;
    };
    if (!e || (e.type !== 'user' && e.type !== 'assistant')) return [];
    if (e.isMeta) return [];

    const content = e.message?.content;
    const out: MirroredMessage[] = [];

    if (typeof content === 'string') {
        const text = content.trim();
        if (text) out.push({ role: e.type === 'user' ? 'user' : 'assistant', text });
        return out;
    }
    if (!Array.isArray(content)) return out;

    for (const raw of content) {
        const block = raw as { type?: string; text?: string; name?: string; content?: unknown };
        if (block.type === 'text' && block.text?.trim()) {
            out.push({ role: e.type === 'user' ? 'user' : 'assistant', text: block.text.trim() });
        } else if (block.type === 'tool_use' && block.name) {
            out.push({ role: 'tool', text: `⚙ ${block.name}` });
        }
        // tool_result blocks are skipped: they are the bulk of a transcript and
        // reading them back adds noise without telling the user anything new.
    }
    return out;
}

function parseLines(chunk: string): MirroredMessage[] {
    const out: MirroredMessage[] = [];
    carry += chunk;
    const lines = carry.split('\n');
    // The final element is either empty or a partial line still being written.
    carry = lines.pop() ?? '';
    for (const line of lines) {
        if (!line.trim()) continue;
        try {
            out.push(...renderEntry(JSON.parse(line)));
        } catch {
            // A torn line mid-append; the next tick will carry a complete one.
        }
    }
    return out;
}

function readFrom(path: string, from: number, to: number): Promise<MirroredMessage[]> {
    return new Promise(resolve => {
        if (to <= from) return resolve([]);
        const messages: MirroredMessage[] = [];
        const stream = createReadStream(path, { start: from, end: to - 1, encoding: 'utf8' });
        stream.on('data', c => messages.push(...parseLines(c as string)));
        stream.on('end', () => resolve(messages));
        stream.on('error', () => resolve([]));
    });
}

/**
 * Begin mirroring. `onHistory` receives everything already in the transcript;
 * `onAppend` fires for each batch written afterwards.
 */
export async function startMirror(
    target: MirrorTarget,
    onHistory: Listener,
    onAppend: Listener
): Promise<{ ok: true } | { ok: false; reason: string }> {
    stopMirror();

    const path = findTranscript(target.sessionId);
    if (!path) return { ok: false, reason: 'could not find that session\'s transcript on disk' };

    active = target;
    watchedPath = path;
    carry = '';
    offset = 0;

    const size = statSync(path).size;
    onHistory(await readFrom(path, 0, size));
    offset = size;

    // watchFile polls stat rather than relying on filesystem events, which are
    // unreliable for a file another process is appending to on Windows.
    watchFile(path, { interval: 300 }, async curr => {
        if (!active || watchedPath !== path) return;
        if (curr.size < offset) {
            // Truncated or replaced; restart from the beginning of the new file.
            offset = 0;
            carry = '';
        }
        if (curr.size === offset) return;
        const batch = await readFrom(path, offset, curr.size);
        offset = curr.size;
        if (batch.length) onAppend(batch);
    });

    return { ok: true };
}

export function stopMirror(): void {
    if (watchedPath) unwatchFile(watchedPath);
    watchedPath = undefined;
    active = undefined;
    carry = '';
    offset = 0;
}

export function mirroring(): MirrorTarget | undefined {
    return active;
}
