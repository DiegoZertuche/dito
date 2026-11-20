/**
 * THE LINE ON INICIO, AS THE TWIN THREAD WRITES IT (ticket #320; spec #258
 * decision 15; ADR-0044 as amended; design D4).
 *
 * A turn nobody wrote — the rep's arrival, or an event — answers with a line
 * delivered to the dashboard alone: under the greeting for an arrival, in
 * the bar for an event (ticket #339). It is the arrival line's kind, and it
 * keeps that kind's fence: a bound, one line, no web address, and no number
 * that is not in what the turn was shown. A customer's name typed out is the
 * guard's rule for every post (`guard.ts`), and a customer is named by their
 * reference like everywhere else.
 *
 * EVERY REFUSAL IS FEEDBACK, as the guard's are: the model is handed the
 * reason and may write the line again inside its budget, and a turn that
 * still ends on a refused line ends `failed` — no line, and the page's
 * fallback stands.
 */
import { carriesLink, ungroundedNumberIn } from "../posts.js";
import type { ServedAnswerState } from "./served.js";
import { unmarked, withoutReferences } from "./references.js";

/**
 * The longest the line may be, in characters.
 *
 * TWO HUNDRED AND FORTY: the prototype's longest welcome is 118 and its
 * longest return line 139, and the welcome's line runs 640 px wide at 16.5 px
 * — about eighty characters a row — so 240 is three rows, the most a line
 * under a greeting can take before it reads as a paragraph. A bound, not a
 * target.
 */
export const LINE_MAX = 240;

/** Why a line cannot be put on Inicio, or nothing. */
export function lineViolations(
  line: string,
  served: ServedAnswerState,
): readonly string[] {
  const violations: string[] = [];
  // A MARK'S CARD IS NEVER READ BY THE REP (ticket #401): the bound
  // counts what they read.
  if ([...unmarked(line)].length > LINE_MAX) {
    violations.push(`your line is one line on the rep's dashboard, at most ${String(LINE_MAX)} characters`);
  }
  if (line.includes("\n")) {
    violations.push("your line is one line, with no line break");
  }
  if (carriesLink(line)) {
    violations.push("your line carries no web address — the rep is already on the page");
  }
  const invented = ungroundedNumberIn(withoutReferences(line), served.grounds.join("\n"));
  if (invented !== undefined) {
    violations.push(
      `the number ${invented} is not in anything you were shown this turn — say only what is in front of you`,
    );
  }
  return violations;
}
