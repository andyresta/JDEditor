use serde::{Deserialize, Serialize};

/// A capture-able display/monitor.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScreenInfo {
    /// Platform-specific identifier used when building the ffmpeg input
    /// (e.g. "0" on Linux/X11, an avfoundation index on macOS, or "desktop" on Windows).
    pub id: String,
    pub name: String,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub is_primary: bool,
}

/// A webcam or audio input device.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceInfo {
    /// Platform-specific identifier used when building the ffmpeg input
    /// (device path on Linux, avfoundation index on macOS, DirectShow name on Windows).
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum QualityPreset {
    Low,
    Medium,
    High,
    Source,
}

impl QualityPreset {
    /// (max output height in pixels (0 = no scaling), video bitrate in kbps)
    pub fn params(&self) -> (u32, u32) {
        match self {
            QualityPreset::Low => (480, 1_500),
            QualityPreset::Medium => (720, 4_000),
            QualityPreset::High => (1080, 8_000),
            QualityPreset::Source => (0, 12_000),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecordingConfig {
    /// Screen to capture. Required.
    pub screen_id: String,
    /// Optional region within the screen. None = full screen.
    pub area: Option<Rect>,
    /// One window, by its title bar, instead of the screen. The window is
    /// followed wherever it is moved to and whatever size it is made,
    /// because it is the window being captured rather than the patch of
    /// screen it happens to be over.
    #[serde(default)]
    pub window_title: Option<String>,
    /// The camera on its own, with no screen in the recording at all.
    #[serde(default)]
    pub camera_only: bool,

    /// Whether to write down where the mouse went while recording.
    ///
    /// Off unless asked for. What it costs is a reading of the pointer
    /// sixty times a second and a small file beside the recording; what
    /// it buys is the editor being able to zoom in on what was clicked
    /// without anyone having to mark it by hand. Absent in projects and
    /// bar setups saved before it existed, hence the default.
    #[serde(default)]
    pub track_cursor: bool,

    /// Whether to put a ring around the mouse while recording, so it can
    /// be followed on a busy screen. Drawn on the screen itself, in a
    /// window of its own, so the capture picks it up like anything else
    /// that was on screen — there is nothing for the editor or the
    /// renderer to reproduce afterwards.
    #[serde(default)]
    pub highlight_cursor: bool,

    pub include_webcam: bool,
    pub webcam_id: Option<String>,

    pub include_audio: bool,
    pub audio_id: Option<String>,

    pub quality: QualityPreset,
    pub fps: u32,

    /// Directory the output file is written to. Defaults to the app's video dir.
    pub output_dir: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecordingStatus {
    pub is_recording: bool,
    pub is_paused: bool,
    pub elapsed_seconds: u64,
    pub output_path: Option<String>,
    /// Why the recording stopped, when it stopped by itself because ffmpeg
    /// failed. Set instead of `output_path`, since there's no usable file.
    pub error: Option<String>,
    /// Microphone level, 0.0..=1.0, while audio is being recorded.
    pub audio_level: Option<f32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecordingFile {
    pub path: String,
    pub name: String,
    pub size_bytes: u64,
    pub created_at: String,
}

/// What the main window hands over when it opens the floating recorder
/// bar, which drives the recording from that point on.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BarSetup {
    pub config: RecordingConfig,
    /// Whether the bar should have the user drag out a region first
    /// ("Area" capture) rather than starting on the whole screen.
    pub pick_area: bool,
    /// Whether the app's own window stays on screen while recording.
    ///
    /// Normally it steps out of the way: nobody wants the recorder in
    /// their recording. But a recording *of* this app — showing the
    /// editor, demonstrating it, teaching it — needs it to stay exactly
    /// where it is. Absent in setups saved before the choice existed,
    /// hence the default.
    #[serde(default)]
    pub keep_app_on_screen: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceList {
    pub screens: Vec<ScreenInfo>,
    pub webcams: Vec<DeviceInfo>,
    pub audio_inputs: Vec<DeviceInfo>,
}
