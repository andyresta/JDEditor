# Third-party notices

## FFmpeg / ffprobe

If you ran `npm run fetch-ffmpeg`, this app bundles pre-built `ffmpeg` and
`ffprobe` binaries so recording and media playback work without a separate
install. These binaries are:

- Copyright (c) the FFmpeg developers, licensed under the **GNU General
  Public License v3 (or later)** (built with GPL components including
  `libx264`/`libx265`).
- Obtained from third-party build providers, not modified:
  - Windows & Linux: [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds)
  - macOS: [evermeet.cx](https://evermeet.cx/ffmpeg/)
- Full source for FFmpeg is available from the
  [FFmpeg project](https://ffmpeg.org/download.html) and from the build
  providers linked above.

JDEditor invokes `ffmpeg`/`ffprobe` as separate subprocesses (via
`std::process::Command`) — they are never statically or dynamically
linked into JDEditor's own compiled binary. JDEditor's own source code is
not covered by the GPL as a result of bundling these tools.

If you distribute a build of this app with ffmpeg/ffprobe bundled, you are
redistributing GPL-licensed binaries and should keep this notice (or
equivalent attribution and a pointer to source) alongside your
distribution.
