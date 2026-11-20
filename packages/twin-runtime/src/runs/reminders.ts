/**
 * THE REMINDERS: ONE-SHOT ROWS OF THE CLOCK STORE THAT WAKE THE THREAD
 * (ticket #364; ADR-0031 as amended 2026-10-07; ADR-0014: one clock; CONTEXT.md
 * *Rutinas*, *Schedule*).
 *
 * Three things a card can lapse by: a binding question on its sixth day
 * (FR-32 expires it at about a week), the day's notes two hours before their
 * correction window closes, a draft that has waited since yesterday. When a
 * card that can lapse is born, code writes one `once` row of `schedules` for
 * it, tied to the seat's `reminders` automation, at the instant its reminder
 * is due — shifted out of the rep's quiet hours there and then, so the firing
 * never has to know about them.
 *
 * THE FIRING WAKES THE THREAD AND DOES NOTHING ELSE (`fireDueReminders`): the
 * row's instant came, the gate and the `reminders` switch allow it, and the
 * card still waits — so the thread is told `expiring`, and the thread alone
 * decides whether to knock and with what sentence (ADR-0031). A card that
 * settled in the meantime ends its row and wakes nobody. Rutinas shows the
 * `reminders` row with its switch; paused, no row fires.
 *
 * NO ROW IS EVER DELETED (ADR-0010, 2026-10-06): a row that fired keeps its
 * `fired_at`, and one that passed without firing its `ended_at`.
 */
import { stillWaits, waitingCandidates } from "../canvas.js";
import { correctionWindowClose, readPostsByIds } from "../feed.js";
import { automationPaused, runGate, seatStateOf } from "./gate.js";
import type { RunDeps } from "./engine.js";
import { outOfQuietHours, WINDOW_CLOSING_BEFORE_MS, type ReminderSubject } from "./reminder-rows.js";

export { inQuietHours, REMINDER_SUBJECTS, type ReminderSubject, scheduleReminder } from "./reminder-rows.js";

/**
 * THE REMINDERS' HALF OF THE CLOCK, for one twin at `now`: every one-shot row
 * of the `reminders` automation whose instant has come and that has not
 * fired or ended. Each is stamped in the statement that takes it, so two
 * passes never take one twice: `fired_at` when the card still waits, and the
 * thread is woken with `expiring`; `ended_at` when the gate holds — a seat
 * that cannot act, the switch at «En pausa» — or the card settled, and nobody
 * is woken. How many wakes it raised.
 */
export async function fireDueReminders(deps: RunDeps, now: Date): Promise<number> {
  const due = await deps.db.query<{
    id: string;
    post_id: string;
    subject: ReminderSubject;
    seat_id: string;
    automation_id: string;
  }>(
    `SELECT s.id, s.post_id, s.subject, a.seat_id, a.id AS automation_id
       FROM schedules s
       JOIN automations a ON a.id = s.automation_id AND a.shipped = 'reminders'
      WHERE s.twin_id = $1 AND s.kind = 'once' AND s.post_id IS NOT NULL
        AND s.fired_at IS NULL AND s.ended_at IS NULL AND s.fire_at <= $2
      ORDER BY s.fire_at, s.id`,
    [deps.twinId, now],
  );
  if (due.rows.length === 0) return 0;
  // NO THREAD TO WAKE, NO ROW FIRES (Codex r3): a firing is the thread's
  // event, and a row stamped with nobody told would be a reminder lost.
  if (deps.threadSessions === undefined) return 0;
  const waiting = new Set(await waitingCandidates({ db: deps.db, twinId: deps.twinId }, now));
  const posts = await readPostsByIds(
    {
      db: deps.db,
      twinId: deps.twinId,
      dek: deps.dek,
      bundle: deps.bundle,
      ...(deps.timeZone === undefined ? {} : { timeZone: deps.timeZone }),
    },
    due.rows.map((row) => row.post_id).filter((id) => waiting.has(id)),
    now,
  );
  let raised = 0;
  for (const row of due.rows) {
    // THE NOTES' WINDOW IS READ BEFORE ANYONE IS WOKEN: it opens when the
    // notes reached the rep, which a rail that held the send puts later than
    // the instant the row was written for (Codex r1).
    if (row.subject === "window_closing") {
      const later = await windowClosingLater(deps, row.post_id, now);
      if (later !== undefined) {
        await deps.db.query(
          "UPDATE schedules SET fire_at = $2 WHERE id = $1 AND fired_at IS NULL AND ended_at IS NULL",
          [row.id, later],
        );
        continue;
      }
    }
    const verdict = runGate({
      seat: await seatStateOf(deps.db, row.seat_id),
      paused: false,
      cancelled: false,
      automationPaused: await automationPaused(deps.db, row.seat_id, row.automation_id),
    });
    // THE SUBJECT STILL STANDS: the card is one the canvas still counts as
    // waiting — a draft untapped, a question unanswered, notes whose window
    // is open with a line the rep can take back.
    const post = posts.get(row.post_id);
    const fires = verdict === "advance" && post !== undefined && stillWaits(post);
    // A ROW THAT DOES NOT FIRE IS ENDED, NOT FIRED — the switch off, the seat
    // unable to act, the card already settled — so it owes no knock and is no
    // firing in Rutinas.
    const stamped = await deps.db.query(
      `UPDATE schedules SET ${fires ? "fired_at" : "ended_at"} = $2
        WHERE id = $1 AND fired_at IS NULL AND ended_at IS NULL`,
      [row.id, now],
    );
    if ((stamped.rowCount ?? 0) === 0 || !fires) continue;
    deps.threadSessions?.raise(deps.twinId, { kind: "expiring", postId: row.post_id, subject: row.subject });
    raised += 1;
  }
  return raised;
}

/** How long a notes reminder waits before asking again whether the notes have reached the rep. */
const NOT_YET_REACHED_RECHECK_MS = 30 * 60_000;

/**
 * WHEN THE NOTES' REMINDER IS REALLY DUE, if that is later than now: two
 * hours before the correction window closes — the window the send that
 * reached the rep opened (`correctionWindowClose`) — shifted out of quiet
 * hours; or, while the notes have not reached the rep, a while from now, to
 * ask again. Nothing when it is due now, or the window has closed.
 */
async function windowClosingLater(deps: RunDeps, postId: string, now: Date): Promise<Date | undefined> {
  const notes = await deps.db.query<{ id: string }>(
    `SELECT dp.id FROM posts p JOIN disclosure_posts dp ON dp.notice_id = p.notice_id
      WHERE p.id = $1 AND p.twin_id = $2`,
    [postId, deps.twinId],
  );
  const disclosurePostId = notes.rows[0]?.id;
  if (disclosurePostId === undefined) return undefined;
  const closesAt = await correctionWindowClose({ db: deps.db, twinId: deps.twinId }, disclosurePostId);
  if (closesAt === undefined) return new Date(now.getTime() + NOT_YET_REACHED_RECHECK_MS);
  const zone = deps.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const due = outOfQuietHours(new Date(closesAt.getTime() - WINDOW_CLOSING_BEFORE_MS), zone, closesAt);
  return due > now ? due : undefined;
}
