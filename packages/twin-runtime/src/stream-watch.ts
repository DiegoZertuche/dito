/**
 * WHAT THE CANVAS HEARS BETWEEN READS: A POST LANDED, A SEND WAITS, A SEND
 * FAILED (ticket #266; spec #258 decision 14).
 *
 * The seat's stream carries `arrived` for every proactive post that lands on
 * the canvas — a draft, a binding question, the day's notes — and every
 * customer send's outcome (`recentSends`): `queued` while the rail is down,
 * `failed`, `held`, and `sent` too — the confirmation sweep publishes `sent`
 * the moment it commits, and this is what tells it again if that publish was
 * lost between the commit and the bus (Codex r3); a page hears a final word
 * twice as once. This is where the loop notices each, once per pass, from the
 * store.
 *
 * ═══ ONE PLACE, AFTER EVERY COMMIT BY CONSTRUCTION
 *
 * A proactive post is written by eight callers of `insertPost` across the
 * consumer, the thread, the disclosure and the dashboard acts, each inside a
 * transaction its caller owns. A publisher at each would be eight places to
 * keep «after the commit» true; this reads what is COMMITTED — a row another
 * transaction has not committed is invisible to it — so an event here can
 * never be about a row that rolls back, whoever wrote it. What it costs is the
 * loop's interval: a card reaches an open page up to one pass after it lands.
 *
 * ═══ MEMORY IS PER PROCESS, AND THAT IS THE CONTRACT
 *
 * Which posts and sends it has already told about lives here and nowhere
 * else. Events are ephemeral (`seat-events.ts`): a page that was not listening
 * reads the canvas when it opens. The FIRST pass of a process tells about
 * everything that waits, because a post committed between a page's reconnect
 * read and that pass would otherwise reach nobody; a page that already holds a
 * card hears its `arrived` as nothing (the canvas's reducer dedupes by id), so
 * the replay costs frames and changes no page.
 *
 * IT NEVER STOPS THE LOOP. An event is a courtesy to an open page; the store
 * is the truth, and a page that missed one reads it. A pass whose watch
 * failed tells nobody and tries again next pass.
 *
 * ═══ THE TWIN THREAD HEARS THE SAME NEWS (ticket #319; spec #318 decision 11)
 *
 * Every card that lands is a `post.landed` event in the day's session,
 * and every send's outcome a `post.settled` — told here for the reason the
 * page is told here: this is the one place that sees only committed rows,
 * whoever wrote them. A card one of the thread's own turns wrote is never
 * told back to it — the thread would wake on its own act for ever. Unlike
 * the page, the thread is not told what already waited when the process
 * started: a restart is not news, and a turn per standing card would be a
 * model call each for nothing.
 */
import type { TwinSendOutcome } from "@dito/seam";
import type pg from "pg";
import {
  isCanvasKind,
  readOnCanvas,
  recentSends,
  stillWaits,
  waitingCandidates,
} from "./canvas.js";
import {
  feedPostOnTheWire,
  readPostsByIds,
  type FeedDeps,
} from "./feed.js";
import type { SeatEvents } from "./seat-events.js";
import {
  THREAD_ARRIVAL_WAKE,
  THREAD_EVENT_WAKE,
  THREAD_MESSAGE_WAKE,
} from "./thread/automation.js";
import type { RaisedThreadEvent, ThreadEventSink } from "./thread/events.js";

/** What the watch needs: the store, the key that opens a card, the bus, the thread. */
export interface StreamWatchDeps extends FeedDeps {
  readonly db: pg.ClientBase;
  readonly events?: SeatEvents;
  readonly thread?: ThreadEventSink;
}

/** The send words the watch tells (`recentSends`). */
type SendNews = TwinSendOutcome["outcome"];

/** The watch's memory for one process. */
export interface StreamWatch {
  /** One pass: tell the seat what landed and what the rail did to its sends. */
  tick(deps: StreamWatchDeps, now: Date): Promise<void>;
}

export function createStreamWatch(): StreamWatch {
  // THE CANDIDATES ALREADY TOLD — published as `arrived`, or opened and found
  // not to belong (an answered question stays a candidate in SQL for ever). A
  // post leaves the set when it stops being a candidate, so the set is the
  // size of what waits. A post joins it only once its event was published.
  const toldPosts = new Set<string>();
  // ...and the sends already told, by command, with the word.
  const toldSends = new Map<string, SendNews>();
  // ...and, for the thread, the cards it was told landed. What already stood
  // when this process started is not news (the header argues it); what was
  // posted after — the first pass's own drafts included (Codex r2) — is.
  const toldThread = new Set<string>();
  const startedAt = new Date();
  return {
    async tick(deps, now) {
      const events = deps.events;
      if (events === undefined && deps.thread === undefined) return;
      try {
        const candidates = await waitingCandidates(deps, now);
        if (deps.thread !== undefined) {
          const standing = new Set(candidates);
          for (const id of toldThread) if (!standing.has(id)) toldThread.delete(id);
          const fresh = candidates.filter((id) => !toldThread.has(id));
          for (const landed of await landingsOf(deps, fresh, startedAt)) {
            deps.thread.raise(deps.twinId, landed);
          }
          for (const id of fresh) toldThread.add(id);
        }
        const seat = events === undefined ? undefined : await seatOf(deps);
        if (events !== undefined && seat !== undefined) {
          const standing = new Set(candidates);
          for (const id of toldPosts) if (!standing.has(id)) toldPosts.delete(id);
          const fresh = candidates.filter((id) => !toldPosts.has(id));
          const opened = await readPostsByIds(deps, fresh, now);
          // A CARD'S OWN WORDS MAY NAME A CUSTOMER WITH A CARD BESIDE THEM
          // (ticket #401): linked while that card is on the canvas.
          const onCanvas = fresh.length === 0 ? new Set<string>() : await readOnCanvas(deps, now);
          for (const id of fresh) {
            const post = opened.get(id);
            if (post !== undefined && isCanvasKind(post) && stillWaits(post)) {
              events.publish(seat, {
                kind: "arrived",
                post: feedPostOnTheWire(post, onCanvas),
              });
            }
            // TOLD ONLY ONCE ITS EVENT IS OUT — or once it is known not to
            // belong — so a pass that fails before here tells it next pass.
            toldPosts.add(id);
          }
        }
        const sends = await recentSends(deps, now);
        const current = new Set(sends.map((send) => send.commandId));
        for (const id of toldSends.keys()) if (!current.has(id)) toldSends.delete(id);
        for (const send of sends) {
          if (toldSends.get(send.commandId) === send.outcome) continue;
          if (events !== undefined && seat !== undefined) {
            events.publish(seat, {
              kind: "settle",
              postId: send.postId,
              outcome: send.outcome,
            });
          }
          // A SEND'S OUTCOME IS THE RAIL'S, never the rep's act on the card:
          // the thread hears it and is not woken by it (`thread/events.ts`).
          deps.thread?.raise(deps.twinId, {
            kind: "post.settled",
            postId: send.postId,
            outcome: send.outcome,
            byRep: false,
          });
          toldSends.set(send.commandId, send.outcome);
        }
      } catch {
        // The store is the truth, and a page that missed this reads it; what
        // was not published is not marked told, so the next pass tells it.
      }
    },
  };
}

/**
 * The landings to tell the thread among `ids`: each post's kind and the
 * occasion of the execution that wrote it (`code` where none did) — and
 * never a post one of the thread's own turns wrote.
 */
async function landingsOf(
  deps: StreamWatchDeps,
  ids: readonly string[],
  since: Date,
): Promise<readonly RaisedThreadEvent[]> {
  if (ids.length === 0) return [];
  const rows = await deps.db.query<{ id: string; kind: string; source: string | null }>(
    `SELECT p.id,
            CASE WHEN p.draft_id IS NOT NULL THEN 'draft'
                 WHEN p.question_subject IS NOT NULL THEN 'question'
                 ELSE COALESCE(n.kind, 'post') END AS kind,
            e.trigger_kind AS source
       FROM posts p
       LEFT JOIN notices n ON n.id = p.notice_id
       LEFT JOIN executions e ON e.id = p.execution_id
      WHERE p.twin_id = $1 AND p.id = ANY($2::uuid[]) AND p.posted_at >= $3
      ORDER BY p.posted_at, p.id`,
    [deps.twinId, [...ids], since],
  );
  return rows.rows
    .filter((row) => !THREAD_OCCASIONS.includes(row.source ?? ""))
    // A RUN'S REPORT IS TOLD AS THE RUN'S END (ticket #326): `run.finished`
    // names it, so it never wakes a second turn as a card that landed.
    .filter((row) => !(row.kind === "answer" && row.source === "run_step"))
    .map((row) => ({
      kind: "post.landed",
      postId: row.id,
      postKind: row.kind,
      source: row.source ?? "code",
    }));
}

/** The occasions of the twin thread's own turns, whose posts it is never told back. */
const THREAD_OCCASIONS: readonly string[] = [
  THREAD_MESSAGE_WAKE.occasion,
  THREAD_EVENT_WAKE.occasion,
  THREAD_ARRIVAL_WAKE.occasion,
];

/** The twin's one seat (`seats_one_seat_per_twin`), or none. */
async function seatOf(deps: StreamWatchDeps): Promise<string | undefined> {
  const rows = await deps.db.query<{ id: string }>(
    "SELECT id FROM seats WHERE twin_id = $1",
    [deps.twinId],
  );
  return rows.rows[0]?.id;
}
