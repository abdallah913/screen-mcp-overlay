//! Reading a control's properties, batched when UI Automation allows it.
//!
//! Every property read is a cross-process call into the target app, and a
//! describe used to make about eight per node. A cache request fetches all of
//! them in the same call that finds or walks to the node. Caching is purely an
//! optimisation: every reader here takes the cached value when one is there and
//! falls back to a live read on any error, so a provider that mishandles cache
//! requests costs speed, never correctness.

use uiautomation::core::UICacheRequest;
use uiautomation::types::{TreeScope, UIProperty};
use uiautomation::variants::Variant;
use uiautomation::{UIAutomation, UIElement};
use windows::Win32::UI::Accessibility::{IUIAutomationElement, UIA_PROPERTY_ID};

use crate::model::Rect;

use super::rank;

/// What a describe reads for every node it walks.
pub const DESCRIBE: &[UIProperty] = &[
    UIProperty::Name,
    UIProperty::ControlType,
    UIProperty::AutomationId,
    UIProperty::BoundingRectangle,
    UIProperty::IsEnabled,
    UIProperty::IsOffscreen,
    UIProperty::ValueValue,
    UIProperty::IsPassword,
    UIProperty::ToggleToggleState,
    UIProperty::SelectionItemIsSelected,
    UIProperty::ExpandCollapseExpandCollapseState,
];

/// What a find reads for every candidate. Not the value: a document's value is
/// its whole text, and a wait polls a find several times a second. The few
/// matches returned read theirs live.
pub const FIND: &[UIProperty] = &[
    UIProperty::Name,
    UIProperty::ControlType,
    UIProperty::AutomationId,
    UIProperty::BoundingRectangle,
    UIProperty::IsEnabled,
    UIProperty::IsOffscreen,
    UIProperty::ToggleToggleState,
    UIProperty::SelectionItemIsSelected,
    UIProperty::ExpandCollapseExpandCollapseState,
];

/// What suggest needs: a name and a role for every control in the window.
pub const NAMES: &[UIProperty] = &[UIProperty::Name, UIProperty::ControlType];

/// What the tracker needs on every tick.
pub const PLACE: &[UIProperty] = &[UIProperty::BoundingRectangle, UIProperty::IsOffscreen];

/// A cache request for the given properties, or None if UI Automation will not
/// build one (then every read is live).
///
/// The tree filter is widened to the raw view: a cached find otherwise searches
/// only the control view, and would quietly match less than the uncached find
/// it replaces.
pub fn request_for(auto: &UIAutomation, props: &[UIProperty]) -> Option<UICacheRequest> {
    let req = auto.create_cache_request().ok()?;
    for p in props {
        req.add_property(*p).ok()?;
    }
    req.set_tree_scope(TreeScope::Element).ok()?;
    req.set_tree_filter(auto.create_true_condition().ok()?).ok()?;
    Some(req)
}

/// Cached when it can be, live otherwise.
fn pick<T>(
    cached: bool,
    from_cache: impl FnOnce() -> uiautomation::Result<T>,
    live: impl FnOnce() -> uiautomation::Result<T>,
) -> Option<T> {
    if cached {
        if let Ok(v) = from_cache() {
            return Some(v);
        }
    }
    live().ok()
}

/// A property that may not apply to this control.
///
/// The plain getters return the property's default when the control lacks the
/// pattern, and some defaults are real states (a ToggleState default would
/// read as a state every button has). Asking UIA to ignore defaults returns a
/// "not supported" marker instead, which no conversion accepts, so it comes out
/// as None. A COM error, by contrast, falls back to the live read.
fn optional(el: &UIElement, p: UIProperty, cached: bool) -> Option<Variant> {
    let raw: &IUIAutomationElement = el.as_ref();
    let id: UIA_PROPERTY_ID = p.into();
    if cached {
        if let Ok(v) = unsafe { raw.GetCachedPropertyValueEx(id, true) } {
            return Some(Variant::from(v));
        }
    }
    unsafe { raw.GetCurrentPropertyValueEx(id, true) }.ok().map(Variant::from)
}

fn int(el: &UIElement, p: UIProperty, cached: bool) -> Option<i32> {
    let v = optional(el, p, cached)?;
    (&v).try_into().ok()
}

fn flag(el: &UIElement, p: UIProperty, cached: bool) -> Option<bool> {
    let v = optional(el, p, cached)?;
    (&v).try_into().ok()
}

fn short(s: String) -> Option<String> {
    let t = s.trim();
    if t.is_empty() || t.len() > 120 {
        None
    } else {
        Some(t.to_string())
    }
}

pub fn name(el: &UIElement, cached: bool) -> String {
    pick(cached, || el.get_cached_name(), || el.get_name()).unwrap_or_default()
}

pub fn control_type(el: &UIElement, cached: bool) -> i32 {
    pick(cached, || el.get_cached_control_type(), || el.get_control_type()).map_or(0, |c| c as i32)
}

pub fn automation_id(el: &UIElement, cached: bool) -> Option<String> {
    short(pick(cached, || el.get_cached_automation_id(), || el.get_automation_id())?)
}

pub fn enabled(el: &UIElement, cached: bool) -> bool {
    pick(cached, || el.is_cached_enabled(), || el.is_enabled()).unwrap_or(true)
}

/// UI Automation's own verdict: scrolled out of its viewport, or collapsed away.
pub fn offscreen(el: &UIElement, cached: bool) -> bool {
    pick(cached, || el.is_cached_offscreen(), || el.is_offscreen()).unwrap_or(false)
}

pub fn rect(el: &UIElement, cached: bool) -> Option<Rect> {
    let r = pick(cached, || el.get_cached_bounding_rectangle(), || el.get_bounding_rectangle())?;
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

/// The control's current value (an edit's text, a combo's choice, a slider's
/// position). Never a password field's: the overlay must not become a way to
/// read one, even though such fields usually refuse anyway.
pub fn value(el: &UIElement, cached: bool) -> Option<String> {
    let v = short(optional(el, UIProperty::ValueValue, cached)?.get_string().ok()?)?;
    if flag(el, UIProperty::IsPassword, cached).unwrap_or(false) {
        return None;
    }
    Some(v)
}

/// The control's state words for its role. Only the properties that role can
/// show are read, which matters on the live path where each is a call.
pub fn state(el: &UIElement, cached: bool, role: &str, focused: bool) -> Option<String> {
    let toggle = rank::wants_toggle(role).then(|| int(el, UIProperty::ToggleToggleState, cached)).flatten();
    let selected =
        rank::wants_selection(role).then(|| flag(el, UIProperty::SelectionItemIsSelected, cached)).flatten();
    let expand = rank::wants_expand(role)
        .then(|| int(el, UIProperty::ExpandCollapseExpandCollapseState, cached))
        .flatten();
    rank::state_words(role, toggle, selected, expand, focused)
}

pub fn expand_state(el: &UIElement, cached: bool) -> Option<i32> {
    int(el, UIProperty::ExpandCollapseExpandCollapseState, cached)
}

pub fn selected(el: &UIElement, cached: bool) -> Option<bool> {
    flag(el, UIProperty::SelectionItemIsSelected, cached)
}

/// The focused control, read once per query rather than once per node.
///
/// Identified by name, role and rect instead of comparing elements, which
/// would be a cross-process call for every row.
pub struct Focus(Option<(String, i32, Rect)>);

impl Focus {
    pub fn now(auto: &UIAutomation) -> Focus {
        // Not the value: the focused control is often a document, whose value
        // is its whole text.
        let req = request_for(auto, &[UIProperty::Name, UIProperty::ControlType, UIProperty::BoundingRectangle]);
        let (el, cached) = match req.and_then(|r| auto.get_focused_element_build_cache(&r).ok()) {
            Some(el) => (el, true),
            None => match auto.get_focused_element() {
                Ok(el) => (el, false),
                Err(_) => return Focus(None),
            },
        };
        Focus(rect(&el, cached).map(|r| (name(&el, cached), control_type(&el, cached), r)))
    }

    pub fn is(&self, name: &str, ctrl: i32, rect: &Rect) -> bool {
        self.0.as_ref().is_some_and(|(n, c, r)| n == name && *c == ctrl && r == rect)
    }
}
