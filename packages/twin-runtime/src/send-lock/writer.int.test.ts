/**
 * Send-lock writer integration tests (ticket #24) — the lock and the law,
 * exercised the pre-agreed way (spec #18): drafts, taps, and config are
 * minted directly as SQL fixtures on the real Postgres seam; behavior is
 * asserted through the writer's public interface and the seam rows the
 * plane's executor consumes. Nothing mocked (ADR-0028).
 *
 * Governing ADRs: 0006 (tap + command in one transaction), 0017 (allowlist
 * and pacing are domain logic at the writer), 0020 (refusals audit-chained).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { hmacKeyFromEnv, verifyAuditChainInDb } from "@dito/audit";
import { createBundle } from "@dito/bundle";
import { createDekFromMaterial } from "@dito/crypto";
import {
  attemptSend,
  createSendLockWriter as createSeamSendLockWriter,
  deferRefusal,
  reconcileFr70,
} from "@dito/seam";
import {
  CONSERVATIVE_DEV_PACING,
  createSendLockWriter,
  type SendLockWriter,
} from "./writer.js";
import { drainSendRefusals } from "./refusals.js";
import { dismissDraft } from "../rep-acts.js";
import { resetAndMigrate, withClient, TEST_DATABASE_URL } from "../testing/db.js";
import { removeTmpDir } from "../testing/tmp.js";

// The chain key: CI mints one per run and hands it to this suite AND the
// scripts/audit-verify.mjs step, so the invariant step verifies the very
// corpus this file writes. A bare local run chains under a throwaway key.
const hmacKey = process.env["DITO_AUDIT_HMAC_KEY"]
  ? hmacKeyFromEnv()
  : randomBytes(32);
let pool: pg.Pool;
let writer: SendLockWriter;
/** For the one test that needs a dismissal's whole dependency shape. */
let tmp: string;

beforeAll(async () => {
  await resetAndMigrate();
  tmp = mkdtempSync(join(tmpdir(), "dito-writer-int-"));
  pool = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 10 });
  writer = createSendLockWriter({ pool, hmacKey });
});

afterAll(async () => {
  await pool.end();
  removeTmpDir(tmp);
});

// Fixtures default to the shipped conservative dev values (slice AC 8) —
// the very thresholds rig provisioning seeds. Tests that need tighter or
// looser pacing override per twin.

interface Fixture {
  twinId: string;
  companyId: string;
  seatId: string;
  destination: string;
  draftId: string;
  /** The raw plane-delivered affirmation event (the «va» quoted reply). */
  affirmationEventId: string;
}

/**
 * Mints the full fixture family for one twin: an inbound customer event, a
 * draft answering it, the rep's affirmation event, the send-allowlist row
 * for the draft's destination, and pacing config.
 */
async function mintFixture(
  client: pg.ClientBase,
  overrides: {
    allowlisted?: boolean;
    pacing?: { maxSendsPerHour: number; minSecondsBetweenSends: number } | null;
  } = {},
): Promise<Fixture> {
  const twinId = randomUUID();
  const companyId = randomUUID();
  const seatId = randomUUID();
  const destination = `5215550${Math.floor(Math.random() * 1_000_000)}@s.whatsapp.net`;

  const inboundId = await insertWaEvent(client, { twinId, companyId, seatId });
  const draftRes = await client.query(
    `INSERT INTO drafts (twin_id, in_reply_to_event_id, destination, content_enc)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [twinId, inboundId, destination, Buffer.from("opaque-draft-ciphertext")],
  );
  const affirmationEventId = await insertWaEvent(client, { twinId, companyId, seatId });

  if (overrides.allowlisted !== false) {
    await client.query(
      "INSERT INTO send_allowlist (twin_id, destination_jid) VALUES ($1, $2)",
      [twinId, destination],
    );
  }
  const pacing =
    overrides.pacing === undefined ? CONSERVATIVE_DEV_PACING : overrides.pacing;
  if (pacing !== null) {
    await client.query(
      `INSERT INTO pacing_thresholds (twin_id, max_sends_per_hour, min_seconds_between_sends)
       VALUES ($1, $2, $3)`,
      [twinId, pacing.maxSendsPerHour, pacing.minSecondsBetweenSends],
    );
  }
  return {
    twinId,
    companyId,
    seatId,
    destination,
    draftId: draftRes.rows[0].id,
    affirmationEventId,
  };
}

async function insertWaEvent(
  client: pg.ClientBase,
  ids: { twinId: string; companyId: string; seatId: string },
): Promise<string> {
  const res = await client.query(
    `INSERT INTO wa_events
       (source, external_event_id, event_type, company_id, seat_id, twin_id, occurred_at, payload_enc)
     VALUES ('whatsapp', $1, 'message', $2, $3, $4, now(), $5)
     RETURNING id`,
    [randomUUID(), ids.companyId, ids.seatId, ids.twinId, Buffer.from("opaque")],
  );
  return String(res.rows[0].id);
}

async function commandRowsFor(twinId: string) {
  return withClient(async (c) =>
    (
      await c.query(
        `SELECT id, send_class, destination, payload_ref, tap_id, draft_id, twin_id, outcome
           FROM send_commands WHERE twin_id = $1`,
        [twinId],
      )
    ).rows,
  );
}

async function tapRowsFor(draftId: string) {
  return withClient(async (c) =>
    (
      await c.query(
        "SELECT id, draft_id, minter, source_event_id FROM taps WHERE draft_id = $1",
        [draftId],
      )
    ).rows,
  );
}

describe("ADR-0006's SECOND MINTER, on the same writer (ticket #224)", () => {
  /**
   * THE DASHBOARD'S WRITER: the same logic, with the two things that differ.
   * It runs on the same pool and records a refusal as a ROW instead of a
   * chain entry, because rep-web holds no chain key (ADR-0002, ADR-0008) —
   * `deferRefusal` is `@dito/seam`'s own recorder for exactly that, and the
   * runtime's `drainSendRefusals` chains what it leaves.
   */
  let dashboard: SendLockWriter;

  beforeAll(() => {
    dashboard = createSeamSendLockWriter({
      sessions: pool,
      recordRefusal: deferRefusal,
    });
  });

  it("writes the tap and its command together, with no source event at all", async () => {
    const f = await withClient((c) => mintFixture(c));
    const result = await dashboard.requestCustomerSend({
      minter: "rep_web",
      draftId: f.draftId,
    });
    expect(result.outcome).toBe("written");
    // THE MINTER IS THE STORE'S OWN WORD, and the tap carries NO seam event:
    // the rep pressed a button, and `taps_matcher_requires_event_check`
    // permits exactly this minter to carry none.
    expect(await tapRowsFor(f.draftId)).toEqual([
      {
        id: result.outcome === "written" ? result.tapId : null,
        draft_id: f.draftId,
        minter: "rep_web",
        source_event_id: null,
      },
    ]);
    // ...and the command is the plane executor's, indistinguishable from the
    // thread's: a command is a command (ADR-0006).
    const commands = await commandRowsFor(f.twinId);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      send_class: "customer_send",
      destination: f.destination,
      payload_ref: `draft:${f.draftId}`,
      draft_id: f.draftId,
      twin_id: f.twinId,
      outcome: null,
    });
  });

  it("refuses the second Enviar on the constraint that IS the cross-surface lock", async () => {
    const f = await withClient((c) => mintFixture(c));
    const first = await dashboard.requestCustomerSend({
      minter: "rep_web",
      draftId: f.draftId,
    });
    expect(first.outcome).toBe("written");
    const second = await dashboard.requestCustomerSend({
      minter: "rep_web",
      draftId: f.draftId,
    });
    expect(second).toEqual({ outcome: "refused", reason: "already_tapped" });
    // ONE TAP AND ONE COMMAND, whatever a rep pressed twice — the same
    // guarantee the thread's late «va» meets, off the same UNIQUE(draft_id).
    expect(await tapRowsFor(f.draftId)).toHaveLength(1);
    expect(await commandRowsFor(f.twinId)).toHaveLength(1);
  });

  it("refuses a thread tap on a draft the DASHBOARD already sent, and the reverse", async () => {
    // THE LOCK IS CROSS-SURFACE OR IT IS NOTHING. One `taps` table and one
    // UNIQUE(draft_id) is ADR-0006's whole design, and this is the claim from
    // both directions: whichever minter got there first, the other is the late
    // loser and reads «ya se envió».
    const byCard = await withClient((c) => mintFixture(c));
    expect(
      (
        await dashboard.requestCustomerSend({
          minter: "rep_web",
          draftId: byCard.draftId,
        })
      ).outcome,
    ).toBe("written");
    expect(
      await writer.requestCustomerSend({
        minter: "affirmation_matcher",
        draftId: byCard.draftId,
        sourceEventId: byCard.affirmationEventId,
      }),
    ).toEqual({ outcome: "refused", reason: "already_tapped" });

    const byThread = await withClient((c) => mintFixture(c));
    expect(
      (
        await writer.requestCustomerSend({
          minter: "affirmation_matcher",
          draftId: byThread.draftId,
          sourceEventId: byThread.affirmationEventId,
        })
      ).outcome,
    ).toBe("written");
    expect(
      await dashboard.requestCustomerSend({
        minter: "rep_web",
        draftId: byThread.draftId,
      }),
    ).toEqual({ outcome: "refused", reason: "already_tapped" });
  });

  it("refuses a dashboard send of a dismissed draft, and records it as a ROW", async () => {
    // THE AC's OWN CASE: a tap on a dismissed draft is refused as
    // `refused:dismissed`. The dashboard cannot chain that itself, so the row
    // is the record and the entry is owed — `deferRefusal` and
    // …20260908100060's section 2 argue the trade in full.
    const f = await withClient((c) => mintFixture(c));
    await withClient((c) =>
      c.query(
        `INSERT INTO draft_dismissals (draft_id, source_event_id)
         VALUES ($1, $2)`,
        [f.draftId, f.affirmationEventId],
      ),
    );
    const refused = await dashboard.requestCustomerSend({
      minter: "rep_web",
      draftId: f.draftId,
    });
    expect(refused).toEqual({ outcome: "refused", reason: "dismissed" });
    // NOTHING BUT THE RECORD PERSISTS: the attempt rolled back to its
    // savepoint, so there is no tap and no command.
    expect(await tapRowsFor(f.draftId)).toEqual([]);
    expect(await commandRowsFor(f.twinId)).toEqual([]);
    const rows = await withClient((c) =>
      c.query<{
        twin_id: string;
        draft_id: string;
        minter: string;
        reason: string;
        chained_at: Date | null;
      }>(
        "SELECT twin_id, draft_id, minter, reason, chained_at FROM send_refusals WHERE draft_id = $1",
        [f.draftId],
      ),
    );
    expect(rows.rows).toEqual([
      {
        twin_id: f.twinId,
        draft_id: f.draftId,
        minter: "rep_web",
        reason: "dismissed",
        chained_at: null,
      },
    ]);
  });

  it("chains what the dashboard could not, at the runtime's next pass", async () => {
    // THE DRAIN. The row is the record; the entry is the lease holder's, and
    // it says exactly what the writer would have said — caller, action, opaque
    // refs, outcome (ADR-0020).
    const before = await auditRows();
    const drained = await withClient((c) => drainSendRefusals(c, hmacKey));
    expect(drained.stopped).toBe(false);
    expect(drained.chained).toBeGreaterThanOrEqual(1);
    const after = await auditRows();
    const added = after.slice(before.length);
    const byDashboard = added.filter((row) => row.caller === "rep_web");
    expect(
      byDashboard.map((row) => ({
        caller: row.caller,
        action: row.action,
        outcome: row.outcome,
      })),
    ).toContainEqual({
      caller: "rep_web",
      action: "customer_send",
      outcome: "refused:dismissed",
    });
    // ...AND THE REFERENCE IS THE ONE THE WRITER WOULD HAVE WRITTEN: opaque
    // ids only, never a JID and never content (ADR-0020). A reader of the
    // chain cannot tell which minter was holding a key.
    for (const row of byDashboard) {
      expect(row.ref).toMatch(/^twin:[0-9a-f-]+ draft:[0-9a-f-]+$/u);
    }
    // IDEMPOTENT ON THE ROW: a second pass finds nothing, because the first
    // stamped `chained_at` in the same transaction as the append.
    const again = await withClient((c) => drainSendRefusals(c, hmacKey));
    expect(again).toEqual({ chained: 0, stopped: false });
  });

  it("refuses an off-allowlist dashboard send, and records that too", async () => {
    const f = await withClient((c) => mintFixture(c, { allowlisted: false }));
    expect(
      await dashboard.requestCustomerSend({
        minter: "rep_web",
        draftId: f.draftId,
      }),
    ).toEqual({ outcome: "refused", reason: "off_allowlist" });
    const rows = await withClient((c) =>
      c.query<{ reason: string }>(
        "SELECT reason FROM send_refusals WHERE draft_id = $1",
        [f.draftId],
      ),
    );
    expect(rows.rows).toEqual([{ reason: "off_allowlist" }]);
  });

  it("refuses a draft that does not exist, without recording anything", async () => {
    // NO ROW AND NO ENTRY, on either surface: the writer refuses before it has
    // a twin to name, so there is nothing content-free to write down.
    expect(
      await dashboard.requestCustomerSend({
        minter: "rep_web",
        draftId: randomUUID(),
      }),
    ).toEqual({ outcome: "refused", reason: "no_valid_tap" });
  });
});

describe("writer construction (ADR-0020 custody, fail-closed)", () => {
  it("refuses a weak HMAC key at construction, not at the first refusal", () => {
    expect(() =>
      createSendLockWriter({ pool, hmacKey: randomBytes(8) }),
    ).toThrow(/32 bytes/);
  });
});

describe("customer_send with a valid tap basis (ADR-0006)", () => {
  it("writes the tap and its command together; the command carries the draft's own destination", async () => {
    const fx = await withClient((c) => mintFixture(c));

    const result = await writer.requestCustomerSend({
      minter: "affirmation_matcher",
      draftId: fx.draftId,
      sourceEventId: fx.affirmationEventId,
    });

    expect(result.outcome).toBe("written");
    if (result.outcome !== "written") return;

    const taps = await tapRowsFor(fx.draftId);
    expect(taps.length).toBe(1);
    expect(taps[0].id).toBe(result.tapId);
    expect(taps[0].minter).toBe("affirmation_matcher");
    expect(String(taps[0].source_event_id)).toBe(fx.affirmationEventId);

    const commands = await commandRowsFor(fx.twinId);
    expect(commands.length).toBe(1);
    expect(commands[0].id).toBe(result.commandId);
    expect(commands[0].send_class).toBe("customer_send");
    expect(commands[0].destination).toBe(fx.destination);
    expect(commands[0].payload_ref).toBe(`draft:${fx.draftId}`);
    expect(commands[0].tap_id).toBe(result.tapId);
    expect(commands[0].draft_id).toBe(fx.draftId);
    expect(commands[0].outcome).toBeNull();
  });
});

describe("customer_send without a valid tap (ADR-0006)", () => {
  it("refuses a draft that does not exist — no tap, no command row", async () => {
    const ghostDraftId = randomUUID();
    const fx = await withClient((c) => mintFixture(c));

    const result = await writer.requestCustomerSend({
      minter: "affirmation_matcher",
      draftId: ghostDraftId,
      sourceEventId: fx.affirmationEventId,
    });

    expect(result).toEqual({ outcome: "refused", reason: "no_valid_tap" });
    expect(await tapRowsFor(ghostDraftId)).toEqual([]);
    const commands = await withClient(async (c) =>
      (await c.query("SELECT id FROM send_commands WHERE draft_id = $1", [ghostDraftId]))
        .rows,
    );
    expect(commands).toEqual([]);
  });

  it("refuses an affirmation whose source event does not exist — no tap, no command row", async () => {
    const fx = await withClient((c) => mintFixture(c));

    const result = await writer.requestCustomerSend({
      minter: "affirmation_matcher",
      draftId: fx.draftId,
      sourceEventId: "999999999",
    });

    expect(result).toEqual({ outcome: "refused", reason: "no_valid_tap" });
    expect(await tapRowsFor(fx.draftId)).toEqual([]);
    expect(await commandRowsFor(fx.twinId)).toEqual([]);
  });

  it("accepts an uppercase draft id and still writes the canonical payload_ref", async () => {
    const fx = await withClient((c) => mintFixture(c));

    const result = await writer.requestCustomerSend({
      minter: "affirmation_matcher",
      draftId: fx.draftId.toUpperCase(),
      sourceEventId: fx.affirmationEventId,
    });

    expect(result.outcome).toBe("written");
    const commands = await commandRowsFor(fx.twinId);
    expect(commands.length).toBe(1);
    expect(commands[0].payload_ref).toBe(`draft:${fx.draftId}`);
    // The canonical ref keeps FR-70 clean over this corpus.
    const report = await withClient((c) => reconcileFr70(c));
    expect(report.violations).toEqual([]);
  });

  it("refuses malformed references — never an internal error", async () => {
    const fx = await withClient((c) => mintFixture(c));

    const badDraft = await writer.requestCustomerSend({
      minter: "affirmation_matcher",
      draftId: "not-a-uuid",
      sourceEventId: fx.affirmationEventId,
    });
    expect(badDraft).toEqual({ outcome: "refused", reason: "no_valid_tap" });

    const badEvent = await writer.requestCustomerSend({
      minter: "affirmation_matcher",
      draftId: fx.draftId,
      sourceEventId: "'; DROP TABLE taps; --",
    });
    expect(badEvent).toEqual({ outcome: "refused", reason: "no_valid_tap" });

    expect(await tapRowsFor(fx.draftId)).toEqual([]);
    expect(await commandRowsFor(fx.twinId)).toEqual([]);
  });

  it("refuses an affirmation event belonging to a different twin than the draft", async () => {
    const fx = await withClient((c) => mintFixture(c));
    const other = await withClient((c) => mintFixture(c));

    const result = await writer.requestCustomerSend({
      minter: "affirmation_matcher",
      draftId: fx.draftId,
      sourceEventId: other.affirmationEventId,
    });

    expect(result).toEqual({ outcome: "refused", reason: "no_valid_tap" });
    expect(await tapRowsFor(fx.draftId)).toEqual([]);
    expect(await commandRowsFor(fx.twinId)).toEqual([]);
  });
});

describe("the single-use lock: UNIQUE(draft_id) (ADR-0006)", () => {
  it("refuses the second «va» on an already-tapped draft — ya se envió, one command only", async () => {
    const fx = await withClient((c) => mintFixture(c));
    const first = await writer.requestCustomerSend({
      minter: "affirmation_matcher",
      draftId: fx.draftId,
      sourceEventId: fx.affirmationEventId,
    });
    expect(first.outcome).toBe("written");

    const secondAffirmation = await withClient((c) =>
      insertWaEvent(c, { twinId: fx.twinId, companyId: fx.companyId, seatId: fx.seatId }),
    );
    const second = await writer.requestCustomerSend({
      minter: "affirmation_matcher",
      draftId: fx.draftId,
      sourceEventId: secondAffirmation,
    });

    expect(second).toEqual({ outcome: "refused", reason: "already_tapped" });
    expect((await tapRowsFor(fx.draftId)).length).toBe(1);
    expect((await commandRowsFor(fx.twinId)).length).toBe(1);
  });

  it("resolves a concurrent double affirmation to exactly one send", async () => {
    const fx = await withClient((c) => mintFixture(c));
    const secondAffirmation = await withClient((c) =>
      insertWaEvent(c, { twinId: fx.twinId, companyId: fx.companyId, seatId: fx.seatId }),
    );

    const [a, b] = await Promise.all([
      writer.requestCustomerSend({
        minter: "affirmation_matcher",
        draftId: fx.draftId,
        sourceEventId: fx.affirmationEventId,
      }),
      writer.requestCustomerSend({
        minter: "affirmation_matcher",
        draftId: fx.draftId,
        sourceEventId: secondAffirmation,
      }),
    ]);

    const outcomes = [a.outcome, b.outcome].sort();
    expect(outcomes).toEqual(["refused", "written"]);
    expect((await tapRowsFor(fx.draftId)).length).toBe(1);
    expect((await commandRowsFor(fx.twinId)).length).toBe(1);
  });
});

describe("a tap authorizes exactly its draft's content (ADR-0006)", () => {
  it("drafts are immutable in the store: post-tap mutation of content or destination is refused", async () => {
    const fx = await withClient((c) => mintFixture(c));
    const result = await writer.requestCustomerSend({
      minter: "affirmation_matcher",
      draftId: fx.draftId,
      sourceEventId: fx.affirmationEventId,
    });
    expect(result.outcome).toBe("written");

    // «va» affirmed one specific message; nothing may swap the payload
    // between the tap and the executor's dereference.
    await expect(
      withClient((c) =>
        c.query("UPDATE drafts SET content_enc = $1 WHERE id = $2", [
          Buffer.from("swapped-payload"),
          fx.draftId,
        ]),
      ),
    ).rejects.toThrow(/immutable/);
    await expect(
      withClient((c) =>
        c.query("UPDATE drafts SET destination = $1 WHERE id = $2", [
          "5219999999999@s.whatsapp.net",
          fx.draftId,
        ]),
      ),
    ).rejects.toThrow(/immutable/);
    await expect(
      withClient((c) =>
        c.query("DELETE FROM drafts WHERE id = $1", [fx.draftId]),
      ),
    ).rejects.toThrow(/immutable/);
  });

  it("a validated command cannot be rewritten: only outcome finalization is allowed", async () => {
    const fx = await withClient((c) => mintFixture(c));
    const result = await writer.requestCustomerSend({
      minter: "affirmation_matcher",
      draftId: fx.draftId,
      sourceEventId: fx.affirmationEventId,
    });
    expect(result.outcome).toBe("written");
    if (result.outcome !== "written") return;
    const commandId = result.commandId;

    // The decision the writer validated is frozen: destination, payload,
    // identity, and the pacing clock can never change afterwards.
    for (const [column, value] of [
      ["destination", "5219999999999@s.whatsapp.net"],
      ["payload_ref", `draft:${randomUUID()}`],
      ["twin_id", randomUUID()],
      ["created_at", new Date(Date.now() - 2 * 3600 * 1000)],
    ] as const) {
      await expect(
        withClient((c) =>
          c.query(`UPDATE send_commands SET ${column} = $1 WHERE id = $2`, [
            value,
            commandId,
          ]),
        ),
      ).rejects.toThrow(/outcome/);
    }
    await expect(
      withClient((c) =>
        c.query("DELETE FROM send_commands WHERE id = $1", [commandId]),
      ),
    ).rejects.toThrow(/outcome|refused/);

    // The executor's one legal write: finalizing the outcome, once.
    await withClient((c) =>
      c.query(
        "UPDATE send_commands SET outcome = 'sent', executed_at = now() WHERE id = $1",
        [commandId],
      ),
    );
    // Outcomes are final — never silent, never rewritten (ADR-0006).
    await expect(
      withClient((c) =>
        c.query("UPDATE send_commands SET outcome = 'failed' WHERE id = $1", [
          commandId,
        ]),
      ),
    ).rejects.toThrow(/final/);
  });

  it("outcome and executed_at finalize together — a one-sided write is refused", async () => {
    const fx = await withClient((c) => mintFixture(c));
    const result = await writer.requestCustomerSend({
      minter: "affirmation_matcher",
      draftId: fx.draftId,
      sourceEventId: fx.affirmationEventId,
    });
    expect(result.outcome).toBe("written");
    if (result.outcome !== "written") return;

    await expect(
      withClient((c) =>
        c.query("UPDATE send_commands SET outcome = 'sent' WHERE id = $1", [
          result.commandId,
        ]),
      ),
    ).rejects.toThrow(/paired/);
    await expect(
      withClient((c) =>
        c.query("UPDATE send_commands SET executed_at = now() WHERE id = $1", [
          result.commandId,
        ]),
      ),
    ).rejects.toThrow(/paired/);
    // The INSERT side of the same invariant.
    await expect(
      withClient((c) =>
        c.query(
          `INSERT INTO send_commands (twin_id, send_class, destination, payload_ref, executed_at)
           VALUES ($1, 'system_send', $2, 'draft:none', now())`,
          [fx.twinId, fx.destination],
        ),
      ),
    ).rejects.toThrow(/paired/);
  });

  it("taps are immutable: a minted tap can never be retargeted or removed", async () => {
    const fx = await withClient((c) => mintFixture(c));
    const result = await writer.requestCustomerSend({
      minter: "affirmation_matcher",
      draftId: fx.draftId,
      sourceEventId: fx.affirmationEventId,
    });
    expect(result.outcome).toBe("written");
    if (result.outcome !== "written") return;

    const otherEvent = await withClient((c) =>
      insertWaEvent(c, { twinId: fx.twinId, companyId: fx.companyId, seatId: fx.seatId }),
    );
    await expect(
      withClient((c) =>
        c.query("UPDATE taps SET source_event_id = $1 WHERE id = $2", [
          otherEvent,
          result.tapId,
        ]),
      ),
    ).rejects.toThrow(/immutable/);
    await expect(
      withClient((c) =>
        c.query("DELETE FROM taps WHERE id = $1", [result.tapId]),
      ),
    ).rejects.toThrow(/immutable/);
  });
});

async function auditRows() {
  return withClient(async (c) =>
    (
      await c.query(
        "SELECT caller, action, ref, outcome FROM audit_chain ORDER BY id",
      )
    ).rows,
  );
}

describe("the hard send-allowlist (slice AC 7, ADR-0017/0020)", () => {
  it("refuses an off-allowlist destination: no tap, no command, one content-free audit entry", async () => {
    const fx = await withClient((c) => mintFixture(c, { allowlisted: false }));
    const before = (await auditRows()).length;

    const result = await writer.requestCustomerSend({
      minter: "affirmation_matcher",
      draftId: fx.draftId,
      sourceEventId: fx.affirmationEventId,
    });

    expect(result).toEqual({ outcome: "refused", reason: "off_allowlist" });
    // One transaction (ADR-0006): the tap minted mid-attempt rolled back
    // with the command — only the refusal's audit entry committed.
    expect(await tapRowsFor(fx.draftId)).toEqual([]);
    expect(await commandRowsFor(fx.twinId)).toEqual([]);

    const entries = await auditRows();
    expect(entries.length).toBe(before + 1);
    const entry = entries[entries.length - 1];
    expect(entry).toEqual({
      caller: "affirmation_matcher",
      action: "customer_send",
      ref: `twin:${fx.twinId} draft:${fx.draftId}`,
      outcome: "refused:off_allowlist",
    });
    // Content-free (ADR-0020): no field carries the destination JID or any
    // draft content — opaque ids only.
    for (const value of Object.values(entry)) {
      expect(String(value)).not.toContain(fx.destination);
      expect(String(value)).not.toContain("@s.whatsapp.net");
    }
  });
});

describe("the dismissed draft (ticket #30; spec #29 grilling decision 1)", () => {
  it("refuses a «va» on a dismissed draft: no tap, no command, the audit-chained 'dismissed' refusal — a dead draft can never quietly come back to life and send", async () => {
    const fx = await withClient((c) => mintFixture(c));
    // The terminal dismissal, as the matcher mints it from the raw
    // plane-delivered «no va» event.
    const dismissalEventId = await withClient((c) => insertWaEvent(c, fx));
    await withClient((c) =>
      c.query(
        "INSERT INTO draft_dismissals (draft_id, source_event_id) VALUES ($1, $2)",
        [fx.draftId, dismissalEventId],
      ),
    );
    const before = (await auditRows()).length;

    const result = await writer.requestCustomerSend({
      minter: "affirmation_matcher",
      draftId: fx.draftId,
      sourceEventId: fx.affirmationEventId,
    });

    expect(result).toEqual({ outcome: "refused", reason: "dismissed" });
    expect(await tapRowsFor(fx.draftId)).toEqual([]);
    expect(await commandRowsFor(fx.twinId)).toEqual([]);

    const entries = await auditRows();
    expect(entries.length).toBe(before + 1);
    expect(entries[entries.length - 1]).toEqual({
      caller: "affirmation_matcher",
      action: "customer_send",
      ref: `twin:${fx.twinId} draft:${fx.draftId}`,
      outcome: "refused:dismissed",
    });
  });

  it("a dismissal is terminal by construction: the record can never be retargeted or removed", async () => {
    const fx = await withClient((c) => mintFixture(c));
    const dismissalEventId = await withClient((c) => insertWaEvent(c, fx));
    await withClient((c) =>
      c.query(
        "INSERT INTO draft_dismissals (draft_id, source_event_id) VALUES ($1, $2)",
        [fx.draftId, dismissalEventId],
      ),
    );

    const otherEvent = await withClient((c) => insertWaEvent(c, fx));
    await expect(
      withClient((c) =>
        c.query(
          "UPDATE draft_dismissals SET source_event_id = $1 WHERE draft_id = $2",
          [otherEvent, fx.draftId],
        ),
      ),
    ).rejects.toThrow(/immutable/);
    await expect(
      withClient((c) =>
        c.query("DELETE FROM draft_dismissals WHERE draft_id = $1", [
          fx.draftId,
        ]),
      ),
    ).rejects.toThrow(/immutable/);
  });
});

describe("a draft with a blank still open (ticket #342)", () => {
  /** The dashboard's writer: the same lock, a refusal recorded as a row. */
  const dashboard = (): SendLockWriter =>
    createSeamSendLockWriter({ sessions: pool, recordRefusal: deferRefusal });

  /** The fixture's draft, with one blank left open in it. */
  async function withBlank(): Promise<Fixture> {
    const fx = await withClient((c) => mintFixture(c));
    await withClient((c) =>
      c.query("INSERT INTO draft_blanks (draft_id, key) VALUES ($1, 'b1')", [fx.draftId]),
    );
    return fx;
  }

  it("refuses the thread's «va» on it, chained as `blank_open`, with no tap and no command", async () => {
    const fx = await withBlank();
    const before = (await auditRows()).length;
    expect(
      await writer.requestCustomerSend({
        minter: "affirmation_matcher",
        draftId: fx.draftId,
        sourceEventId: fx.affirmationEventId,
      }),
    ).toEqual({ outcome: "refused", reason: "blank_open" });
    expect(await tapRowsFor(fx.draftId)).toEqual([]);
    expect(await commandRowsFor(fx.twinId)).toEqual([]);
    const entries = await auditRows();
    expect(entries.length).toBe(before + 1);
    expect(entries.at(-1)).toEqual({
      caller: "affirmation_matcher",
      action: "customer_send",
      ref: `twin:${fx.twinId} draft:${fx.draftId}`,
      outcome: "refused:blank_open",
    });
  });

  it("refuses the dashboard's Enviar on it, recorded as a row", async () => {
    const fx = await withBlank();
    expect(await dashboard().requestCustomerSend({ minter: "rep_web", draftId: fx.draftId })).toEqual({
      outcome: "refused",
      reason: "blank_open",
    });
    expect(await tapRowsFor(fx.draftId)).toEqual([]);
    const rows = await withClient((c) =>
      c.query<{ minter: string; reason: string }>(
        "SELECT minter, reason FROM send_refusals WHERE draft_id = $1",
        [fx.draftId],
      ),
    );
    expect(rows.rows).toEqual([{ minter: "rep_web", reason: "blank_open" }]);
  });

  it("writes the draft that filled it, while the draft with the blank stays refused", async () => {
    const fx = await withBlank();
    const filled = await withClient((c) => mintFollowUpDraft(c, fx));
    const sent = await dashboard().requestCustomerSend({ minter: "rep_web", draftId: filled.draftId });
    expect(sent.outcome).toBe("written");
    expect(await dashboard().requestCustomerSend({ minter: "rep_web", draftId: fx.draftId })).toEqual({
      outcome: "refused",
      reason: "blank_open",
    });
  });

  it("keeps a draft's blanks for good: the rows can never be removed or rewritten", async () => {
    const fx = await withBlank();
    await expect(
      withClient((c) => c.query("DELETE FROM draft_blanks WHERE draft_id = $1", [fx.draftId])),
    ).rejects.toThrow(/immutable/);
    await expect(
      withClient((c) => c.query("UPDATE draft_blanks SET key = 'b2' WHERE draft_id = $1", [fx.draftId])),
    ).rejects.toThrow(/immutable/);
  });
});

/** Mints a second draft + affirmation event for an existing fixture twin. */
async function mintFollowUpDraft(
  client: pg.ClientBase,
  fx: Fixture,
): Promise<{ draftId: string; affirmationEventId: string }> {
  const inboundId = await insertWaEvent(client, fx);
  const draftRes = await client.query(
    `INSERT INTO drafts (twin_id, in_reply_to_event_id, destination, content_enc)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [fx.twinId, inboundId, fx.destination, Buffer.from("opaque-follow-up")],
  );
  return {
    draftId: draftRes.rows[0].id,
    affirmationEventId: await insertWaEvent(client, fx),
  };
}

describe("pacing at the writer (slice AC 8, ADR-0017)", () => {
  it("paces against prior customer sends only: the twin's own just-posted system_send never blocks the affirmation that answers it", async () => {
    // Integration adjudication on #25: the consumer posts the draft to the
    // twin thread as a system_send moments before the rep's «va» arrives.
    // Pacing governs what the writer writes — customer-facing sends, the
    // enforcement-risk surface ADR-0017 watches; twin-thread posts are the
    // product's own surface. Counting them would make every affirmation
    // inside the min gap of its own draft post mechanically refusable —
    // the magic loop could never close at rig pacing.
    const fx = await withClient((c) => mintFixture(c));
    await withClient((c) =>
      c.query(
        `INSERT INTO send_commands (twin_id, send_class, destination, payload_ref, draft_id)
         VALUES ($1, 'system_send', $2, $3, $4)`,
        [fx.twinId, "5215550000@s.whatsapp.net", `draft:${fx.draftId}`, fx.draftId],
      ),
    );

    const result = await writer.requestCustomerSend({
      minter: "affirmation_matcher",
      draftId: fx.draftId,
      sourceEventId: fx.affirmationEventId,
    });

    expect(result.outcome).toBe("written");
  });

  it("at most one outstanding customer_send per twin: a backlog cannot pile up behind a down plane and drain back-to-back (Codex round 1)", async () => {
    // Pacing measures command creation time, so commands accepted while
    // the plane is down would execute back-to-back on recovery. The rule
    // that closes it is domain logic at the writer (ADR-0017): while a
    // customer_send is pending (no outcome), the next mint refuses —
    // audit-chained, «hay un envío en camino».
    const fx = await withClient((c) =>
      mintFixture(c, { pacing: { maxSendsPerHour: 30, minSecondsBetweenSends: 0 } }),
    );
    const first = await writer.requestCustomerSend({
      minter: "affirmation_matcher",
      draftId: fx.draftId,
      sourceEventId: fx.affirmationEventId,
    });
    expect(first.outcome).toBe("written");

    const followUp = await withClient((c) => mintFollowUpDraft(c, fx));
    const second = await writer.requestCustomerSend({
      minter: "affirmation_matcher",
      draftId: followUp.draftId,
      sourceEventId: followUp.affirmationEventId,
    });
    expect(second).toEqual({ outcome: "refused", reason: "send_in_flight" });
    expect(await tapRowsFor(followUp.draftId)).toEqual([]);

    const entries = await auditRows();
    expect(entries[entries.length - 1]).toEqual({
      caller: "affirmation_matcher",
      action: "customer_send",
      ref: `twin:${fx.twinId} draft:${followUp.draftId}`,
      outcome: "refused:send_in_flight",
    });

    // The executor finalizes the outstanding send — the lane is free.
    await withClient((c) =>
      c.query(
        "UPDATE send_commands SET outcome = 'sent', executed_at = now() WHERE twin_id = $1 AND send_class = 'customer_send' AND outcome IS NULL",
        [fx.twinId],
      ),
    );
    const third = await writer.requestCustomerSend({
      minter: "affirmation_matcher",
      draftId: followUp.draftId,
      sourceEventId: followUp.affirmationEventId,
    });
    expect(third.outcome).toBe("written");
  });

  it("pacing measures the wire, not the mint: a command created long ago but executed seconds ago still holds the gap (Codex round 2)", async () => {
    // The outage shape: a command minted before a plane outage executes
    // the moment the plane recovers — its created_at has aged past any
    // gap, but its ATTEMPT just touched the rail. The next tap must wait
    // out the gap from the attempt, or two sends reach the rail
    // seconds apart.
    const fx = await withClient((c) => mintFixture(c));
    // The recovered customer send, planted whole: tapped, minted two
    // hours ago, executed by the plane seconds ago (attempt + sent).
    await withClient(async (c) => {
      const tapRes = await c.query(
        "INSERT INTO taps (draft_id, minter, source_event_id) VALUES ($1, 'affirmation_matcher', $2) RETURNING id",
        [fx.draftId, fx.affirmationEventId],
      );
      const cmdRes = await c.query(
        `INSERT INTO send_commands (twin_id, send_class, destination, payload_ref, tap_id, draft_id, created_at, outcome, executed_at)
         VALUES ($1, 'customer_send', $2, $3, $4, $5, now() - interval '2 hours', 'sent', now())
         RETURNING id`,
        [fx.twinId, fx.destination, `draft:${fx.draftId}`, tapRes.rows[0].id, fx.draftId],
      );
      await c.query(
        "INSERT INTO send_attempts (command_id, attempted_at) VALUES ($1, now())",
        [cmdRes.rows[0].id],
      );
    });

    const followUp = await withClient((c) => mintFollowUpDraft(c, fx));
    const result = await writer.requestCustomerSend({
      minter: "affirmation_matcher",
      draftId: followUp.draftId,
      sourceEventId: followUp.affirmationEventId,
    });
    expect(result).toEqual({ outcome: "refused", reason: "pacing" });
  });

  it("a send that clears conservative config is refused after the config tightens; the refusal is audit-chained", async () => {
    const fx = await withClient((c) => mintFixture(c));
    const first = await writer.requestCustomerSend({
      minter: "affirmation_matcher",
      draftId: fx.draftId,
      sourceEventId: fx.affirmationEventId,
    });
    expect(first.outcome).toBe("written");

    // Tighten the config: no two sends may be closer than an hour apart.
    await withClient((c) =>
      c.query(
        "UPDATE pacing_thresholds SET min_seconds_between_sends = 3600 WHERE twin_id = $1",
        [fx.twinId],
      ),
    );
    const followUp = await withClient((c) => mintFollowUpDraft(c, fx));

    const second = await writer.requestCustomerSend({
      minter: "affirmation_matcher",
      draftId: followUp.draftId,
      sourceEventId: followUp.affirmationEventId,
    });

    expect(second).toEqual({ outcome: "refused", reason: "pacing" });
    expect(await tapRowsFor(followUp.draftId)).toEqual([]);
    expect((await commandRowsFor(fx.twinId)).length).toBe(1);

    const entries = await auditRows();
    expect(entries[entries.length - 1]).toEqual({
      caller: "affirmation_matcher",
      action: "customer_send",
      ref: `twin:${fx.twinId} draft:${followUp.draftId}`,
      outcome: "refused:pacing",
    });
  });

  it("refuses at the hourly cap; a send outside the window does not count", async () => {
    const fx = await withClient((c) =>
      mintFixture(c, { pacing: { maxSendsPerHour: 1, minSecondsBetweenSends: 0 } }),
    );
    // Two hours of history planted as a fixture (rows are frozen after
    // insert, so history is minted, never rewritten): an old outbound that
    // must NOT count against the rolling hour.
    await withClient((c) =>
      c.query(
        `INSERT INTO send_commands (twin_id, send_class, destination, payload_ref, created_at)
         VALUES ($1, 'system_send', $2, 'draft:none', now() - interval '2 hours')`,
        [fx.twinId, fx.destination],
      ),
    );

    const first = await writer.requestCustomerSend({
      minter: "affirmation_matcher",
      draftId: fx.draftId,
      sourceEventId: fx.affirmationEventId,
    });
    expect(first.outcome).toBe("written");

    const followUp = await withClient((c) => mintFollowUpDraft(c, fx));
    const atCap = await writer.requestCustomerSend({
      minter: "affirmation_matcher",
      draftId: followUp.draftId,
      sourceEventId: followUp.affirmationEventId,
    });
    expect(atCap).toEqual({ outcome: "refused", reason: "pacing" });
  });

  it("fails closed: a twin with no pacing config cannot send, and the refusal is audit-chained", async () => {
    const fx = await withClient((c) => mintFixture(c, { pacing: null }));

    const result = await writer.requestCustomerSend({
      minter: "affirmation_matcher",
      draftId: fx.draftId,
      sourceEventId: fx.affirmationEventId,
    });

    expect(result).toEqual({ outcome: "refused", reason: "pacing_unconfigured" });
    expect(await tapRowsFor(fx.draftId)).toEqual([]);
    expect(await commandRowsFor(fx.twinId)).toEqual([]);
    const entries = await auditRows();
    expect(entries[entries.length - 1]).toEqual({
      caller: "affirmation_matcher",
      action: "customer_send",
      ref: `twin:${fx.twinId} draft:${fx.draftId}`,
      outcome: "refused:pacing_unconfigured",
    });
  });

  it("a lock-delayed send cannot backdate itself under the pacing gap", async () => {
    const fx = await withClient((c) =>
      mintFixture(c, { pacing: { maxSendsPerHour: 30, minSecondsBetweenSends: 2 } }),
    );
    const followUp = await withClient((c) => mintFollowUpDraft(c, fx));

    // A holder pins the twin's advisory lock for longer than the configured
    // gap, so the send's transaction start predates the lock wait.
    const holder = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await holder.connect();
    await holder.query("BEGIN");
    await holder.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('dito:send_lock:twin:' || $1::text, 0))",
      [fx.twinId],
    );
    const pending = writer.requestCustomerSend({
      minter: "affirmation_matcher",
      draftId: fx.draftId,
      sourceEventId: fx.affirmationEventId,
    });
    await new Promise((resolve) => setTimeout(resolve, 3000));
    await holder.query("COMMIT");
    await holder.end();

    const delayed = await pending;
    expect(delayed.outcome).toBe("written");

    // The delayed command must carry its decision time, not its transaction
    // start — otherwise this immediate follow-up sees it as already old and
    // two sends leave one second apart on the wire.
    const immediate = await writer.requestCustomerSend({
      minter: "affirmation_matcher",
      draftId: followUp.draftId,
      sourceEventId: followUp.affirmationEventId,
    });
    expect(immediate).toEqual({ outcome: "refused", reason: "pacing" });
  });

  it("two concurrent sends for one twin cannot both slip under the cap", async () => {
    const fx = await withClient((c) =>
      mintFixture(c, { pacing: { maxSendsPerHour: 1, minSecondsBetweenSends: 0 } }),
    );
    const followUp = await withClient((c) => mintFollowUpDraft(c, fx));

    const [a, b] = await Promise.all([
      writer.requestCustomerSend({
        minter: "affirmation_matcher",
        draftId: fx.draftId,
        sourceEventId: fx.affirmationEventId,
      }),
      writer.requestCustomerSend({
        minter: "affirmation_matcher",
        draftId: followUp.draftId,
        sourceEventId: followUp.affirmationEventId,
      }),
    ]);

    expect([a.outcome, b.outcome].sort()).toEqual(["refused", "written"]);
    expect((await commandRowsFor(fx.twinId)).length).toBe(1);
  });
});

/**
 * ONE DECISION AT A TIME PER TWIN, ACROSS THE TWO ACTS THAT UNDO EACH OTHER
 * (ticket #224; Codex r1, a reachable failure).
 *
 * A send refuses when the draft carries a dismissal and a dismissal refuses
 * when it carries a tap, in two tables no constraint spans — so each decides
 * on the other's ABSENCE. What keeps that safe is the shared lock and not the
 * deployment: everything the lease holder mints is one pass apart by
 * construction, and ADR-0006's second minter runs in another process. The
 * pair «the customer got the message» + «the rep was told it was discarded»
 * is the one outcome that must never both be true.
 *
 * MADE DETERMINISTIC RATHER THAN RUN AS A GAMBLE. A `Promise.all` of the two
 * would interleave differently on every machine and would pass on a broken
 * build most of the time. So the send holds its transaction open — lock
 * taken, tap written, nothing committed — and the dismissal is given a
 * statement timeout: it either waits on the lock (and is cancelled) or reads
 * an untouched draft and dismisses, and those two are exactly the fixed and
 * the broken build.
 */
describe("a send and a dismissal cannot both win (#224)", () => {
  it("makes the dismissal wait for the send lock, then refuses it on what it reads", async () => {
    const fx = await withClient((c) => mintFixture(c));
    const dek = createDekFromMaterial(randomBytes(32));
    const bundle = createBundle(join(tmp, `${fx.twinId}.bundle`), dek);
    // THE REP'S TWO «no va»s, COMMITTED BEFORE EITHER TRANSACTION OPENS, so
    // the only statement that can be cancelled below is the one waiting on
    // the lock.
    const [firstNo, secondNo] = await withClient(async (c) => [
      await insertWaEvent(c, fx),
      await insertWaEvent(c, fx),
    ]);
    const sender = await pool.connect();
    const dismisser = await pool.connect();
    try {
      // THE SEND, MID-FLIGHT: inside its own transaction, holding the twin
      // lock, with the tap written and nothing visible to anybody else yet.
      await sender.query("BEGIN");
      const sent = await attemptSend(
        sender,
        { minter: "rep_web", draftId: fx.draftId },
        deferRefusal,
      );
      expect(sent.outcome).toBe("written");

      // ...AND THE DISMISSAL ARRIVING WHILE IT IS. 250ms is far longer than
      // the read needs and far shorter than a human pause, so a cancellation
      // here means it waited on the lock rather than that the box was busy.
      await dismisser.query("BEGIN");
      await dismisser.query("SET LOCAL statement_timeout = 250");
      await expect(
        dismissDraft(
          { db: dismisser, dek, twinId: fx.twinId, hmacKey, bundle },
          {
            draftId: fx.draftId,
            evidence: {
              surface: "twin_thread",
              sourceEventId: firstNo!,
              waMessageId: "WAMID-NO-VA-RACE-1",
            },
          },
        ),
      ).rejects.toThrow(/statement timeout|canceling statement/iu);
      await dismisser.query("ROLLBACK");
      await sender.query("COMMIT");

      // ...AND ONCE THE SEND IS COMMITTED THE ANSWER IS THE HONEST ONE. The
      // draft went; a receipt saying «discarded» would lie (#30's own rule).
      await dismisser.query("BEGIN");
      const after = await dismissDraft(
        { db: dismisser, dek, twinId: fx.twinId, hmacKey, bundle },
        {
          draftId: fx.draftId,
          evidence: {
            surface: "twin_thread",
            sourceEventId: secondNo!,
            waMessageId: "WAMID-NO-VA-RACE-2",
          },
        },
      );
      await dismisser.query("COMMIT");
      expect(after).toEqual({ outcome: "refused", reason: "already_sent" });
      const dismissals = await withClient(async (c) =>
        (
          await c.query("SELECT 1 FROM draft_dismissals WHERE draft_id = $1", [
            fx.draftId,
          ])
        ).rowCount,
      );
      expect(dismissals).toBe(0);
    } finally {
      bundle.close();
      sender.release();
      dismisser.release();
    }
  });
});

/**
 * The corpus invariants (they run last in this file, over everything the
 * suite above produced — sends, refusals, races): FR-70 and the audit
 * chain's end-to-end linkage, the same checks CI runs as invariant steps.
 */
describe("invariants over the produced corpus", () => {
  it("FR-70: every outbound customer_send matches a recorded tap for its own draft and twin (slice AC 9)", async () => {
    const report = await withClient((c) => reconcileFr70(c));
    expect(report.customerSends).toBeGreaterThan(0);
    expect(report.violations).toEqual([]);
  });

  it("the audit chain verifies end to end and holds every refusal the suite provoked (ADR-0020)", async () => {
    const verdict = await withClient((c) => verifyAuditChainInDb(c, hmacKey));
    expect(verdict.entries).toBeGreaterThan(0);
    expect(verdict.valid).toBe(true);
  });
});
