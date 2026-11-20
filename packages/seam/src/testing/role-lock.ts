/**
 * THE ROLE LOCK: SUITES RUNNING AT ONCE SHARE ONE SET OF ROLES (ticket #390).
 *
 * Databases are per file; roles are CLUSTER-GLOBAL. Three kinds of writer
 * touch them during a run: a suite borrowing an application role's password
 * (`owner-password.ts`), a reset that re-applies the migrations in place
 * (their `ALTER ROLE` statements, `db.ts`), and the two files that move a
 * role's attributes or password on purpose (`ROLE_WRITING_FILES` in
 * `integration-file.ts`). Without coordination they collide in two ways:
 * two updates of one `pg_authid` row at once fail with "tuple concurrently
 * updated", and a suite that set `BYPASSRLS` for one assertion is undone,
 * or seen, by another file mid-assertion.
 *
 * TWO ADVISORY LOCKS on the server's `postgres` database. Advisory locks are
 * scoped to a database, so every process takes them on the same one — and on
 * that one rather than the run's own, because roles are shared by every run
 * on the server: the plane's Go suite takes the same two around its
 * migrations (`plane/internal/testdb`), and so does a second lane on another
 * base.
 *
 * - USE, held SHARED by every suite relying on a role as the migrations and
 *   the borrow leave it, for as long as it relies on it; held EXCLUSIVE by a
 *   file that changes a role on purpose, for the whole file.
 * - WRITE, held exclusive around every write to a role. Always taken after
 *   USE, so the order is one and the pair cannot deadlock.
 *
 * Both are session locks on ONE connection per process, so a process
 * re-entering a lock it holds (a file holding USE exclusive that borrows; a
 * borrower resetting in place) is granted at once — Postgres stacks a
 * session's own advisory locks — and every release matches its acquire.
 *
 * Outside a run (an evals script by hand) the helpers run their work
 * directly: the one role write such a process makes is a reset in place,
 * which only a suite's own open session forces.
 */
import pg from "pg";
import { baseDatabaseUrl, withDatabaseName } from "./database-url.js";
import { BORROW_CLASS } from "./role-borrows.js";

/**
 * The advisory lock class this harness owns, and its two keys. The plane's
 * `testdb` package spells the same three numbers; they are one lock.
 */
const LOCK_CLASS = 390;
const USE = 1;
const WRITE = 2;

/** Whether the lane's global setup is running this process (`integration-run.ts`). */
export function inRun(): boolean {
  return process.env["DITO_TEST_RUN"] === "1";
}

interface Coordination {
  client: Promise<pg.Client> | null;
  holds: number;
  /** How many borrows of each role this process holds now. */
  borrows: Map<string, number>;
  /** The tail of this process's role writes, which run one at a time. */
  writes: Promise<unknown>;
}

/**
 * On `globalThis` rather than in module scope: a suite that resets its
 * module registry would otherwise open a second session, and a session
 * waiting on its own process's lock never wakes.
 */
const STATE = Symbol.for("dito.testing.roleLock");

function state(): Coordination {
  const holder = globalThis as unknown as Record<symbol, Coordination | undefined>;
  holder[STATE] ??= { client: null, holds: 0, borrows: new Map(), writes: Promise.resolve() };
  return holder[STATE];
}

async function session(): Promise<pg.Client> {
  const s = state();
  s.client ??= (async () => {
    const client = new pg.Client({
      connectionString: withDatabaseName(baseDatabaseUrl(process.env), "postgres"),
    });
    await client.connect();
    return client;
  })();
  return s.client;
}

/**
 * Takes USE in `mode` and answers the release. In a run only; outside one
 * the release is a no-op.
 */
export async function holdRoles(
  mode: "shared" | "exclusive",
): Promise<() => Promise<void>> {
  if (!inRun()) return async () => {};
  const fn = mode === "shared" ? "pg_advisory_lock_shared" : "pg_advisory_lock";
  const unlock = mode === "shared" ? "pg_advisory_unlock_shared" : "pg_advisory_unlock";
  await acquire(`SELECT ${fn}($1, $2)`, USE);
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await release(`SELECT ${unlock}($1, $2)`, USE);
  };
}

/**
 * Takes the borrow of `role` (`role-borrows.ts`): a shared advisory lock
 * keyed by the role, held on this process's lock session until the
 * release, which is how every lane counts who still holds one. Answers the
 * session's backend pid, what the count leaves out when this process asks
 * whether it is the last, and the release.
 */
export async function holdBorrow(
  role: string,
): Promise<{ pid: number; release: () => Promise<void> }> {
  const s = state();
  await acquireWith("SELECT pg_advisory_lock_shared($1, hashtext($2))", [BORROW_CLASS, role]);
  s.borrows.set(role, (s.borrows.get(role) ?? 0) + 1);
  const pid = (await (await session()).query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))
    .rows[0]!.pid;
  let released = false;
  return {
    pid,
    release: async () => {
      if (released) return;
      released = true;
      s.borrows.set(role, (s.borrows.get(role) ?? 1) - 1);
      await releaseWith("SELECT pg_advisory_unlock_shared($1, hashtext($2))", [BORROW_CLASS, role]);
    },
  };
}

/** How many borrows of `role` this process holds now. */
export function borrowsHeld(role: string): number {
  return state().borrows.get(role) ?? 0;
}

/**
 * Runs `fn` holding USE shared and WRITE. In a run only; outside one `fn`
 * runs with no lock.
 *
 * ONE AT A TIME WITHIN THE PROCESS TOO: the session's own locks never block
 * it, so two writes from one process would otherwise interleave their
 * transactions on the one connection.
 */
export async function withRoleWrites<T>(fn: () => Promise<T>): Promise<T> {
  if (!inRun()) return fn();
  const s = state();
  const turn = s.writes.then(() => lockedWrite(fn));
  s.writes = turn.catch(() => undefined);
  return turn;
}

async function lockedWrite<T>(fn: () => Promise<T>): Promise<T> {
  const releaseUse = await holdRoles("shared");
  try {
    await acquire("SELECT pg_advisory_lock($1, $2)", WRITE);
    try {
      return await fn();
    } finally {
      await release("SELECT pg_advisory_unlock($1, $2)", WRITE);
    }
  } finally {
    await releaseUse();
  }
}

function acquire(sql: string, key: number): Promise<void> {
  return acquireWith(sql, [LOCK_CLASS, key]);
}

function release(sql: string, key: number): Promise<void> {
  return releaseWith(sql, [LOCK_CLASS, key]);
}

async function acquireWith(sql: string, params: unknown[]): Promise<void> {
  const s = state();
  s.holds += 1;
  try {
    await (await session()).query(sql, params);
  } catch (err) {
    await settle(-1);
    throw err;
  }
}

async function releaseWith(sql: string, params: unknown[]): Promise<void> {
  try {
    await (await session()).query(sql, params);
  } finally {
    await settle(-1);
  }
}

/** Counts holds and closes the session when the last one goes, which frees every lock it had. */
async function settle(delta: number): Promise<void> {
  const s = state();
  s.holds += delta;
  if (s.holds === 0 && s.client !== null) {
    const closing = s.client;
    s.client = null;
    await (await closing).end();
  }
}
