/**
 * DRAFTING AS AN EXECUTION, AT THE POSTGRES SEAM (ticket #172 AC 8; spec
 * #171 decisions 12, 14, 15 and 17).
 *
 * The pre-agreed seam (spec #18, spec #171's Testing Decisions): `wa_events`
 * fixtures in with real DEK-encrypted payloads, and out the other side the
 * draft, its post, its `system_send`, its timing, the rep-side `executions`
 * row, the entry on `public.audit_chain` and the turn's processing markers.
 * Real Postgres, real envelope crypto, real SQLCipher (ADR-0028); the model
 * is scripted at the model boundary and CI never calls one.
 *
 * WHAT THIS FILE CLAIMS AND `consumer.int.test.ts` DOES NOT. That one is
 * about the draft the rep reads; this one is about the RECORD of the run
 * that wrote it — the four dispositions AC 8 enumerates, the entry beside
 * each record, the marker a `failed` run leaves on every event of its turn
 * (ticket #240), and what the
 * execution was actually shown. Two files rather than one because the draft
 * and its execution are two claims, and a suite that made both would be
 * where either was hard to find.
 *
 * IT IS ALSO CI's MINT for the rep side's coverage class. The step after it
 * runs `audit-coverage-check --require-acts=rep_execution` over exactly what
 * this file leaves behind, so the corpus is committed on purpose and the
 * last test in the file is the one that says so.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyAuditChainInDb } from "@dito/audit";
import { createBundle, type Bundle } from "@dito/bundle";
import { createDekFromMaterial, type Dek } from "@dito/crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { processPendingWaEvents, type TwinRuntimeDeps } from "./consumer.js";
import { openSealedParts, type PostPart } from "./posts.js";
import { DRAFTING_WAKE } from "./drafting/automation.js";
import { DRAFTING_DEFINITION } from "./runs/shipped-conversations.js";
import {
  resetAndMigrate,
  withClient,
  TEST_AUDIT_HMAC_KEY,
} from "./testing/db.js";
import { fakeEmbedder } from "./testing/fake-embedder.js";
import { neverSendLock } from "./testing/never-writer.js";
import { insertWaEvent } from "./testing/seam-fixtures.js";
import {
  closeScriptedModels,
  promptOf,
  scriptedModel,
  systemOf,
  toolResultsOf,
  type Script,
  type ScriptedTurn,
} from "./testing/scripted-model.js";
import { SETTLE_IMMEDIATELY } from "./testing/settle.js";
import { removeTmpDir } from "./testing/tmp.js";
import { newExecutionPool } from "./testing/execution-pool.js";

// Every scripted model this suite opened is closed with it (#328).
afterAll(closeScriptedModels);

/** One connection source for every execution this suite runs (ticket #173). */
const executionPool = newExecutionPool();

const SELF_CHAT = "5215550000@s.whatsapp.net";
const CHAT = "5215550001@s.whatsapp.net";
const PUSH_NAME = "Sra. Garza";
const ZONE = "America/Monterrey";
const DRAFT_TEXT = "claro, 50 bultos para el lunes";
/**
 * The sentence the twin finishes its drafting turn on — the card's sentence
 * and the thread's line above the Borrador (ticket #368) — naming the
 * customer by the reference its chat binding part hands it: this suite's one
 * chat is the first a fresh bundle gives one.
 */
const SENTENCE = "Te dejé la respuesta para [c1]: pidió 50 bultos y luego fijó el lunes.";

/** The turn this file drafts against: three lines, one request (#75). */
const TURN = [
  "buenas, ¿me puede mandar 50 bultos?",
  "los de siempre",
  "para el lunes si se puede",
];

let tmp: string;

beforeAll(async () => {
  await resetAndMigrate();
  tmp = mkdtempSync(join(tmpdir(), "dito-drafting-int-"));
});

afterAll(() => {
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
  return {
    twinId,
    dek,
    bundle: createBundle(join(tmp, `${twinId}.bundle`), dek),
  };
}

function depsFor(
  client: pg.Client,
  twin: Twin,
  script: Script,
): { deps: TwinRuntimeDeps; requests: Record<string, unknown>[] } {
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
      // This file is not about batching (see testing/settle.ts).
      ...SETTLE_IMMEDIATELY,
      drafting: { model: "claude-sonnet-5" },
      embedder: fakeEmbedder(),
      executionPool,
      sendLock: neverSendLock(),
      hmacKey: TEST_AUDIT_HMAC_KEY,
      // Pinned so the «now» part and the frozen post's clock time are exact
      // wherever the suite runs — and so the two can be compared at all.
      timeZone: ZONE,
    },
  };
}

/**
 * A drafted reply: the twin writes it with `create_draft` (ticket #363), then
 * finishes on the sentence the rep reads above it (ticket #368).
 */
function draftingTurns(
  extra: Record<string, unknown> = {},
  sentence: string = SENTENCE,
): ScriptedTurn[] {
  return [
    { toolCall: { name: "create_draft", input: { text: DRAFT_TEXT, ...extra } } },
    { text: sentence },
  ];
}

/** Puts one turn of counterparty inbound on the seam, oldest first. */
async function arriveTurn(
  client: pg.Client,
  twin: Twin,
  options: { readonly lines?: readonly string[]; readonly pushName?: string } = {},
): Promise<string[]> {
  const tag = twin.twinId.slice(0, 8);
  const ids: string[] = [];
  const lines = options.lines ?? TURN;
  for (const [at, text] of lines.entries()) {
    ids.push(
      await insertWaEvent(client, twin.dek, {
        twinId: twin.twinId,
        chatJid: CHAT,
        senderJid: CHAT,
        fromMe: false,
        messageId: `TURN-${at}-${tag}`,
        text,
        ...(options.pushName === undefined ? {} : { pushName: options.pushName }),
        occurredAt: new Date(Date.UTC(2026, 8, 4, 18, at)),
      }),
    );
  }
  return ids;
}

interface ExecutionRow {
  id: string;
  twin_id: string;
  trigger_kind: string;
  trigger_mechanism: string;
  trigger_ref: string;
  instructions_digest: string;
  tool_names: string[];
  lane: string;
  iterations: number;
  tokens_input: number;
  tokens_output: number;
  disposition: string;
  started_at: Date;
  ended_at: Date;
}

async function executionsOf(
  client: pg.Client,
  twin: Twin,
): Promise<ExecutionRow[]> {
  const res = await client.query<ExecutionRow>(
    "SELECT * FROM executions WHERE twin_id = $1 ORDER BY started_at, id",
    [twin.twinId],
  );
  return res.rows;
}

/**
 * This twin's `execution` entries, in order.
 *
 * SCOPED BY THE REFERENCE, because the rep chain has no tenant column and
 * this file's tests share one database: `public.audit_chain` is one sequence
 * of links for the whole deployment (`store.ts`), and the twin is in the
 * reference `triggerRef` renders. So "this twin's entries" is a question
 * about the ref rather than about a column — which is also why the coverage
 * class counts rather than joins.
 */
async function chainEntriesOf(
  client: pg.Client,
  twin: Twin,
): Promise<{ caller: string; action: string; ref: string; outcome: string }[]> {
  const res = await client.query<{
    caller: string;
    action: string;
    ref: string;
    outcome: string;
  }>(
    `SELECT caller, action, ref, outcome FROM audit_chain
      WHERE action = 'execution' AND ref LIKE '%twin:' || $1 || '%'
      ORDER BY id`,
    [twin.twinId],
  );
  return res.rows;
}

async function markersOf(
  client: pg.Client,
  twin: Twin,
): Promise<{ event_id: string; disposition: string }[]> {
  // ORDERED BY THE COLUMN, not by the projected text: `ORDER BY event_id`
  // over a `::text` output column of the same name sorts lexicographically,
  // which puts event 10 before event 8.
  const res = await client.query<{ event_id: string; disposition: string }>(
    `SELECT p.event_id::text AS event_id, p.disposition
       FROM wa_event_processing p
      WHERE p.twin_id = $1
      ORDER BY p.event_id`,
    [twin.twinId],
  );
  return res.rows;
}

describe("a settled turn leaves a draft, a record and one chain entry (AC 8)", () => {
  it("drafts once for three messages, and records the run that wrote it", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const ids = await arriveTurn(client, twin);
      const { deps } = depsFor(client, twin, draftingTurns());

      expect(await processPendingWaEvents(deps)).toEqual({
        processed: 3,
        drafted: 1,
      });

      // ONE DRAFT for the whole turn (#75, unchanged).
      const drafts = await client.query<{
        id: string;
        in_reply_to_event_id: string;
      }>("SELECT id, in_reply_to_event_id::text FROM drafts WHERE twin_id = $1", [
        twin.twinId,
      ]);
      expect(drafts.rows).toHaveLength(1);
      // ...replying to the ANCHOR, the message that closed the turn.
      expect(drafts.rows[0]!.in_reply_to_event_id).toBe(ids[2]);

      // ONE EXECUTION ROW, `ExecutionRecord` column for column.
      const [execution, ...rest] = await executionsOf(client, twin);
      expect(rest).toEqual([]);
      expect(execution).toMatchObject({
        twin_id: twin.twinId,
        trigger_kind: "chat_turn",
        trigger_mechanism: "seam_event",
        lane: "realtime",
        disposition: "drafted",
      });
      // The tools it was GIVEN: its look, and the draft it writes with.
      expect(execution!.tool_names).toEqual(["search_memory", "create_draft"]);
      // Two model rounds: the draft, and the turn that ends after its result
      // rides back.
      expect(execution!.iterations).toBe(2);
      expect(execution!.tokens_input).toBeGreaterThan(0);
      expect(execution!.ended_at.getTime()).toBeGreaterThanOrEqual(
        execution!.started_at.getTime(),
      );

      // THE REFERENCE IS CONTENT-FREE AND JID-FREE: the twin, the anchor,
      // and how many messages the turn held. Never the chat.
      expect(execution!.trigger_ref).toBe(
        `trigger:chat_turn mechanism:seam_event twin:${twin.twinId} event:${ids[2]!} events:3`,
      );
      expect(execution!.trigger_ref).not.toContain("@");
      expect(execution!.trigger_ref).not.toContain("5215550001");

      // ONE CHAIN ENTRY, carrying the same reference plus the digest.
      const entries = await chainEntriesOf(client, twin);
      expect(entries).toEqual([
        {
          caller: "execution",
          action: "execution",
          ref: `${execution!.trigger_ref} instructions:${execution!.instructions_digest}`,
          outcome: "drafted",
        },
      ]);
      // ...and the chain AUTHENTICATES end to end under the rep key, which
      // is what makes it a chain rather than a log (ADR-0020).
      const verified = await verifyAuditChainInDb(client, TEST_AUDIT_HMAC_KEY);
      expect(verified.valid).toBe(true);
      expect(verified.entries).toBeGreaterThan(0);

      // The timing row names the execution that produced it.
      const timing = await client.query<{ execution_id: string }>(
        `SELECT t.execution_id FROM draft_timings t
           JOIN drafts d ON d.id = t.draft_id
          WHERE d.twin_id = $1`,
        [twin.twinId],
      );
      expect(timing.rows[0]!.execution_id).toBe(execution!.id);

      // The anchor carries `drafted` and the rest `drafted_in_batch` (#75).
      expect(await markersOf(client, twin)).toEqual([
        { event_id: ids[0]!, disposition: "drafted_in_batch" },
        { event_id: ids[1]!, disposition: "drafted_in_batch" },
        { event_id: ids[2]!, disposition: "drafted" },
      ]);
      twin.bundle.close();
    });
  });

  it("records a turn that needs no answer as `no-action`, and consumes it", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const ids = await arriveTurn(client, twin, { lines: ["gracias!"] });
      // THE TWIN WRITES NOTHING AND CALLS NOTHING.
      const { deps } = depsFor(client, twin, [{ text: "" }]);

      expect(await processPendingWaEvents(deps)).toEqual({
        processed: 1,
        drafted: 0,
      });

      const [execution] = await executionsOf(client, twin);
      expect(execution!.disposition).toBe("no-action");
      // A silence is a DECISION, so it leaves a record and an entry — the
      // whole point of a disposition rather than an absence.
      const entries = await chainEntriesOf(client, twin);
      expect(entries.map((entry) => entry.outcome)).toEqual(["no-action"]);
      expect(await markersOf(client, twin)).toEqual([
        { event_id: ids[0]!, disposition: "no_answer_needed" },
      ]);
      // ...and nothing was drafted or queued.
      const drafts = await client.query(
        "SELECT id FROM drafts WHERE twin_id = $1",
        [twin.twinId],
      );
      expect(drafts.rows).toEqual([]);
      twin.bundle.close();
    });
  });

  it("takes a refusal as feedback and keeps the corrected draft, as ONE execution", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await arriveTurn(client, twin);
      // The first call carries an empty draft, which the tool refuses; the
      // reason goes back as the tool's answer and the model calls again
      // inside the budget it already has (#133's finding).
      const { deps } = depsFor(client, twin, [
        { toolCall: { name: "create_draft", input: { text: "" } } },
        ...draftingTurns(),
      ]);

      expect(await processPendingWaEvents(deps)).toEqual({
        processed: 3,
        drafted: 1,
      });

      const [execution, ...rest] = await executionsOf(client, twin);
      // ONE execution, not two: nothing was recorded by the refusal, so
      // nothing was replaced.
      expect(rest).toEqual([]);
      expect(execution!.disposition).toBe("drafted");
      // ...and the record SHOWS the correction: three rounds rather than
      // two, which is the only trace a refusal leaves.
      expect(execution!.iterations).toBe(3);
      expect(await chainEntriesOf(client, twin)).toHaveLength(1);
      const drafts = await client.query<{ content_enc: Buffer }>(
        "SELECT content_enc FROM drafts WHERE twin_id = $1",
        [twin.twinId],
      );
      expect(
        Buffer.from(twin.dek.decrypt(drafts.rows[0]!.content_enc)).toString(
          "utf8",
        ),
      ).toBe(DRAFT_TEXT);
      twin.bundle.close();
    });
  });

  it("records an execution whose model call fails as `failed`, consumes its whole turn, and lets the pass finish", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const ids = await arriveTurn(client, twin);
      // A PROVIDER THAT ANSWERS NOTHING AT ALL.
      const { deps } = depsFor(client, twin, []);

      // THE PASS RESOLVES, with the failure recorded inside it (ticket #240;
      // `execution-failure.ts` argues the class). A turn the model will not
      // finish is one chat's problem and never the runtime's.
      expect(await processPendingWaEvents(deps)).toEqual({
        processed: 3,
        drafted: 0,
      });

      const [execution] = await executionsOf(client, twin);
      expect(execution!.disposition).toBe("failed");
      // THE TRACE SURVIVES: the record and its entry commit even though
      // nothing else did, which is what the harness's uncaught throw never
      // left behind.
      expect((await chainEntriesOf(client, twin)).map((e) => e.outcome)).toEqual([
        "failed",
      ]);
      expect(await verifyAuditChainInDb(client, TEST_AUDIT_HMAC_KEY)).toMatchObject(
        { valid: true },
      );
      // NO DRAFT, AND THE WHOLE TURN MARKED (ticket #240) — one verdict about
      // a turn is one transaction, exactly as the `no_answer_needed` arm
      // consumes it whole, so the chat is not put back in front of the model
      // on the next poll.
      expect(
        (await client.query("SELECT id FROM drafts WHERE twin_id = $1", [twin.twinId]))
          .rows,
      ).toEqual([]);
      expect(await markersOf(client, twin)).toEqual([
        { event_id: ids[0]!, disposition: "execution_failed" },
        { event_id: ids[1]!, disposition: "execution_failed" },
        { event_id: ids[2]!, disposition: "execution_failed" },
      ]);

      // ...and the next pass finds nothing at all. The marker is what bounds
      // the spend at one paid attempt per turn (ticket #240).
      const again = depsFor(client, twin, draftingTurns());
      expect(await processPendingWaEvents(again.deps)).toEqual({
        processed: 0,
        drafted: 0,
      });
      expect(again.requests).toEqual([]);
      expect((await executionsOf(client, twin)).map((row) => row.disposition)).toEqual([
        "failed",
      ]);
      expect(await chainEntriesOf(client, twin)).toHaveLength(1);
      twin.bundle.close();
    });
  });

  it("leaves the chat beside a failed turn drafted, and the pass finishes", async () => {
    // TWO CHATS, ONE PASS, ONE FAILURE — and the claim is that they do not
    // reach each other. The lane settles every execution before anything is
    // reported (`lanes.ts`), each turn is marked with its own execution's
    // outcome, and the pass finishes: a turn the model will not finish costs
    // that chat its draft and nothing else (ticket #240).
    await withClient(async (client) => {
      const twin = freshTwin();
      const tag = twin.twinId.slice(0, 8);
      const doomed = await insertWaEvent(client, twin.dek, {
        twinId: twin.twinId,
        chatJid: CHAT,
        senderJid: CHAT,
        fromMe: false,
        messageId: `DOOMED-${tag}`,
        text: "¿me manda la cotización?",
        occurredAt: new Date(Date.UTC(2026, 8, 4, 18, 0)),
      });
      const other = "5215550002@s.whatsapp.net";
      const fine = await insertWaEvent(client, twin.dek, {
        twinId: twin.twinId,
        chatJid: other,
        senderJid: other,
        fromMe: false,
        messageId: `FINE-${tag}`,
        text: "¿tiene 20 bultos?",
        occurredAt: new Date(Date.UTC(2026, 8, 4, 18, 1)),
      });
      // The first chat's model call fails; the second drafts, on the lane,
      // beside it. Scripted PER CONVERSATION, because a flat list
      // would hand whichever asked first the turns meant for the other now
      // that the two interleave.
      const { deps } = depsFor(client, twin, (prompt) =>
        prompt.includes("cotizaci") ? [] : draftingTurns(),
      );

      expect(await processPendingWaEvents(deps)).toEqual({
        processed: 2,
        drafted: 1,
      });

      // Both traces are committed: the failure, and the draft beside it.
      expect(
        [...(await executionsOf(client, twin)).map((row) => row.disposition)].sort(),
      ).toEqual(["drafted", "failed"]);
      expect(
        [...(await chainEntriesOf(client, twin)).map((entry) => entry.outcome)].sort(),
      ).toEqual(["drafted", "failed"]);
      // Each turn is marked with its own execution's outcome, so neither chat
      // is re-read on the next poll and the two are told apart by the word.
      expect(await markersOf(client, twin)).toEqual([
        { event_id: doomed, disposition: "execution_failed" },
        { event_id: fine, disposition: "drafted" },
      ]);
      twin.bundle.close();
    });
  });
});

describe("the binding question the execution composed (spec #171 decision 17)", () => {
  it("renders the composed sentence with the name folded in, and the answers line from data", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await arriveTurn(client, twin, { pushName: PUSH_NAME });
      const { deps } = depsFor(
        client,
        twin,
        draftingTurns({ binding_question: "¿este chat es el de {name}?" }),
      );
      await processPendingWaEvents(deps);

      const notice = await client.query<{ content_enc: Buffer; execution_id: string }>(
        "SELECT content_enc, execution_id FROM notices WHERE twin_id = $1 AND kind = 'binding_question'",
        [twin.twinId],
      );
      expect(notice.rows).toHaveLength(1);
      expect(
        Buffer.from(twin.dek.decrypt(notice.rows[0]!.content_enc)).toString("utf8"),
      ).toBe(
        "✳️ ¿este chat es el de Sra. Garza?\n\n" +
          "Para confirmarlo, responde a este mensaje citándolo con «si».",
      );
      // The notice names the execution that composed it.
      const [execution] = await executionsOf(client, twin);
      expect(notice.rows[0]!.execution_id).toBe(execution!.id);
      twin.bundle.close();
    });
  });

  it("asks anyway when the execution composed nothing — ceremony never blocks the draft", async () => {
    // #34's rule, and the road a chat whose payload carries no push-name
    // already takes: the once-ever question posts code-composed rather than
    // being skipped, because a chat nobody is ever asked about is a chat
    // that never binds.
    await withClient(async (client) => {
      const twin = freshTwin();
      await arriveTurn(client, twin, { pushName: PUSH_NAME });
      const { deps } = depsFor(client, twin, draftingTurns());
      await processPendingWaEvents(deps);

      const notice = await client.query<{ content_enc: Buffer }>(
        "SELECT content_enc FROM notices WHERE twin_id = $1 AND kind = 'binding_question'",
        [twin.twinId],
      );
      expect(
        Buffer.from(twin.dek.decrypt(notice.rows[0]!.content_enc)).toString("utf8"),
      ).toBe(
        "✳️ ¿Este chat es de Sra. Garza?\n\n" +
          "Para confirmarlo, responde a este mensaje citándolo con «si».",
      );
      twin.bundle.close();
    });
  });

  it("refuses a sentence that types the name, and the corrected one is accepted", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await arriveTurn(client, twin, { pushName: PUSH_NAME });
      const { deps } = depsFor(client, twin, [
        { toolCall: { name: "create_draft", input: { text: DRAFT_TEXT, binding_question: "¿este chat es el de Sra. Garza?" } } },
        ...draftingTurns({ binding_question: "¿este chat es el de {name}?" }),
      ]);
      await processPendingWaEvents(deps);

      const [execution] = await executionsOf(client, twin);
      expect(execution!.disposition).toBe("drafted");
      expect(execution!.iterations).toBe(3);
      const notice = await client.query<{ content_enc: Buffer }>(
        "SELECT content_enc FROM notices WHERE twin_id = $1 AND kind = 'binding_question'",
        [twin.twinId],
      );
      expect(
        Buffer.from(twin.dek.decrypt(notice.rows[0]!.content_enc)).toString("utf8"),
      ).toContain("¿este chat es el de Sra. Garza?");
      twin.bundle.close();
    });
  });
});

describe("what the execution was shown (spec #171's Testing Decisions)", () => {
  it("is shown the `now` header, the numbered turn and the rep's language — and no rig line", async () => {
    // A SCRIPT THAT IS A FUNCTION OF THE PROMPT, which is how "what the
    // execution was shown changed what it did" is provable at all: the
    // script reads the prompt and answers from it, so the assertions below
    // are about what really reached the wire.
    await withClient(async (client) => {
      const twin = freshTwin();
      await arriveTurn(client, twin, { pushName: PUSH_NAME });
      let read = "";
      const { deps, requests } = depsFor(client, twin, (prompt) => {
        read = prompt;
        return draftingTurns();
      });
      await processPendingWaEvents(deps);

      // TWO READERS OF ONE STRING, and they must agree: the script read the
      // prompt as the wire delivered it, and `promptOf` reads it back off
      // the request the runner sent. A suite reaching into
      // `requests[0].messages[0].content` by hand is one cast away from
      // asserting nothing (`promptOf`'s own note).
      const shown = promptOf(requests[0]!);
      expect(shown).toBe(read);
      expect(shown).not.toBe("");

      // `now`, FIRST, in the rep's own zone at the turn's pick-up.
      expect(shown).toContain("## now\n\n[Now: ");
      expect(shown).toContain("(America/Monterrey)]");
      expect(shown.indexOf("## now")).toBe(0);

      // The rep's language and register, as English bracketed metadata.
      expect(shown).toContain(
        "[The rep's language and register: Mexican Spanish, informal WhatsApp.]",
      );

      // The turn, numbered, under the heading that says it and only it is
      // to be answered.
      expect(shown).toContain(
        "NEW — unanswered messages from the counterparty, oldest first.",
      );
      expect(shown).toContain(`1. ${TURN[0]!}`);
      expect(shown).toContain(`2. ${TURN[1]!}`);
      expect(shown).toContain(`3. ${TURN[2]!}`);

      // Who this chat is, and that nobody has said so — in English, with no
      // frame label: «(sin confirmar)» is chrome the rep reads on the POST.
      expect(shown).toContain("Sra. Garza");
      expect(shown).toContain("Nobody has confirmed who this is");
      expect(shown).not.toContain("sin confirmar");
      expect(shown).toContain("{name}");
      twin.bundle.close();
    });
  });

  it("holds no Spanish of its own — every Spanish word in the prompt is somebody's message", async () => {
    // THE CLAIM THE THIRD ACCEPTANCE CRITERION MAKES, at the wire. The
    // model is TOLD the language as data; nothing code wrote into the turn
    // is in it. Checked by removing the two humans' words from the prompt
    // and sweeping what is left for Spanish orthography.
    await withClient(async (client) => {
      const twin = freshTwin();
      await arriveTurn(client, twin, { pushName: PUSH_NAME });
      const { deps, requests } = depsFor(client, twin, draftingTurns());
      await processPendingWaEvents(deps);

      let framing = promptOf(requests[0]!);
      for (const said of [...TURN, PUSH_NAME]) framing = framing.split(said).join("");
      expect(framing).not.toMatch(/[¿¡«»áéíóúüñÁÉÍÓÚÜÑ]/u);
      // ...and the rig line the harness carried is gone from what the model
      // is told, prompt and system alike.
      const system = systemOf(requests[0]);
      for (const line of ["Mexican Spanish", "this rig", "Porque:"]) {
        expect(system, `the system prompt names "${line}"`).not.toContain(line);
      }
      expect(system).toContain("## who you are");
      expect(system).toContain("search_memory (projection)");
      twin.bundle.close();
    });
  });

  it("runs on the automation's own budget and its own wake", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await arriveTurn(client, twin);
      const { deps, requests } = depsFor(client, twin, draftingTurns());
      await processPendingWaEvents(deps);

      // The runtime's 16,000 rather than the harness's 1,024 (#148). The
      // turn cap never reaches the wire — the SDK child consumes it — so
      // what it bounds is asserted where it can be seen: the refusal test
      // above spends three of the six.
      expect(requests[0]!["max_tokens"]).toBe(16_000);
      expect(requests[0]!["model"]).toBe("claude-sonnet-5");
      expect(DRAFTING_DEFINITION.budget.iterations).toBe(6);
      // The rung is the app boundary's and the wake is drafting's own.
      expect(DRAFTING_WAKE.occasion).toBe("chat_turn");
      twin.bundle.close();
    });
  });

  it("lets the execution look further back through this chat, and only this chat", async () => {
    // The one tool, exercised over real twin memory. Another customer's
    // chat holds the nearest neighbour of the search; a draft for this
    // chat can never be written out of it (ADR-0013's projection, scoped
    // from `deps` and unreachable from the input).
    await withClient(async (client) => {
      const twin = freshTwin();
      const tag = twin.twinId.slice(0, 8);
      const OTHER = "5215550009@s.whatsapp.net";
      const SECRET = "a Don Beto le damos precio especial de 180 el bulto";
      const OURS = "el flete a Saltillo lo pagamos nosotros";
      for (const [chat, text, id] of [
        [OTHER, SECRET, `OTHER-${tag}`],
        [CHAT, OURS, `MINE-${tag}`],
      ] as const) {
        await insertWaEvent(client, twin.dek, {
          twinId: twin.twinId,
          chatJid: chat,
          senderJid: chat,
          fromMe: true,
          messageId: id,
          text,
          backfill: true,
          occurredAt: new Date(Date.UTC(2026, 6, 1, 10, 0)),
        });
      }
      await processPendingWaEvents(depsFor(client, twin, []).deps);
      await arriveTurn(client, twin, {
        lines: ["¿el flete a Saltillo quién lo paga?"],
      });

      let searched = "";
      const { deps } = depsFor(client, twin, (prompt) => {
        searched = prompt;
        return [
          {
            toolCall: {
              name: "search_memory",
              input: { about: "el flete a Saltillo" },
            },
          },
          ...draftingTurns(),
        ];
      });
      await processPendingWaEvents(deps);

      const [execution] = await executionsOf(client, twin);
      expect(execution!.disposition).toBe("drafted");
      // Three rounds: the search, the draft, and the turn that ends.
      expect(execution!.iterations).toBe(3);
      // The prompt the script read is the FIRST request's, so this only
      // proves the tool was reachable; what the search returned is asserted
      // through the draft below.
      expect(searched).toContain("¿el flete a Saltillo quién lo paga?");
      // The other customer's conversation never entered the turn.
      expect(searched).not.toContain(SECRET);
      expect(searched).not.toContain("Don Beto");
      twin.bundle.close();
    });
  });

  it("hands the search's hits back to the model, from this chat alone", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const tag = twin.twinId.slice(0, 8);
      const OURS = "el flete a Saltillo lo pagamos nosotros";
      await insertWaEvent(client, twin.dek, {
        twinId: twin.twinId,
        chatJid: CHAT,
        senderJid: CHAT,
        fromMe: true,
        messageId: `HIT-${tag}`,
        text: OURS,
        backfill: true,
        occurredAt: new Date(Date.UTC(2026, 6, 1, 10, 0)),
      });
      await processPendingWaEvents(depsFor(client, twin, []).deps);
      await arriveTurn(client, twin, { lines: ["¿y el flete?"] });

      const { deps, requests } = depsFor(client, twin, [
        {
          toolCall: { name: "search_memory", input: { about: "el flete" } },
        },
        ...draftingTurns(),
      ]);
      await processPendingWaEvents(deps);

      // The SECOND request carries the tool result: the search's own hits,
      // each one carrying WHEN it was sent — the projection the tool
      // declares, in the seat's zone, through the one formatter (#139).
      const second = JSON.stringify(requests[1]!["messages"]);
      expect(second).toContain(`rep: ${OURS}`);
      expect(second).toContain("[Wednesday, Jul 1, 2026, 04:00:00 CST] rep:");
      twin.bundle.close();
    });
  });

  it("pins the Borrador's bytes: the twin's sentence, its customer named by code, above the frame (ticket #368)", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await arriveTurn(client, twin, { lines: ["¿me manda 20 bultos?"] });
      const { deps } = depsFor(client, twin, draftingTurns());
      await processPendingWaEvents(deps);

      const post = await client.query<{ post_enc: Buffer }>(
        "SELECT post_enc FROM drafts WHERE twin_id = $1",
        [twin.twinId],
      );
      const rendered = Buffer.from(
        twin.dek.decrypt(post.rows[0]!.post_enc),
      ).toString("utf8");
      // The whole Mock A frame under the twin's own words, with the
      // instruction line rendered from the accepted keyword set — and no
      // «Porque:» line: the reason is in the words.
      expect(rendered).toBe(
        "✳️ Te dejé la respuesta para 5215550001 (sin confirmar): pidió 50 bultos y luego fijó el lunes.\n\n" +
          `*Borrador — para 5215550001 (sin confirmar)*\n\n` +
          `«${DRAFT_TEXT}»\n\n` +
          "Para enviarlo, responde a este mensaje citándolo con «va».",
      );
      twin.bundle.close();
    });
  });
});

/**
 * THE DRAFT CARD CARRIES THE TWIN'S SENTENCE (ticket #368; the glossary's
 * *Hand-off*). The words the drafting turn ends on are the draft post's
 * `prose` part — the card's sentence on Inicio — and the line above the
 * Borrador on the phone; the draft tool takes no clause of its own, and a turn
 * that said nothing leaves the card to code's own sentence.
 */
describe("the draft post carries the twin's own sentence at both doors (ticket #368)", () => {
  /** The draft post's parts, opened under the twin's key, and the phone's text. */
  async function draftPostOf(
    client: pg.Client,
    twin: Twin,
  ): Promise<{ readonly parts: readonly PostPart[]; readonly phone: string }> {
    const rows = await client.query<{ parts_enc: Buffer; post_enc: Buffer }>(
      `SELECT p.parts_enc, d.post_enc FROM posts p JOIN drafts d ON d.id = p.draft_id
        WHERE p.twin_id = $1`,
      [twin.twinId],
    );
    expect(rows.rows).toHaveLength(1);
    const row = rows.rows[0]!;
    return {
      parts: openSealedParts(twin.dek, row.parts_enc),
      phone: Buffer.from(twin.dek.decrypt(row.post_enc)).toString("utf8"),
    };
  }

  it("lands [prose(words), draft]: the card's sentence is the turn's words, its customer a mention code renders", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await arriveTurn(client, twin);
      await processPendingWaEvents(depsFor(client, twin, draftingTurns()).deps);

      const { parts, phone } = await draftPostOf(client, twin);
      expect(parts.map((part) => part.kind)).toEqual(["prose", "draft"]);
      expect(parts[0]).toEqual({
        kind: "prose",
        text: SENTENCE,
        mentions: [{ reference: "c1", name: "5215550001 (sin confirmar)" }],
      });
      expect(parts[1]).not.toHaveProperty("rationale");
      // ...and the phone's draft message shows the same words above the draft.
      expect(phone.startsWith("✳️ Te dejé la respuesta para 5215550001 (sin confirmar): pidió 50 bultos")).toBe(true);
      expect(phone).not.toContain("Porque:");
      twin.bundle.close();
    });
  });

  it("a turn that wrote the draft and said nothing lands the draft alone, its frame opening the phone's message", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await arriveTurn(client, twin);
      await processPendingWaEvents(depsFor(client, twin, draftingTurns({}, "")).deps);

      const { parts, phone } = await draftPostOf(client, twin);
      expect(parts.map((part) => part.kind)).toEqual(["draft"]);
      expect(phone.startsWith("✳️ *Borrador — para ")).toBe(true);
      twin.bundle.close();
    });
  });

  it("refuses a `porque` as a parameter it never declared, and the draft lands on the next call", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await arriveTurn(client, twin);
      const { deps, requests } = depsFor(client, twin, [
        { toolCall: { name: "create_draft", input: { text: DRAFT_TEXT, porque: "pidió bultos" } } },
        ...draftingTurns(),
      ]);
      await processPendingWaEvents(deps);

      expect(toolResultsOf(requests[1])[0]).toMatch(/^rejected:.*porque/u);
      const { parts } = await draftPostOf(client, twin);
      expect(parts.map((part) => part.kind)).toEqual(["prose", "draft"]);
      twin.bundle.close();
    });
  });
});

/**
 * THE CI CORPUS, minted last and left behind — the shape `fr73.int.test.ts`
 * and the merge corpus both use.
 *
 * The step after this file runs `audit-coverage-check
 * --require-acts=rep_execution` and `audit-verify --require-entries` over
 * exactly what it leaves, so a corpus that stopped being minted has to fail
 * HERE rather than silently in a CI step nobody reads.
 */
describe("the CI corpus for the rep side's coverage class (ticket #172)", () => {
  it("leaves committed executions, their entries and a chain that verifies", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await arriveTurn(client, twin, { pushName: PUSH_NAME });
      const { deps } = depsFor(
        client,
        twin,
        draftingTurns({ binding_question: "¿este chat es el de {name}?" }),
      );
      expect(await processPendingWaEvents(deps)).toEqual({
        processed: 3,
        drafted: 1,
      });

      // Left COMMITTED, unlike every proof above that plants and rolls
      // back. Asserted here so the corpus and its check cannot drift.
      const rows = await client.query<{ n: string }>(
        "SELECT count(*) AS n FROM executions",
      );
      expect(Number(rows.rows[0]!.n)).toBeGreaterThan(0);
      const entries = await client.query<{ n: string }>(
        "SELECT count(*) AS n FROM audit_chain WHERE action = 'execution'",
      );
      expect(Number(entries.rows[0]!.n)).toBe(Number(rows.rows[0]!.n));
      expect(
        (await verifyAuditChainInDb(client, TEST_AUDIT_HMAC_KEY)).valid,
      ).toBe(true);
      twin.bundle.close();
    });
  });
});

/**
 * DRAFTING POSTS ITS CARD AND NEVER KNOCKS (ticket #320; spec #318 decision
 * 21; design D5). The card lands with no knock, the landing wakes the twin
 * thread, and the thread's turn decides (`thread-day.int.test.ts`). What only
 * this seam can say is that a drafting turn the MODEL drove — through the real
 * tool, the real emission path and the real seal — lands a post with no knock
 * in it and the store's word `none`, and that the draft tool takes no
 * sentence for the phone at all.
 */
describe("a drafting turn posts its card and never knocks (ticket #320 AC 1)", () => {
  /** Every part of every post this twin wrote, opened under its own key. */
  async function partsOf(
    client: pg.Client,
    twin: Twin,
  ): Promise<readonly PostPart[][]> {
    const rows = await client.query<{ parts_enc: Buffer }>(
      "SELECT parts_enc FROM posts WHERE twin_id = $1 AND parts_enc IS NOT NULL ORDER BY posted_at",
      [twin.twinId],
    );
    return rows.rows.map((row) => [...openSealedParts(twin.dek, row.parts_enc)]);
  }

  it("lands the card with no knock of its own", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await arriveTurn(client, twin, { pushName: PUSH_NAME });
      const { deps } = depsFor(
        client,
        twin,
        draftingTurns({ binding_question: "¿este chat es el de {name}?" }),
      );
      await processPendingWaEvents(deps);

      const posts = await partsOf(client, twin);
      expect(posts.map((parts) => parts.map((part) => part.kind))).toEqual([
        ["prose", "draft"],
        ["prose", "question"],
      ]);
      const knocks = await client.query("SELECT 1 FROM post_knocks WHERE twin_id = $1", [twin.twinId]);
      expect(knocks.rows).toEqual([]);
      twin.bundle.close();
    });
  });

  it("refuses a draft that still writes a sentence for the phone, and the draft lands on the next call", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await arriveTurn(client, twin);
      const { deps, requests } = depsFor(client, twin, [
        {
          toolCall: {
            name: "create_draft",
            input: { text: DRAFT_TEXT, knock: "Te dejé listo lo de la Sra. Garza." },
          },
        },
        ...draftingTurns(),
      ]);
      await processPendingWaEvents(deps);

      // THE TOOL TAKES NO KNOCK: its schema is closed, and the runner refuses
      // a parameter it never declared before the handler runs.
      expect(toolResultsOf(requests[1])[0]).toMatch(/^rejected:.*knock/u);
      const posts = await partsOf(client, twin);
      expect(posts.map((parts) => parts.map((part) => part.kind))).toEqual([["prose", "draft"]]);
      twin.bundle.close();
    });
  });
});
