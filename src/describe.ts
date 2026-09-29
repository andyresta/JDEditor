/** The film, written down.
 *
 * A model cannot watch a video. What it can read is this: what is on the
 * timeline, what was said and when, and where the quiet is. Everything
 * the agent knows about a project comes through here, so the shape of
 * this text matters more than which model reads it — a briefing that
 * leaves out a clip's id is a briefing the model cannot act on, and one
 * that lists every word on its own line costs ten times what it needs to.
 *
 * Three rules it is built on:
 *
 * **Ids are exact and quotable.** Every clip, track and note is named the
 * way an operation will have to name it. The model's whole job is to
 * answer with ids, and it can only use what it was shown.
 *
 * **Times are timeline seconds, two decimals, everywhere.** One clock,
 * one format. A briefing that mixed file time and timeline time would
 * produce edits that cut in the wrong place and look right on paper.
 *
 * **The same document always writes the same text.** No dates, no
 * ordering by anything that can change underneath it. That is what makes
 * it testable, and what lets a reply be cached.
 */

import type { EditDoc } from "./ops";
import type { Silence } from "./silence";
import { isTextClip, speedOf, type TimelineClip } from "./types";

export interface BriefingOptions {
  /** Only describe this stretch of the timeline. An hour of transcript is
   * a great deal to send when the question is about the first minute. */
  from?: number;
  to?: number;
  /** Where the quiet is, if it has been worked out. Computed by the
   * caller, which is the only place the audio envelopes live. */
  silences?: Silence[];
  /** How long a transcript line may get before it is broken. Reading
   * length, not caption length — this is prose for a model, not words on
   * a screen. */
  lineLength?: number;
}

const DEFAULTS = { lineLength: 72 };

/** Seconds, written one way throughout. */
function at(seconds: number): string {
  return seconds.toFixed(2);
}

function span(from: number, to: number): string {
  return `${at(from)}-${at(to)}`;
}

/** What a clip is, in one word an operation can be chosen from. */
function kindOf(clip: TimelineClip): "title" | "sound" | "video" {
  if (isTextClip(clip)) return "title";
  if (clip.soundOnly) return "sound";
  return "video";
}

/** The file a clip plays, without the folders above it. */
function fileOf(clip: TimelineClip): string {
  if (isTextClip(clip)) {
    const words = clip.text?.content?.split("\n")[0]?.trim();
    return words ? `"${words}"` : '"(no words)"';
  }
  const parts = clip.mediaPath.split(/[\\/]/);
  return parts[parts.length - 1] || "(no file)";
}

/** What is worth saying about a clip beyond where it sits. */
function notesOn(clip: TimelineClip): string {
  const said: string[] = [];
  const speed = speedOf(clip);
  if (Math.abs(speed - 1) > 1e-6) said.push(`${speed}x`);
  if (clip.muted) said.push("muted");
  if (clip.transitionIn) said.push(`in:${clip.transitionIn.kind}`);
  if (clip.transitionOut) said.push(`out:${clip.transitionOut.kind}`);
  if (clip.volume && clip.volume.length > 1) {
    said.push(`${clip.volume.length} volume points`);
  }
  return said.length > 0 ? ` [${said.join(", ")}]` : "";
}

/** Whether a stretch of timeline falls inside the window asked about. */
function within(from: number, to: number, window: { from: number; to: number }) {
  return to > window.from && from < window.to;
}

/** The transcript, broken into lines that read like speech.
 *
 * Broken where the speaker broke: a gap of half a second ends a line,
 * and so does running past the reading length. Each line carries the
 * span it covers, because that span is what an edit will be made from.
 */
function transcript(
  words: EditDoc["words"],
  window: { from: number; to: number },
  lineLength: number,
): string[] {
  const lines: string[] = [];
  let held: typeof words = [];

  const flush = () => {
    if (held.length === 0) return;
    const text = held.map((word) => word.word).join(" ");
    lines.push(`  ${span(held[0].start, held[held.length - 1].end)}  ${text}`);
    held = [];
  };

  for (const word of words) {
    if (!within(word.start, word.end, window)) continue;
    const last = held[held.length - 1];
    const rested = last != null && word.start - last.end >= 0.5;
    const full =
      held.reduce((n, w) => n + w.word.length + 1, 0) + word.word.length > lineLength;
    // A different clip is a different piece of film, and lumping two of
    // them into one line would hide where one ends.
    const moved = last != null && held[0].clipId !== word.clipId;
    if (rested || full || moved) flush();
    held.push(word);
  }
  flush();
  return lines;
}

/** Everything the agent is told about the project. */
export function describe(doc: EditDoc, options: BriefingOptions = {}): string {
  const { lineLength } = { ...DEFAULTS, ...options };

  const ends = doc.tracks
    .flatMap((track) => track.clips)
    .reduce((longest, clip) => Math.max(longest, clip.startSeconds + clip.durationSeconds), 0);
  const window = {
    from: options.from ?? 0,
    to: options.to ?? Math.max(ends, options.from ?? 0),
  };
  const whole = window.from <= 0 && window.to >= ends;

  const out: string[] = [];

  out.push("FILM");
  out.push(
    `  ${at(ends)}s long, ${doc.tracks.length} track${doc.tracks.length === 1 ? "" : "s"}` +
      (whole ? "" : `  (describing ${span(window.from, window.to)} only)`),
  );
  out.push("");

  out.push("TRACKS AND CLIPS");
  if (doc.tracks.length === 0) {
    out.push("  (nothing on the timeline)");
  }
  for (const track of doc.tracks) {
    out.push(`  ${track.id}  "${track.name}"`);
    const shown = track.clips.filter((clip) =>
      within(clip.startSeconds, clip.startSeconds + clip.durationSeconds, window),
    );
    if (shown.length === 0) {
      out.push("    (empty)");
      continue;
    }
    for (const clip of shown) {
      const to = clip.startSeconds + clip.durationSeconds;
      out.push(
        `    ${clip.id}  ${kindOf(clip).padEnd(5)}  ${span(clip.startSeconds, to)}` +
          `  (${at(clip.durationSeconds)}s)  ${fileOf(clip)}${notesOn(clip)}`,
      );
    }
  }
  out.push("");

  const lines = transcript(doc.words, window, lineLength);
  out.push("TRANSCRIPT");
  out.push(
    lines.length > 0
      ? lines.join("\n")
      : doc.words.length === 0
        ? "  (nothing has been transcribed)"
        : "  (nothing was said in this stretch)",
  );
  out.push("");

  const quiet = (options.silences ?? []).filter((s) => within(s.start, s.end, window));
  out.push("PAUSES");
  out.push(
    options.silences == null
      ? "  (not looked for)"
      : quiet.length === 0
        ? "  (none)"
        : quiet
            .map((s) => `  ${span(s.start, s.end)}  (${at(s.end - s.start)}s)`)
            .join("\n"),
  );
  out.push("");

  const notes = doc.notes
    .filter((note) => note.atSeconds >= window.from && note.atSeconds <= window.to)
    .sort((a, b) => a.atSeconds - b.atSeconds);
  out.push("NOTES LEFT BY THE EDITOR");
  out.push(
    notes.length === 0
      ? "  (none)"
      : notes.map((note) => `  ${note.id}  ${at(note.atSeconds)}  ${note.text}`).join("\n"),
  );

  return out.join("\n");
}

/** Roughly how much a briefing will cost to send.
 *
 * Characters over four, which is the usual rule of thumb for English and
 * close enough for Indonesian. Rough on purpose: it is here to catch a
 * briefing that has run away with itself, not to bill anyone.
 */
export function roughTokens(briefing: string): number {
  return Math.ceil(briefing.length / 4);
}
