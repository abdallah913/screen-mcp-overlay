import { contextBridge, ipcRenderer } from 'electron';
import type { AppStatus, HudMessage } from '../shared/types.js';

contextBridge.exposeInMainWorld('hudApi', {
    onMessage(cb: (m: HudMessage) => void): void {
        ipcRenderer.on('hud:message', (_e, m: HudMessage) => cb(m));
    },
    onStream(cb: (p: { id: string; delta: string; done: boolean }) => void): void {
        ipcRenderer.on('hud:stream', (_e, p) => cb(p));
    },
    onStatus(cb: (s: AppStatus) => void): void {
        ipcRenderer.on('hud:status', (_e, s: AppStatus) => cb(s));
    },
    onBusy(cb: (b: boolean) => void): void {
        ipcRenderer.on('hud:busy', (_e, b: boolean) => cb(b));
    },
    onClear(cb: () => void): void {
        ipcRenderer.on('hud:clear', () => cb());
    },
    onMirror(cb: (label: string | null) => void): void {
        ipcRenderer.on('hud:mirror', (_e, label: string | null) => cb(label));
    },
    onSpeak(cb: (p: { text: string; rate: number }) => void): void {
        ipcRenderer.on('hud:speak', (_e, p) => cb(p));
    },
    send: (prompt: string): Promise<void> => ipcRenderer.invoke('agent:send', prompt),
    interrupt: (): Promise<void> => ipcRenderer.invoke('agent:interrupt'),
    reset: (): Promise<void> => ipcRenderer.invoke('agent:reset'),
    listAttachable: (): Promise<unknown[]> => ipcRenderer.invoke('agent:list-attachable'),
    mirror: (dir: string, id: string, summary: string): Promise<void> =>
        ipcRenderer.invoke('agent:mirror', dir, id, summary),
    stopMirror: (): Promise<void> => ipcRenderer.invoke('agent:stop-mirror'),
    clearScreen: (): Promise<void> => ipcRenderer.invoke('app:clear-annotations'),
    copyMcpUrl: (): Promise<void> => ipcRenderer.invoke('app:copy-mcp-url'),
    hide: (): void => ipcRenderer.send('app:hide-hud')
});
