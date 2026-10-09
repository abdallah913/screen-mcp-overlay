import { contextBridge, ipcRenderer } from 'electron';
import type { Rect, UserAnswer } from '../shared/types.js';
import type { OverlayFrame } from '../shared/layout.js';

contextBridge.exposeInMainWorld('overlayApi', {
    onState(cb: (s: OverlayFrame) => void): void {
        ipcRenderer.on('overlay:state', (_e, s: OverlayFrame) => cb(s));
    },
    onPing(cb: (ids: string[]) => void): void {
        ipcRenderer.on('overlay:ping', (_e, ids: unknown) => {
            if (Array.isArray(ids)) cb(ids.filter((id): id is string => typeof id === 'string'));
        });
    },
    // A click or Cancel names the step it was made against, like an answer
    // does: one in flight while the agent replaces the step must not land on
    // the new step, whose prompt the user has not even seen yet.
    reportClick(stepId: string, displayId: string, dip: { x: number; y: number }): void {
        ipcRenderer.send('overlay:click', { id: stepId, displayId, dip });
    },
    cancelClick(stepId: string): void {
        ipcRenderer.send('overlay:cancel-click', { id: stepId });
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
