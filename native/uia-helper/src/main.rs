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

mod model;
mod ocr;
mod search;
mod windows;
mod winops;

use std::collections::HashMap;
use std::io::{BufRead, Write};

use serde::{Deserialize, Serialize};
use uiautomation::UIAutomation;
use ::windows::core::Interface;
use ::windows::Win32::Foundation::HWND;
use ::windows::Win32::UI::Accessibility::{IUIAutomation, IUIAutomation2};
use ::windows::Win32::UI::HiDpi::{SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2};

use model::Rect;
use search::Session;

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
    /// element_at_point: virtual-screen physical coordinates.
    #[serde(default)]
    x: Option<i32>,
    #[serde(default)]
    y: Option<i32>,
    /// covered: the area to test, virtual-screen physical.
    #[serde(default)]
    rect: Option<Rect>,
    /// find_elements: also return matches that have no usable rect, marked
    /// with why (collapsed container, unselected tab) and what contains them.
    #[serde(default)]
    include_hidden: bool,
    /// covered: a window of ignore_pid that still counts as covering (the
    /// chat panel, which the user can see; the overlay itself never covers).
    #[serde(default)]
    hud: Option<String>,
    /// describe: do not read focus at all, so no row is marked focused or
    /// kept for being (or holding) the focused control. A 'changes' wait
    /// compares describes, and focus moving alone must not read as a change.
    #[serde(default)]
    ignore_focus: bool,
    /// covered: the target is a list, tree or menu row, which an open
    /// dropdown draws in its own popup even when the app reports the row in
    /// its main window's tree.
    #[serde(default)]
    row: bool,
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
    // UI Automation waits on the target app for every cross-process call. A
    // hung app would otherwise block this single-threaded helper, and with it
    // the anchor tracker, for as long as the app stays hung. Bounded timeouts
    // turn that into a failed call. Older systems without IUIAutomation2 keep
    // the defaults.
    if let Ok(auto2) = AsRef::<IUIAutomation>::as_ref(&auto).cast::<IUIAutomation2>() {
        unsafe {
            let _ = auto2.SetConnectionTimeout(1000);
            let _ = auto2.SetTransactionTimeout(4000);
        }
    }

    let mut session = Session { auto, cache: HashMap::new(), next: 0, clock: 0 };
    let ignore_pid = |req: &Request| req.ignore_pid.unwrap_or(0);

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
            "list_windows" => reply(req.id, Ok(windows::list_windows())),
            "find_elements" => {
                let r = session.find_elements(
                    req.window.as_deref(),
                    req.name.as_deref(),
                    req.role.as_deref(),
                    req.automation_id.as_deref(),
                    req.limit.unwrap_or(25).clamp(1, 200),
                    req.include_hidden,
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
                    req.ignore_focus,
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
                Ok(h) => reply(req.id, session.scroll_window(h, req.notches.unwrap_or(-3))),
                Err(e) => reply::<()>(req.id, Err(e)),
            },
            "ocr" => match req.path.as_deref() {
                Some(p) => reply(req.id, ocr::recognise(p)),
                None => reply::<()>(req.id, Err("ocr needs an image path".into())),
            },
            "element_at_point" => match (req.x, req.y) {
                (Some(x), Some(y)) => reply(req.id, session.element_at_point(x, y, ignore_pid(&req))),
                _ => reply::<()>(req.id, Err("element_at_point needs x and y".into())),
            },
            "covered" => match parse_hwnd(req.window.as_deref()) {
                Ok(h) => {
                    let hud = req.hud.as_deref().and_then(|r| parse_hwnd(Some(r)).ok());
                    reply(req.id, winops::covered(h, req.rect, ignore_pid(&req), hud, req.row))
                }
                Err(e) => reply::<()>(req.id, Err(e)),
            },
            "collapsed" => match req.window.as_deref() {
                Some(w) => reply(req.id, session.collapsed(w, req.limit.unwrap_or(8).clamp(1, 20))),
                None => reply::<()>(req.id, Err("collapsed needs a window ref".into())),
            },
            "scroll_into_view" => match req.window.as_deref() {
                Some(w) => reply(
                    req.id,
                    session.scroll_into_view(w, req.name.as_deref(), req.role.as_deref(), req.automation_id.as_deref()),
                ),
                None => reply::<()>(req.id, Err("scroll_into_view needs a window ref".into())),
            },
            "suggest" => match (req.window.as_deref(), req.name.as_deref()) {
                (Some(w), Some(n)) => reply(
                    req.id,
                    session.suggest(w, n, req.role.as_deref(), req.limit.unwrap_or(3).clamp(1, 10)),
                ),
                _ => reply::<()>(req.id, Err("suggest needs a window ref and a name".into())),
            },
            "ping" => reply(req.id, Ok(serde_json::json!({ "pong": true }))),
            other => reply::<()>(req.id, Err(format!("unknown op '{other}'"))),
        }
    }
}

