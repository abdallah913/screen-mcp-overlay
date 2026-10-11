import { AsyncLocalStorage } from 'node:async_hooks';
import { z } from 'zod';
import type { ShapeType } from '../../../shared/types.js';
import { DEFAULT_COLORS as PALETTE } from '../../../shared/palette.js';
import { clean } from '../../../shared/uitree.js';
import { notShared } from '../../../shared/windows.js';
import { NotSharedError, lastWindowList } from '../../uia.js';
import { noteRefused, sharedOf, sharedWindows } from '../../sharing.js';

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
 * Run a handler, turning anything it throws into an error the agent can read,
 * and making sure neither its result nor its error says anything about a
 * window the user has not shared (see agentSafe and redact).
 */
export async function guarded(tool: string, fn: () => Promise<Result>): Promise<Result> {
    try {
        return redactResult(await fn());
    } catch (err) {
        return redactResult(fail(`${tool}: ${await agentSafe(err as Error)}`));
    }
}

/**
 * Helper errors that say something about one window: that it closed, hangs, is
 * minimised or elsewhere. Every window is checked against the shared set
 * before the helper is asked, so these normally concern a shared window; one
 * that names a window that is not shared (the share was withdrawn mid-call, or
 * a path missed the check) must read like any window that is not open.
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

/**
 * The strings the agent itself sent in the current call. Text the agent
 * supplied is never redacted when echoed back: replacing its own words only
 * when they happen to be an open window's title would tell it the window is
 * open.
 */
const agentInput = new AsyncLocalStorage<string[]>();

function stringsIn(value: unknown, out: string[] = []): string[] {
    if (typeof value === 'string') out.push(value);
    else if (Array.isArray(value)) for (const v of value) stringsIn(v, out);
    else if (value && typeof value === 'object') for (const v of Object.values(value)) stringsIn(v, out);
    return out;
}

/** Run one tool call with the agent's own arguments in scope, for redact. */
export function withAgentInput<T>(args: unknown, fn: () => T): T {
    return agentInput.run(stringsIn(args), fn);
}

/** Below this length a title is a word ("Photos", "Mail") that shared content may well contain. */
const REDACT_MIN = 6;
const GENERIC = 'another window';

/**
 * Defence in depth behind every check that keeps unshared windows out of
 * responses: any full title of a window that is not shared, as seen in the
 * last window list, becomes "another window" wherever it appears. Whole
 * titles only, and only ones no shared title contains, so a shared page that
 * mentions "YouTube" or a shared window whose title includes the unshared one
 * reads as it is.
 */
export function redact(text: string): string {
    const all = lastWindowList();
    if (all.length === 0 || !text) return text;
    const shared = sharedOf(all);
    const sharedTitles = shared.map(w => w.title);
    const echoed = agentInput.getStore() ?? [];
    const forms = new Set<string>();
    for (const w of all) {
        if (shared.includes(w)) continue;
        // As printed raw, with whitespace collapsed, and cut where lists cut it.
        for (const t of [w.title.trim(), clean(w.title), clean(w.title).slice(0, 50)]) {
            if (t.length >= REDACT_MIN) forms.add(t);
        }
    }
    const titles = [...forms]
        .filter(t => !sharedTitles.some(s => s.includes(t) || clean(s).includes(t)))
        .filter(t => !echoed.some(e => e.includes(t)) && !GENERIC.includes(t))
        .sort((a, b) => b.length - a.length);
    let out = text;
    for (const t of titles) if (out.includes(t)) out = out.split(t).join(GENERIC);
    return out;
}

/** redact over every text block of a result; images are masked where they are made (capture.ts). */
export function redactResult<R extends { content: unknown[] }>(r: R): R {
    return {
        ...r,
        content: r.content.map(c =>
            c && typeof c === 'object' && (c as { type?: string }).type === 'text'
                ? { ...(c as { text: string }), text: redact((c as { text: string }).text) }
                : c
        )
    };
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
