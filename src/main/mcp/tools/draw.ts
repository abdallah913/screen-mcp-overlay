import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { store } from '../../store.js';
import { SHAPE_TYPES, guarded, text } from './common.js';
import { ids, placeAnchored, placeFixed, resolveAnchor } from './anchoring.js';

/** Drawing: annotate and clear_annotations. */

export function registerDraw(server: McpServer): void {
    // ---------------------------------------------------------------- annotate
    server.registerTool(
        'annotate',
        {
            title: 'Draw on the screen',
            description:
                'Draw on the real screen; click-through, so the user keeps working. box, highlight, circle, ' +
                'step (numbered) and spotlight (dims the rest) take x,y,width,height; arrow takes x,y to ' +
                'toX,toY; label takes x,y,text. text captions any shape. Anchor to a control so drawings ' +
                'follow it: fixed coordinates go stale when a window moves. Replaces earlier drawings unless ' +
                'replace:false.',
            inputSchema: {
                // No `kind` and no per-shape `fit`: both are inferred (see
                // resolveAnchor and fits), and still honoured internally.
                anchor: z
                    .object({
                        window: z.string().optional(),
                        name: z.string().optional().describe('Name substring.'),
                        automationId: z.string().optional().describe('Exact AutomationId; beats name.'),
                        role: z.string().optional().describe('Control type.'),
                        ref: z.string().optional()
                    })
                    .optional()
                    .describe(
                        'Follow a target: {window, name|automationId|role} for a control (re-found if rebuilt), ' +
                            '{window} for a window, {ref} for a ref. x,y become px offsets from its top-left; ' +
                            'shapes without width/height fit it.'
                    ),
                shapes: z
                    .array(
                        z.object({
                            type: z.enum(SHAPE_TYPES),
                            x: z.number().optional(),
                            y: z.number().optional(),
                            width: z.number().optional(),
                            height: z.number().optional(),
                            toX: z.number().optional(),
                            toY: z.number().optional(),
                            text: z.string().optional(),
                            pad: z.number().optional().describe('Px around a fitted shape. Default 4.'),
                            color: z.string().optional().describe('CSS color.'),
                            thickness: z.number().optional(),
                            dim: z.number().min(0).max(1).optional().describe('Spotlight darkness.'),
                            pulse: z.boolean().optional()
                        })
                    )
                    .min(1),
                space: z
                    .enum(['image', 'physical', 'dip', 'normalized'])
                    .optional()
                    .describe(
                        'Unanchored coordinates: "image" = pixels of a capture (default when one exists), ' +
                            '"physical"/"dip" = display px, "normalized" = 0..1.'
                    ),
                captureId: z.string().optional().describe('Default: the latest capture.'),
                display: z.string().optional().describe('For non-image spaces.'),
                replace: z.boolean().default(true),
                ttlMs: z.number().int().min(0).default(0).describe('Auto-clear after ms; 0 keeps.')
            }
        },
        args =>
            guarded('annotate', async () => {
                const ttl = args.ttlMs > 0 ? ` They clear in ${args.ttlMs}ms.` : '';
                if (args.anchor) {
                    const target = await resolveAnchor(args.anchor);
                    const created = placeAnchored(target, args.shapes, { replace: args.replace, ttlMs: args.ttlMs });
                    return text(`Drew ${ids(created)} on ${target.label}; they follow it.${ttl}`);
                }
                const { created, display, capture } = placeFixed(args, args.shapes);
                const from = capture ? ` (from ${capture.id})` : '';
                return text(`Drew ${ids(created)} on display ${display.id}${from}.${ttl}`);
            })
    );

    // ------------------------------------------------------------------- clear
    server.registerTool(
        'clear_annotations',
        {
            title: 'Clear annotations',
            description: 'Remove drawings: the given ids, or all.',
            inputSchema: { ids: z.array(z.string()).optional() }
        },
        async args => {
            const n = store.clear(args.ids);
            return text(`Cleared ${n}; ${store.list().length} remain.`);
        }
    );

}
