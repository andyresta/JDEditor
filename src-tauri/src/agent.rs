//! Asking a model for an edit.
//!
//! The model is given the briefing `describe()` wrote, the question
//! somebody typed, and one tool: a way to propose a list of edits. It
//! never touches the project. What comes back is carried to the editor,
//! checked there against the rules in `ops.ts`, and shown to a person to
//! accept or refuse.
//!
//! **This module is deliberately not the authority on what an edit is.**
//! It hands the model's operations back as the JSON they arrived as,
//! without inspecting them. The editor already has one place that decides
//! whether an operation makes sense — `problemWith` — and a second
//! opinion written in Rust would be a second thing to keep in step, and
//! the one that disagreed would be the one nobody noticed. Rust's job
//! here is to carry the post.
//!
//! The key never appears in a reply, an error, or a log. What comes back
//! from the service can end up in a toast or a screenshot, and a key that
//! only ever travels one way cannot end up in either.

use crate::providers::{self, Role};

/// Where an OpenAI-shaped chat request goes. DeepSeek serves this format
/// at its own address, which is why no client library is needed.
const DEEPSEEK_CHAT: &str = "https://api.deepseek.com/chat/completions";

/// How long to wait. A thinking model reading a long transcript is not
/// quick, and cutting it off at the usual thirty seconds would fail the
/// requests most worth making.
const PATIENCE: std::time::Duration = std::time::Duration::from_secs(180);

/// What the model is told it is doing.
///
/// Short on manners and long on the two things it gets wrong without
/// being told: inventing ids, and doing more than was asked.
const BRIEF: &str = "\
You are an editing assistant inside a video editor. You are given a \
description of a project's timeline and a question about it.

Rules:
- Only ever name ids that appear in the description. Never invent one.
- All times are seconds on the timeline, as written in the description.
- Propose the smallest set of edits that answers the question. If one \
cut will do, propose one cut.
- If the question cannot be answered from the description, say so and \
propose nothing. Guessing is worse than asking.
- If you are unsure whether an edit is wanted, say what you would do and \
propose nothing.
- Answer in the language the question was asked in.";

/// One turn of the conversation, as the editor keeps it.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Turn {
    /// "user" or "assistant".
    pub role: String,
    pub content: String,
}

/// One frame the model asked to see, already pulled out of a file.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Frame {
    /// The image on disk, from `media::frame_at`.
    pub path: String,
    /// Where it sits on the timeline, so the model can tie what it sees
    /// to what the briefing says is there.
    pub at_seconds: f64,
}

/// What the editor asks.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentAsk {
    /// The project, as `describe()` wrote it.
    pub briefing: String,
    /// What was typed.
    pub question: String,
    /// What has been said so far, oldest first. Empty for a fresh start.
    #[serde(default)]
    pub history: Vec<Turn>,
    /// Whether the model may ask to see frames.
    ///
    /// False when no model has been marked as the eyes, and then the tool
    /// is not offered at all — so the answer is "I cannot see the
    /// picture" rather than a guess dressed as an observation.
    #[serde(default)]
    pub can_look: bool,
    /// Frames it asked for last time, fetched and handed back. Empty on a
    /// first ask.
    #[serde(default)]
    pub frames: Vec<Frame>,
}

/// What comes back.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentReply {
    /// What the model said in words. May be empty when it only proposed.
    pub text: String,
    /// The edits it proposed, exactly as they arrived. Checked by the
    /// editor, not here.
    pub operations: Vec<serde_json::Value>,
    /// Who answered, so the panel can say so.
    pub model: String,
    /// Moments on the timeline it wants to see before it can answer.
    ///
    /// When this comes back non-empty, nothing has been decided yet: the
    /// editor is expected to fetch these frames and ask again with them.
    pub looks: Vec<f64>,
}

/// The most frames one question may ask for.
///
/// A model told it may look will look at everything unless it is given a
/// number. Each frame is a picture somebody pays for, so it is asked to
/// choose.
const MOST_FRAMES: usize = 8;

/// The tools the model is given.
///
/// `propose_edits` carries a list rather than being called once per edit:
/// the editor applies a batch as a single step with a single entry in the
/// undo history, and a model making eight separate calls would be
/// describing something the editor cannot do.
///
/// `look_at` is only offered when something has been marked as the eyes.
/// Offering it without is worse than not offering it at all: the model
/// would ask for frames that never arrive.
fn tools(can_look: bool) -> serde_json::Value {
    let mut all = vec![serde_json::json!({
        "type": "function",
        "function": {
            "name": "propose_edits",
            "description":
                "Propose a list of edits to the timeline. They are shown to the \
                 person for approval and applied together as one step, or not at \
                 all. Do not call this unless an edit was actually asked for.",
            "parameters": {
                "type": "object",
                "properties": {
                    "operations": {
                        "type": "array",
                        "description": "The edits, in the order they should be applied.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "kind": {
                                    "type": "string",
                                    "enum": [
                                        "cut", "removeClips", "moveClip", "trim",
                                        "setSpeed", "setVolume", "addTitle",
                                        "setTransition", "removeRange",
                                        "addNote", "editNote", "moveNote", "removeNotes"
                                    ],
                                    "description":
                                        "cut: split every clip the moment crosses, or one named clip \
                                         (atSeconds, clipId?). removeClips: delete clips (clipIds). \
                                         moveClip: move one (clipId, trackId, startSeconds). \
                                         trim: drag one edge (clipId, edge start|end, seconds). \
                                         setSpeed: retime (clipIds, speed 0.25-4). \
                                         setVolume: replace a volume line (clipId, points [{at, gain}]). \
                                         addTitle: words over the picture (trackId or null for a new \
                                         track, atSeconds, text {content}, durationSeconds?). \
                                         setTransition: (clipIds, edge in|out, transition?). \
                                         removeRange: take a stretch out and close the gap \
                                         (fromSeconds, toSeconds) — this is how a pause or a sentence \
                                         is removed. addNote: leave a remark (atSeconds, text). \
                                         editNote/moveNote/removeNotes: (noteId/noteIds, text/atSeconds)."
                                }
                            },
                            "required": ["kind"],
                            // The editor is the authority on the rest of the
                            // shape; anything here would be a second opinion
                            // to keep in step.
                            "additionalProperties": true
                        }
                    },
                    "why": {
                        "type": "string",
                        "description": "One sentence on what these edits do and why."
                    }
                },
                "required": ["operations"]
            }
        }
    })];

    if can_look {
        all.push(serde_json::json!({
            "type": "function",
            "function": {
                "name": "look_at",
                "description": format!(
                    "Ask to see what is on screen at particular moments. Use this \
                     when the question is about the picture and the transcript does \
                     not answer it — for example when somebody says \"this\" or \
                     \"here\" without saying what it is. The frames come back and \
                     you are asked again. At most {MOST_FRAMES} moments, so choose \
                     the ones that matter. Do not use this when the transcript \
                     already answers the question."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "seconds": {
                            "type": "array",
                            "items": { "type": "number" },
                            "description": "Moments on the timeline, in seconds."
                        },
                        "why": {
                            "type": "string",
                            "description": "One sentence on what you are looking for."
                        }
                    },
                    "required": ["seconds"]
                }
            }
        }));
    }

    serde_json::Value::Array(all)
}

fn client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(PATIENCE)
        .build()
        .map_err(|e| e.to_string())
}

/* ------------------------------------------------------ what comes back */

#[derive(Debug, serde::Deserialize)]
struct ChatReply {
    #[serde(default)]
    choices: Vec<Choice>,
    #[serde(default)]
    error: Option<ApiError>,
}

#[derive(Debug, serde::Deserialize)]
struct ApiError {
    #[serde(default)]
    message: String,
}

#[derive(Debug, serde::Deserialize)]
struct Choice {
    #[serde(default)]
    message: Message,
}

#[derive(Debug, Default, serde::Deserialize)]
struct Message {
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    tool_calls: Vec<ToolCall>,
}

#[derive(Debug, serde::Deserialize)]
struct ToolCall {
    #[serde(default)]
    function: FunctionCall,
}

#[derive(Debug, Default, serde::Deserialize)]
struct FunctionCall {
    #[serde(default)]
    name: String,
    /// The arguments, which arrive as a string of JSON rather than as
    /// JSON — that is the wire format, not a mistake.
    #[serde(default)]
    arguments: String,
}

/// Pulls the proposed edits out of a reply.
///
/// A model that writes malformed JSON into the arguments has proposed
/// nothing, which is the safe reading: better an answer with no edits in
/// it than half an edit built from what could be parsed.
fn operations_in(message: &Message) -> Vec<serde_json::Value> {
    let mut out = Vec::new();
    for call in &message.tool_calls {
        if call.function.name != "propose_edits" {
            continue;
        }
        let Ok(args) = serde_json::from_str::<serde_json::Value>(&call.function.arguments) else {
            continue;
        };
        let Some(list) = args.get("operations").and_then(|v| v.as_array()) else {
            continue;
        };
        out.extend(list.iter().cloned());
    }
    out
}

/// The moments it asked to see, capped and tidied.
///
/// Sorted and de-duplicated because a model asking for the same second
/// twice should not be charged for it twice, and capped because the
/// number in the tool's description is a request, not a guarantee.
fn looks_in(message: &Message) -> Vec<f64> {
    let mut out: Vec<f64> = Vec::new();
    for call in &message.tool_calls {
        if call.function.name != "look_at" {
            continue;
        }
        let Ok(args) = serde_json::from_str::<serde_json::Value>(&call.function.arguments) else {
            continue;
        };
        let Some(list) = args.get("seconds").and_then(|v| v.as_array()) else {
            continue;
        };
        for at in list.iter().filter_map(|v| v.as_f64()) {
            if at.is_finite() && at >= 0.0 {
                out.push((at * 1000.0).round() / 1000.0);
            }
        }
    }
    out.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    out.dedup();
    out.truncate(MOST_FRAMES);
    out
}

/// What the model said, and the sentence it gave for its proposal.
fn text_in(message: &Message) -> String {
    let said = message.content.clone().unwrap_or_default();
    let why = message
        .tool_calls
        .iter()
        .filter(|c| c.function.name == "propose_edits" || c.function.name == "look_at")
        .filter_map(|c| serde_json::from_str::<serde_json::Value>(&c.function.arguments).ok())
        .find_map(|args| args.get("why").and_then(|v| v.as_str()).map(String::from))
        .unwrap_or_default();

    match (said.trim().is_empty(), why.trim().is_empty()) {
        (true, true) => String::new(),
        (true, false) => why,
        (false, true) => said,
        (false, false) => format!("{}\n\n{}", said.trim(), why.trim()),
    }
}

/* -------------------------------------------------------------- the work */

pub fn ask(app: &tauri::AppHandle, ask: AgentAsk) -> Result<AgentReply, String> {
    if ask.question.trim().is_empty() {
        return Err("There is nothing to ask.".to_string());
    }

    let model = providers::chosen(app, Role::Brain).ok_or_else(|| {
        "No brain has been chosen yet — pick one under AI providers.".to_string()
    })?;
    let all = providers::models(app);
    let chosen = all
        .iter()
        .find(|m| m.id == model)
        .ok_or_else(|| format!("There is no model called {model}."))?;
    let key = providers::key_for(app, &chosen.provider)?;

    let mut messages = vec![
        serde_json::json!({ "role": "system", "content": BRIEF }),
        serde_json::json!({
            "role": "system",
            "content": format!("The project as it stands:\n\n{}", ask.briefing),
        }),
    ];
    for turn in &ask.history {
        // Only the two roles a conversation is made of; anything else is
        // not something this editor wrote.
        if turn.role != "user" && turn.role != "assistant" {
            continue;
        }
        messages.push(serde_json::json!({ "role": turn.role, "content": turn.content }));
    }
    // The question, and any frames it asked for last time.
    //
    // A message with pictures in it is a list of parts rather than a
    // string: that is the wire format, and it is also why the frames go
    // with the question rather than in a message of their own — the
    // model is being asked again, not told something new.
    if ask.frames.is_empty() {
        messages.push(serde_json::json!({ "role": "user", "content": ask.question }));
    } else {
        let mut parts = vec![serde_json::json!({
            "type": "text",
            "text": format!(
                "Here are the frames you asked for, in order. The question was: {}",
                ask.question
            ),
        })];
        for frame in &ask.frames {
            let bytes = std::fs::read(&frame.path)
                .map_err(|e| format!("Could not read the frame at {:.2}s: {e}", frame.at_seconds))?;
            parts.push(serde_json::json!({
                "type": "text",
                "text": format!("At {:.2}s:", frame.at_seconds),
            }));
            parts.push(serde_json::json!({
                "type": "image_url",
                "image_url": { "url": format!("data:image/jpeg;base64,{}", encode_base64(&bytes)) },
            }));
        }
        messages.push(serde_json::json!({ "role": "user", "content": parts }));
    }

    let body = serde_json::json!({
        "model": chosen.model,
        "messages": messages,
        "tools": tools(ask.can_look && ask.frames.is_empty()),
        "stream": false,
    });

    let reply = client()?
        .post(DEEPSEEK_CHAT)
        .bearer_auth(&key)
        .json(&body)
        .send()
        .map_err(|e| format!("Could not reach {}: {e}", chosen.provider_name))?;

    let status = reply.status();
    let text = reply
        .text()
        .map_err(|e| format!("Could not read the answer: {e}"))?;

    let parsed: ChatReply = serde_json::from_str(&text).map_err(|e| {
        // The body is not echoed: it is whatever the service chose to send
        // and has no business in a toast.
        format!("{} sent something this could not read ({e}).", chosen.provider_name)
    })?;

    if let Some(error) = parsed.error {
        let said = error.message.trim();
        return Err(if said.is_empty() {
            format!("{} refused the request ({status}).", chosen.provider_name)
        } else {
            format!("{}: {said}", chosen.provider_name)
        });
    }
    if !status.is_success() {
        return Err(format!("{} answered {status}.", chosen.provider_name));
    }

    let message = parsed
        .choices
        .into_iter()
        .next()
        .map(|c| c.message)
        .unwrap_or_default();

    Ok(AgentReply {
        operations: operations_in(&message),
        looks: looks_in(&message),
        text: text_in(&message),
        model: format!("{} · {}", chosen.provider_name, chosen.model),
    })
}

/// Base64, written out rather than pulled in.
///
/// One small function against one more dependency to audit in a project
/// somebody else will read: this is the whole of it, and it has a test.
fn encode_base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(ALPHABET[(n >> 18) as usize & 63] as char);
        out.push(ALPHABET[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            ALPHABET[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            ALPHABET[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(json: &str) -> Message {
        serde_json::from_str(json).expect("a message this test wrote")
    }

    /// The arguments arrive as a string of JSON inside the JSON, which is
    /// the part of this wire format most likely to be got wrong.
    #[test]
    fn proposed_edits_are_read_out_of_the_tool_call() {
        let m = message(
            r#"{
              "content": "Taking out the long pause.",
              "tool_calls": [{
                "function": {
                  "name": "propose_edits",
                  "arguments": "{\"operations\":[{\"kind\":\"removeRange\",\"fromSeconds\":2.15,\"toSeconds\":3.88}],\"why\":\"one pause\"}"
                }
              }]
            }"#,
        );
        let ops = operations_in(&m);
        assert_eq!(ops.len(), 1);
        assert_eq!(ops[0]["kind"], "removeRange");
        assert_eq!(ops[0]["fromSeconds"], 2.15);
        let said = text_in(&m);
        assert!(said.contains("Taking out the long pause"), "{said}");
        assert!(said.contains("one pause"), "{said}");
    }

    /// An answer with no edits in it is an ordinary answer, not a failure.
    #[test]
    fn an_answer_without_edits_is_still_an_answer() {
        let m = message(r#"{ "content": "There is no pause long enough to cut." }"#);
        assert!(operations_in(&m).is_empty());
        assert_eq!(text_in(&m), "There is no pause long enough to cut.");
    }

    /// Malformed arguments propose nothing. Half an edit built from what
    /// happened to parse is worse than none.
    #[test]
    fn malformed_arguments_propose_nothing() {
        let m = message(
            r#"{
              "content": "here you go",
              "tool_calls": [{ "function": { "name": "propose_edits", "arguments": "{oops" } }]
            }"#,
        );
        assert!(operations_in(&m).is_empty());
        assert_eq!(text_in(&m), "here you go");
    }

    /// A tool this editor never offered is ignored rather than obeyed.
    #[test]
    fn a_tool_we_did_not_offer_is_ignored() {
        let m = message(
            r#"{
              "tool_calls": [{
                "function": {
                  "name": "delete_everything",
                  "arguments": "{\"operations\":[{\"kind\":\"removeClips\",\"clipIds\":[\"a\"]}]}"
                }
              }]
            }"#,
        );
        assert!(operations_in(&m).is_empty());
    }

    /// The operations are carried through untouched: the editor is the
    /// one that decides whether they make sense, and anything trimmed or
    /// tidied here would be a second opinion to keep in step.
    #[test]
    fn operations_are_carried_through_as_they_arrived() {
        let m = message(
            r#"{
              "tool_calls": [{
                "function": {
                  "name": "propose_edits",
                  "arguments": "{\"operations\":[{\"kind\":\"setSpeed\",\"clipIds\":[\"a\"],\"speed\":99,\"nonsense\":true}]}"
                }
              }]
            }"#,
        );
        let ops = operations_in(&m);
        assert_eq!(ops.len(), 1);
        // Out of range, and kept anyway — refusing it is `problemWith`'s
        // job, and it can say why in words the panel can show.
        assert_eq!(ops[0]["speed"], 99);
        assert_eq!(ops[0]["nonsense"], true);
    }

    /// Several tool calls in one reply are all collected, in order.
    #[test]
    fn several_calls_are_gathered_in_order() {
        let m = message(
            r#"{
              "tool_calls": [
                { "function": { "name": "propose_edits", "arguments": "{\"operations\":[{\"kind\":\"cut\",\"atSeconds\":1}]}" } },
                { "function": { "name": "propose_edits", "arguments": "{\"operations\":[{\"kind\":\"cut\",\"atSeconds\":2}]}" } }
              ]
            }"#,
        );
        let ops = operations_in(&m);
        assert_eq!(ops.len(), 2);
        assert_eq!(ops[0]["atSeconds"], 1);
        assert_eq!(ops[1]["atSeconds"], 2);
    }

    /// The eyes are only offered when something has been marked as them.
    /// Offering the tool without is worse than not offering it: the model
    /// would ask for frames that never come.
    #[test]
    fn looking_is_only_offered_when_there_are_eyes() {
        assert!(tools(true).to_string().contains("look_at"));
        assert!(!tools(false).to_string().contains("look_at"));
        // And proposing edits is offered either way.
        assert!(tools(false).to_string().contains("propose_edits"));
    }

    #[test]
    fn the_moments_asked_for_are_read_out_of_the_call() {
        let m = message(
            r#"{
              "tool_calls": [{
                "function": {
                  "name": "look_at",
                  "arguments": "{\"seconds\":[12.5,4.25,12.5],\"why\":\"checking the screen\"}"
                }
              }]
            }"#,
        );
        // Sorted, and the repeat dropped: the same second twice is one
        // picture, not two to pay for.
        assert_eq!(looks_in(&m), vec![4.25, 12.5]);
        assert!(text_in(&m).contains("checking the screen"));
        // Asking to look is not proposing an edit.
        assert!(operations_in(&m).is_empty());
    }

    /// However many it asks for, it gets the cap.
    #[test]
    fn it_cannot_ask_for_more_frames_than_the_cap() {
        let many: Vec<String> = (0..40).map(|i| i.to_string()).collect();
        let args = format!("{{\"seconds\":[{}]}}", many.join(","));
        let m = message(&format!(
            r#"{{ "tool_calls": [{{ "function": {{ "name": "look_at", "arguments": {} }} }}] }}"#,
            serde_json::to_string(&args).unwrap()
        ));
        assert_eq!(looks_in(&m).len(), MOST_FRAMES);
    }

    /// A moment that is not a moment is dropped rather than fetched.
    #[test]
    fn nonsense_moments_are_dropped() {
        let m = message(
            r#"{
              "tool_calls": [{
                "function": {
                  "name": "look_at",
                  "arguments": "{\"seconds\":[-4, 3.5, null, \"soon\"]}"
                }
              }]
            }"#,
        );
        assert_eq!(looks_in(&m), vec![3.5]);
    }

    /// The base64 here is written out by hand rather than pulled in, so
    /// it is checked against the examples in the standard.
    #[test]
    fn base64_is_written_correctly() {
        assert_eq!(encode_base64(b""), "");
        assert_eq!(encode_base64(b"f"), "Zg==");
        assert_eq!(encode_base64(b"fo"), "Zm8=");
        assert_eq!(encode_base64(b"foo"), "Zm9v");
        assert_eq!(encode_base64(b"foob"), "Zm9vYg==");
        assert_eq!(encode_base64(b"fooba"), "Zm9vYmE=");
        assert_eq!(encode_base64(b"foobar"), "Zm9vYmFy");
        // Bytes that are not text, which is what a JPEG is.
        assert_eq!(encode_base64(&[0x00, 0xFF, 0x80]), "AP+A");
        assert_eq!(encode_base64(&[0xFF; 3]), "////");
    }

    /// Every operation the editor knows about is offered to the model.
    /// One missing from here is one it can never propose, however well it
    /// would have answered the question.
    #[test]
    fn every_operation_is_offered() {
        let schema = tools(true).to_string();
        for kind in [
            "cut",
            "removeClips",
            "moveClip",
            "trim",
            "setSpeed",
            "setVolume",
            "addTitle",
            "setTransition",
            "removeRange",
            "addNote",
            "editNote",
            "moveNote",
            "removeNotes",
        ] {
            assert!(schema.contains(kind), "{kind} is not offered to the model");
        }
    }
}
