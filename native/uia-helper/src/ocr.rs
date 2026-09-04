//! Text recognition for surfaces that expose no accessibility tree.
//!
//! Canvas apps, games and remote-desktop windows return an empty UIA tree, which
//! is exactly where `describe_window` gives up and a screenshot is the only
//! option. Windows ships an OCR engine (`Windows.Media.Ocr`), so reading the
//! words out of the pixels costs no extra dependency and no network call — and
//! because it returns per-line bounding boxes, the results stay anchorable
//! rather than being an undifferentiated blob of text.

use std::time::{Duration, Instant};

use serde::Serialize;
use windows_future::{AsyncStatus, IAsyncOperation};
use windows::core::RuntimeType;
use windows::Graphics::Imaging::BitmapDecoder;
use windows::Media::Ocr::OcrEngine;
use windows::Storage::Streams::{DataWriter, InMemoryRandomAccessStream};

use crate::Rect;

/// Block until a WinRT async operation finishes.
///
/// windows-rs 0.3 dropped the blocking `get()` and exposes only `IntoFuture`,
/// and pulling in an async runtime for four calls in a synchronous helper is not
/// worth it. The COM apartment here is MTA, so the completion runs on a pool
/// thread and a bounded status poll cannot deadlock.
fn block<T: RuntimeType>(op: IAsyncOperation<T>) -> Result<T, String> {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        match op.Status().map_err(|e| e.to_string())? {
            AsyncStatus::Started => {
                if Instant::now() > deadline {
                    return Err("the OCR operation timed out".into());
                }
                std::thread::sleep(Duration::from_millis(2));
            }
            AsyncStatus::Completed => return op.GetResults().map_err(|e| e.to_string()),
            other => return Err(format!("async operation ended with status {other:?}")),
        }
    }
}

#[derive(Serialize)]
pub struct OcrLine {
    pub text: String,
    /// Pixel coordinates within the supplied image, matching capture space.
    pub rect: Rect,
}

/// Recognise text in a PNG on disk. Coordinates are image pixels.
pub fn recognise(path: &str) -> Result<Vec<OcrLine>, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("could not read {path}: {e}"))?;

    // The decoder wants a WinRT stream, so copy the file into memory as one.
    let stream = InMemoryRandomAccessStream::new().map_err(|e| e.to_string())?;
    let writer = DataWriter::CreateDataWriter(&stream).map_err(|e| e.to_string())?;
    writer.WriteBytes(&bytes).map_err(|e| e.to_string())?;
    block(writer.StoreAsync().map_err(|e| e.to_string())?)?;
    // FlushAsync yields IAsyncOperation<bool>, same blocking treatment.
    block(writer.FlushAsync().map_err(|e| e.to_string())?)?;
    stream.Seek(0).map_err(|e| e.to_string())?;

    let decoder = block(BitmapDecoder::CreateAsync(&stream).map_err(|e| e.to_string())?)
        .map_err(|e| format!("could not decode the image: {e}"))?;
    let bitmap = block(decoder.GetSoftwareBitmapAsync().map_err(|e| e.to_string())?)?;

    // Follows the user's own language preferences, so it matches what they see.
    let engine = OcrEngine::TryCreateFromUserProfileLanguages()
        .map_err(|e| format!("no OCR engine available: {e}"))?;
    let result = block(engine.RecognizeAsync(&bitmap).map_err(|e| e.to_string())?)?;

    let mut out = Vec::new();
    for line in result.Lines().map_err(|e| e.to_string())?.into_iter() {
        let text = line.Text().map_err(|e| e.to_string())?.to_string();
        if text.trim().is_empty() {
            continue;
        }
        // A line has no rect of its own; union its words.
        let mut left = f64::MAX;
        let mut top = f64::MAX;
        let mut right = f64::MIN;
        let mut bottom = f64::MIN;
        for word in line.Words().map_err(|e| e.to_string())?.into_iter() {
            let r = word.BoundingRect().map_err(|e| e.to_string())?;
            left = left.min(r.X as f64);
            top = top.min(r.Y as f64);
            right = right.max((r.X + r.Width) as f64);
            bottom = bottom.max((r.Y + r.Height) as f64);
        }
        if left > right || top > bottom {
            continue;
        }
        out.push(OcrLine {
            text,
            rect: Rect {
                x: left.round() as i32,
                y: top.round() as i32,
                width: (right - left).round() as i32,
                height: (bottom - top).round() as i32,
            },
        });
    }
    Ok(out)
}
