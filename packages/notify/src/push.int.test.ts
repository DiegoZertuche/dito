/**
 * THE PUSH RAIL, AGAINST A RECEIVER THAT DECRYPTS WHAT ARRIVED (ticket #262
 * AC 2; spec #258 *Testing decisions* — "notify's push transport tested
 * against a local receiver holding the test subscription's keys"; ADR-0022 as
 * amended, ADR-0019's sixth flow, ADR-0028).
 *
 * ═══ THE RECEIVER IS THE ORACLE, AND IT IS WRITTEN FROM THE RFC
 *
 * A test that asked the transport to decrypt its own ciphertext would pass by
 * construction and prove nothing about what a BROWSER would open. So the
 * receiver below holds the subscription's PRIVATE key and its auth secret, and
 * undoes the encryption the way RFC 8291 §3.4 and RFC 8188 §2 say a user agent
 * does — parse the header, agree the key, derive the content key and the
 * nonce, open the record, strip the delimiter. Nothing in it calls
 * `push.ts`; the only thing the two share is the standard.
 *
 * ═══ NO PUSH SERVICE IS TOUCHED
 *
 * The receiver is a Node HTTP server on loopback, and the subscription's
 * endpoint names it. That is the same shape the SES lane refuses to take —
 * there the real provider is the only proof and the suite loud-skips without
 * credentials — and the difference is what is being proven: SES's claim is
 * "the SDK command is right", which only SES can answer, and push's claim is
 * "these bytes are what a browser opens", which anybody holding the private
 * key can answer exactly. A browser vendor's service adds latency and an
 * outage and confirms nothing this does not.
 *
 * EVERY VALUE IS OBVIOUSLY SYNTHETIC: the VAPID pair is generated per run and
 * never committed, the subscription's keys are made here, and the endpoint is
 * loopback.
 */
import {
  createDecipheriv,
  createECDH,
  hkdfSync,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { NotifyError } from "./catalog.js";
import { createNotify, type EmailTransport, type Notify } from "./notify.js";
import {
  encryptPushPayload,
  generateVapidKeys,
  livePushTransport,
  vapidAuthorization,
  type PushSubscription,
} from "./push.js";
import { resetAndMigrate, seedSeat, TEST_DATABASE_URL } from "./testing/db.js";

const AT = new Date("2026-09-22T18:00:00Z");
const DASHBOARD = "https://dito.test";
const KNOCK = "Te dejé listo lo de Garza.";
/** ...and the sentence the near-expiry tier composes (ticket #268). */
const REMINDER = "Te quedó pendiente el borrador de Garza desde ayer.";

/** A transport that would send mail, so an email arm cannot pass unnoticed. */
function recordingEmail(): EmailTransport & { readonly sent: number[] } {
  const sent: number[] = [];
  return {
    sent,
    send: () => {
      sent.push(1);
      return Promise.resolve({ providerMessageId: `0100-${sent.length}` });
    },
  };
}

/** ...and one whose provider says no, the way SES does when it will not send. */
function refusingEmail(): EmailTransport & { readonly sent: number[] } {
  const sent: number[] = [];
  return {
    sent,
    send: () => {
      // COUNTED EVEN THOUGH IT LEFT NOTHING: what the cases below are about is
      // whether the channel was ATTEMPTED, and a retry that never reached the
      // transport is the failure this ticket closes.
      sent.push(1);
      return Promise.reject(new Error("the transport would not take it"));
    },
  };
}

/**
 * ONE BROWSER'S KEYS, as the Push API would hand them over.
 *
 * The private half never leaves this process and is what makes the receiver
 * an independent reader rather than a mirror of the sender.
 */
function browserKeys(): {
  readonly subscription: Omit<PushSubscription, "endpoint">;
  readonly privateKey: Buffer;
} {
  const pair = createECDH("prime256v1");
  pair.generateKeys();
  const auth = randomBytes(16);
  return {
    subscription: {
      p256dh: pair.getPublicKey().toString("base64url"),
      auth: auth.toString("base64url"),
    },
    privateKey: pair.getPrivateKey(),
  };
}

/**
 * WHAT A USER AGENT DOES WITH AN `aes128gcm` BODY (RFC 8188 §2, RFC 8291 §3.4)
 * — written from the standard, never from the transport under test.
 */
function openPushBody(
  body: Buffer,
  keys: { readonly subscription: Omit<PushSubscription, "endpoint">; readonly privateKey: Buffer },
): string {
  const salt = body.subarray(0, 16);
  const keyLength = body.readUInt8(20);
  const senderPublic = body.subarray(21, 21 + keyLength);
  const record = body.subarray(21 + keyLength);
  const agreement = createECDH("prime256v1");
  agreement.setPrivateKey(keys.privateKey);
  const shared = agreement.computeSecret(senderPublic);
  const clientPublic = Buffer.from(keys.subscription.p256dh, "base64url");
  const prk = Buffer.from(
    hkdfSync(
      "sha256",
      shared,
      Buffer.from(keys.subscription.auth, "base64url"),
      Buffer.concat([
        Buffer.from("WebPush: info\0", "utf8"),
        clientPublic,
        senderPublic,
      ]),
      32,
    ),
  );
  const contentKey = Buffer.from(
    hkdfSync("sha256", prk, salt, Buffer.from("Content-Encoding: aes128gcm\0", "utf8"), 16),
  );
  const nonce = Buffer.from(
    hkdfSync("sha256", prk, salt, Buffer.from("Content-Encoding: nonce\0", "utf8"), 12),
  );
  const decipher = createDecipheriv("aes-128-gcm", contentKey, nonce);
  decipher.setAuthTag(record!.subarray(record!.length - 16));
  const opened = Buffer.concat([
    decipher.update(record!.subarray(0, record!.length - 16)),
    decipher.final(),
  ]);
  // The last record's padding delimiter is `0x02`; everything before it is the
  // message a browser hands its service worker.
  const delimiter = opened.lastIndexOf(0x02);
  return opened.subarray(0, delimiter).toString("utf8");
}

/** One request the receiver took, as this suite reads it. */
interface Arrival {
  readonly authorization: string;
  readonly contentEncoding: string;
  readonly ttl: string;
  readonly body: Buffer;
}

/** The local push service: it answers whatever the case under test needs. */
interface Receiver {
  readonly origin: string;
  readonly arrivals: Arrival[];
  answer(status: number): void;
  /**
   * ...or takes the request and never answers at all (ticket #276) — the one
   * behaviour a status cannot express, and the one that holds a caller open
   * for as long as the socket stays alive.
   */
  hang(on: boolean): void;
  close(): Promise<void>;
}

async function startReceiver(): Promise<Receiver> {
  const arrivals: Arrival[] = [];
  let status = 201;
  let hanging = false;
  const held: ServerResponse[] = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      arrivals.push({
        authorization: String(request.headers["authorization"] ?? ""),
        contentEncoding: String(request.headers["content-encoding"] ?? ""),
        ttl: String(request.headers["ttl"] ?? ""),
        body: Buffer.concat(chunks),
      });
      if (hanging) {
        // HELD RATHER THAN DROPPED, because «the service is down» and «the
        // service accepted the connection and went quiet» are different
        // failures and only the second one hangs a caller.
        held.push(response);
        return;
      }
      response.writeHead(status);
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    origin: `http://127.0.0.1:${String(port)}`,
    arrivals,
    answer: (next) => {
      status = next;
    },
    hang: (on) => {
      hanging = on;
      if (!on) for (const response of held.splice(0)) response.end();
    },
    close: async () => {
      for (const response of held.splice(0)) response.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    },
  };
}

let db: pg.Client;
let pool: pg.Pool;
let receiver: Receiver;
const vapid = generateVapidKeys("mailto:operador@dito.test");

beforeAll(async () => {
  await resetAndMigrate();
  db = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await db.connect();
  pool = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 4 });
  receiver = await startReceiver();
}, 180_000);

afterAll(async () => {
  await receiver?.close();
  await pool?.end();
  await db?.end();
});

beforeEach(async () => {
  receiver.answer(201);
  receiver.arrivals.length = 0;
  await db.query("DELETE FROM push_subscriptions");
  await db.query("DELETE FROM notify_sends");
  await db.query("DELETE FROM sessions");
  await db.query("DELETE FROM seats");
  await db.query("DELETE FROM companies");
});

/** One seat with one logged-in browser that has accepted notifications. */
async function seatWithBrowser(): Promise<{
  readonly seatId: string;
  readonly subscriptionId: string;
  readonly keys: ReturnType<typeof browserKeys>;
}> {
  const seat = await seedSeat(db);
  const session = await db.query<{ id: string }>(
    `INSERT INTO sessions (company_id, seat_id, token_sha256, expires_at)
     VALUES ($1, $2, $3, now() + interval '90 days') RETURNING id`,
    [seat.companyId, seat.seatId, randomBytes(32)],
  );
  const keys = browserKeys();
  const row = await db.query<{ id: string }>(
    `INSERT INTO push_subscriptions
       (company_id, seat_id, session_id, endpoint, p256dh, auth)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [
      seat.companyId,
      seat.seatId,
      session.rows[0]!.id,
      `${receiver.origin}/push/${randomUUID()}`,
      keys.subscription.p256dh,
      keys.subscription.auth,
    ],
  );
  return { seatId: seat.seatId, subscriptionId: row.rows[0]!.id, keys };
}

function notifyWithPush(email: EmailTransport & { readonly sent: number[] } = recordingEmail()) {
  return {
    email,
    notify: createNotify({
      db: pool,
      transport: email,
      push: livePushTransport(vapid),
      now: () => AT,
      dashboardOrigin: DASHBOARD,
    }),
  };
}

describe("the knock reaches a browser, encrypted to it (ticket #262 AC 2)", () => {
  it("delivers the twin's own sentence and the link to the card", async () => {
    const seat = await seatWithBrowser();
    const postId = randomUUID();
    const { notify, email } = notifyWithPush();

    const [record] = await notify.send({
      type: "draft_ready",
      seatId: seat.seatId,
      slots: { body: KNOCK },
      about: postId,
    });

    expect(receiver.arrivals).toHaveLength(1);
    const arrival = receiver.arrivals[0]!;
    // WHAT A BROWSER WOULD OPEN, decrypted with the subscription's own private
    // key by code written from the RFC.
    expect(JSON.parse(openPushBody(arrival.body, seat.keys))).toEqual({
      title: "Dito",
      body: KNOCK,
      url: `${DASHBOARD}/#post-${postId}`,
    });
    // ...and the framing a service checks before it forwards anything.
    expect(arrival.contentEncoding).toBe("aes128gcm");
    expect(arrival.authorization.startsWith("vapid t=")).toBe(true);
    expect(arrival.authorization).toContain(`k=${vapid.publicKey}`);
    expect(Number(arrival.ttl)).toBeGreaterThan(0);
    // The record says it left, and it is content-free: the sentence is
    // nowhere in it and the row names the post it announced.
    expect(record!.outcome).toBe("sent");
    expect(record!.aboutRef).toBe(postId);
    const stored = await db.query<{ message_type: string; about_ref: string }>(
      "SELECT message_type, about_ref FROM notify_sends",
    );
    expect(stored.rows).toEqual([
      { message_type: "draft_ready", about_ref: postId },
    ]);
    // A PUSH TYPE SENDS NO MAIL, which is the containment ADR-0022's
    // amendment buys: composed text leaves by push and never through SES.
    expect(email.sent).toHaveLength(0);
  });

  it("sends one request per subscription of the seat", async () => {
    const seat = await seatWithBrowser();
    const second = browserKeys();
    const session = await db.query<{ id: string }>(
      "SELECT id FROM sessions LIMIT 1",
    );
    const company = await db.query<{ company_id: string }>(
      "SELECT company_id FROM seats WHERE id = $1",
      [seat.seatId],
    );
    await db.query(
      `INSERT INTO push_subscriptions
         (company_id, seat_id, session_id, endpoint, p256dh, auth)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        company.rows[0]!.company_id,
        seat.seatId,
        session.rows[0]!.id,
        `${receiver.origin}/push/${randomUUID()}`,
        second.subscription.p256dh,
        second.subscription.auth,
      ],
    );

    const { notify } = notifyWithPush();
    const records = await notify.send({
      type: "draft_ready",
      seatId: seat.seatId,
      slots: { body: KNOCK },
      about: randomUUID(),
    });

    // TWO REQUESTS AND TWO ROWS (ticket #276). The fan-out is per device and
    // so is the record: one row stood for the whole ask, so a crash between
    // the two lost the second device's delivery for good and a 201 beside a
    // 500 read as `sent`.
    expect(receiver.arrivals).toHaveLength(2);
    expect(openPushBody(receiver.arrivals[0]!.body, seat.keys)).toContain(KNOCK);
    expect(
      openPushBody(receiver.arrivals[1]!.body, {
        subscription: second.subscription,
        privateKey: second.privateKey,
      }),
    ).toContain(KNOCK);
    expect(records.map((one) => one.outcome)).toEqual(["sent", "sent"]);
    const rows = await db.query<{ channel: string; subscription_id: string }>(
      "SELECT channel, subscription_id FROM notify_sends ORDER BY requested_at",
    );
    expect(rows.rows.map((row) => row.channel)).toEqual(["push", "push"]);
    // ...and each names the browser it reached, so no device can be counted
    // twice and none can be lost.
    expect(new Set(rows.rows.map((row) => row.subscription_id)).size).toBe(2);
  });

  it("retires a subscription the service says is gone", async () => {
    const seat = await seatWithBrowser();
    receiver.answer(410);
    const { notify } = notifyWithPush();

    const [record] = await notify.send({
      type: "draft_ready",
      seatId: seat.seatId,
      slots: { body: KNOCK },
      about: randomUUID(),
    });

    // GONE IS AN ANSWER AND NOT A FAILURE (RFC 8030 §7.3): the row stops
    // being a place to deliver, so the next ask never tries it again.
    const ended = await db.query<{ ended_at: Date | null }>(
      "SELECT ended_at FROM push_subscriptions WHERE id = $1",
      [seat.subscriptionId],
    );
    expect(ended.rows[0]!.ended_at).not.toBeNull();
    expect(record!.outcome).toBe("refused");
    expect(record!.reason).toBe("no_subscription");

    receiver.answer(201);
    receiver.arrivals.length = 0;
    await notify.send({
      type: "draft_ready",
      seatId: seat.seatId,
      slots: { body: KNOCK },
      about: randomUUID(),
    });
    expect(receiver.arrivals).toHaveLength(0);
  });

  it("records a seat with no subscription and raises nothing", async () => {
    const seat = await seedSeat(db);
    const { notify } = notifyWithPush();

    const [record] = await notify.send({
      type: "draft_ready",
      seatId: seat.seatId,
      slots: { body: KNOCK },
      about: randomUUID(),
    });

    expect(record!.outcome).toBe("refused");
    expect(record!.reason).toBe("no_subscription");
    expect(receiver.arrivals).toHaveLength(0);
  });

  it("records a service that refused, and never throws at the pass", async () => {
    const seat = await seatWithBrowser();
    receiver.answer(500);
    const { notify } = notifyWithPush();

    const [record] = await notify.send({
      type: "draft_ready",
      seatId: seat.seatId,
      slots: { body: KNOCK },
      about: randomUUID(),
    });

    // A PUSH FAILURE IS A ROW ALONE. There is nothing a caller can do about a
    // push service saying no, and a throw here would stop the runtime's pass
    // over a notification (ADR-0042's class of failure that is not
    // infrastructure).
    expect(record!.outcome).toBe("failed");
    expect(record!.reason).toBe("transport_failed");
    const live = await db.query("SELECT 1 FROM push_subscriptions WHERE ended_at IS NULL");
    expect(live.rowCount).toBe(1);
  });

  it("refuses an announcement that names no post, before any row is written", async () => {
    const seat = await seatWithBrowser();
    const { notify } = notifyWithPush();

    await expect(
      notify.send({
        type: "draft_ready",
        seatId: seat.seatId,
        slots: { body: KNOCK },
      }),
    ).rejects.toThrow(/knock is tied to a post that exists/u);
    const rows = await db.query("SELECT 1 FROM notify_sends");
    expect(rows.rowCount).toBe(0);
  });

  it("refuses a sentence carrying a link of its own, because the link is code's", async () => {
    const seat = await seatWithBrowser();
    const { notify } = notifyWithPush();

    await expect(
      notify.send({
        type: "draft_ready",
        seatId: seat.seatId,
        slots: { body: "míralo en https://otro.example/x" },
        about: randomUUID(),
      }),
    ).rejects.toThrow(/cannot be rendered/u);
    expect(receiver.arrivals).toHaveLength(0);
  });
});

describe("a reminder reaches a browser and no inbox (ticket #268 AC 3 and AC 4)", () => {
  it("delivers the twin's own sentence and the link to the card it is about", async () => {
    const seat = await seatWithBrowser();
    const postId = randomUUID();
    const { notify, email } = notifyWithPush();

    const [record] = await notify.send({
      type: "reminder",
      seatId: seat.seatId,
      slots: { body: REMINDER },
      about: postId,
    });

    // THE SAME WIRE THE KNOCK TAKES, which is why the type exists rather than
    // the knock being reused for it: what differs is the occasion, and the
    // deep link still names the card the rep taps through to.
    expect(receiver.arrivals).toHaveLength(1);
    expect(
      JSON.parse(openPushBody(receiver.arrivals[0]!.body, seat.keys)),
    ).toEqual({
      title: "Dito",
      body: REMINDER,
      url: `${DASHBOARD}/#post-${postId}`,
    });
    expect(record!.outcome).toBe("sent");
    expect(record!.aboutRef).toBe(postId);
    const stored = await db.query<{ message_type: string; about_ref: string }>(
      "SELECT message_type, about_ref FROM notify_sends",
    );
    expect(stored.rows).toEqual([{ message_type: "reminder", about_ref: postId }]);
    // NO REMINDER EVER GOES BY EMAIL (spec #258 decision 7: email is for grave
    // events only). The type has no email template at all, so `sendOn` never
    // reaches the SES transport however a caller asks.
    expect(email.sent).toHaveLength(0);
  });

  it("sends one request per subscription of the seat, and records one ask", async () => {
    // THE TICKET'S OWN WORDS, over this type: "one send per subscription"
    // (#268 AC 1). The fan-out is `sendOn`'s one loop with no message type in
    // it — the knock's case one screen up pins the same loop — and what is
    // asserted here is that the reminder really rides it, because the pass reads
    // ONE row back to decide whether it ever has to ask again.
    const seat = await seatWithBrowser();
    const second = browserKeys();
    const session = await db.query<{ id: string }>(
      "SELECT id FROM sessions LIMIT 1",
    );
    const company = await db.query<{ company_id: string }>(
      "SELECT company_id FROM seats WHERE id = $1",
      [seat.seatId],
    );
    await db.query(
      `INSERT INTO push_subscriptions
         (company_id, seat_id, session_id, endpoint, p256dh, auth)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        company.rows[0]!.company_id,
        seat.seatId,
        session.rows[0]!.id,
        `${receiver.origin}/push/${randomUUID()}`,
        second.subscription.p256dh,
        second.subscription.auth,
      ],
    );
    const { notify } = notifyWithPush();

    const [record] = await notify.send({
      type: "reminder",
      seatId: seat.seatId,
      slots: { body: REMINDER },
      about: randomUUID(),
    });

    expect(receiver.arrivals).toHaveLength(2);
    // EACH DEVICE GETS ITS OWN CIPHERTEXT, and only its own key opens it.
    expect(JSON.parse(openPushBody(receiver.arrivals[0]!.body, seat.keys)).body).toBe(
      REMINDER,
    );
    expect(JSON.parse(openPushBody(receiver.arrivals[1]!.body, second)).body).toBe(
      REMINDER,
    );
    expect(record!.outcome).toBe("sent");
    // ONE ROW PER BROWSER (ticket #276), which is what lets a fan-out
    // interrupted between the two resume with the one it never reached.
    const rows = await db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM notify_sends",
    );
    expect(rows.rows[0]!.n).toBe(2);
  });

  it("records a seat with no browser and sends nothing at all", async () => {
    // A SEAT THAT DECLINED NOTIFICATIONS RECEIVES NOTHING FOR A ROUTINE WAIT,
    // which is the digest's absence said from the other end (spec #258): the
    // dashboard is a pull surface then, and the row is the record.
    const seat = await seedSeat(db);
    const { notify, email } = notifyWithPush();

    const [record] = await notify.send({
      type: "reminder",
      seatId: seat.seatId,
      slots: { body: REMINDER },
      about: randomUUID(),
    });

    expect(record!.outcome).toBe("refused");
    expect(email.sent).toHaveLength(0);
    expect(receiver.arrivals).toHaveLength(0);
  });
});

describe("a grave event goes both ways, in code (ticket #262 AC 5)", () => {
  it("mails the seat and pushes every browser, once", async () => {
    const seat = await seatWithBrowser();
    const { notify, email } = notifyWithPush();

    const [record] = await notify.send({
      type: "rail_dropped",
      seatId: seat.seatId,
      slots: {},
      about: "4210",
    });

    expect(email.sent).toHaveLength(1);
    expect(receiver.arrivals).toHaveLength(1);
    // THE CALLER NAMED NO PAGE. Both transports take the destination off the
    // catalog entry and the deployment's own origin, so an email and a push
    // about one event cannot send a rep to two places.
    // NO TWIN VOICE ON EITHER (ADR-0037): the push body is the copy package's
    // own sentence, and the link goes where a rep re-links.
    expect(JSON.parse(openPushBody(receiver.arrivals[0]!.body, seat.keys))).toEqual({
      title: "Dito",
      body: "Tu WhatsApp se desconectó. Vuelve a conectarlo en Conexiones.",
      url: `${DASHBOARD}/conexiones`,
    });
    expect(record!.outcome).toBe("sent");
    expect(record!.aboutRef).toBe("4210");
  });

  it("still mails a seat whose browsers have all gone", async () => {
    const seat = await seedSeat(db);
    const { notify, email } = notifyWithPush();

    const [record] = await notify.send({
      type: "rail_dropped",
      seatId: seat.seatId,
      slots: {},
      about: "4211",
    });

    // THE ONE OCCASION THAT MUST REACH A REP WHO DECLINED NOTIFICATIONS
    // (spec #258 decision 7): email is the floor for a grave event and for
    // nothing else.
    expect(email.sent).toHaveLength(1);
    expect(record!.outcome).toBe("sent");
  });
});

describe("each destination is its own attempt (ticket #276)", () => {
  /** A second browser of the same seat, logged in under the same session. */
  async function secondBrowser(seatId: string): Promise<{
    readonly id: string;
    readonly keys: ReturnType<typeof browserKeys>;
  }> {
    const seat = await db.query<{ company_id: string }>(
      "SELECT company_id FROM seats WHERE id = $1",
      [seatId],
    );
    const session = await db.query<{ id: string }>(
      "SELECT id FROM sessions WHERE seat_id = $1 LIMIT 1",
      [seatId],
    );
    const keys = browserKeys();
    const row = await db.query<{ id: string }>(
      `INSERT INTO push_subscriptions
         (company_id, seat_id, session_id, endpoint, p256dh, auth)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [
        seat.rows[0]!.company_id,
        seatId,
        session.rows[0]!.id,
        `${receiver.origin}/push/${randomUUID()}`,
        keys.subscription.p256dh,
        keys.subscription.auth,
      ],
    );
    return { id: row.rows[0]!.id, keys };
  }

  /**
   * The same service a pass later, with its clock moved past the spacing.
   *
   * A CLOCK IS A PARAMETER IN THIS PACKAGE, so «the next pass» is an instant
   * rather than a wait: a failed attempt stands for five minutes, which is
   * what stops a retry becoming a request on every two-second tick, and a case
   * about the retry has to be on the far side of it.
   */
  function nextPass(email = recordingEmail()): {
    readonly email: EmailTransport & { readonly sent: number[] };
    readonly notify: Notify;
  } {
    return {
      email,
      notify: createNotify({
        db: pool,
        transport: email,
        push: livePushTransport(vapid),
        now: () => new Date(AT.getTime() + 10 * 60 * 1000),
        dashboardOrigin: DASHBOARD,
      }),
    };
  }

  /** One attempt, as the store holds it. */
  interface AttemptRow {
    readonly channel: string;
    readonly outcome: string | null;
    readonly reason: string | null;
    readonly subscription_id: string | null;
  }

  /**
   * Every row about one thing, ordered by what it says rather than by when it
   * was written: every row of one ask carries the suite's one pinned instant,
   * and `notify_sends.id` is a random uuid — so «the order they happened» is
   * not a thing this store can answer and asserting it would be asserting a
   * coin flip. What the cases below are about is WHICH attempts exist.
   */
  async function rowsAbout(about: string): Promise<readonly AttemptRow[]> {
    const rows = await db.query<AttemptRow>(
      `SELECT channel, outcome, reason, subscription_id
         FROM notify_sends WHERE about_ref = $1 ORDER BY channel, outcome`,
      [about],
    );
    return rows.rows;
  }

  it("pushes a grave event while mail is down, and mails it when mail comes back", async () => {
    // THE FAILURE THIS CLOSES (Codex on PR #274, finding 3): an SES rejection
    // settled the ask's one row and threw before the subscription loop, so the
    // push was skipped exactly when mail was down — and a later pass found the
    // row and never tried either again.
    const seat = await seatWithBrowser();
    const refusing = refusingEmail();
    await expect(
      notifyWithPush(refusing).notify.send({
        type: "rail_dropped",
        seatId: seat.seatId,
        slots: {},
        about: "5100",
      }),
    ).rejects.toThrow(NotifyError);

    // The push went out anyway, and each channel recorded its own outcome.
    expect(receiver.arrivals).toHaveLength(1);
    expect(await rowsAbout("5100")).toEqual([
      { channel: "email", outcome: "failed", reason: "transport_failed", subscription_id: null },
      { channel: "push", outcome: "sent", reason: null, subscription_id: seat.subscriptionId },
    ]);

    // THE NEXT PASS RETRIES THE CHANNEL THAT FAILED AND ONLY THAT ONE.
    const { email: working, notify: retrying } = nextPass();
    await retrying.send({
      type: "rail_dropped",
      seatId: seat.seatId,
      slots: {},
      about: "5100",
    });
    expect(working.sent).toHaveLength(1);
    expect(receiver.arrivals).toHaveLength(1);
    expect(
      (await rowsAbout("5100")).map((row) => `${row.channel}:${String(row.outcome)}`),
    ).toEqual(["email:failed", "email:sent", "push:sent"]);

    // ...and a pass after that owes nothing at all.
    const { email: idle, notify: settled } = nextPass();
    expect(
      await settled.send({
        type: "rail_dropped",
        seatId: seat.seatId,
        slots: {},
        about: "5100",
      }),
    ).toEqual([]);
    expect(idle.sent).toHaveLength(0);
    expect(receiver.arrivals).toHaveLength(1);
  });

  it("retries the push a service refused, and never the mail that went", async () => {
    // THE REVERSE DIRECTION, which is the same rule read the other way: a
    // channel is retried until it is recorded sent or refused, and the one
    // that succeeded is never attempted again.
    const seat = await seatWithBrowser();
    receiver.answer(500);
    const first = recordingEmail();
    await notifyWithPush(first).notify.send({
      type: "rail_logged_out",
      seatId: seat.seatId,
      slots: {},
      about: "5200",
    });
    expect(first.sent).toHaveLength(1);
    expect(
      (await rowsAbout("5200")).map((row) => `${row.channel}:${String(row.outcome)}`),
    ).toEqual(["email:sent", "push:failed"]);

    receiver.answer(201);
    receiver.arrivals.length = 0;
    const { email: second, notify: retrying } = nextPass();
    await retrying.send({
      type: "rail_logged_out",
      seatId: seat.seatId,
      slots: {},
      about: "5200",
    });
    expect(second.sent).toHaveLength(0);
    expect(receiver.arrivals).toHaveLength(1);
    expect(
      (await rowsAbout("5200")).map((row) => `${row.channel}:${String(row.outcome)}`),
    ).toEqual(["email:sent", "push:failed", "push:sent"]);
  });

  it("resumes a fan-out a crash interrupted, with the browser it never reached", async () => {
    // THE FAILURE THIS CLOSES (finding 4): one row was opened before the loop
    // over the seat's browsers, so a crash after the laptop and before the
    // phone lost the phone's delivery for good — the next pass saw the row and
    // announced nothing.
    //
    // THE CRASH IS THE STORE IT LEAVES BEHIND, which is what a crash IS at
    // this seam: the laptop's attempt settled, the phone's never opened, and
    // nothing in memory tells the two apart from a fresh process.
    const seat = await seatWithBrowser();
    const phone = await secondBrowser(seat.seatId);
    const post = randomUUID();
    await db.query(
      `INSERT INTO notify_sends
         (seat_id, message_type, requested_at, outcome, settled_at, about_ref,
          channel, subscription_id)
       VALUES ($1, 'draft_ready', $2, 'sent', $2, $3, 'push', $4)`,
      [seat.seatId, AT, post, seat.subscriptionId],
    );

    const records = await notifyWithPush().notify.send({
      type: "draft_ready",
      seatId: seat.seatId,
      slots: { body: KNOCK },
      about: post,
    });

    // ONE REQUEST, TO THE PHONE, and the laptop is never knocked twice.
    expect(receiver.arrivals).toHaveLength(1);
    expect(openPushBody(receiver.arrivals[0]!.body, phone.keys)).toContain(KNOCK);
    expect(records.map((one) => one.subscriptionId)).toEqual([phone.id]);
    expect((await rowsAbout(post)).map((row) => row.subscription_id).sort()).toEqual(
      [seat.subscriptionId, phone.id].sort(),
    );
  });

  it("spaces a retry rather than making one on every tick", async () => {
    // THE BOUND THAT HAS TO COME BACK WITH THE RETRY (the two-axis review's
    // Spec axis). A destination that failed is attempted again — that is what
    // makes a dropped rail reach the rep by mail once mail is back — and the
    // tier that asks runs every two seconds, so a rule that said only «attempt
    // what has not succeeded» would put a request in front of a refusing
    // provider seven hundred times a minute, each one holding the pass for its
    // own deadline and writing a row.
    const seat = await seatWithBrowser();
    receiver.answer(500);
    await notifyWithPush().notify.send({
      type: "draft_ready",
      seatId: seat.seatId,
      slots: { body: KNOCK },
      about: "5400",
    });
    expect(receiver.arrivals).toHaveLength(1);

    // The next pass, seconds later: the failure still stands, so nothing is
    // attempted and no row is written.
    receiver.answer(201);
    expect(
      await notifyWithPush().notify.send({
        type: "draft_ready",
        seatId: seat.seatId,
        slots: { body: KNOCK },
        about: "5400",
      }),
    ).toEqual([]);
    expect(receiver.arrivals).toHaveLength(1);
    expect(await rowsAbout("5400")).toHaveLength(1);

    // ...and a pass after the spacing attempts it once more. The clock is a
    // parameter, so the case moves it rather than waiting.
    await nextPass().notify.send({
      type: "draft_ready",
      seatId: seat.seatId,
      slots: { body: KNOCK },
      about: "5400",
    });
    expect(receiver.arrivals).toHaveLength(2);
    expect(
      (await rowsAbout("5400")).map((row) => String(row.outcome)).sort(),
    ).toEqual(["failed", "sent"]);
  });

  it("records a browser whose service never answered, and goes on", async () => {
    // THE DEADLINE'S OWN ROW (finding 2). What the pass needs is not that the
    // provider answered but that the attempt is settled and the step returns.
    const seat = await seatWithBrowser();
    receiver.hang(true);
    try {
      const records = await notifyWithPush().notify.send({
        type: "draft_ready",
        seatId: seat.seatId,
        slots: { body: KNOCK },
        about: "5300",
      });
      expect(records.map((one) => one.outcome)).toEqual(["failed"]);
      expect(await rowsAbout("5300")).toEqual([
        {
          channel: "push",
          outcome: "failed",
          reason: "transport_failed",
          subscription_id: seat.subscriptionId,
        },
      ]);
    } finally {
      receiver.hang(false);
    }
  }, 30_000);
});

describe("a login that is over takes its browser with it (ticket #276)", () => {
  it("delivers nothing to a browser whose session expired, and ends it", async () => {
    // THE FAILURE THIS CLOSES (finding 5): «Cerrar sesiones» ended the
    // subscriptions it granted, and a session that simply EXPIRED ended
    // nothing — so a laptop nobody had logged in on since spring kept
    // receiving the twin's own composed sentences.
    const seat = await seatWithBrowser();
    // SIX MONTHS BACK AND A DAY PAST ITS EXPIRY, both moved, because the
    // store insists a session expires after it was created — an expiry in the
    // past is only reachable through a login that really is old.
    await db.query(
      "UPDATE sessions SET created_at = $1, expires_at = $2 WHERE seat_id = $3",
      [
        new Date(AT.getTime() - 200 * 24 * 60 * 60 * 1000),
        new Date(AT.getTime() - 24 * 60 * 60 * 1000),
        seat.seatId,
      ],
    );

    const records = await notifyWithPush().notify.send({
      type: "draft_ready",
      seatId: seat.seatId,
      slots: { body: KNOCK },
      about: randomUUID(),
    });

    expect(receiver.arrivals).toHaveLength(0);
    expect(records.map((one) => one.reason)).toEqual(["no_subscription"]);
    // ENDED AND NOT MERELY SKIPPED, so «why did this device stop being
    // notified» has an answer and the tier's own weaker predicate converges.
    const ended = await db.query<{ ended_at: Date | null }>(
      "SELECT ended_at FROM push_subscriptions WHERE id = $1",
      [seat.subscriptionId],
    );
    expect(ended.rows[0]!.ended_at).not.toBeNull();
  });

  it("delivers nothing to a browser whose session was ended, and ends it", async () => {
    const seat = await seatWithBrowser();
    await db.query("UPDATE sessions SET ended_at = $1 WHERE seat_id = $2", [
      AT,
      seat.seatId,
    ]);

    await notifyWithPush().notify.send({
      type: "draft_ready",
      seatId: seat.seatId,
      slots: { body: KNOCK },
      about: randomUUID(),
    });

    expect(receiver.arrivals).toHaveLength(0);
    const ended = await db.query<{ ended_at: Date | null }>(
      "SELECT ended_at FROM push_subscriptions WHERE id = $1",
      [seat.subscriptionId],
    );
    expect(ended.rows[0]!.ended_at).not.toBeNull();
  });

  it("still delivers to a browser whose login is live", async () => {
    const seat = await seatWithBrowser();
    await notifyWithPush().notify.send({
      type: "draft_ready",
      seatId: seat.seatId,
      slots: { body: KNOCK },
      about: randomUUID(),
    });

    expect(receiver.arrivals).toHaveLength(1);
    const live = await db.query<{ ended_at: Date | null }>(
      "SELECT ended_at FROM push_subscriptions WHERE id = $1",
      [seat.subscriptionId],
    );
    expect(live.rows[0]!.ended_at).toBeNull();
  });
});

describe("what the wire carries (ticket #262 AC 2)", () => {
  it("encrypts to the subscription, so the same sentence is never the same bytes", () => {
    const keys = browserKeys();
    const subscription: PushSubscription = {
      endpoint: `${receiver.origin}/push/x`,
      ...keys.subscription,
    };
    const first = encryptPushPayload(subscription, KNOCK);
    const second = encryptPushPayload(subscription, KNOCK);
    // A FRESH EPHEMERAL PAIR AND A FRESH SALT PER MESSAGE (RFC 8291 §3): two
    // sends of one sentence share no bytes past the header's own length, so a
    // service that kept both learns nothing by comparing them.
    expect(first.equals(second)).toBe(false);
    expect(first.toString("latin1")).not.toContain("Garza");
    expect(openPushBody(first, keys)).toBe(KNOCK);
    expect(openPushBody(second, keys)).toBe(KNOCK);
  });

  it("gives up on a service that takes the request and never answers (#276)", async () => {
    // THE RUNTIME AWAITS THIS INSIDE ITS OWN POLL, once per registration, so a
    // service that accepts a connection and goes quiet holds drafting behind
    // it for as long as the socket stays open unless something cuts the call
    // (Codex on PR #274, finding 2). A status cannot express that failure;
    // only a receiver that holds the response can.
    const keys = browserKeys();
    receiver.hang(true);
    try {
      const started = Date.now();
      await expect(
        livePushTransport(vapid).send(
          { endpoint: `${receiver.origin}/push/quiet`, ...keys.subscription },
          { title: "Dito", body: KNOCK, url: `${DASHBOARD}/` },
        ),
      ).rejects.toThrow();
      // Bounded by the deadline rather than by the suite's patience — the
      // request really arrived, and really was cut off.
      expect(Date.now() - started).toBeLessThan(20_000);
      expect(receiver.arrivals).toHaveLength(1);
    } finally {
      receiver.hang(false);
    }
  }, 30_000);

  it("follows no redirect: an endpoint that redirects is not a push service (#269)", async () => {
    // A SUBSCRIPTION ROW IS WRITTEN FROM WHAT A BROWSER POSTED, so its
    // endpoint is a value a rep's own request chose. A redirect would carry
    // this process's POST wherever it pointed — the receiver below stands for
    // a loopback service — and RFC 8030 gives a push service no reason to
    // send one.
    const keys = browserKeys();
    const bouncer: Server = createServer((_request, response) => {
      response.writeHead(307, { location: `${receiver.origin}/push/elsewhere` });
      response.end();
    });
    await new Promise<void>((resolve) => bouncer.listen(0, "127.0.0.1", resolve));
    const before = receiver.arrivals.length;
    try {
      await expect(
        livePushTransport(vapid).send(
          {
            endpoint: `http://127.0.0.1:${String((bouncer.address() as AddressInfo).port)}/push/x`,
            ...keys.subscription,
          },
          { title: "Dito", body: KNOCK, url: `${DASHBOARD}/` },
        ),
      ).rejects.toThrow();
      expect(receiver.arrivals).toHaveLength(before);
    } finally {
      await new Promise<void>((resolve) => bouncer.close(() => resolve()));
    }
  });

  it("signs an assertion for the endpoint's own origin and nobody else's", () => {
    const header = vapidAuthorization("https://push.example/one/two", vapid);
    const claims = header.slice("vapid t=".length).split(".")[1]!;
    const parsed = JSON.parse(Buffer.from(claims, "base64url").toString("utf8")) as {
      aud: string;
      sub: string;
      exp: number;
    };
    // THE AUDIENCE IS THE ORIGIN AND NOT THE ENDPOINT (RFC 8292 §2): an
    // assertion says which SERVICE is being spoken to and never which browser.
    expect(parsed.aud).toBe("https://push.example");
    expect(parsed.sub).toBe("mailto:operador@dito.test");
    expect(parsed.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(header).not.toContain("/one/two");
  });
});
