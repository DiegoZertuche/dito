/**
 * WHEN A CARD'S REMINDER IS DUE, on the rep's clock (ticket #364, Codex r2):
 * never inside the quiet hours, on the days a DST change moves the clock too.
 */
import { describe, expect, it } from "vitest";
import { localHour } from "../rep-clock.js";
import { inQuietHours, outOfQuietHours, reminderOf } from "./reminder-rows.js";

const ZONE = "America/Tijuana";

describe("a reminder is never due inside the quiet hours", () => {
  it("wakes a draft at eight the next morning, the morning the clock falls back included", () => {
    // 31 October 2026, 20:00 in Tijuana (PDT); the clock falls back that night.
    const posted = new Date("2026-11-01T03:00:00.000Z");
    const reminder = reminderOf([{ kind: "draft" } as never], posted, ZONE);
    expect(reminder?.subject).toBe("draft_waiting");
    expect(localHour(reminder!.fireAt, ZONE)).toBe(8);
    expect(inQuietHours(reminder!.fireAt, ZONE)).toBe(false);
  });

  it("moves an instant in the quiet to the morning, or to the evening before when the morning is too late", () => {
    // 23:30 on 31 October in Tijuana.
    const late = new Date("2026-11-01T06:30:00.000Z");
    const morning = outOfQuietHours(late, ZONE);
    expect(localHour(morning, ZONE)).toBe(8);
    const lapses = new Date(morning.getTime() - 60_000);
    const evening = outOfQuietHours(late, ZONE, lapses);
    expect(inQuietHours(evening, ZONE)).toBe(false);
    expect(localHour(evening, ZONE)).toBe(21);
    expect(evening.getTime()).toBeLessThan(late.getTime());
  });
});
