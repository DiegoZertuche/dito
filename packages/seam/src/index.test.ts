import { describe, expect, it } from "vitest";
import {
  daysBackOf,
  SEND_CLASSES,
  SHIPPED_AUTOMATIONS,
  SEND_OUTCOMES,
  TWIN_ACT_WORDS,
  TWIN_API_ACTS_LOG_DAYS,
  TWIN_API_ROUTES,
} from "./index.js";

// Contract pin (ADR-0006): exactly two send classes, exactly three outcomes.
// The schema-level enforcement of these lives in the seam integration tests
// (src/schema.int.test.ts) against real Postgres.
describe("@dito/seam contracts", () => {
  it("pins the two send classes of ADR-0006", () => {
    expect(SEND_CLASSES).toEqual(["customer_send", "system_send"]);
  });

  it("pins the three send outcomes of ADR-0006", () => {
    expect(SEND_OUTCOMES).toEqual(["sent", "failed", "held"]);
  });

  it("pins the three reads Trabajos en curso and Rutinas ask (#267)", () => {
    expect([
      TWIN_API_ROUTES.routines,
      TWIN_API_ROUTES.actsLog,
      TWIN_API_ROUTES.runs,
    ]).toEqual(["/routines", "/acts-log", "/runs"]);
    // «"Hoy" and ‹ › back seven days; older is gone from the dashboard»
    // (spec #258 decision 16).
    expect(TWIN_API_ACTS_LOG_DAYS).toBe(7);
  });

  it("pins the acts log's eight act words and Rutinas' five shipped automations (#267, #320, #325, #364, #368)", () => {
    expect(TWIN_ACT_WORDS).toEqual([
      "sent",
      "dismissed",
      "confirmed",
      "declined",
      "retracted",
      "reminded",
      "disclosed",
      "cleared",
    ]);
    expect(SHIPPED_AUTOMATIONS).toEqual(["drafting", "extraction", "daily_disclosure", "reminders", "overnight_requests"]);
  });

  it("reads a day-back parameter one way on both sides of the wire (#267)", () => {
    expect([null, "0", "1", "7", "8", "99", "123456789012"].map(daysBackOf)).toEqual([
      0, 0, 1, 7, 7, 7, 7,
    ]);
    expect(["-1", "ayer", "1.5", "", " 2"].map(daysBackOf)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });
});
