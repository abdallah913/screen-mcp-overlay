import type { AppStatus, HudMessage } from '../../shared/types.js';

declare global {
    interface Window {
        hudApi: {
            onMessage(cb: (m: HudMessage) => void): void;
            onStream(cb: (p: { id: string; delta: string; done: boolean }) => void): void;
            onStatus(cb: (s: AppStatus) => void): void;
            onBusy(cb: (b: boolean) => void): void;
            send(prompt: string): Promise<void>;
            listAttachable(): Promise<AttachTarget[]>;
            mirror(dir: string, id: string, summary: string): Promise<void>;
            stopMirror(): Promise<void>;
            onClear(cb: () => void): void;
            onSpeak(cb: (p: { text: string; rate: number }) => void): void;
            onMirror(cb: (label: string | null) => void): void;
            interrupt(): Promise<void>;
            reset(): Promise<void>;
            clearScreen(): Promise<void>;
            copyMcpUrl(): Promise<void>;
            hide(): void;
        };
    }
}

interface AttachTarget {
    workspace: { dir: string; label: string; ideName: string };
    sessions: { sessionId: string; summary: string; lastModified: number; dir: string }[];
}

const log = document.getElementById('log') as HTMLDivElement;
const picker = document.getElementById('picker') as HTMLDivElement;
const mirrorBar = document.getElementById('mirror-bar') as HTMLDivElement;
const mirrorLabel = document.getElementById('mirror-label') as HTMLSpanElement;
const pickerList = document.getElementById('picker-list') as HTMLDivElement;
const input = document.getElementById('input') as HTMLTextAreaElement;
const sendBtn = document.getElementById('send') as HTMLButtonElement;
const statusEl = document.getElementById('status') as HTMLDivElement;
const dot = document.getElementById('dot') as HTMLSpanElement;

/** Streaming bubbles, keyed by the stream id the main process assigns. */
const streams = new Map<string, HTMLElement>();
let busy = false;
let mirroring = false;

function atBottom(): boolean {
    return log.scrollHeight - log.scrollTop - log.clientHeight < 60;
}

function scroll(force = false): void {
    if (force || atBottom()) log.scrollTop = log.scrollHeight;
}

function bubble(role: string): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = `msg ${role}`;
    const body = document.createElement('div');
    body.className = 'body';
    wrap.appendChild(body);
    log.appendChild(wrap);
    return body;
}

function addMessage(m: HudMessage): void {
    const stick = atBottom();
    const body = bubble(m.role);
    body.textContent = m.text;
    scroll(stick);
}

window.hudApi.onMessage(addMessage);

window.hudApi.onStream(({ id, delta, done }) => {
    const stick = atBottom();
    let body = streams.get(id);
    if (!body) {
        body = bubble('assistant');
        body.classList.add('streaming');
        streams.set(id, body);
    }
    if (delta) body.textContent += delta;
    if (done) {
        body.classList.remove('streaming');
        streams.delete(id);
    }
    scroll(stick);
});

window.hudApi.onSpeak(({ text, rate }) => {
    try {
        // Cancel anything still playing so guidance never overlaps itself.
        speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(text);
        u.rate = rate;
        speechSynthesis.speak(u);
    } catch {
        // No voices installed, or synthesis blocked; the panel text still shows.
    }
});

window.hudApi.onClear(() => {
    log.replaceChildren();
    streams.clear();
});

window.hudApi.onMirror(label => {
    mirroring = label !== null;
    mirrorBar.hidden = !mirroring;
    if (label) mirrorLabel.textContent = label;
    // While following an editor session the panel is a view, not an input.
    input.disabled = mirroring;
    sendBtn.disabled = mirroring;
    input.placeholder = mirroring
        ? 'Following your editor — type there'
        : "Ask about what's on your screen…";
});

window.hudApi.onBusy(b => {
    busy = b;
    sendBtn.textContent = b ? 'Stop' : 'Send';
    sendBtn.classList.toggle('stop', b);
    dot.classList.toggle('busy', b);
});

window.hudApi.onStatus((s: AppStatus) => {
    statusEl.textContent = s.mcpUrl ? `${s.provider} · ${s.mcpUrl}` : 'MCP server not running';
    statusEl.title = s.contentProtection
        ? 'The overlay is hidden from screen recording and from its own screenshots.'
        : 'The overlay is visible to screen recording.';
});

function submit(): void {
    if (mirroring) return;
    if (busy) {
        void window.hudApi.interrupt();
        return;
    }
    const value = input.value.trim();
    if (!value) return;
    input.value = '';
    resizeInput();
    void window.hudApi.send(value);
    scroll(true);
}

sendBtn.addEventListener('click', submit);

input.addEventListener('keydown', e => {
    // Enter sends; Shift+Enter makes a new line.
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        submit();
    }
    if (e.key === 'Escape') window.hudApi.hide();
});

function resizeInput(): void {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
}
input.addEventListener('input', resizeInput);

// --- attach picker --------------------------------------------------------

function relativeTime(ms: number): string {
    const mins = Math.round((Date.now() - ms) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.round(hours / 24)}d ago`;
}

async function openPicker(): Promise<void> {
    picker.hidden = false;
    pickerList.textContent = 'Looking for editor sessions…';

    let targets: AttachTarget[] = [];
    try {
        targets = await window.hudApi.listAttachable();
    } catch (err) {
        pickerList.textContent = `Could not list sessions: ${(err as Error).message}`;
        return;
    }

    const withSessions = targets.filter(t => t.sessions.length > 0);
    if (withSessions.length === 0) {
        pickerList.textContent =
            'No editor sessions found. Open a folder in VS Code with Claude Code running, then try again.';
        return;
    }

    pickerList.replaceChildren();
    for (const target of withSessions) {
        const group = document.createElement('div');
        group.className = 'ws';
        const head = document.createElement('div');
        head.className = 'ws-head';
        head.textContent = `${target.workspace.label}  ·  ${target.workspace.ideName}`;
        head.title = target.workspace.dir;
        group.appendChild(head);

        for (const session of target.sessions) {
            const row = document.createElement('button');
            row.className = 'session';
            const title = document.createElement('span');
            title.className = 'session-title';
            title.textContent = session.summary;
            const when = document.createElement('span');
            when.className = 'session-when';
            when.textContent = relativeTime(session.lastModified);
            row.append(title, when);
            row.addEventListener('click', () => {
                picker.hidden = true;
                void window.hudApi.mirror(session.dir, session.sessionId, session.summary);
            });
            group.appendChild(row);
        }
        pickerList.appendChild(group);
    }
}

document.getElementById('attach')!.addEventListener('click', () => {
    if (picker.hidden) void openPicker();
    else picker.hidden = true;
});
document.getElementById('picker-close')!.addEventListener('click', () => {
    picker.hidden = true;
});

document.getElementById('mirror-stop')!.addEventListener('click', () => void window.hudApi.stopMirror());

document.getElementById('clear')!.addEventListener('click', () => void window.hudApi.clearScreen());
document.getElementById('new')!.addEventListener('click', () => {
    log.replaceChildren();
    streams.clear();
    void window.hudApi.reset();
});
document.getElementById('copy')!.addEventListener('click', () => void window.hudApi.copyMcpUrl());
document.getElementById('close')!.addEventListener('click', () => window.hudApi.hide());

input.focus();
