/**
 * The binding ceremony (ticket #34; spec #29 grilling decision 3), tested
 * across the primary Postgres seam: inject `wa_events` fixtures, assert
 * twin posts, dispositions, taps — and the entity mirror's contents only
 * THROUGH the bundle API. Real Postgres, real envelope crypto, real
 * SQLCipher (ADR-0028); the model is scripted at the model boundary,
 * and the matcher-side tests script it empty so any model call fails loudly.
 *
 * The properties under test are the ticket's ACs: binding birth is lazy
 * and once-ever (one framed question per chat, ever — restarts and further
 * drafts never re-ask, an unanswered question just leaves the chat
 * provisional); a quoted «va» on the question confirms into the bundle's
 * entity mirror and can NEVER mint a send tap, while a draft «va» can
 * NEVER confirm a binding (adversarial both directions); provisional
 * rendering wears «(sin confirmar)» until the rep's word replaces it; and
 * injected model output can never propose-and-confirm a binding
 * (poisoned-echo extended). Bindings exist nowhere outside the bundle
 * (ADR-0004) — the structural scan lives in binding-wall.test.ts.
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
  createSendLockWriter,
  CONSERVATIVE_DEV_PACING,
} from "./send-lock/writer.js";
import {
  resetAndMigrate,
  withClient,
  TEST_AUDIT_HMAC_KEY,
  TEST_DATABASE_URL,
} from "./testing/db.js";
import { removeTmpDir } from "./testing/tmp.js";
import { fakeEmbedder } from "./testing/fake-embedder.js";
import { insertWaEvent, simulateExecutorPost } from "./testing/seam-fixtures.js";
import {
  closeScriptedModels,
  entityKindTurns,
  qaSilenceTurns,
  scriptedModel,
  type Script,
  type ScriptedTurn,
} from "./testing/scripted-model.js";
import { SETTLE_IMMEDIATELY } from "./testing/settle.js";
import { newExecutionPool } from "./testing/execution-pool.js";
import { threadTurns } from "./testing/thread-script.js";
import { DECLINE_BINDING_TOOL } from "./thread/acts.js";

// Every scripted model this suite opened is closed with it (#328).
afterAll(closeScriptedModels);

/** One connection source for every execution this suite runs (ticket #173). */
const executionPool = newExecutionPool();

const SELF_CHAT = "5215550000@s.whatsapp.net";
const CHAT = "5215550001@s.whatsapp.net";
const DRAFT_TEXT = "claro, se las mando el jueves temprano";
const PUSH_NAME = "Sra. Garza";

const QUESTION_TEXT =
  "✳️ ¿Este chat es de Sra. Garza?\n\n" +
  "Para confirmarlo, responde a este mensaje citándolo con «si».";

/** The ack a confirmation now posts (ticket #49; #36 finding 2). */
const ACK_TEXT = "✳️ Listo, guardé este chat como *Sra. Garza*.";

/** One scripted needs-answer decision (tool call + closing turn). */
function draftingTurns(draftText = DRAFT_TEXT): ScriptedTurn[] {
  return [
    { toolCall: { name: "create_draft", input: { text: draftText } } },
    { text: "done" },
  ];
}

let tmp: string;
let pool: pg.Pool;

beforeAll(async () => {
  await resetAndMigrate();
  tmp = mkdtempSync(join(tmpdir(), "dito-bindings-int-"));
  pool = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 4 });
});

afterAll(async () => {
  await pool.end();
  removeTmpDir(tmp);
});

/** A fresh twin with its own real SQLCipher bundle under a local DEK. */
function freshTwin(): { twinId: string; dek: Dek; bundle: Bundle } {
  const twinId = randomUUID();
  const dek = createDekFromMaterial(randomBytes(32));
  const bundle = createBundle(join(tmp, `${twinId}.bundle`), dek);
  return { twinId, dek, bundle };
}

/**
 * Runtime deps. Each call builds a FRESH deps object (fresh scripted model,
 * fresh writer) — calling it again models a runtime restart: nothing about
 * the ceremony may live in process state.
 */
function depsFor(
  client: pg.Client,
  twin: { twinId: string; dek: Dek; bundle: Bundle },
  turns: Script = [],
): TwinRuntimeDeps {
  const { harness } = scriptedModel(turns);
  return {
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
    sendLock: createSendLockWriter({ pool, hmacKey: TEST_AUDIT_HMAC_KEY }),
    hmacKey: TEST_AUDIT_HMAC_KEY,
  };
}

/** Seeds the writer's config so a draft «va» can actually mint and send. */
async function seedSendConfig(client: pg.Client, twinId: string): Promise<void> {
  await client.query(
    "INSERT INTO send_allowlist (twin_id, destination_jid) VALUES ($1, $2)",
    [twinId, CHAT],
  );
  await client.query(
    "INSERT INTO pacing_thresholds (twin_id, max_sends_per_hour, min_seconds_between_sends) VALUES ($1, $2, $3)",
    [
      twinId,
      CONSERVATIVE_DEV_PACING.maxSendsPerHour,
      CONSERVATIVE_DEV_PACING.minSecondsBetweenSends,
    ],
  );
}

/** A counterparty inbound in the customer chat. */
function customerInbound(
  twinId: string,
  messageId: string,
  opts: { pushName?: string; text?: string } = {},
) {
  return {
    twinId,
    chatJid: CHAT,
    senderJid: CHAT,
    fromMe: false,
    messageId,
    text: opts.text ?? "¿me mandas 40 cajas para el jueves?",
    ...(opts.pushName === undefined ? {} : { pushName: opts.pushName }),
  };
}

/** The rep's quoted self-chat reply as the plane captures it (raw, own-sent). */
function repReply(
  twinId: string,
  text: string,
  quotedMessageId: string,
  messageId: string,
) {
  return {
    twinId,
    chatJid: SELF_CHAT,
    senderJid: SELF_CHAT,
    fromMe: true,
    messageId,
    text,
    quotedMessageId,
  };
}

interface QuestionRow {
  id: string;
  about_event_id: string;
  content: string;
  command_id: string;
  destination: string;
}

/** Every binding-question notice with its system_send, decrypted. */
async function bindingQuestions(
  client: pg.Client,
  twin: { twinId: string; dek: Dek },
): Promise<QuestionRow[]> {
  const res = await client.query<{
    id: string;
    about_event_id: string;
    content_enc: Buffer;
    command_id: string;
    destination: string;
  }>(
    `SELECT n.id, n.about_event_id, n.content_enc, sc.id AS command_id, sc.destination
       FROM notices n
       JOIN send_commands sc ON sc.payload_ref = 'notice:' || n.id
      WHERE n.twin_id = $1 AND n.kind = 'binding_question'
      ORDER BY n.created_at, n.id`,
    [twin.twinId],
  );
  return res.rows.map((r) => ({
    id: r.id,
    about_event_id: r.about_event_id,
    content: Buffer.from(twin.dek.decrypt(r.content_enc)).toString("utf8"),
    command_id: r.command_id,
    destination: r.destination,
  }));
}

async function disposition(client: pg.Client, eventId: string): Promise<string> {
  const res = await client.query<{ disposition: string }>(
    "SELECT disposition FROM wa_event_processing WHERE event_id = $1",
    [eventId],
  );
  return res.rows[0]!.disposition;
}

/** Every binding ack this twin posted, in thread order (ticket #49). */
async function ackTexts(
  client: pg.Client,
  twin: { twinId: string; dek: Dek },
): Promise<string[]> {
  const res = await client.query<{ content_enc: Buffer }>(
    `SELECT content_enc FROM notices
      WHERE twin_id = $1 AND kind = 'binding_ack' ORDER BY created_at, id`,
    [twin.twinId],
  );
  return res.rows.map((r) =>
    Buffer.from(twin.dek.decrypt(r.content_enc)).toString("utf8"),
  );
}

async function decryptedDraftPosts(
  client: pg.Client,
  twin: { twinId: string; dek: Dek },
): Promise<string[]> {
  const res = await client.query<{ post_enc: Buffer }>(
    "SELECT post_enc FROM drafts WHERE twin_id = $1 ORDER BY created_at, id",
    [twin.twinId],
  );
  return res.rows.map((r) =>
    Buffer.from(twin.dek.decrypt(r.post_enc)).toString("utf8"),
  );
}

/**
 * Drives the birth: one needs-answer inbound with a push-name, consumed —
 * returns the question's system_send command id for posting.
 */
async function bornQuestion(
  client: pg.Client,
  twin: { twinId: string; dek: Dek; bundle: Bundle },
): Promise<{ inboundId: string; questionCommandId: string }> {
  const inboundId = await insertWaEvent(
    client,
    twin.dek,
    // A per-call message id: external_event_id is globally unique at the
    // seam and every test shares the one CHAT jid.
    customerInbound(twin.twinId, `3EB0-BIND-IN-${randomUUID()}`, {
      pushName: PUSH_NAME,
    }),
  );
  await processPendingWaEvents(depsFor(client, twin, draftingTurns()));
  const questions = await bindingQuestions(client, twin);
  expect(questions).toHaveLength(1);
  return { inboundId, questionCommandId: questions[0]!.command_id };
}

describe("binding birth: lazy and once-ever (ticket #34 AC 2)", () => {
  it("the first draft needing a {cliente} for an unbound chat posts exactly one framed binding question, and the draft renders the push-name «(sin confirmar)»", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const inboundId = await insertWaEvent(
        client,
        twin.dek,
        customerInbound(twin.twinId, "3EB0-B1-1", { pushName: PUSH_NAME }),
      );

      await processPendingWaEvents(depsFor(client, twin, draftingTurns()));

      // Exactly one framed question, about the triggering inbound,
      // addressed to the twin thread as a system_send.
      const questions = await bindingQuestions(client, twin);
      expect(questions).toHaveLength(1);
      expect(questions[0]!.content).toBe(QUESTION_TEXT);
      expect(questions[0]!.about_event_id).toBe(inboundId);
      expect(questions[0]!.destination).toBe(SELF_CHAT);

      // The draft flowed — ceremony never blocks — and renders provisional.
      const posts = await decryptedDraftPosts(client, twin);
      expect(posts).toHaveLength(1);
      expect(posts[0]).toContain("*Borrador — para Sra. Garza (sin confirmar)*");

      // Asking proposes; only the rep's «va» confirms: the mirror is empty.
      expect(twin.bundle.listChatBindings()).toEqual([]);
      twin.bundle.close();
    });
  });

  it("once-ever: further drafts and runtime restarts never re-ask, and an unanswered question just leaves the chat provisional — no nag", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await bornQuestion(client, twin);

      // A second draft in the same chat — same runtime.
      await insertWaEvent(
        client,
        twin.dek,
        customerInbound(twin.twinId, "3EB0-B2-2", { pushName: PUSH_NAME }),
      );
      await processPendingWaEvents(depsFor(client, twin, draftingTurns()));

      // A third draft after a restart (fresh deps: nothing in process
      // state carries the ceremony).
      await insertWaEvent(
        client,
        twin.dek,
        customerInbound(twin.twinId, "3EB0-B2-3", { pushName: PUSH_NAME }),
      );
      await processPendingWaEvents(depsFor(client, twin, draftingTurns()));

      // Idle passes over the unanswered question: nothing new, ever.
      await processPendingWaEvents(depsFor(client, twin));
      await processPendingWaEvents(depsFor(client, twin));

      expect(await bindingQuestions(client, twin)).toHaveLength(1);
      const posts = await decryptedDraftPosts(client, twin);
      expect(posts).toHaveLength(3);
      for (const post of posts) {
        expect(post).toContain("para Sra. Garza (sin confirmar)");
      }
      expect(twin.bundle.listChatBindings()).toEqual([]);
      twin.bundle.close();
    });
  });

  it("no push-name, nothing to propose: the draft renders the number «(sin confirmar)» and the question waits for the first {cliente}-needing draft that carries one", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await insertWaEvent(
        client,
        twin.dek,
        customerInbound(twin.twinId, "3EB0-B3-1"),
      );
      await processPendingWaEvents(depsFor(client, twin, draftingTurns()));

      expect(await bindingQuestions(client, twin)).toHaveLength(0);
      const posts = await decryptedDraftPosts(client, twin);
      expect(posts[0]).toContain("*Borrador — para 5215550001 (sin confirmar)*");

      // The rail supplies the name later: the next name-needing draft
      // asks — once.
      await insertWaEvent(
        client,
        twin.dek,
        customerInbound(twin.twinId, "3EB0-B3-2", { pushName: PUSH_NAME }),
      );
      await processPendingWaEvents(depsFor(client, twin, draftingTurns()));

      const questions = await bindingQuestions(client, twin);
      expect(questions).toHaveLength(1);
      expect(questions[0]!.content).toBe(QUESTION_TEXT);
      twin.bundle.close();
    });
  });
});

describe("confirmation: a quoted yes on the question, and only that (ticket #34 AC 3; the set grows at #49)", () => {
  it("a quoted «va» on the binding-question post confirms into the entity mirror — and mints no tap, no customer_send, nothing else", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await seedSendConfig(client, twin.twinId);
      const { questionCommandId } = await bornQuestion(client, twin);
      await simulateExecutorPost(client, {
        commandId: questionCommandId,
        twinId: twin.twinId,
        waMessageId: "WAMID-QUESTION-1",
      });

      const vaId = await insertWaEvent(
        client,
        twin.dek,
        repReply(twin.twinId, "va", "WAMID-QUESTION-1", "3EB0-REP-B1"),
      );
      // ONE scripted call, and it is the crossing's kind determination
      // (ticket #60). The verb itself still consults no model: anything
      // beyond that one call exhausts the script and fails loudly.
      await processPendingWaEvents(depsFor(client, twin, entityKindTurns()));

      expect(await disposition(client, vaId)).toBe("binding_confirmed");
      const bindings = twin.bundle.listChatBindings();
      expect(bindings).toHaveLength(1);
      expect(bindings[0]!.chatJid).toBe(CHAT);
      expect(bindings[0]!.displayName).toBe(PUSH_NAME);
      expect(bindings[0]!.entityId).toMatch(/^[0-9a-f-]{36}$/);

      // The adversarial direction: a binding «va» can NEVER mint a send.
      const taps = await client.query("SELECT id FROM taps");
      expect(taps.rows).toEqual([]);
      const customerSends = await client.query(
        "SELECT id FROM send_commands WHERE twin_id = $1 AND send_class = 'customer_send'",
        [twin.twinId],
      );
      expect(customerSends.rows).toEqual([]);

      // The confirmation ACKS out loud (ticket #49; #36 finding 2): the
      // framed «Descartado»-shaped line, about the rep's own confirming
      // event, delivered through the existing notice → system_send path —
      // the plane stays dumb (ADR-0005/0017).
      const notices = await client.query<{
        id: string;
        kind: string;
        about_event_id: string;
        content_enc: Buffer;
      }>(
        `SELECT id, kind, about_event_id, content_enc FROM notices
          WHERE twin_id = $1 ORDER BY created_at`,
        [twin.twinId],
      );
      expect(notices.rows.map((r) => r.kind)).toEqual([
        "binding_question",
        "binding_ack",
      ]);
      const ack = notices.rows[1]!;
      expect(ack.about_event_id).toBe(vaId);
      expect(
        Buffer.from(twin.dek.decrypt(ack.content_enc)).toString("utf8"),
      ).toBe(ACK_TEXT);
      const ackSends = await client.query(
        `SELECT send_class, destination, tap_id FROM send_commands
          WHERE payload_ref = $1`,
        [`notice:${ack.id}`],
      );
      expect(ackSends.rows).toEqual([
        { send_class: "system_send", destination: SELF_CHAT, tap_id: null },
      ]);
      twin.bundle.close();
    });
  });

  it.each(["si", "s\u00ed", "S\u00cd", "si\u0301"])(
    "a quoted %j confirms too — the question's own yes-words, and the ack names what was saved",
    async (yes) => {
      await withClient(async (client) => {
        const twin = freshTwin();
        await seedSendConfig(client, twin.twinId);
        const { questionCommandId } = await bornQuestion(client, twin);
        // Per-case ids: external_event_id is globally unique at the seam
        // and every case here shares the one CHAT jid.
        const posted = `WAMID-QUESTION-SI-${randomUUID()}`;
        await simulateExecutorPost(client, {
          commandId: questionCommandId,
          twinId: twin.twinId,
          waMessageId: posted,
        });

        const yesId = await insertWaEvent(
          client,
          twin.dek,
          repReply(twin.twinId, yes, posted, `3EB0-REP-SI-${randomUUID()}`),
        );
        // A verb must never consult a model — the one scripted call is
        // the crossing's kind determination (ticket #60), and nothing else
        // in this pass may ask.
        await processPendingWaEvents(depsFor(client, twin, entityKindTurns()));

        expect(await disposition(client, yesId)).toBe("binding_confirmed");
        expect(twin.bundle.listChatBindings()).toHaveLength(1);
        expect(await ackTexts(client, twin)).toEqual([ACK_TEXT]);
        // Still never a send: a question's yes has no path to the writer.
        const taps = await client.query("SELECT id FROM taps");
        expect(taps.rows).toEqual([]);
        twin.bundle.close();
      });
    },
  );

  it.each(["no", "no va", "NO", "¡no!", "no, ese no es Torres", "ya no"])(
    "a quoted %j declines through the tool: nothing bound, nothing minted, and the rep is told (ticket #174)",
    async (no) => {
      await withClient(async (client) => {
        const twin = freshTwin();
        await seedSendConfig(client, twin.twinId);
        const { questionCommandId } = await bornQuestion(client, twin);
        const posted = `WAMID-QUESTION-NO-${randomUUID()}`;
        await simulateExecutorPost(client, {
          commandId: questionCommandId,
          twinId: twin.twinId,
          waMessageId: posted,
        });

        const noId = await insertWaEvent(
          client,
          twin.dek,
          repReply(twin.twinId, no, posted, `3EB0-REP-NO-${randomUUID()}`),
        );
        // THE DECLINE WAS A KEYWORD UNTIL #174, and it was the clearest
        // case for retiring one: it wrote nothing, said nothing, and the
        // rep had to know the word or watch nothing happen. It is prose now
        // — the four phrases above are all of it — and `decline_binding` is
        // what acts. The evidence is this event, checked by code.
        await processPendingWaEvents(
          depsFor(
            client,
            twin,
            threadTurns({ tool: DECLINE_BINDING_TOOL, evidence: noId }),
          ),
        );

        // THE ACT'S EXISTING WORD, unchanged (spec #171 decision 22).
        expect(await disposition(client, noId)).toBe("declined");
        // The chat stays exactly as provisional as an unanswered question
        // leaves it — and the once-ever rule is untouched.
        expect(twin.bundle.listChatBindings()).toEqual([]);
        // ...AND THE REP IS FINALLY TOLD, which is the one thing that
        // changed for them: the receipt is rendered from the tool's result
        // and posts on its own, because the twin had nothing else to say.
        const notices = await client.query<{ kind: string; content_enc: Buffer }>(
          "SELECT kind, content_enc FROM notices WHERE twin_id = $1 ORDER BY created_at",
          [twin.twinId],
        );
        expect(notices.rows.map((row) => row.kind)).toEqual([
          "binding_question",
          "binding_ack",
        ]);
        expect(
          Buffer.from(twin.dek.decrypt(notices.rows[1]!.content_enc)).toString("utf8"),
        ).toBe("✳️ Entendido, este chat sigue sin confirmar.");
        const taps = await client.query("SELECT id FROM taps");
        expect(taps.rows).toEqual([]);
        twin.bundle.close();
      });
    },
  );

  it("a declined binding does not stop the ceremony from having been asked — and the chat is never re-asked", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await seedSendConfig(client, twin.twinId);
      const { questionCommandId } = await bornQuestion(client, twin);
      const posted = `WAMID-QUESTION-ONCE-${randomUUID()}`;
      await simulateExecutorPost(client, {
        commandId: questionCommandId,
        twinId: twin.twinId,
        waMessageId: posted,
      });

      const noId = await insertWaEvent(
        client,
        twin.dek,
        repReply(twin.twinId, "no, ese no es Torres", posted, `3EB0-ONCE-${randomUUID()}`),
      );
      await processPendingWaEvents(
        depsFor(
          client,
          twin,
          threadTurns({ tool: DECLINE_BINDING_TOOL, evidence: noId }),
        ),
      );

      // WHERE A DECLINE IS RECORDED (#174's own question, answered): in the
      // event's marker and the receipt, and nowhere else. It needs no row
      // of its own, because the once-ever ceremony keys on the QUESTION
      // notice being committed rather than on its answer — so it already
      // never re-asks, whatever the rep said. A `binding_declines` table
      // would be a second answer to a question the notice already answers.
      const asked = await client.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM notices WHERE twin_id = $1 AND kind = 'binding_question'",
        [twin.twinId],
      );
      expect(asked.rows[0]!.n).toBe("1");

      // A second customer message in the same chat earns no second question.
      await insertWaEvent(client, twin.dek, {
        twinId: twin.twinId,
        chatJid: CHAT,
        senderJid: CHAT,
        fromMe: false,
        messageId: `WAMID-IN-AGAIN-${randomUUID()}`,
        text: "¿y para cuándo?",
        pushName: PUSH_NAME,
      });
      await processPendingWaEvents(depsFor(client, twin, draftingTurns()));
      const askedAgain = await client.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM notices WHERE twin_id = $1 AND kind = 'binding_question'",
        [twin.twinId],
      );
      expect(askedAgain.rows[0]!.n).toBe("1");
      twin.bundle.close();
    });
  });

  it("after confirmation, framed posts render the rep-confirmed name unmarked — and never re-ask", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const { questionCommandId } = await bornQuestion(client, twin);
      await simulateExecutorPost(client, {
        commandId: questionCommandId,
        twinId: twin.twinId,
        waMessageId: "WAMID-QUESTION-2",
      });
      await insertWaEvent(
        client,
        twin.dek,
        repReply(twin.twinId, "va", "WAMID-QUESTION-2", "3EB0-REP-B2"),
      );
      await processPendingWaEvents(depsFor(client, twin, entityKindTurns()));

      // The next draft — even with a different push-name on the wire —
      // wears the rep-confirmed name, unmarked.
      await insertWaEvent(
        client,
        twin.dek,
        customerInbound(twin.twinId, "3EB0-B5-2", {
          pushName: "Garza Abarrotes",
        }),
      );
      await processPendingWaEvents(depsFor(client, twin, draftingTurns()));

      const posts = await decryptedDraftPosts(client, twin);
      expect(posts[1]).toContain("*Borrador — para Sra. Garza*");
      expect(posts[1]).not.toContain("(sin confirmar)");
      expect(await bindingQuestions(client, twin)).toHaveLength(1);
      twin.bundle.close();
    });
  });

  it("a reply carrying no verb the question accepts mints nothing — content is a follow-up the Q&A owns, and the bare-phrase rule holds for the new words too", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const { questionCommandId } = await bornQuestion(client, twin);
      await simulateExecutorPost(client, {
        commandId: questionCommandId,
        twinId: twin.twinId,
        waMessageId: "WAMID-QUESTION-3",
      });

      // «sí, es ella» reads as agreement and is not the verb: the
      // bare-phrase rule is unchanged for every verb (ticket #49 AC 4), so
      // content beyond the phrase confirms nothing.
      const contentId = await insertWaEvent(
        client,
        twin.dek,
        repReply(twin.twinId, "sí, es ella", "WAMID-QUESTION-3", "3EB0-REP-B4"),
      );
      // «¿si?» is a QUESTION, disqualified by the «¿?» anywhere rule.
      const askedId = await insertWaEvent(
        client,
        twin.dek,
        repReply(twin.twinId, "¿si?", "WAMID-QUESTION-3", "3EB0-REP-B4B"),
      );
      // Routing (spec #29 decision 2): a binding question IS a twin post,
      // so a reply quoting it that carries no verb this kind accepts is a
      // follow-up the Q&A owns, with the question as context. The twin is
      // scripted silent on both — the honest reading of prose pointed at a
      // question the rep did not answer.
      await processPendingWaEvents(
        // A RULE: the two thread turns run at once (`Script`).
        depsFor(client, twin, () => qaSilenceTurns()),
      );

      expect(await disposition(client, contentId)).toBe("deliberate_silence");
      expect(await disposition(client, askedId)).toBe("deliberate_silence");
      // Nothing minted: no binding — a content reply is NOT a confirmation,
      // however affirmative it reads.
      expect(twin.bundle.listChatBindings()).toEqual([]);
      // No dismissal machinery fired: no row, no «Descartado» ack.
      const dismissals = await client.query("SELECT draft_id FROM draft_dismissals");
      expect(dismissals.rows).toEqual([]);
      const notices = await client.query(
        "SELECT kind FROM notices WHERE twin_id = $1",
        [twin.twinId],
      );
      expect(notices.rows).toEqual([{ kind: "binding_question" }]);
      twin.bundle.close();
    });
  });

  it("a repeat «va» on the question is idempotent — the first confirmation stands, disposition binding_confirmed, still one binding", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const { questionCommandId } = await bornQuestion(client, twin);
      await simulateExecutorPost(client, {
        commandId: questionCommandId,
        twinId: twin.twinId,
        waMessageId: "WAMID-QUESTION-4",
      });
      await insertWaEvent(
        client,
        twin.dek,
        repReply(twin.twinId, "va", "WAMID-QUESTION-4", "3EB0-REP-B5"),
      );
      await processPendingWaEvents(depsFor(client, twin, entityKindTurns()));
      const first = twin.bundle.listChatBindings()[0]!;

      const repeatId = await insertWaEvent(
        client,
        twin.dek,
        repReply(twin.twinId, "va", "WAMID-QUESTION-4", "3EB0-REP-B6"),
      );
      // The repeat determines again and files nothing: the create is
      // idempotent on the minted id, so the second determination lands as
      // the same value on the same row (ticket #60).
      await processPendingWaEvents(depsFor(client, twin, entityKindTurns()));

      expect(await disposition(client, repeatId)).toBe("binding_confirmed");
      expect(twin.bundle.listChatBindings()).toEqual([first]);
      // The ack rides the rep's ACT, like «Descartado» does: each
      // confirming reply is acknowledged, and both name the binding that
      // STANDS rather than the name the question re-proposed.
      expect(await ackTexts(client, twin)).toEqual([ACK_TEXT, ACK_TEXT]);
      twin.bundle.close();
    });
  });

  it("a crash between the mirror write and the marker replays cleanly: the confirmed binding is recognized, marked binding_confirmed, never doubled", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const { questionCommandId } = await bornQuestion(client, twin);
      await simulateExecutorPost(client, {
        commandId: questionCommandId,
        twinId: twin.twinId,
        waMessageId: "WAMID-QUESTION-5",
      });
      const vaId = await insertWaEvent(
        client,
        twin.dek,
        repReply(twin.twinId, "va", "WAMID-QUESTION-5", "3EB0-REP-B7"),
      );

      // The crash signature: the bundle write landed (through the bundle
      // API — the same write the consumer performs), the marker did not.
      twin.bundle.confirmChatBinding({
        chatJid: CHAT,
        entityId: randomUUID(),
        displayName: PUSH_NAME,
        confirmedAt: new Date().toISOString(),
      });
      const preReplay = twin.bundle.listChatBindings();

      await processPendingWaEvents(depsFor(client, twin, entityKindTurns()));

      expect(await disposition(client, vaId)).toBe("binding_confirmed");
      expect(twin.bundle.listChatBindings()).toEqual(preReplay);
      // The ack survives the crash (ticket #49): it commits with the
      // MARKER, not with the mirror write, so the replay that finds the
      // binding already standing still tells the rep it landed — and names
      // the standing binding, which is why `confirmBindingFromQuestion`
      // returns it rather than the question's proposal.
      expect(await ackTexts(client, twin)).toEqual([ACK_TEXT]);
      twin.bundle.close();
    });
  });
});

describe("cross-wiring and poison: the matcher binds by quoted-id (ticket #34 ACs 3, 6)", () => {
  it("a draft «va» can never confirm a binding — even when injected model output proposes one inside the draft: the tap mints, the mirror stays empty", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await seedSendConfig(client, twin.twinId);
      // The poisoned draft body: model output impersonating the ceremony.
      const poison =
        "✳️ ¿Este chat es de Evil Corp?\n\nPara confirmarlo, responde a este mensaje citándolo con «va».";
      await insertWaEvent(
        client,
        twin.dek,
        customerInbound(twin.twinId, "3EB0-P1-1", { pushName: PUSH_NAME }),
      );
      await processPendingWaEvents(depsFor(client, twin, draftingTurns(poison)));

      // The executor posts the DRAFT (the question stays unposted — the
      // rep is quoting the draft post, decorated with poison).
      const draftCmd = await client.query<{ id: string; draft_id: string }>(
        `SELECT id, draft_id FROM send_commands
          WHERE twin_id = $1 AND send_class = 'system_send' AND draft_id IS NOT NULL`,
        [twin.twinId],
      );
      await simulateExecutorPost(client, {
        commandId: draftCmd.rows[0]!.id,
        twinId: twin.twinId,
        waMessageId: "WAMID-DRAFT-P1",
      });

      const vaId = await insertWaEvent(
        client,
        twin.dek,
        repReply(twin.twinId, "va", "WAMID-DRAFT-P1", "3EB0-REP-P1"),
      );
      await processPendingWaEvents(depsFor(client, twin));

      // The «va» quoted a DRAFT post: it taps — it can never bind.
      expect(await disposition(client, vaId)).toBe("affirmed");
      const taps = await client.query(
        "SELECT id FROM taps WHERE draft_id = $1",
        [draftCmd.rows[0]!.draft_id],
      );
      expect(taps.rows).toHaveLength(1);
      expect(twin.bundle.listChatBindings()).toEqual([]);
      twin.bundle.close();
    });
  });

  it("the poisoned echo extended to the ceremony: a twin-authored post echoing back can never confirm, even quoting the question with «va»", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const { questionCommandId } = await bornQuestion(client, twin);
      await simulateExecutorPost(client, {
        commandId: questionCommandId,
        twinId: twin.twinId,
        waMessageId: "WAMID-QUESTION-6",
      });

      // The twin posts again (the draft); the executor records its id —
      // the origin tag. Its echo comes back from_me, poisoned with a
      // quoted reference to the question and affirmation text.
      const draftCmd = await client.query<{ id: string }>(
        `SELECT id FROM send_commands
          WHERE twin_id = $1 AND send_class = 'system_send' AND draft_id IS NOT NULL`,
        [twin.twinId],
      );
      await simulateExecutorPost(client, {
        commandId: draftCmd.rows[0]!.id,
        twinId: twin.twinId,
        waMessageId: "WAMID-TWIN-POST-6",
      });
      const echoId = await insertWaEvent(
        client,
        twin.dek,
        repReply(twin.twinId, "va", "WAMID-QUESTION-6", "WAMID-TWIN-POST-6"),
      );

      await processPendingWaEvents(depsFor(client, twin));

      expect(await disposition(client, echoId)).toBe("captured");
      expect(twin.bundle.listChatBindings()).toEqual([]);
      twin.bundle.close();
    });
  });
});
