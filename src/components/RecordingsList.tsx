import { revealItemInDir } from "@tauri-apps/plugin-opener";
import type { RecordingFile } from "../types";

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function RecordingsList({
  recordings,
  onOpen,
  onDelete,
}: {
  recordings: RecordingFile[];
  onOpen: (path: string, name: string) => void;
  onDelete: (path: string) => void;
}) {
  if (recordings.length === 0) {
    return <p className="empty-hint">No recordings yet.</p>;
  }

  return (
    <ul className="recordings-list">
      {recordings.map((r) => (
        <li key={r.path} className="recording-item">
          <div className="recording-info">
            <span className="recording-name">{r.name}</span>
            <span className="recording-meta">
              {r.created_at} &middot; {formatSize(r.size_bytes)}
            </span>
          </div>
          <div className="recording-actions">
            <button onClick={() => onOpen(r.path, r.name)}>Open in Editor</button>
            <button onClick={() => revealItemInDir(r.path)}>Show in folder</button>
            <button className="danger" onClick={() => onDelete(r.path)}>
              Delete
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
}
