/**
 * A PHRASE THE REP SELECTED, FOUND AMONG THE CARD'S OWN WORDS (ticket #341;
 * the spine's movement 7, «¿Y esto?»).
 *
 * The page sends the words the rep selected on one of the twin's cards; this
 * finds them in what that card shows — the twin's sentence with each name
 * drawn where its reference stands, a draft's body, one numbered line of the
 * day's notes — and answers the phrase AS THE TWIN WROTE IT there, so the thread is told the twin's own words and never
 * anything the page could have put in the request. A phrase the card does not
 * show is found nowhere.
 *
 * WHITESPACE FOLDS, CASE DOES NOT. A selection crossing a line break reads
 * back with a newline where the card wrapped or broke a paragraph, so every
 * run of whitespace counts as one space on both sides. The letters are the
 * card's own: the browser copies them as drawn, so a phrase differing in case
 * is not one the rep selected there.
 *
 * A NAME IS NEVER CUT. The twin writes a customer as a reference (`[c7]`) and
 * the card draws the name — with the number's tails after it, in the copy
 * record's words, where the customer has more than one chat, exactly as
 * rep-web's `withTails` draws it; a phrase that takes any of a name is told
 * with the whole reference in its place.
 */
import { CHROME } from "@dito/copy";
import type { FeedPost } from "./feed.js";
import { markInProse } from "@dito/seam";
import { referencePattern, spellReference } from "./thread/references.js";

/** The phrase on `post`, as the twin wrote it in the first text that shows it — or `undefined` when none does. */
export function findPhrase(post: FeedPost, phrase: string): string | undefined {
  const wanted = folded(phrase).text.trim();
  if (wanted === "") return undefined;
  for (const part of post.parts) {
    const runs =
      part.kind === "prose"
        ? [proseRuns(part.text, part.mentions ?? [])]
        : part.kind === "draft"
          ? [[{ shown: part.body, raw: part.body, whole: false }]]
          : part.kind === "record-lines"
            ? part.lines.map((line) => [{ shown: line.text, raw: line.text, whole: false }])
            : [];
    for (const text of runs) {
      const found = foundIn(text, wanted);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/**
 * One stretch of a part: what the card shows, what the twin wrote, and
 * whether it is one name — shown as a name, written as a reference, and so
 * taken whole or not at all.
 */
interface Run {
  readonly shown: string;
  readonly raw: string;
  readonly whole: boolean;
}

/** The twin's sentence as runs: its words, and each reference the mentions name drawn as that name. */
function proseRuns(
  text: string,
  mentions: readonly { readonly reference: string; readonly name: string; readonly tails?: readonly string[] }[],
): Run[] {
  const names = new Map(mentions.map((mention) => [mention.reference, drawnName(mention)] as const));
  const runs: Run[] = [];
  // A MARK'S BRACKETS AND CARD ARE NOTHING THE CARD SHOWS (ticket #401): they
  // stand in the runs as raw text shown as nothing: a phrase is found in what
  // the card shows, and quoted back as the twin wrote it, marks and all.
  const syntax: { readonly start: number; readonly end: number }[] = [];
  for (const mark of text.matchAll(markInProse())) {
    const wordsEnd = mark.index + 1 + mark[1]!.length;
    syntax.push({ start: mark.index, end: mark.index + 1 }, { start: wordsEnd, end: mark.index + mark[0].length });
  }
  const cuts = [
    ...syntax.map((one) => ({ ...one, shown: "" })),
    ...[...text.matchAll(referencePattern())].flatMap((match) => {
      const name = names.get(spellReference(Number(match[1])));
      return name === undefined ? [] : [{ start: match.index, end: match.index + match[0].length, shown: name }];
    }),
  ].sort((one, other) => one.start - other.start);
  let at = 0;
  for (const cut of cuts) {
    if (cut.start > at) runs.push({ shown: text.slice(at, cut.start), raw: text.slice(at, cut.start), whole: false });
    runs.push({ shown: cut.shown, raw: text.slice(cut.start, cut.end), whole: true });
    at = cut.end;
  }
  if (at < text.length) runs.push({ shown: text.slice(at), raw: text.slice(at), whole: false });
  return runs;
}

/** A name as the card draws it: «Torres (termina en 8416 / 0537)» where there are tails, the name alone otherwise. */
function drawnName(mention: { readonly name: string; readonly tails?: readonly string[] }): string {
  const tails = mention.tails ?? [];
  return tails.length === 0 ? mention.name : `${mention.name} (${CHROME["customer.tail"]} ${tails.join(" / ")})`;
}

/** The phrase, found in what the runs show, as the twin wrote it — or `undefined`. */
function foundIn(runs: readonly Run[], wanted: string): string | undefined {
  // EVERY CHARACTER SHOWN, with where it came from: its run, and its offset
  // in what the twin wrote (a name's characters all answer to its reference).
  const shown: { readonly run: number; readonly raw: number }[] = [];
  let text = "";
  let raw = 0;
  runs.forEach((run, index) => {
    for (let at = 0; at < run.shown.length; at += 1) shown.push({ run: index, raw: run.whole ? raw : raw + at });
    text += run.shown;
    raw += run.raw.length;
  });
  const fold = folded(text);
  const start = fold.text.indexOf(wanted);
  if (start === -1) return undefined;
  const first = shown[fold.origin[start]!]!;
  const last = shown[fold.origin[start + wanted.length - 1]!]!;
  const written = runs.map((run) => run.raw).join("");
  const end = runs[last.run]!.whole ? last.raw + runs[last.run]!.raw.length : last.raw + 1;
  return written.slice(first.raw, end);
}

/**
 * Text with every run of whitespace as one space, and for each character of
 * the result the offset in `text` it came from.
 */
function folded(text: string): { readonly text: string; readonly origin: readonly number[] } {
  let out = "";
  const origin: number[] = [];
  let blank = false;
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at]!;
    if (/\s/u.test(char)) {
      if (blank) continue;
      blank = true;
      out += " ";
    } else {
      blank = false;
      out += char;
    }
    origin.push(at);
  }
  return { text: out, origin };
}
