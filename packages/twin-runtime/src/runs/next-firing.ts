/**
 * WHEN A CADENCE FIRES NEXT (tickets #386, #387): the clock's own arithmetic
 * (`wakes.ts`), said forward, in a module of its own so a reader of a rutina —
 * the tool that writes one, a card that shows one — reaches it without the
 * clock's.
 *
 * A CADENCE IS A SET OF WEEKDAYS AT AN HOUR: a weekly one names its set, a
 * daily one is all seven. Both directions cut one candidate per weekday of the
 * set in the seat's zone — the clock the latest at or before now, this the
 * first at or after `from` — so the two never disagree about which days a
 * cadence has. Each candidate is made an instant before it is compared, so a
 * night the clocks go back never fires an hour early nor skips it.
 */
import type pg from "pg";
import { readRutina } from "./rutinas.js";

/** A cadence as the clock reads it: daily, or weekly on a set of ISO weekdays (1 = Monday), at a whole hour. */
export interface Cadence {
  readonly every: "day" | "week";
  readonly weekdays?: readonly number[];
  readonly atHour: number;
}

/**
 * The weekdays a cadence fires on, as a SQL `smallint[]` over two expressions
 * naming its `every` and its `weekdays`: the set on a weekly cadence, all seven
 * on a daily one.
 */
export function cadenceWeekdaysSql(every: string, weekdays: string): string {
  return `(CASE WHEN ${every} = 'week' THEN ${weekdays} ELSE ARRAY[1, 2, 3, 4, 5, 6, 7]::smallint[] END)`;
}

/**
 * THE FIRST INSTANT A CADENCE FIRES AT OR AFTER `from` (tickets #386, #387),
 * cut in the seat's zone the way `fireDueCadences` cuts its instants: for each
 * weekday of the set, that weekday's hour this week, or next week's when that
 * is already behind `from`, and the nearest of them. The clock fires an
 * instant at or after a rutina's activation and no earlier, so from the
 * instant it was activated this is the first one it fires — what the twin is
 * told when a rutina goes live at the ask — and from now it is the next one,
 * what Rutinas says beside «Próxima vez».
 */
export async function firstFiringAtOrAfter(
  db: pg.ClientBase,
  cadence: Cadence,
  from: Date,
  zone: string,
): Promise<Date> {
  const rows = await db.query<{ at: Date }>(
    `WITH here AS (SELECT ($1::timestamptz AT TIME ZONE $2) AS t)
     SELECT min(CASE WHEN (c.candidate AT TIME ZONE $2) < $1::timestamptz
                     THEN (c.candidate + interval '7 days') AT TIME ZONE $2
                     ELSE c.candidate AT TIME ZONE $2 END) AS at
       FROM here
       CROSS JOIN unnest(${cadenceWeekdaysSql("$3", "$4::smallint[]")}) AS w(d)
       CROSS JOIN LATERAL (
         SELECT (here.t::date + (w.d - extract(isodow FROM here.t)::int + 7) % 7)
                + make_time($5::int, 0, 0) AS candidate) c`,
    [from, zone, cadence.every, cadence.weekdays ?? null, cadence.atHour],
  );
  return rows.rows[0]!.at;
}

/**
 * The first instant an active rutina on a cadence fires, from the instant it
 * was activated — or nothing, for one an event wakes or one not active.
 */
export async function firstFiringOf(
  db: pg.ClientBase,
  args: { readonly twinId: string; readonly id: string; readonly zone: string },
): Promise<Date | undefined> {
  const rutina = await readRutina(db, args.twinId, args.id);
  if (rutina === undefined || rutina.activatedAt === null || rutina.wake.kind !== "schedule") return undefined;
  return await firstFiringAtOrAfter(db, rutina.wake, rutina.activatedAt, args.zone);
}
