/**
 * IS THIS BINDING QUESTION STILL OPEN — the three authorities, in one place
 * (ticket #268; remainder 1 of #256; spec #258 *Smaller items carried*).
 *
 * TWO SURFACES ASK THE SAME QUESTION AND THEY MUST NOT ANSWER IT
 * DIFFERENTLY. The feed draws a card's buttons from it — a question with an
 * answer offers none — and the canvas reads from it which question cards
 * still wait. A card that reads `declined` and a canvas that still offers it
 * would be one product contradicting itself on the same screen.
 *
 * ═══ THE THIRD AUTHORITY IS WHY THIS MODULE EXISTS ═══
 *
 * Two were already read (`questionAnswer` in `feed.ts`, before this ticket):
 * CONFIRMED is the bundle's entity mirror holding a binding for the
 * question's chat, and DECLINED-ON-A-CARD is a `dashboard_acts` row. The
 * thread's «no va» is NEITHER. It writes no act row and no binding — the
 * decline tool says so itself: "in the event's own processing marker
 * (`declined`) and in the receipt post beside it" (`thread/acts.ts`) — so a
 * question the rep declined on their phone went on reading as open on the
 * dashboard for ever. That is remainder 1 of #256.
 *
 * ═══ HOW THE THREAD'S DECLINE IS FOUND ═══
 *
 * The marker is on the REP's own message, not on the question — so the walk
 * is from the decline back to the post: which rail message did this twin's
 * question go out as, and does a declined message quote it. That is
 * `crossing-backlog.ts`'s own shape for `binding_confirmed`, read for the
 * other word, and it is a walk rather than a join because the quoted id lives
 * inside a sealed payload and Postgres cannot see it.
 *
 * IT IS BOUNDED AT BOTH ENDS. A question the rail never delivered has no
 * message id, so there is nothing to have quoted and the scan never runs. And
 * a decline cannot be RECEIVED before the question it declines was written, so
 * only rows this database took in after the post are opened. What is left is
 * one decode per decline this twin has made since that question — a handful,
 * because a binding question is asked once per chat, ever
 * (`bindingQuestionAsked`).
 *
 * `received_at` AND NOT `occurred_at`, which is the difference between a bound
 * and a bug. `occurred_at` is the SENDER'S clock off the rail, so a rep whose
 * phone runs a few minutes slow would stamp their «no va» before the post this
 * side wrote — and the card would read open for ever. `received_at` is this
 * database's own clock, the same one `posts.posted_at` is stamped from, and
 * the two are ordered by the world: the question is written, the executor
 * posts it, the rep reads it, and only then does their reply arrive here.
 */
import type { Bundle } from "@dito/bundle";
import type { Dek } from "@dito/crypto";
import { decodeWaMessagePayload } from "@dito/seam";
import type pg from "pg";

/** Confirmed, declined, or still waiting on the rep. */
export type BindingQuestionState = "open" | "confirmed" | "declined";

/** What this read needs: the seam, the twin, the key, and the mirror. */
export interface BindingQuestionDeps {
  readonly db: pg.ClientBase;
  readonly twinId: string;
  readonly dek: Dek;
  /**
   * THE ENTITY MIRROR, for the one authority the seam cannot answer.
   *
   * OPTIONAL, because a runtime can serve reads with no bundle open
   * (`FeedDeps.bundle` argues the pair): a question it cannot read a binding
   * for goes on offering its buttons to a surface whose presses it would
   * refuse anyway. BOTH declines still read, because both are on the seam.
   */
  readonly bundle?: Bundle;
}

/** The question being asked about: its card, its chat, and when it was asked. */
export interface AskedBindingQuestion {
  /** The `posts` row the question is on — what a dashboard decline names. */
  readonly postId: string;
  /** The chat the question is about, re-derived from its own anchor. */
  readonly chatJid: string;
  /** When the post was written — nothing before it can have answered it. */
  readonly askedAt: Date;
}

/**
 * Where one binding question stands.
 *
 * THE ORDER IS CONFIRMED, THEN DECLINED, and it is the rule #49 set for a
 * repeat answer: a chat that is bound is bound, and a «no» arriving after a
 * «sí» does not undo it (`declineBinding` refuses one outright). So the
 * mirror is asked first and a decline is only ever read for a chat nothing
 * bound.
 */
export async function bindingQuestionState(
  deps: BindingQuestionDeps,
  question: AskedBindingQuestion,
): Promise<BindingQuestionState> {
  // WITH NO ENTITY MIRROR THERE IS NO BINDING TO READ, so a confirmed
  // question goes on asking; both declines below read either way, because
  // their authority is on the seam.
  if (deps.bundle?.readChatBinding(question.chatJid) !== undefined) {
    return "confirmed";
  }
  if (await declinedOnACard(deps, question.postId)) return "declined";
  if (await declinedInTheThread(deps, question)) return "declined";
  return "open";
}

/** «No es este cliente» on the dashboard: one act row, one verb. */
async function declinedOnACard(
  deps: BindingQuestionDeps,
  postId: string,
): Promise<boolean> {
  const declined = await deps.db.query(
    `SELECT 1 FROM dashboard_acts
      WHERE twin_id = $1 AND post_id = $2 AND verb = 'decline_binding'
        AND outcome = ANY($3::text[])`,
    // `performed` AND `already` ARE THE TWO WORDS THAT MEAN IT HAPPENED, said
    // that way round rather than as «it was not refused» — `applyMarks` in
    // rep-web keeps the same rule over the same vocabulary.
    [deps.twinId, postId, ["performed", "already"]],
  );
  return declined.rows.length > 0;
}

/**
 * ...and «no va» in the twin thread: a `declined` marker on a rep message
 * that quoted this question.
 *
 * ONE DECODE PER CANDIDATE AND NO WAY AROUND IT: the quoted id is inside the
 * payload envelope under the twin DEK (ADR-0005/0008), so the filtering that
 * can happen in SQL — this twin, this word, after this post — happens there,
 * and the rest is `crossing-backlog.ts`'s own loop.
 */
async function declinedInTheThread(
  deps: BindingQuestionDeps,
  question: AskedBindingQuestion,
): Promise<boolean> {
  const posted = await deps.db.query<{ wa_message_id: string }>(
    `SELECT se.wa_message_id
       FROM posts p
       JOIN send_commands sc
         ON sc.twin_id = p.twin_id
        AND sc.payload_ref = 'notice:' || p.notice_id
        AND sc.send_class = 'system_send'
       JOIN send_executions se
         ON se.command_id = sc.id AND se.twin_id = p.twin_id
      WHERE p.id = $1 AND p.twin_id = $2`,
    [question.postId, deps.twinId],
  );
  // NOTHING WENT OUT, SO NOTHING CAN HAVE QUOTED IT. A question posted at the
  // dashboard's door alone, or one whose send has not resolved, is a question
  // the thread has never seen.
  if (posted.rows.length === 0) return false;
  const posts = new Set(posted.rows.map((row) => row.wa_message_id));
  const declines = await deps.db.query<{ payload_enc: Buffer }>(
    `SELECT e.payload_enc
       FROM wa_event_processing p
       JOIN wa_events e ON e.id = p.event_id
      WHERE p.twin_id = $1 AND p.disposition = 'declined'
        AND e.received_at >= $2`,
    [deps.twinId, question.askedAt],
  );
  for (const row of declines.rows) {
    const quoted = decodeWaMessagePayload(deps.dek, row.payload_enc)
      .quotedMessageId;
    if (quoted !== undefined && posts.has(quoted)) return true;
  }
  return false;
}

/**
 * The chat a binding question is about, re-derived from the question's own
 * anchor (ticket #255; #268 gave it a second reader and one home).
 *
 * THE ANCHOR IS THE CUSTOMER-CHAT EVENT the question part names, and its
 * sealed payload is where the chat lives — the same derivation
 * `askedQuestion` in `rep-acts.ts` makes before it confirms or declines
 * anything, so a surface and an act cannot disagree about which conversation
 * a question was about.
 *
 * NOTHING MEANS THIS TWIN DOES NOT HOLD THE EVENT, which draws the card
 * exactly as it drew before #255: no answer, no number, no name.
 */
export async function chatOfBindingQuestion(
  deps: Pick<BindingQuestionDeps, "db" | "twinId" | "dek">,
  aboutEventId: string,
): Promise<string | undefined> {
  const events = await deps.db.query<{ payload_enc: Buffer }>(
    "SELECT payload_enc FROM wa_events WHERE id = $1 AND twin_id = $2",
    [aboutEventId, deps.twinId],
  );
  const payloadEnc = events.rows[0]?.payload_enc;
  if (payloadEnc === undefined) return undefined;
  return decodeWaMessagePayload(deps.dek, payloadEnc).chatJid;
}
