mod bar;
mod caption;
mod cursor;
mod halo;
mod devices;
mod export;
mod media;
mod meter;
mod models;
mod overlay;
mod project;
mod recorder;
mod recordings;
mod sidecar;
mod waveform;

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

/// The windows on screen that a recording could be pointed at.
#[tauri::command]
async fn list_windows() -> Result<Vec<devices::WindowInfo>, String> {
    blocking(devices::list_windows).await
}

/// Whether a file is where it is said to be.
///
/// A project remembers where its footage was; opening one somewhere else,
/// or after the files have been tidied into another folder, has to be able
/// to find out that they have gone rather than discovering it later as a
/// clip that plays nothing.
#[tauri::command]
async fn path_exists(path: String) -> Result<bool, String> {
    blocking(move || std::path::Path::new(&path).is_file()).await
}

/// Keeps a copy of the work in progress, so that an editor that never got
/// the chance to close properly can offer it back.
#[tauri::command]
async fn write_recovery(app: tauri::AppHandle, contents: String) -> Result<(), String> {
    blocking(move || project::write_recovery(&app, &contents)).await?
}

/// The unsaved work of a session that ended badly, if there was one.
#[tauri::command]
async fn read_recovery(app: tauri::AppHandle) -> Result<Option<String>, String> {
    blocking(move || project::read_recovery(&app)).await?
}

/// Forgets the copy. The project's own file is never touched by this.
#[tauri::command]
async fn clear_recovery(app: tauri::AppHandle) -> Result<(), String> {
    blocking(move || project::clear_recovery(&app)).await?
}

/// Stores a picture the editor drew where the renderer can reach it.
///
/// Titles and the backdrop are both painted on a canvas by the editor and
/// handed over as bytes; they are put beside the thumbnails, named after
/// what they belong to, so a second export replaces the first rather than
/// piling up.
#[tauri::command]
async fn write_overlay_image(
    app: tauri::AppHandle,
    name: String,
    bytes: Vec<u8>,
) -> Result<String, String> {
    blocking(move || export::write_overlay_image(&app, &name, &bytes)).await?
}

/// Renders the timeline to a file. Long-running by nature, so it runs off
/// the UI thread and reports its position through `export-progress`
/// events rather than by returning anything until it is done.
#[tauri::command]
async fn export_timeline(
    app: tauri::AppHandle,
    plan: export::ExportPlan,
) -> Result<String, String> {
    blocking(move || export::run(&app, plan)).await?
}

#[tauri::command]
async fn cancel_export(app: tauri::AppHandle) -> Result<(), String> {
    blocking(move || export::cancel(&app)).await
}

/// The loudness envelope of a file's audio, for drawing on the timeline.
/// Decoding a long file takes a moment, so like `prepare_media` this runs
/// off the UI thread and the editor draws a flat line until it answers.
#[tauri::command]
async fn audio_peaks(
    app: tauri::AppHandle,
    path: String,
) -> Result<waveform::AudioPeaks, String> {
    blocking(move || waveform::read(&app, &path)).await?
}

/// Writes captions from what is said in the given clips.
///
/// Long-running and on the network, so it runs off the UI thread and says
/// where it has got to through `caption-progress` events.
#[tauri::command]
async fn write_captions(
    app: tauri::AppHandle,
    request: caption::CaptionRequest,
) -> Result<Vec<caption::Caption>, String> {
    blocking(move || caption::run(&app, request)).await?
}

/// Where the mouse went during a recording, if it was followed.
///
/// None for anything this app did not record, and for recordings made
/// with the switch off — neither is a failure, only an absence.
#[tauri::command]
async fn cursor_track(path: String) -> Result<Option<cursor::CursorTrack>, String> {
    blocking(move || Ok(cursor::read(std::path::Path::new(&path)))).await?
}

/// Whether the mouse can be followed on this machine at all, so a switch
/// that could do nothing is never offered.
#[tauri::command]
async fn can_track_cursor() -> Result<bool, String> {
    blocking(move || Ok(cursor::can_follow())).await?
}

/// Every transcription service on offer: what it is, whether a key has
/// been put in for it, and which one is marked for use.
///
/// The keys themselves never come back out — what the editor is told is
/// only that there is one, so a key cannot end up in a log or a
/// screenshot by way of the interface.
#[tauri::command]
async fn speech_engines(app: tauri::AppHandle) -> Result<Vec<caption::EngineInfo>, String> {
    blocking(move || Ok(caption::engines(&app))).await?
}

/// Puts a key in for one service, or takes it away again when given
/// nothing.
#[tauri::command]
async fn save_speech_key(
    app: tauri::AppHandle,
    engine: String,
    key: String,
) -> Result<Vec<caption::EngineInfo>, String> {
    blocking(move || {
        caption::save_key(&app, &engine, &key)?;
        Ok(caption::engines(&app))
    })
    .await?
}

/// Marks one service as the one auto caption uses.
#[tauri::command]
async fn choose_speech_engine(
    app: tauri::AppHandle,
    engine: String,
) -> Result<Vec<caption::EngineInfo>, String> {
    blocking(move || {
        caption::choose(&app, &engine)?;
        Ok(caption::engines(&app))
    })
    .await?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(RecorderState::default())
        .manage(bar::BarState::default())
        .manage(export::ExportState::default())
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
            audio_peaks,
            path_exists,
            list_windows,
            write_recovery,
            read_recovery,
            clear_recovery,
            write_overlay_image,
            export_timeline,
            cancel_export,
            cursor_track,
            can_track_cursor,
            write_captions,
            speech_engines,
            save_speech_key,
            choose_speech_engine,
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
