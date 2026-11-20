/**
 * THE BAR'S HISTORY: EVERYTHING SAID AT THE DASHBOARD'S DOOR, PAGED BACK BY
 * DAY (tickets #261, #263 and #338; spec #258 decisions 4 and 13; ADR-0008,
 * ADR-0010).
 *
 * CONTEXT.md's *Exchange* is the rep's half of it. The twin's own lines are
 * here by the UX spine's ruling of 2026-10-05 (row A: «everything Dito says
 * stays in the thread»), which overturns «history = rep-asked exchanges only».
 *
 * What the rep asked through the bar and what the twin said back, paired, and
 * every line the twin said at the door on its own — a page of seat-local days
 * at a time, in the order it happened. A phone question's answer is posted at
 * the phone's door and is never here.
 *
 * ═══ A SENTENCE SAID ON A CARD IS THE CARD'S (ticket #401; boundary #327,
 * F14, ruled by Diego 2026-10-13)
 *
 * What the twin says beside a card on a summons (`say_on_card`) is drawn on
 * that card and is never an entry of the bar's history: every card the rep
 * took the twin to was a turn of its own, and the history filled with them.
 * The post stays, and so does the twin's own session record of it.
 *
 * ═══ A LINE OF THE TWIN'S OWN, TOLD FROM A REPLY BY ITS POST ROW
 *
 * A post at the dashboard's door names why it is there, exactly one reason
 * (`posts_door_one_reason_check`): the message it answers, the arrival it
 * greets, or `unasked`. A reply names its message and is paired with it, so
 * it is never read a second time as a line; the arrival line and the unasked
 * line name no message and are the twin's own (`canvas.ts`' `readLastLine`
 * reads the same two). A post at the phone's door carries none of the three,
 * and a proactive card carries no door at all, so neither is here.
 *
 * ═══ A DAY IS CUT IN ONE ZONE, IN ONE PLACE
 *
 * «Which day is this message in» is computed in Postgres from the rep's own
 * zone, and so is «which day is today» — so the two are one arithmetic
 * rather than two that could disagree across a daylight-saving boundary. The
 * page receives bare dates (`TwinExchangeDay.day`, `TwinExchanges.today`) and
 * never turns an instant into a day with a zone of its own. The instant
 * «today» is measured from is the CALLER's, like the feed's `now`, because
 * the page names «Hoy» from it and a server filling it in from its own clock
 * would cut the wrong day without failing anything.
 *
 * ═══ PAGED BY DAY, AND THE CURSOR IS A DAY
 *
 * A page is the newest `EXCHANGE_DAYS_PER_PAGE` days that hold anything, at
 * or before `until`, and `nextUntil` names the newest day before them that
 * holds anything. A day and never a row id: a day is never cut in half
 * between two pages, and the page and the read cannot disagree about where
 * one ends, because the read is the only thing that ever decides it.
 *
 * ═══ AN EXCHANGE THE TWIN LEFT NOTHING FOR IS NOT KEPT
 *
 * A turn that failed, or that chose silence, left the rep nothing to read.
 * The bar says so once, in its current line, and hands the question back to
 * the composer (spec #258 decision 13) — and the history leaves the exchange
 * out, so the read never returns one. The message row stays: it is class-2
 * evidence (ADR-0003) and nothing about a history changes that.
 *
 * ═══ THE SEAT AND THE TWIN, BOTH
 *
 * The messages are read by SEAT — a twin has one seat today
 * (`seats_one_seat_per_twin`) and the door is a person's — and the replies by
 * TWIN, because a post belongs to the twin. Both predicates are in their own
 * WHERE clause rather than inferred from the other, so a fleet that ever seats
 * two reps on one twin does not quietly hand one the other's words.
 *
 * ═══ AND THE WORDS COME BACK OPENED
 *
 * Both halves are sealed under the twin DEK (ADR-0008) and rep-web holds no
 * key, so this read is the lease holder's exactly as the feed's is. What
 * crosses is what the rep typed and what the twin composed for them, and
 * nothing else: no session, no seat, no chat.
 */
import type { Dek } from "@dito/crypto";
import type { TwinExchange, TwinExchanges, TwinOwnLine } from "@dito/seam";
import type pg from "pg";
import {
  feedPostOnTheWire,
  readPostsByIds,
  readRepliesAtTheDoor,
  type FeedPost,
} from "./feed.js";

/** What the read needs: the seam, the twin, the seat, and the key. */
export interface ExchangeDeps {
  readonly db: pg.ClientBase;
  readonly twinId: string;
  readonly dek: Dek;
  /**
   * The rep's own zone, for the days this read cuts on.
   *
   * OPTIONAL AND DEFAULTED TO THE HOST'S, exactly as the feed's is: a runtime
   * started with no zone renders in the deployment's, which on the rig is the
   * rep's. It is the one value that decides which day a message is in, so it
   * is a parameter rather than a clock read inside this module.
   */
  readonly timeZone?: string;
}

/** One exchange, as the runtime reads it before the wire. */
export interface Exchange {
  readonly messageId: string;
  readonly at: Date;
  readonly text: string;
  readonly reply?: FeedPost;
  readonly settled?: true;
}

/** One line the twin said at the door on its own (`TwinOwnLine`). */
export interface OwnLine {
  readonly line: FeedPost;
}

/** One seat-local day, oldest entry first. */
export interface ExchangeDay {
  readonly day: string;
  readonly exchanges: readonly (Exchange | OwnLine)[];
}

/** One page of days, oldest first, with the day the next page ends on. */
export interface Exchanges {
  readonly today: string;
  readonly days: readonly ExchangeDay[];
  readonly nextUntil?: string;
}

/**
 * How many days that hold anything one page carries.
 *
 * TWO, so the first page holds today's exchanges and the last day before
 * them — «yesterday's exchanges are there on the first open» (ticket #263)
 * for a rep who asked something yesterday, and the last day they did for one
 * who did not. More is one tap on «Días anteriores» away, and a page is
 * decrypted whole in one request, so a small page is also a bounded one.
 */
export const EXCHANGE_DAYS_PER_PAGE = 2;

/**
 * THE TWO MARKERS A DOOR TURN LEAVES WHEN IT PRODUCED NOTHING FOR THE REP
 * (ticket #261).
 *
 * The door's reachable set of outcomes is four words and no more, which is
 * what makes this a short list rather than a vocabulary. `answered` posts the
 * reply this read pairs. `drafted` posts a Borrador and its card — the twin
 * answered with something that waits on the rep. The other two are these: a
 * run that could not finish, and one that chose to say nothing. Every
 * remaining word in the seam's set belongs to an ACT, and every act the thread
 * has is bound to a post the rep quoted — which the bar's composer cannot do.
 *
 * NAMED RATHER THAN INFERRED FROM THE ABSENCE OF A POST, because a draft is a
 * post too: "did this turn leave anything" answered by counting rows would
 * have to know which rows belong to this door, and that is what the marker
 * already says.
 */
const LEFT_NOTHING: readonly string[] = ["execution_failed", "deliberate_silence"];

/**
 * Whether a door turn marked with `disposition` left the rep nothing — the
 * one rule the history's read and the stream's `failed` event share, so the
 * two cannot disagree about which exchanges are kept (ticket #263).
 */
export function leftTheRepNothing(disposition: string): boolean {
  return LEFT_NOTHING.includes(disposition);
}

/**
 * One row of a page, before its words are opened and its reply attached — a
 * message, or (`own`) a line the twin said on its own, opened as a post.
 */
interface EntryRow {
  readonly id: string;
  readonly occurred_at: Date;
  readonly text_enc: Buffer | null;
  readonly disposition: string | null;
  readonly day: string;
  readonly own: boolean;
}

/**
 * Reads one page of the seat's history: the newest days that hold anything,
 * at or before `until` (today, at `now`, when absent).
 *
 * OLDEST FIRST, which is the order a conversation reads and the reverse of the
 * feed's: the bar renders newest at the bottom, over the composer, the way
 * every chat anybody has ever used does.
 */
export async function readExchanges(
  deps: ExchangeDeps,
  page: {
    readonly seatId: string;
    readonly now: Date;
    /** The newest day this page may hold, `YYYY-MM-DD`; today when absent. */
    readonly until?: string;
  },
): Promise<Exchanges> {
  const zone = deps.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const today = await deps.db.query<{ today: string }>(
    "SELECT (($1::timestamptz) AT TIME ZONE $2)::date::text AS today",
    [page.now, zone],
  );
  const res = await deps.db.query<EntryRow>(
    // ONE STATEMENT, so the days a page holds and the entries in them are
    // read from one snapshot: a message or a line landing between two
    // statements could otherwise name a day the first one never counted.
    `WITH kept AS (
       SELECT m.id, m.occurred_at, m.text_enc, p.disposition,
              (m.occurred_at AT TIME ZONE $3)::date AS day, false AS own
         FROM dashboard_messages m
         LEFT JOIN dashboard_message_processing p ON p.message_id = m.id
        WHERE m.twin_id = $1 AND m.seat_id = $2
          AND (p.disposition IS NULL OR NOT (p.disposition = ANY($6::text[])))
       UNION ALL
       -- THE TWIN'S OWN LINES: the seat scopes an arrival line and the twin
       -- an unasked one, readLastLine's rule in canvas.ts. The day is cut from the
       -- instant, as a message's is. A sentence said on a card is the card's
       -- and never one of these (ticket #401).
       SELECT p.id, p.posted_at, NULL, NULL,
              (p.posted_at AT TIME ZONE $3)::date, true
         FROM posts p
         LEFT JOIN rep_arrivals a ON a.id = p.arrival_id
        WHERE p.twin_id = $1
          AND ((p.arrival_id IS NOT NULL AND a.seat_id = $2) OR p.unasked)
          AND p.on_post_id IS NULL
     ),
     page_days AS (
       SELECT DISTINCT day FROM kept
        WHERE day <= COALESCE($4::date, ($5::timestamptz AT TIME ZONE $3)::date)
        ORDER BY day DESC
        LIMIT $7
     )
     SELECT id, occurred_at, text_enc, disposition, day::text AS day, own
       FROM kept
      WHERE day IN (SELECT day FROM page_days)
     UNION ALL
     -- THE CURSOR RIDES AS ONE MORE ROW with no message on it: the newest day
     -- before this page that holds anything, or none. Its id is NULL, which is
     -- how the loop below tells it from an entry.
     SELECT NULL, NULL, NULL, NULL, max(day)::text, NULL
       FROM kept
      WHERE day < (SELECT min(day) FROM page_days)
     ORDER BY occurred_at NULLS LAST, id`,
    [
      deps.twinId,
      page.seatId,
      zone,
      page.until ?? null,
      page.now,
      [...LEFT_NOTHING],
      EXCHANGE_DAYS_PER_PAGE,
    ],
  );
  const rows = res.rows.filter((row) => row.id !== null);
  const nextUntil = res.rows.find((row) => row.id === null)?.day ?? null;
  const replies = await readRepliesAtTheDoor(
    deps,
    rows.filter((row) => !row.own).map((row) => row.id),
    page.now,
  );
  const lines = await readPostsByIds(
    deps,
    rows.filter((row) => row.own).map((row) => row.id),
    page.now,
  );
  const days: ExchangeDay[] = [];
  for (const row of rows) {
    const entry = row.own ? ownLineOf(lines.get(row.id)) : exchangeOf(deps, row, replies.get(row.id));
    if (entry === undefined) continue;
    const last = days.at(-1);
    if (last?.day === row.day) {
      (last.exchanges as (Exchange | OwnLine)[]).push(entry);
    } else {
      days.push({ day: row.day, exchanges: [entry] });
    }
  }
  return {
    today: today.rows[0]!.today,
    days,
    ...(nextUntil === null ? {} : { nextUntil }),
  };
}

/** A message row, opened, with the reply it was answered with when one landed. */
function exchangeOf(deps: ExchangeDeps, row: EntryRow, reply: FeedPost | undefined): Exchange {
  return {
    messageId: row.id,
    at: row.occurred_at,
    // A MESSAGE ROW ALWAYS CARRIES ITS WORDS: the column is NOT NULL, and only
    // a line's row selects NULL in its place.
    text: Buffer.from(deps.dek.decrypt(row.text_enc!)).toString("utf8"),
    ...(reply === undefined ? {} : { reply }),
    // THE MARKER'S PRESENCE ENDS THE WAIT, whatever it says (ticket #261):
    // an unmarked message is the twin still thinking, which is what a page
    // resumes waiting on after a reload.
    ...(row.disposition === null ? {} : { settled: true as const }),
  };
}

/** A line's post as an entry — none when it was not opened under this twin. */
function ownLineOf(post: FeedPost | undefined): OwnLine | undefined {
  return post === undefined ? undefined : { line: post };
}

/**
 * The read model, projected onto the wire — the feed's own rule, one read over
 * (`feedPageOnTheWire` argues why naming every field is what makes the pin in
 * `feed-wire.test.ts` possible).
 */
export function exchangesOnTheWire(read: Exchanges, onCanvas: ReadonlySet<string> = new Set()): TwinExchanges {
  return {
    today: read.today,
    days: read.days.map((day) => ({
      day: day.day,
      exchanges: day.exchanges.map((entry) => exchangeOnTheWire(entry, onCanvas)),
    })),
    ...(read.nextUntil === undefined ? {} : { nextUntil: read.nextUntil }),
  };
}

/**
 * One entry onto the wire: every name opens the card the twin wrote beside
 * it while that card is on the canvas at this read (tickets #321, #401), so a
 * name in yesterday's answer stops leading anywhere once its card settles.
 */
function exchangeOnTheWire(entry: Exchange | OwnLine, onCanvas: ReadonlySet<string>): TwinExchange | TwinOwnLine {
  if ("line" in entry) return { line: feedPostOnTheWire(entry.line, onCanvas) };
  const exchange = entry;
  return {
    messageId: exchange.messageId,
    at: exchange.at.toISOString(),
    text: exchange.text,
    ...(exchange.reply === undefined
      ? {}
      : { reply: feedPostOnTheWire(exchange.reply, onCanvas) }),
    ...(exchange.settled === undefined ? {} : { settled: exchange.settled }),
  };
}
