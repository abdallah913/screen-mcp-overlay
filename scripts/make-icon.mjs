#!/usr/bin/env node
/**
 * Generates build/icon.ico (and icon.png) with no image dependencies.
 *
 * Shapes are rasterised into an RGBA buffer with 4x4 supersampling, encoded as
 * PNG by hand, and packed into a Vista-style ICO that embeds PNG data directly.
 * Keeping this in-repo means the icon is reproducible and reviewable as code
 * rather than an opaque binary.
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'build');
mkdirSync(outDir, { recursive: true });

const SS = 4; // supersampling factor

// ---------------------------------------------------------------- rasteriser

const hex = h => [
    parseInt(h.slice(1, 3), 16),
    parseInt(h.slice(3, 5), 16),
    parseInt(h.slice(5, 7), 16)
];

/** Signed distance from a point to a rounded rectangle. Negative is inside. */
function sdRoundRect(px, py, cx, cy, hw, hh, r) {
    const qx = Math.abs(px - cx) - (hw - r);
    const qy = Math.abs(py - cy) - (hh - r);
    const ax = Math.max(qx, 0);
    const ay = Math.max(qy, 0);
    return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r;
}

function render(size) {
    const S = size * SS;
    const acc = new Float32Array(S * S * 4);

    const put = (i, [r, g, b], a) => {
        if (a <= 0) return;
        // Source-over compositing in straight alpha.
        const dr = acc[i], dg = acc[i + 1], db = acc[i + 2], da = acc[i + 3];
        const na = a + da * (1 - a);
        if (na <= 0) return;
        acc[i] = (r * a + dr * da * (1 - a)) / na;
        acc[i + 1] = (g * a + dg * da * (1 - a)) / na;
        acc[i + 2] = (b * a + db * da * (1 - a)) / na;
        acc[i + 3] = na;
    };

    const BG = hex('#17171a');
    const EDGE = hex('#3a3a42');
    const BOX = hex('#ff3b30');
    const DOT = hex('#0a84ff');

    // Antialias from the signed distance. Distances are in unit space, so scale
    // by the supersampled resolution to get a ramp exactly one sample wide.
    const cov = d => Math.min(1, Math.max(0, 0.5 - d * S));

    for (let y = 0; y < S; y += 1) {
        for (let x = 0; x < S; x += 1) {
            const u = (x + 0.5) / S;
            const v = (y + 0.5) / S;
            const i = (y * S + x) * 4;

            // Background plate.
            const dBg = sdRoundRect(u, v, 0.5, 0.5, 0.5, 0.5, 0.22);
            put(i, BG, cov(dBg));
            // A hairline rim so the icon reads against dark taskbars.
            put(i, EDGE, cov(Math.abs(dBg + 0.018) - 0.016) * 0.9);

            // The annotation box: a hollow rounded rectangle.
            const dBox = sdRoundRect(u, v, 0.47, 0.46, 0.24, 0.19, 0.05);
            put(i, BOX, cov(Math.abs(dBox) - 0.032));

            // Pointer dot riding the box's lower-right corner.
            const dDot = Math.hypot(u - 0.73, v - 0.68) - 0.1;
            put(i, DOT, cov(dDot));
        }
    }

    // Box-filter down to the final size.
    const out = Buffer.alloc(size * size * 4);
    for (let y = 0; y < size; y += 1) {
        for (let x = 0; x < size; x += 1) {
            let r = 0, g = 0, b = 0, a = 0;
            for (let sy = 0; sy < SS; sy += 1) {
                for (let sx = 0; sx < SS; sx += 1) {
                    const i = ((y * SS + sy) * S + (x * SS + sx)) * 4;
                    const sa = acc[i + 3];
                    r += acc[i] * sa;
                    g += acc[i + 1] * sa;
                    b += acc[i + 2] * sa;
                    a += sa;
                }
            }
            const n = SS * SS;
            const o = (y * size + x) * 4;
            // Un-premultiply so the PNG carries straight alpha.
            out[o] = a > 0 ? Math.round(r / a) : 0;
            out[o + 1] = a > 0 ? Math.round(g / a) : 0;
            out[o + 2] = a > 0 ? Math.round(b / a) : 0;
            out[o + 3] = Math.round((a / n) * 255);
        }
    }
    return out;
}

// -------------------------------------------------------------- PNG encoding

const CRC_TABLE = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
        let c = n;
        for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c;
    }
    return t;
})();

function crc32(buf) {
    let c = -1;
    for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
}

function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
}

function encodePng(size, rgba) {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(size, 0);
    ihdr.writeUInt32BE(size, 4);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 6; // RGBA
    // Each scanline is prefixed with filter type 0 (none).
    const raw = Buffer.alloc(size * (size * 4 + 1));
    for (let y = 0; y < size; y += 1) {
        raw[y * (size * 4 + 1)] = 0;
        rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
    }
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', deflateSync(raw, { level: 9 })),
        chunk('IEND', Buffer.alloc(0))
    ]);
}

// -------------------------------------------------------------- ICO assembly

const SIZES = [16, 24, 32, 48, 64, 128, 256];
const pngs = SIZES.map(s => ({ size: s, data: encodePng(s, render(s)) }));

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(pngs.length, 4);

let offset = 6 + pngs.length * 16;
const entries = [];
for (const { size, data } of pngs) {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size; // 0 means 256
    e[1] = size >= 256 ? 0 : size;
    e[2] = 0; // palette size
    e[3] = 0; // reserved
    e.writeUInt16LE(1, 4); // colour planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    offset += data.length;
}

const ico = Buffer.concat([header, ...entries, ...pngs.map(p => p.data)]);
writeFileSync(join(outDir, 'icon.ico'), ico);
writeFileSync(join(outDir, 'icon.png'), pngs.find(p => p.size === 256).data);
// The tray needs a small bitmap; 32px keeps it crisp at 100-150% scaling.
writeFileSync(join(outDir, 'tray.png'), pngs.find(p => p.size === 32).data);

console.log(`build/icon.ico   ${ico.length} bytes, sizes: ${SIZES.join(', ')}`);
console.log(`build/icon.png   ${pngs.find(p => p.size === 256).data.length} bytes`);
console.log(`build/tray.png   ${pngs.find(p => p.size === 32).data.length} bytes`);
