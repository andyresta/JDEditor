/** Notes turned into chapters.
 *
 * The yellow notes along the ruler already hold a moment and a few words,
 * which is exactly what a chapter is. This turns them into the list a
 * video site expects in a description:
 *
 *     0:00 Opening
 *     1:24 Installing it
 *     4:02 What can go wrong
 *
 * The rules below are YouTube's, and they are unforgiving in a particular
 * way: a list that breaks one of them is not partly accepted, it is
 * ignored altogether and no chapters appear at all. So the list is
 * checked before it is handed over, and what is wrong with it is said
 * plainly rather than left to be discovered on a published video.
 */

import { notesInOrder, type ProjectNote } from "./types";

/** A list has to start at the very beginning. */
const MUST_START_AT = 0;
/** Fewer than this and the list is ignored. */
export const FEWEST_CHAPTERS = 3;
/** And no chapter may be shorter than this. */
export const SHORTEST_CHAPTER = 10;

/** A moment, written the way a description expects it.
 *
 * Hours only when there are hours: "1:05:20" for a long film, "5:20" for
 * a short one. Minutes are not padded at the front of the line because
 * that is how every description on the site reads.
 */
export function timecode(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secs = whole % 60;
  const two = (n: number) => String(n).padStart(2, "0");
  return hours > 0 ? `${hours}:${two(minutes)}:${two(secs)}` : `${minutes}:${two(secs)}`;
}

export interface Chapters {
  /** The list, ready to be pasted. Empty when there is nothing to say. */
  text: string;
  /** How many chapters it holds. */
  count: number;
  /** What would stop a video site accepting it, in words. Empty when it
   * would be accepted. */
  problems: string[];
}

/** Turns the notes of a project into a chapter list.
 *
 * Notes with nothing written on them are left out: an empty note is a
 * marker somebody dropped and has not come back to, not a chapter.
 */
export function chaptersFrom(notes: ProjectNote[], filmSeconds: number): Chapters {
  const said = notesInOrder(notes).filter((note) => note.text.trim().length > 0);

  const lines = said.map(
    (note) => `${timecode(note.atSeconds)} ${note.text.trim().replace(/\s+/g, " ")}`,
  );

  const problems: string[] = [];
  if (said.length === 0) {
    return { text: "", count: 0, problems: ["No notes have anything written on them."] };
  }

  if (said[0].atSeconds > MUST_START_AT + 0.5) {
    problems.push(
      `The first chapter has to be at ${timecode(0)} — add a note at the very start.`,
    );
  }
  if (said.length < FEWEST_CHAPTERS) {
    problems.push(
      `There have to be at least ${FEWEST_CHAPTERS} chapters; this has ${said.length}.`,
    );
  }

  // Each chapter runs until the next one, and the last until the end of
  // the film.
  const ends = said.map((note, i) =>
    i + 1 < said.length ? said[i + 1].atSeconds : Math.max(filmSeconds, note.atSeconds),
  );
  const short = said.filter((note, i) => ends[i] - note.atSeconds < SHORTEST_CHAPTER);
  if (short.length > 0) {
    problems.push(
      short.length === 1
        ? `One chapter is shorter than ${SHORTEST_CHAPTER} seconds (${timecode(short[0].atSeconds)}).`
        : `${short.length} chapters are shorter than ${SHORTEST_CHAPTER} seconds.`,
    );
  }

  return { text: lines.join("\n"), count: said.length, problems };
}
