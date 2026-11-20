/**
 * THE TWIN THREAD'S RUN TOOLS (ticket #323; spec #318 decisions 4, 19, 20 and
 * 24; ADR-0013 as amended 2026-09-27: `start_workflow`, `steer_run`,
 * `pause_run`, `cancel_run` disclosed-and-undoable-after through Trabajos en
 * curso, `read_runs` a projection).
 *
 * The thread starts work that outlives its turn, steers it, pauses it,
 * cancels it, and reads what is in flight. None of them needs the rep's
 * evidence — a turn an event woke may start work the rep asked for earlier
 * (decision 19) — and every one of them is in front of the rep the moment it
 * lands: the run's row on Trabajos, its flags, its state.
 *
 * EACH REFUSES A RUN THAT IS NOT THIS TWIN'S: every id is resolved under the
 * twin before anything is written, and one that resolves to nothing is
 * answered as if the run did not exist. `steer_run`, `pause_run` and
 * `cancel_run` refuse a run that has ended.
 *
 * THE TWIN'S OWN ACTS, NOT THE REP'S (`RUN_ACT_WORDS`): like a spotlight or a
 * note, none of them marks the rep's message or takes the turn's one act — a
 * structural change is a cancel and a new start in one turn (decision 24).
 */
import {
  defineTool,
  renderTurnInstant,
  type EffectOutcome,
  type GatedEffectToolDeclaration,
  type ProjectionToolDeclaration,
} from "@dito/execution";
import type { ThreadDeps } from "../thread/deps.js";
import { referencesIn, writeReference } from "../thread/references.js";
import { readRunContent } from "./content.js";
import { runCatalog } from "./catalog.js";
import {
  CANCEL_RUN_DECLARATION,
  PAUSE_RUN_DECLARATION,
  READ_RUNS_DECLARATION,
  START_WORKFLOW_DECLARATION,
  STEER_RUN_DECLARATION,
} from "./declarations.js";
import { MAX_RUN_NAME, parseRunDefinition, type RunDefinition, type RunValue } from "./definition.js";
import { appendToRunSession, createRunEngine, releaseAfterGuidance, type RunEngine } from "./engine.js";
import { SHIPPED_RUNS } from "./shipped.js";
import { startRun } from "./start.js";
import { listedRuns, readRun, setFlag } from "./store.js";

/**
 * The longest a run's guidance may be, one message: the thread's own cap on a
 * line the rep reads, with room for what the rep said.
 */
const MAX_GUIDANCE = 2_000;

// ─── start_workflow ─────────────────────────────────────────────────────

export function startWorkflowTool(deps: ThreadDeps): GatedEffectToolDeclaration {
  return defineTool({
    ...START_WORKFLOW_DECLARATION,
    run: async (input: unknown): Promise<EffectOutcome> => {
      const given = (input ?? {}) as { shipped?: unknown; name?: unknown; definition?: unknown; inputs?: unknown };
      // A RUN STARTS NO RUNS (Codex r2): a step that could would start work no
      // budget of the run's bounds, and copies of itself without end. The one
      // way a run makes runs is an `each`, whose children share its budget.
      if (deps.trigger.kind === "run_step") {
        return refused("a step of a run starts no other run — an each is how a run works through several things at once.");
      }
      if (deps.seatId === undefined || deps.harness === undefined || deps.model === undefined) {
        return refused("this twin has no seat a run could serve yet.");
      }
      const chosen = chooseDefinition(given);
      if ("refused" in chosen) return refused(chosen.refused);
      const inputs = readInputs(given.inputs);
      if ("refused" in inputs) return refused(inputs.refused);
      const stray = [chosen.definition.name, ...Object.values(inputs.values).flatMap(textsOf)]
        .flatMap(referencesIn)
        .find((reference) => deps.served.customers(reference) === undefined);
      if (stray !== undefined) {
        return refused(`${writeReference(stray)} names no customer — use a reference a tool gave you.`);
      }
      const started = await startRun(
        {
          db: deps.db,
          twinId: deps.twinId,
          seatId: deps.seatId,
          dek: deps.dek,
          harness: deps.harness,
          model: deps.model,
          timeZone: deps.timeZone,
        },
        {
          definition: chosen.definition,
          inputs: inputs.values,
          automation: chosen.automation,
          creator: "thread",
          createdByExecutionId: deps.executionId,
          now: deps.runtimeSeenAt,
        },
      );
      const wakes =
        started.firstWaitAt === undefined
          ? ""
          : ` Its first step waits until ${renderTurnInstant(started.firstWaitAt, deps.timeZone)}.`;
      return {
        performed: true,
        act: "run_started",
        told: `Run ${started.runId} is started: ${String(started.stepCount)} steps, in Trabajos en curso now.${wakes} You are told when it finishes or fails; a post step, where it has one, reports to the rep itself.`,
      };
    },
  });
}

function chooseDefinition(given: {
  readonly shipped?: unknown;
  readonly name?: unknown;
  readonly definition?: unknown;
}): { readonly definition: RunDefinition; readonly automation: string } | { readonly refused: string } {
  if ((given.shipped === undefined) === (given.definition === undefined)) {
    return { refused: "give either `shipped`, the name of a run Dito ships, or `definition`, one you write — one of the two." };
  }
  if (given.shipped !== undefined) {
    const shippedName = String(given.shipped);
    const shipped = Object.hasOwn(SHIPPED_RUNS, shippedName) ? SHIPPED_RUNS[shippedName as keyof typeof SHIPPED_RUNS] : undefined;
    if (shipped === undefined) return { refused: `Dito ships no run named "${shippedName}"; write the run as a definition.` };
    // A SHIPPED RUN IS NAMED BY THE TWIN, in the rep's words (ticket #324):
    // the definition is code's and its name is what Trabajos shows the rep.
    if (typeof given.name !== "string" || given.name.trim() === "" || given.name.length > MAX_RUN_NAME) {
      return { refused: `a shipped run takes \`name\`: the few words, in the rep's language, Trabajos en curso shows it by — at most ${String(MAX_RUN_NAME)} characters.` };
    }
    return { definition: { ...shipped, name: given.name.trim() }, automation: shippedName };
  }
  const parsed = parseRunDefinition(given.definition, runCatalog());
  return parsed.ok ? { definition: parsed.definition, automation: "inline" } : { refused: parsed.reason };
}

function readInputs(
  raw: unknown,
): { readonly values: Readonly<Record<string, RunValue>> } | { readonly refused: string } {
  if (raw === undefined) return { values: {} };
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { refused: "`inputs` is an object of typed values." };
  }
  const values: Record<string, RunValue> = {};
  for (const [key, value] of Object.entries(raw)) {
    const fits =
      typeof value === "string" ||
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value)) ||
      (Array.isArray(value) && value.every((item) => typeof item === "string"));
    if (!fits || !/^[a-z][a-z0-9_]{0,39}$/u.test(key)) {
      return { refused: `input \`${key}\` is a lowercase name holding text, a number, yes/no or a list of text.` };
    }
    values[key] = value as RunValue;
  }
  return { values };
}

function textsOf(value: RunValue): readonly string[] {
  return typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
}

// ─── steer_run ──────────────────────────────────────────────────────────

export function steerRunTool(deps: ThreadDeps): GatedEffectToolDeclaration {
  return defineTool({
    ...STEER_RUN_DECLARATION,
    run: async (input: unknown): Promise<EffectOutcome> => {
      const given = (input ?? {}) as { run_id?: unknown; guidance?: unknown };
      const run = await liveRunOf(deps, given.run_id);
      if ("refused" in run) return refused(run.refused);
      if (typeof given.guidance !== "string" || given.guidance.trim() === "" || given.guidance.length > MAX_GUIDANCE) {
        return refused(`\`guidance\` is what the rep said about the run, at most ${String(MAX_GUIDANCE)} characters.`);
      }
      if (deps.harness === undefined || deps.model === undefined) {
        return refused("this twin has no harness a run could be steered in.");
      }
      const message = `[Guidance from the rep · ${renderTurnInstant(deps.runtimeSeenAt, deps.timeZone)}] ${given.guidance.trim()}`;
      await steer(deps, deps.runs ?? createRunEngine(), run.id, run.sessionId, message);
      await deps.db.query("UPDATE runs SET last_change_at = clock_timestamp() WHERE id = $1", [run.id]);
      return {
        performed: true,
        act: "run_steered",
        told: `The guidance is kept in run ${run.id}; its next agent step reads it.`,
      };
    },
  });
}

/**
 * THE GUIDANCE REACHES THE RUN'S NEXT AGENT STEP AND NO OTHER: appended to the
 * run's session now when nothing in this process holds the run, or queued
 * behind the step in flight, which appends it when that step has ended
 * (`engine.ts`).
 */
async function steer(
  deps: ThreadDeps,
  engine: RunEngine,
  runId: string,
  sessionId: string,
  message: string,
): Promise<void> {
  if (!engine.claim(runId)) {
    engine.queue(runId, message);
    return;
  }
  engine.queue(runId, message);
  await releaseAfterGuidance(engine, runId, (guidance) =>
    appendToRunSession(deps.harness!, deps.model!, sessionId, guidance),
  );
}

// ─── pause_run and cancel_run ───────────────────────────────────────────

export function pauseRunTool(deps: ThreadDeps): GatedEffectToolDeclaration {
  return defineTool({
    ...PAUSE_RUN_DECLARATION,
    run: async (input: unknown): Promise<EffectOutcome> => {
      const given = (input ?? {}) as { run_id?: unknown; paused?: unknown };
      if (typeof given.paused !== "boolean") return refused("`paused` is true or false.");
      const run = await liveRunOf(deps, given.run_id);
      if ("refused" in run) return refused(run.refused);
      if (run.cancelled) return refused(`run ${run.id} is cancelled and ends at the next pass.`);
      await setFlag(deps.db, { twinId: deps.twinId, runId: run.id, flag: "paused", value: given.paused });
      return {
        performed: true,
        act: given.paused ? "run_paused" : "run_resumed",
        told: given.paused
          ? `Run ${run.id} is paused: it fires nothing until it is taken up again.`
          : `Run ${run.id} is taken up again from where it stood.`,
      };
    },
  });
}

export function cancelRunTool(deps: ThreadDeps): GatedEffectToolDeclaration {
  return defineTool({
    ...CANCEL_RUN_DECLARATION,
    run: async (input: unknown): Promise<EffectOutcome> => {
      const given = (input ?? {}) as { run_id?: unknown };
      const run = await liveRunOf(deps, given.run_id);
      if ("refused" in run) return refused(run.refused);
      await setFlag(deps.db, { twinId: deps.twinId, runId: run.id, flag: "cancelled", value: true });
      return {
        performed: true,
        act: "run_cancelled",
        told: `Run ${run.id} is cancelled: it ends at the next pass, with its report to the rep.`,
      };
    },
  });
}

/** One of this twin's runs that has not ended, or why not. */
async function liveRunOf(
  deps: ThreadDeps,
  raw: unknown,
): Promise<
  | { readonly id: string; readonly sessionId: string; readonly cancelled: boolean }
  | { readonly refused: string }
> {
  if (typeof raw !== "string" || !UUID_SHAPE.test(raw)) {
    return { refused: "`run_id` is a run's id, as start_workflow or read_runs gave it." };
  }
  const run = await readRun(deps.db, deps.twinId, raw);
  if (run === undefined) return { refused: `no run of yours has the id ${raw}.` };
  if (run.ended_at !== null) return { refused: `run ${raw} has already ended.` };
  return { id: run.id, sessionId: run.session_id, cancelled: run.cancelled };
}

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

// ─── read_runs ──────────────────────────────────────────────────────────

/** How many days of ended runs the read shows, beside every run still going. */
const READ_RUNS_DAYS = 7;

export function readRunsTool(deps: ThreadDeps): ProjectionToolDeclaration {
  return defineTool({
    ...READ_RUNS_DECLARATION,
    run: async () => {
      const since = new Date(deps.runtimeSeenAt.getTime() - READ_RUNS_DAYS * 24 * 60 * 60 * 1000);
      const runs = await listedRuns(deps.db, deps.twinId, since);
      const names = new Map<string, string>();
      if (deps.harness !== undefined) {
        for (const run of runs) {
          try {
            names.set(run.id, readRunContent(deps.harness.directory, deps.dek, run.id, run.definition_digest).definition.name);
          } catch {
            // Listed by its id and state alone.
          }
        }
      }
      const text =
        runs.length === 0
          ? "You have no runs going, and none ended in the last days."
          : runs
              .map((run) =>
                [
                  `run_id: ${run.id}`,
                  `name: ${names.get(run.id) ?? ""}`,
                  `state: ${[run.state, ...(run.paused ? ["paused"] : []), ...(run.cancelled ? ["cancelled"] : [])].join(", ")}`,
                  `current_step: ${String(run.current_step + 1)} of ${String(run.step_count)}`,
                  `started: ${renderTurnInstant(run.created_at, deps.timeZone)}`,
                  `last_change: ${renderTurnInstant(run.last_change_at, deps.timeZone)}`,
                ].join(" · "),
              )
              .join("\n");
      deps.served.read(text);
      return text;
    },
  });
}

/** A write that did not happen, told to the model as feedback it can act on. */
function refused(why: string): EffectOutcome {
  return { performed: false, told: `refused: ${why}` };
}

