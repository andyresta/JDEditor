import { useCallback, useEffect, useRef, useState } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { currentMonitor, getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import { api } from "../api";
import { formatDuration, type Rect, type RecordingConfig } from "../types";

/** Gap between the bar and the bottom of the usable screen area. */
const BOTTOM_MARGIN = 18;

/** What the bar is currently doing. There's no step here where it waits
 * to be told to begin: the capture mode was already chosen in the main
 * window, so the bar picks the region (if that's the mode) and starts. */
type Phase =
  | "loading"
  | "selecting"
  | "starting"
  | "recording"
  | "paused"
  | "finishing"
  | "failed";

function IconMic() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 15a3.5 3.5 0 0 0 3.5-3.5V6a3.5 3.5 0 1 0-7 0v5.5A3.5 3.5 0 0 0 12 15Z" />
      <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3" />
    </svg>
  );
}

function IconPause() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M9.5 6v12M14.5 6v12" />
    </svg>
  );
}

function IconPlay() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M8 5.5l11 6.5L8 18.5z" />
    </svg>
  );
}

function IconRestart() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4.5 12a7.5 7.5 0 1 0 2.6-5.7" />
      <path d="M4 4.5V10h5.5" />
    </svg>
  );
}

function IconTrash() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4.5 7h15M9.5 7V5h5v2M6.5 7l1 12h9l1-12M10.5 10.5v5.5M13.5 10.5v5.5" />
    </svg>
  );
}

function IconGrip() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="6" r="1.4" />
      <circle cx="12" cy="12" r="1.4" />
      <circle cx="12" cy="18" r="1.4" />
    </svg>
  );
}

/**
 * The floating control bar: a small always-on-top window that takes over
 * from the main window for the whole recording flow — picking the area,
 * starting, pausing and stopping — and is kept out of the recording
 * itself so it can sit on top of the captured region.
 *
 * Rendered instead of the main app when this window's label is
 * "recorder-bar".
 */
export function RecorderBar() {
  const [config, setConfig] = useState<RecordingConfig | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const [area, setArea] = useState<Rect | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [audioLevel, setAudioLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  /** Set while a control's command is in flight — starting and stopping
   * ffmpeg take a moment, and these buttons shouldn't fire twice. */
  const [busy, setBusy] = useState(false);
  const shellRef = useRef<HTMLDivElement | null>(null);
  /** Set once the bar has been dragged, so it stops re-centring itself. */
  const dragged = useRef(false);

  /** Starts the capture. `region` is null for the whole screen. */
  const beginRecording = useCallback(
    async (settings: RecordingConfig, region: Rect | null) => {
      setError(null);
      setPhase("starting");
      try {
        await api.startRecording({ ...settings, area: region });
        setElapsed(0);
        setAudioLevel(0);
        setPhase("recording");
      } catch (e) {
        setError(String(e));
        setPhase("failed");
      }
    },
    [],
  );

  // Everything was decided in the main window, so the bar gets straight
  // on with it: Area capture opens the region selector, and anything else
  // starts recording the whole screen right away.
  useEffect(() => {
    let cancelled = false;
    api
      .recorderBarSetup()
      .then(async (setup) => {
        if (cancelled) return;
        if (!setup) {
          setError("The recorder bar has no capture settings to work from.");
          setPhase("failed");
          return;
        }
        setConfig(setup.config);

        if (setup.pick_area) {
          setPhase("selecting");
          await api.openAreaSelector();
          return;
        }
        await beginRecording(setup.config, null);
      })
      .catch((e) => {
        setError(String(e));
        setPhase("failed");
      });
    return () => {
      cancelled = true;
    };
  }, [beginRecording]);

  /** Hands the finished file to the main window, which opens the editor. */
  const finish = useCallback(async (path: string) => {
    setPhase("finishing");
    await emit("recording-finished", { path });
    await api.closeRecorderBar().catch(() => {});
  }, []);

  // The area selector reports back by event, since it lives in its own
  // window. A null payload means the user asked for the whole screen;
  // either way the recording begins at once. Abandoning the selection
  // arrives as its own event and takes the whole flow down with it.
  useEffect(() => {
    const selected = listen<Rect | null>("area-selected", async (event) => {
      if (!config) return;
      setArea(event.payload);
      const self = getCurrentWindow();
      await self.show().catch(() => {});
      await self.setFocus().catch(() => {});
      await beginRecording(config, event.payload);
    });
    const abandoned = listen("area-selection-cancelled", () => {
      api.closeRecorderBar().catch(() => {});
    });

    return () => {
      selected.then((unlisten) => unlisten());
      abandoned.then((unlisten) => unlisten());
    };
  }, [config, beginRecording]);

  // A failure has to be visible. In Area capture the bar starts hidden
  // behind the region selector, and the main window is hidden too, so
  // staying hidden would leave nothing on screen at all.
  useEffect(() => {
    if (phase !== "failed") return;
    const self = getCurrentWindow();
    self.show().catch(() => {});
    self.setFocus().catch(() => {});
  }, [phase]);

  // The backend owns the clock, so paused time stays out of the count. It
  // also carries the microphone level, which is why this polls several
  // times a second rather than once.
  useEffect(() => {
    if (phase !== "recording" && phase !== "paused") return;

    let stopped = false;
    const poll = async () => {
      const status = await api.recordingStatus().catch(() => null);
      if (!status || stopped) return;
      setElapsed(status.elapsed_seconds);
      setAudioLevel(status.audio_level ?? 0);

      if (status.is_recording) {
        setPhase(status.is_paused ? "paused" : "recording");
      } else if (status.error) {
        // ffmpeg gave up by itself. Say why and offer another go — opening
        // the editor on a file that won't play only hides the problem.
        setError(status.error);
        setPhase("failed");
      } else if (status.output_path) {
        finish(status.output_path);
      }
    };

    poll();
    // Fast enough to keep up with the microphone level, which the backend
    // refreshes dozens of times a second.
    const timer = window.setInterval(poll, 100);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [phase, finish]);

  // Keep the window itself exactly as big as the bar, so none of the
  // transparent area around it swallows clicks meant for what's behind —
  // and re-centre it afterwards, since growing a window only moves its
  // right edge and would leave the bar sitting off-centre.
  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;
    const rect = shell.getBoundingClientRect();
    const width = Math.ceil(rect.width);
    const height = Math.ceil(rect.height);

    const place = async () => {
      const self = getCurrentWindow();
      await self.setSize(new LogicalSize(width, height));

      // Once it's been dragged somewhere, that's where the user wants it.
      if (dragged.current) return;
      const monitor = await currentMonitor();
      if (!monitor) return;

      // The work area excludes the taskbar, so "the bottom" is the bottom
      // of the space actually available.
      const origin = monitor.workArea.position.toLogical(monitor.scaleFactor);
      const usable = monitor.workArea.size.toLogical(monitor.scaleFactor);
      await self.setPosition(
        new LogicalPosition(
          Math.round(origin.x + (usable.width - width) / 2),
          Math.round(origin.y + usable.height - height - BOTTOM_MARGIN),
        ),
      );
    };
    place().catch(() => {});
  }, [phase, area, config, error]);

  async function handlePauseResume() {
    const paused = phase === "paused";
    setError(null);
    setBusy(true);
    try {
      if (paused) {
        await api.resumeRecording();
        setPhase("recording");
      } else {
        await api.pauseRecording();
        setPhase("paused");
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  /** Throws away what's been recorded and starts the same capture again. */
  async function handleRestart() {
    if (!config) return;
    setBusy(true);
    try {
      // Best effort: when the start itself failed there's nothing to throw
      // away, and that shouldn't stop another attempt.
      await api.discardRecording().catch(() => {});
      await beginRecording(config, area);
    } catch (e) {
      setError(String(e));
      setPhase("failed");
    } finally {
      setBusy(false);
    }
  }

  /** Throws the recording away and goes back to the main window. */
  async function handleDiscard() {
    setError(null);
    setBusy(true);
    try {
      await api.discardRecording();
      await api.closeRecorderBar();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  }

  async function handleStop() {
    const previous = phase;
    setPhase("finishing");
    try {
      await finish(await api.stopRecording());
    } catch (e) {
      setError(String(e));
      setPhase(previous);
    }
  }

  function handleClose() {
    api.closeRecorderBar().catch((e) => setError(String(e)));
  }

  /** Drags the whole bar from any part of its surface that isn't a
   * control. `data-tauri-drag-region` isn't used because it matches on
   * the mousedown target, and every control here has an <svg> inside it
   * that becomes the target instead — so dragging is started directly. */
  function handleDragStart(event: React.MouseEvent) {
    if (event.button !== 0) return;
    if ((event.target as Element).closest("button, select, input")) return;
    dragged.current = true;
    getCurrentWindow().startDragging().catch(() => {});
  }

  const recording = phase === "recording";
  const paused = phase === "paused";
  const live = recording || paused || phase === "finishing";

  return (
    <div className="bar-shell" ref={shellRef}>
      <div className="bar-pill" onMouseDown={handleDragStart}>
        {(phase === "loading" || phase === "selecting" || phase === "starting") && (
          <span className="bar-text">
            <span className="spinner" />
            {phase === "selecting" ? "Choose an area…" : "Starting…"}
          </span>
        )}

        {phase === "failed" && (
          <>
            <span className="bar-text">Couldn't start recording</span>
            <button
              className="bar-button bar-button-primary"
              onClick={handleRestart}
              disabled={busy || !config}
            >
              Try again
            </button>
            <button className="bar-button" onClick={handleClose} disabled={busy}>
              Close
            </button>
          </>
        )}

        {live && (
          <>
            {/* The timer doubles as the stop button, the way a recorder's
                red indicator usually does. */}
            <button
              className="bar-stop"
              onClick={handleStop}
              disabled={busy || phase === "finishing"}
              title="Stop recording"
            >
              <span className={`bar-stop-dot ${paused ? "bar-stop-dot-paused" : ""}`} />
              <span className="bar-stop-time">{formatDuration(elapsed)}</span>
            </button>

            {config?.include_audio && (
              <span className="bar-mic" title="Microphone level">
                <span className="bar-mic-icon">
                  <IconMic />
                </span>
                <span className="bar-mic-level">
                  <span
                    className="bar-mic-level-fill"
                    style={{ width: `${Math.round((recording ? audioLevel : 0) * 100)}%` }}
                  />
                </span>
              </span>
            )}

            {phase === "finishing" ? (
              <span className="bar-text">
                <span className="spinner" />
                Finishing…
              </span>
            ) : (
              <>
                <span className="bar-divider" />
                <button
                  className="bar-icon-button"
                  onClick={handlePauseResume}
                  disabled={busy}
                  title={paused ? "Resume" : "Pause"}
                >
                  {paused ? <IconPlay /> : <IconPause />}
                </button>
                <button
                  className="bar-icon-button"
                  onClick={handleRestart}
                  disabled={busy}
                  title="Discard and start over"
                >
                  <IconRestart />
                </button>
                <button
                  className="bar-icon-button bar-icon-danger"
                  onClick={handleDiscard}
                  disabled={busy}
                  title="Discard recording"
                >
                  <IconTrash />
                </button>
              </>
            )}
          </>
        )}

        <span className="bar-grip" title="Drag to move">
          <IconGrip />
        </span>
      </div>

      {error && (
        <div className="bar-error" title={error}>
          {error}
        </div>
      )}
    </div>
  );
}
