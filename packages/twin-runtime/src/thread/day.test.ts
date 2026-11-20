/**
 * THE DAY CUT, AS A RULE OF THE ZONE, THE INSTANT AND THE LAST TURN'S END
 * (ticket #319; spec #318 decision 1). Worked examples on the rig's own zone.
 */
import { describe, expect, it } from "vitest";
import { CUT_IDLE_MS, cutsTheDay, seatDay } from "./day.js";

const ZONE = "America/Monterrey";

/** An instant on Monterrey's clock (UTC−6, no daylight saving). */
function local(day: string, time: string): Date {
  return new Date(`${day}T${time}-06:00`);
}

describe("the day turns at midnight on the seat's clock", () => {
  it("names the seat-local day, not UTC's", () => {
    // 23:30 in Monterrey is already the next day in UTC.
    expect(seatDay(local("2026-10-02", "23:30:00"), ZONE)).toBe("2026-10-02");
    expect(seatDay(local("2026-10-03", "00:10:00"), ZONE)).toBe("2026-10-03");
  });
});

describe("a wake after midnight opens a new day only after a ten-minute gap", () => {
  const open = { openDay: "2026-10-02", timeZone: ZONE, busy: false };

  it("cuts when the day has turned and the conversation has been quiet ten minutes", () => {
    expect(
      cutsTheDay({
        ...open,
        lastTurnEndedAt: local("2026-10-02", "23:40:00"),
        now: local("2026-10-03", "08:00:00"),
      }),
    ).toBe(true);
  });

  it("does not cut inside an exchange that runs past midnight", () => {
    expect(
      cutsTheDay({
        ...open,
        lastTurnEndedAt: local("2026-10-02", "23:58:00"),
        now: local("2026-10-03", "00:03:00"),
      }),
    ).toBe(false);
  });

  it("cuts at exactly ten minutes and not a second before", () => {
    const last = local("2026-10-02", "23:55:00");
    expect(
      cutsTheDay({ ...open, lastTurnEndedAt: last, now: new Date(last.getTime() + CUT_IDLE_MS - 1000) }),
    ).toBe(false);
    expect(
      cutsTheDay({ ...open, lastTurnEndedAt: last, now: new Date(last.getTime() + CUT_IDLE_MS) }),
    ).toBe(true);
  });

  it("never cuts the day it is still on, however quiet", () => {
    expect(
      cutsTheDay({
        ...open,
        lastTurnEndedAt: local("2026-10-02", "08:00:00"),
        now: local("2026-10-02", "23:59:00"),
      }),
    ).toBe(false);
  });

  it("never cuts a conversation with a turn in flight", () => {
    expect(
      cutsTheDay({
        ...open,
        busy: true,
        lastTurnEndedAt: local("2026-10-02", "20:00:00"),
        now: local("2026-10-03", "09:00:00"),
      }),
    ).toBe(false);
  });

  it("cuts a conversation that never had a turn as soon as the day turns", () => {
    expect(
      cutsTheDay({ ...open, lastTurnEndedAt: undefined, now: local("2026-10-03", "00:01:00") }),
    ).toBe(true);
  });

  it("reads midnight in the zone it is given, never UTC's", () => {
    // 19:00 in Monterrey is 01:00 UTC the next day: no cut on the seat's clock.
    expect(
      cutsTheDay({
        ...open,
        lastTurnEndedAt: local("2026-10-02", "17:00:00"),
        now: local("2026-10-02", "19:00:00"),
      }),
    ).toBe(false);
  });
});
