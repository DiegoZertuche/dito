/**
 * WHEN A RUTINA RUNS, IN WORDS (ticket #387): one weekday, a set, Monday to
 * Friday and every day, each at its hour; an event by what wakes it.
 */
import { describe, expect, it } from "vitest";
import { CHROME } from "./chrome.js";
import { whenRutinaRuns } from "./rutina-when.js";

const at = (weekdays: readonly number[]) => whenRutinaRuns({ kind: "schedule", every: "week", weekdays, atHour: 9 });

describe("when a rutina runs, in the copy package's words", () => {
  it("says one weekday after «Cada»", () => {
    expect(at([5])).toBe(`${CHROME["rutinas.every"]}viernes${CHROME["rutinas.atClock"]}09:00`);
    expect(at([5])).toBe("Cada viernes a las 09:00");
  });

  it("says a set as Spanish lists it, in ISO order, with a final «y»", () => {
    expect(at([4, 1])).toBe("Lunes y jueves a las 09:00");
    expect(at([5, 1, 3])).toBe("Lunes, miércoles y viernes a las 09:00");
    expect(at([6, 7])).toBe("Sábado y domingo a las 09:00");
  });

  it("says Monday to Friday as «Entre semana», and all seven as every day", () => {
    expect(at([1, 2, 3, 4, 5])).toBe(`${CHROME["rutinas.weekdaysAt"]}09:00`);
    expect(at([1, 2, 3, 4, 5])).toBe("Entre semana a las 09:00");
    expect(at([1, 2, 3, 4, 5, 6, 7])).toBe("Cada día a las 09:00");
    expect(whenRutinaRuns({ kind: "schedule", every: "day", atHour: 18 })).toBe(`${CHROME["rutinas.dailyAt"]}18:00`);
  });

  it("says an event by what wakes it, its customer by the name given", () => {
    expect(whenRutinaRuns({ kind: "trigger", event: "customer_message" })).toBe(CHROME["rutinas.whenCustomerWrites"]);
    expect(whenRutinaRuns({ kind: "trigger", event: "customer_message", customer: "Sergio Ramos" })).toBe(
      `${CHROME["rutinas.whenNamedWrites"]}Sergio Ramos`,
    );
    expect(whenRutinaRuns({ kind: "trigger", event: "card_settled" })).toBe(CHROME["rutinas.whenCardSettles"]);
  });
});
