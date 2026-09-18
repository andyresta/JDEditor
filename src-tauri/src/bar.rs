use crate::models::BarSetup;
use crate::overlay::on_main_thread;
use std::sync::Mutex;
use tauri::{Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};

pub const BAR_LABEL: &str = "recorder-bar";

const BAR_WIDTH: f64 = 460.0;
const BAR_HEIGHT: f64 = 64.0;
/// Gap between the bar and the bottom edge of the display.
const BAR_BOTTOM_MARGIN: f64 = 48.0;

/// The capture settings the main window handed over when it opened the
/// bar. The bar reads them back to record with, since it — not the main
/// window — drives the recording from that point on.
#[derive(Default)]
pub struct BarState(pub Mutex<Option<BarSetup>>);

pub fn setup(app: &tauri::AppHandle) -> Option<BarSetup> {
    app.state::<BarState>().0.lock().unwrap().clone()
}

/// Opens the floating recorder bar and steps the main window out of the
/// way. The main window comes back when the bar closes.
pub fn open(app: &tauri::AppHandle, setup: BarSetup) -> Result<(), String> {
    *app.state::<BarState>().0.lock().unwrap() = Some(setup);

    if let Some(existing) = app.get_webview_window(BAR_LABEL) {
        let _ = on_main_thread(app, move || existing.set_focus());
        return Ok(());
    }

    // Area capture puts the region selector on screen first, so the bar
    // starts hidden and shows itself once there's a region — otherwise it
    // would flash up and disappear again.
    let start_hidden = app
        .state::<BarState>()
        .0
        .lock()
        .unwrap()
        .as_ref()
        .is_some_and(|setup| setup.pick_area);

    let app_handle = app.clone();
    on_main_thread(app, move || create_bar_window(&app_handle, start_hidden))?
}

pub fn close(app: &tauri::AppHandle) -> Result<(), String> {
    if let Some(bar) = app.get_webview_window(BAR_LABEL) {
        on_main_thread(app, move || bar.close().map_err(|e| e.to_string()))?
    } else {
        Ok(())
    }
}

fn create_bar_window(app: &tauri::AppHandle, start_hidden: bool) -> Result<(), String> {
    let main = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    // Whether this app is being recorded, rather than merely doing the
    // recording.
    let keep_on_screen = app
        .state::<BarState>()
        .0
        .lock()
        .unwrap()
        .as_ref()
        .is_some_and(|setup| setup.keep_app_on_screen);

    let mut builder =
        WebviewWindowBuilder::new(app, BAR_LABEL, WebviewUrl::App("index.html".into()))
            .title("JDEditor recorder")
            .transparent(true)
            .decorations(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .resizable(false)
            .shadow(false)
            .focused(true)
            .visible(!start_hidden)
            .inner_size(BAR_WIDTH, BAR_HEIGHT);

    if let Some(monitor) = main
        .primary_monitor()
        .ok()
        .flatten()
        .or_else(|| main.current_monitor().ok().flatten())
    {
        // Bottom centre of the display. The builder takes logical
        // coordinates, while a monitor reports physical ones.
        let scale = monitor.scale_factor();
        let position = monitor.position().to_logical::<f64>(scale);
        let size = monitor.size().to_logical::<f64>(scale);
        builder = builder.position(
            position.x + (size.width - BAR_WIDTH) / 2.0,
            position.y + size.height - BAR_HEIGHT - BAR_BOTTOM_MARGIN,
        );
    }

    let bar = builder.build().map_err(|e| e.to_string())?;
    exclude_from_capture(&bar);

    // However the bar goes away — stopping a recording, closing it, or
    // being shut some other way — the main window is what the user should
    // be left looking at.
    let app_handle = app.clone();
    bar.on_window_event(move |event| {
        if matches!(event, WindowEvent::Destroyed) {
            if let Some(main) = app_handle.get_webview_window("main") {
                let _ = main.show();
                let _ = main.set_focus();
            }
        }
    });

    if keep_on_screen {
        // Left where it is, and left in front: a recording of this app is
        // a recording of this app, and it cannot be behind the thing
        // recording it. Focus goes to the bar all the same, so the very
        // next click is on Record rather than on the editor.
        let _ = main.set_focus();
    } else {
        let _ = main.hide();
    }
    Ok(())
}

/// Keeps the bar out of the recording, so it can float over the captured
/// region without appearing in the captured frames. Windows enforces this
/// at the compositor level, which covers gdigrab along with every other
/// way of grabbing the screen.
#[cfg(target_os = "windows")]
fn exclude_from_capture(window: &WebviewWindow) {
    // user32's SetWindowDisplayAffinity, declared here rather than pulled
    // in from a windows-crate dependency of this crate's own, whose HWND
    // type would then have to match the one Tauri hands back.
    #[link(name = "user32")]
    extern "system" {
        fn SetWindowDisplayAffinity(hwnd: isize, affinity: u32) -> i32;
    }
    const WDA_EXCLUDEFROMCAPTURE: u32 = 0x0000_0011;

    if let Ok(hwnd) = window.hwnd() {
        // Best effort: on a build of Windows without it (pre-10 2004) the
        // bar simply shows up in the recording.
        unsafe { SetWindowDisplayAffinity(hwnd.0 as isize, WDA_EXCLUDEFROMCAPTURE) };
    }
}

#[cfg(not(target_os = "windows"))]
fn exclude_from_capture(_window: &WebviewWindow) {}
