/**
 * THE TWIN'S WORKING MEMORY AND THE LEAN-IN OFFER, AT THE POSTGRES SEAM
 * (ticket #322; spec #318 decisions 2, 19, 20, 32 and 33).
 *
 * The pre-agreed seam: door rows and the runtime's own events in; out the
 * other side the bundle's working-memory versions, what the scripted model was
 * shown and what its tools answered, the curation record with its sealed
 * offers, the runtime API's reads and the seat's stream. Real Postgres, real
 * envelope crypto, real SQLCipher and the real Claude Agent SDK child; only the
 * model is scripted (ADR-0028), and CI never calls one.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBundle, type Bundle } from "@dito/bundle";
import { createDekFromMaterial, type Dek } from "@dito/crypto";
import { sessionFile } from "@dito/execution";
import {
  TWIN_API_ACT_ROUTES,
  TWIN_API_ASK_ROUTES,
  TWIN_API_ROUTES,
  TWIN_API_SEAT_HEADER,
  type TwinCanvas,
  type TwinStreamEvent,
} from "@dito/seam";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readCanvas, writeCuration } from "./canvas.js";
import { processPendingWaEvents, type TwinRuntimeDeps } from "./consumer.js";
import { RECEIPTS } from "./grammar.js";
import { startLocalApi } from "./local-api.js";
import { NOTEPAD_PART } from "./rep-notepad.js";
import { createSeatEvents, type SeatEvents } from "./seat-events.js";
import { createSendLockWriter } from "./send-lock/writer.js";
import {
  resetAndMigrate,
  withClient,
  TEST_AUDIT_HMAC_KEY,
  TEST_DATABASE_URL,
} from "./testing/db.js";
import { seatAtTheDoor, typeAtTheDoor, type DoorSeat } from "./testing/door.js";
import { newExecutionPool } from "./testing/execution-pool.js";
import { fakeEmbedder } from "./testing/fake-embedder.js";
import { insertWaEvent } from "./testing/seam-fixtures.js";
import {
  closeScriptedModels,
  scriptedModel,
  systemOf,
  toolResultsOf,
  type Script,
  type ScriptedModel,
  type ScriptedTurn,
} from "./testing/scripted-model.js";
import { SETTLE_IMMEDIATELY } from "./testing/settle.js";
import { removeTmpDir } from "./testing/tmp.js";
import {
  isEventTurn,
  isThreadTurn,
  threadTurns,
  type ThreadToolCall,
} from "./testing/thread-script.js";
import { EVIDENCE_PARAMETER } from "./thread/evidence.js";
import { WRITE_NOTEPAD_TOOL } from "./thread/notepad.js";
import { createThreadSessions, type ThreadSessions } from "./thread/sessions.js";
import { WRITE_WORKING_MEMORY_TOOL } from "./thread/working-memory.js";
import { WORKING_MEMORY_PART } from "./working-memory.js";

// EVERY CASE SPAWNS AT LEAST ONE CLAUDE CODE CHILD.
vi.setConfig({ testTimeout: 120_000 });

afterAll(closeScriptedModels);

const SELF_CHAT = "5215550000@s.whatsapp.net";
const ZONE = "America/Monterrey";
const BEARER = "working-memory-integration-bearer";

/** The rep's standing rule, so «after the notepad» has a notepad to be after. */
const RULE = "con la Sra. Garza siempre de usted";

let tmp: string;
let pool: pg.Pool;
const executionPool = newExecutionPool();

beforeAll(async () => {
  await resetAndMigrate();
  tmp = mkdtempSync(join(tmpdir(), "dito-working-memory-int-"));
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

interface Day {
  readonly client: pg.Client;
  readonly twin: Twin;
  readonly seat: DoorSeat;
  readonly model: ScriptedModel;
  readonly sessions: ThreadSessions;
  readonly events: SeatEvents;
  readonly heard: TwinStreamEvent[];
  readonly deps: () => TwinRuntimeDeps;
}

/** A twin with a seat, a scripted model, one day's registry and a seat bus. */
async function withDay(script: Script, run: (day: Day) => Promise<void>): Promise<void> {
  await withClient(async (client) => {
    const twinId = randomUUID();
    const dek = createDekFromMaterial(randomBytes(32));
    const twin: Twin = { twinId, dek, bundle: createBundle(join(tmp, `${twinId}.bundle`), dek) };
    const seat = await seatAtTheDoor(client, twin.twinId);
    const model = scriptedModel(script);
    const sessions = createThreadSessions();
    const events = createSeatEvents();
    const heard: TwinStreamEvent[] = [];
    events.subscribe(seat.seatId, (event) => heard.push(event));
    try {
      await run({
        client,
        twin,
        seat,
        model,
        sessions,
        events,
        heard,
        deps: () => runtimeDeps(client, twin, model, sessions, events),
      });
    } finally {
      await sessions.close();
      twin.bundle.close();
    }
  });
}

function runtimeDeps(
  client: pg.Client,
  twin: Twin,
  model: ScriptedModel,
  sessions: ThreadSessions,
  events?: SeatEvents,
): TwinRuntimeDeps {
  return {
    db: client,
    executionPool,
    harness: model.harness,
    bundle: twin.bundle,
    dek: twin.dek,
    twinId: twin.twinId,
    selfChatJid: SELF_CHAT,
    ...SETTLE_IMMEDIATELY,
    drafting: { model: "claude-sonnet-5" },
    embedder: fakeEmbedder(),
    sendLock: createSendLockWriter({ pool, hmacKey: TEST_AUDIT_HMAC_KEY }),
    hmacKey: TEST_AUDIT_HMAC_KEY,
    timeZone: ZONE,
    threadSessions: sessions,
    ...(events === undefined ? {} : { events }),
  };
}

/** The runtime API over this day's twin, sessions and seat bus. */
async function apiOver(day: Day) {
  const api = await startLocalApi(
    {
      db: pool,
      twinId: day.twin.twinId,
      dek: day.twin.dek,
      bearer: BEARER,
      timeZone: ZONE,
      acts: { hmacKey: TEST_AUDIT_HMAC_KEY, bundle: day.twin.bundle, selfChatJid: SELF_CHAT },
      thread: day.sessions,
      events: day.events,
    },
    { port: 0 },
  );
  const origin = `http://127.0.0.1:${String(api.port)}`;
  const headers = {
    authorization: `Bearer ${BEARER}`,
    [TWIN_API_SEAT_HEADER]: day.seat.seatId,
    "content-type": "application/json",
  };
  return {
    close: () => api.close(),
    // EVERY READ CARRIES THE PAGE'S `now`, as rep-web's do; the ones that cut
    // no day ignore it.
    get: async (path: string): Promise<unknown> => {
      const res = await fetch(
        `${origin}${path}?now=${encodeURIComponent(new Date().toISOString())}`,
        { headers },
      );
      expect(res.status).toBe(200);
      return await res.json();
    },
    post: async (path: string, body?: unknown): Promise<unknown> => {
      const res = await fetch(`${origin}${path}`, {
        method: "POST",
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      expect(res.status).toBe(200);
      return await res.json();
    },
  };
}

/** A call to the working-memory tool. */
function noteCall(input: {
  readonly text: string;
  readonly matters: readonly { readonly label: string; readonly about: string }[];
  readonly based_on: number;
  readonly rep_asked?: boolean;
}): ThreadToolCall {
  return { name: WRITE_WORKING_MEMORY_TOOL, input: { ...input, matters: [...input.matters] } };
}

/** A turn that reads the canvas, does what it is given, and answers from that read. */
function answering(calls: readonly ThreadToolCall[], answer: string): ScriptedTurn[] {
  return threadTurns({ calls: [{ name: "read_canvas", input: {} }, ...calls], answer });
}

const SILENT: ScriptedTurn[] = threadTurns({});

/** A draft card the twin wrote for the rep to act on, planted by its own drafting run. */
async function plantDraft(day: Day): Promise<string> {
  const chat = `5215552${String(Math.floor(Math.random() * 1e6)).padStart(6, "0")}@s.whatsapp.net`;
  await insertWaEvent(day.client, day.twin.dek, {
    twinId: day.twin.twinId,
    companyId: day.seat.companyId,
    seatId: day.seat.seatId,
    chatJid: chat,
    senderJid: chat,
    fromMe: false,
    messageId: `3EB0-WM-${randomUUID().slice(0, 8)}`,
    text: "¿tienes 12 bombas?",
    pushName: "Torres",
    occurredAt: new Date(),
  });
  const drafting = scriptedModel([
    { toolCall: { name: "create_draft", input: { text: "sí, te las aparto" } } },
    { text: "done" },
  ]);
  const sessions = createThreadSessions();
  try {
    await processPendingWaEvents(runtimeDeps(day.client, day.twin, drafting, sessions));
  } finally {
    await sessions.close();
  }
  const post = await day.client.query<{ id: string }>(
    `SELECT p.id FROM posts p JOIN drafts d ON d.id = p.draft_id
      WHERE p.twin_id = $1 AND d.destination = $2`,
    [day.twin.twinId, chat],
  );
  return post.rows[0]!.id;
}

/** The wake messages the day's session holds, oldest first. */
async function wakesOf(day: Day): Promise<string[]> {
  const open = await day.client.query<{ session_id: string }>(
    "SELECT session_id FROM thread_sessions WHERE twin_id = $1 AND closed_at IS NULL",
    [day.twin.twinId],
  );
  const file = readFileSync(
    sessionFile(day.model.harness.directory, open.rows[0]!.session_id),
    "utf8",
  );
  return file
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { type: string; message?: { content?: unknown } })
    .filter((entry) => entry.type === "user")
    .flatMap((entry) => {
      const content = entry.message?.content;
      if (typeof content === "string") return [content];
      if (!Array.isArray(content)) return [];
      const blocks = content as { type?: string; text?: string }[];
      if (blocks.some((block) => block.type === "tool_result")) return [];
      return [blocks.map((block) => block.text ?? "").join("\n")];
    });
}

/** Every tool result the newest request carries, in order. */
function resultsSoFar(model: ScriptedModel): string[] {
  return toolResultsOf(model.requests.at(-1));
}

describe("the twin writes its working memory, and every next turn reads it after the notepad (AC 1)", () => {
  const OPENS = "dile a Torres que el pedido sale el jueves";
  const CLOSES = "lo de Torres ya quedó";

  it("opens a matter, refuses an over-cap rewrite with the notes that stand, closes it, and the chips and the stream follow", async () => {
    let card = "";
    const script: Script = (prompt) => {
      if (!isThreadTurn(prompt)) return SILENT;
      if (prompt.includes(OPENS)) {
        return answering(
          [
            noteCall({
              text: "Torres espera saber que su pedido sale el jueves.",
              matters: [{ label: "Torres, el pedido", about: card }],
              based_on: 0,
            }),
          ],
          "Va, se lo digo.",
        );
      }
      if (prompt.includes(CLOSES)) {
        return answering(
          [
            noteCall({ text: "x".repeat(2001), matters: [], based_on: 1 }),
            noteCall({ text: "Lo de Torres ya quedó.", matters: [], based_on: 1, rep_asked: true }),
          ],
          "Perfecto.",
        );
      }
      return SILENT;
    };
    await withDay(script, async (day) => {
      day.twin.bundle.writeNotepad({
        text: RULE,
        writtenAt: "2026-10-04T15:00:00.000Z",
        executionId: randomUUID(),
        evidenceRef: randomUUID(),
      });
      card = await plantDraft(day);
      const api = await apiOver(day);
      try {
        // THE FIRST LINE OPENS A MATTER: a version, about the card's post id.
        await typeAtTheDoor(day.client, day.twin, day.seat, OPENS);
        await processPendingWaEvents(day.deps());
        const opened = day.twin.bundle.readWorkingMemory();
        expect(opened).toMatchObject({
          version: 1,
          text: "Torres espera saber que su pedido sale el jueves.",
          matters: [{ label: "Torres, el pedido", about: { kind: "post", id: card } }],
        });
        // THE MATTERS' READ AND THE STREAM CARRY THE MATTER (AC 4), WITH ITS
        // SUBJECT RENDERED BY CODE — the card's own customer — and that
        // customer's reference, which a waiting card carries (ticket #335).
        const matters = (await api.get(TWIN_API_ROUTES.openMatters)) as {
          version: number;
          matters: { label: string; about: unknown; subject?: string }[];
        };
        expect(matters).toEqual({
          version: 1,
          matters: [
            {
              label: "Torres, el pedido",
              about: { kind: "post", id: card },
              subject: expect.stringMatching(/^Torres/u) as unknown as string,
              customer: expect.stringMatching(/^c\d+$/u) as unknown as string,
            },
          ],
        });
        expect(day.heard).toContainEqual({ kind: "noted", ...matters });

        // THE SECOND LINE CLOSES IT, after a rewrite the cap refused.
        await typeAtTheDoor(day.client, day.twin, day.seat, CLOSES);
        await processPendingWaEvents(day.deps());
        const closed = day.twin.bundle.readWorkingMemory();
        expect(closed).toMatchObject({ version: 2, text: "Lo de Torres ya quedó.", matters: [] });
        // THE REFUSAL HANDED THE MODEL WHAT STANDS, to rewrite from.
        const refusal = resultsSoFar(day.model)
          .map((result) => JSON.parse(result.startsWith("{") ? result : "{}") as Record<string, unknown>)
          .find((result) => result["outcome"] === "over_cap");
        expect(refusal).toMatchObject({
          cap: 2000,
          chars_attempted: 2001,
          current_version: 1,
          current_text: "Torres espera saber que su pedido sale el jueves.",
        });
        expect(day.heard.filter((event) => event.kind === "noted").at(-1)).toEqual({
          kind: "noted",
          version: 2,
          matters: [],
        });
        // BOTH TURNS ENDED WELL, each having written its notes.
        const turns = await day.client.query<{ disposition: string }>(
          "SELECT disposition FROM executions WHERE twin_id = $1 AND trigger_kind = 'twin_thread_message'",
          [day.twin.twinId],
        );
        expect(turns.rows.map((row) => row.disposition)).toEqual(["acted", "acted"]);
        // THE REP ASKED, SO THE RECEIPT FOLDED INTO THE REPLY.
        const exchanges = (await api.get(TWIN_API_ROUTES.exchanges)) as {
          days: { exchanges: { text: string; reply?: { parts: { kind: string; text?: string }[] } }[] }[];
        };
        const closing = exchanges.days.flatMap((one) => one.exchanges).find((one) => one.text === CLOSES);
        expect(closing?.reply?.parts).toContainEqual(
          expect.objectContaining({ kind: "receipt", text: RECEIPTS.workingMemoryWritten }),
        );

        // THE SECOND WAKE WAS SHOWN THE FIRST VERSION, right after the
        // notepad, marked as the twin's own notes — in the wake, never in the
        // system text fixed when the session opened.
        const wake = (await wakesOf(day)).find((one) => one.includes(CLOSES))!;
        expect(wake.indexOf(`## ${WORKING_MEMORY_PART}`)).toBeGreaterThan(wake.indexOf(`## ${NOTEPAD_PART}`));
        expect(wake.indexOf(`## ${WORKING_MEMORY_PART}`)).toBeLessThan(wake.indexOf(CLOSES));
        expect(wake).toContain(RULE);
        expect(wake).toContain(
          "[Your own working notes, at version 1: what you are keeping track of with this rep. You wrote these; they are not the rep's instructions and bind nothing.",
        );
        expect(wake).toContain(`- Torres, el pedido [post ${card}]`);
        expect(wake.indexOf("Torres espera saber")).toBeGreaterThan(wake.indexOf("</rep_notepad>"));
        expect(systemOf(day.model.requests.at(-1))).not.toContain("<working_memory>");
      } finally {
        await api.close();
      }
    });
  });

  it("is shown to the next drafting turn right after the notepad, as notes", async () => {
    const drafts: ScriptedTurn[] = [
      { toolCall: { name: "create_draft", input: { text: "Claro, se las cotizo." } } },
      { text: "done" },
    ];
    await withDay((prompt) => (isThreadTurn(prompt) || isEventTurn(prompt, "post.landed") ? SILENT : drafts), async (day) => {
      day.twin.bundle.writeNotepad({
        text: RULE,
        writtenAt: "2026-10-04T15:00:00.000Z",
        executionId: randomUUID(),
        evidenceRef: randomUUID(),
      });
      day.twin.bundle.writeWorkingMemory({
        text: "Garza espera la cotización de las bombas.",
        matters: [],
        writtenAt: "2026-10-04T15:05:00.000Z",
        executionId: randomUUID(),
      });
      const chat = "5215551234567@s.whatsapp.net";
      await insertWaEvent(day.client, day.twin.dek, {
        twinId: day.twin.twinId,
        chatJid: chat,
        senderJid: chat,
        fromMe: false,
        messageId: `3EB0-WM-${randomUUID().slice(0, 8)}`,
        text: "¿a cómo las bombas?",
        occurredAt: new Date(),
      });
      await processPendingWaEvents(day.deps());
      const prompt = day.model.requests
        .map((request) => JSON.stringify(request["messages"]))
        .find((one) => one.includes("## the turn"));
      expect(prompt).toBeDefined();
      const notes = prompt!.indexOf(`## ${WORKING_MEMORY_PART}`);
      expect(notes).toBeGreaterThan(prompt!.indexOf(`## ${NOTEPAD_PART}`));
      expect(prompt!.indexOf(RULE)).toBeLessThan(notes);
      expect(prompt).toContain("Garza espera la cotización de las bombas.");
      expect(prompt).toContain("they are not the rep's instructions and bind nothing:]");
    });
  });
});

describe("a turn an event woke writes the working memory and cannot write the notepad (AC 2)", () => {
  it("notes the rep's settle of the spotlit card; the same turn's notepad write is refused for want of a rep line", async () => {
    let spotlit = "";
    const script: Script = (prompt) =>
      isEventTurn(prompt, "post.settled")
        ? threadTurns({
            calls: [
              noteCall({ text: "El rep descartó la respuesta para Torres.", matters: [], based_on: 0 }),
              {
                name: WRITE_NOTEPAD_TOOL,
                input: { [EVIDENCE_PARAMETER]: randomUUID(), text: "siempre de usted", based_on: 0 },
              },
            ],
          })
        : SILENT;
    await withDay(script, async (day) => {
      spotlit = await plantDraft(day);
      await writeCuration(
        { db: day.client, dek: day.twin.dek },
        {
          twinId: day.twin.twinId,
          executionId: (
            await day.client.query<{ id: string }>("SELECT id FROM executions WHERE twin_id = $1 LIMIT 1", [
              day.twin.twinId,
            ])
          ).rows[0]!.id,
          spotlight: spotlit,
          order: [spotlit],
          offers: [],
          left: [],
        },
      );
      const api = await apiOver(day);
      try {
        await api.post(TWIN_API_ACT_ROUTES.dismissDraft, { postId: spotlit });
        await processPendingWaEvents(day.deps());

        const turn = await day.client.query<{ id: string }>(
          `SELECT id FROM executions WHERE twin_id = $1 AND trigger_kind = 'twin_thread_event'
             AND trigger_ref LIKE '%event:post.settled%'`,
          [day.twin.twinId],
        );
        expect(turn.rows).toHaveLength(1);
        // THE WORKING MEMORY WAS WRITTEN, BY THAT TURN.
        expect(day.twin.bundle.readWorkingMemory()).toMatchObject({
          version: 1,
          text: "El rep descartó la respuesta para Torres.",
          executionId: turn.rows[0]!.id,
        });
        // ...AND THE NOTEPAD WAS NOT: no rep line, no evidence.
        expect(day.twin.bundle.readNotepad()).toBeUndefined();
        expect(resultsSoFar(day.model)).toContain(
          "refused: this turn was woken by an event, not by a message from the rep, so there is no message of theirs that could ask for this.",
        );
      } finally {
        await api.close();
      }
    });
  });
});

describe("the lean-in offer rides on the arrival's curation (AC 4)", () => {
  it("writes the twin's offer on the card it placed, sealed, and the canvas read and the stream carry it", async () => {
    let target = "";
    // THE CARD'S CUSTOMER BY THEIR REFERENCE (#321), read once it is planted.
    let customer = "";
    const script: Script = (prompt) =>
      isEventTurn(prompt, "arrival")
        ? threadTurns({
            calls: [
              // AN OFFER WITH A LINK IS REFUSED, AND NOTHING IS CHOSEN...
              {
                name: "move_cards",
                input: {
                  top: target,
                  order: [],
                  offers: [{ post_id: target, sentence: "Mira https://example.com" }],
                },
              },
              // ...AND ONE THAT PASSES IS WRITTEN, ITS SLOT FILLED.
              {
                name: "move_cards",
                input: {
                  top: target,
                  order: [],
                  offers: [{ post_id: target, sentence: `¿Le confirmo a [${customer}] que sí hay?` }],
                },
              },
            ],
            answer: `Buenos días; empieza por [${customer}].`,
          })
        : SILENT;
    await withDay(script, async (day) => {
      target = await plantDraft(day);
      customer = (
        await readCanvas(
          { db: day.client, twinId: day.twin.twinId, dek: day.twin.dek, timeZone: ZONE, bundle: day.twin.bundle },
          { seatId: day.seat.seatId, now: new Date() },
        )
      ).waiting.find((post) => post.id === target)!.customer!;
      const api = await apiOver(day);
      try {
        await api.post(TWIN_API_ASK_ROUTES.arrival);
        await processPendingWaEvents(day.deps());

        const versions = await day.client.query<{ offers_enc: Buffer | null }>(
          "SELECT offers_enc FROM canvas_curations WHERE twin_id = $1",
          [day.twin.twinId],
        );
        expect(versions.rows).toHaveLength(1);
        // SEALED: the sentence is nowhere in the row's bytes.
        expect(versions.rows[0]!.offers_enc?.toString("utf8") ?? "").not.toContain("confirmo");
        const canvas = await readCanvas(
          { db: day.client, twinId: day.twin.twinId, dek: day.twin.dek, timeZone: ZONE, bundle: day.twin.bundle },
          { seatId: day.seat.seatId, now: new Date() },
        );
        expect(canvas.curation?.offers).toHaveLength(1);
        const offer = canvas.curation!.offers[0]!;
        expect(offer.postId).toBe(target);
        // KEPT AS THE TWIN WROTE IT, WITH THE CUSTOMER IT NAMES (ticket #404):
        // the page draws the name, never a string with the name pasted in.
        expect(offer.sentence).toBe(`¿Le confirmo a [${customer}] que sí hay?`);
        expect(offer.mentions).toEqual([expect.objectContaining({ reference: customer })]);
        const mentions = offer.mentions!.map(({ reference, name, tails }) => ({
          reference,
          name,
          ...(tails === undefined ? {} : { tails }),
        }));
        // THE WIRE CARRIES IT, AND SO DOES `curated`.
        const wire = (await api.get(TWIN_API_ROUTES.canvas)) as TwinCanvas;
        expect(wire.curation?.offers).toEqual([{ postId: target, sentence: offer.sentence, mentions }]);
        expect(day.heard).toContainEqual(
          expect.objectContaining({
            kind: "curated",
            curation: expect.objectContaining({ offers: [{ postId: target, sentence: offer.sentence, mentions }] }),
          }),
        );
        expect(resultsSoFar(day.model).some((result) => result.includes("with no link"))).toBe(true);
      } finally {
        await api.close();
      }
    });
  });
});
