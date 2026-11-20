/**
 * The instant a person types (ticket #67).
 *
 * `parseIsoInstant` is the rig's steering override read from a shell, and
 * it exists because both ways of typing a day wrong are SILENT: a zoneless
 * string keys the wrong civil day, and `new Date` rolls an impossible day
 * over into the next month without complaint. A steering session that runs
 * a day it never asked for is exactly the failure ticket #67 exists to
 * remove, so the parser is checked here rather than discovered on a phone.
 */
import { describe, expect, it } from "vitest";
import {
  atLocalHour,
  isLaterRepDay,
  localHour,
  parseIsoInstant,
  renderTurnHeader,
  renderTurnInstant,
} from "./rep-clock.js";

const ZONE = "America/Monterrey";

describe("reading an instant a person typed", () => {
  it("takes an ISO-8601 instant whose offset is spelled out", () => {
    expect(parseIsoInstant("2026-08-31T21:30:00-06:00")?.toISOString()).toBe(
      "2026-09-01T03:30:00.000Z",
    );
    expect(parseIsoInstant("2026-08-31T21:30:00Z")?.toISOString()).toBe(
      "2026-08-31T21:30:00.000Z",
    );
    expect(parseIsoInstant("2026-08-31T21:30Z")?.toISOString()).toBe(
      "2026-08-31T21:30:00.000Z",
    );
  });

  it("takes what `new Date().toISOString()` produces — the string an operator pastes", () => {
    const now = new Date("2026-08-31T21:30:00.123Z");
    expect(parseIsoInstant(now.toISOString())?.toISOString()).toBe(
      now.toISOString(),
    );
  });

  it("refuses a day with no zone in it — `2026-08-31` is the 30th in Monterrey, and nothing downstream would say so", () => {
    expect(parseIsoInstant("2026-08-31")).toBeUndefined();
    expect(parseIsoInstant("2026-08-31T21:30:00")).toBeUndefined();
  });

  it("refuses an impossible day rather than rolling it over — a typo must fail, not succeed at the wrong time", () => {
    // `new Date` reads every one of these and answers with another day.
    expect(new Date("2026-02-30T21:30:00Z").toISOString()).toBe(
      "2026-03-02T21:30:00.000Z",
    );
    expect(parseIsoInstant("2026-02-30T21:30:00Z")).toBeUndefined();
    expect(parseIsoInstant("2026-04-31T21:30:00-06:00")).toBeUndefined();
    expect(parseIsoInstant("2026-08-00T21:30:00Z")).toBeUndefined();
    expect(parseIsoInstant("2026-00-15T21:30:00Z")).toBeUndefined();
  });

  it("keeps the leap day that really exists, and refuses the one that does not", () => {
    expect(parseIsoInstant("2028-02-29T21:30:00Z")?.toISOString()).toBe(
      "2028-02-29T21:30:00.000Z",
    );
    expect(parseIsoInstant("2026-02-29T21:30:00Z")).toBeUndefined();
  });

  it("refuses anything that is not an instant at all", () => {
    for (const raw of ["", "tomorrow", "1756692600", "2026-13-01T21:30:00Z"]) {
      expect(parseIsoInstant(raw)).toBeUndefined();
    }
  });
});

/**
 * The rule the rig's disclosure trigger enforces (ticket #67, Codex r2):
 * a steering override may move extraction and the correction window as far
 * ahead as a session needs, but a disclosure post is keyed `(twin, day)`
 * and posting tomorrow's account today IS the post tomorrow gets. It lives
 * here rather than inside the script so that "which day has the rep lived"
 * is asked once, on their own calendar.
 */
describe("a day the rep has not lived yet", () => {
  it("is later when the rep's own calendar says so", () => {
    // 21:30 on the 30th against 21:30 on the 29th, both Monterrey.
    expect(
      isLaterRepDay(
        new Date("2026-08-31T03:30:00Z"),
        new Date("2026-08-30T03:30:00Z"),
        ZONE,
      ),
    ).toBe(true);
  });

  it("is not later within one rep day, however many hours apart", () => {
    // 07:00 and 23:30 on the 29th: the same day the rep is living.
    expect(
      isLaterRepDay(
        new Date("2026-08-30T05:30:00Z"),
        new Date("2026-08-29T13:00:00Z"),
        ZONE,
      ),
    ).toBe(false);
  });

  it("asks on the REP's calendar, not on UTC's", () => {
    // 05:30Z is the 30th in UTC and still the 29th in Monterrey, so a
    // trigger reading UTC would refuse an instant the rep is living in.
    const stillThe29th = new Date("2026-08-30T05:30:00Z");
    const earlierThe29th = new Date("2026-08-29T20:00:00Z");
    expect(isLaterRepDay(stillThe29th, earlierThe29th, ZONE)).toBe(false);
    expect(isLaterRepDay(stillThe29th, earlierThe29th, "UTC")).toBe(true);
  });

  it("is not later when the steered instant is behind the real one", () => {
    expect(
      isLaterRepDay(
        new Date("2026-08-29T03:30:00Z"),
        new Date("2026-08-30T03:30:00Z"),
        ZONE,
      ),
    ).toBe(false);
  });
});

/**
 * THE TURN'S METADATA, SPELLED OUT FOR THE MODEL (tickets #121 and #139).
 *
 * Every expectation here is a literal read off a calendar and a clock,
 * never rendered by the code under test: 1 September 2026 is a Tuesday, 30
 * August a Sunday, 31 August a Monday, 8 March 2026 a Sunday.
 *
 * IN ENGLISH, IN BRACKETS, AND THAT IS THE CLAIM. The first cut of #139
 * wrote this framing in Spanish, over a Spanish conversation, and the
 * model echoed the weekday word it was shown — «el lunes» said on the
 * run's own day came back as the Tuesday a week out. Nothing code writes
 * into the turn is speech-shaped now, and a Spanish weekday appears
 * nowhere except inside a message.
 */
describe("the instant the model reads", () => {
  it("names the weekday, the date, the time to the second and the zone", () => {
    // 21:30:16 on Tuesday 1 September in Monterrey — the pass's own hour.
    expect(
      renderTurnInstant(new Date("2026-09-02T03:30:16Z"), ZONE),
    ).toBe("Tuesday, Sep 1, 2026, 21:30:16 CST");
  });

  /**
   * THE MIDNIGHT BOUNDARY, IN BOTH DIRECTIONS. 20:30 on a Sunday in
   * Monterrey (UTC-6) is already 02:30 MONDAY in UTC — the beat #121 left
   * stamped a day ahead of the line above it — and the same instant is
   * 19:30 the Sunday in Los Angeles (UTC-7).
   */
  it("is the rep's own day at an instant UTC already calls the next one", () => {
    const at = new Date("2026-08-31T02:30:00Z");
    expect(renderTurnInstant(at, ZONE)).toBe(
      "Sunday, Aug 30, 2026, 20:30:00 CST",
    );
    expect(renderTurnInstant(at, "America/Los_Angeles")).toBe(
      "Sunday, Aug 30, 2026, 19:30:00 PDT",
    );
    expect(renderTurnInstant(at, "UTC")).toBe(
      "Monday, Aug 31, 2026, 02:30:00 UTC",
    );
  });

  it("follows a zone across a DST spring-forward, abbreviation and all", () => {
    // Denver moves to UTC-6 at 02:00 local on Sunday 8 March 2026, which
    // is 09:00 UTC. Half an hour either side of that instant:
    expect(
      renderTurnInstant(new Date("2026-03-08T08:30:00Z"), "America/Denver"),
    ).toBe("Sunday, Mar 8, 2026, 01:30:00 MST");
    expect(
      renderTurnInstant(new Date("2026-03-08T09:30:00Z"), "America/Denver"),
    ).toBe("Sunday, Mar 8, 2026, 03:30:00 MDT");
  });
});

/**
 * THE TURN'S FIRST LINE (ticket #139, second ruling).
 *
 * It replaced #121's «Hoy es martes 1 de septiembre de 2026
 * (America/Monterrey).» — prose, in the conversation's own language, one
 * line above a transcript of people talking.
 */
describe("the turn's metadata header", () => {
  it("is the instant, bracketed, with the IANA zone spelled out once", () => {
    expect(
      renderTurnHeader(parseIsoInstant("2026-09-01T21:30:16-06:00")!, ZONE),
    ).toBe("[Now: Tuesday, Sep 1, 2026, 21:30:16 CST (America/Monterrey)]");
  });

  it("carries the hour the pass actually ran at, on the rep's clock", () => {
    // Ten past midnight on the day after — «mañana» said at 23:50 and read
    // here is a different day, and the header is what says so.
    expect(
      renderTurnHeader(parseIsoInstant("2026-09-02T00:10:00-06:00")!, ZONE),
    ).toBe("[Now: Wednesday, Sep 2, 2026, 00:10:00 CST (America/Monterrey)]");
  });

  it("is the REP's day at an instant UTC already calls tomorrow", () => {
    // 21:00 Tuesday in Los Angeles is 04:00 Wednesday in UTC. A header cut
    // from the instant rather than the rep's clock would say Wednesday and
    // move every «el lunes» a week.
    expect(
      renderTurnHeader(new Date("2026-09-02T04:00:00Z"), "America/Los_Angeles"),
    ).toBe("[Now: Tuesday, Sep 1, 2026, 21:00:00 PDT (America/Los_Angeles)]");
  });

  it("names the zone it actually rendered in when the caller pinned none", () => {
    // `timeZone` is optional across this module — unset means the host
    // clock — so the header must say which zone that resolved to rather
    // than print «(undefined)» or claim one it did not use.
    const at = new Date("2026-09-01T18:00:00Z");
    const host = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(renderTurnHeader(at)).toContain(`(${host})]`);
    expect(renderTurnHeader(at)).toBe(renderTurnHeader(at, host));
  });
});

describe("an hour of a civil day on the rep's clock (ticket #364, Codex r2)", () => {
  it("lands on the hour the clock shows, on the days a DST change makes 23 and 25 hours long", () => {
    // TIJUANA KEEPS DST: 1 November 2026 falls back, 8 March 2026 springs forward.
    const zone = "America/Tijuana";
    for (const day of ["2026-11-01", "2026-03-08", "2026-10-08"]) {
      for (const hour of [8, 22]) {
        const at = atLocalHour(day, hour, zone);
        expect(localHour(at, zone), `${day} ${String(hour)}`).toBe(hour);
      }
    }
    expect(atLocalHour("2026-11-01", 8, zone).toISOString()).toBe("2026-11-01T16:00:00.000Z");
    expect(atLocalHour("2026-03-08", 8, zone).toISOString()).toBe("2026-03-08T15:00:00.000Z");
    expect(atLocalHour("2026-10-08", 8, ZONE).toISOString()).toBe("2026-10-08T14:00:00.000Z");
  });
});

