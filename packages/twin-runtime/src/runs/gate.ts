/**
 * THE SEAT-STATE GATE OF A RUN (ticket #323; ADR-0012: «every wake, step
 * boundary … consults seat state — one central gate»; spec #318 decision 26).
 *
 * ONE FUNCTION, CONSULTED BEFORE THE ENGINE CREATES ANYTHING FOR A RUN — the
 * clock firing a wait, the next step beginning, a cancelled run's report — and
 * at every step boundary. It reads the seat's state and the run's two flags
 * and answers what may happen.
 *
 * THE SEAT HOLDS THREE STATES TODAY (`SEAT_STATES`: invited, linked, retired),
 * and only `linked` lets a run move: an `invited` seat has no rail to act
 * through and a `retired` one has no rep to act for. ADR-0012's
 * `enforcement-paused` and `closing` are words the seam does not hold yet; when
 * they arrive they are seat states, read here, and they fire nothing.
 *
 * THE PAUSE SWITCH IS ONE MORE FACT (ticket #325; spec #318 decision 30):
 * an automation the rep set «En pausa» on Rutinas fires nothing — the clock
 * creates no run for it, a trigger creates none, and a run it already fired
 * holds at its next step boundary until the switch is back on. That is the
 * switch's fact, and it is not the run's own `paused` flag: Pausar on
 * Trabajos pauses one run and leaves the automation firing; the switch pauses
 * the automation and every run of it, and flips no run's flag. Two facts,
 * read side by side, in the function and in the SQL.
 */
import { SEAT_LINKED, type SeatState } from "@dito/seam";
import type pg from "pg";

/** What the gate reads. */
export interface GateFacts {
  /** The run's seat's state, or `undefined` when the seat is gone. */
  readonly seat: SeatState | undefined;
  /** The run's own flag, set by Pausar on Trabajos or the thread's `pause_run`. */
  readonly paused: boolean;
  readonly cancelled: boolean;
  /** The switch on Rutinas for the automation the run belongs to, for its seat. */
  readonly automationPaused: boolean;
}

/**
 * What may happen for the run now:
 *
 *   `advance` — fire its wait, begin its next step;
 *   `end`     — it was cancelled: end it with its report, and nothing else;
 *   `hold`    — nothing: the seat cannot act, the run is paused, or its
 *               automation's switch stands at «En pausa». The row
 *               stays as it is, and the next pass asks again.
 */
export type GateVerdict = "advance" | "end" | "hold";

export function runGate(facts: GateFacts): GateVerdict {
  if (facts.seat !== SEAT_LINKED) return "hold";
  if (facts.cancelled) return "end";
  if (facts.paused || facts.automationPaused) return "hold";
  return "advance";
}

/**
 * THE SEAT-STATE HALF OF THE GATE AS A PREDICATE, over the SQL expression that
 * names the seat.
 */
export function seatLinkedSql(seat: string): string {
  return `EXISTS (SELECT 1 FROM seats s WHERE s.id = ${seat} AND s.state = '${SEAT_LINKED}')`;
}

/**
 * THE SWITCH'S HALF AS A PREDICATE (tickets #325, #364): no `automation_pauses`
 * row holds this seat's switch at «En pausa» for the automation, named by the
 * SQL expression for its row's id — which may be NULL, for a run no
 * automation fired. One function, so the clock's firing, a seam event's and
 * the run's next step read the switch with one statement's words.
 */
export function automationUnpausedSql(seat: string, automationId: string): string {
  return `NOT EXISTS (SELECT 1 FROM automation_pauses p
    WHERE p.seat_id = ${seat} AND p.paused AND p.automation_id = ${automationId})`;
}

/**
 * THE SAME GATE AS A PREDICATE OVER `runs` (alias `r`), for the statement that
 * moves a run: beginning a step and firing a wait re-assert it in the UPDATE
 * itself (Codex r1), so a pause, a cancel, a switch turned off or a seat
 * unlinked between the read `runGate` answered and the write never lets the
 * write through. Every field of `GateFacts` has its clause here.
 */
export const GATE_ADVANCES_SQL = `r.ended_at IS NULL AND NOT r.paused AND NOT r.cancelled
  AND ${seatLinkedSql("r.seat_id")}
  AND ${automationUnpausedSql("r.seat_id", "r.automation_id")}`;

/**
 * Everything the gate reads for one run, on the caller's connection: its
 * seat's state, its two flags, and the switch of the automation it belongs to.
 */
export async function gateFactsOf(
  db: pg.ClientBase,
  run: {
    readonly seat_id: string;
    readonly automation_id: string | null;
    readonly paused: boolean;
    readonly cancelled: boolean;
  },
): Promise<GateFacts> {
  return {
    seat: await seatStateOf(db, run.seat_id),
    paused: run.paused,
    cancelled: run.cancelled,
    automationPaused: await automationPaused(db, run.seat_id, run.automation_id),
  };
}

/**
 * Whether the seat's switch stands at «En pausa» for an automation, by its
 * row's id — `automationUnpausedSql`'s question, asked once. A run no
 * automation fired (`null`) has no switch.
 */
export async function automationPaused(
  db: pg.ClientBase,
  seatId: string,
  automationId: string | null,
): Promise<boolean> {
  if (automationId === null) return false;
  const rows = await db.query(
    `SELECT 1 WHERE NOT ${automationUnpausedSql("$1::uuid", "$2::uuid")}`,
    [seatId, automationId],
  );
  return rows.rows.length > 0;
}

/** The run's seat's state, read on the caller's connection. */
export async function seatStateOf(
  db: pg.ClientBase,
  seatId: string,
): Promise<SeatState | undefined> {
  const rows = await db.query<{ state: SeatState }>("SELECT state FROM seats WHERE id = $1", [seatId]);
  return rows.rows[0]?.state;
}
