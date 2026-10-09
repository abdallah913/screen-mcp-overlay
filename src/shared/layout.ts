import type { Annotation, OverlayState, Point, Rect, Size, StepView, UserAnswer } from './types.js';
import { parseProgress } from './progress.js';

/**
 * Where the overlay puts things: captions, the step strip, edge pointers, the
 * shape of a ring. Pure geometry, so it is tested without a window; the
 * renderer measures text and hands sizes in, and draws whatever comes back.
 *
 * Every rectangle here is in one display's local DIPs, the overlay canvas's
 * own coordinate space.
 */

/**
 * What an overlay window is sent: the shared OverlayState plus what one
 * display needs to know about the others.
 */
export interface OverlayFrame extends OverlayState {
    /** The other displays, in this display's local DIPs, to point at what is drawn on them. */
    others: Rect[];
    /** This display minus its taskbar, local DIPs: where the step strip may dock. */
    workArea: Rect;
    /**
     * This overlay plays the step's sound cues: the display holding the step's
     * target, else the primary. One display only, or every monitor chimes at once.
     */
    lead: boolean;
    /** This overlay shows the step strip (see showsStrip). */
    showStrip: boolean;
    /** The step's targets are all hidden: what the strip says it is waiting for. */
    waiting?: string;
}

// ------------------------------------------------------------------ rects

export function intersection(a: Rect, b: Rect): Rect | null {
    const x = Math.max(a.x, b.x);
    const y = Math.max(a.y, b.y);
    const r = Math.min(a.x + a.width, b.x + b.width);
    const bt = Math.min(a.y + a.height, b.y + b.height);
    return r > x && bt > y ? { x, y, width: r - x, height: bt - y } : null;
}

export function overlapArea(a: Rect, b: Rect): number {
    const i = intersection(a, b);
    return i ? i.width * i.height : 0;
}

export function inflate(r: Rect, by: number): Rect {
    return { x: r.x - by, y: r.y - by, width: r.width + by * 2, height: r.height + by * 2 };
}

export function centre(r: Rect): Point {
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

function contains(r: Rect, p: Point): boolean {
    return p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;
}

/** Shortest distance between two rectangles; 0 when they touch or overlap. */
export function gap(a: Rect, b: Rect): number {
    const dx = Math.max(0, b.x - (a.x + a.width), a.x - (b.x + b.width));
    const dy = Math.max(0, b.y - (a.y + a.height), a.y - (b.y + b.height));
    return Math.hypot(dx, dy);
}

function clampPoint(p: Point, r: Rect): Point {
    return {
        x: Math.max(r.x, Math.min(p.x, r.x + r.width)),
        y: Math.max(r.y, Math.min(p.y, r.y + r.height))
    };
}

/** Move a box inside `view` (shrinking nothing), keeping `margin` from its edges. */
function clampBox(b: Rect, view: Rect, margin: number): Rect {
    const x = Math.max(view.x + margin, Math.min(b.x, view.x + view.width - b.width - margin));
    const y = Math.max(view.y + margin, Math.min(b.y, view.y + view.height - b.height - margin));
    return { ...b, x, y };
}

// ---------------------------------------------------------------- routing

/**
 * The area a shape occupies. An arrow spans its tail and head, at least 1 DIP
 * thick: a level or upright one would otherwise have no area, read as a point
 * at its tail, and not be drawn on the display its head crosses onto. A label
 * is a point, its text placed separately.
 */
export function shapeBounds(a: Annotation): Rect {
    if (a.type === 'arrow' && a.to) {
        const x = Math.min(a.rect.x, a.to.x);
        const y = Math.min(a.rect.y, a.to.y);
        return { x, y, width: Math.max(1, Math.abs(a.to.x - a.rect.x)), height: Math.max(1, Math.abs(a.to.y - a.rect.y)) };
    }
    if (a.type === 'label') return { x: a.rect.x, y: a.rect.y, width: 0, height: 0 };
    return a.rect;
}

/**
 * Re-express annotations, each stored relative to its home display, in one
 * display's local DIPs. Every overlay receives every annotation: a control
 * straddling two monitors is drawn on both, and a display with nothing on it
 * still knows where the step is so it can point there. `origins` maps a
 * display id to its top-left in global DIPs; an annotation whose home display
 * has gone is dropped. The home id stays in `displayId`.
 */
export function routeTo(annotations: Annotation[], origins: Map<string, Point>, here: Point): Annotation[] {
    const out: Annotation[] = [];
    for (const a of annotations) {
        const home = origins.get(a.displayId);
        if (!home) continue;
        const dx = home.x - here.x;
        const dy = home.y - here.y;
        out.push({
            ...a,
            rect: { ...a.rect, x: a.rect.x + dx, y: a.rect.y + dy },
            to: a.to ? { x: a.to.x + dx, y: a.to.y + dy } : undefined
        });
    }
    return out;
}

/** A global DIP rect clipped to one display and made local to it, or null if they don't meet. */
export function localPart(global: Rect, display: Rect): Rect | null {
    const i = intersection(global, display);
    return i ? { ...i, x: i.x - display.x, y: i.y - display.y } : null;
}

/**
 * Which display leads the step: the one holding the step's first target
 * annotation (hidden ones too, so the strip stays put while a menu closes),
 * else the primary. A hidden target keeps the display it was last on, which
 * may since have been unplugged; leading from there would put the strip on no
 * monitor at all, so only displays in `live` count.
 */
export function leadDisplay(
    step: StepView | null,
    annotations: Annotation[],
    primaryId: string,
    live: { has(id: string): boolean }
): string {
    for (const id of step?.targetIds ?? []) {
        const a = annotations.find(x => x.id === id);
        if (a && live.has(a.displayId)) return a.displayId;
    }
    return primaryId;
}

/**
 * Whether a display shows the step strip. Normally the lead only, or every
 * monitor would repeat the prompt. A click step with no target is the
 * exception: every display takes the click and shows a crosshair, and the user
 * may be looking at any of them, so each one says what the click is for.
 */
export function showsStrip(step: StepView | null, lead: boolean): boolean {
    if (!step) return false;
    return lead || (step.mode === 'click' && step.targetIds.length === 0);
}

const AWAY: Record<NonNullable<Annotation['hiddenReason']>, string> = {
    minimized: 'it was minimised. Restore it to carry on.',
    closed: 'it was closed.',
    'other-desktop': 'it is on another virtual desktop.',
    gone: 'it is no longer on screen.'
};

/**
 * The strip's note while every target of the pending step is hidden, so the
 * user is told why the circle went away instead of seeing it silently vanish:
 * "Waiting for “Notepad” to come back: it was minimised. Restore it to carry on."
 *
 * A minimised, closed or other-desktop target took its window with it, so the
 * window is named; one that is simply gone (a menu that closed) is named itself,
 * and its window only says where it was: that window is still on screen. Names
 * come from the anchor's own fields, never its ref: a user has no idea what
 * "el_3" or "0x1A2B" is.
 */
export function waitingNote(step: StepView | null, annotations: Annotation[]): string | undefined {
    if (!step) return undefined;
    const targets = step.targetIds.flatMap(id => annotations.filter(a => a.id === id));
    if (targets.length === 0 || targets.some(a => !a.hidden)) return undefined;
    const a = targets[0]!;
    const reason = a.hiddenReason ?? 'gone';
    const label = quoted(a.anchor?.label);
    const app = quoted(a.anchor?.app);
    const subject =
        reason !== 'gone' ? (app ?? 'the app') : (label ?? (app ? `the target in ${app}` : 'the target'));
    return `Waiting for ${subject} to come back: ${AWAY[reason]}`;
}

/** Long enough for a window title; a mail row's name can run to hundreds of characters. */
const NOTE_NAME_MAX = 60;

function quoted(name: string | undefined): string | undefined {
    const t = name?.trim().replace(/\s+/g, ' ');
    if (!t) return undefined;
    return `“${t.length > NOTE_NAME_MAX ? `${t.slice(0, NOTE_NAME_MAX - 1).trimEnd()}…` : t}”`;
}

/**
 * How much of `r` lies on some display. Displays never overlap, so the parts
 * simply add up. A zero-area shape (a label's point) counts as all or nothing.
 */
export function visibleFraction(r: Rect, displays: Rect[]): number {
    if (r.width <= 0 || r.height <= 0) return displays.some(d => contains(d, r)) ? 1 : 0;
    const area = r.width * r.height;
    return Math.min(1, displays.reduce((s, d) => s + overlapArea(r, d), 0) / area);
}

/**
 * Where a shape is from this display's point of view.
 * - `here`: at least partly on this display; draw it.
 * - `elsewhere`: on another monitor; at most point toward it.
 * - `off`: less than a quarter of it is on any display (a window dragged half
 *   off the desktop); drawing it would show the user nothing, so the display
 *   nearest to it draws an edge arrow instead.
 */
export type Placement = 'here' | 'elsewhere' | 'off';

const OFF_THRESHOLD = 0.25;

export function classify(bounds: Rect, view: Size, others: Rect[]): Placement {
    const own: Rect = { x: 0, y: 0, ...view };
    if (visibleFraction(bounds, [own, ...others]) < OFF_THRESHOLD) return 'off';
    const touches =
        bounds.width <= 0 || bounds.height <= 0 ? contains(own, bounds) : overlapArea(bounds, own) > 0;
    return touches ? 'here' : 'elsewhere';
}

/** Whether this display (at the origin, `view` sized) is the one nearest to `r`. */
export function nearestIsHere(r: Rect, view: Size, others: Rect[]): boolean {
    const c = centre(r);
    const dist = (d: Rect): number => {
        const p = clampPoint(c, d);
        return Math.hypot(p.x - c.x, p.y - c.y);
    };
    const mine = dist({ x: 0, y: 0, ...view });
    return others.every(d => mine <= dist(d));
}

// --------------------------------------------------------------- pointers

export type Side = 'left' | 'right' | 'top' | 'bottom';

/** Which edge of the view faces `p`. */
export function sideToward(p: Point, view: Size): Side {
    const dx = p.x < 0 ? p.x : p.x > view.width ? p.x - view.width : 0;
    const dy = p.y < 0 ? p.y : p.y > view.height ? p.y - view.height : 0;
    if (Math.abs(dx) >= Math.abs(dy) && dx !== 0) return dx < 0 ? 'left' : 'right';
    if (dy !== 0) return dy < 0 ? 'top' : 'bottom';
    // Inside the view: pick the nearest edge, which is where it is closest to leaving.
    const d = { left: p.x, right: view.width - p.x, top: p.y, bottom: view.height - p.y };
    return (Object.keys(d) as Side[]).reduce((a, b) => (d[b] < d[a] ? b : a));
}

export const ARROW_GLYPH: Record<Side, string> = { left: '←', right: '→', top: '↑', bottom: '↓' };

/**
 * An arrow inset from the edge of the view, pointing at a target beyond it.
 * `tip` is where the head is drawn, `tail` where the shaft starts.
 */
export function edgeArrow(target: Rect, view: Size, margin = 30, length = 46): { tip: Point; tail: Point; side: Side } {
    const c = centre(target);
    const tip = clampPoint(c, { x: margin, y: margin, width: view.width - margin * 2, height: view.height - margin * 2 });
    const side = sideToward(c, view);
    let ux = c.x - tip.x;
    let uy = c.y - tip.y;
    const len = Math.hypot(ux, uy);
    if (len < 1) {
        // The target's centre is inside the view; point straight out of the facing edge.
        ux = side === 'left' ? -1 : side === 'right' ? 1 : 0;
        uy = side === 'top' ? -1 : side === 'bottom' ? 1 : 0;
    } else {
        ux /= len;
        uy /= len;
    }
    return { tip, tail: { x: tip.x - ux * length, y: tip.y - uy * length }, side };
}

/** "The step is on your right-hand screen →" */
export function elsewhereText(side: Side): string {
    const where = {
        left: 'your left-hand screen',
        right: 'your right-hand screen',
        top: 'the screen above',
        bottom: 'the screen below'
    }[side];
    return `The step is on ${where} ${ARROW_GLYPH[side]}`;
}

/** The note under an off-screen target's caption. */
export function offScreenText(side: Side): string {
    return `off the ${side} edge of the screen ${ARROW_GLYPH[side]}`;
}

/** Where a pill pointing toward `target` sits: on the facing edge, as close to it as fits. */
export function edgeAnchor(target: Rect, view: Size, inset = 40): Point {
    return clampPoint(centre(target), { x: inset, y: inset, width: view.width - inset * 2, height: view.height - inset * 2 });
}

// -------------------------------------------------------------- the ring

/**
 * The outline highlight_and_wait's circle actually takes.
 *
 * An ellipse inscribed in the padded rectangle cuts through the corners of a
 * wide control: a 400x24 field padded by 8 has its corners at 1.28 on the
 * ellipse's own scale, so the stroke runs through the text at both ends. Past
 * an aspect of ~1.6 a rounded rectangle is drawn instead. Its corner radius is
 * capped at 3.4 x pad: measured from the control's corner, the corner arc's
 * centre is (r - pad)·√2 away, which stays inside the arc while r <= pad·(2+√2).
 * A full stadium (r = height/2) would cut the corners of a tall-wide control.
 */
export function ringShape(rect: Rect, pad: number): { kind: 'ellipse' } | { kind: 'rounded'; radius: number } {
    const long = Math.max(rect.width, rect.height);
    const short = Math.max(1, Math.min(rect.width, rect.height));
    if (long / short <= 1.6) return { kind: 'ellipse' };
    return { kind: 'rounded', radius: Math.max(0, Math.min(short / 2, 3.4 * pad)) };
}

// --------------------------------------------------------------- captions

/** Caption text wraps to this width: wide enough to read, narrow enough to stay near its target. */
export function captionMaxWidth(viewWidth: number): number {
    return Math.min(Math.max(220, Math.min(360, 0.4 * viewWidth)), Math.max(60, viewWidth - 24));
}

/**
 * Greedy word wrap into at most `maxLines`, ending in an ellipsis when cut.
 * A word longer than a whole line (a path, a URL) is split by characters.
 */
export function wrapText(text: string, maxWidth: number, measure: (s: string) => number, maxLines = 3): string[] {
    const words = text.trim().split(/\s+/).filter(Boolean);
    const lines: string[] = [];
    let line = '';
    for (const word of words) {
        const tryLine = line ? `${line} ${word}` : word;
        if (measure(tryLine) <= maxWidth) {
            line = tryLine;
            continue;
        }
        if (line) lines.push(line);
        line = '';
        let rest = word;
        while (measure(rest) > maxWidth && rest.length > 1) {
            let cut = rest.length - 1;
            while (cut > 1 && measure(rest.slice(0, cut)) > maxWidth) cut -= 1;
            lines.push(rest.slice(0, cut));
            rest = rest.slice(cut);
        }
        line = rest;
    }
    if (line) lines.push(line);
    if (lines.length <= maxLines) return lines;

    const kept = lines.slice(0, maxLines);
    let last = `${kept[maxLines - 1]!}…`;
    while (last.length > 1 && measure(last) > maxWidth) last = `${last.slice(0, -2).trimEnd()}…`;
    kept[maxLines - 1] = last;
    return kept;
}

/**
 * Controls that open something downward when clicked. A caption placed under
 * "File" covers the very menu the click opens, so for these "below" is the
 * last resort rather than merely the last choice.
 */
export function opensDownward(role: string | undefined): boolean {
    return !!role && /menu|tab|combo|dropdown|splitbutton|select/i.test(role.replace(/\s+/g, ''));
}

export interface CaptionRequest {
    id: string;
    size: Size;
    /** What the caption belongs to; it must not be covered. */
    target: Rect;
    /**
     * - `beside` (default): search above, right, left, then below the target.
     * - `above-point`: a label, centred above its point and never moved away.
     * - `on`: centred on the target, e.g. a pill standing in for a shape.
     */
    mode?: 'beside' | 'above-point' | 'on';
    opensDown?: boolean;
    /**
     * Align above/below placements to the target's left edge plus this inset
     * rather than centring them; a step's text sits beside its corner badge.
     */
    startInset?: number;
}

export interface CaptionBox {
    id: string;
    box: Rect;
    /** Drawn when the caption had to land away from its target, so it isn't read as a neighbour's. */
    leader?: [Point, Point];
}

const CAPTION_GAP = 6;
const VIEW_MARGIN = 4;
/** Captions farther than this from their target get a leader line. */
const LEADER_AFTER = 16;

function candidates(req: CaptionRequest): Rect[] {
    const { width: w, height: h } = req.size;
    const t = req.target;
    const tc = centre(t);
    if (req.mode === 'above-point') return [{ x: t.x - w / 2, y: t.y - h - CAPTION_GAP, width: w, height: h }];
    if (req.mode === 'on') return [{ x: tc.x - w / 2, y: tc.y - h / 2, width: w, height: h }];
    const alignedX = req.startInset !== undefined ? t.x + req.startInset : tc.x - w / 2;
    const above = { x: alignedX, y: t.y - h - CAPTION_GAP, width: w, height: h };
    const right = { x: t.x + t.width + CAPTION_GAP, y: tc.y - h / 2, width: w, height: h };
    const left = { x: t.x - w - CAPTION_GAP, y: tc.y - h / 2, width: w, height: h };
    const below = { x: alignedX, y: t.y + t.height + CAPTION_GAP, width: w, height: h };
    return [above, right, left, below];
}

/**
 * Place every caption so none covers any target, the step strip, the chat
 * panel or an earlier caption.
 *
 * The order is above, right, left, below. Above is where people look for a
 * label; below comes last because menus, dropdowns and ribbon panels open
 * downward from the control being pointed at, and for those it is a last
 * resort. A candidate is first clamped onto the display, which is what used to
 * push a caption for anything in the top 32 DIP straight into its target; it
 * then counts only if it is still clear. When nothing is clear the least
 * overlapping candidate wins, its own target weighing most. Requests are placed
 * in order, so earlier ones (the current step) get the best spots.
 */
export function placeCaptions(reqs: CaptionRequest[], view: Size, obstacles: Rect[]): CaptionBox[] {
    const viewRect: Rect = { x: 0, y: 0, ...view };
    const placed: Rect[] = [];
    const out: CaptionBox[] = [];
    const targets = reqs.filter(r => r.target.width > 0 && r.target.height > 0).map(r => r.target);

    for (const req of reqs) {
        const own = inflate(req.target, 2);
        const others = targets.filter(t => t !== req.target);
        const overlap = (b: Rect): number => {
            let c = overlapArea(b, own) * 4;
            for (const o of obstacles) c += overlapArea(b, o) * 2;
            for (const o of placed) c += overlapArea(b, o) * 2;
            for (const o of others) c += overlapArea(b, o);
            return c;
        };

        const cands = candidates(req).map(b => clampBox(b, viewRect, VIEW_MARGIN));
        let best: Rect = cands[0]!;
        let bestCost = Infinity;
        for (const [i, b] of cands.entries()) {
            const avoid = req.opensDown && i === 3;
            const o = overlap(b);
            if (o === 0 && !avoid) {
                best = b;
                break;
            }
            // Prefer earlier candidates on a tie, and keep a downward menu's
            // area free unless everything else is worse.
            const c = o + i + (avoid ? req.size.width * req.size.height : 0);
            if (c < bestCost) {
                best = b;
                bestCost = c;
            }
        }
        placed.push(best);

        const box: CaptionBox = { id: req.id, box: best };
        if (req.mode !== 'on' && req.mode !== 'above-point' && gap(best, req.target) > LEADER_AFTER) {
            box.leader = [clampPoint(centre(req.target), best), clampPoint(centre(best), req.target)];
        }
        out.push(box);
    }
    return out;
}

// ------------------------------------------------------------ step badges

/**
 * What a step shape shows. Short text (up to 3 characters) is the badge
 * itself; longer text is an instruction and is captioned beside a numbered
 * badge instead of being crammed into a 30px dot. The number comes from the
 * text when it leads with one ("3. Click Save", "2/5 Click Save"), else from
 * the step's position among the steps on screen.
 */
export function stepBadge(text: string | undefined, ordinal: number): { badge: string; caption?: string } {
    const t = (text ?? '').trim();
    if (!t) return { badge: String(ordinal) };
    if (t.length <= 3) return { badge: t };
    const progress = parseProgress(t);
    if (progress) return { badge: String(progress.n), caption: t };
    const numbered = /^(\d{1,3})[.):]\s+(\S[\s\S]*)$/.exec(t);
    if (numbered) return { badge: numbered[1]!, caption: numbered[2]! };
    return { badge: String(ordinal), caption: t };
}

// ------------------------------------------------------------- step strip

/** "1:18 left". */
export function timeLeft(deadline: number, now: number): string {
    const s = Math.max(0, Math.ceil((deadline - now) / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} left`;
}

/** The step's progress and its prompt without the n/N prefix. */
export function stripProgress(step: StepView): { progress?: { n: number; of: number }; prompt: string } {
    const parsed = parseProgress(step.prompt);
    return {
        progress: step.progress ?? (parsed ? { n: parsed.n, of: parsed.of } : undefined),
        prompt: parsed ? parsed.rest : step.prompt
    };
}

/**
 * Where the step strip docks: top centre unless that covers the step's target
 * (menu bars, tabs and title bars live there), then bottom centre, then the
 * corners. Targets weigh more than other drawings and the chat panel. Inset
 * from the work area, so a taskbar on any edge is respected.
 */
export function dockStrip(size: Size, workArea: Rect, targets: Rect[], others: Rect[]): Rect {
    const m = 24;
    const { width: w, height: h } = size;
    const wa = workArea;
    const midX = wa.x + (wa.width - w) / 2;
    const top = wa.y + m;
    const bottom = wa.y + wa.height - h - m;
    const leftX = wa.x + m;
    const rightX = wa.x + wa.width - w - m;
    const cands: Rect[] = [
        { x: midX, y: top, width: w, height: h },
        { x: midX, y: bottom, width: w, height: h },
        { x: leftX, y: top, width: w, height: h },
        { x: rightX, y: top, width: w, height: h },
        { x: leftX, y: bottom, width: w, height: h },
        { x: rightX, y: bottom, width: w, height: h }
    ].map(b => clampBox(b, wa, 0));

    const avoidT = targets.map(t => inflate(t, 16));
    let best = cands[0]!;
    let bestCost = Infinity;
    for (const b of cands) {
        let c = 0;
        for (const t of avoidT) c += overlapArea(b, t) * 10;
        for (const o of others) c += overlapArea(b, o);
        if (c === 0) return b;
        if (c < bestCost) {
            best = b;
            bestCost = c;
        }
    }
    return best;
}

// ------------------------------------------------------------ mouse input

/**
 * Whether an overlay window takes the mouse rather than letting it through.
 * Click-through is the default: the overlay must never intercept the user's
 * mouse. Two exceptions: every overlay while a click-mode step is pending, and
 * the one overlay whose step strip is under the pointer, so its buttons can be
 * pressed. Neither applies to a window whose page is not running (crashed,
 * hung, not loaded yet): it draws nothing and reports nothing, so taking the
 * mouse would only make it an invisible sheet that swallows clicks.
 */
export function takesMouse(w: { live: boolean; picking: boolean; hovered: boolean }): boolean {
    return w.live && (w.picking || w.hovered);
}

/**
 * Whether a global DIP point is over a display's step strip, which is given in
 * that display's local DIPs. A little slack keeps a pointer resting on the
 * strip's edge counted as over it.
 */
export function overStrip(p: Point, origin: Point, strip: Rect | null, slack = 6): boolean {
    if (!strip) return false;
    return contains(inflate({ ...strip, x: origin.x + strip.x, y: origin.y + strip.y }, slack), p);
}

/**
 * Whether a renderer tells main that the pointer is (or is not) over its strip.
 * `sent` is what it last told main, or null when it cannot know what main
 * believes: main hovers a strip that docks under a resting pointer by itself,
 * so after a new strip rect the next answer always goes, or leaving the strip
 * would go unsaid and the clicks beside it would be eaten. "Over" is repeated
 * every 200 ms while it holds: main's failsafe may have restored click-through
 * behind the renderer's back (a pointer that jumped monitors).
 */
export function reportsHover(sent: boolean | null, over: boolean, sinceSentMs: number): boolean {
    return over !== sent || (over && sinceSentMs > 200);
}

/**
 * Validate an answer arriving from a renderer. The step code trusts its input,
 * and a renderer is the least trusted thing in the process.
 */
export function parseUserAnswer(x: unknown): UserAnswer | null {
    if (!x || typeof x !== 'object') return null;
    const a = x as Record<string, unknown>;
    switch (a.kind) {
        case 'done':
        case 'skip':
            return { kind: a.kind };
        case 'stuck':
            return typeof a.text === 'string' ? { kind: 'stuck', text: a.text } : { kind: 'stuck' };
        case 'reply':
            return typeof a.text === 'string' ? { kind: 'reply', text: a.text } : null;
        case 'choice':
            return Number.isInteger(a.index) && (a.index as number) >= 0 ? { kind: 'choice', index: a.index as number } : null;
        default:
            return null;
    }
}

// ------------------------------------------------------------- sound cues

/** What an overlay has already chimed for. */
export interface CuesHeard {
    stepId: string | null;
    done: Set<string>;
}

/**
 * Which cues a frame calls for: the start tone for a new step (the lead display
 * only, or every monitor chimes), the done tone for a new check mark on its
 * home display. `heard` is null on a page's first frame. A page reloaded after
 * a crash, or opened for a monitor plugged in mid-step, is only learning what
 * is already on screen; chiming then replayed a step that began long ago and
 * every check mark since, every 10 s for a page in a crash loop.
 */
export function stepCues(
    heard: CuesHeard | null,
    f: Pick<OverlayFrame, 'step' | 'annotations' | 'displayId' | 'cues' | 'lead'>
): { start: boolean; done: boolean; heard: CuesHeard } {
    const stepId = f.step?.id ?? null;
    const done = new Set(f.annotations.filter(a => a.type === 'done' && a.displayId === f.displayId).map(a => a.id));
    const now = { stepId, done };
    if (!heard || !f.cues) return { start: false, done: false, heard: now };
    return {
        start: f.lead && stepId !== null && stepId !== heard.stepId,
        done: [...done].some(id => !heard.done.has(id)),
        heard: now
    };
}
