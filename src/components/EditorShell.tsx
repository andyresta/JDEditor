import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { MenuBar, type MenuDef } from "./MenuBar";
import {
  BACKDROP_CATEGORIES,
  BACKDROP_KINDS,
  DEFAULT_CLIP_SECONDS,
  formatDuration,
  mediaKindFor,
  type BackdropCategory,
  type BackdropKind,
  type EditorSettings,
  type MediaItem,
  type MediaKind,
  type TimelineClip,
  type TimelineTrack,
} from "../types";
import "../editor.css";

interface EditorShellProps {
  media: MediaItem[];
  activeMediaPath: string | null;
  projectName: string;
  isDirty: boolean;
  settings: EditorSettings;
  onSettingsChange: (next: EditorSettings) => void;
  onSelectMedia: (path: string) => void;
  onImportMedia: (kind: "visual" | "audio") => void;
  onRemoveMedia: (path: string) => void;
  onNewProject: () => void;
  onOpenProject: () => void;
  onSaveProject: () => void;
  onSaveProjectAs: () => void;
  onCloseProject: () => void;
  tracks: TimelineTrack[];
  selectedClipId: string | null;
  onSelectClip: (clipId: string | null) => void;
  onAddTrack: () => void;
  onAddClip: (trackId: string, mediaPath: string, startSeconds: number) => void;
  onMoveClip: (clipId: string, trackId: string, startSeconds: number) => void;
  onRemoveClip: (clipId: string) => void;
}

/* ------------------------------------------------------------------ icons */

type IconName =
  | "trash"
  | "folder"
  | "undo"
  | "redo"
  | "clips"
  | "export"
  | "wand"
  | "crop"
  | "frame"
  | "chevron"
  | "skip-back"
  | "skip-forward"
  | "play"
  | "pause"
  | "scissors"
  | "zoom-out"
  | "zoom-in"
  | "picture"
  | "speaker"
  | "video"
  | "plus"
  | "close"
  | "search";

function Icon({ name, className }: { name: IconName; className?: string }) {
  return (
    <svg
      className={`ed-icon ${className ?? ""}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {iconPaths(name)}
    </svg>
  );
}

function iconPaths(name: IconName) {
  switch (name) {
    case "trash":
      return (
        <>
          <path d="M4 7h16" />
          <path d="M9 7V4.8A.8.8 0 0 1 9.8 4h4.4a.8.8 0 0 1 .8.8V7" />
          <path d="M6.5 7l.8 12.2a.9.9 0 0 0 .9.8h7.6a.9.9 0 0 0 .9-.8L17.5 7" />
          <path d="M10 11v6M14 11v6" />
        </>
      );
    case "folder":
      return (
        <>
          <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2.2h8A1.5 1.5 0 0 1 20 9.7v7.8A1.5 1.5 0 0 1 18.5 19h-14A1.5 1.5 0 0 1 3 17.5z" />
        </>
      );
    case "undo":
      return (
        <>
          <path d="M4 9h9.5a5.5 5.5 0 0 1 0 11H8" />
          <path d="M8 5L4 9l4 4" />
        </>
      );
    case "redo":
      return (
        <>
          <path d="M20 9h-9.5a5.5 5.5 0 0 0 0 11H16" />
          <path d="M16 5l4 4-4 4" />
        </>
      );
    case "clips":
      return (
        <>
          <rect x="3" y="6" width="12" height="12" rx="2" />
          <path d="M17 8.5l4-2v11l-4-2" />
        </>
      );
    case "export":
      return (
        <>
          <path d="M12 16V4" />
          <path d="M8 8l4-4 4 4" />
          <path d="M4 15v3.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V15" />
        </>
      );
    case "wand":
      return (
        <>
          <path d="M5 19L16 8" />
          <path d="M14.5 4.5l1 2.5 2.5 1-2.5 1-1 2.5-1-2.5L11 8l2.5-1z" />
          <path d="M19 15l.6 1.4L21 17l-1.4.6L19 19l-.6-1.4L17 17l1.4-.6z" />
        </>
      );
    case "crop":
      return (
        <>
          <path d="M7 3v12.5a1.5 1.5 0 0 0 1.5 1.5H21" />
          <path d="M3 7h12.5A1.5 1.5 0 0 1 17 8.5V21" />
        </>
      );
    case "frame":
      return (
        <>
          <rect x="4" y="4" width="16" height="16" rx="2" />
          <path d="M4 9h16M4 15h16M9 4v16M15 4v16" />
        </>
      );
    case "chevron":
      return <path d="M6 9.5l6 5 6-5" />;
    case "skip-back":
      return (
        <>
          <path d="M18.5 6v12l-9-6z" />
          <path d="M6 5.5v13" />
        </>
      );
    case "skip-forward":
      return (
        <>
          <path d="M5.5 6v12l9-6z" />
          <path d="M18 5.5v13" />
        </>
      );
    case "play":
      return <path d="M8.5 6.2l9 5.8-9 5.8z" fill="currentColor" stroke="none" />;
    case "pause":
      return (
        <>
          <rect x="8" y="6" width="3" height="12" rx="1" fill="currentColor" stroke="none" />
          <rect x="13" y="6" width="3" height="12" rx="1" fill="currentColor" stroke="none" />
        </>
      );
    case "scissors":
      return (
        <>
          <circle cx="6.5" cy="18" r="2.3" />
          <circle cx="6.5" cy="6" r="2.3" />
          <path d="M8.3 7.4L19 18M8.3 16.6L19 6" />
        </>
      );
    case "zoom-out":
      return (
        <>
          <circle cx="10.5" cy="10.5" r="6" />
          <path d="M15 15l5 5M8 10.5h5" />
        </>
      );
    case "zoom-in":
      return (
        <>
          <circle cx="10.5" cy="10.5" r="6" />
          <path d="M15 15l5 5M8 10.5h5M10.5 8v5" />
        </>
      );
    case "picture":
      return (
        <>
          <rect x="3.5" y="5" width="17" height="14" rx="2" />
          <circle cx="9" cy="10" r="1.6" />
          <path d="M4.5 17l4.8-4.4 3.4 3 2.6-2.3 4.2 3.7" />
        </>
      );
    case "speaker":
      return (
        <>
          <path d="M5 10h3l4-3.5v11L8 14H5z" />
          <path d="M15.5 9.2a4 4 0 0 1 0 5.6" />
          <path d="M18 7a7.5 7.5 0 0 1 0 10" />
        </>
      );
    case "video":
      return (
        <>
          <rect x="2.5" y="6" width="13" height="12" rx="2" />
          <path d="M15.5 11l5-3v8l-5-3z" />
        </>
      );
    case "plus":
      return <path d="M12 5.5v13M5.5 12h13" />;
    case "close":
      return <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />;
    case "search":
      return (
        <>
          <circle cx="10.5" cy="10.5" r="6" />
          <path d="M15 15l5 5" />
        </>
      );
  }
}

/* ------------------------------------------------------- backdrop presets */

/** 7 colour pairs per category; every visual is a pure CSS gradient. */
const PALETTES: Record<BackdropCategory, [string, string][]> = {
  macOS: [
    ["#6d8bff", "#c86dd7"],
    ["#ff9a8b", "#ff6a88"],
    ["#43cea2", "#185a9d"],
    ["#fbc2eb", "#a6c1ee"],
    ["#f6d365", "#fda085"],
    ["#5ee7df", "#b490ca"],
    ["#30cfd0", "#330867"],
  ],
  Dark: [
    ["#232526", "#414345"],
    ["#0f2027", "#2c5364"],
    ["#1c1c24", "#3a3a52"],
    ["#111827", "#374151"],
    ["#141e30", "#243b55"],
    ["#16222a", "#3a6073"],
    ["#000000", "#434343"],
  ],
  Blue: [
    ["#2193b0", "#6dd5ed"],
    ["#1e3c72", "#2a5298"],
    ["#396cd8", "#89c6ff"],
    ["#0093e9", "#80d0c7"],
    ["#4facfe", "#00f2fe"],
    ["#13547a", "#80d0c7"],
    ["#2563eb", "#1e40af"],
  ],
  Cities: [
    ["#f5af19", "#f12711"],
    ["#3a1c71", "#ffaf7b"],
    ["#485563", "#29323c"],
    ["#7f7fd5", "#91eae4"],
    ["#c31432", "#240b36"],
    ["#eacda3", "#d6ae7b"],
    ["#42275a", "#734b6d"],
  ],
  Purple: [
    ["#8e2de2", "#4a00e0"],
    ["#a18cd1", "#fbc2eb"],
    ["#6a11cb", "#2575fc"],
    ["#c471f5", "#fa71cd"],
    ["#7028e4", "#e5b2ca"],
    ["#654ea3", "#eaafc8"],
    ["#5f2c82", "#49a09d"],
  ],
  Orange: [
    ["#ff7e5f", "#feb47b"],
    ["#f83600", "#f9d423"],
    ["#ffb75e", "#ed8f03"],
    ["#ff512f", "#f09819"],
    ["#fc4a1a", "#f7b733"],
    ["#e65c00", "#f9d423"],
    ["#cb2d3e", "#ef473a"],
  ],
};

function swatchGradient(category: BackdropCategory, index: number): string {
  const [a, b] = PALETTES[category][index] ?? PALETTES[category][0];
  return `linear-gradient(135deg, ${a} 0%, ${b} 100%)`;
}

function backdropFor(
  kind: BackdropKind,
  category: BackdropCategory,
  index: number,
): string {
  const [a, b] = PALETTES[category][index] ?? PALETTES[category][0];
  switch (kind) {
    case "Desktop":
      return "linear-gradient(160deg, #dfe6f2 0%, #b9c6dd 50%, #8fa2c4 100%)";
    case "Wallpaper":
      return `linear-gradient(135deg, ${a} 0%, ${b} 100%)`;
    case "Image":
      return (
        `radial-gradient(60% 70% at 20% 20%, ${a} 0%, transparent 65%),` +
        `radial-gradient(70% 80% at 80% 30%, ${b} 0%, transparent 70%),` +
        `radial-gradient(80% 80% at 50% 90%, ${a}bb 0%, transparent 70%),` +
        `linear-gradient(160deg, ${b} 0%, ${a} 100%)`
      );
    case "Color":
      return `linear-gradient(${a}, ${a})`;
    case "Gradient":
      return `linear-gradient(to bottom right, ${a} 0%, ${b} 55%, ${a} 100%)`;
    case "None":
      return "none";
  }
}

/* ---------------------------------------------------------------- helpers */

function formatTimecode(seconds: number): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const m = Math.floor(safe / 60);
  const s = Math.floor(safe % 60);
  const hundredths = Math.floor((safe % 1) * 100);
  return `${m}:${s.toString().padStart(2, "0")}.${hundredths
    .toString()
    .padStart(2, "0")}`;
}

/** Ruler tick label: 0:00, 0:05, 1:00 … */
function formatTick(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function kindIcon(kind: MediaKind): IconName {
  if (kind === "image") return "picture";
  if (kind === "audio") return "speaker";
  return "video";
}

function kindLabel(kind: MediaKind): string {
  if (kind === "image") return "Image";
  if (kind === "audio") return "Audio";
  return "Video";
}

type SidebarTab = "media" | "audio" | "background";

const SIDEBAR_TABS: { id: SidebarTab; label: string }[] = [
  { id: "media", label: "Media" },
  { id: "audio", label: "Audio" },
  { id: "background", label: "Background" },
];

const FALLBACK_TIMELINE_SECONDS = 30;

/** Width of the track-name column. Shared by the CSS (as `--ed-side`) and
 * by the playhead maths, which has to skip past it. */
const TRACK_LABEL_WIDTH = 110;

/** One track row plus the gap above it — mirrors `.ed-trackrow` in
 * editor.css, so the playhead can be made to end exactly at the last
 * track instead of running on past it. */
const TRACK_ROW_PITCH = 43;

/** Drag payload types. Custom media types keep timeline drags apart from
 * anything else the OS might drop on the window, and are readable in
 * `dataTransfer.types` during dragover — where `getData` returns "". */
const MEDIA_MIME = "application/x-jdeditor-media";
const CLIP_MIME = "application/x-jdeditor-clip";

/** What is currently being dragged. `dataTransfer` carries the same thing,
 * but only the drop event may read it, so the grab offset and the preview
 * width are kept here as well. */
type DragPayload =
  | {
      kind: "media";
      mediaPath: string;
      durationSeconds: number;
      grabSeconds: number;
    }
  | {
      kind: "clip";
      clipId: string;
      durationSeconds: number;
      grabSeconds: number;
    };

/** Where the clip being dragged would land, so the lane can show it. */
interface DropTarget {
  trackId: string;
  startSeconds: number;
  durationSeconds: number;
}

/** How long a clip runs on the timeline when its media never reported a
 * duration — a still has none, and a video still being probed has none
 * yet. */
function clipSecondsFor(item: MediaItem | undefined): number {
  const duration = item?.durationSeconds;
  return typeof duration === "number" && duration > 0
    ? duration
    : DEFAULT_CLIP_SECONDS;
}

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/* -------------------------------------------------------------- media row */

function MediaRow({
  item,
  isActive,
  onSelect,
  onRemove,
  onDragStart,
  onDragEnd,
}: {
  item: MediaItem;
  isActive: boolean;
  onSelect: () => void;
  onRemove: () => void;
  onDragStart: (e: DragEvent<HTMLElement>) => void;
  onDragEnd: () => void;
}) {
  const duration = formatDuration(item.durationSeconds);
  return (
    <div
      className={`ed-mediarow ${isActive ? "is-active" : ""}`}
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      title="Drag onto a track to place it on the timeline"
    >
      <button
        className="ed-mediarow-main"
        title={item.path}
        onClick={onSelect}
        draggable
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
      >
        <span className="ed-mediarow-thumb">
          {item.status === "preparing" ? (
            <span className="spinner" />
          ) : item.thumbnailPath ? (
            <img src={convertFileSrc(item.thumbnailPath)} alt="" />
          ) : (
            <Icon name={kindIcon(item.kind)} />
          )}
        </span>
        <span className="ed-mediarow-text">
          <span className="ed-mediarow-name">{item.name}</span>
          <span className="ed-mediarow-meta">
            {item.status === "preparing"
              ? "Preparing…"
              : duration || kindLabel(item.kind)}
          </span>
        </span>
      </button>
      <button
        className="ed-mediarow-remove"
        title={`Remove ${item.name} from the project`}
        aria-label={`Remove ${item.name} from the project`}
        onClick={onRemove}
      >
        <Icon name="close" />
      </button>
    </div>
  );
}

/* ------------------------------------------------------------- component */

export function EditorShell({
  media,
  activeMediaPath,
  projectName,
  isDirty,
  settings,
  onSettingsChange,
  onSelectMedia,
  onImportMedia,
  onRemoveMedia,
  onNewProject,
  onOpenProject,
  onSaveProject,
  onSaveProjectAs,
  onCloseProject,
  tracks,
  selectedClipId,
  onSelectClip,
  onAddTrack,
  onAddClip,
  onMoveClip,
  onRemoveClip,
}: EditorShellProps) {
  const [toast, setToast] = useState<string | null>(null);
  const [showInspector, setShowInspector] = useState(true);
  const [showTimeline, setShowTimeline] = useState(true);
  const [activeTab, setActiveTab] = useState<SidebarTab>("media");

  // Timeline drag-and-drop. The payload lives in a ref because dragover
  // fires dozens of times a second and none of it should re-render; only
  // the drop indicator is state.
  const dragRef = useRef<DragPayload | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);

  // Appearance and timeline zoom live in the project now, so every one of
  // them is read from props and written back through onSettingsChange.
  const { backdropKind, category, swatch, padding, rounded, timelineZoom } = settings;

  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  // Reads the latest settings out of a ref so the callback identity stays
  // stable — the zoom nudger is referenced from the View menu and from the
  // playbar, and re-creating it every render would churn them both.
  const patchSettings = useCallback(
    (patch: Partial<EditorSettings>) => {
      onSettingsChange({ ...settingsRef.current, ...patch });
    },
    [onSettingsChange],
  );

  // Playback state.
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [videoDuration, setVideoDuration] = useState(0);
  /** Written to directly while playing — see the animation-frame effect. */
  const timecodeRef = useRef<HTMLSpanElement | null>(null);
  const playheadRef = useRef<HTMLDivElement | null>(null);
  const timelineScrollRef = useRef<HTMLDivElement | null>(null);
  const rulerRef = useRef<HTMLDivElement | null>(null);
  const [scrubbing, setScrubbing] = useState(false);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 2200);
    return () => window.clearTimeout(t);
  }, [toast]);

  const comingSoon = useCallback((feature: string) => {
    setToast(`${feature} is coming in a future update.`);
  }, []);

  // The File menu advertises Ctrl+S, so it has to actually work.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (e.shiftKey) onSaveProjectAs();
        else onSaveProject();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onSaveProject, onSaveProjectAs]);

  // Delete / Backspace removes the selected clip. Typing anywhere that
  // takes text — the project name field, a slider's number box, anything
  // contenteditable — must never lose a clip instead of a character.
  useEffect(() => {
    const clipId = selectedClipId;
    if (!clipId) return;
    // An arrow const, not a hoisted declaration, so the narrowing above
    // still holds inside it.
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      const focused = document.activeElement;
      if (
        focused instanceof HTMLInputElement ||
        focused instanceof HTMLTextAreaElement ||
        focused instanceof HTMLSelectElement ||
        (focused instanceof HTMLElement && focused.isContentEditable)
      ) {
        return;
      }
      e.preventDefault();
      onRemoveClip(clipId);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [selectedClipId, onRemoveClip]);

  const deleteSelectedClip = useCallback(() => {
    if (!selectedClipId) {
      setToast("Select a clip on the timeline first.");
      return;
    }
    onRemoveClip(selectedClipId);
  }, [selectedClipId, onRemoveClip]);

  const selectedMedia = media.find((m) => m.path === activeMediaPath) ?? null;
  const visualMedia = media.filter((m) => m.kind !== "audio");
  const audioMedia = media.filter((m) => m.kind === "audio");

  /** The timeline is as long as what has been laid out on it — the end of
   * the furthest clip on any track — and falls back to a fixed span while
   * it is still empty. It is no longer tied to the previewed clip: the
   * tracks are the edit, the preview is just a viewer. */
  const timelineSeconds = useMemo(() => {
    let end = 0;
    for (const track of tracks) {
      for (const clip of track.clips) {
        end = Math.max(end, clip.startSeconds + clip.durationSeconds);
      }
    }
    return end > 0 ? end : FALLBACK_TIMELINE_SECONDS;
  }, [tracks]);

  /** With nothing laid out, the timeline has no time to point at — the
   * playhead would otherwise run along an empty ruler while the preview
   * plays a clip that isn't on any track. */
  const timelineHasClips = useMemo(
    () => tracks.some((track) => track.clips.length > 0),
    [tracks],
  );

  /** Every clip in playing order. Where two tracks overlap in time the
   * upper track wins, the way a stack of video layers would. */
  const orderedClips = useMemo(
    () =>
      tracks
        .flatMap((track, depth) => track.clips.map((clip) => ({ clip, depth })))
        .sort((a, b) => a.clip.startSeconds - b.clip.startSeconds || a.depth - b.depth),
    [tracks],
  );

  /** The clip sitting under a point on the timeline, if any. */
  const clipAt = useCallback(
    (seconds: number) =>
      orderedClips.find(
        ({ clip }) =>
          seconds >= clip.startSeconds &&
          seconds < clip.startSeconds + clip.durationSeconds,
      )?.clip ?? null,
    [orderedClips],
  );

  /** The first clip starting at or after a point, for skipping the gaps. */
  const clipFrom = useCallback(
    (seconds: number) =>
      orderedClips.find(({ clip }) => clip.startSeconds >= seconds - 0.001)?.clip ?? null,
    [orderedClips],
  );

  // What the preview shows is decided by the playhead, not by the sidebar:
  // the red line and the picture have to be describing the same moment.
  // Only when nothing has been laid out yet does the sidebar selection
  // stand in, so imported media can still be looked at before placing it.
  const previewClip = timelineHasClips ? clipAt(currentTime) : null;
  const previewMedia = timelineHasClips
    ? (previewClip ? (media.find((m) => m.path === previewClip.mediaPath) ?? null) : null)
    : selectedMedia;

  /** Only video drives the playhead; a still or a bare audio file has no
   * frame clock for the timeline to follow. */
  const drivesPlayback = previewMedia == null || previewMedia.kind === "video";

  const totalSeconds = timelineHasClips
    ? timelineSeconds
    : videoDuration > 0
      ? videoDuration
      : typeof selectedMedia?.durationSeconds === "number" &&
          selectedMedia.durationSeconds > 0
        ? selectedMedia.durationSeconds
        : 0;

  // Keep the picture on the moment the playhead is pointing at, whenever
  // the playhead is moved by anything other than playback itself.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !previewClip || isPlaying) return;
    const within = Math.max(0, currentTime - previewClip.startSeconds);
    if (Math.abs(video.currentTime - within) > 0.05) video.currentTime = within;
  }, [previewClip, currentTime, isPlaying]);

  // Starting a fresh preview source resets the readings.
  useEffect(() => {
    setVideoDuration(0);
  }, [previewMedia?.path]);

  // How wide the timeline can actually be seen, which is what the zoom
  // range is measured against. The track-name column is inside the same
  // scroller, so it is discounted here.
  const [viewportWidth, setViewportWidth] = useState(0);
  useEffect(() => {
    const element = timelineScrollRef.current;
    if (!element) return;
    const lanes = (width: number) => Math.max(0, width - TRACK_LABEL_WIDTH);
    setViewportWidth(lanes(element.clientWidth));

    const observer = new ResizeObserver((entries) => {
      setViewportWidth(lanes(entries[0].contentRect.width));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [showTimeline]);

  // Zoomed all the way out, the whole clip spans half the visible width;
  // every 25 points on the slider doubles that, so 25 is "fits exactly".
  const minTrackWidth = Math.max(200, Math.round(viewportWidth / 2));
  const trackWidth = Math.round(minTrackWidth * Math.pow(2, timelineZoom / 25));

  /** The one scale every clip, tick and drop position is measured with. */
  const pixelsPerSecond = timelineSeconds > 0 ? trackWidth / timelineSeconds : 0;

  const timeToPixels = useCallback(
    (seconds: number) =>
      timelineSeconds > 0
        ? Math.max(0, Math.min(trackWidth, (seconds / timelineSeconds) * trackWidth))
        : 0,
    [timelineSeconds, trackWidth],
  );

  // The video element's `timeupdate` event only fires about four times a
  // second, which is why the hundredths and the playhead moved in visible
  // steps. While playing, both are driven off animation frames instead —
  // and written straight to the DOM, because re-rendering the whole editor
  // sixty times a second to move one line and one label is wasteful.
  useEffect(() => {
    // Images and audio-only clips never mount a <video>; with nothing to
    // read a clock off, there is nothing for this loop to paint.
    if (!isPlaying || !videoRef.current) return;
    let frame = 0;

    // The media clock only moves when a new video frame is presented —
    // roughly 30 times a second — so on a 60Hz display it would repeat a
    // position, then jump, which reads as a tremble. Between those
    // updates the position is carried forward by wall-clock time.
    let clockTime = videoRef.current.currentTime;
    let clockAt = performance.now();

    const paint = () => {
      const video = videoRef.current;
      if (video) {
        const now = performance.now();
        if (video.currentTime !== clockTime) {
          clockTime = video.currentTime;
          clockAt = now;
        }
        const limit = Number.isFinite(video.duration) ? video.duration : timelineSeconds;
        const within = video.paused
          ? clockTime
          : Math.min(limit, clockTime + ((now - clockAt) / 1000) * video.playbackRate);

        // Playback is reported in timeline time, not in the previewed
        // file's own time, so the playhead and the picture agree.
        const at = previewClip ? previewClip.startSeconds + within : within;

        // Run off the end of this clip and playback moves to the next one
        // laid out after it, or stops if that was the last.
        if (previewClip && within >= previewClip.durationSeconds - 0.03) {
          const next = clipFrom(previewClip.startSeconds + previewClip.durationSeconds);
          video.pause();
          setCurrentTime(next ? next.startSeconds : previewClip.startSeconds + previewClip.durationSeconds);
          setIsPlaying(Boolean(next));
          return;
        }

        if (timecodeRef.current) {
          timecodeRef.current.textContent = formatTimecode(at);
        }

        const offset = timeToPixels(at);
        if (playheadRef.current) {
          playheadRef.current.style.transform = `translateX(${offset}px)`;
        }

        // Zoomed in far enough the playhead runs off the edge; follow it
        // so the moving part stays on screen. The track-name column sits
        // at the head of the same scroller and covers the first
        // TRACK_LABEL_WIDTH pixels of it, so the playhead has to be kept
        // clear of that too.
        const scroll = timelineScrollRef.current;
        if (scroll) {
          const x = TRACK_LABEL_WIDTH + offset;
          const margin = Math.max(24, scroll.clientWidth * 0.15);
          if (x < scroll.scrollLeft + TRACK_LABEL_WIDTH + margin) {
            scroll.scrollLeft = x - TRACK_LABEL_WIDTH - margin;
          } else if (x > scroll.scrollLeft + scroll.clientWidth - margin) {
            scroll.scrollLeft = x - scroll.clientWidth + margin;
          }
        }
      }
      frame = requestAnimationFrame(paint);
    };

    frame = requestAnimationFrame(paint);
    return () => cancelAnimationFrame(frame);
  }, [isPlaying, timelineSeconds, timeToPixels, previewClip, clipFrom]);

  // Carrying on into the next clip: once its source is loaded, pick up
  // where the playhead says and keep playing.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !isPlaying || !previewClip) return;
    const within = Math.max(0, currentTime - previewClip.startSeconds);
    if (Math.abs(video.currentTime - within) > 0.3) video.currentTime = within;
    if (video.paused) void video.play().catch(() => setIsPlaying(false));
  }, [isPlaying, previewClip, currentTime]);

  const nudgeZoom = useCallback(
    (by: number) => {
      patchSettings({
        timelineZoom: Math.min(100, Math.max(0, settingsRef.current.timelineZoom + by)),
      });
    },
    [patchSettings],
  );

  function togglePlay() {
    // Pressing play while the playhead sits in a gap starts from the next
    // clip along, rather than doing nothing at a point with no picture.
    if (timelineHasClips && !previewClip) {
      const next = clipFrom(currentTime) ?? clipFrom(0);
      if (!next) return;
      setCurrentTime(next.startSeconds);
      setIsPlaying(true);
      return;
    }

    const v = videoRef.current;
    if (!v) {
      setToast(
        media.length === 0
          ? "Import a clip first, then press play."
          : timelineHasClips
            ? "Drag a clip onto a track to play it."
            : "Select a ready clip to play it.",
      );
      return;
    }
    if (v.paused) {
      void v.play().catch(() => setToast("This clip could not be played."));
    } else {
      v.pause();
    }
  }

  function seekTo(seconds: number) {
    const v = videoRef.current;
    if (!v) {
      setToast("Select a ready clip first.");
      return;
    }
    const dur = Number.isFinite(v.duration) ? v.duration : 0;
    v.currentTime = Math.max(0, Math.min(seconds, dur));
    setCurrentTime(v.currentTime);
  }

  /** Where along the timeline a pointer is, in seconds. */
  const secondsAtPointer = useCallback(
    (clientX: number) => {
      const ruler = rulerRef.current;
      if (!ruler || trackWidth <= 0) return 0;
      const bounds = ruler.getBoundingClientRect();
      const ratio = (clientX - bounds.left) / trackWidth;
      return Math.max(0, Math.min(timelineSeconds, ratio * timelineSeconds));
    },
    [trackWidth, timelineSeconds],
  );

  /** Moves the playhead to a point on the timeline, bringing the preview
   * with it as far as it can go. Deliberately not `seekTo`: the timeline
   * runs as long as its furthest clip, which can be longer than whichever
   * single clip is being previewed — clamping the playhead to that one
   * clip's duration would leave it stuck partway through a drag. It also
   * can't raise a toast per mouse-move the way `seekTo` would. */
  const scrubTo = useCallback(
    (seconds: number) => {
      const at = Math.max(0, Math.min(timelineSeconds, seconds));
      setCurrentTime(at);

      const video = videoRef.current;
      const duration = video && Number.isFinite(video.duration) ? video.duration : 0;
      if (video && duration > 0) video.currentTime = Math.min(at, duration);
    },
    [timelineSeconds],
  );

  /** Scrubbing: press anywhere on the ruler (or grab the playhead) and
   * drag to move playback to that point in time. */
  function startScrub(event: ReactMouseEvent) {
    if (event.button !== 0) return;
    event.preventDefault();
    scrubTo(secondsAtPointer(event.clientX));

    const onMove = (moveEvent: MouseEvent) => {
      scrubTo(secondsAtPointer(moveEvent.clientX));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      setScrubbing(false);
    };

    setScrubbing(true);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  const mediaByPath = useMemo(
    () => new Map(media.map((item) => [item.path, item])),
    [media],
  );

  /* -------------------------------------------------- timeline dragging */

  /** Seconds at the pointer inside a lane, with the grab offset taken off
   * so a clip keeps the spot it was picked up by instead of snapping its
   * head to the cursor. Never negative: nothing sits before zero. */
  function dropSecondsFor(e: DragEvent<HTMLElement>, grabSeconds: number) {
    if (pixelsPerSecond <= 0) return 0;
    const rect = e.currentTarget.getBoundingClientRect();
    const seconds = (e.clientX - rect.left) / pixelsPerSecond;
    return Math.max(0, seconds - grabSeconds);
  }

  function endDrag() {
    dragRef.current = null;
    setIsDragging(false);
    setDropTarget(null);
  }

  function handleMediaDragStart(e: DragEvent<HTMLElement>, item: MediaItem) {
    dragRef.current = {
      kind: "media",
      mediaPath: item.path,
      durationSeconds: clipSecondsFor(item),
      grabSeconds: 0,
    };
    setIsDragging(true);
    e.dataTransfer.effectAllowed = "copy";
    e.dataTransfer.setData(MEDIA_MIME, item.path);
  }

  function handleClipDragStart(e: DragEvent<HTMLElement>, clip: TimelineClip) {
    const rect = e.currentTarget.getBoundingClientRect();
    dragRef.current = {
      kind: "clip",
      clipId: clip.id,
      durationSeconds: clip.durationSeconds,
      grabSeconds:
        pixelsPerSecond > 0 ? (e.clientX - rect.left) / pixelsPerSecond : 0,
    };
    setIsDragging(true);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData(CLIP_MIME, clip.id);
    onSelectClip(clip.id);
  }

  function handleLaneDragOver(e: DragEvent<HTMLElement>, trackId: string) {
    const payload = dragRef.current;
    const types = e.dataTransfer.types;
    if (!payload && !types.includes(MEDIA_MIME) && !types.includes(CLIP_MIME)) {
      return;
    }
    // Without this the browser never fires `drop` at all.
    e.preventDefault();
    e.dataTransfer.dropEffect = payload?.kind === "clip" ? "move" : "copy";

    const startSeconds = dropSecondsFor(e, payload?.grabSeconds ?? 0);
    const durationSeconds = payload?.durationSeconds ?? DEFAULT_CLIP_SECONDS;
    setDropTarget((current) =>
      // Same lane, same pixel: keep the old object so the editor doesn't
      // re-render on every one of the many dragover events.
      current &&
      current.trackId === trackId &&
      current.durationSeconds === durationSeconds &&
      Math.abs(current.startSeconds - startSeconds) * pixelsPerSecond < 1
        ? current
        : { trackId, startSeconds, durationSeconds },
    );
  }

  function handleLaneDrop(e: DragEvent<HTMLElement>, trackId: string) {
    e.preventDefault();
    const payload = dragRef.current;
    const startSeconds = dropSecondsFor(e, payload?.grabSeconds ?? 0);
    // The payload is only readable off dataTransfer here, in the drop
    // itself; the ref is the fallback for a drag that began elsewhere.
    const clipId =
      e.dataTransfer.getData(CLIP_MIME) ||
      (payload?.kind === "clip" ? payload.clipId : "");
    const mediaPath =
      e.dataTransfer.getData(MEDIA_MIME) ||
      (payload?.kind === "media" ? payload.mediaPath : "");
    endDrag();

    if (clipId) onMoveClip(clipId, trackId, startSeconds);
    else if (mediaPath) onAddClip(trackId, mediaPath, startSeconds);
  }

  const menus: MenuDef[] = [
    {
      label: "File",
      items: [
        { label: "New Project", onClick: onNewProject },
        { label: "Open Project...", onClick: onOpenProject },
        {
          label: "Save Project",
          onClick: onSaveProject,
          shortcut: "Ctrl+S",
          separatorBefore: true,
        },
        {
          label: "Save Project As...",
          onClick: onSaveProjectAs,
          shortcut: "Ctrl+Shift+S",
        },
        {
          label: "Import Media...",
          onClick: () => onImportMedia("visual"),
          separatorBefore: true,
        },
        { label: "Import Audio...", onClick: () => onImportMedia("audio") },
        { label: "Close Project", onClick: onCloseProject, separatorBefore: true },
      ],
    },
    {
      label: "Edit",
      items: [
        // No shortcut labels until these do something: advertising a key
        // that silently does nothing is worse than showing no key.
        { label: "Undo", onClick: () => comingSoon("Undo") },
        { label: "Redo", onClick: () => comingSoon("Redo") },
        { label: "Cut", onClick: () => comingSoon("Cut"), separatorBefore: true },
        { label: "Copy", onClick: () => comingSoon("Copy") },
        { label: "Paste", onClick: () => comingSoon("Paste") },
        {
          // This one does work now, so it gets to advertise its key.
          label: "Delete Clip",
          onClick: deleteSelectedClip,
          shortcut: "Del",
          separatorBefore: true,
        },
        { label: "Add Track", onClick: onAddTrack },
      ],
    },
    {
      label: "View",
      items: [
        {
          label: showInspector ? "Hide Inspector" : "Show Inspector",
          onClick: () => setShowInspector((v) => !v),
        },
        {
          label: showTimeline ? "Hide Timeline" : "Show Timeline",
          onClick: () => setShowTimeline((v) => !v),
        },
        {
          label: "Zoom Timeline In",
          onClick: () => nudgeZoom(12.5),
          separatorBefore: true,
        },
        { label: "Zoom Timeline Out", onClick: () => nudgeZoom(-12.5) },
      ],
    },
  ];

  const backdrop = backdropFor(backdropKind, category, swatch);
  const stageStyle: CSSProperties = {
    ["--ed-backdrop" as string]: backdrop,
    ["--ed-pad" as string]: `${padding}px`,
    ["--ed-radius" as string]: `${rounded}px`,
  };

  // Tick every 1/2/5/10/… seconds — whichever keeps the labels far enough
  // apart to stay readable at the current zoom.
  const ruler = useMemo(() => {
    const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
    const perSecond = trackWidth / timelineSeconds;
    const step = steps.find((s) => s * perSecond >= 70) ?? steps[steps.length - 1];

    const marks: number[] = [];
    for (let s = 0; s <= Math.ceil(timelineSeconds); s += step) marks.push(s);
    return marks;
  }, [timelineSeconds, trackWidth]);

  const playheadOffset = timeToPixels(currentTime);

  /** The gradient and padding only make sense behind a picture frame. */
  const framed =
    previewMedia != null &&
    (previewMedia.status === "preparing" || previewMedia.kind !== "audio");

  return (
    <div className="ed-shell">
      {/* ------------------------------------------------------- top bar */}
      <header className="ed-topbar">
        <MenuBar menus={menus} />

        <button
          className="ed-iconbtn"
          title="Delete project"
          onClick={() => comingSoon("Delete project")}
        >
          <Icon name="trash" />
        </button>

        <div className="ed-topbar-group">
          <button
            className="ed-iconbtn"
            title="Undo"
            onClick={() => comingSoon("Undo")}
          >
            <Icon name="undo" />
          </button>
          <button
            className="ed-iconbtn"
            title="Redo"
            onClick={() => comingSoon("Redo")}
          >
            <Icon name="redo" />
          </button>
        </div>

        <div className="ed-spacer" />

        <button className="ed-pill" onClick={() => comingSoon("Clips library")}>
          <Icon name="clips" />
          <span>Clips</span>
        </button>
        <button
          className="ed-pill ed-pill-primary"
          onClick={() => comingSoon("Export")}
        >
          <Icon name="export" />
          <span>Export</span>
        </button>
      </header>

      {/* ---------------------------------------------------- middle row */}
      <div className="ed-middle">
        <main className="ed-stage">
          {/* stage toolbar */}
          <div className="ed-stage-toolbar">
            <div className="ed-stage-toolbar-left">
              <button className="ed-chipbtn" onClick={() => comingSoon("Auto layout")}>
                <Icon name="wand" />
                <span>Auto</span>
                <Icon name="chevron" className="ed-caret" />
              </button>
              <button className="ed-chipbtn" onClick={() => comingSoon("Crop")}>
                <Icon name="crop" />
                <span>Crop</span>
              </button>
              <button className="ed-chipbtn" onClick={() => comingSoon("Frame")}>
                <Icon name="frame" />
                <span>Frame</span>
                <Icon name="chevron" className="ed-caret" />
              </button>
            </div>
            <div className="ed-stage-toolbar-right">
              <span className="ed-muted">Preview quality</span>
              <button
                className="ed-chipbtn"
                onClick={() => comingSoon("Preview quality")}
              >
                <span>Full</span>
                <Icon name="chevron" className="ed-caret" />
              </button>
            </div>
          </div>

          {/* preview canvas */}
          <div className="ed-canvas">
            <div
              className={`ed-backdrop ${framed ? "" : "is-empty"}`}
              style={stageStyle}
            >
              {previewMedia == null ? (
                <div className="ed-preview-state">
                  <p>
                    {media.length === 0
                      ? "Import media to get started."
                      : timelineHasClips
                        ? "Nothing on the timeline at this point — move the playhead onto a clip."
                        : "Select a clip in the Media panel to preview it."}
                  </p>
                  {media.length === 0 && (
                    <button
                      className="ed-pill ed-pill-primary"
                      onClick={() => onImportMedia("visual")}
                    >
                      <Icon name="plus" />
                      <span>Import media</span>
                    </button>
                  )}
                </div>
              ) : previewMedia.status === "preparing" ? (
                <div className="ed-preview-state">
                  <span className="spinner spinner-lg" />
                  <p>Preparing {kindLabel(previewMedia.kind).toLowerCase()} for editing…</p>
                </div>
              ) : previewMedia.kind === "video" ? (
                <video
                  key={previewMedia.path}
                  ref={videoRef}
                  className="ed-video"
                  src={convertFileSrc(previewMedia.path)}
                  onLoadedMetadata={(e) => {
                    const v = e.currentTarget;
                    setVideoDuration(Number.isFinite(v.duration) ? v.duration : 0);
                    setCurrentTime(v.currentTime);
                  }}
                  onTimeUpdate={(e) => {
                    // While playing, animation frames own the readout; a
                    // state update here would re-render on top of them
                    // four times a second and snap the playhead back to a
                    // stale position. Seeks while paused still land here.
                    if (e.currentTarget.paused) {
                      setCurrentTime(e.currentTarget.currentTime);
                    }
                  }}
                  onDurationChange={(e) => {
                    const d = e.currentTarget.duration;
                    setVideoDuration(Number.isFinite(d) ? d : 0);
                  }}
                  onPlay={() => setIsPlaying(true)}
                  onPause={(e) => {
                    // Hand the final position back to React, so what's
                    // rendered matches where playback actually stopped.
                    setCurrentTime(e.currentTarget.currentTime);
                    setIsPlaying(false);
                  }}
                  onEnded={(e) => {
                    setCurrentTime(e.currentTarget.currentTime);
                    setIsPlaying(false);
                  }}
                  onClick={togglePlay}
                />
              ) : previewMedia.kind === "image" ? (
                <img
                  key={previewMedia.path}
                  className="ed-still"
                  src={convertFileSrc(previewMedia.path)}
                  alt={previewMedia.name}
                />
              ) : (
                <div className="ed-audio-stage">
                  <Icon name="speaker" className="ed-audio-glyph" />
                  <p className="ed-audio-name" title={previewMedia.name}>
                    {previewMedia.name}
                  </p>
                  <audio
                    key={previewMedia.path}
                    className="ed-audio-player"
                    src={convertFileSrc(previewMedia.path)}
                    controls
                  />
                </div>
              )}
            </div>
          </div>

          {/* playback controls */}
          <div className="ed-playbar">
            <div className="ed-timecode">
              <span ref={timecodeRef}>
                {formatTimecode(drivesPlayback ? currentTime : 0)}
              </span>{" "}
              <span className="ed-timecode-sep">/</span>{" "}
              {formatTimecode(totalSeconds)}
            </div>

            <div className="ed-playbar-center">
              <button
                className="ed-iconbtn"
                title="Jump to start"
                disabled={!drivesPlayback}
                onClick={() => seekTo(0)}
              >
                <Icon name="skip-back" />
              </button>
              <button
                className="ed-playbtn"
                title={
                  drivesPlayback
                    ? isPlaying
                      ? "Pause"
                      : "Play"
                    : previewMedia?.kind === "audio"
                      ? "Use the player on the stage to hear this track"
                      : "A still image has nothing to play"
                }
                disabled={!drivesPlayback}
                onClick={togglePlay}
              >
                <Icon name={isPlaying ? "pause" : "play"} />
              </button>
              <button
                className="ed-iconbtn"
                title="Jump to end"
                disabled={!drivesPlayback}
                onClick={() => seekTo(totalSeconds)}
              >
                <Icon name="skip-forward" />
              </button>

              <span className="ed-divider" />

              <button
                className="ed-iconbtn"
                title="Split clip"
                onClick={() => comingSoon("Split")}
              >
                <Icon name="scissors" />
              </button>

              <span className="ed-divider" />

              <div className="ed-zoom">
                <button
                  className="ed-iconbtn ed-iconbtn-sm"
                  title="Zoom out"
                  onClick={() => nudgeZoom(-12.5)}
                  disabled={timelineZoom <= 0}
                >
                  <Icon name="zoom-out" />
                </button>
                <input
                  className="ed-range ed-range-sm"
                  type="range"
                  min={0}
                  max={100}
                  value={timelineZoom}
                  style={{ ["--ed-fill" as string]: `${timelineZoom}%` }}
                  onChange={(e) =>
                    patchSettings({ timelineZoom: Number(e.currentTarget.value) })
                  }
                  aria-label="Timeline zoom"
                />
                <button
                  className="ed-iconbtn ed-iconbtn-sm"
                  title="Zoom in"
                  onClick={() => nudgeZoom(12.5)}
                  disabled={timelineZoom >= 100}
                >
                  <Icon name="zoom-in" />
                </button>
              </div>
            </div>

            <div className="ed-playbar-right" />
          </div>
        </main>

        {/* ------------------------------------------------- inspector */}
        {showInspector && (
          <aside className="ed-inspector">
            <div className="ed-tabs">
              {SIDEBAR_TABS.map((tab) => (
                <button
                  key={tab.id}
                  className={`ed-tab ${activeTab === tab.id ? "is-active" : ""}`}
                  aria-pressed={activeTab === tab.id}
                  onClick={() => setActiveTab(tab.id)}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            <div className="ed-inspector-body">
              {activeTab === "media" && (
                <>
                  <div className="ed-projectline">
                    <Icon name="folder" className="ed-project-icon" />
                    <span className="ed-project-name" title={projectName}>
                      {projectName}
                    </span>
                    {isDirty && (
                      <span
                        className="ed-dirty"
                        title="Unsaved changes"
                        aria-label="Unsaved changes"
                      />
                    )}
                  </div>

                  <div className="ed-section-head">
                    <h3 className="ed-section-title">Media</h3>
                    <button
                      className="ed-chipbtn"
                      onClick={() => onImportMedia("visual")}
                    >
                      <Icon name="plus" />
                      <span>Import</span>
                    </button>
                  </div>

                  {visualMedia.length === 0 ? (
                    <div className="ed-medialist-empty">
                      <p>No videos or images in this project yet.</p>
                      <button
                        className="ed-pill ed-pill-primary"
                        onClick={() => onImportMedia("visual")}
                      >
                        <Icon name="plus" />
                        <span>Import media</span>
                      </button>
                    </div>
                  ) : (
                    <div className="ed-medialist">
                      {visualMedia.map((item) => (
                        <MediaRow
                          key={item.path}
                          item={item}
                          isActive={item.path === activeMediaPath}
                          onSelect={() => onSelectMedia(item.path)}
                          onRemove={() => onRemoveMedia(item.path)}
                          onDragStart={(e) => handleMediaDragStart(e, item)}
                          onDragEnd={endDrag}
                        />
                      ))}
                    </div>
                  )}
                </>
              )}

              {activeTab === "audio" && (
                <>
                  <div className="ed-section-head">
                    <h3 className="ed-section-title">Audio</h3>
                    <button
                      className="ed-chipbtn"
                      onClick={() => onImportMedia("audio")}
                    >
                      <Icon name="plus" />
                      <span>Import audio</span>
                    </button>
                  </div>

                  {audioMedia.length === 0 ? (
                    <div className="ed-medialist-empty">
                      <p>No audio tracks in this project yet.</p>
                      <button
                        className="ed-pill ed-pill-primary"
                        onClick={() => onImportMedia("audio")}
                      >
                        <Icon name="plus" />
                        <span>Import audio</span>
                      </button>
                    </div>
                  ) : (
                    <div className="ed-medialist">
                      {audioMedia.map((item) => (
                        <MediaRow
                          key={item.path}
                          item={item}
                          isActive={item.path === activeMediaPath}
                          onSelect={() => onSelectMedia(item.path)}
                          onRemove={() => onRemoveMedia(item.path)}
                          onDragStart={(e) => handleMediaDragStart(e, item)}
                          onDragEnd={endDrag}
                        />
                      ))}
                    </div>
                  )}
                </>
              )}

              {activeTab === "background" && (
                <>
                  <h3 className="ed-section-title">Background Image</h3>

                  <div className="ed-kind-grid">
                    {BACKDROP_KINDS.map((kind) => (
                      <button
                        key={kind}
                        className={`ed-kind ${backdropKind === kind ? "is-active" : ""}`}
                        onClick={() => patchSettings({ backdropKind: kind })}
                      >
                        <span className="ed-kind-dot" />
                        <span>{kind}</span>
                      </button>
                    ))}
                  </div>

                  <div className="ed-cat-row">
                    {BACKDROP_CATEGORIES.map((cat) => (
                      <button
                        key={cat}
                        className={`ed-cat ${category === cat ? "is-active" : ""}`}
                        onClick={() => patchSettings({ category: cat })}
                      >
                        {cat}
                      </button>
                    ))}
                  </div>

                  <div className="ed-swatches">
                    {PALETTES[category].map((_pair, i) => (
                      <button
                        key={i}
                        className={`ed-swatch ${swatch === i ? "is-active" : ""}`}
                        style={{ backgroundImage: swatchGradient(category, i) }}
                        aria-label={`Background ${i + 1}`}
                        aria-pressed={swatch === i}
                        onClick={() => patchSettings({ swatch: i })}
                      />
                    ))}
                  </div>

                  <div className="ed-field">
                    <label className="ed-field-label" htmlFor="ed-padding">
                      Padding
                    </label>
                    <input
                      id="ed-padding"
                      className="ed-range"
                      type="range"
                      min={0}
                      max={120}
                      value={padding}
                      style={{ ["--ed-fill" as string]: `${(padding / 120) * 100}%` }}
                      onChange={(e) =>
                        patchSettings({ padding: Number(e.currentTarget.value) })
                      }
                    />
                  </div>

                  <div className="ed-field">
                    <label className="ed-field-label" htmlFor="ed-rounded">
                      Rounded Corners
                    </label>
                    <input
                      id="ed-rounded"
                      className="ed-range"
                      type="range"
                      min={0}
                      max={48}
                      value={rounded}
                      style={{ ["--ed-fill" as string]: `${(rounded / 48) * 100}%` }}
                      onChange={(e) =>
                        patchSettings({ rounded: Number(e.currentTarget.value) })
                      }
                    />
                  </div>

                  <p className="ed-note">
                    Background, padding and corners affect this preview.
                  </p>
                </>
              )}
            </div>
          </aside>
        )}
      </div>

      {/* ------------------------------------------------------ timeline */}
      {showTimeline && (
        <footer className="ed-timeline">
          {/* One scroller for both axes, with the track-name column stuck
              to its left edge and the ruler stuck to its top. That is what
              keeps a name beside its lane however far the timeline is
              scrolled, and lets the rows grow past the visible height. */}
          <div
            className="ed-timeline-scroll"
            ref={timelineScrollRef}
            onClick={(e) => {
              if (e.target === e.currentTarget) onSelectClip(null);
            }}
          >
            <div
              className="ed-timeline-inner"
              style={{ width: TRACK_LABEL_WIDTH + trackWidth }}
              onClick={(e) => {
                if (e.target === e.currentTarget) onSelectClip(null);
              }}
            >
              <div className="ed-rulerrow">
                <div className="ed-rulerrow-side">
                  <button
                    className="ed-addtrack"
                    title="Add another track"
                    onClick={onAddTrack}
                  >
                    <Icon name="plus" />
                    <span>Add track</span>
                  </button>
                </div>
                <div
                  className={`ed-ruler ${scrubbing ? "is-scrubbing" : ""}`}
                  ref={rulerRef}
                  style={{ width: trackWidth }}
                  onMouseDown={startScrub}
                  title="Drag to move playback"
                >
                  {ruler.map((s) => (
                    <span
                      key={s}
                      className="ed-tick"
                      style={{ left: `${(s / timelineSeconds) * 100}%` }}
                    >
                      <i className="ed-tick-line" />
                      <em className="ed-tick-label">{formatTick(s)}</em>
                    </span>
                  ))}
                </div>
              </div>

              {tracks.map((track) => {
                const isTarget = dropTarget != null && dropTarget.trackId === track.id;
                return (
                  <div className="ed-trackrow" key={track.id}>
                    <div className="ed-tracklabel">
                      <Icon name="video" />
                      <span className="ed-tracklabel-name" title={track.name}>
                        {track.name}
                      </span>
                    </div>

                    <div
                      className={`ed-lane ${isDragging ? "is-dragging" : ""} ${
                        isTarget ? "is-dropping" : ""
                      }`}
                      style={{ width: trackWidth }}
                      onDragOver={(e) => handleLaneDragOver(e, track.id)}
                      onDragLeave={() =>
                        setDropTarget((current) =>
                          current?.trackId === track.id ? null : current,
                        )
                      }
                      onDrop={(e) => handleLaneDrop(e, track.id)}
                      onClick={(e) => {
                        if (e.target === e.currentTarget) onSelectClip(null);
                      }}
                    >
                      {track.clips.length === 0 && !isTarget && (
                        <span className="ed-lane-hint">
                          Drag media from the panel onto this track
                        </span>
                      )}

                      {track.clips.map((clip) => {
                        const item = mediaByPath.get(clip.mediaPath);
                        const preparing = item?.status === "preparing";
                        const kind = item?.kind ?? mediaKindFor(clip.mediaPath);
                        const label = item?.name ?? fileName(clip.mediaPath);
                        const isSelected = clip.id === selectedClipId;
                        return (
                          <div
                            key={clip.id}
                            className={`ed-clip ${isSelected ? "is-selected" : ""} ${
                              preparing ? "is-preparing" : ""
                            }`}
                            style={{
                              left: clip.startSeconds * pixelsPerSecond,
                              width: Math.max(
                                8,
                                clip.durationSeconds * pixelsPerSecond,
                              ),
                            }}
                            role="button"
                            tabIndex={0}
                            aria-pressed={isSelected}
                            title={`${label} — ${
                              formatDuration(clip.durationSeconds) || "--:--"
                            } at ${formatTick(clip.startSeconds)}`}
                            draggable
                            onDragStart={(e) => handleClipDragStart(e, clip)}
                            onDragEnd={endDrag}
                            onClick={() => onSelectClip(clip.id)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault();
                                onSelectClip(clip.id);
                              }
                            }}
                          >
                            <span className="ed-clip-wave" aria-hidden="true" />
                            <span className="ed-clip-head">
                              {preparing ? (
                                <span className="spinner" />
                              ) : item?.thumbnailPath ? (
                                <img
                                  className="ed-clip-thumb"
                                  src={convertFileSrc(item.thumbnailPath)}
                                  alt=""
                                />
                              ) : (
                                <Icon
                                  name={kindIcon(kind)}
                                  className="ed-clip-glyph"
                                />
                              )}
                              <span className="ed-clip-name">{label}</span>
                            </span>
                            <span className="ed-clip-badges">
                              <span className="ed-clip-badge">
                                {preparing
                                  ? "Preparing…"
                                  : formatDuration(clip.durationSeconds) || "--:--"}
                              </span>
                            </span>
                          </div>
                        );
                      })}

                      {isTarget && dropTarget && (
                        <div
                          className="ed-dropmark"
                          aria-hidden="true"
                          style={{
                            left: dropTarget.startSeconds * pixelsPerSecond,
                            width: Math.max(
                              8,
                              dropTarget.durationSeconds * pixelsPerSecond,
                            ),
                          }}
                        >
                          <span className="ed-dropmark-time">
                            {formatTimecode(dropTarget.startSeconds)}
                          </span>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}

              {tracks.length === 0 && (
                <div className="ed-trackrow">
                  <div className="ed-tracklabel is-empty" />
                  <div className="ed-lane-none" style={{ width: trackWidth }}>
                    No tracks yet — add one, then drag media onto it.
                  </div>
                </div>
              )}

              {/* Second way in to the same action: a ghost row that reads
                  as "another track goes here". */}
              <button
                className="ed-addrow"
                title="Add another track"
                onClick={onAddTrack}
              >
                <span className="ed-addrow-side" aria-hidden="true" />
                <span className="ed-addrow-lane" style={{ width: trackWidth }}>
                  <Icon name="plus" />
                  <span>Add track</span>
                </span>
              </button>

              {timelineHasClips && (
                <div
                  className="ed-playhead"
                  ref={playheadRef}
                  style={{
                    transform: `translateX(${playheadOffset}px)`,
                    height: tracks.length * TRACK_ROW_PITCH,
                  }}
                >
                  <span
                    className="ed-playhead-knob"
                    onMouseDown={startScrub}
                    title="Drag to move playback"
                  />
                </div>
              )}
            </div>
          </div>
        </footer>
      )}

      {toast && <div className="editor-toast">{toast}</div>}
    </div>
  );
}
