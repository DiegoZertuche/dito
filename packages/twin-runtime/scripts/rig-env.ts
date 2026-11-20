/**
 * The rig's shared composition settings (ticket #51, Codex r1).
 *
 * The daily disclosure keys its idempotence on THE REP'S CALENDAR DAY, so
 * the day has to be the same value whichever process derives it. The
 * scheduled runner (`rig-run.ts`) and the hand trigger
 * (`rig-disclose.ts`) are two processes with two ambient environments; if
 * they disagreed about the zone they would key one rep day as two and post
 * the rep's account of what crossed twice, straight past the
 * `(twin, day)` unique index. So the zone is read once, here, and both
 * roots call this.
 *
 * TICKET #67 ADDS THE CLOCK ITSELF, for the same reason and read the same
 * way. A steering session drives extraction, the disclosure and the
 * correction window by hand, and those three passes must not disagree
 * about what day it is — so the instant is ONE value from ONE variable,
 * read here, and every hand trigger takes it from this function.
 */
import { parseIsoInstant } from "../dist/index.js";

/**
 * The rep's IANA time zone. `DITO_TIME_ZONE` when set, otherwise the
 * host's own resolved zone — resolved rather than left undefined, so what
 * the two processes agree on is a VALUE, not a shared default that a
 * changed `TZ` could silently split.
 */
export function repTimeZone(): string {
  const configured = process.env["DITO_TIME_ZONE"];
  if (configured !== undefined && configured !== "") return configured;
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * The hour of the rep's day at which the scheduled disclosure may post
 * (`DITO_DISCLOSURE_HOUR`). Undefined leaves the runtime's own default.
 * A steering session that wants the post earlier can set it — or just use
 * the hand trigger, which ignores the clock entirely.
 */
export function disclosureHourFromEnv(): number | undefined {
  const raw = process.env["DITO_DISCLOSURE_HOUR"];
  if (raw === undefined || raw === "") return undefined;
  const hour = Number(raw);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new Error(
      `DITO_DISCLOSURE_HOUR must be an hour of the day, 0–23 — got ${JSON.stringify(raw)}`,
    );
  }
  return hour;
}

/**
 * The clock a hand-driven pass runs on (ticket #67).
 *
 * TWO INSTANTS, because a steering session moves one of them and must
 * never move the other. `now` is the REP'S clock — what day it is, whether
 * the settle hour has passed, when a question expires, when a correction
 * window closes — and `DITO_RIG_NOW` moves it. `seamNow` is the real
 * instant, which nothing moves: it is what the extraction pass writes as
 * its watermark, because `wa_events.occurred_at` is stamped by the plane
 * as messages actually arrive.
 *
 * #57 found out what happens when those are one value. The rig was driven
 * with `now` about 16 hours ahead, the watermark went with it, and every
 * genuinely new message then landed BEHIND the watermark where no later
 * window would ever reach it. The rig went deaf after a single injected
 * run and had to be repaired by hand.
 */
export interface RigClock {
  /** What the passes call now. */
  readonly now: Date;
  /** The real instant. The override never moves this. */
  readonly seamNow: Date;
  /** Whether `DITO_RIG_NOW` moved the clock at all. */
  readonly steered: boolean;
}

export function rigClock(): RigClock {
  const seamNow = new Date();
  const raw = process.env["DITO_RIG_NOW"];
  if (raw === undefined || raw === "") {
    // INERT unless explicitly set: the two instants are the same one, and
    // every pass behaves exactly as the scheduled runtime does.
    return { now: seamNow, seamNow, steered: false };
  }
  // Read by the RUNTIME's own clock module rather than parsed here — one
  // rule about what a day is, refusing a zoneless string and an impossible
  // calendar day, both of which key a session to a day nobody typed.
  const now = parseIsoInstant(raw);
  if (now === undefined) {
    throw new Error(
      `DITO_RIG_NOW must be an ISO-8601 instant with an explicit offset and a real calendar day, e.g. 2026-08-31T21:30:00-06:00 — got ${JSON.stringify(raw)}`,
    );
  }
  return { now, seamNow, steered: true };
}

/**
 * One line saying which clock this run is on, so a steering session's
 * transcript records what it was pretending — and so a forgotten
 * `DITO_RIG_NOW` is visible in the very first line of output rather than
 * three confusing runs later.
 */
export function describeRigClock(clock: RigClock, timeZone: string): string {
  const shown = (at: Date): string =>
    at.toLocaleString("en-CA", { timeZone, hour12: false });
  return clock.steered
    ? `STEERED to ${shown(clock.now)} (${timeZone}); the seam is really at ${shown(clock.seamNow)}`
    : `${shown(clock.now)} (${timeZone})`;
}
