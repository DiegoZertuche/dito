/**
 * THE CONFIDENCE BAND (ticket #66, the diagnosis half).
 *
 * #66 reports the same observation three times: over real rig traffic the
 * aperture's gate stopped NOTHING. `below_threshold` was 0 every run, so
 * FR-31's safety valve — which turned a below-threshold extraction into a
 * disclosure question then and DROPS it now (ticket #218) — has never once
 * opened. The observed behaviour is bimodal: confidently right, confidently
 * wrong, or silent.
 *
 * THIS MODULE MEASURES AND CHANGES NOTHING, and that still holds after the
 * fix half. It moves no threshold — the measurement it produced is the
 * argument for not moving one — touches no prompt, and proposes no new
 * candidate shape. It exists so that the three hypotheses #66 lists can be
 * told apart by a reader, which they could not be before, because #56 left
 * `confidence` off `ScoredCrossing` and the report therefore could not say
 * whether a wrong crossing sat beside the gate or nowhere near it.
 *
 * WHAT IT REPORTS, AND WHY EACH CUT EARNS ITS PLACE:
 *
 * - `distinct` — every value the emitter actually produced, with its
 *   count. This is the single cut that separates hypothesis 2 from
 *   hypothesis 3. If eighty-seven crossings take four distinct values,
 *   there is no threshold to move: the emitter has a vocabulary, not a
 *   scale, and "uncertain" is not a number it can say.
 * - `bands` — a histogram whose edges include the gate, so "clustered at
 *   the extremes" is answered by looking rather than by adjectives.
 * - `correct` beside `wrong` — where the false positives sat. A threshold
 *   move can only catch a wrong crossing that was NEAR the gate; wrong
 *   crossings at 0.95 are out of the gate's reach whatever it is set to,
 *   and that is the most decision-relevant number in the whole report.
 * - `filed` beside `dropped` — the gate's own two sides. The dropped half
 *   is the only direct evidence of what the emitter says when it is unsure,
 *   and it is the half that had been empty.
 *
 * WHAT THE GATE'S SECOND INPUT DOES AND DOES NOT DO TO THIS TABLE (tickets
 * #66, #76 and #218). The gate reads two things — the confidence, and the
 * model's own reading of whether the record it proposes names something
 * outside the day — and both endings are now the same: nothing is recorded.
 * `dropped` here is the CONFIDENCE half alone, which is what the population
 * is for: it is the direct evidence of what the emitter says when it is
 * unsure. An unresolved reference appears in NO population here at any
 * confidence, and the pass's own count is its only trace — the report prints
 * that count beside this table for exactly that reason.
 *
 * That absence is a bias worth knowing when reading `graded`. The
 * unresolved-reference candidates are plainly-worded ones — that is what the
 * reading MEANS — so they were sitting at 0.95 or 1.00 when they left, and
 * what remains here is not quite every opinion the extractor had.
 *
 * NO MEAN. A median and the raw distinct values, never an average: the
 * distribution this exists to describe is suspected of being a couple of
 * spikes, and a mean of two spikes reports a value nothing ever emitted.
 */

/** A half-open span of confidence, `[from, to)`. */
export interface Range {
  readonly from: number;
  readonly to: number;
}

/** One histogram bucket — a `Range` and how many landed in it. */
export interface ConfidenceBand extends Range {
  readonly n: number;
}

/** One value the emitter produced, and how often. */
export interface ConfidenceValue {
  readonly value: number;
  readonly n: number;
}

/**
 * One population of graded candidates, summarised.
 *
 * `min`, `max` and `median` are undefined on an empty population rather
 * than 0 — there is no smallest confidence in a set with no members, and a
 * zero would read as a measurement of something very unsure.
 */
export interface ConfidenceCell {
  readonly n: number;
  readonly min: number | undefined;
  readonly max: number | undefined;
  readonly median: number | undefined;
  readonly bands: readonly ConfidenceBand[];
  /** Ascending by value. The cut that shows a vocabulary rather than a scale. */
  readonly distinct: readonly ConfidenceValue[];
}

/** The same population cut five ways — the cuts the diagnosis needs. */
export interface ConfidenceOutcomes {
  /**
   * Every graded candidate this run can see: filed plus dropped.
   *
   * TWO SOURCES, ONE POPULATION (ticket #218). The filed half comes off the
   * Ledger and the dropped half off the run's own submissions, because a drop
   * reaches no store at all: the candidate-question store is retired with its
   * route, and it was the only place the below-gate half could be read back.
   * The submission carries every candidate the model proposed, so this half
   * holds one sample per candidate. What it can OVER-count is a candidate the
   * aperture REFUSED before the gate read it, and `renderDroppedBelowGate`
   * says so when the two counts differ.
   */
  readonly graded: ConfidenceCell;
  /** The ones that CROSSED — above the gate. */
  readonly filed: ConfidenceCell;
  /** The ones the gate STOPPED — below it (FR-31; ticket #218). */
  readonly dropped: ConfidenceCell;
  /** Of the filed, the ones that matched a label. */
  readonly correct: ConfidenceCell;
  /** Of the filed, the false positives. Where these sit is the whole question. */
  readonly wrong: ConfidenceCell;
}

export interface ConfidenceDistribution {
  /**
   * The gate this run was scored under, RECORDED and not proposed. It is
   * read from the aperture rather than restated here, so a report can
   * never describe a threshold the run did not use.
   */
  readonly gate: number;
  /**
   * A READING AID, not a proposal: the neighbourhood of the gate, within
   * which a threshold move could plausibly have changed an outcome. #66
   * asks how many corpus items fall in the middle band and says to report
   * zero if it is zero.
   */
  readonly middleBand: Range;
  /** Graded candidates inside `middleBand`. */
  readonly inMiddleBand: number;
  readonly overall: ConfidenceOutcomes;
  readonly byFactType: Readonly<Record<string, ConfidenceOutcomes>>;
  /**
   * Crossings the Ledger holds with a NULL confidence — a rep act rather
   * than an extraction. Counted and never folded in: a null is not a zero,
   * and averaging one in would invent an unsure reading.
   */
  readonly ungradedCrossings: number;
}

/**
 * The histogram's fixed edges. The top three are narrow because that is
 * where the emitter is suspected of living, and one band from 0.9 to 1
 * would hide the very clustering this report exists to show.
 *
 * THE GATE IS ADDED TO THEM, never assumed to be among them (see
 * `bandEdges`). 0.8 happens to be in this list today, and the report says
 * outright that its edges include the gate — a sentence that would go
 * silently false the moment the second dispatch moves the threshold to
 * 0.75 and the two sides of the gate started sharing the `[0.7, 0.8)`
 * bucket.
 */
const FIXED_BAND_EDGES = [0, 0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95, 1];

/** How far either side of the gate `middleBand` reaches. */
const MIDDLE_BAND_RADIUS = 0.1;

/**
 * Snaps a derived boundary onto the grid the stored data lives on.
 *
 * The Ledger holds a fact's confidence as `numeric(4, 3)`, so no stored
 * confidence has a fourth decimal, and a boundary that grows one is a
 * float artefact and nothing else: `0.8 - 0.1` is `0.7000000000000001` in
 * doubles, which would put a candidate at exactly 0.7 OUTSIDE the middle
 * band by a hair nobody could see in the report. Boundaries derived from
 * the gate — rather than written down — have to be snapped back.
 */
function onStoredGrid(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * The histogram's edges for a given gate: the fixed ones, plus the gate
 * itself, sorted and deduplicated.
 *
 * So the two sides of the gate can never share a bucket, whatever the gate
 * is set to — which is what the report claims about this histogram, and
 * what a hard-coded list could only promise for one particular threshold.
 */
function bandEdges(gate: number): number[] {
  return [...new Set([...FIXED_BAND_EDGES, onStoredGrid(gate)])].sort(
    (a, b) => a - b,
  );
}

/** The median. Even counts take the mean of the middle pair. */
function median(sorted: readonly number[]): number | undefined {
  if (sorted.length === 0) return undefined;
  const mid = sorted.length / 2;
  if (sorted.length % 2 === 1) return sorted[Math.floor(mid)]!;
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Which band a value belongs to.
 *
 * Half-open upwards, so a value exactly at the gate is FILED-side, which is
 * how the aperture reads it (`confidence < threshold` becomes a question).
 * The top band closes at 1 so a confidence of exactly 1 is counted rather
 * than dropped.
 */
function bandsOf(values: readonly number[], edges: readonly number[]): ConfidenceBand[] {
  const bands: ConfidenceBand[] = [];
  for (let i = 0; i < edges.length - 1; i += 1) {
    const from = edges[i]!;
    const to = edges[i + 1]!;
    const top = i === edges.length - 2;
    bands.push({
      from,
      to,
      n: values.filter((v) => v >= from && (top ? v <= to : v < to)).length,
    });
  }
  return bands;
}

/** Summarises one population. */
function summarise(
  values: readonly number[],
  edges: readonly number[],
): ConfidenceCell {
  const sorted = [...values].sort((a, b) => a - b);
  const counts = new Map<number, number>();
  for (const value of sorted) counts.set(value, (counts.get(value) ?? 0) + 1);
  return {
    n: sorted.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    median: median(sorted),
    bands: bandsOf(sorted, edges),
    distinct: [...counts.entries()]
      .sort(([a], [b]) => a - b)
      .map(([value, n]) => ({ value, n })),
  };
}

/**
 * One graded candidate, as the distribution sees it — the smallest shape
 * that answers every cut above.
 *
 * `crossed` is the gate's own verdict, and `correct` is the scorer's;
 * a dropped candidate has no `correct` because it was never judged against
 * a label — it never crossed, so it was never a precision outcome. Whether
 * a label BACKED it is a different claim, and it is on the report's
 * *dropped below gate* row (ticket #218).
 */
export interface GradedCandidate {
  readonly factType: string;
  readonly confidence: number;
  readonly crossed: boolean;
  readonly correct: boolean | undefined;
}

/**
 * The graded candidates among a run's CROSSINGS — the one place a null
 * confidence is dropped.
 *
 * A null means the fact was filed by a REP ACT and no model ever graded
 * it. Dropping it is the rule; folding it in as a zero would invent an
 * unsure reading that nothing ever had. Written once because the scorer
 * and the probe lane both need it, and a rule kept in two places is a rule
 * one of them forgets.
 *
 * `correct` is the caller's: the scorer has a verdict, and an
 * OBSERVATIONAL lane has none and passes `undefined` rather than a guess.
 */
export function gradedCrossings(
  rows: readonly {
    readonly factType: string;
    readonly confidence: number | null;
    readonly correct: boolean | undefined;
  }[],
): GradedCandidate[] {
  return rows.flatMap((row) =>
    row.confidence === null
      ? []
      : [
          {
            factType: row.factType,
            confidence: row.confidence,
            crossed: true,
            correct: row.correct,
          },
        ],
  );
}

function outcomes(
  candidates: readonly GradedCandidate[],
  edges: readonly number[],
): ConfidenceOutcomes {
  const of = (
    keep: (candidate: GradedCandidate) => boolean,
  ): ConfidenceCell =>
    summarise(candidates.filter(keep).map((c) => c.confidence), edges);
  return {
    graded: of(() => true),
    filed: of((c) => c.crossed),
    dropped: of((c) => !c.crossed),
    correct: of((c) => c.correct === true),
    wrong: of((c) => c.correct === false),
  };
}

/**
 * The whole distribution, over every graded candidate this run can see —
 * see `ConfidenceOutcomes.graded` for where the two halves come from.
 *
 * `factTypes` is passed in rather than derived, for the same reason
 * `byFactType` in the precision table is: a MISSING row reads as "fine",
 * and a type nothing was graded on is a finding rather than an absence.
 */
export function distributionOf(input: {
  readonly candidates: readonly GradedCandidate[];
  readonly gate: number;
  readonly factTypes: readonly string[];
  readonly ungradedCrossings: number;
}): ConfidenceDistribution {
  const { candidates, gate } = input;
  const edges = bandEdges(gate);
  const middleBand = {
    from: onStoredGrid(Math.max(0, gate - MIDDLE_BAND_RADIUS)),
    to: onStoredGrid(Math.min(1, gate + MIDDLE_BAND_RADIUS)),
  };
  const byFactType: Record<string, ConfidenceOutcomes> = {};
  const types = new Set<string>([
    ...input.factTypes,
    ...candidates.map((c) => c.factType),
  ]);
  for (const type of [...types].sort()) {
    byFactType[type] = outcomes(
      candidates.filter((c) => c.factType === type),
      edges,
    );
  }
  return {
    gate,
    middleBand,
    inMiddleBand: candidates.filter(
      (c) => c.confidence >= middleBand.from && c.confidence < middleBand.to,
    ).length,
    overall: outcomes(candidates, edges),
    byFactType,
    ungradedCrossings: input.ungradedCrossings,
  };
}
