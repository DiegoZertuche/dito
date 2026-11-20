/**
 * THE THREAD'S STRUCTURAL GUARD (ticket #173; spec #171 decision 21;
 * ADR-0037 as amended).
 *
 * The owner twin's mechanism at the rep side's strictness. Every rule below
 * is a property of the SHAPE of the twin's line against the rows this run
 * actually served — nothing here decides whether prose is true or scores an
 * answer — which is why it runs in CI with no model call at all (ADR-0028)
 * and why `guard.test.ts` can show each rule biting against a synthetic
 * offender.
 *
 * WHAT IT PROTECTS. The rep reads the twin's line as the twin's, and the
 * lines code writes — a receipt — as code's. So prose may not write a receipt
 * of its own, which would read exactly like code's; and a reference must
 * name somebody. Both are reachable through content the search returned
 * telling the model to do it, which is why they are refusals here rather
 * than sentences in a prompt.
 *
 * WHAT A LINE RESTS ON IS THE TWIN'S (Diego, 2026-11-18, #404): when to
 * search before answering is its own call, and nothing here reads what the
 * turn looked up.
 *
 * WHAT IT DOES NOT JUDGE IS WHICH CUSTOMER A REFERENCE PICKED (ticket #321;
 * ADR-0039 as amended; D15). A customer is named by their stable reference,
 * and the one check on the reference itself is that it names a row. Nothing
 * here matches the twin's words against what tells two chats apart: the twin
 * reads what the rep said and chooses, and the card it writes shows the
 * choice before the tap. What stays is the prose fence — no name typed
 * beside the reference that gives it. Nothing here reads whether a line asks
 * the rep anything: the binding question is a tool the twin calls
 * (`propose-binding.ts`), never a sentence code reads intent from.
 *
 * WHERE IT IS WEAKER THAN THE OWNER'S, AND WHY THAT IS A DECISION (spec #171
 * decision 21, in as many words): "digits are *not* refused — the rep side
 * has no wall to protect and a draft body legitimately carries quantities".
 * The owner guard refuses any digit and any calendar word because on that
 * side every number the owner reads is one code rendered from a filed fact.
 * Here the twin is answering the rep about their own conversations, and «le
 * pidió 40 cajas para el jueves» is the answer. `guard.test.ts` asserts both
 * as ALLOWED, so the weakening is a green test rather than a missing one.
 *
 * EVERY VIOLATION IS FEEDBACK, unlike the owner side's. The guard sweeps the
 * twin's final words (ticket #363), and `@dito/execution` hands a refusal
 * back to the model as the reason its turn may not end yet — the SDK's `Stop`
 * hook — so it writes again inside the budget it already has (#133's
 * finding); the reasons below are written to be acted on, and a turn that
 * still ends on refused words ends `failed` with nothing rendered.
 */
import { asRepReads, RECEIPTS, runNamed } from "../grammar.js";
import { mentionsName } from "./chats.js";
import {
  mentionOf,
  phoneName,
  referencesIn,
  replaceReferences,
  withoutReferences,
  writeReference,
  type Customers,
} from "./references.js";
import { repTriggerOf, type ThreadDeps } from "./deps.js";
import { lineViolations } from "./line.js";
import type { ServedAnswerState } from "./served.js";

/**
 * WHETHER THE ANSWER WOULD READ AS A RECEIPT THE TWIN DID NOT EARN (ticket
 * #174, Codex round 1; ADR-0037 as amended).
 *
 * THE BYTES ARE THE PROBLEM, NOT THE DISPOSITION. A receipt is rendered
 * from a tool's result precisely so the twin cannot report an effect it did
 * not perform — and the rep reads bytes, not the `executions` table. An
 * answer of «Descartado» written with no tool call renders `✳️
 * Descartado`, which is byte-identical to the receipt a real dismissal
 * posts: the record says `answered`, and the rep believes their draft is
 * gone while it sits there waiting. The record being right is not the same
 * as the rep being told the truth.
 *
 * The phrases are the RENDERER's own (`RECEIPTS.every`, which is exhaustive
 * over the fixed sentences AND the total refusal record, with the numbered
 * one as a frame), never written down here, so the thing the model is
 * refused for producing is precisely the thing code is about to render; and
 * it runs over the string the rep will actually READ, references rendered and
 * canonicalized, because a receipt hidden behind `*Descartado*` or a
 * zero-width space is the same lie.
 *
 * IT REFUSES THE PHRASE WHATEVER THE TURN DID, and that is deliberate: even
 * an execution that really dismissed the draft must not write the receipt
 * itself, because then the rep could not tell a rendered one from a typed
 * one either. Code folds the real one in beside the prose
 * (`renderAnswerPost`), so there is nothing the model loses by not writing
 * it — and the instructions say so ("Never write out what an act did as if
 * you had done it").
 *
 * AND IT IGNORES WHAT THE PHRASE ENDS WITH (ticket #276). «Listo, lo anoté»
 * with no period and «¡Listo, lo anoté!» are the phrase too, so neither can
 * post a false acknowledgment of a write that never happened. A rep reads
 * the sentence, not the full stop.
 *
 * WHAT IT CANNOT CATCH, said plainly: a paraphrase. «ya lo quité» is not any
 * of these phrases and reads as a claim. That is the ordinary hazard of a
 * model saying something untrue, which the receipt beside it contradicts —
 * what this rule closes is the narrower and worse case, where the twin's
 * words are INDISTINGUISHABLE from code's.
 */
function forgesReceipt(rendered: string): string | undefined {
  const read = fold(asRead(rendered));
  for (const phrase of RECEIPTS.every.fixed) {
    if (read.includes(unpunctuated(fold(asRead(phrase))))) return phrase;
  }
  // THE NUMBERED ONE SPANS EVERY INDEX A POST COULD PRINT, matched from the
  // renderer's own two halves rather than from a list this file would have
  // to bound. The disclosure numbers from 1 and never restarts, and it has
  // no maximum — so a set built to any number would leave the next one
  // through (Codex round 2).
  const { before, after } = RECEIPTS.every.numbered;
  const numbered = new RegExp(
    `${escaped(fold(asRead(before)))}\\d+${escaped(unpunctuated(fold(asRead(after))))}`,
    "u",
  );
  const hit = numbered.exec(read);
  if (hit !== null) return hit[0];
  // ...AND A RUN'S ENDINGS SPAN EVERY RUN, matched from their templates (ticket
  // #358): the run's name as an ending names it, the step and the count as
  // any number.
  for (const ending of RUN_ENDINGS) {
    const found = ending.exec(read);
    if (found !== null) return found[0];
  }
  return undefined;
}

/** A run ending's template as a pattern over folded prose: each slot any run's name or any number. */
const RUN_ENDINGS: readonly RegExp[] = RECEIPTS.every.runEndings.map((template) => {
  // THE NAME SLOT IS WHAT `runNamed` WRAPS A NAME IN, read off it: any name
  // between its two marks, or its word for a run with none.
  const [open = "", close = ""] = runNamed("\u0000").split("\u0000");
  // ...A NAME THAT HOLDS THE MARKS ITSELF INCLUDED (Codex r3): the name runs
  // to whichever closing mark the rest of the sentence follows.
  const named = `(?:${escaped(open)}.+?${escaped(close)}|${escaped(fold(runNamed("")))})`;
  const pieces = unpunctuated(fold(asRepReads(template))).split(/(\{run\}|\{step\}|\{of\})/u);
  return new RegExp(
    pieces.map((piece) => (piece === "{run}" ? named : piece === "{step}" || piece === "{of}" ? "\\d+" : escaped(piece))).join(""),
    "u",
  );
});

/**
 * A receipt phrase with whatever it ends with taken off (ticket #276).
 *
 * THE PHRASE AND NOT THE PROSE IS WHAT IS TRIMMED, which is what makes this a
 * widening and never a narrowing: the model's own sentence is compared whole,
 * and every variant that ends where a receipt's words end — with a period,
 * with none, with an exclamation mark, with an ellipsis — now matches the one
 * the renderer owns. A sentence that merely CONTAINS a receipt's opening word
 * is untouched, because the trim comes off the end and nowhere else.
 *
 * THE OPENING «¡» NEEDS NO RULE OF ITS OWN: it is before the phrase rather
 * than inside it, so «¡Listo, lo anoté!» still contains the trimmed words.
 */
function unpunctuated(phrase: string): string {
  return phrase.replace(/[.!?…\s]+$/u, "");
}

/** One string, safe to drop into a pattern. */
function escaped(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * The answer as the notice will carry it: every reference that names a
 * customer replaced by the name code renders for it.
 *
 * A REFERENCE THAT NAMES NOBODY IS LEFT STANDING rather than throwing, unlike
 * the renderer's own (`renderNames`). It is already a violation of its own
 * rule, and a guard that threw on it would turn a refusal the model can act
 * on into an exception with no reason attached.
 */
function asRendered(answerText: string, customers: Customers): string {
  return replaceReferences(answerText, (written, reference) => {
    const customer = customers(reference);
    return customer === undefined ? written : phoneName(mentionOf(customer));
  });
}

/**
 * Case- and accent-insensitive, the way a person types a name — the fold
 * `answering.ts` and the drafting contract already use for the same job.
 */
function fold(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

/**
 * The prose as the REP SEES IT, canonically (Codex r2) — `grammar.ts`'s
 * own, because the renderer is what decides what the rep reads.
 */
const asRead = asRepReads;

/**
 * Whether some prose NAMES somebody, as the rep reads it — the chat fold, not
 * a substring (Codex round 1): the words of the name, contiguous and whole,
 * inside the words of the prose, accents and punctuation folded away, and
 * `asRead` first so a zero-width character cannot split a name in two.
 */
function says(prose: string, phrase: string): boolean {
  return mentionsName(asRead(prose), asRead(phrase));
}

/**
 * A NAME TYPED WHERE A REFERENCE STANDS, or nothing (tickets #320, #321;
 * ADR-0037 as amended — "you write the words, you never write a value").
 *
 * THE PROSE RULE, NOT AN IDENTITY GUESS. A customer's name is a value
 * the record holds: code renders it from the reference, unmarked when the rep
 * confirmed it and «(sin confirmar)» when nobody has. A twin that writes
 * «Torres» beside `[c7]` — or anywhere in a text that names c7 — is typing
 * the value code is about to render, and for a chat nobody has confirmed it
 * types the UNMARKED form, telling the rep a chat is theirs when nobody has
 * said so. So the check is against the names of the references the text
 * itself carries, and against nothing else: a name the rep typed and the twin
 * echoes, with no reference behind it, is the twin's words, not a value.
 */
export function typedReferencedName(
  text: string,
  customers: Customers,
): string | undefined {
  const typed = withoutReferences(text);
  for (const reference of referencesIn(text)) {
    const name = customers(reference)?.name;
    if (name !== undefined && fold(asRead(name)).trim() !== "" && says(typed, name)) {
      return name;
    }
  }
  return undefined;
}

/**
 * THE ONE CHECK LEFT ON A REFERENCE (ticket #321; ADR-0013 as amended): the
 * references a text carries that name no row. Each is a value nothing can
 * render, and the reason says what to do instead.
 */
function unresolvedReferences(
  text: string,
  field: string,
  customers: Customers,
): readonly string[] {
  return referencesIn(text)
    .filter((reference) => customers(reference) === undefined)
    .map(
      (reference) =>
        `${field} carries ${writeReference(reference)}, which names no customer: use a reference a tool gave you, or look the customer up by name`,
    );
}

/**
 * WHETHER ANYBODY WROTE THIS TURN, as the turn-aware rule reads it — off the
 * run and never off the words: the model's prose is not evidence of it.
 */
export interface TurnFacts {
  /**
   * Whether nobody wrote this turn: an event or the rep's arrival woke it
   * (ticket #320). Its words rest on the event and on what it was shown —
   * the canvas, what it read — and never on a question the rep asked.
   */
  readonly unasked: boolean;
}

/**
 * What is structurally wrong with the line a turn ended on, as sentences the
 * model can act on — or an empty list: the guard sweeps the twin's final
 * words (ticket #363).
 *
 * A PURE FUNCTION OVER THE WORDS, THE SERVED STATE AND WHO WOKE THE TURN, so the same rules can be shown to bite in a unit suite
 * with no execution around them. THEY ACCUMULATE rather than stopping at the
 * first: the whole list goes back as the refusal, and a model handed one of
 * three problems fixes one of three. SILENCE HAS NOTHING TO CHECK.
 */
export function wordsViolations(
  words: string,
  served: ServedAnswerState,
  turn: TurnFacts,
): readonly string[] {
  if (words.trim() === "") return [];
  return [
    ...proseViolations(words, served),
    // A TURN NOBODY WROTE ANSWERS WITH A LINE ON INICIO (ticket #320), and the
    // line keeps the arrival line's fence.
    ...(turn.unasked ? lineViolations(words, served) : []),
  ];
}

/**
 * THE RULES EVERY LINE THE REP READS OBEYS, whether it answers or asks
 * (ticket #175): it may not be nothing but references, forge a receipt, carry
 * a reference that names nobody, or type a name its own references already
 * name.
 */
function proseViolations(words: string, served: ServedAnswerState): readonly string[] {
  const violations: string[] = [];
  const rendered = asRendered(words, served.customers);

  if (withoutReferences(words).trim() === "") {
    // NOTHING BUT REFERENCES: a name with no sentence around it.
    violations.push("your line is nothing but references: say something around them, or write nothing at all");
  }

  const forged = forgesReceipt(rendered);
  if (forged !== undefined) {
    violations.push(
      `do not write "${forged}": that is the exact line code posts when a tool really performs an act, so writing it yourself would show the rep something that did not happen. Say what you did in your own words, or say nothing about it — the rep is shown the real line automatically`,
    );
  }

  violations.push(...unresolvedReferences(words, "your line", served.customers));

  const typed = typedReferencedName(words, served.customers);
  if (typed !== undefined) {
    violations.push(
      `your line types the name "${typed}" beside the reference that already names them: write only the reference, and code puts in the name the rep knows them by`,
    );
  }

  return violations;
}

/**
 * THE THREAD'S RULE OVER ITS LINE (ticket #363), bound to one turn: the
 * guard's sentences joined as the one refusal the model is handed when it
 * tries to end on words the guard refuses (`ExecutionDefinitionSpec.wordsRule`).
 */
export function threadWordsRule(deps: ThreadDeps): (words: string) => string | undefined {
  return (words) => {
    const violations = wordsViolations(
      words,
      deps.served.state(),
      { unasked: repTriggerOf(deps) === undefined },
    );
    return violations.length === 0 ? undefined : violations.join("; ");
  };
}
