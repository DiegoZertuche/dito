/**
 * WHICH DAY'S SESSION A WAKE BELONGS TO (ticket #319; spec #318 decision
 * 1; design D3).
 *
 * The twin thread is one Agent SDK session per rep per seat-local day. The day
 * turns at midnight in the rep's zone — the zone the «now» recipe, the
 * arrival's first-visit rule and the exchanges read already cut in, never UTC
 * — and NEVER INSIDE AN EXCHANGE: a wake after midnight whose conversation had
 * a turn end less than ten minutes before stays in that session, and the
 * cut waits for the first wake after a ten-minute gap.
 *
 * A PURE FUNCTION OF THE ZONE, THE INSTANT AND THE LAST TURN'S END, so the
 * rule is one place and its tests are worked examples rather than a clock.
 */
import { civilDate } from "../rep-clock.js";

/**
 * How long the session must have been quiet before a new day cuts it.
 *
 * TEN MINUTES (spec #318 decision 1, Diego's grilling of 2026-10-03): long
 * enough that a rep still answering the twin's last line at 00:03 is in the
 * same exchange, short enough that the night's first wake after a pause opens
 * the new day rather than dragging yesterday into it.
 */
export const CUT_IDLE_MS = 10 * 60_000;

/** The seat-local day of an instant, `YYYY-MM-DD`. */
export function seatDay(at: Date, timeZone: string): string {
  return civilDate(at, timeZone);
}

/**
 * Whether a wake at `now` opens a new day's session rather than joining
 * the open one.
 *
 * `lastTurnEndedAt` IS THE END OF THE OPEN SESSION'S LAST TURN, and with
 * none (a session that has only been opened) there is no exchange to be
 * inside. A conversation with a turn in flight is never cut — that is an
 * exchange by definition — and the caller says so with `busy`.
 */
export function cutsTheDay(args: {
  readonly openDay: string;
  readonly lastTurnEndedAt: Date | undefined;
  readonly now: Date;
  readonly timeZone: string;
  readonly busy: boolean;
}): boolean {
  if (args.busy) return false;
  if (seatDay(args.now, args.timeZone) === args.openDay) return false;
  if (args.lastTurnEndedAt === undefined) return true;
  return args.now.getTime() - args.lastTurnEndedAt.getTime() >= CUT_IDLE_MS;
}
