import { ipcMain } from 'electron';
import type { AgentEvent, AgentProvider } from './types.js';
import { ClaudeProvider } from './claude.js';
import { clearLog, pushMessage, setBusy, setMirror, streamMessage } from '../hud.js';
import { listIdeWorkspaces, listSessionsForDir, type IdeWorkspace, type SessionChoice } from './sessions.js';
import { sdkUnavailable } from './sdk.js';
import { mirroring, startMirror, stopMirror } from './mirror.js';

/**
 * Owns the chat panel's conversation: one provider, one in-flight turn at a
 * time, and the translation from provider events into HUD updates.
 */

const providers = new Map<string, AgentProvider>();
let current: AgentProvider;
let sessionId: string | undefined;
let busy = false;

export function initAgentHost(): void {
    const claude = new ClaudeProvider();
    providers.set(claude.id, claude);
    current = claude;

    ipcMain.handle('agent:send', async (_e, prompt: string) => {
        await sendPrompt(prompt);
    });

    ipcMain.handle('agent:interrupt', async () => {
        await current.interrupt();
    });

    ipcMain.handle('agent:reset', async () => {
        await current.interrupt();
        sessionId = undefined;
        stopMirror();
        setMirror(null);
        pushMessage('system', 'Started a new conversation.');
    });

    ipcMain.handle('agent:provider', () => current.label);

    // --- attaching to an editor session -----------------------------------

    ipcMain.handle('agent:list-attachable', async (): Promise<AttachTarget[]> => {
        const workspaces = listIdeWorkspaces();
        const out: AttachTarget[] = [];
        for (const ws of workspaces) {
            let sessions: SessionChoice[] = [];
            try {
                sessions = await listSessionsForDir(ws.dir, 5);
            } catch (err) {
                pushMessage('error', `Could not read sessions for ${ws.label}. ${sdkUnavailable(err)}`);
            }
            out.push({ workspace: ws, sessions });
        }
        return out;
    });

    ipcMain.handle('agent:mirror', async (_e, dir: string, id: string, summary: string) => {
        const result = await startMirror(
            { sessionId: id, dir, label: summary },
            history => {
                clearLog();
                pushMessage('system', `Following "${summary}" from your editor. Live, read-only.`);
                for (const m of history) pushMessage(m.role, m.text);
            },
            batch => {
                for (const m of batch) pushMessage(m.role, m.text);
            }
        );
        if (!result.ok) {
            pushMessage('error', `Could not mirror that session: ${result.reason}`);
            return;
        }
        setMirror(summary);
    });

    ipcMain.handle('agent:stop-mirror', () => {
        if (!mirroring()) return;
        stopMirror();
        setMirror(null);
        pushMessage('system', 'Stopped following the editor session. This panel is its own conversation again.');
    });
}

export interface AttachTarget {
    workspace: IdeWorkspace;
    sessions: SessionChoice[];
}

export function currentProviderLabel(): string {
    return current?.label ?? 'none';
}

export function isBusy(): boolean {
    return busy;
}

export async function sendPrompt(prompt: string): Promise<void> {
    const trimmed = prompt.trim();
    if (!trimmed) return;
    if (busy) {
        pushMessage('system', 'Still working on the previous message. Press Stop to interrupt.');
        return;
    }

    if (mirroring()) {
        pushMessage(
            'system',
            'This panel is following your editor session, so it is read-only. Type in your editor ' +
                'instead, or press Stop following to start a separate conversation here.'
        );
        return;
    }

    const unavailable = await current.check();
    if (unavailable) {
        pushMessage('error', unavailable);
        return;
    }

    pushMessage('user', trimmed);
    busy = true;
    setBusy(true);

    // Streaming assistant text is rendered by id so deltas land in the right
    // bubble even when tool calls interleave with prose.
    const openText = new Set<string>();

    const emit = (e: AgentEvent): void => {
        switch (e.type) {
            case 'text-start':
                // The renderer creates the bubble keyed by this id on first
                // sight, so there is no separate pushMessage for it.
                if (!openText.has(e.id)) {
                    openText.add(e.id);
                    streamMessage(e.id, '', false);
                }
                break;
            case 'text-delta':
                streamMessage(e.id, e.delta, false);
                break;
            case 'text-end':
                streamMessage(e.id, '', true);
                openText.delete(e.id);
                break;
            case 'thinking':
                setBusy(true);
                break;
            case 'tool':
                pushMessage('tool', e.summary);
                break;
            case 'notice':
                pushMessage('system', e.text);
                break;
            case 'error':
                pushMessage('error', e.message);
                break;
            case 'done':
                break;
        }
    };

    try {
        const result = await current.send({ prompt: trimmed, sessionId }, emit);
        sessionId = result.sessionId ?? sessionId;
    } catch (err) {
        pushMessage('error', (err as Error).message);
    } finally {
        busy = false;
        setBusy(false);
    }
}
