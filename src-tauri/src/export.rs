use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::process::{Child, Stdio};
use std::sync::Mutex;
use tauri::{Emitter, Manager};

/// One piece of media placed on the timeline, already reduced to numbers.
///
/// The editor works out what a clip means — which track it is on, what it
/// is stacked over, where its volume line reads at each moment — and sends
/// the result. Nothing here knows about tracks, layers or decibels; this
/// end only knows how to turn a list of placements into an ffmpeg command.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct PlanClip {
    pub path: String,
    /// Where it begins on the timeline, in seconds.
    pub start: f64,
    pub duration: f64,
    /// How far into its own file it starts.
    pub trim_start: f64,
    /// Whether this placement contributes a picture.
    pub visual: bool,
    /// Whether it contributes sound.
    pub audible: bool,
    /// A still image, which has to be looped rather than decoded.
    pub still: bool,
    /// Width as a fraction of the canvas, and the centre of the layer as a
    /// fraction of the canvas measured from its own centre.
    pub scale: f64,
    pub x: f64,
    pub y: f64,
    /// The volume line, in clip-local seconds. One entry is a fixed level;
    /// several make a ramp. Empty means full volume.
    pub volume: Vec<PlanVolumePoint>,
    /// The framing over the course of the clip, already sampled. Empty
    /// when it holds still, which is both the common case and the one
    /// that renders fastest.
    #[serde(default)]
    pub zoom: Vec<PlanZoomPoint>,
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct PlanZoomPoint {
    pub at: f64,
    pub scale: f64,
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct PlanVolumePoint {
    pub at: f64,
    pub gain: f64,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportPlan {
    pub output_path: String,
    pub format: String,
    /// Canvas size. Always even, because H.264 cannot encode odd ones.
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub duration: f64,
    /// Encoder quality, already chosen for the format by the editor.
    pub video_quality: u32,
    pub audio_bitrate_kbps: u32,
    /// Bottom of the stack first: they are overlaid in this order.
    pub clips: Vec<PlanClip>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ExportProgress {
    /// 0.0 to 1.0, or -1 while ffmpeg hasn't reported a position yet.
    pub fraction: f64,
    pub seconds_done: f64,
    pub seconds_total: f64,
}

/// The running render, so it can be cancelled.
#[derive(Default)]
pub struct ExportState(pub Mutex<Option<Child>>);

pub fn cancel(app: &tauri::AppHandle) {
    let state = app.state::<ExportState>();
    let mut running = state.0.lock().unwrap();
    if let Some(child) = running.as_mut() {
        let _ = child.kill();
    }
}

/// Puts a title's picture on disk for the renderer to overlay.
///
/// Named after the clip rather than given a fresh name each time, so
/// exporting the same project twice leaves one file per title instead of
/// a growing pile of them.
pub fn write_text_image(
    app: &tauri::AppHandle,
    clip_id: &str,
    bytes: &[u8],
) -> Result<String, String> {
    // Only the characters a file name can safely hold; the id is ours, but
    // a path is not the place to trust that.
    let safe: String = clip_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect();
    if safe.is_empty() {
        return Err("A title needs a name to be stored under.".to_string());
    }

    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("titles");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{safe}.png"));
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

/// Whether a file has an audio stream at all. A screen recording made
/// without a microphone has none, and asking ffmpeg for `[3:a]` when there
/// is no such stream fails the whole render — so each file is asked once
/// before the command is built.
fn has_audio(path: &str) -> bool {
    let output = crate::sidecar::command("ffprobe")
        .args([
            "-v", "error", "-select_streams", "a:0", "-show_entries",
            "stream=index", "-of", "csv=p=0", path,
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output();
    match output {
        Ok(out) => !String::from_utf8_lossy(&out.stdout).trim().is_empty(),
        Err(_) => false,
    }
}

fn even(value: f64) -> i64 {
    let rounded = value.round() as i64;
    if rounded % 2 == 0 {
        rounded
    } else {
        rounded + 1
    }
}

/// The `volume` filter's level for one clip.
///
/// A flat line is a single number. A shaped one becomes an expression in
/// `t`: a sum of terms, each covering one stretch of the clip and zero
/// outside it, so the pieces add up to a single ramp without nesting
/// dozens of conditionals. The editor has already sampled its own curve
/// finely enough that straight lines between the points it sends are
/// indistinguishable from what it drew.
fn volume_filter(points: &[PlanVolumePoint]) -> String {
    if points.is_empty() {
        return String::new();
    }
    if points.len() == 1 {
        return format!("volume={:.5}", points[0].gain.max(0.0));
    }

    let mut terms: Vec<String> = Vec::new();
    // Before the first point and after the last, the line is flat.
    terms.push(format!(
        "lt(t,{:.4})*{:.5}",
        points[0].at,
        points[0].gain.max(0.0)
    ));
    for pair in points.windows(2) {
        let (from, to) = (&pair[0], &pair[1]);
        let span = to.at - from.at;
        if span <= 0.0001 {
            continue;
        }
        terms.push(format!(
            "gte(t,{a:.4})*lt(t,{b:.4})*({ga:.5}+({gb:.5}-{ga:.5})*(t-{a:.4})/{span:.4})",
            a = from.at,
            b = to.at,
            ga = from.gain.max(0.0),
            gb = to.gain.max(0.0),
            span = span,
        ));
    }
    let last = points.last().unwrap();
    terms.push(format!("gte(t,{:.4})*{:.5}", last.at, last.gain.max(0.0)));

    format!("volume=eval=frame:volume='{}'", terms.join("+"))
}

/// A number that travels: an ffmpeg expression in `t` built from samples,
/// as a sum of terms each covering one stretch and worth zero outside it.
///
/// `pick` says which of a sample's numbers the expression is for, and
/// `offset` shifts the times. The picture's size is worked out in the
/// clip's own time, while where it sits on screen is worked out in the
/// timeline's — the two differ by where the clip begins, and getting that
/// wrong would leave a zoom whose size and position disagreed.
fn travelling(
    samples: &[PlanZoomPoint],
    offset: f64,
    pick: impl Fn(&PlanZoomPoint) -> f64,
) -> String {
    if samples.is_empty() {
        return String::new();
    }
    if samples.len() == 1 {
        return format!("{:.5}", pick(&samples[0]));
    }

    let mut terms: Vec<String> = Vec::new();
    let first = &samples[0];
    terms.push(format!("lt(t,{:.4})*{:.5}", first.at + offset, pick(first)));
    for pair in samples.windows(2) {
        let (from, to) = (&pair[0], &pair[1]);
        let span = to.at - from.at;
        if span <= 0.0001 {
            continue;
        }
        terms.push(format!(
            "gte(t,{a:.4})*lt(t,{b:.4})*({va:.5}+({vb:.5}-{va:.5})*(t-{a:.4})/{span:.4})",
            a = from.at + offset,
            b = to.at + offset,
            va = pick(from),
            vb = pick(to),
            span = span,
        ));
    }
    let last = samples.last().unwrap();
    terms.push(format!("gte(t,{:.4})*{:.5}", last.at + offset, pick(last)));
    terms.join("+")
}

/// Turns the plan into ffmpeg's arguments.
fn build_args(plan: &ExportPlan) -> Result<Vec<String>, String> {
    if plan.clips.is_empty() {
        return Err("There is nothing on the timeline to export.".to_string());
    }

    let audio_only = plan.format == "mp3";
    let wants_audio = plan.format != "gif";

    // Each distinct file is asked about once, however many times it is
    // placed on the timeline.
    let mut audio_by_path: HashMap<&str, bool> = HashMap::new();
    for clip in &plan.clips {
        if clip.audible && !clip.still {
            audio_by_path
                .entry(clip.path.as_str())
                .or_insert_with(|| has_audio(&clip.path));
        }
    }

    let mut args: Vec<String> = vec!["-y".into(), "-hide_banner".into()];
    for clip in &plan.clips {
        if clip.still {
            args.push("-loop".into());
            args.push("1".into());
            args.push("-t".into());
            args.push(format!("{:.4}", clip.duration));
        }
        args.push("-i".into());
        args.push(clip.path.clone());
    }

    let mut chains: Vec<String> = Vec::new();
    // Names the stage the picture has reached, so each layer knows what to
    // lay itself over. Unused when only sound is being written out.
    let mut last_video;

    if !audio_only {
        // A black canvas of the chosen size for the full length, which
        // every layer is laid over. It is also what shows through wherever
        // the timeline is empty.
        chains.push(format!(
            "color=c=black:s={}x{}:r={}:d={:.4}[bg]",
            plan.width, plan.height, plan.fps, plan.duration
        ));
        last_video = "bg".to_string();

        for (index, clip) in plan.clips.iter().enumerate() {
            if !clip.visual {
                continue;
            }
            let zooms = !clip.zoom.is_empty();

            // A clip that zooms is scaled afresh on every frame; one that
            // holds still is scaled once, which is far cheaper and is what
            // nearly every clip does.
            let sizing = if zooms {
                // Worked in the clip's own time: `setpts` has already put
                // its first frame at zero, and the scaling happens before
                // the padding that moves it onto the timeline.
                format!(
                    "scale=w='{}*({})':h=-2:eval=frame",
                    plan.width,
                    travelling(&clip.zoom, 0.0, |point| point.scale),
                )
            } else {
                format!("scale={}:-2", even(plan.width as f64 * clip.scale).max(2))
            };

            // Padded with transparent frames up to its place on the
            // timeline rather than shifted with setpts: overlay needs a
            // frame from both of its inputs at every moment, and padding
            // gives it one from the very start.
            chains.push(format!(
                // `format=rgba` comes before the scaling, not after. After
                // it, the format filter settles on the size of the first
                // frame and holds every later one to it — a zoom would
                // simply not zoom, quietly and without any error. It is
                // needed at all so that `tpad` can pad with transparency
                // rather than with black.
                "[{index}:v]trim=start={trim:.4}:duration={dur:.4},setpts=PTS-STARTPTS,                 format=rgba,{sizing},setsar=1,fps={fps},                 tpad=start_duration={start:.4}:start_mode=add:color=black@0[v{index}]",
                index = index,
                trim = clip.trim_start,
                dur = clip.duration,
                sizing = sizing,
                fps = plan.fps,
                start = clip.start,
            ));

            // The framing gives the centre of the layer; overlay wants its
            // top-left, so half its own size comes back off. Overlay reads
            // the timeline's clock, so a travelling position has to be
            // offset by where the clip begins.
            let (position_x, position_y) = if zooms {
                (
                    format!(
                        "'(0.5+({}))*{}-overlay_w/2'",
                        travelling(&clip.zoom, clip.start, |point| point.x),
                        plan.width
                    ),
                    format!(
                        "'(0.5+({}))*{}-overlay_h/2'",
                        travelling(&clip.zoom, clip.start, |point| point.y),
                        plan.height
                    ),
                )
            } else {
                (
                    format!("{:.2}-overlay_w/2", (0.5 + clip.x) * plan.width as f64),
                    format!("{:.2}-overlay_h/2", (0.5 + clip.y) * plan.height as f64),
                )
            };

            let out = format!("ov{index}");
            chains.push(format!(
                "[{last}][v{index}]overlay=x={x}:y={y}:eof_action=pass:shortest=0[{out}]",
                last = last_video,
                index = index,
                x = position_x,
                y = position_y,
                out = out,
            ));
            last_video = out;
        }

        if plan.format == "gif" {
            // A palette built from the footage itself; the default 216
            // colours turn a screen recording's gradients to mud.
            chains.push(format!(
                "[{last}]split[gifa][gifb];[gifa]palettegen=stats_mode=diff[pal];\
                 [gifb][pal]paletteuse=dither=bayer:bayer_scale=3[vout]",
                last = last_video
            ));
        } else {
            chains.push(format!("[{last}]format=yuv420p[vout]", last = last_video));
        }
    }

    let mut audio_labels: Vec<String> = Vec::new();
    if wants_audio {
        for (index, clip) in plan.clips.iter().enumerate() {
            if !clip.audible || clip.still {
                continue;
            }
            if !audio_by_path.get(clip.path.as_str()).copied().unwrap_or(false) {
                continue;
            }
            let level = volume_filter(&clip.volume);
            // The volume line is read before the clip is moved into place,
            // so its times are the clip's own — which is how the editor
            // draws it.
            let mut chain = format!(
                "[{index}:a]atrim=start={trim:.4}:duration={dur:.4},asetpts=PTS-STARTPTS",
                index = index,
                trim = clip.trim_start,
                dur = clip.duration,
            );
            if !level.is_empty() {
                chain.push(',');
                chain.push_str(&level);
            }
            let delay = (clip.start * 1000.0).round() as i64;
            if delay > 0 {
                chain.push_str(&format!(",adelay={delay}:all=1"));
            }
            let label = format!("a{index}");
            chain.push_str(&format!("[{label}]"));
            chains.push(chain);
            audio_labels.push(label);
        }

        if !audio_labels.is_empty() {
            let inputs: String = audio_labels.iter().map(|l| format!("[{l}]")).collect();
            // `normalize=0` keeps each track at the level it was given
            // instead of quietly dividing by the number of them; the
            // limiter is what catches the sum going over.
            chains.push(format!(
                "{inputs}amix=inputs={count}:normalize=0:dropout_transition=0,\
                 alimiter=limit=0.98[aout]",
                inputs = inputs,
                count = audio_labels.len(),
            ));
        }
    }

    if audio_only && audio_labels.is_empty() {
        return Err("There is no sound on the timeline to export.".to_string());
    }

    args.push("-filter_complex".into());
    args.push(chains.join(";"));

    if !audio_only {
        args.push("-map".into());
        args.push("[vout]".into());
    }
    if !audio_labels.is_empty() {
        args.push("-map".into());
        args.push("[aout]".into());
    } else if !audio_only {
        args.push("-an".into());
    }

    match plan.format.as_str() {
        "mp4" | "mov" => {
            args.extend(
                [
                    "-c:v", "libx264", "-preset", "medium", "-crf",
                ]
                .iter()
                .map(|s| s.to_string()),
            );
            args.push(plan.video_quality.to_string());
            args.push("-pix_fmt".into());
            args.push("yuv420p".into());
            if !audio_labels.is_empty() {
                args.push("-c:a".into());
                args.push("aac".into());
                args.push("-b:a".into());
                args.push(format!("{}k", plan.audio_bitrate_kbps));
            }
            if plan.format == "mp4" {
                args.push("-movflags".into());
                args.push("+faststart".into());
            }
        }
        "webm" => {
            args.extend(
                ["-c:v", "libvpx-vp9", "-b:v", "0", "-crf"]
                    .iter()
                    .map(|s| s.to_string()),
            );
            args.push(plan.video_quality.to_string());
            args.push("-row-mt".into());
            args.push("1".into());
            if !audio_labels.is_empty() {
                args.push("-c:a".into());
                args.push("libopus".into());
                args.push("-b:a".into());
                args.push(format!("{}k", plan.audio_bitrate_kbps));
            }
        }
        "gif" => {
            args.push("-loop".into());
            args.push("0".into());
        }
        "mp3" => {
            args.push("-c:a".into());
            args.push("libmp3lame".into());
            args.push("-b:a".into());
            args.push(format!("{}k", plan.audio_bitrate_kbps));
        }
        other => return Err(format!("Unknown export format: {other}")),
    }

    args.push("-t".into());
    args.push(format!("{:.4}", plan.duration));
    // Reported on stdout, a line at a time, which is what drives the bar.
    args.push("-progress".into());
    args.push("pipe:1".into());
    args.push("-nostats".into());
    args.push(plan.output_path.clone());

    Ok(args)
}

pub fn run(app: &tauri::AppHandle, plan: ExportPlan) -> Result<String, String> {
    let args = build_args(&plan)?;

    let mut child = crate::sidecar::command("ffmpeg")
        .args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Could not start ffmpeg: {e}"))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "ffmpeg reported no progress".to_string())?;
    let mut stderr = child.stderr.take();

    // Drained on its own thread: an unread pipe fills and stops ffmpeg
    // dead, and this is also the only place a real failure explains itself.
    let complaints = std::thread::spawn(move || {
        let mut text = String::new();
        if let Some(handle) = stderr.as_mut() {
            use std::io::Read;
            let _ = handle.read_to_string(&mut text);
        }
        text
    });

    {
        let state = app.state::<ExportState>();
        *state.0.lock().unwrap() = Some(child);
    }

    let total = plan.duration.max(0.001);
    for line in BufReader::new(stdout).lines().map_while(Result::ok) {
        let Some(value) = line.strip_prefix("out_time_us=") else {
            continue;
        };
        let Ok(micros) = value.trim().parse::<i64>() else {
            continue;
        };
        let seconds = (micros as f64 / 1_000_000.0).max(0.0);
        let _ = app.emit(
            "export-progress",
            ExportProgress {
                fraction: (seconds / total).clamp(0.0, 1.0),
                seconds_done: seconds,
                seconds_total: total,
            },
        );
    }

    let status = {
        let state = app.state::<ExportState>();
        let mut running = state.0.lock().unwrap();
        match running.as_mut() {
            Some(child) => child.wait().map_err(|e| e.to_string())?,
            None => return Err("Export was cancelled.".to_string()),
        }
    };
    {
        let state = app.state::<ExportState>();
        *state.0.lock().unwrap() = None;
    }

    if !status.success() {
        // A cancelled render is a kill, not a fault; the part-written file
        // is of no use either way.
        let _ = std::fs::remove_file(&plan.output_path);
        let text = complaints.join().unwrap_or_default();
        let line = text
            .lines()
            .rev()
            .find(|line| !line.trim().is_empty())
            .unwrap_or("ffmpeg failed");
        return Err(line.trim().to_string());
    }

    Ok(plan.output_path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn clip(path: &str, start: f64, duration: f64) -> PlanClip {
        PlanClip {
            path: path.to_string(),
            start,
            duration,
            trim_start: 0.0,
            visual: true,
            audible: true,
            still: false,
            scale: 1.0,
            x: 0.0,
            y: 0.0,
            volume: Vec::new(),
            zoom: Vec::new(),
        }
    }

    fn plan(format: &str, clips: Vec<PlanClip>) -> ExportPlan {
        ExportPlan {
            output_path: "out.mp4".into(),
            format: format.into(),
            width: 1280,
            height: 720,
            fps: 30,
            duration: 10.0,
            video_quality: 23,
            audio_bitrate_kbps: 192,
            clips,
        }
    }

    #[test]
    fn lays_each_layer_over_the_one_below() {
        let mut over = clip("b.mp4", 2.0, 4.0);
        over.scale = 0.5;
        over.x = 0.25;
        let args = build_args(&plan("mp4", vec![clip("a.mp4", 0.0, 10.0), over])).unwrap();
        let graph = args.join(" ");
        // The second clip is laid over the first, not over the canvas.
        assert!(graph.contains("[bg][v0]overlay"), "{graph}");
        assert!(graph.contains("[ov0][v1]overlay"), "{graph}");
        // Half the canvas wide, and a quarter of the canvas right of centre.
        assert!(graph.contains("scale=640:-2"), "{graph}");
        assert!(graph.contains("x=960.00-overlay_w/2"), "{graph}");
        // It waits its turn rather than starting at zero.
        assert!(graph.contains("tpad=start_duration=2.0000"), "{graph}");
    }

    #[test]
    fn a_still_is_looped_for_its_length() {
        let mut still = clip("a.png", 0.0, 5.0);
        still.still = true;
        still.audible = false;
        let args = build_args(&plan("mp4", vec![still])).unwrap();
        let joined = args.join(" ");
        assert!(joined.contains("-loop 1 -t 5.0000 -i a.png"), "{joined}");
    }

    #[test]
    fn a_flat_volume_line_is_a_plain_number() {
        let filter = volume_filter(&[PlanVolumePoint { at: 0.0, gain: 0.5 }]);
        assert_eq!(filter, "volume=0.50000");
    }

    #[test]
    fn a_shaped_volume_line_becomes_a_ramp() {
        let filter = volume_filter(&[
            PlanVolumePoint { at: 0.0, gain: 0.0 },
            PlanVolumePoint { at: 2.0, gain: 1.0 },
        ]);
        assert!(filter.starts_with("volume=eval=frame:volume='"), "{filter}");
        // Flat before the first point, a ramp between, flat after the last.
        assert!(filter.contains("lt(t,0.0000)*0.00000"), "{filter}");
        assert!(filter.contains("gte(t,0.0000)*lt(t,2.0000)"), "{filter}");
        assert!(filter.contains("gte(t,2.0000)*1.00000"), "{filter}");
    }

    #[test]
    fn an_empty_timeline_is_refused() {
        assert!(build_args(&plan("mp4", Vec::new())).is_err());
    }

    /// Renders for real and asks ffprobe what came out. Everything above
    /// checks the command that gets built; this is the only thing that
    /// checks the command actually works — a filtergraph can be perfectly
    /// well-formed and still be rejected by ffmpeg.
    ///
    /// Needs a file to render and an ffmpeg to render it, so it points at
    /// whatever `JD_TEST_CLIP` names and stands aside when that isn't set.
    fn render(format: &str, mutate: impl FnOnce(&mut ExportPlan)) -> Option<String> {
        let path = std::env::var("JD_TEST_CLIP").ok()?;
        let out = std::env::temp_dir().join(format!("jd-export-test.{format}"));
        let _ = std::fs::remove_file(&out);

        let mut p = plan(format, vec![clip(&path, 0.0, 4.0)]);
        p.output_path = out.to_string_lossy().to_string();
        p.duration = 4.0;
        p.width = 640;
        p.height = 360;
        p.fps = 24;
        mutate(&mut p);

        let args = build_args(&p).expect("args");
        let status = crate::sidecar::command("ffmpeg")
            .args(&args)
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .output()
            .expect("ffmpeg ran");
        assert!(
            status.status.success(),
            "ffmpeg refused the command:
{}
args: {}",
            String::from_utf8_lossy(&status.stderr),
            args.join(" ")
        );
        Some(p.output_path)
    }

    fn probe(path: &str, entries: &str) -> String {
        let out = crate::sidecar::command("ffprobe")
            .args(["-v", "error", "-show_entries", entries, "-of", "csv=p=0", path])
            .output()
            .expect("ffprobe ran");
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    #[test]
    fn renders_a_stack_with_a_volume_line_to_mp4() {
        let Some(out) = render("mp4", |p| {
            // A second layer, half size and off-centre, over the first.
            let mut over = p.clips[0].clone();
            over.start = 1.0;
            over.duration = 2.0;
            over.trim_start = 1.0;
            over.scale = 0.5;
            over.x = 0.2;
            over.y = -0.15;
            // And a fade on the layer underneath.
            p.clips[0].volume = vec![
                PlanVolumePoint { at: 0.0, gain: 0.0 },
                PlanVolumePoint { at: 4.0, gain: 1.0 },
            ];
            p.clips.push(over);
        }) else {
            eprintln!("JD_TEST_CLIP not set; skipping");
            return;
        };

        let size = std::fs::metadata(&out).expect("written").len();
        assert!(size > 10_000, "suspiciously small output: {size} bytes");

        let shape = probe(&out, "stream=width,height");
        assert!(shape.contains("640,360"), "wrong canvas: {shape}");

        let seconds: f64 = probe(&out, "format=duration").parse().unwrap_or(0.0);
        assert!(
            (seconds - 4.0).abs() < 0.35,
            "wrong length: {seconds}s, wanted 4"
        );

        let codecs = probe(&out, "stream=codec_type");
        assert!(codecs.contains("video"), "no video stream: {codecs}");
        assert!(codecs.contains("audio"), "no audio stream: {codecs}");
    }

    #[test]
    fn renders_sound_on_its_own_to_mp3() {
        let Some(out) = render("mp3", |_| {}) else {
            eprintln!("JD_TEST_CLIP not set; skipping");
            return;
        };
        let codecs = probe(&out, "stream=codec_type");
        assert_eq!(codecs, "audio", "an mp3 should carry sound and nothing else");
    }

    #[test]
    fn renders_a_silent_gif() {
        let Some(out) = render("gif", |_| {}) else {
            eprintln!("JD_TEST_CLIP not set; skipping");
            return;
        };
        let codecs = probe(&out, "stream=codec_type");
        assert_eq!(codecs, "video", "a gif carries no sound");
    }

    /// Paints a plain block of colour to a file, so a composition can be
    /// made of pieces that are told apart by looking at them.
    fn colour_source(name: &str, colour: &str) -> Option<String> {
        let out = std::env::temp_dir().join(name);
        let status = crate::sidecar::command("ffmpeg")
            .args([
                "-y", "-f", "lavfi", "-i",
                &format!("color=c={colour}:s=640x360:r=24:d=5"),
                "-c:v", "libx264", "-pix_fmt", "yuv420p",
                &out.to_string_lossy(),
            ])
            .output()
            .ok()?;
        status.status.success().then(|| out.to_string_lossy().to_string())
    }

    /// The colour of one pixel of a rendered file, at a moment.
    fn pixel_at(path: &str, seconds: f64, x: u32, y: u32) -> (u8, u8, u8) {
        let out = crate::sidecar::command("ffmpeg")
            .args([
                "-v", "error", "-ss", &format!("{seconds}"), "-i", path,
                "-vf", &format!("crop=2:2:{x}:{y},format=rgb24"),
                "-frames:v", "1", "-f", "rawvideo", "-",
            ])
            .output()
            .expect("ffmpeg read a pixel");
        let bytes = out.stdout;
        assert!(bytes.len() >= 3, "no pixel came back at {seconds}s");
        (bytes[0], bytes[1], bytes[2])
    }

    fn looks_like(got: (u8, u8, u8), want: (u8, u8, u8)) -> bool {
        let tolerance = 60i32;
        (got.0 as i32 - want.0 as i32).abs() < tolerance
            && (got.1 as i32 - want.1 as i32).abs() < tolerance
            && (got.2 as i32 - want.2 as i32).abs() < tolerance
    }

    /// Where a layer actually lands, checked by looking at the pixels.
    ///
    /// A filtergraph that ffmpeg accepts can still put a layer in the wrong
    /// place — the arithmetic that turns a layout into an overlay position
    /// is exactly the sort that is off by half a width and looks plausible.
    /// Two flat colours make it possible to simply look.
    #[test]
    fn a_layer_lands_where_its_layout_says() {
        let (Some(red), Some(blue)) = (
            colour_source("jd-red.mp4", "red"),
            colour_source("jd-blue.mp4", "blue"),
        ) else {
            eprintln!("no ffmpeg to make test sources with; skipping");
            return;
        };

        let out = std::env::temp_dir().join("jd-overlay-test.mp4");
        let mut p = plan("mp4", vec![clip(&red, 0.0, 4.0)]);
        p.clips[0].audible = false;
        p.output_path = out.to_string_lossy().to_string();
        p.width = 640;
        p.height = 360;
        p.fps = 24;
        p.duration = 4.0;

        // Half the canvas wide, its centre a fifth of the way right of the
        // middle, and only on screen between 1s and 3s.
        let mut over = clip(&blue, 1.0, 2.0);
        over.audible = false;
        over.scale = 0.5;
        over.x = 0.2;
        over.y = 0.0;
        p.clips.push(over);

        let args = build_args(&p).expect("args");
        let run = crate::sidecar::command("ffmpeg")
            .args(&args)
            .stderr(Stdio::piped())
            .output()
            .expect("ffmpeg ran");
        assert!(
            run.status.success(),
            "{}",
            String::from_utf8_lossy(&run.stderr)
        );

        const RED: (u8, u8, u8) = (255, 0, 0);
        const BLUE: (u8, u8, u8) = (0, 0, 255);

        // The layer is 320 wide, centred on 0.7*640 = 448, so it covers
        // 288..608. Its own middle is blue; well left of it is still red.
        assert!(
            looks_like(pixel_at(&p.output_path, 2.0, 447, 179), BLUE),
            "the middle of the layer should be blue at 2s"
        );
        assert!(
            looks_like(pixel_at(&p.output_path, 2.0, 100, 179), RED),
            "left of the layer should still be red at 2s"
        );
        // Just outside each edge, and just inside, pin down its width.
        assert!(
            looks_like(pixel_at(&p.output_path, 2.0, 270, 179), RED),
            "the layer should not reach x=270"
        );
        assert!(
            looks_like(pixel_at(&p.output_path, 2.0, 300, 179), BLUE),
            "the layer should cover x=300"
        );
        // And it keeps to its stretch of the timeline.
        assert!(
            looks_like(pixel_at(&p.output_path, 0.5, 447, 179), RED),
            "the layer should not be there before it starts"
        );
        assert!(
            looks_like(pixel_at(&p.output_path, 3.5, 447, 179), RED),
            "the layer should be gone after it ends"
        );
    }

    /// A zoom that really zooms, checked by looking at the pixels.
    ///
    /// The filtergraph for a travelling framing is two expressions that
    /// have to agree — one sizing the picture in the clip's own time, one
    /// placing it in the timeline's. They can be individually plausible
    /// and still disagree, which no amount of reading the string would
    /// catch, so the render is measured instead.
    #[test]
    fn a_zoom_grows_the_picture_over_time() {
        let (Some(red), Some(blue)) = (
            colour_source("jd-z-red.mp4", "red"),
            colour_source("jd-z-blue.mp4", "blue"),
        ) else {
            eprintln!("no ffmpeg to make test sources with; skipping");
            return;
        };

        let out = std::env::temp_dir().join("jd-zoom-test.mp4");
        let mut p = plan("mp4", vec![clip(&red, 0.0, 4.0)]);
        p.clips[0].audible = false;
        p.output_path = out.to_string_lossy().to_string();
        p.width = 640;
        p.height = 360;
        p.fps = 24;
        p.duration = 4.0;

        // A blue layer starting at a quarter of the frame and growing to
        // fill it, held in the middle throughout.
        let mut over = clip(&blue, 0.0, 4.0);
        over.audible = false;
        over.zoom = vec![
            PlanZoomPoint { at: 0.0, scale: 0.25, x: 0.0, y: 0.0 },
            PlanZoomPoint { at: 4.0, scale: 1.0, x: 0.0, y: 0.0 },
        ];
        p.clips.push(over);

        let args = build_args(&p).expect("args");
        let run = crate::sidecar::command("ffmpeg")
            .args(&args)
            .stderr(Stdio::piped())
            .output()
            .expect("ffmpeg ran");
        assert!(
            run.status.success(),
            "ffmpeg refused the zoom:
{}",
            String::from_utf8_lossy(&run.stderr)
        );

        const RED: (u8, u8, u8) = (255, 0, 0);
        const BLUE: (u8, u8, u8) = (0, 0, 255);
        let path = &p.output_path;
        let middle_y = 179;

        // The middle is blue the whole way through: the layer is centred.
        for at in [0.2, 2.0, 3.8] {
            assert!(
                looks_like(pixel_at(path, at, 319, middle_y), BLUE),
                "the middle should be blue at {at}s"
            );
        }

        // x = 100 is covered only once the layer is wide enough to reach
        // it: half of 640*scale must exceed 220, so scale > 0.6875, which
        // the ramp reaches at about 2.9s.
        assert!(
            looks_like(pixel_at(path, 1.0, 100, middle_y), RED),
            "at 1s the layer is still too small to reach x=100"
        );
        assert!(
            looks_like(pixel_at(path, 3.8, 100, middle_y), BLUE),
            "by 3.8s the layer should have grown over x=100"
        );
    }

    /// A zoom that also travels sideways, so the two expressions are
    /// checked against each other rather than only against themselves.
    #[test]
    fn a_zoom_can_pan_while_it_grows() {
        let (Some(red), Some(blue)) = (
            colour_source("jd-p-red.mp4", "red"),
            colour_source("jd-p-blue.mp4", "blue"),
        ) else {
            eprintln!("no ffmpeg to make test sources with; skipping");
            return;
        };

        let out = std::env::temp_dir().join("jd-pan-test.mp4");
        let mut p = plan("mp4", vec![clip(&red, 0.0, 4.0)]);
        p.clips[0].audible = false;
        p.output_path = out.to_string_lossy().to_string();
        p.width = 640;
        p.height = 360;
        p.fps = 24;
        p.duration = 4.0;

        // Quarter size throughout, travelling from left of centre to right.
        let mut over = clip(&blue, 0.0, 4.0);
        over.audible = false;
        over.zoom = vec![
            PlanZoomPoint { at: 0.0, scale: 0.25, x: -0.3, y: 0.0 },
            PlanZoomPoint { at: 4.0, scale: 0.25, x: 0.3, y: 0.0 },
        ];
        p.clips.push(over);

        let args = build_args(&p).expect("args");
        let run = crate::sidecar::command("ffmpeg")
            .args(&args)
            .stderr(Stdio::piped())
            .output()
            .expect("ffmpeg ran");
        assert!(run.status.success(), "{}", String::from_utf8_lossy(&run.stderr));

        const RED: (u8, u8, u8) = (255, 0, 0);
        const BLUE: (u8, u8, u8) = (0, 0, 255);
        let path = &p.output_path;

        // 160 wide, centred at 0.2*640 = 128 early on and at 0.8*640 = 512
        // late on. So the left spot is blue first and red later, and the
        // right spot the other way about.
        assert!(looks_like(pixel_at(path, 0.2, 128, 179), BLUE), "left, early");
        assert!(looks_like(pixel_at(path, 0.2, 512, 179), RED), "right, early");
        assert!(looks_like(pixel_at(path, 3.8, 128, 179), RED), "left, late");
        assert!(looks_like(pixel_at(path, 3.8, 512, 179), BLUE), "right, late");
    }

    /// A title reaches the finished file.
    ///
    /// The editor draws a title to a transparent picture and the renderer
    /// lays it over the frame as a still. This paints a stand-in for that
    /// picture — an opaque block in a known place — and checks it is
    /// there, and only while the title is on the timeline.
    #[test]
    fn a_title_is_laid_over_the_picture() {
        let Some(red) = colour_source("jd-t-red.mp4", "red") else {
            eprintln!("no ffmpeg to make test sources with; skipping");
            return;
        };
        // Stands in for what the canvas produces: transparent everywhere
        // but a green band across the middle.
        let title = std::env::temp_dir().join("jd-title.png");
        let made = crate::sidecar::command("ffmpeg")
            .args([
                "-y", "-f", "lavfi", "-i",
                "color=c=black@0:s=640x360,format=rgba",
                "-f", "lavfi", "-i", "color=c=green:s=200x40",
                "-filter_complex", "[0][1]overlay=x=220:y=160[o]",
                "-map", "[o]", "-frames:v", "1",
                &title.to_string_lossy(),
            ])
            .output()
            .expect("ffmpeg ran");
        assert!(made.status.success(), "could not paint the stand-in title");

        let out = std::env::temp_dir().join("jd-title-test.mp4");
        let mut p = plan("mp4", vec![clip(&red, 0.0, 4.0)]);
        p.clips[0].audible = false;
        p.output_path = out.to_string_lossy().to_string();
        p.width = 640;
        p.height = 360;
        p.fps = 24;
        p.duration = 4.0;

        // On screen only between 1s and 3s, laid over the frame whole.
        let mut over = clip(&title.to_string_lossy(), 1.0, 2.0);
        over.audible = false;
        over.still = true;
        p.clips.push(over);

        let args = build_args(&p).expect("args");
        let run = crate::sidecar::command("ffmpeg")
            .args(&args)
            .stderr(Stdio::piped())
            .output()
            .expect("ffmpeg ran");
        assert!(run.status.success(), "{}", String::from_utf8_lossy(&run.stderr));

        const RED: (u8, u8, u8) = (255, 0, 0);
        const GREEN: (u8, u8, u8) = (0, 128, 0);
        let path = &p.output_path;

        // The band shows while the title is on, and the picture beneath it
        // shows through everywhere the title left transparent.
        assert!(
            looks_like(pixel_at(path, 2.0, 320, 179), GREEN),
            "the title should be on screen at 2s"
        );
        assert!(
            looks_like(pixel_at(path, 2.0, 40, 179), RED),
            "the picture should show through beside it"
        );
        assert!(
            looks_like(pixel_at(path, 0.5, 320, 179), RED),
            "the title should not be there before it starts"
        );
        assert!(
            looks_like(pixel_at(path, 3.5, 320, 179), RED),
            "the title should be gone after it ends"
        );
    }

    #[test]
    fn odd_layer_widths_are_rounded_up() {
        // H.264 cannot encode an odd number of pixels.
        assert_eq!(even(1279.0), 1280);
        assert_eq!(even(640.4), 640);
    }
}
