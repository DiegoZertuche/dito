/**
 * Context-aware drafting (ticket #35; spec #29 decision 11, story 18):
 * drafts stop being amnesiac. The drafting call's context grows from the
 * recent transcript to RETRIEVED conversation context over twin memory —
 * the same retrieval the Q&A uses, the same seam, the same scripted-model
 * testing.
 *
 * The property that matters is the one the rep sees: a draft that reads
 * like the rep wrote it after reading the thread. Across the primary
 * Postgres seam we can assert the mechanism honestly — the retrieved
 * context REACHES the model call, and the sentence the rep reads above the
 * draft carries it — while leaving prose judgment to the rig (ADR-0028: draft prose is
 * never asserted in CI).
 */
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBundle, type Bundle } from "@dito/bundle";
import { createDekFromMaterial, type Dek } from "@dito/crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { processPendingWaEvents, type TwinRuntimeDeps } from "./consumer.js";
import {
  resetAndMigrate,
  withClient,
  TEST_AUDIT_HMAC_KEY,
} from "./testing/db.js";
import { removeTmpDir } from "./testing/tmp.js";
import { fakeEmbedder } from "./testing/fake-embedder.js";
import { neverSendLock } from "./testing/never-writer.js";
import { insertWaEvent } from "./testing/seam-fixtures.js";
import { openSealedParts } from "./posts.js";
import {
  closeScriptedModels,
  scriptedModel,
  toolResultsOf,
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
const PUSH_NAME = "Sra. Garza";

/** The fact that lives ONLY in old backfilled history, far outside the recent window. */
const OLD_FACT = "el flete a Saltillo lo pagamos nosotros";
const SENTENCE = "Le contesté que el flete corre por nuestra cuenta, como ya habíamos acordado para Saltillo.";

let tmp: string;

beforeAll(async () => {
  await resetAndMigrate();
  tmp = mkdtempSync(join(tmpdir(), "dito-draftctx-int-"));
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
      // Ticket #75: this suite is not about batching (see testing/settle.ts).
      ...SETTLE_IMMEDIATELY,
      drafting: { model: "claude-sonnet-5" },
      embedder: fakeEmbedder(),
      executionPool,
      sendLock: neverSendLock(),
      hmacKey: TEST_AUDIT_HMAC_KEY,
      // A deliberately TIGHT recent window: the old fact cannot reach the
      // model as recent transcript, so anything that carries it there came
      // from retrieval — the point of the test.
      historyLimit: 2,
    },
  };
}

/** The twin writes the draft, then finishes on the sentence the rep reads above it (ticket #368). */
function draftingTurns(draftText: string, sentence: string): ScriptedTurn[] {
  return [
    { toolCall: { name: "create_draft", input: { text: draftText } } },
    { text: sentence },
  ];
}

describe("context-aware drafting over twin memory (ticket #35)", () => {
  it("the drafting call carries retrieved conversation context — a fact from old backfilled history reaches the model though it is far outside the recent window", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const tag = twin.twinId.slice(0, 8);

      // Old history: the fact, plus filler that will crowd the recent
      // window. All backfilled — never drafts, only memory.
      const old: [string, string][] = [
        [`OLD-1-${tag}`, OLD_FACT],
        [`OLD-2-${tag}`, "perfecto, quedamos así"],
        [`OLD-3-${tag}`, "buen día"],
        [`OLD-4-${tag}`, "gracias"],
      ];
      for (const [messageId, text] of old) {
        await insertWaEvent(client, twin.dek, {
          twinId: twin.twinId,
          chatJid: CHAT,
          senderJid: CHAT,
          fromMe: false,
          messageId,
          text,
          pushName: PUSH_NAME,
          backfill: true,
          occurredAt: new Date("2026-07-01T10:00:00Z"),
        });
      }
      await processPendingWaEvents(depsFor(client, twin, []).deps);

      // The live inbound: it asks about the very thing the old history
      // settled, in the old fact's own words — so retrieval finds it.
      await insertWaEvent(client, twin.dek, {
        twinId: twin.twinId,
        chatJid: CHAT,
        senderJid: CHAT,
        fromMe: false,
        messageId: `LIVE-1-${tag}`,
        text: "¿el flete a Saltillo quién lo paga?",
        pushName: PUSH_NAME,
        occurredAt: new Date("2026-08-27T09:00:00Z"),
      });

      const { deps, requests } = depsFor(
        client,
        twin,
        draftingTurns("El flete a Saltillo lo pagamos nosotros.", SENTENCE),
      );
      expect(await processPendingWaEvents(deps)).toEqual({
        processed: 1,
        drafted: 1,
      });

      // The retrieved context REACHED the drafting call.
      const userTurn = JSON.stringify(requests[0]?.["messages"]);
      expect(userTurn).toContain(OLD_FACT);
      // …and it arrived as retrieved memory, distinct from the recent
      // transcript — which, at historyLimit 2, could not have carried it.
      expect(userTurn).toContain("from the rep's memory");

      // The sentence the rep reads above the draft reflects that context.
      const draft = await client.query<{ post_enc: Buffer }>(
        "SELECT post_enc FROM drafts WHERE twin_id = $1",
        [twin.twinId],
      );
      const post = Buffer.from(
        twin.dek.decrypt(draft.rows[0]!.post_enc),
      ).toString("utf8");
      expect(post).toContain(SENTENCE);
      expect(post).toContain("Saltillo");

      // NFR-2 still holds: drafting stays real-time with retrieval in the
      // path (ADR-0016). The honest measurement is the rig's; this is the
      // in-test bound the slice-1 suites established.
      const timing = await client.query<{
        event_received_at: Date;
        draft_ready_at: Date;
      }>(
        `SELECT t.event_received_at, t.draft_ready_at
           FROM draft_timings t JOIN drafts d ON d.id = t.draft_id
          WHERE d.twin_id = $1`,
        [twin.twinId],
      );
      expect(timing.rows).toHaveLength(1);
      const elapsed =
        timing.rows[0]!.draft_ready_at.getTime() -
        timing.rows[0]!.event_received_at.getTime();
      expect(elapsed).toBeLessThan(60_000);
      twin.bundle.close();
    });
  });

  it("the recent window cannot crowd the retrieved context out: the old promise still reaches the model when every top hit is a recent message", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const tag = twin.twinId.slice(0, 8);
      const INBOUND = "¿el flete a Saltillo quién lo paga?";

      // The old promise — worded differently, far outside the window.
      await insertWaEvent(client, twin.dek, {
        twinId: twin.twinId,
        chatJid: CHAT,
        senderJid: CHAT,
        fromMe: false,
        messageId: `CROWD-OLD-${tag}`,
        text: OLD_FACT,
        pushName: PUSH_NAME,
        backfill: true,
        occurredAt: new Date("2026-07-01T10:00:00Z"),
      });
      // Recent traffic that repeats the inbound's wording EXACTLY, so it
      // outranks everything: with the limit applied before the dedupe,
      // the whole retrieval page was recent and the dedupe emptied it.
      for (let i = 0; i < 5; i++) {
        await insertWaEvent(client, twin.dek, {
          twinId: twin.twinId,
          chatJid: CHAT,
          senderJid: CHAT,
          fromMe: false,
          messageId: `CROWD-RECENT-${i}-${tag}`,
          text: INBOUND,
          pushName: PUSH_NAME,
          backfill: true,
          occurredAt: new Date("2026-08-26T10:00:00Z"),
        });
      }
      await processPendingWaEvents(depsFor(client, twin, []).deps);

      await insertWaEvent(client, twin.dek, {
        twinId: twin.twinId,
        chatJid: CHAT,
        senderJid: CHAT,
        fromMe: false,
        messageId: `CROWD-LIVE-${tag}`,
        text: INBOUND,
        pushName: PUSH_NAME,
        occurredAt: new Date("2026-08-27T09:00:00Z"),
      });

      // The recent window is TIGHT, so the old fact is structurally
      // outside it: if it reaches the model it came from retrieval, never
      // from the transcript. The window still holds enough exact-match
      // rows to fill a retrieval page sized to the limit alone.
      const { harness, requests } = scriptedModel(
        draftingTurns("El flete a Saltillo lo pagamos nosotros.", SENTENCE),
      );
      await processPendingWaEvents({
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
        historyLimit: 3,
      });

      const userTurn = JSON.stringify(requests[0]?.["messages"]);
      expect(userTurn).toContain(OLD_FACT);
      // It arrived as RETRIEVED memory, not as recent transcript.
      expect(userTurn).toContain("from the rep's memory");
      twin.bundle.close();
    });
  });

  it("retrieved context is scoped to the chat being answered — another customer's conversation never leaks into a draft", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const tag = twin.twinId.slice(0, 8);
      const OTHER = "5215550009@s.whatsapp.net";
      const SECRET = "a Don Beto le damos precio especial de 180 el bulto";

      // Another customer's chat holds a message worded to be the nearest
      // neighbour of the inbound — the adversarial retrieval case.
      await insertWaEvent(client, twin.dek, {
        twinId: twin.twinId,
        chatJid: OTHER,
        senderJid: OTHER,
        fromMe: true,
        messageId: `OTHER-1-${tag}`,
        text: SECRET,
        pushName: "Don Beto",
        backfill: true,
        occurredAt: new Date("2026-07-02T10:00:00Z"),
      });
      await insertWaEvent(client, twin.dek, {
        twinId: twin.twinId,
        chatJid: CHAT,
        senderJid: CHAT,
        fromMe: false,
        messageId: `MINE-1-${tag}`,
        text: "el bulto de 180 me sirve",
        pushName: PUSH_NAME,
        backfill: true,
        occurredAt: new Date("2026-07-02T11:00:00Z"),
      });
      await processPendingWaEvents(depsFor(client, twin, []).deps);

      await insertWaEvent(client, twin.dek, {
        twinId: twin.twinId,
        chatJid: CHAT,
        senderJid: CHAT,
        fromMe: false,
        messageId: `LIVE-2-${tag}`,
        text: "¿en cuánto me deja el bulto?",
        pushName: PUSH_NAME,
        occurredAt: new Date("2026-08-27T09:10:00Z"),
      });

      const { deps, requests } = depsFor(
        client,
        twin,
        draftingTurns("Se lo dejo en 180 el bulto.", "preguntó precio del bulto"),
      );
      await processPendingWaEvents(deps);

      const userTurn = JSON.stringify(requests[0]?.["messages"]);
      // This chat's own history is there…
      expect(userTurn).toContain("el bulto de 180 me sirve");
      // …the other customer's is NOT. A draft for Sra. Garza can never be
      // written out of Don Beto's pricing.
      expect(userTurn).not.toContain(SECRET);
      expect(userTurn).not.toContain("Don Beto");
      twin.bundle.close();
    });
  });
});

describe("a draft that leaves a blank for the rep (ticket #342)", () => {
  const BODY = "Hola, los 300 bultos te quedan en ⟦precio⟧ cada uno, puestos el jueves. ¿Te los aparto?";
  const PRECIO = {
    key: "precio",
    label: "precio",
    question: "¿A cuánto le dejamos el bulto? La última vez fue a $172.",
  };

  /** A live inbound the scripted turn answers. */
  async function inbound(client: pg.Client, twin: { twinId: string; dek: Dek }): Promise<void> {
    await insertWaEvent(client, twin.dek, {
      twinId: twin.twinId,
      chatJid: CHAT,
      senderJid: CHAT,
      fromMe: false,
      messageId: `LIVE-${twin.twinId.slice(0, 8)}`,
      text: "¿me apartas 300 bultos para el jueves?",
      pushName: PUSH_NAME,
      occurredAt: new Date("2026-10-05T17:00:00Z"),
    });
  }

  /** The draft parts of every post this twin holds, opened. */
  async function draftPartsOf(client: pg.Client, twin: { twinId: string; dek: Dek }) {
    const rows = await client.query<{ parts_enc: Buffer; draft_id: string }>(
      "SELECT parts_enc, draft_id FROM posts WHERE twin_id = $1 AND draft_id IS NOT NULL",
      [twin.twinId],
    );
    return rows.rows.map((row) => ({
      draftId: row.draft_id,
      part: openSealedParts(twin.dek, row.parts_enc).find((one) => one.kind === "draft"),
    }));
  }

  it("lands a draft whose part carries the blank and whose draft_blanks row names it", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await inbound(client, twin);
      const { deps } = depsFor(client, twin, [
        { toolCall: { name: "create_draft", input: { text: BODY, blanks: [PRECIO] } } },
        { text: "done" },
      ]);
      expect(await processPendingWaEvents(deps)).toEqual({ processed: 1, drafted: 1 });

      const [landed] = await draftPartsOf(client, twin);
      // STORED UNDER THE KEY CODE GIVES IT, never the model's (Codex r2).
      expect(landed?.part).toMatchObject({ kind: "draft", blanks: [{ ...PRECIO, key: "b1" }] });
      const rows = await client.query<{ key: string }>(
        "SELECT key FROM draft_blanks WHERE draft_id = $1",
        [landed!.draftId],
      );
      expect(rows.rows).toEqual([{ key: "b1" }]);
      const body = await client.query<{ content_enc: Buffer }>("SELECT content_enc FROM drafts WHERE id = $1", [
        landed!.draftId,
      ]);
      expect(Buffer.from(twin.dek.decrypt(body.rows[0]!.content_enc)).toString("utf8")).toBe(BODY.replace("⟦precio⟧", "⟦b1⟧"));
      twin.bundle.close();
    });
  });

  it("refuses a marker no blank names as feedback, and the draft lands on the next submission", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await inbound(client, twin);
      const { deps, requests } = depsFor(client, twin, [
        { toolCall: { name: "create_draft", input: { text: BODY } } },
        { toolCall: { name: "create_draft", input: { text: BODY, blanks: [PRECIO] } } },
        { text: "done" },
      ]);
      expect(await processPendingWaEvents(deps)).toEqual({ processed: 1, drafted: 1 });

      expect(toolResultsOf(requests.at(-1))[0]).toContain(
        'the text carries ⟦precio⟧ and no blank has the key "precio"',
      );
      const parts = await draftPartsOf(client, twin);
      expect(parts.map((one) => one.part)).toMatchObject([{ kind: "draft", blanks: [{ ...PRECIO, key: "b1" }] }]);
      twin.bundle.close();
    });
  });
});

describe("a delicate draft carries its reason (ticket #343)", () => {
  const BODY = "Hola, te dejo los 300 bultos a $172 cada uno, puestos el jueves. ¿Te los aparto?";
  const REASON =
    "Le dejé $172, 8% abajo de lista, porque Torres le ofreció lo mismo la semana pasada. Si prefieres lista, la cambio.";

  async function inbound(client: pg.Client, twin: { twinId: string; dek: Dek }): Promise<void> {
    await insertWaEvent(client, twin.dek, {
      twinId: twin.twinId,
      chatJid: CHAT,
      senderJid: CHAT,
      fromMe: false,
      messageId: `LIVE-${twin.twinId.slice(0, 8)}`,
      text: "¿en cuánto me dejas los 300 bultos?",
      pushName: PUSH_NAME,
      occurredAt: new Date("2026-10-05T17:00:00Z"),
    });
  }

  /** The draft parts of every post this twin holds, opened. */
  async function draftPartsOf(client: pg.Client, twin: { twinId: string; dek: Dek }) {
    const rows = await client.query<{ parts_enc: Buffer }>(
      "SELECT parts_enc FROM posts WHERE twin_id = $1 AND draft_id IS NOT NULL",
      [twin.twinId],
    );
    return rows.rows.map((row) => openSealedParts(twin.dek, row.parts_enc).find((one) => one.kind === "draft"));
  }

  it("lands a draft whose sealed part carries the flag and the reason", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await inbound(client, twin);
      const { deps } = depsFor(client, twin, [
        { toolCall: { name: "create_draft", input: { text: BODY, delicate: true, reason: REASON } } },
        { text: "done" },
      ]);
      expect(await processPendingWaEvents(deps)).toEqual({ processed: 1, drafted: 1 });
      expect(await draftPartsOf(client, twin)).toMatchObject([{ kind: "draft", delicate: true, reason: REASON }]);
      twin.bundle.close();
    });
  });

  it("lands a plain draft with neither", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await inbound(client, twin);
      const { deps } = depsFor(client, twin, [
        { toolCall: { name: "create_draft", input: { text: BODY } } },
        { text: "done" },
      ]);
      expect(await processPendingWaEvents(deps)).toEqual({ processed: 1, drafted: 1 });
      const [part] = await draftPartsOf(client, twin);
      expect(part).toBeDefined();
      expect(part !== undefined && ("delicate" in part || "reason" in part)).toBe(false);
      twin.bundle.close();
    });
  });

  it("refuses the flag without a reason, a reason without the flag and an over-long reason as feedback, and lands the next call", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await inbound(client, twin);
      const submit = (fields: Record<string, unknown>) => ({
        toolCall: { name: "create_draft", input: { text: BODY, ...fields } },
      });
      const { deps, requests } = depsFor(client, twin, [
        submit({ delicate: true }),
        submit({ reason: REASON }),
        submit({ delicate: true, reason: `${REASON} Ya lo hablamos ayer con ella.` }),
        submit({ delicate: true, reason: REASON }),
        { text: "done" },
      ]);
      expect(await processPendingWaEvents(deps)).toEqual({ processed: 1, drafted: 1 });
      const refusals = toolResultsOf(requests.at(-1));
      expect(refusals[0]).toContain("delicate is true and reason is empty");
      expect(refusals[1]).toContain("reason is written and delicate is not true");
      expect(refusals[2]).toContain("reason runs 3 sentences");
      expect(await draftPartsOf(client, twin)).toMatchObject([{ kind: "draft", delicate: true, reason: REASON }]);
      twin.bundle.close();
    });
  });
});
