/**
 * TRABAJOS EN CURSO'S RUNS, READ (ticket #323; spec #318 decision 25;
 * ADR-0044's `run` part; the runs read stops answering empty).
 *
 * One row per run of the twin's: every one still going, and every one that
 * ended in the days the dashboard keeps — its name, its state word, its flags,
 * one detail (the step it stands at, and for a wait on the clock the instant
 * it wakes), its steps with their states, and its instants. Typed facts code
 * renders into copy on rep-web's side; never a sentence on the wire.
 *
 * THE LEASE HOLDER'S, because an inline run's name is inside its sealed
 * content (`content.ts`) and rep-web holds no key (ADR-0008). The name's
 * customers are rendered here, by the confirmed name the bundle holds, the
 * way every surface renders a reference (spec #318 decision 18).
 *
 * THE STEP LIST IS THE PINNED DEFINITION LAID OUT, each step's state its
 * checkpoint's — or `pending` for one the run has not reached, or past a
 * branch never will.
 */
import type { Bundle } from "@dito/bundle";
import type { Dek } from "@dito/crypto";
import {
  TWIN_API_RUNS_DAYS,
  type TwinRun,
  type TwinRunAwait,
  type TwinRunStep,
  type TwinRuns,
} from "@dito/seam";
import type pg from "pg";
import { seatDay } from "../thread/day.js";
import {
  customersOf,
  mentionsIn,
  renderNames,
  replaceReferences,
  withoutReferences,
  type Customers,
} from "../thread/references.js";
import { readRunContent, type RunContent } from "./content.js";
import { layout, passAt, type LaidStep } from "./definition.js";
import { listedRuns, stepsOf, type RunRow, type RunStepRow } from "./store.js";

export interface RunsReadDeps {
  readonly db: pg.ClientBase;
  readonly twinId: string;
  readonly dek: Dek;
  /** The twin's harness directory, where each run's sealed content lies. */
  readonly harnessDirectory: string;
  /** For a name's customers; absent, a name reads with its references taken out. */
  readonly bundle?: Bundle;
  readonly selfChatJid?: string;
  readonly timeZone?: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export async function readRuns(deps: RunsReadDeps, now: Date): Promise<TwinRuns> {
  const timeZone = deps.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const runs = await listedRuns(deps.db, deps.twinId, new Date(now.getTime() - TWIN_API_RUNS_DAYS * DAY_MS));
  const steps = await stepsOf(
    deps.db,
    runs.map((run) => run.id),
  );
  const waits = await wakesOf(deps.db, runs);
  return {
    today: seatDay(now, timeZone),
    runs: runs.map((run) => runOnTheWire(deps, run, steps.get(run.id) ?? [], waits.get(run.id), timeZone)),
  };
}

function runOnTheWire(
  deps: RunsReadDeps,
  run: RunRow,
  checkpoints: readonly RunStepRow[],
  wakesAt: Date | undefined,
  timeZone: string,
): TwinRun {
  const content = contentOf(deps, run);
  const laid = content === undefined ? undefined : layout(content.definition);
  const stateAt = new Map(checkpoints.map((row) => [row.step_index, row.state] as const));
  const steps: TwinRunStep[] = Array.from({ length: run.step_count }, (_, index) => ({
    kind: laid?.[index]?.kind ?? checkpoints.find((row) => row.step_index === index)?.kind ?? "agent",
    state: stateAt.get(index) ?? "pending",
  }));
  const current = steps[run.current_step]!;
  const pass = laid === undefined || content === undefined ? undefined : passAt(laid, content, run.current_step);
  return {
    runId: run.id,
    ...(run.parent_run_id === null ? {} : { parentRunId: run.parent_run_id }),
    automation: run.automation,
    name: content === undefined ? "" : nameOf(deps, content.definition.name),
    state: run.state,
    paused: run.paused,
    cancelled: run.cancelled,
    detail: {
      step: run.current_step + 1,
      of: run.step_count,
      kind: current.kind,
      ...(run.state === "waiting" && wakesAt !== undefined ? { until: wakesAt.toISOString() } : {}),
      ...awaitsOf(run, laid, checkpoints, wakesAt),
      ...(pass === undefined ? {} : { pass: pass.pass, ...(pass.passes === undefined ? {} : { passes: pass.passes }) }),
    },
    steps,
    createdAt: run.created_at.toISOString(),
    lastChangeAt: run.last_change_at.toISOString(),
    ...(run.ended_at === null
      ? {}
      : { endedAt: run.ended_at.toISOString(), day: seatDay(run.ended_at, timeZone) }),
  };
}

/**
 * WHAT A WAITING RUN WAITS ON (ticket #368), read from its own rows: a card
 * when the step it stands at is parked on one (`run_steps.awaits_post_id` — a
 * wait on a card's settle, or a step that asked), a customer's reply when that
 * step is a wait on one, the runs it started when that step is an `each`, the
 * clock when a wake for it is on the clock store.
 * Nothing when the run is not waiting, or its rows say none of the three.
 */
function awaitsOf(
  run: RunRow,
  laid: readonly LaidStep[] | undefined,
  checkpoints: readonly RunStepRow[],
  wakesAt: Date | undefined,
): { readonly awaits?: TwinRunAwait } {
  if (run.state !== "waiting") return {};
  const at = checkpoints.find((row) => row.step_index === run.current_step);
  if (at?.awaits_post_id !== null && at?.awaits_post_id !== undefined) return { awaits: "card" };
  const step = laid?.[run.current_step];
  if (step?.kind === "wait" && "reply" in step.until) return { awaits: "reply" };
  if (step?.kind === "each" || at?.kind === "each") return { awaits: "runs" };
  return wakesAt === undefined ? {} : { awaits: "clock" };
}

/**
 * The run's sealed content, or `undefined` when it cannot be read — a row the
 * read still lists, by its steps' kinds alone.
 */
function contentOf(deps: RunsReadDeps, run: RunRow): RunContent | undefined {
  try {
    return readRunContent(deps.harnessDirectory, deps.dek, run.id, run.definition_digest);
  } catch {
    return undefined;
  }
}

/**
 * The run's own name, its customers by the names the rep knows them by — or,
 * where a reference names nobody the bundle holds, with it taken out.
 */
function nameOf(deps: RunsReadDeps, name: string): string {
  if (deps.bundle === undefined || deps.selfChatJid === undefined) return withoutReferences(name).trim();
  const customers = customersOf(deps.bundle, deps.selfChatJid);
  const kept = resolvableOnly(name, customers);
  return renderNames(kept, mentionsIn(kept, customers));
}

/**
 * A text with every reference that names nobody the bundle holds taken out,
 * so it renders: what code says about a run never fails on a customer the
 * rep has since unbound.
 */
export function resolvableOnly(text: string, customers: Customers): string {
  return replaceReferences(text, (written, reference) => (customers(reference) === undefined ? "" : written));
}

/** When each waiting run's wait on the clock falls due. */
async function wakesOf(
  db: pg.ClientBase,
  runs: readonly RunRow[],
): Promise<ReadonlyMap<string, Date>> {
  const waiting = runs.filter((run) => run.state === "waiting");
  if (waiting.length === 0) return new Map();
  const rows = await db.query<{ run_id: string; step_index: number; fire_at: Date }>(
    `SELECT run_id, step_index, fire_at FROM schedules
      WHERE run_id = ANY($1::uuid[]) AND kind = 'once'`,
    [waiting.map((run) => run.id)],
  );
  const at = new Map<string, Date>();
  for (const run of waiting) {
    const row = rows.rows.find((candidate) => candidate.run_id === run.id && candidate.step_index === run.current_step);
    if (row !== undefined) at.set(run.id, row.fire_at);
  }
  return at;
}
