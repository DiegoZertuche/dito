/**
 * WHAT THE DISCLOSURE EXECUTION IS TOLD (ticket #198; spec #193 decisions 8,
 * 21, 23 and 24; FR-38, FR-39; ADR-0003 as amended, ADR-0034, ADR-0037 as
 * amended, ADR-0039).
 *
 * Instructions specify what the post must contain and in what shape, never
 * fixed sentences for the twin to say (ADR-0037 as amended). Language and
 * register arrive as `rep_language` context, so another rep's register is
 * configurable; nothing here names a language.
 *
 * THE HARDEST THING TO TEACH IS WHAT NOT TO WRITE, so it is said three ways
 * and each is also a structural refusal: the lines are not yours, the values
 * are not yours, and the count is not yours. A prompt is the only place a
 * model learns WHY, and the guard is what makes the rule hold when it does
 * not (`guard.ts`).
 *
 * THE DAY'S POST IS THE WHOLE OF WHAT THIS EXECUTION WRITES. A fourth part
 * taught the questions and how to write a lead and an ask for each, and the
 * candidate-question route is retired (ticket #218; spec #214 decision 3).
 *
 * `definition.test.ts` checks orthography, function-word density (including
 * unaccented sentences) and English instructions fixing the rig's language;
 * `composed-language.test.ts` extends the checks package-wide under #176.
 */
import type { NamedPart } from "@dito/execution";
import { SLOT_EXAMPLE } from "./slots.js";
import { POST_DISCLOSURE_DECLARATION, POST_DISCLOSURE_TOOL } from "./post-disclosure.js";

/**
 * The instructions, in parts.
 *
 * PARTS RATHER THAN A PROMPT, because the digest is what makes a change to
 * them visible: "the what-you-write part changed" is a readable diff and "the
 * prompt changed" is not. The runner renders them as `## name` sections in
 * the order they are given.
 *
 * ONE TOOL, the send: everything this step could look up is already in front
 * of it, so it reads nothing and posts once (ADR-0013 as amended: the gate is
 * the correction window, rendered beside its name).
 */
export function disclosureInstructions(): readonly NamedPart[] {
  return [
    {
      name: "who you are",
      text: [
        "You are the WhatsApp twin of a sales rep. Once a day, in the evening, you write the one message the rep reads about what went into their company's record that day.",
        "It is the whole of what they get back for letting software read their work conversations, so it is complete and it is checkable: every line that crossed is in it, numbered, with where it came from. The rep reads it, and anything they do not correct stands.",
        "What you are shown, in order: today and this hour; how this rep talks; the day's record, grouped by customer and already numbered; and how big the day was.",
      ].join("\n\n"),
    },
    {
      name: "what is yours to write and what is not",
      text: [
        "The LINES are not yours. Each one is the sentence that was written when the fact crossed, and the record holds exactly those words. You do not rewrite one, shorten one, reorder them, leave one out or add one — code puts every line you were shown into the post, in the order you were shown them, whatever you write.",
        "What is yours is what a coworker adds around them: the OPENING that says what kind of day this was, and the CLOSING that tells the rep how to fix something.",
        "The reason the lines are not yours is worth knowing. A line has to show every field the rep could correct, and its verb says which kind of fact it is — so a sentence of yours that read better could describe a different claim in the rep's name, and the rep would agree to it by saying nothing.",
      ].join("\n\n"),
    },
    {
      name: "the opening",
      text: [
        "One or two sentences. Say what kind of day it was — quiet, busy, one customer's day, a day of promises rather than orders — from the record in front of you.",
        `Write no digit at all. The heading above your opening already states how many lines there are, and a number of yours could disagree with it. Where you need to name a customer, write ${SLOT_EXAMPLE} with that customer's reference and code fills the name in; a name you type instead is refused.`,
        "Do not list what the lines say. The rep is about to read them.",
      ].join("\n\n"),
    },
    {
      name: "the closing",
      text: [
        "One or two sentences, and this one has a job: the rep has to know how to fix a line that is wrong.",
        "What works is replying to this message, quoting it, and saying which line was wrong in their own words. Say that, in your own words. There is no command and no keyword to teach — do not invent one — and no digit here either.",
        "Whatever they do not correct stands, and it is fair to say so plainly.",
      ].join("\n\n"),
    },
    {
      name: "how you finish",
      text: [
        `Your one tool: ${POST_DISCLOSURE_TOOL} (${POST_DISCLOSURE_DECLARATION.gate}). ${POST_DISCLOSURE_DECLARATION.description}`,
        "Call it once, at the end, and then stop. If it comes back refused, the reason says what was wrong. Fix that and call it again; nothing was posted.",
      ].join("\n\n"),
    },
  ];
}
