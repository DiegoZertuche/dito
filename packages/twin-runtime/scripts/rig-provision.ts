/**
 * Rig provisioning for #26 (one-time): provisionTwin in the #20 order,
 * then seed the four config tables — scope allowlist (counterparty
 * chat), send allowlist (counterparty destination), CONSERVATIVE_DEV_PACING,
 * and the history window FR-15's ninety days live in (ticket #222).
 * An unseeded twin cannot send by design (#24) and cannot FILL by design
 * either: the plane refuses a scope-in whose twin has no window row rather
 * than choosing a window nobody promised. Idempotent inserts;
 * TwinAlreadyProvisionedError is tolerated so a re-run only re-seeds.
 *
 * Usage: source .env.rig, then
 *   node --experimental-strip-types scripts/rig-provision.ts <counterpartyNumber>
 * (build first: pnpm build)
 */
import { KMSClient } from "@aws-sdk/client-kms";
import pg from "pg";
import {
  CONSERVATIVE_DEV_PACING,
  DEFAULT_HISTORY_WINDOW_DAYS,
  provisionTwin,
  TwinAlreadyProvisionedError,
} from "../dist/index.js";

const twinId = process.env["DITO_TWIN_ID"];
const dbUrl = process.env["DITO_DATABASE_URL"];
const counterparty = process.argv[2];
if (twinId === undefined || dbUrl === undefined || counterparty === undefined) {
  console.error(
    "usage: source .env.rig && node --experimental-strip-types scripts/rig-provision.ts <counterpartyNumber>",
  );
  process.exit(1);
}
if (!/^\d{10,15}$/.test(counterparty)) {
  console.error(`counterparty must be international digits only, got: ${counterparty}`);
  process.exit(1);
}
const counterpartyJid = `${counterparty}@s.whatsapp.net`;
const bundlePath = new URL(`../../../rig-data/twin-${twinId}.bundle`, import.meta.url).pathname;

const db = new pg.Client({ connectionString: dbUrl });
await db.connect();
try {
  try {
    await provisionTwin({ kms: new KMSClient({}), db, twinId, bundlePath });
    console.log(`provisioned: twin ${twinId}, bundle at ${bundlePath}`);
  } catch (err) {
    if (err instanceof TwinAlreadyProvisionedError) {
      console.log("twin already provisioned — re-seeding config only");
    } else {
      throw err;
    }
  }
  await db.query(
    "INSERT INTO scope_allowlist (twin_id, chat_jid) VALUES ($1, $2) ON CONFLICT DO NOTHING",
    [twinId, counterpartyJid],
  );
  await db.query(
    "INSERT INTO send_allowlist (twin_id, destination_jid) VALUES ($1, $2) ON CONFLICT DO NOTHING",
    [twinId, counterpartyJid],
  );
  await db.query(
    `INSERT INTO pacing_thresholds (twin_id, max_sends_per_hour, min_seconds_between_sends)
     VALUES ($1, $2, $3) ON CONFLICT (twin_id) DO UPDATE
       SET max_sends_per_hour = EXCLUDED.max_sends_per_hour,
           min_seconds_between_sends = EXCLUDED.min_seconds_between_sends`,
    [twinId, CONSERVATIVE_DEV_PACING.maxSendsPerHour, CONSERVATIVE_DEV_PACING.minSecondsBetweenSends],
  );
  await db.query(
    `INSERT INTO history_windows (twin_id, days) VALUES ($1, $2)
     ON CONFLICT (twin_id) DO UPDATE SET days = EXCLUDED.days`,
    [twinId, DEFAULT_HISTORY_WINDOW_DAYS],
  );
  console.log(`seeded: scope+send allowlist for ${counterpartyJid}, pacing ${CONSERVATIVE_DEV_PACING.maxSendsPerHour}/hr ${CONSERVATIVE_DEV_PACING.minSecondsBetweenSends}s, history window ${DEFAULT_HISTORY_WINDOW_DAYS}d`);
} finally {
  await db.end();
}
