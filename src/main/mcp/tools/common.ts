import { z } from 'zod';
import type { ShapeType } from '../../../shared/types.js';
import { DEFAULT_COLORS as PALETTE } from '../../../shared/palette.js';
import { notShared } from '../../../shared/windows.js';
import { NotSharedError } from '../../uia.js';
import { noteRefused, revocationCount, sharedWindows } from '../../sharing.js';

/*
 * Shared pieces of the tool layer.
 *
 * Token discipline. The tool list is resent on every turn of every
 * conversation, while a tool's response is paid only when the tool is used. So
 * descriptions say what a tool does and when to reach for it, and caveats that
 * only matter in the moment (an occluded window, an unscoped search, an app that
 * ignores wheel messages) live in the responses that trigger them.
 */

export type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
export type Result = { content: Content[]; isError?: true };

export const text = (t: string): Result => ({ content: [{ type: 'text', text: t }] });
export const fail = (t: string): Result => ({ content: [{ type: 'text', text: t }], isError: true });

/**
 * What a call hears when the user stopped sharing something while it ran.
 * Fixed, and the same whichever window it was: what was read may be from the
 * window the user just took back, and saying which would say more again.
 */
export const STOPPED_WHILE_RUNNING =
    'The user stopped sharing a window while this ran, so nothing from it is returned. list_windows shows what ' +
    'is shared now.';

/**
 * Run a handler, turning anything it throws into an error the agent can read.
 *
 * What keeps unshared windows out of a result is structural: every window is
 * checked against the shared set before anything is read from it, and only
 * shared windows are listed, described, searched or painted into a capture.
 * Nothing here rewrites a result by the titles of what is open: replacing a
 * private window's title wherever it appeared changed a shared page's text,
 * or the agent's own echoed guess, only while that window was open, which
 * told the agent it was open and what it was called.
 *
 * A share the user withdraws while the handler runs can still be in what it
 * read, so then nothing of the result goes back, whichever window it was.
 */
export async function guarded(tool: string, fn: () => Promise<Result>): Promise<Result> {
    const revocations = revocationCount();
    let result: Result;
    try {
        result = await fn();
    } catch (err) {
        result = fail(`${tool}: ${await agentSafe(err as Error)}`);
    }
    if (revocationCount() === revocations || ANSWERS_STOPS_ITSELF.has(tool)) return result;
    return fail(`${tool}: ${STOPPED_WHILE_RUNNING}`);
}

/**
 * Tools that watch for a share ending while they wait, and then stop reading
 * and answer in fixed words of their own (guide.ts, waits.ts). A walkthrough
 * step or a wait can run for many minutes, and the user stopping some other
 * share meanwhile must not throw away what the step found in the windows
 * still shared.
 */
const ANSWERS_STOPS_ITSELF = new Set(['highlight_and_wait', 'wait_for_element']);

/**
 * Helper errors that say something about one window: that it closed, hangs, is
 * minimised or elsewhere. Every window is checked against the shared set
 * before the helper is asked, so these normally concern a shared window; one
 * that names a window that is not shared (the share was withdrawn mid-call, or
 * a path missed the check) must read like any window that is not open. Judged
 * by the ref the error names alone, never by titles.
 */
const WINDOW_STATE = /no window for ref|not responding|has closed|closed|minimi[sz]ed|other (virtual )?desktop|could not be resolved/i;

async function agentSafe(err: Error): Promise<string> {
    if (err instanceof NotSharedError || err.name === 'NotSharedError') return err.message;
    if (!WINDOW_STATE.test(err.message)) return err.message;
    const refs = [...err.message.matchAll(/(?<![\w.])(-?\d{3,})(?![\w.])/g)].map(m => m[1]!);
    if (refs.length === 0) return err.message;
    const shared = await sharedWindows().catch(() => []);
    const unshared = refs.find(r => !shared.some(w => w.ref === r));
    if (unshared === undefined) return err.message;
    noteRefused(unshared);
    return notShared(unshared, shared);
}

/*
 * The server's last pass over every result (server.ts) once rewrote the
 * titles of windows that are not shared; that is what made it an oracle (see
 * guarded). These stay so the server's wrapper keeps working, and change
 * nothing: a result reads the same whatever else is open.
 */

export function withAgentInput<T>(_args: unknown, fn: () => T): T {
    return fn();
}

export function redact(text: string): string {
    return text;
}

export function redactResult<R extends { content: unknown[] }>(r: R): R {
    return r;
}

export const WINDOW = 'Shared window: ref, title substring or "foreground".';
export const CONDITIONS = ['appears', 'disappears', 'enabled'] as const;
export const SHAPE_TYPES = ['box', 'highlight', 'circle', 'arrow', 'label', 'spotlight', 'step'] as const;
/** Shapes drawn from a rectangle, as opposed to a point (arrow, label). */
export const RECT_SHAPES = new Set<ShapeType>(['box', 'highlight', 'circle', 'spotlight', 'step']);

export const DEFAULT_COLORS: Record<ShapeType, string> = PALETTE;

/**
 * Schema fragments shared by every tool that finds a control. Nested copies
 * (an anchor, an until) go undescribed: the model has already read the same
 * three fields at the top level of the tool, and every description is resent
 * on every turn.
 */
export const selectorFields = (described = true) => ({
    name: described ? z.string().optional().describe('Name substring.') : z.string().optional(),
    automationId: described
        ? z.string().optional().describe('Exact AutomationId; beats name.')
        : z.string().optional(),
    role: described ? z.string().optional().describe('Control type.') : z.string().optional()
});
export const regionField = () =>
    z
        .object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })
        .optional()
        .describe('Display-physical px.');

/** "window" and its alias "dialog" mean a top-level window, found via the window list. */
export function isWindowRole(role: string | undefined): boolean {
    return role !== undefined && ['window', 'dialog'].includes(role.trim().toLowerCase());
}
