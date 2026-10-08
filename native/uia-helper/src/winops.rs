//! Window operations: focus, occlusion, true window capture and scrolling.
//!
//! These exist because cropping a screen grab to a window's rectangle captures
//! whatever is *rendered* there, which is the topmost window, not necessarily
//! the one that was asked for. Returning another application's pixels under the
//! requested window's name is the worst kind of wrong: it looks right, so an
//! agent annotates over it confidently.
//!
//! The helper serves every request on one thread, so nothing here may wait on
//! the target app without a bound: a hung window gets a clear error, never a
//! call that blocks until it recovers.

use serde::Serialize;
use windows::Win32::Foundation::{GetLastError, SetLastError, ERROR_ACCESS_DENIED, ERROR_TIMEOUT, HWND, LPARAM, POINT, RECT, WIN32_ERROR, WPARAM};
use windows::Win32::Graphics::Gdi::{
    BitBlt, ClientToScreen, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits,
    MonitorFromPoint, ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HBITMAP, HDC,
    HGDIOBJ, MONITOR_DEFAULTTONULL, SRCCOPY,
};
// PrintWindow lives under Storage::Xps, and AttachThreadInput under
// System::Threading, rather than where their use would suggest.
use windows::Win32::Storage::Xps::{PrintWindow, PRINT_WINDOW_FLAGS};
use windows::Win32::System::Threading::AttachThreadInput;
use windows::Win32::UI::Input::KeyboardAndMouse::{SetActiveWindow, SetFocus};
use windows::Win32::UI::WindowsAndMessaging::{
    BringWindowToTop, GetAncestor, GetClientRect, GetDesktopWindow, GetForegroundWindow, GetShellWindow, GetWindow,
    GetWindowLongW, GetWindowRect, GetWindowThreadProcessId, IsIconic, IsWindow, IsWindowVisible, SendMessageTimeoutW,
    SetForegroundWindow, ShowWindow, WindowFromPoint, GA_ROOT, GA_ROOTOWNER, GWL_EXSTYLE, GW_HWNDNEXT, GW_HWNDPREV,
    SMTO_ABORTIFHUNG, SW_RESTORE, WM_MOUSEWHEEL, WM_NULL, WS_EX_TOOLWINDOW, WS_EX_TRANSPARENT,
};

use crate::model::{Coverage, PrintResult, Rect};
use crate::search::popups::{is_popup, popups_of};
use crate::windows::{class_of, is_cloaked, is_elevated, is_hung, rect_of, title_of};

/// PW_RENDERFULLCONTENT: renders DirectComposition surfaces too, which is what
/// makes this work for Chromium and other GPU-composited apps.
const PW_RENDERFULLCONTENT: PRINT_WINDOW_FLAGS = PRINT_WINDOW_FLAGS(2);

/// How long a window gets to answer a message before it counts as not
/// responding. Long enough for a busy app, short enough that a request queued
/// behind it in the helper does not time out too.
const MESSAGE_TIMEOUT_MS: u32 = 1000;

const NOT_RESPONDING: &str = "that window is not responding, so Windows cannot reach it until the app recovers. \
     Wait for it, or ask the user whether it has frozen";
const CLOSED: &str = "that window has closed";

#[derive(Serialize)]
pub struct Occlusion {
    /// Rough fraction of the window covered by windows above it, 0.0 to 1.0.
    pub covered: f32,
    /// Titles of the windows sitting on top, nearest first.
    pub by: Vec<String>,
}

fn intersect(a: &Rect, b: &Rect) -> i64 {
    let x = (a.x + a.width).min(b.x + b.width) - a.x.max(b.x);
    let y = (a.y + a.height).min(b.y + b.height) - a.y.max(b.y);
    if x <= 0 || y <= 0 {
        0
    } else {
        x as i64 * y as i64
    }
}

fn pid_of(hwnd: HWND) -> u32 {
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
    pid
}

fn exists(hwnd: HWND) -> bool {
    unsafe { IsWindow(Some(hwnd)) }.as_bool()
}

/// How much of `hwnd` is hidden behind windows above it in the Z order.
///
/// Approximate on purpose: overlapping occluders are summed rather than unioned,
/// so the figure can overshoot. It is a "do not trust this capture" signal, not
/// a measurement.
pub fn occlusion_of(hwnd: HWND, ignore_pid: u32) -> Occlusion {
    let Some(target) = rect_of(hwnd) else {
        return Occlusion { covered: 0.0, by: Vec::new() };
    };
    let area = (target.width as i64 * target.height as i64).max(1);

    let mut covered = 0i64;
    let mut by = Vec::new();
    // GW_HWNDPREV walks towards the front of the Z order.
    let mut above = unsafe { GetWindow(hwnd, GW_HWNDPREV) }.unwrap_or_default();

    while !above.is_invalid() {
        let visible = unsafe { IsWindowVisible(above) }.as_bool();
        let tool = unsafe { GetWindowLongW(above, GWL_EXSTYLE) } as u32 & WS_EX_TOOLWINDOW.0 != 0;
        // The overlay's own windows cover the whole screen and are click-through
        // and excluded from capture, so counting them would report every window
        // as fully occluded, always.
        let ours = ignore_pid != 0 && pid_of(above) == ignore_pid;
        if visible && !tool && !ours && !is_cloaked(above) && !unsafe { IsIconic(above) }.as_bool() {
            if let Some(r) = rect_of(above) {
                let overlap = intersect(&target, &r);
                if overlap > area / 100 {
                    covered += overlap;
                    by.push(title_of(above));
                }
            }
        }
        above = unsafe { GetWindow(above, GW_HWNDPREV) }.unwrap_or_default();
    }

    Occlusion { covered: (covered as f64 / area as f64).min(1.0) as f32, by }
}

// ------------------------------------------------------------- messages

/// How a SendMessageTimeoutW call ended.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Delivery {
    Delivered,
    /// UIPI: the window runs at a higher integrity level than we do.
    Blocked,
    /// The window did not answer in time, or Windows already knew it was hung.
    NotResponding,
    Failed(u32),
}

/// SendMessageTimeoutW returns 0 on any failure and leaves the reason in the
/// last error: ERROR_ACCESS_DENIED is UIPI, ERROR_TIMEOUT a window that did
/// not answer (SMTO_ABORTIFHUNG reports a known-hung window the same way).
fn delivery(returned: isize, last_error: u32) -> Delivery {
    if returned != 0 {
        Delivery::Delivered
    } else if last_error == ERROR_ACCESS_DENIED.0 {
        Delivery::Blocked
    } else if last_error == ERROR_TIMEOUT.0 {
        Delivery::NotResponding
    } else {
        Delivery::Failed(last_error)
    }
}

fn send_bounded(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> Delivery {
    let mut answer = 0usize;
    unsafe {
        // Cleared first: a success leaves the last error alone, so a stale code
        // from an earlier call would read as this call's failure.
        SetLastError(WIN32_ERROR(0));
        let returned =
            SendMessageTimeoutW(hwnd, msg, wparam, lparam, SMTO_ABORTIFHUNG, MESSAGE_TIMEOUT_MS, Some(&mut answer));
        delivery(returned.0, GetLastError().0)
    }
}

/// Whether the window's thread answers at all. IsHungAppWindow only trips after
/// 5 s of silence, so a window that froze a moment ago is caught by a WM_NULL
/// round trip instead. A UIPI refusal says nothing about responsiveness.
pub fn responds(hwnd: HWND) -> bool {
    !is_hung(hwnd) && send_bounded(hwnd, WM_NULL, WPARAM(0), LPARAM(0)) != Delivery::NotResponding
}

// ----------------------------------------------------------------- focus

/// Bring a window to the front and give it focus.
///
/// Windows refuses SetForegroundWindow from a process that does not already own
/// the foreground, to stop applications stealing focus. Attaching to the current
/// foreground thread's input queue first is the documented way round it, and is
/// what every window-manager utility does.
pub fn focus(hwnd: HWND) -> Result<(), String> {
    if !exists(hwnd) {
        return Err(CLOSED.into());
    }
    if !unsafe { IsWindowVisible(hwnd) }.as_bool() {
        return Err("that window is not visible".into());
    }
    // Restoring and attaching input to a hung thread would block this helper
    // for as long as the app stays frozen.
    if !responds(hwnd) {
        return Err(NOT_RESPONDING.into());
    }
    unsafe {
        if IsIconic(hwnd).as_bool() {
            let _ = ShowWindow(hwnd, SW_RESTORE);
        }

        let foreground = GetForegroundWindow();
        let mut target_pid = 0u32;
        let target_thread = GetWindowThreadProcessId(hwnd, Some(&mut target_pid));
        let fg_thread = if foreground.is_invalid() {
            0
        } else {
            GetWindowThreadProcessId(foreground, None)
        };

        let attached = fg_thread != 0 && fg_thread != target_thread;
        if attached {
            let _ = AttachThreadInput(fg_thread, target_thread, true);
        }

        let _ = BringWindowToTop(hwnd);
        let ok = SetForegroundWindow(hwnd).as_bool();
        let _ = SetActiveWindow(hwnd);
        let _ = SetFocus(Some(hwnd));

        if attached {
            let _ = AttachThreadInput(fg_thread, target_thread, false);
        }

        if !ok && GetForegroundWindow() != hwnd {
            // UIPI also stops the input-queue attach that makes the change
            // possible, so for an elevated window that is the real reason.
            if is_elevated(target_pid) {
                return Err(
                    "Windows refused the focus change: that window runs as administrator (elevated or \
                     protected), so Windows blocks this app from bringing it forward. Ask the user to click \
                     the window instead."
                        .into(),
                );
            }
            return Err(
                "Windows refused the focus change. This happens when the foreground application \
                 is locking focus, or during a drag. Ask the user to click the window instead."
                    .into(),
            );
        }
    }
    Ok(())
}

// --------------------------------------------------------------- capture

/// A memory bitmap selected into a DC, released on every exit path.
struct Canvas {
    screen: HDC,
    mem: HDC,
    bitmap: HBITMAP,
    old: HGDIOBJ,
    width: i32,
    height: i32,
}

impl Canvas {
    fn new(width: i32, height: i32) -> Result<Canvas, String> {
        unsafe {
            let screen = GetDC(None);
            if screen.is_invalid() {
                return Err("could not obtain a device context".into());
            }
            let mem = CreateCompatibleDC(Some(screen));
            let bitmap = CreateCompatibleBitmap(screen, width, height);
            let old = SelectObject(mem, bitmap.into());
            Ok(Canvas { screen, mem, bitmap, old, width, height })
        }
    }

    /// Copy what is on screen at `origin`: whatever is rendered there, which is
    /// the target window only when nothing covers it.
    fn copy_screen(&self, origin: (i32, i32)) {
        unsafe {
            let _ = BitBlt(self.mem, 0, 0, self.width, self.height, Some(self.screen), origin.0, origin.1, SRCCOPY);
        }
    }

    /// The bitmap as top-down BGRA rows.
    fn pixels(&self) -> Result<Vec<u8>, String> {
        let mut info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: self.width,
                // Negative height gives a top-down image, matching PNG order.
                biHeight: -self.height,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut buf = vec![0u8; (self.width as usize) * (self.height as usize) * 4];
        // GetDIBits wants the bitmap deselected, so swap the original back in
        // for the read and reselect ours afterwards for a possible second pass.
        let copied = unsafe {
            SelectObject(self.mem, self.old);
            let n = GetDIBits(
                self.mem,
                self.bitmap,
                0,
                self.height as u32,
                Some(buf.as_mut_ptr() as *mut _),
                &mut info,
                DIB_RGB_COLORS,
            );
            SelectObject(self.mem, self.bitmap.into());
            n
        };
        if copied == 0 {
            return Err("could not read the window bitmap".into());
        }
        Ok(buf)
    }
}

impl Drop for Canvas {
    fn drop(&mut self) {
        unsafe {
            SelectObject(self.mem, self.old);
            let _ = DeleteObject(self.bitmap.into());
            let _ = DeleteDC(self.mem);
            ReleaseDC(None, self.screen);
        }
    }
}

/// Channel tolerance for "the same colour": GPU surfaces that PrintWindow
/// cannot read come back exactly black, but dithering and colour management
/// can move an otherwise flat fill by a step or two.
const UNIFORM_TOLERANCE: u8 = 4;

/// Whether every pixel of `region` (x, y, width, height in image pixels) in a
/// BGRA image is the same colour, give or take the tolerance. That is what a
/// DirectX or GPU surface looks like when PrintWindow could not read it: the
/// frame may render, but the content is one flat colour, usually black. Alpha
/// is ignored because GDI leaves it unreliable. An empty region checks the
/// whole image.
fn looks_blank(bgra: &[u8], width: usize, height: usize, region: (usize, usize, usize, usize)) -> bool {
    let (mut rx, mut ry, mut rw, mut rh) = region;
    if rw == 0 || rh == 0 || rx >= width || ry >= height {
        (rx, ry, rw, rh) = (0, 0, width, height);
    }
    let rw = rw.min(width - rx);
    let rh = rh.min(height - ry);
    if rw == 0 || rh == 0 || bgra.len() < width * height * 4 {
        return false;
    }
    let first = &bgra[(ry * width + rx) * 4..(ry * width + rx) * 4 + 3];
    (ry..ry + rh).all(|y| {
        let row = &bgra[(y * width + rx) * 4..(y * width + rx + rw) * 4];
        row.chunks_exact(4)
            .all(|px| px[..3].iter().zip(first).all(|(a, b)| a.abs_diff(*b) <= UNIFORM_TOLERANCE))
    })
}

/// The client area's position inside the raw window rectangle, in image pixels.
/// The frame and title bar usually render even when the content does not, so
/// the blank check looks at the content alone.
fn client_region(hwnd: HWND, raw: &RECT) -> (usize, usize, usize, usize) {
    let mut client = RECT::default();
    let mut origin = POINT::default();
    unsafe {
        if GetClientRect(hwnd, &mut client).is_err() || !ClientToScreen(hwnd, &mut origin).as_bool() {
            return (0, 0, 0, 0);
        }
    }
    let x = (origin.x - raw.left).max(0) as usize;
    let y = (origin.y - raw.top).max(0) as usize;
    (x, y, client.right.max(0) as usize, client.bottom.max(0) as usize)
}

/// Capture a window's own pixels, even when something is covering it.
///
/// PrintWindow asks the window to render itself into a bitmap, so the result is
/// the window's content rather than whatever happens to be on screen at those
/// coordinates. When it cannot (the window refuses, is hung, or hands back a
/// blank GPU surface) the screen is copied instead and `fallback` says so,
/// because then anything covering the window is in the image.
pub fn print_window_png(hwnd: HWND, path: &str) -> Result<PrintResult, String> {
    if !exists(hwnd) {
        return Err(CLOSED.into());
    }
    if unsafe { IsIconic(hwnd) }.as_bool() {
        return Err("that window is minimised, so it has nothing on screen to capture; focus_window restores it".into());
    }
    // PrintWindow works in window coordinates, which include the frame that the
    // DWM extended bounds trims, so use the raw window rect for the bitmap size.
    let mut raw = RECT::default();
    unsafe { GetWindowRect(hwnd, &mut raw) }.map_err(|e| e.to_string())?;
    let width = (raw.right - raw.left).max(1);
    let height = (raw.bottom - raw.top).max(1);

    let canvas = Canvas::new(width, height)?;
    // PrintWindow is a message round trip to the window's thread: on a hung
    // window it would block this helper, and every request behind it.
    let mut printed = responds(hwnd) && unsafe { PrintWindow(hwnd, canvas.mem, PW_RENDERFULLCONTENT) }.as_bool();
    let mut buf = canvas.pixels()?;
    if printed && looks_blank(&buf, width as usize, height as usize, client_region(hwnd, &raw)) {
        printed = false;
    }
    if !printed {
        // On another virtual desktop the screen holds some other window
        // entirely, which is exactly the wrong-pixels case this op exists to
        // prevent.
        if is_cloaked(hwnd) {
            return Err("that window is on another virtual desktop and would not render itself, so there is \
                        nothing of it on this screen to capture; focus_window brings it here"
                .into());
        }
        canvas.copy_screen((raw.left, raw.top));
        buf = canvas.pixels()?;
    }
    drop(canvas);

    // GDI hands back BGRA with an unreliable alpha channel; PNG wants RGBA
    // and the window is opaque, so swap the channels and force alpha.
    for px in buf.chunks_exact_mut(4) {
        px.swap(0, 2);
        px[3] = 255;
    }

    let file = std::fs::File::create(path).map_err(|e| format!("could not write {path}: {e}"))?;
    let mut encoder = png::Encoder::new(std::io::BufWriter::new(file), width as u32, height as u32);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    let mut writer = encoder.write_header().map_err(|e| e.to_string())?;
    writer.write_image_data(&buf).map_err(|e| e.to_string())?;
    writer.finish().map_err(|e| e.to_string())?;

    // The caller needs the origin as well as the size: PrintWindow works on
    // the raw window rect, which includes the invisible resize border that
    // the DWM extended bounds trims, so image coordinates are relative to
    // this rectangle rather than to the one list_windows reports.
    Ok(PrintResult { rect: Rect { x: raw.left, y: raw.top, width, height }, fallback: !printed })
}

// ---------------------------------------------------------------- scroll

/// What a failed scroll tells the agent. A silent success here would send it
/// off to re-describe a view that never moved.
fn scroll_outcome(d: Delivery) -> Result<(), String> {
    match d {
        Delivery::Delivered => Ok(()),
        Delivery::Blocked => Err("that window runs as administrator, so Windows blocks messages to it from this app \
             and it did not scroll. Ask the user to scroll it."
            .into()),
        Delivery::NotResponding => Err(format!("{NOT_RESPONDING}. It did not scroll.")),
        Delivery::Failed(code) => Err(format!("Windows did not deliver the scroll (error {code}).")),
    }
}

/// The error for a scroll not sent because the window did not answer (see
/// responds): the same words a scroll that timed out gets.
pub fn not_scrolled() -> String {
    scroll_outcome(Delivery::NotResponding).err().unwrap_or_default()
}

/// Scroll a window by sending it wheel notches, as a user's wheel would.
///
/// Wheel messages go to the window under the cursor in normal use; sending
/// directly to the target avoids moving the pointer, which would be input
/// control rather than a view change. The send is bounded, so a hung window
/// costs at most a second instead of wedging the helper.
pub fn scroll(hwnd: HWND, notches: i32) -> Result<(), String> {
    if !exists(hwnd) {
        return Err(CLOSED.into());
    }
    if is_hung(hwnd) {
        return scroll_outcome(Delivery::NotResponding);
    }
    let rect = rect_of(hwnd).ok_or("could not measure that window")?;
    // lParam carries screen coordinates of the pointer for the message.
    let x = rect.x + rect.width / 2;
    let y = rect.y + rect.height / 2;
    let lparam = LPARAM(((y as isize) << 16) | (x as isize & 0xffff));
    let delta = notches * 120; // WHEEL_DELTA
    let wparam = WPARAM(((delta as isize) << 16) as usize);
    scroll_outcome(send_bounded(hwnd, WM_MOUSEWHEEL, wparam, lparam))
}

// --------------------------------------------------------------- covered

/// Sample grid per side: 25 points find any window covering a meaningful part
/// of a control, at a cost of microseconds and no COM.
const GRID: i64 = 5;

/// The grid's points, row by row, at the centres of equal cells so the middle
/// point is the rect's centre.
fn grid_points(r: &Rect) -> Vec<(i32, i32)> {
    let (x, y, w, h) = (r.x as i64, r.y as i64, r.width as i64, r.height as i64);
    (0..GRID)
        .flat_map(|row| {
            (0..GRID).map(move |col| ((x + (2 * col + 1) * w / (2 * GRID)) as i32, (y + (2 * row + 1) * h / (2 * GRID)) as i32))
        })
        .collect()
}

/// Index of the rect's centre in `grid_points`.
const CENTRE: usize = (GRID * GRID / 2) as usize;

/// What one sample point landed on.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Sample {
    /// Off every display, or bare desktop: nothing covers it, but the target
    /// is not there either, so the point says nothing about covering.
    Nowhere,
    Target,
    /// Another top-level window, by handle.
    Other(isize),
}

/// The share of meaningful points that land on another window, whether the
/// centre does, and the covering windows with the most points first (ties in
/// the order first met).
fn tally(samples: &[Sample]) -> (f32, bool, Vec<isize>) {
    let mut seen = 0usize;
    let mut covered = 0usize;
    let mut by: Vec<(isize, usize)> = Vec::new();
    for s in samples {
        match *s {
            Sample::Nowhere => {}
            Sample::Target => seen += 1,
            Sample::Other(h) => {
                seen += 1;
                covered += 1;
                match by.iter_mut().find(|(k, _)| *k == h) {
                    Some((_, n)) => *n += 1,
                    None => by.push((h, 1)),
                }
            }
        }
    }
    // A stable sort keeps first-met order among equals.
    by.sort_by_key(|&(_, n)| std::cmp::Reverse(n));
    let fraction = if seen == 0 { 0.0 } else { covered as f32 / seen as f32 };
    let centre = matches!(samples.get(CENTRE), Some(Sample::Other(_)));
    (fraction, centre, by.into_iter().map(|(h, _)| h).collect())
}

/// What a sample point that landed on top-level window `root` says, for a
/// target window `target`. `chain` holds the other windows that count as the
/// target: its own popups, and only while the target is itself a popup (see
/// covered).
fn sample_of(root: isize, target: isize, chain: &[isize], desktop: impl FnOnce() -> bool) -> Sample {
    if root == target || chain.contains(&root) {
        Sample::Target
    } else if desktop() {
        Sample::Nowhere
    } else {
        Sample::Other(root)
    }
}

fn is_desktop(root: HWND) -> bool {
    let shell = unsafe { root == GetShellWindow() || root == GetDesktopWindow() };
    shell || class_of(root) == "WorkerW"
}

fn contains(r: &Rect, x: i32, y: i32) -> bool {
    x >= r.x && y >= r.y && x < r.x + r.width && y < r.y + r.height
}

/// Which of our own windows can cover a target: none but the chat panel.
#[derive(Clone, Copy)]
struct Ours {
    pid: u32,
    hud: Option<HWND>,
}

impl Ours {
    /// One of our windows that never covers anything: the overlay is drawn
    /// for the user on top of their apps, so counting it would report every
    /// target as covered. The chat panel is opaque, and a target under it
    /// really is out of sight.
    fn ignored(&self, hwnd: HWND) -> bool {
        self.pid != 0 && pid_of(hwnd) == self.pid && Some(hwnd) != self.hud
    }
}

/// Whether a window can hide what is beneath it from the user's eyes.
fn can_cover(hwnd: HWND, ours: Ours) -> bool {
    let shown = unsafe {
        IsWindowVisible(hwnd).as_bool()
            && !IsIconic(hwnd).as_bool()
            // Click-through windows (our overlay, other apps' HUDs) are not
            // hit-tested, matching what WindowFromPoint skips.
            && GetWindowLongW(hwnd, GWL_EXSTYLE) as u32 & WS_EX_TRANSPARENT.0 == 0
    };
    shown && !is_cloaked(hwnd) && !ours.ignored(hwnd)
}

/// The top-level window that owns what is drawn at a point, never one of ours
/// but the chat panel.
///
/// WindowFromPoint already skips click-through windows, which is what our
/// overlay is outside click mode. When it still lands on one of our ignored
/// windows (the overlay in click mode), the Z order below that window is
/// walked for the first one that contains the point.
fn root_at(x: i32, y: i32, ours: Ours) -> Option<HWND> {
    let pt = POINT { x, y };
    unsafe {
        if MonitorFromPoint(pt, MONITOR_DEFAULTTONULL).is_invalid() {
            return None;
        }
        let hit = WindowFromPoint(pt);
        if hit.is_invalid() {
            return None;
        }
        let root = GetAncestor(hit, GA_ROOT);
        let mut root = if root.is_invalid() { hit } else { root };
        if !ours.ignored(root) {
            return Some(root);
        }
        loop {
            root = GetWindow(root, GW_HWNDNEXT).ok().filter(|h| !h.is_invalid())?;
            if can_cover(root, ours) && rect_of(root).is_some_and(|r| contains(&r, x, y)) {
                return Some(root);
            }
        }
    }
}

/// What the chat panel is called when it covers a target. Its window title is
/// the app's name, which would read as some other program.
const HUD_NAME: &str = "the overlay's chat panel";

/// A name the user would recognise for a covering window. Menus and dropdowns
/// have no title of their own, so they take their owner's ("a popup of Paint"
/// reads better than a class name).
fn covering_name(hwnd: HWND, hud: Option<HWND>) -> String {
    if Some(hwnd) == hud {
        return HUD_NAME.to_string();
    }
    let title = title_of(hwnd);
    if !title.trim().is_empty() {
        return title;
    }
    let owner = unsafe { GetAncestor(hwnd, GA_ROOTOWNER) };
    if !owner.is_invalid() && owner != hwnd {
        let owner_title = title_of(owner);
        if !owner_title.trim().is_empty() {
            return format!("a popup of {owner_title}");
        }
    }
    class_of(hwnd)
}

/// How much of `rect` (virtual-screen physical; the whole window when None) is
/// hidden behind other top-level windows, measured at the points the user would
/// look at rather than by summing rectangles. Windows of `ignore_pid` (ours)
/// never count, except `hud`, the chat panel.
///
/// A control in an open popup is measured against that popup, which the
/// caller passes as `hwnd`. While the target is a popup, its own other popups
/// count as the target too: a submenu cascading over its parent menu is the
/// same open menu, and calling it a cover would advise bringing the window
/// forward, which closes the menu. A main window's own dropdown is not: an
/// autocomplete list hanging over the circled Submit button hides it from the
/// user like any other window, and the user would aim at the list entry.
pub fn covered(hwnd: HWND, rect: Option<Rect>, ignore_pid: u32, hud: Option<HWND>) -> Result<Coverage, String> {
    if !exists(hwnd) {
        return Err(CLOSED.into());
    }
    let target = unsafe { GetAncestor(hwnd, GA_ROOT) };
    let target = if target.is_invalid() { hwnd } else { target };
    if unsafe { IsIconic(target) }.as_bool() {
        return Err("that window is minimised, so nothing of it is on screen".into());
    }
    if is_cloaked(target) {
        return Err("that window is on another virtual desktop, so nothing of it is on this screen".into());
    }
    let area = match rect {
        Some(r) => r,
        None => rect_of(target).ok_or("could not measure that window")?,
    };
    if area.width <= 0 || area.height <= 0 {
        return Err("that area is empty".into());
    }

    let ours = Ours { pid: ignore_pid, hud };
    let chain: Vec<isize> =
        if is_popup(target) { popups_of(target).into_iter().map(|(h, _)| h.0 as isize).collect() } else { Vec::new() };
    let samples: Vec<Sample> = grid_points(&area)
        .into_iter()
        .map(|(x, y)| match root_at(x, y, ours) {
            None => Sample::Nowhere,
            Some(root) => sample_of(root.0 as isize, target.0 as isize, &chain, || is_desktop(root)),
        })
        .collect();

    let (fraction, centre_covered, by) = tally(&samples);
    let mut names: Vec<String> = Vec::new();
    for h in by {
        let name = covering_name(HWND(h as *mut std::ffi::c_void), hud);
        if !names.contains(&name) {
            names.push(name);
        }
    }
    Ok(Coverage { fraction, centre_covered, by: names })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn delivery_reads_the_last_error() {
        assert_eq!(delivery(1, 0), Delivery::Delivered);
        // A success with a stale error code is still a success.
        assert_eq!(delivery(1, ERROR_ACCESS_DENIED.0), Delivery::Delivered);
        assert_eq!(delivery(0, ERROR_ACCESS_DENIED.0), Delivery::Blocked);
        assert_eq!(delivery(0, ERROR_TIMEOUT.0), Delivery::NotResponding);
        assert_eq!(delivery(0, 1400), Delivery::Failed(1400));
    }

    #[test]
    fn a_failed_scroll_is_never_a_success() {
        assert!(scroll_outcome(Delivery::Delivered).is_ok());
        assert!(scroll_outcome(Delivery::Blocked).unwrap_err().contains("runs as administrator"));
        assert!(scroll_outcome(Delivery::NotResponding).unwrap_err().contains("not responding"));
        assert!(scroll_outcome(Delivery::Failed(5)).is_err());
    }

    fn image(width: usize, height: usize, fill: [u8; 4]) -> Vec<u8> {
        fill.iter().copied().cycle().take(width * height * 4).collect()
    }

    fn paint(buf: &mut [u8], width: usize, x: usize, y: usize, colour: [u8; 4]) {
        buf[(y * width + x) * 4..(y * width + x) * 4 + 4].copy_from_slice(&colour);
    }

    #[test]
    fn a_flat_black_surface_is_blank() {
        let buf = image(8, 6, [0, 0, 0, 0]);
        assert!(looks_blank(&buf, 8, 6, (0, 0, 0, 0)));
        // Alpha is ignored, and a step of dithering is still flat.
        let mut buf = image(8, 6, [10, 10, 10, 0]);
        paint(&mut buf, 8, 3, 3, [12, 9, 13, 255]);
        assert!(looks_blank(&buf, 8, 6, (0, 0, 0, 0)));
    }

    #[test]
    fn any_real_content_is_not_blank() {
        let mut buf = image(8, 6, [0, 0, 0, 255]);
        paint(&mut buf, 8, 7, 5, [200, 200, 200, 255]);
        assert!(!looks_blank(&buf, 8, 6, (0, 0, 0, 0)));
    }

    #[test]
    fn a_rendered_frame_around_blank_content_is_blank() {
        // Title bar row drawn, client area (rows 1..6) black.
        let mut buf = image(8, 6, [0, 0, 0, 255]);
        for x in 0..8 {
            paint(&mut buf, 8, x, 0, [240, 240, 240, 255]);
        }
        assert!(!looks_blank(&buf, 8, 6, (0, 0, 0, 0)));
        assert!(looks_blank(&buf, 8, 6, (0, 1, 8, 5)));
        // A client rect running past the image is clipped, not trusted.
        assert!(looks_blank(&buf, 8, 6, (0, 1, 50, 50)));
    }

    #[test]
    fn grid_centre_is_the_rect_centre() {
        let r = Rect { x: -100, y: 40, width: 200, height: 100 };
        let pts = grid_points(&r);
        assert_eq!(pts.len(), 25);
        assert_eq!(pts[CENTRE], (0, 90));
        assert_eq!(pts[0], (-80, 50));
        assert_eq!(pts[24], (80, 130));
        assert!(pts.iter().all(|&(x, y)| contains(&r, x, y)));
    }

    #[test]
    fn tally_counts_only_points_that_say_something() {
        let mut s = vec![Sample::Target; 25];
        assert_eq!(tally(&s), (0.0, false, vec![]));

        // Off-display points are left out of the share, not counted as clear.
        for p in s.iter_mut().take(10) {
            *p = Sample::Nowhere;
        }
        s[CENTRE] = Sample::Other(7);
        let (fraction, centre, by) = tally(&s);
        assert!((fraction - 1.0 / 15.0).abs() < 1e-6);
        assert!(centre);
        assert_eq!(by, vec![7]);

        assert_eq!(tally(&[Sample::Nowhere; 25]), (0.0, false, vec![]));
    }

    #[test]
    fn a_main_windows_own_dropdown_covers_its_controls() {
        // The app's autocomplete list (5) over the circled button of its main
        // window (1): the target is no popup, so nothing else is the target.
        let samples: Vec<Sample> = [1, 5, 5].iter().map(|&root| sample_of(root, 1, &[], || false)).collect();
        assert_eq!(samples, [Sample::Target, Sample::Other(5), Sample::Other(5)]);
        let (fraction, _, by) = tally(&samples);
        assert!(fraction > 0.5);
        assert_eq!(by, vec![5]);
    }

    #[test]
    fn a_submenu_over_its_parent_menu_is_the_same_menu() {
        // Target is the parent menu (2); its cascading submenu (3) is in its
        // chain, an unrelated window (9) is not.
        assert_eq!(sample_of(3, 2, &[3], || false), Sample::Target);
        assert_eq!(sample_of(2, 2, &[3], || false), Sample::Target);
        assert_eq!(sample_of(9, 2, &[3], || false), Sample::Other(9));
    }

    #[test]
    fn bare_desktop_says_nothing() {
        assert_eq!(sample_of(4, 1, &[], || true), Sample::Nowhere);
        // The target is never mistaken for the desktop, nor asked about it.
        assert_eq!(sample_of(1, 1, &[], || panic!("asked")), Sample::Target);
    }

    #[test]
    fn tally_names_the_biggest_cover_first() {
        let mut s = vec![Sample::Target; 25];
        s[0] = Sample::Other(1);
        s[1] = Sample::Other(2);
        s[2] = Sample::Other(2);
        s[3] = Sample::Other(3);
        let (fraction, centre, by) = tally(&s);
        assert!((fraction - 4.0 / 25.0).abs() < 1e-6);
        assert!(!centre);
        // 2 covers most; 1 and 3 tie and keep the order they were met.
        assert_eq!(by, vec![2, 1, 3]);
    }
}
