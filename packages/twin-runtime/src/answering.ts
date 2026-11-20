/**
 * Answer emission and the binding ceremony it can trigger (#35, #173).
 * Search and its served-hit contract belong to `thread/tools.ts` and
 * `thread/served.ts`; search includes the self-chat (spec #171 decision 19).
 * The model contract lives in `thread/automation.ts`.
 *
 * The ceremony lives outside `thread/` because drafting, answers and
 * extraction share its once-ever asked-state (#34). Code decides whether a
 * question is DUE and the twin writes its sentence (#195): the reply's own
 * prose carries the question and one post is both. A thread execution
 * borrows these helpers into its transaction so the answer and ceremony
 * commit together.
 */
import type { Bundle } from "@dito/bundle";
import type { Dek } from "@dito/crypto";
import type { Door } from "@dito/seam";
import type pg from "pg";
import { insertNoticeWithSystemSend } from "./notices.js";
import { composeAnswerPost, insertPost, type DocumentPart, type Mention } from "./posts.js";
import { decodeWaMessagePayload } from "./payload.js";

/**
 * The conversation a reply's binding question is about: the chat, the name
 * the phone offered for it, and the other side's messages written under that
 * name, newest first — what the ceremony anchors to (`thread/references.ts`'s
 * `Customer`, for a chat nobody has confirmed).
 */
export interface AskedChat {
  readonly chatJid: string;
  readonly pushName: string;
  readonly anchors: readonly string[];
}

/**
 * THE BINDING QUESTION A TURN HANDED THE REP, due and anchored (ticket #363):
 * the customer-chat event it is about, the name the rail supplied, and the
 * twin's sentence with `{name}` where that name goes.
 */
export interface BindingQuestion {
  readonly aboutEventId: string;
  readonly proposedName: string;
  readonly sentence: string;
}

export interface AnsweringDeps {
  /**
   * Accept a borrowed connection so answers run inside the execution's
   * transaction, not on the runtime's dedicated client (#173; `lanes.ts`).
   * These helpers need only queries, hence `ClientBase`.
   */
  readonly db: pg.ClientBase;
  readonly bundle: Bundle;
  readonly dek: Dek;
  readonly twinId: string;
  readonly selfChatJid: string;
}

/**
 * Posts the answer THROUGH THE DOOR IT WAS ASKED AT (tickets #35, #173, #261;
 * ADR-0044 as amended — "an answer goes where it was asked").
 *
 * The thread's answer is framed and rides the notice seam every twin post uses,
 * so it is a system send to the twin thread like every other (never a customer
 * send, ADR-0006). The DASHBOARD's answer is the same post and no send at all:
 * one `posts` row naming the message it answers, unframed, rendered by the
 * surface that asked and by no other. Both run inside the caller's
 * transaction: the post, the execution's record, its chain entry and the
 * message's disposition commit together, so a crash can never leave an answer
 * half-told (ADR-0020).
 *
 * THE SIGIL IS THE THREAD'S RULE AND NOT THE POST'S. `assertFramed` refuses an
 * unframed notice because a message arriving in a chat the rep also types in
 * has to be visibly the twin's (ADR-0037) — a keyword needs a missing button.
 * The dashboard has the button, no keyword and nothing else in the column, so
 * the door's post carries the parts without the frame and never passes through
 * that assertion. The rendering `composeAnswerPost` returns beside the parts is
 * the THREAD's bytes, so a door answer discards it: there is no thread to
 * render, and storing one would be a second, unread copy of what the rep saw.
 *
 * THE RECEIPT IS BUILT FROM WHAT THE TOOL DID (ticket #174), never from model
 * text: one post per turn carries what the twin DID, then what it says about
 * it — two registers in that order, and only the second is the twin's own
 * voice, its words as it wrote them (ticket #363).
 *
 * ...AND SO IS THE BINDING QUESTION, WHEN THE TURN HANDED THE REP ONE IN THE
 * THREAD (tickets #195, #363: the twin's `propose_binding` call, never its
 * words). The same post is registered as the ceremony's question for that chat —
 * the notice kind and the `about_event_id` the day's read's own proposal
 * writes — so a bare «si» quoted on it binds through the matcher with
 * nothing about the matcher changed. That is why the post is anchored on the
 * CUSTOMER-chat event rather than on the rep's message: the confirmation
 * re-derives the chat and the name from that event's sealed payload, so what
 * a «si» confirms is what the rep was shown.
 *
 * AT THE DASHBOARD'S DOOR IT IS NOT FOLDED (ticket #261), and the caller is
 * what decides: a question is PROACTIVE — both surfaces, its own send — and a
 * door answer is delivered to the door alone, so `consumer.ts` posts the
 * question beside this reply rather than inside it, and this function is
 * handed no `binding` on that door.
 *
 * Use the seat's resolved zone for the post as for the execution's «now»,
 * beats and search hits: the model and rep must read the same hour
 * (#172's recorded remainder; #139).
 */
export async function postAnswer(
  deps: AnsweringDeps,
  args: {
    /** Which door the rep asked through — where this answer is delivered. */
    readonly door: Door;
    /**
     * The rep's own row — what the answer is about and what gets marked. A
     * turn nobody wrote has none and answers with a line on Inicio instead
     * (ticket #320; `consumer.ts`).
     */
    readonly eventId: string;
    /** The execution that composed it (ticket #173). */
    readonly executionId: string;
    /** The answer, references as the twin wrote them (ticket #321). */
    readonly answer: string;
    /** What each of its references named — sealed beside the words. */
    readonly mentions: readonly Mention[];
    /**
     * The acknowledgement of what this turn's effect tool DID, when one
     * did (ticket #174), rendered from the tool's own result.
     *
     * IT ARRIVES HERE RATHER THAN BEING COMPOSED, which is the whole of
     * ADR-0037's rule about receipts: a model that wrote the same sentence
     * into `answer` above changes nothing about what is rendered as the
     * receipt, because the caller passes what the TOOL returned.
     */
    readonly receipt?: string;
    /**
     * The binding question this post also asks, when the turn handed the rep
     * one and code found it due (tickets #195, #363).
     *
     * IT IS WHAT MAKES THE POST THE CEREMONY'S OWN. With it the notice is a
     * `binding_question` about that question's event — the shape the
     * matcher, the once-ever read, the decline tool and the crossing backlog
     * all already recognize — and without it the post is an ordinary answer
     * about the rep's own message. Nothing between the two.
     */
    readonly binding?: BindingQuestion;
    /** The workspace documents the turn wrote, each at the version its end took (ticket #326). */
    readonly documents?: readonly DocumentPart[];
  },
): Promise<void> {
  const asksBinding = args.binding !== undefined;
  const post = composeAnswerPost({
    answer: args.answer,
    mentions: args.mentions,
    ...(args.receipt === undefined ? {} : { receipt: args.receipt }),
    ...(args.binding === undefined ? {} : { binding: args.binding }),
    ...(args.documents === undefined || args.documents.length === 0 ? {} : { documents: args.documents }),
  });
  if (args.door === "dashboard") {
    await insertPost(deps.db, {
      twinId: deps.twinId,
      dek: deps.dek,
      parts: post.parts,
      executionId: args.executionId,
      asked: { door: "dashboard", messageId: args.eventId },
    });
    return;
  }
  await insertNoticeWithSystemSend(deps.db, {
    twinId: deps.twinId,
    selfChatJid: deps.selfChatJid,
    dek: deps.dek,
    kind: asksBinding ? "binding_question" : "answer",
    aboutEventId: args.binding?.aboutEventId ?? args.eventId,
    post,
    executionId: args.executionId,
    // A POST THAT ALSO ASKS IS PROACTIVE, AND CARRIES NO DOOR (ticket #261).
    // A binding question goes to both surfaces because the rep answers it
    // wherever they are — and this post IS the question (#195), so marking it
    // as the thread's would take the card off Inicio and leave the rep one
    // place to answer. Only a post that is nothing but an answer TO A MESSAGE
    // belongs to the door it was asked at.
    ...(asksBinding ? {} : { asked: { door: "twin_thread" as const } }),
  });
}

/**
 * WHETHER THE BINDING CEREMONY IS DUE FOR THE CHAT A TURN ASKED ABOUT,
 * and where it would anchor (#34's hand-off; spec #29 grilling decision 3;
 * spec #171 decision 17; tickets #195, #363).
 *
 * CODE DECIDES A QUESTION IS DUE AND THE TWIN WRITES THE SENTENCE (#195).
 * Due-ness is this function's, and none of it is a judgement a model makes:
 * an unbound chat of the rep's, never asked about, with a name the
 * COUNTERPARTY supplied. The chat is the one the twin's `propose_binding`
 * call named by reference.
 *
 * Same once-ever rule and same asked-state as the draft path — the committed
 * question notice — so the two triggers can never both ask. The proposal comes
 * from the rail's push-name only: a chat with none has nothing to propose
 * (asking «¿Este chat es de 5215550001?» would mint number-named entities —
 * #34's recorded decision 1), and model text can never become a proposed
 * name.
 *
 * Returns the customer-chat event the question is ABOUT, or undefined when
 * nothing is owed — in which case the reply posts alone. `propose_binding`
 * reads it first so the twin is told; the read that decides is the caller's,
 * INSIDE the answer's transaction and under the ceremony's lock, so
 * asked-state can never drift from what the rep actually saw — and so two
 * executions running at once cannot both decide the same chat is unasked
 * (`takeBindingCeremonyLock`, #173).
 */
export async function bindingQuestionAnchor(
  deps: AnsweringDeps,
  chat: AskedChat,
): Promise<string | undefined> {
  // The rep's own thread is searchable and citable (#173; spec #171 decision
  // 19), but a binding question about it would let the rep confirm
  // themselves as a customer and bind the twin thread to an entity.
  if (chat.chatJid === deps.selfChatJid) return undefined;
  if (deps.bundle.readChatBinding(chat.chatJid) !== undefined) return undefined;
  // RE-READ HERE AND NOT TRUSTED FROM `chat.asked`. The search read the
  // asked-state to tell the model what it may ask about; this read is the
  // ceremony's own, under the per-twin lock, and it is the one that decides.
  if (await bindingQuestionAsked(deps, chat.chatJid)) return undefined;
  for (const messageId of chat.anchors) {
    const aboutEventId = await sourceEventForHit(deps, {
      chatJid: chat.chatJid,
      messageId,
      pushName: chat.pushName,
    });
    // No resolvable source event means no question FROM THIS ROW. The whole
    // ceremony hangs off `about_event_id`, so asking without one would
    // create a question that can never be answered — try the next candidate
    // rather than giving up on the chat.
    if (aboutEventId !== undefined) return aboutEventId;
  }
  return undefined;
}

/**
 * Resolve the cited row's source as the question's `about_event_id` (#34).
 * Asked-state and confirmation derive the chat and proposed name from that
 * event's encrypted payload. Using the triggering self-chat message instead
 * would re-ask forever and bind the wrong chat. As on the draft path
 * (`consumer.ts`), the anchor must be in the chat the question asks about.
 *
 * Both feeds use `<chat>:<message-id>` external ids to find candidates, but
 * the payload must verify their identity and proposed name: a «va» must
 * confirm exactly what the rep saw.
 *
 * Only message events can anchor a proposal (#97). Reaction hits are
 * retrievable, but the decoder refuses their payloads outright, so the
 * query must stay message-only. They also cannot propose a name; try the
 * next candidate and leave a gesture-only chat waiting for a message.
 */
async function sourceEventForHit(
  deps: AnsweringDeps,
  hit: {
    readonly chatJid: string;
    readonly messageId: string;
    readonly pushName: string;
  },
): Promise<string | undefined> {
  // The composed id is a PREFIX, not an equality: a re-delivery of the same
  // message appends a suffix (#33's `…:history`). LIKE is therefore right,
  // but the pattern is built from rail data — a message id containing `_` or
  // `%` would be a wildcard and could match a DIFFERENT event in the same
  // chat — so the operands are escaped and an explicit ESCAPE clause is set.
  const prefix = likeLiteral(`${hit.chatJid}:${hit.messageId}`);
  const res = await deps.db.query<{ id: string; payload_enc: Buffer }>(
    `SELECT id, payload_enc
       FROM wa_events
      WHERE twin_id = $1 AND external_event_id LIKE $2 ESCAPE '\\'
        AND event_type = 'message'
      ORDER BY id`,
    [deps.twinId, `${prefix}%`],
  );
  for (const row of res.rows) {
    // The id only NARROWS the scan; identity is decided by the sealed
    // payload. All three fields are checked — chat, message id, and the
    // push-name being proposed — so even a wildcard match, a suffixed
    // re-delivery, or an arbitrary row order cannot resolve the question to
    // another message: what a «va» confirms is what the rep was shown.
    const payload = decodeWaMessagePayload(deps.dek, row.payload_enc);
    if (
      payload.chatJid === hit.chatJid &&
      payload.messageId === hit.messageId &&
      payload.pushName === hit.pushName
    ) {
      return row.id;
    }
  }
  return undefined;
}

/** Escapes a value for safe use as a LIKE prefix (with ESCAPE '\'). */
function likeLiteral(value: string): string {
  return value.replace(/[\\%_]/gu, (ch) => `\\${ch}`);
}

/**
 * Whether this chat's once-ever binding question has already been posted
 * (ticket #34). The asked-state is the committed question notice itself; the
 * chat a question asks about lives only inside its source event's
 * DEK-encrypted payload, so the sweep decrypts to compare — at most one
 * question exists per chat ever, so the set stays as small as the twin's
 * asked chats.
 *
 * It lives here, beside the answer path, because BOTH triggers share it: the
 * draft path (#34) and the answer path (#35, "the first draft OR ANSWER
 * needing a {cliente}"). One asked-state, one reader — and from #173 both
 * read it under one per-twin lock, because two executions running at once
 * would otherwise both find a chat unasked and both ask.
 */
export async function bindingQuestionAsked(
  deps: Pick<AnsweringDeps, "db" | "dek" | "twinId">,
  chatJid: string,
): Promise<boolean> {
  const asked = await deps.db.query<{ payload_enc: Buffer }>(
    `SELECT e.payload_enc
       FROM notices n
       JOIN wa_events e ON e.id = n.about_event_id
      WHERE n.twin_id = $1 AND n.kind = 'binding_question'`,
    [deps.twinId],
  );
  return asked.rows.some(
    (row) => decodeWaMessagePayload(deps.dek, row.payload_enc).chatJid === chatJid,
  );
}
