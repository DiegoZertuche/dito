/**
 * The rig's hand trigger for rep-web's own login credential (ticket #221;
 * spec #214 decision 5; ADR-0002, ADR-0029).
 *
 * WHY IT IS A SIBLING OF `rig-seed-owner.ts` AND NOT A SECTION OF IT. That
 * script sets `dito_owner`'s password and registers the owner side's two
 * rows, and the name is the record: a script called *seed-owner* setting the
 * REP side's login is the one place an operator would look last. #157's whole
 * finding was that owner-side and rep-side credentials had been allowed to
 * share a home — one chain key, one grant — and the fix was to separate them
 * everywhere they touch. This is that separation applied to the launchers.
 *
 * IT WRITES NO ROW. `rig-seed-owner.ts` owns the `companies` and `seats` rows,
 * because there is exactly one seat on the rig and it is the one the owner's
 * views render. What rep-web needs beyond them is a password on its role, and
 * the migration that creates `dito_rep_web` deliberately ships none: a
 * migration is a reviewed, checksummed, forever-readable artifact (ADR-0029),
 * and a password in one is a password in every clone of this repo.
 *
 * IDEMPOTENT ON RETRY, like every hand trigger beside it: a second run sets
 * the same password again and says so, because an operator who lost the first
 * run's output should not have to tell a refusal from a failure.
 *
 * NO BUNDLE, NO TWIN KEY, NO CHAIN KEY. Setting a role's password decides
 * nothing about a conversation and performs no act ADR-0020 covers.
 *
 * THE PASSWORD NEVER REACHES STDOUT. What is printed is that the role has one
 * — the same rule `rig-notify.ts` follows for an address.
 *
 * Usage: source .env.rig, then
 *   node --experimental-strip-types scripts/rig-seed-rep-web.ts
 *
 * (build first: `pnpm build` — the role's name comes from `@dito/aperture`,
 * where the grants clause pins it.)
 */
import { REP_WEB_ROLE } from "@dito/aperture";
import pg from "pg";

const USAGE =
  "usage: source .env.rig && node --experimental-strip-types scripts/rig-seed-rep-web.ts";

const dbUrl = process.env["DITO_DATABASE_URL"];
const password = process.env["DITO_REP_WEB_DB_PASSWORD"];

for (const [name, value] of [
  ["DITO_DATABASE_URL", dbUrl],
  // Appended by hand rather than minted: `scripts/rig-env-init.sh` never
  // overwrites an existing `.env.rig`, because the chain's HMAC key must stay
  // stable. `README.md` names this line beside the owner's (#221).
  ["DITO_REP_WEB_DB_PASSWORD", password],
] as const) {
  if (value === undefined || value === "") {
    console.error(
      `${name} is not set. Source .env.rig first; if ${name} is missing from it, append it (openssl rand -hex 24 is a fine value).`,
    );
    console.error(USAGE);
    process.exit(1);
  }
}

const db = new pg.Client({ connectionString: dbUrl });
await db.connect();
try {
  // The password is not a parameter: PostgreSQL takes it as a literal in the
  // ALTER, so it is escaped here rather than bound. It never reaches stdout,
  // and it is the operator's own value out of `.env.rig`.
  await db.query(
    `ALTER ROLE ${sqlIdentifier(REP_WEB_ROLE)} PASSWORD ${sqlStringLiteral(password!)}`,
  );
  console.log(`${REP_WEB_ROLE}'s password set from DITO_REP_WEB_DB_PASSWORD`);
  console.log(
    "rep-web can now authenticate. Start it with ./rig-rep.sh, which reads DITO_REP_WEB_DATABASE_URL by name from .env.rig and starts the app from an EMPTY environment (ADR-0002).",
  );
} finally {
  await db.end();
}

/** A single-quoted SQL string literal, doubling any quote inside it. */
function sqlStringLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * A quoted SQL identifier, doubling any double-quote inside it.
 *
 * The role's name is a CONSTANT from `@dito/aperture` rather than an
 * argument, so this quoting protects nothing a caller could reach — it is
 * here because `ALTER ROLE` takes no parameter, and an unquoted identifier
 * folds case, which is how a password lands on a cluster-global object that
 * is not the one the code named (`borrowOwnerPassword`'s own argument).
 */
function sqlIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
