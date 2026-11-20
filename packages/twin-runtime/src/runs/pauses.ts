/**
 * THE PAUSE SWITCH'S STORE (tickets #325, #364; spec #318 decision 30;
 * ADR-0012: the pause state on every wake; CONTEXT.md *Rutinas*).
 *
 * Every automation Rutinas shows — Dito's own four and every rutina the twin
 * authored — is a row of `automations`, and its per-seat state, «Activa» or
 * «En pausa», is a row beside it, named by that row's id: one switch, one
 * mechanism, for Dito's and the rep's alike. No row means «Activa», which is
 * what every automation is until the rep touches its switch.
 *
 * WHO READS IT: the gate (`gate.ts`), in the function and in the SQL — the
 * clock and the seam events before they fire anything, a run before its next
 * step, the consumer before a customer's message is drafted. WHO WRITES IT:
 * the rep's act on Rutinas, and nothing else.
 */
import type pg from "pg";

/**
 * Sets the seat's switch for one automation, by its row. `false` when it
 * already stood there, so the act can answer `already` and write nothing.
 */
export async function setAutomationPaused(
  db: pg.ClientBase,
  args: {
    readonly twinId: string;
    readonly seatId: string;
    readonly automationId: string;
    readonly paused: boolean;
  },
): Promise<boolean> {
  // A SWITCH NEVER TOUCHED STANDS AT «ACTIVA»: turning it on writes nothing.
  const standing = await db.query<{ paused: boolean }>(
    "SELECT paused FROM automation_pauses WHERE seat_id = $1 AND automation_id = $2",
    [args.seatId, args.automationId],
  );
  if ((standing.rows[0]?.paused ?? false) === args.paused) return false;
  await db.query(
    `INSERT INTO automation_pauses (twin_id, seat_id, automation_id, paused)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT ON CONSTRAINT automation_pauses_one_per_rutina
       DO UPDATE SET paused = EXCLUDED.paused, changed_at = clock_timestamp()`,
    [args.twinId, args.seatId, args.automationId, args.paused],
  );
  return true;
}
