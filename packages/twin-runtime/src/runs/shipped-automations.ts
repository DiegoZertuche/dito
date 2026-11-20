/**
 * DITO'S OWN AUTOMATIONS, AS ROWS (ticket #364; ADR-0014 as amended
 * 2026-10-06/07: «every automation, Dito-shipped or rep-created, is an
 * instance of that one shape»; CONTEXT.md *Automation*, *Rutinas*).
 *
 * Five things fire on their own besides the rep's rutinas, and each is one row
 * of `automations` per seat — origin `dito`, its `shipped` name, `active`,
 * pinned to the digest of the definition this build ships — with the rep's
 * switch beside it like any rutina's (`pauses.ts`):
 *
 *   `drafting`         — a customer's message wakes it (the consumer's turn,
 *                        which answers someone and leaves no run row);
 *   `extraction`       — the clock, every day at the seat's disclosure hour,
 *                        when the seam has settled and a chat-day is unsettled;
 *   `daily_disclosure` — the clock, at the same hour, once the day's
 *                        extraction run has ended and the day owes a line;
 *   `reminders`        — one-shot rows of the clock store, one per card that
 *                        can lapse, each waking the thread (`reminders.ts`). It
 *                        is pinned to the thread's definition, because the
 *                        thread's turn is what its firing wakes;
 *   `overnight_requests` — the clock, every morning at eight on the seat's
 *                        clock — when the quiet hours end and the rep's day
 *                        starts — when a customer wrote overnight (ticket
 *                        #326's briefing: what was asked, and a draft for each).
 *
 * WRITTEN BY THE RUNTIME, ONCE A PROCESS, FOR ITS SEAT (`ensureShippedAutomations`,
 * called from the pass): idempotent on `automations_one_shipped_per_seat`, so
 * a restart writes nothing new, and a build whose definition changed moves
 * the pin and the hour — the rows say what this build fires.
 */
import { randomUUID } from "node:crypto";
import type { ShippedAutomation } from "@dito/seam";
import type pg from "pg";
import { DISCLOSURE_DEFINITION } from "../disclosure/definition.js";
import { EXTRACTION_DEFINITION } from "../extraction/definition.js";
import { civilDate, DEFAULT_DISCLOSURE_HOUR, startOfCivilDay } from "../rep-clock.js";
import { runDigest, type RunDefinition } from "./definition.js";
import type { PreconditionName } from "./preconditions.js";
import { QUIET_HOURS_UNTIL } from "./reminder-rows.js";
import { DRAFTING_DEFINITION, THREAD_DEFINITION } from "./shipped-conversations.js";
import { SHIPPED_RUNS } from "./shipped.js";

/** How one of Dito's automations wakes. */
export type ShippedWake =
  | { readonly kind: "trigger"; readonly event: "customer_message" }
  | {
      readonly kind: "schedule";
      readonly precondition: PreconditionName;
      /** Its own hour on the seat's clock; absent, the seat's disclosure hour. */
      readonly atHour?: number;
    }
  | { readonly kind: "once" };

/** One of Dito's automations, as this build ships it. */
export interface ShippedAutomationSpec {
  readonly definition: RunDefinition;
  readonly wake: ShippedWake;
}

/** The five, by the name their row carries, in the order Rutinas lists them. */
export const SHIPPED_AUTOMATION_SPECS: Readonly<Record<ShippedAutomation, ShippedAutomationSpec>> = {
  drafting: { definition: DRAFTING_DEFINITION, wake: { kind: "trigger", event: "customer_message" } },
  extraction: {
    definition: EXTRACTION_DEFINITION,
    wake: { kind: "schedule", precondition: "seam_settled_and_chat_day_unsettled" },
  },
  daily_disclosure: {
    definition: DISCLOSURE_DEFINITION,
    wake: { kind: "schedule", precondition: "runs_settled_and_disclosure_owed_and_day_unposted" },
  },
  reminders: { definition: THREAD_DEFINITION, wake: { kind: "once" } },
  overnight_requests: {
    definition: SHIPPED_RUNS.overnight_requests,
    wake: { kind: "schedule", precondition: "customer_chat_traffic_overnight", atHour: QUIET_HOURS_UNTIL },
  },
};

/**
 * WRITES THE SEAT'S FIVE ROWS AND ITS THREE CADENCES, where they are missing —
 * and moves a row's pin and a cadence's hour to this build's. The day's read
 * and its post fire at the seat's disclosure hour, the instant extraction is
 * cut ahead of the disclosure (ADR-0016); the overnight requests at eight in
 * the morning; each with its precondition by name.
 *
 * A ROW IS ACTIVE FROM THE START OF THE DAY IT IS WRITTEN on the rep's clock
 * (Codex r3), so a seat that links — or a build that first writes the rows —
 * after the hour still reads and posts that day; yesterday's instant is never
 * caught up.
 */
export async function ensureShippedAutomations(
  db: pg.ClientBase,
  seat: {
    readonly twinId: string;
    readonly seatId: string;
    readonly disclosureHour?: number;
    /** The rep's zone, whose day the rows are active from. */
    readonly timeZone?: string;
  },
  now: Date,
): Promise<void> {
  const disclosureHour = seat.disclosureHour ?? DEFAULT_DISCLOSURE_HOUR;
  const activatedAt = startOfCivilDay(civilDate(now, seat.timeZone), seat.timeZone);
  for (const [shipped, spec] of Object.entries(SHIPPED_AUTOMATION_SPECS) as [ShippedAutomation, ShippedAutomationSpec][]) {
    const cadence = spec.wake.kind === "schedule";
    const hour = spec.wake.kind === "schedule" ? (spec.wake.atHour ?? disclosureHour) : null;
    const row = await db.query<{ id: string }>(
      `INSERT INTO automations (id, twin_id, seat_id, origin, shipped, state, definition_digest,
                                wake, every, at_hour, trigger_event, activated_at)
       VALUES ($1, $2, $3, 'dito', $4, 'active', $5, $6, $7, $8, $9, $10)
       ON CONFLICT ON CONSTRAINT automations_one_shipped_per_seat
         DO UPDATE SET definition_digest = EXCLUDED.definition_digest, at_hour = EXCLUDED.at_hour
       RETURNING id`,
      [
        randomUUID(),
        seat.twinId,
        seat.seatId,
        shipped,
        runDigest(spec.definition),
        spec.wake.kind === "trigger" ? "trigger" : "schedule",
        cadence ? "day" : null,
        cadence ? hour : null,
        spec.wake.kind === "trigger" ? spec.wake.event : null,
        activatedAt,
      ],
    );
    if (spec.wake.kind !== "schedule") continue;
    await db.query(
      `INSERT INTO schedules (twin_id, kind, every, at_hour, automation_id, precondition)
       VALUES ($1, 'cadence', 'day', $2, $3, $4)
       ON CONFLICT (automation_id) WHERE kind = 'cadence' AND ended_at IS NULL
         DO UPDATE SET at_hour = EXCLUDED.at_hour, precondition = EXCLUDED.precondition`,
      [seat.twinId, hour, row.rows[0]!.id, spec.wake.precondition],
    );
  }
}

/** One of Dito's rows for this twin's seat: its id and its seat — or nothing, before the pass wrote it. */
export async function shippedAutomationOf(
  db: pg.ClientBase,
  twinId: string,
  shipped: ShippedAutomation,
): Promise<{ readonly id: string; readonly seatId: string } | undefined> {
  const rows = await db.query<{ id: string; seat_id: string }>(
    "SELECT id, seat_id FROM automations WHERE twin_id = $1 AND shipped = $2 AND ended_at IS NULL",
    [twinId, shipped],
  );
  const row = rows.rows[0];
  return row === undefined ? undefined : { id: row.id, seatId: row.seat_id };
}

/**
 * The definition one of Dito's rows fires — this build's, when the row pins
 * it — or nothing, when the row pins another build's: a run never starts
 * under a definition its row does not name.
 */
export function shippedDefinitionOf(shipped: ShippedAutomation, digest: string): RunDefinition | undefined {
  const definition = SHIPPED_AUTOMATION_SPECS[shipped].definition;
  return runDigest(definition) === digest ? definition : undefined;
}
