/**
 * THE DAY'S EXTRACTION AND ITS DISCLOSURE, ASKED FOR BY HAND AND WAITED FOR
 * (tickets #52, #194, #364): the eval lane, the rig's own tools and the
 * suites start the same run the clock fires — the automation's own, by
 * `startShippedRun`, with the rep as its creator — and drive the engine until
 * it has ended, so the numbers they read are about work that happened.
 *
 * NOT THE RUNTIME'S WAY: the running runtime never waits on a run, its pass
 * hands each step to the batch lane and moves on. Here nothing else is
 * waiting, so the caller's own lane is settled after every pass of the
 * engine until the run is over.
 */
import type pg from "pg";
import { dayOwed, type DailyDisclosureDeps } from "../disclosure.js";
import type { DailyExtractionDeps, ExtractionSteering } from "../extraction-pass.js";
import { daySettled } from "../extraction-pass.js";
import { openBatchWork } from "../lanes.js";
import { readRunContent } from "./content.js";
import { MAX_REPEATS, type RunValue } from "./definition.js";
import { advanceRuns, createRunEngine, type RunDeps } from "./engine.js";
import { ensureShippedAutomations } from "./shipped-automations.js";
import { readRun } from "./store.js";
import { startShippedRun } from "./wakes.js";

/** What a day's extraction did, read back from its runs and their claims. */
export interface DailyExtractionResult {
  /**
   * The runs that read the day, in the order they started — none when none
   * could start, more than one when the day held more chat-days than one
   * run's `each` takes.
   */
  readonly runIds: readonly string[];
  /** In-scope chats with traffic in their window. */
  readonly chats: number;
  /** Chat-days claimed and handed to a child of a run. */
  readonly extracted: number;
  /** Unbound chats whose read waits for a binding (FR-32). */
  readonly deferred: number;
  /** Facts the aperture filed across the runs' claims. */
  readonly filed: number;
  /** Claims no child filed, settled `failed`. */
  readonly failed: number;
  /** Records the merge ladder made one. */
  readonly merged: number;
  /** Pairs the ladder left apart because their kinds differ (ticket #60). */
  readonly kindMismatches: number;
  /** Whether every chat-day of the day is settled now. */
  readonly settled: boolean;
  /**
   * Each child run's chat — the one chat-day it read. The eval lane's trace
   * is keyed by run, and this is how it says which chat a run's cost and
   * proposals were.
   */
  readonly chatOfRun: ReadonlyMap<string, string>;
}

/** What a day's disclosure did. */
export interface DailyDisclosureResult {
  /** The run that posted the day — absent when none could start. */
  readonly runId?: string;
  /** Whether the day's post committed. */
  readonly posted: boolean;
  /** How many lines it carried — zero when it did not post. */
  readonly lines: number;
}

/** The most passes of the engine one hand run waits through: a parent, its children, its last step. */
const MAX_PASSES = 200;

/** The most runs one hand read of a day starts: far past any day a rep's chats make. */
const MAX_RUNS = 50;

/**
 * THE HAND TRIGGER FOR THE DAY'S EXTRACTION: runs of Dito's extraction,
 * started as the rep's and waited for, until the day has no chat-day left to
 * claim. One run's `each` takes at most `MAX_REPEATS` chat-days, so a day with
 * more is read by the next run, as the clock's next pass would read it.
 * `steering` is the rig's (#67): a re-read of a filed day, on a clock moved
 * ahead of the seam's.
 */
export async function runDailyExtraction(
  deps: DailyExtractionDeps,
  now: Date,
  steering: ExtractionSteering = {},
): Promise<DailyExtractionResult> {
  const runDeps = runDepsOf(deps);
  // THE ENGINE IS DRIVEN ON THE REP'S CLOCK — what the steps are told it is
  // — and a seam clock moved apart from it rides in as the run's input.
  const inputs: Record<string, RunValue> = {
    ...(steering.reextract === true ? { reextract: true } : {}),
    ...(steering.seamNow !== undefined && steering.seamNow.getTime() !== now.getTime()
      ? { seam_now: steering.seamNow.toISOString() }
      : {}),
  };
  const runIds: string[] = [];
  let totals = { chats: 0, extracted: 0, deferred: 0, filed: 0, failed: 0, merged: 0, kindMismatches: 0 };
  for (let started = 0; started < MAX_RUNS; started += 1) {
    const runId = await startAndWait(runDeps, "extraction", inputs, now);
    if (runId === undefined) break;
    runIds.push(runId);
    const outputs = await outputsOf(runDeps, runId);
    const claim = outputs["claim"] ?? {};
    const settle = outputs["settle"] ?? {};
    const extracted = Array.isArray(claim["claims"]) ? claim["claims"].length : 0;
    totals = {
      // THE DAY'S CHATS ARE COUNTED ONCE: every run walks the same chats,
      // and the first saw them all.
      chats: started === 0 ? numberOf(claim["chats"]) : totals.chats,
      extracted: totals.extracted + extracted,
      deferred: totals.deferred + numberOf(claim["deferred"]),
      filed: totals.filed + numberOf(settle["filed"]),
      failed: totals.failed + numberOf(settle["failed"]),
      merged: totals.merged + numberOf(settle["merged"]),
      kindMismatches: totals.kindMismatches + numberOf(settle["kind_mismatches"]),
    };
    // A RUN THAT TOOK FEWER THAN IT COULD LEFT NOTHING BEHIND IT.
    if (extracted < MAX_REPEATS) break;
  }
  return {
    runIds,
    ...totals,
    settled: await daySettled(deps, now, steering.seamNow),
    chatOfRun: await chatsOfChildren(runDeps, runIds),
  };
}

/** Each child of these runs, by the chat-day claim its item names. */
async function chatsOfChildren(deps: RunDeps, parents: readonly string[]): Promise<ReadonlyMap<string, string>> {
  const chats = new Map<string, string>();
  if (parents.length === 0) return chats;
  const children = await deps.db.query<{ id: string; definition_digest: string }>(
    "SELECT id, definition_digest FROM runs WHERE twin_id = $1 AND parent_run_id = ANY($2::uuid[])",
    [deps.twinId, [...parents]],
  );
  for (const child of children.rows) {
    const claim = readRunContent(deps.harness.directory, deps.dek, child.id, child.definition_digest).inputs["claim"];
    if (typeof claim !== "string") continue;
    const row = await deps.db.query<{ chat_jid: string }>(
      "SELECT chat_jid FROM extraction_runs WHERE twin_id = $1 AND id = $2",
      [deps.twinId, claim],
    );
    const chat = row.rows[0]?.chat_jid;
    if (chat !== undefined) chats.set(child.id, chat);
  }
  return chats;
}

/**
 * THE HAND TRIGGER FOR THE DAY'S POST: one run of Dito's disclosure, started
 * as the rep's and waited for — when the day owes the rep a post, as the
 * rep's own request asks (`runtime-requests.ts`); no run at all when it does
 * not.
 */
export async function runDailyDisclosure(deps: DailyDisclosureDeps, now: Date): Promise<DailyDisclosureResult> {
  if (!(await dayOwed(deps, now))) return { posted: false, lines: 0 };
  const runDeps = runDepsOf(deps);
  const runId = await startAndWait(runDeps, "daily_disclosure", {}, now);
  if (runId === undefined) return { posted: false, lines: 0 };
  const posted = await deps.db.query<{ lines: string }>(
    `SELECT count(l.*) AS lines
       FROM disclosure_attempts a
       JOIN run_steps s ON s.execution_id = a.execution_id AND s.run_id = $2
       JOIN disclosure_posts p ON p.twin_id = a.twin_id AND p.disclosure_day = a.disclosure_day
       LEFT JOIN disclosure_post_lines l ON l.post_id = p.id
      WHERE a.twin_id = $1
      GROUP BY p.id`,
    [deps.twinId, runId],
  );
  const row = posted.rows[0];
  return { runId, posted: row !== undefined, lines: Number(row?.lines ?? 0) };
}

/** The engine's deps, as a hand trigger's own make them: no thread is told. */
function runDepsOf(deps: DailyExtractionDeps | DailyDisclosureDeps): RunDeps {
  return {
    ...deps,
    embedder: "embedder" in deps ? deps.embedder : refusingEmbedder(),
  };
}

/** The embedder a disclosure's hand trigger is handed: it reads no chat's day, so nothing asks it. */
function refusingEmbedder(): RunDeps["embedder"] {
  return new Proxy({} as RunDeps["embedder"], {
    get: () => () => {
      throw new Error("the day's disclosure reads no chat's day, so nothing it runs embeds anything");
    },
  });
}

/**
 * Starts the automation's run for this twin's seat — its rows written first,
 * as the pass writes them — and drives the engine until the run has ended.
 * The run's id, or nothing when no run could start (no seat, the gate holding,
 * the switch at «En pausa»).
 */
async function startAndWait(
  deps: RunDeps,
  shipped: "extraction" | "daily_disclosure",
  inputs: Readonly<Record<string, RunValue>>,
  now: Date,
): Promise<string | undefined> {
  const seat = await deps.db.query<{ id: string }>("SELECT id FROM seats WHERE twin_id = $1", [deps.twinId]);
  const seatId = seat.rows[0]?.id;
  if (seatId === undefined) return undefined;
  await ensureShippedAutomations(
    deps.db,
    {
      twinId: deps.twinId,
      seatId,
      ...(deps.disclosureHour === undefined ? {} : { disclosureHour: deps.disclosureHour }),
      ...(deps.timeZone === undefined ? {} : { timeZone: deps.timeZone }),
    },
    now,
  );
  const runId = await withTransaction(deps, async (client) => (await startShippedRun(deps, client, shipped, inputs, now))?.runId);
  if (runId === undefined) return undefined;
  const engine = createRunEngine();
  const batch = openBatchWork();
  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    await advanceRuns({ ...deps, runs: engine }, now, batch);
    await batch.lane.settle();
    const run = await readRun(deps.db, deps.twinId, runId);
    if (run === undefined || run.ended_at !== null) return runId;
  }
  throw new Error(`run ${runId} did not end within ${String(MAX_PASSES)} passes of the engine`);
}

/** One transaction on a connection of the pool's. */
async function withTransaction<T>(deps: RunDeps, work: (client: pg.ClientBase) => Promise<T>): Promise<T> {
  const client = await deps.executionPool.connect();
  try {
    await client.query("BEGIN");
    try {
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    }
  } finally {
    client.release();
  }
}

/** The run's outputs, step by step, read under the digest its row pins. */
async function outputsOf(
  deps: RunDeps,
  runId: string,
): Promise<Readonly<Record<string, Readonly<Record<string, RunValue>>>>> {
  const run = await readRun(deps.db, deps.twinId, runId);
  if (run === undefined) return {};
  return readRunContent(deps.harness.directory, deps.dek, runId, run.definition_digest).outputs;
}

function numberOf(value: RunValue | undefined): number {
  return typeof value === "number" ? value : 0;
}
