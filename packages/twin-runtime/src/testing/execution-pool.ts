/**
 * ONE EXECUTION POOL PER SUITE FILE (ticket #173).
 *
 * From this ticket an execution runs its whole transaction on a connection of
 * its own, borrowed for exactly that long — because the transaction is open
 * across the model call and `pg` queues queries per client, so two executions
 * sharing one would issue their statements into each other's transaction
 * (`lanes.ts` argues it in full). The composition root owns the pool, exactly
 * as it owns the send-lock writer's, and for integration suites that root is
 * the suite file.
 *
 * IT REGISTERS ITS OWN TEARDOWN, so a suite adding this line cannot forget
 * the other one: an un-ended pool keeps a vitest worker alive with nothing
 * saying why. Called at module scope, where a hook registration belongs;
 * pools connect lazily, so creating one before `resetAndMigrate()` costs
 * nothing and reaches the recreated schema.
 *
 * SIZED FROM BOTH LANES' CAPS, so the pool cannot disagree with them: one
 * smaller than their sum breaks nothing — an execution simply waits — but it
 * would narrow the concurrency the caps declare, silently. Both are here
 * because the runtime draws on ONE pool for both lanes: the consumer's
 * drafting and thread executions and the daily pass's extractions (ticket
 * #194) borrow from the same place.
 */
import pg from "pg";
import { afterAll } from "vitest";
import { BATCH_LANE_CAP, REALTIME_LANE_CAP } from "../lanes.js";
import { TEST_DATABASE_URL } from "./db.js";

export function newExecutionPool(): pg.Pool {
  const pool = new pg.Pool({
    connectionString: TEST_DATABASE_URL,
    max: REALTIME_LANE_CAP + BATCH_LANE_CAP,
  });
  afterAll(async () => {
    await pool.end();
  });
  return pool;
}
