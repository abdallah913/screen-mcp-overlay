//! An app's open popups: menus, dropdown lists and flyouts.
//!
//! These are often separate top-level windows, which UI Automation lists under
//! the desktop rather than under the app window, so a search rooted at the
//! window can never reach the menu item the user was just told to open. They
//! are found here by process instead, with plain Win32 calls (no COM), and
//! searched before the window itself.

use windows::core::{w, BOOL};
use windows::Win32::Foundation::{HWND, LPARAM, TRUE};
use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, FindWindowExW, GetWindow, GetWindowLongW, GetWindowThreadProcessId, IsWindowVisible, GWL_EXSTYLE,
    GWL_STYLE, GW_OWNER, WS_CAPTION, WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_EX_TRANSPARENT,
};

use crate::model::Rect;
use crate::windows::{class_of, is_cloaked, rect_of, title_of};

use super::rank::{popup_like, touches};

/// More than this many open popups is not a menu chain but stale windows.
const MAX_POPUPS: usize = 8;

/// Classes that are visible, captionless and same-process but never content:
/// tooltips, and the drop shadows Windows draws under menus.
const NEVER_POPUPS: &[&str] = &["tooltips_class32", "SysShadow"];

struct Search {
    target: HWND,
    pids: Vec<u32>,
    screen: Option<Rect>,
    found: Vec<(HWND, Rect)>,
}

pub fn pid_of(hwnd: HWND) -> u32 {
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
    pid
}

/// The monitor the window is on, as a rect.
fn screen_of(hwnd: HWND) -> Option<Rect> {
    let mut info = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
    let ok = unsafe { GetMonitorInfoW(MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST), &mut info) };
    if !ok.as_bool() {
        return None;
    }
    let m = info.rcMonitor;
    Some(Rect { x: m.left, y: m.top, width: m.right - m.left, height: m.bottom - m.top })
}

unsafe extern "system" fn visit(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let search = &mut *(lparam.0 as *mut Search);
    if search.found.len() >= MAX_POPUPS {
        return BOOL(0);
    }
    if hwnd == search.target || !IsWindowVisible(hwnd).as_bool() || !search.pids.contains(&pid_of(hwnd)) {
        return TRUE;
    }
    let style = GetWindowLongW(hwnd, GWL_STYLE) as u32;
    let ex = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32;
    // Click-through windows are decoration (shadows, our own overlay style).
    if ex & WS_EX_TRANSPARENT.0 != 0 || is_cloaked(hwnd) {
        return TRUE;
    }
    let owned = GetWindow(hwnd, GW_OWNER).is_ok_and(|o| !o.is_invalid());
    let like = popup_like(
        style & WS_CAPTION.0 == WS_CAPTION.0,
        ex & WS_EX_TOOLWINDOW.0 != 0,
        ex & WS_EX_TOPMOST.0 != 0,
        owned,
        !title_of(hwnd).trim().is_empty(),
    );
    if !like || NEVER_POPUPS.contains(&class_of(hwnd).as_str()) {
        return TRUE;
    }
    let Some(rect) = rect_of(hwnd) else { return TRUE };
    if rect.width <= 0 || rect.height <= 0 {
        return TRUE;
    }
    if let Some(screen) = &search.screen {
        if !touches(&rect, screen) {
            return TRUE;
        }
    }
    search.found.push((hwnd, rect));
    TRUE
}

/// The window's visible popups, topmost first (EnumWindows walks the z-order
/// from the top, and a submenu opens above its parent menu).
///
/// A UWP app's frame belongs to ApplicationFrameHost while its popups belong to
/// the app itself, so the hosted CoreWindow's process counts too.
pub fn popups_of(window: HWND) -> Vec<(HWND, Rect)> {
    let mut pids = vec![pid_of(window)];
    if let Ok(core) = unsafe { FindWindowExW(Some(window), None, w!("Windows.UI.Core.CoreWindow"), None) } {
        let hosted = pid_of(core);
        if hosted != 0 && !pids.contains(&hosted) {
            pids.push(hosted);
        }
    }
    if pids[0] == 0 {
        return Vec::new();
    }
    let mut search = Search { target: window, pids, screen: screen_of(window), found: Vec::new() };
    // EnumWindows reports an error when the callback stops it early, which is
    // how the cap works; whatever was collected is still the answer.
    let _ = unsafe { EnumWindows(Some(visit), LPARAM(&mut search as *mut Search as isize)) };
    search.found
}
