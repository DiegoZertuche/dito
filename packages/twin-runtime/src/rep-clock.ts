/**
 * The rep's own clock (tickets #51 and #52; ADR-0004, ADR-0016).
 *
 * The day's two cadences read it — extraction and the disclosure — and
 * ADR-0016 says extraction is cut AHEAD of the disclosure. That ordering only holds
 * if both agree about what "the day" is and when its evening starts, so
 * they share this module rather than each carrying a copy: a copy is
 * shared until it drifts, and the drift here is a disclosure posted before
 * its own day's facts exist.
 *
 * Everything takes an explicit instant — the `reconcileFr70At` shape, no
 * clock seam — and an optional IANA zone. Unset means the host clock,
 * which is what the rig runs on when `DITO_TIME_ZONE` is absent.
 */
import { civilDate } from "./grammar.js";

/**
 * The hour of the rep's day, 0–23, at which the day's read and its post are
 * due: after the working day, before the rep is asleep.
 */
export const DEFAULT_DISCLOSURE_HOUR = 21;

/** The hour on the rep's own clock, 0–23. */
export function localHour(at: Date, timeZone?: string): number {
  return Number(
    new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      hourCycle: "h23",
      ...(timeZone === undefined ? {} : { timeZone }),
    }).format(at),
  );
}

/**
 * The instant a civil day begins on the rep's clock.
 *
 * Both edges of an extraction window are computed this way — midnight of
 * the day and midnight of the next — rather than as "start plus 24 hours",
 * so a day that DST makes 23 or 25 hours long is still exactly the rep's
 * day.
 *
 * The one-step correction is exact except inside a DST spring-forward gap,
 * where local midnight does not exist; there the window starts at the
 * instant the clock jumps to, which is the whole of that day's traffic
 * anyway.
 */
export function startOfCivilDay(day: string, timeZone?: string): Date {
  const asUtc = Date.parse(`${day}T00:00:00Z`);
  const shown = Date.parse(`${civilDateTime(new Date(asUtc), timeZone)}Z`);
  return new Date(asUtc + (asUtc - shown));
}

/**
 * The instant a civil day's clock reads `hour`:00 in the zone — read off the
 * zone's own offset at that hour, so a day a DST change shortens or lengthens
 * still lands on the hour the rep's clock shows.
 */
export function atLocalHour(day: string, hour: number, timeZone?: string): Date {
  const wanted = Date.parse(`${day}T${String(hour).padStart(2, "0")}:00:00Z`);
  const shownAt = (at: number): number => Date.parse(`${civilDateTime(new Date(at), timeZone)}Z`);
  // TWICE: the first guess carries the offset at the wrong side of a change,
  // the second the offset at the hour itself.
  const first = wanted + (wanted - shownAt(wanted));
  return new Date(first + (wanted - shownAt(first)));
}

/**
 * How far back any daily window may reach, as an instant before `dayStart`.
 *
 * Seven days, anchored rather than invented: FR-32 expires an unanswered
 * question in about a week, and the thing a chat waits on before it can be
 * extracted at all is slice 2's binding proposal — so a chat that has owed
 * its extraction for longer than that has effectively had its ending.
 * Beyond it, reading a chat's history in one pass is a BACKFILL, and
 * backfill is out of scope (spec #48 decision 13).
 */
const MAX_LOOKBACK_MS = 7 * 86_400_000;

/** The floor under a window's start: nothing reaches further back than this. */
export function earliestWindowStart(dayStart: Date): Date {
  return new Date(dayStart.getTime() - MAX_LOOKBACK_MS);
}

/** The rep's calendar day at an instant, as `YYYY-MM-DD`. */
export { civilDate };

/**
 * THE TURN'S FIRST LINE AND THE STAMP ON EVERY BEAT — moved to
 * `@dito/execution` at ticket #178, re-exported here.
 *
 * WHY THEY MOVED AND WHY THIS LINE IS ALL THAT IS LEFT. Every automation is
 * now handed a code-rendered «now» as a standard context recipe (spec #171
 * decision 8(3); ADR-0014 as amended), and the owner side is the first
 * consumer outside this package — so the formatter had to live somewhere
 * both apps can reach, and only `@dito/execution` is that place: it holds no
 * connection, no key and no credential, which is what makes it importable
 * from either side of the wall. The dependency runs the only way the wall
 * allows, `twin-runtime` → `execution`.
 *
 * A SECOND COPY WITH A BYTE-IDENTITY TEST WAS THE ALTERNATIVE AND IT WAS
 * REFUSED. #139's founding complaint was two renderings of one instant that
 * could disagree about a date; a test proving today's two copies agree is
 * not the same claim as there being one. Everything here — `extraction.ts`'s
 * header and its per-beat stamps, `rep-clock.test.ts`, the eval corpus's
 * pinned labels — now reads the same function the owner twin does, and the
 * argument for its shape rides with it.
 */
export { renderTurnHeader, renderTurnInstant } from "@dito/execution";

/**
 * `2026-08-31T21:30:00-06:00` — an ISO-8601 instant with its offset spelled
 * out and its calendar real. Fractional seconds allowed, because
 * `new Date().toISOString()` is what an operator pastes.
 */
const ISO_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * READS AN INSTANT A PERSON TYPED, AND REFUSES THE TWO WAYS OF TYPING IT
 * WRONG (ticket #67).
 *
 * The rig's steering override is a day typed into a shell, and both
 * mistakes below key a whole session to a day nobody meant:
 *
 *   NO OFFSET. `2026-08-31` parses as UTC midnight, which is the 30th on a
 *   Monterrey clock. The zone belongs in the string, not in the reader.
 *
 *   AN IMPOSSIBLE DAY. `new Date` rolls one over in silence —
 *   `2026-02-30T21:30:00Z` becomes the 2nd of March — so a typo does not
 *   fail, it succeeds at the wrong time, and nothing downstream can tell.
 *
 * Both are refused rather than guessed at: "the passes cannot disagree
 * about the day" is worth nothing if the day itself is a typo.
 *
 * Returns undefined rather than throwing, because the caller is the only
 * one that knows which setting the value came from — and naming it is what
 * makes the error actionable.
 */
export function parseIsoInstant(raw: string): Date | undefined {
  const parts = ISO_INSTANT.exec(raw);
  if (parts === null) return undefined;
  const at = new Date(raw);
  if (Number.isNaN(at.getTime())) return undefined;
  const [, year, month, day] = parts;
  const monthOfYear = Number(month);
  if (monthOfYear < 1 || monthOfYear > 12) return undefined;
  // Day zero of the NEXT month is the last day of this one.
  const lastDayOfMonth = new Date(
    Date.UTC(Number(year), monthOfYear, 0),
  ).getUTCDate();
  const dayOfMonth = Number(day);
  if (dayOfMonth < 1 || dayOfMonth > lastDayOfMonth) return undefined;
  return at;
}

/**
 * Whether `at` falls on a LATER rep day than `than` — a day the rep has
 * not lived through yet (ticket #67).
 *
 * The rig's disclosure trigger is the one caller: a steering override may
 * move extraction and the correction window as far ahead as a session
 * needs, but a disclosure post is keyed `(twin, day)` and is a statement
 * made to a person. Posting tomorrow's account today would BE the post
 * tomorrow gets, and the scheduled pass would then say nothing on a real
 * day the rep had traffic.
 *
 * On the rep's own calendar, never on UTC's: 05:30Z is still yesterday in
 * Monterrey, and a rule about which day a person has lived has to be asked
 * on their clock. `YYYY-MM-DD` compares as a date, which is the whole
 * reason the stored key is one.
 */
export function isLaterRepDay(at: Date, than: Date, timeZone?: string): boolean {
  return civilDate(at, timeZone) > civilDate(than, timeZone);
}

/** `YYYY-MM-DDTHH:mm:ss` as the given zone shows an instant. */
function civilDateTime(at: Date, timeZone?: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    ...(timeZone === undefined ? {} : { timeZone }),
  }).formatToParts(at);
  const get = (type: string): string =>
    parts.find((p) => p.type === type)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}`;
}
