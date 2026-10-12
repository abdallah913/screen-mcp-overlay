import type { ClickResult, StepAnswer, StepView, UserAnswer } from '../shared/types.js';
import { parseProgress } from '../shared/progress.js';
import { store } from './store.js';

/**
 * The step the user is being asked to take, and every way it can end.
 *
 * There is one pending step at a time, shared by every client: a click request
 * (wait_for_user_click), a watched step (highlight_and_wait with until), or a
 * multiple-choice question (show_message with options). The overlay strip, the
 * panel card and the global hotkeys all answer it through answerStep(), so a
 * user can say "done", "I can't find it" or "skip" to an agent running in a
 * terminal, which has no other way to hear them while a tool call blocks.
 *
 * A step always resolves, never rejects. Escape, silence, a typed reply and a
 * client that went away are answers for the agent to act on, not errors to
 * retry; reporting them as errors made models repeat the same instruction to a
 * user who had just said no.
 */

export interface StepRequest {
    prompt: string;
    mode: StepView['mode'];
    /** Click mode: how many points to collect. */
    count?: number;
    /** Choice mode: the buttons. */
    options?: string[];
    /** Click mode: map click coordinates back into this capture. */
    captureId?: string;
    timeoutMs: number;
    /**
     * The MCP request's abort signal. It fires when the client cancels the tool
     * call (Esc in Claude Code, Stop in the panel) or its connection drops, and
     * the step then ends instead of holding the screen until it times out.
     */
    signal?: AbortSignal;
    /** Annotations marking the step's target, so the UI can dock out of their way. */
    targetIds?: string[];
    progress?: { n: number; of: number };
    /** What is circled and where, for the panel card and log. */
    target?: string;
    /** The app's own question (asking to share a window), not an agent's. */
    fromApp?: boolean;
}

// ------------------------------------------------------------ the app's voice

/**
 * The app asks the user to share windows, and an agent must not be able to ask
 * in its place. What tells them apart is structural: the app's own steps carry
 * fromApp, and the panel card and overlay strip mark those with a badge that
 * no text can draw. The wording is a second line: an agent's words that use
 * the app's name are labelled as the agent's wherever the user meets them.
 */
export const APP_VOICE = 'Screen MCP Overlay';

const AGENT_SAYS = 'The agent says: ';

/** About this much of an agent's words is quoted in one of the app's own lines. */
const QUOTE_CHARS = 60;

/** Take no space on screen, or reorder what follows: zero-width characters, direction controls, soft hyphens and the like. */
const UNSEEN = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;
/** Shown right to left from here: text checked in one order would be read in another. */
const DIRECTION = /\p{Bidi_Control}/gu;
/** Line breaks and other control characters. */
const BREAKS = /[\p{Cc}\p{Zl}\p{Zp}]/gu;
/**
 * Anything that reads as a quotation mark; two single ones side by side pass
 * for a double. Unicode's own list (CJK corner brackets and fullwidth marks
 * among them) and every opening or closing punctuation mark, plus the primes,
 * modifier letters and ornaments that look like one.
 */
const QUOTE_MARKS = /[\p{Quotation_Mark}\p{Pi}\p{Pf}`´″‶′‵ʹʺʻʼʽ˝ˮ״׳❛❜❝❞❟❠🙶🙷🙸]+/gu;

/**
 * Letters that pass for Latin ones on screen (Cyrillic, Greek, Armenian,
 * Cherokee, small capitals), and the capital I, digits and bar that pass for
 * l and o, each as look-alike=letter. Escaped, as most of them look exactly
 * like what they stand for.
 */
const LOOKALIKES = new Map(
    [
        // Cyrillic
        '\u0410=a \u0412=b \u0415=e \u0405=s \u0406=l \u0408=j \u041a=k \u041c=m \u041d=h \u041e=o \u0420=p \u0421=c \u0422=t',
        '\u0423=y \u0425=x \u0474=v \u04ae=y \u04ba=h \u04c0=l \u051a=q \u051c=w \u0430=a \u0432=b \u0433=r \u0435=e \u0455=s',
        '\u0456=i \u0458=j \u043a=k \u043c=m \u043d=h \u043e=o \u043f=n \u0440=p \u0441=c \u0442=t \u0443=y \u0445=x \u0475=v',
        '\u04af=y \u04bb=h \u04cf=l \u0501=d \u051b=q \u051d=w',
        // Greek
        '\u0391=a \u0392=b \u0395=e \u0396=z \u0397=h \u0399=l \u039a=k \u039c=m \u039d=n \u039f=o \u03a1=p \u03a4=t \u03a5=y',
        '\u03a7=x \u03b1=a \u03b3=y \u03b5=e \u03b7=n \u03b9=i \u03ba=k \u03bd=v \u03bf=o \u03c1=p \u03c4=t \u03c5=u \u03c7=x',
        '\u03f2=c \u03f9=c \u03f3=j',
        // Armenian
        '\u0555=o \u0585=o \u054d=u \u057d=u \u0578=n \u0581=g \u0570=h',
        // Cherokee
        '\u13aa=a \u13f4=b \u13df=c \u13ac=e \u13bb=h \u13ab=j \u13e6=k \u13de=l \u13b7=m \u13eb=o \u13e2=p \u13a1=r \u13da=s',
        '\u13a2=t \u13d9=v \u13b3=w \u13a0=d \u13a5=i \u13c3=z \u13a9=y \u13c0=g',
        // Latin small capitals and dotless letters
        '\u1d00=a \u0299=b \u1d04=c \u1d05=d \u1d07=e \u0262=g \u029c=h \u026a=i \u1d0a=j \u1d0b=k \u029f=l \u1d0d=m \u0274=n',
        '\u1d0f=o \u1d18=p \u0280=r \ua731=s \u1d1b=t \u1d1c=u \u1d20=v \u1d21=w \u028f=y \u1d22=z \u0131=i \u0237=j \u0251=a',
        '\u0261=g',
        // Latin and digits: I, 1 and | for l, 0 for o
        'I=l 1=l |=l 0=o'
    ]
        .join(' ')
        .split(' ')
        .map(pair => pair.split('=') as [string, string])
);

/**
 * Text reduced to what it looks like: compatibility forms (fullwidth, maths
 * letters) folded, invisible characters and accents dropped, look-alikes
 * mapped to the Latin letter they pass for, case ignored, and only letters
 * and digits kept, so neither spacing nor punctuation can split a name.
 */
function looksLike(text: string): string {
    return [...text.normalize('NFKC').replace(UNSEEN, '').normalize('NFD').replace(/\p{M}/gu, '')]
        .map(ch => LOOKALIKES.get(ch) ?? ch)
        .join('')
        .toLowerCase()
        .replace(/rn/g, 'm')
        .replace(/[^a-z0-9]/g, '');
}

/** The names the user knows the app by: its own, and the panel's title. */
const APP_NAMES = [APP_VOICE, 'Screen Overlay'].map(looksLike);

/** Whether the text, as it shows, uses one of the app's names anywhere. */
function namesApp(text: string): boolean {
    const seen = looksLike(text);
    return APP_NAMES.some(name => seen.includes(name));
}

/**
 * An agent's words as the user is to meet them: in a step, a panel line, a
 * button, the voice or a caption on screen. Direction controls go, so the
 * text reads in the order it was checked in. Words that use the app's name
 * anywhere are labelled as the agent's and run onto one line, so no line of
 * them starts as the app; a walkthrough's "n/N" stays in front of the label
 * for the progress pill. Everything else is left as written.
 */
export function asAgentText(text: string): string {
    const shown = String(text).replace(DIRECTION, '');
    if (!namesApp(shown)) return shown;
    const flat = shown.replace(BREAKS, ' ').replace(UNSEEN, '').replace(/\s+/g, ' ').trim();
    const progress = parseProgress(flat);
    const lead = progress ? `${progress.n}/${progress.of} ` : '';
    const rest = progress ? progress.rest : flat;
    return rest.startsWith(AGENT_SAYS) ? `${lead}${rest}` : `${lead}${AGENT_SAYS}${rest}`;
}

/**
 * Text quoted inside one of the app's own lines: one line, nothing invisible,
 * no quotation marks of its own (so it cannot close the quote and carry on as
 * the app), and cut to `max` characters.
 */
export function flatText(text: string, max: number): string {
    const flat = String(text)
        .replace(BREAKS, ' ')
        .replace(UNSEEN, '')
        .replace(QUOTE_MARKS, "'")
        .replace(/\s+/g, ' ')
        .trim();
    const chars = [...flat];
    return chars.length > max ? `${chars.slice(0, max - 1).join('').trimEnd()}…` : flat;
}

/**
 * An agent's words quoted in one of the app's own lines (a refusal, a step
 * replaced): “flattened and short”, or `instead` when they use the app's
 * name, as the app's line would then carry the app's name twice, once in
 * words it did not write. '' when nothing visible is left.
 */
export function quoteAgentText(text: string, instead: string, max = QUOTE_CHARS): string {
    const whole = flatText(text, Infinity);
    if (!whole) return '';
    return namesApp(whole) ? instead : `“${flatText(whole, max)}”`;
}

export interface StepHandle {
    id: string;
    /** Resolves when the step ends, however it ends. Never rejects. */
    answer: Promise<StepAnswer>;
    /**
     * End the step from the tool's side, e.g. because the awaited UI state
     * arrived. `answer` then resolves with `{kind: 'ended'}`. No-op if the step
     * already ended.
     */
    end(): void;
}

interface Pending {
    view: StepView;
    /** The options as the agent gave them, which is what it hears back; the view's may be labelled. */
    options?: string[];
    captureId?: string;
    got: ClickResult[];
    resolve: (a: StepAnswer) => void;
    timer: NodeJS.Timeout;
    signal?: AbortSignal;
    onAbort?: () => void;
}

let pending: Pending | null = null;

type EndedListener = (view: StepView, answer: StepAnswer) => void;
const endedListeners = new Set<EndedListener>();

/**
 * Hear how each step ended. The store's 'step' event only says that the step
 * went away; the panel needs the answer too, to log the outcome next to the
 * instruction and to say when a step was replaced or stopped.
 */
export function onStepEnded(listener: EndedListener): () => void {
    endedListeners.add(listener);
    return () => endedListeners.delete(listener);
}

/** Labels for the keys that answer a step; set by whoever registers them. */
let keys: StepView['keys'] = {};

export function setStepKeys(next: StepView['keys']): void {
    keys = next;
    if (pending) {
        pending.view.keys = keys;
        publish();
    }
}

/**
 * Put the step (or its absence) in the store. The store records it before its
 * 'step' listeners (the tray, the panel, the step keys) run, so one that throws
 * has not stopped the step from starting or ending; letting the throw through
 * would turn a broken menu into a tool error, or an answer the agent never gets.
 */
function publish(): void {
    try {
        store.setStep(pending ? { ...pending.view, collected: pending.got.length } : null);
    } catch {
        // Only a listener failed; the step itself is published.
    }
}

function settle(p: Pending, answer: StepAnswer): void {
    if (pending !== p) return;
    pending = null;
    clearTimeout(p.timer);
    if (p.onAbort) p.signal?.removeEventListener('abort', p.onAbort);
    // The answer goes to the agent before anything else runs.
    p.resolve(answer);
    publish();
    const view = { ...p.view, collected: p.got.length };
    for (const listener of endedListeners) {
        try {
            listener(view, answer);
        } catch {
            // A broken panel must not stop the answer reaching the agent.
        }
    }
}

/**
 * Start a step. A step already pending is superseded: it resolves as
 * `cancelled by superseded`, because the newest instruction is the one on
 * screen and two clients share one overlay.
 */
export function beginStep(req: StepRequest): StepHandle {
    if (pending) settle(pending, { kind: 'cancelled', by: 'superseded', partial: pending.got });

    const id = store.nextId('step');
    const now = Date.now();
    let resolve!: (a: StepAnswer) => void;
    const answer = new Promise<StepAnswer>(r => (resolve = r));

    const p: Pending = {
        view: {
            id,
            prompt: req.fromApp ? req.prompt : asAgentText(req.prompt),
            mode: req.mode,
            count: req.mode === 'click' ? Math.max(1, req.count ?? 1) : 0,
            collected: 0,
            // A button is the agent's words too, and one can read as the
            // app's answer to its own question.
            options: req.fromApp ? req.options : req.options?.map(asAgentText),
            fromApp: req.fromApp === true,
            startedAt: now,
            deadline: now + req.timeoutMs,
            progress: req.progress,
            target: req.target,
            targetIds: req.targetIds ?? [],
            keys
        },
        options: req.options,
        captureId: req.captureId,
        got: [],
        resolve,
        timer: setTimeout(() => settle(p, { kind: 'timeout', partial: p.got }), req.timeoutMs),
        signal: req.signal
    };
    p.timer.unref?.();
    pending = p;

    if (req.signal) {
        if (req.signal.aborted) {
            settle(p, { kind: 'cancelled', by: 'client', partial: [] });
        } else {
            p.onAbort = () => settle(p, { kind: 'cancelled', by: 'client', partial: p.got });
            req.signal.addEventListener('abort', p.onAbort, { once: true });
        }
    }
    if (pending === p) publish();

    return {
        id,
        answer,
        end: () => settle(p, { kind: 'ended' })
    };
}

/**
 * Answer the pending step from the user's side. `id` guards against answering a
 * newer step with a click meant for an older one. Returns whether it applied.
 */
export function answerStep(answer: UserAnswer, id?: string): boolean {
    const p = pending;
    if (!p || (id !== undefined && id !== p.view.id)) return false;
    switch (answer.kind) {
        case 'choice': {
            const label = p.options?.[answer.index];
            if (label === undefined) return false;
            settle(p, { kind: 'choice', index: answer.index, label });
            return true;
        }
        case 'stuck':
            settle(p, { kind: 'stuck', text: answer.text?.trim() || undefined });
            return true;
        case 'reply': {
            const text = answer.text.trim();
            if (!text) return false;
            settle(p, { kind: 'reply', text });
            return true;
        }
        default:
            settle(p, answer);
            return true;
    }
}

/** A click from the overlay, for a click-mode step. Returns whether it was used. */
export function addClick(result: ClickResult): boolean {
    const p = pending;
    if (!p || p.view.mode !== 'click') return false;
    p.got.push(result);
    if (p.got.length >= p.view.count) settle(p, { kind: 'clicks', clicks: p.got, complete: true });
    else publish();
    return true;
}

/**
 * End the pending step on the user's behalf: Escape, or "clear everything".
 * Clicks already collected are kept in the answer.
 */
export function cancelStep(by: 'esc' | 'clear'): boolean {
    const p = pending;
    if (!p) return false;
    settle(p, { kind: 'cancelled', by, partial: p.got });
    return true;
}

export function currentStep(): StepView | null {
    return pending ? { ...pending.view, collected: pending.got.length } : null;
}

/** The capture a click-mode step maps clicks into, if any. */
export function currentCaptureId(): string | undefined {
    return pending?.captureId;
}

/** The subset of Electron's globalShortcut that step keys need. */
export interface ShortcutApi {
    register(accelerator: string, callback: () => void): boolean;
    unregister(accelerator: string): void;
    isRegistered(accelerator: string): boolean;
}

/**
 * Global keys that answer the pending step, held only while one is pending.
 *
 * The user is in the target app during a step, so a "done" or "I'm stuck" key
 * is the only way to answer without reaching for the mouse or a terminal. Held
 * permanently, though, the chords would be stolen from every other app on the
 * machine, so they are registered when a step starts and released when it ends.
 *
 * Escape is taken in click mode only. In watch mode the user is operating their
 * app, where Escape closes the menu or dialog the step is about.
 *
 * Registration can fail (another app owns the chord, or the setting is not a
 * valid accelerator), so only keys that actually registered are published for
 * the UI to show: a hint for a key that does nothing is worse than none.
 * Returns a function that stops listening and releases everything.
 */
export function bindStepKeys(api: ShortcutApi, chords: () => { done: string; stuck: string }): () => void {
    let boundFor: string | null = null;
    let held: string[] = [];

    const release = (): void => {
        for (const accel of held) {
            try {
                api.unregister(accel);
            } catch {
                // Already gone; nothing to release.
            }
        }
        held = [];
    };

    const take = (accel: string, fn: () => void): boolean => {
        // The chords come from a hand-editable file; a null there must
        // disable the key, not throw out of the step's publication.
        if (typeof accel !== 'string' || !accel.trim()) return false;
        try {
            // Never take over one of our own chords: a setting equal to
            // Ctrl+Shift+X would otherwise silently replace the panic button.
            if (api.isRegistered(accel) || !api.register(accel, fn)) return false;
        } catch {
            return false;
        }
        held.push(accel);
        return true;
    };

    const sync = (): void => {
        const step = store.getStep();
        const id = step?.id ?? null;
        // setStepKeys republishes the step, which lands back here; only a new
        // step, or the end of one, changes what is held.
        if (id === boundFor) return;
        release();
        boundFor = id;
        if (!step) {
            setStepKeys({});
            return;
        }
        const labels: StepView['keys'] = {};
        // Only a watched step is answered with done or stuck. A choice is
        // answered by picking an option, and a click step by pointing: "done"
        // there would end it without the point the agent asked for.
        if (step.mode === 'watch') {
            const { done, stuck } = chords();
            if (take(done, () => answerStep({ kind: 'done' }, step.id))) labels.done = keyLabel(done);
            if (take(stuck, () => answerStep({ kind: 'stuck' }, step.id))) labels.stuck = keyLabel(stuck);
        }
        if (step.mode === 'click' && take('Escape', () => cancelStep('esc'))) labels.cancel = 'Esc';
        setStepKeys(labels);
    };

    store.on('step', sync);
    sync();
    return () => {
        store.off('step', sync);
        release();
        boundFor = null;
    };
}

const KEY_NAMES: Record<string, string> = {
    control: 'Ctrl',
    ctrl: 'Ctrl',
    commandorcontrol: 'Ctrl',
    cmdorctrl: 'Ctrl',
    alt: 'Alt',
    option: 'Alt',
    altgr: 'AltGr',
    shift: 'Shift',
    super: 'Win',
    meta: 'Win',
    escape: 'Esc',
    esc: 'Esc'
};

/** "Control+Shift+F9" the way a Windows user reads it: "Ctrl+Shift+F9". */
export function keyLabel(accelerator: string): string {
    return accelerator
        .split('+')
        .map(part => part.trim())
        .filter(Boolean)
        .map(part => KEY_NAMES[part.toLowerCase()] ?? (part.length === 1 ? part.toUpperCase() : part))
        .join('+');
}
