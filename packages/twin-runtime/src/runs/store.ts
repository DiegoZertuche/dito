/**
 * THE RUN ROW, ITS CHECKPOINTS AND THE CLOCK STORE, AS SQL (ticket #323;
 * `…20261006100030_runs.sql` argues the columns).
 *
 * Every statement a run's life writes or reads, on whichever connection the
 * caller holds: the thread's turn starts a run on its own transaction, the
 * engine moves it on an execution client, the local API reads and acts on its
 * pool. Ids, closed words, counts and instants — nothing here carries content.
 */
import type pg from "pg";
import type { TwinRunState, TwinRunStepKind } from "@dito/seam";
import { GATE_ADVANCES_SQL } from "./gate.js";

/**
 * Who started a run (`runs_created_by_check`): the thread's turn, the clock
 * firing a rutina's cadence, a seam event firing a rutina's trigger (ticket
 * #325), or the rep's own act.
 */
export const RUN_CREATORS = ["thread", "clock", "rep", "trigger"] as const;

export type RunCreator = (typeof RUN_CREATORS)[number];

/** A run's row, as the engine and the reads take it. */
export interface RunRow {
  readonly id: string;
  readonly twin_id: string;
  readonly seat_id: string;
  readonly automation: string;
  /** The automation's row it was born of, when an automation fired it (tickets #325, #364). */
  readonly automation_id: string | null;
  readonly definition_digest: string;
  /** The run that made this one as one of an `each` step's children (ticket #324), or null. */
  readonly parent_run_id: string | null;
  readonly session_id: string;
  readonly state: TwinRunState;
  readonly current_step: number;
  readonly step_count: number;
  readonly budget_iterations: number;
  readonly budget_tokens: number;
  readonly spent_iterations: number;
  readonly spent_tokens: number;
  readonly paused: boolean;
  readonly cancelled: boolean;
  readonly created_by: RunCreator;
  readonly created_at: Date;
  readonly started_at: Date | null;
  readonly last_change_at: Date;
  readonly ended_at: Date | null;
}

/** A step's checkpoint (`run_steps`). */
export interface RunStepRow {
  readonly step_index: number;
  readonly kind: TwinRunStepKind;
  readonly state: "running" | "waiting" | "succeeded" | "failed";
  readonly execution_id: string | null;
  readonly awaits_post_id: string | null;
  readonly started_at: Date;
  readonly ended_at: Date | null;
}

const RUN_COLUMNS = `id, twin_id, seat_id, automation, automation_id, definition_digest, parent_run_id, session_id, state,
  current_step, step_count, budget_iterations, budget_tokens, spent_iterations,
  spent_tokens, paused, cancelled, created_by, created_at, started_at,
  last_change_at, ended_at`;

export async function insertRun(
  db: pg.ClientBase,
  run: {
    readonly id: string;
    readonly twinId: string;
    readonly seatId: string;
    readonly automation: string;
    readonly digest: string;
    readonly sessionId: string;
    readonly stepCount: number;
    readonly budget: { readonly iterations: number; readonly tokens: number };
    readonly createdBy: RunCreator;
    readonly createdByExecutionId?: string;
    /**
     * The automation that fired it — a rutina or one of Dito's own — and what
     * woke it (tickets #325, #364): the clock's instant or the event, absent
     * for a run the rep asked for and for a child, whose parent was the
     * firing.
     */
    readonly fired?: { readonly id: string; readonly wokenBy?: string };
    /** The run whose `each` step made this one (ticket #324). */
    readonly parentRunId?: string;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO runs (id, twin_id, seat_id, automation, definition_digest, session_id,
                       state, step_count, budget_iterations, budget_tokens,
                       created_by, created_by_execution_id, automation_id, woken_by, parent_run_id)
     VALUES ($1, $2, $3, $4, $5, $6, 'ready', $7, $8, $9, $10, $11, $12, $13, $14)`,
    [
      run.id,
      run.twinId,
      run.seatId,
      run.automation,
      run.digest,
      run.sessionId,
      run.stepCount,
      run.budget.iterations,
      run.budget.tokens,
      run.createdBy,
      run.createdByExecutionId ?? null,
      run.fired?.id ?? null,
      run.fired?.wokenBy ?? null,
      run.parentRunId ?? null,
    ],
  );
}

/**
 * The children an `each` step of `parentId` made since `since` — the instant
 * that step began — in the order they were made, which is their items' order.
 */
export async function childrenOf(
  db: pg.ClientBase,
  parentId: string,
  since: Date,
): Promise<readonly RunRow[]> {
  const rows = await db.query<RunRow>(
    `SELECT ${RUN_COLUMNS} FROM runs
      WHERE parent_run_id = $1 AND created_at >= $2
      ORDER BY created_at, id`,
    [parentId, since],
  );
  return rows.rows;
}

/** Whether every child `parentId` made has ended — what a parked `each` waits on. */
export async function childrenEnded(db: pg.ClientBase, parentId: string): Promise<boolean> {
  const rows = await db.query(
    "SELECT 1 FROM runs WHERE parent_run_id = $1 AND ended_at IS NULL LIMIT 1",
    [parentId],
  );
  return rows.rowCount === 0;
}

/** One of this twin's runs, or `undefined` — the fence every tool and act goes through. */
export async function readRun(
  db: pg.ClientBase,
  twinId: string,
  runId: string,
): Promise<RunRow | undefined> {
  const rows = await db.query<RunRow>(
    `SELECT ${RUN_COLUMNS} FROM runs WHERE twin_id = $1 AND id = $2`,
    [twinId, runId],
  );
  return rows.rows[0];
}

/** This twin's runs that have not ended, oldest first. */
export async function liveRuns(db: pg.ClientBase, twinId: string): Promise<readonly RunRow[]> {
  const rows = await db.query<RunRow>(
    `SELECT ${RUN_COLUMNS} FROM runs
      WHERE twin_id = $1 AND ended_at IS NULL
      ORDER BY created_at, id`,
    [twinId],
  );
  return rows.rows;
}

/** The runs a read lists: every one still going, and those that ended since `since`. */
export async function listedRuns(
  db: pg.ClientBase,
  twinId: string,
  since: Date,
): Promise<readonly RunRow[]> {
  const rows = await db.query<RunRow>(
    `SELECT ${RUN_COLUMNS} FROM runs
      WHERE twin_id = $1 AND (ended_at IS NULL OR ended_at >= $2)
      ORDER BY (ended_at IS NULL) DESC, COALESCE(ended_at, created_at) DESC, id`,
    [twinId, since],
  );
  return rows.rows;
}

/** A run's checkpoints, by index. */
export async function stepsOf(
  db: pg.ClientBase,
  runIds: readonly string[],
): Promise<ReadonlyMap<string, readonly RunStepRow[]>> {
  if (runIds.length === 0) return new Map();
  const rows = await db.query<RunStepRow & { run_id: string }>(
    `SELECT run_id, step_index, kind, state, execution_id, awaits_post_id, started_at, ended_at
       FROM run_steps WHERE run_id = ANY($1::uuid[]) ORDER BY run_id, step_index`,
    [[...runIds]],
  );
  const byRun = new Map<string, RunStepRow[]>();
  for (const row of rows.rows) {
    const list = byRun.get(row.run_id) ?? [];
    list.push(row);
    byRun.set(row.run_id, list);
  }
  return byRun;
}

/**
 * The instant a run's wait on the clock falls due — written once, by the
 * thread's start when the run opens on a wait, or by the engine when it
 * reaches one; whichever is first, the row is the same. `again` is a wait a
 * `while` reached once more (ticket #324): its row is written anew, unfired.
 */
export async function scheduleWait(
  db: pg.ClientBase,
  args: {
    readonly twinId: string;
    readonly runId: string;
    readonly step: number;
    readonly fireAt: Date;
    readonly again?: boolean;
  },
): Promise<Date> {
  await db.query(
    args.again === true
      ? `INSERT INTO schedules (twin_id, kind, fire_at, run_id, step_index)
         VALUES ($1, 'once', $2, $3, $4)
         ON CONFLICT (run_id, step_index) DO UPDATE SET fire_at = EXCLUDED.fire_at, fired_at = NULL`
      : `INSERT INTO schedules (twin_id, kind, fire_at, run_id, step_index)
         VALUES ($1, 'once', $2, $3, $4)
         ON CONFLICT (run_id, step_index) DO NOTHING`,
    [args.twinId, args.fireAt, args.runId, args.step],
  );
  const rows = await db.query<{ fire_at: Date }>(
    "SELECT fire_at FROM schedules WHERE run_id = $1 AND step_index = $2",
    [args.runId, args.step],
  );
  return rows.rows[0]!.fire_at;
}

/** The wake of one waiting step, when it has one on the clock. */
export async function waitScheduleOf(
  db: pg.ClientBase,
  runId: string,
  step: number,
): Promise<{ readonly fireAt: Date; readonly firedAt: Date | null } | undefined> {
  const rows = await db.query<{ fire_at: Date; fired_at: Date | null }>(
    "SELECT fire_at, fired_at FROM schedules WHERE run_id = $1 AND step_index = $2",
    [runId, step],
  );
  const row = rows.rows[0];
  return row === undefined ? undefined : { fireAt: row.fire_at, firedAt: row.fired_at };
}

/**
 * The clock firing a run's wait: stamps the row, once. `false` when another
 * pass already did, so a wake is never fired twice.
 */
export async function fireWait(
  db: pg.ClientBase,
  args: { readonly runId: string; readonly step: number; readonly at: Date },
): Promise<boolean> {
  const fired = await db.query(
    `UPDATE schedules SET fired_at = $3
      WHERE run_id = $1 AND step_index = $2 AND fired_at IS NULL AND fire_at <= $3
        AND EXISTS (SELECT 1 FROM runs r WHERE r.id = schedules.run_id AND ${GATE_ADVANCES_SQL})`,
    [args.runId, args.step, args.at],
  );
  return (fired.rowCount ?? 0) > 0;
}

/**
 * A step begins: the run says it is running it and its checkpoint is written —
 * only while the gate still holds, in the same statement (`GATE_ADVANCES_SQL`).
 * `false` when the gate has closed since, and nothing is written.
 */
export async function beginStep(
  db: pg.ClientBase,
  args: { readonly runId: string; readonly step: number; readonly kind: TwinRunStepKind },
): Promise<boolean> {
  const begun = await db.query(
    `UPDATE runs r SET state = 'running', current_step = $2,
                       started_at = COALESCE(started_at, clock_timestamp()),
                       last_change_at = clock_timestamp()
      WHERE r.id = $1 AND ${GATE_ADVANCES_SQL}`,
    [args.runId, args.step],
  );
  if ((begun.rowCount ?? 0) === 0) return false;
  // A WAITING STEP RESUMES ON ITS CHECKPOINT; A STEP A `while` REACHES AGAIN
  // (ticket #324) begins on a fresh one — its earlier pass's execution is in
  // `executions` under the same run and step, and the checkpoint says the pass
  // that is running now.
  await db.query(
    `INSERT INTO run_steps (run_id, step_index, kind, state)
     VALUES ($1, $2, $3, 'running')
     ON CONFLICT (run_id, step_index) DO UPDATE SET
       state = 'running',
       execution_id = CASE WHEN run_steps.state = 'waiting' THEN run_steps.execution_id END,
       ended_at = NULL,
       started_at = CASE WHEN run_steps.state = 'waiting' THEN run_steps.started_at ELSE clock_timestamp() END,
       awaits_post_id = CASE WHEN run_steps.state = 'waiting' THEN run_steps.awaits_post_id END,
       answered_at = CASE WHEN run_steps.state = 'waiting' THEN run_steps.answered_at END
       WHERE run_steps.state IN ('waiting', 'succeeded')`,
    [args.runId, args.step, args.kind],
  );
  return true;
}

/** When a step's checkpoint began — what a reply wait counts a reply from. */
export async function stepStartedAt(db: pg.ClientBase, runId: string, step: number): Promise<Date | undefined> {
  const rows = await db.query<{ started_at: Date }>(
    "SELECT started_at FROM run_steps WHERE run_id = $1 AND step_index = $2",
    [runId, step],
  );
  return rows.rows[0]?.started_at;
}

/** A step parks: its checkpoint and the run both say `waiting`, and a card it waits on is unanswered. */
export async function parkStep(
  db: pg.ClientBase,
  args: { readonly runId: string; readonly step: number; readonly awaitsPostId?: string },
): Promise<void> {
  await db.query(
    `UPDATE run_steps SET state = 'waiting', awaits_post_id = $3, answered_at = NULL
      WHERE run_id = $1 AND step_index = $2`,
    [args.runId, args.step, args.awaitsPostId ?? null],
  );
  await db.query(
    `UPDATE runs SET state = 'waiting', last_change_at = clock_timestamp() WHERE id = $1`,
    [args.runId],
  );
}

/** A step ends, with the execution it left. */
export async function endStep(
  db: pg.ClientBase,
  args: {
    readonly runId: string;
    readonly step: number;
    readonly kind: TwinRunStepKind;
    readonly state: "succeeded" | "failed";
    readonly executionId: string;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO run_steps (run_id, step_index, kind, state, execution_id, ended_at)
     VALUES ($1, $2, $3, $4, $5, clock_timestamp())
     ON CONFLICT (run_id, step_index)
       DO UPDATE SET state = EXCLUDED.state, execution_id = EXCLUDED.execution_id,
                     ended_at = EXCLUDED.ended_at`,
    [args.runId, args.step, args.kind, args.state, args.executionId],
  );
}

/** What one step spent, counted against the run's one budget. */
export async function spend(
  db: pg.ClientBase,
  args: { readonly runId: string; readonly iterations: number; readonly tokens: number },
): Promise<void> {
  await db.query(
    `UPDATE runs SET spent_iterations = spent_iterations + $2,
                     spent_tokens = spent_tokens + $3
      WHERE id = $1`,
    [args.runId, args.iterations, args.tokens],
  );
}

/** The run moves on to `next`, ready for the engine to begin it. */
export async function moveTo(db: pg.ClientBase, runId: string, next: number): Promise<void> {
  await db.query(
    `UPDATE runs SET state = 'ready', current_step = $2, last_change_at = clock_timestamp()
      WHERE id = $1`,
    [runId, next],
  );
}

/** The run ends — its last step's checkpoint already says how. */
export async function endRun(
  db: pg.ClientBase,
  runId: string,
  state: "succeeded" | "failed",
): Promise<void> {
  await db.query(
    `UPDATE runs SET state = $2, ended_at = clock_timestamp(), last_change_at = clock_timestamp()
      WHERE id = $1 AND ended_at IS NULL`,
    [runId, state],
  );
}

/** The session a run's agent steps resume, when a failed turn forked it under a new id. */
export async function moveSession(db: pg.ClientBase, runId: string, sessionId: string): Promise<void> {
  await db.query("UPDATE runs SET session_id = $2 WHERE id = $1", [runId, sessionId]);
}

/**
 * A flag set by the thread or by the rep on Trabajos. `false` when the run
 * has ended, so a flag never lands on a run that is over.
 *
 * A RUN'S CHILDREN CARRY ITS FLAGS (ticket #324): a paused parent pauses the
 * children it is waiting on and a cancelled one cancels them, so nothing of a
 * run the rep stopped goes on in its children.
 */
export async function setFlag(
  db: pg.ClientBase,
  args: {
    readonly twinId: string;
    readonly runId: string;
    readonly flag: "paused" | "cancelled";
    readonly value: boolean;
  },
): Promise<boolean> {
  const set = await db.query<{ id: string }>(
    `UPDATE runs SET ${args.flag === "paused" ? "paused" : "cancelled"} = $3,
                     last_change_at = clock_timestamp()
      WHERE twin_id = $1 AND (id = $2 OR parent_run_id = $2) AND ended_at IS NULL
      RETURNING id`,
    [args.twinId, args.runId, args.value],
  );
  return set.rows.some((row) => row.id === args.runId);
}
