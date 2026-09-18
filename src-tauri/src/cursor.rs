//! Where the mouse was, while the screen was being recorded.
//!
//! A screen recording is mostly a story about a pointer: it moves
//! somewhere, it clicks, something happens. The picture alone loses half
//! of that — the pointer is a few pale pixels — so this writes down where
//! it went and when it was pressed, and the editor uses that twice over:
//! to zoom in on what was clicked, and to say where the pointer was for
//! anything that wants to point at it.
//!
//! Times are in *recorded* seconds, not wall seconds. A recording that was
//! paused for a minute has no minute in it, and a note of where the mouse
//! wandered during the pause would land a zoom in the wrong place.
//!
//! Positions are in screen pixels, with the captured region written down
//! beside them, so the editor can turn them into fractions of the frame
//! however the capture was set up.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// One reading of the pointer.
#[derive(Debug, Clone, Copy, serde::Serialize, serde::Deserialize)]
pub struct CursorSample {
    /// Seconds into the recording.
    pub at: f64,
    /// Where the pointer was, in screen pixels.
    pub x: i32,
    pub y: i32,
    /// Whether the left button was down at that moment.
    pub down: bool,
}

/// The whole trail, and what it is measured against.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct CursorTrack {
    pub version: u32,
    /// The top-left corner of what was captured, in screen pixels, and how
    /// large it was. A sample at `origin` is at the very corner of the
    /// picture; one at `origin + size` is at the far corner.
    pub origin: (i32, i32),
    pub size: (u32, u32),
    pub samples: Vec<CursorSample>,
}

/// How often the pointer is read.
///
/// Sixty times a second: the same rate as a smooth recording, and fine
/// enough that a click is never attributed to where the pointer went
/// next. Each reading costs a system call and eight bytes.
const EVERY: Duration = Duration::from_millis(16);

/// Readings this close together and this still are not worth keeping: a
/// pointer that has not moved says the same thing however often it is
/// asked. Presses are always kept, whatever else is dropped.
const STILL_PIXELS: i32 = 2;

/// Reads the pointer's position. `None` where there is no way to ask,
/// which is every platform but Windows for now.
#[cfg(target_os = "windows")]
fn where_is_the_pointer() -> Option<(i32, i32, bool)> {
    use windows_sys::Win32::Foundation::POINT;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON};
    use windows_sys::Win32::UI::WindowsAndMessaging::GetCursorPos;

    let mut point = POINT { x: 0, y: 0 };
    // SAFETY: `point` is a plain struct this call only writes into.
    let ok = unsafe { GetCursorPos(&mut point) };
    if ok == 0 {
        return None;
    }
    // The high bit says the button is down now; the low bit only says it
    // has been pressed since the last ask, which is not the question.
    let down = unsafe { GetAsyncKeyState(VK_LBUTTON as i32) } as u16 & 0x8000 != 0;
    Some((point.x, point.y, down))
}

#[cfg(not(target_os = "windows"))]
fn where_is_the_pointer() -> Option<(i32, i32, bool)> {
    None
}

/// Whether the pointer can be followed at all here. The editor asks, so
/// that a switch nobody can turn on is not offered.
pub fn can_follow() -> bool {
    where_is_the_pointer().is_some()
}

struct Shared {
    samples: Mutex<Vec<CursorSample>>,
    /// Recorded time that has already elapsed, in milliseconds, plus when
    /// the current stretch began. Held apart so a pause can be a pause.
    running: AtomicBool,
    stop: AtomicBool,
}

/// Told where the pointer is as each reading is taken, for anything that
/// wants to draw there — the ring around the mouse, in practice.
pub type Report = Box<dyn Fn(i32, i32, bool) + Send>;

/// Follows the pointer for as long as a recording is running.
pub struct Watcher {
    shared: Arc<Shared>,
    /// Joined on finish, so the last readings are in before the file is
    /// written.
    thread: Option<std::thread::JoinHandle<()>>,
    origin: (i32, i32),
    size: (u32, u32),
}

impl Watcher {
    /// Starts following. `origin` and `size` describe the patch of screen
    /// being captured, so the readings can be placed in the picture later.
    ///
    /// `keep` says whether the readings are written down for the editor;
    /// `report` is handed every reading as it is taken. Either can be off:
    /// the ring around the mouse wants reporting without keeping, and the
    /// automatic zooms want keeping without reporting.
    pub fn watch(
        origin: (i32, i32),
        size: (u32, u32),
        keep: bool,
        report: Option<Report>,
    ) -> Self {
        let shared = Arc::new(Shared {
            samples: Mutex::new(Vec::new()),
            running: AtomicBool::new(true),
            stop: AtomicBool::new(false),
        });

        let mine = Arc::clone(&shared);
        let thread = std::thread::spawn(move || {
            // Recorded time, kept by the thread itself: wall time minus
            // however long it spent paused.
            let mut recorded = Duration::ZERO;
            let mut since = Instant::now();
            let mut was_running = true;
            let mut last: Option<CursorSample> = None;

            while !mine.stop.load(Ordering::Relaxed) {
                let running = mine.running.load(Ordering::Relaxed);
                if running != was_running {
                    if running {
                        // Coming back: the clock starts again from here.
                        since = Instant::now();
                    } else {
                        recorded += since.elapsed();
                    }
                    was_running = running;
                }

                if running {
                    if let Some((x, y, down)) = where_is_the_pointer() {
                        let at = (recorded + since.elapsed()).as_secs_f64();
                        let worth_keeping = match last {
                            None => true,
                            Some(before) => {
                                before.down != down
                                    || (before.x - x).abs() > STILL_PIXELS
                                    || (before.y - y).abs() > STILL_PIXELS
                            }
                        };
                        if worth_keeping {
                            let sample = CursorSample { at, x, y, down };
                            last = Some(sample);
                            if keep {
                                if let Ok(mut samples) = mine.samples.lock() {
                                    samples.push(sample);
                                }
                            }
                            if let Some(report) = report.as_ref() {
                                report(x, y, down);
                            }
                        }
                    }
                }
                std::thread::sleep(EVERY);
            }
        });

        Self {
            shared,
            thread: Some(thread),
            origin,
            size,
        }
    }

    /// Stops the clock without stopping the watching: the pointer may
    /// wander while a recording is paused, and none of that is in the
    /// film.
    pub fn pause(&self) {
        self.shared.running.store(false, Ordering::Relaxed);
    }

    pub fn resume(&self) {
        self.shared.running.store(true, Ordering::Relaxed);
    }

    /// Stops following and answers with the trail.
    pub fn finish(mut self) -> CursorTrack {
        self.shared.stop.store(true, Ordering::Relaxed);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
        let samples = self
            .shared
            .samples
            .lock()
            .map(|s| s.clone())
            .unwrap_or_default();
        CursorTrack {
            version: 1,
            origin: self.origin,
            size: self.size,
            samples,
        }
    }
}

impl Drop for Watcher {
    fn drop(&mut self) {
        // A watcher let go of without being finished still has to let its
        // thread go, or every discarded recording leaves one behind.
        self.shared.stop.store(true, Ordering::Relaxed);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

/// Where a recording's trail is kept: beside the recording, under the
/// same name.
///
/// Beside it rather than inside it because an mp4 has nowhere to put this,
/// and beside it rather than in the app's own folder because a recording
/// that is moved or copied should take its trail with it.
pub fn track_path(recording: &Path) -> PathBuf {
    let mut name = recording.file_name().unwrap_or_default().to_os_string();
    name.push(".cursor.json");
    recording.with_file_name(name)
}

pub fn write(recording: &Path, track: &CursorTrack) -> Result<(), String> {
    if track.samples.is_empty() {
        return Ok(());
    }
    let text = serde_json::to_string(track).map_err(|e| e.to_string())?;
    std::fs::write(track_path(recording), text).map_err(|e| e.to_string())
}

/// The trail beside a recording, if there is one. Absent is not an error:
/// most files have never been near this app's recorder.
pub fn read(recording: &Path) -> Option<CursorTrack> {
    let text = std::fs::read_to_string(track_path(recording)).ok()?;
    serde_json::from_str(&text).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_trail_is_kept_beside_the_recording_it_belongs_to() {
        let recording = Path::new("C:/takes/JDEditor_2026-09-18.mp4");
        assert_eq!(
            track_path(recording),
            Path::new("C:/takes/JDEditor_2026-09-18.mp4.cursor.json"),
            "the trail has to travel with the file, and be obviously its"
        );
    }

    #[test]
    fn a_trail_survives_being_written_down_and_read_back() {
        let dir = std::env::temp_dir();
        let fake = dir.join("jd-cursor-test.mp4");
        let track = CursorTrack {
            version: 1,
            origin: (0, 0),
            size: (1920, 1080),
            samples: vec![
                CursorSample { at: 0.0, x: 10, y: 20, down: false },
                CursorSample { at: 1.5, x: 300, y: 400, down: true },
            ],
        };
        write(&fake, &track).expect("written");
        let back = read(&fake).expect("read back");
        assert_eq!(back.samples.len(), 2);
        assert_eq!(back.size, (1920, 1080));
        assert!(back.samples[1].down);
        assert!((back.samples[1].at - 1.5).abs() < 1e-9);
        let _ = std::fs::remove_file(track_path(&fake));
    }

    #[test]
    fn nothing_is_written_for_a_recording_with_no_trail() {
        let fake = std::env::temp_dir().join("jd-cursor-empty.mp4");
        let _ = std::fs::remove_file(track_path(&fake));
        let empty = CursorTrack {
            version: 1,
            origin: (0, 0),
            size: (1920, 1080),
            samples: Vec::new(),
        };
        write(&fake, &empty).expect("nothing to write is not a failure");
        assert!(
            read(&fake).is_none(),
            "an empty trail should leave no file lying beside the recording"
        );
    }

    /// Reads the real pointer, briefly.
    ///
    /// Harmless — asking where the mouse is changes nothing — and it is
    /// the only way to know that the sampling thread starts, keeps time,
    /// and stops when it is told to.
    #[test]
    fn the_watcher_follows_the_pointer_and_keeps_recorded_time() {
        if !can_follow() {
            eprintln!("no way to read the pointer here; skipping");
            return;
        }
        let watcher = Watcher::watch((0, 0), (1920, 1080), true, None);
        std::thread::sleep(Duration::from_millis(120));
        // A pause is a pause: the clock stops, so nothing after this can
        // be stamped much past the 120ms already recorded.
        watcher.pause();
        std::thread::sleep(Duration::from_millis(200));
        watcher.resume();
        std::thread::sleep(Duration::from_millis(120));
        let track = watcher.finish();

        assert!(
            !track.samples.is_empty(),
            "the pointer was never read at all"
        );
        let last = track.samples.last().unwrap();
        assert!(
            last.at < 0.32,
            "the 200ms pause should not be in the recorded time, but the last sample is at {}",
            last.at
        );
        assert!(
            track.samples.iter().all(|s| s.at >= 0.0),
            "no reading can be from before the recording began"
        );
    }
}
