/**
 * THE ACTS LOG, RUTINAS AND THE RUNS, AT THE POSTGRES SEAM (ticket #267; spec
 * #258 decision 16 and *Testing decisions* — «the acts log read by day; the
 * runs read»).
 *
 * Fixture in, rows out. The subjects are the twin's own posts, written by
 * scripted drafting runs exactly as the twin writes them; the acts on them are
 * the rows each act leaves, planted at chosen instants so a day's edges can be
 * placed on purpose. Real envelope crypto over a real SQLCipher bundle; the
 * model is scripted and CI never calls one.
 *
 * THE CLOCK IS THE CALLER'S. Every read below is asked at `NOW`, 14:00 on
 * 8 September in Monterrey (UTC-6), whatever the host's own date is.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileCandidateFact, fileEntityCreate } from "@dito/aperture";
import { createBundle, type Bundle } from "@dito/bundle";
import { createDekFromMaterial, type Dek } from "@dito/crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { actsLogOnTheWire, readActsLog, type ActsLog, type LoggedAct } from "./acts-log.js";
import { recordArrival } from "./arrival.js";
import { processPendingWaEvents, type TwinRuntimeDeps } from "./consumer.js";
import { withDbTransaction } from "./db-tx.js";
import { insertNoticeWithSystemSend } from "./notices.js";
import { insertPost, reexpressStrayPosts } from "./posts.js";
import { readRutinas } from "./routines.js";
import { ensureShippedAutomations } from "./runs/shipped-automations.js";
import { createSendLockWriter } from "./send-lock/writer.js";
import {
  resetAndMigrate,
  TEST_AUDIT_HMAC_KEY,
  TEST_DATABASE_URL,
  withClient,
} from "./testing/db.js";
import { newExecutionPool } from "./testing/execution-pool.js";
import { fakeEmbedder } from "./testing/fake-embedder.js";
import { closeScriptedModels, scriptedModel, type Script } from "./testing/scripted-model.js";
import { insertWaEvent, simulateExecutorPost } from "./testing/seam-fixtures.js";
import { SETTLE_IMMEDIATELY } from "./testing/settle.js";
import { removeTmpDir } from "./testing/tmp.js";

// Every scripted model this suite opened is closed with it (#328).
afterAll(closeScriptedModels);

const SELF_CHAT = "5215550000@s.whatsapp.net";
const ZONE = "America/Monterrey";
/** 14:00 on Tuesday 8 September, seat-local. */
const NOW = new Date("2026-09-08T20:00:00.000Z");

const executionPool = newExecutionPool();

let tmp: string;
let pool: pg.Pool;

interface Seat {
  readonly twinId: string;
  readonly companyId: string;
  readonly seatId: string;
  readonly dek: Dek;
  readonly bundle: Bundle;
}

beforeAll(async () => {
  await resetAndMigrate();
  tmp = mkdtempSync(join(tmpdir(), "dito-acts-log-int-"));
  pool = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 4 });
});

afterAll(async () => {
  await pool.end();
  removeTmpDir(tmp);
});

/** A twin with its company and its one seat, registered. */
async function freshSeat(client: pg.Client): Promise<Seat> {
  const twinId = randomUUID();
  const dek = createDekFromMaterial(randomBytes(32));
  const seat: Seat = {
    twinId,
    companyId: randomUUID(),
    seatId: randomUUID(),
    dek,
    bundle: createBundle(join(tmp, `${twinId}.bundle`), dek),
  };
  await client.query("INSERT INTO companies (id, display_name) VALUES ($1, $2)", [
    seat.companyId,
    `Ferretería ${seat.companyId.slice(0, 4)}`,
  ]);
  await client.query(
    `INSERT INTO seats (id, company_id, twin_id, rep_display_name, state)
     VALUES ($1, $2, $3, $4, 'linked')`,
    [seat.seatId, seat.companyId, seat.twinId, "Mauricio Cantú"],
  );
  return seat;
}

function depsFor(client: pg.Client, seat: Seat, script: Script): TwinRuntimeDeps {
  const { harness } = scriptedModel(script);
  return {
    db: client,
    harness,
    bundle: seat.bundle,
    dek: seat.dek,
    twinId: seat.twinId,
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

/** The read deps a local API hands `readActsLog`. */
function readDeps(client: pg.Client, seat: Seat) {
  return {
    db: client,
    twinId: seat.twinId,
    dek: seat.dek,
    timeZone: ZONE,
    bundle: seat.bundle,
  };
}

/**
 * One customer writes and the twin drafts for them: the draft card and, for a
 * chat nobody bound, the binding question beside it. Answers both posts.
 */
async function draftFor(
  client: pg.Client,
  seat: Seat,
  customer: { readonly jid: string; readonly pushName: string },
): Promise<{ draftPost: string; draftId: string; questionPost: string }> {
  const asked = await questionPosts(client, seat);
  await insertWaEvent(client, seat.dek, {
    twinId: seat.twinId,
    companyId: seat.companyId,
    seatId: seat.seatId,
    chatJid: customer.jid,
    senderJid: customer.jid,
    fromMe: false,
    messageId: `3EB0-LOG-${randomUUID().slice(0, 8)}`,
    text: "¿me mandas 40 cajas?",
    pushName: customer.pushName,
    occurredAt: new Date("2026-09-08T13:00:00.000Z"),
  });
  await processPendingWaEvents(
    depsFor(client, seat, [
      { toolCall: { name: "create_draft", input: { text: "claro, te las aparto" } } },
      { text: "done" },
    ]),
  );
  const draft = await client.query<{ id: string; draft_id: string }>(
    `SELECT p.id, p.draft_id FROM posts p JOIN drafts d ON d.id = p.draft_id
      WHERE p.twin_id = $1 AND d.destination = $2`,
    [seat.twinId, customer.jid],
  );
  const question = (await questionPosts(client, seat)).find((id) => !asked.includes(id));
  return {
    draftPost: draft.rows[0]!.id,
    draftId: draft.rows[0]!.draft_id,
    questionPost: question!,
  };
}

/** The seat's binding questions so far — how a run's new one is told apart. */
async function questionPosts(client: pg.Client, seat: Seat): Promise<string[]> {
  const rows = await client.query<{ id: string }>(
    "SELECT id FROM posts WHERE twin_id = $1 AND question_subject = 'binding'",
    [seat.twinId],
  );
  return rows.rows.map((row) => row.id);
}

/** A message the rep sent in their own thread, already marked by the consumer. */
async function repSaid(
  client: pg.Client,
  seat: Seat,
  marker: string,
  at: Date,
  quotedMessageId?: string,
): Promise<string> {
  const eventId = await insertWaEvent(client, seat.dek, {
    twinId: seat.twinId,
    companyId: seat.companyId,
    seatId: seat.seatId,
    chatJid: SELF_CHAT,
    senderJid: SELF_CHAT,
    fromMe: true,
    messageId: `3EB0-REP-${randomUUID().slice(0, 8)}`,
    text: "no va",
    occurredAt: at,
    ...(quotedMessageId === undefined ? {} : { quotedMessageId }),
  });
  await client.query(
    `INSERT INTO wa_event_processing (event_id, twin_id, disposition, processed_at)
     VALUES ($1, $2, $3, $4)`,
    [eventId, seat.twinId, marker, at],
  );
  return eventId;
}

/** A draft the rail's ack says went out, tapped on the dashboard. */
async function sent(client: pg.Client, seat: Seat, draftId: string, at: Date): Promise<void> {
  const tap = await client.query<{ id: string }>(
    "INSERT INTO taps (draft_id, minter) VALUES ($1, 'rep_web') RETURNING id",
    [draftId],
  );
  await client.query(
    `INSERT INTO send_commands
       (twin_id, send_class, destination, payload_ref, tap_id, draft_id, outcome, executed_at)
     SELECT $1, 'customer_send', d.destination, 'draft:' || d.id, $2, d.id, 'sent', $3
       FROM drafts d WHERE d.id = $4`,
    [seat.twinId, tap.rows[0]!.id, at, draftId],
  );
}

/** A draft dismissed by the rep's own «no va», at `at`. */
async function dismissed(client: pg.Client, seat: Seat, draftId: string, at: Date): Promise<void> {
  const evidence = await repSaid(client, seat, "dismissed", at);
  await client.query(
    "INSERT INTO draft_dismissals (draft_id, source_event_id, created_at) VALUES ($1, $2, $3)",
    [draftId, evidence, at],
  );
}

/** One push notify recorded for a reminder's knock about `postId`, settled at `at`. */
async function pushed(
  client: pg.Client,
  seat: Seat,
  postId: string,
  outcome: "sent" | "failed" | "refused",
  at: Date,
): Promise<void> {
  await client.query(
    `INSERT INTO notify_sends
       (seat_id, message_type, requested_at, outcome, reason, settled_at, about_ref, channel)
     VALUES ($1, 'reminder', $2, $3, $4, $2, $5, 'push')`,
    [
      seat.seatId,
      at,
      outcome,
      outcome === "sent" ? null : outcome === "refused" ? "no_subscription" : "transport_failed",
      postId,
    ],
  );
}

/** A draft with no post — the shape a fixture needs only to be dismissed. */
async function bareDraft(client: pg.Client, seat: Seat): Promise<string> {
  const res = await client.query<{ id: string }>(
    `INSERT INTO drafts (twin_id, destination, content_enc)
     VALUES ($1, '5215559999@s.whatsapp.net', $2) RETURNING id`,
    [seat.twinId, Buffer.from(seat.dek.encrypt(Buffer.from("ok", "utf8")))],
  );
  return res.rows[0]!.id;
}

/** One `executions` row, as the store writes one when a run ends. */
async function ran(
  client: pg.Client,
  seat: Seat,
  occasion: string,
  startedAt: Date,
  disposition: string,
): Promise<string> {
  const res = await client.query<{ id: string }>(
    `INSERT INTO executions
       (twin_id, trigger_kind, trigger_mechanism, trigger_ref, instructions_digest,
        tool_names, lane, started_at, ended_at, iterations, tokens_input,
        tokens_output, disposition)
     VALUES ($1, $2, 'request', $3, 'digest', '{}', 'realtime', $4, $4, 1, 10, 10, $5)
     RETURNING id`,
    [seat.twinId, occasion, `${occasion}:fixture`, startedAt, disposition],
  );
  return res.rows[0]!.id;
}

/**
 * One fact filed through the aperture, the single writer
 * (`dashboard-acts.int.test.ts` argues the shape), and numbered on two days'
 * notes: line 3 of the 5th's, which never reached the rep, and line 1 of the
 * 6th's, which did.
 *
 * POSTED NOW, on the host's clock: ADR-0034's trigger lets a line join its
 * post only in the transaction that wrote it, which is what `posted_at =
 * now()` checks — so a numbered post cannot be backdated, and the day this
 * one is posted on is outside every day the log below reads.
 */
async function numberedNotes(
  client: pg.Client,
  seat: Seat,
): Promise<{ lineId: string; factId: string }> {
  const customer = "5215550009@s.whatsapp.net";
  const sourceEventId = await insertWaEvent(client, seat.dek, {
    twinId: seat.twinId,
    companyId: seat.companyId,
    seatId: seat.seatId,
    chatJid: customer,
    senderJid: SELF_CHAT,
    fromMe: true,
    messageId: `3EB0-QUOTE-${randomUUID().slice(0, 8)}`,
    text: "te las dejo en 4500",
    occurredAt: new Date("2026-09-07T15:07:00.000Z"),
  });
  const bindMessageId = `3EB0-BIND-${randomUUID().slice(0, 8)}`;
  const bindEventId = await insertWaEvent(client, seat.dek, {
    twinId: seat.twinId,
    companyId: seat.companyId,
    seatId: seat.seatId,
    chatJid: SELF_CHAT,
    senderJid: SELF_CHAT,
    fromMe: true,
    messageId: bindMessageId,
    text: "va",
    occurredAt: new Date("2026-09-07T15:00:00.000Z"),
  });
  const entityId = randomUUID();
  await fileEntityCreate(
    { db: client, dek: seat.dek, hmacKey: TEST_AUDIT_HMAC_KEY },
    {
      twinId: seat.twinId,
      entityId,
      kind: "business",
      displayName: "Abarrotes La Luz",
      evidence: { surface: "twin_thread", sourceEventId: bindEventId, waMessageId: bindMessageId },
      disclosureText: "Lo di de alta como cliente.",
    },
  );
  const filed = await fileCandidateFact(
    { db: client, dek: seat.dek },
    {
      twinId: seat.twinId,
      entityId,
      sourceEventId,
      factType: "QuoteGiven",
      payload: { item: "cajas", amount: 4500, currency: "MXN" },
      confidence: 0.95,
      reading: "stated",
      renderDisclosureLine: () => "Le cotizaste cajas en 4500 MXN.",
    },
  );
  if (!filed.filed) throw new Error(`fixture did not file: ${filed.reason}`);
  const line = await client.query<{ id: string }>(
    `SELECT id FROM disclosure_lines
      WHERE twin_id = $1 AND fact_id = $2 AND subject_kind = 'fact'`,
    [seat.twinId, filed.factId],
  );
  const lineId = line.rows[0]!.id;
  // THE SAME LINE, NUMBERED 3 ON THE 5TH'S NOTES, WHICH THE RAIL REFUSED —
  // so the rep only ever read it as line 1 of the 6th's.
  await numbered(client, seat, lineId, { day: "2026-09-05", index: 3, outcome: "failed" });
  await numbered(client, seat, lineId, { day: "2026-09-06", index: 1, outcome: "sent" });
  return { lineId, factId: filed.factId };
}

/** One day's notes carrying `lineId` at `index`, its send settled `outcome` on the 5th. */
async function numbered(
  client: pg.Client,
  seat: Seat,
  lineId: string,
  at: { readonly day: string; readonly index: number; readonly outcome: "sent" | "failed" },
): Promise<void> {
  const noticeId = await insertNoticeWithSystemSend(client, {
    twinId: seat.twinId,
    selfChatJid: SELF_CHAT,
    dek: seat.dek,
    kind: "daily_disclosure",
    post: {
      parts: [{ kind: "receipt", text: "Hoy agregué 1 dato al registro." }],
      text: "✳️ Hoy agregué 1 dato al registro.",
    },
  });
  await withDbTransaction(client, async () => {
    const post = randomUUID();
    await client.query(
      `INSERT INTO disclosure_posts (id, twin_id, disclosure_day, notice_id)
       VALUES ($1, $2, $3, $4)`,
      [post, seat.twinId, at.day, noticeId],
    );
    await client.query(
      `INSERT INTO disclosure_post_lines (twin_id, post_id, line_index, disclosure_line_id)
       VALUES ($1, $2, $3, $4)`,
      [seat.twinId, post, at.index, lineId],
    );
  });
  // SETTLED ON THE 5TH, seat-local — a day none of the reads below asserts
  // in full.
  await client.query(
    `UPDATE send_commands SET outcome = $2, executed_at = '2026-09-06T03:05:00.000Z'
      WHERE payload_ref = 'notice:' || $1::text`,
    [noticeId, at.outcome],
  );
}

/**
 * A day's notes with no numbered line, posted at `postedAt` and its send
 * settled `outcome` at the same instant.
 */
async function notesOf(
  client: pg.Client,
  seat: Seat,
  day: string,
  postedAt: string,
  outcome: "sent" | "failed",
): Promise<void> {
  const noticeId = await insertNoticeWithSystemSend(client, {
    twinId: seat.twinId,
    selfChatJid: SELF_CHAT,
    dek: seat.dek,
    kind: "daily_disclosure",
    post: {
      parts: [{ kind: "receipt", text: "Hoy agregué 1 dato al registro." }],
      text: "✳️ Hoy agregué 1 dato al registro.",
    },
  });
  await client.query(
    `INSERT INTO disclosure_posts (twin_id, disclosure_day, notice_id, posted_at)
     VALUES ($1, $2, $3, $4)`,
    [seat.twinId, day, noticeId, postedAt],
  );
  await client.query(
    `UPDATE send_commands SET outcome = $2, executed_at = $3
      WHERE payload_ref = 'notice:' || $1::text`,
    [noticeId, outcome, postedAt],
  );
}

/** What a day's lines say, in the order the page draws them. */
function linesOf(log: ActsLog): readonly Partial<LoggedAct>[] {
  return log.acts.map((act) => ({
    act: act.act,
    at: act.at,
    ...(act.name === undefined ? {} : { name: act.name }),
    ...(act.line === undefined ? {} : { line: act.line }),
    ...(act.notesDay === undefined ? {} : { notesDay: act.notesDay }),
    ...(act.opens === undefined ? {} : { opens: act.opens }),
  }));
}

describe("the acts log, one seat-local day at a time (ticket #267)", () => {
  let seat: Seat;
  let other: Seat;

  beforeAll(async () => {
    await withClient(async (client) => {
      seat = await freshSeat(client);
      other = await freshSeat(client);
      // AN ARRIVAL LINE ON THE DAY, which the log leaves on Inicio: the rep
      // arrived at 08:00 and the twin said so — the arrival post as the
      // thread's turn writes it (ticket #320).
      const arrived = await recordArrival(
        { db: client, twinId: seat.twinId, timeZone: ZONE },
        { companyId: seat.companyId, seatId: seat.seatId },
        new Date("2026-09-08T14:00:00.000Z"),
      );
      if (!arrived.woke) throw new Error("the fixture arrival was throttled");
      const greeted = await ran(client, seat, "arrival", new Date("2026-09-08T14:00:00.000Z"), "answered");
      await insertPost(client, {
        twinId: seat.twinId,
        dek: seat.dek,
        parts: [{ kind: "prose", text: "Hoy empieza con Laura esperando su precio." }],
        executionId: greeted,
        asked: { door: "dashboard", arrivalId: arrived.arrivalId },
      });
      // ...AND ITS MARKER, as that turn writes it (ticket #358): the arrival
      // is answered, so no later pass greets for it again.
      await client.query(
        "INSERT INTO rep_arrival_executions (arrival_id, twin_id, execution_id) VALUES ($1, $2, $3)",
        [arrived.arrivalId, seat.twinId, greeted],
      );

      // THE TWIN'S OWN POSTS NEXT, while nothing else waits on the consumer.
      const laura = await draftFor(client, seat, {
        jid: "5215550001@s.whatsapp.net",
        pushName: "Laura Garza",
      });
      const torres = await draftFor(client, seat, {
        jid: "5215550002@s.whatsapp.net",
        pushName: "Torres Hnos",
      });
      const carmen = await draftFor(client, seat, {
        jid: "5215550003@s.whatsapp.net",
        pushName: "Doña Carmen",
      });
      // 09:10 — Laura's draft goes out.
      await sent(client, seat, laura.draftId, new Date("2026-09-08T15:10:00.000Z"));
      // 09:40 — a chat is bound, in the entity mirror (either surface lands here).
      seat.bundle.confirmChatBinding({
        chatJid: "5215550004@s.whatsapp.net",
        entityId: randomUUID(),
        displayName: "Refacciones RS",
        confirmedAt: "2026-09-08T15:40:00.000Z",
      });
      await client.query(
        "INSERT INTO chat_directory (twin_id, chat_jid, kind) VALUES ($1, $2, 'dm')",
        [seat.twinId, "5215550004@s.whatsapp.net"],
      );
      // ...and one whose chat Conexiones has no row to draw: named, opening
      // nothing.
      seat.bundle.confirmChatBinding({
        chatJid: "5215550005@s.whatsapp.net",
        entityId: randomUUID(),
        displayName: "Ferretería del Norte",
        confirmedAt: "2026-09-08T15:45:00.000Z",
      });
      // 10:20 — Torres' draft, dismissed.
      await dismissed(client, seat, torres.draftId, new Date("2026-09-08T16:20:00.000Z"));
      // 11:00 — «Es otro cliente» on Laura's question, from the dashboard.
      await client.query(
        `INSERT INTO dashboard_acts
           (company_id, seat_id, twin_id, post_id, verb, acted_at, outcome)
         VALUES ($1, $2, $3, $4, 'decline_binding', $5, 'performed')`,
        [seat.companyId, seat.seatId, seat.twinId, laura.questionPost, new Date("2026-09-08T17:00:00.000Z")],
      );
      // 11:30 — «no va» quoting Torres' question, in the thread.
      const asked = await client.query<{ id: string }>(
        `SELECT sc.id FROM send_commands sc JOIN posts p ON sc.payload_ref = 'notice:' || p.notice_id
          WHERE p.id = $1`,
        [torres.questionPost],
      );
      const questionMessage = `3EB0-ASKED-${randomUUID().slice(0, 8)}`;
      await simulateExecutorPost(client, {
        commandId: asked.rows[0]!.id,
        twinId: seat.twinId,
        waMessageId: questionMessage,
      });
      await repSaid(client, seat, "declined", new Date("2026-09-08T17:30:00.000Z"), questionMessage);
      // 08:00 — Carmen's draft's reminder fired and the thread knocked about
      // it, while it still waits.
      const knocked = await ran(client, seat, "twin_thread_event", new Date("2026-09-08T14:00:00.000Z"), "acted");
      await client.query(
        `INSERT INTO post_knocks (post_id, twin_id, text_enc, execution_id, knocked_at, subject)
         VALUES ($1, $2, $3, $4, $5, 'draft_waiting')`,
        [carmen.draftPost, seat.twinId, Buffer.from(seat.dek.encrypt(Buffer.from("Carmen espera.", "utf8"))), knocked, new Date("2026-09-08T13:59:00.000Z")],
      );
      // ...ONE BROWSER REFUSED IT AND ONE TOOK IT: the line is the one that
      // reached the rep, at the instant it did.
      await pushed(client, seat, carmen.draftPost, "failed", new Date("2026-09-08T13:59:30.000Z"));
      await pushed(client, seat, carmen.draftPost, "sent", new Date("2026-09-08T14:00:00.000Z"));
      // A REMINDER'S KNOCK NEVER DELIVERED reminded nobody: Torres' draft was
      // knocked about at 08:30 and its only push found no browser.
      const unsent = await ran(client, seat, "twin_thread_event", new Date("2026-09-08T14:30:00.000Z"), "acted");
      await client.query(
        `INSERT INTO post_knocks (post_id, twin_id, text_enc, execution_id, knocked_at, subject)
         VALUES ($1, $2, $3, $4, $5, 'draft_waiting')`,
        [torres.draftPost, seat.twinId, Buffer.from(seat.dek.encrypt(Buffer.from("Torres espera.", "utf8"))), unsent, new Date("2026-09-08T14:30:00.000Z")],
      );
      await pushed(client, seat, torres.draftPost, "refused", new Date("2026-09-08T14:30:05.000Z"));
      // 12:00 — line 1 of the 6th's notes, retracted.
      const notes = await numberedNotes(client, seat);
      // The 7th's notes reached the rep at 21:00 that evening; the 4th's,
      // posted an hour later, never did — the rail refused them.
      await notesOf(client, seat, "2026-09-07", "2026-09-08T03:00:00.000Z", "sent");
      await notesOf(client, seat, "2026-09-04", "2026-09-08T04:00:00.000Z", "failed");
      const evidence = await repSaid(client, seat, "retracted", new Date("2026-09-08T18:00:00.000Z"));
      await client.query(
        `INSERT INTO fact_retractions
           (company_id, seat_id, twin_id, fact_id, disclosure_line_id, source_event_id, retracted_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [seat.companyId, seat.seatId, seat.twinId, notes.factId, notes.lineId, evidence, new Date("2026-09-08T18:00:00.000Z")],
      );

      // THE DAY'S TWO EDGES: 23:50 on the 7th and 00:10 on the 8th, seat-local
      // — twenty minutes apart, one UTC date, two days.
      await dismissed(client, seat, await bareDraft(client, seat), new Date("2026-09-08T05:50:00.000Z"));
      await dismissed(client, seat, await bareDraft(client, seat), new Date("2026-09-08T06:10:00.000Z"));
      // TEN DAYS AGO, which no day of the log may reach.
      await dismissed(client, seat, await bareDraft(client, seat), new Date("2026-08-29T18:00:00.000Z"));

      // ANOTHER SEAT'S TWIN acting the same morning.
      await dismissed(client, other, await bareDraft(client, other), new Date("2026-09-08T16:00:00.000Z"));
      other.bundle.confirmChatBinding({
        chatJid: "5215550004@s.whatsapp.net",
        entityId: randomUUID(),
        displayName: "Otro Negocio",
        confirmedAt: "2026-09-08T16:05:00.000Z",
      });
    });
  });

  afterAll(() => {
    seat.bundle.close();
    other.bundle.close();
  });

  it("reads today's acts with the act word, the instant and the subject, oldest first", async () => {
    await withClient(async (client) => {
      const log = await readActsLog(readDeps(client, seat), { seatId: seat.seatId, now: NOW, back: 0 });
      expect(log.today).toBe("2026-09-08");
      expect(log.day).toBe("2026-09-08");
      expect(linesOf(log)).toEqual([
        { act: "dismissed", at: new Date("2026-09-08T06:10:00.000Z") },
        { act: "reminded", at: new Date("2026-09-08T14:00:00.000Z"), name: "Doña Carmen (sin confirmar)", opens: "inicio" },
        { act: "sent", at: new Date("2026-09-08T15:10:00.000Z"), name: "Laura Garza (sin confirmar)" },
        { act: "confirmed", at: new Date("2026-09-08T15:40:00.000Z"), name: "Refacciones RS", opens: "conexiones" },
        { act: "confirmed", at: new Date("2026-09-08T15:45:00.000Z"), name: "Ferretería del Norte" },
        { act: "dismissed", at: new Date("2026-09-08T16:20:00.000Z"), name: "Torres Hnos (sin confirmar)" },
        { act: "declined", at: new Date("2026-09-08T17:00:00.000Z"), name: "Laura Garza" },
        { act: "declined", at: new Date("2026-09-08T17:30:00.000Z"), name: "Torres Hnos" },
        { act: "retracted", at: new Date("2026-09-08T18:00:00.000Z"), line: 1, notesDay: "2026-09-06" },
      ]);
    });
  });

  it("carries no line of the twin's on a day whose arrival line it composed — the page heads the day in code", async () => {
    await withClient(async (client) => {
      const today = await readActsLog(readDeps(client, seat), { seatId: seat.seatId, now: NOW, back: 0 });
      expect(Object.keys(actsLogOnTheWire(today)).sort()).toEqual(["acts", "back", "day", "today"]);
    });
  });

  it("cuts the day in the seat's zone: 23:50 and 00:10 fall on two days", async () => {
    await withClient(async (client) => {
      const yesterday = await readActsLog(readDeps(client, seat), { seatId: seat.seatId, now: NOW, back: 1 });
      expect(yesterday.day).toBe("2026-09-07");
      // The 7th's notes reached the rep at 21:00 that evening and carry no
      // line to take back, so they open nothing; the 4th's, refused by the
      // rail an hour later, are no disclosure at all.
      expect(linesOf(yesterday)).toEqual([
        { act: "disclosed", at: new Date("2026-09-08T03:00:00.000Z") },
        { act: "dismissed", at: new Date("2026-09-08T05:50:00.000Z") },
      ]);
    });
  });

  it("reaches seven days back and no further — an act ten days old is on no day", async () => {
    await withClient(async (client) => {
      const days: string[] = [];
      for (const back of [0, 1, 2, 3, 4, 5, 6, 7, 8, 99]) {
        const log = await readActsLog(readDeps(client, seat), { seatId: seat.seatId, now: NOW, back });
        days.push(log.day);
        expect(log.acts.map((act) => act.at.toISOString())).not.toContain("2026-08-29T18:00:00.000Z");
      }
      expect(days).toEqual([
        "2026-09-08",
        "2026-09-07",
        "2026-09-06",
        "2026-09-05",
        "2026-09-04",
        "2026-09-03",
        "2026-09-02",
        "2026-09-01",
        "2026-09-01",
        "2026-09-01",
      ]);
    });
  });

  it("never shows another seat's acts", async () => {
    await withClient(async (client) => {
      const mine = await readActsLog(readDeps(client, seat), { seatId: seat.seatId, now: NOW, back: 0 });
      expect(mine.acts.map((act) => act.at.toISOString())).not.toContain("2026-09-08T16:00:00.000Z");
      expect(mine.acts.map((act) => act.name)).not.toContain("Otro Negocio");
      const theirs = await readActsLog(readDeps(client, other), { seatId: other.seatId, now: NOW, back: 0 });
      expect(linesOf(theirs)).toEqual([
        { act: "dismissed", at: new Date("2026-09-08T16:00:00.000Z") },
        { act: "confirmed", at: new Date("2026-09-08T16:05:00.000Z"), name: "Otro Negocio" },
      ]);
    });
  });
});

describe("an unbound chat's line carries the card's own marked name (ticket #298)", () => {
  it("names a draft for a chat with no push name, and one that predates parts, by the number marked «(sin confirmar)»", async () => {
    await withClient(async (client) => {
      const seat = await freshSeat(client);
      await insertWaEvent(client, seat.dek, {
        twinId: seat.twinId,
        companyId: seat.companyId,
        seatId: seat.seatId,
        chatJid: "5215550006@s.whatsapp.net",
        senderJid: "5215550006@s.whatsapp.net",
        fromMe: false,
        messageId: `3EB0-298-${randomUUID().slice(0, 8)}`,
        text: "¿me mandas 40 cajas?",
        occurredAt: new Date("2026-09-08T13:00:00.000Z"),
      });
      await processPendingWaEvents(
        depsFor(client, seat, [
          { toolCall: { name: "create_draft", input: { text: "claro, te las aparto" } } },
          { text: "done" },
        ]),
      );
      const composed = await client.query<{ id: string }>(
        "SELECT id FROM drafts WHERE twin_id = $1",
        [seat.twinId],
      );
      const legacy = await client.query<{ id: string }>(
        `INSERT INTO drafts (twin_id, destination, content_enc)
         VALUES ($1, '5215550007@s.whatsapp.net', $2) RETURNING id`,
        [seat.twinId, Buffer.from(seat.dek.encrypt(Buffer.from("ok", "utf8")))],
      );
      await reexpressStrayPosts({ db: client, twinId: seat.twinId });
      await dismissed(client, seat, composed.rows[0]!.id, new Date("2026-09-08T16:00:00.000Z"));
      await dismissed(client, seat, legacy.rows[0]!.id, new Date("2026-09-08T16:30:00.000Z"));

      const log = await readActsLog(readDeps(client, seat), { seatId: seat.seatId, now: NOW, back: 0 });
      expect(linesOf(log)).toEqual([
        { act: "dismissed", at: new Date("2026-09-08T16:00:00.000Z"), name: "5215550006 (sin confirmar)" },
        { act: "dismissed", at: new Date("2026-09-08T16:30:00.000Z"), name: "5215550007 (sin confirmar)" },
      ]);
      seat.bundle.close();
    });
  });
});

describe("Rutinas and the runs in flight (ticket #267)", () => {
  it("lists Dito's own from their rows, with their wake and each one's last firing or none (#364)", async () => {
    await withClient(async (client) => {
      const seat = await freshSeat(client);
      await ensureShippedAutomations(client, { twinId: seat.twinId, seatId: seat.seatId }, NOW);
      await ran(client, seat, "chat_turn", new Date("2026-09-07T16:00:00.000Z"), "drafted");
      await ran(client, seat, "chat_turn", new Date("2026-09-08T15:00:00.000Z"), "no-action");
      // An owner-side and a classification run are not what fires on its own.
      await ran(client, seat, "entity_kind", new Date("2026-09-08T15:30:00.000Z"), "classified");
      const read = await readRutinas({ db: client, twinId: seat.twinId, timeZone: ZONE }, NOW);
      expect(read.today).toBe("2026-09-08");
      const TONIGHT = { at: "2026-09-09T03:00:00.000Z", day: "2026-09-08" };
      expect(read.automations.map((card) => (card.origin === "dito" ? { ...card, id: "row" } : card))).toEqual([
        {
          id: "row",
          origin: "dito",
          shipped: "drafting",
          wake: { kind: "trigger" },
          // DRAFTING ANSWERS SOMEONE AND LEAVES NO RUN: its last firing is its
          // last turn. The twin thread is the twin itself and is not listed.
          lastRun: { at: "2026-09-08T15:00:00.000Z", day: "2026-09-08" },
          paused: false,
        },
        // EACH CADENCE CARRIES ITS NEXT INSTANT FROM 14:00 ON THE 8TH (ticket #387).
        { id: "row", origin: "dito", shipped: "extraction", wake: { kind: "schedule", every: "day", atHour: 21 }, paused: false, nextFiring: TONIGHT },
        { id: "row", origin: "dito", shipped: "daily_disclosure", wake: { kind: "schedule", every: "day", atHour: 21 }, paused: false, nextFiring: TONIGHT },
        { id: "row", origin: "dito", shipped: "reminders", wake: { kind: "once" }, paused: false },
        {
          id: "row",
          origin: "dito",
          shipped: "overnight_requests",
          wake: { kind: "schedule", every: "day", atHour: 8 },
          paused: false,
          nextFiring: { at: "2026-09-09T14:00:00.000Z", day: "2026-09-09" },
        },
      ]);
      seat.bundle.close();
    });
  });
});
