/**
 * THE ACTS LOG, ONE SEAT-LOCAL DAY AT A TIME (ticket #267; spec #258
 * decisions 15 and 16; CONTEXT.md *Acts log*; ADR-0008, ADR-0010).
 *
 * What the twin did and when, as Trabajos en curso shows it: every settled
 * act of one day with its word, its instant and who it was about. The day
 * carries no line of the twin's: its arrival line was composed for its moment
 * and stays on Inicio, and the page heads the day with its name and date.
 * Read over the rows the acts already leave;
 * there is no table of its own, because each act is already recorded exactly
 * once somewhere, and a second copy would be a second answer to «did it
 * happen».
 *
 * ═══ WHERE EACH ACT IS FOUND ═══
 *
 *   sent       `send_commands` — a `customer_send` whose outcome is `sent`, at
 *              `executed_at`. Both surfaces' taps end here (ADR-0006), and
 *              `held` is not a send yet: it lands here the day it is `sent`.
 *   dismissed  `draft_dismissals` — the terminal row either surface writes
 *              (`rep-acts.ts`), at `created_at`.
 *   confirmed  the bundle's entity mirror — the one place a confirmed binding
 *              lands, from either surface, once per chat, with its own
 *              `confirmedAt` and the name it stored (ADR-0004). The seam holds
 *              no row of its own for it: a thread «va» repeated marks its event
 *              `binding_confirmed` again, which would log one binding twice.
 *   declined   a `dashboard_acts` row `decline_binding` that `performed`, or a
 *              thread message marked `declined` — the two authorities
 *              `binding-question.ts` reads. A decline writes nothing else.
 *   retracted  `fact_retractions` — both surfaces, at `retracted_at`, with the
 *              number the notes printed for the line (`disclosure_post_lines`).
 *   reminded   a knock the thread added for a card's fired reminder
 *              (`post_knocks` with a subject, ticket #364) whose push notify
 *              recorded `sent` to one of the seat's browsers (`notify_sends`,
 *              `message_type` `reminder`, `about_ref` the post), at the first
 *              such send: a knock refused, failed or with no browser to reach
 *              reminded nobody (Codex r1).
 *   disclosed  `disclosure_posts` whose own `system_send` is `sent`, at the
 *              rail's `executed_at`: notes the rail never delivered were not
 *              disclosed (Codex r3).
 *   cleared    a `dashboard_acts` row `clear_card` that `performed` — the
 *              rep's «Listo» on a card with no act of its own (ticket #368),
 *              named by the document the card handed them.
 *
 * ═══ ONE DAY, CUT IN THE SEAT'S ZONE, SEVEN DEEP ═══
 *
 * The day is `back` whole days before the seat-local today, and both are cut
 * in Postgres from the caller's `now` in the rep's zone — the exchanges' own
 * arithmetic (`exchanges.ts`), so a day boundary cannot differ between the
 * bar's history and this. The day's two edges become instants in that same
 * statement, and every act is read between them. `back` is clamped to
 * `TWIN_API_ACTS_LOG_DAYS` before anything is cut, so no caller reaches an
 * older day.
 *
 * ═══ «WHERE THE SUBJECT STILL EXISTS» ═══
 *
 * A line links only to something the rep can still open and act on. A post
 * that still waits on Inicio — a reminder's subject, the day's notes while a
 * line can be taken back — is decided by the canvas's own read, so the log
 * and the canvas cannot disagree about it. A confirmed binding opens
 * Conexiones where its chat has a directory row there to draw it. A sent or dismissed draft, a declined
 * question and a retracted line are settled: their line names them and opens
 * nothing.
 *
 * ═══ THE SEAT AND THE TWIN ═══
 *
 * A twin has one seat (`seats_one_seat_per_twin`); every row here is read by
 * its twin, and by its seat as well wherever the row carries one — the
 * exchanges' rule, so a fleet that ever seats two reps on a twin does not
 * hand one the other's acts.
 */
import {
  decodeWaMessagePayload,
  TWIN_API_ACTS_LOG_DAYS,
  type TwinActOpens,
  type TwinActsLog,
  type TwinActWord,
  type TwinLoggedAct,
} from "@dito/seam";
import { counterpartyOf, readWaiting } from "./canvas.js";
import { readPostsByIds, type FeedDeps, type FeedPost } from "./feed.js";
import { readPostedSystemSend } from "./twin-posts.js";

/** One line of the log as the runtime reads it: its instant still a `Date`. */
export interface LoggedAct {
  readonly act: TwinActWord;
  readonly at: Date;
  readonly name?: string;
  readonly line?: number;
  readonly notesDay?: string;
  readonly opens?: TwinActOpens;
}

/** One day of the log, oldest act first. */
export interface ActsLog {
  readonly today: string;
  readonly day: string;
  readonly back: number;
  readonly acts: readonly LoggedAct[];
}

/**
 * `back` as the log answers it: a whole number from today to the seventh day
 * before it. The clamp is here rather than at the page because this is the
 * one process that cuts the day — a page that asks for more is answered the
 * last day it may see.
 */
export function clampBack(back: number): number {
  return Math.min(Math.max(back, 0), TWIN_API_ACTS_LOG_DAYS);
}

/** One act row off the seam, before its subject is opened. */
interface ActRow {
  readonly act: Exclude<TwinActWord, "confirmed">;
  readonly at: Date;
  readonly post_id: string | null;
  readonly event_id: string | null;
  readonly line_index: number | null;
  readonly notes_day: string | null;
}

/**
 * Reads one day of the seat's acts.
 *
 * `now` IS THE CALLER'S, the exchanges' rule: which day is «today» is a
 * statement about the reader's day, and a server filling it in from its own
 * clock would cut the wrong day without failing anything.
 */
export async function readActsLog(
  deps: FeedDeps,
  read: { readonly seatId: string; readonly now: Date; readonly back: number },
): Promise<ActsLog> {
  const zone = deps.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const back = clampBack(read.back);
  const bounds = await deps.db.query<{
    today: string;
    day: string;
    from_at: Date;
    until_at: Date;
  }>(
    // THE DAY'S EDGES ARE LOCAL MIDNIGHTS TURNED INTO INSTANTS IN THE SEAT'S
    // ZONE, so a day that crosses a daylight-saving change is its own length.
    `SELECT today::text AS today,
            (today - $3::int)::text AS day,
            ((today - $3::int)::timestamp AT TIME ZONE $2) AS from_at,
            ((today - $3::int + 1)::timestamp AT TIME ZONE $2) AS until_at
       FROM (SELECT ($1::timestamptz AT TIME ZONE $2)::date AS today) t`,
    [read.now, zone, back],
  );
  const { today, day, from_at: from, until_at: until } = bounds.rows[0]!;
  const rows = await readActRows(deps, read.seatId, from, until);
  const named = await namesOf(deps, rows, read.now);
  const waiting = rows.some((row) => row.act === "reminded" || row.act === "disclosed")
    ? new Set((await readWaiting(deps, read.now)).map((post) => post.id))
    : new Set<string>();
  const acts: LoggedAct[] = rows.map((row) => {
    const post = subjectOf(row, named.questionOfEvent);
    const name = post === undefined ? undefined : named.names.get(post);
    const opens =
      (row.act === "reminded" || row.act === "disclosed") &&
      post !== undefined &&
      waiting.has(post)
        ? ("inicio" as const)
        : undefined;
    return {
      act: row.act,
      at: row.at,
      ...(name === undefined ? {} : { name }),
      ...(row.line_index === null ? {} : { line: row.line_index }),
      ...(row.notes_day === null ? {} : { notesDay: row.notes_day }),
      ...(opens === undefined ? {} : { opens }),
    };
  });
  acts.push(...(await confirmationsBetween(deps, from, until)));
  acts.sort((a, b) => a.at.getTime() - b.at.getTime());
  return { today, day, back, acts };
}

/**
 * Every act on the seam between two instants, in one statement so the day is
 * read from one snapshot. The table each arm reads is argued in the header.
 */
async function readActRows(
  deps: FeedDeps,
  seatId: string,
  from: Date,
  until: Date,
): Promise<readonly ActRow[]> {
  const res = await deps.db.query<ActRow>(
    `SELECT 'sent' AS act, sc.executed_at AS at, p.id AS post_id,
            NULL::text AS event_id, NULL::int AS line_index, NULL::text AS notes_day
       FROM send_commands sc
       LEFT JOIN posts p ON p.draft_id = sc.draft_id AND p.twin_id = sc.twin_id
      WHERE sc.twin_id = $1 AND sc.send_class = 'customer_send'
        AND sc.outcome = 'sent'
        AND sc.executed_at >= $3 AND sc.executed_at < $4
     UNION ALL
     SELECT 'dismissed', x.created_at, p.id, NULL, NULL, NULL
       FROM draft_dismissals x
       JOIN drafts d ON d.id = x.draft_id AND d.twin_id = $1
       LEFT JOIN posts p ON p.draft_id = x.draft_id AND p.twin_id = $1
      WHERE x.created_at >= $3 AND x.created_at < $4
     UNION ALL
     SELECT 'declined', a.acted_at, a.post_id, NULL, NULL, NULL
       FROM dashboard_acts a
      WHERE a.twin_id = $1 AND a.seat_id = $2
        AND a.verb = 'decline_binding' AND a.outcome = 'performed'
        AND a.acted_at >= $3 AND a.acted_at < $4
     UNION ALL
     SELECT 'declined', m.processed_at, NULL, m.event_id::text, NULL, NULL
       FROM wa_event_processing m
      WHERE m.twin_id = $1 AND m.disposition = 'declined'
        AND m.processed_at >= $3 AND m.processed_at < $4
     UNION ALL
     -- THE NUMBER THE NOTES PRINTED, which is what the rep pressed Retirar on.
     SELECT 'retracted', r.retracted_at, NULL, NULL, l.line_index,
            l.disclosure_day::text
       FROM fact_retractions r
       LEFT JOIN LATERAL (
              -- THE POST THE REP READ IT ON: a line whose first post never
              -- reached them is numbered again in a later one, so only a post
              -- whose send was acknowledged can be the one they pressed
              -- Retirar on (Codex r3).
              SELECT pl.line_index, dp.disclosure_day
                FROM disclosure_post_lines pl
                JOIN disclosure_posts dp
                  ON dp.id = pl.post_id AND dp.twin_id = pl.twin_id
                JOIN send_commands sc
                  ON sc.twin_id = dp.twin_id AND sc.send_class = 'system_send'
                 AND sc.payload_ref = 'notice:' || dp.notice_id
                 AND sc.outcome = 'sent'
               WHERE pl.twin_id = r.twin_id
                 AND pl.disclosure_line_id = r.disclosure_line_id
               ORDER BY sc.executed_at DESC
               LIMIT 1) l ON true
      WHERE r.twin_id = $1 AND r.seat_id = $2
        AND r.retracted_at >= $3 AND r.retracted_at < $4
     UNION ALL
     -- A REMINDER IS ONE THAT REACHED A BROWSER: the first push notify
     -- recorded as sent for a reminder's knock about this post, however many
     -- browsers took it.
     SELECT 'reminded', s.first_sent, k.post_id, NULL, NULL, NULL
       FROM post_knocks k
       JOIN LATERAL (
              SELECT min(ns.settled_at) AS first_sent
                FROM notify_sends ns
               WHERE ns.seat_id = $2 AND ns.message_type = 'reminder'
                 AND ns.outcome = 'sent'
                 AND ns.about_ref = k.post_id::text
                 AND ns.settled_at >= k.knocked_at) s
         ON s.first_sent IS NOT NULL
      WHERE k.twin_id = $1 AND k.subject IS NOT NULL
        AND s.first_sent >= $3 AND s.first_sent < $4
     UNION ALL
     SELECT 'cleared', a.acted_at, a.post_id, NULL, NULL, NULL
       FROM dashboard_acts a
      WHERE a.twin_id = $1 AND a.seat_id = $2
        AND a.verb = 'clear_card' AND a.outcome = 'performed'
        AND a.acted_at >= $3 AND a.acted_at < $4
     UNION ALL
     -- THE DAY'S NOTES ARE DISCLOSED WHEN THEY REACHED THE REP: the post's
     -- own send, sent, at the instant the rail acknowledged it (Codex r3).
     SELECT 'disclosed', sc.executed_at, p.id, NULL, NULL, NULL
       FROM disclosure_posts dp
       JOIN send_commands sc
         ON sc.twin_id = dp.twin_id AND sc.send_class = 'system_send'
        AND sc.payload_ref = 'notice:' || dp.notice_id
        AND sc.outcome = 'sent'
       LEFT JOIN posts p ON p.notice_id = dp.notice_id AND p.twin_id = dp.twin_id
      WHERE dp.twin_id = $1
        AND sc.executed_at >= $3 AND sc.executed_at < $4
      ORDER BY at, act`,
    [deps.twinId, seatId, from, until],
  );
  return res.rows;
}

/**
 * The confirmations of the day, off the entity mirror — none on a runtime
 * serving the reads with no bundle open, which holds no binding to name.
 */
async function confirmationsBetween(
  deps: FeedDeps,
  from: Date,
  until: Date,
): Promise<LoggedAct[]> {
  if (deps.bundle === undefined) return [];
  const bindings = deps.bundle.listChatBindings().filter((binding) => {
    const at = new Date(binding.confirmedAt);
    return at >= from && at < until;
  });
  if (bindings.length === 0) return [];
  // CONEXIONES DRAWS A CHAT FROM ITS DIRECTORY ROW, so a binding opens there
  // only where one stands to draw it (Codex r3): the scope rows are a
  // contact's or a group's, by its phone or its hidden address.
  const listed = await deps.db.query<{ chat_jid: string; lid_jid: string | null }>(
    `SELECT chat_jid, lid_jid FROM chat_directory
      WHERE twin_id = $1 AND kind IN ('dm', 'group')
        AND (chat_jid = ANY($2::text[]) OR lid_jid = ANY($2::text[]))`,
    [deps.twinId, bindings.map((binding) => binding.chatJid)],
  );
  const shown = new Set(
    listed.rows.flatMap((row) => (row.lid_jid === null ? [row.chat_jid] : [row.chat_jid, row.lid_jid])),
  );
  return bindings.map((binding) => ({
    act: "confirmed" as const,
    at: new Date(binding.confirmedAt),
    name: binding.displayName,
    ...(shown.has(binding.chatJid) ? { opens: "conexiones" as const } : {}),
  }));
}

/** The post a line is about: its own, or the question a thread decline quoted. */
function subjectOf(
  row: ActRow,
  questionOfEvent: ReadonlyMap<string, string>,
): string | undefined {
  if (row.post_id !== null) return row.post_id;
  if (row.event_id !== null) return questionOfEvent.get(row.event_id);
  return undefined;
}

/**
 * Who each subject post is about, opened under the twin's key — and, for a
 * decline typed in the thread, which question it quoted.
 *
 * THE THREAD'S DECLINE IS FOUND BY THE WALK `binding-question.ts` MAKES, the
 * other way round: the quoted id is inside the rep's sealed payload, and it
 * names the rail message the question went out as — through the registry's
 * one quoted-id join (`readPostedSystemSend`) — which names the notice, which
 * names the post.
 */
async function namesOf(
  deps: FeedDeps,
  rows: readonly ActRow[],
  now: Date,
): Promise<{
  names: ReadonlyMap<string, string>;
  questionOfEvent: ReadonlyMap<string, string>;
}> {
  const questionOfEvent = new Map<string, string>();
  const eventIds = rows.flatMap((row) => (row.event_id === null ? [] : [row.event_id]));
  if (eventIds.length > 0) {
    const events = await deps.db.query<{ id: string; payload_enc: Buffer }>(
      "SELECT id::text AS id, payload_enc FROM wa_events WHERE twin_id = $1 AND id = ANY($2::bigint[])",
      [deps.twinId, eventIds],
    );
    const quoted = new Map<string, string>();
    for (const row of events.rows) {
      const id = decodeWaMessagePayload(deps.dek, row.payload_enc).quotedMessageId;
      if (id !== undefined) quoted.set(row.id, id);
    }
    for (const [eventId, messageId] of quoted) {
      const posted = await readPostedSystemSend(deps, messageId);
      if (posted?.noticeId == null) continue;
      const post = await deps.db.query<{ id: string }>(
        "SELECT id FROM posts WHERE twin_id = $1 AND notice_id = $2",
        [deps.twinId, posted.noticeId],
      );
      const postId = post.rows[0]?.id;
      if (postId !== undefined) questionOfEvent.set(eventId, postId);
    }
  }
  const ids = new Set<string>(questionOfEvent.values());
  for (const row of rows) if (row.post_id !== null) ids.add(row.post_id);
  const opened = await readPostsByIds(deps, [...ids], now);
  const names = new Map<string, string>();
  for (const [id, post] of opened) {
    // A CARD «LISTO» PUT AWAY NAMES NO CUSTOMER: its document's title says
    // what it was (ticket #368).
    const name = counterpartyOf(post) ?? documentTitleOf(post);
    if (name !== undefined) names.set(id, name);
  }
  return { names, questionOfEvent };
}

/** The title of the first document a post hands the rep, if it hands one. */
function documentTitleOf(post: FeedPost): string | undefined {
  for (const part of post.parts) if (part.kind === "document") return part.title;
  return undefined;
}

/** The log onto the wire: every instant an ISO string (`TwinActsLog`). */
export function actsLogOnTheWire(log: ActsLog): TwinActsLog {
  return {
    today: log.today,
    day: log.day,
    back: log.back,
    acts: log.acts.map(actOnTheWire),
  };
}

function actOnTheWire(act: LoggedAct): TwinLoggedAct {
  return {
    act: act.act,
    at: act.at.toISOString(),
    ...(act.name === undefined ? {} : { name: act.name }),
    ...(act.line === undefined ? {} : { line: act.line }),
    ...(act.notesDay === undefined ? {} : { notesDay: act.notesDay }),
    ...(act.opens === undefined ? {} : { opens: act.opens }),
  };
}
