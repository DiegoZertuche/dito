/**
 * THE REP'S WORDLESS ASKS, AS ROWS THE PASS READS (ticket #358; ADR-0012 as
 * amended — the machine is rows the pass reads; ADR-0031 as amended
 * 2026-10-06 — a rep who asked is always answered).
 *
 * A pick of one of the twin's open matters, a selection of a phrase on a card
 * and a summons of the twin's mark to a card are each an ask the rep made at the
 * dashboard: the local API checks it and writes a row (`recordAsk`), and the
 * consumer's pass reads the rows that carry no marker (`pendingAsks`) and
 * hands each to a turn of the twin thread, whose transaction writes the
 * marker (`consumer.ts`' `markAsk`). So an ask is served exactly once, across a restart,
 * by the marker — never by a queue in memory.
 *
 * The rep's arrival is the fourth ask and keeps its own row (`rep_arrivals`,
 * with the throttle `arrival.ts` holds) and its own marker
 * (`rep_arrival_executions`); `pendingArrivals` reads the two the same way.
 *
 * WHAT A ROW CARRIES IS WHAT THE EVENT CARRIES: ids, and the twin's own words
 * where the event has them — a pick's label as the twin's notes hold it, a
 * selection's phrase as the card shows it — sealed under the twin DEK.
 */
import type pg from "pg";
import type { Dek } from "@dito/crypto";
import type { ThreadEvent } from "./thread/events.js";

/** The three asks a row holds — `rep_asks_kind_check`'s other half. */
export const REP_ASK_KINDS = ["pick", "selection", "summons"] as const;
export type RepAskKind = (typeof REP_ASK_KINDS)[number];

/** The events a row of `rep_asks` becomes. */
export type AskEvent = Extract<ThreadEvent, { readonly kind: "matter.picked" | "selection" | "summons" }>;

/** The event the arrival's row becomes. */
export type ArrivalEvent = Extract<ThreadEvent, { readonly kind: "arrival" }>;

/** The four kinds of event that are rows, never raised in memory. */
export type AskedEventKind = AskEvent["kind"] | ArrivalEvent["kind"];

/** What reading and writing the rows needs. */
export interface RepAskDeps {
  readonly db: pg.ClientBase;
  readonly twinId: string;
  readonly dek: Dek;
}

/** Whose ask — off the registry, never the request. */
export interface RepAskScope {
  readonly companyId: string;
  readonly seatId: string;
}

/**
 * Writes one ask, keyed by the page's own id for it. An id already written
 * is the same ask sent twice and writes nothing more.
 */
export async function recordAsk(deps: RepAskDeps, scope: RepAskScope, event: AskEvent): Promise<void> {
  const fields =
    event.kind === "matter.picked"
      ? { id: event.pickId, kind: "pick", postId: null, aboutKind: event.about.kind, aboutId: event.about.id, words: event.label }
      : event.kind === "selection"
        ? { id: event.selectionId, kind: "selection", postId: event.postId, aboutKind: null, aboutId: null, words: event.phrase }
        : { id: event.summonsId, kind: "summons", postId: event.postId, aboutKind: null, aboutId: null, words: null };
  await deps.db.query(
    `INSERT INTO rep_asks (id, company_id, seat_id, twin_id, kind, post_id, about_kind, about_id, words_enc)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (id) DO NOTHING`,
    [
      fields.id,
      scope.companyId,
      scope.seatId,
      deps.twinId,
      fields.kind,
      fields.postId,
      fields.aboutKind,
      fields.aboutId,
      fields.words === null ? null : Buffer.from(deps.dek.encrypt(Buffer.from(fields.words, "utf8"))),
    ],
  );
}

/** One ask the pass owes a turn: its event, and when the rep made it. */
export interface PendingAsk {
  readonly event: AskEvent | ArrivalEvent;
  readonly at: Date;
}

/** Every ask of this twin's with no marker, oldest first — the arrivals among them. */
export async function pendingAsks(deps: RepAskDeps): Promise<readonly PendingAsk[]> {
  const [asks, arrivals] = await Promise.all([pendingRepAsks(deps), pendingArrivals(deps)]);
  return [...asks, ...arrivals].sort((one, other) => one.at.getTime() - other.at.getTime());
}

async function pendingRepAsks(deps: RepAskDeps): Promise<readonly PendingAsk[]> {
  const rows = await deps.db.query<{
    id: string;
    seat_id: string;
    kind: RepAskKind;
    post_id: string | null;
    about_kind: "entity" | "post" | null;
    about_id: string | null;
    words_enc: Buffer | null;
    asked_at: Date;
  }>(
    `SELECT a.id, a.seat_id, a.kind, a.post_id, a.about_kind, a.about_id, a.words_enc, a.asked_at
       FROM rep_asks a
       LEFT JOIN rep_ask_processing p ON p.ask_id = a.id
      WHERE a.twin_id = $1 AND p.ask_id IS NULL
      ORDER BY a.asked_at, a.id`,
    [deps.twinId],
  );
  return rows.rows.map((row) => {
    const words = row.words_enc === null ? "" : Buffer.from(deps.dek.decrypt(row.words_enc)).toString("utf8");
    const event: AskEvent =
      row.kind === "pick"
        ? { kind: "matter.picked", about: { kind: row.about_kind!, id: row.about_id! }, label: words, pickId: row.id, seatId: row.seat_id }
        : row.kind === "selection"
          ? { kind: "selection", postId: row.post_id!, phrase: words, selectionId: row.id, seatId: row.seat_id }
          : { kind: "summons", postId: row.post_id!, summonsId: row.id, seatId: row.seat_id };
    return { event, at: row.asked_at };
  });
}

async function pendingArrivals(deps: RepAskDeps): Promise<readonly PendingAsk[]> {
  const rows = await deps.db.query<{
    id: string;
    seat_id: string;
    visit: "first_of_day" | "return";
    arrived_at: Date;
    last_arrived_at: Date | null;
  }>(
    `SELECT a.id, a.seat_id, a.visit, a.arrived_at, a.last_arrived_at
       FROM rep_arrivals a
       LEFT JOIN rep_arrival_executions m ON m.arrival_id = a.id
      WHERE a.twin_id = $1 AND m.arrival_id IS NULL
      ORDER BY a.arrived_at, a.id`,
    [deps.twinId],
  );
  return rows.rows.map((row) => ({
    event: {
      kind: "arrival",
      door: "dashboard",
      firstOfDay: row.visit === "first_of_day",
      arrival: {
        arrivalId: row.id,
        seatId: row.seat_id,
        arrivedAt: row.arrived_at,
        ...(row.last_arrived_at === null ? {} : { lastArrivedAt: row.last_arrived_at }),
      },
    },
    at: row.arrived_at,
  }));
}
