//! Window and UI Automation queries for Screen MCP Overlay.
//!
//! Speaks JSON-lines on stdin/stdout so the Electron main process can keep one
//! long-lived instance: `{"id":1,"op":"list_windows"}` in, `{"id":1,"ok":true,
//! "result":...}` out. A persistent process matters because the annotation
//! tracker re-reads anchor rectangles several times a second, and spawning a
//! process per query would cost more than the query.
//!
//! Every rectangle returned is in **physical pixels** in Windows' virtual-screen
//! space, which can have negative origins on multi-monitor setups. That only
//! holds because of the DPI-awareness call in `main`; without it Windows hands
//! back DPI-virtualised coordinates and every rect is silently wrong on a scaled
//! display.

mod ocr;
mod winops;

use std::collections::HashMap;
use std::io::{BufRead, Write};

use serde::{Deserialize, Serialize};
use uiautomation::types::{TreeScope, UIProperty};
use uiautomation::variants::Variant;
use uiautomation::{UIAutomation, UIElement};

use windows::core::BOOL;
use windows::Win32::Foundation::{HWND, LPARAM, RECT, TRUE};
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS};
use windows::Win32::UI::HiDpi::{SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetForegroundWindow, GetWindowLongW, GetWindowRect, GetWindowTextLengthW, GetWindowTextW,
    GetWindowThreadProcessId, IsIconic, IsWindowVisible, GWL_EXSTYLE, WS_EX_TOOLWINDOW,
};

// ---------------------------------------------------------------- protocol

#[derive(Deserialize)]
struct Request {
    id: u64,
    op: String,
    #[serde(default)]
    window: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    role: Option<String>,
    #[serde(default)]
    limit: Option<usize>,
    #[serde(default)]
    refs: Option<Vec<String>>,
    #[serde(default)]
    max_nodes: Option<usize>,
    #[serde(default)]
    max_depth: Option<usize>,
    #[serde(default)]
    automation_id: Option<String>,
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    notches: Option<i32>,
    #[serde(default)]
    ignore_pid: Option<u32>,
}

#[derive(Serialize)]
struct Response<T: Serialize> {
    id: u64,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<T>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Serialize, Clone, Copy)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

#[derive(Serialize)]
struct WindowInfo {
    /// Stringified HWND. Stable while the window lives.
    r#ref: String,
    title: String,
    class: String,
    pid: u32,
    rect: Rect,
    foreground: bool,
    minimized: bool,
}

#[derive(Serialize)]
struct ElementInfo {
    /// Handle into this process's element cache, valid for the session.
    r#ref: String,
    name: String,
    role: String,
    /// The app's own stable id for this control, when it sets one. Immune to
    /// localisation and label changes, so it makes a selector exact.
    #[serde(skip_serializing_if = "Option::is_none")]
    automation_id: Option<String>,
    rect: Rect,
    enabled: bool,
}

#[derive(Serialize)]
struct DescribedNode {
    depth: usize,
    r#ref: String,
    name: String,
    role: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    automation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    value: Option<String>,
    enabled: bool,
    rect: Rect,
}

#[derive(Serialize)]
struct Resolved {
    r#ref: String,
    /// null when the window or control has gone away.
    rect: Option<Rect>,
}

// ------------------------------------------------------------------ win32

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

fn class_of(hwnd: HWND) -> String {
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
    });
    TRUE
}

fn list_windows() -> Vec<WindowInfo> {
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

// -------------------------------------------------------------------- uia

/// Control types worth naming. UIA exposes far more; these are the ones an
/// agent would plausibly ask to point at.
fn role_id(role: &str) -> Option<i32> {
    Some(match role.to_ascii_lowercase().as_str() {
        "button" => 50000,
        "checkbox" => 50002,
        "combobox" => 50003,
        "edit" | "textbox" | "input" => 50004,
        "hyperlink" | "link" => 50005,
        "image" => 50006,
        "listitem" => 50007,
        "list" => 50008,
        "menuitem" => 50011,
        "radiobutton" => 50013,
        "tab" => 50018,
        "tabitem" => 50019,
        "text" | "label" => 50020,
        "toolbar" => 50021,
        "tree" => 50023,
        "treeitem" => 50024,
        "group" => 50026,
        "document" => 50030,
        "pane" => 50033,
        "window" => 50032,
        _ => return None,
    })
}

fn role_name(id: i32) -> &'static str {
    match id {
        50000 => "button",
        50002 => "checkbox",
        50003 => "combobox",
        50004 => "edit",
        50005 => "link",
        50006 => "image",
        50007 => "listitem",
        50008 => "list",
        50011 => "menuitem",
        50013 => "radiobutton",
        50018 => "tab",
        50019 => "tabitem",
        50020 => "text",
        50021 => "toolbar",
        50023 => "tree",
        50024 => "treeitem",
        50026 => "group",
        50030 => "document",
        50032 => "window",
        50033 => "pane",
        _ => "other",
    }
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

struct Session {
    auto: UIAutomation,
    /// Live UIElement handles. Keeping the objects beats re-resolving by
    /// RuntimeId: it is faster and survives relayout within the same run.
    cache: HashMap<String, UIElement>,
    next: u64,
}

impl Session {
    fn find_elements(
        &mut self,
        window_ref: Option<&str>,
        name: Option<&str>,
        role: Option<&str>,
        automation_id: Option<&str>,
        limit: usize,
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

        // Search on the cheapest available property, then filter in Rust. A
        // substring match is what an agent naturally asks for, and UIA has no
        // "contains" condition.
        let cond = match role.and_then(role_id) {
            Some(id) => self
                .auto
                .create_property_condition(UIProperty::ControlType, Variant::from(id), None)
                .map_err(|e| e.to_string())?,
            None => self
                .auto
                .create_property_condition(UIProperty::IsEnabled, Variant::from(true), None)
                .map_err(|e| e.to_string())?,
        };

        // find_all walks the entire subtree before returning. Across the whole
        // desktop that is seconds, which makes polling waits useless. When the
        // caller only wants one match, find_first short-circuits on the first
        // hit instead.
        let found: Vec<UIElement> = if limit == 1 && name.is_none() && automation_id.is_none() {
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
            } else if el_name.trim().is_empty() {
                continue;
            }
            let Some(rect) = to_rect(el) else { continue };

            self.next += 1;
            let key = format!("el_{}", self.next);
            let ctrl = el.get_control_type().map(|c| c as i32).unwrap_or(0);
            out.push(ElementInfo {
                r#ref: key.clone(),
                name: el_name,
                role: role_name(ctrl).to_string(),
                automation_id: el_auto,
                rect,
                enabled: el.is_enabled().unwrap_or(true),
            });
            self.cache.insert(key, el.clone());
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

    fn describe(
        &mut self,
        window_ref: &str,
        max_nodes: usize,
        max_depth: usize,
    ) -> Result<Vec<DescribedNode>, String> {
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
            self.next += 1;
            let key = format!("el_{}", self.next);
            let ctrl = el.get_control_type().map(|c| c as i32).unwrap_or(0);
            out.push(DescribedNode {
                depth,
                r#ref: key.clone(),
                name,
                role: role_name(ctrl).to_string(),
                automation_id: automation_id_of(&el),
                value,
                enabled: el.is_enabled().unwrap_or(true),
                rect,
            });
            self.cache.insert(key, el);
        }
        Ok(out)
    }

    /// Re-read current rectangles. This is the tracker's hot path.
    fn resolve(&self, refs: &[String]) -> Vec<Resolved> {
        refs.iter()
            .map(|r| {
                let rect = if let Some(el) = self.cache.get(r) {
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
                Resolved { r#ref: r.clone(), rect }
            })
            .collect()
    }
}

// ------------------------------------------------------------------- main

fn parse_hwnd(raw: Option<&str>) -> Result<HWND, String> {
    let s = raw.ok_or("this operation needs a window ref")?;
    let n: isize = s.parse().map_err(|_| format!("bad window ref '{s}'"))?;
    Ok(HWND(n as *mut std::ffi::c_void))
}

fn reply<T: Serialize>(id: u64, result: Result<T, String>) {
    let line = match result {
        Ok(r) => serde_json::to_string(&Response { id, ok: true, result: Some(r), error: None }),
        Err(e) => serde_json::to_string(&Response::<T> { id, ok: false, result: None, error: Some(e) }),
    };
    if let Ok(l) = line {
        let stdout = std::io::stdout();
        let mut lock = stdout.lock();
        let _ = writeln!(lock, "{l}");
        let _ = lock.flush();
    }
}

fn main() {
    // Must come before any UIA or window call: without it Windows reports
    // DPI-virtualised coordinates and every rectangle is wrong on a scaled display.
    unsafe {
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }

    let auto = match UIAutomation::new() {
        Ok(a) => a,
        Err(e) => {
            reply::<()>(0, Err(format!("could not start UI Automation: {e}")));
            std::process::exit(1);
        }
    };
    let mut session = Session { auto, cache: HashMap::new(), next: 0 };

    reply(0, Ok(serde_json::json!({ "ready": true, "version": env!("CARGO_PKG_VERSION") })));

    let stdin = std::io::stdin();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let req: Request = match serde_json::from_str(&line) {
            Ok(r) => r,
            Err(e) => {
                reply::<()>(0, Err(format!("bad request: {e}")));
                continue;
            }
        };

        match req.op.as_str() {
            "list_windows" => reply(req.id, Ok(list_windows())),
            "find_elements" => {
                let r = session.find_elements(
                    req.window.as_deref(),
                    req.name.as_deref(),
                    req.role.as_deref(),
                    req.automation_id.as_deref(),
                    req.limit.unwrap_or(25).clamp(1, 200),
                );
                reply(req.id, r);
            }
            "resolve" => {
                let refs = req.refs.unwrap_or_default();
                reply(req.id, Ok(session.resolve(&refs)));
            }
            "describe" => {
                let Some(w) = req.window.as_deref() else {
                    reply::<()>(req.id, Err("describe needs a window ref".into()));
                    continue;
                };
                let r = session.describe(
                    w,
                    req.max_nodes.unwrap_or(120).clamp(1, 1000),
                    // Chromium apps bury their content ~19 levels down; a shallow
                    // default silently returns only the window chrome.
                    req.max_depth.unwrap_or(25).clamp(1, 40),
                );
                reply(req.id, r);
            }
            "focus_window" => match parse_hwnd(req.window.as_deref()) {
                Ok(h) => reply(req.id, winops::focus(h).map(|_| serde_json::json!({ "focused": true }))),
                Err(e) => reply::<()>(req.id, Err(e)),
            },
            "occlusion" => match parse_hwnd(req.window.as_deref()) {
                Ok(h) => reply(req.id, Ok(winops::occlusion_of(h, req.ignore_pid.unwrap_or(0)))),
                Err(e) => reply::<()>(req.id, Err(e)),
            },
            "print_window" => {
                let target = parse_hwnd(req.window.as_deref());
                match (target, req.path.as_deref()) {
                    (Ok(h), Some(p)) => reply(
                        req.id,
                        winops::print_window_png(h, p),
                    ),
                    (Err(e), _) => reply::<()>(req.id, Err(e)),
                    (_, None) => reply::<()>(req.id, Err("print_window needs a path".into())),
                }
            }
            "scroll_window" => match parse_hwnd(req.window.as_deref()) {
                Ok(h) => reply(
                    req.id,
                    winops::scroll(h, req.notches.unwrap_or(-3))
                        .map(|_| serde_json::json!({ "scrolled": true })),
                ),
                Err(e) => reply::<()>(req.id, Err(e)),
            },
            "ocr" => match req.path.as_deref() {
                Some(p) => reply(req.id, ocr::recognise(p)),
                None => reply::<()>(req.id, Err("ocr needs an image path".into())),
            },
            "ping" => reply(req.id, Ok(serde_json::json!({ "pong": true }))),
            other => reply::<()>(req.id, Err(format!("unknown op '{other}'"))),
        }
    }
}
