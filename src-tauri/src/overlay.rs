use crate::models::Rect;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};

const OVERLAY_LABEL: &str = "area-selector";

/// Whether the overlay currently on screen already reported a result, so
/// closing it doesn't report a second, empty one over the top.
static SELECTION_REPORTED: AtomicBool = AtomicBool::new(true);

/// Runs `f` on the main thread and waits for its result. Window creation/
/// closing/focus must happen on the main thread on Windows (mixing threads
/// there can hang rather than error), so every overlay window operation
/// goes through this instead of being called directly from a command
/// handler thread.
///
/// The caller must not itself be the main thread: `f` only runs once the
/// main thread is back in its event loop, so calling this from there parks
/// it forever on a closure that can never run, freezing every window in
/// the app. In practice that means any command reaching this has to be an
/// `async fn` — Tauri runs those off-thread, while a plain `fn` command
/// runs on the main thread.
pub fn on_main_thread<T, F>(app: &tauri::AppHandle, f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> T + Send + 'static,
{
    let (tx, rx) = mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(f());
    })
    .map_err(|e| e.to_string())?;
    rx.recv()
        .map_err(|_| "main-thread task did not complete".to_string())
}

fn create_overlay_window(app: &tauri::AppHandle) -> Result<(), String> {
    let main = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    let monitors = main.available_monitors().map_err(|e| e.to_string())?;
    if monitors.is_empty() {
        return Err("No displays detected".to_string());
    }

    let (mut min_x, mut min_y) = (i32::MAX, i32::MAX);
    let (mut max_x, mut max_y) = (i32::MIN, i32::MIN);
    for m in &monitors {
        let pos = m.position();
        let size = m.size();
        min_x = min_x.min(pos.x);
        min_y = min_y.min(pos.y);
        max_x = max_x.max(pos.x + size.width as i32);
        max_y = max_y.max(pos.y + size.height as i32);
    }

    SELECTION_REPORTED.store(false, Ordering::SeqCst);

    let overlay = WebviewWindowBuilder::new(app, OVERLAY_LABEL, WebviewUrl::App("index.html".into()))
        .title("Select recording area")
        .transparent(true)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .shadow(false)
        .build()
        .map_err(|e| e.to_string())?;

    // Monitors report physical pixels, but the builder's position/size take
    // logical ones — so the geometry is applied here instead, where it can
    // be stated in physical pixels directly. Getting this exact matters:
    // the overlay's own page treats its viewport as the screen when it
    // sizes the default capture region, and a scaled display would
    // otherwise leave most of that region off-screen.
    overlay
        .set_position(tauri::PhysicalPosition::new(min_x, min_y))
        .map_err(|e| e.to_string())?;
    overlay
        .set_size(tauri::PhysicalSize::new(
            (max_x - min_x) as u32,
            (max_y - min_y) as u32,
        ))
        .map_err(|e| e.to_string())?;

    // If the overlay goes away without the frontend ever reporting
    // anything (closed some other way), say so, or whatever is waiting on
    // the selection would wait forever. This counts as cancelling rather
    // than as picking the whole screen: choosing the area now starts the
    // recording immediately, and a window that merely vanished is no
    // reason to start recording anything.
    let app_handle = app.clone();
    overlay.on_window_event(move |event| {
        if matches!(event, WindowEvent::Destroyed)
            && !SELECTION_REPORTED.swap(true, Ordering::SeqCst)
        {
            let _ = app_handle.emit("area-selection-cancelled", ());
        }
    });

    Ok(())
}

/// Opens a transparent, always-on-top window spanning every monitor so the
/// user can drag-select a capture region. The window's own frontend (see
/// `AreaSelectorOverlay.tsx`, chosen by window label) reports the result
/// back via the `submit_area_selection` command.
pub fn open(app: &tauri::AppHandle) -> Result<(), String> {
    if let Some(existing) = app.get_webview_window(OVERLAY_LABEL) {
        let _ = on_main_thread(app, move || existing.set_focus());
        return Ok(());
    }

    let app_handle = app.clone();
    on_main_thread(app, move || create_overlay_window(&app_handle))?
}

pub fn close(app: &tauri::AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(OVERLAY_LABEL) {
        on_main_thread(app, move || win.close().map_err(|e| e.to_string()))?
    } else {
        Ok(())
    }
}

/// Called by the overlay window's frontend once the user finishes dragging
/// (or cancels). `rect` is `None` on cancel, meaning "the entire screen".
/// The result goes to every window, since either the main window or the
/// floating recorder bar may be the one waiting for it.
pub fn submit(app: &tauri::AppHandle, rect: Option<Rect>) -> Result<(), String> {
    SELECTION_REPORTED.store(true, Ordering::SeqCst);
    app.emit("area-selected", rect).map_err(|e| e.to_string())?;
    close(app)
}

/// Called when the user abandons the selection altogether, as opposed to
/// choosing the whole screen — nothing should start recording.
pub fn cancel(app: &tauri::AppHandle) -> Result<(), String> {
    SELECTION_REPORTED.store(true, Ordering::SeqCst);
    app.emit("area-selection-cancelled", ())
        .map_err(|e| e.to_string())?;
    close(app)
}
