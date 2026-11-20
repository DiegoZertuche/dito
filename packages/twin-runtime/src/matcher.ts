/**
 * The quoted-reply affirmation matcher (ticket #25; ADR-0006). Authority
 * comes only from the raw plane-delivered self-chat reply and its quoted
 * message id, never model output. The twin-post registry (#49) resolves
 * that id through send_executions and owns the accepted set and effect for
 * each post kind, so adding a kind needs no matcher or send-lock branch.
 *
 * Only two acts use keywords (#174): a bare «va» quoted on a draft releases
 * its send; a bare «si»/«sí»/«va» quoted on a binding question confirms it. A wrong
 * yes to either cannot be taken back (ADR-0037; spec #171
 * decision 18). Other eligible text reaches the thread's gated tools as
 * `twin_input`, including dismissal, line correction, the aperture question's
 * answer and replies to unknown posts (#173's recorded remainder 4).
 * The exception is a proposal affirmation with an unresolved quote: it
 * refuses loudly rather than swallowing a possible lost-draft tap.
 * In doubt, mint nothing (spec #18, story 10).
 *
 * Echo filters are defence in depth. #63's rig finding corrects ADR-0023's
 * echo premise: outgoing WhatsApp posts sync to other linked devices, not
 * the sending plane. Keep the filters against a rail, re-link or device
 * change that delivers one: a twin-authored post must never become input
 * (the poisoned path).
 * The executor does not feed these posts back onto the seam either; it
 * records only customer_send, whose customer chat is outside this router.
 */
import type { Dek } from "@dito/crypto";
import type pg from "pg";
import { acceptsAffirmation } from "./affirmation.js";
import { isFramed } from "./grammar.js";
import type { WaMessagePayload } from "./payload.js";
import type { RefusalReason, SendLockWriter } from "./send-lock/writer.js";
import { resolveQuotedTarget } from "./twin-posts.js";

/**
 * Why the matcher itself refused, beyond the writer's reasons:
 * `unresolved_draft` — the reply is affirmation-shaped but its quoted id
 * resolves to no recorded draft post. The one honest cause in this
 * topology is a lost mapping (the executor posted a draft and died before
 * recording its message id), and silently consuming the rep's real «va»
 * with the exactly-once marker would swallow it forever — so it refuses
 * loudly instead. Mints nothing either way.
 */
export type MatcherRefusalReason = RefusalReason | "unresolved_draft";

/** Outcomes of the routing policy in the module header. */
export type MatchOutcome =
  | { disposition: "captured" }
  | { disposition: "affirmed" }
  | { disposition: "affirmation_refused"; reason: MatcherRefusalReason }
  /**
   * A quoted yes — «si», «sí» or «va» since #49 — resolved to a
   * binding-question post (ticket #34; spec #29 grilling decision 3): the
   * caller confirms the binding into the bundle's entity mirror (the chat
   * and proposed name re-derived from the question's source event under
   * the twin DEK), acks, then marks. The matcher binds by quoted-id and
   * runs the verb the REGISTRY bound to that post, so this outcome and
   * "affirmed" are structurally disjoint: a question's yes can never reach
   * the send-lock writer, and a draft's «va» can never reach the mirror.
   */
  | { disposition: "binding_confirmed"; questionEventId: string }
  /**
   * The rep addressed the twin (#35; spec #29 grilling decision 2); see
   * the header for routing. Not "question": CONTEXT.md reserves that noun
   * for an aperture-held ask in the opposite direction, twin→rep.
   *
   * No quoted content is carried here (#173). The caller uses the payload's
   * quoted id with `readQuotedPost` to obtain words, kind and draft state
   * from one owner, avoiding a second, drifting account of the same post.
   * The execution decides whether to answer; routing alone cannot choose
   * `answered` or `deliberate_silence`.
   */
  | { disposition: "twin_input" }
  /**
   * A media-only message in the twin thread (story 13): saving a photo to
   * yourself triggers nothing — not even a model call. The caller commits
   * `media_ignored`.
   */
  | { disposition: "media_ignored" };

export interface MatcherDeps {
  readonly db: pg.Client;
  readonly twinId: string;
  readonly selfChatJid: string;
  readonly sendLock: SendLockWriter;
  /** Reads back the twin's own posts when a quoted follow-up needs its context (ticket #35). */
  readonly dek: Dek;
}

/**
 * Routes one captured event to a keyword act or thread input, after origin
 * and media filtering. The caller commits the returned disposition.
 */
export async function matchCapturedEvent(
  deps: MatcherDeps,
  eventId: string,
  payload: WaMessagePayload,
): Promise<MatchOutcome> {
  // Routing is total inside the twin thread and stops at its edge: the
  // rep's own-sent traffic in a CUSTOMER chat is bundle material only —
  // never a verb, never a question to the twin.
  if (!payload.fromMe || payload.chatJid !== deps.selfChatJid) {
    return { disposition: "captured" };
  }

  // Check origin BEFORE the quoted/unquoted split (#35; spec #29 decision
  // 2): twin posts are unquoted, and treating an echo as fresh thread input
  // would make the twin answer itself. A recorded post can never mint.
  const echo = await deps.db.query(
    "SELECT 1 FROM send_executions WHERE twin_id = $1 AND wa_message_id = $2",
    [deps.twinId, payload.messageId],
  );
  if (echo.rows.length > 0) {
    return { disposition: "captured" };
  }

  // The frame is an independent origin signal (Codex r1): the executor
  // can post and die before recording send_executions (#25/#30). Every
  // twin post has the sigil, so this guard prevents an answer loop even
  // without the mapping. A rep typing the sigil is also ignored — the
  // safe direction. Durable outbound identity in the plane remains the
  // recorded remainder for the lost-mapping window.
  if (isFramed(payload.text)) {
    return { disposition: "captured" };
  }

  // Media-only messages must not reach the model (spec #29 decision 2;
  // story 13). Check before the quote split: a caption-less media reply
  // can quote a post too, but still contains no text for thread execution.
  if (payload.text.trim() === "") {
    return { disposition: "media_ignored" };
  }

  if (payload.quotedMessageId === undefined) {
    // Everything else the rep types unquoted is twin input: no address
    // token, no prefix, no magic word (grilling decision 2).
    return { disposition: "twin_input" };
  }

  // Resolve the accepted set and effect together, as the header requires.
  const quoted = await resolveQuotedTarget(deps, payload.quotedMessageId);

  if (quoted === undefined) {
    // The quoted id resolves to NOTHING the twin posted. An
    // AFFIRMATION-shaped reply here is the lost-mapping case: the executor
    // posted a draft and died before recording its message id, so the
    // rep's genuine «va» quotes a message the mapping does not know.
    // Refuse loudly rather than swallow it behind the exactly-once marker.
    //
    // The set consulted is the PROPOSAL one, deliberately, even though the
    // kind is unknowable: the refusal microcopy names a missing draft post,
    // and only a draft post's loss can strand a send the rep believes
    // released. A lost QUESTION post is not that case — an unconfirmed
    // binding leaves the chat provisional, which is exactly what an
    // unanswered question already means — so «si» here mints nothing and
    // goes to the execution like any other sentence.
    if (acceptsAffirmation("proposal", payload.text)) {
      return { disposition: "affirmation_refused", reason: "unresolved_draft" };
    }
    // Unknown quotes still reach the execution (#174; #173's remainder
    // 4), without inventing context for a post the registry cannot resolve.
    return { disposition: "twin_input" };
  }

  // No keyword effect without BOTH an actionable post and its accepted yes
  // (spec #48 grilling decision 3). Non-actionable posts fall through to prose.
  if (quoted.actionable && acceptsAffirmation(quoted.grammar, payload.text)) {
    return await quoted.affirm(deps, eventId);
  }

  // Everything else the rep can say to a post of theirs: prose about it.
  // The post rides along as context, read by the execution from the same
  // quoted id (`readQuotedPost`), and the acts the rep asks for in words
  // are the execution's gated tools.
  return { disposition: "twin_input" };
}
