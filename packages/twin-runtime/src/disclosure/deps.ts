/**
 * WHAT ONE DAY'S DISCLOSURE IS BUILT OVER (ticket #198; spec #193 decisions
 * 21, 22 and 23; ADR-0034, ADR-0037 as amended).
 *
 * EVERYTHING IS ALREADY RENDERED, AND THAT IS THE OCCASION RATHER THAN AN
 * OMISSION. This automation has no tools: the lines are what the aperture
 * stored at filing, the claim lines are what it sealed when it asked, and the
 * names come off the bundle's entity mirror — so there is nothing left to
 * look up and nothing a read could return that the pass does not already
 * hold. What the execution adds is speech, and speech needs no connection.
 *
 * REFERENCES, NOT NAMES (the thread's own rule, `thread/served.ts`): the
 * model is handed small integers and never asked which sort of thing one is,
 * so a slot `[[3]]` in the opening names the third customer and nothing else.
 * A slot is where a NAME goes.
 *
 * THE CUSTOMERS ARE NUMBERED FROM ONE, and they are the only thing numbered
 * (ticket #218): the candidate-question route is retired, so there is no
 * second sort of reference to keep out of the counter's way.
 */

/**
 * One customer the day names, as the execution is served them.
 *
 * THE NAME IS THE REP'S OWN WORD. It comes from the bundle's entity mirror,
 * which is the only place a counterparty has a name rep-side (ADR-0004), and
 * it reaches the post through `counterpartyName` — so what the rep reads is
 * the name they confirmed rather than one model text produced. The model is
 * SHOWN it, because a twin that could not read its own customers' names could
 * not say what kind of day it was; what it may not do is type one, which is
 * the guard's third rule.
 */
export interface ServedCounterparty {
  /** The wire reference a slot fills from. */
  readonly ref: number;
  /** The rep-confirmed display name, as the post will render it. */
  readonly name: string;
}

/**
 * One numbered line of the day, exactly as the post will carry it (spec #193
 * decision 22).
 *
 * THE TEXT IS THE APERTURE'S, STORED (ADR-0034), and the number is the one
 * `disclosure_post_lines` records — which is what a rep's correction resolves
 * through. Both are shown to the model so its opening can be about the day
 * that is really there, and neither is anything it may change: code renders
 * every line, in stored order, whatever the call says.
 */
export interface ServedLine {
  readonly index: number;
  readonly text: string;
  /** The provenance clause, rendered by the same function the post uses. */
  readonly provenance: string;
}

/** One customer's block of the day, in the order the post will print it. */
export interface ServedGroup {
  /** The customer this block belongs to, by reference. */
  readonly counterparty: number;
  readonly lines: readonly ServedLine[];
}

/** What one day's disclosure is composed over. */
export interface DisclosureDeps {
  /** Every customer this post names — one per group (ticket #218). */
  readonly counterparties: readonly ServedCounterparty[];
  /** The day's lines, grouped and numbered as the post will render them. */
  readonly groups: readonly ServedGroup[];
  /**
   * How this rep talks, as data (spec #171 decision 15; `rep-language.ts`).
   * The disclosure is prose a person reads, so it takes the same part
   * drafting and the thread take rather than a register of its own.
   */
  readonly repLanguage: string;
  /**
   * The seat's IANA zone, resolved by the caller — what the «now» part is
   * rendered in.
   *
   * REQUIRED HERE THOUGH IT IS OPTIONAL ON THE RUNTIME'S DEPS, for the reason
   * the drafting deps give: unset on the runtime means the host clock, and
   * the resolution happens once at the caller so nothing downstream can
   * disagree about an hour (#139).
   */
  readonly timeZone: string;
}

/** The customer a reference names, or `undefined` when nothing served it. */
export function servedCounterparty(
  deps: DisclosureDeps,
  ref: number,
): ServedCounterparty | undefined {
  return deps.counterparties.find((counterparty) => counterparty.ref === ref);
}
