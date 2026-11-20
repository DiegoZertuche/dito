/**
 * THE GATED SES LANE — real SES to a dev mailbox, or a loud skip (ticket
 * #219 AC 5; spec #214 *Notify, in detail*; ADR-0028's no-emulation rule).
 *
 * ADR-0028 is why this file has no fake in it: the crypto path is never
 * mocked and neither is this one. When the lane's three inputs are present
 * the two 6a messages are really sent, to a mailbox the operator owns, and
 * the send record is asserted afterwards. When they are absent the suite is
 * SKIPPED — the KMS lane's pattern exactly — and `ci.yml` annotates the run
 * so a green nobody can interpret is impossible.
 *
 *   DITO_REQUIRE_SES=1        this run must exercise SES
 *   DITO_SES_FROM             the verified sender the mail says it is from
 *   DITO_SES_DEV_MAILBOX      the operator's own inbox, which the seat gets
 *
 * ...plus AWS credentials in the environment, which the SDK resolves the
 * way `@dito/crypto`'s KMS lane resolves its own.
 *
 * `DITO_REQUIRE_SES=1` WITH ANYTHING MISSING IS A FAILURE, not a skip. That
 * is the half a `skipIf` cannot do: a run that was told to prove the rail
 * works and quietly proved nothing is the silent green this repo's whole
 * invariant discipline exists to refuse.
 *
 * THE EVIDENCE IS CONTENT-FREE. What this lane leaves behind is the
 * `notify_sends` row — seat, type, instant, outcome, provider id — and one
 * printed line naming the provider id so an operator can find the message
 * in the provider's console. Never the address, never the code, never the
 * body: those are the message's, and ADR-0019's flow 4 keeps them out of
 * every store and every log.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { createLiveNotify } from "./index.js";
import { resetAndMigrate, seedSeat, TEST_DATABASE_URL } from "./testing/db.js";

const required = process.env["DITO_REQUIRE_SES"] === "1";
const from = process.env["DITO_SES_FROM"];
const mailbox = process.env["DITO_SES_DEV_MAILBOX"];
const missing = [
  ...(from === undefined || from === "" ? ["DITO_SES_FROM"] : []),
  ...(mailbox === undefined || mailbox === "" ? ["DITO_SES_DEV_MAILBOX"] : []),
];
const ready = required && missing.length === 0;

describe("the SES lane's gate (ticket #219 AC 5)", () => {
  it("refuses to pass when it was told to exercise SES and cannot", () => {
    // Runs in every configuration, and only says anything in one: a run
    // that set DITO_REQUIRE_SES and did not set the addresses.
    if (!required) return;
    expect(
      missing,
      "DITO_REQUIRE_SES=1 asks this run to prove the email rail works, and these are unset — refusing to pass on a lane nobody was standing behind (ADR-0028 doctrine)",
    ).toEqual([]);
  });
});

describe.skipIf(!ready)("the two 6a messages, really sent (ticket #219 AC 5)", () => {
  let db: pg.Client;
  let pool: pg.Pool;

  beforeAll(async () => {
    await resetAndMigrate();
    db = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await db.connect();
    // DELETE AND NOT TRUNCATE, in dependency order: `acknowledgments`
    // refuses TRUNCATE (ticket #223) and carries a foreign key into `seats`,
    // so CASCADE would reach it. This file writes none.
    await db.query("DELETE FROM notify_sends");
    await db.query("DELETE FROM seats");
    await db.query("DELETE FROM companies");
    pool = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 2 });
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
    await db?.end();
  });

  it("sends the invitation to the seat's mailbox and records it", async () => {
    const seat = await seedSeat(db, { email: mailbox! });
    const notify = createLiveNotify({
      db: pool,
      from: from!,
      now: () => new Date(),
      dashboardOrigin: "https://dito.test",
    });

    const [record] = await notify.send({
      type: "invitation",
      seatId: seat.seatId,
      slots: { url: "https://dito.test/entrar/8f2c" },
    });

    expect(record!.outcome).toBe("sent");
    expect(record!.providerMessageId).not.toBeNull();
    // The lane's evidence, content-free: what was sent, for which seat, and
    // the provider's id. Nothing of the message itself.
    console.log(
      `SES lane: ${record!.type} for seat ${record!.seatId} → ${record!.outcome} (${record!.providerMessageId})`,
    );
  });

  it("sends the login code to the same mailbox and records it", async () => {
    const seat = await seedSeat(db, { email: mailbox! });
    const notify = createLiveNotify({
      db: pool,
      from: from!,
      now: () => new Date(),
      dashboardOrigin: "https://dito.test",
    });

    const [record] = await notify.send({
      type: "login_code",
      seatId: seat.seatId,
      // OBVIOUSLY SYNTHETIC. No login flow exists yet (#223), so this is not
      // a code anything would accept — it is six digits so the slot's type
      // takes it.
      slots: { code: "000000", url: "https://dito.test/entrar/8f2c", minutes: 10 },
    });

    expect(record!.outcome).toBe("sent");
    console.log(
      `SES lane: ${record!.type} for seat ${record!.seatId} → ${record!.outcome} (${record!.providerMessageId})`,
    );
  });

  it("leaves no address, no code and no body in the record", async () => {
    const rows = await db.query<{ row: string }>(
      "SELECT notify_sends::text AS row FROM notify_sends",
    );
    expect(rows.rows.length).toBeGreaterThan(0);
    for (const { row } of rows.rows) {
      expect(row).not.toContain("@");
      expect(row).not.toContain("000000");
    }
  });
});
