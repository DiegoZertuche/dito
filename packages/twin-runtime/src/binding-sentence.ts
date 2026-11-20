/**
 * THE BINDING QUESTION'S SENTENCE, AS THE TWIN WRITES IT (tickets #34, #172,
 * #363; spec #171 decision 17): one rule for both places a turn hands the
 * rep that question — drafting's `create_draft` and the thread's
 * `propose_binding`.
 *
 * THE NAME IS THE RAIL'S, NEVER ONE MODEL TEXT PRODUCED (#34's decision 1;
 * ADR-0037 as amended): the sentence carries `{name}` exactly once where the
 * name goes, code folds the name in, and a sentence that types the name as
 * well is refused. ONE SENTENCE, because the rep answers the post with one
 * word, and a second sentence beside the question is a second thing that
 * word could be read as answering.
 */
import { NAME_SLOT } from "./grammar.js";

/** Why this sentence may not ask the question, or nothing when it may. */
export function bindingSentenceViolation(sentence: string, proposedName: string | undefined): string | undefined {
  if (sentence.trim() === "") return "the question is one sentence, in words";
  if (typesTheName(sentence, proposedName)) {
    return `the question types the name instead of writing ${NAME_SLOT} where it goes`;
  }
  const slots = sentence.split(NAME_SLOT).length - 1;
  if (slots !== 1) {
    return `the question carries ${NAME_SLOT} exactly once, and this one carries it ${String(slots)} time(s)`;
  }
  if (/[.!?…]\s+\S/u.test(sentence.trim())) {
    return "the question is one sentence: say everything else in your own line";
  }
  return undefined;
}

/**
 * Whether the sentence spells the name out as well as slotting it — folded,
 * because a name typed with different accents or casing is the same name to a
 * reader; the slot is removed first.
 */
function typesTheName(sentence: string, name: string | undefined): boolean {
  if (name === undefined) return false;
  const wanted = fold(name);
  if (wanted === "") return false;
  return fold(sentence.split(NAME_SLOT).join(" ")).includes(wanted);
}

function fold(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim();
}
