/**
 * OWN SENDS ENTER TWIN MEMORY (ticket #63).
 *
 * WhatsApp syncs a rep's outgoing messages to their OTHER linked devices.
 * The plane is the device that sent them, so it never receives its own echo
 * — and until #63 nothing else wrote them down. Every message the twin sent
 * on the rep's behalf was invisible to the twin the moment it left: at the
 * #57 rig session the customer chat held six messages, every one inbound,
 * while three `customer_send`s had gone out with outcome `sent`. Extraction
 * filed nothing from a conversation that plainly contained a commitment,
 * and it was right to: a price GIVEN, a date PROMISED and an order ACCEPTED
 * are all things the REP says.
 *
 * Tested across the primary Postgres seam, the same one slices 1–3 use. The
 * whole loop runs for real — inbound fixture → draft → quoted «va» → tap +
 * `customer_send` through the real send-lock writer → the executor's post,
 * simulated at the seam exactly as `plane/executor` performs it (the Go side
 * is proven in `plane/executor/own_send_int_test.go` against a stubbed
 * socket) → the own-send capture → the bundle → the daily extraction pass.
 * Real Postgres, real envelope crypto, real SQLCipher (ADR-0028); the model
 * is scripted at the model boundary, and the suites that must
 * make NO model call script it empty so a call fails loudly.
 *
 * The properties: the capture lands with the rail's own id and the chat's
 * canonical identity; the capture guard governs it (`scope_allowlist`, NOT
 * `send_allowlist` — different lists); extraction can finally read the rep's
 * half; and the write-back opens no feedback loop — the twin's own words can
 * never mint a tap, answer a question, confirm a binding, or draft a reply.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  auditSelfChatExclusion,
  fileEntityCreate,
  readFiledFacts,
  type FiledFact,
} from "@dito/aperture";
import { createBundle, type Bundle } from "@dito/bundle";
import { createDekFromMaterial, type Dek } from "@dito/crypto";
import { decodeWaMessagePayload, reconcileFr70 } from "@dito/seam";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { processPendingWaEvents, type TwinRuntimeDeps } from "./consumer.js";
import { runDailyExtraction } from "./testing/by-hand.js";
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
  extractionTurns,
  qaSilenceTurns,
  scriptedModel,
  type Script,
  type ScriptedTurn,
} from "./testing/scripted-model.js";
import { isThreadTurn } from "./testing/thread-script.js";
import { SETTLE_IMMEDIATELY } from "./testing/settle.js";
import { newExecutionPool } from "./testing/execution-pool.js";

// Every scripted model this suite opened is closed with it (#328).
afterAll(closeScriptedModels);

/** One connection source for every execution this suite runs (ticket #173). */
const executionPool = newExecutionPool();

const SELF_CHAT = "5215550000@s.whatsapp.net";
const ZONE = "America/Monterrey";

/** The rep's day under test: 2026-08-29 in America/Monterrey (UTC-6). */
const MORNING = new Date("2026-08-29T15:20:00Z");
const AFTERNOON = new Date("2026-08-29T22:10:00Z");
const NOW = new Date("2026-08-30T03:30:00Z");
const YESTERDAY = new Date("2026-08-28T20:00:00Z");

/**
 * The seam dedupes on `(source, external_event_id)` and composes that id as
 * `<chat jid>:<message id>` — GLOBALLY, across twins (ADR-0005) — so every
 * twin here gets its own customer number.
 */
let chatCounter = 0;

let tmp: string;
let pool: pg.Pool;

beforeAll(async () => {
  await resetAndMigrate();
  tmp = mkdtempSync(join(tmpdir(), "dito-own-sends-int-"));
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
    chat: `52155${String(630000 + chatCounter)}@s.whatsapp.net`,
  };
}

/** Rig provisioning: what a twin needs before it can send or remember. */
async function provision(
  client: pg.Client,
  twin: Twin,
  opts: { inScope?: boolean } = {},
): Promise<void> {
  await client.query(
    "INSERT INTO send_allowlist (twin_id, destination_jid) VALUES ($1, $2)",
    [twin.twinId, twin.chat],
  );
  await client.query(
    "INSERT INTO pacing_thresholds (twin_id, max_sends_per_hour, min_seconds_between_sends) VALUES ($1, $2, $3)",
    [
      twin.twinId,
      CONSERVATIVE_DEV_PACING.maxSendsPerHour,
      // Nothing here is measuring pacing, and the loop taps within seconds.
      0,
    ],
  );
  // The CAPTURE list, which is a different list from the SEND one above —
  // and that difference is the point of one of the tests below.
  if (opts.inScope !== false) {
    await client.query(
      "INSERT INTO scope_allowlist (twin_id, chat_jid) VALUES ($1, $2)",
      [twin.twinId, twin.chat],
    );
  }
}

function depsFor(
  client: pg.Client,
  twin: Twin,
  turns: Script = [],
): TwinRuntimeDeps {
  return depsAndRequests(client, twin, turns).deps;
}

/**
 * The same deps, keeping the scripted client's request log — which is how a
 * test reads what the twin actually put in front of the model, rather than
 * only what came back.
 */
function depsAndRequests(
  client: pg.Client,
  twin: Twin,
  turns: Script = [],
): { deps: TwinRuntimeDeps; requests: Record<string, unknown>[] } {
  const { harness, requests } = scriptedModel(turns);
  const deps: TwinRuntimeDeps = {
    db: client,
    harness,
    bundle: twin.bundle,
    dek: twin.dek,
    twinId: twin.twinId,
    selfChatJid: SELF_CHAT,
    // Ticket #75: this suite is not about batching (see testing/settle.ts).
    ...SETTLE_IMMEDIATELY,
    drafting: { model: "claude-sonnet-5" },
    executionPool,
    sendLock: createSendLockWriter({ pool, hmacKey: TEST_AUDIT_HMAC_KEY }),
    hmacKey: TEST_AUDIT_HMAC_KEY,
    embedder: fakeEmbedder(),
    timeZone: ZONE,
  };
  return { deps, requests };
}

/**
 * The rep's half of the conversation — the half that was invisible. It
 * carries all three of the fact types a REP commits: a price GIVEN, an order
 * ACCEPTED and a date PROMISED (#63; the fourth type, ContactEstablished,
 * is the customer's to state).
 */
const DRAFT_TEXT =
  "Sí, se los tomo: 3 millares a $8,400 cada uno, y se los mando el sábado 5 de septiembre.";

function draftingTurns(text = DRAFT_TEXT): ScriptedTurn[] {
  return [
    { toolCall: { name: "create_draft", input: { text: text } } },
    { text: "done" },
  ];
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
 * The rep-confirmed binding, as slice 2 produces one: the twin asked, the
 * rep said «si», the mirror holds the binding and the aperture filed the
 * entity create. Extraction's input set is the BOUND chats, so nothing
 * crosses without this.
 *
 * THE «si» EVENT IS A SYNTHETIC RECORD, and since #174 it is one the router
 * has an opinion about: the id it quotes resolves to no post this twin
 * made, so the message reaches the thread execution rather than ending in
 * silence — which is the ticket's own claim that every rep message in the
 * thread has a path. Suites using this fixture therefore script a silence
 * on whichever pass consumes it (`qaSilenceTurns()`).
 */
async function bindChat(
  client: pg.Client,
  twin: Twin,
  displayName: string,
): Promise<string> {
  const entityId = randomUUID();
  const short = entityId.slice(0, 8);
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
    quotedMessageId: `WAMID-Q-${short}`,
    occurredAt: YESTERDAY,
  });
  twin.bundle.confirmChatBinding({
    chatJid: twin.chat,
    entityId,
    displayName,
    confirmedAt: YESTERDAY.toISOString(),
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

interface SeamRow {
  readonly id: string;
  readonly externalEventId: string;
  readonly occurredAt: Date;
  readonly payload: ReturnType<typeof decodeWaMessagePayload>;
}

/** Twin memory's inbound door, for one chat, decrypted under the twin DEK. */
async function seamRows(
  client: pg.Client,
  twin: Twin,
  chatJid: string,
): Promise<SeamRow[]> {
  const res = await client.query<{
    id: string;
    external_event_id: string;
    occurred_at: Date;
    payload_enc: Buffer;
  }>(
    `SELECT id, external_event_id, occurred_at, payload_enc
       FROM wa_events
      WHERE twin_id = $1
        AND left(external_event_id, length($2::text) + 1) = $2 || ':'
      ORDER BY id`,
    [twin.twinId, chatJid],
  );
  return res.rows.map((row) => ({
    id: row.id,
    externalEventId: row.external_event_id,
    occurredAt: row.occurred_at,
    payload: decodeWaMessagePayload(twin.dek, row.payload_enc),
  }));
}

async function dispositions(
  client: pg.Client,
  twin: Twin,
): Promise<Record<string, string>> {
  const res = await client.query<{ event_id: string; disposition: string }>(
    "SELECT event_id, disposition FROM wa_event_processing WHERE twin_id = $1",
    [twin.twinId],
  );
  return Object.fromEntries(res.rows.map((r) => [r.event_id, r.disposition]));
}

/**
 * The whole loop, up to and including the executor's delivery of the tapped
 * draft: inbound → draft → posted → «va» → tap + customer_send → sent.
 *
 * Returns the ids a test needs to talk about what happened.
 */
async function runTheLoop(
  client: pg.Client,
  twin: Twin,
  opts: {
    draftText?: string;
    /** Skip the tap, so nothing is ever delivered (the control). */
    deliver?: boolean;
    ownSendMessageId: string;
  },
): Promise<{ draftId: string; customerSendId: string | undefined }> {
  // A RULE RATHER THAN A FLAT LIST (ticket #174). The binding fixture's
  // «si» quotes a post this twin never made, so it reaches the thread
  // execution — and a pass that runs a thread turn AND a drafting turn
  // cannot be scripted as one cursor, because the two interleave at their
  // model calls (`lanes.ts`). Keyed by the prompt, each gets its own.
  const deps = depsFor(client, twin, (prompt) =>
    isThreadTurn(prompt) ? qaSilenceTurns() : draftingTurns(opts.draftText),
  );
  await insertWaEvent(client, twin.dek, {
    twinId: twin.twinId,
    companyId: twin.companyId,
    seatId: twin.seatId,
    chatJid: twin.chat,
    senderJid: twin.chat,
    fromMe: false,
    messageId: `WAMID-IN-${opts.ownSendMessageId}`,
    text: "¿en cuánto me sale el millar y para cuándo me lo tienes?",
    pushName: "Ferretería Fuentes",
    occurredAt: MORNING,
  });
  await processPendingWaEvents(deps);

  const draftRes = await client.query<{ id: string }>(
    "SELECT id FROM drafts WHERE twin_id = $1",
    [twin.twinId],
  );
  const draftId = draftRes.rows[0]!.id;
  const systemSend = await client.query<{ id: string }>(
    `SELECT id FROM send_commands
      WHERE twin_id = $1 AND send_class = 'system_send' AND payload_ref = $2`,
    [twin.twinId, `draft:${draftId}`],
  );
  const draftPostId = `WAMID-POST-${opts.ownSendMessageId}`;
  await simulateExecutorPost(client, {
    commandId: systemSend.rows[0]!.id,
    twinId: twin.twinId,
    waMessageId: draftPostId,
    plane: {
      dek: twin.dek,
      selfJid: SELF_CHAT,
      companyId: twin.companyId,
      seatId: twin.seatId,
    },
  });
  if (opts.deliver === false) {
    return { draftId, customerSendId: undefined };
  }

  // The rep taps.
  await insertWaEvent(client, twin.dek, {
    twinId: twin.twinId,
    companyId: twin.companyId,
    seatId: twin.seatId,
    chatJid: SELF_CHAT,
    senderJid: SELF_CHAT,
    fromMe: true,
    messageId: `WAMID-VA-${opts.ownSendMessageId}`,
    text: "va",
    quotedMessageId: draftPostId,
    occurredAt: AFTERNOON,
  });
  await processPendingWaEvents(deps);

  const customerSend = await client.query<{ id: string }>(
    `SELECT id FROM send_commands
      WHERE twin_id = $1 AND send_class = 'customer_send' AND draft_id = $2`,
    [twin.twinId, draftId],
  );
  expect(customerSend.rows).toHaveLength(1);

  // ...and the executor delivers it. THIS is the step that, before #63,
  // recorded `send_executions` and stopped.
  await simulateExecutorPost(client, {
    commandId: customerSend.rows[0]!.id,
    twinId: twin.twinId,
    waMessageId: opts.ownSendMessageId,
    executedAt: AFTERNOON,
    plane: {
      dek: twin.dek,
      selfJid: SELF_CHAT,
      companyId: twin.companyId,
      seatId: twin.seatId,
    },
  });
  return { draftId, customerSendId: customerSend.rows[0]!.id };
}

describe("the twin's own sends enter twin memory (ticket #63)", () => {
  it("a delivered customer_send lands as a from_me message on the destination chat, with the rail's own id", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await provision(client, twin);
      await runTheLoop(client, twin, { ownSendMessageId: "WAMID-OWN-A" });

      const rows = await seamRows(client, twin, twin.chat);
      expect(rows.map((r) => r.payload.messageId)).toEqual([
        "WAMID-IN-WAMID-OWN-A",
        "WAMID-OWN-A",
      ]);
      const own = rows[1]!;
      expect(own.externalEventId).toBe(`${twin.chat}:WAMID-OWN-A`);
      expect(own.payload.fromMe).toBe(true);
      expect(own.payload.chatJid).toBe(twin.chat);
      expect(own.payload.senderJid).toBe(SELF_CHAT);
      expect(own.payload.text).toBe(DRAFT_TEXT);
      // The send's real instant, not the pass's wall clock.
      expect(own.occurredAt.toISOString()).toBe(AFTERNOON.toISOString());
      // No push-name: the rep is not a counterparty.
      expect(own.payload.pushName).toBeUndefined();

      // ...and it reaches the bundle as the rep's own line, so the twin
      // reads the conversation the way the rep sees it.
      await processPendingWaEvents(depsFor(client, twin));
      const conversation = twin.bundle.readConversation(twin.chat);
      expect(
        conversation.map((row) => [row.fromMe, row.content] as const),
      ).toEqual([
        [false, "¿en cuánto me sale el millar y para cuándo me lo tienes?"],
        [true, DRAFT_TEXT],
      ]);

      // FR-70 stays green: recording what was sent creates no outbound and
      // no second send path.
      const fr70 = await reconcileFr70(client);
      expect(fr70.violations).toEqual([]);
      expect(fr70.customerSends).toBeGreaterThanOrEqual(1);
      twin.bundle.close();
    });
  });

  it("extraction can finally see the rep's commitment — where the same candidates filed nothing before", async () => {
    await withClient(async (client) => {
      // THE CONTROL, first: the identical draft, never tapped, so the
      // executor never delivered it and the rep's words are nowhere on the
      // seam. The model is scripted to submit exactly the same two facts,
      // citing the same message id — and they are refused, because that
      // message is not in the day the pass read. This is the defect, on
      // purpose.
      const before = freshTwin();
      await provision(client, before);
      await bindChat(client, before, "Ferretería Fuentes");
      await runTheLoop(client, before, {
        ownSendMessageId: "WAMID-OWN-CONTROL",
        deliver: false,
      });
      // The binding fixture's «si» is still pending and now reaches the
      // execution (see `bindChat`): scripted silent, which is the honest
      // scripting for a synthetic record of a message the twin never posted.
      await processPendingWaEvents(depsFor(client, before, qaSilenceTurns()));
      await runDailyExtraction(
        {
          ...depsFor(
            client,
            before,
            extracted(
              {
                fact_type: "QuoteGiven",
                message_id: "WAMID-OWN-CONTROL",
                confidence: 0.95,
                item: "millar",
                amount: 8400,
                currency: "MXN",
              },
              {
                fact_type: "OrderTaken",
                message_id: "WAMID-OWN-CONTROL",
                confidence: 0.95,
                item: "millar",
                quantity: 3,
                unit: "millares",
              },
              {
                fact_type: "DatePromised",
                message_id: "WAMID-OWN-CONTROL",
                confidence: 0.95,
                commitment: "que se los mandas el sábado",
                due_on: "2026-09-05",
              },
            ),
          ),
          bundle: before.bundle,
        },
        NOW,
      );
      const controlFacts = await readFiledFacts(
        { db: client, dek: before.dek },
        before.twinId,
      );
      // Nothing crossed. `readFiledFacts` reads facts; the entity create is
      // an entity row with its own disclosure line, not a fact — so an empty
      // list here is exactly the rig's finding: a conversation that plainly
      // contained a commitment produced no fact.
      expect(controlFacts).toEqual([]);
      // ...and the run recorded WHY: two candidates, none filed, both
      // refused for citing a message the pass never read.
      const controlRun = await client.query<{
        candidates: number;
        filed: number;
        refused: number;
      }>(
        "SELECT candidates, filed, refused FROM extraction_runs WHERE twin_id = $1",
        [before.twinId],
      );
      expect(controlRun.rows).toEqual([
        { candidates: 3, filed: 0, refused: 3 },
      ]);
      before.bundle.close();

      // ...AND NOW, with #63's write-back, the same day and the same
      // candidates.
      const after = freshTwin();
      await provision(client, after);
      await bindChat(client, after, "Ferretería Fuentes");
      await runTheLoop(client, after, { ownSendMessageId: "WAMID-OWN-B" });
      await processPendingWaEvents(depsFor(client, after, qaSilenceTurns()));
      await runDailyExtraction(
        {
          ...depsFor(
            client,
            after,
            extracted(
              {
                fact_type: "QuoteGiven",
                message_id: "WAMID-OWN-B",
                confidence: 0.95,
                item: "millar",
                amount: 8400,
                currency: "MXN",
              },
              {
                fact_type: "OrderTaken",
                message_id: "WAMID-OWN-B",
                confidence: 0.95,
                item: "millar",
                quantity: 3,
                unit: "millares",
              },
              {
                fact_type: "DatePromised",
                message_id: "WAMID-OWN-B",
                confidence: 0.95,
                commitment: "que se los mandas el sábado",
                due_on: "2026-09-05",
              },
            ),
          ),
          bundle: after.bundle,
        },
        NOW,
      );
      const facts = await readFiledFacts(
        { db: client, dek: after.dek },
        after.twinId,
      );
      expect(facts.map((f) => f.factType).sort()).toEqual([
        "DatePromised",
        "OrderTaken",
        "QuoteGiven",
      ]);
      const quote = facts.find((f) => f.factType === "QuoteGiven") as FiledFact;
      expect(quote.payload).toMatchObject({ amount: 8400, currency: "MXN" });
      // Its provenance is the seam row the executor wrote — the rep's own
      // message, traceable in stored rows with no model in the walk.
      const own = (await seamRows(client, after, after.chat)).find(
        (r) => r.payload.messageId === "WAMID-OWN-B",
      );
      expect(quote.sourceEventId).toBe(own!.id);

      // ADR-0033 stays green over a corpus that now contains own sends: no
      // fact, candidate or question carries the twin thread as its source.
      const exclusion = await auditSelfChatExclusion(client);
      expect(exclusion.violations).toEqual([]);
      after.bundle.close();
    });
  });

  it("the OTHER half of the defect: the Q&A can recall what the twin told a customer", async () => {
    await withClient(async (client) => {
      // #63 is two defects, not one. Beyond extraction, "the twin has
      // amnesia about its own words: Q&A and context-aware drafting cannot
      // see them either". This is that half, at the seam: the rep asks their
      // twin what they told the customer, and the twin's own send is what
      // comes back out of memory.
      const twin = freshTwin();
      await provision(client, twin);
      await runTheLoop(client, twin, { ownSendMessageId: "WAMID-OWN-RECALL" });
      // Ingest the capture into the bundle and its vector store.
      await processPendingWaEvents(depsFor(client, twin));

      const { deps, requests } = depsAndRequests(client, twin, [
        {
          toolCall: {
            name: "search_memory",
            input: { about: "millares sábado septiembre", counterparty: null },
          },
        },
        { text: "Le dijiste 3 millares a $8,400 para el sábado." },
      ]);
      await insertWaEvent(client, twin.dek, {
        twinId: twin.twinId,
        companyId: twin.companyId,
        seatId: twin.seatId,
        chatJid: SELF_CHAT,
        senderJid: SELF_CHAT,
        fromMe: true,
        messageId: "WAMID-ASK-RECALL",
        text: "¿qué le dije de los millares?",
        occurredAt: new Date("2026-08-29T23:00:00Z"),
      });
      await processPendingWaEvents(deps);

      // What the twin put in front of the model on the closing turn: the
      // retrieved rows, rendered as data. Before #63 the rep's own line was
      // not in memory to retrieve.
      const shown = JSON.stringify(requests.at(-1));
      expect(shown).toContain(DRAFT_TEXT);
      expect(shown).toContain("the rep wrote:");

      // ...and the answer posted, which is the rep-visible half.
      const answer = await client.query<{ content_enc: Buffer }>(
        "SELECT content_enc FROM notices WHERE twin_id = $1 AND kind = 'answer'",
        [twin.twinId],
      );
      expect(answer.rows).toHaveLength(1);
      expect(
        Buffer.from(twin.dek.decrypt(answer.rows[0]!.content_enc)).toString("utf8"),
      ).toContain("3 millares a $8,400");
      twin.bundle.close();
    });
  });

  it("the capture guard governs the write-back — scope_allowlist, not send_allowlist", async () => {
    await withClient(async (client) => {
      // A chat the rep may still SEND to and has taken out of SCOPE: a
      // descoped chat with a tapped draft in flight. The send goes (the tap
      // authorized it); nothing is remembered — exactly what would happen
      // had the rep typed it on their phone.
      const twin = freshTwin();
      await provision(client, twin, { inScope: false });
      const { customerSendId } = await runTheLoop(client, twin, {
        ownSendMessageId: "WAMID-OWN-DESCOPED",
      });

      // The customer's inbound is there (it arrived before the descope);
      // the twin's own reply is not, and never will be.
      const rows = await seamRows(client, twin, twin.chat);
      expect(rows.map((r) => r.payload.messageId)).toEqual([
        "WAMID-IN-WAMID-OWN-DESCOPED",
      ]);
      expect(rows.filter((r) => r.payload.fromMe)).toEqual([]);
      const outcome = await client.query<{ outcome: string }>(
        "SELECT outcome FROM send_commands WHERE id = $1",
        [customerSendId],
      );
      expect(outcome.rows[0]!.outcome).toBe("sent");
      const executions = await client.query(
        "SELECT 1 FROM send_executions WHERE command_id = $1",
        [customerSendId],
      );
      expect(executions.rows).toHaveLength(1);
      twin.bundle.close();
    });
  });

  it("no feedback loop: the twin's own words mint nothing — no tap, no draft, no answer, no binding", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await provision(client, twin);
      // The body is every verb the grammar knows, in one message, plus the
      // twin's own frame. If routing were ever to treat an own send as rep
      // input, this is the message that would prove it.
      const poison = "✳️ va si no va 1 no";
      const { draftId } = await runTheLoop(client, twin, {
        draftText: poison,
        ownSendMessageId: "WAMID-OWN-POISON",
      });

      // The model is scripted EMPTY: a drafting or Q&A call here throws.
      const inert = depsFor(client, twin);
      const result = await processPendingWaEvents(inert);
      expect(result.drafted).toBe(0);

      const own = (await seamRows(client, twin, twin.chat)).find(
        (r) => r.payload.messageId === "WAMID-OWN-POISON",
      );
      const seen = await dispositions(client, twin);
      expect(seen[own!.id]).toBe("captured");

      // One draft (the one the loop made), one tap (the rep's «va»), and no
      // second customer_send — the twin did not answer itself.
      const drafts = await client.query(
        "SELECT id FROM drafts WHERE twin_id = $1",
        [twin.twinId],
      );
      expect(drafts.rows.map((r) => r.id)).toEqual([draftId]);
      const taps = await client.query(
        "SELECT draft_id FROM taps WHERE draft_id = $1",
        [draftId],
      );
      expect(taps.rows).toHaveLength(1);
      const sends = await client.query<{ send_class: string }>(
        "SELECT send_class FROM send_commands WHERE twin_id = $1 ORDER BY created_at",
        [twin.twinId],
      );
      expect(sends.rows.filter((r) => r.send_class === "customer_send")).toHaveLength(1);
      // Nothing was dismissed, nothing was bound, nothing was answered.
      const dismissals = await client.query(
        "SELECT 1 FROM draft_dismissals WHERE draft_id = $1",
        [draftId],
      );
      expect(dismissals.rows).toEqual([]);
      expect(twin.bundle.readChatBinding(twin.chat)).toBeUndefined();

      const fr70 = await reconcileFr70(client);
      expect(fr70.violations).toEqual([]);
      twin.bundle.close();
    });
  });

  it("a real echo of the executor's own send collapses to one seam row and one bundle message", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await provision(client, twin);
      await runTheLoop(client, twin, { ownSendMessageId: "WAMID-OWN-ECHO" });
      await processPendingWaEvents(depsFor(client, twin));

      // WhatsApp delivers the plane's own send back — a re-link, a rail
      // change, a whatsmeow that starts looping own-sends to the sending
      // device. The plane composes the same seam id from the same canonical
      // chat and the same rail id, so the existing dedupe collapses it.
      const dup = await client.query(
        `INSERT INTO wa_events
           (source, external_event_id, event_type, company_id, seat_id, twin_id, occurred_at, payload_enc)
         SELECT source, external_event_id, event_type, company_id, seat_id, twin_id, occurred_at, payload_enc
           FROM wa_events
          WHERE twin_id = $1 AND external_event_id = $2
         ON CONFLICT ON CONSTRAINT wa_events_source_external_event_id_key DO NOTHING`,
        [twin.twinId, `${twin.chat}:WAMID-OWN-ECHO`],
      );
      expect(dup.rowCount).toBe(0);

      const rows = await seamRows(client, twin, twin.chat);
      expect(
        rows.filter((r) => r.payload.messageId === "WAMID-OWN-ECHO"),
      ).toHaveLength(1);
      const conversation = twin.bundle.readConversation(twin.chat);
      expect(
        conversation.filter((row) => row.messageId === "WAMID-OWN-ECHO"),
      ).toHaveLength(1);
      twin.bundle.close();
    });
  });
});
