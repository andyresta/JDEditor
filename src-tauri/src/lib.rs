mod devices;
mod media;
mod models;
mod overlay;
mod recorder;
mod recordings;

use models::{DeviceList, Rect, RecordingConfig, RecordingFile, RecordingStatus};
use recorder::RecorderState;
use tauri::State;

#[tauri::command]
fn list_devices(app: tauri::AppHandle) -> Result<DeviceList, String> {
    devices::list_all(&app)
}

#[tauri::command]
fn check_ffmpeg() -> bool {
    devices::ffmpeg_path().is_some()
}

#[tauri::command]
fn start_recording(
    app: tauri::AppHandle,
    state: State<RecorderState>,
    config: RecordingConfig,
) -> Result<String, String> {
    recorder::start(&app, &state, config)
}

#[tauri::command]
fn stop_recording(state: State<RecorderState>) -> Result<String, String> {
    recorder::stop(&state)
}

#[tauri::command]
fn recording_status(state: State<RecorderState>) -> RecordingStatus {
    recorder::status(&state)
}

#[tauri::command]
fn open_area_selector(app: tauri::AppHandle) -> Result<(), String> {
    overlay::open(&app)
}

#[tauri::command]
fn submit_area_selection(app: tauri::AppHandle, rect: Option<Rect>) -> Result<(), String> {
    overlay::submit(&app, rect)
}

#[tauri::command]
fn list_recordings(app: tauri::AppHandle) -> Result<Vec<RecordingFile>, String> {
    recordings::list(&app)
}

#[tauri::command]
fn delete_recording(path: String) -> Result<(), String> {
    recordings::delete(&path)
}

#[tauri::command]
fn prepare_media(app: tauri::AppHandle, path: String) -> Result<media::MediaPrepared, String> {
    media::prepare(&app, &path)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(RecorderState::default())
        .invoke_handler(tauri::generate_handler![
            list_devices,
            check_ffmpeg,
            start_recording,
            stop_recording,
            recording_status,
            open_area_selector,
            submit_area_selection,
            list_recordings,
            delete_recording,
            prepare_media,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
