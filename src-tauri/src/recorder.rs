use crate::devices;
use crate::models::{RecordingConfig, RecordingStatus, Rect, ScreenInfo};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Instant;
use tauri::Manager;

pub struct RecordingProcess {
    child: Child,
    output_path: PathBuf,
    started_at: Instant,
}

#[derive(Default)]
pub struct RecorderState(pub Mutex<Option<RecordingProcess>>);

pub fn status(state: &RecorderState) -> RecordingStatus {
    let mut guard = state.0.lock().unwrap();
    if let Some(proc) = guard.as_mut() {
        match proc.child.try_wait() {
            Ok(Some(_exit)) => {
                // The ffmpeg process ended on its own (e.g. disk full, device unplugged).
                let path = proc.output_path.to_string_lossy().to_string();
                *guard = None;
                return RecordingStatus {
                    is_recording: false,
                    elapsed_seconds: 0,
                    output_path: Some(path),
                };
            }
            Ok(None) => {
                return RecordingStatus {
                    is_recording: true,
                    elapsed_seconds: proc.started_at.elapsed().as_secs(),
                    output_path: Some(proc.output_path.to_string_lossy().to_string()),
                };
            }
            Err(_) => {}
        }
    }
    RecordingStatus {
        is_recording: false,
        elapsed_seconds: 0,
        output_path: None,
    }
}

pub fn start(
    app: &tauri::AppHandle,
    state: &RecorderState,
    config: RecordingConfig,
) -> Result<String, String> {
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
    let index: usize = config
        .screen_id
        .parse()
        .map_err(|_| "invalid screen_id".to_string())?;
    let screen = screens
        .get(index)
        .ok_or_else(|| "selected screen not found".to_string())?
        .clone();

    let output_dir = resolve_output_dir(app, config.output_dir.as_deref())?;
    std::fs::create_dir_all(&output_dir).map_err(|e| e.to_string())?;
    let output_path = output_dir.join(timestamped_filename());

    let args = build_ffmpeg_args(&config, &screen, index, &output_path)?;

    let mut child = Command::new(crate::sidecar::command_name("ffmpeg"))
        .args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("failed to start ffmpeg: {e}"))?;

    // Give ffmpeg a brief moment to fail fast on bad input args/devices.
    std::thread::sleep(std::time::Duration::from_millis(400));
    if let Ok(Some(exit)) = child.try_wait() {
        return Err(format!(
            "ffmpeg exited immediately (status: {exit}). Check that the selected devices are available and not in use by another app."
        ));
    }

    let path_string = output_path.to_string_lossy().to_string();
    *guard = Some(RecordingProcess {
        child,
        output_path,
        started_at: Instant::now(),
    });

    Ok(path_string)
}

pub fn stop(state: &RecorderState) -> Result<String, String> {
    let mut proc = {
        let mut guard = state.0.lock().unwrap();
        guard.take().ok_or_else(|| "No recording is in progress".to_string())?
    };

    let path = proc.output_path.to_string_lossy().to_string();

    // Ask ffmpeg to shut down cleanly (writes a valid, playable file) before
    // resorting to a hard kill.
    if let Some(mut stdin) = proc.child.stdin.take() {
        let _ = stdin.write_all(b"q");
        let _ = stdin.flush();
    }

    let deadline = Instant::now() + std::time::Duration::from_secs(5);
    loop {
        match proc.child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            _ => {
                let _ = proc.child.kill();
                let _ = proc.child.wait();
                break;
            }
        }
    }

    Ok(path)
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

#[cfg(target_os = "linux")]
fn audio_input(device_id: &str) -> Vec<String> {
    vec!["-f".into(), "pulse".into(), "-i".into(), device_id.to_string()]
}

#[cfg(target_os = "windows")]
fn audio_input(device_id: &str) -> Vec<String> {
    vec![
        "-f".into(),
        "dshow".into(),
        "-i".into(),
        format!("audio={device_id}"),
    ]
}

#[cfg(target_os = "macos")]
fn audio_input(device_id: &str) -> Vec<String> {
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
        args.extend(audio_input(id));
        let idx = next_input;
        Some(idx)
    } else {
        None
    };

    let (_, target_height) = config.quality.params();

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

    let bitrate = config.quality.params().1;
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
