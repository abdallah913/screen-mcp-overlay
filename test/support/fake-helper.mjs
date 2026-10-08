import { createRequire } from 'node:module';

/*
 * A small fake desktop for tool tests: canned answers to every helper op, and a
 * record of what the tools asked. Tests that need different behaviour pass
 * `overrides` (op name -> handler) instead of editing this file, so several
 * test files can share it.
 */

const require = createRequire(import.meta.url);
const harness = require('../../dist-test/harness.cjs');

export const rect = (x, y, width, height) => ({ x, y, width, height });

const flags = { minimized: false, cloaked: false, elevated: false, hung: false };

export function fakeDesktop() {
    return {
        windows: [
            { ref: '100', title: 'Untitled - Notepad', class: 'Notepad', pid: 11, rect: rect(100, 100, 800, 600), foreground: true, ...flags },
            { ref: '200', title: 'Calculator', class: 'Calc', pid: 12, rect: rect(1000, 100, 320, 500), foreground: false, ...flags },
            { ref: '300', title: 'Minimised thing', class: 'X', pid: 13, rect: rect(0, 0, 100, 100), foreground: false, ...flags, minimized: true },
            { ref: '400', title: 'Overlay panel', class: 'Chrome_WidgetWin_1', pid: process.pid, rect: rect(0, 0, 100, 100), foreground: false, ...flags }
        ],
        controls: [
            { ref: 'el_1', name: 'Save', role: 'button', automation_id: 'SaveBtn', rect: rect(150, 150, 80, 24), enabled: true },
            { ref: 'el_2', name: 'Export', role: 'button', rect: rect(250, 150, 80, 24), enabled: false }
        ],
        tree: [
            { depth: 0, ref: 'el_10', name: 'Untitled - Notepad', role: 'window', enabled: true, rect: rect(100, 100, 800, 600) },
            { depth: 2, ref: 'el_11', name: 'Save', role: 'button', enabled: true, rect: rect(150, 150, 80, 24) },
            { depth: 3, ref: 'el_12', name: 'Save', role: 'text', enabled: true, rect: rect(152, 152, 70, 20) },
            { depth: 2, ref: 'el_13', name: 'Text editor', role: 'document', value: 'hello', enabled: true, rect: rect(100, 180, 800, 500) }
        ]
    };
}

/**
 * Install the fake helper. Returns `calls` (every op and its params, in order)
 * and the desktop it answers from, which a test may mutate between calls.
 */
export function fakeHelper(overrides = {}, desktop = fakeDesktop()) {
    const calls = [];
    const { windows, controls, tree } = desktop;
    const contains = (r, x, y) => x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height;
    const handlers = {
        list_windows: () => windows,
        find_elements: p =>
            controls
                .filter(c =>
                    p.automation_id ? c.automation_id === p.automation_id : !p.name || c.name.toLowerCase().includes(p.name.toLowerCase())
                )
                .filter(c => !p.role || c.role === p.role)
                .filter(c => p.include_hidden || !c.hidden)
                .slice(0, p.limit ?? 25),
        describe: () => ({ nodes: tree, truncated: false }),
        resolve: p =>
            p.refs.map(r => ({
                ref: r,
                rect: windows.find(w => w.ref === r)?.rect ?? controls.find(c => c.ref === r)?.rect ?? null
            })),
        focus_window: () => ({ focused: true }),
        scroll_window: () => ({ scrolled: true }),
        occlusion: () => ({ covered: 0, by: [] }),
        covered: () => ({ fraction: 0, centre_covered: false, by: [] }),
        element_at_point: p => {
            const element = controls.find(c => !c.hidden && contains(c.rect, p.x, p.y)) ?? null;
            const win = windows.find(w => !w.minimized && contains(w.rect, p.x, p.y));
            return { element, window: win ? { ref: win.ref, title: win.title } : null };
        },
        scroll_into_view: p => {
            const element = controls.find(c => (p.automation_id ? c.automation_id === p.automation_id : c.name.toLowerCase().includes((p.name ?? '').toLowerCase())));
            if (!element) throw new Error('no such control');
            return { scrolled: true, element };
        },
        suggest: p => controls.map(c => ({ name: c.name, role: c.role })).slice(0, p.limit ?? 3),
        ...overrides
    };
    harness.useHelperTransport(async (op, params) => {
        calls.push({ op, params });
        const h = handlers[op];
        if (!h) throw new Error(`fake helper has no ${op}`);
        return h(params, calls);
    });
    return { calls, ...desktop };
}

/** A fresh MCP client connected to a fresh server, as every request gets. */
export async function connect() {
    const server = harness.buildServer();
    const [a, b] = harness.InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new harness.Client({ name: 'test', version: '0' });
    await client.connect(b);
    return client;
}

/** Call one tool and flatten its result to text. */
export async function call(name, args = {}) {
    const client = await connect();
    try {
        const r = await client.callTool({ name, arguments: args });
        return {
            text: r.content.filter(c => c.type === 'text').map(c => c.text).join('\n'),
            isError: Boolean(r.isError)
        };
    } finally {
        await client.close();
    }
}

export { harness };
