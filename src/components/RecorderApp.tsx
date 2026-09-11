import { Dispatch, SetStateAction, useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api } from "../api";
import { EditorShell } from "./EditorShell";
import { Launcher } from "./Launcher";
import { RecordingsList } from "./RecordingsList";
import {
  DeviceList,
  FPS_OPTIONS,
  MediaItem,
  QUALITY_LABELS,
  QualityPreset,
  Rect,
  RecordingFile,
} from "../types";

function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

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

/** Opens the area-selector overlay and resolves with what the user picked
 * (or `null` if they pressed Esc to cancel, meaning "entire screen"). */
function pickArea(): Promise<Rect | null> {
  return new Promise((resolve, reject) => {
    let unlisten: (() => void) | undefined;
    listen<Rect | null>("area-selected", (event) => {
      unlisten?.();
      resolve(event.payload);
    })
      .then((u) => {
        unlisten = u;
      })
      .catch(reject);

    api.openAreaSelector().catch((e) => {
      unlisten?.();
      reject(e);
    });
  });
}

function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60)
    .toString()
    .padStart(2, "0");
  const s = Math.floor(seconds % 60)
    .toString()
    .padStart(2, "0");
  return `${m}:${s}`;
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
  const [area, setArea] = useState<Rect | null>(null);

  const [isRecording, setIsRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [lastOutput, setLastOutput] = useState<string | null>(null);
  const [recordings, setRecordings] = useState<RecordingFile[]>([]);

  const [pickingArea, setPickingArea] = useState(false);
  const [deviceDebug, setDeviceDebug] = useState<string | null>(null);
  const [deviceDebugLoading, setDeviceDebugLoading] = useState(false);

  const [view, setView] = useState<"launcher" | "recorder" | "editor">("launcher");
  const [projectMedia, setProjectMedia] = useState<MediaItem[]>([]);
  const [activeMediaPath, setActiveMediaPath] = useState<string | null>(null);

  const pollRef = useRef<number | null>(null);

  const refreshRecordings = useCallback(() => {
    api.listRecordings().then(setRecordings).catch(() => {});
  }, []);

  /** Switches into the editor immediately, showing `path` as a "preparing"
   * media item. Used for the recording-just-stopped case, where we want the
   * editor to appear at once instead of waiting on ffmpeg/ffprobe first. */
  const addPreparingMedia = useCallback((path: string, name?: string) => {
    setProjectMedia([{ path, name: name ?? basename(path), status: "preparing" }]);
    setActiveMediaPath(path);
    setView("editor");
  }, []);

  /** Same, but for a file that's already finalized on disk (opening a past
   * recording, or an import) — safe to kick off the metadata/thumbnail
   * fetch right away. */
  const openInEditor = useCallback(
    (path: string, name?: string) => {
      addPreparingMedia(path, name);
      preparePathAsync(path, setProjectMedia);
    },
    [addPreparingMedia],
  );

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

  useEffect(() => {
    if (!isRecording) {
      if (pollRef.current) window.clearInterval(pollRef.current);
      return;
    }
    pollRef.current = window.setInterval(async () => {
      const status = await api.recordingStatus();
      setIsRecording(status.is_recording);
      setElapsed(status.elapsed_seconds);
      if (!status.is_recording) {
        setLastOutput(status.output_path);
        refreshRecordings();
        if (status.output_path) openInEditor(status.output_path);
      }
    }, 1000);
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
    };
  }, [isRecording, refreshRecordings, openInEditor]);

  // The editor is meant to fill the screen; the launcher and recorder
  // screens use the normal, centered window size.
  useEffect(() => {
    const win = getCurrentWindow();
    if (view === "editor") {
      win.maximize().catch(() => {});
    } else {
      win.unmaximize().catch(() => {});
    }
  }, [view]);

  async function handleToggleRecording() {
    setError(null);
    if (isRecording) {
      // The output path is already known from when recording started, so
      // jump into the editor right away instead of waiting for ffmpeg to
      // finish flushing the file first — the media item's spinner covers
      // that wait (and the metadata/thumbnail fetch after it).
      const pendingPath = lastOutput;
      setIsRecording(false);
      setElapsed(0);
      if (pendingPath) addPreparingMedia(pendingPath);

      try {
        const path = await api.stopRecording();
        setLastOutput(path);
        refreshRecordings();
        if (pendingPath) {
          preparePathAsync(path, setProjectMedia);
        } else {
          openInEditor(path);
        }
      } catch (e) {
        setError(String(e));
        if (pendingPath) {
          setProjectMedia((current) =>
            current.map((m) => (m.path === pendingPath ? { ...m, status: "ready" } : m)),
          );
        }
      }
      return;
    }

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

    let pickedArea: Rect | null;
    setPickingArea(true);
    try {
      pickedArea = await pickArea();
    } catch (e) {
      setPickingArea(false);
      setError(String(e));
      return;
    }
    setPickingArea(false);
    setArea(pickedArea);

    try {
      const path = await api.startRecording({
        screen_id: screenId,
        area: pickedArea,
        include_webcam: includeWebcam,
        webcam_id: includeWebcam ? webcamId : null,
        include_audio: includeAudio,
        audio_id: includeAudio ? audioId : null,
        quality,
        fps,
        output_dir: null,
      });
      setLastOutput(path);
      setIsRecording(true);
      setElapsed(0);
    } catch (e) {
      setError(String(e));
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

  async function handleImportMedia() {
    const picked = await api.pickMediaFiles();
    if (!picked || picked.length === 0) return;
    const existingPaths = new Set(projectMedia.map((m) => m.path));
    const newPaths = picked.filter((p) => !existingPaths.has(p));
    if (newPaths.length === 0) return;

    const additions: MediaItem[] = newPaths.map((p) => ({
      path: p,
      name: basename(p),
      status: "preparing",
    }));
    setProjectMedia((current) => [...current, ...additions]);
    setActiveMediaPath((current) => current ?? newPaths[0]);
    newPaths.forEach((p) => preparePathAsync(p, setProjectMedia));
  }

  function handleNewProject() {
    setProjectMedia([]);
    setActiveMediaPath(null);
  }

  async function handleOpenProject() {
    const picked = await api.pickMediaFiles();
    if (!picked || picked.length === 0) return;
    const items: MediaItem[] = picked.map((p) => ({
      path: p,
      name: basename(p),
      status: "preparing",
    }));
    setProjectMedia(items);
    setActiveMediaPath(items[0].path);
    picked.forEach((p) => preparePathAsync(p, setProjectMedia));
  }

  if (view === "editor") {
    return (
      <EditorShell
        media={projectMedia}
        activeMediaPath={activeMediaPath}
        onSelectMedia={setActiveMediaPath}
        onImportMedia={handleImportMedia}
        onNewProject={handleNewProject}
        onOpenProject={handleOpenProject}
        onCloseProject={() => setView("launcher")}
      />
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
    <main className="container">
      <button
        className="link-button back-link"
        disabled={isRecording}
        onClick={() => setView("launcher")}
      >
        &larr; Back
      </button>
      <header className="app-header">
        <h1>JDEditor</h1>
        <p className="subtitle">Screen, webcam &amp; audio recorder</p>
      </header>

      {error && <div className="banner banner-error">{error}</div>}

      <section className="panel">
        <h2>Source</h2>
        <div className="field">
          <label htmlFor="screen-select">Screen</label>
          <select
            id="screen-select"
            value={screenId}
            disabled={isRecording}
            onChange={(e) => setScreenId(e.target.value)}
          >
            {devices?.screens.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.width}x{s.height})
                {s.is_primary ? " · Primary" : ""}
              </option>
            ))}
          </select>
        </div>

        <div className="field field-row">
          <span>Area</span>
          <span className="area-summary">
            {area
              ? `Last: ${area.width} x ${area.height} @ (${area.x}, ${area.y})`
              : "You'll drag-select the area right when you click Start Recording"}
            {" — press Esc during selection to record the entire screen."}
          </span>
        </div>
      </section>

      <section className="panel">
        <h2>Webcam</h2>
        <div className="field field-row">
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={includeWebcam}
              disabled={isRecording}
              onChange={(e) => setIncludeWebcam(e.target.checked)}
            />
            Include webcam
          </label>
          <select
            value={webcamId}
            disabled={isRecording || !includeWebcam}
            onChange={(e) => setWebcamId(e.target.value)}
          >
            {devices?.webcams.length ? (
              devices.webcams.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))
            ) : (
              <option value="">No webcams found</option>
            )}
          </select>
        </div>
      </section>

      <section className="panel">
        <h2>Audio</h2>
        <div className="field field-row">
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={includeAudio}
              disabled={isRecording}
              onChange={(e) => setIncludeAudio(e.target.checked)}
            />
            Include audio
          </label>
          <select
            value={audioId}
            disabled={isRecording || !includeAudio}
            onChange={(e) => setAudioId(e.target.value)}
          >
            {devices?.audio_inputs.length ? (
              devices.audio_inputs.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))
            ) : (
              <option value="">No audio sources found</option>
            )}
          </select>
        </div>

        {devices && (devices.webcams.length === 0 || devices.audio_inputs.length === 0) && (
          <div className="device-diagnostic">
            <button
              className="link-button"
              onClick={handleShowDeviceDebug}
              disabled={deviceDebugLoading}
            >
              {deviceDebugLoading
                ? "Scanning…"
                : "No webcam/audio detected? Show diagnostic info"}
            </button>
            {deviceDebug && <pre className="debug-output">{deviceDebug}</pre>}
          </div>
        )}
      </section>

      <section className="panel">
        <h2>Quality &amp; frame rate</h2>
        <div className="field field-row">
          <label htmlFor="quality-select">Quality</label>
          <select
            id="quality-select"
            value={quality}
            disabled={isRecording}
            onChange={(e) => setQuality(e.target.value as QualityPreset)}
          >
            {Object.entries(QUALITY_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <div className="field field-row">
          <label htmlFor="fps-select">FPS</label>
          <select
            id="fps-select"
            value={fps}
            disabled={isRecording}
            onChange={(e) => setFps(Number(e.target.value))}
          >
            {FPS_OPTIONS.map((f) => (
              <option key={f} value={f}>
                {f} fps
              </option>
            ))}
          </select>
        </div>
      </section>

      <section className="panel record-panel">
        <button
          className={`record-button ${isRecording ? "recording" : ""}`}
          onClick={handleToggleRecording}
          disabled={pickingArea}
        >
          {pickingArea
            ? "Select the area to record…"
            : isRecording
              ? `Stop  ${formatElapsed(elapsed)}`
              : "Start Recording"}
        </button>
        {!isRecording && lastOutput && (
          <p className="last-output">Saved: {lastOutput}</p>
        )}
      </section>

      <section className="panel">
        <h2>Recordings</h2>
        <RecordingsList
          recordings={recordings}
          onOpen={(path, name) => openInEditor(path, name)}
          onDelete={handleDelete}
        />
      </section>
    </main>
  );
}
