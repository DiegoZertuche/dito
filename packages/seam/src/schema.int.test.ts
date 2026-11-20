/**
 * Seam schema integration tests (ticket #19) — real Postgres, migrations
 * applied by the pinned Atlas. These tests exercise the schema exactly the
 * way the plane and the twin-runtime will: SQL through the seam, nothing
 * mocked (ADR-0028).
 *
 * Governing ADRs: 0005 (the seam), 0006 (send lock, birth order), 0020
 * (append-only audit chain).
 */
import { beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { pgErrorCode, resetAndMigrate, withClient } from "./testing/db.js";

beforeAll(async () => {
  await resetAndMigrate();
});

/** Inserts a wa_events row with the pinned metadata envelope; returns its id. */
async function insertWaEvent(
  client: import("pg").Client,
  overrides: Partial<Record<string, unknown>> = {},
): Promise<number> {
  const row = {
    source: "whatsapp",
    external_event_id: randomUUID(),
    event_type: "message",
    company_id: randomUUID(),
    seat_id: randomUUID(),
    twin_id: randomUUID(),
    occurred_at: new Date("2026-08-26T12:00:00Z"),
    payload_enc: Buffer.from("op-aque-ciphertext"),
    ...overrides,
  };
  const res = await client.query(
    `INSERT INTO wa_events
       (source, external_event_id, event_type, company_id, seat_id, twin_id, occurred_at, payload_enc)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      row.source,
      row.external_event_id,
      row.event_type,
      row.company_id,
      row.seat_id,
      row.twin_id,
      row.occurred_at,
      row.payload_enc,
    ],
  );
  return res.rows[0].id;
}

describe("wa_events (inbound seam, ADR-0005)", () => {
  it("accepts the pinned metadata envelope and returns the payload ciphertext intact", async () => {
    await withClient(async (client) => {
      const externalEventId = randomUUID();
      const payload = Buffer.from([1, 2, 3, 255, 0, 42]);
      await insertWaEvent(client, {
        external_event_id: externalEventId,
        payload_enc: payload,
      });

      const res = await client.query(
        `SELECT source, external_event_id, event_type, company_id, seat_id, twin_id,
                occurred_at, payload_enc
           FROM wa_events WHERE external_event_id = $1`,
        [externalEventId],
      );
      expect(res.rowCount).toBe(1);
      const got = res.rows[0];
      expect(got.source).toBe("whatsapp");
      expect(got.event_type).toBe("message");
      expect(got.occurred_at).toEqual(new Date("2026-08-26T12:00:00Z"));
      expect(Buffer.from(got.payload_enc).equals(payload)).toBe(true);
    });
  });

  it("dedupes on (source, external_event_id): the duplicate insert is refused", async () => {
    await withClient(async (client) => {
      const externalEventId = randomUUID();
      await insertWaEvent(client, { external_event_id: externalEventId });
      // Same rail event redelivered — different metadata, same identity.
      await expect(
        insertWaEvent(client, {
          external_event_id: externalEventId,
          event_type: "message_edit",
        }),
      ).rejects.toSatisfy((err) => pgErrorCode(err) === "23505");
    });
  });

  it("does not dedupe the same external id across different sources", async () => {
    await withClient(async (client) => {
      const externalEventId = randomUUID();
      await insertWaEvent(client, { external_event_id: externalEventId });
      await insertWaEvent(client, {
        external_event_id: externalEventId,
        source: "whatsapp_cloud_api",
      });
      const res = await client.query(
        "SELECT count(*)::int AS n FROM wa_events WHERE external_event_id = $1",
        [externalEventId],
      );
      expect(res.rows[0].n).toBe(2);
    });
  });
});

/** Inserts a draft answering a fresh wa_events row; returns the draft id. */
async function insertDraft(
  client: import("pg").Client,
  overrides: Partial<Record<string, unknown>> = {},
): Promise<string> {
  const eventId =
    "in_reply_to_event_id" in overrides
      ? overrides["in_reply_to_event_id"]
      : await insertWaEvent(client);
  const res = await client.query(
    `INSERT INTO drafts (twin_id, in_reply_to_event_id, destination, content_enc)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [
      overrides["twin_id"] ?? randomUUID(),
      eventId,
      overrides["destination"] ?? "5215512345678@s.whatsapp.net",
      overrides["content_enc"] ?? Buffer.from("draft-ciphertext"),
    ],
  );
  return res.rows[0].id;
}

describe("drafts", () => {
  it("stores a draft (encrypted content) pointing at the event it answers", async () => {
    await withClient(async (client) => {
      const eventId = await insertWaEvent(client);
      const draftId = await insertDraft(client, {
        in_reply_to_event_id: eventId,
      });
      const res = await client.query(
        "SELECT in_reply_to_event_id, destination, content_enc FROM drafts WHERE id = $1",
        [draftId],
      );
      expect(res.rowCount).toBe(1);
      expect(res.rows[0].in_reply_to_event_id).toBe(String(eventId));
      expect(res.rows[0].destination).toBe("5215512345678@s.whatsapp.net");
    });
  });

  it("refuses a draft answering an event that does not exist", async () => {
    await withClient(async (client) => {
      await expect(
        insertDraft(client, { in_reply_to_event_id: 999_999_999 }),
      ).rejects.toSatisfy((err) => pgErrorCode(err) === "23503");
    });
  });
});

/** Mints a tap for a draft from a raw plane-delivered event; returns the tap id. */
async function insertTap(
  client: import("pg").Client,
  draftId: string,
  overrides: Partial<Record<string, unknown>> = {},
): Promise<string> {
  const sourceEventId =
    "source_event_id" in overrides
      ? overrides["source_event_id"]
      : await insertWaEvent(client);
  const res = await client.query(
    `INSERT INTO taps (draft_id, minter, source_event_id)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [draftId, overrides["minter"] ?? "affirmation_matcher", sourceEventId],
  );
  return res.rows[0].id;
}

describe("taps (the single-use send lock, ADR-0006)", () => {
  it("records the rep's affirmation of one draft, pinned to the raw event that minted it", async () => {
    await withClient(async (client) => {
      const draftId = await insertDraft(client);
      const affirmationEventId = await insertWaEvent(client);
      const tapId = await insertTap(client, draftId, {
        source_event_id: affirmationEventId,
      });
      const res = await client.query(
        "SELECT draft_id, minter, source_event_id FROM taps WHERE id = $1",
        [tapId],
      );
      expect(res.rows[0].draft_id).toBe(draftId);
      expect(res.rows[0].minter).toBe("affirmation_matcher");
      expect(res.rows[0].source_event_id).toBe(String(affirmationEventId));
    });
  });

  it("UNIQUE(draft_id): the second tap on the same draft is refused — a double «va» cannot double-send", async () => {
    await withClient(async (client) => {
      const draftId = await insertDraft(client);
      await insertTap(client, draftId);
      await expect(insertTap(client, draftId)).rejects.toSatisfy(
        (err) => pgErrorCode(err) === "23505",
      );
    });
  });

  it("refuses a tap on a draft that does not exist — a tap authorizes one specific draft", async () => {
    await withClient(async (client) => {
      await expect(insertTap(client, randomUUID())).rejects.toSatisfy(
        (err) => pgErrorCode(err) === "23503",
      );
    });
  });

  it("pins the closed minter set: slice 1's only minter is the affirmation matcher", async () => {
    await withClient(async (client) => {
      const draftId = await insertDraft(client);
      // Model output (or any unnamed path) can never mint a tap; a new
      // minter arrives only via migration — the reviewable event ADR-0006
      // wants for its "exactly two non-model code paths".
      await expect(
        insertTap(client, draftId, { minter: "model_output" }),
      ).rejects.toSatisfy((err) => pgErrorCode(err) === "23514");
    });
  });

  it("refuses an affirmation-matcher tap with no raw plane-delivered event — the matcher's input is pinned", async () => {
    await withClient(async (client) => {
      const draftId = await insertDraft(client);
      await expect(
        insertTap(client, draftId, { source_event_id: null }),
      ).rejects.toSatisfy((err) => pgErrorCode(err) === "23514");
    });
  });
});

/** Writes a send command; returns its id. */
async function insertSendCommand(
  client: import("pg").Client,
  cmd: {
    sendClass: string;
    tapId?: string | null;
    draftId?: string | null;
    destination?: string;
    payloadRef?: string;
    outcome?: string | null;
  },
): Promise<string> {
  const res = await client.query(
    `INSERT INTO send_commands (twin_id, send_class, destination, payload_ref, tap_id, draft_id, outcome)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [
      randomUUID(),
      cmd.sendClass,
      cmd.destination ?? "5215512345678@s.whatsapp.net",
      // Canonical by default: a command's payload_ref names its own draft
      // (send_commands_draft_payload_bound_check, ticket #25).
      cmd.payloadRef ??
        (cmd.draftId ? `draft:${cmd.draftId}` : `draft:${randomUUID()}`),
      cmd.tapId ?? null,
      cmd.draftId ?? null,
      cmd.outcome ?? null,
    ],
  );
  return res.rows[0].id;
}

describe("send_commands (outbound seam, ADR-0006)", () => {
  it("accepts a system_send with no tap — the plane enforces self-chat-only from live session identity", async () => {
    await withClient(async (client) => {
      const id = await insertSendCommand(client, { sendClass: "system_send" });
      const res = await client.query(
        "SELECT send_class, tap_id, outcome FROM send_commands WHERE id = $1",
        [id],
      );
      expect(res.rows[0].send_class).toBe("system_send");
      expect(res.rows[0].tap_id).toBeNull();
      expect(res.rows[0].outcome).toBeNull(); // not yet executed
    });
  });

  it("refuses a customer_send with no tap reference — no code path reaches a customer without a recorded tap", async () => {
    await withClient(async (client) => {
      await expect(
        insertSendCommand(client, { sendClass: "customer_send", tapId: null }),
      ).rejects.toSatisfy((err) => pgErrorCode(err) === "23514");
    });
  });

  it("refuses a command pairing a draft with another payload ref — the rep can only ever affirm the content that was posted (ticket #25)", async () => {
    await withClient(async (client) => {
      const shown = await insertDraft(client);
      const unseen = await insertDraft(client);
      // A system_send that would display `shown` while the matcher
      // resolves quoted replies to `unseen` — the «va» would authorize
      // content the rep never saw. Unrepresentable by CHECK.
      await expect(
        insertSendCommand(client, {
          sendClass: "system_send",
          draftId: unseen,
          payloadRef: `draft:${shown}`,
        }),
      ).rejects.toSatisfy((err) => pgErrorCode(err) === "23514");
      // The canonical pairing is what every writer mints — accepted.
      const id = await insertSendCommand(client, {
        sendClass: "system_send",
        draftId: shown,
        payloadRef: `draft:${shown}`,
      });
      expect(id).toBeTruthy();
    });
  });

  it("accepts a customer_send referencing a recorded tap and its tapped draft", async () => {
    await withClient(async (client) => {
      const draftId = await insertDraft(client);
      const tapId = await insertTap(client, draftId);
      const id = await insertSendCommand(client, {
        sendClass: "customer_send",
        tapId,
        draftId,
        payloadRef: `draft:${draftId}`,
      });
      const res = await client.query(
        "SELECT tap_id, draft_id FROM send_commands WHERE id = $1",
        [id],
      );
      expect(res.rows[0].tap_id).toBe(tapId);
      expect(res.rows[0].draft_id).toBe(draftId);
    });
  });

  it("refuses a customer_send pairing a real tap with a different draft — a tap authorizes exactly its own draft", async () => {
    await withClient(async (client) => {
      const tappedDraft = await insertDraft(client);
      const otherDraft = await insertDraft(client);
      const tapId = await insertTap(client, tappedDraft);
      await expect(
        insertSendCommand(client, {
          sendClass: "customer_send",
          tapId,
          draftId: otherDraft,
        }),
      ).rejects.toSatisfy((err) => pgErrorCode(err) === "23503");
    });
  });

  it("refuses a customer_send with a tap but no draft reference", async () => {
    await withClient(async (client) => {
      const draftId = await insertDraft(client);
      const tapId = await insertTap(client, draftId);
      await expect(
        insertSendCommand(client, {
          sendClass: "customer_send",
          tapId,
          draftId: null,
        }),
      ).rejects.toSatisfy((err) => pgErrorCode(err) === "23514");
    });
  });

  it("refuses a system_send that carries a tap — taps belong to customer sends only", async () => {
    await withClient(async (client) => {
      const draftId = await insertDraft(client);
      const tapId = await insertTap(client, draftId);
      await expect(
        insertSendCommand(client, { sendClass: "system_send", tapId, draftId }),
      ).rejects.toSatisfy((err) => pgErrorCode(err) === "23514");
    });
  });

  it("refuses a second command on the same tap — a retry is a new tap, never a reuse", async () => {
    await withClient(async (client) => {
      const draftId = await insertDraft(client);
      const tapId = await insertTap(client, draftId);
      await insertSendCommand(client, {
        sendClass: "customer_send",
        tapId,
        draftId,
      });
      await expect(
        insertSendCommand(client, {
          sendClass: "customer_send",
          tapId,
          draftId,
        }),
      ).rejects.toSatisfy((err) => pgErrorCode(err) === "23505");
    });
  });

  it("refuses send classes outside customer_send/system_send", async () => {
    await withClient(async (client) => {
      await expect(
        insertSendCommand(client, { sendClass: "broadcast_send" }),
      ).rejects.toSatisfy((err) => pgErrorCode(err) === "23514");
    });
  });

  it("constrains outcomes to sent/failed/held — never silent, never auto-retried", async () => {
    await withClient(async (client) => {
      const id = await insertSendCommand(client, { sendClass: "system_send" });
      await client.query(
        "UPDATE send_commands SET outcome = 'sent', executed_at = now() WHERE id = $1",
        [id],
      );
      const res = await client.query(
        "SELECT outcome FROM send_commands WHERE id = $1",
        [id],
      );
      expect(res.rows[0].outcome).toBe("sent");

      await expect(
        insertSendCommand(client, { sendClass: "system_send", outcome: "retrying" }),
      ).rejects.toSatisfy((err) => pgErrorCode(err) === "23514");
    });
  });
});

describe("the envelope crosses the seam (ADR-0008 × ADR-0005)", () => {
  it("a DEK-sealed payload survives wa_events storage and decrypts intact on the other side", async () => {
    const { createDekFromMaterial } = await import("@dito/crypto");
    const dek = createDekFromMaterial(
      Uint8Array.from({ length: 32 }, (_, i) => (i * 11 + 5) % 256),
    );
    const message = new TextEncoder().encode(
      "señora Marta pidió 15 kilos para el viernes",
    );
    await withClient(async (client) => {
      const externalEventId = randomUUID();
      await insertWaEvent(client, {
        external_event_id: externalEventId,
        payload_enc: Buffer.from(dek.encrypt(message)),
      });
      const res = await client.query(
        "SELECT payload_enc FROM wa_events WHERE external_event_id = $1",
        [externalEventId],
      );
      const opened = dek.decrypt(res.rows[0].payload_enc);
      expect(Buffer.from(opened).equals(Buffer.from(message))).toBe(true);
      // And the stored bytes are ciphertext, not the message.
      expect(
        Buffer.from(res.rows[0].payload_enc).includes(Buffer.from(message)),
      ).toBe(false);
    });
  });
});

describe("metadata-only config tables (ADR-0023 skeleton, ADR-0017 pacing)", () => {
  it("scope_allowlist holds one chat identity per twin per chat — names/ids only, no content columns", async () => {
    await withClient(async (client) => {
      const twinId = randomUUID();
      const chat = "5215598765432@s.whatsapp.net";
      await client.query(
        "INSERT INTO scope_allowlist (twin_id, chat_jid) VALUES ($1, $2)",
        [twinId, chat],
      );
      // Idempotence boundary: the same chat cannot be scoped twice.
      await expect(
        client.query(
          "INSERT INTO scope_allowlist (twin_id, chat_jid) VALUES ($1, $2)",
          [twinId, chat],
        ),
      ).rejects.toSatisfy((err) => pgErrorCode(err) === "23505");

      // Metadata-only: the table carries identity and bookkeeping columns, nothing else.
      const cols = await client.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'scope_allowlist'
         ORDER BY column_name`,
      );
      expect(cols.rows.map((r) => r.column_name)).toEqual([
        "chat_jid",
        "created_at",
        "twin_id",
      ]);
    });
  });

  it("send_allowlist holds the hard destination allowlist per twin", async () => {
    await withClient(async (client) => {
      const twinId = randomUUID();
      const dest = "5215512345678@s.whatsapp.net";
      await client.query(
        "INSERT INTO send_allowlist (twin_id, destination_jid) VALUES ($1, $2)",
        [twinId, dest],
      );
      await expect(
        client.query(
          "INSERT INTO send_allowlist (twin_id, destination_jid) VALUES ($1, $2)",
          [twinId, dest],
        ),
      ).rejects.toSatisfy((err) => pgErrorCode(err) === "23505");
    });
  });

  it("pacing_thresholds holds one row of conservative thresholds per twin", async () => {
    await withClient(async (client) => {
      const twinId = randomUUID();
      await client.query(
        `INSERT INTO pacing_thresholds (twin_id, max_sends_per_hour, min_seconds_between_sends)
         VALUES ($1, $2, $3)`,
        [twinId, 12, 90],
      );
      await expect(
        client.query(
          `INSERT INTO pacing_thresholds (twin_id, max_sends_per_hour, min_seconds_between_sends)
           VALUES ($1, $2, $3)`,
          [twinId, 20, 30],
        ),
      ).rejects.toSatisfy((err) => pgErrorCode(err) === "23505");
    });
  });
});

describe("audit_chain (append-only, ADR-0020 skeleton)", () => {
  async function insertAuditEntry(
    client: import("pg").Client,
  ): Promise<number> {
    const res = await client.query(
      `INSERT INTO audit_chain (caller, action, ref, outcome, prev_hash, entry_hash)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [
        "send_commands_writer",
        "send_refused_off_allowlist",
        `draft:${randomUUID()}`,
        "refused",
        null,
        Buffer.alloc(32, 7),
      ],
    );
    return res.rows[0].id;
  }

  it("appends content-free entries: caller, action, opaque ref, outcome, chain hashes", async () => {
    await withClient(async (client) => {
      const id = await insertAuditEntry(client);
      const res = await client.query(
        "SELECT caller, action, outcome FROM audit_chain WHERE id = $1",
        [id],
      );
      expect(res.rows[0]).toEqual({
        caller: "send_commands_writer",
        action: "send_refused_off_allowlist",
        outcome: "refused",
      });
    });
  });

  it("refuses UPDATE — the chain is tamper-evident, not editable", async () => {
    await withClient(async (client) => {
      const id = await insertAuditEntry(client);
      await expect(
        client.query("UPDATE audit_chain SET outcome = 'ok' WHERE id = $1", [id]),
      ).rejects.toSatisfy(
        (err) =>
          err instanceof Error && err.message.includes("append-only"),
      );
    });
  });

  it("refuses DELETE", async () => {
    await withClient(async (client) => {
      const id = await insertAuditEntry(client);
      await expect(
        client.query("DELETE FROM audit_chain WHERE id = $1", [id]),
      ).rejects.toSatisfy(
        (err) =>
          err instanceof Error && err.message.includes("append-only"),
      );
    });
  });

  it("refuses TRUNCATE", async () => {
    await withClient(async (client) => {
      await insertAuditEntry(client);
      await expect(client.query("TRUNCATE audit_chain")).rejects.toSatisfy(
        (err) =>
          err instanceof Error && err.message.includes("append-only"),
      );
    });
  });
});
