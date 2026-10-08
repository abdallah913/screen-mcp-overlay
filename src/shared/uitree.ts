import type { Point, Rect, SnapshotNode } from './types.js';

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
    /** Siblings of the same role the helper skipped after this one. */
    more?: number;
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
    nodes: Pick<RawNode, 'depth' | 'role' | 'name' | 'automation_id' | 'popup'>[]
): string[] {
    return structure(nodes).map(s => s.key);
}

/**
 * Each node's key. An open popup is numbered apart from the window's own
 * children: it is listed first, so sharing their counter turned the window's
 * "pane[1]" into "pane[2]" whenever a pane-like popup opened, re-keying its
 * whole subtree and making a since= diff report every row as removed and added.
 */
function structure(
    nodes: Pick<RawNode, 'depth' | 'role' | 'name' | 'automation_id' | 'popup'>[]
): { key: string }[] {
    const stack: { depth: number; segment: string }[] = [];
    const childCounts = new Map<string, Map<string, number>>();

    return nodes.map(n => {
        while (stack.length > 0 && stack[stack.length - 1]!.depth >= n.depth) stack.pop();

        const parentPath = stack.map(s => s.segment).join('/');
        const scope = childCounts.get(parentPath) ?? new Map<string, number>();
        childCounts.set(parentPath, scope);

        // Position among same-role siblings: stable while the layout is.
        const kind = n.popup ? `popup:${n.role}` : n.role;
        const index = (scope.get(kind) ?? 0) + 1;
        scope.set(kind, index);

        const segment = `${kind}[${index}]`;
        stack.push({ depth: n.depth, segment });
        // An AutomationId is the app's own stable handle, so prefer it over the
        // display name: it survives relabelling and translation.
        const identity = n.automation_id ? `#${n.automation_id}` : clean(n.name);
        return { key: `${parentPath ? `${parentPath}/` : ''}${segment}:${identity}` };
    });
}

/**
 * A snapshot row. `unread` is how many same-role siblings after it the helper
 * skipped, to spend its row budget on the controls past a long list. On a
 * display-only marker (see collapseRuns), `more` is how many rows it stands
 * for, and its ref is empty.
 */
export type TreeRow = SnapshotNode & { unread?: number; more?: number };

/** Roles that come in long, uniform runs: list, tree and grid rows. */
const RUN_ROLES = new Set(['listitem', 'treeitem', 'dataitem']);
/** A run longer than this collapses... */
const RUN_LIMIT = 8;
/** ...to its first few rows plus a marker. */
const RUN_SHOWN = 5;

/** A row the user is on. Never collapsed away: it is usually the one that matters. */
function isCurrent(n: Pick<SnapshotNode, 'state'>): boolean {
    return /\b(selected|focused)\b/.test(n.state ?? '');
}

/**
 * Collapse long runs of same-role list, tree and grid siblings into a marker,
 * for printing only.
 *
 * A file list or a settings tree can spend most of a describe on near-identical
 * rows, burying the controls after it (a dialog's File name box, its Save
 * button) under rows nobody asked about. The marker names the search that
 * recovers any collapsed row. Rows the helper never read (`unread`) get the
 * same marker, so the agent knows the list goes on.
 *
 * Snapshots, diffs and change signatures use the full rows: a selection moving
 * inside a collapsed row, or rows added past the fifth, is a real change that a
 * collapsed copy cannot see.
 */
export function collapseRuns(nodes: TreeRow[]): TreeRow[] {
    // Group each node's children, in order; -1 is the top level.
    const children = new Map<number, number[]>();
    const stack: number[] = [];
    nodes.forEach((n, i) => {
        while (stack.length > 0 && nodes[stack[stack.length - 1]!]!.indent >= n.indent) stack.pop();
        const parent = stack.length > 0 ? stack[stack.length - 1]! : -1;
        const siblings = children.get(parent);
        if (siblings) siblings.push(i);
        else children.set(parent, [i]);
        stack.push(i);
    });

    /** Index just past a node's subtree. */
    const subtreeEnd = (i: number): number => {
        let j = i + 1;
        while (j < nodes.length && nodes[j]!.indent > nodes[i]!.indent) j += 1;
        return j;
    };
    /**
     * Whether the user is on this row or anywhere under it: an expanded tree
     * node holding the selected child must stay, or the row that says where
     * the user is goes with it.
     */
    const holdsCurrent = (i: number): boolean => nodes.slice(i, subtreeEnd(i)).some(isCurrent);

    const dropped = new Set<number>();
    const markers: { after: number; parent: number; row: TreeRow }[] = [];
    for (const [parent, kids] of children) {
        let start = 0;
        while (start < kids.length) {
            const role = nodes[kids[start]!]!.role;
            let stop = start + 1;
            while (stop < kids.length && nodes[kids[stop]!]!.role === role) stop += 1;
            const run = kids.slice(start, stop);
            start = stop;

            const long = RUN_ROLES.has(role) && run.length > RUN_LIMIT;
            const hidden = long ? run.slice(RUN_SHOWN).filter(i => !holdsCurrent(i)) : [];
            const unread = run.reduce((sum, i) => sum + (nodes[i]!.unread ?? 0), 0);
            if (hidden.length === 0 && unread === 0) continue;

            for (const i of hidden) for (let j = i; j < subtreeEnd(i); j += 1) dropped.add(j);
            const first = nodes[run[0]!]!;
            markers.push({
                after: subtreeEnd(run[run.length - 1]!) - 1,
                parent,
                row: {
                    key: `${parent >= 0 ? `${nodes[parent]!.key}/` : ''}more[${role}]`,
                    indent: first.indent,
                    name: '',
                    role,
                    enabled: true,
                    ref: '',
                    rect: first.rect,
                    more: hidden.length + unread,
                    unread: unread || undefined
                }
            });
        }
    }

    // A run nested in a collapsed row went with it. Where an inner run and an
    // outer one end on the same row, the deeper marker prints first.
    const after = new Map<number, TreeRow[]>();
    for (const m of markers) {
        if (dropped.has(m.parent)) continue;
        after.set(m.after, [...(after.get(m.after) ?? []), m.row]);
    }
    const out: TreeRow[] = [];
    nodes.forEach((n, i) => {
        if (!dropped.has(i)) out.push(n);
        const here = after.get(i);
        if (here) out.push(...here.sort((a, b) => b.indent - a.indent));
    });
    return out;
}

/** Every row of a tree: what snapshots store, diffs compare and describes print through collapseRuns. */
export function toSnapshotNodes(raw: RawNode[]): TreeRow[] {
    const nodes = pruneEchoes(raw);
    const depths = displayDepths(nodes);
    const shape = structure(nodes);
    return nodes.map((n, i) => ({
        key: shape[i]!.key,
        indent: depths[i]!,
        name: clean(n.name),
        role: n.role,
        automationId: n.automation_id,
        value: n.value ? clean(n.value) : undefined,
        enabled: n.enabled,
        ref: n.ref,
        rect: n.rect,
        state: n.state || undefined,
        offscreen: n.offscreen || undefined,
        popup: n.popup || undefined,
        unread: n.more || undefined
    }));
}

/** State words as printed: "checked focused". */
function words(state: string | undefined): string {
    return (state ?? '')
        .split(',')
        .map(w => w.trim())
        .filter(Boolean)
        .join(' ');
}

/** What a row is called: its name, with a popup's mark. */
function title(n: TreeRow): string {
    return `${n.popup ? '(popup) ' : ''}${n.name || '(unnamed)'}`;
}

export function row(n: TreeRow, includeRects: boolean): string {
    const pad = '  '.repeat(n.indent);
    if (n.more !== undefined) {
        const unread = n.unread ?? 0;
        const why = unread === 0 ? '' : unread === n.more ? ' not read' : ` (${unread} not read)`;
        return `${pad}… +${n.more} more [${n.role}]${why}; find_ui_elements role:${n.role} name:…`;
    }
    // An open menu or dropdown is its own top-level popup, gone the moment the
    // user clicks elsewhere, so it is worth saying where a row came from.
    const parts = [`${pad}${title(n)} [${n.role}]`];
    // A text control's value is often its name again.
    if (n.value && n.value !== n.name) parts.push(` "${n.value}"`);
    const state = words(n.state);
    if (state) parts.push(` ${state}`);
    if (!n.enabled) parts.push(' disabled');
    // The rect is real but not where the user can see it: scrolled out of view.
    if (n.offscreen) parts.push(' offscreen');
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
    state?: string;
    offscreen?: boolean;
}): string {
    const state = words(e.state);
    return (
        `${clean(e.name) || '(unnamed)'} [${e.role}]${state ? ` ${state}` : ''}${e.enabled ? '' : ' disabled'}` +
        `${e.offscreen ? ' offscreen' : ''}${e.automation_id ? ` id=${e.automation_id}` : ''}  ` +
        `${rectText(e.rect)}  ${e.ref}`
    );
}

/**
 * Names a window gets from its frame, whatever toolkit is underneath.
 */
const FRAME_ONLY = new Set(['minimize', 'maximize', 'restore', 'close', 'system', 'application']);

/**
 * Explain *why* a tree is thin, because the failure modes need different
 * fallbacks and look identical from the node list alone.
 *
 * - Elevated window: the app runs as administrator (or is protected), and
 *   Windows' UIPI stops a normal process reading its controls at all. Saying
 *   "no provider" here sent agents hunting for an accessibility switch that
 *   does not exist.
 * - Nothing below the window: no accessibility provider is attached at all.
 * - Frame only: a provider answers for the title bar but not the content.
 *   Chromium does this until accessibility is switched on; Qt does it unless the
 *   app ships the accessibility plugin.
 *
 * A wrapper that merely repeats the window's own title counts as frame, not
 * content -- Chromium nests one, and treating it as real content was enough to
 * stop this firing on exactly the tree it was written for.
 */
export function diagnoseTree(nodes: SnapshotNode[], window: { elevated?: boolean } = {}): string | null {
    const root = nodes[0];
    const content = nodes.filter(n => n.indent > 0);
    const rootName = root ? root.name.trim().toLowerCase() : '';
    const meaningful = content.filter(n => {
        const name = n.name.trim().toLowerCase();
        return name !== '' && name !== rootName && !FRAME_ONLY.has(name);
    });
    if (meaningful.length === 0 && window.elevated) return elevatedNote();
    if (content.length === 0) {
        return (
            'Only the window itself is exposed — no accessibility provider is answering for its ' +
            'content. Use read_text (OCR) for this window, or capture_screen if you need to see it.'
        );
    }
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

/** Why an elevated window reads as empty, and what still works on it. */
export function elevatedNote(): string {
    return (
        'This window runs as administrator (or is protected), so Windows blocks reading its controls ' +
        '(UIPI); nothing is wrong with the app. read_text (OCR) still reads it, and drawings anchored ' +
        'to the window itself still follow it.'
    );
}

/** State that matters in a diff. Focus moves with every click, so it is left out as churn. */
function steady(state: string | undefined): string {
    return words(state)
        .split(' ')
        .filter(w => w && w !== 'focused')
        .join(' ');
}

/**
 * How a row changed, naming only what differs on each side:
 * `unchecked -> checked`, `"abc" -> "abcdef"`, `enabled -> disabled`.
 */
function change(old: TreeRow, n: TreeRow): string | null {
    const before: string[] = [];
    const after: string[] = [];
    if ((old.value ?? '') !== (n.value ?? '')) {
        before.push(`"${old.value ?? ''}"`);
        after.push(`"${n.value ?? ''}"`);
    }
    const s0 = steady(old.state);
    const s1 = steady(n.state);
    if (s0 !== s1) {
        // "selected" losing its word reads better as "not selected" than as nothing.
        before.push(s0 || `not ${s1}`);
        after.push(s1 || `not ${s0}`);
    }
    if (old.enabled !== n.enabled) {
        before.push(old.enabled ? 'enabled' : 'disabled');
        after.push(n.enabled ? 'enabled' : 'disabled');
    }
    // How many rows the helper skipped after this one: rows added or removed
    // past its cut show up only here.
    if ((old.unread ?? 0) !== (n.unread ?? 0)) {
        before.push(`+${old.unread ?? 0} unread`);
        after.push(`+${n.unread ?? 0} unread`);
    }
    return before.length > 0 ? `${before.join(' ')} -> ${after.join(' ')}` : null;
}

/** A new row as a diff prints it: the describe row's words, without the indent. */
function added(n: TreeRow): string {
    const value = n.value && n.value !== n.name ? ` "${n.value}"` : '';
    const state = words(n.state);
    return (
        `+ ${title(n)} [${n.role}]${value}${state ? ` ${state}` : ''}${n.enabled ? '' : ' disabled'}` +
        `${n.offscreen ? ' offscreen' : ''}  ${n.ref}`
    );
}

/** Lines describing what changed, or null when the two snapshots match. */
export function diffLines(before: TreeRow[], after: TreeRow[]): string[] | null {
    const prev = new Map(before.map(n => [n.key, n]));
    const next = new Map(after.map(n => [n.key, n]));
    const out: string[] = [];

    for (const n of after) {
        const old = prev.get(n.key);
        if (!old) {
            out.push(added(n));
            continue;
        }
        const what = change(old, n);
        if (what) out.push(`~ ${title(n)} [${n.role}] ${what}  ${n.ref}`);
    }
    for (const n of before) {
        if (!next.has(n.key)) out.push(`- ${title(n)} [${n.role}]`);
    }
    return out.length > 0 ? out : null;
}

// ------------------------------------------------------------ name matching

/**
 * A label reduced to what a person reads: no case, no `&` mnemonic markers, no
 * trailing ellipsis, and nothing after a tab (where menus put the shortcut).
 */
export function labelKey(s: string): string {
    const head = s.split('\t')[0] ?? '';
    return clean(head.replace(/&(.)/g, '$1').replace(/(\.\.\.|…)\s*$/, '')).toLowerCase();
}

/** 0 exact, 1 starts with, 2 contains, 3 not at all. */
export function nameTier(name: string, wanted: string): number {
    const have = labelKey(name);
    const want = labelKey(wanted);
    if (have === want) return 0;
    if (have.startsWith(want)) return 1;
    return have.includes(want) ? 2 : 3;
}

export interface Candidate {
    name: string;
    automation_id?: string;
    enabled: boolean;
    rect: Rect;
    offscreen?: boolean;
}

const inside = (r: Rect, outer: Rect): boolean =>
    r.x >= outer.x && r.y >= outer.y && r.x + r.width <= outer.x + outer.width && r.y + r.height <= outer.y + outer.height;

/**
 * Order matches for "the control this label names".
 *
 * The helper returns substring matches in tree order, so name "Save" used to
 * circle "Save as…" or "Autosave" whenever it came first, while the caption said
 * "Click Save". An AutomationId match comes first, then the exact label, then
 * one that starts with it, then one that merely contains it. Ties go to the
 * control the user can act on: enabled, in view, inside the window, and the
 * smaller one, since a big container named like its button is rarely the target.
 */
export function rankMatches<T extends Candidate>(
    matches: T[],
    wanted: { name?: string; automationId?: string },
    within?: Rect
): T[] {
    const score = (m: T): number[] => [
        wanted.automationId && m.automation_id === wanted.automationId ? 0 : 1,
        wanted.name ? nameTier(m.name, wanted.name) : 0,
        m.enabled ? 0 : 1,
        m.offscreen ? 1 : 0,
        within && !inside(m.rect, within) ? 1 : 0,
        m.rect.width * m.rect.height
    ];
    const scored = matches.map((m, i) => ({ m, s: score(m), i }));
    scored.sort((a, b) => {
        for (let k = 0; k < a.s.length; k += 1) if (a.s[k] !== b.s[k]) return a.s[k]! - b.s[k]!;
        return a.i - b.i;
    });
    return scored.map(x => x.m);
}

/**
 * Whether a ranked choice needs a second look: other matches exist and the
 * first is not the only exact label among them. An exact "Save" beside "Save
 * as…" is not ambiguous; two exact "Save"s, or only partial matches, are.
 */
export function isAmbiguous(ranked: Candidate[], wanted: { name?: string; automationId?: string }): boolean {
    if (ranked.length < 2 || !wanted.name || wanted.automationId) return false;
    const exact = ranked.filter(m => nameTier(m.name, wanted.name!) === 0).length;
    return exact !== 1 || nameTier(ranked[0]!.name, wanted.name) !== 0;
}

/** How near a re-found control must be to where its drawing last was, in physical px. */
const RECOVER_NEAR_PX = 16;

/**
 * Which of the controls a selector finds again is the one a drawing was on,
 * or undefined when that cannot be told.
 *
 * Per-row buttons ("Remove" on every row, often with one AutomationId between
 * them) tie on every rank key, so taking the first match moved a circle to
 * another row's button for good. When the choice is not clear-cut, only the
 * match that sits where the target last was counts; otherwise the drawing
 * stays hidden rather than point at a look-alike.
 */
export function recoveredMatch<T extends Candidate>(
    ranked: T[],
    wanted: { name?: string; automationId?: string },
    last?: Rect
): T | undefined {
    const best = ranked[0];
    if (!best) return undefined;
    const identity = (m: T): string =>
        [wanted.automationId && m.automation_id === wanted.automationId, wanted.name ? nameTier(m.name, wanted.name) : 0].join();
    const rank = (m: T): string => [identity(m), m.enabled, Boolean(m.offscreen)].join();
    const tied = ranked.some(m => m !== best && rank(m) === rank(best));
    if (!tied && !isAmbiguous(ranked, wanted)) return best;
    if (!last) return undefined;

    const centre = (r: Rect): Point => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
    const was = centre(last);
    const distance = (m: T): number => Math.hypot(centre(m.rect).x - was.x, centre(m.rect).y - was.y);
    const near = Math.max(RECOVER_NEAR_PX, Math.min(last.width, last.height) / 2);
    const [nearest] = ranked
        .filter(m => identity(m) === identity(best))
        .map(m => ({ m, d: distance(m) }))
        .sort((a, b) => a.d - b.d);
    return nearest && nearest.d <= near ? nearest.m : undefined;
}

/**
 * Where a control sits in its window, in the words a person would use:
 * "top-left", "bottom", "centre". Null when it lies outside the window.
 */
export function whereIn(r: Rect, win: Rect): string | null {
    const cx = r.x + r.width / 2;
    const cy = r.y + r.height / 2;
    if (cx < win.x || cy < win.y || cx > win.x + win.width || cy > win.y + win.height) return null;
    const third = (v: number, start: number, size: number): 0 | 1 | 2 =>
        v < start + size / 3 ? 0 : v > start + (size * 2) / 3 ? 2 : 1;
    const vertical = ['top', '', 'bottom'][third(cy, win.y, win.height)]!;
    const horizontal = ['left', '', 'right'][third(cx, win.x, win.width)]!;
    if (!vertical && !horizontal) return 'centre';
    return vertical && horizontal ? `${vertical}-${horizontal}` : vertical || horizontal;
}
