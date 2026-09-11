export interface ScreenInfo {
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  is_primary: boolean;
}

export interface DeviceInfo {
  id: string;
  name: string;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type QualityPreset = "low" | "medium" | "high" | "source";

export interface DeviceList {
  screens: ScreenInfo[];
  webcams: DeviceInfo[];
  audio_inputs: DeviceInfo[];
}

export interface RecordingConfig {
  screen_id: string;
  area: Rect | null;
  include_webcam: boolean;
  webcam_id: string | null;
  include_audio: boolean;
  audio_id: string | null;
  quality: QualityPreset;
  fps: number;
  output_dir: string | null;
}

/** What the main window hands to the floating bar when it opens it. */
export interface BarSetup {
  config: RecordingConfig;
  /** Have the bar drag out a region first, rather than starting on the
   * whole screen. */
  pick_area: boolean;
}

export interface RecordingStatus {
  is_recording: boolean;
  is_paused: boolean;
  elapsed_seconds: number;
  output_path: string | null;
  /** Why the recording stopped, when ffmpeg failed on its own. */
  error: string | null;
  /** Microphone level, 0..1, while audio is being recorded. */
  audio_level: number | null;
}

export interface RecordingFile {
  path: string;
  name: string;
  size_bytes: number;
  created_at: string;
}

export const QUALITY_LABELS: Record<QualityPreset, string> = {
  low: "Low (480p)",
  medium: "Medium (720p)",
  high: "High (1080p)",
  source: "Original (source resolution)",
};

export const FPS_OPTIONS = [24, 30, 60] as const;

export interface MediaPrepared {
  duration_seconds: number | null;
  width: number | null;
  height: number | null;
  thumbnail_path: string | null;
}

export type MediaStatus = "preparing" | "ready";

export type MediaKind = "video" | "image" | "audio";

export interface MediaItem {
  path: string;
  name: string;
  kind: MediaKind;
  status: MediaStatus;
  durationSeconds?: number | null;
  width?: number | null;
  height?: number | null;
  thumbnailPath?: string | null;
}

const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "avif"];
const AUDIO_EXTENSIONS = ["mp3", "wav", "m4a", "aac", "flac", "ogg", "opus"];

export const VIDEO_EXTENSIONS = ["mp4", "mov", "mkv", "avi", "webm", "m4v"];

/** What kind of media a path holds, judged by its extension — everything
 * unrecognised is treated as video, which is what this app records. */
export function mediaKindFor(path: string): MediaKind {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  if (IMAGE_EXTENSIONS.includes(extension)) return "image";
  if (AUDIO_EXTENSIONS.includes(extension)) return "audio";
  return "video";
}

export const IMPORT_FILTERS = {
  visual: [
    { name: "Video & images", extensions: [...VIDEO_EXTENSIONS, ...IMAGE_EXTENSIONS] },
  ],
  audio: [{ name: "Audio", extensions: AUDIO_EXTENSIONS }],
};

export const BACKDROP_KINDS = [
  "Desktop",
  "Wallpaper",
  "Image",
  "Color",
  "Gradient",
  "None",
] as const;
export type BackdropKind = (typeof BACKDROP_KINDS)[number];

export const BACKDROP_CATEGORIES = [
  "macOS",
  "Dark",
  "Blue",
  "Cities",
  "Purple",
  "Orange",
] as const;
export type BackdropCategory = (typeof BACKDROP_CATEGORIES)[number];

/** Editor appearance and timeline state. Saved as part of the project, so
 * reopening a `.jd` file restores how it looked. */
export interface EditorSettings {
  backdropKind: BackdropKind;
  category: BackdropCategory;
  swatch: number;
  padding: number;
  rounded: number;
  timelineZoom: number;
}

export const DEFAULT_EDITOR_SETTINGS: EditorSettings = {
  backdropKind: "Wallpaper",
  category: "Cities",
  swatch: 0,
  padding: 36,
  rounded: 14,
  timelineZoom: 25,
};

/** A piece of media placed on a track. Imported media sits in the project
 * pool until it's dragged onto a track, at which point it becomes one of
 * these — so the same file can appear more than once. */
export interface TimelineClip {
  id: string;
  mediaPath: string;
  /** Where the clip begins, in seconds from the start of the timeline. */
  startSeconds: number;
  durationSeconds: number;
}

export interface TimelineTrack {
  id: string;
  name: string;
  clips: TimelineClip[];
}

/** How long a clip runs when its media hasn't reported a duration — a
 * still image has none at all, and a video that's still being probed
 * doesn't have one yet. */
export const DEFAULT_CLIP_SECONDS = 5;

let idCounter = 0;

/** Ids only have to be unique within a project, and this avoids depending
 * on `crypto.randomUUID`, which needs a secure context — not something to
 * bet on across Tauri's custom protocol origin and the dev server. */
export function newId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${idCounter}`;
}

export function newTrack(name: string): TimelineTrack {
  return { id: newId("track"), name, clips: [] };
}

/** The contents of a `.jd` project file. Only what can't be recomputed is
 * stored: durations and thumbnails are read back off disk on open.
 *
 * `tracks` is optional so that projects saved before the timeline existed
 * still open — they simply arrive with no tracks laid out yet. */
export interface ProjectFile {
  format: "jdeditor-project";
  version: 1;
  name: string;
  media: { path: string; name: string }[];
  tracks?: TimelineTrack[];
  activeMediaPath: string | null;
  settings: EditorSettings;
}

export const PROJECT_EXTENSION = "jd";

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return "";
  const total = Math.round(seconds);
  const m = Math.floor(total / 60)
    .toString()
    .padStart(2, "0");
  const s = Math.floor(total % 60)
    .toString()
    .padStart(2, "0");
  return `${m}:${s}`;
}

