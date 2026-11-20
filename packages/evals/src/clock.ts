/**
 * THE RUN'S FIXED CLOCK (ticket #56 AC 4: "the run is reproducible").
 *
 * Every transcript is one day — 2026-09-01 in America/Monterrey — and the
 * pass is triggered at 21:30 that evening. A run whose `now` came from the
 * wall clock would read a different window every time and could not be
 * compared with yesterday's number.
 *
 * The rep's own zone, not UTC, because the day is the rep's day (#51) and a
 * corpus keyed on a different midnight is a corpus of different days.
 *
 * It lives in its own module, apart from the harness, for one reason: the
 * corpus's UNIT test has to check its messages against the window, and the
 * harness imports Postgres, the bundle and the twin-runtime. A unit lane
 * that had to load the database stack to ask what time it is would stop
 * being a unit lane.
 */

import { SEAM_SETTLING_LAG_MS } from "@dito/twin-runtime";

/** 2026-09-01T00:00 in America/Monterrey (UTC-6). */
export const DAY_START_UTC = Date.UTC(2026, 8, 1, 6, 0, 0);

export const EVAL_TIME_ZONE = "America/Monterrey";

/** 21:30 on the rep's clock, the same evening — when the pass is triggered. */
export const EVAL_NOW = new Date(DAY_START_UTC + 21.5 * 60 * 60 * 1000);

// WHERE EACH CHAT'S BINDING SITS is no longer a constant here (ticket
// #139). `BOUND_AT` used to be six hours before this day's start — outside
// every window, because every window was this day's. A transcript that
// declares `owedFromDaysAgo` is read from an EARLIER day, and a fixed
// instant would then sit INSIDE it: the ceremony's «buenas» would be a
// beat of the day the model reads. The harness derives the instant from
// each transcript's own window start instead.

/**
 * THE LAST MINUTE OF THE DAY THE PASS WILL ACTUALLY READ.
 *
 * A corpus message after this instant is seeded, never read, and never
 * scored — while the report goes on claiming every message it seeded. The
 * denominator would quietly lose whichever cases somebody wrote late in the
 * day, which are exactly the hard ones, and no run would say so.
 * `corpus.test.ts` refuses such a message in the UNIT lane, so a corpus
 * edit meets it immediately rather than at the next live run.
 *
 * THE WINDOW'S END IS EXCLUSIVE (`occurred_at < window.end`), so the
 * boundary minute itself is NOT read — a fact Codex round 2 caught and the
 * first cut of this constant got wrong by one. `- 1` after the floor, and
 * `clock.test.ts` proves the advertised minute is inside the window and the
 * next one is not.
 *
 * `SEAM_SETTLING_LAG_MS` is IMPORTED from the pass rather than mirrored:
 * round 2 was also right that a copy drifts in the unsafe direction the day
 * the runtime lengthens its lag.
 */
export const LAST_READABLE_MINUTE =
  Math.floor(
    (EVAL_NOW.getTime() - SEAM_SETTLING_LAG_MS - DAY_START_UTC) / 60_000,
  ) - 1;
