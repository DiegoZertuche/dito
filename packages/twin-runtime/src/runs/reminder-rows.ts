/**
 * A CARD THAT CAN LAPSE IS BORN WITH ITS REMINDER (ticket #364; ADR-0031 as
 * amended 2026-10-07): which subject it can lapse by, when the reminder is
 * due — shifted out of the rep's quiet hours — and the one-shot row of the
 * clock store that carries it, written in the transaction that writes the
 * card. The firing is `reminders.ts`'.
 */
import type pg from "pg";
import type { PostPart } from "../posts.js";
import { atLocalHour, civilDate, localHour } from "../rep-clock.js";

/**
 * THE THREE SUBJECTS A CARD CAN LAPSE BY, and the words
 * `schedules_subject_check` and `post_knocks_subject_check` hold.
 */
export const REMINDER_SUBJECTS = ["question_expiring", "window_closing", "draft_waiting"] as const;

export type ReminderSubject = (typeof REMINDER_SUBJECTS)[number];

/** The hour the twin stops reaching for the rep's attention (spec #258 decision 8). */
export const QUIET_HOURS_FROM = 22;

/** ...and the hour it may start again. */
export const QUIET_HOURS_UNTIL = 8;

/** A binding question's reminder: its sixth day, a day before FR-32's week runs out. */
const QUESTION_DUE_AFTER_MS = 6 * 86_400_000;

/** The day's notes' reminder: two hours before the correction window closes. */
export const WINDOW_CLOSING_BEFORE_MS = 2 * 3_600_000;

/** How long the correction window stays open once the day's notes reached the rep (FR-38). */
const CORRECTION_WINDOW_MS = 24 * 3_600_000;

/** Whether an instant falls in the rep's quiet hours. */
export function inQuietHours(at: Date, timeZone: string): boolean {
  const hour = localHour(at, timeZone);
  return hour >= QUIET_HOURS_FROM || hour < QUIET_HOURS_UNTIL;
}

/**
 * THE INSTANT OUT OF QUIET HOURS: unchanged when the rep is awake; otherwise
 * the next morning's first waking instant — unless that is already past the
 * subject's own end, and then the evening's last one before the quiet began,
 * so a reminder never lands after the thing it is about.
 */
export function outOfQuietHours(at: Date, timeZone: string, lapsesAt?: Date): Date {
  if (!inQuietHours(at, timeZone)) return at;
  // THE MORNING THE QUIET ENDS ON: today's when it is still before eight,
  // tomorrow's when the quiet began this evening.
  const morningDay =
    localHour(at, timeZone) < QUIET_HOURS_UNTIL
      ? civilDate(at, timeZone)
      : civilDate(new Date(at.getTime() + 12 * 3_600_000), timeZone);
  const morning = atLocalHour(morningDay, QUIET_HOURS_UNTIL, timeZone);
  if (lapsesAt === undefined || morning < lapsesAt) return morning;
  // ...OR THE MINUTE BEFORE THE QUIET BEGAN, the evening before that morning.
  const eveningDay = civilDate(new Date(morning.getTime() - 12 * 3_600_000), timeZone);
  return new Date(atLocalHour(eveningDay, QUIET_HOURS_FROM, timeZone).getTime() - 60_000);
}

/**
 * The reminder a card is born owing, read off its parts: which subject, and
 * when — or nothing, for a card that cannot lapse.
 */
export function reminderOf(
  parts: readonly PostPart[],
  postedAt: Date,
  timeZone: string,
): { readonly subject: ReminderSubject; readonly fireAt: Date } | undefined {
  if (parts.some((part) => part.kind === "draft")) {
    // WAITING SINCE YESTERDAY: the first waking instant of the next day.
    const tomorrow = civilDate(new Date(postedAt.getTime() + 86_400_000), timeZone);
    return { subject: "draft_waiting", fireAt: atLocalHour(tomorrow, QUIET_HOURS_UNTIL, timeZone) };
  }
  if (parts.some((part) => part.kind === "question" && part.subject === "binding")) {
    const lapsesAt = new Date(postedAt.getTime() + 7 * 86_400_000);
    return {
      subject: "question_expiring",
      fireAt: outOfQuietHours(new Date(postedAt.getTime() + QUESTION_DUE_AFTER_MS), timeZone, lapsesAt),
    };
  }
  if (parts.some((part) => part.kind === "record-lines")) {
    // THE WINDOW OPENS WHEN THE POST REACHES THE REP, seconds after it is
    // written; the firing reads the window's own close before it wakes anyone,
    // and moves the row when the window opened later (`reminders.ts`).
    const lapsesAt = new Date(postedAt.getTime() + CORRECTION_WINDOW_MS);
    return {
      subject: "window_closing",
      fireAt: outOfQuietHours(new Date(lapsesAt.getTime() - WINDOW_CLOSING_BEFORE_MS), timeZone, lapsesAt),
    };
  }
  return undefined;
}

/**
 * Writes the card's reminder row, in the caller's transaction, tied to the
 * seat's `reminders` automation — or nothing, for a card that cannot lapse or
 * a twin whose rows Dito has not written yet. One row per card and subject
 * (`schedules_one_reminder_per_subject`).
 */
export async function scheduleReminder(
  client: pg.ClientBase,
  args: {
    readonly twinId: string;
    readonly postId: string;
    readonly parts: readonly PostPart[];
    readonly postedAt: Date;
    readonly timeZone: string;
  },
): Promise<void> {
  const reminder = reminderOf(args.parts, args.postedAt, args.timeZone);
  if (reminder === undefined) return;
  await client.query(
    `INSERT INTO schedules (twin_id, kind, fire_at, automation_id, post_id, subject)
     SELECT $1, 'once', $2, a.id, $3, $4
       FROM automations a
      WHERE a.twin_id = $1 AND a.shipped = 'reminders' AND a.ended_at IS NULL
     ON CONFLICT ON CONSTRAINT schedules_one_reminder_per_subject DO NOTHING`,
    [args.twinId, reminder.fireAt, args.postId, reminder.subject],
  );
}

