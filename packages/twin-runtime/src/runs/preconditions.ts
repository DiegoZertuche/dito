/**
 * THE PRECONDITIONS A CADENCE NAMES (ticket #364; CONTEXT.md *Precondition*:
 * «the check a Schedule makes before creating an execution — the seat's state,
 * something left to do — so a firing with nothing behind it creates no
 * execution»).
 *
 * One registry, by the name `schedules.precondition` carries and
 * `schedules_precondition_check` holds. The clock asks a cadence's named check
 * after the gate lets it through and before it stamps the instant
 * (`wakes.ts`): false, and the instant stays unfired, so the next pass asks
 * again; true, and the cadence fires for that instant — once, or, for the
 * day's read, again while it holds (`PRECONDITIONS_THAT_REPEAT`).
 *
 * EACH IS A STATEMENT ABOUT THE STORE, never about a model's words — code
 * deciding structure: whether the day has something left to read, whether the
 * read has ended and the day owes the rep a post, whether the night left
 * anything to brief the rep on.
 */
import type pg from "pg";
import type { BatchWork } from "../lanes.js";
import { batchIsIdle } from "../lanes.js";
import { atLocalHour, civilDate } from "../rep-clock.js";
import { QUIET_HOURS_FROM } from "./reminder-rows.js";
import type { RunDeps } from "./engine.js";
import { dayOwed, daySettled, disclosureDepsOf, extractionDepsOf } from "./run-reads.js";

/** The names a cadence may carry. */
export const PRECONDITION_NAMES = [
  "seam_settled_and_chat_day_unsettled",
  "runs_settled_and_disclosure_owed_and_day_unposted",
  "customer_chat_traffic_overnight",
] as const;

export type PreconditionName = (typeof PRECONDITION_NAMES)[number];

/** What a check reads: the runtime, the pass's connection, the batch lane, the seat, the pass's instant and the cadence's. */
export interface PreconditionAsk {
  readonly deps: RunDeps;
  readonly db: pg.ClientBase;
  readonly batch: BatchWork;
  readonly seatId: string;
  readonly now: Date;
  /** The instant of the seat's day the cadence has reached. */
  readonly dueAt: Date;
}

/** One named check. */
export type Precondition = (ask: PreconditionAsk) => Promise<boolean>;

export const PRECONDITIONS: Readonly<Record<PreconditionName, Precondition>> = {
  /**
   * THE DAY HAS SOMETHING LEFT TO READ: an in-scope chat with traffic in its
   * window — cut a minute short of now, so the seam has settled
   * (`SEAM_SETTLING_LAG_MS`) — whose chat-day no read has settled.
   */
  seam_settled_and_chat_day_unsettled: async ({ deps, db, now }) =>
    !(await daySettled(extractionDepsOf(deps, db), now)),

  /**
   * THE DAY'S READ HAS ENDED AND THE DAY OWES THE REP A POST (ADR-0016:
   * extraction is cut ahead of the disclosure): no run of the seat's
   * extraction is going and the batch lane is idle; every chat-day of the day
   * is settled — or the extraction's switch is off, so nothing will read
   * them; no attempt at today's post was made; and a line is owed.
   */
  runs_settled_and_disclosure_owed_and_day_unposted: async ({ deps, db, batch, seatId, now }) => {
    if (!batchIsIdle(batch)) return false;
    const extraction = await db.query<{ going: boolean; paused: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM runs r WHERE r.automation_id = a.id AND r.ended_at IS NULL) AS going,
              EXISTS (SELECT 1 FROM automation_pauses p WHERE p.automation_id = a.id AND p.paused) AS paused
         FROM automations a
        WHERE a.twin_id = $1 AND a.seat_id = $2 AND a.shipped = 'extraction' AND a.ended_at IS NULL`,
      [deps.twinId, seatId],
    );
    const row = extraction.rows[0];
    if (row?.going === true) return false;
    if (row?.paused !== true && !(await daySettled(extractionDepsOf(deps, db), now))) return false;
    return await dayOwed(disclosureDepsOf(deps, db), now);
  },

  customer_chat_traffic_overnight: async (ask) => await customerChatTrafficOvernight(ask),
};

/**
 * THE NIGHT LEFT SOMETHING TO BRIEF THE REP ON (ticket #364, for #326's
 * overnight requests): a message in an in-scope customer chat in the night
 * before the morning's instant — from the quiet hours' start the evening
 * before it up to the instant — by the seam's plaintext metadata alone.
 * Whether it asked for anything is the twin's to read; a night with no
 * traffic at all has nothing behind it, so the morning's instant passes with
 * no run and no model call (CONTEXT.md *Precondition*).
 *
 * AND ONLY ON ITS OWN DAY (Codex, on the rebase): the run reads the night
 * before the instant it is told, which is the pass's — so an instant a
 * runtime that was down reaches the next day is not caught up, or the
 * briefing would be of another night than the one this check read.
 */
async function customerChatTrafficOvernight({ deps, db, now, dueAt }: PreconditionAsk): Promise<boolean> {
  const zone = deps.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (civilDate(now, zone) !== civilDate(dueAt, zone)) return false;
  const eveningBefore = civilDate(new Date(dueAt.getTime() - 12 * 3_600_000), zone);
  const from = atLocalHour(eveningBefore, QUIET_HOURS_FROM, zone);
  const res = await db.query(
    `SELECT 1 FROM wa_events e
       JOIN scope_allowlist s ON s.twin_id = e.twin_id
        AND left(e.external_event_id, length(s.chat_jid) + 1) = s.chat_jid || ':'
      WHERE e.twin_id = $1 AND e.event_type = 'message'
        AND e.occurred_at >= $2 AND e.occurred_at < $3
      LIMIT 1`,
    [deps.twinId, from, dueAt],
  );
  return res.rows.length > 0;
}

/**
 * THE PRECONDITIONS WHOSE CADENCE FIRES AGAIN THE SAME DAY while they hold
 * and no run of theirs is going (`fireDueCadences`).
 *
 * THE DAY'S READ, AND ONLY IT: one run claims at most as many chat-days as an
 * `each` makes, so a day with more is read by the next run, as soon as the
 * last has ended — and a chat-day once claimed is settled for the day, so the
 * repeats end when the day is read. The day's post is not here: one attempt a
 * day is its rule (spec #193 decision 10), so its instant fires once.
 */
export const PRECONDITIONS_THAT_REPEAT: ReadonlySet<PreconditionName> = new Set<PreconditionName>([
  "seam_settled_and_chat_day_unsettled",
]);

/** Whether a word names a precondition this build checks. */
export function isPreconditionName(word: string): word is PreconditionName {
  return (PRECONDITION_NAMES as readonly string[]).includes(word);
}
