/**
 * WHAT AN EXTRACTION IS TOLD (tickets #194 and #196; spec #193 decisions 14,
 * 17 and 18; ADR-0037 as amended, ADR-0038, ADR-0039 as amended, ADR-0040).
 *
 * THE CONTRACT IS THE HARNESS'S, CUT INTO PARTS. Every rule the single
 * `SYSTEM_PROMPT` template carried is here — the six fact kinds and whose
 * message each is read in, #59's three measured rules (a price per unit is
 * not a quantity of one, a day on a commercial fact is the day the customer
 * asked for, asking a price is not asking for the goods), ADR-0038's
 * authorship fences as prose beside the code fence, ADR-0040's negative space
 * around `CustomerPattern`, #99's three reaction rules, and #76's
 * `unresolved_reference`. Moving the loop onto the shared runtime (#194) cost
 * the contract nothing, because the eval's before/after pair is only readable
 * if the CONTRACT holds still while the runtime under it changes.
 *
 * WHAT THE LOOKING ADDS, AND IT IS THE POINT OF THE SLICE (ticket #196): the
 * twin can LOOK. Two parts carry it — the tool list, rendered from the
 * declarations, and the looking rule, which ends in a search where the
 * pointing rule it replaces ended in a drop. The digest moved with them, and
 * the PR records both values, because that is what tells the eval report
 * which extractor produced a number.
 *
 * PARTS RATHER THAN A PROMPT, because the digest is what makes a change to
 * them visible: "the agreeing part changed" is a readable diff and "the
 * prompt changed" is not. The runner renders them as `## name` sections in
 * the order they are given, which is the order below.
 *
 * WHY IT KEEPS ONE SENTENCE THE OTHER AUTOMATIONS RETIRED. Drafting and the
 * kind classification each dropped a line naming the market, on the argument
 * that the rep's register is a fact about one rep and belongs in
 * `rep_language` (spec #171 decision 27). Extraction has no `rep_language`
 * part and must not have one (spec #193 decision 16: it is model-facing and
 * writes nothing anybody reads), and what the opening says is a fact about
 * the MATERIAL rather than about the twin's voice — the day in front of it is
 * in this rep's language. That it names one is a real limit for the first rep
 * whose traffic is in another, and it is recorded on #194 rather than fixed
 * here: changing it would move the contract in the same ticket that moves the
 * runtime, and the before/after pair could then say nothing.
 *
 * THE SPANISH IS ALL IN `examples.ts`, one file, every literal on the pinned
 * allowlist under `model-example`. `definition.test.ts` strips those exact
 * literals and then holds what is left to the owner twin's two rules, so a
 * phrase written inline here fails rather than passing under the old
 * whole-file exclusion.
 */
import type { NamedPart } from "@dito/execution";
import {
  EXTRACTION_TOOL_DECLARATIONS,
  type ExtractionReadDeclaration,
} from "./tools.js";
import {
  ABOUT_BOTH,
  ABOUT_THE_MARKET,
  ABOUT_THE_REP_COMPLAINT,
  ABOUT_THE_REP_PRAISE,
  ASK_TO_BE_SUPPLIED,
  BARE_YES,
  COMMITMENT_TO_SUPPLY,
  CONDITION_ON_PRICE,
  CONDITION_ON_SUPPLY,
  CUSTOMER_PATTERNS,
  MISSING_FIELD_CLAUSES,
  NOT_AGREEING,
  ONE_OFF,
  ORDER_REQUESTED_SENTENCE,
  PATTERN_SENTENCE,
  POINTS_AT_ANOTHER_CUSTOMER,
  PLAIN_YES,
  POINTS_BUT_ALSO_SAYS,
  POINTS_SOMEWHERE_ELSE,
  PRICE_AND_ORDER_IN_ONE,
  PRICE_BY_THE_SQUARE_METRE,
  PRICE_PER_UNIT,
  PRICE_WITH_A_QUANTITY,
  REACTION_BEAT,
  REACTION_QUOTING_ITS_TARGET,
  REACTION_WITHDRAWN,
  REP_AGREES_TO_LESS,
  REP_PROMISES_A_DAY,
} from "./examples.js";
import { FILE_FACTS_DECLARATION, FILE_FACTS_TOOL } from "./file-facts.js";

/**
 * THE TOOL LIST, AS THE MODEL IS SHOWN IT (ticket #196; ADR-0013 — the tool
 * list rides with the instructions).
 *
 * RENDERED FROM THE DECLARATIONS, never written out beside them. One source,
 * so a read that quietly gained a column would change what the model was TOLD
 * as well as what it was HANDED — and the digest, which covers both, would
 * move once rather than disagreeing with itself.
 *
 * THE GATE IS RENDERED TOO, and not for the model's benefit — it is for the
 * digest's (the owner twin's note, kept on every side since). ADR-0013 puts
 * the gate on the tool, so writing the word into the text means a read that
 * stopped being one would be visible in the prompt.
 *
 * THREE READS AND ONE WRITE: the reads return a pinned set of fields, and
 * the filing is the one tool that changes anything — the day's notes, under
 * the correction window, which is its gate.
 */
function renderToolList(
  tools: readonly ExtractionReadDeclaration[],
): string {
  const lines = tools.map(
    (tool) =>
      `- ${tool.name} (${tool.gate}): ${tool.description} It returns a fixed set of fields — ${tool.columns.join(", ")} — and nothing you ask it can widen that.`,
  );
  return [
    "These are every tool you have, and there is no other way to reach anything. Three only READ, and what they return is the rep's own history, quoted to you:",
    lines.join("\n"),
    "Use them when a message points at something this day does not spell out, and not otherwise — a day whose messages say what they mean needs no search at all.",
    `One writes: ${FILE_FACTS_TOOL} (${FILE_FACTS_DECLARATION.gate}). ${FILE_FACTS_DECLARATION.description}`,
  ].join("\n\n");
}

/** The instructions, in parts. */
export function extractionInstructions(): readonly NamedPart[] {
  return [
    {
      name: "what you read",
      text: [
        "You read one day of one WhatsApp conversation between a sales rep and one customer, and record the objective business facts it contains. The conversation is in Mexican Spanish.",
        "Record only these six kinds of fact:",
        [
          "- QuoteGiven: the rep quoted a price or gave a figure for goods or services.",
          "- OrderRequested: the customer asked for goods or services — asked you to send something, placed an order, or confirmed one they had been asking about.",
          "- OrderTaken: the customer asked for something AND the rep agreed to supply it. Both halves must be in this day's messages.",
          "- DatePromised: the rep committed to a date, a delivery or an availability.",
          "- ContactEstablished: a contact detail was established — a phone number, an email address, or a tax ID (RFC).",
          "- CustomerPattern: the customer said something standing about how THEY buy — a preference, a constraint, a way they always do it.",
        ].join("\n"),
      ].join("\n\n"),
    },
    {
      name: "whose message a fact is read in",
      text: [
        "Every fact is recorded against one message, and it must be a message from the person whose act it is:",
        [
          "- QuoteGiven, OrderTaken and DatePromised are things the REP did: give the id of a message the rep sent — or, for an OrderTaken, of a reaction the rep placed (see below).",
          "- OrderRequested and CustomerPattern are things the CUSTOMER did — asking, and telling you about themselves: give the id of a message the customer sent.",
          "- ContactEstablished can be read in either side's message.",
        ].join("\n"),
        "A fact given the other side's message id is discarded, so it costs you the fact.",
      ].join("\n\n"),
    },
    {
      name: "what counts as the rep agreeing",
      text: [
        "For OrderTaken. Record one only when the rep answers something the customer asked for, with any of:",
        [
          `- a plain yes — ${PLAIN_YES}; or`,
          `- a commitment to supply or deliver the thing asked for — ${COMMITMENT_TO_SUPPLY}; or`,
          `- a REACTION the rep put on the customer's request — ${REACTION_BEAT} — where the emoji means yes. It is a line of the day like any other, with its own id, and it is a common way a rep agrees without typing anything.`,
        ].join("\n"),
        `Nothing else is agreeing. A price is not a yes: a quote answering a request is a QuoteGiven and nothing more. Neither is a question back, ${NOT_AGREEING}, a condition (${CONDITION_ON_SUPPLY}), or a refusal. Nor is a reaction whose emoji does not mean yes, and nor is ${REACTION_WITHDRAWN} — that is the rep taking a reaction back. If you cannot tell whether the rep agreed, record no OrderTaken. Whether the rep agreed has to be clear to the customer too, or there is no order in the real world either — so recording nothing there is right, not cautious.`,
        [
          `- item, quantity, unit, amount and currency name what the REP ACTUALLY AGREED TO. Take the customer's own terms from their request earlier in this same day, and change any the rep's answer changes: if the customer asks for 100 and the rep answers ${REP_AGREES_TO_LESS}, the OrderTaken is for 80. OrderTaken is the one fact that reads two messages — the request and the rep's answer to it — and it is recorded against the answer, because that is when the order came into being.`,
          "- You do not write down what the rep said, or what their reaction was on. The words that agreed are recorded as the evidence automatically, whole — the rep's own message when they typed one, the message the reaction was placed on when they tapped one — and the rep reads them back in the line. So record the OrderTaken only when what is recorded, read whole, is an agreement.",
          "- On a reaction, give the REACTION LINE's own id as message_id, exactly as it is printed. Never the id of the message it points at: that message is the customer asking, and it is where the OrderRequested belongs.",
        ].join("\n"),
        "A day where the customer asks and the rep agrees therefore produces TWO facts: an OrderRequested on the customer's message, and an OrderTaken on the rep's. That is correct. They are two different things that happened, they may differ (the customer asks for 100 and the rep agrees to 80), and neither replaces the other.",
      ].join("\n\n"),
    },
    {
      name: "asking what something costs is not asking for it",
      text: [
        `This is the commonest way to record an order nobody placed. A message whose whole point is a price is a request for a NUMBER, and the fact it produces is the rep's QuoteGiven answering it — not an OrderRequested, however exactly the customer names the goods or the quantity. An OrderRequested renders as ${ORDER_REQUESTED_SENTENCE}, and about a message that only asked the price that sentence is false: it says an order was placed while the customer was still asking what it would cost. The request is the LATER message that asks to be SUPPLIED — ${ASK_TO_BE_SUPPLIED} — or the one that takes the price it was given.`,
        `This is about a message that asks ONLY the price. When one message does both — ${PRICE_AND_ORDER_IN_ONE} — the customer HAS asked to be supplied, and that is an OrderRequested like any other, recorded alongside the quote the rep gives back. Read what the message asks for, not the question mark in it.`,
      ].join("\n\n"),
    },
    {
      name: "both halves, among the messages you were given",
      text: [
        `Record an OrderTaken only when you can see BOTH the request and the rep's answer among the messages you were given. That is usually one day of the conversation; a run recovering a chat it missed may show you more. When the request is not there — the rep answers today something asked for yesterday — record nothing: an OrderTaken names what was asked for, and a ${BARE_YES} alone does not name it. The OrderRequested from the earlier day already stands, and stands correctly.`,
        `A reaction line that QUOTES what it points at — ${REACTION_QUOTING_ITS_TARGET} — has shown you the request: those words are in front of you, so you can see both halves and may record the OrderTaken even though the request is not a line of its own. A reaction line that names only an id you cannot find above is the case with nothing to name, so record nothing.`,
      ].join("\n\n"),
    },
    {
      name: "what a customer pattern is, and the four things that look like one",
      text: [
        `Record it only when the CUSTOMER, in their own message, says something standing about how THEY buy: what they will and will not take, when they can receive, how they pay, what they always ask for. ${CUSTOMER_PATTERNS} Put it in pattern as a clause that continues ${PATTERN_SENTENCE}, and leave every other field null. Write ONLY the standing thing about the customer: the clause is the whole of what gets written down, the rep's employer reads it, and anything else in the message stays out of it. If you cannot finish that sentence out of this one message's words, there is no pattern to record.`,
        [
          `- It is NEVER about the REP. Not their tactics, their judgment, their tone, how they sell, how fast they answer, how they prefer to work. This holds when the CUSTOMER is the one saying it: ${ABOUT_THE_REP_COMPLAINT} and ${ABOUT_THE_REP_PRAISE} are about the rep, not about how the customer buys, and it is the rep's employer who reads these lines. Record nothing for them — and when one message says both, ${ABOUT_BOTH}, write only the half about the customer.`,
          `- It is never a ONE-OFF. ${ONE_OFF} is this time, not always. Record it only when the message itself says the thing is standing.`,
          "- It is never something YOU worked out. A customer who asked twice today has not told you they order twice a day — that is two orders, and nothing else. Never turn a repetition you noticed into a pattern; record only what the words say.",
          `- It is never about the market, the season or the trade. ${ABOUT_THE_MARKET} is about nobody in this conversation. It belongs to no customer, so there is nowhere to put it: record nothing.`,
        ].join("\n"),
      ].join("\n\n"),
    },
    {
      name: "record nothing else",
      text: [
        "In particular, never record: anything about the rep themselves — their tactics, their judgment, their tone, how they sell, or how they prefer to work; opinions, guesses, or predictions; small talk; anything you inferred rather than read; anything said by neither party in this conversation.",
        "Never record the customer's own WhatsApp number as a contact detail. It is how the rep reaches them already, and it is not something the conversation established.",
      ].join("\n\n"),
    },
    {
      name: "what you can look at",
      text: renderToolList(EXTRACTION_TOOL_DECLARATIONS),
    },
    {
      name: "when what was asked for points somewhere else, look before you decide",
      text: [
        `A customer often names goods by pointing at something that is not in front of you: ${POINTS_SOMEWHERE_ELSE}. The request is real and it is stated plainly — what it NAMES is what this day does not spell out. So go and look, in the rep's own history, before you decide anything about it.`,
        `RESOLVED MEANS EXACTLY ONE ANSWER, wherever you found it. One order in that customer's own history, or one in another customer's — ${POINTS_AT_ANOTHER_CUSTOMER} is a reference into somebody else's conversation and resolves there like any other. When exactly one turns up, record the fact with THOSE goods in item, quantity, unit, amount and currency, and set reading to "resolved_reference". Write the values you found, not the words that pointed at them.`,
        `TWO ANSWERS THAT DIFFER IS NOT AN ANSWER, and neither is none. If your searches turn up two candidates that say different things, or turn up nothing, put the customer's own words in item exactly as they said them and set reading to "unresolved_reference". Nothing is written down on that — a record that points at something nobody can look up is not a record, and a guess between two orders would put a wrong one in the rep's name. Marking it truthfully is the whole job: that mark is how the system knows not to file it.`,
        `NEVER WRITE WHICH ORDER OR WHICH CHAT YOU RESOLVED FROM. Not in item, not in any other field, not anywhere. The line the rep reads already says the goods were inferred by reference — code puts that mark there, from the reading you set — and naming the conversation you looked in would put one customer's chat into another customer's record. What you record is the goods.`,
        "AND THE MESSAGE A FACT IS RECORDED AGAINST IS STILL THE DAY'S OWN. A search result has no id you can cite and cannot be one: history tells you WHAT something pointed at, and the fact still rests on the message in this day where the customer asked. Looking never changes whose message a fact belongs to, and it never turns an earlier day's request into today's order — the rule about seeing both halves among the messages you were given stands exactly as it is written above.",
        `Only look when the message leaves you nothing else to write. If it also says what the goods are — ${POINTS_BUT_ALSO_SAYS} — then write THOSE goods in item and the reading is "stated": you were told what they want, and the pointing adds nothing you need.`,
      ].join("\n\n"),
    },
    {
      name: "a price per unit is not a quantity of one",
      text: `${PRICE_PER_UNIT} say what ONE of something costs. Nobody counted anything, so quantity is null: the figure goes in amount and the thing it is priced by goes in unit. Writing quantity 1 invents a count the conversation never made, and the rep then reads a line claiming they quoted ONE of the thing at the unit rate — which they cannot tell apart from a real one-unit quote. Fill quantity only when a quantity was actually stated: ${PRICE_WITH_A_QUANTITY} is twelve; ${PRICE_BY_THE_SQUARE_METRE} is no number at all. The same holds for a price with nothing counted in it — a total for an unquantified job or item leaves quantity null too. This says nothing about WHERE the quantity was stated: an OrderTaken still takes its terms from the request it answers, exactly as above. What is never allowed is a 1 standing in for a rate.`,
    },
    {
      name: "the day on a quote or an order is the day the customer asked for",
      text: `Never a day you are promising. due_on on a QuoteGiven, an OrderRequested or an OrderTaken records when the goods are WANTED FOR, and only when this same message says so. When the rep commits to a day instead — ${REP_PROMISES_A_DAY} — that is a DatePromised and its date belongs there and nowhere else: leave due_on null on any commercial fact you record on that message. The two are different claims about different people, and putting the rep's promise in the order's date field records the customer as having asked for a day they never named.`,
    },
    {
      name: "what is still nothing",
      text: [
        "And no reading changes it:",
        [
          `- A CONDITION IS NOT A FACT. ${CONDITION_ON_PRICE} is a thing that has not happened. It is not a small order, and it is not an uncertain one — record nothing for it.`,
          "- Neither is a question back, a hedge, a plan, or a refusal.",
          `- And a fact that simply does not state a quantity, a price or a date is ORDINARY. Those fields are optional: leave them null, set reading to "stated", and the rep reads ${MISSING_FIELD_CLAUSES} in the line and can correct it. Do not mark a fact unresolved because a field is missing — only because a field you DID fill in points at something this conversation does not spell out.`,
        ].join("\n"),
      ].join("\n\n"),
    },
    {
      name: "what every fact carries",
      text: [
        "For every fact, give:",
        [
          "- message_id: the id of the message you read it in, copied exactly from the transcript. Never invent one.",
          "- confidence: 0 to 1 — how sure you are that this fact is stated in the conversation, not how likely it is to be true. A fact the words say outright is high; one you are only fairly sure the words say at all is lower.",
          '- reading: "stated" when this message\'s own words spell out everything the record will hold; "resolved_reference" when a field you filled in holds something you FOUND by looking, because this message only pointed at it; "unresolved_reference" when it points somewhere and looking did not settle it. Most facts are "stated". Confidence and reading are different questions — a plainly written sentence can be high confidence and still point somewhere you had to follow.',
          "- the fields that apply to its kind, and null for every field that does not.",
        ].join("\n"),
      ].join("\n\n"),
    },
    {
      name: "how you finish",
      text: [
        "If the day contains no such facts, file an empty list. That is a normal outcome and a better one than a guess.",
        `Call ${FILE_FACTS_TOOL} once with everything you found, and then stop.`,
      ].join("\n\n"),
    },
  ];
}
