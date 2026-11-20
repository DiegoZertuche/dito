/**
 * THE READS A THREAD TURN NEEDS BEFORE IT IS PUSHED (tickets #173, #319; spec
 * #171 decision 19).
 *
 * Context recipes are synchronous — `RecipeRenderer` returns a `NamedPart`,
 * not a promise — and what a turn points at lives behind an encrypted column:
 * the quoted post's words in a notice or a draft. So the
 * consumer performs these reads on the runtime's own connection before it
 * hands the turn to the lane; what reaches `ThreadDeps` is rows, decrypted.
 * The one read made for the SESSION rather than a turn is the carried
 * tail's material, which the day's session opens with (`tail.ts`).
 *
 * WHICH FIXES WHAT A TURN'S CONTEXT IS A SNAPSHOT OF: the post the rep pointed
 * at as it stood when the router reached their message, not as it stands when
 * the model happens to read it. The one thing that reads twin memory later is
 * the search tool, which is exactly the thing the model asked for.
 */
import type { Bundle } from "@dito/bundle";
import type { TwinApiBlankAbout, TwinApiLineAbout } from "@dito/seam";
import type { Dek } from "@dito/crypto";
import type pg from "pg";
import { isFramed } from "../grammar.js";
import { readRepliesAtTheDoor } from "../feed.js";
import {
  decodeWaMessagePayload,
  decodeWaOpaquePayload,
  decodeWaReactionPayload,
} from "../payload.js";
import { readDraftCard } from "../drafts.js";
import { readCardPost, readPostedPost, readPostedReplies } from "../twin-posts.js";
import type { DraftState, QuotedPost } from "./deps.js";
import { annotateNames } from "./references.js";
import type { TailItem } from "./tail.js";

/**
 * The quoted post, in the two shapes its two readers need: the identity the
 * TRIGGER carries, and what the RECIPE shows the model.
 *
 * ONE READ, TWO READERS, which is why they arrive together. The id and the
 * words come out of the same join, and asking twice would be two chances for
 * the record to name a post the prompt did not show.
 */
export interface QuotedTwinPost {
  /** The rep-side identity: what `TwinThreadMessageTrigger.quotedPostId` holds. */
  readonly id: string;
  /** What the `quoted_post` recipe renders. */
  readonly shown: QuotedPost;
  /**
   * The chat the quoted DRAFT was written for, when the rep quoted a draft
   * (ticket #175) — absent for every other kind of post. A rep who replies
   * to a Borrador with «hazme otro, más corto» has named a customer without
   * typing a name, and the consumer turns this into that customer's
   * reference for the turn (ticket #321).
   */
  readonly destination?: string;
}

/** What both reads need: one connection, the twin's key, and twin memory. */
export interface ThreadReadDeps {
  readonly db: pg.ClientBase;
  readonly dek: Dek;
  readonly twinId: string;
  readonly bundle: Bundle;
  readonly selfChatJid: string;
}

/**
 * THE TWO DOORS' LINES, the carried tail's material (ticket #319; spec #318
 * decisions 1 and 13; `tail.ts` argues what the tail is and why it is built
 * from rows).
 *
 * THE SELF-CHAT'S REP HALF IS IN TWIN MEMORY: every self-chat message is
 * ingested before routing decides anything (`ingestIntoTwinMemory`). FRAMED
 * ROWS ARE DROPPED — a rail that echoes one of the twin's own posts back
 * delivers it `from_me` in the self-chat, and `isFramed` is the structural
 * signal the matcher uses for the same thing — so the twin's half comes from
 * what the executor posted, once.
 *
 * THE BAR'S LINES ARE THE SEALED DOOR ROWS and its replies the posts asked at
 * the door — the same rows the bar's own history reads. A line whose turn
 * failed is not carried: the session dropped that turn, and the bar's
 * history does not show it either.
 *
 * NOTHING FROM THE FIRST LINE STILL WAITING ON, on either door. The wake that
 * opens the new session — and any line arriving with it — is pushed into
 * it as itself; carried as well, it would stand in the session twice.
 * Every earlier line has been answered or deliberately left, so the first
 * unconsumed one is where yesterday ends.
 */
export async function readTailMaterial(
  deps: ThreadReadDeps,
  limit: number,
): Promise<readonly TailItem[]> {
  // THE THREAD'S OWN DOORS ONLY (Codex r2): a customer message waiting out
  // its settle window is pending too, and is no line of the thread's — so a
  // pending seam event counts only when its sealed payload is the rep's own
  // self-chat. The seam carries no chat column (ADR-0004), so it is opened.
  const pendingEvents = await deps.db.query<{ occurred_at: Date; payload_enc: Buffer; event_type: string }>(
    `SELECT e.occurred_at, e.payload_enc, e.event_type
       FROM wa_events e
       LEFT JOIN wa_event_processing p ON p.event_id = e.id
      WHERE e.twin_id = $1 AND p.event_id IS NULL`,
    [deps.twinId],
  );
  const pendingDoor = await deps.db.query<{ first: Date | null }>(
    `SELECT min(m.occurred_at) AS first
       FROM dashboard_messages m
       LEFT JOIN dashboard_message_processing p ON p.message_id = m.id
      WHERE m.twin_id = $1 AND p.message_id IS NULL`,
    [deps.twinId],
  );
  const firsts = [
    ...pendingEvents.rows
      .filter((row) => selfChatOf(deps, row.event_type, row.payload_enc))
      .map((row) => row.occurred_at),
    ...(pendingDoor.rows[0]?.first ? [pendingDoor.rows[0].first] : []),
  ];
  const before =
    firsts.length === 0
      ? undefined
      : new Date(Math.min(...firsts.map((at) => at.getTime())));
  return (await readDoorLines(deps, limit)).filter(
    (item) => before === undefined || item.at < before,
  );
}

/**
 * Whether a pending seam event is in the rep's own self-chat — the only chat
 * whose lines the carried tail holds. An event this build cannot open is
 * counted as the thread's, which can only shorten the tail, never lengthen it.
 */
function selfChatOf(deps: ThreadReadDeps, eventType: string, payloadEnc: Buffer): boolean {
  try {
    const payload =
      eventType === "reaction"
        ? decodeWaReactionPayload(deps.dek, payloadEnc)
        : eventType === "opaque"
          ? decodeWaOpaquePayload(deps.dek, payloadEnc)
          : decodeWaMessagePayload(deps.dek, payloadEnc);
    return payload.chatJid === deps.selfChatJid;
  } catch {
    return true;
  }
}

/** Both doors' lines and the twin's replies to them, unordered. */
async function readDoorLines(
  deps: ThreadReadDeps,
  limit: number,
): Promise<readonly TailItem[]> {
  const rep: TailItem[] = deps.bundle
    .readConversation(deps.selfChatJid)
    .filter((row) => !isFramed(row.content))
    .slice(-limit)
    .map((row) => ({
      door: "twin_thread",
      side: "rep",
      at: new Date(row.occurredAt),
      text: row.content,
    }));
  const twin: TailItem[] = (await readPostedReplies(deps, limit)).map((post) => ({
    door: "twin_thread",
    side: "twin",
    at: post.at,
    text: post.text,
  }));
  const door = await deps.db.query<{ id: string; occurred_at: Date; text_enc: Buffer }>(
    `SELECT m.id, m.occurred_at, m.text_enc
       FROM dashboard_messages m
       LEFT JOIN dashboard_message_processing p ON p.message_id = m.id
      WHERE m.twin_id = $1
        AND p.disposition IS DISTINCT FROM 'execution_failed'
      ORDER BY m.occurred_at DESC, m.id DESC
      LIMIT $2`,
    [deps.twinId, limit],
  );
  const replies = await readRepliesAtTheDoor(
    deps,
    door.rows.map((row) => row.id),
    new Date(),
  );
  const bar: TailItem[] = door.rows.flatMap((row): TailItem[] => {
    const asked: TailItem = {
      door: "dashboard",
      side: "rep",
      at: row.occurred_at,
      text: Buffer.from(deps.dek.decrypt(row.text_enc)).toString("utf8"),
    };
    const reply = replies.get(row.id);
    const said = reply?.parts
      .flatMap((part) =>
        part.kind === "prose"
          ? // ITS REFERENCES KEPT, ITS NAMES BESIDE THEM (ticket #321): the
            // twin reading its own words back reads who it named.
            [annotateNames(part.text, part.mentions ?? [])]
          : part.kind === "receipt"
            ? [part.text]
            : [],
      )
      .join("\n");
    return reply === undefined || said === undefined || said === ""
      ? [asked]
      : [asked, { door: "dashboard", side: "twin", at: reply.at, text: said }];
  });
  return [...rep, ...twin, ...bar];
}

/**
 * What the rep pointed at, when they pointed at something the twin posted.
 *
 * ONE OWNER FOR "WHAT DID THE TWIN SAY UNDER THIS ID" (`readPostedPost`), and
 * this adds the one thing beyond the words: where a draft stands. `taps` and
 * `draft_dismissals` are the two single-use locks (both keyed on the draft),
 * so the three states are exactly the three rows that can exist — and the
 * pair is read in one statement so a tap landing between two reads cannot
 * produce a state that never held.
 *
 * A quoted id that names nothing this twin posted resolves to `undefined`,
 * which is the same answer as "the rep quoted nothing": in both cases there is
 * no post of the twin's to show, and inventing one is the alternative.
 */
export async function readQuotedPost(
  deps: ThreadReadDeps,
  waMessageId: string,
): Promise<QuotedTwinPost | undefined> {
  const post = await readPostedPost(deps, waMessageId);
  if (post === undefined) return undefined;
  if (post.kind !== "draft") {
    return {
      id: post.id,
      shown: {
        ...(post.kind === undefined ? {} : { kind: post.kind }),
        text: post.text,
      },
    };
  }
  const { state, destination } = await readDraft(deps, post.id);
  return {
    id: post.id,
    shown: {
      kind: "draft",
      text: post.text,
      draftState: state,
    },
    ...(destination === undefined ? {} : { destination }),
  };
}

/**
 * THE CARD A DOOR MESSAGE EDITED A LINE OF (ticket #344), in the shape a quoted
 * post has — so the dashboard's door points at a post exactly as a reply in the
 * thread does, and every rep-act tool walks from the same two halves. The line
 * rides with what the turn is shown: it is the rep's tap, off their own row.
 */
export async function readEditedCard(
  deps: ThreadReadDeps,
  about: TwinApiLineAbout,
): Promise<QuotedTwinPost | undefined> {
  const post = await readCardPost(deps, about.postId);
  if (post === undefined) return undefined;
  return {
    id: post.id,
    shown: {
      ...(post.kind === undefined ? {} : { kind: post.kind }),
      text: post.text,
      editedLine: about.lineIndex,
    },
  };
}

/**
 * THE DRAFT A DOOR MESSAGE ANSWERED A BLANK OF (ticket #342), in the shape a
 * quoted draft has — its id is the DRAFT's, as a draft quoted in the thread
 * is, so `fill_blank` resolves its target the way every act on a draft does —
 * with the blank the rep tapped beside it: their tap, off their own row.
 */
export async function readAnsweredBlank(
  deps: ThreadReadDeps,
  about: TwinApiBlankAbout,
): Promise<QuotedTwinPost | undefined> {
  const card = await readDraftCard(deps, { postId: about.postId });
  const blank = card?.part.blanks?.find((one) => one.key === about.key);
  if (card === undefined || blank === undefined) return undefined;
  return {
    id: card.draftId,
    shown: {
      kind: "draft",
      text: card.posted ?? card.body,
      draftState: card.state === "waiting" ? "live" : card.state,
      answeredBlank: blank,
    },
    destination: card.destination,
  };
}

/** Where one draft stands, and which chat it was written for. */
async function readDraft(
  deps: ThreadReadDeps,
  draftId: string,
): Promise<{
  readonly state: DraftState;
  readonly destination: string | undefined;
}> {
  const res = await deps.db.query<{
    tapped: boolean;
    dismissed: boolean;
    filled: boolean;
    destination: string | null;
  }>(
    `SELECT EXISTS (SELECT 1 FROM taps WHERE draft_id = $1) AS tapped,
            EXISTS (SELECT 1 FROM draft_dismissals WHERE draft_id = $1) AS dismissed,
            EXISTS (SELECT 1 FROM draft_fills WHERE draft_id = $1) AS filled,
            (SELECT destination FROM drafts WHERE id = $1 AND twin_id = $2) AS destination`,
    [draftId, deps.twinId],
  );
  const row = res.rows[0]!;
  return {
    state: draftStateOf(row),
    destination: row.destination ?? undefined,
  };
}

function draftStateOf(row: {
  tapped: boolean;
  dismissed: boolean;
  filled: boolean;
}): DraftState {
  // TAPPED WINS, and it cannot be a coin flip: a dismissal is refused on an
  // already-tapped draft (`dismissDraft`) and a tap is refused on a dismissed
  // one (the send lock's `dismissed` reason), so at most one of the two rows
  // exists. Ordering the check anyway means a corpus that somehow held both
  // reads as «already sent», which is the state the rep cannot undo and
  // therefore the one they must be told about.
  if (row.tapped) return "tapped";
  if (row.dismissed) return "dismissed";
  // A DRAFT A FILL TOOK THE PLACE OF (ticket #342) can neither be sent — its
  // blank is still open in it — nor be the card the rep reads.
  return row.filled ? "filled" : "live";
}
