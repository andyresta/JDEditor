use std::io::{BufRead, BufReader};
use std::process::{Child, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;

/// A live microphone level, read from a second, audio-only ffmpeg that
/// prints RMS levels for the same device the recording is capturing.
/// Sharing one microphone between both processes works because capture is
/// opened in shared mode; where it isn't, the meter is simply absent and
/// the recording carries on without it.
pub struct Meter {
    child: Child,
    /// The latest level as `f32` bits, written by the reader thread.
    level: Arc<AtomicU32>,
}

/// Quietest level the meter bothers showing. Speech sits around -30dB, so
/// this keeps the bar moving over the range that actually matters.
const FLOOR_DB: f32 = -60.0;

/// Starts metering the device described by `audio_input_args` (the same
/// platform-specific input the recording uses). Returns `None` if the
/// meter can't be started, which is never fatal — it just means no level
/// display.
/// The key `ametadata` prints the level under. Its lines carry an
/// `[Parsed_ametadata_N @ 0x…]` prefix, so this is searched for rather
/// than stripped from the front.
const LEVEL_KEY: &str = "RMS_level=";

/// How much of the previous level survives each new reading. Readings
/// arrive around 40 times a second, each covering a slip of audio too
/// short to be steady on its own, so the bar rises instantly to a new
/// peak and falls away over roughly a third of a second instead of
/// flickering between individual readings.
const PEAK_DECAY: f32 = 0.85;

pub fn start(audio_input_args: &[String]) -> Option<Meter> {
    let mut child = crate::sidecar::command("ffmpeg")
        .args(audio_input_args)
        .args([
            // Keep progress reporting off stderr, so the levels are the
            // only thing that shows up there.
            "-nostats",
            "-af",
            // A reading per ~1024 samples (around 20ms), to match the small
            // capture buffer the meter asks the device for. The reading is
            // printed through ffmpeg's log rather than `file=-`: that
            // writes via buffered AVIO, which holds ~32KB of readings back
            // until ffmpeg exits — fine for a fixed-length run, useless
            // for a meter that has to be live.
            "asetnsamples=1024,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level",
            "-f",
            "null",
            "-",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .ok()?;

    let stderr = child.stderr.take()?;
    let level = Arc::new(AtomicU32::new(0));
    let shared = Arc::clone(&level);

    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            let Some(index) = line.find(LEVEL_KEY) else {
                continue;
            };
            // Silence reports "-inf", which parses to negative infinity
            // and clamps to zero.
            let db = line[index + LEVEL_KEY.len()..]
                .trim()
                .parse::<f32>()
                .unwrap_or(FLOOR_DB);
            let normalized = ((db - FLOOR_DB) / -FLOOR_DB).clamp(0.0, 1.0);

            let previous = f32::from_bits(shared.load(Ordering::Relaxed));
            shared.store(normalized.max(previous * PEAK_DECAY).to_bits(), Ordering::Relaxed);
        }
    });

    Some(Meter { child, level })
}

impl Meter {
    /// The latest microphone level, 0.0 (silent) to 1.0 (loud).
    pub fn level(&self) -> f32 {
        f32::from_bits(self.level.load(Ordering::Relaxed))
    }

    pub fn stop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
