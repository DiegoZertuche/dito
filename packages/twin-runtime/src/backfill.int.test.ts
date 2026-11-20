/**
 * History-sync backfill through the twin's one ingest path (ticket #33,
 * spec #29 decisions 5–6), tested across the primary Postgres seam: inject
 * backfill-marked `wa_events` (sealed exactly as the plane's history
 * normalization seals them), assert bundle contents THROUGH the bundle API
 * plus dispositions — never bundle SQL, never module internals. Real
 * Postgres, real envelope crypto, real SQLCipher (ADR-0028); the model is
 * scripted at the model boundary.
 *
 * The properties under test are the ticket's ACs: backfill-marked events
 * route to ingest ONLY — an otherwise-draftable customer inbound mints no
 * draft, no post, no send command, and a historical quoted «va» never
 * reaches the matcher; a constructed history batch lands as bundle
 * message-store rows readable via the bundle API (push-name included);
 * re-delivered history produces no duplicate bundle rows, and the
 * message-id rule holds across live/backfill overlap.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBundle, type Bundle } from "@dito/bundle";
import { createDekFromMaterial, type Dek } from "@dito/crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { processPendingWaEvents } from "./consumer.js";
import {
  resetAndMigrate,
  withClient,
  TEST_AUDIT_HMAC_KEY,
} from "./testing/db.js";
import { retrieveRelevantMessages } from "./retrieval.js";
import { removeTmpDir } from "./testing/tmp.js";
import { fakeEmbedder } from "./testing/fake-embedder.js";
import { neverSendLock } from "./testing/never-writer.js";
import { insertWaEvent } from "./testing/seam-fixtures.js";
import { closeScriptedModels, scriptedModel, type ScriptedTurn } from "./testing/scripted-model.js";
import { SETTLE_IMMEDIATELY } from "./testing/settle.js";
import { newExecutionPool } from "./testing/execution-pool.js";

// Every scripted model this suite opened is closed with it (#328).
afterAll(closeScriptedModels);

/** One connection source for every execution this suite runs (ticket #173). */
const executionPool = newExecutionPool();

const SELF_CHAT = "5215550000@s.whatsapp.net";
const CHAT = "5215550021@s.whatsapp.net";
const DRAFT_TEXT = "claro, se las mando el jueves temprano";

function draftingTurns(needsAnswer: boolean): ScriptedTurn[] {
  return needsAnswer
    ? [
        { toolCall: { name: "create_draft", input: { text: DRAFT_TEXT } } },
        { text: "done" },
      ]
    : [{ text: "" }];
}

let tmp: string;

beforeAll(async () => {
  await resetAndMigrate();
  tmp = mkdtempSync(join(tmpdir(), "dito-backfill-int-"));
});

afterAll(() => {
  removeTmpDir(tmp);
});

function freshTwin(): { twinId: string; dek: Dek; bundle: Bundle } {
  const twinId = randomUUID();
  const dek = createDekFromMaterial(randomBytes(32));
  const bundle = createBundle(join(tmp, `${twinId}.bundle`), dek);
  return { twinId, dek, bundle };
}

function depsFor(
  client: pg.Client,
  twin: { twinId: string; dek: Dek; bundle: Bundle },
  turns: readonly ScriptedTurn[],
) {
  const { harness, requests } = scriptedModel(turns);
  return {
    requests,
    deps: {
      db: client,
      harness,
      bundle: twin.bundle,
      dek: twin.dek,
      twinId: twin.twinId,
      selfChatJid: SELF_CHAT,
      // Ticket #75: this suite is not about batching (see testing/settle.ts).
      ...SETTLE_IMMEDIATELY,
      drafting: { model: "claude-sonnet-5" },
      embedder: fakeEmbedder(),
      executionPool,
      sendLock: neverSendLock(),
      hmacKey: TEST_AUDIT_HMAC_KEY,
    },
  };
}

async function countRows(
  client: pg.Client,
  table: string,
  twinId: string,
): Promise<number> {
  const res = await client.query(
    `SELECT count(*)::int AS n FROM ${table} WHERE twin_id = $1`,
    [twinId],
  );
  return res.rows[0].n;
}

describe("history-sync backfill through the one ingest path (ticket #33)", () => {
  it("a planted backfill batch routes to ingest only: the otherwise-draftable inbound mints no draft, no post, no send command — and a historical «va» never reaches the matcher", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      // A month-old exchange, backfill-marked as the plane's history
      // normalization stamps it: a customer inbound that WOULD draft were
      // it live, the rep's own reply, and — the sharpest edge — the rep's
      // own historical quoted «va» in the self-chat, which must never
      // reach the matcher.
      await insertWaEvent(client, twin.dek, {
        twinId: twin.twinId,
        chatJid: CHAT,
        senderJid: CHAT,
        fromMe: false,
        messageId: "3EB0-BFI-1",
        text: "¿me mandas 40 cajas para el jueves?",
        pushName: "Sra. Garza",
        backfill: true,
        occurredAt: new Date("2026-07-20T10:42:00Z"),
      });
      await insertWaEvent(client, twin.dek, {
        twinId: twin.twinId,
        chatJid: CHAT,
        senderJid: SELF_CHAT,
        fromMe: true,
        messageId: "3EB0-BFI-2",
        text: "claro, el jueves se las llevo",
        backfill: true,
        occurredAt: new Date("2026-07-20T10:45:00Z"),
      });
      await insertWaEvent(client, twin.dek, {
        twinId: twin.twinId,
        chatJid: SELF_CHAT,
        senderJid: SELF_CHAT,
        fromMe: true,
        messageId: "3EB0-BFI-3",
        text: "va",
        quotedMessageId: "3EB0-OLD-DRAFT",
        backfill: true,
        occurredAt: new Date("2026-07-21T09:00:00Z"),
      });

      // No scripted turns: backfill must never call the model.
      const { deps, requests } = depsFor(client, twin, []);
      expect(await processPendingWaEvents(deps)).toEqual({
        processed: 3,
        drafted: 0,
      });
      expect(requests).toHaveLength(0);

      // Nothing minted, anywhere: backfill never drafts (decision 6).
      expect(await countRows(client, "drafts", twin.twinId)).toBe(0);
      expect(await countRows(client, "send_commands", twin.twinId)).toBe(0);
      expect(await countRows(client, "notices", twin.twinId)).toBe(0);
      const taps = await client.query(
        "SELECT count(*)::int AS n FROM taps t JOIN drafts d ON d.id = t.draft_id WHERE d.twin_id = $1",
        [twin.twinId],
      );
      expect(taps.rows[0].n).toBe(0);

      // Dispositions record backfill ingestion — every delivery.
      const marks = await client.query(
        "SELECT disposition FROM wa_event_processing WHERE twin_id = $1",
        [twin.twinId],
      );
      expect(marks.rows).toEqual([
        { disposition: "backfill_ingested" },
        { disposition: "backfill_ingested" },
        { disposition: "backfill_ingested" },
      ]);

      // End-to-end at the seam: the history lands as bundle message-store
      // rows readable via the bundle API — push-name where the blob
      // carried one, absent where it didn't.
      expect(twin.bundle.readConversation(CHAT)).toEqual([
        {
          chatJid: CHAT,
          messageId: "3EB0-BFI-1",
          senderJid: CHAT,
          fromMe: false,
          occurredAt: "2026-07-20T10:42:00.000Z",
          content: "¿me mandas 40 cajas para el jueves?",
          pushName: "Sra. Garza",
        },
        {
          chatJid: CHAT,
          messageId: "3EB0-BFI-2",
          senderJid: SELF_CHAT,
          fromMe: true,
          occurredAt: "2026-07-20T10:45:00.000Z",
          content: "claro, el jueves se las llevo",
        },
      ]);
      expect(
        twin.bundle.readConversation(SELF_CHAT).map((r) => r.messageId),
      ).toEqual(["3EB0-BFI-3"]);

      // Ingest mints no bindings — the #31 rule holds for the backfill feed
      // too; the ceremony is the rep's, never history's.
      expect(twin.bundle.listChatBindings()).toEqual([]);
      // …but at the #35 integration a vector now accompanies every ingested
      // message, on BOTH feeds. #33 wrote `toBe(0)` because #32 was not in
      // its history; the integrated truth is one vector per backfilled
      // message — memory the twin can actually retrieve (proven searchable
      // in "backfilled history is retrievable" below).
      expect(twin.bundle.countMessageVectors()).toBe(3);
      twin.bundle.close();
    });
  });

  it("the message-id rule holds across live/backfill overlap: a live-drafted message re-delivered as history stores once and re-drafts nothing", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      // Live first: the customer's message arrives and drafts, as today.
      await insertWaEvent(client, twin.dek, {
        twinId: twin.twinId,
        chatJid: CHAT,
        senderJid: CHAT,
        fromMe: false,
        messageId: "3EB0-OVL-1",
        text: "¿me lo aparta?",
        occurredAt: new Date("2026-08-27T09:30:00Z"),
      });
      const live = depsFor(client, twin, draftingTurns(true));
      expect(await processPendingWaEvents(live.deps)).toEqual({
        processed: 1,
        drafted: 1,
      });

      // Then the history blob overlaps it: the same (chat, message id)
      // arrives backfill-marked under a DISTINCT external event id — the
      // re-delivery signature the seam's dedupe cannot catch — plus one
      // genuinely older message.
      await insertWaEvent(client, twin.dek, {
        twinId: twin.twinId,
        chatJid: CHAT,
        senderJid: CHAT,
        fromMe: false,
        messageId: "3EB0-OVL-1",
        text: "¿me lo aparta?",
        backfill: true,
        occurredAt: new Date("2026-08-27T09:30:00Z"),
        externalEventId: `${CHAT}:3EB0-OVL-1:history`,
      });
      await insertWaEvent(client, twin.dek, {
        twinId: twin.twinId,
        chatJid: CHAT,
        senderJid: CHAT,
        fromMe: false,
        messageId: "3EB0-OVL-0",
        text: "mensaje más viejo",
        backfill: true,
        occurredAt: new Date("2026-08-27T08:30:00Z"),
      });

      const backfill = depsFor(client, twin, []);
      expect(await processPendingWaEvents(backfill.deps)).toEqual({
        processed: 2,
        drafted: 0,
      });
      expect(backfill.requests).toHaveLength(0);

      // One bundle row per WhatsApp message — the overlap stored nothing
      // twice; the older message joined the store.
      expect(
        twin.bundle
          .readConversation(CHAT)
          .map((r) => r.messageId)
          .sort(),
      ).toEqual(["3EB0-OVL-0", "3EB0-OVL-1"]);

      // Exactly the live draft exists — the overlap re-drafted nothing.
      expect(await countRows(client, "drafts", twin.twinId)).toBe(1);
      const marks = await client.query(
        "SELECT disposition, count(*)::int AS n FROM wa_event_processing WHERE twin_id = $1 GROUP BY disposition ORDER BY disposition",
        [twin.twinId],
      );
      expect(marks.rows).toEqual([
        { disposition: "backfill_ingested", n: 2 },
        { disposition: "drafted", n: 1 },
      ]);
      twin.bundle.close();
    });
  });

  it("backfill ingest is restart-safe and idempotent: a re-delivered batch stores nothing twice and disposes every delivery", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const batch = [
        {
          messageId: "3EB0-RSF-1",
          text: "¿abren el domingo?",
          occurredAt: new Date("2026-08-15T11:00:00Z"),
        },
        {
          messageId: "3EB0-RSF-2",
          text: "sí, hasta las 2",
          occurredAt: new Date("2026-08-15T11:05:00Z"),
        },
      ];
      for (const msg of batch) {
        await insertWaEvent(client, twin.dek, {
          twinId: twin.twinId,
          chatJid: CHAT,
          senderJid: CHAT,
          fromMe: false,
          backfill: true,
          ...msg,
        });
      }
      const first = depsFor(client, twin, []);
      expect(await processPendingWaEvents(first.deps)).toEqual({
        processed: 2,
        drafted: 0,
      });

      // A restart re-syncs and the plane re-delivers the same history
      // under fresh external ids; the runtime resumes and must land every
      // message on its already-stored row.
      for (const msg of batch) {
        await insertWaEvent(client, twin.dek, {
          twinId: twin.twinId,
          chatJid: CHAT,
          senderJid: CHAT,
          fromMe: false,
          backfill: true,
          ...msg,
          externalEventId: `${CHAT}:${msg.messageId}:resync`,
        });
      }
      const resumed = depsFor(client, twin, []);
      expect(await processPendingWaEvents(resumed.deps)).toEqual({
        processed: 2,
        drafted: 0,
      });

      expect(
        twin.bundle.readConversation(CHAT).map((r) => r.messageId),
      ).toEqual(["3EB0-RSF-1", "3EB0-RSF-2"]);
      const marks = await client.query(
        "SELECT count(*)::int AS n FROM wa_event_processing WHERE twin_id = $1 AND disposition = 'backfill_ingested'",
        [twin.twinId],
      );
      expect(marks.rows[0].n).toBe(4);
      twin.bundle.close();
    });
  });

  // The #35 integration's cross-ticket wiring (#32 × #33). #33's backfill
  // was built with #32 absent from its history, so nothing here was ever
  // proven end to end: a history batch that ingests but never embeds is
  // memory the twin cannot retrieve — the slice's whole artifact
  // («¿qué me pidió X la semana pasada?») answers from BACKFILLED history.
  describe("backfilled history is retrievable (#32 × #33 integration)", () => {
    it("a backfilled history batch ends up searchable through the retrieval API — one vector per message, ranked by relevance", async () => {
      await withClient(async (client) => {
        const twin = freshTwin();
        const history: readonly [string, string][] = [
          ["3EB0-RET-1", "buenas, ¿tiene chile en polvo?"],
          ["3EB0-RET-2", "necesito 40 cajas para el jueves"],
          ["3EB0-RET-3", "gracias, quedamos así"],
        ];
        for (const [messageId, text] of history) {
          await insertWaEvent(client, twin.dek, {
            twinId: twin.twinId,
            chatJid: CHAT,
            senderJid: CHAT,
            fromMe: false,
            messageId,
            text,
            pushName: "Sra. Garza",
            backfill: true,
            occurredAt: new Date("2026-07-15T10:00:00Z"),
          });
        }

        const { deps, requests } = depsFor(client, twin, []);
        expect(await processPendingWaEvents(deps)).toEqual({
          processed: 3,
          drafted: 0,
        });
        // Still no drafting — retrievability costs the past nothing.
        expect(requests).toHaveLength(0);
        expect(twin.bundle.countMessageVectors()).toBe(3);

        // The artifact's shape: a question in the rep's own words finds the
        // backfilled message, through the retrieval contract #35's Q&A uses.
        const hits = await retrieveRelevantMessages({
          bundle: twin.bundle,
          embedder: deps.embedder,
          query: "cajas para el jueves",
          limit: 3,
        });
        expect(hits[0]?.message.messageId).toBe("3EB0-RET-2");
        expect(hits[0]?.message.content).toBe(
          "necesito 40 cajas para el jueves",
        );
        // Scoping to the chat holds over history exactly as over live rows.
        const scoped = await retrieveRelevantMessages({
          bundle: twin.bundle,
          embedder: deps.embedder,
          query: "cajas para el jueves",
          chatJid: CHAT,
        });
        expect(scoped.map((h) => h.message.messageId)).toContain("3EB0-RET-2");
        twin.bundle.close();
      });
    });

    it("backfill embeds the STORED content, never its own row: a history re-delivery carrying different text leaves the winning row searchable by its own words", async () => {
      await withClient(async (client) => {
        const twin = freshTwin();
        // Live wins the store: this text is what the bundle holds.
        await insertWaEvent(client, twin.dek, {
          twinId: twin.twinId,
          chatJid: CHAT,
          senderJid: CHAT,
          fromMe: false,
          messageId: "3EB0-DUP-1",
          text: "necesito 40 cajas para el jueves",
          occurredAt: new Date("2026-08-27T09:30:00Z"),
        });
        const live = depsFor(client, twin, draftingTurns(true));
        expect(await processPendingWaEvents(live.deps)).toEqual({
          processed: 1,
          drafted: 1,
        });

        // The history blob re-delivers the SAME WhatsApp message id under a
        // distinct external event id, carrying different text (an edit, a
        // truncation — the rail is not obliged to agree with itself). The
        // store's first write wins, so the losing text must never become
        // the index: embedding reads IngestResult.content, not this row.
        await insertWaEvent(client, twin.dek, {
          twinId: twin.twinId,
          chatJid: CHAT,
          senderJid: CHAT,
          fromMe: false,
          messageId: "3EB0-DUP-1",
          text: "pagaré con transferencia bancaria",
          backfill: true,
          occurredAt: new Date("2026-08-27T09:30:00Z"),
          externalEventId: `${CHAT}:3EB0-DUP-1:history`,
        });
        const backfill = depsFor(client, twin, []);
        expect(await processPendingWaEvents(backfill.deps)).toEqual({
          processed: 1,
          drafted: 0,
        });

        // One row, one vector — and the vector belongs to the stored text.
        expect(twin.bundle.readConversation(CHAT)).toHaveLength(1);
        expect(twin.bundle.countMessageVectors()).toBe(1);
        const own = await retrieveRelevantMessages({
          bundle: twin.bundle,
          embedder: backfill.deps.embedder,
          query: "cajas para el jueves",
        });
        expect(own[0]?.message.content).toBe("necesito 40 cajas para el jueves");
        // The losing delivery's words index nothing: were the vector minted
        // from this event's own row, the stored message would rank nearest
        // to a query it does not contain a single word of.
        const loser = await retrieveRelevantMessages({
          bundle: twin.bundle,
          embedder: backfill.deps.embedder,
          query: "pagaré con transferencia bancaria",
        });
        expect(loser[0]?.distance).toBeGreaterThan(own[0]!.distance);
        twin.bundle.close();
      });
    });
  });
});
