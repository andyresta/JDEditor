import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { IMPORT_FILTERS, PROJECT_EXTENSION } from "./types";
import type {
  AudioPeaks,
  BarSetup,
  CaptionSegment,
  CursorTrack,
  SpeechEngine,
  ExportFormat,
  ExportPlan,
  DeviceList,
  WindowInfo,
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
  /** The windows on screen, for pointing a recording at one of them. */
  listWindows: () => invoke<WindowInfo[]>("list_windows"),
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
  /** One file, for putting a clip back in touch with media that moved.
   *
   * Filtered by what went missing: a dialog offering only video would not
   * show the .mp3 it is asking the user to find. */
  pickMediaFile: (name: string, kind: "visual" | "audio" = "visual") =>
    open({
      multiple: false,
      title: `Where is ${name}?`,
      filters: IMPORT_FILTERS[kind],
    }) as Promise<string | null>,
  pathExists: (path: string) => invoke<boolean>("path_exists", { path }),
  /** The editor's copy of work that has not been saved yet. One slot, in
   * the app's own folder — never beside the user's project. */
  writeRecovery: (contents: string) => invoke<void>("write_recovery", { contents }),
  readRecovery: () => invoke<string | null>("read_recovery"),
  clearRecovery: () => invoke<void>("clear_recovery"),
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
  audioPeaks: (path: string) => invoke<AudioPeaks>("audio_peaks", { path }),
  pickExportPath: (suggested: string, format: ExportFormat) =>
    save({
      defaultPath: suggested,
      filters: [{ name: format.toUpperCase(), extensions: [format] }],
    }),
  /** Stores a full-frame picture the editor drew — a title, or the
   * backdrop — where the renderer can overlay it. */
  writeOverlayImage: (name: string, bytes: number[]) =>
    invoke<string>("write_overlay_image", { name, bytes }),
  exportTimeline: (plan: ExportPlan) => invoke<string>("export_timeline", { plan }),
  /** Every transcription service, with whether a key has been entered and
   * which one is marked for use. The keys themselves never come back. */
  /** Where the mouse went during a recording, if it was followed. Null
   * for anything this app did not record. */
  cursorTrack: (path: string) => invoke<CursorTrack | null>("cursor_track", { path }),
  /** Whether the mouse can be followed on this machine at all. */
  canTrackCursor: () => invoke<boolean>("can_track_cursor"),
  speechEngines: () => invoke<SpeechEngine[]>("speech_engines"),
  /** Puts a key in for one service, or clears it when given nothing.
   * Answers with the list as it now stands. */
  saveSpeechKey: (engine: string, key: string) =>
    invoke<SpeechEngine[]>("save_speech_key", { engine, key }),
  chooseSpeechEngine: (engine: string) =>
    invoke<SpeechEngine[]>("choose_speech_engine", { engine }),
  /** Listens to the given clips and answers with captions. Long-running:
   * it reports its way through `caption-progress` events. */
  writeCaptions: (request: {
    jobs: {
      clipId: string;
      path: string;
      start: number;
      duration: number;
      trimStart: number;
      speed: number;
    }[];
    language: string;
    wordsPerCaption: number;
    engine: string;
  }) => invoke<CaptionSegment[]>("write_captions", { request }),
  cancelExport: () => invoke<void>("cancel_export"),
  revealFile: (path: string) => revealItemInDir(path),
};
