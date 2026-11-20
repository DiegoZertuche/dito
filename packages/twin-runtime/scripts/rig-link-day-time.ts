/**
 * HOW LONG LINK DAY TOOK (ticket #223; spec #214 user story 21 and DoD 3: "the
 * time from invitation to linked number under five minutes, recorded").
 *
 * RECORDED, NEVER GATED (spec #214's *Testing Decisions*: "Recorded, not
 * gated: link day's time from invitation to first draft card on the rig"). This
 * prints three lines an operator copies into a boundary comment; nothing in CI
 * reads it and nothing fails on it. A five-minute target measured by a test
 * would be a test that fails when a rep reads the contract carefully.
 *
 * Usage — source .env.rig (or use ./rig.sh), then:
 *
 *   node --experimental-strip-types \
 *     packages/twin-runtime/scripts/rig-link-day-time.ts <seatId>
 *
 * ═══ THE TWO INSTANTS ARE THE TWO THE PRODUCT DEFINITION NAMES
 *
 * `invitations.issued_at` is where the clock starts — the moment the operator
 * (or, on the horizon, the owner's Seats surface) issued the link — and the
 * first `rail_status_events` row reading `linked` AFTER it is where it stops.
 *
 * THE RAIL ROW AND NOT THE SEAT'S STATE, and the difference matters by up to a
 * poll interval: the plane writes the rail row the instant WhatsApp confirms,
 * and the runtime moves the seat to `linked` on its next pass (`seat-state.ts`).
 * What the rep experienced is the first of those.
 *
 * AND «AFTER IT», which is what makes a re-issued invitation measurable: a rig
 * that has linked before holds older `linked` rows, so the read is bounded
 * below by the invitation this run is about.
 *
 * ═══ IT PRINTS NO TOKEN AND NO ADDRESS
 *
 * Two instants, a delta and the seat's own id. The invitation's digest is not
 * printed either — there is nothing an operator could do with it, and a
 * terminal is a place a screenshot happens.
 */
import pg from "pg";

const dbUrl = process.env["DITO_DATABASE_URL"];
const seatId = process.argv[2];
if (dbUrl === undefined || seatId === undefined) {
  console.error(
    "usage: source .env.rig && node --experimental-strip-types scripts/rig-link-day-time.ts <seatId>",
  );
  process.exit(1);
}

const db = new pg.Client({ connectionString: dbUrl });
await db.connect();
try {
  const measured = await db.query<{
    issued_at: Date;
    linked_at: Date | null;
    seconds: string | null;
  }>(
    `SELECT i.issued_at,
            l.occurred_at AS linked_at,
            extract(epoch FROM (l.occurred_at - i.issued_at))::text AS seconds
       FROM invitations i
       JOIN seats s ON s.id = i.seat_id
       LEFT JOIN LATERAL (
            SELECT r.occurred_at
              FROM rail_status_events r
             WHERE r.twin_id = s.twin_id
               AND r.status = 'linked'
               AND r.occurred_at >= i.issued_at
             ORDER BY r.id
             LIMIT 1
       ) l ON true
      WHERE i.seat_id = $1
      ORDER BY i.issued_at DESC
      LIMIT 1`,
    [seatId],
  );
  const row = measured.rows[0];
  if (row === undefined) {
    console.error(
      `no invitation for seat ${seatId} — issue one with rig-invite.ts`,
    );
    process.exit(1);
  }
  console.log(`seat ${seatId}`);
  console.log(`invitation issued: ${row.issued_at.toISOString()}`);
  if (row.linked_at === null || row.seconds === null) {
    console.log(
      "number linked:     not yet — no `linked` rail row after that invitation",
    );
    process.exit(0);
  }
  console.log(`number linked:     ${row.linked_at.toISOString()}`);
  const seconds = Number(row.seconds);
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds - minutes * 60);
  console.log(
    `link day took:     ${String(minutes)}m ${String(rest)}s (${seconds.toFixed(1)}s)`,
  );
} finally {
  await db.end();
}
