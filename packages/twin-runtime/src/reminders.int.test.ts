/**
 * THE REMINDERS: ONE-SHOT ROWS OF THE CLOCK STORE THAT WAKE THE THREAD (ticket
 * #364; ADR-0031 as amended 2026-10-07; CONTEXT.md *Rutinas*, *Knock*).
 *
 * The Postgres seam: a card is born through the one write every post goes
 * through, and what the store holds afterwards is the claim — its reminder
 * row, the instant it fires at, what a due row raises, and the knock a thread
 * turn adds for it. Two things stand in, at the boundaries only: the MODEL,
 * scripted (CI never calls one), and the NOTIFIER the composition root hands
 * the runtime. Real Postgres, real envelope crypto, real SQLCipher.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBundle, type Bundle } from "@dito/bundle";
import { createDekFromMaterial, type Dek } from "@dito/crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { processPendingWaEvents, type TwinRuntimeDeps } from "./consumer.js";
import { deliverPendingKnocks, type TwinNotifier } from "./notify-tiers.js";
import { composeBindingQuestionPost, insertPost, type PostPart } from "./posts.js";
import { insertNoticeWithSystemSend } from "./notices.js";
import { setAutomationPaused } from "./runs/pauses.js";
import { fireDueReminders, inQuietHours } from "./runs/reminders.js";
import { ensureShippedAutomations } from "./runs/shipped-automations.js";
import { createSendLockWriter } from "./send-lock/writer.js";
import type { ThreadEvent } from "./thread/events.js";
import { createThreadSessions } from "./thread/sessions.js";
import { resetAndMigrate, TEST_AUDIT_HMAC_KEY, TEST_DATABASE_URL, withClient } from "./testing/db.js";
import { seatAtTheDoor } from "./testing/door.js";
import { newExecutionPool } from "./testing/execution-pool.js";
import { fakeEmbedder } from "./testing/fake-embedder.js";
import { closeScriptedModels, scriptedModel, type Script } from "./testing/scripted-model.js";
import { insertWaEvent } from "./testing/seam-fixtures.js";
import { disclosedFact } from "./testing/disclosed-fact.js";
import { SETTLE_IMMEDIATELY } from "./testing/settle.js";
import { removeTmpDir } from "./testing/tmp.js";

afterAll(closeScriptedModels);

const SELF_CHAT = "5215550000@s.whatsapp.net";
const CUSTOMER = "5215550001@s.whatsapp.net";
/** The rep's zone: UTC−6 all year. */
const ZONE = "America/Monterrey";
/** Tuesday 22 September 2026, 11:00 on the rep's clock: when Dito's rows were written. */
const MIDDAY = new Date("2026-09-22T17:00:00.000Z");

const executionPool = newExecutionPool();
let tmp: string;
let pool: pg.Pool;

beforeAll(async () => {
  await resetAndMigrate();
  tmp = mkdtempSync(join(tmpdir(), "dito-reminders-int-"));
  pool = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 4 });
});

afterAll(async () => {
  await pool.end();
  removeTmpDir(tmp);
});

interface Twin {
  readonly client: pg.Client;
  readonly twinId: string;
  readonly companyId: string;
  readonly seatId: string;
  readonly dek: Dek;
  readonly bundle: Bundle;
}

async function withTwin(run: (twin: Twin) => Promise<void>): Promise<void> {
  await withClient(async (client) => {
    const twinId = randomUUID();
    const dek = createDekFromMaterial(randomBytes(32));
    const bundle = createBundle(join(tmp, `${twinId}.bundle`), dek);
    const seat = await seatAtTheDoor(client, twinId);
    await ensureShippedAutomations(client, { twinId, seatId: seat.seatId }, MIDDAY);
    try {
      await run({ client, twinId, companyId: seat.companyId, seatId: seat.seatId, dek, bundle });
    } finally {
      bundle.close();
    }
  });
}

function depsFor(twin: Twin, script: Script, raised: ThreadEvent[] = []): TwinRuntimeDeps {
  const { harness } = scriptedModel(script);
  const sessions = createThreadSessions();
  const raise = sessions.raise.bind(sessions);
  sessions.raise = (twinId, event) => {
    raised.push(event);
    raise(twinId, event);
  };
  return {
    db: twin.client,
    executionPool,
    harness,
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
  };
}

/** A draft and its card, born through the one write every post takes. */
async function draftBorn(twin: Twin): Promise<string> {
  const draft = await twin.client.query<{ id: string }>(
    "INSERT INTO drafts (twin_id, destination, content_enc) VALUES ($1, $2, $3) RETURNING id",
    [twin.twinId, CUSTOMER, Buffer.from(twin.dek.encrypt(Buffer.from("te las dejo en 4500", "utf8")))],
  );
  const draftId = draft.rows[0]!.id;
  const parts: PostPart[] = [{ kind: "draft", draftId, counterparty: "Sra. Garza", body: "te las dejo en 4500" } as PostPart];
  await insertPost(twin.client, { twinId: twin.twinId, dek: twin.dek, parts, delivery: { draftId }, timeZone: ZONE });
  return await postOf(twin, "p.draft_id = $2", draftId);
}

/** A binding question, born through the notice seam. */
async function questionBorn(twin: Twin): Promise<string> {
  const about = await insertWaEvent(twin.client, twin.dek, {
    twinId: twin.twinId,
    companyId: twin.companyId,
    seatId: twin.seatId,
    chatJid: CUSTOMER,
    senderJid: CUSTOMER,
    fromMe: false,
    messageId: `M-${randomUUID().slice(0, 8)}`,
    text: "me mandas 40 cajas",
    pushName: "Sra. Garza",
  });
  await insertNoticeWithSystemSend(twin.client, {
    twinId: twin.twinId,
    selfChatJid: SELF_CHAT,
    dek: twin.dek,
    kind: "binding_question",
    aboutEventId: about,
    post: composeBindingQuestionPost({ aboutEventId: about, proposedName: "Sra. Garza" }),
    timeZone: ZONE,
  });
  return await postOf(twin, "p.question_subject = 'binding' AND $2::text IS NOT NULL", "any");
}

async function postOf(twin: Twin, where: string, value: string): Promise<string> {
  const res = await twin.client.query<{ id: string }>(
    `SELECT p.id FROM posts p WHERE p.twin_id = $1 AND ${where} ORDER BY p.posted_at DESC LIMIT 1`,
    [twin.twinId, value],
  );
  return res.rows[0]!.id;
}

async function reminderOf(
  twin: Twin,
  postId: string,
): Promise<{ subject: string; fire_at: Date; fired_at: Date | null; ended_at: Date | null } | undefined> {
  const res = await twin.client.query<{ subject: string; fire_at: Date; fired_at: Date | null; ended_at: Date | null }>(
    `SELECT s.subject, s.fire_at, s.fired_at, s.ended_at FROM schedules s
       JOIN automations a ON a.id = s.automation_id AND a.shipped = 'reminders'
      WHERE s.post_id = $1 AND s.kind = 'once'`,
    [postId],
  );
  return res.rows[0];
}

describe("a card that can lapse is born with its reminder row (ticket #364)", () => {
  it("a draft waits for the next morning's first waking instant", async () => {
    await withTwin(async (twin) => {
      const postId = await draftBorn(twin);
      const reminder = await reminderOf(twin, postId);
      expect(reminder).toMatchObject({ subject: "draft_waiting", fired_at: null });
      expect(inQuietHours(reminder!.fire_at, ZONE)).toBe(false);
      expect(reminder!.fire_at.getTime()).toBeGreaterThan(Date.now());
    });
  });

  it("a binding question comes due on its sixth day, outside quiet hours", async () => {
    await withTwin(async (twin) => {
      const postId = await questionBorn(twin);
      const reminder = await reminderOf(twin, postId);
      expect(reminder).toMatchObject({ subject: "question_expiring", fired_at: null });
      expect(inQuietHours(reminder!.fire_at, ZONE)).toBe(false);
      const days = (reminder!.fire_at.getTime() - Date.now()) / 86_400_000;
      expect(days).toBeGreaterThan(5.5);
      expect(days).toBeLessThan(7);
    });
  });

  it("the day's notes come due two hours before their correction window closes, outside quiet hours", async () => {
    await withTwin(async (twin) => {
      const { postId } = await disclosedFact(twin.client, twin);
      const reminder = await reminderOf(twin, postId);
      expect(reminder).toMatchObject({ subject: "window_closing", fired_at: null });
      // THE FIXTURE POSTS ON THE HOST'S CLOCK, the zone an unset one means.
      expect(inQuietHours(reminder!.fire_at, Intl.DateTimeFormat().resolvedOptions().timeZone)).toBe(false);
    });
  });

  it("writes no row for a card that cannot lapse", async () => {
    await withTwin(async (twin) => {
      await insertPost(twin.client, {
        twinId: twin.twinId,
        dek: twin.dek,
        parts: [{ kind: "prose", text: "listo" }],
        asked: { door: "dashboard", unasked: true },
        timeZone: ZONE,
      });
      const rows = await twin.client.query("SELECT 1 FROM schedules WHERE twin_id = $1 AND post_id IS NOT NULL", [twin.twinId]);
      expect(rows.rows).toEqual([]);
    });
  });
});

describe("a due reminder wakes the thread, which alone decides to knock (ticket #364; ADR-0031)", () => {
  it("raises `expiring` for a card that still waits, once, and the thread's knock is the reminder's", async () => {
    await withTwin(async (twin) => {
      const postId = await draftBorn(twin);
      const due = (await reminderOf(twin, postId))!.fire_at;
      const raised: ThreadEvent[] = [];
      const script: Script = (prompt) =>
        prompt.includes("expiring")
          ? [
              { toolCall: { name: "knock", input: { post_id: postId, sentence: "Te espera el borrador para la Sra. Garza." } } },
              { text: "" },
            ]
          : [{ text: "" }];
      const deps = depsFor(twin, script, raised);
      expect(await fireDueReminders(deps, new Date(due.getTime() - 60_000))).toBe(0);
      expect(await fireDueReminders(deps, due)).toBe(1);
      expect(raised).toEqual([{ kind: "expiring", postId, subject: "draft_waiting" }]);
      expect(await fireDueReminders(deps, new Date(due.getTime() + 60_000))).toBe(0);
      expect((await reminderOf(twin, postId))!.fired_at).toEqual(due);

      // THE THREAD'S TURN ON THE EVENT knocks through the knock tool.
      await processPendingWaEvents(deps);
      const knocks = await twin.client.query<{ subject: string | null }>(
        "SELECT subject FROM post_knocks WHERE post_id = $1",
        [postId],
      );
      expect(knocks.rows).toEqual([{ subject: "draft_waiting" }]);

      // ...and the at-once tier delivers it as a reminder, the knock's own message.
      const asks: { type: string; about: string }[] = [];
      const notifier: TwinNotifier = {
        send: async (request) => {
          asks.push({ type: request.type, about: request.about });
          await twin.client.query(
            `INSERT INTO notify_sends (seat_id, message_type, requested_at, outcome, settled_at, about_ref)
             VALUES ($1, $2, now(), 'sent', now(), $3)`,
            [request.seatId, request.type, request.about],
          );
          return {};
        },
      };
      await twin.client.query(
        `INSERT INTO push_subscriptions (seat_id, endpoint, p256dh, auth, created_at)
         VALUES ($1, $2, $3, $4, now() - interval '1 day')`,
        [twin.seatId, `https://push.example/${randomUUID()}`, "p256dh", "auth"],
      ).catch(() => undefined);
      await deliverPendingKnocks({ db: twin.client, twinId: twin.twinId, dek: twin.dek, notify: notifier }, new Date());
      expect(asks).toEqual([{ type: "reminder", about: postId }]);
    });
  });

  it("stamps a settled card's row and wakes nobody", async () => {
    await withTwin(async (twin) => {
      const postId = await draftBorn(twin);
      const due = (await reminderOf(twin, postId))!.fire_at;
      const draftId = (await twin.client.query<{ draft_id: string }>("SELECT draft_id FROM posts WHERE id = $1", [postId])).rows[0]!.draft_id;
      const dismissal = await insertWaEvent(twin.client, twin.dek, {
        twinId: twin.twinId,
        companyId: twin.companyId,
        seatId: twin.seatId,
        chatJid: SELF_CHAT,
        senderJid: SELF_CHAT,
        fromMe: true,
        messageId: `D-${randomUUID().slice(0, 8)}`,
        text: "no va",
      });
      await twin.client.query("INSERT INTO draft_dismissals (draft_id, source_event_id) VALUES ($1, $2)", [draftId, dismissal]);
      const raised: ThreadEvent[] = [];
      expect(await fireDueReminders(depsFor(twin, [], raised), due)).toBe(0);
      expect(raised).toEqual([]);
      // ENDED, NOT FIRED: the row passed and owes no knock.
      expect(await reminderOf(twin, postId)).toMatchObject({ fired_at: null, ended_at: due });
    });
  });

  it("a notes reminder whose window opened late moves to two hours before that window closes, and wakes nobody yet (Codex r1)", async () => {
    await withTwin(async (twin) => {
      // THE NOTES REACHED THE REP TEN HOURS AFTER THEY WERE POSTED — a rail
      // that held the send — so their window closes ten hours later too.
      const reachedAt = new Date(Date.now() + 10 * 3_600_000);
      const { postId } = await disclosedFact(twin.client, twin, { reachedAt });
      const written = (await reminderOf(twin, postId))!.fire_at;
      const raised: ThreadEvent[] = [];
      expect(await fireDueReminders(depsFor(twin, [], raised), written)).toBe(0);
      expect(raised).toEqual([]);
      const moved = (await reminderOf(twin, postId))!;
      expect(moved).toMatchObject({ fired_at: null, ended_at: null });
      expect(moved.fire_at.getTime()).toBeGreaterThan(written.getTime());
      expect(moved.fire_at.getTime()).toBeLessThan(reachedAt.getTime() + 24 * 3_600_000);
      expect(inQuietHours(moved.fire_at, ZONE)).toBe(false);
    });
  });

  it("with the reminders «En pausa» no row wakes the thread", async () => {
    await withTwin(async (twin) => {
      const postId = await draftBorn(twin);
      const due = (await reminderOf(twin, postId))!.fire_at;
      const row = await twin.client.query<{ id: string }>(
        "SELECT id FROM automations WHERE twin_id = $1 AND shipped = 'reminders'",
        [twin.twinId],
      );
      await setAutomationPaused(twin.client, { twinId: twin.twinId, seatId: twin.seatId, automationId: row.rows[0]!.id, paused: true });
      const raised: ThreadEvent[] = [];
      expect(await fireDueReminders(depsFor(twin, [], raised), due)).toBe(0);
      expect(raised).toEqual([]);
      // THE ROW ENDS UNFIRED, so turning the switch back on grants the thread
      // no knock for it and Rutinas counts no firing.
      expect(await reminderOf(twin, postId)).toMatchObject({ fired_at: null, ended_at: due });
      expect(await fireDueReminders(depsFor(twin, [], raised), new Date(due.getTime() + 60_000))).toBe(0);
    });
  });

  it("the nudge's store and its message are gone", async () => {
    await withTwin(async (twin) => {
      const table = await twin.client.query("SELECT to_regclass('public.nudges') AS t");
      expect(table.rows).toEqual([{ t: null }]);
      const { NOTIFY_MESSAGE_TYPES } = await import("@dito/notify");
      expect([...NOTIFY_MESSAGE_TYPES]).not.toContain("nudge");
    });
  });
});

