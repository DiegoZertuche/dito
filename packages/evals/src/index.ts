/**
 * @dito/evals — the eval harness ADR-0028 names as a component.
 *
 * ADR-0028 gives this package "golden corpora for the refusal suite
 * (FR-71b), extraction-precision fixtures (labeled seed transcripts
 * pre-pilot; the disclosure loop takes over at pilot), draft-quality/voice
 * spot suites, and prompt-regression runs on any ladder or model change".
 *
 * Ticket #56 builds the FIRST of those: extraction precision, measured
 * over what actually reached the Ledger versus what the aperture's
 * confidence gate STOPPED (ticket #218). The others arrive with the
 * surfaces they measure — FR-71b's refusal corpus with the owner read
 * (slice 4), voice with the copy catalog.
 *
 * The seam-driving harness lives in `src/testing`, which is excluded from
 * the build like every other package's: it is fixture plumbing, it reaches
 * other packages' fixture plumbing at the source, and it must never be
 * importable from shipped code.
 */
export {
  corpusDigest,
  EXCLUDED_FACT_TYPES,
  MIN_CROSSINGS_FOR_CONFIDENCE,
  PRECISION_BAR,
  PROSE_FIELDS,
  SOURCE_DESCRIPTIONS,
  STRUCTURED_FIELDS,
  type FactCheck,
  type FactLabel,
  type SeedMessage,
  type SeedTranscript,
  type SilentMessage,
} from "./corpus.ts";

export { LOOKING_TRANSCRIPTS } from "./corpus/looking.ts";
export { ALL_TRANSCRIPTS, SEED_TRANSCRIPTS } from "./corpus/transcripts.ts";

export {
  EVAL_NOW,
  EVAL_TIME_ZONE,
  LAST_READABLE_MINUTE,
} from "./clock.ts";

export type {
  ConfidenceBand,
  ConfidenceCell,
  ConfidenceDistribution,
  ConfidenceOutcomes,
  ConfidenceValue,
} from "./confidence.ts";

export {
  labelDrops,
  scoreCrossings,
  scoreLooking,
  wilsonInterval,
  type DroppedBelowGateRow,
  type DroppedCandidate,
  type FactCheckShape,
  type Interval,
  type LookingCase,
  type LookingOutcome,
  type LookingRow,
  type ObservedDrop,
  type PlacedLabel,
  type PrecisionCell,
  type PrecisionReport,
  type ScoredCrossing,
  type WrongCrossing,
  type WrongReason,
} from "./scoring.ts";

export {
  buildReport,
  renderReport,
  type BeforeSide,
  type ChatDayCost,
  type EvalReportDocument,
  type PassCounts,
  type RetryCounts,
} from "./report.ts";
