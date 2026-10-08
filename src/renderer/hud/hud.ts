import type { AppStatus, HudMessage, StepView } from '../../shared/types.js';
import {
    type CardAnswer,
    choiceForKey,
    clickProgress,
    heldReplyNote,
    keysHint,
    sameText,
    stepButtons,
    stepHeading,
    timeLeft
} from './step.js';

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
            onSpeakStop(cb: () => void): void;
            onMirror(cb: (label: string | null) => void): void;
            onStep(cb: (step: StepView | null) => void): void;
            onStepEnded(cb: (p: { id: string; outcome: string }) => void): void;
            onCollapsed(cb: (collapsed: boolean) => void): void;
            onReplyReturned(cb: (text: string) => void): void;
            answerStep(id: string, answer: CardAnswer): void;
            showMe(id: string): void;
            composing(on: boolean): void;
            reportVoices(local: boolean): void;
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
const card = document.getElementById('step-card') as HTMLElement;
const cardProgress = document.getElementById('step-progress') as HTMLSpanElement;
const cardKind = document.getElementById('step-kind') as HTMLSpanElement;
const cardTime = document.getElementById('step-time') as HTMLSpanElement;
const cardPrompt = document.getElementById('step-prompt') as HTMLDivElement;
const cardTarget = document.getElementById('step-target') as HTMLDivElement;
const cardShow = document.getElementById('step-show') as HTMLButtonElement;
const cardCount = document.getElementById('step-count') as HTMLDivElement;
const cardButtons = document.getElementById('step-buttons') as HTMLDivElement;
const cardKeys = document.getElementById('step-keys') as HTMLDivElement;

/** Streaming bubbles, keyed by the stream id the main process assigns. */
const streams = new Map<string, HTMLElement>();
let busy = false;
let mirroring = false;
/** The pending step, pinned as a card above the composer. */
let step: StepView | null = null;
/** Each step's line in the log, so its outcome can be written beside it. */
const stepEntries = new Map<string, HTMLElement>();
let ticker: number | undefined;
let composing = false;
/**
 * The step that was pending when the text in the reply box was started (null:
 * none was); undefined while the box is empty. See heldReplyNote.
 */
let typedFor: string | null | undefined;

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
    // An agent that also posts the step's instruction with show_message would
    // log it twice; the step's own entry already holds it.
    if (m.role === 'guide' && step && sameText(m.text, step.prompt)) return;
    const stick = atBottom();
    const body = bubble(m.role);
    body.textContent = m.text;
    scroll(stick);
}

window.hudApi.onMessage(addMessage);

/** A line from the panel itself, about something only it knows. */
function note(text: string): void {
    const body = bubble('system');
    body.textContent = text;
    scroll(true);
}

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

// --- speech -------------------------------------------------------------

/**
 * Only installed voices are used. Chromium can list voices that synthesise
 * remotely, and sending the user's guidance off the machine is not something a
 * speech preference should do quietly.
 */
function localVoice(): SpeechSynthesisVoice | null | undefined {
    const voices = speechSynthesis.getVoices();
    if (voices.length === 0) return undefined;
    return voices.find(v => v.localService && v.default) ?? voices.find(v => v.localService) ?? null;
}

function reportVoices(): void {
    try {
        window.hudApi.reportVoices(!!localVoice());
    } catch {
        window.hudApi.reportVoices(false);
    }
}

try {
    speechSynthesis.addEventListener('voiceschanged', reportVoices);
    // Voices load asynchronously, and a machine with none never fires
    // voiceschanged, so look once more after a moment either way.
    if (speechSynthesis.getVoices().length > 0) reportVoices();
    setTimeout(reportVoices, 3000);
} catch {
    window.hudApi.reportVoices(false);
}

window.hudApi.onSpeak(({ text, rate }) => {
    try {
        // Cancel anything still playing so guidance never overlaps itself.
        speechSynthesis.cancel();
        const voice = localVoice();
        if (voice === null) return;
        const u = new SpeechSynthesisUtterance(text);
        if (voice) u.voice = voice;
        u.rate = rate;
        speechSynthesis.speak(u);
    } catch {
        // No voices installed, or synthesis blocked; the panel text still shows.
    }
});

window.hudApi.onSpeakStop(() => {
    try {
        speechSynthesis.cancel();
    } catch {
        // Nothing was playing.
    }
});

window.hudApi.onClear(() => {
    log.replaceChildren();
    streams.clear();
    stepEntries.clear();
});

window.hudApi.onMirror(label => {
    mirroring = label !== null;
    mirrorBar.hidden = !mirroring;
    if (label) mirrorLabel.textContent = label;
    updateComposer();
});

window.hudApi.onBusy(b => {
    busy = b;
    dot.classList.toggle('busy', b);
    updateComposer();
});

window.hudApi.onStatus((s: AppStatus) => {
    statusEl.textContent = s.mcpUrl ? `${s.provider} · ${s.mcpUrl}` : 'MCP server not running';
    statusEl.title = s.contentProtection
        ? 'The overlay is hidden from screen recording and from its own screenshots.'
        : 'The overlay is visible to screen recording.';
});

window.hudApi.onCollapsed(collapsed => {
    document.body.classList.toggle('pill', collapsed);
});

// --- the pending step -------------------------------------------------------

/**
 * Log a step's instruction as guidance, once. If the agent posted the same
 * text just before starting the step (show_message, then the step), that line
 * becomes the step's entry instead of a second copy.
 */
function logStep(s: StepView): void {
    const last = log.lastElementChild as HTMLElement | null;
    const lastBody = last?.querySelector('.body') as HTMLElement | null;
    const stick = atBottom();
    let body: HTMLElement;
    if (last?.classList.contains('guide') && !last.dataset.step && lastBody && sameText(lastBody.textContent ?? '', s.prompt)) {
        body = lastBody;
    } else {
        body = bubble('guide');
        body.textContent = s.prompt;
    }
    // What is circled and where, so the log still says which control a step
    // meant once its drawing is gone.
    if (s.target) {
        const where = document.createElement('div');
        where.className = 'where';
        where.textContent = s.target;
        body.appendChild(where);
    }
    scroll(stick);
    (body.parentElement as HTMLElement).dataset.step = s.id;
    stepEntries.set(s.id, body);
}

window.hudApi.onStep(next => {
    const fresh = next !== null && next.id !== step?.id;
    if (fresh) logStep(next);
    step = next;
    renderCard();
    updateComposer();
    // A question's number keys work only while the reply box does not have
    // focus, so an empty box gives focus up to the card; typing still goes
    // to the box (see the keydown handler).
    if (fresh && next.mode === 'choice' && document.activeElement === input && !input.value.trim()) card.focus();
});

window.hudApi.onStepEnded(({ id, outcome }) => {
    const body = stepEntries.get(id);
    stepEntries.delete(id);
    if (!body || !outcome) return;
    const tag = document.createElement('span');
    tag.className = 'outcome';
    tag.textContent = outcome;
    // Beside the instruction, above the where-line.
    body.insertBefore(tag, body.querySelector('.where'));
});

// Main hands back a reply that arrived after its step had ended.
window.hudApi.onReplyReturned(text => {
    const ended = 'That step had already ended, so your reply was not sent.';
    // A locked box (this panel follows an editor) cannot take it back.
    if (input.disabled) {
        note(`${ended} You wrote: "${text}"`);
        return;
    }
    note(`${ended} It is back in the reply box.`);
    const current = input.value.trim();
    input.value = current ? `${text}\n${current}` : text;
    // Main has said what happened; the next Enter sends it wherever it goes now.
    typedFor = step?.id ?? null;
    resizeInput();
    updateComposer();
});

function answer(a: CardAnswer): void {
    if (step) window.hudApi.answerStep(step.id, a);
}

function renderCard(): void {
    window.clearInterval(ticker);
    ticker = undefined;
    card.hidden = !step;
    if (!step) return;

    const s = step;
    const heading = stepHeading(s);
    cardProgress.hidden = !heading.progress;
    cardProgress.textContent = heading.progress ?? '';
    cardKind.textContent = s.mode === 'choice' ? 'The agent asks' : s.mode === 'click' ? 'Point at it' : 'Your step';
    cardPrompt.textContent = heading.prompt;
    cardTarget.hidden = !s.target;
    cardTarget.textContent = s.target ?? '';
    // Nothing drawn, nothing to point at again.
    cardShow.hidden = s.targetIds.length === 0;

    const count = clickProgress(s);
    cardCount.hidden = !count;
    cardCount.textContent = count ? `${count} · the app does not receive these clicks` : '';

    cardButtons.replaceChildren(
        ...stepButtons(s).map(b => {
            const btn = document.createElement('button');
            btn.className = b.primary ? 'step-btn primary' : 'step-btn';
            if (b.key) {
                const key = document.createElement('kbd');
                key.textContent = b.key;
                btn.append(key);
            }
            btn.append(b.label);
            btn.addEventListener('click', () => answer(b.answer));
            return btn;
        })
    );
    cardButtons.classList.toggle('options', s.mode === 'choice');

    const keys = keysHint(s);
    cardKeys.hidden = !keys;
    cardKeys.textContent = keys ?? '';

    const tick = (): void => {
        cardTime.textContent = timeLeft(s.deadline, Date.now());
    };
    tick();
    ticker = window.setInterval(tick, 1000);
}

// Someone who looked away (or listens rather than reads) gets the target
// pointed at again, and the step read again if steps are read aloud.
cardShow.addEventListener('click', () => {
    if (step) window.hudApi.showMe(step.id);
});

// Number keys pick an option while the panel has focus, but never from inside
// the reply box: a reply such as "2 of them are open" would otherwise be sent
// as the choice of option 2.
document.addEventListener('keydown', e => {
    if (!step || step.mode !== 'choice' || e.ctrlKey || e.altKey || e.metaKey) return;
    if (document.activeElement === input) return;
    const index = choiceForKey(step, e.key);
    if (index !== null) {
        e.preventDefault();
        answer({ kind: 'choice', index });
        return;
    }
    // Any other character starts a typed reply. Focusing the box during
    // keydown lets this same keystroke land in it.
    if (e.key.length === 1 && e.key !== ' ' && !input.disabled) input.focus();
});

// Bringing the panel forward while a step is pending is reaching for the reply
// box, except for a question, whose number keys need the focus elsewhere.
window.addEventListener('focus', () => {
    if (!step || input.disabled) return;
    if (step.mode === 'choice' && !input.value.trim()) card.focus();
    else input.focus();
});

// --- composer ---------------------------------------------------------------

/**
 * While a step is pending the composer answers it: whatever is typed goes to
 * the agent waiting on the step, including one in the user's terminal and
 * while this panel follows an editor session or its own agent is busy (busy
 * because it is waiting on that very step).
 */
function updateComposer(): void {
    const replying = step !== null;
    const locked = mirroring && !replying;
    // A reply left in a box that is about to lock (its step ended while this
    // panel follows an editor) could be neither sent nor cleared. Move it to
    // the log, where it can still be read and copied.
    if (locked && !input.disabled && input.value.trim()) {
        const why =
            heldReplyNote(typedFor ?? null, step, { busy, mirroring }) ??
            'This panel is now following your editor, so this was not sent.';
        note(`${why} You wrote: "${input.value.trim()}"`);
        input.value = '';
        typedFor = undefined;
        resizeInput();
    }
    const stop = stopping();
    input.disabled = locked;
    sendBtn.disabled = locked;
    input.placeholder = replying
        ? 'Reply to the agent…'
        : mirroring
          ? 'Following your editor — type there'
          : "Ask about what's on your screen…";
    sendBtn.textContent = stop ? 'Stop' : replying ? 'Reply' : 'Send';
    sendBtn.classList.toggle('stop', stop);
    setComposing();
}

/** Whether the Send button reads Stop: the panel's agent is busy and there is no reply to send. */
function stopping(): boolean {
    return busy && !(step !== null && input.value.trim());
}

/** Tell main whether unsent text is being held; a locked box holds none. */
function setComposing(): void {
    const now = !input.disabled && input.value.trim().length > 0;
    if (now === composing) return;
    composing = now;
    window.hudApi.composing(now);
}

/**
 * Send what is in the box. `fromButton`: the Send/Stop button, which stops a
 * busy agent when it reads Stop. Enter never stops one while there is text:
 * someone pressing Enter means to send what they wrote.
 */
function submit(fromButton: boolean): void {
    const value = input.value.trim();
    if (fromButton && stopping()) {
        if (!mirroring) void window.hudApi.interrupt();
        return;
    }
    if (value && typedFor !== undefined) {
        const held = heldReplyNote(typedFor, step, { busy, mirroring });
        if (held) {
            note(held);
            typedFor = step?.id ?? null;
            return;
        }
    }
    if (step && value) {
        window.hudApi.answerStep(step.id, { kind: 'reply', text: value });
    } else {
        if (mirroring) return;
        if (busy) {
            if (value) {
                note('The agent is still working. Press Stop to interrupt it, or send this when it has finished.');
                return;
            }
            void window.hudApi.interrupt();
            return;
        }
        if (!value) return;
        void window.hudApi.send(value);
    }
    input.value = '';
    typedFor = undefined;
    resizeInput();
    updateComposer();
    scroll(true);
}

sendBtn.addEventListener('click', () => submit(true));

input.addEventListener('keydown', e => {
    // Enter sends; Shift+Enter makes a new line.
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        submit(false);
    }
    if (e.key === 'Escape') window.hudApi.hide();
});

function resizeInput(): void {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
}
input.addEventListener('input', () => {
    if (!input.value.trim()) typedFor = undefined;
    else if (typedFor === undefined) typedFor = step?.id ?? null;
    resizeInput();
    updateComposer();
});

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
