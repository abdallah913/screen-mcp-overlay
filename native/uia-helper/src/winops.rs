//! Window operations: focus, occlusion, true window capture and scrolling.
//!
//! These exist because cropping a screen grab to a window's rectangle captures
//! whatever is *rendered* there, which is the topmost window, not necessarily
//! the one that was asked for. Returning another application's pixels under the
//! requested window's name is the worst kind of wrong: it looks right, so an
//! agent annotates over it confidently.

use serde::Serialize;
use windows::Win32::Foundation::{HWND, LPARAM, RECT, WPARAM};
use windows::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits,
    ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HBITMAP, HDC,
    SRCCOPY,
};
// PrintWindow lives under Storage::Xps, and AttachThreadInput under
// System::Threading, rather than where their use would suggest.
use windows::Win32::Storage::Xps::{PrintWindow, PRINT_WINDOW_FLAGS};
use windows::Win32::System::Threading::AttachThreadInput;
use windows::Win32::UI::Input::KeyboardAndMouse::{SetActiveWindow, SetFocus};
use windows::Win32::UI::WindowsAndMessaging::{
    BringWindowToTop, GetForegroundWindow, GetWindow, GetWindowLongW, GetWindowThreadProcessId,
    IsIconic, IsWindowVisible, SendMessageW, SetForegroundWindow, ShowWindow, GWL_EXSTYLE,
    GW_HWNDPREV, SW_RESTORE, WM_MOUSEWHEEL, WS_EX_TOOLWINDOW,
};

use crate::{is_cloaked, rect_of, Rect};

/// PW_RENDERFULLCONTENT: renders DirectComposition surfaces too, which is what
/// makes this work for Chromium and other GPU-composited apps.
const PW_RENDERFULLCONTENT: PRINT_WINDOW_FLAGS = PRINT_WINDOW_FLAGS(2);

#[derive(Serialize)]
pub struct Occlusion {
    /// Rough fraction of the window covered by windows above it, 0.0 to 1.0.
    pub covered: f32,
    /// Titles of the windows sitting on top, nearest first.
    pub by: Vec<String>,
}

fn intersect(a: &Rect, b: &Rect) -> i64 {
    let x = (a.x + a.width).min(b.x + b.width) - a.x.max(b.x);
    let y = (a.y + a.height).min(b.y + b.height) - a.y.max(b.y);
    if x <= 0 || y <= 0 {
        0
    } else {
        x as i64 * y as i64
    }
}

/// How much of `hwnd` is hidden behind windows above it in the Z order.
///
/// Approximate on purpose: overlapping occluders are summed rather than unioned,
/// so the figure can overshoot. It is a "do not trust this capture" signal, not
/// a measurement.
pub fn occlusion_of(hwnd: HWND, ignore_pid: u32) -> Occlusion {
    let Some(target) = rect_of(hwnd) else {
        return Occlusion { covered: 0.0, by: Vec::new() };
    };
    let area = (target.width as i64 * target.height as i64).max(1);

    let mut covered = 0i64;
    let mut by = Vec::new();
    // GW_HWNDPREV walks towards the front of the Z order.
    let mut above = unsafe { GetWindow(hwnd, GW_HWNDPREV) }.unwrap_or_default();

    while !above.is_invalid() {
        let visible = unsafe { IsWindowVisible(above) }.as_bool();
        let tool = unsafe { GetWindowLongW(above, GWL_EXSTYLE) } as u32 & WS_EX_TOOLWINDOW.0 != 0;
        // The overlay's own windows cover the whole screen and are click-through
        // and excluded from capture, so counting them would report every window
        // as fully occluded, always.
        let mut owner_pid = 0u32;
        unsafe { GetWindowThreadProcessId(above, Some(&mut owner_pid)) };
        let ours = ignore_pid != 0 && owner_pid == ignore_pid;
        if visible && !tool && !ours && !is_cloaked(above) && !unsafe { IsIconic(above) }.as_bool() {
            if let Some(r) = rect_of(above) {
                let overlap = intersect(&target, &r);
                if overlap > area / 100 {
                    covered += overlap;
                    by.push(crate::title_of(above));
                }
            }
        }
        above = unsafe { GetWindow(above, GW_HWNDPREV) }.unwrap_or_default();
    }

    Occlusion { covered: (covered as f64 / area as f64).min(1.0) as f32, by }
}

/// Bring a window to the front and give it focus.
///
/// Windows refuses SetForegroundWindow from a process that does not already own
/// the foreground, to stop applications stealing focus. Attaching to the current
/// foreground thread's input queue first is the documented way round it, and is
/// what every window-manager utility does.
pub fn focus(hwnd: HWND) -> Result<(), String> {
    if !unsafe { IsWindowVisible(hwnd) }.as_bool() {
        return Err("that window is not visible".into());
    }
    unsafe {
        if IsIconic(hwnd).as_bool() {
            let _ = ShowWindow(hwnd, SW_RESTORE);
        }

        let foreground = GetForegroundWindow();
        let mut target_pid = 0u32;
        let target_thread = GetWindowThreadProcessId(hwnd, Some(&mut target_pid));
        let fg_thread = if foreground.is_invalid() {
            0
        } else {
            GetWindowThreadProcessId(foreground, None)
        };

        let attached = fg_thread != 0 && fg_thread != target_thread;
        if attached {
            let _ = AttachThreadInput(fg_thread, target_thread, true);
        }

        let _ = BringWindowToTop(hwnd);
        let ok = SetForegroundWindow(hwnd).as_bool();
        let _ = SetActiveWindow(hwnd);
        let _ = SetFocus(Some(hwnd));

        if attached {
            let _ = AttachThreadInput(fg_thread, target_thread, false);
        }

        if !ok && GetForegroundWindow() != hwnd {
            return Err(
                "Windows refused the focus change. This happens when the foreground application \
                 is locking focus, or during a drag. Ask the user to click the window instead."
                    .into(),
            );
        }
    }
    Ok(())
}

/// Capture a window's own pixels, even when something is covering it.
///
/// PrintWindow asks the window to render itself into a bitmap, so the result is
/// the window's content rather than whatever happens to be on screen at those
/// coordinates.
pub fn print_window_png(hwnd: HWND, path: &str) -> Result<Rect, String> {
    let rect = rect_of(hwnd).ok_or("could not measure that window")?;
    // PrintWindow works in window coordinates, which include the frame that the
    // DWM extended bounds trims, so use the raw window rect for the bitmap size.
    let mut raw = RECT::default();
    unsafe {
        windows::Win32::UI::WindowsAndMessaging::GetWindowRect(hwnd, &mut raw)
            .map_err(|e| e.to_string())?
    };
    let width = (raw.right - raw.left).max(1);
    let height = (raw.bottom - raw.top).max(1);
    let _ = rect;

    unsafe {
        let screen_dc: HDC = GetDC(None);
        if screen_dc.is_invalid() {
            return Err("could not obtain a device context".into());
        }
        let mem_dc = CreateCompatibleDC(Some(screen_dc));
        let bitmap: HBITMAP = CreateCompatibleBitmap(screen_dc, width, height);
        let old = SelectObject(mem_dc, bitmap.into());

        let printed = PrintWindow(hwnd, mem_dc, PW_RENDERFULLCONTENT).as_bool();
        if !printed {
            // Some windows refuse PrintWindow; fall back to copying the screen,
            // which is what the old behaviour did all the time.
            let _ = BitBlt(mem_dc, 0, 0, width, height, Some(screen_dc), raw.left, raw.top, SRCCOPY);
        }

        let mut info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width,
                // Negative height gives a top-down image, matching PNG order.
                biHeight: -height,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };

        let mut buf = vec![0u8; (width as usize) * (height as usize) * 4];
        let copied = GetDIBits(
            mem_dc,
            bitmap,
            0,
            height as u32,
            Some(buf.as_mut_ptr() as *mut _),
            &mut info,
            DIB_RGB_COLORS,
        );

        SelectObject(mem_dc, old);
        let _ = DeleteObject(bitmap.into());
        let _ = DeleteDC(mem_dc);
        ReleaseDC(None, screen_dc);

        if copied == 0 {
            return Err("could not read the window bitmap".into());
        }

        // GDI hands back BGRA with an unreliable alpha channel; PNG wants RGBA
        // and the window is opaque, so swap the channels and force alpha.
        for px in buf.chunks_exact_mut(4) {
            px.swap(0, 2);
            px[3] = 255;
        }

        let file = std::fs::File::create(path).map_err(|e| format!("could not write {path}: {e}"))?;
        let mut encoder = png::Encoder::new(std::io::BufWriter::new(file), width as u32, height as u32);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().map_err(|e| e.to_string())?;
        writer.write_image_data(&buf).map_err(|e| e.to_string())?;
        writer.finish().map_err(|e| e.to_string())?;

        // The caller needs the origin as well as the size: PrintWindow works on
        // the raw window rect, which includes the invisible resize border that
        // the DWM extended bounds trims, so image coordinates are relative to
        // this rectangle rather than to the one list_windows reports.
        Ok(Rect { x: raw.left, y: raw.top, width, height })
    }
}

/// Scroll a window by sending it wheel notches, as a user's wheel would.
///
/// Wheel messages go to the window under the cursor in normal use; posting
/// directly to the target avoids moving the pointer, which would be input
/// control rather than a view change.
pub fn scroll(hwnd: HWND, notches: i32) -> Result<(), String> {
    let rect = rect_of(hwnd).ok_or("could not measure that window")?;
    // lParam carries screen coordinates of the pointer for the message.
    let x = rect.x + rect.width / 2;
    let y = rect.y + rect.height / 2;
    let lparam = LPARAM(((y as isize) << 16) | (x as isize & 0xffff));
    let delta = notches * 120; // WHEEL_DELTA
    let wparam = WPARAM(((delta as isize) << 16) as usize);

    unsafe {
        SendMessageW(hwnd, WM_MOUSEWHEEL, Some(wparam), Some(lparam));
    }
    Ok(())
}
