/**
 * THE ENGINE AND THE CLOCK, DRIVEN TO REST FOR A SUITE (ticket #364).
 *
 * The runtime's pass hands each run's next step to the batch lane and moves
 * on; a suite that asserts on what a run did drives the same engine pass after
 * pass, settling the lane each time, until no run of the twin is still going
 * — or until the runs left are waiting on something no pass will bring (a
 * card the rep has not answered).
 */
import { openBatchWork } from "../lanes.js";
import { advanceRuns, createRunEngine, type RunDeps } from "../runs/engine.js";
import { ensureShippedAutomations } from "../runs/shipped-automations.js";
import { liveRuns } from "../runs/store.js";
import { fireDueCadences } from "../runs/wakes.js";

/** The most passes one drive takes: a parent, its children, its last step, with room. */
const MAX_PASSES = 60;

/** Drives every run of the twin until none is going or none moved. */
export async function driveRuns(deps: RunDeps, now: Date): Promise<void> {
  const engine = createRunEngine();
  const batch = openBatchWork();
  let last = "";
  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    await advanceRuns({ ...deps, runs: engine }, now, batch);
    await batch.lane.settle();
    const going = await liveRuns(deps.db, deps.twinId);
    if (going.length === 0) return;
    const seen = JSON.stringify(going.map((run) => [run.id, run.state, run.current_step]));
    if (seen === last) return;
    last = seen;
  }
}

/**
 * ONE PASS OF THE CLOCK, then the runs it started driven to rest: Dito's rows
 * written for the twin's seat first, as the runtime's pass writes them —
 * active from the start of that day, so the day's own instant is one they
 * fire for and yesterday's is not — then every cadence that has come due. How
 * many runs the clock started.
 */
export async function clockPass(deps: RunDeps & { readonly disclosureHour?: number }, now: Date): Promise<number> {
  const seat = await deps.db.query<{ id: string }>("SELECT id FROM seats WHERE twin_id = $1", [deps.twinId]);
  const seatId = seat.rows[0]?.id;
  if (seatId !== undefined) {
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
  }
  const fired = await fireDueCadences(deps, now, openBatchWork());
  await driveRuns(deps, now);
  return fired;
}
