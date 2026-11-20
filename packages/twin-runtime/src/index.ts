/**
 * @dito/twin-runtime — the compute-plane runtime for one twin (ADR-0001).
 *
 * Slice 1 (#23): the seam consumer — wa_events decrypt under the DEK,
 * conversation rows land in the bundle, counterparty inbound classifies
 * and drafts through the execution runner on the Claude Agent SDK (ADR-0014/0015),
 * and a needs-answer draft emits its system_send command to the rep's
 * self-chat (ADR-0006). Slice 1 (#24): the send-lock writer — the sole
 * mint path for taps and customer_send commands, allowlist and pacing
 * enforced, refusals audit-chained. Slice 1 (#25): the quoted-reply
 * affirmation matcher (the rep's «va» mints the tap through the writer,
 * echo-protected by the executor's origin tags) and the confirmation
 * sweep («Enviado a …» after a send resolves). The runtime is the sole
 * bundle holder by construction this slice; the executor itself lives in
 * the plane (plane/executor). Slice 2 (#30): the twin-thread grammar —
 * every twin post renders through the one grammar point and opens with
 * the ✳️ frame (Mock A for drafts) — and the dismiss verb: a quoted
 * «no va» dismisses a draft terminally, acked «✳️ Descartado», with a
 * later «va» refused through the writer's audit-chained taxonomy.
 * Slice 2 (#35): the twin thread is fully routed — every unquoted rep
 * text is twin input, answered from real history through a second Tool
 * Runner call site with retrieval tools (framed) or
 * met with a deliberate silence the model chose; media-only is ignored;
 * quoted replies route by target. Drafting stops being amnesiac: the
 * drafting call carries retrieved conversation context from the same
 * memory.
 */

export {
  processPendingWaEvents,
  UnsupportedEventTypeError,
  type ProcessResult,
  type TwinRuntimeDeps,
} from "./consumer.js";
export { type ModelCallConfig, type ModelEffort } from "./model-config.js";
// THE TRACE SURFACE (#177 hotfix 1). The rig is the only composition root that
// passes one, and `renderShape` is the content-free default it prints with.
export {
  renderFull,
  renderShape,
  type RuntimeTrace,
} from "./trace-render.js";
// THE DRAFTING AUTOMATION (ticket #172). What the rig's runner needs to name
// is the boundary default for the rep's language: the automation itself, its
// registries and its store are the consumer's business and reach nobody
// outside this package.
export {
  DEFAULT_REP_LANGUAGE,
  REP_LANGUAGE_RECIPE,
  repLanguagePart,
} from "./rep-language.js";
export {
  decodeWaMessagePayload,
  WaPayloadError,
  type WaMessagePayload,
} from "./payload.js";
export {
  embedMessageBacklog,
  type EmbedBacklogOptions,
  type EmbedBacklogResult,
} from "./backlog.js";
export {
  BGE_M3_MODEL,
  createBgeM3Embedder,
  type BgeM3Options,
} from "./bge-m3.js";
export {
  EmbedderContractError,
  embedAll,
  embedOne,
  type Embedder,
} from "./embedder.js";
export {
  auditFr73,
  auditFr73At,
  type Fr73Gap,
  type Fr73Options,
  type Fr73Report,
  type Fr73Target,
  type Fr73Violation,
} from "./fr73.js";
export { harnessDirectoryBeside } from "./harness-directory.js";
export {
  openTwinMemory,
  OrphanBundleError,
  provisionTwin,
  TwinAlreadyProvisionedError,
  TwinNotProvisionedError,
  type TwinMemoryOptions,
} from "./provision.js";
export {
  retrieveRelevantMessages,
  type RetrievalOptions,
} from "./retrieval.js";
export {
  bindingQuestionAsked,
  bindingQuestionAnchor,
  postAnswer,
  type AnsweringDeps,
} from "./answering.js";
export {
  BATCH_LANE_CAP,
  batchIsIdle,
  openBatchWork,
  openLanes,
  REALTIME_LANE_CAP,
  type BatchWork,
  type Lane,
  type Lanes,
} from "./lanes.js";
export { THREAD_MAX_ITERATIONS, THREAD_MESSAGE_WAKE } from "./thread/automation.js";
export type {
  DraftState,
  QuotedPost,
  ThreadDeps,
} from "./thread/deps.js";
export {
  createThreadSessions,
  type ThreadSessions,
} from "./thread/sessions.js";
export type { ThreadEvent, ThreadEventSink } from "./thread/events.js";
export {
  advanceRuns,
  createRunEngine,
  executeStep,
  type RunEngine,
  type StepRun,
  type StepSettlement,
} from "./runs/engine.js";
export type { Conversation } from "./runs/conversation.js";
export { ServedHits, type ServedAnswerState, type ServedHit } from "./thread/served.js";
export { runTwinRuntime, type RunTwinRuntimeOptions } from "./runtime.js";
// THE POST PRIMITIVE AND ITS FEED (ticket #220). Exported because the local
// API (#221) is the reader: rep-web is a client of the runtime, never a
// store reader (ADR-0010), so the shape a card renders from crosses this
// boundary and nothing else does.
export {
  answerActsOf,
  reexpressStrayPosts,
  PART_KINDS,
  POST_ORIGINS,
  QUESTION_SUBJECTS,
  type ComposedPost,
  type DraftPart,
  type PostAnswerAct,
  type PostOrigin,
  type PostPart,
  type ProsePart,
  type QuestionPart,
  type QuestionSubject,
  type RecordLineGroup,
  type RecordLinesPart,
  type ReceiptPart,
} from "./posts.js";
// ...AND THE DOOR IT IS SERVED THROUGH (ticket #221; ADR-0010). The
// composition root starts it beside the loop, because a server and a poll are
// two things one process does rather than one thing: the rig starts both, and
// the seam suite starts the server alone over a fixture bundle.
export {
  startLocalApi,
  type LocalApi,
  type LocalApiActDeps,
  type LocalApiDeps,
  type LocalApiOptions,
  type LocalApiSessions,
} from "./local-api.js";
// ...AND THE BUS THAT JOINS THE TWO (ticket #263): the loop publishes a door
// turn's reply to it and the server's stream reads it, so the composition
// root makes one and hands the same one to both.
export {
  createSeatEvents,
  type SeatEventListener,
  type SeatEvents,
} from "./seat-events.js";
// THE ARRIVAL AND THE CANVAS (tickets #266, #320): the record the page's ask
// writes, the seat's last line, and the canvas read.
export { ARRIVAL_THROTTLE_MS, recordArrival } from "./arrival.js";
export { readLastLine, readCanvas, type CanvasLine, type Canvas } from "./canvas.js";
// THE FOUR ACTS THAT DOOR SERVES (ticket #224). Exported for the composition
// root and the seam suite, exactly as the server is: a rig starts both and the
// suite drives the acts over a fixture bundle.
export {
  performDashboardAct,
  DETERMINISTIC_INSTRUCTIONS,
  type DashboardActDeps,
  type DashboardActRequest,
  type DashboardActScope,
} from "./dashboard-acts.js";
export {
  drainSendRefusals,
  type DrainedRefusals,
} from "./send-lock/refusals.js";
export {
  feedPageOnTheWire,
  readFeed,
  type FeedDeps,
  type FeedPage,
  type FeedPost,
  type FeedRead,
  type OpenedDraftPart,
  type OpenedPart,
  type OpenedProsePart,
  type OpenedQuestionPart,
  type OpenedReceiptPart,
  type OpenedRecordLine,
  type OpenedRecordLinesPart,
} from "./feed.js";
export {
  resolveDisclosureLineOfPost,
  type DailyDisclosureDeps,
  type DisclosureLookupDeps,
  type ResolvedDisclosureLine,
} from "./disclosure.js";
export {
  DEFAULT_TRANSCRIPT_LIMIT,
  EXTRACTION_RUN_STATES,
  SEAM_SETTLING_LAG_MS,
  type DailyExtractionDeps,
  type ExtractionRunState,
  type ExtractionSteering,
} from "./extraction-pass.js";
// THE DAY'S EXTRACTION AND ITS POST BY HAND (ticket #364): the eval lane and
// the rig's tools start the automation's own run and wait for it.
export {
  runDailyDisclosure,
  runDailyExtraction,
  type DailyDisclosureResult,
  type DailyExtractionResult,
} from "./runs/by-hand.js";
// The request wake's two closed words (ticket #197), exported for the RIG's
// requester: it reads an outcome and a reason back off the row it wrote, and a
// script restating those sets as bare strings would be a second copy of a
// vocabulary the store's own CHECK holds. The arrays stay inside the package —
// `migration-vocabulary.test.ts` reads them from the module that owns them.
export type {
  RuntimeRequestOutcome,
  RuntimeRequestReason,
} from "./runtime-requests.js";
// Scope in and scope out as rep acts, and FR-15's ninety days as the
// primitive the plane reads per fill (ticket #222). The acts are FUNCTIONS,
// and their door is a dashboard act (`dashboard-acts.ts`, reached through
// `TWIN_API_ACT_ROUTES`) which calls them inside its own transaction rather
// than opening a second one; the window is exported for `rig-provision.ts` the way
// `CONSERVATIVE_DEV_PACING` is, because the number the store is seeded with
// and the number the product promises are one value stated once.
export {
  scopeChatIn,
  scopeChatOut,
  DEFAULT_HISTORY_WINDOW_DAYS,
  SCOPE_ACT_KINDS,
  type ScopeAct,
  type ScopeActDeps,
} from "./scoping.js";
// The rep's clock, exported for the RIG's composition roots (ticket #67):
// the hand triggers read one steering instant out of the environment, and
// a script that parsed it for itself would be a copy of this rule that
// drifts — silently, into another day.
//
// `renderTurnHeader` and `renderTurnInstant` are what the extraction turn
// is framed and stamped with (tickets #121, #139), and the eval corpus's
// unit lane reads both: every relative-weekday label in it is arithmetic
// off ONE rep day, and the two carried-in days are said on a Sunday the
// pass reads from — so «el lunes is the 31st» is only true of the instant
// their beats are actually stamped with. The lane asserts THOSE STRINGS
// rather than restating the date, so moving the eval clock fails there
// instead of silently invalidating a label.
//
// `earliestWindowStart` is exported for the corpus's own well-formedness
// check (ticket #139): a transcript may declare that its chat has owed its
// extraction since an earlier rep day, and one reaching further back than
// the pass will ever look would have its beats silently cut off.
export {
  civilDate,
  earliestWindowStart,
  isLaterRepDay,
  parseIsoInstant,
  renderTurnHeader,
  renderTurnInstant,
} from "./rep-clock.js";
// EXTRACTION, AS ONE OF DITO'S AUTOMATIONS (tickets #194, #364): its
// definition, whose digest the eval report records as the stamp its numbers
// were measured under — instructions, tools, recipes and budget together.
export { EXTRACTION_DEFINITION, extractionDigest } from "./extraction/definition.js";
export { runDigest } from "./runs/definition.js";
// THE CEILING EVERY EXTRACTION STEP'S CALL CARRIES (ticket #194), recorded by
// the eval artifacts. Re-exported here rather than taken from
// `@dito/execution` directly, because `@dito/evals` depends on this package
// and not on that one.
export { DEFAULT_MAX_TOKENS } from "@dito/execution";
export type { ExtractionDeps } from "./extraction/deps.js";
export {
  FILE_FACTS_TOOL,
  // EXPORTED FOR THE MEASUREMENT (ticket #218). The eval harness recovers
  // the candidates the model filed from the runner's own trace, to name the
  // ones the gate stopped — and it parses them with THIS function rather than
  // reading the wire a second way, so what it reports is what the aperture
  // was handed.
  parseCandidateFacts,
  type CandidateFact,
  type CandidateFacts,
} from "./extraction/file-facts.js";
// WHICH MODEL EACH ROUTED RUNG RUNS ON, resolved in one place (tickets
// #148 and #154). Three call sites read `DITO_EXTRACTION_MODEL` and each
// used to carry its own default literal; the effort knob would have been a
// second such literal beside every one of them. The entity-kind rung
// resolves the same way, under its own variable, and stays SEPARATE —
// deriving it from extraction's config is what moved it silently once
// already.
export {
  DEFAULT_ENTITY_KIND_MODEL,
  DEFAULT_EXTRACTION_MODEL,
  entityKindModelConfig,
  extractionModelConfig,
  ExtractionConfigError,
} from "./extraction-config.js";
export {
  ENTITY_KIND_MAX_ITERATIONS,
  ENTITY_KIND_WAKE,
} from "./entity-kind/automation.js";
export type { EntityKindDeps } from "./entity-kind/deps.js";
export {
  backfillEntityKinds,
  EntityKindBackfillScopeError,
  type EntityKindBackfillDeps,
  type EntityKindBackfillResult,
  type EntityKindDetermined,
} from "./entity-kind-backfill.js";
export {
  CONSERVATIVE_DEV_PACING,
  createSendLockWriter,
  type CustomerSendRequest,
  type CustomerSendResult,
  type PacingThresholds,
  type RefusalReason,
  type SendLockWriter,
  type TapMinter,
} from "./send-lock/writer.js";
export { acceptsAffirmation, type PostGrammar } from "./affirmation.js";
export { TWIN_POST_KINDS, type TwinPostKind } from "./twin-posts.js";
export {
  processResolvedSends,
  type ConfirmationDeps,
} from "./confirmations.js";
export {
  CORRECTION_REFUSAL_MICROCOPY,
  REFUSAL_MICROCOPY,
  type CorrectionRefusalReason,
} from "./microcopy.js";
// AND THE BY-REFERENCE MARK ITSELF (ticket #199). The eval's looking row
// grades whether a resolved fact told the rep it was inferred, and a copy of
// the parenthetical in the corpus would go on passing the day the mark
// changed — the same rule `fold` follows for the scorer.
export {
  assertFramed,
  BY_REFERENCE_MARK,
  counterpartyDisplayName,
  counterpartyName,
  renderBindingAck,
  renderBindingQuestion,
  renderCorrectionAck,
  renderCorrectionRefusal,
  renderDismissAck,
  renderDraftPost,
  renderFactDisclosureLine,
  renderRefusalNotice,
  renderSendConfirmation,
} from "./grammar.js";
