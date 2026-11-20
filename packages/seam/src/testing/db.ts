/**
 * Integration-test harness for the Postgres seam (ADR-0028: real Postgres,
 * migrations applied by the pinned Atlas — the one migration tool, ADR-0029).
 *
 * ONE MIGRATION PER RUN, A CLONE PER RESET (ticket #390). The lane's global
 * setup migrates one template with `scripts/migrate.sh` and seals it against
 * connections; a reset replaces the suite's own database with a fresh clone
 * of it (`CREATE DATABASE … TEMPLATE`, a file copy inside the server), so
 * every database a suite sees came out of Atlas and no suite can see another
 * file's rows. `database-url.ts` names every database involved.
 */
import pg from "pg";
import { buildTemplate, migrate, sqlIdentifier, withMaintenance } from "./admin.js";
import {
  assertResettable,
  baseDatabaseUrl,
  databaseNameOf,
  templateDatabaseName,
  testDatabaseUrl,
} from "./database-url.js";
import { withRoleWrites } from "./role-lock.js";

export const TEST_DATABASE_URL = testDatabaseUrl(process.env);

/**
 * Set by the lane's global setup once the template is migrated. Without it
 * (an evals script run by hand) the process migrates a template of its own
 * before its first reset.
 */
const RUN_MARKER = "DITO_TEST_RUN";

let ownTemplate: Promise<void> | null = null;

/**
 * Replaces the suite's database with a fresh clone of the run's migrated
 * template: every seam schema, the Ledger's and the Atlas revision history,
 * exactly as the migrations leave them.
 *
 * A DATABASE WITH ANOTHER SESSION ON IT IS RESET IN PLACE. A suite that
 * resets between its own tests holds its client open across the call, and
 * dropping the database would end that client under it. So a database
 * with a session on it — found first, or refused by the drop (55006) — is
 * not dropped, and the reset instead drops every
 * schema and re-applies the migrations with Atlas on the same database — the
 * one path that runs a migration during a run, and the reason it holds the
 * role lock (`role-lock.ts`): the migrations write cluster-global roles.
 */
export async function resetAndMigrate(): Promise<void> {
  const name = databaseNameOf(TEST_DATABASE_URL);
  assertResettable(name, process.env);
  const base = baseDatabaseUrl(process.env);
  if (process.env[RUN_MARKER] !== "1") {
    ownTemplate ??= buildTemplate(base);
    await ownTemplate;
  }
  const template = templateDatabaseName(databaseNameOf(base));
  const cloned = await withMaintenance(base, async (admin) => {
    // Asked first because a refused drop is slow: Postgres waits five
    // seconds for the other sessions to leave before it answers 55006.
    const others = await admin.query(
      "SELECT 1 FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid() LIMIT 1",
      [name],
    );
    if (others.rows.length > 0) return false;
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${sqlIdentifier(name)}`);
    } catch (err) {
      if (pgErrorCode(err) === "55006") return false;
      throw err;
    }
    await admin.query(
      `CREATE DATABASE ${sqlIdentifier(name)} TEMPLATE ${sqlIdentifier(template)}`,
    );
    return true;
  });
  if (!cloned) await withRoleWrites(resetInPlace);
}

/** Drops all seam state on the suite's own database and re-applies the migrations. */
async function resetInPlace(): Promise<void> {
  await withClient(async (client) => {
    // Every non-system schema, not a hand-kept list (ticket #50): the
    // migrations own more than `public` — the Ledger lives in its own
    // schema — and a reset that names schemas one by one goes stale the
    // moment a migration adds another.
    await client.query(`
      DO $$
      DECLARE target text;
      BEGIN
          FOR target IN
              SELECT nspname FROM pg_namespace
               WHERE nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
                 AND nspname NOT LIKE 'pg\\_temp%'
                 AND nspname NOT LIKE 'pg\\_toast\\_temp%'
          LOOP
              EXECUTE format('DROP SCHEMA IF EXISTS %I CASCADE', target);
          END LOOP;
      END;
      $$;`);
    await client.query("CREATE SCHEMA public");
  });
  migrate(TEST_DATABASE_URL);
}

/** Opens a client, runs `fn`, always closes. */
export async function withClient<T>(
  fn: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/**
 * Opens a SECOND connection, authenticated as `role`, runs `fn`, always
 * closes (ticket #127).
 *
 * `SET ROLE` inside the schema owner's own session is the existing
 * precedent (`invariants.int.test.ts`) and it is not enough here. Slice 4's
 * whole claim is that a process AUTHENTICATES as an application role, and
 * `security_invoker`, row-level security and `current_setting` all behave
 * the same under `SET ROLE` — so a test that took the shortcut would leave
 * the one new thing unproven: that the owner app can connect at all, with a
 * password of its own, and reach exactly the objects it was granted.
 *
 * The password is the caller's, borrowed onto the role with
 * `borrowOwnerPassword`: roles are cluster-global, so a role and its
 * password outlive every reset, and the borrow is what keeps suites running
 * at once from changing it under each other (`role-lock.ts`).
 */
export async function withRoleClient<T>(
  role: string,
  password: string,
  fn: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const url = new URL(TEST_DATABASE_URL);
  url.username = role;
  url.password = password;
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** Returns the SQLSTATE code carried by a Postgres error, if any. */
export function pgErrorCode(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null && "code" in err) {
    return String((err as { code?: unknown }).code);
  }
  return undefined;
}
