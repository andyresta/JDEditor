//! A ring around the mouse, for the duration of a recording.
//!
//! The pointer in a screen recording is a few pale pixels, and on a busy
//! screen nobody can follow it. This puts a soft ring behind it and a
//! pulse under every click — not afterwards in the editor, but *while*
//! recording, in a transparent window of its own that the capture picks
//! up along with everything else on screen.
//!
//! Drawn there rather than added at export for a plain reason: the
//! recording is then simply a recording of what was on the screen. There
//! is nothing for the renderer to reproduce, nothing that can disagree
//! between the preview and the finished file, and no cost at all when the
//! film is finally written out.
//!
//! The window never takes the pointer: it is click-through, so it sits
//! over the work without being in the way of it.

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

pub const HALO_LABEL: &str = "cursor-halo";

/// Where the pointer is, told to the ring sixty times a second.
///
/// In physical pixels from the window's own top-left corner, because that
/// is what the page can place something at once it has divided by its own
/// pixel ratio — the alternative is teaching the page about monitors.
#[derive(Debug, Clone, Copy, serde::Serialize)]
pub struct HaloAt {
    pub x: i32,
    pub y: i32,
    pub down: bool,
}

/// Opens the ring over the patch of screen being recorded.
///
/// Must be called on the main thread — window creation on Windows is not
/// safe from anywhere else — which `overlay::on_main_thread` arranges.
pub fn open(app: &tauri::AppHandle, origin: (i32, i32), size: (u32, u32)) -> Result<(), String> {
    if app.get_webview_window(HALO_LABEL).is_some() {
        return Ok(());
    }

    let halo = WebviewWindowBuilder::new(app, HALO_LABEL, WebviewUrl::App("index.html".into()))
        .title("Mouse highlight")
        .transparent(true)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .shadow(false)
        // Never takes focus: the work being recorded is what should have
        // it, and a window stealing focus at the moment recording starts
        // would be recorded doing so.
        .focused(false)
        .build()
        .map_err(|e| e.to_string())?;

    // Physical pixels, like the area selector: the monitors report them,
    // and the builder's own size takes logical ones.
    halo.set_position(tauri::PhysicalPosition::new(origin.0, origin.1))
        .map_err(|e| e.to_string())?;
    halo.set_size(tauri::PhysicalSize::new(size.0, size.1))
        .map_err(|e| e.to_string())?;
    // The whole point: the ring is over the work, not in front of it.
    halo.set_ignore_cursor_events(true)
        .map_err(|e| e.to_string())?;

    Ok(())
}

pub fn close(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window(HALO_LABEL) {
        let _ = window.close();
    }
}
