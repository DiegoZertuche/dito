/**
 * THE REP ARRIVED ON INICIO: THE RECORD, THE THROTTLE AND THE ANSWER (ticket
 * #266; spec #258 decision 15; ADR-0014 as amended — the `arrival` occasion).
 *
 * `door.ts`' shape, one ask over. The page asks the local API when it renders
 * Inicio; this records the arrival for the seat and answers what the page
 * needs before any line lands. The execution the arrival wakes is the
 * consumer's next pass, which reads the row (`rep-asks.ts`), and this returns
 * as soon as the row is durable — the page never waits on the twin.
 *
 * ═══ METADATA ONLY
 *
 * The seat, the instant, the seat-local day and which visit of the day it is.
 * The instant is the runtime's own clock at the ask, never the page's: a
 * browser's clock is the one input here a caller could move, and the throttle
 * and the day both rest on it.
 *
 * ═══ THE THROTTLE: TEN MINUTES, AND NOTHING RECORDED INSIDE THEM
 *
 * «A return within ten minutes of the last arrival wakes nothing, and the last
 * line stands» (decision 15). So a throttled ask writes no row — there is no
 * arrival to route — and answers `woke: false` with the last line's id. The
 * ten minutes run from the last RECORDED arrival, so a rep who reloads every
 * few minutes is greeted again once ten have passed since the greeting, not
 * never.
 *
 * TWO TABS AT ONCE ARE ONE ARRIVAL. The read of the last arrival and the
 * write of the next are under a per-seat advisory lock inside one
 * transaction, so two asks landing together cannot both find the last
 * arrival old enough and wake two executions.
 *
 * ═══ THE DAY IS CUT IN POSTGRES, IN THE SEAT'S ZONE
 *
 * `exchanges.ts`' own arithmetic: `(instant AT TIME ZONE zone)::date` in the
 * statement that writes the row, so «the first visit of the day» and the day
 * the acts log is cut by (`acts-log.ts`) are one computation,
 * and no instant is ever turned into a day with a zone of this process's own.
 */
import type pg from "pg";
import type { ArrivalVisit } from "@dito/seam";
import { withDbTransaction } from "./db-tx.js";

/**
 * How long after an arrival a return wakes nothing, in ms (spec #258
 * decision 15: «a return within ten minutes of the last arrival wakes
 * nothing»).
 *
 * THE SPEC'S NUMBER, and the reason it is not two: a rep who steps away for
 * coffee and back has not left — «as a rep who steps away for two minutes, I
 * want no new greeting» (user story 3) — while one back from a meeting has.
 */
export const ARRIVAL_THROTTLE_MS = 10 * 60_000;

/** What recording an arrival needs. */
export interface ArrivalRecordDeps {
  /** A connection the ask may open its own transaction on. */
  readonly db: pg.ClientBase;
  readonly twinId: string;
  /** The seat's IANA zone — the one the day is cut in. */
  readonly timeZone: string;
}

/** Whose arrival — off the registry, never the request. */
export interface ArrivalScope {
  readonly companyId: string;
  readonly seatId: string;
}

/** What one ask recorded: an arrival, or nothing inside the throttle. */
export type ArrivalRecorded =
  | {
      readonly woke: true;
      readonly arrivalId: string;
      readonly visit: ArrivalVisit;
      readonly arrivedAt: Date;
      readonly lastArrivedAt?: Date;
    }
  /**
   * Nothing recorded — and the arrival the throttle kept, whose line may
   * still be on its way: a second tab opened seconds after the first follows
   * that arrival's line rather than none (Codex r3).
   */
  | { readonly woke: false; readonly keptArrivalId: string };

/**
 * Records one arrival for the seat, or nothing inside the throttle.
 *
 * `now` IS A PARAMETER, time being a parameter everywhere in this package:
 * the local API passes its own clock at the ask, and the seam suite passes
 * instants either side of ten minutes and of midnight.
 */
export async function recordArrival(
  deps: ArrivalRecordDeps,
  scope: ArrivalScope,
  now: Date,
): Promise<ArrivalRecorded> {
  return await withDbTransaction(deps.db, async () => {
    // ONE ARRIVAL AT A TIME PER SEAT (the header). A transaction-scoped lock,
    // released at the commit that writes the row.
    await deps.db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `rep_arrival:${scope.seatId}`,
    ]);
    const last = await deps.db.query<{ id: string; arrived_at: Date; day: string }>(
      `SELECT id, arrived_at, day::text AS day
         FROM rep_arrivals
        WHERE seat_id = $1
        ORDER BY arrived_at DESC
        LIMIT 1`,
      [scope.seatId],
    );
    const previous = last.rows[0];
    if (
      previous !== undefined &&
      now.getTime() - previous.arrived_at.getTime() < ARRIVAL_THROTTLE_MS
    ) {
      return { woke: false, keptArrivalId: previous.id } as const;
    }
    const written = await deps.db.query<{ id: string; visit: ArrivalVisit }>(
      `INSERT INTO rep_arrivals
         (company_id, seat_id, twin_id, arrived_at, day, visit, last_arrived_at)
       SELECT $1, $2, $3, $4, d.day,
              CASE WHEN $6::date IS NOT NULL AND $6::date = d.day
                   THEN 'return' ELSE 'first_of_day' END,
              $7
         FROM (SELECT ($4::timestamptz AT TIME ZONE $5)::date AS day) d
       RETURNING id, visit`,
      [
        scope.companyId,
        scope.seatId,
        deps.twinId,
        now,
        deps.timeZone,
        previous?.day ?? null,
        previous?.arrived_at ?? null,
      ],
    );
    const row = written.rows[0]!;
    return {
      woke: true,
      arrivalId: row.id,
      visit: row.visit,
      arrivedAt: now,
      ...(previous === undefined ? {} : { lastArrivedAt: previous.arrived_at }),
    } as const;
  });
}
