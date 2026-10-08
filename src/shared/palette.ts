import type { ShapeType } from './types.js';

/**
 * Default colour per shape. Shared by the tool layer, which stamps a colour on
 * every annotation it creates, and the renderer, which chooses legible text
 * for whatever colour a badge ends up with.
 */
export const DEFAULT_COLORS: Record<ShapeType, string> = {
    box: '#ff3b30',
    highlight: '#ffd60a',
    circle: '#ff3b30',
    arrow: '#ff3b30',
    label: '#ffffff',
    spotlight: '#000000',
    step: '#0a84ff',
    done: '#30d158'
};
