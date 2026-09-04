import { contextBridge, ipcRenderer } from 'electron';
import type { OverlayState } from '../shared/types.js';

contextBridge.exposeInMainWorld('overlayApi', {
    onState(cb: (s: OverlayState) => void): void {
        ipcRenderer.on('overlay:state', (_e, s: OverlayState) => cb(s));
    },
    reportClick(displayId: string, dip: { x: number; y: number }): void {
        ipcRenderer.send('overlay:click', { displayId, dip });
    },
    cancelClick(): void {
        ipcRenderer.send('overlay:cancel-click');
    }
});
