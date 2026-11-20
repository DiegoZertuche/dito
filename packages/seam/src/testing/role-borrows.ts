/**
 * THE RECORD OF BORROWED ROLE PASSWORDS (ticket #390), kept where every lane
 * on the server sees it: a table on the server's `postgres` database, one
 * row per role some suite has borrowed, holding the verifier the role had
 * before the first borrower. `owner-password.ts` argues why the borrow
 * exists; this module is the bookkeeping, shared by the borrow and by the
 * run's setup and teardown.
 *
 * WHO STILL HOLDS A BORROW IS NOT COUNTED IN A COLUMN. Each borrower holds a
 * shared advisory lock keyed by the role (class 391, `hashtext(role)`) on
 * its process's lock session for as long as it borrows, so the holders are
 * whatever `pg_locks` shows granted — and a worker that dies stops counting
 * the moment its session ends. The last one out, by that count, puts the
 * recorded verifier back. Every write here runs under the role lock's
 * WRITE (`role-lock.ts`), so two lanes never decide "last" at once.
 *
 * AND ONLY OVER THE BORROW'S OWN PASSWORD: the row also keeps the verifier
 * the last borrow installed, and the recorded one goes back only while the
 * role still holds that. A role somebody set again since — the rig's own
 * launcher reseeds its roles after a borrower died — keeps what they set,
 * and the stale row is dropped.
 */
import type { ClientBase } from "pg";
import { sqlIdentifier, sqlLiteral, withMaintenance } from "./admin.js";

/** The advisory class a borrow is held under; the key within it is `hashtext(role)`. */
export const BORROW_CLASS = 391;

const TABLE = "dito_test_role_borrows";

/**
 * Records `role`'s verifier unless a borrow already did — a row left by a
 * borrower still holding, or by one that died, carries the verifier from
 * before EITHER — and sets `password` on the role. Throws, writing nothing,
 * for a role that does not exist. The caller holds WRITE and the transaction.
 */
export async function recordBorrow(
  tx: ClientBase,
  role: string,
  password: string,
): Promise<void> {
  await tx.query(
    `CREATE TABLE IF NOT EXISTS ${TABLE} (role text PRIMARY KEY, verifier text, installed text)`,
  );
  const authid = await tx.query<{ rolpassword: string | null }>(
    "SELECT rolpassword FROM pg_authid WHERE rolname = $1",
    [role],
  );
  const found = authid.rows[0];
  if (found === undefined) {
    throw new Error(`no role ${role} in pg_authid — is this database migrated?`);
  }
  await tx.query(
    `INSERT INTO ${TABLE} (role, verifier) VALUES ($1, $2) ON CONFLICT (role) DO NOTHING`,
    [role, found.rolpassword],
  );
  // Interpolated only now, when the catalog has confirmed it is a role name:
  // `ALTER ROLE` takes no parameters. QUOTED, the way the harness's own
  // reset quotes with `format('%I')` — the catalog match proves the row
  // exists, not that a bare spelling resolves back to it, and a role name
  // that folds to a DIFFERENT role is a password written to the wrong
  // cluster-global object.
  await tx.query(`ALTER ROLE ${sqlIdentifier(role)} PASSWORD ${sqlLiteral(password)}`);
  await tx.query(
    `UPDATE ${TABLE} SET installed = (SELECT rolpassword FROM pg_authid WHERE rolname = $1)
      WHERE role = $1`,
    [role],
  );
}

/**
 * Puts `role`'s recorded verifier back and clears its row when no session
 * but `self` holds a borrow of it — and `self` only as many times as
 * `selfHolds` says it still will after this one goes. The caller holds
 * WRITE and the transaction.
 */
export async function giveBackIfLast(
  tx: ClientBase,
  role: string,
  self: number | null,
  selfHolds: number,
): Promise<void> {
  if (!(await tableExists(tx))) return;
  const holders = await tx.query<{ others: string }>(
    `SELECT count(*) AS others FROM pg_locks
      WHERE locktype = 'advisory' AND granted AND objsubid = 2
        AND classid = $1 AND objid = hashtext($2)::oid
        AND pid IS DISTINCT FROM $3`,
    [BORROW_CLASS, role, self],
  );
  if (Number(holders.rows[0]!.others) + selfHolds > 0) return;
  const row = await tx.query<{ verifier: string | null; current: boolean }>(
    `DELETE FROM ${TABLE} WHERE role = $1
       RETURNING verifier,
                 (SELECT rolpassword FROM pg_authid WHERE rolname = $1)
                   IS NOT DISTINCT FROM installed AS current`,
    [role],
  );
  const recorded = row.rows[0];
  if (recorded === undefined || recorded.current !== true) return;
  // `ALTER ROLE … PASSWORD` stores an already-hashed `SCRAM-SHA-256$…`
  // string verbatim, so the role ends with the exact bytes it started with,
  // and a role that had no password gets none back.
  await tx.query(
    recorded.verifier === null
      ? `ALTER ROLE ${sqlIdentifier(role)} PASSWORD NULL`
      : `ALTER ROLE ${sqlIdentifier(role)} PASSWORD ${sqlLiteral(recorded.verifier)}`,
  );
}

/**
 * Gives back every borrow nobody holds any more — a worker or a whole run
 * that died mid-borrow — and drops the table once it is empty. The run's
 * setup and teardown call it, from a process that holds no lock, so it
 * takes the role lock on its own session in the one order (USE, WRITE).
 */
export async function recoverBorrows(baseUrl: string): Promise<void> {
  await withMaintenance(baseUrl, async (admin) => {
    await admin.query("SELECT pg_advisory_lock_shared(390, 1)");
    await admin.query("SELECT pg_advisory_lock(390, 2)");
    if (!(await tableExists(admin))) return;
    const rows = await admin.query<{ role: string }>(`SELECT role FROM ${TABLE}`);
    for (const { role } of rows.rows) {
      await admin.query("BEGIN");
      try {
        await giveBackIfLast(admin, role, null, 0);
        await admin.query("COMMIT");
      } catch (err) {
        await admin.query("ROLLBACK");
        throw err;
      }
    }
    const left = await admin.query(`SELECT 1 FROM ${TABLE} LIMIT 1`);
    if (left.rows.length === 0) await admin.query(`DROP TABLE ${TABLE}`);
  });
}

async function tableExists(client: ClientBase): Promise<boolean> {
  const found = await client.query<{ found: string | null }>(
    "SELECT to_regclass($1)::text AS found",
    [TABLE],
  );
  return found.rows[0]?.found !== null && found.rows[0]?.found !== undefined;
}
