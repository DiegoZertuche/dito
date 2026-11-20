/**
 * The send confirmation (ticket #25): after a customer_send resolves
 * sent, «Enviado a {name}» posts to the twin thread via system_send —
 * tested across the Postgres seam (spec #18): plant executor-resolved
 * command rows, assert the notice and its command on the other side.
 * Real Postgres, real envelope crypto (ADR-0028).
 */
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBundle, type Bundle } from "@dito/bundle";
import { createDekFromMaterial, type Dek } from "@dito/crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { processResolvedSends } from "./confirmations.js";
import { removeTmpDir } from "./testing/tmp.js";
import { resetAndMigrate, withClient } from "./testing/db.js";
import { insertWaEvent } from "./testing/seam-fixtures.js";
import { SETTLE_IMMEDIATELY } from "./testing/settle.js";

const SELF_CHAT = "5215550000@s.whatsapp.net";
const CUSTOMER = "5215550001@s.whatsapp.net";

let tmp: string;

beforeAll(async () => {
  await resetAndMigrate();
  tmp = mkdtempSync(join(tmpdir(), "dito-confirmations-int-"));
});

afterAll(() => {
  removeTmpDir(tmp);
});

/** A fresh twin with its own real SQLCipher bundle (the sweep reads bindings through it, #34). */
function freshTwin(): { twinId: string; dek: Dek; bundle: Bundle } {
  const twinId = randomUUID();
  const dek = createDekFromMaterial(randomBytes(32));
  const bundle = createBundle(join(tmp, `${twinId}.bundle`), dek);
  return { twinId, dek, bundle };
}

/** A customer_send the executor resolved (or left as given). */
async function plantCustomerSend(
  client: pg.Client,
  twin: { twinId: string; dek: Dek },
  outcome: "sent" | "failed" | "held" | null,
  opts: { inReplyToEventId?: string } = {},
): Promise<{ commandId: string }> {
  const draftRes = await client.query<{ id: string }>(
    "INSERT INTO drafts (twin_id, destination, content_enc, in_reply_to_event_id) VALUES ($1, $2, $3, $4) RETURNING id",
    [
      twin.twinId,
      CUSTOMER,
      Buffer.from(twin.dek.encrypt(Buffer.from("hola", "utf8"))),
      opts.inReplyToEventId ?? null,
    ],
  );
  const draftId = draftRes.rows[0]!.id;
  const eventRes = await client.query<{ id: string }>(
    `INSERT INTO wa_events (source, external_event_id, event_type, company_id, seat_id, twin_id, occurred_at, payload_enc)
     VALUES ('whatsapp', $1, 'message', gen_random_uuid(), gen_random_uuid(), $2, now(), $3) RETURNING id`,
    [randomUUID(), twin.twinId, Buffer.from("opaque")],
  );
  const tapRes = await client.query<{ id: string }>(
    "INSERT INTO taps (draft_id, minter, source_event_id) VALUES ($1, 'affirmation_matcher', $2) RETURNING id",
    [draftId, eventRes.rows[0]!.id],
  );
  const cmdRes = await client.query<{ id: string }>(
    `INSERT INTO send_commands (twin_id, send_class, destination, payload_ref, tap_id, draft_id)
     VALUES ($1, 'customer_send', $2, $3, $4, $5) RETURNING id`,
    [twin.twinId, CUSTOMER, `draft:${draftId}`, tapRes.rows[0]!.id, draftId],
  );
  const commandId = cmdRes.rows[0]!.id;
  if (outcome !== null) {
    await client.query(
      "UPDATE send_commands SET outcome = $2, executed_at = now() WHERE id = $1",
      [commandId, outcome],
    );
  }
  return { commandId };
}

function depsFor(
  client: pg.Client,
  twin: { twinId: string; dek: Dek; bundle: Bundle },
) {
  return {
    db: client,
    dek: twin.dek,
    bundle: twin.bundle,
    twinId: twin.twinId,
    selfChatJid: SELF_CHAT,
    // Ticket #75: this suite is not about batching (see testing/settle.ts).
    ...SETTLE_IMMEDIATELY,
  };
}

describe("send confirmation to the twin thread (ticket #25)", () => {
  it("a customer_send resolved sent gets «Enviado a {name}» — one notice, one system_send, exactly once across repeated sweeps", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const { commandId } = await plantCustomerSend(client, twin, "sent");

      await processResolvedSends(depsFor(client, twin));
      // The sweep is re-runnable: a second pass must not double-post.
      await processResolvedSends(depsFor(client, twin));

      const notices = await client.query<{ id: string; content_enc: Buffer }>(
        "SELECT id, content_enc FROM notices WHERE about_command_id = $1 AND kind = 'send_confirmation'",
        [commandId],
      );
      expect(notices.rows).toHaveLength(1);
      // No source event on this planted draft → the counterparty name falls
      // back to the number; the frame and the ✓ are ticket #30's grammar,
      // the provisional mark is ticket #34's — the chat is unbound.
      expect(
        Buffer.from(twin.dek.decrypt(notices.rows[0]!.content_enc)).toString("utf8"),
      ).toBe("✳️ Enviado a 5215550001 (sin confirmar) ✓");

      const commands = await client.query(
        "SELECT destination, tap_id, outcome FROM send_commands WHERE send_class = 'system_send' AND payload_ref = $1",
        [`notice:${notices.rows[0]!.id}`],
      );
      expect(commands.rows).toEqual([
        { destination: SELF_CHAT, tap_id: null, outcome: null },
      ]);
    });
  });

  it("before confirmation, the sweep names the counterparty from the drafted inbound's push-name, marked provisional (tickets #30/#34)", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const inboundId = await insertWaEvent(client, twin.dek, {
        twinId: twin.twinId,
        chatJid: CUSTOMER,
        senderJid: CUSTOMER,
        fromMe: false,
        messageId: "3EB0-CONF-PN",
        text: "¿tiene disponibilidad?",
        pushName: "Sra. Garza",
      });
      const { commandId } = await plantCustomerSend(client, twin, "sent", {
        inReplyToEventId: inboundId,
      });

      await processResolvedSends(depsFor(client, twin));

      const notices = await client.query<{ content_enc: Buffer }>(
        "SELECT content_enc FROM notices WHERE about_command_id = $1 AND kind = 'send_confirmation'",
        [commandId],
      );
      expect(notices.rows).toHaveLength(1);
      expect(
        Buffer.from(twin.dek.decrypt(notices.rows[0]!.content_enc)).toString("utf8"),
      ).toBe("✳️ Enviado a Sra. Garza (sin confirmar) ✓");
      twin.bundle.close();
    });
  });

  it("after the rep confirms the binding, «Enviado a {cliente}» wears the confirmed name unmarked (ticket #34 AC 4)", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      // The rep-confirmed binding, in the entity mirror through the bundle
      // API (the ceremony's seam path is proven in bindings.int.test.ts).
      twin.bundle.confirmChatBinding({
        chatJid: CUSTOMER,
        entityId: randomUUID(),
        displayName: "Sra. Garza",
        confirmedAt: new Date().toISOString(),
      });
      const inboundId = await insertWaEvent(client, twin.dek, {
        twinId: twin.twinId,
        chatJid: CUSTOMER,
        senderJid: CUSTOMER,
        fromMe: false,
        messageId: "3EB0-CONF-BOUND",
        text: "¿tiene disponibilidad?",
        // The rail may say anything today — the rep's word wins.
        pushName: "Garza Abarrotes",
      });
      const { commandId } = await plantCustomerSend(client, twin, "sent", {
        inReplyToEventId: inboundId,
      });

      await processResolvedSends(depsFor(client, twin));

      const notices = await client.query<{ content_enc: Buffer }>(
        "SELECT content_enc FROM notices WHERE about_command_id = $1 AND kind = 'send_confirmation'",
        [commandId],
      );
      expect(notices.rows).toHaveLength(1);
      expect(
        Buffer.from(twin.dek.decrypt(notices.rows[0]!.content_enc)).toString("utf8"),
      ).toBe("✳️ Enviado a Sra. Garza ✓");
      twin.bundle.close();
    });
  });

  it("pending, failed, and held sends confirm nothing — «Enviado» is only ever true", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await plantCustomerSend(client, twin, null);
      await plantCustomerSend(client, twin, "failed");
      await plantCustomerSend(client, twin, "held");

      await processResolvedSends(depsFor(client, twin));

      const notices = await client.query(
        "SELECT id FROM notices WHERE twin_id = $1",
        [twin.twinId],
      );
      expect(notices.rows).toEqual([]);
    });
  });
});
