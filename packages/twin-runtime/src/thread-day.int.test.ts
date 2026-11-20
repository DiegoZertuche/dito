/**
 * THE TWIN THREAD'S DAY-LONG SESSION, AT THE POSTGRES SEAM (ticket #319;
 * spec #318 decisions 1, 8, 11, 13 and 14; design D1, D3 and D7).
 *
 * The pre-agreed seam: door rows in — `wa_events` in the rep's self-chat,
 * `dashboard_messages` at the bar, the runtime's own events — and out the other
 * side the session row, the conversation file the SDK child wrote, the
 * execution records, the markers, the posts, and what the scripted model was
 * shown. Real Postgres, real envelope crypto, real SQLCipher, the real Claude
 * Agent SDK and its real child; only the model is scripted (ADR-0028), and CI
 * never calls one.
 *
 * EVERY CASE HOLDS ITS OWN REGISTRY AND CLOSES IT, so no SDK child outlives
 * the case that opened it; a case that restarts the runtime closes one
 * registry and opens another, which is exactly what a deploy does.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createBundle, type Bundle } from "@dito/bundle";
import { createDekFromMaterial, type Dek } from "@dito/crypto";
import { renderParts, renderTurnInstant, sessionFile, workspaceOf } from "@dito/execution";
import {
  TWIN_API_ACT_ROUTES,
  TWIN_API_ASK_ROUTES,
  TWIN_API_ROUTES,
  TWIN_API_SEAT_HEADER,
  type TwinExchanges,
  type TwinStreamEvent,
} from "@dito/seam";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { finalizeDueFacts } from "@dito/aperture";
import { canvasOnTheWire, readCanvas, readSpotlight, waitingCandidates, writeCuration } from "./canvas.js";
import { processPendingWaEvents, type TwinRuntimeDeps } from "./consumer.js";
import { readPostsByIds } from "./feed.js";
import { deliverPendingKnocks, type TwinNotifier } from "./notify-tiers.js";
import { composeAnswerPost, documentPart, openSealedParts, type PostPart } from "./posts.js";
import { insertNoticeWithSystemSend } from "./notices.js";
import { dismissDraft } from "./rep-acts.js";
import { createSeatEvents, type SeatEvents } from "./seat-events.js";
import type { Embedder } from "./embedder.js";
import { startLocalApi } from "./local-api.js";
import { createSendLockWriter } from "./send-lock/writer.js";
import { createStreamWatch, type StreamWatch } from "./stream-watch.js";
import {
  resetAndMigrate,
  withClient,
  TEST_AUDIT_HMAC_KEY,
  TEST_DATABASE_URL,
} from "./testing/db.js";
import { disclosedFact } from "./testing/disclosed-fact.js";
import { seatAtTheDoor, typeAtTheDoor, type DoorSeat } from "./testing/door.js";
import { newExecutionPool } from "./testing/execution-pool.js";
import { fakeEmbedder } from "./testing/fake-embedder.js";
import { insertWaEvent } from "./testing/seam-fixtures.js";
import {
  closeScriptedModels,
  latestPromptOf,
  scriptedModel,
  systemOf,
  toolNamesOf,
  toolResultsOf,
  transcriptOf,
  type Script,
  type ScriptedModel,
  type ScriptedTurn,
} from "./testing/scripted-model.js";
import { SETTLE_IMMEDIATELY } from "./testing/settle.js";
import { removeTmpDir } from "./testing/tmp.js";
import {
  isEventTurn,
  isThreadTurn,
  knockCall,
  nothingToSayCall,
  sayOnCardCall,
  moveCardsCall,
  spotlightCall,
  threadTurns,
} from "./testing/thread-script.js";
import { RECEIPTS } from "./grammar.js";
import { embedMessageBacklog } from "./backlog.js";
import { RETRACT_DISCLOSURE_LINE_TOOL } from "./thread/acts.js";
import { FILL_BLANK_TOOL } from "./thread/fill.js";
import { indexThreadItems } from "./thread/memory-tools.js";
import { createThreadSessions, type ThreadSessions } from "./thread/sessions.js";
import { openBatchWork } from "./lanes.js";
import { advanceRuns, createRunEngine, daySessionShape, executeStep, type RunEngine } from "./runs/engine.js";
import { shippedRunCatalog } from "./runs/catalog.js";
import { THREAD_EVENT_WAKE, THREAD_MAX_ITERATIONS } from "./thread/automation.js";
import { THREAD_DEFINITION } from "./runs/shipped-conversations.js";
import { threadDeps } from "./testing/thread-deps.js";
import { CREATE_AUTOMATION_TOOL } from "./runs/create-automation.js";
import { setAutomationPaused } from "./runs/pauses.js";
import { ensureShippedAutomations } from "./runs/shipped-automations.js";
import { activateRutina, insertRutina } from "./runs/rutinas.js";
import { ANSWER_PROPOSAL_TOOL } from "./runs/proposals.js";
import { fireDueCadences } from "./runs/wakes.js";
import { parseRunDefinition, runDigest, type RunDefinition } from "./runs/definition.js";

// EVERY CASE SPAWNS AT LEAST ONE CLAUDE CODE CHILD and several resume one.
vi.setConfig({ testTimeout: 120_000 });

afterAll(closeScriptedModels);

const SELF_CHAT = "5215550000@s.whatsapp.net";
const CUSTOMER = "5215550001@s.whatsapp.net";
const ZONE = "America/Monterrey";
const BEARER = "thread-day-integration-bearer";

let tmp: string;
let pool: pg.Pool;
const executionPool = newExecutionPool();

beforeAll(async () => {
  await resetAndMigrate();
  tmp = mkdtempSync(join(tmpdir(), "dito-thread-day-int-"));
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
  return { twinId, dek, bundle: createBundle(join(tmp, `${twinId}.bundle`), dek) };
}

/**
 * The runtime's deps for one twin over one scripted model and one registry —
 * the same harness from pass to pass, as a running runtime has it, so the
 * conversation file stays where the child wrote it.
 */
function depsFor(
  client: pg.Client,
  twin: Twin,
  model: ScriptedModel,
  sessions: ThreadSessions,
  options: {
    readonly executable?: string;
    readonly events?: SeatEvents;
    readonly embedder?: Embedder;
  } = {},
): TwinRuntimeDeps {
  return {
    db: client,
    executionPool,
    harness: {
      ...model.harness,
      ...(options.executable === undefined ? {} : { executable: options.executable }),
    },
    bundle: twin.bundle,
    dek: twin.dek,
    twinId: twin.twinId,
    selfChatJid: SELF_CHAT,
    ...SETTLE_IMMEDIATELY,
    drafting: { model: "claude-sonnet-5" },
    embedder: options.embedder ?? fakeEmbedder(),
    sendLock: createSendLockWriter({ pool, hmacKey: TEST_AUDIT_HMAC_KEY }),
    hmacKey: TEST_AUDIT_HMAC_KEY,
    timeZone: ZONE,
    threadSessions: sessions,
    ...(options.events === undefined ? {} : { events: options.events }),
  };
}

/** A turn that looks, finds nothing, and answers — which needs no history. */
function replyTurns(answer: string): ScriptedTurn[] {
  return [
    { toolCall: { name: "search_memory", input: { about: "lo de hoy", counterparty: null } } },
    { text: answer },
  ];
}

/** A turn that stays silent. */
const SILENT: ScriptedTurn[] = [
  { text: "" },
];

/**
 * A turn that ends on a line the guard refuses — a receipt only code writes —
 * every time it is sent back, until the turn's budget runs out: a failed
 * execution (ticket #363).
 */
const FAILS: ScriptedTurn[] = Array.from({ length: THREAD_MAX_ITERATIONS }, () => ({ text: RECEIPTS.every.fixed[0]! }));

/** The rep writes in their own self-chat. */
async function repWrites(client: pg.Client, twin: Twin, text: string): Promise<string> {
  return await insertWaEvent(client, twin.dek, {
    twinId: twin.twinId,
    chatJid: SELF_CHAT,
    senderJid: SELF_CHAT,
    fromMe: true,
    messageId: `3EB0-DAY-${randomUUID().slice(0, 8)}`,
    text,
    occurredAt: new Date(),
  });
}

/** The twin's session rows, oldest first. */
async function sessionRows(
  client: pg.Client,
  twin: Twin,
): Promise<
  {
    session_id: string;
    previous_session_id: string | null;
    day: string;
    closed_at: Date | null;
    resume_refusal: string | null;
  }[]
> {
  const res = await client.query(
    `SELECT session_id, previous_session_id, day::text AS day, closed_at, resume_refusal
       FROM thread_sessions WHERE twin_id = $1 ORDER BY opened_at, id`,
    [twin.twinId],
  );
  return res.rows as never;
}

/** The one open session's id. */
async function openSessionId(client: pg.Client, twin: Twin): Promise<string> {
  const open = (await sessionRows(client, twin)).filter((row) => row.closed_at === null);
  expect(open).toHaveLength(1);
  return open[0]!.session_id;
}

interface Entry {
  readonly type: string;
  readonly uuid?: string;
  /** The child's own message to the model — its ask for visible output after a silence, a hook's reason. */
  readonly isMeta?: boolean;
  readonly message?: { readonly role?: string; readonly content?: unknown };
}

/** The conversation file's entries, as the child wrote them. */
function entriesIn(model: ScriptedModel, sessionId: string): Entry[] {
  return readFileSync(sessionFile(model.harness.directory, sessionId), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Entry);
}

/** Every user message the file holds that is not a tool result or the child's own, as text. */
function promptsIn(model: ScriptedModel, sessionId: string): string[] {
  return entriesIn(model, sessionId).flatMap((entry) => {
    if (entry.type !== "user" || entry.isMeta === true) return [];
    const content = entry.message?.content;
    if (typeof content === "string") return [content];
    if (!Array.isArray(content)) return [];
    const blocks = content as { type?: string; text?: string }[];
    if (blocks.some((block) => block.type === "tool_result")) return [];
    return [blocks.map((block) => block.text ?? "").join("\n")];
  });
}

/** Every tool the assistant called in the file, in order, by its bare name. */
function toolCallsIn(model: ScriptedModel, sessionId: string): string[] {
  return entriesIn(model, sessionId).flatMap((entry) => {
    if (entry.type !== "assistant" || !Array.isArray(entry.message?.content)) return [];
    return (entry.message.content as { type?: string; name?: string }[])
      .filter((block) => block.type === "tool_use")
      .map((block) => String(block.name).replace(/^mcp__dito__/u, ""));
  });
}

interface ExecutionRow {
  readonly trigger_kind: string;
  readonly trigger_ref: string;
  readonly disposition: string;
}

async function executionsOf(client: pg.Client, twin: Twin): Promise<ExecutionRow[]> {
  const res = await client.query<ExecutionRow>(
    "SELECT trigger_kind, trigger_ref, disposition FROM executions WHERE twin_id = $1 ORDER BY started_at, id",
    [twin.twinId],
  );
  return res.rows;
}

async function doorDispositions(client: pg.Client, twin: Twin): Promise<string[]> {
  const res = await client.query<{ disposition: string }>(
    `SELECT p.disposition FROM dashboard_message_processing p
       JOIN dashboard_messages m ON m.id = p.message_id
      WHERE p.twin_id = $1 ORDER BY m.occurred_at, m.id`,
    [twin.twinId],
  );
  return res.rows.map((row) => row.disposition);
}

/** A twin with a seat at the door, its registry and its model — and their teardown. */
async function withDay(
  script: Script,
  run: (day: {
    readonly client: pg.Client;
    readonly twin: Twin;
    readonly seat: DoorSeat;
    readonly model: ScriptedModel;
    sessions: ThreadSessions;
    readonly deps: (options?: {
      readonly executable?: string;
      readonly events?: SeatEvents;
      readonly embedder?: Embedder;
    }) => TwinRuntimeDeps;
  }) => Promise<void>,
  /** What the day's web searches find (ticket #326), when a case searches. */
  modelOptions: Parameters<typeof scriptedModel>[1] = {},
): Promise<void> {
  await withClient(async (client) => {
    const twin = freshTwin();
    const seat = await seatAtTheDoor(client, twin.twinId);
    const model = scriptedModel(script, modelOptions);
    const day = {
      client,
      twin,
      seat,
      model,
      sessions: createThreadSessions(),
      deps: (
        options: {
          readonly executable?: string;
          readonly events?: SeatEvents;
          readonly embedder?: Embedder;
        } = {},
      ) => depsFor(client, twin, model, day.sessions, options),
    };
    try {
      await run(day);
    } finally {
      await day.sessions.close();
      twin.bundle.close();
    }
  });
}

describe("one conversation per rep per day, through both doors (AC 1)", () => {
  it("holds a line from the bar and one from the phone in one file, and the second turn reads the first natively", async () => {
    await withDay([...replyTurns("Garza pidió 40 cajas."), ...replyTurns("Sí, las 40 de Garza.")], async (day) => {
      await typeAtTheDoor(day.client, day.twin, day.seat, "¿qué quedó con lo de Garza?");
      await processPendingWaEvents(day.deps());
      await repWrites(day.client, day.twin, "y lo de Garza de hace rato, ¿ya quedó?");
      await processPendingWaEvents(day.deps());

      const id = await openSessionId(day.client, day.twin);
      expect(existsSync(sessionFile(day.model.harness.directory, id))).toBe(true);
      // THE TWO LINES, IN ORDER, EACH TAGGED WITH THE DOOR IT CAME THROUGH.
      const prompts = promptsIn(day.model, id);
      expect(prompts).toHaveLength(2);
      expect(prompts[0]).toContain("[door: dashboard]");
      expect(prompts[0]).toContain("¿qué quedó con lo de Garza?");
      expect(prompts[1]).toContain("[door: WhatsApp]");
      expect(prompts[1]).toContain("y lo de Garza de hace rato");
      // ...THE TWO REPLIES AND THEIR TOOL CALLS, in the order they were made.
      expect(toolCallsIn(day.model, id)).toEqual(["search_memory", "search_memory"]);
      // THE SECOND TURN'S FIRST REQUEST CARRIES THE FIRST EXCHANGE AS MESSAGES:
      // the line, the twin's words, then the next line (ticket #363).
      const secondTurn = transcriptOf(day.model.requests[2]);
      const first = secondTurn.findIndex(
        (entry) => "text" in entry && entry.text.includes("¿qué quedó con lo de Garza?"),
      );
      const answer = secondTurn.findIndex(
        (entry) => "text" in entry && entry.role === "assistant" && entry.text === "Garza pidió 40 cajas.",
      );
      const second = secondTurn.findIndex(
        (entry) => "text" in entry && entry.text.includes("y lo de Garza de hace rato"),
      );
      expect(first).toBeGreaterThanOrEqual(0);
      expect(answer).toBeGreaterThan(first);
      expect(second).toBeGreaterThan(answer);
      // TWO EXECUTIONS, ONE PER TURN, each through its own door.
      const executions = await executionsOf(day.client, day.twin);
      expect(executions.map((row) => row.trigger_kind)).toEqual([
        "twin_thread_message",
        "twin_thread_message",
      ]);
      expect(executions[0]!.trigger_ref).toContain("door:dashboard");
      expect(executions[1]!.trigger_ref).toContain("door:twin_thread");
      expect(executions.map((row) => row.disposition)).toEqual(["answered", "answered"]);
      // THE SYSTEM TEXT IS THE ONE THE CHILD WAS OPENED WITH, on every request
      // of the session — the notebooks are each wake's, never the system
      // text's (ticket #322), and so are the keywords, told only to the line
      // at the phone's door (ticket #404).
      const system = systemOf(day.model.requests[0]);
      for (const request of day.model.requests) expect(systemOf(request)).toBe(system);
      expect(system).not.toContain("## notepad");
      expect(system).not.toContain("## keyword set");
    });
  });
});

describe("«el segundo» hours later lands on the same customer, with no focus store (ticket #321)", () => {
  it("asks between two Torres by reference, and the later turn writes to the second by the reference the conversation already holds", async () => {
    const TORRES_HERMANOS = "5215550011@s.whatsapp.net";
    const JUAN_TORRES = "5215550012@s.whatsapp.net";
    const asks: ScriptedTurn[] = [
      { toolCall: { name: "resolve_chat", input: { name: "Torres" } } },
      { text: "¿[c1] o [c2]?" },
    ];
    const writes: ScriptedTurn[] = [
      {
        toolCall: {
          name: "create_draft",
          input: { entity: "c2", text: "Ya está la factura." },
        },
      },
      { text: "Listo, para [c2]." },
    ];
    await withDay([...asks, ...writes], async (day) => {
      for (const [chatJid, displayName] of [
        [TORRES_HERMANOS, "Torres Hermanos"],
        [JUAN_TORRES, "Juan Torres"],
      ] as const) {
        day.twin.bundle.confirmChatBinding({
          chatJid,
          entityId: randomUUID(),
          displayName,
          confirmedAt: new Date().toISOString(),
        });
      }
      await repWrites(day.client, day.twin, "escríbele a Torres que ya está la factura");
      await processPendingWaEvents(day.deps());
      await repWrites(day.client, day.twin, "el segundo");
      await processPendingWaEvents(day.deps());

      // ONE CONVERSATION, AND THE SECOND TURN READ THE FIRST'S LOOKUP IN IT:
      // the reference «el segundo» resolves to is the one the conversation
      // already holds — nothing re-served it and nothing looked it up again.
      const id = await openSessionId(day.client, day.twin);
      expect(toolCallsIn(day.model, id)).toEqual(["resolve_chat", "create_draft"]);
      const secondTurn = JSON.stringify(day.model.requests[2]?.["messages"]);
      expect(secondTurn).toContain("[c2] Juan Torres");
      const drafts = await day.client.query<{ destination: string }>(
        "SELECT destination FROM drafts WHERE twin_id = $1",
        [day.twin.twinId],
      );
      expect(drafts.rows).toEqual([{ destination: JUAN_TORRES }]);
      expect(day.twin.bundle.listStores()).not.toContain("focus");
    });
  });
});

describe("the seam's events reach the conversation, ids only (AC 2)", () => {
  it("tells a planted draft's landing, its settle and its seen-stamp — the landing woke a turn, the others appended", async () => {
    const script: Script = (prompt) =>
      isThreadTurn(prompt) || prompt.includes("post.landed")
        ? SILENT
        : [
            { toolCall: { name: "create_draft", input: { text: "claro, se las aparto para el jueves" } } },
            { text: "done" },
          ];
    await withDay(script, async (day) => {
      const api = await startLocalApi(
        {
          db: pool,
          twinId: day.twin.twinId,
          dek: day.twin.dek,
          bearer: BEARER,
          timeZone: ZONE,
          acts: { hmacKey: TEST_AUDIT_HMAC_KEY, bundle: day.twin.bundle, selfChatJid: SELF_CHAT },
          thread: day.sessions,
        },
        { port: 0 },
      );
      const origin = `http://127.0.0.1:${String(api.port)}`;
      const asRep = {
        authorization: `Bearer ${BEARER}`,
        [TWIN_API_SEAT_HEADER]: day.seat.seatId,
        "content-type": "application/json",
      };
      try {
        const watch = createStreamWatch();
        const watchDeps = {
          db: day.client,
          twinId: day.twin.twinId,
          dek: day.twin.dek,
          timeZone: ZONE,
          thread: day.sessions,
        };
        // A CUSTOMER WRITES AND DRAFTING POSTS ITS CARD — the card the
        // drafting automation writes, through its own execution.
        await insertWaEvent(day.client, day.twin.dek, {
          twinId: day.twin.twinId,
          companyId: day.seat.companyId,
          seatId: day.seat.seatId,
          chatJid: CUSTOMER,
          senderJid: CUSTOMER,
          fromMe: false,
          messageId: `3EB0-CUS-${randomUUID().slice(0, 8)}`,
          text: "¿me apartas 40 cajas para el jueves?",
          pushName: "Sra. Garza",
          occurredAt: new Date(),
        });
        await processPendingWaEvents(day.deps());
        const post = await day.client.query<{ id: string; draft_id: string }>(
          "SELECT id, draft_id FROM posts WHERE twin_id = $1 AND draft_id IS NOT NULL",
          [day.twin.twinId],
        );
        const postId = post.rows[0]!.id;
        // THE LANDING, TOLD ON THE WATCH'S FIRST LOOK — a card posted after the
        // process started is news (Codex r2); THE PASS AFTER IT GIVES IT A TURN.
        await watch.tick(watchDeps, new Date());
        await processPendingWaEvents(day.deps());
        // THE REP DISCARDS IT ON THE CANVAS, AND LOOKS AT IT.
        const dismissed = await fetch(`${origin}${TWIN_API_ACT_ROUTES.dismissDraft}`, {
          method: "POST",
          headers: asRep,
          body: JSON.stringify({ postId }),
        });
        expect(dismissed.status).toBe(200);
        const seen = await fetch(`${origin}${TWIN_API_ASK_ROUTES.seen}`, {
          method: "POST",
          headers: asRep,
          body: JSON.stringify({ postIds: [postId] }),
        });
        expect(seen.status).toBe(200);
        await processPendingWaEvents(day.deps());

        // THREE EVENTS IN THE SESSION, EACH WITH THE POST'S ID...
        const id = await openSessionId(day.client, day.twin);
        const said = promptsIn(day.model, id).join("\n");
        expect(said).toContain(`post.landed {"post_id":"${postId}","kind":"draft","source":"chat_turn"}`);
        expect(said).toContain(`post.settled {"post_id":"${postId}","outcome":"dismissed"}`);
        expect(said).toContain(`post.seen {"post_id":"${postId}"}`);
        // ...AND NOTHING OF ITS CONTENT: not the draft, not the customer, not a name.
        const file = readFileSync(sessionFile(day.model.harness.directory, id), "utf8");
        for (const content of ["claro, se las aparto", "40 cajas para el jueves", "Garza"]) {
          expect(file, content).not.toContain(content);
        }
        // THE LANDING WOKE A TURN, AND THE RECORDS SAY SO; THE SETTLE AND THE
        // SEEN-STAMP ONLY APPENDED, AND LEFT NONE. (The same drafting run also
        // asked who the chat belongs to, and that card landed too.)
        const executions = await executionsOf(day.client, day.twin);
        const woken = executions.filter((row) => row.trigger_kind === "twin_thread_event");
        expect(woken.map((row) => row.trigger_ref)).toContainEqual(
          expect.stringContaining(`event:post.landed post:${postId}`),
        );
        expect(woken.every((row) => row.trigger_ref.includes("event:post.landed"))).toBe(true);
        expect(woken.every((row) => row.disposition === "no-action")).toBe(true);
      } finally {
        await api.close();
      }
    });
  });

  it("wakes on the rep's own settle of the spotlighted card, and only appends one on another card", async () => {
    await withDay(() => SILENT, async (day) => {
      const api = await startLocalApi(
        {
          db: pool,
          twinId: day.twin.twinId,
          dek: day.twin.dek,
          bearer: BEARER,
          timeZone: ZONE,
          acts: { hmacKey: TEST_AUDIT_HMAC_KEY, bundle: day.twin.bundle, selfChatJid: SELF_CHAT },
          thread: day.sessions,
        },
        { port: 0 },
      );
      try {
        const origin = `http://127.0.0.1:${String(api.port)}`;
        const asRep = {
          authorization: `Bearer ${BEARER}`,
          [TWIN_API_SEAT_HEADER]: day.seat.seatId,
          "content-type": "application/json",
        };
        // TWO CARDS THE REP CAN DISCARD, and the twin's curation spotlighting
        // the first (ticket #320: the curation is its own record now).
        const [spotlit, other] = [await plantDraft(day), await plantDraft(day)];
        await writeCuration({ db: day.client, dek: day.twin.dek }, {
          twinId: day.twin.twinId,
          executionId: await someExecutionOf(day.client, day.twin),
          spotlight: spotlit,
          order: [spotlit, other],
          offers: [],
          left: [],
        });
        for (const postId of [other, spotlit]) {
          const res = await fetch(`${origin}${TWIN_API_ACT_ROUTES.dismissDraft}`, {
            method: "POST",
            headers: asRep,
            body: JSON.stringify({ postId }),
          });
          expect(res.status).toBe(200);
        }
        await processPendingWaEvents(day.deps());

        const woken = (await executionsOf(day.client, day.twin)).filter(
          (row) => row.trigger_kind === "twin_thread_event",
        );
        expect(woken.map((row) => row.trigger_ref)).toEqual([
          expect.stringContaining(`event:post.settled post:${spotlit}`),
        ]);
        const said = promptsIn(day.model, await openSessionId(day.client, day.twin)).join("\n");
        expect(said).toContain(`post.settled {"post_id":"${other}","outcome":"dismissed"}`);
      } finally {
        await api.close();
      }
    });
  });

  it("resumes the day's conversation to append an event when no child is up — no model call", async () => {
    await withDay(replyTurns("Listo."), async (day) => {
      await repWrites(day.client, day.twin, "anota que mañana llamo a Torres");
      await processPendingWaEvents(day.deps());
      const id = await openSessionId(day.client, day.twin);
      const requests = day.model.requests.length;
      // THE RUNTIME RESTARTS: the child is gone with the old registry.
      await day.sessions.close();
      day.sessions = createThreadSessions();
      const postId = randomUUID();
      day.sessions.raise(day.twin.twinId, { kind: "post.seen", postId });
      await processPendingWaEvents(day.deps());
      await day.sessions.close();

      expect(day.model.requests).toHaveLength(requests);
      expect(await openSessionId(day.client, day.twin)).toBe(id);
      expect(promptsIn(day.model, id).join("\n")).toContain(`post.seen {"post_id":"${postId}"}`);
    });
  });

  it("appends the phone link's state, dropped and back, and wakes nothing: no execution, no model call (#401)", async () => {
    await withDay(replyTurns("Listo."), async (day) => {
      await repWrites(day.client, day.twin, "anota que mañana llamo a Torres");
      await processPendingWaEvents(day.deps());
      const id = await openSessionId(day.client, day.twin);
      const requests = day.model.requests.length;
      const before = await executionsOf(day.client, day.twin);

      day.sessions.raise(day.twin.twinId, { kind: "rail", state: "dropped", since: "2026-10-13T09:36:00.000Z" });
      day.sessions.raise(day.twin.twinId, { kind: "rail", state: "linked" });
      await processPendingWaEvents(day.deps());
      await day.sessions.close();

      expect(day.model.requests).toHaveLength(requests);
      expect(await executionsOf(day.client, day.twin)).toEqual(before);
      // ...AND THE DAY'S SESSION KEEPS BOTH, for the twin's next turn.
      const said = promptsIn(day.model, id).join("\n");
      expect(said).toContain(`rail {"state":"dropped","down_since":"2026-10-13T09:36:00.000Z"}`);
      expect(said).toContain(`rail {"state":"linked"}`);
    });
  });
});

/** A draft card the twin wrote for the rep to act on, planted by its own drafting run. */
async function plantDraft(
  day: {
    readonly client: pg.Client;
    readonly twin: Twin;
    readonly seat: DoorSeat;
    readonly model: ScriptedModel;
  },
  chat = `5215552${String(Math.floor(Math.random() * 1e6)).padStart(6, "0")}@s.whatsapp.net`,
): Promise<string> {
  await insertWaEvent(day.client, day.twin.dek, {
    twinId: day.twin.twinId,
    companyId: day.seat.companyId,
    seatId: day.seat.seatId,
    chatJid: chat,
    senderJid: chat,
    fromMe: false,
    messageId: `3EB0-PL-${randomUUID().slice(0, 8)}`,
    text: "¿tienes 12 bombas?",
    occurredAt: new Date(),
  });
  const drafting = scriptedModel([
    { toolCall: { name: "create_draft", input: { text: "sí, te las aparto" } } },
    // THE CARD'S SENTENCE, the drafting turn's words (ticket #368).
    { text: "Te dejé la respuesta: pidió bombas." },
  ]);
  const sessions = createThreadSessions();
  try {
    await processPendingWaEvents(depsFor(day.client, day.twin, drafting, sessions));
  } finally {
    await sessions.close();
  }
  // THE NEWEST CARD OF THE CHAT: a chat planted twice holds two.
  const post = await day.client.query<{ id: string }>(
    `SELECT p.id FROM posts p JOIN drafts d ON d.id = p.draft_id
      WHERE p.twin_id = $1 AND d.destination = $2
      ORDER BY p.posted_at DESC, p.id DESC
      LIMIT 1`,
    [day.twin.twinId, chat],
  );
  return post.rows[0]!.id;
}

/**
 * The reference a card's customer is named by (ticket #321) — the one the
 * canvas block prints beside the card, read from the bundle the way the block
 * reads it.
 */
async function referenceOfCard(
  day: { readonly client: pg.Client; readonly twin: Twin },
  postId: string,
): Promise<string> {
  const draft = await day.client.query<{ destination: string }>(
    "SELECT d.destination FROM posts p JOIN drafts d ON d.id = p.draft_id WHERE p.id = $1",
    [postId],
  );
  return `c${String(day.twin.bundle.referenceForChat(draft.rows[0]!.destination))}`;
}

describe("the day turns at midnight on the seat's clock, never inside an exchange (AC 3)", () => {
  /** The open session, moved to yesterday with its last turn `ago` ms before now. */
  async function yesterday(client: pg.Client, twin: Twin, ago: number): Promise<void> {
    await client.query(
      `UPDATE thread_sessions
          SET day = day - 1, opened_at = opened_at - interval '1 day',
              last_turn_at = now() - ($2::int * interval '1 millisecond')
        WHERE twin_id = $1 AND closed_at IS NULL`,
      [twin.twinId, ago],
    );
  }

  it("opens a new session after midnight whose first message carries yesterday's tail, word for word", async () => {
    await withDay([...replyTurns("Garza pidió 40 cajas."), ...replyTurns("Buenos días.")], async (day) => {
      await typeAtTheDoor(day.client, day.twin, day.seat, "¿qué quedó con lo de Garza?");
      await processPendingWaEvents(day.deps());
      const first = await openSessionId(day.client, day.twin);
      // THE NIGHT PASSES: yesterday's session, quiet for fifteen minutes, and a
      // runtime that restarted overnight.
      await yesterday(day.client, day.twin, 15 * 60_000);
      await day.sessions.close();
      day.sessions = createThreadSessions();
      // A CUSTOMER'S MESSAGE STILL WAITING OUT ITS SETTLE WINDOW, from before
      // yesterday's exchange: pending, and no line of the thread's (Codex r2).
      await insertWaEvent(day.client, day.twin.dek, {
        twinId: day.twin.twinId,
        chatJid: CUSTOMER,
        senderJid: CUSTOMER,
        fromMe: false,
        messageId: `3EB0-WAIT-${randomUUID().slice(0, 8)}`,
        text: "¿sigue en pie lo del jueves?",
        occurredAt: new Date(Date.now() - 2 * 86_400_000),
      });
      await typeAtTheDoor(day.client, day.twin, day.seat, "¿dónde quedamos?");
      await processPendingWaEvents({ ...day.deps(), settleWindowMs: 3_600_000 });

      const rows = await sessionRows(day.client, day.twin);
      expect(rows).toHaveLength(2);
      expect(rows[0]!.session_id).toBe(first);
      expect(rows[0]!.closed_at).not.toBeNull();
      expect(rows[1]!.previous_session_id).toBe(first);
      expect(rows[1]!.closed_at).toBeNull();
      const [carried, wake] = promptsIn(day.model, rows[1]!.session_id);
      expect(carried).toMatch(/^\[Carried over: /u);
      expect(carried).toContain("the rep: ¿qué quedó con lo de Garza?");
      expect(carried).toContain("you: Garza pidió 40 cajas.");
      expect(carried).not.toContain("¿dónde quedamos?");
      expect(wake).toContain("¿dónde quedamos?");
    });
  });

  it("keeps yesterday's conversation for a wake inside the ten-minute gap", async () => {
    await withDay([...replyTurns("Sí."), ...replyTurns("Claro.")], async (day) => {
      await typeAtTheDoor(day.client, day.twin, day.seat, "¿ya quedó lo de Garza?");
      await processPendingWaEvents(day.deps());
      const first = await openSessionId(day.client, day.twin);
      await yesterday(day.client, day.twin, 3 * 60_000);
      await day.sessions.close();
      day.sessions = createThreadSessions();
      await typeAtTheDoor(day.client, day.twin, day.seat, "y una cosa más");
      await processPendingWaEvents(day.deps());

      expect(await sessionRows(day.client, day.twin)).toHaveLength(1);
      expect(await openSessionId(day.client, day.twin)).toBe(first);
      expect(promptsIn(day.model, first)).toHaveLength(2);
    });
  });
});

describe("a child gone between turns is resumed, and nothing is lost (AC 4)", () => {
  /** The Claude Code binary the SDK ships for this platform. */
  function bundledClaude(): string {
    const sdk = realpathSync(
      createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk"),
    );
    return join(
      dirname(dirname(sdk)),
      `claude-agent-sdk-${process.platform}-${process.arch}`,
      "claude",
    );
  }

  it("resumes the same session id with every earlier item intact, after a kill and after a restart", async () => {
    await withDay(
      // SILENCE, because each line is a note in the rep's own thread that the
      // next turn's search would find: what is under test is the session.
      [...SILENT, ...SILENT, ...SILENT],
      async (day) => {
        // THE CHILD WRITES ITS OWN PID, so the case kills the process the day's
        // session holds and no other.
        const recorder = join(day.model.harness.directory, "record-pid.sh");
        writeFileSync(
          recorder,
          `#!/bin/sh\necho $$ >> "$HOME/child.pids"\nexec "${bundledClaude()}" "$@"\n`,
        );
        chmodSync(recorder, 0o755);
        const deps = (): TwinRuntimeDeps => day.deps({ executable: recorder });

        await repWrites(day.client, day.twin, "primera");
        await processPendingWaEvents(deps());
        const id = await openSessionId(day.client, day.twin);
        const before = entriesIn(day.model, id).flatMap((entry) => entry.uuid ?? []);

        const pid = Number(
          readFileSync(join(day.model.harness.directory, "child.pids"), "utf8").trim().split("\n")[0],
        );
        process.kill(pid, "SIGKILL");
        await new Promise((resolve) => setTimeout(resolve, 500));
        await repWrites(day.client, day.twin, "segunda");
        await processPendingWaEvents(deps());
        expect(await openSessionId(day.client, day.twin)).toBe(id);
        const afterKill = entriesIn(day.model, id).flatMap((entry) => entry.uuid ?? []);
        expect(afterKill.slice(0, before.length)).toEqual(before);

        // ...AND A RESTART OF THE RUNTIME MID-DAY: a new registry, the same row.
        await day.sessions.close();
        day.sessions = createThreadSessions();
        await repWrites(day.client, day.twin, "tercera");
        await processPendingWaEvents(deps());
        expect(await openSessionId(day.client, day.twin)).toBe(id);
        const afterRestart = entriesIn(day.model, id).flatMap((entry) => entry.uuid ?? []);
        expect(afterRestart.slice(0, afterKill.length)).toEqual(afterKill);
        expect(promptsIn(day.model, id).map((prompt) => /primera|segunda|tercera/u.exec(prompt)?.[0])).toEqual([
          "primera",
          "segunda",
          "tercera",
        ]);
      },
    );
  });
});

describe("a failed turn is not kept (AC 5)", () => {
  it("leaves no item in the conversation and no exchange in the bar's history, which returns the rows as before", async () => {
    await withDay([...replyTurns("Primera respuesta."), ...FAILS, ...replyTurns("Tercera respuesta.")], async (day) => {
      const api = await startLocalApi(
        { db: pool, twinId: day.twin.twinId, dek: day.twin.dek, bearer: BEARER, timeZone: ZONE },
        { port: 0 },
      );
      try {
        for (const line of ["primera pregunta", "segunda pregunta", "tercera pregunta"]) {
          await typeAtTheDoor(day.client, day.twin, day.seat, line);
          await processPendingWaEvents(day.deps());
        }
        expect(await doorDispositions(day.client, day.twin)).toEqual([
          "answered",
          "execution_failed",
          "answered",
        ]);
        // THE FAILED TURN WAS DROPPED BY A FORK: the session moved to a
        // new id carrying from the old, and holds the first and third lines.
        const rows = await sessionRows(day.client, day.twin);
        expect(rows).toHaveLength(2);
        expect(rows[1]!.previous_session_id).toBe(rows[0]!.session_id);
        expect(rows[0]!.closed_at).not.toBeNull();
        const prompts = promptsIn(day.model, rows[1]!.session_id).join("\n");
        expect(prompts).toContain("primera pregunta");
        expect(prompts).toContain("tercera pregunta");
        expect(prompts).not.toContain("segunda pregunta");
        expect(JSON.stringify(transcriptOf(day.model.requests.at(-1)))).not.toContain(
          "segunda pregunta",
        );
        // THE BAR'S HISTORY, AT THE RUNTIME API: the rows, as before — the
        // failed exchange is not among them.
        const res = await fetch(
          `http://127.0.0.1:${String(api.port)}${TWIN_API_ROUTES.exchanges}?now=${encodeURIComponent(new Date().toISOString())}`,
          { headers: { authorization: `Bearer ${BEARER}`, [TWIN_API_SEAT_HEADER]: day.seat.seatId } },
        );
        expect(res.status).toBe(200);
        const page = (await res.json()) as TwinExchanges;
        const exchanges = page.days.flatMap((one) => one.exchanges);
        expect(exchanges.map((exchange) => exchange.text)).toEqual([
          "primera pregunta",
          "tercera pregunta",
        ]);
        expect(exchanges.every((exchange) => exchange.reply !== undefined)).toBe(true);
      } finally {
        await api.close();
      }
    });
  });
});

/**
 * THE THREAD ON THE ONE ENGINE (ticket #363): the day's session is opened
 * with the thread definition's own frame — its instructions, every tool the
 * thread holds, nothing to submit through — and a turn ends when the model
 * stops, its words the line it says.
 */
describe("the thread on the one engine: the day's frame is the definition's, and a turn ends on its words (ticket #363)", () => {
  it("opens the day with the definition's frame — its instructions, every tool, no submission — and no turn can call one", async () => {
    await withDay(replyTurns("Garza pidió 40 cajas."), async (day) => {
      await typeAtTheDoor(day.client, day.twin, day.seat, "¿qué quedó con lo de Garza?");
      await processPendingWaEvents(day.deps());

      const expected = daySessionShape(THREAD_DEFINITION, "claude-sonnet-5");
      const lease = await day.sessions.enter(
        {
          twinId: day.twin.twinId,
          harness: day.model.harness,
          bundle: day.twin.bundle,
          dek: day.twin.dek,
          pool: executionPool,
          selfChatJid: SELF_CHAT,
          timeZone: ZONE,
          model: "claude-sonnet-5",
        },
        new Date(),
      );
      expect(lease.session.shape).toEqual(expected);
      // EVERY REQUEST OFFERS THE THREAD'S OWN — THE REP'S CHATS' THREE READS
      // AMONG THEM (ticket #396) — AND THE SDK'S FIVE FILE TOOLS (ticket
      // #326), AND NOTHING TO SUBMIT THROUGH.
      for (const request of day.model.requests) {
        const offered = toolNamesOf(request);
        expect(offered).toHaveLength(37);
        expect(offered).toEqual(expect.arrayContaining(["Read", "Glob", "Grep", "Write", "Edit"]));
        expect(offered).not.toContain("Bash");
        expect(offered).not.toContain("submit_answer");
        expect(systemOf(request)).toContain(renderParts(expected.instructions));
      }
      expect(await doorDispositions(day.client, day.twin)).toEqual(["answered"]);
    });
  });

  it("records a turn that says nothing and calls nothing as `no-action`, and posts nothing at the door", async () => {
    await withDay(SILENT, async (day) => {
      const before = await day.client.query("SELECT 1 FROM posts WHERE twin_id = $1", [day.twin.twinId]);
      await typeAtTheDoor(day.client, day.twin, day.seat, "nota: llamar al de la ferretería");
      await processPendingWaEvents(day.deps());

      expect((await executionsOf(day.client, day.twin)).map((row) => row.disposition)).toEqual(["no-action"]);
      expect(await doorDispositions(day.client, day.twin)).toEqual(["deliberate_silence"]);
      const after = await day.client.query("SELECT 1 FROM posts WHERE twin_id = $1", [day.twin.twinId]);
      expect(after.rows).toHaveLength(before.rows.length);
    });
  });
});

describe("the fold: two lines, one turn (design D7)", () => {
  it("answers both with one result and one record, marks the other line folded, and answers each on its own door", async () => {
    // A SEARCH THAT COMES BACK HONESTLY EMPTY WHICHEVER LINE OWNS THE TURN:
    // scoped to a customer with no messages. Unscoped, a turn the door owns
    // would find the phone's own line — only the owner's message is kept out
    // of its search — and the citation-less answer would be refused.
    const script: ScriptedTurn[] = [
      { toolCall: { name: "search_memory", input: { about: "lo de hoy", counterparty: "Pérez" } } },
      { text: "Las dos cosas, sí." },
    ];
    await withDay(script, async (day) => {
      day.twin.bundle.confirmChatBinding({
        chatJid: "5215550099@s.whatsapp.net",
        entityId: randomUUID(),
        displayName: "Pérez",
        confirmedAt: new Date().toISOString(),
      });
      // TWO LINES IN ONE PASS, ONE AT EACH DOOR: both are pushed into the
      // session while the first turn has not ended, and the child's own queue
      // answers them in one turn.
      await repWrites(day.client, day.twin, "¿quedó lo de Garza?");
      await typeAtTheDoor(day.client, day.twin, day.seat, "y lo de Torres también");
      await processPendingWaEvents(day.deps());

      // ONE RECORD, OWNED BY WHICHEVER LINE THE CHILD CONSUMED FIRST. The two
      // wakes run on the lane at once, and which one reaches the session
      // first is a race between their connection borrows — so the owner is
      // read off the record, and the other line is the folded one.
      const executions = await executionsOf(day.client, day.twin);
      expect(executions).toHaveLength(1);
      const phoneOwns = executions[0]!.trigger_ref.includes("door:twin_thread");
      expect(executions[0]!.trigger_ref).toContain(phoneOwns ? "door:twin_thread" : "door:dashboard");
      // THE OTHER LINE IS CONSUMED AS FOLDED, and answered at its own door.
      expect(await doorDispositions(day.client, day.twin)).toEqual([phoneOwns ? "folded" : "answered"]);
      const marker = await day.client.query<{ disposition: string }>(
        "SELECT disposition FROM wa_event_processing WHERE twin_id = $1",
        [day.twin.twinId],
      );
      expect(marker.rows.map((row) => row.disposition)).toEqual([phoneOwns ? "answered" : "folded"]);
      const posts = await day.client.query<{ asked_on: string | null; notice_id: string | null }>(
        "SELECT asked_on, notice_id FROM posts WHERE twin_id = $1 ORDER BY posted_at",
        [day.twin.twinId],
      );
      expect(posts.rows.map((row) => row.asked_on).sort()).toEqual(["dashboard", "twin_thread"]);
      // BOTH LINES ARE IN THE THREAD'S OWN STORE, the folded one through the
      // turn that answered it (ticket #320).
      const garza = day.twin.bundle.searchThreadItems({ words: ["Garza"], limit: 8 });
      expect(garza.map((item) => [item.role, item.door, item.text])).toContainEqual([
        "rep",
        "twin_thread",
        "¿quedó lo de Garza?",
      ]);
      const torres = day.twin.bundle.searchThreadItems({ words: ["Torres"], limit: 8 });
      expect(torres.map((item) => [item.role, item.door, item.text])).toContainEqual([
        "rep",
        "dashboard",
        "y lo de Torres también",
      ]);
    });
  });
});

// ═══ TICKET #320: THE THREAD ALONE KNOCKS AND CURATES; THE ARRIVAL IS A TURN;
// ═══ IT READS AND SEARCHES ITS OWN DAYS

/** Any execution of this twin's, for a fixture row that has to name one. */
async function someExecutionOf(client: pg.Client, twin: Twin): Promise<string> {
  const row = await client.query<{ id: string }>(
    "SELECT id FROM executions WHERE twin_id = $1 LIMIT 1",
    [twin.twinId],
  );
  return row.rows[0]!.id;
}

/**
 * The stream watch's look, telling the day's session what landed since the
 * watch — the process — started.
 */
async function tellLandings(
  day: {
    readonly client: pg.Client;
    readonly twin: Twin;
    readonly sessions: ThreadSessions;
  },
  watch: StreamWatch,
): Promise<void> {
  await watch.tick(
    {
      db: day.client,
      twinId: day.twin.twinId,
      dek: day.twin.dek,
      timeZone: ZONE,
      thread: day.sessions,
    },
    new Date(),
  );
}

/** A notifier that records what it was asked and writes the row notify would. */
function recordingNotifier(
  client: pg.Client,
): TwinNotifier & { readonly asks: { type: string; body?: string; about: string }[] } {
  const asks: { type: string; body?: string; about: string }[] = [];
  return {
    asks,
    send: async (request) => {
      asks.push({
        type: request.type,
        ...(request.slots["body"] === undefined ? {} : { body: request.slots["body"] }),
        about: request.about,
      });
      await client.query(
        `INSERT INTO notify_sends
           (seat_id, message_type, requested_at, outcome, settled_at, about_ref)
         VALUES ($1, $2, now(), 'sent', now(), $3)`,
        [request.seatId, request.type, request.about],
      );
      return {};
    },
  };
}

/** A post's own sealed parts, opened — without the rows every reader joins beside them. */
async function openedBare(day: { readonly twin: Twin; readonly client: pg.Client }, postId: string) {
  const row = await day.client.query<{ parts_enc: Buffer }>("SELECT parts_enc FROM posts WHERE id = $1", [postId]);
  return openSealedParts(day.twin.dek, row.rows[0]!.parts_enc);
}

/** The opened post, as every surface reads it. */
async function opened(day: { readonly twin: Twin; readonly client: pg.Client }, postId: string) {
  const posts = await readPostsByIds(
    { db: day.client, twinId: day.twin.twinId, dek: day.twin.dek, timeZone: ZONE, bundle: day.twin.bundle },
    [postId],
    new Date(),
  );
  return posts.get(postId)!;
}

/**
 * What the last turn's own calls returned, in order — the newest request's
 * tool results, less the day's earlier ones it carries: the request the turn
 * wrote its words in carries every result of its calls (ticket #363).
 */
function lastResults(model: ScriptedModel, calls: number): string[] {
  return toolResultsOf(model.requests.at(-1)).slice(-calls);
}

/** The local API over this day's sessions and a seat bus. */
async function apiOver(
  day: { readonly twin: Twin; readonly sessions: ThreadSessions },
  events?: SeatEvents,
) {
  return await startLocalApi(
    {
      db: pool,
      twinId: day.twin.twinId,
      dek: day.twin.dek,
      bearer: BEARER,
      timeZone: ZONE,
      acts: { hmacKey: TEST_AUDIT_HMAC_KEY, bundle: day.twin.bundle, selfChatJid: SELF_CHAT },
      thread: day.sessions,
      ...(events === undefined ? {} : { events }),
    },
    { port: 0 },
  );
}

describe("a line edited on the notes card reaches the thread as the rep's correction (ticket #344)", () => {
  /** The words the rep typed over line 1 — a sentence whose numbers name no line they tapped. */
  const CORRECTED = "Le cotizaste 2 cajas en 4800 MXN.";

  /**
   * A day with the notes card, a door message editing its line 1, and a model
   * that calls the retraction with that message as its evidence.
   */
  async function correctionDay(
    turn: { readonly line: number; readonly answer: string },
    /** `shut`: the window closes and the fact finalizes after the rep's edit is written. */
    record: { readonly shut?: boolean },
    check: (day: {
      readonly client: pg.Client;
      readonly twin: Twin;
      readonly seat: DoorSeat;
      readonly model: ScriptedModel;
      readonly postId: string;
      readonly factId: string;
      readonly messageId: string;
    }) => Promise<void>,
  ): Promise<void> {
    let evidence = "";
    await withDay(
      (prompt) =>
        isThreadTurn(prompt)
          ? threadTurns({
              tool: RETRACT_DISCLOSURE_LINE_TOOL,
              evidence,
              input: { line: turn.line },
              answer: turn.answer,
            })
          : SILENT,
      async (day) => {
        const scoped = {
          twinId: day.twin.twinId,
          companyId: day.seat.companyId,
          seatId: day.seat.seatId,
          dek: day.twin.dek,
        };
        const filed = await disclosedFact(day.client, scoped, {
          reachedAt: new Date(),
          withCreateLine: true,
        });
        // THE FIXTURE'S OWN SEAM ROWS ARE YESTERDAY'S, already consumed: the
        // pass under test must find nothing pending but the rep's edit.
        await day.client.query(
          `INSERT INTO wa_event_processing (event_id, twin_id, disposition)
           SELECT id, twin_id, 'captured' FROM wa_events WHERE twin_id = $1`,
          [day.twin.twinId],
        );
        const messageId = await typeAtTheDoor(day.client, day.twin, day.seat, CORRECTED, {
          kind: "line",
          postId: filed.postId,
          lineIndex: 1,
        });
        if (record.shut === true) {
          // THE WINDOW SHUTS UNDER THE REP: their edit is on the row, and the
          // record finalizes — a pass run past the close — before the twin
          // reaches it.
          await finalizeDueFacts(
            { db: day.client },
            { twinId: day.twin.twinId },
            new Date(Date.now() + 25 * 3_600_000),
          );
        }
        evidence = messageId;
        await processPendingWaEvents(day.deps());
        await check({ ...day, postId: filed.postId, factId: filed.factId, messageId });
      },
    );
  }

  /** The reply posted at the door for one message, as the bar reads it. */
  async function replyTo(day: { readonly client: pg.Client; readonly twin: Twin }, messageId: string) {
    const post = await day.client.query<{ id: string }>(
      "SELECT id FROM posts WHERE asked_message_id = $1",
      [messageId],
    );
    expect(post.rows).toHaveLength(1);
    return await opened(day, post.rows[0]!.id);
  }

  it("annotates the line the rep tapped, keeps their words, chains the act and answers in one line", async () => {
    const answer = "Listo, lo corregí: le cotizaste 2 cajas en 4800.";
    await correctionDay({ line: 1, answer }, {}, async (day) => {
      // THE TWIN WAS TOLD WHICH LINE THE REP EDITED, off the row — not by
      // reading the sentence, whose «2» names line 2 of this very post.
      const id = await openSessionId(day.client, day.twin);
      expect(promptsIn(day.model, id).join("\n")).toContain("line 1");
      expect(await doorDispositions(day.client, day.twin)).toEqual(["retracted"]);

      const kept = await day.client.query<{ dashboard_message_id: string; correction_enc: Buffer }>(
        "SELECT dashboard_message_id, correction_enc FROM fact_retractions WHERE fact_id = $1",
        [day.factId],
      );
      expect(kept.rows).toHaveLength(1);
      expect(kept.rows[0]!.dashboard_message_id).toBe(day.messageId);
      expect(Buffer.from(day.twin.dek.decrypt(kept.rows[0]!.correction_enc)).toString("utf8")).toBe(
        CORRECTED,
      );
      const chained = await day.client.query<{ caller: string; outcome: string }>(
        "SELECT caller, outcome FROM audit_chain WHERE action = 'fact_retraction' AND ref LIKE $1",
        [`%message:${day.messageId}%`],
      );
      expect(chained.rows).toEqual([{ caller: "aperture", outcome: "retracted" }]);

      // ONE LINE BACK, with the receipt folded into it.
      const reply = await replyTo(day, day.messageId);
      const prose = reply.parts.filter((part) => part.kind === "prose");
      expect(prose.map((part) => part.text)).toEqual([answer]);
      expect(reply.parts.filter((part) => part.kind === "receipt").map((part) => part.text)).toEqual([
        RECEIPTS.retracted(1),
      ]);

      // THE CARD SHOWS THE CORRECTED WORDS, and keeps the claim it printed.
      const card = await opened(day, day.postId);
      const lines = card.parts.find((part) => part.kind === "record-lines");
      expect(lines?.kind === "record-lines" ? lines.lines[0] : undefined).toMatchObject({
        index: 1,
        text: "Le cotizaste cajas en 4500 MXN.",
        corrected: CORRECTED,
        retracted: true,
        retractable: false,
      });
    });
  });

  it("posts a silent turn's receipt to both surfaces by the notice and send a button's takes, as the reply to the line (ticket #358)", async () => {
    await correctionDay({ line: 1, answer: "" }, {}, async (day) => {
      expect(await doorDispositions(day.client, day.twin)).toEqual(["retracted"]);
      // THE REPLY TO THE LINE IS THE RECEIPT ALONE, as the day's thread reads it.
      const reply = await replyTo(day, day.messageId);
      expect(reply.parts.map((part) => ({ kind: part.kind, text: "text" in part ? part.text : "" }))).toEqual([
        { kind: "receipt", text: RECEIPTS.retracted(1) },
      ]);
      // ...DELIVERED AS A NOTICE AND ITS SEND — the phone's thread has it too —
      // under the act's own kind, its origin the turn's execution.
      const delivered = await day.client.query<{ kind: string; execution: boolean; sends: number }>(
        `SELECT n.kind, n.execution_id IS NOT NULL AS execution,
                (SELECT count(*)::int FROM send_commands c WHERE c.payload_ref = 'notice:' || n.id) AS sends
           FROM posts p JOIN notices n ON n.id = p.notice_id
          WHERE p.asked_message_id = $1`,
        [day.messageId],
      );
      expect(delivered.rows).toEqual([{ kind: "correction_ack", execution: true, sends: 1 }]);
    });
  });

  it("refuses a call naming another line than the one the rep tapped, and keeps nothing", async () => {
    await correctionDay({ line: 2, answer: "No pude." }, {}, async (day) => {
      const refused = toolResultsOf(day.model.requests.at(-1)).find((one) => one.includes("names line"));
      expect(refused).toContain("names line 1 and this call names 2");
      const rows = await day.client.query("SELECT 1 FROM fact_retractions WHERE fact_id = $1", [day.factId]);
      expect(rows.rows).toEqual([]);
    });
  });

  it("refuses a line whose window shut under the rep, by the aperture's word, chained, and answers with the refusal", async () => {
    const answer = "Esa ya quedó firme.";
    await correctionDay(
      { line: 1, answer },
      { shut: true },
      async (day) => {
        expect(await doorDispositions(day.client, day.twin)).toEqual(["correction_refused"]);
        const rows = await day.client.query("SELECT 1 FROM fact_retractions WHERE fact_id = $1", [day.factId]);
        expect(rows.rows).toEqual([]);
        const chained = await day.client.query<{ outcome: string }>(
          "SELECT outcome FROM audit_chain WHERE action = 'fact_retraction' AND ref LIKE $1",
          [`%message:${day.messageId}%`],
        );
        expect(chained.rows).toEqual([{ outcome: "refused:window_closed" }]);
        const reply = await replyTo(day, day.messageId);
        expect(reply.parts.filter((part) => part.kind === "receipt").map((part) => part.text)).toEqual([
          RECEIPTS.correctionRefused("window_closed"),
        ]);
        const card = await opened(day, day.postId);
        const lines = card.parts.find((part) => part.kind === "record-lines");
        expect(lines?.kind === "record-lines" ? lines.lines[0]?.corrected : "absent").toBeUndefined();
      },
    );
  });
});

describe("a blank the twin left is filled from the rep's answer (ticket #342)", () => {
  const BODY = "Hola Laura, los 300 bultos te quedan en ⟦precio⟧ cada uno. ¿Te los aparto?";
  const QUESTION = "¿A cuánto le dejamos el bulto a Laura? La última vez fue a $172.";
  const CONFIRMED = "Listo, quedó a $168 el bulto. Ya se puede mandar.";
  /** The sentence drafting's turn finished on: the card's (ticket #368). */
  const SAID = "Te dejé la respuesta de los 300 bultos; falta que me digas el precio.";

  /** A draft card with one blank, planted by the twin's own drafting run — delicate when given a reason. */
  async function plantBlankDraft(
    day: {
      readonly client: pg.Client;
      readonly twin: Twin;
      readonly seat: DoorSeat;
    },
    reason?: string,
  ): Promise<{ readonly postId: string; readonly draftId: string }> {
    const chat = `5215553${String(Math.floor(Math.random() * 1e6)).padStart(6, "0")}@s.whatsapp.net`;
    await insertWaEvent(day.client, day.twin.dek, {
      twinId: day.twin.twinId,
      companyId: day.seat.companyId,
      seatId: day.seat.seatId,
      chatJid: chat,
      senderJid: chat,
      fromMe: false,
      messageId: `3EB0-BL-${randomUUID().slice(0, 8)}`,
      text: "¿me apartas 300 bultos?",
      occurredAt: new Date(),
    });
    const drafting = scriptedModel([
      {
        toolCall: {
          name: "create_draft",
          input: {
            text: BODY,
            blanks: [{ key: "precio", label: "precio", question: QUESTION }],
            ...(reason === undefined ? {} : { delicate: true, reason }),
          },
        },
      },
      { text: SAID },
    ]);
    const sessions = createThreadSessions();
    try {
      await processPendingWaEvents(depsFor(day.client, day.twin, drafting, sessions));
    } finally {
      await sessions.close();
    }
    const post = await day.client.query<{ id: string; draft_id: string }>(
      `SELECT p.id, p.draft_id FROM posts p JOIN drafts d ON d.id = p.draft_id
        WHERE p.twin_id = $1 AND d.destination = $2`,
      [day.twin.twinId, chat],
    );
    return { postId: post.rows[0]!.id, draftId: post.rows[0]!.draft_id };
  }

  /** A day whose thread turn calls `fill_blank` with `input` over the rep's answer to the blank. */
  async function answerDay(
    input: Readonly<Record<string, unknown>>,
    answer: string,
    check: (day: {
      readonly client: pg.Client;
      readonly twin: Twin;
      readonly model: ScriptedModel;
      readonly planted: { readonly postId: string; readonly draftId: string };
      readonly messageId: string;
    }) => Promise<void>,
    reason?: string,
  ): Promise<void> {
    await withDay(
      (prompt) => (isThreadTurn(prompt) ? threadTurns({ tool: FILL_BLANK_TOOL, input, answer }) : SILENT),
      async (day) => {
        const planted = await plantBlankDraft(day, reason);
        const messageId = await typeAtTheDoor(day.client, day.twin, day.seat, "a 168, por el flete", {
          kind: "blank",
          postId: planted.postId,
          key: "b1",
        });
        await processPendingWaEvents(day.deps());
        await check({ ...day, planted, messageId });
      },
    );
  }

  it("carries a delicate draft's reason onto the draft its fill writes (ticket #343)", async () => {
    const reason = "Le confirmo los 300 bultos a Laura, por debajo de lista. Torres le ofreció lo mismo la semana pasada.";
    await answerDay(
      { key: "b1", value: "$168" },
      CONFIRMED,
      async (day) => {
        const fills = await day.client.query<{ filled_draft_id: string }>(
          "SELECT filled_draft_id FROM draft_fills WHERE draft_id = $1",
          [day.planted.draftId],
        );
        const card = await day.client.query<{ id: string }>("SELECT id FROM posts WHERE draft_id = $1", [
          fills.rows[0]!.filled_draft_id,
        ]);
        const draft = (await opened(day, card.rows[0]!.id)).parts.find((part) => part.kind === "draft");
        expect(draft).toMatchObject({ delicate: true, reason });
      },
      reason,
    );
  });

  it("writes the filled draft, the fill row and the new card; the old card stops waiting and the new one waits", async () => {
    await answerDay({ key: "b1", value: "$168" }, CONFIRMED, async (day) => {
      // THE TWIN WAS SHOWN THE BLANK THE REP ANSWERED AND ITS OWN QUESTION, off the row.
      const id = await openSessionId(day.client, day.twin);
      expect(promptsIn(day.model, id).join("\n")).toContain(QUESTION);
      expect(await doorDispositions(day.client, day.twin)).toEqual(["drafted"]);

      const fills = await day.client.query<{ filled_draft_id: string; execution_id: string }>(
        "SELECT filled_draft_id, execution_id FROM draft_fills WHERE draft_id = $1",
        [day.planted.draftId],
      );
      expect(fills.rows).toHaveLength(1);
      const filledId = fills.rows[0]!.filled_draft_id;
      const execution = await day.client.query<{ trigger_kind: string }>(
        "SELECT trigger_kind FROM executions WHERE id = $1",
        [fills.rows[0]!.execution_id],
      );
      expect(execution.rows).toHaveLength(1);

      // A NEW DRAFT, THE OLD ONE UNTOUCHED.
      const bodies = await day.client.query<{ id: string; content_enc: Buffer }>(
        "SELECT id, content_enc FROM drafts WHERE id = ANY($1::uuid[])",
        [[day.planted.draftId, filledId]],
      );
      const bodyOf = (draftId: string): string =>
        Buffer.from(day.twin.dek.decrypt(bodies.rows.find((row) => row.id === draftId)!.content_enc)).toString("utf8");
      expect(bodyOf(day.planted.draftId)).toBe(BODY.replace("⟦precio⟧", "⟦b1⟧"));
      expect(bodyOf(filledId)).toBe("Hola Laura, los 300 bultos te quedan en $168 cada uno. ¿Te los aparto?");
      const blanks = await day.client.query("SELECT key FROM draft_blanks WHERE draft_id = $1", [filledId]);
      expect(blanks.rows).toEqual([]);

      // THE NEW CARD SAYS WHAT IT FILLED, AND WHERE.
      const card = await day.client.query<{ id: string }>("SELECT id FROM posts WHERE draft_id = $1", [filledId]);
      const newPost = card.rows[0]!.id;
      const parts = (await opened(day, newPost)).parts;
      const draft = parts.find((part) => part.kind === "draft");
      expect(draft).toMatchObject({
        filled: { draftId: day.planted.draftId, key: "b1", start: 40, end: 44 },
      });
      // THE SENTENCE GOES WITH THE DRAFT (ticket #368): the fill keeps the
      // words the drafting turn said of it.
      expect(parts.filter((part) => part.kind === "prose").map((part) => part.text)).toEqual([SAID]);
      expect(draft?.kind === "draft" ? draft.blanks : "absent").toBeUndefined();

      const waiting = await waitingCandidates({ db: day.client, twinId: day.twin.twinId }, new Date());
      expect(waiting).toContain(newPost);
      expect(waiting).not.toContain(day.planted.postId);

      // ONE LINE BACK, AND NO RECEIPT: the card is the acknowledgement.
      const reply = await day.client.query<{ id: string }>(
        "SELECT id FROM posts WHERE asked_message_id = $1",
        [day.messageId],
      );
      const said = (await opened(day, reply.rows[0]!.id)).parts;
      expect(said.filter((part) => part.kind === "prose").map((part) => part.text)).toEqual([CONFIRMED]);
      expect(said.filter((part) => part.kind === "receipt")).toEqual([]);

      // ...AND A DESCARTAR LEFT OPEN ON THE OLD CARD DISCARDS NOTHING (Codex r1):
      // the draft that took its place is the one that waits.
      const dismissed = await dismissDraft(
        { db: day.client, dek: day.twin.dek, twinId: day.twin.twinId, hmacKey: TEST_AUDIT_HMAC_KEY, bundle: day.twin.bundle },
        { draftId: day.planted.draftId, evidence: { surface: "dashboard", dashboardActId: randomUUID() } },
      );
      expect(dismissed).toEqual({ outcome: "refused", reason: "written_again" });
    });
  });

  it("refuses a key the draft does not have, and writes nothing", async () => {
    await answerDay({ key: "b2", value: "a las 9" }, "No encontré ese hueco.", async (day) => {
      expect(lastResults(day.model, 1)[0]).toContain('that draft has no blank "b2"');
      const fills = await day.client.query("SELECT 1 FROM draft_fills WHERE draft_id = $1", [day.planted.draftId]);
      expect(fills.rows).toEqual([]);
      const waiting = await waitingCandidates({ db: day.client, twinId: day.twin.twinId }, new Date());
      expect(waiting).toContain(day.planted.postId);
    });
  });

  it("refuses a fill on a turn whose message points at no draft of the twin's", async () => {
    await withDay(
      (prompt) =>
        isThreadTurn(prompt)
          ? threadTurns({ tool: FILL_BLANK_TOOL, input: { key: "b1", value: "$168" }, answer: "No pude." })
          : SILENT,
      async (day) => {
        const planted = await plantBlankDraft(day);
        await typeAtTheDoor(day.client, day.twin, day.seat, "el precio de Laura es 168");
        await processPendingWaEvents(day.deps());
        expect(lastResults(day.model, 1)[0]).toContain("this message is not about one of your drafts");
        const fills = await day.client.query("SELECT 1 FROM draft_fills WHERE draft_id = $1", [planted.draftId]);
        expect(fills.rows).toEqual([]);
      },
    );
  });
});

describe("the thread decides the knock (ticket #320 AC 1)", () => {
  it("knocks a landed draft when its turn decides to, and the phone hears of it once", async () => {
    let target = "";
    // THE CARD'S CUSTOMER BY THEIR REFERENCE: the lock screen shows the name
    // the card carries (ticket #321).
    let reference = "";
    const script: Script = (prompt) =>
      isEventTurn(prompt, "post.landed") && prompt.includes(`"post_id":"${target}"`)
        ? threadTurns({ calls: [knockCall(target, `Te dejé lista la respuesta para [${reference}].`)] })
        : SILENT;
    await withDay(script, async (day) => {
      const watch = createStreamWatch();
      target = await plantDraft(day);
      reference = await referenceOfCard(day, target);
      await tellLandings(day, watch);
      await processPendingWaEvents(day.deps());

      // THE CARD LANDED WITH NO KNOCK: drafting posts its words and the draft, and stops.
      expect((await openedBare(day, target)).map((part) => part.kind)).toEqual(["prose", "draft"]);
      // THE THREAD'S TURN ADDED IT, as its own row, named by that turn.
      const knocks = await day.client.query<{ post_id: string; execution_id: string }>(
        "SELECT post_id, execution_id FROM post_knocks WHERE twin_id = $1",
        [day.twin.twinId],
      );
      const turn = (await executionsOf(day.client, day.twin)).find((row) =>
        row.trigger_ref.includes(`event:post.landed post:${target}`),
      );
      expect(turn).toBeDefined();
      const record = await day.client.query<{ id: string }>(
        "SELECT id FROM executions WHERE twin_id = $1 AND trigger_ref = $2",
        [day.twin.twinId, turn!.trigger_ref],
      );
      expect(knocks.rows).toEqual([{ post_id: target, execution_id: record.rows[0]!.id }]);
      // EVERY SURFACE READS IT AS THE POST'S OWN KNOCK PART, its reference
      // rendered as the card's own name.
      const knocked = await opened(day, target);
      const draftPart = knocked.parts.find((part) => part.kind === "draft");
      const name = draftPart?.kind === "draft" ? draftPart.counterparty : "";
      const sentence = `Te dejé lista la respuesta para ${name}.`;
      expect(knocked.parts).toContainEqual(expect.objectContaining({ kind: "knock", text: sentence }));
      // ...AND THE AT-ONCE TIER DELIVERS IT, ONCE.
      const notifier = recordingNotifier(day.client);
      const deliver = () =>
        deliverPendingKnocks(
          { db: day.client, twinId: day.twin.twinId, dek: day.twin.dek, notify: notifier },
          new Date(),
        );
      expect(await deliver()).toBe(1);
      expect(await deliver()).toBe(0);
      expect(notifier.asks).toEqual([{ type: "draft_ready", body: sentence, about: target }]);
      const sends = await day.client.query("SELECT 1 FROM notify_sends WHERE about_ref = $1", [target]);
      expect(sends.rows).toHaveLength(1);
      // THE TURN WAS SHOWN THE CANVAS, the card among it.
      const prompt = promptsIn(day.model, await openSessionId(day.client, day.twin)).find((one) =>
        one.includes(`post.landed {"post_id":"${target}"`),
      );
      expect(prompt).toContain("## canvas");
      expect(prompt).toContain(`post ${target} · a draft reply`);
    });
  });

  it("leaves a landed draft unknocked when its turn stays silent: nothing is sent", async () => {
    await withDay(() => SILENT, async (day) => {
      const watch = createStreamWatch();
      const target = await plantDraft(day);
      await tellLandings(day, watch);
      await processPendingWaEvents(day.deps());

      const woke = (await executionsOf(day.client, day.twin)).filter((row) =>
        row.trigger_ref.includes(`event:post.landed post:${target}`),
      );
      expect(woke.map((row) => row.disposition)).toEqual(["no-action"]);
      const knocks = await day.client.query("SELECT 1 FROM post_knocks WHERE twin_id = $1", [day.twin.twinId]);
      expect(knocks.rows).toHaveLength(0);
      const notifier = recordingNotifier(day.client);
      expect(
        await deliverPendingKnocks(
          { db: day.client, twinId: day.twin.twinId, dek: day.twin.dek, notify: notifier },
          new Date(),
        ),
      ).toBe(0);
      expect(notifier.asks).toEqual([]);
    });
  });
});

describe("one kind of knock: the thread's row, written in the turn that posts (tickets #320 AC 2, #358)", () => {
  const LAURA = "5215550032@s.whatsapp.net";
  /** The model the knock's post id is read back from, as a model reads the tool's answer. */
  let reading: ScriptedModel | undefined;
  /** The post `create_draft` named in its answer, as the knock call read it. */
  let named = "";
  /** The post `create_draft` named in its answer, read off the turn's latest request. */
  const namedPost = (): string => {
    const told = toolResultsOf(reading!.requests.at(-1)).at(-1) ?? "";
    named = /post ([0-9a-f-]{36})/u.exec(told)?.[1] ?? "";
    return named;
  };

  it("knocks a draft the rep asked for in the turn that writes it: the card lands at the turn's end under the id it named, with one knock row beside it, delivered once", async () => {
    const script: Script = (prompt) =>
      isThreadTurn(prompt)
        ? [
            { toolCall: { name: "resolve_chat", input: { name: "Laura" } } },
            { toolCall: { name: "create_draft", input: { entity: "c1", text: "Laura, ya está tu cotización." } } },
            // THE POST'S ID IS WHAT `create_draft` ANSWERED, read when the
            // model makes the call — the way the twin learns it.
            {
              toolCall: {
                name: "knock",
                input: {
                  get post_id() {
                    return namedPost();
                  },
                  sentence: "Ya quedó el mensaje de la cotización.",
                },
              },
            },
            { text: "Te dejé lista la cotización de [c1]." },
          ]
        : SILENT;
    await withDay(script, async (day) => {
      reading = day.model;
      day.twin.bundle.confirmChatBinding({
        chatJid: LAURA,
        entityId: randomUUID(),
        displayName: "Laura Garza",
        confirmedAt: new Date().toISOString(),
      });
      await repWrites(day.client, day.twin, "escríbele a Laura que ya está su cotización");
      await processPendingWaEvents(day.deps());

      const card = await day.client.query<{ id: string; parts_enc: Buffer }>(
        "SELECT p.id, p.parts_enc FROM posts p JOIN drafts d ON d.id = p.draft_id WHERE p.twin_id = $1 AND d.destination = $2",
        [day.twin.twinId, LAURA],
      );
      expect(card.rows).toHaveLength(1);
      const postId = card.rows[0]!.id;
      // THE CARD LANDED UNDER THE ID THE TWIN WAS TOLD AND KNOCKED ON (#358),
      // the turn's words its sentence (#368); THE KNOCK IS ITS ROW, never a part.
      expect(postId).toBe(named);
      expect(openSealedParts(day.twin.dek, card.rows[0]!.parts_enc)).toEqual([
        { kind: "prose", text: "Te dejé lista la cotización de [c1].", mentions: [expect.objectContaining({ reference: "c1", name: "Laura Garza" })] },
        expect.objectContaining({ kind: "draft", counterparty: "Laura Garza" }),
      ]);
      const knocks = await day.client.query<{ post_id: string; subject: string | null; trigger_kind: string }>(
        `SELECT k.post_id, k.subject, e.trigger_kind FROM post_knocks k JOIN executions e ON e.id = k.execution_id
          WHERE k.twin_id = $1`,
        [day.twin.twinId],
      );
      expect(knocks.rows).toEqual([{ post_id: postId, subject: null, trigger_kind: "twin_thread_message" }]);
      // ...DELIVERED BY THE ONE ARM, ONCE.
      const notifier = recordingNotifier(day.client);
      const deliver = () =>
        deliverPendingKnocks({ db: day.client, twinId: day.twin.twinId, dek: day.twin.dek, notify: notifier }, new Date());
      expect(await deliver()).toBe(1);
      expect(await deliver()).toBe(0);
      expect(notifier.asks).toEqual([{ type: "draft_ready", body: "Ya quedó el mensaje de la cotización.", about: postId }]);
      // ...AND IT WAS THAT LANDING'S ONE KNOCK: the store refuses a second.
      await expect(
        day.client.query(
          `INSERT INTO post_knocks (post_id, twin_id, text_enc, execution_id)
           VALUES ($1, $2, '\\x00', $3)`,
          [postId, day.twin.twinId, await someExecutionOf(day.client, day.twin)],
        ),
      ).rejects.toThrow(/post_knocks_one_per_reminder/u);
    });
  });

  it("refuses a second landing knock about one card, by the tool and by the store", async () => {
    let target = "";
    const script: Script = (prompt) =>
      isEventTurn(prompt, "post.landed") && prompt.includes(`"post_id":"${target}"`)
        ? threadTurns({ calls: [knockCall(target, "Primera vez."), knockCall(target, "Segunda vez.")] })
        : SILENT;
    await withDay(script, async (day) => {
      const watch = createStreamWatch();
      target = await plantDraft(day);
      await tellLandings(day, watch);
      await processPendingWaEvents(day.deps());

      const knocks = await day.client.query<{ post_id: string }>(
        "SELECT post_id FROM post_knocks WHERE twin_id = $1",
        [day.twin.twinId],
      );
      expect(knocks.rows).toEqual([{ post_id: target }]);
      expect((await opened(day, target)).parts).toContainEqual(
        expect.objectContaining({ kind: "knock", text: "Primera vez." }),
      );
      // THE REFUSAL IS THE TOOL'S ANSWER, which the turn read and went on.
      expect(lastResults(day.model, 2).filter((result) => result.includes("already had its knock"))).toHaveLength(1);
      // ...AND THE STORE REFUSES THE SAME, WHOEVER WRITES.
      await expect(
        day.client.query(
          `INSERT INTO post_knocks (post_id, twin_id, text_enc, execution_id)
           VALUES ($1, $2, '\\x00', $3)`,
          [target, day.twin.twinId, await someExecutionOf(day.client, day.twin)],
        ),
      ).rejects.toThrow(/post_knocks_one_per_reminder/u);
    });
  });
});

describe("the arrival is a turn of the thread (ticket #320 AC 3)", () => {
  /** Asks for the arrival as the page does; returns what it answered. */
  async function arrive(origin: string, seat: DoorSeat): Promise<{ woke: boolean; arrivalId?: string }> {
    const res = await fetch(`${origin}${TWIN_API_ASK_ROUTES.arrival}`, {
      method: "POST",
      headers: { authorization: `Bearer ${BEARER}`, [TWIN_API_SEAT_HEADER]: seat.seatId },
    });
    expect(res.status).toBe(200);
    return (await res.json()) as { woke: boolean; arrivalId?: string };
  }

  it("greets through the thread: `arrival` on the record, the line door-only, the curation the canvas read returns", async () => {
    let target = "";
    let reference = "";
    const script: Script = (prompt) =>
      isEventTurn(prompt, "arrival")
        ? threadTurns({ calls: [moveCardsCall(target)], answer: `Buenos días; empieza por [[${reference}]](${target}).` })
        : SILENT;
    await withDay(script, async (day) => {
      target = await plantDraft(day);
      reference = await referenceOfCard(day, target);
      const events = createSeatEvents();
      const heard: TwinStreamEvent[] = [];
      events.subscribe(day.seat.seatId, (event) => heard.push(event));
      const api = await apiOver(day, events);
      try {
        const origin = `http://127.0.0.1:${String(api.port)}`;
        const arrived = await arrive(origin, day.seat);
        expect(arrived.woke).toBe(true);
        await processPendingWaEvents(day.deps({ events }));

        // ONE VOICE: the thread's turn, recorded under the arrival's own word.
        const turns = (await executionsOf(day.client, day.twin)).filter(
          (row) => row.trigger_kind === "arrival",
        );
        expect(turns).toHaveLength(1);
        expect(turns[0]!.trigger_ref).toContain(`arrival:${arrived.arrivalId!}`);
        // THE LINE LANDED AS THE ARRIVAL POST: door-only, no delivery row, no knock.
        const post = await day.client.query<{
          id: string;
          asked_on: string;
          notice_id: string | null;
          draft_id: string | null;
          knocked: boolean;
        }>(
          `SELECT id, asked_on, notice_id, draft_id, EXISTS (SELECT 1 FROM post_knocks k WHERE k.post_id = posts.id) AS knocked
             FROM posts WHERE arrival_id = $1`,
          [arrived.arrivalId],
        );
        expect(post.rows).toHaveLength(1);
        expect(post.rows[0]).toMatchObject({
          asked_on: "dashboard",
          notice_id: null,
          draft_id: null,
          knocked: false,
        });
        const commands = await day.client.query<{ payload_ref: string }>(
          "SELECT payload_ref FROM send_commands WHERE twin_id = $1",
          [day.twin.twinId],
        );
        expect(commands.rows.some((one) => one.payload_ref.includes(post.rows[0]!.id))).toBe(false);
        // THE MARKER NAMES THE THREAD'S TURN.
        const marker = await day.client.query<{ trigger_kind: string }>(
          `SELECT e.trigger_kind FROM rep_arrival_executions m
             JOIN executions e ON e.id = m.execution_id
            WHERE m.arrival_id = $1`,
          [arrived.arrivalId],
        );
        expect(marker.rows).toEqual([{ trigger_kind: "arrival" }]);
        // THE CANVAS READ RETURNS THE LINE AND THE CURATION THE TURN WROTE.
        const canvas = await readCanvas(
          { db: day.client, twinId: day.twin.twinId, dek: day.twin.dek, timeZone: ZONE, bundle: day.twin.bundle },
          { seatId: day.seat.seatId, now: new Date() },
        );
        expect(canvas.arrival?.arrivalId).toBe(arrived.arrivalId);
        // THE LINE KEEPS THE TWIN'S REFERENCE AND ITS MARK, whose card waits —
        // the name opens exactly that card (tickets #321, #401).
        expect(canvas.arrival?.line).toBe(`Buenos días; empieza por [[${reference}]](${target}).`);
        expect(canvas.arrival?.mentions).toEqual([expect.objectContaining({ reference })]);
        expect(canvas.curation?.spotlight).toBe(target);
        // NOTHING OF THE LINE REACHED THE SEAT WHILE THE TWIN WROTE IT (ticket
        // #375): `curated` carried the line and the curation once they
        // committed, its mention linking the card that waits, and the
        // curation this turn wrote — where the page's presence goes as the bar
        // plays the line back (tickets #340, #380).
        expect(heard.filter((event) => "arrivalId" in event && event.arrivalId === arrived.arrivalId).map((event) => event.kind)).toEqual(["curated"]);
        const landed = heard.find((event) => event.kind === "curated");
        expect(landed).toMatchObject({
          kind: "curated",
          arrivalId: arrived.arrivalId,
          arrival: expect.objectContaining({
            line: canvas.arrival?.line,
            mentions: [expect.objectContaining({ reference })],
          }),
          curation: { spotlight: target },
        });

        // A RETURN WITHIN TEN MINUTES WAKES NOTHING: no record, no model call.
        const requests = day.model.requests.length;
        expect((await arrive(origin, day.seat)).woke).toBe(false);
        await processPendingWaEvents(day.deps({ events }));
        expect(day.model.requests).toHaveLength(requests);
        expect(
          (await executionsOf(day.client, day.twin)).filter((row) => row.trigger_kind === "arrival"),
        ).toHaveLength(1);
      } finally {
        await api.close();
      }
    });
  });

  it("shows the seat nothing of a line the guard sent back: `curated` carries the line written again (ticket #375)", async () => {
    // A REFERENCE THAT NAMES NOBODY, which the guard sends back, and the line
    // written again — the arrival's turn on the rig ran four such rounds.
    const script: Script = (prompt) =>
      isEventTurn(prompt, "arrival")
        ? [{ text: "Buenos días; te espera [c99]." }, { text: "Buenos días; hoy empezamos tranquilos." }]
        : SILENT;
    await withDay(script, async (day) => {
      const events = createSeatEvents();
      const heard: TwinStreamEvent[] = [];
      events.subscribe(day.seat.seatId, (event) => heard.push(event));
      const api = await apiOver(day, events);
      try {
        const arrived = await arrive(`http://127.0.0.1:${String(api.port)}`, day.seat);
        await processPendingWaEvents(day.deps({ events }));

        expect(JSON.stringify(day.model.requests.at(-1))).toContain("[c99]");
        const posted = await readCanvas(
          { db: day.client, twinId: day.twin.twinId, dek: day.twin.dek, timeZone: ZONE, bundle: day.twin.bundle },
          { seatId: day.seat.seatId, now: new Date() },
        );
        expect(posted.arrival?.line).toBe("Buenos días; hoy empezamos tranquilos.");
        expect(heard.filter((event) => "arrivalId" in event && event.arrivalId === arrived.arrivalId)).toEqual([
          expect.objectContaining({
            kind: "curated",
            arrival: expect.objectContaining({ line: posted.arrival?.line }),
          }),
        ]);
        expect(JSON.stringify(heard)).not.toContain("[c99]");
      } finally {
        await api.close();
      }
    });
  });

  it("carries no curation an earlier turn wrote on an arrival whose turn chose none (ticket #380)", async () => {
    let reference = "";
    const script: Script = (prompt) =>
      isEventTurn(prompt, "arrival") ? [{ text: `Buenos días; [${reference}] sigue esperando.` }] : SILENT;
    await withDay(script, async (day) => {
      const target = await plantDraft(day);
      reference = await referenceOfCard(day, target);
      await writeCuration({ db: day.client, dek: day.twin.dek }, {
        twinId: day.twin.twinId,
        executionId: await someExecutionOf(day.client, day.twin),
        spotlight: target,
        order: [target],
        offers: [],
        left: [],
      });
      const events = createSeatEvents();
      const heard: TwinStreamEvent[] = [];
      events.subscribe(day.seat.seatId, (event) => heard.push(event));
      const api = await apiOver(day, events);
      try {
        const arrived = await arrive(`http://127.0.0.1:${String(api.port)}`, day.seat);
        await processPendingWaEvents(day.deps({ events }));
        const ended = heard.filter((event) => "arrivalId" in event && event.arrivalId === arrived.arrivalId);
        // THE LINE NAMES THE CUSTOMER WHOSE CARD THE OLDER CURATION SPOTLIT, AND
        // MARKED NO CARD: the name draws plain (ticket #401).
        expect(ended).toEqual([
          expect.objectContaining({
            kind: "curated",
            arrival: expect.objectContaining({ line: `Buenos días; [${reference}] sigue esperando.` }),
          }),
        ]);
        expect(ended[0]).not.toHaveProperty("curation");
      } finally {
        await api.close();
      }
    });
  });

  it("opens the card the twin marked a name with, plain with none, in the arrival line, the door's reply and the history; never a card code picked (ticket #401)", async () => {
    let older = "";
    let newer = "";
    let reference = "";
    const script: Script = (prompt) =>
      isEventTurn(prompt, "arrival")
        ? [{ text: `Buenos días; [[${reference}]](${older}) te espera, y [${reference}] también.` }]
        : prompt.includes("¿y la otra?")
          ? replyTurns(`La otra de [[${reference}]](${newer}) sigue ahí.`)
          : SILENT;
    await withDay(script, async (day) => {
      const chat = `5215553${String(Math.floor(Math.random() * 1e6)).padStart(6, "0")}@s.whatsapp.net`;
      older = await plantDraft(day, chat);
      newer = await plantDraft(day, chat);
      reference = await referenceOfCard(day, older);
      const events = createSeatEvents();
      const heard: TwinStreamEvent[] = [];
      events.subscribe(day.seat.seatId, (event) => heard.push(event));
      const api = await apiOver(day, events);
      try {
        const origin = `http://127.0.0.1:${String(api.port)}`;
        const arrived = await arrive(origin, day.seat);
        await processPendingWaEvents(day.deps({ events }));
        // THE TWIN MARKED THE FIRST NAME WITH THE OLDER CARD AND THE SECOND WITH NONE.
        const said = `Buenos días; [[${reference}]](${older}) te espera, y [${reference}] también.`;
        const greeted = heard.find((event) => event.kind === "curated" && event.arrivalId === arrived.arrivalId);
        expect(greeted).toMatchObject({ arrival: { line: said } });
        const canvas = await readCanvas(
          { db: day.client, twinId: day.twin.twinId, dek: day.twin.dek, timeZone: ZONE, bundle: day.twin.bundle },
          { seatId: day.seat.seatId, now: new Date() },
        );
        expect(canvasOnTheWire(canvas).arrival?.line).toBe(said);
        expect(JSON.stringify(canvasOnTheWire(canvas).arrival?.mentions)).not.toContain("card");

        // THE DOOR'S REPLY OPENS THE CARD ITS OWN WORDS MARKED, and the history reads it the same.
        const messageId = await typeAtTheDoor(day.client, day.twin, day.seat, "¿y la otra?");
        await processPendingWaEvents(day.deps({ events }));
        const replied = heard.find((event) => event.kind === "post" && event.messageId === messageId);
        expect(JSON.stringify(replied)).toContain(`[[${reference}]](${newer})`);
        const history = await fetch(
          `${origin}${TWIN_API_ROUTES.exchanges}?now=${encodeURIComponent(new Date().toISOString())}`,
          { headers: { authorization: `Bearer ${BEARER}`, [TWIN_API_SEAT_HEADER]: day.seat.seatId } },
        );
        const page = JSON.stringify(await history.json());
        expect(page).toContain(`[[${reference}]](${older}) te espera, y [${reference}] también.`);
        expect(page).toContain(`[[${reference}]](${newer}) sigue ahí`);
      } finally {
        await api.close();
      }
    });
  });

  it("draws marked words plain once their card is taken off the canvas, and links them again once it is back (ticket #401)", async () => {
    let card = "";
    let reference = "";
    const script: Script = (prompt) =>
      isEventTurn(prompt, "arrival") ? [{ text: `Buenos días; [[${reference}]](${card}) te espera.` }] : SILENT;
    await withDay(script, async (day) => {
      card = await plantDraft(day);
      reference = await referenceOfCard(day, card);
      const events = createSeatEvents();
      const heard: TwinStreamEvent[] = [];
      events.subscribe(day.seat.seatId, (event) => heard.push(event));
      const api = await apiOver(day, events);
      try {
        const origin = `http://127.0.0.1:${String(api.port)}`;
        await arrive(origin, day.seat);
        await processPendingWaEvents(day.deps({ events }));
        const read = async (): Promise<string | undefined> =>
          canvasOnTheWire(
            await readCanvas(
              { db: day.client, twinId: day.twin.twinId, dek: day.twin.dek, timeZone: ZONE, bundle: day.twin.bundle },
              { seatId: day.seat.seatId, now: new Date() },
            ),
          ).arrival?.line;
        expect(await read()).toBe(`Buenos días; [[${reference}]](${card}) te espera.`);
        // THE TWIN TAKES THE CARD OFF THE CANVAS: the same words, the name plain.
        await writeCuration({ db: day.client, dek: day.twin.dek }, {
          twinId: day.twin.twinId,
          executionId: await someExecutionOf(day.client, day.twin),
          order: [],
          offers: [],
          left: [card],
        });
        expect(await read()).toBe(`Buenos días; [${reference}] te espera.`);
        // ...AND THE SEALED WORDS ARE UNTOUCHED: put back, it links again.
        await writeCuration({ db: day.client, dek: day.twin.dek }, {
          twinId: day.twin.twinId,
          executionId: await someExecutionOf(day.client, day.twin),
          order: [card],
          offers: [],
          left: [],
        });
        expect(await read()).toBe(`Buenos días; [[${reference}]](${card}) te espera.`);
      } finally {
        await api.close();
      }
    });
  });

  it("names the rep's message on the `curated` of a door turn that chose a card, ahead of its `post` (ticket #380)", async () => {
    let target = "";
    const script: Script = (prompt) =>
      prompt.includes("¿qué hay pendiente?")
        ? [{ toolCall: moveCardsCall(target) }, ...replyTurns("Te lo dejé arriba.")]
        : SILENT;
    await withDay(script, async (day) => {
      target = await plantDraft(day);
      await processPendingWaEvents(day.deps());
      const events = createSeatEvents();
      const heard: TwinStreamEvent[] = [];
      events.subscribe(day.seat.seatId, (event) => heard.push(event));
      const messageId = await typeAtTheDoor(day.client, day.twin, day.seat, "¿qué hay pendiente?");
      await processPendingWaEvents(day.deps({ events }));
      const told = heard.filter((event) => event.kind === "curated" || event.kind === "post");
      expect(told.map((event) => event.kind)).toEqual(["curated", "post"]);
      expect(told[0]).toMatchObject({
        kind: "curated",
        answers: [messageId],
        curation: { spotlight: target },
      });
      expect(told[1]).toMatchObject({ kind: "post", messageId });
    });
  });

  it("ends a silent arrival with `curated` and no line", async () => {
    await withDay(() => SILENT, async (day) => {
      const events = createSeatEvents();
      const heard: TwinStreamEvent[] = [];
      events.subscribe(day.seat.seatId, (event) => heard.push(event));
      const api = await apiOver(day, events);
      try {
        const arrived = await arrive(`http://127.0.0.1:${String(api.port)}`, day.seat);
        await processPendingWaEvents(day.deps({ events }));
        expect(heard.filter((event) => "arrivalId" in event && event.arrivalId === arrived.arrivalId)).toEqual([
          { kind: "curated", arrivalId: arrived.arrivalId },
        ]);
      } finally {
        await api.close();
      }
    });
  });

  it("leaves no line when the turn fails, and the page keeps its fallback: `curated` with nothing", async () => {
    // A LINE THE GUARD REFUSES, WRITTEN AGAIN EVERY TIME IT IS SENT BACK (ticket
    // #363): the turn's budget runs out on it, and nothing is posted.
    const invented = { text: "Te esperan 987654 cosas." };
    const script: Script = (prompt) =>
      isEventTurn(prompt, "arrival") ? Array.from({ length: THREAD_MAX_ITERATIONS }, () => invented) : SILENT;
    await withDay(script, async (day) => {
      const events = createSeatEvents();
      const heard: TwinStreamEvent[] = [];
      events.subscribe(day.seat.seatId, (event) => heard.push(event));
      const api = await apiOver(day, events);
      try {
        const arrived = await arrive(`http://127.0.0.1:${String(api.port)}`, day.seat);
        await processPendingWaEvents(day.deps({ events }));

        const turns = (await executionsOf(day.client, day.twin)).filter(
          (row) => row.trigger_kind === "arrival",
        );
        expect(turns.map((row) => row.disposition)).toEqual(["failed"]);
        const posts = await day.client.query("SELECT 1 FROM posts WHERE arrival_id = $1", [arrived.arrivalId]);
        expect(posts.rows).toHaveLength(0);
        const marker = await day.client.query("SELECT 1 FROM rep_arrival_executions WHERE arrival_id = $1", [
          arrived.arrivalId,
        ]);
        expect(marker.rows).toHaveLength(1);
        expect(heard.filter((event) => event.kind === "curated")).toEqual([
          { kind: "curated", arrivalId: arrived.arrivalId },
        ]);
      } finally {
        await api.close();
      }
    });
  });

  it("refuses say_on_card on a turn the twin took on its own — an arrival — and its line plays in the bar (ticket #384)", async () => {
    let target = "";
    const script: Script = (prompt) =>
      isEventTurn(prompt, "arrival")
        ? [{ toolCall: sayOnCardCall(target, "Sigue esperando precio.") }, { text: "Buenos días; te espera un borrador." }]
        : SILENT;
    await withDay(script, async (day) => {
      target = await plantDraft(day);
      const events = createSeatEvents();
      const heard: TwinStreamEvent[] = [];
      events.subscribe(day.seat.seatId, (event) => heard.push(event));
      const api = await apiOver(day, events);
      try {
        const arrived = await arrive(`http://127.0.0.1:${String(api.port)}`, day.seat);
        await processPendingWaEvents(day.deps({ events }));
        const results = toolResultsOf(day.model.requests.at(-1)).join("\n");
        expect(results).toContain("refused: you speak on a card only when the rep brought you to it");
        const notes = await day.client.query("SELECT 1 FROM posts WHERE twin_id = $1 AND on_post_id IS NOT NULL", [
          day.twin.twinId,
        ]);
        expect(notes.rows).toHaveLength(0);
        const ended = heard.filter((event) => "arrivalId" in event && event.arrivalId === arrived.arrivalId);
        expect(ended).toEqual([
          expect.objectContaining({
            kind: "curated",
            arrival: expect.objectContaining({ line: "Buenos días; te espera un borrador." }),
          }),
        ]);
        expect(ended[0]).not.toHaveProperty("note");
      } finally {
        await api.close();
      }
    });
  });
});

describe("a line nobody asked for lands on the dashboard alone (ticket #320; design D4)", () => {
  it("posts an event turn's words as a door-only line: no system_send, no send command, no knock", async () => {
    let target = "";
    let reference = "";
    const script: Script = (prompt) =>
      isEventTurn(prompt, "post.landed") && prompt.includes(`"post_id":"${target}"`)
        ? threadTurns({ answer: `Te dejé lista la respuesta de [${reference}].` })
        : SILENT;
    await withDay(script, async (day) => {
      const watch = createStreamWatch();
      target = await plantDraft(day);
      reference = await referenceOfCard(day, target);
      const commandsBefore = (
        await day.client.query("SELECT 1 FROM send_commands WHERE twin_id = $1", [day.twin.twinId])
      ).rows.length;
      const events = createSeatEvents();
      const heard: TwinStreamEvent[] = [];
      events.subscribe(day.seat.seatId, (event) => heard.push(event));
      await tellLandings(day, watch);
      await processPendingWaEvents(day.deps({ events }));

      const lines = await day.client.query<{
        asked_on: string;
        notice_id: string | null;
        draft_id: string | null;
        arrival_id: string | null;
        knocked: boolean;
      }>(
        `SELECT asked_on, notice_id, draft_id, arrival_id, EXISTS (SELECT 1 FROM post_knocks k WHERE k.post_id = posts.id) AS knocked
           FROM posts WHERE twin_id = $1 AND unasked`,
        [day.twin.twinId],
      );
      expect(lines.rows).toEqual([
        { asked_on: "dashboard", notice_id: null, draft_id: null, arrival_id: null, knocked: false },
      ]);
      const answers = await day.client.query(
        "SELECT 1 FROM notices WHERE twin_id = $1 AND kind = 'answer'",
        [day.twin.twinId],
      );
      expect(answers.rows).toHaveLength(0);
      const commandsAfter = (
        await day.client.query("SELECT 1 FROM send_commands WHERE twin_id = $1", [day.twin.twinId])
      ).rows.length;
      expect(commandsAfter).toBe(commandsBefore);
      // IT RENDERS WHERE THE ARRIVAL LINE RENDERS, and the open page hears it.
      const canvas = await readCanvas(
        { db: day.client, twinId: day.twin.twinId, dek: day.twin.dek, timeZone: ZONE, bundle: day.twin.bundle },
        { seatId: day.seat.seatId, now: new Date() },
      );
      expect(canvas.arrival?.line).toBe(`Te dejé lista la respuesta de [${reference}].`);
      expect(canvas.arrival?.arrivalId).toBeUndefined();
      expect(heard).toContainEqual(
        expect.objectContaining({ kind: "curated", arrival: expect.objectContaining({ line: canvas.arrival?.line }) }),
      );
    });
  });
});

describe("a matter the rep picks resumes in the twin's own words (ticket #335)", () => {
  /** The twin's notes hold one open matter about `postId`, labelled `label`. */
  function noteTheMatter(day: { readonly twin: Twin }, postId: string, label: string): void {
    day.twin.bundle.writeWorkingMemory({
      text: "La reserva de bombas sigue a medias.",
      matters: [{ label, about: { kind: "post", id: postId } }],
      writtenAt: new Date().toISOString(),
      executionId: randomUUID(),
    });
  }

  /** The matters the bar is served, as it reads them. */
  async function servedMatters(
    origin: string,
    seat: DoorSeat,
  ): Promise<{ label: string; about: { kind: string; id: string } }[]> {
    const asRep = { authorization: `Bearer ${BEARER}`, [TWIN_API_SEAT_HEADER]: seat.seatId };
    const served = (await (await fetch(`${origin}${TWIN_API_ROUTES.openMatters}`, { headers: asRep })).json()) as {
      matters: { label: string; about: { kind: string; id: string } }[];
    };
    return served.matters;
  }

  /** The first matter the bar is served, then the pick as the bar posts it. */
  async function pickTheFirst(
    origin: string,
    seat: DoorSeat,
    pickId: string,
  ): Promise<{ status: number; picked?: boolean }> {
    const asRep = { authorization: `Bearer ${BEARER}`, [TWIN_API_SEAT_HEADER]: seat.seatId };
    const matter = (await servedMatters(origin, seat))[0]!;
    const res = await fetch(`${origin}${TWIN_API_ASK_ROUTES.pick}`, {
      method: "POST",
      headers: { ...asRep, "content-type": "application/json" },
      body: JSON.stringify({ pickId, about: matter.about, label: matter.label }),
    });
    return { status: res.status, ...(res.ok ? ((await res.json()) as { picked: boolean }) : {}) };
  }

  it("wakes a turn told the matter by the twin's own label, and its line lands at the dashboard's door alone, under the pick", async () => {
    let target = "";
    let reference = "";
    const script: Script = (prompt) =>
      isEventTurn(prompt, "matter.picked")
        ? threadTurns({ answer: `Con [${reference}] quedamos en apartar las bombas. ¿Seguimos ahí?` })
        : SILENT;
    await withDay(script, async (day) => {
      target = await plantDraft(day);
      reference = await referenceOfCard(day, target);
      noteTheMatter(day, target, `apartarle las bombas a [${reference}]`);
      const events = createSeatEvents();
      const heard: TwinStreamEvent[] = [];
      events.subscribe(day.seat.seatId, (event) => heard.push(event));
      const api = await apiOver(day, events);
      try {
        const pickId = randomUUID();
        expect(await pickTheFirst(`http://127.0.0.1:${String(api.port)}`, day.seat, pickId)).toEqual({
          status: 200,
          picked: true,
        });
        await processPendingWaEvents(day.deps({ events }));

        // ONE TURN, WOKEN BY THE PICK, ON THE CARD THE MATTER IS ABOUT.
        const woken = (await executionsOf(day.client, day.twin)).filter(
          (row) => row.trigger_kind === "twin_thread_event",
        );
        expect(woken.map((row) => row.trigger_ref)).toEqual([
          expect.stringContaining(`event:matter.picked post:${target}`),
        ]);
        // TOLD BY THE TWIN'S OWN LABEL, AS ITS NOTES HOLD IT — the reference,
        // never the name the bar showed.
        const said = promptsIn(day.model, await openSessionId(day.client, day.twin)).join("\n");
        expect(said).toContain(
          `matter.picked {"about":"post ${target}","label":"apartarle las bombas a [${reference}]"}`,
        );
        // NOTHING IN THE REP'S NAME: no door message, no exchange.
        const messages = await day.client.query("SELECT 1 FROM dashboard_messages WHERE twin_id = $1", [
          day.twin.twinId,
        ]);
        expect(messages.rows).toHaveLength(0);
        // THE LINE IS THE DASHBOARD'S ALONE: door-only, no notice, no draft, no knock.
        const lines = await day.client.query<{ asked_on: string; notice_id: string | null; knocked: boolean }>(
          "SELECT asked_on, notice_id, EXISTS (SELECT 1 FROM post_knocks k WHERE k.post_id = posts.id) AS knocked FROM posts WHERE twin_id = $1 AND unasked",
          [day.twin.twinId],
        );
        expect(lines.rows).toEqual([{ asked_on: "dashboard", notice_id: null, knocked: false }]);
        // ...AND THE OPEN PAGE HEARS IT UNDER THE PICK, ITS NAME PLAIN: the twin marked no card.
        expect(heard).toContainEqual(
          expect.objectContaining({
            kind: "curated",
            pickId,
            arrival: expect.objectContaining({
              line: `Con [${reference}] quedamos en apartar las bombas. ¿Seguimos ahí?`,
              mentions: [expect.objectContaining({ reference })],
            }),
          }),
        );
      } finally {
        await api.close();
      }
    });
  });

  it("tells the page the turn left nothing, under the pick, when the twin stays silent", async () => {
    await withDay(() => SILENT, async (day) => {
      const target = await plantDraft(day);
      noteTheMatter(day, target, "apartarle las bombas");
      const events = createSeatEvents();
      const heard: TwinStreamEvent[] = [];
      events.subscribe(day.seat.seatId, (event) => heard.push(event));
      const api = await apiOver(day, events);
      try {
        const pickId = randomUUID();
        await pickTheFirst(`http://127.0.0.1:${String(api.port)}`, day.seat, pickId);
        await processPendingWaEvents(day.deps({ events }));
        expect(heard.filter((event) => event.kind === "curated")).toEqual([{ kind: "curated", pickId }]);
      } finally {
        await api.close();
      }
    });
  });

  it("finds nothing to tell for a matter the twin has since closed, and wakes nothing", async () => {
    await withDay(() => SILENT, async (day) => {
      const target = await plantDraft(day);
      noteTheMatter(day, target, "apartarle las bombas");
      const api = await apiOver(day);
      try {
        const origin = `http://127.0.0.1:${String(api.port)}`;
        const asRep = { authorization: `Bearer ${BEARER}`, [TWIN_API_SEAT_HEADER]: day.seat.seatId };
        const [matter] = await servedMatters(origin, day.seat);
        // THE TWIN CLOSES THE MATTER BEFORE THE REP'S TAP ARRIVES.
        day.twin.bundle.writeWorkingMemory({
          text: "",
          matters: [],
          writtenAt: new Date().toISOString(),
          executionId: randomUUID(),
        });
        const requests = day.model.requests.length;
        const res = await fetch(`${origin}${TWIN_API_ASK_ROUTES.pick}`, {
          method: "POST",
          headers: { ...asRep, "content-type": "application/json" },
          body: JSON.stringify({ pickId: randomUUID(), ...matter! }),
        });
        expect(await res.json()).toEqual({ picked: false });
        await processPendingWaEvents(day.deps());
        expect(day.model.requests).toHaveLength(requests);
        expect(
          (await executionsOf(day.client, day.twin)).filter((row) => row.trigger_kind === "twin_thread_event"),
        ).toEqual([]);
        // ...AND A BODY THAT IS NO MATTER IS A BAD REQUEST.
        for (const body of [
          { pickId: "x", about: matter!.about, label: "a" },
          { pickId: randomUUID(), about: { kind: "chat", id: target }, label: "a" },
          { pickId: randomUUID(), about: { kind: "post", id: target }, label: "" },
        ]) {
          const bad = await fetch(`${origin}${TWIN_API_ASK_ROUTES.pick}`, {
            method: "POST",
            headers: { ...asRep, "content-type": "application/json" },
            body: JSON.stringify(body),
          });
          expect(bad.status).toBe(400);
        }
      } finally {
        await api.close();
      }
    });
  });

  it("queues a pick made while the rep's own line is answered, as any event: the line's turn first, then the pick's", async () => {
    const script: Script = (prompt) =>
      isEventTurn(prompt, "matter.picked")
        ? threadTurns({ answer: "Seguimos con las bombas." })
        : isThreadTurn(prompt)
          ? [
              { toolCall: { name: "search_memory", input: { about: "bombas", counterparty: null } } },
              { text: "Te preguntaron por unas bombas." },
            ]
          : SILENT;
    await withDay(script, async (day) => {
      const target = await plantDraft(day);
      noteTheMatter(day, target, "apartarle las bombas");
      const api = await apiOver(day);
      try {
        await typeAtTheDoor(day.client, day.twin, day.seat, "¿qué hay pendiente?");
        await pickTheFirst(`http://127.0.0.1:${String(api.port)}`, day.seat, randomUUID());
        await processPendingWaEvents(day.deps());
        const turns = (await executionsOf(day.client, day.twin)).filter(
          (row) => row.trigger_kind === "twin_thread_message" || row.trigger_kind === "twin_thread_event",
        );
        expect(turns.map((row) => row.trigger_kind)).toEqual(["twin_thread_message", "twin_thread_event"]);
        expect(turns[1]!.trigger_ref).toContain("event:matter.picked");
        expect(await doorDispositions(day.client, day.twin)).toEqual(["answered"]);
      } finally {
        await api.close();
      }
    });
  });

  it("records two turns queued on one day session in the order they ran: the second began after the first ended (ticket #358)", async () => {
    const script: Script = (prompt) =>
      isEventTurn(prompt, "matter.picked")
        ? threadTurns({ answer: "Seguimos con las bombas." })
        : isThreadTurn(prompt)
          ? [
              { toolCall: { name: "search_memory", input: { about: "bombas", counterparty: null } } },
              { text: "Te preguntaron por unas bombas." },
            ]
          : SILENT;
    await withDay(script, async (day) => {
      const target = await plantDraft(day);
      noteTheMatter(day, target, "apartarle las bombas");
      const api = await apiOver(day);
      try {
        // THE PICK FIRST, THE LINE AFTER: the two reach the lane in one pass,
        // and the session runs the line's turn before the pick's whichever
        // was handed over first — the record says when each ran.
        await pickTheFirst(`http://127.0.0.1:${String(api.port)}`, day.seat, randomUUID());
        await typeAtTheDoor(day.client, day.twin, day.seat, "¿qué hay pendiente?");
        await processPendingWaEvents(day.deps());
        const turns = await day.client.query<{ trigger_kind: string; started_at: Date; ended_at: Date }>(
          `SELECT trigger_kind, started_at, ended_at FROM executions
            WHERE twin_id = $1 AND trigger_kind IN ('twin_thread_message', 'twin_thread_event')
            ORDER BY started_at, id`,
          [day.twin.twinId],
        );
        expect(turns.rows.map((row) => row.trigger_kind)).toEqual(["twin_thread_message", "twin_thread_event"]);
        expect(turns.rows[1]!.started_at.getTime()).toBeGreaterThanOrEqual(turns.rows[0]!.ended_at.getTime());
      } finally {
        await api.close();
      }
    });
  });

  it("hands the pass's turns to the day session in the order the pass raised them, whatever the lane task awaits first (ticket #358)", async () => {
    const script: Script = (prompt) =>
      isEventTurn(prompt, "matter.picked")
        ? threadTurns({ answer: "Seguimos con las bombas." })
        : isThreadTurn(prompt)
          ? [
              { toolCall: { name: "search_memory", input: { about: "bombas", counterparty: null } } },
              { text: "Te preguntaron por unas bombas." },
            ]
          : SILENT;
    await withDay(script, async (day) => {
      const target = await plantDraft(day);
      noteTheMatter(day, target, "apartarle las bombas");
      const api = await apiOver(day);
      try {
        await typeAtTheDoor(day.client, day.twin, day.seat, "¿qué hay pendiente?");
        await pickTheFirst(`http://127.0.0.1:${String(api.port)}`, day.seat, randomUUID());
        // THE LINE'S TASK IS HELD BEFORE IT REACHES THE SESSION: the first
        // `enter` of the pass — the line's, raised first — answers only once
        // the model has been asked for a turn, or after a bound, so the pick's
        // task, raised second, is free to reach the session first.
        const deps = day.deps();
        const sessions = deps.threadSessions!;
        const asked = day.model.requests.length;
        let entered = 0;
        const held: ThreadSessions = new Proxy(sessions, {
          get: (target, property, receiver: unknown) => {
            const value: unknown = Reflect.get(target, property, receiver);
            if (typeof value !== "function") return value;
            if (property !== "enter") return (value as (...args: unknown[]) => unknown).bind(target);
            return async (...args: Parameters<ThreadSessions["enter"]>) => {
              const lease = await target.enter(...args);
              entered += 1;
              if (entered === 1) {
                const bound = Date.now() + 2000;
                while (day.model.requests.length === asked && Date.now() < bound) {
                  await new Promise((resolve) => setTimeout(resolve, 10));
                }
              }
              return lease;
            };
          },
        });
        await processPendingWaEvents({ ...deps, threadSessions: held });
        const turns = (await executionsOf(day.client, day.twin)).filter(
          (row) => row.trigger_kind === "twin_thread_message" || row.trigger_kind === "twin_thread_event",
        );
        expect(entered).toBe(2);
        expect(turns.map((row) => row.trigger_kind)).toEqual(["twin_thread_message", "twin_thread_event"]);
      } finally {
        await api.close();
      }
    });
  });
});

describe("a phrase the rep selects on a card wakes the twin to explain it (ticket #341)", () => {
  /** The select ask, as the bar posts it for a phrase on `postId`. */
  async function selectOn(
    origin: string,
    seat: DoorSeat,
    postId: string,
    phrase: string,
    selectionId: string,
  ): Promise<{ status: number; selected?: boolean }> {
    const res = await fetch(`${origin}${TWIN_API_ASK_ROUTES.select}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${BEARER}`,
        [TWIN_API_SEAT_HEADER]: seat.seatId,
        "content-type": "application/json",
      },
      body: JSON.stringify({ selectionId, postId, phrase }),
    });
    return { status: res.status, ...(res.ok ? ((await res.json()) as { selected: boolean }) : {}) };
  }

  it("wakes a turn told the card and the phrase, and its line lands at the dashboard's door alone, under the selection", async () => {
    const script: Script = (prompt) =>
      isEventTurn(prompt, "selection")
        ? threadTurns({ answer: "«te las aparto» es lo que le contesté cuando pidió las bombas." })
        : SILENT;
    await withDay(script, async (day) => {
      const target = await plantDraft(day);
      const events = createSeatEvents();
      const heard: TwinStreamEvent[] = [];
      events.subscribe(day.seat.seatId, (event) => heard.push(event));
      const api = await apiOver(day, events);
      try {
        const selectionId = randomUUID();
        expect(
          await selectOn(`http://127.0.0.1:${String(api.port)}`, day.seat, target, "te las aparto", selectionId),
        ).toEqual({ status: 200, selected: true });
        await processPendingWaEvents(day.deps({ events }));

        // ONE TURN, WOKEN BY THE SELECTION, ON THE CARD IT WAS MADE ON.
        const woken = (await executionsOf(day.client, day.twin)).filter(
          (row) => row.trigger_kind === "twin_thread_event",
        );
        expect(woken.map((row) => row.trigger_ref)).toEqual([
          expect.stringContaining(`event:selection post:${target}`),
        ]);
        const said = promptsIn(day.model, await openSessionId(day.client, day.twin)).join("\n");
        expect(said).toContain(`selection {"post_id":"${target}","phrase":"te las aparto"}`);
        // NOTHING IN THE REP'S NAME: no door message, so no rep line in the thread.
        const messages = await day.client.query("SELECT 1 FROM dashboard_messages WHERE twin_id = $1", [
          day.twin.twinId,
        ]);
        expect(messages.rows).toHaveLength(0);
        // THE LINE IS THE DASHBOARD'S ALONE: door-only, no notice, no knock.
        const lines = await day.client.query<{ asked_on: string; notice_id: string | null; knocked: boolean }>(
          "SELECT asked_on, notice_id, EXISTS (SELECT 1 FROM post_knocks k WHERE k.post_id = posts.id) AS knocked FROM posts WHERE twin_id = $1 AND unasked",
          [day.twin.twinId],
        );
        expect(lines.rows).toEqual([{ asked_on: "dashboard", notice_id: null, knocked: false }]);
        // ...AND THE OPEN PAGE HEARS IT UNDER THE SELECTION, and under no pick.
        const curated = heard.filter((event) => event.kind === "curated");
        expect(curated).toEqual([
          expect.objectContaining({
            kind: "curated",
            selectionId,
            arrival: expect.objectContaining({ line: "«te las aparto» es lo que le contesté cuando pidió las bombas." }),
          }),
        ]);
        expect(curated[0]).not.toHaveProperty("pickId");
      } finally {
        await api.close();
      }
    });
  });

  it("tells the page the turn left nothing, under the selection, when the twin stays silent", async () => {
    await withDay(() => SILENT, async (day) => {
      const target = await plantDraft(day);
      const events = createSeatEvents();
      const heard: TwinStreamEvent[] = [];
      events.subscribe(day.seat.seatId, (event) => heard.push(event));
      const api = await apiOver(day, events);
      try {
        const selectionId = randomUUID();
        await selectOn(`http://127.0.0.1:${String(api.port)}`, day.seat, target, "te las aparto", selectionId);
        await processPendingWaEvents(day.deps({ events }));
        expect(heard.filter((event) => event.kind === "curated")).toEqual([{ kind: "curated", selectionId }]);
      } finally {
        await api.close();
      }
    });
  });

  it("wakes nothing for a phrase the card does not carry", async () => {
    await withDay(() => SILENT, async (day) => {
      const target = await plantDraft(day);
      const api = await apiOver(day);
      try {
        const requests = day.model.requests.length;
        expect(
          await selectOn(`http://127.0.0.1:${String(api.port)}`, day.seat, target, "te las regalo", randomUUID()),
        ).toEqual({ status: 200, selected: false });
        await processPendingWaEvents(day.deps());
        expect(day.model.requests).toHaveLength(requests);
        expect(
          (await executionsOf(day.client, day.twin)).filter((row) => row.trigger_kind === "twin_thread_event"),
        ).toEqual([]);
      } finally {
        await api.close();
      }
    });
  });
});

describe("a card the rep summons the twin to, where the twin may say one sentence (ticket #340)", () => {
  /** The summon ask, as the page posts it when the presence lands on `postId`. */
  async function summonTo(
    origin: string,
    seat: DoorSeat,
    postId: string,
    summonsId: string,
  ): Promise<{ status: number; summoned?: boolean }> {
    const res = await fetch(`${origin}${TWIN_API_ASK_ROUTES.summon}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${BEARER}`,
        [TWIN_API_SEAT_HEADER]: seat.seatId,
        "content-type": "application/json",
      },
      body: JSON.stringify({ summonsId, postId }),
    });
    return { status: res.status, ...(res.ok ? ((await res.json()) as { summoned: boolean }) : {}) };
  }

  it("wakes a turn told the card, whose say_on_card lands under it — the card's, never the bar history's — heard under the summons, and ends the turn (ticket #401)", async () => {
    let target = "";
    const sentence = "Este chat escribe desde el número que te dio en marzo.";
    const script: Script = (prompt) =>
      isEventTurn(prompt, "summons") ? threadTurns({ calls: [sayOnCardCall(target, sentence)] }) : SILENT;
    await withDay(script, async (day) => {
      target = await plantDraft(day);
      const events = createSeatEvents();
      const heard: TwinStreamEvent[] = [];
      events.subscribe(day.seat.seatId, (event) => heard.push(event));
      const api = await apiOver(day, events);
      try {
        const origin = `http://127.0.0.1:${String(api.port)}`;
        const summonsId = randomUUID();
        expect(await summonTo(origin, day.seat, target, summonsId)).toEqual({ status: 200, summoned: true });
        await processPendingWaEvents(day.deps({ events }));

        // ONE TURN, WOKEN BY THE SUMMONS, TOLD THE CARD AND NOTHING ELSE.
        const woken = (await executionsOf(day.client, day.twin)).filter(
          (row) => row.trigger_kind === "twin_thread_event",
        );
        expect(woken.map((row) => row.trigger_ref)).toEqual([
          expect.stringContaining(`event:summons post:${target}`),
        ]);
        const said = promptsIn(day.model, await openSessionId(day.client, day.twin)).join("\n");
        expect(said).toContain(`summons {"post_id":"${target}"}`);
        // THE SENTENCE IS A POST ON THAT CARD: door-only, no notice, no knock,
        // no message in the rep's name.
        const notes = await day.client.query<{
          id: string;
          on_post_id: string;
          asked_on: string;
          notice_id: string | null;
          knocked: boolean;
        }>(
          "SELECT id, on_post_id, asked_on, notice_id, EXISTS (SELECT 1 FROM post_knocks k WHERE k.post_id = posts.id) AS knocked FROM posts WHERE twin_id = $1 AND unasked",
          [day.twin.twinId],
        );
        expect(notes.rows).toEqual([
          { id: expect.any(String), on_post_id: target, asked_on: "dashboard", notice_id: null, knocked: false },
        ]);
        const messages = await day.client.query("SELECT 1 FROM dashboard_messages WHERE twin_id = $1", [
          day.twin.twinId,
        ]);
        expect(messages.rows).toHaveLength(0);
        // ...THE OPEN PAGE HEARS IT UNDER THE SUMMONS, with the card it is on,
        // and as no line of the pill's.
        expect(heard.filter((event) => event.kind === "curated")).toEqual([
          {
            kind: "curated",
            summonsId,
            note: expect.objectContaining({ postId: notes.rows[0]!.id, card: target, line: sentence }),
          },
        ]);
        // ...THE BAR'S HISTORY LISTS NONE OF IT: the sentence is the card's
        // (ticket #401), and its post stays (above).
        const res = await fetch(
          `${origin}${TWIN_API_ROUTES.exchanges}?now=${encodeURIComponent(new Date().toISOString())}`,
          { headers: { authorization: `Bearer ${BEARER}`, [TWIN_API_SEAT_HEADER]: day.seat.seatId } },
        );
        const page = (await res.json()) as TwinExchanges;
        expect(page.days.flatMap((one) => one.exchanges)).toEqual([]);
        // ...AND THE TURN ENDED ON THE SENTENCE (ticket #401): one model call,
        // and nothing asked of the model after it.
        expect(day.model.requests).toHaveLength(1);
        expect(JSON.stringify(day.model.requests)).not.toContain("no visible output");
      } finally {
        await api.close();
      }
    });
  });

  it("leaves the card as it was when the twin says nothing, and tells the page so under the summons", async () => {
    await withDay(() => SILENT, async (day) => {
      const target = await plantDraft(day);
      const events = createSeatEvents();
      const heard: TwinStreamEvent[] = [];
      events.subscribe(day.seat.seatId, (event) => heard.push(event));
      const api = await apiOver(day, events);
      try {
        const summonsId = randomUUID();
        await summonTo(`http://127.0.0.1:${String(api.port)}`, day.seat, target, summonsId);
        await processPendingWaEvents(day.deps({ events }));
        expect(heard.filter((event) => event.kind === "curated")).toEqual([{ kind: "curated", summonsId }]);
        const notes = await day.client.query("SELECT 1 FROM posts WHERE twin_id = $1 AND on_post_id IS NOT NULL", [
          day.twin.twinId,
        ]);
        expect(notes.rows).toHaveLength(0);
      } finally {
        await api.close();
      }
    });
  });

  it("ends a turn on nothing_to_say: no line, no note, one model call, and the page told under the summons (ticket #401)", async () => {
    const script: Script = (prompt) =>
      isEventTurn(prompt, "summons") ? [{ toolCall: nothingToSayCall() }, { text: "This turn has nothing to add." }] : SILENT;
    await withDay(script, async (day) => {
      const target = await plantDraft(day);
      const events = createSeatEvents();
      const heard: TwinStreamEvent[] = [];
      events.subscribe(day.seat.seatId, (event) => heard.push(event));
      const api = await apiOver(day, events);
      try {
        const summonsId = randomUUID();
        await summonTo(`http://127.0.0.1:${String(api.port)}`, day.seat, target, summonsId);
        await processPendingWaEvents(day.deps({ events }));
        expect(heard.filter((event) => event.kind === "curated")).toEqual([{ kind: "curated", summonsId }]);
        const posted = await day.client.query("SELECT 1 FROM posts WHERE twin_id = $1 AND unasked", [day.twin.twinId]);
        expect(posted.rows).toHaveLength(0);
        expect(day.model.requests).toHaveLength(1);
        expect(JSON.stringify(heard)).not.toContain("nothing to add");
      } finally {
        await api.close();
      }
    });
  });

  it("refuses a sentence on a post that is not a card of the twin's that waits, and writes nothing", async () => {
    let elsewhere = "";
    const script: Script = (prompt) =>
      isEventTurn(prompt, "summons") ? threadTurns({ calls: [sayOnCardCall(elsewhere, "Algo.")] }) : SILENT;
    await withDay(script, async (day) => {
      const target = await plantDraft(day);
      elsewhere = randomUUID();
      const api = await apiOver(day);
      try {
        await summonTo(`http://127.0.0.1:${String(api.port)}`, day.seat, target, randomUUID());
        await processPendingWaEvents(day.deps());
        const results = toolResultsOf(day.model.requests.at(-1)).join("\n");
        expect(results).toContain(`refused: post ${elsewhere} is not a card of yours that waits`);
        const notes = await day.client.query("SELECT 1 FROM posts WHERE twin_id = $1 AND on_post_id IS NOT NULL", [
          day.twin.twinId,
        ]);
        expect(notes.rows).toHaveLength(0);
      } finally {
        await api.close();
      }
    });
  });

  it("refuses a sentence on a waiting card the rep did not bring the twin to, and writes nothing (ticket #384; Codex r1)", async () => {
    let other = "";
    const script: Script = (prompt) =>
      isEventTurn(prompt, "summons") ? threadTurns({ calls: [sayOnCardCall(other, "Este también espera.")] }) : SILENT;
    await withDay(script, async (day) => {
      const target = await plantDraft(day);
      other = await plantDraft(day);
      const api = await apiOver(day);
      try {
        await summonTo(`http://127.0.0.1:${String(api.port)}`, day.seat, target, randomUUID());
        await processPendingWaEvents(day.deps());
        const results = toolResultsOf(day.model.requests.at(-1)).join("\n");
        expect(results).toContain(`refused: the rep brought you to post ${target}`);
        const notes = await day.client.query("SELECT 1 FROM posts WHERE twin_id = $1 AND on_post_id IS NOT NULL", [
          day.twin.twinId,
        ]);
        expect(notes.rows).toHaveLength(0);
      } finally {
        await api.close();
      }
    });
  });

  it("refuses say_on_card on a turn the rep's line woke, with the reason as its answer: nothing lands on the card, and the line goes to the bar (ticket #384)", async () => {
    let target = "";
    const script: Script = (prompt) =>
      prompt.includes("¿y la de Laura?")
        ? [{ toolCall: sayOnCardCall(target, "Sigue esperando precio.") }, ...replyTurns("Sigue esperando precio.")]
        : SILENT;
    await withDay(script, async (day) => {
      target = await plantDraft(day);
      await processPendingWaEvents(day.deps());
      const events = createSeatEvents();
      const heard: TwinStreamEvent[] = [];
      events.subscribe(day.seat.seatId, (event) => heard.push(event));
      const api = await apiOver(day, events);
      try {
        const messageId = await typeAtTheDoor(day.client, day.twin, day.seat, "¿y la de Laura?");
        await processPendingWaEvents(day.deps({ events }));
        // THE TOOL'S ANSWER IS THE REASON, and the turn's line is still said.
        const results = toolResultsOf(day.model.requests.at(-1)).join("\n");
        expect(results).toContain("refused: you speak on a card only when the rep brought you to it");
        // NOTHING LANDS ON THE CARD...
        const notes = await day.client.query("SELECT 1 FROM posts WHERE twin_id = $1 AND on_post_id IS NOT NULL", [
          day.twin.twinId,
        ]);
        expect(notes.rows).toHaveLength(0);
        // ...THE PAGE HEARS NO NOTE, ONLY THE REPLY...
        expect(heard.some((event) => event.kind === "curated" && event.note !== undefined)).toBe(false);
        expect(heard.filter((event) => event.kind === "post")).toEqual([
          expect.objectContaining({ kind: "post", messageId }),
        ]);
        // ...AND THE TURN IS ANSWERED AS ANY OTHER, its line the day's thread's one reply.
        expect(await doorDispositions(day.client, day.twin)).toEqual(["answered"]);
        const res = await fetch(
          `http://127.0.0.1:${String(api.port)}${TWIN_API_ROUTES.exchanges}?now=${encodeURIComponent(new Date().toISOString())}`,
          { headers: { authorization: `Bearer ${BEARER}`, [TWIN_API_SEAT_HEADER]: day.seat.seatId } },
        );
        const page = (await res.json()) as TwinExchanges;
        const exchanges = page.days.flatMap((one) => one.exchanges);
        expect(exchanges.filter((entry) => entry.line !== undefined)).toEqual([]);
        expect(exchanges.map((entry) => entry.text)).toEqual(["¿y la de Laura?"]);
        expect(exchanges[0]!.reply).toBeDefined();
      } finally {
        await api.close();
      }
    });
  });
});

describe("the rep's asks are rows the pass reads, answered once across a restart (ticket #358)", () => {
  /** One ask of the bar's, as the page posts it. */
  async function ask(origin: string, seat: DoorSeat, route: string, body?: unknown): Promise<unknown> {
    const res = await fetch(`${origin}${route}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${BEARER}`,
        [TWIN_API_SEAT_HEADER]: seat.seatId,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    expect(res.status).toBe(200);
    return await res.json();
  }

  it("leaves a row for an arrival, a pick, a selection and a summons; after a restart one pass answers each and marks it, and the next serves nothing", async () => {
    const script: Script = (prompt) =>
      ["arrival", "matter.picked", "selection", "summons"].some((kind) => isEventTurn(prompt, kind))
        ? threadTurns({ answer: "Aquí sigo con lo de las bombas." })
        : SILENT;
    await withDay(script, async (day) => {
      const target = await plantDraft(day);
      day.twin.bundle.writeWorkingMemory({
        text: "La reserva de bombas sigue a medias.",
        matters: [{ label: "apartarle las bombas", about: { kind: "post", id: target } }],
        writtenAt: new Date().toISOString(),
        executionId: randomUUID(),
      });
      const api = await apiOver(day);
      const pickId = randomUUID();
      const selectionId = randomUUID();
      const summonsId = randomUUID();
      let arrivalId: string;
      try {
        const origin = `http://127.0.0.1:${String(api.port)}`;
        const arrived = (await ask(origin, day.seat, TWIN_API_ASK_ROUTES.arrival)) as { woke: boolean; arrivalId: string };
        expect(arrived.woke).toBe(true);
        arrivalId = arrived.arrivalId;
        expect(
          await ask(origin, day.seat, TWIN_API_ASK_ROUTES.pick, {
            pickId,
            about: { kind: "post", id: target },
            label: "apartarle las bombas",
          }),
        ).toEqual({ picked: true });
        expect(
          await ask(origin, day.seat, TWIN_API_ASK_ROUTES.select, { selectionId, postId: target, phrase: "te las aparto" }),
        ).toEqual({ selected: true });
        expect(await ask(origin, day.seat, TWIN_API_ASK_ROUTES.summon, { summonsId, postId: target })).toEqual({
          summoned: true,
        });
      } finally {
        await api.close();
      }
      // NOTHING THE REP ASKED IS HELD IN MEMORY: the four are rows.
      expect(day.sessions.drain(day.twin.twinId)).toEqual([]);
      const asks = await day.client.query<{ id: string; kind: string }>(
        "SELECT id, kind FROM rep_asks WHERE twin_id = $1 ORDER BY asked_at, id",
        [day.twin.twinId],
      );
      expect(asks.rows).toEqual([
        { id: pickId, kind: "pick" },
        { id: selectionId, kind: "selection" },
        { id: summonsId, kind: "summons" },
      ]);

      // THE RUNTIME RESTARTS between the asks and the thread's turn: the day's
      // sessions this process held are gone, and a fresh registry serves.
      await day.sessions.close();
      day.sessions = createThreadSessions();
      await processPendingWaEvents(day.deps());

      // EACH ASK IS ANSWERED BY A TURN OF THE THREAD AND MARKED BY IT.
      const turns = (await executionsOf(day.client, day.twin)).filter(
        (row) => row.trigger_kind === "arrival" || row.trigger_kind === "twin_thread_event",
      );
      expect(turns.length).toBeGreaterThan(0);
      const said = turns.map((row) => row.trigger_ref).join("\n") +
        promptsIn(day.model, await openSessionId(day.client, day.twin)).join("\n");
      for (const kind of ["arrival", "matter.picked", "selection", "summons"]) expect(said).toContain(kind);
      const marked = await day.client.query<{ ask_id: string; disposition: string }>(
        "SELECT ask_id, disposition FROM rep_ask_processing WHERE twin_id = $1",
        [day.twin.twinId],
      );
      expect(marked.rows.map((row) => row.ask_id).sort()).toEqual([pickId, selectionId, summonsId].sort());
      const arrivalMarker = await day.client.query<{ trigger_kind: string }>(
        `SELECT e.trigger_kind FROM rep_arrival_executions m JOIN executions e ON e.id = m.execution_id
          WHERE m.arrival_id = $1`,
        [arrivalId],
      );
      expect(arrivalMarker.rows).toHaveLength(1);

      // ...AND A SECOND PASS — another restart, even — SERVES NOTHING TWICE.
      const requests = day.model.requests.length;
      const executions = (await executionsOf(day.client, day.twin)).length;
      await day.sessions.close();
      day.sessions = createThreadSessions();
      await processPendingWaEvents(day.deps());
      expect(day.model.requests).toHaveLength(requests);
      expect(await executionsOf(day.client, day.twin)).toHaveLength(executions);
    });
  });

  it("marks an ask whose turn failed `execution_failed`, and serves it no more", async () => {
    const script: Script = (prompt) => (isEventTurn(prompt, "summons") ? FAILS : SILENT);
    await withDay(script, async (day) => {
      const target = await plantDraft(day);
      const api = await apiOver(day);
      const summonsId = randomUUID();
      try {
        await ask(`http://127.0.0.1:${String(api.port)}`, day.seat, TWIN_API_ASK_ROUTES.summon, { summonsId, postId: target });
      } finally {
        await api.close();
      }
      await processPendingWaEvents(day.deps());
      const marked = await day.client.query<{ disposition: string }>(
        "SELECT disposition FROM rep_ask_processing WHERE ask_id = $1",
        [summonsId],
      );
      expect(marked.rows).toEqual([{ disposition: "execution_failed" }]);
      const requests = day.model.requests.length;
      await processPendingWaEvents(day.deps());
      expect(day.model.requests).toHaveLength(requests);
    });
  });
});

describe("the thread reads and searches its own days (ticket #320 AC 4)", () => {
  const PLANTED = "Quedé con Torres en mandarle la factura el viernes.";
  const MEANING = "el comprobante que le debo";

  /**
   * THE MEANING SIDE'S BOUNDARY, scripted: the embedder is the one model-shaped
   * thing the search depends on, so the suite says which two texts mean the
   * same — and the word side is left to find nothing for the meaning query.
   */
  function meaningEmbedder(): Embedder {
    const words = fakeEmbedder();
    return {
      embed: (texts) => words.embed(texts.map((text) => (text === MEANING ? PLANTED : text))),
    };
  }

  it("finds an archived day's item by its words and by its meaning, reads a draft whole, and reads the canvas after a settle", async () => {
    const plantedId = randomUUID();
    let seenPost = "";
    let settledPost = "";
    // TWO TURNS READ, inside the turn's budget each; every other turn is
    // silent. A rule, so the post ids are read once the cards are planted.
    const script: Script = (prompt) => {
      if (!isThreadTurn(prompt)) return SILENT;
      if (prompt.includes("¿qué hablamos?")) {
        return threadTurns({
          calls: [
            { name: "search_messages", input: { about: "factura Torres", since: null, until: null } },
            { name: "search_messages", input: { about: MEANING, since: null, until: null } },
            { name: "search_messages", input: { about: "inventario", since: null, until: null } },
            { name: "read_message", input: { item_id: plantedId } },
          ],
        });
      }
      if (prompt.includes("¿qué tengo?")) {
        return threadTurns({
          calls: [
            { name: "read_post", input: { post_id: seenPost } },
            { name: "read_canvas", input: {} },
          ],
        });
      }
      return SILENT;
    };
    await withDay(script, async (day) => {
      // TWO ARCHIVED DAYS, indexed by the runtime's own function.
      const embedder = meaningEmbedder();
      await indexThreadItems(
        { bundle: day.twin.bundle, embedder },
        { sessionId: randomUUID(), day: "2026-10-01" },
        [{ id: randomUUID(), role: "rep", door: "dashboard", at: new Date("2026-10-01T15:00:00Z"), text: "¿cómo vamos con Garza?" }],
      );
      await indexThreadItems(
        { bundle: day.twin.bundle, embedder },
        { sessionId: randomUUID(), day: "2026-10-02" },
        [
          { id: plantedId, role: "twin", door: "twin_thread", at: new Date("2026-10-02T17:00:00Z"), text: PLANTED },
          { id: randomUUID(), role: "event", at: new Date("2026-10-02T17:01:00Z"), text: '[Event] post.seen {"post_id":"x"}' },
        ],
      );
      // TODAY: two cards; the rep discards one and looks at the other.
      settledPost = await plantDraft(day);
      seenPost = await plantDraft(day);
      await day.client.query(
        `INSERT INTO seen_marks (company_id, seat_id, subject_kind, subject_ref)
         VALUES ($1, $2, 'post', $3)`,
        [day.seat.companyId, day.seat.seatId, seenPost],
      );
      await repWrites(day.client, day.twin, "hoy toca revisar inventario");
      await processPendingWaEvents(day.deps({ embedder }));
      const api = await apiOver(day);
      try {
        const dismissed = await fetch(
          `http://127.0.0.1:${String(api.port)}${TWIN_API_ACT_ROUTES.dismissDraft}`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${BEARER}`,
              [TWIN_API_SEAT_HEADER]: day.seat.seatId,
              "content-type": "application/json",
            },
            body: JSON.stringify({ postId: settledPost }),
          },
        );
        expect(dismissed.status).toBe(200);
      } finally {
        await api.close();
      }
      await repWrites(day.client, day.twin, "¿qué hablamos?");
      await processPendingWaEvents(day.deps({ embedder }));
      const [byWords, byMeaning, today, item] = lastResults(day.model, 4);
      await repWrites(day.client, day.twin, "¿qué tengo?");
      await processPendingWaEvents(day.deps({ embedder }));
      const [post, canvas] = lastResults(day.model, 2);
      // FIRST, EACH TIME: the word match leads, and the meaning side ranks the
      // nearest item first with no word of the query in it.
      expect(byWords?.split("\n")[0]).toContain(`[item ${plantedId}]`);
      expect(byMeaning?.split("\n")[0]).toContain(`[item ${plantedId}]`);
      expect(today?.split("\n")[0]).toContain("the rep, on WhatsApp: hoy toca revisar inventario");
      expect(item).toContain(PLANTED);
      expect(item).toContain("[2026-10-02]");
      expect(post).toContain(`post ${seenPost}`);
      expect(post).toContain("<draft>sí, te las aparto</draft>");
      expect(post).toContain("what you said: Te dejé la respuesta: pidió bombas.");
      expect(canvas).toContain(`post ${seenPost} · a draft reply`);
      expect(canvas).toMatch(new RegExp(`post ${seenPost} · .* · seen`, "u"));
      expect(canvas).not.toContain(`post ${settledPost} · a draft reply`);
      expect(canvas).toContain(`post ${settledPost} discarded`);
    });
  });
});

describe("the thread reads a customer's timeline (ticket #320)", () => {
  it("reads the timeline of the customer a card on the canvas is about", async () => {
    let card = "";
    const script: Script = (prompt) =>
      isThreadTurn(prompt) && prompt.includes("¿qué sabemos de él?")
        ? threadTurns({ calls: [{ name: "read_entity", input: { entity: card } }] })
        : SILENT;
    await withDay(script, async (day) => {
      card = await plantDraft(day);
      const chat = (
        await day.client.query<{ destination: string }>(
          "SELECT d.destination FROM posts p JOIN drafts d ON d.id = p.draft_id WHERE p.id = $1",
          [card],
        )
      ).rows[0]!.destination;
      day.twin.bundle.confirmChatBinding({
        chatJid: chat,
        entityId: randomUUID(),
        displayName: "Bombas del Norte",
        confirmedAt: "2026-10-02T15:00:00.000Z",
      });
      await repWrites(day.client, day.twin, "¿qué sabemos de él?");
      await processPendingWaEvents(day.deps());

      // BY THE CARD'S POST ID, which names the customer it is about — the
      // same customer, by the same reference, the confirmation handed on.
      const [timeline] = lastResults(day.model, 1);
      expect(timeline).toContain(`[${await referenceOfCard(day, card)}]'s timeline, oldest first:`);
      expect(timeline).toContain(
        `the rep confirmed a conversation as theirs (the number ending ${chat.split("@")[0]!.slice(-4)})`,
      );
      expect(timeline).toContain("Nothing has been recorded about them yet.");
    });
  });
});

describe("a knock is about its own card, while it waits (ticket #320; Codex r1)", () => {
  it("refuses a knock naming another card's customer, and one about a card that settled", async () => {
    let first = "";
    let settled = "";
    let own = "";
    let another = "";
    const script: Script = (prompt) =>
      isEventTurn(prompt, "post.landed") && prompt.includes(`"post_id":"${first}"`)
        ? threadTurns({
            calls: [
              knockCall(first, `Te dejé lista la respuesta para [${another}].`),
              knockCall(first, "Te dejé lista la respuesta para [c999]."),
              knockCall(settled, "Te dejé lista la respuesta."),
              knockCall(first, `Te dejé lista la respuesta para [${own}].`),
            ],
          })
        : SILENT;
    await withDay(script, async (day) => {
      const watch = createStreamWatch();
      first = await plantDraft(day);
      settled = await plantDraft(day);
      const third = await plantDraft(day);
      own = await referenceOfCard(day, first);
      another = await referenceOfCard(day, third);
      const api = await apiOver(day);
      try {
        const dismissed = await fetch(`http://127.0.0.1:${String(api.port)}${TWIN_API_ACT_ROUTES.dismissDraft}`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${BEARER}`,
            [TWIN_API_SEAT_HEADER]: day.seat.seatId,
            "content-type": "application/json",
          },
          body: JSON.stringify({ postId: settled }),
        });
        expect(dismissed.status).toBe(200);
      } finally {
        await api.close();
      }
      await tellLandings(day, watch);
      await processPendingWaEvents(day.deps());

      // THE CUSTOMER CHECK READS REFERENCES (ticket #321): another card's
      // customer is refused, a reference that names nobody costs the knock,
      // and the card's own lands.
      const [elsewhere, nobody, gone, landed] = lastResults(day.model, 4);
      expect(elsewhere).toContain("names a customer that card is not about");
      expect(nobody).toContain("[c999], which names no customer");
      expect(gone).toContain("no longer waits");
      expect(landed).toContain("will be told");
      const knocks = await day.client.query<{ post_id: string }>(
        "SELECT post_id FROM post_knocks WHERE twin_id = $1",
        [day.twin.twinId],
      );
      expect(knocks.rows).toEqual([{ post_id: first }]);
    });
  });
});

describe("the thread's own search outlives a failing embedder (ticket #320; Codex r2)", () => {
  it("keeps the items and finds them by their words when no vector can be made", async () => {
    // DOWN FOR THE THREAD'S OWN ITEMS AND ITS SEARCH ONLY: the rep's line still
    // ingests, as the rest of the pass needs it to.
    const words = fakeEmbedder();
    const failing: Embedder = {
      embed: (texts) =>
        texts.some((text) => text.includes("factura") && !text.startsWith("¿"))
          ? Promise.reject(new Error("the embedder is down"))
          : words.embed(texts),
    };
    const script: Script = (prompt) =>
      isThreadTurn(prompt) && prompt.includes("¿y la factura?")
        ? threadTurns({
            calls: [{ name: "search_messages", input: { about: "factura", since: null, until: null } }],
          })
        : SILENT;
    await withDay(script, async (day) => {
      const kept = randomUUID();
      await indexThreadItems(
        { bundle: day.twin.bundle, embedder: failing },
        { sessionId: randomUUID(), day: "2026-10-02" },
        [{ id: kept, role: "twin", door: "twin_thread", at: new Date("2026-10-02T17:00:00Z"), text: "Le mandé la factura a Torres." }],
      );
      await repWrites(day.client, day.twin, "¿y la factura?");
      await processPendingWaEvents(day.deps({ embedder: failing }));

      const [found] = lastResults(day.model, 1);
      expect(found).toContain(`[item ${kept}]`);
    });
  });
});

describe("a knock about a card that settled before it went out is not sent (ticket #320; Codex r3)", () => {
  it("delivers nothing for a draft the rep discarded between the knock and the pass", async () => {
    let target = "";
    const script: Script = (prompt) =>
      isEventTurn(prompt, "post.landed") && prompt.includes(`"post_id":"${target}"`)
        ? threadTurns({ calls: [knockCall(target, "Te dejé lista la respuesta.")] })
        : SILENT;
    await withDay(script, async (day) => {
      const watch = createStreamWatch();
      target = await plantDraft(day);
      await tellLandings(day, watch);
      await processPendingWaEvents(day.deps());
      const api = await apiOver(day);
      try {
        const dismissed = await fetch(`http://127.0.0.1:${String(api.port)}${TWIN_API_ACT_ROUTES.dismissDraft}`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${BEARER}`,
            [TWIN_API_SEAT_HEADER]: day.seat.seatId,
            "content-type": "application/json",
          },
          body: JSON.stringify({ postId: target }),
        });
        expect(dismissed.status).toBe(200);
      } finally {
        await api.close();
      }
      const knocks = await day.client.query("SELECT 1 FROM post_knocks WHERE post_id = $1", [target]);
      expect(knocks.rows).toHaveLength(1);
      const notifier = recordingNotifier(day.client);
      expect(
        await deliverPendingKnocks(
          { db: day.client, twinId: day.twin.twinId, dek: day.twin.dek, notify: notifier },
          new Date(),
        ),
      ).toBe(0);
      expect(notifier.asks).toEqual([]);
    });
  });
});

describe("a draft the rep asked for that commits them carries its reason (ticket #343)", () => {
  const LAURA = "5215550031@s.whatsapp.net";
  const TEXT = "Laura, te dejo los 300 bultos a $172 cada uno. ¿Te los aparto?";
  const REASON = "Le dejé a [c1] $172, 8% abajo de lista, porque Torres le ofreció lo mismo. Si prefieres lista, la cambio.";

  it("refuses the flag without its reason in the same turn, lands the draft with it, and read_post shows the twin its reason", async () => {
    let card = "";
    const script: Script = (prompt) => {
      if (!isThreadTurn(prompt)) return SILENT;
      if (prompt.includes("escríbele a Laura")) {
        return threadTurns({
          calls: [
            { name: "resolve_chat", input: { name: "Laura" } },
            { name: "create_draft", input: { entity: "c1", text: TEXT, delicate: true } },
            {
              name: "create_draft",
              input: { entity: "c1", text: TEXT, delicate: true, reason: REASON },
            },
          ],
          answer: "Listo, para [c1].",
        });
      }
      if (prompt.includes("¿qué le pusiste?")) return threadTurns({ calls: [{ name: "read_post", input: { post_id: card } }] });
      return SILENT;
    };
    await withDay(script, async (day) => {
      day.twin.bundle.confirmChatBinding({
        chatJid: LAURA,
        entityId: randomUUID(),
        displayName: "Laura Garza",
        confirmedAt: new Date().toISOString(),
      });
      await repWrites(day.client, day.twin, "escríbele a Laura que le dejo los bultos a 172");
      await processPendingWaEvents(day.deps());
      const [, refused, written] = lastResults(day.model, 3);
      expect(refused).toContain("refused: delicate is true and reason is empty");
      expect(written).toContain("the draft for [c1] is written");

      const post = await day.client.query<{ id: string; parts_enc: Buffer }>(
        "SELECT p.id, p.parts_enc FROM posts p JOIN drafts d ON d.id = p.draft_id WHERE p.twin_id = $1 AND d.destination = $2",
        [day.twin.twinId, LAURA],
      );
      expect(post.rows).toHaveLength(1);
      card = post.rows[0]!.id;
      // THE REFERENCE WRITTEN OUT AS THE NAME: the pill draws the reason as plain words.
      const reason = "Le dejé a Laura Garza $172, 8% abajo de lista, porque Torres le ofreció lo mismo. Si prefieres lista, la cambio.";
      expect(openSealedParts(day.twin.dek, post.rows[0]!.parts_enc).find((part) => part.kind === "draft")).toMatchObject({
        delicate: true,
        reason,
      });

      await repWrites(day.client, day.twin, "¿qué le pusiste?");
      await processPendingWaEvents(day.deps());
      const [read] = lastResults(day.model, 1);
      expect(read).toContain(`- the reason you gave the rep to read before sending it: ${reason}`);
    });
  });

  it("bounds the reason as the pill draws it, the customer's name written out (Codex r3)", async () => {
    const LONG = "Distribuidora de Materiales para la Construcción y Acabados Finos del Noreste Hermanos Garza y Asociados";
    const short = "Le dejé a [c1] $172, 8% abajo de lista, porque Torres le ofreció lo mismo la semana pasada y ella lo mencionó en su último mensaje.";
    const script: Script = (prompt) =>
      isThreadTurn(prompt)
        ? threadTurns({
            calls: [
              { name: "resolve_chat", input: { name: "Garza" } },
              { name: "create_draft", input: { entity: "c1", text: TEXT, delicate: true, reason: `${short} ${"y ".repeat(40)}listo.` } },
            ],
            answer: "Listo.",
          })
        : SILENT;
    await withDay(script, async (day) => {
      day.twin.bundle.confirmChatBinding({
        chatJid: LAURA,
        entityId: randomUUID(),
        displayName: LONG,
        confirmedAt: new Date().toISOString(),
      });
      await repWrites(day.client, day.twin, "escríbele a Garza que le dejo los bultos a 172");
      await processPendingWaEvents(day.deps());
      const [refused] = lastResults(day.model, 1);
      expect(refused).toMatch(/^refused: reason runs \d+ characters: keep it under 300/u);
      const drafts = await day.client.query("SELECT 1 FROM drafts WHERE twin_id = $1", [day.twin.twinId]);
      expect(drafts.rows).toEqual([]);
    });
  });
});

// ─── runs with steps and the clock (ticket #323) ─────────────────────────

/** When the Thursday reminder's wait falls due, and a pass clock either side of it. */
const THURSDAY = new Date("2026-10-08T15:00:00.000Z");
const BEFORE_THURSDAY = new Date(THURSDAY.getTime() - 60 * 60 * 1000);
const AFTER_THURSDAY = new Date(THURSDAY.getTime() + 60 * 1000);

/** The inline run the thread writes for «recuérdame el jueves revisar lo de Sergio». */
function reminderRun(options: { readonly failing?: boolean } = {}): Record<string, unknown> {
  return {
    name: "Revisar lo de Sergio",
    budget: { iterations: 6, tokens: 200_000 },
    steps: [
      { kind: "wait", name: "until_thursday", until: { at: THURSDAY.toISOString() } },
      {
        kind: "agent",
        name: options.failing === true ? "check_failing" : "check",
        instructions: "Read Sergio's conversation and write the reminder's line.",
        tools: ["search_memory"],
        output: { line: "string" },
      },
      { kind: "post", name: "report", text: `${options.failing === true ? "check_failing" : "check"}.line` },
    ],
  };
}

/** The thread's turn that starts it: look, start the run, say so. */
function startsTheReminder(definition: Record<string, unknown> = reminderRun()): ScriptedTurn[] {
  return threadTurns({
    calls: [
      { name: "search_memory", input: { about: "Sergio", counterparty: null } },
      { name: "start_workflow", input: { definition } },
    ],
    answer: "Listo, el jueves lo reviso.",
  });
}

/** The run's agent step: it reads, then ends on its line as its structured output. */
const CHECKS_ON_SERGIO: ScriptedTurn[] = [
  { toolCall: { name: "search_memory", input: { about: "Sergio", counterparty: null } } },
  { structured: { line: "Sergio sigue esperando tu respuesta del pedido." } },
];

/** Whether a prompt is a run's agent step. */
function isRunStep(prompt: string): boolean {
  return prompt.includes('[Run "');
}

interface RunRowSeen {
  readonly id: string;
  readonly state: string;
  readonly current_step: number;
  readonly paused: boolean;
  readonly cancelled: boolean;
  readonly session_id: string;
  readonly spent_iterations: number;
}

async function runsOf(client: pg.Client, twin: Twin): Promise<RunRowSeen[]> {
  const res = await client.query<RunRowSeen>(
    `SELECT id, state, current_step, paused, cancelled, session_id, spent_iterations
       FROM runs WHERE twin_id = $1 ORDER BY created_at, id`,
    [twin.twinId],
  );
  return res.rows;
}

async function stepRowsOf(
  client: pg.Client,
  runId: string,
): Promise<{ step_index: number; kind: string; state: string; execution_id: string | null }[]> {
  const res = await client.query(
    "SELECT step_index, kind, state, execution_id FROM run_steps WHERE run_id = $1 ORDER BY step_index",
    [runId],
  );
  return res.rows as never;
}

/** The posts a run wrote: a notice under one of its steps' executions. */
async function runPostsOf(client: pg.Client, twin: Twin, runId: string): Promise<string[]> {
  const res = await client.query<{ content_enc: Buffer }>(
    `SELECT n.content_enc FROM notices n
       JOIN executions e ON e.id = n.execution_id
      WHERE n.twin_id = $1 AND e.trigger_kind = 'run_step' AND e.trigger_ref LIKE $2
      ORDER BY n.created_at`,
    [twin.twinId, `% run:${runId} %`],
  );
  return res.rows.map((row) => Buffer.from(twin.dek.decrypt(row.content_enc)).toString("utf8"));
}

/** This twin's draft cards, oldest first: their sealed parts and the thread's text (ticket #396). */
async function draftCardsOf(
  client: pg.Client,
  twin: Twin,
): Promise<{ readonly parts: readonly PostPart[]; readonly text: string }[]> {
  const res = await client.query<{ parts_enc: Buffer; post_enc: Buffer }>(
    `SELECT p.parts_enc, d.post_enc FROM posts p JOIN drafts d ON d.id = p.draft_id
      WHERE p.twin_id = $1 ORDER BY p.posted_at, p.id`,
    [twin.twinId],
  );
  return res.rows.map((row) => ({
    parts: openSealedParts(twin.dek, row.parts_enc),
    text: Buffer.from(twin.dek.decrypt(row.post_enc)).toString("utf8"),
  }));
}

/** The day's deps with one runs engine, and a pass of the clock at `now` that waits for its lane. */
function withRuns(day: { readonly deps: () => TwinRuntimeDeps }): {
  readonly deps: TwinRuntimeDeps & { readonly runs: RunEngine };
  tick(now: Date): Promise<void>;
} {
  const deps = { ...day.deps(), runs: createRunEngine() };
  return {
    deps,
    async tick(now) {
      const batch = openBatchWork();
      await advanceRuns(deps, now, batch);
      await batch.lane.settle();
    },
  };
}

describe("a run started from a turn waits on the clock, reports, and wakes the thread at its end (ticket #323 AC 1)", () => {
  it("creates the run ready with its wait on the clock store, fires it past the instant, resumes its session, posts, succeeds, and wakes a turn on run.finished", async () => {
    const script: Script = (prompt) =>
      isRunStep(prompt)
        ? CHECKS_ON_SERGIO
        : isEventTurn(prompt, "run.finished")
          ? SILENT
          : startsTheReminder();
    await withDay(script, async (day) => {
      const runs = withRuns(day);
      await repWrites(day.client, day.twin, "recuérdame el jueves revisar lo de Sergio");
      await processPendingWaEvents(runs.deps);

      // THE TURN STARTED IT: the row in `ready`, the wait on the clock store.
      const [run] = await runsOf(day.client, day.twin);
      expect(run).toMatchObject({ state: "ready", current_step: 0, paused: false, cancelled: false });
      const schedules = await day.client.query<{ kind: string; fire_at: Date; fired_at: Date | null; step_index: number }>(
        "SELECT kind, fire_at, fired_at, step_index FROM schedules WHERE run_id = $1",
        [run!.id],
      );
      expect(schedules.rows).toEqual([{ kind: "once", fire_at: THURSDAY, fired_at: null, step_index: 0 }]);

      // THE PASS TAKES IT BEFORE THE INSTANT: it parks on its wait, and the
      // thread is told it started — the start and the park only append
      // (decision 11; boundary #327 F4: a run starting wakes nothing, the
      // turn that started it already told the rep).
      await runs.tick(BEFORE_THURSDAY);
      expect((await runsOf(day.client, day.twin))[0]).toMatchObject({ state: "waiting", current_step: 0 });
      await processPendingWaEvents(runs.deps);
      const id = await openSessionId(day.client, day.twin);
      const told = promptsIn(day.model, id).join("\n");
      expect(told).toContain(`run.started {"run_id":"${run!.id}"}`);
      expect(told).toContain(`run.suspended {"run_id":"${run!.id}","step":"1","state":"waiting"}`);
      expect((await executionsOf(day.client, day.twin)).map((row) => row.trigger_ref.split(" ")[3])).toEqual([
        expect.stringMatching(/^event:/u),
      ]);

      // THE CLOCK PASSES THE INSTANT: the wait fires, the agent step runs on
      // the run's own session, resumed, and the post step reports.
      await runs.tick(AFTER_THURSDAY);
      const ended = (await runsOf(day.client, day.twin))[0]!;
      expect(ended).toMatchObject({ state: "succeeded", current_step: 2 });
      const fired = await day.client.query<{ fired_at: Date | null }>(
        "SELECT fired_at FROM schedules WHERE run_id = $1",
        [run!.id],
      );
      expect(fired.rows[0]!.fired_at).toEqual(AFTER_THURSDAY);
      const stepRequest = day.model.requests.find((request) => isRunStep(latestPromptOf(request)))!;
      expect(transcriptOf(stepRequest).some((entry) => "text" in entry && entry.text.includes(`[Run "Revisar lo de Sergio" · started`))).toBe(true);
      expect(systemOf(stepRequest)).toContain("Read Sergio's conversation and write the reminder's line.");
      expect(toolNamesOf(stepRequest)).toEqual(expect.arrayContaining(["search_memory", "StructuredOutput"]));
      expect(toolNamesOf(stepRequest)).not.toContain("submit_step");
      expect(toolNamesOf(stepRequest)).not.toContain("create_draft");
      expect(existsSync(sessionFile(day.model.harness.directory, ended.session_id))).toBe(true);
      expect((await runPostsOf(day.client, day.twin, run!.id)).join("\n")).toContain(
        "Sergio sigue esperando tu respuesta del pedido.",
      );
      // THE TWIN'S OWN WORDS FROM A TYPED FIELD STAY PROSE (ticket #358).
      // ...AND THE CARD CARRIES NO LINE NAMING ITS RUN (ticket #399).
      expect((await runPostPartsOf(day.client, day.twin, run!.id)).flat().map((part) => part.kind)).toEqual(["prose"]);

      // ONE EXECUTION PER STEP, each a `run_step` record naming the run and the step.
      const steps = await stepRowsOf(day.client, run!.id);
      expect(steps.map((step) => [step.step_index, step.kind, step.state])).toEqual([
        [0, "wait", "succeeded"],
        [1, "agent", "succeeded"],
        [2, "post", "succeeded"],
      ]);
      const stepExecutions = (await executionsOf(day.client, day.twin)).filter(
        (row) => row.trigger_kind === "run_step",
      );
      expect(stepExecutions.map((row) => [row.trigger_ref.split(" ").at(-1), row.disposition])).toEqual([
        ["step:0", "no-action"],
        ["step:1", "answered"],
        ["step:2", "posted"],
      ]);

      // RUN.FINISHED WAKES A TURN of the day's conversation.
      await processPendingWaEvents(runs.deps);
      // ...NAMING THE REPORT THE RUN POSTED, so the turn can read it.
      const reports = await day.client.query<{ id: string }>(
        `SELECT p.id FROM posts p JOIN executions e ON e.id = p.execution_id
          WHERE p.twin_id = $1 AND e.trigger_ref LIKE $2`,
        [day.twin.twinId, `% run:${run!.id} step:2`],
      );
      const executions = await executionsOf(day.client, day.twin);
      expect(executions.some((row) => row.trigger_ref.includes(`event:run.finished post:${reports.rows[0]!.id}`))).toBe(true);
      expect(executions.some((row) => row.trigger_ref.includes("event:run.step"))).toBe(false);
    });
  });
});

/**
 * A script for a day that starts the reminder on its first line and then does
 * whatever `later` says on the rep's next one, with the run's id in hand — the
 * id the first turn's tool gave back, which the test reads off the row.
 */
function reminderDay(options: {
  readonly later?: (runId: string) => ScriptedTurn[];
  readonly step?: readonly ScriptedTurn[];
  readonly definition?: Record<string, unknown>;
}): { readonly script: Script; setRun(runId: string): void } {
  let runId = "";
  return {
    setRun: (id) => {
      runId = id;
    },
    script: (prompt) =>
      isRunStep(prompt)
        ? (options.step ?? CHECKS_ON_SERGIO)
        : isThreadTurn(prompt) && prompt.includes("recuérdame el jueves")
          ? startsTheReminder(options.definition)
          : isThreadTurn(prompt) && options.later !== undefined
            ? options.later(runId)
            : SILENT,
  };
}

/** A rep line about the run, answered with one run tool call; what the tool did is the whole answer. */
function runToolTurn(name: string, input: Record<string, unknown>): ScriptedTurn[] {
  return threadTurns({ calls: [{ name, input }] });
}

/** Starts the reminder from the rep's line and parks it on its wait; returns the run. */
async function startAndPark(
  day: { readonly client: pg.Client; readonly twin: Twin },
  runs: ReturnType<typeof withRuns>,
  setRun: (runId: string) => void,
): Promise<RunRowSeen> {
  await repWrites(day.client, day.twin, "recuérdame el jueves revisar lo de Sergio");
  await processPendingWaEvents(runs.deps);
  await runs.tick(BEFORE_THURSDAY);
  // ...AND THE THREAD HEARS THE START, in a turn of its own.
  await processPendingWaEvents(runs.deps);
  const run = (await runsOf(day.client, day.twin))[0]!;
  expect(run.state).toBe("waiting");
  setRun(run.id);
  return run;
}

describe("the rep steers, pauses and cancels a run, and the seat gates it (ticket #323 AC 2)", () => {
  it("appends guidance while it waits, and the run's next agent step reads it in its request", async () => {
    const day = reminderDay({
      later: (runId) =>
        runToolTurn("steer_run", { run_id: runId, guidance: "Pregúntale también por el pago pendiente." }),
    });
    await withDay(day.script, async (d) => {
      const runs = withRuns(d);
      await startAndPark(d, runs, day.setRun);
      await repWrites(d.client, d.twin, "y que también le pregunte por el pago");
      await processPendingWaEvents(runs.deps);
      await runs.tick(AFTER_THURSDAY);

      expect((await runsOf(d.client, d.twin))[0]!.state).toBe("succeeded");
      const stepRequest = d.model.requests.find((request) => isRunStep(latestPromptOf(request)))!;
      const guided = transcriptOf(stepRequest).find(
        (entry) => "text" in entry && entry.text.includes("[Guidance from the rep"),
      );
      expect(guided).toBeDefined();
      expect("text" in guided! && guided.text).toContain("Pregúntale también por el pago pendiente.");
      // NOTHING OF THE GUIDANCE ON A COORDINATION ROW.
      const rows = await d.client.query("SELECT r.*, s.* FROM runs r LEFT JOIN run_steps s ON s.run_id = r.id WHERE r.twin_id = $1", [d.twin.twinId]);
      expect(JSON.stringify(rows.rows)).not.toContain("pago");
    });
  });

  it("pauses it: the pass fires nothing for it, and the row stays waiting", async () => {
    const day = reminderDay({
      later: (runId) => runToolTurn("pause_run", { run_id: runId, paused: true }),
    });
    await withDay(day.script, async (d) => {
      const runs = withRuns(d);
      const run = await startAndPark(d, runs, day.setRun);
      await repWrites(d.client, d.twin, "mejor pausa lo de Sergio");
      await processPendingWaEvents(runs.deps);
      await runs.tick(AFTER_THURSDAY);

      expect((await runsOf(d.client, d.twin))[0]).toMatchObject({ state: "waiting", paused: true });
      const fired = await d.client.query("SELECT fired_at FROM schedules WHERE run_id = $1", [run.id]);
      expect(fired.rows).toEqual([{ fired_at: null }]);
      expect(d.model.requests.some((request) => isRunStep(latestPromptOf(request)))).toBe(false);
      expect((await stepRowsOf(d.client, run.id)).map((step) => step.state)).toEqual(["waiting"]);
    });
  });

  it("cancels it: the run ends at the pass with its report, flagged, and its end wakes the thread naming the report", async () => {
    const day = reminderDay({
      later: (runId) => runToolTurn("cancel_run", { run_id: runId }),
    });
    await withDay(day.script, async (d) => {
      const runs = withRuns(d);
      const run = await startAndPark(d, runs, day.setRun);
      await repWrites(d.client, d.twin, "olvídalo, cancela lo de Sergio");
      await processPendingWaEvents(runs.deps);
      await runs.tick(BEFORE_THURSDAY);

      expect((await runsOf(d.client, d.twin))[0]).toMatchObject({ state: "failed", cancelled: true });
      expect(await runPostsOf(d.client, d.twin, run.id)).toEqual([
        expect.stringContaining("Cancelé «Revisar lo de Sergio»."),
      ]);
      // CODE'S ENDING IS A RECEIPT, never the twin's prose (ticket #358).
      expect(await runPostPartsOf(d.client, d.twin, run.id)).toEqual([
        [{ kind: "receipt", text: "Cancelé «Revisar lo de Sergio»." }],
      ]);
      await processPendingWaEvents(runs.deps);
      const said = promptsIn(d.model, await openSessionId(d.client, d.twin)).join("\n");
      expect(said).toContain(`run.finished {"run_id":"${run.id}","state":"cancelled","post_id":"`);
      expect((await executionsOf(d.client, d.twin)).some((row) => row.trigger_ref.includes("event:run.finished post:"))).toBe(true);
      // ...AND NOTHING OF IT FIRES AFTERWARDS.
      await runs.tick(AFTER_THURSDAY);
      expect(d.model.requests.some((request) => isRunStep(latestPromptOf(request)))).toBe(false);
    });
  });

  it("fires nothing for a run whose seat is not linked, and leaves its row as it stood", async () => {
    const day = reminderDay({});
    await withDay(day.script, async (d) => {
      const runs = withRuns(d);
      const run = await startAndPark(d, runs, day.setRun);
      await d.client.query("UPDATE seats SET state = 'invited' WHERE id = $1", [d.seat.seatId]);
      await runs.tick(AFTER_THURSDAY);

      expect((await runsOf(d.client, d.twin))[0]).toMatchObject({ state: "waiting", current_step: 0 });
      const fired = await d.client.query("SELECT fired_at FROM schedules WHERE run_id = $1", [run.id]);
      expect(fired.rows).toEqual([{ fired_at: null }]);
      expect(d.model.requests.some((request) => isRunStep(latestPromptOf(request)))).toBe(false);
    });
  });
});

describe("a failed agent step ends the run and nothing restarts it (ticket #323 AC 3)", () => {
  it("ends it failed with a report post and one execution per step, and the next pass starts nothing", async () => {
    const day = reminderDay({ step: FAILS });
    await withDay(day.script, async (d) => {
      const runs = withRuns(d);
      const run = await startAndPark(d, runs, day.setRun);
      await runs.tick(AFTER_THURSDAY);

      expect((await runsOf(d.client, d.twin))[0]).toMatchObject({ state: "failed", current_step: 1, cancelled: false });
      expect((await stepRowsOf(d.client, run.id)).map((step) => [step.kind, step.state])).toEqual([
        ["wait", "succeeded"],
        ["agent", "failed"],
      ]);
      const stepExecutions = (await executionsOf(d.client, d.twin)).filter((row) => row.trigger_kind === "run_step");
      expect(stepExecutions.map((row) => [row.trigger_ref.split(" ").at(-1), row.disposition])).toEqual([
        ["step:0", "no-action"],
        ["step:1", "failed"],
      ]);
      expect(await runPostsOf(d.client, d.twin, run.id)).toEqual([
        expect.stringContaining("Se detuvo «Revisar lo de Sergio» en el paso 2 de 3."),
      ]);
      expect(await runPostPartsOf(d.client, d.twin, run.id)).toEqual([
        [{ kind: "receipt", text: "Se detuvo «Revisar lo de Sergio» en el paso 2 de 3. Queda en Trabajos en curso." }],
      ]);
      // THE NEXT PASSES START NOTHING: no model call, no record.
      const requests = d.model.requests.length;
      await runs.tick(new Date(AFTER_THURSDAY.getTime() + 60_000));
      await runs.tick(new Date(AFTER_THURSDAY.getTime() + 120_000));
      expect(d.model.requests.filter((request) => isRunStep(latestPromptOf(request)))).toHaveLength(
        d.model.requests.slice(0, requests).filter((request) => isRunStep(latestPromptOf(request))).length,
      );
      expect((await executionsOf(d.client, d.twin)).filter((row) => row.trigger_kind === "run_step")).toHaveLength(2);
      // ...AND THE FAILURE WAKES A TURN.
      await processPendingWaEvents(runs.deps);
      expect((await executionsOf(d.client, d.twin)).some((row) => row.trigger_ref.includes("event:run.failed"))).toBe(true);
    });
  });
});

// ─── a step's rounds and the rep's chats (ticket #396) ──────────────────

describe("a step's rounds are the run's budget, never a constant (ticket #396, F9)", () => {
  it("a rutina's agent step with twelve rounds runs past six: it completes at round eight", async () => {
    const script: Script = (prompt) => {
      if (isThreadTurn(prompt)) {
        return prompt.includes("revisa mis chats con calma")
          ? startsRun({
              definition: {
                name: "Revisar con calma",
                budget: { iterations: 12, tokens: 400_000 },
                steps: [
                  { kind: "agent", name: "look", instructions: "Look through the rep's chats.", tools: ["list_chats"], output: { line: "string" } },
                  { kind: "post", name: "report", text: "look.line" },
                ],
              },
            })
          : SILENT;
      }
      return isStep(prompt, "look")
        ? [
            ...Array.from({ length: 7 }, (): ScriptedTurn => ({ toolCall: { name: "list_chats", input: {} } })),
            { structured: { line: "Revisé todos tus chats." } },
          ]
        : SILENT;
    };
    await withDay(script, async (day) => {
      confirmThree(day.twin);
      const runs = withRuns(day);
      await repWrites(day.client, day.twin, "revisa mis chats con calma");
      await processPendingWaEvents(runs.deps);
      await runs.tick(THURSDAY);

      const [run] = await runsOf(day.client, day.twin);
      expect(run).toMatchObject({ state: "succeeded" });
      expect(stepRequests(day.model, "look")).toHaveLength(8);
      const look = await day.client.query<{ iterations: number; disposition: string }>(
        `SELECT iterations, disposition FROM executions
          WHERE twin_id = $1 AND trigger_kind = 'run_step' AND trigger_ref LIKE $2`,
        [day.twin.twinId, `% run:${run!.id} step:0`],
      );
      expect(look.rows).toEqual([{ iterations: 8, disposition: "answered" }]);
      expect((await runPostsOf(day.client, day.twin, run!.id)).at(-1)).toContain("Revisé todos tus chats.");
    });
  });
});

describe("every read of the rep's chats is the twin's and every rutina's (ticket #396; Diego, 2026-10-12)", () => {
  /**
   * Laura wrote last, the rep wrote last to Sergio, and Torres has said
   * nothing in the twin's memory — and the rep's own thread speaks of the
   * same quote, which no search of their customers' conversations reaches.
   */
  async function chatsWithAnswers(twin: Twin): Promise<void> {
    const at = (minutes: number): string => new Date(Date.parse("2026-10-12T15:00:00.000Z") + minutes * 60_000).toISOString();
    const message = (chatJid: string, id: string, fromMe: boolean, minutes: number, content: string): void => {
      twin.bundle.ingestMessage({
        chatJid,
        messageId: id,
        senderJid: fromMe ? SELF_CHAT : chatJid,
        fromMe,
        occurredAt: at(minutes),
        content,
      });
    };
    message(STALE_CHATS.laura, "LAURA-1", true, 0, "Te mando la cotización de los bultos.");
    message(STALE_CHATS.laura, "LAURA-2", false, 30, "Gracias, la reviso y te digo.");
    message(STALE_CHATS.sergio, "SERGIO-1", false, 10, "¿Me cotizas 40 bultos?");
    message(STALE_CHATS.sergio, "SERGIO-2", true, 60, "Claro, va la cotización de los 40 bultos.");
    message(SELF_CHAT, "SELF-1", true, 70, "Recordar la cotización de bultos de Sergio.");
    await embedMessageBacklog({ bundle: twin.bundle, embedder: fakeEmbedder() });
  }

  it("the thread lists the rep's customers with who wrote last, newest first, and no words of theirs", async () => {
    const script: Script = (prompt) =>
      isThreadTurn(prompt) && prompt.includes("¿quién me debe respuesta?")
        ? threadTurns({ calls: [{ name: "list_chats", input: {} }], answer: "Te debo revisar." })
        : SILENT;
    await withDay(script, async (day) => {
      const refs = confirmThree(day.twin);
      await chatsWithAnswers(day.twin);
      await repWrites(day.client, day.twin, "¿quién me debe respuesta?");
      await processPendingWaEvents(day.deps());

      const [listed] = lastResults(day.model, 1);
      const lines = listed!.split("\n");
      expect(lines[0]).toBe("The customers the rep has confirmed, newest conversation first:");
      expect(lines[1]).toContain(`${refs.sergio} Sergio Ruiz — last message `);
      expect(lines[1]).toMatch(/, from the rep$/u);
      expect(lines[2]).toContain(`${refs.laura} Laura Garza — last message `);
      expect(lines[2]).toMatch(/, from the customer$/u);
      expect(lines[3]).toBe(`${refs.torres} Torres Hermanos — no message in your memory yet`);
      // AN INDEX AND NOTHING MORE: no customer's words cross through it.
      expect(listed).not.toContain("cotización");
      expect(listed).not.toContain("Gracias");
    });
  });

  it("a rep's rutina reads the index, searches a customer's conversation and reads their record — never the twin's own thread", async () => {
    let refs = { laura: "", torres: "", sergio: "" };
    const script: Script = (prompt) => {
      if (isThreadTurn(prompt)) {
        return prompt.includes("revisa quién no me ha contestado")
          ? startsRun({
              definition: {
                name: "Quién no me ha contestado",
                budget: { iterations: 12, tokens: 400_000 },
                steps: [
                  {
                    kind: "agent",
                    name: "find",
                    instructions: "Find the customers who have not answered the rep.",
                    tools: ["list_chats", "search_chat_history", "read_filed_facts"],
                    output: { line: "string" },
                  },
                  { kind: "post", name: "report", text: "find.line" },
                ],
              },
            })
          : SILENT;
      }
      return isStep(prompt, "find")
        ? [
            { toolCall: { name: "list_chats", input: {} } },
            { toolCall: { name: "search_chat_history", input: { about: "cotización de bultos", chat: refs.sergio } } },
            { toolCall: { name: "search_chat_history", input: { about: "cotización de bultos", chat: null } } },
            { toolCall: { name: "read_filed_facts", input: { chat: refs.sergio } } },
            { structured: { line: `${refs.sergio} no te ha contestado.` } },
          ]
        : SILENT;
    };
    await withDay(script, async (day) => {
      refs = confirmThree(day.twin);
      await chatsWithAnswers(day.twin);
      const runs = withRuns(day);
      await repWrites(day.client, day.twin, "revisa quién no me ha contestado");
      await processPendingWaEvents(runs.deps);
      await runs.tick(THURSDAY);

      const [run] = await runsOf(day.client, day.twin);
      expect(run).toMatchObject({ state: "succeeded" });
      const [listed, searched, everywhere, record] = toolResultsOf(stepRequests(day.model, "find").at(-1));
      expect(listed).toContain("Sergio Ruiz — last message");
      expect(listed).toContain(", from the rep");
      // ONE CUSTOMER'S CONVERSATIONS, BY THEIR REFERENCE...
      expect(searched).toContain(`${refs.sergio} Sergio Ruiz`);
      expect(searched).not.toContain("Laura Garza");
      // ...OR EVERY CUSTOMER'S, AND NEVER THE TWIN'S OWN THREAD (ADR-0033).
      expect(everywhere).toContain("Laura Garza");
      expect(everywhere).not.toContain("this thread");
      expect(everywhere).not.toContain("Recordar la cotización");
      expect(record).toBe(`Nothing is recorded for ${refs.sergio} yet.`);
      expect((await runPostsOf(day.client, day.twin, run!.id)).at(-1)).toContain("Sergio Ruiz no te ha contestado.");
    });
  });
});

// ─── rutinas: the twin writes an automation (ticket #325) ────────────────

/** The plan the twin writes for «cada viernes a las 9 mándame la lista…». */
const FRIDAY_LIST = {
  name: "Clientes sin contacto de la semana",
  budget: { iterations: 6, tokens: 120_000 },
  steps: [
    {
      kind: "agent",
      name: "find",
      instructions: "List the customers the rep has not written to this week, one per line.",
      tools: ["search_memory"],
      output: { list: "string" },
    },
    { kind: "post", name: "report", text: "find.list" },
  ],
} as const;

/** Every Friday at nine, as the twin types the wake. */
const FRIDAY_AT_NINE = { schedule: { every: "week", weekdays: ["friday"], at_hour: 9 } } as const;

const FRIDAY_SENTENCE =
  "Cada viernes a las 9 te mando la lista de los clientes a los que no has escrito en la semana.";

/** A turn that writes the Friday rutina, on the twin's word for who asked. */
function writesTheRutina(overrides: Readonly<Record<string, unknown>> = {}): ScriptedTurn[] {
  return threadTurns({
    tool: CREATE_AUTOMATION_TOOL,
    input: {
      asked_by: "rep",
      sentence: FRIDAY_SENTENCE,
      wake: FRIDAY_AT_NINE,
      definition: FRIDAY_LIST,
      ...overrides,
    },
    answer: "Listo.",
  });
}

interface RutinaSeen {
  readonly id: string;
  readonly origin: string;
  readonly state: string;
  readonly definition_digest: string;
  readonly wake: string;
  readonly every: string | null;
  readonly weekdays: number[] | null;
  readonly at_hour: number | null;
  readonly activated_at: Date | null;
  readonly ended_at: Date | null;
  readonly proposal_post_id: string | null;
}

async function rutinasOf(client: pg.Client, twin: Twin): Promise<RutinaSeen[]> {
  const res = await client.query<RutinaSeen>(
    `SELECT id, origin, state, definition_digest, wake, every, weekdays, at_hour, activated_at, ended_at, proposal_post_id
       FROM automations WHERE twin_id = $1 AND origin <> 'dito' ORDER BY created_at`,
    [twin.twinId],
  );
  return res.rows;
}

/** The proposal cards the twin posted, oldest first. */
async function proposalCards(client: pg.Client, twin: Twin): Promise<string[]> {
  const rows = await client.query<{ id: string }>(
    `SELECT p.id FROM posts p JOIN notices n ON n.id = p.notice_id
      WHERE p.twin_id = $1 AND n.kind = 'proposal' ORDER BY p.posted_at, p.id`,
    [twin.twinId],
  );
  return rows.rows.map((row) => row.id);
}

/**
 * THE NEXT WHOLE HOUR, and its hour of the rep's day: Monterrey keeps UTC−6
 * all year, so the rep's hour is six behind the clock's.
 */
function nextWholeHour(now: Date): { readonly at: Date; readonly atHour: number } {
  const at = new Date(Math.floor(now.getTime() / 3_600_000) * 3_600_000 + 3_600_000);
  return { at, atHour: (at.getUTCHours() + 18) % 24 };
}

/** Activar or Descartar pressed on the card, or the switch on Rutinas: the dashboard act on the rutina. */
async function actOnTheRutina(
  day: {
    readonly client: pg.Client;
    readonly twin: Twin;
    readonly seat: DoorSeat;
    readonly model: ScriptedModel;
    readonly sessions: ThreadSessions;
  },
  route: "activateAutomation" | "discardAutomation" | "pauseAutomation" | "resumeAutomation",
  automation: string,
  events?: SeatEvents,
  /** The proposal card the button was pressed on, when it was. */
  proposal?: string,
): Promise<string> {
  return await performDashboardAct(
    {
      db: day.client,
      dek: day.twin.dek,
      twinId: day.twin.twinId,
      hmacKey: TEST_AUDIT_HMAC_KEY,
      bundle: day.twin.bundle,
      selfChatJid: SELF_CHAT,
      harnessDirectory: day.model.harness.directory,
      thread: day.sessions,
      ...(events === undefined ? {} : { events }),
    },
    { companyId: day.seat.companyId, seatId: day.seat.seatId },
    { target: "automation", route, automation, ...(proposal === undefined ? {} : { proposal }) },
  );
}

/** A seat bus that keeps what it heard. */
function heardOn(seatId: string): { readonly events: SeatEvents; readonly heard: TwinStreamEvent[] } {
  const events = createSeatEvents();
  const heard: TwinStreamEvent[] = [];
  events.subscribe(seatId, (event) => heard.push(event));
  return { events, heard };
}

describe("a rutina the rep asks for is live at the ask (ticket #386; Diego's ruling of 2026-10-11)", () => {
  it("a daily rutina asked for in a line is active at birth, fires the first instant at or after the ask with no Activar, and the twin is told that instant", async () => {
    const next = nextWholeHour(new Date());
    const daily = { schedule: { every: "day", at_hour: next.atHour } };
    let asked = "";
    await withDay(
      (prompt) => (isThreadTurn(prompt) ? writesTheRutina({ wake: daily }) : SILENT),
      async (day) => {
        const runs = withRuns(day);
        asked = await repWrites(day.client, day.twin, "cada día a esta hora mándame la lista de los clientes sin contacto");
        await processPendingWaEvents(runs.deps);

        const [rutina] = await rutinasOf(day.client, day.twin);
        expect(rutina).toMatchObject({
          origin: "rep",
          state: "active",
          wake: "schedule",
          every: "day",
          weekdays: null,
          at_hour: next.atHour,
          ended_at: null,
          proposal_post_id: null,
        });
        expect(rutina!.activated_at).not.toBeNull();
        // THE TWIN IS TOLD WHEN IT FIRST RUNS, in the rep's zone, from the clock's own arithmetic.
        expect(lastResults(day.model, 1)[0]).toBe(
          `Rutina ${rutina!.id} is active and on the rep's Rutinas page, where they can switch it off or discard it. It first runs at ${renderTurnInstant(next.at, ZONE)}, and on its cadence after that.`,
        );
        // THE TWO HALVES, JOINED BY THE PIN, and the line the turn answered recorded beside them.
        const content = day.twin.bundle.readAutomation(rutina!.id)!;
        expect(content.sentence).toBe(FRIDAY_SENTENCE);
        expect(content.evidenceRef).toBe(asked);
        const definition = JSON.parse(content.definition) as RunDefinition;
        expect(rutina!.definition_digest).toBe(runDigest(definition));
        // NO CARD: nothing waits on the rep.
        expect(await proposalCards(day.client, day.twin)).toEqual([]);

        // THE CLOCK: nothing before the instant, one run once it is reached — no Activar anywhere.
        const batch = openBatchWork();
        expect(await fireDueCadences(runs.deps, new Date(next.at.getTime() - 60_000), batch)).toBe(0);
        expect(await fireDueCadences(runs.deps, new Date(next.at.getTime() + 60_000), batch)).toBe(1);
        await batch.lane.settle();
        const fired = await day.client.query<{ created_by: string; woken_by: string; automation_id: string }>(
          "SELECT created_by, woken_by, automation_id FROM runs WHERE twin_id = $1",
          [day.twin.twinId],
        );
        expect(fired.rows).toEqual([
          { created_by: "clock", woken_by: `clock:${String(next.at.getTime())}`, automation_id: rutina!.id },
        ]);
      },
    );
  });

  it("a turn an event woke writes one on the twin's word, as it says — nothing tests who asked against the turn", async () => {
    await withDay(
      (prompt) => (isEventTurn(prompt, "run.failed") ? writesTheRutina() : SILENT),
      async (day) => {
        day.sessions.raise(day.twin.twinId, { kind: "run.failed", runId: randomUUID(), step: 0 });
        await processPendingWaEvents(day.deps());
        const [rutina] = await rutinasOf(day.client, day.twin);
        expect(rutina).toMatchObject({ origin: "rep", state: "active" });
        // THE TURN ANSWERED NO LINE: its own execution stands as what wrote it.
        expect(day.twin.bundle.readAutomation(rutina!.id)?.evidenceRef).toMatch(/^[0-9a-f-]{36}$/u);
      },
    );
  });

  it("a definition naming a tool no registry holds is refused with the reason as the tool's answer", async () => {
    const withAStrangeTool = {
      ...FRIDAY_LIST,
      steps: [{ ...FRIDAY_LIST.steps[0], tools: ["send_whatsapp"] }, FRIDAY_LIST.steps[1]],
    };
    await withDay(
      (prompt) => (isThreadTurn(prompt) ? writesTheRutina({ definition: withAStrangeTool }) : SILENT),
      async (day) => {
        await repWrites(day.client, day.twin, "cada viernes mándame la lista por WhatsApp");
        await processPendingWaEvents(day.deps());
        expect(lastResults(day.model, 1)[0]).toMatch(/^refused: .*send_whatsapp/u);
        expect(await rutinasOf(day.client, day.twin)).toEqual([]);
      },
    );
  });

  it("a set of weekdays is one rutina: «entre semana» is one row and one clock row on Monday to Friday (ticket #387)", async () => {
    const weekdays = { schedule: { every: "week", weekdays: ["friday", "monday", "tuesday", "wednesday", "thursday", "monday"], at_hour: 9 } };
    await withDay(
      (prompt) => (isThreadTurn(prompt) ? writesTheRutina({ wake: weekdays }) : SILENT),
      async (day) => {
        await repWrites(day.client, day.twin, "entre semana a las 9 mándame la lista de los clientes sin contacto");
        await processPendingWaEvents(day.deps());
        const rutinas = await rutinasOf(day.client, day.twin);
        expect(rutinas).toEqual([expect.objectContaining({ state: "active", every: "week", weekdays: [1, 2, 3, 4, 5], at_hour: 9 })]);
        const clock = await day.client.query<{ weekdays: number[] }>(
          "SELECT weekdays FROM schedules WHERE automation_id = $1 AND kind = 'cadence'",
          [rutinas[0]!.id],
        );
        expect(clock.rows).toEqual([{ weekdays: [1, 2, 3, 4, 5] }]);
      },
    );
  });

  it("an empty set of weekdays, or weekdays on a daily schedule, is refused with one sentence (ticket #387)", async () => {
    for (const [schedule, refusal] of [
      [{ every: "week", weekdays: [], at_hour: 9 }, "refused: a weekly schedule names one or more weekdays: monday, tuesday, wednesday, thursday, friday, saturday, sunday."],
      [{ every: "day", weekdays: ["monday"], at_hour: 9 }, "refused: weekdays are for a weekly schedule only."],
    ] as const) {
      await withDay(
        (prompt) => (isThreadTurn(prompt) ? writesTheRutina({ wake: { schedule } }) : SILENT),
        async (day) => {
          await repWrites(day.client, day.twin, "mándame la lista a las 9");
          await processPendingWaEvents(day.deps());
          expect(lastResults(day.model, 1)[0]).toBe(refusal);
          expect(await rutinasOf(day.client, day.twin)).toEqual([]);
        },
      );
    }
  });
});

describe("a rutina the twin proposes is a card where the rep is, accepted there (ticket #386)", () => {
  it("lands one proposal card at both doors with the sentence, when it runs and the plan code rendered; nothing fires before it is accepted", async () => {
    await withDay(
      (prompt) => (isThreadTurn(prompt) ? writesTheRutina({ asked_by: "twin" }) : SILENT),
      async (day) => {
        const runs = withRuns(day);
        await repWrites(day.client, day.twin, "ya te mandé la lista de los clientes otra vez");
        await processPendingWaEvents(runs.deps);

        const [rutina] = await rutinasOf(day.client, day.twin);
        const [card] = await proposalCards(day.client, day.twin);
        expect(rutina).toMatchObject({ origin: "twin", state: "pending", activated_at: null, proposal_post_id: card });
        expect(lastResults(day.model, 1)[0]).toBe(
          `Rutina ${rutina!.id} is your proposal, on card ${card} in front of the rep on their dashboard and in their thread. It runs only once they accept it: on the card, or by telling you — then answer the card with answer_proposal.`,
        );
        // BOTH DOORS: the self-chat's send, and the canvas's waiting cards.
        const sends = await day.client.query(
          "SELECT 1 FROM send_commands sc JOIN posts p ON sc.payload_ref = 'notice:' || p.notice_id WHERE p.id = $1 AND sc.send_class = 'system_send'",
          [card],
        );
        expect(sends.rowCount).toBe(1);
        expect(await waitingCandidates({ db: day.client, twinId: day.twin.twinId }, new Date())).toContain(card);
        const opened = (await readPostsByIds({ db: day.client, twinId: day.twin.twinId, dek: day.twin.dek }, [card!], new Date())).get(card!)!;
        expect(opened.parts).toEqual([
          {
            kind: "proposal",
            automationId: rutina!.id,
            name: FRIDAY_LIST.name,
            sentence: FRIDAY_SENTENCE,
            when: "Cada viernes a las 09:00",
            plan: [
              { text: "Pensar", depth: 0 },
              { text: "Avisar", depth: 0 },
            ],
            replaces: false,
            acts: ["activate", "discard"],
          },
        ]);
        // THE PHONE'S RENDERING: the sentence framed, when, and the plan — no instruction line.
        const notice = await day.client.query<{ content_enc: Buffer }>(
          "SELECT n.content_enc FROM notices n JOIN posts p ON p.notice_id = n.id WHERE p.id = $1",
          [card],
        );
        expect(Buffer.from(day.twin.dek.decrypt(notice.rows[0]!.content_enc)).toString("utf8")).toBe(
          `✳️ ${FRIDAY_SENTENCE}\nCada viernes a las 09:00\n\nCómo la hago\n· Pensar\n· Avisar`,
        );
        // NOTHING FIRES WHILE IT WAITS.
        const batch = openBatchWork();
        expect(await fireDueCadences(runs.deps, new Date("2026-10-16T15:05:00.000Z"), batch)).toBe(0);
        expect(await fireDueCadences(runs.deps, new Date(Date.now() + 14 * 86_400_000), batch)).toBe(0);
        await batch.lane.settle();
        expect(await runsOf(day.client, day.twin)).toEqual([]);
      },
    );
  });

  it("Activar on the card makes it active, settles the card `confirmed` as the rep's act, and the thread is told; a second press is `already`", async () => {
    await withDay(
      (prompt) => (isThreadTurn(prompt) ? (prompt.includes("otra vez") ? writesTheRutina({ asked_by: "twin" }) : SILENT) : SILENT),
      async (day) => {
        await repWrites(day.client, day.twin, "ya te mandé la lista de los clientes otra vez");
        await processPendingWaEvents(day.deps());
        const [card] = await proposalCards(day.client, day.twin);
        const [{ id }] = (await rutinasOf(day.client, day.twin)) as [RutinaSeen];
        const { events, heard } = heardOn(day.seat.seatId);

        expect(await actOnTheRutina(day, "activateAutomation", id, events)).toBe("performed");
        expect((await rutinasOf(day.client, day.twin))[0]).toMatchObject({ state: "active" });
        expect(heard).toEqual([{ kind: "settle", postId: card, outcome: "confirmed" }]);
        expect(await waitingCandidates({ db: day.client, twinId: day.twin.twinId }, new Date())).not.toContain(card);
        const opened = (await readPostsByIds({ db: day.client, twinId: day.twin.twinId, dek: day.twin.dek }, [card!], new Date())).get(card!)!;
        expect(opened.parts[0]).toMatchObject({ kind: "proposal", acts: [] });
        expect(await actOnTheRutina(day, "activateAutomation", id, events)).toBe("already");

        // THE SETTLE REACHES THE DAY'S SESSION, read at the twin's next turn.
        await repWrites(day.client, day.twin, "gracias");
        await processPendingWaEvents(day.deps());
        const told = promptsIn(day.model, await openSessionId(day.client, day.twin)).join("\n");
        expect(told).toContain(`post.settled {"post_id":"${card!}","outcome":"confirmed"}`);
      },
    );
  });

  it("Descartar on the card ends the rutina, settles the card `declined`, and deletes its content", async () => {
    await withDay(
      (prompt) => (isThreadTurn(prompt) ? writesTheRutina({ asked_by: "twin" }) : SILENT),
      async (day) => {
        await repWrites(day.client, day.twin, "ya te mandé la lista de los clientes otra vez");
        await processPendingWaEvents(day.deps());
        const [card] = await proposalCards(day.client, day.twin);
        const [{ id }] = (await rutinasOf(day.client, day.twin)) as [RutinaSeen];
        const { events, heard } = heardOn(day.seat.seatId);

        expect(await actOnTheRutina(day, "discardAutomation", id, events)).toBe("performed");
        expect((await rutinasOf(day.client, day.twin))[0]!.ended_at).not.toBeNull();
        expect(heard).toEqual([{ kind: "settle", postId: card, outcome: "declined" }]);
        expect(await waitingCandidates({ db: day.client, twinId: day.twin.twinId }, new Date())).not.toContain(card);
        expect(day.twin.bundle.readAutomation(id)).toBeUndefined();
      },
    );
  });

  it("the rep's yes in their own words: the thread answers the card with answer_proposal — the same act Activar is — and the card's button after it is `already`", async () => {
    let card = "";
    let yes = "";
    const script: Script = (prompt) => {
      if (!isThreadTurn(prompt)) return SILENT;
      if (prompt.includes("otra vez")) return writesTheRutina({ asked_by: "twin" });
      if (prompt.includes("sí, actívala")) {
        return threadTurns({
          tool: ANSWER_PROPOSAL_TOOL,
          evidence: yes,
          input: { post_id: card, answer: "activate" },
          answer: "Lista, corre desde el viernes.",
        });
      }
      return SILENT;
    };
    await withDay(script, async (day) => {
      await repWrites(day.client, day.twin, "ya te mandé la lista de los clientes otra vez");
      await processPendingWaEvents(day.deps());
      [card] = (await proposalCards(day.client, day.twin)) as [string];
      const [{ id }] = (await rutinasOf(day.client, day.twin)) as [RutinaSeen];

      const { events, heard } = heardOn(day.seat.seatId);
      yes = await repWrites(day.client, day.twin, "sí, actívala");
      await processPendingWaEvents(day.deps({ events }));
      expect((await rutinasOf(day.client, day.twin))[0]).toMatchObject({ state: "active" });
      // AN OPEN CANVAS HEARS THE CARD SETTLE once the turn commits (Codex r1).
      expect(heard).toContainEqual({ kind: "settle", postId: card, outcome: "confirmed" });
      expect(lastResults(day.model, 1)[0]).toMatch(
        new RegExp(`^Rutina ${id} is active, and the card ${card} is answered\\. It first runs at `, "u"),
      );
      expect(await waitingCandidates({ db: day.client, twinId: day.twin.twinId }, new Date())).not.toContain(card);
      // THE CARD'S OWN BUTTONS, PRESSED AFTER ON A PAGE LEFT OPEN: Activar is
      // `already`, and Descartar answers nothing — the rutina the rep accepted
      // keeps running (Codex r1).
      expect(await actOnTheRutina(day, "activateAutomation", id, undefined, card)).toBe("already");
      expect(await actOnTheRutina(day, "discardAutomation", id, undefined, card)).toBe("refused");
      expect((await rutinasOf(day.client, day.twin))[0]).toMatchObject({ state: "active", ended_at: null });
    });
  });

  it("the rep's no in their own words discards it the way Descartar does", async () => {
    let card = "";
    let no = "";
    const script: Script = (prompt) => {
      if (!isThreadTurn(prompt)) return SILENT;
      if (prompt.includes("otra vez")) return writesTheRutina({ asked_by: "twin" });
      if (prompt.includes("mejor no la hagas")) {
        return threadTurns({
          tool: ANSWER_PROPOSAL_TOOL,
          evidence: no,
          input: { post_id: card, answer: "discard" },
          answer: "Va, la quito.",
        });
      }
      return SILENT;
    };
    await withDay(script, async (day) => {
      await repWrites(day.client, day.twin, "ya te mandé la lista de los clientes otra vez");
      await processPendingWaEvents(day.deps());
      [card] = (await proposalCards(day.client, day.twin)) as [string];
      no = await repWrites(day.client, day.twin, "mejor no la hagas");
      await processPendingWaEvents(day.deps());
      expect((await rutinasOf(day.client, day.twin))[0]!.ended_at).not.toBeNull();
      expect(await waitingCandidates({ db: day.client, twinId: day.twin.twinId }, new Date())).not.toContain(card);
    });
  });
});

describe("the switch and Descartar on an active rutina reach the day's thread, and wake nothing (ticket #386)", () => {
  it("«En pausa», «Activa» and Descartar each append what the rep did to the rutina, read at the twin's next turn", async () => {
    await withDay(
      (prompt) => (isThreadTurn(prompt) && prompt.includes("cada viernes") ? writesTheRutina() : SILENT),
      async (day) => {
        await repWrites(day.client, day.twin, "cada viernes a las 9 mándame la lista");
        await processPendingWaEvents(day.deps());
        const [{ id }] = (await rutinasOf(day.client, day.twin)) as [RutinaSeen];
        const executions = (await executionsOf(day.client, day.twin)).length;

        expect(await actOnTheRutina(day, "pauseAutomation", id)).toBe("performed");
        expect(await actOnTheRutina(day, "resumeAutomation", id)).toBe("performed");
        expect(await actOnTheRutina(day, "discardAutomation", id)).toBe("performed");
        // APPENDED, NEVER WOKEN: the pass runs no turn for them.
        await processPendingWaEvents(day.deps());
        const records = await executionsOf(day.client, day.twin);
        expect(records.filter((row) => row.trigger_kind === "twin_thread_event")).toEqual([]);
        expect(records.filter((row) => row.trigger_kind !== "dashboard_act")).toHaveLength(executions);

        await repWrites(day.client, day.twin, "gracias");
        await processPendingWaEvents(day.deps());
        const told = promptsIn(day.model, await openSessionId(day.client, day.twin)).join("\n");
        expect(told).toContain(`rutina.paused {"rutina_id":"${id}"}`);
        expect(told).toContain(`rutina.resumed {"rutina_id":"${id}"}`);
        expect(told).toContain(`rutina.discarded {"rutina_id":"${id}"}`);
      },
    );
  });
});

describe("a change to an active rutina follows who asked (ticket #386)", () => {
  /** An active Friday rutina, as one the rep asked for earlier. */
  async function standing(day: { readonly client: pg.Client; readonly twin: Twin; readonly seat: DoorSeat }): Promise<string> {
    const id = randomUUID();
    await insertRutina(day.client, day.twin.bundle, {
      id,
      twinId: day.twin.twinId,
      seatId: day.seat.seatId,
      origin: "rep",
      wake: { kind: "schedule", every: "week", weekdays: [5], atHour: 9 },
      definition: FRIDAY_LIST as unknown as RunDefinition,
      sentence: FRIDAY_SENTENCE,
      executionId: randomUUID(),
      evidenceRef: randomUUID(),
      writtenAt: new Date(),
    });
    expect(await activateRutina(day.client, { twinId: day.twin.twinId, id })).toEqual({ retired: [] });
    return id;
  }

  it("asked by the rep, the new version is live at the ask and the old one ends in the same turn", async () => {
    let old = "";
    await withDay(
      (prompt) =>
        isThreadTurn(prompt) && prompt.includes("mejor a las 10")
          ? writesTheRutina({ replaces: old, wake: { schedule: { every: "week", weekdays: ["friday"], at_hour: 10 } } })
          : SILENT,
      async (day) => {
        old = await standing(day);
        await repWrites(day.client, day.twin, "mejor a las 10 lo de los viernes");
        await processPendingWaEvents(day.deps());
        const [before, after] = await rutinasOf(day.client, day.twin);
        expect(before).toMatchObject({ id: old });
        expect(before!.ended_at).not.toBeNull();
        expect(after).toMatchObject({ origin: "rep", state: "active", at_hour: 10, ended_at: null });
        const cadences = await day.client.query<{ automation_id: string; ended: boolean }>(
          "SELECT automation_id, ended_at IS NOT NULL AS ended FROM schedules WHERE automation_id = ANY($1::uuid[]) ORDER BY ended",
          [[old, after!.id]],
        );
        expect(cadences.rows).toEqual([
          { automation_id: after!.id, ended: false },
          { automation_id: old, ended: true },
        ]);
      },
    );
  });

  it("proposed by the twin, the old one keeps running until the rep accepts the new one's card", async () => {
    let old = "";
    await withDay(
      (prompt) =>
        isThreadTurn(prompt) && prompt.includes("los viernes")
          ? writesTheRutina({ asked_by: "twin", replaces: old, wake: { schedule: { every: "week", weekdays: ["friday"], at_hour: 10 } } })
          : SILENT,
      async (day) => {
        old = await standing(day);
        await repWrites(day.client, day.twin, "los viernes a las 9 casi nunca estoy");
        await processPendingWaEvents(day.deps());
        const [before, after] = await rutinasOf(day.client, day.twin);
        expect(before).toMatchObject({ id: old, state: "active", ended_at: null });
        expect(after).toMatchObject({ origin: "twin", state: "pending" });
        const [card] = await proposalCards(day.client, day.twin);
        const opened = (await readPostsByIds({ db: day.client, twinId: day.twin.twinId, dek: day.twin.dek }, [card!], new Date())).get(card!)!;
        expect(opened.parts[0]).toMatchObject({ kind: "proposal", replaces: true, when: "Cada viernes a las 10:00" });

        expect(await actOnTheRutina(day, "activateAutomation", after!.id)).toBe("performed");
        const [ended, live] = await rutinasOf(day.client, day.twin);
        expect(ended!.ended_at).not.toBeNull();
        expect(live).toMatchObject({ state: "active", ended_at: null });
      },
    );
  });
});

describe("a rutina listening for a customer fires from the consumer's pass, once per message (ticket #325)", () => {
  it("starts one run on the customer's message; a firing that failed holds the turn back and fires on the next pass, and never twice", async () => {
    const drafts: Script = (prompt) =>
      isThreadTurn(prompt) || isEventTurn(prompt, "post.landed")
        ? SILENT
        : [
            { toolCall: { name: "create_draft", input: { text: "claro, se las aparto" } } },
            { text: "done" },
          ];
    await withDay(drafts, async (day) => {
      const garza = day.twin.bundle.referenceForChat(CUSTOMER);
      const rutina = randomUUID();
      await insertRutina(day.client, day.twin.bundle, {
        id: rutina,
        twinId: day.twin.twinId,
        seatId: day.seat.seatId,
        origin: "rep",
        wake: { kind: "trigger", event: "customer_message", customer: garza },
        definition: FRIDAY_LIST as unknown as RunDefinition,
        sentence: "Cuando te escriba la Sra. Garza, te aviso.",
        executionId: randomUUID(),
        evidenceRef: randomUUID(),
        writtenAt: new Date(),
      });
      expect(await activateRutina(day.client, { twinId: day.twin.twinId, id: rutina })).toEqual({ retired: [] });
      const eventId = await insertWaEvent(day.client, day.twin.dek, {
        twinId: day.twin.twinId,
        companyId: day.seat.companyId,
        seatId: day.seat.seatId,
        chatJid: CUSTOMER,
        senderJid: CUSTOMER,
        fromMe: false,
        messageId: `3EB0-CUS-${randomUUID().slice(0, 8)}`,
        text: "¿me apartas 40 cajas para el jueves?",
        pushName: "Sra. Garza",
        occurredAt: new Date(),
      });
      const fired = async (): Promise<{ created_by: string; woken_by: string }[]> =>
        (
          await day.client.query<{ created_by: string; woken_by: string }>(
            "SELECT created_by, woken_by FROM runs WHERE twin_id = $1 AND automation_id = $2",
            [day.twin.twinId, rutina],
          )
        ).rows;
      const draftsWritten = async (): Promise<number> =>
        (await day.client.query("SELECT 1 FROM drafts WHERE twin_id = $1", [day.twin.twinId])).rows.length;

      // THE FIRING FAILS: the run's content cannot be written.
      const runs = join(day.model.harness.directory, "runs");
      mkdirSync(runs, { recursive: true });
      chmodSync(runs, 0o500);
      try {
        await expect(processPendingWaEvents(day.deps())).rejects.toThrow();
      } finally {
        chmodSync(runs, 0o700);
      }
      // ...SO THE CUSTOMER'S TURN WAITED: no run, no draft, the message pending.
      expect(await fired()).toEqual([]);
      expect(await draftsWritten()).toBe(0);
      const pending = await day.client.query("SELECT 1 FROM wa_event_processing WHERE event_id = $1", [eventId]);
      expect(pending.rows).toEqual([]);

      // THE NEXT PASS FIRES IT, ONCE, AND DRAFTS.
      await processPendingWaEvents(day.deps());
      expect(await fired()).toEqual([{ created_by: "trigger", woken_by: `event:customer_message:${eventId}` }]);
      expect(await draftsWritten()).toBe(1);
      await processPendingWaEvents(day.deps());
      expect(await fired()).toHaveLength(1);
    });
  });
});

describe("drafting «En pausa» on Rutinas (ticket #325)", () => {
  it("creates no execution for a customer's message while paused, records it as captured, and drafts only what arrives after it is turned back on", async () => {
    const drafts: Script = (prompt) =>
      isThreadTurn(prompt) || isEventTurn(prompt, "post.landed")
        ? SILENT
        : [
            { toolCall: { name: "create_draft", input: { text: "claro, se las aparto" } } },
            { text: "done" },
          ];
    await withDay(drafts, async (day) => {
      await ensureShippedAutomations(day.client, { twinId: day.twin.twinId, seatId: day.seat.seatId }, new Date());
      const drafting = await day.client.query<{ id: string }>(
        "SELECT id FROM automations WHERE twin_id = $1 AND shipped = 'drafting'",
        [day.twin.twinId],
      );
      const switched = (paused: boolean) =>
        setAutomationPaused(day.client, {
          twinId: day.twin.twinId,
          seatId: day.seat.seatId,
          automationId: drafting.rows[0]!.id,
          paused,
        });
      const customerWrites = (text: string) =>
        insertWaEvent(day.client, day.twin.dek, {
          twinId: day.twin.twinId,
          companyId: day.seat.companyId,
          seatId: day.seat.seatId,
          chatJid: CUSTOMER,
          senderJid: CUSTOMER,
          fromMe: false,
          messageId: `3EB0-CUS-${randomUUID().slice(0, 8)}`,
          text,
          pushName: "Sra. Garza",
          occurredAt: new Date(),
        });
      const draftings = async (): Promise<number> =>
        (
          await day.client.query("SELECT 1 FROM executions WHERE twin_id = $1 AND trigger_kind = 'chat_turn'", [
            day.twin.twinId,
          ])
        ).rows.length;
      const dispositionOf = async (eventId: string): Promise<string | undefined> =>
        (
          await day.client.query<{ disposition: string }>(
            "SELECT disposition FROM wa_event_processing WHERE event_id = $1",
            [eventId],
          )
        ).rows[0]?.disposition;

      expect(await switched(true)).toBe(true);
      const whilePaused = await customerWrites("¿me apartas 40 cajas para el jueves?");
      await processPendingWaEvents(day.deps());
      expect(await draftings()).toBe(0);
      expect(await dispositionOf(whilePaused)).toBe("captured");
      expect(day.twin.bundle.readConversation(CUSTOMER).map((row) => row.content)).toContain(
        "¿me apartas 40 cajas para el jueves?",
      );

      // BACK ON: the message of the pause stays answered by the rep, and the next is drafted.
      expect(await switched(false)).toBe(true);
      await processPendingWaEvents(day.deps());
      expect(await draftings()).toBe(0);
      const afterwards = await customerWrites("¿y para el viernes?");
      await processPendingWaEvents(day.deps());
      expect(await draftings()).toBe(1);
      expect(await dispositionOf(afterwards)).toMatch(/^drafted/u);
    });
  });
});

// ─── the question, the repeats and the children, end to end (ticket #324) ─

/** Three customers the rep confirmed, by their references. */
const STALE_CHATS = {
  laura: "5218112340001@s.whatsapp.net",
  torres: "5218112340002@s.whatsapp.net",
  sergio: "5218112340003@s.whatsapp.net",
} as const;

function confirmThree(twin: Twin): { readonly laura: string; readonly torres: string; readonly sergio: string } {
  const names = { laura: "Laura Garza", torres: "Torres Hermanos", sergio: "Sergio Ruiz" } as const;
  const refs: Record<string, string> = {};
  for (const [key, chatJid] of Object.entries(STALE_CHATS)) {
    twin.bundle.confirmChatBinding({
      chatJid,
      entityId: randomUUID(),
      displayName: names[key as keyof typeof names],
      confirmedAt: new Date().toISOString(),
    });
    refs[key] = `[c${String(twin.bundle.referenceForChat(chatJid))}]`;
  }
  return refs as { laura: string; torres: string; sergio: string };
}

/** Whether a prompt is the run step of that name: `[Run "…" · step N of M: <name>]`. */
function isStep(prompt: string, name: string): boolean {
  return isRunStep(prompt) && prompt.includes(`: ${name}]`);
}

/** A rep line answered by looking, then starting a run. */
function startsRun(input: Record<string, unknown>): ScriptedTurn[] {
  return threadTurns({
    calls: [
      { name: "search_memory", input: { about: "lo que me pidió", counterparty: null } },
      { name: "start_workflow", input },
    ],
    answer: "Va, me pongo con eso.",
  });
}

/** The ids of this twin's question cards, oldest first. */
async function askCards(client: pg.Client, twin: Twin): Promise<string[]> {
  const rows = await client.query<{ id: string }>(
    `SELECT p.id FROM posts p JOIN notices n ON n.id = p.notice_id
      WHERE p.twin_id = $1 AND n.kind = 'ask' ORDER BY p.posted_at, p.id`,
    [twin.twinId],
  );
  return rows.rows.map((row) => row.id);
}

/** «Responder» on the card: the dashboard act, through the one answer path. */
async function answerOnTheCard(
  day: { readonly client: pg.Client; readonly twin: Twin; readonly seat: DoorSeat; readonly model: ScriptedModel },
  postId: string,
  answers: Record<string, unknown>,
): Promise<string> {
  return await performDashboardAct(
    {
      db: day.client,
      dek: day.twin.dek,
      twinId: day.twin.twinId,
      hmacKey: TEST_AUDIT_HMAC_KEY,
      bundle: day.twin.bundle,
      selfChatJid: SELF_CHAT,
      harnessDirectory: day.model.harness.directory,
    },
    { companyId: day.seat.companyId, seatId: day.seat.seatId },
    { target: "post", route: "answerAsk", postId, answers },
  );
}

/** The run's typed outputs, opened out of its sealed content. */
async function outputsOf(
  day: { readonly client: pg.Client; readonly twin: Twin; readonly model: ScriptedModel },
  runId: string,
): Promise<Record<string, Record<string, unknown>>> {
  const row = await day.client.query<{ definition_digest: string }>("SELECT definition_digest FROM runs WHERE id = $1", [runId]);
  return readRunContent(day.model.harness.directory, day.twin.dek, runId, row.rows[0]!.definition_digest).outputs as never;
}

/** The dispositions the run's step left, by step: `step:N disposition`. */
async function stepDispositions(client: pg.Client, twin: Twin, runId: string): Promise<string[]> {
  const rows = await client.query<{ trigger_ref: string; disposition: string }>(
    `SELECT trigger_ref, disposition FROM executions
      WHERE twin_id = $1 AND trigger_kind = 'run_step' AND trigger_ref LIKE $2
      ORDER BY started_at, id`,
    [twin.twinId, `% run:${runId} %`],
  );
  return rows.rows.map((row) => `${row.trigger_ref.split(" ").at(-1)!} ${row.disposition}`);
}

/** A run that asks which customer to start with, and ends with the answer. */
function choosing(refs: { readonly laura: string; readonly torres: string }): Record<string, unknown> {
  return {
    name: "Con quién empiezo",
    budget: { iterations: 4, tokens: 100_000 },
    steps: [
      {
        kind: "ask",
        name: "choose",
        question: { value: `¿Con quién empiezo, ${refs.laura} o ${refs.torres}?` },
        fields: [{ name: "who", kind: "pick_one", options: { value: [refs.laura, refs.torres] } }],
      },
      { kind: "end", name: "done", value: "choose.who" },
    ],
  };
}

describe("a run asks the rep on a card and waits for the answer (ticket #324 AC 1)", () => {
  it("an ask step parks the run on its card at both doors; the dashboard's answer resumes it with the typed answer; a second answer is refused", async () => {
    let refs = { laura: "", torres: "", sergio: "" };
    const script: Script = (prompt) =>
      isThreadTurn(prompt) && prompt.includes("pregúntame con quién empiezo") ? startsRun({ definition: choosing(refs) }) : SILENT;
    await withDay(script, async (day) => {
      refs = confirmThree(day.twin);
      const runs = withRuns(day);
      await repWrites(day.client, day.twin, "pregúntame con quién empiezo");
      await processPendingWaEvents(runs.deps);
      await runs.tick(THURSDAY);

      const [run] = await runsOf(day.client, day.twin);
      expect(run).toMatchObject({ state: "waiting", current_step: 0 });
      const [card] = await askCards(day.client, day.twin);
      // BOTH DOORS: the self-chat's send, and the canvas's waiting cards.
      const sends = await day.client.query(
        "SELECT 1 FROM send_commands sc JOIN posts p ON sc.payload_ref = 'notice:' || p.notice_id WHERE p.id = $1 AND sc.send_class = 'system_send'",
        [card],
      );
      expect(sends.rowCount).toBe(1);
      expect(await waitingCandidates({ db: day.client, twinId: day.twin.twinId }, THURSDAY)).toContain(card);
      const opened = (await readPostsByIds({ db: day.client, twinId: day.twin.twinId, dek: day.twin.dek }, [card!], THURSDAY)).get(card!)!;
      expect(opened.parts).toEqual([
        expect.objectContaining({
          kind: "ask",
          acts: ["answer"],
          fields: [
            {
              name: "who",
              kind: "pick_one",
              options: [
                { value: refs.laura, label: "Laura Garza" },
                { value: refs.torres, label: "Torres Hermanos" },
              ],
            },
          ],
        }),
      ]);
      expect((await stepRowsOf(day.client, run!.id)).map((step) => [step.kind, step.state])).toEqual([["ask", "waiting"]]);

      // AN ANSWER THAT IS NONE OF THE CARD'S OPTIONS IS REFUSED, and nothing moves.
      expect(await answerOnTheCard(day, card!, { who: refs.sergio })).toBe("refused");
      expect(await answerOnTheCard(day, card!, { who: refs.torres })).toBe("performed");
      // ...AND A SECOND ANSWER, whatever it says, is refused: the card is answered.
      expect(await answerOnTheCard(day, card!, { who: refs.laura })).toBe("refused");
      expect(await waitingCandidates({ db: day.client, twinId: day.twin.twinId }, THURSDAY)).not.toContain(card);

      await runs.tick(THURSDAY);
      expect((await runsOf(day.client, day.twin))[0]).toMatchObject({ state: "succeeded" });
      expect((await outputsOf(day, run!.id))["choose"]).toEqual({ who: refs.torres });
      expect(await stepDispositions(day.client, day.twin, run!.id)).toEqual(["step:0 asked", "step:0 no-action", "step:1 posted"]);
      expect((await runPostsOf(day.client, day.twin, run!.id)).at(-1)).toContain("Torres Hermanos");
      // NOTHING OF THE ANSWER ON A ROW (FR-73).
      const rows = await day.client.query("SELECT r.*, s.* FROM runs r JOIN run_steps s ON s.run_id = r.id WHERE r.id = $1", [run!.id]);
      expect(JSON.stringify(rows.rows)).not.toContain(refs.torres);
    });
  });

  it("the thread answers a card from the rep's own words through answer_ask — the same path — and the run resumes", async () => {
    let refs = { laura: "", torres: "", sergio: "" };
    let card = "";
    let asked = "";
    const script: Script = (prompt) => {
      if (!isThreadTurn(prompt)) return SILENT;
      if (prompt.includes("pregúntame con quién empiezo")) return startsRun({ definition: choosing(refs) });
      if (prompt.includes("empieza con Torres")) {
        return threadTurns({
          calls: [{ name: "read_post", input: { post_id: card } }],
          tool: "answer_ask",
          evidence: asked,
          input: { post_id: card, answers: { who: refs.torres } },
          answer: "Va, empiezo con Torres.",
        });
      }
      return SILENT;
    };
    await withDay(script, async (day) => {
      refs = confirmThree(day.twin);
      const runs = withRuns(day);
      await repWrites(day.client, day.twin, "pregúntame con quién empiezo");
      await processPendingWaEvents(runs.deps);
      await runs.tick(THURSDAY);
      [card] = (await askCards(day.client, day.twin)) as [string];
      asked = await repWrites(day.client, day.twin, "empieza con Torres");
      await processPendingWaEvents(runs.deps);
      // THE TWIN READ THE CARD, THEN ANSWERED IT: the options it resolved against are the card's.
      const results = toolResultsOf(day.model.requests.at(-1));
      expect(results.some((result) => result.includes(`${refs.torres} (Torres Hermanos)`))).toBe(true);
      expect(results.some((result) => result.includes(`The answer is on card ${card}`))).toBe(true);
      expect(await answerOnTheCard(day, card, { who: refs.laura })).toBe("refused");

      await runs.tick(THURSDAY);
      const [run] = await runsOf(day.client, day.twin);
      expect(run).toMatchObject({ state: "succeeded" });
      expect((await outputsOf(day, run!.id))["choose"]).toEqual({ who: refs.torres });
    });
  });

  it("an agent step that calls the ask tool parks its run the same way, and is woken in the same conversation with the answer", async () => {
    let refs = { laura: "", torres: "", sergio: "" };
    const definition = (): Record<string, unknown> => ({
      name: "Decidir con quién",
      budget: { iterations: 8, tokens: 200_000 },
      steps: [
        {
          kind: "agent",
          name: "decide",
          instructions: "Ask the rep which of the two customers to start with, then say whom.",
          tools: ["ask"],
          output: { who: "string" },
        },
        { kind: "end", name: "done", value: "decide.who" },
      ],
    });
    const script: Script = (prompt) => {
      if (isThreadTurn(prompt)) return prompt.includes("decide tú pero pregúntame") ? startsRun({ definition: definition() }) : SILENT;
      if (!isStep(prompt, "decide")) return SILENT;
      return prompt.includes("## the rep's answer")
        ? [{ structured: { who: refs.torres } }]
        : [
            {
              toolCall: {
                name: "ask",
                input: {
                  question: `¿Con quién empiezo, ${refs.laura} o ${refs.torres}?`,
                  fields: [{ name: "who", kind: "pick_one", label: null, options: [refs.laura, refs.torres] }],
                },
              },
            },
          ];
    };
    await withDay(script, async (day) => {
      refs = confirmThree(day.twin);
      const runs = withRuns(day);
      await repWrites(day.client, day.twin, "decide tú pero pregúntame");
      await processPendingWaEvents(runs.deps);
      await runs.tick(THURSDAY);

      const [run] = await runsOf(day.client, day.twin);
      expect(run).toMatchObject({ state: "waiting", current_step: 0 });
      const [card] = await askCards(day.client, day.twin);
      const steps = await day.client.query<{ awaits_post_id: string | null; state: string }>(
        "SELECT awaits_post_id, state FROM run_steps WHERE run_id = $1",
        [run!.id],
      );
      expect(steps.rows).toEqual([{ awaits_post_id: card, state: "waiting" }]);
      // THE TOOL POSTED AND THE TURN SETTLED `asked`: the model never decided to pause.
      expect(await stepDispositions(day.client, day.twin, run!.id)).toEqual(["step:0 asked"]);

      expect(await answerOnTheCard(day, card!, { who: refs.torres })).toBe("performed");
      await runs.tick(THURSDAY);
      expect((await runsOf(day.client, day.twin))[0]).toMatchObject({ state: "succeeded" });
      // THE RESUMED TURN READS THE ANSWER FIRST, AND THE QUESTION IT ASKED ABOVE IT.
      const resumed = day.model.requests.find((request) => latestPromptOf(request).includes("## the rep's answer"))!;
      expect(latestPromptOf(resumed)).toContain(`{"who":"${refs.torres}"}`);
      expect(transcriptOf(resumed).some((entry) => "tool" in entry && entry.tool === "ask")).toBe(true);
      expect(await stepDispositions(day.client, day.twin, run!.id)).toEqual(["step:0 asked", "step:0 answered", "step:1 posted"]);
    });
  });
});

describe("an agent step calls a tool under that tool's own gate (ticket #324 AC 2)", () => {
  it("a run's step starts no other run: start_workflow refuses inside a run (Codex r2)", async () => {
    const script: Script = (prompt) => {
      if (isThreadTurn(prompt)) {
        return prompt.includes("y vuelve a empezar")
          ? startsRun({
              definition: {
                name: "Otra vez",
                budget: { iterations: 6, tokens: 100_000 },
                steps: [
                  { kind: "agent", name: "again", instructions: "Start this run again.", tools: ["start_workflow"], output: { line: "string" } },
                  { kind: "post", name: "report", text: "again.line" },
                ],
              },
            })
          : SILENT;
      }
      return isStep(prompt, "again")
        ? [
            { toolCall: { name: "start_workflow", input: { shipped: "standing_goal", name: "Otra vez" } } },
            { structured: { line: "Listo." } },
          ]
        : SILENT;
    };
    await withDay(script, async (day) => {
      const runs = withRuns(day);
      await repWrites(day.client, day.twin, "revisa y vuelve a empezar");
      await processPendingWaEvents(runs.deps);
      await runs.tick(THURSDAY);
      expect(await runsOf(day.client, day.twin)).toEqual([expect.objectContaining({ state: "succeeded" })]);
      const step = day.model.requests.findLast((request) => isStep(latestPromptOf(request), "again"))!;
      expect(toolResultsOf(step).some((result) => result.startsWith("refused: a step of a run starts no other run"))).toBe(true);
    });
  });

  it("a rep-evidenced tool is refused inside a run, whose turn carries no line of the rep's, and the step goes on", async () => {
    const script: Script = (prompt) => {
      if (isThreadTurn(prompt)) {
        return prompt.includes("y apúntalo en mi libreta")
          ? startsRun({
              definition: {
                name: "Anotar",
                budget: { iterations: 6, tokens: 100_000 },
                steps: [
                  { kind: "agent", name: "note", instructions: "Write the rep's notebook.", tools: ["write_notepad"], output: { line: "string" } },
                  { kind: "post", name: "report", text: "note.line" },
                ],
              },
            })
          : SILENT;
      }
      return isStep(prompt, "note")
        ? [
            { toolCall: { name: "write_notepad", input: { text: "Los martes no visito.", based_on: 0, evidence: "nada" } } },
            { structured: { line: "No pude anotarlo desde aquí." } },
          ]
        : SILENT;
    };
    await withDay(script, async (day) => {
      const runs = withRuns(day);
      await repWrites(day.client, day.twin, "revisa mis visitas y apúntalo en mi libreta");
      await processPendingWaEvents(runs.deps);
      await runs.tick(THURSDAY);
      expect((await runsOf(day.client, day.twin))[0]).toMatchObject({ state: "succeeded" });
      const step = day.model.requests.findLast((request) => isStep(latestPromptOf(request), "note"))!;
      expect(toolResultsOf(step).some((result) => result.startsWith("refused:") || result.startsWith("rejected:"))).toBe(true);
      expect(day.twin.bundle.readNotepad()).toBeUndefined();
    });
  });
});

describe("a child run's session is the SDK's fork of its parent's (ticket #324; ADR-0012)", () => {
  it("a child's first agent step reads its parent's earlier steps, and the parent's conversation is left as it was", async () => {
    let refs = { laura: "", torres: "", sergio: "" };
    const script: Script = (prompt) => {
      if (isThreadTurn(prompt)) {
        return prompt.includes("revisa a mis dos clientes")
          ? startsRun({
              definition: {
                name: "Uno por uno",
                budget: { iterations: 12, tokens: 300_000 },
                steps: [
                  { kind: "agent", name: "look", instructions: "Find the two customers.", tools: [], output: { customers: "list" } },
                  {
                    kind: "each",
                    name: "per",
                    over: "look.customers",
                    item: "customer",
                    body: [{ kind: "agent", name: "write", instructions: "Say one line about input.customer.", tools: [], output: { line: "string" } }],
                  },
                  { kind: "post", name: "report", text: "per.outputs" },
                ],
              },
            })
          : SILENT;
      }
      if (isStep(prompt, "look")) {
        return [{ structured: { customers: [refs.laura, refs.torres] } }];
      }
      if (isStep(prompt, "write")) {
        const customer = /"customer":"(\[c\d+\])"/u.exec(prompt)![1]!;
        return [{ structured: { line: `${customer} sigue al día.` } }];
      }
      return SILENT;
    };
    await withDay(script, async (day) => {
      refs = confirmThree(day.twin);
      const runs = withRuns(day);
      await repWrites(day.client, day.twin, "revisa a mis dos clientes");
      await processPendingWaEvents(runs.deps);
      await runs.tick(THURSDAY);
      const [parent] = await runsOf(day.client, day.twin);
      expect(parent).toMatchObject({ state: "waiting" });
      const parentFile = sessionFile(day.model.harness.directory, parent!.session_id);
      const parentBefore = readFileSync(parentFile, "utf8");

      await runs.tick(THURSDAY);
      await runs.tick(THURSDAY);
      expect((await runsOf(day.client, day.twin)).find((row) => row.id === parent!.id)).toMatchObject({ state: "succeeded" });
      // EACH CHILD'S FIRST STEP READ THE PARENT'S CONVERSATION: the find step's
      // own result is in its transcript, above its own prompt.
      const childSteps = day.model.requests.filter((request) => isStep(latestPromptOf(request), "write"));
      expect(childSteps.length).toBeGreaterThanOrEqual(2);
      for (const request of childSteps) {
        expect(
          transcriptOf(request).some(
            (entry) => "tool" in entry && entry.tool === "StructuredOutput" && JSON.stringify(entry.input).includes(refs.torres) && JSON.stringify(entry.input).includes(refs.laura),
          ),
        ).toBe(true);
      }
      // ...AND THE PARENT'S FILE IS AS IT WAS: the children wrote on under their own ids.
      expect(readFileSync(parentFile, "utf8")).toBe(parentBefore);
      const children = await day.client.query<{ session_id: string }>("SELECT session_id FROM runs WHERE parent_run_id = $1", [parent!.id]);
      for (const child of children.rows) {
        expect(child.session_id).not.toBe(parent!.session_id);
        expect(existsSync(sessionFile(day.model.harness.directory, child.session_id))).toBe(true);
      }
      expect((await runPostsOf(day.client, day.twin, parent!.id)).at(-1)).toContain("Laura Garza sigue al día.");
    });
  });
});

describe("a run never spotlights or knocks: no such tool reaches a step (ticket #324; decisions 21 and 25)", () => {
  it("refuses a definition whose agent step names the spotlight or the knock, and starts nothing", async () => {
    const script: Script = (prompt) =>
      isThreadTurn(prompt) && prompt.includes("y que me lo destaque")
        ? startsRun({
            definition: {
              name: "Destacar",
              budget: { iterations: 4, tokens: 100_000 },
              steps: [
                { kind: "agent", name: "loud", instructions: "Spotlight the card and knock.", tools: ["spotlight", "knock"], output: { line: "string" } },
                { kind: "post", name: "report", text: "loud.line" },
              ],
            },
          })
        : SILENT;
    await withDay(script, async (day) => {
      const runs = withRuns(day);
      await repWrites(day.client, day.twin, "revisa lo de hoy y que me lo destaque");
      await processPendingWaEvents(runs.deps);
      const [refused] = lastResults(day.model, 1);
      expect(refused).toMatch(/^refused: steps\[0\] \(loud\): `spotlight` is not a tool a step may call/u);
      expect(await runsOf(day.client, day.twin)).toEqual([]);
    });
  });
});

describe("the first two shipped runs, against the fake model (ticket #324 AC 4; spec #318 decision 27)", () => {
  it("«búscame los clientes que ya no me contestan»: finds them, asks on a card, drafts one per chosen customer, reports over the children", async () => {
    let refs = { laura: "", torres: "", sergio: "" };
    const script: Script = (prompt) => {
      if (isThreadTurn(prompt)) {
        return prompt.includes("búscame los clientes que ya no me contestan")
          ? startsRun({ shipped: "stale_relationships", name: "Clientes que ya no contestan" })
          : SILENT;
      }
      if (isStep(prompt, "find")) {
        return [
          {
            structured: {
              customers: [refs.laura, refs.torres, refs.sergio],
              reasons: ["no contesta desde el lunes", "dejó el pedido a medias", "no respondió la cotización"],
              question: `Encontré a ${refs.laura}, ${refs.torres} y ${refs.sergio} callados. ¿Te hago borrador para los 3 o solo algunos?`,
              summary: "Revisé tus pláticas de las últimas semanas.",
            },
          },
        ];
      }
      if (isStep(prompt, "follow_up")) {
        const customer = /"customer":"(\[c\d+\])"/u.exec(prompt)![1]!;
        return [
          { toolCall: { name: "create_draft", input: { entity: customer, text: "Hola, ¿cómo va todo? Quedo pendiente." } } },
          { structured: { line: `${customer}: le escribí para retomar la plática.` } },
        ];
      }
      return SILENT;
    };
    await withDay(script, async (day) => {
      refs = confirmThree(day.twin);
      const runs = withRuns(day);
      await repWrites(day.client, day.twin, "búscame los clientes que ya no me contestan");
      await processPendingWaEvents(runs.deps);
      await runs.tick(THURSDAY);

      const [run] = await runsOf(day.client, day.twin);
      expect(run).toMatchObject({ state: "waiting", current_step: 3 });
      const [card] = await askCards(day.client, day.twin);
      expect(await answerOnTheCard(day, card!, { customers: [refs.laura, refs.sergio] })).toBe("performed");

      // THE ANSWER RESUMES THE ASK; THE EACH MAKES ONE CHILD PER CHOSEN CUSTOMER AND PARKS.
      await runs.tick(THURSDAY);
      const children = await day.client.query<{ id: string; state: string }>(
        "SELECT id, state FROM runs WHERE parent_run_id = $1 ORDER BY created_at, id",
        [run!.id],
      );
      expect(children.rows).toHaveLength(2);
      // THE CHILDREN RUN, each drafting behind the tap; then the parent reports over them.
      await runs.tick(THURSDAY);
      await runs.tick(THURSDAY);
      expect((await runsOf(day.client, day.twin)).find((row) => row.id === run!.id)).toMatchObject({ state: "succeeded" });
      const drafts = await day.client.query<{ destination: string }>(
        "SELECT destination FROM drafts WHERE twin_id = $1 ORDER BY destination",
        [day.twin.twinId],
      );
      expect(drafts.rows.map((row) => row.destination)).toEqual([STALE_CHATS.laura, STALE_CHATS.sergio]);
      // NOTHING SENT: no customer send waits on a tap the rep never gave.
      const sends = await day.client.query("SELECT 1 FROM send_commands WHERE twin_id = $1 AND send_class = 'customer_send'", [day.twin.twinId]);
      expect(sends.rowCount).toBe(0);
      const report = (await runPostsOf(day.client, day.twin, run!.id)).at(-1)!;
      expect(report).toContain("Laura Garza: le escribí para retomar la plática.");
      expect(report).toContain("Sergio Ruiz: le escribí para retomar la plática.");
      expect(report).not.toContain("Torres Hermanos");
    });
  });

  it("«sigue a Sergio hasta que conteste, máximo tres intentos»: drafts, waits, drafts again, and reports after his reply on the second attempt", async () => {
    let refs = { laura: "", torres: "", sergio: "" };
    const script: Script = (prompt) => {
      if (isThreadTurn(prompt)) {
        return prompt.includes("sigue a Sergio hasta que conteste")
          ? startsRun({
              shipped: "standing_goal",
              name: `Seguir a ${refs.sergio}`,
              inputs: { customer: refs.sergio, attempts: 3, days: 3 },
            })
          : SILENT;
      }
      if (isStep(prompt, "nudge")) {
        return [
          { toolCall: { name: "create_draft", input: { entity: refs.sergio, text: "Hola Sergio, ¿pudiste ver la cotización?" } } },
          { structured: { line: "Le dejé otro mensaje a Sergio." } },
        ];
      }
      if (isStep(prompt, "summary")) {
        return [{ structured: { line: `${refs.sergio} contestó al segundo intento.` } }];
      }
      return SILENT;
    };
    await withDay(script, async (day) => {
      refs = confirmThree(day.twin);
      const runs = withRuns(day);
      await repWrites(day.client, day.twin, "sigue a Sergio hasta que conteste, máximo tres intentos");
      await processPendingWaEvents(runs.deps);
      await runs.tick(THURSDAY);
      const [run] = await runsOf(day.client, day.twin);
      expect(run).toMatchObject({ state: "waiting", current_step: 2 });

      // NO REPLY BY THE DEADLINE: the wait says so, and the second attempt drafts and waits again.
      const fourDays = new Date(THURSDAY.getTime() + 4 * 24 * 60 * 60 * 1000);
      await runs.tick(fourDays);
      expect((await runsOf(day.client, day.twin))[0]).toMatchObject({ state: "waiting", current_step: 2 });
      expect((await outputsOf(day, run!.id))["follow"]).toEqual({ iteration: 2 });

      // HE REPLIES: the wait is due on his message, and the run reports.
      day.twin.bundle.ingestMessage({
        chatJid: STALE_CHATS.sergio,
        messageId: "SERGIO-REPLY",
        senderJid: STALE_CHATS.sergio,
        fromMe: false,
        occurredAt: new Date(Date.now() + 1000).toISOString(),
        content: "Sí, ya la vi, va.",
      });
      await runs.tick(new Date(fourDays.getTime() + 60 * 60 * 1000));
      expect((await runsOf(day.client, day.twin))[0]).toMatchObject({ state: "succeeded" });
      const outputs = await outputsOf(day, run!.id);
      expect(outputs["follow"]).toEqual({ iteration: 2, exited: "condition" });
      expect(outputs["answer"]).toEqual({ replied: true, message_id: "SERGIO-REPLY" });
      const drafts = await day.client.query("SELECT destination FROM drafts WHERE twin_id = $1", [day.twin.twinId]);
      expect(drafts.rows).toEqual([{ destination: STALE_CHATS.sergio }, { destination: STALE_CHATS.sergio }]);
      expect((await runPostsOf(day.client, day.twin, run!.id)).at(-1)).toContain("Sergio Ruiz contestó al segundo intento.");
      // NO DRAFT CARD NAMES ITS RUN OR ITS PASS, and neither does the report
      // (ticket #399): a card says where it came from in the twin's words.
      const cards = await draftCardsOf(day.client, day.twin);
      expect(cards).toHaveLength(2);
      for (const card of cards) {
        expect(card.parts.map((part) => part.kind)).not.toContain("run");
        expect(card.text).not.toContain("Seguir a");
        expect(card.text).not.toContain("Vuelta");
      }
      expect((await runPostsOf(day.client, day.twin, run!.id)).at(-1)).not.toContain("Seguir a");
      // ONE RECORD PER STEP IT RAN, the repeat's included — each draft step
      // `drafted`, the act word of the effect it performed (ticket #357).
      expect(await stepDispositions(day.client, day.twin, run!.id)).toEqual([
        "step:0 no-action",
        "step:1 drafted",
        "step:2 no-action",
        "step:0 no-action",
        "step:1 drafted",
        "step:2 no-action",
        "step:0 no-action",
        "step:3 answered",
        "step:4 posted",
      ]);
    });
  });
});
import { readRunContent } from "./runs/content.js";
import { performDashboardAct } from "./dashboard-acts.js";

/** The parts of the posts a run wrote, oldest first (ticket #326). */
async function runPostPartsOf(client: pg.Client, twin: Twin, runId: string): Promise<(readonly PostPart[])[]> {
  const res = await client.query<{ parts_enc: Buffer }>(
    `SELECT p.parts_enc FROM posts p
       JOIN executions e ON e.id = p.execution_id
      WHERE p.twin_id = $1 AND e.trigger_kind = 'run_step' AND e.trigger_ref LIKE $2
      ORDER BY p.posted_at, p.id`,
    [twin.twinId, `% run:${runId} %`],
  );
  return res.rows.map((row) => openSealedParts(twin.dek, row.parts_enc));
}

/** The requests a run's step made, by the step's name. */
function stepRequests(model: ScriptedModel, name: string): Record<string, unknown>[] {
  return model.requests.filter((request) => isStep(latestPromptOf(request), name));
}

describe("the last two shipped runs, against the fake model (ticket #326 AC 3)", () => {
  const HOTELS = "# Hoteles en Madrid\n\n1. Hotel Prado, junto al museo, desde 120 euros la noche ([Hotel Prado](https://example.com/prado)).\n";
  const HITS = [{ title: "Hotel Prado", url: "https://example.com/prado", text: "Habitaciones desde 120 euros la noche." }];

  function researching(found: boolean): Script {
    return (prompt) => {
      if (isThreadTurn(prompt)) {
        return prompt.includes("búscame hoteles en Madrid")
          ? startsRun({ shipped: "research_and_document", name: "Hoteles en Madrid", inputs: { topic: "hoteles en Madrid para la semana que viene" } })
          : SILENT;
      }
      if (isStep(prompt, "gather")) {
        return [
          { toolCall: { name: "WebSearch", input: { query: "hoteles en Madrid semana que viene" } } },
          {
            structured: found
              ? { found: true, sources: ["Hotel Prado — https://example.com/prado"], notes: "Hotel Prado, junto al museo, desde 120 euros." }
              : { found: false, sources: [], notes: "Busqué hoteles en Madrid para la semana que viene y no encontré fuentes que valgan un documento." },
          },
        ];
      }
      if (isStep(prompt, "write")) {
        return [
          { toolCall: { name: "Write", input: { file_path: join(WORKSPACE.current, "hoteles-madrid.md"), content: HOTELS } } },
          { structured: { path: "hoteles-madrid.md", line: "Te armé el documento con los hoteles que encontré." } },
        ];
      }
      return SILENT;
    };
  }

  /** Where the scripted write lands: the day's workspace, known once its harness is. */
  const WORKSPACE = { current: "" };

  it("«búscame hoteles en Madrid… y ármame un documento»: searches the web, writes the document, and reports with it at its version", async () => {
    await withDay(
      researching(true),
      async (day) => {
        WORKSPACE.current = workspaceOf(day.model.harness);
        const runs = withRuns(day);
        await repWrites(day.client, day.twin, "búscame hoteles en Madrid para la semana que viene y ármame un documento");
        await processPendingWaEvents(runs.deps);
        await runs.tick(THURSDAY);

        const [run] = await runsOf(day.client, day.twin);
        expect(run).toMatchObject({ state: "succeeded" });
        // ONE WEB SEARCH, ANSWERED BY THE SCRIPT: nothing reached the web.
        expect(day.model.searches).toEqual(["hoteles en Madrid semana que viene"]);
        // THE GATHER STEP WAS SERVED THE SEARCH, THE WRITE STEP THE FILE TOOLS — AND NEITHER BASH.
        for (const request of stepRequests(day.model, "gather")) {
          expect(toolNamesOf(request)).toEqual(expect.arrayContaining(["WebSearch", "search_memory", "search_messages", "StructuredOutput"]));
          expect(toolNamesOf(request)).not.toContain("Write");
          expect(toolNamesOf(request)).not.toContain("Bash");
        }
        for (const request of stepRequests(day.model, "write")) {
          expect(toolNamesOf(request)).toEqual(expect.arrayContaining(["Read", "Write", "Edit", "StructuredOutput"]));
          expect(toolNamesOf(request)).not.toContain("WebSearch");
          expect(toolNamesOf(request)).not.toContain("Bash");
        }
        const version = day.twin.bundle.latestVersionOf("hoteles-madrid.md")!;
        expect(version).toMatchObject({ version: 1, title: "Hoteles en Madrid", content: HOTELS, runId: run!.id });
        const [report] = await runPostPartsOf(day.client, day.twin, run!.id);
        expect(report).toEqual([
          { kind: "prose", text: "Te armé el documento con los hoteles que encontré." },
          { kind: "document", versionId: version.id, title: "Hoteles en Madrid", version: 1 },
        ]);
        expect(await stepDispositions(day.client, day.twin, run!.id)).toEqual([
          "step:0 answered",
          "step:1 no-action",
          "step:2 acted",
          "step:3 posted",
        ]);
        // NO TOOL LIST RECORDED BASH OR WEBFETCH, the thread's turn included.
        const tools = await day.client.query<{ tool_names: string[] }>("SELECT tool_names FROM executions WHERE twin_id = $1", [day.twin.twinId]);
        expect(tools.rows.flatMap((row) => row.tool_names)).not.toContain("Bash");
        expect(tools.rows.flatMap((row) => row.tool_names)).not.toContain("WebFetch");
      },
      { webSearch: HITS },
    );
  });

  it("ends on the twin's own line with no document when it says it found no sources", async () => {
    await withDay(
      researching(false),
      async (day) => {
        WORKSPACE.current = workspaceOf(day.model.harness);
        const runs = withRuns(day);
        await repWrites(day.client, day.twin, "búscame hoteles en Madrid para la semana que viene y ármame un documento");
        await processPendingWaEvents(runs.deps);
        await runs.tick(THURSDAY);

        const [run] = await runsOf(day.client, day.twin);
        expect(run).toMatchObject({ state: "succeeded" });
        expect(stepRequests(day.model, "write")).toEqual([]);
        expect(day.twin.bundle.latestVersionOf("hoteles-madrid.md")).toBeUndefined();
        const [report] = await runPostPartsOf(day.client, day.twin, run!.id);
        expect(report).toEqual([
          { kind: "prose", text: "Busqué hoteles en Madrid para la semana que viene y no encontré fuentes que valgan un documento." },
        ]);
      },
      { webSearch: [] },
    );
  });

  it("«ármame un documento con lo que te acabo de decir», in the turn: the thread writes it, and its answer hands the rep the document as a card", async () => {
    const NOTES = "# Lo de Torres\n\n- 40 cajas para el jueves\n";
    const script: Script = (prompt) =>
      isThreadTurn(prompt) && prompt.includes("ármame un documento con lo que te acabo de decir")
        ? threadTurns({
            // THE REPLY RESTS ON WHAT THE TURN READ (the thread's guard), then the write.
            calls: [
              { name: "search_messages", input: { about: "lo de Torres", since: null, until: null } },
              { name: "Write", input: { file_path: join(WORKSPACE.current, "torres.md"), content: NOTES } },
            ],
            answer: "Listo, te lo dejé en un documento.",
          })
        : SILENT;
    await withDay(script, async (day) => {
      WORKSPACE.current = workspaceOf(day.model.harness);
      await typeAtTheDoor(day.client, day.twin, day.seat, "ármame un documento con lo que te acabo de decir");
      await processPendingWaEvents(day.deps());

      const version = day.twin.bundle.latestVersionOf("torres.md")!;
      expect(version).toMatchObject({ version: 1, title: "Lo de Torres", content: NOTES });
      expect(version).not.toHaveProperty("runId");
      const posts = await day.client.query<{ id: string; parts_enc: Buffer }>(
        "SELECT id, parts_enc FROM posts WHERE twin_id = $1 AND asked_on = 'dashboard' AND parts_enc IS NOT NULL",
        [day.twin.twinId],
      );
      const answer = posts.rows.map((row) => ({ id: row.id, parts: openSealedParts(day.twin.dek, row.parts_enc) })).at(-1)!;
      expect(answer.parts).toEqual([
        { kind: "prose", text: "Listo, te lo dejé en un documento." },
        { kind: "document", versionId: version.id, title: "Lo de Torres", version: 1 },
      ]);
      // THE CARD IS ON THE CANVAS FOR ITS DAY.
      expect(await waitingCandidates({ db: day.client, twinId: day.twin.twinId }, new Date())).toContain(answer.id);
      const executions = await executionsOf(day.client, day.twin);
      expect(executions.at(-1)!.disposition).toBe("acted");
    });
  });

  it("«¿qué me pidieron anoche?»: posts the briefing with its list, and one child per request writes its draft behind the tap", async () => {
    let refs = { laura: "", torres: "", sergio: "" };
    const script: Script = (prompt) => {
      if (isThreadTurn(prompt)) {
        return prompt.includes("qué me pidieron anoche")
          ? startsRun({ shipped: "overnight_requests", name: "Lo que te pidieron anoche" })
          : SILENT;
      }
      if (isStep(prompt, "read_night")) {
        return [
          {
            structured: {
              requests: [`${refs.laura} pide la lista de precios`, `${refs.torres} pregunta por la entrega del jueves`],
              summary: "Anoche te pidieron dos cosas; ya te dejo los borradores.",
            },
          },
        ];
      }
      if (isStep(prompt, "reply")) {
        const customer = /"request":"(\[c\d+\])/u.exec(prompt)![1]!;
        return [
          { toolCall: { name: "create_draft", input: { entity: customer, text: "Claro, te lo mando en un rato." } } },
          { structured: { line: `${customer}: le contesté lo que pidió.` } },
        ];
      }
      return SILENT;
    };
    await withDay(script, async (day) => {
      refs = confirmThree(day.twin);
      const runs = withRuns(day);
      await repWrites(day.client, day.twin, "¿qué me pidieron anoche?");
      await processPendingWaEvents(runs.deps);
      await runs.tick(THURSDAY);
      await runs.tick(THURSDAY);
      await runs.tick(THURSDAY);

      const run = (await runsOf(day.client, day.twin))[0]!;
      expect(run).toMatchObject({ state: "succeeded" });
      const [briefing, ...rest] = await runPostPartsOf(day.client, day.twin, run.id);
      expect(rest).toEqual([]);
      expect(briefing![0]).toEqual({ kind: "prose", text: "Anoche te pidieron dos cosas; ya te dejo los borradores." });
      expect(briefing![1]).toMatchObject({
        kind: "data",
        shape: "list",
        rows: [
          { text: `${refs.laura} pide la lista de precios`, mentions: [expect.objectContaining({ name: "Laura Garza" })] },
          { text: `${refs.torres} pregunta por la entrega del jueves`, mentions: [expect.objectContaining({ name: "Torres Hermanos" })] },
        ],
      });
      // THE PHONE READS THE LIST BY NAME.
      const sent = (await runPostsOf(day.client, day.twin, run.id))[0]!;
      expect(sent).toContain("1. Laura Garza pide la lista de precios");
      expect(sent).toContain("2. Torres Hermanos pregunta por la entrega del jueves");
      // ONE DRAFT PER REQUEST, EACH WRITTEN BY ITS CHILD'S OWN AGENT STEP.
      const drafts = await day.client.query<{ destination: string }>(
        "SELECT destination FROM drafts WHERE twin_id = $1 ORDER BY destination",
        [day.twin.twinId],
      );
      expect(drafts.rows.map((row) => row.destination)).toEqual([STALE_CHATS.laura, STALE_CHATS.torres]);
      const children = await day.client.query<{ id: string }>("SELECT id FROM runs WHERE parent_run_id = $1", [run.id]);
      for (const child of children.rows) {
        expect(await stepDispositions(day.client, day.twin, child.id)).toEqual(["step:0 drafted"]);
      }
      const sends = await day.client.query("SELECT 1 FROM send_commands WHERE twin_id = $1 AND send_class = 'customer_send'", [day.twin.twinId]);
      expect(sends.rowCount).toBe(0);
    });
  });
});

/**
 * A DEFINITION ON THE DAY'S CONVERSATION (ticket #357): Dito ships it as one
 * `agent` step, the no-row path runs it on the day's session the thread's
 * lease hands in — never one of its own — and the thread's next turn reads
 * what it brought, natively, in the same conversation.
 */
describe("a definition on the day's conversation runs on the day's session handed in (ticket #357)", () => {
  const DAY_LOOK = {
    name: "Un vistazo al día",
    budget: { iterations: 6, tokens: 100_000 },
    session: "day",
    steps: [{ kind: "agent", name: "look", instructions: "Look over the day and say in one line what stands out.", recipes: ["notepad"] }],
  };
  const SEEN = "Lo que destaca hoy: Garza pidió 40 cajas.";

  it("appends its turn to the day's thread_sessions session, and the thread's next turn sees it in its prompt", async () => {
    const script: Script = (prompt) =>
      prompt.includes("[Un vistazo al día · look]")
        ? [
            { toolCall: { name: "search_memory", input: { about: "hoy", counterparty: null } } },
            { text: SEEN },
          ]
        : replyTurns("Sí, lo de Garza sigue en pie.");
    await withDay(script, async (day) => {
      const parsed = parseRunDefinition(DAY_LOOK, shippedRunCatalog());
      if (!parsed.ok) throw new Error(parsed.reason);
      const lease = await day.sessions.enter(
        {
          twinId: day.twin.twinId,
          harness: day.model.harness,
          bundle: day.twin.bundle,
          dek: day.twin.dek,
          pool: executionPool,
          selfChatJid: SELF_CHAT,
          timeZone: ZONE,
          model: "claude-sonnet-5",
        },
        new Date(),
      );
      const trigger = { kind: "twin_thread_event", mechanism: "seam_event", twinId: day.twin.twinId, event: "post.landed" } as const;
      const deps = day.deps();
      const executionId = randomUUID();
      await day.client.query("BEGIN");
      const ran = await executeStep(
        { harness: deps.harness, db: day.client, twinId: day.twin.twinId, hmacKey: deps.hmacKey },
        {
          definition: parsed.definition,
          conversation: {
            kind: "thread",
            deps: threadDeps({
              db: day.client,
              dek: day.twin.dek,
              twinId: day.twin.twinId,
              executionId,
              hmacKey: deps.hmacKey,
              trigger,
              bundle: day.twin.bundle,
              embedder: deps.embedder,
              selfChatJid: SELF_CHAT,
              seatId: day.seat.seatId,
              timeZone: ZONE,
            }),
          },
          inputs: {},
          trigger,
          wake: THREAD_EVENT_WAKE,
          lane: "realtime",
          executionId,
          now: new Date(),
          model: "claude-sonnet-5",
          day: { session: lease.session, tag: { trigger } },
        },
      );
      await day.client.query("COMMIT");
      if (ran.kind !== "ran") throw new Error("the step's turn folded into another");
      const { settlement } = ran;
      expect(settlement.disposition).toBe("answered");
      expect(settlement.words).toBe(SEEN);
      // THE STEP'S TURN HOLDS THE DAY'S TOOLS (ticket #363) and ends on its
      // words.
      expect(settlement.record.toolNames).not.toContain("submit_answer");

      // THE STEP WROTE INTO THE DAY'S SESSION, the one its row names — it opened none.
      const id = await openSessionId(day.client, day.twin);
      expect(lease.session.sessionId).toBe(id);
      expect(promptsIn(day.model, id).some((prompt) => prompt.includes("Look over the day and say in one line what stands out."))).toBe(true);

      // THE THREAD'S NEXT TURN READS IT: the step's line and its words are in its request.
      await repWrites(day.client, day.twin, "¿y lo de Garza?");
      await processPendingWaEvents(day.deps());
      const next = day.model.requests.findLast((request) => latestPromptOf(request).includes("¿y lo de Garza?"))!;
      const transcript = transcriptOf(next);
      expect(transcript.some((entry) => "text" in entry && entry.role === "user" && entry.text.includes("[Un vistazo al día · look]"))).toBe(true);
      expect(transcript.some((entry) => "text" in entry && entry.role === "assistant" && entry.text === SEEN)).toBe(true);
      expect(await openSessionId(day.client, day.twin)).toBe(id);

      // ONE RECORD FOR THE STEP, under the caller's occasion; no run row.
      expect((await executionsOf(day.client, day.twin)).filter((row) => row.trigger_kind === "twin_thread_event")).toHaveLength(1);
      expect(await runsOf(day.client, day.twin)).toEqual([]);
    });
  });

  it("refuses a definition naming the day's conversation from start_workflow, and starts nothing", async () => {
    const script: Script = (prompt) =>
      isThreadTurn(prompt) && prompt.includes("quiero platicar contigo todo el día")
        ? startsRun({ definition: { ...DAY_LOOK, steps: [...DAY_LOOK.steps, { kind: "end", name: "done" }] } })
        : SILENT;
    await withDay(script, async (day) => {
      const runs = withRuns(day);
      await repWrites(day.client, day.twin, "quiero platicar contigo todo el día");
      await processPendingWaEvents(runs.deps);
      const [refused] = lastResults(day.model, 1);
      expect(refused).toContain("only a run Dito ships joins it");
      expect(await runsOf(day.client, day.twin)).toEqual([]);
    });
  });
});

/**
 * HOW A CARD LEAVES THE CANVAS (ticket #368; ruled 2026-10-08). The twin's
 * curation takes any card off Inicio for the rep — it still waits — and
 * «Listo» is the rep's own act on a card that has no act of its own: recorded
 * like every dashboard act, heard by the thread as the rep's settle. A report
 * neither touched leaves after its twenty-four hours, as before.
 */
describe("a card leaves the canvas by the twin's curation, by «Listo», or by its day (ticket #368)", () => {
  /** A report handing the rep a document, as a run's answer posts it. */
  async function plantReport(day: { readonly client: pg.Client; readonly twin: Twin }): Promise<string> {
    const executionId = await someExecutionOf(day.client, day.twin);
    await insertNoticeWithSystemSend(day.client, {
      twinId: day.twin.twinId,
      selfChatJid: SELF_CHAT,
      dek: day.twin.dek,
      kind: "answer",
      executionId,
      post: composeAnswerPost({
        answer: "Te dejé los hoteles de Madrid.",
        mentions: [],
        documents: [documentPart({ id: randomUUID(), title: "Hoteles en Madrid", version: 1 })],
      }),
    });
    const row = await day.client.query<{ id: string }>(
      "SELECT id FROM posts WHERE twin_id = $1 AND execution_id = $2 ORDER BY posted_at DESC LIMIT 1",
      [day.twin.twinId, executionId],
    );
    return row.rows[0]!.id;
  }

  /** The local API the dashboard acts through, with the day's thread behind it. */
  async function clearAt(
    day: { readonly twin: Twin; readonly seat: DoorSeat; readonly sessions: ThreadSessions },
    postIds: readonly string[],
  ): Promise<readonly unknown[]> {
    const api = await startLocalApi(
      {
        db: pool,
        twinId: day.twin.twinId,
        dek: day.twin.dek,
        bearer: BEARER,
        timeZone: ZONE,
        acts: { hmacKey: TEST_AUDIT_HMAC_KEY, bundle: day.twin.bundle, selfChatJid: SELF_CHAT },
        thread: day.sessions,
      },
      { port: 0 },
    );
    try {
      const answers: unknown[] = [];
      for (const postId of postIds) {
        const res = await fetch(`http://127.0.0.1:${String(api.port)}${TWIN_API_ACT_ROUTES.clearCard}`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${BEARER}`,
            [TWIN_API_SEAT_HEADER]: day.seat.seatId,
            "content-type": "application/json",
          },
          body: JSON.stringify({ postId }),
        });
        answers.push(await res.json());
      }
      return answers;
    } finally {
      await api.close();
    }
  }

  it("«Listo» takes a report off the canvas, recorded as the rep's act, and the thread hears it settle as `cleared`", async () => {
    await withDay(() => SILENT, async (day) => {
      await plantDraft(day);
      const report = await plantReport(day);
      expect(await waitingCandidates({ db: day.client, twinId: day.twin.twinId }, new Date())).toContain(report);
      // THE CARD OFFERS «LISTO» while it is on the canvas.
      const before = (await readPostsByIds({ db: day.client, twinId: day.twin.twinId, dek: day.twin.dek }, [report], new Date())).get(report)!;
      expect(before.parts.find((part) => part.kind === "document")?.acts).toEqual(["clear"]);

      expect(await clearAt(day, [report, report])).toEqual([{ outcome: "performed" }, { outcome: "already" }]);
      await processPendingWaEvents(day.deps());

      expect(await waitingCandidates({ db: day.client, twinId: day.twin.twinId }, new Date())).not.toContain(report);
      const after = (await readPostsByIds({ db: day.client, twinId: day.twin.twinId, dek: day.twin.dek }, [report], new Date())).get(report)!;
      expect(after.parts.find((part) => part.kind === "document")?.acts).toEqual([]);
      const acts = await day.client.query<{ verb: string; outcome: string; post_id: string }>(
        "SELECT verb, outcome, post_id FROM dashboard_acts WHERE twin_id = $1 ORDER BY acted_at, id",
        [day.twin.twinId],
      );
      expect(acts.rows).toEqual([
        { verb: "clear_card", outcome: "performed", post_id: report },
        { verb: "clear_card", outcome: "already", post_id: report },
      ]);
      const executions = await executionsOf(day.client, day.twin);
      expect(
        executions.filter((row) => row.trigger_kind === "dashboard_act").map((row) => row.disposition),
      ).toEqual(["acted", "no-action"]);
      const said = promptsIn(day.model, await openSessionId(day.client, day.twin)).join("\n");
      expect(said).toContain(`post.settled {"post_id":"${report}","outcome":"cleared"}`);
    });
  });

  it("refuses «Listo» on a card with acts of its own: a draft keeps Enviar and Descartar, and still waits", async () => {
    await withDay(() => SILENT, async (day) => {
      const draft = await plantDraft(day);
      const posted = (await readPostsByIds({ db: day.client, twinId: day.twin.twinId, dek: day.twin.dek }, [draft], new Date())).get(draft)!;
      expect(posted.parts.flatMap((part) => part.acts)).toEqual(["tap", "dismiss"]);
      expect(await clearAt(day, [draft])).toEqual([{ outcome: "refused" }]);
      expect(await waitingCandidates({ db: day.client, twinId: day.twin.twinId }, new Date())).toContain(draft);
    });
  });

  it("leaves a report nobody cleared on the canvas for its day, and off it after", async () => {
    await withDay(() => SILENT, async (day) => {
      await plantDraft(day);
      const report = await plantReport(day);
      const candidates = (hours: number) =>
        waitingCandidates({ db: day.client, twinId: day.twin.twinId }, new Date(Date.now() + hours * 60 * 60 * 1000));
      expect(await candidates(23)).toContain(report);
      expect(await candidates(25)).not.toContain(report);
    });
  });

  it("the twin's curation takes a card off the canvas — it still waits — and places it again by naming it", async () => {
    let draft = "";
    await withDay(
      (prompt) =>
        prompt.includes("quítame ese borrador")
          ? [
              { toolCall: { name: "move_cards", input: { top: null, order: [], leave: [draft] } } },
              { text: "" },
            ]
          : prompt.includes("regrésamelo")
            ? [
                { toolCall: { name: "move_cards", input: { top: draft, order: [] } } },
                { text: "" },
              ]
            : SILENT,
      async (day) => {
        draft = await plantDraft(day);
        const read = () =>
          readCanvas(
            { db: day.client, twinId: day.twin.twinId, dek: day.twin.dek, timeZone: ZONE },
            { seatId: day.seat.seatId, now: new Date() },
          );

        await repWrites(day.client, day.twin, "quítame ese borrador de enfrente");
        await processPendingWaEvents(day.deps());
        const off = await read();
        expect(off.curation?.left).toEqual([draft]);
        expect(off.curation?.spotlight).toBeUndefined();
        expect(off.facts.waiting).toBe(0);
        // THE CARD STILL WAITS: a run waiting on it, its reminder and the bell
        // read it as before; only Inicio leaves it out.
        expect(await waitingCandidates({ db: day.client, twinId: day.twin.twinId }, new Date())).toContain(draft);
        expect(off.waiting.map((post) => post.id)).toContain(draft);

        await repWrites(day.client, day.twin, "regrésamelo");
        await processPendingWaEvents(day.deps());
        const back = await read();
        expect(back.curation?.left).toEqual([]);
        expect(back.curation?.spotlight).toBe(draft);
        expect(back.facts.waiting).toBe(1);
      },
    );
  });
});

describe("the spotlight: one card the twin holds up (ticket #401, ruled 2026-10-13)", () => {
  /** The rows the spotlight tool wrote, oldest first. */
  async function spotlights(client: pg.Client, twin: Twin): Promise<(string | null)[]> {
    const rows = await client.query<{ post_id: string | null }>(
      "SELECT post_id FROM canvas_spotlights WHERE twin_id = $1 ORDER BY id",
      [twin.twinId],
    );
    return rows.rows.map((row) => row.post_id);
  }

  it("holds a card up as the twin's act — a version, the page told, the canvas read and the card list carry it — and null ends it", async () => {
    let target = "";
    const script: Script = (prompt) =>
      prompt.includes("¿cuál veo primero?")
        ? [{ toolCall: spotlightCall(target) }, ...replyTurns("Esa.")]
        : prompt.includes("ya no")
          ? [{ toolCall: spotlightCall(null) }, ...replyTurns("Listo.")]
          : SILENT;
    await withDay(script, async (day) => {
      target = await plantDraft(day);
      await processPendingWaEvents(day.deps());
      const events = createSeatEvents();
      const heard: TwinStreamEvent[] = [];
      events.subscribe(day.seat.seatId, (event) => heard.push(event));
      await typeAtTheDoor(day.client, day.twin, day.seat, "¿cuál veo primero?");
      await processPendingWaEvents(day.deps({ events }));

      expect(await spotlights(day.client, day.twin)).toEqual([target]);
      expect(day.model.requests.flatMap((request) => toolResultsOf(request))).toContain(`Post ${target} is held up on the rep's dashboard.`);
      expect(heard).toContainEqual(expect.objectContaining({ kind: "curated", spotlit: { postId: target, since: expect.any(String) as unknown } }));
      const feed = { db: day.client, twinId: day.twin.twinId, dek: day.twin.dek, timeZone: ZONE, bundle: day.twin.bundle };
      expect((await readCanvas(feed, { seatId: day.seat.seatId, now: new Date() })).spotlight?.postId).toBe(target);
      // THE CARD LIST THE NEXT TURN READS SAYS IT, with when it began.
      await typeAtTheDoor(day.client, day.twin, day.seat, "ya no");
      await processPendingWaEvents(day.deps({ events }));
      expect(day.model.requests.map((request) => latestPromptOf(request)).join("\n")).toMatch(
        new RegExp(`post ${target} [^\\n]* · in the spotlight since \\[`, "u"),
      );
      // ...AND NULL ENDS IT.
      expect(await spotlights(day.client, day.twin)).toEqual([target, null]);
      expect(heard).toContainEqual(expect.objectContaining({ kind: "curated", spotlit: null }));
      expect((await readCanvas(feed, { seatId: day.seat.seatId, now: new Date() })).spotlight).toBeUndefined();
    });
  });

  it("refuses a card that does not wait on the rep's dashboard, and writes nothing", async () => {
    const stray = randomUUID();
    const script: Script = (prompt) =>
      prompt.includes("ponla arriba") ? [{ toolCall: spotlightCall(stray) }, ...replyTurns("No la veo.")] : SILENT;
    await withDay(script, async (day) => {
      await typeAtTheDoor(day.client, day.twin, day.seat, "ponla arriba");
      await processPendingWaEvents(day.deps());
      expect(day.model.requests.flatMap((request) => toolResultsOf(request))).toContainEqual(
        expect.stringMatching(new RegExp(`^refused: post ${stray} is not a card on the rep's dashboard now`, "u")),
      );
      expect(await spotlights(day.client, day.twin)).toEqual([]);
    });
  });

  it("ends when its card settles — the rep discarded it", async () => {
    let target = "";
    const script: Script = (prompt) =>
      prompt.includes("¿cuál veo primero?") ? [{ toolCall: spotlightCall(target) }, ...replyTurns("Esa.")] : SILENT;
    await withDay(script, async (day) => {
      target = await plantDraft(day);
      await processPendingWaEvents(day.deps());
      const feed = { db: day.client, twinId: day.twin.twinId, dek: day.twin.dek, timeZone: ZONE, bundle: day.twin.bundle };
      await typeAtTheDoor(day.client, day.twin, day.seat, "¿cuál veo primero?");
      await processPendingWaEvents(day.deps());
      expect((await readSpotlight(feed, new Date()))?.postId).toBe(target);
      const draft = await day.client.query<{ draft_id: string }>("SELECT draft_id FROM posts WHERE id = $1", [target]);
      const dismissal = await repWrites(day.client, day.twin, "así no");
      await day.client.query("INSERT INTO draft_dismissals (draft_id, source_event_id) VALUES ($1, $2)", [
        draft.rows[0]!.draft_id,
        dismissal,
      ]);
      expect(await readSpotlight(feed, new Date())).toBeUndefined();
    });
  });

  it("ends when its card is taken off the dashboard, and stays ended when the card comes back", async () => {
    let target = "";
    const script: Script = (prompt) =>
      prompt.includes("¿cuál veo primero?")
        ? [{ toolCall: spotlightCall(target) }, ...replyTurns("Esa.")]
        : prompt.includes("quítala")
          ? [{ toolCall: { name: "move_cards", input: { top: null, order: [], leave: [target] } } }, ...replyTurns("Fuera.")]
          : prompt.includes("regrésala")
            ? [{ toolCall: moveCardsCall(target) }, ...replyTurns("Ahí está.")]
            : SILENT;
    await withDay(script, async (day) => {
      target = await plantDraft(day);
      await processPendingWaEvents(day.deps());
      const feed = { db: day.client, twinId: day.twin.twinId, dek: day.twin.dek, timeZone: ZONE, bundle: day.twin.bundle };
      await typeAtTheDoor(day.client, day.twin, day.seat, "¿cuál veo primero?");
      await processPendingWaEvents(day.deps());
      expect((await readSpotlight(feed, new Date()))?.postId).toBe(target);
      await typeAtTheDoor(day.client, day.twin, day.seat, "quítala");
      await processPendingWaEvents(day.deps());
      expect(await readSpotlight(feed, new Date())).toBeUndefined();
      await typeAtTheDoor(day.client, day.twin, day.seat, "regrésala");
      await processPendingWaEvents(day.deps());
      expect(await readSpotlight(feed, new Date())).toBeUndefined();
    });
  });
});
