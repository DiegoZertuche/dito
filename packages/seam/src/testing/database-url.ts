/**
 * THE DATABASE A SUITE RESETS, AND ONLY THE ONE IT WAS GIVEN (ticket #305).
 *
 * NO DEFAULT, because a suite's setup replaces the database it is given: on
 * a developer machine the obvious default is a database something else lives
 * in, and an unset variable would reset it. Its own module, importing nothing,
 * so the refusal and every name below are testable without connecting
 * anywhere.
 *
 * ONE VARIABLE NAMES A RUN, AND EVERY DATABASE THE RUN TOUCHES IS DERIVED
 * FROM IT (ticket #390). The integration lane runs files in parallel, each on
 * a database of its own cloned from one migrated template, so no suite can
 * see or reset another's rows. `DITO_TEST_DATABASE_URL` names the run's base;
 * the lane's setup file names the running file in `DITO_TEST_FILE`; the
 * file's database is the base's name followed by the file's. Outside a run
 * (the evals scripts) no file is named, and the base itself is the database a
 * reset replaces.
 */

/** The longest identifier Postgres keeps whole (NAMEDATALEN − 1). */
const MAX_DATABASE_NAME = 63;

/**
 * The suites whose databases a run keeps for CI's check scripts, which read
 * each one through `DITO_DATABASE_URL` instead of running the suite a second
 * time (ticket #390). Every other file's database is dropped when the run
 * ends. The workflow names these databases literally, and the unit suite
 * beside this module holds `.github/workflows/ci.yml` to this list.
 */
export const KEPT_FOR_CHECKS: readonly string[] = [
  "packages/twin-runtime/src/send-lock/writer.int.test.ts",
  "packages/twin-runtime/src/crossing.int.test.ts",
  "packages/twin-runtime/src/extraction.int.test.ts",
  "packages/twin-runtime/src/corrections.int.test.ts",
  "packages/twin-runtime/src/drafting.int.test.ts",
  "packages/twin-runtime/src/thread.int.test.ts",
  "packages/twin-runtime/src/dashboard-acts.int.test.ts",
  "packages/owner-twin/src/turn.int.test.ts",
  "packages/twin-runtime/src/fr73.int.test.ts",
  "packages/twin-runtime/src/audit-coverage.int.test.ts",
  "packages/aperture/src/shadow-lift.int.test.ts",
  "packages/evals/src/extraction-precision.int.test.ts",
];

type Env = Readonly<Record<string, string | undefined>>;

/**
 * The database the running suite owns: its file's when the lane named one,
 * else the base. Throws when the base is unset — there is no default.
 */
export function testDatabaseUrl(env: Env): string {
  const base = baseDatabaseUrl(env);
  const file = env["DITO_TEST_FILE"];
  if (file === undefined || file === "") return base;
  return withDatabaseName(base, fileDatabaseName(databaseNameOf(base), file));
}

/** The run's base, exactly as named. Throws when unset or empty. */
export function baseDatabaseUrl(env: Env): string {
  const url = env["DITO_TEST_DATABASE_URL"];
  if (url === undefined || url === "") {
    throw new Error(
      "DITO_TEST_DATABASE_URL is unset — point it at a test database this run may reset; the test helpers have no default",
    );
  }
  return url;
}

/**
 * The database a test file runs on: the base's name, then the file's path
 * from the repository root without its tree, `src/` or suffix.
 */
export function fileDatabaseName(baseName: string, file: string): string {
  const slug = file
    .replace(/^(packages|apps)\//u, "")
    .replace("/src/", "/")
    .replace(/\.int\.test\.ts$/u, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "");
  return checkedName(`${baseName}_${slug}`);
}

/** The run's migrated template: the one source every file's database is cloned from. */
export function templateDatabaseName(baseName: string): string {
  return checkedName(`${baseName}_template`);
}

/** The database a URL names. */
export function databaseNameOf(url: string): string {
  return decodeURIComponent(new URL(url).pathname.replace(/^\//u, ""));
}

/** The same server and credentials, another database. */
export function withDatabaseName(url: string, name: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${encodeURIComponent(name)}`;
  return parsed.toString();
}

/**
 * THE GUARD ON EVERY DROP: only a database whose name says "test" may be
 * replaced, unless `DITO_ALLOW_DB_RESET=1`. A mistyped URL carrying the
 * schema owner's credentials must never erase a real seam.
 */
export function assertResettable(name: string, env: Env): void {
  if (!/test/iu.test(name) && env["DITO_ALLOW_DB_RESET"] !== "1") {
    throw new Error(
      `refusing to reset non-test database "${name}" (set DITO_ALLOW_DB_RESET=1 to override)`,
    );
  }
}

/** Refuses a name Postgres would truncate, which could fold two files onto one database. */
function checkedName(name: string): string {
  if (name.length > MAX_DATABASE_NAME) {
    throw new Error(
      `test database name "${name}" is ${name.length} characters; Postgres keeps ${MAX_DATABASE_NAME} — shorten the base or the file name`,
    );
  }
  return name;
}
