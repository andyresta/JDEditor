use crate::devices;
use crate::models::{RecordingConfig, RecordingStatus, Rect, ScreenInfo};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::Manager;

/// One ffmpeg run, writing one piece of the recording.
struct Segment {
    child: Child,
    path: PathBuf,
    started_at: Instant,
    meter: Option<crate::meter::Meter>,
}

/// A recording in progress. Pausing is done by ending the current segment
/// and resuming by starting the next one, with the segments joined into a
/// single file on stop. Suspending ffmpeg instead would leave the paused
/// stretch in the output as a frozen gap, since its input timestamps come
/// from the wall clock.
pub struct RecordingSession {
    config: RecordingConfig,
    screen: ScreenInfo,
    screen_index: usize,
    /// Where the joined recording ends up. Only exists once stopped.
    output_path: PathBuf,
    /// Holds the individual segments until they're joined.
    parts_dir: PathBuf,
    finished: Vec<PathBuf>,
    /// Recorded time in `finished`, so the elapsed counter reports how
    /// much was recorded rather than how long ago it started.
    recorded_before: Duration,
    active: Option<Segment>,
}

#[derive(Default)]
pub struct RecorderState(pub Mutex<Option<RecordingSession>>);

impl RecordingSession {
    fn start_segment(&mut self) -> Result<(), String> {
        std::fs::create_dir_all(&self.parts_dir).map_err(|e| e.to_string())?;
        let path = self
            .parts_dir
            .join(format!("part-{:03}.mp4", self.finished.len() + 1));
        let args = build_ffmpeg_args(&self.config, &self.screen, self.screen_index, &path)?;
        let child = spawn_ffmpeg(&args, &path.with_extension("log"))?;

        // The level meter is a nice-to-have on top of the recording, so a
        // microphone that won't open twice costs the meter, not the take.
        let meter = match (self.config.include_audio, self.config.audio_id.as_deref()) {
            (true, Some(id)) => crate::meter::start(&audio_input(id, AudioLatency::Low)),
            _ => None,
        };

        self.active = Some(Segment {
            child,
            path,
            started_at: Instant::now(),
            meter,
        });
        Ok(())
    }

    /// Ends the segment ffmpeg is writing right now, banking both its file
    /// and its duration. Leaves the session paused.
    fn end_segment(&mut self) {
        let Some(mut segment) = self.active.take() else {
            return;
        };
        self.recorded_before += segment.started_at.elapsed();
        if let Some(meter) = segment.meter.as_mut() {
            meter.stop();
        }
        quit_ffmpeg(&mut segment.child);
        self.finished.push(segment.path);
    }

    fn elapsed(&self) -> Duration {
        self.recorded_before
            + self
                .active
                .as_ref()
                .map(|s| s.started_at.elapsed())
                .unwrap_or_default()
    }

    /// Joins the recorded segments into `output_path` and clears the
    /// working files away. A lone segment is just moved into place; several
    /// are concatenated without re-encoding, which is safe because every
    /// segment was produced with identical settings.
    /// Removes every file this recording produced, leaving nothing behind.
    fn discard(&mut self) {
        for part in std::mem::take(&mut self.finished) {
            let _ = std::fs::remove_file(part.with_extension("log"));
            let _ = std::fs::remove_file(part);
        }
        let _ = std::fs::remove_dir(&self.parts_dir);
    }

    fn finish(&mut self) -> Result<String, String> {
        let parts = std::mem::take(&mut self.finished);
        let first = parts
            .first()
            .ok_or_else(|| "Nothing was recorded".to_string())?;

        // An empty segment means ffmpeg never got as far as writing
        // anything — the mp4 muxer buffers the first few seconds, so a
        // failed or hard-killed run leaves a 0-byte file. Report why
        // instead of handing an unplayable file to the editor, and leave
        // the working files in place to be looked at.
        for part in &parts {
            if std::fs::metadata(part).map(|m| m.len()).unwrap_or(0) == 0 {
                return Err(format!(
                    "ffmpeg produced an empty recording. It reported:\n{}",
                    log_tail(&part.with_extension("log"))
                ));
            }
        }

        if parts.len() == 1 {
            std::fs::rename(first, &self.output_path)
                .map_err(|e| format!("failed to save the recording: {e}"))?;
        } else {
            concat_segments(&parts, &self.output_path, &self.parts_dir)?;
            for part in &parts {
                let _ = std::fs::remove_file(part);
            }
        }
        for part in &parts {
            let _ = std::fs::remove_file(part.with_extension("log"));
        }
        let _ = std::fs::remove_dir(&self.parts_dir);

        Ok(self.output_path.to_string_lossy().to_string())
    }
}

pub fn status(app: &tauri::AppHandle) -> RecordingStatus {
    let state = app.state::<RecorderState>();
    let mut guard = state.0.lock().unwrap();

    let ffmpeg_ended = match guard.as_mut() {
        None => return idle_status(),
        Some(session) => session
            .active
            .as_mut()
            .is_some_and(|segment| matches!(segment.child.try_wait(), Ok(Some(_)))),
    };

    // ffmpeg can also stop on its own (bad capture settings, disk full,
    // capture device pulled). Wrap the recording up in that case rather
    // than reporting a live recording whose process is already gone.
    if ffmpeg_ended {
        let mut session = guard.take().expect("session present");
        session.end_segment();

        return match session.finish() {
            Ok(path) => RecordingStatus {
                is_recording: false,
                is_paused: false,
                elapsed_seconds: 0,
                output_path: Some(path),
                error: None,
                audio_level: None,
            },
            Err(e) => RecordingStatus {
                is_recording: false,
                is_paused: false,
                elapsed_seconds: 0,
                output_path: None,
                // `e` already carries what ffmpeg reported.
                error: Some(format!("Recording stopped: {e}")),
                audio_level: None,
            },
        };
    }

    let session = guard.as_ref().expect("session present");
    let active = session.active.as_ref();
    RecordingStatus {
        is_recording: true,
        is_paused: active.is_none(),
        elapsed_seconds: session.elapsed().as_secs(),
        output_path: Some(session.output_path.to_string_lossy().to_string()),
        error: None,
        audio_level: active.and_then(|s| s.meter.as_ref()).map(|m| m.level()),
    }
}

fn idle_status() -> RecordingStatus {
    RecordingStatus {
        is_recording: false,
        is_paused: false,
        elapsed_seconds: 0,
        output_path: None,
        error: None,
        audio_level: None,
    }
}

pub fn start(app: &tauri::AppHandle, config: RecordingConfig) -> Result<String, String> {
    let state = app.state::<RecorderState>();
    let mut guard = state.0.lock().unwrap();
    if guard.is_some() {
        return Err("A recording is already in progress".to_string());
    }

    if devices::ffmpeg_path().is_none() {
        return Err(
            "ffmpeg was not found on PATH. Install ffmpeg and make sure it is available in your system PATH."
                .to_string(),
        );
    }

    let screens = devices::list_screens(app)?;
    let screen_index: usize = config
        .screen_id
        .parse()
        .map_err(|_| "invalid screen_id".to_string())?;
    let screen = screens
        .get(screen_index)
        .ok_or_else(|| "selected screen not found".to_string())?
        .clone();

    let output_dir = resolve_output_dir(app, config.output_dir.as_deref())?;
    std::fs::create_dir_all(&output_dir).map_err(|e| e.to_string())?;
    let filename = timestamped_filename();

    let mut session = RecordingSession {
        config,
        screen,
        screen_index,
        parts_dir: output_dir.join(format!(".{filename}.parts")),
        output_path: output_dir.join(&filename),
        finished: Vec::new(),
        recorded_before: Duration::ZERO,
        active: None,
    };
    if let Err(e) = session.start_segment() {
        // Nothing was recorded, so don't leave the working directory behind.
        let _ = std::fs::remove_dir(&session.parts_dir);
        return Err(e);
    }

    let path = session.output_path.to_string_lossy().to_string();
    *guard = Some(session);
    Ok(path)
}

pub fn pause(app: &tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<RecorderState>();
    let mut guard = state.0.lock().unwrap();
    let session = guard
        .as_mut()
        .ok_or_else(|| "No recording is in progress".to_string())?;

    session.end_segment();
    Ok(())
}

pub fn resume(app: &tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<RecorderState>();
    let mut guard = state.0.lock().unwrap();
    let session = guard
        .as_mut()
        .ok_or_else(|| "No recording is in progress".to_string())?;

    if session.active.is_some() {
        return Ok(());
    }
    session.start_segment()
}

/// Kills any capture still running, without waiting for ffmpeg to shut
/// down cleanly. Meant for application exit: the alternative is ffmpeg
/// outliving the app, which leaves it recording to a file nobody will
/// finish and holding its own executable open — enough to block the next
/// build of this project.
pub fn abort_on_exit(app: &tauri::AppHandle) {
    let state = app.state::<RecorderState>();
    let Ok(mut guard) = state.0.lock() else {
        return;
    };
    let Some(session) = guard.as_mut() else {
        return;
    };
    let Some(segment) = session.active.as_mut() else {
        return;
    };

    if let Some(meter) = segment.meter.as_mut() {
        meter.stop();
    }
    let _ = segment.child.kill();
    let _ = segment.child.wait();
}

/// Stops the recording and throws it away, so nothing is left on disk.
pub fn discard(app: &tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<RecorderState>();
    let mut session = {
        let mut guard = state.0.lock().unwrap();
        guard
            .take()
            .ok_or_else(|| "No recording is in progress".to_string())?
    };

    session.end_segment();
    session.discard();
    Ok(())
}

pub fn stop(app: &tauri::AppHandle) -> Result<String, String> {
    let state = app.state::<RecorderState>();
    let mut session = {
        let mut guard = state.0.lock().unwrap();
        guard
            .take()
            .ok_or_else(|| "No recording is in progress".to_string())?
    };

    session.end_segment();
    session.finish()
}

/// Starts ffmpeg with its output captured to `log_path`. ffmpeg explains
/// itself on stderr and nowhere else, so without this any failure — a
/// device that won't open, a capture region the encoder rejects — leaves
/// nothing behind but an empty file. The log goes to a file rather than a
/// pipe on purpose: nobody is draining it while the recording runs, and a
/// full pipe would block ffmpeg itself.
fn spawn_ffmpeg(args: &[String], log_path: &Path) -> Result<Child, String> {
    let mut log = std::fs::File::create(log_path).map_err(|e| e.to_string())?;
    let _ = writeln!(log, "ffmpeg {}\n", args.join(" "));
    drop(log);
    let log = std::fs::OpenOptions::new()
        .append(true)
        .open(log_path)
        .map_err(|e| e.to_string())?;

    let mut child = crate::sidecar::command("ffmpeg")
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::from(log))
        .spawn()
        .map_err(|e| format!("failed to start ffmpeg: {e}"))?;

    // Give ffmpeg a brief moment to fail fast on bad input args/devices.
    std::thread::sleep(Duration::from_millis(400));
    if let Ok(Some(exit)) = child.try_wait() {
        return Err(format!(
            "ffmpeg exited immediately (status: {exit}). It reported:\n{}",
            log_tail(log_path)
        ));
    }
    Ok(child)
}

/// The part of an ffmpeg log worth showing someone. Its progress lines are
/// carriage-return separated and endless, so those are dropped; and since
/// the line that actually explains a failure usually sits well above the
/// shutdown noise at the end of the file, the complaints are picked out
/// wherever they appear rather than just tailing it.
fn log_tail(log_path: &Path) -> String {
    const HINTS: [&str; 8] = [
        "error",
        "invalid",
        "could not",
        "failed",
        "not divisible",
        "no such",
        "denied",
        "unknown",
    ];
    const MAX_LINES: usize = 10;
    const MAX_CHARS: usize = 900;

    let text = std::fs::read_to_string(log_path).unwrap_or_default();
    let lines: Vec<&str> = text
        .split(['\n', '\r'])
        .map(str::trim)
        .filter(|line| {
            !line.is_empty() && !line.starts_with("frame=") && !line.starts_with("Press [")
        })
        .collect();

    let complaints = lines.iter().copied().filter(|line| {
        let lowered = line.to_lowercase();
        HINTS.iter().any(|hint| lowered.contains(hint))
    });
    let closing = lines.iter().copied().skip(lines.len().saturating_sub(3));

    // Earliest complaint first — that's the cause; everything after it is
    // usually just the consequences unwinding.
    let mut chosen: Vec<&str> = Vec::new();
    for line in complaints.chain(closing) {
        if !chosen.contains(&line) {
            chosen.push(line);
        }
    }
    chosen.truncate(MAX_LINES);

    if chosen.is_empty() {
        return format!("(nothing; see {})", log_path.display());
    }
    chosen.join("\n").chars().take(MAX_CHARS).collect()
}

/// Asks ffmpeg to shut down cleanly, so it writes a valid, playable file,
/// before resorting to a hard kill.
fn quit_ffmpeg(child: &mut Child) {
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(b"q");
        let _ = stdin.flush();
    }

    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(100));
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break;
            }
        }
    }
}

fn concat_segments(parts: &[PathBuf], output: &Path, parts_dir: &Path) -> Result<(), String> {
    let list_path = parts_dir.join("segments.txt");
    let list: String = parts
        .iter()
        .map(|part| {
            // The concat demuxer reads backslashes as escapes, and wants a
            // literal quote inside a quoted path written as '\''.
            let path = part
                .to_string_lossy()
                .replace('\\', "/")
                .replace('\'', "'\\''");
            format!("file '{path}'\n")
        })
        .collect();
    std::fs::write(&list_path, list).map_err(|e| e.to_string())?;

    let output = crate::sidecar::command("ffmpeg")
        .args(["-y", "-f", "concat", "-safe", "0", "-i"])
        .arg(&list_path)
        .args(["-c", "copy"])
        .arg(output)
        .output()
        .map_err(|e| format!("failed to run ffmpeg: {e}"))?;
    let _ = std::fs::remove_file(&list_path);

    if !output.status.success() {
        return Err("failed to join the recording's segments".to_string());
    }
    Ok(())
}

fn resolve_output_dir(app: &tauri::AppHandle, override_dir: Option<&str>) -> Result<PathBuf, String> {
    if let Some(dir) = override_dir {
        return Ok(PathBuf::from(dir));
    }
    let video_dir = app
        .path()
        .video_dir()
        .or_else(|_| app.path().app_data_dir())
        .map_err(|e| e.to_string())?;
    Ok(video_dir.join("JDEditor"))
}

fn timestamped_filename() -> String {
    chrono::Local::now()
        .format("JDEditor-%Y-%m-%d_%H-%M-%S.mp4")
        .to_string()
}

fn screen_input(config: &RecordingConfig, screen: &ScreenInfo, screen_index: usize) -> (Vec<String>, Option<String>) {
    let rect = config.area.unwrap_or(Rect {
        x: screen.x,
        y: screen.y,
        width: screen.width,
        height: screen.height,
    });

    // Trim the region to even dimensions. libx264's yuv420p needs both to
    // be even, and at source quality nothing scales the capture on its way
    // to the encoder — so an area dragged by hand, which is odd-sized
    // about half the time, would fail the encoder a couple of seconds in
    // (after the capture devices finish opening) and leave an empty file.
    let rect = Rect {
        width: rect.width & !1,
        height: rect.height & !1,
        ..rect
    };

    build_screen_input(config.fps, screen_index, rect)
}

#[cfg(target_os = "linux")]
fn build_screen_input(fps: u32, screen_index: usize, rect: Rect) -> (Vec<String>, Option<String>) {
    let source = devices::screen_grab_source(screen_index);
    let args = vec![
        "-f".into(),
        "x11grab".into(),
        "-framerate".into(),
        fps.to_string(),
        "-video_size".into(),
        format!("{}x{}", rect.width, rect.height),
        "-i".into(),
        format!("{}+{},{}", source, rect.x, rect.y),
    ];
    (args, None)
}

#[cfg(target_os = "windows")]
fn build_screen_input(fps: u32, screen_index: usize, rect: Rect) -> (Vec<String>, Option<String>) {
    let source = devices::screen_grab_source(screen_index);
    let args = vec![
        "-f".into(),
        "gdigrab".into(),
        "-framerate".into(),
        fps.to_string(),
        "-offset_x".into(),
        rect.x.to_string(),
        "-offset_y".into(),
        rect.y.to_string(),
        "-video_size".into(),
        format!("{}x{}", rect.width, rect.height),
        "-i".into(),
        source,
    ];
    (args, None)
}

#[cfg(target_os = "macos")]
fn build_screen_input(fps: u32, screen_index: usize, rect: Rect) -> (Vec<String>, Option<String>) {
    let source = devices::screen_grab_source(screen_index);
    let args = vec![
        "-f".into(),
        "avfoundation".into(),
        "-framerate".into(),
        fps.to_string(),
        "-i".into(),
        format!("{}:none", source),
    ];
    // avfoundation cannot offset-capture a sub-region, so any area
    // selection has to be cropped out of the full-screen capture afterwards.
    let crop = Some(format!(
        "crop={}:{}:{}:{}",
        rect.width, rect.height, rect.x, rect.y
    ));
    (args, crop)
}

#[cfg(target_os = "linux")]
fn webcam_input(fps: u32, device_id: &str) -> Vec<String> {
    vec![
        "-f".into(),
        "v4l2".into(),
        "-framerate".into(),
        fps.to_string(),
        "-i".into(),
        device_id.to_string(),
    ]
}

#[cfg(target_os = "windows")]
fn webcam_input(fps: u32, device_id: &str) -> Vec<String> {
    vec![
        "-f".into(),
        "dshow".into(),
        "-framerate".into(),
        fps.to_string(),
        "-i".into(),
        format!("video={device_id}"),
    ]
}

#[cfg(target_os = "macos")]
fn webcam_input(fps: u32, device_id: &str) -> Vec<String> {
    vec![
        "-f".into(),
        "avfoundation".into(),
        "-framerate".into(),
        fps.to_string(),
        "-i".into(),
        format!("{device_id}:none"),
    ]
}

/// How an audio capture should be tuned. The recording wants whatever
/// buffering the device is happiest with, since a starved buffer means
/// dropouts in the take. The level meter wants the opposite: the device's
/// default buffer is half a second on Windows, and that half second is
/// pure lag between making a sound and seeing the bar move.
#[derive(Clone, Copy, PartialEq)]
enum AudioLatency {
    Default,
    Low,
}

#[cfg(target_os = "linux")]
fn audio_input(device_id: &str, latency: AudioLatency) -> Vec<String> {
    let mut args = vec!["-f".to_string(), "pulse".to_string()];
    if latency == AudioLatency::Low {
        args.extend(["-fragment_size".to_string(), "1024".to_string()]);
    }
    args.extend(["-i".to_string(), device_id.to_string()]);
    args
}

#[cfg(target_os = "windows")]
fn audio_input(device_id: &str, latency: AudioLatency) -> Vec<String> {
    let mut args = vec!["-f".to_string(), "dshow".to_string()];
    if latency == AudioLatency::Low {
        args.extend(["-audio_buffer_size".to_string(), "50".to_string()]);
    }
    args.extend(["-i".to_string(), format!("audio={device_id}")]);
    args
}

#[cfg(target_os = "macos")]
fn audio_input(device_id: &str, _latency: AudioLatency) -> Vec<String> {
    // avfoundation has no buffer-size knob to turn here.
    vec![
        "-f".into(),
        "avfoundation".into(),
        "-i".into(),
        format!(":{device_id}"),
    ]
}

fn build_ffmpeg_args(
    config: &RecordingConfig,
    screen: &ScreenInfo,
    screen_index: usize,
    output_path: &Path,
) -> Result<Vec<String>, String> {
    let (screen_spec, screen_crop) = screen_input(config, screen, screen_index);

    let mut args: Vec<String> = vec!["-y".to_string()];
    args.extend(screen_spec);
    let screen_in = 0usize;
    let mut next_input = 1usize;

    let webcam_in = if config.include_webcam {
        let id = config
            .webcam_id
            .as_deref()
            .ok_or_else(|| "webcam_id is required when include_webcam is true".to_string())?;
        args.extend(webcam_input(config.fps, id));
        let idx = next_input;
        next_input += 1;
        Some(idx)
    } else {
        None
    };

    let audio_in = if config.include_audio {
        let id = config
            .audio_id
            .as_deref()
            .ok_or_else(|| "audio_id is required when include_audio is true".to_string())?;
        args.extend(audio_input(id, AudioLatency::Default));
        let idx = next_input;
        Some(idx)
    } else {
        None
    };

    // Both values come from one call so they can't be mixed up: this used
    // to bind the bitrate as the target height, which scaled every preset
    // up to thousands of pixels tall (and made "source" exceed what the
    // encoder accepts at all).
    let (target_height, bitrate) = config.quality.params();

    let mut screen_chain = format!("[{screen_in}:v]");
    if let Some(crop) = &screen_crop {
        screen_chain.push_str(crop);
        screen_chain.push(',');
    }
    if target_height > 0 {
        screen_chain.push_str(&format!("scale=-2:{target_height}"));
    } else {
        screen_chain.push_str("null");
    }

    let filter_complex = if let Some(cam_in) = webcam_in {
        format!(
            "{screen_chain}[screen];[{cam_in}:v]scale=320:-2[cam];[screen][cam]overlay=W-w-20:H-h-20[vout]"
        )
    } else {
        format!("{screen_chain}[vout]")
    };

    args.push("-filter_complex".to_string());
    args.push(filter_complex);
    args.push("-map".to_string());
    args.push("[vout]".to_string());

    args.push("-c:v".to_string());
    args.push("libx264".to_string());
    args.push("-preset".to_string());
    args.push("veryfast".to_string());
    args.push("-pix_fmt".to_string());
    args.push("yuv420p".to_string());
    args.push("-b:v".to_string());
    args.push(format!("{bitrate}k"));
    args.push("-r".to_string());
    args.push(config.fps.to_string());

    if let Some(a_in) = audio_in {
        args.push("-map".to_string());
        args.push(format!("{a_in}:a"));
        args.push("-c:a".to_string());
        args.push("aac".to_string());
        args.push("-b:a".to_string());
        args.push("160k".to_string());
    } else {
        args.push("-an".to_string());
    }

    args.push(output_path.to_string_lossy().to_string());

    Ok(args)
}
