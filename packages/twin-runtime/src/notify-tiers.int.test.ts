/**
 * THE TIERS, AT THE POSTGRES SEAM (ticket #262 AC 4 and AC 5; spec #258
 * *Notification end to end* and *Testing decisions*; ADR-0031 as amended).
 *
 * Every claim these two steps make is about what the store holds afterwards:
 * which posts have been announced, which have not, and what a restart changes.
 * So the seam is the whole of the test, and the ONE thing standing in is the
 * notifier — which is not a mock of an internal collaborator but the boundary
 * the runtime is handed by its composition root (`TwinNotifier`). What the
 * real service does with an ask is proven against a receiver that decrypts it
 * (`@dito/notify`'s `push.int.test.ts`).
 *
 * THE RESTART IS SIMULATED BY CALLING THE STEP AGAIN, and that is exactly what
 * a restart is here: nothing in these steps keeps state in memory, so a second
 * call over the same rows is a second process reading the same store.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { createDekFromMaterial, type Dek } from "@dito/crypto";
import { describe, expect, it } from "vitest";
import type pg from "pg";
import {
  announceRailTransition,
  deliverPendingKnocks,
  type TwinNotifier,
} from "./notify-tiers.js";
import { sealParts, type PostPart } from "./posts.js";
import { resetAndMigrate, withClient } from "./testing/db.js";

const KNOCK = "Te dejé listo lo de Garza.";
/**
 * The pass's own instant, and the one every fixture is written against.
 *
 * INJECTED RATHER THAN READ, because the at-once tier is bounded by HOW OLD a
 * post is (`ANNOUNCE_WINDOW_MS`) and a suite that let the host clock decide
 * would be asserting against the moment it happened to run.
 */
const NOW = new Date();

/** A notifier that records what it was asked and writes the row notify would. */
function recordingNotifier(
  client: pg.Client,
): TwinNotifier & {
  readonly asks: { type: string; body?: string; about: string }[];
} {
  const asks: { type: string; body?: string; about: string }[] = [];
  return {
    asks,
    send: async (request) => {
      asks.push({
        type: request.type,
        ...(request.slots["body"] === undefined
          ? {}
          : { body: request.slots["body"] }),
        about: request.about,
      });
      // THE ROW IS THE POINT OF THE STAND-IN. «Fire once» is a property of
      // the send record, so a notifier that recorded nothing would make every
      // second pass look like a first one.
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

/** ...and one whose mail rail refuses, the way SES does when it will not send. */
const refusingNotifier: TwinNotifier = {
  send: () => Promise.reject(new Error("the transport would not take it")),
};

/** One company, one seat, and the twin it owns. */
async function seat(
  client: pg.Client,
): Promise<{ seatId: string; twinId: string }> {
  const companyId = randomUUID();
  const seatId = randomUUID();
  const twinId = randomUUID();
  await client.query(
    "INSERT INTO companies (id, display_name) VALUES ($1, $2)",
    [companyId, `Ferretería ${companyId.slice(0, 4)}`],
  );
  await client.query(
    `INSERT INTO seats (id, company_id, twin_id, rep_display_name, state)
     VALUES ($1, $2, $3, $4, 'linked')`,
    [seatId, companyId, twinId, "Mauricio Cantú"],
  );
  return { seatId, twinId };
}

/** A landing knock the thread's knock tool wrote about a post (`post_knocks`). */
interface Knock {
  readonly kind: "knock";
  readonly text: string;
}

/**
 * One post of this twin's, with the parts it carries, sealed — and, where the
 * fixture lists a knock among them, the landing knock the thread wrote about
 * it, a `post_knocks` row at the post's own instant (ticket #358: the one
 * store).
 *
 * DELIVERED BY A DRAFT ROW, whatever the parts say. `posts_one_delivery_check`
 * insists a post names one or the other, and a draft is the arm with no
 * ceremony of its own — which keeps every fixture here about the PARTS and the
 * knock, which is what the tier reads.
 */
async function post(
  client: pg.Client,
  twinId: string,
  dek: Dek,
  given: readonly (PostPart | Knock)[],
  postedAt: Date = NOW,
): Promise<string> {
  const parts = given.filter((part): part is PostPart => part.kind !== "knock");
  const draft = await client.query<{ id: string }>(
    `INSERT INTO drafts (twin_id, destination, content_enc)
     VALUES ($1, $2, $3) RETURNING id`,
    [twinId, "5215550001@s.whatsapp.net", Buffer.from("opaque")],
  );
  // THE INSTANT IS WRITTEN AND NEVER UPDATED: a post is immutable (ADR-0034)
  // and the store refuses an UPDATE outright, so a case about age plants the
  // age rather than moving it afterwards.
  const row = await client.query<{ id: string }>(
    `INSERT INTO posts (twin_id, origin, parts_enc, draft_id, posted_at)
     VALUES ($1, 'composed', $2, $3, $4) RETURNING id`,
    [twinId, sealParts(dek, parts), draft.rows[0]!.id, postedAt],
  );
  const postId = row.rows[0]!.id;
  for (const knock of given.filter((part): part is Knock => part.kind === "knock")) {
    const turn = await client.query<{ id: string }>(
      `INSERT INTO executions
         (twin_id, trigger_kind, trigger_mechanism, trigger_ref, instructions_digest,
          tool_names, lane, started_at, ended_at, iterations, tokens_input,
          tokens_output, disposition)
       VALUES ($1, 'twin_thread_event', 'seam_event', 'event:post.landed', 'digest', '{}', 'realtime', $2, $2, 1, 10, 10, 'acted')
       RETURNING id`,
      [twinId, postedAt],
    );
    await client.query(
      `INSERT INTO post_knocks (post_id, twin_id, text_enc, execution_id, knocked_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [postId, twinId, Buffer.from(dek.encrypt(Buffer.from(knock.text, "utf8"))), turn.rows[0]!.id, postedAt],
    );
  }
  return postId;
}

/**
 * One browser of this seat, logged in and subscribed.
 *
 * THE SESSION IS PART OF THE FIXTURE because a subscription is granted under
 * one and the store insists on the reference — the LOGIN is what a browser's
 * permission hangs off, which is the whole of ticket #276's finding 5 one
 * layer down.
 */
async function browser(
  client: pg.Client,
  seatId: string,
  createdAt: Date = new Date(NOW.getTime() - 60 * 60 * 1000),
): Promise<string> {
  const company = await client.query<{ company_id: string }>(
    "SELECT company_id FROM seats WHERE id = $1",
    [seatId],
  );
  const session = await client.query<{ id: string }>(
    `INSERT INTO sessions (company_id, seat_id, token_sha256, expires_at)
     VALUES ($1, $2, $3, now() + interval '90 days') RETURNING id`,
    [company.rows[0]!.company_id, seatId, randomBytes(32)],
  );
  const row = await client.query<{ id: string }>(
    `INSERT INTO push_subscriptions
       (company_id, seat_id, session_id, endpoint, p256dh, auth, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [
      company.rows[0]!.company_id,
      seatId,
      session.rows[0]!.id,
      `https://push.example/${randomUUID()}`,
      "a".repeat(88),
      "b".repeat(24),
      createdAt,
    ],
  );
  return row.rows[0]!.id;
}

/** One push attempt that stands, as notify would have written it. */
async function attempt(
  client: pg.Client,
  seatId: string,
  postId: string,
  subscriptionId: string,
): Promise<void> {
  await client.query(
    `INSERT INTO notify_sends
       (seat_id, message_type, requested_at, outcome, settled_at, about_ref,
        channel, subscription_id)
     VALUES ($1, 'draft_ready', now(), 'sent', now(), $2, 'push', $3)`,
    [seatId, postId, subscriptionId],
  );
}

async function rail(
  client: pg.Client,
  twinId: string,
  ...statuses: readonly string[]
): Promise<void> {
  for (const status of statuses) {
    await client.query(
      `INSERT INTO rail_status_events (twin_id, status, detail, occurred_at)
       VALUES ($1, $2, '', clock_timestamp())`,
      [twinId, status],
    );
  }
}

describe("the at-once tier delivers each knock once (ticket #262 AC 4)", () => {
  it("announces a draft and a question, and never a post without a knock", async () => {
    await resetAndMigrate();
    await withClient(async (client) => {
      const mauricio = await seat(client);
      const dek = createDekFromMaterial(randomBytes(32));
      // TWO DISTINCT INSTANTS, because the order asserted below is ARRIVAL
      // order and that is a fact about instants the store recorded. Two posts
      // planted at one instant have no arrival order — the read's tie-break is
      // a random uuid — so a fixture that shared one would be asserting the
      // tie-break rather than the promise (CI run 35707946869).
      const drafted = await post(
        client,
        mauricio.twinId,
        dek,
        [
          { kind: "draft", draftId: randomUUID() },
          { kind: "knock", text: KNOCK },
        ],
        new Date(NOW.getTime() - 2 * 60 * 1000),
      );
      const asked = await post(
        client,
        mauricio.twinId,
        dek,
        [
          { kind: "prose", text: "¿este chat es de Garza?" },
          { kind: "question", subject: "binding", aboutEventId: "9" },
          { kind: "knock", text: "Te pregunté de quién es un chat." },
        ],
        new Date(NOW.getTime() - 60 * 1000),
      );
      // A RECEIPT AND THE DAY'S RECORD CARRY NO KNOCK, so neither announces:
      // the disclosure is the twin's account of a day and a receipt is
      // something that already happened (spec #258 decision 7).
      await post(client, mauricio.twinId, dek, [
        { kind: "receipt", text: "Enviado a Garza" },
      ]);
      const notifier = recordingNotifier(client);

      expect(
        await deliverPendingKnocks(
          {
            db: client,
            twinId: mauricio.twinId,
            dek,
            notify: notifier,
          },
          NOW,
        ),
      ).toBe(2);
      // THE TYPE COMES OFF THE POST'S OWN PARTS: a post that asks is a
      // question, and one that proposes is a draft — and they arrive in the
      // order they were written, which is what a rep coming back to an hour of
      // waiting work is owed.
      expect(notifier.asks).toEqual([
        { type: "draft_ready", body: KNOCK, about: drafted },
        {
          type: "question_asked",
          body: "Te pregunté de quién es un chat.",
          about: asked,
        },
      ]);
    });
  });

  it("is never starved by a batch of posts with nothing to announce (#276)", async () => {
    await resetAndMigrate();
    await withClient(async (client) => {
      const mauricio = await seat(client);
      const dek = createDekFromMaterial(randomBytes(32));
      // TWENTY-ONE POSTS AND THE BATCH IS TWENTY, which is the shape the
      // failure needed: the `LIMIT` was cut BEFORE the parts were opened, so
      // twenty receipts filled it on every pass and the twenty-first post's
      // knock was silent for the whole window.
      //
      // THE TWENTY ARE SEALED UNDER A KEY THE TIER DOES NOT HOLD, and that is
      // the pin rather than a counter: `openSealedParts` throws on a foreign
      // key, so a pass that opened even one of them fails loudly. The claim is
      // therefore the strong one — a post with nothing to announce is never
      // opened at all, on this pass or any later one.
      const foreign = createDekFromMaterial(randomBytes(32));
      for (let i = 0; i < 20; i += 1) {
        await post(
          client,
          mauricio.twinId,
          foreign,
          [{ kind: "receipt", text: "Enviado a Garza" }],
          new Date(NOW.getTime() - (30 - i) * 60 * 1000),
        );
      }
      const waiting = await post(
        client,
        mauricio.twinId,
        dek,
        [
          { kind: "draft", draftId: randomUUID() },
          { kind: "knock", text: KNOCK },
        ],
        new Date(NOW.getTime() - 60 * 1000),
      );
      const notifier = recordingNotifier(client);
      const deps = { db: client, twinId: mauricio.twinId, dek, notify: notifier };

      expect(await deliverPendingKnocks(deps, NOW)).toBe(1);
      // ...and the second pass finds the record and announces nothing more.
      expect(await deliverPendingKnocks(deps, NOW)).toBe(0);
      expect(notifier.asks).toEqual([
        { type: "draft_ready", body: KNOCK, about: waiting },
      ]);
    });
  });

  it("delivers after a restart between the post and the send, and never twice", async () => {
    await resetAndMigrate();
    await withClient(async (client) => {
      const mauricio = await seat(client);
      const dek = createDekFromMaterial(randomBytes(32));
      const announced = await post(client, mauricio.twinId, dek, [
        { kind: "draft", draftId: randomUUID() },
        { kind: "knock", text: KNOCK },
      ]);
      const notifier = recordingNotifier(client);

      // THE FIRST PASS IS ALSO THE RESTART'S FIRST PASS: the post is on the
      // store with no send about it, which is the state a crash between the
      // two leaves, and nothing in memory distinguishes them.
      expect(
        await deliverPendingKnocks(
          {
            db: client,
            twinId: mauricio.twinId,
            dek,
            notify: notifier,
          },
          NOW,
        ),
      ).toBe(1);
      // ...and a restart AFTER the send changes nothing, because the record is
      // the memory.
      expect(
        await deliverPendingKnocks(
          {
            db: client,
            twinId: mauricio.twinId,
            dek,
            notify: notifier,
          },
          NOW,
        ),
      ).toBe(0);
      expect(notifier.asks.map((ask) => ask.about)).toEqual([announced]);
      const rows = await client.query<{ about_ref: string }>(
        "SELECT about_ref FROM notify_sends",
      );
      expect(rows.rows).toEqual([{ about_ref: announced }]);
    });
  });

  it("asks again while a live browser of the seat has no record about the post (#276)", async () => {
    // THE TIER'S MEMORY IS PER DESTINATION. One row standing for a whole post
    // would exclude it, so a fan-out a crash interrupted between two of the
    // seat's browsers loses the second one's delivery for good — the pass sees
    // the row and never asks again (ticket #276, finding 4).
    await resetAndMigrate();
    await withClient(async (client) => {
      const mauricio = await seat(client);
      const laptop = await browser(client, mauricio.seatId);
      const phone = await browser(client, mauricio.seatId);
      const dek = createDekFromMaterial(randomBytes(32));
      const waiting = await post(client, mauricio.twinId, dek, [
        { kind: "draft", draftId: randomUUID() },
        { kind: "knock", text: KNOCK },
      ]);
      // The store a crash leaves: the laptop's attempt settled, the phone's
      // never opened.
      await attempt(client, mauricio.seatId, waiting, laptop);
      const notifier = recordingNotifier(client);
      const deps = { db: client, twinId: mauricio.twinId, dek, notify: notifier };

      expect(await deliverPendingKnocks(deps, NOW)).toBe(1);
      expect(notifier.asks.map((ask) => ask.about)).toEqual([waiting]);

      // ...and once the phone has one too, the post is done.
      await attempt(client, mauricio.seatId, waiting, phone);
      expect(await deliverPendingKnocks(deps, NOW)).toBe(0);
    });
  });

  it("owes nothing to a browser registered after the post (#276)", async () => {
    // A REP WHO ALLOWS NOTIFICATIONS AT THREE IN THE AFTERNOON IS NOT KNOCKED
    // FOR THE PRECEDING FOUR HOURS. A backlog on a lock screen is the digest
    // ADR-0031 as amended deliberately does not build, so a device is told
    // what happens from the moment it exists.
    await resetAndMigrate();
    await withClient(async (client) => {
      const mauricio = await seat(client);
      const dek = createDekFromMaterial(randomBytes(32));
      const waiting = await post(
        client,
        mauricio.twinId,
        dek,
        [
          { kind: "draft", draftId: randomUUID() },
          { kind: "knock", text: KNOCK },
        ],
        new Date(NOW.getTime() - 90 * 60 * 1000),
      );
      const notifier = recordingNotifier(client);
      const deps = { db: client, twinId: mauricio.twinId, dek, notify: notifier };

      // The first pass asks with no browser at all and the refusal is recorded.
      expect(await deliverPendingKnocks(deps, NOW)).toBe(1);
      await client.query(
        "UPDATE notify_sends SET channel = 'push', reason = 'no_subscription', outcome = 'refused' WHERE about_ref = $1",
        [waiting],
      );
      // Then the rep allows notifications, half an hour after the draft landed.
      await browser(client, mauricio.seatId, new Date(NOW.getTime() - 60 * 60 * 1000 + 1));
      expect(await deliverPendingKnocks(deps, NOW)).toBe(0);
      expect(notifier.asks).toHaveLength(1);
    });
  });

  it("announces nothing about a post older than the window (the Spec axis)", async () => {
    await resetAndMigrate();
    await withClient(async (client) => {
      const mauricio = await seat(client);
      const dek = createDekFromMaterial(randomBytes(32));
      await post(
        client,
        mauricio.twinId,
        dek,
        [
          { kind: "draft", draftId: randomUUID() },
          { kind: "knock", text: KNOCK },
        ],
        new Date(NOW.getTime() - 5 * 60 * 60 * 1000),
      );
      const notifier = recordingNotifier(client);

      // «AT ONCE» MEANS AT ONCE. A push service drops a message a device has
      // not collected inside its TTL, so a knock from five hours ago is one
      // nobody would see — and the same bound is what stops the pass
      // re-decrypting every post this twin ever wrote on every tick.
      expect(
        await deliverPendingKnocks(
          { db: client, twinId: mauricio.twinId, dek, notify: notifier },
          NOW,
        ),
      ).toBe(0);
      expect(notifier.asks).toEqual([]);
    });
  });

  it("announces nothing for another twin's post, and nothing with no notifier", async () => {
    await resetAndMigrate();
    await withClient(async (client) => {
      const mauricio = await seat(client);
      const otra = await seat(client);
      const dek = createDekFromMaterial(randomBytes(32));
      await post(client, otra.twinId, dek, [
        { kind: "draft", draftId: randomUUID() },
        { kind: "knock", text: KNOCK },
      ]);
      const notifier = recordingNotifier(client);

      expect(
        await deliverPendingKnocks(
          {
            db: client,
            twinId: mauricio.twinId,
            dek,
            notify: notifier,
          },
          NOW,
        ),
      ).toBe(0);
      // A DEPLOYMENT WITH NO PUSH IDENTITY ANNOUNCES NOTHING and raises
      // nothing: the rep still has every card on the dashboard.
      expect(
        await deliverPendingKnocks({ db: client, twinId: otra.twinId, dek }, NOW),
      ).toBe(0);
      expect(notifier.asks).toEqual([]);
    });
  });
});

describe("a rail transition is announced once (ticket #262 AC 5)", () => {
  it("announces a drop, and a second pass finds the send and does nothing", async () => {
    await resetAndMigrate();
    await withClient(async (client) => {
      const mauricio = await seat(client);
      const dek = createDekFromMaterial(randomBytes(32));
      await rail(client, mauricio.twinId, "qr", "linked", "dropped");
      const notifier = recordingNotifier(client);
      const deps = {
        db: client,
        twinId: mauricio.twinId,
        dek,
        notify: notifier,
      };

      expect(await announceRailTransition(deps, NOW)).toBe(true);
      expect(await announceRailTransition(deps, NOW)).toBe(false);
      expect(notifier.asks.map((ask) => ask.type)).toEqual(["rail_dropped"]);
      // THE PASS NAMES NO PAGE. Notify fills both transports' links from the
      // catalog and the deployment's own origin, so the ask carries no slot.
      expect(notifier.asks[0]!.body).toBeUndefined();
    });
  });

  it("tells a drop from a log-out, and says nothing once the rail is back", async () => {
    await resetAndMigrate();
    await withClient(async (client) => {
      const mauricio = await seat(client);
      const dek = createDekFromMaterial(randomBytes(32));
      await rail(client, mauricio.twinId, "logged_out");
      const notifier = recordingNotifier(client);
      const deps = {
        db: client,
        twinId: mauricio.twinId,
        dek,
        notify: notifier,
      };

      expect(await announceRailTransition(deps, NOW)).toBe(true);
      expect(notifier.asks.map((ask) => ask.type)).toEqual(["rail_logged_out"]);
      // A `linked` ROW AFTER A DROP SENDS NOTHING: the tier reads the rail's
      // own latest row, so a twin that came back is a twin with nothing to
      // report.
      await rail(client, mauricio.twinId, "linked");
      expect(await announceRailTransition(deps, NOW)).toBe(false);
      // ...and a LATER drop is its own event, with its own row.
      await rail(client, mauricio.twinId, "dropped");
      expect(await announceRailTransition(deps, NOW)).toBe(true);
      expect(notifier.asks.map((ask) => ask.type)).toEqual([
        "rail_logged_out",
        "rail_dropped",
      ]);
    });
  });

  it("carries on when the mail rail refuses, rather than stopping the pass", async () => {
    await resetAndMigrate();
    await withClient(async (client) => {
      const mauricio = await seat(client);
      const dek = createDekFromMaterial(randomBytes(32));
      await rail(client, mauricio.twinId, "dropped");

      // A REP WHOSE INBOX BOUNCED MUST NOT ALSO LOSE THEIR DRAFTS
      // (`runtime.ts`'s fail-stop doctrine: infrastructure, never a message).
      await expect(
        announceRailTransition(
          {
            db: client,
            twinId: mauricio.twinId,
            dek,
            notify: refusingNotifier,
          },
          NOW,
        ),
      ).resolves.toBe(false);
    });
  });

  it("says nothing for a twin with no seat to reach", async () => {
    await resetAndMigrate();
    await withClient(async (client) => {
      const twinId = randomUUID();
      const dek = createDekFromMaterial(randomBytes(32));
      await rail(client, twinId, "dropped");
      const notifier = recordingNotifier(client);
      expect(
        await announceRailTransition(
          { db: client, twinId, dek, notify: notifier },
          NOW,
        ),
      ).toBe(false);
      expect(notifier.asks).toEqual([]);
    });
  });
});
