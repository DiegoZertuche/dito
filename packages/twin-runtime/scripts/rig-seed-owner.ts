/**
 * The rig's hand trigger for the owner side's two registry rows (ticket
 * #127; ADR-0004 as amended, ADR-0016 as amended, ADR-0027 as context).
 *
 * WHY THIS IS A SCRIPT AND NOT A MIGRATION. The rig's company, seat and
 * twin ids are ENVIRONMENT, not data: `scripts/rig-env-init.sh` mints them
 * once into the gitignored `.env.rig`, and they differ per developer. A
 * migration seeding them would have to invent ids nothing else uses, or
 * hard-code one machine's. Every rig-specific row so far has come from a
 * script beside this one, for the same reason.
 *
 * WHAT IT WRITES. One `companies` row and one `seats` row, naming the ids
 * that have been on every seam row since the rig was first linked, so that
 * the owner's views have a company to scope to and a seat to render the
 * filing seat as (ADR-0004 as amended: the owner sees the rep's display
 * name through the seats view, never the twin). It does NOT lift the
 * shadow flag — that is `rig-lift-shadow` (#132), one audited act — and it
 * writes no fact, no entity and nothing in `ledger` at all.
 *
 * IT ALSO SETS THE OWNER ROLE'S PASSWORD, which is the other half of a
 * usable owner side. The migration that creates `dito_owner` deliberately
 * ships no password: a migration is a reviewed, checksummed, forever
 * readable artifact (ADR-0029), and a password in one is a password in
 * every clone. The rig's lives in `.env.rig` beside the audit chain's HMAC
 * key, and this is what puts it on the role.
 *
 * IDEMPOTENT ON RETRY, like every hand trigger beside it: a second run
 * updates the two display names and the password and says so, because an
 * operator who lost the first run's output should not have to tell a
 * refusal from a failure.
 *
 * NO BUNDLE, NO TWIN KEY. Registering a seat decides nothing about a
 * conversation and may not open an envelope to do it (ADR-0004). It needs
 * the database and the two names, and not even the chain's key: this
 * writes no Ledger row and performs no act ADR-0020 covers.
 *
 * THE OUTPUT IS OPAQUE (ADR-0020: application logs carry opaque ids only).
 * The names are printed back because the operator typed them into this
 * command a line earlier, so echoing them puts nothing on the session's
 * transcript that was not already there.
 *
 * Usage: source .env.rig, then
 *   node --experimental-strip-types scripts/rig-seed-owner.ts "<company>" "<rep>"
 *
 * (build first: `pnpm build` — the seat's state comes from `@dito/seam`'s
 * `SEAT_STATES` rather than from a word spelled here (#221), and that import
 * resolves against the package's `dist`.)
 */
import { SEAT_LINKED } from "@dito/seam";
import pg from "pg";

const USAGE =
  'usage: source .env.rig && node --experimental-strip-types scripts/rig-seed-owner.ts "<company display name>" "<rep display name>"';

const [companyName, repName, ...rest] = process.argv.slice(2);
const dbUrl = process.env["DITO_DATABASE_URL"];
const companyId = process.env["DITO_COMPANY_ID"];
const seatId = process.env["DITO_SEAT_ID"];
const twinId = process.env["DITO_TWIN_ID"];
const ownerPassword = process.env["DITO_OWNER_DB_PASSWORD"];

if (
  companyName === undefined ||
  repName === undefined ||
  rest.length > 0 ||
  companyName.trim() === "" ||
  repName.trim() === ""
) {
  console.error(USAGE);
  process.exit(1);
}
for (const [name, value] of [
  ["DITO_DATABASE_URL", dbUrl],
  ["DITO_COMPANY_ID", companyId],
  ["DITO_SEAT_ID", seatId],
  ["DITO_TWIN_ID", twinId],
  // Named separately in the error below, because this one is the variable
  // `rig-env-init.sh` did not mint for a rig created before ticket #127 —
  // an existing `.env.rig` is never overwritten (the chain's HMAC key must
  // stay stable), so an older rig appends this line by hand.
  ["DITO_OWNER_DB_PASSWORD", ownerPassword],
] as const) {
  if (value === undefined || value === "") {
    console.error(
      `${name} is not set. Source .env.rig first; if ${name} is missing from it, append it (it is minted by scripts/rig-env-init.sh on a fresh rig).`,
    );
    console.error(USAGE);
    process.exit(1);
  }
}

const db = new pg.Client({ connectionString: dbUrl });
await db.connect();
try {
  await db.query("BEGIN");
  const company = await db.query<{ shadow_lifted_at: Date | null }>(
    `INSERT INTO companies (id, display_name) VALUES ($1, $2)
     ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name
     RETURNING shadow_lifted_at`,
    [companyId, companyName],
  );
  // `linked` AND NOT `active`. FR-63's three states are what `seats.state`
  // holds (#221), and the rig's seat is one whose number IS linked. The word
  // comes from `SEAT_STATES` rather than being spelled again: a state this
  // script writes that the store refuses is a rig that cannot be seeded.
  await db.query(
    `INSERT INTO seats (id, company_id, twin_id, rep_display_name, state)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (id) DO UPDATE SET rep_display_name = EXCLUDED.rep_display_name`,
    [seatId, companyId, twinId, repName, SEAT_LINKED],
  );
  // The password is not a parameter: PostgreSQL takes it as a literal in
  // the ALTER, so it is escaped here rather than bound. It never reaches
  // stdout, and it is the operator's own value out of `.env.rig`.
  await db.query(
    `ALTER ROLE dito_owner PASSWORD ${sqlStringLiteral(ownerPassword!)}`,
  );
  await db.query("COMMIT");

  console.log(`company ${companyId} registered as «${companyName}»`);
  console.log(
    `seat ${seatId} registered as «${repName}», ${SEAT_LINKED}, owning twin ${twinId}`,
  );
  console.log("dito_owner's password set from DITO_OWNER_DB_PASSWORD");
  console.log(
    company.rows[0]!.shadow_lifted_at === null
      ? "this company's Ledger is NOT lifted: every row it holds is still shadow, and the owner sees none of them until the lift act runs (#132)"
      : `this company's Ledger was lifted at ${company.rows[0]!.shadow_lifted_at.toISOString()}`,
  );
} catch (err) {
  await db.query("ROLLBACK");
  throw err;
} finally {
  await db.end();
}

/** A single-quoted SQL string literal, doubling any quote inside it. */
function sqlStringLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
