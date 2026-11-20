/**
 * The rig's hand trigger for the launch gate (ticket #132; ADR-0016 as
 * amended, ADR-0020, ADR-0038).
 *
 * ADR-0016 as amended makes lifting "one audited act per company", and THIS
 * IS WHO INVOKES IT: the developer, by hand, at the rig — the same actor
 * and the same shape as the other break-glass triggers beside this file.
 * "On the rig it is a break-glass script the developer runs over their own
 * traffic; for a real owner it is the same act, gated by Test 4's precision
 * measurement rather than by a person's judgement." One door, two callers.
 *
 * IT IS NOT IDEMPOTENT, and it is the one trigger in this family that is
 * not. `rig-unmerge.ts` exits clean on a merge already reversed because an
 * operator who lost the first run's output should not have to tell a
 * refusal from a failure — but a launch gate opens ONCE, and the instant it
 * opened is a fact about the past that a second run would rewrite
 * (ADR-0034). So a repeat REFUSES, says when the company was really lifted,
 * and exits non-zero. Nothing is written by the refusal: no timestamp, no
 * flipped row, no chain entry.
 *
 * IT CLOSES ADR-0038'S PAYLOAD-MIGRATION WINDOW for this company, and that
 * is the one consequence to read before running it. That ADR's `OrderTaken`
 * migration "refuses, loudly, if a single non-shadow `OrderTaken` row
 * exists… This window closes the moment Test 4 flips the shadow flag" —
 * this is that moment. Any upcaster-free payload migration that wanted this
 * company's rows wants them BEFORE this runs, and will never be cheaper
 * than it is right now.
 *
 * IT TOLERATES A LIVE TWIN RUNTIME, which is worth saying because it was
 * not free. Both halves of the launch gate take the same company-scoped
 * lock — every filing path a shared one, this act an exclusive one — so a
 * crossing already in flight is either flipped by the act or stamped
 * visible by its own INSERT, and there is no third outcome. Without that, a
 * crossing that read «unlifted» a moment before the act could commit a
 * permanently invisible row into a company that IS lifted, with no second
 * run to repair it.
 *
 * THE LOCK IS COOPERATIVE, so that tolerance has one condition and it is
 * the operator's to meet (Codex r2): it binds writers running THIS build.
 * A `rig-run.ts` started before the shadow lift shipped still files with the
 * old INSERT, which takes no lock and lets `shadow` fall to the column
 * default — so it can commit an invisible row after this act has finished.
 * Restart the runtime on the current build before lifting, or stop it.
 * Nothing here can detect a stale writer, and inventing a version handshake
 * to guess at one would be machinery for a case an operator can simply
 * avoid.
 *
 * NO BUNDLE, NO TWIN KEY — like `rig-unmerge.ts` and `rig-finalize.ts`, and
 * for the stricter of their two reasons: deciding that a company's records
 * may be read by their owner opens no envelope and reads no conversation
 * (ADR-0004). What it needs is the Ledger and the chain key.
 *
 * WHO the operator was is not recorded, deliberately, exactly as the
 * unmerge does not record it: there is no operator identity in the Ledger,
 * and reaching production at all is an audited session (ADR-0016) feeding
 * the same chain this appends to. That session is the answer to "who".
 *
 * THE DATABASE STAMPS THE INSTANT, and `DITO_RIG_NOW` does not move it.
 * That variable moves the REP's clock for the three SCHEDULED hand triggers
 * (rig.sh says so in as many words), because each of them asks "which day is
 * it for the rep" and a session needs to steer that. This asks nothing of
 * the kind: `shadow_lifted_at` records WHEN A COMPANY'S LEDGER BECAME
 * READABLE, which happened inside the transaction below and at no other
 * instant — so this command passes no time at all and the store writes
 * `now()`, exactly as `entity_unmerges.unmerged_at` does. A steerable one
 * would let a session write down that an owner could read something a day
 * before they could.
 *
 * THE OUTPUT IS OPAQUE (ADR-0020: application logs carry opaque ids only).
 * It prints the company id, the instant and two counts — no customer, no
 * fact, no name, and nothing this command's own argument did not already
 * put on the session's transcript.
 *
 * Usage: source .env.rig, then
 *   node --experimental-strip-types scripts/rig-lift-shadow.ts <companyId>
 * The company id is DITO_COMPANY_ID on a rig; `rig-seed-owner.ts` must have
 * registered it first. (build first: pnpm build)
 */
import {
  liftCompanyShadow,
  ShadowAlreadyLiftedError,
  ShadowLiftUnknownCompanyError,
} from "@dito/aperture";
import { hmacKeyFromEnv } from "@dito/audit";
import pg from "pg";

const USAGE =
  "usage: source .env.rig && node --experimental-strip-types scripts/rig-lift-shadow.ts <companyId>";

/**
 * Checked HERE rather than left to a Postgres cast, the rule `rig-unmerge`
 * states: a mistyped id must land as this file's own refusal, because
 * `invalid input syntax for type uuid` on a break-glass verb tells an
 * operator nothing about what they did wrong.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const args = process.argv.slice(2);
// A MISTYPED FLAG STOPS THE RUN rather than being ignored, as its siblings
// do. This command takes no flags at all, so any is one.
const flags = args.filter((arg) => arg.startsWith("--"));
const [companyId, ...rest] = args.filter((arg) => !arg.startsWith("--"));
const dbUrl = process.env["DITO_DATABASE_URL"];
if (
  companyId === undefined ||
  rest.length > 0 ||
  flags.length > 0 ||
  dbUrl === undefined
) {
  console.error(USAGE);
  process.exit(1);
}
if (!UUID.test(companyId)) {
  console.error(`company id ${JSON.stringify(companyId)} is not a UUID`);
  console.error(USAGE);
  process.exit(1);
}

// Read before connecting: the chain key is fail-closed with no fallback
// (ADR-0020), and an operator who forgot to source `.env.rig` should find
// out before anything opens.
const hmacKey = hmacKeyFromEnv();

const db = new pg.Client({ connectionString: dbUrl });
await db.connect();
try {
  // THE SCRIPT OPENS NO TRANSACTION. `liftCompanyShadow` runs inside the
  // aperture's own unit, which is what makes the timestamp, the flipped
  // rows and the chain entry land together or not at all.
  const lifted = await liftCompanyShadow({ db, hmacKey }, { companyId });
  console.log(
    `lifted company ${lifted.companyId} at ${lifted.liftedAt.toISOString()}`,
  );
  console.log(
    `${lifted.entities} entity row(s) and ${lifted.facts} fact row(s) are no longer shadow`,
  );
  console.log(
    "everything this company files from now on lands visible on its own — nothing has to be flipped again (ADR-0016 as amended)",
  );
  console.log(
    "a finalized fact is what an owner reads, so a fact still inside its 24h correction window appears when that window closes (ADR-0004)",
  );
  console.log(
    "ADR-0038's payload-migration window is now CLOSED for this company: an upcaster-free migration over its rows is no longer possible",
  );
} catch (err) {
  if (err instanceof ShadowAlreadyLiftedError) {
    // A REFUSAL, not a failure to report as one: the operator asked for a
    // state the store is already in, and unlike every other trigger here
    // that is not something to shrug at — a second lift would rewrite when
    // this company's Ledger became readable. Nothing was written.
    console.error(
      `company ${err.companyId} was already lifted at ${err.liftedAt.toISOString()} — a launch gate opens once, and nothing was written`,
    );
    process.exitCode = 1;
  } else if (err instanceof ShadowLiftUnknownCompanyError) {
    console.error(
      `no company ${err.companyId} is registered — run rig-seed-owner.ts "<company>" "<rep>" first, and check DITO_COMPANY_ID`,
    );
    process.exitCode = 1;
  } else {
    throw err;
  }
} finally {
  await db.end();
}
