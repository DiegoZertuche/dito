/**
 * THE RUNS ENGINE AND THE CLOCK IN THE PASS (ticket #323; spec #318 decisions
 * 22–26; ADR-0012 as amended 2026-09-27; ADR-0014's clock engine).
 *
 * Once a pass, after the stream watch, `advanceRuns` reads the twin's runs
 * that have not ended, asks the seat-state gate about each (`gate.ts`), and
 * moves the ones it may: a cancelled run is ended with its report, a run
 * whose wait has come due — its instant on the clock store, or its card
 * settled — and a run ready for its next step are handed to the batch lane,
 * where `driveRun` takes them step by step until one parks, ends or fails.
 *
 * EVERY STEP IS AN EXECUTION (decision 37): one record and one content-free
 * chain entry, written in the transaction that ends the step beside its
 * checkpoint. An `agent` step is a model turn on the run's own SDK session —
 * opened new for the run's first one and resumed for every later one, so the
 * run remembers its own steps — with that step's instructions and the tools it
 * calls under their own gates, ending when the model stops, on its typed
 * output when it declares one (ticket #357); every other kind is code, with
 * no model, recorded the way a dashboard act is. The same builder and runner
 * run a one-step definition with no run at all (`executeStep`).
 *
 * A STEP BEGINS IN ONE TRANSACTION AND ENDS IN ANOTHER, and that is what makes
 * «runs never restart» true across a crash: the run says `running` before the
 * step's work starts, so a process that dies inside it leaves a run the next
 * process finds `running` and ends `failed` (`settleStranded`) — it never runs
 * the step again. A step that fails in this process ends the run the same way,
 * with a report post and the step's record; nothing fires for it afterwards.
 *
 * GUIDANCE FOLDS AT STEP BOUNDARIES (decision 24). `steer_run` appends the
 * rep's guidance to the run's session when no step of it is in flight here,
 * and otherwise queues it in this process until the step in flight has ended
 * (`RunEngine`), so the step that reads it is always the NEXT agent step.
 *
 * WHAT THE THREAD IS TOLD (decision 11): `run.started` when the engine first
 * takes a run, `run.step` after each step, `run.suspended` when a wait parks
 * it, and `run.finished` or `run.failed` at its end — raised after the commit
 * that made each true, ids and words only. Only the two endings wake a turn
 * (boundary #327, F4): a start, a step and a suspension are lines the day's
 * session keeps for the next turn.
 *
 * A RUN'S CHILDREN ARE RUNS (ticket #324; ADR-0012: an `each` forks the
 * session, and a child run has the full state set). An `each` step makes one
 * row per item, each with its own content and a session the SDK forks from its
 * parent's at that instant, and parks the parent; the pass drives the
 * children as it drives every run, so one child's wait holds nobody else, and
 * the parent is due when every child has ended — well or not. A child reports
 * through its parent: it posts no ending of its own and the thread hears
 * nothing of it, and the parent's report is written over what the children
 * ended with.
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { Bundle, WorkspaceVersion } from "@dito/bundle";
import type { Dek } from "@dito/crypto";
import {
  DEFAULT_MAX_TOKENS,
  defineExecution,
  ExecutionError,
  executionAuditEntry,
  isDisposition,
  isSdkTool,
  NOW_RECIPE,
  openSession,
  renderParts,
  runExecution,
  sessionFile,
  sessionShapeOf,
  STANDARD_RECIPES,
  type Disposition,
  type EffectOutcome,
  type ExecutionAuditChain,
  type ExecutionDefinition,
  type ExecutionOutcome,
  type ExecutionRecord,
  type Harness,
  type Effort,
  type Lane,
  type NamedPart,
  type ReadDisposition,
  type RunStepTrigger,
  type Session,
  type SessionShape,
  type StructuredOutputContract,
  type Trigger,
  type Trace,
  type TurnEnding,
  type Wake,
  type WakeSettlement,
  workspaceOf,
  workspacePath,
} from "@dito/execution";
import type pg from "pg";
import { waitingCandidates } from "../canvas.js";
import { DETERMINISTIC_INSTRUCTIONS } from "../dashboard-acts.js";
import type { Embedder } from "../embedder.js";
import type { ModelCallConfig } from "../model-config.js";
import { traceFor, type RuntimeTrace } from "../trace-render.js";
import { TwinExecutionStore, twinExecutionChain } from "../execution-store.js";
import { RUN_REPORTS } from "../grammar.js";
import { snapshotWorkspace } from "../workspace.js";
import { DEFAULT_REP_LANGUAGE, repLanguageLine } from "../rep-language.js";
import type { BatchWork } from "../lanes.js";
import { insertNoticeWithSystemSend } from "../notices.js";
import { composeAnswerPost, composeReceiptPost, documentPart, listPart } from "../posts.js";
import { ActSlot } from "../thread/acts.js";
import type { ThreadDeps, ThreadTrigger } from "../thread/deps.js";
import { TurnDraftTiming } from "../thread/draft-timing.js";
import { HeldDraftSlot, landDraft, type DraftTwin } from "../drafts.js";
import type { HandOver } from "../hand-over.js";
import { TurnBindingProposal } from "../thread/propose-binding.js";
import type { RaisedThreadEvent, ThreadEventSink } from "../thread/events.js";
import { typedReferencedName } from "../thread/guard.js";
import {
  customersOf,
  mentionsIn,
  renderNames,
  parseReference,
  referencesIn,
  REFERENCE_EXAMPLE,
  type Customers,
} from "../thread/references.js";
import { ServedHits } from "../thread/served.js";
import { THREAD_TOOL_DECLARATIONS } from "../thread/tools.js";
import { askFieldsOf, postAskCard } from "./ask.js";
import { THREAD_OWN_TOOLS } from "./catalog.js";
import { readRunContent, writeRunContent, type RunContent } from "./content.js";
import { bind, CONVERSATION_RECIPES, type Conversation } from "./conversation.js";
import { resolvableOnly } from "./read.js";
import {
  holds,
  layout,
  MAX_REPEATS,
  MAX_RUN_NAME,
  MAX_WAIT_MS,
  nextAfter,
  outputSchema,
  runDigest,
  sourceValue,
  spanMs,
  valueOf,
  whileOutput,
  type LaidStep,
  type RunDefinition,
  type SpanSpec,
  type StepKind,
  type OutputFieldType,
  type RunValue,
  type RunValues,
} from "./definition.js";
import { gateFactsOf, runGate } from "./gate.js";
import { RUN_RECIPES } from "./recipes.js";
import { stepReadsOf } from "./run-reads.js";
import {
  beginStep,
  childrenEnded,
  childrenOf,
  endRun,
  endStep,
  fireWait,
  insertRun,
  liveRuns,
  moveSession,
  moveTo,
  parkStep,
  readRun,
  scheduleWait,
  spend,
  stepStartedAt,
  stepsOf,
  waitScheduleOf,
  type RunRow,
  type RunStepRow,
} from "./store.js";

/** What the engine needs of the runtime: the stores, the keys, the harness, the thread. */
export interface RunDeps {
  readonly db: pg.ClientBase;
  readonly executionPool: pg.Pool;
  readonly harness: Harness;
  readonly bundle: Bundle;
  readonly dek: Dek;
  readonly twinId: string;
  readonly selfChatJid: string;
  readonly hmacKey: Uint8Array;
  readonly embedder: Embedder;
  readonly drafting: ModelCallConfig;
  /** The rung extraction's steps run on, when the deployment routes it apart (ADR-0015 as amended). */
  readonly extraction?: ModelCallConfig;
  readonly timeZone?: string;
  readonly repLanguage?: string;
  /** How much of a chat's history an extraction step is shown before its window. */
  readonly historyLimit?: number;
  /** The hour of the rep's day the clock fires the day's extraction and disclosure at. */
  readonly disclosureHour?: number;
  /** Where a step's per-call trace goes, if anywhere — the rig's debug view, never a log (#177 hotfix 1). */
  readonly trace?: RuntimeTrace;
  readonly threadSessions?: ThreadEventSink;
  readonly runs?: RunEngine;
}

/**
 * WHAT THIS PROCESS KNOWS ABOUT ITS RUNS, AND NOTHING THE STORE DOES NOT ALSO
 * SAY: which runs it holds right now — a step in flight, or a steer appending
 * — with the guidance that arrived while it held them, and whether it has
 * settled the runs an earlier process left mid-step.
 *
 * ONE PER PROCESS, held by the composition root beside the thread's sessions
 * and handed to the thread's tools, so a steer and a step of the same run
 * never write one session file from two children at once.
 */
export interface RunEngine {
  /** Claims a run for this process; `false` when something here already holds it. */
  claim(runId: string): boolean;
  /** Queues guidance for a run something here holds; `false` when nothing does. */
  queue(runId: string, guidance: string): boolean;
  /** Takes the guidance queued for a held run. */
  drain(runId: string): readonly string[];
  /** Lets the run go; guidance still queued is handed back for the caller to append. */
  release(runId: string): readonly string[];
  /** Whether this process has ended the runs an earlier one left `running`. */
  strandedSettled: boolean;
}

export function createRunEngine(): RunEngine {
  const held = new Map<string, string[]>();
  return {
    claim(runId) {
      if (held.has(runId)) return false;
      held.set(runId, []);
      return true;
    },
    queue(runId, guidance) {
      const queued = held.get(runId);
      if (queued === undefined) return false;
      queued.push(guidance);
      return true;
    },
    drain(runId) {
      const queued = held.get(runId) ?? [];
      held.set(runId, []);
      return queued;
    },
    release(runId) {
      const queued = held.get(runId) ?? [];
      held.delete(runId);
      return queued;
    },
    strandedSettled: false,
  };
}


/** What an id looks like, checked before one reaches a `uuid` cast. */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** The wake a run's step declares: the runs engine asks for it. */
const RUN_STEP_WAKE: Wake = { kind: "trigger", mechanism: "request", occasion: "run_step" };

/**
 * ONE PASS OF THE CLOCK AND THE ENGINE, for one twin at `now`.
 *
 * NEVER THROWS FOR A RUN'S SAKE: a run whose step fails ends `failed` inside
 * its own task, and the lane's settle is where an infrastructure fault
 * underneath a step surfaces, as every other lane's does.
 */
export async function advanceRuns(
  deps: RunDeps & { readonly runs: RunEngine },
  now: Date,
  batch: BatchWork,
): Promise<void> {
  const engine = deps.runs;
  if (!engine.strandedSettled) {
    await settleStranded(deps, engine);
    engine.strandedSettled = true;
  }
  const runs = await liveRuns(deps.db, deps.twinId);
  if (runs.length === 0) return;
  const steps = await stepsOf(
    deps.db,
    runs.map((run) => run.id),
  );
  let waitingCards: ReadonlySet<string> | undefined;
  for (const run of runs) {
    const verdict = runGate(await gateFactsOf(deps.db, run));
    if (verdict === "hold") continue;
    if (verdict === "advance" && run.state === "waiting") {
      const due = await waitIsDue(deps, run, steps.get(run.id) ?? [], now, async () => {
        waitingCards ??= new Set(await waitingCandidates({ db: deps.db, twinId: deps.twinId }, now));
        return waitingCards;
      });
      if (!due) continue;
    }
    if (run.state === "running") continue;
    if (!engine.claim(run.id)) continue;
    batch.lane.submit(async () => {
      try {
        if (verdict === "end") await endCancelled(deps, run.id);
        else await driveRun(deps, run.id, now);
      } finally {
        await releaseAfterGuidance(engine, run.id, (guidance) => appendQueued(deps, run.id, guidance));
      }
    });
  }
}

/**
 * Whether a waiting run's wait has come due at `now`: the card it watches
 * settled — answered, for a question card — every child of its `each` ended,
 * the customer it waits on replied, or its instant on the clock store reached
 * (the row stamped `fired_at` here, once).
 */
async function waitIsDue(
  deps: RunDeps,
  run: RunRow,
  steps: readonly RunStepRow[],
  now: Date,
  waitingCards: () => Promise<ReadonlySet<string>>,
): Promise<boolean> {
  const checkpoint = steps.find((step) => step.step_index === run.current_step);
  if (checkpoint?.awaits_post_id != null) {
    return !(await waitingCards()).has(checkpoint.awaits_post_id);
  }
  if (checkpoint?.kind === "each") return await childrenEnded(deps.db, run.id);
  if (checkpoint?.kind === "wait" && replyCameIn(deps, run, checkpoint.started_at)) return true;
  const schedule = await waitScheduleOf(deps.db, run.id, run.current_step);
  if (schedule === undefined || schedule.fireAt > now) return false;
  return schedule.firedAt !== null || (await fireWait(deps.db, { runId: run.id, step: run.current_step, at: now }));
}

/**
 * WHETHER THE CUSTOMER A REPLY WAIT WATCHES HAS WRITTEN SINCE IT BEGAN — read
 * off the bundle's message index, the instant and the id and never the words
 * (`wa_events` holds the chat only inside its sealed payload). A run whose
 * content cannot be read is not due here; its next drive ends it.
 */
function replyCameIn(deps: RunDeps, run: RunRow, since: Date): boolean {
  try {
    const content = readRunContent(deps.harness.directory, deps.dek, run.id, run.definition_digest);
    const step = layout(content.definition)[run.current_step];
    if (step?.kind !== "wait" || !("reply" in step.until)) return false;
    const chats = chatsOf(deps, valueOf(step.until.reply, { inputs: content.inputs, outputs: content.outputs }));
    return chats !== undefined && deps.bundle.firstMessageFromOtherSideAfter(chats, since.toISOString()) !== undefined;
  } catch {
    return false;
  }
}

/** The chats of the customer a field names by reference, or nothing. */
function chatsOf(deps: RunDeps, value: RunValue | undefined): readonly string[] | undefined {
  if (typeof value !== "string") return undefined;
  const reference = referencesIn(value)[0] ?? parseReference(value);
  if (reference === undefined) return undefined;
  const customer = customersOf(deps.bundle, deps.selfChatJid)(reference);
  return customer === undefined || customer.chats.length === 0 ? undefined : customer.chats.map((chat) => chat.chatJid);
}

// ─── one run, step by step ──────────────────────────────────────────────

/**
 * A step's ending, as the step's own code reports it.
 *
 * `parked` waits on the clock (`fireAt`), on a card (`awaitsPostId`) — a
 * question card the step itself posted when `asked` — or, with neither, on the
 * children its `each` made.
 */
type StepEnding =
  | { readonly kind: "done"; readonly output: Readonly<Record<string, RunValue>>; readonly disposition: Disposition }
  | { readonly kind: "parked"; readonly awaitsPostId?: string; readonly fireAt?: Date; readonly asked?: true }
  | { readonly kind: "failed"; readonly disposition: Disposition };

/** What one step left: its ending, and the model turn's own record when it was an agent step. */
interface StepResult {
  readonly ending: StepEnding;
  readonly record?: ExecutionRecord;
}

/**
 * Takes one run from where it stands until a step parks it, the run ends, or
 * the gate holds it at a step boundary.
 *
 * EACH STEP IS TWO COMMITS. The boundary — flags and seat re-read, the
 * checkpoint written `running` — commits first, so a process that dies inside
 * the step leaves a run that says so. Then the step's work and its ending
 * commit together on one connection: the agent turn's record and chain entry,
 * an act's own rows, a report post, the checkpoint's end, the spend and where
 * the run goes next — all of it or none.
 */
async function driveRun(deps: RunDeps, runId: string, now: Date): Promise<void> {
  // THE REPORT THE RUN POSTED LAST in this drive, which its end names.
  let reported: string | undefined;
  for (;;) {
    // READ ON THE LANE'S OWN CONNECTION, never the pass's: the pass may be
    // inside a transaction of its own by the time this task runs.
    const boundary = await withClient(deps, async (client) => {
      const run = await readRun(client, deps.twinId, runId);
      return run === undefined
        ? undefined
        : { run, facts: await gateFactsOf(client, run) };
    });
    if (boundary === undefined || boundary.run.ended_at !== null) return;
    const { run } = boundary;
    const verdict = runGate(boundary.facts);
    if (verdict === "end") {
      await endCancelled(deps, runId);
      return;
    }
    if (verdict === "hold") return;
    let content: RunContent;
    let laid: readonly LaidStep[];
    try {
      content = readRunContent(deps.harness.directory, deps.dek, run.id, run.definition_digest);
      laid = layout(content.definition);
    } catch (error) {
      await failRun(deps, run, error);
      return;
    }
    const step = laid[run.current_step]!;
    const resumingWait = run.state === "waiting";
    const begun = await withClient(deps, (client) =>
      withTransaction(client, () => beginStep(client, { runId, step: step.index, kind: step.kind })),
    );
    if (!begun) return;
    if (run.started_at === null) tell(deps, run, { kind: "run.started", runId });
    const executionId = randomUUID();
    const startedAt = new Date();
    const values: RunValues = { inputs: content.inputs, outputs: content.outputs };
    let moved: { readonly ending: StepEnding; readonly next?: number; readonly posted?: string } | undefined;
    try {
      moved = await withClient(deps, (client) =>
        withTransaction(client, async () => {
          const result = await runStep(client, deps, run, step, content, values, executionId, now, resumingWait);
          return await settleStep(client, deps, { run, step, laid, content, result, executionId, startedAt });
        }),
      );
    } catch (error) {
      await failRun(deps, run, error);
      return;
    }
    const { ending } = moved;
    reported = moved.posted ?? reported;
    if (ending.kind === "parked") {
      tell(deps, run, { kind: "run.suspended", runId, step: step.index });
      return;
    }
    tell(deps, run, { kind: "run.step", runId, step: step.index, state: ending.kind === "done" ? "succeeded" : "failed" });
    if (ending.kind === "failed") {
      tell(deps, run, { kind: "run.failed", runId, step: step.index, ...(reported === undefined ? {} : { postId: reported }) });
      return;
    }
    if (moved.next === undefined) {
      tell(deps, run, { kind: "run.finished", runId, state: "succeeded", ...(reported === undefined ? {} : { postId: reported }) });
      return;
    }
  }
}

/**
 * A step's ending, written inside the step's own transaction: parked, failed
 * with its report, or done — its output in the run's content, its record, and
 * the run moved to the next step or ended.
 */
async function settleStep(
  client: pg.ClientBase,
  deps: RunDeps,
  args: {
    readonly run: RunRow;
    readonly step: LaidStep;
    readonly laid: readonly LaidStep[];
    readonly content: RunContent;
    readonly result: StepResult;
    readonly executionId: string;
    readonly startedAt: Date;
  },
): Promise<{ readonly ending: StepEnding; readonly next?: number; readonly posted?: string }> {
  const { run, step, content, result, executionId } = args;
  const { ending, record } = result;
  // THE STEP BOUNDARY VERSIONS THE WORKSPACE (ticket #326; ADR-0011 as
  // amended), whatever the step's ending, and before a report is composed —
  // so a `post` names the version this boundary took.
  await snapshotWorkspace(deps, { executionId, runId: run.id, sessionId: run.session_id, now: new Date() });
  if (ending.kind === "parked") {
    // A STEP THAT ASKED LEAVES ITS EXECUTION NOW (ticket #324): the agent
    // turn that called the ask tool, settled `asked`, or the `ask` step that
    // posted its card — the card names that execution, and the step's later
    // resumption is an execution of its own.
    if (record !== undefined) {
      await spend(client, { runId: run.id, iterations: record.iterations, tokens: record.tokens.input + record.tokens.output });
    }
    if (record !== undefined || ending.asked === true) {
      await recordStep(client, deps, {
        runId: run.id,
        step: step.index,
        executionId,
        startedAt: args.startedAt,
        disposition: "asked",
        ...(record === undefined ? {} : { record }),
      });
    }
    await parkStep(client, {
      runId: run.id,
      step: step.index,
      ...(ending.awaitsPostId === undefined ? {} : { awaitsPostId: ending.awaitsPostId }),
    });
    return { ending };
  }
  if (record !== undefined) {
    await spend(client, {
      runId: run.id,
      iterations: record.iterations,
      tokens: record.tokens.input + record.tokens.output,
    });
  }
  if (ending.kind === "failed") {
    const posted = await closeRun(client, deps, {
      run,
      step: step.index,
      kind: step.kind,
      executionId,
      startedAt: args.startedAt,
      disposition: ending.disposition,
      ...(record === undefined ? {} : { record }),
      sentence: RUN_REPORTS.failed(content.definition.name, step.index + 1, run.step_count),
    });
    return { ending, posted };
  }
  // A CHILD'S POST IS ITS LINE IN ITS PARENT'S REPORT, never a card of its own
  // (Codex r1): the parent reports over its children (`childLine`).
  const report =
    step.kind === "post"
      ? run.parent_run_id === null
        ? postText(step, content)
        : undefined
      : step.kind === "end"
        ? endReport(run, step, args.laid, content)
        : undefined;
  // THE STEP'S RECORD READS WHAT THE STEP DOES (ticket #358): a `post` or an
  // `end` with a report lands it as a card — the post below, in this same
  // transaction, or none of it commits — so it is `posted`; one with nothing
  // to report lands none and is `no-action`.
  await recordStep(client, deps, {
    runId: run.id,
    step: step.index,
    executionId,
    startedAt: args.startedAt,
    disposition: step.kind === "post" || step.kind === "end" ? (report === undefined ? "no-action" : "posted") : ending.disposition,
    ...(record === undefined ? {} : { record }),
  });
  // A POST STEP'S OUTPUT IS ITS POST'S ID (Codex r1): the report is written
  // before the step's output, so a later step that names `<post>.post_id`
  // reads the card it is.
  const posted =
    report === undefined
      ? undefined
      : await postReport(client, deps, executionId, report, step.kind === "post" ? besideTheReport(deps, run, step, content) : {});
  const output =
    step.kind !== "post"
      ? ending.output
      : posted === undefined
        ? { ...ending.output, text: postText(step, content)?.text ?? "" }
        : { ...ending.output, post_id: posted };
  const outputs = { ...content.outputs, [step.name]: output };
  const next = nextAfter(args.laid, step.index, { inputs: content.inputs, outputs });
  await endStep(client, { runId: run.id, step: step.index, kind: step.kind, state: "succeeded", executionId });
  writeRunContent(deps.harness.directory, deps.dek, run.id, { ...content, outputs });
  if (next === undefined) await endRun(client, run.id, "succeeded");
  else await moveTo(client, run.id, next);
  return {
    ending,
    ...(next === undefined ? {} : { next }),
    ...(posted === undefined ? {} : { posted }),
  };
}

/** The run's one budget is spent: the run ends rather than begin a model turn it cannot pay for. */
class BudgetSpent extends Error {
  override readonly name = "BudgetSpent";
  constructor() {
    super("the run's budget is spent");
  }
}

/** One step's own work, by its kind, on the step's own transaction. */
async function runStep(
  client: pg.ClientBase,
  deps: RunDeps,
  run: RunRow,
  step: LaidStep,
  content: RunContent,
  values: RunValues,
  executionId: string,
  now: Date,
  resumingWait: boolean,
): Promise<StepResult> {
  switch (step.kind) {
    case "agent":
      return await runAgentStep(client, deps, run, step, content, values, executionId, now, resumingWait);
    case "code": {
      const inputs = Object.fromEntries(
        Object.entries(step.inputs).map(([key, ref]) => [key, valueOf(ref, values)]),
      );
      const output = await RUN_RECIPES[step.recipe]!(inputs, { db: client, deps, now });
      return { ending: { kind: "done", output, disposition: "no-action" } };
    }
    case "act":
      return { ending: await runActStep(client, deps, run, step, values, executionId, now) };
    case "ask":
      return { ending: await runAskStep(client, deps, step, content, values, executionId, resumingWait) };
    case "post":
      // A DOCUMENT A RUN'S OWN REPORT NAMES AND THE WORKSPACE NEVER HELD
      // fails the step as a report with nothing to say does (ticket #326):
      // the rep would be handed a card that opens nothing. A child's post is
      // its line in its parent's report, which carries no document.
      return postText(step, content) === undefined ||
        (step.document !== undefined && run.parent_run_id === null && documentOf(deps, run, step, content) === undefined)
        ? { ending: { kind: "failed", disposition: "failed" } }
        : { ending: { kind: "done", output: {}, disposition: "posted" } };
    case "wait":
      return { ending: await runWaitStep(client, deps, run, step, values, now, resumingWait) };
    case "each":
      return { ending: await runEachStep(client, deps, run, step, content, values, resumingWait) };
    case "while": {
      const cap = sourceValue(step.cap, values);
      return typeof cap === "number" && Number.isSafeInteger(cap) && cap >= 0 && cap <= MAX_REPEATS
        ? { ending: { kind: "done", output: whileOutput(step, values, cap), disposition: "no-action" } }
        : { ending: { kind: "failed", disposition: "failed" } };
    }
    case "end": {
      const value = step.value === undefined ? undefined : valueOf(step.value, values);
      return { ending: { kind: "done", output: value === undefined ? {} : { value }, disposition: "no-action" } };
    }
    case "if":
      return {
        ending: {
          kind: "done",
          output: { taken: holds(step.when, values) ? "then" : "else" },
          disposition: "no-action",
        },
      };
  }
}

/**
 * A report's text from the field a `post` or an `end` names: a string as it
 * is, a list one line per item — or nothing, when there is nothing to say.
 */
function reportText(value: RunValue | undefined): string | undefined {
  const text = Array.isArray(value)
    ? value.filter((line) => line.trim() !== "").join("\n")
    : typeof value === "string"
      ? value
      : undefined;
  return text === undefined || text.trim() === "" ? undefined : text;
}

/**
 * WHAT A RUN'S REPORT SAYS (ticket #358): the twin's words from a typed field,
 * posted as prose — or code's sentence, posted as a receipt (ADR-0037 as
 * amended: a receipt is chrome, never the twin's speech).
 */
interface RunReport {
  readonly kind: "prose" | "receipt";
  readonly text: string;
}

/**
 * WHAT A `post` POSTS: its field as a report — or, for a list that came back
 * empty (an `each` over nobody the rep chose), code's sentence that the run is
 * done, since an empty answer is an answer and not a failure.
 */
function postText(step: Extract<LaidStep, { kind: "post" }>, content: RunContent): RunReport | undefined {
  const value = valueOf(step.text, { inputs: content.inputs, outputs: content.outputs });
  const said = reportText(value);
  if (said !== undefined) return { kind: "prose", text: said };
  return Array.isArray(value) ? { kind: "receipt", text: RUN_REPORTS.finished(content.definition.name) } : undefined;
}

/**
 * WHAT A RUN'S REPORT HANDS THE REP BESIDE ITS WORDS (ticket #326): the list
 * its `list` names, one row per item, and the workspace document its
 * `document` names (`documentOf`).
 */
function besideTheReport(
  deps: RunDeps,
  run: RunRow,
  step: Extract<LaidStep, { kind: "post" }>,
  content: RunContent,
): ReportBeside {
  const listed = step.list === undefined ? undefined : valueOf(step.list, { inputs: content.inputs, outputs: content.outputs });
  const list = Array.isArray(listed) ? listed.filter((row) => row.trim() !== "") : [];
  const document = documentOf(deps, run, step, content);
  return {
    ...(list.length === 0 ? {} : { list }),
    ...(document === undefined ? {} : { document }),
  };
}

/**
 * The workspace document a `post` names — or nothing when it names none the
 * workspace holds: the newest version this run's own boundaries took, or,
 * when another boundary versioned the file first, the newest there is. The
 * workspace is the twin's one directory, so two pieces of work at once may
 * reach a boundary over the other's file.
 */
function documentOf(
  deps: Pick<RunDeps, "harness" | "bundle">,
  run: Pick<RunRow, "id">,
  step: Extract<LaidStep, { kind: "post" }>,
  content: RunContent,
): WorkspaceVersion | undefined {
  if (step.document === undefined) return undefined;
  const path = valueOf(step.document, { inputs: content.inputs, outputs: content.outputs });
  if (typeof path !== "string" || path.trim() === "") return undefined;
  const versions = deps.bundle.listWorkspaceVersions(workspacePath(workspaceOf(deps.harness), path.trim()));
  return versions.filter((version) => version.runId === run.id).at(-1) ?? versions.at(-1);
}

/**
 * WHAT AN `end` POSTS: its value, when it names one; otherwise code's
 * sentence that the run is done — unless a `post` already reported on this
 * run, which said what there was to say. A child posts nothing: its parent
 * reports over it.
 */
function endReport(
  run: RunRow,
  step: Extract<LaidStep, { kind: "end" }>,
  laid: readonly LaidStep[],
  content: RunContent,
): RunReport | undefined {
  if (run.parent_run_id !== null) return undefined;
  const values: RunValues = { inputs: content.inputs, outputs: content.outputs };
  const said = step.value === undefined ? undefined : reportText(valueOf(step.value, values));
  if (said !== undefined) return { kind: "prose", text: said };
  const reported = laid.some((other) => other.kind === "post" && Object.hasOwn(content.outputs, other.name));
  return reported ? undefined : { kind: "receipt", text: RUN_REPORTS.finished(content.definition.name) };
}

/**
 * AN `ask`: the card posted under this step's execution — the question the
 * definition names, its fields rendered by code — and the run parked on it;
 * resumed, the rep's typed answer is the step's output (`ask.ts`).
 */
async function runAskStep(
  client: pg.ClientBase,
  deps: RunDeps,
  step: Extract<LaidStep, { kind: "ask" }>,
  content: RunContent,
  values: RunValues,
  executionId: string,
  resuming: boolean,
): Promise<StepEnding> {
  if (resuming) {
    const answer = content.answers?.[step.name];
    return answer === undefined
      ? { kind: "failed", disposition: "failed" }
      : { kind: "done", output: answer, disposition: "no-action" };
  }
  const question = sourceValue(step.question, values);
  if (typeof question !== "string" || question.trim() === "") return { kind: "failed", disposition: "failed" };
  const customers = customersOf(deps.bundle, deps.selfChatJid);
  const drafts = [];
  for (const field of step.fields) {
    const label = field.label === undefined ? undefined : sourceValue(field.label, values);
    const options = field.options === undefined ? undefined : sourceValue(field.options, values);
    if ((label !== undefined && typeof label !== "string") || (options !== undefined && !Array.isArray(options))) {
      return { kind: "failed", disposition: "failed" };
    }
    drafts.push({
      name: field.name,
      kind: field.kind,
      ...(label === undefined ? {} : { label }),
      ...(options === undefined ? {} : { options: options as readonly string[] }),
    });
  }
  const rendered = askFieldsOf(drafts, customers);
  if ("refused" in rendered) return { kind: "failed", disposition: "failed" };
  const postId = await postAskCard(client, {
    twinId: deps.twinId,
    selfChatJid: deps.selfChatJid,
    dek: deps.dek,
    executionId,
    question: resolvableOnly(question.trim(), customers),
    customers,
    fields: rendered.fields,
  });
  return { kind: "parked", awaitsPostId: postId, asked: true };
}

/**
 * AN `each`: one child run per item of its list, at most `MAX_REPEATS` — each
 * with its own row, its own content (the parent's inputs and its item), its
 * share of what the parent's budget has left, and its own session forked from
 * the parent's at this instant — and the parent parked until every child has
 * ended. Resumed, the step's output is the
 * children's ids, a line for each — the text of the latest step that said
 * something, or code's sentence for one that failed or said nothing — and how
 * many failed.
 */
async function runEachStep(
  client: pg.ClientBase,
  deps: RunDeps,
  run: RunRow,
  step: Extract<LaidStep, { kind: "each" }>,
  content: RunContent,
  values: RunValues,
  resuming: boolean,
): Promise<StepEnding> {
  if (resuming) {
    const since = await stepStartedAt(client, run.id, step.index);
    const children = since === undefined ? [] : await childrenOf(client, run.id, since);
    return {
      kind: "done",
      output: {
        children: children.map((child) => child.id),
        outputs: children.map((child) => childLine(deps, child)),
        failed: children.filter((child) => child.state === "failed").length,
      },
      disposition: "no-action",
    };
  }
  const items = sourceValue(step.over, values);
  if (!Array.isArray(items) || items.length > MAX_REPEATS) return { kind: "failed", disposition: "failed" };
  if (items.length === 0) {
    return { kind: "done", output: { children: [], outputs: [], failed: 0 }, disposition: "no-action" };
  }
  // ONE BUDGET PER RUN, SHARED WITH ITS CHILDREN (decision 23; Codex r1): what
  // the parent has left, split evenly between them — and a fan-out the parent
  // cannot fund at one call and one token a child is refused, so a run and
  // every child it makes spend at most what the run was given.
  const budget = {
    iterations: Math.floor((run.budget_iterations - run.spent_iterations) / items.length),
    tokens: Math.floor((run.budget_tokens - run.spent_tokens) / items.length),
  };
  if (budget.iterations < 1 || budget.tokens < 1) throw new BudgetSpent();
  // ...AND WHAT THE CHILDREN ARE GIVEN IS SPENT BY THE PARENT NOW (Codex r2),
  // so its later steps see only what is left after them.
  await spend(client, { runId: run.id, iterations: budget.iterations * items.length, tokens: budget.tokens * items.length });
  for (const item of items) {
    const definition: RunDefinition = {
      name: childName(content.definition.name, item),
      budget,
      steps: step.body,
    };
    const childId = randomUUID();
    const sessionId = await forkRunSession(
      deps,
      run.session_id,
      `[Run "${definition.name}" · a child of run ${run.id}, for one item] This conversation goes on from here for this item alone: ${JSON.stringify({ [step.item]: item })}.`,
    );
    writeRunContent(deps.harness.directory, deps.dek, childId, {
      definition,
      inputs: { ...content.inputs, [step.item]: item },
      outputs: {},
    });
    await insertRun(client, {
      id: childId,
      twinId: deps.twinId,
      seatId: run.seat_id,
      automation: run.automation,
      digest: runDigest(definition),
      sessionId,
      stepCount: layout(definition).length,
      budget: definition.budget,
      createdBy: run.created_by,
      parentRunId: run.id,
      // A RUTINA'S CHILD IS THE RUTINA'S (ticket #325's switch reaches it).
      ...(run.automation_id === null ? {} : { fired: { id: run.automation_id } }),
    });
  }
  return { kind: "parked" };
}

/** A child's name: its parent's, and the item it is for — a customer by reference. */
function childName(parent: string, item: string): string {
  const suffix = ` · ${item}`;
  return `${parent.slice(0, Math.max(1, MAX_RUN_NAME - suffix.length)).trim()}${suffix}`.slice(0, MAX_RUN_NAME);
}

/**
 * THE FORK (ADR-0012: an `each` forks the session per item), the SDK's own:
 * the child opens the parent's session with `forkSession`, takes the line that
 * says which item it is for, and exits — the SDK writes the whole
 * conversation on under a new id, which `moved` reports, and leaves the
 * parent's file as it was. A parent with no conversation yet has nothing to
 * fork, and its child opens a new session of its own. No model is asked
 * anything.
 */
async function forkRunSession(
  deps: RunDeps,
  parentSessionId: string,
  opening: string,
): Promise<string> {
  if (!existsSync(sessionFile(deps.harness.directory, parentSessionId))) {
    const sessionId = randomUUID();
    await appendToRunSession(deps.harness, deps.drafting.model, sessionId, [opening]);
    return sessionId;
  }
  let forked: string | undefined;
  await appendToRunSession(deps.harness, deps.drafting.model, parentSessionId, [opening], {
    fork: (to) => (forked = to),
  });
  if (forked === undefined) throw new Error("the SDK did not fork the parent's session for a child run");
  return forked;
}

/**
 * WHAT ONE CHILD ENDED WITH, as one line of its parent's report: the text
 * fields of the step it ended at — an agent's typed strings and lists, or an
 * `end`'s value — or, for a child that failed, code's sentence saying where it
 * stopped.
 */
function childLine(deps: RunDeps, child: RunRow): string {
  let content: RunContent;
  try {
    content = readRunContent(deps.harness.directory, deps.dek, child.id, child.definition_digest);
  } catch {
    return RUN_REPORTS.failed("", child.current_step + 1, child.step_count);
  }
  if (child.state === "failed") {
    return child.cancelled
      ? RUN_REPORTS.cancelled(content.definition.name)
      : RUN_REPORTS.failed(content.definition.name, child.current_step + 1, child.step_count);
  }
  // THE LATEST STEP THAT SAID SOMETHING (Codex r2): an `end` with no value
  // after an agent's result leaves that result as the child's line, and a
  // child that said nothing at all is still a line — code's sentence that it
  // is done — so every child that ended well stands in its parent's report.
  const laid = layout(content.definition);
  for (let index = Math.min(child.current_step, laid.length - 1); index >= 0; index -= 1) {
    const step = laid[index]!;
    const output = content.outputs[step.name];
    if (output === undefined) continue;
    const texts = Object.entries(output)
      .flatMap(([field, value]) => (textField(step, field) ? [Array.isArray(value) ? value.join(", ") : String(value)] : []))
      .filter((text) => text.trim() !== "");
    if (texts.length > 0) return texts.join(" · ");
  }
  return RUN_REPORTS.finished(content.definition.name);
}

/** Whether a field of a step's output is text a line can carry — never an id or a flag. */
function textField(step: LaidStep, field: string): boolean {
  if (step.kind === "agent") return step.output?.[field] === "string" || step.output?.[field] === "list";
  if (step.kind === "end") return field === "value";
  if (step.kind === "post") return field === "text";
  if (step.kind === "ask") return step.fields.some((asked) => asked.name === field && asked.kind !== "date");
  return false;
}

/**
 * A wait: due already — the clock fired it, the card settled, or its instant
 * has passed — or parked until it is.
 */
async function runWaitStep(
  client: pg.ClientBase,
  deps: RunDeps,
  run: RunRow,
  step: Extract<LaidStep, { kind: "wait" }>,
  values: RunValues,
  now: Date,
  resumingWait: boolean,
): Promise<StepEnding> {
  const until = step.until;
  if ("reply" in until) return await runReplyWait(client, deps, run, step, until, values, now, resumingWait);
  if (resumingWait) return { kind: "done", output: {}, disposition: "no-action" };
  if ("settle" in until) {
    // THE CARD IS ONE OF THIS TWIN'S POSTS, or the wait fails: an id an
    // earlier step got wrong is never a wait that passes at once.
    const postId = valueOf(until.settle, values);
    if (typeof postId !== "string" || !UUID_SHAPE.test(postId)) return { kind: "failed", disposition: "failed" };
    const own = await client.query("SELECT 1 FROM posts WHERE id = $1 AND twin_id = $2", [postId, deps.twinId]);
    if (own.rowCount === 0) return { kind: "failed", disposition: "failed" };
    const waiting = new Set(await waitingCandidates({ db: client, twinId: deps.twinId }, now));
    return waiting.has(postId)
      ? { kind: "parked", awaitsPostId: postId }
      : { kind: "done", output: {}, disposition: "no-action" };
  }
  const fireAt = "at" in until ? new Date(until.at) : new Date(now.getTime() + spanMs(until.after));
  // A WAIT A `while` REACHES AGAIN WAITS AGAIN (ticket #324): its row is
  // written anew rather than found fired from the pass before.
  const again = Object.hasOwn(values.outputs, step.name);
  const scheduled = await scheduleWait(client, { twinId: deps.twinId, runId: run.id, step: step.index, fireAt, again });
  if (scheduled > now) return { kind: "parked", fireAt: scheduled };
  // AN INSTANT ALREADY PAST FIRES UNDER THE GATE TOO (Codex r3): a pause or a
  // cancel that landed since the step began refuses the fire, and the wait
  // parks for the pass to fire it when the gate allows.
  return (await fireWait(client, { runId: run.id, step: step.index, at: now }))
    ? { kind: "done", output: {}, disposition: "no-action" }
    : { kind: "parked", fireAt: scheduled };
}

/**
 * A WAIT ON A CUSTOMER'S REPLY, WITH A DEADLINE (ticket #324): parked with the
 * deadline on the clock store, due when the customer writes or the deadline
 * passes (`waitIsDue`), and resumed with which side ended it — `replied`, and
 * the reply's id when they did. Nothing reads what they wrote.
 */
async function runReplyWait(
  client: pg.ClientBase,
  deps: RunDeps,
  run: RunRow,
  step: Extract<LaidStep, { kind: "wait" }>,
  until: { readonly reply: string; readonly within: SpanSpec },
  values: RunValues,
  now: Date,
  resumingWait: boolean,
): Promise<StepEnding> {
  const chats = chatsOf(deps, valueOf(until.reply, values));
  if (chats === undefined) return { kind: "failed", disposition: "failed" };
  if (resumingWait) {
    const since = await stepStartedAt(client, run.id, step.index);
    const reply = since === undefined ? undefined : deps.bundle.firstMessageFromOtherSideAfter(chats, since.toISOString());
    return {
      kind: "done",
      output: reply === undefined ? { replied: false } : { replied: true, message_id: reply.messageId },
      disposition: "no-action",
    };
  }
  const span: Record<string, number> = {};
  for (const [key, part] of Object.entries(until.within)) {
    const value = part === undefined ? undefined : sourceValue(part, values);
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return { kind: "failed", disposition: "failed" };
    span[key] = value;
  }
  const ms = spanMs(span);
  if (ms <= 0 || ms > MAX_WAIT_MS) return { kind: "failed", disposition: "failed" };
  const again = Object.hasOwn(values.outputs, step.name);
  const fireAt = await scheduleWait(client, {
    twinId: deps.twinId,
    runId: run.id,
    step: step.index,
    fireAt: new Date(now.getTime() + ms),
    again,
  });
  return { kind: "parked", fireAt };
}

/**
 * An `act`: exactly one call to one of the thread's tools, its parameters
 * mapped from typed fields and the definition's own values, behind the tool's
 * own gate — `create_draft` ends in a card behind the tap, `spotlight` and
 * `knock` are disclosed on the canvas. Its rows commit with the step's record.
 */
async function runActStep(
  client: pg.ClientBase,
  deps: RunDeps,
  run: RunRow,
  step: Extract<LaidStep, { kind: "act" }>,
  values: RunValues,
  executionId: string,
  now: Date,
): Promise<StepEnding> {
  const input = Object.fromEntries(
    Object.entries(step.inputs).map(([key, source]) => [
      key,
      typeof source === "string" ? valueOf(source, values) : source.value,
    ]),
  );
  if (THREAD_OWN_TOOLS.has(step.tool)) return { kind: "failed", disposition: "failed" };
  const conversation = await runConversationOf(client, deps, run, [step.tool], values, executionId, now);
  const tool = bind(conversation).tool(step.tool);
  if (tool === undefined || tool.gate === "projection") return { kind: "failed", disposition: "failed" };
  const outcome = await tool.run(input);
  if (!outcome.performed) return { kind: "failed", disposition: "failed" };
  // A DRAFT THE ACT HELD LANDS WITH IT (tickets #358, #368): `create_draft`
  // holds its draft for the turn's words, and an act has no model and so no
  // words — the card carries code's sentence, as one whose turn said nothing.
  const held = conversation.kind === "run" ? conversation.deps.draft.held : undefined;
  if (held !== undefined) await landDraft(client, draftTwinOf(deps), held, { words: "", mentions: [] });
  const posted = await client.query<{ id: string }>(
    "SELECT id FROM posts WHERE execution_id = $1 ORDER BY posted_at DESC, id LIMIT 1",
    [executionId],
  );
  return {
    kind: "done",
    output: { performed: true, ...(posted.rows[0] === undefined ? {} : { post_id: posted.rows[0].id }) },
    // THE TOOL'S OWN ACT WORD, read as an agent step's is (ticket #358).
    disposition: performedDisposition([outcome]) ?? "acted",
  };
}

/**
 * An `agent` step of a run: one model turn on the run's own session — new for
 * the run's first agent step, resumed for every later one — built and run as
 * every agent step is (`agentStepDefinition`, `runStepTurn`). The guidance
 * queued while an earlier step was in flight is appended first, so this turn
 * reads it. Its record and chain entry are the turn's own, on the step's
 * transaction. A turn whose `ask` left it waiting parks the step on the card;
 * resumed, the turn opens on the rep's answer.
 */
async function runAgentStep(
  client: pg.ClientBase,
  deps: RunDeps,
  run: RunRow,
  step: AgentStep,
  content: RunContent,
  values: RunValues,
  executionId: string,
  now: Date,
  resuming: boolean,
): Promise<StepResult> {
  const remaining = run.budget_iterations - run.spent_iterations;
  if (remaining < 1 || run.spent_tokens >= run.budget_tokens) throw new BudgetSpent();
  const trigger = stepTrigger(deps.twinId, run.id, step.index);
  // A STEP THAT ASKED IS WOKEN WITH THE ANSWER (ticket #324): the rep's typed
  // answer, as the first thing the resumed conversation reads.
  const answer = resuming ? content.answers?.[step.name] : undefined;
  if (resuming && answer === undefined) throw new Error(`step ${String(step.index)} resumed with no answer to the card it asked`);
  // THE RUNG IS THE AUTOMATION'S (ADR-0015 as amended): the day's extraction
  // reads on its own rung when the deployment routes one, every other step
  // on drafting's.
  const rung = run.automation === "extraction" ? (deps.extraction ?? deps.drafting) : deps.drafting;
  const conversation = await runConversationOf(
    client,
    deps,
    run,
    [...step.tools, ...(step.recipes ?? [])],
    values,
    executionId,
    now,
  );
  const definition = agentStepDefinition({
    step,
    conversation,
    frame: { kind: "run" },
    heading: `[Run "${content.definition.name}" · step ${String(step.index + 1)} of ${String(run.step_count)}: ${step.name}]`,
    values,
    laid: layout(content.definition),
    now,
    model: rung.model,
    ...(rung.effort === undefined ? {} : { effort: rung.effort }),
    // THE STEP'S ROUNDS ARE THE RUN'S BUDGET (ticket #396): what the twin gave
    // the run and the run has not spent, and no constant beside it.
    maxIterations: remaining,
    // NO CALL MAY WRITE PAST WHAT THE RUN HAS LEFT (Codex r1): each call's
    // output is capped at the tokens the budget still holds.
    maxTokens: Math.min(DEFAULT_MAX_TOKENS, run.budget_tokens - run.spent_tokens),
    lane: "batch",
    wake: RUN_STEP_WAKE,
    suspends: true,
    ...(answer === undefined ? {} : { answer }),
  });
  const turn = await runStepTurn({
    harness: deps.harness,
    definition,
    trigger,
    chain: twinExecutionChain(client, deps.hmacKey),
    conversation: { kind: "run", sessionId: run.session_id, guidance: () => deps.runs?.drain(run.id) ?? [] },
    ...traceFor(deps.trace, trigger),
  });
  if (turn.kind === "folded") throw new Error("a run's step folded into another wake");
  const { settlement, movedTo } = turn;
  if (movedTo !== undefined) await moveSession(client, run.id, movedTo);
  const { record } = settlement;
  // A DRAFT THE STEP WROTE LANDS WITH THE STEP'S WORDS (ticket #368): a run
  // never speaks in the bar (decision 25), so what its step finished on is the
  // sentence the card carries above the draft, as a turn's words are.
  const stepDeps = conversation.kind === "run" ? conversation.deps : undefined;
  const held = stepDeps?.draft.held;
  if (stepDeps !== undefined && held !== undefined && settlement.disposition !== "failed" && settlement.disposition !== "schema-miss") {
    const words = settlement.words.trim();
    await landDraft(client, draftTwinOf(deps), held, { words, mentions: mentionsIn(words, stepDeps.served.state().customers) });
  }
  switch (settlement.disposition) {
    // A MALFORMED TYPED OUTPUT FAILS THE STEP AS A FAILED TURN DOES, its
    // record saying which (ticket #357).
    case "failed":
    case "schema-miss":
      return { ending: { kind: "failed", disposition: settlement.disposition }, record };
    case "asked": {
      // THE TOOL POSTED AND THE TURN SETTLED `asked`: the engine parks the
      // step on the card the tool's own outcome names (ticket #324).
      const card = settlement.effects.find((effect) => effect.performed && effect.waitsOn !== undefined);
      if (card === undefined || !card.performed || card.waitsOn === undefined) {
        return { ending: { kind: "failed", disposition: "failed" }, record };
      }
      return { ending: { kind: "parked", awaitsPostId: card.waitsOn }, record };
    }
    default:
      return { ending: { kind: "done", output: settlement.output ?? {}, disposition: settlement.disposition }, record };
  }
}

/** The twin a run's draft is written for, and where its post goes (`landDraft`). */
function draftTwinOf(deps: StepDeps): DraftTwin {
  return {
    twinId: deps.twinId,
    selfChatJid: deps.selfChatJid,
    dek: deps.dek,
    ...(deps.timeZone === undefined ? {} : { timeZone: deps.timeZone }),
  };
}

/** One laid-out `agent` step. */
type AgentStep = Extract<LaidStep, { kind: "agent" }>;

/** What an agent step's typed output holds, field by field. */
export type StepOutput = Readonly<Record<string, RunValue>>;

/**
 * WHAT ONE AGENT STEP'S TURN DID (ticket #357): how it ended, its record,
 * what its tools did, the words it ended on and its typed output when it
 * declares one — the one reading the engine makes of a turn, for a run's
 * step and for a definition run with no run alike.
 */
export interface StepSettlement {
  readonly disposition: Disposition;
  readonly record: ExecutionRecord;
  readonly effects: readonly EffectOutcome[];
  readonly words: string;
  readonly output?: StepOutput;
}

/**
 * WHAT A STEP'S TURN IS FRAMED BY (tickets #357, #363): a run's step is told
 * Dito's parts about runs and then its own instructions; a one-step
 * definition with no run is told its own instructions and nothing else,
 * since they are the whole of what it is; and a step joining the day's
 * conversation is told what that session was told when its child opened
 * (`SessionShape`), since a session's system prompt, tools and budget are
 * fixed for the child's life and a turn that said anything else would be
 * refused.
 */
type StepFrame =
  | { readonly kind: "run" }
  | { readonly kind: "own" }
  | { readonly kind: "day"; readonly shape: SessionShape };

/** Which conversation a step's turn joins. */
type StepConversation<Tag> =
  | {
      /** The run's own session, opened new or resumed for the turn. */
      readonly kind: "run";
      readonly sessionId: string;
      /** What the rep said about the run since its last step, appended before the turn. */
      readonly guidance?: () => readonly string[];
    }
  /** One call of its own, kept nowhere: a turn with no run has no later turn to remember it. */
  | { readonly kind: "own" }
  | {
      /** The day's session, handed in. */
      readonly kind: "day";
      readonly session: Session<Tag>;
      readonly tag: Tag;
      /** When the turn may be handed to the session, and the call that says it was (`hand-over.ts`). */
      readonly handOver?: HandOver;
      /** Whether a rep's line pushed while it runs folds into it (D7): the thread's own turn on a line. */
      readonly folds: boolean;
    };

/** How a step's turn came back: it ran, or — on the day — another turn answered it. */
type StepTurn<Tag> =
  | {
      readonly kind: "ran";
      readonly settlement: StepSettlement;
      /** The tags of the wakes that folded into it. */
      readonly folded: readonly Tag[];
      readonly movedTo?: string;
    }
  | { readonly kind: "folded"; readonly into: Tag };

/**
 * ONE AGENT STEP'S TURN, RUN — the only place the engine runs one (tickets
 * #357, #363): on the run's session, opened new or resumed for the turn and
 * closed after it; as one call that leaves no session behind, for a turn with
 * no run; or on the day's session handed in, which is the thread's to open,
 * cut and close and is woken here and nothing more.
 *
 * A TURN JOINING THE DAY WAITS FOR A TURN OF ITS OWN (`priority: "later"`,
 * as an event's does) unless it is the thread's own turn on a rep's line, so
 * a line of the rep's folds only into a turn that answers the rep (D7).
 */
async function runStepTurn<Tag>(args: {
  readonly harness: Harness;
  readonly definition: ExecutionDefinition<StepOutput | undefined>;
  readonly trigger: Trigger;
  readonly chain: ExecutionAuditChain;
  readonly conversation: StepConversation<Tag>;
  readonly trace?: Trace;
}): Promise<StepTurn<Tag>> {
  const { conversation } = args;
  const wake = {
    trigger: args.trigger,
    definition: args.definition,
    chain: args.chain,
    ...(args.trace === undefined ? {} : { trace: args.trace }),
  };
  if (conversation.kind === "day") {
    // HANDED OVER IN THE PASS'S ORDER (ticket #358): `wake` gives the session
    // the turn before it first awaits, so the turn behind may go once it is
    // called; the settlement is awaited outside the order.
    await conversation.handOver?.ready;
    const settling = conversation.session.wake({
      ...wake,
      tag: conversation.tag,
      ...(conversation.folds ? {} : { priority: "later" as const }),
    });
    conversation.handOver?.handed();
    const settled = await settling;
    if (settled.kind === "folded") return { kind: "folded", into: settled.into };
    return { kind: "ran", settlement: settlementOf(settled), folded: settled.folded };
  }
  if (conversation.kind === "own") {
    try {
      const outcome = await runExecution({ harness: args.harness, ...wake });
      return { kind: "ran", settlement: settlementOfOutcome(outcome), folded: [] };
    } catch (error) {
      if (!(error instanceof ExecutionError)) throw error;
      return { kind: "ran", settlement: failedSettlement(error), folded: [] };
    }
  }
  let movedTo: string | undefined;
  const session = openSession<undefined>({
    harness: args.harness,
    shape: sessionShapeOf(args.definition),
    start: existsSync(sessionFile(args.harness.directory, conversation.sessionId))
      ? { kind: "resume", sessionId: conversation.sessionId }
      : { kind: "new", sessionId: conversation.sessionId },
    hooks: { moved: (to) => (movedTo = to) },
  });
  try {
    for (const guidance of conversation.guidance?.() ?? []) await session.append(guidance);
    const settled = await session.wake({ ...wake, tag: undefined });
    if (settled.kind === "folded") throw new Error("an agent step's turn folded into another wake");
    return {
      kind: "ran",
      settlement: settlementOf(settled),
      folded: [],
      ...(movedTo === undefined ? {} : { movedTo }),
    };
  } finally {
    await session.close();
  }
}

/** A step's wake that ran or failed, read. */
function settlementOf<Tag>(
  settled: Exclude<WakeSettlement<StepOutput | undefined, Tag>, { readonly kind: "folded" }>,
): StepSettlement {
  return settled.kind === "failed" ? failedSettlement(settled.error) : settlementOfOutcome(settled.outcome);
}

/** A turn that failed: its record, and nothing it did. */
function failedSettlement(error: ExecutionError): StepSettlement {
  return { disposition: "failed", record: error.record, effects: [], words: "" };
}

/** A turn that ended with an outcome, read. */
function settlementOfOutcome(outcome: ExecutionOutcome<StepOutput | undefined>): StepSettlement {
  return {
    disposition: outcome.record.disposition,
    record: outcome.record,
    effects: outcome.effects,
    words: outcome.words,
    ...(outcome.submission === undefined ? {} : { output: outcome.submission }),
  };
}

/**
 * WHAT AN AGENT STEP'S RECORD SAYS IT DID (tickets #357, #363) — the engine's
 * one reading, off what happened and never off what the model said: the act
 * word of a performed effect when the record's vocabulary has that word
 * (`drafted` for a draft), `acted` for any other performed effect, the word
 * the definition answers with (`answeredAs`, `answered` when it names none)
 * when the turn produced words or a typed output and no effect, `no-action`
 * when it produced neither. `asked`, `schema-miss` and `failed` are settled
 * by the runtime before this is read.
 */
export function stepDispositionOf(
  answeredAs: ReadDisposition = "answered",
): (output: StepOutput | undefined, handled: void | undefined, ending: TurnEnding) => ReadDisposition {
  return (output, _handled, ending) =>
    performedDisposition(ending.effects) ??
    (output !== undefined || ending.words.trim() !== "" ? answeredAs : "no-action");
}

/**
 * WHAT A PERFORMED EFFECT SAYS ABOUT A STEP (tickets #357, #358): the act word
 * of the first performed effect that is a disposition (`drafted` for a
 * draft), `acted` for any other performed effect — or nothing, where none
 * performed. One reading for an agent step's turn and an `act` step's call.
 */
function performedDisposition(effects: readonly EffectOutcome[]): ReadDisposition | undefined {
  const performed = effects.filter((effect) => effect.performed);
  if (performed.length === 0) return undefined;
  return (
    performed
      .map((effect) => effect.act)
      .find((act): act is ReadDisposition => isDisposition(act) && act !== "failed" && act !== "asked") ?? "acted"
  );
}

/** What an agent step's tools and recipes are bound to: who runs, what woke the turn, and the store. */
export type StepDeps = Pick<
  RunDeps,
  "harness" | "bundle" | "dek" | "twinId" | "selfChatJid" | "hmacKey" | "embedder" | "drafting" | "timeZone" | "repLanguage" | "runs"
>;

/** The trigger a run's step is recorded under. */
function stepTrigger(twinId: string, runId: string, step: number): RunStepTrigger {
  return { kind: "run_step", mechanism: "request", twinId, runId, step };
}

/**
 * A RUN'S STEP'S CONVERSATION (ticket #364): the thread's dependencies bound
 * to the step's own execution — its connection, its trigger, a turn of its
 * own, so the thread's tools it reads with or acts through run under that
 * trigger and no other — and what its run hands it to read or post, opened
 * for the tools and recipes it names (`run-reads.ts`). A run's step carries
 * no line and no canvas, so the thread's per-turn recipes render nothing in
 * it (`conversation.ts`).
 */
async function runConversationOf(
  client: pg.ClientBase,
  deps: RunDeps,
  run: RunRow,
  names: readonly string[],
  values: RunValues,
  executionId: string,
  now: Date,
): Promise<Conversation> {
  const trigger = stepTrigger(deps.twinId, run.id, run.current_step);
  return {
    kind: "run",
    deps: stepThreadDeps(deps, client, run.seat_id, trigger, executionId),
    reads: await stepReadsOf(client, deps, names, values, executionId, now),
  };
}

/** The thread's dependencies, bound to one run step's execution and trigger. */
function stepThreadDeps(
  deps: StepDeps,
  client: pg.ClientBase,
  seatId: string,
  trigger: ThreadTrigger,
  executionId: string,
): ThreadDeps {
  const now = new Date();
  return {
    db: client,
    dek: deps.dek,
    twinId: deps.twinId,
    executionId,
    hmacKey: deps.hmacKey,
    trigger,
    bundle: deps.bundle,
    embedder: deps.embedder,
    selfChatJid: deps.selfChatJid,
    message: "",
    seatId,
    canvasBlock: "",
    repLanguage: deps.repLanguage ?? DEFAULT_REP_LANGUAGE,
    timeZone: deps.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    eventReceivedAt: now,
    runtimeSeenAt: now,
    draftTiming: new TurnDraftTiming(),
    draft: new HeldDraftSlot(),
    binding: new TurnBindingProposal(),
    served: new ServedHits(customersOf(deps.bundle, deps.selfChatJid)),
    acts: new ActSlot(),
    ...(deps.runs === undefined ? {} : { runs: deps.runs }),
    harness: deps.harness,
    model: deps.drafting.model,
  };
}

/** A definition's own instructions, as the one part it is told: the step's, under its name. */
function ownParts(step: AgentStep): readonly NamedPart[] {
  return [{ name: step.name, text: step.instructions }];
}

/**
 * Whether a step joining the day IS the day's own turn — its instructions
 * are what the day's session was opened with (`daySessionShape`) — rather
 * than a step that brings instructions of its own into the day.
 */
function hostsTheDay(step: AgentStep, shape: SessionShape): boolean {
  return renderParts(ownParts(step)) === renderParts(shape.instructions);
}

/**
 * WHAT THE DAY'S SESSION IS OPENED WITH (tickets #319, #363): the thread's
 * definition's own instructions, every tool the thread holds as listed, no
 * typed result — its turns end on their words — the SDK's own tools its step
 * names (ticket #326), and the
 * definition's budget as a step's turn is given it. Built without a turn,
 * because a session may open to hold an event or a carried tail before any
 * turn exists, and from the same step and the same budget rule a turn's
 * definition is built from (`oneStepDefinition`, `stepTurnBudget`), since the
 * session refuses a turn whose shape is not this one.
 */
export function daySessionShape(definition: RunDefinition, model: string): SessionShape {
  if (definition.session !== "day") {
    throw new Error("the day's session is opened with a definition on the day's conversation");
  }
  const step = theOneStep(definition);
  const budget = stepTurnBudget(definition);
  const sdkTools = step.tools.filter(isSdkTool);
  return {
    instructions: ownParts(step),
    tools: THREAD_TOOL_DECLARATIONS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
    ...(sdkTools.length === 0 ? {} : { sdkTools }),
    budget: { model, ...budget },
  };
}

/** One turn's share of a one-step definition's budget: its rounds, and its output ceiling capped as a step's is. */
function stepTurnBudget(definition: RunDefinition): { readonly maxIterations: number; readonly maxTokens: number } {
  return {
    maxIterations: definition.budget.iterations,
    maxTokens: Math.min(DEFAULT_MAX_TOKENS, definition.budget.tokens),
  };
}

/**
 * WHAT AN AGENT STEP IS TOLD, AND HOW IT ENDS (decision 23; tickets #357,
 * #363) — the one place a step's turn is built, for a run's step and for a
 * definition run with no run alike.
 *
 * Its frame (`StepFrame`). Its tools: the ones it names, as its conversation
 * binds them — on the day, the day's. Its ending: the step's typed output as
 * the SDK's structured output when it declares one, its words when it does
 * not — never a tool it must call. Its context: the «now», then, for a step
 * that brings instructions into the day, those; the recipes it names in their
 * order, each rendering from its conversation or not at all; the rep's answer
 * when it is woken with one; and what it was started with — and, in a run,
 * what the earlier steps produced.
 */
export function agentStepDefinition(args: {
  readonly step: AgentStep;
  /** What the step's tools and its recipes are bound to (`conversation.ts`). */
  readonly conversation: Conversation;
  readonly frame: StepFrame;
  /** The line that says which work this is: the run and the step, or the definition and the step. */
  readonly heading: string;
  readonly values: RunValues;
  /** The run's laid-out steps, when the step is a run's. */
  readonly laid?: readonly LaidStep[];
  readonly now: Date;
  readonly model: string;
  /** How hard the model works, when the step's rung names it (ADR-0015 as amended). */
  readonly effort?: Effort;
  readonly maxIterations: number;
  readonly maxTokens: number;
  readonly lane: Lane;
  readonly wake: Wake;
  /** Whether the ask tool's card may leave the turn waiting — a run's step, which can park. */
  readonly suspends: boolean;
  /** The word a turn that answered without acting records (`stepDispositionOf`). */
  readonly answeredAs?: ReadDisposition;
  /** The rep's typed answer to the card this step asked, when it is woken with one. */
  readonly answer?: Readonly<Record<string, RunValue>>;
}): ExecutionDefinition<StepOutput | undefined> {
  const { step, frame } = args;
  const bound = bind(args.conversation);
  // A GUEST ON THE DAY BRINGS ITS OWN INSTRUCTIONS AS ITS TURN'S FIRST PART;
  // the day's own turn is told them already, as the session's system prompt.
  const guest = frame.kind === "day" && !hostsTheDay(step, frame.shape);
  // EVERY TOOL UNDER ITS OWN GATE, AND NEVER WHAT IS THE THREAD'S OWN ON A
  // STEP'S OWN CONVERSATION (ticket #324; decisions 21, 23 and 25): the parser refused
  // both, and a step whose content names one anyway fails rather than call it.
  // Joining the day, the tools are the day's, the thread's voice among them.
  const names = frame.kind === "day" ? frame.shape.tools.map((tool) => tool.name) : step.tools.filter((name) => !isSdkTool(name));
  // THE SDK'S OWN TOOLS GO BY NAME (ticket #326): the CLI serves them under
  // the gates `SDK_TOOL_GATES` maps, and on the day they are the day's.
  // A GUEST ON THE DAY HOLDS ONLY THE ONES IT NAMES (Codex r1): the day's child
  // lists the host's, and the session denies a turn any it was not given.
  const sdkTools = frame.kind === "day" && !guest ? (frame.shape.sdkTools ?? []) : step.tools.filter(isSdkTool);
  const tools = names.map((name) => {
    const tool = frame.kind !== "day" && THREAD_OWN_TOOLS.has(name) ? undefined : bound.tool(name);
    if (tool === undefined) {
      throw new Error(`step ${String(step.index)} names ${name}, which is no tool a step may call`);
    }
    return tool;
  });
  const recipes = (step.recipes ?? []).map((name) => {
    const recipe = CONVERSATION_RECIPES[name];
    if (recipe === undefined) throw new Error(`step ${String(step.index)} names ${name}, which is no context recipe`);
    return recipe(args.conversation);
  });
  const output = step.output;
  // WHAT IT WAS STARTED WITH AND WHAT IT ENDS ON, for every step; the heading
  // and the rep's language besides for a step of a run or a guest on the day,
  // which is working inside somebody else's frame.
  const framed = frame.kind === "run" || guest;
  const told = [
    ...(framed ? [args.heading, repLanguageLine(bound.repLanguage)] : []),
    ...(framed || Object.keys(args.values.inputs).length > 0
      ? [`What it was started with: ${JSON.stringify(args.values.inputs)}`]
      : []),
    ...(args.laid === undefined ? [] : [`What its earlier steps produced: ${JSON.stringify(args.values.outputs)}`]),
    ...(output === undefined ? [] : [`This step's result, returned as your structured output: ${shapeLine(output)}.`]),
    ...(args.laid === undefined ? [] : shownToTheRep(step, args.laid)),
  ];
  return defineExecution<StepOutput | undefined>({
    instructions:
      frame.kind === "run"
        ? [...RUN_STEP_PARTS, { name: "this step", text: step.instructions }]
        : frame.kind === "own"
          ? ownParts(step)
          : frame.shape.instructions,
    tools,
    ...(sdkTools.length === 0 ? {} : { sdkTools }),
    ...(output === undefined ? {} : { outputFormat: stepOutputFormat(output, bound.customers, bound.holds) }),
    // WHAT THE TWIN'S WORDS ARE HELD TO, where they are said to the rep (the
    // thread's guard): a turn ending on its words only.
    ...(output === undefined && bound.words !== undefined ? { wordsRule: bound.words } : {}),
    context: [
      STANDARD_RECIPES[NOW_RECIPE]!.create(undefined)({ at: args.now, timeZone: bound.timeZone }),
      // JOINING THE DAY, A GUEST SAYS HOW ITS TURN ENDS (Codex r2): the day's
      // instructions are the thread's, told once when its child opened.
      ...(guest
        ? [
            {
              name: "this step",
              text: `${step.instructions}\n\n[This turn is a step of its own: it ends when you stop, on what you write last, and nothing is submitted.]`,
            },
          ]
        : []),
      ...recipes.flatMap((part) => (part === undefined ? [] : [part])),
      ...(args.answer === undefined
        ? []
        : [
            {
              name: "the rep's answer",
              text: `[The rep answered the question you asked them: ${JSON.stringify(args.answer)}] Go on with this step from here, and finish it.`,
            },
          ]),
      ...(told.length === 0 ? [] : [{ name: args.laid === undefined ? "the step" : "the run", text: told.join("\n") }]),
    ],
    // THE RECIPES THE DEFINITION NAMES, by name: one definition stamps one
    // way whichever of them its conversation had something for this turn.
    recipes: [
      { recipe: NOW_RECIPE, parameters: { at: "instant", timeZone: "zone" } },
      ...(step.recipes ?? []).map((name) => ({ recipe: name, parameters: {} })),
    ],
    budget:
      frame.kind === "day"
        ? frame.shape.budget
        : {
            model: args.model,
            maxIterations: args.maxIterations,
            maxTokens: args.maxTokens,
            ...(args.effort === undefined ? {} : { effort: args.effort }),
          },
    lane: args.lane,
    wake: args.wake,
    dispositionOf: stepDispositionOf(args.answeredAs),
    ...(args.suspends ? { suspends: true as const } : {}),
  });
}

/**
 * Which of a step's fields a later `post` step puts in front of the rep — so
 * the step knows the text it writes there is said to them. Read off the laid
 * steps: a fact of the plan, never a guess about the prose.
 */
function shownToTheRep(step: AgentStep, laid: readonly LaidStep[]): readonly string[] {
  const own = (ref: string | undefined): readonly string[] =>
    ref !== undefined && ref.startsWith(`${step.name}.`) ? [ref.slice(step.name.length + 1)] : [];
  const posts = laid.flatMap((later) => (later.kind === "post" ? [later] : []));
  const fields = posts.flatMap((post) => [...own(post.text), ...own(post.list)]);
  const documents = posts.flatMap((post) => own(post.document));
  return [
    ...(fields.length === 0
      ? []
      : [`[A later step posts these fields of your result to the rep, as the run's report: ${[...new Set(fields)].join(", ")}.]`]),
    ...(documents.length === 0
      ? []
      : [`[A later step hands the rep the document in your workspace whose path you return in: ${[...new Set(documents)].join(", ")}.]`]),
  ];
}

/**
 * The parts every agent step of a run is told: what the work is, how a
 * customer is named, how the step ends. Shapes and rules, never a sentence
 * the rep reads.
 */
const RUN_STEP_PARTS: readonly NamedPart[] = [
  {
    name: "who you are",
    text: [
      "You are the twin of a sales rep, working one step of work the rep or Dito set going — most often a step of a run the rep asked you for, a run that lasts longer than one conversation and comes back to its work later. When this conversation is a run's own, its earlier steps, what they found, and anything the rep said about the run since are above you.",
      "This step has one purpose, given below as the step's instructions. A later step of a run decides what the rep is shown, unless this step lands a card of its own — a draft written behind the rep's tap.",
      "A text in your result that the rep will read is written to them — in their language and register, the way you speak to them in their thread, short enough for a glance — never about them.",
      "Messages marked as guidance from the rep are the rep's own word about this run since it began. Follow them in this step and in every step after it.",
    ].join("\n\n"),
  },
  {
    name: "how you name a customer",
    text: `Every customer has a reference of their own — ${REFERENCE_EXAMPLE} — and every tool that tells you about a customer prints it beside their name. Wherever a text of yours speaks of a customer, write their reference and never their name, and code puts in the name the rep knows them by. A reference that names nobody is refused.`,
  },
  {
    name: "how you finish",
    text: [
      "When the step declares a typed result, end by returning it as your structured output, every field filled. When it declares none, stop when the step is done.",
      // THE CARD'S WORDS ARE THE STEP'S LAST (ticket #396, F11; ADR-0037 as
      // amended 2026-10-08): said as what the rep reads; nothing checks it.
      "When this step lands a card — a draft written behind the rep's tap — what you write last is the card's sentence, above the draft: every word of it is shown to the rep, in their language, as you speaking to them, so end the step with what the card is and why now. A note about the step, the run or your choice to say nothing is never written. When the step lands no card, what you write last is the step's own record, and nothing to say is no words.",
      "A document you leave for the rep is a file you write into your workspace — your working directory — with Write, and change with Edit; return its path as a field of your result, and every version of it is kept.",
      "A result that writes a customer's name beside their reference, or a reference that names nobody, fails the step.",
    ].join("\n\n"),
  },
];

/**
 * The step's typed output as the SDK's structured output (ticket #357): the
 * CLI holds the model to its schema (`outputSchema`), and `parse` then holds
 * every reference in a text to a customer, with no name typed beside it — the
 * thread's own rule for a reference (spec #318 decision 18; `guard.ts`) — and
 * the whole answer to what its conversation holds it to (`holds`: a kind the
 * Ledger has, for the entity-kind question).
 */
function stepOutputFormat(
  output: Readonly<Record<string, OutputFieldType>>,
  customers: Customers,
  heldTo?: (output: StepOutput) => string | undefined,
): StructuredOutputContract<StepOutput | undefined> {
  const fields = Object.entries(output);
  return {
    schema: outputSchema(output),
    parse: (given) => {
      if (given === null || typeof given !== "object" || Array.isArray(given)) {
        return { ok: false, reason: "the result is an object with the step's fields" };
      }
      const value = given as Record<string, unknown>;
      const keys = Object.keys(value);
      if (keys.some((key) => !Object.hasOwn(output, key)) || fields.some(([field]) => !keys.includes(field))) {
        return { ok: false, reason: `this step's result is exactly ${shapeLine(output)}` };
      }
      const result: Record<string, RunValue> = {};
      for (const [field, type] of fields) {
        const fieldValue = value[field];
        const fits =
          type === "list"
            ? Array.isArray(fieldValue) && fieldValue.every((item) => typeof item === "string")
            : typeof fieldValue === type && !(typeof fieldValue === "number" && !Number.isFinite(fieldValue));
        if (!fits) return { ok: false, reason: `\`${field}\` is a ${type === "list" ? "list of strings" : type}` };
        const texts = typeof fieldValue === "string" ? [fieldValue] : Array.isArray(fieldValue) ? (fieldValue as string[]) : [];
        const stray = texts.flatMap(referencesIn).find((reference) => customers(reference) === undefined);
        if (stray !== undefined) return { ok: false, reason: `\`${field}\` names [c${String(stray)}], which names no customer` };
        const typed = texts.map((text) => typedReferencedName(text, customers)).find((name) => name !== undefined);
        if (typed !== undefined) {
          return { ok: false, reason: `\`${field}\` types the name "${typed}" beside the reference that already names them` };
        }
        result[field] = fieldValue as RunValue;
      }
      const refused = heldTo?.(result);
      if (refused !== undefined) return { ok: false, reason: refused };
      return { ok: true, submission: result };
    },
  };
}

/** A step's typed output as one line: each field and its type. */
function shapeLine(output: Readonly<Record<string, OutputFieldType>>): string {
  return Object.entries(output)
    .map(([field, type]) => `\`${field}\` (${type === "list" ? "a list of texts" : type})`)
    .join(", ");
}

// ─── a definition run with no run ───────────────────────────────────────

/**
 * The savepoint a turn with no run is taken under, so a `failed` one leaves
 * its trace and nothing else. A constant because it is an identifier
 * interpolated into SQL, and one spelling keeps the release and the rollback
 * naming the same savepoint. Nothing nests inside it but the per-tool
 * savepoints (`thread/registries.ts`), which release before it does.
 */
const STEP_SAVEPOINT = "execute_step";

/** How a turn with no run came back: it ran, or — on the day — another turn answered it. */
export type StepRun<Tag> =
  | {
      readonly kind: "ran";
      readonly settlement: StepSettlement;
      /** The tags of the wakes on the day that folded into this turn, each answered by it. */
      readonly folded: readonly Tag[];
    }
  | { readonly kind: "folded"; readonly into: Tag };

/** A definition run with no run's one step: one `agent` step, or a refusal. */
function theOneStep(definition: RunDefinition): AgentStep {
  const [step, ...rest] = layout(definition);
  if (step?.kind !== "agent" || rest.length > 0) {
    throw new Error("a definition run with no run is one agent step");
  }
  return step;
}

/**
 * WHAT A ONE-STEP DEFINITION'S TURN IS, BUILT (ticket #363): its agent step,
 * framed by its own instructions or by the day's session's shape, its tools
 * and recipes bound to the conversation — the definition `executeStep` runs,
 * and the one its stamp pins.
 */
export function oneStepDefinition(args: {
  readonly definition: RunDefinition;
  readonly conversation: Conversation;
  readonly inputs: Readonly<Record<string, RunValue>>;
  readonly lane: Lane;
  readonly wake: Wake;
  readonly now: Date;
  readonly model: string;
  /** The day's session's shape, for a definition on the day's conversation. */
  readonly day?: SessionShape;
}): ExecutionDefinition<StepOutput | undefined> {
  const step = theOneStep(args.definition);
  const frame: StepFrame = args.day === undefined ? { kind: "own" } : { kind: "day", shape: args.day };
  return agentStepDefinition({
    step,
    conversation: args.conversation,
    frame,
    heading: `[${args.definition.name} · ${step.name}]`,
    values: { inputs: args.inputs, outputs: {} },
    now: args.now,
    model: args.model,
    ...stepTurnBudget(args.definition),
    lane: args.lane,
    wake: args.wake,
    suspends: false,
    ...(args.definition.answeredAs === undefined ? {} : { answeredAs: args.definition.answeredAs }),
  });
}

/** Who runs a turn with no run, and where its record goes: the caller's connection, its transaction open. */
export interface StepHost {
  readonly harness: Harness;
  readonly db: pg.ClientBase;
  readonly twinId: string;
  readonly hmacKey: Uint8Array;
}

/** What a turn with no run is: the definition, what it is bound to, and the occasion it is recorded under. */
export interface StepCall<Tag> {
  readonly definition: RunDefinition;
  /** What the step's tools and recipes are bound to. */
  readonly conversation: Conversation;
  readonly inputs: Readonly<Record<string, RunValue>>;
  readonly trigger: Trigger;
  readonly wake: Wake;
  readonly lane: Lane;
  readonly executionId: string;
  readonly now: Date;
  /** The ADR-0015 rung the turn runs on — the caller's, since each conversation names its own. */
  readonly model: string;
  /** The day's session and the tag its wakes carry, for a definition on the day's conversation. */
  readonly day?: { readonly session: Session<Tag>; readonly tag: Tag; readonly handOver?: HandOver };
  readonly trace?: Trace;
}

/** A turn that ran — every turn on a call of its own, which nothing folds into. */
export type RanStep<Tag> = Extract<StepRun<Tag>, { readonly kind: "ran" }>;

/**
 * ONE ONE-STEP DEFINITION, RUN WITH NO RUN (tickets #357, #363): the way work
 * that answers someone runs — the twin thread's turn, drafting's, the
 * entity-kind question — never work on Trabajos (the ruling of 2026-10-07:
 * «a turn that answers someone is an execution with no run row»).
 *
 * The definition is one `agent` step, parsed with the catalog by the caller;
 * the trigger, the wake it fired, the lane, the model rung and the
 * conversation its tools and recipes are bound to are the caller's, so the
 * record carries the caller's occasion and lane and never `run_step`. The
 * step is built exactly as a run's step is (`agentStepDefinition`) and run by
 * the same runner (`runStepTurn`): as one call that leaves no session behind,
 * or, for a definition on the day's conversation, on the day's session handed
 * in.
 *
 * ONE RECORD AND ONE CHAIN ENTRY, on the caller's connection and inside its
 * transaction, and A FAILED TURN LEAVES NOTHING ELSE: the turn runs under a
 * savepoint, so what its tools wrote rolls back with a failure and the
 * turn's own chain entry — appended inside the savepoint — is appended again
 * after the rollback, then the record beside it (ADR-0020: one record and one
 * entry per execution, committed together). A wake that folded into another
 * turn on the day leaves nothing: that turn's record answers it. No row of
 * the runs store is touched; the post, the markers and the index are the
 * caller's.
 */
export async function executeStep(deps: StepHost, args: StepCall<never> & { readonly day?: undefined }): Promise<RanStep<never>>;
export async function executeStep<Tag>(
  deps: StepHost,
  args: StepCall<Tag> & { readonly day: { readonly session: Session<Tag>; readonly tag: Tag; readonly handOver?: HandOver } },
): Promise<StepRun<Tag>>;
export async function executeStep<Tag>(deps: StepHost, args: StepCall<Tag>): Promise<StepRun<Tag>> {
  const step = theOneStep(args.definition);
  const joinsTheDay = args.definition.session === "day";
  if (joinsTheDay !== (args.day !== undefined)) {
    throw new Error(
      joinsTheDay
        ? "a definition on the day's conversation runs on the day's session, handed in"
        : "a definition on a conversation of its own runs on a single call of its own, never on a session handed in",
    );
  }
  const definition = oneStepDefinition({
    definition: args.definition,
    conversation: args.conversation,
    inputs: args.inputs,
    lane: args.lane,
    wake: args.wake,
    now: args.now,
    model: args.model,
    ...(args.day === undefined ? {} : { day: args.day.session.shape }),
  });
  const chain = twinExecutionChain(deps.db, deps.hmacKey);
  await deps.db.query(`SAVEPOINT ${STEP_SAVEPOINT}`);
  const turn = await runStepTurn({
    harness: deps.harness,
    definition,
    trigger: args.trigger,
    chain,
    conversation:
      args.day === undefined
        ? { kind: "own" }
        : {
            kind: "day",
            ...args.day,
            folds: hostsTheDay(step, args.day.session.shape) && args.trigger.kind === "twin_thread_message",
          },
    ...(args.trace === undefined ? {} : { trace: args.trace }),
  });
  if (turn.kind === "folded") {
    await deps.db.query(`ROLLBACK TO SAVEPOINT ${STEP_SAVEPOINT}`);
    return turn;
  }
  const { settlement } = turn;
  if (settlement.disposition === "failed") {
    await deps.db.query(`ROLLBACK TO SAVEPOINT ${STEP_SAVEPOINT}`);
    await chain.append(executionAuditEntry(args.trigger, definition.digest, "failed"));
  } else {
    await deps.db.query(`RELEASE SAVEPOINT ${STEP_SAVEPOINT}`);
  }
  await new TwinExecutionStore({ client: deps.db, twinId: deps.twinId, executionId: args.executionId }).recordExecution(
    settlement.record,
  );
  return { kind: "ran", settlement, folded: turn.folded };
}

// ─── records, reports and endings ───────────────────────────────────────

/**
 * One step's execution, recorded: the agent turn's own record, whose chain
 * entry the session already appended on this transaction — or, for a step
 * with no model in it, a record and a chain entry written here, as a
 * dashboard act's are.
 */
async function recordStep(
  client: pg.ClientBase,
  deps: RunDeps,
  args: {
    readonly runId: string;
    readonly step: number;
    readonly executionId: string;
    readonly startedAt: Date;
    readonly disposition: Disposition;
    readonly record?: ExecutionRecord;
  },
): Promise<void> {
  const store = new TwinExecutionStore({ client, twinId: deps.twinId, executionId: args.executionId });
  if (args.record !== undefined) {
    await store.recordExecution(args.record);
    return;
  }
  const trigger = stepTrigger(deps.twinId, args.runId, args.step);
  await twinExecutionChain(client, deps.hmacKey).append(
    executionAuditEntry(trigger, DETERMINISTIC_INSTRUCTIONS, args.disposition),
  );
  await store.recordExecution({
    trigger,
    instructionsDigest: DETERMINISTIC_INSTRUCTIONS,
    toolNames: [],
    startedAt: args.startedAt,
    endedAt: new Date(),
    iterations: 0,
    tokens: { input: 0, output: 0 },
    disposition: args.disposition,
    lane: "batch",
  });
}

/** What a report carries beside its words (ticket #326): a list's rows and a workspace document. */
interface ReportBeside {
  readonly list?: readonly string[];
  readonly document?: WorkspaceVersion;
}

/**
 * THE RUN'S OWN POST (decision 25): a report to both surfaces — the
 * self-chat and the canvas — composed from a typed field as the twin's prose or, where
 * code ended the run, as the receipt code renders (ticket #358). Named by the
 * execution that wrote it; its post id is what the run's end tells the thread.
 *
 * EVERY REPORT IS THE NOTICE KIND `answer`, whoever's words it carries: the
 * kind says the post is a run's report (`stream-watch.ts` tells it as the
 * run's end, never as a card that landed), and its part says whose words they
 * are.
 */
async function postReport(
  client: pg.ClientBase,
  deps: RunDeps,
  executionId: string,
  report: RunReport,
  beside: ReportBeside = {},
): Promise<string> {
  const customers = customersOf(deps.bundle, deps.selfChatJid);
  const said = resolvableOnly(report.text, customers);
  const rows = (beside.list ?? []).map((row) => resolvableOnly(row, customers));
  // WHAT THE REPORT HANDS THE REP BESIDE ITS WORDS travels with it, whoever's
  // words they are (Codex r1).
  const handed = {
    ...(rows.length === 0 ? {} : { list: listPart(rows.map((row) => ({ text: row, mentions: mentionsIn(row, customers) }))) }),
    ...(beside.document === undefined ? {} : { documents: [documentPart(beside.document)] }),
  };
  const noticeId = await insertNoticeWithSystemSend(client, {
    twinId: deps.twinId,
    selfChatJid: deps.selfChatJid,
    dek: deps.dek,
    kind: "answer",
    executionId,
    post:
      report.kind === "receipt"
        ? composeReceiptPost(renderNames(said, mentionsIn(said, customers)), handed)
        : composeAnswerPost({ answer: said, mentions: mentionsIn(said, customers), ...handed }),
  });
  const posted = await client.query<{ id: string }>("SELECT id FROM posts WHERE notice_id = $1", [noticeId]);
  return posted.rows[0]!.id;
}

/**
 * WHERE A RUN STANDS, FOR ITS ENDING: its name and the kind of the step at its
 * current index — off its content, or, when that cannot be read, off the
 * step's own checkpoint. A kind neither holds is left unknown, and the
 * ending then writes no checkpoint for a step that never began.
 */
async function stoodAt(
  deps: RunDeps,
  run: RunRow,
): Promise<{ readonly name: string; readonly kind?: StepKind }> {
  try {
    const content = readRunContent(deps.harness.directory, deps.dek, run.id, run.definition_digest);
    const kind = layout(content.definition)[run.current_step]?.kind;
    return { name: content.definition.name, ...(kind === undefined ? {} : { kind }) };
  } catch {
    const checkpoint = await withClient(deps, (client) =>
      client.query<{ kind: StepKind }>("SELECT kind FROM run_steps WHERE run_id = $1 AND step_index = $2", [
        run.id,
        run.current_step,
      ]),
    );
    const kind = checkpoint.rows[0]?.kind;
    return { name: "", ...(kind === undefined ? {} : { kind }) };
  }
}

/**
 * HOW A RUN IS CLOSED, whatever ended it — a failed step, a spent budget, a
 * cancel, a process that died inside a step: the step's execution (the agent
 * turn's own record when the step made one, else one written here), the
 * ending's receipt under that execution, the step's checkpoint closed
 * `failed`, and the run's end, on the caller's transaction. Returns the
 * report's post id.
 */
async function closeRun(
  client: pg.ClientBase,
  deps: RunDeps,
  args: {
    readonly run: RunRow;
    readonly step: number;
    readonly kind?: StepKind;
    readonly executionId: string;
    readonly startedAt: Date;
    /**
     * The step's word where it failed. Absent for a cancel, whose record reads
     * what it lands (ticket #358): `posted` for the root's receipt, `no-action`
     * for a child, which lands none.
     */
    readonly disposition?: Disposition;
    readonly record?: ExecutionRecord;
    readonly sentence: string;
  },
): Promise<string | undefined> {
  // A CHILD POSTS NO ENDING: its parent's report carries it (ticket #324).
  const lands = args.run.parent_run_id === null;
  await recordStep(client, deps, {
    runId: args.run.id,
    step: args.step,
    executionId: args.executionId,
    startedAt: args.startedAt,
    disposition: args.disposition ?? (lands ? "posted" : "no-action"),
    ...(args.record === undefined ? {} : { record: args.record }),
  });
  const posted = lands ? await postReport(client, deps, args.executionId, { kind: "receipt", text: args.sentence }) : undefined;
  if (args.kind !== undefined) {
    await endStep(client, {
      runId: args.run.id,
      step: args.step,
      kind: args.kind,
      state: "failed",
      executionId: args.executionId,
    });
  }
  await endRun(client, args.run.id, "failed");
  return posted;
}

/**
 * A RUN ENDS `failed` OUTSIDE ITS STEP'S TRANSACTION — the step threw, its
 * budget was spent, its content could not be read, or the process died inside
 * it — closed in a transaction of its own, with an execution written here.
 * Nothing fires for it afterwards: the engine reads only runs that have not
 * ended.
 */
async function failRun(deps: RunDeps, run: RunRow, error: unknown): Promise<void> {
  const stood = await stoodAt(deps, run);
  const executionId = randomUUID();
  // A STEP THAT FAILED OR DIED STILL ENDS AT A BOUNDARY (ticket #326; Codex
  // r1): whatever it wrote into the workspace is on disk, so it is versioned
  // under the execution that closes the step — and a snapshot that fails here
  // never keeps the run from closing.
  try {
    await snapshotWorkspace(deps, { executionId, runId: run.id, sessionId: run.session_id, now: new Date() });
  } catch {
    // The files stay in the workspace; the next boundary of any work versions them.
  }
  const reportedId = await withClient(deps, (client) =>
    withTransaction(client, () =>
      closeRun(client, deps, {
        run,
        step: run.current_step,
        ...(stood.kind === undefined ? {} : { kind: stood.kind }),
        executionId,
        startedAt: new Date(),
        disposition: "failed",
        sentence:
          error instanceof BudgetSpent
            ? RUN_REPORTS.budgetSpent(stood.name)
            : RUN_REPORTS.failed(stood.name, run.current_step + 1, run.step_count),
      }),
    ),
  );
  tell(deps, run, { kind: "run.step", runId: run.id, step: run.current_step, state: "failed" });
  tell(deps, run, { kind: "run.failed", runId: run.id, step: run.current_step, ...(reportedId === undefined ? {} : { postId: reportedId }) });
}

/**
 * A CANCELLED RUN ENDS: the step it stood at closes with an execution of its
 * own, the report says it was cancelled, and the run ends `failed` with its
 * `cancelled` flag — the end a rep act or the thread asked for.
 */
async function endCancelled(deps: RunDeps, runId: string): Promise<void> {
  const run = await withClient(deps, (client) => readRun(client, deps.twinId, runId));
  if (run === undefined || run.ended_at !== null) return;
  const stood = await stoodAt(deps, run);
  const reportedId = await withClient(deps, (client) =>
    withTransaction(client, () =>
      closeRun(client, deps, {
        run,
        step: run.current_step,
        ...(stood.kind === undefined ? {} : { kind: stood.kind }),
        executionId: randomUUID(),
        startedAt: new Date(),
        sentence: RUN_REPORTS.cancelled(stood.name),
      }),
    ),
  );
  tell(deps, run, { kind: "run.finished", runId, state: "cancelled", ...(reportedId === undefined ? {} : { postId: reportedId }) });
}

/**
 * THE RUNS AN EARLIER PROCESS LEFT MID-STEP: `running` with nothing in this
 * process holding them. Runs never restart, so each ends `failed` with its
 * report and a record for the step it was inside.
 */
async function settleStranded(deps: RunDeps, engine: RunEngine): Promise<void> {
  for (const run of await liveRuns(deps.db, deps.twinId)) {
    if (run.state !== "running" || !engine.claim(run.id)) continue;
    try {
      await failRun(deps, run, new Error("the runtime stopped inside this step"));
    } finally {
      engine.release(run.id);
    }
  }
}

/**
 * LETS A HELD RUN GO ONLY ONCE ITS QUEUED GUIDANCE IS IN ITS SESSION (Codex
 * r2): the guidance is appended while the run is still held, and the hold is
 * let go in the same synchronous moment the queue is found empty — so no
 * second child opens on the run's session, and no next step begins, before
 * what the rep said is there for it to read.
 */
export async function releaseAfterGuidance(
  engine: RunEngine,
  runId: string,
  append: (guidance: readonly string[]) => Promise<void>,
): Promise<void> {
  for (;;) {
    const queued = engine.drain(runId);
    if (queued.length === 0) {
      engine.release(runId);
      return;
    }
    try {
      await append(queued);
    } catch (error) {
      engine.release(runId);
      throw error;
    }
  }
}

/**
 * Guidance queued while the run was held, appended to its session now — so
 * it is there for whichever agent step comes next, however long the run
 * waits first.
 */
async function appendQueued(deps: RunDeps, runId: string, guidance: readonly string[]): Promise<void> {
  if (guidance.length === 0) return;
  const run = await withClient(deps, (client) => readRun(client, deps.twinId, runId));
  if (run === undefined) return;
  await appendToRunSession(deps.harness, deps.drafting.model, run.session_id, guidance);
}

/**
 * Appends to a run's session with no turn: the child opens on the session —
 * new when no step has written it yet — takes the messages, and exits. No
 * model call.
 */
export async function appendToRunSession(
  harness: Harness,
  model: string,
  sessionId: string,
  messages: readonly string[],
  /** Fork the session whole instead (an `each`'s child), told the new id. */
  options: { readonly fork?: (to: string) => void } = {},
): Promise<void> {
  const fork = options.fork;
  const session = openSession<undefined>({
    harness,
    shape: appendShape(model),
    start: existsSync(sessionFile(harness.directory, sessionId))
      ? { kind: "resume", sessionId, ...(fork === undefined ? {} : { fork: true as const }) }
      : { kind: "new", sessionId },
    ...(fork === undefined ? {} : { hooks: { moved: (to: string) => fork(to) } }),
  });
  try {
    for (const message of messages) await session.append(message);
  } finally {
    await session.close();
  }
}

/**
 * The shape an append-only child opens with: it answers no turn, so it is
 * told the run's parts and lists no tool; the model is the deployment's rung,
 * never asked anything here.
 */
function appendShape(model: string): SessionShape {
  return {
    instructions: RUN_STEP_PARTS,
    tools: [],
    budget: { model, maxIterations: 1, maxTokens: DEFAULT_MAX_TOKENS },
  };
}

/**
 * Tells the thread what a run did — never a child's doings, which reach the
 * rep through their parent's report (ticket #324).
 */
function tell(deps: RunDeps, run: Pick<RunRow, "parent_run_id">, event: RaisedThreadEvent): void {
  if (run.parent_run_id !== null) return;
  deps.threadSessions?.raise(deps.twinId, event);
}

async function withClient<T>(deps: RunDeps, run: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await deps.executionPool.connect();
  try {
    return await run(client);
  } finally {
    client.release();
  }
}

async function withTransaction<T>(client: pg.ClientBase, run: () => Promise<T>): Promise<T> {
  await client.query("BEGIN");
  try {
    const result = await run();
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

