import { describeWindow, windowInfo, type Described, type WindowInfo } from './uia.js';
import { store } from './store.js';
import { clean, collapseRuns, diagnoseTree, diffLines, elevatedNote, row, toSnapshotNodes } from '../shared/uitree.js';
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
    /** The window's details when the caller already has them; looked up only if needed. */
    info?: WindowInfo;
}

/** The window's flags, fetched only on the paths that need them: the common case pays nothing. */
async function lookup(opts: DescribeOptions): Promise<WindowInfo | undefined> {
    return opts.info ?? (await windowInfo(opts.window).catch(() => undefined));
}

/**
 * Say the walk was cut, and where. The rows alone cannot show it, and an agent
 * that assumed it saw the whole window concluded the control it wanted did not
 * exist; naming the subtrees never reached tells it where to search instead.
 */
function truncationNote(d: Described): string {
    if (d.unanswered) {
        return '\n(the app stopped answering partway, so this is only part of the window: describe it again once it responds)';
    }
    if (!d.truncated) return '';
    const names = (d.unvisited ?? []).map(n => `"${clean(n)}"`).filter(n => n !== '""');
    const where = names.length
        ? ` before reaching ${names.slice(0, 4).join(', ')}${names.length > 4 ? ` and ${names.length - 4} more` : ''}`
        : '';
    return (
        `\n(truncated: the walk stopped at maxNodes${where}. Raise maxNodes, or find_ui_elements with ` +
        'this window and a name)'
    );
}

export async function describeWindowAsText(opts: DescribeOptions): Promise<string> {
    let described: Described;
    try {
        described = await describeWindow({ window: opts.window, maxNodes: opts.maxNodes, maxDepth: opts.maxDepth });
    } catch (err) {
        // A hung app wedges every UIA call into it; a generic helper timeout
        // sends the agent to retry something that cannot work yet.
        const info = await lookup(opts);
        if (info?.hung) {
            throw new Error(
                `"${clean(info.title)}" is not responding, so its controls cannot be read right now. Wait for ` +
                    'it to recover, or capture_screen to see it.'
            );
        }
        throw err;
    }

    const { nodes } = described;
    if (nodes.length === 0) {
        const info = await lookup(opts);
        if (info?.minimized) {
            return (
                `"${clean(info.title)}" is minimized, so its controls have no place on screen. focus_window ` +
                'restores it; then describe it again.'
            );
        }
        if (info?.elevated) return elevatedNote();
        return (
            'That window exposes no accessibility tree, which is normal for canvas UIs, games and some ' +
            'web content. Use read_text to read it, or capture_screen to see it.'
        );
    }

    // The snapshot keeps every row and only the printed text collapses long
    // lists, so a later since= diff still sees a change inside a collapsed row.
    const snapshotNodes = toSnapshotNodes(nodes);
    const id = store.recordSnapshot({
        id: store.nextId('snap'),
        windowRef: opts.window,
        at: Date.now(),
        nodes: snapshotNodes
    });

    // Say *why* a tree is thin. "Empty", "frame only" and "elevated" need
    // different fallbacks, and they are indistinguishable from the node list
    // alone. Only a thin tree pays for the window lookup.
    let diagnosis = diagnoseTree(snapshotNodes);
    if (diagnosis) {
        const info = await lookup(opts);
        if (info?.elevated) diagnosis = diagnoseTree(snapshotNodes, info);
    }
    const note = diagnosis ? `\n\nNOTE: ${diagnosis}` : '';

    const full =
        collapseRuns(snapshotNodes).map(n => row(n, opts.includeRects ?? false)).join('\n') +
        truncationNote(described) +
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
    if (!changes) {
        // Rows the helper skipped in long lists are not in either snapshot, so
        // a change among them (a box ticked far down a list) cannot show here.
        const unread = snapshotNodes.reduce((sum, n) => sum + (n.unread ?? 0), 0);
        const blind = unread
            ? ` (${unread} row(s) of long lists were not read, so a change there would not show; ` +
              'find_ui_elements with a name reads one)'
            : '';
        return `No changes since ${opts.since}${blind}.\nsnapshotId: ${id}`;
    }

    const delta = `${changes.length} change(s) since ${opts.since}:\n${changes.join('\n')}\nsnapshotId: ${id}`;
    // After a navigation or a dialog opening nearly everything differs, and the
    // diff plus its markup is longer than simply saying what is there now.
    return delta.length < full.length ? delta : full;
}
