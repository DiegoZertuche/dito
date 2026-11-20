/**
 * The runtime speaks 'opaque' (ticket #124; ADR-0042). Every in-scope
 * delivery leaves exactly one seam row, and a row the plane could not read
 * says so — a photo, a voice note, a message the rail could not decrypt, a
 * shape that did not parse. The runtime learns to speak the type BEFORE any
 * plane emits one (#125), because a row the consumer refuses is pending
 * forever: that deploy order is now a rule of the seam rather than of one
 * kind.
 *
 * Tested across the pre-agreed Postgres seam (spec #123): inject
 * `wa_events` opaque rows with real DEK-encrypted payloads, assert what the
 * consumer did with them, what the model was SHOWN, and — the negatives
 * that matter most — what never happened: no turn, no draft, no embedding,
 * no tap through the matcher. The model is scripted at the Tool Runner
 * boundary; a suite that scripts no turn fails loudly on any model call.
 * Crypto is real throughout (ADR-0028).
 *
 * Governing ADRs: 0042 (opaque deliveries are seam rows), 0041 (the
 * reactions precedent this mirrors), 0037 (the twin composes; no
 * opaque-specific microcopy), 0006 (the two non-model tap minters), 0033
 * (the twin thread stays twin-side).
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
  insertWaOpaque,
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
const PHOTO = "[foto]";

let tmp: string;
let pool: pg.Pool;

beforeAll(async () => {
  await resetAndMigrate();
  tmp = mkdtempSync(join(tmpdir(), "dito-opaque-int-"));
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
  options: { live?: boolean } = {},
): { deps: TwinRuntimeDeps; requests: Record<string, unknown>[] } {
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
 * The customer's ask, already in twin memory: the beat a photo will arrive
 * beside. Its message id is per-call — `external_event_id` is globally
 * unique at the seam and every test here shares the one CHAT jid.
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
    occurredAt: new Date("2026-09-01T15:00:00Z"),
  });
  const { deps } = depsFor(client, twin, draftingTurns());
  await processPendingWaEvents(deps);
  return { eventId, messageId };
}

/** The volatile user turn of the FIRST model call in a run. */
function userTurnOf(requests: readonly Record<string, unknown>[]): string {
  const first = requests[0];
  if (first === undefined) throw new Error("no model call was made");
  return promptOf(first);
}

describe("a customer-chat opaque delivery: context yes, trigger no (ADR-0042)", () => {
  it("is consumed rather than refused — the runtime speaks 'opaque' before any plane emits one", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const ask = await seedAsk(client, twin);

      const photoId = await insertWaOpaque(client, twin.dek, {
        twinId: twin.twinId,
        chatJid: CHAT,
        senderJid: CHAT,
        fromMe: false,
        messageId: `3EB0-PHOTO-${randomUUID()}:opaque`,
        kind: "imageMessage",
        reason: "no_slot",
        pushName: "Sra. Garza",
        occurredAt: new Date("2026-09-01T15:01:00Z"),
      });

      // No scripted turn at all: any model call is a loud failure, which is
      // what makes "never triggers a draft" an assertion rather than a hope.
      const { deps, requests } = depsFor(client, twin);
      expect(await processPendingWaEvents(deps)).toEqual({
        processed: 1,
        drafted: 0,
      });
      expect(requests).toHaveLength(0);
      expect(await dispositionOf(client, photoId)).toBe("captured");
      expect(
        (await client.query("SELECT id FROM drafts WHERE twin_id = $1", [
          twin.twinId,
        ])).rows,
      ).toHaveLength(1); // the seeded ask's draft, and no second one
      expect(ask.eventId).toBeDefined();

      twin.bundle.close();
    });
  });

  it("joins twin memory as one placeholder beat composed from its kind — never as text, and never as silence", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await seedAsk(client, twin);
      for (const [kind, at] of [
        ["imageMessage", "2026-09-01T15:01:00Z"],
        ["audioMessage", "2026-09-01T15:02:00Z"],
        ["undecryptable", "2026-09-01T15:03:00Z"],
      ] as const) {
        await insertWaOpaque(client, twin.dek, {
          twinId: twin.twinId,
          chatJid: CHAT,
          senderJid: CHAT,
          fromMe: false,
          messageId: `3EB0-${kind}-${randomUUID()}:opaque`,
          kind,
          reason: kind === "undecryptable" ? "undecryptable" : "no_slot",
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
      ).toEqual([ASK, PHOTO, "[nota de voz]", "[mensaje que no se pudo leer]"]);
      twin.bundle.close();
    });
  });

  it("is never embedded — the placeholder ends the husk's pollution of the vector store", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await seedAsk(client, twin);
      const before = twin.bundle.countMessageVectors();

      await insertWaOpaque(client, twin.dek, {
        twinId: twin.twinId,
        chatJid: CHAT,
        senderJid: CHAT,
        fromMe: false,
        messageId: `3EB0-PHOTO-${randomUUID()}:opaque`,
        kind: "imageMessage",
        reason: "no_slot",
        occurredAt: new Date("2026-09-01T15:01:00Z"),
      });
      await processPendingWaEvents(depsFor(client, twin).deps);

      // The row is in twin memory and out of the index — and it is not
      // merely un-embedded YET: the backlog never selects it either.
      expect(twin.bundle.readConversation(CHAT)).toHaveLength(2);
      expect(twin.bundle.countMessageVectors()).toBe(before);
      expect(twin.bundle.listUnembeddedMessages(10)).toEqual([]);
      twin.bundle.close();
    });
  });

  it("never opens a turn: a photo alone leaves the chat with nothing to answer", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      // No seeded ask at all — the photo is the only thing in this chat, so
      // a draft could only ever be triggered BY it.
      await insertWaOpaque(client, twin.dek, {
        twinId: twin.twinId,
        chatJid: CHAT,
        senderJid: CHAT,
        fromMe: false,
        messageId: `3EB0-ALONE-${randomUUID()}:opaque`,
        kind: "imageMessage",
        reason: "no_slot",
        pushName: "Sra. Garza",
        occurredAt: new Date("2026-09-01T15:00:00Z"),
      });

      const { deps, requests } = depsFor(client, twin);
      expect(await processPendingWaEvents(deps)).toEqual({
        processed: 1,
        drafted: 0,
      });
      expect(requests).toHaveLength(0);
      expect(
        (await client.query("SELECT id FROM drafts WHERE twin_id = $1", [
          twin.twinId,
        ])).rows,
      ).toHaveLength(0);
      twin.bundle.close();
    });
  });

  it("a backfilled opaque delivery routes to ingest only, like all backfill", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const photoId = await insertWaOpaque(client, twin.dek, {
        twinId: twin.twinId,
        chatJid: CHAT,
        senderJid: CHAT,
        fromMe: false,
        messageId: `3EB0-HISTORY-${randomUUID()}:opaque`,
        kind: "imageMessage",
        reason: "no_slot",
        backfill: true,
      });

      const { deps } = depsFor(client, twin);
      expect(await processPendingWaEvents(deps)).toEqual({
        processed: 1,
        drafted: 0,
      });
      expect(await dispositionOf(client, photoId)).toBe("backfill_ingested");
      expect(twin.bundle.readConversation(CHAT)).toHaveLength(1);
      twin.bundle.close();
    });
  });
});

describe("the placeholder reaches the model in chronological position", () => {
  it("the drafting call shows it in the transcript, between the beats it fell between", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      // The customer asks, sends a photo, then asks again: the second ask
      // is the turn, and the photo is context in the middle of it.
      await seedAsk(client, twin);
      await insertWaOpaque(client, twin.dek, {
        twinId: twin.twinId,
        chatJid: CHAT,
        senderJid: CHAT,
        fromMe: false,
        messageId: `3EB0-PHOTO-${randomUUID()}:opaque`,
        kind: "imageMessage",
        reason: "no_slot",
        occurredAt: new Date("2026-09-01T15:01:00Z"),
      });
      await insertWaEvent(client, twin.dek, {
        twinId: twin.twinId,
        chatJid: CHAT,
        senderJid: CHAT,
        fromMe: false,
        messageId: `3EB0-ASK-2-${randomUUID()}`,
        text: "¿y el flete?",
        occurredAt: new Date("2026-09-01T15:02:00Z"),
      });

      const { deps, requests } = depsFor(client, twin, draftingTurns());
      expect(await processPendingWaEvents(deps)).toEqual({
        processed: 2,
        drafted: 1,
      });

      const turn = userTurnOf(requests);
      expect(turn).toContain(`counterparty: ${PHOTO}`);
      // In its place: after the ask it followed, before the one it preceded.
      expect(turn.indexOf(ASK)).toBeLessThan(turn.indexOf(PHOTO));
      twin.bundle.close();
    });
  });

  /**
   * WHERE THE TICKET'S TWO CLAUSES MEET (`/code-review`, spec axis). AC 2
   * asks for the placeholder in «the extraction transcript, drafting
   * context and Q&A context», and ADR-0042 says flatly that an opaque
   * delivery is NEVER EMBEDDED. Q&A memory is vector retrieval and nothing
   * else, so the two cannot both hold and the ADR is what governs. This is
   * what the code does, pinned so the choice is visible rather than
   * assumed; the divergence is recorded on the ticket, and closing it
   * properly is a retrieval-side expansion or a promotion, neither of
   * which is this ticket's to choose.
   */
  it("is never a Q&A citation, because it was never embedded — the twin answers from what it can read", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await seedAsk(client, twin);
      await insertWaOpaque(client, twin.dek, {
        twinId: twin.twinId,
        chatJid: CHAT,
        senderJid: CHAT,
        fromMe: false,
        messageId: `3EB0-PHOTO-${randomUUID()}:opaque`,
        kind: "imageMessage",
        reason: "no_slot",
        occurredAt: new Date("2026-09-01T15:01:00Z"),
      });
      await processPendingWaEvents(depsFor(client, twin).deps);

      await insertWaEvent(client, twin.dek, {
        twinId: twin.twinId,
        chatJid: SELF_CHAT,
        senderJid: SELF_CHAT,
        fromMe: true,
        messageId: `3EB0-Q-${randomUUID()}`,
        text: "¿qué me mandó la Sra. Garza?",
        occurredAt: new Date("2026-09-01T16:00:00Z"),
      });
      const { deps, requests } = depsFor(client, twin, [
        {
          toolCall: {
            name: "search_memory",
            input: { about: "Garza", counterparty: null },
          },
        },
        { text: "pidió 20 bultos" },
      ]);
      await processPendingWaEvents(deps);

      // The search served the chat's readable beats and not the
      // placeholder: retrieval is over the vector store, and an opaque
      // delivery has no vector by construction.
      const served = JSON.stringify(requests[1]);
      expect(served).toContain(ASK);
      expect(served).not.toContain(PHOTO);
      twin.bundle.close();
    });
  });
});

describe("the fold: one message, one beat (ADR-0042)", () => {
  it("shows the READABLE row over the opaque one for the same message — a retry fixes memory rather than duplicating it", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const messageId = `3EB0-RETRY-${randomUUID()}`;
      // The rail could not decrypt it...
      await insertWaOpaque(client, twin.dek, {
        twinId: twin.twinId,
        chatJid: CHAT,
        senderJid: CHAT,
        fromMe: false,
        messageId: `${messageId}:opaque`,
        kind: "undecryptable",
        reason: "undecryptable",
        occurredAt: new Date("2026-09-01T15:00:00Z"),
      });
      // ...and the sender re-delivered it after whatsmeow's retry receipt.
      await insertWaEvent(client, twin.dek, {
        twinId: twin.twinId,
        chatJid: CHAT,
        senderJid: CHAT,
        fromMe: false,
        messageId,
        text: ASK,
        occurredAt: new Date("2026-09-01T15:00:00Z"),
      });

      const { deps, requests } = depsFor(client, twin, draftingTurns());
      await processPendingWaEvents(deps);

      expect(
        twin.bundle.readConversation(CHAT).map((row) => row.content),
      ).toEqual([ASK]);
      expect(userTurnOf(requests)).not.toContain(
        "[mensaje que no se pudo leer]",
      );
      twin.bundle.close();
    });
  });

  it("shows the OPAQUE row over the empty-text husk for the same message — existing memory heals on the next relink", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const messageId = `3EB0-HUSK-${randomUUID()}`;
      // The husk a pre-ADR-0042 plane wrote for this photo: a message row
      // that reads as somebody saying nothing.
      await insertWaEvent(client, twin.dek, {
        twinId: twin.twinId,
        chatJid: CHAT,
        senderJid: CHAT,
        fromMe: false,
        messageId,
        text: "",
        occurredAt: new Date("2026-09-01T15:00:00Z"),
      });
      await processPendingWaEvents(depsFor(client, twin, draftingTurns()).deps);
      // ...and the honest row relink backfill writes beside it.
      await insertWaOpaque(client, twin.dek, {
        twinId: twin.twinId,
        chatJid: CHAT,
        senderJid: CHAT,
        fromMe: false,
        messageId: `${messageId}:opaque`,
        kind: "imageMessage",
        reason: "no_slot",
        backfill: true,
        occurredAt: new Date("2026-09-01T15:00:00Z"),
      });
      await processPendingWaEvents(depsFor(client, twin).deps);

      expect(
        twin.bundle.readConversation(CHAT).map((row) => row.content),
      ).toEqual([PHOTO]);
      twin.bundle.close();
    });
  });
});

describe("a gesture at a message the twin could not read (ticket #124, Codex r1)", () => {
  it("renders bare rather than quoting «» — two readers of one message never disagree in front of the model", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const messageId = `3EB0-HUSK-RX-${randomUUID()}`;
      // The rep sent the price list as a photo: the legacy husk for it, the
      // honest opaque row relink writes beside it, and the customer's 👍 on
      // the message both are about.
      await insertWaEvent(client, twin.dek, {
        twinId: twin.twinId,
        chatJid: CHAT,
        senderJid: SELF_CHAT,
        fromMe: true,
        messageId,
        text: "",
        occurredAt: new Date("2026-09-01T15:00:00Z"),
      });
      await insertWaOpaque(client, twin.dek, {
        twinId: twin.twinId,
        chatJid: CHAT,
        senderJid: SELF_CHAT,
        fromMe: true,
        messageId: `${messageId}:opaque`,
        kind: "imageMessage",
        reason: "no_slot",
        backfill: true,
        occurredAt: new Date("2026-09-01T15:00:00Z"),
      });
      await insertWaReaction(client, twin.dek, {
        twinId: twin.twinId,
        chatJid: CHAT,
        senderJid: CHAT,
        fromMe: false,
        messageId: `3EB0-RX-${randomUUID()}`,
        reactionTo: messageId,
        emoji: "👍",
        occurredAt: new Date("2026-09-01T15:01:00Z"),
      });
      // No scripted turn: none of the three may reach the model.
      const seeded = depsFor(client, twin);
      await processPendingWaEvents(seeded.deps);
      expect(seeded.requests).toHaveLength(0);

      // The transcript stands the placeholder over the husk, and the
      // gesture beside it says «reacción 👍» with nothing quoted — never
      // «reacción 👍 a: «»», which is the same message read two ways.
      await insertWaEvent(client, twin.dek, {
        twinId: twin.twinId,
        chatJid: CHAT,
        senderJid: CHAT,
        fromMe: false,
        messageId: `3EB0-ASK-3-${randomUUID()}`,
        text: "¿me la mandas?",
        occurredAt: new Date("2026-09-01T15:02:00Z"),
      });
      const { deps, requests } = depsFor(client, twin, draftingTurns());
      await processPendingWaEvents(deps);

      const turn = userTurnOf(requests);
      expect(turn).toContain(PHOTO);
      expect(turn).toContain("[reacción 👍]");
      expect(turn).not.toContain("«»");
      twin.bundle.close();
    });
  });
});

describe("a rep's own opaque delivery is not the rep answering by hand (ticket #75's supersede rule)", () => {
  it("leaves the turn to be drafted — rail luck must not decide whether the rep is offered a draft", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await insertWaEvent(client, twin.dek, {
        twinId: twin.twinId,
        chatJid: CHAT,
        senderJid: CHAT,
        fromMe: false,
        messageId: `3EB0-SUP-${randomUUID()}`,
        text: "¿me pasas la lista de precios?",
        occurredAt: new Date("2026-09-01T15:00:00Z"),
      });
      // The rep's own delivery lands AFTER the ask — exactly the shape a
      // hand-typed reply takes, and the one thing it must not be read as.
      // The kind here is a MALFORMED REACTION, which is why the class
      // decides rather than the photo: a well-formed 👍 is excluded by #97,
      // and the same tap must not suppress a draft merely because the rail
      // delivered it badly enough for the plane to type it `'opaque'`.
      await insertWaOpaque(client, twin.dek, {
        twinId: twin.twinId,
        chatJid: CHAT,
        senderJid: SELF_CHAT,
        fromMe: true,
        messageId: `3EB0-SUP-RX-${randomUUID()}:opaque`,
        kind: "reaction/reaction_to",
        reason: "malformed",
        occurredAt: new Date("2026-09-01T15:00:30Z"),
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

describe("structural not-a-tap: the matcher never receives an opaque delivery (ADR-0006)", () => {
  it("a photo in the twin thread mints nothing, sends nothing, dismisses nothing", async () => {
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

      // The rep sends a photo into their own thread while a Borrador is
      // open. A quoted «va» here would mint a tap and release a
      // customer_send; this must not — and the matcher, whose input is a
      // `WaMessagePayload`, is never even called.
      const photoId = await insertWaOpaque(client, twin.dek, {
        twinId: twin.twinId,
        chatJid: SELF_CHAT,
        senderJid: SELF_CHAT,
        fromMe: true,
        messageId: `3EB0-SELF-PHOTO-${randomUUID()}:opaque`,
        kind: "imageMessage",
        reason: "no_slot",
        occurredAt: new Date("2026-09-01T15:05:00Z"),
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
        (await client.query(
          "SELECT draft_id FROM draft_dismissals WHERE draft_id = $1",
          [draft.rows[0]!.id],
        )).rows,
      ).toHaveLength(0);
      // AND THE ASSERTION IS NOW STRUCTURAL TWICE OVER (ticket #240). It used
      // to rest on the WORD: the matcher's own outcomes are `affirmed`,
      // `affirmation_refused`, `dismissed`, `binding_confirmed` and
      // `media_ignored`, so a build that routed this row through it could not
      // have landed on the Q&A path's `deliberate_silence`. Since F13 there is
      // no execution at all for a self-chat opaque delivery, so the word is
      // `captured` — which the matcher CAN write, and which is why the three
      // assertions above it are the ones that carry the claim now. The
      // structural half is unchanged and is the strongest of the four:
      // `matchCapturedEvent` takes a `WaMessagePayload` and cannot be handed
      // this payload at all.
      expect(await dispositionOf(client, photoId)).toBe("captured");
      twin.bundle.close();
    });
  });
});

/**
 * THE SELF-CHAT ARM (ticket #240; ADR-0042; `routeOpaque` argues it).
 *
 * The self-chat is not where reps send photos: it is where the RAIL puts its
 * own traffic, because every pairing burst and every on-demand history page
 * delivers protocol messages the plane cannot type. So an opaque delivery here
 * is recorded and answered by nothing, exactly as one in a customer chat is —
 * and what this block asserts is the pair of negatives that costs the most
 * when it breaks: no execution, and nothing posted where the rep reads.
 *
 * Whether a rep-authored message that arrives opaque ever earns one
 * «reenvíamelo» is 6b's question (#215).
 */
describe("a twin-thread opaque delivery is recorded and answered by nothing (ADR-0042; ticket #240)", () => {
  it("reaches no execution and posts nothing, while the readable message behind it is still answered", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await seedAsk(client, twin);

      const photoId = await insertWaOpaque(client, twin.dek, {
        twinId: twin.twinId,
        chatJid: SELF_CHAT,
        senderJid: SELF_CHAT,
        fromMe: true,
        messageId: `3EB0-SELF-PHOTO-${randomUUID()}:opaque`,
        kind: "imageMessage",
        reason: "no_slot",
        occurredAt: new Date("2026-09-01T15:05:00Z"),
      });

      // NO SCRIPT AT ALL: an execution for this row would ask the wire for a
      // turn that does not exist, and the pass would fail loudly. The empty
      // script IS the assertion that the model is never called.
      const first = depsFor(client, twin);
      await processPendingWaEvents(first.deps);
      expect(first.requests).toHaveLength(0);
      expect(await dispositionOf(client, photoId)).toBe("captured");
      expect(
        (await client.query(
          "SELECT id FROM notices WHERE twin_id = $1 AND kind = 'answer'",
          [twin.twinId],
        )).rows,
      ).toEqual([]);
      // The placeholder is in twin memory all the same (ADR-0042's row
      // invariant) — recorded, never answered.
      expect(
        twin.bundle.readConversation(SELF_CHAT).map((row) => row.content),
      ).toContain(PHOTO);

      // AND THE THREAD STILL WORKS. The rep writes about the photo they just
      // sent, and that message runs its execution and posts the twin's own
      // words — so what F13 removed is the RAIL's traffic, not the surface.
      await insertWaEvent(client, twin.dek, {
        twinId: twin.twinId,
        chatJid: SELF_CHAT,
        senderJid: SELF_CHAT,
        fromMe: true,
        messageId: `3EB0-SELF-ASK-${randomUUID()}`,
        text: "te acabo de mandar la lista, ¿la ves?",
        occurredAt: new Date("2026-09-01T15:06:00Z"),
      });
      const TWIN_WORDS = "todavía no puedo abrir fotos — ¿me lo escribes?";
      const { deps, requests } = depsFor(client, twin, [
        {
          toolCall: {
            name: "search_memory",
            input: { about: "foto", counterparty: null },
          },
        },
        { text: TWIN_WORDS },
      ]);
      await processPendingWaEvents(deps);

      // The placeholder still reaches the model — as CONTEXT, in the thread
      // window, which is the half of «context yes, trigger no» that stays.
      expect(userTurnOf(requests)).toContain(PHOTO);
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
