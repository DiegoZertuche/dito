/**
 * The chat trigger batches (ticket #75). Three customer messages in
 * succession used to produce three drafts, three model calls, and two
 * dismissals for the rep — «this causes too much churn to the rep» (#69,
 * finding 2). A burst is one conversational turn, and a turn earns one
 * draft.
 *
 * Tested across the pre-agreed Postgres seam (spec #18): `wa_events` in,
 * drafts out, the model scripted at the model boundary. The model
 * client's REQUEST COUNT is asserted here on purpose — «three calls became
 * one» is the ticket's whole point, so how many times the model was called
 * is behaviour at this seam, not an implementation detail.
 *
 * The settle window is a PREDICATE OVER TIMESTAMPS, never an in-memory
 * timer, so these suites drive it with real elapsed time against real
 * `wa_events.received_at` rows rather than a fake clock.
 *
 * Governing ADRs: 0006 (the marker is the lock — batching must not weaken
 * it), 0014, 0016.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBundle, type Bundle } from "@dito/bundle";
import { createDekFromMaterial, type Dek } from "@dito/crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  processPendingWaEvents,
  UnsupportedEventTypeError,
  type TwinRuntimeDeps,
} from "./consumer.js";
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
import { closeScriptedModels, scriptedModel, type ScriptedTurn, promptOf,
  type Script,
} from "./testing/scripted-model.js";
import { newExecutionPool } from "./testing/execution-pool.js";

// Every scripted model this suite opened is closed with it (#328).
afterAll(closeScriptedModels);

/** One connection source for every execution this suite runs (ticket #173). */
const executionPool = newExecutionPool();

const SELF_CHAT = "5215550000@s.whatsapp.net";
const CHAT = "5215550001@s.whatsapp.net";
const DRAFT_TEXT = "claro, 50 bultos para el lunes";

/** One scripted needs-answer decision: the tool call, then the closing turn. */
function draftingTurns(needsAnswer = true): ScriptedTurn[] {
  return needsAnswer
    ? [
        { toolCall: { name: "create_draft", input: { text: DRAFT_TEXT } } },
        { text: "done" },
      ]
    : [{ text: "" }];
}

/**
 * The requests ONE drafting decision makes through the real SDK child:
 * the turn that calls the tool, and the turn that closes after its result.
 * Two drafts would be four — and would exhaust a one-decision script.
 */
const REQUESTS_PER_MODEL_CALL = 2;

let tmp: string;
let pool: pg.Pool;

beforeAll(async () => {
  await resetAndMigrate();
  tmp = mkdtempSync(join(tmpdir(), "dito-batching-int-"));
  pool = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 4 });
});

afterAll(async () => {
  await pool.end();
  removeTmpDir(tmp);
});

interface Twin {
  readonly twinId: string;
  readonly companyId: string;
  readonly seatId: string;
  readonly dek: Dek;
  readonly bundle: Bundle;
}

function freshTwin(): Twin {
  const twinId = randomUUID();
  const dek = createDekFromMaterial(randomBytes(32));
  const bundle = createBundle(join(tmp, `${twinId}.bundle`), dek);
  return { twinId, companyId: randomUUID(), seatId: randomUUID(), dek, bundle };
}

function depsFor(
  client: pg.Client,
  twin: Twin,
  turns: Script,
  window: {
    settleWindowMs?: number;
    batchCeilingMs?: number;
    historyLimit?: number;
    /** The REAL send-lock writer, for the one test that taps a draft. */
    live?: boolean;
  } = {},
): { deps: TwinRuntimeDeps; requests: Record<string, unknown>[] } {
  const { live, ...limits } = window;
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
      drafting: { model: "claude-sonnet-5" },
      executionPool,
      sendLock: (live ?? false)
        ? createSendLockWriter({ pool, hmacKey: TEST_AUDIT_HMAC_KEY })
        : neverSendLock(),
      hmacKey: TEST_AUDIT_HMAC_KEY,
      embedder: fakeEmbedder(),
      ...limits,
    },
  };
}

/** Rig provisioning: what a twin needs before it can send or remember a chat. */
async function provision(
  client: pg.Client,
  twin: Twin,
  chatJid: string,
): Promise<void> {
  await client.query(
    "INSERT INTO send_allowlist (twin_id, destination_jid) VALUES ($1, $2)",
    [twin.twinId, chatJid],
  );
  await client.query(
    `INSERT INTO pacing_thresholds (twin_id, max_sends_per_hour, min_seconds_between_sends)
     VALUES ($1, $2, 0)`,
    [twin.twinId, CONSERVATIVE_DEV_PACING.maxSendsPerHour],
  );
  await client.query(
    "INSERT INTO scope_allowlist (twin_id, chat_jid) VALUES ($1, $2)",
    [twin.twinId, chatJid],
  );
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** The user turn the drafting call actually sent, as the model saw it. */
function userTurnOf(requests: Record<string, unknown>[]): string {
  return promptOf(requests[0]!);
}

/** The heading that opens the new-messages block — the seam of the prompt's two halves. */
const NEW_BLOCK_HEADING = "NEW — unanswered messages from the counterparty";

/** The prompt split at that heading: everything before it, everything after. */
function contextAndNewBlocks(userTurn: string): [string, string] {
  const at = userTurn.indexOf(NEW_BLOCK_HEADING);
  expect(at, "the prompt has no new-messages block").toBeGreaterThan(-1);
  return [userTurn.slice(0, at), userTurn.slice(at)];
}

describe("the chat trigger batches a burst into one draft (ticket #75)", () => {
  it("three customer messages inside the settle window produce exactly one draft and one model call, and the draft is written against all three", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const settleWindowMs = 400;
      const burst = [
        ["3EB0-B1-1", "te pido 50 bultos"],
        ["3EB0-B1-2", "para el lunes"],
        ["3EB0-B1-3", "y me confirmas el precio porfa"],
      ] as const;
      const eventIds: string[] = [];
      for (const [messageId, text] of burst) {
        eventIds.push(
          await insertWaEvent(client, twin.dek, {
            twinId: twin.twinId,
            chatJid: CHAT,
            senderJid: CHAT,
            fromMe: false,
            messageId,
            text,
            pushName: "Sra. Garza",
          }),
        );
      }

      // Inside the window the burst is not consumed at all: no draft, no
      // model call, and — the exactly-once half — no marker either, so the
      // events are still there to be drafted against.
      const early = depsFor(client, twin, draftingTurns(), { settleWindowMs });
      expect(await processPendingWaEvents(early.deps)).toEqual({
        processed: 0,
        drafted: 0,
      });
      expect(early.requests).toHaveLength(0);

      await sleep(settleWindowMs + 150);

      // The script holds exactly ONE decision: a second drafting call would
      // exhaust it and fail loudly.
      const settled = depsFor(client, twin, draftingTurns(), {
        settleWindowMs,
      });
      expect(await processPendingWaEvents(settled.deps)).toEqual({
        processed: 3,
        drafted: 1,
      });
      expect(settled.requests).toHaveLength(REQUESTS_PER_MODEL_CALL);

      const drafts = await client.query(
        "SELECT id, destination FROM drafts WHERE twin_id = $1",
        [twin.twinId],
      );
      expect(drafts.rows).toHaveLength(1);
      expect(drafts.rows[0]!.destination).toBe(CHAT);

      // One system_send carrying the draft to the twin thread. (The chat is
      // unbound and the payload carries a push-name, so the once-ever
      // binding question rides along in the same transaction — #34's
      // behaviour, unchanged by batching.)
      const commands = await client.query(
        "SELECT id FROM send_commands WHERE twin_id = $1 AND draft_id = $2",
        [twin.twinId, drafts.rows[0]!.id],
      );
      expect(commands.rows).toHaveLength(1);

      // Every message of the burst reached the one model call — «te pido 50
      // bultos» then «para el lunes» must both be in the draft's evidence.
      const userTurn = userTurnOf(settled.requests);
      for (const [, text] of burst) expect(userTurn).toContain(text);

      // Every event of the burst is marked, exactly once, in the one
      // transaction that emitted the draft (ADR-0006's shape).
      const marks = await client.query<{ event_id: string; disposition: string }>(
        `SELECT event_id, disposition FROM wa_event_processing
          WHERE twin_id = $1 ORDER BY event_id`,
        [twin.twinId],
      );
      expect(marks.rows.map((r) => r.event_id)).toEqual(eventIds);
      // One draft, one 'drafted' marker: the anchor is the message that
      // closed the turn, and the rest say what actually happened to them.
      expect(marks.rows.map((r) => r.disposition)).toEqual([
        "drafted_in_batch",
        "drafted_in_batch",
        "drafted",
      ]);

      twin.bundle.close();
    });
  });

  it("the prompt keeps prior context and the new unresponded messages apart: the turn appears only under the new heading, and settled traffic only above it", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const settleWindowMs = 400;
      const SETTLED = "el flete a Saltillo lo pagamos nosotros";
      const NEW_FIRST = "te pido 50 bultos";
      const NEW_SECOND = "para el lunes";

      // Prior traffic, already answered: it goes in as backfill so it can
      // never itself be part of a turn, and it lands in twin memory as the
      // transcript this chat already has.
      await insertWaEvent(client, twin.dek, {
        twinId: twin.twinId,
        chatJid: CHAT,
        senderJid: CHAT,
        fromMe: false,
        messageId: "3EB0-B2-OLD",
        text: SETTLED,
        backfill: true,
        occurredAt: new Date("2026-08-29T10:00:00Z"),
      });
      await processPendingWaEvents(depsFor(client, twin, []).deps);

      for (const [messageId, text] of [
        ["3EB0-B2-1", NEW_FIRST],
        ["3EB0-B2-2", NEW_SECOND],
      ] as const) {
        await insertWaEvent(client, twin.dek, {
          twinId: twin.twinId,
          chatJid: CHAT,
          senderJid: CHAT,
          fromMe: false,
          messageId,
          text,
          occurredAt: new Date("2026-08-30T09:00:00Z"),
        });
      }
      await sleep(settleWindowMs + 150);

      const { deps, requests } = depsFor(client, twin, draftingTurns(), {
        settleWindowMs,
      });
      expect(await processPendingWaEvents(deps)).toEqual({
        processed: 2,
        drafted: 1,
      });

      const [context, newBlock] = contextAndNewBlocks(userTurnOf(requests));

      // Prior context is above the heading, and the turn is not: a message
      // the twin must answer can never be read as one it already handled.
      expect(context).toContain(SETTLED);
      expect(context).not.toContain(NEW_FIRST);
      expect(context).not.toContain(NEW_SECOND);

      // The turn is below it, whole and in order — and the settled line is
      // not repeated there under a second heading.
      expect(newBlock).toContain(`1. ${NEW_FIRST}`);
      expect(newBlock).toContain(`2. ${NEW_SECOND}`);
      expect(newBlock).not.toContain(SETTLED);

      twin.bundle.close();
    });
  });

  it("a message arriving after the draft is posted starts a NEW window rather than being folded into a draft the rep has not acted on", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const settleWindowMs = 400;
      const FIRST = "¿me mandas 40 cajas para el jueves?";
      const SECOND = "ah, y súmale 10 bultos de cemento";

      await insertWaEvent(client, twin.dek, {
        twinId: twin.twinId,
        chatJid: CHAT,
        senderJid: CHAT,
        fromMe: false,
        messageId: "3EB0-B3-1",
        text: FIRST,
        occurredAt: new Date("2026-08-30T09:00:00Z"),
      });
      await sleep(settleWindowMs + 150);
      const first = depsFor(client, twin, draftingTurns(), { settleWindowMs });
      expect(await processPendingWaEvents(first.deps)).toEqual({
        processed: 1,
        drafted: 1,
      });

      // The draft is posted and the rep has not touched it. A late message
      // cannot join it: `drafts` are immutable (ADR-0006 — a tap must
      // release exactly the text the rep read), so folding it in would mean
      // either rewriting a posted draft or dropping the message. It starts
      // its own window instead, and earns its own draft.
      const secondEventId = await insertWaEvent(client, twin.dek, {
        twinId: twin.twinId,
        chatJid: CHAT,
        senderJid: CHAT,
        fromMe: false,
        messageId: "3EB0-B3-2",
        text: SECOND,
        occurredAt: new Date("2026-08-30T09:05:00Z"),
      });
      const early = depsFor(client, twin, draftingTurns(), { settleWindowMs });
      expect(await processPendingWaEvents(early.deps)).toEqual({
        processed: 0,
        drafted: 0,
      });
      expect(early.requests).toHaveLength(0);

      await sleep(settleWindowMs + 150);
      const second = depsFor(client, twin, draftingTurns(), { settleWindowMs });
      expect(await processPendingWaEvents(second.deps)).toEqual({
        processed: 1,
        drafted: 1,
      });

      const drafts = await client.query(
        "SELECT in_reply_to_event_id FROM drafts WHERE twin_id = $1 ORDER BY created_at",
        [twin.twinId],
      );
      expect(drafts.rows).toHaveLength(2);
      expect(drafts.rows[1]!.in_reply_to_event_id).toBe(secondEventId);

      // Nothing was lost and nothing was silently folded: the second draft
      // answers the late message, with the already-answered one as context.
      const [context, newBlock] = contextAndNewBlocks(userTurnOf(second.requests));
      expect(newBlock).toContain(`1. ${SECOND}`);
      expect(newBlock).not.toContain(FIRST);
      expect(context).toContain(FIRST);

      twin.bundle.close();
    });
  });

  it("the rep answering by hand cancels the pending draft — the model is never called — while anything the customer says afterwards still earns one", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const settleWindowMs = 400;
      const asked = [
        ["3EB0-B4-1", "¿tienen cemento en existencia?", "2026-08-30T09:00:00Z"],
        ["3EB0-B4-2", "lo necesito para el lunes", "2026-08-30T09:00:30Z"],
      ] as const;
      const askedIds: string[] = [];
      for (const [messageId, text, at] of asked) {
        askedIds.push(
          await insertWaEvent(client, twin.dek, {
            twinId: twin.twinId,
            chatJid: CHAT,
            senderJid: CHAT,
            fromMe: false,
            messageId,
            text,
            occurredAt: new Date(at),
          }),
        );
      }
      // The rep picks up their own phone and answers, inside the window.
      const repEventId = await insertWaEvent(client, twin.dek, {
        twinId: twin.twinId,
        chatJid: CHAT,
        senderJid: SELF_CHAT,
        fromMe: true,
        messageId: "3EB0-B4-REP",
        text: "sí tenemos, el lunes sin problema",
        occurredAt: new Date("2026-08-30T09:01:00Z"),
      });
      await sleep(settleWindowMs + 150);

      // NO scripted turns at all: a drafting call here would fail loudly.
      // A draft for something the rep has already answered is churn by
      // definition, and it costs a model call to produce.
      const cancelled = depsFor(client, twin, [], { settleWindowMs });
      expect(await processPendingWaEvents(cancelled.deps)).toEqual({
        processed: 3,
        drafted: 0,
      });
      expect(cancelled.requests).toHaveLength(0);
      expect(
        (await client.query("SELECT id FROM drafts WHERE twin_id = $1", [
          twin.twinId,
        ])).rows,
      ).toHaveLength(0);

      const marks = await client.query<{ event_id: string; disposition: string }>(
        `SELECT event_id, disposition FROM wa_event_processing
          WHERE twin_id = $1 ORDER BY event_id`,
        [twin.twinId],
      );
      expect(marks.rows).toEqual([
        { event_id: askedIds[0], disposition: "answered_by_rep" },
        { event_id: askedIds[1], disposition: "answered_by_rep" },
        // The rep's own message keeps the disposition it always had — the
        // matcher's raw material, untouched by batching.
        { event_id: repEventId, disposition: "captured" },
      ]);

      // …and the conversation goes on: what the customer says AFTER the
      // rep's reply is unanswered, so it drafts.
      await insertWaEvent(client, twin.dek, {
        twinId: twin.twinId,
        chatJid: CHAT,
        senderJid: CHAT,
        fromMe: false,
        messageId: "3EB0-B4-3",
        text: "¿y me lo puedes dejar en 180?",
        occurredAt: new Date("2026-08-30T09:02:00Z"),
      });
      await sleep(settleWindowMs + 150);
      const after = depsFor(client, twin, draftingTurns(), { settleWindowMs });
      expect(await processPendingWaEvents(after.deps)).toEqual({
        processed: 1,
        drafted: 1,
      });
      expect(after.requests).toHaveLength(REQUESTS_PER_MODEL_CALL);

      twin.bundle.close();
    });
  });

  it("a chatty customer cannot defer their draft forever: the window resets on every message, but the ceiling from the oldest one fires anyway", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      // A window no single gap ever closes, and a ceiling the run outlives.
      const settleWindowMs = 600;
      const batchCeilingMs = 1200;
      const window = { settleWindowMs, batchCeilingMs };
      const gap = 300;

      const send = async (n: number): Promise<void> => {
        await insertWaEvent(client, twin.dek, {
          twinId: twin.twinId,
          chatJid: CHAT,
          senderJid: CHAT,
          fromMe: false,
          messageId: `3EB0-B5-${n}`,
          text: `otra cosa más (${n})`,
          occurredAt: new Date(`2026-08-30T09:0${n}:00Z`),
        });
      };

      await send(1);
      await sleep(gap);
      await send(2);
      await sleep(gap);

      // THE RESET, proven: the first message has now waited longer than the
      // whole settle window, and it still does not draft — because the
      // window is the TURN's quiet, not any one message's age.
      const reset = depsFor(client, twin, draftingTurns(), window);
      expect(await processPendingWaEvents(reset.deps)).toEqual({
        processed: 0,
        drafted: 0,
      });
      expect(reset.requests).toHaveLength(0);

      // Keep talking. Every message resets the quiet again…
      await send(3);
      await sleep(gap);
      await send(4);
      await sleep(gap);
      await send(5);
      await sleep(gap / 2);

      // …and the ceiling ends it: the oldest message has waited long
      // enough, so the turn is drafted against everything said so far even
      // though the chat never actually went quiet.
      const ceiling = depsFor(client, twin, draftingTurns(), window);
      expect(await processPendingWaEvents(ceiling.deps)).toEqual({
        processed: 5,
        drafted: 1,
      });
      expect(ceiling.requests).toHaveLength(REQUESTS_PER_MODEL_CALL);
      const [, newBlock] = contextAndNewBlocks(userTurnOf(ceiling.requests));
      for (let n = 1; n <= 5; n += 1) {
        expect(newBlock).toContain(`otra cosa más (${n})`);
      }

      twin.bundle.close();
    });
  });

  it("turns are per chat: two customers bursting at once get one draft each, and neither chat's words reach the other's call", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const settleWindowMs = 400;
      const OTHER = "5215550009@s.whatsapp.net";
      const MINE = "me mandas 50 bultos de cemento";
      const THEIRS = "necesito 3 tambos de pintura blanca";

      for (const [chatJid, prefix, text] of [
        [CHAT, "MINE", MINE],
        [OTHER, "THEIRS", THEIRS],
      ] as const) {
        for (const n of [1, 2]) {
          await insertWaEvent(client, twin.dek, {
            twinId: twin.twinId,
            chatJid,
            senderJid: chatJid,
            fromMe: false,
            messageId: `3EB0-B6-${prefix}-${n}`,
            text: n === 1 ? text : `${text} — porfa (${prefix})`,
            occurredAt: new Date(`2026-08-30T09:0${n}:00Z`),
          });
        }
      }
      await sleep(settleWindowMs + 150);

      // A RULE, because the two chats' executions run at once and either may
      // reach the model first (`Script`).
      const { deps, requests } = depsFor(client, twin, () => draftingTurns(), {
        settleWindowMs,
      });
      expect(await processPendingWaEvents(deps)).toEqual({
        processed: 4,
        drafted: 2,
      });
      expect(requests).toHaveLength(2 * REQUESTS_PER_MODEL_CALL);

      const drafts = await client.query<{ destination: string }>(
        "SELECT destination FROM drafts WHERE twin_id = $1 ORDER BY destination",
        [twin.twinId],
      );
      expect(drafts.rows.map((r) => r.destination)).toEqual([CHAT, OTHER]);

      // One call per chat, each blind to the other — a burst never widens
      // the scope a draft is written from.
      // Found by what each call was shown, never by arrival order.
      const calls = requests.map((request) => promptOf(request));
      const mineCall = calls.find((call) => call.includes(MINE)) ?? "";
      const theirsCall = calls.find((call) => call.includes(THEIRS)) ?? "";
      expect(mineCall).toContain(MINE);
      expect(mineCall).not.toContain(THEIRS);
      expect(theirsCall).toContain(THEIRS);
      expect(theirsCall).not.toContain(MINE);

      twin.bundle.close();
    });
  });

  it("rep acts never wait on a window: a quoted reply in the twin thread is matched in the same pass a customer turn is still deferring", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const settleWindowMs = 60_000;

      const customerEventId = await insertWaEvent(client, twin.dek, {
        twinId: twin.twinId,
        chatJid: CHAT,
        senderJid: CHAT,
        fromMe: false,
        messageId: "3EB0-B7-1",
        text: "¿me mandas 40 cajas?",
      });
      // The rep quotes something in the twin thread with the tap keyword.
      // It resolves to no recorded draft post, so the matcher refuses it
      // loudly and mints nothing — which is exactly the behaviour under
      // test: the SEND PATH is untouched, and it did not wait.
      const repEventId = await insertWaEvent(client, twin.dek, {
        twinId: twin.twinId,
        chatJid: SELF_CHAT,
        senderJid: SELF_CHAT,
        fromMe: true,
        messageId: "3EB0-B7-2",
        text: "va",
        quotedMessageId: "3EB0-B7-UNKNOWN",
      });

      const { deps, requests } = depsFor(client, twin, [], { settleWindowMs });
      expect(await processPendingWaEvents(deps)).toEqual({
        processed: 1,
        drafted: 0,
      });
      expect(requests).toHaveLength(0);

      const marks = await client.query<{ event_id: string; disposition: string }>(
        "SELECT event_id, disposition FROM wa_event_processing WHERE twin_id = $1",
        [twin.twinId],
      );
      expect(marks.rows).toEqual([
        { event_id: repEventId, disposition: "affirmation_refused" },
      ]);
      // The customer's message is still pending — deferred, not consumed —
      // which is what "no event is left unprocessed because it was batched"
      // rests on: it is still selectable by the very next pass.
      const pending = await client.query(
        `SELECT e.id FROM wa_events e
           LEFT JOIN wa_event_processing p ON p.event_id = e.id
          WHERE e.twin_id = $1 AND p.event_id IS NULL`,
        [twin.twinId],
      );
      expect(pending.rows.map((r) => r.id)).toEqual([customerEventId]);

      // Nothing was minted on the send path.
      const taps = await client.query(
        "SELECT id FROM taps WHERE source_event_id = $1",
        [repEventId],
      );
      expect(taps.rows).toHaveLength(0);

      twin.bundle.close();
    });
  });

  it("NFR-2 stays honest under batching: the settle window is visible in the timings rather than hidden inside them, and the twin's own work is one model call for the whole turn", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const settleWindowMs = 500;
      for (const n of [1, 2, 3]) {
        await insertWaEvent(client, twin.dek, {
          twinId: twin.twinId,
          chatJid: CHAT,
          senderJid: CHAT,
          fromMe: false,
          messageId: `3EB0-B8-${n}`,
          text: `parte ${n} del pedido`,
          occurredAt: new Date(`2026-08-30T09:0${n}:00Z`),
        });
      }
      await sleep(settleWindowMs + 150);

      const { deps, requests } = depsFor(client, twin, draftingTurns(), {
        settleWindowMs,
      });
      expect(await processPendingWaEvents(deps)).toEqual({
        processed: 3,
        drafted: 1,
      });
      // What NFR-2's budget is actually spent on: THREE messages, ONE
      // model call. Before #75 the same traffic cost three.
      expect(requests).toHaveLength(REQUESTS_PER_MODEL_CALL);

      const timing = await client.query<{
        event_received_at: Date;
        runtime_seen_at: Date;
        draft_ready_at: Date;
      }>(
        `SELECT t.event_received_at, t.runtime_seen_at, t.draft_ready_at
           FROM draft_timings t JOIN drafts d ON d.id = t.draft_id
          WHERE d.twin_id = $1`,
        [twin.twinId],
      );
      expect(timing.rows).toHaveLength(1);
      const { event_received_at, runtime_seen_at, draft_ready_at } =
        timing.rows[0]!;

      // `event_received_at` is when the TURN began — its oldest arrival —
      // so the wait the rep's customer actually experienced is in the
      // record, not hidden by re-stamping it at pick-up.
      const waited = runtime_seen_at.getTime() - event_received_at.getTime();
      expect(waited).toBeGreaterThanOrEqual(settleWindowMs);

      // And the twin's OWN work — pick-up to draft-ready, which is what
      // ADR-0016's ~1-minute budget measures — is unaffected by the wait
      // that preceded it.
      const work = draft_ready_at.getTime() - runtime_seen_at.getTime();
      expect(work).toBeGreaterThanOrEqual(0);
      expect(work).toBeLessThan(60_000);

      twin.bundle.close();
    });
  });

  it("tapping a draft does not swallow the message that arrived while the rep was deciding — only a reply the rep TYPED closes a turn (Codex r1)", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const settleWindowMs = 400;
      await provision(client, twin, CHAT);

      // Turn A arrives and is drafted.
      await insertWaEvent(client, twin.dek, {
        twinId: twin.twinId,
        companyId: twin.companyId,
        seatId: twin.seatId,
        chatJid: CHAT,
        senderJid: CHAT,
        fromMe: false,
        messageId: "3EB0-B9-A",
        text: "¿en cuánto me sale el millar?",
        occurredAt: new Date("2026-08-30T09:00:00Z"),
      });
      await sleep(settleWindowMs + 150);
      const drafting = depsFor(client, twin, draftingTurns(), {
        settleWindowMs,
        live: true,
      });
      expect(await processPendingWaEvents(drafting.deps)).toEqual({
        processed: 1,
        drafted: 1,
      });

      // The executor posts it to the twin thread, so the rep can quote it.
      const draftId = (
        await client.query<{ id: string }>(
          "SELECT id FROM drafts WHERE twin_id = $1",
          [twin.twinId],
        )
      ).rows[0]!.id;
      const systemSend = await client.query<{ id: string }>(
        `SELECT id FROM send_commands
          WHERE twin_id = $1 AND send_class = 'system_send' AND payload_ref = $2`,
        [twin.twinId, `draft:${draftId}`],
      );
      const draftPostId = "3EB0-B9-POST";
      await simulateExecutorPost(client, {
        commandId: systemSend.rows[0]!.id,
        twinId: twin.twinId,
        waMessageId: draftPostId,
      });

      // The customer says one more thing WHILE the rep is deciding. The
      // posted draft is immutable and was frozen before this existed, so it
      // cannot answer it.
      const lateEventId = await insertWaEvent(client, twin.dek, {
        twinId: twin.twinId,
        companyId: twin.companyId,
        seatId: twin.seatId,
        chatJid: CHAT,
        senderJid: CHAT,
        fromMe: false,
        messageId: "3EB0-B9-LATE",
        text: "ah, y también necesito 3 tambos de pintura",
        occurredAt: new Date("2026-08-30T09:02:00Z"),
      });

      // …and only then does the rep tap.
      await insertWaEvent(client, twin.dek, {
        twinId: twin.twinId,
        companyId: twin.companyId,
        seatId: twin.seatId,
        chatJid: SELF_CHAT,
        senderJid: SELF_CHAT,
        fromMe: true,
        messageId: "3EB0-B9-VA",
        text: "va",
        quotedMessageId: draftPostId,
        occurredAt: new Date("2026-08-30T09:03:00Z"),
      });
      const tapping = depsFor(client, twin, [], { settleWindowMs, live: true });
      await processPendingWaEvents(tapping.deps);
      const customerSend = await client.query<{ id: string }>(
        `SELECT id FROM send_commands
          WHERE twin_id = $1 AND send_class = 'customer_send' AND draft_id = $2`,
        [twin.twinId, draftId],
      );
      expect(customerSend.rows).toHaveLength(1);

      // The executor delivers it, and #63 captures it back into twin memory
      // as a `from_me` row — dated AFTER the late message. THAT is the trap:
      // counting it as "the rep replied" would mark the late message
      // answered and it would never be drafted.
      await simulateExecutorPost(client, {
        commandId: customerSend.rows[0]!.id,
        twinId: twin.twinId,
        waMessageId: "3EB0-B9-SENT",
        executedAt: new Date("2026-08-30T09:04:00Z"),
        plane: {
          dek: twin.dek,
          selfJid: SELF_CHAT,
          companyId: twin.companyId,
          seatId: twin.seatId,
        },
      });

      await sleep(settleWindowMs + 150);
      const late = depsFor(client, twin, draftingTurns(), {
        settleWindowMs,
        live: true,
      });
      await processPendingWaEvents(late.deps);

      // The late message got its own draft. It was neither lost nor folded
      // into a draft that had already gone out.
      expect(late.requests).toHaveLength(REQUESTS_PER_MODEL_CALL);
      const marks = await client.query<{ disposition: string }>(
        "SELECT disposition FROM wa_event_processing WHERE event_id = $1",
        [lateEventId],
      );
      expect(marks.rows).toEqual([{ disposition: "drafted" }]);
      const drafts = await client.query(
        "SELECT id FROM drafts WHERE twin_id = $1",
        [twin.twinId],
      );
      expect(drafts.rows).toHaveLength(2);

      twin.bundle.close();
    });
  });

  it("a turn longer than the recent window still cannot appear under both headings: its own messages are excluded from retrieval too (Codex r1)", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const settleWindowMs = 400;
      // A recent window far tighter than the burst, so the burst's earliest
      // messages sit OUTSIDE it — the case where retrieval could hand them
      // back as «older context» while they also stand under NEW.
      const historyLimit = 2;
      const burst = [1, 2, 3, 4, 5].map(
        (n) => [`3EB0-B10-${n}`, `renglón ${n} del pedido de cemento`] as const,
      );
      for (const [messageId, text] of burst) {
        await insertWaEvent(client, twin.dek, {
          twinId: twin.twinId,
          chatJid: CHAT,
          senderJid: CHAT,
          fromMe: false,
          messageId,
          text,
          occurredAt: new Date(`2026-08-30T09:0${messageId.at(-1)}:00Z`),
        });
      }
      await sleep(settleWindowMs + 150);

      const { deps, requests } = depsFor(client, twin, draftingTurns(), {
        settleWindowMs,
        historyLimit,
      });
      expect(await processPendingWaEvents(deps)).toEqual({
        processed: 5,
        drafted: 1,
      });

      const [context, newBlock] = contextAndNewBlocks(userTurnOf(requests));
      for (const [, text] of burst) {
        expect(newBlock).toContain(text);
        expect(context).not.toContain(text);
      }

      twin.bundle.close();
    });
  });

  it("a settled turn still drafts when a later event poisons the pass — a row this build cannot read stops the runtime, it does not delete a draft that was owed (Codex r2)", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const settleWindowMs = 400;

      const askedEventId = await insertWaEvent(client, twin.dek, {
        twinId: twin.twinId,
        chatJid: CHAT,
        senderJid: CHAT,
        fromMe: false,
        messageId: "3EB0-B11-1",
        text: "¿me confirmas el pedido de ayer?",
        occurredAt: new Date("2026-08-30T09:00:00Z"),
      });
      await sleep(settleWindowMs + 150);
      // A LATER row this runtime does not speak. It was a `reaction` until
      // #97 taught the runtime to speak one; it is a delivery receipt now,
      // and the property is the same either way — a row this build cannot
      // read refuses loudly and stays unconsumed, so it poisons every pass
      // from here on.
      await insertWaEvent(client, twin.dek, {
        twinId: twin.twinId,
        chatJid: CHAT,
        senderJid: CHAT,
        fromMe: false,
        messageId: "3EB0-B11-RECEIPT",
        text: "",
        eventType: "receipt",
        occurredAt: new Date("2026-08-30T09:01:00Z"),
      });

      const { deps, requests } = depsFor(client, twin, draftingTurns(), {
        settleWindowMs,
      });
      // Still fail-stop: the pass refuses, exactly as it always has.
      await expect(processPendingWaEvents(deps)).rejects.toThrow(
        UnsupportedEventTypeError,
      );
      // …but the turn that had already settled was drafted first. Before
      // this, the settle step sat behind the whole routing loop, so the
      // poison row — which stays pending forever — would have starved a
      // draft the rep was owed, on every pass and every restart.
      expect(requests).toHaveLength(REQUESTS_PER_MODEL_CALL);
      const marks = await client.query<{ disposition: string }>(
        "SELECT disposition FROM wa_event_processing WHERE event_id = $1",
        [askedEventId],
      );
      expect(marks.rows).toEqual([{ disposition: "drafted" }]);
      expect(
        (await client.query("SELECT id FROM drafts WHERE twin_id = $1", [
          twin.twinId,
        ])).rows,
      ).toHaveLength(1);

      twin.bundle.close();
    });
  });

  it("a reaction arriving mid-pass is no longer poison at all — it is consumed, and the turn it followed still drafts (ticket #97)", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const settleWindowMs = 400;

      const askedEventId = await insertWaEvent(client, twin.dek, {
        twinId: twin.twinId,
        chatJid: CHAT,
        senderJid: CHAT,
        fromMe: false,
        messageId: "3EB0-B13-1",
        text: "¿me confirmas el pedido de ayer?",
        occurredAt: new Date("2026-08-30T09:00:00Z"),
      });
      await sleep(settleWindowMs + 150);
      const reactionEventId = await insertWaReaction(client, twin.dek, {
        twinId: twin.twinId,
        chatJid: CHAT,
        senderJid: CHAT,
        fromMe: false,
        messageId: "3EB0-B13-REACTION",
        reactionTo: "3EB0-B13-1",
        emoji: "👍",
        occurredAt: new Date("2026-08-30T09:01:00Z"),
      });

      const { deps, requests } = depsFor(client, twin, draftingTurns(), {
        settleWindowMs,
      });
      // No refusal, and no second draft: the gesture is consumed as
      // context and the settled turn is answered once.
      expect(await processPendingWaEvents(deps)).toEqual({
        processed: 2,
        drafted: 1,
      });
      expect(requests).toHaveLength(REQUESTS_PER_MODEL_CALL);
      const marks = await client.query<{ event_id: string; disposition: string }>(
        `SELECT event_id, disposition FROM wa_event_processing
          WHERE event_id = ANY($1::bigint[]) ORDER BY event_id`,
        [[askedEventId, reactionEventId]],
      );
      expect(marks.rows).toEqual([
        { event_id: askedEventId, disposition: "drafted" },
        { event_id: reactionEventId, disposition: "captured" },
      ]);

      twin.bundle.close();
    });
  });

  it("a chat holding more than one turn's worth of unanswered messages drains in bounded turns — nothing is dropped, and no oversized batch can wedge the runtime (Codex r3)", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const settleWindowMs = 400;
      // The shape a runtime that was down for a long time wakes to: a
      // backlog whose quiet has long since elapsed, all of it one chat.
      const backlog = 45;
      const eventIds: string[] = [];
      for (let n = 1; n <= backlog; n += 1) {
        eventIds.push(
          await insertWaEvent(client, twin.dek, {
            twinId: twin.twinId,
            chatJid: CHAT,
            senderJid: CHAT,
            fromMe: false,
            messageId: `3EB0-B12-${String(n).padStart(2, "0")}`,
            text: `mensaje ${n} del rezago`,
            occurredAt: new Date(
              `2026-08-30T09:00:00Z`.replace("00:00Z", `${String(n).padStart(2, "0")}:00Z`),
            ),
          }),
        );
      }
      await sleep(settleWindowMs + 150);

      // Pass one takes a bounded turn — 40 of them — and answers it.
      const first = depsFor(client, twin, draftingTurns(), { settleWindowMs });
      expect(await processPendingWaEvents(first.deps)).toEqual({
        processed: 40,
        drafted: 1,
      });
      expect(first.requests).toHaveLength(REQUESTS_PER_MODEL_CALL);
      const [, firstNew] = contextAndNewBlocks(userTurnOf(first.requests));
      expect(firstNew).toContain("mensaje 1 del rezago");
      expect(firstNew).toContain("mensaje 40 del rezago");
      expect(firstNew).not.toContain("mensaje 41 del rezago");

      // …and the remainder is NOT lost: it is still pending, and the very
      // next pass drains it. The backlog empties at a bounded rate rather
      // than wedging the loop on one impossible call.
      const second = depsFor(client, twin, draftingTurns(), { settleWindowMs });
      expect(await processPendingWaEvents(second.deps)).toEqual({
        processed: backlog - 40,
        drafted: 1,
      });
      const [, secondNew] = contextAndNewBlocks(userTurnOf(second.requests));
      expect(secondNew).toContain("mensaje 41 del rezago");
      expect(secondNew).toContain(`mensaje ${backlog} del rezago`);

      // Every message reached a draft, exactly once, and the seam accounts
      // for all of them.
      const marks = await client.query<{ n: string; disposition: string }>(
        `SELECT count(*)::text AS n, disposition FROM wa_event_processing
          WHERE twin_id = $1 GROUP BY disposition ORDER BY disposition`,
        [twin.twinId],
      );
      expect(marks.rows).toEqual([
        { n: "2", disposition: "drafted" },
        { n: String(backlog - 2), disposition: "drafted_in_batch" },
      ]);

      twin.bundle.close();
    });
  });
});
