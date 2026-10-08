import { screen } from 'electron';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Annotation, ClickResult, Rect, SnapshotNode, StepAnswer } from '../../../shared/types.js';
import { rectContains } from '../../../shared/geometry.js';
import { parseProgress } from '../../../shared/progress.js';
import { clean, diffLines, elementLine, toSnapshotNodes } from '../../../shared/uitree.js';
import { store } from '../../store.js';
import { beginStep } from '../../steps.js';
import { postToHud } from '../../hud.js';
import { listDisplays } from '../../displays.js';
import {
    coverage,
    describeWindow,
    elementAtPoint,
    listWindows,
    resolveRefs,
    resolveWindow,
    type Coverage,
    type PointHit,
    type WindowInfo
} from '../../uia.js';
import { isTopLevelWait, waitForElement, type WaitCondition, type WaitOutcome, type WaitRequest } from '../../waits.js';
import { answerText } from './answers.js';
import { CONDITIONS, DEFAULT_COLORS, WINDOW, guarded, isWindowRole, selectorFields, text } from './common.js';
import { placeAnchored, resolveAnchor, type ResolvedAnchor } from './anchoring.js';

/**
 * Waiting on the user and the UI: highlight_and_wait, wait_for_element,
 * wait_for_user_click.
 *
 * Every way a step can end is an answer, not an error: the UI reaching the
 * awaited state, the user saying done, stuck or skip, a typed reply, Escape,
 * silence, or the client going away. Errors are kept for what the agent got
 * wrong (a malformed until, a control that is not there) and for a helper that
 * failed, because those are the cases where retrying differently helps.
 */

// ------------------------------------------------------------------ shapes

const UNTIL_CONDITIONS = [...CONDITIONS, 'changes'] as const;

interface Until {
    condition: WaitCondition;
    name?: string;
    automationId?: string;
    role?: string;
    window?: string;
    value?: string;
}

interface StepSpec {
    window: string;
    name?: string;
    automationId?: string;
    role?: string;
    prompt: string;
    until?: Until;
}

interface StepOptions {
    timeoutMs: number;
    keep: boolean;
    signal: AbortSignal;
    /** Keep looking for the target this long: in a plan it may still be animating in. */
    findRetryMs: number;
    /** "Step 2/3: ", leading every line of a plan's step. */
    label: string;
}

interface StepResult {
    /** The step is done, so a plan may go on. */
    ok: boolean;
    /** The full report for this step. */
    text: string;
    /** One line, for a plan's earlier steps. */
    line: string;
    /** The window a following plan step defaults to. */
    window: string;
}

/** How long the check mark that replaces a met step's circle stays up. */
const DONE_TTL_MS = 1000;
/** A circled control gone this long, with the step unmet, ends the wait. */
const TARGET_GONE_MS = 10_000;
/** The longest a whole plan may run, like the longest single step. */
const PLAN_MAX_MS = 900_000;
/** The most of anything a report lists before saying how many more. */
const LIST_CAP = 3;

const secsOf = (ms: number): string => (ms / 1000).toFixed(1);
const quote = (s: string): string => `"${clean(s).slice(0, 60)}"`;
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

function untilText(u: Until): string {
    const fields = { name: u.name, automationId: u.automationId, role: u.role, window: u.window, value: u.value };
    const set = Object.entries(fields).filter(([, v]) => v !== undefined);
    return `"${u.condition}"${set.length ? ` ${JSON.stringify(Object.fromEntries(set))}` : ''}`;
}

// --------------------------------------------------------- wait summaries

/** Why an unmet wait came close, from what its last check saw. */
function seenNote(req: WaitRequest, o: WaitOutcome): string {
    const s = o.seen;
    if (!s) return '';
    if (req.condition === 'disappears') return `\nStill there: ${elementLine(s)}`;
    if (isTopLevelWait(req)) {
        return (
            `\nA matching window was already open before the step (${s.ref} ${quote(s.name)}), so it does not ` +
            'count. If the app reuses it, wait for a control inside it instead (until without role "window").'
        );
    }
    if (req.value) {
        const now = [s.value !== undefined ? `value "${clean(s.value)}"` : '', s.state ?? ''].filter(Boolean);
        return `\nClosest: ${elementLine(s)}${now.length ? ` (${now.join(', ')})` : ''}`;
    }
    if (req.condition === 'enabled' && !s.enabled) return `\nIt is there but disabled: ${elementLine(s)}`;
    return '';
}

function waitSummary(req: WaitRequest, o: WaitOutcome, how = ''): string {
    const secs = secsOf(o.waitedMs);
    if (o.met) {
        const closed = o.windowClosed ? ' (the window itself closed)' : how;
        return `Met: "${req.condition}" after ${secs}s${closed}.${o.element ? `\n${elementLine(o.element)}` : ''}`;
    }
    if (o.ended === 'window-closed') return `NOT met: the window closed after ${secs}s.`;
    if (o.ended === 'gave-up') return `NOT met yet: ${o.reason}.`;
    return `NOT met: "${req.condition}" did not happen within ${secs}s (${o.polls} checks).${seenNote(req, o)}`;
}

const UNSCOPED_NOTE =
    '\nNote: not scoped to a window, so every check walked the whole desktop (seconds each, and the ' +
    'timeout can overshoot). Pass window to make it near-instant.';

// ------------------------------------------------------------- where things are

/** "top-left", "centre", "bottom": where a rect sits inside a window, in words the user can follow. */
function whereIn(r: Rect, win: Rect): string {
    const fx = (r.x + r.width / 2 - win.x) / Math.max(1, win.width);
    const fy = (r.y + r.height / 2 - win.y) / Math.max(1, win.height);
    const h = fx < 1 / 3 ? 'left' : fx > 2 / 3 ? 'right' : '';
    const v = fy < 1 / 3 ? 'top' : fy > 2 / 3 ? 'bottom' : '';
    return v && h ? `${v}-${h}` : v || h || 'centre';
}

/** "40px below and 12px left of": how far a point is outside a rect, in physical px. */
function offsetFrom(r: Rect, p: { x: number; y: number }, scale: number): string {
    const dx = p.x < r.x ? p.x - r.x : p.x > r.x + r.width ? p.x - (r.x + r.width) : 0;
    const dy = p.y < r.y ? p.y - r.y : p.y > r.y + r.height ? p.y - (r.y + r.height) : 0;
    const px = (d: number): string => `${Math.round(Math.abs(d) * scale)}px`;
    const parts = [
        dy < 0 ? `${px(dy)} above` : dy > 0 ? `${px(dy)} below` : '',
        dx < 0 ? `${px(dx)} left of` : dx > 0 ? `${px(dx)} right of` : ''
    ].filter(Boolean);
    return parts.join(' and ');
}

function circledLine(target: ResolvedAnchor, windowRef: string, windows: WindowInfo[]): string {
    const win = windows.find(w => w.ref === windowRef);
    const where = win ? `${whereIn(target.rect, win.rect)} of ${quote(win.title)}` : `in window ${windowRef}`;
    return `Circled ${target.label}, ${where}.`;
}

/**
 * Whether the target is hidden behind another window, as a warning, or null.
 *
 * Untitled windows on top are left out: an open menu or dropdown is an
 * untitled top-level popup of the app itself, and counting it would warn on
 * every menu step. A tooltip is untitled too, and passes in a moment.
 */
function coveredNote(c: Coverage, what: string, windowTitle: string): string | null {
    const by = c.by.filter(t => clean(t) !== '');
    if (by.length === 0 || !(c.centre_covered || c.fraction >= 0.5)) return null;
    return (
        `WARNING: ${what} is ${Math.round(c.fraction * 100)}% behind ${by.slice(0, 2).map(quote).join(', ')}; ` +
        `focus_window {window:${JSON.stringify(windowTitle)}} brings it forward.`
    );
}

async function coverageOf(windowRef: string, rect: Rect): Promise<Coverage | null> {
    try {
        return await coverage(windowRef, rect);
    } catch {
        // Best effort: a failed read must not cost the step.
        return null;
    }
}

/**
 * What the user can see of the circled control right now, for a STUCK or
 * failed step: gone, scrolled away, covered, or plainly visible (in which
 * case the prompt, not the screen, is what to change).
 */
async function targetStatus(circleId: string | undefined, windowRef: string, windowTitle: string): Promise<string> {
    const circle = circleId ? store.list().find(a => a.id === circleId) : undefined;
    if (!circle?.anchor) return '';
    if (circle.hidden) return 'The circled control is not on screen now (it went away, or its window is minimised).';
    let rect: Rect | null = null;
    try {
        const [live] = await resolveRefs([circle.anchor.ref]);
        if (live?.offscreen) return 'The circled control is scrolled out of view; scroll_window brings it into view.';
        rect = live?.rect ?? null;
    } catch {
        return '';
    }
    if (!rect) return 'The circled control is not on screen now.';
    const c = await coverageOf(windowRef, rect);
    const covered = c && coveredNote(c, 'the circled control', windowTitle);
    if (covered) return covered;
    if (c && c.fraction > 0.2) {
        return `The circled control is ${Math.round(c.fraction * 100)}% covered by another window.`;
    }
    return 'The circled control is visible and uncovered: ask what they see, or describe it differently.';
}

// ------------------------------------------------------------- clicks

/** Roles too coarse to name: a click on a canvas or page says only which window. */
const COARSE_ROLES = new Set(['pane', 'window', 'document']);

function hitText(hit: PointHit): string | null {
    const e = hit.element;
    const inWindow = hit.window ? ` in ${quote(hit.window.title)}` : '';
    if (e && clean(e.name) && !COARSE_ROLES.has(e.role)) return `${quote(e.name)} [${e.role}] ${e.ref}${inWindow}`;
    return hit.window ? `the window ${quote(hit.window.title)}` : null;
}

/**
 * Name the control under a click. The overlay reports display-local DIPs and
 * the helper reads virtual-screen physical pixels; with monitors at different
 * scales the two layouts are not a uniform scaling of each other, so the
 * conversion goes through Electron rather than arithmetic. Best effort: a
 * failed read leaves the click unnamed, never loses it.
 */
async function nameClick(c: ClickResult): Promise<string | null> {
    try {
        const d = screen.getAllDisplays().find(x => String(x.id) === c.displayId);
        if (!d) return null;
        const p = screen.dipToScreenPoint({ x: d.bounds.x + c.dip.x, y: d.bounds.y + c.dip.y });
        return hitText(await elementAtPoint(p.x, p.y));
    } catch {
        return null;
    }
}

/** Which of the current drawings a click landed inside. */
function drawingsAt(c: ClickResult): string[] {
    return store
        .forDisplay(c.displayId)
        .filter(a => !a.hidden && a.type !== 'done' && rectContains(a.rect, c.dip))
        .map(a => a.id);
}

async function clickLine(c: ClickResult, i: number): Promise<string> {
    const img = c.image ? `, image ${c.image.x},${c.image.y}` : '';
    const named = await nameClick(c);
    const inside = drawingsAt(c);
    const what = [named, inside.length ? `inside ${inside.join(', ')}` : ''].filter(Boolean).join('; ');
    return (
        `${i + 1}. display ${c.displayId}: physical ${c.physical.x},${c.physical.y}${img}, ` +
        `normalized ${c.normalized.x},${c.normalized.y}${what ? ` -> ${what}` : ''}`
    );
}

// ------------------------------------------------------------- before and after

async function snapshotOf(windowRef: string): Promise<{ id: string; nodes: SnapshotNode[] } | undefined> {
    try {
        // The same budget as describe_window's default, so since= diffs line up.
        const { nodes } = await describeWindow({ window: windowRef, maxNodes: 120 });
        const snap = toSnapshotNodes(nodes);
        const id = store.recordSnapshot({ id: store.nextId('snap'), windowRef, at: Date.now(), nodes: snap });
        return { id, nodes: snap };
    } catch {
        return undefined;
    }
}

/** Rows worth acting on in a window that just opened; lists and trees become counts. */
const ACTIONABLE = new Set([
    'button',
    'splitbutton',
    'edit',
    'combobox',
    'checkbox',
    'radiobutton',
    'menuitem',
    'tabitem',
    'link',
    'slider',
    'spinner'
]);
const COUNTED = new Set(['listitem', 'treeitem', 'dataitem']);
const ACTIONABLE_CAP = 25;

function actionableRows(nodes: SnapshotNode[]): string {
    // Title-bar buttons are on every window and never the point.
    const body = nodes.filter(n => !/(^|\/)titlebar\[/.test(n.key));
    const rows = body
        .filter(n => ACTIONABLE.has(n.role))
        .map(n => {
            const value = n.value && n.role === 'edit' ? ` "${n.value}"` : '';
            const state = [n.enabled ? '' : 'disabled', n.state ?? ''].filter(Boolean).join(',');
            return `${n.name || '(unnamed)'} [${n.role}]${value}${state ? ` ${state}` : ''} ${n.ref}`;
        });
    const counts = new Map<string, number>();
    for (const n of body) if (COUNTED.has(n.role)) counts.set(n.role, (counts.get(n.role) ?? 0) + 1);
    const shown = rows.slice(0, ACTIONABLE_CAP);
    const more = rows.length - shown.length;
    const extra = [...counts].map(([role, n]) => `${n} ${role}`);
    if (more > 0) extra.push(`${more} more`);
    return [...shown, ...extra].join('; ');
}

/** Windows that opened or closed since `before`. */
function windowDelta(before: WindowInfo[], now: WindowInfo[]): { opened: WindowInfo[]; closed: WindowInfo[] } {
    const was = new Set(before.map(w => w.ref));
    const is = new Set(now.map(w => w.ref));
    return { opened: now.filter(w => !was.has(w.ref)), closed: before.filter(w => !is.has(w.ref)) };
}

function windowLines(opened: WindowInfo[], closed: WindowInfo[]): string[] {
    return [
        ...opened
            .slice(0, LIST_CAP)
            .map(w => `+ window ${w.ref} ${quote(w.title)}${w.foreground ? ' [foreground]' : ''}`),
        ...closed.slice(0, LIST_CAP).map(w => `- window ${w.ref} ${quote(w.title)}`)
    ];
}

/** Lines of a diff, capped, with how to see the rest. */
function cappedDiff(lines: string[], cap: number, sinceId: string): string[] {
    if (lines.length <= cap) return lines;
    return [...lines.slice(0, cap), `+${lines.length - cap} more: describe_window since=${sinceId}`];
}

/**
 * What the step changed, so the agent can plan the next step without another
 * describe_window: windows that opened (with the new one's controls) or
 * closed, or else the step window's own changes. One describe at the start and
 * one here, never one per poll.
 */
async function afterBlock(
    before: WindowInfo[],
    windowRef: string | undefined,
    start: { id: string; nodes: SnapshotNode[] } | undefined
): Promise<string> {
    let now: WindowInfo[];
    try {
        now = await listWindows();
    } catch {
        return '';
    }
    const { opened, closed } = windowDelta(before, now);
    const lines = windowLines(opened, closed);

    const fresh = opened.find(w => w.foreground) ?? opened[0];
    if (fresh) {
        const snap = await snapshotOf(fresh.ref);
        const rows = snap && (actionableRows(snap.nodes) || 'no controls exposed');
        if (snap) lines.push(`  ${quote(fresh.title)}: ${rows} (snapshotId: ${snap.id})`);
    } else if (start && windowRef) {
        const snap = await snapshotOf(windowRef);
        const changes = snap && diffLines(start.nodes, snap.nodes);
        if (snap && changes) lines.push(...cappedDiff(changes, 30, start.id), `snapshotId: ${snap.id}`);
    }
    return lines.length ? `\nAfter:\n${lines.join('\n')}` : '';
}

/**
 * Everything the server noticed about a step that did not complete, so the
 * agent picks the right recovery instead of rediscovering the facts with
 * list_windows, describe_window or a screenshot, and instead of blaming the
 * selector when the user simply went elsewhere.
 */
async function failureDigest(ctx: {
    req: WaitRequest;
    before: WindowInfo[];
    windowRef: string;
    windowTitle: string;
    start?: { id: string; nodes: SnapshotNode[] };
    circleId?: string;
}): Promise<string> {
    const out: string[] = [];
    let now: WindowInfo[] = [];
    try {
        now = await listWindows();
    } catch {
        // Leave the window part out rather than fail the report.
    }
    const { opened, closed } = windowDelta(ctx.before, now);
    if (opened.length || closed.length) out.push(`Since the step began:\n${windowLines(opened, closed).join('\n')}`);
    const front = now.find(w => w.foreground);
    if (front) out.push(`Foreground: ${quote(front.title)}.`);

    const status = await targetStatus(ctx.circleId, ctx.windowRef, ctx.windowTitle);
    if (status) out.push(status);

    let changed = false;
    if (ctx.start) {
        const snap = await snapshotOf(ctx.windowRef);
        const diff = snap && diffLines(ctx.start.nodes, snap.nodes);
        if (diff) {
            changed = true;
            out.push(`Changes in ${quote(ctx.windowTitle)}:`, ...cappedDiff(diff, 6, ctx.start.id));
        }
    }

    const top = isTopLevelWait(ctx.req);
    if (opened.length) {
        const w = opened.find(x => x.foreground) ?? opened[0]!;
        out.push(
            top
                ? `A new window ${quote(w.title)} appeared; until did not match it: use its title.`
                : `A new window ${quote(w.title)} appeared; if the control is in it, pass ` +
                  `until.window:${JSON.stringify(clean(w.title))}.`
        );
    } else if (!changed && !closed.length) {
        // Without a snapshot only the window list was watched, so say just that.
        const what = ctx.start ? 'Nothing changed' : 'No window opened or closed';
        out.push(`${what}: the user may still be working or looking elsewhere; rephrase rather than repeat.`);
    } else if (!top) {
        out.push('The control may be named differently; describe_window shows what is there.');
    }
    return out.length ? `\n${out.join('\n')}` : '';
}

// ------------------------------------------------------------- the step

async function findTarget(
    spec: StepSpec,
    windowRef: string,
    retryMs: number,
    signal: AbortSignal
): Promise<ResolvedAnchor> {
    const deadline = Date.now() + retryMs;
    const { name, role, automationId } = spec;
    for (;;) {
        try {
            return await resolveAnchor({ window: windowRef, name, role, automationId });
        } catch (err) {
            if (Date.now() >= deadline || signal.aborted) throw err;
            await sleep(300);
        }
    }
}

type WaitPlan = Omit<WaitRequest, 'timeoutMs' | 'pollMs'>;

async function waitPlan(u: Until, windowRef: string, before: WindowInfo[]): Promise<WaitPlan> {
    const topLevel = isWindowRole(u.role) && !u.window && !u.automationId;
    return {
        condition: u.condition,
        window: u.window ? await resolveWindow(u.window) : topLevel ? undefined : windowRef,
        name: u.name,
        role: topLevel ? 'window' : u.role,
        automationId: u.automationId,
        value: u.value,
        baseline: new Set(before.map(w => w.ref))
    };
}

/**
 * An until that is already true before the user acts cannot show they did
 * anything. A new-window wait is edge-triggered by its baseline instead, and
 * "changes" is a change by definition; everything else is checked once first.
 */
function needsPrecheck(req: WaitPlan): boolean {
    if (req.condition === 'changes') return false;
    return !(isTopLevelWait(req) && (req.condition === 'appears' || req.condition === 'enabled'));
}

/** Swap the step's circle for a brief check mark, so the user sees the step registered. */
function confirmOnScreen(circleId: string | undefined): void {
    const circle = circleId ? store.list().find(a => a.id === circleId) : undefined;
    if (!circleId) return;
    store.clear([circleId]);
    // A target that went away (the dialog the user just closed) has no place to tick.
    if (!circle || circle.hidden) return;
    const now = Date.now();
    store.add([
        {
            id: store.nextId('ann'),
            displayId: circle.displayId,
            type: 'done',
            rect: circle.rect,
            text: 'Got it',
            color: DEFAULT_COLORS.done,
            thickness: circle.thickness,
            createdAt: now,
            expiresAt: now + DONE_TTL_MS
        }
    ]);
}

/** Drawings that outlive the step, so the agent can clear them when the task is done. */
function othersStillUp(ours: Set<string>): string {
    const others = store.list().filter(a => !a.expiresAt && !ours.has(a.id));
    if (others.length === 0) return '';
    const listed = others.slice(0, LIST_CAP).map(a => a.id).join(', ');
    const more = others.length > LIST_CAP ? ', …' : '';
    return `\n${others.length} other drawing(s) still up (${listed}${more}); clear_annotations when the task is done.`;
}

function giveUpWhenGone(circleId: string | undefined): (() => string | null) | undefined {
    if (!circleId) return undefined;
    return () => {
        const a = store.list().find(x => x.id === circleId);
        if (!a?.hidden || a.hiddenSince === undefined) return null;
        const gone = Date.now() - a.hiddenSince;
        return gone >= TARGET_GONE_MS ? `the circled control went away ${Math.round(gone / 1000)}s ago` : null;
    };
}

function prefixed(label: string, body: string): string {
    return label ? `${label}${body}` : body;
}

/**
 * One walkthrough step: draw, wait for the UI or the user, report. Shared by
 * a single highlight_and_wait and by every step of a plan.
 */
async function runStep(spec: StepSpec, opts: StepOptions): Promise<StepResult> {
    const u = spec.until;
    if (u && u.condition !== 'changes' && !(u.name || u.role || u.automationId)) {
        throw new Error('until needs name, automationId or role (or condition "changes")');
    }
    const windowRef = await resolveWindow(spec.window);
    const before = await listWindows();
    const windowTitle = clean(before.find(w => w.ref === windowRef)?.title ?? windowRef);
    const plan = u ? await waitPlan(u, windowRef, before) : undefined;
    const result = (ok: boolean, body: string, line = body.split('\n')[0]!, next = windowRef): StepResult => ({
        ok,
        text: prefixed(opts.label, body),
        line: prefixed(opts.label, line),
        window: next
    });

    // Checked before drawing: a step whose until already holds would confirm
    // at once, and the agent would move on while the user is still a step
    // behind. A failed check loses only this guard, not the step.
    const pre =
        plan && needsPrecheck(plan)
            ? await waitForElement({ ...plan, timeoutMs: 0, pollMs: 0 }).catch(() => undefined)
            : undefined;

    let target: ResolvedAnchor | undefined;
    if (spec.name || spec.automationId || spec.role) {
        try {
            target = await findTarget(spec, windowRef, opts.findRetryMs, opts.signal);
        } catch (err) {
            if (pre?.met) {
                const seen = pre.element ? `\n${elementLine(pre.element)}` : '';
                return result(true, `Already done (the user was ahead): ${untilText(u!)} already holds.${seen}`);
            }
            throw err;
        }
    }
    if (pre?.met) {
        const seen = pre.element ? `: ${elementLine(pre.element)}` : '';
        return result(
            false,
            `NOT started: until is already true (${untilText(u!)}${seen}), so it cannot show the user did anything; ` +
                'wait for a state their action changes (e.g. the dialog that opens).'
        );
    }

    const warnings: string[] = [];
    if (target) {
        // Scrolled out, the rect is real but points at whatever is in front of
        // it now; drawing there would send the user to the wrong control.
        const [live] = await resolveRefs([target.ref]).catch(() => []);
        if (live?.offscreen) {
            return result(
                false,
                `NOT started: ${target.label} is scrolled out of view in ${quote(windowTitle)}; call scroll_window ` +
                    'with its name, or ask the user to scroll.'
            );
        }
        const c = await coverageOf(windowRef, target.rect);
        const covered = c && coveredNote(c, target.label, windowTitle);
        if (covered) warnings.push(covered);
    }

    let drawn: Annotation[] = [];
    if (target) {
        drawn = placeAnchored(target, [{ type: 'circle', fit: true, pad: 8, pulse: true, text: spec.prompt }], {
            replace: true,
            ttlMs: 0
        });
    } else {
        // Nothing to caption, so the prompt still needs to reach the user.
        postToHud(spec.prompt, 'info');
    }
    const circleId = drawn[0]?.id;
    const circled = target ? circledLine(target, windowRef, before) : '';
    const tail = (body: string): string => [body, circled, ...warnings].filter(Boolean).join('\n');
    const lineOf = (status: string): string => [status, circled].filter(Boolean).join(' ');
    const clearCircle = (): void => {
        if (!opts.keep && circleId) store.clear([circleId]);
    };
    // With keep, the circle outlives the step, but it is still this step's.
    const ours = new Set(drawn.map(a => a.id));

    // A snapshot of the step window, for the After block and the failure
    // digest; only when the until searches that window, since it costs a describe.
    const start = plan && plan.window === windowRef && !isTopLevelWait(plan) ? await snapshotOf(windowRef) : undefined;

    const progress = parseProgress(spec.prompt);
    const step = beginStep({
        prompt: spec.prompt,
        mode: plan ? 'watch' : 'click',
        count: 1,
        timeoutMs: opts.timeoutMs,
        signal: opts.signal,
        targetIds: drawn.map(a => a.id),
        progress: progress ? { n: progress.n, of: progress.of } : undefined
    });
    const startedAt = Date.now();

    // ---- click mode: the overlay captures one click
    if (!plan) {
        const a = await step.answer;
        const waited = Date.now() - startedAt;
        const verdict =
            a.kind === 'clicks' && a.clicks[0]
                ? await clickVerdict(a.clicks[0], circleId, windowRef)
                : { ok: false, text: await userOutcome(a, waited, circleId, windowRef, windowTitle) };
        if (verdict.ok && !opts.keep) confirmOnScreen(circleId);
        else clearCircle();
        return result(verdict.ok, tail(verdict.text) + (verdict.ok ? othersStillUp(ours) : ''));
    }

    // ---- watch mode: the user works in the app while the UI is polled
    const stop = new AbortController();
    const last = new AbortController();
    const waiting = waitForElement({
        ...plan,
        timeoutMs: opts.timeoutMs,
        pollMs: 400,
        signal: stop.signal,
        lastCheck: last.signal,
        giveUp: giveUpWhenGone(circleId)
    }).then(
        o => ({ o }),
        (err: Error) => ({ err })
    );
    const first = await Promise.race([waiting, step.answer.then(a => ({ a }))]);

    let outcome: WaitOutcome | undefined;
    let answer: StepAnswer | undefined;
    if ('a' in first) {
        answer = first.a;
        // Done, or the step's own clock running out: give the UI one last
        // look, so a state that arrived a moment ago still counts.
        if (answer.kind === 'done' || answer.kind === 'timeout') last.abort();
        else stop.abort();
        const settled = await waiting;
        if (answer.kind === 'done' || answer.kind === 'timeout') {
            if ('err' in settled) {
                clearCircle();
                throw settled.err;
            }
            outcome = settled.o;
        }
    } else {
        step.end();
        if ('err' in first) {
            clearCircle();
            throw first.err;
        }
        outcome = first.o;
    }

    const req: WaitRequest = { ...plan, timeoutMs: opts.timeoutMs, pollMs: 400 };
    const matched = outcome?.element?.role === 'window' ? outcome.element.ref : (plan.window ?? windowRef);

    if (outcome?.met) {
        const how = answer?.kind === 'done' ? ' (checked when the user pressed Done)' : '';
        const summary = waitSummary(req, outcome, how);
        if (!opts.keep) confirmOnScreen(circleId);
        const after = await afterBlock(before, plan.window, start);
        return result(true, tail(summary) + after + othersStillUp(ours), lineOf(summary.split('\n')[0]!), matched);
    }

    if (outcome && (answer === undefined || answer.kind === 'timeout' || answer.kind === 'done')) {
        const head =
            answer?.kind === 'done'
                ? `DONE after ${Math.round((Date.now() - startedAt) / 1000)}s, but the until is NOT met: ` +
                  `${untilText(u!)}.${seenNote(req, outcome)}`
                : waitSummary(req, outcome);
        const digest = await failureDigest({ req, before, windowRef, windowTitle, start, circleId });
        // Left up, so the user keeps the pointer while the agent decides; the
        // next step's drawing replaces it.
        const left = circleId && store.list().some(a => a.id === circleId)
            ? `\nCircle ${circleId} left up; your next highlight_and_wait replaces it.`
            : '';
        return result(false, tail(head) + digest + left, lineOf(head.split('\n')[0]!));
    }

    // Read what the user can see of the target before its circle goes.
    const said = await userOutcome(answer!, Date.now() - startedAt, circleId, windowRef, windowTitle);
    clearCircle();
    return result(false, tail(said));
}

/**
 * Judge a click-mode answer against the circle. Off target, the agent gets
 * what was clicked and where it is from the circle, so it can say "that was
 * Export PDF; Export is just above it" without another read.
 */
async function clickVerdict(
    click: ClickResult,
    circleId: string | undefined,
    windowRef: string
): Promise<{ ok: boolean; text: string }> {
    const where = `${click.physical.x},${click.physical.y} on display ${click.displayId}`;
    const named = await nameClick(click);
    const on = named ? `, on ${named}` : '';
    // Read the live annotation: the tracker may have moved it since it was drawn.
    const circle = circleId ? store.list().find(x => x.id === circleId) : undefined;
    if (!circle) return { ok: true, text: `The user clicked at ${where}${on}.` };

    if (circle.displayId !== click.displayId || !rectContains(circle.rect, click.dip)) {
        const scale = listDisplays().find(d => d.id === click.displayId)?.scaleFactor ?? 1;
        const off =
            circle.displayId === click.displayId
                ? `${offsetFrom(circle.rect, click.dip, scale)} the circle`
                : 'on another display than the circle';
        return {
            ok: false,
            text:
                `The user clicked OUTSIDE the target, at ${where}${on}, ${off}. ` +
                'The app did not receive that click; they may mean something else.'
        };
    }

    // On target, but the target may have been behind another window, so what
    // the user saw under the circle was that window.
    if (circle.anchor) {
        const [live] = await resolveRefs([circle.anchor.ref]).catch(() => []);
        const c = live?.rect ? await coverageOf(windowRef, live.rect) : null;
        const by = c?.centre_covered ? c.by.find(t => clean(t) !== '') : undefined;
        if (by !== undefined) {
            return {
                ok: false,
                text:
                    `The user clicked where the target is (${where}), but it was covered by ${quote(by)}, so ` +
                    'they may have meant that window. The app did not receive the click.'
            };
        }
    }
    return { ok: true, text: `The user clicked the target (${where}).` };
}

/**
 * The user's answer, in the shared vocabulary. A STUCK also says what the
 * user can see of the target, which decides between redrawing, scrolling,
 * focusing the window and rewording.
 */
async function userOutcome(
    a: StepAnswer,
    waitedMs: number,
    circleId: string | undefined,
    windowRef: string,
    windowTitle: string
): Promise<string> {
    const said = answerText(a, waitedMs) ?? `The step ended (${a.kind}).`;
    if (a.kind !== 'stuck') return said;
    const status = await targetStatus(circleId, windowRef, windowTitle);
    return status ? `${said}\n${status}` : said;
}

/**
 * A plan: the step plus its `then` steps, each drawn when the previous one is
 * met, so a known path costs one call instead of a model round trip per step.
 * It stops at the first step that is not met, never skipping ahead.
 */
async function runPlan(
    main: StepSpec,
    then: Omit<StepSpec, 'window'>[],
    opts: Omit<StepOptions, 'findRetryMs' | 'label'>
): Promise<string> {
    const steps = [main, ...then];
    const p = parseProgress(main.prompt);
    const base = p ? p.n - 1 : 0;
    const total = Math.max(p?.of ?? 0, base + steps.length);
    const deadline = Date.now() + PLAN_MAX_MS;
    const results: StepResult[] = [];
    let window = main.window;

    for (const [i, s] of steps.entries()) {
        const n = base + i + 1;
        const label = `Step ${n}/${total}: `;
        const remaining = deadline - Date.now();
        if (i > 0 && (opts.signal.aborted || remaining < 1000)) break;
        const prompt = parseProgress(s.prompt) ? s.prompt : `${n}/${total} ${s.prompt}`;
        let r: StepResult;
        try {
            r = await runStep(
                { ...s, window, prompt },
                { ...opts, timeoutMs: Math.min(opts.timeoutMs, remaining), findRetryMs: i > 0 ? 3000 : 0, label }
            );
        } catch (err) {
            // The first step failing is the call failing; a later one is a
            // finding about the plan, reported with the progress made so far.
            if (i === 0) throw err;
            r = { ok: false, text: `${label}could not start: ${(err as Error).message}`, line: '', window };
        }
        results.push(r);
        if (!r.ok) break;
        window = r.window;
    }

    const lines = results.slice(0, -1).map(r => r.line);
    const lastResult = results[results.length - 1];
    if (lastResult) lines.push(lastResult.text);
    if (results.length < steps.length) {
        const why = opts.signal.aborted ? ' (the request was cancelled)' : lastResult?.ok ? ' (out of time)' : '';
        lines.push(`Stopped at step ${base + results.length}/${total}${why}; the steps after it were not shown.`);
    }
    return lines.join('\n');
}

// ------------------------------------------------------------- the tools

const untilSchema = () =>
    z.object({
        condition: z.enum(UNTIL_CONDITIONS),
        ...selectorFields(false),
        window: z.string().optional(),
        value: z.string().optional()
    });

export function registerGuide(server: McpServer): void {
    // ------------------------------------------------------- walkthrough step
    server.registerTool(
        'highlight_and_wait',
        {
            title: 'Point at something and wait',
            description:
                'One walkthrough step in one call: circle a control with your prompt and wait. ' +
                'With until, the user operates the app normally and this returns once the UI reaches that ' +
                'state (a dialog opens, a button enables). Without until, it waits for a confirming click, ' +
                'which the overlay captures: the app does not receive it.',
            inputSchema: {
                window: z.string().describe(WINDOW),
                ...selectorFields(),
                prompt: z.string().describe('What the user should do; captions the circle.'),
                until: untilSchema()
                    .optional()
                    .describe(
                        'The state that proves the step is done. Searched in the step\'s window unless window ' +
                            'is given; role "window" alone waits for a new top-level window.'
                    ),
                then: z
                    .array(
                        z.object({
                            ...selectorFields(false),
                            prompt: z.string(),
                            // Checked in the handler: a second copy of the until
                            // schema would be resent on every turn for nothing.
                            until: z.unknown()
                        })
                    )
                    .max(10)
                    .optional()
                    .describe(
                        'Next steps, until as above, in the window the last until matched; stops at the first not met.'
                    ),
                timeoutMs: z.number().int().min(1000).max(900000).default(120000),
                keep: z.boolean().default(false).describe('Leave the circle up afterwards.')
            }
        },
        (args, { signal }) =>
            guarded('highlight_and_wait', async () => {
                const main: StepSpec = {
                    window: args.window,
                    name: args.name,
                    automationId: args.automationId,
                    role: args.role,
                    prompt: args.prompt,
                    until: args.until
                };
                const opts = { timeoutMs: args.timeoutMs, keep: args.keep, signal };
                if (!args.then?.length) {
                    return text((await runStep(main, { ...opts, findRetryMs: 0, label: '' })).text);
                }
                if (!args.until) throw new Error('then needs until on this step too: a plan cannot wait for clicks');
                const then = args.then.map((s, i) => {
                    const until = untilSchema().safeParse(s.until);
                    if (!until.success) {
                        throw new Error(`then[${i}].until: ${until.error.issues[0]?.message ?? 'invalid'}`);
                    }
                    return { ...s, until: until.data };
                });
                return text(await runPlan(main, then, opts));
            })
    );

    // -------------------------------------------------------------- wait on UI
    server.registerTool(
        'wait_for_element',
        {
            title: 'Wait for the UI to reach a state',
            description:
                'Block until a control appears, disappears or becomes enabled, in one call instead of polling ' +
                'with screenshots. timeoutMs:0 checks once, which is how to assert state cheaply. role ' +
                '"window" without window waits for a top-level window. Returns NOT met on timeout.',
            inputSchema: {
                condition: z.enum(UNTIL_CONDITIONS),
                ...selectorFields(),
                value: z.string().optional().describe('Value substring or state, e.g. checked.'),
                window: z.string().optional().describe(`${WINDOW} Pass it: unscoped searches take seconds.`),
                timeoutMs: z.number().int().min(0).max(900000).default(60000)
            }
        },
        (args, { signal }) =>
            guarded('wait_for_element', async () => {
                if (args.condition !== 'changes' && !args.name && !args.role && !args.automationId) {
                    throw new Error('needs name, automationId or role to match against (or condition "changes")');
                }
                const req: WaitRequest = {
                    condition: args.condition,
                    window: args.window ? await resolveWindow(args.window) : undefined,
                    name: args.name,
                    role: isWindowRole(args.role) ? 'window' : args.role,
                    automationId: args.automationId,
                    value: args.value,
                    timeoutMs: args.timeoutMs,
                    pollMs: 500,
                    signal
                };
                // Only a real wait reports what else changed; an assertion stays one line.
                const before = args.timeoutMs > 0 ? await listWindows() : undefined;
                const outcome = await waitForElement(req);
                if (outcome.ended === 'aborted') return text('CANCELLED: the request was cancelled while waiting.');
                // A top-level window wait uses the window list and is fast anyway.
                const slow = !req.window && !isTopLevelWait(req) ? UNSCOPED_NOTE : '';
                const naming =
                    !outcome.met && !outcome.ended && !outcome.seen && req.condition !== 'changes'
                        ? '\nThe control may be named differently; describe_window shows what is there.'
                        : '';
                const after = before && outcome.met ? await afterBlock(before, undefined, undefined) : '';
                return text(waitSummary(req, outcome) + naming + slow + after);
            })
    );

    // --------------------------------------------------------------- ask user
    server.registerTool(
        'wait_for_user_click',
        {
            title: 'Ask the user to point at something',
            description:
                'Ask the user to click a point; returns it in every coordinate space. Use it instead of ' +
                'guessing what they mean. The overlay captures the click, so the app does not receive it. ' +
                'Escape cancels.',
            inputSchema: {
                prompt: z.string().describe('Shown on their screen.'),
                count: z.number().int().min(1).max(10).default(1),
                timeoutMs: z.number().int().min(1000).max(600000).default(60000),
                captureId: z.string().optional().describe('Map clicks into this capture. Default: the latest.')
            }
        },
        (args, { signal }) =>
            guarded('wait_for_user_click', async () => {
                const progress = parseProgress(args.prompt);
                const startedAt = Date.now();
                const a = await beginStep({
                    prompt: args.prompt,
                    mode: 'click',
                    count: args.count,
                    timeoutMs: args.timeoutMs,
                    captureId: args.captureId ?? store.latestCapture()?.id,
                    signal,
                    progress: progress ? { n: progress.n, of: progress.of } : undefined
                }).answer;
                const clicks =
                    a.kind === 'clicks' ? a.clicks : a.kind === 'timeout' || a.kind === 'cancelled' ? a.partial : [];
                const lines: string[] = [];
                for (const [i, c] of clicks.entries()) lines.push(await clickLine(c, i));
                const listed = lines.length ? `The user clicked:\n${lines.join('\n')}` : '';
                // Partial clicks lead with the status word, then the clicks that did come in.
                const said = answerText(a, Date.now() - startedAt);
                return text([said, listed].filter(Boolean).join('\n'));
            })
    );
}
