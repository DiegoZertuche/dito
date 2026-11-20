/**
 * WHAT FILING A DAY'S CANDIDATES DID (tickets #196, #364; the ruling on #194,
 * 2026-09-06; spec #193 decision 19; ADR-0014 as amended).
 *
 * THE RULING, IN ONE SENTENCE: the record reads what the APERTURE did, not
 * what the model handed over. The two really differ, in a case the rig
 * produces every day — a day whose every candidate the aperture drops as an
 * unresolved reference handed over candidates and filed nothing — and a record
 * saying `filed` about that day would attest to a crossing that never
 * happened. So the filing tool's outcome carries these counts, and the word it
 * records the step by is read from them (`file-facts.ts`).
 *
 * ITS OWN MODULE, so `file-facts.ts` stays about the WIRE and this holds the
 * one thing that is about the STORE. It imports no connection and no store of
 * its own: these are counts, and the read is what produces them.
 */

/**
 * The aperture's verdict on one run's candidates, counted — what the run row
 * records and nothing else.
 *
 * COUNTS ONLY, NEVER CONTENT. `extraction_runs` is bookkeeping: the
 * candidates it counts are either filed (and disclosed), asked about, or
 * gone, and every one of those is readable in a store of its own.
 */
export interface ExtractionCounts {
  /**
   * BEATS, under the column name it was given before there were any but
   * messages (`extraction_runs.messages`). A gesture counts as one since
   * ticket #98; the stored column keeps its name, because renaming a
   * recorded count re-labels every run already written.
   */
  readonly messages: number;
  readonly candidates: number;
  readonly filed: number;
  /** Below the aperture's gate: became a QUESTION, never a fact (ticket #53). */
  readonly belowThreshold: number;
  /**
   * DROPPED (ticket #76): the model said the fact names something this day
   * does not spell out — «lo mismo del pedido pasado» — and looking found
   * nothing, or found two referents that differ, so nothing was filed,
   * nothing was asked, and nothing was disclosed.
   *
   * THE ONLY PLACE THE DROP IS VISIBLE, which is why it is counted at all.
   * A drop leaves no fact, no question and no line, so every downstream
   * store is silent about it by construction; this number is the whole
   * measurement. It says how much recall the drop trades, and it is what the
   * resolution below it is measured against.
   *
   * Counted apart from `belowThreshold` rather than added to it, because
   * the two have different endings as well as different causes: one asks the
   * rep, the other tells nobody. #66 found every wrong crossing at
   * 0.95–1.00 and one candidate in the whole middle band, and a single
   * number would hide which of the two moved.
   */
  readonly unresolvedReference: number;
  /**
   * RESOLVED BY LOOKING (ticket #196; spec #193 decision 19): the model read
   * the message as pointing somewhere the day does not spell out, searched
   * the rep's own history, found exactly ONE referent, and filed the goods
   * that referent named.
   *
   * THE PAIR OF `unresolvedReference`. That column says how much recall the
   * drop costs; this one says how much of it looking bought back. Without
   * both, a build whose tools resolve nothing reads exactly like one whose
   * tools resolve everything.
   *
   * A SECOND AXIS RATHER THAN A SIXTH OUTCOME, which is why it is not in the
   * run row's counts inequality (see the migration): the four counters above
   * partition what the APERTURE did with a candidate, and this says how the
   * MODEL read it — so a resolved candidate that filed is correctly counted
   * twice, once on each axis. EVERY candidate offered to the aperture under
   * this reading is counted, whichever door it went out of, because a rate
   * needs its denominator: the four above are what say how many of them
   * crossed, became a question, or were refused.
   */
  readonly resolvedReference: number;
  /** Refused on other grounds: an unknown type, a malformed payload, chat identity. */
  readonly refused: number;
}

/**
 * What one filing did.
 *
 * `superseded` IS NOT AN ERROR AND NOT AN EMPTY DAY. Another read has read
 * past this window while this one was in its model call — the state re-check
 * or the covered-window check inside the filing said so — so no candidate
 * was offered to the aperture at all and this run's claim row is somebody
 * else's to settle. It is its own arm rather than a row of zeroes because
 * those two mean different things to the caller: zeroes are a run that read
 * a day and filed nothing, and this is a run that read nothing.
 */
export type ExtractionFiling =
  | { readonly superseded: true }
  | { readonly superseded: false; readonly counts: ExtractionCounts };
