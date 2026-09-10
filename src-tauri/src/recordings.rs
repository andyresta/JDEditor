use crate::models::RecordingFile;
use tauri::Manager;

pub fn output_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let video_dir = app
        .path()
        .video_dir()
        .or_else(|_| app.path().app_data_dir())
        .map_err(|e| e.to_string())?;
    Ok(video_dir.join("JDEditor"))
}

pub fn list(app: &tauri::AppHandle) -> Result<Vec<RecordingFile>, String> {
    let dir = output_dir(app)?;
    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return Ok(Vec::new()),
    };

    let mut files: Vec<RecordingFile> = entries
        .filter_map(|entry| entry.ok())
        .filter(|entry| {
            entry
                .path()
                .extension()
                .and_then(|ext| ext.to_str())
                .map(|ext| ext.eq_ignore_ascii_case("mp4"))
                .unwrap_or(false)
        })
        .filter_map(|entry| {
            let metadata = entry.metadata().ok()?;
            let created = metadata
                .created()
                .or_else(|_| metadata.modified())
                .ok()?;
            let created_at: chrono::DateTime<chrono::Local> = created.into();
            Some(RecordingFile {
                path: entry.path().to_string_lossy().to_string(),
                name: entry.file_name().to_string_lossy().to_string(),
                size_bytes: metadata.len(),
                created_at: created_at.format("%Y-%m-%d %H:%M:%S").to_string(),
            })
        })
        .collect();

    files.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(files)
}

pub fn delete(path: &str) -> Result<(), String> {
    let is_mp4 = std::path::Path::new(path)
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.eq_ignore_ascii_case("mp4"))
        .unwrap_or(false);
    if !is_mp4 {
        return Err("Refusing to delete a non-recording file".to_string());
    }
    std::fs::remove_file(path).map_err(|e| e.to_string())
}
