/**
 * A CARD'S OUTCOME, TOLD FROM THE THREAD'S SIDE (ticket #266; spec #258
 * decisions 12 and 14).
 *
 * The rep can answer a card in either door: «no» to a binding question in
 * the self-chat declines it as surely as «Es otro cliente» on the dashboard,
 * and a canvas left open on a laptop should see the card leave. The thread's
 * writers commit these outcomes on their own transactions; each calls here
 * AFTER its commit, with the id it acted through, and this names the post the
 * canvas draws and publishes `settle` to the twin's seat.
 *
 * NEVER A REASON TO FAIL WHAT ALREADY COMMITTED. The act is durable and the
 * store says it; a lookup that throws here leaves the page to its next read.
 */
import type { SettleOutcome } from "@dito/seam";
import type pg from "pg";
import type { SeatEvents } from "./seat-events.js";
import type { ThreadEventSink } from "./thread/events.js";

/** What telling a card's outcome needs. */
export interface SettleDeps {
  readonly db: pg.ClientBase;
  readonly twinId: string;
  readonly events?: SeatEvents;
  /**
   * THE TWIN THREAD, told the same outcome as an event (ticket #319; spec #318
   * decision 11).
   */
  readonly thread?: ThreadEventSink;
}

/**
 * Publishes `settle` for one post named by its own id (ticket #386) — a card
 * a thread act answered by the id the tool was handed — to the twin's seat and
 * to the thread. Never fails what already committed.
 */
export async function publishPostSettle(
  deps: SettleDeps,
  postId: string,
  outcome: SettleOutcome,
  byRep: boolean,
): Promise<void> {
  if (deps.events === undefined && deps.thread === undefined) return;
  try {
    const seats = await deps.db.query<{ id: string }>("SELECT id FROM seats WHERE twin_id = $1", [deps.twinId]);
    for (const seat of seats.rows) deps.events?.publish(seat.id, { kind: "settle", postId, outcome });
    deps.thread?.raise(deps.twinId, { kind: "post.settled", postId, outcome, byRep });
  } catch {
    // The act committed; the page reads it on its next read.
  }
}

/**
 * Publishes `settle` for the post a delivery row or a binding question
 * delivers — the rep side's own ids, the ones a thread act resolves through.
 *
 * `delivery` IS A NOTICE'S OR A DRAFT'S ID (`trigger.quotedPostId`'s class);
 * `question` IS THE CUSTOMER-CHAT EVENT A BINDING QUESTION IS ABOUT, which is
 * what the matcher's «va» resolves to.
 */
export async function publishSettle(
  deps: SettleDeps,
  target:
    | { readonly delivery: string }
    | { readonly question: string },
  outcome: SettleOutcome,
  /**
   * WHETHER THE REP'S OWN ACT SETTLED IT — their «va» the matcher read — or
   * an act the twin performed in one of its own turns, on their word. The
   * wake list reads the difference (`thread/events.ts`): a turn's own act
   * never wakes the thread that just performed it.
   */
  byRep: boolean,
): Promise<void> {
  const events = deps.events;
  if (events === undefined && deps.thread === undefined) return;
  try {
    const rows = await deps.db.query<{ post_id: string; seat_id: string | null }>(
      "delivery" in target
        ? `SELECT p.id AS post_id, s.id AS seat_id
             FROM posts p
             LEFT JOIN seats s ON s.twin_id = p.twin_id
            WHERE p.twin_id = $1
              AND (p.notice_id = $2::uuid OR p.draft_id = $2::uuid)`
        : `SELECT p.id AS post_id, s.id AS seat_id
             FROM posts p
             JOIN notices n ON n.id = p.notice_id AND n.twin_id = p.twin_id
             LEFT JOIN seats s ON s.twin_id = p.twin_id
            WHERE p.twin_id = $1
              AND n.kind = 'binding_question'
              AND n.about_event_id = $2::bigint`,
      [deps.twinId, "delivery" in target ? target.delivery : target.question],
    );
    for (const row of rows.rows) {
      if (row.seat_id !== null) {
        events?.publish(row.seat_id, {
          kind: "settle",
          postId: row.post_id,
          outcome,
        });
      }
      deps.thread?.raise(deps.twinId, {
        kind: "post.settled",
        postId: row.post_id,
        outcome,
        byRep,
      });
    }
  } catch {
    // The act committed; the page reads it on its next read.
  }
}
