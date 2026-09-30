export interface ScreenInfo {
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  is_primary: boolean;
}

export interface DeviceInfo {
  id: string;
  name: string;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type QualityPreset = "low" | "medium" | "high" | "source";

export interface DeviceList {
  screens: ScreenInfo[];
  webcams: DeviceInfo[];
  audio_inputs: DeviceInfo[];
}

/** A window on screen that a recording can be pointed at. */
export interface WindowInfo {
  /** Its title bar, which is both how a person recognises it and how the
   * capture is asked for it. */
  title: string;
  /** The program it belongs to, for telling two of the same name apart. */
  app: string;
}

export interface RecordingConfig {
  screen_id: string;
  area: Rect | null;
  /** One window, by its title, instead of the screen. */
  window_title: string | null;
  /** The camera on its own, with no screen in the recording. */
  camera_only: boolean;
  /** Put a ring around the mouse while recording, so it can be followed
   * on a busy screen. Drawn on the screen at the time. */
  highlight_cursor: boolean;
  /** Write down where the mouse goes, so the editor can zoom in on what
   * was clicked. Off unless asked for. */
  track_cursor: boolean;
  include_webcam: boolean;
  webcam_id: string | null;
  include_audio: boolean;
  audio_id: string | null;
  quality: QualityPreset;
  fps: number;
  output_dir: string | null;
}

/** What the main window hands to the floating bar when it opens it. */
export interface BarSetup {
  config: RecordingConfig;
  /** Whether this app's own window stays on screen while recording,
   * rather than stepping out of the way — for recording the editor
   * itself. */
  keep_app_on_screen?: boolean;
  /** Have the bar drag out a region first, rather than starting on the
   * whole screen. */
  pick_area: boolean;
}

export interface RecordingStatus {
  is_recording: boolean;
  is_paused: boolean;
  elapsed_seconds: number;
  output_path: string | null;
  /** Why the recording stopped, when ffmpeg failed on its own. */
  error: string | null;
  /** Microphone level, 0..1, while audio is being recorded. */
  audio_level: number | null;
}

export interface RecordingFile {
  path: string;
  name: string;
  size_bytes: number;
  created_at: string;
}

export const QUALITY_LABELS: Record<QualityPreset, string> = {
  low: "Low (480p)",
  medium: "Medium (720p)",
  high: "High (1080p)",
  source: "Original (source resolution)",
};

export const FPS_OPTIONS = [24, 30, 60] as const;

export interface MediaPrepared {
  duration_seconds: number | null;
  width: number | null;
  height: number | null;
  frame_rate: number | null;
  thumbnail_path: string | null;
}

export type MediaStatus = "preparing" | "ready" | "missing";

export type MediaKind = "video" | "image" | "audio";

export interface MediaItem {
  path: string;
  name: string;
  kind: MediaKind;
  status: MediaStatus;
  durationSeconds?: number | null;
  width?: number | null;
  height?: number | null;
  /** Frames a second, when the file admitted to one. */
  frameRate?: number | null;
  thumbnailPath?: string | null;
}

const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "avif"];
const AUDIO_EXTENSIONS = ["mp3", "wav", "m4a", "aac", "flac", "ogg", "opus"];

export const VIDEO_EXTENSIONS = ["mp4", "mov", "mkv", "avi", "webm", "m4v"];

/** What kind of media a path holds, judged by its extension — everything
 * unrecognised is treated as video, which is what this app records. */
export function mediaKindFor(path: string): MediaKind {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  if (IMAGE_EXTENSIONS.includes(extension)) return "image";
  if (AUDIO_EXTENSIONS.includes(extension)) return "audio";
  return "video";
}

export const IMPORT_FILTERS = {
  visual: [
    { name: "Video & images", extensions: [...VIDEO_EXTENSIONS, ...IMAGE_EXTENSIONS] },
  ],
  audio: [{ name: "Audio", extensions: AUDIO_EXTENSIONS }],
};

export const BACKDROP_KINDS = [
  "Desktop",
  "Wallpaper",
  "Image",
  "Color",
  "Gradient",
  "None",
] as const;
export type BackdropKind = (typeof BACKDROP_KINDS)[number];

export const BACKDROP_CATEGORIES = [
  "macOS",
  "Dark",
  "Blue",
  "Cities",
  "Purple",
  "Orange",
] as const;
export type BackdropCategory = (typeof BACKDROP_CATEGORIES)[number];

/** Editor appearance and timeline state. Saved as part of the project, so
 * reopening a `.jd` file restores how it looked. */
/* ------------------------------------------------------------ frame shape */

/** The shape of the picture, written as it is spoken.
 *
 * It belongs to the project rather than to the export, because it decides
 * what the preview is showing: a film being cut for a phone has to be cut
 * against a tall frame, not against a wide one that is squeezed into a
 * tall file at the last moment.
 */
export const FRAME_SHAPES = ["16:9", "9:16", "1:1", "4:5"] as const;
export type FrameShape = (typeof FRAME_SHAPES)[number];

export const FRAME_SHAPE_LABELS: Record<FrameShape, string> = {
  "16:9": "Widescreen",
  "9:16": "Portrait",
  "1:1": "Square",
  "4:5": "Tall",
};

/** Width over height. */
export function shapeRatio(shape: FrameShape): number {
  const [width, height] = shape.split(":").map(Number);
  return height > 0 ? width / height : 16 / 9;
}

export interface EditorSettings {
  /** The shape of the picture. Absent in projects made before there was a
   * choice, which were all widescreen. */
  aspect: FrameShape;
  backdropKind: BackdropKind;
  category: BackdropCategory;
  swatch: number;
  padding: number;
  /** How wide the panel on the right is, in pixels. Dragged by its edge
   * and kept with the project, because how much room the picture gets
   * against how much the controls get is a working preference, not a
   * property of the film. Absent in projects saved before it could be
   * dragged. */
  inspectorWidth?: number;
  /** How wide the agent's column is, and whether it is open at all.
   *
   * Kept with the project for the same reason the inspector's width is:
   * how much room the picture gets against how much the controls get is
   * a working preference. Absent in projects saved before there was a
   * column to open. */
  agentWidth?: number;
  agentOpen?: boolean;
  rounded: number;
  timelineZoom: number;
}

export const DEFAULT_EDITOR_SETTINGS: EditorSettings = {
  aspect: "16:9",
  backdropKind: "Wallpaper",
  category: "Cities",
  swatch: 0,
  padding: 36,
  rounded: 14,
  inspectorWidth: 300,
  agentWidth: 340,
  // Shut to begin with: an empty column taking a third of the picture is
  // not what anyone opening a project for the first time is after.
  agentOpen: false,
  timelineZoom: 25,
};

/** A piece of media placed on a track. Imported media sits in the project
 * pool until it's dragged onto a track, at which point it becomes one of
 * these — so the same file can appear more than once. */
export interface TimelineClip {
  id: string;
  mediaPath: string;
  /** Where the clip begins, in seconds from the start of the timeline. */
  startSeconds: number;
  durationSeconds: number;
  /** How far into its own file the clip starts playing. Zero — and so
   * usually absent — until the clip has been cut: the second half of a cut
   * begins partway through the same file. */
  trimStartSeconds?: number;
  /** Where this clip sits inside the preview frame. Absent until it has
   * been moved or resized, so a clip that has never been touched follows
   * whatever its track's default is. */
  layout?: ClipLayout;
  /** A framing that changes over the course of the clip: zooming into a
   * corner of the screen at one moment and back out at another. Absent
   * while the clip holds still, in which case `layout` is the whole story.
   * Times are the clip's own, so trimming carries them along. */
  layoutPoints?: LayoutPoint[];
  /** Words rather than footage. A clip with this is a title: it has no
   * file behind it, so `mediaPath` is empty and everything that looks up
   * media has to let it pass. */
  text?: TextStyle;
  /** Silenced by hand, from the clip's own menu. */
  muted?: boolean;
  /** Which part of its own picture is kept. Absent means all of it. */
  crop?: Crop;
  /** Rectangles covered over so what is under them never reaches the
   * file. Absent for a clip with nothing to hide. */
  redactions?: Redaction[];
  /** Its colour, as three dials. Absent means untouched. */
  grade?: Grade;
  /** The clip's volume line, sorted by time. Absent — or empty — means a
   * flat line at full volume. One point is an overall level; two or more
   * make an envelope that ramps between them. */
  volume?: VolumePoint[];
  /** Its sound has been split onto the paired audio track, so the picture
   * itself plays silent and the volume is edited on that track instead. */
  audioDetached?: boolean;
  /** This clip is here to be heard, not seen — the half that Split Audio
   * lifts off a video. It stays sound-only wherever it is moved to, which
   * is what tells it apart from a video clip that simply happens to have
   * been dropped on an audio track. */
  soundOnly?: boolean;
  /** How the clip arrives, and how it leaves. Absent means it simply cuts,
   * which is what every clip does until a transition is put on it. */
  transitionIn?: Transition;
  transitionOut?: Transition;
  /** How fast it plays. 1, and so usually absent, until it is changed.
   *
   * It is the one property that makes a clip's length on the timeline
   * differ from the length of the material behind it, which is why every
   * conversion between the two goes through `mediaTimeAt` and `mediaSpan`
   * rather than being written out where it is needed. */
  speed?: number;
  /** The video clip this one's sound was split off from. Set when Split
   * Audio makes it, so that changing the video's speed can change this
   * one's too and the two stay together. */
  sourceClipId?: string;
}

/** A clip's place in the preview frame, so clips on higher tracks can be
 * laid over the ones below — the picture-in-picture arrangement every
 * editor has.
 *
 * `x` and `y` are the offset of the layer's centre from the frame's
 * centre, and `scale` is its width, all as fractions of the frame rather
 * than pixels: the preview is whatever size the window leaves it, and a
 * layout written in pixels would mean something different every time the
 * window was resized. */
/** Which part of a clip's own picture is kept.
 *
 * Fractions of the source, not pixels: a project holding a 4K recording
 * beside a 720p one would otherwise need two sets of numbers meaning the
 * same thing, and a crop would stop meaning what it meant when the file
 * behind it was relinked to a different size.
 *
 * `x` and `y` are the top-left corner, `width` and `height` how much is
 * kept. The whole picture is `{ x: 0, y: 0, width: 1, height: 1 }`, which
 * is what a clip with no crop on it is treated as.
 */
export interface Crop {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const WHOLE_PICTURE: Crop = { x: 0, y: 0, width: 1, height: 1 };

/** The smallest crop worth having. Below this the handles are on top of
 * each other and there is nothing left to see. */
export const MIN_CROP = 0.05;

/** A clip's crop, or the whole picture when it has none. */
export function cropOf(clip: TimelineClip): Crop {
  return clip.crop ?? WHOLE_PICTURE;
}

/** Whether a crop actually takes anything off. */
export function isCropped(crop: Crop): boolean {
  return (
    crop.x > 1e-6 ||
    crop.y > 1e-6 ||
    crop.width < 1 - 1e-6 ||
    crop.height < 1 - 1e-6
  );
}

/** Keeps a crop inside the picture and no smaller than it is worth.
 *
 * Every edge is held before the size is, so dragging a handle past the
 * far side of the picture stops at the edge rather than turning the
 * rectangle inside out.
 */
export function heldCrop(crop: Crop): Crop {
  const x = Math.min(Math.max(crop.x, 0), 1 - MIN_CROP);
  const y = Math.min(Math.max(crop.y, 0), 1 - MIN_CROP);
  const width = Math.min(Math.max(crop.width, MIN_CROP), 1 - x);
  const height = Math.min(Math.max(crop.height, MIN_CROP), 1 - y);
  return { x, y, width, height };
}

/** The shape a clip is drawn at, after its crop.
 *
 * A 16:9 recording cropped to its middle third is no longer 16:9, and the
 * box it is drawn in has to follow or the picture inside it is squashed.
 * Null when the file has not said how big it is yet.
 */
export function croppedShape(
  clip: TimelineClip,
  width: number | null | undefined,
  height: number | null | undefined,
): { width: number; height: number } | null {
  if (!width || !height) return null;
  const crop = cropOf(clip);
  return { width: width * crop.width, height: height * crop.height };
}

/** A rectangle covered over, to keep what is under it out of the film.
 *
 * Email addresses, API keys, client names, a face in a window. This is a
 * safety feature rather than a decoration: somebody who publishes a
 * screen recording with a token in it cannot take it back.
 *
 * Measured in fractions of the clip's picture **after its crop**, because
 * that is what a person sees when they draw the box. Fractions rather
 * than pixels for the same reason a crop uses them: the same box means
 * the same thing whatever the file's size.
 */
export interface Redaction {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** How it is covered.
   *
   * A blur is softer to look at and reads as deliberate. A solid fill is
   * the safer of the two and the only one that leaves nothing at all
   * behind — a blur is a smearing of the pixels that were there, and a
   * light one can sometimes be undone. Anything that must not escape
   * should be filled, not blurred. */
  style: "blur" | "solid";
  /** How soft the blur is, as a fraction of the box's shorter side.
   *
   * Measured against the box rather than in pixels so a setting that
   * looks right stays right on a 4K recording and a 720p one alike.
   * Absent means the default. Ignored by a solid fill, which has nothing
   * to soften. */
  softness?: number;
  /** How round the corners are, as a fraction of the box's shorter side.
   * Zero is square, 0.5 is a full stadium. */
  radius?: number;
}

/** The smallest box worth drawing. */
export const MIN_REDACTION = 0.02;

/** How soft a blur is unless it is told otherwise. A sixth of the box's
 * shorter side: enough that nothing survives it, little enough that it
 * still reads as part of the picture. */
export const DEFAULT_SOFTNESS = 1 / 6;
export const MIN_SOFTNESS = 1 / 40;
/** Found by trying it: ffmpeg refuses a blur radius of half the box's
 * shorter side, at every box size tried, and two fifths is accepted at
 * all of them. A setting the renderer will not accept is worse than one
 * that stops a little short of it. */
export const MAX_SOFTNESS = 0.4;

/** Corners, square unless asked for. */
export const DEFAULT_RADIUS = 0;
export const MAX_RADIUS = 0.5;

export function softnessOf(box: Redaction): number {
  const said = box.softness ?? DEFAULT_SOFTNESS;
  return Math.min(MAX_SOFTNESS, Math.max(MIN_SOFTNESS, said));
}

export function radiusOf(box: Redaction): number {
  return Math.min(MAX_RADIUS, Math.max(0, box.radius ?? DEFAULT_RADIUS));
}

export function redactionsOf(clip: TimelineClip): Redaction[] {
  return clip.redactions ?? [];
}

/** Keeps a box inside the picture and no smaller than it is worth. */
export function heldRedaction(box: Redaction): Redaction {
  const x = Math.min(Math.max(box.x, 0), 1 - MIN_REDACTION);
  const y = Math.min(Math.max(box.y, 0), 1 - MIN_REDACTION);
  return {
    ...box,
    x,
    y,
    width: Math.min(Math.max(box.width, MIN_REDACTION), 1 - x),
    height: Math.min(Math.max(box.height, MIN_REDACTION), 1 - y),
  };
}

/** Colour, as three dials over the whole clip.
 *
 * These three earn their place in a recorder: footage shot against a
 * bright window needs its brightness pulled down, a flat screen capture
 * needs contrast, and a washed-out camera needs saturation. Curves,
 * wheels and white balance are a larger tool than this and are not here.
 *
 * Each is a multiplier where one means untouched, so a clip nobody has
 * graded costs nothing — neither a filter in the export nor a repaint in
 * the preview.
 *
 * They are exactly CSS's `brightness()`, `contrast()` and `saturate()`,
 * applied in that order, because the preview is written in CSS and the
 * renderer has to reproduce whatever the preview shows. ffmpeg's own
 * `eq=contrast` is **not** the same formula — it pivots on luma and comes
 * out as much as fifty levels away — so the renderer spells the CSS one
 * out by hand. See `grade_chain` in export.rs.
 */
export interface Grade {
  brightness: number;
  contrast: number;
  saturation: number;
}

/** Untouched: what every clip has until somebody moves a dial. */
export const NEUTRAL_GRADE: Grade = { brightness: 1, contrast: 1, saturation: 1 };

/** The dials run from nothing to twice. Past twice the picture is clipped
 * to white in every channel and moving the dial further does nothing
 * visible, so the range stops where the effect does. */
export const MIN_GRADE = 0;
export const MAX_GRADE = 2;

/** How far from one still counts as untouched.
 *
 * A slider that reports 0.9999 should not cost a filter on every frame,
 * and both ends of the app have to agree on where the line is — this
 * number is the same one `grade_chain` uses. */
export const GRADE_EPSILON = 0.001;

export function heldGrade(grade: Grade): Grade {
  const held = (n: number) =>
    Number.isFinite(n) ? Math.min(MAX_GRADE, Math.max(MIN_GRADE, n)) : 1;
  return {
    brightness: held(grade.brightness),
    contrast: held(grade.contrast),
    saturation: held(grade.saturation),
  };
}

export function gradeOf(clip: TimelineClip): Grade {
  return clip.grade ? heldGrade(clip.grade) : NEUTRAL_GRADE;
}

export function isGraded(grade: Grade): boolean {
  return (
    Math.abs(grade.brightness - 1) > GRADE_EPSILON ||
    Math.abs(grade.contrast - 1) > GRADE_EPSILON ||
    Math.abs(grade.saturation - 1) > GRADE_EPSILON
  );
}

/** The grade as a CSS filter, or empty when there is nothing to do.
 *
 * The one place the preview's colour is written. Empty rather than
 * `brightness(1) contrast(1) saturate(1)` because a filter — even an
 * idle one — puts the element on its own layer and rounds its colours
 * through the compositor. */
export function gradeFilter(grade: Grade): string {
  if (!isGraded(grade)) return "";
  return [
    `brightness(${grade.brightness})`,
    `contrast(${grade.contrast})`,
    `saturate(${grade.saturation})`,
  ].join(" ");
}

export interface ClipLayout {
  x: number;
  y: number;
  scale: number;
}

/** Every clip fills the frame until it is moved or resized, whichever
 * track it sits on.
 *
 * Upper tracks used to start as a corner inset so that stacking would be
 * obvious at a glance, but that was wrong: a clip on the second track with
 * nothing underneath it showed as a thumbnail in the corner of an empty
 * stage, which reads as the preview having failed to find it. A track is a
 * layer, and a layer covers the ones below — shrinking one into a
 * picture-in-picture is for the corner handles to do, on request. */
export const FULL_FRAME_LAYOUT: ClipLayout = { x: 0, y: 0, scale: 1 };

/** A title's words and how they look. Sizes are fractions of the frame's
 * height rather than pixels, so the same title reads the same whether it
 * is previewed in a small window or rendered at 1080p. */
export interface TextStyle {
  content: string;
  /** Line height as a fraction of the frame's height. */
  size: number;
  color: string;
  /** A panel behind the words, or nothing. */
  background: string | null;
  bold: boolean;
}

export const DEFAULT_TEXT_STYLE: TextStyle = {
  content: "Your title",
  size: 0.09,
  color: "#ffffff",
  background: "#0b2016",
  bold: true,
};

export const DEFAULT_TEXT_SECONDS = 5;

export function isTextClip(clip: TimelineClip): boolean {
  return clip.text != null;
}

/* ------------------------------------------------------------ transitions */

/** How a clip can arrive or leave.
 *
 * Each one is a movement of the same three things the editor already
 * animates — where the layer sits, how big it is, and how solid it is — so
 * a transition is not a separate kind of effect with its own renderer. It
 * is a framing that changes over a second, which is exactly what a zoom
 * is, and it is carried to the finished file the same way.
 */
export const TRANSITIONS = [
  "dissolve",
  "slide-left",
  "slide-right",
  "slide-up",
  "slide-down",
  "slide-top-left",
  "slide-top-right",
  "slide-bottom-left",
  "slide-bottom-right",
  "zoom",
  "zoom-out",
  "pop",
  "grow",
] as const;
export type TransitionKind = (typeof TRANSITIONS)[number];

export const TRANSITION_LABELS: Record<TransitionKind, string> = {
  dissolve: "Dissolve",
  "slide-left": "Slide from left",
  "slide-right": "Slide from right",
  "slide-up": "Slide from top",
  "slide-down": "Slide from bottom",
  "slide-top-left": "Slide from top left",
  "slide-top-right": "Slide from top right",
  "slide-bottom-left": "Slide from bottom left",
  "slide-bottom-right": "Slide from bottom right",
  zoom: "Zoom in",
  "zoom-out": "Zoom out",
  pop: "Pop",
  grow: "Grow",
};

export interface Transition {
  kind: TransitionKind;
  seconds: number;
}

export const DEFAULT_TRANSITION_SECONDS = 0.6;
export const MIN_TRANSITION_SECONDS = 0.1;
export const MAX_TRANSITION_SECONDS = 3;

/** How small a zoom transition starts. Small enough to read as arriving,
 * large enough that the picture is never unrecognisable on the way. */
const ZOOM_TRANSITION_FROM = 0.55;

/** How large a zoom-out starts. Kept modest: a picture that begins at
 * three times its size arrives showing a ninth of itself, and nobody can
 * tell what they are looking at until it lands. */
const ZOOM_OUT_TRANSITION_FROM = 1.55;

/** A pop starts a little under its size and passes a little over it on
 * the way — the overshoot is the whole character of it. */
const POP_TRANSITION_FROM = 0.82;
const POP_OVERSHOOT = 1.7;

/** A grow starts well under its size and simply arrives, without fading:
 * over the clip it follows it reads as a picture opening out rather than
 * appearing. */
const GROW_TRANSITION_FROM = 0.68;

/** Eases past the mark and settles back. The standard "back out" curve:
 * at the end its slope is negative, which is what makes the picture look
 * like it has weight. */
function backOut(t: number): number {
  const over = POP_OVERSHOOT;
  const x = t - 1;
  return 1 + (over + 1) * x * x * x + over * x * x;
}

/** A transition, trimmed to something the clip can actually hold.
 *
 * Half the clip at most: a transition longer than that would still be
 * arriving when it had already begun to leave, and the two would fight
 * over the same frames. */
export function transitionSeconds(
  transition: Transition | undefined,
  clipSeconds: number,
): number {
  if (!transition) return 0;
  return Math.max(
    0,
    Math.min(transition.seconds, MAX_TRANSITION_SECONDS, clipSeconds / 2),
  );
}

/** Where a clip is, and how solid, partway through a transition.
 *
 * `progress` is 0 when the clip has not arrived at all and 1 when it is
 * fully in place; an outgoing transition runs it the other way.
 *
 * Movement is eased and opacity is not, deliberately. The renderer fades
 * alpha in a straight line and has no way to be asked for anything else,
 * so easing the opacity here would make the preview a promise the
 * finished file could not keep. Movement is sampled rather than described,
 * so it can be eased freely.
 */
function transitionShape(
  kind: TransitionKind,
  progress: number,
): { dx: number; dy: number; scale: number; opacity: number } {
  const eased = smoothstep(Math.max(0, Math.min(1, progress)));
  const away = 1 - eased;
  switch (kind) {
    case "dissolve":
      return { dx: 0, dy: 0, scale: 1, opacity: progress };
    case "slide-left":
      return { dx: -away, dy: 0, scale: 1, opacity: 1 };
    case "slide-right":
      return { dx: away, dy: 0, scale: 1, opacity: 1 };
    case "slide-up":
      return { dx: 0, dy: -away, scale: 1, opacity: 1 };
    case "slide-down":
      return { dx: 0, dy: away, scale: 1, opacity: 1 };
    case "slide-top-left":
      return { dx: -away, dy: -away, scale: 1, opacity: 1 };
    case "slide-top-right":
      return { dx: away, dy: -away, scale: 1, opacity: 1 };
    case "slide-bottom-left":
      return { dx: -away, dy: away, scale: 1, opacity: 1 };
    case "slide-bottom-right":
      return { dx: away, dy: away, scale: 1, opacity: 1 };
    case "zoom":
      return {
        dx: 0,
        dy: 0,
        scale: ZOOM_TRANSITION_FROM + (1 - ZOOM_TRANSITION_FROM) * eased,
        opacity: progress,
      };
    case "zoom-out":
      return {
        dx: 0,
        dy: 0,
        scale:
          ZOOM_OUT_TRANSITION_FROM + (1 - ZOOM_OUT_TRANSITION_FROM) * eased,
        opacity: progress,
      };
    case "pop": {
      // The overshoot is taken from the plain progress rather than from
      // the smoothed one: easing an ease flattens exactly the kick this
      // is for.
      const kick = backOut(Math.max(0, Math.min(1, progress)));
      return {
        dx: 0,
        dy: 0,
        scale: POP_TRANSITION_FROM + (1 - POP_TRANSITION_FROM) * kick,
        opacity: progress,
      };
    }
    case "grow":
      return {
        dx: 0,
        dy: 0,
        scale: GROW_TRANSITION_FROM + (1 - GROW_TRANSITION_FROM) * eased,
        // No fade: it opens out over the clip before it rather than
        // appearing out of nothing.
        opacity: 1,
      };
  }
}

/** Whether a transition moves the picture about, as against only fading
 * it. The ones that move have to be sampled for the renderer; the ones
 * that only fade are a filter it already has. */
export function transitionMoves(kind: TransitionKind): boolean {
  return kind !== "dissolve";
}

/** Whether a transition fades as well as moves.
 *
 * This has to agree exactly with whatever `transitionShape` does to
 * opacity, because the renderer is told to fade by this and draws the
 * fade in a straight line. A kind that dims the picture here without
 * saying so would come out of the render solid. */
export function transitionFades(kind: TransitionKind): boolean {
  return (
    kind === "dissolve" || kind === "zoom" || kind === "zoom-out" || kind === "pop"
  );
}

/** Everything about how a clip is drawn at a moment in its own time: the
 * framing its zoom asks for, moved and faded by whichever transitions are
 * running. Past the end of the clip it keeps whatever it last had, which
 * is what an outgoing clip does while the next one fades in over it. */
export interface Framing {
  layout: ClipLayout;
  /** 0 is invisible, 1 fully there. */
  opacity: number;
}

/** Only what the transitions are doing at this moment, with the clip's own
 * framing left out of it. */
function transitionDeltaAt(clip: TimelineClip, seconds: number) {
  let dx = 0;
  let dy = 0;
  let scale = 1;
  let opacity = 1;

  const arriving = transitionSeconds(clip.transitionIn, clip.durationSeconds);
  if (arriving > 0 && seconds < arriving && clip.transitionIn) {
    const shape = transitionShape(clip.transitionIn.kind, seconds / arriving);
    dx += shape.dx;
    dy += shape.dy;
    scale *= shape.scale;
    opacity *= shape.opacity;
  }

  const leaving = transitionSeconds(clip.transitionOut, clip.durationSeconds);
  if (leaving > 0 && seconds > clip.durationSeconds - leaving && clip.transitionOut) {
    const left = (clip.durationSeconds - seconds) / leaving;
    const shape = transitionShape(clip.transitionOut.kind, left);
    dx += shape.dx;
    dy += shape.dy;
    scale *= shape.scale;
    opacity *= shape.opacity;
  }

  return { dx, dy, scale, opacity: Math.max(0, Math.min(1, opacity)) };
}

export function framingAt(clip: TimelineClip, seconds: number): Framing {
  const resting = layoutAt(clip, seconds);
  const move = transitionDeltaAt(clip, seconds);
  return {
    layout: {
      x: resting.x + move.dx,
      y: resting.y + move.dy,
      scale: resting.scale * move.scale,
    },
    opacity: move.opacity,
  };
}

/** The framing for a title.
 *
 * A title's own layout says where the words sit inside the frame, not
 * where the frame sits — the drawing covers the whole stage either way,
 * which is what lets the preview and the export be the same picture. So a
 * transition moves the drawing and leaves the words where they were
 * placed within it.
 */
export function transitionFramingAt(clip: TimelineClip, seconds: number): Framing {
  const move = transitionDeltaAt(clip, seconds);
  return {
    layout: { x: move.dx, y: move.dy, scale: move.scale },
    opacity: move.opacity,
  };
}

/** The framing to draw a clip's layer at, whatever kind of clip it is. */
export function layerFramingAt(clip: TimelineClip, seconds: number): Framing {
  return isTextClip(clip)
    ? transitionFramingAt(clip, seconds)
    : framingAt(clip, seconds);
}

/** How long the clip before this one has to keep playing for this one to
 * fade in over it rather than out of the backdrop.
 *
 * Zero unless the clip actually arrives with a transition — a plain cut
 * needs nothing held.
 */
export function holdForTransition(clip: TimelineClip | undefined): number {
  if (!clip) return 0;
  return transitionSeconds(clip.transitionIn, clip.durationSeconds);
}

/** The clip immediately before this one on the same track, when the two
 * meet with no gap between them.
 *
 * A gap means there is nothing to transition from: the clip arrives out of
 * the backdrop, and holding the earlier clip over the gap would put back
 * on screen something the edit had already left behind.
 */
export function clipBefore(
  clips: TimelineClip[],
  clip: TimelineClip,
): TimelineClip | undefined {
  return clips.find(
    (other) =>
      other.id !== clip.id &&
      Math.abs(other.startSeconds + other.durationSeconds - clip.startSeconds) < 0.002,
  );
}

/** One framing, held at a moment in a clip. Between two of them the
 * picture travels from the first to the second. */
export interface LayoutPoint {
  at: number;
  layout: ClipLayout;
}

/** How far a zoom may be pushed. Past this a screen recording is a few
 * enormous pixels and nothing more. */
export const MAX_ZOOM = 6;

/** The framing a list of points describes at a moment: held before the
 * first and after the last, and easing between them, so a zoom starts and
 * stops gently rather than lurching. */
export function layoutAtPoints(
  points: LayoutPoint[] | undefined,
  seconds: number,
  resting: ClipLayout,
): ClipLayout {
  if (!points || points.length === 0) return resting;
  if (points.length === 1) return points[0].layout;

  const first = points[0];
  const last = points[points.length - 1];
  if (seconds <= first.at) return first.layout;
  if (seconds >= last.at) return last.layout;

  for (let i = 1; i < points.length; i += 1) {
    const from = points[i - 1];
    const to = points[i];
    if (seconds > to.at) continue;
    const span = to.at - from.at;
    if (span <= 0) return to.layout;
    const eased = smoothstep((seconds - from.at) / span);
    return {
      x: from.layout.x + eased * (to.layout.x - from.layout.x),
      y: from.layout.y + eased * (to.layout.y - from.layout.y),
      scale: from.layout.scale + eased * (to.layout.scale - from.layout.scale),
    };
  }
  return last.layout;
}

export function layoutAt(clip: TimelineClip, seconds: number): ClipLayout {
  return layoutAtPoints(clip.layoutPoints, seconds, clip.layout ?? FULL_FRAME_LAYOUT);
}

/** Holds a framing at a moment in a clip, replacing whatever was held
 * there before. */
export function setLayoutAt(
  clip: TimelineClip,
  seconds: number,
  layout: ClipLayout,
): TimelineClip {
  const at = toMillis(Math.max(0, Math.min(clip.durationSeconds, seconds)));
  const existing = clip.layoutPoints ?? [];

  if (existing.length === 0) {
    const resting = clip.layout ?? FULL_FRAME_LAYOUT;
    // The first point on a clip that has only ever held still also gets
    // one at the very beginning, holding what it looked like until now —
    // otherwise a zoom added halfway through would apply to the whole clip
    // rather than being somewhere it travels to.
    return {
      ...clip,
      layoutPoints:
        at > 0.001
          ? [{ at: 0, layout: resting }, { at, layout }]
          : [{ at: 0, layout }],
    };
  }

  return {
    ...clip,
    layoutPoints: [
      ...existing.filter((point) => Math.abs(point.at - at) > 0.001),
      { at, layout },
    ].sort((a, b) => a.at - b.at),
  };
}

/** Takes a framing away. The last one left is no longer a journey, so it
 * becomes the clip's resting framing again. */
export function removeLayoutAt(clip: TimelineClip, seconds: number): TimelineClip {
  const points = (clip.layoutPoints ?? []).filter(
    (point) => Math.abs(point.at - seconds) > 0.001,
  );
  if (points.length <= 1) {
    return {
      ...clip,
      layoutPoints: undefined,
      layout: points[0]?.layout ?? clip.layout,
    };
  }
  return { ...clip, layoutPoints: points };
}

/** The stretch of a zoom between two moments in a clip, rebased to start
 * at zero — the same journey the volume line takes when an edge moves. */
export function sliceLayout(
  points: LayoutPoint[] | undefined,
  from: number,
  to: number,
  resting: ClipLayout,
): LayoutPoint[] | undefined {
  if (!points || points.length === 0 || to <= from) return undefined;
  if (points.length === 1) return points;

  const inside = points
    .filter((point) => point.at > from + 1e-6 && point.at < to - 1e-6)
    .map((point) => ({ at: toMillis(point.at - from), layout: point.layout }));

  return [
    { at: 0, layout: layoutAtPoints(points, from, resting) },
    ...inside,
    { at: toMillis(to - from), layout: layoutAtPoints(points, to, resting) },
  ];
}

/** Video tracks carry the picture and, unless it has been split off, its
 * sound. An audio track carries only sound, split from the video track it
 * is paired with. */
export type TrackKind = "video" | "audio";

export interface TimelineTrack {
  id: string;
  name: string;
  clips: TimelineClip[];
  /** Absent on projects saved before audio tracks existed — everything in
   * those was a video track. */
  kind?: TrackKind;
  /** For an audio track, the video track whose sound it holds. */
  sourceTrackId?: string;
  /** Row height in pixels, when it has been dragged taller than the rest.
   * Absent means the default. */
  height?: number;
  /** Whether the name was chosen by hand. Numbered names are handed out
   * automatically; one that was typed is left alone. */
  named?: boolean;
}

/** Row heights. The default is deliberately short so several tracks fit;
 * one track at a time can be pulled taller to work on it closely. */
export const TRACK_HEIGHT = 37;
export const TRACK_HEIGHT_MIN = 28;
export const TRACK_HEIGHT_MAX = 180;
/** What the expand control jumps to, and back from. */
export const TRACK_HEIGHT_TALL = 96;

export function trackHeightOf(track: TimelineTrack): number {
  return track.height ?? TRACK_HEIGHT;
}

/** A point on a clip's volume line: how loud, and when. `at` is measured
 * from the clip's own start rather than the project's, so moving a clip
 * along the timeline carries its volume line with it.
 *
 * `gain` is a straight multiplier, where 1 is the sound as recorded. It
 * can go above 1: raising a clip is done with a gain stage rather than the
 * media element's own volume, which stops at 1. */
export interface VolumePoint {
  at: number;
  gain: number;
}

/** How far the line reaches above and below the recorded level. Decibels,
 * not multipliers, because that is how loudness is heard and how every
 * other editor labels it: halfway up the line is 0 dB either way. */
export const MAX_BOOST_DB = 12;
export const MIN_GAIN_DB = -48;
export const MAX_GAIN = 10 ** (MAX_BOOST_DB / 20);

/** Where a gain sits on the line: 0 at the bottom, 1 at the top, and 0 dB
 * — the sound exactly as recorded — squarely in the middle, so a point has
 * somewhere to go in both directions. */
export function positionForGain(gain: number): number {
  if (gain <= 0) return 0;
  const db = 20 * Math.log10(gain);
  if (db >= 0) return 0.5 + Math.min(db / MAX_BOOST_DB, 1) * 0.5;
  return 0.5 - Math.min(db / MIN_GAIN_DB, 1) * 0.5;
}

/** The reverse: what a place on the line is worth. */
export function gainForPosition(position: number): number {
  const at = Math.max(0, Math.min(1, position));
  // The bottom of the line is silence rather than merely very quiet, so
  // that dragging a point all the way down does what it looks like.
  if (at <= 0.005) return 0;
  const db =
    at >= 0.5
      ? ((at - 0.5) / 0.5) * MAX_BOOST_DB
      : ((0.5 - at) / 0.5) * MIN_GAIN_DB;
  return 10 ** (db / 20);
}

/** A gain as it is written on screen. */
export function formatGainDb(gain: number): string {
  if (gain <= 0) return "−∞ dB";
  const db = 20 * Math.log10(gain);
  if (db > -0.05 && db < 0.05) return "0.0 dB";
  return `${db > 0 ? "+" : ""}${db.toFixed(1)} dB`;
}

/** A peak reading from the waveform, 0-255, as a height 0-1 on the same
 * decibel scale the volume line uses. A screen recording's peaks often sit
 * around -22 dBFS; drawn on a straight multiplier they would be an almost
 * invisible ridge, while on this scale the shape of the speech is plain. */
export function peakHeight(peak: number): number {
  if (peak <= 0) return 0;
  const db = 20 * Math.log10(peak / 255);
  return Math.max(0, Math.min(1, 1 - db / MIN_GAIN_DB));
}

/** What the backend reports for a file's audio. */
export interface AudioPeaks {
  peaks_per_second: number;
  peaks: number[];
}

/** Eases the ends of a ramp so the line leaves one point and arrives at
 * the next without a corner. Deliberately this rather than a spline
 * through the points: a spline overshoots either side of a control point,
 * and an overshoot on a volume line is a level nobody asked for. */
function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

/** The volume line's reading at a moment inside a clip. Flat before the
 * first point and after the last, and a smooth ramp in between — which is
 * what makes two points a fade.
 *
 * The ramp is worked in line positions rather than in multipliers, for two
 * reasons that amount to the same thing: loudness is heard in decibels, so
 * a fade that is even in decibels is the one that sounds even; and the
 * line is drawn on a decibel scale, so this is what makes the curve on
 * screen the curve that is actually heard. */
export function gainAt(points: VolumePoint[] | undefined, seconds: number): number {
  if (!points || points.length === 0) return 1;
  if (points.length === 1) return points[0].gain;

  const first = points[0];
  const last = points[points.length - 1];
  if (seconds <= first.at) return first.gain;
  if (seconds >= last.at) return last.gain;

  for (let i = 1; i < points.length; i += 1) {
    const from = points[i - 1];
    const to = points[i];
    if (seconds > to.at) continue;
    const span = to.at - from.at;
    if (span <= 0) return to.gain;
    const eased = smoothstep((seconds - from.at) / span);
    return gainForPosition(
      positionForGain(from.gain) +
        eased * (positionForGain(to.gain) - positionForGain(from.gain)),
    );
  }
  return last.gain;
}

/** Divides a volume line at `offset` seconds into the clip, for a cut.
 * Both halves get a point exactly on the seam, holding the level the line
 * read there, so cutting a clip never changes how it sounds. */
export function splitVolume(
  points: VolumePoint[] | undefined,
  offset: number,
): [VolumePoint[] | undefined, VolumePoint[] | undefined] {
  if (!points || points.length === 0) return [undefined, undefined];
  const seam = gainAt(points, offset);
  return [
    [
      ...points.filter((point) => point.at < offset),
      { at: toMillis(offset), gain: seam },
    ],
    [
      { at: 0, gain: seam },
      ...points
        .filter((point) => point.at > offset)
        .map((point) => ({ at: toMillis(point.at - offset), gain: point.gain })),
    ],
  ];
}

/** Clip times are kept to the millisecond.
 *
 * Finer than anything that can be seen or heard, and it stops a run of
 * edits from collecting the dust binary floating point leaves behind: a
 * clip trimmed in and back out a few times would otherwise come to rest at
 * 0.09999999999999964 seconds rather than a tenth of one, and two clips
 * meant to meet exactly would miss each other by a millionth of a second. */
export function toMillis(seconds: number): number {
  return Math.round(seconds * 1000) / 1000;
}

/** The stretch of a volume line between two moments in a clip, rebased so
 * it starts at zero again.
 *
 * Used when a clip's edges move: the line is measured from the clip's own
 * start, so trimming the head off without moving the line with it would
 * slide every fade away from the sound it was drawn against.
 *
 * Both ends get a point holding the level the line read there, so the
 * shortened clip begins and ends exactly as loud as the original did at
 * those moments. */
export function sliceVolume(
  points: VolumePoint[] | undefined,
  from: number,
  to: number,
): VolumePoint[] | undefined {
  if (!points || points.length === 0 || to <= from) return undefined;
  // One point is a level rather than a shape; a level survives any trim.
  if (points.length === 1) return points;

  const inside = points
    .filter((point) => point.at > from + 1e-6 && point.at < to - 1e-6)
    .map((point) => ({ at: toMillis(point.at - from), gain: point.gain }));

  return [
    { at: 0, gain: gainAt(points, from) },
    ...inside,
    { at: toMillis(to - from), gain: gainAt(points, to) },
  ];
}

/* ------------------------------------------------------------------ speed */

/** How far a clip's speed may be pushed. Four times is about as fast as a
 * screen recording stays followable; a quarter is slow enough to study a
 * single frame without the picture turning to mush. */
export const MIN_SPEED = 0.25;
export const MAX_SPEED = 4;

/** The ones worth a button of their own. */
export const SPEED_PRESETS = [0.25, 0.5, 1, 1.5, 2, 4];

export function speedOf(clip: TimelineClip): number {
  const speed = clip.speed;
  if (typeof speed !== "number" || !Number.isFinite(speed) || speed <= 0) return 1;
  return Math.min(MAX_SPEED, Math.max(MIN_SPEED, speed));
}

/** How much of the file a stretch of timeline uses up. */
export function mediaSpan(clip: TimelineClip, timelineSeconds: number): number {
  return timelineSeconds * speedOf(clip);
}

/** The moment in the file that plays at a moment in the clip. */
export function mediaTimeAt(clip: TimelineClip, elapsed: number): number {
  return (clip.trimStartSeconds ?? 0) + elapsed * speedOf(clip);
}

/** How it is said on screen: 1x, 1.5x, 0.25x. */
export function formatSpeed(speed: number): string {
  return `${Number(speed.toFixed(2))}x`;
}

/** The same clip played at a different speed.
 *
 * The stretch of the file it shows is kept and its length on the timeline
 * changes, which is the way round that makes the feature worth having:
 * speeding up a dull minute is meant to make it take less time, not to
 * show less of it.
 *
 * The volume line and the zoom are timed against the clip rather than
 * against the file, so they are stretched with it and stay over the same
 * material.
 */
export function withSpeed(clip: TimelineClip, speed: number): TimelineClip {
  const next = Math.min(MAX_SPEED, Math.max(MIN_SPEED, speed));
  const material = mediaSpan(clip, clip.durationSeconds);
  const duration = toMillis(Math.max(MIN_CLIP_SECONDS, material / next));
  const stretch = clip.durationSeconds > 0 ? duration / clip.durationSeconds : 1;

  return {
    ...clip,
    speed: next === 1 ? undefined : next,
    durationSeconds: duration,
    volume: clip.volume?.map((point) => ({
      at: toMillis(point.at * stretch),
      gain: point.gain,
    })),
    layoutPoints: clip.layoutPoints?.map((point) => ({
      at: toMillis(point.at * stretch),
      layout: point.layout,
    })),
  };
}

/** Sets a clip's speed and closes up after it.
 *
 * A clip that plays faster is shorter, so what comes after it on the same
 * track is moved along by the difference — otherwise speeding up a dull
 * stretch would leave a hole exactly as long as the time it saved, which
 * is the opposite of the point.
 *
 * Only the clip's own track moves. Nothing else is touched — not even
 * the sound that was split off this very clip: splitting it made it a
 * clip in its own right, and a speed given to a picture is given to the
 * picture. The two can be made to match by giving the sound the same
 * speed, which is a second deliberate act rather than a silent one.
 */
/** Where a moment on the timeline ends up when a clip is retimed.
 *
 * A retime moves two different sets of things, and they move differently.
 * Everything *after* the clip shifts by the room it gave up or took, the
 * way `setClipSpeed` shifts the clips. Everything *inside* it stretches
 * or squeezes with it: a note at four seconds into a ten-second clip is
 * about what happens two-fifths of the way through, and when that clip
 * plays in five seconds it is two seconds in, not four.
 *
 * Getting only the first half of that right leaves every note inside a
 * retimed clip pointing at the wrong frame, which is the harder mistake
 * to notice: the note is still roughly where it was, just no longer on
 * the thing it was about.
 *
 * Null when nothing would move: the clip is gone, or it already plays at
 * that speed.
 */
export function speedShift(
  tracks: TimelineTrack[],
  clipId: string,
  speed: number,
): { at: (seconds: number) => number } | null {
  let found: TimelineClip | undefined;
  for (const track of tracks) {
    const match = track.clips.find((clip) => clip.id === clipId);
    if (match) found = match;
  }
  if (!found) return null;

  const wanted = Math.min(MAX_SPEED, Math.max(MIN_SPEED, speed));
  if (speedOf(found) === wanted) return null;

  const start = found.startSeconds;
  const was = found.durationSeconds;
  const now = withSpeed(found, wanted).durationSeconds;
  const ends = start + was;
  const delta = now - was;
  // A thousandth of a second: a moment exactly on the clip's end belongs
  // to what comes after it, not to the clip.
  const touch = 1e-3;

  return {
    at: (seconds: number) => {
      if (seconds < start) return seconds;
      if (seconds >= ends - touch) return Math.max(0, seconds + delta);
      if (was <= 0) return seconds;
      return start + ((seconds - start) * now) / was;
    },
  };
}

export function setClipSpeed(
  tracks: TimelineTrack[],
  clipId: string,
  speed: number,
): TimelineTrack[] {
  let found: TimelineClip | undefined;
  for (const track of tracks) {
    const match = track.clips.find((clip) => clip.id === clipId);
    if (match) found = match;
  }
  if (!found) return tracks;

  const wanted = Math.min(MAX_SPEED, Math.max(MIN_SPEED, speed));
  if (speedOf(found) === wanted) return tracks;

  const oldEnd = found.startSeconds + found.durationSeconds;
  const delta = withSpeed(found, wanted).durationSeconds - found.durationSeconds;

  return tracks.map((track) => {
    if (!track.clips.some((clip) => clip.id === clipId)) return track;
    const clips = track.clips
      .map((clip) => {
        if (clip.id === clipId) return withSpeed(clip, wanted);
        // Everything that began at or after the old end shifts by the
        // difference. A clip that straddles that moment is left alone:
        // moving it would break its own place against the picture.
        if (clip.startSeconds >= oldEnd - 0.001) {
          return { ...clip, startSeconds: toMillis(clip.startSeconds + delta) };
        }
        return clip;
      })
      .sort((a, b) => a.startSeconds - b.startSeconds);
    return { ...track, clips };
  });
}

/** The shortest a clip may be trimmed to. Long enough to still be grabbed
 * and dragged back out again. */
export const MIN_CLIP_SECONDS = 0.1;

/** A clip's edges after a trim, with everything that depends on them
 * brought along and every limit applied.
 *
 * `edge` says which end was dragged and `seconds` where it was dropped, in
 * timeline time. The result is clamped to what the file can actually
 * supply: the head cannot go back past the file's first frame, the tail
 * cannot run past its last, and neither may cross the other.
 *
 * Absolute rather than a delta on purpose — a drag asks for the same edge
 * position many times a second, and asking twice has to mean the same as
 * asking once. */
export function trimClip(
  clip: TimelineClip,
  edge: "start" | "end",
  seconds: number,
  mediaSeconds: number | null | undefined,
): TimelineClip {
  const trimStart = clip.trimStartSeconds ?? 0;
  const speed = speedOf(clip);
  const end = clip.startSeconds + clip.durationSeconds;

  if (edge === "start") {
    // Back no further than the file's own beginning, and no later than a
    // hair before the tail. The head of the file is `trimStart` seconds of
    // material away, which at this speed is that much less time.
    const earliest = Math.max(0, clip.startSeconds - trimStart / speed);
    const latest = end - MIN_CLIP_SECONDS;
    const at = toMillis(Math.min(Math.max(seconds, earliest), latest));
    const moved = at - clip.startSeconds;
    return {
      ...clip,
      startSeconds: at,
      trimStartSeconds: toMillis(trimStart + moved * speed),
      durationSeconds: toMillis(clip.durationSeconds - moved),
      volume: sliceVolume(clip.volume, moved, clip.durationSeconds),
      layoutPoints: sliceLayout(
        clip.layoutPoints,
        moved,
        clip.durationSeconds,
        clip.layout ?? FULL_FRAME_LAYOUT,
      ),
    };
  }

  // The tail can be pulled back out only as far as the file still has
  // material; a still has none to run out of.
  const available =
    typeof mediaSeconds === "number" && mediaSeconds > 0
      ? (mediaSeconds - trimStart) / speed
      : Number.POSITIVE_INFINITY;
  const longest = clip.startSeconds + available;
  const at = toMillis(
    Math.min(Math.max(seconds, clip.startSeconds + MIN_CLIP_SECONDS), longest),
  );
  const duration = toMillis(at - clip.startSeconds);
  return {
    ...clip,
    durationSeconds: duration,
    volume: sliceVolume(clip.volume, 0, duration),
    layoutPoints: sliceLayout(
      clip.layoutPoints,
      0,
      duration,
      clip.layout ?? FULL_FRAME_LAYOUT,
    ),
  };
}

/** Puts a clip on a track, making room for it.
 *
 * A track plays one thing at a time, so whatever the newcomer lands on
 * gives way: a clip it covers entirely goes, one it overlaps at an edge is
 * trimmed back, and one it lands in the middle of is left as a piece
 * either side. A piece too short to be worth keeping is dropped rather
 * than left as a sliver nobody can grab.
 *
 * Without this two clips would simply sit on top of each other and which
 * one played was settled by whichever happened to come first in the
 * array — an order that changed every time a clip was moved. The result is
 * returned in time order, so "what is playing at this moment" has exactly
 * one answer.
 *
 * Everything it does is one step to undo. */
/** Cuts every clip that the playhead is standing in.
 *
 * Lifted out of the editor's own handler so that the scissors and an
 * automatic edit cut by the same rule. Two copies of this would drift,
 * and the day they did, an edit made from the transcript would divide a
 * clip differently from the one made by hand — the kind of difference
 * nobody notices until a volume line or a zoom comes out wrong.
 *
 * `clipId` narrows it to one clip; without it, every clip the moment
 * crosses is cut. The count comes back because the caller tells the
 * person how many clips were cut, and because nothing should be recorded
 * for undo when the answer is none.
 */
export function splitClipAt(
  tracks: TimelineTrack[],
  atSeconds: number,
  clipId?: string,
): { tracks: TimelineTrack[]; cuts: number } {
  let cuts = 0;
  const next = tracks.map((track) => {
    const clips: TimelineClip[] = [];
    for (const clip of track.clips) {
      const offset = atSeconds - clip.startSeconds;
      // Too close to either end and one of the halves would be empty.
      const splittable =
        (clipId == null || clip.id === clipId) &&
        offset > 0.05 &&
        offset < clip.durationSeconds - 0.05;
      if (!splittable) {
        clips.push(clip);
        continue;
      }

      const [before, after] = splitVolume(clip.volume, offset);
      const resting = clip.layout ?? FULL_FRAME_LAYOUT;
      const tail = toMillis(clip.durationSeconds - offset);
      clips.push({
        ...clip,
        durationSeconds: toMillis(offset),
        volume: before,
        // The zoom is divided along with the sound. Handing both halves
        // the whole list left the second one holding framings timed
        // against a clip it is no longer part of.
        layoutPoints: sliceLayout(clip.layoutPoints, 0, offset, resting),
        // The cut is a cut: the first half keeps how it arrived, the
        // second keeps how it leaves, and neither gains a transition at
        // the join that the editor never asked for.
        transitionOut: undefined,
      });
      clips.push({
        ...clip,
        id: newId("clip"),
        startSeconds: toMillis(atSeconds),
        durationSeconds: tail,
        // The second half begins further into the file by as much
        // material as the first half used, which at anything but normal
        // speed is not the same as the time it took.
        trimStartSeconds: toMillis(mediaTimeAt(clip, offset)),
        volume: after,
        layoutPoints: sliceLayout(
          clip.layoutPoints,
          offset,
          clip.durationSeconds,
          resting,
        ),
        transitionIn: undefined,
      });
      cuts += 1;
    }
    return clips.length === track.clips.length ? track : { ...track, clips };
  });

  return { tracks: next, cuts };
}

/** Where a clip can sit on a track without covering anything.
 *
 * Starts from where it was let go of and moves right, past the end of
 * each clip it would have overlapped, until it lands somewhere free.
 *
 * This is the rule for a clip being dragged: nothing it is dropped on
 * gets shorter, and nothing disappears. Dropping a clip onto another one
 * used to cut the other one back to make room — which is a fine rule for
 * a clip being deliberately laid over a gap, and a poor one for a hand
 * that slipped: the clip underneath had been trimmed to length on
 * purpose, and getting it back means undoing and doing it all again.
 *
 * Right rather than left because the drop point is where the *start* of
 * the clip was put: pushing it right keeps it after the thing it ran
 * into, which is where it was heading.
 */
export function settleStart(
  clips: TimelineClip[],
  incoming: TimelineClip,
  wanted: number,
): number {
  // A thousandth of a second: clips that merely touch do not overlap.
  const touch = 1e-3;
  const others = clips
    .filter((clip) => clip.id !== incoming.id)
    .sort((a, b) => a.startSeconds - b.startSeconds);

  let at = Math.max(0, wanted);
  // Pushing past one clip can run it into the next, so this keeps going
  // until a pass changes nothing. Every pass moves it strictly right and
  // there are finitely many clips, so it always ends.
  let settled = false;
  while (!settled) {
    settled = true;
    for (const other of others) {
      const otherEnd = other.startSeconds + other.durationSeconds;
      const overlaps =
        at < otherEnd - touch && at + incoming.durationSeconds > other.startSeconds + touch;
      if (overlaps) {
        at = otherEnd;
        settled = false;
      }
    }
  }
  return toMillis(at);
}

/** Puts a clip on a track without shortening anything already there.
 *
 * The result is in time order, so "what is playing at this moment" still
 * has exactly one answer.
 */
export function settleOnTrack(
  clips: TimelineClip[],
  incoming: TimelineClip,
): TimelineClip[] {
  const at = settleStart(clips, incoming, incoming.startSeconds);
  const placed =
    Math.abs(at - incoming.startSeconds) < 1e-9
      ? incoming
      : { ...incoming, startSeconds: at };
  return [...clips.filter((clip) => clip.id !== incoming.id), placed].sort(
    (a, b) => a.startSeconds - b.startSeconds,
  );
}

/** How far one edge of a clip may be trimmed before it would run into its
 * neighbour on the same track. A trim stops at the neighbour rather than
 * eating it — dragging an edge is a small adjustment, and it should not be
 * able to destroy the clip beside it by accident. */
export function trimLimit(
  clips: TimelineClip[],
  clip: TimelineClip,
  edge: "start" | "end",
): number {
  const end = clip.startSeconds + clip.durationSeconds;
  if (edge === "start") {
    let earliest = 0;
    for (const other of clips) {
      if (other.id === clip.id) continue;
      const otherEnd = other.startSeconds + other.durationSeconds;
      if (otherEnd <= clip.startSeconds + 1e-3) earliest = Math.max(earliest, otherEnd);
    }
    return earliest;
  }
  let latest = Number.POSITIVE_INFINITY;
  for (const other of clips) {
    if (other.id === clip.id) continue;
    if (other.startSeconds >= end - 1e-3) latest = Math.min(latest, other.startSeconds);
  }
  return latest;
}

/** A flat line made explicit, so a point can be added to it. */
export function volumePointsOf(clip: TimelineClip): VolumePoint[] {
  const points = clip.volume;
  if (points && points.length >= 2) return points;
  const gain = points?.[0]?.gain ?? 1;
  return [
    { at: 0, gain },
    { at: clip.durationSeconds, gain },
  ];
}

/** Stamps `soundOnly` on the clips of audio tracks that predate the flag.
 * Without it, an older project's split-off audio — which points at a video
 * file — would be taken for a video clip and start showing a picture.
 *
 * A title is never stamped. It has no file behind it and no sound in it,
 * and marking one as sound sent the editor looking for audio at an empty
 * path: pressing play then stopped the whole timeline with "nothing here
 * can decode it". A title on an audio track is still a title. */
export function withSoundOnlyClips(tracks: TimelineTrack[]): TimelineTrack[] {
  return tracks.map((track) =>
    trackKindOf(track) !== "audio"
      ? track
      : {
          ...track,
          clips: track.clips.map((clip) =>
            clip.soundOnly === undefined && !isTextClip(clip)
              ? { ...clip, soundOnly: true }
              : clip,
          ),
        },
  );
}

/** Whether a clip is heard rather than seen.
 *
 * The clip's own nature, not the lane's: a video dragged onto an audio
 * track is still a video, and the half Split Audio lifted off one stays
 * sound wherever it is put. A title is neither — it is drawn, not played
 * — so it is never sound, whatever flag a project may have saved on it.
 * That last clause is the load-bearing one: projects already written with
 * a title marked as sound have to open and play. */
export function isSoundClip(clip: TimelineClip, kind: MediaKind): boolean {
  if (isTextClip(clip)) return false;
  return Boolean(clip.soundOnly) || kind === "audio";
}

export function trackKindOf(track: TimelineTrack): TrackKind {
  return track.kind ?? "video";
}

/** Names every track after where it sits, so the numbering stays right
 * when one is added, split off or removed: video tracks are "Track 1",
 * "Track 2" and so on, and an audio track takes the number of the video
 * track its sound came from — Track 2's sound lands on "Audio 2".
 *
 * Called on every structural change rather than when a track is created,
 * because a name written once goes stale the moment the track above it
 * goes away. */
export function withTrackNames(tracks: TimelineTrack[]): TimelineTrack[] {
  const numberOf = new Map<string, number>();
  let videos = 0;
  for (const track of tracks) {
    if (trackKindOf(track) === "video") {
      videos += 1;
      numberOf.set(track.id, videos);
    }
  }

  // An audio track with no video track to point at can still be numbered;
  // it just falls back to counting audio tracks in order.
  let loose = 0;
  return tracks.map((track) => {
    let name: string;
    if (trackKindOf(track) === "video") {
      name = `Track ${numberOf.get(track.id)}`;
    } else {
      const paired = track.sourceTrackId
        ? numberOf.get(track.sourceTrackId)
        : undefined;
      if (paired == null) loose += 1;
      name = `Audio ${paired ?? loose}`;
    }
    // A name the user typed is theirs. Numbering the tracks is a
    // convenience for the ones nobody has bothered to name, and quietly
    // renaming "Interview" back to "Track 2" would not be one.
    if (track.named) return track;
    return track.name === name ? track : { ...track, name };
  });
}

/** How long a clip runs when its media hasn't reported a duration — a
 * still image has none at all, and a video that's still being probed
 * doesn't have one yet. */
/** A clip on the clipboard, held with its place measured from the
 * earliest of the group rather than from the start of the timeline. */
export interface CopiedClip {
  clip: TimelineClip;
  /** Seconds after the earliest piece in the group. */
  startOffset: number;
  /** Tracks below the one the earliest piece came from. */
  trackOffset: number;
}

/** Takes copies of clips, keeping the arrangement they were in.
 *
 * Measured from the earliest of them, and from the track that one was on,
 * so the group can be put down somewhere else and still be the same
 * shape. Without this a group pasted anywhere would land in a heap at one
 * moment on one track.
 *
 * The result is in time order, which is the order they play and so the
 * order it is safe to lay them down in.
 */
export function copyOf(
  tracks: TimelineTrack[],
  clipIds: string[],
): CopiedClip[] {
  const wanted = new Set(clipIds);
  const found: { clip: TimelineClip; track: number }[] = [];
  tracks.forEach((track, index) => {
    for (const clip of track.clips) {
      if (wanted.has(clip.id)) found.push({ clip, track: index });
    }
  });
  if (found.length === 0) return [];

  found.sort((a, b) =>
    a.clip.startSeconds === b.clip.startSeconds
      ? a.track - b.track
      : a.clip.startSeconds - b.clip.startSeconds,
  );
  const first = found[0];
  return found.map((entry) => ({
    clip: entry.clip,
    startOffset: toMillis(entry.clip.startSeconds - first.clip.startSeconds),
    trackOffset: entry.track - first.track,
  }));
}

/** Where one clip is to end up. */
export interface ClipMove {
  clipId: string;
  trackId: string;
  startSeconds: number;
}

/** Where a whole selection ends up when one of its clips is dragged.
 *
 * The clip under the pointer goes exactly where it was dropped; the rest
 * keep their places relative to it, shifting by the same amount of time
 * and the same number of tracks. A clip that would fall off the top or the
 * bottom of the track list is held at the end one rather than lost.
 *
 * Nothing is moved before the start of the timeline: the whole group is
 * held back together if the earliest of them would have gone negative, so
 * the arrangement survives being dragged too far left.
 */
export function moveSelection(
  tracks: TimelineTrack[],
  clipIds: string[],
  draggedId: string,
  toTrackId: string,
  toSeconds: number,
): ClipMove[] {
  const place = new Map<string, { clip: TimelineClip; track: number }>();
  tracks.forEach((track, index) => {
    for (const clip of track.clips) {
      if (clipIds.includes(clip.id)) place.set(clip.id, { clip, track: index });
    }
  });

  const dragged = place.get(draggedId);
  const landing = tracks.findIndex((track) => track.id === toTrackId);
  if (!dragged || landing < 0) {
    return [{ clipId: draggedId, trackId: toTrackId, startSeconds: toSeconds }];
  }

  const shift = toSeconds - dragged.clip.startSeconds;
  const earliest = Math.min(
    ...[...place.values()].map((found) => found.clip.startSeconds),
  );
  // Held back as one rather than piling up against zero one clip at a time.
  const held = Math.max(shift, -earliest);
  const drop = landing - dragged.track;

  return [...place.values()].map((found) => ({
    clipId: found.clip.id,
    trackId:
      tracks[Math.max(0, Math.min(tracks.length - 1, found.track + drop))].id,
    startSeconds: toMillis(found.clip.startSeconds + held),
  }));
}

export const DEFAULT_CLIP_SECONDS = 5;

let idCounter = 0;

/** Ids only have to be unique within a project, and this avoids depending
 * on `crypto.randomUUID`, which needs a secure context — not something to
 * bet on across Tauri's custom protocol origin and the dev server. */
export function newId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${idCounter}`;
}

export function newTrack(name: string, kind: TrackKind = "video"): TimelineTrack {
  return { id: newId("track"), name, kind, clips: [] };
}

/** The contents of a `.jd` project file. Only what can't be recomputed is
 * stored: durations and thumbnails are read back off disk on open.
 *
 * `tracks` is optional so that projects saved before the timeline existed
 * still open — they simply arrive with no tracks laid out yet. */
export interface ProjectFile {
  format: "jdeditor-project";
  version: 1;
  name: string;
  /** `path` is where the file was when the project was saved. `relative`
   * is where it sits beneath the project's own folder, when it does — that
   * is what lets a project and its footage be moved together without the
   * clips losing sight of them. Opening tries the relative one first. */
  media: { path: string; name: string; relative?: string }[];
  tracks?: TimelineTrack[];
  /** Notes left along the timeline. Absent in projects saved before there
   * were any. */
  notes?: ProjectNote[];
  /** What was heard, with the moment each word was said.
   *
   * Kept with the project rather than recomputed, because recomputing it
   * means sending the audio to a paid service again. Absent in projects
   * saved before it was carried, and in projects nothing has been
   * transcribed in. */
  words?: TimedWord[];
  activeMediaPath: string | null;
  settings: EditorSettings;
}

export const PROJECT_EXTENSION = "jd";

/** Work in progress, kept between saves so that an editor which never got
 * the chance to close properly can offer it back.
 *
 * It holds the project exactly as a `.jd` file would, plus where that file
 * was — the project may never have been saved at all, in which case there
 * is no path and the recovered work is simply untitled again. */
export interface RecoveryFile {
  format: "jdeditor-recovery";
  version: 1;
  /** When it was written, from the clock of the machine that wrote it. */
  savedAtMs: number;
  /** The `.jd` it belongs to, or null for a project never saved. */
  projectPath: string | null;
  project: ProjectFile;
}

/** How long ago, said the way a person would. */
export function timeAgo(msSince: number): string {
  const seconds = Math.max(0, Math.round(msSince / 1000));
  if (seconds < 90) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours === 1 ? "an hour ago" : `${hours} hours ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

/* --------------------------------------------------------- media paths */

/** Paths are compared and joined with forward slashes throughout. Windows
 * accepts them everywhere, and mixing the two separators is how a path
 * ends up not matching one that means the same place. */
function normalisePath(path: string): string {
  return path.split(String.fromCharCode(92)).join("/");
}

/** The folder a file lives in, whichever separator it was written with. */
export function folderOf(filePath: string): string {
  const path = normalisePath(filePath);
  const at = path.lastIndexOf("/");
  return at < 0 ? "" : path.slice(0, at);
}

/** Where a media file sits relative to its project, when it sits beneath
 * it at all.
 *
 * Only files under the project's own folder get one. That is the case
 * worth supporting — a project and its footage kept together and moved
 * together — and it is the only one where a relative path is certain to
 * still mean the same file afterwards. Anything else stays absolute and
 * relies on being found again by hand.
 *
 * Compared without regard to case, because Windows does not distinguish
 * `C:/Videos` from `c:/videos` but string equality does. */
export function toRelativeMediaPath(
  mediaPath: string,
  projectPath: string | null,
): string | undefined {
  if (!projectPath) return undefined;
  const folder = folderOf(projectPath);
  if (!folder) return undefined;
  const media = normalisePath(mediaPath);
  const prefix = `${folder}/`;
  if (media.toLowerCase().startsWith(prefix.toLowerCase())) {
    return media.slice(prefix.length);
  }
  return undefined;
}

/** The other direction: a stored relative path made whole again against
 * wherever the project is being opened from now. */
export function fromRelativeMediaPath(
  relative: string,
  projectPath: string,
): string {
  const folder = folderOf(projectPath);
  return folder ? `${folder}/${normalisePath(relative)}` : normalisePath(relative);
}

/** A file's own name, without the folders above it. */
export function mediaFileName(path: string): string {
  return normalisePath(path).split("/").pop() ?? path;
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return "";
  const total = Math.round(seconds);
  const m = Math.floor(total / 60)
    .toString()
    .padStart(2, "0");
  const s = Math.floor(total % 60)
    .toString()
    .padStart(2, "0");
  return `${m}:${s}`;
}


/* ------------------------------------------------------------- exporting */

export const EXPORT_FORMATS = ["mp4", "webm", "mov", "gif", "mp3"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export const EXPORT_FORMAT_LABELS: Record<ExportFormat, string> = {
  mp4: "MP4 · H.264 — plays everywhere",
  webm: "WebM · VP9 — smaller, for the web",
  mov: "MOV · H.264 — for Final Cut and friends",
  gif: "GIF — short, silent, loops",
  mp3: "MP3 — the sound only",
};

/** Every preset is 16:9, which is the shape of the preview: a clip of some
 * other shape is letterboxed inside it there, and has to be letterboxed
 * the same way here or the export wouldn't match what was edited. */
export const EXPORT_RESOLUTIONS = ["480p", "720p", "1080p", "source"] as const;
export type ExportResolution = (typeof EXPORT_RESOLUTIONS)[number];

export const EXPORT_QUALITIES = ["small", "balanced", "best"] as const;
export type ExportQuality = (typeof EXPORT_QUALITIES)[number];

export const EXPORT_QUALITY_LABELS: Record<ExportQuality, string> = {
  small: "Smaller file",
  balanced: "Balanced",
  best: "Best looking",
};

export const EXPORT_FPS_OPTIONS = [15, 24, 30, 60] as const;

export interface ExportSettings {
  format: ExportFormat;
  resolution: ExportResolution;
  quality: ExportQuality;
  fps: number;
}

export const DEFAULT_EXPORT_SETTINGS: ExportSettings = {
  format: "mp4",
  resolution: "1080p",
  quality: "balanced",
  fps: 30,
};

/** What the renderer is handed: placements reduced to numbers, with every
 * question about tracks, layers and decibels already answered. */
export interface ExportPlanClip {
  /** Which part of its own picture is kept, as fractions of the source.
   * Absent for a clip that keeps all of it. */
  crop?: Crop;
  /** Rectangles covered over, in fractions of the cropped picture. */
  redactions?: Redaction[];
  /** Its colour. Absent for a clip nobody has graded. */
  grade?: Grade;
  path: string;
  start: number;
  duration: number;
  trimStart: number;
  visual: boolean;
  audible: boolean;
  still: boolean;
  /** Whether the project's corner radius applies to it. Footage gets it;
   * a title, which is words on a transparent sheet, does not. */
  rounded: boolean;
  /** How long the clip fades up at its start and away at its end, in its
   * own seconds. Zero for a transition that only moves, and for a plain
   * cut. */
  fadeIn: number;
  fadeOut: number;
  /** Extra seconds of the clip's own material to keep playing after its
   * end, so the clip that follows can arrive over the top of it rather
   * than out of the backdrop. */
  hold: number;
  /** The part of that hold there is no material left for, which is held on
   * the last frame instead. */
  freeze: number;
  /** How fast it plays. Every other number here is in timeline seconds;
   * this is what turns them into seconds of the file. */
  speed: number;
  /** Width as a fraction of the stage, and the centre of the layer as a
   * fraction of the stage measured from the stage's own centre. */
  scale: number;
  x: number;
  y: number;
  volume: VolumePoint[];
  /** The zoom, sampled along the clip. Empty when its framing holds
   * still, which is the common case and the cheap one to render. */
  zoom: { at: number; scale: number; x: number; y: number }[];
}

export interface ExportPlan {
  outputPath: string;
  format: ExportFormat;
  /** The whole picture, backdrop included. */
  width: number;
  height: number;
  /** Where the footage goes inside that picture: the frame inset by the
   * padding. Clip placements are fractions of this, not of the frame. */
  stage: { x: number; y: number; width: number; height: number };
  /** Corner radius for footage, in the frame's own pixels. */
  radius: number;
  /** The backdrop the editor drew, on disk, or null for a bare frame. */
  backdrop: string | null;
  fps: number;
  duration: number;
  videoQuality: number;
  audioBitrateKbps: number;
  clips: ExportPlanClip[];
}

export interface ExportProgress {
  fraction: number;
  seconds_done: number;
  seconds_total: number;
}

/* --------------------------------------------------------- auto caption */

/** One transcription service, as the app reports it.
 *
 * Never carries the key. What the editor is told is only whether a key has
 * been entered, so a key cannot reach a screenshot or a log by way of the
 * interface. */
/** What a model is being asked to be.
 *
 * Three different jobs, and no one service does all three — nor, today,
 * is any one service even capable of all three. So each is chosen on its
 * own. */
export type AiRole = "ears" | "eyes" | "brain";

export const AI_ROLES: { id: AiRole; label: string; what: string }[] = [
  {
    id: "ears",
    label: "Ears",
    what: "Turns speech into words with times against them. Only a transcription service can do this.",
  },
  {
    id: "eyes",
    label: "Eyes",
    what: "Describes a frame, so the editor can be asked about what is on screen.",
  },
  {
    id: "brain",
    label: "Brain",
    what: "Reads the transcript and the timeline, and proposes the edits.",
  },
];

/** What the brain answered.
 *
 * `operations` are proposals, exactly as the model sent them. Nothing has
 * been checked and nothing has been applied: the editor decides whether
 * they make sense and a person decides whether they happen. */
export interface AgentReply {
  text: string;
  operations: unknown[];
  /** Who answered, so the panel can say so. */
  model: string;
  /** Moments on the timeline it wants to see before it can answer.
   *
   * Non-empty means nothing has been decided: the editor fetches these
   * frames and asks again with them. */
  looks: number[];
}

/** A frame handed back to the model, and where on the timeline it came
 * from. */
export interface AgentFrame {
  path: string;
  atSeconds: number;
}

/** One turn of a conversation with the agent. */
export interface AgentTurn {
  role: "user" | "assistant";
  content: string;
  /** What this turn proposed, when it was the agent's. */
  operations?: unknown[];
  /** Who said it, for an agent's turn. */
  model?: string;
}

/** One model the editor can call on.
 *
 * `hasKey` is about the provider, not this model: one key buys every
 * model that provider offers. The key itself never comes back here. */
export interface AiModel {
  id: string;
  /** The provider's id, which is what a key is filed under. */
  provider: string;
  providerName: string;
  model: string;
  note: string;
  keysAt: string;
  /** The roles this model is able to fill. */
  roles: AiRole[];
  hasKey: boolean;
  /** The roles it is currently marked for. */
  chosenFor: AiRole[];
}

export interface SpeechEngine {
  id: string;
  provider: string;
  model: string;
  /** What it is good for, in the words someone choosing would want. */
  note: string;
  /** Where its keys are issued. */
  keysAt: string;
  hasKey: boolean;
  isDefault: boolean;
}

/** One caption the service heard, and where it belongs. */
export interface CaptionSegment {
  clipId: string;
  start: number;
  duration: number;
  text: string;
}

/** One word, and when it was heard on the timeline.
 *
 * The transcription services time every word, and those times used to be
 * used to group words into captions and then dropped. They are what
 * transcript-driven editing is built from: to cut a filler word out of a
 * take you have to know exactly when it was said.
 *
 * The times are timeline seconds, mapped the same way a caption's are, so
 * a word can be handed straight to an edit without further arithmetic. */
export interface TimedWord {
  clipId: string;
  word: string;
  start: number;
  end: number;
}

/** What a transcription run answers with: captions to lay down, and the
 * words they were made from. */
export interface CaptionResult {
  captions: CaptionSegment[];
  words: TimedWord[];
}

/** How far along a transcription is. */
export interface CaptionProgress {
  stage: "listening" | "done";
  done: number;
  total: number;
  engine: string;
}

/** The languages worth offering by name. Anything else can be had by
 * letting the service work it out, which every one of them does well. */
/** What a language code amounts to, in the reader's own language.
 *
 * There used to be a list of six languages here, which meant that anyone
 * recording in a seventh simply had no option to pick — while the
 * transcription services themselves take any ISO code and handle dozens.
 * A list written by hand serves only the languages its author happened to
 * think of, and this editor is meant for more people than that.
 *
 * So there is no list. A code is typed, and this says what it means —
 * using the table the platform already carries, which is nobody's to
 * maintain and is itself translated.
 *
 * Returns null for anything that is not a language, which is how the
 * field tells someone they have mistyped without refusing what they
 * wrote: the services accept codes this browser may not know.
 */
export function languageName(code: string): string | null {
  const wanted = code.trim();
  if (wanted.length === 0) return null;
  try {
    const names = new Intl.DisplayNames(undefined, { type: "language" });
    const said = names.of(wanted);
    // Unknown codes come back as the code itself, which tells us nothing.
    return said && said.toLowerCase() !== wanted.toLowerCase() ? said : null;
  } catch {
    // An invalid tag throws rather than answering.
    return null;
  }
}

/** How many words a caption may hold. Three or four is the short,
 * fast-changing style; six reads more like a subtitle. */
export const CAPTION_WORD_COUNTS = [2, 3, 4, 5, 6] as const;

/** What a caption looks like: smaller than a title, and low in the frame
 * where captions belong. The panel behind the words is what keeps them
 * readable over a bright screen recording. */
export const CAPTION_TEXT_STYLE: TextStyle = {
  content: "",
  size: 0.055,
  color: "#ffffff",
  background: "#000000",
  bold: true,
};

/** Where captions sit inside the frame: below the middle, clear of the
 * bottom edge. A fraction of the frame, like every other layout, so it
 * means the same thing in the file as on screen. */
export const CAPTION_LAYOUT: ClipLayout = { x: 0, y: 0.33, scale: 1 };

/** The clips to listen to, in the order they play.
 *
 * Exactly what would be heard if the timeline were played: a muted clip is
 * not transcribed, nor is a title, nor a clip whose sound has been lifted
 * onto its own track — that track's own clip is the one carrying the sound
 * now, and it is in this list instead. */
export function clipsWorthHearing(tracks: TimelineTrack[]): TimelineClip[] {
  const out: TimelineClip[] = [];
  for (const track of tracks) {
    for (const clip of track.clips) {
      if (isTextClip(clip)) continue;
      if (clip.muted) continue;
      if (clip.audioDetached && !clip.soundOnly) continue;
      out.push(clip);
    }
  }
  return out.sort((a, b) => a.startSeconds - b.startSeconds);
}

/** Turns what was heard into clips on a track of their own.
 *
 * Captions are title clips: the same kind of clip the Text button makes,
 * which is why they need nothing new from the renderer and can be moved,
 * retimed, restyled and deleted like anything else on the timeline. */
export function captionClips(
  captions: CaptionSegment[],
  style: TextStyle = CAPTION_TEXT_STYLE,
): TimelineClip[] {
  const stamp = Date.now();
  return captions
    .filter((caption) => caption.text.trim().length > 0 && caption.duration > 0)
    .map((caption, index) => ({
      id: `caption-${stamp}-${index}`,
      mediaPath: "",
      startSeconds: toMillis(caption.start),
      durationSeconds: toMillis(caption.duration),
      text: { ...style, content: caption.text.trim() },
      layout: { ...CAPTION_LAYOUT },
      /** Which clip it was heard in, so a caption can be traced back. */
      sourceClipId: caption.clipId,
    }));
}

/* ------------------------------------------------------------ the shelf */

/** One clip kept across projects.
 *
 * A real file cut to the piece that was saved, not a reference to the
 * take it came from: a reference would break the first time a recording
 * was moved or cleared out. */
export interface SavedClip {
  id: string;
  name: string;
  /** "video" or "audio". */
  kind: string;
  seconds: number;
  path: string;
  thumbnailPath?: string | null;
  savedAt: string;
}

/* -------------------------------------------------------- sound library */

/** What may be done with a piece of sound from the library.
 *
 * Kept as the app reports it rather than worked out here: which licence a
 * file carries is a fact about the file, and a second opinion about it in
 * the editor could only ever disagree. */
export type SoundLicence = "cc0" | "attribution" | "non-commercial" | "unknown";

export const LICENCE_LABELS: Record<SoundLicence, string> = {
  cc0: "CC0 — no credit needed",
  attribution: "CC-BY — credit the maker",
  "non-commercial": "CC-BY-NC — not for paid work",
  unknown: "Unfamiliar licence",
};

/** One piece of sound the library offered. Handed straight back to the
 * app to fetch it, so nothing here may be reshaped on the way. */
export interface LibraryItem {
  id: string;
  name: string;
  author: string;
  seconds: number;
  licence: SoundLicence;
  licenceUrl: string;
  previewUrl: string;
  pageUrl: string;
}

export interface LibraryResults {
  items: LibraryItem[];
  total: number;
  /** How many were left out for being non-commercial. */
  hidden: number;
}

/* ---------------------------------------------------------------- notes */

/** A note to whoever is editing, pinned to a moment on the timeline.
 *
 * Nothing about the film: it is never drawn into the picture and never
 * reaches the renderer. It is a pin in the margin — "redo this take",
 * "cut the cough here", "check the name spelling" — kept with the project
 * so it is still there tomorrow, and so it travels with the project to
 * whoever opens it next.
 */
export interface ProjectNote {
  id: string;
  /** Where on the timeline it is pinned. */
  atSeconds: number;
  text: string;
}

export function newNote(atSeconds: number, text = ""): ProjectNote {
  return { id: newId("note"), atSeconds: toMillis(Math.max(0, atSeconds)), text };
}

/** Notes in the order they sit on the timeline. */
export function notesInOrder(notes: ProjectNote[]): ProjectNote[] {
  return [...notes].sort((a, b) => a.atSeconds - b.atSeconds);
}

/* ----------------------------------------------------- following clicks */

/** One reading of the mouse, as the recorder wrote it down. */
export interface CursorSample {
  /** Seconds into the recording. */
  at: number;
  /** Screen pixels. */
  x: number;
  y: number;
  down: boolean;
}

/** The trail left beside a recording. `origin` and `size` are the patch of
 * screen that was captured, so a reading can be turned into a fraction of
 * the picture whatever was recorded. */
export interface CursorTrack {
  version: number;
  origin: [number, number];
  size: [number, number];
  samples: CursorSample[];
}

/** How close a zoom goes in on what was clicked. */
export const CLICK_ZOOM = 1.8;
/** How long before the click the picture starts moving in, and how long
 * after it starts coming back out. Both are eased by the editor's own
 * ramp between points, so these are the whole gesture. */
const ZOOM_IN_SECONDS = 0.45;
const ZOOM_HOLD_SECONDS = 1.4;
const ZOOM_OUT_SECONDS = 0.6;
/** Clicks closer together than this belong to one zoom: a double click,
 * or a click and the click on what it opened. */
const SAME_VISIT_SECONDS = 2.2;

/** Where a point of the picture has to be put for the frame to be centred
 * on it at a given scale.
 *
 * A layout's x and y are fractions of the stage from its centre, and the
 * picture fills the stage at scale 1 — so a point `p` of the picture
 * (0 to 1 across) sits at `(p − 0.5) · scale` from the centre, and
 * bringing it *to* the centre means offsetting by the negative of that.
 * Held inside the frame afterwards: a zoom that shows the backdrop at the
 * edges is a zoom that has slipped off the picture. */
export function framingOn(
  point: { x: number; y: number },
  scale: number,
): ClipLayout {
  const reach = Math.max(0, scale / 2 - 0.5);
  const put = (at: number) =>
    Math.max(-reach, Math.min(reach, (0.5 - at) * scale));
  return { scale, x: put(point.x), y: put(point.y) };
}

/** The moments a click happened, in recording seconds.
 *
 * The button being held down is one click, however many readings it
 * spans: what matters is where the pointer was when it went down. */
export function clicksIn(track: CursorTrack): { at: number; x: number; y: number }[] {
  const clicks: { at: number; x: number; y: number }[] = [];
  let wasDown = false;
  for (const sample of track.samples) {
    if (sample.down && !wasDown) {
      clicks.push({ at: sample.at, x: sample.x, y: sample.y });
    }
    wasDown = sample.down;
  }
  return clicks;
}

/** Turns a recording's clicks into zoom points for one clip.
 *
 * The clip carries its own trim and speed, so a click three minutes into
 * the recording may be ten seconds into the clip, or nowhere in it at
 * all. Clicks that land outside what the clip actually plays are left
 * out — they are not in the film.
 *
 * Clicks close together share one zoom that travels between them, rather
 * than the picture darting out and back in; that is the difference
 * between a zoom that follows the work and one that is seasick.
 */
export function zoomPointsFromClicks(
  clip: TimelineClip,
  track: CursorTrack,
  scale: number = CLICK_ZOOM,
): LayoutPoint[] {
  const [width, height] = track.size;
  if (width <= 0 || height <= 0) return [];
  const speed = speedOf(clip);
  const trim = clip.trimStartSeconds ?? 0;

  /** Recording time to the clip's own time. */
  const intoClip = (at: number) => (at - trim) / speed;

  const inside = clicksIn(track)
    .map((click) => ({
      at: intoClip(click.at),
      point: {
        x: Math.max(0, Math.min(1, (click.x - track.origin[0]) / width)),
        y: Math.max(0, Math.min(1, (click.y - track.origin[1]) / height)),
      },
    }))
    .filter((click) => click.at >= 0 && click.at <= clip.durationSeconds);
  if (inside.length === 0) return [];

  // Clicks that belong together, kept as one visit with several stops.
  const visits: { stops: typeof inside }[] = [];
  for (const click of inside) {
    const last = visits[visits.length - 1];
    const previous = last?.stops[last.stops.length - 1];
    if (previous && click.at - previous.at <= SAME_VISIT_SECONDS) {
      last.stops.push(click);
    } else {
      visits.push({ stops: [click] });
    }
  }

  const resting: ClipLayout = clip.layout ?? FULL_FRAME_LAYOUT;
  const points: LayoutPoint[] = [];
  const add = (at: number, layout: ClipLayout) => {
    const when = toMillis(Math.max(0, Math.min(clip.durationSeconds, at)));
    // Two points at the same moment would ask the picture to be in two
    // places at once; the later one is the one that was meant.
    const already = points.findIndex((p) => Math.abs(p.at - when) < 0.001);
    if (already >= 0) points[already] = { at: when, layout };
    else points.push({ at: when, layout });
  };

  for (const visit of visits) {
    const first = visit.stops[0];
    const last = visit.stops[visit.stops.length - 1];
    add(first.at - ZOOM_IN_SECONDS, resting);
    for (const stop of visit.stops) {
      add(stop.at, framingOn(stop.point, scale));
    }
    add(last.at + ZOOM_HOLD_SECONDS, framingOn(last.point, scale));
    add(last.at + ZOOM_HOLD_SECONDS + ZOOM_OUT_SECONDS, resting);
  }

  // A clip that begins zoomed, because the first click is right at its
  // start, needs somewhere to have come from.
  points.sort((a, b) => a.at - b.at);
  if (points.length > 0 && points[0].at > 0.001) {
    points.unshift({ at: 0, layout: resting });
  }
  // And somewhere to end at, so the last zoom does not hold to the end of
  // the clip when it was meant to let go.
  const lastPoint = points[points.length - 1];
  if (lastPoint && lastPoint.at < clip.durationSeconds - 0.001) {
    points.push({ at: toMillis(clip.durationSeconds), layout: resting });
  }
  return points;
}
