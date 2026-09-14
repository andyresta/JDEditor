import { api } from "./api";
import { drawTextLayer } from "./textLayer";
import {
  FULL_FRAME_LAYOUT,
  gainAt,
  isTextClip,
  layoutAt,
  mediaKindFor,
  trackKindOf,
  type ExportPlan,
  type ExportPlanClip,
  type ExportQuality,
  type ExportSettings,
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

/** The zoom as straight segments the renderer can follow. Empty when the
 * clip's framing never changes. */
function sampleZoom(clip: TimelineClip) {
  const points = clip.layoutPoints;
  if (!points || points.length < 2) return [];

  const steps = Math.max(2, Math.ceil(clip.durationSeconds * ZOOM_SAMPLES_PER_SECOND));
  const sampled: { at: number; scale: number; x: number; y: number }[] = [];
  for (let step = 0; step <= steps; step += 1) {
    const at = (clip.durationSeconds * step) / steps;
    const framing = layoutAt(clip, at);
    sampled.push({ at, scale: framing.scale, x: framing.x, y: framing.y });
  }
  return sampled;
}

/** The heights each preset renders at. Widths come from 16:9. */
const RESOLUTION_HEIGHTS: Record<string, number> = {
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

/** The canvas the timeline is rendered onto. Always 16:9, because that is
 * the shape of the preview the edit was made against. */
export function exportCanvas(
  media: MediaItem[],
  resolution: ExportSettings["resolution"],
): { width: number; height: number } {
  let height = RESOLUTION_HEIGHTS[resolution];
  if (height === undefined) {
    // "Source": the tallest video in the project, so nothing is thrown
    // away, falling back to 720p when none of them said how big they are.
    const tallest = media
      .filter((item) => item.kind === "video" && typeof item.height === "number")
      .reduce((most, item) => Math.max(most, item.height ?? 0), 0);
    height = tallest > 0 ? tallest : 720;
  }
  return { width: even((height * 16) / 9), height: even(height) };
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
    paths.set(clip.id, await api.writeTextImage(clip.id, bytes));
  }
  return paths;
}

export function buildExportPlan(
  tracks: TimelineTrack[],
  media: MediaItem[],
  settings: ExportSettings,
  outputPath: string,
  /** Where each title's picture was put, from `renderTitles`. */
  titles: Map<string, string> = new Map(),
): { plan: ExportPlan } | { error: string } {
  const duration = timelineDuration(tracks);
  if (duration <= 0) {
    return { error: "There is nothing on the timeline to export." };
  }

  const byPath = new Map(media.map((item) => [item.path, item]));
  const clips: ExportPlanClip[] = [];
  let missing = 0;

  for (const track of tracks) {
    const audioTrack = trackKindOf(track) === "audio";
    for (const clip of track.clips as TimelineClip[]) {
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
          volume: [],
          zoom: [],
        });
        continue;
      }

      const item = byPath.get(clip.mediaPath);
      const kind = item?.kind ?? mediaKindFor(clip.mediaPath);
      if (!item) missing += 1;

      const soundOnly = Boolean(clip.soundOnly) || kind === "audio";
      // The framing it rests at; a clip that zooms carries its journey in
      // `zoom` and this is only where it begins.
      const layout = clip.layoutPoints?.length
        ? layoutAt(clip, 0)
        : (clip.layout ?? FULL_FRAME_LAYOUT);
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
        still: kind === "image",
        scale: layout.scale,
        x: layout.x,
        y: layout.y,
        volume: sampleVolume(clip.volume),
        zoom: sampleZoom(clip),
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

  const { width, height } = exportCanvas(media, settings.resolution);
  return {
    plan: {
      outputPath,
      format: settings.format,
      width,
      height,
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
          (RESOLUTION_HEIGHTS[settings.resolution] ?? 1080)) /
          1080 +
        AUDIO_KBPS[settings.quality] / 1000;
  const megabytes = (megabitsPerSecond * seconds) / 8;
  if (megabytes < 1) return "under 1 MB";
  if (megabytes < 1024) return `about ${Math.round(megabytes)} MB`;
  return `about ${(megabytes / 1024).toFixed(1)} GB`;
}
