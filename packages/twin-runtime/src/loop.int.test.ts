/**
 * The magic loop end to end across the Postgres seam (ticket #25; spec
 * #18): inbound counterparty fixture → draft → system_send row →
 * (executor post + recorded message id, simulated at the seam exactly as
 * plane/executor performs it — proven in Go) → rep quoted «va» fixture →
 * tap + customer_send in one writer transaction → executor finalization →
 * confirmation notice in the twin thread — and FR-70 green over the
 * corpus this very loop produced (slice AC 9).
 *
 * Real Postgres, real envelope crypto, real SQLCipher, the real send-lock
 * writer; the model is scripted at the model boundary; the draft
 * text asserted is the script's own fixture string, never judged prose.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBundle } from "@dito/bundle";
import { createDekFromMaterial } from "@dito/crypto";
import { decodeWaMessagePayload, reconcileFr70 } from "@dito/seam";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { processResolvedSends } from "./confirmations.js";
import { processPendingWaEvents, type TwinRuntimeDeps } from "./consumer.js";
import { createSendLockWriter, CONSERVATIVE_DEV_PACING } from "./send-lock/writer.js";
import {
  resetAndMigrate,
  withClient,
  TEST_AUDIT_HMAC_KEY,
  TEST_DATABASE_URL,
} from "./testing/db.js";
import { removeTmpDir } from "./testing/tmp.js";
import { fakeEmbedder } from "./testing/fake-embedder.js";
import { insertWaEvent, simulateExecutorPost } from "./testing/seam-fixtures.js";
import { closeScriptedModels, scriptedModel, type ScriptedTurn } from "./testing/scripted-model.js";
import { SETTLE_IMMEDIATELY } from "./testing/settle.js";
import { newExecutionPool } from "./testing/execution-pool.js";

// Every scripted model this suite opened is closed with it (#328).
afterAll(closeScriptedModels);

/** One connection source for every execution this suite runs (ticket #173). */
const executionPool = newExecutionPool();

const SELF_CHAT = "5215550000@s.whatsapp.net";
const CUSTOMER = "5215550001@s.whatsapp.net";
const DRAFT_TEXT = "claro, se las mando el jueves temprano";

function draftingTurns(): ScriptedTurn[] {
  return [
    { toolCall: { name: "create_draft", input: { text: DRAFT_TEXT } } },
    { text: "done" },
  ];
}

let tmp: string;
let pool: pg.Pool;

beforeAll(async () => {
  await resetAndMigrate();
  tmp = mkdtempSync(join(tmpdir(), "dito-loop-int-"));
  pool = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 4 });
});

afterAll(async () => {
  await pool.end();
  removeTmpDir(tmp);
});

describe("the magic loop, seam to seam (ticket #25; slice ACs 5, 6, 9)", () => {
  it("inbound → draft → posted → «va» → tap+customer_send → sent → «Enviado» — FR-70 green over the produced corpus", async () => {
    await withClient(async (client) => {
      const twinId = randomUUID();
      // The seat's scope, as the plane stamps it on every captured row from
      // its own configuration — one pair per twin (ticket #63).
      const companyId = randomUUID();
      const seatId = randomUUID();
      const dek = createDekFromMaterial(randomBytes(32));
      const bundle = createBundle(join(tmp, `${twinId}.bundle`), dek);
      // Rig provisioning seeds (fail-closed: an unseeded twin cannot send).
      await client.query(
        "INSERT INTO send_allowlist (twin_id, destination_jid) VALUES ($1, $2)",
        [twinId, CUSTOMER],
      );
      // ...and the CAPTURE list, a different list (ADR-0023 vs ADR-0017):
      // it is what admits the customer's inbound and the twin's own reply
      // into twin memory.
      await client.query(
        "INSERT INTO scope_allowlist (twin_id, chat_jid) VALUES ($1, $2)",
        [twinId, CUSTOMER],
      );
      await client.query(
        "INSERT INTO pacing_thresholds (twin_id, max_sends_per_hour, min_seconds_between_sends) VALUES ($1, $2, $3)",
        [twinId, CONSERVATIVE_DEV_PACING.maxSendsPerHour, CONSERVATIVE_DEV_PACING.minSecondsBetweenSends],
      );

      const { harness, requests } = scriptedModel(draftingTurns());
      const deps: TwinRuntimeDeps = {
        db: client,
        harness,
        bundle,
        dek,
        twinId,
        selfChatJid: SELF_CHAT,
        // Ticket #75: this suite is not about batching (see testing/settle.ts).
        ...SETTLE_IMMEDIATELY,
        drafting: { model: "claude-sonnet-5" },
        executionPool,
        sendLock: createSendLockWriter({ pool, hmacKey: TEST_AUDIT_HMAC_KEY }),
        hmacKey: TEST_AUDIT_HMAC_KEY,
        embedder: fakeEmbedder(),
      };

      // 1. The counterparty asks something that needs an answer.
      await insertWaEvent(client, dek, {
        twinId,
        companyId,
        seatId,
        chatJid: CUSTOMER,
        senderJid: CUSTOMER,
        fromMe: false,
        messageId: "3EB0-LOOP-IN",
        text: "¿me mandas 40 cajas para el jueves?",
      });
      await processPendingWaEvents(deps);
      // One drafting run = two model requests: the decision tool
      // call, then the closing turn after the tool result rides back.
      expect(requests).toHaveLength(2);

      // 2. The draft and its system_send are on the seam.
      const draftRow = await client.query<{ id: string }>(
        "SELECT id FROM drafts WHERE twin_id = $1",
        [twinId],
      );
      const draftId = draftRow.rows[0]!.id;
      const systemSend = await client.query<{ id: string }>(
        `SELECT id FROM send_commands
          WHERE twin_id = $1 AND send_class = 'system_send' AND payload_ref = $2`,
        [twinId, `draft:${draftId}`],
      );
      expect(systemSend.rows).toHaveLength(1);

      // 3. The executor posts the draft to the twin thread and records
      //    the posted message id (simulated; semantics proven in Go).
      await simulateExecutorPost(client, {
        commandId: systemSend.rows[0]!.id,
        twinId,
        waMessageId: "WAMID-LOOP-DRAFT",
      });

      // 4. The rep quote-replies «va» in the self-chat (raw, own-sent).
      const vaEventId = await insertWaEvent(client, dek, {
        twinId,
        companyId,
        seatId,
        chatJid: SELF_CHAT,
        senderJid: SELF_CHAT,
        fromMe: true,
        messageId: "3EB0-LOOP-VA",
        text: "va",
        quotedMessageId: "WAMID-LOOP-DRAFT",
      });
      await processPendingWaEvents(deps);

      // 5. The tap and its customer_send exist, bound to the raw event.
      const tap = await client.query(
        "SELECT minter, source_event_id FROM taps WHERE draft_id = $1",
        [draftId],
      );
      expect(tap.rows).toEqual([
        { minter: "affirmation_matcher", source_event_id: vaEventId },
      ]);
      const customerSend = await client.query<{ id: string }>(
        `SELECT id FROM send_commands
          WHERE twin_id = $1 AND send_class = 'customer_send' AND draft_id = $2`,
        [twinId, draftId],
      );
      expect(customerSend.rows).toHaveLength(1);

      // 6. The executor sends it and finalizes (simulated as above), and
      //    records what it sent into twin memory (ticket #63): WhatsApp
      //    never echoes the sending device's own message back to it, so the
      //    executor's own write-back is the only way the twin ever sees the
      //    half of the conversation the rep just released.
      await simulateExecutorPost(client, {
        commandId: customerSend.rows[0]!.id,
        twinId,
        waMessageId: "WAMID-LOOP-CUST",
        plane: { dek, selfJid: SELF_CHAT, companyId, seatId },
      });
      const ownSend = await client.query<{ payload_enc: Buffer }>(
        "SELECT payload_enc FROM wa_events WHERE twin_id = $1 AND external_event_id = $2",
        [twinId, `${CUSTOMER}:WAMID-LOOP-CUST`],
      );
      expect(ownSend.rows).toHaveLength(1);
      const sent = decodeWaMessagePayload(dek, ownSend.rows[0]!.payload_enc);
      expect([sent.fromMe, sent.text]).toEqual([true, DRAFT_TEXT]);

      // 7. The next pass posts the confirmation to the twin thread.
      await processResolvedSends(deps);
      const notice = await client.query<{ id: string; content_enc: Buffer }>(
        "SELECT id, content_enc FROM notices WHERE about_command_id = $1 AND kind = 'send_confirmation'",
        [customerSend.rows[0]!.id],
      );
      expect(notice.rows).toHaveLength(1);
      expect(
        Buffer.from(dek.decrypt(notice.rows[0]!.content_enc)).toString("utf8"),
        // Unbound chat, no push-name: number, marked provisional (#34).
      ).toBe("✳️ Enviado a 5215550001 (sin confirmar) ✓");
      const confirmationSend = await client.query(
        "SELECT destination, outcome FROM send_commands WHERE payload_ref = $1",
        [`notice:${notice.rows[0]!.id}`],
      );
      expect(confirmationSend.rows).toEqual([
        { destination: SELF_CHAT, outcome: null },
      ]);

      // 8. FR-70 over the corpus this loop just produced (slice AC 9):
      //    every outbound customer_send joins to its recorded tap.
      const report = await reconcileFr70(client);
      expect(report.customerSends).toBeGreaterThanOrEqual(1);
      expect(report.violations).toEqual([]);

      bundle.close();
    });
  });
});
