import { EventEmitter } from 'node:events';
import type { Annotation, CaptureRecord, ClickRequest, Point, Rect, UiSnapshot } from '../shared/types.js';

/**
 * Single source of truth for everything drawn on screen. The MCP server, the
 * agent host and the tray all mutate this; overlay windows subscribe and
 * re-render. Keeping state here (rather than in the MCP server object) is what
 * lets the MCP layer stay stateless and serve many clients at once.
 */
class Store extends EventEmitter {
    private annotations = new Map<string, Annotation>();
    private captures = new Map<string, CaptureRecord>();
    private snapshots = new Map<string, UiSnapshot>();
    private clickRequest: ClickRequest | null = null;
    private seq = 0;
    private sweeper: NodeJS.Timeout | null = null;

    nextId(prefix: string): string {
        this.seq += 1;
        return `${prefix}_${this.seq}`;
    }

    // ---- annotations -------------------------------------------------------

    add(items: Annotation[]): void {
        for (const a of items) this.annotations.set(a.id, a);
        this.scheduleSweep();
        this.emit('annotations');
    }

    clear(ids?: string[]): number {
        if (!ids || ids.length === 0) {
            const n = this.annotations.size;
            this.annotations.clear();
            this.emit('annotations');
            return n;
        }
        let n = 0;
        for (const id of ids) if (this.annotations.delete(id)) n += 1;
        this.emit('annotations');
        return n;
    }

    list(): Annotation[] {
        return [...this.annotations.values()];
    }

    forDisplay(displayId: string): Annotation[] {
        return this.list().filter(a => a.displayId === displayId);
    }

    /** Anchored annotations, for the tracker to re-resolve. */
    anchored(): Annotation[] {
        return this.list().filter(a => a.anchor);
    }

    /**
     * Apply recomputed geometry from the anchor tracker. Emits once for the
     * whole batch, and only when something actually moved -- a redraw on every
     * tick would burn the GPU for nothing while windows sit still.
     */
    applyTracking(
        updates: { id: string; displayId: string; rect: Rect; to?: Point; hidden: boolean }[]
    ): boolean {
        let changed = false;
        for (const u of updates) {
            const a = this.annotations.get(u.id);
            if (!a) continue;
            const moved =
                a.displayId !== u.displayId ||
                a.rect.x !== u.rect.x ||
                a.rect.y !== u.rect.y ||
                a.rect.width !== u.rect.width ||
                a.rect.height !== u.rect.height ||
                a.to?.x !== u.to?.x ||
                a.to?.y !== u.to?.y ||
                !!a.hidden !== u.hidden;
            if (!moved) continue;
            a.displayId = u.displayId;
            a.rect = u.rect;
            a.to = u.to;
            a.hidden = u.hidden;
            changed = true;
        }
        if (changed) this.emit('annotations');
        return changed;
    }

    /** Drop expired annotations and keep a timer running only while needed. */
    private scheduleSweep(): void {
        if (this.sweeper) return;
        this.sweeper = setInterval(() => {
            const now = Date.now();
            let changed = false;
            for (const [id, a] of this.annotations) {
                if (a.expiresAt && a.expiresAt <= now) {
                    this.annotations.delete(id);
                    changed = true;
                }
            }
            const anyPending = [...this.annotations.values()].some(a => a.expiresAt);
            if (!anyPending && this.sweeper) {
                clearInterval(this.sweeper);
                this.sweeper = null;
            }
            if (changed) this.emit('annotations');
        }, 200);
        this.sweeper.unref?.();
    }

    // ---- captures ----------------------------------------------------------

    recordCapture(c: CaptureRecord): void {
        this.captures.set(c.id, c);
        // Keep the last 40 so `space: "image"` stays usable across a long session
        // without leaking unbounded memory.
        if (this.captures.size > 40) {
            const oldest = [...this.captures.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
            if (oldest) this.captures.delete(oldest.id);
        }
    }

    capture(id: string): CaptureRecord | undefined {
        return this.captures.get(id);
    }

    latestCapture(): CaptureRecord | undefined {
        return [...this.captures.values()].sort((a, b) => b.createdAt - a.createdAt)[0];
    }

    // ---- ui snapshots ------------------------------------------------------

    /**
     * Baselines for describe_window deltas. Bounded like captures: a stale id
     * degrades to a full tree rather than an error, so eviction is harmless.
     */
    recordSnapshot(snap: UiSnapshot): string {
        this.snapshots.set(snap.id, snap);
        if (this.snapshots.size > 20) {
            const oldest = [...this.snapshots.values()].sort((a, b) => a.at - b.at)[0];
            if (oldest) this.snapshots.delete(oldest.id);
        }
        return snap.id;
    }

    snapshot(id: string): UiSnapshot | undefined {
        return this.snapshots.get(id);
    }

    // ---- click requests ----------------------------------------------------

    setClickRequest(req: ClickRequest | null): void {
        this.clickRequest = req;
        this.emit('click-request');
    }

    getClickRequest(): ClickRequest | null {
        return this.clickRequest;
    }
}

export const store = new Store();
