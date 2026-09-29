/** The noises between the words.
 *
 * "Eee", "anu", "um" — the sounds a person makes while deciding what to
 * say next. Everybody makes them, nobody wants them in a tutorial, and
 * finding them by hand means scrubbing through a take one pause at a
 * time.
 *
 * The transcript already says what was said and when, so this is arith-
 * metic rather than cleverness: match the words, merge the ones that run
 * together, and hand back the stretches of timeline they occupy. No
 * model, no key, nothing sent anywhere.
 *
 * The lists below are deliberately short. A word that is *sometimes* a
 * hesitation and sometimes meant — "like", "gitu", "kayak" — is left out
 * entirely: removing one of those when it was meant changes what a person
 * said, and a tool that edits speech has no business guessing at that.
 */

import { toMillis, type TimedWord } from "./types";

/** Sounds that are hesitations wherever they appear.
 *
 * Grouped by language only so the lists stay readable; all of them are
 * matched at once, because a recording in Indonesian will still have the
 * occasional "um" in it and nobody should have to say which.
 */
export const FILLER_WORDS: Record<string, string[]> = {
  Indonesian: ["anu", "eh", "ehm", "hmm", "mmm", "nganu"],
  // "ah" is deliberately absent. Held as "ahh" it is a hesitation and
  // the pattern below catches it, but on its own it is as often a word
  // somebody meant — "ah, I see" — and taking that out would change
  // what was said.
  English: ["um", "uh", "er", "erm", "uhm", "hm", "mm"],
};

/** Hesitations that are held, and so are spelled at whatever length the
 * service heard: "eee", "eeeee", "mmmm", "uhhh".
 *
 * A pattern rather than a list, because there is no end to the list. Each
 * demands a doubled letter, so an ordinary word is never caught: "er"
 * matches by being in the list above, but "era" does not match here. */
const HELD = [
  /^e{2,}$/, // eee, eeee
  /^m{2,}$/, // mmm
  /^h{1,2}m{2,}$/, // hmm, hhmm
  /^u+h+$/, // uh, uhhh
  // A doubled letter required, so "ahh" and "aah" match and a plain
  // "ah" does not.
  /^(a{2,}h+|a+h{2,})$/,
  /^e+r+m*$/, // err, errm
];

/** What a word amounts to once punctuation and case are set aside. */
function plain(word: string): string {
  return word
    .toLowerCase()
    .replace(/[^\p{L}]/gu, "")
    .trim();
}

/** The vocabulary used unless another is given. */
export function defaultFillers(): Set<string> {
  return new Set(Object.values(FILLER_WORDS).flat());
}

/** Whether a word is one of the noises. */
export function isFiller(word: string, vocabulary = defaultFillers()): boolean {
  const bare = plain(word);
  if (bare.length === 0) return false;
  if (vocabulary.has(bare)) return true;
  return HELD.some((pattern) => pattern.test(bare));
}

/** Which words in a transcript are hesitations, by position. */
export function fillerAt(
  words: TimedWord[],
  vocabulary = defaultFillers(),
): Set<number> {
  const found = new Set<number>();
  words.forEach((word, index) => {
    if (isFiller(word.word, vocabulary)) found.add(index);
  });
  return found;
}

/** A stretch of timeline to take out. */
export interface FillerRun {
  start: number;
  end: number;
  /** How many words it covers, for saying what is about to happen. */
  words: number;
}

/** The stretches of timeline the hesitations occupy.
 *
 * Neighbouring ones are joined: "eee... um" said together is one stumble
 * and comes out as one cut, not two — which also keeps the tiny sliver of
 * audio between them from being left behind.
 *
 * The answer is in timeline seconds, ready for `removeRange`, and in the
 * order it is spoken. A caller removing them all should work from the end
 * backwards, since each cut moves everything after it.
 */
export function fillerRuns(
  words: TimedWord[],
  vocabulary = defaultFillers(),
): FillerRun[] {
  const runs: FillerRun[] = [];
  let open: FillerRun | null = null;

  for (let i = 0; i < words.length; i += 1) {
    if (!isFiller(words[i].word, vocabulary)) {
      open = null;
      continue;
    }
    const word = words[i];
    // Joined to the one before it when they were said one after the
    // other with no real word between them.
    if (open && i > 0 && isFiller(words[i - 1].word, vocabulary)) {
      open.end = word.end;
      open.words += 1;
      continue;
    }
    open = { start: word.start, end: word.end, words: 1 };
    runs.push(open);
  }

  return runs
    .filter((run) => run.end > run.start)
    .map((run) => ({
      start: toMillis(run.start),
      end: toMillis(run.end),
      words: run.words,
    }));
}

/** How much time a set of runs accounts for. */
export function fillerSeconds(runs: FillerRun[]): number {
  return toMillis(runs.reduce((sum, run) => sum + (run.end - run.start), 0));
}
