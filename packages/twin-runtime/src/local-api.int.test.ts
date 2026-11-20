/**
 * THE RUNTIME'S LOCAL API, AT ITS OWN SEAM (ticket #221 AC 3; spec #214's
 * Testing Decisions — "the runtime's local API is the one new seam.
 * Integration tests drive a real runtime over a real fixture bundle and
 * assert what the API returns … A bearer that is not rep-web's is refused; a
 * seat cannot reach another twin's feed").
 *
 * THE SEAM IS HTTP, so every claim below is made against bytes a client would
 * receive: `fetch` against a real server on a real ephemeral loopback port,
 * with a real Postgres seam underneath and real envelope crypto over a real
 * SQLCipher bundle (ADR-0028 — the crypto path is never mocked). Nothing
 * reaches into a handler.
 *
 * THE POSTS ARE PLANTED THROUGH THE RUNTIME, not through an INSERT. The feed
 * opens sealed parts, so a row written by hand would prove that the read can
 * decrypt bytes this file encrypted — a test that passes by construction. A
 * scripted drafting run writes the post the way the twin does, and the model
 * is scripted at the model boundary as always: CI never calls one.
 *
 * TWO TWINS, ALWAYS. Every refusal in this file is about telling one twin's
 * seat from another's, and a suite with one twin cannot see the difference
 * between a scoped read and an unscoped one.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBundle, type Bundle } from "@dito/bundle";
import { createDekFromMaterial, type Dek } from "@dito/crypto";
import {
  readLinkSession,
  TWIN_API_ACT_ROUTES,
  TWIN_API_ACTS_LOG_DAYS,
  TWIN_API_ASK_ROUTES,
  TWIN_API_BACK_PARAM,
  TWIN_API_KEEP_PARAM,
  TWIN_API_MESSAGE_MAX_CHARS,
  TWIN_API_NOTEPAD_MAX_CHARS,
  TWIN_API_ROUTES,
  TWIN_API_SEAT_HEADER,
  TWIN_API_STREAM_ROUTES,
  withReadSnapshot,
  type TwinActsLog,
  type TwinApiArrivalResult,
  type TwinCanvas,
  type TwinDocuments,
  type TwinExchange,
  type TwinExchanges,
  type TwinFeedPost,
  type TwinOfferSpendings,
  type TwinRailState,
  type TwinRoutines,
  type TwinRutina,
  type TwinShippedAutomation,
  type TwinRuns,
  type TwinStreamEvent,
} from "@dito/seam";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { processResolvedSends } from "./confirmations.js";
import { waitingCandidates, writeCuration } from "./canvas.js";
import { processPendingWaEvents, type TwinRuntimeDeps } from "./consumer.js";
import { RECEIPTS, renderReceiptPost } from "./grammar.js";
import { LINK_ASK_UNTAKEN_SECONDS, LINK_ASK_WINDOW_SECONDS } from "./link.js";
import { startLocalApi, type LocalApi } from "./local-api.js";
import { createSeatEvents, type SeatEvents } from "./seat-events.js";
import { composeAnswerPost, composeDraftPost, documentPart, listPart, sealParts } from "./posts.js";
import { insertNoticeWithSystemSend } from "./notices.js";
import { TwinExecutionStore } from "./execution-store.js";
import { customersOf, mentionsIn } from "./thread/references.js";
import { recordDraft } from "./drafts.js";
import { createSendLockWriter } from "./send-lock/writer.js";
import { createStreamWatch } from "./stream-watch.js";
import {
  resetAndMigrate,
  TEST_AUDIT_HMAC_KEY,
  TEST_DATABASE_URL,
  withClient,
} from "./testing/db.js";
import { newExecutionPool } from "./testing/execution-pool.js";
import { fakeEmbedder } from "./testing/fake-embedder.js";
import { closeScriptedModels, scriptedModel, type Script } from "./testing/scripted-model.js";
import { disclosedFact } from "./testing/disclosed-fact.js";
import { insertWaEvent, simulateExecutorPost } from "./testing/seam-fixtures.js";
import { SETTLE_IMMEDIATELY } from "./testing/settle.js";
import { removeTmpDir } from "./testing/tmp.js";
import { createThreadSessions, type ThreadSessions } from "./thread/sessions.js";
import { readRunContent, writeRunContent } from "./runs/content.js";
import { advanceRuns, createRunEngine } from "./runs/engine.js";
import { openBatchWork } from "./lanes.js";
import { runDigest, type RunDefinition } from "./runs/definition.js";
import { beginStep, insertRun, parkStep, scheduleWait } from "./runs/store.js";
import { ensureShippedAutomations } from "./runs/shipped-automations.js";
import { insertRutina, sweepRutinaContent, type RutinaWake } from "./runs/rutinas.js";

// Every scripted model this suite opened is closed with it (#328).
afterAll(closeScriptedModels);

const SELF_CHAT = "5215550000@s.whatsapp.net";
const CUSTOMER = "5215550001@s.whatsapp.net";
const PUSH_NAME = "Sra. Garza";
const ZONE = "America/Monterrey";
const DRAFT_TEXT = "claro, se las mando el jueves temprano";
/** The sentence a drafting turn finishes on: the card's sentence (ticket #368). */
const SENTENCE = "Te dejé la respuesta: preguntó por 40 cajas y quedó sin respuesta.";

/** 2026-08-29 10:20 America/Monterrey — the customer's message. */
const MORNING = new Date("2026-08-29T16:20:00.000Z");
/** ...and the instant a page renders at, which the feed read takes. */
const READING = new Date("2026-08-29T17:00:00.000Z");

/** The bearer this runtime is started with. A test value and nothing else. */
const BEARER = "rep-web-integration-bearer";

const executionPool = newExecutionPool();

let tmp: string;
let pool: pg.Pool;
let api: LocalApi;
let origin: string;
/** The twin the API serves, and one it does not. */
let served: Twin;
let other: Twin;

interface Twin {
  readonly twinId: string;
  readonly companyId: string;
  readonly seatId: string;
  readonly dek: Dek;
  readonly bundle: Bundle;
}

beforeAll(async () => {
  await resetAndMigrate();
  tmp = mkdtempSync(join(tmpdir(), "dito-local-api-int-"));
  pool = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 4 });
  served = freshTwin();
  other = freshTwin();
  await withClient(async (client) => {
    // The registry both twins' seats live in — the API resolves a seat to a
    // twin through it, so without these rows every request is `unknown_seat`.
    for (const twin of [served, other]) {
      await client.query(
        "INSERT INTO companies (id, display_name) VALUES ($1, $2)",
        [twin.companyId, `Ferretería ${twin.companyId.slice(0, 4)}`],
      );
      await client.query(
        `INSERT INTO seats (id, company_id, twin_id, rep_display_name, state)
         VALUES ($1, $2, $3, $4, 'linked')`,
        [twin.seatId, twin.companyId, twin.twinId, "Mauricio Cantú"],
      );
      // ...and Dito's own automations for each seat, as the runtime's pass
      // writes them.
      await ensureShippedAutomations(client, { twinId: twin.twinId, seatId: twin.seatId }, MORNING);
    }
    // One customer message per twin, drafted by a scripted run: the post the
    // feed reads is the post the twin composed.
    for (const twin of [served, other]) {
      await customerWrites(client, twin);
      await processPendingWaEvents(depsFor(client, twin, draftingTurns()));
    }
    // ...and the rail's own history for the served twin: linked, then dropped.
    await client.query(
      `INSERT INTO rail_status_events (twin_id, status, detail, occurred_at)
       VALUES ($1, 'linked', '', $2), ($1, 'dropped', '', $3)`,
      [
        served.twinId,
        new Date("2026-08-28T10:00:00.000Z"),
        new Date("2026-08-29T15:00:00.000Z"),
      ],
    );
    // The other twin's rail is somewhere else entirely, so a leak would show.
    await client.query(
      `INSERT INTO rail_status_events (twin_id, status, detail, occurred_at)
       VALUES ($1, 'logged_out', '', $2)`,
      [other.twinId, new Date("2026-08-29T16:00:00.000Z")],
    );
  });
  api = await startLocalApi(
    {
      db: pool,
      twinId: served.twinId,
      dek: served.dek,
      bearer: BEARER,
      timeZone: ZONE,
      // THE THREE THINGS AN ACT NEEDS AND A READ DOES NOT (ticket #224): the
      // chain key for the entry each execution owes, the bundle a confirmed
      // binding lands in, and the thread a receipt is posted to.
      acts: {
        hmacKey: TEST_AUDIT_HMAC_KEY,
        bundle: served.bundle,
        selfChatJid: SELF_CHAT,
      },
    },
    { port: 0 },
  );
  origin = `http://127.0.0.1:${String(api.port)}`;
});

afterAll(async () => {
  await api.close();
  served.bundle.close();
  other.bundle.close();
  await pool.end();
  removeTmpDir(tmp);
});

function freshTwin(): Twin {
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
  twin: Twin,
  script: Script = [],
  /** The seat bus a door turn streams to (ticket #263). */
  events?: SeatEvents,
  /** The day's sessions the local API tells events to (ticket #320). */
  threadSessions?: ThreadSessions,
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
    ...(events === undefined ? {} : { events }),
    ...(threadSessions === undefined ? {} : { threadSessions }),
  };
}

function draftingTurns(): Script {
  return [
    { toolCall: { name: "create_draft", input: { text: DRAFT_TEXT } } },
    { text: "done" },
  ];
}

async function customerWrites(client: pg.Client, twin: Twin): Promise<string> {
  return insertWaEvent(client, twin.dek, {
    twinId: twin.twinId,
    companyId: twin.companyId,
    seatId: twin.seatId,
    chatJid: CUSTOMER,
    senderJid: CUSTOMER,
    fromMe: false,
    messageId: `3EB0-API-${twin.twinId.slice(0, 8)}`,
    text: "¿me mandas 40 cajas para el jueves?",
    pushName: PUSH_NAME,
    occurredAt: MORNING,
  });
}

/** One act, POSTed the way rep-web posts it. */
async function act(
  path: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<{ status: number; body: string }> {
  const res = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: res.status, body: await res.text() };
}

/** The served twin's own draft post — the card every act below is aimed at. */
async function servedDraftPost(): Promise<{ postId: string; draftId: string }> {
  const res = await withClient((client) =>
    client.query<{ id: string; draft_id: string }>(
      `SELECT id, draft_id FROM posts
        WHERE twin_id = $1 AND draft_id IS NOT NULL
        ORDER BY posted_at LIMIT 1`,
      [served.twinId],
    ),
  );
  const row = res.rows[0]!;
  return { postId: row.id, draftId: row.draft_id };
}

/** One request, with whatever headers the claim under test wants. */
async function ask(
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  const res = await fetch(`${origin}${path}`, { headers });
  return { status: res.status, body: await res.text() };
}

/** ...and the ordinary one: rep-web's bearer, the served twin's seat. */
function asRepWeb(seatId: string = served.seatId): Record<string, string> {
  return {
    authorization: `Bearer ${BEARER}`,
    [TWIN_API_SEAT_HEADER]: seatId,
  };
}

const FEED = `${TWIN_API_ROUTES.feed}?now=${encodeURIComponent(READING.toISOString())}`;

describe("what the API serves rep-web (AC 3)", () => {
  it("answers the rail's latest state, with the instant it changed", async () => {
    const res = await ask(TWIN_API_ROUTES.rail, asRepWeb());
    expect(res.status).toBe(200);
    const rail = JSON.parse(res.body) as TwinRailState;
    // The LATEST row, not the first: two rows were planted and the second is
    // the one Conexiones draws.
    expect(rail.status).toBe("dropped");
    expect(rail.at).toBe("2026-08-29T15:00:00.000Z");
  });

  it("never puts the rail row's detail on the wire", async () => {
    // On a `qr` row `detail` is a live pairing token. Planted here so the
    // claim is about a row that has one rather than about a row that does not.
    await withClient(async (client) => {
      await client.query(
        `INSERT INTO rail_status_events (twin_id, status, detail, occurred_at)
         VALUES ($1, 'qr', $2, $3)`,
        [served.twinId, "2@aPairingTokenNobodyShouldSee", new Date()],
      );
    });
    try {
      const res = await ask(TWIN_API_ROUTES.rail, asRepWeb());
      expect(res.body).not.toContain("aPairingTokenNobodyShouldSee");
      expect((JSON.parse(res.body) as TwinRailState).status).toBe("qr");
    } finally {
      await withClient(async (client) => {
        await client.query(
          "DELETE FROM rail_status_events WHERE twin_id = $1 AND status = 'qr'",
          [served.twinId],
        );
      });
    }
  });

  it("answers the feed with its parts opened under the twin's key", async () => {
    const res = await ask(FEED, asRepWeb());
    expect(res.status).toBe(200);
    const page = JSON.parse(res.body) as {
      posts: { parts: { kind: string; body?: string; acts?: string[] }[] }[];
    };
    const drafts = page.posts.flatMap((post) =>
      post.parts.filter((part) => part.kind === "draft"),
    );
    expect(drafts).toHaveLength(1);
    // THE BODY IS THE DRAFT'S OWN, OPENED. Nothing but the lease holder can
    // produce this string from what is on the seam: `drafts.content_enc` is a
    // DEK envelope and rep-web holds no key (ADR-0008, ADR-0010).
    expect(drafts[0]!.body).toBe(DRAFT_TEXT);
    expect(drafts[0]!.acts).toEqual(["tap", "dismiss"]);
  });

  it("serves only this runtime's twin, whatever the feed holds", async () => {
    // The other twin's draft is in the same table under the same schema, and
    // its text is identical — so what proves the scoping is the COUNT, over a
    // read that could not tell the two apart any other way.
    const page = JSON.parse((await ask(FEED, asRepWeb())).body) as {
      posts: unknown[];
    };
    const rows = await withClient((client) =>
      client.query<{ count: string }>("SELECT count(*)::text FROM posts"),
    );
    expect(Number(rows.rows[0]!.count)).toBeGreaterThan(page.posts.length);
  });

  it("pages by the cursor it minted, repeating nothing and skipping nothing", async () => {
    // Walked one post at a time, so the cursor decides every boundary. The
    // expected value is the WHOLE feed read in one page — the read's own
    // answer to a different question — rather than a count this test
    // computed, which is what stops it passing by construction.
    const whole = JSON.parse((await ask(FEED, asRepWeb())).body) as {
      posts: { id: string }[];
    };
    const walked: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < whole.posts.length + 1; page += 1) {
      const url = `${FEED}&limit=1${cursor === undefined ? "" : `&cursor=${encodeURIComponent(cursor)}`}`;
      const next = JSON.parse((await ask(url, asRepWeb())).body) as {
        posts: { id: string }[];
        nextCursor?: string;
      };
      walked.push(...next.posts.map((post) => post.id));
      if (next.nextCursor === undefined) break;
      cursor = next.nextCursor;
    }
    expect(walked).toEqual(whole.posts.map((post) => post.id));
  });
});

describe("what the API refuses (AC 3)", () => {
  it("refuses a bearer that is not rep-web's, before it reads anything", async () => {
    const res = await ask(TWIN_API_ROUTES.rail, {
      authorization: "Bearer not-rep-webs-secret",
      [TWIN_API_SEAT_HEADER]: served.seatId,
    });
    expect(res.status).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: "unauthorized" });
    // ...and it says nothing about the seat it was handed, which is the point
    // of putting this fence first.
    expect(res.body).not.toContain(served.seatId);
  });

  it("refuses a request with no bearer at all", async () => {
    const res = await ask(TWIN_API_ROUTES.rail, {
      [TWIN_API_SEAT_HEADER]: served.seatId,
    });
    expect(res.status).toBe(401);
  });

  it("refuses a seat whose twin is not this runtime's", async () => {
    // The seat is real, its company is real, and its twin is somebody else's.
    // This is the claim spec #214's Testing Decisions make in as many words:
    // "a seat cannot reach another twin's feed".
    const res = await ask(FEED, asRepWeb(other.seatId));
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: "wrong_twin" });
    expect(res.body).not.toContain(DRAFT_TEXT);
  });

  it("refuses the rail read for another twin's seat too", async () => {
    const res = await ask(TWIN_API_ROUTES.rail, asRepWeb(other.seatId));
    expect(res.status).toBe(403);
    // The other twin's rail says `logged_out`; nothing of it comes back.
    expect(res.body).not.toContain("logged_out");
  });

  it("refuses a seat nobody registered, and one that is not a seat id", async () => {
    const unknown = await ask(FEED, asRepWeb(randomUUID()));
    expect(unknown.status).toBe(403);
    expect(JSON.parse(unknown.body)).toEqual({ error: "unknown_seat" });
    const nonsense = await ask(FEED, asRepWeb("mauricio"));
    expect(nonsense.status).toBe(400);
    expect(JSON.parse(nonsense.body)).toEqual({ error: "no_seat" });
  });

  it("refuses a feed read with no «now», rather than taking its own clock", async () => {
    const res = await ask(TWIN_API_ROUTES.feed, asRepWeb());
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: "bad_request" });
  });

  it("refuses a page size the read does not serve, saying nothing of its cap", async () => {
    const res = await ask(`${FEED}&limit=10000`, asRepWeb());
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: "bad_request" });
    // The read's own refusal names its cap and its cursor grammar, which is a
    // map of the store for anybody who got past the bearer.
    expect(res.body).not.toContain("200");
  });

  it("refuses a cursor it did not mint", async () => {
    const res = await ask(`${FEED}&cursor=notacursor`, asRepWeb());
    expect(res.status).toBe(400);
  });

  it("answers no route for a path it does not serve, and for a POST", async () => {
    // A PATH NOTHING IS REGISTERED AT, and it has to come from outside all
    // three route maps: every path this app serves is in `TWIN_API_ROUTES`,
    // `TWIN_API_ASK_ROUTES` or `TWIN_API_ACT_ROUTES`.
    const path = await ask("/libreta", asRepWeb());
    expect(path.status).toBe(404);
    expect(JSON.parse(path.body)).toEqual({ error: "no_route" });
    const posted = await fetch(`${origin}${TWIN_API_ROUTES.rail}`, {
      method: "POST",
      headers: asRepWeb(),
    });
    expect(posted.status).toBe(404);
  });

  it("caches nothing, on an answer and on a refusal alike", async () => {
    // One twin's private state on a loopback port. A proxy, a browser or a
    // fetch cache keeping a copy would be a second home for it.
    for (const [path, headers] of [
      [TWIN_API_ROUTES.rail, asRepWeb()],
      [TWIN_API_ROUTES.rail, { authorization: "Bearer wrong" }],
    ] as const) {
      const res = await fetch(`${origin}${path}`, { headers });
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
  });
});

describe("what an act does through the API (ticket #224)", () => {
  it("discards the draft the card carried, and records the whole of it", async () => {
    const { postId, draftId } = await servedDraftPost();
    const answered = await act(
      TWIN_API_ACT_ROUTES.dismissDraft,
      asRepWeb(),
      { postId },
    );
    expect(answered.status).toBe(200);
    expect(JSON.parse(answered.body)).toEqual({ outcome: "performed" });

    const written = await withClient(async (client) => {
      const acts = await client.query<{
        id: string;
        verb: string;
        seat_id: string;
        twin_id: string;
        post_id: string;
      }>(
        "SELECT id, verb, seat_id, twin_id, post_id FROM dashboard_acts WHERE twin_id = $1",
        [served.twinId],
      );
      const dismissal = await client.query<{
        source_event_id: string | null;
        dashboard_act_id: string | null;
      }>(
        "SELECT source_event_id, dashboard_act_id FROM draft_dismissals WHERE draft_id = $1",
        [draftId],
      );
      const runs = await client.query<{
        trigger_kind: string;
        trigger_mechanism: string;
        disposition: string;
        lane: string;
        iterations: number;
        tokens_input: number;
        tokens_output: number;
        tool_names: string[];
        trigger_ref: string;
      }>(
        `SELECT trigger_kind, trigger_mechanism, disposition, lane, iterations,
                tokens_input, tokens_output, tool_names, trigger_ref
           FROM executions WHERE twin_id = $1 AND trigger_kind = 'dashboard_act'`,
        [served.twinId],
      );
      const chained = await client.query<{
        caller: string;
        action: string;
        outcome: string;
        ref: string;
      }>(
        `SELECT caller, action, outcome, ref FROM audit_chain
          WHERE action = 'execution' AND ref LIKE '%dashboard_act%' ORDER BY id`,
      );
      return { acts, dismissal, runs, chained };
    });

    // THE ACT ROW IS THE EVIDENCE, and its scope came off the registry rather
    // than off the request (ADR-0003, ADR-0035).
    expect(written.acts.rows).toHaveLength(1);
    const actRow = written.acts.rows[0]!;
    expect({
      verb: actRow.verb,
      seat_id: actRow.seat_id,
      twin_id: actRow.twin_id,
      post_id: actRow.post_id,
    }).toEqual({
      verb: "dismiss_draft",
      seat_id: served.seatId,
      twin_id: served.twinId,
      post_id: postId,
    });
    // ...AND THE DISMISSAL NAMES IT, on the other of the two evidence columns:
    // exactly one is set, which `draft_dismissals_one_evidence_check` refuses
    // to let be otherwise.
    expect(written.dismissal.rows[0]).toEqual({
      source_event_id: null,
      dashboard_act_id: actRow.id,
    });
    // ONE EXECUTION, WITH NO MODEL IN IT (ADR-0014 as amended).
    expect(written.runs.rows).toHaveLength(1);
    const run = written.runs.rows[0]!;
    expect(run.trigger_mechanism).toBe("request");
    expect(run.disposition).toBe("acted");
    expect(run.lane).toBe("realtime");
    expect(run.iterations).toBe(0);
    expect(run.tokens_input).toBe(0);
    expect(run.tokens_output).toBe(0);
    expect(run.tool_names).toEqual([]);
    // The reference names the twin, the act and the post — and no chat, so
    // the store's own content-free CHECK admits it (ADR-0020).
    expect(run.trigger_ref).toContain(`twin:${served.twinId}`);
    expect(run.trigger_ref).toContain(`post:${postId}`);
    expect(run.trigger_ref).not.toContain("@");
    // ...AND ONE CHAIN ENTRY BESIDE IT, from the execution runtime.
    expect(written.chained.rows).toEqual([
      {
        caller: "execution",
        action: "execution",
        outcome: "acted",
        ref: run.trigger_ref + " instructions:deterministic",
      },
    ]);
  });

  it("posts the receipt into the rep's own thread, in the thread's grammar", async () => {
    // «ONE ACT, TWO SURFACES» FROM THE OUTPUT SIDE: the rep pressed a button
    // and the twin says so where it says everything else. The sentence is
    // code's (ADR-0037's receipts rule) and it wears the thread's frame,
    // because the thread is what renders it.
    const posted = await withClient((client) =>
      client.query<{ kind: string; content_enc: Buffer }>(
        `SELECT n.kind, n.content_enc
           FROM notices n
           JOIN send_commands sc ON sc.payload_ref = 'notice:' || n.id
          WHERE n.twin_id = $1 AND n.kind = 'dismissal_ack'`,
        [served.twinId],
      ),
    );
    expect(posted.rows).toHaveLength(1);
    const text = Buffer.from(
      served.dek.decrypt(posted.rows[0]!.content_enc),
    ).toString("utf8");
    // BYTE FOR BYTE THE THREAD'S OWN POST (AC 2: "the thread renders the
    // dismissal exactly as a prose «no va» does"). The oracle is the thread's
    // renderer, so this is not a claim about a sigil being present — it is the
    // claim that the two surfaces produce one post.
    expect(text).toBe(renderReceiptPost(RECEIPTS.dismissed));
    // ...and the post primitive carries the same act as a `receipt` part, so
    // the DASHBOARD renders it without the frame (#220).
    const parts = await withClient((client) =>
      client.query<{ parts_enc: Buffer | null }>(
        `SELECT p.parts_enc FROM posts p
           JOIN notices n ON n.id = p.notice_id
          WHERE n.kind = 'dismissal_ack' AND p.twin_id = $1`,
        [served.twinId],
      ),
    );
    expect(parts.rows).toHaveLength(1);
    expect(parts.rows[0]!.parts_enc).not.toBeNull();
  });

  it("answers «already» to a second press of the same button", async () => {
    const { postId } = await servedDraftPost();
    const again = await act(TWIN_API_ACT_ROUTES.dismissDraft, asRepWeb(), {
      postId,
    });
    expect(JSON.parse(again.body)).toEqual({ outcome: "already" });
    // IDEMPOTENT AND STILL RECORDED: the rep really did press the button
    // twice, so there are two act rows and two executions — and exactly one
    // dismissal, because the row it would write already exists.
    const counts = await withClient((client) =>
      client.query<{ acts: number; dismissals: number }>(
        `SELECT (SELECT count(*)::int FROM dashboard_acts WHERE twin_id = $1) AS acts,
                (SELECT count(*)::int FROM draft_dismissals dd
                   JOIN drafts d ON d.id = dd.draft_id
                  WHERE d.twin_id = $1) AS dismissals`,
        [served.twinId],
      ),
    );
    expect(counts.rows[0]).toEqual({ acts: 2, dismissals: 1 });
  });

  it("refuses an act on a post of another twin, and writes no act row for it", async () => {
    // THE TWIN IS THE FENCE, read from the registry rather than taken from the
    // request — so the post simply does not resolve, and nothing is recorded
    // because there was no card to act on.
    const foreign = await withClient((client) =>
      client.query<{ id: string }>(
        "SELECT id FROM posts WHERE twin_id = $1 LIMIT 1",
        [other.twinId],
      ),
    );
    const before = await withClient((client) =>
      client.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM dashboard_acts",
      ),
    );
    const answered = await act(TWIN_API_ACT_ROUTES.dismissDraft, asRepWeb(), {
      postId: foreign.rows[0]!.id,
    });
    expect(JSON.parse(answered.body)).toEqual({ outcome: "refused" });
    const after = await withClient((client) =>
      client.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM dashboard_acts",
      ),
    );
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
  });

  it("refuses a retraction with no line, as a bad request rather than a refusal", async () => {
    // The two are different things and the closed refusal set already draws
    // the line: `bad_request` is a parameter the act cannot take, `refused` is
    // an act the store declined. A card's Retirar button always carries its
    // number.
    const { postId } = await servedDraftPost();
    const answered = await act(TWIN_API_ACT_ROUTES.retractLine, asRepWeb(), {
      postId,
    });
    expect(answered.status).toBe(400);
    expect(JSON.parse(answered.body)).toEqual({ error: "bad_request" });
  });

  it("refuses a body that is not an act's, and a line that is not a line", async () => {
    const { postId } = await servedDraftPost();
    for (const body of [
      "not json at all",
      JSON.stringify([postId]),
      JSON.stringify({ postId: "not-a-uuid" }),
      JSON.stringify({}),
      JSON.stringify({ postId, lineIndex: 0 }),
      JSON.stringify({ postId, lineIndex: 1.5 }),
      JSON.stringify({ postId, lineIndex: "1" }),
    ]) {
      const answered = await act(
        TWIN_API_ACT_ROUTES.retractLine,
        asRepWeb(),
        body,
      );
      expect(`${body}: ${answered.status}`).toBe(`${body}: 400`);
    }
  });

  it("refuses an act to a read's path, and a read to an act's", async () => {
    // THE METHOD DECIDES WHICH MAP THE PATH IS LOOKED UP IN, so the wrong
    // method is no route rather than a method error — which is what keeps a
    // caller the bearer already turned away from mapping the surface.
    const { postId } = await servedDraftPost();
    const posted = await act(TWIN_API_ROUTES.feed, asRepWeb(), { postId });
    expect(posted.status).toBe(404);
    expect(JSON.parse(posted.body)).toEqual({ error: "no_route" });
    const got = await ask(TWIN_API_ACT_ROUTES.dismissDraft, asRepWeb());
    expect(got.status).toBe(404);
    expect(JSON.parse(got.body)).toEqual({ error: "no_route" });
  });

  it("refuses an act before it reads a body, when the bearer is not rep-web's", async () => {
    const { postId } = await servedDraftPost();
    const answered = await act(
      TWIN_API_ACT_ROUTES.dismissDraft,
      {
        authorization: "Bearer not-rep-webs",
        [TWIN_API_SEAT_HEADER]: served.seatId,
      },
      { postId },
    );
    expect(answered.status).toBe(401);
    expect(JSON.parse(answered.body)).toEqual({ error: "unauthorized" });
  });

  it("refuses an act for a seat whose twin is not this runtime's", async () => {
    const { postId } = await servedDraftPost();
    const answered = await act(
      TWIN_API_ACT_ROUTES.dismissDraft,
      asRepWeb(other.seatId),
      { postId },
    );
    expect(answered.status).toBe(403);
    expect(JSON.parse(answered.body)).toEqual({ error: "wrong_twin" });
  });

  it("serves no act at all on a runtime started for the reads alone", async () => {
    // A server with no key, no bundle and no thread has nothing to post a
    // receipt into, so the honest answer is that the door is not there — not
    // an `unavailable`, which would say the act might have happened.
    const readsOnly = await startLocalApi(
      { db: pool, twinId: served.twinId, dek: served.dek, bearer: BEARER },
      { port: 0 },
    );
    try {
      const res = await fetch(
        `http://127.0.0.1:${String(readsOnly.port)}${TWIN_API_ACT_ROUTES.dismissDraft}`,
        {
          method: "POST",
          headers: {
            ...asRepWeb(),
            "content-type": "application/json",
          },
          body: JSON.stringify({ postId: randomUUID() }),
        },
      );
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "no_route" });
    } finally {
      await readsOnly.close();
    }
  });
});

describe("what the server refuses to be", () => {
  it("will not start with an empty bearer", async () => {
    await expect(
      startLocalApi(
        { db: pool, twinId: served.twinId, dek: served.dek, bearer: "  " },
        { port: 0 },
      ),
    ).rejects.toThrow(/bearer secret/);
  });

  it("will not bind anything but loopback", async () => {
    // The bearer is the authority and the bind is the blast radius: a runtime
    // listening on a routable interface puts an unsealing service on a
    // network ADR-0002 says nothing about.
    await expect(
      startLocalApi(
        {
          db: pool,
          twinId: served.twinId,
          dek: served.dek,
          bearer: BEARER,
        },
        { port: 0, bindHost: "0.0.0.0" },
      ),
    ).rejects.toThrow(/loopback only/);
  });
});

/* ── LINK DAY'S TWO READS AND ITS TWO WRITES (ticket #223) ────────────────
   The API is the ONE new seam of this slice (spec #214's Testing Decisions),
   so the four things #223 added to it are driven over the wire from the same
   real runtime: the link read that is the only door to a credential, the
   directory read that opens sealed names, the link ask that writes the
   plane's `pairing_code` row, and the two scope switches that write the
   allowlist row, the request row, the act row and the chain entry.

   EVERY ONE OF THEM PLANTS AND THEN CLEANS UP, because this file's other
   describes assert over the rail's own history and over `dashboard_acts`. */

/** A name, sealed under the served twin's key exactly as the plane seals one. */
function sealedName(name: string): Buffer {
  return Buffer.from(served.dek.encrypt(Buffer.from(name, "utf8")));
}

const GARZA = "Sra. Garza";
const PROVEEDORES = "Proveedores CDMX";

/**
 * A FRESH SET OF ADDRESSES PER PLANT, because a directory row a scope act has
 * named cannot be deleted afterwards: `dashboard_acts.chat_directory_id` is a
 * foreign key and that table refuses DELETE by trigger (it is class-2
 * evidence). So `clearDirectory` removes what it can and every plant uses
 * addresses nothing has used before, which is also what `chat_directory`'s own
 * UNIQUE (twin, chat) demands.
 */
let planted = 0;

/** Four directory rows: one of each kind the store can hold. */
async function plantDirectory(): Promise<{
  dm: string;
  dmChat: string;
  group: string;
  groupChat: string;
  self: string;
  other: string;
}> {
  planted += 1;
  const suffix = String(600 + planted);
  const dmChat = `52155505${suffix}@s.whatsapp.net`;
  const groupChat = `52155509${suffix}@g.us`;
  return await withClient(async (client) => {
    const rows = await client.query<{ id: string; kind: string }>(
      `INSERT INTO chat_directory
         (twin_id, chat_jid, kind, name_enc, last_activity_at)
       VALUES ($1, $2, 'dm', $3, $7),
              ($1, $4, 'group', $8, $7),
              ($1, $5, 'self', NULL, $7),
              ($1, $6, 'other', NULL, $7)
       RETURNING id, kind`,
      [
        served.twinId,
        dmChat,
        sealedName(GARZA),
        groupChat,
        `52155500${suffix}@s.whatsapp.net`,
        `status${suffix}@broadcast`,
        new Date("2026-08-29T15:30:00.000Z"),
        sealedName(PROVEEDORES),
      ],
    );
    const byKind = new Map(rows.rows.map((row) => [row.kind, row.id]));
    await client.query(
      "INSERT INTO scope_allowlist (twin_id, chat_jid) VALUES ($1, $2)",
      [served.twinId, dmChat],
    );
    return {
      dm: byKind.get("dm")!,
      dmChat,
      group: byKind.get("group")!,
      groupChat,
      self: byKind.get("self")!,
      other: byKind.get("other")!,
    };
  });
}

async function clearDirectory(): Promise<void> {
  await withClient(async (client) => {
    await client.query("DELETE FROM scope_allowlist WHERE twin_id = $1", [
      served.twinId,
    ]);
    // EVERY ROW NO ACT NAMES. An act row is immutable evidence, so a row it
    // points at outlives the test that planted it — and `planted` is what
    // keeps the next plant from colliding with it.
    await client.query(
      `DELETE FROM chat_directory
        WHERE twin_id = $1
          AND NOT EXISTS (
                SELECT 1 FROM dashboard_acts a
                 WHERE a.chat_directory_id = chat_directory.id)`,
      [served.twinId],
    );
    await client.query(
      "DELETE FROM plane_requests WHERE twin_id = $1 AND kind <> 'pairing_code'",
      [served.twinId],
    );
  });
}

/**
 * How many `scope_change` entries the chain holds.
 *
 * COUNTED AND COMPARED rather than emptied between tests: the chain is
 * append-only by trigger (ADR-0020), so «one more than before» is the only
 * shape an assertion about it can take.
 */
async function scopeEntriesOn(client: pg.Client): Promise<number> {
  const rows = await client.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM audit_chain WHERE action = 'scope_change'",
  );
  return rows.rows[0]!.n;
}

async function scopeEntries(): Promise<number> {
  return await withClient((client) => scopeEntriesOn(client));
}

/** One rail row, appended, and the id so it can be taken back off. */
async function plantRail(
  status: string,
  detail: string,
  at: Date,
): Promise<string> {
  return await withClient(async (client) => {
    const row = await client.query<{ id: string }>(
      `INSERT INTO rail_status_events (twin_id, status, detail, occurred_at)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [served.twinId, status, detail, at],
    );
    return row.rows[0]!.id;
  });
}

async function removeRail(id: string): Promise<void> {
  await withClient(async (client) => {
    await client.query("DELETE FROM rail_status_events WHERE id = $1", [id]);
  });
}

const QR_PAYLOAD = "2@aPairingTokenNobodyShouldSee";
const PAIRING_CODE = "K7RDM2QX";

describe("the link read — the one door to a credential (ticket #223)", () => {
  it("hands over a `qr` row's payload, which `/rail` refuses to", async () => {
    const planted = await plantRail(
      "qr",
      QR_PAYLOAD,
      new Date("2026-08-29T17:10:00.000Z"),
    );
    try {
      const link = await ask(TWIN_API_ROUTES.link, asRepWeb());
      expect(link.status).toBe(200);
      expect(JSON.parse(link.body)).toEqual({
        status: "qr",
        at: "2026-08-29T17:10:00.000Z",
        // THE SESSION THIS ROW OPENED, which is the instant the page counts
        // ADR-0031's window from (ticket #241).
        windowOpenedAt: "2026-08-29T17:10:00.000Z",
        qr: QR_PAYLOAD,
        // NOTHING IS ON ITS WAY, which the page needs to know as much as it
        // needs the credential: the difference between «se venció» and «ya lo
        // pedimos» is this field (Codex r2).
        ask: "none",
      });
      // ...AND THE OTHER READ OF THE SAME ROW STILL DOES NOT. Two reads, one
      // row, and the difference is a column `dito_rep_web` holds no privilege
      // on at all (`grants.ts` argues the link-hijack).
      const rail = await ask(TWIN_API_ROUTES.rail, asRepWeb());
      expect(rail.body).not.toContain(QR_PAYLOAD);
    } finally {
      await removeRail(planted);
    }
  });

  it("hands over a `pairing_code` row's eight characters the same way", async () => {
    const planted = await plantRail(
      "pairing_code",
      PAIRING_CODE,
      new Date("2026-08-29T17:20:00.000Z"),
    );
    try {
      const link = await ask(TWIN_API_ROUTES.link, asRepWeb());
      expect(JSON.parse(link.body)).toMatchObject({
        status: "pairing_code",
        pairingCode: PAIRING_CODE,
        windowOpenedAt: "2026-08-29T17:20:00.000Z",
      });
    } finally {
      await removeRail(planted);
    }
  });

  it("serves the code for its whole session beside the newest QR", async () => {
    // THE FAILURE THIS EXISTS FOR (ticket #241; boundary #225, F10 and F11).
    // The plane re-issues its QR every twenty seconds, so a read of the LATEST
    // row alone served the pairing code for twenty seconds and then replaced
    // it with a QR — both codes served on the rig went unread. The read
    // answers the session: the newest of each door, and the instant the
    // session's first row opened its window.
    const opened = new Date("2026-08-29T18:00:00.000Z");
    const planted = [
      await plantRail("pairing_code", PAIRING_CODE, opened),
      await plantRail("qr", "2@supersededByTheNextOne", new Date("2026-08-29T18:00:20.000Z")),
      await plantRail("qr", QR_PAYLOAD, new Date("2026-08-29T18:00:40.000Z")),
    ];
    try {
      const link = await ask(TWIN_API_ROUTES.link, asRepWeb());
      expect(JSON.parse(link.body)).toEqual({
        // The rail's LATEST word is the third row; the window's clock is the
        // first row's, forty seconds earlier.
        status: "qr",
        at: "2026-08-29T18:00:40.000Z",
        windowOpenedAt: "2026-08-29T18:00:00.000Z",
        qr: QR_PAYLOAD,
        pairingCode: PAIRING_CODE,
        ask: "none",
      });
      // ONE QR PER DOOR: the superseded payload is not on the wire at all,
      // because what the page renders is the newest of each kind.
      expect(link.body).not.toContain("supersededByTheNextOne");
    } finally {
      for (const id of planted) await removeRail(id);
    }
  });

  it("opens the window after the rail's last non-credential row", async () => {
    // A STALE SESSION IS NOT THE SESSION. The suite's own history ends in
    // `dropped`, so this plants a whole earlier session, ends it with a second
    // `dropped`, and opens a new one: a read anchored on the FIRST credential
    // row it can find would hand the page a window that shut an hour ago and a
    // rep an expired screen with a live code on the rail.
    const planted = [
      await plantRail("qr", "2@theSessionBeforeThisOne", new Date("2026-08-29T19:00:00.000Z")),
      await plantRail("dropped", "", new Date("2026-08-29T19:03:00.000Z")),
      await plantRail("qr", QR_PAYLOAD, new Date("2026-08-29T19:10:00.000Z")),
      await plantRail("qr", QR_PAYLOAD, new Date("2026-08-29T19:10:20.000Z")),
    ];
    try {
      const link = await ask(TWIN_API_ROUTES.link, asRepWeb());
      expect(JSON.parse(link.body)).toMatchObject({
        windowOpenedAt: "2026-08-29T19:10:00.000Z",
        qr: QR_PAYLOAD,
      });
      expect(link.body).not.toContain("theSessionBeforeThisOne");
    } finally {
      for (const id of planted) await removeRail(id);
    }
  });

  it("leaves a session the plane never closed behind, once its window is out", async () => {
    // THE FAILURE THIS EXISTS FOR (the two-axis review's Spec axis).
    // `rail.HandleShutdown` records `dropped` only from a LINKED rail, so a
    // plane stopped inside a link window leaves its credential rows with no
    // boundary row after them — and a session read that took the first
    // credential row it could find would anchor the NEXT plane's window an
    // hour in the past. That page says «se venció» over a live QR for ever,
    // and «Generar otro» cannot clear it. A silence longer than one window is
    // the boundary the plane did not write.
    const abandoned = new Date("2026-08-29T20:00:00.000Z");
    const opened = new Date("2026-08-29T21:00:00.000Z");
    const planted = [
      await plantRail("qr", "2@theSessionNobodyClosed", abandoned),
      await plantRail("qr", "2@alsoTheSessionNobodyClosed", new Date(abandoned.getTime() + 20_000)),
      await plantRail("qr", QR_PAYLOAD, opened),
    ];
    try {
      const link = await ask(TWIN_API_ROUTES.link, asRepWeb());
      expect(JSON.parse(link.body)).toMatchObject({
        windowOpenedAt: "2026-08-29T21:00:00.000Z",
        qr: QR_PAYLOAD,
      });
      expect(link.body).not.toContain("SessionNobodyClosed");
    } finally {
      for (const id of planted) await removeRail(id);
    }
  });

  it("holds the anchor still while the plane keeps writing rows", async () => {
    // CODEX r1, AND IT IS THE OTHER DIRECTION OF THE SAME DEFECT. A cut-off
    // measured back from the NEWEST row moves as the plane writes: over a
    // restart inside one window — the abandoned session's rows and the new
    // one's, no gap between them longer than a window — the anchor would
    // slide forward row by row, and a countdown that slides forward hands the
    // rep a credential whose window has passed. The anchor is the run's own
    // first row, so it does not move; the page's own arithmetic then says
    // «se venció» until the plane's current session ends and writes the
    // boundary row that clears it.
    const opened = new Date("2026-08-29T22:00:00.000Z");
    const at = (seconds: number) =>
      new Date(opened.getTime() + seconds * 1000);
    const planted = [
      await plantRail("qr", "2@beforeTheRestart", opened),
      await plantRail("pairing_code", "AAAA1111", at(50)),
      await plantRail("qr", "2@stillBeforeTheRestart", at(60)),
      await plantRail("qr", "2@afterTheRestart", at(100)),
      await plantRail("qr", "2@aRefreshAfterThat", at(160)),
      await plantRail("qr", QR_PAYLOAD, at(180)),
    ];
    try {
      const link = await ask(TWIN_API_ROUTES.link, asRepWeb());
      expect(JSON.parse(link.body)).toMatchObject({
        windowOpenedAt: opened.toISOString(),
      });
    } finally {
      for (const id of planted) await removeRail(id);
    }
  });

  it("answers from one snapshot, so a session opened mid-read is never half-seen", async () => {
    // CODEX r2, AND THE FAILURE IS THE WORST SHAPE THIS PAGE HAS. The read
    // asks four questions in four statements and the plane writes between
    // them: a new session opening — with its ask settling — after the first
    // statement would answer with the NEW credentials on the OLD session's
    // anchor and nothing pending, which the page renders as «se venció». That
    // screen carries no refresh, so the code the rep just asked for would sit
    // unread on the rail until they pressed again.
    //
    // DRIVEN AT THE STATEMENTS AND NOT OVER THE WIRE, because the claim is
    // about the snapshot the read holds: over HTTP the interleaving is a
    // timing accident, and here it is a committed write from a second
    // connection at a chosen point inside the snapshot.
    const abandoned = new Date("2026-08-29T23:00:00.000Z");
    const planted = [await plantRail("qr", "2@theAbandonedSession", abandoned)];
    try {
      await withClient(async (reader) => {
        await withReadSnapshot(reader, async () => {
          const opened = await readLinkSession(
            reader,
            served.twinId,
            LINK_ASK_WINDOW_SECONDS,
          );
          expect(opened?.windowOpenedAt).toEqual(abandoned);
          // The plane opens its next session on another connection, committed
          // while this snapshot is open.
          planted.push(await plantRail("qr", QR_PAYLOAD, new Date()));
          const again = await readLinkSession(
            reader,
            served.twinId,
            LINK_ASK_WINDOW_SECONDS,
          );
          expect(again?.windowOpenedAt).toEqual(abandoned);
        });
        // ...AND THE NEXT READING SEES THE NEW SESSION WHOLE, which is what
        // makes the snapshot a consistency rule rather than a stale page: the
        // page reloads every ten seconds and every reload is a fresh one.
        const next = await readLinkSession(
          reader,
          served.twinId,
          LINK_ASK_WINDOW_SECONDS,
        );
        expect(next?.windowOpenedAt).not.toEqual(abandoned);
      });
    } finally {
      for (const id of planted) await removeRail(id);
    }
  });

  it("hands over NOTHING on a `linked` row, whatever the column still holds", async () => {
    // THE FAILURE THIS EXISTS FOR. The plane leaves whatever it last wrote in
    // `detail`, so a read that served it by status-blind rule would let the
    // link page draw a QR beside «tu número quedó vinculado» — a credential
    // for a socket that is not waiting for one. The session's own rows are
    // planted BEFORE the `linked` row here, which is the shape a real link
    // has: the QR that was scanned is still on the rail.
    const planted = [
      await plantRail("qr", QR_PAYLOAD, new Date("2026-08-29T17:29:00.000Z")),
      await plantRail("linked", QR_PAYLOAD, new Date("2026-08-29T17:30:00.000Z")),
    ];
    try {
      const link = await ask(TWIN_API_ROUTES.link, asRepWeb());
      expect(link.body).not.toContain(QR_PAYLOAD);
      expect(JSON.parse(link.body)).toEqual({
        status: "linked",
        at: "2026-08-29T17:30:00.000Z",
        windowOpenedAt: null,
        ask: "none",
      });
    } finally {
      for (const id of planted) await removeRail(id);
    }
  });

  it("refuses it for a seat whose twin is not this runtime's", async () => {
    const res = await ask(TWIN_API_ROUTES.link, asRepWeb(other.seatId));
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: "wrong_twin" });
  });
});

describe("the directory read — names opened, addresses withheld (ticket #223)", () => {
  it("opens the sealed names and never puts a chat's address on the wire", async () => {
    const rows = await plantDirectory();
    try {
      const res = await ask(TWIN_API_ROUTES.directory, asRepWeb());
      expect(res.status).toBe(200);
      const answer = JSON.parse(res.body) as {
        chats: {
          id: string;
          kind: string;
          name: string | null;
          inScope: boolean;
        }[];
      };
      // THE NAME IS OPENED, which nothing but the lease holder can do:
      // `name_enc` is a DEK envelope and rep-web holds no key (ADR-0008).
      const names = answer.chats.map((chat) => chat.name);
      expect(names).toContain(GARZA);
      expect(names).toContain(PROVEEDORES);
      // ...AND NO ADDRESS CROSSES. The row's own id is the handle every switch
      // names, so no page, form or log holds a customer's number (ADR-0004).
      expect(res.body).not.toContain(rows.dmChat);
      expect(res.body).not.toContain("@g.us");
      expect(res.body).not.toContain("@s.whatsapp.net");
      // `inScope` IS THE GUARD'S OWN QUESTION, answered over the same
      // allowlist the socket reads.
      expect(
        answer.chats.find((chat) => chat.id === rows.dm)?.inScope,
      ).toBe(true);
      expect(
        answer.chats.find((chat) => chat.id === rows.group)?.inScope,
      ).toBe(false);
    } finally {
      await clearDirectory();
    }
  });

  it("lists people and groups, and never the twin thread or a broadcast", async () => {
    const rows = await plantDirectory();
    try {
      const answer = JSON.parse(
        (await ask(TWIN_API_ROUTES.directory, asRepWeb())).body,
      ) as { chats: { id: string; kind: string }[] };
      expect([...new Set(answer.chats.map((chat) => chat.kind))].toSorted()).toEqual(
        ["dm", "group"],
      );
      // `self` IS IN SCOPE STRUCTURALLY — the guard answers `chat == self`
      // before it reads the allowlist at all — so a switch on it would be a
      // control that cannot change anything. `other` is an address server and
      // not a conversation (`directory.ts` argues both).
      const ids = answer.chats.map((chat) => chat.id);
      expect(ids).not.toContain(rows.self);
      expect(ids).not.toContain(rows.other);
    } finally {
      await clearDirectory();
    }
  });

  it("never offers WhatsApp's own chat, which is an address and not a person", async () => {
    // THE RIG'S OWN FAILURE (boundary #225, F32): `0@s.whatsapp.net` is where
    // WhatsApp's announcements arrive from, it was kinded `dm`, and so it stood
    // on the scoping page under «Chat por conocer» — where it was marked, and
    // its fill then refused `no_lid`. The plane reads user `0` as `other` now
    // (`plane/directory`), and `other` is a kind this read does not list.
    const system = await withClient(async (client) => {
      const res = await client.query<{ id: string }>(
        `INSERT INTO chat_directory (twin_id, chat_jid, kind, name_enc)
         VALUES ($1, '0@s.whatsapp.net', 'other', NULL) RETURNING id`,
        [served.twinId],
      );
      return res.rows[0]!.id;
    });
    try {
      const answer = JSON.parse(
        (await ask(TWIN_API_ROUTES.directory, asRepWeb())).body,
      ) as { chats: { id: string }[] };
      expect(answer.chats.map((chat) => chat.id)).not.toContain(system);
    } finally {
      await clearDirectory();
    }
  });

  it("carries the fill's progress, which is what the rep's sync view renders", async () => {
    const rows = await plantDirectory();
    try {
      await withClient(async (client) => {
        await client.query(
          `UPDATE chat_directory
              SET fill_pages = 3, fill_oldest_at = $2,
                  fill_end_of_transfer = 'COMPLETE_AND_NO_MORE_MESSAGE_REMAIN_ON_PRIMARY',
                  fill_last_at = $3,
                  -- HOW THE ATTEMPT ENDED, which is what lets Inicio's card
                  -- NAME the chats Dito reads from today (#255, F39): the word
                  -- is the plane's and the name is sealed, so this read is the
                  -- only one that can pair them.
                  fill_stopped_at = $3, fill_stopped_by = 'no_lid'
            WHERE id = $1`,
          [
            rows.dm,
            new Date("2026-06-01T00:00:00.000Z"),
            new Date("2026-08-29T16:00:00.000Z"),
          ],
        );
      });
      const answer = JSON.parse(
        (await ask(TWIN_API_ROUTES.directory, asRepWeb())).body,
      ) as {
        chats: {
          id: string;
          fill: {
            pages: number;
            oldestAt: string | null;
            endOfTransfer: string | null;
            stoppedBy: string | null;
          };
        }[];
      };
      expect(answer.chats.find((chat) => chat.id === rows.dm)?.fill).toEqual({
        pages: 3,
        oldestAt: "2026-06-01T00:00:00.000Z",
        endOfTransfer: "COMPLETE_AND_NO_MORE_MESSAGE_REMAIN_ON_PRIMARY",
        lastAt: "2026-08-29T16:00:00.000Z",
        stoppedBy: "no_lid",
      });
      // ...AND A ROW THE PLANE HAS STAMPED NOTHING ON SAYS SO, because an
      // absent marker is the running state and never a word (`fill.ts`).
      expect(
        answer.chats.find((chat) => chat.id === rows.group)?.fill.stoppedBy,
      ).toBeNull();
    } finally {
      await clearDirectory();
    }
  });

  it("serves only this runtime's twin", async () => {
    const rows = await plantDirectory();
    try {
      await withClient(async (client) => {
        await client.query(
          `INSERT INTO chat_directory (twin_id, chat_jid, kind, name_enc)
           VALUES ($1, $2, 'dm', $3)`,
          [other.twinId, "5215550777@s.whatsapp.net", sealedName("Nobody")],
        );
      });
      const answer = JSON.parse(
        (await ask(TWIN_API_ROUTES.directory, asRepWeb())).body,
      ) as { chats: { id: string; name: string | null }[] };
      const ids = answer.chats.map((chat) => chat.id);
      expect(ids).toContain(rows.dm);
      expect(ids).toContain(rows.group);
      // ...AND NOTHING OF THE OTHER TWIN'S, whose row is in the same table
      // under the same schema with a name only its own key opens.
      expect(answer.chats.map((chat) => chat.name)).not.toContain("Nobody");
      const refused = await ask(
        TWIN_API_ROUTES.directory,
        asRepWeb(other.seatId),
      );
      expect(refused.status).toBe(403);
    } finally {
      await withClient(async (client) => {
        await client.query("DELETE FROM chat_directory WHERE twin_id = $1", [
          other.twinId,
        ]);
      });
      await clearDirectory();
    }
  });
});

describe("the link ask — the plane's `pairing_code` row (ticket #223)", () => {
  it("writes exactly one request carrying the runtime's OWN digits", async () => {
    const asked = await act(TWIN_API_ASK_ROUTES.link, asRepWeb(), undefined);
    expect(asked.status).toBe(200);
    expect(JSON.parse(asked.body)).toEqual({ outcome: "performed" });
    const rows = await withClient((client) =>
      client.query<{
        kind: string;
        chat_jid: string | null;
        parameters: { phone?: string };
      }>(
        `SELECT kind, chat_jid, parameters FROM plane_requests
          WHERE twin_id = $1 AND kind = 'pairing_code'`,
        [served.twinId],
      ),
    );
    expect(rows.rows).toHaveLength(1);
    // THE SEAT'S OWN NUMBER, FROM THE RUNTIME'S SELF CHAT, and never a body
    // value: a `phone` a caller could name would let anybody past the bearer
    // ask the plane to pair somebody else's number.
    expect(rows.rows[0]).toEqual({
      kind: "pairing_code",
      chat_jid: null,
      parameters: { phone: SELF_CHAT.split("@")[0] },
    });
  });

  it("...and the link read then says a credential is on its way", async () => {
    // THE FIELD THE PAGE'S SIXTH STATE RESTS ON (Codex r2). The rail still
    // holds whatever row it held before the ask, so «is one coming» cannot be
    // read off the rail at all — and without it a rep who pressed «Generar
    // otro» was shown «se venció» for the whole life of the replacement, on a
    // screen that does not reload.
    const link = await ask(TWIN_API_ROUTES.link, asRepWeb());
    expect(JSON.parse(link.body)).toMatchObject({ ask: "waiting" });
  });

  it("answers «already» to a second ask while the first is unsettled", async () => {
    // ONE LIVE ASK AT A TIME. The plane serves requests one at a time and a
    // code lives ~160 seconds, so a queued second ask would produce a second
    // credential the moment the first expired — with the rep looking at a page
    // that shows one of them.
    const again = await act(TWIN_API_ASK_ROUTES.link, asRepWeb(), undefined);
    expect(JSON.parse(again.body)).toEqual({ outcome: "already" });
    const count = await withClient((client) =>
      client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM plane_requests
          WHERE twin_id = $1 AND kind = 'pairing_code'`,
        [served.twinId],
      ),
    );
    expect(count.rows[0]!.n).toBe(1);
  });

  it("...but not to one whose request went stale unserved (Codex r1)", async () => {
    // A REQUEST OLDER THAN THE CREDENTIAL'S OWN WINDOW IS NOT A LIVE ASK. The
    // plane starts its ~160-second link window at connection time and exits on
    // its own QR-channel timeout, so a rep who spent that window reading the
    // contract — or whose plane was simply down — leaves a request nothing will
    // ever settle. An unbounded «is one unsettled» answered `already` for ever
    // and «Generar otro» became a button that could not work.
    await withClient(async (client) => {
      await client.query(
        `UPDATE plane_requests
            SET requested_at = now() - interval '1 hour'
          WHERE twin_id = $1 AND kind = 'pairing_code'`,
        [served.twinId],
      );
    });
    const fresh = await act(TWIN_API_ASK_ROUTES.link, asRepWeb(), undefined);
    expect(JSON.parse(fresh.body)).toEqual({ outcome: "performed" });
    const count = await withClient((client) =>
      client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM plane_requests
          WHERE twin_id = $1 AND kind = 'pairing_code'`,
        [served.twinId],
      ),
    );
    // TWO ROWS, and the stale one is left exactly as it is: a request row is
    // the plane's own record of what it was asked, and nothing here rewrites
    // one it did not settle.
    expect(count.rows[0]!.n).toBe(2);
  });

  it("says an ask the plane has not taken is untaken, and a press over it asks again (#403)", async () => {
    // THE RIG'S HANG: a plane that is not running takes nothing, and the page
    // said «Pidiendo tu código» for the whole window. Past
    // `LINK_ASK_UNTAKEN_SECONDS` the read says so and the ask stops being
    // live — a press answered `already` would be the same dead button.
    await withClient(async (client) => {
      await client.query(
        `UPDATE plane_requests
            SET requested_at = now() - make_interval(secs => $2::double precision)
          WHERE twin_id = $1 AND kind = 'pairing_code'
            AND requested_at > now() - interval '10 minutes'`,
        [served.twinId, LINK_ASK_UNTAKEN_SECONDS + 5],
      );
    });
    const late = await ask(TWIN_API_ROUTES.link, asRepWeb());
    expect(JSON.parse(late.body)).toMatchObject({ ask: "untaken" });

    const again = await act(TWIN_API_ASK_ROUTES.link, asRepWeb(), undefined);
    expect(JSON.parse(again.body)).toEqual({ outcome: "performed" });
    const now = await ask(TWIN_API_ROUTES.link, asRepWeb());
    expect(JSON.parse(now.body)).toMatchObject({ ask: "waiting" });
  });

  it("says an ask the plane could not serve failed, and one it refused is the rail's to answer (#403)", async () => {
    // The plane took it and could not serve it — the rig's logged-out plane,
    // three times in under 100 ms. The page owes the rep that sentence and the
    // button, not «Pidiendo tu código» for the rest of the window.
    await withClient(async (client) => {
      await client.query(
        `UPDATE plane_requests
            SET taken_at = now(), outcome = 'failed', reason = 'pass_failed',
                settled_at = now()
          WHERE twin_id = $1 AND kind = 'pairing_code' AND outcome IS NULL`,
        [served.twinId],
      );
    });
    const failed = await ask(TWIN_API_ROUTES.link, asRepWeb());
    expect(JSON.parse(failed.body)).toMatchObject({ ask: "failed" });
    // ...AND A FAILED ASK IS NOT LIVE: the press writes the next one.
    const again = await act(TWIN_API_ASK_ROUTES.link, asRepWeb(), undefined);
    expect(JSON.parse(again.body)).toEqual({ outcome: "performed" });
    const now = await ask(TWIN_API_ROUTES.link, asRepWeb());
    expect(JSON.parse(now.body)).toMatchObject({ ask: "waiting" });
    // ...AND A REFUSAL BY NAME IS NOT A FAILURE: a number that already holds
    // a session is refused every time, and the rail's rows are the answer.
    await withClient(async (client) => {
      await client.query(
        `UPDATE plane_requests
            SET taken_at = now(), outcome = 'refused', reason = 'already_linked',
                settled_at = now()
          WHERE twin_id = $1 AND kind = 'pairing_code' AND outcome IS NULL`,
        [served.twinId],
      );
    });
    const refused = await ask(TWIN_API_ROUTES.link, asRepWeb());
    expect(JSON.parse(refused.body)).toMatchObject({ ask: "none" });
    // The next test settles every ask `served`; a served row carries no reason.
    await withClient(async (client) => {
      await client.query(
        `UPDATE plane_requests SET outcome = 'served', reason = NULL
          WHERE twin_id = $1 AND kind = 'pairing_code'
            AND outcome IN ('failed', 'refused')`,
        [served.twinId],
      );
    });
  });

  it("refuses the ask while the rail's latest row says linked", async () => {
    // Decided from the SEAM rather than by spending a request row and a plane
    // pass to learn what the rail already says (`askForPairingCode`).
    await withClient(async (client) => {
      await client.query(
        `UPDATE plane_requests SET taken_at = now(), outcome = 'served',
                stopped_by = NULL, settled_at = now()
          WHERE twin_id = $1 AND kind = 'pairing_code'`,
        [served.twinId],
      );
    });
    const planted = await plantRail(
      "linked",
      "",
      new Date("2026-08-29T18:00:00.000Z"),
    );
    try {
      const refused = await act(
        TWIN_API_ASK_ROUTES.link,
        asRepWeb(),
        undefined,
      );
      expect(JSON.parse(refused.body)).toEqual({ outcome: "refused" });
    } finally {
      await removeRail(planted);
      await withClient(async (client) => {
        await client.query(
          "DELETE FROM plane_requests WHERE twin_id = $1 AND kind = 'pairing_code'",
          [served.twinId],
        );
      });
    }
  });

  it("refuses it for another twin's seat, and answers no route to a GET", async () => {
    const foreign = await act(
      TWIN_API_ASK_ROUTES.link,
      asRepWeb(other.seatId),
      undefined,
    );
    expect(foreign.status).toBe(403);
    // A READ ON AN ASK'S PATH IS NO ROUTE, which is the method rule: a link
    // preview or a prefetch would otherwise ask the plane for a credential.
    const got = await ask(TWIN_API_ASK_ROUTES.link, asRepWeb());
    expect(got.status).toBe(404);
    expect(JSON.parse(got.body)).toEqual({ error: "no_route" });
  });
});

describe("the two scope switches, over the wire (ticket #223)", () => {
  it("writes the allowlist row, the request row, the act row and its entries", async () => {
    const rows = await plantDirectory();
    try {
      await withClient(async (client) => {
        await client.query("DELETE FROM scope_allowlist WHERE twin_id = $1", [
          served.twinId,
        ]);
      });
      const before = await scopeEntries();
      const answered = await act(TWIN_API_ACT_ROUTES.scopeIn, asRepWeb(), {
        directoryId: rows.group,
      });
      expect(answered.status).toBe(200);
      expect(JSON.parse(answered.body)).toEqual({ outcome: "performed" });
      const written = await withClient(async (client) => {
        const allowed = await client.query<{ chat_jid: string }>(
          "SELECT chat_jid FROM scope_allowlist WHERE twin_id = $1",
          [served.twinId],
        );
        const asked = await client.query<{ kind: string }>(
          `SELECT kind FROM plane_requests
            WHERE twin_id = $1 AND kind <> 'pairing_code'`,
          [served.twinId],
        );
        const acts = await client.query<{
          verb: string;
          post_id: string | null;
          chat_directory_id: string | null;
        }>(
          `SELECT verb, post_id, chat_directory_id FROM dashboard_acts
            WHERE twin_id = $1 AND verb IN ('scope_in', 'scope_out')`,
          [served.twinId],
        );
        return { allowed, asked, acts, chained: await scopeEntriesOn(client) };
      });
      // The chat the ROW named, resolved on this side — the address never left
      // the runtime.
      expect(written.allowed.rows).toEqual([{ chat_jid: rows.groupChat }]);
      expect(written.asked.rows).toEqual([{ kind: "scope_in" }]);
      expect(written.acts.rows).toEqual([
        { verb: "scope_in", post_id: null, chat_directory_id: rows.group },
      ]);
      expect(written.chained - before).toBe(1);
    } finally {
      await clearDirectory();
    }
  });

  it("takes it back out again, and refuses a row of another twin", async () => {
    const rows = await plantDirectory();
    try {
      const out = await act(TWIN_API_ACT_ROUTES.scopeOut, asRepWeb(), {
        directoryId: rows.dm,
      });
      expect(JSON.parse(out.body)).toEqual({ outcome: "performed" });
      const allowed = await withClient((client) =>
        client.query("SELECT 1 FROM scope_allowlist WHERE twin_id = $1", [
          served.twinId,
        ]),
      );
      expect(allowed.rows).toEqual([]);
      // ANOTHER TWIN'S SEAT IS REFUSED BEFORE THE ROW IS EVEN LOOKED UP, by
      // the same fence every act meets.
      const foreign = await act(
        TWIN_API_ACT_ROUTES.scopeIn,
        asRepWeb(other.seatId),
        { directoryId: rows.dm },
      );
      expect(foreign.status).toBe(403);
    } finally {
      await clearDirectory();
    }
  });

  it("refuses a body that is not a scope act's, and a post id in its place", async () => {
    const { postId } = await servedDraftPost();
    for (const body of [
      "not json at all",
      JSON.stringify({}),
      // A POST ID WHERE A DIRECTORY ROW BELONGS. Both are uuids, so only the
      // FIELD NAME tells them apart — which is why the body shape a path
      // accepts is read off the record both sides share
      // (`DASHBOARD_ACT_TARGET_OF_ROUTE`) rather than guessed from the value.
      JSON.stringify({ postId }),
      JSON.stringify({ directoryId: "not-a-uuid" }),
    ]) {
      const answered = await act(
        TWIN_API_ACT_ROUTES.scopeIn,
        asRepWeb(),
        body,
      );
      expect(`${body}: ${String(answered.status)}`).toBe(`${body}: 400`);
    }
  });

  it("refuses a directory row id on a CARD's act, for the same reason", async () => {
    const rows = await plantDirectory();
    try {
      const answered = await act(
        TWIN_API_ACT_ROUTES.dismissDraft,
        asRepWeb(),
        { directoryId: rows.dm },
      );
      expect(answered.status).toBe(400);
    } finally {
      await clearDirectory();
    }
  });
});

/**
 * THE DASHBOARD'S DOOR, OVER THE WIRE (ticket #261; spec #258 *Habla con
 * Dito, the mechanism*).
 *
 * The two routes #263's composer lands on: the ask that takes the rep's words
 * and the read that gives today's exchanges back. Every claim is made against
 * bytes a client would receive, over the same real server and the same real
 * Postgres the rest of this file uses.
 *
 * TWO SEATS, ALWAYS — the file's own rule, read on a surface where it bites
 * hardest: a door message is the rep's own words, and the one thing this API
 * must never do is put them in front of another seat.
 */
describe("the door's message and its day of exchanges (ticket #261)", () => {
  /** The served twin's own open login, minted once for this block. */
  let session: string;

  beforeAll(async () => {
    session = randomUUID();
    await withClient(async (client) => {
      await client.query(
        `INSERT INTO sessions (id, company_id, seat_id, token_sha256, expires_at)
         VALUES ($1, $2, $3, $4, now() + interval '30 days')`,
        [session, served.companyId, served.seatId, randomBytes(32)],
      );
    });
  });

  const EXCHANGES = (now: Date): string =>
    `${TWIN_API_ROUTES.exchanges}?now=${encodeURIComponent(now.toISOString())}`;

  /** What the API answered, as the wire's own type. */
  async function exchangesAt(now: Date): Promise<TwinExchanges> {
    const res = await ask(EXCHANGES(now), asRepWeb());
    expect(res.status).toBe(200);
    return JSON.parse(res.body) as TwinExchanges;
  }

  /** Every exchange of a page, across its days. */
  function flat(page: TwinExchanges): readonly TwinExchange[] {
    return page.days.flatMap((one) => one.exchanges).filter((one) => one.line === undefined);
  }

  it("writes one sealed row and answers with its id", async () => {
    const said = "¿qué quedó con lo de Garza?";
    const answered = await act(TWIN_API_ASK_ROUTES.message, asRepWeb(), {
      text: said,
      sessionId: session,
    });
    expect(answered.status).toBe(200);
    const { messageId } = JSON.parse(answered.body) as { messageId: string };

    await withClient(async (client) => {
      const row = await client.query<{
        company_id: string;
        seat_id: string;
        twin_id: string;
        session_id: string;
        text_enc: Buffer;
      }>("SELECT * FROM dashboard_messages WHERE id = $1", [messageId]);
      expect(row.rows).toHaveLength(1);
      // THE SCOPE IS THE REGISTRY'S, NEVER THE REQUEST'S: the body carried a
      // text and a session and no seat, no company and no twin at all.
      expect(row.rows[0]!.company_id).toBe(served.companyId);
      expect(row.rows[0]!.seat_id).toBe(served.seatId);
      expect(row.rows[0]!.twin_id).toBe(served.twinId);
      expect(row.rows[0]!.session_id).toBe(session);
      // THE WORDS ARE SEALED. Nothing but the lease holder can produce this
      // string from what is in the store (ADR-0008), and the row carries them
      // in no other column.
      expect(
        Buffer.from(served.dek.decrypt(row.rows[0]!.text_enc)).toString("utf8"),
      ).toBe(said);
      // ...AND THE ONE TEXT COLUMN IS A BLANK'S KEY (ticket #342), which
      // `dashboard_messages_about_check` holds to a short lower-case
      // identifier: a name the twin gave a slot, never the rep's words.
      const columns = await client.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name = 'dashboard_messages' AND data_type = 'text'`,
      );
      expect(columns.rows).toEqual([{ column_name: "about_blank_key" }]);
    });
  });

  it("refuses an empty message, one past the cap, and an unknown session", async () => {
    for (const body of [
      { text: "   ", sessionId: session },
      { text: "a".repeat(TWIN_API_MESSAGE_MAX_CHARS + 1), sessionId: session },
      { text: "hola", sessionId: randomUUID() },
      { text: "hola", sessionId: "not-a-session" },
      { text: 7, sessionId: session },
      { sessionId: session },
    ]) {
      const answered = await act(TWIN_API_ASK_ROUTES.message, asRepWeb(), body);
      // ONE WORD FOR ALL OF THEM: three of the four are facts a composer
      // already knows, and telling them apart would map the store for whoever
      // got past the bearer (#221's decision 2).
      expect(`${JSON.stringify(body)}: ${String(answered.status)}`).toBe(
        `${JSON.stringify(body)}: 400`,
      );
      expect(JSON.parse(answered.body)).toEqual({ error: "bad_request" });
    }
  });

  it("refuses a session that belongs to another seat", async () => {
    // THE FOURTH FENCE, WHICH IS THE ONE A MESSAGE NEEDS. The bearer, the seat
    // header and the registry say whose twin this is; the session says whose
    // login typed the words, and another seat's open login is not this rep's.
    const foreign = randomUUID();
    await withClient(async (client) => {
      await client.query(
        "INSERT INTO companies (id, display_name) VALUES ($1, $2)",
        [other.companyId, "Otra"],
      ).catch(() => undefined);
      await client.query(
        `INSERT INTO sessions (id, company_id, seat_id, token_sha256, expires_at)
         VALUES ($1, $2, $3, $4, now() + interval '30 days')`,
        [foreign, other.companyId, other.seatId, randomBytes(32)],
      );
    });
    const answered = await act(TWIN_API_ASK_ROUTES.message, asRepWeb(), {
      text: "hola",
      sessionId: foreign,
    });
    expect(answered.status).toBe(400);
  });

  it("refuses a seat whose twin is not this runtime's, before any write", async () => {
    const before = await countMessages();
    const answered = await act(
      TWIN_API_ASK_ROUTES.message,
      asRepWeb(other.seatId),
      { text: "hola", sessionId: session },
    );
    expect(answered.status).toBe(403);
    expect(JSON.parse(answered.body)).toEqual({ error: "wrong_twin" });
    expect(await countMessages()).toBe(before);
  });

  it("keeps the line the rep edited on the row, beside the sealed words (ticket #344)", async () => {
    const record = await withClient((client) =>
      disclosedFact(client, served, { reachedAt: new Date() }),
    );
    const said = "Le cotizaste cajas en 4800 MXN.";
    const answered = await act(TWIN_API_ASK_ROUTES.message, asRepWeb(), {
      text: said,
      sessionId: session,
      about: { kind: "line", postId: record.postId, lineIndex: 1 },
    });
    expect(answered.status).toBe(200);
    const { messageId } = JSON.parse(answered.body) as { messageId: string };
    const row = await withClient((client) =>
      client.query<{ about_post_id: string; about_line_index: number; text_enc: Buffer }>(
        "SELECT about_post_id, about_line_index, text_enc FROM dashboard_messages WHERE id = $1",
        [messageId],
      ),
    );
    expect(row.rows[0]!.about_post_id).toBe(record.postId);
    expect(row.rows[0]!.about_line_index).toBe(1);
    expect(Buffer.from(served.dek.decrypt(row.rows[0]!.text_enc)).toString("utf8")).toBe(said);
  });

  it("writes no reference for a message that names no line (ticket #344)", async () => {
    const answered = await act(TWIN_API_ASK_ROUTES.message, asRepWeb(), {
      text: "¿y lo de Garza?",
      sessionId: session,
    });
    const { messageId } = JSON.parse(answered.body) as { messageId: string };
    const row = await withClient((client) =>
      client.query<{ about_post_id: string | null; about_line_index: number | null }>(
        "SELECT about_post_id, about_line_index FROM dashboard_messages WHERE id = $1",
        [messageId],
      ),
    );
    expect(row.rows[0]).toEqual({ about_post_id: null, about_line_index: null });
  });

  it("refuses a reference that is not both a card of this twin and a line it printed (ticket #344)", async () => {
    const record = await withClient((client) =>
      disclosedFact(client, served, { day: "2026-09-09", reachedAt: new Date() }),
    );
    const { postId: draftCard } = await servedDraftPost();
    const foreign = await withClient(async (client) => {
      await client.query(
        "INSERT INTO companies (id, display_name) VALUES ($1, $2) ON CONFLICT DO NOTHING",
        [other.companyId, "Otra"],
      );
      return await disclosedFact(client, other, { reachedAt: new Date() });
    });
    const before = await countMessages();
    for (const about of [
      { kind: "line", postId: record.postId },
      { kind: "line", lineIndex: 1 },
      // A REFERENCE THAT DOES NOT SAY WHAT IT NAMES (ticket #342): a line or
      // a blank, never a shape the door has to guess at.
      { postId: record.postId, lineIndex: 1 },
      { kind: "line", postId: "not-a-uuid", lineIndex: 1 },
      { kind: "line", postId: record.postId, lineIndex: 0 },
      { kind: "line", postId: record.postId, lineIndex: 1.5 },
      { kind: "line", postId: record.postId, lineIndex: "1" },
      { kind: "line", postId: record.postId, lineIndex: 2 },
      { kind: "line", postId: draftCard, lineIndex: 1 },
      { kind: "line", postId: foreign.postId, lineIndex: 1 },
      { kind: "line", postId: randomUUID(), lineIndex: 1 },
      "line 1",
      null,
    ]) {
      const answered = await act(TWIN_API_ASK_ROUTES.message, asRepWeb(), {
        text: "Le cotizaste cajas en 4800 MXN.",
        sessionId: session,
        about,
      });
      expect(`${JSON.stringify(about)}: ${String(answered.status)}`).toBe(
        `${JSON.stringify(about)}: 400`,
      );
    }
    expect(await countMessages()).toBe(before);
  });

  it("refuses a reference to a line whose correction window shut (ticket #344, Codex r1)", async () => {
    // A PAGE LEFT OPEN PAST THE CLOSE, or a form posted without script: the
    // card would draw this line read-only, so the door takes no edit of it.
    const record = await withClient((client) =>
      disclosedFact(client, served, {
        day: "2026-09-10",
        reachedAt: new Date(Date.now() - 25 * 3_600_000),
      }),
    );
    const before = await countMessages();
    const answered = await act(TWIN_API_ASK_ROUTES.message, asRepWeb(), {
      text: "Le cotizaste cajas en 4800 MXN.",
      sessionId: session,
      about: { kind: "line", postId: record.postId, lineIndex: 1 },
    });
    expect(answered.status).toBe(400);
    expect(await countMessages()).toBe(before);
  });

  /**
   * A draft card of the served twin's that leaves one blank (ticket #342),
   * recorded the way the twin records every draft, under one of its runs.
   */
  async function servedBlankDraft(): Promise<{ postId: string; draftId: string }> {
    return await withClient(async (client) => {
      const execution = await client.query<{ id: string }>(
        "SELECT id FROM executions WHERE twin_id = $1 LIMIT 1",
        [served.twinId],
      );
      const draftId = randomUUID();
      const body = "Te quedan en ⟦b1⟧ cada una.";
      await recordDraft(
        client,
        { twinId: served.twinId, selfChatJid: SELF_CHAT, dek: served.dek },
        {
          id: draftId,
          executionId: execution.rows[0]!.id,
          destination: CUSTOMER,
          contentEnc: served.dek.encrypt(Buffer.from(body, "utf8")),
          post: composeDraftPost({
            draftId,
            counterparty: PUSH_NAME,
            body,
            words: SENTENCE,
            blanks: [{ key: "b1", label: "precio", question: "¿A cuánto se las dejamos?" }],
          }),
        },
      );
      const post = await client.query<{ id: string }>("SELECT id FROM posts WHERE draft_id = $1", [draftId]);
      return { postId: post.rows[0]!.id, draftId };
    });
  }

  it("serves a delicate draft's flag and reason on the card, as the twin sealed them (ticket #343)", async () => {
    const reason = "Le dejé $172, 8% abajo de lista, porque Torres le ofreció lo mismo.";
    const postId = await withClient(async (client) => {
      const execution = await client.query<{ id: string }>(
        "SELECT id FROM executions WHERE twin_id = $1 LIMIT 1",
        [served.twinId],
      );
      const draftId = randomUUID();
      const body = "Te los dejo a $172 cada uno.";
      await recordDraft(
        client,
        { twinId: served.twinId, selfChatJid: SELF_CHAT, dek: served.dek },
        {
          id: draftId,
          executionId: execution.rows[0]!.id,
          destination: CUSTOMER,
          contentEnc: served.dek.encrypt(Buffer.from(body, "utf8")),
          post: composeDraftPost({
            draftId,
            counterparty: PUSH_NAME,
            body,
            words: SENTENCE,
            delicacy: { delicate: true, reason },
          }),
        },
      );
      const post = await client.query<{ id: string }>("SELECT id FROM posts WHERE draft_id = $1", [draftId]);
      return post.rows[0]!.id;
    });
    const res = await ask(`${TWIN_API_ROUTES.canvas}?now=${encodeURIComponent(new Date().toISOString())}`, asRepWeb());
    expect(res.status).toBe(200);
    const canvas = JSON.parse(res.body) as TwinCanvas;
    const card = canvas.waiting.find((post) => post.id === postId);
    expect(card?.parts.find((part) => part.kind === "draft")).toMatchObject({ delicate: true, reason });
  });

  it("keeps the blank the rep answered on the row, beside the sealed words (ticket #342)", async () => {
    const card = await servedBlankDraft();
    const answered = await act(TWIN_API_ASK_ROUTES.message, asRepWeb(), {
      text: "a 168, por el flete",
      sessionId: session,
      about: { kind: "blank", postId: card.postId, key: "b1" },
    });
    expect(answered.status).toBe(200);
    const { messageId } = JSON.parse(answered.body) as { messageId: string };
    const row = await withClient((client) =>
      client.query(
        "SELECT about_post_id, about_line_index, about_blank_key FROM dashboard_messages WHERE id = $1",
        [messageId],
      ),
    );
    expect(row.rows[0]).toEqual({
      about_post_id: card.postId,
      about_line_index: null,
      about_blank_key: "b1",
    });
  });

  it("refuses a blank that no waiting draft card of this twin leaves (ticket #342)", async () => {
    const card = await servedBlankDraft();
    const filled = await servedBlankDraft();
    await withClient(async (client) => {
      const execution = await client.query<{ id: string }>(
        "SELECT id FROM executions WHERE twin_id = $1 LIMIT 1",
        [served.twinId],
      );
      await client.query(
        "INSERT INTO draft_fills (draft_id, filled_draft_id, execution_id) VALUES ($1, $2, $3)",
        [filled.draftId, card.draftId, execution.rows[0]!.id],
      );
    });
    const { postId: plainDraft } = await servedDraftPost();
    const record = await withClient((client) =>
      disclosedFact(client, served, { day: "2026-09-11", reachedAt: new Date() }),
    );
    const before = await countMessages();
    for (const about of [
      { kind: "blank", postId: card.postId, key: "b2" },
      // A KEY THE MODEL COINED, never one code stores (Codex r2).
      { kind: "blank", postId: card.postId, key: "precio" },
      { kind: "blank", postId: card.postId },
      { kind: "blank", postId: plainDraft, key: "b1" },
      { kind: "blank", postId: record.postId, key: "b1" },
      { kind: "blank", postId: filled.postId, key: "b1" },
      { kind: "blank", postId: randomUUID(), key: "b1" },
      { kind: "elsewhere", postId: card.postId, key: "b1" },
    ]) {
      const answered = await act(TWIN_API_ASK_ROUTES.message, asRepWeb(), {
        text: "a 168",
        sessionId: session,
        about,
      });
      expect(`${JSON.stringify(about)}: ${String(answered.status)}`).toBe(
        `${JSON.stringify(about)}: 400`,
      );
    }
    expect(await countMessages()).toBe(before);
  });

  it("answers a GET on the ask's path with no route, and a POST on the read's", async () => {
    // THE METHOD IS PART OF THE REGISTRATION (#221's decision 2), and the door
    // is registered in both maps' shape rather than in a third kind of rule.
    expect((await ask(TWIN_API_ASK_ROUTES.message, asRepWeb())).status).toBe(404);
    expect(
      (await act(TWIN_API_ROUTES.exchanges, asRepWeb(), {})).status,
    ).toBe(404);
  });

  it("returns the pairs day by day, oldest first, and keeps no turn that left nothing", async () => {
    const day = new Date("2026-09-22T18:00:00.000Z");
    const messages = await withClient(async (client) => {
      const ids: string[] = [];
      for (const [text, at] of [
        ["ayer pregunté esto", "2026-09-21T18:00:00.000Z"],
        ["lo primero de hoy", "2026-09-22T15:00:00.000Z"],
        ["lo segundo de hoy", "2026-09-22T16:00:00.000Z"],
      ] as const) {
        const row = await client.query<{ id: string }>(
          `INSERT INTO dashboard_messages
             (company_id, seat_id, twin_id, session_id, text_enc, occurred_at)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [
            served.companyId,
            served.seatId,
            served.twinId,
            session,
            Buffer.from(served.dek.encrypt(Buffer.from(text, "utf8"))),
            new Date(at),
          ],
        );
        ids.push(row.rows[0]!.id);
      }
      return ids;
    });

    const page = await exchangesAt(day);
    // THE SEAT'S DAY, CUT IN ITS OWN ZONE: 18:00Z on the 22nd is noon in
    // Monterrey, and the page names it as a bare date.
    expect(page.today).toBe("2026-09-22");
    // YESTERDAY IS ON THE FIRST PAGE, on its own day and before today's —
    // oldest first, which is the order a conversation reads.
    expect(
      page.days.map((one) => [
        one.day,
        one.exchanges
          .filter((exchange) => messages.includes(exchange.messageId ?? ""))
          .map((exchange) => exchange.text),
      ]),
    ).toEqual([
      ["2026-09-21", ["ayer pregunté esto"]],
      ["2026-09-22", ["lo primero de hoy", "lo segundo de hoy"]],
    ]);
    // NO REPLY YET IS «THE TWIN IS STILL THINKING», and it is absent rather
    // than null: a page resuming a wait after a reload reads exactly that.
    const today = page.days[1]!.exchanges;
    expect(today.every((one) => !("reply" in one) && !("settled" in one))).toBe(
      true,
    );

    // ...AND A REPLY, ONCE IT LANDS, comes back opened under the twin's key.
    await withClient(async (client) => {
      await client.query(
        `INSERT INTO posts (twin_id, origin, parts_enc, asked_on, asked_message_id)
         VALUES ($1, 'composed', $2, 'dashboard', $3)`,
        [
          served.twinId,
          sealParts(served.dek, [
            { kind: "prose", text: "Quedaron 40 cajas para el jueves." },
          ]),
          messages[1]!,
        ],
      );
    });
    const answered = flat(await exchangesAt(day)).find(
      (one) => one.messageId === messages[1],
    );
    expect(answered?.reply?.askedOn).toBe("dashboard");
    expect(
      answered?.reply?.parts.map((part) =>
        part.kind === "prose" ? part.text : part.kind,
      ),
    ).toEqual(["Quedaron 40 cajas para el jueves."]);

    // ...AND A TURN THAT LEFT THE REP NOTHING IS NOT KEPT: the message row
    // stays — it is evidence — and the history's read leaves it out.
    await withClient(async (client) => {
      await client.query(
        `INSERT INTO dashboard_message_processing (message_id, twin_id, disposition)
         VALUES ($1, $2, 'execution_failed')`,
        [messages[2]!, served.twinId],
      );
    });
    expect(
      flat(await exchangesAt(day)).some((one) => one.messageId === messages[2]),
    ).toBe(false);

    // ...AND A MESSAGE THAT PRODUCED A DRAFT IS SETTLED AND KEPT. The twin
    // answered it with a Borrador and its card, so the wait ends and the
    // exchange stays in the history.
    await withClient(async (client) => {
      await client.query(
        `INSERT INTO dashboard_message_processing (message_id, twin_id, disposition)
         VALUES ($1, $2, 'drafted')`,
        [messages[1]!, served.twinId],
      );
    });
    const drafted = flat(await exchangesAt(day)).find(
      (one) => one.messageId === messages[1],
    );
    expect(drafted?.settled).toBe(true);
  });

  it("grants rep-web nothing at all on either new store", async () => {
    // THE DASHBOARD DOES NOT WRITE THE REP'S WORDS, it asks the lease holder
    // to seal and write them — and it holds no key to read them back with
    // either (ADR-0008, ADR-0010). Asserted over the live catalog rather than
    // read off the migration, because a grant can arrive from anywhere.
    const grants = await withClient((client) =>
      client.query<{ table_name: string; grantee: string; privilege_type: string }>(
        `SELECT table_name, grantee, privilege_type
           FROM information_schema.role_table_grants
          WHERE table_name IN ('dashboard_messages', 'dashboard_message_processing')
            AND grantee <> CURRENT_USER
          ORDER BY table_name, grantee, privilege_type`,
      ),
    );
    expect(
      grants.rows.map(
        (row) => `${row.table_name} ${row.grantee} ${row.privilege_type}`,
      ),
    ).toEqual([
      "dashboard_message_processing dito_twin_runtime INSERT",
      "dashboard_message_processing dito_twin_runtime SELECT",
      "dashboard_messages dito_aperture SELECT",
      "dashboard_messages dito_twin_runtime INSERT",
      "dashboard_messages dito_twin_runtime SELECT",
    ]);
  });

  it("serves only this seat's own exchanges", async () => {
    // The other twin's door, written under its own seat — and it is not in
    // this runtime's answer at all, because the read is scoped by BOTH the
    // twin and the seat rather than by either alone.
    const theirs = await withClient(async (client) => {
      const foreign = randomUUID();
      await client.query(
        `INSERT INTO sessions (id, company_id, seat_id, token_sha256, expires_at)
         VALUES ($1, $2, $3, $4, now() + interval '30 days')`,
        [foreign, other.companyId, other.seatId, randomBytes(32)],
      );
      const row = await client.query<{ id: string }>(
        `INSERT INTO dashboard_messages
           (company_id, seat_id, twin_id, session_id, text_enc, occurred_at)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [
          other.companyId,
          other.seatId,
          other.twinId,
          foreign,
          Buffer.from(other.dek.encrypt(Buffer.from("no es mío", "utf8"))),
          new Date("2026-09-22T15:30:00.000Z"),
        ],
      );
      return row.rows[0]!.id;
    });
    const res = await ask(EXCHANGES(new Date("2026-09-22T18:00:00.000Z")), asRepWeb());
    expect(res.body).not.toContain(theirs);
    expect(res.body).not.toContain("no es mío");
  });

  /** How many door messages exist, over the whole store. */
  async function countMessages(): Promise<number> {
    const res = await withClient((client) =>
      client.query<{ n: string }>("SELECT count(*) AS n FROM dashboard_messages"),
    );
    return Number(res.rows[0]!.n);
  }
});

describe("the rep notepad, read and edited through the API (ticket #264)", () => {
  /** The rule the rep writes on *Mi libreta*, in every case here. */
  const TAUGHT = "Con Fuentes, siempre de usted.\nFirmo como «Mauricio», a secas.";

  /** Every row the notebook edit could leave behind, counted for this twin. */
  async function traces(): Promise<Record<string, number>> {
    const res = await withClient((client) =>
      client.query<Record<string, string>>(
        `SELECT
           (SELECT count(*) FROM dashboard_acts
             WHERE twin_id = $1 AND verb = 'edit_notepad') AS acts,
           (SELECT count(*) FROM posts WHERE twin_id = $1) AS posts,
           (SELECT count(*) FROM notices WHERE twin_id = $1) AS notices,
           (SELECT count(*) FROM send_commands WHERE twin_id = $1) AS sends,
           (SELECT count(*) FROM dashboard_messages WHERE twin_id = $1) AS messages`,
        [served.twinId],
      ),
    );
    const row = res.rows[0]!;
    return Object.fromEntries(
      Object.entries(row).map(([key, value]) => [key, Number(value)]),
    );
  }

  /** «Guardar», based on the version the served twin's notebook is at. */
  async function save(
    text: string,
    headers: Record<string, string> = asRepWeb(),
  ): Promise<{ status: number; body: string }> {
    return await act(TWIN_API_ACT_ROUTES.editNotepad, headers, {
      text,
      basedOn: served.bundle.readNotepad()?.version ?? 0,
    });
  }

  /** The newest notebook act row of the served twin. */
  async function latestAct(): Promise<{
    id: string;
    acted_at: Date;
    outcome: string;
    post_id: string | null;
    chat_directory_id: string | null;
    seat_id: string;
  }> {
    const res = await withClient((client) =>
      client.query<{
        id: string;
        acted_at: Date;
        outcome: string;
        post_id: string | null;
        chat_directory_id: string | null;
        seat_id: string;
      }>(
        `SELECT id, acted_at, outcome, post_id, chat_directory_id, seat_id
           FROM dashboard_acts
          WHERE twin_id = $1 AND verb = 'edit_notepad'
          ORDER BY acted_at DESC LIMIT 1`,
        [served.twinId],
      ),
    );
    return res.rows[0]!;
  }

  it("answers a notebook nobody has written as empty, with no instant", async () => {
    const res = await ask(TWIN_API_ROUTES.notepad, asRepWeb());
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      text: "",
      version: 0,
      writtenAt: null,
      // ...AND THE TWIN'S OWN NOTES BESIDE IT, written by nobody yet (#322).
      workingMemory: { text: "", matters: [], version: 0, writtenAt: null },
    });
  });

  it("writes one act row and one version, and the read answers the new text", async () => {
    const before = await traces();
    const answered = await save(TAUGHT);
    expect(answered.status).toBe(200);
    expect(JSON.parse(answered.body)).toEqual({ outcome: "performed" });

    const after = await traces();
    expect(after.acts).toBe(before.acts! + 1);
    const row = await latestAct();
    // NEITHER TARGET: the notebook is the seat's own, and the seat is the one
    // the request authenticated as.
    expect(row).toMatchObject({
      outcome: "performed",
      post_id: null,
      chat_directory_id: null,
      seat_id: served.seatId,
    });
    // THE VERSION NAMES THE ACT ROW AS ITS EVIDENCE, and was written at the
    // instant the rep pressed Guardar.
    const version = served.bundle.readNotepad();
    expect(version?.text).toBe(TAUGHT);
    expect(version?.evidenceRef).toBe(row.id);
    expect(version?.writtenAt).toBe(row.acted_at.toISOString());
    const run = await withClient((client) =>
      client.query<{ trigger_kind: string; disposition: string }>(
        "SELECT trigger_kind, disposition FROM executions WHERE id = $1",
        [version?.executionId],
      ),
    );
    expect(run.rows).toEqual([
      { trigger_kind: "dashboard_act", disposition: "acted" },
    ]);

    const read = await ask(TWIN_API_ROUTES.notepad, asRepWeb());
    expect(JSON.parse(read.body)).toMatchObject({
      text: TAUGHT,
      version: version?.version,
      writtenAt: row.acted_at.toISOString(),
    });
  });

  it("posts no receipt, no post, no notice, no send and no exchange", async () => {
    const before = await traces();
    await save(TAUGHT);
    const after = await traces();
    // ADR-0033: a dashboard edit is about the control the rep touched, so the
    // only new row anywhere is the act itself.
    expect(after).toEqual({ ...before, acts: before.acts! + 1 });
  });

  it("chains the act by its ids alone, with neither target named", async () => {
    const row = await latestAct();
    const entries = await withClient((client) =>
      client.query<{ ref: string; outcome: string }>(
        "SELECT ref, outcome FROM audit_chain WHERE ref LIKE '%' || $1 || '%'",
        [row.id],
      ),
    );
    expect(entries.rows).toHaveLength(1);
    expect(entries.rows[0]!.ref).toContain("post:none chat_row:none");
    // The rep's words are the bundle's and never the chain's (ADR-0020).
    expect(entries.rows[0]!.ref).not.toContain("Fuentes");
    expect(entries.rows[0]!.outcome).not.toContain("Fuentes");
  });

  it("takes exactly the cap, counted in characters and not bytes", async () => {
    // Four bytes a character on the wire, one to the rep: a notebook of the
    // most a rep may write is a body the API has to read whole.
    const full = "😀".repeat(TWIN_API_NOTEPAD_MAX_CHARS);
    const answered = await save(full);
    expect(JSON.parse(answered.body)).toEqual({ outcome: "performed" });
    expect(served.bundle.readNotepad()?.text).toBe(full);
  });

  it("refuses one character past the cap with the store's numbers, and writes nothing", async () => {
    await save(TAUGHT);
    const standing = served.bundle.readNotepad();
    const before = await traces();
    const answered = await save("a".repeat(TWIN_API_NOTEPAD_MAX_CHARS + 1));
    expect(answered.status).toBe(200);
    expect(JSON.parse(answered.body)).toEqual({
      outcome: "over_cap",
      cap: TWIN_API_NOTEPAD_MAX_CHARS,
      charsAttempted: TWIN_API_NOTEPAD_MAX_CHARS + 1,
    });
    // NOTHING WRITTEN, the act row included, and the standing text is not
    // handed back on the wire.
    expect(await traces()).toEqual(before);
    expect(served.bundle.readNotepad()).toEqual(standing);
    expect(answered.body).not.toContain("Fuentes");
  });

  it("writes an empty version for an empty save, which the read answers as empty", async () => {
    const before = served.bundle.readNotepad();
    const answered = await save("");
    expect(JSON.parse(answered.body)).toEqual({ outcome: "performed" });
    const cleared = served.bundle.readNotepad();
    expect(cleared?.text).toBe("");
    expect(cleared?.version).toBe(before!.version + 1);
    const read = await ask(TWIN_API_ROUTES.notepad, asRepWeb());
    expect(JSON.parse(read.body)).toMatchObject({
      text: "",
      version: cleared?.version,
      writtenAt: cleared?.writtenAt,
    });
  });

  it("refuses a save based on a version the thread has since replaced, and writes no version (Codex r1)", async () => {
    // THE PAGE WAS SERVED ONE VERSION; the rep then taught the twin on the
    // phone, which appended the next. A whole-notebook save based on the first
    // would drop that rule from the current text.
    await save(TAUGHT);
    const shown = served.bundle.readNotepad()!;
    served.bundle.writeNotepad({
      text: `${TAUGHT}\nLos viernes salgo a ruta.`,
      writtenAt: new Date().toISOString(),
      executionId: randomUUID(),
      evidenceRef: randomUUID(),
    });
    const taughtOnThePhone = served.bundle.readNotepad()!;
    const before = await traces();
    const answered = await act(TWIN_API_ACT_ROUTES.editNotepad, asRepWeb(), {
      text: "Con Fuentes, de tú.",
      basedOn: shown.version,
    });
    expect(JSON.parse(answered.body)).toEqual({
      outcome: "stale",
      version: taughtOnThePhone.version,
    });
    expect(served.bundle.readNotepad()).toEqual(taughtOnThePhone);
    // THE PRESS IS ON THE RECORD, refused; nothing else was written.
    expect(await traces()).toEqual({ ...before, acts: before.acts! + 1 });
    expect((await latestAct()).outcome).toBe("refused");
  });

  it("accounts a version the bundle would not take as refused, with the act row already on the record (Codex r1)", async () => {
    // THE EVIDENCE COMMITS BEFORE THE VERSION IS WRITTEN, so a bundle that
    // fails leaves the rep's press on the record, stamped, and no version.
    const failing = new Proxy(served.bundle, {
      // BOUND TO THE REAL BUNDLE, whose private connection a proxy receiver
      // cannot reach; only the write is replaced.
      get: (target, property) =>
        property === "writeNotepad"
          ? () => {
              throw new Error("the bundle refused the write");
            }
          : (Reflect.get(target, property, target) as (...args: unknown[]) => unknown).bind(target),
    });
    const flaky = await startLocalApi(
      {
        db: pool,
        twinId: served.twinId,
        dek: served.dek,
        bearer: BEARER,
        acts: { hmacKey: TEST_AUDIT_HMAC_KEY, bundle: failing, selfChatJid: SELF_CHAT },
      },
      { port: 0 },
    );
    try {
      const standing = served.bundle.readNotepad();
      const before = await traces();
      const res = await fetch(
        `http://127.0.0.1:${String(flaky.port)}${TWIN_API_ACT_ROUTES.editNotepad}`,
        {
          method: "POST",
          headers: { ...asRepWeb(), "content-type": "application/json" },
          body: JSON.stringify({ text: "otra", basedOn: standing?.version ?? 0 }),
        },
      );
      expect(res.status).toBe(500);
      expect(served.bundle.readNotepad()).toEqual(standing);
      expect(await traces()).toEqual({ ...before, acts: before.acts! + 1 });
      const row = await latestAct();
      expect(row.outcome).toBe("refused");
      const run = await withClient((client) =>
        client.query<{ disposition: string }>(
          `SELECT e.disposition FROM executions e
            JOIN audit_chain a ON a.ref LIKE '%' || $1 || '%'
           WHERE e.twin_id = $2 AND e.trigger_kind = 'dashboard_act'
           ORDER BY e.started_at DESC LIMIT 1`,
          [row.id, served.twinId],
        ),
      );
      expect(run.rows).toEqual([{ disposition: "no-action" }]);
    } finally {
      await flaky.close();
    }
  });

  it("refuses a body that is not a notebook, as a bad request that writes nothing", async () => {
    const before = await traces();
    for (const body of [
      {},
      { text: 7, basedOn: 0 },
      { text: "sin versión" },
      { text: "x", basedOn: -1 },
      { text: "x", basedOn: 1.5 },
      { postId: randomUUID() },
      "[]",
    ]) {
      const answered = await act(TWIN_API_ACT_ROUTES.editNotepad, asRepWeb(), body);
      expect(answered.status).toBe(400);
      expect(JSON.parse(answered.body)).toEqual({ error: "bad_request" });
    }
    expect(await traces()).toEqual(before);
  });

  it("refuses another twin's seat and a missing seat, before either store is touched", async () => {
    const before = await traces();
    const standing = served.bundle.readNotepad();
    const foreign = await save("de otro", asRepWeb(other.seatId));
    expect(foreign.status).toBe(403);
    expect(JSON.parse(foreign.body)).toEqual({ error: "wrong_twin" });
    const seatless = await save("de nadie", {
      authorization: `Bearer ${BEARER}`,
    });
    expect(seatless.status).toBe(400);
    expect(JSON.parse(seatless.body)).toEqual({ error: "no_seat" });
    const read = await ask(TWIN_API_ROUTES.notepad, asRepWeb(other.seatId));
    expect(read.status).toBe(403);
    expect(await traces()).toEqual(before);
    expect(served.bundle.readNotepad()).toEqual(standing);
  });

  it("answers the twin's working memory beside the notebook, and a save writes the notebook alone (ticket #322 AC 3)", async () => {
    const TORRES = randomUUID();
    const notes = served.bundle.writeWorkingMemory({
      text: "Torres espera saber cuándo sale su pedido.",
      matters: [{ label: "Torres, el pedido", about: { kind: "entity", id: TORRES } }],
      writtenAt: "2026-10-04T17:00:00.000Z",
      executionId: randomUUID(),
    });
    expect(notes.outcome).toBe("written");
    const before = served.bundle.readWorkingMemory()!;
    const read = await ask(TWIN_API_ROUTES.notepad, asRepWeb());
    expect(JSON.parse(read.body)).toMatchObject({
      workingMemory: {
        text: "Torres espera saber cuándo sale su pedido.",
        matters: [{ label: "Torres, el pedido", about: { kind: "entity", id: TORRES } }],
        version: before.version,
        writtenAt: "2026-10-04T17:00:00.000Z",
      },
    });
    // «GUARDAR» ON THE FIRST SECTION WRITES THE NOTEBOOK AND NOTHING ELSE.
    const notebookBefore = served.bundle.readNotepad()?.version ?? 0;
    expect(JSON.parse((await save(TAUGHT)).body)).toEqual({ outcome: "performed" });
    expect(served.bundle.readNotepad()?.version).toBe(notebookBefore + 1);
    expect(served.bundle.readWorkingMemory()).toEqual(before);
    // ...AND THE CHIPS' READ ANSWERS THE OPEN MATTERS ALONE, never the prose.
    const chips = await ask(TWIN_API_ROUTES.openMatters, asRepWeb());
    expect(chips.status).toBe(200);
    expect(JSON.parse(chips.body)).toEqual({
      version: before.version,
      matters: [{ label: "Torres, el pedido", about: { kind: "entity", id: TORRES } }],
    });
    expect(chips.body).not.toContain("espera saber");
    // ...for this seat's twin only.
    expect((await ask(TWIN_API_ROUTES.openMatters, asRepWeb(other.seatId))).status).toBe(403);
  });

  it("puts the subject beside each label, rendered from the stored reference, and none when it no longer resolves", async () => {
    const LAURA = randomUUID();
    served.bundle.confirmChatBinding({
      chatJid: `52155520${String(Date.now()).slice(-5)}@s.whatsapp.net`,
      entityId: LAURA,
      displayName: "Laura",
      confirmedAt: "2026-10-01T17:00:00.000Z",
    });
    const gone = randomUUID();
    served.bundle.writeWorkingMemory({
      text: "Laura confirma el jueves.",
      matters: [
        { label: "Pedido grande - confirma el jueves", about: { kind: "entity", id: LAURA } },
        { label: "Un borrador que ya se fue", about: { kind: "post", id: gone } },
      ],
      writtenAt: "2026-10-04T18:00:00.000Z",
      executionId: randomUUID(),
    });
    const chips = JSON.parse((await ask(TWIN_API_ROUTES.openMatters, asRepWeb())).body) as {
      matters: { label: string; subject?: string }[];
    };
    expect(chips.matters).toEqual([
      {
        label: "Pedido grande - confirma el jueves",
        about: { kind: "entity", id: LAURA },
        subject: "Laura",
        // ...AND HER REFERENCE, which a waiting card of hers carries (ticket #335).
        customer: `c${String(served.bundle.referenceOfEntity(LAURA))}`,
      },
      { label: "Un borrador que ya se fue", about: { kind: "post", id: gone } },
    ]);
    // ...AND MI LIBRETA'S SECOND SECTION CARRIES THE SAME.
    const notebook = JSON.parse((await ask(TWIN_API_ROUTES.notepad, asRepWeb())).body) as {
      workingMemory: { matters: { subject?: string }[] };
    };
    expect(notebook.workingMemory.matters.map((matter) => matter.subject)).toEqual(["Laura", undefined]);
  });

  it("answers no route to a POST on the read and a GET on the act", async () => {
    const posted = await act(TWIN_API_ROUTES.notepad, asRepWeb(), {
      text: "x",
      basedOn: 0,
    });
    expect(posted.status).toBe(404);
    const got = await ask(TWIN_API_ACT_ROUTES.editNotepad, asRepWeb());
    expect(got.status).toBe(404);
  });

  it("serves neither on a runtime started for the reads alone", async () => {
    // The notebook lives in the bundle the acts hold, so a server with none
    // has no notebook to answer about.
    const readsOnly = await startLocalApi(
      { db: pool, twinId: served.twinId, dek: served.dek, bearer: BEARER },
      { port: 0 },
    );
    try {
      const at = `http://127.0.0.1:${String(readsOnly.port)}`;
      const read = await fetch(`${at}${TWIN_API_ROUTES.notepad}`, {
        headers: asRepWeb(),
      });
      expect(read.status).toBe(404);
      const chips = await fetch(`${at}${TWIN_API_ROUTES.openMatters}`, {
        headers: asRepWeb(),
      });
      expect(chips.status).toBe(404);
      const edit = await fetch(`${at}${TWIN_API_ACT_ROUTES.editNotepad}`, {
        method: "POST",
        headers: { ...asRepWeb(), "content-type": "application/json" },
        body: JSON.stringify({ text: "x", basedOn: 0 }),
      });
      expect(edit.status).toBe(404);
    } finally {
      await readsOnly.close();
    }
  });
});

/** An open stream: what it answered, what it has carried, and a way to wait. */
interface OpenStream {
  readonly status: number;
  readonly type: string | null;
  readonly heard: TwinStreamEvent[];
  until(check: (heard: readonly TwinStreamEvent[]) => boolean): Promise<void>;
  close(): void;
}

/** Opens a seat's stream as rep-web does, and reads its frames as they come. */
async function openStreamAt(
  origin_: string,
  headers: Record<string, string>,
): Promise<OpenStream> {
  const controller = new AbortController();
  const res = await fetch(`${origin_}${TWIN_API_STREAM_ROUTES.events}`, {
    headers,
    signal: controller.signal,
  });
  const heard: TwinStreamEvent[] = [];
  const waiting = new Set<() => void>();
  if (res.ok && res.body !== null) {
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    void (async () => {
      let buffer = "";
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          buffer += value;
          let cut = buffer.indexOf("\n\n");
          while (cut !== -1) {
            const frame = buffer.slice(0, cut);
            buffer = buffer.slice(cut + 2);
            const data = frame
              .split("\n")
              .filter((line) => line.startsWith("data: "))
              .map((line) => line.slice("data: ".length))
              .join("\n");
            if (data !== "") heard.push(JSON.parse(data) as TwinStreamEvent);
            cut = buffer.indexOf("\n\n");
          }
          for (const wake of waiting) wake();
        }
      } catch {
        // The test closed the stream.
      }
    })();
  } else {
    await res.body?.cancel();
  }
  return {
    status: res.status,
    type: res.headers.get("content-type"),
    heard,
    until: (check) =>
      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          waiting.delete(wake);
          reject(new Error(`the stream carried ${JSON.stringify(heard)} and never what was awaited`));
        }, 10_000);
        const wake = (): void => {
          if (!check(heard)) return;
          clearTimeout(timer);
          waiting.delete(wake);
          resolve();
        };
        waiting.add(wake);
        wake();
      }),
    close: () => controller.abort(),
  };
}

/**
 * THE SEAT'S EVENT STREAM, OVER THE WIRE (ticket #263; spec #258 decision 14).
 *
 * A TWIN OF ITS OWN AND A SERVER OF ITS OWN, started WITH the bus the
 * consumer publishes to — which is the composition the rig makes and the one
 * the suite's first server deliberately does not, so «no bus, no stream» is
 * asserted over that one. The model is scripted at the wire; the stream is
 * read by a plain `fetch`, frame by frame, the way a browser's `EventSource`
 * reads it.
 */
describe("the seat's event stream (ticket #263)", () => {
  const ANSWER =
    "Revisé tus chats y de eso hay poco; pregúntame por un cliente y te digo lo que tengo.";
  let streamer: Twin;
  let events: SeatEvents;
  let streaming: LocalApi;
  let at: string;
  let session: string;

  beforeAll(async () => {
    streamer = freshTwin();
    events = createSeatEvents();
    session = randomUUID();
    await withClient(async (client) => {
      await client.query(
        "INSERT INTO companies (id, display_name) VALUES ($1, $2)",
        [streamer.companyId, "Ferretería del Stream"],
      );
      await client.query(
        `INSERT INTO seats (id, company_id, twin_id, rep_display_name, state)
         VALUES ($1, $2, $3, $4, 'linked')`,
        [streamer.seatId, streamer.companyId, streamer.twinId, "Mauricio Cantú"],
      );
      await client.query(
        `INSERT INTO sessions (id, company_id, seat_id, token_sha256, expires_at)
         VALUES ($1, $2, $3, $4, now() + interval '30 days')`,
        [session, streamer.companyId, streamer.seatId, randomBytes(32)],
      );
    });
    streaming = await startLocalApi(
      {
        db: pool,
        twinId: streamer.twinId,
        dek: streamer.dek,
        bearer: BEARER,
        timeZone: ZONE,
        acts: {
          hmacKey: TEST_AUDIT_HMAC_KEY,
          bundle: streamer.bundle,
          selfChatJid: SELF_CHAT,
        },
        events,
      },
      { port: 0 },
    );
    at = `http://127.0.0.1:${String(streaming.port)}`;
  });

  afterAll(async () => {
    await streaming.close();
    streamer.bundle.close();
  });

  /** Opens the stream as rep-web does, at this block's server by default. */
  function openStream(
    headers: Record<string, string>,
    origin_ = at,
  ): Promise<OpenStream> {
    return openStreamAt(origin_, headers);
  }

  /** The streamer's seat, with rep-web's bearer. */
  function asTheStreamer(): Record<string, string> {
    return {
      authorization: `Bearer ${BEARER}`,
      [TWIN_API_SEAT_HEADER]: streamer.seatId,
    };
  }

  /** Types a message through the API's own ask, as the bar's composer does. */
  async function typeThroughTheApi(text: string): Promise<string> {
    const res = await fetch(`${at}${TWIN_API_ASK_ROUTES.message}`, {
      method: "POST",
      headers: { ...asTheStreamer(), "content-type": "application/json" },
      body: JSON.stringify({ text, sessionId: session }),
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as { messageId: string }).messageId;
  }

  /** A turn that searched, found nothing, and answered with `text`. */
  function answering(text: string): Script {
    return [
      {
        toolCall: {
          name: "search_memory",
          input: { about: "cajas", counterparty: null },
        },
      },
      { text: text },
    ];
  }

  it("carries a reply once, as the post whose text is the reply's, and nothing before it (ticket #375)", async () => {
    const stream = await openStream(asTheStreamer());
    try {
      expect(stream.status).toBe(200);
      expect(stream.type).toContain("text/event-stream");
      const messageId = await typeThroughTheApi("¿qué hay de nuevo?");
      await withClient(async (client) => {
        await processPendingWaEvents(
          depsFor(client, streamer, answering(ANSWER), events),
        );
      });
      await stream.until((heard) =>
        heard.some((event) => event.kind === "post" && event.messageId === messageId),
      );
      const mine = stream.heard.filter(
        (event) => "messageId" in event && event.messageId === messageId,
      );
      // ONE FRAME FOR THE MESSAGE, AT THE TURN'S END: its prose is the reply
      // the exchanges read will serve, which the bar plays back.
      expect(mine.map((event) => event.kind)).toEqual(["post"]);
      const post = mine.at(-1);
      expect(post?.kind).toBe("post");
      const prose =
        post?.kind === "post"
          ? post.reply?.parts.map((part) => (part.kind === "prose" ? part.text : "")).join("")
          : undefined;
      expect(prose).toBe(ANSWER);
      const read = await fetch(
        `${at}${TWIN_API_ROUTES.exchanges}?now=${encodeURIComponent(new Date().toISOString())}`,
        { headers: asTheStreamer() },
      );
      const page = (await read.json()) as TwinExchanges;
      const kept = page.days
        .flatMap((one) => one.exchanges)
        .find((one) => one.messageId === messageId);
      expect(post?.kind === "post" ? post.reply?.id : undefined).toBe(kept?.reply?.id);
    } finally {
      stream.close();
    }
  });

  it("says `failed` for a turn that left the rep nothing, and posts nothing", async () => {
    const stream = await openStream(asTheStreamer());
    try {
      const messageId = await typeThroughTheApi("¿y lo otro?");
      await withClient(async (client) => {
        // A turn whose model call fails ends `failed` (#240) — here, a
        // provider that answers nothing at all.
        await processPendingWaEvents(depsFor(client, streamer, [], events));
      });
      await stream.until((heard) =>
        heard.some((event) => event.kind === "failed" && event.messageId === messageId),
      );
      const mine = stream.heard.filter(
        (event) => "messageId" in event && event.messageId === messageId,
      );
      expect(mine).toEqual([{ kind: "failed", messageId }]);
      // ...AND THE HISTORY DOES NOT KEEP IT (spec #258 decision 13).
      const read = await fetch(
        `${at}${TWIN_API_ROUTES.exchanges}?now=${encodeURIComponent(new Date().toISOString())}`,
        { headers: asTheStreamer() },
      );
      expect(await read.text()).not.toContain(messageId);
    } finally {
      stream.close();
    }
  });

  it("carries nothing for a question asked on the phone, and the read never pairs its answer", async () => {
    const stream = await openStream(asTheStreamer());
    try {
      const before = stream.heard.length;
      await withClient(async (client) => {
        await insertWaEvent(client, streamer.dek, {
          twinId: streamer.twinId,
          chatJid: SELF_CHAT,
          senderJid: SELF_CHAT,
          fromMe: true,
          messageId: `3EB0-PHONE-${randomUUID().slice(0, 8)}`,
          text: "¿qué me pidió la Sra. Garza?",
          occurredAt: new Date(),
        });
        await processPendingWaEvents(
          depsFor(client, streamer, answering("Nada de la Sra. Garza por ahora."), events),
        );
        // THE PHONE'S ANSWER EXISTS — posted at the phone's door, with its
        // send — and it is the phone's alone.
        const posts = await client.query<{ asked_on: string | null }>(
          "SELECT asked_on FROM posts WHERE twin_id = $1 AND asked_on = 'twin_thread'",
          [streamer.twinId],
        );
        expect(posts.rows).toHaveLength(1);
      });
      // A beat's worth of quiet, then nothing new on the seat's stream.
      await new Promise<void>((resolve) => setTimeout(resolve, 300));
      expect(stream.heard.slice(before)).toEqual([]);
      const read = await fetch(
        `${at}${TWIN_API_ROUTES.exchanges}?now=${encodeURIComponent(new Date().toISOString())}`,
        { headers: asTheStreamer() },
      );
      expect(await read.text()).not.toContain("Nada de la Sra. Garza");
    } finally {
      stream.close();
    }
  });

  it("refuses at the three fences, as every route does", async () => {
    const wrongBearer = await openStream({
      authorization: "Bearer not-rep-web",
      [TWIN_API_SEAT_HEADER]: streamer.seatId,
    });
    expect(wrongBearer.status).toBe(401);
    const noSeat = await openStream({ authorization: `Bearer ${BEARER}` });
    expect(noSeat.status).toBe(400);
    // ANOTHER TWIN'S SEAT IS REFUSED BEFORE IT HEARS ANYTHING: this runtime
    // holds one twin, and a stream for a seat it does not hold never opens.
    const theirs = await openStream({
      authorization: `Bearer ${BEARER}`,
      [TWIN_API_SEAT_HEADER]: served.seatId,
    });
    expect(theirs.status).toBe(403);
    expect(theirs.heard).toEqual([]);
    // ...AND IT IS A GET: a POST to its path is no route, like any read's.
    const posted = await fetch(`${at}${TWIN_API_STREAM_ROUTES.events}`, {
      method: "POST",
      headers: { ...asTheStreamer(), "content-type": "application/json" },
      body: "{}",
    });
    expect(posted.status).toBe(404);
  });

  it("is no route on a runtime composed with no bus", async () => {
    // The suite's first server is started without one, as a runtime serving
    // no dashboard is: nothing publishes, so there is no stream to open.
    const none = await openStream(asRepWeb(), origin);
    expect(none.status).toBe(404);
  });

  it("holds no pool connection while it stays open", async () => {
    // THE POOL IS FOUR. Four streams held open, then a read: if a stream kept
    // the connection its fences borrowed, the read would wait for one of them
    // to close, which none of them does.
    const open = await Promise.all(
      Array.from({ length: 4 }, () => openStream(asTheStreamer())),
    );
    try {
      expect(open.map((one) => one.status)).toEqual([200, 200, 200, 200]);
      const read = await fetch(`${at}${TWIN_API_ROUTES.rail}`, {
        headers: asTheStreamer(),
        signal: AbortSignal.timeout(5_000),
      });
      expect(read.status).toBe(200);
    } finally {
      for (const one of open) one.close();
    }
  });
});

describe("the bar's history, paged back by day (ticket #263)", () => {
  /** A twin of its own, so its seat's history holds exactly what this block plants. */
  let paged: Twin;
  let session: string;

  beforeAll(async () => {
    paged = freshTwin();
    session = randomUUID();
    await withClient(async (client) => {
      await client.query(
        "INSERT INTO companies (id, display_name) VALUES ($1, $2)",
        [paged.companyId, "Ferretería de los días"],
      );
      await client.query(
        `INSERT INTO seats (id, company_id, twin_id, rep_display_name, state)
         VALUES ($1, $2, $3, $4, 'linked')`,
        [paged.seatId, paged.companyId, paged.twinId, "Mauricio Cantú"],
      );
      await client.query(
        `INSERT INTO sessions (id, company_id, seat_id, token_sha256, expires_at)
         VALUES ($1, $2, $3, $4, now() + interval '30 days')`,
        [session, paged.companyId, paged.seatId, randomBytes(32)],
      );
    });
  });

  afterAll(() => {
    paged.bundle.close();
  });

  it("pages back a day at a time by a day cursor, keeping only what the twin answered", async () => {
    const itsOwn = await startLocalApi(
      { db: pool, twinId: paged.twinId, dek: paged.dek, bearer: BEARER, timeZone: ZONE },
      { port: 0 },
    );
    try {
      const planted = await withClient(async (client) => {
        const ids = new Map<string, string>();
        for (const [text, at_] of [
          ["hace tres días", "2026-09-19T17:00:00.000Z"],
          ["anteayer, falló", "2026-09-20T17:00:00.000Z"],
          ["ayer", "2026-09-21T17:00:00.000Z"],
          ["hoy temprano", "2026-09-22T14:00:00.000Z"],
        ] as const) {
          const row = await client.query<{ id: string }>(
            `INSERT INTO dashboard_messages
               (company_id, seat_id, twin_id, session_id, text_enc, occurred_at)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
            [
              paged.companyId,
              paged.seatId,
              paged.twinId,
              session,
              Buffer.from(paged.dek.encrypt(Buffer.from(text, "utf8"))),
              new Date(at_),
            ],
          );
          ids.set(text, row.rows[0]!.id);
        }
        await client.query(
          `INSERT INTO dashboard_message_processing (message_id, twin_id, disposition)
           VALUES ($1, $2, 'execution_failed')`,
          [ids.get("anteayer, falló"), paged.twinId],
        );
        return ids;
      });
      const pageAt = async (until?: string): Promise<TwinExchanges> => {
        const params = new URLSearchParams({
          now: "2026-09-22T18:00:00.000Z",
          ...(until === undefined ? {} : { until }),
        });
        const res = await fetch(
          `http://127.0.0.1:${String(itsOwn.port)}${TWIN_API_ROUTES.exchanges}?${params.toString()}`,
          { headers: asRepWeb(paged.seatId) },
        );
        expect(res.status).toBe(200);
        return (await res.json()) as TwinExchanges;
      };
      const texts = (page: TwinExchanges): [string, (string | undefined)[]][] =>
        page.days.map((one) => [one.day, one.exchanges.map((exchange) => exchange.text)]);

      const first = await pageAt();
      expect(first.today).toBe("2026-09-22");
      expect(texts(first)).toEqual([
        ["2026-09-21", ["ayer"]],
        ["2026-09-22", ["hoy temprano"]],
      ]);
      // THE CURSOR SKIPS THE DAY THAT HOLDS ONLY A TURN THAT LEFT NOTHING:
      // that exchange is not kept, so its day holds nothing to page to.
      expect(first.nextUntil).toBe("2026-09-19");
      const second = await pageAt(first.nextUntil);
      expect(texts(second)).toEqual([["2026-09-19", ["hace tres días"]]]);
      expect("nextUntil" in second).toBe(false);
      expect(JSON.stringify([first, second])).not.toContain(
        planted.get("anteayer, falló"),
      );

      // A CURSOR THAT IS NOT A DAY IS A BAD REQUEST, before it reaches a query.
      for (const until of ["ayer", "2026-02-31", "2026-09-2", "'; --"]) {
        const res = await fetch(
          `http://127.0.0.1:${String(itsOwn.port)}${TWIN_API_ROUTES.exchanges}?now=2026-09-22T18:00:00.000Z&until=${encodeURIComponent(until)}`,
          { headers: asRepWeb(paged.seatId) },
        );
        expect(`${until}: ${String(res.status)}`).toBe(`${until}: 400`);
      }
    } finally {
      await itsOwn.close();
    }
  });
});

/**
 * EVERYTHING THE TWIN SAID AT THE DOOR, IN THE ONE HISTORY (ticket #338; the UX
 * spine's row A). The twin's own lines — the arrival line, the line a turn
 * said unasked — stand among the rep's exchanges in the order they happened;
 * a reply stays paired and is never a line of its own, and nothing posted at
 * the phone's door is here.
 */
describe("the twin's own lines among the rep's exchanges (ticket #338)", () => {
  let own: Twin;
  let session: string;

  beforeAll(async () => {
    own = freshTwin();
    session = randomUUID();
    await withClient(async (client) => {
      await client.query(
        "INSERT INTO companies (id, display_name) VALUES ($1, $2)",
        [own.companyId, "Ferretería del hilo"],
      );
      await client.query(
        `INSERT INTO seats (id, company_id, twin_id, rep_display_name, state)
         VALUES ($1, $2, $3, $4, 'linked')`,
        [own.seatId, own.companyId, own.twinId, "Mauricio Cantú"],
      );
      await client.query(
        `INSERT INTO sessions (id, company_id, seat_id, token_sha256, expires_at)
         VALUES ($1, $2, $3, $4, now() + interval '30 days')`,
        [session, own.companyId, own.seatId, randomBytes(32)],
      );
    });
  });

  afterAll(() => {
    own.bundle.close();
  });

  it("reads the arrival line and an unasked line in order beside the rep's exchange, with their days, and leaves the phone's door out", async () => {
    const itsOwn = await startLocalApi(
      { db: pool, twinId: own.twinId, dek: own.dek, bearer: BEARER, timeZone: ZONE },
      { port: 0 },
    );
    try {
      await withClient(async (client) => {
        const message = async (text: string, at_: string): Promise<string> =>
          (
            await client.query<{ id: string }>(
              `INSERT INTO dashboard_messages
                 (company_id, seat_id, twin_id, session_id, text_enc, occurred_at)
               VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
              [
                own.companyId,
                own.seatId,
                own.twinId,
                session,
                Buffer.from(own.dek.encrypt(Buffer.from(text, "utf8"))),
                new Date(at_),
              ],
            )
          ).rows[0]!.id;
        const prose = (text: string): Buffer =>
          sealParts(own.dek, [{ kind: "prose", text }]);
        const arrivalLine = async (text: string, at_: string, day: string): Promise<void> => {
          const arrival = await client.query<{ id: string }>(
            `INSERT INTO rep_arrivals (company_id, seat_id, twin_id, arrived_at, day, visit)
             VALUES ($1, $2, $3, $4, $5, 'first_of_day') RETURNING id`,
            [own.companyId, own.seatId, own.twinId, new Date(at_), day],
          );
          await client.query(
            `INSERT INTO posts (twin_id, origin, parts_enc, asked_on, arrival_id, posted_at)
             VALUES ($1, 'composed', $2, 'dashboard', $3, $4)`,
            [own.twinId, prose(text), arrival.rows[0]!.id, new Date(at_)],
          );
        };
        await message("hace tres días", "2026-09-19T17:00:00.000Z");
        await arrivalLine("Ayer temprano: dos cosas te esperan.", "2026-09-21T13:00:00.000Z", "2026-09-21");
        await arrivalLine("Hoy hay dos cosas: Laura y Sergio.", "2026-09-22T13:00:00.000Z", "2026-09-22");
        const asked = await message("¿qué le debo a Torres?", "2026-09-22T14:00:00.000Z");
        await client.query(
          `INSERT INTO posts (twin_id, origin, parts_enc, asked_on, asked_message_id, posted_at)
           VALUES ($1, 'composed', $2, 'dashboard', $3, $4)`,
          [own.twinId, prose("La hora de entrega del viernes."), asked, new Date("2026-09-22T14:00:05.000Z")],
        );
        await client.query(
          `INSERT INTO posts (twin_id, origin, parts_enc, asked_on, unasked, posted_at)
           VALUES ($1, 'composed', $2, 'dashboard', true, $3)`,
          [own.twinId, prose("Por cierto, Torres ya confirmó las 40 cajas."), new Date("2026-09-22T15:00:00.000Z")],
        );
        // THE PHONE'S DOOR: an answer posted at the twin thread, with the
        // notice that delivers it there. It is the phone's alone.
        const notice = await client.query<{ id: string }>(
          `INSERT INTO notices (twin_id, kind, content_enc)
           VALUES ($1, 'daily_disclosure', $2) RETURNING id`,
          [own.twinId, Buffer.from(own.dek.encrypt(Buffer.from("x", "utf8")))],
        );
        await client.query(
          `INSERT INTO posts (twin_id, origin, parts_enc, asked_on, notice_id, posted_at)
           VALUES ($1, 'composed', $2, 'twin_thread', $3, $4)`,
          [own.twinId, prose("Solo en el teléfono."), notice.rows[0]!.id, new Date("2026-09-22T16:00:00.000Z")],
        );
      });
      const res = await fetch(
        `http://127.0.0.1:${String(itsOwn.port)}${TWIN_API_ROUTES.exchanges}?now=2026-09-22T18:00:00.000Z`,
        { headers: asRepWeb(own.seatId) },
      );
      expect(res.status).toBe(200);
      const page = (await res.json()) as TwinExchanges;
      const said = (post: TwinFeedPost | undefined): string =>
        post?.parts.map((part) => (part.kind === "prose" ? part.text : part.kind)).join("") ?? "";
      expect(
        page.days.map((one) => [
          one.day,
          one.exchanges.map((entry) =>
            entry.line === undefined
              ? `rep: ${entry.text} / ${said(entry.reply)}`
              : `twin ${entry.line.at}: ${said(entry.line)}`,
          ),
        ]),
      ).toEqual([
        ["2026-09-21", ["twin 2026-09-21T13:00:00.000Z: Ayer temprano: dos cosas te esperan."]],
        [
          "2026-09-22",
          [
            "twin 2026-09-22T13:00:00.000Z: Hoy hay dos cosas: Laura y Sergio.",
            "rep: ¿qué le debo a Torres? / La hora de entrega del viernes.",
            "twin 2026-09-22T15:00:00.000Z: Por cierto, Torres ya confirmó las 40 cajas.",
          ],
        ],
      ]);
      // THE TWO-DAY PAGE AND ITS CURSOR STAND: the day before holds the rep's
      // question alone, and the cursor names it.
      expect(page.nextUntil).toBe("2026-09-19");
      // THE LINE IS THE POST AS THE FEED SERVES IT, at the door it was said at.
      const line = page.days[1]!.exchanges[0]!.line;
      expect(line?.askedOn).toBe("dashboard");
      expect(JSON.stringify(page)).not.toContain("Solo en el teléfono.");
    } finally {
      await itsOwn.close();
    }
  });
});

describe("the arrival ask, the canvas read and the canvas's words on the stream (tickets #266, #320)", () => {
  const CANVAS_CUSTOMER = "5215550077@s.whatsapp.net";
  let desk: Twin;
  let neighbour: Twin;
  let events: SeatEvents;
  // THE DAY'S SESSIONS THE DESK'S API AND ITS PASSES SHARE (ticket #320); the
  // arrival itself is a row the pass reads (ticket #358).
  const sessions = createThreadSessions();
  let deskApi: LocalApi;
  let neighbourApi: LocalApi;
  let at: string;
  let neighbourAt: string;

  beforeAll(async () => {
    desk = freshTwin();
    neighbour = freshTwin();
    // ONE BUS FOR BOTH SERVERS, as if one process held both: what reaches the
    // neighbour's stream is then exactly what the bus's seat key lets through.
    events = createSeatEvents();
    await withClient(async (client) => {
      for (const twin of [desk, neighbour]) {
        await client.query(
          "INSERT INTO companies (id, display_name) VALUES ($1, $2)",
          [twin.companyId, "Ferretería del Lienzo"],
        );
        await client.query(
          `INSERT INTO seats (id, company_id, twin_id, rep_display_name, state)
           VALUES ($1, $2, $3, $4, 'linked')`,
          [twin.seatId, twin.companyId, twin.twinId, "Mauricio Cantú"],
        );
      }
      await client.query(
        "INSERT INTO send_allowlist (twin_id, destination_jid) VALUES ($1, $2)",
        [desk.twinId, CANVAS_CUSTOMER],
      );
      await client.query(
        "INSERT INTO pacing_thresholds (twin_id, max_sends_per_hour, min_seconds_between_sends) VALUES ($1, 60, 0)",
        [desk.twinId],
      );
    });
    const start = (twin: Twin): Promise<LocalApi> =>
      startLocalApi(
        {
          db: pool,
          twinId: twin.twinId,
          dek: twin.dek,
          bearer: BEARER,
          timeZone: ZONE,
          acts: { hmacKey: TEST_AUDIT_HMAC_KEY, bundle: twin.bundle, selfChatJid: SELF_CHAT },
          events,
          thread: sessions,
        },
        { port: 0 },
      );
    deskApi = await start(desk);
    neighbourApi = await start(neighbour);
    at = `http://127.0.0.1:${String(deskApi.port)}`;
    neighbourAt = `http://127.0.0.1:${String(neighbourApi.port)}`;
  });

  afterAll(async () => {
    await deskApi.close();
    await neighbourApi.close();
    await sessions.close();
    desk.bundle.close();
    neighbour.bundle.close();
  });

  function asDesk(twin: Twin = desk): Record<string, string> {
    return { authorization: `Bearer ${BEARER}`, [TWIN_API_SEAT_HEADER]: twin.seatId };
  }

  /** A customer writes to the desk twin and it drafts — a card, planted as the twin writes it. */
  async function plantDraft(client: pg.Client, tag: string): Promise<void> {
    await insertWaEvent(client, desk.dek, {
      twinId: desk.twinId,
      companyId: desk.companyId,
      seatId: desk.seatId,
      chatJid: CANVAS_CUSTOMER,
      senderJid: CANVAS_CUSTOMER,
      fromMe: false,
      messageId: `3EB0-CNV-${tag}-${randomUUID().slice(0, 6)}`,
      text: "¿me apartas 12 bombas?",
      pushName: "Refacciones RS",
      occurredAt: new Date(),
    });
    await processPendingWaEvents(depsFor(client, desk, draftingTurns(), events));
  }

  async function askArrival(headers: Record<string, string>, origin_ = at) {
    const res = await fetch(`${origin_}${TWIN_API_ASK_ROUTES.arrival}`, {
      method: "POST",
      headers,
    });
    return { status: res.status, body: res.ok ? ((await res.json()) as TwinApiArrivalResult) : undefined };
  }

  async function readTheCanvas(query = ""): Promise<TwinCanvas> {
    const res = await fetch(
      `${at}${TWIN_API_ROUTES.canvas}?now=${encodeURIComponent(new Date().toISOString())}${query}`,
      { headers: asDesk() },
    );
    expect(res.status).toBe(200);
    return (await res.json()) as TwinCanvas;
  }

  it("records the arrival and answers the fallback's facts; a return inside ten minutes wakes nothing", async () => {
    await withClient((client) => plantDraft(client, "A"));
    const first = await askArrival(asDesk());
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ woke: true, visit: "first_of_day" });
    expect(first.body?.facts.waiting).toBeGreaterThan(0);
    expect(first.body?.lastLineId).toBeUndefined();
    const back = await askArrival(asDesk());
    expect(back.body?.woke).toBe(false);
    // THE THROTTLED ASK NAMES THE ARRIVAL IT KEPT, so a second tab follows the
    // line that arrival is still composing (Codex r3).
    expect(back.body?.arrivalId).toBe(first.body?.arrivalId);
  });

  it("passes the three fences and refuses another twin's seat, before it records anything", async () => {
    expect((await askArrival({ [TWIN_API_SEAT_HEADER]: desk.seatId })).status).toBe(401);
    expect((await askArrival({ authorization: `Bearer ${BEARER}` })).status).toBe(400);
    expect((await askArrival(asDesk(neighbour))).status).toBe(403);
    const recorded = await withClient((client) =>
      client.query("SELECT 1 FROM rep_arrivals WHERE seat_id = $1", [neighbour.seatId]),
    );
    expect(recorded.rows).toHaveLength(0);
    // ...AND IT IS A POST: a GET on its path is no route.
    const got = await fetch(`${at}${TWIN_API_ASK_ROUTES.arrival}`, { headers: asDesk() });
    expect(got.status).toBe(404);
  });

  it("carries the thread's arrival line once, in its landing, and the canvas read carries the line and the curation", async () => {
    const stream = await openStreamAt(at, asDesk());
    try {
      const before = await readTheCanvas();
      const spotlit = before.waiting[0]!.id;
      const arrivalId = await withClient(async (client) => {
        const row = await client.query<{ id: string }>(
          `SELECT a.id FROM rep_arrivals a
            LEFT JOIN rep_arrival_executions m ON m.arrival_id = a.id
           WHERE a.seat_id = $1 AND m.arrival_id IS NULL`,
          [desk.seatId],
        );
        // THE ARRIVAL THE FIRST CASE RECORDED IS A ROW WITH NO MARKER (ticket
        // #358), and this pass gives it the thread's turn: the cards moved,
        // then the line.
        await processPendingWaEvents(
          depsFor(
            client,
            desk,
            [
              { toolCall: { name: "move_cards", input: { top: spotlit, order: [] } } },
              { text: `Buenos días; te dejé listo [lo de [c1]](${spotlit}) y es por donde empezaría.` },
            ],
            events,
            sessions,
          ),
        );
        return row.rows[0]!.id;
      });
      await stream.until((heard) =>
        heard.some((event) => event.kind === "curated" && event.arrivalId === arrivalId),
      );
      // THE ARRIVAL'S LINE COMES ONCE, IN ITS `curated`, and nothing of it before.
      expect(stream.heard.filter((event) => "arrivalId" in event && event.arrivalId === arrivalId).map((event) => event.kind)).toEqual(["curated"]);
      const landed = stream.heard.find((event) => event.kind === "curated");
      const canvas = await readTheCanvas();
      expect(landed?.kind === "curated" ? landed.arrival?.postId : undefined).toBe(canvas.arrival?.postId);
      // THE LINE KEEPS THE TWIN'S REFERENCE AND ITS MARK, whose card waits
      // (tickets #321, #401); its mention names the customer.
      expect(canvas.arrival?.line).toBe(`Buenos días; te dejé listo [lo de [c1]](${spotlit}) y es por donde empezaría.`);
      expect(canvas.arrival?.mentions).toEqual([{ reference: "c1", name: "Refacciones RS (sin confirmar)" }]);
      expect(canvas.curation?.spotlight).toBe(spotlit);
      expect(landed?.kind === "curated" ? landed.curation?.spotlight : undefined).toBe(spotlit);
    } finally {
      stream.close();
    }
  });

  it("tells an open stream about a draft that landed, with the post on the wire, once", async () => {
    const stream = await openStreamAt(at, asDesk());
    const watch = createStreamWatch();
    const arrivedIds = (): string[] =>
      stream.heard.flatMap((event) => (event.kind === "arrived" ? [event.post.id] : []));
    try {
      await withClient(async (client) => {
        const watchDeps = { db: client, twinId: desk.twinId, dek: desk.dek, timeZone: ZONE, bundle: desk.bundle, events };
        // THE FIRST PASS TELLS WHAT STANDS: a page that holds it hears nothing
        // new, and one that read before a post committed hears that post.
        await watch.tick(watchDeps, new Date());
        await stream.until((heard) => heard.some((event) => event.kind === "arrived"));
        const standing = arrivedIds();
        await plantDraft(client, "B");
        await watch.tick(watchDeps, new Date());
        await stream.until(() => arrivedIds().length > standing.length);
        const landed = arrivedIds().slice(standing.length);
        expect(landed).toHaveLength(1);
        const post = stream.heard.find(
          (event) => event.kind === "arrived" && event.post.id === landed[0],
        );
        expect(
          post?.kind === "arrived" && post.post.parts.some((part) => part.kind === "draft"),
        ).toBe(true);
        expect((await readTheCanvas()).waiting.map((one) => one.id)).toContain(landed[0]);
        // ...AND A PASS WITH NOTHING NEW TELLS NOTHING.
        const told = arrivedIds().length;
        await watch.tick(watchDeps, new Date());
        await new Promise<void>((resolve) => setTimeout(resolve, 200));
        expect(arrivedIds()).toHaveLength(told);
      });
    } finally {
      stream.close();
    }
  });

  it("hands the browser no chat address, nor its digits, on the canvas read, the feed or an `arrived` frame (ticket #305)", async () => {
    const stream = await openStreamAt(at, asDesk());
    const watch = createStreamWatch();
    try {
      await withClient(async (client) => {
        await plantDraft(client, "D");
        // A FRESH WATCH TELLS EVERY CARD THAT STANDS, so the frames below
        // carry every draft this suite planted for the customer.
        await watch.tick(
          { db: client, twinId: desk.twinId, dek: desk.dek, timeZone: ZONE, bundle: desk.bundle, events },
          new Date(),
        );
      });
      await stream.until((heard) =>
        heard.some(
          (event) => event.kind === "arrived" && event.post.parts.some((part) => part.kind === "draft"),
        ),
      );
      const feed = await fetch(
        `${at}${TWIN_API_ROUTES.feed}?now=${encodeURIComponent(new Date().toISOString())}`,
        { headers: asDesk() },
      );
      expect(feed.status).toBe(200);
      const payloads = {
        canvas: await readTheCanvas(),
        feed: await feed.json(),
        arrived: stream.heard.filter((event) => event.kind === "arrived"),
      };
      // THE BINDING QUESTION'S `chatNumber` IS THE ONE PLACE THE DIGITS CROSS
      // ON PURPOSE — the rep is asked which chat of their own phone to bind
      // (boundary #225, F35) — so the sweep reads around that field by name
      // and pins it to the digits, and covers every other byte.
      const asked = new Set<unknown>();
      const wire = JSON.stringify(payloads, (key, value: unknown) => {
        if (key !== "chatNumber") return value;
        asked.add(value);
        return undefined;
      });
      expect([...asked]).toEqual(["5215550077"]);
      // NOT A SWEEP OVER NOTHING: the drafts are there, named as the rep reads them.
      expect(wire).toContain("Refacciones RS (sin confirmar)");
      expect(wire).not.toContain("5215550077");
      expect(wire).not.toContain("@s.whatsapp.net");
    } finally {
      stream.close();
    }
  });

  it("settles a card acted on through the API with the act's word, after the act", async () => {
    const stream = await openStreamAt(at, asDesk());
    try {
      const canvas = await readTheCanvas();
      const question = canvas.waiting.find((post) => post.parts.some((part) => part.kind === "question"));
      expect(question).toBeDefined();
      const res = await fetch(`${at}${TWIN_API_ACT_ROUTES.declineBinding}`, {
        method: "POST",
        headers: { ...asDesk(), "content-type": "application/json" },
        body: JSON.stringify({ postId: question!.id }),
      });
      expect(res.status).toBe(200);
      await stream.until((heard) => heard.some((event) => event.kind === "settle"));
      expect(stream.heard.filter((event) => event.kind === "settle")).toEqual([
        { kind: "settle", postId: question!.id, outcome: "declined" },
      ]);
      // ...AND THE STORE ALREADY SAYS IT: the card is off the canvas.
      expect((await readTheCanvas()).waiting.map((post) => post.id)).not.toContain(question!.id);
    } finally {
      stream.close();
    }
  });

  it("says `sent` when the runtime settles the send's outcome, never at the press", async () => {
    const stream = await openStreamAt(at, asDesk());
    try {
      const canvas = await readTheCanvas();
      const draftPost = canvas.waiting.find((post) => post.parts.some((part) => part.kind === "draft"))!;
      const draftId = draftPost.parts.find((part) => part.kind === "draft");
      await withClient(async (client) => {
        const written = await createSendLockWriter({ pool, hmacKey: TEST_AUDIT_HMAC_KEY }).requestCustomerSend({
          minter: "rep_web",
          draftId: draftId?.kind === "draft" ? draftId.draftId : "",
        });
        expect(written.outcome).toBe("written");
        // THE PRESS IS NOT THE SEND: nothing is on the stream yet.
        expect(stream.heard.filter((event) => event.kind === "settle")).toEqual([]);
        const command = await client.query<{ id: string }>(
          "SELECT id FROM send_commands WHERE twin_id = $1 AND send_class = 'customer_send'",
          [desk.twinId],
        );
        await simulateExecutorPost(client, {
          commandId: command.rows[0]!.id,
          twinId: desk.twinId,
          waMessageId: `3EB0-SENT-${randomUUID().slice(0, 6)}`,
          plane: { dek: desk.dek, selfJid: SELF_CHAT, companyId: desk.companyId, seatId: desk.seatId },
        });
        await processResolvedSends({
          db: client,
          dek: desk.dek,
          bundle: desk.bundle,
          twinId: desk.twinId,
          selfChatJid: SELF_CHAT,
          events,
        });
      });
      await stream.until((heard) => heard.some((event) => event.kind === "settle"));
      expect(stream.heard.filter((event) => event.kind === "settle")).toEqual([
        { kind: "settle", postId: draftPost.id, outcome: "sent" },
      ]);
      // ...AND THE NEXT READ CARRIES IT, for a page whose stream missed it.
      expect((await readTheCanvas()).sends).toContainEqual({
        postId: draftPost.id,
        outcome: "sent",
      });
    } finally {
      stream.close();
    }
  });

  it("tells a send whose ack never came as `held`, and one the rail refused as `failed` (ADR-0006)", async () => {
    // TWO FRESH DRAFTS, TWO TAPS, AND THE EXECUTOR'S TWO NON-SENT ENDINGS.
    await withClient(async (client) => {
      await plantDraft(client, "H");
      await plantDraft(client, "F");
    });
    const drafts = (await readTheCanvas()).waiting
      .filter((post) => post.parts.some((part) => part.kind === "draft"))
      .slice(-2);
    expect(drafts).toHaveLength(2);
    const stream = await openStreamAt(at, asDesk());
    const watch = createStreamWatch();
    try {
      await withClient(async (client) => {
        const watchDeps = { db: client, twinId: desk.twinId, dek: desk.dek, timeZone: ZONE, bundle: desk.bundle, events };
        await watch.tick(watchDeps, new Date());
        // THE FIRST PASS TELLS WHAT STANDS — the earlier `sent` among it.
        await new Promise<void>((resolve) => setTimeout(resolve, 200));
        stream.heard.splice(0, stream.heard.length);
        const writer = createSendLockWriter({ pool, hmacKey: TEST_AUDIT_HMAC_KEY });
        for (const [post, outcome] of [
          [drafts[0]!, "held"],
          [drafts[1]!, "failed"],
        ] as const) {
          const part = post.parts.find((one) => one.kind === "draft");
          const draftId = part?.kind === "draft" ? part.draftId : "";
          expect((await writer.requestCustomerSend({ minter: "rep_web", draftId })).outcome).toBe("written");
          await client.query(
            `UPDATE send_commands SET outcome = $2, executed_at = now()
              WHERE draft_id = $1 AND send_class = 'customer_send' AND outcome IS NULL`,
            [draftId, outcome],
          );
        }
        await watch.tick(watchDeps, new Date());
      });
      await stream.until(
        (heard) => heard.filter((event) => event.kind === "settle").length >= 2,
      );
      expect(
        stream.heard
          .filter((event) => event.kind === "settle")
          .map((event) => (event.kind === "settle" ? `${event.postId} ${event.outcome}` : ""))
          .sort(),
      ).toEqual([`${drafts[0]!.id} held`, `${drafts[1]!.id} failed`].sort());
    } finally {
      stream.close();
    }
  });

  it("publishes `seen` to the seat's own stream and to no other, and refuses ids that are not ids", async () => {
    const mine = await openStreamAt(at, asDesk());
    const theirs = await openStreamAt(neighbourAt, asDesk(neighbour));
    try {
      expect(theirs.status).toBe(200);
      const postId = (await readTheCanvas()).waiting[0]!.id;
      const res = await fetch(`${at}${TWIN_API_ASK_ROUTES.seen}`, {
        method: "POST",
        headers: { ...asDesk(), "content-type": "application/json" },
        body: JSON.stringify({ postIds: [postId] }),
      });
      expect(await res.json()).toEqual({ published: 1 });
      await mine.until((heard) => heard.some((event) => event.kind === "seen"));
      expect(mine.heard.filter((event) => event.kind === "seen")).toEqual([
        { kind: "seen", postIds: [postId] },
      ]);
      const bad = await fetch(`${at}${TWIN_API_ASK_ROUTES.seen}`, {
        method: "POST",
        headers: { ...asDesk(), "content-type": "application/json" },
        body: JSON.stringify({ postIds: ["not-an-id"] }),
      });
      expect(bad.status).toBe(400);
      await new Promise<void>((resolve) => setTimeout(resolve, 300));
      // EVERY WORD THIS BLOCK PUBLISHED WAS THE DESK'S, AND THE NEIGHBOUR'S
      // STREAM — ON THE SAME BUS — HEARD NONE OF IT.
      expect(theirs.heard).toEqual([]);
    } finally {
      mine.close();
      theirs.close();
    }
  });

  it("answers a card the page must keep, and refuses one that is not an id", async () => {
    const all = await withClient((client) =>
      client.query<{ id: string }>(
        "SELECT id FROM posts WHERE twin_id = $1 AND question_subject = 'binding' ORDER BY posted_at LIMIT 1",
        [desk.twinId],
      ),
    );
    const declined = all.rows[0]!.id;
    const canvas = await readTheCanvas(`&${TWIN_API_KEEP_PARAM}=${declined}`);
    expect(canvas.kept?.id).toBe(declined);
    const bad = await fetch(
      `${at}${TWIN_API_ROUTES.canvas}?now=${encodeURIComponent(new Date().toISOString())}&${TWIN_API_KEEP_PARAM}=nope`,
      { headers: asDesk() },
    );
    expect(bad.status).toBe(400);
  });
});

describe("the offers the rep spent, kept for the day (ticket #335)", () => {
  const OFFER = "¿Le confirmo a la Sra. Garza las 40 cajas del jueves?";
  /** The twin offers `sentence` on the served draft card, as a new curation version. */
  async function offerOnTheCard(sentence: string): Promise<string> {
    const { postId } = await servedDraftPost();
    await withClient(async (client) => {
      const execution = await client.query<{ id: string }>(
        "SELECT id FROM executions WHERE twin_id = $1 LIMIT 1",
        [served.twinId],
      );
      await writeCuration({ db: client, dek: served.dek }, {
        twinId: served.twinId,
        executionId: execution.rows[0]!.id,
        spotlight: postId,
        order: [postId],
        offers: [{ postId, sentence }],
        left: [],
      });
    });
    return postId;
  }

  async function spendingsAt(now: Date, seatId = served.seatId): Promise<TwinOfferSpendings> {
    const read = await ask(
      `${TWIN_API_ROUTES.offerSpendings}?now=${encodeURIComponent(now.toISOString())}`,
      asRepWeb(seatId),
    );
    expect(read.status).toBe(200);
    return JSON.parse(read.body) as TwinOfferSpendings;
  }

  it("keeps a dismissed offer for the day, so a fresh read on any device holds it, and lets a new sentence on the card rise", async () => {
    const postId = await offerOnTheCard(OFFER);
    const spent = await act(TWIN_API_ASK_ROUTES.spend, asRepWeb(), {
      postId,
      sentence: OFFER,
      reason: "dismissed",
    });
    expect(spent.status).toBe(200);
    expect(JSON.parse(spent.body)).toEqual({ spent: true });
    // A FRESH READ — another tab, another device — HOLDS IT.
    const now = new Date();
    expect((await spendingsAt(now)).spent).toContainEqual({ postId, sentence: OFFER, reason: "dismissed" });
    // THE SENTENCE IS SEALED IN THE STORE, never in the clear.
    const stored = await withClient((client) =>
      client.query<{ sentence_enc: Buffer }>(
        "SELECT sentence_enc FROM offer_spendings WHERE seat_id = $1 AND post_id = $2",
        [served.seatId, postId],
      ),
    );
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]!.sentence_enc.toString("utf8")).not.toContain("cajas");
    // A NEW OFFER ON THE SAME CARD IS UNSPENT: the read names the old
    // sentence only, and the new one is the twin's to raise.
    const NEWER = "¿Le mando a la Sra. Garza la ficha de las cajas?";
    await offerOnTheCard(NEWER);
    const after = (await spendingsAt(now)).spent.filter((one) => one.postId === postId);
    expect(after.map((one) => one.sentence)).toEqual([OFFER]);
    // ...for this seat's twin only.
    expect((await ask(`${TWIN_API_ROUTES.offerSpendings}?now=${encodeURIComponent(now.toISOString())}`, asRepWeb(other.seatId))).status).toBe(403);
  });

  it("reads a day by the caller's clock: the seat-local day the mark was made holds it, and the next day none", async () => {
    const postId = await offerOnTheCard(OFFER);
    await act(TWIN_API_ASK_ROUTES.spend, asRepWeb(), { postId, sentence: OFFER, reason: "taken" });
    const now = new Date();
    expect((await spendingsAt(now)).spent).toContainEqual({ postId, sentence: OFFER, reason: "taken" });
    const nextDay = await spendingsAt(new Date(now.getTime() + 24 * 60 * 60_000));
    expect(nextDay.spent).toEqual([]);
    // THE DAY IS CUT IN THE SEAT'S ZONE: 17:00 UTC on 29 August is still
    // that day in Monterrey, and 03:00 UTC on the 30th is the evening before.
    expect((await spendingsAt(READING)).day).toBe("2026-08-29");
    expect((await spendingsAt(new Date("2026-08-30T03:00:00.000Z"))).day).toBe("2026-08-29");
  });

  it("keeps a mark for a sentence the twin has since replaced, and none for a card that is not this twin's (Codex r2)", async () => {
    const postId = await offerOnTheCard(OFFER);
    const REPLACED = "¿Le aviso a la Sra. Garza que ya salió?";
    await offerOnTheCard(REPLACED);
    // THE PAGE STILL SHOWED THE OLD SENTENCE WHEN THE REP LET IT GO.
    const late = await act(TWIN_API_ASK_ROUTES.spend, asRepWeb(), { postId, sentence: OFFER, reason: "dismissed" });
    expect(JSON.parse(late.body)).toEqual({ spent: true });
    const before = (await spendingsAt(new Date())).spent.length;
    const stranger = await act(TWIN_API_ASK_ROUTES.spend, asRepWeb(), {
      postId: randomUUID(),
      sentence: OFFER,
      reason: "taken",
    });
    expect(JSON.parse(stranger.body)).toEqual({ spent: false });
    expect((await spendingsAt(new Date())).spent).toHaveLength(before);
  });

  it("refuses a body that is not a card, a sentence and a reason from the three", async () => {
    const postId = await offerOnTheCard(OFFER);
    for (const body of [
      { postId: "not-an-id", sentence: OFFER, reason: "dismissed" },
      { postId, sentence: "", reason: "dismissed" },
      { postId, sentence: OFFER, reason: "ignored" },
      { postId, reason: "taken" },
    ]) {
      expect((await act(TWIN_API_ASK_ROUTES.spend, asRepWeb(), body)).status).toBe(400);
    }
    expect((await act(TWIN_API_ASK_ROUTES.spend, { [TWIN_API_SEAT_HEADER]: served.seatId }, { postId, sentence: OFFER, reason: "taken" })).status).toBe(401);
  });

  it("answers the day's read only with the caller's «now»", async () => {
    expect((await ask(TWIN_API_ROUTES.offerSpendings, asRepWeb())).status).toBe(400);
  });
});

/**
 * The rep's asks of the served twin, as rows (ticket #358): the page's id,
 * the kind, the card, and the twin's own words opened.
 */
async function askRowsOf(twin: { readonly twinId: string; readonly dek: Dek }, ids: readonly string[]): Promise<unknown[]> {
  const rows = await withClient((client) =>
    client.query<{ id: string; kind: string; seat_id: string; post_id: string | null; words_enc: Buffer | null }>(
      "SELECT id, kind, seat_id, post_id, words_enc FROM rep_asks WHERE twin_id = $1 AND id = ANY($2::uuid[]) ORDER BY asked_at, id",
      [twin.twinId, [...ids]],
    ),
  );
  return rows.rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    seatId: row.seat_id,
    postId: row.post_id,
    ...(row.words_enc === null ? {} : { words: Buffer.from(twin.dek.decrypt(row.words_enc)).toString("utf8") }),
  }));
}

describe("a phrase the rep selects on a card, a row the thread is served from (tickets #341, #358)", () => {
  // THE DAY'S SESSIONS THE API IS HANDED, which a selection never reaches:
  // it is a row (ticket #358).
  const sessions = createThreadSessions();
  let selectApi: LocalApi;
  let at: string;
  /** A card of the twin's own whose sentence names a customer by reference. */
  let named: string;

  beforeAll(async () => {
    selectApi = await startLocalApi(
      {
        db: pool,
        twinId: served.twinId,
        dek: served.dek,
        bearer: BEARER,
        timeZone: ZONE,
        acts: { hmacKey: TEST_AUDIT_HMAC_KEY, bundle: served.bundle, selfChatJid: SELF_CHAT },
        thread: sessions,
      },
      { port: 0 },
    );
    at = `http://127.0.0.1:${String(selectApi.port)}`;
    const planted = await withClient((client) =>
      client.query<{ id: string }>(
        `INSERT INTO posts (twin_id, origin, parts_enc) VALUES ($1, 'composed', $2) RETURNING id`,
        [
          served.twinId,
          sealParts(served.dek, [
            {
              kind: "prose",
              text: "[c4] pidió 300 bultos el martes, para el jueves en Cancún; [c5] lo confirma.",
              mentions: [
                { reference: "c4", name: "Laura Garza" },
                { reference: "c5", name: "Torres", tails: ["8416", "0537"] },
              ],
            },
          ]),
        ],
      ),
    );
    named = planted.rows[0]!.id;
  });

  afterAll(async () => {
    await selectApi.close();
    await sessions.close();
  });

  async function select(body: unknown, headers = asRepWeb()): Promise<{ status: number; body: string }> {
    const res = await fetch(`${at}${TWIN_API_ASK_ROUTES.select}`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.text() };
  }

  it("finds a phrase in a draft's body — across a line break the page read back — and writes the selection's row, raising nothing", async () => {
    sessions.drain(served.twinId);
    const { postId } = await servedDraftPost();
    const selectionId = randomUUID();
    const messagesBefore = await withClient((client) =>
      client.query("SELECT 1 FROM dashboard_messages WHERE twin_id = $1", [served.twinId]),
    );
    const answered = await select({ selectionId, postId, phrase: " se las\n mando " });
    expect(answered.status).toBe(200);
    expect(JSON.parse(answered.body)).toEqual({ selected: true });
    expect(await askRowsOf(served, [selectionId])).toEqual([
      { id: selectionId, kind: "selection", seatId: served.seatId, postId, words: "se las mando" },
    ]);
    expect(sessions.drain(served.twinId)).toEqual([]);
    // NOTHING IN THE REP'S NAME: no door message.
    const messagesAfter = await withClient((client) =>
      client.query("SELECT 1 FROM dashboard_messages WHERE twin_id = $1", [served.twinId]),
    );
    expect(messagesAfter.rows).toHaveLength(messagesBefore.rows.length);
  });

  it("tells the twin its own words: a name the card drew comes back as the reference it wrote, whole", async () => {
    const garza = randomUUID();
    expect(JSON.parse((await select({ selectionId: garza, postId: named, phrase: "Garza pidió 300 bultos" })).body)).toEqual({
      selected: true,
    });
    expect(await askRowsOf(served, [garza])).toEqual([expect.objectContaining({ words: "[c4] pidió 300 bultos" })]);
    // A NAME DRAWN WITH ITS NUMBER'S TAILS, as the card draws it, is the same name.
    const torres = randomUUID();
    const tailed = await select({ selectionId: torres, postId: named, phrase: "Torres (termina en 8416 / 0537) lo confirma" });
    expect(JSON.parse(tailed.body)).toEqual({ selected: true });
    expect(await askRowsOf(served, [torres])).toEqual([expect.objectContaining({ words: "[c5] lo confirma" })]);
  });

  it("refuses a phrase the card does not carry, and a card that is not this twin's, and writes nothing", async () => {
    const { postId } = await servedDraftPost();
    const refused: string[] = [];
    for (const body of [
      { selectionId: randomUUID(), postId, phrase: "se las regalo" },
      // THE LETTERS ARE THE CARD'S OWN: the browser copies them as drawn.
      { selectionId: randomUUID(), postId, phrase: "SE LAS MANDO" },
      // A NAME'S REFERENCE IS THE TWIN'S WRITING, never words the card shows.
      { selectionId: randomUUID(), postId: named, phrase: "[c4] pidió" },
      { selectionId: randomUUID(), postId: randomUUID(), phrase: "se las mando" },
    ]) {
      refused.push(body.selectionId);
      const answered = await select(body);
      expect(answered.status).toBe(200);
      expect(JSON.parse(answered.body)).toEqual({ selected: false });
    }
    expect(await askRowsOf(served, refused)).toEqual([]);
  });

  it("refuses a body that is not a selection's id, a card and a phrase, before it reads anything", async () => {
    const { postId } = await servedDraftPost();
    for (const body of [
      { selectionId: "x", postId, phrase: "se las mando" },
      { selectionId: randomUUID(), postId: "not-an-id", phrase: "se las mando" },
      { selectionId: randomUUID(), postId, phrase: "  " },
      { selectionId: randomUUID(), postId },
      ["se las mando"],
    ]) {
      expect((await select(body)).status).toBe(400);
    }
    expect((await select({ selectionId: randomUUID(), postId, phrase: "se las mando" }, { [TWIN_API_SEAT_HEADER]: served.seatId })).status).toBe(401);
    expect(sessions.drain(served.twinId)).toEqual([]);
  });
});

describe("a card the rep summons the twin to, a row the thread is served from (tickets #340, #358)", () => {
  const sessions = createThreadSessions();
  let summonApi: LocalApi;
  let at: string;
  /** A post of the twin's own that is no card: prose alone waits on nobody. */
  let noCard: string;

  beforeAll(async () => {
    summonApi = await startLocalApi(
      {
        db: pool,
        twinId: served.twinId,
        dek: served.dek,
        bearer: BEARER,
        timeZone: ZONE,
        acts: { hmacKey: TEST_AUDIT_HMAC_KEY, bundle: served.bundle, selfChatJid: SELF_CHAT },
        thread: sessions,
      },
      { port: 0 },
    );
    at = `http://127.0.0.1:${String(summonApi.port)}`;
    const planted = await withClient((client) =>
      client.query<{ id: string }>(
        `INSERT INTO posts (twin_id, origin, parts_enc) VALUES ($1, 'composed', $2) RETURNING id`,
        [served.twinId, sealParts(served.dek, [{ kind: "prose", text: "Una nota suelta." }])],
      ),
    );
    noCard = planted.rows[0]!.id;
  });

  afterAll(async () => {
    await summonApi.close();
    await sessions.close();
  });

  async function summon(body: unknown, headers = asRepWeb()): Promise<{ status: number; body: string }> {
    const res = await fetch(`${at}${TWIN_API_ASK_ROUTES.summon}`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.text() };
  }

  /** A card the canvas read says waits now, as the page would have drawn it. */
  async function waitingCard(): Promise<string> {
    const res = await fetch(`${at}${TWIN_API_ROUTES.canvas}?now=${encodeURIComponent(new Date().toISOString())}`, {
      headers: asRepWeb(),
    });
    const canvas = (await res.json()) as TwinCanvas;
    return canvas.waiting[0]!.id;
  }

  it("writes the summons' row for a card of the twin's that waits — the card and nothing else — and raises nothing", async () => {
    sessions.drain(served.twinId);
    const postId = await waitingCard();
    const summonsId = randomUUID();
    const count = async (): Promise<number> =>
      (
        await withClient((client) =>
          client.query("SELECT 1 FROM dashboard_messages WHERE twin_id = $1", [served.twinId]),
        )
      ).rows.length;
    const messagesBefore = await count();
    const answered = await summon({ summonsId, postId });
    expect(answered.status).toBe(200);
    expect(JSON.parse(answered.body)).toEqual({ summoned: true });
    expect(await askRowsOf(served, [summonsId])).toEqual([
      { id: summonsId, kind: "summons", seatId: served.seatId, postId },
    ]);
    expect(sessions.drain(served.twinId)).toEqual([]);
    // NOTHING IN THE REP'S NAME: no door message.
    expect(await count()).toBe(messagesBefore);
  });

  it("refuses a post that is not a card of this twin's that waits, and writes nothing", async () => {
    const refused: string[] = [];
    for (const postId of [noCard, randomUUID()]) {
      const summonsId = randomUUID();
      refused.push(summonsId);
      const answered = await summon({ summonsId, postId });
      expect(answered.status).toBe(200);
      expect(JSON.parse(answered.body)).toEqual({ summoned: false });
    }
    expect(await askRowsOf(served, refused)).toEqual([]);
  });

  it("refuses a body that is not a summons's id and a card, before it reads anything", async () => {
    const postId = await waitingCard();
    for (const body of [{ summonsId: "x", postId }, { summonsId: randomUUID(), postId: "not-an-id" }, { postId }, [postId]]) {
      expect((await summon(body)).status).toBe(400);
    }
    expect((await summon({ summonsId: randomUUID(), postId }, { [TWIN_API_SEAT_HEADER]: served.seatId })).status).toBe(401);
    expect(sessions.drain(served.twinId)).toEqual([]);
  });
});

describe("Rutinas and the acts log, over the wire (ticket #267)", () => {
  /** The served seat's read at `READING` — 11:00 on 29 August in Monterrey. */
  const at = (route: string, extra = ""): string =>
    `${route}?now=${encodeURIComponent(READING.toISOString())}${extra}`;

  it("serves Rutinas behind the three fences, and refuses another twin's seat", async () => {
    const res = await ask(at(TWIN_API_ROUTES.routines), asRepWeb());
    expect(res.status).toBe(200);
    const read = JSON.parse(res.body) as TwinRoutines;
    expect(read.today).toBe("2026-08-29");
    const shipped = read.automations.flatMap((card) => (card.origin === "dito" ? [card] : []));
    expect(shipped.map((card) => card.shipped)).toEqual(["drafting", "extraction", "daily_disclosure", "reminders", "overnight_requests"]);
    // THE SERVED TWIN DRAFTED IN THIS SUITE'S SETUP, so drafting has fired;
    // its disclosure never ran.
    expect(shipped[0]!.lastRun).toBeDefined();
    expect("lastRun" in shipped[2]!).toBe(false);
    const theirs = await ask(at(TWIN_API_ROUTES.routines), asRepWeb(other.seatId));
    expect(theirs.status).toBe(403);
    expect(JSON.parse(theirs.body)).toEqual({ error: "wrong_twin" });
  });

  it("serves one day of the acts log, clamped to seven days back", async () => {
    const today = await ask(at(TWIN_API_ROUTES.actsLog), asRepWeb());
    expect(today.status).toBe(200);
    const log = JSON.parse(today.body) as TwinActsLog;
    expect([log.today, log.day, log.back]).toEqual(["2026-08-29", "2026-08-29", 0]);
    expect(Array.isArray(log.acts)).toBe(true);
    // A URL ASKING FOR DAY EIGHT, OR NINETY-NINE, IS ANSWERED DAY SEVEN.
    for (const asked of [TWIN_API_ACTS_LOG_DAYS, 8, 99, 123456789]) {
      const res = await ask(at(TWIN_API_ROUTES.actsLog, `&${TWIN_API_BACK_PARAM}=${String(asked)}`), asRepWeb());
      const day = JSON.parse(res.body) as TwinActsLog;
      expect([day.day, day.back]).toEqual(["2026-08-22", 7]);
    }
  });

  it("refuses an acts-log read with no «now», with a day that is not a count, and for another twin", async () => {
    const noNow = await ask(TWIN_API_ROUTES.actsLog, asRepWeb());
    expect(noNow.status).toBe(400);
    for (const back of ["-1", "ayer", "1.5"]) {
      const bad = await ask(at(TWIN_API_ROUTES.actsLog, `&${TWIN_API_BACK_PARAM}=${back}`), asRepWeb());
      expect(bad.status).toBe(400);
      expect(JSON.parse(bad.body)).toEqual({ error: "bad_request" });
    }
    const theirs = await ask(at(TWIN_API_ROUTES.actsLog), asRepWeb(other.seatId));
    expect(theirs.status).toBe(403);
  });

});

describe("Trabajos en curso's runs, read and acted on over the wire (ticket #323 AC 4)", () => {
  let runsApi: LocalApi;
  let runsOrigin: string;
  const harnessDirectory = (): string => join(tmp, "served.harness");
  /** A run of the served twin's waiting on Thursday, one that ended, and one of the other twin's. */
  let waiting: string;
  let finished: string;
  let theirs: string;
  const THURSDAY = new Date("2026-08-31T15:00:00.000Z");
  const DEFINITION: RunDefinition = {
    name: "Revisar lo de Sergio",
    budget: { iterations: 6, tokens: 40_000 },
    steps: [
      { kind: "wait", name: "until_monday", until: { at: THURSDAY.toISOString() } },
      { kind: "agent", name: "check", instructions: "Read and write the line.", tools: ["search_memory"], output: { line: "string" } },
      { kind: "post", name: "report", text: "check.line" },
    ],
  };

  /** A run, as the thread's start and the engine leave it: the sealed content, the row, its steps. */
  async function seedRun(
    client: pg.Client,
    twin: Twin,
    shape: "waiting" | "succeeded",
  ): Promise<string> {
    const runId = randomUUID();
    writeRunContent(harnessDirectory(), twin.dek, runId, { definition: DEFINITION, inputs: {}, outputs: {} });
    await insertRun(client, {
      id: runId,
      twinId: twin.twinId,
      seatId: twin.seatId,
      automation: "inline",
      digest: runDigest(DEFINITION),
      sessionId: randomUUID(),
      stepCount: 3,
      budget: DEFINITION.budget,
      createdBy: "thread",
    });
    await beginStep(client, { runId, step: 0, kind: "wait" });
    if (shape === "waiting") {
      await scheduleWait(client, { twinId: twin.twinId, runId, step: 0, fireAt: THURSDAY });
      await parkStep(client, { runId, step: 0 });
      return runId;
    }
    await client.query("UPDATE runs SET state = 'succeeded', current_step = 2, ended_at = $2 WHERE id = $1", [
      runId,
      new Date("2026-08-28T20:00:00.000Z"),
    ]);
    return runId;
  }

  beforeAll(async () => {
    await withClient(async (client) => {
      waiting = await seedRun(client, served, "waiting");
      finished = await seedRun(client, served, "succeeded");
      theirs = await seedRun(client, other, "waiting");
    });
    runsApi = await startLocalApi(
      {
        db: pool,
        twinId: served.twinId,
        dek: served.dek,
        bearer: BEARER,
        timeZone: ZONE,
        acts: { hmacKey: TEST_AUDIT_HMAC_KEY, bundle: served.bundle, selfChatJid: SELF_CHAT },
        harnessDirectory: harnessDirectory(),
      },
      { port: 0 },
    );
    runsOrigin = `http://127.0.0.1:${String(runsApi.port)}`;
  });

  afterAll(async () => {
    await runsApi.close();
  });

  async function readRunsAt(seatId: string = served.seatId): Promise<{ status: number; body: string }> {
    const res = await fetch(
      `${runsOrigin}${TWIN_API_ROUTES.runs}?now=${encodeURIComponent(READING.toISOString())}`,
      { headers: asRepWeb(seatId) },
    );
    return { status: res.status, body: await res.text() };
  }

  async function runAct(path: string, runId: string): Promise<{ status: number; body: string }> {
    const res = await fetch(`${runsOrigin}${path}`, {
      method: "POST",
      headers: { ...asRepWeb(), "content-type": "application/json" },
      body: JSON.stringify({ runId }),
    });
    return { status: res.status, body: await res.text() };
  }

  it("reads each run with its name, its state word, one detail and its steps — and never another twin's", async () => {
    const res = await readRunsAt();
    expect(res.status).toBe(200);
    const read = JSON.parse(res.body) as TwinRuns;
    expect(read.today).toBe("2026-08-29");
    expect(read.runs.map((run) => run.runId)).toEqual([waiting, finished]);
    expect(read.runs[0]).toMatchObject({
      name: "Revisar lo de Sergio",
      automation: "inline",
      state: "waiting",
      paused: false,
      cancelled: false,
      detail: { step: 1, of: 3, kind: "wait", until: THURSDAY.toISOString(), awaits: "clock" },
      steps: [
        { kind: "wait", state: "waiting" },
        { kind: "agent", state: "pending" },
        { kind: "post", state: "pending" },
      ],
    });
    expect(read.runs[1]).toMatchObject({ state: "succeeded", day: "2026-08-28" });
    expect(JSON.stringify(read)).not.toContain(theirs);
    const elsewhere = await readRunsAt(other.seatId);
    expect(elsewhere.status).toBe(403);
  });

  it("takes Pausar, Reanudar and Cancelar as dashboard acts, each with its row and its execution, and leaves the acts log as it was", async () => {
    const logBefore = await ask(
      `${TWIN_API_ROUTES.actsLog}?now=${encodeURIComponent(READING.toISOString())}`,
      asRepWeb(),
    );
    expect(JSON.parse((await runAct(TWIN_API_ACT_ROUTES.pauseRun, waiting)).body)).toEqual({ outcome: "performed" });
    expect(JSON.parse((await runAct(TWIN_API_ACT_ROUTES.pauseRun, waiting)).body)).toEqual({ outcome: "already" });
    expect((JSON.parse((await readRunsAt()).body) as TwinRuns).runs[0]).toMatchObject({ paused: true });
    expect(JSON.parse((await runAct(TWIN_API_ACT_ROUTES.resumeRun, waiting)).body)).toEqual({ outcome: "performed" });
    expect(JSON.parse((await runAct(TWIN_API_ACT_ROUTES.cancelRun, waiting)).body)).toEqual({ outcome: "performed" });
    expect((JSON.parse((await readRunsAt()).body) as TwinRuns).runs[0]).toMatchObject({ paused: false, cancelled: true });
    // A FLAG NEVER LANDS ON A RUN THAT IS OVER.
    expect(JSON.parse((await runAct(TWIN_API_ACT_ROUTES.pauseRun, finished)).body)).toEqual({ outcome: "refused" });

    const rows = await withClient((client) =>
      client.query<{ verb: string; outcome: string; post_id: string | null }>(
        "SELECT verb, outcome, post_id FROM dashboard_acts WHERE run_id = $1 ORDER BY acted_at, id",
        [waiting],
      ),
    );
    expect(rows.rows.map((row) => [row.verb, row.outcome, row.post_id])).toEqual([
      ["pause_run", "performed", null],
      ["pause_run", "already", null],
      ["resume_run", "performed", null],
      ["cancel_run", "performed", null],
    ]);
    const executions = await withClient((client) =>
      client.query<{ disposition: string }>(
        "SELECT disposition FROM executions WHERE trigger_kind = 'dashboard_act' AND trigger_ref LIKE $1 ORDER BY started_at, id",
        [`% run:${waiting} %`],
      ),
    );
    expect(executions.rows.map((row) => row.disposition)).toEqual(["acted", "no-action", "acted", "acted"]);
    const logAfter = await ask(
      `${TWIN_API_ROUTES.actsLog}?now=${encodeURIComponent(READING.toISOString())}`,
      asRepWeb(),
    );
    expect(logAfter.body).toBe(logBefore.body);
  });

  it("refuses an act on another twin's run, writing no row and changing nothing", async () => {
    expect(JSON.parse((await runAct(TWIN_API_ACT_ROUTES.cancelRun, theirs)).body)).toEqual({ outcome: "refused" });
    const run = await withClient((client) =>
      client.query<{ cancelled: boolean }>("SELECT cancelled FROM runs WHERE id = $1", [theirs]),
    );
    expect(run.rows).toEqual([{ cancelled: false }]);
    const rows = await withClient((client) =>
      client.query("SELECT 1 FROM dashboard_acts WHERE run_id = $1", [theirs]),
    );
    expect(rows.rows).toEqual([]);
    const malformed = await runAct(TWIN_API_ACT_ROUTES.cancelRun, "no-es-un-id");
    expect(malformed.status).toBe(400);
  });
});

describe("Rutinas: the proposals, Activar, Descartar and the switch, over the wire (ticket #325 AC 2–4)", () => {
  let api: LocalApi;
  let apiOrigin: string;
  /** A proposal the rep will activate, one they will discard, and one of the other twin's. */
  let proposal: string;
  let discarded: string;
  let theirs: string;
  const DEFINITION: RunDefinition = {
    name: "Clientes sin contacto de la semana",
    budget: { iterations: 6, tokens: 120_000 },
    steps: [
      { kind: "agent", name: "find", instructions: "List them.", tools: ["search_memory"], output: { list: "string" } },
      { kind: "wait", name: "breathe", until: { after: { days: 1 } } },
      { kind: "post", name: "report", text: "find.list" },
    ],
  };
  const SENTENCE = "Cada viernes a las 9 te mando la lista de los clientes sin contacto de la semana.";
  const FRIDAYS: RutinaWake = { kind: "schedule", every: "week", weekdays: [5], atHour: 9 };

  async function seedRutina(client: pg.Client, twin: Twin, origin: "rep" | "twin"): Promise<string> {
    const id = randomUUID();
    await insertRutina(client, twin.bundle, {
      id,
      twinId: twin.twinId,
      seatId: twin.seatId,
      origin,
      wake: FRIDAYS,
      definition: DEFINITION,
      sentence: SENTENCE,
      executionId: randomUUID(),
      evidenceRef: randomUUID(),
      writtenAt: READING,
    });
    return id;
  }

  beforeAll(async () => {
    await withClient(async (client) => {
      proposal = await seedRutina(client, served, "rep");
      discarded = await seedRutina(client, served, "twin");
      theirs = await seedRutina(client, other, "rep");
    });
    api = await startLocalApi(
      {
        db: pool,
        twinId: served.twinId,
        dek: served.dek,
        bearer: BEARER,
        timeZone: ZONE,
        acts: { hmacKey: TEST_AUDIT_HMAC_KEY, bundle: served.bundle, selfChatJid: SELF_CHAT },
      },
      { port: 0 },
    );
    apiOrigin = `http://127.0.0.1:${String(api.port)}`;
  });

  afterAll(async () => {
    await api.close();
  });

  /** One of Dito's cards, and the rutinas the twin authored, out of the one list. */
  const dittos = (read: TwinRoutines): TwinShippedAutomation[] =>
    read.automations.flatMap((card) => (card.origin === "dito" ? [card] : []));
  const rutinasOf = (read: TwinRoutines): TwinRutina[] =>
    read.automations.flatMap((card) => (card.origin === "dito" ? [] : [card]));

  async function readRutinas(): Promise<TwinRoutines> {
    const res = await fetch(
      `${apiOrigin}${TWIN_API_ROUTES.routines}?now=${encodeURIComponent(READING.toISOString())}`,
      { headers: asRepWeb() },
    );
    expect(res.status).toBe(200);
    return JSON.parse(await res.text()) as TwinRoutines;
  }

  async function automationAct(path: string, automation: string): Promise<{ status: number; body: string }> {
    const res = await fetch(`${apiOrigin}${path}`, {
      method: "POST",
      headers: { ...asRepWeb(), "content-type": "application/json" },
      body: JSON.stringify({ automation }),
    });
    return { status: res.status, body: await res.text() };
  }

  /** The act rows and the chain entries an automation's acts left. */
  async function tracesOf(automation: string): Promise<{ acts: string[][]; entries: number }> {
    return await withClient(async (client) => {
      const acts = await client.query<{ verb: string; outcome: string }>(
        "SELECT verb, outcome FROM dashboard_acts WHERE automation = $1 ORDER BY acted_at, id",
        [automation],
      );
      const entries = await client.query(
        "SELECT 1 FROM audit_chain WHERE ref LIKE '%automation:' || $1 || '%'",
        [automation],
      );
      return { acts: acts.rows.map((row) => [row.verb, row.outcome]), entries: entries.rows.length };
    });
  }

  it("reads Dito's own with their switch, from one list — a pending rutina nowhere on it (#386), never another twin's", async () => {
    const read = await readRutinas();
    expect(dittos(read).map((card) => [card.shipped, card.paused])).toEqual([
      ["drafting", false],
      ["extraction", false],
      ["daily_disclosure", false],
      ["reminders", false],
      ["overnight_requests", false],
    ]);
    // A PROPOSAL IS A CARD WHERE THE REP IS, never a row of Rutinas.
    expect(rutinasOf(read)).toEqual([]);
    expect(JSON.stringify(read)).not.toContain(theirs);
    // THE THREAD IS NEVER ON RUTINAS: it is the twin itself.
    expect(JSON.stringify(read)).not.toContain("twin_thread");
  });

  it("Activar sets a proposal active with its audit line — Rutinas lists it then, with its plan — and a second press is `already`", async () => {
    expect(JSON.parse((await automationAct(TWIN_API_ACT_ROUTES.activateAutomation, proposal)).body)).toEqual({
      outcome: "performed",
    });
    expect(rutinasOf(await readRutinas()).find((rutina) => rutina.id === proposal)).toEqual({
      id: proposal,
      origin: "rep",
      state: "active",
      name: "Clientes sin contacto de la semana",
      sentence: SENTENCE,
      wake: { kind: "schedule", every: "week", weekdays: [5], atHour: 9 },
      plan: [
        { kind: "agent", depth: 0 },
        { kind: "wait", depth: 0, wait: { after: { days: 1 } } },
        { kind: "post", depth: 0 },
      ],
      paused: false,
      // READ ON SATURDAY 29 AUGUST: the Friday after, at nine on the rep's clock (ticket #387).
      nextFiring: { at: "2026-09-04T15:00:00.000Z", day: "2026-09-04" },
    });
    expect(JSON.parse((await automationAct(TWIN_API_ACT_ROUTES.activateAutomation, proposal)).body)).toEqual({
      outcome: "already",
    });
    expect(await tracesOf(proposal)).toEqual({
      acts: [
        ["activate_automation", "performed"],
        ["activate_automation", "already"],
      ],
      entries: 2,
    });
  });

  it("Descartar ends the proposal's row and its cadence — kept, marked ended — and deletes its content in the bundle", async () => {
    expect(JSON.parse((await automationAct(TWIN_API_ACT_ROUTES.discardAutomation, discarded)).body)).toEqual({
      outcome: "performed",
    });
    // NOTHING LEFT FOR THE PASS'S SWEEP: the act deleted the content once its row had ended.
    expect(await withClient((client) => sweepRutinaContent(client, served.bundle, served.twinId))).toBe(0);
    expect(rutinasOf(await readRutinas()).map((rutina) => rutina.id)).not.toContain(discarded);
    const left = await withClient(async (client) => ({
      rows: (await client.query("SELECT 1 FROM automations WHERE id = $1 AND ended_at IS NOT NULL", [discarded])).rows.length,
      cadences: (await client.query("SELECT 1 FROM schedules WHERE automation_id = $1 AND ended_at IS NOT NULL", [discarded]))
        .rows.length,
    }));
    expect(left).toEqual({ rows: 1, cadences: 1 });
    expect(served.bundle.readAutomation(discarded)).toBeUndefined();
    expect((await tracesOf(discarded)).acts).toEqual([["discard_automation", "performed"]]);
  });

  it("the switch writes the seat's pause and an audit line per flip, by the row, for one of Dito's and for an active rutina — and Descartar refuses one of Dito's", async () => {
    const extraction = dittos(await readRutinas()).find((card) => card.shipped === "extraction")!.id;
    expect(JSON.parse((await automationAct(TWIN_API_ACT_ROUTES.pauseAutomation, extraction)).body)).toEqual({
      outcome: "performed",
    });
    expect(JSON.parse((await automationAct(TWIN_API_ACT_ROUTES.pauseAutomation, extraction)).body)).toEqual({
      outcome: "already",
    });
    expect(dittos(await readRutinas()).find((card) => card.id === extraction)?.paused).toBe(true);
    const row = await withClient((client) =>
      client.query<{ seat_id: string; paused: boolean }>(
        "SELECT seat_id, paused FROM automation_pauses WHERE twin_id = $1 AND automation_id = $2",
        [served.twinId, extraction],
      ),
    );
    expect(row.rows).toEqual([{ seat_id: served.seatId, paused: true }]);
    expect(JSON.parse((await automationAct(TWIN_API_ACT_ROUTES.resumeAutomation, extraction)).body)).toEqual({
      outcome: "performed",
    });
    expect(dittos(await readRutinas()).find((card) => card.id === extraction)?.paused).toBe(false);
    expect(JSON.parse((await automationAct(TWIN_API_ACT_ROUTES.discardAutomation, extraction)).body)).toEqual({
      outcome: "refused",
    });
    expect(await tracesOf(extraction)).toEqual({
      acts: [
        ["pause_automation", "performed"],
        ["pause_automation", "already"],
        ["resume_automation", "performed"],
        ["discard_automation", "refused"],
      ],
      entries: 4,
    });

    // THE ACTIVE RUTINA'S SWITCH, the same act.
    expect(JSON.parse((await automationAct(TWIN_API_ACT_ROUTES.pauseAutomation, proposal)).body)).toEqual({
      outcome: "performed",
    });
    expect(rutinasOf(await readRutinas()).find((rutina) => rutina.id === proposal)?.paused).toBe(true);
  });

  it("refuses an act on another twin's rutina, writing no row, and a body naming no automation", async () => {
    expect(JSON.parse((await automationAct(TWIN_API_ACT_ROUTES.activateAutomation, theirs)).body)).toEqual({
      outcome: "refused",
    });
    expect((await tracesOf(theirs)).acts).toEqual([]);
    const state = await withClient((client) =>
      client.query<{ state: string }>("SELECT state FROM automations WHERE id = $1", [theirs]),
    );
    expect(state.rows).toEqual([{ state: "pending" }]);
    expect((await automationAct(TWIN_API_ACT_ROUTES.pauseAutomation, "extraction")).status).toBe(400);
    expect((await automationAct(TWIN_API_ACT_ROUTES.discardAutomation, "no-es-un-id")).status).toBe(400);
  });
});

describe("a run's question card answered over the wire, and its children read with it (ticket #324)", () => {
  let askApi: LocalApi;
  let askOrigin: string;
  const harnessDirectory = (): string => join(tmp, "served.harness");
  const NOW = new Date("2026-08-29T15:00:00.000Z");
  const ASKS: RunDefinition = {
    name: "Elegir con quién",
    budget: { iterations: 1, tokens: 1 },
    steps: [
      {
        kind: "ask",
        name: "choose",
        question: { value: "¿Con quién empiezo?" },
        fields: [
          { name: "who", kind: "pick_one", options: { value: ["Laura", "Torres"] } },
          { name: "when", kind: "date" },
        ],
      },
      { kind: "end", name: "done", value: "choose.who" },
    ],
  };
  let runId: string;
  let card: string;

  /** One pass of the engine over the served twin, as the runtime's poll makes it. */
  async function pass(client: pg.Client): Promise<void> {
    const batch = openBatchWork();
    await advanceRuns(
      {
        db: client,
        executionPool,
        harness: { directory: harnessDirectory(), apiKey: "never-called" },
        bundle: served.bundle,
        dek: served.dek,
        twinId: served.twinId,
        selfChatJid: SELF_CHAT,
        hmacKey: TEST_AUDIT_HMAC_KEY,
        embedder: fakeEmbedder(),
        drafting: { model: "claude-sonnet-5" },
        runs: createRunEngine(),
      },
      NOW,
      batch,
    );
    await batch.lane.settle();
  }

  async function answer(body: unknown): Promise<{ status: number; body: string }> {
    const res = await fetch(`${askOrigin}${TWIN_API_ACT_ROUTES.answerAsk}`, {
      method: "POST",
      headers: { ...asRepWeb(), "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.text() };
  }

  beforeAll(async () => {
    await withClient(async (client) => {
      runId = randomUUID();
      writeRunContent(harnessDirectory(), served.dek, runId, { definition: ASKS, inputs: {}, outputs: {} });
      await insertRun(client, {
        id: runId,
        twinId: served.twinId,
        seatId: served.seatId,
        automation: "inline",
        digest: runDigest(ASKS),
        sessionId: randomUUID(),
        stepCount: 2,
        budget: ASKS.budget,
        createdBy: "thread",
      });
      await pass(client);
      const posted = await client.query<{ awaits_post_id: string }>(
        "SELECT awaits_post_id FROM run_steps WHERE run_id = $1 AND state = 'waiting'",
        [runId],
      );
      card = posted.rows[0]!.awaits_post_id;
    });
    askApi = await startLocalApi(
      {
        db: pool,
        twinId: served.twinId,
        dek: served.dek,
        bearer: BEARER,
        timeZone: ZONE,
        acts: { hmacKey: TEST_AUDIT_HMAC_KEY, bundle: served.bundle, selfChatJid: SELF_CHAT },
        harnessDirectory: harnessDirectory(),
      },
      { port: 0 },
    );
    askOrigin = `http://127.0.0.1:${String(askApi.port)}`;
  });

  afterAll(async () => {
    await askApi.close();
  });

  it("refuses a body that is not typed answers, and an answer the card's own fields do not take", async () => {
    expect((await answer({ postId: card, answers: "Laura" })).status).toBe(400);
    expect((await answer({ postId: card, answers: { who: 3 } })).status).toBe(400);
    expect(JSON.parse((await answer({ postId: card, answers: { who: "Sergio", when: "2026-09-01" } })).body)).toEqual({ outcome: "refused" });
    expect(JSON.parse((await answer({ postId: card, answers: { who: "Laura" } })).body)).toEqual({ outcome: "refused" });
    expect(JSON.parse((await answer({ postId: card, answers: { who: "Laura", when: "el lunes" } })).body)).toEqual({ outcome: "refused" });
  });

  it("writes the answer once — into the run's sealed content, never a row — and refuses a second", async () => {
    expect(JSON.parse((await answer({ postId: card, answers: { who: "Torres", when: "2026-09-01" } })).body)).toEqual({ outcome: "performed" });
    expect(JSON.parse((await answer({ postId: card, answers: { who: "Laura", when: "2026-09-02" } })).body)).toEqual({ outcome: "refused" });
    await withClient(async (client) => {
      const acts = await client.query<{ verb: string; outcome: string; post_id: string }>(
        "SELECT verb, outcome, post_id FROM dashboard_acts WHERE post_id = $1 AND outcome IS NOT NULL ORDER BY acted_at, id",
        [card],
      );
      expect(acts.rows.map((row) => [row.verb, row.outcome])).toContainEqual(["answer_ask", "performed"]);
      expect(acts.rows.filter((row) => row.outcome === "performed")).toHaveLength(1);
      const digest = await client.query<{ definition_digest: string }>("SELECT definition_digest FROM runs WHERE id = $1", [runId]);
      const content = readRunContent(harnessDirectory(), served.dek, runId, digest.rows[0]!.definition_digest);
      expect(content.answers).toEqual({ choose: { who: "Torres", when: "2026-09-01" } });
      const rows = await client.query("SELECT r.*, s.* FROM runs r JOIN run_steps s ON s.run_id = r.id WHERE r.id = $1", [runId]);
      expect(JSON.stringify(rows.rows)).not.toContain("Torres");
      // THE ENGINE TAKES IT UP AT ITS NEXT PASS: the step's output is the answer.
      await pass(client);
      const ended = await client.query<{ state: string }>("SELECT state FROM runs WHERE id = $1", [runId]);
      expect(ended.rows).toEqual([{ state: "succeeded" }]);
    });
  });

  it("reads a run's children with the parent they belong to", async () => {
    const parent = randomUUID();
    const child = randomUUID();
    await withClient(async (client) => {
      for (const [id, parentRunId] of [
        [parent, undefined],
        [child, parent],
      ] as const) {
        writeRunContent(harnessDirectory(), served.dek, id, { definition: ASKS, inputs: {}, outputs: {} });
        await insertRun(client, {
          id,
          twinId: served.twinId,
          seatId: served.seatId,
          automation: "inline",
          digest: runDigest(ASKS),
          sessionId: randomUUID(),
          stepCount: 2,
          budget: ASKS.budget,
          createdBy: "thread",
          ...(parentRunId === undefined ? {} : { parentRunId }),
        });
      }
    });
    const res = await fetch(`${askOrigin}${TWIN_API_ROUTES.runs}?now=${encodeURIComponent(READING.toISOString())}`, {
      headers: asRepWeb(),
    });
    const read = JSON.parse(await res.text()) as TwinRuns;
    expect(read.runs.find((run) => run.runId === child)).toMatchObject({ parentRunId: parent });
    expect(read.runs.find((run) => run.runId === parent)).not.toHaveProperty("parentRunId");
  });
});

/**
 * A RUN'S REPORT HANDS THE REP A DOCUMENT AND A LIST (ticket #326 AC 2): the
 * feed and the canvas open both parts under the twin's key, and the document
 * opens by its version's id through the runtime — this twin's, for this
 * twin's seat, and no other's.
 */
describe("a workspace document and a list, at the runtime's door (ticket #326)", () => {
  const CONTENT = "# Hoteles en Madrid\n\n1. Hotel Prado, junto al museo.\n";

  /** One version written into a twin's bundle, as a step boundary leaves it. */
  function versionIn(twin: Twin, path: string) {
    const version = {
      id: randomUUID(),
      path,
      version: 1,
      sha256: "scripted",
      title: "Hoteles en Madrid",
      content: CONTENT,
      writtenAt: READING.toISOString(),
      executionId: randomUUID(),
    };
    twin.bundle.writeWorkspaceVersion(version);
    return version;
  }

  it("opens both parts in the feed and puts the report on the canvas, with no path and no text on the wire", async () => {
    const version = versionIn(served, "reporte.md");
    const executionId = randomUUID();
    let cardOfRow = "";
    await withClient(async (client) => {
      await client.query("BEGIN");
      await new TwinExecutionStore({ client, twinId: served.twinId, executionId }).recordExecution({
        trigger: { kind: "run_step", mechanism: "request", twinId: served.twinId, runId: randomUUID(), step: 2 },
        instructionsDigest: "deterministic",
        toolNames: [],
        startedAt: READING,
        endedAt: READING,
        iterations: 0,
        tokens: { input: 0, output: 0 },
        disposition: "posted",
        lane: "batch",
      });
      const customers = customersOf(served.bundle, SELF_CHAT);
      // THE CARD THE TWIN MARKED THE NAME WITH (ticket #401): the customer's waiting draft.
      const draft = await client.query<{ id: string }>(
        `SELECT p.id FROM posts p JOIN drafts d ON d.id = p.draft_id
          WHERE p.twin_id = $1 AND d.destination = $2 AND p.id = ANY($3::uuid[])
          ORDER BY p.posted_at DESC LIMIT 1`,
        [served.twinId, CUSTOMER, [...(await waitingCandidates({ db: client, twinId: served.twinId }, READING))]],
      );
      cardOfRow = draft.rows[0]!.id;
      const reference = served.bundle.referenceForChat(CUSTOMER);
      const row = `[[c${String(reference)}]](${cardOfRow}) pide la lista de precios`;
      await insertNoticeWithSystemSend(client, {
        twinId: served.twinId,
        selfChatJid: SELF_CHAT,
        dek: served.dek,
        kind: "answer",
        executionId,
        post: composeAnswerPost({
          answer: "Te dejé los hoteles y lo que quedó pendiente.",
          mentions: [],
          list: listPart([{ text: row, mentions: mentionsIn(row, customers) }]),
          documents: [documentPart(version)],
        }),
      });
      await client.query("COMMIT");
    });

    const page = JSON.parse((await ask(FEED, asRepWeb())).body) as { posts: TwinFeedPost[] };
    const report = page.posts.find((post) => post.parts.some((part) => part.kind === "document"))!;
    expect(report.parts.find((part) => part.kind === "document")).toEqual({
      kind: "document",
      documentId: version.id,
      title: "Hoteles en Madrid",
      version: 1,
      // «LISTO»: the report has no act of its own (ticket #368).
      acts: ["clear"],
    });
    expect(report.parts.find((part) => part.kind === "data")).toMatchObject({
      kind: "data",
      // A ROW OPENS THE CARD THE TWIN MARKED ITS NAME WITH, which waits (ticket #401).
      rows: [
        {
          text: expect.stringContaining(`](${cardOfRow}) pide la lista de precios`) as unknown,
          mentions: [expect.objectContaining({ name: `${PUSH_NAME} (sin confirmar)` })],
        },
      ],
      acts: ["clear"],
    });
    const wire = JSON.stringify(report);
    expect(wire).not.toContain("reporte.md");
    expect(wire).not.toContain("Hotel Prado");

    const canvas = JSON.parse(
      (await ask(`${TWIN_API_ROUTES.canvas}?now=${encodeURIComponent(READING.toISOString())}`, asRepWeb())).body,
    ) as TwinCanvas;
    expect(canvas.waiting.map((post) => post.id)).toContain(report.id);
  });

  it("answers a document's title and text by its id, read-only, and no route for another twin's", async () => {
    const mine = versionIn(served, "hoteles.md");
    const theirs = versionIn(other, "hoteles.md");

    const res = await ask(`${TWIN_API_ROUTES.document}${mine.id}`, asRepWeb());
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ documentId: mine.id, title: "Hoteles en Madrid", version: 1, content: CONTENT });
    expect(res.body).not.toContain("hoteles.md");

    const stranger = await ask(`${TWIN_API_ROUTES.document}${theirs.id}`, asRepWeb());
    expect(stranger.status).toBe(404);
    expect(JSON.parse(stranger.body)).toEqual({ error: "no_route" });
    const otherSeat = await ask(`${TWIN_API_ROUTES.document}${mine.id}`, asRepWeb(other.seatId));
    expect(otherSeat.status).not.toBe(200);
    const unsigned = await ask(`${TWIN_API_ROUTES.document}${mine.id}`, { [TWIN_API_SEAT_HEADER]: served.seatId });
    expect(unsigned.status).toBe(401);
  });

  it("lists every document's latest version, newest first, with no path and no text — this twin's, for this twin's seat (ticket #368)", async () => {
    const first = versionIn(served, "lista-precios.md");
    const second = { ...first, id: randomUUID(), version: 2, writtenAt: new Date(READING.getTime() + 60_000).toISOString() };
    served.bundle.writeWorkspaceVersion(second);
    versionIn(other, "de-otro.md");

    const res = await ask(TWIN_API_ROUTES.documents, asRepWeb());
    expect(res.status).toBe(200);
    const listed = (JSON.parse(res.body) as TwinDocuments).documents;
    // ONE ROW PER DOCUMENT, ITS LATEST VERSION, newest first.
    expect(listed[0]).toEqual({ documentId: second.id, title: "Hoteles en Madrid", version: 2, writtenAt: second.writtenAt });
    expect(listed.filter((one) => one.documentId === first.id)).toEqual([]);
    expect(new Set(listed.map((one) => one.documentId)).size).toBe(listed.length);
    expect(res.body).not.toContain(".md");
    expect(res.body).not.toContain("Hotel Prado");
    const otherSeat = await ask(TWIN_API_ROUTES.documents, asRepWeb(other.seatId));
    expect(otherSeat.status).not.toBe(200);
  });
});
