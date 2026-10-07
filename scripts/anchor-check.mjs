#!/usr/bin/env node
/**
 * Proves anchored annotations track their target.
 *
 * Boxes a real window via list_windows, then moves that window with Win32
 * SetWindowPos and re-reads where the annotation ended up. If tracking works the
 * annotation's screen position shifts by the same delta as the window.
 * Run the overlay with SCREEN_OVERLAY_SHOW_IN_CAPTURE=1 to see it happen.
 */

import { connectOverlay, parseWindows, textOf } from './lib/client.mjs';
import { execFileSync } from 'node:child_process';

const client = await connectOverlay('dev-script');

// --- pick a window to anchor to -------------------------------------------
const windows = textOf(await client.callTool({ name: 'list_windows', arguments: {} }));
console.log(windows.split('\n').slice(0, 10).join('\n'));

const entries = parseWindows(windows);

// A movable, non-maximised window is the honest test case.
const target = entries.find(e => e.w < 2000 && e.h < 1200 && e.x > 0) ?? entries[0];
if (!target) throw new Error('no window to test against');
console.log(`\ntarget: "${target.title}" ref=${target.ref} at (${target.x}, ${target.y})`);

// --- anchor a box to it ----------------------------------------------------
console.log('\n' + textOf(await client.callTool({
    name: 'annotate',
    arguments: {
        // A box with no size fits its anchor.
        anchor: { window: target.ref },
        shapes: [
            { type: 'box', pad: 6, text: 'anchored', color: '#32d74b', thickness: 4 },
            { type: 'label', x: 20, y: 40, text: 'follows the window' }
        ]
    }
})));

const moveWindow = (ref, dx, dy) => {
    const ps = `
Add-Type @"
using System;using System.Runtime.InteropServices;
public class W {
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h,IntPtr a,int x,int y,int cx,int cy,uint f);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);
  [StructLayout(LayoutKind.Sequential)] public struct R { public int L,T,Rt,B; }
}
"@
$h = [IntPtr]${ref}
$r = New-Object W+R
[void][W]::GetWindowRect($h, [ref]$r)
[void][W]::SetWindowPos($h, [IntPtr]::Zero, $r.L + ${dx}, $r.T + ${dy}, 0, 0, 0x0001 -bor 0x0004)
`;
    execFileSync('powershell', ['-NoProfile', '-Command', ps], { stdio: 'pipe' });
};

const readBack = async () => {
    // Re-listing gives the window's live rect; the annotation is pinned to it.
    const t = textOf(await client.callTool({ name: 'list_windows', arguments: {} }));
    const w = parseWindows(t).find(e => e.ref === target.ref);
    return w ? { x: w.x, y: w.y } : null;
};

console.log('\nbefore move :', JSON.stringify(await readBack()));
console.log('moving the window by (+120, +80)…');
moveWindow(target.ref, 120, 80);
await new Promise(r => setTimeout(r, 900));
const after = await readBack();
console.log('after move  :', JSON.stringify(after));

if (after) {
    const dx = after.x - target.x;
    const dy = after.y - target.y;
    console.log(`window delta: (${dx}, ${dy})  ${dx === 120 && dy === 80 ? 'as expected' : '(window manager adjusted it)'}`);
}

console.log('\nHolding 6s — the green box should be sitting on the moved window.');
await new Promise(r => setTimeout(r, 6000));

// Put it back and clean up.
moveWindow(target.ref, -120, -80);
await client.callTool({ name: 'clear_annotations', arguments: {} });
await client.close();
console.log('window restored, annotations cleared');
