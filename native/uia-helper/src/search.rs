//! UI Automation queries: searching, describing and re-resolving controls.

use std::collections::HashMap;

use uiautomation::types::{TreeScope, UIProperty};
use uiautomation::variants::Variant;
use uiautomation::{UIAutomation, UIElement};
use windows::Win32::Foundation::HWND;
use windows::Win32::UI::WindowsAndMessaging::{IsIconic, IsWindowVisible};

use crate::model::{Described, DescribedNode, ElementInfo, PointHit, Rect, Resolved, ScrollIntoView, Suggestion};
use crate::windows::rect_of;

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

/// The control's current value, for inputs, combos and sliders.
fn value_of(el: &UIElement) -> Option<String> {
    let v = el.get_property_value(UIProperty::ValueValue).ok()?;
    let s = v.get_string().ok()?;
    let t = s.trim();
    if t.is_empty() || t.len() > 120 {
        None
    } else {
        Some(t.to_string())
    }
}

fn automation_id_of(el: &UIElement) -> Option<String> {
    let id = el.get_automation_id().ok()?;
    let t = id.trim();
    if t.is_empty() || t.len() > 120 {
        None
    } else {
        Some(t.to_string())
    }
}

fn to_rect(el: &UIElement) -> Option<Rect> {
    let r = el.get_bounding_rectangle().ok()?;
    let (l, t, rr, b) = (r.get_left(), r.get_top(), r.get_right(), r.get_bottom());
    if rr <= l || b <= t {
        return None;
    }
    // Windows parks the controls of a minimised window near -32000. They are
    // real elements with real rects, but pointing at them would draw offscreen.
    if l < -30000 || t < -30000 {
        return None;
    }
    Some(Rect { x: l, y: t, width: rr - l, height: b - t })
}

/// How many element handles to keep alive at once.
///
/// Each cached UIElement is a COM reference that pins memory in the target
/// application's accessibility provider, not just here. The cache used to grow
/// forever: a describe adds up to a thousand, and a fifteen-minute
/// wait_for_element adds a few every poll. Anchors are touched on every tracker
/// tick, so least-recently-used eviction never drops one that is on screen.
const CACHE_LIMIT: usize = 5000;

pub struct Session {
    pub auto: UIAutomation,
    /// Live UIElement handles plus the tick they were last used. Keeping the
    /// objects beats re-resolving by RuntimeId: it is faster and survives
    /// relayout within the same run.
    pub cache: HashMap<String, (UIElement, u64)>,
    pub next: u64,
    pub clock: u64,
}

impl Session {
    /// Cache an element and hand back the ref the client will use for it.
    pub fn remember(&mut self, el: UIElement) -> String {
        self.next += 1;
        self.clock += 1;
        let key = format!("el_{}", self.next);
        self.cache.insert(key.clone(), (el, self.clock));
        if self.cache.len() > CACHE_LIMIT {
            // Evict a quarter at once so the sort runs once per ~1000 inserts
            // rather than on every one.
            let mut ages: Vec<(u64, String)> =
                self.cache.iter().map(|(k, (_, used))| (*used, k.clone())).collect();
            ages.sort_unstable();
            for (_, k) in ages.into_iter().take(CACHE_LIMIT / 4) {
                self.cache.remove(&k);
            }
        }
        key
    }

    pub fn find_elements(
        &mut self,
        window_ref: Option<&str>,
        name: Option<&str>,
        role: Option<&str>,
        automation_id: Option<&str>,
        limit: usize,
        _include_hidden: bool,
    ) -> Result<Vec<ElementInfo>, String> {
        let root = match window_ref {
            Some(w) => {
                let raw: isize = w.parse().map_err(|_| format!("bad window ref '{w}'"))?;
                self.auto
                    .element_from_handle(uiautomation::types::Handle::from(raw))
                    .map_err(|e| format!("no window for ref '{w}': {e}"))?
            }
            None => self.auto.get_root_element().map_err(|e| e.to_string())?,
        };

        // Filter on control type in UIA, then on name in Rust: a substring
        // match is what an agent naturally asks for, and UIA has no "contains"
        // condition. Without a role this must match everything. It used to be
        // IsEnabled=true, which hid disabled controls from every search, so a
        // button greying out counted as "disappears" and a disabled one could
        // never "appear".
        let cond = match role {
            Some(r) => {
                let id = role_id(r)?;
                self.auto
                    .create_property_condition(UIProperty::ControlType, Variant::from(id), None)
                    .map_err(|e| e.to_string())?
            }
            None => self.auto.create_true_condition().map_err(|e| e.to_string())?,
        };

        // find_all walks the entire subtree before returning. Across the whole
        // desktop that is seconds, which makes polling waits useless. When the
        // caller only wants one match, find_first short-circuits on the first
        // hit instead.
        let first_only = limit == 1 && name.is_none() && automation_id.is_none();
        let found: Vec<UIElement> = if first_only {
            match root.find_first(TreeScope::Descendants, &cond) {
                Ok(el) => vec![el],
                Err(_) => Vec::new(),
            }
        } else {
            root.find_all(TreeScope::Descendants, &cond)
                .map_err(|e| format!("search failed: {e}"))?
        };

        let needle = name.map(|n| n.to_ascii_lowercase());
        let mut out = Vec::new();
        for el in found.iter() {
            let el_name = el.get_name().unwrap_or_default();
            let el_auto = automation_id_of(el);

            // An AutomationId match is exact and wins outright; it is what makes
            // a selector survive a relabel or a translated build.
            if let Some(want) = automation_id {
                if el_auto.as_deref() != Some(want) {
                    continue;
                }
            } else if let Some(n) = &needle {
                if !el_name.to_ascii_lowercase().contains(n.as_str()) {
                    continue;
                }
            } else if !first_only && el_name.trim().is_empty() {
                // Unnamed matches are noise in a listing, but find_first
                // returns exactly one element; discarding it would report "no
                // such control" while named ones exist.
                continue;
            }
            let Some(rect) = to_rect(el) else { continue };

            let ctrl = el.get_control_type().map(|c| c as i32).unwrap_or(0);
            let enabled = el.is_enabled().unwrap_or(true);
            out.push(ElementInfo {
                r#ref: self.remember(el.clone()),
                name: el_name,
                role: role_name(ctrl).to_string(),
                automation_id: el_auto,
                rect,
                enabled,
                value: None,
                offscreen: false,
                state: None,
                window: None,
                hidden: None,
                container: None,
            });
            if out.len() >= limit {
                break;
            }
        }
        Ok(out)
    }

    /// Depth-first walk of the control view, bounded so a huge app cannot
    /// produce an unbounded response.
    fn collect(
        &self,
        walker: &uiautomation::UITreeWalker,
        el: &UIElement,
        depth: usize,
        max_depth: usize,
        max_nodes: usize,
        out: &mut Vec<(usize, UIElement)>,
    ) {
        if depth > max_depth || out.len() >= max_nodes {
            return;
        }
        let mut child = walker.get_first_child(el).ok();
        while let Some(c) = child {
            if out.len() >= max_nodes {
                return;
            }
            out.push((depth, c.clone()));
            self.collect(walker, &c, depth + 1, max_depth, max_nodes, out);
            child = walker.get_next_sibling(&c).ok();
        }
    }

    pub fn describe(
        &mut self,
        window_ref: &str,
        max_nodes: usize,
        max_depth: usize,
    ) -> Result<Described, String> {
        let raw: isize = window_ref
            .parse()
            .map_err(|_| format!("bad window ref '{window_ref}'"))?;
        let root = self
            .auto
            .element_from_handle(uiautomation::types::Handle::from(raw))
            .map_err(|e| format!("no window for ref '{window_ref}': {e}"))?;
        let walker = self.auto.get_control_view_walker().map_err(|e| e.to_string())?;

        let mut nodes: Vec<(usize, UIElement)> = vec![(0, root.clone())];
        self.collect(&walker, &root, 1, max_depth, max_nodes, &mut nodes);
        let walked = nodes.len();

        let mut out = Vec::with_capacity(nodes.len());
        for (depth, el) in nodes {
            let Some(rect) = to_rect(&el) else { continue };
            let name = el.get_name().unwrap_or_default();
            let value = value_of(&el);
            // Unnamed, valueless containers are pure structure: they cost tokens
            // and tell the reader nothing. Their children are still walked.
            if depth > 0 && name.trim().is_empty() && value.is_none() {
                continue;
            }
            let ctrl = el.get_control_type().map(|c| c as i32).unwrap_or(0);
            let automation_id = automation_id_of(&el);
            let enabled = el.is_enabled().unwrap_or(true);
            out.push(DescribedNode {
                depth,
                r#ref: self.remember(el),
                name,
                role: role_name(ctrl).to_string(),
                automation_id,
                value,
                enabled,
                rect,
                state: None,
                offscreen: false,
                popup: false,
            });
        }
        // The walk stops at max_nodes raw nodes, unnamed wrappers included,
        // so judge truncation by the walk rather than the filtered rows.
        // TODO(stage 1, search agent): budget only emitted rows and name the
        // subtrees left unvisited.
        Ok(Described { nodes: out, truncated: walked >= max_nodes, unvisited: Vec::new() })
    }

    /// Re-read current rectangles. This is the tracker's hot path, and the
    /// touch here is what keeps on-screen anchors out of cache eviction.
    pub fn resolve(&mut self, refs: &[String]) -> Vec<Resolved> {
        self.clock += 1;
        let now = self.clock;
        refs.iter()
            .map(|r| {
                let rect = if let Some((el, used)) = self.cache.get_mut(r) {
                    *used = now;
                    to_rect(el)
                } else if let Ok(raw) = r.parse::<isize>() {
                    let hwnd = HWND(raw as *mut std::ffi::c_void);
                    if unsafe { IsWindowVisible(hwnd) }.as_bool() && !unsafe { IsIconic(hwnd) }.as_bool() {
                        rect_of(hwnd)
                    } else {
                        None
                    }
                } else {
                    None
                };
                Resolved { r#ref: r.clone(), rect, offscreen: false }
            })
            .collect()
    }

    /// The control under a virtual-screen physical point, and its top-level
    /// window. Elements of `ignore_pid` (the overlay itself) are never returned.
    pub fn element_at_point(&mut self, _x: i32, _y: i32, _ignore_pid: u32) -> Result<PointHit, String> {
        Err("element_at_point is not implemented yet".into())
    }

    /// Bring a control into view with ScrollItemPattern. A view change, like
    /// scroll_window: it moves the content, never the pointer.
    pub fn scroll_into_view(
        &mut self,
        _window_ref: &str,
        _name: Option<&str>,
        _role: Option<&str>,
        _automation_id: Option<&str>,
    ) -> Result<ScrollIntoView, String> {
        Err("scroll_into_view is not implemented yet".into())
    }

    /// Names in the window closest to one that matched nothing.
    pub fn suggest(
        &mut self,
        _window_ref: &str,
        _name: &str,
        _role: Option<&str>,
        _limit: usize,
    ) -> Result<Vec<Suggestion>, String> {
        Err("suggest is not implemented yet".into())
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

