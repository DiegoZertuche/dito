/**
 * THE OWNER ROLE'S PASSWORD, BORROWED FOR A SUITE AND GIVEN BACK (#133).
 *
 * WHY THIS EXISTS AT ALL. Eight owner-side integration suites need
 * `dito_owner` to have a password they know, because slice 4's whole claim is
 * that a process AUTHENTICATES as an application role rather than taking the
 * `SET ROLE` shortcut (see `withRoleClient`'s own header). The migration that
 * creates the role deliberately ships no password — a secret does not belong
 * in a checksummed artifact (…100020, ADR-0029) — so whoever needs the role
 * to log in sets one: the rig from `.env.rig` via `rig-seed-owner.ts`, a test
 * database from here.
 *
 * AND WHY IT IS ONE HOME RATHER THAN EIGHT COPIES. Roles are CLUSTER-GLOBAL
 * while databases are not. A ticket lane running its suites against its own
 * database in the shared docker server writes straight into the live rig's
 * login, so the credential a suite finds has to be the credential it leaves —
 * and eight hand-copied beforeAll/afterAll pairs are eight chances to get
 * that wrong. On 2026-09-04 they did: `./rig-owner.sh` died with `28P01
 * password authentication failed for user "dito_owner"` and `pg_authid`
 * showed no password at all (#133).
 *
 * WHAT PUTTING IT BACK MEANS. `ALTER ROLE … PASSWORD` stores an already
 * hashed `SCRAM-SHA-256$…` string verbatim and hashes anything else, so the
 * verifier read out of `pg_authid` goes back in as a literal and the role
 * ends with the exact bytes it started with. A role that had NO password gets
 * none back, which is the state the migration leaves it in.
 *
 * TWO FACTS THAT ARE NOT THE SAME FACT, and conflating them is what let the
 * live failure happen: "no row in `pg_authid`" and "a row whose password is
 * null". The eight suites each kept a `let ownerVerifierBefore: string | null
 * = null` that meant both — so a teardown could null a role the suite had
 * never read. Here a borrow either succeeds and hands back the one object
 * that knows how to undo it, or it throws; there is no handle to call restore
 * on if the capture did not happen, so the teardown writes NOTHING rather
 * than guessing. The one case where a throw is not also "wrote nothing" is a
 * connection that fails on close after the ALTER landed: the role then holds
 * the suite's password, which `rig-seed-owner.ts` puts right — it is never
 * left with no password at all, which is the failure that cost a session.
 *
 * SUITES AT ONCE SHARE THE BORROW (ticket #390). The lane runs files in
 * parallel, and other lanes may run on the same server, so a borrow that
 * captured what it found would capture another suite's test password and
 * hand the rig that one at the end. So the server keeps a record of
 * borrowed roles (`role-borrows.ts`): the first borrower of a role records
 * the verifier it found, every borrower holds the borrow while it borrows,
 * and the last one out puts the recorded verifier back. Each borrower also
 * holds the role lock's USE shared from borrow to restore, so a file that
 * moves the role on purpose waits for every borrower to leave
 * (`role-lock.ts`). A run's setup and teardown give back whatever a dead
 * borrower left (`integration-run.ts`).
 *
 * NOT DONE HERE, deliberately: suppressing `log_statement` around the ALTER.
 * One suite attempted it with a transaction-local `set_config(…, true)`
 * outside a transaction, where it does nothing. Doing it properly needs a
 * `SET LOCAL` inside a transaction, which is one more way for a TEARDOWN to
 * fail — and a teardown that fails leaves the rig holding the suite's
 * password, which is the failure this file exists to prevent. Robustness
 * wins; the server's default `log_statement` is `none`.
 */
import type { Client } from "pg";
import { withMaintenance } from "./admin.js";
import { baseDatabaseUrl } from "./database-url.js";
import { giveBackIfLast, recordBorrow } from "./role-borrows.js";
import { borrowsHeld, holdBorrow, holdRoles, inRun, withRoleWrites } from "./role-lock.js";

/**
 * The password every owner-side suite authenticates as the owner role with.
 * A test credential and nothing else. One value for all of them because the
 * role is cluster-global and suites hold it at once, so a second value would
 * be a second suite's login broken.
 */
export const OWNER_TEST_PASSWORD = "dito_owner_integration";

/** A borrowed credential, and the only way to give it back. */
export interface BorrowedOwnerPassword {
  /**
   * Lets this suite's borrow go; the last borrower out puts the verifier the
   * first one found back on the role, verbatim.
   */
  restore(): Promise<void>;
}

/**
 * Takes a borrow of `role` — the first borrower records the role's current
 * verifier — sets {@link OWNER_TEST_PASSWORD} on it, and returns the handle
 * that lets the borrow go.
 *
 * The read, the record and the write are ONE transaction under the role
 * lock's WRITE, so nothing can slip between them. The role is named as an
 * argument rather than imported, which is what keeps the seam package
 * ignorant of the owner side's vocabulary (`OWNER_ROLE` is pinned in the
 * aperture's `grants.ts`).
 */
export async function borrowOwnerPassword(
  role: string,
): Promise<BorrowedOwnerPassword> {
  if (!inRun()) {
    throw new Error(
      "borrowOwnerPassword runs inside the integration lane only (pnpm test:integration): the borrow is counted under the run's role lock",
    );
  }
  const base = baseDatabaseUrl(process.env);
  const releaseUse = await holdRoles("shared");
  let borrow: { pid: number; release: () => Promise<void> } | null = null;
  try {
    borrow = await holdBorrow(role);
    await withRoleWrites(() =>
      inTransaction(base, (tx) => recordBorrow(tx, role, OWNER_TEST_PASSWORD)),
    );
  } catch (err) {
    await borrow?.release();
    await releaseUse();
    throw err;
  }

  const held = borrow;
  let restored = false;
  return {
    restore: async () => {
      if (restored) return;
      restored = true;
      try {
        // The borrow is let go INSIDE the write, so the next lane to ask
        // "am I the last?" already sees this one gone.
        await withRoleWrites(async () => {
          await inTransaction(base, (tx) =>
            giveBackIfLast(tx, role, held.pid, borrowsHeld(role) - 1),
          );
          await held.release();
        });
      } finally {
        await held.release();
        await releaseUse();
      }
    },
  };
}

/** One transaction on a session of its own on the server's `postgres` database. */
function inTransaction<T>(baseUrl: string, fn: (tx: Client) => Promise<T>): Promise<T> {
  return withMaintenance(baseUrl, async (client) => {
    await client.query("BEGIN");
    try {
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
  });
}
