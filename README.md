# JDEditor

A cross-platform (Windows, macOS, Linux) desktop screen/webcam/audio recorder
built with Tauri v2 + Rust + React. This is step 1 of a larger video editor:
record first, edit later.

## Features (step 1)

- The app opens to a centered **launcher** with two choices: **Record** or
  **Editor**. Record leads to the recording form below; Editor opens
  `EditorShell` directly (with an empty project) and maximizes the window,
  since the editor is meant to fill the screen. The window restores to its
  normal centered size when you leave the editor (Close Project).
- Screen recording, with a picker for which display to capture
- Optional webcam overlay (picture-in-picture), with source selection
- Optional audio recording, with source selection
- Clicking **Start Recording** opens the drag-to-select area overlay right
  away (no separate "select area" step); press **Esc** during selection to
  record the entire screen instead.
- Quality presets (Low/Medium/High/Source) and selectable frame rate (24/30/60 fps)
- A list of past recordings with "show in folder" and delete
- When a recording finishes (Stop clicked, or the recording ends on its own),
  the app automatically switches to an **editor placeholder** — a desktop
  app-style shell (File/Edit/View menu bar, media/preview/properties panels,
  a timeline strip) that plays back the recording. It has the standard menu
  items you'd expect (New/Open/Save/Save As/Export/Import Media/Close
  Project), but only playback, project navigation, and media import are
  wired up — actual editing (trim, cut, effects, export, saving a project
  file) is intentionally a "coming soon" placeholder for a future step.
- Newly added media (a fresh recording, or anything picked via Import
  Media/Open Project) shows a "Preparing…" spinner in the Media panel and
  Preview while its duration, resolution and a thumbnail are fetched
  asynchronously in the background (via `ffprobe`/`ffmpeg`); the UI never
  blocks waiting for this. Clicking Stop switches to the editor
  immediately — it doesn't wait for ffmpeg to finish flushing the file
  first, that wait (plus the metadata/thumbnail fetch) happens behind the
  same spinner.

## How it works

Capture and encoding are done by shelling out to **ffmpeg** (screen grab +
webcam + microphone are muxed into a single H.264/AAC `.mp4`), which is far
more reliable across three OSes than a custom capture stack. The Rust side
(`src-tauri/src`) is organized as:

- `devices.rs` — enumerates displays (via Tauri's monitor API), webcams and
  audio inputs (via OS-specific means: `/dev/video*` + `pactl` on Linux,
  `ffmpeg -f avfoundation -list_devices` on macOS, `ffmpeg -f dshow
  -list_devices` on Windows).
- `recorder.rs` — builds the per-OS ffmpeg command line (x11grab/gdigrab/
  avfoundation for the screen, v4l2/dshow/avfoundation for the webcam,
  pulse/dshow/avfoundation for audio) and manages the ffmpeg child process
  (start/stop/status).
- `overlay.rs` — opens a transparent, always-on-top window spanning every
  monitor so the user can drag-select a capture region. Window creation/
  closing/focus is dispatched via `AppHandle::run_on_main_thread` — doing
  this from a command-handler thread instead hung the whole app on
  Windows (Win32 requires window operations to happen on the thread that
  created them).
- `recordings.rs` — lists/deletes finished recordings from the output folder.
- `media.rs` — asynchronously probes a media file with `ffprobe` (duration,
  resolution) and extracts a thumbnail frame with `ffmpeg`, both best-effort
  (a missing `ffprobe` or a probe failure degrades gracefully rather than
  blocking playback).
- `sidecar.rs` — resolves `ffmpeg`/`ffprobe` to the copy bundled next to
  the app (if `npm run fetch-ffmpeg` was run), falling back to `PATH`
  otherwise. Every `Command::new("ffmpeg"/"ffprobe")` call goes through
  this instead of the bare name.

The frontend (`src/`) is a single Vite + React page; `App.tsx` renders either
the main recorder UI or the area-selector overlay UI, based on which Tauri
window it's running in (checked via the window label). Within the main
window, `RecorderApp` switches between three views: `Launcher` (the
Record/Editor choice), the recording form, and `EditorShell` (the editor
placeholder) — maximizing/restoring the window as it enters/leaves the
editor view. Media playback in the editor uses Tauri's asset protocol
(`convertFileSrc`), enabled in `tauri.conf.json` for locally-picked files.

## Prerequisites

- Standard [Tauri prerequisites](https://tauri.app/start/prerequisites/) for
  your OS (Rust toolchain, and on Linux the WebKitGTK/GTK dev packages).
- **ffmpeg**: see "Bundling ffmpeg" below — either fetch it once so it's
  bundled into the app, or skip that and just have ffmpeg installed and on
  `PATH` instead (the app checks for either at startup and shows install
  instructions if neither is found).

## Development

```bash
npm install
npm run fetch-ffmpeg   # one-time, see "Bundling ffmpeg" below
npm run tauri dev
```

## Bundling ffmpeg

JDEditor shells out to `ffmpeg`/`ffprobe` for everything (recording,
metadata, thumbnails). By default it also looks for them bundled right
next to the app — so once you've fetched them, **end users don't need to
install ffmpeg separately**.

```bash
npm run fetch-ffmpeg
```

This downloads a static `ffmpeg`+`ffprobe` build for **the machine you run
it on** and places them at `src-tauri/binaries/ffmpeg-<target-triple>` /
`ffprobe-<target-triple>`, which `tauri.conf.json`'s `bundle.externalBin`
then copies into every dev/release build automatically. Run it once per
OS/arch you build for (matching how Tauri cross-platform builds normally
work — build on/for each target, e.g. one CI runner per OS).

- **Sources**: Windows & Linux builds come from
  [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds) (GitHub
  releases); macOS from [evermeet.cx](https://evermeet.cx/ffmpeg/) (x86_64
  only — runs fine on Apple Silicon via Rosetta 2). These were verified
  working for Linux x86_64 in development (downloaded, extracted, and
  confirmed `tauri build` copies them next to the compiled binary with
  zero system ffmpeg installed). The Windows/macOS URLs were checked to
  respond correctly but **not** run end-to-end — verify on those
  platforms before shipping.
- **Size trade-off**: these are full-featured GPL static builds, ~165MB
  *each* — bundling both adds a few hundred MB to the app. If that's too
  much, skip `fetch-ffmpeg` and rely on a system-installed ffmpeg instead
  (the app falls back to `PATH` automatically); or ask for the bundling
  step to be dropped later.
- **Licensing**: the bundled ffmpeg/ffprobe are GPL-licensed (built with
  `libx264`/`libx265`). They're invoked as separate subprocesses — never
  linked into JDEditor's own binary — which is the standard way apps
  bundle ffmpeg without the GPL applying to the rest of the codebase. See
  `THIRD_PARTY_NOTICES.md`.
- Don't have `ffmpeg`/`ffprobe` bundled or installed? The app shows a
  screen with manual install instructions (`winget`/`brew`/`apt`) as a
  fallback.

## Known limitations / platform notes

- **Linux**: screen capture uses X11 (`x11grab`); Wayland sessions are not
  currently supported (a common ffmpeg limitation). Audio device listing
  uses PulseAudio (`pactl`); PipeWire-only setups without the Pulse
  compatibility layer won't show sources.
- **macOS**: avfoundation only supports capturing an entire display, so a
  selected sub-area is cropped out of the full-screen capture after the
  fact rather than captured directly. The app assumes avfoundation's
  screen-capture device order matches the OS's monitor enumeration order.
- **Windows**: `gdigrab` captures the whole virtual desktop; per-monitor
  "screens" in the picker are really just different regions of that same
  capture.
- **Webcam/audio not detected**: the Windows (`dshow`) and macOS
  (`avfoundation`) device lists are parsed from ffmpeg's own log text,
  which this project couldn't be tested against on real hardware (see
  below). If nothing shows up, use the "No webcam/audio detected? Show
  diagnostic info" button next to those dropdowns — it dumps the raw
  ffmpeg device-listing output, which is the fastest way to fix the parser
  against your machine's actual output.
- This app was developed in a headless Linux container with no attached
  display, camera, or microphone, and cross-compiling to Windows/macOS
  isn't fully possible there either (no MSVC linker, no Apple SDK). Given
  that, verification so far:
  - **Linux x86_64**: built and cross-checked for real in that
    environment (including the bundled-ffmpeg sidecar end-to-end) — this
    is the most-verified platform.
  - **Windows**: the Rust code was cross-compiled and type-checked for
    the `x86_64-pc-windows-gnu` target (catching real bugs — see the
    `run_on_main_thread` fix above), but never actually run on Windows by
    this project. It has since been run by a real user on Windows, which
    is how the area-selector hang and empty webcam/audio lists were
    caught; those fixes are in, but not yet re-confirmed on that machine.
  - **macOS**: could not be cross-compiled or run at all (would need a
    real Mac or Apple's SDK) — the `avfoundation` code path is unverified
    beyond code review.
  - Please keep reporting what you see (including the diagnostic dump for
    device-detection issues) — that's the only way to close these gaps.
