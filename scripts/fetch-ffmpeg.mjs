#!/usr/bin/env node
// Downloads static ffmpeg + ffprobe binaries for the current machine and
// places them where Tauri's `bundle.externalBin` (see tauri.conf.json)
// expects to find them, so `npm run tauri dev`/`build` bundles them into
// the app — end users won't need ffmpeg installed separately.
//
// Run this once per OS/arch you build for (it fetches binaries for the
// machine it's running on, matching normal Tauri cross-platform builds:
// build on/for each target separately, or in CI per-runner).
//
// Sources:
//   - Windows & Linux: BtbN/FFmpeg-Builds (GPL static builds, GitHub releases)
//   - macOS: evermeet.cx (x86_64 static builds; run fine on Apple Silicon
//     via Rosetta 2)
//
// NOTE: this fetches a full-featured GPL ffmpeg build (~150-190MB per
// binary). Bundling ffmpeg+ffprobe adds a few hundred MB to the app —
// that's the trade-off for users not needing to install ffmpeg
// separately. ffmpeg/ffprobe are invoked as separate subprocesses (never
// linked into the app binary), which is the standard, license-compatible
// way apps bundle them; see README.md's "ffmpeg licensing" note.

import { execFileSync } from "node:child_process";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  chmodSync,
  readdirSync,
  statSync,
  copyFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const BINARIES_DIR = path.join(REPO_ROOT, "src-tauri", "binaries");
const IS_WINDOWS = process.platform === "win32";
const EXE = IS_WINDOWS ? ".exe" : "";
const force = process.argv.includes("--force");

function rustHostTriple() {
  const out = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
  const match = out.match(/^host:\s*(\S+)/m);
  if (!match) throw new Error('Could not determine Rust host triple from `rustc -vV`.');
  return match[1];
}

// Maps a Rust target triple to how to fetch ffmpeg/ffprobe for it.
// `archive`: a single download containing both binaries (under bin/).
// `split`: two separate single-binary downloads.
function sourceFor(triple) {
  const GH = "https://github.com/BtbN/FFmpeg-Builds/releases/latest/download";
  switch (triple) {
    case "x86_64-unknown-linux-gnu":
      return { kind: "archive", url: `${GH}/ffmpeg-master-latest-linux64-gpl.tar.xz` };
    case "aarch64-unknown-linux-gnu":
      return { kind: "archive", url: `${GH}/ffmpeg-master-latest-linuxarm64-gpl.tar.xz` };
    case "x86_64-pc-windows-msvc":
      return { kind: "archive", url: `${GH}/ffmpeg-master-latest-win64-gpl.zip` };
    case "aarch64-pc-windows-msvc":
      return { kind: "archive", url: `${GH}/ffmpeg-master-latest-winarm64-gpl.zip` };
    case "x86_64-apple-darwin":
    case "aarch64-apple-darwin":
      // evermeet.cx only builds x86_64; it runs under Rosetta 2 on Apple
      // Silicon. ffmpeg/ffprobe ship as separate single-binary zips.
      return {
        kind: "split",
        ffmpegUrl: "https://evermeet.cx/ffmpeg/getrelease/ffmpeg/zip",
        ffprobeUrl: "https://evermeet.cx/ffmpeg/getrelease/ffprobe/zip",
      };
    default:
      throw new Error(
        `No known ffmpeg source for target "${triple}". Download ffmpeg/ffprobe ` +
          `for this platform yourself and place them at:\n` +
          `  src-tauri/binaries/ffmpeg-${triple}${EXE}\n` +
          `  src-tauri/binaries/ffprobe-${triple}${EXE}\n`,
      );
  }
}

async function downloadFile(url, destFile) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) {
    throw new Error(`Download failed (${res.status} ${res.statusText}): ${url}`);
  }
  const out = createWriteStream(destFile);
  await finished(Readable.fromWeb(res.body).pipe(out));
}

function extractArchive(archiveFile, destDir) {
  mkdirSync(destDir, { recursive: true });
  // GNU tar (Linux) auto-detects .tar.xz; bsdtar (Windows' built-in tar.exe,
  // and macOS) also reads .zip archives — so plain `tar -xf` works for
  // every archive type we use, on every OS we run this script on.
  execFileSync("tar", ["-xf", archiveFile, "-C", destDir], { stdio: "inherit" });
}

function findFile(dir, name) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findFile(full, name);
      if (found) return found;
    } else if (entry.name === name) {
      return full;
    }
  }
  return null;
}

async function main() {
  const triple = rustHostTriple();
  console.log(`Rust host triple: ${triple}`);

  const ffmpegDest = path.join(BINARIES_DIR, `ffmpeg-${triple}${EXE}`);
  const ffprobeDest = path.join(BINARIES_DIR, `ffprobe-${triple}${EXE}`);

  if (!force && existsSync(ffmpegDest) && existsSync(ffprobeDest)) {
    console.log("ffmpeg/ffprobe already present for this target. Use --force to re-download.");
    return;
  }

  const source = sourceFor(triple);
  mkdirSync(BINARIES_DIR, { recursive: true });
  const workDir = path.join(tmpdir(), `jdeditor-ffmpeg-${Date.now()}`);
  mkdirSync(workDir, { recursive: true });

  try {
    let ffmpegFound;
    let ffprobeFound;

    if (source.kind === "archive") {
      const archiveExt = source.url.endsWith(".zip") ? ".zip" : ".tar.xz";
      const archivePath = path.join(workDir, `ffmpeg${archiveExt}`);
      console.log(`Downloading ${source.url} ...`);
      await downloadFile(source.url, archivePath);

      const extractDir = path.join(workDir, "extracted");
      extractArchive(archivePath, extractDir);
      ffmpegFound = findFile(extractDir, `ffmpeg${EXE}`);
      ffprobeFound = findFile(extractDir, `ffprobe${EXE}`);
    } else {
      for (const [name, url] of [
        ["ffmpeg", source.ffmpegUrl],
        ["ffprobe", source.ffprobeUrl],
      ]) {
        const archivePath = path.join(workDir, `${name}.zip`);
        console.log(`Downloading ${name} from ${url} ...`);
        await downloadFile(url, archivePath);
        const extractDir = path.join(workDir, `${name}-extracted`);
        extractArchive(archivePath, extractDir);
        const found = findFile(extractDir, `${name}${EXE}`);
        if (name === "ffmpeg") ffmpegFound = found;
        else ffprobeFound = found;
      }
    }

    if (!ffmpegFound || !ffprobeFound) {
      throw new Error("Could not find ffmpeg/ffprobe after extracting the download(s).");
    }

    copyFileSync(ffmpegFound, ffmpegDest);
    copyFileSync(ffprobeFound, ffprobeDest);
    if (!IS_WINDOWS) {
      chmodSync(ffmpegDest, 0o755);
      chmodSync(ffprobeDest, 0o755);
    }

    for (const dest of [ffmpegDest, ffprobeDest]) {
      const sizeMb = (statSync(dest).size / (1024 * 1024)).toFixed(1);
      console.log(`✓ ${path.relative(REPO_ROOT, dest)} (${sizeMb} MB)`);
    }
    console.log("\nDone. These will be bundled automatically by `tauri dev`/`tauri build`.");
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(`\nfetch-ffmpeg failed: ${err.message}`);
  console.error(
    "\nYou can also download ffmpeg/ffprobe manually and place them at:\n" +
      `  src-tauri/binaries/ffmpeg-<target-triple>${EXE}\n` +
      `  src-tauri/binaries/ffprobe-<target-triple>${EXE}\n` +
      '(run `rustc -vV` to find your target triple, under "host:").',
  );
  process.exit(1);
});
