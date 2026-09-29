/** Finding the quiet.
 *
 * The first thing an agent has to be able to do with a recording is hear
 * where nothing is happening. Almost every automatic edit worth making to
 * a tutorial starts there: the long pause while a page loads, the two
 * seconds of dead air before someone remembers what they meant to say.
 *
 * Nothing here calls ffmpeg, and nothing here goes near a network. The
 * loudness envelope has already been read off every file for the waveform
 * the timeline draws — thirty readings a second, cached — and that is
 * enough to find a pause to a thirtieth of a second. This module is a
 * pure function over that envelope, so it can be tested without a browser
 * and without a media file.
 */

import {
  isTextClip,
  speedOf,
  toMillis,
  type AudioPeaks,
  type TimelineClip,
  type TimelineTrack,
} from "./types";

/** A stretch of quiet. `start` and `end` are seconds. */
export interface Silence {
  start: number;
  end: number;
}

export interface SilenceOptions {
  /** Anything quieter than this counts as silence, in dBFS, where 0 is
   * full scale. Room tone in an ordinary room sits somewhere around -50;
   * a microphone left running in a quiet flat is nearer -60. The default
   * is deliberately cautious: it catches true dead air and leaves
   * breathing, keyboard noise and room tone alone. */
  quieterThanDb?: number;
  /** How long a stretch has to be before it counts — measured on what
   * would actually be cut, after `keepSeconds` has come off both ends.
   *
   * Speech is full of gaps a tenth of a second long, and cutting those
   * out is how an edit comes to sound like a ransom note. Measuring the
   * padded span rather than the raw one is what stops a gap that is only
   * a little longer than its own padding being reported as a silence
   * twenty-seven milliseconds long: true, useless, and not what anyone
   * asking for silences of at least half a second meant. */
  atLeastSeconds?: number;
  /** Left untouched at each end of a silence, so a cut made from this
   * never clips the edge of the word either side of it. Comes off both
   * ends, so a silence shorter than twice this is not reported at all. */
  keepSeconds?: number;
}

const DEFAULTS: Required<SilenceOptions> = {
  quieterThanDb: -40,
  atLeastSeconds: 0.6,
  keepSeconds: 0.12,
};

/** The envelope stores a peak as 0-255, linear, where 255 is full scale.
 *
 * Linear, so the bottom of the range is coarse: 1 is about -48dB, 2 is
 * -42dB, 3 is -38.6dB. There is no point offering a threshold finer than
 * that, and a threshold below about -50dB can only ever mean "digital
 * silence", because the envelope cannot represent anything between. */
export function levelForDb(db: number): number {
  if (db <= -Infinity) return 0;
  return 255 * Math.pow(10, db / 20);
}

/** Stretches of a file quiet enough to be worth cutting.
 *
 * Times are the file's own seconds, measured from the start of its audio
 * — the same clock `trimStartSeconds` is measured on.
 */
export function silencesIn(
  peaks: AudioPeaks,
  options: SilenceOptions = {},
): Silence[] {
  const { quieterThanDb, atLeastSeconds, keepSeconds } = {
    ...DEFAULTS,
    ...options,
  };
  const rate = peaks.peaks_per_second;
  if (!rate || rate <= 0 || peaks.peaks.length === 0) return [];

  const level = levelForDb(quieterThanDb);
  const found: Silence[] = [];

  // A run of quiet readings, closed off by the first loud one — or by the
  // end of the file, which is a perfectly good way for a silence to end.
  let runFrom: number | null = null;
  for (let i = 0; i <= peaks.peaks.length; i += 1) {
    const quiet = i < peaks.peaks.length && peaks.peaks[i] <= level;
    if (quiet) {
      if (runFrom === null) runFrom = i;
      continue;
    }
    if (runFrom === null) continue;

    // The reading at `runFrom` covers the bucket beginning at that index,
    // and the run ends where the loud reading begins.
    const from = runFrom / rate;
    const to = i / rate;
    runFrom = null;

    const start = from + keepSeconds;
    const end = to - keepSeconds;
    // The two paddings can together be longer than the silence between
    // them, and what is left after them has to be worth cutting.
    if (end - start < atLeastSeconds) continue;

    found.push({ start: toMillis(start), end: toMillis(end) });
  }

  return found;
}

/** How much of a file a clip actually plays. */
function heardSpan(clip: TimelineClip): { from: number; to: number } {
  const from = clip.trimStartSeconds ?? 0;
  return { from, to: from + clip.durationSeconds * speedOf(clip) };
}

/** The same silences, expressed as moments on the timeline.
 *
 * A clip shows one stretch of its file at one speed, so a silence is
 * useful to an edit only once it has been moved onto the clock the
 * timeline keeps. Silences wholly outside what the clip plays are
 * dropped; one that straddles an edge is cut back to it.
 */
export function ontoTimeline(
  silences: Silence[],
  clip: TimelineClip,
): Silence[] {
  const speed = speedOf(clip);
  const { from, to } = heardSpan(clip);
  const ends = clip.startSeconds + clip.durationSeconds;

  const out: Silence[] = [];
  for (const quiet of silences) {
    // Overlap with what this clip plays, in the file's own seconds.
    const a = Math.max(quiet.start, from);
    const b = Math.min(quiet.end, to);
    if (b <= a) continue;

    const at = (fileSeconds: number) =>
      clip.startSeconds + (fileSeconds - from) / speed;
    const start = Math.max(at(a), clip.startSeconds);
    const end = Math.min(at(b), ends);
    if (end <= start) continue;
    out.push({ start: toMillis(start), end: toMillis(end) });
  }
  return out;
}

/** Everything quiet in one clip, on the timeline's clock.
 *
 * The usual way in: hand it a clip and the envelope of the file behind
 * it, and get back the stretches of timeline an edit could take out.
 */
export function silencesInClip(
  clip: TimelineClip,
  peaks: AudioPeaks,
  options: SilenceOptions = {},
): Silence[] {
  return ontoTimeline(silencesIn(peaks, options), clip);
}

/** How much time a set of silences accounts for. */
export function totalSeconds(silences: Silence[]): number {
  return toMillis(
    silences.reduce((sum, quiet) => sum + (quiet.end - quiet.start), 0),
  );
}

/* ------------------------------------------------- the whole timeline */

/** Whether a clip has sound worth listening to.
 *
 * A title has none, a muted clip has been told to stay out of it, and a
 * clip whose sound was split onto a track of its own is silent by
 * arrangement — the audio clip beside it is what speaks now.
 */
function sounds(clip: TimelineClip): boolean {
  return !isTextClip(clip) && !clip.muted && clip.mediaPath !== "";
}

/** Stretches of the timeline where nothing is being said on any track.
 *
 * Not simply the silences of one clip: a moment is only worth cutting if
 * **every** clip sounding at that moment is quiet through it. A voice
 * over music is not a pause just because the voice stopped, and cutting
 * there would take a bite out of the music.
 *
 * Stretches no clip covers at all are left alone. A gap in the timeline
 * may be deliberate — a beat of black — and closing it is a different
 * decision from taking out a pause in speech.
 *
 * The answer is in timeline seconds, ready to hand to `removeRange`.
 */
export function quietRanges(
  tracks: TimelineTrack[],
  peaksByPath: Map<string, AudioPeaks>,
  options: SilenceOptions = {},
): Silence[] {
  const { atLeastSeconds } = { ...DEFAULTS, ...options };

  /** One sounding clip: where it plays, and where it is quiet. */
  const heard: { from: number; to: number; quiet: Silence[] }[] = [];
  for (const track of tracks) {
    for (const clip of track.clips) {
      if (!sounds(clip)) continue;
      const peaks = peaksByPath.get(clip.mediaPath);
      // A clip whose envelope has not been read yet, or which has no
      // audio track at all, says nothing about whether this moment is
      // quiet. Treating it as silent would cut away pictures on the
      // strength of a file nobody has listened to.
      if (!peaks || peaks.peaks.length === 0) continue;
      heard.push({
        from: clip.startSeconds,
        to: clip.startSeconds + clip.durationSeconds,
        quiet: silencesInClip(clip, peaks, options),
      });
    }
  }
  if (heard.length === 0) return [];

  // Every moment where anything starts or stops mattering. Between two
  // neighbouring boundaries nothing changes, so one look in the middle
  // settles the whole stretch.
  const edges = new Set<number>();
  for (const clip of heard) {
    edges.add(clip.from);
    edges.add(clip.to);
    for (const quiet of clip.quiet) {
      edges.add(quiet.start);
      edges.add(quiet.end);
    }
  }
  const marks = [...edges].sort((a, b) => a - b);

  const covers = (a: number, b: number, at: number) => at >= a && at <= b;

  const found: Silence[] = [];
  for (let i = 0; i + 1 < marks.length; i += 1) {
    const from = marks[i];
    const to = marks[i + 1];
    if (to <= from) continue;
    const middle = (from + to) / 2;

    const sounding = heard.filter((clip) => covers(clip.from, clip.to, middle));
    if (sounding.length === 0) continue;
    const allQuiet = sounding.every((clip) =>
      clip.quiet.some((q) => covers(q.start, q.end, middle)),
    );
    if (!allQuiet) continue;

    // Joined to the one before it when they touch, so a pause spanning
    // two clips comes back as one stretch rather than two.
    const last = found[found.length - 1];
    if (last && Math.abs(last.end - from) < 1e-6) {
      last.end = to;
    } else {
      found.push({ start: from, end: to });
    }
  }

  return found
    .filter((quiet) => quiet.end - quiet.start >= atLeastSeconds)
    .map((quiet) => ({ start: toMillis(quiet.start), end: toMillis(quiet.end) }));
}
