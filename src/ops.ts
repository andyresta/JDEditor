/** Edits as things, rather than as button presses.
 *
 * Everything the editor can do to a timeline goes through a handler in
 * `RecorderApp`, and each of those reads the tracks out of its own React
 * closure. That is exactly right for a person pressing one button at a
 * time, and useless for anything proposing ten changes at once: the
 * second handler would read the tracks as they were before the first ran,
 * and nine of the ten changes would be lost.
 *
 * So an edit is described here as a value — a small, closed set of
 * operations — and a list of them is folded over the document in one
 * pass. That is what lets an automatic edit, a script, or a model propose
 * a batch and have it land as one change with one entry in the undo
 * history.
 *
 * Two rules hold the whole thing up:
 *
 * **The rules live in `types.ts`, not here.** Cutting is `splitClipAt`,
 * moving is `settleOnTrack`, trimming is `trimClip`, speed is
 * `setClipSpeed` — the same functions the editor's own buttons call. An
 * operation is the glue that says which clip and how much. If an
 * automatic edit divided a clip by a rule of its own, the timeline would
 * behave differently depending on who asked, which is the kind of thing
 * nobody notices until a volume line comes out wrong.
 *
 * **All of it, or none of it.** A batch is checked as it is applied, each
 * step against the document as it stands at that point, and the first
 * problem abandons the whole batch and hands back the document untouched.
 * A model proposing edits *will* name a clip that does not exist — that
 * is not a risk, it is a certainty — and half-applying a batch would
 * leave a timeline nobody asked for and no clear way back.
 */

import {
  isTextClip,
  MAX_SPEED,
  MIN_SPEED,
  DEFAULT_TEXT_SECONDS,
  DEFAULT_TEXT_STYLE,
  FULL_FRAME_LAYOUT,
  newId,
  newNote,
  newTrack,
  setClipSpeed,
  settleOnTrack,
  splitClipAt,
  toMillis,
  trimClip,
  trimLimit,
  withTrackNames,
  type TextStyle,
  type ProjectNote,
  type TimedWord,
  type TimelineClip,
  type TimelineTrack,
  type Transition,
  type VolumePoint,
} from "./types";

/** What an operation works on.
 *
 * Only the tracks and what is known about the files behind them: an
 * operation has no business with which clip is selected, what the preview
 * is showing, or where the playhead is standing.
 */
export interface EditDoc {
  tracks: TimelineTrack[];
  /** Enough about each file to trim against. Trimming may not run past
   * the end of the footage, and only the file knows where that is. */
  media: { path: string; durationSeconds?: number | null }[];
  /** Remarks pinned along the timeline.
   *
   * Part of the document rather than something beside it, because an
   * edit moves them: taking a pause out slides every note after it
   * backwards, and a note left pointing at a moment that has moved is
   * worse than no note at all. */
  notes: ProjectNote[];
  /** Every word heard in the film, timed against the timeline.
   *
   * Here for the same reason the notes are, and more urgently: editing
   * by transcript means reading a time off a word and cutting there, so
   * a transcript that did not move with the film would send the second
   * edit to the wrong place, and every edit after that further wrong.
   *
   * Empty when nothing has been transcribed, which is not the same as
   * nothing having been said. */
  words: TimedWord[];
}

export type Operation =
  /** Cut every clip the moment crosses, or one named clip. */
  | { kind: "cut"; atSeconds: number; clipId?: string }
  | { kind: "removeClips"; clipIds: string[] }
  /** Move a clip to a track and a time. It settles after anything it
   * would have covered rather than shortening it. */
  | { kind: "moveClip"; clipId: string; trackId: string; startSeconds: number }
  /** Drag one edge. `seconds` is where that edge should end up on the
   * timeline; it is held back at whatever is beside it. */
  | { kind: "trim"; clipId: string; edge: "start" | "end"; seconds: number }
  | { kind: "setSpeed"; clipIds: string[]; speed: number }
  /** Replace a clip's volume line. An empty list is a flat line at full
   * volume. */
  | { kind: "setVolume"; clipId: string; points: VolumePoint[] }
  /** Words over the picture. A null track puts them on a new one, which
   * is what keeps a title from displacing footage. */
  | {
      kind: "addTitle";
      trackId: string | null;
      atSeconds: number;
      text?: Partial<TextStyle>;
      durationSeconds?: number;
    }
  | {
      kind: "setTransition";
      clipIds: string[];
      edge: "in" | "out";
      transition?: Transition;
    }
  /** Takes a stretch of timeline out and closes the gap behind it.
   *
   * Every track is cut at both ends of the range, whatever was wholly
   * inside it is dropped, and everything after it moves left by the
   * length of what went. A ripple delete, in other words — which is what
   * a person means by "take that pause out".
   *
   * It has to be one operation rather than a cut, a remove and a series
   * of moves: the cut makes clips whose ids did not exist when the batch
   * was written, so nothing could name them to move them. Every track
   * moves by the same amount, which is what keeps picture and sound
   * together. */
  | { kind: "removeRange"; fromSeconds: number; toSeconds: number }
  /** A remark pinned to a moment. Worth an agent having: "this bit is
   * still muddled" is a more honest answer than a guess at what to cut. */
  | { kind: "addNote"; atSeconds: number; text: string }
  | { kind: "editNote"; noteId: string; text: string }
  | { kind: "moveNote"; noteId: string; atSeconds: number }
  | { kind: "removeNotes"; noteIds: string[] };

/* --------------------------------------------------------- looking about */

function clipsOf(doc: EditDoc): TimelineClip[] {
  return doc.tracks.flatMap((track) => track.clips);
}

function findClip(doc: EditDoc, id: string): TimelineClip | undefined {
  return clipsOf(doc).find((clip) => clip.id === id);
}

function trackHolding(doc: EditDoc, id: string): TimelineTrack | undefined {
  return doc.tracks.find((track) => track.clips.some((clip) => clip.id === id));
}

const isTime = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

/* ------------------------------------------------------------- checking */

/** What is wrong with this operation against this document, or null.
 *
 * Deliberately a sentence rather than a code: the one reading it is
 * either a person looking at a failed batch or a model being told why its
 * proposal was refused, and both do better with words.
 */
export function problemWith(doc: EditDoc, op: Operation): string | null {
  const missing = (id: string) => `There is no clip called ${id}.`;

  switch (op.kind) {
    case "cut": {
      if (!isTime(op.atSeconds)) return "A cut needs a time on the timeline.";
      if (op.clipId != null && !findClip(doc, op.clipId)) return missing(op.clipId);
      return null;
    }
    case "removeClips": {
      if (op.clipIds.length === 0) return "Nothing was named to remove.";
      const gone = op.clipIds.find((id) => !findClip(doc, id));
      return gone ? missing(gone) : null;
    }
    case "moveClip": {
      if (!findClip(doc, op.clipId)) return missing(op.clipId);
      if (!doc.tracks.some((track) => track.id === op.trackId)) {
        return `There is no track called ${op.trackId}.`;
      }
      if (!isTime(op.startSeconds)) return "A clip has to be moved to a time.";
      return null;
    }
    case "trim": {
      if (!findClip(doc, op.clipId)) return missing(op.clipId);
      if (op.edge !== "start" && op.edge !== "end") {
        return "A clip has two edges: start and end.";
      }
      if (!isTime(op.seconds)) return "An edge has to be moved to a time.";
      return null;
    }
    case "setSpeed": {
      if (op.clipIds.length === 0) return "Nothing was named to retime.";
      const gone = op.clipIds.find((id) => !findClip(doc, id));
      if (gone) return missing(gone);
      if (!Number.isFinite(op.speed) || op.speed < MIN_SPEED || op.speed > MAX_SPEED) {
        return `Speed runs from ${MIN_SPEED}x to ${MAX_SPEED}x.`;
      }
      return null;
    }
    case "setVolume": {
      if (!findClip(doc, op.clipId)) return missing(op.clipId);
      if (!Array.isArray(op.points)) return "A volume line is a list of points.";
      for (const point of op.points) {
        if (!isTime(point.at) || !Number.isFinite(point.gain) || point.gain < 0) {
          return "Every point on a volume line needs a time and a gain of zero or more.";
        }
      }
      return null;
    }
    case "addTitle": {
      if (!isTime(op.atSeconds)) return "A title needs a time on the timeline.";
      if (op.trackId != null && !doc.tracks.some((track) => track.id === op.trackId)) {
        return `There is no track called ${op.trackId}.`;
      }
      if (op.durationSeconds != null && !(op.durationSeconds > 0)) {
        return "A title has to be on screen for longer than no time at all.";
      }
      return null;
    }
    case "removeRange": {
      if (!isTime(op.fromSeconds) || !isTime(op.toSeconds)) {
        return "A stretch to remove needs a start and an end.";
      }
      if (op.toSeconds <= op.fromSeconds) {
        return "A stretch to remove has to end after it begins.";
      }
      return null;
    }
    case "addNote": {
      if (!isTime(op.atSeconds)) return "A note needs a moment to be pinned to.";
      if (op.text.trim().length === 0) return "A note with nothing written on it says nothing.";
      return null;
    }
    case "editNote": {
      if (!doc.notes.some((note) => note.id === op.noteId)) {
        return `There is no note called ${op.noteId}.`;
      }
      return null;
    }
    case "moveNote": {
      if (!doc.notes.some((note) => note.id === op.noteId)) {
        return `There is no note called ${op.noteId}.`;
      }
      if (!isTime(op.atSeconds)) return "A note has to be moved to a moment.";
      return null;
    }
    case "removeNotes": {
      if (op.noteIds.length === 0) return "No note was named.";
      const gone = op.noteIds.find((id) => !doc.notes.some((note) => note.id === id));
      return gone ? `There is no note called ${gone}.` : null;
    }
    case "setTransition": {
      if (op.clipIds.length === 0) return "Nothing was named.";
      const gone = op.clipIds.find((id) => !findClip(doc, id));
      if (gone) return missing(gone);
      if (op.edge !== "in" && op.edge !== "out") {
        return "A transition sits at the in edge or the out edge.";
      }
      return null;
    }
    default: {
      // An operation of a kind this version does not know. Named rather
      // than ignored: silently dropping part of a batch is the failure
      // this module exists to prevent.
      const unknown = op as { kind?: unknown };
      return `There is no edit called ${String(unknown.kind)}.`;
    }
  }
}

/* -------------------------------------------------------------- applying */

/** One operation, assuming it has already been found sound. */
function run(doc: EditDoc, op: Operation): EditDoc {
  const mapTracks = (f: (track: TimelineTrack) => TimelineTrack): EditDoc => ({
    ...doc,
    tracks: doc.tracks.map(f),
  });
  const mapClips = (f: (clip: TimelineClip, track: TimelineTrack) => TimelineClip) =>
    mapTracks((track) => ({ ...track, clips: track.clips.map((c) => f(c, track)) }));

  switch (op.kind) {
    case "cut":
      return { ...doc, tracks: splitClipAt(doc.tracks, op.atSeconds, op.clipId).tracks };

    case "removeClips": {
      const going = new Set(op.clipIds);
      return mapTracks((track) => ({
        ...track,
        clips: track.clips.filter((clip) => !going.has(clip.id)),
      }));
    }

    case "moveClip": {
      const moving = findClip(doc, op.clipId);
      if (!moving) return doc;
      const placed = { ...moving, startSeconds: toMillis(op.startSeconds) };
      // Lifted off every track first, then laid down: a clip moving
      // between tracks must not be made to give way to itself.
      return mapTracks((track) => {
        const without = track.clips.filter((clip) => clip.id !== op.clipId);
        if (track.id !== op.trackId) {
          return without.length === track.clips.length ? track : { ...track, clips: without };
        }
        return { ...track, clips: settleOnTrack(without, placed) };
      });
    }

    case "trim": {
      const track = trackHolding(doc, op.clipId);
      if (!track) return doc;
      const clip = track.clips.find((c) => c.id === op.clipId)!;
      // Held back at whatever is beside it: an edge should never quietly
      // swallow its neighbour.
      const limit = trimLimit(track.clips, clip, op.edge);
      const held =
        op.edge === "start" ? Math.max(op.seconds, limit) : Math.min(op.seconds, limit);
      const footage = doc.media.find((item) => item.path === clip.mediaPath);
      return mapClips((c) =>
        c.id === op.clipId ? trimClip(c, op.edge, held, footage?.durationSeconds) : c,
      );
    }

    case "setSpeed": {
      // Earliest first: each one closes up what follows it, so a later
      // clip is moved by the ripple of an earlier one before its own is
      // worked out.
      const order = clipsOf(doc)
        .filter((clip) => op.clipIds.includes(clip.id))
        .sort((a, b) => a.startSeconds - b.startSeconds)
        .map((clip) => clip.id);
      let tracks = doc.tracks;
      for (const id of order) tracks = setClipSpeed(tracks, id, op.speed);
      return { ...doc, tracks };
    }

    case "setVolume":
      return mapClips((clip) =>
        clip.id === op.clipId
          ? { ...clip, volume: op.points.length > 0 ? op.points : undefined }
          : clip,
      );

    case "addTitle": {
      const clip: TimelineClip = {
        id: newId("clip"),
        mediaPath: "",
        startSeconds: toMillis(op.atSeconds),
        durationSeconds: op.durationSeconds ?? DEFAULT_TEXT_SECONDS,
        text: { ...DEFAULT_TEXT_STYLE, ...(op.text ?? {}) },
        layout: { ...FULL_FRAME_LAYOUT },
      };
      if (op.trackId === null) {
        // A new track, because a title laid onto a track that is already
        // busy would push the footage about to make room for itself.
        return {
          ...doc,
          tracks: withTrackNames([...doc.tracks, { ...newTrack("Track"), clips: [clip] }]),
        };
      }
      return mapTracks((track) =>
        track.id === op.trackId
          ? { ...track, clips: settleOnTrack(track.clips, clip) }
          : track,
      );
    }

    case "removeRange": {
      const { fromSeconds: from, toSeconds: to } = op;
      const length = to - from;
      // A thousandth of a second: an edge that merely touches the range
      // is on its boundary, not inside it.
      const touch = 1e-3;

      // Cut every track at both ends first, so nothing is left straddling
      // the range with half of it to keep. A clip already ending within
      // a twentieth of a second of an edge is not split — `splitClipAt`
      // refuses to make a piece that short — and it does not need to be:
      // it falls wholly on one side or the other.
      let tracks = splitClipAt(doc.tracks, from).tracks;
      tracks = splitClipAt(tracks, to).tracks;

      tracks = tracks.map((track) => {
        const clips = track.clips
          .filter((clip) => {
            const ends = clip.startSeconds + clip.durationSeconds;
            const inside =
              clip.startSeconds >= from - touch && ends <= to + touch;
            return !inside;
          })
          .map((clip) =>
            clip.startSeconds >= to - touch
              ? { ...clip, startSeconds: toMillis(clip.startSeconds - length) }
              : clip,
          );
        return { ...track, clips };
      });

      // Words that were spoken inside the stretch are gone with it, and
      // the rest move up. Dropped rather than collapsed, unlike the
      // notes: a note is a remark about the film and survives the moment
      // it was about, but a word is a claim that something was said
      // here — and after this edit, it was not.
      const words = doc.words
        .filter((word) => word.end <= from + touch || word.start >= to - touch)
        .map((word) =>
          word.start >= to - touch
            ? {
                ...word,
                start: toMillis(word.start - length),
                end: toMillis(word.end - length),
              }
            : word,
        );

      // The notes move with the film.
      //
      // One inside the stretch is pinned to a moment that no longer
      // exists. It is collapsed to where the stretch began rather than
      // thrown away: the moment has gone, but somebody wrote those words
      // on purpose, and an edit that quietly deletes writing is not one
      // anybody would trust to run twice.
      const notes = doc.notes.map((note) => {
        if (note.atSeconds >= to - touch) {
          return { ...note, atSeconds: toMillis(note.atSeconds - length) };
        }
        if (note.atSeconds > from) {
          return { ...note, atSeconds: toMillis(from) };
        }
        return note;
      });

      return { ...doc, tracks, notes, words };
    }

    case "addNote":
      return { ...doc, notes: [...doc.notes, newNote(op.atSeconds, op.text)] };

    case "editNote":
      return {
        ...doc,
        notes: doc.notes.map((note) =>
          note.id === op.noteId ? { ...note, text: op.text } : note,
        ),
      };

    case "moveNote":
      return {
        ...doc,
        notes: doc.notes.map((note) =>
          note.id === op.noteId
            ? { ...note, atSeconds: toMillis(Math.max(0, op.atSeconds)) }
            : note,
        ),
      };

    case "removeNotes": {
      const going = new Set(op.noteIds);
      return { ...doc, notes: doc.notes.filter((note) => !going.has(note.id)) };
    }

    case "setTransition": {
      const chosen = new Set(op.clipIds);
      return mapClips((clip) =>
        chosen.has(clip.id)
          ? op.edge === "in"
            ? { ...clip, transitionIn: op.transition }
            : { ...clip, transitionOut: op.transition }
          : clip,
      );
    }

    default:
      return doc;
  }
}

/** The result of asking for a batch.
 *
 * `problems` empty means every operation ran. Otherwise `doc` is the
 * document exactly as it came in, and `problems` says what stopped it —
 * with `failedAt` naming which operation in the list.
 */
export interface Applied {
  doc: EditDoc;
  problems: string[];
  failedAt: number | null;
}

/** Applies a batch, all of it or none of it.
 *
 * Each operation is checked against the document as it stands at that
 * point rather than against the one that came in, because an operation
 * can be made possible — or impossible — by the one before it. Cutting a
 * clip in two makes a clip that was not there to move a moment ago.
 */
export function apply(doc: EditDoc, ops: Operation[]): Applied {
  let current = doc;
  for (let i = 0; i < ops.length; i += 1) {
    const problem = problemWith(current, ops[i]);
    if (problem) {
      return { doc, problems: [problem], failedAt: i };
    }
    current = run(current, ops[i]);
  }
  return { doc: current, problems: [], failedAt: null };
}

/* -------------------------------------------------------- in plain words */

/** What a clip is called, for saying something about it.
 *
 * The file's name, or a title's own words. Not the id: an id is for the
 * program, and a list of edits that reads "clip-mf8x2k-3" is a list
 * nobody can approve.
 */
function nameOf(doc: EditDoc, id: string): string {
  const clip = findClip(doc, id);
  if (!clip) return id;
  if (isTextClip(clip)) {
    const words = clip.text?.content?.split("\n")[0]?.trim();
    return words ? `"${words}"` : "a title";
  }
  const parts = clip.mediaPath.split(/[\\/]/);
  return parts[parts.length - 1] || id;
}

const secs = (n: number) => `${n.toFixed(2)}s`;

/** One operation, in a sentence a person can agree or disagree with.
 *
 * This is what stands between a model's proposal and somebody pressing
 * Apply. A panel showing `{"kind":"removeRange","fromSeconds":2.15}` is
 * asking for approval of something nobody has read; the whole point of
 * showing a proposal is that it can be understood before it happens.
 */
export function explain(op: Operation, doc: EditDoc): string {
  switch (op.kind) {
    case "cut":
      return op.clipId
        ? `Cut ${nameOf(doc, op.clipId)} at ${secs(op.atSeconds)}`
        : `Cut every clip at ${secs(op.atSeconds)}`;

    case "removeClips":
      return op.clipIds.length === 1
        ? `Remove ${nameOf(doc, op.clipIds[0])}`
        : `Remove ${op.clipIds.length} clips: ${op.clipIds
            .map((id) => nameOf(doc, id))
            .join(", ")}`;

    case "moveClip": {
      const track = doc.tracks.find((t) => t.id === op.trackId);
      return `Move ${nameOf(doc, op.clipId)} to ${
        track ? `"${track.name}"` : op.trackId
      } at ${secs(op.startSeconds)}`;
    }

    case "trim":
      return `Drag the ${op.edge} of ${nameOf(doc, op.clipId)} to ${secs(op.seconds)}`;

    case "setSpeed":
      return `Play ${
        op.clipIds.length === 1
          ? nameOf(doc, op.clipIds[0])
          : `${op.clipIds.length} clips`
      } at ${op.speed}x`;

    case "setVolume":
      return op.points.length === 0
        ? `Put the volume of ${nameOf(doc, op.clipId)} back to normal`
        : `Reshape the volume of ${nameOf(doc, op.clipId)} (${op.points.length} point${
            op.points.length === 1 ? "" : "s"
          })`;

    case "addTitle": {
      const words = op.text?.content?.split("\n")[0]?.trim();
      const where =
        op.trackId === null
          ? "on a new track"
          : `on "${doc.tracks.find((t) => t.id === op.trackId)?.name ?? op.trackId}"`;
      return `Add the title ${words ? `"${words}"` : "(no words)"} at ${secs(
        op.atSeconds,
      )} ${where}`;
    }

    case "setTransition": {
      const what =
        op.clipIds.length === 1 ? nameOf(doc, op.clipIds[0]) : `${op.clipIds.length} clips`;
      const edge = op.edge === "in" ? "arrives" : "leaves";
      return op.transition
        ? `Make ${what} ${edge} with ${op.transition.kind} over ${secs(
            op.transition.seconds,
          )}`
        : `Take the transition off the way ${what} ${edge}`;
    }

    case "removeRange":
      return `Remove ${secs(op.fromSeconds)}\u2013${secs(op.toSeconds)} (${secs(
        op.toSeconds - op.fromSeconds,
      )}) and close the gap`;

    case "addNote":
      return `Leave a note at ${secs(op.atSeconds)}: "${op.text}"`;

    case "editNote":
      return `Rewrite the note at ${secs(
        doc.notes.find((n) => n.id === op.noteId)?.atSeconds ?? 0,
      )}: "${op.text}"`;

    case "moveNote":
      return `Move a note to ${secs(op.atSeconds)}`;

    case "removeNotes":
      return op.noteIds.length === 1
        ? "Remove a note"
        : `Remove ${op.noteIds.length} notes`;

    default:
      return "An edit this version does not know about";
  }
}

/** Whether something that arrived from outside is shaped like an
 * operation at all.
 *
 * What a model sends is JSON, not a value of this type. Everything past
 * the `kind` is left to `problemWith`, which can say what is wrong in
 * words; this only rules out what is not an operation in the first place.
 */
export function asOperation(value: unknown): Operation | null {
  if (typeof value !== "object" || value === null) return null;
  const kind = (value as { kind?: unknown }).kind;
  return typeof kind === "string" ? (value as Operation) : null;
}

/** Everything wrong with a batch, without changing anything.
 *
 * Stops at the first problem for the same reason `apply` does: once one
 * operation cannot run, the document the later ones were written against
 * never comes into being, so anything said about them would be a guess.
 */
export function validate(doc: EditDoc, ops: Operation[]): string[] {
  return apply(doc, ops).problems;
}
