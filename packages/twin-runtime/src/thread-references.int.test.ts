/**
 * THE TWIN NAMES A CUSTOMER BY ONE STABLE REFERENCE, AT THE POSTGRES SEAM
 * (ticket #321; spec #318 decisions 16 and 18; D15; ADR-0037, ADR-0039 and
 * ADR-0013 as amended; CONTEXT.md *Reference*).
 *
 * The ticket's acceptance criteria as one file: a reply naming two customers
 * by reference renders both confirmed names on the phone and on the
 * dashboard, the two-chat customer with the number's tail; a reference that
 * names nobody is sent back once and the record shows the retry; a draft to a
 * customer by reference and a chat pick lands in that chat and its card shows
 * the tail; and on the dashboard a name opens only the card the twin marked it with,
 * read through the runtime API over a real server.
 *
 * THE SEAM IS THE AGREEMENT (spec #18; spec #318's Testing Decisions).
 * `wa_events` and door rows in with real DEK-encrypted payloads; out the other
 * side the `drafts` row with its frozen Borrador, the posts and notices, the
 * rep-side `executions` row and the event's marker. Real Postgres, real
 * envelope crypto, real SQLCipher (ADR-0028); the model is the scripted model
 * server and CI never calls one.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBundle, type Bundle } from "@dito/bundle";
import { createDekFromMaterial, type Dek } from "@dito/crypto";
import {
  TWIN_API_ROUTES,
  TWIN_API_SEAT_HEADER,
  type TwinExchanges,
  type TwinFeedPost,
} from "@dito/seam";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { processPendingWaEvents, type TwinRuntimeDeps } from "./consumer.js";
import { startLocalApi } from "./local-api.js";
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
import { newExecutionPool } from "./testing/execution-pool.js";
import { fakeEmbedder } from "./testing/fake-embedder.js";
import { insertWaEvent, simulateExecutorPost } from "./testing/seam-fixtures.js";
import {
  closeScriptedModels,
  scriptedModel,
  toolResultsOf,
  type Script,
  type ScriptedTurn,
} from "./testing/scripted-model.js";
import { seatAtTheDoor, typeAtTheDoor } from "./testing/door.js";
import { SETTLE_IMMEDIATELY } from "./testing/settle.js";
import { removeTmpDir } from "./testing/tmp.js";
import { RESOLVE_CHAT_TOOL } from "./thread/tools.js";
import { CREATE_DRAFT_TOOL } from "./thread/write.js";

// Every scripted model this suite opened is closed with it (#328).
afterAll(closeScriptedModels);

const SELF_CHAT = "5215550000@s.whatsapp.net";
const TORRES_A = "5215550001@s.whatsapp.net";
const TORRES_B = "5215550002@s.whatsapp.net";
const GARZA = "5215550003@s.whatsapp.net";
const DIEGO_0537 = "5218110000537@s.whatsapp.net";
const DIEGO_8416 = "5218110008416@s.whatsapp.net";
const ZONE = "America/Monterrey";

const BODY = "Ya está lista la factura, se la mando hoy mismo.";

/** One connection source for every execution this suite runs. */
const executionPool = newExecutionPool();

let tmp: string;
let pool: pg.Pool;

beforeAll(async () => {
  await resetAndMigrate();
  tmp = mkdtempSync(join(tmpdir(), "dito-references-int-"));
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

function depsFor(
  client: pg.Client,
  twin: Twin,
  script: Script = [],
): { deps: TwinRuntimeDeps; requests: Record<string, unknown>[] } {
  const { harness, requests } = scriptedModel(script);
  return {
    requests,
    deps: {
      db: client,
      executionPool,
      harness,
      bundle: twin.bundle,
      dek: twin.dek,
      twinId: twin.twinId,
      selfChatJid: SELF_CHAT,
      // This file is not about batching (see testing/settle.ts).
      ...SETTLE_IMMEDIATELY,
      drafting: { model: "claude-sonnet-5" },
      embedder: fakeEmbedder(),
      sendLock: createSendLockWriter({ pool, hmacKey: TEST_AUDIT_HMAC_KEY }),
      hmacKey: TEST_AUDIT_HMAC_KEY,
      timeZone: ZONE,
    },
  };
}

/**
 * A chat the REP has confirmed — the only kind `resolve_chat` can return
 * and the only kind `create_draft` can write to — and the customer's
 * reference, which the confirmation gives.
 *
 * Written straight into the entity mirror, bypassing the ceremony: what
 * this file is about is what happens AFTER a binding exists, and #34's own
 * suite is where the ceremony is proven. `entityId` puts a second chat on an
 * existing customer — the two-number customer no production path writes yet
 * (no merge path exists), planted here so the tail and the pick are built
 * against it.
 */
function bind(twin: Twin, chatJid: string, displayName: string, entityId = randomUUID()): string {
  twin.bundle.confirmChatBinding({
    chatJid,
    entityId,
    displayName,
    confirmedAt: new Date(Date.UTC(2026, 7, 27, 17, 0, twin.bundle.listChatBindings().length)).toISOString(),
  });
  return `c${String(twin.bundle.referenceOfEntity(entityId))}`;
}

/** The writer's config: the hard allowlist and conservative pacing. */
async function seedSendConfig(
  client: pg.Client,
  twinId: string,
  destination: string,
): Promise<void> {
  await client.query(
    "INSERT INTO send_allowlist (twin_id, destination_jid) VALUES ($1, $2)",
    [twinId, destination],
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

/** One customer message in a chat, so twin memory holds something of theirs. */
async function customerWrites(
  client: pg.Client,
  twin: Twin,
  chatJid: string,
  text: string,
  at = new Date("2026-08-26T16:42:00Z"),
): Promise<void> {
  await insertWaEvent(client, twin.dek, {
    twinId: twin.twinId,
    chatJid,
    senderJid: chatJid,
    fromMe: false,
    messageId: `3EB0-C-${randomUUID().slice(0, 8)}`,
    text,
    pushName: "quien sea",
    backfill: true,
    occurredAt: at,
  });
  await processPendingWaEvents(depsFor(client, twin).deps);
}

/** One rep message in their own thread, quoting a post of the twin's. */
async function repWrites(
  client: pg.Client,
  twin: Twin,
  text: string,
  quotedMessageId?: string,
): Promise<string> {
  return insertWaEvent(client, twin.dek, {
    twinId: twin.twinId,
    chatJid: SELF_CHAT,
    senderJid: SELF_CHAT,
    fromMe: true,
    messageId: `3EB0-REP-${randomUUID().slice(0, 8)}`,
    text,
    ...(quotedMessageId === undefined ? {} : { quotedMessageId }),
    occurredAt: new Date("2026-08-27T09:00:00Z"),
  });
}

/** The scripted turns of a twin that looks a name up and writes to the customer. */
function resolvesAndWrites(options: {
  readonly name: string;
  readonly entity: string;
  readonly chat?: number;
  readonly answer: string;
  readonly body?: string;
}): ScriptedTurn[] {
  return [
    {
      toolCall: { name: RESOLVE_CHAT_TOOL, input: { name: options.name } },
    },
    ...writes(options),
  ];
}

/** ...and of one that writes to a customer it already holds the reference of. */
function writes(options: {
  readonly entity: string;
  readonly chat?: number;
  readonly answer: string;
  readonly body?: string;
}): ScriptedTurn[] {
  return [
    {
      toolCall: {
        name: CREATE_DRAFT_TOOL,
        input: {
          entity: options.entity,
          ...(options.chat === undefined ? {} : { chat: options.chat }),
          text: options.body ?? BODY,
        },
      },
    },
    says(options.answer),
  ];
}

/** The twin's words, ending its turn (ticket #363). */
function says(answer: string): ScriptedTurn {
  return { text: answer };
}

/** Every draft this twin holds, with its frozen Borrador, oldest first. */
async function draftsOf(
  client: pg.Client,
  twin: Twin,
): Promise<
  {
    id: string;
    destination: string;
    post: string;
    body: string;
    inReplyTo: string | null;
  }[]
> {
  const res = await client.query<{
    id: string;
    destination: string;
    post_enc: Buffer;
    content_enc: Buffer;
    in_reply_to_event_id: string | null;
  }>(
    `SELECT id, destination, post_enc, content_enc, in_reply_to_event_id
       FROM drafts WHERE twin_id = $1 ORDER BY created_at, id`,
    [twin.twinId],
  );
  return res.rows.map((row) => ({
    id: row.id,
    destination: row.destination,
    post: Buffer.from(twin.dek.decrypt(row.post_enc)).toString("utf8"),
    body: Buffer.from(twin.dek.decrypt(row.content_enc)).toString("utf8"),
    inReplyTo: row.in_reply_to_event_id,
  }));
}

/** Every twin post in the thread, decrypted, in the order the rep sees them. */
async function twinPosts(
  client: pg.Client,
  twin: Twin,
): Promise<{ kind: string; text: string }[]> {
  const res = await client.query<{ kind: string; content_enc: Buffer }>(
    `SELECT n.kind, n.content_enc
       FROM notices n
       JOIN send_commands sc ON sc.payload_ref = 'notice:' || n.id
      WHERE n.twin_id = $1 AND sc.twin_id = $1
      ORDER BY sc.created_at, sc.id`,
    [twin.twinId],
  );
  return res.rows.map((row) => ({
    kind: row.kind,
    text: Buffer.from(twin.dek.decrypt(row.content_enc)).toString("utf8"),
  }));
}

async function disposition(client: pg.Client, eventId: string): Promise<string> {
  const res = await client.query<{ disposition: string }>(
    "SELECT disposition FROM wa_event_processing WHERE event_id = $1",
    [eventId],
  );
  return res.rows[0]?.disposition ?? "(none)";
}

/** Every execution this twin ran, oldest first — the rep-side record. */
async function executions(
  client: pg.Client,
  twinId: string,
): Promise<{ id: string; disposition: string }[]> {
  const res = await client.query<{ id: string; disposition: string }>(
    "SELECT id, disposition FROM executions WHERE twin_id = $1 ORDER BY started_at, id",
    [twinId],
  );
  return res.rows;
}

/** Posts a draft as the executor would, so the rep can quote its Borrador. */
async function postDraft(
  client: pg.Client,
  twin: Twin,
  draftId: string,
): Promise<string> {
  const command = await client.query<{ id: string }>(
    "SELECT id FROM send_commands WHERE payload_ref = $1",
    [`draft:${draftId}`],
  );
  const waMessageId = `WAMID-DRAFT-${randomUUID().slice(0, 8)}`;
  await simulateExecutorPost(client, {
    commandId: command.rows[0]!.id,
    twinId: twin.twinId,
    waMessageId,
  });
  return waMessageId;
}


/** What the runtime API reads back for a seat, over a real server. */
async function withApi<T>(
  twin: Twin,
  seatId: string,
  read: (get: (route: string) => Promise<unknown>) => Promise<T>,
): Promise<T> {
  const bearer = "references-integration-bearer";
  const api = await startLocalApi(
    {
      db: pool,
      twinId: twin.twinId,
      dek: twin.dek,
      bearer,
      timeZone: ZONE,
      acts: { hmacKey: TEST_AUDIT_HMAC_KEY, bundle: twin.bundle, selfChatJid: SELF_CHAT },
    },
    { port: 0 },
  );
  try {
    return await read(async (route) => {
      const res = await fetch(
        `http://127.0.0.1:${String(api.port)}${route}?now=${encodeURIComponent(new Date().toISOString())}`,
        { headers: { authorization: `Bearer ${bearer}`, [TWIN_API_SEAT_HEADER]: seatId } },
      );
      expect(res.status).toBe(200);
      return (await res.json()) as unknown;
    });
  } finally {
    await api.close();
  }
}

/** The prose of the bar's one reply, as rep-web receives it. */
function replyProse(exchanges: TwinExchanges): Extract<TwinFeedPost["parts"][number], { kind: "prose" }> {
  const reply = exchanges.days.flatMap((day) => day.exchanges).at(-1)?.reply;
  const prose = reply?.parts.find((part) => part.kind === "prose");
  if (prose?.kind !== "prose") throw new Error("the bar's reply carries no prose");
  return prose;
}

describe("a reply names customers by reference and code renders their names (AC 1)", () => {
  it("renders both confirmed names in the self-chat, the two-chat customer with the number's tail", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const garza = bind(twin, GARZA, "Sra. Garza");
      const diego = randomUUID();
      const two = bind(twin, DIEGO_8416, "Diego Zertuche", diego);
      bind(twin, DIEGO_0537, "Diego Zertuche", diego);
      const eventId = await repWrites(client, twin, "¿quién me pidió cajas?");
      await processPendingWaEvents(
        depsFor(client, twin, [
          { toolCall: { name: RESOLVE_CHAT_TOOL, input: { name: "Garza" } } },
          says(`${`[${garza}]`} y [${two}] te pidieron cajas.`),
        ]).deps,
      );
      expect(await twinPosts(client, twin)).toEqual([
        { kind: "answer", text: "✳️ Sra. Garza y Diego Zertuche (…8416, …0537) te pidieron cajas." },
      ]);
      expect(await disposition(client, eventId)).toBe("answered");
      twin.bundle.close();
    });
  });

  it("renders both names on the dashboard too: the bar's reply carries each customer, the two-chat one with both tails", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const seat = await seatAtTheDoor(client, twin.twinId);
      const garza = bind(twin, GARZA, "Sra. Garza");
      const diego = randomUUID();
      const two = bind(twin, DIEGO_8416, "Diego Zertuche", diego);
      bind(twin, DIEGO_0537, "Diego Zertuche", diego);
      await typeAtTheDoor(client, twin, seat, "¿quién me pidió cajas?");
      await processPendingWaEvents(
        depsFor(client, twin, [
          { toolCall: { name: RESOLVE_CHAT_TOOL, input: { name: "Garza" } } },
          says(`[${garza}] y [${two}] te pidieron cajas.`),
        ]).deps,
      );
      const prose = replyProse(
        await withApi(twin, seat.seatId, async (get) => (await get(TWIN_API_ROUTES.exchanges)) as TwinExchanges),
      );
      expect(prose.text).toBe(`[${garza}] y [${two}] te pidieron cajas.`);
      expect(prose.mentions).toEqual([
        { reference: garza, name: "Sra. Garza" },
        { reference: two, name: "Diego Zertuche", tails: ["8416", "0537"] },
      ]);
      twin.bundle.close();
    });
  });

  it("sends a reference that names no customer back to the model once, and the record counts the retry", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const torres = bind(twin, TORRES_A, "Torres");
      await repWrites(client, twin, "¿qué onda con Torres?");
      const { deps, requests } = depsFor(client, twin, [
        { toolCall: { name: RESOLVE_CHAT_TOOL, input: { name: "Torres" } } },
        says("[c99] te pidió la factura."),
        says(`[${torres}] te pidió la factura.`),
      ]);
      await processPendingWaEvents(deps);

      // THE FAKE'S NEXT REQUEST CARRIES THE REFUSAL — sent back, never kept.
      expect(JSON.stringify(requests[2]!["messages"])).toContain(
        "your line carries [c99], which names no customer",
      );
      expect(await twinPosts(client, twin)).toEqual([
        { kind: "answer", text: "✳️ Torres te pidió la factura." },
      ]);
      const record = await client.query<{ iterations: number; disposition: string }>(
        "SELECT iterations, disposition FROM executions WHERE twin_id = $1",
        [twin.twinId],
      );
      // THREE ROUNDS — the lookup, the refused line and the one kept: one
      // more than a turn whose first line stands.
      expect(record.rows).toEqual([{ iterations: 3, disposition: "answered" }]);
      twin.bundle.close();
    });
  });
});

describe("«escríbele a Torres…» yields a Borrador for Torres's chat, by reference (AC 2)", () => {
  it("looks the name up, writes the inert draft to the customer's chat, frames the confirmed name, and records `drafted`", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const torres = bind(twin, TORRES_A, "Torres");
      bind(twin, GARZA, "Sra. Garza");
      await customerWrites(client, twin, TORRES_A, "¿ya salió mi factura?");
      const eventId = await repWrites(client, twin, "escríbele a Torres que ya está la factura");
      const { deps, requests } = depsFor(
        client,
        twin,
        resolvesAndWrites({
          name: "Torres",
          entity: torres,
          answer: `Listo, ahí está el borrador para [${torres}].`,
        }),
      );
      await processPendingWaEvents(deps);

      // WHAT THE LOOKUP SHOWED THE MODEL: the reference, the name, the chat.
      expect(toolResultsOf(requests[1]).join("\n")).toContain(`[${torres}] Torres — one chat:`);
      const drafts = await draftsOf(client, twin);
      expect(drafts).toHaveLength(1);
      expect(drafts[0]!.destination).toBe(TORRES_A);
      expect(drafts[0]!.body).toBe(BODY);
      expect(drafts[0]!.inReplyTo).toBe(eventId);
      // THE TURN'S WORDS ABOVE THE FRAME, the customer's name rendered by
      // code (ticket #368); ONE CHAT, SO NO TAIL: the frame is the frame it
      // always was.
      expect(drafts[0]!.post.startsWith("✳️ Listo, ahí está el borrador para Torres.\n\n*Borrador — para Torres*")).toBe(true);
      expect(drafts[0]!.post).not.toContain("…");
      expect(drafts[0]!.post).not.toContain("(sin confirmar)");

      // ITS TIMING ROW NAMES THIS EXECUTION, from the run's own holder now
      // that no focus carries it.
      const [execution] = await executions(client, twin.twinId);
      const timings = await client.query<{ execution_id: string; ordered: boolean }>(
        `SELECT execution_id,
                (event_received_at <= runtime_seen_at
                 AND runtime_seen_at <= draft_ready_at) AS ordered
           FROM draft_timings WHERE draft_id = $1`,
        [drafts[0]!.id],
      );
      expect(timings.rows).toEqual([{ execution_id: execution!.id, ordered: true }]);
      // THE ACT WORD OF THE EFFECT IT PERFORMED (ticket #363): a draft.
      expect(execution!.disposition).toBe("drafted");
      expect(await disposition(client, eventId)).toBe("drafted");
      // THE WORDS RIDE THE BORRADOR (ticket #368): the phone reads one
      // message, so no reply posts beside it.
      expect(await twinPosts(client, twin)).toEqual([]);
      twin.bundle.close();
    });
  });

  it("carries no «su chat» provenance and no «Porque:» line, and keeps the label (ticket #368)", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const torres = bind(twin, TORRES_A, "Torres");
      await repWrites(client, twin, "escríbele a Torres que ya está la factura");
      await processPendingWaEvents(
        depsFor(client, twin, resolvesAndWrites({ name: "Torres", entity: torres, answer: "Listo." })).deps,
      );
      const [draft] = await draftsOf(client, twin);
      expect(draft!.post).toContain("*Borrador — para Torres*");
      expect(draft!.post).not.toContain("Porque:");
      expect(draft!.post).not.toContain("su chat");
      twin.bundle.close();
    });
  });

  it("writes to the chat the twin picked for a customer with two numbers, the card shows its tail, and a missing pick is sent back", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const diego = randomUUID();
      const reference = bind(twin, DIEGO_0537, "Diego Zertuche", diego);
      bind(twin, DIEGO_8416, "Diego Zertuche", diego);
      await customerWrites(client, twin, DIEGO_0537, "¿y la cotización?", new Date("2026-08-12T18:00:00Z"));
      await customerWrites(client, twin, DIEGO_8416, "¿ya salió mi factura?", new Date("2026-08-26T18:00:00Z"));
      const eventId = await repWrites(client, twin, "escríbele a Diego que ya salió su factura");
      const { deps, requests } = depsFor(client, twin, [
        { toolCall: { name: RESOLVE_CHAT_TOOL, input: { name: "Diego Zertuche" } } },
        { toolCall: { name: "search_memory", input: { about: "factura", counterparty: null } } },
        // NO PICK FOR A CUSTOMER WITH TWO CHATS: sent back, nothing written.
        { toolCall: { name: CREATE_DRAFT_TOOL, input: { entity: reference, text: BODY } } },
        // A PICK OUTSIDE THEIR CHATS: sent back too.
        { toolCall: { name: CREATE_DRAFT_TOOL, input: { entity: reference, chat: 3, text: BODY } } },
        ...writes({ entity: reference, chat: 2, answer: `Listo, le escribí a [${reference}].` }),
      ]);
      await processPendingWaEvents(deps);

      // ONE REFERENCE, BOTH CHATS — in the order the rep confirmed them.
      const lookup = toolResultsOf(requests[1]).join("\n");
      expect(lookup).toContain(`[${reference}] Diego Zertuche — 2 chats; say which when you write to them:`);
      expect(lookup).toContain("chat 1: number ending 0537; the other side last wrote on Wednesday, Aug 12, 2026");
      expect(lookup).toContain("chat 2: number ending 8416; the other side last wrote on Wednesday, Aug 26, 2026");
      // THE SEARCH SAYS WHICH OF THEIR CHATS EACH MESSAGE CAME OUT OF — what
      // the twin picks the chat by.
      const found = toolResultsOf(requests[2]).join("\n");
      expect(found).toContain(
        `the rep's conversation with [${reference}] Diego Zertuche (the chat with the number ending 8416) — the other side wrote: ¿ya salió mi factura?`,
      );
      const refusals = toolResultsOf(requests[4]).join("\n");
      expect(refusals).toContain("has 2 chats, so say which one");
      expect(refusals).toContain("is not one of");

      const drafts = await draftsOf(client, twin);
      expect(drafts.map((draft) => draft.destination)).toEqual([DIEGO_8416]);
      // THE PHONE'S FRAME AND THE DASHBOARD'S CARD BOTH SHOW WHICH NUMBER.
      expect(drafts[0]!.post).toContain("\n\n*Borrador — para Diego Zertuche (…8416)*");
      const card = await client.query<{ id: string }>("SELECT id FROM posts WHERE draft_id = $1", [drafts[0]!.id]);
      const [read] = await withApi(twin, (await seatAtTheDoor(client, twin.twinId)).seatId, async (get) =>
        ((await get(TWIN_API_ROUTES.canvas)) as { waiting: TwinFeedPost[] }).waiting.filter(
          (post) => post.id === card.rows[0]!.id,
        ),
      );
      expect(read?.customer).toBe(reference);
      expect(read?.parts.find((part) => part.kind === "draft")).toMatchObject({
        counterparty: "Diego Zertuche",
        tail: "8416",
      });
      // THE TURN'S WORDS NAME THE CUSTOMER WITH BOTH TAILS — one reference, two
      // numbers — and ride the Borrador, so no reply posts beside it (ticket #368).
      expect(drafts[0]!.post.startsWith("✳️ Listo, le escribí a Diego Zertuche (…0537, …8416).\n\n")).toBe(true);
      expect((await twinPosts(client, twin)).filter((post) => post.kind === "answer")).toEqual([]);
      expect(await disposition(client, eventId)).toBe("drafted");
      twin.bundle.close();
    });
  });

  it("never writes to a chat nobody has confirmed, by whatever reference names it", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await customerWrites(client, twin, TORRES_A, "¿ya salió mi factura?");
      const unconfirmed = `c${String(twin.bundle.referenceForChat(TORRES_A))}`;
      const eventId = await repWrites(client, twin, "escríbele a quien sea");
      const { deps, requests } = depsFor(client, twin, [
        { toolCall: { name: CREATE_DRAFT_TOOL, input: { entity: unconfirmed, text: BODY } } },
        says("No me has dicho quién es, así que no le escribo."),
      ]);
      // THE REPLY RESTS ON NOTHING THE RECORD HOLDS, so it needs a lookup:
      // the scripted turn above has none and the guard asks for a search.
      await processPendingWaEvents(deps);
      expect(toolResultsOf(requests[1]).join("\n")).toContain("nobody has confirmed");
      expect(await draftsOf(client, twin)).toEqual([]);
      expect(await disposition(client, eventId)).not.toBe("drafted");
      twin.bundle.close();
    });
  });
});

describe("a search scoped by reference looks through that customer alone (Codex r2)", () => {
  it("searches the one Torres the reference names, every chat of theirs, and refuses a reference that names nobody", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      bind(twin, TORRES_A, "Torres");
      const other = bind(twin, TORRES_B, "Torres");
      await customerWrites(client, twin, TORRES_A, "¿me apartas 40 cajas?");
      await customerWrites(client, twin, TORRES_B, "necesito 12 cajas de bujías");
      await repWrites(client, twin, "¿qué quería el otro Torres?");
      const { deps, requests } = depsFor(client, twin, [
        { toolCall: { name: "search_memory", input: { about: "cajas", counterparty: other } } },
        { toolCall: { name: "search_memory", input: { about: "cajas", counterparty: "[c99]" } } },
        says(`[${other}] quería 12 cajas de bujías.`),
      ]);
      await processPendingWaEvents(deps);
      const [scoped, refused] = toolResultsOf(requests[2]);
      expect(scoped).toContain("necesito 12 cajas de bujías");
      expect(scoped).not.toContain("¿me apartas 40 cajas?");
      expect(refused).toContain("[c99], which names no customer");
      twin.bundle.close();
    });
  });
});

describe("a tap on a rep-initiated Borrador sends exactly as today (FR-70)", () => {
  it("mints the tap and the customer send through the unchanged path", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const torres = bind(twin, TORRES_A, "Torres");
      await seedSendConfig(client, twin.twinId, TORRES_A);
      await repWrites(client, twin, "escríbele a Torres que ya está la factura");
      await processPendingWaEvents(
        depsFor(client, twin, resolvesAndWrites({ name: "Torres", entity: torres, answer: "Listo." })).deps,
      );
      const [draft] = await draftsOf(client, twin);
      const waMessageId = await postDraft(client, twin, draft!.id);
      const vaId = await repWrites(client, twin, "va", waMessageId);
      await processPendingWaEvents(depsFor(client, twin).deps);
      expect(await disposition(client, vaId)).toBe("affirmed");
      const sends = await client.query<{ destination: string }>(
        `SELECT destination FROM send_commands WHERE twin_id = $1 AND send_class = 'customer_send'`,
        [twin.twinId],
      );
      expect(sends.rows).toEqual([{ destination: TORRES_A }]);
      twin.bundle.close();
    });
  });
});

describe("two customers of one name are two references, and the rep's answer is the twin's to read", () => {
  it("asks between them by reference, and a later turn — a new session — writes to the one picked by that reference alone", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const hermanos = bind(twin, TORRES_A, "Torres Hermanos");
      const juan = bind(twin, TORRES_B, "Juan Torres");
      const askId = await repWrites(client, twin, "escríbele a Torres que ya está la factura");
      await processPendingWaEvents(
        depsFor(client, twin, [
          { toolCall: { name: RESOLVE_CHAT_TOOL, input: { name: "Torres" } } },
          says(`¿[${hermanos}] o [${juan}]?`),
        ]).deps,
      );
      expect(await draftsOf(client, twin)).toEqual([]);
      expect(await twinPosts(client, twin)).toEqual([
        { kind: "answer", text: "✳️ ¿Torres Hermanos o Juan Torres?" },
      ]);
      expect(await disposition(client, askId)).toBe("answered");

      // «EL SEGUNDO» — the reference names the same customer in any turn, so
      // nothing is looked up again and no store re-serves anything.
      const pickId = await repWrites(client, twin, "el segundo");
      const { deps, requests } = depsFor(client, twin, writes({ entity: juan, answer: `Listo, para [${juan}].` }));
      await processPendingWaEvents(deps);
      const drafts = await draftsOf(client, twin);
      expect(drafts.map((draft) => draft.destination)).toEqual([TORRES_B]);
      expect(drafts[0]!.post).toContain("\n\n*Borrador — para Juan Torres*");
      expect(await disposition(client, pickId)).toBe("drafted");
      expect(
        requests.map((request) => JSON.stringify(request["messages"])).join(" "),
      ).not.toContain("resolve_chat");
      twin.bundle.close();
    });
  });

  it("posts a choice that names a conversation nobody confirmed as words, and asks the ceremony nothing (#363)", async () => {
    // THE WORDS ARE ONLY WORDS: a choice is the twin's sentence, and the
    // question whether a chat is a customer is `propose_binding`'s alone.
    await withClient(async (client) => {
      const twin = freshTwin();
      const hermanos = bind(twin, TORRES_A, "Torres Hermanos");
      await customerWrites(client, twin, GARZA, "¿ya salió mi factura?");
      const nobody = `c${String(twin.bundle.referenceForChat(GARZA))}`;
      await repWrites(client, twin, "escríbele a Torres que ya está la factura");
      const { deps } = depsFor(client, twin, [
        { toolCall: { name: RESOLVE_CHAT_TOOL, input: { name: "Torres" } } },
        says(`¿[${hermanos}] o [${nobody}]?`),
      ]);
      await processPendingWaEvents(deps);
      const posts = await twinPosts(client, twin);
      expect(posts.map((post) => post.kind)).toEqual(["answer"]);
      expect(posts[0]!.text).toContain("¿Torres Hermanos o ");
      twin.bundle.close();
    });
  });
});

describe("a name the twin cannot reach gets a sentence and no draft", () => {
  it("says so for a name nothing is bound under, resting on the lookup alone", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await customerWrites(client, twin, GARZA, "¿me apartas 40 cajas?");
      const eventId = await repWrites(client, twin, "escríbele a Pérez que ya salió");
      await processPendingWaEvents(
        depsFor(client, twin, [
          { toolCall: { name: RESOLVE_CHAT_TOOL, input: { name: "Pérez" } } },
          says("No tengo un chat guardado con ese nombre."),
        ]).deps,
      );
      expect(await draftsOf(client, twin)).toEqual([]);
      expect(await twinPosts(client, twin)).toEqual([
        { kind: "answer", text: "✳️ No tengo un chat guardado con ese nombre." },
      ]);
      expect(await disposition(client, eventId)).toBe("answered");
      twin.bundle.close();
    });
  });

  it("refuses a `create_draft` for a reference that names nobody, and the twin can still answer", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      bind(twin, TORRES_A, "Torres");
      const eventId = await repWrites(client, twin, "escríbele a alguien");
      await processPendingWaEvents(
        depsFor(client, twin, [
          { toolCall: { name: CREATE_DRAFT_TOOL, input: { entity: "c77", text: BODY } } },
          { toolCall: { name: "search_memory", input: { about: "alguien", counterparty: null } } },
          says("¿A quién le escribo?"),
        ]).deps,
      );
      expect(await draftsOf(client, twin)).toEqual([]);
      expect(await disposition(client, eventId)).toBe("answered");
      twin.bundle.close();
    });
  });
});

describe("two tools in ONE response share one connection (#195, Codex r1)", () => {
  it("searches and drafts in the same message, and leaves a record either way", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const torres = bind(twin, TORRES_A, "Torres");
      await customerWrites(client, twin, TORRES_A, "¿ya salió mi factura?");
      await repWrites(client, twin, "escríbele a Torres que ya está la factura");
      await processPendingWaEvents(
        depsFor(client, twin, [
          { toolCall: { name: RESOLVE_CHAT_TOOL, input: { name: "Torres" } } },
          {
            toolCalls: [
              { name: "search_memory", input: { about: "factura", counterparty: null } },
              {
                name: CREATE_DRAFT_TOOL,
                input: { entity: torres, text: "Ya está la factura." },
              },
            ],
          },
          says(`Listo, para [${torres}].`),
        ]).deps,
      );
      const drafts = await draftsOf(client, twin);
      expect(drafts.map((draft) => draft.destination)).toEqual([TORRES_A]);
      const runs = await client.query<{ disposition: string }>(
        "SELECT disposition FROM executions WHERE twin_id = $1",
        [twin.twinId],
      );
      expect(runs.rows.map((row) => row.disposition)).toEqual(["drafted"]);
      twin.bundle.close();
    });
  });
});

describe("on the dashboard a name opens only the card the twin marked it with (AC 4; ticket #401)", () => {
  it("leaves a name the twin marked with no card plain, even with the customer's card waiting — code picks none", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const seat = await seatAtTheDoor(client, twin.twinId);
      const torres = bind(twin, TORRES_A, "Torres");
      const garza = bind(twin, GARZA, "Sra. Garza");
      await customerWrites(client, twin, TORRES_A, "¿ya salió mi factura?");
      await typeAtTheDoor(client, twin, seat, "escríbele a Torres que ya está la factura");
      await processPendingWaEvents(
        depsFor(client, twin, [
          { toolCall: { name: RESOLVE_CHAT_TOOL, input: { name: "Torres" } } },
          ...writes({ entity: torres, answer: `Listo: [${torres}] tiene su borrador; [${garza}] no ha escrito.` }),
        ]).deps,
      );
      expect(await draftsOf(client, twin)).toHaveLength(1);

      // THE BAR'S HISTORY: both names, neither linked — the twin marked no card.
      const read = replyProse(
        await withApi(twin, seat.seatId, async (get) => (await get(TWIN_API_ROUTES.exchanges)) as TwinExchanges),
      );
      expect(read.text).toBe(`Listo: [${torres}] tiene su borrador; [${garza}] no ha escrito.`);
      expect(read.mentions).toEqual([
        { reference: torres, name: "Torres" },
        { reference: garza, name: "Sra. Garza" },
      ]);
      twin.bundle.close();
    });
  });
});

describe("the focus is gone: the bundle holds no store for it", () => {
  it("opens at the version that dropped it, and a whole turn writes nothing of the kind", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const torres = bind(twin, TORRES_A, "Torres");
      await repWrites(client, twin, "escríbele a Torres que ya está la factura");
      await processPendingWaEvents(
        depsFor(client, twin, resolvesAndWrites({ name: "Torres", entity: torres, answer: "Listo." })).deps,
      );
      expect(twin.bundle.listStores()).not.toContain("focus");
      expect(twin.bundle.listStores()).toContain("customer_references");
      twin.bundle.close();
    });
  });
});
