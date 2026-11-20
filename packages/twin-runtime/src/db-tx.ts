/**
 * The one transaction wrapper for a seam connection: BEGIN, run, COMMIT —
 * ROLLBACK and rethrow on any failure. No nesting, deliberately.
 *
 * IT IS NO LONGER ONLY THE RUNTIME'S OWN CLIENT (ticket #173). Routing, the
 * settle predicate and every sequential outcome still run on the runtime's
 * dedicated connection; an EXECUTION runs its whole transaction on a
 * connection it borrowed for exactly that long, because the runner appends
 * its audit entry inside that transaction and `pg` queues per client — so two
 * executions interleaving on one connection would issue their statements into
 * each other's open transaction (`lanes.ts` argues it in full). The type says
 * `ClientBase` and always did.
 *
 * SO NO STAMP WRITTEN INSIDE ONE MAY READ `now()`: this transaction encloses
 * the execution's model round-trips (`tool-savepoints.ts`), and Postgres
 * `now()` is the instant this `BEGIN` ran. Every stamp a rep-side execution
 * writes takes `clock_timestamp()`, which …20260906100040 argues in full.
 */
import type pg from "pg";

export async function withDbTransaction<T>(
  db: pg.ClientBase,
  fn: () => Promise<T>,
): Promise<T> {
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

/**
 * THE DAILY PASS'S ONE PER-TWIN LOCK (ticket #53, Codex r2).
 *
 * Extraction's filing and the daily disclosure's assembly take the SAME
 * key, and that is what makes FR-39's "questions first" an ordering the
 * rep can rely on rather than one that holds when the two passes happen
 * not to overlap. With two keys, a below-threshold question could commit
 * between the disclosure's last look for questions and its facts post — so
 * the facts post would carry the earlier `created_at` and the question
 * would be dispatched behind it, which is exactly the order FR-39 forbids.
 *
 * Safe to share because neither holds it across a model call, and WHERE each
 * takes it is what makes that true: extraction takes it at its FILING step
 * (`extraction-pass.ts`) and the disclosure at its POSTING step
 * (`disclosure.ts`), both after every round-trip that execution makes. The
 * transaction around them is older than the lock — an execution's whole
 * transaction encloses its model calls (`withDbTransaction` above) — so this
 * is a lock held across writes only, and there is one key, so there is no
 * ordering to invert.
 *
 * `pg_advisory_xact_lock` — released by the surrounding commit or
 * rollback, the shape the audit chain's tail lock and the send lock both
 * use.
 */
export async function takeDailyPassLock(
  db: pg.ClientBase,
  twinId: string,
): Promise<void> {
  await db.query(
    "SELECT pg_advisory_xact_lock(hashtextextended('dito:daily_pass:twin:' || $1, 0))",
    [twinId],
  );
}

/**
 * THE BINDING CEREMONY'S ONE PER-TWIN LOCK (ticket #173).
 *
 * #34's rule is that a chat is asked about ONCE, EVER, and the asked-state is
 * the committed question notice — so the ceremony is a read followed by a
 * write, and until this ticket the two were separated by nothing because the
 * pass ran one execution at a time. They are not any more (`lanes.ts`): a
 * settled turn for an unbound chat and a thread answer citing that same chat
 * are two executions in one pass, and under READ COMMITTED both read
 * "unasked" before either committed. The rep would be asked twice about one
 * chat, permanently, because a notice is immutable.
 *
 * REACHABLE, not hypothetical: a customer writes while the rep asks their
 * twin about that customer, which is the ordinary shape of a rep's minute.
 *
 * TAKEN INSIDE THE EXECUTION'S TRANSACTION, AFTER THE CHAIN APPEND, and the
 * ORDER is what makes it deadlock-free. `runExecution` appends this
 * execution's entry — taking the chain's single tail lock — before the
 * effects are written, and the ceremony's read-and-write is an effect. So
 * every execution takes the tail lock and then this one, never the other way
 * round, and nothing else in the system takes this lock at all.
 *
 * PER TWIN rather than per chat, and the cost is nothing: the section it
 * guards is two indexed reads and one insert, and a twin's own executions are
 * the only contenders. `pg_advisory_xact_lock` — released by the surrounding
 * commit or rollback, the shape the audit chain's tail lock and the send lock
 * both use.
 */
export async function takeBindingCeremonyLock(
  db: pg.ClientBase,
  twinId: string,
): Promise<void> {
  await db.query(
    "SELECT pg_advisory_xact_lock(hashtextextended('dito:binding_ceremony:twin:' || $1, 0))",
    [twinId],
  );
}
