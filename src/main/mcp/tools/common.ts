import { z } from 'zod';
import type { ShapeType } from '../../../shared/types.js';
import { DEFAULT_COLORS as PALETTE } from '../../../shared/palette.js';

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

/** Run a handler, turning anything it throws into an error the agent can read. */
export async function guarded(tool: string, fn: () => Promise<Result>): Promise<Result> {
    try {
        return await fn();
    } catch (err) {
        return fail(`${tool}: ${(err as Error).message}`);
    }
}

export const WINDOW = 'Ref, title substring, or "foreground".';
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
