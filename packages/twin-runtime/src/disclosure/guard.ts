/**
 * THE DISCLOSURE'S STRUCTURAL GUARD (ticket #198; spec #193 decision 23 and
 * user story 28; ADR-0028 as amended, ADR-0037 as amended).
 *
 * User story 28 is the whole of it: "as a reviewer, I want every guard on the
 * disclosure's submission to be structural, so that a scripted model that
 * types a count, a name or an invented question is refused in CI without a
 * model in the loop." Every rule below is a property of the SHAPE of a call
 * to `post_disclosure` against what this step was served, which is why the seam
 * can show each one biting with no model call at all.
 *
 * FOUR RULES: three about VALUES a call may not type — a number, a
 * served name, a slot to a reference nothing served — and one about a part
 * that renders as nothing. A fifth held every served question to exactly one
 * lead and one ask, and the candidate-question route it guarded is retired
 * (ticket #218; spec #214 decision 3).
 *
 * IT IS THE OWNER TWIN'S GUARD ON THE REP SIDE (`owner-twin/src/guard.ts`),
 * and the family resemblance is deliberate rather than coincidental: spec
 * #171's user story 45 asked for "the Q&A's served-map refusal and the owner
 * twin's structural guard [to] be one mechanism with two strictnesses", and
 * this is the third instance of it. The digits rule, the served-name rule and
 * the slot rule are the same three, over the same `\p{Nd}` class and the same
 * accent-folded whole-word match.
 *
 * WHAT IS SHARED AND WHAT IS NOT. The name matcher IS shared, with the thread
 * one directory over (`mentionsName` in `thread/chats.ts`): two answers to
 * "did the twin say this name" is exactly the hazard that function was written
 * against. The OWNER's copy is not, because `@dito/owner-twin` is on the far
 * side of the wall and this package may not import it (ADR-0002; the
 * dependency-wall test) — the fix there is a package below both, and it is the
 * remainder `slots.ts` already records.
 *
 * A REFUSAL IS FEEDBACK, NOT A TERMINAL FAILURE, which is the one place this
 * guard differs from the owner's. It lives in the tool's parse, so the reason
 * goes back as the tool's answer and the model may call again inside the
 * budget it already has — the rule every automation inherits (#133, where
 * what a terminal refusal costs with a real model was measured). A call
 * refused on every attempt posts nothing and leaves the day's lines pending.
 *
 * WHERE THE FORBIDDEN WORDS COME FROM, said plainly because it is the rule
 * the ticket asks to be recorded: they are the SERVED NAMES and nothing else
 * — `deps.counterparties[].name`, which is the bundle entity mirror's
 * rep-confirmed display name and the exact string `counterpartyName` folds
 * into the post. Not a list written here, for the reason the owner's guard
 * gives about its own: "a hand-written list of Spanish words here would be
 * the first offender the sweep found — and it would be right, because a
 * forbidden-word list is a list of things the product says." Deriving them
 * also makes the rule narrow in the right direction: what is refused is a
 * name THIS day's record holds, so a rep whose customer is called «Cemex» is
 * refused that word tonight and nobody else ever is.
 */
import { asPosted, asRepReads } from "../grammar.js";
import { mentionsName } from "../thread/chats.js";
import { slotReferences, typedProse } from "./slots.js";
import { servedCounterparty, type DisclosureDeps } from "./deps.js";
import type { DayPost } from "./post-disclosure.js";

/**
 * Any digit at all: a count, a line number, a quantity, half a date.
 *
 * `\p{N}` AND NOT `\d`, the owner guard's own correction (its Codex round 2)
 * taken one class wider (Codex r2 here): JavaScript's `\d` is ASCII-only, so
 * a full-width `４` or an Arabic-Indic `٤` is a number the model typed that
 * the rule could not see — and `\p{Nd}` is still only the DECIMAL digits, so
 * «hoy agregué ① dato» passed it. `①` is `No`, `Ⅷ` is `Nl`, `½` is `No`, and
 * every one of them is a number to the person reading the post. The whole of
 * `\p{N}` is what "no digit at all" means, and nothing a disclosure's prose
 * legitimately says is in it.
 *
 * WHY A DIGIT AT ALL IS REFUSED, rather than only the count. The heading
 * states the day's total and the lines carry their own numbers, both computed
 * by code over the rows this post really holds; a composed sentence that
 * carried a number could disagree with either, and «hoy agregué 4 datos»
 * above five lines is a post the rep cannot check. There is nothing a
 * disclosure's opening or closing needs a digit FOR — every value in this
 * post is code's — so the rule costs the twin nothing it should have.
 */
const DIGITS = /\p{N}/u;

/**
 * Whether a piece of prose names a customer — THE THREAD'S OWN ANSWER, not a
 * second one (`thread/chats.ts`).
 *
 * ONE IMPLEMENTATION, because two would be two answers to "did the twin say
 * this name" — which is the hazard `thread/guard.ts`'s own `says` is written
 * against, on a surface where the answer decides which of two customers gets
 * a turn's question. `mentionsName` compares a contiguous run of whole words
 * with accents and punctuation folded away, so «lo de la Sra. Garza» names
 * «Sra. Garza» and «lo de las cajas» names nobody.
 *
 * `asRepReads` FIRST, and it is the half the fold cannot do: a zero-width
 * character inside a name splits it into two words and would slip through,
 * and WhatsApp's own `*` markers would too. The renderer's own
 * canonicalization takes both out, so what is judged is the string the rep
 * will actually see.
 */
function says(prose: string, phrase: string): boolean {
  return mentionsName(asRepReads(prose), asRepReads(phrase));
}

/**
 * What is structurally wrong with one call, as sentences — a pure function
 * over its two sentences and what this step was served, so the
 * same rules can be shown to bite against a synthetic offender in the same
 * suite (`structuralViolations`' own habit on the owner side).
 *
 * THE ORDER IS THE ORDER OF THE REFUSAL A MODEL READS. The typed values come
 * first, because they are what the rep cannot check; the empty part comes
 * last, because a model that wrote nothing knows it.
 */
export function structuralViolations(
  dayPost: DayPost,
  served: DisclosureDeps,
): string[] {
  const found: string[] = [];

  // THE MODEL TYPES NO NUMBER, NO NAME AND NO UNSERVED SLOT — over every
  // prose field, because every one of them is a sentence the rep reads
  // (`proseFields`). The owner side's rule three, on the rep side.
  for (const [field, text] of proseFields(dayPost)) {
    const typed = typedProse(text);
    if (DIGITS.test(typed)) {
      found.push(
        `${field} types a number: the heading's count and every line's number are code's, so your own sentences carry no digit (spec #193 decision 24)`,
      );
    }
    for (const counterparty of served.counterparties) {
      if (says(typed, counterparty.name)) {
        // NAMED WITHOUT NAMING (Codex's habit on the owner side): the refusal
        // says which SLOT to use rather than repeating the name back, so the
        // reason the model reads is the remedy.
        found.push(
          `${field} types a customer's name: a name is a value the record holds, so write [[${counterparty.ref}]] where it goes and code fills it in (ADR-0037 as amended)`,
        );
        break;
      }
    }
    for (const ref of new Set(slotReferences(text))) {
      const counterparty = servedCounterparty(served, ref);
      if (counterparty === undefined) {
        // A SLOT WITH NOTHING TO FILL IT WOULD REACH THE RENDERER, which
        // throws inside the step's transaction (`foldSlots`) — so the
        // whole post would be lost over one sentence. Refused here, where it
        // is feedback the model can act on.
        found.push(
          `a slot in ${field} names reference ${ref}, which is not a customer this post names`,
        );
      }
    }
    // A PART WITH NO LETTER IN IT IS EMPTY, whatever bytes it holds (Codex r1
    // and r3, three bypasses between them). Every negative version of this
    // rule was one blacklist behind the model: `trim` alone admitted
    // zero-width characters and WhatsApp's own `*` markers; folding those
    // admitted a NEL (U+0085), which the RENDERER turns into a space and
    // trims; folding line breaks too admitted a BRAILLE PATTERN BLANK
    // (U+2800), which is a printable glyph that prints nothing. There is no
    // Unicode property for "renders blank", so the rule is positive instead:
    // every field `proseFields` yields is a SENTENCE, and a sentence has
    // letters. Nothing a disclosure's prose legitimately says is letterless,
    // and the fold is still the renderer's own (`asPosted`), so what is
    // judged is the string the post will carry.
    if (!/\p{L}/u.test(asPosted(text))) {
      found.push(`${field} is empty, and an empty part says nothing`);
    }
  }

  return found;
}

/**
 * Every sentence of one call the rep reads, with what to call it in a
 * refusal.
 *
 * A FUNCTION OVER THE CALL RATHER THAN TWO INLINE PAIRS, and it stays one
 * over two fields. The rule the owner guard's own follow-up states is why:
 * every prose field the rep reads is swept, whatever a later ticket adds. It
 * yielded four while the post carried a lead and an ask per
 * question (ticket #218), and a caller that walked `opening` and `closing` by
 * hand is the shape that misses the third.
 */
function proseFields(
  dayPost: DayPost,
): readonly (readonly [string, string])[] {
  return [
    ["opening", dayPost.opening] as const,
    ["closing", dayPost.closing] as const,
  ];
}
