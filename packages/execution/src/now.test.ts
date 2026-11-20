/**
 * THE `now` RECIPE (ticket #178; spec #171 decisions 8(3) and 13; user story
 * 19 — "I want the twin to know what day and time it is in my zone, so that
 * «mañana» and «esta semana» mean what I mean"; user story 25 — "I want the
 * owner twin to know today's date, so that «entre el 1 y el 3 de septiembre»
 * is this year's").
 *
 * EVERY INSTANT IS A PARAMETER, never a clock read: nothing in this package
 * calls `new Date()`, so every case below is exact and none of them is
 * flaky on a host in another zone. The rep side's `rep-clock.test.ts` is the
 * other half of the same claim and needs no change — it now exercises this
 * module through a re-export, which is what "one formatter" means here.
 */
import { describe, expect, it } from "vitest";
import {
  finalizedThrough,
  NOW_OWNER_RECIPE,
  NOW_RECIPE,
  renderCivilDay,
  renderTurnHeader,
  renderTurnInstant,
  STANDARD_RECIPES,
} from "./now.js";

const MONTERREY = "America/Monterrey";

/** 2026-09-01 21:30:16 on a Monterrey clock, and #139's own pinned example. */
const TUESDAY_EVENING = new Date("2026-09-02T03:30:16Z");

describe("the turn header is English bracketed metadata (#139's second ruling)", () => {
  it("renders the weekday, the date, the time with seconds and the zone twice over", () => {
    // The whole string, pinned. The abbreviation is ambiguous on its own —
    // CST is Monterrey here and China elsewhere — which is why the IANA name
    // is spelled out once, at the end.
    expect(renderTurnHeader(TUESDAY_EVENING, MONTERREY)).toBe(
      "[Now: Tuesday, Sep 1, 2026, 21:30:16 CST (America/Monterrey)]",
    );
  });

  it("renders the same instant differently in a different zone", () => {
    expect(renderTurnInstant(TUESDAY_EVENING, "America/Los_Angeles")).toBe(
      "Tuesday, Sep 1, 2026, 20:30:16 PDT",
    );
    expect(renderTurnInstant(TUESDAY_EVENING, "UTC")).toBe(
      "Wednesday, Sep 2, 2026, 03:30:16 UTC",
    );
  });

  it("names the day either side of a DST spring-forward", () => {
    // 2026-03-08 is the US spring-forward; Denver goes 01:59 MST → 03:00 MDT.
    // The abbreviation is what moves, and the formatter reads it off the zone
    // rather than computing an offset.
    expect(renderTurnInstant(new Date("2026-03-08T08:30:00Z"), "America/Denver")).toBe(
      "Sunday, Mar 8, 2026, 01:30:00 MST",
    );
    expect(renderTurnInstant(new Date("2026-03-08T09:30:00Z"), "America/Denver")).toBe(
      "Sunday, Mar 8, 2026, 03:30:00 MDT",
    );
  });
});

describe("the edge of what has finalized (FR-69)", () => {
  it("is the instant the lag names, and the reads refuse against the same one", () => {
    // `finalizedThrough` is the ONE computation of the boundary: the owner's
    // reads refuse a window whose start falls after it, and the recipe below
    // describes it. Asked Friday 2026-09-04 at 18:30 Monterrey, 24 hours
    // back is Thursday the 3rd at 18:30.
    const asked = new Date("2026-09-05T00:30:00Z");
    expect(finalizedThrough(asked, 24).toISOString()).toBe(
      "2026-09-04T00:30:00.000Z",
    );
    expect(renderCivilDay(finalizedThrough(asked, 24), MONTERREY)).toBe(
      "Thursday, Sep 3, 2026",
    );
  });
});

describe("`now`, rendered as a named part", () => {
  const at = TUESDAY_EVENING;

  it("takes an instant and a zone, and renders the turn header", () => {
    const part = STANDARD_RECIPES[NOW_RECIPE]!.create(undefined)({ at, timeZone: MONTERREY });
    expect(part).toEqual({
      name: "now",
      text: "[Now: Tuesday, Sep 1, 2026, 21:30:16 CST (America/Monterrey)]",
    });
  });

  it("declares exactly the two parameters the occasion binds", () => {
    expect(STANDARD_RECIPES[NOW_RECIPE]!.parameters).toEqual({
      at: "instant",
      timeZone: "zone",
    });
  });

  it("is byte-identical to what the rep side's turn header renders", () => {
    // ONE FORMATTER, and this is the assertion that says so at the value
    // level as well as at the import level: the extraction turn's header and
    // every automation's `now` part are the same bytes for the same instant,
    // which was #139's founding complaint about two renderings that could
    // disagree about a date.
    expect(STANDARD_RECIPES[NOW_RECIPE]!.create(undefined)({ at, timeZone: MONTERREY }).text).toBe(
      renderTurnHeader(at, MONTERREY),
    );
  });
});

describe("`now_owner`, which adds the one line the owner side needs", () => {
  const asked = new Date("2026-09-05T00:30:00Z");

  it("renders the turn header first and the window's edge after it", () => {
    const part = STANDARD_RECIPES[NOW_OWNER_RECIPE]!.create(undefined)({
      at: asked,
      timeZone: MONTERREY,
      lagHours: 24,
    });
    expect(part.name).toBe("now");
    const [first, ...rest] = part.text.split("\n");
    expect(first).toBe(renderTurnHeader(asked, MONTERREY));
    // THE LAST WHOLLY FINALIZED DAY, NOT THE BOUNDARY'S OWN DAY (Codex r3).
    // Asked Friday 18:30, the boundary is Thursday 18:30 — so Thursday is
    // only PARTLY readable and a `from` of Thursday 20:00 would be refused
    // by the very reads this line exists to keep the model out of trouble
    // with. Wednesday is the last day every instant of which is readable,
    // which is also the ticket's own definition: "the latest calendar day
    // whose facts are finalized".
    expect(rest.join("\n")).toContain("Wednesday, Sep 2, 2026");
    expect(rest.join("\n")).not.toContain("Sep 3");
  });

  it("never names a day the reads would refuse a window inside (Codex r3)", () => {
    // THE AGREEMENT, ASSERTED RATHER THAN ARGUED. The rendered day must sit
    // strictly before the calendar day the boundary falls in — which is what
    // makes "every instant of it is at or before the boundary" true, and
    // therefore makes the sentence and the refusal say the same thing.
    // Walked across a whole local day, an hour at a time, so the local
    // midnight roll is inside the sweep rather than beside it.
    const zone = MONTERREY;
    const civilDay = (at: Date) =>
      new Intl.DateTimeFormat("en-CA", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        timeZone: zone,
      }).format(at);
    for (let hour = 0; hour < 26; hour += 1) {
      const at = new Date(Date.UTC(2026, 8, 4, hour, 30, 0));
      const rendered = STANDARD_RECIPES[NOW_OWNER_RECIPE]!.create(undefined)({
        at,
        timeZone: zone,
        lagHours: 24,
      }).text;
      const boundaryDay = civilDay(finalizedThrough(at, 24));
      // The named day, read back out of the line as a date `Intl` agrees on.
      const named = /Finalized through: (\w+, \w+ \d+, \d{4})\./u.exec(rendered)![1]!;
      const namedDay = new Intl.DateTimeFormat("en-CA", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        timeZone: "UTC",
      }).format(new Date(`${named} 00:00:00 UTC`));
      expect(namedDay < boundaryDay, `${named} vs boundary ${boundaryDay}`).toBe(
        true,
      );
    }
  });

  it("crosses a month and a year on the owner's clock, not on UTC's", () => {
    // 2027-01-01 05:30Z is still New Year's Eve in Monterrey, so a 24-hour
    // lag lands on the 30th of December and the last whole day is the 29th —
    // the case a UTC-shaped answer would get wrong by a day and a year.
    expect(
      STANDARD_RECIPES[NOW_OWNER_RECIPE]!.create(undefined)({
        at: new Date("2027-01-01T05:30:00Z"),
        timeZone: MONTERREY,
        lagHours: 24,
      }).text,
    ).toContain("Tuesday, Dec 29, 2026");
  });

  it("keeps the header identical to the rep side's, so only the extra line differs", () => {
    const owner = STANDARD_RECIPES[NOW_OWNER_RECIPE]!.create(undefined)({
      at: asked,
      timeZone: MONTERREY,
      lagHours: 24,
    }).text;
    const rep = STANDARD_RECIPES[NOW_RECIPE]!.create(undefined)({
      at: asked,
      timeZone: MONTERREY,
    }).text;
    expect(owner.startsWith(`${rep}\n`)).toBe(true);
  });

  it("declares the lag as a parameter, so no package restates 24 (spec #171 decision 13)", () => {
    // The lag is the owner side's number (`OWNER_LAG_HOURS`, argued at FR-69
    // in `@dito/owner-twin`) and it arrives as a bound value. A 24 written
    // into this package would be the second copy of a constant whose whole
    // point is that the refusal and the sentence agree.
    expect(STANDARD_RECIPES[NOW_OWNER_RECIPE]!.parameters).toEqual({
      at: "instant",
      timeZone: "zone",
      lagHours: "hours",
    });
    const withEight = STANDARD_RECIPES[NOW_OWNER_RECIPE]!.create(undefined)({
      at: asked,
      timeZone: MONTERREY,
      lagHours: 8,
    }).text;
    // Eight hours back from Friday 18:30 is still Friday, so the last whole
    // day is Thursday — a day later than the 24-hour lag reports, which is
    // the whole of what a bound lag buys.
    expect(withEight).toContain("Thursday, Sep 3, 2026");
  });

  it("says nothing about what is inside the window (FR-69)", () => {
    // The one thing the line must never do. FR-69: "not that it is empty,
    // not that it is quiet, not that there is nothing new." The line names
    // the EDGE and nothing about the region past it.
    const text = STANDARD_RECIPES[NOW_OWNER_RECIPE]!.create(undefined)({
      at: asked,
      timeZone: MONTERREY,
      lagHours: 24,
    }).text;
    expect(text).not.toMatch(/empty|nothing|quiet|no facts/iu);
  });
});
