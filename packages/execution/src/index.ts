/**
 * @dito/execution — the minimum execution runtime (ADR-0014 as amended;
 * spec #126 decision 5; ticket #128).
 *
 * Every unit of agentic work is an EXECUTION: a trigger creates it with its
 * own instructions, tools and context, and the agent inside decides what to
 * do — including nothing. Every execution runs one EXECUTION DEFINITION,
 * digest-stamped, whose tools and recipes are named from registries of
 * Dito-authored parts (ADR-0014 as amended; tickets #178, #364).
 *
 * This package is that runtime and nothing else: a credential-free library
 * both apps consume, holding no database connection, no key, and no model
 * credential of its own. Nine things live here, and `README.md` names what
 * deliberately does not — the clock, the runs engine and the lanes' runtime.
 */

export {
  executionAuditEntry,
  EXECUTION_AUDIT_ACTION,
  EXECUTION_CALLER,
  type ExecutionAuditChain,
  type ExecutionAuditEntry,
} from "./audit.js";
export {
  EFFORTS,
  LANES,
  PARAMETER_TYPES,
  isEffort,
  isLane,
  TRIGGER_MECHANISMS,
  wakeAccepts,
  type BudgetSpec,
  type ContextRecipeCall,
  type Effort,
  type Lane,
  type ParameterShape,
  type ParameterType,
  type SeamEventPredicate,
  type TriggerMechanism,
  type TriggerWake,
  type Wake,
} from "./automation.js";
export { sessionFile, workspaceOf, type Harness } from "./harness.js";
export {
  isSdkTool,
  SDK_TOOL_GATES,
  SDK_TOOLS,
  WORKSPACE_FILE_TOOLS,
  workspacePath,
  workspaceViolation,
  WROTE_ACT,
  type SdkTool,
} from "./sdk-tools.js";
export {
  ExecutionError,
  runExecution,
  STRUCTURED_OUTPUT_TOOL,
  type ExecutionOutcome,
  type WordsPiece,
} from "./runner.js";
export {
  openSession,
  sessionShapeOf,
  type Session,
  type SessionHooks,
  type SessionShape,
  type SessionStart,
  type Truncation,
  type WakeSettlement,
  type WakeSpec,
} from "./session.js";
export {
  assertDefinition,
  DEFAULT_MAX_TOKENS,
  defineExecution,
  ExecutionDefinitionError,
  instructionsDigest,
  instructionsText,
  renderParts,
  resolveBudget,
  type Budget,
  type ExecutionDefinition,
  type ExecutionDefinitionSpec,
  type NamedPart,
  type StructuredOutputContract,
  type SubmissionParse,
  type TurnEnding,
} from "./definition.js";
export {
  finalizedThrough,
  NOW_OWNER_RECIPE,
  NOW_RECIPE,
  renderCivilDay,
  renderTurnHeader,
  renderTurnInstant,
  STANDARD_RECIPES,
} from "./now.js";
export {
  type ParameterValue,
  type RecipeParameters,
  type RecipeRegistration,
  type RecipeRegistry,
  type RecipeRenderer,
  type ToolRegistration,
  type ToolRegistry,
} from "./registry.js";
export {
  DISPOSITIONS,
  isDisposition,
  type Disposition,
  type ExecutionRecord,
  type ExecutionStore,
  type ReadDisposition,
  type TokenCount,
} from "./record.js";
export type {
  ToolCall,
  ToolCallOutcome,
  Trace,
  TraceEvent,
} from "./trace.js";
export {
  OCCASIONS,
  triggerRef,
  TriggerRefError,
  type ChatTurnTrigger,
  type DashboardActTrigger,
  type EntityKindTrigger,
  type ArrivalTrigger,
  type Occasion,
  type OwnerQuestionTrigger,
  type Trigger,
  type TwinThreadEventKind,
  type TwinThreadEventTrigger,
  type RunStepTrigger,
  type TwinThreadMessageTrigger,
} from "./trigger.js";
export {
  assertToolDeclaration,
  defineTool,
  GATES,
  inputViolations,
  projectionViolations,
  repEvidencedViolations,
  ToolDeclarationError,
  type EffectOutcome,
  type EffectToolDeclaration,
  type Gate,
  type GatedEffectToolDeclaration,
  type ProjectionToolDeclaration,
  type RepEvidencedToolDeclaration,
  type ToolDeclaration,
  type ToolInputSchema,
  type ToolResult,
} from "./tool.js";
export { oneAtATime, type InTurn } from "./tool-queue.js";
