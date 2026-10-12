/**
 * The test harness (harness.ts), plus the capture directory, for the capture
 * tests: bundled against capture-stub.cjs instead of electron-stub.cjs, so
 * screen grabs and window renders produce real pixels.
 */
export * from './harness.js';
export { initCaptureDir, cleanupCaptureDir } from '../../src/main/capture.js';
export { setContentProtection } from '../../src/main/overlay.js';
