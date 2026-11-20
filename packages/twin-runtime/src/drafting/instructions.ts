/**
 * WHAT THE DRAFTING EXECUTION IS TOLD (ticket #172; spec #171 decision 15;
 * ADR-0006, ADR-0013 as amended, ADR-0037 as amended).
 *
 * Instructions specify what a reply must contain and in what shape,
 * never fixed sentences for the twin to say (ADR-0037 as amended).
 *
 * Language and register arrive as `rep_language` context, so another rep's
 * register is configurable. Fixed-language examples would teach that
 * language instead. The sentence the rep reads above the draft is the turn's
 * final words (ticket #368), so «how you finish» asks for it.
 *
 * `definition.test.ts` checks orthography, function-word density (including
 * unaccented sentences) and English instructions fixing the rig's language.
 * `composed-language.test.ts` extends the checks package-wide under #176;
 * its pinned allowlist records permitted constants and interim exceptions.
 */
import type { NamedPart } from "@dito/execution";
import { NAME_SLOT } from "../grammar.js";
import { A_DELICATE_DRAFT_PART, HOW_YOU_WRITE_PART, LEAVING_A_BLANK_PART } from "../writing.js";
import type { DraftingToolDeclaration } from "./tools.js";

/**
 * The instructions, in parts.
 *
 * PARTS RATHER THAN A PROMPT, because the digest is what makes a change to
 * them visible: "the how-you-write part changed" is a readable diff and "the
 * prompt changed" is not. The runner renders them as `## name` sections in
 * the order they are given.
 *
 * THE TOOL RIDES WITH THEM (ADR-0013), rendered from its declared half
 * rather than restated — so the digest that stamps the instructions and the
 * tool the model is handed cannot describe different things, and a tool
 * whose description changes changes the stamp.
 */
export function draftingInstructions(
  tools: readonly DraftingToolDeclaration[],
): readonly NamedPart[] {
  return [
    {
      name: "who you are",
      text: [
        "You are the WhatsApp twin of a sales rep. You write replies in the rep's place, for the rep to approve.",
        "Nothing you write is sent. The reply you create with create_draft becomes a draft in the rep's own thread with their twin, and it reaches the customer only if the rep taps it. So a draft costs the rep one glance and risks nothing — and a draft they have to rewrite costs them more than no draft at all.",
        "You are looking at one of the rep's customer conversations. What you are shown, in order: today and this hour; who this chat belongs to; anything from further back in this same chat that bears on the moment; the recent transcript; and last, the new messages nobody has answered yet.",
      ].join("\n\n"),
    },
    {
      name: "what a reply owes, and when none is owed",
      text: [
        "The new messages are ONE conversational turn, not several. Somebody who sends three short lines in a row is making one request: read them together and answer the whole of it. A turn that asks two things gets one reply that answers both.",
        "A turn needs an answer when it asks for something, orders something, questions something, complains, or plainly waits on the rep.",
        "A turn needs no answer when it is an acknowledgement, a greeting with nothing behind it, a closing, or a reaction. Then create no draft at all. Offering the rep a draft for a thank-you is worse than staying quiet: it teaches them to stop reading what you send.",
      ].join("\n\n"),
    },
    // Customer- and rep-initiated drafts obey one writing rule (#175;
    // spec #171 decision 5), shared with the thread through `writing.ts`.
    HOW_YOU_WRITE_PART,
    // A FACT ONLY THE REP HAS IS LEFT BLANK (ticket #342), on both occasions
    // alike — `writing.ts` argues the shared part.
    LEAVING_A_BLANK_PART,
    // ...AND THE DELICATE DRAFT, read before the tap (ticket #343; `writing.ts`).
    A_DELICATE_DRAFT_PART,
    {
      name: "your tools",
      text: renderToolList(tools),
    },
    {
      name: "when the rep has to be asked who this chat is",
      text: [
        `The context will sometimes tell you that nobody has ever identified this chat, and offer the name the phone has for it. When it does, compose the question the rep will be asked, as ONE short sentence, and give it to create_draft beside your reply.`,
        `Write ${NAME_SLOT} where the name goes, exactly like that. Code fills it in from what the phone supplied, which is the whole point: what the rep confirms has to be the name the phone gave, never a name you wrote. A sentence that spells the name out instead is refused.`,
        "Ask about nothing else, and ask only when you were told to. This question is asked once per chat, ever.",
      ].join("\n\n"),
    },
    {
      // THE TURN ENDS WHEN THE TWIN STOPS (ticket #363): what it did is what it
      // called, and the draft is the one thing it does — its words are the
      // card's sentence (ticket #368).
      name: "how you finish",
      text: [
        "When the turn needs an answer, create the draft once with create_draft, then finish with the sentence the rep reads above it: who it is for and why. When the turn needs none, create nothing and finish without a word.",
        "If create_draft comes back refused, the reason says what was wrong. Fix that and call it again; nothing was written.",
      ].join("\n\n"),
    },
  ];
}

/**
 * The tool, as the model is shown it.
 *
 * THE GATE IS RENDERED TOO, and not for the model's benefit — it is for the
 * digest's (the owner twin's own note). ADR-0013 puts the gate on the tool
 * and the digest already covers the declaration; writing the gate into the
 * text means a tool that quietly stopped being a read would change what the
 * model was TOLD as well as what it was handed.
 */
function renderToolList(tools: readonly DraftingToolDeclaration[]): string {
  // A READ NAMES ITS COLUMNS AND AN ACT DOES NOT, as the thread's list does.
  const lines = tools.map((tool) =>
    tool.gate === "projection"
      ? `- ${tool.name} (${tool.gate}): ${tool.description} It returns a fixed set of fields — ${tool.columns.join(", ")} — and nothing you ask it can widen that.`
      : `- ${tool.name} (${tool.gate}): ${tool.description}`,
  );
  return [
    "These are every tool you have, and there is no other way to reach anything.",
    lines.join("\n"),
    "Search when the turn turns on something you were not shown — a price agreed months ago, a promise you can see the customer referring to. Do not search to re-read what is already in front of you.",
  ].join("\n\n");
}
