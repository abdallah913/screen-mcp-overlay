import { BrowserWindow, ipcMain, screen } from 'electron';
import { join } from 'node:path';
import type {
    Annotation,
    AppStatus,
    HudMessage,
    HudRole,
    Rect,
    StepAnswer,
    StepView,
    UserAnswer
} from '../shared/types.js';
import { parseProgress } from '../shared/progress.js';
import { listDisplays } from './displays.js';
import { pingTargets, raiseOverlays } from './overlay.js';
import { settings } from './settings.js';
import { answerStep, cancelStep, currentStep, onStepEnded } from './steps.js';
import { store } from './store.js';
import { focusWindow, setHudWindowRef } from './uia.js';

/**
 * The chat panel. Unlike the overlay windows this one is focusable and
 * interactive -- it is where the user types. It is a separate window so the
 * overlay can stay strictly click-through at all times.
 *
 * It is also how the user answers an agent that cannot hear them: a terminal
 * agent blocked on a step has no other channel, so the pending step is pinned
 * here as a card with buttons, and whatever is typed while one is pending goes
 * to that agent as a reply rather than starting a separate conversation.
 */

const WIDTH = 420;
const HEIGHT = 580;
const MARGIN = 24;
/** Drawings this close to the panel count as under it: a ring's stroke and its caption spill past the rect. */
const DODGE_SLACK = 16;
/** The collapsed panel, used when every corner of the display has something drawn in it. */
const PILL = { width: 220, height: 44 };
/** A pasted wall of text must not flood the agent's context. */
export const REPLY_LIMIT = 500;
/** Messages kept for a panel that has not loaded yet; older ones are dropped. */
const QUEUE_LIMIT = 200;
/** The pointer this close to the panel means the user is reaching for it. */
const POINTER_SLACK = 24;
/** How often a move held back by the pointer is tried again. */
const POINTER_RECHECK_MS = 500;

let hud: BrowserWindow | null = null;
let queued: HudMessage[] = [];
let seq = 0;
/** Set when the app is quitting, the one time a close may really close the panel. */
let quitting = false;
let pointerRecheck: NodeJS.Timeout | null = null;

/** Where the user put the panel. Dodging moves it away and always comes back here. */
let home: Rect | null = null;
let placed: { bounds: Rect; collapsed: boolean } | null = null;
/** Moves we make ourselves must not be mistaken for the user choosing a new spot. */
let selfMoveUntil = 0;
let draggingUntil = 0;
let composing = false;

/** The step the panel last saw start, so a republish of the same step is not a new one. */
let shownStep: StepView | null = null;
let spokenFor: string | null = null;
/** Undefined until the panel has looked at the installed voices. */
let localVoice: boolean | undefined;
let onVoices: (() => void) | null = null;

function nextId(): string {
    seq += 1;
    return `msg_${seq}`;
}

/**
 * Create the panel. `startHidden` keeps it closed for a login launch: it loads
 * and listens as usual but is not shown until asked for, or until a question
 * needs answering.
 */
export function createHud(contentProtection: boolean, startHidden = false): BrowserWindow {
    const primary = screen.getPrimaryDisplay();

    hud = new BrowserWindow({
        width: WIDTH,
        height: HEIGHT,
        x: primary.workArea.x + primary.workArea.width - WIDTH - MARGIN,
        y: primary.workArea.y + primary.workArea.height - HEIGHT - MARGIN,
        minWidth: 320,
        minHeight: 260,
        frame: false,
        transparent: true,
        backgroundColor: '#00000000',
        resizable: true,
        skipTaskbar: true,
        hasShadow: true,
        show: false,
        webPreferences: {
            preload: join(__dirname, '../preload/hud.js'),
            contextIsolation: true,
            nodeIntegration: false
        }
    });
    home = hud.getBounds();

    hud.setAlwaysOnTop(true, 'floating');
    hud.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    hud.setContentProtection(contentProtection);
    setHudWindowRef(nativeRef(hud));

    void hud.loadFile(join(__dirname, '../renderer/hud/index.html'));
    hud.once('ready-to-show', () => {
        // Hiding the window before this point does nothing (it is not shown
        // yet), so a hidden start has to be decided here.
        if (!startHidden) hud?.show();
        // Anything the MCP server posted before the window existed.
        for (const m of queued) hud?.webContents.send('hud:message', m);
        queued = [];
        send('hud:step', currentStep());
    });
    // Alt+F4 on the panel means "put it away", not "destroy it": nothing
    // recreates the window, and it carries the step card and the only
    // free-text channel to a terminal agent. Hide it, as the close button
    // does, unless the app is quitting or Windows is ending the session.
    hud.on('close', e => {
        if (quitting) return;
        e.preventDefault();
        hud?.hide();
    });
    hud.on('session-end', allowHudClose);
    hud.on('closed', () => {
        hud = null;
        setHudWindowRef(undefined);
    });
    // Focusing or showing the panel raises it within the topmost band; put the
    // annotations back above it so nothing the agent drew gets hidden. Not while
    // a click is pending: the overlay then captures every click, and the panel
    // has to stay above it for its Cancel button and reply box to be reachable.
    const raise = (): void => {
        if (currentStep()?.mode !== 'click') raiseOverlays();
    };
    hud.on('focus', () => {
        raise();
        // Someone reaching for the collapsed pill wants the panel back.
        if (placed?.collapsed && home) place({ bounds: home, collapsed: false });
    });
    hud.on('show', raise);
    hud.on('blur', reconsiderPlacement);

    // will-move and will-resize fire throughout a drag; the deadline lapses on
    // its own if the matching 'moved' never arrives.
    const dragging = (): void => {
        draggingUntil = Date.now() + 1500;
    };
    hud.on('will-move', dragging);
    hud.on('will-resize', dragging);
    hud.on('moved', userPlaced);
    hud.on('resized', userPlaced);

    wire();
    return hud;
}

let wired = false;

function wire(): void {
    if (wired) return;
    wired = true;

    store.on('step', stepChanged);
    store.on('annotations', reconsiderPlacement);
    onStepEnded(stepEnded);

    ipcMain.on('hud:step-answer', (_e, payload: { id?: unknown; answer?: unknown }) => {
        const answer = panelAnswer(payload?.answer);
        if (!answer || typeof payload.id !== 'string') return;
        if (answer.kind === 'reply') {
            // The step can end between the panel sending this and it arriving
            // (a timeout, its UI state arrived, a newer step). Hand the text
            // back rather than dropping what the user wrote; the panel says so.
            if (!replyToStep(answer.text, payload.id)) send('hud:reply-returned', answer.text);
            return;
        }
        // Look up the target before answering: the tool clears its drawing as
        // soon as the step resolves.
        const step = currentStep();
        if (answer.kind === 'cancel') {
            // The same as Escape or the strip's Cancel, so the agent hears
            // CANCELLED with the points already placed, whichever was used.
            if (step?.id === payload.id) cancelStep('esc');
            return;
        }
        const target = step ? targetWindowRef(step.targetIds, store.list()) : undefined;
        if (answerStep(answer, payload.id) && target && hudWindow()?.isFocused()) {
            // Pressing a button focused the panel; the next step happens in the
            // app, so hand the keyboard back to it.
            focusWindow(target).catch(() => undefined);
        }
    });

    ipcMain.on('hud:composing', (_e, on: unknown) => {
        composing = on === true;
        if (!composing) reconsiderPlacement();
    });

    ipcMain.on('hud:voices', (_e, p: { local?: unknown }) => {
        localVoice = p?.local === true;
        onVoices?.();
    });

    // "Show me" on the card: point at the target again and, for someone
    // listening rather than reading, say the step again. Neither answers it.
    ipcMain.on('hud:show-me', (_e, id: unknown) => {
        const step = currentStep();
        if (!step || step.id !== id) return;
        pingTargets(step.targetIds);
        sayStep(step);
    });
}

/** Let the panel close for real; called when the app quits. */
export function allowHudClose(): void {
    quitting = true;
}

/** A window's HWND in the decimal form the helper uses for refs. */
function nativeRef(win: BrowserWindow): string | undefined {
    try {
        const h = win.getNativeWindowHandle();
        return String(h.length >= 8 ? h.readBigUInt64LE(0) : h.readUInt32LE(0));
    } catch {
        return undefined;
    }
}

export function hudWindow(): BrowserWindow | null {
    return hud && !hud.isDestroyed() ? hud : null;
}

/** The panel's bounds in global DIPs while it is visible, else null. */
export function hudBounds(): Rect | null {
    const win = hudWindow();
    return win && win.isVisible() ? win.getBounds() : null;
}

/**
 * Show or hide the panel. From the keyboard shortcut, while a step is pending,
 * a visible panel that is not focused is brought forward instead of hidden:
 * someone pressing it then wants to type a reply, and hiding the panel is the
 * opposite of that. Not from the tray, whose click always takes focus away
 * from the panel, so the panel could never be hidden from there.
 */
export function toggleHud(fromKeyboard = false): void {
    const win = hudWindow();
    if (!win) return;
    if (win.isVisible() && (win.isFocused() || !fromKeyboard || !currentStep())) {
        win.hide();
        return;
    }
    win.show();
    win.focus();
}

export function setHudContentProtection(on: boolean): void {
    hudWindow()?.setContentProtection(on);
}

function send(channel: string, payload: unknown): void {
    const win = hudWindow();
    if (win) win.webContents.send(channel, payload);
}

/** Push a complete message into the transcript. */
export function pushMessage(role: HudRole, textBody: string): HudMessage {
    const msg: HudMessage = { id: nextId(), role, text: textBody, at: Date.now() };
    const win = hudWindow();
    if (win) win.webContents.send('hud:message', msg);
    else if (queued.push(msg) > QUEUE_LIMIT) queued = queued.slice(-QUEUE_LIMIT);
    return msg;
}

/** Create or extend a streaming assistant message. */
export function streamMessage(id: string, delta: string, done = false): void {
    send('hud:stream', { id, delta, done });
}

export function setStatus(status: AppStatus): void {
    send('hud:status', status);
}

export function setBusy(busy: boolean): void {
    send('hud:busy', busy);
}

/** Wipe the transcript, e.g. before replaying a mirrored session's history. */
export function clearLog(): void {
    send('hud:clear', null);
}

/** Tell the panel it is following an editor session (or no longer is). */
export function setMirror(label: string | null): void {
    send('hud:mirror', label);
}

/**
 * Speak through the panel's renderer.
 *
 * Chromium ships speechSynthesis and it uses the installed Windows voices, so
 * this needs no extra dependency and no network. Returns false when the panel is
 * not around to speak through, or has found no local voice to speak with,
 * rather than pretending it worked.
 */
export function speak(text: string, rate: number): boolean {
    const win = hudWindow();
    if (!win || localVoice === false) return false;
    win.webContents.send('hud:speak', { text, rate });
    return true;
}

/** Cut off whatever the panel is saying. */
export function stopSpeaking(): void {
    spokenFor = null;
    send('hud:speak-stop', null);
}

/** False once the panel has found no local voice; undefined until it has looked. */
export function hasLocalVoice(): boolean | undefined {
    return localVoice;
}

/** Called when the panel reports which voices exist, e.g. to update the tray. */
export function onVoicesKnown(cb: () => void): void {
    onVoices = cb;
}

/**
 * Called by the show_message MCP tool so an external agent can talk to the user.
 * Information for the user is guidance, styled apart from the audit lines.
 */
export function postToHud(textBody: string, level: 'info' | 'warn' | 'error'): void {
    const win = hudWindow();
    if (win && !win.isVisible()) win.showInactive();
    // The pending step's own card already says this.
    if (level === 'info' && currentStep()?.prompt.trim() === textBody.trim()) return;
    pushMessage(level === 'error' ? 'error' : level === 'warn' ? 'system' : 'guide', textBody);
}

/**
 * Answer the pending step with what the user typed. Returns false when there
 * is no step to answer (or `id` names an older one), so the caller can treat
 * the text as an ordinary message instead.
 */
export function replyToStep(textBody: string, id?: string): boolean {
    const reply = capReply(textBody);
    if (!reply || !answerStep({ kind: 'reply', text: reply }, id)) return false;
    pushMessage('user', reply);
    return true;
}

// ---------------------------------------------------------- the pending step

function stepChanged(): void {
    const step = store.getStep();
    send('hud:step', step);
    if (step?.id === shownStep?.id) {
        // Click mode makes the overlays focusable, and the one that took a
        // click can come up over the panel; keep Cancel and the reply box
        // reachable for the rest of a multi-click step.
        if (step?.mode === 'click' && step.collected !== shownStep?.collected) {
            const win = hudWindow();
            if (win?.isVisible()) win.moveTop();
        }
        shownStep = step;
        return;
    }
    const previous = shownStep;
    shownStep = step;

    if (spokenFor && spokenFor !== step?.id) stopSpeaking();
    // The overlay stops capturing clicks; drawings go back above the panel.
    if (previous?.mode === 'click' && step?.mode !== 'click') raiseOverlays();
    if (!step) return;

    const win = hudWindow();
    if (win) {
        // A question is answered here, so it must be seen. Other steps are
        // shown on the overlay where the user is looking, so a panel they hid
        // stays hidden, and in click mode it would cover what they point at.
        if (!win.isVisible() && step.mode === 'choice') win.showInactive();
        // The overlay is about to capture every click; keep the panel above it.
        if (step.mode === 'click' && win.isVisible()) win.moveTop();
    }

    sayStep(step);
}

/** Read a step's instruction aloud, when the user asked for that. */
function sayStep(step: StepView): void {
    const prefs = settings();
    if (!prefs.readStepsAloud) return;
    const line = parseProgress(step.prompt)?.rest ?? step.prompt;
    if (speak(line, prefs.speechRate)) spokenFor = step.id;
}

function stepEnded(view: StepView, answer: StepAnswer): void {
    send('hud:step-ended', { id: view.id, outcome: outcomeLabel(view, answer) });
    if (answer.kind !== 'cancelled') return;
    // The two ways a step ends that the agent did not cause and the user may
    // not have meant: say so where they can see it.
    if (answer.by === 'superseded') {
        pushMessage('system', `Replaced a pending step with a newer one: "${view.prompt}".`);
    } else if (answer.by === 'clear') {
        pushMessage('system', 'Cleared the screen and stopped the current step. The agent has been told.');
    }
}

/** A word or two for the step log, beside the instruction it answers. */
export function outcomeLabel(view: StepView, a: StepAnswer): string {
    switch (a.kind) {
        case 'clicks':
            return a.complete
                ? view.count > 1
                    ? `${a.clicks.length} clicks`
                    : 'Clicked'
                : `${a.clicks.length} of ${view.count} clicks`;
        case 'done':
            return 'Done';
        case 'stuck':
            return "Couldn't find it";
        case 'skip':
            return 'Skipped';
        case 'reply':
            return 'Replied';
        case 'choice':
            return `Chose "${a.label}"`;
        case 'timeout':
            return 'No response';
        case 'cancelled':
            switch (a.by) {
                case 'esc':
                    return 'Cancelled';
                case 'clear':
                    return 'Stopped';
                case 'client':
                    return 'Called off by the agent';
                case 'superseded':
                    return 'Replaced';
            }
            break;
        case 'ended':
            return 'Finished';
    }
    return '';
}

/**
 * What the panel's card sends: an answer, or Cancel on a click step, which ends
 * the step the way Escape does instead of answering it.
 */
export type PanelAnswer = UserAnswer | { kind: 'cancel' };

/**
 * Validate an answer arriving from the panel's renderer. It is our own page,
 * but it is still the far side of an IPC boundary, so nothing is trusted to
 * have the right shape.
 */
export function panelAnswer(raw: unknown): PanelAnswer | null {
    if (!raw || typeof raw !== 'object') return null;
    const a = raw as Record<string, unknown>;
    switch (a.kind) {
        case 'cancel':
            return { kind: 'cancel' };
        case 'done':
            return { kind: 'done' };
        case 'skip':
            return { kind: 'skip' };
        case 'stuck':
            return typeof a.text === 'string' && a.text.trim()
                ? { kind: 'stuck', text: capReply(a.text) }
                : { kind: 'stuck' };
        case 'reply':
            return typeof a.text === 'string' && a.text.trim() ? { kind: 'reply', text: capReply(a.text) } : null;
        case 'choice':
            return Number.isInteger(a.index) ? { kind: 'choice', index: a.index as number } : null;
    }
    return null;
}

export function capReply(textBody: string): string {
    const t = textBody.trim();
    return t.length > REPLY_LIMIT ? `${t.slice(0, REPLY_LIMIT - 1)}…` : t;
}

/** The window a step's target lives in, from the anchors of its drawings. */
export function targetWindowRef(ids: string[], annotations: Annotation[]): string | undefined {
    for (const a of annotations) {
        if (!ids.includes(a.id) || !a.anchor) continue;
        const ref = a.anchor.kind === 'window' ? a.anchor.ref : a.anchor.selector?.window;
        if (ref) return ref;
    }
    return undefined;
}

// ------------------------------------------------- staying out of the way

/**
 * Overlays are raised above the panel, so a circle drawn where the panel sits
 * is drawn over the panel while the control it points at stays hidden under
 * it. Move the panel to a free corner while that is so, and back afterwards.
 *
 * Never while the user is using it: focused, holding unsent text, being
 * dragged, or under the pointer. A panel that jumps away from the cursor is
 * worse than one that covers a target.
 */
function reconsiderPlacement(): void {
    const win = hudWindow();
    if (!win || !home || !win.isVisible()) return;
    if (win.isFocused() || composing || Date.now() < draggingUntil) return;
    const area = screen.getDisplayMatching(home).workArea;
    const want = dodgePlacement(home, area, drawnRects());
    if (samePlacement(currentPlacement(win), want)) return;
    // Someone moving onto the unfocused panel is reaching for its buttons; a
    // panel that jumps away then sends their click into the app underneath.
    // Hold still, and look again once the pointer has moved off.
    if (pointerNear(win.getBounds(), screen.getCursorScreenPoint())) {
        if (!pointerRecheck) {
            pointerRecheck = setTimeout(() => {
                pointerRecheck = null;
                reconsiderPlacement();
            }, POINTER_RECHECK_MS);
            pointerRecheck.unref?.();
        }
        return;
    }
    place(want);
}

/** Whether a point is on a rect or within reach of it. */
export function pointerNear(bounds: Rect, p: { x: number; y: number }, slack = POINTER_SLACK): boolean {
    return (
        p.x >= bounds.x - slack &&
        p.x <= bounds.x + bounds.width + slack &&
        p.y >= bounds.y - slack &&
        p.y <= bounds.y + bounds.height + slack
    );
}

type Placement = { bounds: Rect; collapsed: boolean };

function currentPlacement(win: BrowserWindow): Placement {
    return placed ?? { bounds: win.getBounds(), collapsed: false };
}

function samePlacement(a: Placement, b: Placement): boolean {
    return a.collapsed === b.collapsed && sameRect(a.bounds, b.bounds);
}

function place(want: Placement): void {
    const win = hudWindow();
    if (!win) return;
    const current = currentPlacement(win);
    if (samePlacement(current, want)) return;
    selfMoveUntil = Date.now() + 600;
    if (want.collapsed !== current.collapsed) {
        win.setMinimumSize(want.collapsed ? PILL.width : 320, want.collapsed ? PILL.height : 260);
        send('hud:collapsed', want.collapsed);
    }
    win.setBounds(want.bounds, true);
    placed = want;
}

function userPlaced(): void {
    draggingUntil = 0;
    if (Date.now() < selfMoveUntil) return;
    const win = hudWindow();
    // A dragged pill is still a pill; the panel returns to where it was put.
    if (!win || placed?.collapsed) return;
    home = win.getBounds();
    placed = { bounds: home, collapsed: false };
}

/** Everything visibly drawn, in global DIPs. */
function drawnRects(): Rect[] {
    const origin = new Map(listDisplays().map(d => [d.id, d.dipBounds]));
    const out: Rect[] = [];
    for (const a of store.list()) {
        // Hidden and off-screen drawings are not on screen; stale ones are
        // faded leftovers; the check mark is gone within a second.
        if (a.hidden || a.offscreen || a.stale || a.type === 'done') continue;
        const o = origin.get(a.displayId);
        if (!o) continue;
        let r = a.rect;
        if (a.to) {
            const x = Math.min(r.x, a.to.x);
            const y = Math.min(r.y, a.to.y);
            r = {
                x,
                y,
                width: Math.max(r.x + r.width, a.to.x) - x,
                height: Math.max(r.y + r.height, a.to.y) - y
            };
        }
        out.push({ x: r.x + o.x, y: r.y + o.y, width: r.width, height: r.height });
    }
    return out;
}

/**
 * Where the panel should be: at `home` unless something drawn is under it,
 * else the nearest corner of the work area that is clear, else collapsed to a
 * pill at home's outer corner. Pure, so the rules are testable.
 */
export function dodgePlacement(home: Rect, area: Rect, drawn: Rect[]): { bounds: Rect; collapsed: boolean } {
    const blocked = (r: Rect): boolean => drawn.some(d => intersects(inflate(r, DODGE_SLACK), d));
    if (!blocked(home)) return { bounds: home, collapsed: false };

    const { width, height } = home;
    const left = area.x + MARGIN;
    const right = area.x + area.width - width - MARGIN;
    const top = area.y + MARGIN;
    const bottom = area.y + area.height - height - MARGIN;
    const corners: Rect[] = [
        { x: right, y: bottom, width, height },
        { x: left, y: bottom, width, height },
        { x: right, y: top, width, height },
        { x: left, y: top, width, height }
    ];
    const distance = (r: Rect): number => Math.hypot(r.x - home.x, r.y - home.y);
    const free = corners.filter(c => !blocked(c)).sort((a, b) => distance(a) - distance(b))[0];
    if (free) return { bounds: free, collapsed: false };

    // Keep the pill on home's side of the screen, at its outer corner.
    const midX = area.x + area.width / 2;
    const midY = area.y + area.height / 2;
    const x = home.x + home.width / 2 >= midX ? home.x + home.width - PILL.width : home.x;
    const y = home.y + home.height / 2 >= midY ? home.y + home.height - PILL.height : home.y;
    return { bounds: { x, y, ...PILL }, collapsed: true };
}

function inflate(r: Rect, by: number): Rect {
    return { x: r.x - by, y: r.y - by, width: r.width + 2 * by, height: r.height + 2 * by };
}

function intersects(a: Rect, b: Rect): boolean {
    return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

function sameRect(a: Rect, b: Rect): boolean {
    return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}
