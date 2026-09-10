use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::Command;
use tauri::Manager;

/// Best-effort metadata + a generated thumbnail for a media file, computed
/// off the main thread so the UI can show a "preparing" state in the
/// meantime. Every field is optional: a missing `ffprobe`/`ffmpeg` or an
/// unreadable file degrades gracefully instead of failing the whole
/// operation, since none of this is required to actually play the file.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct MediaPrepared {
    pub duration_seconds: Option<f64>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub thumbnail_path: Option<String>,
}

pub fn prepare(app: &tauri::AppHandle, path: &str) -> Result<MediaPrepared, String> {
    if !std::path::Path::new(path).exists() {
        return Err("File not found".to_string());
    }

    let (duration_seconds, width, height) = probe(path).unwrap_or((None, None, None));
    let thumbnail_path = generate_thumbnail(app, path).ok();

    Ok(MediaPrepared {
        duration_seconds,
        width,
        height,
        thumbnail_path,
    })
}

/// Runs `ffprobe` and pulls duration + video resolution out of its JSON
/// report. Returns `None` (rather than erroring) if ffprobe isn't
/// available or the output can't be parsed.
fn probe(path: &str) -> Option<(Option<f64>, Option<u32>, Option<u32>)> {
    let output = Command::new("ffprobe")
        .args([
            "-v",
            "error",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
            path,
        ])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let json: serde_json::Value = serde_json::from_slice(&output.stdout).ok()?;

    let duration = json["format"]["duration"]
        .as_str()
        .and_then(|s| s.parse::<f64>().ok());

    let video_stream = json["streams"]
        .as_array()
        .and_then(|streams| streams.iter().find(|s| s["codec_type"] == "video"));
    let width = video_stream.and_then(|s| s["width"].as_u64()).map(|w| w as u32);
    let height = video_stream.and_then(|s| s["height"].as_u64()).map(|h| h as u32);

    Some((duration, width, height))
}

/// Extracts a single frame ~1s into the clip as a small JPEG, cached under
/// the app's cache directory so re-opening the same file is instant.
fn generate_thumbnail(app: &tauri::AppHandle, path: &str) -> Result<String, String> {
    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("thumbnails");
    std::fs::create_dir_all(&cache_dir).map_err(|e| e.to_string())?;

    let stem = std::path::Path::new(path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("thumbnail");
    let out_path: PathBuf = cache_dir.join(format!("{stem}.jpg"));

    let output = Command::new("ffmpeg")
        .args(["-y", "-ss", "1", "-i", path, "-frames:v", "1", "-vf", "scale=320:-1", "-q:v", "4"])
        .arg(&out_path)
        .output()
        .map_err(|e| format!("failed to run ffmpeg: {e}"))?;

    if !output.status.success() || !out_path.exists() {
        return Err("thumbnail generation failed".to_string());
    }

    Ok(out_path.to_string_lossy().to_string())
}
