//! Pure decisions behind searching: which name match is best, which names are
//! near misses, which state words a control shows, and which windows count as
//! an app's popups.
//!
//! Kept free of COM so every rule here is unit tested; search.rs only reads
//! properties and feeds them in.

use crate::model::Rect;

/// Fold a control name into the form people type it in.
///
/// Labels carry decoration that never appears in an instruction: Win32 menus
/// write "&Save\tCtrl+S" (mnemonic marker, then the accelerator after a tab),
/// and commands that open a dialog end in "…" or "...". "Save" should equal all
/// of those, or the exact match loses to "Save as" and "Autosave".
pub fn normalise(name: &str) -> String {
    let label = name.split('\t').next().unwrap_or("");
    let mut out = String::with_capacity(label.len());
    let mut chars = label.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '&' {
            // "&&" is a literal ampersand; a single one marks the mnemonic.
            if chars.peek() == Some(&'&') {
                chars.next();
                out.push('&');
            }
            continue;
        }
        out.push(c);
    }
    let mut t = out.trim_end();
    loop {
        if let Some(s) = t.strip_suffix('…') {
            t = s.trim_end();
        } else if let Some(s) = t.strip_suffix("...") {
            t = s.trim_end();
        } else {
            break;
        }
    }
    t.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase()
}

/// How well a name matches what was asked for, best first; None is no match.
///
/// 1 equal after normalising, 2 starts with it, 3 contains it at a word start,
/// 4 contains it anywhere. Tier 0 is reserved for an exact AutomationId.
pub fn name_tier(name: &str, needle: &str) -> Option<u8> {
    let n = normalise(name);
    let q = normalise(needle);
    if q.is_empty() {
        // The needle was all decoration ("..."): fall back to the raw text.
        return name.to_lowercase().contains(&needle.to_lowercase()).then_some(4);
    }
    if n == q {
        return Some(1);
    }
    if n.starts_with(&q) {
        return Some(2);
    }
    let at_word_start = n.match_indices(q.as_str()).any(|(i, _)| {
        n[..i].chars().next_back().is_none_or(|c| !c.is_alphanumeric())
    });
    if at_word_start {
        return Some(3);
    }
    if n.contains(&q) || name.to_lowercase().contains(&needle.to_lowercase()) {
        return Some(4);
    }
    None
}

/// Everything ranking looks at for one match.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rank {
    pub tier: u8,
    /// Found in an open popup of the window: what the user is looking at.
    pub popup: bool,
    pub enabled: bool,
    /// UI Automation says it is scrolled or collapsed out of view.
    pub offscreen: bool,
    /// Its rect is not within its top-level window.
    pub outside: bool,
    pub area: i64,
    /// Position in tree order, so equal matches keep the order the app has.
    pub order: usize,
}

/// Sort key: the best match sorts first.
///
/// Name quality comes first because the agent's words are the strongest
/// evidence. Among equally good names, the open popup wins (the user just
/// opened that menu), then a control the user can actually click: enabled,
/// on screen, inside its window, and the smallest, since a container whose
/// name repeats its child's label is never the thing to click.
pub fn rank_key(r: &Rank) -> (u8, bool, bool, bool, bool, i64, usize) {
    (r.tier, !r.popup, !r.enabled, r.offscreen, r.outside, r.area, r.order)
}

/// True when a control's rect lies outside its top-level window.
///
/// Judged by the centre with a little slack: a row half scrolled past the edge
/// is still clickable, and a title-bar button that pokes a pixel past the DWM
/// frame is not hidden. A rect whose centre is outside the window is drawn over
/// something else, which is the case this exists to catch.
pub fn outside(rect: &Rect, window: &Rect) -> bool {
    const SLACK: i32 = 2;
    let cx = rect.x + rect.width / 2;
    let cy = rect.y + rect.height / 2;
    cx < window.x - SLACK
        || cy < window.y - SLACK
        || cx > window.x + window.width + SLACK
        || cy > window.y + window.height + SLACK
}

fn edit_distance(a: &[char], b: &[char]) -> usize {
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    let mut cur = vec![0; b.len() + 1];
    for (i, ca) in a.iter().enumerate() {
        cur[0] = i + 1;
        for (j, cb) in b.iter().enumerate() {
            let cost = usize::from(ca != cb);
            cur[j + 1] = (prev[j] + cost).min(prev[j + 1] + 1).min(cur[j] + 1);
        }
        std::mem::swap(&mut prev, &mut cur);
    }
    prev[b.len()]
}

/// 0..1, where 1 is identical. Edit distance relative to the longer string.
fn char_similarity(a: &str, b: &str) -> f32 {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    let longest = a.len().max(b.len());
    if longest == 0 {
        return 1.0;
    }
    1.0 - edit_distance(&a, &b) as f32 / longest as f32
}

fn tokens(s: &str) -> Vec<&str> {
    s.split(|c: char| !c.is_alphanumeric()).filter(|t| !t.is_empty()).collect()
}

/// 0..1 word overlap, tolerant of truncations ("Pref" for "Preferences")
/// and small misspellings in a word, and indifferent to word order.
fn token_similarity(a: &str, b: &str) -> f32 {
    let ta = tokens(a);
    let tb = tokens(b);
    if ta.is_empty() || tb.is_empty() {
        return 0.0;
    }
    let total: f32 = ta
        .iter()
        .map(|x| {
            tb.iter()
                .map(|y| {
                    if x == y {
                        1.0
                    } else if x.len().min(y.len()) >= 3 && (x.starts_with(y) || y.starts_with(x)) {
                        0.8
                    } else {
                        let s = char_similarity(x, y);
                        if s >= 0.7 { s } else { 0.0 }
                    }
                })
                .fold(0.0, f32::max)
        })
        .sum();
    total / ta.len().max(tb.len()) as f32
}

/// How close a control's name is to a name that matched nothing, 0..1.
///
/// The better of two views: character edits catch typos and spelling variants
/// ("Colour" for "Color"), word overlap catches reordering and partial labels
/// ("PDF export" for "Export as PDF").
pub fn similarity(name: &str, needle: &str) -> f32 {
    let n = normalise(name);
    let q = normalise(needle);
    if n.is_empty() || q.is_empty() {
        return 0.0;
    }
    char_similarity(&n, &q).max(token_similarity(&n, &q))
}

/// Below this, a "closest" name is a guess that would only mislead.
pub const SUGGEST_THRESHOLD: f32 = 0.34;

/// Roles whose toggle state is worth reading. Most buttons do not toggle, but
/// the ones that do (Bold, a pinned state) are exactly what a step changes.
pub fn wants_toggle(role: &str) -> bool {
    matches!(role, "checkbox" | "radiobutton" | "button" | "menuitem")
}

pub fn wants_selection(role: &str) -> bool {
    matches!(role, "tabitem" | "listitem" | "treeitem" | "radiobutton" | "dataitem")
}

pub fn wants_expand(role: &str) -> bool {
    matches!(role, "combobox" | "menuitem" | "treeitem" | "splitbutton" | "button")
}

/// The state words a control shows, comma-joined, or None.
///
/// `toggle` is UIA's ToggleState (0 off, 1 on, 2 indeterminate) and `expand`
/// its ExpandCollapseState (0 collapsed, 1 expanded, 2 partly, 3 leaf). A
/// state is only reported for roles where it means something to a user, which
/// is also what keeps the reads cheap: the caller asks only for those.
pub fn state_words(role: &str, toggle: Option<i32>, selected: Option<bool>, expand: Option<i32>, focused: bool) -> Option<String> {
    let mut words: Vec<&str> = Vec::new();
    let selected_word = wants_selection(role) && selected == Some(true);
    if wants_toggle(role) && !(role == "radiobutton" && selected.is_some()) {
        // A radio button usually reports selection; when it does, its toggle
        // state would only say the same thing again.
        match toggle {
            Some(0) => words.push("unchecked"),
            Some(1) => words.push("checked"),
            Some(2) => words.push("mixed"),
            _ => {}
        }
    }
    if selected_word {
        words.push("selected");
    }
    if wants_expand(role) {
        match expand {
            Some(0) => words.push("collapsed"),
            Some(1) | Some(2) => words.push("expanded"),
            _ => {}
        }
    }
    if focused {
        words.push("focused");
    }
    (!words.is_empty()).then(|| words.join(","))
}

/// Whether a top-level window of the target's process looks like one of its
/// popups (a menu, dropdown list or flyout) rather than another app window.
///
/// Popups have no caption, and are owned, topmost, tool windows or untitled.
/// A second main window of the same process (two VS Code windows) has a title
/// and none of those, so it is never searched as part of the first. Dialogs
/// have captions, and UI Automation already lists owned dialogs under their
/// owner.
pub fn popup_like(caption: bool, tool: bool, topmost: bool, owned: bool, titled: bool) -> bool {
    !caption && (tool || topmost || owned || !titled)
}

/// Whether a window is itself a popup rather than an app window, given
/// whether it is popup-like (above) and a Win32 menu. Popup-like alone is not
/// enough here: an always-on-top frameless main window passes it. App windows
/// are what list_windows offers, titled and not tool windows, so a popup is
/// one that is neither, or a menu.
pub fn popup_window(like: bool, menu: bool, tool: bool, titled: bool) -> bool {
    like && (menu || tool || !titled)
}

/// True when two rects overlap or touch, so a popup on the window's display
/// counts and a stale one parked on another monitor does not.
pub fn touches(a: &Rect, b: &Rect) -> bool {
    a.x <= b.x + b.width && b.x <= a.x + a.width && a.y <= b.y + b.height && b.y <= a.y + a.height
}

fn overlap_area(a: &Rect, b: &Rect) -> i64 {
    let w = (a.x + a.width).min(b.x + b.width) - a.x.max(b.x);
    let h = (a.y + a.height).min(b.y + b.height) - a.y.max(b.y);
    if w <= 0 || h <= 0 {
        0
    } else {
        i64::from(w) * i64::from(h)
    }
}

/// What ties a popup-like window of the target's process to the target.
#[derive(Clone, Copy, Debug)]
pub struct PopupLink {
    /// A Win32 menu (#32768) created by the target's own thread. Menus have no
    /// owner, but only the thread whose window opened one can create it.
    pub menu_of_its_thread: bool,
    /// The target is its owner, directly or up the owner chain.
    pub owned: bool,
}

/// Whether a popup-like window really belongs to the target.
///
/// Popup-like is not enough on its own. File Explorer windows share
/// explorer.exe with the taskbar and the desktop, which are captionless,
/// untitled and topmost too, and were searched as an open menu of every
/// Explorer window. A real popup is the target's own menu, a window it owns,
/// or one drawn over it. Overlap is strict: a maximised window only abuts the
/// taskbar. Nothing that covers most of the display is a popup: that is the
/// desktop or a shell surface.
pub fn popup_of(link: PopupLink, rect: &Rect, target: Option<&Rect>, screen: Option<&Rect>) -> bool {
    if let Some(s) = screen {
        let area = i64::from(s.width) * i64::from(s.height);
        if area > 0 && overlap_area(rect, s) * 4 >= area * 3 {
            return false;
        }
    }
    link.menu_of_its_thread || link.owned || target.is_some_and(|t| overlap_area(rect, t) > 0)
}

/// Why a target has no rect, judged from its top-level window: "closed",
/// "minimized", "other-desktop" (cloaked), or "gone" when the window is fine
/// and the control itself went away.
pub fn gone_reason(exists: bool, minimized: bool, cloaked: bool) -> &'static str {
    if !exists {
        "closed"
    } else if minimized {
        "minimized"
    } else if cloaked {
        "other-desktop"
    } else {
        "gone"
    }
}

/// HRESULTs that mean the app cannot answer at all, rather than that one call
/// went wrong: UIA_E_TIMEOUT, RPC_E_DISCONNECTED, CO_E_OBJNOTCONNECTED, and
/// RPC_S_SERVER_UNAVAILABLE / RPC_S_CALL_FAILED as HRESULTs. After one of
/// these a live retry of the same call costs another full timeout and gets the
/// same answer, and so would every other call into that app.
pub fn unreachable(code: i32) -> bool {
    const CODES: [u32; 5] = [0x8013_1505, 0x8001_0108, 0x8004_01FD, 0x8007_06BA, 0x8007_06BE];
    CODES.contains(&(code as u32))
}

/// UIA_E_ELEMENTNOTAVAILABLE: this one element no longer exists (a row
/// removed, a popup closed). The app answered, quickly, so it says nothing
/// about the rest of its controls; but asking again about the same element
/// gets the same answer.
pub fn vanished(code: i32) -> bool {
    code as u32 == 0x8004_0201
}

/// Whether an ExpandCollapseState (see state_words) shows the children.
pub fn shows_children(expand: Option<i32>) -> bool {
    matches!(expand, Some(1) | Some(2))
}

/// Rows of a long run of list, tree or grid rows a describe keeps before it
/// skips the rest.
pub const RUN_KEEP: usize = 8;

pub fn collapses(role: &str) -> bool {
    matches!(role, "listitem" | "treeitem" | "dataitem")
}

/// Collapses long runs of same-role siblings while a describe walks them.
///
/// A file list of hundreds of rows used to spend the whole node budget, so the
/// File name box and the Save button after it were never reached. Past
/// RUN_KEEP rows of one run, siblings are skipped unwalked, except the ones
/// the walk wants (selected, expanded, focused or holding the focus), and the
/// count skipped is reported on the last row kept before them.
#[derive(Default)]
pub struct Run {
    role: Option<&'static str>,
    seen: usize,
    /// Index of the last row emitted for this run.
    row: Option<usize>,
    skipped: usize,
}

impl Run {
    /// Whether to skip the next sibling, which has `role`. `wanted` is asked
    /// only when the answer would otherwise be yes. A count to report, as
    /// (row index, skipped), comes back whenever a stretch of skipped
    /// siblings ends.
    pub fn skip(&mut self, role: &'static str, wanted: impl FnOnce() -> bool) -> (bool, Option<(usize, usize)>) {
        if !(collapses(role) && self.role == Some(role)) {
            let report = self.finish();
            *self = Run { role: collapses(role).then_some(role), seen: 1, row: None, skipped: 0 };
            return (false, report);
        }
        self.seen += 1;
        // With no row kept yet there is nowhere to say what was skipped.
        if self.seen > RUN_KEEP && self.row.is_some() && !wanted() {
            self.skipped += 1;
            return (true, None);
        }
        (false, self.finish())
    }

    /// The sibling just visited emitted the row at `index`.
    pub fn kept(&mut self, index: usize) {
        if self.role.is_some() {
            self.row = Some(index);
        }
    }

    /// The count still to report when the walk leaves these siblings.
    pub fn finish(&mut self) -> Option<(usize, usize)> {
        let report = self.row.filter(|_| self.skipped > 0).map(|r| (r, self.skipped));
        self.skipped = 0;
        report
    }
}

/// Which way one axis must scroll to bring an item into a viewport.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Nudge {
    Stay,
    Back,
    Forward,
}

fn nudge_axis(start: i32, len: i32, view_start: i32, view_len: i32) -> Nudge {
    let centre = start + len / 2;
    if centre < view_start {
        Nudge::Back
    } else if centre >= view_start + view_len {
        Nudge::Forward
    } else {
        Nudge::Stay
    }
}

/// Horizontal and vertical scroll directions that bring `item`'s centre into
/// `view`, the scrolling container's rect.
pub fn nudge(item: &Rect, view: &Rect) -> (Nudge, Nudge) {
    (nudge_axis(item.x, item.width, view.x, view.width), nudge_axis(item.y, item.height, view.y, view.height))
}

/// Whether a describe walk must stop before visiting another node.
///
/// Only emitted rows count against `row_limit`: unnamed wrappers are dropped
/// but their children walked, which is what lets a describe reach content that
/// Chromium, Electron and WinUI bury under a dozen of them. That needs its own
/// bound on the walk: ten visits per allowed row, and once the first
/// `max_nodes` visits (what a describe always cost) are spent, no more once
/// the time budget is `overtime`.
pub fn walk_spent(rows: usize, row_limit: usize, visits: usize, max_nodes: usize, overtime: bool) -> bool {
    const VISITS_PER_ROW: usize = 10;
    rows >= row_limit || visits >= max_nodes * VISITS_PER_ROW || (visits >= max_nodes && overtime)
}

/// How many rows of a describe go to open popups, at most. An open menu is
/// usually the most relevant thing on screen, so it must not be squeezed out by
/// a big window, nor may a big popup squeeze out the window.
pub fn popup_reserve(max_nodes: usize) -> usize {
    40.min(max_nodes / 2)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(x: i32, y: i32, width: i32, height: i32) -> Rect {
        Rect { x, y, width, height }
    }

    #[test]
    fn normalise_strips_mnemonics_accelerators_and_ellipses() {
        assert_eq!(normalise("&Save\tCtrl+S"), "save");
        assert_eq!(normalise("Save &As..."), "save as");
        assert_eq!(normalise("Export…"), "export");
        assert_eq!(normalise("Fish && Chips"), "fish & chips");
        assert_eq!(normalise("  Page   Setup  "), "page setup");
        assert_eq!(normalise("ÄNDERN"), "ändern");
    }

    #[test]
    fn tiers_prefer_exact_then_prefix_then_word_then_substring() {
        assert_eq!(name_tier("&Save\tCtrl+S", "save"), Some(1));
        assert_eq!(name_tier("Save as…", "Save"), Some(2));
        assert_eq!(name_tier("Quick save", "save"), Some(3));
        assert_eq!(name_tier("Autosave", "save"), Some(4));
        assert_eq!(name_tier("Open", "save"), None);
        // An ellipsis in the needle is decoration too.
        assert_eq!(name_tier("Save As", "Save As..."), Some(1));
        // A needle that is nothing but decoration still matches literally.
        assert_eq!(name_tier("Wait...", "..."), Some(4));
    }

    #[test]
    fn exact_beats_prefix_even_when_later_in_tree_order() {
        let base = Rank { tier: 0, popup: false, enabled: true, offscreen: false, outside: false, area: 100, order: 0 };
        let save_as = Rank { tier: name_tier("Save as…", "Save").unwrap(), order: 0, ..base };
        let autosave = Rank { tier: name_tier("Autosave", "Save").unwrap(), order: 1, ..base };
        let save = Rank { tier: name_tier("Save", "Save").unwrap(), order: 40, ..base };
        let mut all = [save_as, autosave, save];
        all.sort_by_key(rank_key);
        assert_eq!(all.map(|r| r.order), [40, 0, 1]);
    }

    #[test]
    fn ties_go_to_popup_then_enabled_then_on_screen_then_inside_then_smaller() {
        let base = Rank { tier: 1, popup: false, enabled: true, offscreen: false, outside: false, area: 100, order: 0 };
        let pairs = [
            (Rank { popup: true, order: 1, ..base }, Rank { order: 0, ..base }),
            (Rank { order: 1, ..base }, Rank { enabled: false, order: 0, ..base }),
            (Rank { order: 1, ..base }, Rank { offscreen: true, order: 0, ..base }),
            (Rank { order: 1, ..base }, Rank { outside: true, order: 0, ..base }),
            (Rank { area: 50, order: 1, ..base }, Rank { area: 5000, order: 0, ..base }),
        ];
        for (better, worse) in pairs {
            assert!(rank_key(&better) < rank_key(&worse), "{better:?} should beat {worse:?}");
        }
    }

    #[test]
    fn outside_judges_the_centre_with_slack() {
        let win = r(100, 100, 400, 300);
        assert!(!outside(&r(120, 120, 50, 20), &win));
        // Half scrolled past the bottom edge: centre still inside.
        assert!(!outside(&r(120, 390, 50, 20), &win));
        // Scrolled well below the window.
        assert!(outside(&r(120, 700, 50, 20), &win));
        // A pixel past the frame is not "outside".
        assert!(!outside(&r(99, 99, 2, 2), &win));
        assert!(outside(&r(-400, 120, 50, 20), &win));
    }

    #[test]
    fn similarity_catches_typos_partials_and_reordering() {
        assert!(similarity("Color", "Colour") > 0.8);
        assert!(similarity("Export As…", "Export as PDF") > 0.6);
        assert!(similarity("PDF export", "Export PDF") >= 0.99);
        assert!(similarity("Preferences", "Pref") >= 0.5);
        assert!(similarity("Brightness", "Save") < SUGGEST_THRESHOLD);
        assert!(similarity("Export As…", "Export as PDF") > similarity("Exit", "Export as PDF"));
        assert_eq!(similarity("", "Save"), 0.0);
    }

    #[test]
    fn state_words_follow_the_role() {
        assert_eq!(state_words("checkbox", Some(1), None, None, false).as_deref(), Some("checked"));
        assert_eq!(state_words("checkbox", Some(0), None, None, true).as_deref(), Some("unchecked,focused"));
        assert_eq!(state_words("checkbox", Some(2), None, None, false).as_deref(), Some("mixed"));
        assert_eq!(state_words("tabitem", None, Some(true), None, false).as_deref(), Some("selected"));
        assert_eq!(state_words("tabitem", None, Some(false), None, false), None);
        assert_eq!(state_words("combobox", None, None, Some(0), false).as_deref(), Some("collapsed"));
        assert_eq!(state_words("treeitem", None, Some(true), Some(1), false).as_deref(), Some("selected,expanded"));
        // A leaf has nothing to open.
        assert_eq!(state_words("treeitem", None, None, Some(3), false), None);
        // Roles where a state means nothing never show one.
        assert_eq!(state_words("edit", Some(1), Some(true), Some(1), false), None);
        assert_eq!(state_words("edit", None, None, None, true).as_deref(), Some("focused"));
        // A radio button that reports selection does not also say "checked".
        assert_eq!(state_words("radiobutton", Some(1), Some(true), None, false).as_deref(), Some("selected"));
        assert_eq!(state_words("radiobutton", Some(1), None, None, false).as_deref(), Some("checked"));
    }

    #[test]
    fn popups_are_captionless_and_owned_topmost_tool_or_untitled() {
        // Win32 #32768 menu: no caption, tool, topmost, untitled.
        assert!(popup_like(false, true, true, false, false));
        // WPF or XAML popup: untitled, nothing else.
        assert!(popup_like(false, false, false, false, false));
        // A second main window of the same process (frameless, titled).
        assert!(!popup_like(false, false, false, false, true));
        // An owned dialog has a caption.
        assert!(!popup_like(true, false, false, true, true));
    }

    #[test]
    fn only_a_real_popup_is_a_popup_target() {
        // Win32 #32768 menu, and a WPF or XAML popup (untitled).
        assert!(popup_window(true, true, true, false));
        assert!(popup_window(true, false, false, false));
        // A titled tool-window flyout.
        assert!(popup_window(true, false, true, true));
        // An always-on-top frameless main window: popup-like, but an app
        // window, whose own dropdown covers its controls.
        assert!(!popup_window(true, false, false, true));
        assert!(!popup_window(false, false, true, false));
    }

    #[test]
    fn touching_counts_as_near() {
        let screen = r(0, 0, 1920, 1080);
        assert!(touches(&r(100, 100, 200, 300), &screen));
        assert!(touches(&r(1920, 0, 200, 300), &screen));
        assert!(!touches(&r(1930, 0, 200, 300), &screen));
        assert!(!touches(&r(-3000, -3000, 20, 20), &screen));
    }

    #[test]
    fn a_popup_must_belong_to_the_target() {
        let screen = r(0, 0, 1920, 1080);
        let explorer = r(0, 0, 1920, 1032);
        let none = PopupLink { menu_of_its_thread: false, owned: false };
        // The taskbar of the same explorer.exe only abuts a maximised window.
        assert!(!popup_of(none, &r(0, 1032, 1920, 48), Some(&explorer), Some(&screen)));
        // A dropdown drawn over the window belongs to it.
        assert!(popup_of(none, &r(300, 200, 200, 300), Some(&explorer), Some(&screen)));
        // A submenu cascading past the window's edge is still its own menu.
        let small = r(100, 100, 400, 300);
        let menu = PopupLink { menu_of_its_thread: true, owned: false };
        assert!(popup_of(menu, &r(520, 120, 200, 300), Some(&small), Some(&screen)));
        assert!(!popup_of(none, &r(520, 120, 200, 300), Some(&small), Some(&screen)));
        let owned = PopupLink { menu_of_its_thread: false, owned: true };
        assert!(popup_of(owned, &r(520, 120, 200, 300), Some(&small), Some(&screen)));
        // The desktop's icon host covers the display, whatever links it has.
        assert!(!popup_of(menu, &screen, Some(&explorer), Some(&screen)));
        assert!(!popup_of(none, &r(0, 0, 1920, 1032), Some(&explorer), Some(&screen)));
    }

    #[test]
    fn a_missing_target_says_why() {
        assert_eq!(gone_reason(false, true, true), "closed");
        assert_eq!(gone_reason(true, true, true), "minimized");
        assert_eq!(gone_reason(true, false, true), "other-desktop");
        assert_eq!(gone_reason(true, false, false), "gone");
    }

    #[test]
    fn timeouts_and_dead_providers_are_not_retried() {
        assert!(unreachable(0x8013_1505u32 as i32));
        assert!(unreachable(0x8001_0108u32 as i32));
        assert!(unreachable(0x8004_01FDu32 as i32));
        assert!(unreachable(0x8007_06BAu32 as i32));
        assert!(unreachable(0x8007_06BEu32 as i32));
        // E_FAIL or "not cached" are worth a live read.
        assert!(!unreachable(0x8000_4005u32 as i32));
        assert!(!unreachable(0));
    }

    #[test]
    fn a_vanished_element_is_not_an_unreachable_app() {
        // One row removed or one popup closed must not end the whole walk,
        // nor silence every other control of that window.
        assert!(!unreachable(0x8004_0201u32 as i32));
        assert!(vanished(0x8004_0201u32 as i32));
        assert!(!vanished(0x8013_1505u32 as i32));
        assert!(!vanished(0));
    }

    #[test]
    fn expanded_and_partly_expanded_show_children() {
        assert!(shows_children(Some(1)));
        assert!(shows_children(Some(2)));
        assert!(!shows_children(Some(0)));
        // A leaf, and a control without the pattern.
        assert!(!shows_children(Some(3)));
        assert!(!shows_children(None));
    }

    /// Feeds a run of siblings through `Run`, emitting a row for each one
    /// visited, and returns the visited indices and the reported counts.
    fn walk_run(roles: &[&'static str], wanted: &[usize]) -> (Vec<usize>, Vec<(usize, usize)>) {
        let mut run = Run::default();
        let mut visited = Vec::new();
        let mut reports = Vec::new();
        for (i, role) in roles.iter().enumerate() {
            let (skip, report) = run.skip(role, || wanted.contains(&i));
            reports.extend(report);
            if !skip {
                visited.push(i);
                run.kept(i);
            }
        }
        reports.extend(run.finish());
        (visited, reports)
    }

    #[test]
    fn long_runs_keep_eight_rows_and_count_the_rest() {
        let mut roles = vec!["listitem"; 30];
        roles.push("edit");
        roles.push("button");
        let (visited, reports) = walk_run(&roles, &[]);
        assert_eq!(visited, [0, 1, 2, 3, 4, 5, 6, 7, 30, 31]);
        assert_eq!(reports, [(7, 22)]);
    }

    #[test]
    fn selected_rows_survive_the_collapse() {
        let roles = vec!["listitem"; 20];
        let (visited, reports) = walk_run(&roles, &[12]);
        assert_eq!(visited, [0, 1, 2, 3, 4, 5, 6, 7, 12]);
        assert_eq!(reports, [(7, 4), (12, 7)]);
    }

    #[test]
    fn short_runs_and_other_roles_are_untouched() {
        let roles = ["listitem", "listitem", "button", "button", "button", "button", "button", "button", "button",
            "button", "button", "button"];
        let (visited, reports) = walk_run(&roles, &[]);
        assert_eq!(visited.len(), roles.len());
        assert!(reports.is_empty());
        // A role change starts a new run.
        let mut mixed = vec!["treeitem"; 9];
        mixed.extend(vec!["listitem"; 9]);
        let (visited, reports) = walk_run(&mixed, &[]);
        assert_eq!(visited.len(), 16);
        assert_eq!(reports, [(7, 1), (16, 1)]);
    }

    #[test]
    fn nudges_point_toward_the_item() {
        let view = r(0, 100, 400, 300);
        assert_eq!(nudge(&r(10, 150, 100, 20), &view), (Nudge::Stay, Nudge::Stay));
        assert_eq!(nudge(&r(10, 900, 100, 20), &view), (Nudge::Stay, Nudge::Forward));
        assert_eq!(nudge(&r(10, 20, 100, 20), &view), (Nudge::Stay, Nudge::Back));
        assert_eq!(nudge(&r(600, 150, 100, 20), &view), (Nudge::Forward, Nudge::Stay));
        // Half past the bottom edge: the centre decides.
        assert_eq!(nudge(&r(10, 390, 100, 30), &view), (Nudge::Stay, Nudge::Forward));
    }

    #[test]
    fn walk_budget_counts_rows_and_bounds_visits() {
        // Plenty of visits left, rows still under the limit.
        assert!(!walk_spent(10, 120, 500, 120, false));
        assert!(walk_spent(120, 120, 130, 120, false));
        // Wrappers alone cannot keep a walk going forever.
        assert!(walk_spent(10, 120, 1200, 120, false));
        // Over time, but still inside the visits a describe always made.
        assert!(!walk_spent(10, 120, 100, 120, true));
        assert!(walk_spent(10, 120, 121, 120, true));
    }

    #[test]
    fn popup_reserve_never_takes_more_than_half() {
        assert_eq!(popup_reserve(120), 40);
        assert_eq!(popup_reserve(30), 15);
        assert_eq!(popup_reserve(1), 0);
    }
}
