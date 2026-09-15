use std::path::{Path, PathBuf};
use tauri::Manager;

/// The extension a saved project carries.
pub const EXTENSION: &str = "jd";

/// Writes a project to disk. The document itself is composed by the
/// frontend and passed through as JSON text, so the shape of a project
/// stays in one place rather than being mirrored in two languages.
pub fn save(path: &str, contents: &str) -> Result<String, String> {
    let path = with_extension(path);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, contents)
        .map_err(|e| format!("failed to save the project: {e}"))?;
    Ok(path.to_string_lossy().to_string())
}

pub fn load(path: &str) -> Result<String, String> {
    std::fs::read_to_string(path).map_err(|e| format!("failed to open the project: {e}"))
}

/// Makes sure a saved project ends in `.jd`, since the save dialog lets
/// the name be typed by hand.
fn with_extension(path: &str) -> PathBuf {
    let path = Path::new(path);
    match path.extension() {
        Some(existing) if existing.eq_ignore_ascii_case(EXTENSION) => path.to_path_buf(),
        _ => {
            let mut name = path.file_name().unwrap_or_default().to_os_string();
            name.push(format!(".{EXTENSION}"));
            path.with_file_name(name)
        }
    }
}

/* ------------------------------------------------------------- recovery */

/// What the editor keeps its unsaved work in between saves.
///
/// One slot, in the app's own cache folder rather than beside the user's
/// project: a project that has never been saved has no folder to sit
/// beside, and a half-written copy of someone's film appearing next to the
/// real one is its own kind of confusion.
const RECOVERY_FILE: &str = "recovery.json";

fn recovery_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(RECOVERY_FILE))
}

/// Keeps a copy of the work in progress.
///
/// Written whole and then moved into place, so a crash halfway through
/// writing leaves the last good copy rather than a truncated one — the
/// failure this exists to survive is exactly the one that would otherwise
/// happen while it was being written.
pub fn write_recovery(app: &tauri::AppHandle, contents: &str) -> Result<(), String> {
    let path = recovery_path(app)?;
    let pending = path.with_extension("part");
    std::fs::write(&pending, contents).map_err(|e| e.to_string())?;
    std::fs::rename(&pending, &path).map_err(|e| e.to_string())?;
    Ok(())
}

/// The work left behind by a session that ended without saving, if there
/// is any. None when the last session was closed with everything saved.
pub fn read_recovery(app: &tauri::AppHandle) -> Result<Option<String>, String> {
    let path = recovery_path(app)?;
    match std::fs::read_to_string(&path) {
        Ok(contents) => Ok(Some(contents)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Forgets it: the work has been saved, or the user has said to let it go.
/// Only ever removes this copy — the project's own file is never touched.
pub fn clear_recovery(app: &tauri::AppHandle) -> Result<(), String> {
    let path = recovery_path(app)?;
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}
