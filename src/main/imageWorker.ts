import { BrowserWindow } from 'electron';

/**
 * A hidden BrowserWindow used purely as a 2D rasteriser. `nativeImage` can
 * crop and resize but cannot composite, and we need to burn a coordinate grid
 * into screenshots, so we borrow a canvas from Chromium.
 */
let worker: BrowserWindow | null = null;
let ready: Promise<BrowserWindow> | null = null;

function createWorker(): Promise<BrowserWindow> {
    const win = new BrowserWindow({
        show: false,
        width: 16,
        height: 16,
        webPreferences: { offscreen: true, nodeIntegration: false, contextIsolation: true }
    });
    worker = win;
    return win
        .loadURL('data:text/html,<!doctype html><meta charset="utf-8"><title>compositor</title>')
        .then(() => win);
}

async function getWorker(): Promise<BrowserWindow> {
    if (worker && !worker.isDestroyed()) return worker;
    ready = createWorker();
    return ready;
}

export function disposeImageWorker(): void {
    if (worker && !worker.isDestroyed()) worker.destroy();
    worker = null;
    ready = null;
}

/**
 * Draw a labelled grid over a PNG so an agent can read approximate coordinates
 * off the screenshot instead of estimating them. Returns the original buffer
 * unchanged if compositing fails for any reason — a missing grid is a much
 * smaller problem than a failed capture.
 */
export async function compositeGrid(png: Buffer, step: number): Promise<Buffer> {
    try {
        const win = await getWorker();
        const dataUrl = `data:image/png;base64,${png.toString('base64')}`;
        const result: string = await win.webContents.executeJavaScript(
            `(async () => {
                const img = new Image();
                img.src = ${JSON.stringify(dataUrl)};
                await img.decode();
                const w = img.naturalWidth, h = img.naturalHeight;
                const c = document.createElement('canvas');
                c.width = w; c.height = h;
                const g = c.getContext('2d');
                g.drawImage(img, 0, 0);
                g.lineWidth = 1;
                g.strokeStyle = 'rgba(255,0,255,0.35)';
                g.font = '11px monospace';
                g.textBaseline = 'top';
                const step = ${step};
                const label = (t, x, y) => {
                    g.fillStyle = 'rgba(0,0,0,0.55)';
                    const tw = g.measureText(t).width;
                    g.fillRect(x - 1, y - 1, tw + 4, 13);
                    g.fillStyle = '#ff5cf0';
                    g.fillText(t, x + 1, y);
                };
                for (let x = step; x < w; x += step) {
                    g.beginPath(); g.moveTo(x + 0.5, 0); g.lineTo(x + 0.5, h); g.stroke();
                    label(String(x), x + 2, 2);
                }
                for (let y = step; y < h; y += step) {
                    g.beginPath(); g.moveTo(0, y + 0.5); g.lineTo(w, y + 0.5); g.stroke();
                    label(String(y), 2, y + 2);
                }
                return c.toDataURL('image/png');
            })()`,
            true
        );
        const base64 = result.slice(result.indexOf(',') + 1);
        return Buffer.from(base64, 'base64');
    } catch {
        return png;
    }
}
