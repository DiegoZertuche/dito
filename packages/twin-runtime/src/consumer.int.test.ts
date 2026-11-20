/**
 * The twin-runtime's seam consumer, tested across the Postgres seam — the
 * pre-agreed seam (spec #18): inject `wa_events` fixtures with real
 * DEK-encrypted payloads, assert what appears on the other side — bundle
 * rows, draft records, `system_send` commands, content-free timings. Real
 * Postgres, real envelope crypto, real SQLCipher (ADR-0028); the model is
 * scripted at the model boundary. Draft prose is never
 * judged — the asserted text is our own scripted fixture.
 *
 * Governing ADRs: 0005, 0006, 0008, 0014, 0015, 0016.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyAuditChainInDb } from "@dito/audit";
import { createBundle, type Bundle } from "@dito/bundle";
import { createDekFromMaterial, type Dek } from "@dito/crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  processPendingWaEvents,
  UnsupportedEventTypeError,
} from "./consumer.js";
import {
  resetAndMigrate,
  withClient,
  TEST_AUDIT_HMAC_KEY,
  TEST_DATABASE_URL,
} from "./testing/db.js";
import { openSealedParts } from "./posts.js";
import { removeTmpDir } from "./testing/tmp.js";
import { fakeEmbedder } from "./testing/fake-embedder.js";
import { neverSendLock } from "./testing/never-writer.js";
import {
  insertWaEvent,
  insertWaOpaque,
  insertWaReaction,
} from "./testing/seam-fixtures.js";
import {
  closeScriptedModels,
  qaSilenceTurns,
  scriptedModel,
  type Script,
  type ScriptedTurn,
} from "./testing/scripted-model.js";
import { SETTLE_IMMEDIATELY } from "./testing/settle.js";
import { newExecutionPool } from "./testing/execution-pool.js";
import type { Embedder } from "./embedder.js";
import { isThreadTurn } from "./testing/thread-script.js";

// Every scripted model this suite opened is closed with it (#328).
afterAll(closeScriptedModels);

/** One connection source for every execution this suite runs (ticket #173). */
const executionPool = newExecutionPool();

const SELF_CHAT = "5215550000@s.whatsapp.net";
const CHAT = "5215550001@s.whatsapp.net";
const DRAFT_TEXT = "claro, se las mando el jueves temprano";
/** The sentence the drafting turn finishes on: the line above the Borrador (ticket #368). */
const SENTENCE = "Te dejé la respuesta: ayer preguntó disponibilidad y quedó sin respuesta.";

/** One scripted needs-answer decision (tool call + closing turn). */
function draftingTurns(needsAnswer: boolean, draftText?: string): ScriptedTurn[] {
  return needsAnswer
    ? [
        { toolCall: { name: "create_draft", input: { text: draftText ?? DRAFT_TEXT } } },
        { text: SENTENCE },
      ]
    : [{ text: "" }];
}

let tmp: string;

beforeAll(async () => {
  await resetAndMigrate();
  tmp = mkdtempSync(join(tmpdir(), "dito-twin-runtime-int-"));
});

afterAll(() => {
  removeTmpDir(tmp);
});

/** A fresh twin with its own real SQLCipher bundle under a local DEK (the fixture path — crypto real, never mocked). */
function freshTwin(): { twinId: string; dek: Dek; bundle: Bundle } {
  const twinId = randomUUID();
  const dek = createDekFromMaterial(randomBytes(32));
  const bundle = createBundle(join(tmp, `${twinId}.bundle`), dek);
  return { twinId, dek, bundle };
}

function depsFor(
  client: pg.Client,
  twin: { twinId: string; dek: Dek; bundle: Bundle },
  script: Script,
  overrides: {
    readonly embedder?: Embedder;
    readonly executionPool?: pg.Pool;
  } = {},
) {
  const { harness, requests } = scriptedModel(script);
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
      executionPool: overrides.executionPool ?? executionPool,
      sendLock: neverSendLock(),
      hmacKey: TEST_AUDIT_HMAC_KEY,
      embedder: overrides.embedder ?? fakeEmbedder(),
    },
  };
}

describe("seam consumer: wa_events → bundle rows, drafts, system_send (ticket #23)", () => {
  it("an in-scope counterparty inbound needing an answer yields the bundle row, the draft record, its system_send to the self-chat, and a content-free timing", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const eventId = await insertWaEvent(client, twin.dek, {
        twinId: twin.twinId,
        chatJid: CHAT,
        senderJid: CHAT,
        fromMe: false,
        messageId: "3EB0-C1-1",
        text: "¿me mandas 40 cajas para el jueves?",
        occurredAt: new Date("2026-08-27T14:03:00Z"),
      });

      const { deps } = depsFor(client, twin, draftingTurns(true));
      const result = await processPendingWaEvents(deps);
      expect(result).toEqual({ processed: 1, drafted: 1 });

      // Slice AC 10 continues: the conversation row landed in twin memory.
      expect(twin.bundle.readConversation(CHAT)).toEqual([
        {
          chatJid: CHAT,
          messageId: "3EB0-C1-1",
          senderJid: CHAT,
          fromMe: false,
          occurredAt: "2026-08-27T14:03:00.000Z",
          content: "¿me mandas 40 cajas para el jueves?",
        },
      ]);

      // The draft record: addressed to the counterparty chat, referencing
      // its inbound event, content DEK-encrypted at rest (ADR-0008).
      const drafts = await client.query(
        "SELECT id, destination, in_reply_to_event_id, content_enc FROM drafts WHERE twin_id = $1",
        [twin.twinId],
      );
      expect(drafts.rows).toHaveLength(1);
      const draft = drafts.rows[0]!;
      expect(draft.destination).toBe(CHAT);
      expect(draft.in_reply_to_event_id).toBe(eventId);
      expect(
        Buffer.from(twin.dek.decrypt(draft.content_enc)).toString("utf8"),
      ).toBe(DRAFT_TEXT);

      // The system_send command: to the self-chat only, tap-free
      // (ADR-0006), referencing exactly this draft.
      const commands = await client.query(
        "SELECT send_class, destination, payload_ref, tap_id, draft_id, outcome FROM send_commands WHERE twin_id = $1",
        [twin.twinId],
      );
      expect(commands.rows).toEqual([
        {
          send_class: "system_send",
          destination: SELF_CHAT,
          payload_ref: `draft:${draft.id}`,
          tap_id: null,
          draft_id: draft.id,
          outcome: null,
        },
      ]);

      // Content-free per-draft timing (NFR-2, measured on the rig in #26):
      // instants only, ordered sanely.
      const timings = await client.query(
        "SELECT event_received_at, runtime_seen_at, draft_ready_at FROM draft_timings WHERE draft_id = $1",
        [draft.id],
      );
      expect(timings.rows).toHaveLength(1);
      const t = timings.rows[0]!;
      expect(t.runtime_seen_at.getTime()).toBeGreaterThanOrEqual(
        t.event_received_at.getTime() - 1000,
      );
      expect(t.draft_ready_at.getTime()).toBeGreaterThanOrEqual(
        t.runtime_seen_at.getTime(),
      );

      // And the event is marked processed as 'drafted'.
      const marks = await client.query(
        "SELECT disposition FROM wa_event_processing WHERE event_id = $1 AND twin_id = $2",
        [eventId, twin.twinId],
      );
      expect(marks.rows).toEqual([{ disposition: "drafted" }]);

      twin.bundle.close();
    });
  });

  it("the draft's twin-thread post is Mock A, exactly: the twin's sentence, label, push-name counterparty line, guillemet body, instruction line (tickets #30, #368)", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const occurredAt = new Date("2026-08-27T16:42:00Z");
      await insertWaEvent(client, twin.dek, {
        twinId: twin.twinId,
        chatJid: CHAT,
        senderJid: CHAT,
        fromMe: false,
        messageId: "3EB0-C1-M1",
        text: "¿tiene disponibilidad de 40 cajas?",
        pushName: "Sra. Garza",
        occurredAt,
      });

      const { deps } = depsFor(client, twin, draftingTurns(true));
      await processPendingWaEvents(deps);

      const drafts = await client.query(
        "SELECT content_enc, post_enc FROM drafts WHERE twin_id = $1",
        [twin.twinId],
      );
      expect(drafts.rows).toHaveLength(1);
      const draft = drafts.rows[0]!;

      // content_enc stays the bare customer-bound body — a tap releases
      // exactly what the rep saw in the guillemets, never the frame.
      expect(
        Buffer.from(twin.dek.decrypt(draft.content_enc)).toString("utf8"),
      ).toBe(DRAFT_TEXT);

      // post_enc is the Mock A rendering (spec #29 grilling decision 4).
      // The chat is unbound, so the counterparty wears the provisional
      // mark (ticket #34): the mock's bare «para Sra. Garza» is the
      // post-confirmation rendering, pinned in bindings.int.test.ts.
      expect(
        Buffer.from(twin.dek.decrypt(draft.post_enc)).toString("utf8"),
      ).toBe(
        `✳️ ${SENTENCE}\n\n` +
          `*Borrador — para Sra. Garza (sin confirmar)*\n\n` +
          `«${DRAFT_TEXT}»\n\n` +
          `Para enviarlo, responde a este mensaje citándolo con «va».`,
      );

      twin.bundle.close();
    });
  });

  it("the counterparty line falls back to the number when the payload carries no push-name", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await insertWaEvent(client, twin.dek, {
        twinId: twin.twinId,
        chatJid: CHAT,
        senderJid: CHAT,
        fromMe: false,
        messageId: "3EB0-C1-M2",
        text: "¿me lo puedes cotizar?",
      });

      const { deps } = depsFor(client, twin, draftingTurns(true));
      await processPendingWaEvents(deps);

      const drafts = await client.query(
        "SELECT post_enc FROM drafts WHERE twin_id = $1",
        [twin.twinId],
      );
      const post = Buffer.from(
        twin.dek.decrypt(drafts.rows[0]!.post_enc),
      ).toString("utf8");
      // Unbound and nameless: the number, still marked provisional (#34).
      expect(post).toContain("\n\n*Borrador — para 5215550001 (sin confirmar)*");

      twin.bundle.close();
    });
  });

  it("an inbound not needing an answer yields neither a draft nor a command — the conversation row still lands", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const eventId = await insertWaEvent(client, twin.dek, {
        twinId: twin.twinId,
        chatJid: CHAT,
        senderJid: CHAT,
        fromMe: false,
        messageId: "3EB0-C2-1",
        text: "ok gracias",
      });

      const { deps } = depsFor(client, twin, draftingTurns(false));
      const result = await processPendingWaEvents(deps);
      expect(result).toEqual({ processed: 1, drafted: 0 });

      expect(twin.bundle.readConversation(CHAT)).toHaveLength(1);
      const drafts = await client.query(
        "SELECT id FROM drafts WHERE twin_id = $1",
        [twin.twinId],
      );
      const commands = await client.query(
        "SELECT id FROM send_commands WHERE twin_id = $1",
        [twin.twinId],
      );
      expect(drafts.rows).toHaveLength(0);
      expect(commands.rows).toHaveLength(0);
      const marks = await client.query(
        "SELECT disposition FROM wa_event_processing WHERE event_id = $1",
        [eventId],
      );
      expect(marks.rows).toEqual([{ disposition: "no_answer_needed" }]);
      twin.bundle.close();
    });
  });

  it("the twin never drafts against its own traffic: own-sent and self-chat events are captured for the matcher, and the model is never called", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      // The rep answers a customer from the phone (own-sent, customer chat).
      await insertWaEvent(client, twin.dek, {
        twinId: twin.twinId,
        chatJid: CHAT,
        senderJid: SELF_CHAT,
        fromMe: true,
        messageId: "3EB0-C3-1",
        text: "ahorita se lo confirmo",
      });
      // Self-chat traffic — a rep quoted-reply affirmation (matcher input, #24).
      await insertWaEvent(client, twin.dek, {
        twinId: twin.twinId,
        chatJid: SELF_CHAT,
        senderJid: SELF_CHAT,
        fromMe: true,
        messageId: "3EB0-C3-2",
        text: "va",
        quotedMessageId: "3EB0-QUOTED-1",
      });

      // No scripted turns at all: any model request would fail loudly.
      const { deps, requests } = depsFor(client, twin, []);
      const result = await processPendingWaEvents(deps);
      expect(result).toEqual({ processed: 2, drafted: 0 });
      expect(requests).toHaveLength(0);

      // Both rows are twin memory now (the self-chat is always in scope).
      expect(twin.bundle.readConversation(CHAT)).toHaveLength(1);
      expect(twin.bundle.readConversation(SELF_CHAT)).toHaveLength(1);

      const drafts = await client.query(
        "SELECT id FROM drafts WHERE twin_id = $1",
        [twin.twinId],
      );
      expect(drafts.rows).toHaveLength(0);
      const marks = await client.query(
        "SELECT disposition FROM wa_event_processing WHERE twin_id = $1",
        [twin.twinId],
      );
      // The own-sent customer-chat reply is plain captured. The quoted
      // «va» is matcher input since #25: its quoted id resolves to no
      // recorded draft post, and an affirmation-shaped reply is never
      // consumed silently — it refuses loudly (mints nothing; the
      // matcher suite owns the full behavior).
      expect(marks.rows).toEqual([
        { disposition: "captured" },
        { disposition: "affirmation_refused" },
      ]);
      twin.bundle.close();
    });
  });

  it("processing is exactly-once: a second pass consumes nothing and emits nothing", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await insertWaEvent(client, twin.dek, {
        twinId: twin.twinId,
        chatJid: CHAT,
        senderJid: CHAT,
        fromMe: false,
        messageId: "3EB0-C4-1",
        text: "¿tienen entrega el sábado?",
      });

      const first = depsFor(client, twin, draftingTurns(true));
      expect(await processPendingWaEvents(first.deps)).toEqual({
        processed: 1,
        drafted: 1,
      });

      // A second pass with a live script: consuming anything would call
      // the model and double-draft — both must not happen.
      const second = depsFor(client, twin, draftingTurns(true));
      expect(await processPendingWaEvents(second.deps)).toEqual({
        processed: 0,
        drafted: 0,
      });
      expect(second.requests).toHaveLength(0);

      const drafts = await client.query(
        "SELECT id FROM drafts WHERE twin_id = $1",
        [twin.twinId],
      );
      const commands = await client.query(
        "SELECT id FROM send_commands WHERE twin_id = $1",
        [twin.twinId],
      );
      expect(drafts.rows).toHaveLength(1);
      expect(commands.rows).toHaveLength(1);
      expect(twin.bundle.readConversation(CHAT)).toHaveLength(1);
      twin.bundle.close();
    });
  });

  it("a crash between the bundle append and the marker replays cleanly: the stored row is recognized, the draft still emits once", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await insertWaEvent(client, twin.dek, {
        twinId: twin.twinId,
        chatJid: CHAT,
        senderJid: CHAT,
        fromMe: false,
        messageId: "3EB0-C6-1",
        text: "¿me pasas el precio de la caja grande?",
        occurredAt: new Date("2026-08-27T15:00:00Z"),
      });
      // Simulate the crash's leftover: the conversation row already made
      // it into the bundle, the marker did not.
      twin.bundle.ingestMessage({
        chatJid: CHAT,
        messageId: "3EB0-C6-1",
        senderJid: CHAT,
        fromMe: false,
        occurredAt: "2026-08-27T15:00:00.000Z",
        content: "¿me pasas el precio de la caja grande?",
      });

      const { deps } = depsFor(client, twin, draftingTurns(true));
      expect(await processPendingWaEvents(deps)).toEqual({
        processed: 1,
        drafted: 1,
      });

      // No duplicate conversation row, exactly one draft.
      expect(twin.bundle.readConversation(CHAT)).toHaveLength(1);
      const drafts = await client.query(
        "SELECT id FROM drafts WHERE twin_id = $1",
        [twin.twinId],
      );
      expect(drafts.rows).toHaveLength(1);
      twin.bundle.close();
    });
  });

  // THE POISON ROW USED TO BE A REACTION (tickets #23–#75). It is a
  // `receipt` now, because #97 taught this runtime to speak 'reaction' —
  // and the property under test was never about reactions: it is that an
  // event type this build does not speak stops the pass rather than being
  // skipped past. A delivery receipt is a type a newer plane could
  // plausibly send and this one cannot read, which is exactly the shape the
  // deploy-order rule exists for (ADR-0041: the runtime learns a type
  // BEFORE any plane emits it). The guard below it is the other half.
  it("an event type this runtime does not speak refuses loudly and stays unconsumed — never skipped past", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const eventId = await insertWaEvent(client, twin.dek, {
        twinId: twin.twinId,
        chatJid: CHAT,
        senderJid: CHAT,
        fromMe: false,
        messageId: "3EB0-C7-1",
        text: "x",
        eventType: "receipt",
      });

      const { deps } = depsFor(client, twin, []);
      await expect(processPendingWaEvents(deps)).rejects.toThrow(
        UnsupportedEventTypeError,
      );

      const marks = await client.query(
        "SELECT event_id FROM wa_event_processing WHERE event_id = $1",
        [eventId],
      );
      expect(marks.rows).toHaveLength(0);
      twin.bundle.close();
    });
  });

  it("…and 'reaction' is no longer one of them: the runtime speaks it, so the row is consumed (ticket #97)", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const eventId = await insertWaReaction(client, twin.dek, {
        twinId: twin.twinId,
        chatJid: CHAT,
        senderJid: CHAT,
        fromMe: false,
        messageId: "3EB0-C8-RX",
        reactionTo: "3EB0-C8-1",
        emoji: "👍",
      });

      const { deps } = depsFor(client, twin, []);
      expect(await processPendingWaEvents(deps)).toEqual({
        processed: 1,
        drafted: 0,
      });

      const marks = await client.query<{ disposition: string }>(
        "SELECT disposition FROM wa_event_processing WHERE event_id = $1",
        [eventId],
      );
      expect(marks.rows).toEqual([{ disposition: "captured" }]);
      twin.bundle.close();
    });
  });

  it("…and neither is 'opaque': the runtime speaks a delivery the plane could not read (ticket #124)", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const eventId = await insertWaOpaque(client, twin.dek, {
        twinId: twin.twinId,
        chatJid: CHAT,
        senderJid: CHAT,
        fromMe: false,
        messageId: "3EB0-C9-1:opaque",
        kind: "imageMessage",
        reason: "no_slot",
      });

      const { deps } = depsFor(client, twin, []);
      expect(await processPendingWaEvents(deps)).toEqual({
        processed: 1,
        drafted: 0,
      });

      const marks = await client.query<{ disposition: string }>(
        "SELECT disposition FROM wa_event_processing WHERE event_id = $1",
        [eventId],
      );
      expect(marks.rows).toEqual([{ disposition: "captured" }]);
      // The canonical poison stays a type nobody has taught this runtime —
      // a delivery receipt, above — so the refusal above and the speaking
      // here are two properties rather than one moving target.
      twin.bundle.close();
    });
  });
});

/**
 * ONE REP MESSAGE IN THE TWIN THREAD — what wakes a thread execution
 * (ticket #240).
 *
 * `fromMe` in the self-chat, which is the only thing the router reads to
 * decide the occasion. The instant is fixed so a suite reads the same
 * chronology on every run.
 */
async function repWrites(
  client: pg.Client,
  twin: { twinId: string; dek: Dek; bundle: Bundle },
  text: string,
  at = new Date("2026-09-08T09:00:00Z"),
): Promise<string> {
  return await insertWaEvent(client, twin.dek, {
    twinId: twin.twinId,
    chatJid: SELF_CHAT,
    senderJid: SELF_CHAT,
    fromMe: true,
    messageId: `3EB0-T240-${randomUUID().slice(0, 8)}`,
    text,
    occurredAt: at,
  });
}

/** This twin's execution records, oldest first. */
async function executionsOf(
  client: pg.Client,
  twin: { twinId: string },
): Promise<{ disposition: string; lane: string; trigger_kind: string }[]> {
  const res = await client.query<{
    disposition: string;
    lane: string;
    trigger_kind: string;
  }>(
    `SELECT disposition, lane, trigger_kind FROM executions
      WHERE twin_id = $1 ORDER BY started_at, id`,
    [twin.twinId],
  );
  return res.rows;
}

/**
 * This twin's `execution` chain entries, in order.
 *
 * SCOPED BY THE REFERENCE, because the rep chain has no tenant column and
 * this file's tests share one database (`thread.int.test.ts`' own helper).
 */
async function executionEntriesOf(
  client: pg.Client,
  twin: { twinId: string },
): Promise<string[]> {
  const res = await client.query<{ outcome: string }>(
    `SELECT outcome FROM audit_chain
      WHERE action = 'execution' AND ref LIKE '%twin:' || $1 || '%'
      ORDER BY id`,
    [twin.twinId],
  );
  return res.rows.map((row) => row.outcome);
}

/** What the seam recorded about each of this twin's events, oldest first. */
async function markersOf(
  client: pg.Client,
  twin: { twinId: string },
): Promise<{ event_id: string; disposition: string }[]> {
  const res = await client.query<{ event_id: string; disposition: string }>(
    `SELECT p.event_id, p.disposition FROM wa_event_processing p
      WHERE p.twin_id = $1 ORDER BY p.event_id::bigint`,
    [twin.twinId],
  );
  return res.rows;
}

/** How many posts this twin wrote into the rep's own thread. */
async function twinPostCount(
  client: pg.Client,
  twin: { twinId: string },
): Promise<{ notices: number; sends: number }> {
  const res = await client.query<{ notices: string; sends: string }>(
    `SELECT (SELECT count(*) FROM notices WHERE twin_id = $1)::text AS notices,
            (SELECT count(*) FROM send_commands
              WHERE twin_id = $1 AND send_class = 'system_send')::text AS sends`,
    [twin.twinId],
  );
  const row = res.rows[0]!;
  return { notices: Number(row.notices), sends: Number(row.sends) };
}

/**
 * THE BOUNDARY'S OWN POISON, SCRIPTED (ticket #240; the ruling on #225, F1):
 * a line the guard refuses every time — a receipt code owns, typed as prose —
 * the way the rig's thread turn ran out of its six-iteration
 * budget on 2026-09-08. Eight attempts so the budget, not the script, is what
 * ends the turn: an exhausted script is a loud failure of the wire rather than
 * the execution ending this asserts.
 */
const REFUSED_SUBMITS: readonly ScriptedTurn[] = Array.from(
  { length: 8 },
  () => ({ text: "Descartado." }),
);

const POISON = "¿qué me pidió la semana pasada?";

describe("a realtime execution that fails is an outcome, never the end of the runtime (ticket #240, boundary #225 F1)", () => {
  it("a thread execution whose every line is refused is recorded, its trigger is marked, and the customer turn beside it still drafts", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const poison = await repWrites(client, twin, POISON);
      const asks = await insertWaEvent(client, twin.dek, {
        twinId: twin.twinId,
        chatJid: CHAT,
        senderJid: CHAT,
        fromMe: false,
        messageId: `3EB0-T240-ASK-${randomUUID().slice(0, 8)}`,
        text: "¿me mandas 40 cajas para el jueves?",
        occurredAt: new Date("2026-09-08T09:00:05Z"),
      });
      // SCRIPTED PER CONVERSATION, and the discriminator is the OCCASION
      // rather than the words: the thread's own window renders the rep's
      // recent messages, so the poison text is in every self-chat prompt of
      // this pass and could not tell two of them apart.
      const { deps } = depsFor(client, twin, (prompt) =>
        isThreadTurn(prompt) ? REFUSED_SUBMITS : draftingTurns(true),
      );

      // THE PASS RESOLVES. This is F1: an unhandled rejection here takes the
      // runtime with it, and every dashboard read falls back to
      // `rail.unreachable` until an operator restarts the process.
      expect(await processPendingWaEvents(deps)).toEqual({
        processed: 2,
        drafted: 1,
      });

      // BOTH RAN, and the failure left the pair ADR-0020 asks for.
      expect(
        [...(await executionsOf(client, twin)).map((row) => row.disposition)].sort(),
      ).toEqual(["drafted", "failed"]);
      expect([...(await executionEntriesOf(client, twin))].sort()).toEqual([
        "drafted",
        "failed",
      ]);
      expect(
        (await verifyAuditChainInDb(client, TEST_AUDIT_HMAC_KEY)).valid,
      ).toBe(true);

      // THE POISON ROW IS MARKED, which is what stops it being re-routed on
      // every pass for ever — and the customer's turn is marked its own way.
      expect(await markersOf(client, twin)).toEqual([
        { event_id: poison, disposition: "execution_failed" },
        { event_id: asks, disposition: "drafted" },
      ]);

      // ...AND A SECOND PASS FINDS NOTHING. No new execution, no second
      // model call, no second immutable record for a message that is not
      // getting better on its own.
      const again = depsFor(client, twin, []);
      expect(await processPendingWaEvents(again.deps)).toEqual({
        processed: 0,
        drafted: 0,
      });
      expect(again.requests).toHaveLength(0);
      expect(await executionsOf(client, twin)).toHaveLength(2);
      twin.bundle.close();
    });
  });

  it("...and a DRAFTING execution whose model call fails marks its whole turn, while the rep's own message in the same pass is still answered", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const first = await insertWaEvent(client, twin.dek, {
        twinId: twin.twinId,
        chatJid: CHAT,
        senderJid: CHAT,
        fromMe: false,
        messageId: `3EB0-T240-B1-${randomUUID().slice(0, 8)}`,
        text: "¿tiene 20 bultos?",
        occurredAt: new Date("2026-09-08T09:00:00Z"),
      });
      const second = await insertWaEvent(client, twin.dek, {
        twinId: twin.twinId,
        chatJid: CHAT,
        senderJid: CHAT,
        fromMe: false,
        messageId: `3EB0-T240-B2-${randomUUID().slice(0, 8)}`,
        text: "o los que haya",
        occurredAt: new Date("2026-09-08T09:00:01Z"),
      });
      const repsOwn = await repWrites(
        client,
        twin,
        "nota: pedir precio nuevo",
        new Date("2026-09-08T09:00:02Z"),
      );
      const { deps } = depsFor(client, twin, (prompt) =>
        isThreadTurn(prompt)
          ? qaSilenceTurns()
          : [],
      );

      expect(await processPendingWaEvents(deps)).toEqual({
        processed: 3,
        drafted: 0,
      });

      expect(
        [...(await executionsOf(client, twin)).map((row) => row.disposition)].sort(),
      ).toEqual(["failed", "no-action"]);
      expect(
        (await verifyAuditChainInDb(client, TEST_AUDIT_HMAC_KEY)).valid,
      ).toBe(true);

      // THE WHOLE TURN, not the anchor alone: one verdict about a turn is one
      // transaction, so both of the chat's events carry the word and the next
      // pass puts neither of them back in front of the model.
      expect(await markersOf(client, twin)).toEqual([
        { event_id: first, disposition: "execution_failed" },
        { event_id: second, disposition: "execution_failed" },
        { event_id: repsOwn, disposition: "deliberate_silence" },
      ]);
      expect(
        (await client.query("SELECT id FROM drafts WHERE twin_id = $1", [
          twin.twinId,
        ])).rows,
      ).toEqual([]);
      twin.bundle.close();
    });
  });

  it("a tool that throws on its input is recorded the same way, and the pass still resolves", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const breaks = "consulta que el índice no puede responder";
      const poison = await repWrites(client, twin, "¿y la lista de precios?");
      // THE TOOL'S OWN INPUT DECIDES IT: the embedder refuses THIS query and
      // no other, so what throws is `search_memory` running the arguments the
      // model handed it — not a boundary that is down for the whole pass.
      // Ingest embeds the message text, which is a different string, so the
      // routing half of this pass is untouched.
      const embedder: Embedder = {
        embed: (texts) =>
          texts.some((text) => text.includes(breaks))
            ? Promise.reject(new Error("the index refused this query"))
            : fakeEmbedder().embed(texts),
      };
      const { deps } = depsFor(
        client,
        twin,
        [
          { toolCall: { name: "search_memory", input: { about: breaks, counterparty: null } } },
          // A LINE OVER A SEARCH THAT FAILED: the runner's tool failure
          // outranks it, so a broken search never reads as an empty history.
          { text: "No encontré nada de eso." },
        ],
        { embedder },
      );

      expect(await processPendingWaEvents(deps)).toEqual({
        processed: 1,
        drafted: 0,
      });

      expect(
        (await executionsOf(client, twin)).map((row) => row.disposition),
      ).toEqual(["failed"]);
      expect(await executionEntriesOf(client, twin)).toEqual(["failed"]);
      expect(
        (await verifyAuditChainInDb(client, TEST_AUDIT_HMAC_KEY)).valid,
      ).toBe(true);
      expect(await markersOf(client, twin)).toEqual([
        { event_id: poison, disposition: "execution_failed" },
      ]);
      expect(await twinPostCount(client, twin)).toEqual({
        notices: 0,
        sends: 0,
      });
      twin.bundle.close();
    });
  });

  it("a model call the wire rejects is recorded the same way, and nothing reaches the process as an unhandled rejection", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const poison = await repWrites(client, twin, "¿cuánto le debemos?");
      // THE OTHER HALF OF THE TICKET'S SECOND CRITERION: "a tool throwing; the
      // model client rejecting". `onRequest` throws before any turn is served,
      // which the scripted model answers as a refused request — the child
      // reports an API error and the runner folds it into the execution's
      // ending as `wireFailure`.
      const { harness } = scriptedModel([], {
        onRequest: () =>
          Promise.reject(new Error("the provider refused this request")),
      });

      // NO UNHANDLED REJECTION, ASSERTED RATHER THAN HOPED FOR. This is the
      // failure that killed the rig's runtime: not a rejected promise the pass
      // returned, but one nobody was awaiting. Node reports it on this event,
      // so the only way to claim it did not happen is to listen.
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown): void => {
        unhandled.push(reason);
      };
      process.on("unhandledRejection", onUnhandled);
      try {
        expect(
          await processPendingWaEvents({ ...depsFor(client, twin, []).deps, harness }),
        ).toEqual({ processed: 1, drafted: 0 });
        // One turn of the event loop after the pass, which is when Node
        // reports a rejection that was never handled.
        await new Promise((resolve) => setImmediate(resolve));
      } finally {
        process.off("unhandledRejection", onUnhandled);
      }
      expect(unhandled).toEqual([]);

      expect(
        (await executionsOf(client, twin)).map((row) => row.disposition),
      ).toEqual(["failed"]);
      expect(await executionEntriesOf(client, twin)).toEqual(["failed"]);
      expect(
        (await verifyAuditChainInDb(client, TEST_AUDIT_HMAC_KEY)).valid,
      ).toBe(true);
      expect(await markersOf(client, twin)).toEqual([
        { event_id: poison, disposition: "execution_failed" },
      ]);
      expect(await twinPostCount(client, twin)).toEqual({
        notices: 0,
        sends: 0,
      });
      twin.bundle.close();
    });
  });

  it("...and an INFRASTRUCTURE failure inside an execution still stops the pass — the predicate's other side", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const pending = await repWrites(client, twin, "¿qué falta hoy?");
      // THE SEAM REFUSING, planted as itself: a real Postgres pool naming a
      // database that does not exist, so the borrow every execution makes
      // fails. Nothing is mocked (ADR-0028) and nothing about it is an
      // execution outcome — there is no record to write and no entry to
      // append — so it must reach the loop.
      const absent = new URL(TEST_DATABASE_URL);
      absent.pathname = "/dito_no_such_database_240";
      const unreachable = new pg.Pool({ connectionString: absent.href, max: 1 });
      try {
        const { deps } = depsFor(client, twin, qaSilenceTurns(), {
          executionPool: unreachable,
        });
        await expect(processPendingWaEvents(deps)).rejects.toThrow(
          /does not exist/u,
        );
      } finally {
        await unreachable.end();
      }

      // No record, no entry, no marker: the row is still pending, which is
      // what a broken rig is supposed to leave behind.
      expect(await executionsOf(client, twin)).toEqual([]);
      expect(await executionEntriesOf(client, twin)).toEqual([]);
      expect(await markersOf(client, twin)).toEqual([]);
      expect(pending).not.toBe("");
      twin.bundle.close();
    });
  });
});

describe("an opaque delivery in the rep's own thread is recorded and answered by nothing (ticket #240, boundary #225 F13/F13b; ADR-0042)", () => {
  it("both of the seam's identities are captured — no execution, no post, no system_send — while a readable message in the same pass still executes", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      // THE PAIRING BURST'S OWN SHAPE, both ways the seam identifies one:
      // `<stanza>:opaque` for a delivery whose stanza id the plane read, and
      // `opaque:<hash>` for one it could not (`opaque.ts`).
      const stanza = await insertWaOpaque(client, twin.dek, {
        twinId: twin.twinId,
        chatJid: SELF_CHAT,
        senderJid: SELF_CHAT,
        fromMe: true,
        messageId: `3EB0-T240-BURST-${randomUUID().slice(0, 8)}:opaque`,
        kind: "protocolMessage",
        reason: "no_slot",
        occurredAt: new Date("2026-09-08T09:00:00Z"),
      });
      const hashed = await insertWaOpaque(client, twin.dek, {
        twinId: twin.twinId,
        chatJid: SELF_CHAT,
        senderJid: SELF_CHAT,
        fromMe: true,
        messageId: `opaque:${randomUUID().replaceAll("-", "")}`,
        kind: "undecryptable",
        reason: "undecryptable",
        occurredAt: new Date("2026-09-08T09:00:01Z"),
      });
      const readable = await repWrites(
        client,
        twin,
        "¿me pasas el pendiente de hoy?",
        new Date("2026-09-08T09:00:02Z"),
      );

      // ONE SCRIPT, FOR ONE EXECUTION. An opaque delivery that still
      // submitted a thread execution would ask the wire for turns the
      // readable message's script has already spent, and the run would fail
      // loudly — so the script's length is itself an assertion.
      const { deps, requests } = depsFor(client, twin, qaSilenceTurns());
      expect(await processPendingWaEvents(deps)).toEqual({
        processed: 3,
        drafted: 0,
      });

      // ONE EXECUTION, for the message the twin could read — and the wire was
      // asked for exactly the two rounds that one thread execution makes.
      expect(requests).toHaveLength(2);
      expect(
        (await executionsOf(client, twin)).map((row) => row.trigger_kind),
      ).toEqual(["twin_thread_message"]);
      expect(await executionEntriesOf(client, twin)).toEqual(["no-action"]);

      // NOTHING POSTED AND NOTHING SENT — the 26 system sends and 20
      // near-identical Inicio cards of link day, at their source.
      expect(await twinPostCount(client, twin)).toEqual({
        notices: 0,
        sends: 0,
      });

      // BOTH ROWS ARE IN TWIN MEMORY, as the placeholder beat ADR-0042's row
      // invariant asks for — recorded, never answered.
      expect(
        twin.bundle
          .readConversation(SELF_CHAT)
          .filter((row) => row.opaqueKind !== undefined)
          .map((row) => row.content),
      ).toEqual(["[mensaje que no se pudo leer]", "[mensaje que no se pudo leer]"]);

      expect(await markersOf(client, twin)).toEqual([
        { event_id: stanza, disposition: "captured" },
        { event_id: hashed, disposition: "captured" },
        { event_id: readable, disposition: "deliberate_silence" },
      ]);
      twin.bundle.close();
    });
  });
});

/**
 * WHAT THE DRAFT POST'S PART NAMES, AS STORED (ticket #298; boundary #270,
 * F5). The canvas card reads the part and the thread reads the frame, so the
 * two surfaces agree only if the part carries the frame's own rendering of
 * the counterparty — read here off the sealed parts, not through the feed,
 * whose read-time naming would hide a write that left the name out.
 */
describe("the draft post's part names its counterparty as the frame does (ticket #298)", () => {
  async function draftOf(
    client: pg.Client,
    twin: { twinId: string; dek: Dek; bundle: Bundle },
    pushName: string | undefined,
  ): Promise<{ counterparty: string | undefined; frame: string }> {
    await insertWaEvent(client, twin.dek, {
      twinId: twin.twinId,
      chatJid: CHAT,
      senderJid: CHAT,
      fromMe: false,
      messageId: `3EB0-298-${randomUUID()}`,
      text: "¿me lo puedes cotizar?",
      ...(pushName === undefined ? {} : { pushName }),
    });
    const { deps } = depsFor(client, twin, draftingTurns(true));
    await processPendingWaEvents(deps);
    const res = await client.query<{ parts_enc: Buffer; post_enc: Buffer }>(
      `SELECT p.parts_enc, d.post_enc FROM posts p JOIN drafts d ON d.id = p.draft_id
        WHERE p.twin_id = $1`,
      [twin.twinId],
    );
    expect(res.rows).toHaveLength(1);
    // THE TWIN'S SENTENCE LEADS THE POST (ticket #368); the frame line follows it.
    const part = openSealedParts(twin.dek, res.rows[0]!.parts_enc).find((one) => one.kind === "draft");
    if (part?.kind !== "draft") throw new Error("the draft post carries no draft part");
    const frame = Buffer.from(twin.dek.decrypt(res.rows[0]!.post_enc))
      .toString("utf8")
      .split("\n")
      .find((line) => line.startsWith("*Borrador"))!;
    return { counterparty: part.counterparty, frame };
  }

  it("an unbound chat with no push name: the number, marked «(sin confirmar)»", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const { counterparty, frame } = await draftOf(client, twin, undefined);
      expect(counterparty).toBe("5215550001 (sin confirmar)");
      expect(frame).toBe("*Borrador — para 5215550001 (sin confirmar)*");
      twin.bundle.close();
    });
  });

  it("an unbound chat with a push name: the push name, marked «(sin confirmar)»", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const { counterparty, frame } = await draftOf(client, twin, "Sra. Garza");
      expect(counterparty).toBe("Sra. Garza (sin confirmar)");
      expect(frame).toBe("*Borrador — para Sra. Garza (sin confirmar)*");
      twin.bundle.close();
    });
  });

  it("a bound chat: the confirmed name alone", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      twin.bundle.confirmChatBinding({
        chatJid: CHAT,
        entityId: randomUUID(),
        displayName: "Ferretería Garza",
        confirmedAt: "2026-08-27T16:00:00.000Z",
      });
      const { counterparty, frame } = await draftOf(client, twin, "Sra. Garza");
      expect(counterparty).toBe("Ferretería Garza");
      expect(frame).toBe("*Borrador — para Ferretería Garza*");
      twin.bundle.close();
    });
  });
});
