/**
 * ONE WAY A RUN BEGINS (tickets #323 and #325; spec #318 decisions 22, 26 and
 * 28 as amended 2026-10-06: «a firing creates a run with the clock or the
 * trigger as its creator»).
 *
 * The thread's `start_workflow`, the clock firing a cadence, a seam event
 * firing a rutina's trigger and the rep asking for one of Dito's own
 * automations all start a run the same way, here: the ids
 * minted, the content sealed beside the session, the row written `ready`, the
 * first wait put on the clock store when the run opens on one, and the
 * session opened with the line that says what the run is. Who started it and
 * which automation it belongs to are the only things the callers differ in.
 *
 * ON THE CALLER'S CONNECTION, INSIDE THE CALLER'S TRANSACTION: the thread's
 * turn and the clock's firing each commit the run together with what else
 * they wrote, or neither. The content file and the session are on disk before
 * the commit, so a caller that rolls back leaves them with no row — sealed
 * and never read (PR #356, remainder 7).
 */
import { randomUUID } from "node:crypto";
import type { Dek } from "@dito/crypto";
import { renderTurnInstant, type Harness } from "@dito/execution";
import type pg from "pg";
import { writeRunContent } from "./content.js";
import { layout, runDigest, spanMs, type RunDefinition, type RunValue } from "./definition.js";
import { appendToRunSession } from "./engine.js";
import { insertRun, scheduleWait, type RunCreator } from "./store.js";

/** What starting a run needs of whoever starts it. */
export interface StartRunDeps {
  readonly db: pg.ClientBase;
  readonly twinId: string;
  readonly seatId: string;
  readonly dek: Dek;
  readonly harness: Harness;
  /** The deployment's model rung, which the session's opening child is told and never asks. */
  readonly model: string;
  readonly timeZone?: string;
}

/** One run to start. */
export interface RunStart {
  readonly definition: RunDefinition;
  readonly inputs: Readonly<Record<string, RunValue>>;
  /**
   * The word the row carries: `inline`, a shipped run's name, `rutina`, or
   * the name of one of Dito's own automations.
   */
  readonly automation: string;
  readonly creator: RunCreator;
  /** The thread's turn that started it, when one did. */
  readonly createdByExecutionId?: string;
  /**
   * The automation's row that fired it and what woke it — the clock's instant
   * or the event — or, for a run the rep asked one of Dito's for, the row
   * alone (tickets #325, #364).
   */
  readonly fired?: { readonly id: string; readonly wokenBy?: string };
  /** The instant a first wait's span is counted from. */
  readonly now: Date;
}

/** The run that began. */
export interface StartedRun {
  readonly runId: string;
  readonly stepCount: number;
  /** When its first step's wait falls due, when it opens on one on the clock. */
  readonly firstWaitAt?: Date;
}

/** Starts one run on the caller's connection, and says which and when it first wakes. */
export async function startRun(deps: StartRunDeps, start: RunStart): Promise<StartedRun> {
  const runId = randomUUID();
  const sessionId = randomUUID();
  const { definition } = start;
  const laid = layout(definition);
  writeRunContent(deps.harness.directory, deps.dek, runId, {
    definition,
    inputs: start.inputs,
    outputs: {},
  });
  await insertRun(deps.db, {
    id: runId,
    twinId: deps.twinId,
    seatId: deps.seatId,
    automation: start.automation,
    digest: runDigest(definition),
    sessionId,
    stepCount: laid.length,
    budget: definition.budget,
    createdBy: start.creator,
    ...(start.createdByExecutionId === undefined
      ? {}
      : { createdByExecutionId: start.createdByExecutionId }),
    ...(start.fired === undefined ? {} : { fired: start.fired }),
  });
  // A RUN THAT OPENS ON THE CLOCK HAS ITS WAKE FROM ITS FIRST BREATH: the
  // schedule row is written with the run, so the pass that fires it needs
  // nothing from whoever started it.
  const first = laid[0]!;
  let firstWaitAt: Date | undefined;
  if (first.kind === "wait" && ("at" in first.until || "after" in first.until)) {
    firstWaitAt =
      "at" in first.until
        ? new Date(first.until.at)
        : new Date(start.now.getTime() + spanMs(first.until.after));
    await scheduleWait(deps.db, { twinId: deps.twinId, runId, step: 0, fireAt: firstWaitAt });
  }
  // THE RUN'S SESSION OPENS NOW, with the line that says what it is, so
  // every agent step resumes it and guidance given before the first one
  // has a conversation to land in. No model is asked anything.
  await appendToRunSession(deps.harness, deps.model, sessionId, [
    `[Run "${definition.name}" · started ${renderTurnInstant(start.now, deps.timeZone)}] This conversation is the run's own: ${String(laid.length)} steps, in order — ${laid.map((step) => `${step.name} (${step.kind})`).join(", ")}.`,
  ]);
  return {
    runId,
    stepCount: laid.length,
    ...(firstWaitAt === undefined ? {} : { firstWaitAt }),
  };
}
