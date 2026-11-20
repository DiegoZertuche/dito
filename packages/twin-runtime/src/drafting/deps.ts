/**
 * WHAT ONE DRAFTING TURN IS BUILT OVER (tickets #172, #363; spec #171
 * decisions 9 and 15).
 *
 * A definition holds no function, no connection and no content
 * (`runs/shipped-conversations.ts`), so the tools' reach over twin memory and
 * the connection the draft is written on, the turn's own messages, the chat's
 * recent transcript, the memories retrieval served and what the binding says
 * all arrive here — the drafting conversation the engine binds the step to
 * (`runs/conversation.ts`).
 *
 * WHY CONTENT COMES THROUGH HERE AND NOT AS PARAMETERS. `ParameterValue` is
 * scalar by design: "a parameter rich enough to be an object would be
 * content travelling under the name of a parameter" (`registry.ts`). A turn
 * is a list of messages and a transcript is a longer one, so neither can be
 * a parameter and neither should be — what a definition declares is a
 * recipe's NAME, and the digest stamps exactly that.
 * The recipes read these fields; nothing here reaches the bytes.
 *
 * THE ROWS ARE READ AND RENDERED BEFORE THEY GET HERE. Recipes are
 * synchronous — `RecipeRenderer` returns a `NamedPart`, not a promise — and
 * retrieval embeds a query and searches a vector store, which is a database
 * round trip. So the consumer performs the two bounded reads it has always
 * performed (the recent window, one retrieval page) and hands the rows over;
 * gestures are already composed against what twin memory holds right now
 * (#97) and an unreadable delivery already carries its code-rendered
 * placeholder (ADR-0042), because both are properties of the ROW rather than
 * of the prompt.
 */
import type { Bundle, ConversationRow } from "@dito/bundle";
import type { Dek } from "@dito/crypto";
import type pg from "pg";
import type { HeldDraft } from "../drafts.js";
import type { Embedder } from "../embedder.js";

/** What this turn's `create_draft` held for its caller (tickets #363, #368). */
export interface TurnDraft {
  /** The draft, held until the turn's words are known (`drafts.ts`'s `HeldDraft`). */
  readonly held: HeldDraft;
  /** The twin's own sentence for the binding question, when one was due and it wrote one. */
  readonly bindingQuestion?: string;
}

/**
 * THE ONE DRAFT A DRAFTING TURN WRITES, held for the caller (tickets #363,
 * #368): the tool checks it inside the model loop, before the turn's record
 * and its words exist, and what follows from it — the draft's row and its post
 * with the turn's words, the binding question, the timing row, the markers —
 * is the caller's, after the record (`consumer.ts`). Run-scoped like the
 * thread's `ActSlot`, so a second call in the same turn is refused.
 */
export class DraftSlot {
  #draft: TurnDraft | undefined;

  /** The draft this turn wrote, if it wrote one. */
  get draft(): TurnDraft | undefined {
    return this.#draft;
  }

  /** Holds the turn's draft; a turn holds one. */
  hold(draft: TurnDraft): void {
    if (this.#draft !== undefined) throw new Error("a drafting turn holds one draft");
    this.#draft = draft;
  }
}

/** What one drafting turn's parts and tools are built over. */
export interface DraftingDeps {
  /** Twin memory, for the one tool: a search scoped to this chat. */
  readonly bundle: Bundle;
  /** The embedder boundary the search runs its query through. */
  readonly embedder: Embedder;
  /** The chat being answered. What scopes the search, by construction. */
  readonly chatJid: string;
  /**
   * Who this chat belongs to: the rep-confirmed name when the chat is bound,
   * the rail's push-name (or the bare number) when it is not.
   *
   * UNMARKED, and the mark's absence is the point (the two-axis review's
   * Spec axis). «(sin confirmar)» is a FRAME LABEL — chrome the rep reads on
   * the post, kept in code by ADR-0037's amendment — and `bindingConfirmed`
   * beside this field says the same thing in the language the instructions
   * are written in. Putting the marked rendering here would say it twice,
   * the second time in Spanish, inside a prompt whose whole claim is that
   * nothing code wrote into it is.
   */
  readonly counterparty: string;
  /** Whether a rep has confirmed who this chat is. */
  readonly bindingConfirmed: boolean;
  /**
   * Whether this chat's once-ever binding question is due — decided by
   * CODE (unbound, a push-name to propose, never asked before), which is
   * what spec #171 decision 17 requires. When it is, `create_draft` takes a
   * composed sentence and `proposedName` is what a rep's yes would confirm.
   */
  readonly bindingQuestionDue: boolean;
  /** The name the rail supplied, present exactly when the question is due. */
  readonly proposedName?: string;
  /** The new, unanswered counterparty messages, in conversation order. */
  readonly turn: readonly ConversationRow[];
  /** The chat's recent window, with the turn's own messages removed. */
  readonly transcript: readonly ConversationRow[];
  /** What retrieval served for this turn, deduped against the window. */
  readonly memories: readonly ConversationRow[];
  /** The rep's language and register — see `DEFAULT_REP_LANGUAGE`. */
  readonly repLanguage: string;
  /**
   * The seat's IANA zone, resolved by the caller.
   *
   * REQUIRED HERE THOUGH IT IS OPTIONAL ON THE RUNTIME'S DEPS, and that is
   * the point of resolving it once: the «now» part, the search's hits and
   * the frozen post's clock time all render from THIS value, so the three
   * cannot disagree about an hour — which is #139's founding complaint one
   * surface over. Unset on the runtime means the host clock, and the
   * consumer resolves that to a name before anything renders.
   */
  readonly timeZone: string;
  /**
   * THE CONNECTION THIS TURN'S TRANSACTION IS OPEN ON (ticket #363), borrowed:
   * `create_draft` writes the draft on it, so the draft and the record of the
   * turn that wrote it are one commit.
   */
  readonly db: pg.ClientBase;
  /** The twin's key — the draft's body and its post are sealed under it. */
  readonly dek: Dek;
  readonly twinId: string;
  /** The rep's own thread, where the Borrador is posted. */
  readonly selfChatJid: string;
  /** This execution's own id: the draft and its post name it, and its timing row. */
  readonly executionId: string;
  /** The message that closed the turn: the event the draft is recorded as replying to. */
  readonly anchor: { readonly eventId: string };
  /**
   * The counterparty as the REP reads them on the card — the confirmed name,
   * or the phone's marked «(sin confirmar)» — beside `counterparty`, which is
   * what the turn is told.
   */
  readonly counterpartyShown: string;
  /**
   * THIS CHAT'S CUSTOMER REFERENCE (ADR-0037 as amended 2026-10-02; ticket
   * #368): the sentence the rep reads above the draft names them by it, and
   * code renders the name — the twin never types one.
   */
  readonly reference: number;
  /** What this turn's `create_draft` held, for the caller. */
  readonly drafted: DraftSlot;
}
