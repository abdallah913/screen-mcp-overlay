//! Top-level window enumeration and per-window facts.

use windows::core::BOOL;
use windows::Win32::Foundation::{HWND, LPARAM, RECT, TRUE};
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetForegroundWindow, GetWindowLongW, GetWindowRect, GetWindowTextLengthW, GetWindowTextW,
    GetWindowThreadProcessId, IsIconic, IsWindowVisible, GWL_EXSTYLE, WS_EX_TOOLWINDOW,
};

use crate::model::{Rect, WindowInfo};

pub fn rect_of(hwnd: HWND) -> Option<Rect> {
    // The DWM frame bounds exclude the invisible resize border that
    // GetWindowRect includes, so an annotation drawn on the edge of a window
    // lands on the edge the user actually sees.
    let mut r = RECT::default();
    let ok = unsafe {
        DwmGetWindowAttribute(
            hwnd,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            &mut r as *mut _ as *mut _,
            std::mem::size_of::<RECT>() as u32,
        )
    };
    if ok.is_err() {
        let mut fallback = RECT::default();
        if unsafe { GetWindowRect(hwnd, &mut fallback) }.is_err() {
            return None;
        }
        r = fallback;
    }
    Some(Rect {
        x: r.left,
        y: r.top,
        width: r.right - r.left,
        height: r.bottom - r.top,
    })
}

pub fn is_cloaked(hwnd: HWND) -> bool {
    // Virtual-desktop and UWP windows stay "visible" while cloaked; listing them
    // would offer the user windows they cannot see.
    let mut cloaked: u32 = 0;
    let ok = unsafe {
        DwmGetWindowAttribute(
            hwnd,
            DWMWA_CLOAKED,
            &mut cloaked as *mut _ as *mut _,
            std::mem::size_of::<u32>() as u32,
        )
    };
    ok.is_ok() && cloaked != 0
}

pub fn title_of(hwnd: HWND) -> String {
    let len = unsafe { GetWindowTextLengthW(hwnd) };
    if len <= 0 {
        return String::new();
    }
    let mut buf = vec![0u16; len as usize + 1];
    let n = unsafe { GetWindowTextW(hwnd, &mut buf) };
    String::from_utf16_lossy(&buf[..n as usize])
}

pub fn class_of(hwnd: HWND) -> String {
    use windows::Win32::UI::WindowsAndMessaging::GetClassNameW;
    let mut buf = [0u16; 256];
    let n = unsafe { GetClassNameW(hwnd, &mut buf) };
    String::from_utf16_lossy(&buf[..n as usize])
}

static mut COLLECTED: Vec<WindowInfo> = Vec::new();

unsafe extern "system" fn enum_proc(hwnd: HWND, _: LPARAM) -> BOOL {
    if !IsWindowVisible(hwnd).as_bool() || is_cloaked(hwnd) {
        return TRUE;
    }
    // Tool windows are palettes and tooltips, never something to point at.
    let ex = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32;
    if ex & WS_EX_TOOLWINDOW.0 != 0 {
        return TRUE;
    }
    let title = title_of(hwnd);
    if title.trim().is_empty() {
        return TRUE;
    }
    let Some(rect) = rect_of(hwnd) else { return TRUE };
    if rect.width < 80 || rect.height < 60 {
        return TRUE;
    }

    let mut pid = 0u32;
    GetWindowThreadProcessId(hwnd, Some(&mut pid));

    #[allow(static_mut_refs)]
    COLLECTED.push(WindowInfo {
        r#ref: format!("{}", hwnd.0 as isize),
        title,
        class: class_of(hwnd),
        pid,
        rect,
        foreground: hwnd == GetForegroundWindow(),
        minimized: IsIconic(hwnd).as_bool(),
        // TODO(stage 1, windows agent): list cloaked windows flagged instead of
        // skipping them above, and detect elevation and hangs.
        cloaked: false,
        elevated: false,
        hung: false,
    });
    TRUE
}

pub fn list_windows() -> Vec<WindowInfo> {
    unsafe {
        #[allow(static_mut_refs)]
        {
            COLLECTED.clear();
        }
        let _ = EnumWindows(Some(enum_proc), LPARAM(0));
        #[allow(static_mut_refs)]
        std::mem::take(&mut COLLECTED)
    }
}
