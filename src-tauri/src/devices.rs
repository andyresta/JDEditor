use crate::models::{DeviceInfo, DeviceList, ScreenInfo};
use tauri::Manager;

/// Path to the ffmpeg binary to use: the bundled sidecar if one was shipped
/// with this build, otherwise whatever `ffmpeg` resolves to on PATH.
pub fn ffmpeg_path() -> Option<String> {
    if let Some(bundled) = crate::sidecar::resolve("ffmpeg") {
        return Some(bundled.to_string_lossy().to_string());
    }
    which::which("ffmpeg")
        .ok()
        .map(|p| p.to_string_lossy().to_string())
}

/// Enumerate displays using Tauri's cross-platform monitor API, then attach
/// the OS-specific identifier ffmpeg needs to actually grab that screen.
pub fn list_screens(app: &tauri::AppHandle) -> Result<Vec<ScreenInfo>, String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;

    let monitors = window.available_monitors().map_err(|e| e.to_string())?;
    let primary = window.primary_monitor().map_err(|e| e.to_string())?;

    let mut screens = Vec::with_capacity(monitors.len());
    for (i, m) in monitors.iter().enumerate() {
        let pos = m.position();
        let size = m.size();
        let is_primary = primary
            .as_ref()
            .map(|p| p.position() == pos && p.size() == size)
            .unwrap_or(i == 0);

        screens.push(ScreenInfo {
            id: i.to_string(),
            name: m
                .name()
                .cloned()
                .unwrap_or_else(|| format!("Display {}", i + 1)),
            x: pos.x,
            y: pos.y,
            width: size.width,
            height: size.height,
            is_primary,
        });
    }

    if screens.is_empty() {
        return Err("No displays detected".to_string());
    }
    Ok(screens)
}

/// The ffmpeg input source for a given monitor index (`ScreenInfo::id`
/// parsed back to `usize`). This is recomputed rather than cached on the
/// `ScreenInfo` because on Linux/Windows every monitor shares the same
/// underlying grab source and only the offset/size (from `ScreenInfo`)
/// differ between them.
#[cfg(target_os = "linux")]
pub fn screen_grab_source(_index: usize) -> String {
    // A single X display renders every monitor as one virtual surface, so
    // every monitor shares the same grab source; the per-monitor offset and
    // size (from ScreenInfo) select the right region out of it.
    std::env::var("DISPLAY").unwrap_or_else(|_| ":0.0".to_string())
}

#[cfg(target_os = "windows")]
pub fn screen_grab_source(_index: usize) -> String {
    // gdigrab always captures the full virtual desktop; ScreenInfo's
    // x/y/width/height picks out the monitor's region within it.
    "desktop".to_string()
}

#[cfg(target_os = "macos")]
pub fn screen_grab_source(index: usize) -> String {
    // avfoundation numbers "Capture screen N" devices in display order; this
    // assumes that order matches the monitor enumeration order.
    index.to_string()
}

pub fn list_all(app: &tauri::AppHandle) -> Result<DeviceList, String> {
    // Webcams and audio inputs come from a single probe (one ffmpeg spawn)
    // on platforms where both are read off the same device-listing command,
    // instead of running that probe twice.
    let (webcams, audio_inputs) = platform::list_capture_devices();
    Ok(DeviceList {
        screens: list_screens(app)?,
        webcams,
        audio_inputs,
    })
}

/// Raw output from the OS-specific device-listing command, for diagnosing
/// "no webcams/audio detected" reports without having to guess blindly at
/// what a user's `ffmpeg -list_devices`/`pactl` output actually looks like.
pub fn debug_dump() -> String {
    platform::debug_dump()
}

#[cfg(target_os = "linux")]
mod platform {
    use super::*;
    use std::fs;
    use std::process::Command;

    pub fn list_webcams() -> Result<Vec<DeviceInfo>, String> {
        let mut devices = Vec::new();
        let entries = match fs::read_dir("/dev") {
            Ok(e) => e,
            Err(_) => return Ok(devices),
        };

        let mut video_nodes: Vec<String> = entries
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|name| name.starts_with("video"))
            .collect();
        video_nodes.sort_by_key(|n| {
            n.trim_start_matches("video")
                .parse::<u32>()
                .unwrap_or(u32::MAX)
        });

        for node in video_nodes {
            let sys_name_path = format!("/sys/class/video4linux/{}/name", node);
            let name = fs::read_to_string(&sys_name_path)
                .map(|s| s.trim().to_string())
                .unwrap_or_else(|_| node.clone());
            devices.push(DeviceInfo {
                id: format!("/dev/{}", node),
                name,
            });
        }
        Ok(devices)
    }

    pub fn list_audio_inputs() -> Result<Vec<DeviceInfo>, String> {
        // `pactl list sources` gives verbose blocks with a Name: and a
        // Description: line for each source; sources ending in
        // ".monitor" are loopback/output monitors rather than real mics.
        let output = Command::new("pactl")
            .args(["list", "sources"])
            .output()
            .map_err(|e| format!("failed to run pactl: {e}"))?;
        if !output.status.success() {
            return Ok(Vec::new());
        }
        let text = String::from_utf8_lossy(&output.stdout);

        let mut devices = Vec::new();
        let mut current_name: Option<String> = None;
        for line in text.lines() {
            let line = line.trim();
            if let Some(rest) = line.strip_prefix("Name: ") {
                current_name = Some(rest.trim().to_string());
            } else if let Some(rest) = line.strip_prefix("Description: ") {
                if let Some(name) = current_name.take() {
                    if !name.ends_with(".monitor") {
                        devices.push(DeviceInfo {
                            id: name,
                            name: rest.trim().to_string(),
                        });
                    }
                }
            }
        }
        Ok(devices)
    }

    /// Video and audio are read from separate, independently-cheap sources
    /// on Linux (`/dev/video*` nodes, `pactl`), so there's no shared probe
    /// to dedupe here — just run both.
    pub fn list_capture_devices() -> (Vec<DeviceInfo>, Vec<DeviceInfo>) {
        (
            list_webcams().unwrap_or_default(),
            list_audio_inputs().unwrap_or_default(),
        )
    }

    pub fn debug_dump() -> String {
        let video_dir = fs::read_dir("/dev")
            .map(|entries| {
                entries
                    .filter_map(|e| e.ok())
                    .map(|e| e.file_name().to_string_lossy().to_string())
                    .filter(|name| name.starts_with("video"))
                    .collect::<Vec<_>>()
                    .join(", ")
            })
            .unwrap_or_else(|e| format!("(failed to read /dev: {e})"));

        let pactl_output = Command::new("pactl")
            .args(["list", "sources"])
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
            .unwrap_or_else(|e| format!("(failed to run pactl: {e})"));

        format!(
            "/dev/video* nodes: [{video_dir}]\n\n--- pactl list sources ---\n{pactl_output}"
        )
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use super::*;

    /// `ffmpeg -f avfoundation -list_devices true -i ""` prints the device
    /// list to stderr and then exits non-zero (no capture was requested).
    fn avfoundation_listing() -> Result<String, String> {
        let output = crate::sidecar::command("ffmpeg")
            .args(["-f", "avfoundation", "-list_devices", "true", "-i", ""])
            .output()
            .map_err(|e| format!("failed to run ffmpeg: {e}"))?;
        Ok(String::from_utf8_lossy(&output.stderr).to_string())
    }

    /// Both device kinds are printed by the same `-list_devices` probe, so
    /// run it once and parse both sections out of the one result rather
    /// than spawning ffmpeg twice.
    pub fn list_capture_devices() -> (Vec<DeviceInfo>, Vec<DeviceInfo>) {
        let text = match avfoundation_listing() {
            Ok(text) => text,
            Err(_) => return (Vec::new(), Vec::new()),
        };

        let webcams = parse_avfoundation_section(&text, "video devices")
            .into_iter()
            .filter(|(_, name)| !name.starts_with("Capture screen"))
            .map(|(id, name)| DeviceInfo { id, name })
            .collect();
        let audio_inputs = parse_avfoundation_section(&text, "audio devices")
            .into_iter()
            .map(|(id, name)| DeviceInfo { id, name })
            .collect();
        (webcams, audio_inputs)
    }

    /// Parses lines like `[[idx]] Some Device Name` under a
    /// `AVFoundation <section> devices:` heading. Stays in the section
    /// until the *other* section's heading appears (or the text ends),
    /// skipping over any stray non-device lines rather than stopping at
    /// the first one — ffmpeg builds/log levels aren't perfectly uniform.
    fn parse_avfoundation_section(text: &str, section: &str) -> Vec<(String, String)> {
        const HEADINGS: [&str; 2] = ["video devices", "audio devices"];
        let mut in_section = false;
        let mut out = Vec::new();
        for line in text.lines() {
            if line.contains(section) {
                in_section = true;
                continue;
            }
            if !in_section {
                continue;
            }
            if HEADINGS.iter().any(|h| *h != section && line.contains(h)) {
                break;
            }
            if let Some(start) = line.find('[') {
                if let Some(bracket_end) = line[start + 1..].find(']') {
                    let idx_str = &line[start + 1..start + 1 + bracket_end];
                    if let Ok(idx) = idx_str.parse::<u32>() {
                        let name = line[start + 1 + bracket_end + 1..].trim().to_string();
                        out.push((idx.to_string(), name));
                    }
                }
            }
        }
        out
    }

    pub fn debug_dump() -> String {
        match avfoundation_listing() {
            Ok(text) if !text.trim().is_empty() => text,
            Ok(_) => "ffmpeg ran but produced no output on stderr.".to_string(),
            Err(e) => format!("Failed to run ffmpeg: {e}"),
        }
    }
}

#[cfg(target_os = "windows")]
mod platform {
    use super::*;

    /// `ffmpeg -list_devices true -f dshow -i dummy` prints devices to
    /// stderr under two headings, each entry as a quoted name.
    fn dshow_listing() -> Result<String, String> {
        let output = crate::sidecar::command("ffmpeg")
            .args(["-list_devices", "true", "-f", "dshow", "-i", "dummy"])
            .output()
            .map_err(|e| format!("failed to run ffmpeg: {e}"))?;
        Ok(String::from_utf8_lossy(&output.stderr).to_string())
    }

    /// Both device kinds are printed by the same `-list_devices` probe, so
    /// run it once and parse both kinds out of the one result rather than
    /// spawning ffmpeg twice.
    pub fn list_capture_devices() -> (Vec<DeviceInfo>, Vec<DeviceInfo>) {
        let text = match dshow_listing() {
            Ok(text) => text,
            Err(_) => return (Vec::new(), Vec::new()),
        };
        let (video, audio) = parse_dshow_devices(&text);
        let to_devices = |names: Vec<String>| {
            names
                .into_iter()
                .map(|name| DeviceInfo {
                    id: name.clone(),
                    name,
                })
                .collect()
        };
        (to_devices(video), to_devices(audio))
    }

    /// Parses ffmpeg's dshow device listing. This comes in two formats
    /// depending on the ffmpeg build:
    ///   - Older builds group devices under "DirectShow video devices" /
    ///     "DirectShow audio devices" headings, with no per-device kind
    ///     marker.
    ///   - Newer builds (seen starting around ffmpeg N-126492) drop those
    ///     headings entirely and instead tag each device inline, e.g.
    ///     `"Mic Name" (audio)`, printing "Could not enumerate video
    ///     devices (or none found)." when a kind has no devices.
    /// The inline `(video)`/`(audio)` tag is preferred when present; the
    /// heading-based section is used as a fallback for older output that
    /// has no such tag, so both formats are understood in one pass.
    fn parse_dshow_devices(text: &str) -> (Vec<String>, Vec<String>) {
        let mut in_video_section = false;
        let mut in_audio_section = false;
        let mut video = Vec::new();
        let mut audio = Vec::new();

        for line in text.lines() {
            if line.contains("DirectShow video devices") {
                in_video_section = true;
                in_audio_section = false;
                continue;
            }
            if line.contains("DirectShow audio devices") {
                in_audio_section = true;
                in_video_section = false;
                continue;
            }
            if line.contains("Alternative name") {
                continue;
            }

            let Some(start) = line.find('"') else { continue };
            let Some(end) = line[start + 1..].find('"') else { continue };
            let name = line[start + 1..start + 1 + end].to_string();
            let rest = &line[start + 1 + end + 1..];

            if rest.contains("(video)") {
                video.push(name);
            } else if rest.contains("(audio)") {
                audio.push(name);
            } else if in_video_section {
                video.push(name);
            } else if in_audio_section {
                audio.push(name);
            }
        }
        (video, audio)
    }

    pub fn debug_dump() -> String {
        match dshow_listing() {
            Ok(text) if !text.trim().is_empty() => text,
            Ok(_) => "ffmpeg ran but produced no output on stderr.".to_string(),
            Err(e) => format!("Failed to run ffmpeg: {e}"),
        }
    }
}

/* ------------------------------------------------------- open windows */

/// A window on screen that could be recorded on its own.
#[derive(Debug, Clone, serde::Serialize)]
pub struct WindowInfo {
    /// What the capture is asked for by name. Windows are matched by their
    /// title bar, which is also the only thing a person recognises them by.
    pub title: String,
    /// The program it belongs to, for telling two windows of the same name
    /// apart in the list.
    pub app: String,
}

/// Every window with a title bar, as the capture would find them.
///
/// Read by asking the system for its processes and keeping the ones that
/// have a main window with a name. That is exactly the set a capture can
/// be pointed at: a window with no title cannot be named, and one with no
/// window cannot be recorded.
#[cfg(target_os = "windows")]
pub fn list_windows() -> Vec<WindowInfo> {
    use std::process::Command;

    let script = "Get-Process \
        | Where-Object { $_.MainWindowTitle -ne '' } \
        | Select-Object MainWindowTitle, ProcessName \
        | ConvertTo-Json -Compress";

    let mut command = Command::new("powershell");
    command.args(["-NoProfile", "-NonInteractive", "-Command", script]);
    {
        use std::os::windows::process::CommandExt;
        // The same reason ffmpeg is started this way: a console flashing
        // over the screen is a console flashing into the recording.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let Ok(output) = command.output() else {
        return Vec::new();
    };
    let text = String::from_utf8_lossy(&output.stdout);
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(text.trim()) else {
        return Vec::new();
    };

    // One window comes back as an object rather than a list of one.
    let rows = match &parsed {
        serde_json::Value::Array(rows) => rows.clone(),
        other => vec![other.clone()],
    };

    let mut windows: Vec<WindowInfo> = rows
        .iter()
        .filter_map(|row| {
            let title = row.get("MainWindowTitle")?.as_str()?.trim().to_string();
            if title.is_empty() {
                return None;
            }
            let app = row
                .get("ProcessName")
                .and_then(|name| name.as_str())
                .unwrap_or("")
                .to_string();
            Some(WindowInfo { title, app })
        })
        .collect();

    windows.sort_by(|a, b| a.title.to_lowercase().cmp(&b.title.to_lowercase()));
    windows.dedup_by(|a, b| a.title == b.title);
    windows
}

/// Nothing to offer: capturing one window is a Windows feature here, and a
/// list of windows that could not be recorded would only mislead.
#[cfg(not(target_os = "windows"))]
pub fn list_windows() -> Vec<WindowInfo> {
    Vec::new()
}
