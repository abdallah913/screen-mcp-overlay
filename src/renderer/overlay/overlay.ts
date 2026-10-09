import type { Annotation, Point, Rect, StepView, UserAnswer } from '../../shared/types.js';
import { DEFAULT_COLORS, textOn } from '../../shared/palette.js';
import { parseProgress } from '../../shared/progress.js';
import {
    captionMaxWidth,
    classify,
    dockStrip,
    edgeAnchor,
    edgeArrow,
    elsewhereText,
    inflate,
    nearestIsHere,
    offScreenText,
    opensDownward,
    placeCaptions,
    reportsHover,
    ringShape,
    shapeBounds,
    sideToward,
    stepBadge,
    stepCues,
    stripProgress,
    timeLeft,
    wrapText,
    centre,
    type CaptionRequest,
    type CuesHeard,
    type OverlayFrame
} from '../../shared/layout.js';

/**
 * The drawing surface. The window exactly covers one display in DIPs, so the
 * canvas CSS coordinate space *is* display-local DIPs and annotations arrive
 * ready to draw with no further conversion.
 *
 * Work is split by how often it changes. Where captions, pointers and the step
 * strip go is decided once per state change (layout); a frame only paints that
 * layout, and frames run only while an attention ping is animating.
 */

declare global {
    interface Window {
        overlayApi: {
            onState(cb: (s: OverlayFrame) => void): void;
            onPing(cb: (ids: string[]) => void): void;
            reportClick(stepId: string, displayId: string, dip: { x: number; y: number }): void;
            cancelClick(stepId: string): void;
            answer(id: string, answer: UserAnswer): void;
            hoverUi(over: boolean): void;
            stripRect(rect: Rect | null): void;
        };
    }
}

const api = window.overlayApi;
const canvas = document.getElementById('c') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const strip = document.getElementById('strip') as HTMLDivElement;
const stripProgressEl = document.getElementById('strip-progress') as HTMLSpanElement;
const stripText = document.getElementById('strip-text') as HTMLSpanElement;
const stripTime = document.getElementById('strip-time') as HTMLSpanElement;
const stripButtons = document.getElementById('strip-buttons') as HTMLSpanElement;
const stripHint = document.getElementById('strip-hint') as HTMLSpanElement;
const stripWait = document.getElementById('strip-wait') as HTMLDivElement;

let frame: OverlayFrame | null = null;
/** The pending click-mode step, if any. */
let click: StepView | null = null;
/** rAF handle while an animation is running; null when the canvas is static. */
let rafId: number | null = null;

const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
let reducedMotion = motionQuery.matches;

// ------------------------------------------------------------------ layout

interface CaptionContent {
    pill?: string;
    lines: string[];
    /** A second voice under the text: "behind Chrome", "scrolled out of view". */
    note?: string;
    color: string;
    /** Dashed border: the caption stands in for a target the user can't see right now. */
    dashed?: boolean;
    faded?: boolean;
}

interface PlacedCaption extends CaptionContent {
    box: Rect;
    leader?: [Point, Point];
}

interface EdgePointer {
    tip: Point;
    tail: Point;
    color: string;
    faded: boolean;
}

/** What this display draws, recomputed on every state change. */
let shapes: Annotation[] = [];
let captions: PlacedCaption[] = [];
let pointers: EdgePointer[] = [];
let badges = new Map<string, string>();
let stripBox: Rect | null = null;

const FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif';
const TEXT_FONT = `600 14px ${FONT}`;
const NOTE_FONT = `500 12px ${FONT}`;
const PILL_FONT = `700 12px ${FONT}`;
const PAD_X = 9;
const PAD_Y = 6;
const LINE_H = 18;
const NOTE_H = 16;
const PILL_PAD = 6;
const PILL_GAP = 6;
const BADGE_R = 15;

function measureWith(font: string): (s: string) => number {
    return s => {
        ctx.save();
        ctx.font = font;
        const w = ctx.measureText(s).width;
        ctx.restore();
        return w;
    };
}
const measureText = measureWith(TEXT_FONT);
const measureNote = measureWith(NOTE_FONT);
const measurePill = measureWith(PILL_FONT);

function pillWidth(pill: string | undefined): number {
    return pill ? measurePill(pill) + PILL_PAD * 2 + PILL_GAP : 0;
}

/**
 * Turn caption text into wrapped lines. An "n/N " prefix becomes a progress
 * pill. Wrapping keeps a 120-character prompt in a compact block next to its
 * target instead of an 850-DIP line running off the display.
 */
function captionContent(
    text: string | undefined,
    color: string,
    extra: Omit<CaptionContent, 'lines' | 'color' | 'pill'> = {}
): CaptionContent {
    const progress = text ? parseProgress(text) : null;
    const body = progress ? progress.rest : text ?? '';
    const pill = progress ? `${progress.n}/${progress.of}` : undefined;
    const max = captionMaxWidth(window.innerWidth) - PAD_X * 2;
    const lines = body ? wrapText(body, max - pillWidth(pill), measureText) : [];
    const note = extra.note ? wrapText(extra.note, max, measureNote, 1)[0] : undefined;
    return { ...extra, pill, lines, note, color };
}

function captionSize(c: CaptionContent): { width: number; height: number } {
    const textW = Math.max(0, ...c.lines.map((l, i) => measureText(l) + (i === 0 ? pillWidth(c.pill) : 0)));
    const pillOnly = c.lines.length === 0 ? pillWidth(c.pill) - PILL_GAP : 0;
    const noteW = c.note ? measureNote(c.note) : 0;
    const rows = Math.max(c.lines.length, c.pill ? 1 : 0);
    return {
        width: Math.ceil(Math.max(textW, pillOnly, noteW) + PAD_X * 2),
        height: PAD_Y * 2 + rows * LINE_H + (c.note ? NOTE_H : 0)
    };
}

function colorOf(a: Annotation): string {
    return a.color ?? DEFAULT_COLORS[a.type];
}

/** The ring's padding in DIPs: anchors carry it in physical pixels. */
function padOf(a: Annotation): number {
    return a.anchor ? a.anchor.pad / (window.devicePixelRatio || 1) : 8;
}

/** Things worth pointing at from another monitor: the step, not every leftover box. */
function wantsAttention(a: Annotation, targets: Set<string>): boolean {
    return !!a.pulse || a.type === 'step' || !!a.stepId || targets.has(a.id);
}

function pointerLabel(a: Annotation, textBody: string | undefined): string {
    if (textBody) return textBody;
    return a.anchor?.label ? a.anchor.label : 'The target';
}

function layout(): void {
    if (!frame) return;
    const view = { width: window.innerWidth, height: window.innerHeight };
    const targets = new Set(frame.step?.targetIds ?? []);
    const anns = frame.annotations;

    // Number steps by when they were drawn, for step shapes whose text is an instruction.
    const ordinal = new Map(
        anns
            .filter(a => a.type === 'step')
            .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id, undefined, { numeric: true }))
            .map((a, i) => [a.id, i + 1])
    );

    const placement = new Map(anns.map(a => [a.id, classify(shapeBounds(a), view, frame!.others)]));
    const here = anns.filter(a => placement.get(a.id) === 'here');
    const targetRects = here.filter(a => targets.has(a.id)).map(shapeBounds);
    const otherRects = here.filter(a => !targets.has(a.id) && a.type !== 'spotlight').map(shapeBounds);

    updateStrip(targetRects, [...otherRects, ...frame.exclude]);

    shapes = [];
    pointers = [];
    badges = new Map();
    const reqs: { req: CaptionRequest; content: CaptionContent; rank: number }[] = [];
    const obstacles: Rect[] = [...frame.exclude];
    if (stripBox) obstacles.push(inflate(stripBox, 6));

    const add = (req: Omit<CaptionRequest, 'size'>, content: CaptionContent, rank: number): void => {
        reqs.push({ req: { ...req, size: captionSize(content) }, content, rank });
    };

    for (const a of anns) {
        const where = placement.get(a.id);
        const color = colorOf(a);
        const faded = !!a.stale;
        const rank = targets.has(a.id) ? 1 : 2;
        let textBody = a.text;
        if (a.type === 'step') {
            const b = stepBadge(a.text, ordinal.get(a.id) ?? 1);
            badges.set(a.id, b.badge);
            textBody = b.caption;
        }
        const bounds = shapeBounds(a);

        if (where === 'off') {
            // Less than a quarter of it is on any display. Drawing it would show
            // nothing, so the display nearest to it points the way instead.
            if (a.type === 'spotlight' || !nearestIsHere(bounds, view, frame.others)) continue;
            const arrow = edgeArrow(bounds, view);
            pointers.push({ tip: arrow.tip, tail: arrow.tail, color, faded });
            const at = { x: arrow.tail.x - 4, y: arrow.tail.y - 4, width: 8, height: 8 };
            add(
                { id: a.id, target: at },
                captionContent(pointerLabel(a, textBody), color, {
                    note: offScreenText(arrow.side),
                    dashed: true,
                    faded
                }),
                rank
            );
            continue;
        }
        if (where !== 'here') continue;

        if (a.offscreen) {
            // Scrolled out of its list: the rect is real but whatever is drawn
            // there is unrelated UI. Say where it is instead of circling that.
            add(
                { id: a.id, target: clampedTo(bounds, view), mode: 'on' },
                captionContent(pointerLabel(a, textBody), color, {
                    note: '⇕ scrolled out of view: scroll to bring it up',
                    dashed: true,
                    faded
                }),
                rank
            );
            continue;
        }

        shapes.push(a);
        if (a.type === 'step') obstacles.push(badgeRect(a));
        if (a.type === 'arrow' && a.to) obstacles.push({ x: a.to.x - 10, y: a.to.y - 10, width: 20, height: 20 });

        const note = a.covered ? `behind “${a.covered}”` : undefined;
        if (!textBody && !note) continue;
        const content = captionContent(textBody, color, { note, faded });
        switch (a.type) {
            case 'label':
                add({ id: a.id, target: bounds, mode: 'above-point' }, content, 0);
                break;
            case 'arrow':
                // The text belongs to the arrow's tail: the arrow runs from the
                // words to the thing they describe.
                add({ id: a.id, target: { x: a.rect.x - 4, y: a.rect.y - 4, width: 8, height: 8 } }, content, rank);
                break;
            case 'step':
                add({ id: a.id, target: bounds, startInset: BADGE_R + 4 }, content, rank);
                break;
            default:
                add(
                    { id: a.id, target: bounds, opensDown: opensDownward(a.anchor?.selector?.role) },
                    content,
                    rank
                );
        }
    }

    // A monitor with nothing of the step on it says where the step is.
    if (here.length === 0) {
        const away = anns
            .filter(a => placement.get(a.id) === 'elsewhere' && wantsAttention(a, targets))
            .sort((a, b) => Number(targets.has(b.id)) - Number(targets.has(a.id)))[0];
        if (away) {
            const bounds = shapeBounds(away);
            const side = sideToward(centre(bounds), view);
            const p = edgeAnchor(bounds, view);
            add(
                { id: `${away.id}:elsewhere`, target: { x: p.x, y: p.y, width: 0, height: 0 }, mode: 'on' },
                captionContent(elsewhereText(side), colorOf(away)),
                3
            );
        }
    }

    // Labels keep their spot; then the current step's captions get first pick.
    reqs.sort((a, b) => a.rank - b.rank);
    const boxes = placeCaptions(reqs.map(r => r.req), view, obstacles);
    captions = boxes.map((b, i) => ({ ...reqs[i]!.content, box: b.box, leader: b.leader }));
}

function clampedTo(r: Rect, view: { width: number; height: number }): Rect {
    const c = centre(r);
    const x = Math.max(0, Math.min(c.x, view.width));
    const y = Math.max(0, Math.min(c.y, view.height));
    return { x: x - 1, y: y - 1, width: 2, height: 2 };
}

function badgeRect(a: Annotation): Rect {
    return { x: a.rect.x - BADGE_R, y: a.rect.y - BADGE_R, width: BADGE_R * 2, height: BADGE_R * 2 };
}

// --------------------------------------------------------------- step strip

let stripKey = '';
let stripTimer: number | null = null;
/** What we last told main about the pointer being over the strip; null: not known (see sendStrip). */
let hoverSent: boolean | null = false;
let stripSent: string | null = null;

function button(label: string, key: string | undefined, onClick: () => void, primary = false): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    if (primary) b.className = 'primary';
    if (key) {
        const k = document.createElement('kbd');
        k.textContent = key;
        b.append(k);
    }
    b.addEventListener('click', e => {
        e.stopPropagation();
        onClick();
    });
    return b;
}

function stepButtons(step: StepView): HTMLButtonElement[] {
    const answer = (a: UserAnswer) => () => api.answer(step.id, a);
    switch (step.mode) {
        case 'click':
            return [
                button('Cancel', step.keys.cancel ?? 'Esc', () => api.cancelClick(step.id)),
                button("Can't find it", step.keys.stuck, answer({ kind: 'stuck' }))
            ];
        case 'choice':
            return (step.options ?? []).map((o, index) => button(o, undefined, answer({ kind: 'choice', index }), index === 0));
        default:
            return [
                button('Done', step.keys.done, answer({ kind: 'done' }), true),
                button("Can't find it", step.keys.stuck, answer({ kind: 'stuck' })),
                button('Skip', undefined, answer({ kind: 'skip' }))
            ];
    }
}

/**
 * The step strip: the prompt, how far along the walkthrough is, the time left
 * and the buttons that answer the step, so a user can say "done", "I can't find
 * it" or "skip" even to an agent in a terminal. Shown where main says (the lead
 * display, or every display for a click with no target), docked away from the
 * step's target. While the target is hidden it also says what it is waiting
 * for, rather than the circle silently vanishing.
 */
function updateStrip(targetRects: Rect[], others: Rect[]): void {
    const step = frame?.step ?? null;
    if (!step || !frame?.showStrip) {
        strip.classList.remove('visible');
        stripBox = null;
        stripKey = '';
        if (stripTimer !== null) window.clearInterval(stripTimer);
        stripTimer = null;
        sendStrip(null);
        setHover(false);
        return;
    }

    const { progress, prompt } = stripProgress(step);
    stripProgressEl.textContent = progress ? `${progress.n}/${progress.of}` : '';
    const remaining = step.count - step.collected;
    stripText.textContent = step.mode === 'click' && step.count > 1 ? `${prompt}  (${remaining} more to click)` : prompt;
    stripHint.textContent = step.mode === 'click' ? "This click only points: the app won't get it." : '';
    stripWait.textContent = frame.waiting ?? '';

    const key = JSON.stringify([step.id, step.mode, step.options, step.keys]);
    if (key !== stripKey) {
        stripKey = key;
        stripButtons.replaceChildren(...stepButtons(step));
    }
    const tick = (): void => {
        stripTime.textContent = timeLeft(step.deadline, Date.now());
    };
    tick();
    if (stripTimer !== null) window.clearInterval(stripTimer);
    stripTimer = window.setInterval(tick, 1000);

    const r = strip.getBoundingClientRect();
    stripBox = dockStrip({ width: r.width, height: r.height }, frame.workArea, targetRects, others);
    strip.style.left = `${stripBox.x}px`;
    strip.style.top = `${stripBox.y}px`;
    strip.classList.add('visible');
    sendStrip(stripBox);
}

function sendStrip(rect: Rect | null): void {
    const key = rect ? `${rect.x},${rect.y},${rect.width},${rect.height}` : null;
    if (key === stripSent) return;
    stripSent = key;
    // Main hovers a strip that lands under a resting pointer by itself, so
    // what it believes may no longer be what we last said.
    hoverSent = null;
    api.stripRect(rect);
}

let hoverSentAt = 0;

/** Tell main whether the pointer is over the strip (see reportsHover). */
function setHover(over: boolean): void {
    const now = performance.now();
    if (!reportsHover(hoverSent, over, now - hoverSentAt)) return;
    hoverSent = over;
    hoverSentAt = now;
    api.hoverUi(over);
}

function overStrip(x: number, y: number): boolean {
    const b = stripBox;
    return !!b && x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height;
}

// The window is click-through but forwards mouse moves, so the strip can be
// hit-tested here; main then lets this one window take the mouse until the
// pointer leaves.
document.addEventListener('mousemove', e => setHover(overStrip(e.clientX, e.clientY)));
document.addEventListener('mouseleave', () => setHover(false));

// ------------------------------------------------------------- attention ping

/**
 * A pulsing shape is drawn steadily and pings: two rings expand and fade when
 * it first appears, when it comes back after being hidden, once it settles
 * after moving, and every 15 s while it stays. A pulse that never stopped
 * halved the ring's contrast every 1.6 s for the whole wait and kept the
 * renderer repainting at display refresh rate.
 */
const PING_MS = 1000;
const REPING_MS = 15000;
const SETTLE_MS = 300;

interface Tracked {
    rect: Rect;
    lastPing: number;
    settle: number | null;
}
const tracked = new Map<string, Tracked>();
const pings = new Map<string, number>();
let repingTimer: number | null = null;

function ping(id: string): void {
    if (reducedMotion) return;
    const now = performance.now();
    pings.set(id, now);
    const t = tracked.get(id);
    if (t) t.lastPing = now;
    scheduleReping();
    scheduleDraw();
}

function sameRect(a: Rect, b: Rect): boolean {
    return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function updatePings(): void {
    const live = new Set<string>();
    for (const a of shapes) {
        if (!a.pulse) continue;
        live.add(a.id);
        const t = tracked.get(a.id);
        if (!t) {
            tracked.set(a.id, { rect: a.rect, lastPing: 0, settle: null });
            ping(a.id);
        } else if (!sameRect(t.rect, a.rect)) {
            // Follow a dragged window silently; ping once it has stopped.
            t.rect = a.rect;
            if (t.settle !== null) window.clearTimeout(t.settle);
            t.settle = window.setTimeout(() => {
                t.settle = null;
                ping(a.id);
            }, SETTLE_MS);
        }
    }
    // Forgetting a shape that went away is what makes its return ping.
    for (const [id, t] of tracked) {
        if (live.has(id)) continue;
        if (t.settle !== null) window.clearTimeout(t.settle);
        tracked.delete(id);
        pings.delete(id);
    }
    scheduleReping();
}

const GLOW_MS = 1200;
/** Reduced-motion replays in progress: annotation id -> start. */
const glows = new Map<string, number>();

/**
 * Replay the ping on request (the panel's "Show me") for whichever of these
 * shapes this display draws. Reduced motion gets no expanding rings: the
 * shape's halo brightens and fades back once, in place, instead.
 */
function replay(ids: string[]): void {
    const drawn = new Set(shapes.map(a => a.id));
    for (const id of ids) {
        if (!drawn.has(id)) continue;
        if (reducedMotion) glows.set(id, performance.now());
        else ping(id);
    }
    scheduleDraw();
}

function scheduleReping(): void {
    if (repingTimer !== null) window.clearTimeout(repingTimer);
    repingTimer = null;
    if (tracked.size === 0 || reducedMotion) return;
    const next = Math.min(...[...tracked.values()].map(t => t.lastPing + REPING_MS));
    repingTimer = window.setTimeout(() => {
        repingTimer = null;
        const now = performance.now();
        for (const [id, t] of tracked) if (now >= t.lastPing + REPING_MS - 20) ping(id);
        scheduleReping();
    }, Math.max(50, next - performance.now()));
}

// ----------------------------------------------------------------- sound cues

let audio: AudioContext | null = null;
/** Null until this page's first frame, which only records what is on screen (see stepCues). */
let heard: CuesHeard | null = null;

/**
 * A short two-note cue: rising for "new step", higher for "done". Played by
 * the lead overlay only, or every monitor would chime at once.
 */
function tone(kind: 'start' | 'done'): void {
    try {
        audio ??= new AudioContext();
        const notes = kind === 'start' ? [660, 880] : [880, 1320];
        const t0 = audio.currentTime + 0.01;
        notes.forEach((hz, i) => {
            const osc = audio!.createOscillator();
            const gain = audio!.createGain();
            const at = t0 + i * 0.09;
            osc.type = 'sine';
            osc.frequency.value = hz;
            gain.gain.setValueAtTime(0, at);
            gain.gain.linearRampToValueAtTime(0.07, at + 0.012);
            gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.085);
            osc.connect(gain).connect(audio!.destination);
            osc.start(at);
            osc.stop(at + 0.09);
        });
    } catch {
        // No audio device: the cue is a nicety, never worth an error.
    }
}

function playCues(f: OverlayFrame): void {
    const cues = stepCues(heard, f);
    heard = cues.heard;
    if (cues.start) tone('start');
    if (cues.done) tone('done');
}

// ------------------------------------------------------------------- state

function scheduleDraw(): void {
    if (rafId !== null) return;
    rafId = requestAnimationFrame(function loop(now: number) {
        draw(now);
        rafId = needsAnimation(now) ? requestAnimationFrame(loop) : null;
    });
}

/**
 * Whether anything on screen actually changes between frames.
 *
 * A static overlay does not need repainting at 60fps, and repainting it anyway
 * cost about 5% of a core with nothing drawn. Only a running ping or glow
 * needs a loop.
 */
function needsAnimation(now: number): boolean {
    let running = false;
    for (const [id, start] of pings) {
        if (now - start < PING_MS) running = true;
        else pings.delete(id);
    }
    for (const [id, start] of glows) {
        if (now - start < GLOW_MS) running = true;
        else glows.delete(id);
    }
    return running;
}

function resize(): void {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    canvas.style.width = `${window.innerWidth}px`;
    canvas.style.height = `${window.innerHeight}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

window.addEventListener('resize', () => {
    resize();
    layout();
    scheduleDraw();
});
resize();

motionQuery.addEventListener('change', () => {
    reducedMotion = motionQuery.matches;
    if (reducedMotion) pings.clear();
    scheduleReping();
    scheduleDraw();
});

api.onPing(replay);

api.onState(state => {
    frame = state;
    const wasPicking = click !== null;
    click = state.step?.mode === 'click' ? state.step : null;
    if (wasPicking !== (click !== null)) document.body.classList.toggle('picking', click !== null);
    layout();
    updatePings();
    playCues(state);
    scheduleDraw();
});

window.addEventListener(
    'click',
    e => {
        if (!click || !frame) return;
        // A press on the strip's own buttons is an answer, not a point.
        if (strip.contains(e.target as Node)) return;
        e.preventDefault();
        api.reportClick(click.id, frame.displayId, { x: e.clientX, y: e.clientY });
    },
    true
);

window.addEventListener('keydown', e => {
    if (e.key === 'Escape' && click) api.cancelClick(click.id);
});

// ---------------------------------------------------------------- rendering

function draw(now: number): void {
    // Called from scheduleDraw only; it decides whether another frame follows.
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    drawScrim();
    for (const a of shapes) drawGlow(a, now);
    for (const a of shapes) drawShape(a);
    for (const a of shapes) drawPing(a, now);
    for (const p of pointers) drawPointer(p);
    // Captions last, at full opacity, so no later stroke paints over them.
    for (const c of captions) drawCaption(c);
}

/**
 * One scrim for every spotlight. Each spotlight used to paint its own
 * full-screen scrim and cut only its own hole, so only the last-drawn
 * spotlight was lit and earlier ones stayed dimmed at the full dim value. The
 * chat panel is cut out too: it is where the user types.
 */
function drawScrim(): void {
    const spots = shapes.filter(a => a.type === 'spotlight');
    if (spots.length === 0) return;
    const dim = Math.max(...spots.map(a => (a.dim ?? 0.6) * (a.stale ? 0.35 : 1)));
    ctx.save();
    ctx.fillStyle = `rgba(0,0,0,${dim})`;
    ctx.fillRect(0, 0, window.innerWidth, window.innerHeight);
    ctx.globalCompositeOperation = 'destination-out';
    for (const a of spots) {
        roundRect(a.rect.x, a.rect.y, a.rect.width, a.rect.height, 8);
        ctx.fill();
    }
    for (const r of frame?.exclude ?? []) ctx.fillRect(r.x, r.y, r.width, r.height);
    ctx.restore();

    for (const a of spots) {
        ctx.save();
        ctx.globalAlpha = a.stale ? 0.35 : 1;
        ctx.lineJoin = 'round';
        roundRect(a.rect.x, a.rect.y, a.rect.width, a.rect.height, 8);
        ctx.strokeStyle = 'rgba(0,0,0,0.5)';
        ctx.lineWidth = 4;
        ctx.stroke();
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.restore();
    }
}

/**
 * Stroke the current path three times: a dark band, a light band, then the
 * colour. One of the bands contrasts with any background, so a stroke shows up
 * on white dialogs, mid-grey chrome and accent-blue buttons alike, without
 * relying on hue.
 */
function haloStroke(width: number, color: string): void {
    ctx.lineWidth = width + 4;
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.stroke();
    ctx.lineWidth = width + 2;
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.stroke();
    ctx.lineWidth = width;
    ctx.strokeStyle = color;
    ctx.stroke();
}

/** Build the outline of a rect-like shape, grown by `grow` (for pings). */
function outlinePath(a: Annotation, grow = 0): void {
    const r = inflate(a.rect, grow);
    if (a.type === 'circle' || a.type === 'done') {
        const ring = ringShape(a.rect, padOf(a));
        if (ring.kind === 'rounded') {
            roundRect(r.x, r.y, r.width, r.height, ring.radius + grow);
        } else {
            ctx.beginPath();
            ctx.ellipse(r.x + r.width / 2, r.y + r.height / 2, Math.max(1, r.width / 2), Math.max(1, r.height / 2), 0, 0, Math.PI * 2);
        }
        return;
    }
    roundRect(r.x, r.y, r.width, r.height, (a.type === 'highlight' ? 4 : 6) + grow);
}

function drawShape(a: Annotation): void {
    const color = colorOf(a);
    let width = a.thickness ?? 3;
    ctx.save();
    // A covered target is drawn dashed and translucent, so the ring cannot be
    // read as pointing at the window in front of it; the caption names it.
    ctx.globalAlpha = (a.stale ? 0.35 : 1) * (a.covered ? 0.6 : 1);
    if (a.covered) ctx.setLineDash([8, 6]);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    // Reduced motion gets no rings, so a pulsing shape earns its attention
    // with weight instead: a heavier stroke and a soft outer band.
    const steadyEmphasis = a.pulse && reducedMotion && a.type !== 'arrow' && a.type !== 'label';
    if (steadyEmphasis) {
        width = Math.max(width, 5);
        outlinePath(a);
        ctx.save();
        ctx.globalAlpha *= 0.3;
        ctx.lineWidth = width + 12;
        ctx.strokeStyle = color;
        ctx.stroke();
        ctx.restore();
    }

    switch (a.type) {
        case 'box':
        case 'circle':
        case 'step':
            outlinePath(a);
            haloStroke(width, color);
            if (a.type === 'step') badge(badges.get(a.id) ?? '?', a.rect.x, a.rect.y, color);
            break;

        case 'highlight':
            outlinePath(a);
            ctx.save();
            ctx.globalAlpha *= 0.28;
            ctx.fillStyle = color;
            ctx.fill();
            ctx.restore();
            haloStroke(2, color);
            break;

        case 'arrow':
            if (a.to) arrow(a.rect.x, a.rect.y, a.to.x, a.to.y, width, color);
            break;

        case 'done':
            outlinePath(a);
            haloStroke(2.5, color);
            check(a.rect, color);
            break;
    }
    ctx.restore();
}

function drawPing(a: Annotation, now: number): void {
    const start = pings.get(a.id);
    if (start === undefined || a.type === 'arrow' || a.type === 'label') return;
    const t = (now - start) / PING_MS;
    if (t >= 1) return;
    ctx.save();
    ctx.strokeStyle = colorOf(a);
    ctx.lineWidth = 3;
    for (const delay of [0, 0.3]) {
        const p = (t - delay) / 0.7;
        if (p <= 0 || p >= 1) continue;
        ctx.globalAlpha = (1 - p) * 0.85;
        outlinePath(a, 4 + p * 26);
        ctx.stroke();
    }
    ctx.restore();
}

/** The reduced-motion replay: a wide band behind the outline, up and back down once. */
function drawGlow(a: Annotation, now: number): void {
    const start = glows.get(a.id);
    if (start === undefined || a.type === 'arrow' || a.type === 'label') return;
    const t = (now - start) / GLOW_MS;
    if (t >= 1) return;
    ctx.save();
    ctx.globalAlpha = Math.sin(Math.PI * t) * 0.5;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = colorOf(a);
    ctx.lineWidth = 18;
    outlinePath(a, 4);
    ctx.stroke();
    ctx.restore();
}

function drawPointer(p: EdgePointer): void {
    ctx.save();
    ctx.globalAlpha = p.faded ? 0.35 : 1;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    arrow(p.tail.x, p.tail.y, p.tip.x, p.tip.y, 4, p.color);
    ctx.restore();
}

function roundRect(x: number, y: number, w: number, h: number, r: number): void {
    const rad = Math.max(0, Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2));
    ctx.beginPath();
    ctx.moveTo(x + rad, y);
    ctx.arcTo(x + w, y, x + w, y + h, rad);
    ctx.arcTo(x + w, y + h, x, y + h, rad);
    ctx.arcTo(x, y + h, x, y, rad);
    ctx.arcTo(x, y, x + w, y, rad);
    ctx.closePath();
}

function arrow(x1: number, y1: number, x2: number, y2: number, thickness: number, color: string): void {
    const head = Math.max(10, thickness * 4);
    const angle = Math.atan2(y2 - y1, x2 - x1);
    // Stop the shaft short so it does not poke through the head.
    const shaftX = x2 - Math.cos(angle) * head * 0.7;
    const shaftY = y2 - Math.sin(angle) * head * 0.7;

    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(shaftX, shaftY);
    haloStroke(thickness, color);

    // The head is filled, so its halo is a stroke of the bands before the fill.
    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - head * Math.cos(angle - Math.PI / 7), y2 - head * Math.sin(angle - Math.PI / 7));
    ctx.lineTo(x2 - head * Math.cos(angle + Math.PI / 7), y2 - head * Math.sin(angle + Math.PI / 7));
    ctx.closePath();
    ctx.setLineDash([]);
    ctx.lineWidth = 5;
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.stroke();
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.fill();
}

/** The confirmation tick that replaces a met step's circle for a moment. */
function check(r: Rect, color: string): void {
    const s = Math.max(18, Math.min(44, Math.min(r.width, r.height) * 0.5));
    const c = centre(r);
    ctx.beginPath();
    ctx.moveTo(c.x - s * 0.5, c.y);
    ctx.lineTo(c.x - s * 0.15, c.y + s * 0.35);
    ctx.lineTo(c.x + s * 0.55, c.y - s * 0.4);
    ctx.setLineDash([]);
    haloStroke(Math.max(4, s * 0.16), color);
}

/** A canvas-normalised form of any CSS colour, so its luminance can be read. */
function normalised(color: string): string {
    ctx.save();
    ctx.fillStyle = '#000';
    ctx.fillStyle = color;
    const v = String(ctx.fillStyle);
    ctx.restore();
    return v;
}

/** Numbered circle pinned to a step box's top-left corner. */
function badge(label: string, x: number, y: number, color: string): void {
    ctx.save();
    ctx.setLineDash([]);
    ctx.shadowColor = 'rgba(0,0,0,0.5)';
    ctx.shadowBlur = 8;
    ctx.beginPath();
    ctx.arc(x, y, BADGE_R, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = textOn(normalised(color));
    ctx.font = `700 ${label.length >= 3 ? 11 : 15}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, x, y + 0.5);
    ctx.restore();
}

/** A readable text chip at its laid-out box, with a leader back to its target when it had to move away. */
function drawCaption(c: PlacedCaption): void {
    const { box } = c;
    ctx.save();
    // Always full opacity unless the drawing is stale: the instruction itself
    // must never fade with a shape's animation.
    ctx.globalAlpha = c.faded ? 0.35 : 1;

    if (c.leader) {
        const [from, to] = c.leader;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(from.x, from.y);
        ctx.lineTo(to.x, to.y);
        haloStroke(1.5, c.color);
        ctx.beginPath();
        ctx.arc(to.x, to.y, 3, 0, Math.PI * 2);
        ctx.fillStyle = c.color;
        ctx.fill();
    }

    ctx.shadowColor = 'rgba(0,0,0,0.5)';
    ctx.shadowBlur = 8;
    ctx.fillStyle = 'rgba(20,20,22,0.92)';
    roundRect(box.x, box.y, box.width, box.height, 6);
    ctx.fill();
    ctx.shadowBlur = 0;

    ctx.strokeStyle = c.color;
    ctx.lineWidth = 1.5;
    if (c.dashed) ctx.setLineDash([5, 4]);
    roundRect(box.x, box.y, box.width, box.height, 6);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.textBaseline = 'middle';
    let x = box.x + PAD_X;
    let y = box.y + PAD_Y + LINE_H / 2;
    if (c.pill) {
        ctx.font = PILL_FONT;
        const w = ctx.measureText(c.pill).width + PILL_PAD * 2;
        ctx.fillStyle = c.color;
        roundRect(x, y - 8, w, 16, 8);
        ctx.fill();
        ctx.fillStyle = textOn(normalised(c.color));
        ctx.fillText(c.pill, x + PILL_PAD, y + 0.5);
        x += w + PILL_GAP;
    }
    ctx.font = TEXT_FONT;
    ctx.fillStyle = '#f5f5f7';
    for (const [i, line] of c.lines.entries()) {
        ctx.fillText(line, i === 0 ? x : box.x + PAD_X, y + 0.5);
        y += LINE_H;
    }
    if (c.lines.length === 0 && c.pill) y += LINE_H;
    if (c.note) {
        ctx.font = NOTE_FONT;
        ctx.fillStyle = '#ffd60a';
        ctx.fillText(c.note, box.x + PAD_X, y - LINE_H / 2 + NOTE_H / 2 + 0.5);
    }
    ctx.restore();
}

scheduleDraw();
