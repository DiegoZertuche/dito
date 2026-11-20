/**
 * THE OFFERS THE REP SPENT, KEPT FOR THE DAY (ticket #335).
 *
 * A lean-in offer the rep took, answered or let go stays down for that card
 * for the rest of the seat-local day — after a reload, and on another device.
 * The bar asks the runtime to keep the mark (`/ask/spend`) and reads the day's
 * marks back when it opens (`/offer-spendings`); the page's own copy is the
 * cache of that read.
 *
 * THE REP'S MARK ON THEIR OWN PAGE, AND NOTHING MORE. It is not the twin's act
 * and not a message: the twin is told nothing, no chain entry is written and
 * no execution runs. The store is the seat's own (`offer_spendings`), because
 * the curation the offer rode on is immutable and the twin's next curation
 * would leave a mark written on it behind.
 *
 * THE SENTENCE IS THE OFFER'S VERSION: the mark holds the sentence the rep
 * saw, sealed, and the bar compares it — a new sentence on the same card is a
 * new offer and rises.
 */
import type { Dek } from "@dito/crypto";
import type { OfferSpentReason, TwinApiSpendRequest, TwinOfferSpendings } from "@dito/seam";
import type pg from "pg";

/** What keeping and reading the marks needs. */
export interface OfferSpendingDeps {
  readonly db: pg.ClientBase;
  readonly twinId: string;
  readonly dek: Dek;
  /** The seat's IANA zone — the one the day is cut in. */
  readonly timeZone: string;
}

/** Whose marks — off the registry, never the request. */
export interface OfferSpendingScope {
  readonly companyId: string;
  readonly seatId: string;
}

/**
 * Keeps one mark, when the card is this twin's — answers whether it did.
 *
 * ANY SENTENCE THE PAGE SAW ON ONE OF THIS TWIN'S CARDS, current or not: the
 * twin may rewrite its curation between the rest and the rep's «Luego», and a
 * mark refused then would let the same sentence rise again if the twin offers
 * it later that day (Codex r2). The caller is rep-web behind the bearer, the
 * body is bounded, and the sentence is sealed like every other.
 *
 * `now` IS A PARAMETER: the local API passes its own clock at the ask.
 */
export async function recordOfferSpending(
  deps: OfferSpendingDeps,
  scope: OfferSpendingScope,
  spending: TwinApiSpendRequest,
  now: Date,
): Promise<boolean> {
  const written = await deps.db.query(
    `INSERT INTO offer_spendings
       (company_id, seat_id, twin_id, post_id, sentence_enc, reason, spent_at, day)
     SELECT $1::uuid, $2::uuid, $3::uuid, p.id, $5::bytea, $6::text, $7::timestamptz,
            ($7::timestamptz AT TIME ZONE $8::text)::date
       FROM posts p
      WHERE p.id = $4 AND p.twin_id = $3`,
    [
      scope.companyId,
      scope.seatId,
      deps.twinId,
      spending.postId,
      deps.dek.encrypt(Buffer.from(spending.sentence, "utf8")),
      spending.reason,
      now,
      deps.timeZone,
    ],
  );
  return written.rowCount === 1;
}

/** Every mark the seat made on the seat-local day `now` falls in, oldest first. */
export async function readOfferSpendings(
  deps: OfferSpendingDeps,
  seatId: string,
  now: Date,
): Promise<TwinOfferSpendings> {
  const rows = await deps.db.query<{
    day: string;
    post_id: string;
    sentence_enc: Buffer | null;
    reason: OfferSpentReason | null;
  }>(
    `SELECT d.day::text AS day, s.post_id, s.sentence_enc, s.reason
       FROM (SELECT ($2::timestamptz AT TIME ZONE $3)::date AS day) d
       LEFT JOIN offer_spendings s
         ON s.seat_id = $1 AND s.twin_id = $4 AND s.day = d.day
      ORDER BY s.spent_at, s.id`,
    [seatId, now, deps.timeZone, deps.twinId],
  );
  return {
    day: rows.rows[0]!.day,
    spent: rows.rows.flatMap((row) =>
      row.sentence_enc === null || row.reason === null
        ? []
        : [
            {
              postId: row.post_id,
              sentence: Buffer.from(deps.dek.decrypt(row.sentence_enc)).toString("utf8"),
              reason: row.reason,
            },
          ],
    ),
  };
}
