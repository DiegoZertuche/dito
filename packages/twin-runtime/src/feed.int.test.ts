/**
 * THE POST PRIMITIVE AND ITS FEED, AT THE POSTGRES SEAM (ticket #220; spec
 * #214 decision 2 and its Testing Decisions — "the post primitive is proven
 * at this seam: a scripted drafting run yields one `posts` row whose parts
 * render to today's Borrador text").
 *
 * A scripted run, then the read. `wa_events` fixtures in with real
 * DEK-encrypted payloads; out the other side the `posts` row, its sealed
 * parts, and what the feed returns when the runtime opens them. Real
 * Postgres, real envelope crypto, real SQLCipher (ADR-0028); the model is
 * scripted at the model boundary and CI never calls one.
 *
 * WHAT THIS FILE DOES NOT RE-PROVE. The thread's BYTES are pinned by the
 * suites that already pin them — `grammar.test.ts`, `thread.int.test.ts`,
 * `disclosure.int.test.ts` — and those pass unchanged, which is the whole of
 * this ticket's byte-identity claim. What is asserted here instead is that
 * the thread's frozen text and the feed's opened parts are the SAME record
 * read two ways: every line the feed returns is checked against the bytes the
 * rep actually read.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createBundle, type Bundle } from "@dito/bundle";
import { createDekFromMaterial, type Dek } from "@dito/crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { processPendingWaEvents, type TwinRuntimeDeps } from "./consumer.js";
import { performDashboardAct } from "./dashboard-acts.js";
import { runDailyDisclosure } from "./testing/by-hand.js";
import { readFeed, type FeedPost } from "./feed.js";
import { reexpressStrayPosts } from "./posts.js";
import { createSendLockWriter } from "./send-lock/writer.js";
import { composedDisclosure } from "./testing/disclosure-script.js";
import {
  resetAndMigrate,
  withClient,
  TEST_AUDIT_HMAC_KEY,
  TEST_DATABASE_URL,
} from "./testing/db.js";
import { newExecutionPool } from "./testing/execution-pool.js";
import { fakeEmbedder } from "./testing/fake-embedder.js";
import {
  closeScriptedModels,
  entityKindTurns,
  scriptedModel,
  type Script,
  type ScriptedTurn,
} from "./testing/scripted-model.js";
import { insertWaEvent, simulateExecutorPost } from "./testing/seam-fixtures.js";
import { SETTLE_IMMEDIATELY } from "./testing/settle.js";
import { threadTurns } from "./testing/thread-script.js";
import { removeTmpDir } from "./testing/tmp.js";
import { DECLINE_BINDING_TOOL, DISMISS_DRAFT_TOOL } from "./thread/acts.js";
import { RESOLVE_CHAT_TOOL } from "./thread/tools.js";
import { CREATE_DRAFT_TOOL } from "./thread/write.js";

// Every scripted model this suite opened is closed with it (#328).
afterAll(closeScriptedModels);

const SELF_CHAT = "5215550000@s.whatsapp.net";
const CUSTOMER = "5215550001@s.whatsapp.net";
const PUSH_NAME = "Sra. Garza";
const ZONE = "America/Monterrey";
const DRAFT_TEXT = "claro, se las mando el jueves temprano";
/** The sentence the drafting turn finishes on: the card's sentence (ticket #368). */
const SENTENCE = "Te dejé la respuesta: preguntó por 40 cajas y quedó sin respuesta.";

/** 2026-08-29 10:20 America/Monterrey — the customer's message. */
const MORNING = new Date("2026-08-29T16:20:00.000Z");
/** 2026-08-29 21:00 America/Monterrey — the evening's disclosure pass. */
const EVENING = new Date("2026-08-30T03:00:00.000Z");

const executionPool = newExecutionPool();

let tmp: string;
let pool: pg.Pool;

beforeAll(async () => {
  await resetAndMigrate();
  tmp = mkdtempSync(join(tmpdir(), "dito-feed-int-"));
  pool = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 4 });
});

afterAll(async () => {
  await pool.end();
  removeTmpDir(tmp);
});

interface Seat {
  readonly twinId: string;
  readonly companyId: string;
  readonly seatId: string;
  readonly dek: Dek;
  readonly bundle: Bundle;
}

function freshTwin(): Seat {
  const twinId = randomUUID();
  const dek = createDekFromMaterial(randomBytes(32));
  return {
    twinId,
    companyId: randomUUID(),
    seatId: randomUUID(),
    dek,
    bundle: createBundle(join(tmp, `${twinId}.bundle`), dek),
  };
}

function depsFor(
  client: pg.Client,
  twin: Seat,
  script: Script = [],
): TwinRuntimeDeps {
  const { harness } = scriptedModel(script);
  return {
    db: client,
    harness,
    bundle: twin.bundle,
    dek: twin.dek,
    twinId: twin.twinId,
    selfChatJid: SELF_CHAT,
    ...SETTLE_IMMEDIATELY,
    drafting: { model: "claude-sonnet-5" },
    embedder: fakeEmbedder(),
    executionPool,
    sendLock: createSendLockWriter({ pool, hmacKey: TEST_AUDIT_HMAC_KEY }),
    hmacKey: TEST_AUDIT_HMAC_KEY,
    timeZone: ZONE,
  };
}

function draftingTurns(bindingQuestion?: string): ScriptedTurn[] {
  return [
    {
      toolCall: {
        name: "create_draft",
        input: {
          text: DRAFT_TEXT,
          ...(bindingQuestion === undefined ? {} : { binding_question: bindingQuestion }),
        },
      },
    },
    { text: SENTENCE },
  ];
}

/** One customer message on the seam, and the turn the twin drafts for it. */
async function customerWrites(
  client: pg.Client,
  twin: Seat,
  args: { readonly tag: string; readonly at?: Date } = { tag: "A" },
): Promise<string> {
  return insertWaEvent(client, twin.dek, {
    twinId: twin.twinId,
    companyId: twin.companyId,
    seatId: twin.seatId,
    chatJid: CUSTOMER,
    senderJid: CUSTOMER,
    fromMe: false,
    messageId: `3EB0-IN-${args.tag}-${twin.twinId.slice(0, 8)}`,
    text: "¿me mandas 40 cajas para el jueves?",
    pushName: PUSH_NAME,
    occurredAt: args.at ?? MORNING,
  });
}

/** One rep message in their own thread, quoting a post of the twin's. */
async function repWrites(
  client: pg.Client,
  twin: Seat,
  text: string,
  quotedMessageId?: string,
): Promise<string> {
  return insertWaEvent(client, twin.dek, {
    twinId: twin.twinId,
    companyId: twin.companyId,
    seatId: twin.seatId,
    chatJid: SELF_CHAT,
    senderJid: SELF_CHAT,
    fromMe: true,
    messageId: `3EB0-REP-${randomUUID().slice(0, 8)}`,
    text,
    ...(quotedMessageId === undefined ? {} : { quotedMessageId }),
    occurredAt: MORNING,
  });
}

/** The whole feed, newest first, as one page. */
async function feedOf(
  client: pg.Client,
  twin: Seat,
  /**
   * What «hoy» means while the record lines render. The evening's own instant
   * by default, so a suite reading a day's post back gets the clause the
   * thread printed.
   */
  now?: Date,
): Promise<FeedPost[]> {
  const page = await readFeed(
    {
      db: client,
      twinId: twin.twinId,
      dek: twin.dek,
      timeZone: ZONE,
      // THE ENTITY MIRROR, which is where a binding question's ANSWER is read
      // from (ticket #255, F34) — one authority for both surfaces, so «va» in
      // the thread and the card's own button settle the same card.
      bundle: twin.bundle,
    },
    { now: now ?? EVENING, limit: 50 },
  );
  return [...page.posts];
}

/** What the rep actually read, decrypted from the row the executor posts. */
async function threadTextOf(
  client: pg.Client,
  twin: Seat,
  post: FeedPost,
): Promise<string> {
  const res = await client.query<{ content_enc: Buffer }>(
    `SELECT COALESCE(n.content_enc, d.post_enc) AS content_enc
       FROM posts p
       LEFT JOIN notices n ON n.id = p.notice_id
       LEFT JOIN drafts d ON d.id = p.draft_id
      WHERE p.id = $1`,
    [post.id],
  );
  return Buffer.from(twin.dek.decrypt(res.rows[0]!.content_enc)).toString(
    "utf8",
  );
}

/** The `system_send` the executor posted this post under. */
async function postedAs(
  client: pg.Client,
  twin: Seat,
  post: FeedPost,
  waMessageId: string,
): Promise<void> {
  const res = await client.query<{ id: string }>(
    `SELECT sc.id
       FROM posts p
       JOIN send_commands sc
         ON sc.payload_ref = COALESCE('notice:' || p.notice_id, 'draft:' || p.draft_id)
      WHERE p.id = $1 AND sc.twin_id = $2`,
    [post.id, twin.twinId],
  );
  await simulateExecutorPost(client, {
    commandId: res.rows[0]!.id,
    twinId: twin.twinId,
    waMessageId,
  });
}

describe("a scripted drafting run yields one post whose parts are the draft (AC 1)", () => {
  it("names the draft and its counterparty, carries the twin's sentence before it — and the body is the draft's own", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await customerWrites(client, twin);
      expect(
        await processPendingWaEvents(depsFor(client, twin, draftingTurns())),
      ).toEqual({ processed: 1, drafted: 1 });

      const feed = await feedOf(client, twin);
      // ONE POST for the draft, and one for the ceremony that rides it.
      const draftPosts = feed.filter((post) =>
        post.parts.some((part) => part.kind === "draft"),
      );
      expect(draftPosts).toHaveLength(1);
      const [only] = draftPosts;
      expect(only!.parts.map((one) => one.kind)).toEqual(["prose", "draft"]);
      expect(only!.parts[0]).toMatchObject({ kind: "prose", text: SENTENCE });
      const part = only!.parts[1]!;
      expect(part.kind).toBe("draft");
      if (part.kind !== "draft") throw new Error("unreachable");
      // PROVISIONAL, because nobody has confirmed this chat yet — the part
      // carries the name the POST named, marked exactly as the rep read it
      // (#34's naming rule).
      expect(part.counterparty).toBe(`${PUSH_NAME} (sin confirmar)`);
      // THE BODY IS THE ROW A TAP RELEASES (ADR-0006), opened under the DEK
      // — never a copy inside the part.
      expect(part.body).toBe(DRAFT_TEXT);
      expect(part.acts).toEqual(["tap", "dismiss"]);

      // ...and the post the rep read is the Borrador those values render to.
      // The suites that PIN those bytes are `grammar.test.ts` and
      // `drafting.int.test.ts`; what this checks is that the feed and the
      // thread are one record.
      const thread = await threadTextOf(client, twin, only!);
      expect(thread).toContain(`*Borrador — para ${part.counterparty}*`);
      expect(thread).toContain(`«${part.body}»`);
      expect(thread).toContain(SENTENCE);
      expect(thread).not.toContain("Porque:");
      expect(only!.executionId).not.toBeNull();
      twin.bundle.close();
    });
  });

  it("a rep-initiated draft is the same post shape as a customer-triggered one", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      // A bound chat, so `create_draft` can reach it.
      const entityId = randomUUID();
      twin.bundle.confirmChatBinding({
        chatJid: CUSTOMER,
        entityId,
        displayName: PUSH_NAME,
        confirmedAt: MORNING.toISOString(),
      });
      await repWrites(client, twin, `escríbele a ${PUSH_NAME} que ya salió`);
      await processPendingWaEvents(
        depsFor(client, twin, [
          { toolCall: { name: RESOLVE_CHAT_TOOL, input: { name: PUSH_NAME } } },
          {
            toolCall: {
              name: CREATE_DRAFT_TOOL,
              input: {
                entity: `c${String(twin.bundle.referenceOfEntity(entityId))}`,
                text: "ya salió su pedido",
              },
            },
          },
          { text: "listo, ahí va" },
        ]),
      );

      const feed = await feedOf(client, twin);
      const [part] = feed.flatMap((post) =>
        post.parts.filter((candidate) => candidate.kind === "draft"),
      );
      expect(part).toBeDefined();
      if (part?.kind !== "draft") throw new Error("unreachable");
      expect(part.counterparty).toBe(PUSH_NAME);
      expect(part.body).toBe("ya salió su pedido");
      twin.bundle.close();
    });
  });
});

describe("a binding proposal yields a question part of subject kind binding (AC 3)", () => {
  it("names the subject, its two acts and the event whose payload the confirmation re-derives", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const eventId = await customerWrites(client, twin);
      await processPendingWaEvents(
        depsFor(
          client,
          twin,
          draftingTurns("¿este chat es de {name}?"),
        ),
      );

      const feed = await feedOf(client, twin);
      const asking = feed.find((post) =>
        post.parts.some((part) => part.kind === "question"),
      );
      // THE TWIN'S OWN SENTENCE RIDES BESIDE THE QUESTION (Codex r2): the
      // part carries no words, so a card that rendered only the question
      // would offer confirm and decline over nothing to read.
      expect(asking!.parts.map((part) => part.kind)).toEqual([
        "prose",
        "question",
      ]);
      expect(
        asking!.parts[0]!.kind === "prose" ? asking!.parts[0]!.text : "",
      ).toBe(`¿este chat es de ${PUSH_NAME}?`);
      const question = asking!.parts[1]!;
      if (question.kind !== "question") throw new Error("unreachable");
      expect(question.subject).toBe("binding");
      expect(question.proposedName).toBe(PUSH_NAME);
      expect(question.aboutEventId).toBe(eventId);
      expect(question.acts).toEqual(["confirm", "decline"]);

      // The store carries the subject in the clear, so a surface can ask
      // "is there a question here" without a key.
      const subjects = await client.query<{ question_subject: string | null }>(
        "SELECT question_subject FROM posts WHERE twin_id = $1 ORDER BY posted_at",
        [twin.twinId],
      );
      expect(subjects.rows.map((row) => row.question_subject)).toEqual([
        null,
        "binding",
      ]);
      twin.bundle.close();
    });
  });

  it("settles the card the rep answered, and offers nothing after (#255, F34)", async () => {
    // THE RIG'S FAILURE: the card went on offering «Sí, es este cliente» and
    // «Es otro cliente» under a question the rep had answered five minutes
    // earlier, while the receipt sat two cards below as a post of its own.
    await withClient(async (client) => {
      const twin = freshTwin();
      await customerWrites(client, twin);
      await processPendingWaEvents(
        depsFor(client, twin, draftingTurns("¿este chat es de {name}?")),
      );
      const asking = (await feedOf(client, twin)).find((post) =>
        post.parts.some((part) => part.kind === "question"),
      );
      // THE CARD'S OWN CONFIRM, through the act both surfaces share — not a
      // row planted here: what settles the card has to be what the button
      // actually writes.
      expect(
        await performDashboardAct(
          depsFor(client, twin),
          { companyId: twin.companyId, seatId: twin.seatId },
          { target: "post", route: "confirmBinding", postId: asking!.id },
        ),
      ).toBe("performed");
      const answered = (await feedOf(client, twin)).find(
        (post) => post.id === asking!.id,
      );
      const question = answered!.parts[1]!;
      if (question.kind !== "question") throw new Error("unreachable");
      expect(question.answer).toBe("confirmed");
      // NO ACT, WHICH IS WHAT A SURFACE DRAWS ITS BUTTONS FROM: the answer and
      // the empty list are decided in one place rather than by every renderer
      // agreeing to check both.
      expect(question.acts).toEqual([]);
      twin.bundle.close();
    });
  });

  it("settles it for the rep who answered in their own thread instead", async () => {
    // ONE AUTHORITY FOR BOTH SURFACES: «va» quoting the question lands in the
    // entity mirror, exactly as the card's button does, so a rep who answered
    // on their phone meets a settled card on their laptop.
    await withClient(async (client) => {
      const twin = freshTwin();
      await customerWrites(client, twin);
      await processPendingWaEvents(
        depsFor(client, twin, draftingTurns("¿este chat es de {name}?")),
      );
      twin.bundle.confirmChatBinding({
        chatJid: CUSTOMER,
        entityId: randomUUID(),
        displayName: PUSH_NAME,
        confirmedAt: MORNING.toISOString(),
      });
      const asking = (await feedOf(client, twin)).find((post) =>
        post.parts.some((part) => part.kind === "question"),
      );
      const question = asking!.parts[1]!;
      if (question.kind !== "question") throw new Error("unreachable");
      expect(`${question.answer ?? ""} / ${question.acts.join(",")}`).toBe(
        "confirmed / ",
      );
      twin.bundle.close();
    });
  });

  it("settles it for a decline, which writes only its own act row", async () => {
    // A DECLINE WRITES NOTHING ELSE (`declineBinding` argues it: an
    // unconfirmed binding is the chat staying provisional), so the act naming
    // this post is the only record of one — and the card reads it.
    await withClient(async (client) => {
      const twin = freshTwin();
      await customerWrites(client, twin);
      await processPendingWaEvents(
        depsFor(client, twin, draftingTurns("¿este chat es de {name}?")),
      );
      const asking = (await feedOf(client, twin)).find((post) =>
        post.parts.some((part) => part.kind === "question"),
      );
      expect(
        await performDashboardAct(
          depsFor(client, twin),
          { companyId: twin.companyId, seatId: twin.seatId },
          { target: "post", route: "declineBinding", postId: asking!.id },
        ),
      ).toBe("performed");
      const answered = (await feedOf(client, twin)).find(
        (post) => post.id === asking!.id,
      );
      const question = answered!.parts[1]!;
      if (question.kind !== "question") throw new Error("unreachable");
      expect(`${question.answer ?? ""} / ${question.acts.join(",")}`).toBe(
        "declined / ",
      );
      twin.bundle.close();
    });
  });

  it("settles it for a decline the rep said in their own thread (ticket #268)", async () => {
    // REMAINDER 1 OF #256, CLOSED. «No va» writes no act row and no binding —
    // `declineBindingTool` says so itself: the record is the event's own
    // `declined` marker and the receipt beside it — so a card the rep had
    // answered on their phone went on offering both buttons for ever. The
    // third authority is read in `bindingQuestionState`.
    await withClient(async (client) => {
      const twin = freshTwin();
      await customerWrites(client, twin);
      await processPendingWaEvents(
        depsFor(client, twin, draftingTurns("¿este chat es de {name}?")),
      );
      const asking = (await feedOf(client, twin)).find((post) =>
        post.parts.some((part) => part.kind === "question"),
      );
      // THE QUESTION HAS TO HAVE REACHED THE THREAD for the rep to quote it:
      // the walk back from a decline is «which rail message did this post go
      // out as, and does a declined message quote it».
      const posted = `3EB0-Q-${randomUUID().slice(0, 8)}`;
      await postedAs(client, twin, asking!, posted);
      const noId = await repWrites(client, twin, "no, ese no es", posted);
      await processPendingWaEvents(
        depsFor(
          client,
          twin,
          threadTurns({ tool: DECLINE_BINDING_TOOL, evidence: noId }),
        ),
      );

      const settled = (await feedOf(client, twin)).find(
        (post) => post.id === asking!.id,
      );
      const answeredQuestion = settled!.parts[1]!;
      if (answeredQuestion.kind !== "question") {
        throw new Error("unreachable");
      }
      expect(
        `${answeredQuestion.answer ?? ""} / ${answeredQuestion.acts.join(",")}`,
      ).toBe("declined / ");
      twin.bundle.close();
    });
  });

  it("names the chat it is about: its number, and the directory's own name", async () => {
    // «Ligar chat con cliente — Sra. Garza» names the PROPOSED CUSTOMER and
    // not the conversation (boundary #225, F35), so the rep could not tell
    // which chat they were binding. The name is the DIRECTORY's — what their
    // own phone calls the chat — which is why it differs from the push name
    // the question proposed.
    await withClient(async (client) => {
      const twin = freshTwin();
      await client.query(
        `INSERT INTO chat_directory (twin_id, chat_jid, kind, name_enc)
         VALUES ($1, $2, 'dm', $3)`,
        [
          twin.twinId,
          CUSTOMER,
          Buffer.from(twin.dek.encrypt(Buffer.from("Garza · Refaccionaria", "utf8"))),
        ],
      );
      await customerWrites(client, twin);
      await processPendingWaEvents(
        depsFor(client, twin, draftingTurns("¿este chat es de {name}?")),
      );
      const asking = (await feedOf(client, twin)).find((post) =>
        post.parts.some((part) => part.kind === "question"),
      );
      const question = asking!.parts[1]!;
      if (question.kind !== "question") throw new Error("unreachable");
      // THE DIGITS AND NEVER THE ADDRESS: a JID on a served page is a
      // customer's identity in the HTML and in every log between (ADR-0004).
      expect(question.chatNumber).toBe("5215550001");
      expect(question.chatName).toBe("Garza · Refaccionaria");
      expect(question.proposedName).toBe(PUSH_NAME);
      twin.bundle.close();
    });
  });

  it("shows no number for a chat the rail addresses by LID", async () => {
    // A LID IS AN OPAQUE IDENTIFIER THE PHONE ASSIGNS, and its digits are not
    // a number anybody can dial — so printing them would offer the rep
    // something to compare that cannot match. The directory's own name is what
    // identifies the chat then (`chatNumberOf` argues the absence).
    const LID_CHAT = "111222333444555@lid";
    await withClient(async (client) => {
      const twin = freshTwin();
      await client.query(
        `INSERT INTO chat_directory (twin_id, chat_jid, kind, name_enc)
         VALUES ($1, $2, 'dm', $3)`,
        [
          twin.twinId,
          LID_CHAT,
          Buffer.from(twin.dek.encrypt(Buffer.from("Torres Hnos.", "utf8"))),
        ],
      );
      await insertWaEvent(client, twin.dek, {
        twinId: twin.twinId,
        companyId: twin.companyId,
        seatId: twin.seatId,
        chatJid: LID_CHAT,
        senderJid: LID_CHAT,
        fromMe: false,
        messageId: `3EB0-LID-${twin.twinId.slice(0, 8)}`,
        text: "¿me mandas 40 cajas para el jueves?",
        pushName: PUSH_NAME,
        occurredAt: MORNING,
      });
      await processPendingWaEvents(
        depsFor(client, twin, draftingTurns("¿este chat es de {name}?")),
      );
      const asking = (await feedOf(client, twin)).find((post) =>
        post.parts.some((part) => part.kind === "question"),
      );
      const question = asking!.parts[1]!;
      if (question.kind !== "question") throw new Error("unreachable");
      expect(question.chatNumber).toBeUndefined();
      expect(question.chatName).toBe("Torres Hnos.");
      twin.bundle.close();
    });
  });

  it("refuses a subject kind the closed set does not name", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      // A REAL DELIVERY ROW, so the ONLY constraint left to refuse this is
      // the subject's: a post with neither a notice nor a draft would fail
      // `posts_one_delivery_check` first and prove nothing about the subject.
      // The day's post is the one kind that is about neither a command nor a
      // single event (…20260829100025), so it needs nothing else planted.
      const notice = await client.query<{ id: string }>(
        `INSERT INTO notices (twin_id, kind, content_enc)
         VALUES ($1, 'daily_disclosure', $2) RETURNING id`,
        [twin.twinId, Buffer.from(twin.dek.encrypt(Buffer.from("✳️ x", "utf8")))],
      );
      await expect(
        client.query(
          `INSERT INTO posts (twin_id, origin, parts_enc, question_subject, notice_id)
           VALUES ($1, 'composed', $2, 'schedule', $3)`,
          [twin.twinId, Buffer.from("x"), notice.rows[0]!.id],
        ),
      ).rejects.toThrow(/posts_question_subject_check/u);
      twin.bundle.close();
    });
  });
});

describe("a dismissal yields a receipt part, and a claim without the tool yields none (AC 4)", () => {
  it("carries the receipt the tool returned", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await customerWrites(client, twin);
      await processPendingWaEvents(depsFor(client, twin, draftingTurns()));
      const [draftPost] = (await feedOf(client, twin)).filter((post) =>
        post.parts.some((part) => part.kind === "draft"),
      );
      await postedAs(client, twin, draftPost!, `WAMID-DRAFT-DISMISS-${twin.twinId.slice(0, 8)}`);

      const eventId = await repWrites(
        client,
        twin,
        "así no, mejor no le contestes",
        `WAMID-DRAFT-DISMISS-${twin.twinId.slice(0, 8)}`,
      );
      await processPendingWaEvents(
        depsFor(
          client,
          twin,
          threadTurns({ tool: DISMISS_DRAFT_TOOL, evidence: eventId }),
        ),
      );

      const [newest] = await feedOf(client, twin);
      expect(newest!.parts).toHaveLength(1);
      const receipt = newest!.parts[0]!;
      expect(receipt.kind).toBe("receipt");
      if (receipt.kind !== "receipt") throw new Error("unreachable");
      // The receipt's own sentence, unframed: the sigil belongs to the post
      // the thread renders, and the dashboard shows neither.
      expect(receipt.text).toBe("Descartado");
      expect(receipt.acts).toEqual([]);
      expect(await threadTextOf(client, twin, newest!)).toBe("✳️ Descartado");
      twin.bundle.close();
    });
  });

  it("a submission whose prose claims the dismissal, with no tool call, composes no receipt part", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await customerWrites(client, twin);
      await processPendingWaEvents(depsFor(client, twin, draftingTurns()));
      const [draftPost] = (await feedOf(client, twin)).filter((post) =>
        post.parts.some((part) => part.kind === "draft"),
      );
      await postedAs(client, twin, draftPost!, `WAMID-DRAFT-CLAIMED-${twin.twinId.slice(0, 8)}`);
      await repWrites(client, twin, "así no", `WAMID-DRAFT-CLAIMED-${twin.twinId.slice(0, 8)}`);

      // THE PROSE SAYS IT AND NO TOOL DID IT. A receipt part carries what a
      // TOOL returned, so there is nothing here for one to carry — which is
      // the receipts-are-code rule seen from the store side.
      await processPendingWaEvents(depsFor(client, twin, [{ text: "listo, lo descarté" }]));

      const [newest] = await feedOf(client, twin);
      expect(newest!.parts.map((part) => part.kind)).toEqual(["prose"]);
      const prose = newest!.parts[0]!;
      if (prose.kind !== "prose") throw new Error("unreachable");
      expect(prose.text).toBe("listo, lo descarté");
      // ...and nothing was dismissed.
      expect(
        (
          await client.query("SELECT 1 FROM draft_dismissals WHERE draft_id = $1", [
            draftPost!.parts.find((part) => part.kind === "draft")?.kind === "draft"
              ? (draftPost!.parts.find((part) => part.kind === "draft") as { draftId: string }).draftId
              : "",
          ])
        ).rows,
      ).toEqual([]);
      twin.bundle.close();
    });
  });
});

describe("a scripted disclosure run yields one post whose record lines are the sealed rows (AC 2)", () => {
  it("returns the lines numbered in stored order with the provenance clause the post printed", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      // A rep-confirmed binding is what crosses (ADR-0004), and the
      // ceremony is how one is made: the question, the executor's post, the
      // rep's own quoted «va».
      const askEventId = await customerWrites(client, twin, { tag: "DISC" });
      await processPendingWaEvents(depsFor(client, twin, draftingTurns()));
      const [questionPost] = (await feedOf(client, twin)).filter((post) =>
        post.parts.some((part) => part.kind === "question"),
      );
      await postedAs(client, twin, questionPost!, `WAMID-QUESTION-DISC-${twin.twinId.slice(0, 8)}`);
      expect(askEventId).toBeDefined();
      await repWrites(client, twin, "va", `WAMID-QUESTION-DISC-${twin.twinId.slice(0, 8)}`);
      await processPendingWaEvents(depsFor(client, twin, entityKindTurns()));

      // THE DAY OWES ONE LINE ALREADY: the confirmed binding filed an entity
      // create through the aperture with its disclosure line in the same
      // transaction (#50), which is what the evening's post is about.
      await runDailyDisclosure(
        depsFor(client, twin, composedDisclosure),
        EVENING,
      );

      const [newest] = await feedOf(client, twin);
      const thread = await threadTextOf(client, twin, newest!);
      const kinds = newest!.parts.map((part) => part.kind);
      expect(kinds).toEqual(["prose", "record-lines", "prose"]);
      const lines = newest!.parts[1]!;
      if (lines.kind !== "record-lines") throw new Error("unreachable");
      expect(lines.acts).toEqual(["retract"]);
      expect(lines.lines.length).toBeGreaterThan(0);
      expect(lines.lines.map((line) => line.index)).toEqual(
        lines.lines.map((_, at) => at + 1),
      );
      // EVERY LINE IS ATTRIBUTED TO THE NAME THE REP READ (Codex r1), from
      // the part's own sealed grouping rather than from a mirror lookup that
      // a later rename would answer differently.
      for (const line of lines.lines) {
        expect(line.counterparty).toBe(PUSH_NAME);
        expect(thread).toContain(`*${line.counterparty!}*`);
        // ...and the identity beside the name, which a re-expressed post has
        // when it has no heading (Codex r2).
        expect(line.entityId).toMatch(/^[0-9a-f-]{36}$/u);
      }

      // EVERY LINE THE FEED RETURNS IS A LINE THE REP READ, byte for byte:
      // the number, the stored text and the provenance clause, exactly as
      // the post printed them.
      for (const line of lines.lines) {
        expect(thread).toContain(
          `${String(line.index)}. ${line.text} (${line.provenance})`,
        );
      }
      // ...and the numbering the feed reads IS the sealed one (ADR-0034).
      const sealed = await client.query<{
        line_index: number;
        disclosure_line_id: string;
      }>(
        `SELECT pl.line_index, pl.disclosure_line_id
           FROM disclosure_post_lines pl
          WHERE pl.post_id = $1 ORDER BY pl.line_index`,
        [lines.disclosurePostId],
      );
      expect(sealed.rows).toEqual(
        lines.lines.map((line) => ({
          line_index: line.index,
          disclosure_line_id: line.disclosureLineId,
        })),
      );
      twin.bundle.close();
    });
  });
});

describe("the feed reads one twin's posts, newest first, by cursor (AC 5)", () => {
  it("pages without skipping or repeating a post, and never shows another twin's", async () => {
    await withClient(async (client) => {
      const mine = freshTwin();
      const theirs = freshTwin();
      for (const [at, twin] of [mine, theirs, mine, mine].entries()) {
        await customerWrites(client, twin, {
          tag: `P${String(at)}-${twin.twinId.slice(0, 4)}`,
          at: new Date(MORNING.getTime() + at * 60_000),
        });
        await processPendingWaEvents(depsFor(client, twin, draftingTurns()));
      }

      const whole = await feedOf(client, mine);
      // NEWEST FIRST, which is the order the dashboard's Inicio reads.
      const instants = whole.map((post) => post.at.getTime());
      expect([...instants].sort((a, b) => b - a)).toEqual(instants);

      const paged: FeedPost[] = [];
      let cursor: string | undefined;
      do {
        const page = await readFeed(
          { db: client, twinId: mine.twinId, dek: mine.dek, timeZone: ZONE },
          { now: EVENING, limit: 1, ...(cursor === undefined ? {} : { cursor }) },
        );
        paged.push(...page.posts);
        cursor = page.nextCursor;
        // A page of one, so the walk cannot terminate by accident.
        expect(page.posts.length).toBeLessThanOrEqual(1);
      } while (cursor !== undefined);
      expect(paged.map((post) => post.id)).toEqual(whole.map((post) => post.id));

      // AND NOT ONE OF THE OTHER TWIN'S, whose posts are in the same table.
      const others = new Set(
        (await feedOf(client, theirs)).map((post) => post.id),
      );
      expect(others.size).toBeGreaterThan(0);
      for (const post of whole) expect(others.has(post.id)).toBe(false);
      mine.bundle.close();
      theirs.bundle.close();
    });
  });

  it("refuses a cursor it did not mint", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await expect(
        readFeed(
          { db: client, twinId: twin.twinId, dek: twin.dek },
          { now: EVENING, cursor: "not-a-cursor" },
        ),
      ).rejects.toThrow(/cursor/u);
      twin.bundle.close();
    });
  });
});

describe("a post the migration re-expressed is reachable from the feed (AC 6)", () => {
  /**
   * THE MIGRATION'S OWN RE-EXPRESSION, RUN OVER A POPULATED DATABASE.
   *
   * `resetAndMigrate` migrates an EMPTY database, so …20260907100030's two
   * `INSERT … SELECT`s cover no rows in any lane — the migration's whole
   * claim about rows that predate `posts` would go unproven in CI. So this
   * plants delivery rows the way a build before this ticket wrote them, then
   * runs that migration's re-expression from the file itself, exactly as
   * `execution-stamps.int.test.ts`'s third sweep reads its own defaults off
   * `db/migrations`: the source of truth is the SQL that ships.
   */
  function reexpressionSql(): string {
    const sql = readFileSync(
      path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "../../../db/migrations/20260907100030_posts.sql",
      ),
      "utf8",
    );
    const at = sql.indexOf("INSERT INTO posts");
    expect(at, "the migration no longer re-expresses anything").toBeGreaterThan(
      0,
    );
    return sql.slice(at);
  }

  /** A notice written the way a build before `posts` wrote one: no post row. */
  async function plantNotice(
    client: pg.Client,
    twin: Seat,
    args: {
      readonly kind: string;
      readonly text: string;
      readonly aboutEventId?: string;
      readonly at: Date;
    },
  ): Promise<string> {
    const notice = await client.query<{ id: string }>(
      `INSERT INTO notices (twin_id, kind, about_event_id, content_enc, created_at)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [
        twin.twinId,
        args.kind,
        args.aboutEventId ?? null,
        Buffer.from(twin.dek.encrypt(Buffer.from(args.text, "utf8"))),
        args.at,
      ],
    );
    return notice.rows[0]!.id;
  }

  /** ...and the post the migration makes of it. */
  async function reexpress(
    client: pg.Client,
    twin: Seat,
    args: {
      readonly kind: string;
      readonly text: string;
      readonly aboutEventId?: string;
      readonly at: Date;
    },
  ): Promise<string> {
    const noticeId = await plantNotice(client, twin, args);
    await client.query(reexpressionSql());
    const post = await client.query<{ id: string }>(
      "SELECT id FROM posts WHERE notice_id = $1",
      [noticeId],
    );
    return post.rows[0]!.id;
  }

  it("re-expresses a populated database, and re-running it inserts nothing more", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const eventId = await customerWrites(client, twin, { tag: "MIG" });
      const at = new Date("2026-08-18T10:00:00.000Z");
      // Four delivery rows of the shapes that predate parts: a question, an
      // acknowledgement, an answer, and a draft with its frozen Borrador.
      const asked = await plantNotice(client, twin, {
        kind: "binding_question",
        text: `✳️ ¿Este chat es de ${PUSH_NAME}?`,
        aboutEventId: eventId,
        at,
      });
      const acked = await plantNotice(client, twin, {
        kind: "dismissal_ack",
        text: "✳️ Descartado",
        aboutEventId: eventId,
        at: new Date(at.getTime() + 1000),
      });
      const answered = await plantNotice(client, twin, {
        kind: "answer",
        text: "✳️ le dijiste que sí",
        aboutEventId: eventId,
        at: new Date(at.getTime() + 2000),
      });
      const draft = await client.query<{ id: string }>(
        `INSERT INTO drafts (twin_id, destination, content_enc, post_enc, created_at)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [
          twin.twinId,
          CUSTOMER,
          Buffer.from(twin.dek.encrypt(Buffer.from(DRAFT_TEXT, "utf8"))),
          Buffer.from(
            twin.dek.encrypt(Buffer.from("✳️ *Borrador — para X*", "utf8")),
          ),
          new Date(at.getTime() + 3000),
        ],
      );

      const before = await client.query<{ content_enc: Buffer }>(
        "SELECT content_enc FROM notices WHERE twin_id = $1 ORDER BY created_at",
        [twin.twinId],
      );
      await client.query(reexpressionSql());

      const posts = await client.query<{
        origin: string;
        parts_enc: Buffer | null;
        question_subject: string | null;
        notice_id: string | null;
        draft_id: string | null;
        posted_at: Date;
      }>(
        `SELECT origin, parts_enc, question_subject, notice_id, draft_id, posted_at
           FROM posts WHERE twin_id = $1 ORDER BY posted_at`,
        [twin.twinId],
      );
      expect(posts.rows).toHaveLength(4);
      expect(posts.rows.map((row) => row.origin)).toEqual([
        "reexpressed",
        "reexpressed",
        "reexpressed",
        "reexpressed",
      ]);
      // SQL SEALS NOTHING, so no re-expressed post carries parts.
      expect(posts.rows.every((row) => row.parts_enc === null)).toBe(true);
      // The question's subject is the one column a surface reads without a key.
      expect(
        posts.rows.map((row) => [row.notice_id, row.question_subject]),
      ).toEqual([
        [asked, "binding"],
        [acked, null],
        [answered, null],
        [null, null],
      ]);
      expect(posts.rows[3]!.draft_id).toBe(draft.rows[0]!.id);
      // THE DELIVERY ROW'S OWN INSTANT, never the migration's: the feed
      // orders newest first, and a year of posts under one instant would hand
      // the rep their history in the order the INSERT walked it.
      expect(posts.rows[0]!.posted_at.getTime()).toBe(at.getTime());

      // IDEMPOTENT: re-running it inserts nothing, because the delivery row's
      // unique constraint is the guarantee rather than the migration's own
      // bookkeeping.
      await client.query(reexpressionSql());
      expect(
        (
          await client.query<{ n: string }>(
            "SELECT count(*) AS n FROM posts WHERE twin_id = $1",
            [twin.twinId],
          )
        ).rows[0]!.n,
      ).toBe("4");
      // ...and it rewrote no post the rep had read.
      const after = await client.query<{ content_enc: Buffer }>(
        "SELECT content_enc FROM notices WHERE twin_id = $1 ORDER BY created_at",
        [twin.twinId],
      );
      expect(after.rows.map((row) => row.content_enc.toString("hex"))).toEqual(
        before.rows.map((row) => row.content_enc.toString("hex")),
      );
      twin.bundle.close();
    });
  });

  it("derives a receipt, a question and prose from the notice kinds that predate parts", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const eventId = await customerWrites(client, twin, { tag: "OLD" });
      await reexpress(client, twin, {
        kind: "dismissal_ack",
        text: "✳️ Descartado",
        aboutEventId: eventId,
        at: new Date("2026-08-20T10:00:00.000Z"),
      });
      await reexpress(client, twin, {
        kind: "binding_question",
        text: `✳️ ¿Este chat es de ${PUSH_NAME}?`,
        aboutEventId: eventId,
        at: new Date("2026-08-20T11:00:00.000Z"),
      });
      await reexpress(client, twin, {
        kind: "answer",
        text: "✳️ le dijiste que sí",
        aboutEventId: eventId,
        at: new Date("2026-08-20T12:00:00.000Z"),
      });

      const feed = await feedOf(client, twin);
      expect(feed.map((post) => post.origin)).toEqual([
        "reexpressed",
        "reexpressed",
        "reexpressed",
      ]);
      // NEWEST FIRST, and the instants are the notices' own — a year of
      // posts re-expressed under one instant would hand the rep their
      // history in the order the INSERT happened to walk it.
      //
      // THE QUESTION KEEPS ITS WORDS (Codex r1). A `question` part carries no
      // text, so the ask the rep read comes back as prose beside it — the
      // binding is one of the two acts a wrong yes cannot take back, and
      // confirm/decline over a blank card is the failure that closes.
      //
      // ...AND IT NAMES ITS CHAT EVEN HERE (ticket #255, F35): the number is
      // read off the question's own anchor event, which a re-expressed post
      // names exactly as a composed one does. There is no directory row for
      // this chat and nobody has answered, so the other three fields are
      // absent — a field nothing recorded is ABSENT and never a default.
      expect(feed.map((post) => post.parts)).toEqual([
        [{ kind: "prose", text: "le dijiste que sí", acts: [] }],
        [
          {
            kind: "prose",
            text: `¿Este chat es de ${PUSH_NAME}?`,
            acts: [],
          },
          {
            kind: "question",
            subject: "binding",
            aboutEventId: eventId,
            chatNumber: "5215550001",
            acts: ["confirm", "decline"],
          },
        ],
        [{ kind: "receipt", text: "Descartado", acts: [] }],
      ]);
      twin.bundle.close();
    });
  });

  it("re-expresses the day's post over a populated schema, lines and all (Codex r3)", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      // A REAL DAY FIRST, so there is a sealed `disclosure_lines` row to point
      // a second post at: the ceremony, the crossing, the evening's pass.
      await customerWrites(client, twin, { tag: "OLDDAY" });
      await processPendingWaEvents(depsFor(client, twin, draftingTurns()));
      const [asked] = (await feedOf(client, twin)).filter((post) =>
        post.parts.some((part) => part.kind === "question"),
      );
      await postedAs(
        client,
        twin,
        asked!,
        `WAMID-Q-OLDDAY-${twin.twinId.slice(0, 8)}`,
      );
      await repWrites(
        client,
        twin,
        "va",
        `WAMID-Q-OLDDAY-${twin.twinId.slice(0, 8)}`,
      );
      await processPendingWaEvents(depsFor(client, twin, entityKindTurns()));
      await runDailyDisclosure(
        depsFor(client, twin, composedDisclosure),
        EVENING,
      );
      const line = await client.query<{ id: string }>(
        "SELECT id FROM disclosure_lines WHERE twin_id = $1",
        [twin.twinId],
      );

      // ...AND NOW A DAY'S POST OF THE SHAPE A BUILD BEFORE PARTS WROTE ONE:
      // a `daily_disclosure` notice, its `disclosure_posts` row and its
      // numbering, sealed in ONE transaction as the trigger requires, and no
      // `posts` row anywhere. `disclosure_post_lines` is deliberately not
      // unique on the line (…20260829100025), so an earlier day may carry it.
      const frozen = "✳️ *Hoy agregué 1 dato al registro.*\n\nun día viejo\n\n*X*\n1. algo. (su chat, hoy 10:20)\n\ndime cuál";
      const older = new Date("2026-08-25T03:00:00.000Z");
      await client.query("BEGIN");
      const notice = await client.query<{ id: string }>(
        `INSERT INTO notices (twin_id, kind, content_enc, created_at)
         VALUES ($1, 'daily_disclosure', $2, $3) RETURNING id`,
        [twin.twinId, Buffer.from(twin.dek.encrypt(Buffer.from(frozen, "utf8"))), older],
      );
      const post = await client.query<{ id: string }>(
        `INSERT INTO disclosure_posts (twin_id, disclosure_day, notice_id)
         VALUES ($1, '2026-08-24', $2) RETURNING id`,
        [twin.twinId, notice.rows[0]!.id],
      );
      await client.query(
        `INSERT INTO disclosure_post_lines (twin_id, post_id, line_index, disclosure_line_id)
         VALUES ($1, $2, 1, $3)`,
        [twin.twinId, post.rows[0]!.id, line.rows[0]!.id],
      );
      await client.query("COMMIT");

      await client.query(reexpressionSql());
      const feed = await feedOf(client, twin);
      const older_ = feed.find((entry) => entry.origin === "reexpressed");
      expect(older_).toBeDefined();
      // THE REFERENCE, AND THE SEALED NUMBERING BEHIND IT — never the frozen
      // text, which carries the same claims and a thread instruction.
      expect(older_!.parts.map((part) => part.kind)).toEqual(["record-lines"]);
      const lines = older_!.parts[0]!;
      if (lines.kind !== "record-lines") throw new Error("unreachable");
      expect(lines.disclosurePostId).toBe(post.rows[0]!.id);
      expect(lines.acts).toEqual(["retract"]);
      expect(lines.lines).toHaveLength(1);
      expect(lines.lines[0]!.disclosureLineId).toBe(line.rows[0]!.id);
      expect(lines.lines[0]!.index).toBe(1);
      // NOTHING RECORDED THE HEADING THEN, and the entity is there regardless.
      expect(lines.lines[0]!.counterparty).toBeUndefined();
      expect(lines.lines[0]!.entityId).toMatch(/^[0-9a-f-]{36}$/u);
      // ...and the day this build composed keeps its own three parts.
      const composed = feed.find((entry) => entry.origin === "composed" &&
        entry.parts.some((part) => part.kind === "record-lines"));
      expect(composed!.parts.map((part) => part.kind)).toEqual([
        "prose",
        "record-lines",
        "prose",
      ]);
      twin.bundle.close();
    });
  });

  it("sweeps a post the upgrade window left behind, at startup, once (Codex r1)", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const eventId = await customerWrites(client, twin, { tag: "GAP" });
      // THE OLD RUNTIME, STILL POLLING between the migration and the restart:
      // it writes a notice and its `system_send` and knows nothing about
      // posts. Every invariant stays green and the post is invisible.
      const stray = await plantNotice(client, twin, {
        kind: "dismissal_ack",
        text: "✳️ Descartado",
        aboutEventId: eventId,
        at: new Date("2026-08-31T10:00:00.000Z"),
      });
      expect(await feedOf(client, twin)).toEqual([]);

      // The new runtime comes up.
      expect(
        await reexpressStrayPosts({ db: client, twinId: twin.twinId }),
      ).toBeGreaterThanOrEqual(1);
      const [swept] = await feedOf(client, twin);
      expect(swept!.origin).toBe("reexpressed");
      expect(swept!.parts).toEqual([
        { kind: "receipt", text: "Descartado", acts: [] },
      ]);
      expect(swept!.at.getTime()).toBe(
        new Date("2026-08-31T10:00:00.000Z").getTime(),
      );

      // ...AND A SECOND START WRITES NOTHING, for this twin or any other: the
      // delivery row's unique constraint is the guarantee.
      expect(
        await reexpressStrayPosts({ db: client, twinId: twin.twinId }),
      ).toBe(0);
      expect(
        (
          await client.query<{ n: string }>(
            "SELECT count(*) AS n FROM posts WHERE notice_id = $1",
            [stray],
          )
        ).rows[0]!.n,
      ).toBe("1");
      twin.bundle.close();
    });
  });

  it("leaves a post this build composed alone — it does not re-express its own", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await customerWrites(client, twin, { tag: "OWN" });
      await processPendingWaEvents(depsFor(client, twin, draftingTurns()));
      // Two: the Borrador and the ceremony that rides it.
      const before = await feedOf(client, twin);
      expect(before.map((post) => post.origin)).toEqual([
        "composed",
        "composed",
      ]);

      expect(
        await reexpressStrayPosts({ db: client, twinId: twin.twinId }),
      ).toBe(0);
      expect(await feedOf(client, twin)).toEqual(before);
      twin.bundle.close();
    });
  });

  it("derives a draft part from a draft that predates parts, body and all", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const draft = await client.query<{ id: string }>(
        `INSERT INTO drafts (twin_id, destination, content_enc, post_enc)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [
          twin.twinId,
          CUSTOMER,
          Buffer.from(twin.dek.encrypt(Buffer.from(DRAFT_TEXT, "utf8"))),
          Buffer.from(
            twin.dek.encrypt(Buffer.from("✳️ *Borrador — para X*", "utf8")),
          ),
        ],
      );
      await client.query(reexpressionSql());

      const [only] = await feedOf(client, twin);
      expect(only!.parts).toHaveLength(1);
      const part = only!.parts[0]!;
      if (part.kind !== "draft") throw new Error("unreachable");
      expect(part.draftId).toBe(draft.rows[0]!.id);
      expect(part.body).toBe(DRAFT_TEXT);
      expect(part.acts).toEqual(["tap", "dismiss"]);
      // THE NAME IS THE NAMING RULE'S, read now (ticket #298): nobody has
      // confirmed this chat, so the number wears the frame's own mark.
      expect(part.counterparty).toBe("5215550001 (sin confirmar)");
      twin.bundle.close();
    });
  });

  it("names a draft that predates parts by the binding the mirror holds now, unmarked (ticket #298)", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await client.query(
        `INSERT INTO drafts (twin_id, destination, content_enc, post_enc)
         VALUES ($1, $2, $3, $4)`,
        [
          twin.twinId,
          CUSTOMER,
          Buffer.from(twin.dek.encrypt(Buffer.from(DRAFT_TEXT, "utf8"))),
          Buffer.from(
            twin.dek.encrypt(Buffer.from("✳️ *Borrador — para X*", "utf8")),
          ),
        ],
      );
      await client.query(reexpressionSql());
      twin.bundle.confirmChatBinding({
        chatJid: CUSTOMER,
        entityId: randomUUID(),
        displayName: PUSH_NAME,
        confirmedAt: EVENING.toISOString(),
      });

      const [only] = await feedOf(client, twin);
      const part = only!.parts[0]!;
      if (part.kind !== "draft") throw new Error("unreachable");
      expect(part.counterparty).toBe(PUSH_NAME);
      twin.bundle.close();
    });
  });

  it("leaves the name a composed post recorded as it was, whatever the mirror says now (ticket #298)", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await customerWrites(client, twin);
      await processPendingWaEvents(depsFor(client, twin, draftingTurns()));
      twin.bundle.confirmChatBinding({
        chatJid: CUSTOMER,
        entityId: randomUUID(),
        displayName: "Ferretería Garza",
        confirmedAt: EVENING.toISOString(),
      });

      const [part] = (await feedOf(client, twin)).flatMap((post) =>
        post.parts.filter((candidate) => candidate.kind === "draft"),
      );
      if (part?.kind !== "draft") throw new Error("unreachable");
      expect(part.counterparty).toBe(`${PUSH_NAME} (sin confirmar)`);
      twin.bundle.close();
    });
  });
});
