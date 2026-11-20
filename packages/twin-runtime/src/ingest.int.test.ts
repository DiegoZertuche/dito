/**
 * Live ingest into the bundle message store (ticket #31), tested across
 * the primary Postgres seam (spec #29): inject `wa_events`, assert bundle
 * contents THROUGH the bundle API plus dispositions — never bundle SQL,
 * never module internals. Real Postgres, real envelope crypto, real
 * SQLCipher (ADR-0028); the model is scripted at the model boundary.
 *
 * The properties under test are the ticket's ACs: a live in-scope seam
 * event lands in twin memory; ingest is idempotent by WhatsApp message id
 * (a re-delivered event produces exactly one row) and restart-safe (kill
 * mid-batch, resume: no loss, no dupes); every event's disposition is
 * recorded; and the drafting path is untouched (ADR-0016 — drafting stays
 * real-time, inside the NFR-2 budget). This is the one ingest path #33's
 * backfill routes through.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBundle, type Bundle } from "@dito/bundle";
import { createDekFromMaterial, type Dek } from "@dito/crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { processPendingWaEvents } from "./consumer.js";
import {
  resetAndMigrate,
  withClient,
  TEST_AUDIT_HMAC_KEY,
  TEST_DATABASE_URL,
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

// Every scripted model this suite opened is closed with it (#328).
afterAll(closeScriptedModels);

/** One connection source for every execution this suite runs (ticket #173). */
const executionPool = newExecutionPool();

const SELF_CHAT = "5215550000@s.whatsapp.net";
const CHAT = "5215550001@s.whatsapp.net";
const DRAFT_TEXT = "claro, se las mando el jueves temprano";

/** One scripted needs-answer decision (tool call + closing turn). */
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
  tmp = mkdtempSync(join(tmpdir(), "dito-ingest-int-"));
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
  overrides: { readonly executionPool?: pg.Pool } = {},
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
      executionPool: overrides.executionPool ?? executionPool,
      sendLock: neverSendLock(),
      hmacKey: TEST_AUDIT_HMAC_KEY,
      embedder: fakeEmbedder(),
    },
  };
}

describe("live ingest into the bundle message store (ticket #31)", () => {
  it("a live in-scope seam event lands in twin memory through the bundle API, its disposition recorded — and ingest invents no bindings", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const eventId = await insertWaEvent(client, twin.dek, {
        twinId: twin.twinId,
        chatJid: CHAT,
        senderJid: CHAT,
        fromMe: false,
        messageId: "3EB0-ING-1",
        text: "buenas, ¿tiene chile en polvo?",
        // The #31 hand-off's deferred wire-up (this ticket): the decoded
        // payload push-name reaches the bundle store through ingest.
        pushName: "Sra. Garza",
        occurredAt: new Date("2026-08-27T14:03:00Z"),
      });

      const { deps } = depsFor(client, twin, draftingTurns(false));
      expect(await processPendingWaEvents(deps)).toEqual({
        processed: 1,
        drafted: 0,
      });

      // Through the bundle API only — the message store holds the event.
      expect(twin.bundle.readConversation(CHAT)).toEqual([
        {
          chatJid: CHAT,
          messageId: "3EB0-ING-1",
          senderJid: CHAT,
          fromMe: false,
          occurredAt: "2026-08-27T14:03:00.000Z",
          content: "buenas, ¿tiene chile en polvo?",
          pushName: "Sra. Garza",
        },
      ]);
      // Ingest stores the message and its vector (#32: messages embed at
      // ingest), and nothing else — bindings stay the rep's to confirm
      // (#34 fills the mirror).
      expect(twin.bundle.listChatBindings()).toEqual([]);
      expect(twin.bundle.countMessageVectors()).toBe(1);

      const marks = await client.query(
        "SELECT disposition FROM wa_event_processing WHERE event_id = $1 AND twin_id = $2",
        [eventId, twin.twinId],
      );
      expect(marks.rows).toEqual([{ disposition: "no_answer_needed" }]);
      twin.bundle.close();
    });
  });

  it("ingest is idempotent by WhatsApp message id: a re-delivered event (distinct external id, same message) stores exactly one row, each delivery disposed", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      // The same self-chat note delivered twice with DIFFERENT external
      // event ids — the re-delivery signature the seam's (source,
      // external_event_id) dedupe cannot catch (#33's live/backfill
      // overlap has the same shape). The bundle's message-id rule must.
      const note = {
        twinId: twin.twinId,
        chatJid: SELF_CHAT,
        senderJid: SELF_CHAT,
        fromMe: true,
        messageId: "3EB0-REDELIV-1",
        text: "apuntar: 20 cajas para la sra garza",
        occurredAt: new Date("2026-08-27T15:00:00Z"),
      };
      await insertWaEvent(client, twin.dek, note);
      await insertWaEvent(client, twin.dek, {
        ...note,
        externalEventId: `${SELF_CHAT}:3EB0-REDELIV-1:redelivery`,
      });

      // Since #35 routing became total, an unquoted self-chat note IS twin
      // input — it reaches the Q&A call, which meets a note-to-self with
      // deliberate silence. Both deliveries are routed; neither drafts,
      // and the ingest idempotence this test is about is untouched.
      // A RULE, because the two deliveries run at once (`Script`).
      const { deps, requests } = depsFor(client, twin, () => qaSilenceTurns());
      expect(await processPendingWaEvents(deps)).toEqual({
        processed: 2,
        drafted: 0,
      });
      // No DRAFTING call was made: the model saw the Q&A tools only.
      expect(
        requests.every((r) => !JSON.stringify(r).includes("## chat binding")),
      ).toBe(true);

      // Exactly one message in twin memory; both deliveries disposed.
      expect(twin.bundle.readConversation(SELF_CHAT)).toHaveLength(1);
      const marks = await client.query(
        "SELECT disposition FROM wa_event_processing WHERE twin_id = $1",
        [twin.twinId],
      );
      expect(marks.rows).toEqual([
        { disposition: "deliberate_silence" },
        { disposition: "deliberate_silence" },
      ]);
      twin.bundle.close();
    });
  });

  it("restart-safe: killed mid-batch after the bundle write, a resume loses nothing and duplicates nothing", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const messages = ["3EB0-KILL-1", "3EB0-KILL-2", "3EB0-KILL-3"];
      for (const [i, messageId] of messages.entries()) {
        await insertWaEvent(client, twin.dek, {
          twinId: twin.twinId,
          chatJid: CHAT,
          senderJid: CHAT,
          fromMe: false,
          messageId,
          text: `¿me manda el pedido ${i + 1}?`,
          occurredAt: new Date(`2026-08-27T16:0${i}:00Z`),
        });
      }

      // Pass 1 is killed mid-pass, and the kill has to be INFRASTRUCTURE for
      // the pass to die at all: the seam refuses the borrow every execution
      // makes, so the pass ends AFTER all three bundle writes (twin memory
      // first) and BEFORE any marker, which is the crash signature. Since
      // ticket #75 the three are ONE turn and one call, so the kill lands
      // there rather than between per-message calls; the property under test
      // is unchanged.
      //
      // WHY NOT AN EXHAUSTED SCRIPT, which is how this used to be killed: a
      // model call the wire refuses is an execution's own ENDING now
      // (`execution-failure.ts`, ticket #240), so the run would be recorded,
      // its turn consumed, and the pass would finish — a resume with nothing
      // left to resume. Real Postgres refusing a database that does not exist
      // is the honest kill (ADR-0028: nothing here is mocked).
      const absent = new URL(TEST_DATABASE_URL);
      absent.pathname = "/dito_no_such_database_ingest";
      const unreachable = new pg.Pool({ connectionString: absent.href, max: 1 });
      const killed = depsFor(client, twin, [], { executionPool: unreachable });
      try {
        await expect(processPendingWaEvents(killed.deps)).rejects.toThrow(
          /does not exist/u,
        );
      } finally {
        await unreachable.end();
      }
      expect(twin.bundle.readConversation(CHAT)).toHaveLength(3);
      const marked = await client.query(
        "SELECT count(*)::int AS n FROM wa_event_processing WHERE twin_id = $1",
        [twin.twinId],
      );
      expect(marked.rows[0].n).toBe(0);

      // Resume: the three unmarked events process — each replays onto its
      // already-stored row (no dupe), none is lost, and the turn they make
      // up drafts exactly once.
      const resumed = depsFor(client, twin, draftingTurns(true));
      expect(await processPendingWaEvents(resumed.deps)).toEqual({
        processed: 3,
        drafted: 1,
      });

      expect(
        twin.bundle.readConversation(CHAT).map((r) => r.messageId),
      ).toEqual(messages);
      const drafts = await client.query(
        "SELECT count(*)::int AS n FROM drafts WHERE twin_id = $1",
        [twin.twinId],
      );
      expect(drafts.rows[0].n).toBe(1);
      const marks = await client.query(
        "SELECT disposition FROM wa_event_processing WHERE twin_id = $1 ORDER BY event_id",
        [twin.twinId],
      );
      expect(marks.rows).toEqual([
        { disposition: "drafted_in_batch" },
        { disposition: "drafted_in_batch" },
        { disposition: "drafted" },
      ]);
      twin.bundle.close();
    });
  });

  it("the drafting path is untouched: a live in-scope inbound still drafts, timed inside the NFR-2 budget (ADR-0016 regression)", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const eventId = await insertWaEvent(client, twin.dek, {
        twinId: twin.twinId,
        chatJid: CHAT,
        senderJid: CHAT,
        fromMe: false,
        messageId: "3EB0-NFR2-1",
        text: "¿me mandas 40 cajas para el jueves?",
      });

      const { deps } = depsFor(client, twin, draftingTurns(true));
      expect(await processPendingWaEvents(deps)).toEqual({
        processed: 1,
        drafted: 1,
      });

      // The full slice-1 emission, unchanged: draft + its system_send to
      // the self-chat + the content-free timing, disposition 'drafted'.
      const drafts = await client.query(
        "SELECT id, destination, in_reply_to_event_id FROM drafts WHERE twin_id = $1",
        [twin.twinId],
      );
      expect(drafts.rows).toHaveLength(1);
      expect(drafts.rows[0].destination).toBe(CHAT);
      expect(drafts.rows[0].in_reply_to_event_id).toBe(eventId);
      const commands = await client.query(
        "SELECT send_class, destination FROM send_commands WHERE twin_id = $1",
        [twin.twinId],
      );
      expect(commands.rows).toEqual([
        { send_class: "system_send", destination: SELF_CHAT },
      ]);

      // The regression bound: seam receipt → draft ready stays inside the
      // ~1-minute NFR-2 budget (the honest rig measurement is the slice
      // boundary's; this pins that ingest added no stall to the path).
      const timing = await client.query(
        `SELECT extract(epoch FROM (t.draft_ready_at - t.event_received_at)) AS s
           FROM draft_timings t JOIN drafts d ON d.id = t.draft_id
          WHERE d.twin_id = $1`,
        [twin.twinId],
      );
      expect(timing.rows).toHaveLength(1);
      expect(Number(timing.rows[0].s)).toBeLessThan(60);
      twin.bundle.close();
    });
  });
});
