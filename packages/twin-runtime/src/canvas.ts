/**
 * WHAT WAITS ON THE REP, AND THE TWIN'S LAST WORD ABOUT IT (ticket #266; spec
 * #258 decisions 12 and 15; ADR-0044 as amended; ADR-0010).
 *
 * Inicio is a canvas of what waits on the rep — the drafts nobody has sent or
 * discarded, the binding questions still open, the day's notes while a line
 * can still be taken back — curated by the twin thread's `spotlight` (ticket
 * #320). This is the read that answers all three questions the canvas asks
 * the lease holder: which posts wait, what the twin last said and in what
 * order it put them, and two typed facts about what waits.
 *
 * ═══ «WHAT WAITS» IS A QUESTION ABOUT THE STORE
 *
 * The feed is a page of posts newest first, and «waits» is not a property of
 * a post: a draft waits until a tap or a dismissal names it, a question until
 * one of three authorities answers it (`bindingQuestionState`), the day's
 * notes until their window shuts. So the candidates are chosen in SQL from
 * what is plaintext — a draft with no tap and no dismissal, a post whose
 * subject is a binding, the day's post of the last few days — and the rest is
 * decided on the OPENED post, by the same reads the feed uses, so a card here
 * and a card anywhere else can never disagree about whether it is answered.
 *
 * ═══ WHAT IS NOT HERE, BY KIND
 *
 * An answer, a receipt, a knock and the arrival line are not what waits:
 * they are things that happened. They drop out by kind — which is what takes
 * a pre-6b answer post off Inicio (spec #258 decision 12) — because a post
 * with no draft, no question and no numbered lines is never a candidate.
 */
import {
  readRailState,
  type TwinArrival,
  type TwinCardNote,
  type TwinArrivalFacts,
  type TwinCanvas,
  type TwinCuration,
  type TwinSpotlight,
  type TwinSendOutcome,
} from "@dito/seam";
import type pg from "pg";
import { CORRECTION_WINDOW_HOURS } from "@dito/aperture";
import {
  feedPostOnTheWire,
  mentionOnTheWire,
  readPostsByIds,
  type FeedDeps,
  type FeedPost,
  type OpenedMention,
} from "./feed.js";
import { openSealedParts } from "./posts.js";
import { keepMarksOn } from "./thread/references.js";

/**
 * How long after its send reached the rep a day's notes stay a candidate, in
 * ms — the correction window itself (`CORRECTION_WINDOW_HOURS`), which is what
 * decides whether a line can still be taken back.
 *
 * A DAY'S NOTES ARE A CANDIDATE BY THEIR SEND AND THEIR WINDOW, NEVER BY AGE:
 * a post whose send has not reached the rep — still waiting on a long rail
 * outage, refused, or unconfirmed — has not opened its window, and every fact
 * line on it is still correctable however old it is; one whose send reached
 * the rep is a candidate while its window runs. What
 * the SQL admits is re-decided on the opened post (`stillWaits`).
 */
const NOTES_WINDOW_MS = CORRECTION_WINDOW_HOURS * 60 * 60 * 1000;

/**
 * HOW LONG A POST THAT HANDS THE REP A DOCUMENT OR A LIST STAYS A CARD, in ms
 * (ticket #326; spec #318 decision 25 — «a run posts its own result (a
 * report, a document, a draft card) directly to the canvas»): a run's report,
 * or the twin's answer when its turn wrote a document.
 *
 * A DAY: a document or a list is something to open and read, not an answer
 * the rep owes, so no act of the rep's settles it; it is on the canvas for the
 * twenty-four hours after it landed unless the rep's «Listo» or the twin's
 * curation took it off first (ticket #368), and stays in the self-chat, in Mi
 * libreta's documents and, for a run, in Trabajos en curso's history. A post
 * that is prose alone is no card.
 */
const REPORT_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * How far back a customer send's outcome is news for a card, in ms.
 *
 * AN HOUR: a page that pressed Enviar waits on the outcome for seconds, and a
 * page that missed its `settle` reads it on its next read — an hour covers a
 * stream that was down or a runtime that restarted in between, and keeps the
 * query small on a twin with a long history of sends.
 */
const SEND_NEWS_MS = 60 * 60_000;

/** The canvas as the runtime reads it: instants still `Date`s. */
export interface Canvas {
  /** What waits, oldest first. */
  readonly waiting: readonly FeedPost[];
  readonly sends: readonly TwinSendOutcome[];
  readonly kept?: FeedPost;
  readonly arrival?: CanvasLine;
  /** The twin's current curation, absent while it has written none. */
  readonly curation?: Curation;
  /** The card the twin holds up now (ticket #401), absent while none is. */
  readonly spotlight?: Spotlight;
  readonly facts: TwinArrivalFacts;
}

/**
 * THE SPOTLIGHT (ticket #401; ruled by Diego 2026-10-13): the one card the twin
 * holds up for the rep — lifted on Inicio, the others stepping back, the twin's mark
 * beside it — and since when. Never first place, which is the arrangement's
 * top card (`Curation.spotlight`, a stored name).
 */
export interface Spotlight {
  readonly postId: string;
  readonly since: Date;
}

/**
 * The spotlight now, or none: the newest version the twin wrote, while its card
 * still waits and no arrangement since took it off. Its card leaving ends it
 * here, at the read; nothing the rep does with the twin's mark writes anything.
 */
export async function readSpotlight(
  deps: FeedDeps,
  now: Date,
): Promise<Spotlight | undefined> {
  const rows = await deps.db.query<{ post_id: string | null; written_at: Date; taken_off: boolean }>(
    `SELECT s.post_id, s.written_at,
            -- TAKEN OFF SINCE IT BEGAN, by any arrangement written after it:
            -- a card placed again later does not bring its spotlight back.
            EXISTS (SELECT 1 FROM canvas_curations c
                     WHERE c.twin_id = s.twin_id AND c.written_at >= s.written_at
                       AND s.post_id = ANY(c.left_posts)) AS taken_off
       FROM canvas_spotlights s
      WHERE s.twin_id = $1
      ORDER BY s.id DESC
      LIMIT 1`,
    [deps.twinId],
  );
  const row = rows.rows[0];
  if (row === undefined || row.post_id === null || row.taken_off) return undefined;
  // THE SAME STILL-WAITING SET THE CANVAS READ DRAWS (Codex r3): an answered
  // binding question is a candidate the opened read drops, and so does this.
  const waiting = await readWaiting(deps, now);
  return waiting.some((post) => post.id === row.post_id) ? { postId: row.post_id, since: row.written_at } : undefined;
}

/** Writes one version of the spotlight, inside the caller's transaction — `null` ends it. */
export async function writeSpotlight(
  deps: Pick<FeedDeps, "db">,
  spotlight: { readonly twinId: string; readonly executionId: string; readonly postId: string | null },
): Promise<void> {
  await deps.db.query(
    "INSERT INTO canvas_spotlights (twin_id, post_id, execution_id) VALUES ($1, $2, $3)",
    [spotlight.twinId, spotlight.postId, spotlight.executionId],
  );
}

/** The spotlight onto the wire. */
export function spotlightOnTheWire(spotlight: Spotlight): TwinSpotlight {
  return { postId: spotlight.postId, since: spotlight.since.toISOString() };
}

/**
 * THE TWIN'S LAST LINE FOR THE SEAT (ticket #320; ADR-0044 as amended): the
 * arrival line, or the line a turn the seam's events woke said unasked — one
 * kind, door-only, rendered in one place on Inicio. `arrivalId` is present
 * exactly on the arrival line.
 */
export interface CanvasLine {
  readonly postId: string;
  readonly arrivalId?: string;
  readonly at: Date;
  readonly day: string;
  readonly line: string;
  /** The customers the line names by reference (ticket #321), linked at read. */
  readonly mentions?: readonly OpenedMention[];
}

/**
 * THE CANVAS'S CURATION (ticket #320): the top card and the order of the
 * rest, by post id, as the thread's `move_cards` tool last wrote it (ticket
 * #401). `spotlight` is the top card's stored name (`canvas_curations.spotlight`),
 * kept for the rows already written; it is never the spotlight (`Spotlight`).
 *
 * A POST IT NAMES MAY HAVE SETTLED SINCE, and the canvas skips it: the
 * curation is what the twin decided then, and the canvas draws only what still
 * waits — with the age order behind it (spec #258 decision 15).
 */
export interface Curation {
  /** The version's own number, rising with every write (`canvas_curations.id`). */
  readonly version: number;
  readonly spotlight?: string;
  readonly order: readonly string[];
  /**
   * The twin's lean-in sentence per card it offered something on (ticket
   * #322), in the order it gave them; empty when it offered nothing.
   */
  readonly offers: readonly CurationOffer[];
  /**
   * The cards the twin took off the canvas (ticket #368), as they stand after
   * this version: each stays off until a later version places it in its
   * order. Empty when it took none.
   */
  readonly left: readonly string[];
  readonly at: Date;
}

/**
 * One lean-in offer: the card, and the twin's one sentence about it (ticket
 * #322) — as the twin wrote it, its references and marks standing, with the
 * customers it names (ticket #404), so a page draws it as every other line of
 * the twin's. An offer sealed before #404 holds the names already in its
 * words and no mentions.
 */
export interface CurationOffer {
  readonly postId: string;
  readonly sentence: string;
  readonly mentions?: readonly OpenedMention[];
}

/**
 * The whole canvas for one seat.
 *
 * `keep` IS A POST THE PAGE MUST DRAW WHATEVER ITS STATE — the card an act
 * without script just landed on (`TWIN_API_KEEP_PARAM`). It is answered only
 * when it is this twin's post and a kind the canvas draws, so it opens no
 * answer, no receipt and nobody else's post.
 */
export async function readCanvas(
  deps: FeedDeps,
  read: { readonly seatId: string; readonly now: Date; readonly keep?: string },
): Promise<Canvas> {
  const waiting = await readWaiting(deps, read.now);
  const line = await readLastLine(deps, { seatId: read.seatId });
  const curation = await readCuration(deps);
  const spotlight = await readSpotlight(deps, read.now);
  const arrival = line;
  const sends = (await recentSends(deps, read.now)).map(({ postId, outcome }) => ({
    postId,
    outcome,
  }));
  let kept: FeedPost | undefined;
  if (read.keep !== undefined && !waiting.some((post) => post.id === read.keep)) {
    const found = (await readPostsByIds(deps, [read.keep], read.now)).get(read.keep);
    if (found !== undefined && isCanvasKind(found)) kept = found;
  }
  return {
    waiting,
    sends,
    ...(spotlight === undefined ? {} : { spotlight }),
    ...(kept === undefined ? {} : { kept }),
    ...(arrival === undefined ? {} : { arrival }),
    ...(curation === undefined ? {} : { curation }),
    facts: factsOf(waiting, curation),
  };
}

/**
 * WHAT INICIO SHOWS: the cards that wait, less the ones the twin's latest
 * curation took off the canvas — where words the twin marked may lead
 * (ticket #401; `keepMarksOn`). Code chooses no card from it.
 */
export function onCanvasOf(
  waiting: readonly FeedPost[],
  curation: Pick<Curation, "left"> | undefined,
): ReadonlySet<string> {
  const left = new Set(curation?.left ?? []);
  return new Set(waiting.flatMap((post) => (left.has(post.id) ? [] : [post.id])));
}

/** ...read now. */
export async function readOnCanvas(deps: FeedDeps, now: Date): Promise<ReadonlySet<string>> {
  return onCanvasOf(await readWaiting(deps, now), await readCuration(deps));
}


/**
 * The last hour's customer sends and the settle word each outcome is, oldest
 * first — the watch's news and the read's catch-up, one query.
 *
 * EACH OUTCOME AS ITSELF (ADR-0006): `sent` the rail's ack, `failed` a
 * refusal, `held` an ack that never came — unknown, never `failed` — and a
 * send still waiting is `queued` only while the rail is down (with the rail
 * up it is simply in flight, and says nothing yet).
 */
export async function recentSends(
  deps: Pick<FeedDeps, "db" | "twinId">,
  now: Date,
): Promise<readonly (TwinSendOutcome & { readonly commandId: string })[]> {
  const rail = await readRailState(deps.db, deps.twinId);
  const railDown = rail.status === "dropped" || rail.status === "logged_out";
  const rows = await deps.db.query<{
    id: string;
    post_id: string;
    outcome: "sent" | "failed" | "held" | null;
  }>(
    `SELECT sc.id, p.id AS post_id, sc.outcome
       FROM send_commands sc
       JOIN posts p ON p.draft_id = sc.draft_id AND p.twin_id = sc.twin_id
      WHERE sc.twin_id = $1
        AND sc.send_class = 'customer_send'
        AND sc.created_at > $2
        AND (sc.outcome IS NOT NULL OR $3)
      ORDER BY sc.created_at, sc.id`,
    [deps.twinId, new Date(now.getTime() - SEND_NEWS_MS), railDown],
  );
  return rows.rows.map((row) => ({
    commandId: row.id,
    postId: row.post_id,
    outcome: row.outcome ?? "queued",
  }));
}

/**
 * Every post that waits on the rep, opened, oldest first.
 *
 * TWO STEPS AND THE SECOND IS THE FEED'S OWN: the candidates are ids chosen
 * from plaintext (`waitingCandidates`), and whether each still waits is
 * decided on the post as the feed opens it (`stillWaits`).
 */
export async function readWaiting(
  deps: FeedDeps,
  now: Date,
): Promise<readonly FeedPost[]> {
  const ids = await waitingCandidates(deps, now);
  const opened = await readPostsByIds(deps, ids, now);
  const waiting: FeedPost[] = [];
  for (const id of ids) {
    const post = opened.get(id);
    if (post !== undefined && stillWaits(post)) waiting.push(post);
  }
  return waiting;
}

/**
 * The ids of every post that MAY wait, oldest first — plaintext only, so the
 * question is cheap enough for the stream's watch to ask on every pass.
 *
 * A DRAFT WAITS UNTIL A TAP OR A DISMISSAL NAMES IT, OR A FILL TOOK ITS
 * PLACE, read in one statement for `readDraft`'s reason (`thread/reads.ts`):
 * two reads could see a state that never held (a fill: ticket #342,
 * `thread/fill.ts`). A BINDING QUESTION IS A CANDIDATE UNTIL ITS
 * OPENED PART SAYS IT IS ANSWERED, because two of its three authorities are
 * the bundle and a sealed payload. THE DAY'S NOTES are a candidate while their send waits or
 * their window runs (`NOTES_WINDOW_MS`). A RUN'S QUESTION CARD is one while a
 * step of a run that has not ended waits on it unanswered (ticket #324); A
 * RUTINA'S PROPOSAL CARD while the rutina it names is pending and live (ticket
 * #386). A
 * RUN'S REPORT OR AN ANSWER OF THE TWIN'S, at either door, is one for its day
 * (`REPORT_WINDOW_MS`), and a card only when its opened parts hand the rep a
 * document or a list (ticket #326) — until the rep's «Listo» took it off, the
 * performed `clear_card` row (ticket #368).
 *
 * NEVER AN ARRIVAL POST: it is the twin's line at the dashboard's door, and
 * nothing the rep acts on.
 */
export async function waitingCandidates(
  deps: Pick<FeedDeps, "db" | "twinId">,
  now: Date,
): Promise<readonly string[]> {
  const rows = await deps.db.query<{ id: string }>(
    `SELECT p.id
       FROM posts p
       LEFT JOIN notices n ON n.id = p.notice_id
      WHERE p.twin_id = $1
        AND (
         (p.asked_on IS DISTINCT FROM 'dashboard'
        AND (
              (p.draft_id IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM taps t WHERE t.draft_id = p.draft_id)
               AND NOT EXISTS (
                     SELECT 1 FROM draft_dismissals x WHERE x.draft_id = p.draft_id)
               AND NOT EXISTS (
                     SELECT 1 FROM draft_fills f WHERE f.draft_id = p.draft_id))
           OR p.question_subject = 'binding'
           OR (n.kind = 'ask'
               AND EXISTS (
                     SELECT 1 FROM run_steps s JOIN runs r ON r.id = s.run_id
                      WHERE s.awaits_post_id = p.id AND s.state = 'waiting'
                        AND s.kind IN ('ask', 'agent')
                        AND s.answered_at IS NULL AND r.ended_at IS NULL))
           OR (n.kind = 'proposal'
               AND EXISTS (
                     SELECT 1 FROM automations a
                      WHERE a.twin_id = p.twin_id AND a.proposal_post_id = p.id
                        AND a.state = 'pending' AND a.ended_at IS NULL))
           OR (n.kind = 'daily_disclosure'
               AND EXISTS (
                     SELECT 1 FROM send_commands sc
                      WHERE sc.twin_id = p.twin_id
                        AND sc.payload_ref = 'notice:' || n.id
                        AND (sc.outcome IS DISTINCT FROM 'sent'
                             OR sc.executed_at > $2)))
            ))
         OR (p.parts_enc IS NOT NULL
             AND p.posted_at > $3
             AND (n.kind = 'answer' OR (p.asked_on = 'dashboard' AND p.arrival_id IS NULL))
             AND NOT EXISTS (
                   SELECT 1 FROM dashboard_acts a
                    WHERE a.twin_id = p.twin_id AND a.post_id = p.id
                      AND a.verb = 'clear_card' AND a.outcome = 'performed'))
        )
      ORDER BY p.posted_at, p.id`,
    [deps.twinId, new Date(now.getTime() - NOTES_WINDOW_MS), new Date(now.getTime() - REPORT_WINDOW_MS)],
  );
  return rows.rows.map((row) => row.id);
}

/**
 * Whether an opened candidate still waits: a question nobody answered, a
 * rutina's proposal nobody accepted or discarded, notes with a line the rep
 * can still take back, a draft, or a run's report handing
 * the rep a document or a list (their candidacy already said they wait).
 */
export function stillWaits(post: FeedPost): boolean {
  for (const part of post.parts) {
    // AN ANSWERED QUESTION OFFERS NO ACTS — the feed decides the answer and
    // the empty list together (`openPart`), so the acts are the one reading.
    if (part.kind === "question") return part.acts.includes("confirm");
    if (part.kind === "ask") return part.acts.includes("answer");
    if (part.kind === "proposal") return part.acts.includes("activate");
    if (part.kind === "record-lines") {
      return part.lines.some((line) => line.retractable);
    }
    if (part.kind === "draft") return true;
    // A RUN'S REPORT WITH A DOCUMENT OR A LIST (ticket #326): its window is
    // its candidacy, and the opened parts say whether it is a card at all.
    if (part.kind === "document" || part.kind === "data") return true;
  }
  return false;
}

/** Whether a post is a kind the canvas draws at all, whatever its state. */
export function isCanvasKind(post: FeedPost): boolean {
  return post.parts.some(
    (part) =>
      part.kind === "draft" ||
      part.kind === "question" ||
      part.kind === "ask" ||
      part.kind === "proposal" ||
      part.kind === "record-lines" ||
      part.kind === "document" ||
      part.kind === "data",
  );
}

/**
 * Who a waiting post is about: a draft's counterparty, which the read always
 * supplies (#298), or a question's name — or nobody, where a question carries
 * none (ADR-0034: an absent field is NOT RECORDED THEN).
 *
 * THE DRAFT'S COUNTERPARTY OR THE QUESTION'S PROPOSED NAME, and the chat's
 * own name where the question proposed none. The day's notes are about many
 * customers and name none of them as THE one.
 */
export function counterpartyOf(post: FeedPost): string | undefined {
  for (const part of post.parts) {
    if (part.kind === "draft") return part.counterparty;
    if (part.kind === "question") return part.proposedName ?? part.chatName;
  }
  return undefined;
}

/**
 * The seat's last line — the arrival line, or a line the twin said unasked.
 *
 * THE SEAT SCOPES AN ARRIVAL LINE, AND THE TWIN AN UNASKED ONE: an arrival is
 * a seat's and its post names the arrival row, while a line no arrival asked
 * for belongs to the twin, which serves one seat. The day of an unasked line
 * is cut from its instant in the seat's zone, the arrival's own arithmetic.
 *
 * A SENTENCE THE TWIN SAID ON A CARD IS NO LINE OF THE PILL'S (ticket #340):
 * it is drawn under its card (`readNote`), so a post naming a card it is on
 * is never the seat's last line.
 */
export async function readLastLine(
  deps: Pick<FeedDeps, "db" | "twinId" | "dek" | "timeZone">,
  at: {
    readonly seatId: string;
    /** One arrival's line — what the stream's `curated` reads back after its commit. */
    readonly arrivalId?: string;
    /** ...or the line one execution wrote, and no later turn's (ticket #341). */
    readonly executionId?: string;
  },
): Promise<CanvasLine | undefined> {
  const rows = await deps.db.query<{
    id: string;
    posted_at: Date;
    parts_enc: Buffer;
    day: string;
    arrival_id: string | null;
  }>(
    `SELECT p.id, p.posted_at, p.parts_enc, a.id AS arrival_id,
            COALESCE(a.day, (p.posted_at AT TIME ZONE $4)::date)::text AS day
       FROM posts p
       LEFT JOIN rep_arrivals a ON a.id = p.arrival_id
      WHERE p.twin_id = $1
        AND ((p.arrival_id IS NOT NULL AND a.seat_id = $2) OR p.unasked)
        AND p.on_post_id IS NULL
        AND ($3::uuid IS NULL OR a.id = $3::uuid)
        AND ($5::uuid IS NULL OR p.execution_id = $5::uuid)
      ORDER BY p.posted_at DESC, p.id DESC
      LIMIT 1`,
    [
      deps.twinId,
      at.seatId,
      at.arrivalId ?? null,
      deps.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
      at.executionId ?? null,
    ],
  );
  const row = rows.rows[0];
  if (row === undefined) return undefined;
  // THE PROSE PART IS THE LINE. Older arrival posts also carry a `curation`
  // part; the layout comes from `canvas_curations` (`readCuration`), so
  // nothing here reads it.
  const line =
    openSealedParts(deps.dek, row.parts_enc).find((part) => part.kind === "prose");
  return {
    postId: row.id,
    ...(row.arrival_id === null ? {} : { arrivalId: row.arrival_id }),
    at: row.posted_at,
    day: row.day,
    line: line?.kind === "prose" ? line.text : "",
    ...(line?.kind === "prose" && line.mentions !== undefined ? { mentions: line.mentions } : {}),
  };
}

/** A sentence the twin said on one of its cards (ticket #340): a line, and the card it is on. */
export interface CardNote extends CanvasLine {
  readonly card: string;
}

/**
 * THE SENTENCE ONE EXECUTION SAID ON A CARD, its last when it said more than
 * one (ticket #340; `say_on_card`) — or nothing.
 */
export async function readNote(
  deps: Pick<FeedDeps, "db" | "twinId" | "dek" | "timeZone">,
  executionId: string,
): Promise<CardNote | undefined> {
  const rows = await deps.db.query<{
    id: string;
    on_post_id: string;
    posted_at: Date;
    parts_enc: Buffer;
    day: string;
  }>(
    `SELECT p.id, p.on_post_id, p.posted_at, p.parts_enc,
            (p.posted_at AT TIME ZONE $3)::date::text AS day
       FROM posts p
      WHERE p.twin_id = $1 AND p.execution_id = $2 AND p.on_post_id IS NOT NULL
      ORDER BY p.posted_at DESC, p.id DESC
      LIMIT 1`,
    [deps.twinId, executionId, deps.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone],
  );
  const row = rows.rows[0];
  if (row === undefined) return undefined;
  const line = openSealedParts(deps.dek, row.parts_enc).find((part) => part.kind === "prose");
  return {
    postId: row.id,
    card: row.on_post_id,
    at: row.posted_at,
    day: row.day,
    line: line?.kind === "prose" ? line.text : "",
    ...(line?.kind === "prose" && line.mentions !== undefined ? { mentions: line.mentions } : {}),
  };
}


/** A note onto the wire. */
export function noteOnTheWire(note: CardNote, onCanvas: ReadonlySet<string> = new Set()): TwinCardNote {
  return { ...arrivalOnTheWire(note, onCanvas), card: note.card };
}

/**
 * The twin's current curation: the newest version the `spotlight` tool wrote —
 * or, with `executionId`, the newest that execution wrote, so a turn's ending
 * carries its own curation and never one a turn beside it wrote (ticket #380).
 */
export async function readCuration(
  deps: Pick<FeedDeps, "db" | "twinId" | "dek">,
  options: { readonly executionId?: string } = {},
): Promise<Curation | undefined> {
  const rows = await deps.db.query<{
    id: string;
    spotlight: string | null;
    post_order: string[];
    offers_enc: Buffer | null;
    left_posts: string[];
    written_at: Date;
  }>(
    `SELECT id, spotlight, post_order, offers_enc, left_posts, written_at
       FROM canvas_curations
      WHERE twin_id = $1 AND ($2::uuid IS NULL OR execution_id = $2::uuid)
      ORDER BY id DESC
      LIMIT 1`,
    [deps.twinId, options.executionId ?? null],
  );
  const row = rows.rows[0];
  if (row === undefined) return undefined;
  return {
    version: Number(row.id),
    ...(row.spotlight === null ? {} : { spotlight: row.spotlight }),
    order: row.post_order,
    offers:
      row.offers_enc === null
        ? []
        : (
            JSON.parse(Buffer.from(deps.dek.decrypt(row.offers_enc)).toString("utf8")) as {
              post_id: string;
              sentence: string;
              mentions?: OpenedMention[];
            }[]
          ).map((offer) => ({
            postId: offer.post_id,
            sentence: offer.sentence,
            ...(offer.mentions === undefined || offer.mentions.length === 0 ? {} : { mentions: offer.mentions }),
          })),
    left: row.left_posts,
    at: row.written_at,
  };
}

/**
 * Writes one version of the curation, inside the caller's transaction.
 *
 * THE CALLER HAS CHECKED THE IDS: every one names a post of this twin's that
 * waits (`thread/canvas-tools.ts`), so a curation naming a post the seat does
 * not hold never reaches the store.
 */
export async function writeCuration(
  deps: Pick<FeedDeps, "db" | "dek">,
  curation: {
    readonly twinId: string;
    readonly executionId: string;
    readonly spotlight?: string;
    readonly order: readonly string[];
    /** The lean-in offers, sealed under the twin DEK; none is NULL (ticket #322). */
    readonly offers: readonly CurationOffer[];
    /** The cards off the canvas after this write, the whole set (ticket #368). */
    readonly left: readonly string[];
  },
): Promise<void> {
  const offers =
    curation.offers.length === 0
      ? null
      : deps.dek.encrypt(
          Buffer.from(
            JSON.stringify(
              curation.offers.map((offer) => ({
                post_id: offer.postId,
                sentence: offer.sentence,
                ...(offer.mentions === undefined || offer.mentions.length === 0 ? {} : { mentions: offer.mentions }),
              })),
            ),
            "utf8",
          ),
        );
  await deps.db.query(
    `INSERT INTO canvas_curations (twin_id, spotlight, post_order, offers_enc, execution_id, left_posts)
     VALUES ($1, $2, $3::uuid[], $4, $5, $6::uuid[])`,
    [
      curation.twinId,
      curation.spotlight ?? null,
      [...curation.order],
      offers,
      curation.executionId,
      [...curation.left],
    ],
  );
}

/**
 * Which of these posts the seat has looked at (ticket #320): rep-web's own
 * seen-stamps, read under the runtime's SELECT on `seen_marks`
 * (…20261004100010).
 */
export async function readSeen(
  db: pg.ClientBase,
  seatId: string,
  postIds: readonly string[],
): Promise<ReadonlyMap<string, Date>> {
  if (postIds.length === 0) return new Map();
  // THE LAST TIME THE REP SAW EACH ONE (ticket #401): the twin's card list says when.
  const rows = await db.query<{ subject_ref: string; seen_at: Date }>(
    `SELECT subject_ref, max(seen_at) AS seen_at FROM seen_marks
      WHERE seat_id = $1 AND subject_kind = 'post' AND subject_ref = ANY($2::text[])
      GROUP BY subject_ref`,
    [seatId, [...postIds]],
  );
  return new Map(rows.rows.map((row) => [row.subject_ref, row.seen_at] as const));
}

/** One card that stopped waiting in the last hour, and how. */
export interface RecentSettle {
  readonly postId: string;
  readonly outcome: TwinSendOutcome["outcome"] | "dismissed";
}

/**
 * The cards that stopped waiting in the last hour (ticket #320): a customer
 * send's outcome (`recentSends`) and a discard. What the twin reads to know a
 * card it was told about has settled since.
 */
export async function recentSettles(
  deps: Pick<FeedDeps, "db" | "twinId">,
  now: Date,
): Promise<readonly RecentSettle[]> {
  const sends = (await recentSends(deps, now)).map(
    ({ postId, outcome }): RecentSettle => ({ postId, outcome }),
  );
  const dismissed = await deps.db.query<{ id: string }>(
    `SELECT p.id
       FROM draft_dismissals x
       JOIN posts p ON p.draft_id = x.draft_id AND p.twin_id = $1
      WHERE x.created_at > $2
      ORDER BY x.created_at, p.id`,
    [deps.twinId, new Date(now.getTime() - SEND_NEWS_MS)],
  );
  return [
    ...sends,
    ...dismissed.rows.map((row): RecentSettle => ({ postId: row.id, outcome: "dismissed" })),
  ];
}

/**
 * Two facts about what waits: how many posts wait, and who the spotlight
 * is about — the twin's current spotlight while it still waits, else the
 * oldest post that waits, which is the canvas's own order by age.
 */
export function factsOf(
  waiting: readonly FeedPost[],
  curation: Curation | undefined,
): TwinArrivalFacts {
  // A CARD THE TWIN TOOK OFF THE CANVAS IS NOT COUNTED (ticket #368): the
  // facts say what Inicio shows.
  const left = new Set(curation?.left ?? []);
  const shown = waiting.filter((post) => !left.has(post.id));
  const curated = curation?.spotlight;
  const spotlight =
    shown.find((post) => post.id === curated) ?? shown[0];
  const name = spotlight === undefined ? undefined : counterpartyOf(spotlight);
  return { waiting: shown.length, ...(name === undefined ? {} : { spotlight: name }) };
}

/** The canvas onto the wire: every instant an ISO string (`TwinCanvas`). */
export function canvasOnTheWire(canvas: Canvas): TwinCanvas {
  // EVERY NAME OPENS THE CARD THE TWIN WROTE BESIDE IT while Inicio shows that
  // card (ticket #401).
  const onCanvas = onCanvasOf(canvas.waiting, canvas.curation);
  return {
    waiting: canvas.waiting.map((post) => feedPostOnTheWire(post, onCanvas)),
    sends: canvas.sends,
    ...(canvas.kept === undefined ? {} : { kept: feedPostOnTheWire(canvas.kept, onCanvas) }),
    ...(canvas.arrival === undefined
      ? {}
      : { arrival: arrivalOnTheWire(canvas.arrival, onCanvas) }),
    ...(canvas.curation === undefined
      ? {}
      : { curation: curationOnTheWire(canvas.curation) }),
    ...(canvas.spotlight === undefined ? {} : { spotlight: spotlightOnTheWire(canvas.spotlight) }),
    facts: canvas.facts,
  };
}

/** One line onto the wire. */
export function arrivalOnTheWire(line: CanvasLine, onCanvas: ReadonlySet<string> = new Set()): TwinArrival {
  return {
    postId: line.postId,
    ...(line.arrivalId === undefined ? {} : { arrivalId: line.arrivalId }),
    at: line.at.toISOString(),
    day: line.day,
    // ITS MARKED WORDS OPEN THEIR CARDS while those are on the canvas (ticket #401).
    line: keepMarksOn(line.line, onCanvas),
    ...(line.mentions === undefined ? {} : { mentions: line.mentions.map(mentionOnTheWire) }),
  };
}

/** The curation onto the wire. */
export function curationOnTheWire(curation: Curation): TwinCuration {
  return {
    version: curation.version,
    ...(curation.spotlight === undefined ? {} : { spotlight: curation.spotlight }),
    order: curation.order,
    ...(curation.left.length === 0 ? {} : { left: curation.left }),
    ...(curation.offers.length === 0
      ? {}
      : {
          offers: curation.offers.map((offer) => ({
            postId: offer.postId,
            sentence: offer.sentence,
            ...(offer.mentions === undefined ? {} : { mentions: offer.mentions.map(mentionOnTheWire) }),
          })),
        }),
  };
}
