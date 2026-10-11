//! Which windows the user shared, enforced here as well as in the client.
//!
//! The Electron side decides what the agent may see and refuses everything
//! else before it ever asks. This is the backstop for whatever it misses: a
//! raw window handle the agent guessed, an element ref minted before a share
//! was withdrawn, a point that lands on some other app. Every op that reads or
//! acts on a window the caller names asks `allowed` first, and a window that
//! is not shared gets exactly the answer a window that does not exist gets,
//! so the refusal itself says nothing about what is open.
//!
//! The enumerations (list_windows, zorder) stay unfiltered: the client needs
//! every window to decide what covers what and what opened, and never passes
//! them on.

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};

use serde::Deserialize;
use windows::core::BOOL;
use windows::Win32::Foundation::{HWND, LPARAM, TRUE};
use windows::Win32::UI::WindowsAndMessaging::{EnumWindows, GetAncestor, IsWindow, IsWindowVisible, GA_ROOT, GA_ROOTOWNER};

use crate::windows::{exe_of, is_cloaked, is_hung, is_shell, owner_of, pid_of, served};

/// What a window that is not shared is called wherever one has to be
/// mentioned (as a cover): the same words for every such window.
pub const ANOTHER_WINDOW: &str = "another window";

/// Owner links followed, at most; real chains are one or two long.
const OWNER_HOPS: usize = 8;

/// Menu-serves-window links followed, at most: a submenu's window can be a
/// menu's only through the window both serve, so one hop is all a real one
/// needs, and a cycle of popups pointing at each other ends here.
const SERVE_HOPS: usize = 2;

/// What the user shared. Each window is held with the pid it had when it was
/// shared, so a handle Windows recycles for another process's window does not
/// inherit the share.
#[derive(Default)]
pub struct Grants {
    windows: HashMap<isize, u32>,
    /// Lowercased executable names whose every window is shared.
    apps: HashSet<String>,
}

impl Grants {
    fn granted(&self, h: isize, f: &Facts) -> bool {
        self.windows.get(&h) == Some(&f.pid) || f.exe.as_ref().is_some_and(|e| self.apps.contains(e))
    }
}

/// What the decision needs to know about one window. `None` from the facts
/// source means no such window.
pub struct Facts {
    pub pid: u32,
    /// Read only when some app is shared whole.
    pub exe: Option<String>,
    /// The desktop, its icon host or a taskbar (windows::is_shell).
    pub shell: bool,
    pub owner: Option<isize>,
    /// GA_ROOTOWNER, when it is not the window itself.
    pub root_owner: Option<isize>,
    /// The window an unowned menu or popup serves (windows::served).
    pub serves: Option<isize>,
}

/// Whether the top-level window `root` is shared: granted itself (same
/// handle and pid) or by its app, or owned by a window that is, or a menu or
/// popup serving one. The shell's own windows never are.
pub fn decide(root: isize, grants: &Grants, facts: &impl Fn(isize) -> Option<Facts>) -> bool {
    decide_within(root, grants, facts, SERVE_HOPS)
}

fn decide_within(root: isize, grants: &Grants, facts: &impl Fn(isize) -> Option<Facts>, hops: usize) -> bool {
    let Some(f) = facts(root) else { return false };
    if f.shell {
        return false;
    }
    if grants.granted(root, &f) {
        return true;
    }
    let shared = |h: isize| facts(h).is_some_and(|of| !of.shell && grants.granted(h, &of));
    let mut owner = f.owner;
    for _ in 0..OWNER_HOPS {
        let Some(o) = owner.filter(|&o| o != root) else { break };
        if shared(o) {
            return true;
        }
        owner = facts(o).and_then(|of| of.owner);
    }
    if f.root_owner.is_some_and(|ro| ro != root && shared(ro)) {
        return true;
    }
    match f.serves {
        Some(s) if hops > 0 && s != root => decide_within(s, grants, facts, hops - 1),
        _ => false,
    }
}

/// A shared window as set_shared takes it: the handle alone, as a string or
/// a number (its pid is read as it is stored), or with the pid the client saw
/// when the user shared it. Any shape is accepted so that a client sending
/// another one cannot fail the whole request and leave the old set in place.
#[derive(Deserialize)]
#[serde(untagged)]
pub enum ShareRef {
    Handle(String),
    Number(i64),
    WithPid {
        r#ref: String,
        pid: u32,
    },
}

thread_local! {
    /// Empty until the first set_shared: before the client says what is
    /// shared, nothing is.
    static SHARED: RefCell<Grants> = RefCell::new(Grants::default());
}

fn hwnd_of(raw: isize) -> HWND {
    HWND(raw as *mut std::ffi::c_void)
}

/// Replace what is shared. A window already shared keeps the pid recorded
/// for it then, so a handle that closed and was reused in between is still
/// told apart; a handle that names no window now is dropped.
pub fn set_shared(windows: &[ShareRef], apps: &[String]) {
    SHARED.with(|s| {
        let mut s = s.borrow_mut();
        let mut next: HashMap<isize, u32> = HashMap::new();
        for w in windows {
            let (raw, given) = match w {
                ShareRef::Handle(r) => (r.trim().parse::<isize>().ok(), None),
                ShareRef::Number(n) => (isize::try_from(*n).ok(), None),
                ShareRef::WithPid { r#ref, pid } => (r#ref.trim().parse::<isize>().ok(), Some(*pid)),
            };
            let Some(raw) = raw.filter(|&r| r != 0) else { continue };
            let pid = given.or_else(|| s.windows.get(&raw).copied()).unwrap_or_else(|| pid_of(hwnd_of(raw)));
            if pid != 0 {
                next.insert(raw, pid);
            }
        }
        s.windows = next;
        s.apps = apps.iter().map(|a| a.trim().to_lowercase()).filter(|a| !a.is_empty()).collect();
    });
}

fn live_facts(h: isize, with_exe: bool) -> Option<Facts> {
    let hwnd = hwnd_of(h);
    if h == 0 || !unsafe { IsWindow(Some(hwnd)) }.as_bool() {
        return None;
    }
    let pid = pid_of(hwnd);
    if pid == 0 {
        return None;
    }
    let ro = unsafe { GetAncestor(hwnd, GA_ROOTOWNER) };
    Some(Facts {
        pid,
        exe: if with_exe { exe_of(pid) } else { None },
        shell: is_shell(hwnd),
        owner: owner_of(hwnd).map(|o| o.0 as isize),
        root_owner: (!ro.is_invalid() && ro != hwnd).then_some(ro.0 as isize),
        serves: served(hwnd).map(|s| s.0 as isize),
    })
}

/// The top-level window a handle belongs to: a child control's handle counts
/// as its window's.
pub fn root_of(hwnd: HWND) -> HWND {
    let root = unsafe { GetAncestor(hwnd, GA_ROOT) };
    if root.is_invalid() {
        hwnd
    } else {
        root
    }
}

/// Whether the agent may reach this window (or the window this child handle
/// is in). False for any handle that names no window.
pub fn allowed(hwnd: HWND) -> bool {
    if hwnd.is_invalid() || !unsafe { IsWindow(Some(hwnd)) }.as_bool() {
        return false;
    }
    let root = root_of(hwnd).0 as isize;
    SHARED.with(|s| {
        let grants = s.borrow();
        if grants.windows.is_empty() && grants.apps.is_empty() {
            return false;
        }
        let with_exe = !grants.apps.is_empty();
        decide(root, &grants, &|h| live_facts(h, with_exe))
    })
}

unsafe extern "system" fn visit(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let out = &mut *(lparam.0 as *mut Vec<HWND>);
    if IsWindowVisible(hwnd).as_bool() && !is_cloaked(hwnd) && !is_hung(hwnd) && allowed(hwnd) {
        out.push(hwnd);
    }
    TRUE
}

/// The shared top-level windows on this desktop, front first: their dialogs
/// and open menus included, hung ones left out (each would make a search
/// wait out its timeout). What a search without a window looks through,
/// instead of the whole desktop.
pub fn shared_tops() -> Vec<HWND> {
    let mut out: Vec<HWND> = Vec::new();
    let _ = unsafe { EnumWindows(Some(visit), LPARAM(&mut out as *mut Vec<HWND> as isize)) };
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A small desktop: (handle, pid, exe, shell, owner, root_owner, serves).
    type Row = (isize, u32, &'static str, bool, Option<isize>, Option<isize>, Option<isize>);

    fn desk(rows: &'static [Row]) -> impl Fn(isize) -> Option<Facts> {
        move |h| {
            rows.iter().find(|r| r.0 == h).map(|&(_, pid, exe, shell, owner, root_owner, serves)| Facts {
                pid,
                exe: (!exe.is_empty()).then(|| exe.to_string()),
                shell,
                owner,
                root_owner,
                serves,
            })
        }
    }

    fn grants(windows: &[(isize, u32)], apps: &[&str]) -> Grants {
        Grants { windows: windows.iter().copied().collect(), apps: apps.iter().map(|a| a.to_string()).collect() }
    }

    // A shared Chrome window (10), an unshared one playing a video (20), both
    // pid 40; the shared one's dropdown (11, owned), its menu (12, serves 10),
    // the video's Picture-in-Picture window (21: same pid, overlapping, no
    // link), a menu of the video window (22), a file picker another process
    // opened for the shared window (13, owned by it), a dialog owned by that
    // picker (14), the taskbar (30) and Notepad (50).
    const DESK: &[Row] = &[
        (10, 40, "chrome.exe", false, None, None, None),
        (11, 40, "chrome.exe", false, Some(10), Some(10), None),
        (12, 40, "chrome.exe", false, None, None, Some(10)),
        (13, 77, "pickerhost.exe", false, Some(10), Some(10), None),
        (14, 77, "pickerhost.exe", false, Some(13), Some(10), None),
        (20, 40, "chrome.exe", false, None, None, None),
        (21, 40, "chrome.exe", false, None, None, None),
        (22, 40, "chrome.exe", false, None, None, Some(20)),
        (30, 9, "explorer.exe", true, None, None, None),
        (50, 60, "notepad.exe", false, None, None, None),
    ];

    #[test]
    fn nothing_is_shared_until_something_is() {
        let none = grants(&[], &[]);
        for (h, ..) in DESK {
            assert!(!decide(*h, &none, &desk(DESK)), "{h}");
        }
    }

    #[test]
    fn a_shared_window_brings_what_it_owns_and_its_menus_only() {
        let g = grants(&[(10, 40)], &[]);
        let f = desk(DESK);
        for h in [10, 11, 12, 13, 14] {
            assert!(decide(h, &g, &f), "{h} belongs to the shared window");
        }
        // Same process, even overlapping it, is not a link.
        for h in [20, 21, 22, 30, 50] {
            assert!(!decide(h, &g, &f), "{h} is not shared");
        }
    }

    #[test]
    fn a_recycled_handle_does_not_inherit_the_share() {
        // Shared while pid 41 had handle 10; pid 40 has it now.
        let g = grants(&[(10, 41)], &[]);
        assert!(!decide(10, &g, &desk(DESK)));
        assert!(!decide(11, &g, &desk(DESK)));
    }

    #[test]
    fn a_closed_window_is_not_shared() {
        let g = grants(&[(99, 40)], &[]);
        assert!(!decide(99, &g, &desk(DESK)));
    }

    #[test]
    fn a_shared_app_shares_its_windows_but_never_the_shell() {
        let g = grants(&[], &["notepad.exe", "explorer.exe"]);
        let f = desk(DESK);
        assert!(decide(50, &g, &f));
        // Explorer shared whole still never shares the taskbar or desktop.
        assert!(!decide(30, &g, &f));
        assert!(!decide(10, &g, &f));
    }

    #[test]
    fn the_shell_is_never_shared_even_by_handle() {
        let g = grants(&[(30, 9)], &[]);
        assert!(!decide(30, &g, &desk(DESK)));
    }

    #[test]
    fn a_menu_of_a_menu_is_followed_a_bounded_way() {
        // 61 serves 62 serves 61: a loop ends; 63 serves 64 serves 10 (shared).
        const LOOP: &[Row] = &[
            (10, 40, "", false, None, None, None),
            (61, 40, "", false, None, None, Some(62)),
            (62, 40, "", false, None, None, Some(61)),
            (63, 40, "", false, None, None, Some(64)),
            (64, 40, "", false, None, None, Some(10)),
        ];
        let g = grants(&[(10, 40)], &[]);
        assert!(!decide(61, &g, &desk(LOOP)));
        assert!(decide(63, &g, &desk(LOOP)));
    }

    #[test]
    fn an_owner_loop_ends() {
        const LOOP: &[Row] = &[(71, 1, "", false, Some(72), None, None), (72, 1, "", false, Some(71), None, None)];
        let g = grants(&[(10, 40)], &[]);
        assert!(!decide(71, &g, &desk(LOOP)));
    }

    #[test]
    fn share_refs_take_a_handle_or_a_handle_and_pid() {
        let refs: Vec<ShareRef> = serde_json::from_str(r#"["123", {"ref":"456","pid":7}, 789]"#).unwrap();
        assert!(matches!(&refs[0], ShareRef::Handle(h) if h == "123"));
        assert!(matches!(&refs[1], ShareRef::WithPid { r#ref, pid: 7 } if r#ref == "456"));
        assert!(matches!(&refs[2], ShareRef::Number(789)));
    }
}
