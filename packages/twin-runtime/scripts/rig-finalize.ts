/**
 * The rig's hand trigger for the correction window (ticket #67; #54).
 *
 * A fact nobody corrects finalizes 24 hours after the rep could actually
 * have read the line disclosing it (ADR-0004, FR-35). The scheduled
 * runtime runs that clock on every loop iteration, so on the rig it only
 * ever ran while `rig-run.ts` was up — and a steering session stops
 * `rig-run.ts` to use the other hand triggers. This is the third trigger,
 * so a session can close a window deliberately instead of waiting a day
 * for one to close on its own.
 *
 * IT IS THE CLOCK, SO IT IS SAFE TO RUN EARLY. `finalized_at` is stored as
 * `reachable_at + 24h`, computed from the disclosure, never from when the
 * pass ran — so a steered instant decides WHETHER a window has closed and
 * never WHEN it closed. Running this with `DITO_RIG_NOW` a day ahead
 * finalizes exactly the facts whose windows have really closed by then,
 * stamped with the instant they really closed.
 *
 * NO BUNDLE, NO KEY. Finalization verifies nothing and decrypts nothing
 * (`LedgerClockContext` is the seam and nothing else), so unlike the other
 * two triggers this one does not open twin memory — and it is therefore
 * the one hand trigger that is safe to run with `rig-run.ts` still up. It
 * is idempotent either way: a fact finalizes exactly once.
 *
 * Usage: source .env.rig, then
 *   node --experimental-strip-types scripts/rig-finalize.ts
 * (build first: pnpm build)
 */
import { finalizeDueFacts } from "@dito/aperture";
import pg from "pg";
import { describeRigClock, repTimeZone, rigClock } from "./rig-env.ts";

const twinId = process.env["DITO_TWIN_ID"];
const dbUrl = process.env["DITO_DATABASE_URL"];
if (twinId === undefined || dbUrl === undefined) {
  console.error(
    "usage: source .env.rig && node --experimental-strip-types scripts/rig-finalize.ts",
  );
  process.exit(1);
}

const timeZone = repTimeZone();

const db = new pg.Client({ connectionString: dbUrl });
await db.connect();
try {
  // Read here rather than at module load, for the same reason the other
  // two triggers do: with no override this is a wall clock, and the one
  // instant it should be is the one the pass runs at.
  const clock = rigClock();
  console.log(`finalization clock: ${describeRigClock(clock, timeZone)}`);
  // The SAME instant the other two hand triggers read, from the same
  // variable (ticket #67).
  const result = await finalizeDueFacts({ db }, { twinId }, clock.now);
  console.log(
    result.finalized === 0
      ? "no correction window has closed yet — nothing finalized"
      : `finalized ${result.finalized} fact(s): ${result.factIds.join(", ")}`,
  );
} finally {
  await db.end();
}
