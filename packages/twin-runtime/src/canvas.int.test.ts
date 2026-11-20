/**
 * THE CANVAS AND THE ARRIVAL'S RECORD, AT THE POSTGRES SEAM (tickets #266,
 * #320; spec #258 decision 15).
 *
 * The canvas's posts are planted by a scripted drafting run, as the twin
 * writes them, and the arrival is recorded by the same function the local API
 * calls. What the arrival's turn composes is the twin thread's, and its suite
 * is `thread-day.int.test.ts`. The model is scripted at the model boundary; CI
 * never calls one.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBundle, type Bundle } from "@dito/bundle";
import { createDekFromMaterial, type Dek } from "@dito/crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { recordArrival } from "./arrival.js";
import { readCanvas, waitingCandidates } from "./canvas.js";
import { processPendingWaEvents, type TwinRuntimeDeps } from "./consumer.js";
import { insertNoticeWithSystemSend } from "./notices.js";
import { composeReceiptPost } from "./posts.js";
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
import { insertWaEvent } from "./testing/seam-fixtures.js";
import { SETTLE_IMMEDIATELY } from "./testing/settle.js";
import { removeTmpDir } from "./testing/tmp.js";

// Every scripted model this suite opened is closed with it (#328).
afterAll(closeScriptedModels);

const SELF_CHAT = "5215550000@s.whatsapp.net";
const ZONE = "America/Monterrey";

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
  tmp = mkdtempSync(join(tmpdir(), "dito-arrival-int-"));
  pool = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 4 });
});

afterAll(async () => {
  await pool.end();
  removeTmpDir(tmp);
});

/** A twin with its company and its one seat, registered. */
async function freshSeat(): Promise<Seat> {
  const twinId = randomUUID();
  const dek = createDekFromMaterial(randomBytes(32));
  const seat: Seat = {
    twinId,
    companyId: randomUUID(),
    seatId: randomUUID(),
    dek,
    bundle: createBundle(join(tmp, `${twinId}.bundle`), dek),
  };
  await withClient(async (client) => {
    await client.query(
      "INSERT INTO companies (id, display_name) VALUES ($1, $2)",
      [seat.companyId, "Ferretería de la Llegada"],
    );
    await client.query(
      `INSERT INTO seats (id, company_id, twin_id, rep_display_name, state)
       VALUES ($1, $2, $3, $4, 'linked')`,
      [seat.seatId, seat.companyId, seat.twinId, "Mauricio Cantú"],
    );
  });
  return seat;
}

function depsFor(
  client: pg.Client,
  seat: Seat,
  script: Script = [],
): TwinRuntimeDeps {
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

/** One customer writes and the twin drafts for them — a draft card, planted as the twin writes it. */
async function draftFor(
  client: pg.Client,
  seat: Seat,
  customer: { readonly jid: string; readonly pushName: string; readonly text: string },
): Promise<void> {
  await insertWaEvent(client, seat.dek, {
    twinId: seat.twinId,
    companyId: seat.companyId,
    seatId: seat.seatId,
    chatJid: customer.jid,
    senderJid: customer.jid,
    fromMe: false,
    messageId: `3EB0-ARR-${randomUUID().slice(0, 8)}`,
    text: customer.text,
    pushName: customer.pushName,
    occurredAt: new Date(),
  });
  await processPendingWaEvents(
    depsFor(client, seat, [
      { toolCall: { name: "create_draft", input: { text: "claro, te lo aparto" } } },
      { text: "done" },
    ]),
  );
}

const LAURA = {
  jid: "5215550001@s.whatsapp.net",
  pushName: "Laura Garza",
  text: "¿sigue en pie el precio de Cancún?",
};

/** A draft row of the twin's, which a post may name as its delivery. */
async function aDraft(client: pg.Client, twinId: string): Promise<string> {
  const draft = await client.query<{ id: string }>(
    "INSERT INTO drafts (twin_id, destination, content_enc) VALUES ($1, $2, $3) RETURNING id",
    [twinId, LAURA.jid, Buffer.from("opaque")],
  );
  return draft.rows[0]!.id;
}

describe("the arrival post is door-only, by the store (ticket #266)", () => {
  it("is refused by the store if anything tries to give it a delivery row", async () => {
    const seat = await freshSeat();
    await withClient(async (client) => {
      const recorded = await recordArrival(
        { db: client, twinId: seat.twinId, timeZone: ZONE },
        { companyId: seat.companyId, seatId: seat.seatId },
        new Date(),
      );
      if (!recorded.woke) throw new Error("the fixture arrival was throttled");
      const draftId = await aDraft(client, seat.twinId);
      await expect(
        client.query(
          `INSERT INTO posts (twin_id, origin, parts_enc, asked_on, arrival_id, draft_id)
           VALUES ($1, 'composed', '\\x00', 'dashboard', $2, $3)`,
          [seat.twinId, recorded.arrivalId, draftId],
        ),
      ).rejects.toThrow(/posts_arrival_door_only_check/u);
    });
  });

  it("refuses an unasked line that carries a delivery row (ticket #320)", async () => {
    const seat = await freshSeat();
    await withClient(async (client) => {
      const draftId = await aDraft(client, seat.twinId);
      await expect(
        client.query(
          `INSERT INTO posts (twin_id, origin, parts_enc, asked_on, unasked, draft_id)
           VALUES ($1, 'composed', '\\x00', 'dashboard', true, $2)`,
          [seat.twinId, draftId],
        ),
      ).rejects.toThrow(/posts_unasked_door_only_check/u);
    });
  });
});

describe("the throttle and the day (ticket #266; spec #258 decision 15)", () => {
  it("records nothing for a return within ten minutes, and names the arrival it kept", async () => {
    const seat = await freshSeat();
    const first = new Date("2026-09-21T15:00:00.000Z");
    await withClient(async (client) => {
      const deps = { db: client, twinId: seat.twinId, timeZone: ZONE };
      const scope = { companyId: seat.companyId, seatId: seat.seatId };
      const arrived = await recordArrival(deps, scope, first);
      expect(arrived.woke).toBe(true);
      const back = await recordArrival(deps, scope, new Date(first.getTime() + 9 * 60_000));
      expect(back).toEqual({
        woke: false,
        keptArrivalId: arrived.woke ? arrived.arrivalId : undefined,
      });
      const rows = await client.query("SELECT 1 FROM rep_arrivals WHERE seat_id = $1", [seat.seatId]);
      expect(rows.rows).toHaveLength(1);
    });
  });

  it("flips the first-of-day flag across midnight in the seat's zone", async () => {
    const seat = await freshSeat();
    await withClient(async (client) => {
      const deps = { db: client, twinId: seat.twinId, timeZone: ZONE };
      const scope = { companyId: seat.companyId, seatId: seat.seatId };
      // 23:50 and 00:05 in Monterrey (UTC-6): fifteen minutes apart, two days.
      const late = await recordArrival(deps, scope, new Date("2026-09-22T05:50:00.000Z"));
      const early = await recordArrival(deps, scope, new Date("2026-09-22T06:05:00.000Z"));
      const later = await recordArrival(deps, scope, new Date("2026-09-22T12:00:00.000Z"));
      expect([late, early, later].map((one) => (one.woke ? one.visit : "none"))).toEqual([
        "first_of_day",
        "first_of_day",
        "return",
      ]);
      const days = await client.query<{ day: string }>(
        "SELECT day::text AS day FROM rep_arrivals WHERE seat_id = $1 ORDER BY arrived_at",
        [seat.seatId],
      );
      expect(days.rows.map((row) => row.day)).toEqual(["2026-09-21", "2026-09-22", "2026-09-22"]);
    });
  });
});

describe("what the canvas reads (ticket #266)", () => {
  it("leaves a pre-6b answer post off the canvas, and counts what waits for the fallback line", async () => {
    const seat = await freshSeat();
    await withClient(async (client) => {
      await draftFor(client, seat, LAURA);
      // AN ANSWER WITH NO DOOR — the shape every answer had before #261.
      const event = await insertWaEvent(client, seat.dek, {
        twinId: seat.twinId,
        chatJid: SELF_CHAT,
        senderJid: SELF_CHAT,
        fromMe: true,
        messageId: `3EB0-ANS-${randomUUID().slice(0, 8)}`,
        text: "¿qué hay?",
        occurredAt: new Date(),
      });
      await client.query("BEGIN");
      await insertNoticeWithSystemSend(client, {
        twinId: seat.twinId,
        selfChatJid: SELF_CHAT,
        dek: seat.dek,
        kind: "answer",
        aboutEventId: event,
        post: composeReceiptPost("Todo en orden."),
      });
      await client.query("COMMIT");
      const canvas = await readCanvas(
        { db: client, twinId: seat.twinId, dek: seat.dek, timeZone: ZONE, bundle: seat.bundle },
        { seatId: seat.seatId, now: new Date() },
      );
      // THE DRAFT AND ITS BINDING QUESTION WAIT; THE ANSWER DOES NOT.
      expect(
        canvas.waiting.map((post) => post.parts.find((part) => part.kind !== "prose" && part.kind !== "knock")?.kind),
      ).toEqual(["draft", "question"]);
      expect(canvas.facts).toEqual({ waiting: 2, spotlight: "Laura Garza (sin confirmar)" });
    });
  });
});

describe("the day's notes stay a candidate while a line can be taken back (Codex r1, r2)", () => {
  /** A day's notes post whose notice's send ended as given, `sentAt` for a sent one. */
  async function notesWith(
    client: pg.Client,
    seat: Seat,
    postedAt: Date,
    outcome: "sent" | "failed" | "held" | null,
    executedAt?: Date,
  ): Promise<string> {
    const notice = await client.query<{ id: string }>(
      `INSERT INTO notices (twin_id, kind, content_enc, created_at)
       VALUES ($1, 'daily_disclosure', $2, $3) RETURNING id`,
      [seat.twinId, Buffer.from(seat.dek.encrypt(Buffer.from("notas", "utf8"))), postedAt],
    );
    await client.query(
      `INSERT INTO send_commands
         (twin_id, send_class, destination, payload_ref, outcome, executed_at, created_at)
       VALUES ($1, 'system_send', $2, $3, $4, $5, $6)`,
      [
        seat.twinId,
        SELF_CHAT,
        `notice:${notice.rows[0]!.id}`,
        outcome,
        outcome === null ? null : (executedAt ?? postedAt),
        postedAt,
      ],
    );
    const post = await client.query<{ id: string }>(
      `INSERT INTO posts (twin_id, origin, notice_id, posted_at)
       VALUES ($1, 'reexpressed', $2, $3) RETURNING id`,
      [seat.twinId, notice.rows[0]!.id, postedAt],
    );
    return post.rows[0]!.id;
  }

  it("admits notes whose send waits, failed or never confirmed, however old, and notes inside their window", async () => {
    const seat = await freshSeat();
    const now = new Date("2026-09-26T18:00:00.000Z");
    const tenDaysAgo = new Date(now.getTime() - 10 * 86_400_000);
    await withClient(async (client) => {
      const waiting = await notesWith(client, seat, tenDaysAgo, null);
      const failed = await notesWith(client, seat, tenDaysAgo, "failed");
      const held = await notesWith(client, seat, tenDaysAgo, "held");
      const open = await notesWith(client, seat, tenDaysAgo, "sent", new Date(now.getTime() - 3_600_000));
      const shut = await notesWith(client, seat, tenDaysAgo, "sent", tenDaysAgo);
      const candidates = await waitingCandidates({ db: client, twinId: seat.twinId }, now);
      expect(candidates).toEqual(expect.arrayContaining([waiting, failed, held, open]));
      expect(candidates).not.toContain(shut);
    });
  });
});
