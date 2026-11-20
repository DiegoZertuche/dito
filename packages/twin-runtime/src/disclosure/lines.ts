/**
 * THE DAY, AS THE DISCLOSURE EXECUTION READS IT (ticket #198; spec #193
 * decision 22).
 *
 * EXACTLY WHAT CODE WILL RENDER, which is the decision's own words and the
 * reason these blocks are not a summary. The model is composing an opening
 * about a day and a lead about a claim; if it were shown a paraphrase it
 * would be writing about something the rep will not read. So the line text is
 * the aperture's stored bytes, the number is the one `disclosure_post_lines`
 * will record, and the provenance clause comes from the grammar's own
 * renderer (`renderDisclosureProvenance`) rather than from a second
 * formatter here.
 *
 * ENGLISH FRAMING AROUND SPANISH CONTENT, the shape every recipe in this
 * repo keeps (#143's ruling): what code writes into a turn is metadata a
 * model reads, and the only Spanish in these blocks is the rep's own record
 * quoted back. That is also what lets the composed-language sweep hold this
 * file to the same rule as every other source — there is no es-MX literal in
 * it to exempt.
 *
 * EVERY BLOCK SAYS WHEN IT HAS NOTHING rather than vanishing, the rule the
 * drafting recipes argue: a model shown no block at all could not tell "there
 * is nothing here" from "nobody looked".
 */
import { servedCounterparty, type DisclosureDeps, type ServedGroup } from "./deps.js";

/** How a reference is written wherever the model reads or writes one. */
function ref(at: number): string {
  return `[[${at}]]`;
}

/**
 * THE DAY'S RECORD: the groups, their customers and their numbered lines.
 *
 * THE NUMBERS ARE CONTINUOUS ACROSS THE WHOLE POST and the block shows them
 * that way, because that is what the rep reads down the page and what a
 * correction names (spec #48 decision 14). A per-group numbering shown here
 * would invite an opening that talked about «los tres de Torres» when the
 * post says 4, 5 and 6.
 */
export function renderRecordBlock(deps: DisclosureDeps): string {
  if (deps.groups.length === 0) {
    // NO PASS REACHES THIS, and the unit seam does: a day with no pending
    // line owes nothing, so `readTheDay` creates no execution — while
    // `definition.test.ts` renders this block over `groups: []` directly,
    // because the rule above is what the branch is for. A block that vanished
    // would leave a model composing an opening with no idea whether it had
    // been shown the day.
    return "Nothing crossed into the record today, so the post carries no lines.";
  }
  return [
    "The day's record, grouped by customer and numbered exactly as the post will number them. Every line below goes into the post as it stands, in this order:",
    deps.groups.map((group) => renderGroup(deps, group)).join("\n\n"),
  ].join("\n\n");
}

function renderGroup(deps: DisclosureDeps, group: ServedGroup): string {
  const counterparty = servedCounterparty(deps, group.counterparty);
  // Unreachable through the pass, which builds the two lists from one walk.
  // Loud rather than nameless: a block naming a customer the model cannot
  // slot would invite a slot the guard then refuses, and the model would be
  // corrected for reading what it was shown.
  if (counterparty === undefined) {
    throw new Error(
      `the day's record names counterparty reference ${group.counterparty}, which nothing served this execution — the groups and the served customers are built from one walk (ticket #198)`,
    );
  }
  const lines = group.lines.map(
    (line) => `  ${line.index}. ${line.text} (${line.provenance})`,
  );
  return [`${ref(counterparty.ref)} ${counterparty.name}`, ...lines].join("\n");
}

/**
 * WHAT SIZE OF DAY THIS IS — the counts, so the opening can be about the day
 * rather than about nothing (spec #193 decision 22).
 *
 * THE NUMBERS ARE HERE AND MAY NOT BE REPEATED, which is the one place this
 * block has to be blunt: the heading already states the count, code computes
 * it from the lines the post carries, and prose that stated it again could
 * disagree with the lines under it. The guard refuses a digit anywhere in the
 * composed halves for exactly that reason, so the model is told what the day
 * weighs and told to say it in words.
 */
export function renderCountsBlock(deps: DisclosureDeps): string {
  const lines = deps.groups.reduce(
    (total, group) => total + group.lines.length,
    0,
  );
  return [
    `[The day: ${lines} line(s) across ${deps.groups.length} customer(s).]`,
    "The post's heading states the line count itself, so your own sentences must carry no digit at all — say a quiet day was quiet and a heavy one was heavy, in words.",
  ].join("\n\n");
}
