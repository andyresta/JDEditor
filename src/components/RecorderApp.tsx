import {
  Dispatch,
  SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { api } from "../api";
import { EditorShell } from "./EditorShell";
import { ExportDialog } from "./ExportDialog";
import {
  buildExportPlan,
  exportCanvas,
  renderTitles,
  timelineDuration,
} from "../export";
import { Launcher } from "./Launcher";
import { RecordingsList } from "./RecordingsList";
import {
  AudioPeaks,
  ClipLayout,
  DEFAULT_EXPORT_SETTINGS,
  ExportProgress,
  ExportSettings,
  DEFAULT_CLIP_SECONDS,
  DEFAULT_TEXT_SECONDS,
  DEFAULT_TEXT_STYLE,
  DEFAULT_EDITOR_SETTINGS,
  DeviceList,
  EditorSettings,
  FPS_OPTIONS,
  MediaItem,
  PROJECT_EXTENSION,
  ProjectFile,
  fromRelativeMediaPath,
  mediaFileName,
  toRelativeMediaPath,
  QUALITY_LABELS,
  QualityPreset,
  RecordingFile,
  TimelineClip,
  TextStyle,
  TimelineTrack,
  VolumePoint,
  mediaKindFor,
  newId,
  newTrack,
  placeOnTrack,
  removeLayoutAt,
  setLayoutAt,
  splitVolume,
  trackKindOf,
  toMillis,
  trimClip,
  trimLimit,
  withSoundOnlyClips,
  withTrackNames,
} from "../types";

/** Window size per screen. Must stay within the main window's minimum
 * size in `tauri.conf.json`, or the launcher can't shrink to fit. */
const VIEW_WINDOW_SIZE = {
  launcher: new LogicalSize(560, 420),
  recorder: new LogicalSize(520, 660),
};

/** What the recording will capture. "window" and "camera" are part of the
 * layout but not wired up to anything yet, so they stay disabled rather
 * than pretending to work. */
type CaptureMode = "display" | "window" | "area" | "camera";

const CAPTURE_MODES: {
  id: CaptureMode;
  label: string;
  icon: string;
  hint?: string;
}[] = [
  { id: "display", label: "Display", icon: "🖥" },
  { id: "window", label: "Window", icon: "🪟", hint: "Capturing a single window isn't wired up yet" },
  { id: "area", label: "Area", icon: "⛶" },
  { id: "camera", label: "Camera Only", icon: "📹", hint: "Camera-only recording isn't wired up yet" },
];

function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/** A media item as it starts life: on disk, not yet probed. */
function newMediaItem(path: string, name?: string): MediaItem {
  return {
    path,
    name: name ?? basename(path),
    kind: mediaKindFor(path),
    status: "preparing",
  };
}

/** What the user is asked when a project with unsaved work is about to be
 * put away. */
type PendingExit = "close" | "new" | "open" | null;

/** Fetches duration/resolution/thumbnail in the background and fills them
 * in once ready, flipping the matching media item out of "preparing". */
function preparePathAsync(
  path: string,
  setProjectMedia: Dispatch<SetStateAction<MediaItem[]>>,
) {
  api
    .pathExists(path)
    .then((there) => {
      if (!there) {
        // Said so plainly rather than left looking ready and playing
        // nothing, which is how a moved file used to go unnoticed.
        setProjectMedia((current) =>
          current.map((m) => (m.path === path ? { ...m, status: "missing" } : m)),
        );
        return Promise.reject(new Error("missing"));
      }
      return api.prepareMedia(path);
    })
    .then((info) => {
      setProjectMedia((current) =>
        current.map((m) =>
          m.path === path
            ? {
                ...m,
                status: "ready",
                durationSeconds: info.duration_seconds,
                width: info.width,
                height: info.height,
                frameRate: info.frame_rate,
                thumbnailPath: info.thumbnail_path,
              }
            : m,
        ),
      );
    })
    .catch(() => {
      // Metadata and a thumbnail are a nice-to-have; playback needs
      // neither, so a file that would not answer simply stops showing the
      // "preparing" spinner. A file that isn't there has already been
      // marked missing, and must keep that — saying "ready" about a file
      // nothing can open is exactly the quiet failure this set out to fix.
      setProjectMedia((current) =>
        current.map((m) =>
          m.path === path && m.status !== "missing" ? { ...m, status: "ready" } : m,
        ),
      );
    });
}

/** Everything an edit can change, and so everything undo has to put back.
 * The pieces are held by reference: every handler replaces them rather
 * than mutating them, so an old reference stays a true picture of the past
 * without any copying. */
interface ProjectState {
  media: MediaItem[];
  tracks: TimelineTrack[];
  activeMediaPath: string | null;
  settings: EditorSettings;
}

/** How long two edits of the same kind are treated as one for undo. A
 * volume line or a layer being dragged fires dozens of changes a second,
 * and undoing a drag a pixel at a time would be useless. */
const UNDO_COALESCE_MS = 900;

/** The loudness envelope of a file, as the timeline draws it. Derived
 * from the file itself, so it is never saved into the project — it is
 * read back whenever a project is opened. */
export type PeakMap = Map<string, AudioPeaks>;

export function RecorderApp() {
  const [devices, setDevices] = useState<DeviceList | null>(null);
  const [ffmpegAvailable, setFfmpegAvailable] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [screenId, setScreenId] = useState<string>("");
  const [includeWebcam, setIncludeWebcam] = useState(false);
  const [webcamId, setWebcamId] = useState<string>("");
  const [includeAudio, setIncludeAudio] = useState(false);
  const [audioId, setAudioId] = useState<string>("");
  const [quality, setQuality] = useState<QualityPreset>("medium");
  const [fps, setFps] = useState<number>(30);

  const [lastOutput, setLastOutput] = useState<string | null>(null);
  const [recordings, setRecordings] = useState<RecordingFile[]>([]);

  const [captureMode, setCaptureMode] = useState<CaptureMode>("display");
  const [startingRecorder, setStartingRecorder] = useState(false);
  const [deviceDebug, setDeviceDebug] = useState<string | null>(null);
  const [deviceDebugLoading, setDeviceDebugLoading] = useState(false);

  const [view, setView] = useState<"launcher" | "recorder" | "editor">("launcher");

  // The editor works on a project — a set of media plus how it's laid out
  // — which lives in a `.jd` file once saved.
  const [projectMedia, setProjectMedia] = useState<MediaItem[]>([]);
  const [activeMediaPath, setActiveMediaPath] = useState<string | null>(null);
  const [tracks, setTracks] = useState<TimelineTrack[]>(() => [newTrack("Track 1")]);
  const [audioPeaks, setAudioPeaks] = useState<PeakMap>(() => new Map());
  /** The clip on the clipboard. Held as state rather than in a ref so the
   * Paste entry can grey itself out until there is something to paste. */
  const [clipboard, setClipboard] = useState<TimelineClip | null>(null);

  // Exporting. `exportProgress` doubles as "a render is running": null
  // when nothing is, a fraction once ffmpeg reports where it has got to.
  const [exportOpen, setExportOpen] = useState(false);
  const [exportSettings, setExportSettings] = useState<ExportSettings>(
    DEFAULT_EXPORT_SETTINGS,
  );
  const [exportProgress, setExportProgress] = useState<number | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportedPath, setExportedPath] = useState<string | null>(null);
  /** Files already asked about, so a failed or empty answer isn't asked
   * for again on every render. */
  const peaksRequested = useRef<Set<string>>(new Set());
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [projectPath, setProjectPath] = useState<string | null>(null);
  const [projectName, setProjectName] = useState("Untitled project");
  const [editorSettings, setEditorSettings] = useState<EditorSettings>(
    DEFAULT_EDITOR_SETTINGS,
  );
  const [isDirty, setIsDirty] = useState(false);

  // Undo history. Each entry is the whole document as it stood *before* an
  // edit, which is simpler and far harder to get wrong than recording what
  // each edit did and how to invert it — a project is small enough that
  // copying a reference to each of its four pieces costs nothing.
  const undoStack = useRef<{ key: string; at: number; state: ProjectState }[]>([]);
  const redoStack = useRef<ProjectState[]>([]);
  // Only so the Undo/Redo controls can grey themselves out; the stacks
  // themselves live in refs because nothing else re-renders for them.
  const [historyDepth, setHistoryDepth] = useState({ undo: 0, redo: 0 });
  const [pendingExit, setPendingExit] = useState<PendingExit>(null);
  const [projectBusy, setProjectBusy] = useState(false);

  const refreshRecordings = useCallback(() => {
    api.listRecordings().then(setRecordings).catch(() => {});
  }, []);

  /** Switches into the editor immediately, showing `path` as a "preparing"
   * media item, so the editor appears at once instead of waiting on
   * ffprobe/ffmpeg to report the file's metadata and thumbnail first. */
  const openInEditor = useCallback((path: string, name?: string) => {
    const item = newMediaItem(path, name);

    setProjectMedia((current) => {
      // An open project gains the clip rather than being replaced by it —
      // replacing would throw away work that may not be saved yet.
      if (current.some((m) => m.path === path)) return current;
      return current.length > 0 ? [...current, item] : [item];
    });
    setActiveMediaPath(path);
    setProjectName((current) =>
      projectMedia.length > 0 ? current : (name ?? basename(path)),
    );
    // Either way this is project work with no `.jd` file behind it yet.
    setIsDirty(true);
    setView("editor");
    preparePathAsync(path, setProjectMedia);
  }, [projectMedia]);

  /* ------------------------------------------------------- undo history */

  const projectState = useCallback(
    (): ProjectState => ({
      media: projectMedia,
      tracks,
      activeMediaPath,
      settings: editorSettings,
    }),
    [projectMedia, tracks, activeMediaPath, editorSettings],
  );

  /** Records the document as it is *now*, before the caller changes it.
   *
   * `key` says what kind of edit is about to happen — "volume:clip-3",
   * "layout:clip-7". Two edits with the same key close together are one
   * step to undo, which is what turns a drag into a single entry instead
   * of one per pointer move. The first snapshot of the run is the one
   * kept, since that is what the drag started from. */
  const remember = useCallback(
    (key: string) => {
      const now = performance.now();
      const top = undoStack.current[undoStack.current.length - 1];
      if (top && top.key === key && now - top.at < UNDO_COALESCE_MS) {
        top.at = now;
      } else {
        undoStack.current.push({ key, at: now, state: projectState() });
        // Far more than anyone reaches back, and bounded so a long session
        // can't grow it without end.
        if (undoStack.current.length > 200) undoStack.current.shift();
      }
      // A fresh edit is a new branch: there is no longer anything to redo.
      redoStack.current = [];
      setHistoryDepth({ undo: undoStack.current.length, redo: 0 });
    },
    [projectState],
  );

  const applyState = useCallback((state: ProjectState) => {
    setProjectMedia(state.media);
    setTracks(state.tracks);
    setActiveMediaPath(state.activeMediaPath);
    setEditorSettings(state.settings);
    // A step back is still a change against what is on disk.
    setIsDirty(true);
    setSelectedClipId((current) =>
      state.tracks.some((track) => track.clips.some((clip) => clip.id === current))
        ? current
        : null,
    );
  }, []);

  const undo = useCallback(() => {
    const entry = undoStack.current.pop();
    if (!entry) return;
    redoStack.current.push(projectState());
    applyState(entry.state);
    setHistoryDepth({
      undo: undoStack.current.length,
      redo: redoStack.current.length,
    });
  }, [projectState, applyState]);

  const redo = useCallback(() => {
    const state = redoStack.current.pop();
    if (!state) return;
    // Pushed with a key of its own so the next edit can't be coalesced
    // into the step a redo just replayed.
    undoStack.current.push({ key: "redo", at: performance.now(), state: projectState() });
    applyState(state);
    setHistoryDepth({
      undo: undoStack.current.length,
      redo: redoStack.current.length,
    });
  }, [projectState, applyState]);

  /** Starting or opening a project begins a new history: the steps that
   * built the last one would put back a document this one never had. */
  const clearHistory = useCallback(() => {
    undoStack.current = [];
    redoStack.current = [];
    setHistoryDepth({ undo: 0, redo: 0 });
  }, []);

  /** Builds the document written into a `.jd` file. Only what can't be
   * recomputed goes in: durations and thumbnails are read back off disk
   * when the project is opened again. */
  const projectDocument = useCallback(
    (name: string, savePath: string): ProjectFile => ({
      format: "jdeditor-project",
      version: 1,
      name,
      // Alongside where each file was, where it sits beneath the project's
      // own folder when it does — so a project and its footage can be
      // moved together and still find each other.
      media: projectMedia.map((m) => ({
        path: m.path,
        name: m.name,
        // Against where it is being saved to, not where it was last
        // saved: "Save as" into another folder has to recompute these.
        relative: toRelativeMediaPath(m.path, savePath),
      })),
      tracks,
      activeMediaPath,
      settings: editorSettings,
    }),
    [projectMedia, tracks, activeMediaPath, editorSettings],
  );

  /** Writes the project, asking where to put it when it has no file yet
   * (or when Save As was chosen). Resolves true once it's on disk. */
  const saveProject = useCallback(
    async (forcePrompt = false): Promise<boolean> => {
      setError(null);
      setProjectBusy(true);
      try {
        let target = forcePrompt ? null : projectPath;
        if (!target) {
          target = await api.pickProjectSavePath(`${projectName}.${PROJECT_EXTENSION}`);
          if (!target) return false;
        }

        const name = basename(target).replace(/\.jd$/i, "");
        const written = await api.saveProject(
          target,
          JSON.stringify(projectDocument(name, target), null, 2),
        );
        setProjectPath(written);
        setProjectName(name);
        setIsDirty(false);
        return true;
      } catch (e) {
        setError(String(e));
        return false;
      } finally {
        setProjectBusy(false);
      }
    },
    [projectPath, projectName, projectDocument],
  );

  /** Replaces whatever is loaded with a project from disk. */
  const loadProjectFrom = useCallback(async (path: string) => {
    setError(null);
    setProjectBusy(true);
    try {
      const parsed: ProjectFile = JSON.parse(await api.loadProject(path));
      if (parsed.format !== "jdeditor-project") {
        throw new Error("That file isn't a JDEditor project.");
      }

      // Each file is looked for where it sits beneath this project first,
      // and only then where it was when the project was saved. That is
      // what lets a project and its footage be moved together.
      const entries = parsed.media ?? [];
      const found = await Promise.all(
        entries.map(async (entry) => {
          const tries = entry.relative
            ? [fromRelativeMediaPath(entry.relative, path), entry.path]
            : [entry.path];
          for (const candidate of tries) {
            if (await api.pathExists(candidate)) {
              return { entry, at: candidate, there: true };
            }
          }
          return { entry, at: entry.path, there: false };
        }),
      );

      // A file found somewhere new has to be pointed at from the clips as
      // well, or they would keep asking for a path nothing answers to.
      const moved = new Map(
        found
          .filter((f) => f.at !== f.entry.path)
          .map((f) => [f.entry.path, f.at] as const),
      );

      const items = found.map((f) => ({
        ...newMediaItem(f.at, f.entry.name),
        status: f.there ? ("preparing" as const) : ("missing" as const),
      }));
      setProjectMedia(items);
      // Projects saved before the timeline existed have no tracks; give
      // them an empty one to drag media onto rather than nothing at all.
      setTracks(
        withTrackNames(
          withSoundOnlyClips(
            (parsed.tracks?.length ? parsed.tracks : [newTrack("Track 1")]).map(
              (track) => ({
                ...track,
                clips: track.clips.map((clip) =>
                  moved.has(clip.mediaPath)
                    ? { ...clip, mediaPath: moved.get(clip.mediaPath)! }
                    : clip,
                ),
              }),
            ),
          ),
        ),
      );
      setSelectedClipId(null);
      const active = parsed.activeMediaPath;
      setActiveMediaPath(
        (active && (moved.get(active) ?? active)) ?? items[0]?.path ?? null,
      );
      setEditorSettings({ ...DEFAULT_EDITOR_SETTINGS, ...(parsed.settings ?? {}) });
      setProjectPath(path);
      setProjectName(parsed.name || basename(path).replace(/\.jd$/i, ""));
      setIsDirty(false);
      clearHistory();
      setView("editor");
      items
        .filter((m) => m.status !== "missing")
        .forEach((m) => preparePathAsync(m.path, setProjectMedia));
    } catch (e) {
      setError(String(e));
    } finally {
      setProjectBusy(false);
    }
  }, [clearHistory]);

  const startEmptyProject = useCallback(() => {
    setProjectMedia([]);
    setTracks([newTrack("Track 1")]);
    setSelectedClipId(null);
    setActiveMediaPath(null);
    setProjectPath(null);
    setProjectName("Untitled project");
    setEditorSettings(DEFAULT_EDITOR_SETTINGS);
    setIsDirty(false);
    clearHistory();
  }, [clearHistory]);

  useEffect(() => {
    api
      .checkFfmpeg()
      .then(setFfmpegAvailable)
      .catch(() => setFfmpegAvailable(false));

    api
      .listDevices()
      .then((list) => {
        setDevices(list);
        const primary = list.screens.find((s) => s.is_primary) ?? list.screens[0];
        if (primary) setScreenId(primary.id);
        if (list.webcams[0]) setWebcamId(list.webcams[0].id);
        if (list.audio_inputs[0]) setAudioId(list.audio_inputs[0].id);
      })
      .catch((e) => setError(String(e)));

    refreshRecordings();
  }, [refreshRecordings]);

  // Recording itself is driven by the floating bar, in its own window; it
  // reports the finished file back here so the editor can open it.
  useEffect(() => {
    const pending = listen<{ path: string }>("recording-finished", (event) => {
      const path = event.payload.path;
      setLastOutput(path);
      refreshRecordings();
      openInEditor(path);
    });
    return () => {
      pending.then((unlisten) => unlisten());
    };
  }, [refreshRecordings, openInEditor]);

  // Each screen gets the window it needs: the launcher is two buttons, the
  // recorder has a column of settings panels, and the editor fills the
  // display.
  useEffect(() => {
    const win = getCurrentWindow();
    const fit = async () => {
      if (view === "editor") {
        await win.maximize();
        return;
      }
      await win.unmaximize();
      await win.setSize(VIEW_WINDOW_SIZE[view]);
      await win.center();
    };
    fit().catch(() => {});
  }, [view]);

  /** Hands these settings to the floating bar, which takes it from here:
   * picking the area, recording, pausing and stopping. This window steps
   * aside until the bar is done with it. */
  async function handleStartRecording() {
    setError(null);
    if (!screenId) {
      setError("Select a screen to record.");
      return;
    }
    if (includeWebcam && !webcamId) {
      setError("Select a webcam, or turn off webcam recording.");
      return;
    }
    if (includeAudio && !audioId) {
      setError("Select an audio source, or turn off audio recording.");
      return;
    }

    setStartingRecorder(true);
    try {
      await api.openRecorderBar({
        config: {
          screen_id: screenId,
          area: null,
          include_webcam: includeWebcam,
          webcam_id: includeWebcam ? webcamId : null,
          include_audio: includeAudio,
          audio_id: includeAudio ? audioId : null,
          quality,
          fps,
          output_dir: null,
        },
        // Area capture drags out a region in the bar first; Display goes
        // straight to being ready to record the whole screen.
        pick_area: captureMode === "area",
      });
    } catch (e) {
      setError(String(e));
    } finally {
      setStartingRecorder(false);
    }
  }

  async function handleShowDeviceDebug() {
    setDeviceDebugLoading(true);
    try {
      setDeviceDebug(await api.debugDeviceScan());
    } catch (e) {
      setDeviceDebug(String(e));
    } finally {
      setDeviceDebugLoading(false);
    }
  }

  async function handleDelete(path: string) {
    try {
      await api.deleteRecording(path);
      refreshRecordings();
    } catch (e) {
      setError(String(e));
    }
  }

  async function handleImportMedia(kind: "visual" | "audio") {
    const picked = await api.pickMediaFiles(kind);
    if (!picked || picked.length === 0) return;
    const existingPaths = new Set(projectMedia.map((m) => m.path));
    const newPaths = picked.filter((p) => !existingPaths.has(p));
    if (newPaths.length === 0) return;

    remember("import");
    setProjectMedia((current) => [...current, ...newPaths.map((p) => newMediaItem(p))]);
    setActiveMediaPath((current) => current ?? newPaths[0]);
    setIsDirty(true);
    newPaths.forEach((p) => preparePathAsync(p, setProjectMedia));
  }

  function handleRemoveMedia(path: string) {
    remember("remove-media");
    setProjectMedia((current) => current.filter((m) => m.path !== path));
    // Anything placed on the timeline from this file goes with it, or the
    // tracks would keep clips pointing at media the project no longer has.
    setTracks((current) =>
      current.map((track) => ({
        ...track,
        clips: track.clips.filter((clip) => clip.mediaPath !== path),
      })),
    );
    setActiveMediaPath((current) =>
      current === path
        ? (projectMedia.find((m) => m.path !== path)?.path ?? null)
        : current,
    );
    setIsDirty(true);
  }

  function handleSettingsChange(next: EditorSettings) {
    // Zoom is how the timeline is being looked at, not part of the edit;
    // putting it in the history would make Ctrl+Z undo a zoom before it
    // undid the change the user was actually zooming in to make.
    const sameButForZoom = { ...next, timelineZoom: editorSettings.timelineZoom };
    if (JSON.stringify(sameButForZoom) !== JSON.stringify(editorSettings)) {
      remember("settings");
    }
    setEditorSettings(next);
    setIsDirty(true);
  }

  function handleAddTrack() {
    remember("add-track");
    setTracks((current) => withTrackNames([...current, newTrack("Track")]));
    setIsDirty(true);
  }

  /** How tall one track's row is drawn, as dragged on its name column. */
  function handleResizeTrack(trackId: string, height: number | undefined) {
    remember(`track-height:${trackId}`);
    setTracks((current) =>
      current.map((track) =>
        track.id === trackId ? { ...track, height } : track,
      ),
    );
    setIsDirty(true);
  }

  /** Cuts clips in two at a moment on the timeline. Passing a clip id cuts
   * that one; passing none cuts every clip the playhead runs through, so a
   * picture and the sound split off it stay lined up.
   *
   * The second half starts partway into the same file rather than copying
   * it, and the volume line is divided along with the clip. */
  function handleCutAt(atSeconds: number, clipId?: string): number {
    // Worked out against the current tracks rather than inside a state
    // updater, because the caller is told how many clips were cut and a
    // count set inside an updater wouldn't be known yet — nor be counted
    // only once.
    let cuts = 0;
    const next = tracks.map((track) => {
      const clips: TimelineClip[] = [];
      for (const clip of track.clips) {
        const offset = atSeconds - clip.startSeconds;
        // Too close to either end and one of the halves would be empty.
        const splittable =
          (clipId == null || clip.id === clipId) &&
          offset > 0.05 &&
          offset < clip.durationSeconds - 0.05;
        if (!splittable) {
          clips.push(clip);
          continue;
        }

        const [before, after] = splitVolume(clip.volume, offset);
        clips.push({ ...clip, durationSeconds: toMillis(offset), volume: before });
        clips.push({
          ...clip,
          id: newId("clip"),
          startSeconds: toMillis(atSeconds),
          durationSeconds: toMillis(clip.durationSeconds - offset),
          trimStartSeconds: toMillis((clip.trimStartSeconds ?? 0) + offset),
          volume: after,
        });
        cuts += 1;
      }
      return clips.length === track.clips.length ? track : { ...track, clips };
    });

    if (cuts === 0) return 0;
    remember("cut");
    setTracks(next);
    setIsDirty(true);
    return cuts;
  }

  /** The clip's volume line, as dragged on the timeline. Passing nothing
   * puts it back to a flat full-volume line. */
  function handleUpdateClipVolume(clipId: string, points: VolumePoint[] | undefined) {
    remember(`volume:${clipId}`);
    setTracks((current) =>
      current.map((track) => ({
        ...track,
        clips: track.clips.map((clip) =>
          clip.id === clipId ? { ...clip, volume: points } : clip,
        ),
      })),
    );
    setIsDirty(true);
  }

  /** Puts a copy of a clip on the clipboard. Everything about it travels —
   * where it reads from in its file, its volume line, whether it is muted
   * — except its identity, which the paste gives it anew. */
  function handleCopyClip(clipId: string) {
    const found = tracks.flatMap((track) => track.clips).find((c) => c.id === clipId);
    if (found) setClipboard(found);
  }

  /** Drops what is on the clipboard onto a track at a moment, over
   * whatever is already there — the same rule as dragging one in. */
  function handlePasteClip(trackId: string, seconds: number) {
    if (!clipboard) return;
    remember("paste");
    const pasted: TimelineClip = {
      ...clipboard,
      id: newId("clip"),
      startSeconds: toMillis(Math.max(0, seconds)),
    };
    setTracks((current) =>
      current.map((track) =>
        track.id === trackId
          ? { ...track, clips: placeOnTrack(track.clips, pasted) }
          : track,
      ),
    );
    setSelectedClipId(pasted.id);
    setIsDirty(true);
  }

  /** A second copy of a clip, laid down directly after the original. */
  function handleDuplicateClip(clipId: string) {
    const track = tracks.find((t) => t.clips.some((c) => c.id === clipId));
    const source = track?.clips.find((c) => c.id === clipId);
    if (!track || !source) return;
    remember("duplicate");
    const copy: TimelineClip = {
      ...source,
      id: newId("clip"),
      startSeconds: toMillis(source.startSeconds + source.durationSeconds),
    };
    setTracks((current) =>
      current.map((t) =>
        t.id === track.id ? { ...t, clips: placeOnTrack(t.clips, copy) } : t,
      ),
    );
    setSelectedClipId(copy.id);
    setIsDirty(true);
  }

  /** Moves one edge of a clip to a moment on the timeline.
   *
   * Given where the edge should land rather than how far it moved, so that
   * the dozens of calls a single drag makes all describe the same thing
   * and asking twice means the same as asking once. Everything that
   * depends on the edges — where the clip reads from in its file, how long
   * it runs, where its volume line sits — is brought along by `trimClip`,
   * which also refuses to go past what the file can supply. */
  function handleTrimClip(clipId: string, edge: "start" | "end", seconds: number) {
    remember(`trim:${clipId}`);
    setTracks((current) =>
      current.map((track) => {
        if (!track.clips.some((clip) => clip.id === clipId)) return track;
        return {
          ...track,
          clips: track.clips.map((clip) => {
            if (clip.id !== clipId) return clip;
            // Held back at whatever is beside it on the same track: an
            // edge being nudged should never quietly swallow its
            // neighbour.
            const limit = trimLimit(track.clips, clip, edge);
            const held =
              edge === "start"
                ? Math.max(seconds, limit)
                : Math.min(seconds, limit);
            return trimClip(
              clip,
              edge,
              held,
              projectMedia.find((item) => item.path === clip.mediaPath)
                ?.durationSeconds,
            );
          }),
        };
      }),
    );
    setIsDirty(true);
  }

  /** Silences one clip, or brings it back. */
  function handleToggleClipMute(clipId: string) {
    remember("mute");
    setTracks((current) =>
      current.map((track) => ({
        ...track,
        clips: track.clips.map((clip) =>
          clip.id === clipId ? { ...clip, muted: !clip.muted } : clip,
        ),
      })),
    );
    setIsDirty(true);
  }

  /** Lifts a clip's sound onto its track's own audio track, creating that
   * track the first time — Track 2's sound goes to "Audio 2", directly
   * below it. The picture keeps playing where it was, silently, and the
   * sound becomes a clip that can be moved, muted or deleted on its own. */
  function handleSplitClipAudio(clipId: string) {
    remember("split-audio");
    setTracks((current) => {
      const index = current.findIndex((track) =>
        track.clips.some((clip) => clip.id === clipId),
      );
      if (index < 0) return current;

      const source = current[index];
      const clip = source.clips.find((c) => c.id === clipId);
      // Sound can only be split off a picture, and only once.
      if (!clip || trackKindOf(source) !== "video" || clip.audioDetached) {
        return current;
      }

      const detached: TimelineClip = {
        id: newId("clip"),
        mediaPath: clip.mediaPath,
        startSeconds: clip.startSeconds,
        durationSeconds: clip.durationSeconds,
        // Sound wherever it goes, even if it is later moved onto a video
        // track: it points at a video file, and only this says why.
        soundOnly: true,
      };

      const next = current.map((track) =>
        track.id === source.id
          ? {
              ...track,
              clips: track.clips.map((c) =>
                c.id === clipId ? { ...c, audioDetached: true } : c,
              ),
            }
          : track,
      );

      const paired = next.findIndex(
        (track) => trackKindOf(track) === "audio" && track.sourceTrackId === source.id,
      );
      if (paired >= 0) {
        next[paired] = { ...next[paired], clips: [...next[paired].clips, detached] };
      } else {
        next.splice(index + 1, 0, {
          ...newTrack("Audio", "audio"),
          sourceTrackId: source.id,
          clips: [detached],
        });
      }
      // Catches audio tracks made before the flag existed, so a project
      // already open doesn't have to be reloaded to behave.
      return withTrackNames(withSoundOnlyClips(next));
    });
    setSelectedClipId(clipId);
    setIsDirty(true);
  }

  /** Places a piece of the media pool onto a track. The same file can be
   * placed more than once, so each placement gets its own id. */
  function handleAddClip(trackId: string, mediaPath: string, startSeconds: number) {
    const source = projectMedia.find((m) => m.path === mediaPath);
    if (!source) return;

    remember("add-clip");
    const clip = {
      id: newId("clip"),
      mediaPath,
      // Kept to the millisecond like every other clip time, so a dropped
      // clip doesn't land at 8.414089721254356 seconds.
      startSeconds: toMillis(Math.max(0, startSeconds)),
      // Stills have no duration of their own, and a video still being
      // probed doesn't have one yet.
      durationSeconds: toMillis(source.durationSeconds ?? DEFAULT_CLIP_SECONDS),
    };

    setTracks((current) =>
      current.map((track) =>
        track.id === trackId
          ? { ...track, clips: placeOnTrack(track.clips, clip) }
          : track,
      ),
    );
    setSelectedClipId(clip.id);
    setIsDirty(true);
  }

  function handleMoveClip(clipId: string, trackId: string, startSeconds: number) {
    remember("move-clip");
    setTracks((current) => {
      const moving = current
        .flatMap((track) => track.clips)
        .find((clip) => clip.id === clipId);
      if (!moving) return current;

      const placed = { ...moving, startSeconds: toMillis(Math.max(0, startSeconds)) };
      return current.map((track) => ({
        ...track,
        clips:
          track.id === trackId
            ? placeOnTrack(track.clips, placed)
            : track.clips.filter((c) => c.id !== clipId),
      }));
    });
    setIsDirty(true);
  }

  /** Where a clip sits in the preview frame — dragged and resized on the
   * stage, and part of the project, so reopening the `.jd` file brings the
   * overlays back where they were put. */
  function handleUpdateClipLayout(
    clipId: string,
    layout: ClipLayout,
    atSeconds: number,
  ) {
    remember(`layout:${clipId}`);
    setTracks((current) =>
      current.map((track) => ({
        ...track,
        clips: track.clips.map((clip) => {
          if (clip.id !== clipId) return clip;
          // A clip that has been given zoom points is being animated, so
          // the gesture holds a framing at the moment shown rather than
          // moving the clip as a whole.
          return clip.layoutPoints?.length
            ? setLayoutAt(clip, atSeconds, layout)
            : { ...clip, layout };
        }),
      })),
    );
    setIsDirty(true);
  }

  /** Points a project at a file that has moved.
   *
   * Whatever else went missing is looked for beside it, because footage
   * usually travels as a folder: relinking one file of twenty and being
   * asked nineteen more times would be a poor way to spend an afternoon.
   */
  async function handleRelinkMedia(oldPath: string) {
    const item = projectMedia.find((m) => m.path === oldPath);
    const picked = await api.pickMediaFile(item?.name ?? mediaFileName(oldPath));
    if (!picked) return;

    const folder = picked.split(/[\/]/).slice(0, -1).join("/");
    const others = projectMedia.filter(
      (m) => m.status === "missing" && m.path !== oldPath,
    );
    const alongside = await Promise.all(
      others.map(async (m) => {
        const beside = `${folder}/${mediaFileName(m.path)}`;
        return (await api.pathExists(beside)) ? ([m.path, beside] as const) : null;
      }),
    );

    const moved = new Map<string, string>([[oldPath, picked]]);
    for (const pair of alongside) if (pair) moved.set(pair[0], pair[1]);

    remember("relink");
    setProjectMedia((current) =>
      current.map((m) =>
        moved.has(m.path)
          ? { ...newMediaItem(moved.get(m.path)!, m.name), status: "preparing" }
          : m,
      ),
    );
    setTracks((current) =>
      current.map((track) => ({
        ...track,
        clips: track.clips.map((clip) =>
          moved.has(clip.mediaPath)
            ? { ...clip, mediaPath: moved.get(clip.mediaPath)! }
            : clip,
        ),
      })),
    );
    setActiveMediaPath((current) =>
      current && moved.has(current) ? moved.get(current)! : current,
    );
    for (const to of moved.values()) preparePathAsync(to, setProjectMedia);
    setIsDirty(true);
  }

  /** Puts a title on a track at a moment. It has no file behind it — the
   * words are the clip — so `mediaPath` stays empty and everything that
   * looks up media lets it by. */
  function handleAddTextClip(trackId: string, atSeconds: number) {
    remember("add-text");
    const clip: TimelineClip = {
      id: newId("clip"),
      mediaPath: "",
      startSeconds: toMillis(Math.max(0, atSeconds)),
      durationSeconds: DEFAULT_TEXT_SECONDS,
      text: { ...DEFAULT_TEXT_STYLE },
    };
    setTracks((current) =>
      current.map((track) =>
        track.id === trackId
          ? { ...track, clips: placeOnTrack(track.clips, clip) }
          : track,
      ),
    );
    setSelectedClipId(clip.id);
    setIsDirty(true);
  }

  function handleUpdateText(clipId: string, text: TextStyle) {
    remember(`text:${clipId}`);
    setTracks((current) =>
      current.map((track) => ({
        ...track,
        clips: track.clips.map((clip) =>
          clip.id === clipId ? { ...clip, text } : clip,
        ),
      })),
    );
    setIsDirty(true);
  }

  /** Holds the framing shown right now as a zoom point, so the picture
   * travels to or from it. */
  function handleAddLayoutPoint(clipId: string, atSeconds: number, layout: ClipLayout) {
    remember("zoom-point");
    setTracks((current) =>
      current.map((track) => ({
        ...track,
        clips: track.clips.map((clip) =>
          clip.id === clipId ? setLayoutAt(clip, atSeconds, layout) : clip,
        ),
      })),
    );
    setIsDirty(true);
  }

  function handleRemoveLayoutPoint(clipId: string, atSeconds: number) {
    remember("zoom-point");
    setTracks((current) =>
      current.map((track) => ({
        ...track,
        clips: track.clips.map((clip) =>
          clip.id === clipId ? removeLayoutAt(clip, atSeconds) : clip,
        ),
      })),
    );
    setIsDirty(true);
  }

  function handleRemoveClip(clipId: string) {
    remember("remove-clip");
    setTracks((current) =>
      current.map((track) => ({
        ...track,
        clips: track.clips.filter((clip) => clip.id !== clipId),
      })),
    );
    setSelectedClipId((current) => (current === clipId ? null : current));
    setIsDirty(true);
  }

  // The waveform on the timeline. Read once per file, in the background,
  // and kept only in memory: it is derived from the file, so a project
  // never carries it and reopening one reads it again.
  useEffect(() => {
    for (const item of projectMedia) {
      if (item.status !== "ready" || item.kind === "image") continue;
      if (peaksRequested.current.has(item.path)) continue;
      peaksRequested.current.add(item.path);

      const path = item.path;
      api
        .audioPeaks(path)
        .then((result) => {
          setAudioPeaks((current) => new Map(current).set(path, result));
        })
        .catch(() => {
          // A file with no audio, or one ffmpeg couldn't read: the
          // timeline simply draws no waveform for it.
        });
    }
  }, [projectMedia]);

  // ffmpeg reports its position as it goes; this is what moves the bar.
  useEffect(() => {
    const pending = listen<ExportProgress>("export-progress", (event) => {
      setExportProgress(event.payload.fraction);
    });
    return () => {
      pending.then((unlisten) => unlisten());
    };
  }, []);

  async function handleExport() {
    setExportError(null);
    const suggested = `${projectName}.${exportSettings.format}`;
    const target = await api.pickExportPath(suggested, exportSettings.format);
    if (!target) return;

    const canvas = exportCanvas(projectMedia, exportSettings.resolution);
    let titles: Map<string, string>;
    try {
      // Drawn before the plan is built, because the plan needs to know
      // where each one landed.
      titles = await renderTitles(tracks, canvas.width, canvas.height);
    } catch (e) {
      setExportError(String(e).replace(/^Error:\s*/, ""));
      return;
    }

    const built = buildExportPlan(
      tracks,
      projectMedia,
      exportSettings,
      target,
      titles,
    );
    if ("error" in built) {
      setExportError(built.error);
      return;
    }

    setExportedPath(null);
    setExportProgress(0);
    try {
      const written = await api.exportTimeline(built.plan);
      setExportedPath(written);
    } catch (e) {
      // A render stopped by hand isn't a failure worth shouting about.
      const message = String(e);
      setExportError(
        message.includes("cancelled") ? null : message.replace(/^Error:\s*/, ""),
      );
    } finally {
      setExportProgress(null);
    }
  }

  function handleCancelExport() {
    void api.cancelExport();
  }

  /** Project actions all funnel through here so unsaved work can't be
   * dropped silently: anything that would discard it asks first. */
  function guardUnsaved(action: Exclude<PendingExit, null>) {
    if (isDirty) {
      setPendingExit(action);
      return;
    }
    void runExitAction(action);
  }

  async function runExitAction(action: Exclude<PendingExit, null>) {
    setPendingExit(null);
    if (action === "close") {
      startEmptyProject();
      setView("launcher");
      return;
    }
    if (action === "new") {
      startEmptyProject();
      return;
    }
    const picked = await api.pickProjectFile();
    if (picked) await loadProjectFrom(picked);
  }

  /** "Save" in the unsaved-changes prompt: store the project first, then
   * carry on with whatever was being done — unless saving was cancelled. */
  async function handleSaveThenExit() {
    const action = pendingExit;
    if (!action) return;
    if (await saveProject()) await runExitAction(action);
  }

  if (view === "editor") {
    return (
      <>
        <EditorShell
          media={projectMedia}
          activeMediaPath={activeMediaPath}
          projectName={projectName}
          isDirty={isDirty}
          settings={editorSettings}
          tracks={tracks}
          selectedClipId={selectedClipId}
          onSettingsChange={handleSettingsChange}
          onSelectClip={setSelectedClipId}
          onAddTrack={handleAddTrack}
          onAddClip={handleAddClip}
          onMoveClip={handleMoveClip}
          onRemoveClip={handleRemoveClip}
          onUpdateClipLayout={handleUpdateClipLayout}
          onAddLayoutPoint={handleAddLayoutPoint}
          onAddTextClip={handleAddTextClip}
          onUpdateText={handleUpdateText}
          onRemoveLayoutPoint={handleRemoveLayoutPoint}
          onToggleClipMute={handleToggleClipMute}
          onUpdateClipVolume={handleUpdateClipVolume}
          audioPeaks={audioPeaks}
          onExport={() => {
            setExportError(null);
            setExportedPath(null);
            setExportOpen(true);
          }}
          canUndo={historyDepth.undo > 0}
          canRedo={historyDepth.redo > 0}
          onUndo={undo}
          onRedo={redo}
          clipboardHasClip={clipboard !== null}
          onCopyClip={handleCopyClip}
          onPasteClip={handlePasteClip}
          onDuplicateClip={handleDuplicateClip}
          onTrimClip={handleTrimClip}
          onResizeTrack={handleResizeTrack}
          onCutAt={handleCutAt}
          onSplitClipAudio={handleSplitClipAudio}
          onSelectMedia={setActiveMediaPath}
          onImportMedia={handleImportMedia}
          onRemoveMedia={handleRemoveMedia}
          onRelinkMedia={(path) => void handleRelinkMedia(path)}
          onNewProject={() => guardUnsaved("new")}
          onOpenProject={() => guardUnsaved("open")}
          onSaveProject={() => void saveProject()}
          onSaveProjectAs={() => void saveProject(true)}
          onCloseProject={() => guardUnsaved("close")}
        />

        {exportOpen && (
          <ExportDialog
            settings={exportSettings}
            seconds={timelineDuration(tracks)}
            width={exportCanvas(projectMedia, exportSettings.resolution).width}
            height={exportCanvas(projectMedia, exportSettings.resolution).height}
            progress={exportProgress}
            error={exportError}
            finishedPath={exportedPath}
            onChange={setExportSettings}
            onExport={() => void handleExport()}
            onCancel={handleCancelExport}
            onReveal={(path) => void api.revealFile(path)}
            onClose={() => setExportOpen(false)}
          />
        )}

        {error && (
          <div className="project-error" role="alert">
            {error}
            <button className="link-button" onClick={() => setError(null)}>
              Dismiss
            </button>
          </div>
        )}

        {pendingExit && (
          <div className="project-modal-backdrop">
            <div className="project-modal" role="dialog" aria-modal="true">
              <h2>Save this project?</h2>
              <p>
                &ldquo;{projectName}&rdquo; has changes that aren't saved to a
                .{PROJECT_EXTENSION} file yet.
              </p>
              <div className="project-modal-actions">
                <button
                  className="project-modal-primary"
                  onClick={handleSaveThenExit}
                  disabled={projectBusy}
                >
                  {projectBusy ? "Saving…" : "Save"}
                </button>
                <button
                  onClick={() => void runExitAction(pendingExit)}
                  disabled={projectBusy}
                >
                  Don't save
                </button>
                <button onClick={() => setPendingExit(null)} disabled={projectBusy}>
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}
      </>
    );
  }

  if (view === "launcher") {
    return (
      <Launcher
        onSelectRecord={() => setView("recorder")}
        onSelectEditor={() => setView("editor")}
      />
    );
  }

  if (ffmpegAvailable === false) {
    return (
      <main className="container">
        <button className="link-button back-link" onClick={() => setView("launcher")}>
          &larr; Back
        </button>
        <h1>JDEditor</h1>
        <div className="banner banner-error">
          <p>
            <strong>ffmpeg was not found.</strong> JDEditor uses ffmpeg to capture
            your screen, webcam and audio. Install it and restart the app:
          </p>
          <ul>
            <li>
              <strong>Windows:</strong> <code>winget install ffmpeg</code> (or download
              from ffmpeg.org and add it to PATH)
            </li>
            <li>
              <strong>macOS:</strong> <code>brew install ffmpeg</code>
            </li>
            <li>
              <strong>Linux:</strong> <code>sudo apt install ffmpeg</code> (or your
              distro's package manager)
            </li>
          </ul>
        </div>
      </main>
    );
  }

  return (
    <main className="capture-window">
      <header className="capture-titlebar">
        <button
          className="capture-icon-button"
          onClick={() => setView("launcher")}
          title="Back"
        >
          ‹
        </button>
        <span className="capture-titlebar-spacer" />
        <button
          className="capture-icon-button"
          onClick={handleShowDeviceDebug}
          disabled={deviceDebugLoading}
          title="Show capture device diagnostics"
        >
          {deviceDebugLoading ? "…" : "⚙"}
        </button>
      </header>

      <div className="capture-brand">
        <span className="capture-logo" />
        <span className="capture-name">JDEditor</span>
        <span className="capture-badge">Local</span>
        <div className="capture-switch">
          <span className="capture-switch-option selected" title="Record">
            ⏺
          </span>
          <button
            className="capture-switch-option"
            onClick={() => setView("editor")}
            title="Open the editor"
          >
            🎬
          </button>
        </div>
      </div>

      {error && <div className="capture-error">{error}</div>}

      <div className="capture-grid">
        {CAPTURE_MODES.map((mode) => (
          <button
            key={mode.id}
            className={`capture-mode ${captureMode === mode.id ? "selected" : ""}`}
            onClick={() => setCaptureMode(mode.id)}
            disabled={Boolean(mode.hint)}
            title={mode.hint}
          >
            <span className="capture-mode-icon">{mode.icon}</span>
            <span className="capture-mode-label">{mode.label}</span>
          </button>
        ))}
      </div>

      <ul className="capture-devices">
        {(devices?.screens.length ?? 0) > 1 && (
          <li className="capture-row">
            <span className="capture-row-icon">🖥</span>
            <select
              className="capture-row-select"
              value={screenId}
              onChange={(e) => setScreenId(e.target.value)}
            >
              {devices?.screens.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.width}×{s.height})
                  {s.is_primary ? " · Primary" : ""}
                </option>
              ))}
            </select>
            <span className="capture-toggle capture-toggle-static">On</span>
          </li>
        )}

        <li className="capture-row">
          <span className="capture-row-icon">📹</span>
          {devices?.webcams.length ? (
            <select
              className="capture-row-select"
              value={webcamId}
              disabled={!includeWebcam}
              onChange={(e) => setWebcamId(e.target.value)}
            >
              {devices.webcams.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          ) : (
            <span className="capture-row-empty">No camera found</span>
          )}
          <button
            className={`capture-toggle ${includeWebcam ? "on" : ""}`}
            onClick={() => setIncludeWebcam((on) => !on)}
            disabled={!devices?.webcams.length}
          >
            {includeWebcam ? "On" : "Off"}
          </button>
        </li>

        <li className="capture-row">
          <span className="capture-row-icon">🎤</span>
          {devices?.audio_inputs.length ? (
            <select
              className="capture-row-select"
              value={audioId}
              disabled={!includeAudio}
              onChange={(e) => setAudioId(e.target.value)}
            >
              {devices.audio_inputs.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          ) : (
            <span className="capture-row-empty">No microphone found</span>
          )}
          <button
            className={`capture-toggle ${includeAudio ? "on" : ""}`}
            onClick={() => setIncludeAudio((on) => !on)}
            disabled={!devices?.audio_inputs.length}
          >
            {includeAudio ? "On" : "Off"}
          </button>
        </li>

        <li className="capture-row">
          <span className="capture-row-icon">🔊</span>
          <span className="capture-row-empty">Record System Audio</span>
          <span
            className="capture-toggle capture-toggle-static"
            title="Capturing system audio isn't wired up yet"
          >
            Off
          </span>
        </li>
      </ul>

      {deviceDebug && <pre className="debug-output">{deviceDebug}</pre>}

      <div className="capture-settings">
        <label>
          Quality
          <select
            value={quality}
            onChange={(e) => setQuality(e.target.value as QualityPreset)}
          >
            {Object.entries(QUALITY_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Frame rate
          <select value={fps} onChange={(e) => setFps(Number(e.target.value))}>
            {FPS_OPTIONS.map((f) => (
              <option key={f} value={f}>
                {f} fps
              </option>
            ))}
          </select>
        </label>
      </div>

      <button
        className="capture-start"
        onClick={handleStartRecording}
        disabled={startingRecorder}
      >
        {startingRecorder
          ? "Opening recorder…"
          : captureMode === "area"
            ? "Start — pick an area"
            : "Start Recording"}
      </button>

      <p className="capture-hint">
        {lastOutput
          ? `Saved: ${lastOutput}`
          : "The controls move to a small bar at the bottom of the screen."}
      </p>

      {recordings.length > 0 && (
        <details className="capture-recordings">
          <summary>Recent recordings ({recordings.length})</summary>
          <RecordingsList
            recordings={recordings}
            onOpen={(path, name) => openInEditor(path, name)}
            onDelete={handleDelete}
          />
        </details>
      )}
    </main>
  );
}
