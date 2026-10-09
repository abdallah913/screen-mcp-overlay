import { screen } from 'electron';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import type { Annotation, ClickResult, Rect, SnapshotNode, StepAnswer } from '../../../shared/types.js';
import { rectContains } from '../../../shared/geometry.js';
import { parseProgress } from '../../../shared/progress.js';
import { clean, diffLines, elementLine, toSnapshotNodes, whereIn, type TreeRow } from '../../../shared/uitree.js';
import { store } from '../../store.js';
import { beginStep } from '../../steps.js';
import { postToHud } from '../../hud.js';
import { listDisplays } from '../../displays.js';
import {
    coverage,
    describeWindow,
    elementAtPoint,
    knownControl,
    listAllWindows,
    resolveRefs,
    resolveWindow,
    type Coverage,
    type PointHit,
    type WindowInfo
} from '../../uia.js';
import {
    changesBaseline,
    isTopLevelWait,
    waitForElement,
    type WaitCondition,
    type WaitOutcome,
    type WaitRequest
} from '../../waits.js';
import { answerText } from './answers.js';
import { CONDITIONS, DEFAULT_COLORS, WINDOW, guarded, isWindowRole, selectorFields, text } from './common.js';
import { anchorNotes, placeAnchored, resolveAnchor, type ResolvedAnchor } from './anchoring.js';

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

/**
 * What was circled and where, for the response and the panel's step card. The
 * resolver already says where the target sits when it could tell
 * (resolveAnchor's label is "what, where"); only fill the gap when it could not.
 */
function targetLabel(target: ResolvedAnchor, windowRef: string, windows: WindowInfo[]): string {
    if (target.where) return target.label;
    const win = windows.find(w => w.ref === windowRef);
    const spot = win ? whereIn(target.rect, win.rect) : null;
    return `${target.label}, ${spot && win ? `${spot} of ${quote(win.title)}` : `in window ${windowRef}`}`;
}

/** Physical virtual-screen pixels to global DIPs, through Electron: mixed scaling is not a uniform factor. */
function toDip(r: Rect): Rect {
    const tl = screen.screenToDipPoint({ x: r.x, y: r.y });
    const br = screen.screenToDipPoint({ x: r.x + r.width, y: r.y + r.height });
    return {
        x: Math.round(tl.x),
        y: Math.round(tl.y),
        width: Math.max(1, Math.round(br.x - tl.x)),
        height: Math.max(1, Math.round(br.y - tl.y))
    };
}

function overlapArea(a: Rect, b: Rect): number {
    const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
    const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
    return w > 0 && h > 0 ? w * h : 0;
}

/** Below this share of the target on any display, the user may not see the circle at all. */
const MIN_ON_SCREEN = 0.5;

/**
 * Where the circle is, when that is somewhere the user may not be looking:
 * mostly past the edge of every display, or on another display than the
 * window in front of them (usually the agent's own terminal). Null when it is
 * in plain view. The overlay points the way on screen; this lets the agent
 * say it in words too.
 */
function displayNote(rect: Rect, windows: WindowInfo[]): string | null {
    const displays = screen.getAllDisplays();
    const dip = toDip(rect);
    const inside = displays.reduce((sum, d) => sum + overlapArea(dip, d.bounds), 0);
    const share = inside / (dip.width * dip.height);
    if (share < MIN_ON_SCREEN) {
        const how = share === 0 ? 'off-screen' : `partly off-screen (${Math.round(share * 100)}% visible)`;
        return `Note: the target is ${how}; ask the user to move its window into view.`;
    }
    const front = windows.find(w => w.foreground && onScreen(w));
    if (displays.length < 2 || !front) return null;
    const home = screen.getDisplayMatching(dip);
    const theirs = screen.getDisplayMatching(toDip(front.rect));
    if (home.id === theirs.id) return null;
    // Numbered as list_displays numbers them.
    const n = (id: number): number => displays.findIndex(d => d.id === id) + 1;
    return (
        `Note: the target is on display ${n(home.id)}, while the window in front (${quote(front.title)}) is on ` +
        `display ${n(theirs.id)}; tell the user which screen to look at.`
    );
}

/** Why a circled control left the screen, in the user's terms, when the tracker could tell. */
function goneWhy(reason: Annotation['hiddenReason'], windowTitle: string): string | undefined {
    switch (reason) {
        case 'minimized':
            return `${quote(windowTitle)} was minimised`;
        case 'closed':
            return `${quote(windowTitle)} closed`;
        case 'other-desktop':
            return `${quote(windowTitle)} is on another virtual desktop`;
        default:
            // The control itself went (a page changed, a panel closed): no more to say.
            return undefined;
    }
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
    // Raising the app would not help when our own panel is what is on top,
    // and the agent cannot move it: only the user can.
    const fix = by.every(t => t === PANEL)
        ? 'ask the user to drag the chat panel aside or hide it with Ctrl+Shift+O.'
        : `focus_window {window:${JSON.stringify(windowTitle)}} brings it forward.`;
    return `WARNING: ${what} is ${Math.round(c.fraction * 100)}% behind ${by.slice(0, 2).map(quote).join(', ')}; ${fix}`;
}

/** How the helper names the chat panel when it is what covers a target. */
const PANEL = "the overlay's chat panel";

/**
 * Coverage of a control, measured against the top-level window it actually
 * lives in: a menu item's own open menu, not the app window under it, or
 * every menu step would warn that the item is behind its menu.
 */
async function coverageOf(windowRef: string, rect: Rect, controlRef?: string): Promise<Coverage | null> {
    const known = controlRef ? knownControl(controlRef) : undefined;
    const top = known?.top || windowRef;
    try {
        return await coverage(top, rect, known?.selector.role);
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
    if (circle.hidden) {
        const why = goneWhy(circle.hiddenReason, windowTitle);
        return why
            ? `The circled control is not on screen now: ${why}.`
            : 'The circled control is not on screen now (it went away, or its window is minimised).';
    }
    let rect: Rect | null = null;
    try {
        const [live] = await resolveRefs([circle.anchor.ref]);
        if (live?.offscreen) return 'The circled control is scrolled out of view; scroll_window brings it into view.';
        rect = live?.rect ?? null;
    } catch {
        return '';
    }
    if (!rect) return 'The circled control is not on screen now.';
    const c = await coverageOf(windowRef, rect, circle.anchor.ref);
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

/**
 * Display-local DIPs to global DIPs. A drawing belongs to one display but is
 * drawn on every display it overlaps, so a click on another monitor can still
 * land inside it; comparing in global space is what makes that count.
 */
function toGlobal(displayId: string, r: Rect): Rect | null {
    const d = screen.getAllDisplays().find(x => String(x.id) === displayId);
    return d ? { x: d.bounds.x + r.x, y: d.bounds.y + r.y, width: r.width, height: r.height } : null;
}

function clickInside(a: Annotation, c: ClickResult): boolean {
    const box = toGlobal(a.displayId, a.rect);
    const at = toGlobal(c.displayId, { x: c.dip.x, y: c.dip.y, width: 0, height: 0 });
    return Boolean(box && at && rectContains(box, at));
}

/** Which of the current drawings a click landed inside. */
function drawingsAt(c: ClickResult): string[] {
    return store
        .list()
        .filter(a => !a.hidden && a.type !== 'done' && clickInside(a, c))
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

async function snapshotOf(windowRef: string): Promise<{ id: string; nodes: TreeRow[] } | undefined> {
    try {
        // The same budget as describe_window's default, so since= diffs line up.
        const { nodes, unanswered } = await describeWindow({ window: windowRef, maxNodes: 120 });
        // Part of the window would diff as rows removed that are still there.
        if (unanswered) return undefined;
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

interface WindowDelta {
    opened: WindowInfo[];
    closed: WindowInfo[];
    /** Still open, but minimised since: not closed, and the user can bring it back. */
    minimized: WindowInfo[];
}

/** Windows that opened, closed or were minimised since `before`; both lists include minimised windows. */
function windowDelta(before: WindowInfo[], now: WindowInfo[]): WindowDelta {
    const was = new Map(before.map(w => [w.ref, w]));
    const is = new Set(now.map(w => w.ref));
    return {
        opened: now.filter(w => !was.has(w.ref)),
        closed: before.filter(w => !is.has(w.ref)),
        minimized: now.filter(w => w.minimized && was.get(w.ref)?.minimized === false)
    };
}

function windowLines(d: WindowDelta): string[] {
    return [
        ...d.opened
            .slice(0, LIST_CAP)
            .map(w => `+ window ${w.ref} ${quote(w.title)}${w.foreground ? ' [foreground]' : ''}`),
        ...d.closed.slice(0, LIST_CAP).map(w => `- window ${w.ref} ${quote(w.title)}`),
        ...d.minimized.slice(0, LIST_CAP).map(w => `~ window ${w.ref} ${quote(w.title)} minimised`)
    ];
}

/** A window the user can see: one that opened minimised or on another desktop is not news. */
const onScreen = (w: WindowInfo): boolean => !w.minimized && !w.cloaked;

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
        now = await listAllWindows();
    } catch {
        return '';
    }
    const delta = windowDelta(before, now);
    const lines = windowLines(delta);

    const shown = delta.opened.filter(onScreen);
    const fresh = shown.find(w => w.foreground) ?? shown[0];
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
    /** The response already warns that the target is covered. */
    warnedCovered?: boolean;
}): Promise<string> {
    const out: string[] = [];
    let now: WindowInfo[] | undefined;
    try {
        now = await listAllWindows();
    } catch {
        // Leave the window part out rather than fail the report: against an
        // empty list, every window would read as closed.
    }
    const delta = now ? windowDelta(ctx.before, now) : { opened: [], closed: [], minimized: [] };
    const { closed } = delta;
    const opened = delta.opened.filter(onScreen);
    const listed = windowLines(delta);
    if (listed.length) out.push(`Since the step began:\n${listed.join('\n')}`);
    const front = now?.find(w => w.foreground);
    if (front) out.push(`Foreground: ${quote(front.title)}.`);

    const status = await targetStatus(ctx.circleId, ctx.windowRef, ctx.windowTitle);
    if (status && !(ctx.warnedCovered && status.startsWith('WARNING:'))) out.push(status);

    let changed = false;
    // Whether the window was read at both ends: an app that stopped answering
    // leaves only the window list to go on.
    let compared = false;
    let unread = 0;
    if (ctx.start) {
        const snap = await snapshotOf(ctx.windowRef);
        compared = Boolean(snap);
        unread = snap?.nodes.reduce((sum, n) => sum + (n.unread ?? 0), 0) ?? 0;
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
    } else if (!compared && !now) {
        // Neither the window nor the window list could be read: nothing is
        // known to have changed or not, so say nothing either way.
    } else if (!changed && !closed.length) {
        // Without a snapshot only the window list was watched, so say just that.
        const what = compared ? 'Nothing changed' : 'No window opened or closed';
        out.push(`${what}: the user may still be working or looking elsewhere; rephrase rather than repeat.`);
        // Rows skipped in long lists are in neither snapshot, so a box ticked
        // far down a list cannot show as a change.
        if (unread) out.push(`${unread} row(s) of long lists were not read; to watch one, name it in until.`);
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
        baseline: before
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

/**
 * The one check before drawing. A failed check loses only this guard, not the
 * step; nor does a window that is gone answer anything about what the user
 * did, so it is no answer rather than "disappears: already true".
 */
async function precheck(plan: WaitPlan): Promise<WaitOutcome | undefined> {
    const o = await waitForElement({ ...plan, timeoutMs: 0, pollMs: 0 }).catch(() => undefined);
    return o?.windowClosed ? undefined : o;
}

/** The window an until settled in: the window it matched, else the one it searched. */
function settledIn(o: WaitOutcome, plan: WaitPlan, windowRef: string): string {
    return o.element?.role === 'window' ? o.element.ref : (plan.window ?? windowRef);
}

/**
 * The window a plan's next step runs in. Usually where this step's until
 * settled, but a step that closes a dialog ("Click OK") settles in a window
 * that no longer exists, and the user is back in the app's other window: the
 * one in front, else any. Failing that, whatever is in front now.
 */
async function nextWindow(ref: string, before: WindowInfo[]): Promise<string> {
    let now: WindowInfo[];
    try {
        now = await listAllWindows();
    } catch {
        // The next step resolves the window itself and reports what it finds.
        return ref;
    }
    if (now.some(w => w.ref === ref)) return ref;
    const pid = before.find(w => w.ref === ref)?.pid;
    const shown = now.filter(onScreen);
    const sameApp = shown.filter(w => w.pid === pid);
    return (sameApp.find(w => w.foreground) ?? sameApp[0] ?? shown.find(w => w.foreground))?.ref ?? ref;
}

/** How long the "All N steps done" label stays up. */
const FINISHED_TTL_MS = 3000;
/** How far below the circle the "All N steps done" label sits, in DIPs: clear of the check mark's caption. */
const FINISHED_GAP = 40;

/**
 * Swap the step's circle for a brief check mark, so the user sees the step
 * registered, and on a walkthrough's last step say the whole thing is done.
 * With keep the circle stays, and only the closing label is added.
 */
function confirmOnScreen(circleId: string | undefined, opts: { keep: boolean; finished?: number }): void {
    const circle = circleId ? store.list().find(a => a.id === circleId) : undefined;
    if (!circle) return;
    const now = Date.now();
    const shown: Annotation[] = [];
    if (!opts.keep) {
        store.clear([circle.id]);
        // A target that went away (the dialog the user just closed) has no place to tick.
        if (!circle.hidden) {
            shown.push({
                id: store.nextId('ann'),
                displayId: circle.displayId,
                type: 'done',
                rect: circle.rect,
                text: 'Got it',
                color: DEFAULT_COLORS.done,
                thickness: circle.thickness,
                createdAt: now,
                expiresAt: now + DONE_TTL_MS
            });
        }
    }
    if (opts.finished) {
        // Where the user was last looking, even when the dialog they closed took
        // the target with it: a hidden circle keeps its last visible place.
        shown.push({
            id: store.nextId('ann'),
            displayId: circle.displayId,
            type: 'label',
            rect: {
                x: circle.rect.x + circle.rect.width / 2,
                y: circle.rect.y + circle.rect.height + FINISHED_GAP,
                width: 0,
                height: 0
            },
            text: `All ${opts.finished} steps done`,
            color: DEFAULT_COLORS.done,
            createdAt: now,
            expiresAt: now + FINISHED_TTL_MS
        });
    }
    if (shown.length > 0) store.add(shown);
}

/** Drawings that outlive the step, so the agent can clear them when the task is done. */
function othersStillUp(ours: Set<string>): string {
    const others = store.list().filter(a => !a.expiresAt && !ours.has(a.id));
    if (others.length === 0) return '';
    const listed = others.slice(0, LIST_CAP).map(a => a.id).join(', ');
    const more = others.length > LIST_CAP ? ', …' : '';
    return `\n${others.length} other drawing(s) still up (${listed}${more}); clear_annotations when the task is done.`;
}

function giveUpWhenGone(circleId: string | undefined, windowTitle: string): (() => string | null) | undefined {
    if (!circleId) return undefined;
    return () => {
        const a = store.list().find(x => x.id === circleId);
        if (!a?.hidden || a.hiddenSince === undefined) return null;
        const gone = Date.now() - a.hiddenSince;
        if (gone < TARGET_GONE_MS) return null;
        const why = goneWhy(a.hiddenReason, windowTitle);
        return `the circled control went away ${Math.round(gone / 1000)}s ago${why ? ` (${why})` : ''}`;
    };
}

/** The longest stretch the circled control spent off screen during a step. */
interface HiddenStretch {
    ms: number;
    reason?: Annotation['hiddenReason'];
    /** Still off screen when the step ended. */
    ongoing: boolean;
}

/** Off screen at least this long during a step, the response says so. */
const HIDDEN_NOTE_MS = 5000;

/**
 * Watch the circle for the step's length. The overlay hides a drawing whose
 * target went away, which takes the step's only on-screen instruction with
 * it, so the agent hears about any long stretch of that, even one that ended.
 * `onGone` fires once the target has been gone TARGET_GONE_MS. Returns the
 * function that stops watching and reports the longest stretch.
 */
function watchHidden(circleId: string | undefined, onGone?: () => void): () => HiddenStretch | undefined {
    if (!circleId) return () => undefined;
    let longest: HiddenStretch | undefined;
    let since: number | undefined;
    let reason: Annotation['hiddenReason'];
    let timer: NodeJS.Timeout | undefined;
    const close = (ongoing: boolean): void => {
        if (since === undefined) return;
        const ms = Date.now() - since;
        if (!longest || ms >= longest.ms) longest = { ms, reason, ongoing };
    };
    // A timer can run a millisecond before Date.now() reaches its time; onGone
    // would then find the target not gone long enough, and nothing re-armed it.
    const arm = (from: number): void => {
        clearTimeout(timer);
        const left = from + TARGET_GONE_MS - Date.now();
        if (left <= 0) onGone?.();
        else timer = setTimeout(() => arm(from), left);
    };
    const update = (): void => {
        const a = store.list().find(x => x.id === circleId);
        if (a?.hidden && a.hiddenSince !== undefined) {
            if (since !== a.hiddenSince) {
                since = a.hiddenSince;
                if (onGone) arm(since);
            }
            reason = a.hiddenReason ?? reason;
        } else if (since !== undefined) {
            close(false);
            since = undefined;
            reason = undefined;
            clearTimeout(timer);
        }
    };
    store.on('annotations', update);
    update();
    return () => {
        update();
        store.off('annotations', update);
        clearTimeout(timer);
        close(true);
        return longest;
    };
}

function hiddenNote(stretch: HiddenStretch | undefined, windowTitle: string): string {
    if (!stretch || stretch.ms < HIDDEN_NOTE_MS) return '';
    const secs = Math.round(stretch.ms / 1000);
    const why = goneWhy(stretch.reason, windowTitle);
    return stretch.ongoing
        ? `Note: the circled control has been off screen for ${secs}s${why ? `: ${why}` : ''}.`
        : `Note: the circled control was off screen for ${secs}s during the step${why ? ` (${why})` : ''}.`;
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
    const before = await listAllWindows();
    const windowTitle = clean(before.find(w => w.ref === windowRef)?.title ?? windowRef);
    const plan = u ? await waitPlan(u, windowRef, before) : undefined;
    const result = (ok: boolean, body: string, line = body.split('\n')[0]!, next = windowRef): StepResult => ({
        ok,
        text: prefixed(opts.label, body),
        line: prefixed(opts.label, line),
        window: next
    });

    // The target first, with its retry: in a plan the window may still be
    // filling in, and the until must be read from the same tree the target
    // was found in, or a half-built dialog reads as "disappears: already true".
    let target: ResolvedAnchor | undefined;
    let missing: unknown;
    if (spec.name || spec.automationId || spec.role) {
        try {
            target = await findTarget(spec, windowRef, opts.findRetryMs, opts.signal);
        } catch (err) {
            missing = err;
        }
    }

    // Checked before drawing: a step whose until already holds would confirm
    // at once, and the agent would move on while the user is still a step behind.
    const pre = plan && needsPrecheck(plan) ? await precheck(plan) : undefined;

    if (missing !== undefined) {
        // Only a match shows the user is ahead. An absence cannot tell "ahead"
        // from "not there yet" or "misnamed", and "disappears" usually reuses
        // the target's own selector, so its miss stands.
        if (pre?.met && plan && plan.condition !== 'disappears') {
            const seen = pre.element ? `\n${elementLine(pre.element)}` : '';
            const next = await nextWindow(settledIn(pre, plan, windowRef), before);
            const body = `Already done (the user was ahead): ${untilText(u!)} already holds.${seen}`;
            return result(true, body, undefined, next);
        }
        throw missing;
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
    let warnedCovered = false;
    if (target) {
        // Scrolled out, the rect is real but points at whatever is in front of
        // it now; drawing there would send the user to the wrong control.
        const [live] = target.offscreen ? [] : await resolveRefs([target.ref]).catch(() => []);
        if (target.offscreen || live?.offscreen) {
            return result(
                false,
                `NOT started: ${target.what} is scrolled out of view in ${quote(windowTitle)}; call scroll_window ` +
                    'with its name, or ask the user to scroll.'
            );
        }
        const c = await coverageOf(target.top ?? windowRef, target.rect, target.ref);
        const covered = c && coveredNote(c, target.what, windowTitle);
        if (covered) {
            warnings.push(covered);
            warnedCovered = true;
        }
        // The resolver's own notes (an ambiguous name, a window found on
        // another desktop), less the two this step has just reported its own way.
        const notes = anchorNotes({ ...target, offscreen: undefined, covered: undefined }).trim();
        if (notes) warnings.push(notes);
        const elsewhere = displayNote(target.rect, before);
        if (elsewhere) warnings.push(elsewhere);
    }

    // What "changes" compares against, and the After block's starting point,
    // are read before the user is shown the step: one quick to act on a slow
    // app would otherwise have their change taken as how things started.
    const since = plan ? await changesBaseline(plan) : undefined;
    // A snapshot of the step window, for the After block and the failure
    // digest; only when the until searches that window, since it costs a describe.
    const start = plan && plan.window === windowRef && !isTopLevelWait(plan) ? await snapshotOf(windowRef) : undefined;

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
    const label = target ? targetLabel(target, windowRef, before) : undefined;
    const circled = label ? `Circled ${label}.` : '';
    const notes: string[] = [];
    const tail = (body: string): string => [body, circled, ...warnings, ...notes].filter(Boolean).join('\n');
    const lineOf = (status: string): string => [status, circled].filter(Boolean).join(' ');
    const clearCircle = (): void => {
        if (!opts.keep && circleId) store.clear([circleId]);
    };
    // With keep, the circle outlives the step, but it is still this step's.
    const ours = new Set(drawn.map(a => a.id));

    const progress = parseProgress(spec.prompt);
    // A walkthrough's last step, when it is met, closes the whole walkthrough on screen.
    const finished = progress && progress.n === progress.of ? progress.of : undefined;
    const step = beginStep({
        prompt: spec.prompt,
        mode: plan ? 'watch' : 'click',
        count: 1,
        timeoutMs: opts.timeoutMs,
        signal: opts.signal,
        targetIds: drawn.map(a => a.id),
        progress: progress ? { n: progress.n, of: progress.of } : undefined,
        target: label
    });
    const startedAt = Date.now();
    const gone = giveUpWhenGone(circleId, windowTitle);

    // ---- click mode: the overlay captures one click
    if (!plan) {
        // A target that went away cannot be clicked; waiting out the timeout
        // would hold a crosshair over the screen for nothing.
        let goneFor: string | null = null;
        const stopWatching = watchHidden(circleId, () => {
            goneFor = gone?.() ?? null;
            if (goneFor) step.end();
        });
        // Cleared by another client, or retired by the tracker: with nothing
        // to point at, the next click anywhere would read as the target.
        const removed = (): void => {
            if (circleId && !store.list().some(x => x.id === circleId)) {
                goneFor ??= 'the circle was cleared before the user clicked';
                step.end();
            }
        };
        store.on('annotations', removed);
        const a = await step.answer;
        store.off('annotations', removed);
        const stretch = stopWatching();
        const waited = Date.now() - startedAt;
        const verdict =
            a.kind === 'ended' && goneFor
                ? { ok: false, text: `NOT done: ${goneFor}, so the user could not click it.` }
                : a.kind === 'clicks' && a.clicks[0]
                  ? await clickVerdict(a.clicks[0], circleId, windowRef, windowTitle)
                  : { ok: false, text: await userOutcome(a, waited, circleId, windowRef, windowTitle) };
        if (!goneFor) notes.push(hiddenNote(stretch, windowTitle));
        if (verdict.ok) confirmOnScreen(circleId, { keep: opts.keep, finished });
        else clearCircle();
        return result(verdict.ok, tail(verdict.text) + (verdict.ok ? othersStillUp(ours) : ''));
    }

    // ---- watch mode: the user works in the app while the UI is polled
    const stopWatching = watchHidden(circleId);
    const stop = new AbortController();
    const last = new AbortController();
    const waiting = waitForElement({
        ...plan,
        since,
        timeoutMs: opts.timeoutMs,
        pollMs: 400,
        signal: stop.signal,
        lastCheck: last.signal,
        giveUp: gone
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
        const lastLook = answer.kind === 'done' || answer.kind === 'timeout';
        if (lastLook) last.abort(answer.kind);
        else stop.abort();
        const settled = await waiting;
        if (lastLook) {
            // The user has answered, so this is their outcome, not an error:
            // a helper that failed even its first check leaves the until unknown.
            outcome =
                'err' in settled
                    ? {
                          met: false,
                          waitedMs: Date.now() - startedAt,
                          polls: 0,
                          ended: 'unchecked',
                          reason: settled.err.message
                      }
                    : settled.o;
        }
    } else {
        step.end();
        if ('err' in first) {
            stopWatching();
            clearCircle();
            throw first.err;
        }
        outcome = first.o;
    }
    if (outcome?.ended !== 'gave-up') notes.push(hiddenNote(stopWatching(), windowTitle));
    else stopWatching();

    const req: WaitRequest = { ...plan, timeoutMs: opts.timeoutMs, pollMs: 400 };

    if (outcome?.met) {
        const how = answer?.kind === 'done' ? ' (checked when the user pressed Done)' : '';
        const summary = waitSummary(req, outcome, how);
        confirmOnScreen(circleId, { keep: opts.keep, finished });
        const after = await afterBlock(before, plan.window, start);
        const next = await nextWindow(settledIn(outcome, plan, windowRef), before);
        return result(true, tail(summary) + after + othersStillUp(ours), lineOf(summary.split('\n')[0]!), next);
    }

    if (outcome && (answer === undefined || answer.kind === 'timeout' || answer.kind === 'done')) {
        const head =
            outcome.ended === 'unchecked'
                ? `${answer?.kind === 'done' ? 'DONE' : 'NOT checked: timed out'} after ` +
                  `${Math.round((Date.now() - startedAt) / 1000)}s; the until could not be checked ` +
                  `(helper error: ${outcome.reason}): ${untilText(u!)}.`
                : answer?.kind === 'done'
                  ? `DONE after ${Math.round((Date.now() - startedAt) / 1000)}s, but the until is NOT met: ` +
                    `${untilText(u!)}.${seenNote(req, outcome)}`
                  : waitSummary(req, outcome);
        const digest = await failureDigest({
            req,
            before,
            windowRef,
            windowTitle,
            start,
            circleId,
            warnedCovered
        });
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
    windowRef: string,
    windowTitle: string
): Promise<{ ok: boolean; text: string }> {
    const where = `${click.physical.x},${click.physical.y} on display ${click.displayId}`;
    // The circle as it was when the user clicked: the tracker may have moved it
    // since it was drawn, and moves it again while the click is being named,
    // which can take seconds on a slow app.
    const atClick = circleId ? store.list().find(x => x.id === circleId) : undefined;
    const circle = atClick ? { ...atClick } : undefined;
    const named = await nameClick(click);
    const on = named ? `, on ${named}` : '';
    if (!circleId) return { ok: true, text: `The user clicked at ${where}${on}.` };
    if (!circle) {
        return {
            ok: false,
            text: `The user clicked at ${where}${on}, but the circle had been cleared by then, so it was not a click on the target.`
        };
    }

    // The circle was not drawn, so whatever they clicked, it was not the target.
    if (circle.hidden) {
        const why = goneWhy(circle.hiddenReason, windowTitle);
        return {
            ok: false,
            text:
                `The user clicked at ${where}${on}, but the circled control was not on screen then` +
                `${why ? ` (${why})` : ''}. The app did not receive that click.`
        };
    }

    if (!clickInside(circle, click)) {
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
        const c = live?.rect ? await coverageOf(windowRef, live.rect, circle.anchor.ref) : null;
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
        // The plan's own count wins over whatever prefix a prompt carried, so
        // the pill, the "All N steps done" mark and the labels here agree.
        const prompt = `${n}/${total} ${parseProgress(s.prompt)?.rest ?? s.prompt}`;
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

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/** How often a blocked call tells its client it is still waiting. */
const PROGRESS_EVERY_MS = 10_000;

/**
 * Run a wait on the user while telling the client it is alive. Clients time a
 * tool call out (60 s is common) and a step can take minutes; one that resets
 * its clock on progress keeps the call open as long as the user needs. Only
 * when the request asked for progress (it carries a progressToken); a lost
 * notification costs nothing but that reset.
 */
async function withProgress<T>(extra: Extra, message: string, run: () => Promise<T>): Promise<T> {
    const token = extra._meta?.progressToken;
    if (token === undefined) return run();
    const started = Date.now();
    const send = (): void => {
        const progress = Math.round((Date.now() - started) / 1000);
        extra
            .sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress, message } })
            .catch(() => {});
    };
    send();
    const timer = setInterval(send, PROGRESS_EVERY_MS);
    timer.unref?.();
    try {
        return await run();
    } finally {
        clearInterval(timer);
    }
}

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
                // The one followability rule carried in the tool list itself:
                // some clients drop server instructions.
                prompt: z.string().describe('One action in the app\'s own words, e.g. "2/5 Click Export".'),
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
        (args, extra) =>
            guarded('highlight_and_wait', async () => {
                const { signal } = extra;
                const main: StepSpec = {
                    window: args.window,
                    name: args.name,
                    automationId: args.automationId,
                    role: args.role,
                    prompt: args.prompt,
                    until: args.until
                };
                const opts = { timeoutMs: args.timeoutMs, keep: args.keep, signal };
                const waiting = `Waiting for the user: ${clean(args.prompt)}`;
                if (!args.then?.length) {
                    const single = { ...opts, findRetryMs: 0, label: '' };
                    return text((await withProgress(extra, waiting, () => runStep(main, single))).text);
                }
                if (!args.until) throw new Error('then needs until on this step too: a plan cannot wait for clicks');
                const then = args.then.map((s, i) => {
                    const until = untilSchema().safeParse(s.until);
                    if (!until.success) {
                        throw new Error(`then[${i}].until: ${until.error.issues[0]?.message ?? 'invalid'}`);
                    }
                    return { ...s, until: until.data };
                });
                return text(await withProgress(extra, waiting, () => runPlan(main, then, opts)));
            })
    );

    // -------------------------------------------------------------- wait on UI
    server.registerTool(
        'wait_for_element',
        {
            title: 'Wait for the UI to reach a state',
            description:
                'Block until a control appears, disappears, becomes enabled or changes (name, value, state; ' +
                'with no selector, a window opening or closing), in one call instead of polling with ' +
                'screenshots. timeoutMs:0 checks once: a cheap assertion. role "window" without window waits ' +
                'for a top-level window.',
            inputSchema: {
                condition: z.enum(UNTIL_CONDITIONS),
                ...selectorFields(),
                value: z.string().optional().describe('Value substring or state, e.g. checked.'),
                window: z.string().optional().describe(`${WINDOW} Pass it: unscoped searches take seconds.`),
                timeoutMs: z.number().int().min(0).max(900000).default(60000)
            }
        },
        (args, extra) =>
            guarded('wait_for_element', async () => {
                const { signal } = extra;
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
                const before = args.timeoutMs > 0 ? await listAllWindows() : undefined;
                const outcome = await withProgress(extra, `Waiting for "${req.condition}"`, () => waitForElement(req));
                if (outcome.ended === 'aborted') return text('CANCELLED: the request was cancelled while waiting.');
                // No user is waiting on this answer, so a helper that failed the
                // last look is the error it is, not a verdict on the condition.
                if (outcome.ended === 'unchecked') throw new Error(`the final check failed: ${outcome.reason}`);
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
        (args, extra) =>
            guarded('wait_for_user_click', async () => {
                const { signal } = extra;
                const progress = parseProgress(args.prompt);
                const startedAt = Date.now();
                const step = beginStep({
                    prompt: args.prompt,
                    mode: 'click',
                    count: args.count,
                    timeoutMs: args.timeoutMs,
                    captureId: args.captureId ?? store.latestCapture()?.id,
                    signal,
                    progress: progress ? { n: progress.n, of: progress.of } : undefined
                });
                const a = await withProgress(extra, `Waiting for the user: ${clean(args.prompt)}`, () => step.answer);
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
