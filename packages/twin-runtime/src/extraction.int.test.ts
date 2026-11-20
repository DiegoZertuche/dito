/**
 * Batch extraction: the day's facts (ticket #52; spec #48 grilling
 * decisions 1, 4, 5, 6 and 13).
 *
 * Tested across the primary Postgres seam, the same one slices 1 and 2 use:
 * insert the day's `wa_events`, run the pass with an explicit `now`, and
 * read back what reached the Ledger, the disclosure, and the run's own
 * state. Real Postgres, real envelope crypto, real SQLCipher (ADR-0028);
 * the model is scripted at the model boundary, and every
 * suite that must make NO model call scripts it empty so a call fails
 * loudly.
 *
 * The properties under test are the ticket's ACs: a daily per-chat pass
 * over BOUND, in-scope chats; the run as a row carrying a state; four fact
 * types and no fifth; ContactEstablished's normalized identifiers; the
 * confidence gate filing nothing below it; ADR-0033 mechanized by
 * enumeration rather than by a filter; the orphan rule deferring an unbound
 * chat to the next run; the window being the day and never backfilled
 * history; restart-safety and idempotence per (twin, chat, day); and model
 * output minting nothing.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  auditSelfChatExclusion,
  countFiledEntities,
  fileCandidateFact,
  fileEntityCreate,
  finalizeDueFacts,
  readEntityMerges,
  readFiledFacts,
  resolveEntity,
  type FiledFact,
} from "@dito/aperture";
import { createBundle, type Bundle } from "@dito/bundle";
import type { OpaqueReason } from "@dito/seam";
import { createDekFromMaterial, type Dek } from "@dito/crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setAutomationPaused } from "./runs/pauses.js";
import { bindingQuestionAsked } from "./answering.js";
import { processPendingWaEvents, type TwinRuntimeDeps } from "./consumer.js";
import { createSendLockWriter } from "./send-lock/writer.js";
import { withDbTransaction } from "./db-tx.js";
import { runDailyDisclosure, runDailyExtraction } from "./runs/by-hand.js";
import { seatTheTwin } from "./testing/seat.js";
import { clockPass, driveRuns } from "./testing/drive-runs.js";
import { ensureShippedAutomations } from "./runs/shipped-automations.js";
import { advanceRuns, createRunEngine } from "./runs/engine.js";
import { fireDueCadences } from "./runs/wakes.js";
import { composeBindingQuestionPost } from "./posts.js";
import { civilDate, parseIsoInstant } from "./rep-clock.js";
import { insertNoticeWithSystemSend } from "./notices.js";
import type { DailyExtractionDeps } from "./extraction-pass.js";
import { openBatchWork } from "./lanes.js";
import {
  serveRuntimeRequests,
  settleStrandedRequests,
} from "./runtime-requests.js";
import {
  resetAndMigrate,
  withClient,
  TEST_AUDIT_HMAC_KEY,
  TEST_DATABASE_URL,
} from "./testing/db.js";
import {
  insertWaEvent,
  insertWaOpaque,
  insertWaReaction,
  simulateExecutorPost,
} from "./testing/seam-fixtures.js";
import { embedOne } from "./embedder.js";
import { EXTRACTION_DEFINITION } from "./extraction/definition.js";

/**
 * THE ROUNDS A LONE CHAT'S READ HAS: the run's whole budget, since the `each`
 * splits it over one claim and the step takes its share (ticket #396).
 */
const EXTRACTION_MAX_ITERATIONS = EXTRACTION_DEFINITION.budget.iterations;
import { fakeEmbedder } from "./testing/fake-embedder.js";
import { newExecutionPool } from "./testing/execution-pool.js";
import { removeTmpDir } from "./testing/tmp.js";
import { isThreadTurn } from "./testing/thread-script.js";
import {
  closeScriptedModels,
  extractionTurns,
  latestPromptOf,
  qaSilenceTurns,
  scriptedModel,
  toolResultsOf,
  type ScriptedModel,
  type Script,
  type ScriptedTurn,
} from "./testing/scripted-model.js";
import { composedDisclosure } from "./testing/disclosure-script.js";
import type { TraceEvent } from "@dito/execution";
import { SETTLE_IMMEDIATELY } from "./testing/settle.js";

// Every scripted model this suite opened is closed with it (#328).
afterAll(closeScriptedModels);

const SELF_CHAT = "5215550000@s.whatsapp.net";
const ZONE = "America/Monterrey";

/**
 * Chat JIDs are unique per twin. The seam dedupes on
 * `(source, external_event_id)` and composes that id as
 * `<chat jid>:<message id>` — GLOBALLY, across twins (ADR-0005) — so two
 * suites reusing one JID and one message id collide. Each twin gets its
 * own customers instead, which is also the more honest fixture.
 */
let chatCounter = 0;

/** The rep's day under test: 2026-08-29 in America/Monterrey (UTC-6). */
const MORNING = new Date("2026-08-29T15:20:00Z");
const EVENING = new Date("2026-08-30T01:23:00Z");
/** 21:30 on the rep's clock — after the settle hour, still the 29th. */
const NOW = new Date("2026-08-30T03:30:00Z");
/** Yesterday, on the rep's clock. */
const YESTERDAY = new Date("2026-08-28T20:00:00Z");

/**
 * How long a held model call keeps an execution's transaction open, when a
 * suite needs the transaction's start and its filing statements to be
 * measurably different instants (#200 hotfix 1).
 *
 * REAL TIME RATHER THAN A MOVED CLOCK, because the stamps under test are
 * Postgres's own and no parameter reaches them. Small enough not to slow the
 * lane, and the skew it proves is zero under `now()` however long it is.
 */
const HELD_CALL_MS = 400;

/**
 * HOW EACH FIXTURE INSTANT IS STAMPED IN THE TRANSCRIPT (ticket #139) —
 * literals read off a calendar and a clock, never rendered here.
 *
 * 29 August 2026 is a Saturday, and both of the day's instants are that
 * Saturday on the rep's clock even though `EVENING` is already the 30th in
 * UTC — which is exactly the reading the beat stamp exists to give.
 */
const AT_MORNING = "Saturday, Aug 29, 2026, 09:20:00 CST";
const AT_EVENING = "Saturday, Aug 29, 2026, 19:23:00 CST";

let tmp: string;

/** Where every extraction execution borrows its own connection (#173, #194). */
const pool = newExecutionPool();

/**
 * The send-lock writer's own pool (ticket #24).
 *
 * SEPARATE FROM THE EXECUTIONS', which is the rig's own arrangement and its
 * argument: an execution holds a connection for the length of a model call,
 * and the writer's three statements are on the path of a REP ACT that must
 * never wait behind one. Only the concurrency test below needs a consumer at
 * all; the pool is opened at module scope because that is where a hook
 * registration belongs.
 */
const sendLockPool = newSendLockPool();

function newSendLockPool(): pg.Pool {
  const created = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 2 });
  afterAll(async () => {
    await created.end();
  });
  return created;
}

/**
 * The CONSUMER's deps for the one test that runs a customer turn beside an
 * extraction (ticket #194).
 *
 * A second builder rather than a widened `depsFor`, because the two are
 * different claims: every other test in this file drives the daily pass
 * alone, and giving it a send-lock writer it never uses would say that was
 * part of what extraction needs. The EMBEDDER is on both, because the search
 * is extraction's own tool (ticket #196) and therefore part of what
 * extraction needs.
 */
function consumerDepsFor(client: pg.Client, twin: Twin): TwinRuntimeDeps {
  return {
    ...depsFor(client, twin),
    db: client,
    sendLock: createSendLockWriter({
      pool: sendLockPool,
      hmacKey: TEST_AUDIT_HMAC_KEY,
    }),
  };
}

beforeAll(async () => {
  await resetAndMigrate();
  tmp = mkdtempSync(join(tmpdir(), "dito-extraction-int-"));
});

afterAll(() => {
  removeTmpDir(tmp);
});

interface Twin {
  readonly twinId: string;
  readonly companyId: string;
  readonly seatId: string;
  readonly dek: Dek;
  readonly bundle: Bundle;
  /** This twin's own customer chat. */
  readonly chat: string;
  /** ...and a second one, for the passes that read more than one. */
  readonly otherChat: string;
}

function freshTwin(): Twin {
  const twinId = randomUUID();
  const dek = createDekFromMaterial(randomBytes(32));
  chatCounter += 2;
  return {
    twinId,
    companyId: randomUUID(),
    seatId: randomUUID(),
    dek,
    bundle: createBundle(join(tmp, `${twinId}.bundle`), dek),
    chat: `52155${String(100000 + chatCounter)}@s.whatsapp.net`,
    otherChat: `52155${String(100001 + chatCounter)}@s.whatsapp.net`,
  };
}

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
): DailyExtractionDeps {
  const { harness } = scriptedModel(turns);
  return {
    db: client,
    // An extraction runs its whole transaction on a connection of its own
    // (ticket #194; `lanes.ts`), so the suite is the composition root that
    // owns the pool.
    executionPool: pool,
    harness,
    bundle: twin.bundle,
    dek: twin.dek,
    hmacKey: TEST_AUDIT_HMAC_KEY,
    twinId: twin.twinId,
    selfChatJid: SELF_CHAT,
    // The search's own boundary (ticket #196): the deterministic fake, whose
    // cosine similarity follows word overlap — so what a scripted search
    // finds is exactly assertable with no model in the loop (ADR-0028).
    embedder: fakeEmbedder(),
    // Ticket #75: this suite is not about batching (see testing/settle.ts).
    ...SETTLE_IMMEDIATELY,
    drafting: { model: "claude-sonnet-5" },
    timeZone: ZONE,
  };
}

/** Puts a chat in scope, the way the plane's capture guard reads it. */
async function inScope(
  client: pg.Client,
  twin: Twin,
  ...chats: string[]
): Promise<void> {
  // THE DAY IS READ BY A RUN OF THE SEAT'S, so the twin is seated first.
  await seatTheTwin(client, twin);
  for (const chatJid of chats) {
    await client.query(
      "INSERT INTO scope_allowlist (twin_id, chat_jid) VALUES ($1, $2)",
      [twin.twinId, chatJid],
    );
  }
}

/** One message on the seam, in a customer chat unless told otherwise. */
async function seamMessage(
  client: pg.Client,
  twin: Twin,
  args: {
    messageId: string;
    text: string;
    occurredAt: Date;
    chatJid?: string;
    fromMe?: boolean;
    pushName?: string;
    backfill?: boolean;
  },
): Promise<string> {
  const chatJid = args.chatJid ?? twin.chat;
  return insertWaEvent(client, twin.dek, {
    twinId: twin.twinId,
    companyId: twin.companyId,
    seatId: twin.seatId,
    chatJid,
    senderJid: args.fromMe === true ? SELF_CHAT : chatJid,
    fromMe: args.fromMe ?? false,
    messageId: args.messageId,
    text: args.text,
    occurredAt: args.occurredAt,
    ...(args.pushName === undefined ? {} : { pushName: args.pushName }),
    ...(args.backfill === undefined ? {} : { backfill: args.backfill }),
  });
}

/**
 * One REACTION on the seam (ticket #98), sealed the way the plane will
 * once #100 lands. `messageId` is the reaction's own stanza id and
 * `reactionTo` is the message it points at; an empty `emoji` is a removal.
 */
async function seamReaction(
  client: pg.Client,
  twin: Twin,
  args: {
    messageId: string;
    reactionTo: string;
    emoji: string;
    occurredAt: Date;
    chatJid?: string;
    fromMe?: boolean;
    pushName?: string;
    backfill?: boolean;
    /**
     * The reactor's own millisecond clock. Defaults to `occurredAt`, which
     * is what the plane stamps when the rail supplies none — pinned only by
     * the suites that care WHERE INSIDE A SECOND the tap fell (#109).
     */
    senderTsMs?: number;
  },
): Promise<string> {
  const chatJid = args.chatJid ?? twin.chat;
  return insertWaReaction(client, twin.dek, {
    twinId: twin.twinId,
    companyId: twin.companyId,
    seatId: twin.seatId,
    chatJid,
    senderJid: args.fromMe === true ? SELF_CHAT : chatJid,
    fromMe: args.fromMe ?? false,
    messageId: args.messageId,
    reactionTo: args.reactionTo,
    emoji: args.emoji,
    occurredAt: args.occurredAt,
    ...(args.senderTsMs === undefined ? {} : { senderTsMs: args.senderTsMs }),
    ...(args.pushName === undefined ? {} : { pushName: args.pushName }),
    ...(args.backfill === undefined ? {} : { backfill: args.backfill }),
  });
}

/**
 * One OPAQUE delivery on the seam (ticket #124), sealed the way the plane
 * will once #125 lands. `messageId` is the ROW's identity — the caller
 * passes the `<stanza>:opaque` suffix itself, exactly as the plane composes
 * it — and `kind` is the rail's own name for the shape.
 */
async function seamOpaque(
  client: pg.Client,
  twin: Twin,
  args: {
    messageId: string;
    kind: string;
    occurredAt: Date;
    reason?: OpaqueReason;
    chatJid?: string;
    fromMe?: boolean;
    pushName?: string;
    backfill?: boolean;
  },
): Promise<string> {
  const chatJid = args.chatJid ?? twin.chat;
  return insertWaOpaque(client, twin.dek, {
    twinId: twin.twinId,
    companyId: twin.companyId,
    seatId: twin.seatId,
    chatJid,
    senderJid: args.fromMe === true ? SELF_CHAT : chatJid,
    fromMe: args.fromMe ?? false,
    messageId: args.messageId,
    kind: args.kind,
    reason: args.reason ?? "no_slot",
    occurredAt: args.occurredAt,
    ...(args.pushName === undefined ? {} : { pushName: args.pushName }),
    ...(args.backfill === undefined ? {} : { backfill: args.backfill }),
  });
}

/**
 * A rep-confirmed binding, the whole way slice 2 produces one: the twin
 * asked, the rep said «si», the mirror holds the binding and the aperture
 * filed the entity create.
 *
 * The QUESTION is part of the fixture rather than skipped, because the
 * ADR-0033 invariant derives each twin's own thread from its `system_send`
 * commands — and a twin that never posted anything has no thread to
 * exclude, which the invariant reports as uncheckable. A twin with a bound
 * chat and no post is a state this system cannot reach, so a fixture that
 * built one was testing something that does not exist.
 *
 * Its proposal event sits YESTERDAY, outside every window under test: the
 * ceremony that named a customer is not part of the day being extracted.
 */
async function bindChat(
  client: pg.Client,
  twin: Twin,
  chatJid: string,
  displayName: string,
  /** What the model determined this customer is (ticket #60). */
  kind: "person" | "business" = "person",
  /**
   * Whether the ENTITY crossed (ticket #196).
   *
   * `false` is the state the crossing backlog exists for
   * (`crossPendingBindings`): twin memory holds a binding the rep confirmed
   * before the Ledger existed, so the mirror names an entity no Ledger row
   * backs. The ceremony still runs, because the ADR-0033 invariant derives
   * each twin's own thread from its `system_send` commands and a twin that
   * never posted has no thread to exclude — which it reports as uncheckable
   * rather than green.
   */
  cross = true,
): Promise<string> {
  const entityId = randomUUID();
  const short = entityId.slice(0, 8);
  const proposalEventId = await insertWaEvent(client, twin.dek, {
    twinId: twin.twinId,
    companyId: twin.companyId,
    seatId: twin.seatId,
    chatJid,
    senderJid: chatJid,
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
        chatJid,
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
    quotedMessageId: "WAMID-QUESTION",
    occurredAt: MORNING,
  });
  twin.bundle.confirmChatBinding({
    chatJid,
    entityId,
    displayName,
    confirmedAt: MORNING.toISOString(),
  });
  if (cross) {
    await fileEntityCreate(
      { db: client, dek: twin.dek, hmacKey: TEST_AUDIT_HMAC_KEY },
      {
        twinId: twin.twinId,
        entityId,
        kind,
        displayName,
        evidence: { surface: "twin_thread", sourceEventId, waMessageId: messageId },
        disclosureText: "Lo di de alta como cliente.",
      },
    );
  }
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

/**
 * ONE PASS OF THE ONE CLOCK (tickets #194, #364): Dito's rows written for the
 * twin's seat, every cadence that has come due fired, and the runs it started
 * driven to rest — what `runtime.ts` does across the ticks after the hour.
 * How many runs the clock started.
 */
async function scheduledPass(deps: DailyExtractionDeps, now: Date): Promise<number> {
  return await clockPass(deps, now);
}

/**
 * The transcript the model was actually shown — the prompt of its first
 * request. What a suite asserts about extraction's rendering is asserted
 * here and nowhere else: the renderer is never called directly, so a test
 * says what the MODEL saw rather than what a helper returned.
 */
function transcriptOf(model: ScriptedModel): string {
  return latestPromptOf(model.requests[0] ?? {});
}

/**
 * The executions of the reads a day's run made — its children's agent steps,
 * the ones that read a chat — in order. The run's code steps leave records of
 * their own, which say nothing about a chat's read.
 */
async function readReads(client: pg.Client, twin: Twin): Promise<pg.QueryResult<Record<string, unknown>>> {
  return await client.query<Record<string, unknown>>(
    `SELECT e.* FROM executions e
       JOIN run_steps s ON s.execution_id = e.id AND s.kind = 'agent'
       JOIN runs r ON r.id = s.run_id
      WHERE r.twin_id = $1
      ORDER BY e.started_at`,
    [twin.twinId],
  );
}

async function readRuns(
  client: pg.Client,
  twin: Twin,
): Promise<Record<string, unknown>[]> {
  const res = await client.query(
    `SELECT chat_jid, extraction_day, state, messages, candidates, filed,
            below_threshold, unresolved_reference, resolved_reference, refused,
            window_start, window_end, settled_at
       FROM extraction_runs WHERE twin_id = $1 ORDER BY chat_jid`,
    [twin.twinId],
  );
  return res.rows;
}

/**
 * What crossed, read the way a reader outside the aperture must: through
 * the writer's own read surface. Nothing outside `packages/aperture` names
 * a Ledger table — the source scan in `sole-writer.test.ts` enforces it, so
 * that slice 4's launch-gate flip stays a `WHERE` clause in a view.
 */
async function readFacts(client: pg.Client, twin: Twin): Promise<FiledFact[]> {
  return readFiledFacts({ db: client, dek: twin.dek }, twin.twinId);
}

/**
 * How many posts this twin wrote at all.
 *
 * IT IS THE "NO QUESTION ANYWHERE" ASSERTION (ticket #218). A dropped
 * candidate became a row in the candidate-question store and then a post;
 * that store is retired with its route, so what a seam test shows is the
 * observable half — the rep is told nothing. Every kind, deliberately: a drop
 * must produce no post of ANY kind, and naming one would be a claim about
 * which kind a regression picks.
 */
async function countPosts(client: pg.Client, twin: Twin): Promise<number> {
  const res = await client.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM notices WHERE twin_id = $1",
    [twin.twinId],
  );
  return res.rows[0]!.n;
}

/** How many things this twin has been told crossed. */
async function countLines(client: pg.Client, twin: Twin): Promise<number> {
  const res = await client.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM disclosure_lines WHERE twin_id = $1",
    [twin.twinId],
  );
  return res.rows[0]!.n;
}

describe("the daily per-chat extraction pass", () => {
  it("reads a bound in-scope chat's day, files what passes the gate, and settles its run", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await inScope(client, twin, twin.chat);
      const entityId = await bindChat(client, twin, twin.chat, "Ferretería Fuentes");
      await seamMessage(client, twin, {
        messageId: "WAMID-1",
        text: "¿en cuánto me dejas las 100 cajas?",
        occurredAt: MORNING,
      });
      await seamMessage(client, twin, {
        messageId: "WAMID-2",
        text: "te las dejo en 4500",
        occurredAt: EVENING,
        fromMe: true,
      });

      const result = await runDailyExtraction(
        depsFor(
          client,
          twin,
          extracted({
            fact_type: "QuoteGiven",
            message_id: "WAMID-2",
            confidence: 0.93,
            item: "cajas",
            quantity: 100,
            amount: 4500,
            currency: "MXN",
          }),
        ),
        NOW,
      );

      expect(result).toMatchObject({ chats: 1, extracted: 1, filed: 1, settled: true });

      const facts = await readFacts(client, twin);
      expect(facts).toHaveLength(1);
      expect(facts[0]).toMatchObject({
        factType: "QuoteGiven",
        // 2 since ticket #70: the commercial payloads gained an optional
        // `requestedFor`, per-type (ADR-0034). This message states no day,
        // so none is stored and the line says so.
        payloadVersion: 2,
        payload: { item: "cajas", quantity: 100, amount: 4500, currency: "MXN" },
        sourceType: "extraction",
        shadow: true,
        entityId,
        disclosureText: "Le cotizaste 100 cajas en 4,500 MXN — sin fecha.",
        finalizedAt: null,
        retractedAt: null,
      });
      // Valid time is when the claim was made in the chat.
      expect(facts[0]?.occurredAt).toEqual(EVENING);

      const runs = await readRuns(client, twin);
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({
        chat_jid: twin.chat,
        state: "filed",
        messages: 2,
        candidates: 1,
        filed: 1,
        below_threshold: 0,
        refused: 0,
      });
      expect(runs[0]?.["settled_at"]).not.toBeNull();
      // The window it read is the rep's own calendar day.
      // The first window for a chat starts at the rep's own midnight
      // (Monterrey is UTC-6 year-round since Mexico ended DST in 2022) and
      // ends WHERE THE PASS RAN, not at midnight — the watermark is what
      // carries the rest of the evening into the next run.
      expect(runs[0]?.["window_start"]).toEqual(new Date("2026-08-29T06:00:00Z"));
      expect(runs[0]?.["window_end"]).toEqual(new Date(NOW.getTime() - 60_000));
    });
  });

  it("with «Lo que aprendo de tus chats» paused on Rutinas the clock starts no run, and the rep's own ask reads the day once it is back on (tickets #325, #364)", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await inScope(client, twin, twin.chat);
      await bindChat(client, twin, twin.chat, "Ferretería Fuentes");
      await seamMessage(client, twin, {
        messageId: "WAMID-P1",
        text: "te las dejo en 4500",
        occurredAt: EVENING,
        fromMe: true,
      });
      await ensureShippedAutomations(client, { twinId: twin.twinId, seatId: twin.seatId }, YESTERDAY);
      const row = await client.query<{ id: string }>(
        "SELECT id FROM automations WHERE twin_id = $1 AND shipped = 'extraction'",
        [twin.twinId],
      );
      const paused = (value: boolean) =>
        setAutomationPaused(client, {
          twinId: twin.twinId,
          seatId: twin.seatId,
          automationId: row.rows[0]!.id,
          paused: value,
        });
      const quote = extracted({
        fact_type: "QuoteGiven",
        message_id: "WAMID-P1",
        confidence: 0.93,
        item: "cajas",
        quantity: 100,
        amount: 4500,
        currency: "MXN",
      });
      expect(await paused(true)).toBe(true);
      // PAUSED: no read, no claim, no record — the day's notes, which owe the
      // binding's line, are the clock's one run.
      await clockPass(depsFor(client, twin, quote), NOW);
      const none = await client.query("SELECT 1 FROM runs WHERE twin_id = $1 AND automation = 'extraction'", [twin.twinId]);
      expect(none.rows).toEqual([]);
      expect(await readRuns(client, twin)).toEqual([]);
      // BACK ON: the day is read.
      expect(await paused(false)).toBe(true);
      expect(await runDailyExtraction(depsFor(client, twin, quote), NOW)).toMatchObject({ chats: 1, extracted: 1 });
      expect(await readRuns(client, twin)).toHaveLength(1);
    });
  });

  it("never enumerates the twin thread — the rep's own notes are not an input (ADR-0033)", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      // The self-chat is in NEITHER of extraction's two sources: the plane
      // never writes it to `scope_allowlist` (it treats the self-chat as
      // in scope structurally, before the table is read), and it can never
      // be bound, because a binding names the customer a chat belongs to.
      await inScope(client, twin, twin.chat);
      await bindChat(client, twin, twin.chat, "Ferretería Fuentes");
      const note = await seamMessage(client, twin, {
        messageId: "WAMID-NOTE",
        text: "recuerda: con Fuentes siempre de usted",
        occurredAt: EVENING,
        chatJid: SELF_CHAT,
        fromMe: true,
      });
      await seamMessage(client, twin, {
        messageId: "WAMID-1",
        text: "todo bien, gracias",
        occurredAt: MORNING,
      });

      const model = scriptedModel(extracted());
      const result = await runDailyExtraction(
        { ...depsFor(client, twin), harness: model.harness },
        NOW,
      );

      expect(result.chats).toBe(1);
      const runs = await readRuns(client, twin);
      expect(runs.map((r) => r["chat_jid"])).toEqual([twin.chat]);
      expect(await readFacts(client, twin)).toEqual([]);
      // The note never reached the model at all.
      const turn = latestPromptOf(model.requests[0]!);
      expect(turn).not.toContain("recuerda");
      // ...and nothing anywhere names it as a source.
      const cited = await client.query<{ n: string }>(
        "SELECT count(*) AS n FROM disclosure_lines WHERE source_event_id = $1",
        [note],
      );
      expect(cited.rows[0]?.n).toBe("0");
    });
  });

  it("REFUSES rather than filters if the twin thread ever reaches its input — mechanized, not filtered (decision 4)", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      // The most hostile arrangement available: someone puts the rep's own
      // thread in the capture scope. A filter would quietly drop it and go
      // on — which is the rot decision 4 refused. The run's claim step
      // refuses instead and the run ends `failed`, so widening extraction's
      // input can never be a silent change.
      await inScope(client, twin, twin.chat, SELF_CHAT);
      await bindChat(client, twin, twin.chat, "Ferretería Fuentes");
      await seamMessage(client, twin, {
        messageId: "WAMID-NOTE-HOSTILE",
        text: "recuerda: con Fuentes siempre de usted",
        occurredAt: EVENING,
        chatJid: SELF_CHAT,
        fromMe: true,
      });

      const result = await runDailyExtraction(depsFor(client, twin, []), NOW);
      const run = await client.query("SELECT state FROM runs WHERE id = $1", [result.runIds[0]]);
      expect(run.rows).toEqual([{ state: "failed" }]);
      // And it claimed nothing and filed nothing on the way down.
      expect(await readRuns(client, twin)).toEqual([]);
      expect(await readFacts(client, twin)).toEqual([]);
    });
  });

  it("DROPS both readings below the aperture's confidence gate — no fact, no post, no line (FR-31; #218)", async () => {
    // THE TICKET'S OWN ACCEPTANCE, at the seam. Two candidates at 0.79, one
    // `stated` and one `resolved_reference`, and neither reaches anything:
    // the run's counter reads the drops and the rep is told nothing at all.
    // Both readings are driven because ADR-0039's 2026-09-06 amendment
    // routed the resolved one to a question separately, and the question
    // principle supersedes that too.
    await withClient(async (client) => {
      const twin = freshTwin();
      await inScope(client, twin, twin.chat);
      await bindChat(client, twin, twin.chat, "Ferretería Fuentes");
      await seamMessage(client, twin, {
        messageId: "WAMID-1",
        text: "creo que necesito unas 100",
        occurredAt: MORNING,
      });
      await seamMessage(client, twin, {
        messageId: "WAMID-2",
        text: "y lo mismo del pedido pasado",
        occurredAt: new Date(MORNING.getTime() + 60_000),
      });
      // The binding's own post is the only thing this twin has said so far,
      // and it is what the count below is read against.
      const before = await countPosts(client, twin);

      const result = await runDailyExtraction(
        depsFor(
          client,
          twin,
          extracted(
            {
              fact_type: "OrderRequested",
              message_id: "WAMID-1",
              confidence: 0.79,
              item: "cajas",
              quantity: 100,
            },
            {
              fact_type: "OrderRequested",
              message_id: "WAMID-2",
              confidence: 0.79,
              reading: "resolved_reference",
              item: "cemento gris",
              quantity: 40,
            },
          ),
        ),
        NOW,
      );

      expect(result.filed).toBe(0);
      expect(await readFacts(client, twin)).toEqual([]);
      expect((await readRuns(client, twin))[0]).toMatchObject({
        state: "filed",
        candidates: 2,
        filed: 0,
        below_threshold: 2,
        // The resolved reading is counted on its own axis whatever became
        // of it (#196), which is what makes «how often did looking pay»
        // answerable at all.
        resolved_reference: 1,
      });
      // ...AND THE REP IS TOLD NOTHING. Two drops, no post of any kind, and
      // the only line this twin holds is the binding's own entity create.
      expect(await countPosts(client, twin)).toBe(before);
      expect(await countLines(client, twin)).toBe(1);
    });
  });

  it("files a candidate EXACTLY at the gate — the boundary did not move (#218)", async () => {
    // `confidence < threshold`, so 0.80 crosses. Pinned beside the drop
    // above because the ticket that changed the VERDICT is the one most
    // likely to be read as having changed the NUMBER, and it did not.
    await withClient(async (client) => {
      const twin = freshTwin();
      await inScope(client, twin, twin.chat);
      await bindChat(client, twin, twin.chat, "Ferretería Fuentes");
      await seamMessage(client, twin, {
        messageId: "WAMID-1",
        text: "mándame 100 cajas",
        occurredAt: MORNING,
      });

      const result = await runDailyExtraction(
        depsFor(
          client,
          twin,
          extracted({
            fact_type: "OrderRequested",
            message_id: "WAMID-1",
            confidence: 0.8,
            item: "cajas",
            quantity: 100,
          }),
        ),
        NOW,
      );

      expect(result.filed).toBe(1);
      expect((await readRuns(client, twin))[0]).toMatchObject({
        candidates: 1,
        filed: 1,
        below_threshold: 0,
      });
    });
  });

  /**
   * #57's SECOND CASE, END TO END (tickets #66 and #76).
   *
   * «¿me mandas lo mismo del pedido pasado pero para la otra semana? Y si
   * me haces precio te pido más» is the message both tickets turn on. It
   * carries three different kinds of incompleteness and they end three
   * different ways:
   *
   *  - «lo mismo del pedido pasado» — a real ask whose GOODS live in a
   *    conversation the pass was not given. Read as
   *    `unresolved_reference`, so it is DROPPED (#76).
   *  - «para la otra semana» — a day with no resolvable referent. An
   *    absent optional field: filed as absent and READ BACK as «sin
   *    fecha», never asked about (#65, #70).
   *  - «Y si me haces precio te pido más» — a condition. NOT an order at
   *    any confidence and not a fact of any kind, so nothing is proposed
   *    for it at all.
   *
   * #66's fix half made the first one a QUESTION, and the rig showed why
   * that was wrong: «Te pidió lo mismo del pedido pasado» is unresolved
   * whichever way the rep answers, so the ask could not settle anything
   * and cost the rep work to no end. Dropping is the safe direction under
   * FR-31 and the honest one.
   *
   * The model's own share of that split is the prompt's, and extraction
   * prose is never asserted in CI (ADR-0028) — it is measured in the live
   * lane. What this pins is the SYSTEM's share: given that reading, the
   * day records nothing anywhere and says so in its own counts.
   */
  it("DROPS #57's «lo mismo del pedido pasado» — no fact, no question, no line — and counts the drop (#76)", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await inScope(client, twin, twin.chat);
      await bindChat(client, twin, twin.chat, "Materiales del Valle");
      await seamMessage(client, twin, {
        messageId: "WAMID-P2-03",
        text: "¿me mandas lo mismo del pedido pasado pero para la otra semana? Y si me haces precio te pido más",
        occurredAt: MORNING,
      });

      const result = await runDailyExtraction(
        depsFor(
          client,
          twin,
          extracted({
            fact_type: "OrderRequested",
            message_id: "WAMID-P2-03",
            // AS SURE AS THE CORPUS EVER GETS. #66 measured 83 of 88
            // candidates in [0.95, 1.00], so this is where the wrong
            // crossings live and where no threshold reaches.
            confidence: 0.95,
            reading: "unresolved_reference",
            item: "lo mismo del pedido pasado",
          }),
        ),
        NOW,
      );

      // NOT A FACT.
      expect(result.filed).toBe(0);
      expect(await readFacts(client, twin)).toEqual([]);

      // AND NOTHING REACHES THE REP — the whole of #76 in one assertion.
      // The binding's own post is all this twin has said (#218: the store
      // that held the ask is gone, so what is observable is the silence).
      expect(await countPosts(client, twin)).toBe(1);

      // NOT A DISCLOSURE LINE either. The binding disclosed an entity
      // create of its own (ADR-0003's amendment), so this counts the
      // subject kind a candidate would have produced.
      const lines = await client.query<{ n: string }>(
        `SELECT count(*) AS n FROM disclosure_lines
          WHERE twin_id = $1 AND subject_kind = 'fact'`,
        [twin.twinId],
      );
      expect(lines.rows[0]?.n).toBe("0");

      // ...AND COUNTED, which is what keeps the drop from being invisible.
      // #66 measured this route into existence and a build that dropped
      // silently would destroy its own measurement: the rate is how anyone
      // tells a build where this fires constantly from one where it never
      // fires at all.
      expect((await readRuns(client, twin))[0]).toMatchObject({
        state: "filed",
        candidates: 1,
        filed: 0,
        // Counted apart from the confidence route, which is untouched and
        // still turns its own candidates into questions.
        below_threshold: 0,
        unresolved_reference: 1,
        refused: 0,
      });
    });
  });

  it("carries ContactEstablished's identifiers normalized from the first row written (ADR-0034/0035)", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await inScope(client, twin, twin.chat);
      await bindChat(client, twin, twin.chat, "Ferretería Fuentes");
      await seamMessage(client, twin, {
        messageId: "WAMID-1",
        text: "mi correo es Ana@Ferreteria.MX, RFC fue930101-ab1, tel 81 8000 1111",
        occurredAt: MORNING,
      });

      await runDailyExtraction(
        depsFor(
          client,
          twin,
          extracted({
            fact_type: "ContactEstablished",
            message_id: "WAMID-1",
            confidence: 0.95,
            contact_name: "Ana",
            emails: ["Ana@Ferreteria.MX"],
            rfcs: ["fue930101-ab1"],
            phones: ["81 8000 1111"],
          }),
        ),
        NOW,
      );

      const facts = await readFacts(client, twin);
      expect(facts[0]?.payload).toEqual({
        contactName: "Ana",
        identifiers: {
          phones: ["+528180001111"],
          emails: ["ana@ferreteria.mx"],
          rfcs: ["FUE930101AB1"],
        },
      });
      expect(facts[0]?.disclosureText).toBe(
        "Guardé los datos de contacto de Ana: +528180001111, ana@ferreteria.mx, RFC FUE930101AB1.",
      );
    });
  });

  /**
   * MERGE, AT THE SEAM (ticket #55; ADR-0035, ADR-0036). Two of the rep's
   * conversations turn out to be one customer — the ordinary way that
   * happens, which is that both mention the same tax ID on an ordinary day.
   * Nobody is asked, nothing is disclosed, and the pass that filed the facts
   * is the thing that noticed.
   */
  it("merges two records the day's traffic shows are one customer, and tells nobody (ADR-0035/0036)", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const ctx = { db: client, dek: twin.dek };
      await inScope(client, twin, twin.chat, twin.otherChat);
      const first = await bindChat(client, twin, twin.chat, "Ferretería Fuentes");
      const second = await bindChat(
        client,
        twin,
        twin.otherChat,
        "Fuentes, Ferretería",
      );
      // The same message id in both conversations: the seam scopes its
      // external id by conversation, so each run resolves it to its own row
      // and the script does not depend on which chat is read first.
      for (const chatJid of [twin.chat, twin.otherChat]) {
        await seamMessage(client, twin, {
          messageId: "WAMID-CONTACT",
          text: "nuestro RFC es FUE850101-AB1",
          occurredAt: MORNING,
          chatJid,
        });
      }
      const contact = {
        fact_type: "ContactEstablished",
        message_id: "WAMID-CONTACT",
        confidence: 0.95,
        rfcs: ["FUE850101-AB1"],
      };

      const linesBefore = await countLines(client, twin);
      await runDailyExtraction(
        depsFor(client, twin, [...extracted(contact), ...extracted(contact)]),
        NOW,
      );

      // One customer, recorded twice, now resolving to one id.
      const edges = await readEntityMerges(ctx, twin.companyId);
      expect(edges).toHaveLength(1);
      expect(edges[0]).toMatchObject({
        status: "merged",
        performedBy: "machine",
        matchedOn: "rfc",
      });
      expect([edges[0]!.winnerEntityId, edges[0]!.loserEntityId].sort()).toEqual(
        [first, second].sort(),
      );
      const survivor = edges[0]!.winnerEntityId;
      for (const entityId of [first, second]) {
        await expect(
          resolveEntity(ctx, { companyId: twin.companyId, entityId }),
        ).resolves.toBe(survivor);
      }

      // Both records still stand, and both facts stayed where they were
      // filed — a merge moves nothing.
      expect(await countFiledEntities(ctx, twin.companyId)).toBe(2);
      const facts = await readFacts(client, twin);
      expect(facts.map((f) => f.entityId).sort()).toEqual([first, second].sort());

      // A MERGE IS NOT DISCLOSED (ADR-0003 as amended). The two facts got
      // their lines; the merge got none.
      expect(await countLines(client, twin)).toBe(linesBefore + 2);
      const merged = await client.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM disclosure_lines WHERE twin_id = $1 AND subject_kind NOT IN ('fact', 'entity_create')",
        [twin.twinId],
      );
      expect(merged.rows[0]!.n).toBe(0);
    });
  });

  it("reports what the ladder saw and left alone, so `kind_mismatch` is a number somebody can read (ticket #60)", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await inScope(client, twin, twin.chat, twin.otherChat);
      // A business and a person, as the model told them apart — the case
      // the phone rung's extra condition exists for, and the one that could
      // not arise while every entity was filed `person`.
      await bindChat(
        client,
        twin,
        twin.chat,
        "Ferretería Fuentes",
        "business",
      );
      await bindChat(
        client,
        twin,
        twin.otherChat,
        "Ana García",
        "person",
      );
      for (const chatJid of [twin.chat, twin.otherChat]) {
        await seamMessage(client, twin, {
          messageId: "WAMID-SWITCHBOARD",
          text: "marca al 55 5555 0000",
          occurredAt: MORNING,
          chatJid,
        });
      }
      const contact = {
        fact_type: "ContactEstablished",
        message_id: "WAMID-SWITCHBOARD",
        confidence: 0.95,
        phones: ["55 5555 0000"],
      };

      const result = await runDailyExtraction(
        depsFor(client, twin, [...extracted(contact), ...extracted(contact)]),
        NOW,
      );

      // The report used to be thrown away at this call site, so this count
      // had never been read by anybody; the run's last step counts it.
      expect(result).toMatchObject({ merged: 0, kindMismatches: 1 });
    });
  });

  /**
   * "AUTOMATIC" MEANS AUTOMATIC, not automatic-on-a-successful-filing
   * (ticket #55; ADR-0036). The identifiers that make two records one may
   * have reached the Ledger days ago — and a day whose every candidate fell
   * below the gate files nothing at all. If the ladder only ran when
   * something crossed, both of those days would leave a duplicate standing
   * with nobody ever looking again.
   */
  it("climbs the ladder on a day that files nothing, because the shared identifier crossed earlier", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const ctx = { db: client, dek: twin.dek };
      await inScope(client, twin, twin.chat, twin.otherChat);
      const first = await bindChat(client, twin, twin.chat, "Ferretería Fuentes");
      const second = await bindChat(
        client,
        twin,
        twin.otherChat,
        "Fuentes, Ferretería",
      );

      // YESTERDAY's crossing: both chats' contact facts are already filed,
      // outside every window this pass will read, and no merge has run.
      for (const [entityId, chatJid] of [
        [first, twin.chat],
        [second, twin.otherChat],
      ] as const) {
        const messageId = `WAMID-OLD-${entityId.slice(0, 8)}`;
        const sourceEventId = await seamMessage(client, twin, {
          messageId,
          text: "nuestro RFC es FUE850101-AB1",
          occurredAt: YESTERDAY,
          chatJid,
        });
        const outcome = await fileCandidateFact(ctx, {
          twinId: twin.twinId,
          entityId,
          sourceEventId,
          factType: "ContactEstablished",
          payload: { identifiers: { rfcs: ["FUE850101-AB1"] } },
          confidence: 0.95,
          reading: "stated",
          renderDisclosureLine: () => "Guardé sus datos de contacto.",
        });
        if (!outcome.filed) throw new Error(`fixture did not file: ${outcome.reason}`);
      }
      expect(await readEntityMerges(ctx, twin.companyId)).toEqual([]);

      // TODAY: both chats talk, and the model finds nothing worth filing.
      for (const chatJid of [twin.chat, twin.otherChat]) {
        await seamMessage(client, twin, {
          messageId: "WAMID-CHITCHAT",
          text: "buenos días",
          occurredAt: MORNING,
          chatJid,
        });
      }
      const before = await countLines(client, twin);
      const result = await runDailyExtraction(
        depsFor(client, twin, [...extracted(), ...extracted()]),
        NOW,
      );

      expect(result.filed).toBe(0);
      expect(await countLines(client, twin)).toBe(before);
      // ...and the duplicate is gone anyway.
      const edges = await readEntityMerges(ctx, twin.companyId);
      expect(edges).toHaveLength(1);
      expect(edges[0]!.matchedOn).toBe("rfc");
      await expect(
        resolveEntity(ctx, { companyId: twin.companyId, entityId: second }),
      ).resolves.toBe(edges[0]!.winnerEntityId);
    });
  });

  it("defers an in-scope but UNBOUND chat to the next run, with slice 2's binding proposal (FR-32, decision 13)", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await inScope(client, twin, twin.chat);
      await seamMessage(client, twin, {
        messageId: "WAMID-1",
        text: "mándeme 100 cajas",
        occurredAt: MORNING,
        pushName: "Sra. Garza",
      });

      // The model is scripted EMPTY: a deferred chat must never reach it.
      const result = await runDailyExtraction(depsFor(client, twin, []), NOW);

      expect(result).toMatchObject({ chats: 1, deferred: 1, extracted: 0, filed: 0 });
      expect((await readRuns(client, twin))[0]).toMatchObject({
        chat_jid: twin.chat,
        state: "deferred",
        candidates: 0,
        filed: 0,
      });
      expect(await readFacts(client, twin)).toEqual([]);

      // It got slice 2's proposal, in slice 2's own grammar.
      const notices = await client.query<{ kind: string }>(
        "SELECT kind FROM notices WHERE twin_id = $1 AND kind = 'binding_question'",
        [twin.twinId],
      );
      expect(notices.rows).toHaveLength(1);

      // ...and once the rep binds it, the NEXT run extracts it.
      await bindChat(client, twin, twin.chat, "Sra. Garza");
      const second = await runDailyExtraction(
        depsFor(
          client,
          twin,
          extracted({
            fact_type: "OrderRequested",
            message_id: "WAMID-1",
            confidence: 0.9,
            item: "cajas",
            quantity: 100,
          }),
        ),
        NOW,
      );
      expect(second).toMatchObject({ extracted: 1, filed: 1 });
      expect((await readRuns(client, twin))[0]).toMatchObject({
        state: "filed",
        filed: 1,
      });
      // Still ONE run row for the day: the state moved, a second row was
      // never written.
      expect(await readRuns(client, twin)).toHaveLength(1);
      // And it never asked a second time.
      const asked = await client.query<{ n: string }>(
        "SELECT count(*) AS n FROM notices WHERE twin_id = $1 AND kind = 'binding_question'",
        [twin.twinId],
      );
      expect(asked.rows[0]?.n).toBe("1");
    });
  });

  it("reads the DAY and nothing else: yesterday's traffic and backfilled history are both outside the window", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await inScope(client, twin, twin.chat);
      await bindChat(client, twin, twin.chat, "Ferretería Fuentes");
      await seamMessage(client, twin, {
        messageId: "WAMID-OLD",
        text: "lo de la semana pasada",
        occurredAt: YESTERDAY,
      });
      // The ceremony's own proposal event also sits on the 28th, so the
      // window's lower edge is doing real work here.
      await seamMessage(client, twin, {
        messageId: "WAMID-HIST",
        text: "historia sincronizada",
        occurredAt: MORNING,
        backfill: true,
      });
      await seamMessage(client, twin, {
        messageId: "WAMID-TODAY",
        text: "te las dejo en 4500",
        occurredAt: EVENING,
        fromMe: true,
      });

      const model = scriptedModel(
        extracted({
          fact_type: "QuoteGiven",
          message_id: "WAMID-TODAY",
          confidence: 0.9,
          item: "cajas",
          amount: 4500,
          currency: "MXN",
        }),
      );
      await runDailyExtraction(
        { ...depsFor(client, twin), harness: model.harness },
        NOW,
      );

      const turn = latestPromptOf(model.requests[0]!);
      expect(turn).toContain("WAMID-TODAY");
      expect(turn).not.toContain("WAMID-OLD");
      expect(turn).not.toContain("WAMID-HIST");
      expect((await readRuns(client, twin))[0]).toMatchObject({ messages: 1 });
    });
  });

  it("carries the evening after the run into the next day's window — a day-shaped window alone loses every evening", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await inScope(client, twin, twin.chat);
      await bindChat(client, twin, twin.chat, "Ferretería Fuentes");
      await seamMessage(client, twin, {
        messageId: "WAMID-EARLY",
        text: "buenos días",
        occurredAt: MORNING,
      });

      await runDailyExtraction(depsFor(client, twin, extracted()), NOW);

      // 22:10 on the rep's clock, AFTER the pass that settled the day.
      const late = new Date("2026-08-30T04:10:00Z");
      await seamMessage(client, twin, {
        messageId: "WAMID-LATE",
        text: "se lo confirmo para el sábado",
        occurredAt: late,
        fromMe: true,
      });

      // The rest of the 29th is not readable again on the 29th — one model
      // call per chat per day — so the model is scripted empty here.
      const sameDay = await runDailyExtraction(depsFor(client, twin, []), NOW);
      expect(sameDay).toMatchObject({ extracted: 0, settled: true });

      // The 30th picks it up, and its window starts where the 29th's ended.
      const tomorrow = new Date("2026-08-31T03:30:00Z");
      const model = scriptedModel(
        extracted({
          fact_type: "DatePromised",
          message_id: "WAMID-LATE",
          confidence: 0.9,
          commitment: "que entregas el sábado",
        }),
      );
      const next = await runDailyExtraction(
        { ...depsFor(client, twin), harness: model.harness },
        tomorrow,
      );
      expect(next).toMatchObject({ extracted: 1, filed: 1 });
      const turn = latestPromptOf(model.requests[0]!);
      expect(turn).toContain("WAMID-LATE");
      expect(turn).not.toContain("WAMID-EARLY");

      const runs = await readRuns(client, twin);
      expect(runs).toHaveLength(2);
      expect(runs[1]?.["window_start"]).toEqual(new Date(NOW.getTime() - 60_000));
      expect(runs[1]?.["window_end"]).toEqual(
        new Date(tomorrow.getTime() - 60_000),
      );
    });
  });

  it("never reaches further back than a week — a rig that was off for a month is a backfill, not a daily pass", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await inScope(client, twin, twin.chat);
      await bindChat(client, twin, twin.chat, "Ferretería Fuentes");
      await seamMessage(client, twin, {
        messageId: "WAMID-1",
        text: "hola",
        occurredAt: MORNING,
      });
      await runDailyExtraction(depsFor(client, twin, extracted()), NOW);

      // A month later — 21:30 on the rep's clock on 28 September — with
      // the watermark still back on 29 August.
      const muchLater = new Date("2026-09-29T03:30:00Z");
      await seamMessage(client, twin, {
        messageId: "WAMID-LATER",
        text: "seguimos?",
        occurredAt: new Date("2026-09-29T01:00:00Z"),
      });
      await runDailyExtraction(depsFor(client, twin, extracted()), muchLater);

      const runs = await readRuns(client, twin);
      expect(runs).toHaveLength(2);
      // Seven days back, not the month-old watermark.
      expect(runs[1]?.["window_start"]).toEqual(new Date("2026-09-21T06:00:00Z"));
    });
  });

  it("recovers a run that was claimed and never filed, across a midnight (Codex r1)", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await inScope(client, twin, twin.chat);
      await bindChat(client, twin, twin.chat, "Ferretería Fuentes");
      await seamMessage(client, twin, {
        messageId: "WAMID-CRASHED",
        text: "te las dejo en 4500",
        occurredAt: EVENING,
        fromMe: true,
      });

      // The crash: the pass claimed the 29th and died before filing. The
      // run key is (twin, chat, day), so the 30th's pass never looks at
      // this row under its own key — the WINDOW it recorded is the only
      // thing that says the 29th is still owed.
      await client.query(
        `INSERT INTO extraction_runs
           (twin_id, chat_jid, extraction_day, state, window_start, window_end)
         VALUES ($1, $2, '2026-08-29', 'submitted',
                 '2026-08-29T06:00:00Z', '2026-08-30T03:29:00Z')`,
        [twin.twinId, twin.chat],
      );

      const tomorrow = new Date("2026-08-31T03:30:00Z");
      const model = scriptedModel(
        extracted({
          fact_type: "QuoteGiven",
          message_id: "WAMID-CRASHED",
          confidence: 0.9,
          item: "cajas",
          amount: 4500,
          currency: "MXN",
        }),
      );
      const result = await runDailyExtraction(
        { ...depsFor(client, twin), harness: model.harness },
        tomorrow,
      );

      expect(result).toMatchObject({ extracted: 1, filed: 1 });
      const turn = latestPromptOf(model.requests[0]!);
      expect(turn).toContain("WAMID-CRASHED");
      const runs = await readRuns(client, twin);
      expect(runs[1]?.["window_start"]).toEqual(new Date("2026-08-29T06:00:00Z"));

      // ...and the debt is PAID, not re-owed. The abandoned Aug 29 row is
      // still non-filed, and a watermark that preferred it outright would
      // re-read and re-file the same message every day after (Codex r2).
      const dayAfter = new Date("2026-09-01T03:30:00Z");
      const third = await runDailyExtraction(depsFor(client, twin, []), dayAfter);
      expect(third).toMatchObject({ extracted: 0, filed: 0 });
      expect(await readFacts(client, twin)).toHaveLength(1);
    });
  });

  it("recovers a chat deferred yesterday and bound this morning — the orphan rule holds across a midnight", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await inScope(client, twin, twin.chat);
      await seamMessage(client, twin, {
        messageId: "WAMID-ORPHAN",
        text: "mándeme 100 cajas",
        occurredAt: EVENING,
        pushName: "Sra. Garza",
      });

      const deferredDay = await runDailyExtraction(depsFor(client, twin, []), NOW);
      expect(deferredDay).toMatchObject({ deferred: 1, extracted: 0 });

      // The rep answers overnight.
      await bindChat(client, twin, twin.chat, "Sra. Garza");

      const tomorrow = new Date("2026-08-31T03:30:00Z");
      const model = scriptedModel(
        extracted({
          fact_type: "OrderRequested",
          message_id: "WAMID-ORPHAN",
          confidence: 0.9,
          item: "cajas",
          quantity: 100,
        }),
      );
      const next = await runDailyExtraction(
        { ...depsFor(client, twin), harness: model.harness },
        tomorrow,
      );

      expect(next).toMatchObject({ extracted: 1, filed: 1 });
      const turn = latestPromptOf(model.requests[0]!);
      // Yesterday's message, which the deferred run never read.
      expect(turn).toContain("WAMID-ORPHAN");

      // And the deferred row's debt is paid once, not owed forever.
      const dayAfter = new Date("2026-09-01T03:30:00Z");
      const third = await runDailyExtraction(depsFor(client, twin, []), dayAfter);
      expect(third).toMatchObject({ extracted: 0, filed: 0 });
      expect(await readFacts(client, twin)).toHaveLength(1);
    });
  });

  it("cuts its window short of the caller's clock, so a seam row committing mid-pass is next window's", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await inScope(client, twin, twin.chat);
      await bindChat(client, twin, twin.chat, "Ferretería Fuentes");
      await seamMessage(client, twin, {
        messageId: "WAMID-SETTLED",
        text: "buenas",
        occurredAt: MORNING,
      });
      // Thirty seconds before the pass runs: inside `now`, inside the
      // settling lag, so this pass must not claim to have read it.
      await seamMessage(client, twin, {
        messageId: "WAMID-INFLIGHT",
        text: "y el sábado?",
        occurredAt: new Date(NOW.getTime() - 30_000),
      });

      const model = scriptedModel(extracted());
      await runDailyExtraction(
        { ...depsFor(client, twin), harness: model.harness },
        NOW,
      );

      const turn = latestPromptOf(model.requests[0]!);
      expect(turn).toContain("WAMID-SETTLED");
      expect(turn).not.toContain("WAMID-INFLIGHT");
      const runs = await readRuns(client, twin);
      expect(runs[0]?.["window_end"]).toEqual(new Date(NOW.getTime() - 60_000));
    });
  });

  it("is idempotent per (twin, chat, day): a second run files nothing and never makes a second call", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await inScope(client, twin, twin.chat);
      await bindChat(client, twin, twin.chat, "Ferretería Fuentes");
      await seamMessage(client, twin, {
        messageId: "WAMID-1",
        text: "te las dejo en 4500",
        occurredAt: EVENING,
        fromMe: true,
      });
      const facts = extracted({
        fact_type: "QuoteGiven",
        message_id: "WAMID-1",
        confidence: 0.9,
        item: "cajas",
        amount: 4500,
        currency: "MXN",
      });

      await runDailyExtraction(depsFor(client, twin, facts), NOW);
      // Scripted EMPTY: a second pass over a settled day must not call the
      // model at all, so a call would fail loudly here.
      const second = await runDailyExtraction(depsFor(client, twin, []), NOW);

      expect(second).toMatchObject({ extracted: 0, filed: 0, settled: true });
      expect(await readFacts(client, twin)).toHaveLength(1);
      expect(await readRuns(client, twin)).toHaveLength(1);
    });
  });

  it("fences a claimant that woke after another pass recovered its window — no fact is filed twice (Codex r3)", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await inScope(client, twin, twin.chat);
      await bindChat(client, twin, twin.chat, "Ferretería Fuentes");
      await seamMessage(client, twin, {
        messageId: "WAMID-RACED",
        text: "te las dejo en 4500",
        occurredAt: EVENING,
        fromMe: true,
      });
      const quote = {
        fact_type: "QuoteGiven",
        message_id: "WAMID-RACED",
        confidence: 0.9,
        item: "cajas",
        amount: 4500,
        currency: "MXN",
      };

      // The stale claimant: a pass that claimed the 29th and is still
      // inside its model call. Its row stays `submitted` forever, so a
      // state re-check alone would let it file when it wakes.
      await client.query(
        `INSERT INTO extraction_runs
           (twin_id, chat_jid, extraction_day, state, window_start, window_end)
         VALUES ($1, $2, '2026-08-29', 'submitted',
                 '2026-08-29T06:00:00Z', '2026-08-30T03:29:00Z')`,
        [twin.twinId, twin.chat],
      );

      // The 30th's pass recovers the window and files it.
      const tomorrow = new Date("2026-08-31T03:30:00Z");
      const recovery = await runDailyExtraction(
        depsFor(client, twin, extracted(quote)),
        tomorrow,
      );
      expect(recovery).toMatchObject({ filed: 1 });

      // Now the stale claimant wakes with the SAME candidates and the same
      // window it claimed. Its own row still says `submitted`.
      const stale = await runDailyExtraction(
        depsFor(client, twin, extracted(quote)),
        new Date("2026-08-30T03:29:00Z"),
      );
      expect(stale).toMatchObject({ filed: 0 });
      expect(await readFacts(client, twin)).toHaveLength(1);
    });
  });

  it("re-reads only the OWED tail of a recovery window — a covered prefix is never filed twice (Codex r2 on #53)", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await inScope(client, twin, twin.chat);
      await bindChat(client, twin, twin.chat, "Ferretería Fuentes");
      // One message a filed run already read...
      await seamMessage(client, twin, {
        messageId: "WAMID-COVERED",
        text: "te las dejo en 4500",
        occurredAt: MORNING,
        fromMe: true,
      });
      // ...and one it did not.
      await seamMessage(client, twin, {
        messageId: "WAMID-OWED",
        text: "y el sábado te confirmo",
        occurredAt: EVENING,
        fromMe: true,
      });
      const covered = {
        fact_type: "QuoteGiven",
        message_id: "WAMID-COVERED",
        confidence: 0.9,
        item: "cajas",
        amount: 4500,
        currency: "MXN",
      };
      const owed = {
        fact_type: "DatePromised",
        message_id: "WAMID-OWED",
        confidence: 0.9,
        commitment: "que entregas el sábado",
      };

      // The interleaving, exactly: this pass computes its window and reads
      // BOTH messages, and only THEN — while it is inside its model call,
      // holding no transaction and no lock — another pass files the morning
      // and settles. The watermark cannot help; it was computed before that
      // row existed.
      const racing = scriptedModel(extracted(covered, owed), {
        onRequest: async () => {
          await client.query(
            `INSERT INTO extraction_runs
               (twin_id, chat_jid, extraction_day, state, window_start,
                window_end, settled_at)
             VALUES ($1, $2, '2026-08-28', 'filed',
                     '2026-08-29T06:00:00Z', '2026-08-29T18:00:00Z', now())
             ON CONFLICT (twin_id, chat_jid, extraction_day) WHERE NOT steering
             DO NOTHING`,
            [twin.twinId, twin.chat],
          );
        },
      });
      const recovery = await runDailyExtraction(
        { ...depsFor(client, twin), harness: racing.harness },
        NOW,
      );

      // Only the OWED one crossed. Re-filing the covered prefix would put a
      // second copy of one claim into an append-only store — and, when the
      // model reads the same sentence as a different KIND the second time,
      // would ask the rep about it twice under two identities.
      expect(recovery).toMatchObject({ filed: 1 });
      const facts = await readFacts(client, twin);
      expect(facts.map((f) => f.factType)).toEqual(["DatePromised"]);
    });
  });

  it("drops a candidate citing a message that is not in the window it was shown — a model cannot invent provenance", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await inScope(client, twin, twin.chat);
      await bindChat(client, twin, twin.chat, "Ferretería Fuentes");
      await seamMessage(client, twin, {
        messageId: "WAMID-1",
        text: "todo bien",
        occurredAt: MORNING,
      });

      await runDailyExtraction(
        depsFor(
          client,
          twin,
          extracted({
            fact_type: "DatePromised",
            message_id: "WAMID-INVENTED",
            confidence: 0.99,
            commitment: "que entregas el sábado",
          }),
        ),
        NOW,
      );

      expect(await readFacts(client, twin)).toEqual([]);
      expect((await readRuns(client, twin))[0]).toMatchObject({
        candidates: 1,
        filed: 0,
        refused: 1,
      });
    });
  });

  it("refuses a fact type outside the closed set — the vocabulary is the aperture's, and a model asking for one changes nothing", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await inScope(client, twin, twin.chat);
      await bindChat(client, twin, twin.chat, "Ferretería Fuentes");
      await seamMessage(client, twin, {
        messageId: "WAMID-1",
        text: "siempre pide los viernes",
        occurredAt: MORNING,
      });

      await runDailyExtraction(
        depsFor(
          client,
          twin,
          extracted({
            // `CustomerPattern` stood here until ticket #61 gave it a
            // shape; the claim is about the SET being closed, so it needs
            // a value outside it.
            fact_type: "RepTactic",
            message_id: "WAMID-1",
            confidence: 0.99,
            item: "pide los viernes",
          }),
        ),
        NOW,
      );

      expect(await readFacts(client, twin)).toEqual([]);
      expect((await readRuns(client, twin))[0]).toMatchObject({ refused: 1 });
    });
  });

  /**
   * `CustomerPattern` END TO END (ticket #61) — the type whose false
   * positives are aperture BREACHES rather than noise, driven the way a
   * real day drives it: model output in, a Ledger row and a rep-readable
   * line out.
   */
  describe("a customer's stated preference crosses; a rep's own note never does (#61)", () => {
    it("files what the customer said about themselves, and copies nothing from the message", async () => {
      await withClient(async (client) => {
        const twin = freshTwin();
        await inScope(client, twin, twin.chat);
        await bindChat(client, twin, twin.chat, "Ferretería Fuentes");
        await seamMessage(client, twin, {
          messageId: "WAMID-1",
          text: "nomás recibimos material antes de las 2, después ya no hay quien descargue",
          occurredAt: MORNING,
        });

        await runDailyExtraction(
          depsFor(
            client,
            twin,
            extracted({
              fact_type: "CustomerPattern",
              message_id: "WAMID-1",
              confidence: 0.95,
              pattern: "solo recibe material antes de las 2 de la tarde",
            }),
          ),
          NOW,
        );

        expect(await readFacts(client, twin)).toMatchObject([
          {
            factType: "CustomerPattern",
            payloadVersion: 1,
            // ONE FIELD, read back the way a reader outside the aperture
            // must: nothing from the message rides along (ADR-0040).
            payload: { pattern: "solo recibe material antes de las 2 de la tarde" },
          },
        ]);

        const lines = await client.query<{ rendered_text: string }>(
          `SELECT rendered_text FROM disclosure_lines
            WHERE twin_id = $1 AND subject_kind = 'fact'`,
          [twin.twinId],
        );
        expect(lines.rows[0]?.rendered_text).toBe(
          "Te dijo que solo recibe material antes de las 2 de la tarde.",
        );
      });
    });

    it("a market observation has nowhere entity-less to land, so a wrongly-filed one is an ordinary false positive", async () => {
      // THE ORPHAN RULE ON THE PRODUCTION PATH (FR-32, ADR-0035; Codex r1
      // was right that the aperture-level test did not exercise it).
      //
      // «en diciembre se pone flojo la construcción» is ADR-0035's own
      // example of an observation with NO entity. What the ticket asks of
      // this build is that it introduces no non-entity slot, and this is
      // what that looks like from the production side: the pass supplies
      // the bound chat's entity to every candidate, the store's composite
      // FK requires one, and a wrongly-filed observation is therefore an
      // ordinary entity-attached FALSE POSITIVE — which the corpus labels
      // silent (`PD-01`) so that filing it costs precision.
      //
      // THIS ASSERTS THE COST, NOT THE BEHAVIOUR (Codex r2's framing point
      // is fair). Nothing here says filing it is right: `PD-01` is labelled
      // SILENT in the corpus with FR-32 in its reason, so a crossing on it
      // is a false positive that the `CustomerPattern` row reports. What
      // the test pins is the structural claim the ticket actually makes —
      // there is no entity-less slot, so the wrong outcome is a
      // misattributed fact the rep can retract inside the window rather
      // than an unreachable row nobody can see or correct.
      //
      // WHAT IS DELIBERATELY NOT BUILT is a route that turns it into a
      // question instead. ADR-0039 does admit an entity-ATTACHMENT ask, and
      // Codex r2 is right that this one could be worded to settle an
      // attachment — but settling it the wrong way is the problem. A «si»
      // to «¿esto es de Constructora Vega?» files «Te dijo que diciembre es
      // temporada baja en la construcción» on that cliente's timeline: the
      // same trade-level sentence, on the same wrong entity, now with the
      // rep's own hand on it. The question would launder the record rather
      // than settle it, and it would spend the rep's attention on a
      // classification the twin could not make (ADR-0036: "whether the
      // question exists because the USER needs to decide, or because WE
      // could not"). It would also need the model to declare "this has no
      // customer subject" on the wire — and a model that can say that
      // reliably is one that can record nothing reliably, which is what the
      // prompt already asks for.
      await withClient(async (client) => {
        const twin = freshTwin();
        await inScope(client, twin, twin.chat);
        const entityId = await bindChat(
          client,
          twin,
          twin.chat,
          "Constructora Vega",
        );
        await seamMessage(client, twin, {
          messageId: "WAMID-1",
          text: "en diciembre se pone flojo todo esto de la construcción",
          occurredAt: MORNING,
        });

        await runDailyExtraction(
          depsFor(
            client,
            twin,
            extracted({
              fact_type: "CustomerPattern",
              message_id: "WAMID-1",
              confidence: 1,
              pattern: "diciembre es temporada baja en la construcción",
            }),
          ),
          NOW,
        );

        // Read back through the writer's own read surface, like every
        // other assertion here: nothing outside `packages/aperture` names a
        // Ledger table (`sole-writer.test.ts`).
        const filed = await readFacts(client, twin);
        expect(filed).toHaveLength(1);
        // Attached, to exactly one entity, and it is the bound chat's —
        // `entityId` is non-nullable on the read shape because it is
        // non-nullable in the store.
        expect(filed[0]!.entityId).toBe(entityId);
        expect(filed[0]!.factType).toBe("CustomerPattern");
      });
    });

    it("refuses one read in the rep's own message, however confident the model is", async () => {
      // THE APERTURE BREACH, in the shape the precision corpus carries it:
      // a selling tactic the rep typed into a CUSTOMER chat, where
      // ADR-0033's enumeration does not reach because the chat is not the
      // twin thread. The authorship fence is what stops it, in code, off
      // the flag the plane stamped — and before #61 only prompt wording
      // did.
      await withClient(async (client) => {
        const twin = freshTwin();
        await inScope(client, twin, twin.chat);
        await bindChat(client, twin, twin.chat, "Ferretería Fuentes");
        await seamMessage(client, twin, {
          messageId: "WAMID-1",
          text: "a este cliente siempre hay que darle el precio alto primero, luego negocia",
          occurredAt: MORNING,
          fromMe: true,
        });
        // The binding ceremony already disclosed the entity create; what
        // must not move is the count after extraction runs.
        const before = await countLines(client, twin);

        await runDailyExtraction(
          depsFor(
            client,
            twin,
            extracted({
              fact_type: "CustomerPattern",
              message_id: "WAMID-1",
              confidence: 1,
              pattern: "hay que darle el precio alto primero",
            }),
          ),
          NOW,
        );

        expect(await readFacts(client, twin)).toEqual([]);
        expect(await countLines(client, twin)).toBe(before);
        expect((await readRuns(client, twin))[0]).toMatchObject({
          candidates: 1,
          filed: 0,
          // A refusal, never a question: the rep is not asked to confirm a
          // sentence the aperture could not have filed either way.
          below_threshold: 0,
          refused: 1,
        });
      });
    });
  });

  it("mints nothing but facts: poisoned model output produces no tap, no binding, no entity and no merge (ADR-0003/0006/0035)", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await inScope(client, twin, twin.chat);
      const entityId = await bindChat(client, twin, twin.chat, "Ferretería Fuentes");
      // The rep's own «va» sits on the seam — the exact row a class-2 act
      // is evidenced by. The poisoned candidate cites it and claims to be
      // a rep act.
      const repVa = await seamMessage(client, twin, {
        messageId: "WAMID-VA",
        text: "va",
        occurredAt: EVENING,
        chatJid: SELF_CHAT,
        fromMe: true,
      });
      await seamMessage(client, twin, {
        messageId: "WAMID-1",
        text: "confirmado",
        occurredAt: MORNING,
      });

      const ctx = { db: client, dek: twin.dek };
      const before = {
        taps: (await client.query<{ n: string }>("SELECT count(*) AS n FROM taps"))
          .rows[0]!.n,
        entities: await countFiledEntities(ctx, twin.companyId),
      };

      await runDailyExtraction(
        depsFor(
          client,
          twin,
          extracted(
            {
              fact_type: "DatePromised",
              message_id: "WAMID-VA",
              confidence: 0.99,
              commitment: "que el rep autorizó el envío",
            },
            {
              fact_type: "ContactEstablished",
              message_id: "WAMID-1",
              confidence: 0.99,
              emails: ["nuevo@cliente.mx"],
            },
          ),
        ),
        NOW,
      );

      const after = {
        taps: (await client.query<{ n: string }>("SELECT count(*) AS n FROM taps"))
          .rows[0]!.n,
        entities: await countFiledEntities(ctx, twin.companyId),
      };
      expect(after).toEqual(before);
      // The «va» is untouched — no disposition, no binding, no send.
      const marked = await client.query<{ n: string }>(
        "SELECT count(*) AS n FROM wa_event_processing WHERE event_id = $1",
        [repVa],
      );
      expect(marked.rows[0]?.n).toBe("0");
      expect(twin.bundle.listChatBindings()).toHaveLength(1);
      // The candidate citing the twin thread was never in the window it
      // was shown, so it files nothing; the customer-chat one is a fact.
      const facts = await readFacts(client, twin);
      expect(facts).toHaveLength(1);
      expect(facts[0]).toMatchObject({
        factType: "ContactEstablished",
        entityId,
      });
    });
  });

  it("puts the day's facts into the day's disclosure, grouped by customer and dated «su chat»", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await inScope(client, twin, twin.chat);
      await bindChat(client, twin, twin.chat, "Ferretería Fuentes");
      await seamMessage(client, twin, {
        messageId: "WAMID-1",
        text: "sí, para el sábado",
        occurredAt: EVENING,
        fromMe: true,
      });

      await runDailyExtraction(
        depsFor(
          client,
          twin,
          extracted({
            fact_type: "DatePromised",
            message_id: "WAMID-1",
            confidence: 0.92,
            commitment: "que tienes disponible para el sábado",
          }),
        ),
        NOW,
      );
      const posted = await runDailyDisclosure(
        depsFor(client, twin),
        NOW,
      );

      expect(posted).toMatchObject({ posted: true });
      const notice = await client.query<{ content_enc: Buffer }>(
        "SELECT content_enc FROM notices WHERE twin_id = $1 AND kind = 'daily_disclosure'",
        [twin.twinId],
      );
      const text = Buffer.from(
        twin.dek.decrypt(notice.rows[0]!.content_enc),
      ).toString("utf8");
      expect(text).toContain("*Ferretería Fuentes*");
      expect(text).toContain(
        "Le confirmaste que tienes disponible para el sábado — sin fecha. (su chat, hoy 19:23)",
      );
      // The entity create rides the same post — the disclosure's
      // completeness claim is about everything that crossed (FR-38).
      expect(text).toContain("Lo di de alta como cliente.");
    });
  });

  /**
   * THE #57 REGRESSION, at the seam (ticket #65).
   *
   * The steering session's own case, reproduced end to end: the customer
   * asks for «el lunes», the model files `dueOn: 2026-09-01` — a Tuesday,
   * because Monday was 2026-08-31 — and the rep reads the daily disclosure.
   * Before #65 that disclosure line said «Le confirmaste enviar los
   * bultos.» and the
   * fact finalized 24 hours later holding the wrong day, because there was
   * nothing in the line to correct.
   *
   * What is under test is the whole path, not the renderer: the date must
   * survive from the model's payload, through the aperture's shaping, into
   * the stored `rendered_text`, and out into the post the rep actually
   * reads. And it must be the SAME text in both places — a disclosure line
   * is stored as rendered text carrying no version, so what the rep was
   * told can never be re-rendered from a changed template (ADR-0034).
   */
  it("carries the promised date into the line the rep reads, so the #57 wrong date is correctable", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await inScope(client, twin, twin.chat);
      await bindChat(client, twin, twin.chat, "Ferretería Fuentes");
      await seamMessage(client, twin, {
        messageId: "WAMID-1",
        text: "sale, te los mando para el lunes",
        occurredAt: EVENING,
        fromMe: true,
      });

      await runDailyExtraction(
        depsFor(
          client,
          twin,
          extracted({
            fact_type: "DatePromised",
            message_id: "WAMID-1",
            confidence: 0.92,
            commitment: "enviar los bultos",
            // What the model actually filed on 2026-08-29 for «el lunes».
            due_on: "2026-09-01",
          }),
        ),
        NOW,
      );
      await runDailyDisclosure(
        depsFor(client, twin),
        NOW,
      );

      const notice = await client.query<{ content_enc: Buffer }>(
        "SELECT content_enc FROM notices WHERE twin_id = $1 AND kind = 'daily_disclosure'",
        [twin.twinId],
      );
      const text = Buffer.from(
        twin.dek.decrypt(notice.rows[0]!.content_enc),
      ).toString("utf8");
      // The rep asked for Monday and the twin reads back Tuesday. THAT is
      // the correction signal ADR-0004's window and ADR-0016's ground
      // truth both depend on.
      //
      // Asserted as the WHOLE POST, because the other half of the ticket
      // is that shape D survives: the heading, the counterparty block, the
      // continuous numbering and the provenance suffix are exactly what #48's
      // prototype gate settled. The line got longer and the sentences around
      // the block are the twin's own (#198); the STRUCTURE is unmoved.
      expect(text).toBe(
        `✳️ *Hoy agregué 2 datos al registro.*

fue un día tranquilo, casi todo de un solo cliente

*Ferretería Fuentes*
1. Lo di de alta como cliente. (tú lo confirmaste, hoy 09:20)
2. Le confirmaste enviar los bultos — martes 1 de septiembre de 2026. (su chat, hoy 19:23)

si algo quedó mal respóndeme aquí citando este mensaje y dime cuál`,
      );

      // Stored once, as rendered text (ADR-0034): the line in the store is
      // character-for-character the line in the post, so nothing later
      // re-renders what the rep was told.
      const stored = await client.query<{ rendered_text: string }>(
        `SELECT rendered_text FROM disclosure_lines
          WHERE twin_id = $1 AND subject_kind = 'fact'`,
        [twin.twinId],
      );
      expect(stored.rows.map((row) => row.rendered_text)).toEqual([
        "Le confirmaste enviar los bultos — martes 1 de septiembre de 2026.",
      ]);
      expect(text).toContain(stored.rows[0]!.rendered_text);
    });
  });

  /**
   * The same defect on the commercial types (#57 finding 2): «quantity and
   * total are rendered, the item is «producto (no especificado)»». A field
   * the payload does not hold is stated as absent, never omitted and never
   * defaulted — a missing currency is unknown, not MXN (ADR-0034).
   */
  it("says which commercial fields the Ledger does not hold, in the line the rep reads", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await inScope(client, twin, twin.chat);
      await bindChat(client, twin, twin.chat, "Ferretería Fuentes");
      await seamMessage(client, twin, {
        messageId: "WAMID-1",
        text: "ah y súmale unas 20 más",
        occurredAt: EVENING,
      });

      await runDailyExtraction(
        depsFor(
          client,
          twin,
          extracted({
            fact_type: "OrderRequested",
            message_id: "WAMID-1",
            confidence: 0.92,
            item: "producto (no especificado)",
            quantity: 20,
            unit: "bultos",
            // No amount and no currency: the aperture stores neither, so
            // the line must say the price is not there.
          }),
        ),
        NOW,
      );
      await runDailyDisclosure(
        depsFor(client, twin),
        NOW,
      );

      const notice = await client.query<{ content_enc: Buffer }>(
        "SELECT content_enc FROM notices WHERE twin_id = $1 AND kind = 'daily_disclosure'",
        [twin.twinId],
      );
      const text = Buffer.from(
        twin.dek.decrypt(notice.rows[0]!.content_enc),
      ).toString("utf8");
      expect(text).toContain(
        "Te pidió 20 bultos de producto (no especificado) — sin precio, sin fecha.",
      );
    });
  });

  /**
   * THE #57 ORDER CASE, end to end (ticket #70).
   *
   * «te pido 100 cajas para el lunes» is ONE customer message carrying an
   * order and the day it is wanted for. Before this ticket the day had
   * nowhere to go and was dropped in silence: `DatePromised` is the REP's
   * commitment — the corpus labels a customer-proposed date silent so that
   * no crossing files a promise before the rep made one — and the
   * commercial payload had no date field at all. #57 finding 2 read it
   * from the rep's side: on the orders, «no date appears anywhere».
   *
   * The whole path is what is under test, not the renderer: the day must
   * survive the model's `due_on`, the aperture's shaping into
   * `requestedFor`, the v2 stamp, the stored `rendered_text`, and the post
   * the rep actually reads — and be the SAME text in both places, since a
   * disclosure line is stored as rendered text that is never re-rendered
   * (ADR-0034).
   *
   * The scripted day is the WRONG day on purpose, exactly as #65's
   * `DatePromised` regression is: the session ran on Saturday 2026-08-29,
   * so «el lunes» was 2026-08-31 and the model filed 2026-09-01. The rep
   * reads «martes» against a Monday they remember, inside the window that
   * exists to catch it (ADR-0004). WHICH day it is remains extraction
   * precision (#59); that the rep can SEE it is this ticket.
   */
  it("carries a dated order's day into the line the rep reads, so the #57 dateless order is correctable", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await inScope(client, twin, twin.chat);
      await bindChat(client, twin, twin.chat, "Ferretería Fuentes");
      await seamMessage(client, twin, {
        messageId: "WAMID-1",
        text: "te pido 100 cajas para el lunes",
        occurredAt: EVENING,
      });

      await runDailyExtraction(
        depsFor(
          client,
          twin,
          extracted({
            fact_type: "OrderRequested",
            message_id: "WAMID-1",
            confidence: 0.92,
            item: "cajas",
            quantity: 100,
            // What the model filed on 2026-08-29 for «el lunes»: a Tuesday.
            due_on: "2026-09-01",
          }),
        ),
        NOW,
      );
      await runDailyDisclosure(
        depsFor(client, twin),
        NOW,
      );

      // The day crossed the wall as a field of the order, stamped v2 — and
      // as ONE fact: no second row claims the rep promised anything, which
      // is the whole reason the day is not a `DatePromised`.
      const facts = await readFacts(client, twin);
      expect(facts).toHaveLength(1);
      expect(facts[0]).toMatchObject({
        factType: "OrderRequested",
        payloadVersion: 2,
      });
      expect(facts[0]?.payload).toEqual({
        item: "cajas",
        quantity: 100,
        requestedFor: "2026-09-01",
      });

      const notice = await client.query<{ content_enc: Buffer }>(
        "SELECT content_enc FROM notices WHERE twin_id = $1 AND kind = 'daily_disclosure'",
        [twin.twinId],
      );
      const text = Buffer.from(
        twin.dek.decrypt(notice.rows[0]!.content_enc),
      ).toString("utf8");
      // Asserted as the WHOLE POST: the other half of the ticket is that
      // shape D survives — heading, counterparty block, continuous
      // numbering and provenance suffix are #48's prototype gate. The line
      // got longer and the sentences around the block are the twin's own
      // (#198); the structure is unmoved, and the rep still corrects the
      // order by replying and saying which line was wrong.
      expect(text).toBe(
        `✳️ *Hoy agregué 2 datos al registro.*

fue un día tranquilo, casi todo de un solo cliente

*Ferretería Fuentes*
1. Lo di de alta como cliente. (tú lo confirmaste, hoy 09:20)
2. Te pidió 100 cajas para el martes 1 de septiembre de 2026 — sin precio. (su chat, hoy 19:23)

si algo quedó mal respóndeme aquí citando este mensaje y dime cuál`,
      );

      const stored = await client.query<{ rendered_text: string }>(
        `SELECT rendered_text FROM disclosure_lines
          WHERE twin_id = $1 AND subject_kind = 'fact'`,
        [twin.twinId],
      );
      expect(stored.rows.map((row) => row.rendered_text)).toEqual([
        "Te pidió 100 cajas para el martes 1 de septiembre de 2026 — sin precio.",
      ]);
      expect(text).toContain(stored.rows[0]!.rendered_text);
    });
  });

  /**
   * The other half of the same rule (ADR-0034): an order whose message
   * names no day is given none, and the rep is TOLD so. «sin fecha» states
   * the absence — it never stands in for a value, and it is what lets a
   * rep tell a date the Ledger never held from one it holds correctly.
   *
   * The `item` slot is the model's own words and may itself carry a day,
   * which is exactly why the absence has to be said out loud rather than
   * left to the sentence.
   */
  it("says «sin fecha» on an undated order rather than defaulting one", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await inScope(client, twin, twin.chat);
      await bindChat(client, twin, twin.chat, "Ferretería Fuentes");
      await seamMessage(client, twin, {
        messageId: "WAMID-1",
        text: "te pido 100 cajas",
        occurredAt: EVENING,
      });

      await runDailyExtraction(
        depsFor(
          client,
          twin,
          extracted({
            fact_type: "OrderRequested",
            message_id: "WAMID-1",
            confidence: 0.92,
            item: "cajas",
            quantity: 100,
          }),
        ),
        NOW,
      );
      await runDailyDisclosure(
        depsFor(client, twin),
        NOW,
      );

      // Absent, not null and not a guess at the day the message was sent.
      const facts = await readFacts(client, twin);
      expect(facts[0]?.payload).toEqual({ item: "cajas", quantity: 100 });

      const notice = await client.query<{ content_enc: Buffer }>(
        "SELECT content_enc FROM notices WHERE twin_id = $1 AND kind = 'daily_disclosure'",
        [twin.twinId],
      );
      const text = Buffer.from(
        twin.dek.decrypt(notice.rows[0]!.content_enc),
      ).toString("utf8");
      expect(text).toContain("Te pidió 100 cajas — sin precio, sin fecha.");
    });
  });

  it("is fired by the clock at the seat's hour as one run with one child per chat, each filing through its tool (#364)", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await inScope(client, twin, twin.chat, twin.otherChat);
      await bindChat(client, twin, twin.chat, "Ferretería Fuentes");
      await bindChat(client, twin, twin.otherChat, "Sra. Garza");
      await seamMessage(client, twin, { messageId: "WAMID-1", text: "te las dejo en 4500", occurredAt: MORNING, fromMe: true });
      await seamMessage(client, twin, {
        messageId: "WAMID-2",
        text: "todo bien",
        occurredAt: MORNING,
        chatJid: twin.otherChat,
      });

      // Mid-afternoon on the rep's clock: the day's instant has not come, and
      // the model is scripted empty so a call would fail loudly.
      expect(await clockPass(depsFor(client, twin, []), new Date("2026-08-29T20:00:00Z"))).toBe(0);
      expect(await readRuns(client, twin)).toEqual([]);

      // At the hour: one run of Dito's extraction, one child per chat.
      const rule: Script = (prompt) =>
        prompt.includes("WAMID-1")
          ? extracted({ fact_type: "QuoteGiven", message_id: "WAMID-1", confidence: 0.9, item: "cajas", amount: 4500, currency: "MXN" })
          : extracted();
      expect(await clockPass(depsFor(client, twin, rule), NOW)).toBe(1);
      const runs = await client.query<{ automation: string; created_by: string; parent: boolean; state: string }>(
        `SELECT automation, created_by, parent_run_id IS NULL AS parent, state
           FROM runs WHERE twin_id = $1 ORDER BY parent_run_id IS NULL DESC, created_at`,
        [twin.twinId],
      );
      expect(runs.rows).toEqual([
        { automation: "extraction", created_by: "clock", parent: true, state: "succeeded" },
        { automation: "extraction", created_by: "clock", parent: false, state: "succeeded" },
        { automation: "extraction", created_by: "clock", parent: false, state: "succeeded" },
      ]);
      expect((await readRuns(client, twin)).map((r) => r["state"])).toEqual(["filed", "filed"]);
      // THE DISPOSITIONS ARE THE FILING TOOL'S: `filed` where the aperture
      // filed, `nothing-to-file` where it had nothing.
      const words = await client.query<{ disposition: string }>(
        `SELECT e.disposition FROM executions e
           JOIN run_steps s ON s.execution_id = e.id AND s.kind = 'agent'
           JOIN runs r ON r.id = s.run_id
          WHERE r.twin_id = $1 ORDER BY e.disposition`,
        [twin.twinId],
      );
      expect(words.rows.map((row) => row.disposition)).toEqual(["filed", "nothing-to-file"]);
      // ...AND THE CLOCK FIRES IT ONCE A DAY: its next pass, the read over,
      // fires the day's notes and nothing else.
      expect(await clockPass(depsFor(client, twin), new Date(NOW.getTime() + 600_000))).toBe(1);
      const parents = await client.query<{ automation: string }>(
        "SELECT automation FROM runs WHERE twin_id = $1 AND parent_run_id IS NULL ORDER BY created_at",
        [twin.twinId],
      );
      expect(parents.rows.map((row) => row.automation)).toEqual(["extraction", "daily_disclosure"]);
    });
  });

  it("keeps no hour check of its own: the clock's cadence is the day's only hour (#364)", async () => {
    expect(Object.keys(await import("./extraction-pass.js"))).not.toContain("runDailyExtractionIfDue");
    expect(Object.keys(await import("./disclosure.js"))).not.toContain("runDailyDisclosureIfDue");
  });
});

/**
 * A REACTION IS EVIDENCE ABOUT THE MESSAGE IT TARGETS (ticket #98;
 * ADR-0041).
 *
 * The same Postgres seam every suite above uses, and the same scripted
 * model client: reaction rows go in, and what comes out is asserted on two
 * things only — WHAT THE MODEL WAS SHOWN (the transcript lines, in order)
 * and WHAT CROSSED (candidate facts). Nothing here asserts renderer
 * internals or bundle interior.
 */
describe("extraction reads a reaction as evidence (#98; ADR-0041)", () => {
  const ASK = "me mandas 20 bultos?";

  it("renders each reaction in the window as its own chronological line naming the emoji and its target", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await inScope(client, twin, twin.chat);
      await bindChat(client, twin, twin.chat, "Ferretería Fuentes");
      await seamMessage(client, twin, {
        messageId: "WAMID-ASK",
        text: ASK,
        occurredAt: MORNING,
      });
      await seamReaction(client, twin, {
        messageId: "WAMID-R1",
        reactionTo: "WAMID-ASK",
        emoji: "👍",
        occurredAt: EVENING,
        fromMe: true,
      });

      const model = scriptedModel(extracted());
      await runDailyExtraction(
        { ...depsFor(client, twin), harness: model.harness },
        NOW,
      );

      // The reaction carries ITS OWN id, exactly like a message line —
      // that prefix is what a candidate cites as `agreement` evidence
      // (#99) — and the target it points at is named, so the model can
      // find the line above it.
      expect(transcriptOf(model).split("\n")).toContain(
        `[WAMID-R1] [${AT_EVENING}] rep: [reacción 👍 a WAMID-ASK]`,
      );
      expect((await readRuns(client, twin))[0]).toMatchObject({ messages: 2 });
    });
  });

  it("inlines an OUT-OF-WINDOW target's own words, so a gesture at last week's quote is legible evidence", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await inScope(client, twin, twin.chat);
      await bindChat(client, twin, twin.chat, "Ferretería Fuentes");
      // Yesterday's request — outside today's window, so it is not a line
      // of its own and its id names nothing the model can look up.
      await seamMessage(client, twin, {
        messageId: "WAMID-OLD",
        text: ASK,
        occurredAt: YESTERDAY,
      });
      await seamReaction(client, twin, {
        messageId: "WAMID-R1",
        reactionTo: "WAMID-OLD",
        emoji: "👍",
        occurredAt: MORNING,
        fromMe: true,
      });

      const model = scriptedModel(extracted());
      await runDailyExtraction(
        { ...depsFor(client, twin), harness: model.harness },
        NOW,
      );

      const turn = transcriptOf(model);
      expect(turn.split("\n")).toContain(
        `[WAMID-R1] [${AT_MORNING}] rep: [reacción 👍 a WAMID-OLD: «${ASK}»]`,
      );
      // The target is quoted INSIDE the gesture and is not a beat of its
      // own: yesterday is not in the window, and nothing here re-extracts
      // it.
      expect((await readRuns(client, twin))[0]).toMatchObject({ messages: 1 });
    });
  });

  it("leaves a BACKFILLED reaction out of the window, as all backfill is", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await inScope(client, twin, twin.chat);
      await bindChat(client, twin, twin.chat, "Ferretería Fuentes");
      await seamMessage(client, twin, {
        messageId: "WAMID-ASK",
        text: ASK,
        occurredAt: MORNING,
      });
      // A history blob carrying today's gesture. It is still history.
      await seamReaction(client, twin, {
        messageId: "WAMID-HIST",
        reactionTo: "WAMID-ASK",
        emoji: "👍",
        occurredAt: EVENING,
        fromMe: true,
        backfill: true,
      });

      const model = scriptedModel(extracted());
      await runDailyExtraction(
        { ...depsFor(client, twin), harness: model.harness },
        NOW,
      );

      const turn = transcriptOf(model);
      expect(turn).not.toContain("reacción");
      expect(turn).not.toContain("WAMID-HIST");
      expect((await readRuns(client, twin))[0]).toMatchObject({ messages: 1 });
    });
  });

  it("folds NOTHING: a set, a change and a removal are three beats, in order, and the removal reads as a retraction", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await inScope(client, twin, twin.chat);
      await bindChat(client, twin, twin.chat, "Ferretería Fuentes");
      await seamMessage(client, twin, {
        messageId: "WAMID-ASK",
        text: ASK,
        occurredAt: MORNING,
      });
      // One reactor, one target, three deliveries — the shape a consumer
      // that folded by (reactor, target) would collapse to one line.
      await seamReaction(client, twin, {
        messageId: "WAMID-R1",
        reactionTo: "WAMID-ASK",
        emoji: "👍",
        occurredAt: new Date("2026-08-29T16:00:00Z"),
        fromMe: true,
      });
      await seamReaction(client, twin, {
        messageId: "WAMID-R2",
        reactionTo: "WAMID-ASK",
        emoji: "❤️",
        occurredAt: new Date("2026-08-29T17:00:00Z"),
        fromMe: true,
      });
      await seamReaction(client, twin, {
        messageId: "WAMID-R3",
        reactionTo: "WAMID-ASK",
        emoji: "",
        occurredAt: new Date("2026-08-29T18:00:00Z"),
        fromMe: true,
      });

      const model = scriptedModel(extracted());
      await runDailyExtraction(
        { ...depsFor(client, twin), harness: model.harness },
        NOW,
      );

      const lines = transcriptOf(model)
        .split("\n")
        .filter((line) => line.includes("reacción"))
        .map((line) => line.slice(line.indexOf(": ") + 2));
      expect(lines).toEqual([
        "[reacción 👍 a WAMID-ASK]",
        "[reacción ❤️ a WAMID-ASK]",
        "[reacción retirada de WAMID-ASK]",
      ]);
      expect((await readRuns(client, twin))[0]).toMatchObject({ messages: 4 });
    });
  });

  it("keeps two beats of ONE SECOND in delivery order: a removal delivered first never renders before the 👍 it retracts (#109)", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await inScope(client, twin, twin.chat);
      await bindChat(client, twin, twin.chat, "Ferretería Fuentes");
      await seamMessage(client, twin, {
        messageId: "WAMID-ASK",
        text: ASK,
        occurredAt: MORNING,
      });

      // The rep taps 👍 by mistake and takes it back a fifth of a second
      // later. The rail's stanza timestamp is WHOLE SECONDS, so both rows
      // carry the same `occurred_at`; only the reactor's own millisecond
      // clock says which tap came first — and the seam saw them in the
      // wrong order (a reconnect, a retry), so the row ids say the
      // opposite.
      const SAME_SECOND = new Date("2026-08-29T16:00:00Z");
      await seamReaction(client, twin, {
        messageId: "WAMID-R-REMOVE",
        reactionTo: "WAMID-ASK",
        emoji: "",
        occurredAt: SAME_SECOND,
        senderTsMs: SAME_SECOND.getTime() + 200,
        fromMe: true,
      });
      await seamReaction(client, twin, {
        messageId: "WAMID-R-SET",
        reactionTo: "WAMID-ASK",
        emoji: "👍",
        occurredAt: SAME_SECOND,
        senderTsMs: SAME_SECOND.getTime(),
        fromMe: true,
      });

      const model = scriptedModel(extracted());
      await runDailyExtraction(
        { ...depsFor(client, twin), harness: model.harness },
        NOW,
      );

      // The set, then its retraction — «puso 👍 y luego lo quitó». The
      // inverted transcript would read as an agreement that stands, which
      // is the wrong direction of error (ADR-0038).
      const lines = transcriptOf(model)
        .split("\n")
        .filter((line) => line.includes("reacción"))
        .map((line) => line.slice(line.indexOf(": ") + 2));
      expect(lines).toEqual([
        "[reacción 👍 a WAMID-ASK]",
        "[reacción retirada de WAMID-ASK]",
      ]);
    });
  });

  it("renders a gesture at a target nothing captured bare, with its id — a missing target never fails the pass", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await inScope(client, twin, twin.chat);
      await bindChat(client, twin, twin.chat, "Ferretería Fuentes");
      await seamReaction(client, twin, {
        messageId: "WAMID-R1",
        // Before the QR code, or a message this twin never captured.
        reactionTo: "WAMID-GHOST",
        emoji: "👍",
        occurredAt: MORNING,
        fromMe: true,
      });

      const model = scriptedModel(extracted());
      const result = await runDailyExtraction(
        { ...depsFor(client, twin), harness: model.harness },
        NOW,
      );

      expect(result).toMatchObject({ extracted: 1, settled: true });
      expect(transcriptOf(model).split("\n")).toContain(
        `[WAMID-R1] [${AT_MORNING}] rep: [reacción 👍 a WAMID-GHOST]`,
      );
    });
  });

  it("never reads a reaction in the twin thread — provenance decides, and a gesture is no exception (ADR-0033)", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await inScope(client, twin, twin.chat);
      await bindChat(client, twin, twin.chat, "Ferretería Fuentes");
      await seamMessage(client, twin, {
        messageId: "WAMID-NOTE-98",
        text: "recuerda: con Fuentes siempre de usted",
        occurredAt: MORNING,
        chatJid: SELF_CHAT,
        fromMe: true,
      });
      // The rep 👍s their own note. It is rep-stated material and it never
      // crosses — the self-chat is in neither of extraction's two sources.
      const gesture = await seamReaction(client, twin, {
        messageId: "WAMID-RNOTE",
        reactionTo: "WAMID-NOTE-98",
        emoji: "👍",
        occurredAt: EVENING,
        chatJid: SELF_CHAT,
        fromMe: true,
      });
      await seamMessage(client, twin, {
        messageId: "WAMID-1",
        text: "todo bien, gracias",
        occurredAt: MORNING,
      });

      const model = scriptedModel(extracted());
      const result = await runDailyExtraction(
        { ...depsFor(client, twin), harness: model.harness },
        NOW,
      );

      expect(result.chats).toBe(1);
      const turn = transcriptOf(model);
      expect(turn).not.toContain("reacción");
      expect(turn).not.toContain("recuerda");
      const cited = await client.query<{ n: string }>(
        "SELECT count(*) AS n FROM disclosure_lines WHERE source_event_id = $1",
        [gesture],
      );
      expect(cited.rows[0]?.n).toBe("0");
    });
  });

  /**
   * THE WHOLE LOOP, END TO END (ticket #99; ADR-0041). The model is shown
   * the gesture line, cites the REACTION's own id as its `OrderTaken`'s
   * source, and says nothing about the target or about the words —
   * deterministic code reads both back off the seam and composes the
   * evidence the rep then reads.
   */
  it("files an OrderTaken cited on a rep's 👍, with the target's words as the evidence", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await inScope(client, twin, twin.chat);
      await bindChat(client, twin, twin.chat, "Ferretería Fuentes");
      await seamMessage(client, twin, {
        messageId: "WAMID-ASK",
        text: ASK,
        occurredAt: MORNING,
      });
      const gesture = await seamReaction(client, twin, {
        messageId: "WAMID-R1",
        reactionTo: "WAMID-ASK",
        emoji: "👍",
        occurredAt: EVENING,
        fromMe: true,
      });

      const result = await runDailyExtraction(
        depsFor(
          client,
          twin,
          extracted(
            {
              fact_type: "OrderRequested",
              message_id: "WAMID-ASK",
              confidence: 0.95,
              item: "bultos",
              quantity: 20,
            },
            {
              fact_type: "OrderTaken",
              message_id: "WAMID-R1",
              confidence: 0.95,
              item: "bultos",
              quantity: 20,
            },
          ),
        ),
        NOW,
      );

      // TWO FACTS on one exchange, which is the shape ADR-0038 split the
      // type for: the customer asked, and the business agreed — the second
      // of them evidenced by a gesture rather than by words.
      expect(result).toMatchObject({ filed: 2 });
      const facts = await readFacts(client, twin);
      expect(facts.map((f) => f.factType)).toEqual([
        "OrderRequested",
        "OrderTaken",
      ]);
      const taken = facts[1]!;
      expect(taken.payload).toEqual({
        item: "bultos",
        quantity: 20,
        agreement: ASK,
        agreementGesture: "👍",
      });
      // The line the rep reads names the gesture and quotes the message it
      // was placed on — ADR-0041's own worked example.
      expect(taken.disclosureText).toBe(
        `Le confirmaste el pedido de 20 bultos — sin precio, sin fecha. Confirmaste con 👍: «${ASK}».`,
      );
      // Provenance is the GESTURE's row: that is the beat the fact was
      // read in, and the anchor every later walk follows.
      expect(taken.sourceEventId).toBe(gesture);
      expect(taken.occurredAt).toEqual(EVENING);
    });
  });

  /**
   * R2 (Diego, 2026-08-31): AN INLINED OUT-OF-WINDOW TARGET COUNTS AS
   * "GIVEN TO THE PASS".
   *
   * ADR-0038 files an `OrderTaken` only when both the request and the
   * answer are among the messages the pass was given, because a bare «va»
   * does not name what was asked for. A gesture at yesterday's request is
   * exactly that case with the missing half restored: #98's renderer
   * inlines the target's words ON the reaction line, so the pass WAS given
   * the request — and the aperture then reads the same words back off the
   * seam rather than trusting the transcript.
   *
   * This is agreement arriving after deliberation, which ADR-0041 names as
   * the common case a bare unresolvable id would re-amputate.
   */
  it("files an OrderTaken on today's 👍 at YESTERDAY's request, whose words the transcript inlined", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await inScope(client, twin, twin.chat);
      await bindChat(client, twin, twin.chat, "Ferretería Fuentes");
      await seamMessage(client, twin, {
        messageId: "WAMID-OLD",
        text: ASK,
        occurredAt: YESTERDAY,
      });
      await seamReaction(client, twin, {
        messageId: "WAMID-R1",
        reactionTo: "WAMID-OLD",
        emoji: "👍",
        occurredAt: MORNING,
        fromMe: true,
      });

      const model = scriptedModel(
        extracted({
          fact_type: "OrderTaken",
          message_id: "WAMID-R1",
          confidence: 0.95,
          item: "bultos",
          quantity: 20,
        }),
      );
      const result = await runDailyExtraction(
        { ...depsFor(client, twin), harness: model.harness },
        NOW,
      );

      // The request was in front of the model INLINED on the gesture line,
      // and nowhere else: yesterday is not a beat of this window.
      expect(transcriptOf(model).split("\n")).toContain(
        `[WAMID-R1] [${AT_MORNING}] rep: [reacción 👍 a WAMID-OLD: «${ASK}»]`,
      );
      expect(result).toMatchObject({ filed: 1 });
      const facts = await readFacts(client, twin);
      expect(facts).toHaveLength(1);
      expect(facts[0]!.payload).toEqual({
        item: "bultos",
        quantity: 20,
        agreement: ASK,
        agreementGesture: "👍",
      });
    });
  });

  /**
   * R3 (from #72): THERE IS NO DETERMINISTIC RETRACTION BLOCK, and this is
   * the test that documents its absence.
   *
   * A 👍 and its removal are two beats of the transcript, in order, and
   * whether the agreement STANDS is the model's reading of them. Here the
   * scripted model reads it as standing and cites the 👍; the fact files.
   * A model reading the same two beats the other way records nothing, and
   * that is the whole mechanism — the aperture holds no fold and looks for
   * no later row.
   */
  it("files on a 👍 the rep later removed, when the model reads the agreement as standing", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await inScope(client, twin, twin.chat);
      await bindChat(client, twin, twin.chat, "Ferretería Fuentes");
      await seamMessage(client, twin, {
        messageId: "WAMID-ASK",
        text: ASK,
        occurredAt: MORNING,
      });
      await seamReaction(client, twin, {
        messageId: "WAMID-R1",
        reactionTo: "WAMID-ASK",
        emoji: "👍",
        occurredAt: EVENING,
        fromMe: true,
      });
      await seamReaction(client, twin, {
        messageId: "WAMID-R2",
        reactionTo: "WAMID-ASK",
        emoji: "",
        occurredAt: new Date(EVENING.getTime() + 60_000),
        fromMe: true,
      });

      const model = scriptedModel(
        extracted({
          fact_type: "OrderTaken",
          message_id: "WAMID-R1",
          confidence: 0.95,
          item: "bultos",
          quantity: 20,
        }),
      );
      const result = await runDailyExtraction(
        { ...depsFor(client, twin), harness: model.harness },
        NOW,
      );

      // Both beats were shown, in order — the retraction is a beat, not a
      // correction to the one above it (ADR-0041).
      const lines = transcriptOf(model)
        .split("\n")
        .filter((line) => line.includes("reacción"));
      expect(lines).toHaveLength(2);
      expect(lines[1]).toContain("reacción retirada de WAMID-ASK");
      expect(result).toMatchObject({ filed: 1 });
      expect((await readFacts(client, twin))[0]!.payload).toMatchObject({
        agreementGesture: "👍",
      });
    });
  });

  /**
   * ...AND CITING THE REMOVAL ITSELF IS A DIFFERENT THING, refused in
   * code. That is an evidence-SHAPE error rather than a reading: the row
   * says the rep took the gesture back, and no reading of it is an
   * agreement. The customer's `OrderRequested` stands alone, which is
   * ADR-0038's under-filing direction.
   */
  it("refuses an OrderTaken cited on a REMOVED reaction", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await inScope(client, twin, twin.chat);
      await bindChat(client, twin, twin.chat, "Ferretería Fuentes");
      await seamMessage(client, twin, {
        messageId: "WAMID-ASK",
        text: ASK,
        occurredAt: MORNING,
      });
      await seamReaction(client, twin, {
        messageId: "WAMID-R1",
        reactionTo: "WAMID-ASK",
        emoji: "",
        occurredAt: EVENING,
        fromMe: true,
      });

      const result = await runDailyExtraction(
        depsFor(
          client,
          twin,
          extracted(
            {
              fact_type: "OrderRequested",
              message_id: "WAMID-ASK",
              confidence: 0.95,
              item: "bultos",
              quantity: 20,
            },
            {
              fact_type: "OrderTaken",
              message_id: "WAMID-R1",
              confidence: 0.95,
              item: "bultos",
              quantity: 20,
            },
          ),
        ),
        NOW,
      );

      expect(result).toMatchObject({ filed: 1 });
      expect((await readFacts(client, twin)).map((f) => f.factType)).toEqual([
        "OrderRequested",
      ]);
      expect((await readRuns(client, twin))[0]).toMatchObject({
        candidates: 2,
        filed: 1,
        refused: 1,
      });
    });
  });

  /**
   * A CUSTOMER'S 👍 IS NOT THE REP AGREEING. The gesture is real agreement
   * in the other direction (ADR-0041 says so), and nothing files it: the
   * fact `OrderTaken` makes is the REP's, its sentence names them, and a
   * fact read on the wrong side of the conversation is false in the one
   * way the rep cannot see (ADR-0038).
   */
  it("refuses an OrderTaken cited on the CUSTOMER's reaction", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await inScope(client, twin, twin.chat);
      await bindChat(client, twin, twin.chat, "Ferretería Fuentes");
      await seamMessage(client, twin, {
        messageId: "WAMID-QUOTE",
        text: "se los dejo en 4,500",
        occurredAt: MORNING,
        fromMe: true,
      });
      await seamReaction(client, twin, {
        messageId: "WAMID-R1",
        reactionTo: "WAMID-QUOTE",
        emoji: "👍",
        occurredAt: EVENING,
      });

      const result = await runDailyExtraction(
        depsFor(
          client,
          twin,
          extracted({
            fact_type: "OrderTaken",
            message_id: "WAMID-R1",
            confidence: 0.95,
            item: "bultos",
            quantity: 20,
          }),
        ),
        NOW,
      );

      expect(result).toMatchObject({ filed: 0 });
      expect(await readFacts(client, twin)).toEqual([]);
      expect((await readRuns(client, twin))[0]).toMatchObject({ refused: 1 });
    });
  });

  it("never proposes a binding off a gesture: the ceremony's anchor is a message or there is none", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      // Two unbound in-scope chats. In the first, the customer's only beat
      // today is a 👍 — which carries a push name like any delivery, and is
      // the FIRST thing in its window, so a proposal picked by order alone
      // would pick it.
      await inScope(client, twin, twin.chat, twin.otherChat);
      await seamReaction(client, twin, {
        messageId: "WAMID-R1",
        reactionTo: "WAMID-GHOST",
        emoji: "👍",
        occurredAt: MORNING,
        pushName: "Sra. Garza",
      });
      // The second chat's customer gestured first and typed afterwards.
      await seamReaction(client, twin, {
        messageId: "WAMID-R2",
        reactionTo: "WAMID-GHOST-2",
        emoji: "👍",
        occurredAt: MORNING,
        chatJid: twin.otherChat,
        pushName: "Ferretería Fuentes",
      });
      const typed = await seamMessage(client, twin, {
        messageId: "WAMID-SAID",
        text: "buenas, ¿me apartas 20 bultos?",
        occurredAt: EVENING,
        chatJid: twin.otherChat,
        pushName: "Ferretería Fuentes",
      });

      // A deferred chat never reaches the model: scripted empty.
      const first = await runDailyExtraction(depsFor(client, twin, []), NOW);
      expect(first).toMatchObject({ chats: 2, deferred: 2, extracted: 0 });

      // ONE proposal, and it is anchored on the MESSAGE. The whole binding
      // ceremony hangs off `about_event_id`, and every reader of that
      // anchor decodes it as a message — the defect #97 fixed in the
      // ceremony's own «or answer» trigger. So the gesture-only chat asks
      // nothing at all, and the chat that also has words anchors on the
      // words.
      const notices = await client.query<{ about_event_id: string }>(
        `SELECT about_event_id FROM notices
          WHERE twin_id = $1 AND kind = 'binding_question'`,
        [twin.twinId],
      );
      expect(notices.rows.map((r) => r.about_event_id)).toEqual([typed]);

      // ...and the next run reads the same chats without dying on either.
      const second = await runDailyExtraction(depsFor(client, twin, []), NOW);
      expect(second).toMatchObject({ chats: 2, deferred: 2 });
    });
  });

  /**
   * THE SPEC'S REQUIRED TESTS (#96): a reaction changes what is extracted,
   * and a retraction changes the judgement.
   *
   * Both are asserted with ONE rule read off the transcript, run over two
   * worlds. Two worlds scripted with two different lists would prove only
   * that the fixture differed; the same rule answering differently is what
   * makes the transcript the thing that changed.
   */
  describe("what the model was shown is what changed its judgement", () => {
    /** The rep floats a delivery day. Alone, it promises nothing. */
    const OFFER = "¿te mando los 20 bultos el viernes?";

    async function repOffered(client: pg.Client, twin: Twin): Promise<void> {
      await inScope(client, twin, twin.chat);
      await bindChat(client, twin, twin.chat, "Ferretería Fuentes");
      await seamMessage(client, twin, {
        messageId: "WAMID-OFFER",
        text: OFFER,
        occurredAt: MORNING,
        fromMe: true,
      });
    }

    /**
     * One rule, three readings: the customer accepted (the gesture stands),
     * the customer took it back (a retraction is the last beat), or the
     * rep floated a day nobody answered.
     */
    function judgeTheDay(transcript: string): ScriptedTurn[] {
      if (transcript.includes("[reacción retirada de WAMID-OFFER]")) {
        return extracted();
      }
      if (!transcript.includes("[reacción 👍 a WAMID-OFFER]")) {
        return extracted();
      }
      return extracted({
        fact_type: "DatePromised",
        message_id: "WAMID-OFFER",
        confidence: 0.95,
        commitment: "que entregas los 20 bultos el viernes",
      });
    }

    it("files the promise the customer's 👍 accepted, and nothing where there is no 👍", async () => {
      await withClient(async (client) => {
        const agreed = freshTwin();
        await repOffered(client, agreed);
        await seamReaction(client, agreed, {
          messageId: "WAMID-R1",
          reactionTo: "WAMID-OFFER",
          emoji: "👍",
          occurredAt: EVENING,
        });
        const withGesture = scriptedModel(judgeTheDay);
        await runDailyExtraction(
          { ...depsFor(client, agreed), harness: withGesture.harness },
          NOW,
        );

        // The same day, the same rule, and nobody reacted.
        const silent = freshTwin();
        await repOffered(client, silent);
        const withoutGesture = scriptedModel(judgeTheDay);
        await runDailyExtraction(
          { ...depsFor(client, silent), harness: withoutGesture.harness },
          NOW,
        );

        expect(await readFacts(client, agreed)).toMatchObject([
          {
            factType: "DatePromised",
            payload: { commitment: "que entregas los 20 bultos el viernes" },
          },
        ]);
        expect(await readFacts(client, silent)).toEqual([]);
      });
    });

    it("files nothing once the 👍 is taken back — a retraction is a beat the model can read", async () => {
      await withClient(async (client) => {
        const twin = freshTwin();
        await repOffered(client, twin);
        await seamReaction(client, twin, {
          messageId: "WAMID-R1",
          reactionTo: "WAMID-OFFER",
          emoji: "👍",
          occurredAt: new Date("2026-08-29T17:00:00Z"),
        });
        await seamReaction(client, twin, {
          messageId: "WAMID-R2",
          reactionTo: "WAMID-OFFER",
          emoji: "",
          occurredAt: new Date("2026-08-29T18:00:00Z"),
        });

        const model = scriptedModel(judgeTheDay);
        await runDailyExtraction(
          { ...depsFor(client, twin), harness: model.harness },
          NOW,
        );

        // BOTH beats are in front of the model — the agreement and its
        // withdrawal — because nothing folds. The judgement is the model's
        // from the transcript, never an aperture rule.
        const lines = transcriptOf(model).split("\n");
        expect(lines.some((l) => l.includes("[reacción 👍 a WAMID-OFFER]"))).toBe(
          true,
        );
        expect(
          lines.some((l) => l.includes("[reacción retirada de WAMID-OFFER]")),
        ).toBe(true);
        expect(await readFacts(client, twin)).toEqual([]);
      });
    });
  });
});

describe("extraction reads an opaque delivery as a placeholder beat (#124; ADR-0042)", () => {
  const ASK = "me mandas 20 bultos?";

  it("renders it as ONE chronological line composed from its kind, in its place among the day's beats", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await inScope(client, twin, twin.chat);
      await bindChat(client, twin, twin.chat, "Ferretería Fuentes");
      await seamMessage(client, twin, {
        messageId: "WAMID-ASK",
        text: ASK,
        occurredAt: MORNING,
      });
      await seamOpaque(client, twin, {
        messageId: "WAMID-PHOTO:opaque",
        kind: "imageMessage",
        occurredAt: EVENING,
      });

      const model = scriptedModel(extracted());
      await runDailyExtraction(
        { ...depsFor(client, twin), harness: model.harness },
        NOW,
      );

      // The placeholder carries ITS OWN row identity as the line's id,
      // exactly like a message — that prefix is what a candidate would
      // cite — and the line itself is composed from the kind by code.
      expect(transcriptOf(model).split("\n")).toContain(
        `[WAMID-PHOTO:opaque] [${AT_EVENING}] customer: [foto]`,
      );
      expect((await readRuns(client, twin))[0]).toMatchObject({ messages: 2 });
    });
  });

  it("leaves a BACKFILLED opaque delivery out of the window, as all backfill is", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await inScope(client, twin, twin.chat);
      await bindChat(client, twin, twin.chat, "Ferretería Fuentes");
      await seamMessage(client, twin, {
        messageId: "WAMID-ASK",
        text: ASK,
        occurredAt: MORNING,
      });
      // A history blob carrying today's photo. It is still history.
      await seamOpaque(client, twin, {
        messageId: "WAMID-HIST:opaque",
        kind: "imageMessage",
        occurredAt: EVENING,
        backfill: true,
      });

      const model = scriptedModel(extracted());
      await runDailyExtraction(
        { ...depsFor(client, twin), harness: model.harness },
        NOW,
      );

      const turn = transcriptOf(model);
      expect(turn).not.toContain("[foto]");
      expect(turn).not.toContain("WAMID-HIST");
      expect((await readRuns(client, twin))[0]).toMatchObject({ messages: 1 });
    });
  });

  it("folds per (chat, stanza): the words stand over the placeholder, and the placeholder stands over the empty-text husk", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await inScope(client, twin, twin.chat);
      await bindChat(client, twin, twin.chat, "Ferretería Fuentes");
      // One message the rail could not decrypt and then re-delivered...
      await seamOpaque(client, twin, {
        messageId: "WAMID-RETRY:opaque",
        kind: "undecryptable",
        reason: "undecryptable",
        occurredAt: MORNING,
      });
      await seamMessage(client, twin, {
        messageId: "WAMID-RETRY",
        text: ASK,
        occurredAt: MORNING,
      });
      // ...and one photo whose pre-ADR-0042 husk is still on the seam.
      await seamMessage(client, twin, {
        messageId: "WAMID-HUSK",
        text: "",
        occurredAt: EVENING,
      });
      await seamOpaque(client, twin, {
        messageId: "WAMID-HUSK:opaque",
        kind: "imageMessage",
        occurredAt: EVENING,
      });

      const model = scriptedModel(extracted());
      await runDailyExtraction(
        { ...depsFor(client, twin), harness: model.harness },
        NOW,
      );

      const lines = transcriptOf(model).split("\n");
      // The retry: the words render, the placeholder does not.
      expect(lines.some((line) => line.includes(ASK))).toBe(true);
      expect(transcriptOf(model)).not.toContain("[mensaje que no se pudo leer]");
      // The husk: the placeholder renders, the silent row does not.
      expect(transcriptOf(model)).toContain("[foto]");
      expect(transcriptOf(model)).not.toContain("[WAMID-HUSK]");
      // Four seam rows, two beats.
      expect((await readRuns(client, twin))[0]).toMatchObject({ messages: 2 });
    });
  });

  it("never ANCHORS the binding ceremony on one: the proposal skips the photo and takes the message behind it", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await inScope(client, twin, twin.chat);
      // An UNBOUND chat whose FIRST push-named beat is an opaque delivery.
      // The proposal picker takes the first candidate it finds, so without
      // the skip this photo is what the ceremony would anchor on — and
      // every reader of a question's `about_event_id` decodes it as a
      // MESSAGE, so the next pass would die on a payload error for the
      // whole twin. That is the defect #98 named for gestures, and an
      // opaque row would reintroduce it.
      await seamOpaque(client, twin, {
        messageId: "WAMID-PHOTO:opaque",
        kind: "imageMessage",
        occurredAt: MORNING,
        pushName: "Sra. Garza",
      });
      const said = await seamMessage(client, twin, {
        messageId: "WAMID-1",
        text: "mándeme 100 cajas",
        occurredAt: EVENING,
        pushName: "Sra. Garza",
      });

      // The model is scripted EMPTY: a deferred chat must never reach it.
      const result = await runDailyExtraction(depsFor(client, twin, []), NOW);

      expect(result).toMatchObject({ chats: 1, deferred: 1, filed: 0 });
      // It still got slice 2's proposal — anchored on the MESSAGE, which is
      // the row every reader of that anchor can actually decode.
      const asked = await client.query<{ about_event_id: string }>(
        "SELECT about_event_id FROM notices WHERE twin_id = $1 AND kind = 'binding_question'",
        [twin.twinId],
      );
      expect(asked.rows).toEqual([{ about_event_id: said }]);
    });
  });
});

/**
 * STEERING THE RIG THROUGH TIME (ticket #67; #57 findings 4 and 5).
 *
 * Both failures the ticket exists for, at the pass's own seam: an injected
 * instant must not poison the watermark, and a steering session must be
 * able to re-read a chat the day has already filed. Every test here also
 * has a twin above it proving the SCHEDULED pass is untouched — the
 * override is inert unless a caller passes it.
 */
describe("steering the daily extraction through time (#67)", () => {
  /** 23:30 on the rep's clock — two hours ahead of `NOW`, still the 29th. */
  const STEERED = new Date("2026-08-30T05:30:00Z");

  it("keeps the watermark on the SEAM's clock when the rep's is steered ahead — the rig does not go deaf after one injected run (#57 finding 5)", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await inScope(client, twin, twin.chat);
      await bindChat(client, twin, twin.chat, "Ferretería Fuentes");
      await seamMessage(client, twin, {
        messageId: "WAMID-BEFORE",
        text: "te las dejo en 4500",
        occurredAt: MORNING,
        fromMe: true,
      });

      // THE INJECTED RUN: the rep's clock says 23:30, the seam is really
      // being read at 21:30.
      const steered = await runDailyExtraction(
        depsFor(client, twin, extracted()),
        STEERED,
        { seamNow: NOW },
      );
      expect(steered).toMatchObject({ extracted: 1 });
      // The watermark is a statement about the SEAM, so it stops where the
      // reading really stopped — 21:29, not 23:29.
      expect((await readRuns(client, twin))[0]?.["window_end"]).toEqual(
        new Date(NOW.getTime() - 60_000),
      );

      // GENUINELY NEW TRAFFIC, at the real clock, after that run — the
      // REP's own message, because what it carries is the rep's commitment
      // and a fact about the rep's act is read in the rep's words or not at
      // all (#71, ADR-0038).
      await seamMessage(client, twin, {
        messageId: "WAMID-AFTER",
        text: "y el sábado te confirmo",
        occurredAt: new Date("2026-08-30T03:35:00Z"),
        fromMe: true,
      });

      // The next ordinary run — no override anywhere near it — reads it.
      // With a poisoned watermark this window would start at 23:29 and the
      // message would be behind it forever.
      const model = scriptedModel(
        extracted({
          fact_type: "DatePromised",
          message_id: "WAMID-AFTER",
          confidence: 0.9,
          commitment: "que entregas el sábado",
        }),
      );
      const next = await runDailyExtraction(
        { ...depsFor(client, twin), harness: model.harness },
        new Date("2026-08-31T03:30:00Z"),
      );

      expect(next).toMatchObject({ extracted: 1, filed: 1 });
      const turn = latestPromptOf(model.requests[0]!);
      expect(turn).toContain("WAMID-AFTER");
    });
  });

  it("reads a chat it has never read before while the clock is steered into tomorrow — every edge of the window is the seam's day, not the steered one", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await inScope(client, twin, twin.chat);
      await bindChat(client, twin, twin.chat, "Ferretería Fuentes");
      await seamMessage(client, twin, {
        messageId: "WAMID-FRESH",
        text: "te las dejo en 4500",
        occurredAt: MORNING,
        fromMe: true,
      });

      // No prior run, so this chat's window starts at a day's midnight —
      // and the only midnight that can contain real traffic is the one the
      // SEAM is living in. Taking the steered day's would open the window
      // after it closed and report a talkative chat as having nothing.
      const model = scriptedModel(
        extracted({
          fact_type: "QuoteGiven",
          message_id: "WAMID-FRESH",
          confidence: 0.9,
          item: "cajas",
          amount: 4500,
          currency: "MXN",
        }),
      );
      const steered = await runDailyExtraction(
        { ...depsFor(client, twin), harness: model.harness },
        new Date("2026-08-31T03:30:00Z"),
        { seamNow: NOW },
      );

      expect(steered).toMatchObject({ chats: 1, extracted: 1, filed: 1 });
      const turn = latestPromptOf(model.requests[0]!);
      expect(turn).toContain("WAMID-FRESH");
      const run = (await readRuns(client, twin))[0];
      // The window is the seam's 29th; the RUN is keyed to the rep's 30th,
      // which is the only thing the override is allowed to move.
      expect(run?.["window_start"]).toEqual(new Date("2026-08-29T06:00:00Z"));
      expect(run?.["window_end"]).toEqual(new Date(NOW.getTime() - 60_000));
    });
  });

  it("does not let a steered run settle a day that has not happened yet — the scheduled pass still reads the real day it was steered into", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await inScope(client, twin, twin.chat);
      await bindChat(client, twin, twin.chat, "Ferretería Fuentes");
      await seamMessage(client, twin, {
        messageId: "WAMID-29TH",
        text: "te las dejo en 4500",
        occurredAt: MORNING,
        fromMe: true,
      });
      // The 29th, read normally: this is what leaves a watermark, and every
      // chat on a live rig has one.
      await runDailyExtraction(depsFor(client, twin, extracted()), NOW);

      // Mid-morning on the 30th, for real.
      await seamMessage(client, twin, {
        messageId: "WAMID-STEERED",
        text: "buenos días",
        occurredAt: new Date("2026-08-30T20:00:00Z"),
      });

      // The session steers a day ahead — 21:30 on the 30th — while the seam
      // is really at 15:00 that afternoon. The run it writes is keyed to a
      // day whose evening has not arrived.
      const tomorrowEvening = new Date("2026-08-31T03:30:00Z");
      expect(
        await runDailyExtraction(
          depsFor(client, twin, extracted()),
          tomorrowEvening,
          { seamNow: new Date("2026-08-30T21:00:00Z") },
        ),
      ).toMatchObject({ extracted: 1 });

      // The 30th then goes on happening, and the rep talks again — their
      // own message, since the fact it carries is their commitment (#71).
      await seamMessage(client, twin, {
        messageId: "WAMID-REAL-30TH",
        text: "y el sábado te confirmo",
        occurredAt: new Date("2026-08-30T22:00:00Z"),
        fromMe: true,
      });

      // The SCHEDULED pass on the real 30th evening must read that chat. A
      // steered run is a person's, not the day's: letting it settle the day
      // would leave the rig blind for the whole of the day it steered into,
      // which is the same silent skip in different clothes.
      const model = scriptedModel(
        extracted({
          fact_type: "DatePromised",
          message_id: "WAMID-REAL-30TH",
          confidence: 0.9,
          commitment: "que entregas el sábado",
        }),
      );
      expect(
        await scheduledPass({ ...depsFor(client, twin), harness: model.harness }, tomorrowEvening),
      ).toBe(1);
      expect(await readFacts(client, twin)).toHaveLength(1);
      const turn = latestPromptOf(model.requests[0]!);
      expect(turn).toContain("WAMID-REAL-30TH");

      // Both runs are on the record, and only one of them is the day's own.
      const runs = await client.query<Record<string, unknown>>(
        `SELECT extraction_day::text AS day, steering, state FROM extraction_runs
          WHERE twin_id = $1 ORDER BY started_at`,
        [twin.twinId],
      );
      expect(runs.rows).toEqual([
        { day: "2026-08-29", steering: false, state: "filed" },
        { day: "2026-08-30", steering: true, state: "filed" },
        { day: "2026-08-30", steering: false, state: "filed" },
      ]);
    });
  });

  it("re-reads a chat the day has already filed when a steering session asks — the session's second round is not `0 read` (#57 finding 4)", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await inScope(client, twin, twin.chat);
      await bindChat(client, twin, twin.chat, "Ferretería Fuentes");
      await seamMessage(client, twin, {
        messageId: "WAMID-ROUND-1",
        text: "te las dejo en 4500",
        occurredAt: MORNING,
        fromMe: true,
      });

      // Round one of the session: send traffic, extract, check.
      const first = await runDailyExtraction(
        depsFor(
          client,
          twin,
          extracted({
            fact_type: "QuoteGiven",
            message_id: "WAMID-ROUND-1",
            confidence: 0.9,
            item: "cajas",
            amount: 4500,
            currency: "MXN",
          }),
        ),
        NOW,
      );
      expect(first).toMatchObject({ extracted: 1, filed: 1 });

      // Round two: MORE traffic, the same rep day — the rep's own message,
      // because round two's fact is the rep's commitment (#71).
      await seamMessage(client, twin, {
        messageId: "WAMID-ROUND-2",
        text: "y el sábado te confirmo",
        occurredAt: new Date("2026-08-30T03:35:00Z"),
        fromMe: true,
      });
      const later = new Date("2026-08-30T03:45:00Z");

      // Without the override this is exactly today's behaviour: the day is
      // settled, so nothing is read and the model is never called.
      expect(
        await runDailyExtraction(depsFor(client, twin, []), later),
      ).toMatchObject({ extracted: 0, filed: 0, settled: true });

      const second = await runDailyExtraction(
        depsFor(
          client,
          twin,
          extracted({
            fact_type: "DatePromised",
            message_id: "WAMID-ROUND-2",
            confidence: 0.9,
            commitment: "que entregas el sábado",
          }),
        ),
        later,
        { reextract: true },
      );
      expect(second).toMatchObject({ extracted: 1, filed: 1 });
      expect(await readFacts(client, twin)).toHaveLength(2);

      // The re-read is a SEPARATE, LABELLED run: the day's first run keeps
      // its own record of what it saw rather than being overwritten.
      const runs = await client.query<Record<string, unknown>>(
        `SELECT state, steering, filed, window_start, window_end
           FROM extraction_runs WHERE twin_id = $1 ORDER BY started_at`,
        [twin.twinId],
      );
      expect(runs.rows).toHaveLength(2);
      expect(runs.rows[0]).toMatchObject({
        state: "filed",
        steering: false,
        filed: 1,
      });
      expect(runs.rows[1]).toMatchObject({
        state: "filed",
        steering: true,
        filed: 1,
      });
      // ...and it picks up exactly where the first one stopped reading.
      expect(runs.rows[1]?.["window_start"]).toEqual(
        new Date(NOW.getTime() - 60_000),
      );
    });
  });

  it("costs nothing to ask twice: a re-read with nothing new since the last one reads no chat and calls no model", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await inScope(client, twin, twin.chat);
      await bindChat(client, twin, twin.chat, "Ferretería Fuentes");
      await seamMessage(client, twin, {
        messageId: "WAMID-SETTLED",
        text: "te las dejo en 4500",
        occurredAt: MORNING,
        fromMe: true,
      });
      await runDailyExtraction(depsFor(client, twin, extracted()), NOW);

      // Nothing has been said since, so the window is empty and the chat
      // is not part of the day at all — the flag never even gets asked.
      // The model is scripted EMPTY, so a call would fail loudly.
      expect(
        await runDailyExtraction(
          depsFor(client, twin, []),
          new Date("2026-08-30T03:45:00Z"),
          { reextract: true },
        ),
      ).toMatchObject({ chats: 0, extracted: 0, filed: 0 });
      // ...and no run row was written for the asking.
      expect(await readRuns(client, twin)).toHaveLength(1);
    });
  });

  it("files nothing twice across a re-read: the covered prefix is not in the window, and a model naming it anyway is refused", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await inScope(client, twin, twin.chat);
      await bindChat(client, twin, twin.chat, "Ferretería Fuentes");
      await seamMessage(client, twin, {
        messageId: "WAMID-ONCE",
        text: "te las dejo en 4500",
        occurredAt: MORNING,
        fromMe: true,
      });
      const quote = {
        fact_type: "QuoteGiven",
        message_id: "WAMID-ONCE",
        confidence: 0.9,
        item: "cajas",
        amount: 4500,
        currency: "MXN",
      };
      await runDailyExtraction(depsFor(client, twin, extracted(quote)), NOW);
      expect(await readFacts(client, twin)).toHaveLength(1);

      // Something new arrives, so the re-read has a window at all — and the
      // model is scripted to file the ALREADY-FILED quote a second time.
      await seamMessage(client, twin, {
        messageId: "WAMID-NEW",
        text: "va, gracias",
        occurredAt: new Date("2026-08-30T03:35:00Z"),
      });
      const model = scriptedModel(extracted(quote));
      const again = await runDailyExtraction(
        { ...depsFor(client, twin), harness: model.harness },
        new Date("2026-08-30T03:45:00Z"),
        { reextract: true },
      );

      expect(again).toMatchObject({ extracted: 1, filed: 0 });
      expect(await readFacts(client, twin)).toHaveLength(1);
      expect(await countLines(client, twin)).toBe(2); // the entity create + the one quote
      // The window starts at the watermark, so the covered message was
      // never even shown: this is why a re-read cannot double-file.
      const turn = latestPromptOf(model.requests[0]!);
      expect(turn).toContain("WAMID-NEW");
      expect(turn).not.toContain("WAMID-ONCE");
    });
  });

  it("leaves the production rule where it was: the database still refuses a second SCHEDULED run for one (twin, chat, day)", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      // A bound chat, so this twin has a thread of its own: the ADR-0033
      // invariant derives it from `system_send`, and a twin with runs and
      // no thread is one it cannot evaluate — which it correctly reports
      // as a violation rather than a pass.
      await inScope(client, twin, twin.chat);
      await bindChat(client, twin, twin.chat, "Ferretería Fuentes");
      const insertRun = (steering: boolean): Promise<unknown> =>
        client.query(
          `INSERT INTO extraction_runs
             (twin_id, chat_jid, extraction_day, state, window_start,
              window_end, settled_at, steering)
           VALUES ($1, $2, '2026-08-29', 'filed',
                   '2026-08-29T06:00:00Z', '2026-08-30T03:29:00Z', now(), $3)`,
          [twin.twinId, twin.chat, steering],
        );
      await insertRun(false);

      // The same rule on the same columns as before ticket #67: a second
      // scheduled run for one chat's day cannot commit.
      await expect(insertRun(false)).rejects.toMatchObject({
        code: "23505",
        constraint: "extraction_runs_one_per_twin_chat_day",
      });

      // A STEERING run for the same chat and day is a different row, and
      // the rule deliberately does not see it.
      await expect(insertRun(true)).resolves.toBeDefined();
    });
  });

  it("never steers on the clock's read: the evening's run reads a chat once a day however often the clock is asked", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await inScope(client, twin, twin.chat);
      await bindChat(client, twin, twin.chat, "Ferretería Fuentes");
      await seamMessage(client, twin, {
        messageId: "WAMID-EVENING",
        text: "te las dejo en 4500",
        occurredAt: MORNING,
        fromMe: true,
      });

      expect(await scheduledPass(depsFor(client, twin, extracted()), NOW)).toBe(1);

      // More traffic, then the clock's next four passes — the model is
      // scripted EMPTY, so a second read of the day would fail loudly.
      await seamMessage(client, twin, {
        messageId: "WAMID-LATER",
        text: "y el sábado",
        occurredAt: new Date("2026-08-30T03:35:00Z"),
      });
      for (const minute of [40, 45, 50, 55]) {
        await scheduledPass(depsFor(client, twin), new Date(`2026-08-30T03:${minute}:00Z`));
      }
      const reads = await client.query("SELECT 1 FROM runs WHERE twin_id = $1 AND automation = 'extraction' AND parent_run_id IS NULL", [
        twin.twinId,
      ]);
      expect(reads.rows).toHaveLength(1);

      const runs = await client.query<{ n: string; steering: boolean }>(
        "SELECT count(*) AS n, bool_or(steering) AS steering FROM extraction_runs WHERE twin_id = $1",
        [twin.twinId],
      );
      expect(runs.rows[0]).toMatchObject({ n: "1", steering: false });
    });
  });

  /**
   * ONE INSTANT, THREE PASSES — at the passes, which is where the ticket's
   * coherence claim belongs.
   *
   * The rig's own disclosure TRIGGER additionally refuses an instant whose
   * rep day is later than the seam's (`rig-disclose.ts`, and the rule
   * itself in `rep-clock.test.ts`): a post is keyed `(twin, day)` and a
   * steered post for tomorrow is the post tomorrow gets. So on the rig the
   * three passes still cannot disagree — either they all take the instant,
   * or the disclosure declines it and says so. This test drives the pass
   * directly, one layer under that policy, and proves the day the pass
   * keys is the day the instant names.
   */
  it("keys one day from one instant: extraction's day, the disclosure's day and the correction window all read the same clock", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await inScope(client, twin, twin.chat);
      await bindChat(client, twin, twin.chat, "Ferretería Fuentes");
      await seamMessage(client, twin, {
        messageId: "WAMID-DAY-1",
        text: "te las dejo en 4500",
        occurredAt: MORNING,
        fromMe: true,
      });

      // The 29th, for real: extracted, disclosed, and the post lands.
      await runDailyExtraction(
        depsFor(
          client,
          twin,
          extracted({
            fact_type: "QuoteGiven",
            message_id: "WAMID-DAY-1",
            confidence: 0.9,
            item: "cajas",
            amount: 4500,
            currency: "MXN",
          }),
        ),
        NOW,
      );
      expect(await runDailyDisclosure(depsFor(client, twin), NOW)).toMatchObject(
        { posted: true },
      );
      const reachedAt = new Date("2026-08-30T03:29:00Z");
      const command = await client.query<{ command_id: string }>(
        `SELECT sc.id AS command_id
           FROM notices n
           JOIN send_commands sc ON sc.payload_ref = 'notice:' || n.id
          WHERE n.twin_id = $1 AND n.kind = 'daily_disclosure'`,
        [twin.twinId],
      );
      await simulateExecutorPost(client, {
        commandId: command.rows[0]!.command_id,
        twinId: twin.twinId,
        waMessageId: `WAMID-POST-${twin.twinId.slice(0, 8)}`,
        executedAt: reachedAt,
      });

      // ONE INSTANT drives the session forward — 21:30 on the 30th, a day
      // and a bit past the real clock, which is still on the 29th.
      const steeredTo = new Date("2026-08-31T03:30:00Z");
      const seamNow = new Date("2026-08-30T03:45:00Z");
      // The rep's own message: the second day's fact is their commitment,
      // which is read in their words or not at all (#71).
      await seamMessage(client, twin, {
        messageId: "WAMID-DAY-2",
        text: "y el sábado te confirmo",
        occurredAt: new Date("2026-08-30T03:35:00Z"),
        fromMe: true,
      });

      const extraction = await runDailyExtraction(
        depsFor(
          client,
          twin,
          extracted({
            fact_type: "DatePromised",
            message_id: "WAMID-DAY-2",
            confidence: 0.9,
            commitment: "que entregas el sábado",
          }),
        ),
        steeredTo,
        { seamNow },
      );
      expect(extraction).toMatchObject({ extracted: 1, filed: 1 });
      const disclosure = await runDailyDisclosure(
        depsFor(client, twin),
        steeredTo,
      );
      expect(disclosure).toMatchObject({ posted: true });
      const closed = await finalizeDueFacts(
        { db: client },
        { twinId: twin.twinId },
        steeredTo,
      );

      // ONE DAY, everywhere: the 30th on the rep's clock.
      const runDays = await client.query<{ day: string }>(
        `SELECT extraction_day::text AS day FROM extraction_runs
          WHERE twin_id = $1 ORDER BY started_at`,
        [twin.twinId],
      );
      const postDays = await client.query<{ day: string }>(
        `SELECT disclosure_day::text AS day FROM disclosure_posts
          WHERE twin_id = $1 ORDER BY disclosure_day`,
        [twin.twinId],
      );
      expect(runDays.rows.map((r) => r.day)).toEqual(["2026-08-29", "2026-08-30"]);
      expect(postDays.rows.map((r) => r.day)).toEqual(["2026-08-29", "2026-08-30"]);

      // The 29th's fact finalizes because the STEERED clock says its window
      // closed — and it finalizes at the instant the window really closed,
      // not at the instant the pass was told it was.
      expect(closed.finalized).toBe(1);
      const filed = await readFacts(client, twin);
      const quote = filed.find((f) => f.factType === "QuoteGiven");
      expect(quote?.finalizedAt).toEqual(
        new Date(reachedAt.getTime() + 24 * 3_600_000),
      );
      // ...and the fact the steered day just filed has not been disclosed
      // long enough to finalize, whatever the injected clock says.
      expect(
        filed.find((f) => f.factType === "DatePromised")?.finalizedAt,
      ).toBeNull();

      // ...and the watermark stayed on the seam's clock throughout.
      const watermark = await client.query<{ window_end: Date }>(
        `SELECT window_end FROM extraction_runs
          WHERE twin_id = $1 ORDER BY started_at DESC LIMIT 1`,
        [twin.twinId],
      );
      expect(watermark.rows[0]?.window_end).toEqual(
        new Date(seamNow.getTime() - 60_000),
      );
    });
  });
});

/**
 * WHAT THE MODEL IS TOLD THE DAY IS (ticket #121).
 *
 * Three live sessions filed a wrong date off a relative weekday — #57's
 * «para el lunes» as a Tuesday, #69's as a Sunday, #102's as «martes 8 de
 * septiembre» — and the cause was recorded in code at #65: the pass showed
 * the model bare UTC instants, so «el lunes» was being resolved against a
 * timestamp that says neither what weekday today is nor whose calendar it
 * is on.
 *
 * The claim under test is the one thing CI can assert about it (ADR-0028
 * keeps extraction prose out of CI): the line the model is shown is
 * rendered by code from the rep clock the pass already holds, and it says
 * the rep's day rather than the seam's or the transcript's.
 */
describe("the day the extraction pass tells the model it is (#121)", () => {
  /**
   * The rep's clock, steered exactly the way the rig steers it: the string
   * shape `DITO_RIG_NOW` takes, read by the same parser `rigClock()` reads
   * it with — an ISO-8601 instant with its offset spelled out. 21:30 on
   * TUESDAY 1 September in Monterrey, which is #102's own rep day.
   */
  const STEERED_REP_NOW = parseIsoInstant("2026-09-01T21:30:00-06:00")!;

  it("shows the rep's steered day, with its weekday and zone, verbatim in the model's own first line", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await inScope(client, twin, twin.chat);
      await bindChat(client, twin, twin.chat, "Ferretería Fuentes");
      await seamMessage(client, twin, {
        messageId: "WAMID-LUNES",
        text: "te pido 50 bultos de cemento para el lunes",
        occurredAt: MORNING,
      });

      const model = scriptedModel(extracted());
      // The rig's own threading (`rig-extract.ts`): the steered instant is
      // the REP's clock, and `seamNow` stays the real one — so the window
      // is still the seam's 29th while the run is keyed to the rep's 1st.
      await runDailyExtraction(
        { ...depsFor(client, twin), harness: model.harness },
        STEERED_REP_NOW,
        { seamNow: NOW },
      );

      // A literal, read off a calendar rather than recomputed: 1 September
      // 2026 is a Tuesday, and it is the day the REP is on — the seam is
      // still living on Saturday the 29th and every message in the
      // transcript below is stamped that day. The hour is the pass's own
      // `now`, the steered 21:30, so «mañana» said late has a side of
      // midnight to be read against (ticket #139).
      //
      // UNDER ITS OWN HEADING, which is the runtime's rendering rather than
      // this automation's (ticket #194): `renderParts` gives every context
      // part a `## name` line, and `now` is the FIRST part —
      // `constructDefinition` refuses an automation whose first one is not.
      expect(transcriptOf(model).split("\n").slice(0, 3)).toEqual([
        "## now",
        "",
        "[Now: Tuesday, Sep 1, 2026, 21:30:00 CST (America/Monterrey)]",
      ]);
      // ...and the beat carries the day IT was said on, on the same
      // clock (#139). 15:20 UTC on Saturday the 29th is 09:20 in
      // Monterrey — a different day from the header above, which is the
      // whole point: one line cannot say what day each beat was said on.
      expect(transcriptOf(model)).toContain(
        "[WAMID-LUNES] [Saturday, Aug 29, 2026, 09:20:00 CST] customer: te pido 50 bultos de cemento para el lunes",
      );
      // Nothing in the turn is a raw instant any more.
      expect(transcriptOf(model)).not.toContain("2026-08-29T15:20:00");
      // ...and nothing code wrote into it is Spanish (#139, second
      // ruling). The customer's «para el lunes» is the ONLY Spanish
      // weekday in the turn, so there is none in the framing to echo.
      expect(transcriptOf(model).match(/lunes/gu)).toHaveLength(1);
      for (const word of ["martes", "sábado", "Hoy es"]) {
        expect(transcriptOf(model), `framing leaked «${word}»`).not.toContain(
          word,
        );
      }
    });
  });

  /**
   * A WINDOW THAT IS NOT ONE REP DAY (ticket #139; #121's remainder 1).
   *
   * `owedFrom` carries an unread window forward — a run that claimed a
   * chat and died before filing — so a pass keyed to Tuesday can be
   * reading beats said on Sunday and on Monday. Under one day line and raw
   * UTC stamps, a Sunday «para el lunes» was resolved against a sentence
   * saying today is Tuesday, and the beat's own stamp said Monday because
   * 20:30 in Monterrey is 02:30Z the next day. Both halves of that are the
   * same defect and both close here: every beat under its own date.
   */
  it("renders each beat of a multi-day window under the day it was said on", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await inScope(client, twin, twin.chat);
      await bindChat(client, twin, twin.chat, "Aceros del Poniente");
      // 20:30 SUNDAY 30 August on the rep's clock — 02:30Z on the Monday,
      // which is the stamp the model used to be shown.
      await seamMessage(client, twin, {
        messageId: "WAMID-DOMINGO",
        text: "me manda 25 rollos el lunes?",
        occurredAt: new Date("2026-08-31T02:30:00Z"),
      });
      // ...and a beat on the MONDAY, so the window really spans two days.
      await seamMessage(client, twin, {
        messageId: "WAMID-LUNES-DIA",
        text: "va, se los mando",
        occurredAt: new Date("2026-08-31T16:05:00Z"),
        fromMe: true,
      });

      // The debt: a run that claimed Sunday the 30th and never filed. Its
      // window start is the only record that the day is still owed, and it
      // is what opens today's window back on the Sunday.
      await client.query(
        `INSERT INTO extraction_runs
           (twin_id, chat_jid, extraction_day, state, window_start, window_end)
         VALUES ($1, $2, '2026-08-30', 'submitted',
                 '2026-08-30T06:00:00Z', '2026-08-31T03:29:00Z')`,
        [twin.twinId, twin.chat],
      );

      const model = scriptedModel(extracted());
      await runDailyExtraction(
        { ...depsFor(client, twin), harness: model.harness },
        parseIsoInstant("2026-09-01T21:30:00-06:00")!,
        { seamNow: new Date("2026-09-02T03:30:00Z") },
      );

      const turn = transcriptOf(model);
      // Literals off a calendar: 30 August 2026 is a Sunday and the 31st a
      // Monday. The two beats sit under different dates, and the Sunday one
      // is NOT the Monday its UTC instant would have named.
      expect(turn).toContain(
        "[WAMID-DOMINGO] [Sunday, Aug 30, 2026, 20:30:00 CST] customer: me manda 25 rollos el lunes?",
      );
      expect(turn).toContain(
        "[WAMID-LUNES-DIA] [Monday, Aug 31, 2026, 10:05:00 CST] rep: va, se los mando",
      );
      // ...beneath a header that is neither of them, under the `now` part's
      // own heading (#194; `renderParts`).
      expect(turn.split("\n").slice(0, 3)).toEqual([
        "## now",
        "",
        "[Now: Tuesday, Sep 1, 2026, 21:30:00 CST (America/Monterrey)]",
      ]);
    });
  });
});

/**
 * EXTRACTION ON THE SHARED RUNTIME (ticket #194; spec #193 decisions 10, 12,
 * 19, 25 and 28; ADR-0010 as amended, ADR-0016, ADR-0020).
 *
 * The three claims the pass's own suite above cannot make, because each is
 * about the RUNTIME the pass now runs on rather than about what it reads:
 *
 * 1. A customer's turn drafts to completion while an extraction is held
 *    mid-call. This is the whole of what the batch lane buys, and it is
 *    unprovable without two model calls in flight at once.
 * 2. A failed execution costs the chat its day and nothing else — the run
 *    settles `failed`, the pass does not throw, the chat is not re-claimed
 *    today, the disclosure still posts for every other chat, and tomorrow's
 *    window reaches back over the messages.
 * 3. Every execution leaves a record with its lane, its iterations, its
 *    tokens and one content-free chain entry, and the run row names it.
 *
 * Real Postgres, real envelope crypto, real SQLCipher (ADR-0028); the model
 * is the scripted model server and CI never calls one.
 */
describe("extraction runs as an execution on the batch lane (#194)", () => {
  /** A model that ends its turn in prose — a run that never submits. */
  function neverSubmits(): ScriptedTurn[] {
    // `end_turn`, so nothing is truncated: this is a model that would not
    // finish, not a budget that ran out.
    return [{ text: "no puedo" }];
  }

  it("drafts a customer's turn to completion while an extraction is held mid-call", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await inScope(client, twin, twin.chat);
      await bindChat(client, twin, twin.chat, "Ferretería Fuentes");
      const asked = await seamMessage(client, twin, {
        messageId: "WAMID-CONCURRENT",
        text: "¿en cuánto me dejas las 100 cajas?",
        occurredAt: MORNING,
      });

      // THE GATE. The extraction's model call blocks on this promise, so the
      // execution is provably still inside its own transaction while the
      // drafting turn below runs to completion. Two scripted wires rather
      // than one, so which request is held is a fact about which DEPS made
      // it rather than about the order they happened to arrive in.
      let release = (): void => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let started = (): void => {};
      const reached = new Promise<void>((resolve) => {
        started = resolve;
      });
      const extraction = scriptedModel(
        extracted({
          fact_type: "OrderRequested",
          message_id: "WAMID-CONCURRENT",
          confidence: 0.95,
          item: "cajas",
          quantity: 100,
        }),
        {
          onRequest: async () => {
            started();
            await held;
          },
        },
      );

      // THE CLOCK FIRES THE DAY'S RUN, and the engine hands its steps to the
      // batch lane: the first pass runs the claim and parks on the children,
      // the second hands the child's read to the lane and returns while it is
      // inside its model call.
      const deps = { ...depsFor(client, twin), harness: extraction.harness };
      await ensureShippedAutomations(client, { twinId: twin.twinId, seatId: twin.seatId }, YESTERDAY);
      const batch = openBatchWork();
      const engine = createRunEngine();
      expect(await fireDueCadences(deps, NOW, batch)).toBe(1);
      await advanceRuns({ ...deps, runs: engine }, NOW, batch);
      await batch.lane.settle();
      await advanceRuns({ ...deps, runs: engine }, NOW, batch);
      await reached;
      expect(extraction.requests).toHaveLength(1);

      // A RULE, so the pass's other pending events — the binding fixture's
      // «si» in the twin thread — are answered too rather than eating the
      // drafting turn (`thread-script.ts`).
      const drafting = scriptedModel((prompt) =>
        isThreadTurn(prompt)
          ? qaSilenceTurns()
          : [
              { toolCall: { name: "create_draft", input: { text: "te las dejo en 4500" } } },
              { text: "done" },
            ],
      );
      try {
        await processPendingWaEvents({
          ...consumerDepsFor(client, twin),
          harness: drafting.harness,
        });

        // THE CLAIM: the draft exists while the extraction has not finished.
        const drafted = await client.query<{ n: string }>(
          "SELECT count(*) AS n FROM drafts WHERE twin_id = $1",
          [twin.twinId],
        );
        expect(Number(drafted.rows[0]!.n)).toBe(1);
        const midFlight = await readRuns(client, twin);
        expect(midFlight[0]).toMatchObject({ state: "submitted" });
      } finally {
        // ALWAYS, so an assertion that fails above leaves no model call
        // waiting on a promise nobody will resolve — a hung suite says
        // nothing about which claim broke.
        release();
        await batch.lane.settle();
      }
      await driveRuns(deps, NOW);
      expect((await readRuns(client, twin))[0]).toMatchObject({
        state: "filed",
        filed: 1,
      });
      expect(asked).toBeTypeOf("string");
    });
  });

  it("shows only what twin memory held BEFORE the window as already handled", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await inScope(client, twin, twin.chat);
      await bindChat(client, twin, twin.chat, "Ferretería Fuentes");
      // The day itself: one message inside the window.
      await seamMessage(client, twin, {
        messageId: "WAMID-TODAY",
        text: "te pido 100 cajas",
        occurredAt: MORNING,
      });
      // Twin memory holds three things: one line from BEFORE the window, the
      // day's own line, and one that arrived AFTER the window closed — inside
      // the settling lag, or while this execution waited its turn on a lane
      // capped at one.
      for (const row of [
        { messageId: "WAMID-BEFORE", text: "buenas tardes", at: YESTERDAY },
        { messageId: "WAMID-TODAY", text: "te pido 100 cajas", at: MORNING },
        { messageId: "WAMID-AFTER", text: "y otra cosa", at: NOW },
      ]) {
        twin.bundle.ingestMessage({
          chatJid: twin.chat,
          messageId: row.messageId,
          senderJid: twin.chat,
          fromMe: false,
          occurredAt: row.at.toISOString(),
          content: row.text,
        });
      }

      const model = scriptedModel(extracted());
      await runDailyExtraction(
        { ...depsFor(client, twin), harness: model.harness },
        NOW,
      );

      const turn = transcriptOf(model);
      // WHAT CAME BEFORE, and only that. The window's own beat stands under
      // the day's heading with its id; the line that arrived after the window
      // closed belongs to no block at all — putting it under "already
      // handled" would tell the model a request it has never seen was dealt
      // with, and would displace the history this block exists to carry.
      expect(turn).toContain("counterparty: buenas tardes");
      expect(turn).toContain("[WAMID-TODAY]");
      expect(turn).not.toContain("y otra cosa");
      // ...and the day's own line is not under BOTH headings (#75's AC 3).
      expect(turn.match(/te pido 100 cajas/gu)).toHaveLength(1);
    });
  });

  it("starts no second run and no second read while the day's read is in flight", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await inScope(client, twin, twin.chat);
      await bindChat(client, twin, twin.chat, "Ferretería Fuentes");
      await seamMessage(client, twin, {
        messageId: "WAMID-IN-FLIGHT",
        text: "te pido 100 cajas",
        occurredAt: MORNING,
      });

      let release = (): void => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let started = (): void => {};
      const reached = new Promise<void>((resolve) => {
        started = resolve;
      });
      const extraction = scriptedModel(
        extracted({
          fact_type: "OrderRequested",
          message_id: "WAMID-IN-FLIGHT",
          confidence: 0.95,
          item: "cajas",
          quantity: 100,
        }),
        {
          onRequest: async () => {
            started();
            await held;
          },
        },
      );

      const deps = { ...depsFor(client, twin), harness: extraction.harness };
      await ensureShippedAutomations(client, { twinId: twin.twinId, seatId: twin.seatId }, YESTERDAY);
      const batch = openBatchWork();
      const engine = createRunEngine();
      expect(await fireDueCadences(deps, NOW, batch)).toBe(1);
      await advanceRuns({ ...deps, runs: engine }, NOW, batch);
      await batch.lane.settle();
      await advanceRuns({ ...deps, runs: engine }, NOW, batch);
      await reached;

      try {
        // The next ticks: the clock has fired today's instant, and the engine
        // holds the child it is driving — so neither starts anything again.
        const later = new Date(NOW.getTime() + 2000);
        expect(await fireDueCadences(deps, later, batch)).toBe(0);
        await advanceRuns({ ...deps, runs: engine }, later, batch);
        expect(await readRuns(client, twin)).toHaveLength(1);
        expect(extraction.requests).toHaveLength(1);
      } finally {
        release();
        await batch.lane.settle();
      }
      await driveRuns(deps, NOW);
      expect((await readRuns(client, twin))[0]).toMatchObject({
        state: "filed",
        filed: 1,
      });
    });
  });

  it("records a failed execution, settles its run, and lets the day's disclosure post anyway", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await inScope(client, twin, twin.chat, twin.otherChat);
      await bindChat(client, twin, twin.chat, "Ferretería Fuentes");
      await bindChat(client, twin, twin.otherChat, "Sra. Garza");
      await seamMessage(client, twin, {
        messageId: "WAMID-UNREAD",
        text: "te pido 100 cajas",
        occurredAt: MORNING,
      });
      await seamMessage(client, twin, {
        messageId: "WAMID-OTHER",
        text: "te las dejo en 4500",
        occurredAt: MORNING,
        chatJid: twin.otherChat,
        fromMe: true,
      });

      // A RULE, NOT A LIST: which chat fails is decided by what the model was
      // SHOWN, so the claim is about one chat's day rather than about the
      // order two executions happened to run in.
      const model = scriptedModel((prompt) =>
        prompt.includes("WAMID-UNREAD")
          ? neverSubmits()
          : extracted({
              fact_type: "QuoteGiven",
              message_id: "WAMID-OTHER",
              confidence: 0.95,
              item: "cajas",
              amount: 4500,
              currency: "MXN",
            }),
      );
      const result = await runDailyExtraction(
        { ...depsFor(client, twin), harness: model.harness },
        NOW,
      );

      // THE RUN DID NOT FAIL, and it says what happened: the chat whose read
      // filed nothing is settled `failed` by the run's last step.
      expect(result).toMatchObject({ chats: 2, extracted: 2, failed: 1, filed: 1 });
      // ...and the day is SETTLED, which is what lets the disclosure post:
      // one chat the model would not read cannot silence it.
      expect(result.settled).toBe(true);

      const runs = await readRuns(client, twin);
      const failedRun = runs.find((run) => run["chat_jid"] === twin.chat);
      expect(failedRun).toMatchObject({
        state: "failed",
        candidates: 0,
        filed: 0,
        below_threshold: 0,
        unresolved_reference: 0,
        refused: 0,
      });
      // Settled, with an instant — the store's own `settled_check` ties the
      // two together for every state but `submitted`.
      expect(failedRun?.["settled_at"]).not.toBeNull();
      // ...and the read that filed nothing is on the record by what it did:
      // it spoke and filed nothing, so its step records no filing.
      const reads = await client.query<{ disposition: string; lane: string; trigger_kind: string }>(
        `SELECT e.disposition, e.lane, e.trigger_kind
           FROM executions e JOIN run_steps s ON s.execution_id = e.id AND s.kind = 'agent'
           JOIN runs r ON r.id = s.run_id
          WHERE r.twin_id = $1 ORDER BY e.disposition`,
        [twin.twinId],
      );
      expect(reads.rows).toEqual([
        { disposition: "answered", lane: "batch", trigger_kind: "run_step" },
        { disposition: "filed", lane: "batch", trigger_kind: "run_step" },
      ]);

      // THE OTHER CHAT FILED, and the day's disclosure posts.
      expect(await readFacts(client, twin)).toHaveLength(1);
      const posted = await runDailyDisclosure(
        depsFor(client, twin),
        NOW,
      );
      expect(posted.posted).toBe(true);

      // NOT RE-CLAIMED TODAY. The model is scripted EMPTY for a second run,
      // so a re-read would fail loudly rather than quietly costing a call.
      const again = await runDailyExtraction(depsFor(client, twin, []), NOW);
      expect(again).toMatchObject({ extracted: 0, failed: 0 });
      expect(
        (await readRuns(client, twin)).find(
          (run) => run["chat_jid"] === twin.chat,
        ),
      ).toMatchObject({ state: "failed" });

      // ...AND TOMORROW'S WINDOW REACHES BACK OVER THE SKIPPED MESSAGES.
      // Only a `filed` run advances the watermark, so the failed run's own
      // window is still owed and `owedFrom` carries it into the next day.
      const tomorrow = scriptedModel(extracted());
      await runDailyExtraction(
        { ...depsFor(client, twin), harness: tomorrow.harness },
        new Date("2026-08-31T03:30:00Z"),
      );
      expect(transcriptOf(tomorrow)).toContain("WAMID-UNREAD");
    });
  });

  it("leaves one execution record and one chain entry per run, with its lane and its spend", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await inScope(client, twin, twin.chat);
      await bindChat(client, twin, twin.chat, "Ferretería Fuentes");
      await seamMessage(client, twin, {
        messageId: "WAMID-RECORDED",
        text: "te las dejo en 4500",
        occurredAt: MORNING,
        fromMe: true,
      });

      await runDailyExtraction(
        depsFor(
          client,
          twin,
          extracted({
            fact_type: "QuoteGiven",
            message_id: "WAMID-RECORDED",
            confidence: 0.95,
            item: "cajas",
            amount: 4500,
            currency: "MXN",
          }),
        ),
        NOW,
      );

      // THE CHILD'S READ IS ONE EXECUTION of the run's steps, and the one
      // that read the chat — the agent step.
      const executions = await client.query<Record<string, unknown>>(
        `SELECT e.* FROM executions e
           JOIN run_steps s ON s.execution_id = e.id AND s.kind = 'agent'
           JOIN runs r ON r.id = s.run_id
          WHERE r.twin_id = $1`,
        [twin.twinId],
      );
      expect(executions.rows).toHaveLength(1);
      const execution = executions.rows[0]!;
      expect(execution).toMatchObject({
        trigger_kind: "run_step",
        trigger_mechanism: "request",
        lane: "batch",
        disposition: "filed",
        // The three reads and the filing (tickets #196, #364), in the order
        // the definition names them — which is the order the model is shown
        // them in.
        tool_names: ["search_chat_history", "list_chats", "read_filed_facts", "file_facts"],
      });
      // Two rounds: the filing, and the turn the runner asks for after
      // serving its tool result. Both are counted, and so is what they spent.
      expect(Number(execution["iterations"])).toBe(2);
      expect(Number(execution["tokens_input"])).toBeGreaterThan(0);
      expect(Number(execution["tokens_output"])).toBeGreaterThan(0);
      // CONTENT-FREE, and the store's own CHECK says so too: no JID reaches
      // the reference (ADR-0004, ADR-0020).
      const ref = String(execution["trigger_ref"]);
      expect(ref).not.toContain("@");
      expect(ref).toContain(`trigger:run_step mechanism:request twin:${twin.twinId}`);

      // The run row names it, which is the join `extraction_runs.execution_id`
      // exists for.
      const joined = await client.query<{ n: string }>(
        `SELECT count(*) AS n FROM extraction_runs r
          WHERE r.twin_id = $1 AND r.execution_id = $2`,
        [twin.twinId, execution["id"]],
      );
      expect(Number(joined.rows[0]!.n)).toBe(1);

      // ONE ENTRY BESIDE IT, carrying the same reference from the same
      // renderer — the pair ADR-0020's coverage check looks for.
      const entries = await client.query<{ caller: string; action: string; outcome: string }>(
        `SELECT caller, action, outcome FROM audit_chain
          WHERE action = 'execution' AND ref = $1 || ' instructions:' || $2`,
        [ref, execution["instructions_digest"]],
      );
      expect(entries.rows).toEqual([
        { caller: "execution", action: "execution", outcome: "filed" },
      ]);
    });
  });

  it("stamps the chain entry and the settle at the instant they were written, not at the transaction's start", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await inScope(client, twin, twin.chat);
      await bindChat(client, twin, twin.chat, "Ferretería Fuentes");
      await seamMessage(client, twin, {
        messageId: "WAMID-STAMPED",
        text: "te las dejo en 4500",
        occurredAt: MORNING,
        fromMe: true,
      });

      // THE MODEL CALL IS HELD, which is what puts a measurable distance
      // between the transaction's start and its filing statements — the rig's
      // shape (…20260906100040), compressed to something a suite can wait
      // for. A timer rather than a lock, because nothing here needs another
      // execution: one call, held.
      const model = scriptedModel(
        extracted({
          fact_type: "QuoteGiven",
          message_id: "WAMID-STAMPED",
          confidence: 0.95,
          item: "cajas",
          amount: 4500,
          currency: "MXN",
        }),
        {
          onRequest: async () => {
            await new Promise((resolve) => setTimeout(resolve, HELD_CALL_MS));
          },
        },
      );
      await runDailyExtraction(
        { ...depsFor(client, twin), harness: model.harness },
        NOW,
      );

      // THE CLAIM: every stamp this execution wrote is AT OR AFTER the
      // instant the runner started it (#200 hotfix 1). Under `now()` the
      // chain entry landed strictly BEFORE `started_at` — the transaction
      // opens, the runner then takes its own clock — so the entry the audit
      // reads as the append instant was really the instant the transaction
      // began, early by the whole model call.
      const stamps = await client.query<{
        chain_after_start_ms: string;
        settle_after_start_ms: string;
      }>(
        `SELECT (EXTRACT(EPOCH FROM (c.created_at - e.started_at)) * 1000)::bigint
                  AS chain_after_start_ms,
                (EXTRACT(EPOCH FROM (r.settled_at - e.started_at)) * 1000)::bigint
                  AS settle_after_start_ms
           FROM executions e
           JOIN extraction_runs r ON r.execution_id = e.id
           JOIN audit_chain c
             ON c.ref = e.trigger_ref || ' instructions:' || e.instructions_digest
          WHERE e.twin_id = $1`,
        [twin.twinId],
      );
      expect(stamps.rows).toHaveLength(1);
      const written = stamps.rows[0]!;
      expect(Number(written.chain_after_start_ms)).toBeGreaterThanOrEqual(
        HELD_CALL_MS,
      );
      expect(Number(written.settle_after_start_ms)).toBeGreaterThanOrEqual(
        HELD_CALL_MS,
      );
    });
  });
});

/**
 * LOOKING BEFORE FILING, AT THE SEAM (ticket #196; spec #193 decisions 12, 18
 * and 19; ADR-0033, ADR-0038, ADR-0039 as amended).
 *
 * The reads are REAL — a real bundle, a real vector store, the real
 * connection — and only the model's calls are scripted, which is what makes a
 * resolution a claim about the STORE rather than about a fixture. The
 * deterministic fake embedder ranks by word overlap, so what a scripted search
 * finds is exactly assertable with no model in the loop (ADR-0028).
 */

/**
 * One line in twin memory, embedded — what a search can actually find.
 *
 * The daily pass reads the SEAM and never writes twin memory; ingest does,
 * and these suites drive the pass alone. So the history a resolution rests on
 * is seeded here, exactly as `backlog.ts` writes it: the row, then its vector
 * through the same embedder the deps carry.
 */
async function remember(
  twin: Twin,
  args: {
    chatJid: string;
    messageId: string;
    text: string;
    occurredAt: Date;
    fromMe?: boolean;
    pushName?: string;
  },
): Promise<void> {
  const stored = twin.bundle.ingestMessage({
    chatJid: args.chatJid,
    messageId: args.messageId,
    senderJid: args.fromMe === true ? SELF_CHAT : args.chatJid,
    fromMe: args.fromMe ?? false,
    occurredAt: args.occurredAt.toISOString(),
    content: args.text,
    ...(args.pushName === undefined ? {} : { pushName: args.pushName }),
  });
  twin.bundle.writeMessageVector(
    stored.storeId,
    await embedOne(fakeEmbedder(), args.text),
  );
}

/** The line the rep is told about one entity, most recent last. */
async function readLines(
  client: pg.Client,
  twin: Twin,
): Promise<string[]> {
  const res = await client.query<{ rendered_text: string }>(
    `SELECT rendered_text FROM disclosure_lines
      WHERE twin_id = $1 AND subject_kind = 'fact'
      ORDER BY filed_at, id`,
    [twin.twinId],
  );
  return res.rows.map((row) => row.rendered_text);
}

/** A day that searches its own chat's history and then submits. */
const LOOKING_ORDER = {
  fact_type: "OrderRequested",
  message_id: "WAMID-1",
  confidence: 0.95,
  reading: "resolved_reference",
  item: "bultos de mortero",
  quantity: 500,
};

describe("the extraction looks before it files (ticket #196)", () => {
  it("resolves a back-reference in the same chat, files the goods, and marks the line", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await inScope(client, twin, twin.chat);
      await bindChat(client, twin, twin.chat, "Ferretería Fuentes");
      // What that customer ordered a week ago, in twin memory and nowhere in
      // the day the model is shown.
      await remember(twin, {
        chatJid: twin.chat,
        messageId: "WAMID-LASTWEEK",
        text: "mándame 500 bultos de mortero",
        occurredAt: new Date("2026-08-22T16:00:00Z"),
        pushName: "Fuentes",
      });
      // ...and today's message, which only points at it.
      await seamMessage(client, twin, {
        messageId: "WAMID-1",
        text: "me mandas lo mismo del pedido pasado?",
        occurredAt: MORNING,
      });

      const model = scriptedModel(
        extractionTurns({
          looks: [
            {
              tool: "search_chat_history",
              input: { about: "mortero pedido pasado", chat: null },
            },
          ],
          facts: [LOOKING_ORDER],
        }),
      );
      await runDailyExtraction(
        { ...depsFor(client, twin), harness: model.harness },
        NOW,
      );

      // THE SEARCH REALLY RAN AND REALLY FOUND IT: request 2 carries the
      // tool's own result back into the conversation.
      expect(toolResultsOf(model.requests[1]).join("\n")).toContain(
        "mándame 500 bultos de mortero",
      );
      // The line carries the goods it referred to, and the mark that says so
      // — generic, naming no order and no chat.
      const lines = await readLines(client, twin);
      expect(lines).toEqual([
        "Te pidió 500 bultos de mortero — sin precio, sin fecha. (por referencia)",
      ]);
      expect(lines[0]).not.toContain("WAMID");
      expect(lines[0]).not.toContain("pedido pasado");
      // ...and the run counts one resolution beside the facts it filed.
      const runs = await readRuns(client, twin);
      expect(runs[0]).toMatchObject({
        state: "filed",
        candidates: 1,
        filed: 1,
        resolved_reference: 1,
        unresolved_reference: 0,
      });
    });
  });

  it("resolves a reference into ANOTHER customer's conversation", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await inScope(client, twin, twin.chat, twin.otherChat);
      await bindChat(client, twin, twin.chat, "Ferretería Fuentes");
      await bindChat(client, twin, twin.otherChat, "Torres");
      // What TORRES ordered — in Torres's own conversation.
      await remember(twin, {
        chatJid: twin.otherChat,
        messageId: "WAMID-TORRES",
        text: "mándame 500 bultos de mortero",
        occurredAt: new Date("2026-08-22T16:00:00Z"),
        pushName: "Torres",
      });
      await seamMessage(client, twin, {
        messageId: "WAMID-1",
        text: "mándame lo mismo que a Torres",
        occurredAt: MORNING,
      });

      const model = scriptedModel(
        // The shape a cross-chat resolution really takes: find out who Torres
        // is, then look in that conversation by the reference the list served.
        extractionTurns({
          looks: [
            { tool: "list_chats", input: {} },
            {
              tool: "search_chat_history",
              input: { about: "mortero", chat: 2 },
            },
          ],
          facts: [LOOKING_ORDER],
        }),
      );
      await runDailyExtraction(
        { ...depsFor(client, twin), harness: model.harness },
        NOW,
      );

      // `list_chats` names the customers and carries NO content — read off
      // what it SERVED rather than off the whole request body.
      const listed = toolResultsOf(model.requests[1]);
      expect(listed).toHaveLength(1);
      expect(listed[0]).toContain("[chat 1] Ferretería Fuentes");
      expect(listed[0]).toContain("[chat 2] Torres");
      expect(listed[0]).not.toContain("mortero");
      // The narrowed search found Torres's own order.
      expect(toolResultsOf(model.requests[2]).join("\n")).toContain(
        "mándame 500 bultos de mortero",
      );
      expect(await readLines(client, twin)).toContain(
        "Te pidió 500 bultos de mortero — sin precio, sin fecha. (por referencia)",
      );
      const runs = await readRuns(client, twin);
      const fuentes = runs.find((row) => row["chat_jid"] === twin.chat);
      expect(fuentes).toMatchObject({ filed: 1, resolved_reference: 1 });
    });
  });

  it("drops a candidate the model could not settle, files nothing, and counts it", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await inScope(client, twin, twin.chat);
      await bindChat(client, twin, twin.chat, "Ferretería Fuentes");
      // TWO differing orders in that customer's history — the case the model
      // must not choose between.
      await remember(twin, {
        chatJid: twin.chat,
        messageId: "WAMID-A",
        text: "mándame 500 bultos de mortero",
        occurredAt: new Date("2026-08-22T16:00:00Z"),
        pushName: "Fuentes",
      });
      await remember(twin, {
        chatJid: twin.chat,
        messageId: "WAMID-B",
        text: "mándame 200 bultos de mortero",
        occurredAt: new Date("2026-08-25T16:00:00Z"),
        pushName: "Fuentes",
      });
      await seamMessage(client, twin, {
        messageId: "WAMID-1",
        text: "me mandas lo mismo del pedido pasado?",
        occurredAt: MORNING,
      });

      const model = scriptedModel(
        extractionTurns({
          looks: [
            {
              tool: "search_chat_history",
              input: { about: "bultos de mortero", chat: null },
            },
          ],
          facts: [
            {
              ...LOOKING_ORDER,
              reading: "unresolved_reference",
              item: "lo mismo del pedido pasado",
              quantity: null,
            },
          ],
        }),
      );
      await runDailyExtraction(
        { ...depsFor(client, twin), harness: model.harness },
        NOW,
      );

      // The search really returned both, which is the fixture's own claim.
      const served = toolResultsOf(model.requests[1]).join("\n");
      expect(served).toContain("500 bultos");
      expect(served).toContain("200 bultos");
      // No fact, no post, no line, and the drop counted.
      expect(await readFacts(client, twin)).toEqual([]);
      expect(await countLines(client, twin)).toBe(1); // the entity create
      expect(await countPosts(client, twin)).toBe(1); // the binding's own
      expect((await readRuns(client, twin))[0]).toMatchObject({
        state: "filed",
        candidates: 1,
        filed: 0,
        unresolved_reference: 1,
        resolved_reference: 0,
      });
    });
  });

  it("drops a reference the search cannot find at all", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await inScope(client, twin, twin.chat);
      await bindChat(client, twin, twin.chat, "Ferretería Fuentes");
      // Twin memory holds one line, and it is about something else entirely.
      await remember(twin, {
        chatJid: twin.chat,
        messageId: "WAMID-OTHER",
        text: "buenas tardes",
        occurredAt: new Date("2026-08-22T16:00:00Z"),
        pushName: "Fuentes",
      });
      await seamMessage(client, twin, {
        messageId: "WAMID-1",
        text: "me mandas lo mismo del pedido pasado?",
        occurredAt: MORNING,
      });

      const model = scriptedModel(
        extractionTurns({
          looks: [
            {
              tool: "search_chat_history",
              input: { about: "pedido pasado", chat: null },
            },
          ],
          facts: [
            {
              ...LOOKING_ORDER,
              reading: "unresolved_reference",
              item: "lo mismo del pedido pasado",
              quantity: null,
            },
          ],
        }),
      );
      await runDailyExtraction(
        { ...depsFor(client, twin), harness: model.harness },
        NOW,
      );

      expect(await readFacts(client, twin)).toEqual([]);
      expect((await readRuns(client, twin))[0]).toMatchObject({
        unresolved_reference: 1,
        resolved_reference: 0,
      });
    });
  });

  it("asks about a resolved candidate below the gate, with the mark on its claim (ADR-0039)", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await inScope(client, twin, twin.chat);
      await bindChat(client, twin, twin.chat, "Ferretería Fuentes");
      await remember(twin, {
        chatJid: twin.chat,
        messageId: "WAMID-LASTWEEK",
        text: "mándame 500 bultos de mortero",
        occurredAt: new Date("2026-08-22T16:00:00Z"),
        pushName: "Fuentes",
      });
      await seamMessage(client, twin, {
        messageId: "WAMID-1",
        text: "me mandas lo mismo del pedido pasado?",
        occurredAt: MORNING,
      });

      const model = scriptedModel(
        extractionTurns({
          looks: [
            {
              tool: "search_chat_history",
              input: { about: "mortero", chat: null },
            },
          ],
          // BELOW THE GATE, SO DROPPED (ticket #218). ADR-0039's 2026-09-06
          // amendment sent a resolved reading below the gate to a question,
          // because a «si» settled something; an unsure resolution is still
          // a hole in the twin's record, so the rep is not asked to
          // proofread it.
          facts: [{ ...LOOKING_ORDER, confidence: 0.5 }],
        }),
      );
      await runDailyExtraction(
        { ...depsFor(client, twin), harness: model.harness },
        NOW,
      );

      // NOTHING AT ALL: no fact, no line beyond the binding's own, and no
      // post — with the SEARCH in the loop, which is what tells this case
      // apart from the ordinary below-gate drop. The run's two counters say
      // it looked and that the threshold stopped what it found.
      expect(await readFacts(client, twin)).toEqual([]);
      expect(await countLines(client, twin)).toBe(1);
      expect(await countPosts(client, twin)).toBe(1);
      expect((await readRuns(client, twin))[0]).toMatchObject({
        below_threshold: 1,
        filed: 0,
        resolved_reference: 1,
      });
    });
  });

  it("never serves the twin thread, however the search is scripted", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await inScope(client, twin, twin.chat);
      await bindChat(client, twin, twin.chat, "Ferretería Fuentes");
      // The rep's own note to their twin, in twin memory, saying the thing
      // the search is about to ask for word for word.
      await remember(twin, {
        chatJid: SELF_CHAT,
        messageId: "WAMID-NOTE",
        text: "acuérdame que Fuentes pidió 900 bultos de mortero",
        occurredAt: new Date("2026-08-22T16:00:00Z"),
        fromMe: true,
      });
      await seamMessage(client, twin, {
        messageId: "WAMID-1",
        text: "me mandas lo mismo del pedido pasado?",
        occurredAt: MORNING,
      });

      const model = scriptedModel(
        extractionTurns({
          looks: [
            {
              tool: "search_chat_history",
              input: {
                about: "acuérdame que Fuentes pidió 900 bultos de mortero",
                chat: null,
              },
            },
          ],
          facts: [],
        }),
      );
      await runDailyExtraction(
        { ...depsFor(client, twin), harness: model.harness },
        NOW,
      );

      // The one row in the store is the rep's own, and the search asked for
      // it by its own words. WHAT CAME BACK is what this asserts — the
      // request also carries the model's own query, so the whole body would
      // hold the phrase whatever the tool answered.
      expect(toolResultsOf(model.requests[1])).toEqual([
        "No message in the rep's history matched.",
      ]);
      // ...and the ADR-0033 invariant is green over this corpus.
      expect((await auditSelfChatExclusion(client)).violations).toEqual([]);
    });
  });

  it("puts every tool call on the trace, and the disposition reads the FILING", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await inScope(client, twin, twin.chat);
      await bindChat(client, twin, twin.chat, "Ferretería Fuentes");
      await seamMessage(client, twin, {
        messageId: "WAMID-1",
        text: "me mandas lo mismo del pedido pasado?",
        occurredAt: MORNING,
      });

      const events: TraceEvent[] = [];
      const model = scriptedModel(
        extractionTurns({
          looks: [
            { tool: "list_chats", input: {} },
            {
              tool: "search_chat_history",
              input: { about: "pedido pasado", chat: null },
            },
            { tool: "read_filed_facts", input: { chat: 1 } },
          ],
          // EVERY CANDIDATE THE APERTURE DROPS. The model submitted one; the
          // aperture filed nothing and asked nothing.
          facts: [
            {
              ...LOOKING_ORDER,
              reading: "unresolved_reference",
              item: "lo mismo del pedido pasado",
              quantity: null,
            },
          ],
        }),
      );
      await runDailyExtraction(
        {
          ...depsFor(client, twin),
          harness: model.harness,
          trace: (_trigger, event) => events.push(event),
        },
        NOW,
      );

      // Every call, in the round that made it, with what it answered.
      expect(
        events
          .filter((event) => event.kind === "tool_call")
          .map((event) => event.tool),
      ).toEqual(["list_chats", "search_chat_history", "read_filed_facts", "file_facts"]);
      // THE RULING ON #194: the model filed a candidate and nothing crossed,
      // so the step's record says so — read off the filing tool's outcome.
      const executions = await client.query<{ id: string; disposition: string; tool_names: string[]; trigger_ref: string; instructions_digest: string }>(
        `SELECT e.id, e.disposition, e.tool_names, e.trigger_ref, e.instructions_digest
           FROM executions e JOIN run_steps s ON s.execution_id = e.id AND s.kind = 'agent'
           JOIN runs r ON r.id = s.run_id
          WHERE r.twin_id = $1`,
        [twin.twinId],
      );
      expect(executions.rows[0]).toMatchObject({
        disposition: "nothing-to-file",
        tool_names: ["search_chat_history", "list_chats", "read_filed_facts", "file_facts"],
      });
      // ...and the chain entry attests to the same word.
      const entries = await client.query<{ outcome: string }>(
        `SELECT outcome FROM audit_chain
          WHERE action = 'execution' AND ref = $1 || ' instructions:' || $2`,
        [executions.rows[0]!.trigger_ref, executions.rows[0]!.instructions_digest],
      );
      expect(entries.rows.map((row) => row.outcome)).toEqual(["nothing-to-file"]);
    });
  });

  it("refuses a candidate carrying the number of another chat it read (Codex r2)", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await inScope(client, twin, twin.chat);
      await bindChat(client, twin, twin.chat, "Ferretería Fuentes");
      // ANOTHER conversation, whose words this run is about to read. Its
      // address is the identity ADR-0004 keeps out of the Ledger.
      const other = twin.otherChat;
      const otherNumber = other.split("@")[0]!;
      await remember(twin, {
        chatJid: other,
        messageId: "WAMID-OTHER",
        text: "mándame 500 bultos de mortero",
        occurredAt: new Date("2026-08-22T16:00:00Z"),
        pushName: "Torres",
      });
      await seamMessage(client, twin, {
        messageId: "WAMID-1",
        text: "me mandas lo mismo que a Torres",
        occurredAt: MORNING,
      });

      const model = scriptedModel(
        extractionTurns({
          looks: [
            {
              tool: "search_chat_history",
              input: { about: "mortero", chat: null },
            },
          ],
          // THE HOSTILE SHAPE: the model resolved, and wrote the OTHER
          // conversation's WhatsApp number into the goods. Nothing in the
          // submission contract can see that — the wall is the aperture's.
          facts: [
            {
              ...LOOKING_ORDER,
              item: `500 bultos de mortero (Torres ${otherNumber})`,
            },
          ],
        }),
      );
      await runDailyExtraction(
        { ...depsFor(client, twin), harness: model.harness },
        NOW,
      );

      // The search really read that conversation, which is what makes the
      // number reachable at all.
      expect(toolResultsOf(model.requests[1]).join("\n")).toContain(
        "mándame 500 bultos de mortero",
      );
      // ...and nothing crossed: no fact, no line, and the run counts a
      // REFUSAL rather than a filing.
      expect(await readFacts(client, twin)).toEqual([]);
      expect(await countLines(client, twin)).toBe(1); // the entity create
      expect((await readRuns(client, twin))[0]).toMatchObject({
        state: "filed",
        candidates: 1,
        filed: 0,
        refused: 1,
        // The axis still records that the model RESOLVED it — what the
        // aperture did with it is the counter beside this one.
        resolved_reference: 1,
      });
      // ...and the Ledger wall sweep is green over the corpus this left.
      expect((await auditSelfChatExclusion(client)).violations).toEqual([]);
    });
  });

  it("keeps ADR-0038's fence: a next-day bare agreement files nothing, even with the request in reach", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await inScope(client, twin, twin.chat);
      await bindChat(client, twin, twin.chat, "Ferretería Fuentes");
      // YESTERDAY's request, reachable by search and NOT in today's window.
      await remember(twin, {
        chatJid: twin.chat,
        messageId: "WAMID-YESTERDAY",
        text: "me mandas 100 cajas de cemento?",
        occurredAt: YESTERDAY,
        pushName: "Fuentes",
      });
      // Today: the rep's bare «va», and nothing else.
      await seamMessage(client, twin, {
        messageId: "WAMID-VA",
        text: "va",
        occurredAt: MORNING,
        fromMe: true,
      });

      const model = scriptedModel(
        extractionTurns({
          looks: [
            {
              tool: "search_chat_history",
              input: { about: "cajas de cemento", chat: null },
            },
          ],
          // THE MODEL DISOBEYS, ON PURPOSE (Codex round 3). Scripting an
          // empty submission would only prove the model obeying the
          // contract's «both halves, among the messages you were given»
          // part, and what decision 12 asks is that the FENCE stands: the
          // search hands back yesterday's request, and this submits the
          // cross-day `OrderTaken` it makes possible, citing today's bare
          // «va» as its evidence.
          facts: [
            {
              fact_type: "OrderTaken",
              message_id: "WAMID-VA",
              confidence: 1,
              reading: "resolved_reference",
              item: "cajas de cemento",
              quantity: 100,
            },
          ],
        }),
      );
      await runDailyExtraction(
        { ...depsFor(client, twin), harness: model.harness },
        NOW,
      );

      // The request WAS in reach — the fixture would be vacuous otherwise.
      expect(toolResultsOf(model.requests[1]).join("\n")).toContain(
        "me mandas 100 cajas de cemento?",
      );
      // ...and nothing was paired into an OrderTaken: the window holds no
      // counterparty message, so there is no request among the messages this
      // run was given and the candidate is REFUSED rather than filed.
      expect(await readFacts(client, twin)).toEqual([]);
      expect(await countLines(client, twin)).toBe(1); // the entity create
      // THE FENCE IS A RECORDED UNDER-FILING, not a win: Diego's ruling on
      // #179 is that "an order taken given the next day should show", and it
      // is a product requirement on the horizon (#117) under *Extraction
      // quality*, waiting on labelled cross-day cases and an ADR-0038
      // amendment. Looking resolves a reference the day's own messages make;
      // it does not pair across days.
      expect((await readRuns(client, twin))[0]).toMatchObject({
        state: "filed",
        candidates: 1,
        filed: 0,
        refused: 1,
      });
    });
  });

  it("keeps the record, the entry and the spend when the FILING raises (Codex r1)", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await inScope(client, twin, twin.chat);
      // A BINDING TWIN MEMORY HOLDS AND THE LEDGER DOES NOT — the state the
      // crossing backlog exists for (`crossPendingBindings`): an install
      // carried across slices wakes with bindings the rep confirmed before
      // the Ledger existed. The pass enumerates it, the aperture files
      // against an entity the Ledger's own entity table has no row for, and
      // `ledger_facts_entity_fkey` raises a Postgres error INSIDE the filing.
      // No mock anywhere: the lever is a real invariant on real rows, which
      // is what #194's remainder 7 could not find.
      await bindChat(client, twin, twin.chat, "Ferretería Fuentes", "person", false);
      await seamMessage(client, twin, {
        messageId: "WAMID-1",
        text: "me mandas 100 cajas",
        occurredAt: MORNING,
      });

      const model = scriptedModel(
        extracted({
          fact_type: "OrderRequested",
          message_id: "WAMID-1",
          confidence: 0.95,
          item: "cajas",
          quantity: 100,
        }),
      );
      await runDailyExtraction(
        { ...depsFor(client, twin), harness: model.harness },
        NOW,
      );

      // NOTHING CROSSED, and the aborted statement took nothing with it.
      expect(await readFacts(client, twin)).toEqual([]);
      expect(await countLines(client, twin)).toBe(0);
      // ...but the model call HAPPENED, so its record stands with the
      // runtime's own word on it and the spend it really cost — never
      // fabricated zeroes.
      const executions = await readReads(client, twin);
      expect(executions.rows).toHaveLength(1);
      expect(executions.rows[0]).toMatchObject({ disposition: "failed" });
      expect(Number(executions.rows[0]!["iterations"])).toBeGreaterThan(0);
      expect(Number(executions.rows[0]!["tokens_input"])).toBeGreaterThan(0);
      // ...with EXACTLY ONE entry beside it (ADR-0020's pair), which is what
      // the rollback-and-re-append is for.
      const entries = await client.query<{ outcome: string }>(
        `SELECT outcome FROM audit_chain
          WHERE action = 'execution' AND ref = $1 || ' instructions:' || $2`,
        [executions.rows[0]!["trigger_ref"], executions.rows[0]!["instructions_digest"]],
      );
      expect(entries.rows.map((row) => row.outcome)).toEqual(["failed"]);
      // ...and the run is `failed`, so the chat is not read again today and
      // tomorrow's window still owes its messages.
      expect((await readRuns(client, twin))[0]).toMatchObject({
        state: "failed",
        candidates: 0,
        filed: 0,
      });
    });
  });

  it("lands `failed` with its tokens when a read will not finish inside its rounds", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await inScope(client, twin, twin.chat);
      await bindChat(client, twin, twin.chat, "Ferretería Fuentes");
      await seamMessage(client, twin, {
        messageId: "WAMID-1",
        text: "me mandas lo mismo del pedido pasado?",
        occurredAt: MORNING,
      });

      // ONE LOOK MORE THAN THE STEP'S ROUNDS AND NO FILING: the run's budget
      // stops the loop, so the last is never asked for.
      const model = scriptedModel(
        Array.from({ length: EXTRACTION_MAX_ITERATIONS + 1 }, (): ScriptedTurn => ({
          toolCall: { name: "list_chats", input: {} },
          usage: { inputTokens: 700, outputTokens: 20 },
        })),
      );
      await runDailyExtraction(
        { ...depsFor(client, twin), harness: model.harness },
        NOW,
      );

      expect(model.requests).toHaveLength(EXTRACTION_MAX_ITERATIONS);
      const executions = await readReads(client, twin);
      expect(executions.rows[0]).toMatchObject({ disposition: "failed" });
      expect(Number(executions.rows[0]!["iterations"])).toBe(
        EXTRACTION_MAX_ITERATIONS,
      );
      // The looking was paid for, so the record says what it cost.
      expect(Number(executions.rows[0]!["tokens_input"])).toBe(
        700 * EXTRACTION_MAX_ITERATIONS,
      );
      // The run is `failed`, files nothing, and is not read again today.
      expect((await readRuns(client, twin))[0]).toMatchObject({
        state: "failed",
        filed: 0,
        resolved_reference: 0,
      });
    });
  });
});

/**
 * THE REP'S REQUEST, at the same Postgres seam (tickets #197, #364; spec #193
 * decision 26; ADR-0010 as amended, ADR-0014 as amended).
 *
 * IN THIS FILE RATHER THAN ONE OF ITS OWN, and the reason is CI's: a request
 * starts the extraction's own run, whose steps leave rep-side execution
 * records and one chain entry each, and the workflow mints THIS suite as the
 * extraction corpus and runs `audit-coverage-check --require-acts=rep_execution`
 * and `audit-verify` over it.
 *
 * The request is written as a ROW and never through a helper that bypasses the
 * store: the seam table IS the channel, and every CHECK on it — the
 * content-free parameters, the closed occasion, the paired reason — is part of
 * what these tests are about.
 */
describe("the rep asks for the day's extraction or its post (#197, #364)", () => {
  /** The plane's own record that this twin's rail came up (`rail_status_events`). */
  async function railLinked(
    client: pg.Client,
    twin: Twin,
    status: "qr" | "linked" | "dropped" | "logged_out" = "linked",
  ): Promise<void> {
    await client.query(
      `INSERT INTO rail_status_events (twin_id, status, occurred_at)
       VALUES ($1, $2, $3)`,
      [twin.twinId, status, YESTERDAY],
    );
  }

  /** One request, written the way it is written: an INSERT. */
  async function ask(
    client: pg.Client,
    twin: Twin,
    args: {
      occasion?: "extraction" | "daily_disclosure";
      chatJid?: string;
      parameters?: Record<string, unknown>;
    } = {},
  ): Promise<string> {
    const asked = await client.query<{ id: string }>(
      `INSERT INTO runtime_requests (twin_id, occasion, chat_jid, parameters)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [twin.twinId, args.occasion ?? "extraction", args.chatJid ?? null, JSON.stringify(args.parameters ?? {})],
    );
    return asked.rows[0]!.id;
  }

  async function readRequest(client: pg.Client, id: string): Promise<Record<string, unknown>> {
    const row = await client.query<Record<string, unknown>>(
      `SELECT taken_at, executions, unclaimed, execution_id, run_id, outcome, reason, settled_at
         FROM runtime_requests WHERE id = $1`,
      [id],
    );
    return row.rows[0]!;
  }

  /**
   * Dito's rows for the twin's seat, as the runtime's pass writes them before
   * it serves anything.
   */
  async function dittosRows(client: pg.ClientBase, twinId: string): Promise<void> {
    const seat = await client.query<{ id: string }>("SELECT id FROM seats WHERE twin_id = $1", [twinId]);
    await ensureShippedAutomations(client, { twinId, seatId: seat.rows[0]!.id }, YESTERDAY);
  }

  /** The run a request started, as its row says. */
  async function readRunOf(client: pg.Client, runId: string): Promise<Record<string, unknown>> {
    const row = await client.query<Record<string, unknown>>(
      "SELECT automation, created_by, state, automation_id, woken_by FROM runs WHERE id = $1",
      [runId],
    );
    return row.rows[0]!;
  }

  /**
   * One tick of the runtime's request step, then the engine driven until the
   * run it started has ended, then the request step again — which is what
   * answers the request.
   */
  async function serveAndFinish(deps: DailyExtractionDeps, now: Date): Promise<void> {
    await dittosRows(deps.db, deps.twinId);
    await serveRuntimeRequests(deps, now);
    await driveRuns(deps, now);
    await serveRuntimeRequests(deps, now);
  }

  it("starts the extraction's own run, with the rep as its creator, and answers the request when the run ends", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await inScope(client, twin, twin.chat);
      await bindChat(client, twin, twin.chat, "Ferretería Fuentes");
      await railLinked(client, twin);
      await seamMessage(client, twin, {
        messageId: "WAMID-REQUESTED",
        text: "¿en cuánto me dejas las 100 cajas?",
        occurredAt: MORNING,
      });
      const requestId = await ask(client, twin);
      const deps = depsFor(
        client,
        twin,
        extracted({
          fact_type: "OrderRequested",
          message_id: "WAMID-REQUESTED",
          confidence: 0.9,
          item: "cajas",
          quantity: 100,
        }),
      );
      await dittosRows(client, twin.twinId);
      await serveRuntimeRequests(deps, NOW);
      const taken = await readRequest(client, requestId);
      expect(taken.outcome).toBeNull();
      expect(await readRunOf(client, taken.run_id as string)).toMatchObject({
        automation: "extraction",
        created_by: "rep",
        woken_by: null,
      });
      await driveRuns(deps, NOW);
      await serveRuntimeRequests(deps, NOW);
      const answered = await readRequest(client, requestId);
      expect(answered).toMatchObject({ outcome: "served", reason: null, executions: 1 });
      expect(answered.execution_id).not.toBeNull();
      // THE CLAIM NAMES THE REQUEST, so a requester can wait on its own work.
      const claims = await client.query("SELECT state, request_id FROM extraction_runs WHERE twin_id = $1", [twin.twinId]);
      expect(claims.rows).toEqual([{ state: "filed", request_id: requestId }]);
      expect(await readFacts(client, twin)).toHaveLength(1);
    });
  });

  it("reads only the customer a request names, and leaves the other chat's day owed", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await inScope(client, twin, twin.chat, twin.otherChat);
      await bindChat(client, twin, twin.chat, "Ferretería Fuentes");
      await bindChat(client, twin, twin.otherChat, "Materiales Garza");
      await railLinked(client, twin);
      await seamMessage(client, twin, { messageId: "WAMID-ONE", text: "hola", occurredAt: MORNING });
      await seamMessage(client, twin, {
        messageId: "WAMID-TWO",
        text: "hola",
        occurredAt: MORNING,
        chatJid: twin.otherChat,
      });
      const requestId = await ask(client, twin, { chatJid: twin.chat });
      await serveAndFinish(depsFor(client, twin, extracted()), NOW);
      expect(await readRequest(client, requestId)).toMatchObject({ outcome: "served", executions: 1 });
      const claims = await client.query<{ chat_jid: string }>(
        "SELECT chat_jid FROM extraction_runs WHERE twin_id = $1",
        [twin.twinId],
      );
      expect(claims.rows.map((row) => row.chat_jid)).toEqual([twin.chat]);
    });
  });

  it("re-reads a filed day when the request asks, from where the last read read through", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await inScope(client, twin, twin.chat);
      await bindChat(client, twin, twin.chat, "Ferretería Fuentes");
      await railLinked(client, twin);
      await seamMessage(client, twin, { messageId: "WAMID-FIRST", text: "buenos días", occurredAt: MORNING });
      await runDailyExtraction(depsFor(client, twin, extracted()), NOW);
      await seamMessage(client, twin, {
        messageId: "WAMID-SINCE",
        text: "¿me mandas 5 bultos?",
        occurredAt: new Date(NOW.getTime() + 60_000),
      });
      const later = new Date(NOW.getTime() + 10 * 60_000);
      const model = scriptedModel(extracted());
      const requestId = await ask(client, twin, { parameters: { reextract: true } });
      await serveAndFinish({ ...depsFor(client, twin), harness: model.harness }, later);
      expect(await readRequest(client, requestId)).toMatchObject({ outcome: "served", executions: 1 });
      const shown = transcriptOf(model);
      expect(shown).toContain("WAMID-SINCE");
      expect(shown).not.toContain("WAMID-FIRST");
    });
  });

  it("refuses a request for a twin whose rail is not linked, and one whose automation the rep switched off", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await inScope(client, twin, twin.chat);
      await railLinked(client, twin, "dropped");
      const unlinked = await ask(client, twin);
      await serveRuntimeRequests(depsFor(client, twin), NOW);
      expect(await readRequest(client, unlinked)).toMatchObject({ outcome: "refused", reason: "rail_not_linked", run_id: null });

      await railLinked(client, twin);
      await ensureShippedAutomations(client, { twinId: twin.twinId, seatId: twin.seatId }, YESTERDAY);
      const row = await client.query<{ id: string }>(
        "SELECT id FROM automations WHERE twin_id = $1 AND shipped = 'extraction'",
        [twin.twinId],
      );
      await setAutomationPaused(client, {
        twinId: twin.twinId,
        seatId: twin.seatId,
        automationId: row.rows[0]!.id,
        paused: true,
      });
      const paused = await ask(client, twin);
      await serveRuntimeRequests(depsFor(client, twin), NOW);
      expect(await readRequest(client, paused)).toMatchObject({
        outcome: "refused",
        reason: "automation_paused",
        run_id: null,
      });
    });
  });

  it("refuses a clock the store admits and this runtime cannot use, with no run", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await inScope(client, twin, twin.chat);
      await railLinked(client, twin);
      const requestId = await ask(client, twin, { parameters: { now: "2026-02-31T12:00:00Z" } });
      await serveRuntimeRequests(depsFor(client, twin), NOW);
      expect(await readRequest(client, requestId)).toMatchObject({
        outcome: "refused",
        reason: "malformed_parameter",
        run_id: null,
      });
    });
  });

  it("posts the day's notes as a run of the rep's, and refuses a day nobody has read yet", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await inScope(client, twin, twin.chat);
      await bindChat(client, twin, twin.chat, "Ferretería Fuentes");
      await railLinked(client, twin);
      await seamMessage(client, twin, {
        messageId: "WAMID-QUOTE",
        text: "te las dejo en 4500",
        occurredAt: MORNING,
        fromMe: true,
      });
      // A DAY NOBODY HAS READ: the chat's traffic has no settled claim.
      const early = await ask(client, twin, { occasion: "daily_disclosure" });
      await serveRuntimeRequests(depsFor(client, twin), NOW);
      expect(await readRequest(client, early)).toMatchObject({ outcome: "refused", reason: "chat_in_flight" });

      await runDailyExtraction(
        depsFor(
          client,
          twin,
          extracted({ fact_type: "QuoteGiven", message_id: "WAMID-QUOTE", confidence: 0.9, item: "cajas", amount: 4500, currency: "MXN" }),
        ),
        NOW,
      );
      const asked = await ask(client, twin, { occasion: "daily_disclosure" });
      await serveAndFinish(depsFor(client, twin), NOW);
      const answered = await readRequest(client, asked);
      expect(answered).toMatchObject({ outcome: "served", executions: 1 });
      expect(await readRunOf(client, answered.run_id as string)).toMatchObject({
        automation: "daily_disclosure",
        created_by: "rep",
      });
      expect(await countPosts(client, twin)).toBeGreaterThan(0);
      const posted = await client.query("SELECT 1 FROM disclosure_posts WHERE twin_id = $1", [twin.twinId]);
      expect(posted.rows).toHaveLength(1);
    });
  });

  it("posts the earlier day a request names, under that day's key, on a later pass (Codex r2)", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await inScope(client, twin, twin.chat);
      await bindChat(client, twin, twin.chat, "Ferretería Fuentes");
      await railLinked(client, twin);
      await seamMessage(client, twin, { messageId: "WAMID-EARLIER", text: "te las dejo en 4500", occurredAt: MORNING, fromMe: true });
      await runDailyExtraction(
        depsFor(
          client,
          twin,
          extracted({ fact_type: "QuoteGiven", message_id: "WAMID-EARLIER", confidence: 0.9, item: "cajas", amount: 4500, currency: "MXN" }),
        ),
        NOW,
      );
      // ASKED A DAY LATER, FOR THE DAY THAT WAS READ.
      const nextDay = new Date(NOW.getTime() + 86_400_000);
      const asked = await ask(client, twin, { occasion: "daily_disclosure", parameters: { now: NOW.toISOString() } });
      await serveAndFinish(depsFor(client, twin), nextDay);
      expect(await readRequest(client, asked)).toMatchObject({ outcome: "served", executions: 1 });
      const posted = await client.query<{ disclosure_day: string }>(
        "SELECT disclosure_day::text FROM disclosure_posts WHERE twin_id = $1",
        [twin.twinId],
      );
      expect(posted.rows).toEqual([{ disclosure_day: civilDate(NOW, ZONE) }]);
    });
  });

  it("refuses a day the rep has not lived", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await inScope(client, twin, twin.chat);
      await railLinked(client, twin);
      const tomorrow = new Date(NOW.getTime() + 2 * 86_400_000).toISOString();
      const requestId = await ask(client, twin, { occasion: "daily_disclosure", parameters: { now: tomorrow } });
      await serveRuntimeRequests(depsFor(client, twin), NOW);
      expect(await readRequest(client, requestId)).toMatchObject({ outcome: "refused", reason: "day_not_lived" });
    });
  });

  it("answers a request this build ended before it started a run, and leaves one whose run is still going", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await inScope(client, twin, twin.chat);
      await bindChat(client, twin, twin.chat, "Ferretería Fuentes");
      await railLinked(client, twin);
      await seamMessage(client, twin, { messageId: "WAMID-LONG", text: "hola", occurredAt: MORNING });
      const stranded = await ask(client, twin);
      await client.query("UPDATE runtime_requests SET taken_at = $2 WHERE id = $1", [stranded, NOW]);
      const going = await ask(client, twin);
      await dittosRows(client, twin.twinId);
      // ONE HARNESS FOR THE LIFE OF THE RUN, as a running runtime has it: the
      // run's content and its session are kept in its directory.
      const deps = depsFor(client, twin, extracted());
      await serveRuntimeRequests(deps, NOW);
      await settleStrandedRequests(deps, NOW);
      expect(await readRequest(client, stranded)).toMatchObject({ outcome: "failed", reason: "interrupted" });
      const left = await readRequest(client, going);
      expect(left.outcome).toBeNull();
      expect(left.run_id).not.toBeNull();
      await driveRuns(deps, NOW);
      await serveRuntimeRequests(deps, NOW);
      expect(await readRequest(client, going)).toMatchObject({ outcome: "served", executions: 1 });
    });
  });
});
