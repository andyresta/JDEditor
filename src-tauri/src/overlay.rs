use crate::models::Rect;
use std::sync::mpsc;
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};

const OVERLAY_LABEL: &str = "area-selector";

/// Runs `f` on the main thread and waits for its result. Window creation/
/// closing/focus must happen on the main thread on Windows (mixing threads
/// there can hang rather than error), so every overlay window operation
/// goes through this instead of being called directly from a command
/// handler thread.
fn on_main_thread<T, F>(app: &tauri::AppHandle, f: F) -> Result<T, String>
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

    let overlay = WebviewWindowBuilder::new(app, OVERLAY_LABEL, WebviewUrl::App("index.html".into()))
        .title("Select recording area")
        .transparent(true)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .shadow(false)
        .position(min_x as f64, min_y as f64)
        .inner_size((max_x - min_x) as f64, (max_y - min_y) as f64)
        .build()
        .map_err(|e| e.to_string())?;

    // If the overlay goes away without the frontend ever calling
    // `submit_area_selection` (closed some other way), make sure the main
    // window still gets an `area-selected` event so a caller awaiting the
    // selection doesn't hang forever. Harmless if it fires again right
    // after a normal submit-then-close, since the frontend only listens
    // for the first event.
    let app_handle = app.clone();
    overlay.on_window_event(move |event| {
        if matches!(event, WindowEvent::Destroyed) {
            let _ = app_handle.emit("area-selected", None::<Rect>);
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
/// (or cancels). `rect` is `None` on cancel.
pub fn submit(app: &tauri::AppHandle, rect: Option<Rect>) -> Result<(), String> {
    if let Some(main) = app.get_webview_window("main") {
        main.emit("area-selected", rect).map_err(|e| e.to_string())?;
    }
    close(app)
}
