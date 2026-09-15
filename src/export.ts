import { api } from "./api";
import { drawBackdrop, frameGeometry, hasBackdrop } from "./frame";
import { drawTextLayer } from "./textLayer";
import {
  FULL_FRAME_LAYOUT,
  gainAt,
  holdForTransition,
  isTextClip,
  layerFramingAt,
  layoutAt,
  mediaKindFor,
  mediaSpan,
  shapeRatio,
  speedOf,
  trackKindOf,
  transitionFades,
  transitionMoves,
  transitionSeconds,
  type Transition,
  type ExportPlan,
  type ExportPlanClip,
  type EditorSettings,
  type ExportQuality,
  type ExportSettings,
  type FrameShape,
  type MediaItem,
  type TimelineClip,
  type TimelineTrack,
  type VolumePoint,
} from "./types";

/** How finely a volume line is sampled on the way out.
 *
 * The line is drawn with eased ramps between its points; the renderer joins
 * the points it is given with straight ones. Cutting each ramp into this
 * many pieces makes the difference between the two smaller than a
 * hundredth of a decibel, which is far below anything audible, without
 * turning the filter into an expression thousands of terms long. */
const VOLUME_SEGMENTS = 12;

/** How often a zoom is sampled on the way out, in samples a second.
 *
 * The renderer joins what it is given with straight lines, and a zoom is
 * something the eye follows closely — a coarse sample would show as the
 * picture changing speed in steps. Twelve a second is smooth and still
 * only a few hundred numbers for a long clip. */
const ZOOM_SAMPLES_PER_SECOND = 12;

/** Fills in readings at a regular rate between two moments. */
function spread(from: number, to: number, into: Set<number>) {
  if (to <= from) return;
  const steps = Math.max(2, Math.ceil((to - from) * ZOOM_SAMPLES_PER_SECOND));
  for (let step = 0; step <= steps; step += 1) {
    into.add(from + ((to - from) * step) / steps);
  }
}

/** The clip's framing as straight segments the renderer can follow. Empty
 * when it never moves, which is the common case and the cheap one.
 *
 * Only the stretches that actually move are sampled closely. A zoom moves
 * throughout, so it is read all the way along; a transition moves for
 * half a second at one end, and reading a five-minute clip closely for the
 * sake of it would build an expression thousands of terms long describing
 * a picture that is standing still.
 */
function sampleFraming(clip: TimelineClip, hold: number) {
  const zooms = (clip.layoutPoints?.length ?? 0) >= 2;
  const arriving = clip.transitionIn && transitionMoves(clip.transitionIn.kind)
    ? transitionSeconds(clip.transitionIn, clip.durationSeconds)
    : 0;
  const leaving = clip.transitionOut && transitionMoves(clip.transitionOut.kind)
    ? transitionSeconds(clip.transitionOut, clip.durationSeconds)
    : 0;
  if (!zooms && arriving === 0 && leaving === 0) return [];

  const moments = new Set<number>([0, clip.durationSeconds]);
  if (hold > 0) moments.add(clip.durationSeconds + hold);
  if (zooms) spread(0, clip.durationSeconds, moments);
  if (arriving > 0) spread(0, arriving, moments);
  if (leaving > 0) spread(clip.durationSeconds - leaving, clip.durationSeconds, moments);

  return [...moments]
    .sort((a, b) => a - b)
    .map((at) => {
      const framing = layerFramingAt(clip, at).layout;
      return { at, scale: framing.scale, x: framing.x, y: framing.y };
    });
}

/** How long a fade this transition asks for. Zero for one that only moves
 * the picture about, which the renderer handles by other means. */
function fadeSeconds(
  transition: Transition | undefined,
  clipSeconds: number,
): number {
  if (!transition || !transitionFades(transition.kind)) return 0;
  return transitionSeconds(transition, clipSeconds);
}

/** What each preset means, measured across the frame's shorter side.
 *
 * Its shorter side rather than its height, so that one preset means one
 * amount of detail whichever way round the frame is: 1080p is 1920x1080
 * lying down and 1080x1920 standing up, which is what everyone who has
 * ever uploaded a vertical video expects it to be. */
const RESOLUTION_SHORT_SIDES: Record<string, number> = {
  "480p": 480,
  "720p": 720,
  "1080p": 1080,
};

/** Encoder settings per quality. H.264 and VP9 number their scales
 * differently — the same figure means a different picture in each — so
 * each codec gets its own. */
const H264_CRF: Record<ExportQuality, number> = { small: 28, balanced: 23, best: 18 };
const VP9_CRF: Record<ExportQuality, number> = { small: 36, balanced: 32, best: 28 };
const AUDIO_KBPS: Record<ExportQuality, number> = { small: 128, balanced: 192, best: 256 };

function even(value: number): number {
  const rounded = Math.round(value);
  return rounded % 2 === 0 ? rounded : rounded + 1;
}

/** The volume line as a list of straight segments the renderer can follow.
 * Empty for a clip that was never touched, which means full volume. */
function sampleVolume(points: VolumePoint[] | undefined): VolumePoint[] {
  if (!points || points.length === 0) return [];
  // A single point is one level for the whole clip; there is nothing to
  // subdivide.
  if (points.length === 1) return [{ at: 0, gain: points[0].gain }];

  const sampled: VolumePoint[] = [];
  for (let i = 1; i < points.length; i += 1) {
    const from = points[i - 1].at;
    const to = points[i].at;
    for (let step = 0; step < VOLUME_SEGMENTS; step += 1) {
      const at = from + ((to - from) * step) / VOLUME_SEGMENTS;
      sampled.push({ at, gain: gainAt(points, at) });
    }
  }
  const last = points[points.length - 1];
  sampled.push({ at: last.at, gain: last.gain });
  return sampled;
}

/** The canvas the timeline is rendered onto: the shape the preview was cut
 * against, at the size the export was asked for. */
export function exportCanvas(
  media: MediaItem[],
  resolution: ExportSettings["resolution"],
  shape: FrameShape = "16:9",
): { width: number; height: number } {
  let short = RESOLUTION_SHORT_SIDES[resolution];
  if (short === undefined) {
    // "Source": the most detailed video in the project, so nothing is
    // thrown away, falling back to 720 when none of them said how big
    // they are. Measured across its shorter side, like the presets.
    const finest = media
      .filter(
        (item) =>
          item.kind === "video" &&
          typeof item.height === "number" &&
          typeof item.width === "number",
      )
      .reduce(
        (most, item) => Math.max(most, Math.min(item.width ?? 0, item.height ?? 0)),
        0,
      );
    short = finest > 0 ? finest : 720;
  }
  const ratio = shapeRatio(shape);
  return ratio >= 1
    ? { width: even(short * ratio), height: even(short) }
    : { width: even(short), height: even(short / ratio) };
}

export function timelineDuration(tracks: TimelineTrack[]): number {
  let end = 0;
  for (const track of tracks) {
    for (const clip of track.clips) {
      end = Math.max(end, clip.startSeconds + clip.durationSeconds);
    }
  }
  return end;
}

/** Flattens the project into placements, bottom of the stack first.
 *
 * Tracks are walked in order so that a clip on a lower track in the list is
 * laid over the ones above it, the same way the preview stacks them. */
/** Draws every title in the project at the size it will be rendered, and
 * puts each one on disk.
 *
 * The same function that paints the preview paints these, at the export's
 * own size — so a title in the finished file is the drawing that was on
 * screen, not an approximation of it reconstructed by the renderer from a
 * font name and a colour. */
export async function renderTitles(
  tracks: TimelineTrack[],
  width: number,
  height: number,
): Promise<Map<string, string>> {
  const paths = new Map<string, string>();
  const titles = tracks
    .flatMap((track) => track.clips)
    .filter((clip) => isTextClip(clip));
  if (titles.length === 0) return paths;

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This machine could not draw the titles.");

  for (const clip of titles) {
    if (!clip.text) continue;
    drawTextLayer(ctx, clip.text, layoutAt(clip, 0), width, height);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/png"),
    );
    if (!blob) throw new Error("A title could not be turned into a picture.");
    const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()));
    paths.set(clip.id, await api.writeOverlayImage(clip.id, bytes));
  }
  return paths;
}

/** Paints the backdrop at the export's own size and puts it on disk.
 *
 * Null when the project has no backdrop, which leaves the frame black
 * behind the footage — the same as the preview shows. */
export async function renderBackdrop(
  settings: EditorSettings,
  width: number,
  height: number,
): Promise<string | null> {
  if (!hasBackdrop(settings.backdropKind)) return null;

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This machine could not draw the backdrop.");
  drawBackdrop(ctx, settings, width, height);

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/png"),
  );
  if (!blob) throw new Error("The backdrop could not be turned into a picture.");
  const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()));
  return api.writeOverlayImage("backdrop", bytes);
}

export function buildExportPlan(
  tracks: TimelineTrack[],
  media: MediaItem[],
  settings: ExportSettings,
  /** The backdrop, padding and corners the edit was made against. */
  look: EditorSettings,
  outputPath: string,
  /** Where each title's picture was put, from `renderTitles`. */
  titles: Map<string, string> = new Map(),
  /** Where the backdrop was put, from `renderBackdrop`. */
  backdrop: string | null = null,
): { plan: ExportPlan } | { error: string } {
  const duration = timelineDuration(tracks);
  if (duration <= 0) {
    return { error: "There is nothing on the timeline to export." };
  }

  const { width, height } = exportCanvas(media, settings.resolution, look.aspect);
  const geometry = frameGeometry(width, height, look);

  const byPath = new Map(media.map((item) => [item.path, item]));
  const clips: ExportPlanClip[] = [];
  let missing = 0;

  for (const track of tracks) {
    const audioTrack = trackKindOf(track) === "audio";
    const onTrack = track.clips as TimelineClip[];
    for (const clip of onTrack) {
      // If the clip that follows arrives with a transition, this one has
      // to keep playing underneath while it does — otherwise the next clip
      // fades up out of the backdrop rather than out of this one.
      const follows = onTrack.find(
        (other) =>
          other.id !== clip.id &&
          Math.abs(
            other.startSeconds - (clip.startSeconds + clip.durationSeconds),
          ) < 0.002,
      );
      const wanted = holdForTransition(follows);
      // A title is a picture the editor drew, laid over the frame whole.
      if (isTextClip(clip)) {
        const drawn = titles.get(clip.id);
        if (!drawn) continue;
        clips.push({
          path: drawn,
          start: clip.startSeconds,
          duration: clip.durationSeconds,
          trimStart: 0,
          visual: true,
          audible: false,
          still: true,
          scale: 1,
          x: 0,
          y: 0,
          // Drawn at the stage's own size and laid over it whole. Its
          // corners are square: the rounding belongs to the footage, and
          // a title is words on a transparent sheet.
          rounded: false,
          fadeIn: fadeSeconds(clip.transitionIn, clip.durationSeconds),
          fadeOut: fadeSeconds(clip.transitionOut, clip.durationSeconds),
          // A title is a still, so there is always another frame of it.
          hold: wanted,
          freeze: 0,
          // A drawing has no material to play through, so it has no speed
          // to play it at.
          speed: 1,
          volume: [],
          zoom: sampleFraming(clip, wanted),
        });
        continue;
      }

      const item = byPath.get(clip.mediaPath);
      const kind = item?.kind ?? mediaKindFor(clip.mediaPath);
      if (!item) missing += 1;

      const soundOnly = Boolean(clip.soundOnly) || kind === "audio";
      const zoom = sampleFraming(clip, wanted);
      // The framing it rests at; a clip that moves carries its journey in
      // `zoom` and this is only where it begins.
      const layout = zoom.length
        ? layerFramingAt(clip, 0).layout
        : (clip.layout ?? FULL_FRAME_LAYOUT);

      // A still has frames for as long as it is asked for; footage only
      // has what is left in the file past its out point, and the rest of
      // the hold is its last frame held. Measured in timeline seconds,
      // which at anything but normal speed is not the same as the amount
      // of material it takes.
      const still = kind === "image";
      const speed = still ? 1 : speedOf(clip);
      const left =
        !still && typeof item?.durationSeconds === "number"
          ? Math.max(
              0,
              item.durationSeconds -
                ((clip.trimStartSeconds ?? 0) + mediaSpan(clip, clip.durationSeconds)),
            ) / speed
          : wanted;
      const hold = Math.min(wanted, left);
      const audible =
        !clip.muted &&
        (soundOnly || audioTrack || (kind === "video" && !clip.audioDetached));

      clips.push({
        path: clip.mediaPath,
        start: clip.startSeconds,
        duration: clip.durationSeconds,
        trimStart: clip.trimStartSeconds ?? 0,
        // `soundOnly` already covers an audio file; what is left is a
        // video or a still, and both have a picture.
        visual: !soundOnly,
        audible,
        still,
        rounded: true,
        fadeIn: fadeSeconds(clip.transitionIn, clip.durationSeconds),
        fadeOut: fadeSeconds(clip.transitionOut, clip.durationSeconds),
        hold,
        freeze: wanted - hold,
        speed,
        scale: layout.scale,
        x: layout.x,
        y: layout.y,
        volume: sampleVolume(clip.volume),
        zoom,
      });
    }
  }

  if (missing > 0) {
    return {
      error:
        missing === 1
          ? "One clip points at a file that isn't in this project any more."
          : `${missing} clips point at files that aren't in this project any more.`,
    };
  }

  return {
    plan: {
      outputPath,
      format: settings.format,
      width,
      height,
      stage: geometry.stage,
      radius: geometry.radius,
      backdrop,
      fps: settings.fps,
      duration,
      videoQuality:
        settings.format === "webm"
          ? VP9_CRF[settings.quality]
          : H264_CRF[settings.quality],
      audioBitrateKbps: AUDIO_KBPS[settings.quality],
      clips,
    },
  };
}

/** A rough idea of the file this will produce, so the choices mean
 * something before the render starts. Deliberately called an estimate: the
 * real size depends on how much the footage moves. */
export function estimateSize(settings: ExportSettings, seconds: number): string {
  if (seconds <= 0) return "—";
  const megabitsPerSecond =
    settings.format === "mp3"
      ? AUDIO_KBPS[settings.quality] / 1000
      : ({ small: 1.8, balanced: 4.5, best: 9 }[settings.quality] *
          (RESOLUTION_SHORT_SIDES[settings.resolution] ?? 1080)) /
          1080 +
        AUDIO_KBPS[settings.quality] / 1000;
  const megabytes = (megabitsPerSecond * seconds) / 8;
  if (megabytes < 1) return "under 1 MB";
  if (megabytes < 1024) return `about ${Math.round(megabytes)} MB`;
  return `about ${(megabytes / 1024).toFixed(1)} GB`;
}
