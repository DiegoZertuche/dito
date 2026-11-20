/**
 * WHEN A RUTINA RUNS, IN WORDS (tickets #325, #386, #387; ADR-0037 as amended:
 * chrome is the copy package's, never the twin's).
 *
 * «Cada viernes a las 09:00», «Lunes y jueves a las 09:00», «Entre semana a
 * las 09:00», «Cada día a las 09:00», «Cuando te escribe Sergio Ramos» —
 * rendered from a wake's typed facts into this package's keys. ONE RENDERING,
 * TWO DOORS: the runtime says it on a proposal card, which the phone and the
 * canvas both read off the post, and Rutinas says it on each card it lists, so
 * the words live here, the one package both import.
 *
 * The hour and the weekdays are the row's typed facts; a weekday's name is the
 * calendar's in es-MX, and a set of them is joined the way Spanish lists are,
 * commas and a final «y»; a customer's name is the one the runtime rendered
 * from the rep's own confirmation.
 */
import { CHROME } from "./chrome.js";

/** A wake as these words take it: a cadence, or the event that wakes it. */
export type RutinaWhen =
  | {
      readonly kind: "schedule";
      readonly every: "day" | "week";
      /** ISO weekdays, 1 = Monday — on a weekly cadence, one or more. */
      readonly weekdays?: readonly number[];
      readonly atHour: number;
    }
  | {
      readonly kind: "trigger";
      readonly event: "customer_message" | "card_settled";
      /** The customer's name, when the wake is about one. */
      readonly customer?: string;
    };

const MONDAY_TO_FRIDAY = "1,2,3,4,5";

/** When the rutina runs, in words. */
export function whenRutinaRuns(wake: RutinaWhen): string {
  if (wake.kind === "trigger") {
    if (wake.event === "card_settled") return CHROME["rutinas.whenCardSettles"];
    return wake.customer === undefined
      ? CHROME["rutinas.whenCustomerWrites"]
      : `${CHROME["rutinas.whenNamedWrites"]}${wake.customer}`;
  }
  const hour = `${String(wake.atHour).padStart(2, "0")}:00`;
  const days = [...new Set(wake.every === "week" ? (wake.weekdays ?? []) : [])].sort((a, b) => a - b);
  if (days.length === 0 || days.length === 7) return `${CHROME["rutinas.dailyAt"]}${hour}`;
  if (days.join(",") === MONDAY_TO_FRIDAY) return `${CHROME["rutinas.weekdaysAt"]}${hour}`;
  if (days.length === 1) return `${CHROME["rutinas.every"]}${weekdayName(days[0]!)}${CHROME["rutinas.atClock"]}${hour}`;
  const list = new Intl.ListFormat("es-MX", { style: "long", type: "conjunction" }).format(days.map(weekdayName));
  return `${list.charAt(0).toLocaleUpperCase("es-MX")}${list.slice(1)}${CHROME["rutinas.atClock"]}${hour}`;
}

/** An ISO weekday's name — 1 is «lunes» — read off a Monday the calendar fixes, in UTC so no zone moves it. */
function weekdayName(weekday: number): string {
  return new Intl.DateTimeFormat("es-MX", { weekday: "long", timeZone: "UTC" }).format(
    new Date(Date.UTC(2026, 9, 4 + weekday, 12)),
  );
}
