/**
 * THE WAKES THAT FIRE AN AUTOMATION: THE CLOCK AND THE SEAM'S EVENTS (tickets
 * #325, #364; spec #318 decisions 26 and 28 as amended 2026-10-06; ADR-0014's
 * one clock; ADR-0012: the seat-state gate and the pause state on every wake).
 *
 * An active automation's row wakes in one of two ways, and either way the
 * firing is one run, started by `startRun` exactly as the thread's
 * `start_workflow` starts one — the clock, the trigger or the rep as its
 * creator, the row's word (`rutina`, or the shipped name of one of Dito's) and
 * its id beside it, its definition the one the row pins: a rutina's from the
 * bundle, Dito's from this build (`shipped-automations.ts`).
 *
 * THE CLOCK (`fireDueCadences`), once a pass, after the runs engine: every
 * live cadence row of the one `schedules` store whose automation is active —
 * Dito's extraction and disclosure among them — each with the latest instant
 * its cadence has reached in the seat's zone: every day at the hour, or every
 * week on each weekday of its set at the hour. An instant before the row was
 * activated never fires, so Activar at 9:30 on a Friday waits for next
 * Friday's nine. A runtime that was down across instants fires the latest one
 * once, never a backlog. A cadence that names a precondition fires only when it holds
 * (`preconditions.ts`): asked after the gate and before the instant is
 * stamped, so a false one leaves the instant for the next pass to ask again.
 * The reminders' one-shot rows are the clock's other half (`reminders.ts`).
 *
 * THE SEAM'S EVENTS (`fireOnEvent`), from the consumer's pass that handles
 * them: an inbound customer message, narrowed to one customer when the
 * rutina names one, and a card settling for good. Dito's drafting row wakes
 * on a customer's message too, but its turn answers someone and leaves no run
 * row (ADR-0014 as amended 2026-10-07), so the consumer runs it and this
 * fires only the rep's rutinas. The predicate reads the event's kind
 * and the customer's reference — metadata — and the run is started with the
 * event's id and that reference as its inputs, never content.
 *
 * ONE RUN PER RUTINA PER WAKE. A cadence row's `last_fired_at` takes the
 * instant in the statement that fires it, and only while that instant is later
 * than the last one, so two passes never fire it twice; `runs_one_per_wake`
 * holds the same of an event a failed pass hands over twice.
 *
 * THE GATE, BOTH WAYS (`gate.ts`): the seat's state and the rutina's switch
 * are read first and asserted again in the statement that fires — a switch
 * turned off between the two never lets the firing through. While the gate
 * holds, a cadence's instant passes with no run (stamped, so turning the
 * switch back on later fires the next instant, not a missed one); an event
 * that arrives while it holds fires nothing.
 */
import { isShippedAutomation, type SettleOutcome, type ShippedAutomation } from "@dito/seam";
import type pg from "pg";
import type { BatchWork } from "../lanes.js";
import { spellReference } from "../thread/references.js";
import type { RunDefinition, RunValue } from "./definition.js";
import { automationPaused, automationUnpausedSql, runGate, seatLinkedSql, seatStateOf } from "./gate.js";
import type { RunDeps } from "./engine.js";
import { cadenceWeekdaysSql } from "./next-firing.js";
import { isPreconditionName, PRECONDITIONS, PRECONDITIONS_THAT_REPEAT } from "./preconditions.js";
import { rutinaContent, readRutina } from "./rutinas.js";
import { shippedAutomationOf, shippedDefinitionOf } from "./shipped-automations.js";
import { startRun, type StartedRun } from "./start.js";


/**
 * THE GATE AS A PREDICATE OVER AN AUTOMATION'S ROW (alias `a`), for the
 * statement that fires it: live and active, its seat linked, its switch at
 * «Activa» — the same facts `runGate` read a moment before, asserted again
 * where the write is.
 */
const AUTOMATION_FIRES_SQL = `a.state = 'active' AND a.ended_at IS NULL AND ${seatLinkedSql("a.seat_id")}
  AND ${automationUnpausedSql("a.seat_id", "a.id")}`;

/** One automation's row, as a firing reads it. */
interface FiringRow {
  readonly id: string;
  readonly seatId: string;
  readonly digest: string;
  /** The name of one of Dito's, or nothing for a rep's rutina. */
  readonly shipped: ShippedAutomation | null;
}

/** The row a firing is about, when it is a live, active one of this twin's. */
async function firingRowOf(db: pg.ClientBase, twinId: string, id: string): Promise<FiringRow | undefined> {
  const rows = await db.query<{ id: string; seat_id: string; definition_digest: string; shipped: string | null }>(
    `SELECT id, seat_id, definition_digest, shipped FROM automations
      WHERE twin_id = $1 AND id = $2 AND state = 'active' AND ended_at IS NULL`,
    [twinId, id],
  );
  const row = rows.rows[0];
  if (row === undefined) return undefined;
  return {
    id: row.id,
    seatId: row.seat_id,
    digest: row.definition_digest,
    shipped: row.shipped !== null && isShippedAutomation(row.shipped) ? row.shipped : null,
  };
}

/**
 * The definition a row fires: one of Dito's this build ships, or a rutina's
 * from the bundle — either way only under the digest the row pins.
 */
async function definitionOf(deps: RunDeps, row: FiringRow): Promise<RunDefinition | undefined> {
  if (row.shipped !== null) return shippedDefinitionOf(row.shipped, row.digest);
  const rutina = await readRutina(deps.db, deps.twinId, row.id);
  return rutina === undefined ? undefined : rutinaContent(deps.bundle, rutina)?.definition;
}

/** A seam event a rutina's trigger may wake on, as the consumer hands it over. */
export type RutinaEvent =
  | {
      readonly kind: "customer_message";
      /** The `wa_events` row: an id, never what it said. */
      readonly eventId: string;
      readonly chatJid: string;
    }
  | { readonly kind: "card_settled"; readonly postId: string; readonly outcome: SettleOutcome };

/**
 * THE OUTCOMES THAT SETTLE A CARD FOR GOOD — what a `card_settled` rutina
 * wakes on (Codex r3). A send the rail is holding (`queued`), one it gave
 * back (`failed`) or one whose ack never came (`held`) leaves the card still
 * open, and a retracted line is one line of the day's notes, not the card.
 */
const CARD_SETTLED_OUTCOMES: ReadonlySet<SettleOutcome> = new Set(["sent", "dismissed", "confirmed", "declined"]);

/**
 * THE CLOCK'S HALF, for one twin at `now`: every active automation whose
 * live cadence has reached an instant it has not fired for, and whose
 * precondition, when it names one, holds. How many runs it started.
 *
 * A CADENCE WHOSE PRECONDITION GOES ON HOLDING FIRES AGAIN THAT DAY
 * (`PRECONDITIONS_THAT_REPEAT`): once its last run has ended, and only for
 * today's instant, the clock fires it again at this pass — woken by the
 * pass's own instant, so each firing is its own run.
 */
export async function fireDueCadences(deps: RunDeps, now: Date, batch: BatchWork): Promise<number> {
  const zone = deps.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const due = await deps.db.query<{
    id: string;
    schedule_id: string;
    due_at: Date;
    precondition: string | null;
    again: boolean;
  }>(
    // THE LATEST INSTANT EACH CADENCE HAS REACHED, cut in the seat's zone: for
    // each weekday the cadence names — all seven for a daily one — that
    // weekday's hour this week, or a week back when it is still ahead of now,
    // and the latest of them. Compared as instants, never as wall clocks: on a
    // night the clocks go back, an hour read twice is still one instant.
    `WITH here AS (SELECT ($2::timestamptz AT TIME ZONE $3) AS t)
     SELECT a.id, s.id AS schedule_id, due.at AS due_at, s.precondition,
            s.last_fired_at IS NOT NULL AND s.last_fired_at >= due.at AS again
       FROM automations a
       JOIN schedules s ON s.automation_id = a.id AND s.kind = 'cadence' AND s.ended_at IS NULL
       CROSS JOIN here
       CROSS JOIN LATERAL (
         SELECT max(CASE WHEN (c.candidate AT TIME ZONE $3) > $2::timestamptz
                         THEN (c.candidate - interval '7 days') AT TIME ZONE $3
                         ELSE c.candidate AT TIME ZONE $3 END) AS at
           FROM unnest(${cadenceWeekdaysSql("s.every", "s.weekdays")}) AS w(d)
           CROSS JOIN LATERAL (
             SELECT (here.t::date - (extract(isodow FROM here.t)::int - w.d + 7) % 7)
                    + make_time(s.at_hour, 0, 0) AS candidate) c) due
      WHERE a.twin_id = $1 AND a.state = 'active' AND a.ended_at IS NULL
        AND due.at >= a.activated_at
        AND (s.last_fired_at IS NULL OR s.last_fired_at < due.at
             OR (s.precondition = ANY($4::text[])
                 AND (due.at AT TIME ZONE $3)::date = here.t::date
                 AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.automation_id = a.id AND r.ended_at IS NULL)))
      ORDER BY due.at, a.id`,
    [deps.twinId, now, zone, [...PRECONDITIONS_THAT_REPEAT]],
  );
  let fired = 0;
  for (const row of due.rows) {
    const automation = await firingRowOf(deps.db, deps.twinId, row.id);
    if (automation === undefined) continue;
    // THE INSTANT IS TAKEN ONCE; A REPEAT TAKES IT AGAIN ONLY WHILE NO RUN OF
    // THE AUTOMATION IS GOING, in the same statement.
    const stamp = async (client: pg.ClientBase, gated: boolean): Promise<boolean> =>
      (
        await client.query(
          `UPDATE schedules s SET last_fired_at = $2
            WHERE s.id = $1
              AND ${
                row.again
                  ? "s.last_fired_at = $2 AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.automation_id = s.automation_id AND r.ended_at IS NULL)"
                  : "(s.last_fired_at IS NULL OR s.last_fired_at < $2)"
              }
              ${gated ? `AND EXISTS (SELECT 1 FROM automations a WHERE a.id = s.automation_id AND ${AUTOMATION_FIRES_SQL})` : ""}`,
          [row.schedule_id, row.due_at],
        )
      ).rowCount === 1;
    const started = await fire(deps, automation, now, {
      wokenBy: `clock:${String((row.again ? now : row.due_at).getTime())}`,
      creator: "clock",
      inputs: {},
      // THE PRECONDITION, ASKED AFTER THE GATE AND BEFORE THE STAMP: false,
      // and the instant stays unfired for the next pass to ask again.
      holds: async () => {
        if (row.precondition === null) return true;
        if (!isPreconditionName(row.precondition)) return false;
        return await PRECONDITIONS[row.precondition]({
          deps,
          db: deps.db,
          batch,
          seatId: automation.seatId,
          now,
          dueAt: row.due_at,
        });
      },
      // THE STATEMENT THAT FIRES IT TAKES THE INSTANT, under the gate: one run
      // per instant, and none for a switch turned off since the read.
      claim: (client) => stamp(client, true),
      // ...AND WHILE THE GATE HOLDS, THE INSTANT PASSES WITH NO RUN.
      held: async () => {
        await stamp(deps.db, false);
      },
    });
    if (started !== undefined) fired += 1;
  }
  return fired;
}

/**
 * THE EVENTS' HALF: every active rutina of this twin whose trigger matches the
 * event fires one run. How many runs it started.
 */
export async function fireOnEvent(deps: RunDeps, event: RutinaEvent, now: Date): Promise<number> {
  if (event.kind === "card_settled" && !CARD_SETTLED_OUTCOMES.has(event.outcome)) return 0;
  const matching = await deps.db.query<{ id: string; trigger_customer: number | null }>(
    `SELECT id, trigger_customer FROM automations
      WHERE twin_id = $1 AND state = 'active' AND ended_at IS NULL AND origin <> 'dito'
        AND wake = 'trigger' AND trigger_event = $2
      ORDER BY created_at, id`,
    [deps.twinId, event.kind],
  );
  if (matching.rows.length === 0) return 0;
  // THE CUSTOMER'S REFERENCE, asked of the bundle only when a rutina listens:
  // the predicate compares it, and the run is told it as its input.
  const customer =
    event.kind === "customer_message" ? deps.bundle.referenceForChat(event.chatJid) : undefined;
  let fired = 0;
  for (const row of matching.rows) {
    if (row.trigger_customer !== null && row.trigger_customer !== customer) continue;
    const automation = await firingRowOf(deps.db, deps.twinId, row.id);
    if (automation === undefined) continue;
    const id = event.kind === "customer_message" ? event.eventId : event.postId;
    const started = await fire(deps, automation, now, {
      wokenBy: `event:${event.kind}:${id}`,
      creator: "trigger",
      inputs: customer === undefined ? { event: id } : { event: id, customer: spellReference(customer) },
      // THE STATEMENT THAT FIRES IT RE-ASSERTS THE GATE, and the unique index
      // on (rutina, wake) refuses the event's second hand-over.
      claim: async (client) =>
        (
          await client.query(
            `SELECT 1 FROM automations a
              WHERE a.id = $1 AND ${AUTOMATION_FIRES_SQL}
                AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.automation_id = a.id AND r.woken_by = $2)
              FOR UPDATE OF a`,
            [automation.id, `event:${event.kind}:${id}`],
          )
        ).rows.length === 1,
      held: async () => {},
    });
    if (started !== undefined) fired += 1;
  }
  return fired;
}

/**
 * THE REP ASKS ONE OF DITO'S AUTOMATIONS TO RUN NOW (ticket #364; spec #193
 * decision 26): the same run its clock fires, started by `startRun` with the
 * rep as its creator and the request's own inputs, behind the same gate and
 * the same switch — on the caller's connection and in its transaction, so the
 * request row it serves is settled with it. Nothing, when the gate holds, the
 * row is missing, or it pins another build's definition.
 */
export async function startShippedRun(
  deps: RunDeps,
  client: pg.ClientBase,
  shipped: ShippedAutomation,
  inputs: Readonly<Record<string, RunValue>>,
  now: Date,
): Promise<StartedRun | undefined> {
  const found = await shippedAutomationOf(client, deps.twinId, shipped);
  if (found === undefined) return undefined;
  const row = await firingRowOf(client, deps.twinId, found.id);
  if (row === undefined) return undefined;
  const verdict = runGate({
    seat: await seatStateOf(client, row.seatId),
    paused: false,
    cancelled: false,
    automationPaused: await automationPaused(client, row.seatId, row.id),
  });
  if (verdict !== "advance") return undefined;
  const definition = await definitionOf(deps, row);
  if (definition === undefined) return undefined;
  return await startRun(
    {
      db: client,
      twinId: deps.twinId,
      seatId: row.seatId,
      dek: deps.dek,
      harness: deps.harness,
      model: deps.drafting.model,
      ...(deps.timeZone === undefined ? {} : { timeZone: deps.timeZone }),
    },
    { definition, inputs, automation: shipped, creator: "rep", fired: { id: row.id }, now },
  );
}

/**
 * One firing of one automation: the gate read, the precondition asked, then —
 * in one transaction on the pool — the claim that re-asserts the gate and the
 * run `startRun` begins. The run started, or nothing.
 */
async function fire(
  deps: RunDeps,
  automation: FiringRow,
  now: Date,
  wake: {
    readonly wokenBy: string;
    readonly creator: "clock" | "trigger";
    readonly inputs: Readonly<Record<string, string>>;
    readonly holds?: () => Promise<boolean>;
    readonly claim: (client: pg.ClientBase) => Promise<boolean>;
    readonly held: () => Promise<void>;
  },
): Promise<StartedRun | undefined> {
  const verdict = runGate({
    seat: await seatStateOf(deps.db, automation.seatId),
    paused: false,
    cancelled: false,
    automationPaused: await automationPaused(deps.db, automation.seatId, automation.id),
  });
  if (verdict !== "advance") {
    await wake.held();
    return undefined;
  }
  if (wake.holds !== undefined && !(await wake.holds())) return undefined;
  // A ROW WHOSE DEFINITION IS NOT THE ONE IT PINS FIRES NOTHING: a run never
  // starts under a definition the rep did not activate, or this build does
  // not ship.
  const definition = await definitionOf(deps, automation);
  if (definition === undefined) return undefined;
  const client = await deps.executionPool.connect();
  try {
    await client.query("BEGIN");
    try {
      if (!(await wake.claim(client))) {
        await client.query("ROLLBACK");
        return undefined;
      }
      const started = await startRun(
        {
          db: client,
          twinId: deps.twinId,
          seatId: automation.seatId,
          dek: deps.dek,
          harness: deps.harness,
          model: deps.drafting.model,
          ...(deps.timeZone === undefined ? {} : { timeZone: deps.timeZone }),
        },
        {
          definition,
          inputs: wake.inputs,
          automation: automation.shipped ?? RUTINA_AUTOMATION,
          creator: wake.creator,
          fired: { id: automation.id, wokenBy: wake.wokenBy },
          now,
        },
      );
      await client.query("COMMIT");
      return started;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    }
  } finally {
    client.release();
  }
}

/**
 * THE WORD EVERY RUN A REP'S RUTINA FIRES CARRIES (`runs_rutina_check`), with
 * the rutina's own id beside it on the row; a run of Dito's carries its
 * shipped name.
 */
export const RUTINA_AUTOMATION = "rutina";
