/**
 * THE EVENING'S SCRIPTED TURN (ticket #198).
 *
 * The daily disclosure is an automation now, so every suite that posts a day
 * scripts what the twin composed around the day's lines. Most of them are not
 * ABOUT the composition — the corrections suite is about a retraction, the
 * audit suite about a chain entry — and they need one honest submission
 * whatever the fixture happens to have filed. This is that submission.
 *
 * IT READS NOTHING OUT OF THE PROMPT (ticket #218). A day's submission is
 * the same two sentences whatever the fixture filed: the candidate-question
 * route is retired (spec #214 decision 3), so there is nothing per-fixture to
 * count. The PARAMETER stays because `scriptedModel`'s rule form is what
 * every caller passes this as — the rule form is why it took a prompt at all,
 * when the questions waiting on the rep varied per fixture.
 *
 * THE PROSE IS DELIBERATELY PLAIN, and it satisfies the structural guard by
 * being what a coworker would write: no digit anywhere, no customer's name,
 * no slot. A suite whose claim IS the composition writes its own submission
 * with `disclosureTurns` instead — including the ones that must be REFUSED.
 */
import { disclosureTurns, type ScriptedTurn } from "@dito/scripted-model";

/** What a coworker writes around the day's own lines. */
const OPENING = "fue un día tranquilo, casi todo de un solo cliente";
const CLOSING =
  "si algo quedó mal respóndeme aquí citando este mensaje y dime cuál";

/**
 * One day's disclosure.
 *
 * Pass it to `scriptedModel` as the rule rather than calling it: the wire
 * hands it each conversation's first user turn, and a suite that called it
 * itself would be guessing at the prompt it is answering.
 */
export function composedDisclosure(_prompt: string): ScriptedTurn[] {
  return disclosureTurns({ opening: OPENING, closing: CLOSING });
}
