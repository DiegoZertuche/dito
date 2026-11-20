/**
 * THE ONE PLACE THE ORDER OF A CONVERSATION'S BEATS IS DEFINED (ticket
 * #109). Both chronological readers — the extraction window's seam read
 * and the bundle's `readConversation` — end here, so «which beat came
 * first» has exactly one answer wherever a model is shown a conversation.
 *
 * THE PROBLEM, plainly. A reaction's `occurred_at` is the rail's stanza
 * timestamp at WHOLE SECONDS, so a rep who taps 👍 by mistake and removes
 * it a moment later produces two rows carrying the SAME instant. Ordered
 * by `(occurred_at, id)` alone, the pair renders in the order the seam
 * happened to receive them — and a reconnect or a retry can deliver the
 * removal first, which renders a withdrawn agreement as one that stands.
 * That is the expensive direction of the error (ADR-0038, ADR-0037: a
 * misread «no» is cheap, a misread «yes» is not).
 *
 * THE ORDER, in three keys:
 *
 *   1. `occurredAt` — the coarse order, and the only one under which "these
 *      are the day's beats" is true (it is what the extraction window is
 *      CUT on). Never overridden here.
 *   2. `senderTsMs`, BETWEEN REACTIONS — the reactor's own millisecond
 *      clock, which ADR-0041 already names as the fold key and which every
 *      reaction delivery carries. Millisecond precision is what separates
 *      two taps inside one second.
 *   3. The coarse position — the row id the caller's `ORDER BY` already
 *      sorted on, which is ARRIVAL order. Written out explicitly below
 *      rather than left to the sort's stability, because "never by unstable
 *      sort order" is the acceptance criterion.
 *
 * ONLY A REACTION EVER MOVES. A message's `occurred_at` is second-granular
 * too and it carries no millisecond clock of its own, so pretending it fell
 * at `.000` would order it against a reaction on an invented number. So
 * within one second the reactions are dealt back into the slots they
 * already occupy, in clock order, and every message holds its position.
 *
 * AND A SECOND HOLDING ONE CLOCKLESS REACTION IS LEFT ENTIRELY ALONE — the
 * WHOLE second, not just that row. A reaction stored before the bundle
 * carried `sender_ts_ms` (schema v5 and older) has no clock, and a partial
 * shuffle around it can end the second on the wrong beat. The trace that
 * proves it, and the reason this guard is deliberately coarse (Codex r2):
 * the truth is `B` removal at `.100`, `A` set at `.900`, `L` removal at
 * `.950`; a reconnect delivers `L, A, B`; a v5 build stores `L` (clockless)
 * and a v6 build then stores `A` and `B`. Coarse order reads `L A B` and
 * ends on a removal. Shuffling only the clocked pair reads `L B A` and ends
 * on a STANDING SET — a fabricated yes this very ticket exists to prevent,
 * and strictly worse than what v5 already showed. Fail closed instead: an
 * upgraded bundle is then never worse than the one it was upgraded from.
 *
 * WHICH MEANS A REACTION CAN JUMP A MESSAGE, and that is a real cost rather
 * than an oversight. The two rules «two same-second reactions order by
 * their own clock» and «a same-second message and reaction keep arrival
 * order» cannot both hold: a message delivered between two out-of-order
 * reactions makes them cycle — `R(.9) < MSG < R(.1) < R(.9)`. Something
 * must give, so the load-bearing rule wins — it is the one this ticket
 * exists for — and the message keeps its SLOT while the gestures around it
 * are re-dealt:
 *
 *     in    R(.9)   MSG   R(.1)          out    R(.1)   MSG   R(.9)
 *
 * A permutation rather than a comparator, deliberately, for that same
 * reason: a comparator handed to `.sort()` would meet the cycle above as
 * undefined behaviour, while dealing the clocked rows into their own slots
 * is one well-defined shuffle whatever the input.
 *
 * AND BECAUSE IT IS A PERMUTATION, IT SERVES A LIST THAT IS NOT IN TIME
 * ORDER AT ALL. The Q&A citation list and drafting's retrieved block are
 * ranked by vector distance, and a same-second removal can outrank the set
 * it retracts — with both rows showing ONE instant, so list order is the
 * only signal the model has (ticket #109, Codex r3). Dealing gestures into
 * their own slots fixes that without sorting the list by time (which would
 * throw away the ranking) and without collapsing the pair (which is the
 * fold ADR-0041 forbids): every slot keeps its rank, and only the gesture
 * occupying it changes.
 */
import type { ConversationRow } from "./bundle.js";

/** Everything the order is decided from — one row, three fields. */
export type DeliveryBeat = Pick<
  ConversationRow,
  "occurredAt" | "reactionTo" | "senderTsMs"
>;

/**
 * Re-orders a list so that reaction deliveries sharing one second read in
 * the order they were MADE rather than the order they happen to sit in.
 *
 * WHATEVER ORDER THE LIST IS ALREADY IN. The two chronological readers pass
 * `(occurred_at, id)`, and there the result is that coarse order refined.
 * But retrieval passes a list ranked by vector DISTANCE (ticket #109's
 * Codex round 3), and this is safe there too: rows are grouped by their
 * instant rather than by adjacency, so a same-second pair is found however
 * far apart the ranking put them, and each is dealt back into a slot the
 * ranking already gave to a gesture of that second. Relevance order is
 * preserved — only which gesture sits in which of its OWN slots changes.
 *
 * The caller keeps its own row shape and says which part of it is the beat
 * (`beatOf`), so the seam's window beats and the bundle's conversation rows
 * share one rule without sharing a type.
 */
export function inDeliveryOrder<T>(
  rows: readonly T[],
  beatOf: (row: T) => DeliveryBeat,
): T[] {
  const ordered = [...rows];
  // Every gesture's position, grouped by the second it happened in. A
  // message takes no slot, so it can never be dealt one.
  const slotsBySecond = new Map<string, number[]>();
  for (const [i, row] of ordered.entries()) {
    const beat = beatOf(row);
    if (beat.reactionTo === undefined) continue;
    const slots = slotsBySecond.get(beat.occurredAt);
    if (slots === undefined) slotsBySecond.set(beat.occurredAt, [i]);
    else slots.push(i);
  }
  for (const slots of slotsBySecond.values()) {
    dealGesturesIntoTheirSlots(ordered, slots, beatOf);
  }
  return ordered;
}

/**
 * One second's reactions, back into their own positions in the order they
 * were tapped — or every one of them untouched when any lacks a clock to be
 * ordered by. `slots` is ascending, so dealing in sorted order fills the
 * earliest position with the earliest tap.
 */
function dealGesturesIntoTheirSlots<T>(
  rows: T[],
  slots: readonly number[],
  beatOf: (row: T) => DeliveryBeat,
): void {
  // One gesture cannot be out of order with itself.
  if (slots.length < 2) return;
  const gestures = slots.map((slot) => ({
    slot,
    row: rows[slot]!,
    senderTsMs: beatOf(rows[slot]!).senderTsMs,
  }));
  // ALL OR NOTHING, and the docblock's trace says why: a partial shuffle
  // around a clockless row can end the second on the wrong beat, which is
  // worse than the coarse order it replaced. Do not narrow this to the
  // clocked rows without re-reading that trace.
  if (gestures.some((gesture) => gesture.senderTsMs === undefined)) return;
  gestures.sort(
    (a, b) =>
      // Both defined — the guard above returned otherwise.
      a.senderTsMs! - b.senderTsMs! ||
      // The tertiary key, spelled out: same millisecond, coarse order.
      a.slot - b.slot,
  );
  for (const [i, gesture] of gestures.entries()) {
    rows[slots[i]!] = gesture.row;
  }
}
