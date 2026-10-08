import type { SnapshotNode } from './types.js';

/**
 * Pure logic for turning a UI Automation tree into text and diffing two of them.
 *
 * Kept out of the Electron main process so it can be unit tested: the structural
 * key in particular is easy to get subtly wrong in ways that only show up as a
 * diff quietly reporting the whole tree as changed.
 */

export interface RawNode {
    depth: number;
    ref: string;
    name: string;
    role: string;
    automation_id?: string;
    value?: string;
    enabled: boolean;
    rect: { x: number; y: number; width: number; height: number };
    state?: string;
    offscreen?: boolean;
    popup?: boolean;
}

/** Control names can contain newlines; they would break one-line-per-row output. */
export function clean(s: string): string {
    return s.replace(/\s+/g, ' ').trim();
}

/** `WxH@x,y`: the one rectangle format every tool prints. */
export function rectText(r: { x: number; y: number; width: number; height: number }): string {
    return `${r.width}x${r.height}@${r.x},${r.y}`;
}

/**
 * Drop text nodes that only repeat their container's name.
 *
 * Chromium, Electron and WinUI put a text child inside nearly every button,
 * link, tab and list item, carrying the same label as its parent: `Save
 * [button]` immediately followed by `Save [text]`. The child adds a row and a
 * ref and says nothing new, and the parent is the better anchor anyway. These
 * are exactly the toolkits whose trees are largest, so this is where rows cost
 * most.
 *
 * Only `text` echoes are dropped, and never a direct child of the window:
 * Chromium's wrapper that repeats the window title is what diagnoseTree keys
 * on, and removing it would turn "frame only" into a misleading "no provider".
 */
export function pruneEchoes<T extends Pick<RawNode, 'depth' | 'name' | 'role' | 'value' | 'automation_id'>>(
    nodes: T[]
): T[] {
    const stack: { depth: number; name: string }[] = [];
    return nodes.filter(n => {
        while (stack.length > 0 && stack[stack.length - 1]!.depth >= n.depth) stack.pop();
        const parent = stack.length > 1 ? stack[stack.length - 1] : undefined;
        const name = clean(n.name);
        stack.push({ depth: n.depth, name });
        const echo =
            n.role === 'text' && !n.value && !n.automation_id && name !== '' && name === parent?.name;
        return !echo;
    });
}

/**
 * Indent by position in the retained ancestor chain, not by raw UIA depth.
 *
 * Raw depths are both huge and sparse: a Chromium app buries content around
 * level 19, and dropping unnamed containers leaves gaps. Indenting by raw depth
 * wastes forty columns; ranking the distinct depths globally is worse than that
 * — it gives siblings different indents whenever their subtrees were pruned to
 * different degrees, which misrepresents the structure. Nodes arrive in
 * depth-first order, so a stack of ancestor depths gives the true relative
 * nesting.
 */
export function displayDepths(nodes: Pick<RawNode, 'depth'>[]): number[] {
    const stack: number[] = [];
    return nodes.map(n => {
        while (stack.length > 0 && stack[stack.length - 1]! >= n.depth) stack.pop();
        stack.push(n.depth);
        return stack.length - 1;
    });
}

/**
 * A key that identifies a control across separate queries.
 *
 * Element refs cannot be used: the helper allocates a fresh `el_N` on every
 * search, so two identical describe calls share none of them (measured: 0 of 12)
 * and a ref-keyed diff would report the whole tree as changed.
 *
 * The ancestor path deliberately uses **role and position only, never names**.
 * Including ancestor names looks more precise and is much worse: an app that
 * puts document state in its title — Notepad going from "Untitled" to
 * "*hello overlay" — renames the root, which re-keys every descendant and turns
 * a two-line edit into a whole-tree diff. Measured before this change, the diff
 * came out longer than the full tree. A node's own name still identifies it, so
 * a rename costs that one row rather than its entire subtree.
 */
export function structuralKeys(
    nodes: Pick<RawNode, 'depth' | 'role' | 'name' | 'automation_id'>[]
): string[] {
    const stack: { depth: number; segment: string }[] = [];
    const childCounts = new Map<string, Map<string, number>>();

    return nodes.map(n => {
        while (stack.length > 0 && stack[stack.length - 1]!.depth >= n.depth) stack.pop();

        const parentPath = stack.map(s => s.segment).join('/');
        const scope = childCounts.get(parentPath) ?? new Map<string, number>();
        childCounts.set(parentPath, scope);

        // Position among same-role siblings: stable while the layout is.
        const index = (scope.get(n.role) ?? 0) + 1;
        scope.set(n.role, index);

        stack.push({ depth: n.depth, segment: `${n.role}[${index}]` });
        // An AutomationId is the app's own stable handle, so prefer it over the
        // display name: it survives relabelling and translation.
        const identity = n.automation_id ? `#${n.automation_id}` : clean(n.name);
        return `${parentPath ? `${parentPath}/` : ''}${n.role}[${index}]:${identity}`;
    });
}

export function toSnapshotNodes(raw: RawNode[]): SnapshotNode[] {
    const nodes = pruneEchoes(raw);
    const depths = displayDepths(nodes);
    const keys = structuralKeys(nodes);
    return nodes.map((n, i) => ({
        key: keys[i]!,
        indent: depths[i]!,
        name: clean(n.name),
        role: n.role,
        automationId: n.automation_id,
        value: n.value ? clean(n.value) : undefined,
        enabled: n.enabled,
        ref: n.ref,
        rect: n.rect,
        state: n.state,
        offscreen: n.offscreen,
        popup: n.popup
    }));
}

export function row(n: SnapshotNode, includeRects: boolean): string {
    const parts = [`${'  '.repeat(n.indent)}${n.name || '(unnamed)'} [${n.role}]`];
    // A text control's value is often its name again.
    if (n.value && n.value !== n.name) parts.push(` "${n.value}"`);
    if (!n.enabled) parts.push(' disabled');
    if (n.automationId) parts.push(` id=${n.automationId}`);
    if (includeRects || n.indent === 0) parts.push(`  ${rectText(n.rect)}`);
    if (n.indent > 0) parts.push(`  ${n.ref}`);
    return parts.join('');
}

/**
 * A search hit, in the same shape as a describe_window row plus its rect, so
 * the agent reads one format whichever tool found the control.
 */
export function elementLine(e: {
    ref: string;
    name: string;
    role: string;
    automation_id?: string;
    enabled: boolean;
    rect: { x: number; y: number; width: number; height: number };
}): string {
    return (
        `${clean(e.name) || '(unnamed)'} [${e.role}]${e.enabled ? '' : ' disabled'}` +
        `${e.automation_id ? ` id=${e.automation_id}` : ''}  ${rectText(e.rect)}  ${e.ref}`
    );
}

function state(n: SnapshotNode): string {
    return `${n.value ? `"${n.value}" ` : ''}${n.enabled ? 'enabled' : 'disabled'}`;
}

/**
 * Names a window gets from its frame, whatever toolkit is underneath.
 */
const FRAME_ONLY = new Set(['minimize', 'maximize', 'restore', 'close', 'system', 'application']);

/**
 * Explain *why* a tree is thin, because the two failure modes need different
 * fallbacks and look identical from the node list alone.
 *
 * - Nothing below the window: no accessibility provider is attached at all.
 * - Frame only: a provider answers for the title bar but not the content.
 *   Chromium does this until accessibility is switched on; Qt does it unless the
 *   app ships the accessibility plugin.
 *
 * A wrapper that merely repeats the window's own title counts as frame, not
 * content -- Chromium nests one, and treating it as real content was enough to
 * stop this firing on exactly the tree it was written for.
 */
export function diagnoseTree(nodes: SnapshotNode[]): string | null {
    const root = nodes[0];
    const content = nodes.filter(n => n.indent > 0);
    if (content.length === 0) {
        return (
            'Only the window itself is exposed — no accessibility provider is answering for its ' +
            'content. Use read_text (OCR) for this window, or capture_screen if you need to see it.'
        );
    }

    const rootName = root ? root.name.trim().toLowerCase() : '';
    const meaningful = content.filter(n => {
        const name = n.name.trim().toLowerCase();
        return name !== '' && name !== rootName && !FRAME_ONLY.has(name);
    });
    if (meaningful.length === 0) {
        return (
            'Only the window frame is exposed (title bar and a wrapper), not the application ' +
            'content. The toolkit is not publishing an accessibility tree: Chromium and Electron ' +
            'apps do this until accessibility is enabled (launching with ' +
            '--force-renderer-accessibility switches it on), and Qt/QML apps do it unless the app ' +
            'ships the accessibility plugin and its controls set Accessible.name. Fall back to ' +
            'read_text (OCR), which still returns per-line rectangles you can anchor to.'
        );
    }
    return null;
}

/** Lines describing what changed, or null when the two snapshots match. */
export function diffLines(before: SnapshotNode[], after: SnapshotNode[]): string[] | null {
    const prev = new Map(before.map(n => [n.key, n]));
    const next = new Map(after.map(n => [n.key, n]));
    const out: string[] = [];

    for (const n of after) {
        const old = prev.get(n.key);
        if (!old) {
            out.push(`+ ${n.name || '(unnamed)'} [${n.role}] ${state(n)}  ${n.ref}`);
        } else if (old.value !== n.value || old.enabled !== n.enabled) {
            out.push(`~ ${n.name || '(unnamed)'} [${n.role}] ${state(old)} -> ${state(n)}  ${n.ref}`);
        }
    }
    for (const n of before) {
        if (!next.has(n.key)) out.push(`- ${n.name || '(unnamed)'} [${n.role}]`);
    }
    return out.length > 0 ? out : null;
}
