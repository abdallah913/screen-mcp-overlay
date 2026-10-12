/**
 * The Electron stub (electron-stub.cjs) with a working image model, for the
 * capture tests: images are BGRA bitmaps in memory, "PNG" files are a raw
 * bitmap behind a small header, and the screen is whatever the test paints
 * into `state.screen`. Every read of the screen is counted, so a test can say
 * that a capture never looked at it.
 *
 * Displays are configurable (`state.displays`), so captures can be tested on
 * a second monitor left of the primary one, at a negative origin.
 */
const { readFileSync } = require('node:fs');

const noop = () => {};
const MAGIC = 'BGRA';

const state = {
    /** Electron displays: { id, bounds (DIP), scaleFactor }. The first is primary. */
    displays: [{ id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 }],
    /** The screen as desktopCapturer sees it, per display id: { width, height, data } in BGRA. */
    screen: {},
    /** How many times the screen was grabbed. */
    grabs: 0
};

function image(width, height, data = new Uint8Array(width * height * 4)) {
    return {
        isEmpty: () => width === 0 || height === 0,
        getSize: () => ({ width, height }),
        toBitmap: () => Buffer.from(data),
        crop: r => {
            const out = new Uint8Array(r.width * r.height * 4);
            for (let y = 0; y < r.height; y += 1) {
                const from = ((r.y + y) * width + r.x) * 4;
                out.set(data.subarray(from, from + r.width * 4), y * r.width * 4);
            }
            return image(r.width, r.height, out);
        },
        // Nearest neighbour: enough to keep colours exact for the tests.
        resize: o => {
            const out = new Uint8Array(o.width * o.height * 4);
            for (let y = 0; y < o.height; y += 1) {
                for (let x = 0; x < o.width; x += 1) {
                    const sx = Math.min(width - 1, Math.floor((x * width) / o.width));
                    const sy = Math.min(height - 1, Math.floor((y * height) / o.height));
                    out.set(data.subarray((sy * width + sx) * 4, (sy * width + sx) * 4 + 4), (y * o.width + x) * 4);
                }
            }
            return image(o.width, o.height, out);
        },
        toPNG: () => encode(width, height, data)
    };
}

function encode(width, height, data) {
    const head = Buffer.alloc(12);
    head.write(MAGIC, 0, 'ascii');
    head.writeUInt32LE(width, 4);
    head.writeUInt32LE(height, 8);
    return Buffer.concat([head, Buffer.from(data)]);
}

function decode(buf) {
    if (buf.length < 12 || buf.toString('ascii', 0, 4) !== MAGIC) return null;
    const width = buf.readUInt32LE(4);
    const height = buf.readUInt32LE(8);
    return { width, height, data: new Uint8Array(buf.subarray(12)) };
}

const electronDisplay = d => d;
const primary = () => state.displays[0];
const dipToScreenPoint = p => {
    // Displays sit side by side at their own scale: a point's physical
    // position is its display's physical origin plus the scaled offset.
    const d = state.displays.find(
        x => p.x >= x.bounds.x && p.x <= x.bounds.x + x.bounds.width && p.y >= x.bounds.y && p.y <= x.bounds.y + x.bounds.height
    ) ?? primary();
    return { x: d.bounds.x + (p.x - d.bounds.x) * d.scaleFactor, y: d.bounds.y + (p.y - d.bounds.y) * d.scaleFactor };
};
const screenToDipPoint = p => {
    const d = state.displays.find(x => {
        const w = x.bounds.width * x.scaleFactor;
        const h = x.bounds.height * x.scaleFactor;
        return p.x >= x.bounds.x && p.x <= x.bounds.x + w && p.y >= x.bounds.y && p.y <= x.bounds.y + h;
    }) ?? primary();
    return { x: d.bounds.x + (p.x - d.bounds.x) / d.scaleFactor, y: d.bounds.y + (p.y - d.bounds.y) / d.scaleFactor };
};
const matching = r => {
    let best = primary();
    let most = -1;
    for (const d of state.displays) {
        const b = d.bounds;
        const w = Math.max(0, Math.min(r.x + r.width, b.x + b.width) - Math.max(r.x, b.x));
        const h = Math.max(0, Math.min(r.y + r.height, b.y + b.height) - Math.max(r.y, b.y));
        if (w * h > most) {
            most = w * h;
            best = d;
        }
    }
    return best;
};

class BrowserWindow {
    static getAllWindows() {
        return [];
    }
}

module.exports = {
    __state: state,
    __decode: decode,
    __encode: encode,
    app: { getPath: () => require('node:os').tmpdir(), getAppPath: () => process.cwd() },
    screen: {
        getPrimaryDisplay: () => electronDisplay(primary()),
        getAllDisplays: () => state.displays.map(electronDisplay),
        screenToDipPoint,
        dipToScreenPoint,
        getDisplayMatching: matching,
        getDisplayNearestPoint: p => matching({ x: p.x, y: p.y, width: 1, height: 1 }),
        on: noop
    },
    ipcMain: { on: noop, handle: noop },
    BrowserWindow,
    desktopCapturer: {
        getSources: async () => {
            state.grabs += 1;
            return state.displays.map(d => {
                const s = state.screen[d.id];
                return { display_id: String(d.id), thumbnail: s ? image(s.width, s.height, s.data) : image(0, 0) };
            });
        }
    },
    nativeImage: {
        createFromPath: path => {
            let decoded = null;
            try {
                decoded = decode(readFileSync(path));
            } catch {
                // A missing file is an empty image, as in Electron.
            }
            return decoded ? image(decoded.width, decoded.height, decoded.data) : image(0, 0);
        },
        createFromBitmap: (buf, o) => image(o.width, o.height, new Uint8Array(buf)),
        createEmpty: () => image(0, 0)
    },
    clipboard: { writeText: noop }
};

// The bundle holds its own copy of this module; tests reach it here.
globalThis.__captureStub = module.exports;
