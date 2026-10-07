/**
 * Just enough of Electron for the MCP layer to load and run under plain Node:
 * one 1920x1080 display at scale 1, so physical pixels and DIPs coincide and a
 * test can reason about geometry without conversions. Anything that would
 * need a real window or a real screen grab is a no-op.
 */
const display = { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 };
const noop = () => {};

class BrowserWindow {
    static getAllWindows() {
        return [];
    }
}

module.exports = {
    app: { getPath: () => require('node:os').tmpdir(), getAppPath: () => process.cwd() },
    screen: {
        getPrimaryDisplay: () => display,
        getAllDisplays: () => [display],
        screenToDipPoint: p => ({ x: p.x, y: p.y }),
        getDisplayNearestPoint: () => display,
        on: noop
    },
    ipcMain: { on: noop, handle: noop },
    BrowserWindow,
    desktopCapturer: {
        getSources: async () => {
            throw new Error('screen capture is not available under test');
        }
    },
    nativeImage: { createFromPath: () => ({ isEmpty: () => true }), createEmpty: () => ({}) },
    clipboard: { writeText: noop }
};
