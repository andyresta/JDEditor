import { invoke } from "@tauri-apps/api/core";
import type {
  DeviceList,
  Rect,
  RecordingConfig,
  RecordingFile,
  RecordingStatus,
} from "./types";

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
};
