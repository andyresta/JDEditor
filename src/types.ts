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

export interface RecordingStatus {
  is_recording: boolean;
  elapsed_seconds: number;
  output_path: string | null;
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

export interface MediaItem {
  path: string;
  name: string;
  status: MediaStatus;
  durationSeconds?: number | null;
  width?: number | null;
  height?: number | null;
  thumbnailPath?: string | null;
}

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

