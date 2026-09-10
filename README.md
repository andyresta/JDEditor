# JDEditor

A cross-platform (Windows, macOS, Linux) desktop screen/webcam/audio recorder
built with Tauri v2 + Rust + React. This is step 1 of a larger video editor:
record first, edit later.

## Features (step 1)

- Screen recording, with a picker for which display to capture
- Optional webcam overlay (picture-in-picture), with source selection
- Optional audio recording, with source selection
- Drag-to-select a custom capture area (or record the entire screen)
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
  monitor so the user can drag-select a capture region.
- `recordings.rs` — lists/deletes finished recordings from the output folder.

The frontend (`src/`) is a single Vite + React page; `App.tsx` renders either
the main recorder UI or the area-selector overlay UI, based on which Tauri
window it's running in (checked via the window label). Within the main
window, `RecorderApp` switches between the recording form and
`EditorShell` (the editor placeholder). Media playback in the editor uses
Tauri's asset protocol (`convertFileSrc`), enabled in `tauri.conf.json` for
locally-picked files.

## Prerequisites

- **ffmpeg** must be installed and on `PATH`. The app checks for this on
  startup and shows install instructions if it's missing.
  - Windows: `winget install ffmpeg`
  - macOS: `brew install ffmpeg`
  - Linux: `sudo apt install ffmpeg` (or your distro's package manager)
- Standard [Tauri prerequisites](https://tauri.app/start/prerequisites/) for
  your OS (Rust toolchain, and on Linux the WebKitGTK/GTK dev packages).

## Development

```bash
npm install
npm run tauri dev
```

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
- This app was developed in a headless Linux container with no attached
  display, camera, or microphone. The Rust code compiles and the ffmpeg
  command-building logic has been reviewed carefully for each OS, but actual
  recording has **not** been exercised end-to-end on real hardware for any
  platform yet — please test on your target OS(es) before relying on it.
