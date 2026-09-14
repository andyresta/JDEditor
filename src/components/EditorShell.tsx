import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { audioGraph } from "../audioGraph";
import { drawTextLayer } from "../textLayer";
import { MenuBar, type MenuDef } from "./MenuBar";
import {
  BACKDROP_CATEGORIES,
  BACKDROP_KINDS,
  FULL_FRAME_LAYOUT,
  MAX_ZOOM,
  isTextClip,
  layoutAt,
  DEFAULT_CLIP_SECONDS,
  formatDuration,
  formatGainDb,
  toMillis,
  gainAt,
  gainForPosition,
  mediaKindFor,
  peakHeight,
  positionForGain,
  volumePointsOf,
  type BackdropCategory,
  type BackdropKind,
  type ClipLayout,
  type EditorSettings,
  type MediaItem,
  trackHeightOf,
  trackKindOf,
  TRACK_HEIGHT,
  TRACK_HEIGHT_MAX,
  TRACK_HEIGHT_MIN,
  TRACK_HEIGHT_TALL,
  type AudioPeaks,
  type MediaKind,
  type TextStyle,
  type VolumePoint,
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
  /** Points the project at a file that has moved. */
  onRelinkMedia: (path: string) => void;
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
  /** `atSeconds` is the clip's own time, which is what a zoom point is
   * measured in. */
  onUpdateClipLayout: (clipId: string, layout: ClipLayout, atSeconds: number) => void;
  onAddLayoutPoint: (clipId: string, atSeconds: number, layout: ClipLayout) => void;
  onAddTextClip: (trackId: string, atSeconds: number) => void;
  onUpdateText: (clipId: string, text: TextStyle) => void;
  onRemoveLayoutPoint: (clipId: string, atSeconds: number) => void;
  onToggleClipMute: (clipId: string) => void;
  onSplitClipAudio: (clipId: string) => void;
  onUpdateClipVolume: (clipId: string, points: VolumePoint[] | undefined) => void;
  /** Each file's loudness envelope, by path, as it arrives. */
  audioPeaks: Map<string, AudioPeaks>;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onExport: () => void;
  clipboardHasClip: boolean;
  onCopyClip: (clipId: string) => void;
  onPasteClip: (trackId: string, seconds: number) => void;
  onDuplicateClip: (clipId: string) => void;
  /** Moves one edge of a clip to a moment on the timeline. */
  onTrimClip: (clipId: string, edge: "start" | "end", seconds: number) => void;
  onResizeTrack: (trackId: string, height: number | undefined) => void;
  /** Cuts at a moment on the timeline — one clip by id, or every clip
   * under the playhead. Answers with how many were cut. */
  onCutAt: (atSeconds: number, clipId?: string) => number;
}

/** Where the volume line sits inside a clip, top and bottom, as a
 * percentage of its height. Full volume is held clear of the very top edge
 * so the line stays visible when it is flat, and silence clear of the
 * bottom so a point there can still be grabbed. */
const VOLUME_TOP = 17;
const VOLUME_BOTTOM = 86;

function volumeY(gain: number): number {
  return VOLUME_TOP + (1 - positionForGain(gain)) * (VOLUME_BOTTOM - VOLUME_TOP);
}

/** Where on the line a height inside the clip falls, 0 at the bottom to 1
 * at the top. */
function positionAtY(percent: number): number {
  return clamp(1 - (percent - VOLUME_TOP) / (VOLUME_BOTTOM - VOLUME_TOP), 0, 1);
}

/** How close an edge has to come to something worth meeting before it is
 * taken there exactly. In pixels, so it feels the same however far the
 * timeline is zoomed in. */
const SNAP_PIXELS = 6;

/** Below this width a clip is all handle and nothing else, so the handles
 * step aside and leave it draggable. */
const TRIM_HANDLE_PX = 7;
const TRIM_MIN_CLIP_PX = 26;

/** How many columns a waveform is drawn with. Past this the extra detail
 * is finer than the pixels it is drawn into. */
const WAVE_COLUMNS = 320;

/** How finely the volume line is sampled when drawn. The line isn't drawn
 * by joining its points up — it is drawn by asking the same function
 * playback asks, at this many places across the clip, so the curve on
 * screen is the curve that is heard rather than an impression of it. */
const VOLUME_SAMPLES = 96;

function volumeCurve(points: VolumePoint[], durationSeconds: number): string {
  const path: string[] = [];
  for (let i = 0; i <= VOLUME_SAMPLES; i += 1) {
    const along = i / VOLUME_SAMPLES;
    const gain = gainAt(points, along * durationSeconds);
    path.push(`${(along * 100).toFixed(2)},${volumeY(gain).toFixed(2)}`);
  }
  return path.join(" ");
}

/** A clip covering the playhead, ready to be drawn: what it plays, how
 * high it sits in the stack, and where in the frame it goes. */
interface Layer {
  clip: TimelineClip;
  item: MediaItem;
  /** Index of the track it came from. 0 is the bottom of the stack. */
  depth: number;
  layout: ClipLayout;
  /** Whether it can be moved about the frame. The stand-in layer shown for
   * a sidebar selection isn't part of the edit, so it can't be. */
  movable: boolean;
  /** Heard but not seen: an audio file, or a clip on an audio track. */
  audioOnly: boolean;
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

/** Whether the keyboard currently belongs to a field rather than to the
 * editor — a shortcut must never eat a character someone is typing. */
function isTyping(): boolean {
  const focused = document.activeElement;
  return (
    focused instanceof HTMLInputElement ||
    focused instanceof HTMLTextAreaElement ||
    focused instanceof HTMLSelectElement ||
    (focused instanceof HTMLElement && focused.isContentEditable)
  );
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
  // Counted in hundredths from the start and split up from there. Taking
  // the pieces apart with `%` and `floor` instead reads a hundredth low
  // whenever the division lands just under a whole one — 7.35 seconds
  // came out as 0:07.34, because 7.35 % 1 is 0.34999999999999964.
  const total = Math.round(safe * 100);
  const minutes = Math.floor(total / 6000);
  const remainder = total % 6000;
  const whole = Math.floor(remainder / 100);
  const hundredths = remainder % 100;
  return `${minutes}:${whole.toString().padStart(2, "0")}.${hundredths
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

type SidebarTab = "media" | "audio" | "text" | "background";

const SIDEBAR_TABS: { id: SidebarTab; label: string }[] = [
  { id: "media", label: "Media" },
  { id: "audio", label: "Audio" },
  { id: "text", label: "Text" },
  { id: "background", label: "Background" },
];

/** One title, drawn on a canvas the size of the stage.
 *
 * A canvas rather than styled markup so that the preview and the exported
 * frame are the same drawing: the renderer is handed a picture made by
 * this very function at the export's own size. Text laid out by the
 * browser and text laid out by ffmpeg would never have matched. */
function TextLayerCanvas({
  text,
  layout,
  width,
  height,
}: {
  text: TextStyle;
  layout: ClipLayout;
  width: number;
  height: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || width <= 0 || height <= 0) return;
    // Drawn at the screen's own pixel density, or the words would be soft.
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(ratio, ratio);
    drawTextLayer(ctx, text, layout, width, height);
  }, [text, layout, width, height]);

  return (
    <canvas
      ref={canvasRef}
      className="ed-text-canvas"
      style={{ width, height }}
      aria-label={text.content}
    />
  );
}

const FALLBACK_TIMELINE_SECONDS = 30;

/** Width of the track-name column. Shared by the CSS (as `--ed-side`) and
 * by the playhead maths, which has to skip past it. */
const TRACK_LABEL_WIDTH = 132;

/** Drag payload types. Custom media types keep timeline drags apart from
 * anything else the OS might drop on the window, and are readable in
 * `dataTransfer.types` during dragover — where `getData` returns "". */
const MEDIA_MIME = "application/x-jdeditor-media";
const CLIP_MIME = "application/x-jdeditor-clip";

/** What is currently being dragged. `dataTransfer` carries the same thing,
 * but only the drop event may read it, so the grab offset and the preview
 * width are kept here as well. */
interface DragBase {
  durationSeconds: number;
  grabSeconds: number;
  /** Every moment this drag should be pulled towards, gathered once when
   * it begins rather than on each of the many dragover events. */
  snapMarks: number[];
}

type DragPayload =
  | ({ kind: "media"; mediaPath: string } & DragBase)
  | ({ kind: "clip"; clipId: string } & DragBase);

/** Where the clip being dragged would land, so the lane can show it. */
interface DropTarget {
  trackId: string;
  startSeconds: number;
  durationSeconds: number;
  /** Whether it was pulled onto something rather than left where the
   * pointer was, so the lane can say so. */
  snapped: boolean;
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
  onRelink,
  onDragStart,
  onDragEnd,
}: {
  item: MediaItem;
  isActive: boolean;
  onSelect: () => void;
  onRemove: () => void;
  onRelink: () => void;
  onDragStart: (e: DragEvent<HTMLElement>) => void;
  onDragEnd: () => void;
}) {
  const duration = formatDuration(item.durationSeconds);
  const missing = item.status === "missing";
  return (
    <div
      className={`ed-mediarow ${isActive ? "is-active" : ""} ${
        item.kind === "audio" ? "is-audio" : ""
      } ${missing ? "is-missing" : ""}`}
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
            {missing
              ? "Not where it was — click Find"
              : item.status === "preparing"
                ? "Preparing…"
                : duration || kindLabel(item.kind)}
          </span>
        </span>
      </button>
      {missing && (
        <button
          className="ed-mediarow-find"
          title={`Find ${item.name}`}
          onClick={onRelink}
        >
          Find
        </button>
      )}
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
  onRelinkMedia,
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
  onUpdateClipLayout,
  onAddLayoutPoint,
  onRemoveLayoutPoint,
  onAddTextClip,
  onUpdateText,
  onToggleClipMute,
  onSplitClipAudio,
  onUpdateClipVolume,
  audioPeaks,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onExport,
  clipboardHasClip,
  onCopyClip,
  onPasteClip,
  onDuplicateClip,
  onTrimClip,
  onResizeTrack,
  onCutAt,
}: EditorShellProps) {
  const [toast, setToast] = useState<string | null>(null);
  /** Ctrl+K is bound once, for the life of the editor; it reaches the
   * current cut through here rather than re-binding on every render. */
  const cutAtPlayheadRef = useRef<(clipId?: string) => void>(() => {});
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
      // The ref is advanced here rather than waiting for the next render,
      // so two changes made before React gets a turn build on each other
      // instead of the second one dropping the first.
      settingsRef.current = { ...settingsRef.current, ...patch };
      onSettingsChange(settingsRef.current);
    },
    [onSettingsChange],
  );

  // Playback state.
  /** Every mounted layer's media element, by clip id. A stack of layers
   * means a stack of <video>s, all of them kept at the same moment. */
  const layerMedia = useRef(new Map<string, HTMLMediaElement>());
  /** One ref callback per clip, cached so its identity doesn't change
   * between renders.
   *
   * An inline `ref={(el) => ...}` is a different function every render, so
   * React hands the element back and re-takes it every time — dozens of
   * times a second during a drag. That is harmless for a lookup table and
   * fatal for the gain stage: an element can be routed through Web Audio
   * only once, so one that is handed back and then asked for again ends up
   * playing into a graph that has been taken apart, which is to say
   * silent. */
  const layerRefs = useRef(new Map<string, (el: HTMLMediaElement | null) => void>());
  /** The positioned box of each layer on the stage. A zoom is written
   * straight to these while playing, the way the playhead is: re-rendering
   * the editor sixty times a second to move one picture would bring back
   * the stutter that taking the playhead off React fixed. */
  const layerBoxes = useRef(new Map<string, HTMLElement>());
  const layerBoxRefs = useRef(new Map<string, (el: HTMLElement | null) => void>());
  const layerBoxRef = useCallback((clipId: string) => {
    const cached = layerBoxRefs.current.get(clipId);
    if (cached) return cached;
    const keep = (element: HTMLElement | null) => {
      if (element) {
        layerBoxes.current.set(clipId, element);
      } else {
        layerBoxes.current.delete(clipId);
        layerBoxRefs.current.delete(clipId);
      }
    };
    layerBoxRefs.current.set(clipId, keep);
    return keep;
  }, []);
  const layerRef = useCallback((clipId: string) => {
    const cached = layerRefs.current.get(clipId);
    if (cached) return cached;
    const keep = (element: HTMLMediaElement | null) => {
      if (element) {
        layerMedia.current.set(clipId, element);
        return;
      }
      // Really gone: React has unmounted it.
      const going = layerMedia.current.get(clipId);
      if (going) audioGraph.release(going);
      layerMedia.current.delete(clipId);
      layerRefs.current.delete(clipId);
    };
    layerRefs.current.set(clipId, keep);
    return keep;
  }, []);
  /** The master clock: where the timeline was when playback last started
   * or jumped, and the wall-clock reading at that instant. Everything on
   * screen is derived from these two numbers.
   *
   * The clock is deliberately not read off a video. Playback has to carry
   * on across a gap where no video is mounted at all, and several layers
   * playing at once have no single clock between them — so wall time
   * leads and the layers are kept in step with it. */
  const clockRef = useRef({ wall: 0, at: 0 });
  /** Bumped on every seek, purely to restart the animation loop. */
  const [clockEpoch, setClockEpoch] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [videoDuration, setVideoDuration] = useState(0);
  /** Written to directly while playing — see the animation-frame effect. */
  const timecodeRef = useRef<HTMLSpanElement | null>(null);
  const playheadRef = useRef<HTMLDivElement | null>(null);
  const timelineScrollRef = useRef<HTMLDivElement | null>(null);
  const rulerRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  /** The block of track rows. Measured rather than worked out from a row
   * height, because rows can each be dragged to their own height — the
   * playhead has to stop exactly at the last of them either way. */
  const tracksRef = useRef<HTMLDivElement | null>(null);
  const [tracksHeight, setTracksHeight] = useState(0);
  /** The stage's size in pixels. A title is measured against the frame's
   * height, so it has to be known before one can be drawn. */
  const [frameSize, setFrameSize] = useState({ width: 0, height: 0 });
  const [scrubbing, setScrubbing] = useState(false);
  /** The transport keys reach the current handlers through here, so they
   * can be bound once for the life of the editor rather than rebound on
   * every render. */
  const transportRef = useRef({
    play: () => {},
    step: (_frames: number) => {},
    goTo: (_seconds: number) => {},
    end: 0,
  });
  /** Which layer is under the pointer right now, so the stage can show it
   * as being handled rather than as being played. */
  const [draggingLayerId, setDraggingLayerId] = useState<string | null>(null);
  /** The clip whose volume line is being dragged. While one is under way
   * that clip must stop being draggable, or the browser would start
   * sliding it along its track instead of moving the line. */
  const [volumeClipId, setVolumeClipId] = useState<string | null>(null);
  /** The track row whose height is being dragged. */
  const [resizingTrackId, setResizingTrackId] = useState<string | null>(null);
  /** The clip whose edge is being dragged, which must stop being draggable
   * while that is happening or the browser would slide it along its track
   * instead of trimming it. */
  const [trimmingClipId, setTrimmingClipId] = useState<string | null>(null);
  /** The clip menu raised by a right-click, and where to put it. */
  const [clipMenu, setClipMenu] = useState<{
    clipId: string;
    x: number;
    y: number;
  } | null>(null);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 2200);
    return () => window.clearTimeout(t);
  }, [toast]);

  const comingSoon = useCallback((feature: string) => {
    setToast(`${feature} is coming in a future update.`);
  }, []);

  // The menus advertise these keys, so they have to actually work.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      // Ctrl+Z belongs to whatever is being typed in, if anything is.
      if (isTyping()) return;
      const key = e.key.toLowerCase();

      if (key === "s") {
        e.preventDefault();
        if (e.shiftKey) onSaveProjectAs();
        else onSaveProject();
        return;
      }
      if (key === "k") {
        e.preventDefault();
        cutAtPlayheadRef.current();
        return;
      }
      if (key === "z") {
        e.preventDefault();
        // Shift+Ctrl+Z is redo on Windows and on the Mac alike; Ctrl+Y is
        // the other habit, handled below.
        if (e.shiftKey) onRedo();
        else onUndo();
        return;
      }
      if (key === "y") {
        e.preventDefault();
        onRedo();
        return;
      }
      if (key === "c" || key === "x") {
        e.preventDefault();
        clipboardRef.current.copy(key === "x");
        return;
      }
      if (key === "v") {
        e.preventDefault();
        clipboardRef.current.paste();
        return;
      }
      if (key === "d") {
        e.preventDefault();
        clipboardRef.current.duplicate();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onSaveProject, onSaveProjectAs, onUndo, onRedo]);

  // The transport keys every editor has. Bound once — the handlers they
  // reach are read from a ref, so this doesn't have to be torn down and
  // rebuilt whenever the playhead moves.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.ctrlKey || e.metaKey || e.altKey || isTyping()) return;
      const transport = transportRef.current;

      switch (e.key) {
        case " ":
          // Taken before the browser can give it to whichever button was
          // last clicked, which would otherwise toggle playback twice.
          e.preventDefault();
          transport.play();
          return;
        case "ArrowLeft":
        case "ArrowRight": {
          e.preventDefault();
          const direction = e.key === "ArrowRight" ? 1 : -1;
          // Shift covers ground: a second at a time rather than a frame.
          transport.step(e.shiftKey ? direction * 10 : direction);
          return;
        }
        case "Home":
          e.preventDefault();
          transport.goTo(0);
          return;
        case "End":
          e.preventDefault();
          transport.goTo(transport.end);
          return;
        default:
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

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
      if (isTyping()) return;
      e.preventDefault();
      onRemoveClip(clipId);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [selectedClipId, onRemoveClip]);

  /** Where a paste lands: on the track holding whatever is selected, or
   * the first track when nothing is, and at the playhead. */
  function pasteTarget(): string | null {
    const withSelection = tracks.find((track) =>
      track.clips.some((clip) => clip.id === selectedClipId),
    );
    return (withSelection ?? tracks[0])?.id ?? null;
  }

  function copySelectedClip(alsoRemove: boolean) {
    if (!selectedClipId) {
      setToast("Select a clip on the timeline first.");
      return;
    }
    onCopyClip(selectedClipId);
    if (alsoRemove) onRemoveClip(selectedClipId);
    setToast(alsoRemove ? "Clip cut." : "Clip copied.");
  }

  function pasteClip() {
    if (!clipboardHasClip) {
      setToast("Nothing has been copied yet.");
      return;
    }
    const trackId = pasteTarget();
    if (!trackId) {
      setToast("Add a track to paste onto.");
      return;
    }
    onPasteClip(trackId, toMillis(currentTime));
  }

  function duplicateSelectedClip() {
    if (!selectedClipId) {
      setToast("Select a clip on the timeline first.");
      return;
    }
    onDuplicateClip(selectedClipId);
  }

  // Reached from the keyboard through a ref, so the shortcuts can be bound
  // once rather than rebound whenever the selection or the playhead moves.
  const clipboardRef = useRef({
    copy: (_cut: boolean) => {},
    paste: () => {},
    duplicate: () => {},
  });
  clipboardRef.current = {
    copy: copySelectedClip,
    paste: pasteClip,
    duplicate: duplicateSelectedClip,
  };

  const deleteSelectedClip = useCallback(() => {
    if (!selectedClipId) {
      setToast("Select a clip on the timeline first.");
      return;
    }
    onRemoveClip(selectedClipId);
  }, [selectedClipId, onRemoveClip]);

  const selectedMedia = media.find((m) => m.path === activeMediaPath) ?? null;
  /** Files the project remembers but cannot find. Said out loud rather
   * than left to be discovered as a clip that plays nothing. */
  const missingMedia = media.filter((item) => item.status === "missing");
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

  const mediaByPath = useMemo(
    () => new Map(media.map((item) => [item.path, item])),
    [media],
  );

  /** Everything covering the playhead right now, bottom of the stack
   * first. One clip per track — a track plays one thing at a time — and
   * the tracks below the first in the list are drawn over it, so a clip
   * dropped on "Track 2" lays over whatever "Track 1" is showing. */
  const activeLayers = useMemo<Layer[]>(() => {
    if (!timelineHasClips) return [];
    const layers: Layer[] = [];
    // Only video tracks take a place in the stack; an audio track sitting
    // between two of them must not push the one below it off the bottom
    // layer and into being an inset overlay.
    let depth = -1;
    for (const track of tracks) {
      const isAudioTrack = trackKindOf(track) === "audio";
      if (!isAudioTrack) depth += 1;

      const clip = track.clips.find(
        (c) =>
          currentTime >= c.startSeconds &&
          currentTime < c.startSeconds + c.durationSeconds,
      );
      if (!clip) continue;

      // A title has no file behind it, so it stands in as a still: silent,
      // with a picture, and with nothing to read a waveform from. Only the
      // drawing of it is different.
      const item = isTextClip(clip)
        ? ({
            path: "",
            name: clip.text?.content.split(String.fromCharCode(10))[0] || "Title",
            kind: "image",
            status: "ready",
          } as MediaItem)
        : mediaByPath.get(clip.mediaPath);
      if (!item) continue;

      // Sound or picture is the clip's own nature, not the lane's: a video
      // dragged onto an audio track is still a video, while the half that
      // Split Audio lifted off one stays sound wherever it is put.
      const audioOnly = Boolean(clip.soundOnly) || item.kind === "audio";
      layers.push({
        clip,
        item,
        depth: audioOnly ? 0 : depth,
        layout: layoutAt(clip, currentTime - clip.startSeconds),
        movable: !audioOnly,
        audioOnly,
      });
    }
    return layers;
  }, [tracks, currentTime, timelineHasClips, mediaByPath]);

  /** What the stage actually shows. With nothing laid out yet the sidebar
   * selection stands in as a single layer, so imported media can still be
   * looked at before it is placed — but it isn't part of the edit, so it
   * can't be moved around the frame. */
  const previewLayers = useMemo<Layer[]>(() => {
    if (timelineHasClips) return activeLayers;
    if (!selectedMedia) return [];
    return [
      {
        clip: {
          id: `preview:${selectedMedia.path}`,
          mediaPath: selectedMedia.path,
          startSeconds: 0,
          durationSeconds: selectedMedia.durationSeconds ?? DEFAULT_CLIP_SECONDS,
        },
        item: selectedMedia,
        depth: 0,
        layout: FULL_FRAME_LAYOUT,
        movable: false,
        audioOnly: selectedMedia.kind === "audio",
      },
    ];
  }, [timelineHasClips, activeLayers, selectedMedia]);

  /** Audio plays but has nothing to draw, so it is kept out of the stack
   * and mounted on its own. */
  const visualLayers = previewLayers.filter((layer) => !layer.audioOnly);
  const audioLayers = previewLayers.filter((layer) => layer.audioOnly);

  /** A bare audio file selected in the sidebar still gets the old card,
   * with its own transport — there is no timeline to scrub against. */
  const audioCard =
    !timelineHasClips && selectedMedia?.kind === "audio" ? selectedMedia : null;

  /** Every moment the set of layers changes: a clip starting, a clip
   * ending. The clock stops at each of these to let the stack be rebuilt,
   * which is what makes a clip on a second track appear partway through
   * the one underneath it. */
  const boundaries = useMemo(() => {
    const marks = new Set<number>();
    for (const track of tracks) {
      for (const clip of track.clips) {
        marks.add(clip.startSeconds);
        marks.add(clip.startSeconds + clip.durationSeconds);
      }
    }
    return [...marks].sort((a, b) => a - b);
  }, [tracks]);

  const totalSeconds = timelineHasClips
    ? timelineSeconds
    : videoDuration > 0
      ? videoDuration
      : typeof selectedMedia?.durationSeconds === "number" &&
          selectedMedia.durationSeconds > 0
        ? selectedMedia.durationSeconds
        : 0;

  /** Whether the transport has anything to drive. */
  const canPlay = timelineHasClips
    ? timelineSeconds > 0
    : selectedMedia != null &&
      selectedMedia.status === "ready" &&
      selectedMedia.kind === "video";

  /** Puts every mounted layer at a moment of timeline time. `tolerance` is
   * how far out of step a layer has to be before it is worth seeking: a
   * seek costs a decode, so during playback only real drift is corrected,
   * while a stopped playhead is placed exactly. */
  const syncLayers = useCallback((at: number, tolerance: number) => {
    for (const layer of sceneRef.current.layers) {
      const element = layerMedia.current.get(layer.clip.id);
      if (!element) continue;
      // How far into the clip we are, and — once it has been cut — how far
      // into its file that is. The volume line is drawn against the clip,
      // so it is read with the former and the file seeked with the latter.
      const elapsed = Math.max(0, at - layer.clip.startSeconds);
      const within = elapsed + (layer.clip.trimStartSeconds ?? 0);

      // Read at the same moment as the picture, so a fade lands exactly
      // where it was drawn. Mute is folded in here rather than left to
      // `element.muted`, because a boosted element no longer plays through
      // its own volume at all.
      const silent =
        Boolean(layer.clip.muted) ||
        (!layer.audioOnly && Boolean(layer.clip.audioDetached));
      const wanted = silent ? 0 : gainAt(layer.clip.volume, elapsed);

      // Above the level it was recorded at, a media element has no more to
      // give; those clips are routed through a gain stage instead. Once an
      // element is on that path it stays there, because the routing can't
      // be undone.
      const node =
        wanted > 1 || audioGraph.has(element) ? audioGraph.attach(element) : null;
      if (node) {
        element.muted = false;
        element.volume = 1;
        node.gain.value = wanted;
      } else {
        element.muted = silent;
        element.volume = Math.min(1, wanted);
      }

      // Past the end of the file the clip was cut from there is nothing to
      // seek to; leave it holding its last frame.
      const duration = element.duration;
      if (Number.isFinite(duration) && duration > 0 && within >= duration) continue;
      if (Math.abs(element.currentTime - within) > tolerance) {
        element.currentTime = within;
      }
    }
  }, []);

  /** Moves the playhead and restarts the clock from there. Every seek goes
   * through this: the clock is wall-clock based, so it has to be told when
   * the timeline jumps rather than inferring it. */
  const anchorClock = useCallback((at: number) => {
    clockRef.current = { wall: performance.now(), at };
    setClockEpoch((epoch) => epoch + 1);
  }, []);

  const movePlayhead = useCallback(
    (at: number) => {
      setCurrentTime(at);
      anchorClock(at);
    },
    [anchorClock],
  );

  // Opening a shorter project, or deleting the clip the playhead was over,
  // can leave it standing past the end of the timeline. Bring it back.
  useEffect(() => {
    if (isPlaying) return;
    // While a duration is still being read the limit is 0, which is not a
    // reason to move anything.
    const limit = timelineHasClips ? timelineSeconds : totalSeconds;
    if (limit > 0 && currentTime > limit) movePlayhead(limit);
  }, [timelineHasClips, timelineSeconds, totalSeconds, currentTime, isPlaying, movePlayhead]);

  // Place the layers whenever the playhead is moved by anything other than
  // playback: scrubbing, the transport, or a clip appearing under it.
  useEffect(() => {
    if (isPlaying) return;
    syncLayers(currentTime, 0.05);
  }, [previewLayers, currentTime, isPlaying, syncLayers]);

  // Start and stop every layer together.
  useEffect(() => {
    for (const layer of previewLayers) {
      const element = layerMedia.current.get(layer.clip.id);
      if (!element) continue;
      if (!isPlaying) {
        element.pause();
        continue;
      }
      if (element.paused) {
        // A browser keeps an audio context suspended until the page has
        // been interacted with; this press is that interaction.
        audioGraph.resume();
        void element.play().catch((error: unknown) => {
          // The stack is rebuilt every time a clip starts or ends, and a
          // layer taken off the stage mid-request aborts its own play().
          // That is its turn ending, not a failure to play — treating it
          // as one used to stop the whole timeline at the first clip
          // boundary.
          const name = error instanceof DOMException ? error.name : "";
          if (name === "AbortError" || !element.isConnected) return;
          setIsPlaying(false);
          setToast("This clip could not be played.");
        });
      }
    }
  }, [isPlaying, previewLayers]);

  // Starting a fresh preview source resets the readings.
  useEffect(() => {
    setVideoDuration(0);
  }, [selectedMedia?.path]);

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

  useEffect(() => {
    const element = stageRef.current;
    if (!element) return;
    const measure = () =>
      setFrameSize({ width: element.clientWidth, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [visualLayers.length]);

  useEffect(() => {
    const element = tracksRef.current;
    if (!element) return;
    setTracksHeight(element.offsetHeight);
    const observer = new ResizeObserver(() => setTracksHeight(element.offsetHeight));
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

  // Everything the animation loop reads, kept in a ref and refreshed every
  // render. The loop must not be torn down and rebuilt whenever a layer is
  // nudged around the frame — that would re-anchor the clock sixty times a
  // second while a layer is being dragged and playback would stand still.
  const sceneRef = useRef({
    layers: previewLayers,
    boundaries,
    limit: totalSeconds,
    timeToPixels,
    hasClips: timelineHasClips,
  });
  sceneRef.current = {
    layers: previewLayers,
    boundaries,
    limit: totalSeconds,
    timeToPixels,
    hasClips: timelineHasClips,
  };

  /** Paints the moving parts for a moment of timeline time. Written
   * straight to the DOM: re-rendering the whole editor sixty times a
   * second to move one line and one label is wasteful, and a React render
   * per frame is what used to make the playhead tremble. */
  const paintAt = useCallback((at: number) => {
    if (timecodeRef.current) {
      timecodeRef.current.textContent = formatTimecode(at);
    }

    // A clip that zooms is moved frame by frame here rather than through a
    // render; one that holds still already sits where React put it.
    for (const layer of sceneRef.current.layers) {
      if (layer.audioOnly || !layer.clip.layoutPoints?.length) continue;
      const box = layerBoxes.current.get(layer.clip.id);
      if (!box) continue;
      const framing = layoutAt(layer.clip, at - layer.clip.startSeconds);
      box.style.width = `${framing.scale * 100}%`;
      box.style.left = `${(0.5 + framing.x) * 100}%`;
      box.style.top = `${(0.5 + framing.y) * 100}%`;
    }
    if (!sceneRef.current.hasClips) return;

    const offset = sceneRef.current.timeToPixels(at);
    if (playheadRef.current) {
      playheadRef.current.style.transform = `translateX(${offset}px)`;
    }

    // Zoomed in far enough the playhead runs off the edge; follow it so
    // the moving part stays on screen. The track-name column sits at the
    // head of the same scroller and covers the first TRACK_LABEL_WIDTH
    // pixels of it, so the playhead has to be kept clear of that too.
    const scroll = timelineScrollRef.current;
    if (!scroll) return;
    const x = TRACK_LABEL_WIDTH + offset;
    const margin = Math.max(24, scroll.clientWidth * 0.15);
    if (x < scroll.scrollLeft + TRACK_LABEL_WIDTH + margin) {
      scroll.scrollLeft = x - TRACK_LABEL_WIDTH - margin;
    } else if (x > scroll.scrollLeft + scroll.clientWidth - margin) {
      scroll.scrollLeft = x - scroll.clientWidth + margin;
    }
  }, []);

  // The clock. While playing, wall time carries the playhead forward and
  // the layers are kept in step with it — so the playhead keeps moving
  // across a stretch of timeline with nothing on it, instead of skipping
  // to the next clip, and several layers stacked together stay together.
  //
  // It runs until the next moment that changes what is on screen: a clip
  // starting, a clip ending, or the end of the project. There it hands
  // back to React, which rebuilds the stack, and starts again.
  useEffect(() => {
    if (!isPlaying) return;
    const from = clockRef.current.at;
    const wall = clockRef.current.wall;
    const { boundaries: marks, limit } = sceneRef.current;
    const boundary = marks.find((mark) => mark > from + 0.001) ?? null;
    const stop =
      limit > 0 && (boundary == null || limit < boundary)
        ? { at: limit, ends: true }
        : boundary != null
          ? { at: boundary, ends: false }
          : null;

    let frame = 0;
    let timer = 0;
    let done = false;

    const finish = () => {
      if (done || !stop) return;
      done = true;
      setCurrentTime(stop.at);
      if (stop.ends) {
        clockRef.current = { wall: performance.now(), at: stop.at };
        setIsPlaying(false);
      } else {
        // Not the end: re-anchor and let this effect run again with the
        // stack rebuilt around the new moment.
        anchorClock(stop.at);
      }
    };

    const tick = () => {
      const at = from + (performance.now() - wall) / 1000;
      if (stop && at >= stop.at) {
        finish();
        return true;
      }
      paintAt(at);
      syncLayers(at, 0.35);
      return false;
    };

    const paint = () => {
      if (tick()) return;
      frame = requestAnimationFrame(paint);
    };

    // Animation frames stop entirely while the window isn't being painted,
    // which would leave a clip running long past its end. A timer aimed at
    // the next boundary is the backstop: it keeps firing when the frames
    // don't.
    if (stop) {
      timer = window.setTimeout(
        finish,
        Math.max(0, (stop.at - from) * 1000 - (performance.now() - wall)),
      );
    }
    frame = requestAnimationFrame(paint);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [isPlaying, clockEpoch, anchorClock, paintAt, syncLayers]);

  const nudgeZoom = useCallback(
    (by: number) => {
      patchSettings({
        timelineZoom: Math.min(100, Math.max(0, settingsRef.current.timelineZoom + by)),
      });
    },
    [patchSettings],
  );

  function togglePlay() {
    if (!canPlay) {
      setToast(
        media.length === 0
          ? "Import a clip first, then press play."
          : timelineHasClips
            ? "Drag a clip onto a track to play it."
            : "Select a ready clip to play it.",
      );
      return;
    }
    if (isPlaying) {
      // Stop where the clock actually is, not where the last render put it.
      const at = clockRef.current.at + (performance.now() - clockRef.current.wall) / 1000;
      movePlayhead(Math.max(0, Math.min(totalSeconds, at)));
      setIsPlaying(false);
      return;
    }
    // Pressing play at the very end starts over rather than doing nothing.
    const at = totalSeconds > 0 && currentTime >= totalSeconds - 0.01 ? 0 : currentTime;
    movePlayhead(at);
    setIsPlaying(true);
  }

  function seekTo(seconds: number) {
    if (!canPlay && !timelineHasClips) {
      setToast("Select a ready clip first.");
      return;
    }
    movePlayhead(Math.max(0, Math.min(totalSeconds, seconds)));
  }

  /** How long a frame is where the playhead stands.
   *
   * Taken from the clip under it rather than assumed, so a step really is
   * a frame: a 29.97fps recording and a 60fps one do not step by the same
   * amount. Falls back to a thirtieth of a second where nothing says
   * otherwise. */
  function frameSeconds(): number {
    const rate = previewLayers.find((layer) => !layer.audioOnly)?.item.frameRate;
    return typeof rate === "number" && rate > 0 ? 1 / rate : 1 / 30;
  }

  /** Moves the playhead by whole frames.
   *
   * Counted from the clock rather than from `currentTime`, which is a
   * render behind: three presses inside one tick would all read the same
   * stale position and the playhead would advance a single frame instead
   * of three. The clock is written the moment the playhead moves, so each
   * press builds on the one before it. */
  function stepFrames(frames: number) {
    const clock = clockRef.current;
    const from = isPlaying
      ? clock.at + (performance.now() - clock.wall) / 1000
      : clock.at;
    const at = from + frames * frameSeconds();
    if (isPlaying) setIsPlaying(false);
    movePlayhead(Math.max(0, Math.min(totalSeconds, at)));
  }

  transportRef.current = {
    play: togglePlay,
    step: stepFrames,
    goTo: (seconds: number) => seekTo(seconds),
    end: totalSeconds,
  };

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
   * with it. Deliberately not `seekTo`: this one is clamped to the whole
   * timeline rather than to what can be played, and it can't raise a toast
   * per mouse-move the way `seekTo` would. */
  const scrubTo = useCallback(
    (seconds: number) => {
      movePlayhead(Math.max(0, Math.min(timelineSeconds, seconds)));
    },
    [timelineSeconds, movePlayhead],
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

  /** What each track actually carries, for its name column: picture, sound,
   * or — where the two meet — both, shown as a pair of icons.
   *
   * Judged by what is on the track rather than by what kind of track it
   * is, so a video that still has its own audio counts as both, an audio
   * file dropped on a video track counts as sound, and a video whose audio
   * has been split off counts as picture alone. */
  const trackContents = useMemo(() => {
    const contents = new Map<string, { picture: boolean; sound: boolean }>();
    for (const track of tracks) {
      const isAudioTrack = trackKindOf(track) === "audio";
      let picture = false;
      let sound = false;
      for (const clip of track.clips) {
        const kind = mediaByPath.get(clip.mediaPath)?.kind ?? mediaKindFor(clip.mediaPath);
        if (clip.soundOnly || kind === "audio") {
          sound = true;
          continue;
        }
        picture = true;
        // A video is both until its sound is taken off it: the pair of
        // icons is what says this track still carries its own audio, and
        // the speaker dropping away is what says the split worked.
        if (kind === "video" && !clip.audioDetached) sound = true;
      }
      // An empty track still says what it is for.
      if (!picture && !sound) {
        if (isAudioTrack) sound = true;
        else picture = true;
      }
      contents.set(track.id, { picture, sound });
    }
    return contents;
  }, [tracks, mediaByPath]);

  /* ----------------------------------------------------------- waveforms */

  /** The outline of every clip's sound, ready to draw: one polygon per
   * clip, mirrored about the middle of the row.
   *
   * Built once per change of tracks or peaks rather than per render — a
   * volume drag re-renders the timeline dozens of times a second and none
   * of those need the shape recomputed. A clip that has been cut shows
   * only its own stretch of the file, which is what `trimStartSeconds`
   * picks out. */
  const waveforms = useMemo(() => {
    const shapes = new Map<string, string>();
    for (const track of tracks) {
      for (const clip of track.clips) {
        const source = audioPeaks.get(clip.mediaPath);
        if (!source || source.peaks.length === 0 || clip.durationSeconds <= 0) {
          continue;
        }

        const rate = source.peaks_per_second;
        const from = (clip.trimStartSeconds ?? 0) * rate;
        const span = clip.durationSeconds * rate;
        const columns = Math.max(
          8,
          Math.min(WAVE_COLUMNS, Math.round(span)),
        );

        const top: string[] = [];
        const bottom: string[] = [];
        for (let column = 0; column < columns; column += 1) {
          // Each column is the loudest reading it covers, so a single
          // sharp peak stays visible however far the clip is zoomed out.
          const start = Math.floor(from + (column / columns) * span);
          const end = Math.max(start + 1, Math.floor(from + ((column + 1) / columns) * span));
          let loudest = 0;
          for (let i = start; i < end && i < source.peaks.length; i += 1) {
            loudest = Math.max(loudest, source.peaks[i] ?? 0);
          }

          // 46 rather than 50 so a full-scale peak keeps a hair of margin
          // inside the clip instead of touching its edges.
          const reach = peakHeight(loudest) * 46;
          const x = (column / (columns - 1)) * 100;
          top.push(`${x.toFixed(2)},${(50 - reach).toFixed(2)}`);
          bottom.unshift(`${x.toFixed(2)},${(50 + reach).toFixed(2)}`);
        }
        shapes.set(clip.id, [...top, ...bottom].join(" "));
      }
    }
    return shapes;
  }, [tracks, audioPeaks]);

  /* --------------------------------------------------------- zoom points */

  /** The clip the zoom controls act on: the one selected, when the
   * playhead is standing inside it. */
  const zoomTarget =
    previewLayers.find(
      (layer) => layer.movable && !layer.audioOnly && layer.clip.id === selectedClipId,
    ) ?? null;

  /** The title being edited: whichever text clip is selected. */
  const selectedText =
    tracks
      .flatMap((track) => track.clips)
      .find((clip) => clip.id === selectedClipId && clip.text) ?? null;

  /** A track with nothing on it at this moment, preferred for a title: a
   * title is something laid over the picture, and dropping one onto busy
   * track would cut a hole in the footage to make room. */
  function freeVideoTrackAt(seconds: number): string | null {
    const busy = (track: TimelineTrack) =>
      track.clips.some(
        (clip) =>
          seconds >= clip.startSeconds &&
          seconds < clip.startSeconds + clip.durationSeconds,
      );
    const video = tracks.filter((track) => trackKindOf(track) === "video");
    return (video.find((track) => !busy(track)) ?? video[0] ?? tracks[0])?.id ?? null;
  }

  function addTextClip() {
    // On the millisecond, and the playhead brought with it — a title that
    // began half a thousandth of a second after the playhead would be
    // added and then not be on screen, which reads as nothing happening.
    const at = toMillis(currentTime);
    const trackId = freeVideoTrackAt(at);
    if (!trackId) {
      setToast("Add a track to put a title on.");
      return;
    }
    onAddTextClip(trackId, at);
    scrubTo(at);
    setActiveTab("text");
  }

  function addZoomPoint() {
    if (!zoomTarget) return;
    const at = currentTime - zoomTarget.clip.startSeconds;
    onAddLayoutPoint(zoomTarget.clip.id, at, zoomTarget.layout);
    setToast(
      zoomTarget.clip.layoutPoints?.length
        ? "Zoom point held here."
        : "Zoom point added — drag or resize the picture to set where it goes.",
    );
  }

  /* ------------------------------------------------------------ cutting */

  /** Cuts at the playhead. With no clip named, every clip the playhead
   * runs through is cut at once, so a picture and the sound split off it
   * stay lined up. */
  function cutAtPlayhead(clipId?: string) {
    const cuts = onCutAt(currentTime, clipId);
    if (cuts > 0) {
      setToast(cuts === 1 ? "Clip cut." : `${cuts} clips cut.`);
      return;
    }
    setToast(
      clipId
        ? "Move the playhead into the clip to cut it."
        : "Move the playhead over a clip to cut it.",
    );
  }

  cutAtPlayheadRef.current = cutAtPlayhead;

  /** Every moment an edge should be pulled towards: the start of the
   * project, the playhead, and the edges of every clip but the one being
   * moved. Shared by trimming and by dragging, so both settle on exactly
   * the same places. */
  function snapMarks(excludeClipId?: string): number[] {
    const marks = [0, currentTime];
    for (const track of tracks) {
      for (const clip of track.clips) {
        if (clip.id === excludeClipId) continue;
        marks.push(clip.startSeconds, clip.startSeconds + clip.durationSeconds);
      }
    }
    return marks;
  }

  /* -------------------------------------------------------- trimming */

  /** Drags one edge of a clip.
   *
   * The scale is taken once, when the edge is picked up, and used for the
   * whole drag. Pulling the last clip's tail out makes the timeline longer,
   * which makes every second narrower — reading the scale afresh on each
   * move would feed that back into the reading and the edge would run away
   * from the pointer. */
  function startTrim(
    event: ReactPointerEvent<HTMLElement>,
    clip: TimelineClip,
    edge: "start" | "end",
  ) {
    if (event.button !== 0 || pixelsPerSecond <= 0) return;
    event.preventDefault();
    event.stopPropagation();
    onSelectClip(clip.id);

    const ruler = rulerRef.current;
    if (!ruler) return;
    const scale = pixelsPerSecond;

    const marks = snapMarks(clip.id);
    const tolerance = SNAP_PIXELS / scale;

    const onMove = (e: PointerEvent) => {
      const bounds = ruler.getBoundingClientRect();
      const wanted = Math.max(0, (e.clientX - bounds.left) / scale);

      let at = wanted;
      let nearest = tolerance;
      for (const mark of marks) {
        const distance = Math.abs(mark - wanted);
        if (distance < nearest) {
          nearest = distance;
          at = mark;
        }
      }
      // To the millisecond: finer than anything that can be seen or heard,
      // and without the dust that dividing pixels by a scale leaves behind.
      onTrimClip(clip.id, edge, Math.round(at * 1000) / 1000);
    };

    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setTrimmingClipId(null);
    };

    setTrimmingClipId(clip.id);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  /* ----------------------------------------------------- track heights */

  /** Drags a track row taller or shorter by its name column. */
  function startTrackResize(event: ReactPointerEvent<HTMLElement>, track: TimelineTrack) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const from = event.clientY;
    const start = trackHeightOf(track);

    const onMove = (e: PointerEvent) => {
      onResizeTrack(
        track.id,
        clamp(
          Math.round(start + (e.clientY - from)),
          TRACK_HEIGHT_MIN,
          TRACK_HEIGHT_MAX,
        ),
      );
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setResizingTrackId(null);
    };

    setResizingTrackId(track.id);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  /* ------------------------------------------------------ the volume line */

  /** Drags the volume line. With `pointIndex` null the whole line moves up
   * or down together, keeping its shape; with an index, that one point
   * moves in both time and level. */
  function startVolumeGesture(
    event: ReactPointerEvent<Element>,
    clip: TimelineClip,
    pointIndex: number | null,
  ) {
    if (event.button !== 0 || clip.durationSeconds <= 0) return;
    event.preventDefault();
    event.stopPropagation();

    const box = event.currentTarget.closest(".ed-clip");
    if (!box) return;
    const rect = box.getBoundingClientRect();
    const start = volumePointsOf(clip);
    const origin = { x: event.clientX, y: event.clientY };
    const band = VOLUME_BOTTOM - VOLUME_TOP;

    // Worked in positions on the line rather than in raw multipliers: the
    // line is a decibel scale, so an even drag has to be an even change in
    // decibels, and the shape of an envelope has to survive being moved.
    const positions = start.map((point) => positionForGain(point.gain));
    const headroom = 1 - Math.max(...positions);
    const floor = Math.min(...positions);
    const positionDelta = (dy: number) => -((dy / rect.height) * 100) / band;

    const onMove = (e: PointerEvent) => {
      if (pointIndex == null) {
        // Clamped as a whole, not point by point, so the envelope isn't
        // flattened against the ceiling on the way up.
        const shift = clamp(positionDelta(e.clientY - origin.y), -floor, headroom);
        onUpdateClipVolume(
          clip.id,
          start.map((point, i) => ({
            ...point,
            gain: gainForPosition(positions[i] + shift),
          })),
        );
        return;
      }

      // A point can't be dragged past its neighbours; that keeps the line
      // sorted without re-ordering it under the pointer mid-drag.
      const low = pointIndex > 0 ? start[pointIndex - 1].at : 0;
      const high =
        pointIndex < start.length - 1
          ? start[pointIndex + 1].at
          : clip.durationSeconds;
      const at = clamp(
        ((e.clientX - rect.left) / rect.width) * clip.durationSeconds,
        low,
        high,
      );
      const gain = gainForPosition(
        positionAtY(((e.clientY - rect.top) / rect.height) * 100),
      );
      onUpdateClipVolume(
        clip.id,
        start.map((point, i) => (i === pointIndex ? { at, gain } : point)),
      );
    };

    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setVolumeClipId(null);
    };

    setVolumeClipId(clip.id);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  /** Double-clicking the line puts a point where it was clicked, at the
   * level the line already reads there — so adding one never changes the
   * sound until it is dragged. */
  function addVolumePoint(event: ReactMouseEvent<Element>, clip: TimelineClip) {
    const box = event.currentTarget.closest(".ed-clip");
    if (!box || clip.durationSeconds <= 0) return;
    event.preventDefault();
    event.stopPropagation();

    const rect = box.getBoundingClientRect();
    const points = volumePointsOf(clip);
    const at = clamp(
      ((event.clientX - rect.left) / rect.width) * clip.durationSeconds,
      0,
      clip.durationSeconds,
    );
    const before = points.findIndex((point) => point.at > at);
    const next = [...points];
    next.splice(before < 0 ? points.length : before, 0, {
      at,
      gain: gainAt(points, at),
    });
    onUpdateClipVolume(clip.id, next);
  }

  /** Double-clicking a point takes it away again. */
  function removeVolumePoint(
    event: ReactMouseEvent<Element>,
    clip: TimelineClip,
    pointIndex: number,
  ) {
    event.preventDefault();
    event.stopPropagation();
    const next = volumePointsOf(clip).filter((_, i) => i !== pointIndex);
    // One point left is still meaningful — it is the clip's overall level.
    onUpdateClipVolume(clip.id, next.length > 0 ? next : undefined);
  }

  /* ------------------------------------------------------- the clip menu */

  /** Every clip on the timeline with the track it belongs to, so the menu
   * can tell a picture from a sound without hunting for it. */
  const clipsById = useMemo(() => {
    const found = new Map<string, { clip: TimelineClip; track: TimelineTrack }>();
    for (const track of tracks) {
      for (const clip of track.clips) found.set(clip.id, { clip, track });
    }
    return found;
  }, [tracks]);

  const menuTarget = clipMenu ? (clipsById.get(clipMenu.clipId) ?? null) : null;
  /** A cut needs the playhead to be inside the clip, clear of both ends. */
  const canCutHere =
    menuTarget != null &&
    currentTime > menuTarget.clip.startSeconds + 0.05 &&
    currentTime < menuTarget.clip.startSeconds + menuTarget.clip.durationSeconds - 0.05;

  /** Sound can only be split off a picture, and only once. */
  const canSplitAudio =
    menuTarget != null &&
    trackKindOf(menuTarget.track) === "video" &&
    !menuTarget.clip.audioDetached &&
    (mediaByPath.get(menuTarget.clip.mediaPath)?.kind ?? "video") === "video";

  // The menu closes on the next thing that happens anywhere, the way every
  // context menu does.
  useEffect(() => {
    if (!clipMenu) return;
    const close = () => setClipMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", onKey);
    // Capture, because the timeline scrolls inside itself.
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close, true);
    };
  }, [clipMenu]);

  function openClipMenu(event: ReactMouseEvent, clipId: string) {
    event.preventDefault();
    event.stopPropagation();
    onSelectClip(clipId);
    setClipMenu({ clipId, x: event.clientX, y: event.clientY });
  }

  /* ------------------------------------------------- layers on the stage */

  /** A layer being moved or resized, and the pointer reading it started
   * from. Kept in a ref: a drag repaints the stage on every move and none
   * of that bookkeeping should cause a render of its own. */
  function startLayerGesture(
    event: ReactPointerEvent<HTMLElement>,
    layer: Layer,
    mode: "move" | "resize",
  ) {
    if (event.button !== 0) return;
    const stage = stageRef.current;
    if (!stage) return;
    event.preventDefault();
    event.stopPropagation();

    // The stand-in layer for a sidebar selection isn't part of the edit:
    // there is nothing to select and nothing to move, but pressing the
    // picture should still start and stop playback.
    if (!layer.movable) {
      const onClickUp = () => {
        window.removeEventListener("pointerup", onClickUp);
        togglePlay();
      };
      window.addEventListener("pointerup", onClickUp);
      return;
    }
    onSelectClip(layer.clip.id);

    const frame = stage.getBoundingClientRect();
    const start = layer.layout;
    const origin = { x: event.clientX, y: event.clientY };
    // Distance from the layer's centre at the moment the handle was
    // grabbed; resizing is that distance growing or shrinking.
    const centre = {
      x: frame.left + frame.width * (0.5 + start.x),
      y: frame.top + frame.height * (0.5 + start.y),
    };
    const reach = Math.hypot(origin.x - centre.x, origin.y - centre.y);
    let moved = false;

    const onMove = (e: PointerEvent) => {
      if (
        !moved &&
        Math.abs(e.clientX - origin.x) < 3 &&
        Math.abs(e.clientY - origin.y) < 3
      ) {
        return;
      }
      moved = true;

      const momentInClip = currentTime - layer.clip.startSeconds;
      if (mode === "move") {
        onUpdateClipLayout(layer.clip.id, {
          ...start,
          // A layer may hang off the edge, but not so far that it can be
          // lost off-stage with no way to get it back.
          // Room to push a zoomed picture right off the frame's edge, so
          // the corner of a screen recording can be brought to the middle.
          x: clamp(start.x + (e.clientX - origin.x) / frame.width, -2, 2),
          y: clamp(start.y + (e.clientY - origin.y) / frame.height, -2, 2),
        }, momentInClip);
        return;
      }

      if (reach < 6) return;
      const now = Math.hypot(e.clientX - centre.x, e.clientY - centre.y);
      onUpdateClipLayout(
        layer.clip.id,
        { ...start, scale: clamp(start.scale * (now / reach), 0.08, MAX_ZOOM) },
        momentInClip,
      );
    };

    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setDraggingLayerId(null);
      // A press that never moved is a click, and a click on the picture
      // has always started and stopped playback.
      if (!moved && mode === "move") togglePlay();
    };

    setDraggingLayerId(layer.clip.id);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  /* -------------------------------------------------- timeline dragging */

  /** Seconds at the pointer inside a lane, with the grab offset taken off
   * so a clip keeps the spot it was picked up by instead of snapping its
   * head to the cursor. Never negative: nothing sits before zero. */
  function dropSecondsFor(e: DragEvent<HTMLElement>, payload: DragPayload | null) {
    if (pixelsPerSecond <= 0) return { seconds: 0, snapped: false };
    const rect = e.currentTarget.getBoundingClientRect();
    const grab = payload?.grabSeconds ?? 0;
    const wanted = Math.max(0, (e.clientX - rect.left) / pixelsPerSecond - grab);

    const marks = payload?.snapMarks ?? [];
    const duration = payload?.durationSeconds ?? 0;
    const tolerance = SNAP_PIXELS / pixelsPerSecond;
    let nearest = tolerance;
    let at = wanted;
    let snapped = false;

    for (const mark of marks) {
      // The head meeting something.
      const head = Math.abs(mark - wanted);
      if (head < nearest) {
        nearest = head;
        at = mark;
        snapped = true;
      }
      // And the tail: butting one clip up against another means the end of
      // what is being dragged has to find the other's beginning, which is
      // the half that makes a sequence join without a sliver of a gap.
      const tail = Math.abs(mark - (wanted + duration));
      if (tail < nearest) {
        nearest = tail;
        at = mark - duration;
        snapped = true;
      }
    }

    return { seconds: toMillis(Math.max(0, at)), snapped };
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
      snapMarks: snapMarks(),
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
      // Its own edges are left out: a clip cannot be pulled onto itself.
      snapMarks: snapMarks(clip.id),
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

    const { seconds: startSeconds, snapped } = dropSecondsFor(e, payload);
    const durationSeconds = payload?.durationSeconds ?? DEFAULT_CLIP_SECONDS;
    setDropTarget((current) =>
      // Same lane, same pixel: keep the old object so the editor doesn't
      // re-render on every one of the many dragover events.
      current &&
      current.trackId === trackId &&
      current.durationSeconds === durationSeconds &&
      current.snapped === snapped &&
      Math.abs(current.startSeconds - startSeconds) * pixelsPerSecond < 1
        ? current
        : { trackId, startSeconds, durationSeconds, snapped },
    );
  }

  function handleLaneDrop(e: DragEvent<HTMLElement>, trackId: string) {
    e.preventDefault();
    const payload = dragRef.current;
    const { seconds: startSeconds } = dropSecondsFor(e, payload);
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
        { label: "Export...", onClick: onExport, separatorBefore: true },
        { label: "Close Project", onClick: onCloseProject, separatorBefore: true },
      ],
    },
    {
      label: "Edit",
      items: [
        // No shortcut labels until these do something: advertising a key
        // that silently does nothing is worse than showing no key.
        { label: "Undo", onClick: onUndo, shortcut: "Ctrl+Z", disabled: !canUndo },
        {
          label: "Redo",
          onClick: onRedo,
          shortcut: "Ctrl+Shift+Z",
          disabled: !canRedo,
        },
        {
          label: "Cut",
          onClick: () => copySelectedClip(true),
          shortcut: "Ctrl+X",
          disabled: !selectedClipId,
          separatorBefore: true,
        },
        {
          label: "Copy",
          onClick: () => copySelectedClip(false),
          shortcut: "Ctrl+C",
          disabled: !selectedClipId,
        },
        {
          label: "Paste",
          onClick: pasteClip,
          shortcut: "Ctrl+V",
          disabled: !clipboardHasClip,
        },
        {
          label: "Duplicate",
          onClick: duplicateSelectedClip,
          shortcut: "Ctrl+D",
          disabled: !selectedClipId,
        },
        {
          label: "Cut at Playhead",
          onClick: () => cutAtPlayhead(),
          shortcut: "Ctrl+K",
          separatorBefore: true,
        },
        {
          // This one does work now, so it gets to advertise its key.
          label: "Delete Clip",
          onClick: deleteSelectedClip,
          shortcut: "Del",
          // Greyed out with nothing selected, like Cut, Copy and
          // Duplicate above it.
          disabled: !selectedClipId,
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
  const framed = visualLayers.length > 0 && audioCard == null;

  return (
    <div
      className="ed-shell"
      // The webview's own menu has nothing to offer here, and it was
      // covering the clip menu; right-clicking a clip raises that instead.
      onContextMenu={(e) => e.preventDefault()}
    >
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
            title={canUndo ? "Undo (Ctrl+Z)" : "Nothing to undo"}
            disabled={!canUndo}
            onClick={onUndo}
          >
            <Icon name="undo" />
          </button>
          <button
            className="ed-iconbtn"
            title={canRedo ? "Redo (Ctrl+Shift+Z)" : "Nothing to redo"}
            disabled={!canRedo}
            onClick={onRedo}
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
          onClick={onExport}
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
              <button
                className="ed-chipbtn"
                title="Put a title on the timeline at the playhead"
                onClick={addTextClip}
              >
                <Icon name="plus" />
                <span>Text</span>
              </button>
              <button
                className="ed-chipbtn"
                disabled={!zoomTarget}
                title={
                  zoomTarget
                    ? "Hold this framing at the playhead, then drag or resize the picture to zoom"
                    : "Select a clip the playhead is standing in"
                }
                onClick={addZoomPoint}
              >
                <Icon name="zoom-in" />
                <span>Zoom point</span>
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
              onPointerDown={(e) => {
                // Pressing the backdrop itself, clear of every layer,
                // drops the selection.
                if (e.target === e.currentTarget) onSelectClip(null);
              }}
            >
              {audioCard ? (
                <div className="ed-audio-stage">
                  <Icon name="speaker" className="ed-audio-glyph" />
                  <p className="ed-audio-name" title={audioCard.name}>
                    {audioCard.name}
                  </p>
                  <audio
                    key={audioCard.path}
                    className="ed-audio-player"
                    src={convertFileSrc(audioCard.path)}
                    controls
                  />
                </div>
              ) : visualLayers.length === 0 ? (
                <div className="ed-preview-state">
                  {audioLayers.length > 0 && (
                    <Icon name="speaker" className="ed-audio-glyph" />
                  )}
                  <p>
                    {media.length === 0
                      ? "Import media to get started."
                      : audioLayers.length > 0
                        ? // Something is playing, it just has no picture:
                          // saying "nothing on the timeline" here was plainly
                          // wrong, and hid the fact that the sound was fine.
                          audioLayers.length === 1
                          ? "Sound only at this point — nothing on the video tracks here."
                          : `Sound only at this point — ${audioLayers.length} audio clips playing, nothing on the video tracks.`
                        : timelineHasClips
                          ? "Nothing on the timeline at this point — the playhead is over a gap."
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
              ) : (
                // The stack. Layers are drawn in track order, so a clip on
                // a lower track in the list lies over the ones above it,
                // and each is placed by its own layout rather than filling
                // the frame. Their coordinates are fractions of this frame
                // — the backdrop's padded inside — so the same layout
                // means the same picture at any window size.
                <div className="ed-stage-frame" ref={stageRef}>
                  {visualLayers.map((layer) => {
                    const selected = layer.clip.id === selectedClipId;
                    return (
                      <div
                        key={layer.clip.id}
                        className={`ed-layer ${selected ? "is-selected" : ""} ${
                          layer.movable ? "is-movable" : ""
                        } ${draggingLayerId === layer.clip.id ? "is-handling" : ""}`}
                        ref={layerBoxRef(layer.clip.id)}
                        style={{
                          zIndex: layer.depth + 1,
                          // A title's canvas covers the frame and the words
                          // are placed inside it, so the box itself never
                          // moves — that is what keeps the preview and the
                          // export the same drawing.
                          width: isTextClip(layer.clip)
                            ? "100%"
                            : `${layer.layout.scale * 100}%`,
                          left: isTextClip(layer.clip)
                            ? "50%"
                            : `${(0.5 + layer.layout.x) * 100}%`,
                          top: isTextClip(layer.clip)
                            ? "50%"
                            : `${(0.5 + layer.layout.y) * 100}%`,
                          // Its own shape, so an overlay isn't letterboxed
                          // inside a box of the wrong proportions.
                          aspectRatio: isTextClip(layer.clip)
                            ? undefined
                            : layer.item.width && layer.item.height
                              ? `${layer.item.width} / ${layer.item.height}`
                              : "16 / 9",
                          height: isTextClip(layer.clip) ? "100%" : undefined,
                        }}
                        onPointerDown={(e) => startLayerGesture(e, layer, "move")}
                      >
                        {layer.clip.text ? (
                          <TextLayerCanvas
                            text={layer.clip.text}
                            layout={layer.layout}
                            width={frameSize.width}
                            height={frameSize.height}
                          />
                        ) : layer.item.status === "preparing" ? (
                          <div className="ed-layer-preparing">
                            <span className="spinner spinner-lg" />
                            <p>
                              Preparing {kindLabel(layer.item.kind).toLowerCase()} for
                              editing…
                            </p>
                          </div>
                        ) : layer.item.kind === "image" ? (
                          <img
                            className="ed-still"
                            src={convertFileSrc(layer.item.path)}
                            alt={layer.item.name}
                            draggable={false}
                          />
                        ) : (
                          <video
                            className="ed-video"
                            src={convertFileSrc(layer.item.path)}
                            // Marked cross-origin so the gain stage can
                            // take it: the asset protocol answers with a
                            // matching Access-Control-Allow-Origin, so it
                            // loads as normal and is never tainted.
                            crossOrigin="anonymous"
                            ref={layerRef(layer.clip.id)}
                            // Muted overlays would be the wrong default: a
                            // second track is as often a voice-over as it is
                            // a talking head.
                            onLoadedMetadata={(e) => {
                              const v = e.currentTarget;
                              if (!timelineHasClips) {
                                setVideoDuration(
                                  Number.isFinite(v.duration) ? v.duration : 0,
                                );
                              }
                              // The clock is the authority on where we are;
                              // a freshly loaded file always says zero.
                              const within =
                                Math.max(
                                  0,
                                  clockRef.current.at - layer.clip.startSeconds,
                                ) + (layer.clip.trimStartSeconds ?? 0);
                              if (within > 0.05) v.currentTime = within;
                            }}
                          />
                        )}

                        {selected && layer.movable && (
                          <>
                            {(["nw", "ne", "sw", "se"] as const).map((corner) => (
                              <span
                                key={corner}
                                className={`ed-layer-handle is-${corner}`}
                                onPointerDown={(e) =>
                                  startLayerGesture(e, layer, "resize")
                                }
                                title="Drag to resize this layer"
                              />
                            ))}
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Audio on a track is heard, not seen. */}
              {audioLayers.map((layer) => (
                <audio
                  key={layer.clip.id}
                  className="ed-layer-audio"
                  src={convertFileSrc(layer.item.path)}
                  crossOrigin="anonymous"
                  ref={layerRef(layer.clip.id)}
                />
              ))}
            </div>
          </div>

          {/* playback controls */}
          <div className="ed-playbar">
            <div className="ed-timecode">
              <span ref={timecodeRef}>
                {formatTimecode(currentTime)}
              </span>{" "}
              <span className="ed-timecode-sep">/</span>{" "}
              {formatTimecode(totalSeconds)}
            </div>

            <div className="ed-playbar-center">
              <button
                className="ed-iconbtn"
                title="Jump to start (Home)"
                disabled={!canPlay}
                onClick={() => seekTo(0)}
              >
                <Icon name="skip-back" />
              </button>
              <button
                className="ed-playbtn"
                title={
                  canPlay
                    ? isPlaying
                      ? "Pause (Space)"
                      : "Play (Space)"
                    : audioCard
                      ? "Use the player on the stage to hear this track"
                      : "Nothing to play yet"
                }
                disabled={!canPlay}
                onClick={togglePlay}
              >
                <Icon name={isPlaying ? "pause" : "play"} />
              </button>
              <button
                className="ed-iconbtn"
                title="Jump to end (End)"
                disabled={!canPlay}
                onClick={() => seekTo(totalSeconds)}
              >
                <Icon name="skip-forward" />
              </button>

              <span className="ed-divider" />

              <button
                className="ed-iconbtn"
                title="Cut every clip at the playhead"
                disabled={!timelineHasClips}
                onClick={() => cutAtPlayhead()}
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
              {missingMedia.length > 0 && (
                <div className="ed-missing" role="alert">
                  <p>
                    {missingMedia.length === 1
                      ? "One file isn't where this project left it."
                      : `${missingMedia.length} files aren't where this project left them.`}{" "}
                    Find one and the rest are looked for beside it.
                  </p>
                  <button
                    className="ed-pill ed-pill-primary"
                    onClick={() => onRelinkMedia(missingMedia[0].path)}
                  >
                    <Icon name="folder" />
                    <span>Find {missingMedia[0].name}</span>
                  </button>
                </div>
              )}

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
                          onRelink={() => onRelinkMedia(item.path)}
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
                          onRelink={() => onRelinkMedia(item.path)}
                          onDragStart={(e) => handleMediaDragStart(e, item)}
                          onDragEnd={endDrag}
                        />
                      ))}
                    </div>
                  )}
                </>
              )}

              {activeTab === "text" && (
                <>
                  <div className="ed-section-head">
                    <h3 className="ed-section-title">Text</h3>
                    <button className="ed-chipbtn" onClick={addTextClip}>
                      <Icon name="plus" />
                      <span>Add title</span>
                    </button>
                  </div>

                  {!selectedText || !selectedText.text ? (
                    <div className="ed-medialist-empty">
                      <p>
                        Select a title on the timeline to change its words, or
                        add one at the playhead.
                      </p>
                    </div>
                  ) : (
                    <>
                      <div className="ed-field">
                        <label className="ed-field-label" htmlFor="ed-text-content">
                          Words
                        </label>
                        <textarea
                          id="ed-text-content"
                          className="ed-textarea"
                          rows={3}
                          value={selectedText.text.content}
                          onChange={(e) =>
                            onUpdateText(selectedText.id, {
                              ...selectedText.text!,
                              content: e.currentTarget.value,
                            })
                          }
                        />
                      </div>

                      <div className="ed-field">
                        <label className="ed-field-label" htmlFor="ed-text-size">
                          Size
                        </label>
                        <input
                          id="ed-text-size"
                          className="ed-range"
                          type="range"
                          min={2}
                          max={30}
                          value={Math.round(selectedText.text.size * 100)}
                          style={{
                            ["--ed-fill" as string]: `${
                              ((selectedText.text.size * 100 - 2) / 28) * 100
                            }%`,
                          }}
                          onChange={(e) =>
                            onUpdateText(selectedText.id, {
                              ...selectedText.text!,
                              size: Number(e.currentTarget.value) / 100,
                            })
                          }
                        />
                      </div>

                      <div className="ed-textrow">
                        <label className="ed-textswatch">
                          <span>Colour</span>
                          <input
                            type="color"
                            value={selectedText.text.color}
                            onChange={(e) =>
                              onUpdateText(selectedText.id, {
                                ...selectedText.text!,
                                color: e.currentTarget.value,
                              })
                            }
                          />
                        </label>

                        <label className="ed-textswatch">
                          <span>Panel</span>
                          <input
                            type="color"
                            value={selectedText.text.background ?? "#0b2016"}
                            disabled={selectedText.text.background === null}
                            onChange={(e) =>
                              onUpdateText(selectedText.id, {
                                ...selectedText.text!,
                                background: e.currentTarget.value,
                              })
                            }
                          />
                        </label>
                      </div>

                      <div className="ed-textrow">
                        <label className="ed-textcheck">
                          <input
                            type="checkbox"
                            checked={selectedText.text.background !== null}
                            onChange={(e) =>
                              onUpdateText(selectedText.id, {
                                ...selectedText.text!,
                                background: e.currentTarget.checked
                                  ? "#0b2016"
                                  : null,
                              })
                            }
                          />
                          <span>Panel behind</span>
                        </label>
                        <label className="ed-textcheck">
                          <input
                            type="checkbox"
                            checked={selectedText.text.bold}
                            onChange={(e) =>
                              onUpdateText(selectedText.id, {
                                ...selectedText.text!,
                                bold: e.currentTarget.checked,
                              })
                            }
                          />
                          <span>Bold</span>
                        </label>
                      </div>

                      <p className="ed-note">
                        Drag the title on the stage to move it. Its length on
                        the timeline is how long it shows for.
                      </p>
                    </>
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
                <div className="ed-rulerrow-side" />
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

              <div className="ed-tracks" ref={tracksRef}>
              {tracks.map((track) => {
                const isTarget = dropTarget != null && dropTarget.trackId === track.id;
                const isAudioTrack = trackKindOf(track) === "audio";
                return (
                  <div
                    className="ed-trackrow"
                    key={track.id}
                    style={{ ["--ed-row-h" as string]: `${trackHeightOf(track)}px` }}
                  >
                    <div
                      className={`ed-tracklabel ${isAudioTrack ? "is-audio" : ""} ${
                        resizingTrackId === track.id ? "is-resizing" : ""
                      }`}
                    >
                      <span className="ed-tracklabel-icons">
                        {trackContents.get(track.id)?.picture && (
                          <Icon name="video" />
                        )}
                        {trackContents.get(track.id)?.sound && (
                          <Icon name="speaker" className="ed-icon-audio" />
                        )}
                      </span>
                      <span className="ed-tracklabel-name" title={track.name}>
                        {track.name}
                      </span>
                      <button
                        className="ed-trackzoom"
                        title={
                          trackHeightOf(track) > TRACK_HEIGHT
                            ? "Back to the normal height"
                            : "Make this track taller"
                        }
                        aria-label={
                          trackHeightOf(track) > TRACK_HEIGHT
                            ? `Shrink ${track.name}`
                            : `Expand ${track.name}`
                        }
                        onClick={() =>
                          onResizeTrack(
                            track.id,
                            trackHeightOf(track) > TRACK_HEIGHT
                              ? undefined
                              : TRACK_HEIGHT_TALL,
                          )
                        }
                      >
                        <Icon
                          name="chevron"
                          className={
                            trackHeightOf(track) > TRACK_HEIGHT ? "ed-flip" : ""
                          }
                        />
                      </button>
                      {/* The bottom edge is the grab handle, for any height
                          between the two the button toggles. */}
                      <span
                        className="ed-trackgrip"
                        title="Drag to set this track's height"
                        onPointerDown={(e) => startTrackResize(e, track)}
                        onDoubleClick={() => onResizeTrack(track.id, undefined)}
                      />
                    </div>

                    <div
                      className={`ed-lane ${isDragging ? "is-dragging" : ""} ${
                        isTarget ? "is-dropping" : ""
                      }`}
                      style={{ width: trackWidth }}
                      onDragOver={(e) => handleLaneDragOver(e, track.id)}
                      onDragLeave={(e) => {
                        // Moving onto a clip inside this lane fires
                        // dragleave on the lane itself, the way mouseout
                        // does. Clearing the indicator then would make it
                        // blink every time the pointer crossed a clip, so
                        // only a dragleave that really leaves the lane
                        // counts.
                        const next = e.relatedTarget;
                        if (next instanceof Node && e.currentTarget.contains(next)) {
                          return;
                        }
                        setDropTarget((current) =>
                          current?.trackId === track.id ? null : current,
                        );
                      }}
                      onDrop={(e) => handleLaneDrop(e, track.id)}
                      onClick={(e) => {
                        if (e.target === e.currentTarget) onSelectClip(null);
                      }}
                    >
                      {track.clips.length === 0 && !isTarget && (
                        <span className="ed-lane-hint">
                          {isAudioTrack
                            ? "Split a clip's audio to fill this track"
                            : "Drag media from the panel onto this track"}
                        </span>
                      )}

                      {track.clips.map((clip) => {
                        const item = mediaByPath.get(clip.mediaPath);
                        const preparing = item?.status === "preparing";
                        const kind = item?.kind ?? mediaKindFor(clip.mediaPath);
                        const label = clip.text
                          ? clip.text.content.split(String.fromCharCode(10))[0] || "Title"
                          : (item?.name ?? fileName(clip.mediaPath));
                        const isSelected = clip.id === selectedClipId;
                        // Stills have nothing to hear; a clip whose sound
                        // has moved to an audio track has nothing left to
                        // set the level of either.
                        // Blue is for sound: a clip on an audio track, and
                        // equally an audio file dropped straight onto a
                        // video track — it plays as sound either way, so it
                        // should read as sound either way.
                        const isText = isTextClip(clip);
                        const isAudioClip =
                          !isText && (Boolean(clip.soundOnly) || kind === "audio");
                        const carriesSound =
                          !isText &&
                          (isAudioClip || (kind !== "image" && !clip.audioDetached));
                        const volumePoints = carriesSound
                          ? volumePointsOf(clip)
                          : [];
                        const volumePath =
                          carriesSound && clip.durationSeconds > 0
                            ? volumeCurve(volumePoints, clip.durationSeconds)
                            : "";
                        // The handles are clutter on every clip at once, so
                        // they appear on the clip being worked on and on any
                        // clip that already has a shaped line.
                        const showKnobs =
                          carriesSound &&
                          (isSelected || (clip.volume?.length ?? 0) >= 2);
                        // A clip narrower than the two handles would be all
                        // handle and could no longer be picked up and moved.
                        const trimmable =
                          clip.durationSeconds * pixelsPerSecond >= TRIM_MIN_CLIP_PX;
                        return (
                          <div
                            key={clip.id}
                            className={`ed-clip ${isSelected ? "is-selected" : ""} ${
                              preparing ? "is-preparing" : ""
                            } ${isAudioClip ? "is-audio" : ""} ${
                              clip.muted ? "is-muted" : ""
                            } ${clip.audioDetached ? "is-split" : ""} ${
                              trimmingClipId === clip.id ? "is-trimming" : ""
                            } ${isText ? "is-text" : ""}`}
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
                            } at ${formatTick(clip.startSeconds)}${
                              clip.muted ? " (muted)" : ""
                            }
Right-click for audio options`}
                            onContextMenu={(e) => openClipMenu(e, clip.id)}
                            draggable={
                              volumeClipId !== clip.id && trimmingClipId !== clip.id
                            }
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
                            {/* A clip whose sound has been split onto an
                                audio track has no levels left to show, so
                                it gets no waveform — the envelope belongs
                                to the audio clip now. */}
                            {carriesSound &&
                              (waveforms.has(clip.id) ? (
                                <svg
                                  className="ed-clip-wave-real"
                                  viewBox="0 0 100 100"
                                  preserveAspectRatio="none"
                                  aria-hidden="true"
                                >
                                  <polygon points={waveforms.get(clip.id)} />
                                </svg>
                              ) : (
                                <span className="ed-clip-wave" aria-hidden="true" />
                              ))}
                            <span className="ed-clip-head">
                              {preparing ? (
                                <span className="spinner" />
                              ) : isText ? (
                                <Icon name="frame" className="ed-clip-glyph" />
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
                            {carriesSound && (
                              <>
                                {/* The line and, drawn first and invisibly,
                                    a fat stroke along the same path that is
                                    the only part taking the pointer — so the
                                    rest of the clip still drags. */}
                                <svg
                                  className="ed-clip-volume"
                                  viewBox="0 0 100 100"
                                  preserveAspectRatio="none"
                                  aria-hidden="true"
                                >
                                  <polyline
                                    className="ed-clip-volume-hit"
                                    points={volumePath}
                                    onPointerDown={(e) =>
                                      startVolumeGesture(e, clip, null)
                                    }
                                    onDoubleClick={(e) => addVolumePoint(e, clip)}
                                  >
                                    <title>
                                      {`${formatGainDb(
                                        gainAt(clip.volume, 0),
                                      )} — drag the line to set the level, double-click to add a point`}
                                    </title>
                                  </polyline>
                                  <line
                                    className="ed-clip-volume-zero"
                                    x1="0"
                                    x2="100"
                                    y1={volumeY(1)}
                                    y2={volumeY(1)}
                                  />
                                  <polyline
                                    className="ed-clip-volume-line"
                                    points={volumePath}
                                  />
                                </svg>
                                {showKnobs && (
                                  <span className="ed-clip-volume-knobs">
                                    {volumePoints.map((point, i) => (
                                      <span
                                        key={i}
                                        className="ed-clip-volume-knob"
                                        style={{
                                          left: `${
                                            clip.durationSeconds > 0
                                              ? (point.at / clip.durationSeconds) *
                                                100
                                              : 0
                                          }%`,
                                          top: `${volumeY(point.gain)}%`,
                                        }}
                                        title={`${formatGainDb(
                                          point.gain,
                                        )} at ${formatTimecode(point.at)} — drag to move, double-click to remove`}
                                        onPointerDown={(e) =>
                                          startVolumeGesture(e, clip, i)
                                        }
                                        onDoubleClick={(e) =>
                                          removeVolumePoint(e, clip, i)
                                        }
                                      />
                                    ))}
                                  </span>
                                )}
                              </>
                            )}

                            {clip.layoutPoints?.length ? (
                              <span className="ed-clip-zooms" aria-hidden="true">
                                {clip.layoutPoints.map((point) => (
                                  <span
                                    key={point.at}
                                    className="ed-clip-zoom"
                                    style={{
                                      left: `${
                                        clip.durationSeconds > 0
                                          ? (point.at / clip.durationSeconds) * 100
                                          : 0
                                      }%`,
                                    }}
                                    title={`Zoom ${Math.round(
                                      point.layout.scale * 100,
                                    )}% at ${formatTimecode(point.at)} — click to go there, double-click to remove`}
                                    onPointerDown={(e) => {
                                      e.preventDefault();
                                      e.stopPropagation();
                                      onSelectClip(clip.id);
                                      scrubTo(clip.startSeconds + point.at);
                                    }}
                                    onDoubleClick={(e) => {
                                      e.preventDefault();
                                      e.stopPropagation();
                                      onRemoveLayoutPoint(clip.id, point.at);
                                    }}
                                  />
                                ))}
                              </span>
                            ) : null}

                            {trimmable && (
                              <>
                                <span
                                  className="ed-clip-trim is-start"
                                  style={{ width: TRIM_HANDLE_PX }}
                                  title="Drag to trim the start"
                                  onPointerDown={(e) => startTrim(e, clip, "start")}
                                />
                                <span
                                  className="ed-clip-trim is-end"
                                  style={{ width: TRIM_HANDLE_PX }}
                                  title="Drag to trim the end"
                                  onPointerDown={(e) => startTrim(e, clip, "end")}
                                />
                              </>
                            )}

                            <span className="ed-clip-badges">
                              {clip.muted && (
                                <span
                                  className="ed-clip-badge is-flag"
                                  title="Muted"
                                >
                                  Muted
                                </span>
                              )}
                              {clip.audioDetached && (
                                <span
                                  className="ed-clip-badge is-flag"
                                  title="Audio split onto its own track"
                                >
                                  Audio split
                                </span>
                              )}
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
                          className={`ed-dropmark ${
                            dropTarget.snapped ? "is-snapped" : ""
                          }`}
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
              </div>

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
                    height: tracksHeight,
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

      {clipMenu && menuTarget && (
        <div
          className="ed-clipmenu"
          role="menu"
          // Kept inside the window: a clip near the right or bottom edge
          // would otherwise open its menu off-screen.
          style={{
            left: Math.min(clipMenu.x, window.innerWidth - 190),
            top: Math.min(clipMenu.y, window.innerHeight - 96),
          }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <button
            className="ed-clipmenu-item"
            role="menuitem"
            disabled={!canCutHere}
            title={
              canCutHere
                ? "Cut this clip in two at the playhead"
                : "Move the playhead into this clip to cut it"
            }
            onClick={() => {
              cutAtPlayhead(clipMenu.clipId);
              setClipMenu(null);
            }}
          >
            <Icon name="scissors" />
            <span>Cut Here</span>
          </button>
          <button
            className="ed-clipmenu-item"
            role="menuitem"
            onClick={() => {
              onToggleClipMute(clipMenu.clipId);
              setClipMenu(null);
            }}
          >
            <Icon name="speaker" />
            <span>{menuTarget.clip.muted ? "Unmute" : "Mute"}</span>
          </button>
          <button
            className="ed-clipmenu-item"
            role="menuitem"
            disabled={!canSplitAudio}
            title={
              canSplitAudio
                ? "Move this clip's sound onto its own audio track"
                : menuTarget.clip.audioDetached
                  ? "This clip's audio is already on its own track"
                  : "Only a video clip's audio can be split off"
            }
            onClick={() => {
              onSplitClipAudio(clipMenu.clipId);
              setClipMenu(null);
            }}
          >
            <Icon name="scissors" />
            <span>Split Audio</span>
          </button>
        </div>
      )}

      {toast && <div className="editor-toast">{toast}</div>}
    </div>
  );
}
