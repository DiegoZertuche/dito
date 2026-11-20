/**
 * WHAT ONE THREAD EXECUTION IS BUILT OVER (ticket #173; spec #171 decisions 9
 * and 19).
 *
 * The occasion binds three kinds of thing at construction, and this is the
 * first: the DEPENDENCIES. A spec holds no function, no connection and no
 * content (`automation.ts`), so the rep's message, the post they pointed at,
 * the last beats of the thread, twin memory's reach and this run's served map
 * all arrive here — the way the drafting side's turn and transcript do.
 *
 * WHY CONTENT COMES THROUGH HERE AND NOT AS PARAMETERS. `ParameterValue` is
 * scalar by design: "a parameter rich enough to be an object would be content
 * travelling under the name of a parameter" (`registry.ts`). A message is a
 * string but a thread is a list of them, so neither can be a parameter and
 * neither should be — what a spec declares is a recipe's NAME and the SHAPE
 * of what varies, and the digest stamps exactly that.
 *
 * EVERYTHING POSTGRES-SHAPED IS READ AND RENDERED BEFORE IT GETS HERE.
 * Recipes are synchronous — `RecipeRenderer` returns a `NamedPart`, not a
 * promise — and the quoted post's words live in an encrypted notice or an
 * encrypted draft, while the twin's own half of the thread lives behind the
 * executor's record of what it actually posted. So the consumer performs
 * those reads on the runtime's own connection, sequentially, before it
 * submits the execution to the lane; what reaches here is rows, decrypted.
 *
 * WHICH ALSO FIXES WHEN THE CONTEXT IS A SNAPSHOT OF, and it is worth saying
 * because executions now interleave: the recipes render at CONSTRUCTION, so a
 * thread execution's context is the thread as it stood when the router
 * reached this message — not as it stands when the model happens to read it.
 * The one thing that reads twin memory later is the search tool, which is
 * exactly the thing the model asked for.
 */
import type { Bundle } from "@dito/bundle";
import type { Dek } from "@dito/crypto";
import type {
  ArrivalTrigger,
  Harness,
  RunStepTrigger,
  TwinThreadEventTrigger,
  TwinThreadMessageTrigger,
} from "@dito/execution";
import type pg from "pg";
import type { DraftBlank } from "../blanks.js";
import type { Embedder } from "../embedder.js";
import type { TwinPostKind } from "../twin-posts.js";
import type { ActSlot } from "./acts.js";
import type { TurnDraftTiming } from "./draft-timing.js";
import type { HeldDraftSlot } from "../drafts.js";
import type { TurnBindingProposal } from "./propose-binding.js";
import type { ServedHits } from "./served.js";
import type { RunEngine } from "../runs/engine.js";

/**
 * What a draft the rep pointed at can be.
 *
 * THREE STATES AND THEY ARE NOT DECORATION. A draft the rep quotes may be
 * waiting for their tap, already sent, or dismissed — and dismissal is
 * TERMINAL (ADR-0037; CONTEXT.md *Dismiss*), so «¿ya se fue?» and «hazme
 * otro» are different questions depending on which. A twin shown the body
 * without the state can only guess, and the guess a model makes about
 * something it cannot see is the one it states most confidently.
 */
export type DraftState = "live" | "tapped" | "dismissed" | "filled";

/** A twin post the rep pointed at, as the execution is shown it. */
export interface QuotedPost {
  /**
   * Which kind of post it was, when it was one of the kinds the registry
   * knows. Absent for a twin post with no verb — a send confirmation, a
   * refusal, an ack, an earlier answer — which is context and nothing else.
   */
  readonly kind?: TwinPostKind;
  /** The post's own words, exactly as the rep read them. */
  readonly text: string;
  /** Where a draft stands, present exactly when the post carried one. */
  readonly draftState?: DraftState;
  /** The reference of the customer a quoted draft was written for (ticket #321). */
  readonly customer?: number;
  /**
   * THE LINE THE REP EDITED ON THE CARD, when their message is that line
   * corrected in place (ticket #344): the number the record printed, off the
   * door's message row — the rep's tap, never anything the model read.
   */
  readonly editedLine?: number;
  /**
   * THE BLANK THE REP ANSWERED, when their message is the answer to one the
   * twin left in this draft (ticket #342): the blank they tapped — or tapped
   * Enviar with open — off the door's message row, never anything the model
   * read.
   */
  readonly answeredBlank?: DraftBlank;
}

/**
 * WHAT WAKES A TURN OF THE TWIN THREAD: a rep's line through either door, an
 * event from the seam, or the rep's arrival on Inicio (tickets #319, #320) —
 * and the step of a workflow run that reads or acts with the thread's own
 * tools (ticket #323), which carries no rep line and so passes no gate that
 * asks for one.
 */
export type ThreadTrigger =
  | TwinThreadMessageTrigger
  | TwinThreadEventTrigger
  | ArrivalTrigger
  | RunStepTrigger;

/** What one thread execution's parts, tools and contract are built over. */
export interface ThreadDeps {
  /**
   * THE CONNECTION THIS EXECUTION'S TRANSACTION IS OPEN ON (ticket #174).
   *
   * BORROWED, NOT THE RUNTIME'S OWN, and threading it through here is what
   * makes an act and its account of itself one commit: a rep-act tool
   * writes the dismissal row, the aperture's retraction or the question's
   * answer on THIS client, so the write lands in the same transaction as
   * the execution's record, its chain entry, the receipt post and the
   * event's processing marker (ADR-0020's rule, as `chainApertureAct`
   * states it for the aperture). Reaching for the runtime's `deps.db` from
   * inside a tool would put the act in a different transaction from the
   * post that acknowledges it.
   *
   * `ClientBase`, like every other reader in this package: nothing here
   * connects, ends or reads a connection's settings.
   */
  readonly db: pg.ClientBase;
  /** The twin's key — the aperture opens the rep's own seam row under it. */
  readonly dek: Dek;
  readonly twinId: string;
  /**
   * THIS EXECUTION'S OWN ID (ticket #175), minted before the run.
   *
   * A draft the rep asked for names it in its timing row, exactly as a
   * customer-triggered one does — so NFR-2 is measured off `draft_timings`
   * on both occasions rather than off `executions` on one of them and
   * `draft_timings` on the other. It is the SAME id the record and the
   * chain entry carry, handed in rather than re-minted, for the reason the
   * trigger is: two mintings would be two answers to "which execution".
   */
  readonly executionId: string;
  /**
   * The rep chain's key, for the one entry a tool writes itself.
   *
   * `retract_disclosure_line` REFUSES SOME CORRECTIONS BEFORE THE APERTURE
   * SEES THEM — a number the post never showed — and a definite act refused
   * is chained (spec #48 decision 18, and Diego's standing rule quoted in
   * `audit-coverage.ts`). The aperture chains the acts it decides itself
   * under its own key; this is for the one it never gets to see.
   */
  readonly hmacKey: Uint8Array;
  /**
   * THE WAKE THAT CREATED THIS EXECUTION (ticket #174; ADR-0013's
   * 2026-09-04 amendment; ADR-0003 as amended).
   *
   * IT IS THE GATE ON EVERY REP-ACT TOOL. A `rep-evidenced` tool "takes the
   * id of a rep-authored twin-thread message as a required parameter and
   * verifies, by code against the execution's trigger, that this message is
   * the one that created the execution" — this is that trigger, and
   * `evidence.ts` is that verification. The trigger is by construction the
   * rep's own self-chat message this execution was created for (the router
   * builds it from the event it is processing), so an id that equals
   * `trigger.eventId` is the rep's own act and an id that does not is
   * somebody else's, another turn's, or invented.
   *
   * ONE OBJECT, STATED ONCE. The consumer builds the trigger before it
   * builds these deps and hands the SAME value to both — to `runExecution`,
   * which puts it on the record and the chain entry, and to here, which is
   * what the tools check against. Two constructions of "which message is
   * this" would be two chances for the record and the gate to disagree.
   *
   * A CUSTOMER-TRIGGERED EXECUTION CANNOT HOLD ONE, which is the structural
   * half: `ThreadDeps` is the twin thread's own type, so drafting has no
   * field to put a rep message id in and its registry holds none of these
   * tools.
   *
   * A TURN AN EVENT WOKE HOLDS NO REP MESSAGE (ticket #319): its trigger is
   * the event — or the rep's arrival (ticket #320) — so no id the model could
   * cite is the rep's and every rep-evidenced tool refuses (`repTriggerOf`).
   */
  readonly trigger: ThreadTrigger;
  /** Twin memory, for the search tool: every chat of the rep's. */
  readonly bundle: Bundle;
  /** The embedder boundary the search runs its query through. */
  readonly embedder: Embedder;
  /**
   * The rep's own thread.
   *
   * IT IS HERE TO BE SEARCHED, WHICH IS THE REVERSAL (spec #171 decision 19:
   * `search_memory` is a projection over "every chat of the rep's, the thread
   * included"). The Q&A excluded this chat from every search — the rep's own
   * just-asked question is trivially its own nearest neighbour, and the twin
   * would cite it back at them — and the exclusion cost the twin any memory
   * of what it and the rep had already worked out. Today's beats are the
   * day's session itself, and the search reaches the rest.
   */
  readonly selfChatJid: string;
  /**
   * What the rep put in front of the twin, verbatim or rendered — or, on a
   * turn an event woke, the event's own line.
   */
  readonly message: string;
  /**
   * Its own WhatsApp message id — the ONE row the search may never serve
   * (Codex r2).
   *
   * THE REP'S QUESTION IS ITS OWN NEAREST NEIGHBOUR. Every self-chat message
   * is ingested and embedded before routing decides anything, so by the time
   * a thread execution searches, the message it is answering is in twin
   * memory — and being the query's own words it ranks first. Without this
   * the twin would cite the rep's question back at the rep as the source of
   * its answer, and on a sparse twin it is the ONLY hit, which also makes the
   * honest empty search unreachable.
   *
   * IT IS NOT THE Q&A's EXCLUSION COMING BACK. That one dropped the whole
   * self-chat, and spec #171 decision 19 reverses it: the thread's history is
   * searchable and citable, which is the point. What is excluded is one row —
   * the message being answered — because it travels in its own part, and a
   * message standing under two headings is a message counted twice.
   *
   * ABSENT AT THE DASHBOARD'S DOOR, where there is no such row to exclude
   * (ticket #261): a door message is not a WhatsApp message, is never ingested
   * and is therefore never a search hit. It is also the reason the evidence
   * gate reads `trigger.door` rather than this field — which row authorized
   * the turn is the trigger's to say.
   */
  readonly messageId?: string;
  /** The twin post they pointed at, when they pointed at one. */
  readonly quotedPost?: QuotedPost;
  /**
   * The seat the twin serves, when it has one — whose seen-stamps the canvas
   * read reports and whose last line it is (ticket #320).
   */
  readonly seatId?: string;
  /**
   * WHAT IS ON THE REP'S CANVAS AS THIS WAKE BEGAN, rendered once (ticket #320;
   * spec #318 decision 10; design §3.2): one reference block in every wake's
   * message, the same rendering `read_canvas` returns, so the twin never
   * guesses what is on screen. Its cards are numbered in `served` already.
   */
  readonly canvasBlock: string;
  /** The rep's language and register — see `DEFAULT_REP_LANGUAGE`. */
  readonly repLanguage: string;
  /**
   * The seat's IANA zone, resolved by the caller.
   *
   * ONE VALUE FOR THE WHOLE TURN, as it is on the drafting side: the «now»
   * part, the thread's own instants, the search's hits and the answer post's
   * citation line all render from THIS zone, so the four cannot disagree
   * about an hour — which is #139's founding complaint. It closes #172's
   * recorded remainder about this surface: the Q&A's answer post took the
   * host clock at its own render site.
   */
  readonly timeZone: string;
  /**
   * THE TWO INSTANTS NFR-2 IS MEASURED BETWEEN (ticket #175).
   *
   * `eventReceivedAt` is when the seam took the rep's message in and
   * `runtimeSeenAt` is when the runtime picked it up — the same pair a
   * customer-triggered draft's timing row carries, so a draft the rep
   * asked for is measured by the same arithmetic and needs no second
   * surface. `runtimeSeenAt` is also the instant the «now» part renders,
   * which is why it is HERE rather than a second parameter beside the
   * deps: one turn cannot be told one hour and render another.
   */
  readonly eventReceivedAt: Date;
  readonly runtimeSeenAt: Date;
  /**
   * WHEN THE DRAFT THIS TURN WROTE WAS READY (tickets #175, #321) — written
   * by `create_draft`, read by the consumer once the run's record exists
   * (`draft-timing.ts`).
   */
  readonly draftTiming: TurnDraftTiming;
  /**
   * THE DRAFT THIS TURN'S `create_draft` CHECKED, held until the turn's words
   * are known (ticket #368; `drafts.ts`'s `HeldDraft`): the turn's caller
   * writes it with them, after the record.
   */
  readonly draft: HeldDraftSlot;
  /**
   * This run's served hits — written by the search, read by the contract.
   *
   * MUTABLE AND RUN-SCOPED, and it is in the deps rather than inside the tool
   * because two things need the same one: a citation may only name what the
   * search served, and the two halves of that sentence are built together
   * from this value (the owner twin threads its `ServedRows` the same way).
   */
  readonly served: ServedHits;
  /**
   * The one act this message gets (ticket #174; spec #171 decision 19: "act
   * with a tool when they asked for an effect, ONE ACT PER MESSAGE").
   *
   * RUN-SCOPED LIKE `served`, AND FOR THE SAME REASON: four tools need the
   * same one, and a counter inside any of them would be a rule that held
   * for that tool alone. It is claimed on the CALL rather than on the
   * performance, so «así no y también el 3 está mal» gets one act and a
   * refusal naming the tool that already holds the slot — which the model
   * can relay, so the rep learns to ask for the second thing separately.
   */
  readonly acts: ActSlot;
  /**
   * THE BINDING QUESTION THIS TURN HANDED THE REP (ticket #363) — written by
   * `propose_binding`, read by the consumer once the turn's record exists.
   */
  readonly binding: TurnBindingProposal;
  /**
   * WHAT THE RUN TOOLS REACH (ticket #323): the twin's harness directory,
   * where a run's session and its sealed content are written; the model rung
   * a run's session child is opened with; and this process's runs engine, so
   * a steer never writes a run's session while a step of it is in flight
   * here. Absent where an execution holds no run tool.
   */
  readonly harness?: Harness;
  readonly model?: string;
  readonly runs?: RunEngine;
}

/**
 * The rep's message this turn answers — or `undefined` on a turn an event
 * woke, which answers nobody's message and so can cite nobody's evidence
 * (ticket #319).
 */
export function repTriggerOf(
  deps: Pick<ThreadDeps, "trigger">,
): TwinThreadMessageTrigger | undefined {
  return deps.trigger.kind === "twin_thread_message" ? deps.trigger : undefined;
}
