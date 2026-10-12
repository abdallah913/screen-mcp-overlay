//! Top-level window enumeration and per-window facts.
//!
//! Besides geometry, each window carries the conditions that make it
//! unreachable even though it exists: minimised, on another virtual desktop,
//! running elevated, or not responding. Without them every one of those reads
//! as "that app is not open" or "it has no accessibility provider", and an
//! agent plans around the wrong cause.

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};

use windows::core::{BOOL, HRESULT, PWSTR};
use windows::Win32::Foundation::{CloseHandle, ERROR_ACCESS_DENIED, FILETIME, HANDLE, HWND, LPARAM, RECT, TRUE};
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS};
use windows::Win32::Security::{
    GetSidSubAuthority, GetSidSubAuthorityCount, GetTokenInformation, TokenIntegrityLevel, TOKEN_MANDATORY_LABEL,
    TOKEN_QUERY,
};
use windows::Win32::System::Threading::{
    GetCurrentProcess, GetProcessTimes, OpenProcess, OpenProcessToken, QueryFullProcessImageNameW,
    PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetAncestor, GetDesktopWindow, GetForegroundWindow, GetGUIThreadInfo, GetShellWindow, GetWindow,
    GetWindowLongW, GetWindowRect, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId, IsHungAppWindow,
    IsIconic, IsWindowVisible, GA_ROOT, GA_ROOTOWNER, GUITHREADINFO, GWL_EXSTYLE, GWL_STYLE, GW_OWNER, WS_CAPTION,
    WS_EX_TOOLWINDOW, WS_POPUP,
};

use crate::model::{Rect, StackWindow, WindowInfo};

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

pub fn pid_of(hwnd: HWND) -> u32 {
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
    pid
}

/// A window handle as the wire carries it.
pub fn ref_of(hwnd: HWND) -> String {
    format!("{}", hwnd.0 as isize)
}

/// The window's direct owner, if it has one.
pub fn owner_of(hwnd: HWND) -> Option<HWND> {
    unsafe { GetWindow(hwnd, GW_OWNER) }.ok().filter(|o| !o.is_invalid())
}

/// Classes of the shell's own surfaces: the desktop and its icon host, and
/// the taskbars. They are never anyone's window to share, whatever process
/// or owner they have; File Explorer shares explorer.exe with all of them.
const SHELL_CLASSES: &[&str] = &["Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd"];

pub fn is_shell(hwnd: HWND) -> bool {
    let desktop = unsafe { hwnd == GetDesktopWindow() || hwnd == GetShellWindow() };
    desktop || SHELL_CLASSES.contains(&class_of(hwnd).as_str())
}

/// The class of a Win32 menu window.
pub const MENU_CLASS: &str = "#32768";

/// True when two rects share some area (touching edges do not count).
pub fn overlaps(a: &Rect, b: &Rect) -> bool {
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}

/// The top-level window an unowned menu or popup is part of, when that can
/// be told: a Win32 menu (#32768) or a captionless untitled popup has no
/// owner, so its owner chain cannot say which window opened it.
///
/// A menu belongs to the window running the menu loop on its thread
/// (hwndMenuOwner). Failing that, a popup is taken as its thread's active
/// window's only when it is drawn over that window: one UI thread can serve
/// several windows (every Chrome window, every Explorer window), and the
/// active one is merely the one last used, which may not be what opened it.
pub fn served(hwnd: HWND) -> Option<HWND> {
    if owner_of(hwnd).is_some() {
        return None;
    }
    let menu = class_of(hwnd) == MENU_CLASS;
    if !menu {
        let style = unsafe { GetWindowLongW(hwnd, GWL_STYLE) } as u32;
        let popup = style & WS_POPUP.0 != 0 && style & WS_CAPTION.0 != WS_CAPTION.0;
        if !popup || !title_of(hwnd).trim().is_empty() {
            return None;
        }
    }
    let thread = unsafe { GetWindowThreadProcessId(hwnd, None) };
    if thread == 0 {
        return None;
    }
    let mut info = GUITHREADINFO { cbSize: std::mem::size_of::<GUITHREADINFO>() as u32, ..Default::default() };
    unsafe { GetGUIThreadInfo(thread, &mut info) }.ok()?;
    let root = |h: HWND| -> Option<HWND> {
        if h.is_invalid() {
            return None;
        }
        let r = unsafe { GetAncestor(h, GA_ROOT) };
        let r = if r.is_invalid() { h } else { r };
        (r != hwnd).then_some(r)
    };
    if menu {
        if let Some(owner) = root(info.hwndMenuOwner) {
            return Some(owner);
        }
    }
    let active = root(info.hwndActive)?;
    overlaps(&rect_of(hwnd)?, &rect_of(active)?).then_some(active)
}

/// The window this one belongs to: the end of its owner chain when it has
/// owners, else the window it serves as a menu or popup (see served).
pub fn root_owner_of(hwnd: HWND) -> Option<HWND> {
    let ro = unsafe { GetAncestor(hwnd, GA_ROOTOWNER) };
    if !ro.is_invalid() && ro != hwnd {
        return Some(ro);
    }
    served(hwnd)
}

// -------------------------------------------------------------- identity

/// The lowercased file name at the end of an image path, "chrome.exe" from
/// "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe".
fn file_name(path: &str) -> Option<String> {
    let name = path.rsplit(['\\', '/']).next()?.trim();
    (!name.is_empty()).then(|| name.to_lowercase())
}

/// The process's creation time: what tells a reused pid from the process
/// that had it before.
fn created(process: HANDLE) -> Option<u64> {
    let (mut born, mut exit, mut kernel, mut user) =
        (FILETIME::default(), FILETIME::default(), FILETIME::default(), FILETIME::default());
    unsafe { GetProcessTimes(process, &mut born, &mut exit, &mut kernel, &mut user) }.ok()?;
    Some((u64::from(born.dwHighDateTime) << 32) | u64::from(born.dwLowDateTime))
}

fn image_name(process: HANDLE) -> Option<String> {
    let mut buf = [0u16; 1024];
    let mut len = buf.len() as u32;
    unsafe { QueryFullProcessImageNameW(process, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len) }.ok()?;
    file_name(&String::from_utf16_lossy(&buf[..(len as usize).min(buf.len())]))
}

/// Cached executable names kept at most; the cache is simply emptied past it.
const EXE_CACHE_LIMIT: usize = 1024;

thread_local! {
    /// Per pid, with the process's creation time, so a pid Windows hands to a
    /// new process is never taken for the old one's executable: whole-app
    /// sharing goes by this name.
    static EXES: RefCell<HashMap<u32, (u64, Option<String>)>> = RefCell::new(HashMap::new());
}

/// The process's executable, lowercased file name; None when Windows will
/// not open the process to say (a protected one) or it has exited.
pub fn exe_of(pid: u32) -> Option<String> {
    if pid == 0 {
        return None;
    }
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }.ok()?;
    let born = created(process);
    let known = born.and_then(|b| EXES.with(|c| c.borrow().get(&pid).filter(|(t, _)| *t == b).map(|(_, e)| e.clone())));
    let exe = match known {
        Some(e) => e,
        None => {
            let e = image_name(process);
            if let Some(b) = born {
                EXES.with(|c| {
                    let mut c = c.borrow_mut();
                    if c.len() >= EXE_CACHE_LIMIT {
                        c.clear();
                    }
                    c.insert(pid, (b, e.clone()));
                });
            }
            e
        }
    };
    let _ = unsafe { CloseHandle(process) };
    exe
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

thread_local! {
    /// Executable names already read during the current enumeration, by pid:
    /// a browser has dozens of windows and one process.
    static SEEN_EXES: RefCell<HashMap<u32, Option<String>>> = RefCell::new(HashMap::new());
}

fn exe_once(pid: u32) -> Option<String> {
    if let Some(known) = SEEN_EXES.with(|s| s.borrow().get(&pid).cloned()) {
        return known;
    }
    let exe = exe_of(pid);
    SEEN_EXES.with(|s| s.borrow_mut().insert(pid, exe.clone()));
    exe
}

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
        owner: owner_of(hwnd).map(ref_of),
        root_owner: root_owner_of(hwnd).map(ref_of),
        exe: exe_once(pid),
    });
    TRUE
}

/// Every titled, sizeable top-level window, shared or not. The client needs
/// them all to decide (what opened, what covers what, what the user may
/// share) and filters what reaches the agent itself.
pub fn list_windows() -> Vec<WindowInfo> {
    SEEN_EXES.with(|s| s.borrow_mut().clear());
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

unsafe extern "system" fn stack_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let out = &mut *(lparam.0 as *mut Vec<StackWindow>);
    if !IsWindowVisible(hwnd).as_bool() || IsIconic(hwnd).as_bool() || is_cloaked(hwnd) {
        return TRUE;
    }
    let Some(rect) = rect_of(hwnd) else { return TRUE };
    if rect.width <= 0 || rect.height <= 0 {
        return TRUE;
    }
    let pid = pid_of(hwnd);
    out.push(StackWindow {
        r#ref: ref_of(hwnd),
        pid,
        rect,
        owner: owner_of(hwnd).map(ref_of),
        root_owner: root_owner_of(hwnd).map(ref_of),
        exe: exe_once(pid),
    });
    TRUE
}

/// Every visible top-level window on this desktop, front first (EnumWindows
/// walks the z-order from the top), with no filter on title, style or size:
/// tooltips, toasts, menus and the taskbar draw over shared windows as much
/// as any app does, so masking a capture needs them all.
pub fn zorder() -> Vec<StackWindow> {
    SEEN_EXES.with(|s| s.borrow_mut().clear());
    let mut out: Vec<StackWindow> = Vec::new();
    let _ = unsafe { EnumWindows(Some(stack_proc), LPARAM(&mut out as *mut Vec<StackWindow> as isize)) };
    out
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

    #[test]
    fn an_exe_is_the_lowercased_file_name() {
        assert_eq!(
            file_name(r"C:\Program Files\Google\Chrome\Application\Chrome.EXE").as_deref(),
            Some("chrome.exe")
        );
        assert_eq!(file_name(r"\\?\C:\Windows\notepad.exe").as_deref(), Some("notepad.exe"));
        assert_eq!(file_name("excel.exe").as_deref(), Some("excel.exe"));
        assert_eq!(file_name(r"C:\odd\"), None);
        assert_eq!(file_name(""), None);
    }

    #[test]
    fn only_shared_area_is_overlap() {
        let r = |x, y, width, height| Rect { x, y, width, height };
        let window = r(100, 100, 400, 300);
        assert!(overlaps(&r(300, 200, 50, 50), &window));
        assert!(overlaps(&r(450, 350, 200, 200), &window));
        // A popup that only abuts the window is not drawn over it.
        assert!(!overlaps(&r(500, 100, 100, 100), &window));
        assert!(!overlaps(&r(100, 400, 400, 40), &window));
        assert!(!overlaps(&r(0, 0, 0, 0), &window));
    }
}
