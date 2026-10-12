import { buildSync } from 'esbuild';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * A fake desktop with pixels, for the capture tests. The real server runs
 * against capture-stub.cjs, whose screen is painted here from the desktop's
 * windows exactly as Windows would composite them: back to front, with
 * rounded corners that show what is behind and a drop shadow below and to
 * the right of every window. Window renders (PrintWindow) hold only the
 * window itself, plus the invisible resize border around it.
 *
 * Colours are BGRA. Anything of the private window (its body, its shadow, the
 * desktop or taskbar around it) has a colour of its own, so a test can say
 * that none of it reached an image or an OCR read.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const outfile = join(root, 'dist-test', 'harness-capture.cjs');
buildSync({
    entryPoints: [join(root, 'test/support/capture-harness.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    outfile,
    alias: { electron: join(root, 'test/support/capture-stub.cjs') },
    logLevel: 'error'
});

const require = createRequire(import.meta.url);
export const harness = require(outfile);
export const stub = globalThis.__captureStub;
harness.initCaptureDir();

export const rect = (x, y, width, height) => ({ x, y, width, height });

export const COLOURS = {
    desktop: [255, 0, 255, 255],
    shadow: [40, 40, 41, 255],
    notepad: [0, 200, 0, 255],
    notepadBar: [0, 120, 0, 255],
    calculator: [200, 0, 0, 255],
    calculatorBar: [120, 0, 0, 255],
    private: [0, 0, 255, 255],
    privateBar: [0, 0, 150, 255],
    border: [0, 0, 0, 255]
};

/** The invisible resize border PrintWindow's rect includes: left, right and bottom. */
export const BORDER = 7;
const CORNER = 8;
const SHADOW = 14;
const BAR = 30;

const flags = { minimized: false, cloaked: false, elevated: false, hung: false };

/** Notepad and Calculator shared; the private video in front, over Notepad, when `open`. */
export function captureDesktop(open = true) {
    const windows = [
        { ref: '100', title: 'Untitled - Notepad', class: 'Notepad', pid: 11, rect: rect(100, 100, 800, 600), foreground: false, ...flags, colour: 'notepad' },
        { ref: '200', title: 'Calculator', class: 'Calc', pid: 12, rect: rect(1000, 100, 320, 500), foreground: false, ...flags, colour: 'calculator' }
    ];
    if (open) {
        windows.unshift({
            ref: '500', title: 'Lofi beats - YouTube - Google Chrome', class: 'Chrome_WidgetWin_1', pid: 40, exe: 'chrome.exe',
            rect: rect(600, 120, 900, 600), foreground: true, ...flags, private: true, colour: 'private'
        });
    }
    return { windows };
}

const physical = d => ({
    x: d.bounds.x,
    y: d.bounds.y,
    width: Math.round(d.bounds.width * d.scaleFactor),
    height: Math.round(d.bounds.height * d.scaleFactor)
});

function fill(img, r, colour, origin = { x: 0, y: 0 }, keep = () => true) {
    for (let y = Math.max(0, r.y - origin.y); y < Math.min(img.height, r.y + r.height - origin.y); y += 1) {
        for (let x = Math.max(0, r.x - origin.x); x < Math.min(img.width, r.x + r.width - origin.x); x += 1) {
            if (!keep(x + origin.x, y + origin.y)) continue;
            img.data.set(colour, (y * img.width + x) * 4);
        }
    }
}

/** Outside a window's rounded corner: the pixels there show what is behind it. */
function inCorner(r, x, y) {
    const cx = x < r.x + CORNER ? r.x + CORNER : x >= r.x + r.width - CORNER ? r.x + r.width - CORNER - 1 : null;
    const cy = y < r.y + CORNER ? r.y + CORNER : y >= r.y + r.height - CORNER ? r.y + r.height - CORNER - 1 : null;
    return cx !== null && cy !== null && (x - cx) ** 2 + (y - cy) ** 2 > CORNER ** 2;
}

/** Paint the screen of every display from the desktop, back to front, as Windows composites it. */
export function paintScreens(desktop) {
    const shown = desktop.windows.filter(w => !w.minimized && !w.cloaked && w.pid !== process.pid);
    for (const d of stub.__state.displays) {
        const frame = physical(d);
        const img = { width: frame.width, height: frame.height, data: new Uint8Array(frame.width * frame.height * 4) };
        fill(img, frame, COLOURS.desktop, frame);
        for (const w of [...shown].reverse()) {
            const r = w.rect;
            fill(img, rect(r.x + SHADOW, r.y + r.height, r.width, SHADOW), COLOURS.shadow, frame);
            fill(img, rect(r.x + r.width, r.y + SHADOW, SHADOW, r.height), COLOURS.shadow, frame);
            fill(img, r, COLOURS[w.colour], frame, (x, y) => !inCorner(r, x, y));
            fill(img, rect(r.x, r.y, r.width, BAR), COLOURS[`${w.colour}Bar`], frame, (x, y) => !inCorner(r, x, y));
        }
        stub.__state.screen[d.id] = img;
    }
}

/** A window's own render, as PrintWindow makes it: the raw rect, its invisible border black. */
function render(w) {
    const raw = rect(w.rect.x - BORDER, w.rect.y, w.rect.width + 2 * BORDER, w.rect.height + BORDER);
    const img = { width: raw.width, height: raw.height, data: new Uint8Array(raw.width * raw.height * 4) };
    fill(img, raw, COLOURS.border, raw);
    fill(img, w.rect, COLOURS[w.colour], raw);
    fill(img, rect(w.rect.x, w.rect.y, w.rect.width, BAR), COLOURS[`${w.colour}Bar`], raw);
    return { raw, img };
}

/** The screen pixels under a rect, unmasked, as the helper's fallback copies them. */
function screenCopy(r) {
    const d = stub.__state.displays[0];
    const s = stub.__state.screen[d.id];
    const img = { width: r.width, height: r.height, data: new Uint8Array(r.width * r.height * 4) };
    for (let y = 0; y < r.height; y += 1) {
        for (let x = 0; x < r.width; x += 1) {
            const sx = r.x + x - d.bounds.x;
            const sy = r.y + y - d.bounds.y;
            if (sx < 0 || sy < 0 || sx >= s.width || sy >= s.height) continue;
            img.data.set(s.data.subarray((sy * s.width + sx) * 4, (sy * s.width + sx) * 4 + 4), (y * r.width + x) * 4);
        }
    }
    return img;
}

/** Which of COLOURS appear in an image, by name. */
export function coloursIn(img) {
    const names = new Set();
    const byKey = new Map(Object.entries(COLOURS).map(([k, v]) => [v.slice(0, 3).join(','), k]));
    for (let i = 0; i < img.data.length; i += 4) {
        const name = byKey.get(`${img.data[i]},${img.data[i + 1]},${img.data[i + 2]}`);
        if (name) names.add(name);
    }
    return names;
}

/** Read an image this stub wrote. */
export function readImage(path) {
    return stub.__decode(readFileSync(path));
}

/**
 * Install the fake helper over `desktop`. `renders` says how each window
 * renders itself: 'ok' (default), 'blank' (a flat GPU surface) or 'fallback'
 * (the window refused, so the helper copied the screen).
 */
export function captureHelper(desktop, { renders = {}, overrides = {} } = {}) {
    const calls = [];
    const { windows } = desktop;
    harness.resetSharing();
    for (const w of windows) if (!w.private && w.pid !== process.pid) harness.shareWindow(w);
    paintScreens(desktop);
    stub.__state.grabs = 0;
    const handlers = {
        list_windows: () => windows,
        zorder: () =>
            windows
                .filter(w => !w.minimized && !w.cloaked)
                .map(w => ({ ref: w.ref, pid: w.pid, rect: w.rect, owner: w.owner, root_owner: w.root_owner, exe: w.exe })),
        resolve: p => p.refs.map(r => ({ ref: r, rect: windows.find(w => w.ref === r)?.rect ?? null })),
        set_shared: () => null,
        occlusion: () => ({ covered: 0, by: [] }),
        print_window: p => {
            const w = windows.find(x => x.ref === p.window);
            if (!w) throw new Error(`no window for ref '${p.window}'`);
            const how = renders[w.ref] ?? 'ok';
            const { raw, img } = render(w);
            if (how === 'blank') img.data.fill(0);
            const out = how === 'fallback' ? screenCopy(raw) : img;
            require('node:fs').writeFileSync(p.path, stub.__encode(out.width, out.height, out.data));
            return { rect: raw, fallback: how === 'fallback' };
        },
        // Reads the image it is given: one line per window colour in it, so a
        // pixel of the private window that got through is text that got through.
        ocr: p => {
            const seen = coloursIn(readImage(p.path));
            const lines = [];
            if (seen.has('notepad')) lines.push({ text: 'notepad text', rect: rect(10, 40, 100, 12) });
            if (seen.has('calculator')) lines.push({ text: 'calculator text', rect: rect(10, 60, 100, 12) });
            if (seen.has('private') || seen.has('privateBar')) lines.push({ text: 'private text', rect: rect(10, 80, 100, 12) });
            if (seen.has('shadow')) lines.push({ text: 'shadow', rect: rect(10, 100, 100, 12) });
            return lines;
        },
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

/** Call one tool and flatten its result to text. */
export async function call(name, args = {}) {
    const server = harness.buildServer();
    const [a, b] = harness.InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new harness.Client({ name: 'test', version: '0' });
    await client.connect(b);
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

/** The image a capture response names. */
export function imageOf(text) {
    const path = /path: (.+)/.exec(text)?.[1];
    return path ? readImage(path.trim()) : null;
}
