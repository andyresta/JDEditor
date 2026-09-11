use std::path::PathBuf;

/// Resolves the path to a bundled "sidecar" binary (`ffmpeg`/`ffprobe`)
/// shipped next to the app executable, so end users don't need to install
/// ffmpeg separately. Tauri's `bundle.externalBin` copies the right
/// platform binary alongside the app at build time (see
/// `tauri.conf.json` and `scripts/fetch-ffmpeg.mjs`); at runtime it's
/// just a regular file sitting next to `current_exe()`.
///
/// Returns `None` if it isn't there — e.g. a plain `cargo run` (not
/// `tauri dev`/`tauri build`), a dev build where `npm run fetch-ffmpeg`
/// hasn't been run yet, or an unsupported platform. Callers should fall
/// back to searching PATH in that case, preserving the original
/// "ffmpeg installed system-wide" behavior.
pub fn resolve(name: &str) -> Option<PathBuf> {
    let exe_dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    let filename = if cfg!(target_os = "windows") {
        format!("{name}.exe")
    } else {
        name.to_string()
    };
    let candidate = exe_dir.join(filename);
    candidate.is_file().then_some(candidate)
}

/// The string to hand to `Command::new(...)` for `name`: the bundled
/// sidecar's absolute path if present, otherwise just `name` (so the OS
/// resolves it via PATH, same as before sidecar support existed).
pub fn command_name(name: &str) -> String {
    resolve(name)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| name.to_string())
}
