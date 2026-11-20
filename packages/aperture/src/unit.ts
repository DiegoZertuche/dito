/**
 * The aperture's unit of work (ticket #50; ADR-0003, FR-72).
 *
 * "The aperture files a fact and enqueues its disclosure line in ONE
 * Postgres transaction" is the aperture's own guarantee, so the aperture
 * owns the transaction rather than borrowing a caller's discipline. Two
 * shapes, one contract:
 *
 *  - called in autocommit (the ordinary case): BEGIN / COMMIT / ROLLBACK;
 *  - called inside a caller's open transaction: a SAVEPOINT, released on
 *    success and rolled back to on failure — so the pair still lands
 *    together or not at all, inside whatever the caller is composing.
 *
 * Either way the deferred FR-72 constraint triggers fire at the OUTERMOST
 * commit, which is where "a fact that crossed undisclosed" stops being
 * representable.
 */
import type pg from "pg";

/** Postgres: SAVEPOINT outside a transaction block. */
const NO_ACTIVE_TRANSACTION = "25P01";

const SAVEPOINT = "dito_aperture_unit";

/** Runs `fn` as one atomic aperture unit on `db`. */
export async function withApertureUnit<T>(
  db: pg.ClientBase,
  fn: () => Promise<T>,
): Promise<T> {
  const nested = await inTransaction(db);
  if (!nested) {
    await db.query("BEGIN");
    try {
      const result = await fn();
      await db.query("COMMIT");
      return result;
    } catch (err) {
      await db.query("ROLLBACK");
      throw err;
    }
  }
  await db.query(`SAVEPOINT ${SAVEPOINT}`);
  try {
    const result = await fn();
    await db.query(`RELEASE SAVEPOINT ${SAVEPOINT}`);
    return result;
  } catch (err) {
    await db.query(`ROLLBACK TO SAVEPOINT ${SAVEPOINT}`);
    await db.query(`RELEASE SAVEPOINT ${SAVEPOINT}`);
    throw err;
  }
}

/**
 * Whether the client is already inside a transaction block, probed the way
 * @dito/audit probes it: SAVEPOINT is legal only inside one, so its
 * refusal is the answer.
 */
async function inTransaction(db: pg.ClientBase): Promise<boolean> {
  try {
    await db.query(`SAVEPOINT ${SAVEPOINT}_probe`);
    await db.query(`RELEASE SAVEPOINT ${SAVEPOINT}_probe`);
    return true;
  } catch (err) {
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      String((err as { code?: unknown }).code) === NO_ACTIVE_TRANSACTION
    ) {
      return false;
    }
    throw err;
  }
}
