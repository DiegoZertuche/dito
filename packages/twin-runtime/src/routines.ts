/**
 * RUTINAS: WHAT FIRES ON ITS OWN, AS ONE READ (tickets #267, #325, #364; spec
 * #258 decisions 16 and 18; spec #318 decisions 29–31; ADR-0014; CONTEXT.md
 * *Rutinas*, *Automation*).
 *
 * Rutinas shows, in the twin's first person, what fires on its own, when it
 * fires and when it last fired — and every card is one row of `automations`
 * for the seat: Dito's five first, in `SHIPPED_AUTOMATIONS`' order, which is
 * the order a rep's day meets them, then the rep's active rutinas, newest
 * first — a rutina the twin proposed is a card where the rep is until they
 * accept it (ticket #386). The twin thread is not among them: it is the twin itself
 * (ruled 2026-10-07). Trabajos en curso is what fired (`runs/read.ts`).
 *
 * EVERY CARD ON A CADENCE CARRIES ITS NEXT INSTANT (ticket #387): the clock's
 * arithmetic said forward from now (`runs/next-firing.ts`), cut in the seat's
 * zone with its day — absent while the switch holds it, which the card says
 * in the switch's own words.
 *
 * ONE OF DITO'S carries its wake off its row — the cadence's hour, a
 * customer's message, one-shot rows — its switch, and its last firing: the
 * last run it started, for the two the clock fires; the last turn it took, for
 * drafting, which answers someone and leaves no run row; the last reminder
 * row that came due, for the reminders, whose firing wakes the thread and
 * starts no run. Its words are copy on rep-web's side, keyed by its name.
 *
 * A RUTINA THE TWIN AUTHORED carries its sentence and its plan out of the
 * bundle: the twin's sentence as it wrote it, its customers' references
 * rendered as the names the rep confirmed, and the plan rendered by code from
 * the steps of the definition the row pins (ADR-0044's `proposal` part). A
 * rutina whose content the bundle does not hold under its pin is left off:
 * Rutinas never shows a plan the clock would not run.
 */
import type { Bundle } from "@dito/bundle";
import {
  isShippedAutomation,
  SHIPPED_AUTOMATIONS,
  type TwinPlanStep,
  type TwinRoutines,
  type TwinRutina,
  type TwinRutinaRun,
  type TwinShippedAutomation,
  type TwinShippedWake,
} from "@dito/seam";
import type pg from "pg";
import type { StepSpec } from "./runs/definition.js";
import { firstFiringAtOrAfter, type Cadence } from "./runs/next-firing.js";
import { listActiveRutinas, rutinaContent, type RutinaRow } from "./runs/rutinas.js";
import { customersOf, mentionsIn, renderNames, type Customers } from "./thread/references.js";

/** What the read needs: the seam, the twin, and the rep's own zone. */
export interface RoutineDeps {
  readonly db: pg.ClientBase;
  readonly twinId: string;
  /** The zone a last firing's day is cut in; the host's when absent (`exchanges.ts`). */
  readonly timeZone?: string;
  /**
   * The twin's bundle and the rep's own chat, where a rutina's sentence and
   * plan are read and its customers named. Absent, no rutina is listed — its
   * words live nowhere else.
   */
  readonly bundle?: Bundle;
  readonly selfChatJid?: string;
}

/**
 * Rutinas' cards — Dito's five with each one's switch and last firing, then
 * the rutinas the twin authored — and the seat-local today.
 */
export async function readRutinas(deps: RoutineDeps, now: Date): Promise<TwinRoutines> {
  const zone = deps.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const today = await deps.db.query<{ today: string }>(
    "SELECT (($1::timestamptz) AT TIME ZONE $2)::date::text AS today",
    [now, zone],
  );
  return {
    today: today.rows[0]!.today,
    automations: [...(await readShipped(deps, zone, now)), ...(await readAuthored(deps, zone, now))],
  };
}

/** Dito's own rows for this twin's seat, as Rutinas shows them. */
async function readShipped(deps: RoutineDeps, zone: string, now: Date): Promise<readonly TwinShippedAutomation[]> {
  const rows = await deps.db.query<{
    id: string;
    shipped: string;
    wake: "schedule" | "trigger";
    every: string | null;
    at_hour: number | null;
    paused: boolean;
    last_at: Date | null;
    last_day: string | null;
  }>(
    // THE LAST FIRING, BY WHAT FIRING MEANS FOR EACH: the last run it started
    // (a child is its parent's firing), drafting's last turn, the reminders'
    // last row that came due.
    `SELECT a.id, a.shipped, a.wake, a.every, a.at_hour,
            EXISTS (SELECT 1 FROM automation_pauses p WHERE p.automation_id = a.id AND p.paused) AS paused,
            last.at AS last_at, (last.at AT TIME ZONE $2)::date::text AS last_day
       FROM automations a
       LEFT JOIN LATERAL (
              SELECT max(at) AS at FROM (
                SELECT max(r.created_at) AS at FROM runs r
                 WHERE r.twin_id = a.twin_id AND r.automation_id = a.id AND r.parent_run_id IS NULL
                UNION ALL
                SELECT max(e.started_at) FROM executions e
                 WHERE a.shipped = 'drafting' AND e.twin_id = a.twin_id AND e.trigger_kind = 'chat_turn'
                UNION ALL
                SELECT max(s.fired_at) FROM schedules s
                 WHERE s.automation_id = a.id AND s.kind = 'once') fired) last ON true
      WHERE a.twin_id = $1 AND a.origin = 'dito' AND a.ended_at IS NULL`,
    [deps.twinId, zone],
  );
  const order = (shipped: string): number => (SHIPPED_AUTOMATIONS as readonly string[]).indexOf(shipped);
  const listed: TwinShippedAutomation[] = [];
  const shipped = rows.rows
    .filter((row) => isShippedAutomation(row.shipped))
    .sort((a, b) => order(a.shipped) - order(b.shipped));
  for (const row of shipped) {
    const wake: TwinShippedWake =
      row.wake === "trigger"
        ? { kind: "trigger" }
        : row.every === null || row.at_hour === null
          ? { kind: "once" }
          : { kind: "schedule", every: "day", atHour: row.at_hour };
    const next = wake.kind === "schedule" && !row.paused ? await nextFiringOf(deps.db, wake, now, zone) : undefined;
    listed.push({
      id: row.id,
      origin: "dito",
      shipped: row.shipped as TwinShippedAutomation["shipped"],
      wake,
      paused: row.paused,
      ...(row.last_at === null || row.last_day === null
        ? {}
        : { lastRun: { at: row.last_at.toISOString(), day: row.last_day } }),
      ...(next === undefined ? {} : { nextFiring: next }),
    });
  }
  return listed;
}

/**
 * THE NEXT INSTANT A CADENCE REACHES, from now, and the seat-local day it falls
 * on (ticket #387): the clock's own arithmetic said forward
 * (`firstFiringAtOrAfter`). It is the instant the clock looks; a cadence that
 * names a precondition may still pass it with no run.
 */
async function nextFiringOf(db: pg.ClientBase, cadence: Cadence, now: Date, zone: string): Promise<TwinRutinaRun> {
  const at = await firstFiringAtOrAfter(db, cadence, now, zone);
  const day = await db.query<{ day: string }>("SELECT (($1::timestamptz) AT TIME ZONE $2)::date::text AS day", [at, zone]);
  return { at: at.toISOString(), day: day.rows[0]!.day };
}

/** The rutinas the twin authored, as Rutinas shows them. */
async function readAuthored(deps: RoutineDeps, zone: string, now: Date): Promise<readonly TwinRutina[]> {
  const { bundle, selfChatJid } = deps;
  if (bundle === undefined || selfChatJid === undefined) return [];
  const rows = await listActiveRutinas(deps.db, deps.twinId);
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const facts = await deps.db.query<{
    id: string;
    paused: boolean;
    last_run_at: Date | null;
    last_run_day: string | null;
  }>(
    `SELECT a.id,
            EXISTS (SELECT 1 FROM automation_pauses p WHERE p.automation_id = a.id AND p.paused) AS paused,
            r.created_at AS last_run_at,
            (r.created_at AT TIME ZONE $3)::date::text AS last_run_day
       FROM unnest($2::uuid[]) AS a(id)
       LEFT JOIN LATERAL (
              SELECT created_at FROM runs
               WHERE twin_id = $1 AND automation_id = a.id AND parent_run_id IS NULL
               ORDER BY created_at DESC, id DESC LIMIT 1) r ON true`,
    [deps.twinId, ids, zone],
  );
  const byId = new Map(facts.rows.map((row) => [row.id, row]));
  const customers = customersOf(bundle, selfChatJid);
  const listed: TwinRutina[] = [];
  for (const row of rows) {
    const content = rutinaContent(bundle, row);
    if (content === undefined) continue;
    const fact = byId.get(row.id);
    const paused = fact?.paused ?? false;
    const next =
      row.state === "active" && row.wake.kind === "schedule" && !paused
        ? await nextFiringOf(deps.db, row.wake, now, zone)
        : undefined;
    listed.push({
      id: row.id,
      origin: row.origin,
      state: row.state,
      name: renderNames(content.definition.name, mentionsIn(content.definition.name, customers)),
      sentence: renderNames(content.sentence, mentionsIn(content.sentence, customers)),
      wake: rutinaWakeOf(row, customers),
      plan: planOf(content.definition.steps, 0),
      paused,
      ...(row.replacesId === null ? {} : { replaces: row.replacesId }),
      ...(fact?.last_run_at == null || fact.last_run_day === null
        ? {}
        : { lastRun: { at: fact.last_run_at.toISOString(), day: fact.last_run_day } }),
      ...(next === undefined ? {} : { nextFiring: next }),
    });
  }
  return listed;
}

/** A rutina's wake as the wire types it, its customer by the name the rep confirmed. */
function rutinaWakeOf(row: RutinaRow, customers: Customers): TwinRutina["wake"] {
  const { wake } = row;
  if (wake.kind === "schedule") {
    return {
      kind: "schedule",
      every: wake.every,
      atHour: wake.atHour,
      ...(wake.weekdays === undefined ? {} : { weekdays: wake.weekdays }),
    };
  }
  const customer = wake.customer === undefined ? undefined : customers(wake.customer)?.shown;
  return { kind: "trigger", event: wake.event, ...(customer === undefined ? {} : { customer }) };
}

/**
 * THE PLAN, RENDERED BY CODE FROM THE STEPS (ADR-0044's `proposal` part): each
 * step's kind in order, a branch's steps one level deeper after their `if`,
 * and a wait's span or the card it waits on. Never a step's instructions or
 * its name — those are the twin's words to itself. The proposal card's plan
 * is said from this too (`runs/rutina-words.ts`).
 */
export function planOf(steps: readonly StepSpec[], depth: number): readonly TwinPlanStep[] {
  return steps.flatMap((step): TwinPlanStep[] => {
    if (step.kind === "if") {
      return [{ kind: "if", depth }, ...planOf(step.then, depth + 1), ...planOf(step.else, depth + 1)];
    }
    if (step.kind === "wait") {
      return [
        {
          kind: "wait",
          depth,
          ...("after" in step.until
            ? { wait: { after: step.until.after } }
            : "settle" in step.until
              ? { wait: { settle: true as const } }
              : {}),
        },
      ];
    }
    return [{ kind: step.kind, depth }];
  });
}
