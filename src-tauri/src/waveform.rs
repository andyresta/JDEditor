use std::io::Read;
use std::process::Stdio;

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

pub fn read(path: &str) -> Result<AudioPeaks, String> {
    if !std::path::Path::new(path).exists() {
        return Err("File not found".to_string());
    }

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
        let result = super::read(&path).expect("peaks");
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
}
