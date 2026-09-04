import type { Annotation, ClickRequest, OverlayState } from '../../shared/types.js';

/**
 * The drawing surface. The window exactly covers one display in DIPs, so the
 * canvas CSS coordinate space *is* display-local DIPs and annotations arrive
 * ready to draw with no further conversion.
 */

declare global {
    interface Window {
        overlayApi: {
            onState(cb: (s: OverlayState) => void): void;
            reportClick(displayId: string, dip: { x: number; y: number }): void;
            cancelClick(): void;
        };
    }
}

const canvas = document.getElementById('c') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const banner = document.getElementById('banner') as HTMLDivElement;
const bannerText = document.getElementById('banner-text') as HTMLSpanElement;

let annotations: Annotation[] = [];
let click: ClickRequest | null = null;
let displayId = '';
let collected = 0;
/** rAF handle while an animation is running; null when the canvas is static. */
let frame: number | null = null;

/**
 * Whether anything on screen actually changes between frames.
 *
 * A static overlay does not need repainting at 60fps, and repainting it anyway
 * cost about 5% of a core with nothing drawn. Only pulsing shapes need a loop.
 */
function needsAnimation(): boolean {
    return annotations.some(a => a.pulse);
}

/** Paint once, and keep painting only while something is animating. */
function scheduleDraw(): void {
    if (frame !== null) return;
    frame = requestAnimationFrame(function loop(now: number) {
        draw(now);
        frame = needsAnimation() ? requestAnimationFrame(loop) : null;
    });
}

function resize(): void {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    canvas.style.width = `${window.innerWidth}px`;
    canvas.style.height = `${window.innerHeight}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

window.addEventListener('resize', () => {
    resize();
    scheduleDraw();
});
resize();

window.overlayApi.onState(state => {
    annotations = state.annotations;
    displayId = annotations[0]?.displayId ?? displayId;
    const wasPending = click !== null;
    click = state.click;
    if (!click) collected = 0;
    if (wasPending !== (click !== null)) updateClickMode();
    updateBanner();
    scheduleDraw();
});

function updateBanner(): void {
    if (!click) {
        banner.classList.remove('visible');
        return;
    }
    const remaining = click.count - collected;
    const suffix = click.count > 1 ? `  (${remaining} more to click)` : '';
    bannerText.textContent = `${click.prompt}${suffix}`;
    banner.classList.add('visible');
}

function updateClickMode(): void {
    document.body.classList.toggle('picking', click !== null);
}

window.addEventListener(
    'click',
    e => {
        if (!click) return;
        e.preventDefault();
        collected += 1;
        window.overlayApi.reportClick(displayId, { x: e.clientX, y: e.clientY });
        updateBanner();
    },
    true
);

window.addEventListener('keydown', e => {
    if (e.key === 'Escape' && click) window.overlayApi.cancelClick();
});

// ---------------------------------------------------------------- rendering

function pulseAlpha(now: number): number {
    // 0.45 .. 1.0 on a ~1.6s cycle. Slow enough to notice, not to annoy.
    return 0.725 + 0.275 * Math.sin((now / 1600) * Math.PI * 2);
}

function draw(now: number): void {
    // Called from scheduleDraw only; it decides whether another frame follows.
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);

    // Spotlights first: they paint a full-screen scrim that everything else
    // must sit on top of.
    for (const a of annotations) {
        if (a.type !== 'spotlight') continue;
        ctx.save();
        ctx.fillStyle = `rgba(0,0,0,${a.dim ?? 0.6})`;
        ctx.fillRect(0, 0, window.innerWidth, window.innerHeight);
        ctx.globalCompositeOperation = 'destination-out';
        roundRect(a.rect.x, a.rect.y, a.rect.width, a.rect.height, 8);
        ctx.fill();
        ctx.restore();

        ctx.save();
        ctx.strokeStyle = 'rgba(255,255,255,0.85)';
        ctx.lineWidth = 2;
        roundRect(a.rect.x, a.rect.y, a.rect.width, a.rect.height, 8);
        ctx.stroke();
        ctx.restore();
    }

    for (const a of annotations) {
        if (a.type === 'spotlight') continue;
        ctx.save();
        ctx.globalAlpha = a.pulse ? pulseAlpha(now) : 1;
        ctx.strokeStyle = a.color ?? '#ff3b30';
        ctx.fillStyle = a.color ?? '#ff3b30';
        ctx.lineWidth = a.thickness ?? 3;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';

        switch (a.type) {
            case 'box':
                shadowed(() => {
                    roundRect(a.rect.x, a.rect.y, a.rect.width, a.rect.height, 6);
                    ctx.stroke();
                });
                if (a.text) caption(a.text, a.rect.x, a.rect.y, a.color ?? '#ff3b30');
                break;

            case 'highlight':
                ctx.globalAlpha *= 0.28;
                roundRect(a.rect.x, a.rect.y, a.rect.width, a.rect.height, 4);
                ctx.fill();
                ctx.globalAlpha = a.pulse ? pulseAlpha(now) : 1;
                ctx.lineWidth = 1.5;
                ctx.stroke();
                if (a.text) caption(a.text, a.rect.x, a.rect.y, a.color ?? '#ffd60a');
                break;

            case 'circle':
                shadowed(() => {
                    ctx.beginPath();
                    ctx.ellipse(
                        a.rect.x + a.rect.width / 2,
                        a.rect.y + a.rect.height / 2,
                        Math.max(1, a.rect.width / 2),
                        Math.max(1, a.rect.height / 2),
                        0,
                        0,
                        Math.PI * 2
                    );
                    ctx.stroke();
                });
                if (a.text) caption(a.text, a.rect.x, a.rect.y, a.color ?? '#ff3b30');
                break;

            case 'arrow':
                if (a.to) shadowed(() => arrow(a.rect.x, a.rect.y, a.to!.x, a.to!.y, a.thickness ?? 3));
                if (a.text) caption(a.text, a.rect.x, a.rect.y, a.color ?? '#ff3b30');
                break;

            case 'label':
                caption(a.text ?? '', a.rect.x, a.rect.y, a.color ?? '#ffffff', true);
                break;

            case 'step':
                shadowed(() => {
                    roundRect(a.rect.x, a.rect.y, a.rect.width, a.rect.height, 6);
                    ctx.stroke();
                });
                badge(a.text ?? '?', a.rect.x, a.rect.y, a.color ?? '#0a84ff');
                break;
        }
        ctx.restore();
    }
}

function shadowed(fn: () => void): void {
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.55)';
    ctx.shadowBlur = 6;
    fn();
    ctx.restore();
}

function roundRect(x: number, y: number, w: number, h: number, r: number): void {
    const rad = Math.max(0, Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2));
    ctx.beginPath();
    ctx.moveTo(x + rad, y);
    ctx.arcTo(x + w, y, x + w, y + h, rad);
    ctx.arcTo(x + w, y + h, x, y + h, rad);
    ctx.arcTo(x, y + h, x, y, rad);
    ctx.arcTo(x, y, x + w, y, rad);
    ctx.closePath();
}

function arrow(x1: number, y1: number, x2: number, y2: number, thickness: number): void {
    const head = Math.max(10, thickness * 4);
    const angle = Math.atan2(y2 - y1, x2 - x1);
    // Stop the shaft short so it does not poke through the head.
    const shaftX = x2 - Math.cos(angle) * head * 0.7;
    const shaftY = y2 - Math.sin(angle) * head * 0.7;

    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(shaftX, shaftY);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - head * Math.cos(angle - Math.PI / 7), y2 - head * Math.sin(angle - Math.PI / 7));
    ctx.lineTo(x2 - head * Math.cos(angle + Math.PI / 7), y2 - head * Math.sin(angle + Math.PI / 7));
    ctx.closePath();
    ctx.fill();
}

/** A readable text chip. Flips below the anchor when it would clip off the top. */
function caption(textBody: string, x: number, y: number, color: string, centred = false): void {
    if (!textBody) return;
    ctx.save();
    ctx.font = '600 14px system-ui, -apple-system, Segoe UI, sans-serif';
    ctx.textBaseline = 'middle';
    const padX = 8;
    const h = 24;
    const w = ctx.measureText(textBody).width + padX * 2;

    let bx = centred ? x - w / 2 : x;
    let by = y - h - 6;
    if (by < 2) by = y + 6;
    bx = Math.max(2, Math.min(bx, window.innerWidth - w - 2));

    ctx.shadowColor = 'rgba(0,0,0,0.5)';
    ctx.shadowBlur = 8;
    ctx.fillStyle = 'rgba(20,20,22,0.92)';
    roundRect(bx, by, w, h, 6);
    ctx.fill();
    ctx.shadowBlur = 0;

    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    roundRect(bx, by, w, h, 6);
    ctx.stroke();

    ctx.fillStyle = '#f5f5f7';
    ctx.fillText(textBody, bx + padX, by + h / 2 + 0.5);
    ctx.restore();
}

/** Numbered circle pinned to a step box's top-left corner. */
function badge(label: string, x: number, y: number, color: string): void {
    const r = 15;
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.5)';
    ctx.shadowBlur = 8;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.font = '700 15px system-ui, -apple-system, Segoe UI, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, x, y + 0.5);
    ctx.restore();
}

scheduleDraw();
