use serde::{Deserialize, Serialize};
use std::path::PathBuf;
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
    /// Frames a second, so stepping the playhead by one lands on a frame
    /// rather than on a guess.
    pub frame_rate: Option<f64>,
    pub thumbnail_path: Option<String>,
}

pub fn prepare(app: &tauri::AppHandle, path: &str) -> Result<MediaPrepared, String> {
    if !std::path::Path::new(path).exists() {
        return Err("File not found".to_string());
    }

    let probed = probe(path).unwrap_or_default();
    let thumbnail_path = generate_thumbnail(app, path).ok();

    Ok(MediaPrepared {
        duration_seconds: probed.duration_seconds,
        width: probed.width,
        height: probed.height,
        frame_rate: probed.frame_rate,
        thumbnail_path,
    })
}

/// What `ffprobe` could be persuaded to say about a file.
#[derive(Debug, Clone, Default)]
struct Probed {
    duration_seconds: Option<f64>,
    width: Option<u32>,
    height: Option<u32>,
    frame_rate: Option<f64>,
}

/// ffprobe reports a rate as a ratio — "30000/1001" for 29.97 — because
/// most of them cannot be written exactly any other way.
fn parse_frame_rate(text: &str) -> Option<f64> {
    let (top, bottom) = text.split_once('/')?;
    let top: f64 = top.parse().ok()?;
    let bottom: f64 = bottom.parse().ok()?;
    if bottom <= 0.0 || top <= 0.0 {
        return None;
    }
    Some(top / bottom)
}

/// Runs `ffprobe` and pulls what the editor needs out of its JSON report.
/// Returns `None` (rather than erroring) if ffprobe isn't available or the
/// output can't be parsed.
fn probe(path: &str) -> Option<Probed> {
    let output = crate::sidecar::command("ffprobe")
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
    // `avg_frame_rate` over `r_frame_rate`: a screen recording is captured
    // at whatever rate the screen managed, and the average is the honest
    // answer where the nominal one is often 1000.
    let frame_rate = video_stream
        .and_then(|s| {
            s["avg_frame_rate"]
                .as_str()
                .and_then(parse_frame_rate)
                .or_else(|| s["r_frame_rate"].as_str().and_then(parse_frame_rate))
        })
        .filter(|rate| *rate > 0.5 && *rate <= 480.0);

    Some(Probed {
        duration_seconds: duration,
        width,
        height,
        frame_rate,
    })
}

#[cfg(test)]
mod tests {
    #[test]
    fn reads_the_ratios_ffprobe_reports() {
        assert_eq!(super::parse_frame_rate("30/1"), Some(30.0));
        let ntsc = super::parse_frame_rate("30000/1001").unwrap();
        assert!((ntsc - 29.97).abs() < 0.01, "{ntsc}");
        // A file with no video stream reports 0/0.
        assert_eq!(super::parse_frame_rate("0/0"), None);
        assert_eq!(super::parse_frame_rate("not a ratio"), None);
    }
}

/// Extracts a single frame ~1s into the clip as a small JPEG, cached under
/// the app's cache directory so re-opening the same file is instant.
/// How wide a frame is made for a model to look at.
///
/// Wide enough to read a line of text in a screen recording, small enough
/// that a handful of them is not a bill. A model charges by the size of
/// the picture, and one at the full width of a 4K recording costs several
/// times what it is worth for "what is on screen here".
const LOOK_WIDTH: u32 = 960;

/// A single frame from a moment in a file.
///
/// The thumbnail generator with the second it takes made an argument:
/// that one is fixed at a second in and 320 pixels wide, because it is
/// for a row in a list. This one is for being looked at.
///
/// `-ss` before `-i` on purpose — it seeks to roughly the right place and
/// decodes from there, rather than decoding from the beginning of the
/// file and throwing the result away. On an hour-long recording that is
/// the difference between a moment and a minute.
///
/// Kept in the cache under the moment it came from, so asking twice about
/// the same second costs one decode.
pub fn frame_at(app: &tauri::AppHandle, path: &str, seconds: f64) -> Result<String, String> {
    if !seconds.is_finite() || seconds < 0.0 {
        return Err("A frame has to come from a moment in the file.".to_string());
    }

    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("frames");
    std::fs::create_dir_all(&cache_dir).map_err(|e| e.to_string())?;

    // The file and the moment together, so two files that happen to share
    // a name cannot be handed each other's frames.
    let stem = std::path::Path::new(path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("frame");
    let safe: String = stem
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let out_path: PathBuf = cache_dir.join(format!(
        "{safe}-{}-{:.3}.jpg",
        short_hash(path),
        seconds
    ));

    if out_path.exists() {
        return Ok(out_path.to_string_lossy().to_string());
    }

    let output = crate::sidecar::command("ffmpeg")
        .args(["-y", "-ss", &format!("{seconds:.3}"), "-i", path])
        .args([
            "-frames:v",
            "1",
            "-vf",
            &format!("scale={LOOK_WIDTH}:-2"),
            "-q:v",
            "5",
        ])
        .arg(&out_path)
        .output()
        .map_err(|e| format!("failed to run ffmpeg: {e}"))?;

    if !output.status.success() || !out_path.exists() {
        // A moment past the end of the file is the usual reason, and it
        // is worth saying which moment rather than "it failed".
        return Err(format!(
            "No frame could be taken from {path} at {seconds:.2}s."
        ));
    }

    Ok(out_path.to_string_lossy().to_string())
}

/// Enough of a hash to tell two paths apart in a file name.
fn short_hash(text: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    text.hash(&mut hasher);
    format!("{:08x}", hasher.finish() as u32)
}

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

    let output = crate::sidecar::command("ffmpeg")
        .args(["-y", "-ss", "1", "-i", path, "-frames:v", "1", "-vf", "scale=320:-1", "-q:v", "4"])
        .arg(&out_path)
        .output()
        .map_err(|e| format!("failed to run ffmpeg: {e}"))?;

    if !output.status.success() || !out_path.exists() {
        return Err("thumbnail generation failed".to_string());
    }

    Ok(out_path.to_string_lossy().to_string())
}
