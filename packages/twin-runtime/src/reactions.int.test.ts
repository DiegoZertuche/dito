/**
 * The runtime speaks 'reaction' (ticket #97; ADR-0041). A 👍 is the most
 * common way a rep says yes on WhatsApp, and until this ticket the seam
 * type that carries one was the canonical POISON ROW — a row the runtime
 * refused, which is why the deploy order is the runtime first and the
 * plane (#100) after.
 *
 * Tested across the pre-agreed Postgres seam (spec #18, spec #96): inject
 * `wa_events` reaction rows with real DEK-encrypted payloads, assert what
 * the consumer did with them, what the model was SHOWN, and — the negative
 * that matters most — what was NOT minted. The model is scripted at the
 * model boundary; a suite that scripts no turn fails loudly on any
 * model call, which is how "a reaction never triggers a draft" is asserted
 * rather than assumed. Crypto is real throughout (ADR-0028).
 *
 * Governing ADRs: 0041 (reactions are typed seam events), 0006 (the two
 * non-model tap minters — a reaction is neither), 0037 (the twin composes;
 * no reaction microcopy), 0033 (the twin thread stays twin-side).
 */
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBundle, type Bundle } from "@dito/bundle";
import { createDekFromMaterial, type Dek } from "@dito/crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { processPendingWaEvents, type TwinRuntimeDeps } from "./consumer.js";
import {
  CONSERVATIVE_DEV_PACING,
  createSendLockWriter,
} from "./send-lock/writer.js";
import {
  resetAndMigrate,
  withClient,
  TEST_AUDIT_HMAC_KEY,
  TEST_DATABASE_URL,
} from "./testing/db.js";
import { removeTmpDir } from "./testing/tmp.js";
import { fakeEmbedder } from "./testing/fake-embedder.js";
import { neverSendLock } from "./testing/never-writer.js";
import {
  insertWaEvent,
  insertWaReaction,
  simulateExecutorPost,
} from "./testing/seam-fixtures.js";
import {
  closeScriptedModels,
  qaSilenceTurns,
  scriptedModel,
  type ScriptedTurn,
  promptOf,
} from "./testing/scripted-model.js";
import { SETTLE_IMMEDIATELY } from "./testing/settle.js";
import { newExecutionPool } from "./testing/execution-pool.js";

// Every scripted model this suite opened is closed with it (#328).
afterAll(closeScriptedModels);

/** One connection source for every execution this suite runs (ticket #173). */
const executionPool = newExecutionPool();

const SELF_CHAT = "5215550000@s.whatsapp.net";
const CHAT = "5215550001@s.whatsapp.net";
const ASK = "¿me mandas 20 bultos?";
const DRAFT_TEXT = "claro, van 20 bultos";

let tmp: string;
let pool: pg.Pool;

beforeAll(async () => {
  await resetAndMigrate();
  tmp = mkdtempSync(join(tmpdir(), "dito-reactions-int-"));
  pool = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 4 });
});

afterAll(async () => {
  await pool.end();
  removeTmpDir(tmp);
});

interface Twin {
  readonly twinId: string;
  readonly dek: Dek;
  readonly bundle: Bundle;
}

function freshTwin(): Twin {
  const twinId = randomUUID();
  const dek = createDekFromMaterial(randomBytes(32));
  const bundle = createBundle(join(tmp, `${twinId}.bundle`), dek);
  return { twinId, dek, bundle };
}

function depsFor(
  client: pg.Client,
  twin: Twin,
  turns: readonly ScriptedTurn[] = [],
  options: { live?: boolean; historyLimit?: number } = {},
): { deps: TwinRuntimeDeps; requests: Record<string, unknown>[] } {
  const { harness, requests } = scriptedModel(turns);
  return {
    requests,
    deps: {
      // Narrowing the RECENT window is how a suite pushes a row out of the
      // transcript and into the retrieved block, which is a different
      // reader with a different order (#109).
      ...(options.historyLimit === undefined
        ? {}
        : { historyLimit: options.historyLimit }),
      db: client,
      harness,
      bundle: twin.bundle,
      dek: twin.dek,
      twinId: twin.twinId,
      selfChatJid: SELF_CHAT,
      // This suite is not about batching (ticket #75, testing/settle.ts).
      ...SETTLE_IMMEDIATELY,
      drafting: { model: "claude-sonnet-5" },
      embedder: fakeEmbedder(),
      executionPool,
      sendLock: (options.live ?? false)
        ? createSendLockWriter({ pool, hmacKey: TEST_AUDIT_HMAC_KEY })
        : neverSendLock(),
      hmacKey: TEST_AUDIT_HMAC_KEY,
    },
  };
}

/** One scripted needs-answer decision (tool call + closing turn). */
function draftingTurns(): ScriptedTurn[] {
  return [
    { toolCall: { name: "create_draft", input: { text: DRAFT_TEXT } } },
    { text: "done" },
  ];
}

/** Seeds the writer's config so a tap COULD mint — the negatives mean more when it could. */
async function seedSendConfig(client: pg.Client, twinId: string): Promise<void> {
  await client.query(
    "INSERT INTO send_allowlist (twin_id, destination_jid) VALUES ($1, $2)",
    [twinId, CHAT],
  );
  await client.query(
    `INSERT INTO pacing_thresholds (twin_id, max_sends_per_hour, min_seconds_between_sends)
     VALUES ($1, $2, $3)`,
    [
      twinId,
      CONSERVATIVE_DEV_PACING.maxSendsPerHour,
      CONSERVATIVE_DEV_PACING.minSecondsBetweenSends,
    ],
  );
}

async function dispositionOf(
  client: pg.Client,
  eventId: string,
): Promise<string | undefined> {
  const res = await client.query<{ disposition: string }>(
    "SELECT disposition FROM wa_event_processing WHERE event_id = $1",
    [eventId],
  );
  return res.rows[0]?.disposition;
}

/**
 * The customer's ask, already in twin memory: the beat a 👍 will answer.
 * Its message id is per-call — `external_event_id` is globally unique at
 * the seam and every test here shares the one CHAT jid.
 */
async function seedAsk(
  client: pg.Client,
  twin: Twin,
): Promise<{ eventId: string; messageId: string }> {
  const messageId = `3EB0-ASK-${randomUUID()}`;
  const eventId = await insertWaEvent(client, twin.dek, {
    twinId: twin.twinId,
    chatJid: CHAT,
    senderJid: CHAT,
    fromMe: false,
    messageId,
    text: ASK,
    pushName: "Sra. Garza",
    occurredAt: new Date("2026-08-31T15:00:00Z"),
  });
  const { deps } = depsFor(client, twin, draftingTurns());
  await processPendingWaEvents(deps);
  return { eventId, messageId };
}

describe("a customer-chat reaction: context yes, trigger no (ADR-0041)", () => {
  it("is consumed rather than refused — the runtime speaks 'reaction' before any plane emits one", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const ask = await seedAsk(client, twin);

      const reactionId = await insertWaReaction(client, twin.dek, {
        twinId: twin.twinId,
        chatJid: CHAT,
        senderJid: CHAT,
        fromMe: false,
        messageId: `3EB0-RX-1-${randomUUID()}`,
        reactionTo: ask.messageId,
        emoji: "👍",
        pushName: "Sra. Garza",
        occurredAt: new Date("2026-08-31T15:01:00Z"),
      });

      // No scripted turn at all: any model call is a loud failure, which
      // is what makes "never triggers a draft" an assertion rather than a
      // hope.
      const { deps, requests } = depsFor(client, twin);
      expect(await processPendingWaEvents(deps)).toEqual({
        processed: 1,
        drafted: 0,
      });
      expect(requests).toHaveLength(0);
      expect(await dispositionOf(client, reactionId)).toBe("captured");
      expect(
        (await client.query("SELECT id FROM drafts WHERE twin_id = $1", [
          twin.twinId,
        ])).rows,
      ).toHaveLength(1); // the seeded ask's draft, and no second one

      twin.bundle.close();
    });
  });

  it("joins twin memory as a gesture at its target, with the target's own words read back from the store", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const ask = await seedAsk(client, twin);
      await insertWaReaction(client, twin.dek, {
        twinId: twin.twinId,
        chatJid: CHAT,
        senderJid: CHAT,
        fromMe: false,
        messageId: `3EB0-RX-2-${randomUUID()}`,
        reactionTo: ask.messageId,
        emoji: "👍",
        occurredAt: new Date("2026-08-31T15:01:00Z"),
      });

      const { deps } = depsFor(client, twin);
      await processPendingWaEvents(deps);

      const conversation = twin.bundle.readConversation(CHAT);
      expect(conversation.map((row) => row.content)).toEqual([
        ASK,
        `[reacción 👍 a: «${ASK}»]`,
      ]);
      twin.bundle.close();
    });
  });

  it("a set, a change and a removal each land as their own beat, in order — nothing folds, and a retraction stays visible as a retraction", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const ask = await seedAsk(client, twin);
      const gestures: [string, string, string][] = [
        [`3EB0-RX-SET-${randomUUID()}`, "👍", "2026-08-31T15:01:00Z"],
        [`3EB0-RX-CHANGE-${randomUUID()}`, "❤️", "2026-08-31T15:02:00Z"],
        [`3EB0-RX-REMOVE-${randomUUID()}`, "", "2026-08-31T15:03:00Z"],
      ];
      for (const [messageId, emoji, at] of gestures) {
        await insertWaReaction(client, twin.dek, {
          twinId: twin.twinId,
          chatJid: CHAT,
          senderJid: CHAT,
          fromMe: false,
          messageId,
          reactionTo: ask.messageId,
          emoji,
          occurredAt: new Date(at),
        });
      }

      const { deps } = depsFor(client, twin);
      expect(await processPendingWaEvents(deps)).toEqual({
        processed: 3,
        drafted: 0,
      });

      expect(
        twin.bundle.readConversation(CHAT).map((row) => row.content),
      ).toEqual([
        ASK,
        `[reacción 👍 a: «${ASK}»]`,
        `[reacción ❤️ a: «${ASK}»]`,
        `[reacción retirada de: «${ASK}»]`,
      ]);
      twin.bundle.close();
    });
  });

  it("a gesture at a message twin memory never captured still lands — named as a gesture, with nothing invented for its target", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await insertWaReaction(client, twin.dek, {
        twinId: twin.twinId,
        chatJid: CHAT,
        senderJid: CHAT,
        fromMe: false,
        messageId: `3EB0-RX-ORPHAN-${randomUUID()}`,
        reactionTo: `3EB0-BEFORE-THE-QR-CODE-${randomUUID()}`,
        emoji: "👍",
      });

      const { deps } = depsFor(client, twin);
      expect(await processPendingWaEvents(deps)).toEqual({
        processed: 1,
        drafted: 0,
      });

      expect(
        twin.bundle.readConversation(CHAT).map((row) => row.content),
      ).toEqual(["[reacción 👍]"]);
      twin.bundle.close();
    });
  });

  it("a backfilled reaction routes to ingest only, like all backfill", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const reactionId = await insertWaReaction(client, twin.dek, {
        twinId: twin.twinId,
        chatJid: CHAT,
        senderJid: CHAT,
        fromMe: false,
        messageId: `3EB0-RX-HISTORY-${randomUUID()}`,
        reactionTo: `3EB0-OLD-${randomUUID()}`,
        emoji: "👍",
        backfill: true,
      });

      const { deps } = depsFor(client, twin);
      expect(await processPendingWaEvents(deps)).toEqual({
        processed: 1,
        drafted: 0,
      });
      expect(await dispositionOf(client, reactionId)).toBe("backfill_ingested");
      expect(twin.bundle.readConversation(CHAT)).toHaveLength(1);
      twin.bundle.close();
    });
  });
});

describe("the reaction reaches the model as a gesture, never as speech", () => {
  it("the drafting call shows the gesture in the transcript, at its target", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      // The customer asks, the rep is slow, the customer 👍s their own
      // earlier line, then asks again: the second ask is the turn, the
      // gesture is context.
      const ask = await seedAsk(client, twin);
      await insertWaReaction(client, twin.dek, {
        twinId: twin.twinId,
        chatJid: CHAT,
        senderJid: CHAT,
        fromMe: false,
        messageId: `3EB0-RX-3-${randomUUID()}`,
        reactionTo: ask.messageId,
        emoji: "👍",
        occurredAt: new Date("2026-08-31T15:01:00Z"),
      });
      await insertWaEvent(client, twin.dek, {
        twinId: twin.twinId,
        chatJid: CHAT,
        senderJid: CHAT,
        fromMe: false,
        messageId: `3EB0-ASK-2-${randomUUID()}`,
        text: "¿y el flete?",
        occurredAt: new Date("2026-08-31T15:02:00Z"),
      });

      const { deps, requests } = depsFor(client, twin, draftingTurns());
      expect(await processPendingWaEvents(deps)).toEqual({
        processed: 2,
        drafted: 1,
      });

      const turn = userTurnOf(requests);
      expect(turn).toContain(`counterparty: [reacción 👍 a: «${ASK}»]`);
      twin.bundle.close();
    });
  });

  it("shows two beats of ONE SECOND in delivery order: a removal delivered first never precedes the 👍 it retracts (#109)", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const ask = await seedAsk(client, twin);

      // The customer taps 👍 and takes it back a fifth of a second later.
      // The rail's stanza timestamp is WHOLE SECONDS, so both rows carry the
      // same instant; the seam received them the wrong way round, so the
      // row ids say the opposite of what happened.
      const SAME_SECOND = new Date("2026-08-31T15:01:00Z");
      for (const [emoji, offsetMs] of [
        ["", 200],
        ["👍", 0],
      ] as const) {
        await insertWaReaction(client, twin.dek, {
          twinId: twin.twinId,
          chatJid: CHAT,
          senderJid: CHAT,
          fromMe: false,
          messageId: `3EB0-RX-TIE-${randomUUID()}`,
          reactionTo: ask.messageId,
          emoji,
          occurredAt: SAME_SECOND,
          senderTsMs: SAME_SECOND.getTime() + offsetMs,
        });
      }
      await insertWaEvent(client, twin.dek, {
        twinId: twin.twinId,
        chatJid: CHAT,
        senderJid: CHAT,
        fromMe: false,
        messageId: `3EB0-ASK-2-${randomUUID()}`,
        text: "¿y el flete?",
        occurredAt: new Date("2026-08-31T15:02:00Z"),
      });

      const { deps, requests } = depsFor(client, twin, draftingTurns());
      expect(await processPendingWaEvents(deps)).toEqual({
        processed: 3,
        drafted: 1,
      });

      // What the MODEL is shown: the 👍, then its retraction. Inverted, the
      // transcript would say the customer confirmed last.
      const gestures = userTurnOf(requests)
        .split("\n")
        .filter((line) => line.includes("reacción"));
      expect(gestures).toEqual([
        `counterparty: [reacción 👍 a: «${ASK}»]`,
        `counterparty: [reacción retirada de: «${ASK}»]`,
      ]);
      twin.bundle.close();
    });
  });

  it("the Q&A call can retrieve one: «¿ya confirmó?» is answerable when the confirmation was a 👍", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const ask = await seedAsk(client, twin);
      await insertWaReaction(client, twin.dek, {
        twinId: twin.twinId,
        chatJid: CHAT,
        senderJid: CHAT,
        fromMe: false,
        messageId: `3EB0-RX-4-${randomUUID()}`,
        reactionTo: ask.messageId,
        emoji: "👍",
        occurredAt: new Date("2026-08-31T15:01:00Z"),
      });
      await processPendingWaEvents(depsFor(client, twin).deps);

      // The rep asks the twin about it, in their own thread.
      await insertWaEvent(client, twin.dek, {
        twinId: twin.twinId,
        chatJid: SELF_CHAT,
        senderJid: SELF_CHAT,
        fromMe: true,
        messageId: `3EB0-Q-1-${randomUUID()}`,
        text: "¿ya confirmó la Sra. Garza los 20 bultos?",
        occurredAt: new Date("2026-08-31T16:00:00Z"),
      });

      const { deps, requests } = depsFor(client, twin, [
        {
          toolCall: {
            name: "search_memory",
            input: { about: "confirmó 20 bultos", counterparty: null },
          },
        },
        { text: "sí, te lo confirmó con un 👍" },
      ]);
      await processPendingWaEvents(deps);

      // The retrieval tool's own result, as the model read it: the gesture
      // is retrievable, and it reads as a gesture at its target.
      const served = JSON.stringify(requests[1]);
      expect(served).toContain("reacci");
      expect(served).toContain(ASK);
      twin.bundle.close();
    });
  });

  it("orders same-second beats in drafting's RETRIEVED block too, where the rank is by distance (#109)", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const ask = await seedAsk(client, twin);

      const SAME_SECOND = new Date("2026-08-31T15:01:00Z");
      for (const [tag, emoji, offsetMs] of [
        ["REMOVE", "", 200],
        ["SET", "👍", 0],
      ] as const) {
        await insertWaReaction(client, twin.dek, {
          twinId: twin.twinId,
          chatJid: CHAT,
          senderJid: CHAT,
          fromMe: false,
          messageId: `3EB0-RX-DR-${tag}-${randomUUID()}`,
          reactionTo: ask.messageId,
          emoji,
          occurredAt: SAME_SECOND,
          senderTsMs: SAME_SECOND.getTime() + offsetMs,
        });
      }
      // The turn. Its words rank the REMOVAL nearer than the set, so the
      // retrieved block's own order disagrees with the delivery order.
      await insertWaEvent(client, twin.dek, {
        twinId: twin.twinId,
        chatJid: CHAT,
        senderJid: CHAT,
        fromMe: false,
        messageId: `3EB0-ASK-DR-${randomUUID()}`,
        text: "¿retiró el 👍 de los 20 bultos?",
        occurredAt: new Date("2026-08-31T15:05:00Z"),
      });

      // A one-message recent window, so the gestures fall OUT of the
      // transcript and reach the model through retrieval instead.
      const { deps, requests } = depsFor(client, twin, draftingTurns(), {
        historyLimit: 1,
      });
      await processPendingWaEvents(deps);

      const turn = userTurnOf(requests);
      const setAt = turn.indexOf("reacción 👍");
      const removedAt = turn.indexOf("reacción retirada");
      expect(setAt).toBeGreaterThanOrEqual(0);
      expect(removedAt).toBeGreaterThanOrEqual(0);
      expect(setAt).toBeLessThan(removedAt);
      twin.bundle.close();
    });
  });

  it("serves the Q&A its same-second beats in delivery order, however the vector ranked them (#109)", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const ask = await seedAsk(client, twin);

      // The 👍 and the removal that retracts it, one second apart from
      // nothing — the same instant — delivered removal-first.
      const SAME_SECOND = new Date("2026-08-31T15:01:00Z");
      for (const [tag, emoji, offsetMs] of [
        ["REMOVE", "", 200],
        ["SET", "👍", 0],
      ] as const) {
        await insertWaReaction(client, twin.dek, {
          twinId: twin.twinId,
          chatJid: CHAT,
          senderJid: CHAT,
          fromMe: false,
          messageId: `3EB0-RX-QA-${tag}-${randomUUID()}`,
          reactionTo: ask.messageId,
          emoji,
          occurredAt: SAME_SECOND,
          senderTsMs: SAME_SECOND.getTime() + offsetMs,
        });
      }
      await processPendingWaEvents(depsFor(client, twin).deps);

      await insertWaEvent(client, twin.dek, {
        twinId: twin.twinId,
        chatJid: SELF_CHAT,
        senderJid: SELF_CHAT,
        fromMe: true,
        messageId: `3EB0-Q-TIE-${randomUUID()}`,
        text: "¿retiró el 👍 de los 20 bultos?",
        occurredAt: new Date("2026-08-31T16:00:00Z"),
      });

      const { deps, requests } = depsFor(client, twin, [
        {
          toolCall: {
            name: "search_memory",
            // A query whose words rank the REMOVAL nearer than the set
            // (`fakeEmbedder` is word-overlap, so the ranking is exact):
            // relevance and delivery order disagree, which is the only
            // fixture that proves anything here.
            input: { about: "¿retiró el 👍 de los 20 bultos?", counterparty: null },
          },
        },
        { text: "puso 👍 y luego lo quitó" },
      ]);
      await processPendingWaEvents(deps);

      // The citation list is ranked by vector distance, and the two rows
      // carry ONE visible instant — so their order in the list is the only
      // thing telling the model which tap came last. The set must come
      // first, or «lo quitó» reads as «lo confirmó».
      const served = JSON.stringify(requests[1]);
      const setAt = served.indexOf("reacción 👍");
      const removedAt = served.indexOf("reacción retirada");
      expect(setAt).toBeGreaterThanOrEqual(0);
      expect(removedAt).toBeGreaterThanOrEqual(0);
      expect(setAt).toBeLessThan(removedAt);
      twin.bundle.close();
    });
  });

  it("a cited gesture never re-reads as a message: the binding ceremony's source-event walk stays on message rows", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      // A chat the ceremony has NEVER asked about — the ask carries no
      // push-name, so no binding question was ever owed — and a reaction
      // that DOES carry one. The «or answer» trigger will therefore walk
      // this gesture's own seam row looking for a chat to propose.
      const messageId = `3EB0-NONAME-${randomUUID()}`;
      await insertWaEvent(client, twin.dek, {
        twinId: twin.twinId,
        chatJid: CHAT,
        senderJid: CHAT,
        fromMe: false,
        messageId,
        text: ASK,
        occurredAt: new Date("2026-08-31T15:00:00Z"),
      });
      await processPendingWaEvents(depsFor(client, twin, draftingTurns()).deps);
      await insertWaReaction(client, twin.dek, {
        twinId: twin.twinId,
        chatJid: CHAT,
        senderJid: CHAT,
        fromMe: false,
        messageId: `3EB0-RX-CITED-${randomUUID()}`,
        reactionTo: messageId,
        emoji: "👍",
        pushName: "Sra. Garza",
        occurredAt: new Date("2026-08-31T15:01:00Z"),
      });
      await processPendingWaEvents(depsFor(client, twin).deps);

      await insertWaEvent(client, twin.dek, {
        twinId: twin.twinId,
        chatJid: SELF_CHAT,
        senderJid: SELF_CHAT,
        fromMe: true,
        messageId: `3EB0-Q-CITED-${randomUUID()}`,
        text: "¿ya confirmó los 20 bultos?",
        occurredAt: new Date("2026-08-31T16:00:00Z"),
      });
      const { deps } = depsFor(client, twin, [
        {
          toolCall: {
            name: "search_memory",
            input: { about: "confirmó", counterparty: null },
          },
        },
        { text: "sí, con un 👍" },
      ]);

      // The answer lands: nothing on this path tries to read a gesture as
      // though it were something the counterparty typed.
      await processPendingWaEvents(deps);
      expect(
        (await client.query(
          "SELECT id FROM notices WHERE twin_id = $1 AND kind = 'answer'",
          [twin.twinId],
        )).rows,
      ).toHaveLength(1);
      twin.bundle.close();
    });
  });

  it("a gesture consumed BEFORE its target reads at that target once it lands — the model-facing line is resolved at read time, never frozen at ingest", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const targetId = `3EB0-LATE-${randomUUID()}`;

      // The gesture arrives first — a live 👍 on a message this twin has
      // not captured yet, or an unordered history walk. It is consumed,
      // and at that moment there is nothing to inline.
      await insertWaReaction(client, twin.dek, {
        twinId: twin.twinId,
        chatJid: CHAT,
        senderJid: CHAT,
        fromMe: false,
        messageId: `3EB0-LATE-RX-${randomUUID()}`,
        reactionTo: targetId,
        emoji: "👍",
        occurredAt: new Date("2026-08-31T15:01:00Z"),
      });
      expect(await processPendingWaEvents(depsFor(client, twin).deps)).toEqual({
        processed: 1,
        drafted: 0,
      });

      // ...and now the target lands.
      await insertWaEvent(client, twin.dek, {
        twinId: twin.twinId,
        chatJid: CHAT,
        senderJid: CHAT,
        fromMe: false,
        messageId: targetId,
        text: ASK,
        occurredAt: new Date("2026-08-31T15:00:00Z"),
      });
      const drafting = depsFor(client, twin, draftingTurns());
      expect(await processPendingWaEvents(drafting.deps)).toEqual({
        processed: 1,
        drafted: 1,
      });

      // The drafting context shows the gesture AT its target, though the
      // gesture was consumed when the target did not exist.
      expect(userTurnOf(drafting.requests)).toContain(
        `[reacción 👍 a: «${ASK}»]`,
      );

      // ...and so does Q&A context, through retrieval.
      await insertWaEvent(client, twin.dek, {
        twinId: twin.twinId,
        chatJid: SELF_CHAT,
        senderJid: SELF_CHAT,
        fromMe: true,
        messageId: `3EB0-LATE-Q-${randomUUID()}`,
        text: "¿ya confirmó?",
        occurredAt: new Date("2026-08-31T16:00:00Z"),
      });
      const qa = depsFor(client, twin, [
        {
          toolCall: {
            name: "search_memory",
            input: { about: "confirmó", counterparty: null },
          },
        },
        { text: "sí, con un 👍" },
      ]);
      await processPendingWaEvents(qa.deps);
      expect(JSON.stringify(qa.requests[1])).toContain(
        `[reacción 👍 a: «${ASK}»]`,
      );
      twin.bundle.close();
    });
  });
});

/** The volatile user turn of the FIRST model call in a run. */
function userTurnOf(requests: readonly Record<string, unknown>[]): string {
  const first = requests[0];
  if (first === undefined) throw new Error("no model call was made");
  return promptOf(first);
}

describe("structural not-a-tap: the matcher never receives a reaction (ADR-0006)", () => {
  it("a reaction on the twin's own Borrador mints nothing, sends nothing, dismisses nothing", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await seedSendConfig(client, twin.twinId);
      await seedAsk(client, twin);
      const draft = await client.query<{ id: string; command_id: string }>(
        `SELECT d.id, sc.id AS command_id
           FROM drafts d JOIN send_commands sc ON sc.draft_id = d.id
          WHERE d.twin_id = $1`,
        [twin.twinId],
      );
      expect(draft.rows).toHaveLength(1);
      const posted = `WAMID-BORRADOR-${randomUUID()}`;
      await simulateExecutorPost(client, {
        commandId: draft.rows[0]!.command_id,
        twinId: twin.twinId,
        waMessageId: posted,
      });

      // The rep 👍s the Borrador in their own thread. A quoted «va» here
      // would mint a tap and release a customer_send; this must not.
      const reactionId = await insertWaReaction(client, twin.dek, {
        twinId: twin.twinId,
        chatJid: SELF_CHAT,
        senderJid: SELF_CHAT,
        fromMe: true,
        messageId: `3EB0-RX-TAP-${randomUUID()}`,
        reactionTo: posted,
        emoji: "👍",
        occurredAt: new Date("2026-08-31T15:05:00Z"),
      });

      // The REAL send-lock writer, and the twin's own words scripted as a
      // deliberate silence — so nothing here is prevented by a stub.
      const { deps } = depsFor(client, twin, qaSilenceTurns(), { live: true });
      await processPendingWaEvents(deps);

      expect(
        (await client.query("SELECT id FROM taps WHERE draft_id = $1", [
          draft.rows[0]!.id,
        ])).rows,
      ).toHaveLength(0);
      expect(
        (await client.query(
          "SELECT id FROM send_commands WHERE twin_id = $1 AND send_class = 'customer_send'",
          [twin.twinId],
        )).rows,
      ).toHaveLength(0);
      expect(
        (await client.query("SELECT draft_id FROM draft_dismissals WHERE draft_id = $1", [
          draft.rows[0]!.id,
        ])).rows,
      ).toHaveLength(0);
      // Not an affirmation, not a dismissal, not a binding: the reaction
      // took the ordinary rep-input path and the twin chose its own reply.
      expect(await dispositionOf(client, reactionId)).toBe("deliberate_silence");
      twin.bundle.close();
    });
  });

  it("a reaction on an open binding QUESTION confirms nothing and declines nothing", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      // The seeded draft's ceremony: one framed binding question, posted.
      await seedAsk(client, twin);
      const question = await client.query<{ command_id: string }>(
        `SELECT sc.id AS command_id
           FROM notices n
           JOIN send_commands sc ON sc.payload_ref = 'notice:' || n.id
          WHERE n.twin_id = $1 AND n.kind = 'binding_question'`,
        [twin.twinId],
      );
      expect(question.rows).toHaveLength(1);
      const posted = `WAMID-QUESTION-RX-${randomUUID()}`;
      await simulateExecutorPost(client, {
        commandId: question.rows[0]!.command_id,
        twinId: twin.twinId,
        waMessageId: posted,
      });

      // A quoted «va» here would bind the chat and file an entity across
      // the wall. A 👍 must do neither.
      const reactionId = await insertWaReaction(client, twin.dek, {
        twinId: twin.twinId,
        chatJid: SELF_CHAT,
        senderJid: SELF_CHAT,
        fromMe: true,
        messageId: `3EB0-RX-QUESTION-${randomUUID()}`,
        reactionTo: posted,
        emoji: "👍",
        occurredAt: new Date("2026-08-31T15:05:00Z"),
      });

      const { deps } = depsFor(client, twin, qaSilenceTurns(), { live: true });
      await processPendingWaEvents(deps);

      expect(twin.bundle.listChatBindings()).toEqual([]);
      expect(await dispositionOf(client, reactionId)).toBe("deliberate_silence");
      twin.bundle.close();
    });
  });
});

describe("a twin-thread reaction is ordinary rep input (ADR-0037: the twin composes)", () => {
  it("reaches the model with the post it points at as context, and the twin's own words are what post back", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await seedAsk(client, twin);
      const draft = await client.query<{ command_id: string }>(
        `SELECT sc.id AS command_id
           FROM drafts d JOIN send_commands sc ON sc.draft_id = d.id
          WHERE d.twin_id = $1`,
        [twin.twinId],
      );
      const posted = `WAMID-BORRADOR-CTX-${randomUUID()}`;
      await simulateExecutorPost(client, {
        commandId: draft.rows[0]!.command_id,
        twinId: twin.twinId,
        waMessageId: posted,
      });

      const reactionId = await insertWaReaction(client, twin.dek, {
        twinId: twin.twinId,
        chatJid: SELF_CHAT,
        senderJid: SELF_CHAT,
        fromMe: true,
        messageId: `3EB0-RX-CTX-${randomUUID()}`,
        reactionTo: posted,
        emoji: "👍",
        occurredAt: new Date("2026-08-31T15:05:00Z"),
      });

      const TWIN_WORDS = "una reacción no envía — cítalo con «va»";
      const { deps, requests } = depsFor(client, twin, [
        {
          toolCall: {
            name: "search_memory",
            input: { about: "borrador", counterparty: null },
          },
        },
        { text: TWIN_WORDS },
      ]);
      await processPendingWaEvents(deps);

      // The gesture reached the model as the rep's message, and the post it
      // points at travelled as its context — the same shape a non-keyword
      // reply to a proposal takes.
      const turn = userTurnOf(requests);
      expect(turn).toContain("[reacción 👍]");
      expect(turn).toContain(DRAFT_TEXT);

      expect(await dispositionOf(client, reactionId)).toBe("answered");
      const answers = await client.query<{ content_enc: Buffer }>(
        "SELECT content_enc FROM notices WHERE twin_id = $1 AND kind = 'answer'",
        [twin.twinId],
      );
      expect(answers.rows).toHaveLength(1);
      expect(
        Buffer.from(twin.dek.decrypt(answers.rows[0]!.content_enc)).toString(
          "utf8",
        ),
      ).toContain(TWIN_WORDS);
      twin.bundle.close();
    });
  });
});

describe("a reaction is not the rep answering by hand (ticket #75's supersede rule)", () => {
  it("a rep's own 👍 in a customer chat leaves the turn to be drafted", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const SUPERSEDE_ASK = `3EB0-SUP-${randomUUID()}`;
      await insertWaEvent(client, twin.dek, {
        twinId: twin.twinId,
        chatJid: CHAT,
        senderJid: CHAT,
        fromMe: false,
        messageId: SUPERSEDE_ASK,
        text: ASK,
        occurredAt: new Date("2026-08-31T15:00:00Z"),
      });
      // The rep's gesture lands AFTER the ask — exactly the shape a
      // hand-typed reply takes, and the one thing it must not be read as.
      await insertWaReaction(client, twin.dek, {
        twinId: twin.twinId,
        chatJid: CHAT,
        senderJid: CHAT,
        fromMe: true,
        messageId: `3EB0-SUP-RX-${randomUUID()}`,
        reactionTo: SUPERSEDE_ASK,
        emoji: "👍",
        occurredAt: new Date("2026-08-31T15:00:30Z"),
      });

      const { deps } = depsFor(client, twin, draftingTurns());
      expect(await processPendingWaEvents(deps)).toEqual({
        processed: 2,
        drafted: 1,
      });
      twin.bundle.close();
    });
  });
});
