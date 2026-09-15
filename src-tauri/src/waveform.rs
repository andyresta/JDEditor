use std::io::Read;
use std::process::Stdio;
use tauri::Manager;

/// How many readings a second the timeline gets. Enough to see the shape
/// of speech — where a sentence starts, where a pause is — without making
/// the reply enormous: an hour of audio is about 108,000 bytes at this
/// rate, against roughly 170MB of raw samples.
const PEAKS_PER_SECOND: usize = 30;

/// What the decoder is asked for. Mono, and a rate far below anything
/// worth listening to, because nothing here is listened to — only the
/// loudness envelope is wanted, and a lower rate means less to decode.
const SAMPLE_RATE: usize = 8_000;

/// The loudness envelope of a file's audio: one reading per bucket, 0-255,
/// where 255 is full scale. Bytes rather than floats because this crosses
/// to the webview as JSON and there are a lot of them.
///
/// Empty when the file has no audio at all, which is how the editor knows
/// to draw a flat line rather than wait for something that isn't coming.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct AudioPeaks {
    pub peaks_per_second: usize,
    pub peaks: Vec<u8>,
}

/* ----------------------------------------------------------------- cache */

/// The stored envelope starts with this, so a file left behind by an older
/// version of the app is recognised as unreadable rather than decoded as
/// if it were the current shape.
const CACHE_MAGIC: &[u8; 4] = b"JDPK";
const CACHE_VERSION: u8 = 1;

/// How many envelopes are kept. Each is about 100KB for an hour of audio,
/// so this is a few megabytes at worst — and a project of twenty clips
/// still finds all of its own.
const CACHE_LIMIT: usize = 200;

/// What the stored envelope is filed under: the path, and how big the file
/// is and when it last changed.
///
/// The size and the date are what make it safe. A file that has been
/// re-recorded, re-encoded or trimmed since keeps its path, and an
/// envelope drawn from the old one would be a waveform that no longer
/// matches a sound — so any of the three changing means it is read again.
fn cache_key(path: &str) -> Option<String> {
    use std::hash::{Hash, Hasher};
    let data = std::fs::metadata(path).ok()?;
    let changed = data
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_millis();
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    path.to_lowercase().hash(&mut hasher);
    data.len().hash(&mut hasher);
    changed.hash(&mut hasher);
    Some(format!("{:016x}", hasher.finish()))
}

fn cache_dir(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    let dir = app.path().app_cache_dir().ok()?.join("waveforms");
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

/// Magic, version, the readings a second, then the readings themselves.
///
/// One byte a reading, as they are held: an hour of audio is about 108KB
/// stored this way, against roughly 400KB written out as numbers in a text
/// file — and the whole point of storing it is to spare the disk work.
fn encode_cache(peaks: &AudioPeaks) -> Option<Vec<u8>> {
    // A rate that will not fit in the one byte kept for it would be read
    // back as something else entirely, so it is simply not stored.
    let rate = u8::try_from(peaks.peaks_per_second).ok()?;
    let mut bytes = Vec::with_capacity(peaks.peaks.len() + 6);
    bytes.extend_from_slice(CACHE_MAGIC);
    bytes.push(CACHE_VERSION);
    bytes.push(rate);
    bytes.extend_from_slice(&peaks.peaks);
    Some(bytes)
}

fn decode_cache(bytes: &[u8]) -> Option<AudioPeaks> {
    if bytes.len() < 6 || &bytes[0..4] != CACHE_MAGIC || bytes[4] != CACHE_VERSION {
        return None;
    }
    Some(AudioPeaks {
        peaks_per_second: bytes[5] as usize,
        peaks: bytes[6..].to_vec(),
    })
}

fn load_cached(app: &tauri::AppHandle, key: &str) -> Option<AudioPeaks> {
    let file = cache_dir(app)?.join(format!("{key}.pk"));
    decode_cache(&std::fs::read(&file).ok()?)
}

fn store_cached(app: &tauri::AppHandle, key: &str, peaks: &AudioPeaks) {
    let Some(dir) = cache_dir(app) else { return };
    let Some(bytes) = encode_cache(peaks) else { return };

    // Written whole and moved into place, so a half-written file is never
    // left behind to be read as an envelope.
    let file = dir.join(format!("{key}.pk"));
    let pending = dir.join(format!("{key}.part"));
    if std::fs::write(&pending, &bytes).is_ok() {
        let _ = std::fs::rename(&pending, &file);
    }
    prune(&dir);
}

/// Keeps the folder from growing without end: once there are more than it
/// should hold, the ones touched longest ago go.
fn prune(dir: &std::path::Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut files: Vec<(std::time::SystemTime, std::path::PathBuf)> = entries
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let when = entry.metadata().ok()?.modified().ok()?;
            Some((when, entry.path()))
        })
        .collect();
    if files.len() <= CACHE_LIMIT {
        return;
    }
    files.sort_by_key(|(when, _)| *when);
    for (_, path) in files.iter().take(files.len() - CACHE_LIMIT) {
        let _ = std::fs::remove_file(path);
    }
}

/// The loudness envelope of a file, read from the file itself the first
/// time and from the store after that.
///
/// Decoding is the expensive part — an hour of audio is an hour of
/// samples to walk through, and it was being done afresh every time a
/// project was opened, for every clip in it. The envelope only depends on
/// the file, so once drawn it need never be drawn again.
pub fn read(app: &tauri::AppHandle, path: &str) -> Result<AudioPeaks, String> {
    if !std::path::Path::new(path).exists() {
        return Err("File not found".to_string());
    }

    let key = cache_key(path);
    if let Some(key) = key.as_deref() {
        if let Some(stored) = load_cached(app, key) {
            return Ok(stored);
        }
    }

    let peaks = decode(path)?;
    if let Some(key) = key.as_deref() {
        store_cached(app, key, &peaks);
    }
    Ok(peaks)
}

fn decode(path: &str) -> Result<AudioPeaks, String> {

    let mut child = crate::sidecar::command("ffmpeg")
        .args([
            "-v",
            "error",
            "-i",
            path,
            // No pictures, one channel, raw signed 16-bit samples on
            // stdout. Decoding straight to samples avoids a temporary file
            // and lets the buckets be filled as they arrive.
            "-vn",
            "-ac",
            "1",
            "-ar",
            &SAMPLE_RATE.to_string(),
            "-f",
            "s16le",
            "-",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Could not run ffmpeg: {e}"))?;

    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| "ffmpeg produced no output".to_string())?;

    // stderr has to be drained alongside stdout: ffmpeg writing into a
    // pipe nobody reads will block once its buffer fills, and the decode
    // would stall forever. A file with no audio stream complains here.
    let mut stderr = child.stderr.take();
    let stderr_reader = std::thread::spawn(move || {
        let mut text = String::new();
        if let Some(handle) = stderr.as_mut() {
            let _ = handle.read_to_string(&mut text);
        }
        text
    });

    let samples_per_peak = SAMPLE_RATE / PEAKS_PER_SECOND;
    let mut peaks: Vec<u8> = Vec::new();
    let mut buffer = [0u8; 16 * 1024];
    // A sample can straddle a read, and a bucket almost always does.
    let mut odd_byte: Option<u8> = None;
    let mut in_bucket = 0usize;
    let mut loudest = 0i32;

    loop {
        let read = stdout
            .read(&mut buffer)
            .map_err(|e| format!("Could not read ffmpeg's output: {e}"))?;
        if read == 0 {
            break;
        }

        let mut index = 0;
        while index < read {
            let sample = match odd_byte.take() {
                Some(low) => {
                    let value = i16::from_le_bytes([low, buffer[index]]);
                    index += 1;
                    value
                }
                None => {
                    if index + 1 >= read {
                        odd_byte = Some(buffer[index]);
                        break;
                    }
                    let value = i16::from_le_bytes([buffer[index], buffer[index + 1]]);
                    index += 2;
                    value
                }
            };

            // The peak, not an average: an average over a thirtieth of a
            // second flattens speech into a low ridge, while the peak keeps
            // the shape of every syllable.
            loudest = loudest.max((sample as i32).abs());
            in_bucket += 1;
            if in_bucket >= samples_per_peak {
                peaks.push(((loudest * 255) / 32_768).min(255) as u8);
                in_bucket = 0;
                loudest = 0;
            }
        }
    }

    // Whatever is left over is a real part of the sound, just a short one.
    if in_bucket > 0 {
        peaks.push(((loudest * 255) / 32_768).min(255) as u8);
    }

    let status = child
        .wait()
        .map_err(|e| format!("ffmpeg did not finish: {e}"))?;
    let complaint = stderr_reader.join().unwrap_or_default();

    if !status.success() && peaks.is_empty() {
        // A file with no audio track isn't a failure the editor should
        // report; it simply has no envelope to draw.
        if complaint.contains("does not contain any stream")
            || complaint.contains("Output file does not contain")
        {
            return Ok(AudioPeaks {
                peaks_per_second: PEAKS_PER_SECOND,
                peaks: Vec::new(),
            });
        }
        let line = complaint
            .lines()
            .find(|line| !line.trim().is_empty())
            .unwrap_or("ffmpeg failed");
        return Err(line.to_string());
    }

    Ok(AudioPeaks {
        peaks_per_second: PEAKS_PER_SECOND,
        peaks,
    })
}

#[cfg(test)]
mod tests {
    /// Checks the envelope against a real recording: the right number of
    /// readings for its length, in range, and actually varying rather than
    /// a flat line of zeros.
    ///
    /// Needs a file to read and an `ffmpeg` to read it with, so it points
    /// at whatever `JD_TEST_CLIP` names and stands aside when that isn't
    /// set — there is nothing here that a machine without either can
    /// meaningfully check.
    #[test]
    fn reads_a_real_recording() {
        let Ok(path) = std::env::var("JD_TEST_CLIP") else {
            eprintln!("JD_TEST_CLIP not set; skipping");
            return;
        };
        let result = super::decode(&path).expect("peaks");
        let seconds = result.peaks.len() as f64 / result.peaks_per_second as f64;
        let loudest = result.peaks.iter().copied().max().unwrap_or(0);
        let quietest = result.peaks.iter().copied().min().unwrap_or(0);
        let average: f64 =
            result.peaks.iter().map(|p| *p as f64).sum::<f64>() / result.peaks.len() as f64;
        println!(
            "peaks={} seconds={:.2} min={} max={} mean={:.1}",
            result.peaks.len(),
            seconds,
            quietest,
            loudest,
            average
        );
        assert!(result.peaks.len() > 100, "too few readings");
        assert!(loudest > 0, "every reading was silence");
        assert!(loudest > quietest, "the envelope never changes");
    }

    /// The stored shape, there and back again. Everything about the store
    /// rests on this: an envelope that comes back different from the one
    /// that went in would draw a waveform that belongs to no sound.
    #[test]
    fn a_stored_envelope_comes_back_as_it_went_in() {
        let peaks = super::AudioPeaks {
            peaks_per_second: 30,
            peaks: (0..5_000).map(|i| (i % 256) as u8).collect(),
        };
        let bytes = super::encode_cache(&peaks).expect("encoded");
        let back = super::decode_cache(&bytes).expect("decoded");
        assert_eq!(back.peaks_per_second, peaks.peaks_per_second);
        assert_eq!(back.peaks, peaks.peaks);
        // A minute of sound in a little under two kilobytes.
        assert!(bytes.len() < peaks.peaks.len() + 16, "the store is not compact");
    }

    #[test]
    fn a_file_from_another_version_is_not_read_as_an_envelope() {
        let peaks = super::AudioPeaks { peaks_per_second: 30, peaks: vec![1, 2, 3] };
        let good = super::encode_cache(&peaks).expect("encoded");

        assert!(super::decode_cache(&[]).is_none(), "nothing is not an envelope");
        assert!(
            super::decode_cache(b"not an envelope at all").is_none(),
            "a file that is not one of ours should be refused"
        );
        let mut older = good.clone();
        older[4] = 0;
        assert!(
            super::decode_cache(&older).is_none(),
            "a file from an older version should be refused rather than misread"
        );
        let mut truncated = good.clone();
        truncated.truncate(3);
        assert!(super::decode_cache(&truncated).is_none(), "a stub is not an envelope");
    }

    /// The same file gives the same name to file it under; a file that has
    /// changed since does not, so the envelope is drawn afresh.
    #[test]
    fn the_key_follows_the_file_rather_than_its_name() {
        let path = std::env::temp_dir().join("jd-key-test.bin");
        std::fs::write(&path, vec![0u8; 1000]).expect("written");
        let name = path.to_string_lossy().to_string();

        let first = super::cache_key(&name).expect("a key");
        assert_eq!(first, super::cache_key(&name).expect("a key"), "asking twice");

        // Re-recorded at a different length: the same path, a different file.
        std::fs::write(&path, vec![0u8; 2000]).expect("written");
        assert_ne!(
            first,
            super::cache_key(&name).expect("a key"),
            "a file that has changed must not be given the old envelope"
        );

        assert!(
            super::cache_key("nothing-is-here.bin").is_none(),
            "a file that is not there has no key"
        );
        let _ = std::fs::remove_file(&path);
    }

    /// The folder is kept to a size. Without this every file ever opened
    /// would leave something behind for good.
    #[test]
    fn the_store_is_kept_to_a_size() {
        let dir = std::env::temp_dir().join("jd-prune-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("made");
        for i in 0..(super::CACHE_LIMIT + 25) {
            std::fs::write(dir.join(format!("{i}.pk")), b"x").expect("written");
        }
        super::prune(&dir);
        let left = std::fs::read_dir(&dir).expect("read").count();
        assert_eq!(left, super::CACHE_LIMIT, "left {left} behind");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
