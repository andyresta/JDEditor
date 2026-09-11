// Throwaway harness: renders the editor with fake data in a plain browser
// so its behaviour can be inspected. Not part of the app.
import { useState } from "react";
import ReactDOM from "react-dom/client";
import { EditorShell } from "./components/EditorShell";
import {
  DEFAULT_EDITOR_SETTINGS,
  newId,
  newTrack,
  type EditorSettings,
  type MediaItem,
  type TimelineTrack,
} from "./types";
import "./App.css";

const MEDIA: MediaItem[] = [
  {
    path: "C:/clips/first.mp4",
    name: "first.mp4",
    kind: "video",
    status: "ready",
    durationSeconds: 20,
  },
  {
    path: "C:/clips/second.mp4",
    name: "second.mp4",
    kind: "video",
    status: "ready",
    durationSeconds: 20,
  },
];

// Two clips with a deliberate gap between them: 0-6s, then 10-16s.
const INITIAL: TimelineTrack[] = [
  {
    id: "track-a",
    name: "Video 1",
    clips: [
      { id: "clip-a", mediaPath: MEDIA[0].path, startSeconds: 0, durationSeconds: 6 },
      { id: "clip-b", mediaPath: MEDIA[1].path, startSeconds: 10, durationSeconds: 6 },
    ],
  },
  { id: "track-b", name: "Track 2", clips: [] },
];

function Harness() {
  const [settings, setSettings] = useState<EditorSettings>(DEFAULT_EDITOR_SETTINGS);
  const [activePath, setActivePath] = useState<string | null>(MEDIA[0].path);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [tracks, setTracks] = useState<TimelineTrack[]>(INITIAL);

  // Exposed so the checks can read state back without guessing from the DOM.
  (window as unknown as { harness: unknown }).harness = { tracks };

  return (
    <EditorShell
      media={MEDIA}
      activeMediaPath={activePath}
      projectName="Sync check"
      isDirty
      settings={settings}
      tracks={tracks}
      selectedClipId={selectedClipId}
      onSettingsChange={setSettings}
      onSelectClip={setSelectedClipId}
      onAddTrack={() => setTracks((t) => [...t, newTrack(`Track ${t.length + 1}`)])}
      onAddClip={(trackId, mediaPath, startSeconds) =>
        setTracks((current) =>
          current.map((track) =>
            track.id === trackId
              ? {
                  ...track,
                  clips: [
                    ...track.clips,
                    { id: newId("clip"), mediaPath, startSeconds, durationSeconds: 6 },
                  ],
                }
              : track,
          ),
        )
      }
      onMoveClip={(clipId, trackId, startSeconds) =>
        setTracks((current) => {
          const moving = current.flatMap((t) => t.clips).find((c) => c.id === clipId);
          if (!moving) return current;
          const placed = { ...moving, startSeconds };
          return current.map((track) => ({
            ...track,
            clips:
              track.id === trackId
                ? [...track.clips.filter((c) => c.id !== clipId), placed]
                : track.clips.filter((c) => c.id !== clipId),
          }));
        })
      }
      onRemoveClip={(clipId) =>
        setTracks((current) =>
          current.map((track) => ({
            ...track,
            clips: track.clips.filter((c) => c.id !== clipId),
          })),
        )
      }
      onSelectMedia={setActivePath}
      onImportMedia={() => {}}
      onRemoveMedia={() => {}}
      onNewProject={() => {}}
      onOpenProject={() => {}}
      onSaveProject={() => {}}
      onSaveProjectAs={() => {}}
      onCloseProject={() => {}}
    />
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<Harness />);
