/**
 * WHAT THE KIND CLASSIFICATION IS TOLD (ticket #176; spec #171 decisions 26
 * and 27; ADR-0035, ADR-0037 as amended).
 *
 * NOT ONE SENTENCE HERE IS A SENTENCE THE TWIN SAYS, and nothing here is
 * written in the language the rep reads. This automation never speaks to
 * anybody — its whole output is one word out of two — so the rule is easy to
 * keep and worth stating anyway: `definition.test.ts` holds this file to the
 * owner twin's two rules (the orthography, and the function-word density that
 * catches a sentence written without its accents), the same way the drafting
 * and thread instructions are held.
 *
 * TWO THINGS THE HARNESS'S PROMPT HELD AND THIS DOES NOT (spec #171 decision
 * 27, which retired the drafting prompt's for the same reason).
 *
 * THE SPANISH PROPER-NOUN EXAMPLES ARE GONE. The harness taught the
 * distinction by quoting seven names — four businesses, a sentence about
 * somebody buying for a company, and two people — and every one of them was
 * Spanish. A prompt that teaches by quoting one language teaches that
 * language: it tells the model what a business is called HERE, which is a
 * fact about this rig's customers rather than about the two words it has to
 * choose between, and it would have to be rewritten for the first rep whose
 * customers are named differently. What replaces them is the DEFINITION —
 * company, shop, workshop, contractor, institution — which is what the
 * examples were illustrating and which travels.
 *
 * AND THE RIG LINE WITH THEM. "one customer of a Mexican sales rep" named
 * the market in the one place nobody looks, exactly as drafting's "this
 * rig's traffic is Mexican Spanish" did. The rep's language is a fact about
 * one rep (`rep_language`), and this automation does not need it: it reads
 * whatever the conversation is in and answers in neither.
 *
 * THE MODEL AND THE RUNG ARE NOT NAMED EITHER, here or anywhere in the spec
 * — ADR-0015 routes at the app boundary, and `kindModelOf` is the one
 * resolver (`consumer.ts`).
 */
import type { NamedPart } from "@dito/execution";

/**
 * The instructions, in parts.
 *
 * PARTS RATHER THAN A PROMPT, because the digest is what makes a change to
 * them visible: "the how-you-tell-them-apart part changed" is a readable diff
 * and "the prompt changed" is not. The runner renders them as `## name`
 * sections in the order they are given.
 *
 * NO TOOL LIST, because there are no tools. The drafting and thread
 * instructions render one from the declarations they are handed; an empty
 * list rendered under a heading would tell the model about an absence it has
 * no use for.
 */
export function entityKindInstructions(): readonly NamedPart[] {
  return [
    {
      name: "what you decide",
      text: [
        "You decide one thing about one customer of a sales rep: is this customer a PERSON or a BUSINESS?",
        "You will be given the customer's name as the rep confirmed it — usually their profile name on the messaging app — and, when there is one, the conversation the rep has had with them.",
      ].join("\n\n"),
    },
    {
      name: "what tells the two apart",
      text: [
        "A BUSINESS is a company, a shop, a workshop, a contractor or an institution. Somebody writing on behalf of one — an employee placing an order for the company they work for, and saying so — is that COMPANY as a customer: many people at one business message one rep, and they are one customer.",
        "A PERSON is an individual buying for themselves.",
        "The name usually settles it. Use the conversation when it does not — what they buy, how much, who they say they are, whether they speak for somebody else.",
      ].join("\n\n"),
    },
    {
      name: "you must choose one",
      text: [
        'You must choose one of the two. There is no "unsure": say which is more likely and say it plainly.',
        "A wrong answer is correctable — a person can change it, and once they have, nothing you say later overrules them. No answer is not correctable: it leaves the customer unrecorded.",
      ].join("\n\n"),
    },
    {
      name: "how you finish",
      text: "Your turn ends with your decision as its result: the kind, one of the two words, and nothing else.",
    },
  ];
}
