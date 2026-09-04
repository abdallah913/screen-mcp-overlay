import { describeWindow } from './uia.js';
import { store } from './store.js';
import { diagnoseTree, diffLines, row, toSnapshotNodes } from '../shared/uitree.js';
/**
 * Renders a window's accessible tree as compact indented text, and diffs it
 * against an earlier snapshot when asked.
 *
 * This is the cheap alternative to a screenshot. A dialog that costs ~1.8k
 * tokens as an image renders here in a few hundred, and every line carries a ref
 * the agent can anchor a drawing to — so it is more actionable, not just cheaper.
 *
 * Deltas are keyed by a client-supplied snapshotId rather than server-held
 * per-client state. The MCP layer is deliberately stateless and shared by
 * several clients at once, so there is no session identity to hang a baseline
 * on; the agent already has the previous response in its context and just hands
 * back a token naming it. Same reasoning as captureId for image coordinates.
 */

export interface DescribeOptions {
    window: string;
    maxNodes?: number;
    maxDepth?: number;
    /** Include each row's rectangle. Off by default: refs are usually enough. */
    includeRects?: boolean;
    /** A snapshotId from an earlier call; returns only what changed since then. */
    since?: string;
}

export async function describeWindowAsText(opts: DescribeOptions): Promise<string> {
    const nodes = await describeWindow({
        window: opts.window,
        maxNodes: opts.maxNodes,
        maxDepth: opts.maxDepth
    });
    if (nodes.length === 0) {
        return (
            'That window exposes no accessibility tree. This is normal for canvas UIs, games and ' +
            'some browser page content — use capture_screen for those.'
        );
    }

    const snapshotNodes = toSnapshotNodes(nodes);
    const id = store.recordSnapshot({
        id: store.nextId('snap'),
        windowRef: opts.window,
        at: Date.now(),
        nodes: snapshotNodes
    });

    // Say *why* a tree is thin. "Empty" and "frame only" need different
    // fallbacks, and they are indistinguishable from the node list alone.
    const diagnosis = diagnoseTree(snapshotNodes);
    const note = diagnosis ? `\n\nNOTE: ${diagnosis}` : '';

    const truncated =
        nodes.length >= (opts.maxNodes ?? 120)
            ? `\n(truncated at ${nodes.length} nodes — raise maxNodes or narrow with find_ui_elements)`
            : '';
    const full =
        snapshotNodes.map(n => row(n, opts.includeRects ?? false)).join('\n') +
        truncated +
        `\nsnapshotId: ${id}` +
        note;

    if (!opts.since) return full;

    const baseline = store.snapshot(opts.since);
    // An unresolvable baseline must degrade to a full snapshot, never error:
    // trading tokens for fragility would defeat the point of the feature.
    if (!baseline) {
        return `(baseline ${opts.since} is no longer cached, so this is a full tree)\n${full}`;
    }
    if (baseline.windowRef !== opts.window) {
        return `(baseline ${opts.since} was taken of a different window, so this is a full tree)\n${full}`;
    }

    const changes = diffLines(baseline.nodes, snapshotNodes);
    if (!changes) return `No changes since ${opts.since}.\nsnapshotId: ${id}`;

    const delta = `${changes.length} change(s) since ${opts.since}:\n${changes.join('\n')}\nsnapshotId: ${id}`;
    // After a navigation or a dialog opening nearly everything differs, and the
    // diff plus its markup is longer than simply saying what is there now.
    return delta.length < full.length ? delta : full;
}
