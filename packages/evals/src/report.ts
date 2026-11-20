/**
 * THE REPORT (ticket #56 ACs 4 and 6).
 *
 * Two renderings of one run, and both are the run: a JSON document that is
 * the record, and a text block for whoever is watching the terminal.
 *
 * WHAT THE REPORT REFUSES TO DO IS AS IMPORTANT AS WHAT IT PRINTS. It
 * never announces a pass or a failure against the ≥95% bar, because THIS
 * SLICE'S NUMBER DOES NOT GATE ANYTHING (AC 6): it is the first
 * measurement, and Test 4 gates the flag flip on pilot data. What it does
 * instead is print the bar beside the estimate and the interval, so a
 * reader can see for themselves whether the run is even capable of
 * answering the question — an n of twelve is not.
 *
 * And it never prints a bare proportion. Every cell carries its n and its
 * 95% interval, because "precision: 100%" over four crossings is the
 * sentence a measurement exists to prevent somebody writing.
 */
import {
  extractionDigest,
  type ModelEffort,
} from "@dito/twin-runtime";
import type { ConfidenceCell, ConfidenceOutcomes } from "./confidence.ts";
import {
  MIN_CROSSINGS_FOR_CONFIDENCE,
  PRECISION_BAR,
  EXCLUDED_FACT_TYPES,
} from "./corpus.ts";
import type {
  DroppedBelowGateRow,
  Interval,
  LookingRow,
  PrecisionCell,
  PrecisionReport,
} from "./scoring.ts";

/**
 * WHAT THE PASS ITSELF SAW, summed over every chat it read — off
 * `extraction_runs`, which the extraction pass settles each chat into.
 *
 * IT IS THE DENOMINATOR THE STORES CANNOT SUPPLY (ticket #66). A confidence
 * distribution read out of the Ledger and the questions store sees FILED
 * and QUESTIONED and nothing else, and two of the outcomes #66 is about are
 * neither:
 *
 * - a candidate the aperture REFUSED reaches no store, so it leaves the
 *   distribution silently, and
 * - a message the extractor proposed NOTHING for — #57's «¿me mandas lo
 *   mismo del pedido pasado…?», which produced zero candidates — is not a
 *   low-confidence reading at all. It is the absence of a data point, and
 *   no distribution over emitted confidences can contain it.
 *
 * So `candidates` is the honest denominator for "did the extractor have an
 * opinion at all", and the gap between it and what the LEDGER holds is
 * exactly what a band computed from that store alone would lose. Since
 * ticket #218 only `filed` reaches a store at all: both of the gate's
 * endings are drops, and `belowThreshold` and `unresolvedReference` are the
 * only trace either leaves. The below-gate half is read back off the run's
 * own submissions instead (`ObservedDrop`).
 */
export interface PassCounts {
  readonly messages: number;
  readonly candidates: number;
  readonly filed: number;
  /**
   * Candidates the CONFIDENCE gate stopped — the count of DROPS since
   * ticket #218, under the name it has always had.
   *
   * IT IS A COUNT OF DROPS AND NOT OF ASKS. The twin does not ask the rep to
   * settle what it was unsure of (spec #214 decision 1), so this column
   * counts candidates reaching the same nowhere an unresolved reference
   * reaches. The report's *dropped below gate* row is what names them.
   */
  readonly belowThreshold: number;
  /**
   * Candidates DROPPED for naming something outside the day (ticket #76) —
   * the pass's own `RunCounts` field of the same name, which is where the
   * reason it is counted apart is written (`extraction-pass.ts`).
   *
   * COUNTED APART FROM `belowThreshold` THOUGH BOTH ARE NOW DROPS (#218).
   * «the model was unsure» and «the model pointed somewhere it could not
   * follow» are different findings about an extractor: one is a threshold's
   * business and the other the search's, and a report that added them would
   * be unable to say which.
   */
  readonly unresolvedReference: number;
  /**
   * Candidates the model read BY REFERENCE and resolved (ticket #196's new
   * `extraction_runs` column; spec #193 decision 19).
   *
   * NOT A TERM IN THE PARTITION beside it: `filed`, `belowThreshold`,
   * `unresolvedReference` and `refused` say what the APERTURE did, and this
   * says how the MODEL read it — so a resolved candidate that filed is
   * counted on both axes, which is the arithmetic that makes «how often did
   * looking pay» answerable at all (ticket #199).
   */
  readonly resolvedReference: number;
  readonly refused: number;
}

/**
 * WHAT ONE CHAT-DAY'S EXTRACTION COST (ticket #199; spec #193 decision 11:
 * "the report records tool calls, iterations and tokens per chat-day").
 *
 * PER CHAT-DAY AND NOT ONLY AS A TOTAL, because the price of looking is a
 * claim about a DAY. Most days in this corpus have nothing to resolve and
 * search nothing, so an average over the corpus reports a number no day
 * actually paid — and the operator's question (spec #193 user story 20) is
 * what a run that DID look cost.
 *
 * `reads` IS THE PRICE OF LOOKING and `toolCalls` is every call the runner
 * made. They differ by the submission, which every run that files makes
 * exactly once: folding it in would put a constant inside the number.
 */
export interface ChatDayCost {
  readonly toolCalls: number;
  /** Of those, the three reads — the searches, lists and filed-fact reads. */
  readonly reads: number;
  readonly iterations: number;
  readonly tokensIn: number;
  readonly tokensOut: number;
}

/**
 * What the run cost, per chat-day and summed — one type because the pair
 * travels together everywhere it goes (the harness's result, the lane's
 * argument, the document's field).
 *
 * The total is summed from the parts by whoever builds it, so a reader
 * comparing them cannot find two numbers about one run.
 */
export interface CostReport {
  readonly total: ChatDayCost;
  /** Keyed by transcript id; every chat-day the run read has an entry. */
  readonly byTranscript: Readonly<Record<string, ChatDayCost>>;
}

/**
 * THE COMMITTED BEFORE THIS RUN IS READ AGAINST (spec #193 decisions 6 and
 * 30; ADR-0028 as amended).
 *
 * Read off the frozen artifact by the lane rather than restated here, so the
 * comparison in the document is a claim about a FILE somebody can open. What
 * `buildReport` does with it is refuse the two ways a pair becomes
 * unreadable — different labels, or a different model — and then record both
 * sides' numbers beside each other.
 */
export interface BeforeSide {
  /** The artifact this side was read from, by name under `reports/`. */
  readonly report: string;
  readonly extractorDigest: string;
  /** The digest of the labels it was scored against — the pair's key. */
  readonly corpusDigest: string;
  readonly model: string;
  readonly overall: PrecisionCell;
  readonly overallClusterInterval: PrecisionReport["overallClusterInterval"];
}

/**
 * WHAT MOVED BETWEEN THE TWO SIDES (tickets #199, #218 and #364; a recorded
 * remainder on #204 asked for it).
 *
 * NAMED IN THE ARTIFACT rather than only in a PR body, which is the point:
 * a reader six months from now has the file and not the review, and a
 * two-number comparison with no account of what differs reads as an A/B
 * that nobody ran.
 *
 * THE LABELS, THE MODEL AND THE `max_tokens` CEILING ARE HELD STILL, and the
 * EXTRACTOR is what moved (ticket #364): the day's read became a run of
 * Dito's extraction, one child per chat-day filing through `file_facts`. What
 * is left between the two numbers is that move and the live model's own
 * run-to-run variation.
 */
const WHAT_ELSE_MOVED: readonly string[] = [
  "the extractor moved (#364): the day's read is a run of Dito's extraction — a code step claims the chat-days, one child run per chat-day reads it with the three reads and files through the gated file_facts tool, a code step settles the claims and climbs the merge ladder — so the digests either side differ",
  "a chat-day's read is six model rounds at most (the run's agent step), where the previous extractor allowed eight",
  "the labels, the model and the max_tokens ceiling did NOT move",
  "so what is left between the two numbers is the extractor's move and the live model's own run-to-run variation",
];

/**
 * MODEL CALLS THIS RUN HAD TO ASK TWICE (ticket #146).
 *
 * A call that ends without `submit_extracted_facts` used to kill the whole
 * run, and the lane was rerun by hand until every chat happened to submit
 * — so the recorded number was always drawn from the runs that went
 * smoothly, and nothing in the file said so. The retry makes the run
 * finish; this is what stops it finishing SILENTLY. A number that cost
 * three retries and one that cost none are not the same number, and the
 * only way a reader can tell is if the artifact says which it is.
 */
export interface RetryCounts {
  readonly total: number;
  /**
   * Per transcript, so a reader can go and look at the day that cost one.
   * Only the transcripts that needed a retry appear: a map of zeros over
   * the whole corpus says nothing a total does not.
   */
  readonly byTranscript: Readonly<Record<string, number>>;
}

export interface EvalReportDocument {
  /** What was measured, so two reports can be told apart. */
  readonly ranAt: string;
  readonly model: string;
  /**
   * The `output_config.effort` the requests carried, or absent when they
   * carried none (ticket #148).
   *
   * ABSENT IS THE MODEL'S OWN DEFAULT — adaptive thinking on Sonnet 5 —
   * which is a real arm of #148's table rather than a field somebody
   * forgot to write. Optional for a second reason as well: every report
   * frozen before #148 was produced without one, and those files are still
   * read (`report.test.ts`).
   */
  readonly effort?: string;
  /**
   * The token ceiling the answer had to fit inside (ticket #148).
   *
   * Recorded because 2,048 is the number that made
   * `DITO_EXTRACTION_MODEL=claude-sonnet-5` unmeasurable: the model's
   * thinking block spent the whole budget, the tool input arrived empty,
   * and the lane read a harness limit as an extraction failure. A
   * precision figure is a figure under a ceiling, and a reader has to be
   * able to see which one.
   */
  readonly maxTokens: number;
  /**
   * WHICH EXTRACTOR PRODUCED THIS NUMBER — a digest of the system prompt
   * and the tool schema (ticket #59, Codex r2).
   *
   * The model NAME is not the extractor: two prompts against one corpus on
   * one model produced two of this ticket's reports, and nothing in either
   * file distinguished them. That is the same hole `corpus.digest` closes
   * on the other side, and it matters most for exactly the claim a
   * precision ticket makes — "this prompt beats that one, same corpus".
   */
  readonly extractorDigest: string;
  readonly corpus: {
    readonly transcripts: number;
    readonly messages: number;
    readonly labels: number;
    /**
     * What the run was actually scored against — the WHOLE corpus, the
     * looking days included. Counts do not move when a label's expected
     * value changes; this does, so a recorded number cannot silently outlive
     * its labels (Codex r1).
     */
    readonly digest: string;
    /**
     * THE ORIGINAL LABELS' DIGEST, BESIDE THE WIDENED CORPUS'S (ticket
     * #199).
     *
     * Two digests because the document makes two claims. `digest` says what
     * this run covered; this says what the before/after PAIR is over — the
     * thirty-four days the frozen before was scored against, unchanged, which
     * is the only thing that makes «not below» a statement about the
     * extractor. `buildReport` refuses a document whose before was scored
     * against anything else.
     */
    readonly originalDigest: string;
    /** Recorded in the document itself, per AC 5 — not only in the source. */
    readonly excludedFactTypes: Readonly<Record<string, string>>;
  };
  readonly bar: number;
  readonly minCrossingsForConfidence: number;
  /** True when this run produced too few crossings to speak about the bar. */
  readonly underpowered: boolean;
  readonly overall: PrecisionCell;
  /**
   * Independent units — chat-days, which is model calls — behind the
   * overall number, and the 95% interval that treats THEM as the sampling
   * unit (Codex round 2). The binomial interval on `overall` assumes every
   * crossing is an independent trial, which they are not; this one makes no
   * such assumption and is what the report leads with.
   */
  readonly clusters: number;
  readonly overallClusterInterval: PrecisionReport["overallClusterInterval"];
  readonly byFactType: Readonly<Record<string, PrecisionCell>>;
  readonly recall: number | undefined;
  /**
   * THE *DROPPED BELOW GATE* ROW (ticket #218; spec #214 decision 1) — every
   * candidate the threshold stopped, with the answer sheet's verdict on it,
   * and the totals.
   *
   * ITS OWN FIELD AND NOT PART OF THE PRECISION TABLE, for the reason the
   * looking row is not: precision is over what CROSSED, and folding a drop
   * in would let a gate that dropped everything post a beautiful number
   * about almost nothing. `labelled` is the recall the gate cost, as a
   * number rather than a hope.
   *
   * OVER EVERY CHAT THE RUN READ, like `pass` beside it and unlike
   * `overall` above it (Codex r1) — which is why it arrives as an input
   * rather than off `report`. The two numbers this row is read as are its
   * own `total` and `pass.belowThreshold`, and the aperture counted both
   * slices.
   */
  readonly droppedBelowGate: DroppedBelowGateRow;
  /**
   * HOW SURE THE TWIN WAS, on both sides of the gate (ticket #66).
   *
   * The report's other half, and a different claim from precision: the
   * table above says how often what crossed was right, and this says
   * whether the gate had a distribution to work with at all. #66's
   * complaint is that three rig runs produced zero below-gate candidates,
   * and nothing in a precision table can tell a threshold in the wrong
   * place apart from an emitter with no way to say "unsure".
   */
  readonly confidence: PrecisionReport["confidence"];
  /**
   * What the extraction pass saw, including the two outcomes that reach no
   * store — a refusal, and a message it proposed nothing for (ticket #66).
   */
  readonly pass: PassCounts;
  /**
   * What the run had to ask twice (ticket #146).
   *
   * OPTIONAL, because every report recorded before #146 lacks it — a run
   * from back then could not have needed a retry and survived to be
   * written. A reader must therefore tell "no retries" apart from "not
   * recorded", and `renderReport` says which of the two it is rather than
   * printing a zero it cannot stand behind.
   */
  readonly retries?: RetryCounts;
  /** Every false positive, so a low number can be argued with rather than believed. */
  readonly wrong: PrecisionReport["wrong"];
  /**
   * THE LOOKING CASES' OWN ROW (ticket #199; spec #193 decision 11).
   *
   * Apart from `overall` and never inside it: these four days are new
   * material, so folding them in would move the number by being ADDED and
   * the no-regression comparison above would be reading a corpus change as
   * an extractor result.
   */
  readonly looking: LookingRow;
  /** What each chat-day cost, and the totals — see `ChatDayCost`. */
  readonly cost: CostReport;
  /**
   * THE NO-REGRESSION COMPARISON, WRITTEN AND NOT JUDGED (spec #193
   * decision 6; ADR-0028 as amended).
   *
   * The after estimate over the original labels beside the committed
   * before's, with both intervals, and the statement «not below». A DROP IS
   * A FINDING FOR THE BOUNDARY AND NEVER A BLOCK, which is why this is a
   * boolean the reader reads and not an exit code the lane takes.
   */
  readonly comparison: {
    readonly beforeReport: string;
    readonly beforeExtractorDigest: string;
    readonly beforeOverall: PrecisionCell;
    readonly beforeClusterInterval: PrecisionReport["overallClusterInterval"];
    /**
     * Whether the after point estimate is not below the before's.
     *
     * ABSENT WHEN EITHER SIDE HAS NO ESTIMATE (Codex r1). A run that filed
     * nothing has an undefined precision, and a boolean would then write
     * `true` into a durable artifact — an affirmative no-regression claim
     * over a run with no number in it, which the renderer's own «NO ESTIMATE»
     * line contradicts. The key is omitted instead, exactly as
     * `PrecisionCell.precision` is omitted, and absence means there was no
     * comparison to make.
     */
    readonly notBelow?: boolean;
    /** See `WHAT_ELSE_MOVED`. */
    readonly alsoChanged: readonly string[];
  };
}

export function buildReport(input: {
  readonly report: PrecisionReport;
  /** The looking cases' row, from `scoreLooking` — see the document's field. */
  readonly looking: LookingRow;
  /**
   * The *dropped below gate* row, from `labelDrops` over the whole run —
   * see the document's field (ticket #218; Codex r1).
   */
  readonly droppedBelowGate: DroppedBelowGateRow;
  /** What each chat-day cost, from the run's own trace (ticket #199). */
  readonly cost: CostReport;
  /**
   * The committed before this run is read against — see `BeforeSide`.
   *
   * REQUIRED, because a lane running today always knows which artifact it is
   * paired with, and a comparison that could be omitted is one that gets
   * omitted on the run whose number moved.
   */
  readonly before: BeforeSide;
  readonly model: string;
  /**
   * Omitted when the request sent none — see the field it lands in.
   *
   * TYPED AS THE RUNTIME'S OWN LEVEL rather than as a string (ticket #194):
   * the digest is computed from this value, so a word the budget does not
   * know would be a stamp for an extractor that could never have run. The
   * lanes already resolve it through `extractionModelConfig`, which refuses
   * anything else.
   */
  readonly effort?: ModelEffort;
  readonly maxTokens: number;
  readonly ranAt: Date;
  readonly corpus: {
    readonly transcripts: number;
    readonly messages: number;
    readonly labels: number;
    readonly digest: string;
    readonly originalDigest: string;
  };
  readonly pass: PassCounts;
  /**
   * REQUIRED, unlike the document's own field (spec review, #146). The
   * document's is optional because three recorded artifacts predate the
   * ticket; a caller running the lane TODAY always knows the answer, and
   * making it optional here would let the one line that carries the count
   * out of the run and into the artifact be dropped with nothing to catch
   * it. `renderReport` is what tells an absent field from a zero.
   */
  readonly retries: RetryCounts;
}): EvalReportDocument {
  const { report, model, ranAt, corpus, before } = input;
  // THE TWO WAYS A PAIR STOPS BEING READABLE, refused here rather than
  // caught by a reader (ticket #199; spec #193 decision 30).
  //
  // #83 moved four labels and ended the #59 pair; #148 moved the model and
  // ended two more. Both times the artifacts stayed side by side in
  // `reports/` looking like comparisons, and a test had to be rewritten to
  // say the pairing was over. The corpus WIDENED for this ticket, which is
  // the first hazard arriving by another door — so a document may not be
  // built at all unless its before was scored against this run's original
  // labels, on this run's model.
  if (before.corpusDigest !== corpus.originalDigest) {
    throw new Error(
      `${before.report} and this run were scored against different labels (${before.corpusDigest} vs ${corpus.originalDigest}) — a before/after pair over two corpora mixes a grading change into an extractor result and cannot be read (ticket #83)`,
    );
  }
  if (before.model !== model) {
    throw new Error(
      `${before.report} ran on ${before.model} and this run on ${model} — a pair over two different models reports a model switch as a migration result (ticket #148)`,
    );
  }
  return {
    ranAt: ranAt.toISOString(),
    model,
    // Spread rather than written as `effort: input.effort`, so a run that
    // sent no effort produces a document with NO KEY rather than one with
    // an explicit null. The distinction survives into the JSON, which is
    // where two arms of #148's table are told apart.
    ...(input.effort === undefined ? {} : { effort: input.effort }),
    maxTokens: input.maxTokens,
    // Read from the extractor itself rather than passed in, so a caller
    // cannot record a number against a prompt that did not produce it.
    //
    // THE EXTRACTOR'S STAMP (tickets #194, #364): the shipped definition's
    // digest — its instructions, its tools and its budget — with the RUNG,
    // which is why it is computed from this run's own model rather than read
    // as a constant. It does not cover the claim, the renderer, `toPayload`,
    // the aperture's shaping or the scorer;
    // `extraction/definition.ts` argues that limit beside itself, and the
    // answer to it is a RE-MEASUREMENT rather than a wider hash — which is
    // what `comparison` below carries, over the labels both sides share.
    extractorDigest: extractionDigest({
      model,
      ...(input.effort === undefined ? {} : { effort: input.effort }),
    }),
    corpus: { ...corpus, excludedFactTypes: EXCLUDED_FACT_TYPES },
    bar: PRECISION_BAR,
    minCrossingsForConfidence: MIN_CROSSINGS_FOR_CONFIDENCE,
    underpowered: report.overall.crossed < MIN_CROSSINGS_FOR_CONFIDENCE,
    overall: report.overall,
    clusters: report.clusters,
    overallClusterInterval: report.overallClusterInterval,
    byFactType: report.byFactType,
    recall: report.recall,
    droppedBelowGate: input.droppedBelowGate,
    confidence: report.confidence,
    pass: input.pass,
    retries: input.retries,
    wrong: report.wrong,
    looking: input.looking,
    cost: input.cost,
    comparison: {
      beforeReport: before.report,
      beforeExtractorDigest: before.extractorDigest,
      beforeOverall: before.overall,
      beforeClusterInterval: before.overallClusterInterval,
      // A MISSING ESTIMATE IS NOT A COMPARISON. Either side can have crossed
      // nothing — a corpus that landed short, a gate that emptied the day —
      // and there is then no statement to make either way, so the key is
      // omitted rather than written `true` (Codex r1).
      ...(report.overall.precision === undefined ||
      before.overall.precision === undefined
        ? {}
        : {
            notBelow:
              report.overall.precision >= before.overall.precision,
          }),
      alsoChanged: WHAT_ELSE_MOVED,
    },
  };
}

function pct(value: number | undefined): string {
  return value === undefined ? "  —  " : `${(value * 100).toFixed(1)}%`;
}

/**
 * «[93.3% – 98.9%]», or a dash where there is no interval to print.
 *
 * One home for the bracket, because the report renders an interval in three
 * places and two spellings of the same figure read as two figures.
 */
function interval(bounds: Interval | undefined): string {
  return bounds === undefined
    ? "     —     "
    : `[${pct(bounds.low)} – ${pct(bounds.high)}]`;
}

function line(name: string, cell: PrecisionCell): string {
  // An ABSENT interval prints nothing here rather than a dash: the cell
  // already shows «—» for the estimate, and a second dash on the same row
  // would read as two missing measurements.
  const bounds =
    cell.interval === undefined ? "" : `  ${interval(cell.interval)}`;
  return `  ${name.padEnd(22)} ${pct(cell.precision).padStart(6)}  (${String(cell.correct).padStart(3)}/${String(cell.crossed).padEnd(3)})${bounds}`;
}

/**
 * How many distinct values the TEXT rendering shows before it stops
 * listing them.
 *
 * The list is here to expose a small vocabulary — four values over
 * eighty-seven crossings is the finding. An emitter with fifty distinct
 * values has already answered that question by having fifty, and printing
 * all of them turns the line into a wall. The JSON keeps every one.
 */
const VALUES_SHOWN = 8;

/** «0.95×70 0.99×6» — the raw vocabulary, unrounded and unaveraged. */
function values(cell: ConfidenceCell): string {
  if (cell.distinct.length === 0) return "—";
  const shown = cell.distinct
    .slice(0, VALUES_SHOWN)
    .map((v) => `${v.value}×${v.n}`)
    .join(" ");
  const rest = cell.distinct.length - VALUES_SHOWN;
  return rest > 0 ? `${shown} …+${rest} more (all in the JSON)` : shown;
}

/**
 * The pass's own line, rendered once — the precision lane and the probe
 * lane both print it, and two copies of one sentence drift.
 */
export function renderPassCounts(pass: PassCounts): string {
  return `${pass.messages} message(s) → ${pass.candidates} candidate(s): ${pass.filed} filed, ${pass.belowThreshold} below the gate, ${pass.unresolvedReference} dropped as unresolved reference(s), ${pass.refused} refused by the aperture; ${pass.resolvedReference} were read BY REFERENCE and resolved`;
}

/** One population's row in the band table: n, and where it sat. */
function bandRow(name: string, cell: ConfidenceCell): string {
  return `    ${name.padEnd(14)} ${String(cell.n).padStart(4)}   ${pct(cell.min).padStart(6)}  ${pct(cell.median).padStart(6)}  ${pct(cell.max).padStart(6)}   ${values(cell)}`;
}

/**
 * THE CONFIDENCE BAND (ticket #66).
 *
 * It reports and it does not advise. There is deliberately no line here
 * suggesting where the gate should go: that is a decision to take from
 * these numbers, and a diagnosis that arrived with its own remedy attached
 * would be arguing rather than measuring.
 */
function renderConfidence(doc: EvalReportDocument): string[] {
  const band = doc.confidence;
  const out: string[] = [];
  out.push(
    "CONFIDENCE BAND — how sure the twin was, on both sides of the gate (#66)",
  );
  out.push(
    `  gate             ${pct(band.gate)} — the aperture's own threshold, recorded, not proposed`,
  );
  // WHAT THE PASS PROPOSED, before either store saw it. Printed first
  // because it is the honest denominator: the two outcomes below it — a
  // refusal, and a message the extractor said nothing about — never reach
  // a store, so the band below cannot contain them (#66's second case
  // produced ZERO candidates, which is not a low confidence).
  out.push(`  the pass saw     ${renderPassCounts(doc.pass)}`);
  out.push(
    `  middle band      ${band.inMiddleBand} of ${band.overall.graded.n} graded candidate(s) in [${pct(band.middleBand.from)} – ${pct(band.middleBand.to)}) — the neighbourhood a threshold move could reach`,
  );
  if (band.ungradedCrossings > 0) {
    out.push(
      `  ungraded         ${band.ungradedCrossings} crossing(s) carry no confidence — a rep act has none, and a null is not a zero`,
    );
  }
  out.push("");
  // TWO ENDINGS, COUNTED APART (tickets #76 and #218). Both reach no store,
  // and a report that added them would be unable to say which of the gate's
  // two tests fired — one is a threshold's business and the other the
  // search's. The band below describes the CONFIDENCE half alone, which is
  // what the population is for.
  out.push(
    `    the gate STOPPED ${doc.pass.belowThreshold} candidate(s) below the threshold — no fact, no question, no line (#218). The band below is their confidences, and the DROPPED BELOW GATE row above says which they were`,
  );
  out.push(
    `    it also DROPPED ${doc.pass.unresolvedReference} candidate(s) as unresolved references — no fact, no question, no line (#76). Nothing downstream can see these; this count is their only trace`,
  );
  out.push("");
  out.push("    population        n      min  median     max   distinct values");
  out.push(bandRow("graded", band.overall.graded));
  out.push(bandRow("filed", band.overall.filed));
  out.push(bandRow("dropped", band.overall.dropped));
  out.push(bandRow("correct", band.overall.correct));
  // Upper-cased because it is the row the second dispatch is decided from:
  // a false positive far above the gate is out of any threshold's reach.
  out.push(bandRow("WRONG", band.overall.wrong));
  out.push("");
  out.push("    per fact type:");
  for (const [factType, outcomes] of Object.entries(band.byFactType)) {
    out.push(perTypeRow(factType, outcomes));
  }
  out.push("");
  out.push("    the graded histogram, whose edges include the gate:");
  band.overall.graded.bands.forEach((bucket, index, all) => {
    // The top band CLOSES at 1, and is bracketed so — a `)` there would
    // tell a reader that a confidence of exactly 1 fell off the end.
    const close = index === all.length - 1 ? "]" : ")";
    out.push(
      `      [${bucket.from.toFixed(2)}, ${bucket.to.toFixed(2)}${close}${String(bucket.n).padStart(5)}`,
    );
  });
  return out;
}

function perTypeRow(factType: string, outcomes: ConfidenceOutcomes): string {
  const wrong =
    outcomes.wrong.n === 0 ? "" : `   wrong at ${values(outcomes.wrong)}`;
  return `      ${factType.padEnd(20)} ${String(outcomes.graded.n).padStart(3)} graded (${outcomes.filed.n} filed, ${outcomes.dropped.n} dropped)   median ${pct(outcomes.graded.median)}${wrong}`;
}

/**
 * The retry line (ticket #146) — and the three things it can say.
 *
 * EXPORTED for the reason `renderPassCounts` is: the precision lane and
 * the probe lane both print it, and two copies of one sentence drift.
 *
 * "Not recorded" is NOT zero, and the distinction is the whole reason the
 * field is optional: a report written before this ticket comes from a lane
 * that could not have retried anything, and printing `0` over it would
 * claim a clean run for an artifact that has no idea.
 */
export function renderRetries(retries: RetryCounts | undefined): string {
  if (retries === undefined) {
    return "not recorded — this report predates #146, when a call that ended without the tool killed the run";
  }
  if (retries.total === 0) {
    return "0 — every chat filed on its first read (#146)";
  }
  const named = Object.entries(retries.byTranscript)
    .map(([transcriptId, n]) => `${transcriptId}×${n}`)
    .join(" ");
  return `${retries.total} — call(s) re-asked after ending without the tool (#146): ${named}`;
}

/**
 * THE *DROPPED BELOW GATE* ROW, RENDERED (ticket #218; spec #214 decision 1).
 *
 * WHAT IT IS FOR. The trade FR-31 makes is SILENT — no fact, no question, no
 * line — and a silent trade with no number beside it is a hope. This row is
 * the number: which candidates the threshold stopped, how sure the model was
 * about each, and whether the corpus says a fact was there. It was visible as
 * an ask somebody received while the candidate-question route stood, which is
 * what ticket #218 retired.
 *
 * TWO COUNTS OF ONE THING, AND THE DIFFERENCE IS SAID OUT LOUD. `total` is
 * the WORKINGS — the candidates this run read off its own submissions and
 * classified through the aperture's `gateVerdict` — and `pass.belowThreshold`
 * is what the APERTURE recorded. Both are over every chat the run read. They
 * disagree when a candidate was REFUSED before the gate ever read it (a
 * malformed payload, the authorship fence, a message outside the window):
 * the aperture counts that under `refused` and the workings above cannot see
 * the refusal, so they over-count. A reader must not have to do that
 * subtraction themselves, which is the same obligation the SHORT line
 * discharged while the questions store was the source.
 *
 * SHORT IS A DIFFERENT SENTENCE FROM OVER, and it gets one (Codex r1). Only
 * one direction has an explanation: the workings read a superset of what the
 * gate judged, so they cannot be short of it, and a run where they are is a
 * row built over a narrower population than the count beside it. Printing
 * «over-counts by -1» there would be false in both the word and the sign, in
 * a durable artifact, next to a labelled total that had quietly lost a drop.
 */
function renderDroppedBelowGate(doc: EvalReportDocument): string[] {
  const row = doc.droppedBelowGate;
  const out: string[] = [];
  out.push(
    `  DROPPED BELOW GATE — the trade FR-31 makes, as a number (#218). The aperture counted ${doc.pass.belowThreshold}`,
  );
  out.push(
    `    labelled         ${row.labelled} of ${row.total} — the corpus says a fact of that kind was stated there, and the threshold stopped it. THE RECALL THE GATE COST`,
  );
  const difference = row.total - doc.pass.belowThreshold;
  if (difference > 0) {
    out.push(
      `    OVER-COUNTS BY ${difference}: these workings read every candidate the model submitted below the gate, and the aperture REFUSES some before the gate reads them (a malformed payload, the authorship fence, a message outside the window). Those are counted under \`refused\`, and the count above is the one to quote`,
    );
  } else if (difference < 0) {
    out.push(
      `    SHORT BY ${-difference}, WHICH THESE WORKINGS CANNOT BE: they read every candidate the model submitted, and the aperture judged a subset of the same submissions — so ${-difference} drop(s) the gate counted are missing from the table below, and the labelled total under-reports the recall the gate cost. Read \`${doc.pass.belowThreshold}\` as the count and treat the table as incomplete`,
    );
  }
  if (row.total === 0) {
    // «Nothing» is a claim about the GATE, so it is only made when the
    // aperture's own count agrees; otherwise the line above has already said
    // the table is incomplete and this must not contradict it.
    out.push(
      difference === 0
        ? "    none — the gate stopped nothing this run"
        : "    no workings to table — see the line above",
    );
    return out;
  }
  out.push("    transcript             message      type              conf  reading              label");
  for (const drop of row.candidates) {
    out.push(
      `    ${drop.transcriptId.padEnd(22)} ${drop.messageId.padEnd(12)} ${drop.factType.padEnd(17)} ${String(drop.confidence).padStart(4)}  ${drop.reading.padEnd(20)} ${drop.labelled ? "LABELLED" : "—"}`,
    );
  }
  return out;
}

/**
 * THE NO-REGRESSION LINES (spec #193 decision 6; ADR-0028 as amended).
 *
 * It STATES and it does not judge. There is no PASS here and no FAIL — the
 * report's own guards refuse those words anywhere in the text — because a
 * drop is a finding for the boundary and this measurement blocks nothing.
 * What a reader gets is both estimates, both intervals, and the sentence
 * saying which way it went.
 */
function renderComparison(doc: EvalReportDocument): string[] {
  const pair = doc.comparison;
  const out: string[] = [];
  out.push(
    "  THE PAIR — the same labels and the same model either side of the change this run measures, over the ORIGINAL labels only",
  );
  out.push(
    `    before           ${pct(pair.beforeOverall.precision)}  ${interval(pair.beforeOverall.interval)}  (${pair.beforeOverall.correct}/${pair.beforeOverall.crossed})  ${pair.beforeReport}, extractor ${pair.beforeExtractorDigest}`,
  );
  out.push(
    `    after            ${pct(doc.overall.precision)}  ${interval(doc.overall.interval)}  (${doc.overall.correct}/${doc.overall.crossed})  this run, extractor ${doc.extractorDigest}`,
  );
  out.push(
    `    cluster before   ${interval(pair.beforeClusterInterval)}        after ${interval(doc.overallClusterInterval)}  — the interval over chat-days, which is the one to quote`,
  );
  out.push(
    pair.notBelow === undefined
      ? "    NO ESTIMATE      one side crossed nothing, so there is no comparison to make"
      : pair.notBelow
        ? "    NOT BELOW        the after point estimate is not below the committed before's"
        : "    BELOW the committed before — the boundary session reads this and decides what it means, and nothing here blocks on it (ADR-0028 as amended; spec #193 decision 6)",
  );
  out.push("    what else moved between the two runs, besides the tools:");
  for (const change of pair.alsoChanged) out.push(`      · ${change}`);
  return out;
}

/**
 * THE LOOKING ROW (spec #193 decision 11) — its own n, its own interval, and
 * every case named.
 *
 * NAMED RATHER THAN COUNTED, for the reason `wrong` is: four cases is a
 * number nobody can argue with, and which four ended which way is the whole
 * finding. The leak count sits apart from the precision because it is a
 * different cost — a wrong quantity is corrected inside the window, and
 * another customer's name in the record is not (ADR-0004).
 */
function renderLooking(doc: EvalReportDocument): string[] {
  const row = doc.looking;
  const out: string[] = [];
  out.push(
    "  LOOKING — the days whose fact can only be read by resolving a reference (#199)",
  );
  out.push(line("LOOKING", {
    crossed: row.crossed,
    correct: row.correct,
    precision: row.precision,
    interval: row.interval,
  }));
  out.push(
    `    LEAKED           ${row.leaks} filed field(s) carried the referent — a name or which order, which may never cross (ADR-0004)`,
  );
  out.push(
    `    UNMARKED         ${row.unmarked} resolved fact(s) whose line does not say the goods were inferred — the rep is not told which line to check harder`,
  );
  for (const one of row.cases) {
    out.push(
      `    ${one.transcriptId.padEnd(30)} ${one.outcome}${one.leaked ? " — LEAKED" : ""}`,
    );
  }
  // ...and the workings, for the reason the wrong-crossing list above exists:
  // a count nobody can argue with is believed rather than read. The predicate
  // is named, so a leak is told from a misread quantity without reading prose.
  for (const wrong of row.wrong) {
    out.push(
      `      ${wrong.transcriptId} / ${wrong.messageId} / ${wrong.factType} — ${wrong.reason} (${wrong.failedCheck ?? "no check"})${wrong.detail === "" ? "" : `: ${wrong.detail}`}`,
    );
  }
  return out;
}

/**
 * WHAT LOOKING COST, per chat-day and in total (spec #193 decision 11, user
 * story 20: "the price of looking is a number and not a surprise").
 *
 * Only the days that spent something are listed. A table of zeroes over
 * forty-seven chat-days says nothing a total does not, and the days that
 * searched are exactly the ones a reader is looking for — which is the same
 * rule the retry line keeps.
 */
function renderCost(doc: EvalReportDocument): string[] {
  const out: string[] = [];
  out.push("  WHAT LOOKING COST — per chat-day, off this run's own trace (#199)");
  out.push(
    `    tool calls       ${doc.cost.total.toolCalls}, of which reads       ${doc.cost.total.reads} (a search, a list or a filed-fact read; the filing is not one)`,
  );
  out.push(
    `    iterations       ${doc.cost.total.iterations}   tokens ${doc.cost.total.tokensIn} in / ${doc.cost.total.tokensOut} out`,
  );
  const spent = Object.entries(doc.cost.byTranscript).filter(
    ([, cost]) => cost.reads > 0,
  );
  out.push(
    spent.length === 0
      ? "    no chat-day made a read at all — nothing in this run needed to look"
      : "    the chat-days that looked:",
  );
  for (const [transcriptId, cost] of spent) {
    out.push(
      `      ${transcriptId.padEnd(30)} ${cost.reads} read(s), ${cost.iterations} iteration(s), ${cost.tokensIn} in / ${cost.tokensOut} out`,
    );
  }
  return out;
}

/** The terminal rendering. Same numbers, arranged for a person. */
export function renderReport(doc: EvalReportDocument): string {
  const out: string[] = [];
  out.push("EXTRACTION PRECISION — over what CROSSED, not over what the model emitted");
  out.push(`  model            ${doc.model}`);
  // BESIDE THE MODEL, because they are the rest of the same question
  // (ticket #148). «claude-sonnet-5» alone does not say which of this
  // ticket's two Sonnet arms a number came from, and «(the model's own
  // default)» is a claim rather than a blank: it says no effort was sent.
  out.push(`  effort           ${doc.effort ?? "(the model's own default)"}`);
  out.push(`  max_tokens       ${doc.maxTokens}`);
  out.push(
    `  corpus           ${doc.corpus.transcripts} transcripts, ${doc.corpus.messages} messages, ${doc.corpus.labels} labels`,
  );
  out.push(`  corpus digest    ${doc.corpus.digest}`);
  // BOTH DIGESTS, because the document makes two claims (#199): the line
  // above says what this run covered, and this says what the pair below is
  // over — the original labels, unchanged since the before was frozen.
  out.push(
    `  original labels  ${doc.corpus.originalDigest} — the days the pair is read over`,
  );
  // Beside the corpus digest, because a precision claim is a claim about a
  // pair of runs and the reader needs to see which half was held still.
  out.push(`  extractor digest ${doc.extractorDigest}`);
  out.push(`  ran at           ${doc.ranAt}`);
  out.push(`  retries          ${renderRetries(doc.retries)}`);
  out.push("");
  out.push(
    "  precision, with n and its 95% interval (binomial over crossings):",
  );
  out.push(line("OVERALL", doc.overall));
  for (const [factType, cell] of Object.entries(doc.byFactType)) {
    out.push(line(factType, cell));
  }
  out.push("");
  // THE HONEST INTERVAL, and it is printed apart from the table because it
  // is a different claim (Codex round 2). The rows above treat every
  // crossing as an independent trial; they are not, because the pass reads
  // one chat per model call and a busy day contributes four or five facts
  // from the same call. Resampling CHAT-DAYS gives the wider interval the
  // sampling design actually supports, and it goes first.
  out.push(
    `  clusters         ${doc.clusters} chat-day(s) — one read each, which is the n the uncertainty rests on`,
  );
  out.push(
    doc.overallClusterInterval === undefined
      ? "  cluster interval   —   (needs at least two chat-days with crossings)"
      : `  CLUSTER INTERVAL ${pct(doc.overall.precision)}  [${pct(doc.overallClusterInterval.low)} – ${pct(doc.overallClusterInterval.high)}]  — resampling chat-days: the unit the sampling actually has, and the one to quote`,
  );
  out.push("");
  out.push(
    `  recall           ${pct(doc.recall)} — reported, never the bar: a label the gate stopped is FR-31 working`,
  );
  out.push("");
  out.push(...renderDroppedBelowGate(doc));
  out.push("");
  out.push(`  the bar          ${pct(doc.bar)} (NFR-3)`);
  if (doc.underpowered) {
    out.push(
      `  UNDERPOWERED     ${doc.overall.crossed} crossings, under the ${doc.minCrossingsForConfidence} this corpus is sized for.`,
    );
    out.push(
      "                   The point estimate stands; the interval is too wide to say whether the bar is met.",
    );
  }
  out.push(
    "                   And note what the sizing rule does NOT buy: it counts crossings, while the",
  );
  out.push(
    `                   independent unit is the chat-day (${doc.clusters} of them). Reaching the bar would need`,
  );
  out.push(
    "                   the CLUSTER interval's lower bound above it, which this corpus is not sized for.",
  );
  out.push(
    "  NOT A GATE       This is the first measurement and it blocks nothing (ticket #56 AC 6).",
  );
  out.push(
    "                   Test 4 gates the flag flip, on pilot data. Do not tune the extractor to this number.",
  );
  out.push("");
  // AC 5's line, saying the two different things it can say (ticket #61).
  // An empty manifest is not the absence of a claim: it is the claim that
  // every type the aperture files is measured here, which is what the
  // reader of a six-month-old artifact needs before believing the table
  // above covers the system.
  const excluded = Object.keys(doc.corpus.excludedFactTypes);
  out.push(
    excluded.length === 0
      ? "  absent from the corpus: none — every fact type the aperture files is labeled here (AC 5)"
      : `  absent from the corpus: ${excluded.join(", ")} — adding one is a corpus change (AC 5)`,
  );

  if (doc.wrong.length > 0) {
    out.push("");
    const misattributed = doc.wrong.filter(
      (w) => w.reason === "misattributed",
    ).length;
    out.push(
      // Exactly what the scorer checked, and no more: the cited message
      // carries no label and the day labels that KIND on another one. It
      // does not claim the content matched — a withdrawn price and an
      // order read off its acknowledgement both land here, and telling
      // them apart is the reader's job, which is why every line below
      // carries the sentence the rep would have read.
      `  WHAT CROSSED WRONG (${doc.wrong.length}${misattributed === 0 ? "" : `, of which ${misattributed} MISATTRIBUTED — the cited message has no label, and the day labels that kind on another one`}):`,
    );
    for (const wrong of doc.wrong) {
      out.push(
        `    ${wrong.transcriptId} / ${wrong.messageId} / ${wrong.factType} — ${wrong.reason}${wrong.detail === "" ? "" : `: ${wrong.detail}`}`,
      );
      out.push(
        // The confidence rides on the line rather than only in the band
        // above (#66): "could a threshold have caught this one" is a
        // question about THIS crossing, and an aggregate cannot answer it.
        `      confidence ${wrong.confidence === null ? "—" : wrong.confidence}, and the rep would have read: «${wrong.disclosureText}»`,
      );
    }
  }
  out.push("");
  out.push(...renderComparison(doc));
  out.push("");
  out.push(...renderLooking(doc));
  out.push("");
  out.push(...renderCost(doc));
  out.push("");
  out.push(...renderConfidence(doc));
  return out.join("\n");
}
