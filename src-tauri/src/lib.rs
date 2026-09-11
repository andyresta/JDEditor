mod bar;
mod devices;
mod media;
mod meter;
mod models;
mod overlay;
mod project;
mod recorder;
mod recordings;
mod sidecar;

use models::{BarSetup, DeviceList, Rect, RecordingConfig, RecordingFile, RecordingStatus};
use recorder::RecorderState;

/// Runs a closure on a background thread instead of the main UI thread.
/// `list_devices`, media probing, etc. all shell out to ffmpeg/ffprobe or
/// walk the filesystem — plain (non-`async`) Tauri commands run on the
/// same thread that pumps the window's event loop, so anything blocking
/// in there would freeze the whole app's UI for as long as it takes. This
/// hands the blocking work to a separate thread and only awaits it, so
/// the window stays responsive while it runs.
async fn blocking<T, F>(f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> T + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| format!("background task failed: {e}"))
}

#[tauri::command]
async fn list_devices(app: tauri::AppHandle) -> Result<DeviceList, String> {
    blocking(move || devices::list_all(&app)).await?
}

#[tauri::command]
async fn check_ffmpeg() -> bool {
    blocking(|| devices::ffmpeg_path().is_some())
        .await
        .unwrap_or(false)
}

#[tauri::command]
async fn debug_device_scan() -> String {
    blocking(devices::debug_dump)
        .await
        .unwrap_or_else(|e| e)
}

#[tauri::command]
async fn start_recording(app: tauri::AppHandle, config: RecordingConfig) -> Result<String, String> {
    blocking(move || recorder::start(&app, config)).await?
}

#[tauri::command]
async fn pause_recording(app: tauri::AppHandle) -> Result<(), String> {
    blocking(move || recorder::pause(&app)).await?
}

#[tauri::command]
async fn resume_recording(app: tauri::AppHandle) -> Result<(), String> {
    blocking(move || recorder::resume(&app)).await?
}

#[tauri::command]
async fn stop_recording(app: tauri::AppHandle) -> Result<String, String> {
    blocking(move || recorder::stop(&app)).await?
}

#[tauri::command]
async fn discard_recording(app: tauri::AppHandle) -> Result<(), String> {
    blocking(move || recorder::discard(&app)).await?
}

#[tauri::command]
async fn open_recorder_bar(app: tauri::AppHandle, setup: BarSetup) -> Result<(), String> {
    blocking(move || bar::open(&app, setup)).await?
}

#[tauri::command]
async fn close_recorder_bar(app: tauri::AppHandle) -> Result<(), String> {
    blocking(move || bar::close(&app)).await?
}

#[tauri::command]
fn recorder_bar_setup(app: tauri::AppHandle) -> Option<BarSetup> {
    bar::setup(&app)
}

#[tauri::command]
async fn recording_status(app: tauri::AppHandle) -> RecordingStatus {
    blocking(move || recorder::status(&app))
        .await
        .unwrap_or(RecordingStatus {
            is_recording: false,
            is_paused: false,
            elapsed_seconds: 0,
            output_path: None,
            error: None,
            audio_level: None,
        })
}

#[tauri::command]
async fn open_area_selector(app: tauri::AppHandle) -> Result<(), String> {
    blocking(move || overlay::open(&app)).await?
}

#[tauri::command]
async fn submit_area_selection(app: tauri::AppHandle, rect: Option<Rect>) -> Result<(), String> {
    blocking(move || overlay::submit(&app, rect)).await?
}

#[tauri::command]
async fn cancel_area_selection(app: tauri::AppHandle) -> Result<(), String> {
    blocking(move || overlay::cancel(&app)).await?
}

#[tauri::command]
async fn list_recordings(app: tauri::AppHandle) -> Result<Vec<RecordingFile>, String> {
    blocking(move || recordings::list(&app)).await?
}

#[tauri::command]
async fn delete_recording(path: String) -> Result<(), String> {
    blocking(move || recordings::delete(&path)).await?
}

#[tauri::command]
async fn prepare_media(app: tauri::AppHandle, path: String) -> Result<media::MediaPrepared, String> {
    blocking(move || media::prepare(&app, &path)).await?
}

/// Writes the project document to `path`, returning where it actually
/// landed (the extension is added if the typed name lacked it).
#[tauri::command]
async fn save_project(path: String, contents: String) -> Result<String, String> {
    blocking(move || project::save(&path, &contents)).await?
}

#[tauri::command]
async fn load_project(path: String) -> Result<String, String> {
    blocking(move || project::load(&path)).await?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(RecorderState::default())
        .manage(bar::BarState::default())
        .invoke_handler(tauri::generate_handler![
            list_devices,
            check_ffmpeg,
            debug_device_scan,
            start_recording,
            pause_recording,
            resume_recording,
            stop_recording,
            discard_recording,
            recording_status,
            open_recorder_bar,
            close_recorder_bar,
            recorder_bar_setup,
            open_area_selector,
            submit_area_selection,
            cancel_area_selection,
            list_recordings,
            delete_recording,
            prepare_media,
            save_project,
            load_project,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // Don't let a capture outlive the app that started it.
            if matches!(event, tauri::RunEvent::Exit) {
                recorder::abort_on_exit(app);
            }
        });
}
