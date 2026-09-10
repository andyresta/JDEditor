use crate::models::Rect;
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

const OVERLAY_LABEL: &str = "area-selector";

/// Opens a transparent, always-on-top window spanning every monitor so the
/// user can drag-select a capture region. The window's own frontend (see
/// `AreaSelector.tsx`, chosen by window label) reports the result back via
/// the `submit_area_selection` command.
pub fn open(app: &tauri::AppHandle) -> Result<(), String> {
    if let Some(existing) = app.get_webview_window(OVERLAY_LABEL) {
        let _ = existing.set_focus();
        return Ok(());
    }

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

    WebviewWindowBuilder::new(app, OVERLAY_LABEL, WebviewUrl::App("index.html".into()))
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

    Ok(())
}

pub fn close(app: &tauri::AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(OVERLAY_LABEL) {
        win.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Called by the overlay window's frontend once the user finishes dragging
/// (or cancels). `rect` is `None` on cancel.
pub fn submit(app: &tauri::AppHandle, rect: Option<Rect>) -> Result<(), String> {
    if let Some(main) = app.get_webview_window("main") {
        main.emit("area-selected", rect).map_err(|e| e.to_string())?;
    }
    close(app)
}
