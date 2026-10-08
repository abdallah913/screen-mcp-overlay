//! The wire contract: every shape that crosses stdout as JSON.
//!
//! Field additions here are protocol changes, so they are made deliberately and
//! mirrored in src/main/uia.ts. Optional fields are skipped when absent, which
//! keeps responses short and lets older clients ignore them.

use serde::{Deserialize, Serialize};

/// Physical pixels in Windows' virtual-screen space (origin may be negative).
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

#[derive(Serialize)]
pub struct WindowInfo {
    /// Stringified HWND. Stable while the window lives.
    pub r#ref: String,
    pub title: String,
    pub class: String,
    pub pid: u32,
    pub rect: Rect,
    pub foreground: bool,
    pub minimized: bool,
    /// On another virtual desktop (or a suspended UWP frame): visible to
    /// Windows, invisible to the user.
    pub cloaked: bool,
    /// Runs at a higher integrity level than the helper, so UIPI blocks UI
    /// Automation and window messages. Also true when the process cannot even
    /// be opened to ask.
    pub elevated: bool,
    /// Not responding (IsHungAppWindow).
    pub hung: bool,
}

/// The control that contains a hidden match: what must be opened first.
#[derive(Serialize, Clone)]
pub struct ContainerInfo {
    pub r#ref: String,
    pub name: String,
    pub role: String,
}

#[derive(Serialize)]
pub struct ElementInfo {
    /// Handle into this process's element cache, valid for the session.
    pub r#ref: String,
    pub name: String,
    pub role: String,
    /// The app's own stable id for this control, when it sets one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub automation_id: Option<String>,
    pub rect: Rect,
    pub enabled: bool,
    /// The control's value (an edit's text, a slider's position), never for
    /// password fields.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    /// Scrolled out of its viewport or outside its window: the rect is real
    /// but drawing there would point at something else.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub offscreen: bool,
    /// Comma-joined state words when the control has any: checked, unchecked,
    /// mixed, selected, expanded, collapsed, focused.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
    /// Set when the match lives in a popup (menu, dropdown, flyout) of the
    /// searched window's process rather than inside the window itself: the
    /// popup's own top-level ref.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window: Option<String>,
    /// Only with include_hidden: why this match has no usable rect.
    /// "collapsed" (inside a collapsed menu, combo box or tree node),
    /// "unselected-tab", or "no-rect".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hidden: Option<String>,
    /// Only with include_hidden: what to open to reveal it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub container: Option<ContainerInfo>,
}

#[derive(Serialize)]
pub struct DescribedNode {
    pub depth: usize,
    pub r#ref: String,
    pub name: String,
    pub role: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub automation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    pub enabled: bool,
    pub rect: Rect,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub offscreen: bool,
    /// Top node of a same-process popup subtree (an open menu or dropdown),
    /// listed under the window it belongs to.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub popup: bool,
}

/// A describe result. `truncated` is true when the node budget ran out before
/// the walk finished; `unvisited` names the first subtrees it never reached.
#[derive(Serialize)]
pub struct Described {
    pub nodes: Vec<DescribedNode>,
    pub truncated: bool,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub unvisited: Vec<String>,
}

#[derive(Serialize)]
pub struct Resolved {
    pub r#ref: String,
    /// null when the window or control has gone away.
    pub rect: Option<Rect>,
    /// Why rect is null: "minimized", "closed", "other-desktop" or "gone".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub offscreen: bool,
}

#[derive(Serialize)]
pub struct WindowRef {
    pub r#ref: String,
    pub title: String,
}

/// What is under a screen point: the control and its top-level window.
#[derive(Serialize)]
pub struct PointHit {
    pub element: Option<ElementInfo>,
    pub window: Option<WindowRef>,
}

/// How much of a rect is hidden behind other top-level windows.
#[derive(Serialize)]
pub struct Coverage {
    /// Fraction of sample points whose top-level window is not the target, 0..1.
    pub fraction: f32,
    pub centre_covered: bool,
    /// Titles of the covering windows, nearest first.
    pub by: Vec<String>,
}

#[derive(Serialize)]
pub struct PrintResult {
    pub rect: Rect,
    /// PrintWindow refused and the pixels came from the screen instead, so
    /// anything covering the window is in the image.
    pub fallback: bool,
}

#[derive(Serialize)]
pub struct ScrollIntoView {
    pub scrolled: bool,
    pub element: ElementInfo,
}

/// A near miss for a name that matched nothing.
#[derive(Serialize)]
pub struct Suggestion {
    pub name: String,
    pub role: String,
}

/// What a wheel scroll did, read from the nearest ScrollPattern before and
/// after: percentages 0..100, None when nothing there reports one.
#[derive(Serialize)]
pub struct Scrolled {
    pub scrolled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub before: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub after: Option<f64>,
}
