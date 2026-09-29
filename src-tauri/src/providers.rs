//! Who does the seeing, the hearing and the thinking.
//!
//! Agentic editing needs three different things from a model, and no one
//! service is best at all three — nor, today, even capable of all three.
//! So each is chosen separately:
//!
//! - **Ears** turn speech into words with times against them. Only a
//!   transcription service can do this. DeepSeek, for instance, has no
//!   audio endpoint at all, so it never appears in this list.
//! - **Eyes** describe a frame. A vision model.
//! - **Brain** reads what the eyes and ears found, reads the timeline,
//!   and proposes edits. Needs tool calls and dependable JSON.
//!
//! Keys are held **per provider**, not per model. Someone using DeepSeek
//! for both eyes and brain enters one key, not two; and a key entered for
//! captions is the same key a thinking model would use.
//!
//! What is stored here is a bill. It lives in the app's own config
//! directory, never in a project file, and `models()` reports only
//! whether a key exists — never the key. A key that only ever travels one
//! way cannot come back out in a screenshot or a log.

use std::collections::BTreeMap;
use std::path::PathBuf;

use tauri::Manager;

/// What a model is being asked to be.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Role {
    /// Speech into timed words.
    Ears,
    /// A picture into a description.
    Eyes,
    /// Everything else into a list of edits.
    Brain,
}

impl Role {
    fn key(self) -> &'static str {
        match self {
            Role::Ears => "ears",
            Role::Eyes => "eyes",
            Role::Brain => "brain",
        }
    }
}

/// Somebody who issues a key and sends a bill.
pub struct Provider {
    pub id: &'static str,
    pub name: &'static str,
    /// Where its keys are issued, so the editor can point at it rather
    /// than leave someone searching.
    pub keys_at: &'static str,
}

pub const PROVIDERS: &[Provider] = &[
    Provider {
        id: "openai",
        name: "OpenAI",
        keys_at: "https://platform.openai.com/api-keys",
    },
    Provider {
        id: "groq",
        name: "Groq",
        keys_at: "https://console.groq.com/keys",
    },
    Provider {
        id: "deepgram",
        name: "Deepgram",
        keys_at: "https://console.deepgram.com",
    },
    Provider {
        id: "elevenlabs",
        name: "ElevenLabs",
        keys_at: "https://elevenlabs.io/app/settings/api-keys",
    },
    Provider {
        id: "deepseek",
        name: "DeepSeek",
        keys_at: "https://platform.deepseek.com/api_keys",
    },
];

pub fn provider(id: &str) -> Option<&'static Provider> {
    PROVIDERS.iter().find(|p| p.id == id)
}

/// The provider a transcription engine belongs to.
///
/// Spelled out rather than derived from the engine's display name: a
/// slug of "ElevenLabs" is a guess, and a guess that silently misses
/// would hide a key someone had already entered.
pub fn provider_id_of(display_name: &str) -> &'static str {
    match display_name {
        "OpenAI" => "openai",
        "Groq" => "groq",
        "Deepgram" => "deepgram",
        "ElevenLabs" => "elevenlabs",
        // Deliberately not the name itself: a provider nobody has an
        // entry for would otherwise have keys filed under a name the
        // settings cannot show, and the key would be invisible rather
        // than missing. `every_engine_belongs_to_a_known_provider` is the
        // test that keeps this arm unreachable.
        _ => "unknown",
    }
}

/// A model that can fill one or more of the three roles.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Model {
    pub id: String,
    pub provider: String,
    pub provider_name: String,
    /// The model as the service names it.
    pub model: String,
    /// What it is good for, in the words someone choosing would want.
    pub note: String,
    pub keys_at: String,
    pub roles: Vec<Role>,
    /// Whether this model's provider has a key stored.
    pub has_key: bool,
    /// The roles this model is currently marked for.
    pub chosen_for: Vec<Role>,
}

/// Models that read and write text rather than listen.
///
/// The transcription engines are not repeated here: they already have a
/// table of their own in `caption`, which holds the endpoint and wire
/// format each one needs, and a second copy would be a second thing to
/// keep right.
struct Thinker {
    id: &'static str,
    provider: &'static str,
    model: &'static str,
    note: &'static str,
    roles: &'static [Role],
}

const THINKERS: &[Thinker] = &[
    Thinker {
        id: "deepseek-flash",
        provider: "deepseek",
        model: "deepseek-flash",
        note: "Cheapest of these by a distance, reads pictures as well as text, and holds a million tokens of context.",
        roles: &[Role::Eyes, Role::Brain],
    },
    Thinker {
        id: "deepseek-v4-pro",
        provider: "deepseek",
        model: "deepseek-v4-pro",
        note: "Stronger reasoning than Flash for the price of it. Text only — it cannot look at a frame.",
        roles: &[Role::Brain],
    },
];

/* ------------------------------------------------------------- storage */

/// Keys, and which model is marked for each role.
///
/// Keys by provider and choices by model, deliberately: one key buys
/// every model a provider offers.
#[derive(Debug, Default, serde::Serialize, serde::Deserialize)]
struct Ring {
    /// Provider id to key.
    #[serde(default)]
    keys: BTreeMap<String, String>,
    /// Role name to model id.
    #[serde(default)]
    chosen: BTreeMap<String, String>,
}

fn ring_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("providers.json"))
}

/// The shape keys were kept in before there were three roles: one key per
/// *engine*, and a single default engine.
#[derive(Debug, Default, serde::Deserialize)]
struct OldKeyring {
    #[serde(default)]
    default: String,
    #[serde(default)]
    keys: BTreeMap<String, String>,
}

/// Brings keys forward from the old per-engine file.
///
/// Called only when there is no new file yet, so it cannot overwrite
/// anything someone has since entered. Keys that were stored against an
/// engine id — "openai-whisper-1" — become keys against that engine's
/// provider, which is what they always were: one OpenAI key, whichever
/// OpenAI model it is spent on.
fn ring_from_old(old: &OldKeyring) -> Option<Ring> {
    let mut ring = Ring::default();
    for (engine_id, key) in &old.keys {
        let Some(engine) = crate::caption::ENGINES.iter().find(|e| e.id == *engine_id) else {
            // A key filed against an engine this version no longer offers.
            // Nothing can spend it, so nothing is carried forward.
            continue;
        };
        if key.trim().is_empty() {
            continue;
        }
        ring.keys
            .insert(provider_id_of(engine.provider).to_string(), key.clone());
    }
    if ring.keys.is_empty() {
        return None;
    }
    // The engine that was marked becomes the ears, which is the only role
    // it could ever have filled.
    if !old.default.is_empty() && crate::caption::ENGINES.iter().any(|e| e.id == old.default) {
        ring.chosen
            .insert(Role::Ears.key().to_string(), old.default.clone());
    }
    Some(ring)
}

fn migrate(app: &tauri::AppHandle) -> Option<Ring> {
    let dir = app.path().app_config_dir().ok()?;
    let old_file = dir.join("speech.json");
    let text = std::fs::read_to_string(&old_file).ok()?;
    let old: OldKeyring = serde_json::from_str(&text).ok()?;
    // The old file is left where it is. Nothing reads it any more, and
    // deleting someone's keys to tidy up is not a trade worth making if
    // any of this turns out to be wrong.
    ring_from_old(&old)
}

fn read_ring(app: &tauri::AppHandle) -> Ring {
    if let Some(text) = ring_file(app).ok().and_then(|f| std::fs::read_to_string(f).ok()) {
        if let Ok(ring) = serde_json::from_str::<Ring>(&text) {
            return ring;
        }
    }
    match migrate(app) {
        Some(ring) => {
            // Written straight away, so the old file is read once and
            // never again.
            let _ = write_ring(app, &ring);
            ring
        }
        None => Ring::default(),
    }
}

fn write_ring(app: &tauri::AppHandle, ring: &Ring) -> Result<(), String> {
    let file = ring_file(app)?;
    let text = serde_json::to_string_pretty(ring).map_err(|e| e.to_string())?;
    // Written beside itself and moved into place, so an interrupted write
    // cannot leave the keys half-there.
    let part = file.with_extension("json.part");
    std::fs::write(&part, text).map_err(|e| e.to_string())?;
    std::fs::rename(&part, &file).map_err(|e| e.to_string())
}

/* --------------------------------------------------------- the registry */

/// Every model, which roles it can fill, and which it is filling.
pub fn models(app: &tauri::AppHandle) -> Vec<Model> {
    let ring = read_ring(app);
    let chosen_for = |id: &str| -> Vec<Role> {
        [Role::Ears, Role::Eyes, Role::Brain]
            .into_iter()
            .filter(|role| ring.chosen.get(role.key()).map(String::as_str) == Some(id))
            .collect()
    };

    let mut out: Vec<Model> = Vec::new();

    for engine in crate::caption::ENGINES {
        let provider_id = provider_id_of(engine.provider);
        out.push(Model {
            id: engine.id.to_string(),
            provider: provider_id.to_string(),
            provider_name: engine.provider.to_string(),
            model: engine.model.to_string(),
            note: engine.note.to_string(),
            keys_at: engine.keys_at.to_string(),
            roles: vec![Role::Ears],
            has_key: ring.keys.contains_key(provider_id),
            chosen_for: chosen_for(engine.id),
        });
    }

    for thinker in THINKERS {
        let p = provider(thinker.provider).expect("a thinker names a provider that exists");
        out.push(Model {
            id: thinker.id.to_string(),
            provider: p.id.to_string(),
            provider_name: p.name.to_string(),
            model: thinker.model.to_string(),
            note: thinker.note.to_string(),
            keys_at: p.keys_at.to_string(),
            roles: thinker.roles.to_vec(),
            has_key: ring.keys.contains_key(p.id),
            chosen_for: chosen_for(thinker.id),
        });
    }

    out
}

/// Whether a model exists, and whether it can do the job asked of it.
fn can(app: &tauri::AppHandle, id: &str, role: Role) -> Result<(), String> {
    let all = models(app);
    let Some(model) = all.iter().find(|m| m.id == id) else {
        return Err(format!("There is no model called {id}."));
    };
    if !model.roles.contains(&role) {
        return Err(format!(
            "{} · {} cannot be the {}.",
            model.provider_name,
            model.model,
            match role {
                Role::Ears => "ears",
                Role::Eyes => "eyes",
                Role::Brain => "brain",
            }
        ));
    }
    Ok(())
}

/// Marks a model for a role.
pub fn choose(app: &tauri::AppHandle, role: Role, id: &str) -> Result<(), String> {
    can(app, id, role)?;
    let mut ring = read_ring(app);
    ring.chosen.insert(role.key().to_string(), id.to_string());
    write_ring(app, &ring)
}

/// Puts a key in for one provider, or takes it away when given nothing.
///
/// Removing a key also unmarks any role it was filling: a role pointing
/// at a model that cannot be paid for would fail at the moment of use,
/// which is the worst moment to find out.
pub fn save_key(app: &tauri::AppHandle, provider_id: &str, key: &str) -> Result<(), String> {
    if provider(provider_id).is_none() {
        return Err(format!("There is no provider called {provider_id}."));
    }
    let mut ring = read_ring(app);
    let key = key.trim();
    if key.is_empty() {
        ring.keys.remove(provider_id);
        let orphaned: Vec<String> = models(app)
            .iter()
            .filter(|m| m.provider == provider_id)
            .map(|m| m.id.clone())
            .collect();
        ring.chosen
            .retain(|_, chosen_id| !orphaned.contains(chosen_id));
    } else {
        ring.keys.insert(provider_id.to_string(), key.to_string());
    }
    write_ring(app, &ring)
}

/// The key for a provider, or an error naming who to go to for one.
pub fn key_for(app: &tauri::AppHandle, provider_id: &str) -> Result<String, String> {
    read_ring(app)
        .keys
        .get(provider_id)
        .map(|k| k.trim().to_string())
        .filter(|k| !k.is_empty())
        .ok_or_else(|| {
            let name = provider(provider_id).map(|p| p.name).unwrap_or(provider_id);
            format!("{name} has no key yet — add one under AI providers.")
        })
}

/// Which model is marked for a role, if any.
pub fn chosen(app: &tauri::AppHandle, role: Role) -> Option<String> {
    read_ring(app)
        .chosen
        .get(role.key())
        .filter(|id| !id.is_empty())
        .cloned()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every transcription engine has to belong to a provider this module
    /// knows about, or its key would be stored against a name that has no
    /// entry and could never be entered through the settings.
    #[test]
    fn every_engine_belongs_to_a_known_provider() {
        for engine in crate::caption::ENGINES {
            let id = provider_id_of(engine.provider);
            assert!(
                provider(id).is_some(),
                "{} maps to {id}, which is not a provider",
                engine.provider
            );
        }
    }

    /// And every thinking model names one too.
    #[test]
    fn every_thinker_belongs_to_a_known_provider() {
        for thinker in THINKERS {
            assert!(
                provider(thinker.provider).is_some(),
                "{} names provider {}",
                thinker.id,
                thinker.provider
            );
            assert!(!thinker.roles.is_empty(), "{} fills no role", thinker.id);
        }
    }

    /// Nothing may claim to hear unless it is a transcription engine.
    /// This is the guard that keeps a chat model out of the ears list,
    /// which is exactly the mistake someone would make by hand.
    #[test]
    fn only_transcription_engines_claim_to_hear() {
        for thinker in THINKERS {
            assert!(
                !thinker.roles.contains(&Role::Ears),
                "{} claims to hear, but only a transcription service can",
                thinker.id
            );
        }
    }

    fn old(pairs: &[(&str, &str)], default: &str) -> OldKeyring {
        OldKeyring {
            default: default.to_string(),
            keys: pairs
                .iter()
                .map(|(id, key)| (id.to_string(), key.to_string()))
                .collect(),
        }
    }

    /// Keys entered before there were three roles have to come forward.
    /// Asking someone to find and paste their keys again because the file
    /// format moved on is not a cost this change is allowed to have.
    #[test]
    fn old_keys_come_forward_as_provider_keys() {
        let ring = ring_from_old(&old(
            &[
                ("openai-whisper-1", "sk-aaa"),
                ("groq-whisper-large-v3-turbo", "gsk-bbb"),
            ],
            "groq-whisper-large-v3-turbo",
        ))
        .expect("two keys is worth migrating");

        assert_eq!(ring.keys.get("openai"), Some(&"sk-aaa".to_string()));
        assert_eq!(ring.keys.get("groq"), Some(&"gsk-bbb".to_string()));
        assert_eq!(
            ring.chosen.get("ears"),
            Some(&"groq-whisper-large-v3-turbo".to_string()),
        );
        // Nothing has been chosen to see or to think: those roles did not
        // exist, so there is nothing to carry forward for them.
        assert_eq!(ring.chosen.get("eyes"), None);
        assert_eq!(ring.chosen.get("brain"), None);
    }

    /// Two engines from one provider share the one key, because they
    /// always did: the key was the provider's, filed under a model's name.
    #[test]
    fn two_engines_of_one_provider_leave_one_key() {
        let ring = ring_from_old(
            &old(
                &[
                    ("groq-whisper-large-v3-turbo", "gsk-same"),
                    ("groq-whisper-large-v3", "gsk-same"),
                ],
                "",
            ),
        )
        .expect("worth migrating");
        assert_eq!(ring.keys.len(), 1);
        assert_eq!(ring.keys.get("groq"), Some(&"gsk-same".to_string()));
    }

    /// An empty or unrecognisable old file must not produce a ring, or
    /// the migration would write an empty one and hide a real file behind
    /// it forever.
    #[test]
    fn nothing_worth_carrying_forward_migrates_nothing() {
        assert!(ring_from_old(&old(&[], "")).is_none());
        assert!(ring_from_old(&old(&[("openai-whisper-1", "   ")], "")).is_none());
        assert!(ring_from_old(&old(&[("a-service-that-was-removed", "k")], "")).is_none());
    }

    /// A marked engine that no longer exists is not carried forward as a
    /// choice; a role pointing at nothing would fail at the moment of use.
    #[test]
    fn a_marked_engine_that_is_gone_is_not_carried_forward() {
        let ring = ring_from_old(&old(&[("openai-whisper-1", "sk-aaa")], "gone-v9"))
            .expect("the key is still worth having");
        assert_eq!(ring.keys.get("openai"), Some(&"sk-aaa".to_string()));
        assert_eq!(ring.chosen.get("ears"), None);
    }

    /// Ids have to be unique across both tables, since a role is stored
    /// as an id and two models sharing one would be indistinguishable.
    #[test]
    fn ids_do_not_collide() {
        let mut seen = std::collections::BTreeSet::new();
        for engine in crate::caption::ENGINES {
            assert!(seen.insert(engine.id.to_string()), "{} twice", engine.id);
        }
        for thinker in THINKERS {
            assert!(seen.insert(thinker.id.to_string()), "{} twice", thinker.id);
        }
    }
}
