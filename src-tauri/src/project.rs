use std::path::{Path, PathBuf};

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
