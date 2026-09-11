import { Dispatch, SetStateAction, useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { api } from "../api";
import { EditorShell } from "./EditorShell";
import { Launcher } from "./Launcher";
import { RecordingsList } from "./RecordingsList";
import {
  DEFAULT_CLIP_SECONDS,
  DEFAULT_EDITOR_SETTINGS,
  DeviceList,
  EditorSettings,
  FPS_OPTIONS,
  MediaItem,
  PROJECT_EXTENSION,
  ProjectFile,
  QUALITY_LABELS,
  QualityPreset,
  RecordingFile,
  TimelineTrack,
  mediaKindFor,
  newId,
  newTrack,
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
    .prepareMedia(path)
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
                thumbnailPath: info.thumbnail_path,
              }
            : m,
        ),
      );
    })
    .catch(() => {
      // Metadata/thumbnail is a nice-to-have; playback doesn't need it, so
      // just stop showing the "preparing" spinner.
      setProjectMedia((current) =>
        current.map((m) => (m.path === path ? { ...m, status: "ready" } : m)),
      );
    });
}

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
  const [tracks, setTracks] = useState<TimelineTrack[]>(() => [newTrack("Video 1")]);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [projectPath, setProjectPath] = useState<string | null>(null);
  const [projectName, setProjectName] = useState("Untitled project");
  const [editorSettings, setEditorSettings] = useState<EditorSettings>(
    DEFAULT_EDITOR_SETTINGS,
  );
  const [isDirty, setIsDirty] = useState(false);
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

  /** Builds the document written into a `.jd` file. Only what can't be
   * recomputed goes in: durations and thumbnails are read back off disk
   * when the project is opened again. */
  const projectDocument = useCallback(
    (name: string): ProjectFile => ({
      format: "jdeditor-project",
      version: 1,
      name,
      media: projectMedia.map((m) => ({ path: m.path, name: m.name })),
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
          JSON.stringify(projectDocument(name), null, 2),
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

      const items = (parsed.media ?? []).map((m) => newMediaItem(m.path, m.name));
      setProjectMedia(items);
      // Projects saved before the timeline existed have no tracks; give
      // them an empty one to drag media onto rather than nothing at all.
      setTracks(
        parsed.tracks?.length ? parsed.tracks : [newTrack("Video 1")],
      );
      setSelectedClipId(null);
      setActiveMediaPath(
        parsed.activeMediaPath ?? items[0]?.path ?? null,
      );
      setEditorSettings({ ...DEFAULT_EDITOR_SETTINGS, ...(parsed.settings ?? {}) });
      setProjectPath(path);
      setProjectName(parsed.name || basename(path).replace(/\.jd$/i, ""));
      setIsDirty(false);
      setView("editor");
      items.forEach((m) => preparePathAsync(m.path, setProjectMedia));
    } catch (e) {
      setError(String(e));
    } finally {
      setProjectBusy(false);
    }
  }, []);

  const startEmptyProject = useCallback(() => {
    setProjectMedia([]);
    setTracks([newTrack("Video 1")]);
    setSelectedClipId(null);
    setActiveMediaPath(null);
    setProjectPath(null);
    setProjectName("Untitled project");
    setEditorSettings(DEFAULT_EDITOR_SETTINGS);
    setIsDirty(false);
  }, []);

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

    setProjectMedia((current) => [...current, ...newPaths.map((p) => newMediaItem(p))]);
    setActiveMediaPath((current) => current ?? newPaths[0]);
    setIsDirty(true);
    newPaths.forEach((p) => preparePathAsync(p, setProjectMedia));
  }

  function handleRemoveMedia(path: string) {
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
    setEditorSettings(next);
    setIsDirty(true);
  }

  function handleAddTrack() {
    setTracks((current) => [...current, newTrack(`Track ${current.length + 1}`)]);
    setIsDirty(true);
  }

  /** Places a piece of the media pool onto a track. The same file can be
   * placed more than once, so each placement gets its own id. */
  function handleAddClip(trackId: string, mediaPath: string, startSeconds: number) {
    const source = projectMedia.find((m) => m.path === mediaPath);
    if (!source) return;

    const clip = {
      id: newId("clip"),
      mediaPath,
      startSeconds: Math.max(0, startSeconds),
      // Stills have no duration of their own, and a video still being
      // probed doesn't have one yet.
      durationSeconds: source.durationSeconds ?? DEFAULT_CLIP_SECONDS,
    };

    setTracks((current) =>
      current.map((track) =>
        track.id === trackId ? { ...track, clips: [...track.clips, clip] } : track,
      ),
    );
    setSelectedClipId(clip.id);
    setIsDirty(true);
  }

  function handleMoveClip(clipId: string, trackId: string, startSeconds: number) {
    setTracks((current) => {
      const moving = current
        .flatMap((track) => track.clips)
        .find((clip) => clip.id === clipId);
      if (!moving) return current;

      const placed = { ...moving, startSeconds: Math.max(0, startSeconds) };
      return current.map((track) => ({
        ...track,
        clips:
          track.id === trackId
            ? [...track.clips.filter((c) => c.id !== clipId), placed]
            : track.clips.filter((c) => c.id !== clipId),
      }));
    });
    setIsDirty(true);
  }

  function handleRemoveClip(clipId: string) {
    setTracks((current) =>
      current.map((track) => ({
        ...track,
        clips: track.clips.filter((clip) => clip.id !== clipId),
      })),
    );
    setSelectedClipId((current) => (current === clipId ? null : current));
    setIsDirty(true);
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
          onSelectMedia={setActiveMediaPath}
          onImportMedia={handleImportMedia}
          onRemoveMedia={handleRemoveMedia}
          onNewProject={() => guardUnsaved("new")}
          onOpenProject={() => guardUnsaved("open")}
          onSaveProject={() => void saveProject()}
          onSaveProjectAs={() => void saveProject(true)}
          onCloseProject={() => guardUnsaved("close")}
        />

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
