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
/// Named the way the editor names them.
///
/// `rename_all` because the plan is composed in the editor, where these
/// are `trimStart` and `fadeIn`; without it serde looks for `trim_start`
/// and never finds it. `deny_unknown_fields` because of what happens when
/// it does not find one: a field with a default is quietly left at zero,
/// so a misspelled `fadeIn` would export every transition with no fade at
/// all and say nothing. Refusing the whole plan is the lesser failure.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
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
    /// Whether the project's corner radius applies. Footage is rounded; a
    /// title, being words on a transparent sheet, is not.
    #[serde(default)]
    pub rounded: bool,
    /// How long it fades up at its start and away at its end, in its own
    /// seconds. Zero for a transition that only moves the picture, whose
    /// travelling is described by `zoom` instead, and for a plain cut.
    #[serde(default)]
    pub fade_in: f64,
    #[serde(default)]
    pub fade_out: f64,
    /// Extra seconds of its own material to keep playing after its end, so
    /// the clip after it can arrive over the top rather than out of the
    /// backdrop.
    #[serde(default)]
    pub hold: f64,
    /// The part of that hold there is no material left for, held on the
    /// last frame instead.
    #[serde(default)]
    pub freeze: f64,
    /// How fast it plays. Every other figure here is in timeline seconds;
    /// this is what turns them into seconds of the file.
    #[serde(default = "one")]
    pub speed: f64,
    /// Width as a fraction of the stage, and the centre of the layer as a
    /// fraction of the stage measured from the stage's own centre.
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
#[serde(deny_unknown_fields)]
pub struct PlanZoomPoint {
    pub at: f64,
    pub scale: f64,
    pub x: f64,
    pub y: f64,
}

/// A rectangle inside the frame, in the frame's own pixels.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PlanRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PlanVolumePoint {
    pub at: f64,
    pub gain: f64,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExportPlan {
    pub output_path: String,
    pub format: String,
    /// Canvas size. Always even, because H.264 cannot encode odd ones.
    pub width: u32,
    pub height: u32,
    /// Where the footage goes inside that canvas: the frame inset by the
    /// project's padding. Placements are fractions of this, not of the
    /// whole frame, which is what the preview measures them against.
    pub stage: PlanRect,
    /// Corner radius for footage, in the frame's own pixels.
    #[serde(default)]
    pub radius: f64,
    /// The backdrop the editor painted, on disk. None leaves the frame
    /// black behind the footage.
    #[serde(default)]
    pub backdrop: Option<String>,
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

/// Puts a picture the editor drew on disk for the renderer to overlay.
///
/// Named after what it belongs to rather than given a fresh name each
/// time, so exporting the same project twice leaves one file per title
/// instead of a growing pile of them.
pub fn write_overlay_image(
    app: &tauri::AppHandle,
    name: &str,
    bytes: &[u8],
) -> Result<String, String> {
    // Only the characters a file name can safely hold; the name is ours,
    // but a path is not the place to trust that.
    let safe: String = name
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect();
    if safe.is_empty() {
        return Err("A picture needs a name to be stored under.".to_string());
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

/// Normal speed, for a plan written before clips could have one.
fn one() -> f64 {
    1.0
}

/// Playing faster or slower without the voices going with it.
///
/// `atempo` is the filter that changes the pace of sound while leaving its
/// pitch alone, which is the whole point: a recording at double speed
/// should take half as long, not come out an octave higher. It is only
/// dependable between half and double, so anything further is reached by
/// chaining several of them — two halvings for a quarter speed, two
/// doublings for four times.
fn tempo_chain(speed: f64) -> String {
    if (speed - 1.0).abs() < 1e-6 {
        return String::new();
    }
    let mut steps: Vec<f64> = Vec::new();
    let mut left = speed;
    while left > 2.0 {
        steps.push(2.0);
        left /= 2.0;
    }
    while left < 0.5 {
        steps.push(0.5);
        left *= 2.0;
    }
    steps.push(left);
    steps
        .iter()
        .map(|step| format!("atempo={step:.6}"))
        .collect::<Vec<_>>()
        .join(",")
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
/// Adds one input to the command and answers with the index ffmpeg will
/// know it by.
///
/// The indices matter: every reference in the filter chain is written as
/// `[n:v]`, so they have to be handed out in the same order the inputs are
/// pushed rather than assumed to match the position of a clip in the plan.
/// The backdrop is an input too, and it comes first.
fn add_input(
    args: &mut Vec<String>,
    count: &mut usize,
    path: &str,
    // Some(seconds) when it is a still with no length of its own.
    still_for: Option<f64>,
) -> usize {
    if let Some(seconds) = still_for {
        args.push("-loop".into());
        args.push("1".into());
        args.push("-t".into());
        args.push(format!("{seconds:.4}"));
    }
    args.push("-i".into());
    args.push(path.to_string());
    let index = *count;
    *count += 1;
    index
}

/// The alpha of a rounded rectangle, as an expression `geq` can evaluate.
///
/// Worked in the clip's own pixels, before it is scaled onto the stage, so
/// the mask is made once from a single frame instead of on every frame of
/// a moving picture. `radius` is given in the finished frame's pixels and
/// `layer_width` is how wide the clip ends up there, which is what turns
/// one into the other.
///
/// The half-pixel in the middle is a soft edge: without it the corners
/// come out as a staircase.
fn rounded_alpha(radius: f64, layer_width: f64) -> String {
    let r = format!("({:.4}*W/{:.4})", radius, layer_width);
    format!(
        "clip(255*({r}+0.5-hypot(         max(max({r}-X,X-(W-1-{r})),0),         max(max({r}-Y,Y-(H-1-{r})),0))),0,255)"
    )
}

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
    let mut input_count = 0usize;
    // The backdrop goes in first so that the numbering is settled before
    // any clip is added, and so it is there to be laid everything else on.
    let backdrop_input = if audio_only {
        None
    } else {
        plan.backdrop
            .as_deref()
            .map(|path| add_input(&mut args, &mut input_count, path, Some(plan.duration)))
    };
    let clip_inputs: Vec<usize> = plan
        .clips
        .iter()
        .map(|clip| {
            // A still is held for as long as it is shown, the hold for the
            // clip arriving over it included.
            let still_for = if clip.still {
                Some(clip.duration + clip.hold)
            } else {
                None
            };
            add_input(&mut args, &mut input_count, &clip.path, still_for)
        })
        .collect();

    let mut chains: Vec<String> = Vec::new();
    // Names the stage the picture has reached, so each layer knows what to
    // lay itself over. Unused when only sound is being written out.
    let mut last_video;

    if !audio_only {
        // What everything is laid over, and what shows through wherever
        // the timeline is empty: the backdrop the editor painted, or a
        // black canvas when the project has none.
        match backdrop_input {
            Some(input) => chains.push(format!(
                "[{input}:v]scale={w}:{h},setsar=1,fps={fps}[bg]",
                input = input,
                w = plan.width,
                h = plan.height,
                fps = plan.fps,
            )),
            None => chains.push(format!(
                "color=c=black:s={}x{}:r={}:d={:.4}[bg]",
                plan.width, plan.height, plan.fps, plan.duration
            )),
        }
        last_video = "bg".to_string();

        let stage = &plan.stage;

        for (index, clip) in plan.clips.iter().enumerate() {
            if !clip.visual {
                continue;
            }
            let input = clip_inputs[index];
            let zooms = !clip.zoom.is_empty();

            // Sized against the stage rather than the whole frame: a clip
            // at full size fills the picture inside the padding, which is
            // exactly what the preview shows.
            //
            // A clip that zooms is scaled afresh on every frame; one that
            // holds still is scaled once, which is far cheaper and is what
            // nearly every clip does.
            let sizing = if zooms {
                // Worked in the clip's own time: `setpts` has already put
                // its first frame at zero, and the scaling happens before
                // the padding that moves it onto the timeline.
                format!(
                    "scale=w='{:.2}*({})':h=-2:eval=frame",
                    stage.width,
                    travelling(&clip.zoom, 0.0, |point| point.scale),
                )
            } else {
                format!("scale={}:-2", even(stage.width * clip.scale).max(2))
            };

            // The corners, cut out of the clip before it is scaled.
            //
            // Doing it before means the shape is worked out once, from a
            // single frame, rather than for every pixel of every frame —
            // and it means the mask is always exactly the size of the
            // picture it belongs to, with no arithmetic on this side left
            // to disagree with what `scale` decided.
            // Beyond its own end when the clip after it arrives with a
            // transition: it keeps playing underneath for that long.
            let shown = clip.duration + clip.hold;
            // How much of the file that takes, and the stretching that
            // turns it back into that much time on the timeline. Every
            // figure after this point is in timeline seconds again, which
            // is what lets the fades, the freeze and the travelling framing
            // all be written without a thought for the speed.
            let speed = if clip.speed > 0.0 { clip.speed } else { 1.0 };
            let material = shown * speed;
            let pacing = if (speed - 1.0).abs() < 1e-6 {
                "setpts=PTS-STARTPTS".to_string()
            } else {
                format!("setpts=(PTS-STARTPTS)/{speed:.6}")
            };

            // Fades are written in the clip's own time, which `setpts` has
            // already rebased to zero. The one at the end is measured from
            // the clip's own end, not from the end of the hold: the hold is
            // there to be faded over, not to be faded.
            let mut fades = String::new();
            if clip.fade_in > 0.0 {
                fades.push_str(&format!(
                    "fade=t=in:st=0:d={:.4}:alpha=1,",
                    clip.fade_in
                ));
            }
            if clip.fade_out > 0.0 {
                fades.push_str(&format!(
                    "fade=t=out:st={:.4}:d={:.4}:alpha=1,",
                    (clip.duration - clip.fade_out).max(0.0),
                    clip.fade_out
                ));
            }

            // When the file runs out before the hold does, the last frame
            // stands in for the rest.
            let freeze = if clip.freeze > 0.0 && !clip.still {
                format!(
                    "tpad=stop_mode=clone:stop_duration={:.4},",
                    clip.freeze
                )
            } else {
                String::new()
            };

            let layer_width = stage.width * clip.scale;
            let rounds = clip.rounded && plan.radius >= 0.5 && layer_width >= 1.0;
            // Joins the picture to whatever comes next: a bare comma when
            // the corners are square, otherwise a detour that forks off a
            // single frame, turns it into the mask, and merges it back in
            // as the alpha channel.
            let rounding = if rounds {
                format!(
                    ",split[c{index}][k{index}];[k{index}]trim=end_frame=1,format=gray,geq=lum='{alpha}'[m{index}];[c{index}][m{index}]alphamerge,",
                    index = index,
                    alpha = rounded_alpha(plan.radius, layer_width),
                )
            } else {
                ",".to_string()
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
                // rather than with black, and so the rounded corners and
                // the fades have an alpha channel to work on. The fades
                // come after the corners: `alphamerge` sets the alpha
                // outright, so a fade applied before it would be thrown
                // away by the mask.
                "[{input}:v]trim=start={trim:.4}:duration={dur:.4},{pacing},{freeze}format=rgba{rounding}{fades}{sizing},setsar=1,fps={fps},tpad=start_duration={start:.4}:start_mode=add:color=black@0[v{index}]",
                input = input,
                index = index,
                trim = clip.trim_start,
                dur = material,
                pacing = pacing,
                freeze = freeze,
                rounding = rounding,
                fades = fades,
                sizing = sizing,
                fps = plan.fps,
                start = clip.start,
            ));

            // The framing gives the centre of the layer within the stage;
            // overlay wants its top-left in the whole frame, so the stage
            // is added back on and half the layer's own size comes off.
            // Overlay reads the timeline's clock, so a travelling position
            // has to be offset by where the clip begins.
            let (position_x, position_y) = if zooms {
                (
                    format!(
                        "'{:.2}+(0.5+({}))*{:.2}-overlay_w/2'",
                        stage.x,
                        travelling(&clip.zoom, clip.start, |point| point.x),
                        stage.width
                    ),
                    format!(
                        "'{:.2}+(0.5+({}))*{:.2}-overlay_h/2'",
                        stage.y,
                        travelling(&clip.zoom, clip.start, |point| point.y),
                        stage.height
                    ),
                )
            } else {
                (
                    format!("{:.2}-overlay_w/2", stage.x + (0.5 + clip.x) * stage.width),
                    format!("{:.2}-overlay_h/2", stage.y + (0.5 + clip.y) * stage.height),
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
            let speed = if clip.speed > 0.0 { clip.speed } else { 1.0 };
            // The volume line is read before the clip is moved into place,
            // so its times are the clip's own — which is how the editor
            // draws it.
            let mut chain = format!(
                "[{input}:a]atrim=start={trim:.4}:duration={dur:.4},asetpts=PTS-STARTPTS",
                input = clip_inputs[index],
                trim = clip.trim_start,
                dur = clip.duration * speed,
            );
            // Paced before the volume line is applied, not after: the line
            // is drawn against the clip on the timeline, and until the
            // sound has been brought back to that pace its own clock is
            // running at the speed of the file.
            let tempo = tempo_chain(speed);
            if !tempo.is_empty() {
                chain.push(',');
                chain.push_str(&tempo);
            }
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
            rounded: false,
            fade_in: 0.0,
            fade_out: 0.0,
            hold: 0.0,
            freeze: 0.0,
            speed: 1.0,
            scale: 1.0,
            x: 0.0,
            y: 0.0,
            volume: Vec::new(),
            zoom: Vec::new(),
        }
    }

    /// The stage of a project with no padding: the whole frame.
    fn full_frame(width: u32, height: u32) -> PlanRect {
        PlanRect {
            x: 0.0,
            y: 0.0,
            width: width as f64,
            height: height as f64,
        }
    }

    /// A plan with no padding, so the stage is the whole frame. Tests that
    /// care about padding set their own stage.
    fn plan(format: &str, clips: Vec<PlanClip>) -> ExportPlan {
        ExportPlan {
            output_path: "out.mp4".into(),
            format: format.into(),
            width: 1280,
            height: 720,
            stage: full_frame(1280, 720),
            radius: 0.0,
            backdrop: None,
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
        // In step with the frame, or every placement would be worked out
        // against a stage twice the size of the picture it lands on.
        p.stage = full_frame(p.width, p.height);
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

    /// A single flat-coloured picture on disk, to stand in for a backdrop.
    fn colour_picture(name: &str, colour: &str, width: u32, height: u32) -> Option<String> {
        let out = std::env::temp_dir().join(name);
        let status = crate::sidecar::command("ffmpeg")
            .args([
                "-y",
                "-f",
                "lavfi",
                "-i",
                &format!("color=c={colour}:s={width}x{height}:d=1"),
                "-frames:v",
                "1",
                &out.to_string_lossy(),
            ])
            .output()
            .ok()?;
        status
            .status
            .success()
            .then(|| out.to_string_lossy().to_string())
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
        p.stage = full_frame(p.width, p.height);
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
        p.stage = full_frame(p.width, p.height);
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
        p.stage = full_frame(p.width, p.height);
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
        p.stage = full_frame(p.width, p.height);
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

    /// A project with padding, rendered and then looked at.
    ///
    /// Everything about the backdrop is a promise the preview makes on the
    /// export's behalf: that the picture is inset by this much, that this
    /// colour is what shows around it, that the corners are cut. The only
    /// way to know the promise is kept is to render a frame and read the
    /// pixels back.
    ///
    /// A stage of 480x270 inset into a 640x360 frame — the frame's own
    /// shape, an eighth in on every side — is used throughout, so the
    /// numbers below can be read off by hand.
    fn padded_plan(clip_path: &str, backdrop: Option<String>, radius: f64) -> ExportPlan {
        let mut p = plan("mp4", vec![clip(clip_path, 0.0, 4.0)]);
        p.clips[0].audible = false;
        p.clips[0].rounded = true;
        p.width = 640;
        p.height = 360;
        p.fps = 24;
        p.duration = 4.0;
        p.stage = PlanRect {
            x: 80.0,
            y: 45.0,
            width: 480.0,
            height: 270.0,
        };
        p.radius = radius;
        p.backdrop = backdrop;
        p
    }

    fn run_plan(p: &ExportPlan) {
        let args = build_args(p).expect("args");
        let run = crate::sidecar::command("ffmpeg")
            .args(&args)
            .stderr(Stdio::piped())
            .output()
            .expect("ffmpeg ran");
        assert!(
            run.status.success(),
            "{}
args: {}",
            String::from_utf8_lossy(&run.stderr),
            args.join(" ")
        );
    }

    const GREEN: (u8, u8, u8) = (0, 128, 0);
    const BLUE: (u8, u8, u8) = (0, 0, 255);
    const RED: (u8, u8, u8) = (255, 0, 0);

    #[test]
    fn padding_lets_the_backdrop_show_around_the_footage() {
        let (Some(blue), Some(green)) = (
            colour_source("jd-pad-blue.mp4", "blue"),
            colour_picture("jd-pad-backdrop.png", "green", 640, 360),
        ) else {
            eprintln!("no ffmpeg to make test sources with; skipping");
            return;
        };

        let mut p = padded_plan(&blue, Some(green), 0.0);
        let out = std::env::temp_dir().join("jd-padded.mp4");
        p.output_path = out.to_string_lossy().to_string();
        run_plan(&p);

        // Outside the stage on every side: the backdrop.
        for (x, y, where_) in [
            (10, 180, "left of the stage"),
            (620, 180, "right of the stage"),
            (320, 10, "above the stage"),
            (320, 340, "below the stage"),
        ] {
            assert!(
                looks_like(pixel_at(&p.output_path, 2.0, x, y), GREEN),
                "the backdrop should show {where_}"
            );
        }

        // Inside it: the footage, right up to the edge.
        for (x, y, where_) in [
            (320, 180, "in the middle"),
            (84, 180, "just inside the left edge"),
            (554, 180, "just inside the right edge"),
            (320, 49, "just inside the top edge"),
            (320, 309, "just inside the bottom edge"),
        ] {
            assert!(
                looks_like(pixel_at(&p.output_path, 2.0, x, y), BLUE),
                "the footage should reach {where_}"
            );
        }
    }

    /// A title is drawn on the whole picture, padding included.
    ///
    /// The editor draws a title at the frame's own size and gives it a
    /// scale that says so: the frame measured in stage widths. If this end
    /// were to place it against the stage instead, the words would shrink
    /// by the padding and slide with it, and the file would no longer be
    /// the picture that was on screen. Rendered and read back rather than
    /// asserted on the command, because the command is not the promise.
    #[test]
    fn a_title_covers_the_whole_frame_and_not_the_padded_inset() {
        let (Some(blue), Some(green), Some(red)) = (
            colour_source("jd-title-blue.mp4", "blue"),
            colour_picture("jd-title-backdrop.png", "green", 640, 360),
            // The drawing, made at the frame's size the way `renderTitles`
            // makes it.
            colour_picture("jd-title-words.png", "red", 640, 360),
        ) else {
            eprintln!("no ffmpeg to make test sources with; skipping");
            return;
        };

        let mut p = padded_plan(&blue, Some(green), 0.0);
        let mut title = clip(&red, 0.0, 4.0);
        title.still = true;
        title.audible = false;
        title.rounded = false;
        // 640 / 480: the frame, in stage widths.
        title.scale = 640.0 / 480.0;
        p.clips.push(title);
        let out = std::env::temp_dir().join("jd-title-frame.mp4");
        p.output_path = out.to_string_lossy().to_string();
        run_plan(&p);

        // The corners of the frame are outside the stage. The drawing has
        // to reach them, or it was laid on the inset.
        for (x, y, where_) in [
            (4, 4, "the top left corner"),
            (636, 4, "the top right corner"),
            (4, 356, "the bottom left corner"),
            (636, 356, "the bottom right corner"),
            (320, 180, "the middle"),
        ] {
            assert!(
                looks_like(pixel_at(&p.output_path, 2.0, x, y), RED),
                "the title should cover {where_}"
            );
        }
    }

    #[test]
    fn a_corner_radius_cuts_the_footage_and_not_the_frame() {
        let (Some(blue), Some(green)) = (
            colour_source("jd-round-blue.mp4", "blue"),
            colour_picture("jd-round-backdrop.png", "green", 640, 360),
        ) else {
            eprintln!("no ffmpeg to make test sources with; skipping");
            return;
        };

        // The stage's top-left corner is at (80, 45). With a radius of 40
        // the corner arc is centred on (120, 85), so a point 2px in from
        // the corner is nearly 14px outside the arc — far enough that no
        // amount of smoothing or colour subsampling could account for it.
        let square = {
            let mut p = padded_plan(&blue, Some(green.clone()), 0.0);
            let out = std::env::temp_dir().join("jd-square-corner.mp4");
            p.output_path = out.to_string_lossy().to_string();
            run_plan(&p);
            pixel_at(&p.output_path, 2.0, 82, 47)
        };
        let rounded = {
            let mut p = padded_plan(&blue, Some(green), 40.0);
            let out = std::env::temp_dir().join("jd-round-corner.mp4");
            p.output_path = out.to_string_lossy().to_string();
            run_plan(&p);
            (
                pixel_at(&p.output_path, 2.0, 82, 47),
                pixel_at(&p.output_path, 2.0, 120, 85),
                pixel_at(&p.output_path, 2.0, 84, 180),
            )
        };

        assert!(
            looks_like(square, BLUE),
            "with no radius the corner is footage, got {square:?}"
        );
        assert!(
            looks_like(rounded.0, GREEN),
            "the radius should cut the corner away, got {:?}",
            rounded.0
        );
        assert!(
            looks_like(rounded.1, BLUE),
            "inside the arc is still footage, got {:?}",
            rounded.1
        );
        assert!(
            looks_like(rounded.2, BLUE),
            "a straight edge is untouched by the radius, got {:?}",
            rounded.2
        );
    }

    #[test]
    fn a_half_size_layer_is_half_the_stage_not_half_the_frame() {
        let (Some(red), Some(blue)) = (
            colour_source("jd-stage-red.mp4", "red"),
            colour_source("jd-stage-blue.mp4", "blue"),
        ) else {
            eprintln!("no ffmpeg to make test sources with; skipping");
            return;
        };

        let mut p = padded_plan(&red, None, 0.0);
        let mut over = clip(&blue, 0.0, 4.0);
        over.audible = false;
        over.scale = 0.5;
        p.clips.push(over);
        let out = std::env::temp_dir().join("jd-stage-scale.mp4");
        p.output_path = out.to_string_lossy().to_string();
        run_plan(&p);

        // Half of the 480-wide stage is 240, centred on the stage's own
        // middle at x=320: so it covers 200..440. Half the frame would
        // have covered 160..480, which is what the check at 180 rules out.
        const RED: (u8, u8, u8) = (255, 0, 0);
        assert!(
            looks_like(pixel_at(&p.output_path, 2.0, 320, 180), BLUE),
            "the middle of the overlay should be the overlay"
        );
        assert!(
            looks_like(pixel_at(&p.output_path, 2.0, 210, 180), BLUE),
            "the overlay should reach x=210"
        );
        assert!(
            looks_like(pixel_at(&p.output_path, 2.0, 180, 180), RED),
            "the overlay should not reach x=180 — that would be half the frame"
        );
    }

    /// Two clips that meet, with the second arriving over the first.
    ///
    /// A transition is the one thing in the editor that cannot be checked
    /// by reading the filtergraph: whether it dissolves or cuts depends on
    /// whether the clip underneath is still being drawn, and the only way
    /// to know is to look at a frame in the middle of it. Two flat colours
    /// make the answer a single pixel.
    fn dissolving_pair(fade: f64, hold: f64, freeze: f64) -> Option<String> {
        let (Some(red), Some(blue)) = (
            colour_source("jd-xf-red.mp4", "red"),
            colour_source("jd-xf-blue.mp4", "blue"),
        ) else {
            return None;
        };

        let mut first = clip(&red, 0.0, 2.0);
        first.audible = false;
        first.hold = hold;
        first.freeze = freeze;

        let mut second = clip(&blue, 2.0, 2.0);
        second.audible = false;
        second.fade_in = fade;

        let mut p = plan("mp4", vec![first, second]);
        p.width = 640;
        p.height = 360;
        p.stage = full_frame(p.width, p.height);
        p.fps = 24;
        p.duration = 4.0;
        let out = std::env::temp_dir().join(format!("jd-xfade-{fade}-{hold}.mp4"));
        p.output_path = out.to_string_lossy().to_string();
        run_plan(&p);
        Some(p.output_path)
    }

    fn between(got: (u8, u8, u8), a: (u8, u8, u8), b: (u8, u8, u8)) -> bool {
        let mid = |x: u8, y: u8| (x as i32 + y as i32) / 2;
        let close = |got: u8, want: i32| (got as i32 - want).abs() < 45;
        close(got.0, mid(a.0, b.0)) && close(got.1, mid(a.1, b.1)) && close(got.2, mid(a.2, b.2))
    }

    #[test]
    fn a_dissolve_shows_both_clips_at_once() {
        const RED: (u8, u8, u8) = (255, 0, 0);
        const BLUE: (u8, u8, u8) = (0, 0, 255);

        let Some(faded) = dissolving_pair(1.0, 1.0, 0.0) else {
            eprintln!("no ffmpeg to make test sources with; skipping");
            return;
        };
        // A plain cut at the same moment, to show the difference is the
        // transition and not something about the two files.
        let Some(cut) = dissolving_pair(0.0, 0.0, 0.0) else {
            return;
        };

        let half = pixel_at(&faded, 2.5, 318, 178);
        assert!(
            between(half, RED, BLUE),
            "halfway through a dissolve should be halfway between the two clips, got {half:?}"
        );

        // Just after the cut the outgoing clip is still nearly all of it —
        // which is only possible if it is still being drawn underneath.
        let early = pixel_at(&faded, 2.1, 318, 178);
        assert!(
            looks_like(early, RED),
            "a tenth into the dissolve should still be mostly the first clip, got {early:?}"
        );

        // And by the end of it, none of the first clip is left.
        let done = pixel_at(&faded, 3.2, 318, 178);
        assert!(
            looks_like(done, BLUE),
            "past the dissolve only the second clip is left, got {done:?}"
        );

        // Without the transition the same moments are a hard cut.
        assert!(
            looks_like(pixel_at(&cut, 2.1, 318, 178), BLUE),
            "a cut is a cut: no trace of the clip before it"
        );
    }

    #[test]
    fn a_held_clip_freezes_when_its_file_runs_out() {
        const RED: (u8, u8, u8) = (255, 0, 0);
        const BLUE: (u8, u8, u8) = (0, 0, 255);
        // Nothing held from the file at all: every held frame is a clone
        // of the last one. The picture should still be there.
        let Some(frozen) = dissolving_pair(1.0, 0.0, 1.0) else {
            eprintln!("no ffmpeg to make test sources with; skipping");
            return;
        };
        let half = pixel_at(&frozen, 2.5, 318, 178);
        assert!(
            between(half, RED, BLUE),
            "a frozen last frame should dissolve just the same, got {half:?}"
        );
    }

    #[test]
    fn a_clip_can_fade_away_to_the_backdrop() {
        let (Some(blue), Some(green)) = (
            colour_source("jd-out-blue.mp4", "blue"),
            colour_picture("jd-out-backdrop.png", "green", 640, 360),
        ) else {
            eprintln!("no ffmpeg to make test sources with; skipping");
            return;
        };

        let mut only = clip(&blue, 0.0, 4.0);
        only.audible = false;
        only.fade_out = 1.0;
        let mut p = plan("mp4", vec![only]);
        p.width = 640;
        p.height = 360;
        p.stage = full_frame(p.width, p.height);
        p.fps = 24;
        p.duration = 4.0;
        p.backdrop = Some(green);
        let out = std::env::temp_dir().join("jd-fadeout.mp4");
        p.output_path = out.to_string_lossy().to_string();
        run_plan(&p);

        const GREEN: (u8, u8, u8) = (0, 128, 0);
        const BLUE: (u8, u8, u8) = (0, 0, 255);
        assert!(
            looks_like(pixel_at(&p.output_path, 1.0, 318, 178), BLUE),
            "before the fade it is the clip"
        );
        assert!(
            between(pixel_at(&p.output_path, 3.5, 318, 178), BLUE, GREEN),
            "halfway out it is half the backdrop"
        );
        assert!(
            looks_like(pixel_at(&p.output_path, 3.95, 318, 178), GREEN),
            "at the very end the backdrop is all that is left"
        );
    }

    #[test]
    fn a_fade_keeps_the_rounded_corners() {
        let (Some(blue), Some(green)) = (
            colour_source("jd-rf-blue.mp4", "blue"),
            colour_picture("jd-rf-backdrop.png", "green", 640, 360),
        ) else {
            eprintln!("no ffmpeg to make test sources with; skipping");
            return;
        };

        // The mask sets the alpha channel outright and the fade scales it.
        // In the wrong order one wipes out the other, which would show as
        // square corners or as no fade at all.
        let mut p = padded_plan(&blue, Some(green), 40.0);
        p.clips[0].fade_in = 1.0;
        let out = std::env::temp_dir().join("jd-round-fade.mp4");
        p.output_path = out.to_string_lossy().to_string();
        run_plan(&p);

        const GREEN: (u8, u8, u8) = (0, 128, 0);
        const BLUE: (u8, u8, u8) = (0, 0, 255);
        assert!(
            looks_like(pixel_at(&p.output_path, 2.0, 82, 47), GREEN),
            "the corner is still cut away once the fade is over"
        );
        assert!(
            looks_like(pixel_at(&p.output_path, 2.0, 320, 180), BLUE),
            "and the middle is still the footage"
        );
        assert!(
            between(pixel_at(&p.output_path, 0.5, 320, 180), BLUE, GREEN),
            "halfway through the fade the backdrop shows through"
        );
    }

    #[test]
    fn tempo_is_chained_to_stay_in_the_filters_range() {
        // atempo is only dependable between half and double, so anything
        // beyond that has to be reached in steps.
        assert_eq!(tempo_chain(1.0), "");
        assert_eq!(tempo_chain(2.0), "atempo=2.000000");
        assert_eq!(tempo_chain(0.5), "atempo=0.500000");
        assert_eq!(tempo_chain(4.0), "atempo=2.000000,atempo=2.000000");
        assert_eq!(tempo_chain(0.25), "atempo=0.500000,atempo=0.500000");
        assert_eq!(tempo_chain(3.0), "atempo=2.000000,atempo=1.500000");
        // Whatever the chain, the steps multiply back to what was asked.
        for speed in [0.25, 0.4, 0.75, 1.5, 2.5, 3.3, 4.0] {
            let product: f64 = tempo_chain(speed)
                .split(',')
                .filter(|part| !part.is_empty())
                .map(|part| part.trim_start_matches("atempo=").parse::<f64>().unwrap())
                .product();
            assert!(
                (product - speed).abs() < 1e-4,
                "{speed} came out as {product}"
            );
        }
    }

    /// A source that is red for its first half and blue for its second, so
    /// that when a moment of it is shown can be read off a single pixel.
    fn two_halves(name: &str) -> Option<String> {
        let out = std::env::temp_dir().join(name);
        let status = crate::sidecar::command("ffmpeg")
            .args([
                "-y",
                "-f",
                "lavfi",
                "-i",
                "color=c=red:s=640x360:r=24:d=4",
                "-vf",
                "drawbox=x=0:y=0:w=640:h=360:color=blue@1:t=fill:enable='gte(t,2)'",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
                &out.to_string_lossy(),
            ])
            .output()
            .ok()?;
        status
            .status
            .success()
            .then(|| out.to_string_lossy().to_string())
    }

    #[test]
    fn speed_plays_more_of_the_file_in_less_time() {
        const RED: (u8, u8, u8) = (255, 0, 0);
        const BLUE: (u8, u8, u8) = (0, 0, 255);
        let Some(source) = two_halves("jd-halves.mp4") else {
            eprintln!("no ffmpeg to make test sources with; skipping");
            return;
        };

        let render = |speed: f64, seconds: f64, name: &str| {
            let mut only = clip(&source, 0.0, seconds);
            only.audible = false;
            only.speed = speed;
            let mut p = plan("mp4", vec![only]);
            p.width = 640;
            p.height = 360;
            p.stage = full_frame(p.width, p.height);
            p.fps = 24;
            p.duration = seconds;
            p.output_path = std::env::temp_dir()
                .join(name)
                .to_string_lossy()
                .to_string();
            run_plan(&p);
            p.output_path
        };

        // Four seconds of material in two: the change of colour that
        // happens halfway through the file should happen halfway through
        // the clip, which is now one second in rather than two.
        let fast = render(2.0, 2.0, "jd-speed-fast.mp4");
        assert!(
            looks_like(pixel_at(&fast, 0.5, 318, 178), RED),
            "the first half of the file is still the first half of the clip"
        );
        assert!(
            looks_like(pixel_at(&fast, 1.5, 318, 178), BLUE),
            "at twice speed the second half arrives after one second, not two"
        );

        // At normal speed the same two seconds show only the first half.
        let plain = render(1.0, 2.0, "jd-speed-plain.mp4");
        assert!(
            looks_like(pixel_at(&plain, 1.5, 318, 178), RED),
            "at normal speed two seconds is still the first half of the file"
        );

        // And slowed down, one second of material is stretched over two.
        let slow = render(0.5, 2.0, "jd-speed-slow.mp4");
        assert!(
            looks_like(pixel_at(&slow, 1.9, 318, 178), RED),
            "at half speed two seconds covers only the first second of the file"
        );
    }

    /// The pitch of a file's sound, by counting how often its waveform
    /// crosses zero: a steady tone crosses twice a cycle, so the count
    /// over a second is twice its frequency.
    ///
    /// Crude for music and exactly right for the single sine wave used
    /// here, and it needs nothing but the ffmpeg already at hand.
    fn tone_hz(path: &str) -> f64 {
        let out = crate::sidecar::command("ffmpeg")
            .args([
                "-v", "error", "-i", path, "-vn", "-ac", "1", "-ar", "16000", "-f",
                "s16le", "-",
            ])
            .output()
            .expect("ffmpeg ran");
        let samples: Vec<i16> = out
            .stdout
            .chunks_exact(2)
            .map(|pair| i16::from_le_bytes([pair[0], pair[1]]))
            .collect();

        // Silence at either end — an encoder's padding — crosses zero on
        // nothing but noise, so the count is taken between the first and
        // last moment the file is actually sounding.
        //
        // The stretch between them is kept whole. Dropping the quiet
        // samples instead would throw away the very part of each cycle
        // that crosses zero, and join what was left into a waveform that
        // crossed far more often than the tone ever did: a 440Hz tone
        // measured 652Hz that way.
        let loud = |sample: &i16| sample.unsigned_abs() > 2_000;
        let Some(first) = samples.iter().position(loud) else {
            return 0.0;
        };
        let last = samples.iter().rposition(loud).unwrap_or(first);
        let sounding = &samples[first..=last];

        let mut crossings = 0usize;
        for pair in sounding.windows(2) {
            if (pair[0] < 0) != (pair[1] < 0) {
                crossings += 1;
            }
        }
        let seconds = sounding.len() as f64 / 16_000.0;
        if seconds <= 0.0 {
            return 0.0;
        }
        crossings as f64 / seconds / 2.0
    }

    #[test]
    fn sound_changes_pace_without_changing_pitch() {
        // A steady tone, so that any shift in pitch is a number rather
        // than an impression.
        let tone = std::env::temp_dir().join("jd-tone.wav");
        let made = crate::sidecar::command("ffmpeg")
            .args([
                "-y",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:duration=4:sample_rate=48000",
                &tone.to_string_lossy(),
            ])
            .output();
        let Ok(made) = made else {
            eprintln!("no ffmpeg to make a tone with; skipping");
            return;
        };
        if !made.status.success() {
            eprintln!("could not make a tone; skipping");
            return;
        }
        let tone = tone.to_string_lossy().to_string();

        let before = tone_hz(&tone);
        assert!(
            (before - 440.0).abs() < 8.0,
            "the tone should be 440Hz to start with, measured {before:.1}"
        );

        let render = |speed: f64, seconds: f64, name: &str| {
            let mut only = clip(&tone, 0.0, seconds);
            only.visual = false;
            only.speed = speed;
            let mut p = plan("mp3", vec![only]);
            p.duration = seconds;
            p.output_path = std::env::temp_dir()
                .join(name)
                .to_string_lossy()
                .to_string();
            run_plan(&p);
            p.output_path
        };

        // Four seconds of tone in two, and again in eight.
        let fast = render(2.0, 2.0, "jd-tone-fast.mp3");
        let slow = render(0.5, 8.0, "jd-tone-slow.mp3");

        let fast_hz = tone_hz(&fast);
        let slow_hz = tone_hz(&slow);
        println!("440Hz -> {fast_hz:.1} at 2x, {slow_hz:.1} at 0.5x");

        assert!(
            (fast_hz - 440.0).abs() < 15.0,
            "at double speed the note should still be 440Hz, not {fast_hz:.1} \
             (880 would mean it had been played faster like a tape)"
        );
        assert!(
            (slow_hz - 440.0).abs() < 15.0,
            "at half speed the note should still be 440Hz, not {slow_hz:.1}"
        );

        // And it really did change pace, rather than being left alone.
        let length: f64 = probe(&fast, "format=duration").parse().unwrap_or(0.0);
        assert!(
            (length - 2.0).abs() < 0.3,
            "four seconds of tone at double speed should last two, lasted {length:.2}"
        );
    }

    #[test]
    fn a_tall_frame_renders_tall() {
        let (Some(blue), Some(green)) = (
            colour_source("jd-tall-blue.mp4", "blue"),
            colour_picture("jd-tall-backdrop.png", "green", 480, 854),
        ) else {
            eprintln!("no ffmpeg to make test sources with; skipping");
            return;
        };

        // A phone-shaped frame with widescreen footage in it: the picture
        // spans the width and the backdrop fills the space above and
        // below, which is what the preview shows for the same project.
        let mut only = clip(&blue, 0.0, 4.0);
        only.audible = false;
        let mut p = plan("mp4", vec![only]);
        p.width = 480;
        p.height = 854;
        p.stage = full_frame(p.width, p.height);
        p.fps = 24;
        p.duration = 4.0;
        p.backdrop = Some(green);
        let out = std::env::temp_dir().join("jd-tall.mp4");
        p.output_path = out.to_string_lossy().to_string();
        run_plan(&p);

        let shape = probe(&p.output_path, "stream=width,height");
        assert!(shape.contains("480,854"), "wrong canvas: {shape}");

        const GREEN: (u8, u8, u8) = (0, 128, 0);
        const BLUE: (u8, u8, u8) = (0, 0, 255);
        // 480 wide of 16:9 footage is 270 tall, centred: rows 292 to 562.
        assert!(
            looks_like(pixel_at(&p.output_path, 2.0, 238, 426), BLUE),
            "the middle of a tall frame is the footage"
        );
        assert!(
            looks_like(pixel_at(&p.output_path, 2.0, 238, 100), GREEN),
            "above it is the backdrop"
        );
        assert!(
            looks_like(pixel_at(&p.output_path, 2.0, 238, 750), GREEN),
            "and below it too"
        );
    }

    /// A plan as the editor actually sends it, read the way the command
    /// actually reads it.
    ///
    /// Every other test here builds a `PlanClip` in Rust and never goes
    /// near the wire — which is why all of them passed while exporting was
    /// impossible: the editor sends `trimStart` and this end was looking
    /// for `trim_start`. The names only exist in two places, and nothing
    /// until now compared them.
    ///
    /// The text below is copied from what `buildExportPlan` produced, not
    /// written from memory of what it ought to produce.
    const SENT_BY_THE_EDITOR: &str = r#"{
      "outputPath": "C:/out/film.mp4",
      "format": "mp4",
      "width": 1920,
      "height": 1080,
      "stage": { "x": 96, "y": 54, "width": 1728, "height": 972 },
      "radius": 21,
      "backdrop": "C:/cache/backdrop.png",
      "fps": 30,
      "duration": 10,
      "videoQuality": 23,
      "audioBitrateKbps": 192,
      "clips": [
        {
          "path": "C:/take.mp4",
          "start": 0,
          "duration": 5,
          "trimStart": 2.5,
          "visual": true,
          "audible": true,
          "still": false,
          "rounded": true,
          "fadeIn": 0,
          "fadeOut": 0,
          "hold": 1,
          "freeze": 0,
          "speed": 2,
          "scale": 1,
          "x": 0,
          "y": 0,
          "volume": [{ "at": 0, "gain": 1 }, { "at": 5, "gain": 0 }],
          "zoom": []
        },
        {
          "path": "C:/take.mp4",
          "start": 5,
          "duration": 5,
          "trimStart": 0,
          "visual": true,
          "audible": true,
          "still": false,
          "rounded": true,
          "fadeIn": 1,
          "fadeOut": 0.5,
          "hold": 0,
          "freeze": 0,
          "speed": 1,
          "scale": 1,
          "x": 0,
          "y": 0,
          "volume": [],
          "zoom": [{ "at": 0, "scale": 1, "x": 0, "y": 0 }, { "at": 5, "scale": 1, "x": -1, "y": 0 }]
        }
      ]
    }"#;

    #[test]
    fn the_plan_the_editor_sends_is_the_plan_this_end_reads() {
        let plan: ExportPlan =
            serde_json::from_str(SENT_BY_THE_EDITOR).expect("the editor's own plan");

        assert_eq!(plan.output_path, "C:/out/film.mp4");
        assert_eq!(plan.video_quality, 23);
        assert_eq!(plan.audio_bitrate_kbps, 192);
        assert_eq!(plan.stage.width, 1728.0);
        assert_eq!(plan.backdrop.as_deref(), Some("C:/cache/backdrop.png"));

        // The three that differ between the two ends. A default would have
        // left each of these at zero without a word.
        assert_eq!(plan.clips[0].trim_start, 2.5, "trimStart");
        assert_eq!(plan.clips[1].fade_in, 1.0, "fadeIn");
        assert_eq!(plan.clips[1].fade_out, 0.5, "fadeOut");

        assert_eq!(plan.clips[0].speed, 2.0);
        assert_eq!(plan.clips[0].hold, 1.0);
        assert_eq!(plan.clips[0].volume.len(), 2);
        assert_eq!(plan.clips[1].zoom.len(), 2);

        // And it builds a command, rather than merely parsing.
        let args = build_args(&plan).expect("args");
        let graph = args.join(" ");
        assert!(graph.contains("trim=start=2.5000"), "{graph}");
        assert!(graph.contains("fade=t=in:st=0:d=1.0000:alpha=1"), "{graph}");
    }

    #[test]
    fn a_field_this_end_does_not_know_is_refused_rather_than_ignored() {
        // The failure this guards against is the quiet one: a name that
        // does not match leaves the field at its default and the render
        // comes out wrong with nothing said. Refusing the plan turns that
        // into a message.
        let misspelled = SENT_BY_THE_EDITOR.replace("\"fadeIn\"", "\"fade_in\"");
        let refused: Result<ExportPlan, _> = serde_json::from_str(&misspelled);
        assert!(
            refused.is_err(),
            "a field this end does not know should be refused, not ignored"
        );
    }
}
