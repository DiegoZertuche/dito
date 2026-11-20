/**
 * THE RUN'S DATABASE ADMINISTRATION (ticket #390): building the template,
 * and creating and dropping databases from a session on none of them.
 *
 * `pg` IS LOADED THROUGH `createRequire`, because vitest runs the lane's
 * global setup through vite-node, whose resolver does not find a workspace
 * package's own dependencies from here — and the global setup imports this
 * module. Node's resolver does; the workers load it the same way.
 */
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Client } from "pg";
import {
  assertResettable,
  databaseNameOf,
  templateDatabaseName,
  withDatabaseName,
} from "./database-url.js";

const pg = createRequire(import.meta.url)("pg") as typeof import("pg");

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);

/** Opens a session on `url`, runs `fn`, always closes. */
export async function withSession<T>(
  url: string,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/**
 * A session on the server's `postgres` database, which every cluster has
 * and no suite uses: a database cannot be created from, or dropped by, a
 * session on itself.
 */
export function withMaintenance<T>(
  baseUrl: string,
  fn: (admin: Client) => Promise<T>,
): Promise<T> {
  return withSession(withDatabaseName(baseUrl, "postgres"), fn);
}

/** Applies `db/migrations` to `url` with the pinned Atlas (ADR-0029). */
export function migrate(url: string): void {
  execFileSync(path.join(REPO_ROOT, "scripts/migrate.sh"), [url], { stdio: "pipe" });
}

/**
 * Migrates the run's template from nothing with the pinned Atlas and seals
 * it: `IS_TEMPLATE` so it may be cloned, `ALLOW_CONNECTIONS false` because
 * a clone is refused while any session is on its source — nothing connects
 * to it after this returns.
 */
export async function buildTemplate(baseUrl: string): Promise<void> {
  const template = templateDatabaseName(databaseNameOf(baseUrl));
  await withMaintenance(baseUrl, async (admin) => {
    await dropDatabase(admin, template);
    await admin.query(`CREATE DATABASE ${sqlIdentifier(template)}`);
    // The migrations write cluster-global roles, so the template is migrated
    // under the role lock's USE shared and WRITE (`role-lock.ts`), on this
    // session: the process holds nothing else when it builds a template.
    await admin.query("SELECT pg_advisory_lock_shared(390, 1)");
    await admin.query("SELECT pg_advisory_lock(390, 2)");
    migrate(withDatabaseName(baseUrl, template));
  });
  await withMaintenance(baseUrl, (admin) =>
    admin.query(
      `ALTER DATABASE ${sqlIdentifier(template)} WITH IS_TEMPLATE true ALLOW_CONNECTIONS false`,
    ),
  );
}

/**
 * Drops `name` if it exists, ending any session left on it — for the run's
 * own setup and teardown, never for a reset, where the session is the
 * suite's. Guarded like every drop: the name must say "test".
 */
export async function dropDatabase(admin: Client, name: string): Promise<void> {
  assertResettable(name, process.env);
  const found = await admin.query<{ datistemplate: boolean }>(
    "SELECT datistemplate FROM pg_database WHERE datname = $1",
    [name],
  );
  const row = found.rows[0];
  if (row === undefined) return;
  if (row.datistemplate) {
    await admin.query(`ALTER DATABASE ${sqlIdentifier(name)} WITH IS_TEMPLATE false`);
  }
  await admin.query(`DROP DATABASE IF EXISTS ${sqlIdentifier(name)} WITH (FORCE)`);
}

/** A quoted SQL identifier, double-quotes doubled: DDL takes no parameters. */
export function sqlIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

/** A SQL string literal, quotes doubled. */
export function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
