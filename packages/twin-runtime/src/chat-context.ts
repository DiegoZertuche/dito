/**
 * TWO CONTEXT RECIPES TWO AUTOMATIONS SHARE (ticket #194; spec #193 decision
 * 16; the shape `rep-language.ts` established at #173).
 *
 * Drafting and extraction are both handed one customer chat, and both are
 * told the same two things about it: who it belongs to, and what was said
 * before the part they have to act on. The NAMES live here so a spec's
 * `chat_binding` means one recipe wherever it is written, and the transcript
 * PART lives here so the two are shown one rendering — the hazard
 * `@dito/execution`'s README states about `renderTurnInstant`, "a test proving
 * two copies agree today is not the same claim as there being one".
 *
 * WHAT IS SHARED AND WHAT IS NOT, said plainly because the asymmetry is
 * deliberate. `recent_transcript` is shared WHOLE: its sentences say what the
 * block is and how to read it, and neither says what the reader is doing with
 * it, so drafting's bytes are unchanged and extraction's are the same bytes.
 * `chat_binding` is shared as a NAME only, and each automation renders its
 * own: drafting's first sentence is «You are drafting for the rep's
 * conversation with …», which is false of a pass that writes nothing — and
 * what the two really have in common is the confirmed/unconfirmed
 * distinction, which is one clause rather than a part. Registries stay per
 * automation (that is the safety, `registry.ts`); the digest covers the
 * recipe's NAME and parameter shape and never its rendered text, so a spec
 * that names `chat_binding` says the same thing on both sides.
 */
import type { ConversationRow } from "@dito/bundle";
import type { NamedPart } from "@dito/execution";
import { renderTranscriptLines } from "./drafting/lines.js";

/** Who this chat belongs to, and whether anybody has said so. */
export const CHAT_BINDING_RECIPE = "chat_binding";

/** What was said before the part this execution has to act on. */
export const RECENT_TRANSCRIPT_RECIPE = "recent_transcript";

/**
 * WHAT WAS SAID BEFORE, AND IS ALREADY DEALT WITH (spec #171 decision 15;
 * spec #193 decision 16).
 *
 * THE ROWS IT ACTS ON ARE NOT HERE. Drafting removes the turn's own messages
 * before handing the window over and extraction removes the day's, because a
 * message standing under both this heading and the new one is exactly the
 * conflation #75's AC 3 forbids — the model would read the thing it has to
 * act on as something already handled.
 *
 * IT MAY HOLD TRAFFIC NEWER THAN THAT, and the model is told: delivery can be
 * out of order, so the window is what twin memory holds and the new material
 * is what is unhandled, and neither is a claim about which came last.
 *
 * EVERY PART SAYS WHEN IT HAS NOTHING, rather than vanishing. The harness
 * omitted this block when it was empty, so a model shown neither could not
 * tell "this chat has no history" from "nobody looked".
 */
export function recentTranscriptPart(
  rows: readonly ConversationRow[],
): NamedPart {
  return {
    name: "recent transcript",
    text:
      rows.length === 0
        ? "This chat has nothing before the messages below: they are the first thing twin memory holds for it."
        : `Transcript (context, already handled):\n${renderTranscriptLines(rows)}\n\nEverything above has been dealt with and is context only. It may even hold messages sent after the ones below, because delivery can be out of order.`,
  };
}
