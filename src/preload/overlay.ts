import { contextBridge, ipcRenderer } from 'electron';
import type { Rect, UserAnswer } from '../shared/types.js';
import type { OverlayFrame } from '../shared/layout.js';

contextBridge.exposeInMainWorld('overlayApi', {
    onState(cb: (s: OverlayFrame) => void): void {
        ipcRenderer.on('overlay:state', (_e, s: OverlayFrame) => cb(s));
    },
    reportClick(displayId: string, dip: { x: number; y: number }): void {
        ipcRenderer.send('overlay:click', { displayId, dip });
    },
    cancelClick(): void {
        ipcRenderer.send('overlay:cancel-click');
    },
    answer(id: string, answer: UserAnswer): void {
        ipcRenderer.send('overlay:step-answer', { id, answer });
    },
    hoverUi(over: boolean): void {
        ipcRenderer.send('overlay:hover-ui', over);
    },
    stripRect(rect: Rect | null): void {
        ipcRenderer.send('overlay:strip', rect);
    }
});
