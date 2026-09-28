//! Sound from a library, brought into a project.
//!
//! The editor can already use any file on disk; what it could not do was
//! find one. This searches a library of freely licensed sound, plays a
//! piece back, and puts the chosen file where the project can see it.
//!
//! Licences are carried the whole way through and never guessed at. The
//! sound in these libraries is free in several different senses — some of
//! it asks for a credit, some of it forbids commercial use — and an
//! editor that hid that difference would be handing people a problem
//! dressed as a convenience. Every result says what it is, and the ones
//! that cannot be used commercially are kept out unless they are asked
//! for.

use std::io::Write;
use std::path::PathBuf;

use tauri::Manager;

/// Where the sound comes from. One for now; the shape is here so a second
/// can be added without the editor learning anything new.
const FREESOUND_SEARCH: &str = "https://freesound.org/apiv2/search/text/";

/// What may be done with a piece of sound.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Licence {
    /// Public domain: no credit, no conditions.
    Cc0,
    /// Free to use, including commercially, if the maker is credited.
    Attribution,
    /// Not for anything that makes money.
    NonCommercial,
    /// Something this end has not seen before. Treated as the strictest
    /// of them, because a licence nobody recognises is not a licence
    /// anybody should rely on.
    Unknown,
}

impl Licence {
    /// Read from the licence URL the library returns.
    fn read(url: &str) -> Self {
        let url = url.to_ascii_lowercase();
        if url.contains("publicdomain/zero") || url.contains("/cc0") {
            Licence::Cc0
        } else if url.contains("licenses/by-nc") {
            Licence::NonCommercial
        } else if url.contains("licenses/by") {
            Licence::Attribution
        } else {
            Licence::Unknown
        }
    }

    /// Whether it may be used in something that makes money.
    pub fn commercial(self) -> bool {
        matches!(self, Licence::Cc0 | Licence::Attribution)
    }

    /// Whether the maker has to be credited.
    ///
    /// Everything but CC0. "NC" only adds a condition to a licence that
    /// already asks for a credit; it does not take that condition away,
    /// and reading it as though it did would have people publishing
    /// uncredited work.
    pub fn needs_credit(self) -> bool {
        !matches!(self, Licence::Cc0)
    }
}

/// One piece of sound, as the editor shows it.
///
/// Read as well as written: the editor hands one of these straight back
/// when it wants the sound fetched, so the names have to mean the same
/// thing in both directions — which is what `rename_all` here and
/// `deny_unknown_fields` together make certain of.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LibraryItem {
    pub id: String,
    pub name: String,
    /// Who made it, for the credit.
    pub author: String,
    pub seconds: f64,
    pub licence: Licence,
    /// The licence in full, to be shown and to be written into the
    /// credits file.
    pub licence_url: String,
    /// Where to hear it without committing to it.
    pub preview_url: String,
    /// The page it came from, so anyone can go and look.
    pub page_url: String,
}

/// What comes back from Freesound's text search. Only the fields asked
/// for are here; the rest of its answer is ignored.
#[derive(Debug, serde::Deserialize)]
struct FreesoundPage {
    #[serde(default)]
    count: u32,
    #[serde(default)]
    results: Vec<FreesoundSound>,
}

#[derive(Debug, serde::Deserialize)]
struct FreesoundSound {
    id: u64,
    name: String,
    #[serde(default)]
    username: String,
    #[serde(default)]
    duration: f64,
    #[serde(default)]
    license: String,
    #[serde(default)]
    previews: FreesoundPreviews,
    #[serde(default)]
    url: String,
}

#[derive(Debug, Default, serde::Deserialize)]
struct FreesoundPreviews {
    #[serde(rename = "preview-hq-mp3", default)]
    hq_mp3: String,
    #[serde(rename = "preview-lq-mp3", default)]
    lq_mp3: String,
}

/// What the editor asks for.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LibrarySearch {
    pub query: String,
    /// 1 for the first page.
    #[serde(default)]
    pub page: u32,
    /// Whether to include sound that may not be used commercially.
    #[serde(default)]
    pub include_non_commercial: bool,
}

/// The answer, with enough to say "more where that came from".
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryResults {
    pub items: Vec<LibraryItem>,
    /// How many the library says it has in all.
    pub total: u32,
    /// How many were left out for being non-commercial, so the editor can
    /// offer them rather than silently swallow them.
    pub hidden: u32,
}

fn client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(45))
        .build()
        .map_err(|e| e.to_string())
}

/// Turns one of the library's own records into one of ours.
fn read_sound(sound: FreesoundSound) -> Option<LibraryItem> {
    let preview = if !sound.previews.hq_mp3.is_empty() {
        sound.previews.hq_mp3
    } else if !sound.previews.lq_mp3.is_empty() {
        sound.previews.lq_mp3
    } else {
        // Nothing to play and nothing to fetch: not worth offering.
        return None;
    };
    Some(LibraryItem {
        id: sound.id.to_string(),
        name: sound.name,
        author: sound.username,
        seconds: sound.duration,
        licence: Licence::read(&sound.license),
        licence_url: sound.license,
        preview_url: preview,
        page_url: sound.url,
    })
}

/// Searches the library.
pub fn search(app: &tauri::AppHandle, ask: LibrarySearch) -> Result<LibraryResults, String> {
    let token = read_key(app)?;
    let query = ask.query.trim();
    if query.is_empty() {
        return Err("Type something to look for.".to_string());
    }

    let page = ask.page.max(1);
    let reply = client()?
        .get(FREESOUND_SEARCH)
        .query(&[
            ("query", query),
            ("page", &page.to_string()),
            ("page_size", "30"),
            // Only what is shown; asking for everything makes the answer
            // several times larger for no gain.
            (
                "fields",
                "id,name,username,duration,license,previews,url",
            ),
        ])
        .header("Authorization", format!("Token {token}"))
        .send()
        .map_err(|e| {
            if e.is_timeout() {
                "The sound library did not answer in time.".to_string()
            } else if e.is_connect() {
                "Could not reach the sound library — check the internet connection."
                    .to_string()
            } else {
                format!("The sound library could not be reached: {e}")
            }
        })?;

    let status = reply.status();
    let body = reply
        .text()
        .map_err(|e| format!("The library's answer could not be read: {e}"))?;

    if !status.is_success() {
        return Err(match status.as_u16() {
            401 | 403 => "The sound library refused the key. Check it under Library.".to_string(),
            429 => "The sound library is rate-limiting; wait a moment and try again.".to_string(),
            _ => format!("The sound library refused the search ({status})."),
        });
    }

    let page: FreesoundPage = serde_json::from_str(&body)
        .map_err(|e| format!("The library answered with something this end could not read: {e}"))?;

    let mut hidden = 0;
    let items: Vec<LibraryItem> = page
        .results
        .into_iter()
        .filter_map(read_sound)
        .filter(|item| {
            let allowed = ask.include_non_commercial || item.licence.commercial();
            if !allowed {
                hidden += 1;
            }
            allowed
        })
        .collect();

    Ok(LibraryResults {
        items,
        total: page.count,
        hidden,
    })
}

/// Where fetched sound is kept: beside the app's other working files,
/// under a name that says where it came from.
fn library_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("library");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Only what a file name can safely hold.
fn tidy(name: &str) -> String {
    let kept: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == ' ' {
                c
            } else {
                '-'
            }
        })
        .collect();
    let trimmed = kept.trim().trim_matches('-').trim();
    if trimmed.is_empty() {
        "sound".to_string()
    } else {
        trimmed.chars().take(60).collect()
    }
}

/// Fetches one piece of sound and puts it on disk, with its licence
/// written down beside it.
///
/// The credit is kept whether or not this particular licence asks for
/// one: what a licence requires can be looked up later, but who made a
/// sound cannot be recovered once it is an anonymous file in a folder.
pub fn fetch(app: &tauri::AppHandle, item: LibraryItem) -> Result<String, String> {
    let token = read_key(app)?;
    let dir = library_dir(app)?;
    let name = format!("{}-{}.mp3", tidy(&item.name), item.id);
    let path = dir.join(&name);

    if !path.is_file() {
        let reply = client()?
            .get(&item.preview_url)
            .header("Authorization", format!("Token {token}"))
            .send()
            .map_err(|e| format!("That sound could not be fetched: {e}"))?;
        if !reply.status().is_success() {
            return Err(format!(
                "That sound could not be fetched ({}).",
                reply.status()
            ));
        }
        let bytes = reply
            .bytes()
            .map_err(|e| format!("That sound could not be read: {e}"))?;
        // Written beside itself and moved into place, so an interrupted
        // fetch cannot leave half a sound behind for the editor to play.
        let part = path.with_extension("part");
        std::fs::write(&part, &bytes).map_err(|e| e.to_string())?;
        std::fs::rename(&part, &path).map_err(|e| e.to_string())?;
    }

    write_credit(&dir, &item)?;
    Ok(path.to_string_lossy().to_string())
}

/// Adds a line to the credits kept beside the fetched sound.
fn write_credit(dir: &std::path::Path, item: &LibraryItem) -> Result<(), String> {
    let file = dir.join("CREDITS.txt");
    let line = format!(
        "{} by {} — {} — {}\n",
        item.name, item.author, item.licence_url, item.page_url
    );
    if let Ok(existing) = std::fs::read_to_string(&file) {
        if existing.contains(&line) {
            return Ok(());
        }
    }
    let mut handle = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&file)
        .map_err(|e| e.to_string())?;
    handle.write_all(line.as_bytes()).map_err(|e| e.to_string())
}

/* ------------------------------------------------------------- the key */

fn key_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("library-key"))
}

/// Puts the library key in, or takes it away when given nothing. Kept in
/// the app's config folder, never in a project: a project is a thing
/// people send each other and a key is not.
pub fn save_key(app: &tauri::AppHandle, key: &str) -> Result<(), String> {
    let file = key_file(app)?;
    let key = key.trim();
    if key.is_empty() {
        let _ = std::fs::remove_file(&file);
        return Ok(());
    }
    std::fs::write(&file, key).map_err(|e| e.to_string())
}

/// Whether a key has been put in — never the key itself.
pub fn has_key(app: &tauri::AppHandle) -> bool {
    key_file(app)
        .ok()
        .and_then(|f| std::fs::read_to_string(f).ok())
        .map(|k| !k.trim().is_empty())
        .unwrap_or(false)
}

fn read_key(app: &tauri::AppHandle) -> Result<String, String> {
    let key = key_file(app)
        .ok()
        .and_then(|f| std::fs::read_to_string(f).ok())
        .unwrap_or_default();
    if key.trim().is_empty() {
        return Err("No sound library key has been set — put one in under Library.".to_string());
    }
    Ok(key.trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_licence_is_read_for_what_it_allows() {
        for (url, expected, commercial, credit) in [
            (
                "http://creativecommons.org/publicdomain/zero/1.0/",
                Licence::Cc0,
                true,
                false,
            ),
            (
                "https://creativecommons.org/licenses/by/4.0/",
                Licence::Attribution,
                true,
                true,
            ),
            (
                "https://creativecommons.org/licenses/by-nc/4.0/",
                Licence::NonCommercial,
                false,
                true,
            ),
            ("https://example.com/some-new-licence", Licence::Unknown, false, true),
        ] {
            let read = Licence::read(url);
            assert_eq!(read, expected, "{url}");
            assert_eq!(read.commercial(), commercial, "{url} commercial");
            assert_eq!(read.needs_credit(), credit, "{url} credit");
        }
    }

    /// "by-nc" contains "by", and read in the wrong order a
    /// non-commercial licence would be taken for a permissive one — which
    /// is the one mistake here that could cost somebody money.
    #[test]
    fn non_commercial_is_never_mistaken_for_plain_attribution() {
        assert_eq!(
            Licence::read("http://creativecommons.org/licenses/by-nc/3.0/"),
            Licence::NonCommercial
        );
        assert!(!Licence::read("http://creativecommons.org/licenses/by-nc-sa/4.0/").commercial());
    }

    /// The shape the library actually answers in, copied from its own
    /// documented reply rather than written from memory of it.
    #[test]
    fn the_reply_the_library_sends_is_the_reply_this_end_reads() {
        let body = r#"{
          "count": 1243,
          "next": "https://freesound.org/apiv2/search/text/?page=2",
          "previous": null,
          "results": [
            {
              "id": 316847,
              "name": "Rain on window.wav",
              "username": "inchadney",
              "duration": 32.4525,
              "license": "http://creativecommons.org/licenses/by/3.0/",
              "url": "https://freesound.org/people/inchadney/sounds/316847/",
              "previews": {
                "preview-hq-mp3": "https://freesound.org/data/previews/316/316847_5121236-hq.mp3",
                "preview-lq-mp3": "https://freesound.org/data/previews/316/316847_5121236-lq.mp3"
              }
            }
          ]
        }"#;
        let page: FreesoundPage = serde_json::from_str(body).expect("the library's own shape");
        assert_eq!(page.count, 1243);
        let item = read_sound(page.results.into_iter().next().unwrap()).expect("an item");
        assert_eq!(item.name, "Rain on window.wav");
        assert_eq!(item.author, "inchadney");
        assert_eq!(item.licence, Licence::Attribution);
        assert!(item.preview_url.ends_with("-hq.mp3"), "the better preview");
        assert!((item.seconds - 32.4525).abs() < 0.001);
    }

    #[test]
    fn a_sound_with_nothing_to_play_is_not_offered() {
        let body = r#"{"count":1,"results":[{"id":1,"name":"silent","username":"x","duration":1.0,"license":"http://creativecommons.org/publicdomain/zero/1.0/","url":"https://freesound.org/s/1/","previews":{}}]}"#;
        let page: FreesoundPage = serde_json::from_str(body).unwrap();
        assert!(read_sound(page.results.into_iter().next().unwrap()).is_none());
    }

    #[test]
    fn a_name_becomes_something_a_file_system_will_take() {
        assert_eq!(tidy("Rain on window.wav"), "Rain on window-wav");
        assert_eq!(tidy("../../etc/passwd"), "etc-passwd");
        assert_eq!(tidy("   "), "sound");
        assert!(tidy(&"x".repeat(200)).chars().count() <= 60);
    }
}
