/**
 * @dito/aperture — the single Ledger writer and the filter deciding what
 * may cross the wall (ADR-0003).
 *
 * This package is the one component in the system holding `ledger` write
 * credentials. It is rep-side and seat-scoped: it outlives twin sessions
 * and serves the closing window. Its two inputs are candidate facts (class
 * 1: model output, untrusted, confidence-gated) and rep acts (class 2:
 * evidence-bound, matched by deterministic code, never by model output).
 *
 * What crosses, crosses disclosed: the aperture files an item and
 * writes its disclosure line in one Postgres transaction (FR-72). The
 * database enforces it — deferred constraint triggers on `ledger.facts`
 * and `ledger.entities` make an undisclosed crossing a state that cannot
 * commit — and `fr72.ts` audits it independently.
 *
 * Readers do NOT belong here and do not select from the Ledger's tables:
 * the shadow filter lives inside the finalized-view definitions
 * (ADR-0016), which is what makes flipping the launch gate a `WHERE`
 * clause rather than a pipeline rebuild.
 */

export {
  classifyApertureInput,
  type ApertureContext,
  type ApertureInput,
  type EntityRef,
  readSeamSource,
  repActEvidenceColumns,
  type DashboardActEvidence,
  type DashboardRepAct,
  type RepActContext,
  type RepActEvidence,
  type SeamGesture,
  type SeamRead,
  type SeamSource,
  type ThreadMessageEvidence,
  type ThreadMessageRepAct,
  type VerifiedRepAct,
} from "./inputs.js";

export {
  APERTURE_CALLER,
  type ApertureAction,
} from "./audit.js";

export {
  retractDisclosedFact,
  RetractionNotEvidenceBoundError,
  UnknownDisclosureLineError,
  type FactRetractionOutcome,
  type FactRetractionRequest,
  type RetractionRefusal,
} from "./retraction.js";

export {
  CORRECTION_WINDOW_HOURS,
  finalizeDueFacts,
  type FinalizationResult,
  type LedgerClockContext,
} from "./finalization.js";

export {
  fileEntityCreate,
  EntityCreateInFlightError,
  EntityIdCollisionError,
  ENTITY_KINDS,
  RepActNotEvidenceBoundError,
  type EntityCreateRequest,
  type EntityCreateResult,
  type EntityKind,
} from "./entities.js";

export {
  fileEntityKind,
  EntityKindUnknownEntityError,
  KIND_DETERMINERS,
  type EntityKindOutcome,
  type EntityKindRequest,
  type KindDeterminer,
} from "./entity-kind.js";

export {
  countFiledEntities,
  listFiledEntities,
  readEntityGrants,
  readFiledEntity,
  readFiledFacts,
  readTwinCompanies,
  type FiledEntity,
  type FiledEntityGrant,
  type FiledFact,
} from "./reads.js";

export {
  reconcileFr72,
  reconcileFr72At,
  type Fr72Report,
  type Fr72Violation,
} from "./fr72.js";

export {
  auditLedgerGrants,
  auditLedgerGrantsAt,
  // The dashboard's own wall as a check of its own (ticket #263): claim 10,
  // run alone, by `scripts/rep-web-grants-check.mjs`.
  auditRepWebGrants,
  auditRepWebGrantsAt,
  type RepWebGrantsReport,
  APERTURE_REP_SIDE_STORES,
  APERTURE_ROLE,
  // The three things the owner side's own tickets import from here: the
  // role it connects as, the setting it declares its company with, and the
  // columns it may render (#129, #130). Everything else the FR-71a audit
  // pins stays inside `grants.ts`, where the audit is.
  OWNER_COMPANY_SETTING,
  OWNER_ROLE,
  OWNER_VISIBLE_COLUMNS,
  // ...and the one thing rep-web imports (#221): the role it authenticates
  // as, which its own connection asserts on every checkout. It declares its
  // company with `OWNER_COMPANY_SETTING` above — one setting for both apps,
  // because it is one company policy — and everything else the rep-web clause
  // pins stays inside `grants.ts` beside the audit.
  REP_WEB_ROLE,
  TWIN_RUNTIME_ROLE,
  type GrantViolation,
  type LedgerGrantsReport,
} from "./grants.js";

// WHAT THE OWNER SIDE READS, AND HOW IT READS ALOUD (#129).
//
// Both modules are owner-side by their arguments and by nothing else: the
// reads take a connection the caller authenticated as `dito_owner` and
// declared a company on, and the renderers take rows. They live in this
// package rather than in the owner app because `sole-writer.test.ts` refuses
// a `ledger` identifier that is not a finalized view anywhere else, and
// because the owner web (#129), the owner twin's projection tools (#130) and
// the room (#131) must all be answering out of one implementation of "the
// owner's timeline".
export {
  countOwnerFacts,
  listOwnerEntities,
  readOwnerTimeline,
  resolveOwnerEntityByName,
  // ...and the fifth, which the owner twin's count tool needs to turn a
  // rep's name into the seat a count narrows to (#130).
  resolveOwnerSeatByName,
  // ...and the three reads BY ID the room's scroll needs (#131). A stored
  // answer keeps the ids of the rows it rests on and nothing else, so
  // re-rendering it from the Ledger asks for a fact, a cliente and a seat by
  // its own id rather than by cliente, by name or by window.
  readOwnerEntitiesByIds,
  readOwnerFactsByIds,
  readOwnerSeatsByIds,
  type OwnerEntity,
  type OwnerFact,
  type OwnerFactCountQuery,
  type OwnerSeat,
  type OwnerTimeline,
  type OwnerTimelineWindow,
} from "./owner-reads.js";

export {
  OWNER_ENTITY_KIND_LABELS,
  OWNER_FACT_TYPE_LABELS,
  OWNER_SOURCE_TYPE_LABELS,
  renderOwnerConfidence,
  renderOwnerEntityKind,
  renderOwnerEntityName,
  renderOwnerFact,
  renderOwnerFactLine,
  renderOwnerFactTypeLabel,
  renderOwnerInstant,
  renderOwnerSeat,
  renderOwnerSourceType,
  type OwnerRenderedFact,
} from "./owner-render.js";

// THE LAUNCH GATE (ticket #132; ADR-0016 as amended): one audited act per
// company, invoked by the `rig-lift-shadow.ts` hand trigger. The stamp that
// makes every LATER crossing land visible has no export of its own — it is
// a clause inside the filing paths, where ADR-0016 puts it.
export {
  liftCompanyShadow,
  ShadowAlreadyLiftedError,
  ShadowLiftUnknownCompanyError,
  type ShadowLiftContext,
  type ShadowLiftRequest,
  type ShadowLiftResult,
} from "./shadow-lift.js";

export {
  auditSelfChatExclusion,
  auditSelfChatExclusionAt,
  type SelfChatExclusionReport,
  type SelfChatViolation,
} from "./self-chat-exclusion.js";

export {
  auditLedgerWall,
  auditLedgerWallAt,
  type LedgerWallReport,
  type LedgerWallViolation,
} from "./wall.js";

export {
  DEFAULT_CALLING_CODE,
  isChatOwnNumber,
  normalizeEmail,
  normalizeIdentifiers,
  normalizePhone,
  normalizeRfc,
  type NormalizedIdentifiers,
} from "./identifiers.js";

export {
  fileMerge,
  fileUnmerge,
  lockCompanyForMerge,
  MERGE_RUNGS,
  MergeAlreadyRecordedError,
  MergeAlreadyReversedError,
  MergeCycleError,
  MergeUnknownEdgeError,
  MergeUnknownEntityError,
  readEntityMerges,
  readResolvedTimeline,
  resolveEntity,
  runMergeMatcher,
  type MergeEdge,
  type MergeEffectSet,
  type MergeMatcherReport,
  type MergePerformer,
  type MergeRequest,
  type MergeReversal,
  type MergeRung,
  type MergeSide,
  type MergeSkip,
  type MergeSkipReason,
  type MergeStatus,
  type ResolvedTimeline,
  type TimelineFact,
  type UnmergeContext,
  type UnmergeRequest,
} from "./merge.js";

export {
  fileCandidateFact,
  // EXPORTED FOR THE MEASUREMENT (ticket #218). The eval report's *dropped
  // below gate* row classifies each submitted candidate by the gate that
  // actually ran, rather than by a second copy of it in `@dito/evals` that
  // could disagree with this one — see `gateVerdict`.
  gateVerdict,
  CANDIDATE_READINGS,
  EXTRACTION_CONFIDENCE_THRESHOLD,
  // EXPORTED FOR THE CORPUS TO CHECK ITSELF AGAINST (ticket #59). ADR-0038
  // rests part of its case on the labeled corpus obeying this fence — "all
  // 89 human labels ... without ever having been told to" — and nothing
  // held that true after it was written. `corpus.test.ts` now does, against
  // this table rather than a restatement of it, so the answer sheet cannot
  // drift from the rule the aperture actually enforces.
  FACT_AUTHORSHIP,
  FACT_PAYLOAD_VERSIONS,
  FACT_TYPES,
  type CandidateFactOutcome,
  type CandidateFactRequest,
  type CandidateReading,
  type FactAuthorship,
  type FactType,
  type GateVerdict,
  type NormalizedFact,
} from "./facts.js";

// The audit chain's COVERAGE (ticket #78, ADR-0020, spec #48 decision 18):
// the enumeration of which acts owe an entry, and the check that says
// whether they have one. Beside the crossing's other invariant reporters,
// and here rather than in @dito/audit because it names `ledger.*` rows
// (ADR-0003, enforced by sole-writer.test.ts).
export {
  auditChainCoverageInDb,
  auditChainCoverageAt,
  type ChainCoverageReport,
  type CoverageViolation,
} from "./audit-coverage.js";
