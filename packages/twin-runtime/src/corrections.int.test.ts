/**
 * Corrections and finalization (ticket #54; spec #48 grilling decisions 14
 * and 15; ADR-0003 as amended, ADR-0004, ADR-0016, ADR-0020, ADR-0026,
 * ADR-0034; FR-33, FR-35).
 *
 * Being wrong stays fixable, and a fact nobody corrects goes final on its
 * own — 24 hours after the rep could actually have READ the statement
 * disclosing it, never 24 hours after it was filed.
 *
 * Driven end to end at the primary Postgres seam, the same one slices 1 and
 * 2 use and the same one #51 and #52 drive: put the day's `wa_events` in,
 * extract, disclose, let the executor post, then inject the rep's own
 * correction and run the consumer. Real Postgres, real envelope crypto,
 * real SQLCipher (ADR-0028).
 *
 * THE CORRECTION IS PROSE AND A TOOL SINCE #174, and the claim this file
 * makes is now sharper rather than weaker. «N no» was a keyword the matcher
 * read, and the rep had to know it; «el 3 está mal» is what they would
 * actually type, and the thread execution reads it. What did NOT move is the
 * part ADR-0003 is about: the model names an INTENT and a number, and code
 * does everything else — it resolves the quoted post through the executor's
 * own record, the number against the numbering stored when the post was
 * rendered, and the rep's evidence against this execution's trigger and the
 * seam row behind it. A model that submitted «lo corregí» and called no tool
 * retracts nothing (proven at the end of this file).
 *
 * SO THE MODEL IS SCRIPTED, AND ONLY TO CALL THE TOOL. Every case below
 * scripts exactly one tool call with this turn's evidence; the walk, the
 * refusals, the window and the chain are all still decided in code, and a
 * script that omits the call is a case where nothing happens.
 *
 * `now` IS ALWAYS EXPLICIT — the `reconcileFr70At` shape. No clock seam, no
 * fake timers, no ambient time: every instant in this file is a literal.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  auditChainCoverageInDb,
  CORRECTION_WINDOW_HOURS,
  fileEntityCreate,
  finalizeDueFacts,
  readFiledFacts,
  type FiledFact,
  retractDisclosedFact,
  UnknownDisclosureLineError,
} from "@dito/aperture";
import { verifyAuditChainInDb } from "@dito/audit";
import { createBundle, type Bundle } from "@dito/bundle";
import { createDekFromMaterial, type Dek } from "@dito/crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bindingQuestionAsked } from "./answering.js";
import { processPendingWaEvents, type TwinRuntimeDeps } from "./consumer.js";
import { withDbTransaction } from "./db-tx.js";
import { runDailyDisclosure, runDailyExtraction } from "./testing/by-hand.js";
import { RECEIPTS } from "./grammar.js";
import { composeBindingQuestionPost } from "./posts.js";
import { insertNoticeWithSystemSend } from "./notices.js";
import { runTwinRuntime } from "./runtime.js";
import { createSendLockWriter } from "./send-lock/writer.js";
import {
  resetAndMigrate,
  withClient,
  TEST_AUDIT_HMAC_KEY,
  TEST_DATABASE_URL,
} from "./testing/db.js";
import { disclosedFact } from "./testing/disclosed-fact.js";
import { seatAtTheDoor, typeAtTheDoor } from "./testing/door.js";
import { removeTmpDir } from "./testing/tmp.js";
import { fakeEmbedder } from "./testing/fake-embedder.js";
import { insertWaEvent, simulateExecutorPost } from "./testing/seam-fixtures.js";
import {
  closeScriptedModels,
  extractionTurns,
  qaSilenceTurns,
  scriptedModel,
  type Script,
  type ScriptedTurn,
} from "./testing/scripted-model.js";
import { composedDisclosure } from "./testing/disclosure-script.js";
import { isThreadTurn, threadTurns } from "./testing/thread-script.js";
import { RETRACT_DISCLOSURE_LINE_TOOL } from "./thread/acts.js";
import { SETTLE_IMMEDIATELY } from "./testing/settle.js";
import { newExecutionPool } from "./testing/execution-pool.js";

// Every scripted model this suite opened is closed with it (#328).
afterAll(closeScriptedModels);

/** One connection source for every execution this suite runs (ticket #173). */
const executionPool = newExecutionPool();

const SELF_CHAT = "5215550000@s.whatsapp.net";
const ZONE = "America/Monterrey";

/** The rep's day under test: 2026-08-29 in America/Monterrey (UTC-6). */
const YESTERDAY = new Date("2026-08-28T20:00:00Z");
const MORNING = new Date("2026-08-29T15:20:00Z");
/** 21:30 on the rep's clock, still the 29th — when the day's passes run. */
const EVENING = new Date("2026-08-30T03:30:00Z");
/** When the executor actually posted the disclosure: 21:31 the rep's time. */
const POSTED_AT = new Date("2026-08-30T03:31:00Z");
/** The instant the correction window closes: POSTED_AT + 24h, exactly. */
const WINDOW_CLOSES = new Date(
  POSTED_AT.getTime() + CORRECTION_WINDOW_HOURS * 3_600_000,
);

/**
 * Chat JIDs are unique per twin: the seam composes `external_event_id` as
 * `<chat jid>:<message id>` GLOBALLY (ADR-0005), so two suites reusing one
 * pair collide.
 */
let chatCounter = 0;
let tmp: string;
let pool: pg.Pool;

beforeAll(async () => {
  await resetAndMigrate();
  tmp = mkdtempSync(join(tmpdir(), "dito-corrections-int-"));
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
  readonly chat: string;
}

function freshTwin(): Twin {
  const twinId = randomUUID();
  const dek = createDekFromMaterial(randomBytes(32));
  chatCounter += 1;
  return {
    twinId,
    companyId: randomUUID(),
    seatId: randomUUID(),
    dek,
    bundle: createBundle(join(tmp, `${twinId}.bundle`), dek),
    chat: `52155${String(400000 + chatCounter)}@s.whatsapp.net`,
  };
}

/**
 * The runtime's deps. `turns` is empty by default, so any model call in a
 * pass that did not script one throws — which is how "no model is in the
 * path" is asserted rather than asserted about.
 */
function depsFor(
  client: pg.Client,
  twin: Twin,
  /**
   * What the model answers. THE DEFAULT IS THE EVENING'S OWN SUBMISSION
   * (ticket #198): the daily disclosure is an automation, so a call that
   * posts a day scripts what the twin composed around its lines, and this
   * suite's claims are about what the day DID rather than about the prose
   * (`testing/disclosure-script.ts`).
   */
  turns: Script = composedDisclosure,
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
    timeZone: ZONE,
  };
}

/** Puts a chat in scope, the way the plane's capture guard reads it. */
async function inScope(
  client: pg.Client,
  twin: Twin,
  chatJid: string,
): Promise<void> {
  await client.query(
    "INSERT INTO scope_allowlist (twin_id, chat_jid) VALUES ($1, $2)",
    [twin.twinId, chatJid],
  );
}

/**
 * A rep-confirmed binding, exactly as slice 2 produces one: the twin asked,
 * the rep said «si», the mirror holds it and the aperture filed the entity
 * create with its disclosure line.
 *
 * The question is part of the fixture rather than skipped — the ADR-0033
 * invariant derives each twin's own thread from its `system_send` commands,
 * and a twin that never posted has no thread to exclude.
 */
async function bindChat(
  client: pg.Client,
  twin: Twin,
  displayName: string,
): Promise<string> {
  const entityId = randomUUID();
  const short = entityId.slice(0, 8);
  const proposalEventId = await insertWaEvent(client, twin.dek, {
    twinId: twin.twinId,
    companyId: twin.companyId,
    seatId: twin.seatId,
    chatJid: twin.chat,
    senderJid: twin.chat,
    fromMe: false,
    messageId: `WAMID-ASK-${short}`,
    text: "buenas",
    pushName: displayName,
    occurredAt: YESTERDAY,
  });
  await withDbTransaction(client, async () => {
    if (
      !(await bindingQuestionAsked(
        { db: client, dek: twin.dek, twinId: twin.twinId },
        twin.chat,
      ))
    ) {
      await insertNoticeWithSystemSend(client, {
        twinId: twin.twinId,
        selfChatJid: SELF_CHAT,
        dek: twin.dek,
        kind: "binding_question",
        aboutEventId: proposalEventId,
        post: composeBindingQuestionPost({
          aboutEventId: proposalEventId,
          proposedName: displayName,
        }),
      });
    }
  });

  const messageId = `WAMID-SI-${short}`;
  const sourceEventId = await insertWaEvent(client, twin.dek, {
    twinId: twin.twinId,
    companyId: twin.companyId,
    seatId: twin.seatId,
    chatJid: SELF_CHAT,
    senderJid: SELF_CHAT,
    fromMe: true,
    messageId,
    text: "si",
    quotedMessageId: `WAMID-QUESTION-${short}`,
    occurredAt: MORNING,
  });
  twin.bundle.confirmChatBinding({
    chatJid: twin.chat,
    entityId,
    displayName,
    confirmedAt: MORNING.toISOString(),
  });
  await fileEntityCreate(
    { db: client, dek: twin.dek, hmacKey: TEST_AUDIT_HMAC_KEY },
    {
      twinId: twin.twinId,
      entityId,
      kind: "person",
      displayName,
      evidence: { surface: "twin_thread", sourceEventId, waMessageId: messageId },
      disclosureText: "Lo di de alta como cliente.",
    },
  );
  return entityId;
}

/**
 * One scripted extraction submission — the shared wire (ticket #194).
 *
 * IT MOVED TO `@dito/scripted-model`, where the four suites that script this
 * tool now read one copy: the turn COUNT changed with the automation's
 * eight-round budget, and four hand-copies of a shape that changes is the
 * drift that package exists to prevent.
 */
const extracted = extractionTurns;

interface DisclosedDay {
  readonly entityId: string;
  /** The notice carrying the day's grouped post. */
  readonly noticeId: string;
  /** The WhatsApp message id the executor posted it under. */
  readonly waMessageId: string;
  /**
   * The FACT lines, with the number the rep read beside each — which is
   * NOT 1, and that is the real shape rather than a fixture quirk: a day
   * that binds a chat and then extracts from it discloses the entity create
   * first (it was filed first), so line 1 is «Lo di de alta como cliente.»
   * and the facts are 2 and 3. It is the first thing every rep sees.
   */
  readonly factLines: readonly { readonly index: number; readonly factId: string }[];
  /** The entity create's own number — the line no verb can correct yet. */
  readonly entityCreateIndex: number;
}

/**
 * A whole day, end to end: a bound chat, two customer messages, extraction,
 * the daily disclosure, and the executor posting it at `postedAt`.
 *
 * `postedAt` is what starts the correction window (ADR-0004), so it is a
 * parameter rather than "whenever the fixture ran".
 */
async function aDisclosedDay(
  client: pg.Client,
  twin: Twin,
  options: { postedAt?: Date | null } = {},
): Promise<DisclosedDay> {
  await inScope(client, twin, twin.chat);
  const entityId = await bindChat(client, twin, "Diego Zertuche");
  // BOTH HALVES OF THE EXCHANGE (ticket #71). The customer asks and the
  // rep answers, and the two facts this day discloses are the REP's —
  // «Le cotizaste …» and «Le confirmaste …» — so each is read in the
  // rep's own message. The aperture refuses a rep act read in a
  // counterparty's message, which is what makes the fixture's shape part
  // of the claim rather than scenery.
  for (const [n, fromMe, text] of [
    [1, false, "¿me cotizas 100 cajas?"],
    [2, false, "¿me las entregas el sábado?"],
    [3, true, "las 100 cajas le salen en 4,500"],
    [4, true, "se las entrego el sábado"],
  ] as const) {
    await insertWaEvent(client, twin.dek, {
      twinId: twin.twinId,
      companyId: twin.companyId,
      seatId: twin.seatId,
      chatJid: twin.chat,
      senderJid: fromMe ? SELF_CHAT : twin.chat,
      fromMe,
      messageId: `WAMID-MSG-${twin.twinId.slice(0, 8)}-${n}`,
      text,
      occurredAt: MORNING,
    });
  }

  // Consume the day first, the way the runtime does — the correction pass
  // later must find nothing but the rep's own reply pending, or it would be
  // classifying yesterday's customer traffic at the same time. Nothing
  // needs an answer: this suite is about the correction, not about drafting.
  // A RULE, NOT A FLAT LIST (ticket #174). Two executions are pending here
  // and they are different shapes: the day's customer traffic needs a
  // drafting decision, and `bindChat`'s «si» — which quotes a post this
  // fixture never had the executor record — now reaches the THREAD
  // execution, because every rep message in the thread has a path. Keyed by
  // the prompt, so neither is served the other's turns.
  await processPendingWaEvents(
    depsFor(client, twin, (prompt) =>
      isThreadTurn(prompt) ? qaSilenceTurns() : noAnswerNeeded(),
    ),
  );

  const extraction = await runDailyExtraction(
    depsFor(
      client,
      twin,
      extracted(
        {
          fact_type: "QuoteGiven",
          message_id: `WAMID-MSG-${twin.twinId.slice(0, 8)}-3`,
          confidence: 0.93,
          item: "cajas",
          quantity: 100,
          amount: 4500,
          currency: "MXN",
        },
        {
          fact_type: "DatePromised",
          message_id: `WAMID-MSG-${twin.twinId.slice(0, 8)}-4`,
          confidence: 0.91,
          commitment: "entregar el sábado",
        },
      ),
    ),
    EVENING,
  );
  expect(extraction.filed).toBe(2);

  // THE POST EVERY CASE IN THIS FILE CORRECTS IS A COMPOSED ONE (ticket
  // #198): the twin's own opening and closing around the lines the aperture
  // stored, and the numbering recorded when code rendered them. That
  // numbering is what «el 3 está mal» resolves through, and it is the whole
  // reason this suite's greens are the proof that composing the speech
  // changed nothing about correcting a line.
  const posted = await runDailyDisclosure(depsFor(client, twin), EVENING);
  expect(posted.posted).toBe(true);

  const post = await client.query<{ id: string; command_id: string }>(
    `SELECT n.id, sc.id AS command_id
       FROM notices n
       JOIN send_commands sc ON sc.payload_ref = 'notice:' || n.id
      WHERE n.twin_id = $1 AND n.kind = 'daily_disclosure'`,
    [twin.twinId],
  );
  const noticeId = post.rows[0]!.id;
  const waMessageId = `WAMID-DISCLOSURE-${twin.twinId.slice(0, 8)}`;
  if (options.postedAt !== null) {
    // The stamp is chosen, because it is the whole subject: the correction
    // window starts at rep-reachability, which is exactly this instant.
    await simulateExecutorPost(client, {
      commandId: post.rows[0]!.command_id,
      twinId: twin.twinId,
      waMessageId,
      executedAt: options.postedAt ?? POSTED_AT,
    });
  }

  const lines = await client.query<{
    line_index: number;
    subject_kind: string;
    fact_id: string | null;
  }>(
    `SELECT pl.line_index, dl.subject_kind, dl.fact_id
       FROM disclosure_post_lines pl
       JOIN disclosure_posts p ON p.id = pl.post_id
       JOIN disclosure_lines dl ON dl.id = pl.disclosure_line_id
      WHERE p.notice_id = $1
      ORDER BY pl.line_index`,
    [noticeId],
  );
  const entityCreate = lines.rows.find(
    (r) => r.subject_kind === "entity_create",
  );
  expect(entityCreate).toBeDefined();
  return {
    entityId,
    noticeId,
    waMessageId,
    factLines: lines.rows
      .filter((r) => r.fact_id !== null)
      .map((r) => ({ index: r.line_index, factId: r.fact_id! })),
    entityCreateIndex: entityCreate!.line_index,
  };
}

/** Every fact that crossed on this day, in the order the post numbered them. */
function factIdsOf(day: DisclosedDay): string[] {
  return day.factLines.map((line) => line.factId);
}

/** The first fact line of the post — the one the corrections below name. */
function firstFact(day: DisclosedDay): { index: number; factId: string } {
  return day.factLines[0]!;
}

/** Polls until `ready`, or fails loudly rather than hanging the suite. */
async function waitFor(ready: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await ready()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("the runtime loop did not reach the expected state in 10s");
}

/**
 * The reply the rep types to correct one numbered line.
 *
 * PROSE SINCE #174, and the number is the rep's own word for which line —
 * the one thing about a correction that has to come from them, because a
 * post carries many lines and quoting it names the post. Everything else is
 * code's: the walk, the window, the evidence.
 */
function correctionFor(line: { index: number }): string {
  return `el ${line.index} está mal`;
}

/**
 * The turn a correction runs: one tool call citing this event as the rep's
 * own message, and a silence.
 *
 * SILENT ON PURPOSE — the twin has nothing to say beyond what it did, so the
 * receipt posts alone under `correction_ack`, which is exactly the post the
 * keyword's ack made and exactly the bytes it made it with.
 */
function correctionTurns(eventId: string, line: number): ScriptedTurn[] {
  return threadTurns({
    tool: RETRACT_DISCLOSURE_LINE_TOOL,
    evidence: eventId,
    input: { line },
  });
}

/** One scripted "this needs no answer" drafting decision. */
function noAnswerNeeded(): ScriptedTurn[] {
  return [
    { text: "" },
  ];
}

/** The rep's own reply in their own thread, quoting a twin post. */
async function repReply(
  client: pg.Client,
  twin: Twin,
  args: { text: string; quoting: string; tag: string; at?: Date },
): Promise<string> {
  return insertWaEvent(client, twin.dek, {
    twinId: twin.twinId,
    companyId: twin.companyId,
    seatId: twin.seatId,
    chatJid: SELF_CHAT,
    senderJid: SELF_CHAT,
    fromMe: true,
    messageId: `WAMID-REP-${twin.twinId.slice(0, 8)}-${args.tag}`,
    text: args.text,
    quotedMessageId: args.quoting,
    occurredAt: args.at ?? new Date("2026-08-30T04:00:00Z"),
  });
}

/** What the twin posted back, newest last. */
async function twinPosts(
  client: pg.Client,
  twin: Twin,
  kind: string,
): Promise<string[]> {
  const res = await client.query<{ content_enc: Buffer }>(
    `SELECT n.content_enc
       FROM notices n
       JOIN send_commands sc ON sc.payload_ref = 'notice:' || n.id
      WHERE n.twin_id = $1 AND n.kind = $2
      ORDER BY sc.created_at, sc.id`,
    [twin.twinId, kind],
  );
  return res.rows.map((row) =>
    Buffer.from(twin.dek.decrypt(row.content_enc)).toString("utf8"),
  );
}

/**
 * One filed fact, read through THE WRITER'S OWN SURFACE and never off the
 * Ledger's fact table (ADR-0016; `sole-writer.test.ts` scans for that, and
 * scans comments too — which is why this one names it in prose).
 *
 * The scan caught the first draft of this helper doing exactly that. It
 * matters here more than anywhere: every fact this slice files is shadow,
 * so the finalized view is correctly empty and cannot answer "what happened
 * to this row?" — and a test that reached past the view for the answer is
 * the direct-table reader ADR-0016 exists to keep out of the tree.
 */
async function readFact(
  client: pg.Client,
  twin: Twin,
  factId: string,
): Promise<FiledFact> {
  const filed = await readFiledFacts({ db: client, dek: twin.dek }, twin.twinId);
  const fact = filed.find((f) => f.id === factId);
  expect(fact, `fact ${factId} is not filed for twin ${twin.twinId}`).toBeDefined();
  return fact!;
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

// ---------------------------------------------------------------------
// AC 1 & 2 — the correction resolves in code and annotates
// ---------------------------------------------------------------------

describe("a correction in prose retracts the line it names, resolved in code (AC 1; spec #48 decision 14; #174)", () => {
  it("walks quoted id → post → index → line → fact with NO model in the path, annotates the fact, and acks", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const day = await aDisclosedDay(client, twin);
      const [quoteFact, dateFact] = factIdsOf(day);

      const correction = await repReply(client, twin, {
        text: correctionFor(firstFact(day)),
        quoting: day.waMessageId,
        tag: "C1",
      });
      // THE MODEL NAMES THE INTENT AND THE NUMBER, AND NOTHING ELSE
      // (ADR-0003 as amended). Every other step is code's — the quoted post
      // through the executor's own record, the number through the stored
      // numbering, the evidence against this execution's trigger — which is
      // what "a model may read intent but can never manufacture a rep act"
      // means once the verb is prose.
      await processPendingWaEvents(
        depsFor(client, twin, correctionTurns(correction, firstFact(day).index)),
      );

      // The fact is annotated, not erased, and it is the fact line 1
      // disclosed — the OTHER fact is untouched, which is what "resolves to
      // exactly one line" means.
      const retracted = await readFact(client, twin, quoteFact!);
      expect(retracted.retractedAt).not.toBeNull();
      expect(retracted.finalizedAt).toBeNull();
      expect((await readFact(client, twin, dateFact!)).retractedAt).toBeNull();

      // Valid time is when the REP said it, off the verified act — never
      // the pass's own clock.
      expect(retracted.retractedAt!.toISOString()).toBe(
        "2026-08-30T04:00:00.000Z",
      );

      // Evidence-bound (ADR-0003 class 2): the rep act is named, and it is
      // the raw plane-delivered event this reply arrived on.
      const evidence = await client.query<{
        source_event_id: string;
        twin_id: string;
        company_id: string;
      }>(
        `SELECT source_event_id, twin_id, company_id
           FROM fact_retractions WHERE fact_id = $1`,
        [quoteFact],
      );
      expect(evidence.rows).toHaveLength(1);
      expect(evidence.rows[0]!.source_event_id).toBe(correction);
      expect(evidence.rows[0]!.twin_id).toBe(twin.twinId);
      expect(evidence.rows[0]!.company_id).toBe(twin.companyId);

      // Audit-chained (ADR-0020, spec #48 decision 18) — and so is the
      // entity create it sits beside, which is the crossing #50 filed
      // unchained and #51 sized closing.
      const chain = await client.query<{
        caller: string;
        action: string;
        ref: string;
        outcome: string;
      }>(
        `SELECT caller, action, ref, outcome FROM audit_chain
          WHERE ref LIKE 'twin:' || $1 || '%' ORDER BY id`,
        [twin.twinId],
      );
      expect(chain.rows.map((r) => `${r.caller}:${r.action}:${r.outcome}`)).toEqual([
        "aperture:entity_create:filed",
        "aperture:fact_retraction:retracted",
      ]);
      expect(chain.rows[1]!.ref).toBe(
        `twin:${twin.twinId} fact:${quoteFact} line:${(
          await client.query<{ id: string }>(
            "SELECT id FROM disclosure_lines WHERE fact_id = $1",
            [quoteFact],
          )
        ).rows[0]!.id} event:${correction}`,
      );
      expect(
        await verifyAuditChainInDb(client, TEST_AUDIT_HMAC_KEY),
      ).toMatchObject({ valid: true });

      // The rep is told, naming the number back so they can see the twin
      // understood which line they meant.
      expect(await twinPosts(client, twin, "correction_ack")).toEqual([
        `✳️ Listo, marqué el dato ${firstFact(day).index} como incorrecto.`,
      ]);
      expect(await dispositionOf(client, correction)).toBe("retracted");
      twin.bundle.close();
    });
  });

  it("refuses a line the rep did not name, when they named one (#174, Codex r2)", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const day = await aDisclosedDay(client, twin);
      const [first, second] = day.factLines;
      expect(second).toBeDefined();

      // ADR-0003 AS AMENDED NAMES THE LINE AS PART OF THE TARGET — "the
      // quoted twin post, and the line within it, resolved by deterministic
      // join" — while permitting the model to read INTENT. Where the rep
      // wrote a number this post really printed, the join exists and it
      // wins: a call naming a DIFFERENT line is refused, which closes
      // «the rep said 2 and the model called 3», misread or injected.
      const correction = await repReply(client, twin, {
        text: `el ${first!.index} está mal`,
        quoting: day.waMessageId,
        tag: "CWRONG",
      });
      await processPendingWaEvents(
        depsFor(client, twin, correctionTurns(correction, second!.index)),
      );

      // NEITHER line moved: not the one the model named, and not the one
      // the rep named either — the tool refused rather than guessing.
      for (const factId of factIdsOf(day)) {
        expect((await readFact(client, twin, factId)).retractedAt).toBeNull();
      }
      expect(await twinPosts(client, twin, "correction_ack")).toEqual([]);
      twin.bundle.close();
    });
  });

  it("lets the model read the line when the rep named no number at all (#174)", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const day = await aDisclosedDay(client, twin);

      // SPEC #171'S OWN EXAMPLE, and the reason the rule above is a
      // refinement rather than a replacement: «no fueron 50, fueron 15»
      // carries two numbers and neither is a line index, so there is no
      // deterministic answer to be had and the model's reading stands —
      // held by the three things that hold it anyway (it can only pick a
      // line the rep was SHOWN, the fact is annotated rather than deleted,
      // and the receipt names the number back).
      const correction = await repReply(client, twin, {
        text: "no fueron 50, fueron 15",
        quoting: day.waMessageId,
        tag: "CPROSE",
      });
      await processPendingWaEvents(
        depsFor(client, twin, correctionTurns(correction, firstFact(day).index)),
      );

      expect(
        (await readFact(client, twin, firstFact(day).factId)).retractedAt,
      ).not.toBeNull();
      expect(await dispositionOf(client, correction)).toBe("retracted");
      twin.bundle.close();
    });
  });

  it("still works for a rep who learned «N no» — the retired verb is prose the twin reads (#174)", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const day = await aDisclosedDay(client, twin);

      // THE ONE MIGRATION QUESTION THIS TICKET OWES THE REP. «3 no» was the
      // taught phrase for two slices; it is not a keyword any more, and the
      // rep who learned it must not type it and watch nothing happen. It
      // reaches the execution like any other sentence, and the tool reads
      // the number out of it exactly as the verb did.
      const correction = await repReply(client, twin, {
        text: `${firstFact(day).index} no`,
        quoting: day.waMessageId,
        tag: "COLD",
      });
      await processPendingWaEvents(
        depsFor(client, twin, correctionTurns(correction, firstFact(day).index)),
      );

      expect(
        (await readFact(client, twin, firstFact(day).factId)).retractedAt,
      ).not.toBeNull();
      expect(await dispositionOf(client, correction)).toBe("retracted");
      expect(await twinPosts(client, twin, "correction_ack")).toEqual([
        `✳️ Listo, marqué el dato ${firstFact(day).index} como incorrecto.`,
      ]);
      // ...and the execution's own record says `acted`, from the tool's
      // result rather than from anything the model wrote.
      const execution = await client.query<{ disposition: string }>(
        `SELECT disposition FROM executions
          WHERE twin_id = $1 AND trigger_kind = 'twin_thread_message'
          ORDER BY started_at DESC LIMIT 1`,
        [twin.twinId],
      );
      expect(execution.rows[0]?.disposition).toBe("acted");
      twin.bundle.close();
    });
  });

  it("retracts NOTHING when the prose claims it and no tool was called (#174)", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const day = await aDisclosedDay(client, twin);

      // The model says the line is marked and calls nothing. A twin that
      // composed its own acknowledgement would have told the rep the record
      // was fixed; a receipt rendered from a tool's result cannot.
      //
      // A PARAPHRASE, because the exact sentence is refused outright — a
      // receipt is code's and prose may not wear it (`guard.ts`, and the
      // seam case in `thread-acts.int.test.ts`). This is the wider claim
      // underneath that one: whatever the twin SAYS, nothing is retracted
      // unless the tool ran.
      const claim = await repReply(client, twin, {
        text: correctionFor(firstFact(day)),
        quoting: day.waMessageId,
        tag: "CLAIM",
      });
      await processPendingWaEvents(
        depsFor(client, twin, [
          // The search is the model's own doing and is what makes a reply
          // with no sources legal here: nothing was ACTED, so the reply
          // rests on the rep's history like any other answer (`guard.ts`).
          {
            toolCall: {
              name: "search_memory",
              input: { about: "el dato", counterparty: null },
            },
          },
          { text: "Ya quedó, ese dato lo di por malo." },
        ]),
      );

      for (const factId of factIdsOf(day)) {
        expect((await readFact(client, twin, factId)).retractedAt).toBeNull();
      }
      expect(await twinPosts(client, twin, "correction_ack")).toEqual([]);
      expect(await dispositionOf(client, claim)).toBe("answered");
      // Nothing chained either: no act was attempted, so there is none to
      // record refused.
      const chain = await client.query(
        `SELECT 1 FROM audit_chain
          WHERE action = 'fact_retraction' AND ref LIKE 'twin:' || $1 || '%'`,
        [twin.twinId],
      );
      expect(chain.rows).toEqual([]);
      twin.bundle.close();
    });
  });

  it("leaves the disclosure line and the fact row exactly where they were — the record shows what happened (FR-33)", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const day = await aDisclosedDay(client, twin);
      const before = await client.query(
        "SELECT id, rendered_text, subject_kind, fact_id FROM disclosure_lines WHERE twin_id = $1 ORDER BY id",
        [twin.twinId],
      );

      const acted = await repReply(client, twin, {
        text: correctionFor(firstFact(day)),
        quoting: day.waMessageId,
        tag: "C2",
      });
      await processPendingWaEvents(
        depsFor(client, twin, correctionTurns(acted, firstFact(day).index)),
      );

      // The line the rep was shown is untouched: a correction annotates the
      // FACT, it never rewrites what the rep was told (the store refuses
      // the UPDATE outright).
      const after = await client.query(
        "SELECT id, rendered_text, subject_kind, fact_id FROM disclosure_lines WHERE twin_id = $1 ORDER BY id",
        [twin.twinId],
      );
      expect(after.rows).toEqual(before.rows);

      // And the fact is still in the timeline — retracted, not gone.
      const timeline = await readFiledFacts(
        { db: client, dek: twin.dek },
        twin.twinId,
      );
      expect(timeline).toHaveLength(2);
      expect(timeline.filter((f) => f.retractedAt !== null)).toHaveLength(1);
      twin.bundle.close();
    });
  });

  it("is terminal and idempotent: a repeat correction keeps the first one's instant and acks again", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const day = await aDisclosedDay(client, twin);
      const acted = await repReply(client, twin, {
        text: correctionFor(firstFact(day)),
        quoting: day.waMessageId,
        tag: "C3a",
      });
      await processPendingWaEvents(
        depsFor(client, twin, correctionTurns(acted, firstFact(day).index)),
      );
      const first = await readFact(client, twin, firstFact(day).factId);

      const second = await repReply(client, twin, {
        text: correctionFor(firstFact(day)),
        quoting: day.waMessageId,
        tag: "C3b",
        at: new Date("2026-08-30T05:00:00Z"),
      });
      await processPendingWaEvents(
        depsFor(client, twin, correctionTurns(second, firstFact(day).index)),
      );

      expect((await readFact(client, twin, firstFact(day).factId)).retractedAt).toEqual(
        first.retractedAt,
      );
      // One evidence row, the first one: a correction is terminal.
      const evidence = await client.query(
        "SELECT source_event_id FROM fact_retractions WHERE fact_id = $1",
        [firstFact(day).factId],
      );
      expect(evidence.rows).toHaveLength(1);
      expect(await dispositionOf(client, second)).toBe("retracted");
      expect(await twinPosts(client, twin, "correction_ack")).toHaveLength(2);
      // Both acts are on the chain, told apart by their outcome.
      const chain = await client.query<{ outcome: string }>(
        `SELECT outcome FROM audit_chain
          WHERE action = 'fact_retraction' AND ref LIKE 'twin:' || $1 || '%'
          ORDER BY id`,
        [twin.twinId],
      );
      expect(chain.rows.map((r) => r.outcome)).toEqual([
        "retracted",
        "already_retracted",
      ]);
      twin.bundle.close();
    });
  });

  it("never crosses twins: one rep's correction cannot reach another rep's post", async () => {
    await withClient(async (client) => {
      const a = freshTwin();
      const b = freshTwin();
      const dayA = await aDisclosedDay(client, a);
      await aDisclosedDay(client, b);

      // B quotes A's posted message id. The registry's join is twin-scoped,
      // so for B that id names nothing the twin posted at all — and B's own
      // execution is therefore shown NO quoted post, whatever its model
      // then asks the tool to do.
      const attempt = await repReply(client, b, {
        text: correctionFor(firstFact(dayA)),
        quoting: dayA.waMessageId,
        tag: "CX",
      });
      await processPendingWaEvents(
        depsFor(client, b, correctionTurns(attempt, firstFact(dayA).index)),
      );

      expect((await readFact(client, a, firstFact(dayA).factId)).retractedAt).toBeNull();
      // THE TOOL REFUSED AND SAID SO TO THE MODEL, which chose silence.
      // The marker is the submission's word rather than an act's, because
      // this refusal has none of its own — nothing definite was named, so
      // there is nothing to record beyond the turn that happened.
      expect(await dispositionOf(client, attempt)).toBe("deliberate_silence");
      expect(await twinPosts(client, b, "correction_ack")).toEqual([]);
      // ...and NOTHING was chained: the tool never reached a line, so no
      // definite act was refused (Diego's standing rule in
      // `audit-coverage.ts` — a verb that never resolved does not chain).
      const chain = await client.query(
        `SELECT 1 FROM audit_chain
          WHERE action = 'fact_retraction' AND ref LIKE 'twin:' || $1 || '%'`,
        [b.twinId],
      );
      expect(chain.rows).toEqual([]);
      a.bundle.close();
      b.bundle.close();
    });
  });

  it("refuses a target the aperture did not write, even when a caller composes one directly", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const day = await aDisclosedDay(client, twin);
      const act = await repReply(client, twin, {
        text: correctionFor(firstFact(day)),
        quoting: day.waMessageId,
        tag: "CD",
      });
      const payload = await client.query<{ external_event_id: string }>(
        "SELECT external_event_id FROM wa_events WHERE id = $1",
        [act],
      );
      const waMessageId = payload.rows[0]!.external_event_id.split(":")[1]!;

      // The twin's own walk can never produce this — the numbering is
      // twin-scoped in the schema — so the aperture refusing it is the
      // second lock on the same door: the target is re-read from the
      // aperture's OWN store, scoped by the act it just verified.
      await expect(
        retractDisclosedFact(
          { db: client, dek: twin.dek, hmacKey: TEST_AUDIT_HMAC_KEY },
          {
            twinId: twin.twinId,
            disclosureLineId: randomUUID(),
            evidence: { surface: "twin_thread", sourceEventId: act, waMessageId },
          },
        ),
      ).rejects.toThrow(UnknownDisclosureLineError);
      expect((await readFact(client, twin, firstFact(day).factId)).retractedAt).toBeNull();
      twin.bundle.close();
    });
  });
});

// ---------------------------------------------------------------------
// Ticket #344 — a line corrected in place, through the dashboard's door
// ---------------------------------------------------------------------

describe("a line corrected on the card keeps the rep's words beside the annotation (ticket #344)", () => {
  it("annotates the fact, copies the door row's sealed words in the same unit, and chains their digest", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const seat = await seatAtTheDoor(client, twin.twinId);
      const scoped = { ...twin, companyId: seat.companyId, seatId: seat.seatId };
      const record = await disclosedFact(client, scoped, { reachedAt: new Date() });
      const corrected = "Le cotizaste cajas en 4800 MXN.";
      const messageId = await typeAtTheDoor(client, twin, seat, corrected, {
        kind: "line",
        postId: record.postId,
        lineIndex: 1,
      });
      const line = await client.query<{ id: string }>(
        "SELECT disclosure_line_id AS id FROM disclosure_post_lines WHERE twin_id = $1 AND line_index = 1",
        [twin.twinId],
      );

      const outcome = await retractDisclosedFact(
        { db: client, dek: twin.dek, hmacKey: TEST_AUDIT_HMAC_KEY },
        {
          twinId: twin.twinId,
          disclosureLineId: line.rows[0]!.id,
          evidence: { surface: "dashboard_message", dashboardMessageId: messageId },
        },
      );
      expect(outcome).toEqual({ retracted: true, factId: record.factId, alreadyRetracted: false });

      // ANNOTATED, NEVER ERASED: the fact keeps its row and is marked.
      expect((await readFact(client, scoped as Twin, record.factId)).retractedAt).not.toBeNull();
      const kept = await client.query<{
        dashboard_message_id: string;
        correction_enc: Buffer;
        text_enc: Buffer;
      }>(
        `SELECT fr.dashboard_message_id, fr.correction_enc, m.text_enc
           FROM fact_retractions fr JOIN dashboard_messages m ON m.id = fr.dashboard_message_id
          WHERE fr.fact_id = $1`,
        [record.factId],
      );
      expect(kept.rows).toHaveLength(1);
      expect(kept.rows[0]!.dashboard_message_id).toBe(messageId);
      // THE REP'S OWN BYTES, copied by code from the row that evidences the act.
      expect(kept.rows[0]!.correction_enc.equals(kept.rows[0]!.text_enc)).toBe(true);
      expect(Buffer.from(twin.dek.decrypt(kept.rows[0]!.correction_enc)).toString("utf8")).toBe(corrected);

      // THE CHAIN COVERS THE ANNOTATION: the entry names the door's message and
      // the digest of the words kept, and the chain verifies.
      const digest = createHash("sha256").update(kept.rows[0]!.correction_enc).digest("hex");
      const entry = await client.query<{ ref: string; outcome: string }>(
        `SELECT ref, outcome FROM audit_chain
          WHERE action = 'fact_retraction' AND ref LIKE $1`,
        [`%message:${messageId}%`],
      );
      expect(entry.rows).toEqual([
        {
          ref: `twin:${twin.twinId} fact:${record.factId} line:${line.rows[0]!.id} correction:${digest} message:${messageId}`,
          outcome: "retracted",
        },
      ]);
      expect(await verifyAuditChainInDb(client, TEST_AUDIT_HMAC_KEY)).toMatchObject({ valid: true });
      twin.bundle.close();
    });
  });

  it("runs end to end at the door: the turn marks the message, and the coverage check finds the act and its entry", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const seat = await seatAtTheDoor(client, twin.twinId);
      const scoped = { ...twin, companyId: seat.companyId, seatId: seat.seatId };
      const record = await disclosedFact(client, scoped, { reachedAt: new Date() });
      // THE FIXTURE'S SEAM ROWS ARE YESTERDAY'S: only the rep's edit is pending.
      await client.query(
        `INSERT INTO wa_event_processing (event_id, twin_id, disposition)
         SELECT id, twin_id, 'captured' FROM wa_events WHERE twin_id = $1`,
        [twin.twinId],
      );
      const messageId = await typeAtTheDoor(client, twin, seat, "Le cotizaste cajas en 4800 MXN.", {
        kind: "line",
        postId: record.postId,
        lineIndex: 1,
      });
      await processPendingWaEvents(depsFor(client, twin, correctionTurns(messageId, 1)));
      const marker = await client.query<{ disposition: string }>(
        "SELECT disposition FROM dashboard_message_processing WHERE message_id = $1",
        [messageId],
      );
      expect(marker.rows).toEqual([{ disposition: "retracted" }]);
      // A TURN THAT ACTED AND SAID NOTHING still answers the door with the
      // act's receipt — as the reply to the line, and on both surfaces, by the
      // notice and send a button's receipt takes (ticket #358).
      const reply = await client.query<{ parts_enc: Buffer; notice_id: string | null }>(
        "SELECT parts_enc, notice_id FROM posts WHERE asked_message_id = $1",
        [messageId],
      );
      expect(reply.rows).toHaveLength(1);
      expect(reply.rows[0]!.notice_id).not.toBeNull();
      expect(JSON.parse(Buffer.from(twin.dek.decrypt(reply.rows[0]!.parts_enc)).toString("utf8"))).toEqual([
        { kind: "receipt", text: RECEIPTS.retracted(1) },
      ]);
      const report = await auditChainCoverageInDb(client);
      expect(report.violations).toEqual([]);
      expect(report.mustChain.find((one) => one.class === "fact_retraction_performed")!.acts).toBeGreaterThan(0);
      twin.bundle.close();
    });
  });

  it("refuses a closed window by the aperture's own word, chained, and keeps nothing", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const seat = await seatAtTheDoor(client, twin.twinId);
      const scoped = { ...twin, companyId: seat.companyId, seatId: seat.seatId };
      const record = await disclosedFact(client, scoped, { reachedAt: new Date() });
      const messageId = await typeAtTheDoor(client, twin, seat, "Le cotizaste cajas en 4800 MXN.", {
        kind: "line",
        postId: record.postId,
        lineIndex: 1,
      });
      // THE WINDOW SHUTS UNDER THE REP, after the door took their edit: a
      // finalization pass run past the close.
      await finalizeDueFacts(
        { db: client },
        { twinId: twin.twinId },
        new Date(Date.now() + 25 * 3_600_000),
      );
      const outcome = await retractDisclosedFact(
        { db: client, dek: twin.dek, hmacKey: TEST_AUDIT_HMAC_KEY },
        {
          twinId: twin.twinId,
          disclosureLineId: record.lineId,
          evidence: { surface: "dashboard_message", dashboardMessageId: messageId },
        },
      );
      expect(outcome).toEqual({ retracted: false, reason: "window_closed" });
      const rows = await client.query("SELECT 1 FROM fact_retractions WHERE fact_id = $1", [record.factId]);
      expect(rows.rows).toEqual([]);
      const entry = await client.query<{ outcome: string }>(
        "SELECT outcome FROM audit_chain WHERE action = 'fact_retraction' AND ref LIKE $1",
        [`%message:${messageId}%`],
      );
      expect(entry.rows).toEqual([{ outcome: "refused:window_closed" }]);
      twin.bundle.close();
    });
  });
});

// ---------------------------------------------------------------------
// AC 3 & 4 — what mints nothing, and what the rep is told
// ---------------------------------------------------------------------

describe("a correction that retracts nothing (AC 3, AC 4)", () => {
  it.each([
    "1 no, está mal",
    "1 no fueron 100",
    "1 no?",
    "no 1",
    "no",
    "01 no",
  ])(
    "%j mints nothing and the line stands — the revision loop stays out of scope",
    async (text) => {
      await withClient(async (client) => {
        const twin = freshTwin();
        const day = await aDisclosedDay(client, twin);
        await repReply(client, twin, {
          text,
          quoting: day.waMessageId,
          tag: "CB",
        });
        // A reply the verb does not accept is prose pointed at a twin post,
        // so the disclosure post's `follow_up` hands it to the Q&A. Scripted
        // silent, because what matters is what did NOT happen.
        await processPendingWaEvents(
          depsFor(client, twin, [
            { text: "" },
          ]),
        );

        for (const factId of factIdsOf(day)) {
          expect((await readFact(client, twin, factId)).retractedAt).toBeNull();
        }
        expect(
          (
            await client.query(
              "SELECT 1 FROM fact_retractions WHERE twin_id = $1",
              [twin.twinId],
            )
          ).rows,
        ).toEqual([]);
        expect(await twinPosts(client, twin, "correction_ack")).toEqual([]);
        twin.bundle.close();
      });
    },
  );

  it("an index the post never showed mints nothing and the rep is told, through the total microcopy record", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const day = await aDisclosedDay(client, twin);

      const attempt = await repReply(client, twin, {
        text: `el ${9} está mal`,
        quoting: day.waMessageId,
        tag: "CU",
      });
      // Still no model: an index that resolves to nothing is decided in
      // code, exactly like one that resolves.
      await processPendingWaEvents(
        depsFor(client, twin, correctionTurns(attempt, 9)),
      );

      for (const factId of factIdsOf(day)) {
        expect((await readFact(client, twin, factId)).retractedAt).toBeNull();
      }
      expect(await twinPosts(client, twin, "correction_refusal")).toEqual([
        "✳️ no encontré ese dato en este mensaje",
      ]);
      expect(await dispositionOf(client, attempt)).toBe("correction_refused");
      // CHAINED, even though the aperture never saw it (spec #48 decision
      // 18: rep acts AND REFUSALS). The rep named a definite line and the
      // system declined it — which is exactly the event they would later
      // dispute — so the caller is the tool, because the tool is what
      // refused.
      const chain = await client.query<{ caller: string; outcome: string }>(
        `SELECT caller, outcome FROM audit_chain
          WHERE action = 'fact_retraction' AND ref LIKE 'twin:' || $1 || '%'`,
        [twin.twinId],
      );
      // CHAINED UNDER THE TOOL'S OWN NAME (#174). It was
      // `correction_matcher`, and that matcher is deleted — the identity a
      // reader wants is the component that refused the act, which is now
      // the tool. The coverage class lists both words, because the chain is
      // append-only and entries written before this build carry the old one.
      expect(chain.rows).toEqual([
        { caller: "retract_disclosure_line", outcome: "refused:unknown_line" },
      ]);
      expect(
        await verifyAuditChainInDb(client, TEST_AUDIT_HMAC_KEY),
      ).toMatchObject({ valid: true });
      twin.bundle.close();
    });
  });

  it("an entity-create line cannot be corrected yet, and says so rather than failing silently", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const day = await aDisclosedDay(client, twin);
      // Line 1 is «Lo di de alta como cliente.» — the first line every rep
      // ever reads, which is why this is not a corner case.
      expect(day.entityCreateIndex).toBe(1);

      const attempt = await repReply(client, twin, {
        text: `el ${day.entityCreateIndex} está mal`,
        quoting: day.waMessageId,
        tag: "CE",
      });
      await processPendingWaEvents(
        depsFor(client, twin, correctionTurns(attempt, day.entityCreateIndex)),
      );

      expect(await twinPosts(client, twin, "correction_refusal")).toEqual([
        "✳️ eso todavía no se puede corregir",
      ]);
      expect(await dispositionOf(client, attempt)).toBe("correction_refused");
      // Nothing unbound, nothing removed, and no FACT touched either:
      // unbinding is a different act with no verb, and inferring one from a
      // correction would let a stale post undo a confirmation.
      expect(twin.bundle.readChatBinding(twin.chat)).toBeDefined();
      for (const factId of factIdsOf(day)) {
        expect((await readFact(client, twin, factId)).retractedAt).toBeNull();
      }
      // Chained, because the APERTURE refused a rep act (decision 18).
      const chain = await client.query<{ outcome: string }>(
        `SELECT outcome FROM audit_chain
          WHERE action = 'fact_retraction' AND ref LIKE 'twin:' || $1 || '%'`,
        [twin.twinId],
      );
      expect(chain.rows.map((r) => r.outcome)).toEqual(["refused:not_a_fact"]);
      twin.bundle.close();
    });
  });
});

// ---------------------------------------------------------------------
// AC 5, 6, 7 — the correction window closes on the rep's clock
// ---------------------------------------------------------------------

describe("facts finalize 24h after REP-REACHABILITY, never after filing (AC 5; ADR-0004)", () => {
  it("does not finalize while the window is open, and finalizes at the instant it closes", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const day = await aDisclosedDay(client, twin);
      const ctx = { db: client };
      const target = { twinId: twin.twinId };

      // One second before the window closes: nothing.
      expect(
        await finalizeDueFacts(
          ctx,
          target,
          new Date(WINDOW_CLOSES.getTime() - 1000),
        ),
      ).toMatchObject({ finalized: 0 });
      for (const factId of factIdsOf(day)) {
        expect((await readFact(client, twin, factId)).finalizedAt).toBeNull();
      }

      // At the instant it closes: both.
      const closed = await finalizeDueFacts(ctx, target, WINDOW_CLOSES);
      expect(closed.finalized).toBe(2);
      for (const factId of factIdsOf(day)) {
        const fact = await readFact(client, twin, factId);
        // The stored instant is when the window actually closed, not when
        // the pass noticed — so it is the same whenever the pass runs.
        expect(fact.finalizedAt!.toISOString()).toBe(
          WINDOW_CLOSES.toISOString(),
        );
      }
      twin.bundle.close();
    });
  });

  it("measures from the post, not from the filing — a disclosure that arrived late finalizes late", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      // Filed on the 29th and disclosed then, but the rail was down: the
      // executor did not land the post until three days later.
      const lateBy = new Date("2026-09-02T03:31:00Z");
      const day = await aDisclosedDay(client, twin, { postedAt: lateBy });

      // 24h after FILING is long past, and nothing finalizes.
      expect(
        await finalizeDueFacts(
          { db: client },
          { twinId: twin.twinId },
          new Date("2026-08-31T12:00:00Z"),
        ),
      ).toMatchObject({ finalized: 0 });

      // 24h after the rep could have READ it, and they do.
      expect(
        await finalizeDueFacts(
          { db: client },
          { twinId: twin.twinId },
          new Date(lateBy.getTime() + CORRECTION_WINDOW_HOURS * 3_600_000),
        ),
      ).toMatchObject({ finalized: 2 });
      expect((await readFact(client, twin, firstFact(day).factId)).finalizedAt).not.toBeNull();
      twin.bundle.close();
    });
  });

  it("a post the rep never received starts no clock at all", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      // The disclosure was assembled and queued, and the executor never
      // resolved it — so `readPendingLines` still owes those lines, and
      // finalizing them here would close a window that never opened.
      const day = await aDisclosedDay(client, twin, { postedAt: null });

      expect(
        await finalizeDueFacts(
          { db: client },
          { twinId: twin.twinId },
          new Date("2026-09-30T00:00:00Z"),
        ),
      ).toMatchObject({ finalized: 0 });
      for (const factId of factIdsOf(day)) {
        expect((await readFact(client, twin, factId)).finalizedAt).toBeNull();
      }
      twin.bundle.close();
    });
  });

  it.each(["failed", "held"] as const)(
    "a post whose send resolved %j reached nobody, so its facts never finalize",
    async (outcome) => {
      await withClient(async (client) => {
        const twin = freshTwin();
        const day = await aDisclosedDay(client, twin, { postedAt: null });
        await client.query(
          `UPDATE send_commands SET outcome = $2, executed_at = $3
            WHERE twin_id = $1 AND payload_ref = 'notice:' || $4`,
          [twin.twinId, outcome, POSTED_AT, day.noticeId],
        );

        expect(
          await finalizeDueFacts(
            { db: client },
            { twinId: twin.twinId },
            new Date("2026-09-30T00:00:00Z"),
          ),
        ).toMatchObject({ finalized: 0 });
        for (const factId of factIdsOf(day)) {
          expect((await readFact(client, twin, factId)).finalizedAt).toBeNull();
        }
        twin.bundle.close();
      });
    },
  );

  it("A RETRACTED FACT NEVER FINALIZES, however long the window has been shut (AC 2)", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const day = await aDisclosedDay(client, twin);
      const acted = await repReply(client, twin, {
        text: correctionFor(firstFact(day)),
        quoting: day.waMessageId,
        tag: "CF",
      });
      await processPendingWaEvents(
        depsFor(client, twin, correctionTurns(acted, firstFact(day).index)),
      );

      const result = await finalizeDueFacts(
        { db: client },
        { twinId: twin.twinId },
        new Date("2026-09-30T00:00:00Z"),
      );
      // Only the uncorrected one.
      expect(result.factIds).toEqual([day.factLines[1]!.factId]);
      const retracted = await readFact(client, twin, firstFact(day).factId);
      expect(retracted.retractedAt).not.toBeNull();
      expect(retracted.finalizedAt).toBeNull();
      twin.bundle.close();
    });
  });

  it("finalizes exactly once: a second pass, and a restart, annotate nothing more (AC 7)", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const day = await aDisclosedDay(client, twin);
      const first = await finalizeDueFacts(
        { db: client },
        { twinId: twin.twinId },
        WINDOW_CLOSES,
      );
      expect(first.finalized).toBe(2);
      const stamped = await readFact(client, twin, firstFact(day).factId);

      // A later pass, with a LATER `now` — the value must not move, because
      // it is derived from reachability rather than from when the pass ran.
      for (const now of [
        WINDOW_CLOSES,
        new Date("2026-09-05T00:00:00Z"),
        new Date("2026-10-01T00:00:00Z"),
      ]) {
        expect(
          await finalizeDueFacts({ db: client }, { twinId: twin.twinId }, now),
        ).toMatchObject({ finalized: 0 });
      }
      expect((await readFact(client, twin, firstFact(day).factId)).finalizedAt).toEqual(
        stamped.finalizedAt,
      );
      twin.bundle.close();
    });
  });

  it("a fact whose window has closed can no longer be corrected, and the rep is told", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const day = await aDisclosedDay(client, twin);
      await finalizeDueFacts({ db: client }, { twinId: twin.twinId }, WINDOW_CLOSES);

      const late = await repReply(client, twin, {
        text: correctionFor(firstFact(day)),
        quoting: day.waMessageId,
        tag: "CW",
        at: new Date("2026-09-01T10:00:00Z"),
      });
      await processPendingWaEvents(
        depsFor(client, twin, correctionTurns(late, firstFact(day).index)),
      );

      // Refused rather than crashing on the store's own CHECK — a rep
      // typing a late «1 no» must never take the runtime down.
      const fact = await readFact(client, twin, firstFact(day).factId);
      expect(fact.retractedAt).toBeNull();
      expect(fact.finalizedAt).not.toBeNull();
      expect(await twinPosts(client, twin, "correction_refusal")).toEqual([
        "✳️ ese dato ya quedó firme y ya no se puede corregir",
      ]);
      expect(await dispositionOf(client, late)).toBe("correction_refused");
      const chain = await client.query<{ outcome: string }>(
        `SELECT outcome FROM audit_chain
          WHERE action = 'fact_retraction' AND ref LIKE 'twin:' || $1 || '%'`,
        [twin.twinId],
      );
      expect(chain.rows.map((r) => r.outcome)).toEqual([
        "refused:window_closed",
      ]);
      twin.bundle.close();
    });
  });

  it("finalizes only its own twin's facts", async () => {
    await withClient(async (client) => {
      const a = freshTwin();
      const b = freshTwin();
      const dayA = await aDisclosedDay(client, a);
      const dayB = await aDisclosedDay(client, b);

      expect(
        await finalizeDueFacts({ db: client }, { twinId: a.twinId }, WINDOW_CLOSES),
      ).toMatchObject({ finalized: 2 });
      for (const factId of factIdsOf(dayA)) {
        expect((await readFact(client, a, factId)).finalizedAt).not.toBeNull();
      }
      for (const factId of factIdsOf(dayB)) {
        expect((await readFact(client, b, factId)).finalizedAt).toBeNull();
      }
      a.bundle.close();
      b.bundle.close();
    });
  });
});

describe("the loop actually runs the clock (AC 5, the wiring)", () => {
  it("finalizes a fact whose window closed, from one pass of the runtime itself", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      // THE ONE FIXTURE INSTANT IN THIS FILE THAT IS NOT A LITERAL, and it
      // is the point of the test. `runTwinRuntime` reads the wall clock
      // once and hands it to every daily pass — that read is the wiring,
      // and a fixture pinned to 2026 could never exercise it. So the
      // disclosure is posted 25 hours before whenever this runs, and the
      // assertion is only that the loop reached the pass at all. Everything
      // ABOUT the clock is tested above, against literals.
      const postedAt = new Date(
        Date.now() - (CORRECTION_WINDOW_HOURS + 1) * 3_600_000,
      );
      const day = await aDisclosedDay(client, twin, { postedAt });
      for (const factId of factIdsOf(day)) {
        expect((await readFact(client, twin, factId)).finalizedAt).toBeNull();
      }

      const abort = new AbortController();
      // Started, not awaited — the loop returns only when the signal is
      // raised, which is the shape runtime.int.test.ts already uses.
      //
      // `disclosureHour: 0` lets the daily passes through whatever hour it
      // is wherever this runs, and ONE scripted extraction submission
      // covers them: extraction takes at most one chat per iteration and
      // marks its run settled, the day's lines are all delivered so nothing
      // is pending to disclose, and every seam event was consumed by the
      // fixture. The loop therefore reaches a fixed point after one pass,
      // and what is left moving is the clock.
      const run = runTwinRuntime(
        { ...depsFor(client, twin, extracted()), disclosureHour: 0 },
        { pollIntervalMs: 5, signal: abort.signal },
      );
      try {
        await waitFor(
          async () =>
            (await readFact(client, twin, factIdsOf(day)[0]!)).finalizedAt !==
            null,
        );
      } finally {
        abort.abort();
        await run;
      }

      for (const factId of factIdsOf(day)) {
        expect((await readFact(client, twin, factId)).finalizedAt).not.toBeNull();
      }
      twin.bundle.close();
    });
  });
});

// ---------------------------------------------------------------------
// AC 8 — nothing here flips the shadow flag
// ---------------------------------------------------------------------

describe("every fact stays shadow-flagged (AC 8; ADR-0016)", () => {
  it("a finalized fact is still shadow, and still invisible through the view a reader uses", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const day = await aDisclosedDay(client, twin);
      await finalizeDueFacts({ db: client }, { twinId: twin.twinId }, WINDOW_CLOSES);

      for (const factId of factIdsOf(day)) {
        expect((await readFact(client, twin, factId)).shadow).toBe(true);
      }
      // The launch gate is a WHERE clause: finalization moves a row one
      // step closer to readable and no owner can see it either way. Flipping
      // the flag is slice 4's, gated by Test 4.
      // The company is DECLARED before the read (ticket #127): the
      // finalized views run as a policy-bound role, so a session naming no
      // company reads nothing through one — and this assertion is about the
      // SHADOW filter, so it has to be able to fail for that reason.
      await client.query("SELECT set_config('dito.company_id', $1, false)", [
        twin.companyId,
      ]);
      const visible = await client.query(
        "SELECT id FROM ledger.finalized_facts WHERE company_id = $1",
        [twin.companyId],
      );
      await client.query("RESET dito.company_id");
      expect(visible.rows).toEqual([]);
      twin.bundle.close();
    });
  });

  it("a retracted fact is invisible through the view too, for its own reason", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const day = await aDisclosedDay(client, twin);
      const acted = await repReply(client, twin, {
        text: correctionFor(firstFact(day)),
        quoting: day.waMessageId,
        tag: "CS",
      });
      await processPendingWaEvents(
        depsFor(client, twin, correctionTurns(acted, firstFact(day).index)),
      );
      expect((await readFact(client, twin, firstFact(day).factId)).shadow).toBe(true);
      // The company is DECLARED before the read (ticket #127): the
      // finalized views run as a policy-bound role, so a session naming no
      // company reads nothing through one — and this assertion is about the
      // SHADOW filter, so it has to be able to fail for that reason.
      await client.query("SELECT set_config('dito.company_id', $1, false)", [
        twin.companyId,
      ]);
      const visible = await client.query(
        "SELECT id FROM ledger.finalized_facts WHERE company_id = $1",
        [twin.companyId],
      );
      await client.query("RESET dito.company_id");
      expect(visible.rows).toEqual([]);
      twin.bundle.close();
    });
  });
});

// ---------------------------------------------------------------------
// The stores hold what they claim to
// ---------------------------------------------------------------------

describe("the retraction's own record is immutable (ADR-0034)", () => {
  it("refuses UPDATE and DELETE on a filed retraction", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const day = await aDisclosedDay(client, twin);
      const acted = await repReply(client, twin, {
        text: correctionFor(firstFact(day)),
        quoting: day.waMessageId,
        tag: "CI",
      });
      await processPendingWaEvents(
        depsFor(client, twin, correctionTurns(acted, firstFact(day).index)),
      );

      await expect(
        client.query(
          "UPDATE fact_retractions SET retracted_at = now() WHERE twin_id = $1",
          [twin.twinId],
        ),
      ).rejects.toThrow(/immutable/);
      await expect(
        client.query("DELETE FROM fact_retractions WHERE twin_id = $1", [
          twin.twinId,
        ]),
      ).rejects.toThrow(/immutable/);
      twin.bundle.close();
    });
  });
});
