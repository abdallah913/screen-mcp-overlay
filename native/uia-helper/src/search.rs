//! UI Automation queries: searching, describing and re-resolving controls.

#[path = "search_popups.rs"]
pub mod popups;
#[path = "search_props.rs"]
mod props;
#[path = "search_rank.rs"]
mod rank;

use std::cell::Cell;
use std::collections::HashMap;
use std::time::{Duration, Instant};

use uiautomation::core::{UICacheRequest, UICondition};
use uiautomation::patterns::{UIScrollItemPattern, UIScrollPattern};
use uiautomation::types::{Handle, Point, ScrollAmount, TreeScope, UIProperty};
use uiautomation::variants::Variant;
use uiautomation::{UIAutomation, UIElement, UITreeWalker};
use windows::core::Interface;
use windows::Win32::Foundation::{HWND, POINT};
use windows::Win32::UI::Accessibility::{IUIAutomation, IUIAutomation2};
use windows::Win32::UI::WindowsAndMessaging::{GetAncestor, IsIconic, IsWindow, IsWindowVisible, WindowFromPoint, GA_ROOT};

use crate::model::{
    ContainerInfo, Described, DescribedNode, ElementInfo, PointHit, Rect, Resolved, ScrollIntoView, Scrolled,
    Suggestion, WindowRef,
};
use crate::windows::{is_cloaked, is_hung, rect_of, title_of};

use props::Focus;
use rank::{Nudge, Rank};

/// Every UIA control type, under the short name agents use for it.
///
/// This used to cover twenty types, and the gaps were silent in both
/// directions: a slider or menu came back as "other", and filtering by an
/// unlisted role quietly dropped the filter and matched every control.
const ROLES: &[(i32, &str)] = &[
    (50000, "button"),
    (50001, "calendar"),
    (50002, "checkbox"),
    (50003, "combobox"),
    (50004, "edit"),
    (50005, "link"),
    (50006, "image"),
    (50007, "listitem"),
    (50008, "list"),
    (50009, "menu"),
    (50010, "menubar"),
    (50011, "menuitem"),
    (50012, "progressbar"),
    (50013, "radiobutton"),
    (50014, "scrollbar"),
    (50015, "slider"),
    (50016, "spinner"),
    (50017, "statusbar"),
    (50018, "tab"),
    (50019, "tabitem"),
    (50020, "text"),
    (50021, "toolbar"),
    (50022, "tooltip"),
    (50023, "tree"),
    (50024, "treeitem"),
    (50025, "custom"),
    (50026, "group"),
    (50027, "thumb"),
    (50028, "datagrid"),
    (50029, "dataitem"),
    (50030, "document"),
    (50031, "splitbutton"),
    (50032, "window"),
    (50033, "pane"),
    (50034, "header"),
    (50035, "headeritem"),
    (50036, "table"),
    (50037, "titlebar"),
    (50038, "separator"),
    (50039, "semanticzoom"),
    (50040, "appbar"),
];

/// Other names agents reach for, mapped onto the canonical ones above.
const ROLE_ALIASES: &[(&str, &str)] = &[
    ("textbox", "edit"),
    ("input", "edit"),
    ("hyperlink", "link"),
    ("label", "text"),
    ("radio", "radiobutton"),
    ("dialog", "window"),
];

/// Resolve a role filter, or explain which roles exist.
///
/// Spaces, hyphens and underscores are ignored, so "list item" and
/// "menu_item" work as well as "listitem".
pub fn role_id(role: &str) -> Result<i32, String> {
    let wanted: String = role
        .chars()
        .filter(|c| !matches!(c, ' ' | '-' | '_'))
        .collect::<String>()
        .to_ascii_lowercase();
    let canonical = ROLE_ALIASES
        .iter()
        .find(|(alias, _)| *alias == wanted)
        .map_or(wanted.as_str(), |(_, name)| *name);
    ROLES
        .iter()
        .find(|(_, name)| *name == canonical)
        .map(|(id, _)| *id)
        .ok_or_else(|| {
            let known: Vec<&str> = ROLES.iter().map(|(_, name)| *name).collect();
            format!("unknown role '{role}'. Known roles: {}", known.join(", "))
        })
}

pub fn role_name(id: i32) -> &'static str {
    ROLES.iter().find(|(rid, _)| *rid == id).map_or("other", |(_, name)| *name)
}


/// How many element handles to keep alive at once.
///
/// Each cached UIElement is a COM reference that pins memory in the target
/// application's accessibility provider, not just here. The cache used to grow
/// forever: a describe adds up to a thousand, and a fifteen-minute
/// wait_for_element adds a few every poll. Anchors are touched on every tracker
/// tick, so least-recently-used eviction never drops one that is on screen.
const CACHE_LIMIT: usize = 5000;

/// Name matches whose rect and state are read for ranking, at most. A one- or
/// two-letter needle can match thousands of controls, and on the uncached path
/// each read is a call into the app; the best tiers are read first, so the cap
/// only ever drops the weakest matches.
const RANK_READS: usize = 300;

/// Matches without a usable rect returned by include_hidden, at most. Each one
/// costs a walk up its ancestors.
const HIDDEN_LIMIT: usize = 3;

/// Ancestors examined when looking for what to open to reveal a hidden match.
const PARENT_WALK: usize = 15;

/// Time a describe may spend past its first max_nodes visits (see
/// rank::walk_spent).
const EXTRA_WALK_TIME: Duration = Duration::from_millis(400);

/// Names of unvisited subtrees reported when a describe is cut short, and the
/// reads spent finding them.
const UNVISITED_NAMES: usize = 5;
const UNVISITED_READS: usize = 20;

/// UI Automation's per-call timeout in the ops the client gives least time:
/// a whole resolve batch gets 3 s and element_at_point 4 s, and an overrun
/// restarts the helper, losing every ref. A call into a window that has just
/// frozen must fail well inside that, rather than at the bound the helper
/// sets for everything else.
const HOT_CALL_TIMEOUT_MS: u32 = 1000;

/// Scroll steps scroll_into_view takes toward a control that cannot scroll
/// itself into view, at most.
const SCROLL_STEPS: usize = 15;

/// How long a wheel scroll gets to finish animating before its new position
/// is read, and how often the position is polled meanwhile.
const SCROLL_SETTLE: Duration = Duration::from_millis(400);
const SCROLL_POLL: Duration = Duration::from_millis(50);

/// A cached element, the tick it was last used, and the top-level window it
/// was found in (0 when unknown): its rect is judged against that window's.
pub struct Entry {
    el: UIElement,
    used: u64,
    top: isize,
}

pub struct Session {
    pub auto: UIAutomation,
    /// Live UIElement handles by ref. Keeping the objects beats re-resolving by
    /// RuntimeId: it is faster and survives relayout within the same run.
    pub cache: HashMap<String, Entry>,
    pub next: u64,
    pub clock: u64,
}

/// One place a search looks: the window itself, or one of its open popups.
struct Scope {
    root: UIElement,
    /// The top-level window, as a raw HWND; 0 for the whole desktop.
    top: isize,
    rect: Option<Rect>,
    popup: bool,
}

/// A control whose name or id matched, before anything else is read.
struct Candidate {
    el: UIElement,
    cached: bool,
    scope: usize,
    name: String,
    tier: u8,
    order: usize,
}

/// What was read about a control on the way to reporting it.
struct Seen {
    name: String,
    rect: Rect,
    enabled: bool,
    offscreen: bool,
}

/// A candidate with a usable rect and what ranking needs to know about it.
struct Matched {
    el: UIElement,
    cached: bool,
    scope: usize,
    seen: Seen,
    rank: Rank,
}

fn hwnd_of(raw: isize) -> HWND {
    HWND(raw as *mut std::ffi::c_void)
}

fn parse_window(w: &str) -> Result<isize, String> {
    w.parse().map_err(|_| format!("bad window ref '{w}'"))
}

/// A window ref to read controls from. A hung window answers UI Automation
/// only after the transaction timeout, every call, so it is refused up front
/// with the real reason instead of failing slowly with a misleading one.
fn readable_window(w: &str) -> Result<isize, String> {
    let raw = parse_window(w)?;
    if is_hung(hwnd_of(raw)) {
        return Err(format!(
            "window {w} is not responding, so its controls cannot be read until it recovers"
        ));
    }
    Ok(raw)
}

/// Holds UI Automation's per-call timeout at a tighter bound while it lives,
/// and puts the previous one back after. Never loosens it, and does nothing
/// without IUIAutomation2 (older systems keep the defaults, as in main).
struct CallBound {
    auto2: Option<IUIAutomation2>,
    was: u32,
}

impl CallBound {
    fn new(auto: &UIAutomation, ms: u32) -> CallBound {
        let auto2 = AsRef::<IUIAutomation>::as_ref(auto).cast::<IUIAutomation2>().ok();
        let was = auto2.as_ref().and_then(|a| unsafe { a.TransactionTimeout() }.ok());
        match (auto2, was) {
            (Some(a), Some(was)) if was > ms && unsafe { a.SetTransactionTimeout(ms) }.is_ok() => {
                CallBound { auto2: Some(a), was }
            }
            _ => CallBound { auto2: None, was: 0 },
        }
    }
}

impl Drop for CallBound {
    fn drop(&mut self) {
        if let Some(a) = &self.auto2 {
            let _ = unsafe { a.SetTransactionTimeout(self.was) };
        }
    }
}

/// Ok(None) when a navigation or search found nothing, Err with the HRESULT
/// when the call itself failed. UIA reports "no such element" as a null
/// result, which windows-rs turns into an error with an S_OK code.
fn found(r: uiautomation::Result<UIElement>) -> Result<Option<UIElement>, i32> {
    match r {
        Ok(el) => Ok(Some(el)),
        Err(e) if e.code() == 0 => Ok(None),
        Err(e) => Err(e.code()),
    }
}

/// Why a target's top-level window shows nothing of it (see
/// rank::gone_reason); "gone" when the window is unknown.
fn gone_reason(top: isize) -> &'static str {
    if top == 0 {
        return "gone";
    }
    let h = hwnd_of(top);
    rank::gone_reason(unsafe { IsWindow(Some(h)) }.as_bool(), unsafe { IsIconic(h) }.as_bool(), is_cloaked(h))
}

/// The element's ScrollPattern, when it scrolls vertically.
fn vertical_scroller(el: &UIElement) -> Option<UIScrollPattern> {
    let p: UIScrollPattern = el.get_pattern().ok()?;
    p.is_vertically_scrollable().unwrap_or(false).then_some(p)
}

/// Vertical scroll position 0..100, or None when it does not scroll (UIA
/// reports -1 then).
fn vertical_percent(p: &UIScrollPattern) -> Option<f64> {
    p.get_vertical_scroll_percent().ok().filter(|v| (0.0..=100.0).contains(v))
}

/// One scroll step along an axis: a page while far off, a line once a page
/// has overshot.
fn scroll_amount(n: Nudge, can: bool, fine: bool) -> ScrollAmount {
    match (n, can, fine) {
        (Nudge::Stay, _, _) | (_, false, _) => ScrollAmount::NoAmount,
        (Nudge::Back, true, false) => ScrollAmount::LargeDecrement,
        (Nudge::Back, true, true) => ScrollAmount::SmallDecrement,
        (Nudge::Forward, true, false) => ScrollAmount::LargeIncrement,
        (Nudge::Forward, true, true) => ScrollAmount::SmallIncrement,
    }
}

fn reversed(before: Nudge, now: Nudge) -> bool {
    matches!((before, now), (Nudge::Back, Nudge::Forward) | (Nudge::Forward, Nudge::Back))
}

/// The scroll position once a wheel scroll has finished. Apps that animate
/// one report the old position for a moment and then pass through values in
/// between, so it is polled until it has left `before` and holds still, or
/// the settle time is up.
fn settled_percent(p: &UIScrollPattern, before: f64) -> Option<f64> {
    let deadline = Instant::now() + SCROLL_SETTLE;
    let mut last = vertical_percent(p);
    while Instant::now() < deadline {
        std::thread::sleep(SCROLL_POLL);
        let now = vertical_percent(p);
        if now == last && now != Some(before) {
            break;
        }
        last = now;
    }
    last
}

/// The state of one describe walk.
struct Walk {
    walker: UITreeWalker,
    req: Option<UICacheRequest>,
    max_depth: usize,
    rows: Vec<DescribedNode>,
    row_limit: usize,
    /// Visits in the current pass, and the pass's budget (see
    /// rank::walk_spent).
    visits: usize,
    max_nodes: usize,
    deadline: Instant,
    /// The app stopped answering: every further call would wait out the
    /// same timeout, so the walk ends here.
    unreachable: Cell<bool>,
    /// The current pass ran out of budget.
    stopped: bool,
    /// Some pass ran out of budget.
    truncated: bool,
    /// The first node never reached at each level of the walk when it stopped.
    pending: Vec<(usize, UIElement, bool)>,
    /// Popup tops already listed, by rect and control type, so a toolkit that
    /// also shows them inside the window does not list them twice.
    listed: Vec<(Rect, i32)>,
    /// The described window, and the top-level window being walked: the same
    /// except while walking one of its popups.
    home: isize,
    top: isize,
    top_rect: Option<Rect>,
    focus: Focus,
}

impl Walk {
    fn spent(&self) -> bool {
        let overtime = Instant::now() > self.deadline;
        self.unreachable.get() || rank::walk_spent(self.rows.len(), self.row_limit, self.visits, self.max_nodes, overtime)
    }

    /// Start a pass with a budget of its own: up to `row_limit` rows in all,
    /// `nodes` visits before `time` runs out (ten times that at most).
    fn pass(&mut self, row_limit: usize, nodes: usize, time: Duration) {
        self.row_limit = row_limit;
        self.max_nodes = nodes;
        self.visits = 0;
        self.deadline = Instant::now() + time;
    }

    /// One step of navigation, cached when possible. A failed cached call is
    /// retried live, unless the app could not answer at all; "nothing there"
    /// is an answer, not a failure.
    fn step(
        &self,
        cached: impl FnOnce(&UICacheRequest) -> uiautomation::Result<UIElement>,
        live: impl FnOnce() -> uiautomation::Result<UIElement>,
    ) -> Option<(UIElement, bool)> {
        if let Some(req) = &self.req {
            match found(cached(req)) {
                Ok(Some(el)) => return Some((el, true)),
                Ok(None) => return None,
                Err(code) if rank::unreachable(code) => {
                    self.unreachable.set(true);
                    return None;
                }
                Err(_) => {}
            }
        }
        live().ok().map(|el| (el, false))
    }

    /// Note on the row at `index` that `n` siblings after it were skipped.
    fn report_more(&mut self, report: Option<(usize, usize)>) {
        let Some((index, n)) = report else { return };
        if let Some(row) = self.rows.get_mut(index) {
            row.more = Some(row.more.unwrap_or(0) + n);
        }
    }

    /// A row a collapsed run must keep: the selected or focused one, which is
    /// usually the very row the reader is asking about.
    fn wanted(&self, el: &UIElement, cached: bool, ctrl: i32) -> bool {
        props::selected(el, cached) == Some(true)
            || props::rect(el, cached).is_some_and(|r| self.focus.is(&props::name(el, cached), ctrl, &r))
    }

    fn first_child(&self, el: &UIElement) -> Option<(UIElement, bool)> {
        self.step(|r| self.walker.get_first_child_build_cache(el, r), || self.walker.get_first_child(el))
    }

    fn next_sibling(&self, el: &UIElement) -> Option<(UIElement, bool)> {
        self.step(|r| self.walker.get_next_sibling_build_cache(el, r), || self.walker.get_next_sibling(el))
    }

    /// Names of the first subtrees a stopped walk never reached, shallowest
    /// first: a dialog's later buttons matter more than the rest of a deep
    /// navigation tree. Unnamed subtrees are skipped; a name is what the
    /// reader can search for.
    fn unvisited(&self) -> Vec<String> {
        let mut pending: Vec<&(usize, UIElement, bool)> = self.pending.iter().collect();
        pending.sort_by_key(|(depth, _, _)| *depth);
        let mut names: Vec<String> = Vec::new();
        let mut reads = 0;
        for (_, first, cached) in pending {
            let mut cur = Some((first.clone(), *cached));
            while let Some((el, cached)) = cur {
                if names.len() >= UNVISITED_NAMES || reads >= UNVISITED_READS {
                    return names;
                }
                reads += 1;
                let name = props::name(&el, cached);
                let name = name.trim();
                if !name.is_empty() && !names.iter().any(|n| n == name) {
                    names.push(name.to_string());
                }
                cur = self.walker.get_next_sibling(&el).ok().map(|n| (n, false));
            }
        }
        names
    }
}

impl Session {
    /// Cache an element and hand back the ref the client will use for it.
    pub fn remember(&mut self, el: UIElement, top: isize) -> String {
        self.next += 1;
        self.clock += 1;
        let key = format!("el_{}", self.next);
        self.cache.insert(key.clone(), Entry { el, used: self.clock, top });
        if self.cache.len() > CACHE_LIMIT {
            // Evict a quarter at once so the sort runs once per ~1000 inserts
            // rather than on every one.
            let mut ages: Vec<(u64, String)> = self.cache.iter().map(|(k, e)| (e.used, k.clone())).collect();
            ages.sort_unstable();
            for (_, k) in ages.into_iter().take(CACHE_LIMIT / 4) {
                self.cache.remove(&k);
            }
        }
        key
    }

    /// The window's element, with its properties cached when possible.
    fn element_for(&self, raw: isize, req: Option<&UICacheRequest>) -> Result<(UIElement, bool), String> {
        if let Some(r) = req {
            match self.auto.element_from_handle_build_cache(Handle::from(raw), r) {
                Ok(el) => return Ok((el, true)),
                // A live retry would only wait out the same timeout again.
                Err(e) if rank::unreachable(e.code()) => return Err(e.to_string()),
                Err(_) => {}
            }
        }
        self.auto.element_from_handle(Handle::from(raw)).map(|el| (el, false)).map_err(|e| e.to_string())
    }

    /// Where a search looks, in order: the window's open popups first (an open
    /// menu is what the user is looking at), then the window. Without a window,
    /// the whole desktop.
    fn scopes(&self, window_ref: Option<&str>) -> Result<Vec<Scope>, String> {
        let Some(w) = window_ref else {
            let root = self.auto.get_root_element().map_err(|e| e.to_string())?;
            return Ok(vec![Scope { root, top: 0, rect: None, popup: false }]);
        };
        let raw = readable_window(w)?;
        let main = self
            .auto
            .element_from_handle(Handle::from(raw))
            .map_err(|e| format!("no window for ref '{w}': {e}"))?;
        let mut out: Vec<Scope> = popups::popups_of(hwnd_of(raw))
            .into_iter()
            .filter_map(|(h, rect)| {
                let top = h.0 as isize;
                let root = self.auto.element_from_handle(Handle::from(top)).ok()?;
                Some(Scope { root, top, rect: Some(rect), popup: true })
            })
            .collect();
        out.push(Scope { root: main, top: raw, rect: rect_of(hwnd_of(raw)), popup: false });
        Ok(out)
    }

    /// Filter on control type in UIA, then on name in Rust: a substring match
    /// is what an agent naturally asks for, and UIA has no "contains"
    /// condition. Without a role this must match everything. It used to be
    /// IsEnabled=true, which hid disabled controls from every search, so a
    /// button greying out counted as "disappears" and a disabled one could
    /// never "appear".
    fn role_condition(&self, role: Option<&str>) -> Result<UICondition, String> {
        match role {
            Some(r) => self
                .auto
                .create_property_condition(UIProperty::ControlType, Variant::from(role_id(r)?), None)
                .map_err(|e| e.to_string()),
            None => self.auto.create_true_condition().map_err(|e| e.to_string()),
        }
    }

    /// Every control in a scope that meets the condition, in tree order, and
    /// whether their properties came back cached.
    ///
    /// find_all walks the entire subtree before returning. Across the whole
    /// desktop that is seconds, which makes polling waits useless. When the
    /// caller only wants one match, find_first short-circuits on the first hit
    /// instead.
    fn find_in(
        &self,
        scope: &Scope,
        cond: &UICondition,
        req: Option<&UICacheRequest>,
        first_only: bool,
    ) -> Result<(Vec<UIElement>, bool), String> {
        // A popup's own top node can be the thing asked for (role "menu");
        // the window's never is.
        let tree = if scope.popup { TreeScope::Subtree } else { TreeScope::Descendants };
        // A cached call that failed because the app cannot answer is not
        // retried live: that would wait out the same timeout a second time.
        if first_only {
            if let Some(r) = req {
                match found(scope.root.find_first_build_cache(tree, cond, r)) {
                    Ok(el) => return Ok((el.into_iter().collect(), true)),
                    Err(code) if rank::unreachable(code) => return Err(format!("search failed: error {code:#x}")),
                    Err(_) => {}
                }
            }
            return Ok((scope.root.find_first(tree, cond).ok().into_iter().collect(), false));
        }
        if let Some(r) = req {
            match scope.root.find_all_build_cache(tree, cond, r) {
                Ok(all) => return Ok((all, true)),
                Err(e) if rank::unreachable(e.code()) => return Err(format!("search failed: {e}")),
                Err(_) => {}
            }
        }
        scope.root.find_all(tree, cond).map(|all| (all, false)).map_err(|e| format!("search failed: {e}"))
    }

    /// The controls in `scopes` that meet the condition and match the name or
    /// id, in tree order. With `first_only`, only the first scope with a
    /// match is searched, and only for its first match. Unnamed controls are
    /// dropped from a listing unless `keep_unnamed`.
    #[allow(clippy::too_many_arguments)]
    fn candidates(
        &self,
        scopes: &[Scope],
        cond: &UICondition,
        req: Option<&UICacheRequest>,
        name: Option<&str>,
        automation_id: Option<&str>,
        first_only: bool,
        keep_unnamed: bool,
    ) -> Result<Vec<Candidate>, String> {
        let mut candidates: Vec<Candidate> = Vec::new();
        for (i, scope) in scopes.iter().enumerate() {
            let (all, cached) = match self.find_in(scope, cond, req, first_only) {
                Ok(f) => f,
                // A popup can close mid-search; only the window itself
                // failing is an error.
                Err(_) if scope.popup => continue,
                Err(e) => return Err(e),
            };
            for el in all {
                let (tier, el_name) = if let Some(want) = automation_id {
                    // An AutomationId match is exact and wins outright; it is
                    // what makes a selector survive a relabel or a translated
                    // build.
                    if props::automation_id(&el, cached).as_deref() != Some(want) {
                        continue;
                    }
                    (0, props::name(&el, cached))
                } else {
                    let el_name = props::name(&el, cached);
                    match name {
                        Some(needle) => match rank::name_tier(&el_name, needle) {
                            Some(t) => (t, el_name),
                            None => continue,
                        },
                        None if !keep_unnamed && el_name.trim().is_empty() => continue,
                        None => (0, el_name),
                    }
                };
                let order = candidates.len();
                candidates.push(Candidate { el, cached, scope: i, name: el_name, tier, order });
            }
            if first_only && !candidates.is_empty() {
                break;
            }
        }
        Ok(candidates)
    }

    pub fn find_elements(
        &mut self,
        window_ref: Option<&str>,
        name: Option<&str>,
        role: Option<&str>,
        automation_id: Option<&str>,
        limit: usize,
        include_hidden: bool,
    ) -> Result<Vec<ElementInfo>, String> {
        let scopes = self.scopes(window_ref)?;
        let cond = self.role_condition(role)?;
        let req = props::request_for(&self.auto, props::FIND);
        // Asking for any one control of a role (a wait for one to appear).
        // Unnamed matches are noise in a listing, but here any match answers
        // the question, and discarding one would report "no such control"
        // while it is right there.
        let lone = limit == 1 && name.is_none() && automation_id.is_none() && !include_hidden;
        let candidates = self.candidates(&scopes, &cond, req.as_ref(), name, automation_id, lone, lone)?;

        let (mut best, mut hidden) = if name.is_some() {
            self.rank_matches(candidates, &scopes, limit)
        } else {
            self.listing(candidates, &scopes, limit)
        };
        if lone && best.is_empty() && !hidden.is_empty() {
            // find_first returns the first match in tree order, shown or not.
            // When that one has no rect (an item of a closed menu, a row on
            // an unselected tab), a visible match further on would never be
            // seen, and a wait for one would never end.
            let all = self.candidates(&scopes, &cond, req.as_ref(), None, None, false, true)?;
            (best, hidden) = self.listing(all, &scopes, limit);
        }
        let mut out: Vec<ElementInfo> = Vec::new();
        if !best.is_empty() {
            // Read only when there is something to report: it is a call or three.
            let tops: Vec<isize> = scopes.iter().map(|s| s.top).collect();
            let focus = Focus::now(&self.auto, &tops);
            for m in best {
                let scope = &scopes[m.scope];
                out.push(self.element_info(m.el, m.cached, m.seen, scope.top, scope.popup, &focus));
            }
        }
        if include_hidden {
            out.extend(self.hidden_matches(hidden, &scopes));
        }
        Ok(out)
    }

    /// A candidate's rect and what ranking reads, or the candidate back when it
    /// has no usable rect.
    fn read_match(&self, c: Candidate, scopes: &[Scope]) -> Result<Matched, Candidate> {
        let scope = &scopes[c.scope];
        let Some(rect) = props::rect(&c.el, c.cached) else { return Err(c) };
        let enabled = props::enabled(&c.el, c.cached);
        let uia_offscreen = props::offscreen(&c.el, c.cached);
        let outside = scope.rect.is_some_and(|w| rank::outside(&rect, &w));
        let rank = Rank {
            tier: c.tier,
            popup: scope.popup,
            enabled,
            offscreen: uia_offscreen,
            outside,
            area: i64::from(rect.width) * i64::from(rect.height),
            order: c.order,
        };
        let seen = Seen { name: c.name, rect, enabled, offscreen: uia_offscreen || outside };
        Ok(Matched { el: c.el, cached: c.cached, scope: c.scope, seen, rank })
    }

    /// The best `limit` name matches, best first, and the matches that had no
    /// rect.
    ///
    /// Tree order used to decide, and stopped at `limit`, so "Save" could
    /// circle "Save as…" or "Autosave" while the exact "Save" sat further down.
    /// Every match is collected; tiers are read best first, and each tier is
    /// sorted on what makes a control the one to click.
    fn rank_matches(&self, mut candidates: Vec<Candidate>, scopes: &[Scope], limit: usize) -> (Vec<Matched>, Vec<Candidate>) {
        candidates.sort_by_key(|c| (c.tier, !scopes[c.scope].popup, c.order));
        let mut rest = candidates.into_iter().peekable();
        let mut out: Vec<Matched> = Vec::new();
        let mut hidden = Vec::new();
        let mut reads = 0;
        while out.len() < limit && reads < RANK_READS {
            let Some(tier) = rest.peek().map(|c| c.tier) else { break };
            let mut group = Vec::new();
            while reads < RANK_READS {
                let Some(c) = rest.next_if(|c| c.tier == tier) else { break };
                reads += 1;
                match self.read_match(c, scopes) {
                    Ok(m) => group.push(m),
                    Err(c) => hidden.push(c),
                }
            }
            group.sort_by_key(|m| rank::rank_key(&m.rank));
            out.extend(group);
        }
        // Some toolkits also show an open popup inside the window's own tree;
        // the copy found in the popup ranks first, so drop the other.
        let mut in_popups: Vec<(Rect, String)> = Vec::new();
        out.retain(|m| {
            let key = (m.seen.rect, m.seen.name.clone());
            if scopes[m.scope].popup {
                in_popups.push(key);
                true
            } else {
                !in_popups.contains(&key)
            }
        });
        out.truncate(limit);
        (out, hidden)
    }

    /// Without a name there is nothing to rank by, so keep the app's order but
    /// put on-screen controls before scrolled-out ones, reading only as far as
    /// `limit` on-screen ones.
    fn listing(&self, candidates: Vec<Candidate>, scopes: &[Scope], limit: usize) -> (Vec<Matched>, Vec<Candidate>) {
        let mut shown = Vec::new();
        let mut scrolled = Vec::new();
        let mut hidden = Vec::new();
        for (reads, c) in candidates.into_iter().enumerate() {
            if shown.len() >= limit || reads >= RANK_READS.max(limit) {
                break;
            }
            match self.read_match(c, scopes) {
                Ok(m) if m.seen.offscreen => scrolled.push(m),
                Ok(m) => shown.push(m),
                Err(c) => hidden.push(c),
            }
        }
        shown.extend(scrolled);
        shown.truncate(limit);
        (shown, hidden)
    }

    /// The full report for a control, from what was already read plus its
    /// role, id, value and state. `top` is its top-level window and `popup`
    /// whether that is a popup of the searched window.
    fn element_info(&mut self, el: UIElement, cached: bool, seen: Seen, top: isize, popup: bool, focus: &Focus) -> ElementInfo {
        let ctrl = props::control_type(&el, cached);
        let role = role_name(ctrl);
        let state = props::state(&el, cached, role, focus.is(&seen.name, ctrl, &seen.rect));
        let automation_id = props::automation_id(&el, cached);
        let value = props::value(&el, cached);
        ElementInfo {
            r#ref: self.remember(el, top),
            name: seen.name,
            role: role.to_string(),
            automation_id,
            rect: seen.rect,
            enabled: seen.enabled,
            value,
            offscreen: seen.offscreen,
            state,
            window: popup.then(|| top.to_string()),
            hidden: None,
            container: None,
        }
    }

    /// The best few matches that have no usable rect, each with why and what
    /// to open first.
    fn hidden_matches(&mut self, mut hidden: Vec<Candidate>, scopes: &[Scope]) -> Vec<ElementInfo> {
        hidden.sort_by_key(|c| (c.tier, !scopes[c.scope].popup, c.order));
        hidden.truncate(HIDDEN_LIMIT);
        hidden
            .into_iter()
            .map(|c| {
                let scope = &scopes[c.scope];
                let (why, container) = self.container_of(&c.el, scope.top);
                let ctrl = props::control_type(&c.el, c.cached);
                let automation_id = props::automation_id(&c.el, c.cached);
                let enabled = props::enabled(&c.el, c.cached);
                let value = props::value(&c.el, c.cached);
                ElementInfo {
                    r#ref: self.remember(c.el, scope.top),
                    name: c.name,
                    role: role_name(ctrl).to_string(),
                    automation_id,
                    rect: Rect { x: 0, y: 0, width: 0, height: 0 },
                    enabled,
                    value,
                    offscreen: false,
                    state: None,
                    window: scope.popup.then(|| scope.top.to_string()),
                    hidden: Some(why.to_string()),
                    container,
                }
            })
            .collect()
    }

    /// Why a match has no rect, and the control to open to reveal it.
    ///
    /// The outermost closed ancestor wins: inside a collapsed tree node within
    /// another collapsed one, only the outer node can be clicked. A tab counts
    /// only when the match sits inside the tab item itself; toolkits that make
    /// pages siblings of their tabs (WinForms) give no reliable link, so those
    /// matches stay "no-rect" rather than name a guessed tab.
    fn container_of(&mut self, el: &UIElement, top: isize) -> (&'static str, Option<ContainerInfo>) {
        let Ok(walker) = self.auto.get_control_view_walker() else { return ("no-rect", None) };
        let mut cur = el.clone();
        let mut open: Option<(&'static str, UIElement, i32)> = None;
        for _ in 0..PARENT_WALK {
            let Ok(parent) = walker.get_parent(&cur) else { break };
            let ctrl = props::control_type(&parent, false);
            let role = role_name(ctrl);
            if role == "window" {
                break;
            }
            if rank::wants_expand(role) && props::expand_state(&parent, false) == Some(0) {
                open = Some(("collapsed", parent.clone(), ctrl));
            } else if role == "tabitem" && props::selected(&parent, false) == Some(false) {
                open = Some(("unselected-tab", parent.clone(), ctrl));
            }
            cur = parent;
        }
        match open {
            Some((why, el, ctrl)) => {
                let name = props::name(&el, false);
                let container = ContainerInfo { r#ref: self.remember(el, top), name, role: role_name(ctrl).to_string() };
                (why, Some(container))
            }
            None => ("no-rect", None),
        }
    }

    /// A row for a control that has a rect.
    #[allow(clippy::too_many_arguments)]
    fn row(
        &mut self,
        w: &Walk,
        el: &UIElement,
        cached: bool,
        depth: usize,
        rect: Rect,
        name: String,
        value: Option<String>,
        popup: bool,
    ) -> DescribedNode {
        let ctrl = props::control_type(el, cached);
        let role = role_name(ctrl);
        let focused = w.focus.is(&name, ctrl, &rect);
        DescribedNode {
            depth,
            automation_id: props::automation_id(el, cached),
            enabled: props::enabled(el, cached),
            offscreen: props::offscreen(el, cached) || w.top_rect.is_some_and(|t| rank::outside(&rect, &t)),
            state: props::state(el, cached, role, focused),
            r#ref: self.remember(el.clone(), w.top),
            name,
            role: role.to_string(),
            value,
            rect,
            popup,
            window: (w.top != w.home).then(|| w.top.to_string()),
            more: None,
        }
    }

    /// Visit one node: emit a row if it says anything, and report whether its
    /// children should be walked.
    ///
    /// Unnamed, valueless containers are pure structure: they cost tokens and
    /// tell the reader nothing, so they get no row, but their children are
    /// walked and only emitted rows count against max_nodes. Counting every
    /// walked node used to end a Chromium describe after ~120 wrappers with a
    /// few dozen rows and no truncation note.
    fn visit(&mut self, w: &mut Walk, el: &UIElement, cached: bool, depth: usize) -> bool {
        w.visits += 1;
        let Some(rect) = props::rect(el, cached) else { return true };
        if w.listed.iter().any(|(r, _)| *r == rect) {
            let ctrl = props::control_type(el, cached);
            if w.listed.iter().any(|(r, c)| *r == rect && *c == ctrl) {
                return false;
            }
        }
        let name = props::name(el, cached);
        let value = props::value(el, cached);
        if depth > 0 && name.trim().is_empty() && value.is_none() {
            return true;
        }
        let row = self.row(w, el, cached, depth, rect, name, value, false);
        w.rows.push(row);
        true
    }

    /// Depth-first walk of the control view under `parent`, stopping when the
    /// walk's budget is spent and remembering the first node it never reached
    /// at each level. Long runs of list, tree and grid rows are cut short
    /// here (rank::Run), so the budget reaches what comes after them.
    fn walk(&mut self, w: &mut Walk, parent: &UIElement, depth: usize) {
        if depth > w.max_depth {
            return;
        }
        let mut run = rank::Run::default();
        let mut next = w.first_child(parent);
        while let Some((el, cached)) = next {
            if w.spent() {
                w.stopped = true;
                w.pending.push((depth, el, cached));
                break;
            }
            let ctrl = props::control_type(&el, cached);
            let (skip, report) = run.skip(role_name(ctrl), || w.wanted(&el, cached, ctrl));
            w.report_more(report);
            if skip {
                // Skipping still cost the step to it.
                w.visits += 1;
            } else {
                let at = w.rows.len();
                let open = self.visit(w, &el, cached, depth);
                if w.rows.len() > at {
                    run.kept(at);
                }
                if open {
                    self.walk(w, &el, depth + 1);
                }
            }
            next = w.next_sibling(&el);
            if w.stopped {
                if let Some((el, cached)) = next {
                    w.pending.push((depth, el, cached));
                }
                break;
            }
        }
        w.report_more(run.finish());
    }

    pub fn describe(&mut self, window_ref: &str, max_nodes: usize, max_depth: usize) -> Result<Described, String> {
        let raw = readable_window(window_ref)?;
        let req = props::request_for(&self.auto, props::DESCRIBE);
        let (root, cached) = self
            .element_for(raw, req.as_ref())
            .map_err(|e| format!("no window for ref '{window_ref}': {e}"))?;
        let walker = self.auto.get_control_view_walker().map_err(|e| e.to_string())?;
        let reserve = rank::popup_reserve(max_nodes);
        let popups = if reserve > 0 { popups::popups_of(hwnd_of(raw)) } else { Vec::new() };
        let mut tops: Vec<isize> = popups.iter().map(|(h, _)| h.0 as isize).collect();
        tops.push(raw);
        let focus = Focus::now(&self.auto, &tops);
        let mut w = Walk {
            walker,
            req,
            max_depth,
            rows: Vec::new(),
            row_limit: max_nodes,
            visits: 0,
            max_nodes,
            deadline: Instant::now() + EXTRA_WALK_TIME,
            unreachable: Cell::new(false),
            stopped: false,
            truncated: false,
            pending: Vec::new(),
            listed: Vec::new(),
            home: raw,
            top: raw,
            top_rect: rect_of(hwnd_of(raw)),
            focus,
        };

        if let Some(rect) = props::rect(&root, cached) {
            let name = props::name(&root, cached);
            let value = props::value(&root, cached);
            let row = self.row(&w, &root, cached, 0, rect, name, value, false);
            w.rows.push(row);
        }

        // Open popups go right after the window's own row, within a reserve,
        // so a big window cannot crowd out the menu the user just opened.
        // They also walk on a budget of their own, visits and time, so a big
        // or slow popup made of unnamed wrappers cannot leave the window's
        // walk spent before it starts.
        if !popups.is_empty() {
            let limit = w.rows.len() + reserve;
            w.pass(limit, reserve, EXTRA_WALK_TIME / 2);
            for (h, prect) in popups {
                if w.spent() {
                    break;
                }
                let top = h.0 as isize;
                let Ok((pel, pcached)) = self.element_for(top, w.req.as_ref()) else { continue };
                w.top = top;
                w.top_rect = Some(prect);
                let at = w.rows.len();
                if let Some(rect) = props::rect(&pel, pcached) {
                    w.listed.push((rect, props::control_type(&pel, pcached)));
                    let name = props::name(&pel, pcached);
                    let value = props::value(&pel, pcached);
                    let row = self.row(&w, &pel, pcached, 1, rect, name, value, true);
                    w.rows.push(row);
                }
                self.walk(&mut w, &pel, 2);
                // An unnamed popup with nothing named inside is an empty host
                // or a decoration: a row saying "(popup)" and nothing more.
                if w.rows.len() == at + 1 && w.rows[at].name.trim().is_empty() {
                    w.rows.truncate(at);
                }
                w.truncated |= w.stopped;
                w.stopped = false;
            }
        }

        w.top = raw;
        w.top_rect = rect_of(hwnd_of(raw));
        w.pass(max_nodes, max_nodes, EXTRA_WALK_TIME);
        self.walk(&mut w, &root, 1);
        let truncated = w.truncated || w.stopped;
        // Naming what was missed means asking the app again, which an app
        // that stopped answering would make wait out the timeout per name.
        let unvisited = if truncated && !w.unreachable.get() { w.unvisited() } else { Vec::new() };
        Ok(Described { nodes: w.rows, truncated, unvisited })
    }

    /// Re-read current rectangles. This is the tracker's hot path, and the
    /// touch here is what keeps on-screen anchors out of cache eviction.
    ///
    /// Each element costs one call: its rect and offscreen flag come back in
    /// the same cache refresh, falling back to two live reads.
    ///
    /// The client gives a whole batch a few seconds, and restarts the helper
    /// (losing every ref) when it overruns. So each call gets a tight timeout,
    /// no call is made into a window that is not responding, and once a
    /// window times out its other refs in the batch are not asked either:
    /// each would wait out the same timeout.
    pub fn resolve(&mut self, refs: &[String]) -> Vec<Resolved> {
        let _bound = CallBound::new(&self.auto, HOT_CALL_TIMEOUT_MS);
        self.clock += 1;
        let now = self.clock;
        let req = props::request_for(&self.auto, props::PLACE);
        let mut silent: Vec<isize> = Vec::new();
        let mut out = Vec::with_capacity(refs.len());
        for r in refs {
            let missing = |reason: Option<&str>| Resolved {
                r#ref: r.clone(),
                rect: None,
                reason: reason.map(str::to_string),
                offscreen: false,
            };
            if let Some(entry) = self.cache.get_mut(r) {
                entry.used = now;
                let top = entry.top;
                if top != 0 && (silent.contains(&top) || is_hung(hwnd_of(top))) {
                    // Not gone, so no reason: the window is still there and
                    // its controls come back when it answers again.
                    if !silent.contains(&top) {
                        silent.push(top);
                    }
                    out.push(missing(None));
                    continue;
                }
                // A window on another desktop keeps its controls' rects, but
                // drawing at them would mark whatever is on this one.
                if top != 0 && is_cloaked(hwnd_of(top)) {
                    out.push(missing(Some("other-desktop")));
                    continue;
                }
                let (el, cached) = match req.as_ref().map(|q| entry.el.build_updated_cache(q)) {
                    Some(Ok(fresh)) => (fresh, true),
                    Some(Err(e)) if rank::unreachable(e.code()) => {
                        if top != 0 {
                            silent.push(top);
                        }
                        out.push(missing(None));
                        continue;
                    }
                    _ => (entry.el.clone(), false),
                };
                let rect = props::rect(&el, cached);
                let offscreen = rect.is_some_and(|rc| {
                    props::offscreen(&el, cached)
                        || (top != 0 && rect_of(hwnd_of(top)).is_some_and(|t| rank::outside(&rc, &t)))
                });
                let reason = rect.is_none().then(|| gone_reason(top).to_string());
                out.push(Resolved { r#ref: r.clone(), rect, reason, offscreen });
            } else if let Ok(raw) = r.parse::<isize>() {
                let hwnd = hwnd_of(raw);
                let shown = unsafe { IsWindowVisible(hwnd) }.as_bool()
                    && !unsafe { IsIconic(hwnd) }.as_bool()
                    && !is_cloaked(hwnd);
                out.push(match rect_of(hwnd).filter(|_| shown) {
                    Some(rect) => Resolved { r#ref: r.clone(), rect: Some(rect), reason: None, offscreen: false },
                    None => missing(Some(gone_reason(raw))),
                });
            } else {
                out.push(missing(Some("gone")));
            }
        }
        out
    }

    /// The control under a virtual-screen physical point, and its top-level
    /// window. Elements of `ignore_pid` (the overlay itself) are never returned.
    ///
    /// The overlay is click-through, so hit-testing already passes through it,
    /// but the chat panel is not: a point on the panel must come back as
    /// nothing rather than as the user's answer.
    pub fn element_at_point(&mut self, x: i32, y: i32, ignore_pid: u32) -> Result<PointHit, String> {
        let ours = |pid: u32| ignore_pid != 0 && pid == ignore_pid;
        // A window that is not responding would hold every call below for the
        // full timeout; it is still the window that was clicked.
        let under = unsafe { GetAncestor(WindowFromPoint(POINT { x, y }), GA_ROOT) };
        if !under.is_invalid() && is_hung(under) {
            let window = (!ours(popups::pid_of(under)))
                .then(|| WindowRef { r#ref: (under.0 as isize).to_string(), title: title_of(under) });
            return Ok(PointHit { element: None, window });
        }
        let _bound = CallBound::new(&self.auto, HOT_CALL_TIMEOUT_MS);
        let el = self
            .auto
            .element_from_point(Point::new(x, y))
            .map_err(|e| format!("nothing answers at {x},{y}: {e}"))?;
        if ours(el.get_process_id().unwrap_or(0)) {
            return Ok(PointHit { element: None, window: None });
        }
        // Windowless content (a browser page, a XAML island) has no handle of
        // its own; the window at the point is then the one it is drawn in.
        let own: HWND = el.get_native_window_handle().map(Into::into).unwrap_or_default();
        let at = if own.is_invalid() { unsafe { WindowFromPoint(POINT { x, y }) } } else { own };
        let top = unsafe { GetAncestor(at, GA_ROOT) };
        let window = (!top.is_invalid() && !ours(popups::pid_of(top)))
            .then(|| WindowRef { r#ref: (top.0 as isize).to_string(), title: title_of(top) });
        let top_raw = if window.is_some() { top.0 as isize } else { 0 };

        let element = match props::rect(&el, false) {
            Some(rect) => {
                let name = props::name(&el, false);
                let enabled = props::enabled(&el, false);
                let top_rect = if top_raw != 0 { rect_of(top) } else { None };
                let offscreen = props::offscreen(&el, false) || top_rect.is_some_and(|t| rank::outside(&rect, &t));
                let focus = Focus::now(&self.auto, &[top_raw]);
                let seen = Seen { name, rect, enabled, offscreen };
                Some(self.element_info(el, false, seen, top_raw, false, &focus))
            }
            None => None,
        };
        Ok(PointHit { element, window })
    }

    /// Bring a control into view with ScrollItemPattern, or failing that by
    /// stepping the nearest scrollable container toward it. A view change,
    /// like scroll_window: it moves the content, never the pointer, and never
    /// acts on the control.
    pub fn scroll_into_view(
        &mut self,
        window_ref: &str,
        name: Option<&str>,
        role: Option<&str>,
        automation_id: Option<&str>,
    ) -> Result<ScrollIntoView, String> {
        let what = match (automation_id, name) {
            (Some(id), _) => format!("automationId \"{id}\""),
            (None, Some(n)) => format!("\"{n}\""),
            (None, None) => return Err("scroll_into_view needs a name or automationId".into()),
        };
        let mut found = self.find_elements(Some(window_ref), name, role, automation_id, 1, false)?;
        if found.is_empty() {
            // An item scrolled far out of a virtualised list can lack a rect
            // altogether and still scroll into view. One inside a closed
            // container cannot: that container has to be opened first.
            found = self
                .find_elements(Some(window_ref), name, role, automation_id, 1, true)?
                .into_iter()
                .filter(|e| e.hidden.as_deref() == Some("no-rect"))
                .collect();
        }
        let Some(mut best) = found.into_iter().next() else {
            return Err(format!("no control matching {what} in this window"));
        };
        if !best.offscreen && best.hidden.is_none() {
            return Ok(ScrollIntoView { scrolled: false, element: best });
        }
        let Some(entry) = self.cache.get(&best.r#ref) else {
            return Err(format!("{what} went away before it could be scrolled"));
        };
        let (el, top) = (entry.el.clone(), entry.top);
        let scrolled = match el.get_pattern::<UIScrollItemPattern>() {
            Ok(item) => {
                item.scroll_into_view().map_err(|e| format!("could not scroll \"{}\" into view: {e}", best.name))?;
                true
            }
            Err(_) => self.step_into_view(&el).ok_or_else(|| {
                format!(
                    "\"{}\" [{}] cannot scroll itself into view (it has no ScrollItemPattern), and no \
                     scrollable container around it could be stepped toward it; scroll_window with notches \
                     scrolls the window instead",
                    best.name, best.role
                )
            })?,
        };
        // The rect and the offscreen flag are what scrolling changed.
        if let Some(rect) = props::rect(&el, false) {
            best.offscreen = props::offscreen(&el, false) || rect_of(hwnd_of(top)).is_some_and(|t| rank::outside(&rect, &t));
            best.rect = rect;
            best.hidden = None;
            best.container = None;
        }
        Ok(ScrollIntoView { scrolled, element: best })
    }

    /// Step the nearest scrollable ancestor of `el` toward it until its centre
    /// is inside that container, as a user's clicks on the scroll bar would
    /// (ScrollPattern, never input). Some(whether anything moved), or None
    /// when there is no rect to aim at or nothing to scroll.
    ///
    /// Page steps first, since a page never carries an item that is less than
    /// a page away past the edge; an axis whose direction flips has
    /// overshot, and continues a line at a time. A step that leaves the item
    /// where it was means the container is at the end of its range.
    fn step_into_view(&self, el: &UIElement) -> Option<bool> {
        props::rect(el, false)?;
        let walker = self.auto.get_control_view_walker().ok()?;
        let mut cur = walker.get_parent(el).ok();
        let mut found: Option<(UIElement, UIScrollPattern)> = None;
        for _ in 0..PARENT_WALK {
            let Some(parent) = cur else { break };
            if let Ok(p) = parent.get_pattern::<UIScrollPattern>() {
                if p.is_vertically_scrollable().unwrap_or(false) || p.is_horizontally_scrollable().unwrap_or(false) {
                    found = Some((parent, p));
                    break;
                }
            }
            cur = walker.get_parent(&parent).ok();
        }
        let (container, scroller) = found?;
        let can = (
            scroller.is_horizontally_scrollable().unwrap_or(false),
            scroller.is_vertically_scrollable().unwrap_or(false),
        );
        let mut fine = (false, false);
        let mut last = (Nudge::Stay, Nudge::Stay);
        let mut moved = false;
        for _ in 0..SCROLL_STEPS {
            let (Some(item), Some(view)) = (props::rect(el, false), props::rect(&container, false)) else { break };
            let (h, v) = rank::nudge(&item, &view);
            fine.0 |= reversed(last.0, h);
            fine.1 |= reversed(last.1, v);
            let step = (scroll_amount(h, can.0, fine.0), scroll_amount(v, can.1, fine.1));
            if step == (ScrollAmount::NoAmount, ScrollAmount::NoAmount) || scroller.scroll(step.0, step.1).is_err() {
                break;
            }
            if props::rect(el, false) == Some(item) {
                break;
            }
            moved = true;
            last = (h, v);
        }
        Some(moved)
    }

    /// The scrolling element a wheel at the window's centre moves: the
    /// nearest ancestor of the control there that scrolls vertically, else
    /// the window element itself. Never a search of the whole window, which
    /// in a big tree with nothing scrollable would cost seconds to find
    /// nothing.
    fn scroller_at_centre(&self, hwnd: HWND) -> Option<UIScrollPattern> {
        let rect = rect_of(hwnd)?;
        let (x, y) = (rect.x + rect.width / 2, rect.y + rect.height / 2);
        // Only when the window itself is what shows at its centre; otherwise
        // the control there belongs to whatever covers it.
        let at = unsafe { GetAncestor(WindowFromPoint(POINT { x, y }), GA_ROOT) };
        if at == hwnd {
            if let (Ok(mut el), Ok(walker)) =
                (self.auto.element_from_point(Point::new(x, y)), self.auto.get_control_view_walker())
            {
                for _ in 0..PARENT_WALK {
                    if let Some(p) = vertical_scroller(&el) {
                        return Some(p);
                    }
                    let own: HWND = el.get_native_window_handle().map(Into::into).unwrap_or_default();
                    if own == hwnd {
                        break;
                    }
                    let Ok(parent) = walker.get_parent(&el) else { break };
                    el = parent;
                }
            }
        }
        vertical_scroller(&self.auto.element_from_handle(Handle::from(hwnd.0 as isize)).ok()?)
    }

    /// Scroll a window by wheel notches, reporting the vertical position of
    /// what it scrolled before and after, so a scroll that moved nothing (an
    /// app that ignores wheel messages sent to it, a list already at its end)
    /// can say so instead of sending the agent off to re-read an unchanged
    /// view.
    pub fn scroll_window(&mut self, hwnd: HWND, notches: i32) -> Result<Scrolled, String> {
        // A window that is not responding gets the scroll's own error, before
        // any UI Automation call can wait on it.
        let scroller = if is_hung(hwnd) { None } else { self.scroller_at_centre(hwnd) };
        let before = scroller.as_ref().and_then(vertical_percent);
        crate::winops::scroll(hwnd, notches)?;
        let after = match (&scroller, before) {
            (Some(p), Some(b)) => settled_percent(p, b),
            _ => None,
        };
        Ok(Scrolled { scrolled: true, before, after })
    }

    /// Collapsed expandable controls in a window and its open popups (menus,
    /// menu items with submenus, combo boxes, tree nodes, split buttons):
    /// where a control that matched nothing may be hiding. Named ones only,
    /// since an unnamed one cannot be pointed out, in tree order with
    /// on-screen ones first.
    pub fn collapsed(&mut self, window_ref: &str, limit: usize) -> Result<Vec<ElementInfo>, String> {
        let scopes = self.scopes(Some(window_ref))?;
        // ExpandCollapseState 0 is Collapsed. Controls without the pattern
        // have no such state and never match.
        let cond = self
            .auto
            .create_property_condition(UIProperty::ExpandCollapseExpandCollapseState, Variant::from(0i32), None)
            .map_err(|e| e.to_string())?;
        let req = props::request_for(&self.auto, props::FIND);
        let candidates = self.candidates(&scopes, &cond, req.as_ref(), None, None, false, false)?;
        let (shown, _) = self.listing(candidates, &scopes, limit);
        if shown.is_empty() {
            return Ok(Vec::new());
        }
        let tops: Vec<isize> = scopes.iter().map(|s| s.top).collect();
        let focus = Focus::now(&self.auto, &tops);
        Ok(shown
            .into_iter()
            .map(|m| {
                let scope = &scopes[m.scope];
                self.element_info(m.el, m.cached, m.seen, scope.top, scope.popup, &focus)
            })
            .collect())
    }

    /// Names in the window closest to one that matched nothing, best first.
    ///
    /// Only a name and a role per control are read, cached in the search call
    /// itself when UIA allows, so this costs about what one find does.
    pub fn suggest(&mut self, window_ref: &str, name: &str, role: Option<&str>, limit: usize) -> Result<Vec<Suggestion>, String> {
        let scopes = self.scopes(Some(window_ref))?;
        let cond = self.role_condition(role)?;
        let req = props::request_for(&self.auto, props::NAMES);
        // (score, tree order, normalised name, name, control type)
        let mut near: Vec<(f32, usize, String, String, i32)> = Vec::new();
        let mut order = 0;
        for scope in &scopes {
            let (all, cached) = match self.find_in(scope, &cond, req.as_ref(), false) {
                Ok(f) => f,
                Err(_) if scope.popup => continue,
                Err(e) => return Err(e),
            };
            for el in all {
                order += 1;
                let full = props::name(&el, cached);
                let label = full.trim();
                // Long names are document text, never a control's label.
                if label.is_empty() || label.len() > 100 {
                    continue;
                }
                let score = rank::similarity(label, name);
                if score < rank::SUGGEST_THRESHOLD {
                    continue;
                }
                let key = rank::normalise(label);
                if near.iter().any(|n| n.2 == key) {
                    continue;
                }
                near.push((score, order, key, label.to_string(), props::control_type(&el, cached)));
            }
        }
        near.sort_by(|a, b| b.0.total_cmp(&a.0).then(a.1.cmp(&b.1)));
        Ok(near
            .into_iter()
            .take(limit)
            .map(|(_, _, _, name, ctrl)| Suggestion { name, role: role_name(ctrl).to_string() })
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_role_round_trips() {
        for (id, name) in ROLES {
            assert_eq!(role_id(name), Ok(*id), "{name}");
            assert_eq!(role_name(*id), *name);
        }
    }

    #[test]
    fn aliases_and_spacing_resolve() {
        assert_eq!(role_id("TextBox"), role_id("edit"));
        assert_eq!(role_id("list item"), role_id("listitem"));
        assert_eq!(role_id("menu_item"), role_id("menuitem"));
        assert_eq!(role_id("dialog"), role_id("window"));
    }

    #[test]
    fn unknown_role_is_an_error_naming_the_options() {
        let err = role_id("widget").unwrap_err();
        assert!(err.contains("'widget'") && err.contains("slider"), "{err}");
    }

    #[test]
    fn unmapped_control_type_is_other() {
        assert_eq!(role_name(49999), "other");
    }
}

