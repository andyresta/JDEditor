//! Captions written from what was said.
//!
//! The editor already knows how to put words on the screen: a caption is a
//! title clip, drawn by the same code that draws every other title, which
//! is why nothing in the renderer needs to learn about this at all. What is
//! missing is only the listening, and that is what this module does — pull
//! each clip's sound out with ffmpeg, send it to a transcription service,
//! and hand back short pieces of text with the moment each belongs to.
//!
//! Every service here is asked for one word at a time rather than whole
//! sentences. Captions of three or four words, changing as the speaker
//! speaks, need to know when each word was said, and sentence timings
//! cannot be split back down into that afterwards. A service that will not
//! time individual words does not belong on this list.

use std::collections::BTreeMap;
use std::io::Read;
use std::path::{Path, PathBuf};

use tauri::{Emitter, Manager};

/* ------------------------------------------------------------- engines */

/// How a service is spoken to. Three shapes cover the field: most of them
/// copy OpenAI's form-upload, Deepgram takes the audio as the body with
/// its options in the query, and ElevenLabs has a form of its own.
#[derive(Debug, Clone, Copy, PartialEq)]
enum Wire {
    OpenAi,
    Deepgram,
    ElevenLabs,
}

/// One service the editor can listen with.
pub struct Engine {
    pub id: &'static str,
    pub provider: &'static str,
    pub model: &'static str,
    /// What it is good for, in the words someone choosing would want.
    pub note: &'static str,
    /// Where its keys are issued, so the editor can point at it rather
    /// than leave someone searching.
    pub keys_at: &'static str,
    endpoint: &'static str,
    wire: Wire,
}

/// The services on offer.
///
/// Several rather than one, each with its own key, because a key is a
/// bill: whoever is paying should be able to pick who they pay, and to
/// keep a second one ready for when the first is rate-limited or out of
/// credit. Every one of these returns word-level timings.
pub const ENGINES: &[Engine] = &[
    Engine {
        id: "openai-whisper-1",
        provider: "OpenAI",
        model: "whisper-1",
        note: "Steady and widely available. Good Indonesian. Charged by the minute.",
        keys_at: "https://platform.openai.com/api-keys",
        endpoint: "https://api.openai.com/v1/audio/transcriptions",
        wire: Wire::OpenAi,
    },
    Engine {
        id: "groq-whisper-large-v3-turbo",
        provider: "Groq",
        model: "whisper-large-v3-turbo",
        note: "The quickest of these by a distance, and the cheapest. Same Whisper lineage.",
        keys_at: "https://console.groq.com/keys",
        endpoint: "https://api.groq.com/openai/v1/audio/transcriptions",
        wire: Wire::OpenAi,
    },
    Engine {
        id: "groq-whisper-large-v3",
        provider: "Groq",
        model: "whisper-large-v3",
        note: "Slower than the turbo model above and more accurate with accents and names.",
        keys_at: "https://console.groq.com/keys",
        endpoint: "https://api.groq.com/openai/v1/audio/transcriptions",
        wire: Wire::OpenAi,
    },
    Engine {
        id: "deepgram-nova-2",
        provider: "Deepgram",
        model: "nova-2",
        note: "Fast, punctuates well, and returns each word already punctuated.",
        keys_at: "https://console.deepgram.com",
        endpoint: "https://api.deepgram.com/v1/listen",
        wire: Wire::Deepgram,
    },
    Engine {
        id: "elevenlabs-scribe-v1",
        provider: "ElevenLabs",
        model: "scribe_v1",
        note: "Strong on overlapping speakers and noisy rooms.",
        keys_at: "https://elevenlabs.io/app/settings/api-keys",
        endpoint: "https://api.elevenlabs.io/v1/speech-to-text",
        wire: Wire::ElevenLabs,
    },
];

fn engine(id: &str) -> Option<&'static Engine> {
    ENGINES.iter().find(|e| e.id == id)
}

/// What the editor is told about an engine. Never the key itself: what
/// comes back here can end up in a screenshot or a log, and a key that
/// only ever travels one way cannot.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineInfo {
    pub id: String,
    pub provider: String,
    pub model: String,
    pub note: String,
    pub keys_at: String,
    pub has_key: bool,
    pub is_default: bool,
}

/* ------------------------------------------------------- what is asked */

/// One clip to listen to, and where it sits on the timeline.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CaptionJob {
    /// The clip these captions came from, carried back out so the editor
    /// can say which clip each one belongs to.
    pub clip_id: String,
    pub path: String,
    /// Where the clip begins on the timeline.
    pub start: f64,
    /// How long it runs there.
    pub duration: f64,
    /// How far into its own file it begins.
    pub trim_start: f64,
    /// How fast it plays there. A clip at double speed covers two seconds
    /// of its file for every second of timeline, so what was said at 0:10
    /// in the file is heard at 0:05 on the timeline.
    pub speed: f64,
}

/// What the editor asks for.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CaptionRequest {
    pub jobs: Vec<CaptionJob>,
    /// An ISO language code, or empty to let the service work it out.
    #[serde(default)]
    pub language: String,
    /// The most words one caption may hold.
    pub words_per_caption: usize,
    /// Which engine to use. Empty means the one marked as default.
    #[serde(default)]
    pub engine: String,
}

/// One caption: some words, and the stretch of timeline they belong to.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Caption {
    pub clip_id: String,
    pub start: f64,
    pub duration: f64,
    pub text: String,
}

/// Where the work has got to. Sent as it goes, because transcribing an
/// hour of speech is not a thing to do behind a still screen.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct CaptionProgress {
    /// "listening" while a clip is being sent, "done" at the end.
    stage: &'static str,
    /// Which clip, of how many.
    done: usize,
    total: usize,
    /// Whose service is being used, so the editor can say so.
    engine: String,
}

/// One word, as the service timed it.
#[derive(Debug, Clone)]
pub struct Word {
    pub word: String,
    pub start: f64,
    pub end: f64,
}

/* ------------------------------------------------------------ grouping */

/// A caption ends here whatever else is true: a silence this long is a
/// held breath, and the words either side of it do not belong together.
const PAUSE: f64 = 0.55;
/// No caption stays up longer than this, however few words it holds.
const LONGEST: f64 = 2.8;
/// Nor holds more letters than this, however few words that is — three
/// long words fill a portrait frame as thoroughly as six short ones.
const WIDEST: usize = 32;
/// A caption of one word flashing past is unreadable; this is the least
/// time one is left up, where the next caption is not already due.
const SHORTEST: f64 = 0.4;

/// Groups timed words into short captions, each with its place on the
/// timeline.
///
/// The rules are about reading rather than about grammar: enough words to
/// be worth a glance, few enough to take in at one, and a break wherever
/// the speaker themselves left one.
pub fn into_captions(words: &[Word], job: &CaptionJob, per: usize) -> Vec<Caption> {
    let per = per.max(1);
    let speed = if job.speed > 0.0 { job.speed } else { 1.0 };
    // The audio was cut at the clip's in-point, so a word's time is
    // measured from there; on the timeline it is divided by the speed and
    // laid after the clip's own start.
    let onto = |at: f64| job.start + at / speed;
    let ends = job.start + job.duration;

    let mut out: Vec<Caption> = Vec::new();
    let mut held: Vec<&Word> = Vec::new();

    let flush = |held: &mut Vec<&Word>, out: &mut Vec<Caption>| {
        if held.is_empty() {
            return;
        }
        let text = held
            .iter()
            .map(|w| w.word.trim())
            .filter(|w| !w.is_empty())
            .collect::<Vec<_>>()
            .join(" ");
        let from = onto(held[0].start).max(job.start);
        let to = onto(held[held.len() - 1].end).min(ends);
        held.clear();
        if text.is_empty() || to <= from {
            return;
        }
        out.push(Caption {
            clip_id: job.clip_id.clone(),
            start: from,
            duration: to - from,
            text,
        });
    };

    for word in words {
        // Anything timed past the end of the clip was never heard on the
        // timeline: the edit cut away there.
        if onto(word.start) >= ends {
            break;
        }
        if let Some(last) = held.last() {
            let full = held.len() >= per;
            let rested = word.start - last.end >= PAUSE;
            let long = word.end - held[0].start > LONGEST;
            let wide = held
                .iter()
                .map(|w| w.word.trim().chars().count() + 1)
                .sum::<usize>()
                + word.word.trim().chars().count()
                > WIDEST;
            // A full stop is a place the speaker meant to break.
            let stopped = last
                .word
                .trim_end()
                .ends_with(['.', '?', '!', '。', '？', '！']);
            if full || rested || long || wide || stopped {
                flush(&mut held, &mut out);
            }
        }
        held.push(word);
    }
    flush(&mut held, &mut out);

    // A one-word caption can be over almost before it is up. Where the
    // next one is not yet due, leave it a moment longer.
    for i in 0..out.len() {
        let room = if i + 1 < out.len() {
            out[i + 1].start
        } else {
            ends
        };
        if out[i].duration < SHORTEST {
            let wanted = (out[i].start + SHORTEST).min(room);
            out[i].duration = (wanted - out[i].start).max(0.0);
        }
    }
    out.retain(|c| c.duration > 0.0 && !c.text.is_empty());
    out
}

/* --------------------------------------------------------------- sound */

/// Pulls a clip's speech out into a file small enough to send.
///
/// Mono, 16 kHz, 32 kbit — speech recognition asks for nothing better, and
/// the difference matters: an hour of sound comes to about a seventh of the
/// 25 MB these services accept, where the original video would not fit at
/// all. `-ss` before `-i` so a clip an hour into a recording is not read
/// from the beginning to get there.
fn speech_audio(
    directory: &Path,
    job: &CaptionJob,
    part: usize,
    from: f64,
    seconds: f64,
) -> Result<PathBuf, String> {
    let out = directory.join(format!("speech-{part}.mp3"));
    let _ = std::fs::remove_file(&out);
    let run = crate::sidecar::command("ffmpeg")
        .args([
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-ss",
            &format!("{from:.4}"),
            "-t",
            &format!("{seconds:.4}"),
            "-i",
            &job.path,
            "-vn",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-c:a",
            "libmp3lame",
            "-b:a",
            "32k",
            &out.to_string_lossy(),
        ])
        .output()
        .map_err(|e| format!("ffmpeg could not be run: {e}"))?;

    if !run.status.success() {
        let said = String::from_utf8_lossy(&run.stderr);
        let line = said.lines().last().unwrap_or("").trim();
        return Err(if line.is_empty() {
            "The sound could not be read out of that clip.".to_string()
        } else {
            format!("The sound could not be read out of that clip: {line}")
        });
    }
    if !out.is_file() {
        return Err("The sound could not be read out of that clip.".to_string());
    }
    Ok(out)
}

/// How much of a clip goes in one request.
///
/// At 32 kbit a minute of sound is a quarter of a megabyte, so this is
/// about 11 MB — comfortably inside the 25 MB these services accept, with
/// room for a clip denser than expected.
const PART_SECONDS: f64 = 2_700.0;

/// The words of one clip, as the chosen service heard them.
fn listen(
    directory: &Path,
    job: &CaptionJob,
    language: &str,
    engine: &Engine,
    key: &str,
) -> Result<Vec<Word>, String> {
    // The clip covers this much of its own file: at double speed, two
    // seconds of sound for every second on the timeline.
    let span = (job.duration * if job.speed > 0.0 { job.speed } else { 1.0 }).max(0.0);
    if span <= 0.0 {
        return Ok(Vec::new());
    }

    let mut words: Vec<Word> = Vec::new();
    let mut part = 0usize;
    let mut done = 0.0f64;
    while done < span {
        let take = (span - done).min(PART_SECONDS);
        let file = speech_audio(directory, job, part, job.trim_start + done, take)?;
        let heard = transcribe(engine, &file, language, key)?;
        // Each part was cut from further into the file, so its own clock
        // starts at zero; put it back on the clip's.
        words.extend(heard.into_iter().map(|w| Word {
            word: w.word,
            start: w.start + done,
            end: w.end + done,
        }));
        let _ = std::fs::remove_file(&file);
        done += take;
        part += 1;
    }
    Ok(words)
}

/* ----------------------------------------------------------- the wires */

/// OpenAI's shape, and Groq's, which copies it.
#[derive(Debug, serde::Deserialize)]
struct OpenAiHeard {
    #[serde(default)]
    words: Vec<OpenAiWord>,
}

#[derive(Debug, serde::Deserialize)]
struct OpenAiWord {
    word: String,
    start: f64,
    end: f64,
}

/// Deepgram's shape: the words are several layers down, and each one comes
/// with a punctuated spelling worth preferring.
#[derive(Debug, serde::Deserialize)]
struct DeepgramHeard {
    results: DeepgramResults,
}

#[derive(Debug, serde::Deserialize)]
struct DeepgramResults {
    #[serde(default)]
    channels: Vec<DeepgramChannel>,
}

#[derive(Debug, serde::Deserialize)]
struct DeepgramChannel {
    #[serde(default)]
    alternatives: Vec<DeepgramAlternative>,
}

#[derive(Debug, serde::Deserialize)]
struct DeepgramAlternative {
    #[serde(default)]
    words: Vec<DeepgramWord>,
}

#[derive(Debug, serde::Deserialize)]
struct DeepgramWord {
    word: String,
    #[serde(default)]
    punctuated_word: Option<String>,
    start: f64,
    end: f64,
}

/// ElevenLabs' shape, which also returns the spaces between words as
/// entries of their own.
#[derive(Debug, serde::Deserialize)]
struct ElevenHeard {
    #[serde(default)]
    words: Vec<ElevenWord>,
}

#[derive(Debug, serde::Deserialize)]
struct ElevenWord {
    text: String,
    #[serde(default)]
    start: Option<f64>,
    #[serde(default)]
    end: Option<f64>,
    /// "word", "spacing" or "audio_event".
    #[serde(rename = "type", default)]
    kind: Option<String>,
}

/// What comes back when it goes wrong. The message is the service's own
/// and is worth passing on: "incorrect api key" and "out of credit" are
/// things only the person holding the key can put right.
#[derive(Debug, serde::Deserialize)]
struct Refused {
    error: RefusedError,
}

#[derive(Debug, serde::Deserialize)]
struct RefusedError {
    message: String,
}

/// Reads whatever the service said about the failure, whichever of the
/// several shapes it used to say it.
fn complaint(body: &str) -> String {
    if let Ok(refused) = serde_json::from_str::<Refused>(body) {
        return refused.error.message;
    }
    // Deepgram answers with a flat object; ElevenLabs with `detail`.
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(body) {
        for key in ["err_msg", "message", "detail", "error"] {
            match value.get(key) {
                Some(serde_json::Value::String(said)) => return said.clone(),
                Some(nested) => {
                    if let Some(said) = nested.get("message").and_then(|m| m.as_str()) {
                        return said.to_string();
                    }
                }
                None => {}
            }
        }
    }
    body.chars().take(300).collect()
}

/// Sends one file and reads the words back.
///
/// The key is read from the file the editor put it in, is used here, and
/// goes nowhere else: it is not logged, not returned, and not written into
/// any project.
fn transcribe(
    engine: &Engine,
    file: &Path,
    language: &str,
    key: &str,
) -> Result<Vec<Word>, String> {
    let mut bytes = Vec::new();
    std::fs::File::open(file)
        .and_then(|mut f| f.read_to_end(&mut bytes))
        .map_err(|e| format!("The sound file could not be read back: {e}"))?;

    let client = reqwest::blocking::Client::builder()
        // Long enough for three quarters of an hour of sound to be worked
        // through, short enough that a dead connection does not hang the
        // editor for ever.
        .timeout(std::time::Duration::from_secs(20 * 60))
        .build()
        .map_err(|e| e.to_string())?;

    let language = language.trim();
    let request = match engine.wire {
        Wire::OpenAi => {
            let part = reqwest::blocking::multipart::Part::bytes(bytes)
                .file_name("speech.mp3")
                .mime_str("audio/mpeg")
                .map_err(|e| e.to_string())?;
            let mut form = reqwest::blocking::multipart::Form::new()
                .text("model", engine.model)
                .text("response_format", "verbose_json")
                .text("timestamp_granularities[]", "word")
                .part("file", part);
            if !language.is_empty() {
                form = form.text("language", language.to_string());
            }
            client
                .post(engine.endpoint)
                .bearer_auth(key)
                .multipart(form)
        }
        Wire::Deepgram => {
            // The audio is the body; everything else is asked for in the
            // query. `punctuate` earns its place: a full stop is where a
            // caption should break.
            let mut url = format!(
                "{}?model={}&punctuate=true&smart_format=true",
                engine.endpoint, engine.model
            );
            if language.is_empty() {
                url.push_str("&detect_language=true");
            } else {
                url.push_str(&format!("&language={language}"));
            }
            client
                .post(url)
                .header("Authorization", format!("Token {key}"))
                .header("Content-Type", "audio/mpeg")
                .body(bytes)
        }
        Wire::ElevenLabs => {
            let part = reqwest::blocking::multipart::Part::bytes(bytes)
                .file_name("speech.mp3")
                .mime_str("audio/mpeg")
                .map_err(|e| e.to_string())?;
            let mut form = reqwest::blocking::multipart::Form::new()
                .text("model_id", engine.model)
                .part("file", part);
            if !language.is_empty() {
                form = form.text("language_code", language.to_string());
            }
            client
                .post(engine.endpoint)
                .header("xi-api-key", key)
                .multipart(form)
        }
    };

    let reply = request.send().map_err(|e| {
        if e.is_timeout() {
            format!("{} did not answer in time.", engine.provider)
        } else if e.is_connect() {
            format!(
                "Could not reach {} — check the internet connection.",
                engine.provider
            )
        } else {
            format!("{} could not be reached: {e}", engine.provider)
        }
    })?;

    let status = reply.status();
    let body = reply
        .text()
        .map_err(|e| format!("The answer could not be read: {e}"))?;

    if !status.is_success() {
        let said = complaint(&body);
        return Err(match status.as_u16() {
            401 | 403 => format!("{} refused the key: {said}", engine.provider),
            429 => format!(
                "{} is rate-limiting, or the account is out of credit: {said}",
                engine.provider
            ),
            413 => format!("That piece of sound was too large to send: {said}"),
            _ => format!("{} refused it ({status}): {said}", engine.provider),
        });
    }

    let words = read_words(engine.wire, &body).map_err(|e| {
        format!(
            "{} answered with something this end could not read: {e}",
            engine.provider
        )
    })?;

    if words.is_empty() {
        // Not an error in itself — a silent clip is a silent clip — but
        // worth telling apart from a service that returned prose with no
        // timings at all, which would leave captions with nowhere to go.
        return Ok(Vec::new());
    }
    Ok(words)
}

/// Turns whichever shape came back into plain timed words.
fn read_words(wire: Wire, body: &str) -> Result<Vec<Word>, serde_json::Error> {
    Ok(match wire {
        Wire::OpenAi => serde_json::from_str::<OpenAiHeard>(body)?
            .words
            .into_iter()
            .map(|w| Word {
                word: w.word,
                start: w.start,
                end: w.end,
            })
            .collect(),
        Wire::Deepgram => serde_json::from_str::<DeepgramHeard>(body)?
            .results
            .channels
            .into_iter()
            .flat_map(|c| c.alternatives.into_iter())
            .flat_map(|a| a.words.into_iter())
            .map(|w| Word {
                // The punctuated spelling where there is one: the grouping
                // rules read full stops, and the plain spelling has none.
                word: w.punctuated_word.unwrap_or(w.word),
                start: w.start,
                end: w.end,
            })
            .collect(),
        Wire::ElevenLabs => serde_json::from_str::<ElevenHeard>(body)?
            .words
            .into_iter()
            .filter(|w| w.kind.as_deref().unwrap_or("word") == "word")
            .filter_map(|w| match (w.start, w.end) {
                (Some(start), Some(end)) => Some(Word {
                    word: w.text,
                    start,
                    end,
                }),
                _ => None,
            })
            .collect(),
    })
}

/* ----------------------------------------------------------- the keys */

/// What the editor has been given: a key per engine, and which one to use.
///
/// Kept in the app's own config folder rather than in the project. A
/// project file is a thing people send each other; a key is not, and the
/// two must not be able to travel together.
#[derive(Debug, Default, serde::Serialize, serde::Deserialize)]
struct Keyring {
    /// The engine marked for use. Empty until one is chosen.
    #[serde(default)]
    default: String,
    /// Engine id to key.
    #[serde(default)]
    keys: BTreeMap<String, String>,
}

fn keyring_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("speech.json"))
}

fn read_keyring(app: &tauri::AppHandle) -> Keyring {
    keyring_file(app)
        .ok()
        .and_then(|f| std::fs::read_to_string(f).ok())
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn write_keyring(app: &tauri::AppHandle, ring: &Keyring) -> Result<(), String> {
    let file = keyring_file(app)?;
    let text = serde_json::to_string_pretty(ring).map_err(|e| e.to_string())?;
    // Written beside itself and moved into place, so an interrupted write
    // cannot leave the keys half-there.
    let part = file.with_extension("json.part");
    std::fs::write(&part, text).map_err(|e| e.to_string())?;
    std::fs::rename(&part, &file).map_err(|e| e.to_string())
}

/// Puts a key in for one engine, or takes it away when given nothing.
///
/// Setting the first key also marks that engine for use: someone who has
/// entered exactly one key has said which one they mean.
pub fn save_key(app: &tauri::AppHandle, id: &str, key: &str) -> Result<(), String> {
    if engine(id).is_none() {
        return Err(format!("There is no transcription service called {id}."));
    }
    let mut ring = read_keyring(app);
    let key = key.trim();
    if key.is_empty() {
        ring.keys.remove(id);
        if ring.default == id {
            ring.default = ring.keys.keys().next().cloned().unwrap_or_default();
        }
    } else {
        ring.keys.insert(id.to_string(), key.to_string());
        if ring.default.is_empty() {
            ring.default = id.to_string();
        }
    }
    write_keyring(app, &ring)
}

/// Marks one engine as the one to use.
pub fn choose(app: &tauri::AppHandle, id: &str) -> Result<(), String> {
    if engine(id).is_none() {
        return Err(format!("There is no transcription service called {id}."));
    }
    let mut ring = read_keyring(app);
    ring.default = id.to_string();
    write_keyring(app, &ring)
}

/// The list the editor shows: every engine, whether it has a key, and
/// which one is marked. Never a key.
pub fn engines(app: &tauri::AppHandle) -> Vec<EngineInfo> {
    let ring = read_keyring(app);
    ENGINES
        .iter()
        .map(|e| EngineInfo {
            id: e.id.to_string(),
            provider: e.provider.to_string(),
            model: e.model.to_string(),
            note: e.note.to_string(),
            keys_at: e.keys_at.to_string(),
            has_key: ring.keys.get(e.id).map(|k| !k.is_empty()).unwrap_or(false),
            is_default: ring.default == e.id,
        })
        .collect()
}

/// The engine to use and its key, or a plain account of what is missing.
fn chosen(app: &tauri::AppHandle, asked: &str) -> Result<(&'static Engine, String), String> {
    let ring = read_keyring(app);
    let id = if asked.trim().is_empty() {
        ring.default.clone()
    } else {
        asked.trim().to_string()
    };
    if id.is_empty() {
        return Err(
            "No transcription service has been set up yet — add a key under Captions.".to_string(),
        );
    }
    let engine = engine(&id).ok_or_else(|| format!("There is no transcription service called {id}."))?;
    let key = ring
        .keys
        .get(&id)
        .map(|k| k.trim().to_string())
        .filter(|k| !k.is_empty())
        .ok_or_else(|| {
            format!(
                "{} · {} has no key yet — add one under Captions.",
                engine.provider, engine.model
            )
        })?;
    Ok((engine, key))
}

/* ------------------------------------------------------------ the work */

/// Listens to every clip asked about and answers with captions.
pub fn run(app: &tauri::AppHandle, request: CaptionRequest) -> Result<Vec<Caption>, String> {
    if request.jobs.is_empty() {
        return Err("There is nothing on the timeline to listen to.".to_string());
    }
    let (engine, key) = chosen(app, &request.engine)?;

    let directory = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("speech");
    std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;

    let told = format!("{} · {}", engine.provider, engine.model);
    let total = request.jobs.len();
    let mut captions: Vec<Caption> = Vec::new();
    for (index, job) in request.jobs.iter().enumerate() {
        let _ = app.emit(
            "caption-progress",
            CaptionProgress {
                stage: "listening",
                done: index,
                total,
                engine: told.clone(),
            },
        );
        let words = listen(&directory, job, &request.language, engine, &key)?;
        captions.extend(into_captions(&words, job, request.words_per_caption));
    }
    let _ = app.emit(
        "caption-progress",
        CaptionProgress {
            stage: "done",
            done: total,
            total,
            engine: told,
        },
    );

    captions.sort_by(|a, b| {
        a.start
            .partial_cmp(&b.start)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    if captions.is_empty() {
        return Err(
            "Nothing was said in those clips, or the speech was too quiet to make out.".to_string(),
        );
    }
    Ok(captions)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn job() -> CaptionJob {
        CaptionJob {
            clip_id: "c1".to_string(),
            path: "C:/take.mp4".to_string(),
            start: 0.0,
            duration: 60.0,
            trim_start: 0.0,
            speed: 1.0,
        }
    }

    fn words(pairs: &[(&str, f64, f64)]) -> Vec<Word> {
        pairs
            .iter()
            .map(|(w, s, e)| Word {
                word: w.to_string(),
                start: *s,
                end: *e,
            })
            .collect()
    }

    #[test]
    fn words_are_grouped_into_captions_of_a_few() {
        let heard = words(&[
            ("Ini", 0.0, 0.3),
            ("adalah", 0.3, 0.6),
            ("contoh", 0.6, 0.9),
            ("caption", 0.9, 1.2),
            ("yang", 1.2, 1.5),
            ("pendek", 1.5, 1.8),
        ]);
        let out = into_captions(&heard, &job(), 3);
        assert_eq!(out.len(), 2, "{out:?}");
        assert_eq!(out[0].text, "Ini adalah contoh");
        assert_eq!(out[1].text, "caption yang pendek");
        assert!((out[0].start - 0.0).abs() < 0.001);
        assert!((out[0].duration - 0.9).abs() < 0.001);
        assert!((out[1].start - 0.9).abs() < 0.001);
    }

    #[test]
    fn a_pause_breaks_a_caption_even_when_it_is_not_full() {
        // "satu", then a second of silence: the next word belongs to what
        // comes after, not to what came before.
        let heard = words(&[("satu", 0.0, 0.4), ("dua", 1.6, 2.0), ("tiga", 2.0, 2.4)]);
        let out = into_captions(&heard, &job(), 5);
        assert_eq!(out.len(), 2, "{out:?}");
        assert_eq!(out[0].text, "satu");
        assert_eq!(out[1].text, "dua tiga");
    }

    #[test]
    fn a_single_word_is_left_up_long_enough_to_read() {
        let heard = words(&[("ya", 0.0, 0.1), ("kemudian", 3.0, 3.4)]);
        let out = into_captions(&heard, &job(), 4);
        assert_eq!(out.len(), 2);
        assert!(
            out[0].duration >= SHORTEST - 0.001,
            "a flash of one word cannot be read: {:?}",
            out[0]
        );
    }

    #[test]
    fn a_long_run_of_words_is_broken_before_it_becomes_a_paragraph() {
        // Four long words said quickly, with no pause anywhere: the width
        // rule has to break them even though nothing else does.
        let heard = words(&[
            ("menyampaikan", 0.0, 0.3),
            ("pertimbangan", 0.3, 0.6),
            ("keseluruhan", 0.6, 0.9),
            ("perencanaan", 0.9, 1.2),
        ]);
        let out = into_captions(&heard, &job(), 8);
        assert!(out.len() >= 2, "{out:?}");
        for caption in &out {
            assert!(
                caption.text.chars().count() <= WIDEST + 12,
                "caption too wide to read: {caption:?}"
            );
        }
    }

    #[test]
    fn the_times_land_where_the_clip_sits_on_the_timeline() {
        // A clip that starts at 0:10 on the timeline, begins 30 seconds
        // into its file, and plays at double speed. A word timed 4 seconds
        // into the sound that was sent is heard two seconds after the clip
        // begins — at 0:12.
        let mut j = job();
        j.start = 10.0;
        j.trim_start = 30.0;
        j.speed = 2.0;
        j.duration = 20.0;
        let out = into_captions(&words(&[("halo", 4.0, 4.4)]), &j, 3);
        assert_eq!(out.len(), 1);
        assert!((out[0].start - 12.0).abs() < 0.001, "{:?}", out[0]);
    }

    #[test]
    fn what_was_said_past_the_end_of_the_clip_is_left_out() {
        // The clip runs for two seconds; the speaker carried on, but the
        // edit cut away.
        let mut j = job();
        j.duration = 2.0;
        let out = into_captions(
            &words(&[("di", 0.0, 0.3), ("dalam", 0.3, 0.6), ("lewat", 5.0, 5.4)]),
            &j,
            2,
        );
        assert_eq!(out.len(), 1, "{out:?}");
        assert_eq!(out[0].text, "di dalam");
    }

    /// Each service's own shape, copied from its documented reply rather
    /// than written from memory of it.
    ///
    /// The export bug this project has already had — a field named one way
    /// on one side of the wire and another way on the other, which every
    /// test missed because none of them crossed the wire — is the reason
    /// these exist at all.
    #[test]
    fn the_openai_reply_is_read_as_openai_sends_it() {
        let body = r#"{
          "task": "transcribe",
          "language": "indonesian",
          "duration": 2.5,
          "text": "Ini adalah contoh",
          "words": [
            { "word": "Ini", "start": 0.0, "end": 0.32 },
            { "word": "adalah", "start": 0.32, "end": 0.78 },
            { "word": "contoh", "start": 0.78, "end": 1.24 }
          ]
        }"#;
        let heard = read_words(Wire::OpenAi, body).expect("OpenAI's own shape");
        assert_eq!(heard.len(), 3);
        assert_eq!(heard[0].word, "Ini");
        assert!((heard[2].end - 1.24).abs() < 0.001);
    }

    #[test]
    fn the_deepgram_reply_is_read_with_its_punctuation_kept() {
        let body = r#"{
          "metadata": { "channels": 1 },
          "results": {
            "channels": [
              {
                "alternatives": [
                  {
                    "transcript": "Halo, selamat pagi.",
                    "confidence": 0.99,
                    "words": [
                      { "word": "halo", "start": 0.08, "end": 0.42, "confidence": 0.99, "punctuated_word": "Halo," },
                      { "word": "selamat", "start": 0.5, "end": 0.9, "confidence": 0.98, "punctuated_word": "selamat" },
                      { "word": "pagi", "start": 0.9, "end": 1.3, "confidence": 0.98, "punctuated_word": "pagi." }
                    ]
                  }
                ]
              }
            ]
          }
        }"#;
        let heard = read_words(Wire::Deepgram, body).expect("Deepgram's own shape");
        assert_eq!(heard.len(), 3);
        // The punctuated spelling, because a full stop is where a caption
        // should break and the plain spelling has none.
        assert_eq!(heard[0].word, "Halo,");
        assert_eq!(heard[2].word, "pagi.");
    }

    #[test]
    fn the_elevenlabs_reply_is_read_without_its_spacing_entries() {
        let body = r#"{
          "language_code": "ind",
          "language_probability": 0.98,
          "text": "Halo semua",
          "words": [
            { "text": "Halo", "start": 0.0, "end": 0.4, "type": "word" },
            { "text": " ", "start": 0.4, "end": 0.42, "type": "spacing" },
            { "text": "semua", "start": 0.42, "end": 0.9, "type": "word" }
          ]
        }"#;
        let heard = read_words(Wire::ElevenLabs, body).expect("ElevenLabs' own shape");
        assert_eq!(heard.len(), 2, "the spaces are not words: {heard:?}");
        assert_eq!(heard[0].word, "Halo");
        assert_eq!(heard[1].word, "semua");
    }

    #[test]
    fn a_refusal_is_read_for_what_it_says() {
        for body in [
            r#"{"error":{"message":"Incorrect API key provided: sk-xxx","code":"invalid_api_key"}}"#,
            r#"{"err_code":"INVALID_AUTH","err_msg":"Invalid credentials."}"#,
            r#"{"detail":{"status":"invalid_api_key","message":"Invalid API key."}}"#,
        ] {
            let said = complaint(body);
            assert!(
                said.to_lowercase().contains("invalid") || said.to_lowercase().contains("incorrect"),
                "the service's own words should come through: {said}"
            );
        }
    }

    #[test]
    fn every_engine_is_named_once_and_points_somewhere() {
        let mut seen = std::collections::BTreeSet::new();
        for e in ENGINES {
            assert!(seen.insert(e.id), "two engines called {}", e.id);
            assert!(e.endpoint.starts_with("https://"), "{} is not on https", e.id);
            assert!(e.keys_at.starts_with("https://"), "{} has nowhere to get a key", e.id);
            assert!(!e.note.is_empty(), "{} says nothing about itself", e.id);
        }
    }

    #[test]
    fn the_sound_that_is_sent_is_small_and_plain() {
        // A real extraction, because the whole point of these arguments is
        // what comes out of them: an hour of speech has to fit inside the
        // 25 MB these services accept, and it only does at one channel and
        // 16 kHz.
        let source = std::env::temp_dir().join("jd-caption-source.mp4");
        let made = crate::sidecar::command("ffmpeg")
            .args([
                "-y",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=220:duration=30",
                "-f",
                "lavfi",
                "-i",
                "color=c=black:s=320x180:r=15:d=30",
                "-shortest",
                "-pix_fmt",
                "yuv420p",
                &source.to_string_lossy(),
            ])
            .output();
        match made {
            Ok(out) if out.status.success() => {}
            _ => {
                eprintln!("no ffmpeg to make a test source with; skipping");
                return;
            }
        }

        let directory = std::env::temp_dir();
        let mut j = job();
        j.path = source.to_string_lossy().to_string();
        j.duration = 30.0;
        let file = speech_audio(&directory, &j, 0, 0.0, 30.0).expect("extracted");
        let size = std::fs::metadata(&file).expect("a file").len();
        assert!(size > 0, "nothing came out");
        // 32 kbit is 4 kB a second: half a minute must not come to much
        // more than 150 kB, or the rate is not what was asked for.
        assert!(
            size < 200_000,
            "the sound came out far too large to send: {size} bytes"
        );

        let probe = crate::sidecar::command("ffprobe")
            .args([
                "-v",
                "error",
                "-select_streams",
                "a:0",
                "-show_entries",
                "stream=channels,sample_rate",
                "-of",
                "csv=p=0",
                &file.to_string_lossy(),
            ])
            .output()
            .expect("ffprobe ran");
        // ffprobe prints these in the stream's own field order rather
        // than the order they were asked for, so read them as a set.
        let said = String::from_utf8_lossy(&probe.stdout);
        let numbers: Vec<&str> = said.trim().split(',').map(|n| n.trim()).collect();
        assert!(
            numbers.contains(&"1") && numbers.contains(&"16000"),
            "one channel at 16 kHz was asked for, got {}",
            said.trim()
        );
        let _ = std::fs::remove_file(&file);
        let _ = std::fs::remove_file(&source);
    }
}
