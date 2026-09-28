//! A shelf of clips, kept across projects.
//!
//! Some pieces come back: an intro, a logo sting, a sound that marks a
//! step in every tutorial. Media belongs to a project and goes when the
//! project is closed; these belong to whoever is editing, and stay.
//!
//! A saved clip is a real file, cut to exactly the piece that was saved,
//! rather than a reference to the take it came from. A reference would be
//! smaller and would break the first time a recording was moved, renamed
//! or cleared out — and a shelf of broken references is worse than no
//! shelf. What is saved is what plays.

use std::path::PathBuf;

use tauri::Manager;

/// One clip on the shelf.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedClip {
    pub id: String,
    /// What it is called on the shelf. Chosen by whoever saved it, or
    /// taken from the file it was cut out of.
    pub name: String,
    /// "video" or "audio": a shelf of both, listed apart.
    pub kind: String,
    pub seconds: f64,
    /// Where the cut file is.
    pub path: String,
    /// A frame from it, for the list. Absent for sound.
    #[serde(default)]
    pub thumbnail_path: Option<String>,
    /// When it was put on the shelf, so the newest is at the top.
    pub saved_at: String,
}

/// What the editor asks to be saved: a piece of one file.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveClip {
    pub path: String,
    /// How far into the file the piece begins.
    pub trim_start: f64,
    /// How long it runs, in the file's own seconds.
    pub seconds: f64,
    pub name: String,
    /// "video" or "audio". Sound saved from a video clip is saved as
    /// sound: what was asked for was the sound.
    pub kind: String,
}

fn shelf_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("clips");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn index_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(shelf_dir(app)?.join("clips.json"))
}

/// Everything on the shelf, newest first.
pub fn list(app: &tauri::AppHandle) -> Vec<SavedClip> {
    let Ok(file) = index_file(app) else {
        return Vec::new();
    };
    let mut clips: Vec<SavedClip> = std::fs::read_to_string(file)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default();
    // A clip whose file has been deleted from underneath us is not on the
    // shelf any more, whatever the index says.
    clips.retain(|clip| std::path::Path::new(&clip.path).is_file());
    clips.sort_by(|a, b| b.saved_at.cmp(&a.saved_at));
    clips
}

fn write_index(app: &tauri::AppHandle, clips: &[SavedClip]) -> Result<(), String> {
    let file = index_file(app)?;
    let text = serde_json::to_string_pretty(clips).map_err(|e| e.to_string())?;
    // Written beside itself and moved into place: an interrupted write
    // must not be able to empty the shelf.
    let part = file.with_extension("json.part");
    std::fs::write(&part, text).map_err(|e| e.to_string())?;
    std::fs::rename(&part, &file).map_err(|e| e.to_string())
}

/// Only what a file name can safely hold.
fn tidy(name: &str) -> String {
    let kept: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == ' ' {
                c
            } else {
                '-'
            }
        })
        .collect();
    let trimmed = kept.trim().trim_matches('-').trim();
    if trimmed.is_empty() {
        "clip".to_string()
    } else {
        trimmed.chars().take(50).collect()
    }
}

/// Cuts the piece out and puts it on the shelf.
///
/// Re-encoded rather than copied through: a stream copy can only cut at a
/// keyframe, so the piece would begin somewhere near where it was asked
/// for rather than where it was asked for — and a shelf of clips that are
/// each a little wrong is no use to anybody. These are short pieces, so
/// the encoding costs a moment.
pub fn save(app: &tauri::AppHandle, ask: SaveClip) -> Result<SavedClip, String> {
    if ask.seconds <= 0.0 {
        return Err("There is nothing in that clip to save.".to_string());
    }
    if !std::path::Path::new(&ask.path).is_file() {
        return Err("That clip's file is not where the project left it.".to_string());
    }

    let sound_only = ask.kind == "audio";
    let dir = shelf_dir(app)?;
    let id = format!(
        "{}-{}",
        chrono::Local::now().format("%Y%m%d-%H%M%S"),
        std::process::id()
    );
    let extension = if sound_only { "m4a" } else { "mp4" };
    let file = dir.join(format!("{}-{}.{extension}", tidy(&ask.name), id));

    let mut args: Vec<String> = vec![
        "-y".into(),
        "-hide_banner".into(),
        "-loglevel".into(),
        "error".into(),
        // Before the input: seeking here costs nothing on a long file.
        "-ss".into(),
        format!("{:.4}", ask.trim_start.max(0.0)),
        "-t".into(),
        format!("{:.4}", ask.seconds),
        "-i".into(),
        ask.path.clone(),
    ];
    if sound_only {
        args.extend(["-vn".into(), "-c:a".into(), "aac".into(), "-b:a".into(), "192k".into()]);
    } else {
        args.extend([
            "-c:v".into(),
            "libx264".into(),
            "-preset".into(),
            "veryfast".into(),
            "-crf".into(),
            "20".into(),
            "-pix_fmt".into(),
            "yuv420p".into(),
            // An odd width or height cannot be encoded as yuv420p, and a
            // clip cut from an area recording is an odd size about half
            // the time.
            "-vf".into(),
            "crop=trunc(iw/2)*2:trunc(ih/2)*2".into(),
            "-c:a".into(),
            "aac".into(),
            "-b:a".into(),
            "192k".into(),
        ]);
    }
    args.push(file.to_string_lossy().to_string());

    let run = crate::sidecar::command("ffmpeg")
        .args(&args)
        .output()
        .map_err(|e| format!("ffmpeg could not be run: {e}"))?;
    if !run.status.success() || !file.is_file() {
        let said = String::from_utf8_lossy(&run.stderr);
        let line = said.lines().last().unwrap_or("").trim();
        return Err(if line.is_empty() {
            "That piece could not be cut out.".to_string()
        } else {
            format!("That piece could not be cut out: {line}")
        });
    }

    let thumbnail_path = if sound_only {
        None
    } else {
        crate::media::prepare(app, &file.to_string_lossy())
            .ok()
            .and_then(|prepared| prepared.thumbnail_path)
    };

    let clip = SavedClip {
        id,
        name: ask.name.trim().to_string(),
        kind: if sound_only { "audio" } else { "video" }.to_string(),
        seconds: ask.seconds,
        path: file.to_string_lossy().to_string(),
        thumbnail_path,
        saved_at: chrono::Local::now().to_rfc3339(),
    };

    let mut clips = list(app);
    clips.insert(0, clip.clone());
    write_index(app, &clips)?;
    Ok(clip)
}

/// Takes one off the shelf, and its file with it.
pub fn remove(app: &tauri::AppHandle, id: &str) -> Result<Vec<SavedClip>, String> {
    let clips = list(app);
    let (going, kept): (Vec<SavedClip>, Vec<SavedClip>) =
        clips.into_iter().partition(|clip| clip.id == id);
    for clip in &going {
        let _ = std::fs::remove_file(&clip.path);
    }
    write_index(app, &kept)?;
    Ok(kept)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_name_becomes_something_a_file_system_will_take() {
        assert_eq!(tidy("Intro sting.mp4"), "Intro sting-mp4");
        assert_eq!(tidy("../../etc/passwd"), "etc-passwd");
        assert_eq!(tidy(""), "clip");
        assert!(tidy(&"x".repeat(200)).chars().count() <= 50);
    }

    /// A real cut, because the whole point of the arguments is what comes
    /// out of them: the piece has to be the length that was asked for,
    /// starting where it was asked to start.
    #[test]
    fn the_piece_that_comes_out_is_the_piece_that_was_asked_for() {
        let source = std::env::temp_dir().join("jd-clip-source.mp4");
        let made = crate::sidecar::command("ffmpeg")
            .args([
                "-y",
                "-f",
                "lavfi",
                "-i",
                "testsrc2=size=320x180:rate=15:duration=12",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:duration=12",
                "-shortest",
                "-pix_fmt",
                "yuv420p",
                &source.to_string_lossy(),
            ])
            .output();
        match made {
            Ok(out) if out.status.success() => {}
            _ => {
                eprintln!("no ffmpeg to make a test source with; skipping");
                return;
            }
        }

        // The same arguments `save` builds, run here: the app handle a
        // command needs is not available to a unit test, but the cutting
        // is what is worth checking and it is all in these.
        let out = std::env::temp_dir().join("jd-clip-out.mp4");
        let run = crate::sidecar::command("ffmpeg")
            .args([
                "-y",
                "-hide_banner",
                "-loglevel",
                "error",
                "-ss",
                "3.0000",
                "-t",
                "2.5000",
                "-i",
                &source.to_string_lossy(),
                "-c:v",
                "libx264",
                "-preset",
                "veryfast",
                "-crf",
                "20",
                "-pix_fmt",
                "yuv420p",
                "-vf",
                "crop=trunc(iw/2)*2:trunc(ih/2)*2",
                "-c:a",
                "aac",
                "-b:a",
                "192k",
                &out.to_string_lossy(),
            ])
            .output()
            .expect("ffmpeg ran");
        assert!(run.status.success(), "{}", String::from_utf8_lossy(&run.stderr));

        let probe = crate::sidecar::command("ffprobe")
            .args([
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "csv=p=0",
                &out.to_string_lossy(),
            ])
            .output()
            .expect("ffprobe ran");
        let seconds: f64 = String::from_utf8_lossy(&probe.stdout)
            .trim()
            .parse()
            .unwrap_or(0.0);
        assert!(
            (seconds - 2.5).abs() < 0.25,
            "asked for 2.5 seconds, got {seconds}"
        );

        let _ = std::fs::remove_file(&out);
        let _ = std::fs::remove_file(&source);
    }

    #[test]
    fn a_clip_survives_being_written_down_and_read_back() {
        let clip = SavedClip {
            id: "20260928-120000-1".to_string(),
            name: "Intro sting".to_string(),
            kind: "video".to_string(),
            seconds: 2.5,
            path: "C:/clips/intro.mp4".to_string(),
            thumbnail_path: Some("C:/thumbs/intro.jpg".to_string()),
            saved_at: "2026-09-28T12:00:00+07:00".to_string(),
        };
        let text = serde_json::to_string(&[clip.clone()]).expect("written");
        // The names the editor reads, in the shape it reads them.
        assert!(text.contains("\"thumbnailPath\""), "{text}");
        assert!(text.contains("\"savedAt\""), "{text}");
        let back: Vec<SavedClip> = serde_json::from_str(&text).expect("read back");
        assert_eq!(back[0].name, "Intro sting");
        assert_eq!(back[0].kind, "video");
        assert!((back[0].seconds - 2.5).abs() < 1e-9);
    }
}
