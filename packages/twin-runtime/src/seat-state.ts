/**
 * THE SEAT'S ONE TRANSITION, WRITTEN BY THE LEASE HOLDER (ticket #223; spec
 * #214 *Link day, in detail*; ADR-0032, FR-63).
 *
 * "The seat moves `invited → linked` when the rail links." That sentence is
 * this module, and the three things about it that were decisions are all about
 * WHO writes it and WHEN.
 *
 * ═══ NOT rep-web, AND THAT IS A GRANT AND NOT A CONVENTION
 *
 * `dito_rep_web` holds `UPDATE (email, onboarded_at)` on `seats` and nothing
 * else — a column-level grant, pinned in `grants.ts` and diffed against the
 * catalog in both directions. A dashboard that could write `state` could claim
 * a number was linked that never was, which is the one fact on link day that
 * nothing downstream re-checks. So the writer is the process that already
 * holds the twin's lease and reads the rail's own rows.
 *
 * ═══ NOT THE `/link` READ EITHER, WHICH WAS THE OBVIOUS PLACE
 *
 * The link page asks the runtime for the credential, so the runtime could flip
 * the seat the moment it observed a `linked` row on that path. Rejected: a READ
 * THAT WRITES is a read whose caller decides when a durable fact is recorded —
 * so a rep who never opens the link page again (they linked by QR from a
 * laptop and closed the tab) would keep an `invited` seat for ever, and a
 * crawler that hit `/link` would be the thing that moved it. The poll loop owns
 * it instead: one indexed statement per pass, on a clock nobody's browser is
 * part of.
 *
 * ═══ AND NO PAGE WAITS ON IT
 *
 * The onboarding order reads the RAIL SEAM for its link step, not the seat's
 * state (`nextOnboardingStep` in rep-web), so the rep moves on the instant the
 * plane writes its `linked` row and this pass is bookkeeping that catches up
 * within a poll interval. The seat's state is the DURABLE RECORD link day's
 * clock ends on — what `rig-link-day-time.ts` and the owner's Seats surface
 * read — rather than a gate anybody is standing behind.
 *
 * ═══ NO CHAIN ENTRY, AND THE ARGUMENT AGAINST ONE IS WORTH WRITING DOWN
 *
 * #78's rule: a chained act is a REP ACT with evidence and an execution behind
 * it. This is neither — nobody pressed anything, no model ran, nothing crossed,
 * and what happened is that the runtime NOTICED a row the plane wrote. The
 * record is the seat's own `state` beside the `rail_status_events` row that
 * caused it, which is two rows a reader can join on the twin.
 *
 * AND THE MECHANICAL HALF, because it is the part that decides it. Adding a
 * word to `AUDIT_ACTIONS` obliges a `MUST_CHAIN` class (the vocabulary's own
 * rule, checked by `audit-coverage.test.ts`), and such a class needs a
 * relation with ONE ROW PER ACT to join entries against. The only trace this
 * act leaves is `seats.state`, which is CURRENT STATE with no history — so the
 * class would have to demand an entry for every seat that reads `linked`,
 * including the ones `rig-seed-owner.ts` and every existing suite plant
 * directly. That is not a strict invariant: it is a red build in every corpus
 * this repo has, for acts that never happened. A per-act trace (a seat-state
 * history table) is what a chained transition would need first, and it is
 * recorded on the horizon rather than built for one transition.
 */
import { SEAT_LINKED, type SeatState } from "@dito/seam";
import type pg from "pg";

/** What the transition needs: a connection and the twin this runtime holds. */
export interface SeatStateDeps {
  readonly db: pg.ClientBase;
  readonly twinId: string;
}

/** The state a seat is in while its invitation is out (FR-63). */
const SEAT_INVITED: SeatState = "invited";

/**
 * Moves this runtime's seat to `linked` when the rail's latest row says so,
 * and answers whether it moved.
 *
 * ONE STATEMENT, AND THE PREDICATE IS THE WHOLE GUARD. `state = 'invited'`
 * makes it idempotent — a second pass changes nothing — and one-way: a seat
 * that is already `linked` is not re-stamped, and a `retired` seat is never
 * resurrected by a rail row (ADR-0009 destroyed its key; a session for it is
 * refused anyway).
 *
 * IT DOES NOT MOVE BACKWARDS WHEN THE RAIL DROPS, which is a decision about
 * what the two records MEAN. `rail_status_events` is the socket's state and it
 * already says `dropped`; `seats.state` is the SEAT's lifecycle — ADR-0027's
 * — and a rep whose WhatsApp disconnected on Tuesday has not become uninvited.
 * Conexiones renders the rail's own word for that, from the rail's own row.
 *
 * THE SUBQUERY IS THE RAIL'S OWN «LATEST», ordered by `id` and not by
 * `occurred_at`, which is `readRailState`'s rule: two transitions of one
 * reconnect can share a wall-clock instant, and the identity column breaks
 * that tie the same way for every reader. It rides
 * `rail_status_events_twin_id_id_idx`, so a pass that has nothing to do costs
 * one index probe.
 */
export async function linkSeatWhenRailLinked(
  deps: SeatStateDeps,
): Promise<boolean> {
  const moved = await deps.db.query(
    `UPDATE seats
        SET state = $3
      WHERE twin_id = $1
        AND state = $2
        AND (SELECT r.status FROM rail_status_events r
              WHERE r.twin_id = seats.twin_id
              ORDER BY r.id DESC
              LIMIT 1) = $3`,
    [deps.twinId, SEAT_INVITED, SEAT_LINKED],
  );
  return (moved.rowCount ?? 0) > 0;
}
