import { useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { MenuBar, type MenuDef } from "./MenuBar";
import { formatDuration, type MediaItem } from "../types";

interface EditorShellProps {
  media: MediaItem[];
  activeMediaPath: string | null;
  onSelectMedia: (path: string) => void;
  onImportMedia: () => void;
  onNewProject: () => void;
  onOpenProject: () => void;
  onCloseProject: () => void;
}

export function EditorShell({
  media,
  activeMediaPath,
  onSelectMedia,
  onImportMedia,
  onNewProject,
  onOpenProject,
  onCloseProject,
}: EditorShellProps) {
  const [toast, setToast] = useState<string | null>(null);
  const [showMediaPanel, setShowMediaPanel] = useState(true);
  const [showPropertiesPanel, setShowPropertiesPanel] = useState(true);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 2200);
    return () => window.clearTimeout(t);
  }, [toast]);

  function comingSoon(feature: string) {
    setToast(`${feature} is coming in a future update.`);
  }

  const activeMedia = media.find((m) => m.path === activeMediaPath) ?? null;

  const menus: MenuDef[] = [
    {
      label: "File",
      items: [
        { label: "New Project", onClick: onNewProject },
        { label: "Open Project...", onClick: onOpenProject },
        { label: "Save Project", onClick: () => comingSoon("Save Project"), separatorBefore: true },
        { label: "Save Project As...", onClick: () => comingSoon("Save Project As") },
        { label: "Export Video...", onClick: () => comingSoon("Export") },
        { label: "Import Media...", onClick: onImportMedia, separatorBefore: true },
        { label: "Close Project", onClick: onCloseProject, separatorBefore: true },
      ],
    },
    {
      label: "Edit",
      items: [
        { label: "Undo", onClick: () => comingSoon("Undo"), shortcut: "Ctrl+Z" },
        { label: "Redo", onClick: () => comingSoon("Redo"), shortcut: "Ctrl+Y" },
        { label: "Cut", onClick: () => comingSoon("Cut"), separatorBefore: true },
        { label: "Copy", onClick: () => comingSoon("Copy") },
        { label: "Paste", onClick: () => comingSoon("Paste") },
        { label: "Delete Clip", onClick: () => comingSoon("Delete Clip"), separatorBefore: true },
      ],
    },
    {
      label: "View",
      items: [
        {
          label: showMediaPanel ? "Hide Media Panel" : "Show Media Panel",
          onClick: () => setShowMediaPanel((v) => !v),
        },
        {
          label: showPropertiesPanel ? "Hide Properties Panel" : "Show Properties Panel",
          onClick: () => setShowPropertiesPanel((v) => !v),
        },
        { label: "Zoom Timeline In", onClick: () => comingSoon("Timeline zoom"), separatorBefore: true },
        { label: "Zoom Timeline Out", onClick: () => comingSoon("Timeline zoom") },
      ],
    },
  ];

  return (
    <div className="editor-shell">
      <MenuBar menus={menus} />

      <div className="editor-body">
        {showMediaPanel && (
          <aside className="editor-panel editor-media">
            <div className="editor-panel-header">
              <h3>Media</h3>
              <button onClick={onImportMedia}>+ Import</button>
            </div>
            {media.length === 0 ? (
              <p className="empty-hint">No media in this project yet.</p>
            ) : (
              <ul className="media-list">
                {media.map((m) => (
                  <li key={m.path}>
                    <button
                      className={`media-list-item ${
                        m.path === activeMediaPath ? "active" : ""
                      } ${m.status === "preparing" ? "preparing" : ""}`}
                      onClick={() => onSelectMedia(m.path)}
                    >
                      <span className="media-thumb-wrap">
                        {m.status === "preparing" ? (
                          <span className="spinner" />
                        ) : m.thumbnailPath ? (
                          <img
                            className="media-thumb"
                            src={convertFileSrc(m.thumbnailPath)}
                            alt=""
                          />
                        ) : (
                          <span className="media-thumb media-thumb-placeholder">🎬</span>
                        )}
                      </span>
                      <span className="media-item-text">
                        <span className="media-item-name">{m.name}</span>
                        <span className="media-item-meta">
                          {m.status === "preparing"
                            ? "Preparing…"
                            : formatDuration(m.durationSeconds)}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </aside>
        )}

        <div className="editor-center">
          <div className="editor-preview">
            {activeMedia && activeMedia.status === "preparing" ? (
              <div className="preview-preparing">
                <span className="spinner spinner-lg" />
                <p>Preparing video for editing…</p>
              </div>
            ) : activeMedia ? (
              <video
                key={activeMedia.path}
                src={convertFileSrc(activeMedia.path)}
                controls
                className="preview-video"
              />
            ) : (
              <div className="preview-empty">
                {media.length === 0
                  ? "Import media to get started."
                  : "Select a clip from the Media panel."}
              </div>
            )}
          </div>

          <div className="editor-timeline">
            <div className="editor-panel-header">
              <h3>Timeline</h3>
              <span className="timeline-hint">Trim, split &amp; multi-track editing coming soon</span>
            </div>
            <div className="timeline-track">
              {media.length === 0 ? (
                <div className="timeline-empty">Nothing on the timeline yet</div>
              ) : (
                media.map((m) => (
                  <button
                    key={m.path}
                    className={`timeline-clip ${
                      m.path === activeMediaPath ? "active" : ""
                    } ${m.status === "preparing" ? "preparing" : ""}`}
                    onClick={() => onSelectMedia(m.path)}
                    title={m.name}
                  >
                    {m.status === "preparing" ? <span className="spinner" /> : null}
                    {m.name}
                  </button>
                ))
              )}
            </div>
          </div>
        </div>

        {showPropertiesPanel && (
          <aside className="editor-panel editor-properties">
            <div className="editor-panel-header">
              <h3>Properties</h3>
            </div>
            <div className="properties-form">
              <div className="field">
                <label>Trim start</label>
                <input type="text" placeholder="00:00:00" disabled />
              </div>
              <div className="field">
                <label>Trim end</label>
                <input type="text" placeholder="00:00:00" disabled />
              </div>
              <div className="field">
                <label>Volume</label>
                <input type="range" min={0} max={100} defaultValue={100} disabled />
              </div>
              <div className="field">
                <label>Filter</label>
                <select disabled>
                  <option>None</option>
                </select>
              </div>
              <p className="empty-hint">Editing tools are coming in a future update.</p>
            </div>
          </aside>
        )}
      </div>

      {toast && <div className="editor-toast">{toast}</div>}
    </div>
  );
}
