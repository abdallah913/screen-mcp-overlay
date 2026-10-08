//! Top-level window enumeration and per-window facts.
//!
//! Besides geometry, each window carries the conditions that make it
//! unreachable even though it exists: minimised, on another virtual desktop,
//! running elevated, or not responding. Without them every one of those reads
//! as "that app is not open" or "it has no accessibility provider", and an
//! agent plans around the wrong cause.

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};

use windows::core::{BOOL, HRESULT};
use windows::Win32::Foundation::{CloseHandle, ERROR_ACCESS_DENIED, HANDLE, HWND, LPARAM, RECT, TRUE};
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS};
use windows::Win32::Security::{
    GetSidSubAuthority, GetSidSubAuthorityCount, GetTokenInformation, TokenIntegrityLevel, TOKEN_MANDATORY_LABEL,
    TOKEN_QUERY,
};
use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetForegroundWindow, GetWindowLongW, GetWindowRect, GetWindowTextLengthW, GetWindowTextW,
    GetWindowThreadProcessId, IsHungAppWindow, IsIconic, IsWindowVisible, GWL_EXSTYLE, WS_EX_TOOLWINDOW,
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
    // Windows on another virtual desktop, and suspended UWP frames, stay
    // "visible" while cloaked. The user cannot see them, so they are listed
    // flagged rather than offered as if they were on screen.
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

/// Not responding: Windows has had no reply from the window's thread for 5 s.
/// Sending such a window a message, or asking it to paint, blocks the caller,
/// and this helper serves every other request on the same thread.
pub fn is_hung(hwnd: HWND) -> bool {
    unsafe { IsHungAppWindow(hwnd) }.as_bool()
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

// ------------------------------------------------------------- elevation

/// What a token query said about a process's integrity level.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Integrity {
    /// Windows refused to let us look, which happens for processes above us
    /// (elevated) and for protected ones.
    Denied,
    /// The mandatory label's RID: 0x2000 medium, 0x3000 high, 0x4000 system.
    Level(u32),
    /// The process went away, or the query failed for some other reason.
    Unknown,
}

const MEDIUM_INTEGRITY: u32 = 0x2000;

/// UIPI blocks UI Automation and window messages from a lower integrity level
/// to a higher one. A refused query counts as higher: the cause is elevation or
/// protection, and both block us the same way.
fn outranks(target: Integrity, own: u32) -> bool {
    match target {
        Integrity::Denied => true,
        Integrity::Level(level) => level > own,
        Integrity::Unknown => false,
    }
}

fn refusal(e: &windows::core::Error) -> Integrity {
    if e.code() == HRESULT::from_win32(ERROR_ACCESS_DENIED.0) {
        Integrity::Denied
    } else {
        Integrity::Unknown
    }
}

fn token_integrity(process: HANDLE) -> Integrity {
    unsafe {
        let mut token = HANDLE::default();
        if let Err(e) = OpenProcessToken(process, TOKEN_QUERY, &mut token) {
            return refusal(&e);
        }
        let mut len = 0u32;
        // The first call only reports the size the label needs.
        let _ = GetTokenInformation(token, TokenIntegrityLevel, None, 0, &mut len);
        // u64 storage keeps the label's embedded SID pointer aligned.
        let mut buf = vec![0u64; (len as usize).div_ceil(8).max(1)];
        let read = GetTokenInformation(token, TokenIntegrityLevel, Some(buf.as_mut_ptr() as *mut _), len, &mut len);
        let _ = CloseHandle(token);
        if read.is_err() || (len as usize) < std::mem::size_of::<TOKEN_MANDATORY_LABEL>() {
            return Integrity::Unknown;
        }
        let label = &*(buf.as_ptr() as *const TOKEN_MANDATORY_LABEL);
        let sid = label.Label.Sid;
        if sid.is_invalid() {
            return Integrity::Unknown;
        }
        let count = GetSidSubAuthorityCount(sid);
        if count.is_null() || *count == 0 {
            return Integrity::Unknown;
        }
        let rid = GetSidSubAuthority(sid, *count as u32 - 1);
        if rid.is_null() {
            return Integrity::Unknown;
        }
        Integrity::Level(*rid)
    }
}

fn integrity_of_pid(pid: u32) -> Integrity {
    unsafe {
        match OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
            Ok(process) => {
                let level = token_integrity(process);
                let _ = CloseHandle(process);
                level
            }
            Err(e) => refusal(&e),
        }
    }
}

thread_local! {
    /// The helper's own level, asked once. Medium when the query fails, since
    /// that is what an ordinary desktop app runs at.
    static OWN_LEVEL: u32 = match token_integrity(unsafe { GetCurrentProcess() }) {
        Integrity::Level(level) => level,
        _ => MEDIUM_INTEGRITY,
    };
    /// Per pid: list_windows runs several times a minute and a process's level
    /// does not change while it runs. Pruned to the pids of the latest listing,
    /// so a pid that Windows reuses is not misjudged for long.
    static ELEVATED: RefCell<HashMap<u32, bool>> = RefCell::new(HashMap::new());
}

/// Whether `pid` runs above the helper's integrity level, or is protected, so
/// that Windows blocks UI Automation and window messages to its windows.
pub fn is_elevated(pid: u32) -> bool {
    if pid == 0 || pid == std::process::id() {
        return false;
    }
    if let Some(known) = ELEVATED.with(|c| c.borrow().get(&pid).copied()) {
        return known;
    }
    let own = OWN_LEVEL.with(|l| *l);
    let elevated = outranks(integrity_of_pid(pid), own);
    ELEVATED.with(|c| c.borrow_mut().insert(pid, elevated));
    elevated
}

// ----------------------------------------------------------- enumeration

static mut COLLECTED: Vec<WindowInfo> = Vec::new();

unsafe extern "system" fn enum_proc(hwnd: HWND, _: LPARAM) -> BOOL {
    if !IsWindowVisible(hwnd).as_bool() {
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
        cloaked: is_cloaked(hwnd),
        elevated: is_elevated(pid),
        hung: is_hung(hwnd),
    });
    TRUE
}

pub fn list_windows() -> Vec<WindowInfo> {
    let listed = unsafe {
        #[allow(static_mut_refs)]
        {
            COLLECTED.clear();
        }
        let _ = EnumWindows(Some(enum_proc), LPARAM(0));
        #[allow(static_mut_refs)]
        std::mem::take(&mut COLLECTED)
    };
    let live: HashSet<u32> = listed.iter().map(|w| w.pid).collect();
    ELEVATED.with(|c| c.borrow_mut().retain(|pid, _| live.contains(pid)));
    listed
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_refused_query_counts_as_elevated() {
        assert!(outranks(Integrity::Denied, MEDIUM_INTEGRITY));
        // Even an elevated helper cannot open a protected process.
        assert!(outranks(Integrity::Denied, 0x3000));
    }

    #[test]
    fn only_a_higher_level_blocks() {
        assert!(outranks(Integrity::Level(0x3000), MEDIUM_INTEGRITY));
        assert!(!outranks(Integrity::Level(MEDIUM_INTEGRITY), MEDIUM_INTEGRITY));
        assert!(!outranks(Integrity::Level(0x1000), MEDIUM_INTEGRITY));
        // An elevated helper reaches elevated apps: UIPI is about the gap.
        assert!(!outranks(Integrity::Level(0x3000), 0x3000));
        assert!(outranks(Integrity::Level(0x4000), 0x3000));
    }

    #[test]
    fn an_unknown_process_is_not_called_elevated() {
        assert!(!outranks(Integrity::Unknown, MEDIUM_INTEGRITY));
    }
}
