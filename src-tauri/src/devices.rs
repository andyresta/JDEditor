use crate::models::{DeviceInfo, DeviceList, ScreenInfo};
use std::process::Command;
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

pub fn list_webcams() -> Result<Vec<DeviceInfo>, String> {
    platform::list_webcams()
}

pub fn list_audio_inputs() -> Result<Vec<DeviceInfo>, String> {
    platform::list_audio_inputs()
}

pub fn list_all(app: &tauri::AppHandle) -> Result<DeviceList, String> {
    Ok(DeviceList {
        screens: list_screens(app)?,
        webcams: list_webcams().unwrap_or_default(),
        audio_inputs: list_audio_inputs().unwrap_or_default(),
    })
}

#[cfg(target_os = "linux")]
mod platform {
    use super::*;
    use std::fs;

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
}

#[cfg(target_os = "macos")]
mod platform {
    use super::*;

    /// `ffmpeg -f avfoundation -list_devices true -i ""` prints the device
    /// list to stderr and then exits non-zero (no capture was requested).
    fn avfoundation_listing() -> Result<String, String> {
        let output = Command::new(crate::sidecar::command_name("ffmpeg"))
            .args(["-f", "avfoundation", "-list_devices", "true", "-i", ""])
            .output()
            .map_err(|e| format!("failed to run ffmpeg: {e}"))?;
        Ok(String::from_utf8_lossy(&output.stderr).to_string())
    }

    pub fn list_webcams() -> Result<Vec<DeviceInfo>, String> {
        let text = avfoundation_listing()?;
        Ok(parse_avfoundation_section(&text, "video devices")
            .into_iter()
            .filter(|(_, name)| !name.starts_with("Capture screen"))
            .map(|(id, name)| DeviceInfo { id, name })
            .collect())
    }

    pub fn list_audio_inputs() -> Result<Vec<DeviceInfo>, String> {
        let text = avfoundation_listing()?;
        Ok(parse_avfoundation_section(&text, "audio devices")
            .into_iter()
            .map(|(id, name)| DeviceInfo { id, name })
            .collect())
    }

    /// Parses lines like `[[idx]] Some Device Name` under a
    /// `AVFoundation <section> devices:` heading.
    fn parse_avfoundation_section(text: &str, section: &str) -> Vec<(String, String)> {
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
            if let Some(start) = line.find('[') {
                if let Some(bracket_end) = line[start + 1..].find(']') {
                    let idx_str = &line[start + 1..start + 1 + bracket_end];
                    if let Ok(idx) = idx_str.parse::<u32>() {
                        let name = line[start + 1 + bracket_end + 1..].trim().to_string();
                        out.push((idx.to_string(), name));
                        continue;
                    }
                }
            }
            // A line that doesn't match `[idx] name` ends this section.
            if in_section && !line.contains('[') {
                break;
            }
        }
        out
    }
}

#[cfg(target_os = "windows")]
mod platform {
    use super::*;

    /// `ffmpeg -list_devices true -f dshow -i dummy` prints devices to
    /// stderr under two headings, each entry as a quoted name.
    fn dshow_listing() -> Result<String, String> {
        let output = Command::new(crate::sidecar::command_name("ffmpeg"))
            .args(["-list_devices", "true", "-f", "dshow", "-i", "dummy"])
            .output()
            .map_err(|e| format!("failed to run ffmpeg: {e}"))?;
        Ok(String::from_utf8_lossy(&output.stderr).to_string())
    }

    pub fn list_webcams() -> Result<Vec<DeviceInfo>, String> {
        let text = dshow_listing()?;
        Ok(parse_dshow_section(&text, "DirectShow video devices")
            .into_iter()
            .map(|name| DeviceInfo {
                id: name.clone(),
                name,
            })
            .collect())
    }

    pub fn list_audio_inputs() -> Result<Vec<DeviceInfo>, String> {
        let text = dshow_listing()?;
        Ok(parse_dshow_section(&text, "DirectShow audio devices")
            .into_iter()
            .map(|name| DeviceInfo {
                id: name.clone(),
                name,
            })
            .collect())
    }

    fn parse_dshow_section(text: &str, heading: &str) -> Vec<String> {
        let mut in_section = false;
        let mut out = Vec::new();
        for line in text.lines() {
            if line.contains(heading) {
                in_section = true;
                continue;
            }
            if !in_section {
                continue;
            }
            if line.contains("Alternative name") {
                continue;
            }
            if let Some(start) = line.find('"') {
                if let Some(end) = line[start + 1..].find('"') {
                    out.push(line[start + 1..start + 1 + end].to_string());
                    continue;
                }
            }
            // First non-matching, non-alternative-name line ends this section.
            break;
        }
        out
    }
}
