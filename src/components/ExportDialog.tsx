import { estimateSize } from "../export";
import {
  EXPORT_FORMATS,
  EXPORT_FORMAT_LABELS,
  EXPORT_FPS_OPTIONS,
  EXPORT_QUALITIES,
  EXPORT_QUALITY_LABELS,
  EXPORT_RESOLUTIONS,
  formatDuration,
  type ExportFormat,
  type ExportQuality,
  type ExportResolution,
  type ExportSettings,
} from "../types";

interface ExportDialogProps {
  settings: ExportSettings;
  /** How long the finished file will be. */
  seconds: number;
  /** The canvas the current choices render onto. */
  width: number;
  height: number;
  /** null while nothing is running; 0-1 once ffmpeg reports a position. */
  progress: number | null;
  error: string | null;
  /** Where the last render landed, so it can be opened. */
  finishedPath: string | null;
  onChange: (next: ExportSettings) => void;
  onExport: () => void;
  onCancel: () => void;
  onReveal: (path: string) => void;
  onClose: () => void;
}

const RESOLUTION_LABELS: Record<ExportResolution, string> = {
  "480p": "480p",
  "720p": "720p",
  "1080p": "1080p",
  source: "Source",
};

export function ExportDialog({
  settings,
  seconds,
  width,
  height,
  progress,
  error,
  finishedPath,
  onChange,
  onExport,
  onCancel,
  onReveal,
  onClose,
}: ExportDialogProps) {
  const running = progress !== null;
  const silent = settings.format === "gif";
  const pictureless = settings.format === "mp3";
  const done = finishedPath !== null && !running;

  const patch = (change: Partial<ExportSettings>) =>
    onChange({ ...settings, ...change });

  return (
    <div className="project-modal-backdrop">
      <div
        className="project-modal export-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Export"
      >
        <h2>Export</h2>

        {done ? (
          <>
            <p>
              Written to <span className="export-path">{finishedPath}</span>
            </p>
            <div className="project-modal-actions">
              <button
                className="project-modal-primary"
                onClick={() => onReveal(finishedPath)}
              >
                Show the file
              </button>
              <button onClick={onClose}>Close</button>
            </div>
          </>
        ) : running ? (
          <>
            <p>
              Rendering {formatDuration(seconds)} at {width}×{height}…
            </p>
            <div
              className="export-progress"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(progress * 100)}
            >
              <span style={{ width: `${Math.round(progress * 100)}%` }} />
            </div>
            <p className="export-note">{Math.round(progress * 100)}% done</p>
            <div className="project-modal-actions">
              <button onClick={onCancel}>Stop</button>
            </div>
          </>
        ) : (
          <>
            <label className="export-field">
              <span>Format</span>
              <select
                value={settings.format}
                onChange={(e) => patch({ format: e.currentTarget.value as ExportFormat })}
              >
                {EXPORT_FORMATS.map((format) => (
                  <option key={format} value={format}>
                    {EXPORT_FORMAT_LABELS[format]}
                  </option>
                ))}
              </select>
            </label>

            {!pictureless && (
              <>
                <label className="export-field">
                  <span>Size</span>
                  <select
                    value={settings.resolution}
                    onChange={(e) =>
                      patch({ resolution: e.currentTarget.value as ExportResolution })
                    }
                  >
                    {EXPORT_RESOLUTIONS.map((resolution) => (
                      <option key={resolution} value={resolution}>
                        {RESOLUTION_LABELS[resolution]}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="export-field">
                  <span>Frame rate</span>
                  <select
                    value={settings.fps}
                    onChange={(e) => patch({ fps: Number(e.currentTarget.value) })}
                  >
                    {EXPORT_FPS_OPTIONS.map((fps) => (
                      <option key={fps} value={fps}>
                        {fps} fps
                      </option>
                    ))}
                  </select>
                </label>
              </>
            )}

            <label className="export-field">
              <span>Quality</span>
              <select
                value={settings.quality}
                onChange={(e) =>
                  patch({ quality: e.currentTarget.value as ExportQuality })
                }
              >
                {EXPORT_QUALITIES.map((quality) => (
                  <option key={quality} value={quality}>
                    {EXPORT_QUALITY_LABELS[quality]}
                  </option>
                ))}
              </select>
            </label>

            <p className="export-note">
              {formatDuration(seconds) || "0:00"}
              {pictureless ? "" : ` · ${width}×${height} · ${settings.fps} fps`} ·{" "}
              {estimateSize(settings, seconds)}
              {silent && " · GIF carries no sound"}
            </p>

            {error && (
              <p className="export-error" role="alert">
                {error}
              </p>
            )}

            <div className="project-modal-actions">
              <button className="project-modal-primary" onClick={onExport}>
                Choose where to save…
              </button>
              <button onClick={onClose}>Cancel</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
