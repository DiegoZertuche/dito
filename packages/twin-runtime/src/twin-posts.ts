/**
 * The twin-post registry (#49; ADR-0003, ADR-0006) owns quoted-post
 * recognition and each kind's accepted keywords and effects (spec #48
 * grilling decision 3). A kind is one entry, not a matcher or send-lock branch.
 * Each affirmation closes over its recognized row, so a draft cannot reach
 * binding confirmation and a binding question cannot mint a send.
 *
 * Only draft sends and binding confirmations use keywords (#174; spec #171
 * decision 18): a wrong yes cannot be taken back. The daily disclosure
 * retains its kind with no keyword so a gated tool can identify its target —
 * the post whose line is retracted. That act is requested in prose.
 *
 * Recognition uses only the raw quoted id and the executor's
 * send_executions mapping, never model output (ADR-0003 class 2;
 * ADR-0006's two-minter rule). The UNIQUE (twin_id, wa_message_id) mapping
 * selects at most one command and its single payload_ref (`draft:<uuid>`
 * or `notice:<uuid>`, never both), so kinds are exclusive by construction
 * rather than by lookup order.
 */
import type { Dek } from "@dito/crypto";
import type pg from "pg";
import type { PostGrammar } from "./affirmation.js";
import type { MatchOutcome } from "./matcher.js";
import type { SendLockWriter } from "./send-lock/writer.js";

/**
 * The registry's post kinds, including the one whose replies are prose.
 *
 * IT LOST `aperture_question` AT #218 (spec #214 decision 3): the twin no
 * longer asks the rep to settle a candidate it was unsure of, so there is no
 * such post for a rep to quote and no tool left that acts on one.
 */
export type TwinPostKind =
  | "draft"
  | "binding_question"
  | "daily_disclosure"
  | "ask"
  | "proposal";

/**
 * What the one quoted-id join needs, and nothing more. Resolving "which
 * post did the rep quote" reads the executor's own record and no twin
 * content, so it asks for no key — a caller following a quoted id
 * somewhere that never decrypts (the daily disclosure's numbering, #51)
 * is not made to hold a DEK to do it.
 */
export interface QuotedLookupDeps {
  /**
   * Accept a borrowed transaction connection (#173; lanes.ts). These
   * lookups only issue queries, so requiring a dedicated Client would
   * exclude a valid caller without providing anything the lookup needs.
   */
  readonly db: pg.ClientBase;
  readonly twinId: string;
}

export interface TwinPostLookupDeps extends QuotedLookupDeps {
  /** Reads back the twin's own posts when a quoted follow-up needs its context. */
  readonly dek: Dek;
}

/** What running a verb needs beyond the lookup: the one mint path (ADR-0006). */
export interface TwinPostActionDeps extends TwinPostLookupDeps {
  readonly sendLock: SendLockWriter;
}

/**
 * An affirmation bound to its recognized row; eventId is the raw rep
 * event. The module header explains why effects cannot cross post kinds.
 */
export type TwinPostVerb = (
  deps: TwinPostActionDeps,
  eventId: string,
) => Promise<MatchOutcome>;

/** A recognized twin post whose keyword the rep may speak. */
export interface ActionableTwinPost {
  readonly actionable: true;
  readonly kind: TwinPostKind;
  readonly grammar: PostGrammar;
  /** What this post's accepted yes does, bound to the row recognized. */
  readonly affirm: TwinPostVerb;
}

/**
 * The keyword lookup result, without quoted content (#173).
 * Post identity, words and kind belong to readPostedPost; keeping that
 * lookup separate gives thread callers values without live verb closures.
 */
export type QuotedTarget =
  | ActionableTwinPost
  /** A post without a keyword; the caller routes the reply as prose. */
  | { readonly actionable: false };

/**
 * The executor's record of one posted `system_send`, as the registry reads
 * it.
 *
 * Exported because the ONE quoted-id join lives here and must keep living
 * here (the `twin-posts.test.ts` sweep enforces it). A caller that needs to
 * follow a quoted id somewhere the registry's verbs do not reach — the
 * daily disclosure's «N no», whose correction is content-bearing and
 * therefore not a bare verb at all (#51/#54) — starts from this row rather
 * than writing the join a second time.
 */
export interface PostedSystemSend {
  readonly payloadRef: string;
  readonly draftId: string | null;
  /** The notice this post carried, when its ref named one. */
  readonly noticeId: string | null;
}

/** The notice that `system_send` carried, when it carried one. */
interface PostedNotice {
  readonly kind: string;
  readonly aboutEventId: string;
  readonly text: string;
}

/**
 * A post kind's optional keyword, accepted set and row-bound effect.
 * Kinds without keywords remain available to readPostedPost, as the
 * module header explains.
 *
 * Recognition receives the rows already read, so adding a kind needs
 * neither another round trip nor another copy of the quoted-id join.
 */
export interface TwinPostKindEntry {
  readonly keyword?: {
    readonly grammar: PostGrammar;
    readonly recognize: (
      posted: PostedSystemSend,
      notice: PostedNotice | undefined,
    ) => TwinPostVerb | undefined;
  };
}

/**
 * A draft post: the executor posted a draft under this quoted id.
 *
 * The `payload_ref` predicate binds recognition to the content the rep
 * SAW — the executor posts what `payload_ref` names, so a row pairing
 * draft A with another ref could otherwise authorize unseen content (belt;
 * `send_commands_draft_payload_bound_check` makes such a row
 * unrepresentable).
 */
function recognizeDraftPost(
  posted: PostedSystemSend,
): TwinPostVerb | undefined {
  const draftId = draftIdOfPost(posted);
  if (draftId === undefined) return undefined;
  return (deps, eventId) => mintTapForDraft(deps, eventId, draftId);
}

/**
 * A binding-question post (ticket #34): the framed once-ever
 * «¿Este chat es de …?». What the confirmation acts on is the question's
 * `about_event_id` — the raw customer-chat event whose DEK-encrypted
 * payload names the chat and its push-name, so the caller re-derives the
 * values the rep was actually shown rather than trusting anything the
 * reply carries.
 */
function recognizeBindingQuestionPost(
  _posted: PostedSystemSend,
  notice: PostedNotice | undefined,
): TwinPostVerb | undefined {
  if (notice?.kind !== "binding_question") return undefined;
  const questionEventId = notice.aboutEventId;
  // Declines use decline_binding, not a keyword (#174): the chat stays
  // provisional, and the tool's receipt acknowledges that the rep was heard.
  return async () => ({ disposition: "binding_confirmed", questionEventId });
}

/**
 * Total over TwinPostKind: adding a kind must fail the typecheck until
 * it is registered. Keep the daily disclosure (#51/#54) even without a
 * keyword (#174), so readPostedPost can name it. The module header explains
 * the keyword/prose boundary.
 */
export const TWIN_POST_KINDS: Readonly<
  Record<TwinPostKind, TwinPostKindEntry>
> = {
  // A draft PROPOSES an act, so «va» ("go ahead") is the whole accepted
  // set: the tap releases a message to a customer, and when in doubt the
  // draft keeps waiting rather than sending.
  draft: {
    keyword: { grammar: "proposal", recognize: recognizeDraftPost },
  },
  // A binding question ASKS the rep something a wrong yes cannot take back,
  // so the yes-words belong (#36 finding 1: «va» read oddly as an answer).
  // Its NO left at #174 and is `decline_binding` now.
  binding_question: {
    keyword: { grammar: "question", recognize: recognizeBindingQuestionPost },
  },
  // The daily disclosure REPORTS, so silence accepts (story 10). Its «N no»
  // was the registry's only INDEXED verb until #174 and is
  // `retract_disclosure_line` now: the rep names the line in their own
  // words — «el 3 está mal» — and code resolves the number against the
  // numbering recorded when the post was rendered, exactly as the verb did.
  daily_disclosure: {},
  // A RUN'S QUESTION CARD (ticket #324) is answered in prose, like the day's
  // notes are corrected: the thread resolves the rep's words against the
  // card's options and answers it with `answer_ask`. No keyword — the kind is
  // here so a quoted card reads as what it is.
  ask: {},
  // A RUTINA THE TWIN PROPOSES (ticket #386) is accepted or discarded in
  // prose: the thread reads the rep's words and answers the card with
  // `answer_proposal`. No keyword, for the ask card's reason.
  proposal: {},
};

/**
 * Resolve a quoted id to an actionable post and its affirmation, a
 * non-actionable marker, or undefined when no target resolves. Neither
 * outcome carries text; `readPostedPost` owns the content lookup.
 */
export async function resolveQuotedTarget(
  deps: TwinPostLookupDeps,
  quotedMessageId: string,
): Promise<QuotedTarget | undefined> {
  const posted = await readPostedSystemSend(deps, quotedMessageId);
  if (posted === undefined) return undefined;
  // Read once, before the kinds look: the post's own record of what it
  // said, decrypted under the twin DEK — never anything the rep's event
  // carries.
  const notice = await readNotice(deps, posted.noticeId);
  for (const [kind, entry] of Object.entries(TWIN_POST_KINDS) as [
    TwinPostKind,
    TwinPostKindEntry,
  ][]) {
    const keyword = entry.keyword;
    if (keyword === undefined) continue;
    const affirm = keyword.recognize(posted, notice);
    if (affirm !== undefined) {
      return { actionable: true, kind, grammar: keyword.grammar, affirm };
    }
  }
  // A twin post no keyword claims — one of the two silent kinds, or a post
  // with no verb at all. Either way there is nothing here for the matcher
  // and the caller routes it as prose.
  if (notice === undefined) return undefined;
  return { actionable: false };
}

/** The identity, kind and frozen text of a posted twin message. */
export interface PostedPost {
  /**
   * The REP SIDE'S OWN IDENTITY for this post: the notice's id, or the
   * draft's when the post carried a draft.
   *
   * It is what the thread's trigger record carries as `quotedPostId`
   * (`@dito/execution`'s `TwinThreadMessageTrigger`), so a chain entry names
   * a post by an id this side minted rather than by a rail stanza id — and
   * it is what a draft's state is read against.
   */
  readonly id: string;
  /**
   * Which kind of post it was, when it was one of the four the registry
   * knows. Undefined for a twin post with no verb — a send confirmation, a
   * refusal, an ack, an earlier answer — which is context and nothing else.
   */
  readonly kind?: TwinPostKind;
  /** The post's own words, exactly as the rep read them. */
  readonly text: string;
}

/**
 * WHAT THE TWIN POSTED under this message id: which kind of post it was, its
 * words, and the draft it carried when it carried one (tickets #97 and #173).
 *
 * `resolveQuotedTarget` above answers "which post, and what do its verbs
 * DO?", and it is the matcher's door. This answers "what did the twin SAY
 * here", and it is the twin thread's — and neither a reaction nor a thread
 * execution goes through the matcher's door, which is structural rather than
 * careful: not-a-tap (ADR-0041) means a resolved post carries live
 * `affirm` closures that a gesture and a model-read message must
 * never be within reach of. So this returns values and no verb.
 *
 * IT RESOLVES A DRAFT'S TEXT TOO, which `resolveQuotedTarget` does not: a
 * draft's post lives on the draft rather than in a notice. A 👍 on a
 * Borrador (ADR-0041), or the rep's prose about it (#173), needs the frozen
 * draft as context; the matcher's keyword lookup does not return its text.
 *
 * THE KIND COMES OFF THE NOTICE'S OWN WORD, not off a recognizer. Three of
 * the four post kinds ARE notice kinds and the fourth is the `payload_ref`
 * naming a draft, so the mapping is a lookup rather than a second copy of
 * the registry's recognition — and running the recognizers here would build
 * verb closures for a caller that must not have them.
 */
export async function readPostedPost(
  deps: TwinPostLookupDeps,
  waMessageId: string,
): Promise<PostedPost | undefined> {
  const posted = await readPostedSystemSend(deps, waMessageId);
  if (posted === undefined) return undefined;
  const notice = await readNotice(deps, posted.noticeId);
  if (notice !== undefined) {
    // `noticeId` is what `readNotice` resolved the notice FROM, so it is a
    // string wherever a notice came back.
    return {
      id: posted.noticeId!,
      ...(isTwinPostKind(notice.kind) ? { kind: notice.kind } : {}),
      text: notice.text,
    };
  }
  const draftId = draftIdOfPost(posted);
  if (draftId === undefined) return undefined;
  const res = await deps.db.query<{ post_enc: Buffer | null }>(
    "SELECT post_enc FROM drafts WHERE id = $1 AND twin_id = $2",
    [draftId, deps.twinId],
  );
  const postEnc = res.rows[0]?.post_enc;
  // `post_enc` is nullable in the schema — drafts predate the twin-thread
  // rendering (#30) — so a draft with no frozen post has no words to show,
  // which is what `undefined` says.
  if (postEnc === undefined || postEnc === null) return undefined;
  return {
    id: draftId,
    kind: "draft",
    text: Buffer.from(deps.dek.decrypt(postEnc)).toString("utf8"),
  };
}

/**
 * WHAT THE TWIN POSTED AS THIS CARD (ticket #344): the post a dashboard card
 * IS, by the rep side's own post id — the identity a card act names and a
 * door message pointing at a line carries — read the way `readPostedPost`
 * reads a quoted one. A card that carried no notice (a draft, a door reply)
 * is no record anybody corrects a line of, and reads as none.
 */
export async function readCardPost(
  deps: TwinPostLookupDeps,
  postId: string,
): Promise<PostedPost | undefined> {
  const noticeId = await noticeOfCard(deps, postId);
  const notice = await readNotice(deps, noticeId);
  if (noticeId === null || notice === undefined) return undefined;
  return {
    id: noticeId,
    ...(isTwinPostKind(notice.kind) ? { kind: notice.kind } : {}),
    text: notice.text,
  };
}

/**
 * The notice a card of this twin carried, by the rep side's post id — or none
 * for a card that carried no notice, or is no card of this twin's.
 */
export async function noticeOfCard(
  deps: { readonly db: pg.ClientBase; readonly twinId: string },
  postId: string,
): Promise<string | null> {
  const res = await deps.db.query<{ notice_id: string | null }>(
    "SELECT notice_id FROM posts WHERE id = $1 AND twin_id = $2",
    [postId, deps.twinId],
  );
  return res.rows[0]?.notice_id ?? null;
}

/** Whether a notice kind is also one of the registry's post kinds. */
function isTwinPostKind(kind: string): kind is TwinPostKind {
  return Object.hasOwn(TWIN_POST_KINDS, kind);
}

/** One posted twin reply and its execution instant. */
export interface PostedReply {
  /** When the executor posted it. */
  readonly at: Date;
  /** The post's own words, exactly as the rep read them. */
  readonly text: string;
}

/**
 * The notice kinds that are the twin REPLYING to the rep in their thread: an
 * answer, and the acknowledgement of an act the rep asked for (ticket #319).
 *
 * NOT A DRAFT, A QUESTION OR THE DAY'S NOTES. Those are cards the rep acts
 * on, not things the two of them said to each other, and a draft's body is
 * words for a customer — so the carried tail (`thread/tail.ts`), which is
 * this read's reader, never holds one.
 */
const REPLY_KINDS = ["answer", "dismissal_ack", "binding_ack", "correction_ack"];

/**
 * Read the twin's posted replies in the rep's own thread, newest first
 * (#173, #319).
 *
 * Keep the executor join here: twin-posts.test.ts rejects a second owner
 * of the send_executions/send_commands lookup. Starting from executions, not
 * notices, excludes pending posts the rep has not seen; otherwise the twin
 * could say "as I told you" about words never delivered.
 */
export async function readPostedReplies(
  deps: TwinPostLookupDeps,
  limit: number,
): Promise<readonly PostedReply[]> {
  const res = await deps.db.query<{ at: Date; content_enc: Buffer }>(
    `SELECT se.executed_at AS at, n.content_enc
       FROM send_executions se
       JOIN send_commands sc ON sc.id = se.command_id
       JOIN notices n ON sc.payload_ref = 'notice:' || n.id
      WHERE se.twin_id = $1
        AND sc.send_class = 'system_send'
        AND n.kind = ANY($3::text[])
      ORDER BY se.executed_at DESC, se.command_id DESC
      LIMIT $2`,
    [deps.twinId, limit, REPLY_KINDS],
  );
  return res.rows.map((row) => ({
    at: row.at,
    text: Buffer.from(deps.dek.decrypt(row.content_enc)).toString("utf8"),
  }));
}

/**
 * THE ONE JOIN that turns a quoted WhatsApp message id into the
 * `system_send` the executor posted under it. Every kind recognizes itself
 * from this row, so the join exists once — and so does everything else
 * that follows a quoted id, which is why this is the module's export
 * rather than its private helper.
 */
export async function readPostedSystemSend(
  deps: QuotedLookupDeps,
  quotedMessageId: string,
): Promise<PostedSystemSend | undefined> {
  const res = await deps.db.query<{ payload_ref: string; draft_id: string | null }>(
    `SELECT sc.payload_ref, sc.draft_id
       FROM send_executions se
       JOIN send_commands sc ON sc.id = se.command_id
      WHERE se.twin_id = $1
        AND se.wa_message_id = $2
        AND sc.send_class = 'system_send'`,
    [deps.twinId, quotedMessageId],
  );
  const row = res.rows[0];
  if (row === undefined) return undefined;
  return {
    payloadRef: row.payload_ref,
    draftId: row.draft_id,
    noticeId: noticeIdOf(row.payload_ref),
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The notice uuid a `payload_ref` names, when it names one.
 *
 * Shape-checked before it can reach a query: `payload_ref` is free text at
 * the seam, and a malformed ref would otherwise arrive at Postgres as an
 * invalid uuid literal (22P02) and abort a whole pass over one bad row.
 * Nothing this twin posted can look like that — only the notice seam and
 * the draft emission write refs — so an unparseable one names no post,
 * which is exactly what `null` says.
 */
function noticeIdOf(payloadRef: string): string | null {
  if (!payloadRef.startsWith("notice:")) return null;
  const id = payloadRef.slice("notice:".length);
  return UUID.test(id) ? id : null;
}

/**
 * Resolve the draft with the payload-binding check explained at
 * recognizeDraftPost. Both callers use this helper so they cannot disagree
 * about which draft's content the rep saw.
 */
function draftIdOfPost(posted: PostedSystemSend): string | undefined {
  const draftId = posted.draftId;
  if (draftId === null || posted.payloadRef !== `draft:${draftId}`) {
    return undefined;
  }
  return draftId;
}

/** One notice of this twin's, opened under the twin key — or none for no id. */
async function readNotice(
  deps: TwinPostLookupDeps,
  noticeId: string | null,
): Promise<PostedNotice | undefined> {
  if (noticeId === null) return undefined;
  const res = await deps.db.query<{
    kind: string;
    about_event_id: string;
    content_enc: Buffer;
  }>(
    `SELECT kind, about_event_id, content_enc
       FROM notices WHERE id = $1 AND twin_id = $2`,
    [noticeId, deps.twinId],
  );
  const row = res.rows[0];
  if (row === undefined) return undefined;
  return {
    kind: row.kind,
    aboutEventId: row.about_event_id,
    text: Buffer.from(deps.dek.decrypt(row.content_enc)).toString("utf8"),
  };
}

/**
 * The draft's YES: the one tap path (ADR-0006). No kind branch lives here
 * — the registry entry that closes over `draftId` is what selects it.
 */
async function mintTapForDraft(
  deps: TwinPostActionDeps,
  eventId: string,
  draftId: string,
): Promise<MatchOutcome> {
  // Crash-replay idempotence: the writer's transaction and the processing
  // marker commit separately, so a crash between them replays this event.
  // A tap already minted FROM THIS EVENT means the replay — affirmed, no
  // second mint, no spurious «ya se envió».
  const replay = await deps.db.query(
    "SELECT 1 FROM taps WHERE source_event_id = $1",
    [eventId],
  );
  if (replay.rows.length > 0) {
    return { disposition: "affirmed" };
  }
  const result = await deps.sendLock.requestCustomerSend({
    minter: "affirmation_matcher",
    draftId,
    sourceEventId: eventId,
  });
  if (result.outcome === "written") {
    return { disposition: "affirmed" };
  }
  return { disposition: "affirmation_refused", reason: result.reason };
}
