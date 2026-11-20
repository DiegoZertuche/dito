/**
 * @dito/owner-twin — the owner twin, as a library (ticket #130; spec #126
 * decisions 5–8 and 16–18).
 *
 * THE FIRST EXECUTION THIS PRODUCT HAS. A trigger — the owner asked
 * something — creates it with its own instructions, its own three tools and
 * its own context, and the agent inside answers, refuses, asks which record
 * was meant, or says the record holds nothing of that kind (ADR-0014 as
 * amended). The runtime under it is `@dito/execution`, which this package
 * consumes and does not reimplement.
 *
 * WHAT IT HOLDS AND WHAT IT DOES NOT. No connection, no credential and NO
 * SQL AT ALL: the three tools wrap `@dito/aperture`'s five owner reads with
 * a `pg.ClientBase` the app authenticated as `dito_owner`, and the store
 * writes only the owner app's own three tables. The room is #131's; what is
 * here ends at a rendered turn.
 */
export {
  OWNER_TWIN_LANE,
  OWNER_TWIN_MAX_ITERATIONS,
  OWNER_TWIN_RECIPES,
  OWNER_TWIN_WAKE,
} from "./automation.js";
export {
  ownerTwinContext,
  ownerTwinExecution,
  renderEarlierTurns,
  type OwnerTurn,
} from "./definition.js";
export { ownerTwinTools, type OwnerTwinDeps } from "./turn-tools.js";
export { structuralViolations } from "./guard.js";
export {
  readOwnerRoomTurns,
  type OwnerRoom,
  type OwnerRoomTurn,
  type OwnerTurnUnrendered,
} from "./history.js";
export { fold, slotPattern, slotReferences, typedProse } from "./prose.js";
export { ownerTwinInstructions } from "./instructions.js";
export {
  OwnerRenderError,
  renderOwnerTurn,
  type ReceiptLine,
  type RenderedOwnerTurn,
  type RenderedRecord,
  type RenderedSegment,
} from "./render.js";
export {
  persistedReference,
  referenceClass,
  ServedRows,
  type PersistedReference,
  type ServedCount,
  type ServedKind,
  type ServedRow,
} from "./served.js";
export {
  OwnerTwinStore,
  ownerExecutionChain,
  readOwnerTurns,
  recordOwnerQuestion,
  storedReferences,
  OWNER_TWIN_HISTORY_TURNS,
  type OwnerConversation,
  type ReferenceRole,
  type StoredReference,
} from "./store.js";
export {
  ownerAnswerFormat,
  ownerDispositionOf,
  parseOwnerAnswer,
  OWNER_ANSWER_KINDS,
  OWNER_ANSWER_SCHEMA,
  type OwnerAnswer,
  type OwnerAnswerKind,
} from "./answer.js";
export {
  COUNT_FACTS_TOOL,
  OWNER_TOOL_COLUMNS,
  READ_TIMELINE_TOOL,
  RESOLVE_ENTITY_TOOL,
} from "./tools.js";
export {
  runOwnerTwinTurn,
  TURN_TRANSACTION,
  type OwnerTwinTurnOutcome,
} from "./turn.js";
