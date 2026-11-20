/**
 * Embeddings and retrieval across the primary Postgres seam (ticket #32,
 * spec #29 decisions 8–9): inject `wa_events`, assert vectors and
 * retrieval THROUGH the bundle API — never bundle SQL, never module
 * internals. Real Postgres, real envelope crypto, real SQLCipher
 * (ADR-0028); the embedder boundary carries the deterministic fake, so
 * every ranking is exactly assertable; the model is scripted at the model
 * boundary as in slice 1.
 *
 * The properties under test are the ticket's ACs: messages embed at
 * ingest; re-delivery and crash-replay never duplicate a vector
 * (composing with #31's message-id idempotence); the backlog batch path
 * embeds pre-existing un-embedded messages restart-safely; and a
 * retrieval query through the bundle API returns the most relevant
 * messages for a text query, scopeable to one chat.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KMSClient } from "@aws-sdk/client-kms";
import {
  createBundle,
  generateFixtureBundle,
  openTwinBundle,
  readSeedTranscript,
  type Bundle,
} from "@dito/bundle";
import {
  createDekFromMaterial,
  ensureTwinKey,
  type Dek,
} from "@dito/crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { embedMessageBacklog } from "./backlog.js";
import { processPendingWaEvents } from "./consumer.js";
import type { Embedder } from "./embedder.js";
import { retrieveRelevantMessages } from "./retrieval.js";
import {
  resetAndMigrate,
  withClient,
  TEST_AUDIT_HMAC_KEY,
} from "./testing/db.js";
import { removeTmpDir } from "./testing/tmp.js";
import { fakeEmbedder } from "./testing/fake-embedder.js";
import { neverSendLock } from "./testing/never-writer.js";
import { insertWaEvent } from "./testing/seam-fixtures.js";
import {
  closeScriptedModels,
  qaSilenceTurns,
  scriptedModel,
  type Script,
  type ScriptedTurn,
} from "./testing/scripted-model.js";
import { SETTLE_IMMEDIATELY } from "./testing/settle.js";
import { newExecutionPool } from "./testing/execution-pool.js";
import { isThreadTurn } from "./testing/thread-script.js";

// Every scripted model this suite opened is closed with it (#328).
afterAll(closeScriptedModels);

/** One connection source for every execution this suite runs (ticket #173). */
const executionPool = newExecutionPool();

const SELF_CHAT = "5215550000@s.whatsapp.net";
const CHAT = "5215550001@s.whatsapp.net";

/** One scripted no-answer decision (tool call + closing turn). */
function noAnswerTurns(): ScriptedTurn[] {
  return [
    { text: "" },
  ];
}

let tmp: string;

beforeAll(async () => {
  await resetAndMigrate();
  tmp = mkdtempSync(join(tmpdir(), "dito-embed-int-"));
});

afterAll(() => {
  removeTmpDir(tmp);
});

/** A fresh twin with its own real SQLCipher bundle under a local DEK. */
function freshTwin(): { twinId: string; dek: Dek; bundle: Bundle } {
  const twinId = randomUUID();
  const dek = createDekFromMaterial(randomBytes(32));
  const bundle = createBundle(join(tmp, `${twinId}.bundle`), dek);
  return { twinId, dek, bundle };
}

function depsFor(
  client: pg.Client,
  twin: { twinId: string; dek: Dek; bundle: Bundle },
  turns: Script,
  embedder: Embedder = fakeEmbedder(),
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
      executionPool,
      sendLock: neverSendLock(),
      hmacKey: TEST_AUDIT_HMAC_KEY,
      embedder,
    },
  };
}

describe("messages embed at ingest (ticket #32)", () => {
  it("a live in-scope seam event and a self-chat note both embed at ingest — the vectors land beside their messages and retrieval finds them through the bundle API", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await insertWaEvent(client, twin.dek, {
        twinId: twin.twinId,
        chatJid: CHAT,
        senderJid: CHAT,
        fromMe: false,
        messageId: "3EB0-EMB-1",
        text: "buenas, ¿tiene chile en polvo?",
        occurredAt: new Date("2026-08-27T14:03:00Z"),
      });
      // Twin memory is the whole conversation, both sides: the rep's own
      // self-chat note embeds too — it is the matcher's raw material AND
      // retrievable memory.
      await insertWaEvent(client, twin.dek, {
        twinId: twin.twinId,
        chatJid: SELF_CHAT,
        senderJid: SELF_CHAT,
        fromMe: true,
        messageId: "3EB0-EMB-2",
        text: "apuntar: 20 cajas para la sra garza",
        occurredAt: new Date("2026-08-27T14:04:00Z"),
      });

      // The self-chat note reaches a thread execution now that routing is
      // total (#35): a note-to-self is met with deliberate silence, which
      // changes nothing about the ingest and embedding this test is about.
      //
      // SCRIPTED PER CONVERSATION RATHER THAN AS ONE LIST (ticket #173). The
      // two executions of this pass — the thread's and the drafting one —
      // now INTERLEAVE on the realtime lane, so a flat list would hand
      // whichever asked first the turns meant for the other. A rule answers
      // each conversation from what it was SHOWN, which is what the rule form
      // exists for.
      const { deps } = depsFor(client, twin, (prompt) =>
        isThreadTurn(prompt) ? qaSilenceTurns() : noAnswerTurns(),
      );
      expect(await processPendingWaEvents(deps)).toEqual({
        processed: 2,
        drafted: 0,
      });

      // One vector per ingested message, inside the bundle.
      expect(twin.bundle.countMessageVectors()).toBe(2);
      expect(twin.bundle.listUnembeddedMessages(10)).toEqual([]);

      // And the memory is searchable: the fake embedder's word-overlap
      // vectors rank the chile question nearest the chile query.
      const [query] = await deps.embedder.embed(["¿tiene chile en polvo?"]);
      const hits = twin.bundle.searchMessages(query!, { limit: 1 });
      expect(hits.map((h) => h.message.messageId)).toEqual(["3EB0-EMB-1"]);
      twin.bundle.close();
    });
  });

  it("a re-delivered event (distinct external id, same message) yields exactly one vector — embedding composes with #31's message-id idempotence", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const note = {
        twinId: twin.twinId,
        chatJid: SELF_CHAT,
        senderJid: SELF_CHAT,
        fromMe: true,
        messageId: "3EB0-REDELIV-V1",
        text: "apuntar: 20 cajas para la sra garza",
        occurredAt: new Date("2026-08-27T15:00:00Z"),
      };
      await insertWaEvent(client, twin.dek, note);
      await insertWaEvent(client, twin.dek, {
        ...note,
        externalEventId: `${SELF_CHAT}:3EB0-REDELIV-V1:redelivery`,
      });

      // Both deliveries are unquoted self-chat text, so both reach the Q&A
      // call (#35 routing); a note-to-self is met with silence either time.
      const { deps } = depsFor(client, twin, [
        ...qaSilenceTurns(),
        ...qaSilenceTurns(),
      ]);
      expect(await processPendingWaEvents(deps)).toEqual({
        processed: 2,
        drafted: 0,
      });

      // One message, one vector: the second delivery resolved onto the
      // stored row and its vector — nothing doubled.
      expect(twin.bundle.readConversation(SELF_CHAT)).toHaveLength(1);
      expect(twin.bundle.countMessageVectors()).toBe(1);
      twin.bundle.close();
    });
  });

  it("a re-delivery carrying different text indexes the STORED text, never the losing text (Codex r2 — one bundle state, one index)", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const base = {
        twinId: twin.twinId,
        chatJid: SELF_CHAT,
        senderJid: SELF_CHAT,
        fromMe: true,
        messageId: "3EB0-CONFLICT-V1",
        occurredAt: new Date("2026-08-27T15:20:00Z"),
      };
      // The same WhatsApp message id delivered twice with DIFFERENT text
      // (the live/backfill overlap #33 will produce: normalization drift,
      // an edit, a re-render). First write wins in the message store.
      await insertWaEvent(client, twin.dek, {
        ...base,
        text: "apuntar: cotizar el flete del jueves",
      });
      await insertWaEvent(client, twin.dek, {
        ...base,
        externalEventId: `${SELF_CHAT}:3EB0-CONFLICT-V1:redelivery`,
        text: "mándame la ubicación de la bodega",
      });

      const { deps } = depsFor(client, twin, [
        ...qaSilenceTurns(),
        ...qaSilenceTurns(),
      ]);
      expect(await processPendingWaEvents(deps)).toEqual({
        processed: 2,
        drafted: 0,
      });

      // One message, one vector — and the vector indexes the text the
      // store actually holds: querying the stored text is an exact hit,
      // querying the losing text is not.
      const conversation = twin.bundle.readConversation(SELF_CHAT);
      expect(conversation).toHaveLength(1);
      expect(conversation[0]!.content).toBe(
        "apuntar: cotizar el flete del jueves",
      );
      expect(twin.bundle.countMessageVectors()).toBe(1);

      const storedHit = await retrieveRelevantMessages({
        bundle: twin.bundle,
        embedder: deps.embedder,
        query: "apuntar: cotizar el flete del jueves",
        limit: 1,
      });
      expect(storedHit[0]!.distance).toBeCloseTo(0, 5);
      const losingHit = await retrieveRelevantMessages({
        bundle: twin.bundle,
        embedder: deps.embedder,
        query: "mándame la ubicación de la bodega",
        limit: 1,
      });
      expect(losingHit[0]!.distance).toBeGreaterThan(0.5);
      twin.bundle.close();
    });
  });

  it("a crash between the message write and the vector write replays into exactly one vector — the un-embedded message finishes, nothing duplicates", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await insertWaEvent(client, twin.dek, {
        twinId: twin.twinId,
        chatJid: SELF_CHAT,
        senderJid: SELF_CHAT,
        fromMe: true,
        messageId: "3EB0-CRASH-V1",
        text: "apuntar: cotizar el flete",
        occurredAt: new Date("2026-08-27T15:10:00Z"),
      });

      // Pass 1 dies INSIDE the embedder — after the message's bundle
      // write, before its vector: the crash signature between the two
      // bundle writes.
      const dying: Embedder = {
        embed: () => Promise.reject(new Error("embedder killed mid-event")),
      };
      const killed = depsFor(client, twin, [], dying);
      await expect(processPendingWaEvents(killed.deps)).rejects.toThrow(
        "embedder killed mid-event",
      );
      expect(twin.bundle.readConversation(SELF_CHAT)).toHaveLength(1);
      expect(twin.bundle.countMessageVectors()).toBe(0);

      // Resume with a healthy embedder: the unmarked event replays, the
      // stored message takes its one vector, disposition lands.
      const resumed = depsFor(client, twin, qaSilenceTurns());
      expect(await processPendingWaEvents(resumed.deps)).toEqual({
        processed: 1,
        drafted: 0,
      });
      expect(twin.bundle.readConversation(SELF_CHAT)).toHaveLength(1);
      expect(twin.bundle.countMessageVectors()).toBe(1);
      const marks = await client.query(
        "SELECT disposition FROM wa_event_processing WHERE twin_id = $1",
        [twin.twinId],
      );
      // The note's outcome under #35 routing: the twin considered it and
      // held. (Pre-#35 this read 'captured' — unquoted self-chat text was
      // inert; it is twin input now.)
      expect(marks.rows).toEqual([{ disposition: "deliberate_silence" }]);
      twin.bundle.close();
    });
  });
});

describe("the backlog batch path (ticket #32)", () => {
  it("embeds a pre-existing backlog in batches — a run killed mid-batch resumes with nothing lost and nothing duplicated, and a finished backlog re-runs as a no-op", async () => {
    // A bundle holding un-embedded history through the one ingest path —
    // the shape the migrated slice-1 rig bundle wakes up in.
    const twin = freshTwin();
    const texts = [
      "¿tiene precio de mayoreo?",
      "le mando la lista en la tarde",
      "¿me aparta las 40 cajas?",
      "claro, se las aparto",
      "gracias, hasta el jueves",
    ];
    for (const [i, text] of texts.entries()) {
      twin.bundle.ingestMessage({
        chatJid: CHAT,
        messageId: `3EB0-BL-${i + 1}`,
        senderJid: CHAT,
        fromMe: i % 2 === 1,
        occurredAt: `2026-08-27T10:0${i}:00.000Z`,
        content: text,
      });
    }
    expect(twin.bundle.countMessageVectors()).toBe(0);
    expect(twin.bundle.listUnembeddedMessages(10)).toHaveLength(5);

    // The first run dies after one batch of 2 — some vectors written,
    // the rest still selectable.
    let batches = 0;
    const inner = fakeEmbedder();
    const dying: Embedder = {
      embed: (batch) => {
        batches += 1;
        if (batches > 1) {
          return Promise.reject(new Error("backlog killed mid-run"));
        }
        return inner.embed(batch);
      },
    };
    await expect(
      embedMessageBacklog({ bundle: twin.bundle, embedder: dying, batchSize: 2 }),
    ).rejects.toThrow("backlog killed mid-run");
    expect(twin.bundle.countMessageVectors()).toBe(2);

    // The resume embeds exactly the remainder (restart-safe: the
    // selection is "still un-embedded", so nothing repeats), and a
    // second full run finds nothing to do.
    expect(
      await embedMessageBacklog({
        bundle: twin.bundle,
        embedder: fakeEmbedder(),
        batchSize: 2,
      }),
    ).toEqual({ embedded: 3 });
    expect(twin.bundle.countMessageVectors()).toBe(5);
    expect(twin.bundle.listUnembeddedMessages(10)).toEqual([]);
    expect(
      await embedMessageBacklog({
        bundle: twin.bundle,
        embedder: fakeEmbedder(),
        batchSize: 2,
      }),
    ).toEqual({ embedded: 0 });

    // The backfilled memory is searchable — the mayoreo question is the
    // nearest hit for the mayoreo query.
    const [query] = await inner.embed(["¿tiene precio de mayoreo?"]);
    expect(
      twin.bundle
        .searchMessages(query!, { limit: 1 })
        .map((h) => h.message.messageId),
    ).toEqual(["3EB0-BL-1"]);
    twin.bundle.close();
  });
});

const skipKms = process.env["DITO_SKIP_KMS_TESTS"] === "1";

describe.skipIf(skipKms)(
  "embedding over the fixture-KMS bundle (ticket #32, ADR-0028 — the one reused fixture key)",
  () => {
    // The checked-in seed the fixture generator ships (bundle package).
    const SEED_PATH = new URL(
      "../../bundle/fixtures/seeds/rig-magic-loop.json",
      import.meta.url,
    ).pathname;
    const FIXTURE_TWIN_ID = "test-fixture";

    it("a slice-1-shaped fixture bundle under the real fixture key migrates at open, embeds its whole backlog, and answers a retrieval query", async () => {
      const kms = new KMSClient({});
      await ensureTwinKey(kms, FIXTURE_TWIN_ID);
      const fixture = await generateFixtureBundle({
        kms,
        twinId: FIXTURE_TWIN_ID,
        seedPath: SEED_PATH,
        outDir: tmp,
        atSchemaVersion: 2,
      });

      // The KMS-integrated open (the same path the rig takes): forward
      // migration in place, vector store born empty and retrieval-ready.
      const bundle = await openTwinBundle({
        kms,
        twinId: FIXTURE_TWIN_ID,
        wrappedDek: readFileSync(fixture.wrappedDekPath),
        path: fixture.bundlePath,
      });
      expect(bundle.countMessageVectors()).toBe(0);

      const seed = readSeedTranscript(SEED_PATH);
      const embedder = fakeEmbedder();
      expect(await embedMessageBacklog({ bundle, embedder })).toEqual({
        embedded: seed.rows.length,
      });
      expect(bundle.listUnembeddedMessages(seed.rows.length + 1)).toEqual([]);

      // Retrieval over the KMS-opened bundle: querying with one seed
      // row's own words makes that content the nearest hit in its chat
      // (identical text, identical fake vector — cosine distance ~0).
      const target = seed.rows[0]!;
      const hits = await retrieveRelevantMessages({
        bundle,
        embedder,
        query: target.content,
        chatJid: target.chatJid,
        limit: 1,
      });
      expect(hits.map((h) => h.message.content)).toEqual([target.content]);
      expect(hits[0]!.distance).toBeCloseTo(0, 4);
      bundle.close();
    });
  },
);

describe("retrieval for a text query (ticket #32 — the contract #35's Q&A tools consume)", () => {
  it("returns the most relevant messages for a text query in exact fake-embedder ranking, and a chat scope never admits another chat's globally-nearer message", async () => {
    await withClient(async (client) => {
      const OTHER_CHAT = "5215550002@s.whatsapp.net";
      const twin = freshTwin();
      const seam = [
        { chatJid: CHAT, messageId: "3EB0-RQ-A1", text: "necesito 40 cajas de chile para el jueves" },
        { chatJid: CHAT, messageId: "3EB0-RQ-A2", text: "gracias, buen día" },
        { chatJid: OTHER_CHAT, messageId: "3EB0-RQ-B1", text: "¿tiene cajas?" },
        { chatJid: OTHER_CHAT, messageId: "3EB0-RQ-B2", text: "mándame la ubicación" },
      ];
      for (const [i, event] of seam.entries()) {
        await insertWaEvent(client, twin.dek, {
          twinId: twin.twinId,
          chatJid: event.chatJid,
          senderJid: event.chatJid,
          fromMe: false,
          messageId: event.messageId,
          text: event.text,
          occurredAt: new Date(`2026-08-27T14:0${i}:00Z`),
        });
      }
      const { deps } = depsFor(client, twin, [
        ...noAnswerTurns(),
        ...noAnswerTurns(),
        ...noAnswerTurns(),
        ...noAnswerTurns(),
      ]);
      expect(await processPendingWaEvents(deps)).toEqual({
        processed: 4,
        drafted: 0,
      });

      // Global: word overlap orders the hits exactly — the chile order
      // first (6 shared words), the cajas question second (1), and the
      // no-overlap messages at cosine distance ~1 behind them.
      const global = await retrieveRelevantMessages({
        bundle: twin.bundle,
        embedder: deps.embedder,
        query: "cajas de chile para el jueves",
        limit: 2,
      });
      expect(global.map((h) => h.message.messageId)).toEqual([
        "3EB0-RQ-A1",
        "3EB0-RQ-B1",
      ]);
      expect(global[0]!.distance).toBeLessThan(global[1]!.distance);
      expect(global[0]!.message.content).toBe(
        "necesito 40 cajas de chile para el jueves",
      );

      // Chat-scoped: the same query inside OTHER_CHAT sees only that
      // chat's messages — the globally-nearest chile order (another
      // chat's) never leaks in.
      const scoped = await retrieveRelevantMessages({
        bundle: twin.bundle,
        embedder: deps.embedder,
        query: "cajas de chile para el jueves",
        chatJid: OTHER_CHAT,
        limit: 2,
      });
      expect(scoped.map((h) => h.message.messageId)).toEqual([
        "3EB0-RQ-B1",
        "3EB0-RQ-B2",
      ]);
      twin.bundle.close();
    });
  });
});
