/**
 * FR-70 reconciliation integration tests (ticket #24, slice AC 9): the SQL
 * join over the seam tables proving every outbound customer_send matches a
 * recorded tap for its own draft and twin. The reconciliation is the
 * independent auditor over the schema's constraints — it must also catch
 * the one mismatch the CHECKs cannot make unrepresentable: a command whose
 * twin differs from its draft's twin.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { reconcileFr70 } from "./fr70.js";
import { resetAndMigrate, withClient } from "./testing/db.js";

beforeAll(async () => {
  await resetAndMigrate();
});

/** A legitimate tapped send: event → draft → tap → customer_send command. */
async function insertTappedSend(
  client: pg.ClientBase,
  overrides: {
    commandTwinId?: string;
    commandDestination?: string;
    commandPayloadRef?: string;
    /** Mint the tap but no command — the orphan the writer can never leave. */
    omitCommand?: boolean;
    /** Mint the tap's source event under this twin instead of the draft's. */
    tapEventTwinId?: string;
    /**
     * Mint the tap as the DASHBOARD does (ticket #224): minter `rep_web` and
     * NO source event, which `taps_matcher_requires_event_check` permits for
     * exactly this minter — the rep pressed a button, and there is no seam row
     * behind a button.
     */
    repWeb?: boolean;
  } = {},
): Promise<{ twinId: string; commandId: string | null; tapId: string }> {
  const twinId = randomUUID();
  const eventRes = await client.query(
    `INSERT INTO wa_events
       (source, external_event_id, event_type, company_id, seat_id, twin_id, occurred_at, payload_enc)
     VALUES ('whatsapp', $1, 'message', $2, $3, $4, now(), $5) RETURNING id`,
    [randomUUID(), randomUUID(), randomUUID(), twinId, Buffer.from("opaque")],
  );
  const draftRes = await client.query(
    `INSERT INTO drafts (twin_id, in_reply_to_event_id, destination, content_enc)
     VALUES ($1, $2, '5215550000000@s.whatsapp.net', $3) RETURNING id`,
    [twinId, eventRes.rows[0].id, Buffer.from("opaque")],
  );
  const draftId = draftRes.rows[0].id;
  let tapSourceEventId = eventRes.rows[0].id;
  if (overrides.tapEventTwinId !== undefined) {
    const foreignEventRes = await client.query(
      `INSERT INTO wa_events
         (source, external_event_id, event_type, company_id, seat_id, twin_id, occurred_at, payload_enc)
       VALUES ('whatsapp', $1, 'message', $2, $3, $4, now(), $5) RETURNING id`,
      [
        randomUUID(),
        randomUUID(),
        randomUUID(),
        overrides.tapEventTwinId,
        Buffer.from("opaque"),
      ],
    );
    tapSourceEventId = foreignEventRes.rows[0].id;
  }
  const tapRes = await client.query(
    `INSERT INTO taps (draft_id, minter, source_event_id)
     VALUES ($1, $2, $3) RETURNING id`,
    [
      draftId,
      overrides.repWeb === true ? "rep_web" : "affirmation_matcher",
      overrides.repWeb === true ? null : tapSourceEventId,
    ],
  );
  const tapId = tapRes.rows[0].id;
  if (overrides.omitCommand) {
    return { twinId, commandId: null, tapId };
  }
  const commandRes = await client.query(
    `INSERT INTO send_commands (twin_id, send_class, destination, payload_ref, tap_id, draft_id)
     VALUES ($1, 'customer_send', $2, $3, $4, $5) RETURNING id`,
    [
      overrides.commandTwinId ?? twinId,
      overrides.commandDestination ?? "5215550000000@s.whatsapp.net",
      overrides.commandPayloadRef ?? `draft:${draftId}`,
      tapId,
      draftId,
    ],
  );
  return { twinId, commandId: commandRes.rows[0].id, tapId };
}

describe("FR-70 reconciliation (slice AC 9, ADR-0006)", () => {
  it("reports a corpus of properly tapped sends clean", async () => {
    await withClient(async (c) => {
      await insertTappedSend(c);
      await insertTappedSend(c);
    });
    const report = await withClient((c) => reconcileFr70(c));
    expect(report.customerSends).toBeGreaterThanOrEqual(2);
    expect(report.violations).toEqual([]);
  });

  it("catches a command whose twin differs from its draft's twin", async () => {
    await resetAndMigrate();
    const planted = await withClient((c) =>
      insertTappedSend(c, { commandTwinId: randomUUID() }),
    );
    const report = await withClient((c) => reconcileFr70(c));
    expect(report.violations.length).toBe(1);
    expect(report.violations[0]).toMatchObject({
      subject: `command:${planted.commandId}`,
    });
  });

  it("catches an orphan tap with no command — a tap that locked its draft without a send", async () => {
    await resetAndMigrate();
    const planted = await withClient((c) =>
      insertTappedSend(c, { omitCommand: true }),
    );
    const report = await withClient((c) => reconcileFr70(c));
    expect(report.violations.length).toBe(1);
    expect(report.violations[0]).toMatchObject({
      subject: `tap:${planted.tapId}`,
    });
  });

  it("catches a command whose destination is not its tapped draft's destination", async () => {
    await resetAndMigrate();
    const planted = await withClient((c) =>
      insertTappedSend(c, {
        commandDestination: "5219999999999@s.whatsapp.net",
      }),
    );
    const report = await withClient((c) => reconcileFr70(c));
    expect(report.violations.length).toBe(1);
    expect(report.violations[0]).toMatchObject({
      subject: `command:${planted.commandId}`,
    });
  });

  it("catches a tap whose source event belongs to a different twin than its draft", async () => {
    await resetAndMigrate();
    const planted = await withClient((c) =>
      insertTappedSend(c, { tapEventTwinId: randomUUID() }),
    );
    const report = await withClient((c) => reconcileFr70(c));
    expect(report.violations.length).toBe(1);
    expect(report.violations[0]).toMatchObject({
      subject: `tap:${planted.tapId}`,
    });
  });

  it("reports a corpus of dashboard taps clean, with no source event on any of them", async () => {
    // ADR-0006's SECOND MINTER (ticket #224). A tap the dashboard minted
    // carries no seam event at all, so it falls out of the same-twin class
    // above — which joins `wa_events` — and this is the corpus that proves the
    // reconciliation still says something about it.
    await resetAndMigrate();
    await withClient(async (c) => {
      await insertTappedSend(c, { repWeb: true });
      await insertTappedSend(c, { repWeb: true });
      // ...and one of each, because a real corpus carries both.
      await insertTappedSend(c);
    });
    const report = await withClient((c) => reconcileFr70(c));
    expect(report.customerSends).toBe(3);
    expect(report.violations).toEqual([]);
    const minters = await withClient((c) =>
      c.query<{ minter: string; sourceless: boolean }>(
        "SELECT minter, source_event_id IS NULL AS sourceless FROM taps ORDER BY minter",
      ),
    );
    expect(minters.rows).toEqual([
      { minter: "affirmation_matcher", sourceless: false },
      { minter: "rep_web", sourceless: true },
      { minter: "rep_web", sourceless: true },
    ]);
  });

  it("catches a source-less tap that authorized a command for another twin", async () => {
    // THE CLASS #224 ADDS, and the reason it had to be added: the same-twin
    // binding above is an INNER JOIN on the tap's source event, so a dashboard
    // tap — which has none — was reconciled by nothing at all. What replaces
    // the event's twin as the second reading is the COMMAND's, because the
    // writer derives both from one draft row in one transaction.
    //
    // PLANTED IN THE ONE DIRECTION THE STORE PERMITS: the command's twin is
    // the field a caller supplies, and every CHECK and foreign key on
    // `send_commands` is satisfied by this row.
    await resetAndMigrate();
    const planted = await withClient((c) =>
      insertTappedSend(c, { repWeb: true, commandTwinId: randomUUID() }),
    );
    const report = await withClient((c) => reconcileFr70(c));
    expect(report.violations).toContainEqual({
      subject: `tap:${planted.tapId}`,
      reason:
        "source-less tap authorizes a command for another twin than its draft",
    });
  });

  it("catches a command whose payload_ref is not the canonical ref of its tapped draft", async () => {
    await resetAndMigrate();
    // Since #25 the schema itself makes this class unrepresentable
    // (send_commands_draft_payload_bound_check) — FR-70 remains the
    // independent auditor over it, so the plant drops the CHECK for this
    // test only (the next reset restores it) to prove the join still
    // catches the class on a seam whose schema half failed.
    await withClient((c) =>
      c.query(
        "ALTER TABLE send_commands DROP CONSTRAINT send_commands_draft_payload_bound_check",
      ),
    );
    const planted = await withClient((c) =>
      insertTappedSend(c, { commandPayloadRef: `draft:${randomUUID()}` }),
    );
    const report = await withClient((c) => reconcileFr70(c));
    expect(report.violations.length).toBe(1);
    expect(report.violations[0]).toMatchObject({
      subject: `command:${planted.commandId}`,
    });
  });
});
