/**
 * THE ONE WAY A DRAFT IS RECORDED (ticket #175; ADR-0006).
 *
 * TWO OCCASIONS, ONE WRITE. A customer's settled turn produces a draft
 * (`drafting/write.ts`'s `create_draft`), and so does the rep asking for one
 * (`thread/write.ts`'s). The two differ in
 * everything ABOUT the occasion — what the draft replies to, whose instant
 * the provenance line carries, whether a binding question is due, which
 * events get marked — and in nothing about what a draft IS. So the four
 * writes that make one are here, and each caller adds its own occasion
 * around them.
 *
 * WHY THAT MATTERS MORE THAN TIDINESS. The row, its `system_send` and its
 * timing row are what the TAP PATH walks: the send lock resolves
 * `draft:<id>`, mints the tap, checks pacing and the allowlist, and posts
 * the confirmation. A second copy of these four statements would be a
 * second definition of what the lock is walking — and the whole safety
 * claim of ADR-0006 is that there is exactly one way a draft comes to
 * exist and exactly one way it goes out. A rep-initiated draft is
 * byte-identically the same row as a customer-triggered one, which is why
 * FR-70 needed nothing added for it.
 *
 * WHAT IS NOT HERE: the turn's processing markers and the binding question.
 * The drafting turn's caller marks the customer messages its draft answered
 * (`drafted` on the anchor, `drafted_in_batch` on the rest) and asks the
 * once-ever question beside it (`postBindingQuestion`), both statements about
 * a CUSTOMER TURN — a rep-initiated draft answers no inbound message and has
 * nothing of that shape. Its own event's marker is the thread execution's,
 * written where every other thread marker is.
 */
import type { Bundle } from "@dito/bundle";
import type { Dek } from "@dito/crypto";
import type pg from "pg";
import { insertNoticeWithSystemSend, insertSystemSendCommand } from "./notices.js";
import { addKnock } from "./post-knocks.js";
import type { DraftBlank } from "./blanks.js";
import type { DraftDelicacy } from "./delicacy.js";
import {
  composeBindingQuestionPost,
  composeDraftPost,
  insertPost,
  openSealedParts,
  type ComposedPost,
  type DraftPart,
  type Mention,
  type ProsePart,
} from "./posts.js";

/** The twin the draft belongs to, and where its post goes. */
export interface DraftTwin {
  readonly twinId: string;
  readonly selfChatJid: string;
  readonly dek: Dek;
  /** The rep's zone, for the reminder a draft or a question is born with. */
  readonly timeZone?: string;
}

/** When one draft was born, as the boundary measures NFR-2 by it. */
export interface DraftTiming {
  readonly draftId: string;
  readonly executionId: string;
  readonly eventReceivedAt: Date;
  readonly runtimeSeenAt: Date;
  readonly draftReadyAt: Date;
}

/** One draft, as either occasion hands it over. */
export interface DraftEmission {
  /**
   * The draft's own id, minted by the caller (ticket #220).
   *
   * MINTED BEFORE THE ROW because the post's `draft` part NAMES it, and a
   * part cannot name an id the INSERT's default is about to choose. The
   * day's post does the same for its `disclosure_posts` row: an id a part
   * must carry is generated in code.
   */
  readonly id: string;
  /**
   * The post's own id, minted beside the draft's where a tool named it to the
   * twin before the row (`HeldDraft.postId`); absent, the INSERT chooses one.
   */
  readonly postId?: string;
  /**
   * The `wa_events` row this draft is recorded as replying to.
   *
   * A CUSTOMER MESSAGE ON ONE PATH AND THE REP'S OWN ON THE OTHER, and the
   * column takes both: it is nullable in the schema and it names the event
   * the draft came out of, which for a rep-initiated draft is the rep
   * asking for it. That is what the timing row measures from and what a
   * reader follows back to find why this draft exists.
   *
   * ABSENT FOR A DRAFT THE DASHBOARD'S DOOR ASKED FOR (ticket #261), and that
   * is the column being honest rather than a gap: `in_reply_to_event_id`
   * references `wa_events`, and a door message is not one. What the draft came
   * out of is still recorded — `executionId` below names the execution, whose
   * trigger names the door and the message — so the walk a reader makes is one
   * hop longer and no fact is lost. ADR-0034's rule, at a column: an absent
   * field is NOT RECORDED THEN, never a default.
   */
  readonly inReplyToEventId?: string;
  /** The execution that produced it — the timing row and the question name it. */
  readonly executionId: string;
  /** The customer chat the draft is for. */
  readonly destination: string;
  readonly contentEnc: Uint8Array;
  /**
   * The post this draft IS: its `draft` part and the Mock A rendering that
   * part amounts to (ticket #220, `composeDraftPost`). `post_enc` is that
   * rendering, DEK-encrypted at rest (ticket #30).
   */
  readonly post: ComposedPost;
}

/**
 * A DRAFT THE TWIN WROTE AND THE TURN HAS NOT YET ENDED ON (ticket #368):
 * everything `create_draft` checked, held until the turn's words are known.
 *
 * HELD RATHER THAN WRITTEN, because the twin's sentence on the card and above
 * the Borrador is the turn's final message (the glossary's *Hand-off*; the
 * ruling of 2026-10-07: the twin's words are the model's final message), and
 * the draft's row and its post are immutable from birth — `drafts.post_enc`
 * is the rendering the phone shows, words included. So the tool checks and
 * holds, and the caller writes it all (`landDraft`) once the turn has ended,
 * in the turn's own transaction: a turn that fails after calling the tool
 * leaves no draft at all.
 */
export interface HeldDraft {
  /** Minted by the tool, which names it to the twin; the part names it too. */
  readonly id: string;
  /**
   * The id the draft's post lands under, minted beside the draft's (ticket
   * #358): the tool names it to the twin, which knocks on it in the same
   * turn, before the post exists.
   */
  readonly postId: string;
  /** The `wa_events` row it replies to, where there is one (`DraftEmission`). */
  readonly inReplyToEventId?: string;
  readonly executionId: string;
  /** The customer chat it goes to. */
  readonly destination: string;
  /** The text a tap releases, its blanks under the keys code stores. */
  readonly body: string;
  /** The name the frame and the card's fallback sentence carry. */
  readonly counterparty: string;
  readonly tail?: string;
  readonly blanks: readonly DraftBlank[];
  readonly delicacy?: DraftDelicacy;
  /** The knock the same turn wrote on this draft's post, landed with it. */
  readonly knock?: HeldKnock;
}

/**
 * THE KNOCK THE THREAD WROTE ON THE POST ITS HELD DRAFT LANDS UNDER (ticket
 * #358): the knock tool passed it through the floors a landed card's knock
 * passes, and it lands as that card's `post_knocks` row, by `addKnock`, in the
 * transaction that writes the post (`landDraft`).
 */
export interface HeldKnock {
  /** The sentence, its references already rendered as names. */
  readonly sentence: string;
  /** The customers it names, by reference (`c7`). */
  readonly customers: readonly string[];
}

/**
 * The one draft a thread turn holds, run-scoped like the act slot: the tool
 * holds it, the caller lands it, and a second draft in one turn is refused
 * before this is reached (`ActSlot`). Drafting's own slot (`DraftSlot`) holds
 * the same draft beside the binding question's sentence, which only that
 * turn composes.
 */
export class HeldDraftSlot {
  #held: HeldDraft | undefined;

  /** The draft this turn holds, if it wrote one. */
  get held(): HeldDraft | undefined {
    return this.#held;
  }

  /** Holds the turn's draft; a turn holds one. */
  hold(draft: HeldDraft): void {
    if (this.#held !== undefined) throw new Error("a turn holds one draft");
    this.#held = draft;
  }

  /** Holds the knock on the held draft's post; a landing has one knock. */
  knock(knock: HeldKnock): void {
    if (this.#held === undefined) throw new Error("a knock is held on a held draft");
    if (this.#held.knock !== undefined) throw new Error("a held draft carries one knock");
    this.#held = { ...this.#held, knock };
  }
}

/**
 * THE HELD DRAFT, WRITTEN WITH THE TURN'S WORDS (ticket #368): its post is
 * the twin's sentence and the draft (`composeDraftPost`), and the row, the
 * blanks, the post and its send follow as `recordDraft` writes them. Called
 * by the caller of every turn that can hold one — drafting's, the thread's
 * and a run's agent step — after the turn's record, inside its transaction.
 *
 * THE POST LANDS UNDER THE ID THE TOOL NAMED, AND ITS KNOCK WITH IT (ticket
 * #358): a knock the thread held on it is written by `addKnock` — the knock
 * tool's own write, every floor read again off the landed card — after the
 * post and in the same transaction, so the post and its knock commit together
 * or neither does. `knocks` is what that read needs beyond the twin — the
 * entity mirror the card's customer is read through; only the thread holds
 * the knock tool, so only its landing passes it.
 */
export async function landDraft(
  client: pg.ClientBase,
  twin: DraftTwin,
  held: HeldDraft,
  said: { readonly words: string; readonly mentions: readonly Mention[] },
  knocks?: { readonly bundle: Bundle },
): Promise<void> {
  await recordDraft(client, twin, {
    id: held.id,
    postId: held.postId,
    ...(held.inReplyToEventId === undefined ? {} : { inReplyToEventId: held.inReplyToEventId }),
    executionId: held.executionId,
    destination: held.destination,
    contentEnc: twin.dek.encrypt(Buffer.from(held.body, "utf8")),
    post: composeDraftPost({
      draftId: held.id,
      words: said.words,
      mentions: said.mentions,
      counterparty: held.counterparty,
      ...(held.tail === undefined ? {} : { tail: held.tail }),
      body: held.body,
      blanks: held.blanks,
      ...(held.delicacy === undefined ? {} : { delicacy: held.delicacy }),
    }),
  });
  if (held.knock === undefined) return;
  if (knocks === undefined) throw new Error("a held knock lands where the knock tool is held (ticket #358)");
  const landed = await addKnock(
    {
      db: client,
      twinId: twin.twinId,
      dek: twin.dek,
      ...(twin.timeZone === undefined ? {} : { timeZone: twin.timeZone }),
      bundle: knocks.bundle,
      executionId: held.executionId,
    },
    { postId: held.postId, ...held.knock },
    new Date(),
  );
  // THE FLOORS THE TOOL READ OFF THE HELD CARD ARE THE ONES READ HERE, so a
  // knock the twin was told is coming and the landed card refuses is the two
  // readings disagreeing — loud, and the whole turn with it.
  if (!landed.knocked) {
    throw new Error(`the knock held on post ${held.postId} was refused at landing: ${landed.refusal} (ticket #358)`);
  }
}

/**
 * Writes the draft and its post command.
 *
 * IT RETURNS THE POST'S ID: the caller minted `emission.id` before this was
 * called, because the post's `draft` part names it (ticket #220), and the
 * post's own id is what the twin knocks on (ticket #358).
 *
 * RUNS INSIDE THE CALLER'S OPEN TRANSACTION, like the notice seam beside
 * it: on the customer path that is the drafting execution's, and on the rep
 * path it is the thread execution's own — the connection #174 threads
 * through `ThreadDeps`, so the draft and the record of the execution that
 * wrote it are one commit or neither.
 */
export async function recordDraft(
  client: pg.ClientBase,
  twin: DraftTwin,
  emission: DraftEmission,
): Promise<string> {
  const draftId = emission.id;
  await client.query(
    `INSERT INTO drafts (id, twin_id, in_reply_to_event_id, destination, content_enc, post_enc)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      draftId,
      twin.twinId,
      emission.inReplyToEventId ?? null,
      emission.destination,
      Buffer.from(emission.contentEnc),
      Buffer.from(twin.dek.encrypt(Buffer.from(emission.post.text, "utf8"))),
    ],
  );
  // THE BLANKS IN THE CLEAR (ticket #342): the keys the draft part seals,
  // one row each, so the send lock — which holds no key at its second minter —
  // can refuse a draft with a fact still missing. Read off the part this
  // emission carries, so the rows and the slots the card draws are one list.
  for (const part of emission.post.parts) {
    if (part.kind !== "draft") continue;
    for (const blank of part.blanks ?? []) {
      await client.query(
        "INSERT INTO draft_blanks (draft_id, key) VALUES ($1, $2)",
        [draftId, blank.key],
      );
    }
  }
  // THE POST BESIDE THE DRAFT (ticket #220): the draft row is the post's
  // thread-rendering record and this is the post itself, in the same
  // transaction as the row it names.
  const postId = await insertPost(client, {
    ...(emission.postId === undefined ? {} : { id: emission.postId }),
    twinId: twin.twinId,
    dek: twin.dek,
    parts: emission.post.parts,
    executionId: emission.executionId,
    delivery: { draftId },
    ...(twin.timeZone === undefined ? {} : { timeZone: twin.timeZone }),
  });
  await insertSystemSendCommand(client, {
    twinId: twin.twinId,
    destination: twin.selfChatJid,
    payloadRef: `draft:${draftId}`,
    draftId,
  });
  return postId;
}

/**
 * THE CHAT'S ONCE-EVER BINDING QUESTION, posted beside the draft a customer's
 * turn earned (tickets #34, #220, #363) — about the raw inbound whose payload
 * names the chat being asked about, and carrying the execution that composed
 * it. The caller decides it is due under the ceremony's lock, after the
 * turn's chain entry (`takeBindingCeremonyLock` argues the order).
 *
 * THE NAME AND THE SENTENCE, NOT THE POST: the question's anchor is the
 * notice's `about_event_id` AND the question part's `aboutEventId`, and
 * composing here keeps those one value.
 */
export async function postBindingQuestion(
  client: pg.ClientBase,
  twin: DraftTwin,
  question: {
    /** The customer-chat event the question is about. */
    readonly aboutEventId: string;
    /** The name the RAIL supplied, which is what a «si» would confirm. */
    readonly proposedName: string;
    /** The twin's own sentence with `{name}` in it, when it composed one. */
    readonly sentence?: string;
    readonly executionId: string;
  },
): Promise<void> {
  await insertNoticeWithSystemSend(client, {
    twinId: twin.twinId,
    selfChatJid: twin.selfChatJid,
    dek: twin.dek,
    kind: "binding_question",
    aboutEventId: question.aboutEventId,
    post: composeBindingQuestionPost({
      aboutEventId: question.aboutEventId,
      proposedName: question.proposedName,
      ...(question.sentence === undefined ? {} : { sentence: question.sentence }),
    }),
    executionId: question.executionId,
    ...(twin.timeZone === undefined ? {} : { timeZone: twin.timeZone }),
  });
}

/**
 * WHEN THIS DRAFT WAS BORN — NFR-2's three instants, written where the
 * execution row already exists (ticket #175).
 *
 * ITS OWN FUNCTION BECAUSE ITS PLACE IN THE TRANSACTION IS NOT THE DRAFT's,
 * and the reason is a foreign key: `draft_timings.execution_id` references
 * `executions(id)`, and a fill writes its draft from inside the model loop,
 * through a tool, BEFORE the turn has ended and therefore before there is any
 * record to point at; the row can only be written after the record — which is
 * where a held draft is landed too (`landDraft`).
 *
 * SO THE PLACEMENT IS THE CALLER'S AND THE STATEMENT IS SHARED. Both
 * occasions write one timing row per draft, with the same columns and the
 * same meaning, and neither can quietly stop writing one without deleting a
 * call to this. The alternative — deferring the constraint — would trade a
 * checked reference for a migration, on a table whose whole purpose is to
 * be joined to the execution that produced it.
 */
export async function recordDraftTiming(
  client: pg.ClientBase,
  timing: DraftTiming,
): Promise<void> {
  await client.query(
    `INSERT INTO draft_timings (draft_id, event_received_at, runtime_seen_at, draft_ready_at, execution_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      timing.draftId,
      timing.eventReceivedAt,
      timing.runtimeSeenAt,
      timing.draftReadyAt,
      timing.executionId,
    ],
  );
}

/**
 * ONE DRAFT CARD AS A FILL READS IT (ticket #342): the card's post, the draft
 * it delivers, where it goes, its body opened, its sealed draft part and where
 * it stands — so the door that takes an answer, the turn shown it and the tool
 * that fills it all read one thing.
 */
export interface DraftCard {
  readonly postId: string;
  readonly draftId: string;
  readonly destination: string;
  readonly body: string;
  /** The post as the thread rendered it (`drafts.post_enc`), when it has one. */
  readonly posted?: string;
  readonly part: DraftPart;
  /** The twin's sentence the card carries above the draft, when it said one (ticket #368). */
  readonly prose?: ProsePart;
  /**
   * `waiting` until a tap, a dismissal or a fill names it — the canvas's own
   * three rows (`waitingCandidates`), read in one statement.
   */
  readonly state: "waiting" | "tapped" | "dismissed" | "filled";
}

/**
 * The draft card a post id or a draft id names, of this twin — or none, for
 * an id that names no draft card of this twin's or a post re-expressed from
 * before parts existed (which can carry no blank).
 */
export async function readDraftCard(
  deps: { readonly db: pg.ClientBase; readonly dek: Dek; readonly twinId: string },
  by: { readonly postId: string } | { readonly draftId: string },
): Promise<DraftCard | undefined> {
  const res = await deps.db.query<{
    post_id: string;
    draft_id: string;
    destination: string;
    content_enc: Buffer;
    post_enc: Buffer | null;
    parts_enc: Buffer | null;
    tapped: boolean;
    dismissed: boolean;
    filled: boolean;
  }>(
    `SELECT p.id AS post_id, d.id AS draft_id, d.destination, d.content_enc, d.post_enc,
            p.parts_enc,
            EXISTS (SELECT 1 FROM taps t WHERE t.draft_id = d.id) AS tapped,
            EXISTS (SELECT 1 FROM draft_dismissals x WHERE x.draft_id = d.id) AS dismissed,
            EXISTS (SELECT 1 FROM draft_fills f WHERE f.draft_id = d.id) AS filled
       FROM posts p
       JOIN drafts d ON d.id = p.draft_id AND d.twin_id = p.twin_id
      WHERE p.twin_id = $1 AND ${"postId" in by ? "p.id" : "d.id"} = $2`,
    [deps.twinId, "postId" in by ? by.postId : by.draftId],
  );
  const row = res.rows[0];
  if (row === undefined || row.parts_enc === null) return undefined;
  const parts = openSealedParts(deps.dek, row.parts_enc);
  const part = parts.find((one): one is DraftPart => one.kind === "draft");
  if (part === undefined) return undefined;
  const prose = parts.find((one): one is ProsePart => one.kind === "prose");
  return {
    postId: row.post_id,
    draftId: row.draft_id,
    destination: row.destination,
    body: Buffer.from(deps.dek.decrypt(row.content_enc)).toString("utf8"),
    ...(row.post_enc === null
      ? {}
      : { posted: Buffer.from(deps.dek.decrypt(row.post_enc)).toString("utf8") }),
    part,
    ...(prose === undefined ? {} : { prose }),
    // TAPPED WINS, `readDraft`'s rule: it is the state the rep cannot undo.
    state: row.tapped ? "tapped" : row.dismissed ? "dismissed" : row.filled ? "filled" : "waiting",
  };
}
