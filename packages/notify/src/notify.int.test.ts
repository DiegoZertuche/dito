/**
 * NOTIFY AT THE POSTGRES SEAM (ticket #219 AC 3; spec #214 *Notify, in
 * detail*; ADR-0022, ADR-0019's flow 4, ADR-0028).
 *
 * The seam is the pre-agreed place to test this: the seat's email is a
 * column and the send record is a row, and both claims — "recipients are
 * resolved from seat state" and "every send is recorded content-free" —
 * are about what the database holds afterwards. Real Postgres, real
 * migrations; the ONE boundary standing in is the email transport, and the
 * SES lane that proves the real client is `ses.int.test.ts`'s.
 *
 * EVERY VALUE IS OBVIOUSLY SYNTHETIC. `.test` is the reserved TLD, the code
 * is `000000`, and the URL is `https://dito.test/…` — nothing in this file
 * is a real address, a real code or a real link.
 */
import { randomUUID } from "node:crypto";
import { inspect } from "node:util";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { NotifyError } from "./index.js";
// FROM INSIDE THE PACKAGE, deliberately: `createNotify` takes a transport,
// which is not on the public surface (see `index.ts`), and injecting one is
// how this seam is driven.
import {
  createNotify,
  type EmailTransport,
  type NotifySessions,
  type OutboundEmail,
} from "./notify.js";
import { resetAndMigrate, seedSeat, TEST_DATABASE_URL } from "./testing/db.js";

/** A transport that records what it was handed and never leaves the process. */
function recordingTransport(): EmailTransport & {
  readonly sent: OutboundEmail[];
} {
  const sent: OutboundEmail[] = [];
  return {
    sent,
    send: (email) => {
      sent.push(email);
      return Promise.resolve({ providerMessageId: `0100-${sent.length}` });
    },
  };
}

/**
 * A transport that always fails, the way a real one does when SES refuses —
 * and quoting the recipient, the way SES really does.
 */
const failingTransport: EmailTransport = {
  send: () =>
    Promise.reject(
      new Error(
        "Email address is not verified. The following identities failed the check: rep@example.test",
      ),
    ),
};

const AT = new Date("2026-09-07T18:00:00Z");
const DASHBOARD = "https://dito.test";
const INVITATION_URL = `${DASHBOARD}/entrar/8f2c`;

let db: pg.Client;
/** Where notify checks out its own session — never this suite's client. */
let pool: pg.Pool;

beforeAll(async () => {
  await resetAndMigrate();
  db = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await db.connect();
  pool = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 4 });
}, 180_000);

afterAll(async () => {
  // `?.` because `beforeAll` can fail before either assignment — a
  // migration the tree cannot apply, say. Without it the teardown throws a
  // second, unrelated TypeError that buries the first, which is the failure
  // `removeTmpDir` is argued for one package over.
  await pool?.end();
  await db?.end();
});

beforeEach(async () => {
  // DELETE AND NOT TRUNCATE, IN DEPENDENCY ORDER — `login.int.test.ts`'
  // rule, and now a necessity rather than a preference. `acknowledgments`
  // is append-only and refuses TRUNCATE outright (ticket #223), and it
  // carries a foreign key into `seats`: a `TRUNCATE … CASCADE` over the
  // registry reaches a table whose whole point is that nothing empties it.
  // This file writes no acknowledgment, so a plain DELETE — which does not
  // cascade — clears exactly what it made.
  await db.query("DELETE FROM notify_sends");
  await db.query("DELETE FROM seats");
  await db.query("DELETE FROM companies");
});

describe("notify resolves the recipient from seat state (ticket #219 AC 3)", () => {
  it("sends the invitation to the seat's own email, and the caller never names one", async () => {
    // The whole of the API's shape: a seat id in, and the address comes off
    // the row. There is no parameter an address could arrive through.
    const seat = await seedSeat(db);
    const transport = recordingTransport();
    const notify = createNotify({ db: pool, transport, now: () => AT, dashboardOrigin: DASHBOARD });

    const [record] = await notify.send({
      type: "invitation",
      seatId: seat.seatId,
      slots: { url: INVITATION_URL },
    });

    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]!.to).toBe("rep@example.test");
    expect(transport.sent[0]!.subject).toBe("Tu tablero de Dito está listo");
    expect(transport.sent[0]!.body).toContain(INVITATION_URL);
    expect(transport.sent[0]!.body).toContain(seat.repDisplayName);
    expect(record!.outcome).toBe("sent");
  });

  it("refuses a caller that passes an address instead of a seat id", async () => {
    const notify = createNotify({
      db: pool,
      transport: recordingTransport(),
      now: () => AT,
      dashboardOrigin: DASHBOARD,
    });
    await expect(
      notify.send({
        type: "invitation",
        // A caller who ignored the type. The refusal is a runtime one
        // because the type is `string` — every uuid is one.
        seatId: "rep@example.test",
        slots: { url: INVITATION_URL },
      }),
    ).rejects.toThrow(NotifyError);
  });

  it("refuses a caller that tries to write the name the seat owns", async () => {
    // `name` is filled from `rep_display_name`. A caller that could pass it
    // could put anything in a message it does not otherwise control.
    const seat = await seedSeat(db);
    const notify = createNotify({
      db: pool,
      transport: recordingTransport(),
      now: () => AT,
      dashboardOrigin: DASHBOARD,
    });
    await expect(
      notify.send({
        type: "invitation",
        seatId: seat.seatId,
        slots: { url: INVITATION_URL, name: "Otro nombre" },
      }),
    ).rejects.toThrow(NotifyError);
  });

  it("refuses a seat nobody registered, and records nothing", async () => {
    const notify = createNotify({
      db: pool,
      transport: recordingTransport(),
      now: () => AT,
      dashboardOrigin: DASHBOARD,
    });
    await expect(
      notify.send({
        type: "invitation",
        seatId: randomUUID(),
        slots: { url: INVITATION_URL },
      }),
    ).rejects.toThrow(NotifyError);
    const rows = await db.query("SELECT count(*)::int AS n FROM notify_sends");
    expect(rows.rows[0]!.n).toBe(0);
  });

  it("records a seat with no email as refused, and sends nothing", async () => {
    // Nobody's bug: the ask was legitimate and the answer is that this seat
    // cannot be mailed yet. That is a fact worth keeping, so it is a row.
    const seat = await seedSeat(db, { email: null });
    const transport = recordingTransport();
    const notify = createNotify({ db: pool, transport, now: () => AT, dashboardOrigin: DASHBOARD });

    const [record] = await notify.send({
      type: "invitation",
      seatId: seat.seatId,
      slots: { url: INVITATION_URL },
    });

    expect(record!.outcome).toBe("refused");
    expect(record!.reason).toBe("no_email");
    expect(transport.sent).toEqual([]);
  });
});

describe("every send is recorded content-free (ticket #219)", () => {
  it("writes one row naming the type, the seat, the instant and the outcome", async () => {
    const seat = await seedSeat(db);
    const notify = createNotify({
      db: pool,
      transport: recordingTransport(),
      now: () => AT,
      dashboardOrigin: DASHBOARD,
    });

    await notify.send({
      type: "login_code",
      seatId: seat.seatId,
      slots: { code: "000000", url: INVITATION_URL, minutes: 10 },
    });

    const rows = await db.query(
      "SELECT seat_id, message_type, requested_at, outcome, reason, provider_message_id, settled_at FROM notify_sends",
    );
    expect(rows.rows).toEqual([
      {
        seat_id: seat.seatId,
        message_type: "login_code",
        requested_at: AT,
        outcome: "sent",
        reason: null,
        provider_message_id: "0100-1",
        settled_at: AT,
      },
    ]);
  });

  it("holds no address, no code and no body anywhere in the row", async () => {
    // The claim in the direction that matters: the record is what stays
    // behind for ever, and a code or an address in it would be exactly the
    // content ADR-0019's flow 4 says email carries and stores do not.
    const seat = await seedSeat(db);
    const notify = createNotify({
      db: pool,
      transport: recordingTransport(),
      now: () => AT,
      dashboardOrigin: DASHBOARD,
    });
    await notify.send({
      type: "login_code",
      seatId: seat.seatId,
      slots: { code: "000000", url: INVITATION_URL, minutes: 10 },
    });

    const rows = await db.query<{ row: string }>(
      "SELECT notify_sends::text AS row FROM notify_sends",
    );
    const row = rows.rows[0]!.row;
    expect(row).not.toContain("@");
    expect(row).not.toContain("000000");
    expect(row).not.toContain("dito.test");
  });

  it("records the ask before the send, so a crash cannot lose the fact of it", async () => {
    // WRITTEN FIRST, SETTLED AFTER — `runtime_requests`' shape, for the
    // reason an email has no undo: a record written only on success would
    // leave a message in somebody's inbox that nothing in the system
    // remembers sending.
    const seat = await seedSeat(db);
    const seen: number[] = [];
    const transport: EmailTransport = {
      send: async () => {
        const rows = await db.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM notify_sends WHERE outcome IS NULL",
        );
        seen.push(rows.rows[0]!.n);
        return { providerMessageId: "0100-1" };
      },
    };
    const notify = createNotify({ db: pool, transport, now: () => AT, dashboardOrigin: DASHBOARD });

    await notify.send({
      type: "invitation",
      seatId: seat.seatId,
      slots: { url: INVITATION_URL },
    });

    expect(seen).toEqual([1]);
  });

  it("commits the record before the send, even inside a caller's transaction (Codex r3)", async () => {
    // THE FAILURE A SAME-CONNECTION TEST CANNOT SEE. rep-web will wrap a
    // request in a transaction; on the caller's own client the row written
    // before the send is UNCOMMITTED while SES sends, and the caller's
    // rollback then erases the record of a message that has already left.
    // So notify checks out its own session, and this proves it from a THIRD
    // connection while the caller's transaction is still open — and then
    // rolls that transaction back, which must change nothing.
    const seat = await seedSeat(db);
    const transport = recordingTransport();
    const notify = createNotify({ db: pool, transport, now: () => AT, dashboardOrigin: DASHBOARD });

    await db.query("BEGIN");
    const [record] = await notify.send({
      type: "invitation",
      seatId: seat.seatId,
      slots: { url: INVITATION_URL },
    });
    expect(record!.outcome).toBe("sent");

    const onlooker = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await onlooker.connect();
    try {
      const seen = await onlooker.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM notify_sends WHERE seat_id = $1",
        [seat.seatId],
      );
      expect(seen.rows[0]!.n).toBe(1);
    } finally {
      await onlooker.end();
    }

    await db.query("ROLLBACK");
    const after = await db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM notify_sends WHERE seat_id = $1",
      [seat.seatId],
    );
    expect(after.rows[0]!.n).toBe(1);
  });

  it("records a transport failure as failed, and says so to the caller", async () => {
    const seat = await seedSeat(db);
    const notify = createNotify({
      db: pool,
      transport: failingTransport,
      now: () => AT,
      dashboardOrigin: DASHBOARD,
    });

    await expect(
      notify.send({
        type: "invitation",
        seatId: seat.seatId,
        slots: { url: INVITATION_URL },
      }),
    ).rejects.toThrow(NotifyError);

    const rows = await db.query<{ outcome: string; reason: string }>(
      "SELECT outcome, reason FROM notify_sends",
    );
    expect(rows.rows).toEqual([
      { outcome: "failed", reason: "transport_failed" },
    ]);
  });

  it("does not repeat the provider's own words, which quote the recipient", async () => {
    // SES names the identity that failed its check, so pasting its message
    // into ours would put the address in an error string the operator script
    // prints — and a `cause` is no better (Codex r3): Node's own formatting
    // walks the chain, so `console.error(err)` prints it. Asserted over the
    // WHOLE formatted exception rather than over `message` alone.
    const seat = await seedSeat(db);
    const notify = createNotify({
      db: pool,
      transport: failingTransport,
      now: () => AT,
      dashboardOrigin: DASHBOARD,
    });
    let refusal: unknown;
    try {
      await notify.send({
        type: "invitation",
        seatId: seat.seatId,
        slots: { url: INVITATION_URL },
      });
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(NotifyError);
    const thrown = refusal as NotifyError;
    expect(thrown.message).toContain(seat.seatId);
    // The whole exception as any logger renders it — the message AND the
    // cause chain Node walks on its own, which is the half a `cause` looks
    // private and is not. The `at …` frames come off first: those are
    // Node's own text, and this repo's `node_modules/.pnpm/@vitest+runner`
    // paths read as addresses to any pattern that would catch a real one.
    const formatted = inspect(thrown, { depth: 5 })
      .split("\n")
      .filter((line) => !/^\s+at /u.test(line))
      .join("\n");
    expect(formatted).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/u);
    expect(formatted).not.toContain(seat.email);
    expect(formatted).toContain("ses");
  });

  it("refuses a link that does not point at the dashboard (Codex r3)", async () => {
    // THE FENCE `@dito/copy`'S RULES CANNOT BE. Every character rule the
    // slot holds still leaves `https://attacker.example/entrar/8f2c` — a
    // phishing link inside a message Dito really sent — because a host is
    // not something a bounded character set can decide.
    const seat = await seedSeat(db);
    const transport = recordingTransport();
    const notify = createNotify({
      db: pool,
      transport,
      now: () => AT,
      dashboardOrigin: DASHBOARD,
    });
    await expect(
      notify.send({
        type: "invitation",
        seatId: seat.seatId,
        slots: { url: "https://attacker.example/entrar/8f2c" },
      }),
    ).rejects.toThrow(NotifyError);
    expect(transport.sent).toEqual([]);
    const rows = await db.query("SELECT count(*)::int AS n FROM notify_sends");
    expect(rows.rows[0]!.n).toBe(0);
  });

  it("refuses a slot the template does not accept, and records nothing", async () => {
    // The caller's bug, so no row: nothing was asked of the world.
    const seat = await seedSeat(db);
    const notify = createNotify({
      db: pool,
      transport: recordingTransport(),
      now: () => AT,
      dashboardOrigin: DASHBOARD,
    });
    await expect(
      notify.send({
        type: "invitation",
        seatId: seat.seatId,
        slots: { url: "javascript:alert(1)" },
      }),
    ).rejects.toThrow(NotifyError);
    const rows = await db.query("SELECT count(*)::int AS n FROM notify_sends");
    expect(rows.rows[0]!.n).toBe(0);
  });

  it("refuses to store a message type the catalog does not hold", async () => {
    // The store's own fence, checked from the other side: the CHECK is what
    // stops a hand-written row claiming a message Dito cannot send.
    const seat = await seedSeat(db);
    await expect(
      db.query(
        "INSERT INTO notify_sends (seat_id, message_type) VALUES ($1, $2)",
        [seat.seatId, "password_reset"],
      ),
    ).rejects.toThrow(/notify_sends_message_type_check/);
  });

  it("refuses to store an address in the provider's message id", async () => {
    const seat = await seedSeat(db);
    await expect(
      db.query(
        `INSERT INTO notify_sends (seat_id, message_type, outcome, settled_at, provider_message_id)
         VALUES ($1, 'invitation', 'sent', now(), $2)`,
        [seat.seatId, "rep@example.test"],
      ),
    ).rejects.toThrow(/notify_sends_provider_message_id_content_free_check/);
  });
});

describe("the seat's email column (ticket #219 AC 6)", () => {
  it("takes an address, and refuses a value that is not one", async () => {
    const seat = await seedSeat(db);
    await expect(
      db.query("UPDATE seats SET email = $1 WHERE id = $2", [
        "no es un correo",
        seat.seatId,
      ]),
    ).rejects.toThrow(/seats_email_check/);
  });

  it("leaves the display name's own constraints exactly as they were", async () => {
    // AC 6: "the existing CHECKs on `rep_display_name` untouched". Both of
    // them, from the other side: the empty-name rule and ADR-0004's
    // never-an-address rule.
    const seat = await seedSeat(db);
    await expect(
      db.query("UPDATE seats SET rep_display_name = $1 WHERE id = $2", [
        "   ",
        seat.seatId,
      ]),
    ).rejects.toThrow(/seats_rep_display_name_check/);
    await expect(
      db.query("UPDATE seats SET rep_display_name = $1 WHERE id = $2", [
        "5215550001@s.whatsapp.net",
        seat.seatId,
      ]),
    ).rejects.toThrow(/seats_rep_display_name_not_an_address/);
  });
});

/**
 * A STORE FAILURE IS NOT A TRANSPORT FAILURE (Codex round 2 on PR #277).
 *
 * The one rail with no undo is email, and the one thing that must never
 * happen on it is a second copy of a message SES already accepted. What makes
 * that reachable is a catch drawn one statement too wide: with the success
 * settle inside the try, a database that fails after the provider has taken
 * the message records `failed`, and the retry spacing then mails the rep the
 * same grave event again.
 */
describe("an accepted email is never sent twice (ticket #276)", () => {
  /**
   * The real pool, with the next settle refused by the database itself.
   *
   * THE FAULT IS INJECTED AT THE STATEMENT AND NOT AT THE CLIENT, so what
   * fails is a real `query` against real Postgres: the settle's UPDATE is
   * swapped once for one the server rejects. A stub that threw of its own
   * accord would be this suite deciding what a store failure looks like;
   * this way the error is the store's.
   */
  function poolWithOneRefusedSettle(): NotifySessions & {
    readonly refused: number[];
  } {
    const refused: number[] = [];
    return {
      refused,
      connect: async () => {
        const client = await pool.connect();
        const real = client.query.bind(client);
        client.query = ((text: unknown, values?: unknown) => {
          if (
            typeof text === "string" &&
            text.includes("UPDATE notify_sends") &&
            refused.length === 0
          ) {
            refused.push(1);
            return real("SELECT 1 / 0" as never);
          }
          return real(text as never, values as never);
        }) as typeof client.query;
        return client;
      },
    };
  }

  it("leaves the row unsettled when the settle fails, and never calls the provider again", async () => {
    const seat = await seedSeat(db);
    const transport = recordingTransport();
    const sessions = poolWithOneRefusedSettle();
    const notify = createNotify({
      db: sessions,
      transport,
      now: () => AT,
      dashboardOrigin: DASHBOARD,
    });
    const about = "9100";

    // SES TOOK THE MESSAGE and the database then refused to write it down.
    await expect(
      notify.send({ type: "rail_dropped", seatId: seat.seatId, slots: {}, about }),
    ).rejects.toThrow();
    expect(transport.sent).toHaveLength(1);
    expect(sessions.refused).toHaveLength(1);

    // THE ROW STANDS UNSETTLED, which is «this may have gone out» — the state
    // the record was always meant to hold after a crash mid-send.
    const rows = await db.query<{ outcome: string | null; reason: string | null }>(
      "SELECT outcome, reason FROM notify_sends WHERE about_ref = $1",
      [about],
    );
    expect(rows.rows).toEqual([{ outcome: null, reason: null }]);

    // ...and the next pass never touches the provider again, because an
    // unsettled attempt stands. What it DOES record is the push channel,
    // which the throw above cut the first pass short of — a grave event still
    // owes that one, and a seat with no registered browser is a refusal.
    const later = createNotify({
      db: pool,
      transport,
      now: () => AT,
      dashboardOrigin: DASHBOARD,
    });
    const second = await later.send({
      type: "rail_dropped",
      seatId: seat.seatId,
      slots: {},
      about,
    });
    expect(transport.sent).toHaveLength(1);
    expect(second.map((one) => one.channel)).toEqual(["push"]);
    // THE EMAIL ROW IS STILL THE ONE, AND STILL UNSETTLED.
    const email = await db.query<{ outcome: string | null }>(
      "SELECT outcome FROM notify_sends WHERE about_ref = $1 AND channel = 'email'",
      [about],
    );
    expect(email.rows).toEqual([{ outcome: null }]);
  });
});
