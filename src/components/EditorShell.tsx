import {
  useCallback,
  useEffect,
  useLayoutEffect,
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
import {
  drawBackdrop,
  fitFrame,
  frameGeometry,
  hasBackdrop,
  PALETTES,
  paletteOf,
} from "../frame";
import { drawTextLayer, textBounds } from "../textLayer";
import { MenuBar, type MenuDef } from "./MenuBar";
import {
  BACKDROP_CATEGORIES,
  BACKDROP_KINDS,
  FULL_FRAME_LAYOUT,
  MAX_ZOOM,
  clipBefore,
  DEFAULT_TRANSITION_SECONDS,
  moveSelection,
  type ClipMove,
  formatSpeed,
  FRAME_SHAPES,
  FRAME_SHAPE_LABELS,
  shapeRatio,
  MAX_SPEED,
  mediaSpan,
  mediaTimeAt,
  MIN_SPEED,
  SPEED_PRESETS,
  speedOf,
  holdForTransition,
  MAX_TRANSITION_SECONDS,
  MIN_TRANSITION_SECONDS,
  TRANSITIONS,
  TRANSITION_LABELS,
  transitionSeconds as transitionSecondsOf,
  type TransitionKind,
  layerFramingAt,
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
  type ClipLayout,
  type EditorSettings,
  type MediaItem,
  type Transition,
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
  /** Every clip picked out on the timeline, in the order they were added
   * to the selection. Empty when nothing is selected. */
  selectedClipIds: string[];
  onSelectClips: (clipIds: string[]) => void;
  onAddTrack: () => void;
  onAddClip: (trackId: string, mediaPath: string, startSeconds: number) => void;
  /** Where clips are to end up. More than one when a whole selection was
   * dragged, in which case they all move together. */
  onMoveClips: (moves: ClipMove[]) => void;
  onRemoveClips: (clipIds: string[]) => void;
  /** `atSeconds` is the clip's own time, which is what a zoom point is
   * measured in. */
  onUpdateClipLayout: (clipId: string, layout: ClipLayout, atSeconds: number) => void;
  onAddLayoutPoint: (clipId: string, atSeconds: number, layout: ClipLayout) => void;
  onAddTextClip: (trackId: string, atSeconds: number) => void;
  onUpdateText: (clipId: string, text: TextStyle) => void;
  onRemoveLayoutPoint: (clipId: string, atSeconds: number) => void;
  onToggleClipMute: (clipId: string) => void;
  onSplitClipAudio: (clipId: string) => void;
  /** How fast the clip plays. Its length on the timeline changes with it. */
  onSetSpeed: (clipIds: string[], speed: number) => void;
  /** How the selected clip arrives or leaves. Undefined takes it off. */
  onSetTransition: (
    clipIds: string[],
    edge: "in" | "out",
    transition: Transition | undefined,
  ) => void;
  onUpdateClipVolume: (clipId: string, points: VolumePoint[] | undefined) => void;
  /** Each file's loudness envelope, by path, as it arrives. */
  audioPeaks: Map<string, AudioPeaks>;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onExport: () => void;
  /** How many clips are on the clipboard. */
  clipboardCount: number;
  onCopyClips: (clipIds: string[]) => void;
  onPasteClips: (trackId: string, seconds: number) => void;
  onDuplicateClips: (clipIds: string[]) => void;
  /** Moves one edge of a clip to a moment on the timeline. */
  onTrimClip: (clipId: string, edge: "start" | "end", seconds: number) => void;
  onResizeTrack: (trackId: string, height: number | undefined) => void;
  /** Takes a track away, clips and all. */
  onRemoveTrack: (trackId: string) => void;
  /** Names a track by hand. An empty name puts it back to being numbered. */
  onRenameTrack: (trackId: string, name: string) => void;
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

/** How long before a clip is due its picture is put on the stage, out of
 * sight, so the file is open and a frame is ready when it is wanted.
 *
 * Measured rather than guessed: a freshly mounted video element reports
 * nothing decoded, and took 64-206 ms to reach its first frame with the
 * file already cached and served from this machine. A recording read off
 * disk is slower, so the lead is generous — it costs one paused element. */
const WARM_SECONDS = 1.5;

/** How close a layer's edge has to come to the frame's before it is taken
 * there exactly. In pixels rather than in fractions of the frame, so the
 * pull feels the same whatever size the window leaves the preview. */
const STAGE_SNAP_PIXELS = 14;

/** Takes a number to the nearest mark within reach, or leaves it exactly
 * as it was.
 *
 * Returning the value untouched when nothing is near matters: a layer
 * should only ever be moved by the magnet, never quietly rounded off by
 * it. */
function magnet(value: number, marks: number[], reach: number): number {
  let best = value;
  let nearest = reach;
  for (const mark of marks) {
    const away = Math.abs(value - mark);
    if (away < nearest) {
      nearest = away;
      best = mark;
    }
  }
  return best;
}

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

/** A map of where a layer will sit: the frame, and the part of it the
 * picture is about to cover. Drawn rather than named because "top left,
 * quarter" is a picture, and reading it as a picture is quicker. */
function PlaceMark({
  wide,
  high,
  across,
  down,
}: {
  wide: number;
  high: number;
  across: "left" | "centre" | "right";
  down: "top" | "middle" | "bottom";
}) {
  const w = 13 * wide;
  const h = 9 * high;
  const x = across === "left" ? 1 : across === "right" ? 14 - w : 1 + (13 - w) / 2;
  const y = down === "top" ? 1 : down === "bottom" ? 10 - h : 1 + (9 - h) / 2;
  return (
    <svg className="ed-icon" viewBox="0 0 15 11" aria-hidden="true">
      <rect
        x="0.5"
        y="0.5"
        width="14"
        height="10"
        rx="1.5"
        fill="none"
        stroke="currentColor"
        strokeOpacity="0.4"
      />
      <rect x={x} y={y} width={w} height={h} rx="1" fill="currentColor" />
    </svg>
  );
}

/** A clip covering the playhead, ready to be drawn: what it plays, how
 * high it sits in the stack, and where in the frame it goes. */
interface Layer {
  clip: TimelineClip;
  item: MediaItem;
  /** Index of the track it came from. 0 is the bottom of the stack. */
  depth: number;
  layout: ClipLayout;
  /** 0 is invisible, 1 fully there. Anything between is a transition. */
  opacity: number;
  /** Where a title's words sit inside its drawing. A title's `layout` is
   * the drawing's own place in the frame, which only a transition moves. */
  textLayout?: ClipLayout;
  /** On screen only because the clip after it is arriving over the top.
   * Its picture carries on; its sound does not, because a transition is
   * something that happens to the picture. */
  holding: boolean;
  /** Not on screen at all yet: mounted early, invisible and silent, so the
   * file is open and a frame decoded before the clip is due. Without this
   * a clip's picture begins as an empty video element, which is a black
   * box — and a transition then fades that black in over the picture it
   * was supposed to be dissolving into. */
  warming: boolean;
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
  | "pencil"
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
    case "pencil":
      return (
        <>
          <path d="M4 20h4L19.2 8.8a2 2 0 0 0 0-2.8l-1.2-1.2a2 2 0 0 0-2.8 0L4 16z" />
          <path d="M14.5 6.5l3 3" />
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

/** The little square in the sidebar that stands for a backdrop choice.
 * Only ever an illustration of a colour pair, so CSS draws it; the
 * backdrop proper is painted by `drawBackdrop`, which is also what the
 * export writes. */
function swatchGradient(category: BackdropCategory, index: number): string {
  const [a, b] = paletteOf(category, index);
  return `linear-gradient(135deg, ${a} 0%, ${b} 100%)`;
}


/* ---------------------------------------------------------------- helpers */

/** What stands in for a title in the places that expect a media file. */
function titleStandIn(clip: TimelineClip): MediaItem {
  return {
    path: "",
    name: clip.text?.content.split(String.fromCharCode(10))[0] || "Title",
    kind: "image",
    status: "ready",
  };
}

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

type SidebarTab =
  | "media"
  | "audio"
  | "text"
  | "transitions"
  | "speed"
  | "background";

const SIDEBAR_TABS: { id: SidebarTab; label: string }[] = [
  { id: "media", label: "Media" },
  { id: "audio", label: "Audio" },
  { id: "text", label: "Text" },
  { id: "transitions", label: "Transitions" },
  { id: "speed", label: "Speed" },
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
  selectedClipIds,
  onSelectClips,
  onAddTrack,
  onAddClip,
  onMoveClips,
  onRemoveClips,
  onUpdateClipLayout,
  onAddLayoutPoint,
  onRemoveLayoutPoint,
  onAddTextClip,
  onUpdateText,
  onToggleClipMute,
  onSplitClipAudio,
  onSetTransition,
  onSetSpeed,
  onUpdateClipVolume,
  audioPeaks,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onExport,
  clipboardCount,
  onCopyClips,
  onPasteClips,
  onDuplicateClips,
  onTrimClip,
  onResizeTrack,
  onRemoveTrack,
  onRenameTrack,
  onCutAt,
}: EditorShellProps) {
  const [toast, setToast] = useState<string | null>(null);
  /** Ctrl+K is bound once, for the life of the editor; it reaches the
   * current cut through here rather than re-binding on every render. */
  const cutAtPlayheadRef = useRef<(clipId?: string) => void>(() => {});
  const [showInspector, setShowInspector] = useState(true);
  const [showTimeline, setShowTimeline] = useState(true);
  const [activeTab, setActiveTab] = useState<SidebarTab>("media");
  const [shapeMenuOpen, setShapeMenuOpen] = useState(false);
  /** The box being dragged across the timeline to pick clips out, in the
   * coordinates of the window. Null when nothing is being dragged. */
  const [marquee, setMarquee] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);
  /** The track whose menu is open, and where it was opened. */
  const [trackMenu, setTrackMenu] = useState<{
    trackId: string;
    x: number;
    y: number;
  } | null>(null);
  /** The track whose name is being typed. */
  const [renamingTrackId, setRenamingTrackId] = useState<string | null>(null);
  /** Which end of the selected clip the transitions tab is editing. */
  const [transitionEdge, setTransitionEdge] = useState<"in" | "out">("in");
  /** How long a transition is made when one is picked. Kept here rather
   * than on the clip so that choosing a length and then trying three
   * different transitions does not mean setting the length three times. */
  const [transitionSecondsWanted, setTransitionSecondsWanted] = useState(
    DEFAULT_TRANSITION_SECONDS,
  );

  // Timeline drag-and-drop. The payload lives in a ref because dragover
  // fires dozens of times a second and none of it should re-render; only
  // the drop indicator is state.
  const dragRef = useRef<DragPayload | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);

  // Appearance and timeline zoom live in the project now, so every one of
  // them is read from props and written back through onSettingsChange.
  const { aspect, backdropKind, category, swatch, padding, rounded, timelineZoom } =
    settings;

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
  /** The ring and corners drawn around the selected layer, kept in step
   * with its box while a zoom or a transition moves it. */
  const layerMarks = useRef(new Map<string, HTMLElement>());
  const layerMarksRefs = useRef(new Map<string, (el: HTMLElement | null) => void>());
  const layerMarksRef = useCallback((clipId: string) => {
    const cached = layerMarksRefs.current.get(clipId);
    if (cached) return cached;
    const keep = (element: HTMLElement | null) => {
      if (element) layerMarks.current.set(clipId, element);
      else {
        layerMarks.current.delete(clipId);
        layerMarksRefs.current.delete(clipId);
      }
    };
    layerMarksRefs.current.set(clipId, keep);
    return keep;
  }, []);

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
  /** The space the preview has to fill, and the backdrop drawn into it. */
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const backdropRef = useRef<HTMLCanvasElement | null>(null);
  const [previewArea, setPreviewArea] = useState({ width: 0, height: 0 });
  /** The block of track rows. Measured rather than worked out from a row
   * height, because rows can each be dragged to their own height — the
   * playhead has to stop exactly at the last of them either way. */
  const tracksRef = useRef<HTMLDivElement | null>(null);
  const [tracksHeight, setTracksHeight] = useState(0);
  /** The stage's size in pixels. A title is measured against the frame's
   * height, so it has to be known before one can be drawn. */
  const [frameSize, setFrameSize] = useState({ width: 0, height: 0 });
  /** The biggest frame that fits the space, in the shape the export
   * writes — so what is on screen is the finished picture, scaled. */
  const previewFrame = useMemo(
    () => fitFrame(previewArea.width, previewArea.height, aspect),
    [previewArea.width, previewArea.height, aspect],
  );
  /** The stage inside that frame: where the footage is placed, inset by
   * the padding. Worked out by the same function the export uses, from the
   * same settings, so a clip sits at the same fraction of the picture in
   * the finished file as it does on screen. */
  const geometry = useMemo(
    () => frameGeometry(previewFrame.width, previewFrame.height, { padding, rounded }),
    [previewFrame.width, previewFrame.height, padding, rounded],
  );
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
  /** The menu raised by right-clicking a picture in the preview. Kept
   * apart from the timeline's clip menu: what can be done to a layer in
   * the frame — where it sits, how much of the frame it covers — is not
   * what can be done to a clip on a track. */
  const [layerMenu, setLayerMenu] = useState<{
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
    if (selectedClipIds.length === 0) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      if (isTyping()) return;
      e.preventDefault();
      onRemoveClips(selectedClipIds);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [selectedClipIds, onRemoveClips]);

  /** Where a paste lands: on the track holding whatever is selected, or
   * the first track when nothing is, and at the playhead. */
  function pasteTarget(): string | null {
    const withSelection = tracks.find((track) =>
      track.clips.some((clip) => selectedClipIds.includes(clip.id)),
    );
    return (withSelection ?? tracks[0])?.id ?? null;
  }

  /** "1 clip" / "3 clips", for saying what just happened. */
  function countedClips(n: number): string {
    return n === 1 ? "1 clip" : `${n} clips`;
  }

  function copySelectedClips(alsoRemove: boolean) {
    if (selectedClipIds.length === 0) {
      setToast("Select a clip on the timeline first.");
      return;
    }
    onCopyClips(selectedClipIds);
    if (alsoRemove) onRemoveClips(selectedClipIds);
    setToast(
      `${countedClips(selectedClipIds.length)} ${alsoRemove ? "cut" : "copied"}.`,
    );
  }

  function pasteClips() {
    if (clipboardCount === 0) {
      setToast("Nothing has been copied yet.");
      return;
    }
    const trackId = pasteTarget();
    if (!trackId) {
      setToast("Add a track to paste onto.");
      return;
    }
    onPasteClips(trackId, toMillis(currentTime));
  }

  function duplicateSelectedClips() {
    if (selectedClipIds.length === 0) {
      setToast("Select a clip on the timeline first.");
      return;
    }
    onDuplicateClips(selectedClipIds);
  }

  // Reached from the keyboard through a ref, so the shortcuts can be bound
  // once rather than rebound whenever the selection or the playhead moves.
  const clipboardRef = useRef({
    copy: (_cut: boolean) => {},
    paste: () => {},
    duplicate: () => {},
  });
  clipboardRef.current = {
    copy: copySelectedClips,
    paste: pasteClips,
    duplicate: duplicateSelectedClips,
  };

  const deleteSelectedClips = useCallback(() => {
    if (selectedClipIds.length === 0) {
      setToast("Select a clip on the timeline first.");
      return;
    }
    onRemoveClips(selectedClipIds);
  }, [selectedClipIds, onRemoveClips]);

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

      // The clip due next, put on the stage before its time: invisible,
      // silent and paused, purely so that its file is open and a frame is
      // decoded by the moment it is wanted. A video element that has just
      // been created has nothing decoded and paints black, and a clip that
      // arrives with a transition would otherwise cross-fade that black
      // over the picture it was supposed to be dissolving into.
      //
      // Only one per track, and only when it is not already playing.
      const soon = track.clips.find(
        (c) =>
          c.id !== clip?.id &&
          c.startSeconds > currentTime &&
          c.startSeconds - currentTime <= WARM_SECONDS &&
          !isTextClip(c),
      );
      if (soon) {
        const item = mediaByPath.get(soon.mediaPath);
        if (item && item.kind === "video" && !soon.soundOnly) {
          layers.push({
            clip: soon,
            item,
            depth,
            layout: layerFramingAt(soon, 0).layout,
            opacity: 0,
            holding: false,
            warming: true,
            movable: false,
            audioOnly: false,
          });
        }
      }

      if (!clip) continue;

      // A clip that arrives with a transition fades in over the one it
      // follows, not out of the backdrop — so while it is arriving, the
      // clip before it stays on screen underneath, carrying on past its
      // own end. Only when the two actually meet: across a gap there is
      // nothing to fade from, and putting the earlier clip back would show
      // something the edit had already left behind.
      const arriving = holdForTransition(clip);
      const held =
        arriving > 0 && currentTime < clip.startSeconds + arriving
          ? clipBefore(track.clips, clip)
          : undefined;


      // A title has no file behind it, so it stands in as a still: silent,
      // with a picture, and with nothing to read a waveform from. Only the
      // drawing of it is different.
      const item = isTextClip(clip) ? titleStandIn(clip) : mediaByPath.get(clip.mediaPath);
      if (!item) continue;

      // Sound or picture is the clip's own nature, not the lane's: a video
      // dragged onto an audio track is still a video, while the half that
      // Split Audio lifted off one stays sound wherever it is put.
      const audioOnly = Boolean(clip.soundOnly) || item.kind === "audio";

      // Pushed first, so it sits under the clip arriving over it: layers
      // at the same depth are stacked in the order they are drawn.
      if (held && !audioOnly) {
        const heldItem = isTextClip(held)
          ? titleStandIn(held)
          : mediaByPath.get(held.mediaPath);
        if (heldItem) {
          const framing = layerFramingAt(held, currentTime - held.startSeconds);
          layers.push({
            clip: held,
            item: heldItem,
            depth,
            layout: framing.layout,
            textLayout: layoutAt(held, currentTime - held.startSeconds),
            opacity: framing.opacity,
            holding: true,
            warming: false,
            movable: false,
            audioOnly: false,
          });
        }
      }

      const framing = layerFramingAt(clip, currentTime - clip.startSeconds);
      layers.push({
        clip,
        item,
        depth: audioOnly ? 0 : depth,
        layout: framing.layout,
        textLayout: layoutAt(clip, currentTime - clip.startSeconds),
        // Sound is never faded by a transition, so a clip that is only
        // heard is always fully there.
        opacity: audioOnly ? 1 : framing.opacity,
        holding: false,
        warming: false,
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
        opacity: 1,
        holding: false,
        warming: false,
        movable: false,
        audioOnly: selectedMedia.kind === "audio",
      },
    ];
  }, [timelineHasClips, activeLayers, selectedMedia]);

  /** Audio plays but has nothing to draw, so it is kept out of the stack
   * and mounted on its own. */
  const visualLayers = previewLayers.filter((layer) => !layer.audioOnly);
  /** What is actually on screen. A layer warming up is mounted but not
   * shown, so it must not answer the question "is anything playing here" —
   * a gap with the next clip warming in it is still a gap. */
  const shownLayers = visualLayers.filter((layer) => !layer.warming);
  const audioLayers = previewLayers.filter((layer) => layer.audioOnly);

  /** A bare audio file selected in the sidebar still gets the old card,
   * with its own transport — there is no timeline to scrub against. */
  const audioCard =
    !timelineHasClips && selectedMedia?.kind === "audio" ? selectedMedia : null;

  /** Every moment the set of layers changes: a clip starting, a clip
   * ending. The clock stops at each of these to let the stack be rebuilt,
   * which is what makes a clip on a second track appear partway through
   * the one underneath it. */
  /** Every moment the stack of layers changes, so that playback can stop,
   * rebuild it, and carry on from there. */
  const boundaries = useMemo(() => {
    const marks = new Set<number>();
    for (const track of tracks) {
      for (const clip of track.clips) {
        marks.add(clip.startSeconds);
        marks.add(clip.startSeconds + clip.durationSeconds);
        // The end of a transition is a change of stack too: the clip it
        // arrived over is finished with, and without a mark here it would
        // stay mounted underneath for the whole of the clip that replaced
        // it.
        const arriving = holdForTransition(clip);
        if (arriving > 0) marks.add(clip.startSeconds + arriving);
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
      const within = mediaTimeAt(layer.clip, elapsed);

      // Played faster or slower, with the voice left alone: a recording
      // run at double speed should take half the time, not rise an octave.
      // Chromium keeps the pitch by default but says so only through this,
      // and a browser that has never heard of it simply ignores it.
      const speed = speedOf(layer.clip);
      if (element.playbackRate !== speed) element.playbackRate = speed;
      element.preservesPitch = true;

      // Read at the same moment as the picture, so a fade lands exactly
      // where it was drawn. Mute is folded in here rather than left to
      // `element.muted`, because a boosted element no longer plays through
      // its own volume at all.
      const silent =
        layer.warming ||
        layer.holding ||
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
      // Drift is measured in the file's own seconds, and a clip running at
      // four times speed covers four of them a second — so what counts as
      // out of step grows with the speed.
      if (Math.abs(element.currentTime - within) > tolerance * speed) {
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
      // A layer warming up is not playing yet; it is holding its first
      // frame, which is the whole point of it being there.
      if (!isPlaying || layer.warming) {
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

  // A press anywhere else puts the frame menu away, the way every other
  // menu in the app behaves.
  useEffect(() => {
    if (!shapeMenuOpen) return;
    const close = (event: MouseEvent) => {
      const menu = (event.target as Element | null)?.closest?.(".ed-chipmenu");
      if (!menu) setShapeMenuOpen(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [shapeMenuOpen]);

  // How much room the preview has been left. The frame is worked out from
  // this rather than left to the layout, because the export needs the same
  // arithmetic and CSS cannot be asked for its answer.
  useEffect(() => {
    const element = canvasRef.current;
    if (!element) return;
    // The content box: what is left inside the padding. `clientWidth`
    // counts the padding as well, and a frame sized from that grew until
    // it filled the very inset it was supposed to sit inside.
    //
    // Measured here and again on every resize. Relying on the observer
    // alone left the preview at nothing at all whenever its first report
    // did not arrive — a pane that is not being painted does not run the
    // callback, though it will still answer a question about layout.
    const measure = () => {
      const style = getComputedStyle(element);
      const inset = (side: string) => parseFloat(style.getPropertyValue(side)) || 0;
      setPreviewArea({
        width: element.clientWidth - inset("padding-left") - inset("padding-right"),
        height: element.clientHeight - inset("padding-top") - inset("padding-bottom"),
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // The backdrop, painted by the same function that paints it for the
  // export. Drawn at the device's own resolution so it is as crisp as the
  // rest of the window on a scaled display.
  useEffect(() => {
    const canvas = backdropRef.current;
    if (!canvas) return;
    const ratio = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(geometry.width * ratio));
    const height = Math.max(1, Math.round(geometry.height * ratio));
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    drawBackdrop(ctx, { backdropKind, category, swatch }, width, height);
  }, [geometry.width, geometry.height, backdropKind, category, swatch]);

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

    // A clip that zooms, or that is arriving or leaving, is moved frame by
    // frame here rather than through a render; one that holds still
    // already sits where React put it.
    for (const layer of sceneRef.current.layers) {
      const clip = layer.clip;
      const animated =
        Boolean(clip.layoutPoints?.length) ||
        Boolean(clip.transitionIn) ||
        Boolean(clip.transitionOut);
      if (layer.audioOnly || !animated) continue;
      const box = layerBoxes.current.get(clip.id);
      if (!box) continue;
      const framing = layerFramingAt(clip, at - clip.startSeconds);
      const wide = boxScaleRef.current(clip, framing.layout.scale);
      box.style.width = `${wide * 100}%`;
      box.style.left = `${(0.5 + framing.layout.x) * 100}%`;
      box.style.top = `${(0.5 + framing.layout.y) * 100}%`;
      box.style.opacity = `${framing.opacity}`;
      const marks = layerMarks.current.get(clip.id);
      // A title's ring is placed in pixels around the words themselves, so
      // the box's own numbers are not what move it. Only a layer ringed by
      // its own box is followed here.
      if (marks && !isTextClip(clip)) {
        marks.style.width = box.style.width;
        marks.style.left = box.style.left;
        marks.style.top = box.style.top;
      }
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

  /** How much of the slider one unit of a pinch is worth.
   *
   * A mouse wheel reports a notch as 100, which at this rate comes to the
   * same 12.5 points the zoom buttons move by — so a notch and a press do
   * the same thing. A trackpad reports a pinch as a stream of much smaller
   * numbers, which at the same rate reads as a smooth zoom rather than a
   * series of steps. The clamp is what keeps the two in proportion. */
  const ZOOM_PER_WHEEL_UNIT = 0.25;
  const ZOOM_PER_EVENT = 12.5;

  /** The moment the pointer was over when a zoom began, and where on
   * screen it was. Held so the view can be scrolled back afterwards to put
   * that moment under the pointer again. */
  const zoomAnchor = useRef<{ seconds: number; clientX: number } | null>(null);

  // Pinching on a trackpad, or turning a wheel with Ctrl held, zooms the
  // timeline rather than the whole page.
  //
  // Listened for on the element rather than through React, and marked as
  // not passive: a passive listener may not call `preventDefault`, and
  // without that the browser answers a pinch by scaling the entire app.
  useEffect(() => {
    const scroller = timelineScrollRef.current;
    if (!scroller) return;

    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();

      // Some browsers report the turn in lines rather than pixels.
      const units = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
      const change = Math.max(
        -ZOOM_PER_EVENT,
        Math.min(ZOOM_PER_EVENT, -units * ZOOM_PER_WHEEL_UNIT),
      );
      const now = settingsRef.current.timelineZoom;
      const next = Math.min(100, Math.max(0, now + change));
      if (next === now) return;

      zoomAnchor.current = {
        seconds: secondsAtPointerRef.current(event.clientX),
        clientX: event.clientX,
      };
      patchSettings({ timelineZoom: next });
    };

    scroller.addEventListener("wheel", onWheel, { passive: false });
    return () => scroller.removeEventListener("wheel", onWheel);
  }, [patchSettings, showTimeline]);

  // Zoom in on the middle of the view and the moment under the pointer
  // slides away from it, which makes a pinch feel like it is fighting the
  // hand doing it. Scrolled back here, once the new width is on screen, so
  // the moment being pointed at stays under the pointer.
  useLayoutEffect(() => {
    const anchor = zoomAnchor.current;
    zoomAnchor.current = null;
    const scroller = timelineScrollRef.current;
    if (!anchor || !scroller || timelineSeconds <= 0) return;

    const viewLeft = scroller.getBoundingClientRect().left;
    const along = (anchor.seconds / timelineSeconds) * trackWidth;
    scroller.scrollLeft = Math.max(
      0,
      viewLeft + TRACK_LABEL_WIDTH + along - anchor.clientX,
    );
  }, [trackWidth, timelineSeconds]);

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

  /** Reached through a ref by the wheel listener, which is bound once for
   * the life of the timeline rather than rebound on every change of
   * scale — and a listener bound once would otherwise be holding the
   * scale it was born with. */
  const secondsAtPointerRef = useRef(secondsAtPointer);
  secondsAtPointerRef.current = secondsAtPointer;

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
        // How much of the file the clip covers, which is not its length on
        // the timeline once its speed has been changed.
        const span = mediaSpan(clip, clip.durationSeconds) * rate;
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
      (layer) => layer.movable && !layer.audioOnly && selectedClipIds.includes(layer.clip.id),
    ) ?? null;

  /** The title being edited: whichever text clip is selected. */
  const selectedText =
    tracks
      .flatMap((track) => track.clips)
      .find((clip) => selectedClipIds.includes(clip.id) && clip.text) ?? null;

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
    selectForGesture(clip.id, event);

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

  /** The clips the transitions and speed tabs work on, and the first of
   * them, which is what the controls read their settings from. */
  const selectedClips = selectedClipIds
    .map((id) => clipsById.get(id))
    .filter((found): found is { clip: TimelineClip; track: TimelineTrack } => !!found);
  const selectedClip = selectedClips[0] ?? null;
  /** Whether they all say the same thing. When they do not, the panel
   * shows nothing picked out rather than one clip's answer standing in
   * for the rest. */
  function agreeOn<T>(read: (clip: TimelineClip) => T): T | undefined {
    if (selectedClips.length === 0) return undefined;
    const first = JSON.stringify(read(selectedClips[0].clip) ?? null);
    return selectedClips.every(
      (found) => JSON.stringify(read(found.clip) ?? null) === first,
    )
      ? read(selectedClips[0].clip)
      : undefined;
  }
  /** Sound has no picture to fade, so the tab says so rather than
   * offering transitions that would do nothing. */
  const selectedIsSound =
    selectedClip != null &&
    (Boolean(selectedClip.clip.soundOnly) ||
      mediaByPath.get(selectedClip.clip.mediaPath)?.kind === "audio");
  const agreedSpeed = agreeOn((clip) => speedOf(clip));
  const speedMixed = selectedClips.length > 1 && agreedSpeed === undefined;
  const selectedSpeed = agreedSpeed ?? (selectedClip ? speedOf(selectedClip.clip) : 1);
  const selectedTransition = agreeOn((clip) =>
    transitionEdge === "in" ? clip.transitionIn : clip.transitionOut,
  );
  /** Several clips picked out that do not all carry the same transition.
   * Nothing is shown as chosen, because nothing is: picking one would set
   * them all, and showing one clip's answer would suggest they agreed. */
  const transitionMixed =
    selectedClips.length > 1 &&
    selectedTransition === undefined &&
    selectedClips.some((found) =>
      transitionEdge === "in" ? found.clip.transitionIn : found.clip.transitionOut,
    );

  /** What the clip in question would fade from, said plainly, because it
   * is the one thing about transitions that is not obvious: a transition
   * at the start of a clip needs something before it to come out of. */
  const transitionSource =
    selectedClip && transitionEdge === "in"
      ? clipBefore(selectedClip.track.clips, selectedClip.clip)
      : undefined;

  function pickTransition(kind: TransitionKind | null) {
    if (!selectedClip) return;
    onSetTransition(
      selectedClipIds,
      transitionEdge,
      kind === null ? undefined : { kind, seconds: transitionSecondsWanted },
    );
  }

  const menuTarget = clipMenu ? (clipsById.get(clipMenu.clipId) ?? null) : null;
  const layerMenuTarget = layerMenu
    ? (visualLayers.find((layer) => layer.clip.id === layerMenu.clipId) ?? null)
    : null;
  /** What the clip menu acts on: the whole selection when the clip it was
   * opened on is part of it, and that clip alone otherwise. */
  const menuSelection = clipMenu
    ? selectedClipIds.includes(clipMenu.clipId)
      ? selectedClipIds
      : [clipMenu.clipId]
    : [];
  // The track menu is put away the same way the clip menu is: by pressing
  // anywhere that is not it.
  useEffect(() => {
    if (!trackMenu) return;
    const close = () => setTrackMenu(null);
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [trackMenu]);
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
    if (!clipMenu && !layerMenu) return;
    const close = () => {
      setClipMenu(null);
      setLayerMenu(null);
    };
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
  }, [clipMenu, layerMenu]);

  /** What a press on a clip does to the selection.
   *
   * On its own it picks that clip out and drops everything else. Held with
   * Ctrl (or Command) it adds the clip to what is already picked out, or
   * takes it back out if it was in — the gesture everything from a file
   * manager to a spreadsheet uses, so it needs no explaining.
   */
  function selectClip(
    clipId: string,
    modifiers?: { ctrlKey: boolean; metaKey: boolean },
  ) {
    const adding = Boolean(modifiers && (modifiers.ctrlKey || modifiers.metaKey));
    if (!adding) {
      onSelectClips([clipId]);
      return;
    }
    onSelectClips(
      selectedClipIds.includes(clipId)
        ? selectedClipIds.filter((id) => id !== clipId)
        : [...selectedClipIds, clipId],
    );
  }

  /** A press on a clip that is already one of several picked out leaves
   * the rest alone — otherwise dragging a group would drop all but the
   * one under the pointer before the drag had begun. */
  function selectForGesture(
    clipId: string,
    modifiers?: { ctrlKey: boolean; metaKey: boolean },
  ) {
    const adding = Boolean(modifiers && (modifiers.ctrlKey || modifiers.metaKey));
    if (!adding && selectedClipIds.length > 1 && selectedClipIds.includes(clipId)) {
      return;
    }
    selectClip(clipId, modifiers);
  }

  /** Drags a box across the timeline and picks out everything it touches.
   *
   * Started from the empty part of a lane, which until now did nothing but
   * clear the selection — and still does, when it turns out to be a press
   * rather than a drag.
   *
   * Which clips are caught is worked out from where they actually are on
   * screen rather than from their times: a clip is a rectangle in a row,
   * the box is a rectangle, and two rectangles either overlap or they do
   * not. Nothing here has to know about zoom levels or scrolling.
   */
  function startMarquee(event: ReactPointerEvent<HTMLElement>) {
    if (event.button !== 0) return;
    const scroller = timelineScrollRef.current;
    if (!scroller) return;

    const origin = { x: event.clientX, y: event.clientY };
    const already = event.ctrlKey || event.metaKey ? selectedClipIds : [];
    // Measured once: a drag asks many times a second and the clips do not
    // move while it is happening.
    const boxes = [...scroller.querySelectorAll<HTMLElement>("[data-clip-id]")].map(
      (element) => ({
        id: element.dataset.clipId ?? "",
        rect: element.getBoundingClientRect(),
      }),
    );

    let dragged = false;
    const onMove = (move: PointerEvent) => {
      const left = Math.min(origin.x, move.clientX);
      const top = Math.min(origin.y, move.clientY);
      const width = Math.abs(move.clientX - origin.x);
      const height = Math.abs(move.clientY - origin.y);
      // A few pixels of wobble is a press, not a drag; without this a
      // plain click on an empty lane would flicker a box.
      if (!dragged && width < 4 && height < 4) return;
      dragged = true;
      setMarquee({ left, top, width, height });

      const caught = boxes
        .filter(
          (box) =>
            box.rect.left < left + width &&
            box.rect.right > left &&
            box.rect.top < top + height &&
            box.rect.bottom > top,
        )
        .map((box) => box.id);
      onSelectClips([...new Set([...already, ...caught])]);
    };

    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setMarquee(null);
      if (!dragged) onSelectClips(already);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  function openClipMenu(event: ReactMouseEvent, clipId: string) {
    event.preventDefault();
    event.stopPropagation();
    selectForGesture(clipId, event);
    setClipMenu({ clipId, x: event.clientX, y: event.clientY });
  }

  /* ------------------------------------------------- layers on the stage */

  /** The shape a layer is drawn at, which is its own picture's and not the
   * frame's — a 4:3 clip half as wide as a 16:9 stage is nowhere near half
   * as tall. A title is the exception: its drawing covers the whole frame,
   * so it takes the frame's shape. */
  function shapeOfLayer(layer: Layer): number {
    if (isTextClip(layer.clip)) return shapeRatio(aspect);
    return layer.item.width && layer.item.height
      ? layer.item.width / layer.item.height
      : 16 / 9;
  }

  /** The shape of the stage — the picture inside the padding. */
  const stageShape =
    geometry.stage.height > 0
      ? geometry.stage.width / geometry.stage.height
      : shapeRatio(aspect);

  // A layout is measured in stage widths, with 0 at the stage's centre,
  // because that is what the renderer is given. The frame is bigger than
  // the stage by the padding, so everything below that talks about the
  // frame has to be said in those same units first. `-insetX` is where the
  // frame's left edge falls, and `frameWide` how many stage widths across
  // it is. The two insets come out equal, since the stage keeps the
  // frame's shape, but both are worked out rather than assumed.
  const insetX = geometry.stage.width > 0 ? geometry.stage.x / geometry.stage.width : 0;
  const insetY =
    geometry.stage.height > 0 ? geometry.stage.y / geometry.stage.height : 0;
  const frameWide = 1 + 2 * insetX;
  const frameHigh = 1 + 2 * insetY;

  /** How wide a layer's box is, as a fraction of the stage.
   *
   * Footage is placed against the stage — the padded inset the project's
   * look describes. A title is not: its drawing is the whole picture, the
   * padding included, because words written on a film are written on the
   * film and not on the part of it left over after a margin. So a title's
   * box is the frame, which in stage widths is `frameWide`.
   *
   * The renderer is told the same thing, in `buildExportPlan`, from the
   * same two numbers — the frame's width and the stage's. */
  function boxScale(clip: TimelineClip, scale: number): number {
    return isTextClip(clip) ? scale * frameWide : scale;
  }

  /** Reached by the per-frame painter, which writes to the DOM directly
   * and so cannot read a value that only exists during a render. */
  const boxScaleRef = useRef(boxScale);
  boxScaleRef.current = boxScale;

  /** The ring and the four corners drawn around a selected layer: where
   * the ring goes, and where each handle goes within it.
   *
   * Two things decide this. A title's ring goes round the words, not round
   * its drawing: the drawing is the whole frame, because that is how it is
   * laid over the picture, and a ring round the empty part of it says
   * nothing about what is being held. And every mark is kept inside the
   * frame, because the frame clips whatever reaches past it — as it must,
   * the file being clipped there too — so a handle placed outside it is
   * not merely unseen, it cannot be pressed at all. */
  function marksFor(layer: Layer): {
    box: CSSProperties;
    handles: Record<string, CSSProperties>;
  } {
    // The frame, in the stage's own coordinates: the stage sits inside it,
    // inset by the padding.
    const frameLeft = -geometry.stage.x;
    const frameTop = -geometry.stage.y;
    const frameRight = frameLeft + geometry.width;
    const frameBottom = frameTop + geometry.height;

    /** A handle is 11px across; these keep it just inside the frame. */
    const HANDLE = 11;
    const KEEP = 2;

    const words =
      isTextClip(layer.clip) && layer.clip.text
        ? textBounds(
            layer.clip.text,
            layer.textLayout ?? layer.layout,
            geometry.width,
            geometry.height,
          )
        : null;

    if (words) {
      // In the stage's coordinates, which is where the marks are drawn.
      const left = words.x - geometry.stage.x;
      const top = words.y - geometry.stage.y;
      /** Centred on the box's own corners, unless that would take a handle
       * past the frame, in which case it stops at the frame. */
      const corners = (
        near: number,
        far: number,
        span: number,
        origin: number,
      ): [number, number] => [
        Math.max(-HANDLE / 2, near + KEEP - origin),
        Math.min(span - HANDLE / 2, far - KEEP - HANDLE - origin),
      ];
      const [west, east] = corners(frameLeft, frameRight, words.width, left);
      const [north, south] = corners(frameTop, frameBottom, words.height, top);
      const place = (x: number, y: number): CSSProperties => ({
        left: x + "px",
        top: y + "px",
        right: "auto",
        bottom: "auto",
      });
      return {
        box: {
          left: left + "px",
          top: top + "px",
          width: words.width + "px",
          height: words.height + "px",
          // Placed by its corner rather than by its centre, unlike a
          // layer's box, so the centring translation must not apply.
          transform: "none",
        },
        handles: {
          nw: place(west, north),
          ne: place(east, north),
          sw: place(west, south),
          se: place(east, south),
        },
      };
    }

    // Footage: the ring goes round the layer itself, and each handle to
    // the corner of however much of it the frame lets be seen.
    const wide = boxScale(layer.clip, layer.layout.scale);
    const shape = shapeOfLayer(layer);
    const high = (wide * stageShape) / shape;
    const left = 0.5 + layer.layout.x - wide / 2;
    const top = 0.5 + layer.layout.y - high / 2;
    const along = (edge: number) =>
      Math.min(100, Math.max(0, ((edge - left) / (wide || 1)) * 100));
    const down = (edge: number) =>
      Math.min(100, Math.max(0, ((edge - top) / (high || 1)) * 100));
    const at = (percent: number, far: boolean) =>
      "calc(" + percent + "% " + (far ? "- " + (HANDLE + 3) + "px" : "+ 3px") + ")";
    const place = (x: string, y: string): CSSProperties => ({
      left: x,
      top: y,
      right: "auto",
      bottom: "auto",
    });
    const west = at(along(-insetX), false);
    const east = at(along(1 + insetX), true);
    const north = at(down(-insetY), false);
    const south = at(down(1 + insetY), true);
    return {
      box: {
        width: wide * 100 + "%",
        left: (0.5 + layer.layout.x) * 100 + "%",
        top: (0.5 + layer.layout.y) * 100 + "%",
        aspectRatio:
          layer.item.width && layer.item.height
            ? layer.item.width + " / " + layer.item.height
            : "16 / 9",
      },
      handles: {
        nw: place(west, north),
        ne: place(east, north),
        sw: place(west, south),
        se: place(east, south),
      },
    };
  }

  /** Puts a layer into a part of the whole frame.
   *
   * `wide` and `high` are fractions of the frame — a quarter is 0.5 by
   * 0.5 — and the corners named are the frame's corners, padding and all.
   * That is the one thing these have to get right: "full" means the edge
   * of the picture the file will hold, not the edge of the padded inset,
   * and a layer told to fill the frame that stops at the padding does not
   * look full to anyone.
   *
   * `cover` comes out at least as large as the box, cropping what will not
   * fit; `contain` at most as large, leaving the backdrop showing where
   * the shapes disagree. */
  function placeInFrame(
    layer: Layer,
    wide: number,
    high: number,
    across: "left" | "centre" | "right",
    down: "top" | "middle" | "bottom",
    how: "cover" | "contain" = "contain",
  ): ClipLayout {
    const shape = shapeOfLayer(layer);
    // The box, in stage widths and stage heights.
    const boxWide = wide * frameWide;
    const boxHigh = high * frameHigh;
    // The width that fills the box across, and the width that fills it
    // down. Contained takes the smaller, covering takes the larger.
    const acrossFill = boxWide;
    const downFill = (boxHigh * shape) / stageShape;
    const scale =
      how === "cover"
        ? Math.max(acrossFill, downFill)
        : Math.min(acrossFill, downFill);
    const tall = (scale * stageShape) / shape;

    // Where the box begins, measured from the stage's left edge in stage
    // widths: the frame starts at -insetX, and the box sits inside it.
    const boxLeft =
      -insetX +
      (across === "left" ? 0 : across === "right" ? 1 - wide : (1 - wide) / 2) *
        frameWide;
    const boxTop =
      -insetY +
      (down === "top" ? 0 : down === "bottom" ? 1 - high : (1 - high) / 2) * frameHigh;

    const left =
      across === "left"
        ? boxLeft
        : across === "right"
          ? boxLeft + boxWide - scale
          : boxLeft + (boxWide - scale) / 2;
    const top =
      down === "top"
        ? boxTop
        : down === "bottom"
          ? boxTop + boxHigh - tall
          : boxTop + (boxHigh - tall) / 2;

    // Back into what a layout is: the centre, offset from the stage's.
    return { scale, x: left + scale / 2 - 0.5, y: top + tall / 2 - 0.5 };
  }

  /** Puts a layout on a layer at the moment being looked at, which is what
   * a zoom point is measured from. */
  function setLayerLayout(layer: Layer, layout: ClipLayout) {
    onUpdateClipLayout(layer.clip.id, layout, currentTime - layer.clip.startSeconds);
    setLayerMenu(null);
  }

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
    selectClip(layer.clip.id, event);

    const frame = stage.getBoundingClientRect();
    // What the drag moves. For footage that is the layer's own framing;
    // for a title it is where the words sit inside the drawing, because a
    // title's `layout` carries only what a transition is doing to it and
    // starting from that would throw the words back to the middle the
    // moment they were touched a second time.
    const start = (isTextClip(layer.clip) ? layer.textLayout : null) ?? layer.layout;
    const origin = { x: event.clientX, y: event.clientY };
    // Distance from the layer's centre at the moment the handle was
    // grabbed; resizing is that distance growing or shrinking.
    const centre = {
      x: frame.left + frame.width * (0.5 + start.x),
      y: frame.top + frame.height * (0.5 + start.y),
    };
    const reach = Math.hypot(origin.x - centre.x, origin.y - centre.y);
    let moved = false;

    // The magnet works on edges, and where a layer's edges are depends on
    // the shape of its own picture rather than the frame's.
    const shape = shapeOfLayer(layer);

    // What a layout's numbers are fractions of. Footage is placed against
    // the stage; a title's numbers are read by the drawing, which covers
    // the frame — so a hand that moves 150 pixels has to move the words
    // 150 pixels, not 150 of something slightly smaller.
    const words = isTextClip(layer.clip);
    const acrossPx = words ? frame.width * frameWide : frame.width;
    const downPx = words ? frame.height * frameHigh : frame.height;

    /** A layer's height as a fraction of the stage, at a given width. */
    const heightFor = (scale: number) => (scale * stageShape) / shape;
    /** The sizes worth landing on exactly: filling the frame edge to edge,
     * and sitting whole inside it — each of them both for the frame and
     * for the padded inset, which are the same two numbers when there is
     * no padding. */
    const sizes = [
      Math.max(1, shape / stageShape),
      Math.min(1, shape / stageShape),
      Math.max(frameWide, (frameHigh * shape) / stageShape),
      Math.min(frameWide, (frameHigh * shape) / stageShape),
    ];

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
      // Alt places a layer exactly where the hand puts it, for the times
      // when a hair off the edge is the wanted picture.
      const free = e.altKey;

      if (mode === "move") {
        const wantedX = start.x + (e.clientX - origin.x) / acrossPx;
        const wantedY = start.y + (e.clientY - origin.y) / downPx;
        // Flush against a side of the frame, or centred on it. Each axis
        // is pulled on its own, so a layer carried into a corner meets
        // both at once and sits in it without a sliver of backdrop left
        // showing along either side.
        const halfWide = start.scale / 2;
        const halfHigh = heightFor(start.scale) / 2;
        // Flush against the frame's own edge, flush against the padded
        // inset, or centred. Both edges are worth meeting: the inset is
        // where a layer rests inside the project's padding, the frame is
        // where the picture actually ends.
        // A title has no edges of its own to bring anywhere — its drawing
        // is the whole frame and the words float inside it — so the only
        // mark worth meeting is the middle.
        const acrossMarks = words
          ? [0]
          : [
              halfWide - 0.5 - insetX,
              halfWide - 0.5,
              0,
              0.5 - halfWide,
              0.5 - halfWide + insetX,
            ];
        const downMarks = words
          ? [0]
          : [
              halfHigh - 0.5 - insetY,
              halfHigh - 0.5,
              0,
              0.5 - halfHigh,
              0.5 - halfHigh + insetY,
            ];
        const x = free ? wantedX : magnet(wantedX, acrossMarks, STAGE_SNAP_PIXELS / acrossPx);
        const y = free ? wantedY : magnet(wantedY, downMarks, STAGE_SNAP_PIXELS / downPx);
        onUpdateClipLayout(layer.clip.id, {
          ...start,
          // A layer may hang off the edge, but not so far that it can be
          // lost off-stage with no way to get it back.
          // Room to push a zoomed picture right off the frame's edge, so
          // the corner of a screen recording can be brought to the middle.
          x: clamp(x, -2, 2),
          y: clamp(y, -2, 2),
        }, momentInClip);
        return;
      }

      if (reach < 6) return;
      const now = Math.hypot(e.clientX - centre.x, e.clientY - centre.y);
      const wanted = start.scale * (now / reach);
      // The two sizes worth landing on exactly, so a layer meant to fill
      // the frame fills it rather than missing by a pixel.
      const scale = free
        ? wanted
        : magnet(wanted, words ? [1] : sizes, STAGE_SNAP_PIXELS / acrossPx);
      onUpdateClipLayout(
        layer.clip.id,
        { ...start, scale: clamp(scale, 0.08, MAX_ZOOM) },
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
    selectForGesture(clip.id, e);
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

    if (clipId) {
      // A clip that was part of a selection takes the rest with it; one
      // that was not is moved on its own, and becomes the selection.
      const moving = selectedClipIds.includes(clipId) ? selectedClipIds : [clipId];
      onMoveClips(moveSelection(tracks, moving, clipId, trackId, startSeconds));
    }
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
          onClick: () => copySelectedClips(true),
          shortcut: "Ctrl+X",
          disabled: selectedClipIds.length === 0,
          separatorBefore: true,
        },
        {
          label: "Copy",
          onClick: () => copySelectedClips(false),
          shortcut: "Ctrl+C",
          disabled: selectedClipIds.length === 0,
        },
        {
          label: "Paste",
          onClick: pasteClips,
          shortcut: "Ctrl+V",
          disabled: clipboardCount === 0,
        },
        {
          label: "Duplicate",
          onClick: duplicateSelectedClips,
          shortcut: "Ctrl+D",
          disabled: selectedClipIds.length === 0,
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
          onClick: deleteSelectedClips,
          shortcut: "Del",
          // Greyed out with nothing selected, like Cut, Copy and
          // Duplicate above it.
          disabled: selectedClipIds.length === 0,
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

  const stageStyle: CSSProperties = {
    ["--ed-radius" as string]: `${geometry.radius}px`,
    width: `${geometry.width}px`,
    height: `${geometry.height}px`,
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
  const framed = shownLayers.length > 0 && audioCard == null;

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
              <div className="ed-chipmenu">
                <button
                  className="ed-chipbtn"
                  title="The shape of the picture, in the preview and in the exported file"
                  aria-haspopup="menu"
                  aria-expanded={shapeMenuOpen}
                  onClick={() => setShapeMenuOpen((open) => !open)}
                >
                  <Icon name="frame" />
                  <span>{aspect}</span>
                  <Icon name="chevron" className="ed-caret" />
                </button>
                {shapeMenuOpen && (
                  <div className="ed-chipmenu-list" role="menu">
                    {FRAME_SHAPES.map((shape) => (
                      <button
                        key={shape}
                        className={`ed-chipmenu-item ${aspect === shape ? "is-active" : ""}`}
                        role="menuitemradio"
                        aria-checked={aspect === shape}
                        onClick={() => {
                          patchSettings({ aspect: shape });
                          setShapeMenuOpen(false);
                        }}
                      >
                        <span
                          className="ed-shape-art"
                          style={{ aspectRatio: shape.replace(":", " / ") }}
                          aria-hidden="true"
                        />
                        <span className="ed-chipmenu-name">
                          {FRAME_SHAPE_LABELS[shape]}
                        </span>
                        <span className="ed-chipmenu-note">{shape}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
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
          <div
            className="ed-canvas"
            ref={canvasRef}
            onPointerDown={(e) => {
              // A press anywhere in the preview that is not on a picture
              // drops the selection, so the frame and its handles go away
              // rather than staying on whatever was touched last. Pressing
              // a picture selects it again — that is the layer's own
              // handler, and this one leaves it alone.
              if (!(e.target as HTMLElement).closest(".ed-layer")) {
                onSelectClips([]);
              }
            }}
          >
            <div
              className={`ed-backdrop ${framed ? "" : "is-empty"}`}
              style={stageStyle}
            >
              {framed && hasBackdrop(backdropKind) && (
                <canvas className="ed-backdrop-paint" ref={backdropRef} />
              )}
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
              ) : (
                <>
              {shownLayers.length === 0 && (
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
              )}
              {/* The stack is mounted even when nothing is showing yet: a
                  clip warming up for its entrance lives here, invisible,
                  and taking it off the stage would undo the warming. */}
              {visualLayers.length > 0 && (
                // The stack. Layers are drawn in track order, so a clip on
                // a lower track in the list lies over the ones above it,
                // and each is placed by its own layout rather than filling
                // the frame. Their coordinates are fractions of the stage
                // — the picture inside the padding — so the same layout
                // means the same picture at any size, on screen or in the
                // finished file.
                <div
                  className="ed-stage-frame"
                  ref={stageRef}
                  style={{
                    left: `${geometry.stage.x}px`,
                    top: `${geometry.stage.y}px`,
                    width: `${geometry.stage.width}px`,
                    height: `${geometry.stage.height}px`,
                  }}
                >
                  {visualLayers.map((layer) => {
                    const selected = selectedClipIds.includes(layer.clip.id);
                    return (
                      <div
                        key={layer.clip.id}
                        className={`ed-layer ${selected ? "is-selected" : ""} ${
                          layer.movable ? "is-movable" : ""
                        } ${draggingLayerId === layer.clip.id ? "is-handling" : ""}`}
                        ref={layerBoxRef(layer.clip.id)}
                        style={{
                          zIndex: layer.depth + 1,
                          opacity: layer.opacity,
                          // Mounted early and invisible: it must not take
                          // a press meant for the picture behind it.
                          pointerEvents: layer.warming ? "none" : undefined,
                          width: `${boxScale(layer.clip, layer.layout.scale) * 100}%`,
                          left: `${(0.5 + layer.layout.x) * 100}%`,
                          top: `${(0.5 + layer.layout.y) * 100}%`,
                          // Its own shape, so an overlay isn't letterboxed
                          // inside a box of the wrong proportions. A title's
                          // drawing covers the whole stage, so its shape is
                          // the stage's — which is what lets a transition
                          // move and scale it like any other layer while the
                          // words stay where they were placed inside it.
                          aspectRatio: isTextClip(layer.clip)
                            ? aspect.replace(":", " / ")
                            : layer.item.width && layer.item.height
                              ? `${layer.item.width} / ${layer.item.height}`
                              : "16 / 9",
                        }}
                        onPointerDown={(e) => startLayerGesture(e, layer, "move")}
                        onContextMenu={(e) => {
                          // The stand-in shown for a sidebar selection is
                          // not part of the edit, so there is nothing to
                          // lay out.
                          if (!layer.movable) return;
                          e.preventDefault();
                          e.stopPropagation();
                          if (!selectedClipIds.includes(layer.clip.id)) {
                            onSelectClips([layer.clip.id]);
                          }
                          setLayerMenu({
                            clipId: layer.clip.id,
                            x: e.clientX,
                            y: e.clientY,
                          });
                        }}
                      >
                        {layer.clip.text ? (
                          <TextLayerCanvas
                            text={layer.clip.text}
                            layout={layer.textLayout ?? layer.layout}
                            // The drawing covers the frame, so it is made
                            // at the frame's size — `frameSize` is the
                            // stage's, which is the frame less the padding.
                            width={frameSize.width * frameWide}
                            height={frameSize.height * frameHigh}
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
                              const within = mediaTimeAt(
                                layer.clip,
                                Math.max(
                                  0,
                                  clockRef.current.at - layer.clip.startSeconds,
                                ),
                              );
                              if (within > 0.05) v.currentTime = within;
                            }}
                          />
                        )}


                      </div>
                    );
                  })}

                  {/* The marks around the layer being worked on: the ring
                      and the four corners.
                      
                      Drawn here rather than inside the layer, above every
                      picture on the stage. A layer covering the frame —
                      a title, or footage set to Full Layer — sits over
                      whatever is below it, handles and all, and a handle
                      that cannot be pressed is not a handle. The marks
                      themselves let the pointer through; only the corners
                      take it, so pressing the picture still moves it. */}
                  {visualLayers.map((layer) => {
                    if (
                      !layer.movable ||
                      layer.warming ||
                      !selectedClipIds.includes(layer.clip.id)
                    ) {
                      return null;
                    }
                    const marks = marksFor(layer);
                    return (
                      <div
                        key={`marks:${layer.clip.id}`}
                        className="ed-layer-marks"
                        ref={layerMarksRef(layer.clip.id)}
                        style={marks.box}
                      >
                        {(["nw", "ne", "sw", "se"] as const).map((corner) => (
                          <span
                            key={corner}
                            className={`ed-layer-handle is-${corner}`}
                            style={marks.handles[corner]}
                            onPointerDown={(e) => startLayerGesture(e, layer, "resize")}
                            title={
                              isTextClip(layer.clip)
                                ? "Drag to resize the words"
                                : "Drag to resize this layer"
                            }
                          />
                        ))}
                      </div>
                    );
                  })}
                </div>
              )}
                </>
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

              {activeTab === "speed" && (
                <>
                  <div className="ed-section-head">
                    <h3 className="ed-section-title">Speed</h3>
                  </div>

                  {!selectedClip ? (
                    <div className="ed-medialist-empty">
                      <p>Select a clip on the timeline to change how fast it plays.</p>
                    </div>
                  ) : isTextClip(selectedClip.clip) ? (
                    <div className="ed-medialist-empty">
                      <p>
                        A title has no material to play through, so there is
                        nothing to speed up. Drag its edges to change how long
                        it stays on screen.
                      </p>
                    </div>
                  ) : (
                    <>
                      <div className="ed-speeds">
                        {SPEED_PRESETS.map((preset) => (
                          <button
                            key={preset}
                            className={`ed-speed ${
                              !speedMixed && Math.abs(selectedSpeed - preset) < 0.001
                                ? "is-active"
                                : ""
                            }`}
                            aria-pressed={
                              !speedMixed && Math.abs(selectedSpeed - preset) < 0.001
                            }
                            onClick={() => onSetSpeed(selectedClipIds, preset)}
                          >
                            {formatSpeed(preset)}
                          </button>
                        ))}
                      </div>

                      <div className="ed-field">
                        <label className="ed-field-label" htmlFor="ed-speed">
                          Speed
                          <span className="ed-field-value">
                            {speedMixed ? "mixed" : formatSpeed(selectedSpeed)}
                          </span>
                        </label>
                        <input
                          id="ed-speed"
                          className="ed-range"
                          type="range"
                          min={MIN_SPEED}
                          max={MAX_SPEED}
                          step={0.05}
                          value={selectedSpeed}
                          style={{
                            ["--ed-fill" as string]: `${
                              ((selectedSpeed - MIN_SPEED) / (MAX_SPEED - MIN_SPEED)) * 100
                            }%`,
                          }}
                          onChange={(e) =>
                            onSetSpeed(selectedClipIds, Number(e.currentTarget.value))
                          }
                        />
                      </div>

                      <p className="ed-note">
                        {selectedClips.length > 1 ? (
                          <>
                            {countedClips(selectedClips.length)} picked out; a speed
                            chosen here is given to all of them.
                          </>
                        ) : (
                          <>
                            {formatDuration(
                              mediaSpan(
                                selectedClip.clip,
                                selectedClip.clip.durationSeconds,
                              ),
                            )}{" "}
                            of footage in{" "}
                            {formatDuration(selectedClip.clip.durationSeconds)} on the
                            timeline.
                          </>
                        )}{" "}
                        Whatever follows on the same track moves along, so the change
                        leaves neither a gap nor an overlap.
                      </p>
                      <p className="ed-note">
                        The sound speeds up with the picture but keeps its own
                        voice — nothing rises or drops in pitch.
                      </p>
                    </>
                  )}
                </>
              )}

              {activeTab === "transitions" && (
                <>
                  <div className="ed-section-head">
                    <h3 className="ed-section-title">Transitions</h3>
                  </div>

                  {!selectedClip ? (
                    <div className="ed-medialist-empty">
                      <p>
                        Select a clip on the timeline to choose how it arrives
                        and how it leaves.
                      </p>
                    </div>
                  ) : selectedIsSound ? (
                    // Said rather than quietly offered: a transition is a
                    // thing that happens to a picture, and putting one on a
                    // sound would look like it had been applied.
                    <div className="ed-medialist-empty">
                      <p>
                        This clip is sound, and a transition shapes a picture.
                        Use the volume line along the clip to fade it in or out.
                      </p>
                    </div>
                  ) : (
                    <>
                      <div className="ed-segmented" role="group" aria-label="Which end">
                        <button
                          className={`ed-segment ${transitionEdge === "in" ? "is-active" : ""}`}
                          aria-pressed={transitionEdge === "in"}
                          onClick={() => setTransitionEdge("in")}
                        >
                          Arrives
                        </button>
                        <button
                          className={`ed-segment ${transitionEdge === "out" ? "is-active" : ""}`}
                          aria-pressed={transitionEdge === "out"}
                          onClick={() => setTransitionEdge("out")}
                        >
                          Leaves
                        </button>
                      </div>

                      <div className="ed-field">
                        <label className="ed-field-label" htmlFor="ed-transition-length">
                          Length
                          <span className="ed-field-value">
                            {(
                              selectedTransition
                                ? transitionSecondsOf(
                                    selectedTransition,
                                    selectedClip.clip.durationSeconds,
                                  )
                                : transitionSecondsWanted
                            ).toFixed(2)}
                            s
                          </span>
                        </label>
                        <input
                          id="ed-transition-length"
                          className="ed-range"
                          type="range"
                          min={MIN_TRANSITION_SECONDS}
                          max={MAX_TRANSITION_SECONDS}
                          step={0.05}
                          value={selectedTransition?.seconds ?? transitionSecondsWanted}
                          style={{
                            ["--ed-fill" as string]: `${
                              (((selectedTransition?.seconds ?? transitionSecondsWanted) -
                                MIN_TRANSITION_SECONDS) /
                                (MAX_TRANSITION_SECONDS - MIN_TRANSITION_SECONDS)) *
                              100
                            }%`,
                          }}
                          onChange={(e) => {
                            const seconds = Number(e.currentTarget.value);
                            setTransitionSecondsWanted(seconds);
                            if (selectedTransition) {
                              onSetTransition(selectedClipIds, transitionEdge, {
                                ...selectedTransition,
                                seconds,
                              });
                            }
                          }}
                        />
                      </div>

                      <div className="ed-transitions">
                        <button
                          className={`ed-transition ${
                            !selectedTransition && !transitionMixed ? "is-active" : ""
                          }`}
                          aria-pressed={!selectedTransition && !transitionMixed}
                          onClick={() => pickTransition(null)}
                        >
                          <span className="ed-transition-art is-cut" aria-hidden="true" />
                          <span>Cut</span>
                        </button>
                        {TRANSITIONS.map((kind) => (
                          <button
                            key={kind}
                            className={`ed-transition ${
                              !transitionMixed && selectedTransition?.kind === kind
                                ? "is-active"
                                : ""
                            }`}
                            aria-pressed={
                              !transitionMixed && selectedTransition?.kind === kind
                            }
                            onClick={() => pickTransition(kind)}
                          >
                            <span
                              className={`ed-transition-art is-${kind}`}
                              aria-hidden="true"
                            />
                            <span>{TRANSITION_LABELS[kind]}</span>
                          </button>
                        ))}
                      </div>

                      {selectedClips.length > 1 && (
                        <p className="ed-note">
                          {countedClips(selectedClips.length)} picked out; a choice
                          here is given to all of them.
                        </p>
                      )}
                      <p className="ed-note">
                        {transitionEdge === "in"
                          ? transitionSource
                            ? "It comes out of the clip before it, which keeps playing underneath while it arrives."
                            : "There is no clip before this one, so it comes out of the background."
                          : "It goes back to whatever is underneath — the background, or a clip on a lower track."}{" "}
                        Sound is not faded: the volume line on the timeline is
                        where a sound is shaped.
                      </p>
                    </>
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
                    Background, padding and corners are part of the picture:
                    what you see here is what gets exported.
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
              if (e.target === e.currentTarget) onSelectClips([]);
            }}
          >
            <div
              className="ed-timeline-inner"
              style={{ width: TRACK_LABEL_WIDTH + trackWidth }}
              onClick={(e) => {
                if (e.target === e.currentTarget) onSelectClips([]);
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
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setClipMenu(null);
                        setTrackMenu({ trackId: track.id, x: e.clientX, y: e.clientY });
                      }}
                    >
                      <span className="ed-tracklabel-icons">
                        {trackContents.get(track.id)?.picture && (
                          <Icon name="video" />
                        )}
                        {trackContents.get(track.id)?.sound && (
                          <Icon name="speaker" className="ed-icon-audio" />
                        )}
                      </span>
                      {renamingTrackId === track.id ? (
                        <input
                          className="ed-tracklabel-input"
                          defaultValue={track.name}
                          autoFocus
                          aria-label={`Name for ${track.name}`}
                          onFocus={(e) => e.currentTarget.select()}
                          onBlur={(e) => {
                            onRenameTrack(track.id, e.currentTarget.value);
                            setRenamingTrackId(null);
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") e.currentTarget.blur();
                            if (e.key === "Escape") {
                              // Put back what it was, then let go.
                              e.currentTarget.value = track.name;
                              e.currentTarget.blur();
                            }
                            e.stopPropagation();
                          }}
                        />
                      ) : (
                        <span
                          className="ed-tracklabel-name"
                          title={`${track.name} — double-click to rename`}
                          onDoubleClick={() => setRenamingTrackId(track.id)}
                        >
                          {track.name}
                        </span>
                      )}
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
                      onPointerDown={(e) => {
                        if (e.target === e.currentTarget) startMarquee(e);
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
                        const isSelected = selectedClipIds.includes(clip.id);
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
                            data-clip-id={clip.id}
                            onDragStart={(e) => handleClipDragStart(e, clip)}
                            onDragEnd={endDrag}
                            onClick={(e) => selectClip(clip.id, e)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault();
                                selectClip(clip.id, e);
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
                                      selectClip(clip.id);
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

                            {/* A wedge on whichever edge carries a
                                transition, as wide as the transition is
                                long — so its length can be seen against
                                the clip rather than only read in a panel. */}
                            {clip.transitionIn && (
                              <span
                                className="ed-clip-transition is-start"
                                style={{
                                  width: timeToPixels(
                                    transitionSecondsOf(
                                      clip.transitionIn,
                                      clip.durationSeconds,
                                    ),
                                  ),
                                }}
                                title={`Arrives: ${TRANSITION_LABELS[clip.transitionIn.kind]}`}
                              />
                            )}
                            {clip.transitionOut && (
                              <span
                                className="ed-clip-transition is-end"
                                style={{
                                  width: timeToPixels(
                                    transitionSecondsOf(
                                      clip.transitionOut,
                                      clip.durationSeconds,
                                    ),
                                  ),
                                }}
                                title={`Leaves: ${TRANSITION_LABELS[clip.transitionOut.kind]}`}
                              />
                            )}

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

      {trackMenu && (
        <div
          className="ed-clipmenu"
          role="menu"
          style={{
            left: Math.min(trackMenu.x, window.innerWidth - 190),
            top: Math.min(trackMenu.y, window.innerHeight - 96),
          }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <button
            className="ed-clipmenu-item"
            role="menuitem"
            onClick={() => {
              setRenamingTrackId(trackMenu.trackId);
              setTrackMenu(null);
            }}
          >
            <Icon name="pencil" />
            <span>Rename</span>
          </button>
          <button
            className="ed-clipmenu-item"
            role="menuitem"
            disabled={tracks.length <= 1}
            title={
              tracks.length <= 1
                ? "There has to be somewhere to put a clip"
                : "Remove this track and everything on it"
            }
            onClick={() => {
              onRemoveTrack(trackMenu.trackId);
              setTrackMenu(null);
            }}
          >
            <Icon name="trash" />
            <span>Delete track</span>
          </button>
        </div>
      )}

      {layerMenu && layerMenuTarget && (
        <div
          className="ed-clipmenu"
          role="menu"
          style={{
            left: Math.min(layerMenu.x, window.innerWidth - 190),
            top: Math.min(layerMenu.y, window.innerHeight - 250),
          }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <button
            className="ed-clipmenu-item"
            role="menuitem"
            title="Cover the whole frame, edge to edge, cropping whatever will not fit"
            onClick={() =>
              setLayerLayout(
                layerMenuTarget,
                placeInFrame(layerMenuTarget, 1, 1, "centre", "middle", "cover"),
              )
            }
          >
            <PlaceMark wide={1} high={1} across="centre" down="middle" />
            <span>Full Layer</span>
          </button>
          <button
            className="ed-clipmenu-item"
            role="menuitem"
            title="Inside the padding, with the whole picture showing"
            onClick={() =>
              setLayerLayout(layerMenuTarget, {
                // Inside the padded inset rather than inside the frame:
                // told to fit, a layer the same shape as the frame would
                // otherwise come out exactly as large as Full Layer, and
                // an entry that does nothing visible is an entry that
                // lies. This is the resting place the padding describes,
                // which is what the picture beside it draws.
                scale: Math.min(1, shapeOfLayer(layerMenuTarget) / stageShape),
                x: 0,
                y: 0,
              })
            }
          >
            <PlaceMark wide={0.82} high={0.82} across="centre" down="middle" />
            <span>Fit In Frame</span>
          </button>
          <button
            className="ed-clipmenu-item"
            role="menuitem"
            title="Leave its size alone and bring it to the middle"
            onClick={() =>
              setLayerLayout(layerMenuTarget, {
                ...layerMenuTarget.layout,
                x: 0,
                y: 0,
              })
            }
          >
            <PlaceMark wide={0.5} high={0.5} across="centre" down="middle" />
            <span>Centre</span>
          </button>
          <div className="ed-clipmenu-rule" />
          {(
            [
              ["Top Left", "left", "top"],
              ["Top Right", "right", "top"],
              ["Bottom Left", "left", "bottom"],
              ["Bottom Right", "right", "bottom"],
            ] as const
          ).map(([label, across, down]) => (
            <button
              key={label}
              className="ed-clipmenu-item"
              role="menuitem"
              title={`A quarter of the frame, flush into the ${label.toLowerCase()} corner`}
              onClick={() =>
                setLayerLayout(
                  layerMenuTarget,
                  placeInFrame(layerMenuTarget, 0.5, 0.5, across, down),
                )
              }
            >
              <PlaceMark wide={0.5} high={0.5} across={across} down={down} />
              <span>{label}</span>
            </button>
          ))}
        </div>
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
            <span className="ed-clipmenu-key">Ctrl+K</span>
          </button>
          <button
            className="ed-clipmenu-item"
            role="menuitem"
            onClick={() => {
              onCopyClips(menuSelection);
              setToast(`${countedClips(menuSelection.length)} copied.`);
              setClipMenu(null);
            }}
          >
            <Icon name="clips" />
            <span>Copy</span>
            <span className="ed-clipmenu-key">Ctrl+C</span>
          </button>
          <button
            className="ed-clipmenu-item"
            role="menuitem"
            onClick={() => {
              onDuplicateClips(menuSelection);
              setClipMenu(null);
            }}
          >
            <Icon name="plus" />
            <span>Duplicate</span>
            <span className="ed-clipmenu-key">Ctrl+D</span>
          </button>
          <button
            className="ed-clipmenu-item"
            role="menuitem"
            onClick={() => {
              onRemoveClips(menuSelection);
              setClipMenu(null);
            }}
          >
            <Icon name="trash" />
            <span>Delete</span>
            <span className="ed-clipmenu-key">Del</span>
          </button>
          <div className="ed-clipmenu-rule" />
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

      {marquee && (
        <div
          className="ed-marquee"
          style={{
            left: marquee.left,
            top: marquee.top,
            width: marquee.width,
            height: marquee.height,
          }}
        />
      )}

      {toast && <div className="editor-toast">{toast}</div>}
    </div>
  );
}
