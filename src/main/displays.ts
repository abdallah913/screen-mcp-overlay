import { screen } from 'electron';
import type { DisplayInfo } from '../shared/types.js';

/** Snapshot every display with the geometry the coordinate contract needs. */
export function listDisplays(): DisplayInfo[] {
    const primaryId = screen.getPrimaryDisplay().id;
    return screen.getAllDisplays().map((d, i) => ({
        id: String(d.id),
        label: `Display ${i + 1}${d.id === primaryId ? ' (primary)' : ''} \u2014 ${Math.round(
            d.bounds.width * d.scaleFactor
        )}x${Math.round(d.bounds.height * d.scaleFactor)}`,
        primary: d.id === primaryId,
        scaleFactor: d.scaleFactor,
        dipBounds: { x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height },
        physicalSize: {
            width: Math.round(d.bounds.width * d.scaleFactor),
            height: Math.round(d.bounds.height * d.scaleFactor)
        }
    }));
}

/**
 * Resolve whatever an agent passed as `display` into a real display.
 * Accepts an exact id, a 1-based index ("2"), "primary", or nothing at all.
 */
export function resolveDisplay(ref: string | undefined, displays: DisplayInfo[]): DisplayInfo {
    if (displays.length === 0) throw new Error('no displays detected');
    if (!ref || ref === 'primary') {
        return displays.find(d => d.primary) ?? displays[0]!;
    }
    const byId = displays.find(d => d.id === ref);
    if (byId) return byId;

    const asIndex = Number(ref);
    if (Number.isInteger(asIndex) && asIndex >= 1 && asIndex <= displays.length) {
        return displays[asIndex - 1]!;
    }
    throw new Error(
        `unknown display "${ref}". Known displays: ${displays.map(d => `${d.id} (${d.label})`).join(', ')}`
    );
}
