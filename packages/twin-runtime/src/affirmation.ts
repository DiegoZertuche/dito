/**
 * The twin thread's two keywords (ticket #25, slice AC 6; ticket #30;
 * ticket #49; CONTRACTED at #174; ADR-0006, ADR-0037 as amended).
 *
 * THE ROUTER IS DOWN TO THE TWO ACTS A WRONG YES CANNOT TAKE BACK, and this
 * file is the whole of it: a bare «va» quoted on a draft, which releases a
 * message to a customer, and a bare «si» / «sí» / «va» quoted on a binding
 * question, which associates a chat with an entity. Everything else the rep
 * says in their thread — «no va», «así no», «3 no», «no, ese no es Torres»,
 * «ya no» — is prose, read by the thread execution and acted on through
 * gated tools (spec #171 decision 18; ADR-0037).
 *
 * WHAT LEFT AT #174, AND WHY IT LEFT. The decline sets, the numbered
 * line-correction verb and the aperture question's «si» are gone. All three
 * existed because there was no other path: a rep act had to be a phrase the
 * matcher recognized or it reached nothing at all, so the rep was asked to
 * learn «no va» for a draft, «N no» for a line and «si» for a question. The
 * thread execution is that other path, and ADR-0037's ruling is that the
 * axis is the DIRECTION OF THE ERROR: a keyword survives only where a
 * misread cannot be taken back. A dismissal, a retraction inside the
 * correction window and an answer to a question can all be taken back, so
 * none of them owes the rep a phrase.
 *
 * The bare-phrase rule is unchanged, and it is one rule for both verbs: the
 * phrase itself, in any case, tolerating only whitespace, a leading «¡» and
 * trailing runs of . ! … — because a tap releases a message to a customer.
 * A question mark anywhere («¿va?», «si?») is a question, never a verb; a
 * reply with content («va mañana») is prose and now reaches the execution
 * rather than falling into silence.
 */

/**
 * The verb class a twin post speaks — the axis the accepted set turns on.
 *
 * `proposal` — the twin proposes an act and waits for the rep's go-ahead (a
 *   draft). «va» is the word two slices have taught and the only one: the
 *   tap releases a message to a customer.
 * `question` — the twin asks the rep something a wrong yes cannot take back
 *   (the binding question). Yes-words belong here, because «va» ("go
 *   ahead") reads oddly as the answer to «¿Este chat es de X?» (#36 finding
 *   1).
 *
 * TWO CLASSES, NOT THREE. `statement` went with the line-correction verb at
 * #174: the daily disclosure's own sets were empty by design — silence
 * accepts a report — so once «N no» became prose the class had no member
 * and no accepted word, and a grammar class nothing speaks is a branch every
 * reader has to rule out.
 */
export type PostGrammar = "proposal" | "question";

/**
 * The words that mean YES, by verb class (spec #48 grilling decision 3;
 * contracted at #174).
 *
 * THE FIRST WORD OF EACH SET IS THE ONE THE TWIN TEACHES (ticket #172). The
 * instruction line under a draft and the answers line under a binding
 * question are rendered from these sets rather than written down — the
 * keyword is a button and the line is its label (ADR-0037 as amended) — and
 * a label naming five accepted spellings would teach none of them. So the
 * order is part of the data: first the word the rep is shown, then the ones
 * also accepted because a keyboard or a habit produces them. Membership
 * decides what MATCHES (`matchesAny` uses `some`, so order cannot affect
 * it); position decides what is TAUGHT.
 *
 * IT IS ALSO THE DATA THE EXECUTION IS HANDED (spec #171 user story 37, the
 * `keyword_set` recipe): "the accepted keyword set handed to the execution
 * as data, so that the twin can teach «va» and cannot teach a word that is
 * not accepted". One table, three readers — the matcher, the two rendered
 * labels, and the prompt — so a word added or retaught here reaches all of
 * them and a word absent from it is one nothing can teach.
 *
 * FROZEN, like every other closed value this repo exports (the two-axis
 * review's Standards axis). This is the matcher's own table and two
 * rep-facing labels render from it, so a caller that could reach in and
 * change one would change what the rep is taught and what the matcher
 * accepts at the same time, from anywhere.
 *
 * A question takes «si» — the taught word, unaccented — and «sí», because
 * the es-MX keyboard produces the accent unprompted and refusing it would
 * leave the rep typing the right word and watching nothing happen. It also
 * keeps «va», the word two slices have already taught: "go ahead" is never
 * WRONG as an answer, only less natural than "yes".
 *
 * A proposal keeps «va» and nothing else, and that asymmetry is the
 * fail-safe direction, not an oversight: a tap releases a message to a
 * customer, and a rep answering «si» to something is not a rep releasing a
 * message they have not re-read. «si» quoted on a draft mints nothing and
 * reaches the execution as prose.
 */
export const AFFIRMATIONS: Readonly<Record<PostGrammar, readonly string[]>> =
  Object.freeze({
    proposal: ["va"],
    question: ["si", "sí", "va"],
  });

const TRIVIAL_DECORATION = /^[¡\s]+|[.!…\s]+$/gu;

/**
 * The one matcher shape both keywords share: the bare phrase, trivially
 * decorated, nothing more.
 *
 * Normalized to NFC on both sides, so a composed and a decomposed «sí» are
 * the same word — the es-MX keyboard's accent can arrive either way, and a
 * rep who typed the right word must never watch nothing happen.
 */
function matchesAny(text: string, phrases: readonly string[]): boolean {
  const bare = bareOf(text);
  return phrases.some((phrase) => bare === phrase.normalize("NFC"));
}

/** The reply with its trivial decoration removed, case- and NFC-normalized. */
function bareOf(text: string): string {
  return text.replace(TRIVIAL_DECORATION, "").toLowerCase().normalize("NFC");
}

/** Whether this reply affirms a post of the given verb class. */
export function acceptsAffirmation(
  grammar: PostGrammar,
  text: string,
): boolean {
  return matchesAny(text, AFFIRMATIONS[grammar]);
}
