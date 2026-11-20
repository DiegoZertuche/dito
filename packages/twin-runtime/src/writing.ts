/**
 * HOW A DRAFT IS WRITTEN — ONE CONSTANT, TWO AUTOMATIONS (ticket #175; spec
 * #171 decision 5: "the drafting instruction parts are shared registry
 * parts, so a rep-requested draft is written under the same rules as a
 * customer-triggered one"; ADR-0037 as amended).
 *
 * A draft the rep asked for and a draft a customer's turn produced are the
 * same object — the same row, the same Borrador, the same tap — so they had
 * better be written under the same rules. This is that rule set, as the
 * named part both drafting's instructions and the thread's include VERBATIM
 * (`runs/shipped-conversations.ts`): one value, two definitions, and a
 * change to the words changes both digests at once.
 *
 * ONE PART AND NOT TWO, and the boundary is worth saying out loud. Drafting
 * also carries «what a reply owes, and when none is owed» — read three
 * short lines as ONE turn, answer a request, stay quiet on a thank-you —
 * and not a sentence of it applies here: the twin is not judging whether a
 * reply is owed, because the REP already decided that by asking. Sharing it
 * would put a judgement about customer turns into a turn that has no
 * customer turn in front of it, which is how a shared prompt starts drifting
 * from what either side actually does.
 *
 * ONE TEXT ON PURPOSE. `drafting/definition.test.ts` pins the drafting
 * digest: a rep-initiated draft is a new occasion, not a new way of writing,
 * so a change here moves both digests at once. The sentence the rep reads
 * above a draft is the turn's final words on both occasions (ticket #368).
 */
import type { NamedPart } from "@dito/execution";
import { draftBlankMarker } from "@dito/seam";

/**
 * The one part that governs how a draft is written, whoever asked for it.
 *
 * Its own name is what the runner renders as the `## how you write` heading
 * in both prompts, which is also how a reader of two digests can see that
 * the same part is in both.
 */
export const HOW_YOU_WRITE_PART: NamedPart = Object.freeze({
  name: "how you write",
  text: [
    "Short. One WhatsApp message, not a letter, and never longer than the thing it answers deserves.",
    "In the language the conversation itself is in, and in the register you were told this rep writes in. Both are facts you were given, not choices — read them and match them.",
    "Commit only to what the record in front of you supports. A price, a date, a quantity or an availability that nobody in this conversation has stated is not yours to state: have the draft ASK instead. A draft that asks is a draft the rep can send; a draft that invents is one they have to catch.",
    "Once the draft is written, what you finish your turn with is the sentence the rep reads above it, in the rep's own language and register: who it is for — the customer by their reference, so code writes their name — and why it exists, what was asked or what was left unanswered. One or two sentences, for the rep and not for the customer.",
  ].join("\n\n"),
});

/**
 * WHEN A FACT IS THE REP'S TO GIVE — THE BLANK, ONE CONSTANT, TWO AUTOMATIONS
 * (ticket #342; spec #318; the spine's movement 8, «Me falta un dato»).
 *
 * Both occasions write a draft and both calls take the same `blanks`
 * field (`blanks.ts`), so the rule for leaving one is shared the way
 * `HOW_YOU_WRITE_PART` is: one value in both specs, so the two cannot drift.
 * Its own part rather than a sentence in that one, because that one's digest
 * is the statement that customer- and rep-initiated drafts are WRITTEN alike,
 * and this is a new thing a draft may carry rather than a new way of writing.
 *
 * WHAT IT TELLS THE TWIN, and nothing else: a blank is for a fact only the rep
 * has, never for one it could read or look up, and never for one the customer
 * owes — that one the draft still asks them; and a draft with a blank cannot
 * go out until the rep fills it. Whether a fact is one is the twin's call.
 */
export const LEAVING_A_BLANK_PART: NamedPart = Object.freeze({
  name: "when a fact is the rep's to give",
  text: [
    "Sometimes the reply turns on one fact only the rep has — the price they will give this customer, the hour they can deliver — and nothing you were shown or can look up says it. Do not guess it: leave a blank where it goes, and declare the blank beside the draft — its key, one or two words of what is missing, and the one question you would ask the rep for it, with what you already know that helps them answer.",
    `A blank stands in the text as ${draftBlankMarker("key")} — its key between those two brackets — once, exactly where the fact goes. It is for a fact only the rep has: never for something you could read or look up, and never for something the customer owes you, which the draft still asks them.`,
    "A draft with a blank cannot go out until the rep fills it. They are asked your question, they answer in their own words, and you fill the blank from what they said.",
  ].join("\n\n"),
});

/**
 * WHEN A DRAFT COMMITS THE REP — THE DELICATE DRAFT AND ITS REASON, ONE
 * CONSTANT, TWO AUTOMATIONS (ticket #343; spec #318; the spine's movement 11,
 * «Antes de que la mandes»).
 *
 * Both calls take the same `delicate` and `reason` fields
 * (`delicacy.ts`), so the rule for marking a draft is shared the way the
 * blank's is: one value in both specs. Its own part, for the blank's reason:
 * a new thing a draft may carry, never a new way of writing one.
 *
 * WHAT IT TELLS THE TWIN, and nothing else: what makes a draft delicate — the
 * ticket's three, as examples of a commitment and never a closed list, the
 * judgement being the twin's — and what the reason is for: the rep reads it
 * just before the tap, after a few words code renders.
 */
export const A_DELICATE_DRAFT_PART: NamedPart = Object.freeze({
  name: "when a draft commits the rep",
  text: [
    "Some drafts commit the rep to something they would want to weigh before it goes out: a price below their list, a delivery date, an apology. Those are examples of a commitment, not the whole list — whether a draft is one is your judgement.",
    "Mark such a draft delicate, and beside it write its reason: what you decided in the draft and why, in the rep's language, in two sentences at most. The rep reads it just before they tap to send, under a few words code renders saying the draft is about to go — so begin with what you decided, with the figure or the date as the draft has it, then why. Whether it goes is theirs to decide, by the tap.",
    "Write the reason as it will read when the draft goes out: a draft that also leaves a blank is sent only once the rep fills it, so the reason speaks of what you decided, never of the blank.",
    "A draft that commits the rep to nothing — a question back, a fact read from the record, a thank-you — is plain: it carries neither the mark nor a reason.",
  ].join("\n\n"),
});
