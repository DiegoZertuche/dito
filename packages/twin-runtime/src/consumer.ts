/**
 * The seam consumer (ADR-0005): the twin-runtime's inbound loop. It reads
 * this twin's unprocessed `wa_events`, decrypts each payload under the
 * twin's DEK (ADR-0008), appends the conversation row to the bundle
 * (slice AC 10), and — for counterparty inbound in customer chats only —
 * runs the DRAFTING AUTOMATION over the settled turn and emits the draft
 * record plus its `system_send` command to the rep's self-chat (ADR-0006:
 * system_send carries no tap; the plane enforces the self-chat
 * destination from live session identity at execution).
 *
 * DRAFTING IS AN EXECUTION SINCE #172, not a harness. A settled turn
 * creates a `chat_turn` trigger, `@dito/execution`'s runner runs the
 * automation's definition over the scripted-or-real wire, and the run
 * leaves a content-free record on `public.executions` and one entry on the
 * rep's audit chain — committed in the same transaction as the draft, its
 * timing, the optional binding question and the turn's processing markers
 * (ADR-0020: nothing chained without a record, no record without an
 * entry).
 *
 * The twin never processes its own traffic as rep input: own-sent events
 * (`from_me`) and everything in the self-chat are captured into the
 * bundle and left for the affirmation matcher (#24/#25) — the classifier
 * never sees them.
 *
 * THE CHAT TRIGGER BATCHES (ticket #75). Drafting is not per message: a
 * customer chat's new counterparty messages are collected into one TURN
 * and answered by ONE draft, once that chat has been quiet for the settle
 * window — because a customer who types three short lines is making one
 * request, and three drafts for it is churn the rep must dismiss twice
 * (#69 finding 2). Every other route still runs per event and
 * immediately: a tap, a dismissal, a correction and an answer are rep
 * acts, and nothing about a rep act waits.
 *
 * IT READS A SECOND DOOR (ticket #261). `dashboard_messages` is the dashboard's
 * own inbound store — the rep's words from the bar, sealed by the local API —
 * and this loop routes those rows in the same pass, into the same
 * thread executions, marked in `dashboard_message_processing` with the same
 * vocabulary. Two sources, two inbound tables, one occasion: the rail writes
 * one and the lease holder writes the other, and neither can write the
 * other's (…20260922100010 argues why the door is not a `wa_events` row).
 *
 * Exactly-once: every event's outcome commits atomically with its
 * `wa_event_processing` marker; the marker's primary key is the lock.
 * BATCHING DOES NOT WEAKEN THAT. A turn's whole batch is marked inside the
 * one transaction that emits its draft, so every event of it is either
 * drafted-and-marked or neither. An event still inside its window is
 * simply UNMARKED — which is what makes the wait survive a restart, since
 * the settle window is a predicate over `wa_events.received_at` read back
 * from Postgres and never a timer held in memory.
 * Failures are loud and stop the pass — a payload this runtime cannot
 * read (tamper, unknown version, unknown event type) means a broken or
 * newer seam, never something to skip past silently.
 */
import { randomUUID } from "node:crypto";
import {
  fileEntityCreate,
  readFiledEntity,
  readTwinCompanies,
  type EntityKind,
  type RepActContext,
  type RepActEvidence,
} from "@dito/aperture";
import { inDeliveryOrder } from "@dito/bundle";
import type { Bundle, ChatBinding, ConversationRow, WorkspaceVersion } from "@dito/bundle";
import type { Dek } from "@dito/crypto";
import {
  WROTE_ACT,
  type ChatTurnTrigger,
  type EffectOutcome,
  type Session,
  type ArrivalTrigger,
  type TwinThreadEventTrigger,
  type TwinThreadMessageTrigger,
  type Harness,
} from "@dito/execution";
import type pg from "pg";
import { snapshotWorkspace } from "./workspace.js";
import { embedOne, type Embedder } from "./embedder.js";
import { classified, classifyBinding } from "./entity-kind/classify.js";
import { DEFAULT_ENTITY_KIND_MODEL } from "./extraction-config.js";
import type { ModelCallConfig } from "./model-config.js";
import { takeBindingCeremonyLock, withDbTransaction } from "./db-tx.js";
import {
  bindingAckReceipt,
  counterpartyDisplayName,
  counterpartyName,
  renderEntityCreateDisclosureLine,
} from "./grammar.js";
import { REFUSAL_MICROCOPY } from "./microcopy.js";
import type { TwinNotifier } from "./notify-tiers.js";
import {
  composeReceiptPost,
  documentPart,
  insertPost,
  prosePart,
} from "./posts.js";
import { confirmBinding } from "./rep-acts.js";
import { DRAFTING_WAKE } from "./drafting/automation.js";
import { DraftSlot, type DraftingDeps } from "./drafting/deps.js";
import { DEFAULT_REP_LANGUAGE } from "./rep-language.js";
import { openLanes, type Lane } from "./lanes.js";
import {
  THREAD_ARRIVAL_WAKE,
  THREAD_EVENT_WAKE,
  THREAD_MESSAGE_WAKE,
} from "./thread/automation.js";
import {
  ActSlot,
  THREAD_ACT_WORDS,
  type ThreadAct,
} from "./thread/acts.js";
import type { ThreadDeps, ThreadTrigger } from "./thread/deps.js";
import { TurnDraftTiming } from "./thread/draft-timing.js";
import { BINDING_PROPOSED_ACT, TurnBindingProposal } from "./thread/propose-binding.js";
import { readAnsweredBlank, readEditedCard, readQuotedPost } from "./thread/reads.js";
import { repTriggerOf } from "./thread/deps.js";
import {
  fateOf,
  postOf,
  renderEvent,
  type ThreadEvent,
} from "./thread/events.js";
import {
  createThreadSessions,
  type ThreadDayDeps,
  type ThreadSessions,
  type ThreadTag,
} from "./thread/sessions.js";
import {
  arrivalOnTheWire,
  curationOnTheWire,
  noteOnTheWire,
  readCuration,
  readLastLine,
  readNote,
  readOnCanvas,
  readSpotlight,
  spotlightOnTheWire,
} from "./canvas.js";
import {
  CARDS_MOVED_ACT,
  PRESENCE_ACT_WORDS,
  readCanvasView,
  renderCanvas,
  SAID_ON_CARD_ACT,
  SPOTLIT_ACT,
} from "./thread/canvas-tools.js";
import { AUTOMATION_ACT_WORDS } from "./runs/create-automation.js";
import { automationPaused } from "./runs/gate.js";
import { shippedAutomationOf } from "./runs/shipped-automations.js";
import { fireOnEvent } from "./runs/wakes.js";
import { RUN_ACT_WORDS } from "./runs/declarations.js";
import { ASK_ACT } from "./runs/ask.js";
import { executeStep, type RunEngine } from "./runs/engine.js";
import { DRAFTING_DEFINITION, THREAD_DEFINITION } from "./runs/shipped-conversations.js";
import { WORKING_MEMORY_ACT } from "./thread/working-memory.js";
import { openMattersOnTheWire } from "./working-memory.js";
import { indexThreadItems, type ThreadItemToIndex } from "./thread/memory-tools.js";
import {
  annotateNames,
  customersOf,
  mentionsIn,
} from "./thread/references.js";
import { ServedHits } from "./thread/served.js";
import { threadWordsRule } from "./thread/guard.js";
import {
  HeldDraftSlot,
  landDraft,
  type DraftTwin,
  postBindingQuestion,
  recordDraftTiming,
} from "./drafts.js";
import { matchCapturedEvent } from "./matcher.js";
import {
  insertNoticeWithSystemSend,
  postReceipt,
  type NoticeKind,
} from "./notices.js";
import {
  decodeWaMessagePayload,
  decodeWaOpaquePayload,
  decodeWaReactionPayload,
  type WaMessagePayload,
  type WaOpaquePayload,
  type WaReactionPayload,
} from "./payload.js";
import { opaqueConversationRow } from "./opaque.js";
import {
  bindingQuestionAnchor,
  bindingQuestionAsked,
  postAnswer,
  type AnsweringDeps,
  type BindingQuestion,
} from "./answering.js";
import {
  renderGesturesForModel,
  renderReactionGesture,
} from "./reactions.js";
import { retrieveRelevantMessages } from "./retrieval.js";
import { pendingAsks } from "./rep-asks.js";
import { HandOverOrder, type HandOver } from "./hand-over.js";
import type { SeatEvents } from "./seat-events.js";
import { publishPostSettle, publishSettle, type SettleDeps } from "./settles.js";
import { SETTLE_OUTCOMES, type Door, type SettleOutcome, type TwinApiMessageAbout } from "@dito/seam";
import { leftTheRepNothing } from "./exchanges.js";
import {
  feedPostOnTheWire,
  readPostsByIds,
  readRepliesAtTheDoor,
} from "./feed.js";
import { traceFor, type RuntimeTrace } from "./trace-render.js";
import type { SendLockWriter } from "./send-lock/writer.js";

export interface TwinRuntimeDeps {
  /**
   * A single dedicated connection (not a pool), for everything the pass does
   * SEQUENTIALLY: reading the pending events, routing each one to its
   * outcome, the settle predicate's reads, the two reads a thread execution
   * is built from, and every marker written outside an execution.
   *
   * NO EXECUTION RUNS ON IT (ticket #173). An execution holds a transaction
   * across its model call — the runner appends its audit entry inside that
   * transaction and it has to commit with the record (ADR-0020) — and `pg`
   * queues queries per client, so two executions interleaving here would
   * issue their statements into each other's open transaction and one's
   * COMMIT would commit the other's half-written work. Each takes its own
   * connection from `executionPool` instead; `lanes.ts` argues the whole
   * trade, including the alternative that was rejected.
   */
  readonly db: pg.Client;
  /**
   * Where an execution's own connection comes from (ticket #173; spec #171
   * decision 3).
   *
   * The composition root owns it, exactly as it owns the send-lock writer's:
   * a component that needs a transaction of its own gets a pool from the
   * boundary rather than inventing one, because a library that built its own
   * would need a connection string and this runtime holds no credential it
   * was not handed.
   *
   * SIZE IT FROM `REALTIME_LANE_CAP`. The lane bounds how many executions
   * borrow at once, so a pool smaller than the cap breaks nothing — an
   * execution simply waits for a connection — but it silently narrows the
   * concurrency the cap declares.
   */
  readonly executionPool: pg.Pool;
  readonly harness: Harness;
  readonly bundle: Bundle;
  readonly dek: Dek;
  readonly twinId: string;
  /**
   * The rep's self-chat JID — the twin thread system_send is addressed
   * to. Config-bound this slice, like the plane's twin binding (#21/#22);
   * the plane independently enforces "self" from live session identity
   * (ADR-0006), so a misconfigured value can never reach another chat.
   */
  readonly selfChatJid: string;
  /** Model config for the drafting call site (ADR-0015). */
  readonly drafting: ModelCallConfig;
  /**
   * Model config for the EXTRACTION call site (ticket #52). ADR-0015 puts
   * extraction on the Haiku rung; the routed ladder is deferred, so this is
   * optional and falls back to `drafting` — here so a composition root can
   * route it separately the day the ladder lands, without a code change at
   * the call site.
   */
  readonly extraction?: ModelCallConfig;
  /**
   * The entity-KIND classification's own model (ticket #148, Codex r1).
   *
   * It used to be derived from `extraction`, and that coupling turned this
   * ticket's rung move into a defect at a call site nobody measured — see
   * `runtime.ts`, where the derivation was. Absent, it falls back to
   * `DEFAULT_ENTITY_KIND_MODEL` rather than to whatever extraction is
   * running, so moving one rung can never move the other by accident.
   */
  readonly kindModel?: ModelCallConfig;
  /**
   * The embedder boundary (#32, spec #29 decision 9): BGE-M3 in-process
   * on the rig, the deterministic fake in integration lanes — which one
   * runs is this composition choice, never a code path. Every ingested
   * message embeds through it into the bundle's vector store.
   */
  readonly embedder: Embedder;
  /**
   * The send-lock writer (#24): the affirmation matcher's one path to a
   * tap and its customer_send (ADR-0006). The writer runs its own
   * transaction on its own pool; the consumer's marker commits after it.
   */
  readonly sendLock: SendLockWriter;
  /**
   * The audit chain's HMAC key (ADR-0020; tickets #53 and #54). Rep acts
   * and refusals are audit-chained (spec #48 decision 18), and every
   * class-2 act this consumer can receive is one: the entity CREATE (#50
   * filed it unchained, #51 sized the gap, #54 closed it), the RETRACTION
   * (#54) and the rep's ANSWER to an aperture question (#53). One key, one
   * vocabulary, one chain.
   *
   * Held here rather than inside the aperture because custody is a
   * composition concern (ADR-0020's custody note): the rig loads it from
   * the environment, the suites mint one per run, and the key reaches the
   * aperture through the same deps every other credential does. The
   * send-lock writer already takes its own copy for its refusal path.
   *
   * REQUIRED, not optional (#53). An optional key would move the failure
   * from composition time to the moment a rep says «si», where — the
   * runtime being fail-stop — it would take drafting and the Q&A down with
   * it. A missing key is a deployment mistake, and the honest place to
   * catch a deployment mistake is the typecheck.
   */
  readonly hmacKey: Uint8Array;
  /** How many recent conversation rows the harness sees (default 20). */
  readonly historyLimit?: number;
  /** How many RETRIEVED (relevance-ranked) rows the drafting call carries (default 6). */
  readonly retrievalLimit?: number;
  /**
   * The rep's own clock (an IANA zone), read by the daily disclosure
   * (ticket #51): it decides «hoy» and «ayer», and it derives THE DAY,
   * which is the key that pass's idempotence rests on. Unset means the
   * host clock, which is what the rig runs on today; tests pin it so
   * fixtures are exact wherever the suite runs.
   *
   * IT NOW REACHES THE DRAFT TOO (ticket #172; #30's remainder 4, closed).
   * The drafting execution's «now» part and the frozen post's clock time
   * are rendered from ONE resolved value, so the hour the model is told
   * and the hour the rep reads cannot disagree. The Q&A's answer post
   * still takes the host clock at its own render site; that one moves with
   * the twin thread (#173).
   */
  readonly timeZone?: string;
  /**
   * The rep's language and register, as the drafting execution is told
   * them (ticket #172; spec #171 decision 15, user story 17).
   *
   * DATA, NOT A CONSTANT IN A PROMPT. The drafting instructions used to
   * carry «this rig's traffic is Mexican Spanish», so a rep in another
   * register had no way to be right. It arrives here from the deployment —
   * `DITO_REP_LANGUAGE` at the rig's boundary — and the rep notepad
   * replaces it in slice 6 with a line the rep wrote (ADR-0033). Unset
   * means `DEFAULT_REP_LANGUAGE`, which is this rig's own traffic and one
   * line to change.
   */
  readonly repLanguage?: string;
  /**
   * The hour of the rep's day, 0–23, at which the scheduled daily
   * disclosure may post (default 21). Here so a composition root — the
   * rig, above all — can actually set it (ticket #51).
   */
  readonly disclosureHour?: number;
  /**
   * How quiet a customer chat must go before its new messages become one
   * draft (ticket #75; default SETTLE_WINDOW_MS). ONE CONSTANT, not a
   * per-twin setting: there is no evidence yet that any two reps want a
   * different figure, and a knob nobody turns is a knob that lies. It is
   * here for the same reason `historyLimit` and `disclosureHour` are — so
   * a composition root (the suites, which drive real elapsed time rather
   * than waiting a minute and a half) can set it without a code change.
   */
  readonly settleWindowMs?: number;
  /**
   * The ceiling on how long a turn may keep deferring (ticket #75; default
   * BATCH_CEILING_MS). Measured from the OLDEST unanswered message, so a
   * customer who types every thirty seconds cannot postpone their draft
   * forever — an unbounded reset is a liveness bug, not a feature.
   */
  readonly batchCeilingMs?: number;
  /**
   * THE SERVICE THAT REACHES THE REP WHEN THEY ARE NOT LOOKING (ticket #262;
   * ADR-0022 as amended, ADR-0013 class 4).
   *
   * A VALUE AND NOT AN IMPORT, which is the one thing about it that is
   * structural. This package assembles every rep-side automation registry, and
   * `dependency-wall.test.ts` refuses `@dito/notify` as a runtime dependency of
   * any package that does — so the rails stay off every model tool surface by
   * construction rather than by anybody remembering. The runtime declares the
   * SHAPE it needs (`TwinNotifier`) and the composition root hands it the
   * service, exactly as the harness and the send lock arrive.
   *
   * OPTIONAL, because a deployment may have no push identity and a suite
   * usually has none: absent means the pass announces nothing and every card
   * still reaches the dashboard.
   */
  readonly notify?: TwinNotifier;
  /**
   * THE SEAT'S EVENT BUS, WHICH THE LOCAL API'S STREAM READS (ticket #263;
   * spec #258 decision 14).
   *
   * A turn over a dashboard message publishes here: the reply's text while
   * the model is writing it, then the post it wrote or the word that it left
   * nothing. The composition root hands the SAME bus to the local API, so
   * the two halves of one process meet without a broker (`seat-events.ts`
   * argues why one process is enough).
   *
   * OPTIONAL, because a runtime serving no dashboard has nobody to tell and
   * most suites have no stream open: absent means a door turn streams nothing
   * and posts its answer for the next read to find.
   */
  readonly events?: SeatEvents;
  /**
   * THE TWIN THREAD'S DAYS, HELD FOR THE LIFE OF THE PROCESS (ticket #319;
   * `thread/sessions.ts`): the day's session per twin, and the events raised
   * for it. The composition root holds one and hands the SAME registry to the
   * local API and the watchers that raise events.
   *
   * ABSENT, A PASS HOLDS ITS OWN AND CLOSES IT ON THE WAY OUT, so no SDK child
   * outlives the pass that opened it: the day's session is resumed by id
   * on the next pass's first wake, which is a resume rather than a loss. What
   * an absent registry costs is events — nothing outside the pass can raise
   * one into it — which is why the runtime composes one.
   */
  readonly threadSessions?: ThreadSessions;
  /**
   * THE RUNS ENGINE (ticket #323) — this process's one, held beside the
   * thread's days so a steer and a step of the same run never write its
   * session from two children at once. Absent, the runtime's loop composes
   * one (`runtime.ts`).
   */
  readonly runs?: RunEngine;
  /**
   * Where every execution's per-call trace goes (#177 hotfix 1).
   *
   * ABSENT IN EVERY SUITE AND ON EVERY DEPLOYMENT BUT THE RIG, which is the
   * point: it is a debug view of one turn, not a log. `trace-render.ts`'s
   * `renderShape` is the content-free default a caller should reach for first.
   */
  readonly trace?: RuntimeTrace;
}

export interface ProcessResult {
  /**
   * Events CONSUMED this pass — one marker written each. An event whose
   * turn has not settled yet (ticket #75) is not consumed and is not
   * counted: it is still pending, and the next pass reconsiders it.
   */
  readonly processed: number;
  /** Drafts (with their system_send commands) emitted this pass. */
  readonly drafted: number;
}

/** A seam event type this runtime does not speak — a newer plane means upgrading the runtime, never skipping. */
export class UnsupportedEventTypeError extends Error {
  override readonly name = "UnsupportedEventTypeError";
  constructor(eventId: string, eventType: string) {
    super(
      `wa_events row ${eventId} has event type "${eventType}" — this runtime speaks "message", "reaction" and "opaque" (a newer plane means upgrading the runtime, never skipping)`,
    );
  }
}

const DEFAULT_HISTORY_LIMIT = 20;
/**
 * Retrieved rows the drafting call carries beyond the recent window
 * (ticket #35). Small on purpose: this rides inside the NFR-2 real-time
 * budget (ADR-0016), and relevance falls off fast — the point is the one
 * promise the rep forgot, not a second transcript.
 */
const DEFAULT_RETRIEVAL_LIMIT = 6;

/**
 * How long a customer chat must stay quiet before its unanswered messages
 * become one draft (ticket #75).
 *
 * NINETY SECONDS, and the figure is a judgment with reasons. Diego's
 * design named "1–2 minutes"; inside that range the trade is one-sided in
 * both directions. Too short and the burst this ticket exists for splits
 * again — the follow-up clause («para el lunes») lands seconds to tens of
 * seconds after the first line, and a 30s window would still cut a slow
 * typist's turn in half. Too long and the twin stops being useful in the
 * moment. 90s sits above every observed intra-burst gap while keeping the
 * worst case — settle + poll + model — around a minute and three quarters,
 * which is under the rep's own read-and-tap latency, so the draft is still
 * never what the customer is waiting on.
 *
 * It also buys the rep the chance to answer by hand first, which cancels
 * the draft outright (`lastRepReplyAt` below) and saves the model call
 * entirely — a longer window makes that MORE likely, which is the second
 * reason not to sit at the bottom of the range.
 *
 * NFR-2 (ADR-0016) is unmoved by this: its ~1-minute budget is the twin's
 * own work — pick-up to draft-ready — and `draft_timings` keeps that
 * measurable as `draft_ready_at - runtime_seen_at`. The settle window is a
 * deliberate product wait that sits BEFORE pick-up, not latency.
 */
const SETTLE_WINDOW_MS = 90_000;

/**
 * The longest a turn may go on deferring, measured from its OLDEST
 * unanswered message (ticket #75, decision 1).
 *
 * Every new inbound resets the quiet window — that is what "quiet" means —
 * so without a ceiling a customer typing steadily every minute would defer
 * their draft forever. That is a liveness bug, so the reset is bounded:
 * five minutes in, the turn is drafted against whatever has arrived, and
 * anything after starts the next one. Five is ~3⅓ windows — long enough
 * that a genuinely continuous burst is not cut in the middle, short enough
 * that the pathological case still gets an answer while the customer is
 * still in the conversation.
 */
const BATCH_CEILING_MS = 300_000;

/**
 * The most messages one turn may carry into one draft (ticket #75; Codex
 * r3).
 *
 * The ceiling above bounds a turn's AGE. It does not bound its SIZE, and
 * the two come apart in one reachable place: this runtime is hand-started
 * and has been down for days at a time, so it can wake to a chat holding
 * hundreds of unconsumed live events whose quiet has long since elapsed.
 * Every one of them would be one turn, one embedding query and one prompt
 * — and a prompt that overflows the model's context fails deterministically,
 * so the chat's whole backlog would be spent on one execution that can never
 * succeed. A bound in time alone therefore leaves a way for a chat to get no
 * draft at all, which is the very thing the ceiling exists to prevent. And
 * reaching it is permanent: a failed execution consumes its turn (ticket
 * #240), so every message of an oversized batch goes unanswered for good.
 *
 * So a very long turn is more than one turn. This is a BOUNDARY, never a
 * drop: the oldest `MAX_TURN_MESSAGES` are drafted and marked, the rest
 * stay pending and settle on the next pass (their quiet is already spent),
 * so every message still reaches a draft and the backlog drains at a
 * bounded rate instead of wedging.
 *
 * Forty, because a real burst is a handful — the case this ticket was cut
 * for is three — and four times the recent-window size is already far past
 * anything a customer types inside a 90-second window. It is a safety
 * bound, not a tuning knob: if it is ever reached in normal traffic, the
 * settle window is wrong, not this.
 */
const MAX_TURN_MESSAGES = 40;

interface PendingEventRow {
  id: string;
  event_type: string;
  payload_enc: Buffer;
  occurred_at: Date;
  received_at: Date;
  /**
   * How long this row has sat unconsumed on the seam, in milliseconds —
   * Postgres `now()` minus its own `received_at`, so BOTH sides of the
   * settle predicate come from one clock and the runtime's wall clock
   * never enters it (ticket #75). `received_at` rather than `occurred_at`
   * deliberately: `occurred_at` is stamped off the rail and a skewed one
   * would either defer a chat forever or defeat the window entirely, while
   * arrival time is ours and answers the question actually being asked —
   * how long since anything new showed up.
   */
  waited_ms: number;
}

/**
 * One customer chat's unconsumed counterparty messages — the TURN a draft
 * is written against (ticket #75). Collected during routing and settled
 * after it, so a rep reply sitting in the same pass is already in twin
 * memory by the time the turn is judged.
 */
interface TurnMessage {
  readonly event: PendingEventRow;
  readonly payload: WaMessagePayload;
  readonly row: ConversationRow;
}

/**
 * Every outcome a consumed `wa_events` row can carry — the seam's closed
 * vocabulary, kept in step with the CHECK constraint by
 * `migration-vocabulary.test.ts` (dispositions grow, machinery doesn't).
 *
 * TWO OF THEM ARE HISTORY AND STAY (ticket #218). `question_answered` and
 * `question_answer_refused` were the aperture question's, and nothing can
 * write either now that the route is retired — but this union mirrors the
 * CHECK constraint rather than what the build writes, and that constraint
 * never narrows (…100022's rule): a rig corpus holds rows under both, audit
 * coverage still watches the refusal, and dropping them here would make this
 * type disagree with the store it describes.
 */
type Disposition =
  | "captured"
  | "no_answer_needed"
  // The turn's anchor — the message that closed it — and the rest of its
  // batch, which the same draft answered (ticket #75).
  | "drafted"
  | "drafted_in_batch"
  // The rep answered this one by hand before the window closed, so the
  // twin drafted nothing for it (ticket #75, decision 2).
  | "answered_by_rep"
  | "affirmed"
  | "affirmation_refused"
  | "dismissed"
  | "binding_confirmed"
  | "declined"
  // Unwritable by this build — see the note above (ticket #218).
  | "question_answered"
  | "question_answer_refused"
  | "backfill_ingested"
  | "answered"
  | "deliberate_silence"
  | "media_ignored"
  | "retracted"
  | "correction_refused"
  // An execution ran for this row and produced no outcome (ticket #240;
  // …20260909100010 argues why none of the eighteen above would do). It is
  // what stops a row the model cannot finish being re-read on every pass for
  // ever; the ending itself is `executions.disposition` and the run's own
  // chain entry.
  | "execution_failed"
  // A rep line answered by a turn it folded into: that turn's record is keyed
  // to the first line's trigger, and this line has none of its own (ticket
  // #319; …20261003100010).
  | "folded";

/**
 * Resolve the entity-kind model for the startup backlog and live
 * confirmation (#148, Codex r1/r2); the operator backfill resolves through
 * `entityKindModelConfig`. A live classification failure fail-stops the pass
 * and leaves the confirmed entity unfiled, so neither caller may silently
 * inherit an extraction-model change.
 *
 * ADR-0015 as amended supersedes #60's shared-rung rationale: #148
 * separates the settings, and #154's equal defaults are not a derivation.
 * Moving either model must be a deliberate choice.
 */
export function kindModelOf(deps: {
  readonly kindModel?: ModelCallConfig;
}): ModelCallConfig {
  return deps.kindModel ?? { model: DEFAULT_ENTITY_KIND_MODEL };
}

/**
 * Processes every unprocessed inbound row for this twin, oldest first — the
 * rail's `wa_events` and the dashboard door's `dashboard_messages` both. One
 * pass; the poll loop (runTwinRuntime) repeats it.
 *
 * ROUTE, ROUTE, THEN SETTLE (ticket #75; the second door at #261). Every seam
 * event is ROUTED in seam order, which is where all of the per-event outcomes
 * commit; counterparty inbound in a customer chat is the one route that does
 * not finish there, and instead joins its chat's turn. Then every door
 * message is routed, into the same thread executions on the same lane. The
 * turns are SETTLED last, one draft each.
 *
 * THE ORDER IS LOAD-BEARING: a rep's own reply arriving in the same pass is
 * routed (and ingested into twin memory) before any turn is judged, so it can
 * cancel the draft it makes redundant — and the door sits with the rest of the
 * routing rather than after the turns, because a rep who typed a question is
 * waiting on the answer exactly as they are in the thread.
 */
export async function processPendingWaEvents(
  deps: TwinRuntimeDeps,
): Promise<ProcessResult> {
  const { db, twinId } = deps;
  const pending = await db.query<PendingEventRow>(
    `SELECT e.id, e.event_type, e.payload_enc, e.occurred_at, e.received_at,
            (EXTRACT(EPOCH FROM (now() - e.received_at)) * 1000)::double precision
              AS waited_ms
       FROM wa_events e
       LEFT JOIN wa_event_processing p ON p.event_id = e.id
      WHERE e.twin_id = $1 AND p.event_id IS NULL
      ORDER BY e.id`,
    [twinId],
  );
  const turns = new Map<string, TurnMessage[]>();
  // THE TWO LANES, OPENED PER PASS (ticket #173; spec #171 decision 3;
  // ADR-0010 as amended). Concurrency lives inside one pass and the runtime
  // loop stays sequential across passes, and opening the lanes here is what
  // makes that structural rather than remembered: a lane cannot outlive the
  // pass that opened it, so no execution of one pass can still be in flight
  // when the next begins.
  //
  // ONLY THE REALTIME ONE IS USED HERE. The batch lane runs' steps take is
  // opened once for the whole runtime rather than once per pass, because a
  // step OUTLIVES the tick that submitted it — `openBatchLane` and
  // `BatchWork` argue that exception (ticket #194).
  const lanes = openLanes();
  // A POISON ROW MUST NOT TAKE THE TURNS AHEAD OF IT DOWN WITH IT (Codex
  // r2). Routing stays fail-stop and the failure still leaves this pass —
  // but the work that was already complete commits first, which is the
  // property the old per-event loop had and which route-then-settle would
  // otherwise have quietly narrowed. Concretely: a `reaction` event this
  // build does not speak used to stop the pass AFTER the customer inbound
  // ahead of it had drafted; without this it would stop INSTEAD of it,
  // every pass and every restart, because the poison row stays pending
  // forever and the settle step is never reached.
  //
  // A turn only partly collected when routing died settles against what it
  // has, and the rest starts the next turn — still fewer drafts than the
  // per-message shape this replaced, and far better than none. If settling
  // then fails too, that failure propagates and this one is dropped: both
  // are loud, both are deterministic, and the poison row is still pending
  // for the next pass to hit again.
  // THE THREAD'S DAYS: the composition root's, or this pass's own, closed on
  // the way out below so no SDK child outlives the pass (`threadSessions`).
  const ownSessions =
    deps.threadSessions === undefined ? createThreadSessions() : undefined;
  const pass: Pass = {
    lane: lanes.realtime,
    tally: { consumed: 0, drafted: 0 },
    sessions: deps.threadSessions ?? ownSessions!,
    appended: [],
    handOver: new HandOverOrder(),
  };
  // THE FIRST FAILURE THIS PASS SAW, in the order the three phases run.
  // Routing's outranks settling's and settling's outranks the lane's, which
  // is the order they happened in and the order a reader reproduces them in:
  // the poison row is what the operator has to deal with, and it is still
  // pending.
  //
  // EVERY FAILURE THAT REACHES THIS VARIABLE IS INFRASTRUCTURE (ticket #240;
  // `execution-failure.ts` argues the line). Routing and settling are
  // infrastructure by construction — a `receipt` event this build cannot read,
  // a bundle that will not open under the settle predicate. An EXECUTION's own
  // ending does not arrive here: it is caught, recorded and marked inside its
  // own transaction, so the lane's `settle` is given nothing for it. What
  // leaves the lane is a fault UNDERNEATH an execution — the seam refusing, a
  // connection the pool cannot hand out, the bundle unopenable, a bug in this
  // build — and that is what the loop's fail-stop is for.
  let failure: unknown;
  // PHASE 1, ROUTING. Captured rather than thrown, and the reason is #75's
  // own Codex r2: a poison row must not take the turns ahead of it down with
  // it. A `receipt` event this build cannot read refuses loudly and stays
  // unconsumed forever, so without this it would starve a draft the rep was
  // owed on every pass and every restart — the settle step below would never
  // be reached.
  try {
    for (const event of pending.rows) {
      const routed = await routeEvent(deps, pass, event);
      if (routed.kind === "turn") {
        const turn = turns.get(routed.turn.payload.chatJid);
        if (turn === undefined) turns.set(routed.turn.payload.chatJid, [routed.turn]);
        else turn.push(routed.turn);
      }
    }
  } catch (thrown) {
    failure = thrown;
  }
  // PHASE 1a, THE RUTINAS THAT LISTEN FOR A CUSTOMER (ticket #325; spec #318
  // decision 28). Every customer message this pass routed into a turn is the
  // seam event a `customer_message` trigger names, and each matching active
  // rutina starts one run — told the message's id and the customer's
  // reference, never what they wrote.
  //
  // A CHAT WHOSE FIRING FAILED IS NOT SETTLED THIS PASS (Codex r1): settling
  // marks its messages processed, which is the only record that they are
  // still owed — so its turn is held back, its messages stay pending, and the
  // next pass routes them and fires again, the ones that already fired
  // refused by `runs_one_per_wake`. One chat at a time, so a failure in one
  // leaves every other chat's firing and turn to go ahead.
  for (const [chatJid, arrived] of [...turns]) {
    try {
      for (const message of arrived) {
        await fireOnEvent(
          deps,
          { kind: "customer_message", eventId: message.event.id, chatJid },
          new Date(),
        );
      }
    } catch (thrown) {
      failure ??= thrown;
      turns.delete(chatJid);
    }
  }
  // PHASE 1b, THE OTHER DOOR (ticket #261; spec #258 decision 13, the bar's
  // mechanism). The dashboard's messages are read and routed in the same
  // pass, into the same thread executions on the same realtime lane, and they
  // are ROUTED rather than settled: a rep who typed a question is waiting on
  // the answer, exactly as in the thread, so there is no window here either.
  //
  // ITS OWN TRY, for the reason phase 1 has one: a poison seam row must not
  // starve the door, and a door message this build cannot read must not starve
  // the turns behind it. The first failure still wins, and the poison row of
  // whichever phase produced it is still pending for the next pass.
  try {
    await routeDashboardMessages(deps, pass);
  } catch (thrown) {
    failure ??= thrown;
  }
  // PHASE 1b′, WHAT THE REP ASKED WITHOUT WORDS (ticket #358): an arrival, a
  // pick, a selection, a summons — rows with no marker, each a turn of its
  // own on the same lane, after the lines typed at the door and before what
  // was only told. Its own try, for the reason each phase has one: a row this
  // pass could not hand over is still unmarked, and the next pass reads it.
  try {
    await routeRepAsks(deps, pass);
  } catch (thrown) {
    failure ??= thrown;
  }
  // PHASE 1c, WHAT HAPPENED AROUND THE TWO OF THEM (tickets #319, #320; spec
  // #318 decisions 11 and 15). Every event raised since the last pass reaches
  // the day's session: appended there, or — the wake list's few — given a
  // turn of its own on the same lane. Its own try, for the reason each phase
  // has one.
  try {
    await routeThreadEvents(deps, pass);
  } catch (thrown) {
    failure ??= thrown;
  }
  // PHASE 2, SETTLING — CAPTURED TOO, WHICH IS ITS OWN FIX (Codex r1). It
  // used to throw straight out, and that left a real hole: settling reads the
  // bundle, one retrieval page and the chat's binding, so it can throw — and
  // an execution submitted before it threw would never be awaited. The pass
  // would reject while that execution was still inside its model call, the
  // loop would fail-stop, and the rig's runner would close the bundle and end
  // the pools underneath work still committing.
  //
  // A turn only partly collected when routing died settles against what it
  // has, and the rest starts the next turn — still fewer drafts than the
  // per-message shape this replaced, and far better than none.
  try {
    for (const [chatJid, arrived] of turns) {
      await settleTurn(deps, pass, chatJid, arrived);
    }
  } catch (thrown) {
    failure ??= thrown;
  }
  // PHASE 3: THE PASS AWAITS THE LANE UNCONDITIONALLY, and the lane settles
  // everything before it throws anything (`lanes.ts`). So no execution of
  // this pass is still running when the pass returns or rejects, whichever of
  // the two phases above went wrong.
  try {
    await lanes.realtime.settle();
  } catch (thrown) {
    failure ??= thrown;
  }
  // ...AND EVERY EVENT IT APPENDED IS HELD BY THE SESSION before the pass
  // returns: an event is never dropped, and a pass that ended before the child
  // wrote one would leave it to a process that may be about to stop.
  try {
    await Promise.all(pass.appended);
  } catch (thrown) {
    failure ??= thrown;
  }
  if (ownSessions !== undefined) {
    try {
      await ownSessions.close();
    } catch (thrown) {
      failure ??= thrown;
    }
  }
  if (failure !== undefined) throw failure;
  return { processed: pass.tally.consumed, drafted: pass.tally.drafted };
}

/**
 * EVERY UNCONSUMED DASHBOARD MESSAGE OF THIS TWIN, ROUTED (ticket #261; spec
 * #258 decision 2).
 *
 * THE SAME READ SHAPE THE SEAM'S IS, one table over: the rows this twin has
 * that carry no processing marker, oldest first, with their words opened under
 * the twin key. The marker's primary key is the exactly-once lock, so a run
 * that commits marks its own message and a run that does not leaves it pending
 * for the next pass — which is what makes the door survive a restart without a
 * timer anywhere.
 *
 * EVERY ONE OF THEM IS `twin_input` BY CONSTRUCTION, which is the whole
 * difference from `routeMessage`. The matcher exists to tell the two keyword
 * acts apart from prose inside a chat that also carries echoes, media husks
 * and the twin's own posts; this table holds nothing but words a rep typed
 * into a composer aimed at their twin, one row per authenticated request. So
 * there is no echo to protect against, no frame to recognize and no quote to
 * resolve — the row IS the input.
 */
async function routeDashboardMessages(
  deps: TwinRuntimeDeps,
  pass: Pass,
): Promise<void> {
  const pending = await deps.db.query<{
    id: string;
    seat_id: string;
    text_enc: Buffer;
    received_at: Date;
    about_post_id: string | null;
    about_line_index: number | null;
    about_blank_key: string | null;
  }>(
    `SELECT m.id, m.seat_id, m.text_enc, m.received_at,
            m.about_post_id, m.about_line_index, m.about_blank_key
       FROM dashboard_messages m
       LEFT JOIN dashboard_message_processing p ON p.message_id = m.id
      WHERE m.twin_id = $1 AND p.message_id IS NULL
      ORDER BY m.occurred_at, m.id`,
    [deps.twinId],
  );
  for (const row of pending.rows) {
    await submitThreadExecution(deps, pass, {
      door: "dashboard",
      seatId: row.seat_id,
      eventId: row.id,
      text: Buffer.from(deps.dek.decrypt(row.text_enc)).toString("utf8"),
      receivedAt: row.received_at,
      // WHAT THE REP POINTED AT ON THE CARD, off the row: the line they
      // edited (ticket #344) or the blank they answered (ticket #342) —
      // `dashboard_messages_about_check` sets the post with exactly one.
      ...aboutOfRow(row),
    });
  }
}

/** A door row's reference, as the turn is pointed by it — or none. */
function aboutOfRow(row: {
  readonly about_post_id: string | null;
  readonly about_line_index: number | null;
  readonly about_blank_key: string | null;
}): { readonly about?: TwinApiMessageAbout } {
  if (row.about_post_id === null) return {};
  if (row.about_line_index !== null) {
    return { about: { kind: "line", postId: row.about_post_id, lineIndex: row.about_line_index } };
  }
  if (row.about_blank_key !== null) {
    return { about: { kind: "blank", postId: row.about_post_id, key: row.about_blank_key } };
  }
  return {};
}

/**
 * ONE PASS'S OWN THREE THINGS: the lane its executions run on, what they have
 * done so far, and the twin thread's days its turns are pushed into.
 *
 * ONE VALUE RATHER THAN THREE PARAMETERS (the two-axis review's Standards
 * axis). They travel together through every routing signature, which is a
 * type asking to be born.
 */
interface Pass {
  readonly lane: Lane;
  readonly tally: PassTally;
  readonly sessions: ThreadSessions;
  /** The events this pass appended, each kept once the session holds it. */
  readonly appended: Promise<void>[];
  /** The order its thread turns reach the day's session in: the order it submitted them (`hand-over.ts`). */
  readonly handOver: HandOverOrder;
}

/**
 * WHAT ROUTING ONE EVENT DECIDED (ticket #173).
 *
 * Three answers where there were two, and the third is what the lane adds: an
 * event may now be HANDED OVER rather than finished or deferred. The
 * distinction is about the marker — the pass counts what it consumed, and a
 * marker written inside an execution's own transaction is not the router's to
 * count.
 */
type Routed =
  /** Counterparty inbound in a customer chat: joins its chat's turn, unmarked. */
  | { readonly kind: "turn"; readonly turn: TurnMessage }
  /** Finished where it stood: its marker is written, and the tally counted it. */
  | { readonly kind: "consumed" }
  /** Handed to the lane: its marker commits inside the execution's transaction. */
  | { readonly kind: "submitted" };

/**
 * TAGGED, LIKE EVERY OTHER UNION IN THIS PACKAGE (the two-axis review's
 * Standards axis). It was discriminated by which property was present, and
 * `{consumed:true}` beside `{submitted:true}` reads alike at a glance — where
 * `Trigger.kind` and `MatchOutcome.disposition` say what they are.
 */
const SUBMITTED: Routed = { kind: "submitted" };

/** Finished here: the marker is written, so the pass has consumed one event. */
function consumed(pass: Pass): Routed {
  pass.tally.consumed += 1;
  return { kind: "consumed" };
}

/**
 * Routes one event to its outcome and marks it — except for counterparty
 * inbound in a customer chat, which is returned UNMARKED to join its
 * chat's turn (ticket #75). The bundle write happens either way: twin
 * memory is not what waits.
 */
async function routeEvent(
  deps: TwinRuntimeDeps,
  pass: Pass,
  event: PendingEventRow,
): Promise<Routed> {
  switch (event.event_type) {
    case "message":
      return await routeMessage(
        deps,
        pass,
        event,
        decodeWaMessagePayload(deps.dek, event.payload_enc),
      );
    case "reaction":
      // A gesture never joins a turn (ADR-0041: context yes, trigger no),
      // so this route never returns one — but in the twin thread it is
      // ordinary rep input, so it may still be handed to the lane.
      return await routeReaction(
        deps,
        pass,
        event,
        decodeWaReactionPayload(deps.dek, event.payload_enc),
      );
    case "opaque":
      // Neither does a delivery the plane could not read (ADR-0042: the
      // same context-yes-trigger-no rule, for the same reason).
      return await routeOpaque(
        deps,
        pass,
        event,
        decodeWaOpaquePayload(deps.dek, event.payload_enc),
      );
    default:
      throw new UnsupportedEventTypeError(event.id, event.event_type);
  }
}

/**
 * Routes one MESSAGE event (the shape this runtime has always spoken).
 */
async function routeMessage(
  deps: TwinRuntimeDeps,
  pass: Pass,
  event: PendingEventRow,
  payload: WaMessagePayload,
): Promise<Routed> {
  const conversationRow = {
    chatJid: payload.chatJid,
    messageId: payload.messageId,
    senderJid: payload.senderJid,
    fromMe: payload.fromMe,
    occurredAt: event.occurred_at.toISOString(),
    content: payload.text,
    // The #31 hand-off's deferred wire-up: the decoded #30 push-name
    // reaches the bundle store (bindings are proposed from it, and
    // «(sin confirmar)» rendering needs it). Absent, never empty.
    ...(payload.pushName === undefined ? {} : { pushName: payload.pushName }),
  };

  await ingestIntoTwinMemory(deps, conversationRow);

  // Backfill routes to ingest ONLY (spec #29 decisions 5–6): a
  // history-normalized event is the past, not input — it never reaches
  // the matcher (a historical quoted «va» must not resolve against
  // today's queue) and never drafts (linking a full history must not make
  // the twin answer last month's messages). The bundle write above is its
  // whole journey; the marker commits that as this event's outcome.
  if (payload.backfill) {
    await markProcessed(deps.db, deps, event.id, "backfill_ingested");
    return consumed(pass);
  }

  // The guard rail: own-sent traffic and the self-chat are never rep
  // input to draft against — they are the matcher's raw material. The
  // matcher (#25) decides what each captured event means: a quoted-reply
  // affirmation mints the tap + customer_send through the send-lock
  // writer; a refused affirmation gets its refusal notice; everything
  // else stays plain captured.
  if (payload.fromMe || payload.chatJid === deps.selfChatJid) {
    const match = await matchCapturedEvent(deps, event.id, payload);
    if (match.disposition === "affirmation_refused") {
      // The refusal's framed microcopy («✳️ ya se envió», …) posts to the
      // twin thread — notice + its system_send + the processing marker
      // commit together, so a crash can never leave a refusal half-told.
      await withDbTransaction(deps.db, async () => {
        await insertNoticeWithSystemSend(deps.db, {
          twinId: deps.twinId,
          selfChatJid: deps.selfChatJid,
          dek: deps.dek,
          kind: "affirmation_refusal",
          aboutEventId: event.id,
          // A RECEIPT the send lock's own refusal record supplies (ADR-0017;
          // ticket #220): code observed the outcome, so no model may describe
          // it.
          post: composeReceiptPost(REFUSAL_MICROCOPY[match.reason]),
        });
        await markProcessed(deps.db, deps, event.id, match.disposition);
      });
    } else if (match.disposition === "binding_confirmed") {
      // The rep's quoted yes on the binding-question post (ticket #34,
      // «si»/«sí»/«va» since #49): the chat and its proposed name re-derive
      // from the question's own source event under the twin DEK — the same
      // values the question proposed, never anything model-produced — and
      // the confirmed binding lands ONLY in the bundle's entity mirror
      // (ADR-0004). Idempotent like ingest: an already-bound chat (a repeat
      // yes, or the replay of a crash between the mirror write and this
      // marker) leaves the first confirmation standing.
      //
      // And this is where the wall is crossed for the first time (ticket
      // #50): the confirmed binding files an ENTITY CREATE through the
      // aperture, with its disclosure line in the same transaction. The
      // rep's own yes — THIS raw plane-delivered event — is the class-2
      // evidence (ADR-0003), and the aperture re-verifies it rather than
      // taking the call site's word for it.
      //
      // SPLIT IN TWO AT #176, and the split is the concurrency defect
      // #173's lanes removed for drafting and the thread. The bundle write
      // and the standing-kind read are synchronous, idempotent and this
      // connection's; the CLASSIFICATION is a model call, and running it
      // inline here made every other pending event of the pass wait on it.
      const confirmed = await confirmBindingFromQuestion(
        deps,
        match.questionEventId,
        // When the rep actually confirmed — the plane's stamp on their
        // yes, not this pass's wall clock. A restart that picks the event
        // up hours later must not record its own processing time as the
        // moment the rep spoke.
        event.occurred_at,
      );
      const repAct: RepActEvidence = {
        surface: "twin_thread",
        sourceEventId: event.id,
        waMessageId: payload.messageId,
      };
      if (confirmed.standingKind !== undefined) {
        // NOTHING TO CLASSIFY, SO NO EXECUTION IS CREATED (ticket #176). A
        // replay — a repeat «va», or a crash between the crossing's commit
        // and this event's processing marker — finds the entity already
        // filed, and the aperture would discard a fresh determination
        // anyway (`standingCreateFor`: the standing one stands, which is
        // what keeps a human's correction safe). An execution here would
        // be a record of a model call nobody needed and a chain entry for
        // a classification that never happened.
        await fileBindingCrossing(deps, deps.db, {
          binding: confirmed.binding,
          kind: confirmed.standingKind,
          repAct,
        });
        await withDbTransaction(deps.db, () =>
          ackBindingConfirmation(deps, deps.db, {
            eventId: event.id,
            displayName: confirmed.binding.displayName,
          }),
        );
        // ...AND ITS CARD SETTLES ON THE CANVAS, after that commit (#266).
        await publishSettle(
          settleDepsOf(deps, deps.db),
          { question: match.questionEventId },
          "confirmed",
          true,
        );
        return consumed(pass);
      }
      // HANDED TO THE LANE (ticket #176). The crossing, the ack and this
      // event's marker all commit inside the execution's transaction — so a
      // classification that fails leaves the event UNMARKED and the rep's
      // «va» replays on the next pass, exactly as the harness's throw did,
      // and the bundle binding already written above makes that replay
      // idempotent.
      submitEntityKindExecution(deps, pass, {
        binding: confirmed.binding,
        repAct,
        eventId: event.id,
        questionEventId: match.questionEventId,
      });
      return SUBMITTED;
    } else if (match.disposition === "twin_input") {
      // WHERE EVERY REP MESSAGE BUT THE TWO KEYWORDS GOES (ticket #173,
      // widened at #174). It used to be the messages the matcher chose not
      // to consume; it is now everything that is not the tap or the binding
      // confirmation — a quoted «no va», a quoted «no» on a question, «3
      // no» on the disclosure, a reply to a post whose mapping was lost.
      // The execution reads what the rep meant and acts through its gated
      // tools; it is handed to the realtime lane rather than answered
      // inline, so a rep asking their twin something no longer waits behind
      // whatever draft the pass was writing.
      await submitThreadExecution(deps, pass, {
        door: "twin_thread",
        eventId: event.id,
        waMessageId: payload.messageId,
        text: payload.text,
        quotedWaMessageId: payload.quotedMessageId,
        receivedAt: event.received_at,
      });
      return SUBMITTED;
    } else {
      await markProcessed(deps.db, deps, event.id, match.disposition);
    }
    return consumed(pass);
  }

  // Counterparty inbound in a customer chat: the one route that does not
  // finish here. It joins its chat's turn UNMARKED, and the marker is
  // written when that turn settles (ticket #75).
  return { kind: "turn", turn: { event, payload, row: conversationRow } };
}

/**
 * TWIN MEMORY FIRST (slice AC 10; ticket #31), and the same write whatever
 * the row is: the message or the gesture lands in the bundle message store
 * whatever the routing outcome — through the ONE ingest path, idempotent
 * by (chat, WhatsApp message id), so a crash between the bundle write and
 * the Postgres marker (two stores, no shared transaction) replays onto the
 * already-stored row, and a re-delivered event can never double-store.
 * #33's backfill routes through this same write, and so does #97's
 * reaction.
 *
 * The vector accompanies its row (ticket #32): embed at ingest, guarded by
 * presence — not by `ingest.stored` — so a crash between the message write
 * and the vector write replays into exactly one vector (a re-delivered
 * event re-checks and skips; a half-done one finishes). First write wins in
 * the store itself, so nothing here can ever duplicate.
 *
 * Embed the STORED content, never this event's: a re-delivery carrying
 * different text for the same WhatsApp message id loses in the store, and
 * indexing its text would leave the winning row hydrating behind a vector
 * nobody could search it by (one bundle state, one index — the same content
 * the backlog path would embed).
 */
async function ingestIntoTwinMemory(
  deps: TwinRuntimeDeps,
  row: ConversationRow,
): Promise<void> {
  const ingest = deps.bundle.ingestMessage(row);
  // AN OPAQUE DELIVERY IS NEVER EMBEDDED (ticket #124; ADR-0042). The
  // placeholder is not an utterance, and indexing it would put the
  // empty-text husk's pollution back into the vector store under a new
  // name. The store's backlog selection refuses it too, so a row that
  // reaches here and a row that reaches the backlog get the same answer.
  //
  // ASKED OF THE STORED ROW, not of this event's (Codex r1) — the same
  // rule the paragraph above states for `content`, one field further. A
  // losing re-delivery resolves onto a row the store already holds, and if
  // that row were the opaque one this call would otherwise embed the
  // placeholder it just read back.
  if (ingest.opaque) return;
  if (!deps.bundle.hasMessageVector(ingest.storeId)) {
    deps.bundle.writeMessageVector(
      ingest.storeId,
      await embedOne(deps.embedder, ingest.content),
    );
  }
}

/**
 * Routes one REACTION event (ticket #97; ADR-0041) — an emoji placed on
 * one specific message, in either direction, remembered like any message.
 *
 * IT IS REMEMBERED AS A GESTURE, NEVER AS SPEECH. The row's content is the
 * rendered gesture naming the emoji and, read back deterministically from
 * twin memory, the words it points at — so the embedder indexes «reaccionó
 * 👍 a “¿me mandas 20 bultos?”» rather than a bare emoji, and every reader
 * downstream sees a gesture where a gesture happened. The reaction's own
 * stanza id keys the row, so a set, a change and a removal are three rows
 * and nothing folds (the target id rides along in `reactionTo`).
 *
 * THEN IT ROUTES BY CHAT, and the two answers are different in kind:
 *
 * — A CUSTOMER CHAT: context yes, trigger no. The gesture joins the bundle
 *   and is consumed there. It never opens a turn and never triggers a
 *   draft, because most reactions close a beat rather than open one and
 *   dismissal is terminal — noise is not free (ADR-0041). The 👎-only
 *   reply is real and is caught where it belongs: the transcript, the
 *   daily disclosure, and rep-initiated drafting.
 *
 * — THE TWIN THREAD: ordinary rep input, the same path any non-keyword
 *   reply to a twin post takes. The post it points at rides along as
 *   context, so the model can read what the rep meant and answer in its
 *   own words — «una reacción no envía» is the twin talking, never
 *   recorded microcopy (ADR-0037), and it could not send in any case: the
 *   gate is on the tool, and the two non-model tap minters (ADR-0006)
 *   never see this row.
 *
 * THE MATCHER IS NOT ON EITHER PATH. That is the structural half of
 * "never a tap" — not a verb table that happens to reject emoji, but a
 * type the matcher cannot be handed (its input is `WaMessagePayload`) and
 * a route that never calls it.
 */
async function routeReaction(
  deps: TwinRuntimeDeps,
  pass: Pass,
  event: PendingEventRow,
  payload: WaReactionPayload,
): Promise<Routed> {
  // The target as twin memory holds it NOW — best effort, and only for the
  // content the vector indexes: the store must have exactly one state to
  // index (ADR-0007), so the row keeps the line as it read when it was
  // stored. What the MODEL sees is composed later, at read time, from the
  // target and emoji stored beside it (`renderGesturesForModel`) — a
  // gesture can legitimately arrive before the message it points at, and a
  // line frozen here would leave it bare for good.
  //
  // WHAT THAT SPLIT LEAVES OPEN, said plainly (Codex r3). Read-time
  // composition fixes what a SELECTED row looks like; it does not change
  // which rows retrieval selects. A gesture ingested before its target is
  // embedded as a bare `[reacción 👍]`, so a query matching the TARGET's
  // words ranks it low and a full page of nearer hits can push it out —
  // the model would then see the request without the 👍 that closed it.
  // Reachable only once a plane emits reactions (#100/#101) and only in
  // the out-of-order case; recorded rather than built, because both fixes
  // are real machinery: re-embedding the gesture when its target lands
  // (a reverse lookup on every message ingest plus a vector REPLACE,
  // against this store's first-write-wins rule), or expanding a retrieved
  // target to the gestures that point at it (retrieval-side, no store
  // mutation — the cheaper of the two, and the place to start).
  const target = deps.bundle.readMessage(payload.chatJid, payload.reactionTo);
  const gesture = renderReactionGesture({
    emoji: payload.emoji,
    target: target?.content,
  });
  await ingestIntoTwinMemory(deps, {
    chatJid: payload.chatJid,
    // The REACTION's own stanza id — what makes each delivery its own row
    // and what the seam's dedupe already keys on.
    messageId: payload.messageId,
    senderJid: payload.senderJid,
    fromMe: payload.fromMe,
    occurredAt: event.occurred_at.toISOString(),
    content: gesture,
    reactionTo: payload.reactionTo,
    reactionEmoji: payload.emoji,
    // The reactor's own millisecond clock, stored beside the delivery so
    // that reading this chat back in order can break a same-second tie
    // (ticket #109; the reasons live in `inDeliveryOrder`).
    senderTsMs: payload.senderTsMs,
    ...(payload.pushName === undefined ? {} : { pushName: payload.pushName }),
  });

  // Backfill routes to ingest ONLY, exactly as a backfilled message does
  // (spec #29 decisions 5–6; ADR-0041: "backfilled reactions feed
  // retrieval and drafting context only"). A history-normalized gesture is
  // the past, not input — answering last month's 👍 in the twin thread
  // would be the same mistake as drafting for last month's messages.
  if (payload.backfill) {
    await markProcessed(deps.db, deps, event.id, "backfill_ingested");
    return consumed(pass);
  }

  if (payload.chatJid !== deps.selfChatJid) {
    // A customer chat, in EITHER direction — the rep's 👍 on a request and
    // the customer's 👍 on a quote are both agreement, and both are
    // context (ADR-0041). Twin memory holds it; nothing else happens.
    await markProcessed(deps.db, deps, event.id, "captured");
    return consumed(pass);
  }

  await submitThreadExecution(deps, pass, {
    door: "twin_thread",
    eventId: event.id,
    // The reaction's own stanza id, so the search never serves the gesture
    // row back as a source of the turn it began.
    waMessageId: payload.messageId,
    text: gesture,
    // The twin's own post, by its words and its kind (`readPostedPost`,
    // never the matcher's door): a Borrador with its state, a question, an
    // ack. Unresolvable when the rep reacted to one of their own notes,
    // which the gesture line has already inlined from twin memory.
    quotedWaMessageId: payload.reactionTo,
    receivedAt: event.received_at,
  });
  return SUBMITTED;
}

/**
 * Routes one OPAQUE event (ticket #124; ADR-0042) — an in-scope delivery
 * the plane could not read: a photo, a voice note, a poll, an edit, a
 * revoke, a sticker, a message the rail could not decrypt, a shape that
 * did not parse.
 *
 * IT IS REMEMBERED AS HAVING HAPPENED, NEVER AS SILENCE, and never as
 * text. The row's content is the placeholder beat composed from the rail's
 * own kind — «[foto]», «[nota de voz]», «[mensaje que no se pudo leer]» —
 * so every reader downstream sees one chronological line saying the twin
 * could not read this, where before it saw the empty-text husk and read
 * somebody saying nothing.
 *
 * AND IT IS NEVER EMBEDDED (ADR-0042). A placeholder is not an utterance;
 * indexing one would put the husk's pollution back into the vector store
 * under a new name. `ingestIntoTwinMemory` skips the vector for it, and
 * the store's own backlog selection skips it too, so "never embedded" is a
 * property of twin memory rather than a habit at one write site.
 *
 * THE ROW'S IDENTITY CARRIES THE KIND — `<stanza>:opaque`, or
 * `opaque:<hash>` with no stanza id — so twin memory can hold BOTH this
 * row and the readable one for the same message, which is what lets a
 * re-delivery heal memory instead of being swallowed. Which of the two
 * STANDS is the fold, at read time (`foldOpaqueDeliveries`), and
 * `opaqueOf` is the key it decides on.
 *
 * AND THEN IT IS CONSUMED, IN EVERY CHAT — context yes, trigger no, which is
 * the rule ADR-0041 gives a gesture and ADR-0042 restates for a delivery
 * nobody could read. The placeholder joins the bundle and the row is marked;
 * no turn opens, no draft is written and no execution runs.
 *
 * THE SELF-CHAT IS NOT AN EXCEPTION TO THAT, and the reason is what the
 * self-chat CARRIES (ticket #240). It is not where reps send photos: it is
 * where the RAIL puts its own traffic, because every pairing burst and every
 * on-demand history page delivers protocol messages the plane cannot type.
 * An execution per such row is a paid model call and a message posted into
 * the rep's own thread for something no human sent — 26 of them on link day,
 * beside 20 near-identical Inicio cards, one of which is the execution that
 * spent its budget and killed the runtime.
 *
 * ONE ARM COVERS ALL THREE SHAPES the rig produces — the pairing burst, a
 * history page's protocol message, a live opaque delivery — because none of
 * them is distinguishable from the others here and a per-shape exception is
 * what ADR-0042 forbids. `captured` is the word, the same one the
 * customer-chat arm takes and for the same reason: twin memory holds this,
 * and nothing else is owed. Not `media_ignored`, which is spec #29 decision
 * 2's word for the empty-text HUSK in this chat — a different row with a
 * different story, still marked its own way.
 *
 * WHETHER A REP-AUTHORED MESSAGE THAT ARRIVES OPAQUE EVER EARNS ONE
 * «reenvíamelo» is 6b's question (#215), and nothing here is built toward
 * it: what would decide it is knowing the rep typed it, which this row
 * cannot say.
 *
 * THE MATCHER IS NOT ON ANY PATH — the structural half of "never a tap": a
 * type the matcher cannot be handed (its input is `WaMessagePayload`) and a
 * route that never calls it.
 */
async function routeOpaque(
  deps: TwinRuntimeDeps,
  pass: Pass,
  event: PendingEventRow,
  payload: WaOpaquePayload,
): Promise<Routed> {
  // Composed once, in the one place both readers of this shape compose it
  // (`opaque.ts`) — the extraction window has to reach the same three
  // answers, and the fold keys on one of them.
  const row = opaqueConversationRow(payload, event.occurred_at.toISOString());
  await ingestIntoTwinMemory(deps, row);

  // Backfill routes to ingest ONLY, exactly as a backfilled message or
  // gesture does (spec #29 decisions 5–6). A history-normalized delivery is
  // the past, not input — and this is the path that HEALS old husks, since
  // relink backfill is where an opaque row for an already-remembered
  // message comes from.
  if (payload.backfill) {
    await markProcessed(deps.db, deps, event.id, "backfill_ingested");
    return consumed(pass);
  }

  // EVERY CHAT, INCLUDING THE REP'S OWN (ticket #240; the ruling on #225,
  // F13/F13b — the header argues it). Twin memory holds it; nothing else
  // happens. The same word a customer-chat gesture takes (#97), for the same
  // claim: recorded, and nothing was owed.
  await markProcessed(deps.db, deps, event.id, "captured");
  return consumed(pass);
}

/**
 * WHAT THE LANE'S EXECUTIONS DID, counted where they commit (ticket #173).
 *
 * An execution's marker is written inside its own transaction, which may not
 * have committed when routing moves on — and an execution whose transaction is
 * GONE writes none at all, because everything it would have written was inside
 * it. So the pass cannot count an execution's work when it SUBMITS one: it
 * counts what the lane's executions actually committed, and that is this.
 *
 * A `failed` EXECUTION IS COUNTED CONSUMED AND NEVER DRAFTED (ticket #240). It
 * marks its trigger now — an execution that ran and produced no outcome is an
 * outcome for the row — so `consumed` says so; `drafted` is what a rep can
 * read, and a failure leaves nothing to read.
 */
interface PassTally {
  consumed: number;
  drafted: number;
}

/**
 * What one message to the twin needs before it can become an execution — from
 * either door (tickets #173 and #261).
 *
 * TAGGED ON THE DOOR, because the two arms genuinely differ in what exists.
 * The thread's message is a `wa_events` row with a rail stanza id and possibly
 * a quote; the door's is a `dashboard_messages` row with no stanza id — it
 * never enters twin memory, so there is no row for the search to exclude —
 * and, for a line of the notes edited in place, the card and line it points at
 * (ticket #344). Two optional fields would have said «one of these is set»
 * without saying which.
 */
type ThreadMessage = ThreadDoorMessage | DashboardDoorMessage;

/** What one thread message needs before it can become an execution. */
interface ThreadDoorMessage extends ArrivedMessage {
  readonly door: "twin_thread";
  /** Its own WhatsApp message id, so the search never serves it back. */
  readonly waMessageId: string;
  /** The twin post they pointed at, when they pointed at one. */
  readonly quotedWaMessageId: string | undefined;
}

/** ...and what one at the dashboard's door needs, which is less (ticket #261). */
interface DashboardDoorMessage extends ArrivedMessage {
  readonly door: "dashboard";
  /**
   * The seat whose login typed it — the key its reply streams under (ticket
   * #263). Off the row the local API wrote from the registry, never from a
   * request.
   */
  readonly seatId: string;
  /**
   * What these words point at on a card: the line of a notes card they
   * correct, edited in place (ticket #344), or the blank of a draft card they
   * answer (ticket #342).
   */
  readonly about?: TwinApiMessageAbout;
}

/** What both doors carry: the row, the words, and when they arrived. */
interface ArrivedMessage {
  /**
   * The rep's own row — what the answer is about and what gets marked. A
   * `wa_events` id at the thread's door, a `dashboard_messages` id at the
   * dashboard's; `door` is what says which store it dereferences in.
   */
  readonly eventId: string;
  /** What the rep put in front of the twin, verbatim or rendered. */
  readonly text: string;
  /**
   * When this side took the message in (ticket #175).
   *
   * IT IS NFR-2's FIRST INSTANT, and a draft the rep asks for records it in
   * its own timing row exactly as a customer-triggered one does — so the
   * budget is measured by one arithmetic on both occasions, and on both doors.
   * Read off the row the router is already holding, never re-queried: a
   * second read of the same column is a second answer to when this message
   * arrived.
   */
  readonly receivedAt: Date;
}

/**
 * THE REP SPOKE TO THEIR TWIN (ticket #173; spec #171 decisions 3 and 19) —
 * in prose, with a gesture (#97), or with something the plane could not read
 * (ADR-0042).
 *
 * Whether that earns an ANSWER is the model's judgement inside the execution
 * — never a pre-classifier out here — so both outcomes are decided by one
 * call and recorded with their own disposition (spec #171 decision 25:
 * "silence is a disposition, not an absence").
 *
 * EVERYTHING POSTGRES-SHAPED IS READ HERE, SEQUENTIALLY, ON THE RUNTIME'S OWN
 * CONNECTION, and then the execution is handed over. Context recipes are
 * synchronous and both of the thread's material parts live behind an
 * encrypted column (`thread/reads.ts`), so the reads cannot happen inside a
 * recipe — and doing them here rather than inside the lane's task is what
 * makes the context a snapshot of the thread as the ROUTER saw it rather than
 * as it stood whenever the model got round to reading it.
 *
 * THE TRIGGER IS BUILT OFF THE WAKE, not restated: the wake declares the
 * occasion and the mechanism, the engine refuses a trigger that disagrees,
 * and this is where the ids the occasion binds are added to them.
 */
async function submitThreadExecution(
  deps: TwinRuntimeDeps,
  pass: Pass,
  message: ThreadMessage,
): Promise<void> {
  // THE SEAT'S ZONE, RESOLVED ONCE, exactly as the drafting side resolves it:
  // the «now» part, the thread's beats and the search's hits all render
  // from THIS value, so the three cannot
  // disagree about an hour — and that closes the remainder #172 recorded
  // about this surface taking the host clock at its own render site.
  const timeZone =
    deps.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const reads = {
    db: deps.db,
    dek: deps.dek,
    twinId: deps.twinId,
    bundle: deps.bundle,
    selfChatJid: deps.selfChatJid,
  };
  // WHAT THE REP POINTED AT, AT EITHER DOOR: the post their reply quotes in
  // the thread, or the card whose line they edited in place (ticket #344) or
  // whose blank they answered (ticket #342) on the dashboard. One shape, so
  // every rep-act tool resolves its target the same way at both.
  const quoted =
    message.door === "twin_thread"
      ? message.quotedWaMessageId === undefined
        ? undefined
        : await readQuotedPost(reads, message.quotedWaMessageId)
      : message.about === undefined
        ? undefined
        : message.about.kind === "line"
          ? await readEditedCard(reads, message.about)
          : await readAnsweredBlank(reads, message.about);
  // THE DRAFT THE REP POINTED AT NAMES ITS CUSTOMER (tickets #175, #321): a
  // rep who replies to a Borrador has named a customer without typing a
  // name, and the turn is shown that customer's reference beside the post.
  const quotedCustomer =
    quoted?.destination === undefined
      ? undefined
      : deps.bundle.referenceOfChat(quoted.destination);
  // WHEN THE RUNTIME PICKED THIS MESSAGE UP — the instant NFR-2's budget is
  // measured from (ADR-0016 as amended). Taken before the execution is
  // queued, so a message that waits for a lane slot has that wait counted
  // rather than hidden.
  const runtimeSeenAt = new Date();
  const wake = THREAD_MESSAGE_WAKE;
  // THE TRIGGER IS BUILT ONCE AND HANDED TO BOTH (ticket #174). It goes to
  // `executeStep`, which puts it on the record and the chain entry, and
  // into `ThreadDeps`, where it is the gate every rep-act tool checks
  // against (ADR-0013's third shape). ONE object, so "which message is this
  // execution's" is stated in one place — two constructions would be two
  // chances for what the record attests and what the tools verify to
  // disagree, on exactly the value that decides whether a rep act happened.
  const trigger: TwinThreadMessageTrigger = {
    kind: wake.occasion,
    mechanism: wake.mechanism,
    twinId: deps.twinId,
    // WHICH DOOR ASKED, ON THE RECORD THAT CREATED THE RUN (ticket #261). The
    // answer's delivery is read back off it — a `twin_thread` answer mints its
    // `system_send`, a `dashboard` answer is posted at the door and mints
    // nothing — so it travels with the trigger rather than being recovered
    // afterwards from the shape of an id.
    door: message.door,
    eventId: message.eventId,
    // THE REP SIDE'S OWN ID FOR THE POST, never the rail's stanza id — the
    // class of reference the rep chain already carries. It is also what the
    // rep-act tools resolve their target from: the model names an intent
    // and code walks from this id to the draft, the question or the post.
    ...(quoted === undefined ? {} : { quotedPostId: quoted.id }),
  };
  const executionId = randomUUID();
  // ONE SERVED MAP PER EXECUTION, minted here: the search writes it and the
  // guard reads it, and two executions running at once must not be able to
  // ground their lines in each other's hits. Its customers are the bundle's
  // stable references (ticket #321), read once per run.
  const served = new ServedHits(customersOf(deps.bundle, deps.selfChatJid));
  // THE CANVAS AS THIS LINE ARRIVES (ticket #320), read with the other reads
  // before the lane.
  const seatId =
    message.door === "dashboard" ? message.seatId : await seatOfTwin(deps.db, deps.twinId);
  const canvasBlock = await canvasBlockFor(deps.db, deps, served, seatId, timeZone);
  // ITS PLACE IN THE PASS'S ORDER, taken as it is submitted (`hand-over.ts`).
  const handOver = pass.handOver.next();
  pass.lane.submit(async () => {
    try {
      // THE DAY'S SESSION, BOTH DOORS' (ticket #319; spec #318 decision
      // 1): opened, resumed or cut before the turn is built.
      const day = await pass.sessions.enter(dayDepsOf(deps, timeZone), new Date());
      await withExecutionClient(deps, async (client) => {
        // THE DEPS AND THE DEFINITION ARE BUILT INSIDE THE BORROW (ticket
        // #174), because the rep-act tools write on this execution's own
        // connection and the tools are constructed with the deps. Nothing the
        // model is SHOWN moved: the reads above happen on the runtime's
        // connection before the lane, so the context is still the thread as
        // it stood when the router reached this message — only the render
        // moved inside, where the connection it will act on exists.
        const draftTiming = new TurnDraftTiming();
        const threadDeps: ThreadDeps = {
          db: client,
          dek: deps.dek,
          twinId: deps.twinId,
          executionId,
          hmacKey: deps.hmacKey,
          trigger,
          bundle: deps.bundle,
          embedder: deps.embedder,
          selfChatJid: deps.selfChatJid,
          message: message.text,
          ...(message.door === "twin_thread"
            ? { messageId: message.waMessageId }
            : {}),
          ...(quoted === undefined
            ? {}
            : {
                quotedPost: {
                  ...quoted.shown,
                  ...(quotedCustomer === undefined ? {} : { customer: quotedCustomer }),
                },
              }),
          ...(seatId === undefined ? {} : { seatId }),
          canvasBlock,
          repLanguage: deps.repLanguage ?? DEFAULT_REP_LANGUAGE,
          timeZone,
          eventReceivedAt: message.receivedAt,
          runtimeSeenAt,
          draftTiming,
          draft: new HeldDraftSlot(),
          served,
          // ONE ACT SLOT PER EXECUTION, as one served map: one message gets one
          // act, and two executions must not spend each other's.
          acts: new ActSlot(),
          binding: new TurnBindingProposal(),
          harness: deps.harness,
          model: deps.drafting.model,
          ...(deps.runs === undefined ? {} : { runs: deps.runs }),
        };
        await runThreadExecution(client, deps, {
          session: day.session,
          day: day.day,
          deps: threadDeps,
          wake,
          trigger,
          executionId,
          served,
          draftTiming,
          timeZone,
          said: { role: "rep", door: message.door, text: message.text, at: message.receivedAt },
          // THE SEAT THE TURN SERVES, whichever door asked: a turn that curated
          // the canvas tells the open page (`tellTheCanvas`).
          ...(seatId === undefined ? {} : { seatId }),
          handOver,
        });
      });
    } finally {
      // A TURN THAT NEVER REACHED THE SESSION frees the one behind it.
      handOver.handed();
    }
    pass.tally.consumed += 1;
  });
}

/** What the day's session is opened, resumed or cut with, off the runtime's deps. */
function dayDepsOf(deps: TwinRuntimeDeps, timeZone: string): ThreadDayDeps {
  return {
    twinId: deps.twinId,
    harness: deps.harness,
    bundle: deps.bundle,
    dek: deps.dek,
    pool: deps.executionPool,
    selfChatJid: deps.selfChatJid,
    timeZone,
    model: deps.drafting.model,
  };
}

/**
 * EVERY EVENT RAISED SINCE THE LAST PASS, INTO THE DAY'S SESSION (ticket
 * #319; spec #318 decision 11; design §6).
 *
 * THE WAKE LIST DECIDES, and only when the twin looks (`thread/events.ts`):
 * an event it appends is a line in the session and no execution at all —
 * the session is opened or resumed for it if no child is up, which costs no
 * model call — and an event it wakes on is a turn of its own on the realtime
 * lane, with a record whose trigger names the event. In the order raised.
 *
 * THE SPOTLIGHT IS READ ONCE, and only when a settle is among them: the
 * current curation the thread's own `spotlight` wrote (ticket #320).
 */
async function routeThreadEvents(deps: TwinRuntimeDeps, pass: Pass): Promise<void> {
  const raised = pass.sessions.drain(deps.twinId);
  if (raised.length === 0) return;
  const timeZone = deps.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  // AN EVENT THIS PASS COULD NOT HAND OVER GOES BACK (Codex r1): a seam read
  // or a session open that throws leaves every event not yet delivered for
  // the next pass, rather than dropped with the failure.
  let delivered = 0;
  try {
    const top = raised.some(({ event }) => event.kind === "post.settled")
      ? await topCardOf(deps)
      : undefined;
    for (const { event, at } of raised) {
      // A CARD SETTLING IS THE SEAM EVENT A `card_settled` TRIGGER NAMES
      // (ticket #325): each matching active rutina starts one run, told the
      // card's post id, before the thread hears of it.
      if (event.kind === "post.settled") {
        await fireOnEvent(deps, { kind: "card_settled", postId: event.postId, outcome: event.outcome }, at);
      }
      if (fateOf(event, { top }) === "append") {
        const day = await pass.sessions.enter(dayDepsOf(deps, timeZone), new Date());
        const line = renderEvent(event, at, timeZone);
        pass.appended.push(
          day.session.append(line).then(() =>
            indexWithoutFailing(deps, day, [
              { id: randomUUID(), role: "event", at, text: line },
            ]),
          ),
        );
      } else {
        await submitThreadEventExecution(deps, pass, event, at, timeZone);
      }
      delivered += 1;
    }
  } catch (thrown) {
    pass.sessions.requeue(deps.twinId, raised.slice(delivered));
    throw thrown;
  }
}

/** The post the canvas spotlights for this twin now, if any. */
async function topCardOf(deps: TwinRuntimeDeps): Promise<string | undefined> {
  return (await readCuration({ db: deps.db, twinId: deps.twinId, dek: deps.dek }))?.spotlight;
}

/**
 * EVERY ASK OF THE REP'S THE TWIN HAS NOT ANSWERED, OLDEST FIRST (ticket
 * #358; `rep-asks.ts`): each a turn of the thread — the arrival's under its
 * own trigger, a pick's, a selection's and a summons' under the event's —
 * whose transaction writes the ask's marker. A row is never answered twice:
 * the pass that reads it settles its lane before the next pass reads again.
 */
async function routeRepAsks(deps: TwinRuntimeDeps, pass: Pass): Promise<void> {
  const asked = await pendingAsks({ db: deps.db, twinId: deps.twinId, dek: deps.dek });
  if (asked.length === 0) return;
  const timeZone = deps.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  for (const { event, at } of asked) {
    if (event.kind === "arrival") await submitThreadArrivalExecution(deps, pass, event, at, timeZone);
    else await submitThreadEventExecution(deps, pass, event, at, timeZone);
  }
}

/** The twin's one seat, when it has one. */
async function seatOfTwin(db: pg.ClientBase, twinId: string): Promise<string | undefined> {
  const seat = await db.query<{ id: string }>("SELECT id FROM seats WHERE twin_id = $1", [
    twinId,
  ]);
  return seat.rows[0]?.id;
}

/**
 * THE WAKE'S CANVAS BLOCK (ticket #320; design §3.2): what waits as the turn
 * begins, its cards numbered in this run's `served`, read on the execution's
 * own connection so the block and the turn's tools see one store.
 */
async function canvasBlockFor(
  client: pg.ClientBase,
  deps: TwinRuntimeDeps,
  served: ServedHits,
  seatId: string | undefined,
  timeZone: string,
): Promise<string> {
  const view = await readCanvasView(
    { db: client, twinId: deps.twinId, dek: deps.dek, timeZone, bundle: deps.bundle },
    seatId,
    new Date(),
    deps.harness?.directory,
  );
  return renderCanvas(view, served, timeZone);
}

/**
 * THE THREAD'S OWN ITEMS, INTO ITS STORE (ticket #320; `memory-tools.ts`
 * argues what is and is not recorded) — after the turn that holds them, and
 * never at the cost of the turn: the store is a reading aid, and a failed
 * embed or write leaves the day's session whole.
 */
async function indexWithoutFailing(
  deps: TwinRuntimeDeps,
  day: { readonly session: { readonly sessionId: string }; readonly day: string },
  items: readonly ThreadItemToIndex[],
): Promise<void> {
  try {
    await indexThreadItems(deps, { sessionId: day.session.sessionId, day: day.day }, items);
  } catch {
    // The item stays in the day's session; only its search is lost.
  }
}

/** The workspace path a `wrote` effect names: its `told` is `<tool>: <path>` (`TurnBook.sdkToolUsed`). */
function writtenPath(told: string): string {
  return told.slice(told.indexOf(": ") + 2);
}

/**
 * THE WORKSPACE, VERSIONED AT A THREAD TURN'S END (ticket #326;
 * `workspace.ts`) — the versions it wrote, or none — and never at the cost of
 * the turn: a snapshot that fails before writing its versions leaves the
 * files to the next boundary, and one that fails after them leaves those
 * versions whole and out of recall.
 */
async function snapshotWithoutFailing(deps: TwinRuntimeDeps, run: ThreadRun): Promise<readonly WorkspaceVersion[]> {
  try {
    return await snapshotWorkspace(deps, { executionId: run.executionId, sessionId: run.session.sessionId, now: new Date() });
  } catch {
    return [];
  }
}

/**
 * A TURN AN EVENT WOKE (ticket #319): the thread's other occasion, on the same
 * lane and through the same run as a rep's line — with no message and no
 * quote, because nobody wrote anything, and with the event's own line as what
 * the turn is about.
 */
async function submitThreadEventExecution(
  deps: TwinRuntimeDeps,
  pass: Pass,
  event: ThreadEvent,
  at: Date,
  timeZone: string,
): Promise<void> {
  const wake = THREAD_EVENT_WAKE;
  const postId = postOf(event);
  const trigger: TwinThreadEventTrigger = {
    kind: wake.occasion,
    mechanism: wake.mechanism,
    twinId: deps.twinId,
    event: event.kind,
    ...(postId === undefined ? {} : { postId }),
  };
  await submitUnaskedExecution(deps, pass, {
    event,
    at,
    timeZone,
    trigger,
    wake,
  });
}

/**
 * THE REP ARRIVED, AND THE THREAD GREETS THEM (ticket #320; spec #318 decision
 * 15; design D4): a turn of the day's session whose trigger is the arrival's
 * own — `executions.trigger_kind` reads `arrival` — shown the canvas and the
 * arrival's line. Its words land as the arrival post; its spotlight is its own
 * call to `spotlight`.
 */
async function submitThreadArrivalExecution(
  deps: TwinRuntimeDeps,
  pass: Pass,
  event: Extract<ThreadEvent, { kind: "arrival" }>,
  at: Date,
  timeZone: string,
): Promise<void> {
  const wake = THREAD_ARRIVAL_WAKE;
  const trigger: ArrivalTrigger = {
    kind: wake.occasion,
    mechanism: wake.mechanism,
    twinId: deps.twinId,
    seatId: event.arrival.seatId,
    arrivalId: event.arrival.arrivalId,
    visit: event.firstOfDay ? "first_of_day" : "return",
    arrivedAt: event.arrival.arrivedAt.toISOString(),
    ...(event.arrival.lastArrivedAt === undefined
      ? {}
      : { lastArrivedAt: event.arrival.lastArrivedAt.toISOString() }),
  };
  await submitUnaskedExecution(deps, pass, {
    event,
    at,
    timeZone,
    trigger,
    wake,
  });
}

/**
 * A TURN NOBODY WROTE (tickets #319, #320): an event's or the rep's arrival —
 * no message and no quote, the event's own line as what the turn is about,
 * and the canvas as it stands.
 */
async function submitUnaskedExecution(
  deps: TwinRuntimeDeps,
  pass: Pass,
  wake: {
    readonly event: ThreadEvent;
    readonly at: Date;
    readonly timeZone: string;
    readonly trigger: TwinThreadEventTrigger | ArrivalTrigger;
    readonly wake: typeof THREAD_EVENT_WAKE | typeof THREAD_ARRIVAL_WAKE;
  },
): Promise<void> {
  const { event, at, timeZone, trigger } = wake;
  const executionId = randomUUID();
  const runtimeSeenAt = new Date();
  const line = renderEvent(event, at, timeZone);
  // WHAT THE TURN IS SHOWN, READ BEFORE THE LANE as a rep line's reads are,
  // so the turns of one pass reach the session in the order they were raised.
  const served = new ServedHits(customersOf(deps.bundle, deps.selfChatJid));
  // THE SEAT A LINE GOES TO: the one that arrived, picked the matter (ticket
  // #335) or selected the phrase (ticket #341), else the twin's one seat.
  const seatId =
    trigger.kind === "arrival"
      ? trigger.seatId
      : event.kind === "matter.picked" || event.kind === "selection" || event.kind === "summons"
        ? event.seatId
        : await seatOfTwin(deps.db, deps.twinId);
  const canvasBlock = await canvasBlockFor(deps.db, deps, served, seatId, timeZone);
  // THE EVENT'S OWN LINE GROUNDS A LINE'S FIGURES TOO (`thread/line.ts`): a
  // welcome may say the hour it was greeted at.
  served.ground(line);
  // ITS PLACE IN THE PASS'S ORDER, taken as it is submitted (`hand-over.ts`).
  const handOver = pass.handOver.next();
  pass.lane.submit(async () => {
    try {
      const day = await pass.sessions.enter(dayDepsOf(deps, timeZone), new Date());
      await withExecutionClient(deps, async (client) => {
        const draftTiming = new TurnDraftTiming();
        const threadDeps: ThreadDeps = {
          db: client,
          dek: deps.dek,
          twinId: deps.twinId,
          executionId,
          hmacKey: deps.hmacKey,
          trigger,
          bundle: deps.bundle,
          embedder: deps.embedder,
          selfChatJid: deps.selfChatJid,
          message: line,
          ...(seatId === undefined ? {} : { seatId }),
          canvasBlock,
          repLanguage: deps.repLanguage ?? DEFAULT_REP_LANGUAGE,
          timeZone,
          eventReceivedAt: at,
          runtimeSeenAt,
          draftTiming,
          draft: new HeldDraftSlot(),
          served,
          acts: new ActSlot(),
          binding: new TurnBindingProposal(),
          harness: deps.harness,
          model: deps.drafting.model,
          ...(deps.runs === undefined ? {} : { runs: deps.runs }),
        };
        await runThreadExecution(client, deps, {
          session: day.session,
          day: day.day,
          deps: threadDeps,
          wake: wake.wake,
          trigger,
          executionId,
          served,
          draftTiming,
          timeZone,
          said: { role: "event", text: line, at },
          ...(seatId === undefined ? {} : { seatId }),
          ...(event.kind === "matter.picked" ? { pickId: event.pickId } : {}),
          ...(event.kind === "selection" ? { selectionId: event.selectionId } : {}),
          ...(event.kind === "summons" ? { summonsId: event.summonsId } : {}),
          handOver,
        });
      });
    } finally {
      // A TURN THAT NEVER REACHED THE SESSION frees the one behind it.
      handOver.handed();
    }
  });
}

/** What one thread turn needs beyond the thread's own definition. */
interface ThreadRun {
  /** The day's session the turn is pushed into (`thread/sessions.ts`). */
  readonly session: Session<ThreadTag>;
  /** Its place in the order the pass hands its turns to that session (`hand-over.ts`). */
  readonly handOver: HandOver;
  /** The seat-local day that session belongs to. */
  readonly day: string;
  /** What woke the turn, as the thread's own store records it (ticket #320). */
  readonly said: Omit<ThreadItemToIndex, "id">;
  /** What the turn's tools and recipes are bound to — its trigger is `trigger`. */
  readonly deps: ThreadDeps;
  /** The wake that fired, which the record's trigger is held to. */
  readonly wake: typeof THREAD_MESSAGE_WAKE | typeof THREAD_EVENT_WAKE | typeof THREAD_ARRIVAL_WAKE;
  readonly trigger: ThreadTrigger;
  /** Minted before the run: the answer notice names it. */
  readonly executionId: string;
  /** The run's served map — what a reference in the line resolves against. */
  readonly served: ServedHits;
  /** When the draft this run wrote was ready — its timing row's instants. */
  readonly draftTiming: TurnDraftTiming;
  readonly timeZone: string;
  /**
   * The seat the turn serves: the one that typed a line at the dashboard's
   * door (ticket #263), or the one a line nobody asked for is shown to
   * (ticket #320).
   */
  readonly seatId?: string;
  /**
   * The page's own id for the matter the rep picked, on a turn that pick woke
   * (ticket #335): the page hears its line, or its absence, under it.
   */
  readonly pickId?: string;
  /** ...and for the phrase the rep selected, on a turn that selection woke (ticket #341). */
  readonly selectionId?: string;
  /** ...and for the card the presence landed on, on a turn that summons woke (ticket #340). */
  readonly summonsId?: string;
}

/** The row of `rep_asks` a turn was woken from — the page's own id for the ask (ticket #358). */
function askOf(run: Pick<ThreadRun, "pickId" | "selectionId" | "summonsId">): string | undefined {
  return run.pickId ?? run.selectionId ?? run.summonsId;
}

/** The seat a door turn's ending is told to, and the bus it is told on (ticket #263). */
interface DoorStream {
  readonly seatId: string;
  readonly events: SeatEvents;
}

/**
 * ONE THREAD EXECUTION, END TO END (tickets #173, #319, #363; spec #171
 * decision 12; ADR-0020).
 *
 * THE TURN RUNS THROUGH THE ONE ENGINE (`executeStep`): the thread's
 * definition on the day's session, which records the turn — its record and
 * its chain entry, on this connection — and hands back its words, what its
 * tools did and the lines that folded into it. What the words become is this
 * function's: the post at the door the rep asked at, the markers, the index.
 *
 * ONE TRANSACTION, AND EVERYTHING IN IT, on a connection this execution
 * borrowed rather than the runtime's: the act and its audit link commit
 * together or not at all (`chainApertureAct`'s rule for the aperture).
 * So the entry, the record, the answer post — which IS the binding question
 * when the reply asked one in the thread (#195), and which has the question
 * beside it rather than inside it at the dashboard's door (#261) — the
 * `system_send` the door takes, and the message's processing marker, are one
 * commit.
 *
 * THE TURN IS A TURN OF THE DAY'S SESSION (ticket #319; design D1, D7):
 * the wake is pushed into the session and the transaction stays open until
 * the turn that answered it has ended. Three endings come back. This wake
 * OWNED the turn and it ran — the record, the post and the markers are this
 * transaction's, for this wake and for every line that FOLDED into the turn,
 * each answered on its own door. It owned a turn that FAILED — recorded,
 * every line it answered consumed as failed, nothing posted, and the session
 * has already dropped the turn. Or this wake FOLDED into another wake's turn
 * — then nothing here is written at all: the owner's transaction records the
 * turn once and marks this line, so a turn never leaves two records.
 *
 * A `failed` RUN POSTS NOTHING AND MARKS ITS EVENT (ticket #240). Nothing
 * posts, which is the thread's own criterion — "a turn that never ends on a
 * line the guard accepts ends `failed` and posts nothing" — the engine has
 * rolled its tools' effects back, the event is consumed under
 * `execution_failed`, and the failure does not leave this function.
 *
 * THE MARKER IS WHAT BOUNDS THE SPEND, which is why it is not optional. A run
 * that consumed nothing would be re-read two seconds later, re-run, and pay
 * for another model call and another immutable record for a message that is
 * not getting better on its own. One marker is one paid attempt per message.
 *
 * WHAT IT COSTS, recorded rather than discovered: a message that failed for a
 * reason that would have passed a moment later — a wire hiccup inside the
 * model call — gets no second attempt, and the rep reads no answer and no
 * explanation. A bounded retry needs a durable attempt count this runtime does
 * not have (#240).
 */
async function runThreadExecution(
  client: pg.PoolClient,
  deps: TwinRuntimeDeps,
  run: ThreadRun,
): Promise<void> {
  const asked = repTriggerOf(run);
  const askId = askOf(run);
  // THE TWIN'S NOTES AS THE TURN BEGINS (ticket #322), so the page is told
  // when they moved — read again after the turn, whatever its outcome: they
  // live in the bundle, outside the transaction a failed run rolls back.
  const notesBefore = deps.bundle.readWorkingMemory()?.version ?? 0;
  const outcome = await withDbTransaction(client, async () => {
    // THE TURN, THROUGH THE ONE ENGINE (ticket #363): the thread's definition
    // on the day's session, its tools and recipes bound to this turn's deps,
    // its words held to the guard. The engine records the turn — one record,
    // one entry — under a savepoint, so a failed turn has rolled back what its
    // tools wrote by the time it comes back; what to post and what to mark is
    // this caller's.
    const ran = await executeStep(
      { harness: deps.harness, db: client, twinId: deps.twinId, hmacKey: deps.hmacKey },
      {
        definition: THREAD_DEFINITION,
        conversation: { kind: "thread", deps: run.deps, words: threadWordsRule(run.deps) },
        inputs: {},
        trigger: run.trigger,
        wake: run.wake,
        lane: "realtime",
        executionId: run.executionId,
        now: run.deps.runtimeSeenAt,
        model: deps.drafting.model,
        day: {
          session: run.session,
          handOver: run.handOver,
          tag: {
            trigger: run.trigger,
            ...(run.seatId === undefined ? {} : { seatId: run.seatId }),
            said: run.said,
            ...(askId === undefined ? {} : { askId }),
          },
        },
        ...traceFor(deps.trace, run.trigger),
      },
    );
    if (ran.kind === "folded") {
      // ANOTHER WAKE'S TURN ANSWERED THIS LINE: its transaction records the
      // turn and marks this line, and nothing of it belongs here.
      return { folded: true as const };
    }
    const folded = ran.folded.flatMap((tag) =>
      tag.trigger.kind === "twin_thread_message" ? [{ ...tag, trigger: tag.trigger }] : [],
    );
    // ...AND THE REP'S ASKS THAT FOLDED INTO IT (ticket #358): the turn read
    // them, so it is the one that answered them, and its transaction marks
    // them as it marks a folded line.
    const foldedAsks = ran.folded.flatMap((tag) => (tag.askId === undefined ? [] : [tag.askId]));
    const foldedArrivals = ran.folded.flatMap((tag) => (tag.trigger.kind === "arrival" ? [tag.trigger] : []));
    const markAsked = async (marked: Disposition): Promise<void> => {
      if (askId !== undefined) await markAsk(client, deps.twinId, askId, marked);
      for (const askId of foldedAsks) await markAsk(client, deps.twinId, askId, foldedMarker(marked, false));
      if (run.trigger.kind === "arrival") await markArrival(client, deps.twinId, run.trigger.arrivalId, run.executionId);
      for (const arrival of foldedArrivals) await markArrival(client, deps.twinId, arrival.arrivalId, run.executionId);
    };
    const { settlement } = ran;
    if (settlement.disposition === "failed") {
      // EVERY LINE IT ANSWERED IS CONSUMED (ticket #240), inside the same
      // transaction as the record and the entry: a failed turn posts nothing,
      // and a door message a turn could not answer is consumed exactly as a
      // thread message is (ticket #261) — a folded line too, because the turn
      // that answered it is the one that failed.
      if (asked !== undefined) {
        await markThreadMessage(client, deps, asked, "execution_failed");
      }
      for (const line of folded) {
        await markThreadMessage(client, deps, line.trigger, "execution_failed");
      }
      // ...AND EVERY ASK IT WAS ANSWERING (tickets #320, #358): the ask was
      // answered by this execution, which left no line.
      await markAsked("execution_failed");
      return { failed: true as const, marked: "execution_failed" as const, folded };
    }
    // THE TURN'S END IS A STEP BOUNDARY (ticket #326; ADR-0011 as amended):
    // the workspace is versioned here, inside the turn, so a document the turn
    // wrote rides on its answer at the version this boundary took.
    // ...AND ONLY THE FILES THIS TURN WROTE ride on its answer (Codex r3): the
    // workspace is the twin's one directory, and a run may be writing beside
    // the turn.
    const wrote = new Set(settlement.effects.flatMap((effect) => (effect.performed && effect.act === WROTE_ACT ? [writtenPath(effect.told)] : [])));
    const documents = (await snapshotWithoutFailing(deps, run)).filter((version) => wrote.has(version.path)).map(documentPart);
    // WHAT THE TOOLS DID, which is what the rep is told and how the event is
    // marked. Never the words: a line that claims «lo descarté» with no call
    // behind it leaves this list empty, so there is nothing to render a
    // receipt from and nothing to mark with (spec #171 decision 22).
    const effects: readonly EffectOutcome[] = settlement.effects;
    const performed = (act: string): boolean => effects.some((effect) => effect.performed && effect.act === act);
    // WHETHER THIS TURN CURATED THE CANVAS, KNOCKED A CARD (ticket #320) OR
    // SAID A SENTENCE ON ONE OF ITS CARDS (ticket #340), which the open page
    // is told once the turn commits.
    // ...MOVED ITS CARDS OR HELD ONE UP (ticket #401), which the open page is told too.
    const moved = performed(CARDS_MOVED_ACT);
    const spotlit = performed(SPOTLIT_ACT);
    const knocked = performed("knocked");
    const spoke = performed(SAID_ON_CARD_ACT);
    // THE CARDS THIS TURN ANSWERED IN THE REP'S NAME (ticket #386), which the
    // open page is told once the turn commits.
    const settled = effects.flatMap((effect) =>
      effect.performed && effect.settles !== undefined && (SETTLE_OUTCOMES as readonly string[]).includes(effect.settles.outcome)
        ? [{ postId: effect.settles.postId, outcome: effect.settles.outcome as SettleOutcome }]
        : [],
    );
    // THE ONE ACT THIS TURN PERFORMED OR REFUSED, if any.
    const acted = threadAct(effects);
    const served = run.served.state();
    const words = settlement.words.trim();
    // THE DRAFT THE TURN HELD LANDS WITH ITS WORDS (ticket #368): what the
    // twin finished on is the sentence the card carries above the draft and
    // the thread's line above the Borrador, written after the record because
    // the post is immutable and the words exist only now — under the post id
    // `create_draft` named, with the knock the turn held on it (ticket #358).
    // Its timing row follows it, the draft ready the moment it is written.
    const held = run.deps.draft.held;
    if (held !== undefined) {
      await landDraft(client, draftTwinOf(deps), held, { words, mentions: mentionsIn(words, served.customers) }, { bundle: deps.bundle });
      run.draftTiming.record({
        draftId: held.id,
        executionId: run.executionId,
        eventReceivedAt: run.deps.eventReceivedAt,
        runtimeSeenAt: run.deps.runtimeSeenAt,
        draftReadyAt: new Date(),
      });
    }
    // A REP-INITIATED DRAFT'S TIMING ROW, written here and not in the tool
    // that held or filled the draft (ticket #175; `thread/draft-timing.ts`
    // argues the placement): `draft_timings.execution_id` references the record the
    // engine just wrote, which did not exist while the model loop was running.
    // Same transaction, same three instants, so NFR-2 measures a draft the rep
    // asked for by the same arithmetic as one a customer's turn produced.
    const timing = run.draftTiming.timing;
    if (timing !== undefined) await recordDraftTiming(client, timing);
    const answering = answeringDeps(client, deps);
    // THE BINDING QUESTION THE TWIN HANDED THE REP (ticket #363), from its
    // `propose_binding` call and never from its words. DUE-NESS IS DECIDED
    // HERE, inside the transaction and under the per-twin lock: two
    // executions run at once (`lanes.ts`), so a read outside the lock lets
    // both find the same chat unasked and both ask, permanently, because a
    // notice is immutable. The lock is taken after the turn's chain append,
    // which is the order every execution takes them in
    // (`takeBindingCeremonyLock` argues why that is deadlock-free).
    const proposal = run.deps.binding.proposal;
    let binding: BindingQuestion | undefined;
    if (proposal !== undefined) {
      await takeBindingCeremonyLock(client, deps.twinId);
      const aboutEventId = await bindingQuestionAnchor(answering, proposal.chat);
      if (aboutEventId !== undefined) {
        binding = { aboutEventId, proposedName: proposal.chat.pushName, sentence: proposal.sentence };
      }
    }
    if (words === "") {
      // SILENCE THE TWIN CHOSE — it wrote nothing — recorded as such, not as
      // ordinary captured traffic (spec #29 story 12; spec #171 decision 25).
      // The word is the one the seam has always used, so the disposition
      // CHECK is untouched.
      //
      // ...UNLESS IT ALSO ACTED, and then the rep still gets the receipt
      // (ticket #174). «así no» and nothing else is a rep asking for an
      // effect and not for a conversation: the twin has nothing to say and
      // still owes them the line saying the draft is gone. The receipt
      // posts alone, under the act's own notice kind, and the marker is the
      // act's word rather than the silence's — because what happened to
      // this event is that the draft was discarded.
      //
      // ...AND SILENCE BESIDE A DRAFT POSTS NOTHING EXTRA (ticket #175),
      // which is the same rule read from the other end: `create_draft`
      // renders no receipt because the Borrador it posted IS the
      // acknowledgement, so a rep who asked for a draft and got one reads
      // exactly one message. The marker is still the act's word.
      if (acted !== undefined && acted.outcome.receipt !== undefined) {
        const kind = THREAD_ACTS[acted.act].notice;
        if (kind === undefined) {
          // A receipt with nowhere to post it is the map and the tools
          // disagreeing, which is loud rather than a line quietly dropped
          // — the same seam `threadAct` throws at one field over.
          throw new Error(
            `the act "${acted.act}" rendered a receipt and has no notice kind to post it under (ticket #175)`,
          );
        }
        // THE RECEIPT IS THE REPLY, BY THE ONE DELIVERY A RECEIPT HAS (ticket
        // #358; `postReceipt`): to both surfaces, as a button's is — naming
        // the rep's thread message where one asked, set at the bar's door so
        // the day's thread shows it as the reply to the line, and naming only
        // the turn's execution where an event woke it.
        await postReceipt(client, {
          twinId: deps.twinId,
          selfChatJid: deps.selfChatJid,
          dek: deps.dek,
          kind,
          // THE PART CARRIES WHAT THE TOOL RETURNED (ticket #220): words that
          // merely claim an effect reach this branch with no receipt at all,
          // so they compose no receipt part.
          receipt: acted.outcome.receipt,
          executionId: run.executionId,
          ...(asked?.door === "twin_thread" ? { about: { eventId: asked.eventId } } : {}),
          ...(asked?.door === "dashboard" ? { asked: { door: "dashboard", messageId: asked.eventId } } : {}),
        });
      }
      // A QUESTION HANDED WITH NOTHING TO SAY posts alone, in the binding
      // question's own form.
      if (binding !== undefined) {
        await postBindingQuestion(
          client,
          {
            twinId: deps.twinId,
            selfChatJid: deps.selfChatJid,
            dek: deps.dek,
            ...(deps.timeZone === undefined ? {} : { timeZone: deps.timeZone }),
          },
          { ...binding, executionId: run.executionId },
        );
      }
      const marked =
        acted === undefined
          ? ("deliberate_silence" as const)
          : THREAD_ACTS[acted.act].marker;
      if (asked !== undefined) await markThreadMessage(client, deps, asked, marked);
      await markFolded(client, deps, folded, marked);
      await markAsked(marked);
      return { marked, folded, moved, spotlit, knocked, spoke, settled };
    }
    // THE CEREMONY FIRES ON BOTH DOORS AND RIDES DIFFERENTLY (ticket #261).
    // In the thread the question is FOLDED into the reply — one post carries
    // the reply and the twin's question, which is the shape #195 built. At the dashboard's door the fold is
    // impossible: a question is a PROACTIVE post, it goes to both surfaces
    // and mints its send because the rep answers it wherever they are, and the reply is
    // delivered to the door alone. So the door's turn posts two things — the
    // answer at the door, and the question beside it — rather than folding a
    // question into a post the phone never receives and spending the
    // once-ever ask on a surface the rep may not open again today. A turn an
    // event woke asks the same way the door does.
    const foldsQuestion = binding !== undefined && asked?.door === "twin_thread";
    const receipt = acted?.outcome.receipt ?? notedReceipt(effects);
    // IN THE THREAD THE WORDS RIDE THE BORRADOR (tickets #175, #368): a turn
    // that wrote a draft and said nothing else posted its words above the
    // draft, so the phone reads one message — the rule #175 set for silence
    // beside a draft. A reply that carries more than the words (a receipt,
    // the binding question, a document) still posts; the dashboard's door
    // keeps its reply, because the bar answers there and the card is elsewhere.
    const ridesTheBorrador = (door: Door): boolean =>
      door === "twin_thread" &&
      held !== undefined &&
      receipt === undefined &&
      !foldsQuestion &&
      documents.length === 0;
    const reply = {
      executionId: run.executionId,
      // THE TWIN'S WORDS AS IT WROTE THEM, AND WHAT EACH REFERENCE NAMED
      // (ADR-0037 as amended; ticket #321): the post seals both, and every
      // surface renders the names from the mentions — the phone at send time,
      // the dashboard with a link to the customer's waiting card. Resolved
      // through the run's own `customers`, the one the guard judged with, so
      // the string it judged and the string the rep reads are one string.
      answer: words,
      mentions: mentionsIn(words, served.customers),
      // ...AND CODE FOLDS THE RECEIPT (ticket #174; spec #171 decision 22).
      // ONE POST PER TURN, so a rep whose message both asked for something
      // and said something reads one message: the effect's own account of
      // itself, then the twin's words. It comes from the TOOL's outcome, so a
      // model that wrote the same sentence into its line changes nothing
      // about what is rendered here — there is simply no receipt to fold.
      // ...OR, WITH NO ACT'S RECEIPT TO FOLD, THE LINE A REWRITE OF THE TWIN'S
      // NOTES OWES when the rep asked for it (ticket #322).
      ...(receipt === undefined ? {} : { receipt }),
      // ...AND THE DOCUMENTS THE TURN WROTE (ticket #326), each a card.
      ...(documents.length === 0 ? {} : { documents }),
    };
    if (asked === undefined) {
      // A TURN NOBODY WROTE SPEAKS ON INICIO AND NOWHERE ELSE (ticket #320;
      // design D4, «a line in the bar»; ADR-0031's self-chat is a pull surface
      // the twin never pushes into unasked): a door-only post of the line
      // kind — the arrival post on an arrival, the unasked line on an event —
      // with no send command, no knock and no push. The phone hears of it
      // only through `knock`.
      // ...ITS RECEIPT INSIDE IT, where its act rendered one (ticket #358): the
      // receipt rides with the twin's words as a reply's does.
      await insertPost(client, {
        twinId: deps.twinId,
        dek: deps.dek,
        parts: [
          ...(receipt === undefined ? [] : [{ kind: "receipt" as const, text: receipt }]),
          prosePart(reply.answer, reply.mentions),
          ...documents,
        ],
        executionId: run.executionId,
        asked:
          run.trigger.kind === "arrival"
            ? { door: "dashboard", arrivalId: run.trigger.arrivalId }
            : { door: "dashboard", unasked: true },
      });
    } else if (!ridesTheBorrador(asked.door)) {
      await postAnswer(answering, {
        ...reply,
        ...(foldsQuestion ? { binding } : {}),
        door: asked.door,
        eventId: asked.eventId,
      });
    }
    // THE REPLY REACHES EVERY DOOR A FOLDED LINE CAME THROUGH (ticket #319):
    // a line typed at the bar while the phone's question was being answered
    // is answered at the bar too, once per door, about the first line that
    // came through it.
    for (const line of firstFoldedPerDoor(folded, asked?.door)) {
      if (ridesTheBorrador(line.trigger.door)) continue;
      await postAnswer(answering, {
        ...reply,
        door: line.trigger.door,
        eventId: line.trigger.eventId,
      });
    }
    if (binding !== undefined && !foldsQuestion) {
      // ITS OWN POST, AS DRAFTING ASKS IT (`postBindingQuestion`): the twin's
      // sentence with the name folded in, on both surfaces, with its send.
      await postBindingQuestion(
          client,
          {
            twinId: deps.twinId,
            selfChatJid: deps.selfChatJid,
            dek: deps.dek,
            ...(deps.timeZone === undefined ? {} : { timeZone: deps.timeZone }),
          },
          { ...binding, executionId: run.executionId },
        );
    }
    // THE MARKER TAKES THE ACT'S EXISTING WORD (ticket #174; spec #171
    // decision 22 — "the vocabulary is not narrowed"). `dismissed`,
    // `retracted`, `declined` when one performed; `correction_refused` when
    // the one Ledger act was refused, which is the word audit coverage joins
    // its refusal class on and the only record a refusal leaves; `answered`
    // when the twin replied and no tool acted.
    const marked =
      acted === undefined ? ("answered" as const) : THREAD_ACTS[acted.act].marker;
    if (asked !== undefined) await markThreadMessage(client, deps, asked, marked);
    await markFolded(client, deps, folded, marked);
    await markAsked(marked);
    return { marked, folded, moved, spotlit, knocked, spoke, settled, said: annotateNames(reply.answer, reply.mentions) };
  });
  if ("folded" in outcome && outcome.folded === true) return;
  if (!("marked" in outcome)) return;
  // A FAILED TURN'S END IS A BOUNDARY TOO (ticket #326): the files it wrote
  // are on disk whatever became of it, so they are versioned now.
  if ("failed" in outcome) await snapshotWithoutFailing(deps, run);
  // THE PAGE HEARS THE LINE AND THE CURATION ONCE THEY COMMITTED (tickets #266,
  // #320) — never before, so a page never shows a row that rolled back. An
  // arrival always hears how its turn ended, its line or nothing, and the
  // fallback stands on nothing (spec #258 decision 15).
  // EVERY LINE OF THE TURN THAT CAME IN AT THE DASHBOARD'S DOOR — the owner's
  // and the folded ones — each told its ending below, and named on the
  // canvas's `curated` first, so the bar binds this turn's choice to their
  // replies and to nobody else's (ticket #380).
  const doorLines = [
    ...(asked?.door === "dashboard" && run.seatId !== undefined
      ? [{ eventId: asked.eventId, seatId: run.seatId }]
      : []),
    ...outcome.folded.flatMap((line) =>
      line.trigger.door === "dashboard" && line.seatId !== undefined
        ? [{ eventId: line.trigger.eventId, seatId: line.seatId }]
        : [],
    ),
  ];
  await tellTheCanvas(
    client,
    deps,
    run,
    {
      failed: "failed" in outcome,
      moved: !("failed" in outcome) && outcome.moved,
      spotlit: !("failed" in outcome) && outcome.spotlit,
      knocked: !("failed" in outcome) && outcome.knocked,
      spoke: !("failed" in outcome) && outcome.spoke,
      lined: !("failed" in outcome) && asked === undefined && outcome.said !== undefined,
    },
    doorLines.flatMap((line) => (line.seatId === run.seatId ? [line.eventId] : [])),
  );
  await tellTheNotes(client, deps, run, notesBefore);
  // THE TURN'S ITEMS, INTO THE THREAD'S OWN STORE (ticket #320), once it is
  // kept: a failed turn is not in the session, so it is not in the store.
  if (!("failed" in outcome)) {
    await indexWithoutFailing(deps, { session: run.session, day: run.day }, [
      { id: randomUUID(), ...run.said },
      // ...AND EVERY LINE THAT FOLDED INTO THIS TURN, which its own wake never
      // records (Codex r1).
      ...outcome.folded.flatMap((line) =>
        line.said === undefined ? [] : [{ id: randomUUID(), ...line.said }],
      ),
      ...(outcome.said === undefined
        ? []
        : [
            {
              id: randomUUID(),
              role: "twin" as const,
              ...(asked === undefined ? {} : { door: asked.door }),
              at: new Date(),
              text: outcome.said,
            },
          ]),
    ]);
  }
  // THE DOOR HEARS HOW THE TURN ENDED ONCE IT HAS COMMITTED, and not a
  // statement before: a post event for a row that then rolled back would be a
  // reply the page shows and no read can find (ticket #263). Every line of the
  // turn that came in at the door hears it — the owner's and the folded ones.
  //
  // AND NOTHING ON THAT PATH CAN CHANGE THE TURN'S AFTERMATH. The turn is
  // committed; a read-back that throws here must neither skip the settle
  // below nor surface as the turn's failure. The page learns the ending from
  // its next history read, which is what it does for any event it missed.
  if (deps.events !== undefined) {
    for (const line of doorLines) {
      try {
        await tellTheDoor(
          client,
          deps,
          { seatId: line.seatId, events: deps.events },
          line.eventId,
          run.timeZone,
          foldedMarker(outcome.marked, line.eventId === asked?.eventId),
        );
      } catch {
        // The next history read carries what this would have said.
      }
    }
  }
  // A CARD THE REP ANSWERED FROM THE THREAD SETTLES ON THE CANVAS TOO (ticket
  // #266; spec #258 decision 20: «a thread-side «no» to a binding question
  // closes the card as a decline»). After the commit, for the post the rep
  // quoted — the one every thread act resolves its target from.
  // ...AND A CARD THE TURN ANSWERED BY ITS ID, the proposal card the rep
  // accepted or discarded in their own words (ticket #386; Codex r1): an open
  // canvas would otherwise go on offering its buttons.
  if (!("failed" in outcome)) {
    for (const card of outcome.settled) {
      await publishPostSettle(settleDepsOf(deps, client), card.postId, card.outcome, false);
    }
  }
  const quoted = asked?.quotedPostId;
  const settledWord = "failed" in outcome ? undefined : SETTLE_OF_MARKER[outcome.marked];
  if (quoted !== undefined && settledWord !== undefined) {
    await publishSettle(
      settleDepsOf(deps, client),
      { delivery: quoted },
      settledWord,
      // THE TWIN'S OWN ACT, on the rep's word in its turn — not the rep's act
      // on the card, so the thread hears it and is not woken by it.
      false,
    );
  }
}

/**
 * WHAT THE OPEN PAGE IS TOLD AFTER A THREAD TURN COMMITTED (tickets #266,
 * #320): `curated`, carrying the arrival's line or its absence, a line said
 * unasked, and the current curation when the turn wrote one. Nothing on this
 * path changes the turn's aftermath — the page reads the same from its next
 * canvas read.
 */
async function tellTheCanvas(
  client: pg.PoolClient,
  deps: TwinRuntimeDeps,
  run: ThreadRun,
  ended: {
    readonly failed: boolean;
    readonly moved: boolean;
    readonly spotlit: boolean;
    readonly knocked: boolean;
    readonly spoke: boolean;
    readonly lined: boolean;
  },
  answers: readonly string[],
): Promise<void> {
  const events = deps.events;
  const seatId = run.seatId;
  if (events === undefined || seatId === undefined) return;
  const arrivalId = run.trigger.kind === "arrival" ? run.trigger.arrivalId : undefined;
  const pickId = run.pickId;
  const selectionId = run.selectionId;
  const summonsId = run.summonsId;
  const feed = {
    db: client,
    twinId: deps.twinId,
    dek: deps.dek,
    timeZone: run.timeZone,
    bundle: deps.bundle,
  };
  if (ended.knocked) {
    // A CARD THE TURN KNOCKED, AGAIN, WITH ITS KNOCK: the page already drew it
    // without one, and the first-day permission ask reads the sentence off
    // the card it holds (`canvas-client.tsx`).
    try {
      const rows = await client.query<{ post_id: string }>(
        "SELECT post_id FROM post_knocks WHERE twin_id = $1 AND execution_id = $2",
        [deps.twinId, run.executionId],
      );
      const posts = await readPostsByIds(feed, rows.rows.map((row) => row.post_id), new Date());
      const onCanvas = posts.size === 0 ? new Set<string>() : await readOnCanvas(feed, new Date());
      for (const post of posts.values()) {
        events.publish(seatId, { kind: "arrived", post: feedPostOnTheWire(post, onCanvas) });
      }
    } catch {
      // The page's next canvas read carries the knock.
    }
  }
  // AN ARRIVAL, A PICK, A SELECTION AND A SUMMONS ALWAYS HEAR HOW THEIR TURN
  // ENDED, its line or nothing: the page is waiting on it (tickets #320, #335,
  // #341, #340).
  const waited =
    arrivalId !== undefined || pickId !== undefined || selectionId !== undefined || summonsId !== undefined;
  if (!waited && !ended.moved && !ended.spotlit && !ended.lined && !ended.spoke) return;
  try {
    const read = ended.lined
      ? await readLastLine(feed, {
          seatId,
          // ANY LINE BUT AN ARRIVAL'S IS THE ONE ITS OWN TURN WROTE (tickets
          // #341, #380): the seat's latest unasked line may be a later
          // turn's, and the bar binds this turn's choice to the line it carries.
          ...(arrivalId === undefined ? { executionId: run.executionId } : { arrivalId }),
        })
      : undefined;
    // THE CURATION ONLY WHEN THIS TURN WROTE IT (ticket #380): the page takes
    // its spotlight as where this turn's words point, so one an earlier turn
    // wrote never rides on a later turn's ending.
    const curation = ended.moved ? await readCuration(feed, { executionId: run.executionId }) : undefined;
    // ...AND THE SPOTLIGHT, WHEN THIS TURN WROTE ONE: the card held up now, or none.
    const spotlight = ended.spotlit ? await readSpotlight(feed, new Date()) : undefined;
    // ITS NAMES OPEN THE CARDS THE TWIN WROTE BESIDE THEM, while they are on
    // the canvas (ticket #401).
    const onCanvas = await readOnCanvas(feed, new Date());
    const line = read;
    // THE SENTENCE THIS TURN SAID ON A CARD, its mentions linked as a line's.
    const said = ended.spoke ? await readNote(feed, run.executionId) : undefined;
    const note = said;
    events.publish(seatId, {
      kind: "curated",
      ...(arrivalId === undefined ? {} : { arrivalId }),
      ...(pickId === undefined ? {} : { pickId }),
      ...(selectionId === undefined ? {} : { selectionId }),
      ...(summonsId === undefined ? {} : { summonsId }),
      ...(line === undefined ? {} : { arrival: arrivalOnTheWire(line, onCanvas) }),
      ...(note === undefined ? {} : { note: noteOnTheWire(note, onCanvas) }),
      ...(curation === undefined ? {} : { curation: curationOnTheWire(curation) }),
      ...(ended.spotlit ? { spotlit: spotlight === undefined ? null : spotlightOnTheWire(spotlight) } : {}),
      ...(answers.length === 0 ? {} : { answers }),
    });
  } catch {
    // The page's next canvas read carries what this would have said.
  }
}

/**
 * WHAT THE OPEN PAGE IS TOLD WHEN THE TWIN'S NOTES MOVED (ticket #322; spec
 * #318 decision 32): `noted`, carrying the open matters as they now stand, so
 * an open bar holds them without a read.
 */
async function tellTheNotes(
  client: pg.ClientBase,
  deps: TwinRuntimeDeps,
  run: ThreadRun,
  before: number,
): Promise<void> {
  const events = deps.events;
  const seatId = run.seatId;
  if (events === undefined || seatId === undefined) return;
  const now = deps.bundle.readWorkingMemory();
  if (now === undefined || now.version === before) return;
  try {
    const matters = await openMattersOnTheWire(
      {
        db: client,
        twinId: deps.twinId,
        dek: deps.dek,
        timeZone: run.timeZone,
        bundle: deps.bundle,
        selfChatJid: deps.selfChatJid,
      },
      now,
    );
    events.publish(seatId, { kind: "noted", ...matters });
  } catch {
    // The page's next open-matters read carries what this would have said.
  }
}

/**
 * THE ARRIVAL WAS ANSWERED (tickets #266, #320): its marker, naming the thread
 * turn that answered it, in that turn's own transaction — a line or none, the
 * arrival is composed for once.
 */
async function markArrival(
  client: pg.ClientBase,
  twinId: string,
  arrivalId: string,
  executionId: string,
): Promise<void> {
  await client.query(
    `INSERT INTO rep_arrival_executions (arrival_id, twin_id, execution_id)
     VALUES ($1, $2, $3)`,
    [arrivalId, twinId, executionId],
  );
}

/**
 * ...and a pick's, a selection's or a summons' (ticket #358), in the door's
 * vocabulary: an ask is answered, met with silence, acted on or failed
 * exactly as a line typed in the bar is.
 */
async function markAsk(
  client: pg.ClientBase,
  twinId: string,
  askId: string,
  disposition: Disposition,
): Promise<void> {
  await client.query(
    "INSERT INTO rep_ask_processing (ask_id, twin_id, disposition) VALUES ($1, $2, $3)",
    [askId, twinId, disposition],
  );
}

/** A folded line's own trigger and the seat it is told on, narrowed to a message. */
interface FoldedLine {
  readonly trigger: TwinThreadMessageTrigger;
  readonly seatId?: string;
}

/**
 * THE MARKER EACH FOLDED LINE TAKES (ticket #319): `folded` when its turn left
 * the rep something, and the owner's own word when it left nothing — a silent
 * turn's lines are all silence to the bar's history, which keeps none of them
 * (`leftTheRepNothing`).
 */
function foldedMarker(owner: Disposition, isOwner: boolean): Disposition {
  return isOwner || leftTheRepNothing(owner) ? owner : "folded";
}

/** Marks every folded line of a turn that ended with `owner`. */
async function markFolded(
  client: pg.ClientBase,
  deps: TwinRuntimeDeps,
  folded: readonly FoldedLine[],
  owner: Disposition,
): Promise<void> {
  for (const line of folded) {
    await markThreadMessage(client, deps, line.trigger, foldedMarker(owner, false));
  }
}

/**
 * The first folded line per door the owner's reply did not already reach —
 * one reply per door, never one per line.
 */
function firstFoldedPerDoor(
  folded: readonly FoldedLine[],
  ownerDoor: TwinThreadMessageTrigger["door"] | undefined,
): readonly FoldedLine[] {
  const reached = new Set(ownerDoor === undefined ? [] : [ownerDoor]);
  const first: FoldedLine[] = [];
  for (const line of folded) {
    if (reached.has(line.trigger.door)) continue;
    reached.add(line.trigger.door);
    first.push(line);
  }
  return first;
}

/** What telling a settled card needs, off the runtime's deps and one connection. */
function settleDepsOf(deps: TwinRuntimeDeps, db: pg.ClientBase): SettleDeps {
  return {
    db,
    twinId: deps.twinId,
    ...(deps.events === undefined ? {} : { events: deps.events }),
    ...(deps.threadSessions === undefined ? {} : { thread: deps.threadSessions }),
  };
}

/**
 * Which thread markers settle the card the rep quoted, and with what word
 * (ticket #266). A retraction is not here: it takes back one numbered line
 * and the thread's marker does not say which, so an open canvas learns it on
 * its next read rather than from a word it cannot place.
 */
const SETTLE_OF_MARKER: Readonly<Partial<Record<Disposition, SettleOutcome>>> = {
  dismissed: "dismissed",
  declined: "declined",
};

/**
 * HOW A COMMITTED DOOR TURN ENDED, TOLD TO ITS SEAT (ticket #263).
 *
 * `failed` when the marker is one of the two that leave the rep nothing
 * (`leftTheRepNothing`, the exchanges read's own rule, so the stream and the
 * read agree about which exchanges are kept). Otherwise `post`, carrying the
 * reply exactly as the exchanges read serves it — read back from the store
 * rather than built from the turn's words, so the text the page reconciles
 * to is the row's and nothing else's.
 */
async function tellTheDoor(
  client: pg.PoolClient,
  deps: TwinRuntimeDeps,
  door: DoorStream,
  messageId: string,
  timeZone: string,
  marked: Disposition,
): Promise<void> {
  if (leftTheRepNothing(marked)) {
    door.events.publish(door.seatId, { kind: "failed", messageId });
    return;
  }
  const replies = await readRepliesAtTheDoor(
    { db: client, twinId: deps.twinId, dek: deps.dek, timeZone },
    [messageId],
    new Date(),
  );
  const reply = replies.get(messageId);
  // ITS NAMES OPEN THE CARDS THE TWIN WROTE BESIDE THEM (ticket #401), as the
  // history's read does — so the reply the page draws from this event links
  // exactly as the one it reads back later.
  const onCanvas =
    reply === undefined
      ? new Set<string>()
      : await readOnCanvas({ db: client, twinId: deps.twinId, dek: deps.dek, timeZone, bundle: deps.bundle }, new Date());
  door.events.publish(door.seatId, {
    kind: "post",
    messageId,
    ...(reply === undefined ? {} : { reply: feedPostOnTheWire(reply, onCanvas) }),
  });
}

/**
 * WHAT THE SEAM RECORDS AND WHAT A STAND-ALONE RECEIPT POSTS, for each act
 * (ticket #174; spec #171 decision 22 — "the marker takes the act's
 * existing word" and "notice kinds stay as today").
 *
 * ONE MAP, TWO READERS, because both questions are asked of the same value
 * and two switches over one word would be two places to forget an act. It
 * is TOTAL over `ThreadAct` — the words `acts.ts` declares — so an act
 * added there without a marker and a kind fails the typecheck here.
 *
 * THE MARKERS ARE THE WORDS THE DELETED MATCHERS WROTE, unchanged: a
 * dismissal still marks `dismissed`, a retraction `retracted`, a declined
 * binding `declined`. All eighteen of the seam's words stand; none is added
 * and none is narrowed, so neither #174 nor #218 owes a migration for this
 * map — what #218 removed is three ACTS, and the seam keeps their words.
 *
 * THE NOTICE KIND HERE IS FOR A RECEIPT THAT POSTS ALONE, and that is the
 * narrower claim it makes. A turn that acted AND spoke posts one `answer`
 * notice with the receipt folded into it (`postAnswer`) — one post per turn,
 * which is spec #171 decision 22's own shape — so these kinds are read on
 * the other branch: the twin acted and had nothing to say. There the act's
 * own kind is used, so `dismissal_ack` is still the kind a bare «Descartado»
 * posts under and a reader of `notices` sees the word they saw before.
 *
 * A declined binding never had a kind — it said nothing at all — and the
 * kinds are a CHECK this map does not widen, so it takes one that exists.
 *
 * `binding_ack` FOR A DECLINE is the one needing an argument. It reads as
 * "the twin acknowledged the binding ceremony's answer", and both a
 * confirmation and a decline are answers to it: the kind names the
 * ceremony, the receipt says which way it went. `answer` would put a
 * decline in a different row kind from the confirmation beside it for no
 * reason a reader could use.
 */
const THREAD_ACTS: Readonly<
  Record<
    ThreadAct,
    {
      readonly marker: Disposition;
      /**
       * The kind a STAND-ALONE receipt posts under — absent for the one act
       * whose own output is the post (ticket #175). `create_draft` renders
       * no receipt, because the Borrador it wrote is the acknowledgement,
       * so there is nothing for a kind to carry; the render site throws if
       * a receipt ever arrives with no kind, so the pair cannot silently
       * drop a line the rep was owed.
       */
      readonly notice?: NoticeKind;
    }
  >
> = {
  dismissed: { marker: "dismissed", notice: "dismissal_ack" },
  binding_declined: { marker: "declined", notice: "binding_ack" },
  retracted: { marker: "retracted", notice: "correction_ack" },
  correction_refused: {
    marker: "correction_refused",
    notice: "correction_refusal",
  },
  // THE REP TAUGHT THE TWIN SOMETHING (ticket #260). The marker is
  // `answered` — the same word a turn with no act takes — because that is
  // what happened to the rep's MESSAGE: the twin read it and replied. The
  // notebook is twin-side memory the seam has no vocabulary for and needs
  // none; the write's own record is the execution, naming the tool and its
  // arguments, with the execution's chain entry beside it (ADR-0020). So the
  // seam's eighteen stand and this ticket owes no migration. The notice kind
  // is `answer` for the same reason: a turn that taught and said nothing
  // still owes the receipt, and that post IS the twin's answer to what the
  // rep told it.
  notepad_written: { marker: "answered", notice: "answer" },
  // A REP-INITIATED DRAFT (ticket #175). The marker is `drafted`, which is
  // the seam's own word for exactly this and already in its eighteen — so
  // this ticket owes no migration either, and the drafting invariant
  // holds unchanged: one `drafted` marker per draft, on the event
  // `drafts.in_reply_to_event_id` names, which here is the rep's own
  // message. NO NOTICE KIND, because the act posted the Borrador itself.
  drafted: { marker: "drafted" },
  // THE REP ANSWERED A RUN'S CARD IN THEIR OWN WORDS (ticket #324): marked
  // `answered`, as a taught notebook is, and the turn's reply is the post.
  ask_answered: { marker: "answered", notice: "answer" },
  // THE REP ACCEPTED OR DISCARDED A RUTINA'S PROPOSAL CARD IN THEIR OWN WORDS
  // (ticket #386): marked `answered`, as a run's card answered in prose is.
  proposal_answered: { marker: "answered", notice: "answer" },
};

/**
 * THE WORDS A THREAD TOOL RECORDS FOR THE TWIN'S OWN DOINGS rather than for a
 * rep's act (tickets #320 and #322): a knock, a spotlight, a rewrite of its
 * own notes — and a run started, steered, paused or cancelled (ticket #323),
 * disclosed on Trabajos en curso rather than evidenced by the rep's message;
 * and a rutina written (tickets #325, #386), disclosed on Rutinas or waiting
 * on its proposal card; and a run's question card (ticket #324), which only a run's step
 * posts; and a binding question handed to the rep (ticket #363), which the
 * rep's own answer settles; and a file written into its workspace (ticket
 * #326), which the snapshot versions. They mark no message and claim no act.
 */
const TWIN_OWN_ACT_WORDS = [
  ...PRESENCE_ACT_WORDS,
  WORKING_MEMORY_ACT,
  WROTE_ACT,
  ...RUN_ACT_WORDS,
  ...AUTOMATION_ACT_WORDS,
  ASK_ACT,
  BINDING_PROPOSED_ACT,
] as const;

/**
 * THE RECEIPT A REWRITE OF THE TWIN'S NOTES OWES THE REP, when one does
 * (ticket #322): the tool renders it only when the model said the rep's own
 * message asked for the change, and it folds into the reply where no rep act
 * already holds the receipt line.
 */
function notedReceipt(effects: readonly EffectOutcome[]): string | undefined {
  for (const effect of effects) {
    if (effect.performed && effect.act === WORKING_MEMORY_ACT && effect.receipt !== undefined) {
      return effect.receipt;
    }
  }
  return undefined;
}

/**
 * The act one thread execution performed or refused, read back out of the
 * runtime's opaque word — or nothing, when no tool acted.
 *
 * A LOUD THROW ON A WORD NOTHING DECLARES, because `EffectOutcome.act` is a
 * `string` by the time it crosses `@dito/execution` (which holds no seam
 * and must not learn one), and the alternative to checking it here is
 * handing an undeclared word to `markProcessed`, where the CHECK constraint
 * rejects it and takes the whole transaction — the record, the chain entry
 * and the post — down with it.
 */
function threadAct(
  effects: readonly EffectOutcome[],
): { readonly outcome: EffectOutcome; readonly act: ThreadAct } | undefined {
  // `ActSlot` allows one CALL, and a second is refused with no word of its
  // own, so the first outcome carrying one is this turn's act.
  // A KNOCK AND A SPOTLIGHT ARE THE TWIN'S PRESENCE, NOT A REP'S ACT (ticket
  // #320), and its own notes are its own (ticket #322): none of them marks a
  // message, and only the notes may fold a receipt (`notedReceipt`).
  const outcome = effects.find(
    (effect) =>
      effect.act !== undefined &&
      !(TWIN_OWN_ACT_WORDS as readonly string[]).includes(effect.act),
  );
  if (outcome === undefined) return undefined;
  const word = outcome.act!;
  if (!Object.hasOwn(THREAD_ACTS, word)) {
    throw new Error(
      `a thread tool reported the act "${word}", which is not one of ${THREAD_ACT_WORDS.join(", ")} — every act a tool records needs a seam marker and a notice kind (ticket #174)`,
    );
  }
  return { outcome, act: word as ThreadAct };
}

/** The answering half's own deps, over this execution's borrowed connection. */
function answeringDeps(
  client: pg.ClientBase,
  deps: TwinRuntimeDeps,
): AnsweringDeps {
  return {
    db: client,
    bundle: deps.bundle,
    dek: deps.dek,
    twinId: deps.twinId,
    selfChatJid: deps.selfChatJid,
  };
}

/**
 * Runs one execution on a connection of its own, borrowed for exactly as long
 * as it needs one (ticket #173; spec #171 decision 3).
 *
 * THE BORROW AND THE RELEASE LIVE HERE AND NOWHERE ELSE, so no execution can
 * forget the second one — a leaked connection is a pool that empties over
 * hours and a runtime that stops drafting for reasons nothing logs.
 *
 * WHY A SEPARATE CONNECTION AT ALL is argued in full in `lanes.ts`: the
 * transaction is open across the model call, and `pg` queues per client, so
 * two executions sharing one would issue statements into each other's
 * transaction with no error anywhere.
 */
async function withExecutionClient(
  deps: TwinRuntimeDeps,
  run: (client: pg.PoolClient) => Promise<void>,
): Promise<void> {
  const client = await deps.executionPool.connect();
  try {
    await run(client);
  } finally {
    client.release();
  }
}

/**
 * Settles one customer chat's turn (ticket #75): decides whether the chat
 * has gone quiet enough to answer, and if so runs the ONE execution that
 * answers everything unanswered in it.
 *
 * FOUR OUTCOMES, and each one either marks every event it decided or marks
 * none of them:
 *   — SUPERSEDED. The rep already replied in this chat, so the messages
 *     that predate their reply are answered and a draft for them would be
 *     churn by definition (decision 2). Marked `answered_by_rep`.
 *   — DEFERRED. The chat is still inside its settle window and under the
 *     ceiling. Nothing is marked, nothing is called, and the next pass
 *     asks again — which is what makes the wait survive a restart.
 *   — DRAFTED, or judged to need no answer. One execution over the whole
 *     turn, and every event of the batch marked in its transaction.
 *   — FAILED. The execution failed.
 *     Its record and its chain entry commit, and every event of the turn is
 *     marked `execution_failed` in the same transaction — so the turn is
 *     consumed exactly once and the pass carries on (ticket #240; the ruling
 *     on boundary #225, F1, where #172 AC 8 left them pending and stopped).
 *
 * NOTHING ABOUT #75 CHANGED HERE, and that is the ticket's first
 * acceptance criterion: the settle predicate, the ceiling, the
 * forty-message bound, the rep-already-replied supersession, one
 * transaction per turn and the anchor's `drafted` beside the rest's
 * `drafted_in_batch` are all as they were. What moved is what happens
 * after the predicate says yes.
 */
async function settleTurn(
  deps: TwinRuntimeDeps,
  pass: Pass,
  chatJid: string,
  arrived: readonly TurnMessage[],
): Promise<void> {
  // DRAFTING «EN PAUSA» ON RUTINAS (tickets #325, #364): its row's switch,
  // read through the gate's own question; no execution — the messages are in
  // twin memory and marked `captured`, the seam's word for a message nothing
  // drafted, so turning the switch back on drafts none of them.
  const drafting = await shippedAutomationOf(deps.db, deps.twinId, "drafting");
  if (drafting !== undefined && (await automationPaused(deps.db, drafting.seatId, drafting.id))) {
    await markAll(deps, arrived.map((m) => m.event.id), "captured");
    pass.tally.consumed += arrived.length;
    return;
  }
  // ONE bundle read for the whole decision: the chat as twin memory holds
  // it right now, the messages of this turn included (routing ingested
  // them). It answers both questions below — has the rep spoken, and what
  // is the recent transcript — in one consistent view.
  const conversation = deps.bundle.readConversation(chatJid);

  // DECISION 2: the rep answering BY HAND closes the turn. #63 put the
  // twin's own sends into twin memory alongside the messages the rep types
  // on their own phone, so "has the rep already answered this?" is finally
  // a question the bundle can answer — and if they have, drafting a reply
  // to what they answered is exactly the churn this ticket exists to
  // remove. Per message, not per turn: only what the rep's reply provably
  // came after is superseded, so anything said afterwards still earns its
  // draft.
  const repLastRepliedAt = await lastHandTypedReplyAt(deps, conversation, arrived);
  const batch: TurnMessage[] = [];
  const superseded: TurnMessage[] = [];
  for (const message of arrived) {
    const before =
      repLastRepliedAt !== undefined && message.row.occurredAt < repLastRepliedAt;
    (before ? superseded : batch).push(message);
  }
  if (superseded.length > 0) {
    await markAll(deps, superseded.map((m) => m.event.id), "answered_by_rep");
    pass.tally.consumed += superseded.length;
  }
  if (batch.length === 0) return;

  // THE SETTLE PREDICATE, over timestamps Postgres supplied (see
  // `waited_ms`): quiet since the NEWEST arrival, bounded by the age of the
  // OLDEST. No timer, no in-memory state — a runtime that restarts mid-wait
  // re-reads exactly the same two numbers and reaches the same answer.
  const waits = batch.map((message) => message.event.waited_ms);
  const quietFor = Math.min(...waits);
  const oldestWait = Math.max(...waits);
  const settled =
    quietFor >= (deps.settleWindowMs ?? SETTLE_WINDOW_MS) ||
    oldestWait >= (deps.batchCeilingMs ?? BATCH_CEILING_MS);
  if (!settled) return;

  // From here the turn IS being answered, so this is when the runtime
  // picked it up — the instant NFR-2's ~1-minute budget is measured from
  // (ADR-0016). Everything before it is the settle window, which is a
  // product wait rather than latency.
  const runtimeSeenAt = new Date();
  // Conversation order, which is the order the model must read them in;
  // seam order is arrival order and the two can differ when delivery is
  // out of order. The LAST is the anchor: the message that closed the
  // turn, whose chat instant is the draft's provenance and whose event the
  // draft records as the one it replies to.
  batch.sort(byChatOrder);
  // A turn longer than the bound is more than one turn (see
  // MAX_TURN_MESSAGES): the oldest are answered now, the rest settle next
  // pass. Nothing is dropped and nothing is drafted twice — the split is
  // just a second turn.
  if (batch.length > MAX_TURN_MESSAGES) batch.length = MAX_TURN_MESSAGES;
  const anchor = batch[batch.length - 1]!;

  const history = conversation.slice(
    -(deps.historyLimit ?? DEFAULT_HISTORY_LIMIT),
  );
  // The recent window carries the turn's own messages (they are in the
  // bundle), and they must not appear twice under two headings — once as
  // settled transcript and once as the thing to answer is exactly the
  // conflation AC 3 forbids. So the transcript is the window MINUS the
  // turn, and the turn travels in its own labelled block.
  const turnMessageIds = new Set(batch.map((m) => m.row.messageId));
  // Gestures are composed against the target twin memory holds right now,
  // never against what it held when the gesture was consumed (#97).
  const chatHistory = renderGesturesForModel(
    deps.bundle,
    history.filter((row) => !turnMessageIds.has(row.messageId)),
  );
  // Context-aware drafting (ticket #35; spec #29 decision 11, story 18):
  // the draft stops being amnesiac. Alongside the RECENT window, the
  // turn's own words retrieve what this chat's history holds that is
  // relevant to it — the promise made last month, the price agreed in
  // June — through the same retrieval the Q&A uses. The query is the whole
  // turn, because half a request retrieves against half the question.
  //
  // Scoped to THIS chat, always: an unscoped retrieval could write one
  // customer's draft out of another customer's conversation. The scope is
  // vec0 partition pruning inside the bundle (#32), not a filter here.
  //
  // Rows the model is already being shown are dropped: sending the same
  // line twice under two headings teaches it nothing and spends budget.
  //
  // BOTH headings, not just the transcript (Codex r1). The turn's own
  // messages are its nearest neighbours by construction, and a turn longer
  // than the recent window has members OUTSIDE it — which would come back
  // as retrieval hits and be rendered under «older context, not the latest
  // turns» while also standing under NEW. That is precisely the conflation
  // the labelling exists to prevent, so the exclusion is the union.
  const alreadyShown = new Set([
    ...history.map((row) => row.messageId),
    ...turnMessageIds,
  ]);
  const retrievalLimit = deps.retrievalLimit ?? DEFAULT_RETRIEVAL_LIMIT;
  const retrieved = (
    await retrieveRelevantMessages({
      bundle: deps.bundle,
      embedder: deps.embedder,
      query: batch.map((message) => message.row.content).join("\n"),
      chatJid,
      // Ask for the limit PLUS everything already shown, because the dedupe
      // below can discard every row of a page. What the model already has
      // is exactly what ranks highest against a fresh turn — the messages
      // just exchanged echo its wording — so a page sized to the limit
      // alone could be entirely dropped, leaving the old promise this
      // retrieval exists to surface outside the result (Codex r1, #35).
      // Widening by the excluded count means at most `alreadyShown.size`
      // rows can be discarded, so `retrievalLimit` survivors are always
      // reachable.
      limit: retrievalLimit + alreadyShown.size,
    })
  )
    .map((hit) => hit.message)
    .filter((row) => !alreadyShown.has(row.messageId))
    .slice(0, retrievalLimit);
  // AFTER the dedupe and the slice, never before: dealing gestures into
  // their own slots can only swap rows that BOTH survived the cut, so a
  // lone gesture never moves into a slot its partner was ranked into
  // (#109, Codex r3). Relevance still chooses WHICH rows; this only fixes
  // the order of two gestures of one second against each other, where the
  // ranking has nothing to say and a removal could otherwise precede its
  // set.
  const retrievedContext = renderGesturesForModel(
    deps.bundle,
    inDeliveryOrder(retrieved, (row) => row),
  );

  // The counterparty name with bindings in the picture (ticket #34): the
  // rep-confirmed name unmarked when the chat is bound — read through the
  // bundle API only — provisional «(sin confirmar)» push-name (number
  // when absent) until then. Ceremony never blocks the draft.
  //
  // READ BEFORE THE EXECUTION RATHER THAN AFTER IT (ticket #172). The
  // execution is TOLD who this chat is and whether the question is due
  // (spec #171 decision 17: "code decides it is due … and says so in
  // context"), so both have to be known before the definition is built.
  // Neither depends on what the model decides, and the `bindingQuestionAsked`
  // sweep is the same read the draft path has always made.
  const binding = deps.bundle.readChatBinding(chatJid);
  // TWO NAMES OUT OF ONE BINDING, and the difference is who reads them
  // (ticket #172, the two-axis review's Spec axis).
  //
  // `postName` is the REP-FACING rendering: the one binding-aware naming
  // rule, which marks an unconfirmed name «(sin confirmar)» — a FRAME
  // LABEL, and ADR-0037's amendment keeps those in code as the rep side's
  // chrome. It goes into the frozen post and nowhere else.
  //
  // `contextName` is what the EXECUTION is told, and it carries no mark:
  // the `chat_binding` recipe says whether the name is confirmed in its own
  // words, so the mark would be the same fact twice — and the second time
  // in a language the instructions deliberately do not use. What the model
  // gets is the name; what it does with an unconfirmed one is the recipe's
  // sentence to make.
  //
  // Both are SENDER-SCOPED, like the push-name itself (AC 2: "the sender
  // push-name, falling back to the number"): in a DM sender and chat
  // coincide, but the fallback names the person being answered, never the
  // room (Codex round 1 on #34).
  const postName = counterpartyName({
    confirmedName: binding?.displayName,
    pushName: anchor.payload.pushName,
    senderJid: anchor.payload.senderJid,
  });
  const contextName =
    binding?.displayName ??
    counterpartyDisplayName(anchor.payload.pushName, anchor.payload.senderJid);
  // Binding birth, lazy and once-ever (ticket #34; spec #29 grilling
  // decision 3): this draft needs a {cliente}, so an unbound chat gets
  // its ONE framed question — proposed from the push-name, so a payload
  // without one has nothing to propose and the ceremony waits for the
  // first name-needing draft that carries one. The committed question
  // notice IS the asked-state (one store, atomic with this draft and the
  // marker — no two-store crash window), which is what makes "ever" hold
  // across restarts and replays.
  const proposedName =
    binding === undefined &&
    anchor.payload.pushName !== undefined &&
    !(await bindingQuestionAsked(deps, chatJid))
      ? anchor.payload.pushName
      : undefined;

  // THE SEAT'S ZONE, RESOLVED ONCE (ticket #172; #30's remainder 4).
  // `deps.timeZone` is optional — unset means the host clock, which is
  // what the rig runs on without `DITO_TIME_ZONE` and what the suites pin
  // — and the `now` recipe requires an IANA name, so the resolution
  // happens here and the SAME value renders the model's «now» and the
  // frozen post's clock time. Two renderings of one instant that could
  // disagree about the hour is #139's founding complaint.
  const timeZone =
    deps.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

  const eventIds = batch.map((message) => message.event.id);
  // THE OCCASION AND THE MECHANISM COME OFF THE WAKE, not restated here: the
  // engine refuses a trigger that disagrees, and this is where the ids the
  // occasion binds are added to them.
  const trigger: ChatTurnTrigger = {
    kind: DRAFTING_WAKE.occasion,
    mechanism: DRAFTING_WAKE.mechanism,
    twinId: deps.twinId,
    chatJid,
    // Named rather than re-derived from `eventIds` order (Codex review):
    // the row `drafts.in_reply_to_event_id` points at, the one marker
    // that may say 'drafted' and the event the audit reference names are
    // the same event, decided in ONE place.
    anchorEventId: anchor.event.id,
    eventIds,
  };

  const run: DraftingRun = {
    trigger,
    executionId: randomUUID(),
    eventIds,
    anchor,
    destination: chatJid,
    counterparty: postName,
    // When the TURN began — its oldest arrival, so the number the rig
    // reads includes the settle window rather than hiding it.
    eventReceivedAt: earliestArrival(batch),
    runtimeSeenAt,
    timeZone,
    ...(proposedName === undefined ? {} : { proposedName }),
    shown: {
      counterparty: contextName,
      bindingConfirmed: binding !== undefined,
      // The classification target is this turn, named explicitly — never
      // inferred from transcript position (delivery can be out of order).
      turn: batch.map((message) => message.row),
      transcript: chatHistory,
      memories: retrievedContext,
    },
  };
  // HANDED TO THE LANE RATHER THAN AWAITED (ticket #173): concurrently with
  // whatever else this pass submitted, on a connection of its own, settled at
  // the end of the pass.
  //
  // WHAT IT CONSUMED IS COUNTED WHERE IT COMMITS, for the reason the tally
  // exists: an execution whose transaction is GONE marks nothing, because
  // every write it would have made was inside it, and counting the turn here
  // would report a consumption that never happened. A `failed` execution marks
  // its turn (ticket #240) and reaches this line normally, `drafted` zero.
  pass.lane.submit(async () => {
    await withExecutionClient(deps, async (client) => {
      const drafted = await runDraftingExecution(client, deps, run);
      pass.tally.consumed += eventIds.length;
      pass.tally.drafted += drafted;
    });
  });
}

/** What one drafting turn needs beyond drafting's own definition. */
interface DraftingRun {
  readonly trigger: ChatTurnTrigger;
  /** Minted before the turn: the draft, its timing row and the question name it. */
  readonly executionId: string;
  readonly eventIds: readonly string[];
  readonly anchor: TurnMessage;
  readonly destination: string;
  /** The counterparty as the REP reads them — marked when unconfirmed. */
  readonly counterparty: string;
  readonly eventReceivedAt: Date;
  readonly runtimeSeenAt: Date;
  readonly timeZone: string;
  /** The name a rep's yes would confirm, when the question is due. */
  readonly proposedName?: string;
  /**
   * WHAT THE TURN IS SHOWN, read before the lane (`DraftingDeps` argues why):
   * who the chat is — UNMARKED, the `chat_binding` recipe says in its own
   * words whether the name is confirmed — the turn, the window, the memories.
   */
  readonly shown: Pick<DraftingDeps, "counterparty" | "bindingConfirmed" | "turn" | "transcript" | "memories">;
}

/**
 * Marks every event of a turn with ONE outcome, in the caller's transaction.
 *
 * A TURN GETS ONE VERDICT OR NONE (ticket #75; ticket #240 for the second
 * caller). Both of the endings that decide a whole turn without drafting —
 * the model judging it to need no answer, and an execution that failed —
 * are one verdict about one turn, so leaving any of its
 * events unmarked would put the model back in front of messages it has
 * already been asked about. The primary key on `wa_event_processing` is what
 * makes "marked twice" unreachable rather than careful.
 */
async function markTurn(
  client: pg.ClientBase,
  deps: TwinRuntimeDeps,
  eventIds: readonly string[],
  disposition: Disposition,
): Promise<void> {
  for (const eventId of eventIds) {
    await markProcessed(client, deps, eventId, disposition);
  }
}

/** The twin a draft belongs to, and where its post goes (`drafts.ts`'s `DraftTwin`). */
function draftTwinOf(deps: TwinRuntimeDeps): DraftTwin {
  return {
    twinId: deps.twinId,
    selfChatJid: deps.selfChatJid,
    dek: deps.dek,
    ...(deps.timeZone === undefined ? {} : { timeZone: deps.timeZone }),
  };
}

/**
 * ONE DRAFTING EXECUTION, END TO END (ticket #172; spec #171 decision 12;
 * ADR-0020).
 *
 * ONE TRANSACTION, AND EVERYTHING IN IT. The runner appends this
 * execution's one content-free chain entry before it returns or throws,
 * fail-closed — "a record with no entry is exactly the hole ADR-0020's
 * coverage check exists to find" — and the remaining gap, an entry with no
 * record, is closed here by the rule `chainApertureAct` states for the
 * aperture: the act and its audit link commit together or not at all. So
 * the entry, the record, the draft, its `system_send`, its timing, the
 * optional binding question and every one of the turn's processing markers
 * are one commit.
 *
 * THE EXECUTION'S OWN ENDING IS CAUGHT INSIDE THE TRANSACTION, and that
 * placement is the whole point. The runner has already appended the entry when
 * it throws; letting the throw escape `withDbTransaction` would ROLL THAT
 * ENTRY BACK, leaving a run that happened with no trace at all. Caught here,
 * the record is written beside the entry the same run wrote and the
 * transaction commits. Anything else — a chain that would not accept the
 * entry, a definition the runner refused, a store that would not write —
 * takes the whole thing down with it, which is correct: nothing
 * half-written, nothing chained with no record. `isExecutionFailure` is where
 * that line is drawn, once, for both of the realtime lane's model-driven
 * occasions.
 *
 * A `failed` RUN DRAFTS NOTHING AND MARKS ITS WHOLE TURN (ticket #240). Every
 * event of the turn takes `execution_failed`, in the same commit as the record
 * and the entry — one verdict about a turn, one transaction, which is the rule
 * the `no_answer_needed` arm below follows for the same reason — so the turn
 * is consumed exactly once and the rep's chat is not re-read on the next poll.
 * The marker is what bounds the spend at one paid attempt per turn, which is
 * why it is not optional.
 *
 * WHAT IT COSTS, recorded rather than discovered: a turn that failed for a
 * reason that would have passed a moment later gets no draft and no second
 * attempt, and the rep is told nothing about it — the ONE place a rep-visible
 * consequence is silent. A bounded retry needs a durable attempt count this
 * runtime does not have (#240; the remainder #172 recorded).
 */
async function runDraftingExecution(
  client: pg.PoolClient,
  deps: TwinRuntimeDeps,
  run: DraftingRun,
): Promise<number> {
  const drafted = new DraftSlot();
  const twin = draftTwinOf(deps);
  const outcome = await withDbTransaction(client, async () => {
    // THE TURN, THROUGH THE ONE ENGINE (ticket #363): drafting's definition on
    // a single call of its own, its search scoped to this chat and its draft
    // written into it, bound to this transaction's connection. The engine
    // records the turn — one record, one entry — and a failed turn has rolled
    // back what its tools wrote by the time it comes back.
    const ran = await executeStep(
      { harness: deps.harness, db: client, twinId: deps.twinId, hmacKey: deps.hmacKey },
      {
        definition: DRAFTING_DEFINITION,
        conversation: {
          kind: "drafting",
          deps: {
            ...run.shown,
            bundle: deps.bundle,
            embedder: deps.embedder,
            chatJid: run.destination,
            bindingQuestionDue: run.proposedName !== undefined,
            ...(run.proposedName === undefined ? {} : { proposedName: run.proposedName }),
            repLanguage: deps.repLanguage ?? DEFAULT_REP_LANGUAGE,
            timeZone: run.timeZone,
            db: client,
            ...twin,
            executionId: run.executionId,
            anchor: { eventId: run.anchor.event.id },
            counterpartyShown: run.counterparty,
            reference: deps.bundle.referenceForChat(run.destination),
            drafted,
          },
        },
        inputs: {},
        trigger: run.trigger,
        wake: DRAFTING_WAKE,
        lane: "realtime",
        executionId: run.executionId,
        now: run.runtimeSeenAt,
        model: deps.drafting.model,
        ...traceFor(deps.trace, run.trigger),
      },
    );
    // NFR-2'S THIRD INSTANT IS THE TURN'S END, never the tool call's: the
    // draft the rep can tap is the one the finished turn commits.
    const draftReadyAt = new Date();
    if (ran.settlement.disposition === "failed") {
      // ...AND THE WHOLE TURN IS CONSUMED (ticket #240), in the same commit.
      await markTurn(client, deps, run.eventIds, "execution_failed");
      return { drafted: 0 };
    }
    const draft = drafted.draft;
    if (draft === undefined) {
      // The whole turn was judged to need no answer: the twin wrote no draft.
      await markTurn(client, deps, run.eventIds, "no_answer_needed");
      return { drafted: 0 };
    }
    // THE DRAFT LANDS WITH THE TURN'S WORDS (ticket #368): the sentence the
    // card carries above it and the thread's line above the Borrador, its
    // customer named by reference and rendered by code. Written here, after
    // the record, because the post is immutable and the words exist only now.
    const words = ran.settlement.words.trim();
    await landDraft(client, twin, draft.held, {
      words,
      mentions: mentionsIn(words, customersOf(deps.bundle, deps.selfChatJid)),
    });
    // THE CEREMONY'S ONCE-EVER RULE, RE-CHECKED UNDER THE LOCK (ticket #173).
    // `proposedName` was decided before the turn, from a read taken outside
    // any transaction, and two executions run in one pass (`lanes.ts`): a
    // settled turn for an unbound chat and a thread answer asking about that
    // same chat would both have read "unasked" before either committed, and
    // the rep would be asked twice, permanently, because a notice is
    // immutable. THE LOCK IS TAKEN AFTER THE TURN'S CHAIN APPEND, which is the
    // order every execution takes the two in (`takeBindingCeremonyLock`
    // argues why that makes it deadlock-free).
    let proposedName = run.proposedName;
    if (proposedName !== undefined) {
      await takeBindingCeremonyLock(client, deps.twinId);
      if (await bindingQuestionAsked({ db: client, dek: deps.dek, twinId: deps.twinId }, run.destination)) {
        proposedName = undefined;
      }
    }
    // THE TWIN COMPOSES THE QUESTION AND CODE RENDERS THE FRAME (spec #171
    // decision 17) — and CODE ASKS ANYWAY WHEN THE TWIN COMPOSED NOTHING,
    // because ceremony never blocks the draft (#34; spec #29 grilling
    // decision 3): a chat that is never asked about never binds.
    if (proposedName !== undefined) {
      await postBindingQuestion(client, twin, {
        aboutEventId: run.anchor.event.id,
        proposedName,
        ...(draft.bindingQuestion === undefined ? {} : { sentence: draft.bindingQuestion }),
        executionId: run.executionId,
      });
    }
    // THE DRAFT'S TIMING ROW, after the record it references (`recordDraftTiming`).
    await recordDraftTiming(client, {
      draftId: draft.held.id,
      executionId: run.executionId,
      eventReceivedAt: run.eventReceivedAt,
      runtimeSeenAt: run.runtimeSeenAt,
      draftReadyAt,
    });
    // ONE 'drafted' MARKER PER DRAFT. The anchor carries it and is the row
    // `drafts.in_reply_to_event_id` names; the rest carry 'drafted_in_batch',
    // so the seam's own count of drafts keeps matching the drafts table.
    for (const eventId of run.eventIds) {
      await markProcessed(client, deps, eventId, eventId === run.anchor.event.id ? "drafted" : "drafted_in_batch");
    }
    return { drafted: 1 };
  });
  return outcome.drafted;
}

/**
 * When the rep last answered this chat BY HAND — undefined when they have
 * not, which is the common case.
 *
 * Own-sent rows in twin memory have two origins since ticket #63, and only
 * one of them is a rep reply. A message the rep typed on their own phone
 * is one. A message the TWIN sent, captured back after the rep tapped a
 * draft, is not — and counting it here loses messages (Codex r1, confirmed
 * independently by the spec review). The reachable case: the twin posts a
 * draft for turn A; the customer sends m2 while the rep is deciding; the
 * rep taps A; the executor's send lands with an instant AFTER m2, and m2 —
 * which that draft could not possibly have answered, because it was frozen
 * before m2 existed — would be marked answered and never drafted. That is
 * exactly the message the ticket's late-arrival criterion protects.
 *
 * Excluding twin sends is not merely safer, it is exact: every message
 * still pending when a tapped draft lands arrived after that draft was
 * composed, because the draft's own batch was marked at emission. So a
 * twin send can never be the answer to anything this function is asked
 * about.
 *
 * `send_executions` is the discriminator — the executor writes one row per
 * send it makes, carrying the rail's own message id, which is the id #63's
 * capture stores. Deterministic, rep-side, and nothing model-produced.
 *
 * Only own-sent rows NEWER than the oldest message of this turn can matter
 * (an older one supersedes nothing), so the lookup is bounded by what has
 * happened since the turn began rather than by the age of the chat.
 */
async function lastHandTypedReplyAt(
  deps: TwinRuntimeDeps,
  conversation: readonly ConversationRow[],
  turn: readonly TurnMessage[],
): Promise<string | undefined> {
  const turnBeganAt = turn.reduce(
    (oldest, message) =>
      message.row.occurredAt < oldest ? message.row.occurredAt : oldest,
    turn[0]!.row.occurredAt,
  );
  const candidates = conversation.filter(
    (row) =>
      row.fromMe &&
      row.occurredAt > turnBeganAt &&
      // NEITHER A GESTURE NOR A DELIVERY THE TWIN COULD NOT READ IS A REPLY
      // (tickets #97 and #124). A rep's own 👍 — or their own photo — lands
      // in twin memory as an own-sent row in the customer chat, so without
      // this it reads exactly like a hand-typed answer and would mark the
      // whole turn `answered_by_rep`. That would SUPPRESS the draft the row
      // is not allowed to trigger, which is a trigger-policy change nobody
      // decided: ADR-0041 and ADR-0042 both rule on OPENING a turn, and
      // ADR-0042 says a customer-chat opaque row "ingests as context only".
      //
      // THE OPAQUE CLASS DECIDED IT (Codex r2), and the argument is the
      // class rather than the photo. «A photo of the price list is an
      // answer» is true and is about ONE member of a class that also holds
      // revokes, stickers, undecryptable deliveries and MALFORMED
      // REACTIONS — and that last one is decisive: the same tap would
      // suppress a draft or not depending on whether the rail delivered
      // the reaction well enough for the plane to type it. Rail luck must
      // not decide whether the rep is offered a draft. Reading a kind here
      // instead would be a per-shape exception, which ADR-0042 forbids:
      // the way a kind earns its own behaviour is promotion into a typed
      // event, and that is where «this shape answers a turn» belongs.
      row.reactionTo === undefined &&
      row.opaqueKind === undefined,
  );
  if (candidates.length === 0) return undefined;
  const twinSent = await deps.db.query<{ wa_message_id: string }>(
    `SELECT wa_message_id FROM send_executions
      WHERE twin_id = $1 AND wa_message_id = ANY($2::text[])`,
    [deps.twinId, candidates.map((row) => row.messageId)],
  );
  const sentByTwin = new Set(twinSent.rows.map((row) => row.wa_message_id));
  let latest: string | undefined;
  for (const row of candidates) {
    if (sentByTwin.has(row.messageId)) continue;
    if (latest === undefined || row.occurredAt > latest) latest = row.occurredAt;
  }
  return latest;
}

/** Conversation order for a turn: chat instant, seam order breaking ties. */
function byChatOrder(a: TurnMessage, b: TurnMessage): number {
  if (a.row.occurredAt !== b.row.occurredAt) {
    return a.row.occurredAt < b.row.occurredAt ? -1 : 1;
  }
  return BigInt(a.event.id) < BigInt(b.event.id) ? -1 : 1;
}

/** The instant the seam first saw anything in this turn. */
function earliestArrival(batch: readonly TurnMessage[]): Date {
  return new Date(
    Math.min(...batch.map((message) => message.event.received_at.getTime())),
  );
}

/**
 * What one rep's «va» settles BEFORE anything is classified (ticket #34,
 * split at #176).
 *
 * The binding that stands after the confirmation, and the kind the Ledger
 * already carries for it when it carries one. Both are read on the runtime's
 * own connection, in phase-1 routing, synchronously — which is what lets the
 * classification go to the lane without the two racing.
 */
interface ConfirmedBinding {
  /** The binding that STANDS, which is what the ack names (#49). */
  readonly binding: ChatBinding;
  /** A kind already filed for this entity — then there is nothing to classify. */
  readonly standingKind?: EntityKind;
}

/**
 * Confirms the binding a quoted yes on a binding-question post means
 * (ticket #34): chat and display name re-derived from the question's
 * source event — the values the rep was actually shown — the entity
 * minted at confirmation (#31's mirror contract), written only through
 * the bundle API. An already-bound chat is left exactly as first
 * confirmed (repeat yes, or the crash-replay between mirror write and
 * marker).
 *
 * THE BUNDLE WRITE STAYS HERE AND STAYS SYNCHRONOUS (ticket #176). It is the
 * one step of the ceremony that is neither a model call nor Postgres: a
 * SQLCipher write through the bundle API, idempotent on the chat, and the
 * rest of the pass depends on it being visible — a turn settling for this
 * same chat later in the pass reads the binding it just made. Moving it into
 * the execution would make "is this chat bound" answer differently depending
 * on which lane slot the classification got.
 *
 * Two stores with no shared transaction, so the ORDER is the contract and
 * both steps are idempotent: the bundle write first (a chat the rep
 * confirmed is bound even if the crossing fails and the pass stops loudly),
 * then the aperture — replayed on the SAME id, so a crash between them files
 * the entity on the next yes rather than losing it. The binding therefore
 * cannot be re-read as "already done, nothing to file".
 *
 * Returns the binding that STANDS after this call, so the ack (#49) names
 * what the twin actually stored rather than what the question proposed —
 * the two differ on exactly the replay and repeat-yes paths above.
 */
async function confirmBindingFromQuestion(
  deps: TwinRuntimeDeps,
  questionEventId: string,
  /** When the plane stamped that yes — the binding's valid time. */
  confirmedAt: Date,
): Promise<ConfirmedBinding> {
  // THE BUNDLE WRITE IS `rep-acts.ts`', shared with the dashboard's «Sí, es
  // este cliente» (#224): one function decides what confirming a binding IS,
  // so the two surfaces cannot mint a chat's entity two different ways.
  const confirmed = await confirmBinding(
    {
      db: deps.db,
      dek: deps.dek,
      twinId: deps.twinId,
      hmacKey: deps.hmacKey,
      bundle: deps.bundle,
    },
    { aboutEventId: questionEventId, confirmedAt },
  );
  if (confirmed.outcome === "refused") {
    // A REFUSAL IS A BROKEN SEAM ON THIS PATH, never something to skip past,
    // and it stays a THROW here rather than becoming one there. The shared act
    // returns a value because the dashboard's transaction has a receipt and a
    // chain entry to commit; this caller is the router, whose doctrine for a
    // seam that disagrees with itself is to stop — the question's own event is
    // missing, or it carries no push-name, and the ceremony proposes only from
    // push-names (#34).
    throw new Error(
      `binding question anchored on wa_events row ${questionEventId} could not be read for this twin — a broken seam, never something to skip past (ticket #34)`,
    );
  }
  const binding = confirmed.binding;

  // WHETHER THERE IS ANYTHING TO CLASSIFY AT ALL (Codex r2 on #60, kept
  // exactly). A replay — a repeat «va», or a crash between the crossing's
  // commit and this event's processing marker — finds the entity already
  // filed, and the aperture would discard a fresh determination anyway
  // (`standingCreateFor`: the standing one stands, which is what keeps a
  // human's correction safe). So asking again buys nothing and costs
  // something real: with the model unreachable, a crash in that window
  // would wedge the consumer on an event whose crossing had already landed.
  //
  // The scope is the aperture's own answer, off this twin's Ledger grants
  // (ADR-0035: a caller never supplies its own company). A twin with no
  // grants has bound nothing yet, so there is nothing standing to find.
  const standing = await standingEntityKind(
    { db: deps.db, dek: deps.dek, hmacKey: deps.hmacKey },
    deps.twinId,
    binding.entityId,
  );
  return {
    binding,
    ...(standing === undefined ? {} : { standingKind: standing }),
  };
}

/**
 * The crossing (ticket #50): the minted id goes to the Ledger UNCHANGED
 * through the aperture, which files the entity and its disclosure line in
 * one transaction.
 *
 * THE CONNECTION IS A PARAMETER SINCE #176, and it is explicit at both call
 * sites for the reason `markProcessed`'s is: a crossing filed beside a
 * classification goes on the connection that execution borrowed, so it
 * commits with the record, the chain entry, the ack and the marker; a
 * crossing on the replay path — where no execution exists — goes on the
 * runtime's own, in the aperture's own unit of work, exactly as it did
 * before this ticket.
 */
async function fileBindingCrossing(
  deps: TwinRuntimeDeps,
  db: pg.ClientBase,
  args: {
    readonly binding: ChatBinding;
    readonly kind: EntityKind;
    /** The rep's own yes — the class-2 rep-act evidence (ADR-0003). */
    readonly repAct: RepActEvidence;
  },
): Promise<void> {
  await fileEntityCreate(
    // The aperture is a separate database ROLE (`dito_aperture`, migration
    // 20260829100012) but not yet a separate CONNECTION: nothing in this
    // repo authenticates as an application role — every process still
    // connects as the schema owner. The grant audit is what makes the
    // single-writer claim real today; the day application roles get
    // credentials, this is where the aperture's own client arrives, and
    // nothing else about the crossing changes.
    { db, dek: deps.dek, hmacKey: deps.hmacKey },
    {
      twinId: deps.twinId,
      entityId: args.binding.entityId,
      kind: args.kind,
      displayName: args.binding.displayName,
      // No createdAt here on purpose: the aperture takes valid time off
      // the verified rep act itself, so the Ledger cannot record a
      // confirmation time a caller chose.
      evidence: args.repAct,
      disclosureText: renderEntityCreateDisclosureLine(),
    },
  );
}

/**
 * The ack (#49; #36 finding 2): the twin says out loud that the confirmation
 * landed. Notice + its system_send + the marker commit together, so a crash
 * can never leave a confirmation silently acked — and because the ack rides
 * the MARKER rather than the mirror write or the crossing, a replay still
 * delivers it exactly once. It names what was STORED, so a repeat yes reads
 * back the binding that stands rather than the name it re-proposed.
 *
 * WHETHER IT OPENS ITS OWN TRANSACTION IS THE CALLER'S (ticket #176). On the
 * replay path there is no execution, so it takes one; inside a
 * classification the whole run is already one transaction and a second
 * `BEGIN` there would commit somebody else's half-written work
 * (`db-tx.ts`: no nesting, deliberately).
 */
async function ackBindingConfirmation(
  deps: TwinRuntimeDeps,
  db: pg.ClientBase,
  args: { readonly eventId: string; readonly displayName: string },
): Promise<void> {
  await insertNoticeWithSystemSend(db, {
    twinId: deps.twinId,
    selfChatJid: deps.selfChatJid,
    dek: deps.dek,
    kind: "binding_ack",
    aboutEventId: args.eventId,
    post: composeReceiptPost(bindingAckReceipt(args.displayName)),
  });
  await markProcessed(db, deps, args.eventId, "binding_confirmed");
}

/**
 * HANDS ONE KIND CLASSIFICATION TO THE REALTIME LANE (ticket #176; spec #171
 * decisions 3 and 26; ADR-0010 as amended).
 *
 * WHY THE LANE AT ALL. The harness ran inline in phase-1 routing, on the
 * runtime's sequential connection, so while one binding's kind was being
 * decided every other pending event of the pass waited behind it — the exact
 * stall #173's lanes removed for drafting and the twin thread. `lanes.ts`'s
 * own header has named entity kind a realtime occupant since that ticket;
 * this is what puts it there.
 *
 * NOTHING THE MODEL IS SHOWN IS READ HERE, and it does not need to be: the
 * bundle is a synchronous SQLCipher connection, so the conversation
 * `classifyBinding` reads inside the lane is read atomically against every
 * other statement the pass issues. The thread's two reads happen before the
 * lane because they are POSTGRES reads on the runtime's own client, which is
 * a different constraint.
 */
function submitEntityKindExecution(
  deps: TwinRuntimeDeps,
  pass: Pass,
  args: {
    readonly binding: ChatBinding;
    readonly repAct: RepActEvidence;
    /** The rep's own «va» — what gets marked when the crossing commits. */
    readonly eventId: string;
    /** The event the question is about — how its card is named to the canvas (#266). */
    readonly questionEventId: string;
  },
): void {
  pass.lane.submit(async () => {
    await withExecutionClient(deps, async (client) => {
      await runEntityKindExecution(client, deps, args);
    });
    pass.tally.consumed += 1;
  });
}

/**
 * ONE KIND CLASSIFICATION, END TO END (ticket #176; spec #171 decision 12;
 * ADR-0020).
 *
 * ONE TRANSACTION, AND EVERYTHING IN IT — the shape #172 established for
 * drafting. The runner appends this execution's one content-free chain entry
 * before it returns or throws, fail-closed, and the remaining gap — an entry
 * with no record — is closed here by the rule `chainApertureAct` states for
 * the aperture: the act and its audit link commit together or not at all. So
 * the entry, the record, the entity create with its disclosure line, the
 * binding ack, its `system_send` and the rep's own event marker are ONE
 * commit.
 *
 * NO SAVEPOINT AROUND THE RUN, unlike the thread's, and the difference is
 * that this automation has no tools: nothing writes anything before the
 * runner returns, so a refused run has no effects to roll back and the entry
 * the runner already appended is simply kept.
 *
 * NO MARKER ON A REFUSED RUN, so the rep's «va» stays pending and the next
 * pass replays it — which is exactly what the harness's uncaught throw left
 * behind, minus the part where nothing recorded that it had happened. The
 * replay is idempotent because the bundle binding is already written
 * (`confirmBindingFromQuestion`) and the standing-kind read finds nothing, so
 * the classification is simply asked again.
 *
 * AND NOTHING IS FILED ON A REFUSAL, which is the rule this call site has
 * always had and the reason it fail-stops: "filing `person` on a failed model
 * call would put the default nobody chose straight back into the column". The
 * rethrow reaches the lane's `settle`, which is what stops the pass.
 *
 * ═══ THE ONE REALTIME OCCASION THAT STILL STOPS THE LOOP ═══
 *
 * Drafting's executions and the thread's consume their trigger when they fail,
 * so a row the model cannot finish is recorded and left behind rather than
 * stopping the runtime (`execution-failure.ts`). This one cannot take that
 * shape, and the obstacle is the MARKER rather than the throw. Both halves are
 * checkable and both are hazards, so both are written down.
 *
 * THE SEAM MARKER IS THE CROSSING'S ONLY EVIDENCE. `crossPendingBindings` —
 * the sweep that files every uncrossed binding at each start — resolves which
 * rep act confirmed a chat by selecting `wa_event_processing` rows whose
 * disposition is `binding_confirmed` and reading the quoted question out of
 * their payload (`resolveConfirmations`). Consuming this event under
 * `execution_failed` therefore makes the rep's yes unresolvable and loses the
 * crossing until they confirm again. And `binding_confirmed` is not available
 * either: audit coverage's `entity_create` class joins exactly that
 * disposition against the chain PER ACT, so writing it with nothing filed
 * leaves the invariant red — a marker claiming an act whose entry does not
 * exist.
 *
 * WHAT THE STOP COSTS, said plainly rather than left for a reader to find: a
 * model call the provider refuses during a kind classification takes this
 * whole process down, the rep's «va» stays pending, and the next start meets
 * it and can go the same way. That is the shape ticket #240 exists to remove,
 * and this is where it is not removed.
 *
 * WHAT WOULD REMOVE IT is a per-process bound on the attempt, deliberately in
 * memory so a restart is a fresh attempt — which lets the event stay pending
 * without the pass paying for the same classification every two seconds. This runtime
 * keeps no such count for a realtime occasion (#240), so the stop stands.
 */
async function runEntityKindExecution(
  client: pg.PoolClient,
  deps: TwinRuntimeDeps,
  run: {
    readonly binding: ChatBinding;
    readonly repAct: RepActEvidence;
    readonly eventId: string;
    readonly questionEventId: string;
  },
): Promise<void> {
  const outcome = await withDbTransaction(client, () =>
    classifyBinding(
      {
        harness: deps.harness,
        db: client,
        bundle: deps.bundle,
        twinId: deps.twinId,
        hmacKey: deps.hmacKey,
        executionId: randomUUID(),
        // ADR-0015 as amended: this rung is its own and is never derived
        // from extraction's (#148, #154). `kindModelOf` is the one resolver,
        // shared with the startup backlog.
        model: kindModelOf(deps).model,
        ...(deps.timeZone === undefined ? {} : { timeZone: deps.timeZone }),
        // THE RUNTIME'S OWN CALLBACK, not one bound to a trigger: this helper
        // builds the trigger itself, off its wake, so it calls `traceFor` on
        // the far side rather than being handed the result.
        ...(deps.trace === undefined ? {} : { trace: deps.trace }),
      },
      run.binding,
    ).then(async (classification) => {
      if (!classified(classification)) return classification;
      await fileBindingCrossing(deps, client, {
        binding: run.binding,
        kind: classification.kind,
        repAct: run.repAct,
      });
      await ackBindingConfirmation(deps, client, {
        eventId: run.eventId,
        displayName: run.binding.displayName,
      });
      return classification;
    }),
  );
  if (!classified(outcome)) {
    // FAIL-STOP, AFTER THE TRACE IS DURABLE — and the one realtime occasion
    // that keeps it (the header argues why #240 could not take it off this
    // one). The record and its entry are committed, the crossing did not
    // happen, and the event is still pending.
    throw outcome.refused;
  }
  // THE QUESTION'S CARD SETTLES ON THE CANVAS, after the crossing and the
  // ack committed (ticket #266).
  await publishSettle(
    settleDepsOf(deps, client),
    { question: run.questionEventId },
    "confirmed",
    true,
  );
}


/**
 * The kind this entity already carries, if it has already crossed (ticket
 * #60). Undefined when nothing stands under that id — a first confirmation,
 * or the replay of a crash BEFORE the crossing committed — which is when
 * the model is asked.
 */
async function standingEntityKind(
  ctx: RepActContext,
  twinId: string,
  entityId: string,
): Promise<EntityKind | undefined> {
  for (const companyId of await readTwinCompanies(ctx, twinId)) {
    const filed = await readFiledEntity(ctx, { companyId, entityId });
    if (filed !== undefined) return filed.kind;
  }
  return undefined;
}

/**
 * Marks several events with ONE disposition, in one transaction: a verdict
 * that covers a whole turn commits for all of it or for none of it.
 */
async function markAll(
  deps: TwinRuntimeDeps,
  eventIds: readonly string[],
  disposition: Disposition,
): Promise<void> {
  // ON THE RUNTIME'S OWN CONNECTION: this is the SEQUENTIAL half of the pass
  // (the supersession the settle predicate decides), not an execution's
  // effect.
  await withDbTransaction(deps.db, async () => {
    for (const eventId of eventIds) {
      await markProcessed(deps.db, deps, eventId, disposition);
    }
  });
}

/**
 * One event's outcome, recorded.
 *
 * THE CONNECTION IS THE FIRST PARAMETER SINCE #173, and it is explicit at
 * every call site on purpose. A marker written by a sequential route goes to
 * the runtime's own client; a marker written by an execution goes to the
 * connection that execution borrowed, because it has to commit with that
 * execution's record and chain entry (ADR-0020) — and reaching for `deps.db`
 * from inside an execution would put the marker in a different transaction
 * from the post it accounts for. Making the caller name the connection is
 * what turns that into something a reader can check line by line.
 */
async function markProcessed(
  client: pg.ClientBase,
  deps: TwinRuntimeDeps,
  eventId: string,
  disposition: Disposition,
): Promise<void> {
  await client.query(
    "INSERT INTO wa_event_processing (event_id, twin_id, disposition) VALUES ($1, $2, $3)",
    [eventId, deps.twinId, disposition],
  );
}

/**
 * ...and one MESSAGE's outcome, on whichever door it arrived through (ticket
 * #261).
 *
 * THE TRIGGER SAYS WHICH TABLE, which is the same rule the evidence gate
 * follows one package over: the row that created the run is the row that gets
 * marked, and the record of which store it lives in belongs to the trigger
 * rather than to a guess at the shape of an id. One vocabulary across both —
 * a door message that is answered marks `answered` exactly as a self-chat one
 * does — so the seam's word set is not forked by a second door.
 */
async function markThreadMessage(
  client: pg.ClientBase,
  deps: TwinRuntimeDeps,
  trigger: TwinThreadMessageTrigger,
  disposition: Disposition,
): Promise<void> {
  if (trigger.door === "twin_thread") {
    await markProcessed(client, deps, trigger.eventId, disposition);
    return;
  }
  await client.query(
    `INSERT INTO dashboard_message_processing (message_id, twin_id, disposition)
     VALUES ($1, $2, $3)`,
    [trigger.eventId, deps.twinId, disposition],
  );
}

