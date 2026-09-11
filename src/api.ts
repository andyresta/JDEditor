import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { IMPORT_FILTERS, PROJECT_EXTENSION } from "./types";
import type {
  BarSetup,
  DeviceList,
  MediaPrepared,
  Rect,
  RecordingConfig,
  RecordingFile,
  RecordingStatus,
} from "./types";

export const api = {
  checkFfmpeg: () => invoke<boolean>("check_ffmpeg"),
  debugDeviceScan: () => invoke<string>("debug_device_scan"),
  listDevices: () => invoke<DeviceList>("list_devices"),
  startRecording: (config: RecordingConfig) =>
    invoke<string>("start_recording", { config }),
  pauseRecording: () => invoke<void>("pause_recording"),
  resumeRecording: () => invoke<void>("resume_recording"),
  stopRecording: () => invoke<string>("stop_recording"),
  discardRecording: () => invoke<void>("discard_recording"),
  recordingStatus: () => invoke<RecordingStatus>("recording_status"),
  openRecorderBar: (setup: BarSetup) =>
    invoke<void>("open_recorder_bar", { setup }),
  closeRecorderBar: () => invoke<void>("close_recorder_bar"),
  recorderBarSetup: () => invoke<BarSetup | null>("recorder_bar_setup"),
  openAreaSelector: () => invoke<void>("open_area_selector"),
  submitAreaSelection: (rect: Rect | null) =>
    invoke<void>("submit_area_selection", { rect }),
  cancelAreaSelection: () => invoke<void>("cancel_area_selection"),
  listRecordings: () => invoke<RecordingFile[]>("list_recordings"),
  deleteRecording: (path: string) =>
    invoke<void>("delete_recording", { path }),
  pickMediaFiles: (kind: "visual" | "audio" = "visual") =>
    open({ multiple: true, filters: IMPORT_FILTERS[kind] }) as Promise<
      string[] | null
    >,
  pickProjectFile: () =>
    open({
      multiple: false,
      filters: [{ name: "JDEditor project", extensions: [PROJECT_EXTENSION] }],
    }) as Promise<string | null>,
  pickProjectSavePath: (suggested: string) =>
    save({
      defaultPath: suggested,
      filters: [{ name: "JDEditor project", extensions: [PROJECT_EXTENSION] }],
    }),
  saveProject: (path: string, contents: string) =>
    invoke<string>("save_project", { path, contents }),
  loadProject: (path: string) => invoke<string>("load_project", { path }),
  prepareMedia: (path: string) =>
    invoke<MediaPrepared>("prepare_media", { path }),
};
