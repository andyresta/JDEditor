import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type {
  DeviceList,
  Rect,
  RecordingConfig,
  RecordingFile,
  RecordingStatus,
} from "./types";

const MEDIA_FILTERS = [
  { name: "Media", extensions: ["mp4", "mov", "mkv", "avi", "webm", "m4v"] },
];

export const api = {
  checkFfmpeg: () => invoke<boolean>("check_ffmpeg"),
  listDevices: () => invoke<DeviceList>("list_devices"),
  startRecording: (config: RecordingConfig) =>
    invoke<string>("start_recording", { config }),
  stopRecording: () => invoke<string>("stop_recording"),
  recordingStatus: () => invoke<RecordingStatus>("recording_status"),
  openAreaSelector: () => invoke<void>("open_area_selector"),
  submitAreaSelection: (rect: Rect | null) =>
    invoke<void>("submit_area_selection", { rect }),
  listRecordings: () => invoke<RecordingFile[]>("list_recordings"),
  deleteRecording: (path: string) =>
    invoke<void>("delete_recording", { path }),
  pickMediaFiles: () =>
    open({ multiple: true, filters: MEDIA_FILTERS }) as Promise<string[] | null>,
};
