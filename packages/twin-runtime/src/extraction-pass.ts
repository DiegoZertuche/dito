/**
 * The daily per-chat extraction pass (ticket #52; spec #48 grilling
 * decisions 1, 4, 5, 6 and 13; ADR-0003, ADR-0004, ADR-0016, ADR-0033,
 * ADR-0035, ADR-0041).
 *
 * Once a day, after the traffic has settled, the twin reads the day's
 * conversations in the rep's BOUND customer chats and pulls out the
 * objective business facts. Everything it finds goes through the aperture
 * from #50 and appears in the disclosure from #51 with no change to either.
 *
 * ADR-0033 IS MECHANIZED HERE, NOT FILTERED. This pass ENUMERATES bound,
 * in-scope customer chats, so the twin thread is structurally never among
 * its inputs — it is not removed by a filter a later slice can drop. Two
 * independent properties put it out of reach: the self-chat is never in
 * `scope_allowlist` (the plane special-cases it as in-scope rather than
 * writing a row), and it can never be BOUND, because a binding is the rep
 * confirming which customer a chat belongs to and the twin thread is not a
 * customer. `assertNotSelfChat` below is the belt: it REFUSES rather than
 * removes, so a later widening of the input fails loudly instead of quietly
 * disclosing the rep's own notes to their employer.
 *
 * THE WINDOW IS THE DAY, AND THE WATERMARK KEEPS IT TRUE. A day-shaped
 * window alone loses traffic every evening — the pass runs at the settle
 * hour, marks the day filed, and everything said between then and midnight
 * falls in a window no run reads again. So a chat's window runs from where
 * it was last READ THROUGH to now, its first one starting at the day's own
 * midnight (which is what keeps backfilled history out), bounded below at
 * yesterday's midnight so a rig that was off for a month never turns one
 * pass into a month-long backfill.
 *
 * BATCH-SHAPED, NOT THE BATCH API (spec #48 decision 1). The run is an
 * `extraction_runs` row carrying a state, not a synchronous function call.
 * `submitted` lasts one ordinary API call today and would last until a poll
 * with the real Batch API; neither the aperture nor the disclosure can tell
 * the difference. That deferral is recorded on #6.
 *
 * A RUN OF ITS OWN, FIRED BY THE CLOCK (ticket #364; ADR-0014 as amended
 * 2026-10-07). Extraction is one of Dito's automations: the clock fires its
 * definition (`extraction/definition.ts`) at the rep's disclosure hour when
 * the precondition holds, and the run's first step claims the day here
 * (`claimChatDays`), its `each` hands every claim to a child whose agent step
 * reads it and files through `file_facts` (`openChatDay`), and its last step
 * settles what no child filed and climbs the merge ladder (`settleChatDays`).
 * The run's steps go on the batch lane, off NFR-2's path.
 *
 * RESTART-SAFE AND IDEMPOTENT PER (twin, chat, day). Claiming a chat-day and
 * filing its facts are two transactions with the model call between them, so
 * a crash mid-call leaves `submitted` and the run, resumed, reads the claim
 * again; the filing re-checks the state it claimed, so the loser of a race
 * discards its candidates rather than filing them twice. The guarantee is
 * `extraction_runs_one_per_twin_chat_day` and the state re-check.
 *
 * ...AND THE RIG CAN BE STEERED THROUGH TIME (ticket #67; #57 findings 4
 * and 5). Two overrides, both rig tooling, both absent from the clock's
 * read: a steering session may re-read a chat whose day is already filed,
 * and it may move the rep's clock without moving the watermark. See
 * `ExtractionSteering`. The production rule that the clock's read reads a
 * chat once a day is still the database's — the unique index is now
 * partial over the rows that pass writes, and it is the same rule on the
 * same columns.
 */
import {
  fileCandidateFact,
  readTwinCompanies,
  runMergeMatcher,
} from "@dito/aperture";
import { foldOpaqueDeliveries, inDeliveryOrder } from "@dito/bundle";
import type { Bundle } from "@dito/bundle";
import type { Dek } from "@dito/crypto";
import type { Embedder } from "./embedder.js";
import type { Harness } from "@dito/execution";
import {
  decodeWaMessagePayload,
  decodeWaOpaquePayload,
  decodeWaReactionPayload,
} from "@dito/seam";
import type { ConversationRow } from "@dito/bundle";
import type pg from "pg";
import type { RuntimeTrace } from "./trace-render.js";
import { bindingQuestionAsked } from "./answering.js";
import { takeDailyPassLock } from "./db-tx.js";
import type { ExtractionDeps } from "./extraction/deps.js";
import type { CandidateFact, CandidateFacts, FilingOutcome } from "./extraction/file-facts.js";
import type { ExtractionCounts, ExtractionFiling } from "./extraction/filing.js";
import { ServedReads } from "./extraction/served.js";
import { renderFactDisclosureLine } from "./grammar.js";
import { composeBindingQuestionPost } from "./posts.js";
import type { ModelCallConfig } from "./model-config.js";
import { insertNoticeWithSystemSend } from "./notices.js";
import { opaqueConversationRow } from "./opaque.js";
import { renderGesturesForModel, renderReactionGesture } from "./reactions.js";
import { civilDate, earliestWindowStart, startOfCivilDay } from "./rep-clock.js";

export interface DailyExtractionDeps {
  /**
   * The connection the read runs on: inside an extraction run, the step's
   * own, whose transaction commits the claims, the facts and the step's
   * record together (`runs/run-reads.ts`); the clock's precondition reads on
   * the pass's.
   */
  readonly db: pg.ClientBase;
  /**
   * Where a run's steps take their own connections from (ADR-0010 as
   * amended): the hand trigger drives the run through the engine, which
   * borrows one per step.
   */
  readonly executionPool: pg.Pool;
  readonly harness: Harness;
  /**
   * The bundle's entity mirror is where BOUND lives (ADR-0004: chat↔entity
   * bindings are rep-side only) — and therefore where extraction's input
   * set comes from. That is the ADR-0033 mechanization: a chat with no
   * binding has no entity, and a fact with no entity has nowhere to go
   * (FR-32, absolute).
   */
  readonly bundle: Bundle;
  /**
   * The embedder boundary (#32) — what `search_chat_history` embeds its query
   * through (ticket #196).
   *
   * REQUIRED, not optional, and that is the fail-closed direction: an
   * extraction that cannot search is one whose looking rule is a sentence in
   * a prompt with nothing behind it, and every candidate that needed a
   * resolution would be dropped with no signal anywhere. A missing embedder
   * is a deployment mistake, and the honest place to catch a deployment
   * mistake is the typecheck. The runtime's own deps already carry one, so
   * the loop's call site is unchanged.
   */
  readonly embedder: Embedder;
  readonly dek: Dek;
  /**
   * The chain key. Required because this pass RUNS THE MERGE MATCHER, and a
   * machine merge is audit-chained (ADR-0020, ADR-0035) — the aperture's
   * write path asks for the key in its signature precisely so a caller that
   * cannot chain cannot merge by accident.
   */
  readonly hmacKey: Uint8Array;
  readonly twinId: string;
  /**
   * The rep's own thread. Used ONLY to refuse — never to filter a list that
   * would otherwise contain it (see `assertNotSelfChat`).
   */
  readonly selfChatJid: string;
  /** Model config for the drafting call site (ADR-0015). */
  readonly drafting: ModelCallConfig;
  /**
   * Model config for the EXTRACTION call site, when a composition root
   * routes it separately. ADR-0015 as amended gives extraction its own rung
   * and its own overrides (`DITO_EXTRACTION_MODEL`, `DITO_EXTRACTION_EFFORT`);
   * absent, it falls back to `drafting`, which is what a deployment that
   * routes one rung means.
   */
  readonly extraction?: ModelCallConfig;
  /** The rep's own clock — what "the day" means, and where its edges are. */
  readonly timeZone?: string;
  /**
   * How many rows of the chat's own history the extraction is shown before
   * the window (default `DEFAULT_TRANSCRIPT_LIMIT`).
   *
   * DRAFTING'S OWN LIMIT AND ITS OWN RECIPE (spec #193 decision 16). The
   * harness showed the day and nothing before it, so a customer's «lo de
   * siempre» had no history to sit against at all; the transcript is the
   * shared `recent_transcript` part and the number is the one the consumer
   * already uses. Here for the reason the consumer's is — so a suite can set
   * it without a code change.
   */
  readonly historyLimit?: number;
  /**
   * The hour of the rep's day, 0–23, at which the clock fires the day's
   * extraction and then its disclosure (`shipped-automations.ts`).
   */
  readonly disclosureHour?: number;
  /**
   * Where each step's per-call trace goes, if anywhere (#177 hotfix 1) — the
   * rig's debug view of one run, never a log.
   */
  readonly trace?: RuntimeTrace;
}

/** One chat extraction may read, with the customer it is bound to. */
interface BoundChat {
  readonly chatJid: string;
  readonly entityId: string;
  readonly displayName: string;
}

/**
 * One BEAT of the day, with the seam row it came from — what somebody
 * said, or what they tapped (ticket #98; ADR-0041). A gesture is a beat
 * like any other: `row.reactionTo` is what tells the two apart.
 */
interface WindowBeat {
  readonly eventId: string;
  readonly row: ConversationRow;
}

/**
 * How far short of the caller's `now` a window is cut, so a seam row that
 * commits after this pass's read is next window's rather than nobody's.
 *
 * EXPORTED because the extraction-precision corpus (#56) has to know where
 * this pass stops reading: a labeled message after the cut is seeded, never
 * read and never scored, while the report goes on claiming it. That corpus
 * mirrored the value for one round and Codex was right that a mirror drifts
 * in the unsafe direction the day this number grows.
 */
export const SEAM_SETTLING_LAG_MS = 60_000;

/**
 * How many rows of the chat's own history an extraction is shown before the
 * window — the consumer's number, for the recipe they share.
 *
 * TWENTY, AND IT IS DRAFTING'S (spec #193 decision 16). A second constant
 * would be a second answer to one question, and the part itself is shared
 * (`chat-context.ts`), so the limit that fills it is too.
 */
export const DEFAULT_TRANSCRIPT_LIMIT = 20;

/**
 * WHAT AN `extraction_runs` ROW MAY SAY, argued in this one place (ticket
 * #194; spec #193 decision 28).
 *
 * `migration-vocabulary.test.ts` holds the store's CHECK to this list, so a
 * state the pass settles and the store refuses is caught in CI rather than
 * after a model call — and for `failed`, after the execution's chain entry is
 * already on an append-only chain.
 *
 * `submitted` — claimed and handed to an execution; nothing is filed. A crash
 *   here re-runs the chat, because the model call is pure and the filing has
 *   not happened.
 * `filed` — the candidates the aperture accepted are filed with their
 *   disclosure lines. TERMINAL for the day.
 * `deferred` — in scope with traffic but UNBOUND, so it got the binding
 *   proposal and no execution (FR-32; spec #193 decision 9). Settled for the
 *   day's disclosure, and re-attempted by the next run.
 * `failed` — the read filed nothing through `file_facts`. Also
 *   terminal for the day: the chat is not read again until tomorrow's window
 *   reaches back over it.
 */
export const EXTRACTION_RUN_STATES = [
  "submitted",
  "filed",
  "deferred",
  "failed",
] as const;

/** One of the four. */
export type ExtractionRunState = (typeof EXTRACTION_RUN_STATES)[number];

/**
 * HOW A STEERING SESSION DRIVES THIS PASS BY HAND (ticket #67).
 *
 * Rig tooling, not product. The scheduled pass never constructs this
 * object at all, so the whole of it is inert unless a hand trigger
 * explicitly sets it — which is the ticket's last and most important
 * acceptance criterion. Two of #57's five findings were about the rig's
 * own instrument rather than about the system under test, and this is
 * that instrument.
 */
export interface ExtractionSteering {
  /**
   * THE INSTANT THE SEAM IS REALLY BEING READ AT, when `now` is an
   * override that has moved the rep's clock ahead of it (#57 finding 5).
   *
   * The two are one instant in production and the pass cannot tell them
   * apart. They come apart only under a steering override, and that
   * distinction is the whole of the fix: `now` is the REP'S clock — what
   * day it is, whether the settle hour has passed, when a question expires
   * — while the watermark is a statement about THE SEAM, whose clock is
   * the real one, because `wa_events.occurred_at` is stamped by the plane
   * as messages actually arrive.
   *
   * Writing a watermark from the rep's steered clock is what deafened the
   * rig: `window_end` landed ~16 hours ahead of real time, so genuinely
   * new messages arrived BEHIND the watermark and no later window would
   * ever start early enough to read them. It had to be repaired by hand.
   */
  readonly seamNow?: Date;
  /**
   * RE-READ A CHAT WHOSE DAY IS ALREADY FILED (#57 finding 4).
   *
   * The trigger exists FOR steering sessions, and a steering session sends
   * traffic, checks the result, sends more and checks again — but the
   * day's second run reported `0 read` and everything sent after the first
   * one was invisible until the next day. Setting this reads the chat
   * again from where the last run read through, and records the re-read as
   * a STEERING RUN (see below).
   *
   * It cannot double-file: the re-read's window starts at the watermark,
   * so it is shown only the messages that arrived since.
   */
  readonly reextract?: boolean;
}

/**
 * WHAT MAKES A RUN A STEERING RUN — `extraction_runs.steering`.
 *
 * A person drove it, in one of exactly two ways: they RE-READ a day that
 * was already filed, or they ran on a MOVED CLOCK. This function answers
 * the second half; `reextract` answers the first, per chat, because a
 * re-read is only a re-read where there was something to re-read.
 *
 * IT IS A CLAIM ABOUT WHO ASKED, NOT ABOUT WHAT WAS READ, and two rules
 * follow. The production uniqueness rule does not see these rows, so a
 * hand re-read never collides with the day's own run. And the SCHEDULED
 * pass does not let them settle its day: a run keyed to a day the rep has
 * not lived through yet must not answer "is this chat's day done?" when
 * that day really arrives. Without that rule one steered run left the rig
 * blind for the whole of the day it steered into — the same silent skip
 * #57 found at the watermark, one layer up.
 *
 * The clock is MOVED when the rep's instant and the seam's differ, which
 * is the only thing a steering override can do to it. Production passes no
 * `seamNow` at all, and the rig passes the real instant when nothing is
 * set, so both answer false.
 */
function isSteeredClock(steering: ExtractionSteering, now: Date): boolean {
  return (
    steering.seamNow !== undefined &&
    steering.seamNow.getTime() !== now.getTime()
  );
}

/** A run that read nothing, so it did nothing. */
const EMPTY_RUN: ExtractionCounts = {
  messages: 0,
  candidates: 0,
  filed: 0,
  belowThreshold: 0,
  unresolvedReference: 0,
  resolvedReference: 0,
  refused: 0,
};

/** One claimed chat-day, and everything its read is built over. */
interface ClaimedRun {
  readonly runId: string;
  readonly chat: BoundChat;
  readonly day: string;
  readonly window: { start: Date; end: Date };
  readonly beats: readonly WindowBeat[];
  /** The rep's clock the run was claimed on — what a question's ~7-day life runs from. */
  readonly now: Date;
}

/** Who asked for a day's read, beyond the clock (ticket #197; `runtime-requests.ts`). */
export interface ChatDaysAsked {
  /** How a steering session is driving this read — see `ExtractionSteering`. */
  readonly steering?: ExtractionSteering;
  /** The chats asked about — one customer's — or every chat that owes the day. */
  readonly chats?: ReadonlySet<string>;
  /** The request row each claim names, when one asked (`extraction_runs.request_id`). */
  readonly requestId?: string;
  /**
   * Whether a STEERING RUN counts as settling a chat's day (ticket #67): true
   * when a person drove the read, false for the clock's, whose day is its own.
   */
  readonly countsSteeringRuns: boolean;
  /** How many chat-days one read may claim: one `each` child per chat-day. */
  readonly maxChats: number;
}

/** What the claim found: the chats with traffic, the claims to read, and what settled without one. */
export interface ChatDaysClaimed {
  /** In-scope chats with traffic in their window. */
  readonly chats: number;
  /** The claimed chat-days a model reads — one child of the extraction run each. */
  readonly claims: readonly string[];
  /** Unbound chats whose read waits for a binding (FR-32). */
  readonly deferred: number;
}

/**
 * THE EXTRACTION RUN'S FIRST STEP (ticket #364; spec #48 decisions 4 and 13;
 * spec #193 decisions 9 and 10): every in-scope chat with traffic in its
 * window whose chat-day is not settled, claimed — an `extraction_runs` row
 * `submitted` per chat-day — so the run's `each` can hand each to a child that
 * reads it. A chat with no binding gets the binding question and defers (the
 * orphan rule), and a claimed window whose only traffic was history sync
 * settles `filed` with no read; neither needs a model, so neither is a child.
 *
 * ON THE CALLER'S CONNECTION, INSIDE THE STEP'S TRANSACTION: the claims, the
 * deferrals and the step's checkpoint commit together. The daily-pass lock a
 * deferral takes is held until that commit, which is the code step's length
 * and never a model call's.
 *
 * ADR-0033 IS THE ENUMERATION: `scope_allowlist` never holds the twin thread,
 * and `assertNotSelfChat` refuses rather than removes, so a widening of the
 * input fails loudly.
 */
export async function claimChatDays(
  deps: DailyExtractionDeps,
  now: Date,
  ask: ChatDaysAsked,
): Promise<ChatDaysClaimed> {
  const steering = ask.steering ?? {};
  const day = civilDate(now, deps.timeZone);
  // Whether this whole read is running on a clock somebody moved (ticket
  // #67; see `isSteeredClock`). A re-read is decided per chat, below.
  const steeredClock = isSteeredClock(steering, now);
  const bound = new Map(deps.bundle.listChatBindings().map((b) => [b.chatJid, b]));
  const runs = await readRunStates(deps, day, ask.countsSteeringRuns);
  const watermarks = await readWatermarks(deps);
  // EVERY EDGE OF THE WINDOW IS CUT FROM ONE INSTANT, AND IT IS THE SEAM'S
  // (ticket #67; #57 finding 5): the earlier of the rep's clock and the
  // seam's, so a steered clock moves the day a run is filed under and never
  // a watermark past the messages that exist.
  const seamNow = steering.seamNow ?? now;
  const windowAt = new Date(Math.min(now.getTime(), seamNow.getTime()));
  const dayStart = startOfCivilDay(civilDate(windowAt, deps.timeZone), deps.timeZone);
  const earliest = earliestWindowStart(dayStart);
  // The seam's own settling lag (Codex r1 on #52): a row committing a breath
  // after this read lands in the next window rather than in none.
  const readThroughAt = new Date(windowAt.getTime() - SEAM_SETTLING_LAG_MS);

  let chats = 0;
  let deferred = 0;
  const claims: string[] = [];
  for (const chatJid of await readInScopeChats(deps)) {
    assertNotSelfChat(deps, chatJid, "the in-scope chat list");
    // A REQUEST MAY NAME ONE CUSTOMER (ticket #197): the enumeration is
    // narrowed, so a conversation it was not asked about is not part of its day.
    if (ask.chats !== undefined && !ask.chats.has(chatJid)) continue;
    const window = windowFor({ watermark: watermarks.get(chatJid), dayStart, earliest, now: readThroughAt });
    // A chat with nothing said in the window is not part of the day —
    // counted on the seam's plaintext, never decrypted.
    if (window === undefined || !(await hasTraffic(deps, chatJid, window))) continue;
    chats += 1;
    const state = runs.get(chatJid);
    // A DAY ALREADY FILED IS DONE — unless a steering session re-reads it
    // (ticket #67), whose window starts at the watermark and so is shown only
    // what arrived since.
    const reextracting = state === "filed" && steering.reextract === true;
    if (state === "filed" && !reextracting) continue;
    // Still unbound: settled for the day, re-attempted the moment it is bound.
    if (state === "deferred" && !bound.has(chatJid)) {
      deferred += 1;
      continue;
    }
    // A FAILED READ COSTS THE CHAT ITS DAY (spec #193 decision 10): tomorrow's
    // window reaches back over it.
    if (state === "failed") continue;
    if (claims.length >= ask.maxChats) continue;
    const runId = await claimRun(deps, chatJid, day, window, steeredClock || reextracting, ask.requestId);
    // NO CLAIM: the day's run is already `filed` or `failed`.
    if (runId === undefined) continue;
    const beats = await readWindow(deps, chatJid, window);
    if (!bound.has(chatJid)) {
      await deferChat(deps, runId, chatJid, window, beats);
      deferred += 1;
      continue;
    }
    if (beats.length === 0) {
      // NOTHING TO READ, SO NO CHILD AND NO MODEL CALL: a window whose only
      // traffic was history sync settles `filed`, which is also what makes
      // "backfilled history is not re-extracted" (spec #48 decision 13) cost
      // one row rather than a model call over an empty day.
      await settleRun(deps.db, runId, "filed", window, EMPTY_RUN);
      continue;
    }
    claims.push(runId);
  }
  return { chats, claims, deferred };
}

/** What the extraction run's last step found of its claims. */
export interface ChatDaysSettled {
  /** Facts the aperture filed across the claims. */
  readonly filed: number;
  /** Claims whose read never filed — settled `failed` here, the chat's day spent. */
  readonly failed: number;
  /** Records the merge ladder made one (ADR-0035). */
  readonly merged: number;
  /**
   * Pairs the ladder saw share a phone and left apart because the model told
   * their kinds apart (ticket #60) — the count ADR-0035's phone rung turns
   * on, reported so it is a number somebody can read.
   */
  readonly kindMismatches: number;
}

/**
 * THE EXTRACTION RUN'S LAST STEP (ticket #364; spec #193 decision 10;
 * ADR-0035, ADR-0036): every claim of the run a child never filed — its read
 * ended without calling `file_facts`, or failed — settled `failed`, so the
 * chat's day is spent and tomorrow's window reaches back over it; then, when
 * the day filed anything, the merge ladder is climbed once per company, over
 * the day's own facts, because two of the rep's conversations may now be one
 * customer and nobody is asked about it.
 *
 * THE MERGE THROWS ON A REFUSING STORE, as it always has — the step fails and
 * the run with it, and the facts already filed stay, since each child
 * committed its own.
 */
export async function settleChatDays(
  deps: DailyExtractionDeps,
  claims: readonly string[],
): Promise<ChatDaysSettled> {
  if (claims.length === 0) return { filed: 0, failed: 0, merged: 0, kindMismatches: 0 };
  const failed = await deps.db.query(
    `UPDATE extraction_runs SET state = 'failed', settled_at = clock_timestamp()
      WHERE twin_id = $1 AND id = ANY($2::uuid[]) AND state = 'submitted'`,
    [deps.twinId, claims],
  );
  const filed = await deps.db.query<{ filed: string; read: string }>(
    `SELECT coalesce(sum(filed), 0) AS filed, count(*) FILTER (WHERE state = 'filed') AS read
       FROM extraction_runs WHERE twin_id = $1 AND id = ANY($2::uuid[])`,
    [deps.twinId, claims],
  );
  let merged = 0;
  let kindMismatches = 0;
  if (Number(filed.rows[0]?.read ?? 0) > 0) {
    const ctx = { db: deps.db, dek: deps.dek, hmacKey: deps.hmacKey };
    for (const companyId of await readTwinCompanies(ctx, deps.twinId)) {
      const report = await runMergeMatcher(ctx, { companyId });
      merged += report.merged.length;
      kindMismatches += report.skipped.filter((skip) => skip.reason === "kind_mismatch").length;
    }
  }
  return { filed: Number(filed.rows[0]?.filed ?? 0), failed: failed.rowCount ?? 0, merged, kindMismatches };
}

/**
 * WHETHER THIS TWIN'S DAY HAS SETTLED, ASKED WITHOUT CLAIMING ANYTHING
 * (tickets #198, #364): the clock's question for both of the day's cadences
 * (`runs/preconditions.ts`) — whether the read has something left, and
 * whether the post may go — and a rep's request's before it starts a run.
 *
 * THE SAME CLASSIFICATION AS THE CLAIM, and deliberately the same reads: a
 * chat is part of the day when its window holds traffic, and it is settled
 * when its run says `filed` or `failed`, or `deferred` with no binding yet.
 * A second answer to "is this day done" written in the disclosure's own
 * module would be two rules that agree today, which is what `readRunStates`
 * and `windowFor` are shared to prevent.
 *
 * IT CLAIMS NOTHING AND DECRYPTS NOTHING. `hasTraffic` reads the seam's
 * plaintext metadata, so the cost is one query per in-scope chat with an
 * open window.
 */
export async function daySettled(
  deps: DailyExtractionDeps,
  /** The REP's clock: which day the runs are read under (a request may move it). */
  now: Date,
  /** The seam's own instant, when the two differ — see `claimChatDays`'s window. */
  seamNow?: Date,
): Promise<boolean> {
  const day = civilDate(now, deps.timeZone);
  const bound = new Map(
    deps.bundle.listChatBindings().map((b) => [b.chatJid, b]),
  );
  // THE SCHEDULED PASS'S OWN QUESTION, so a steering session that read a chat
  // by hand does not answer it: `countsSteeringRuns: false` is what the tick
  // asks with, and the day is settled when the runs the CLOCK owns say so.
  const runs = await readRunStates(deps, day, false);
  const watermarks = await readWatermarks(deps);
  // The window edges are the claim's, cut from the earlier of the two
  // instants for the reasons `claimChatDays` states about the ceiling and the floor.
  const windowAt = new Date(
    Math.min(now.getTime(), (seamNow ?? now).getTime()),
  );
  const dayStart = startOfCivilDay(
    civilDate(windowAt, deps.timeZone),
    deps.timeZone,
  );
  const readThroughAt = new Date(windowAt.getTime() - SEAM_SETTLING_LAG_MS);
  for (const chatJid of await readInScopeChats(deps)) {
    const window = windowFor({
      watermark: watermarks.get(chatJid),
      dayStart,
      earliest: earliestWindowStart(dayStart),
      now: readThroughAt,
    });
    if (window === undefined || !(await hasTraffic(deps, chatJid, window))) {
      continue;
    }
    const state = runs.get(chatJid);
    if (state === "filed" || state === "failed") continue;
    // A DEFERRED CHAT IS SETTLED ONLY WHILE IT IS STILL UNBOUND, which is the
    // loop's own arm: the moment the rep names the customer the next pass
    // re-attempts it, so the day is not done.
    if (state === "deferred" && !bound.has(chatJid)) continue;
    return false;
  }
  return true;
}

/**
 * The rep's in-scope chats, as the plane's capture guard defines them
 * (`scope_allowlist`, ADR-0023).
 *
 * This is the FIRST of the two reasons the twin thread cannot be an input:
 * the plane treats the self-chat as in scope STRUCTURALLY — `chat ==
 * self.ToNonAD()` short-circuits before the table is read — so no row for
 * it is ever written, and a list built from this table cannot contain it.
 */
async function readInScopeChats(
  deps: DailyExtractionDeps,
): Promise<string[]> {
  const res = await deps.db.query<{ chat_jid: string }>(
    "SELECT chat_jid FROM scope_allowlist WHERE twin_id = $1 ORDER BY chat_jid",
    [deps.twinId],
  );
  return res.rows.map((row) => row.chat_jid);
}

/**
 * What this twin's day says about each chat: whether it is settled, and
 * how.
 *
 * AGGREGATED, because a chat can now carry several runs for one day — the
 * scheduled one and whatever a steering session drove by hand (ticket
 * #67). The strongest outcome wins, which is what "is this chat's day
 * done?" has always meant: a chat that was read is read, whatever else
 * was attempted afterwards.
 *
 * ...AND SCOPED TO WHOSE RUNS COUNT. The scheduled pass asks only about
 * its own (`countsSteeringRuns: false`), so a session that steered into
 * tomorrow cannot answer this question on the rig's behalf when tomorrow
 * arrives. The hand trigger asks about everything, which is what keeps
 * "trigger it twice and the second reads nothing" true.
 */
async function readRunStates(
  deps: DailyExtractionDeps,
  day: string,
  countsSteeringRuns: boolean,
): Promise<Map<string, string>> {
  const res = await deps.db.query<{ chat_jid: string; state: string }>(
    // The order is the STRONGEST outcome first, and `failed` sits below
    // `deferred` for the reason the two differ (ticket #194): a deferred run
    // is a standing fact about the chat — nobody has named this customer —
    // and the pass reports it, while a failed one is one run that got
    // nowhere. Both are settled; only the first is worth reporting over the
    // other.
    `SELECT chat_jid,
            CASE WHEN bool_or(state = 'filed')    THEN 'filed'
                 WHEN bool_or(state = 'deferred') THEN 'deferred'
                 WHEN bool_or(state = 'failed')   THEN 'failed'
                 ELSE 'submitted' END AS state
       FROM extraction_runs
      WHERE twin_id = $1 AND extraction_day = $2
        AND ($3 OR NOT steering)
      GROUP BY chat_jid`,
    [deps.twinId, day, countsSteeringRuns],
  );
  return new Map(res.rows.map((row) => [row.chat_jid, row.state]));
}

/** Where each chat's next window should start, from what its runs record. */
interface Watermark {
  /** The end of the last window actually read through. */
  readonly readThrough: Date | undefined;
  /**
   * The start of the earliest window a run CLAIMED and never filed — a
   * `submitted` run whose process died, or a `deferred` one still waiting
   * on a binding. That window is still owed.
   */
  readonly owedFrom: Date | undefined;
}

/**
 * What each chat's runs say is still owed (Codex r1).
 *
 * Only a `filed` run advances `readThrough`: a `deferred` one never reached
 * the model, a `submitted` one died before filing, and a `failed` one reached
 * the model and came back with nothing (ticket #194) — so treating any of
 * those windows as covered would drop exactly the traffic the next run exists
 * to pick up. That is what makes spec #193 decision 10's promise true: a chat
 * whose execution failed today is read tomorrow, because its window is still
 * owed and the seven-day reach-back still covers it.
 *
 * `owedFrom` is what makes an abandoned run recoverable ACROSS DAYS. The
 * run key is (twin, chat, day), so a `submitted` row from yesterday is
 * never looked at again by yesterday's key — and without this its window
 * would simply be skipped, because today's would start at today's midnight.
 * The stale row is not abandoned bookkeeping; it is the record of what is
 * still owed. The same arm carries a chat that was DEFERRED yesterday and
 * bound this morning: its day is read rather than lost, which is the orphan
 * rule's promise (spec #48 decision 13) holding across a midnight.
 */
async function readWatermarks(
  deps: DailyExtractionDeps,
): Promise<Map<string, Watermark>> {
  const res = await deps.db.query<{
    chat_jid: string;
    read_through: Date | null;
    owed_from: Date | null;
  }>(
    `SELECT chat_jid,
            max(window_end)   FILTER (WHERE state = 'filed')  AS read_through,
            min(window_start) FILTER (WHERE state <> 'filed') AS owed_from
       FROM extraction_runs
      WHERE twin_id = $1
      GROUP BY chat_jid`,
    [deps.twinId],
  );
  return new Map(
    res.rows.map((row) => [
      row.chat_jid,
      {
        readThrough: row.read_through ?? undefined,
        owedFrom: row.owed_from ?? undefined,
      },
    ]),
  );
}

/**
 * The window one chat still owes, or undefined when it owes none.
 *
 * "THE WINDOW IS THE DAY" (spec #48 decision 13) is the RULE; the watermark
 * is what keeps it true. A day-shaped window alone loses traffic every
 * single evening: the pass runs at the settle hour, marks the day filed,
 * and the messages sent between then and midnight fall inside a window no
 * run will ever read again. So a window runs from WHERE THIS CHAT WAS LAST
 * READ THROUGH to NOW, and its first-ever window starts at the day's own
 * midnight — which is also what keeps backfilled history out (a chat's
 * first run reads the day, never its past).
 *
 * BOUNDED AT SEVEN DAYS. A rig that was off for a month would otherwise
 * hand a month of one chat to a single model call, which is a backfill
 * wearing a daily pass's clothes and is out of scope. Seven days is FR-32's
 * own expiry horizon, and it leaves ample room for the two cases a daily
 * pass really needs: the evening after its last run, and a chat that spent
 * a day waiting to be bound.
 *
 * Undefined when the window would be empty or inverted — a second run in
 * the same instant, or a watermark from a clock ahead of this one.
 */
function windowFor(bounds: {
  /** What this chat's own runs say is owed, when it has any. */
  watermark: Watermark | undefined;
  dayStart: Date;
  earliest: Date;
  now: Date;
}): { start: Date; end: Date } | undefined {
  // THE LATER OF THE TWO (Codex r2), which is what "still owed" actually
  // means. `owedFrom` is where an abandoned or deferred run's window began;
  // `readThrough` is how far a filed run has since read. Taking `owedFrom`
  // outright re-read the SAME messages every day after a recovery — the
  // recovering run files them and settles, but the run that recorded the
  // debt stays non-filed forever, so the next day re-extracts and files
  // them AGAIN. A debt already covered by a later read is a debt paid.
  const points = [
    bounds.watermark?.owedFrom,
    bounds.watermark?.readThrough,
  ].filter((point): point is Date => point !== undefined);
  const from =
    points.length === 0
      ? bounds.dayStart
      : points.reduce((a, b) => (a > b ? a : b));
  const start = from > bounds.earliest ? from : bounds.earliest;
  if (start >= bounds.now) return undefined;
  return { start, end: bounds.now };
}

/**
 * Whether a chat had anything HAPPEN in its window — counted on the seam's
 * plaintext metadata, with no envelope opened.
 *
 * A backfilled row counts here (the flag lives inside the envelope), so a
 * chat whose only traffic is history sync is claimed and then found empty
 * once `readWindow` drops it. That costs one run row and no model call,
 * which is the right trade: the alternative is decrypting every chat's
 * window on every poll to answer a question that is almost always "yes".
 *
 * THE SAME TYPES `readWindow` READS — `EXTRACTED_EVENT_TYPES`, shared so
 * the two cannot drift (ticket #98). A day whose only beat is a 👍 is a day
 * this pass has to read: the customer agreed and said nothing else, which
 * is precisely the case ADR-0041 exists for.
 */
async function hasTraffic(
  deps: DailyExtractionDeps,
  chatJid: string,
  window: { start: Date; end: Date },
): Promise<boolean> {
  const res = await deps.db.query(
    `SELECT 1
       FROM wa_events
      WHERE twin_id = $1
        AND occurred_at >= $2 AND occurred_at < $3
        AND event_type = ANY($5::text[])
        AND left(external_event_id, length($4::text) + 1) = $4 || ':'
      LIMIT 1`,
    [deps.twinId, window.start, window.end, chatJid, EXTRACTED_EVENT_TYPES],
  );
  return res.rows.length > 0;
}

/**
 * Claims the run — one row per (twin, chat, day) on the scheduled path,
 * moved to `submitted` — and returns its id, which is what identifies a
 * run from here on.
 *
 * A `deferred` run is re-claimed — that is the orphan rule's other half
 * (spec #48 decision 13): a chat the rep binds an hour after the pass
 * proposed it is extracted by the next run rather than waiting a day. A
 * `submitted` one is re-claimed too, which is what makes a crash during the
 * model call recoverable: nothing was filed, so re-reading the chat is
 * exactly the right thing to do — and no run of the seat's extraction
 * starts while one is going (the clock's repeat and a rep's request both ask
 * first), which is what stops a running read's own row being re-claimed under
 * it.
 *
 * A `filed` one is never re-claimed, and NEITHER IS A `failed` ONE (ticket
 * #194; spec #193 decision 10): a chat whose read filed nothing
 * is done for the day, because re-claiming it would ask the same model the
 * same question every two seconds until midnight. Nothing is lost — only a
 * `filed` run advances the watermark, so tomorrow's window reaches back over
 * the same messages. Both arms returning NOTHING is how the caller learns it
 * has no claim.
 */
async function claimRun(
  deps: DailyExtractionDeps,
  chatJid: string,
  day: string,
  window: { start: Date; end: Date },
  /**
   * A STEERING RE-READ of a chat whose day is already filed (ticket #67).
   * It gets a row of its own rather than overwriting the day's run,
   * because that run's counts are the record of what actually crossed —
   * and the production uniqueness rule does not see it.
   */
  steering: boolean,
  /**
   * The operator request this claim is being made for, when one asked
   * (`extraction_runs.request_id`, ticket #197). Undefined on both
   * clock-driven paths, and the column is NULL for every run the clock claims.
   *
   * KEPT BY THE `DO UPDATE` ARM WHEN NOBODY ASKED (Codex r2). A crash leaves a
   * request's run `submitted`, and the SCHEDULED pass is what recovers it — so
   * an unconditional re-stamp would set `request_id` to NULL and the requester
   * still polling for that run would find no rows at all, read the empty list
   * as "everything settled", and exit zero over a recovery that was still
   * running. A recovery does not change who asked, so the clock leaves the
   * ownership where it is and a later REQUEST replaces it with its own.
   */
  requestId: string | undefined,
): Promise<string | undefined> {
  const claimed = steering
    ? await deps.db.query<{ id: string }>(
        `INSERT INTO extraction_runs
           (twin_id, chat_jid, extraction_day, state, window_start, window_end,
            steering, request_id)
         VALUES ($1, $2, $3, 'submitted', $4, $5, true, $6)
         RETURNING id`,
        [deps.twinId, chatJid, day, window.start, window.end, requestId ?? null],
      )
    : await deps.db.query<{ id: string }>(
        `INSERT INTO extraction_runs
           (twin_id, chat_jid, extraction_day, state, window_start, window_end,
            request_id)
         VALUES ($1, $2, $3, 'submitted', $4, $5, $6)
         ON CONFLICT (twin_id, chat_jid, extraction_day) WHERE NOT steering
         DO UPDATE
            SET state = 'submitted',
                settled_at = NULL,
                -- The column's own default, restated: a re-claim re-stamps
                -- the start and both statements must read one clock, or the
                -- row's span depends on which arm wrote it (#200 hotfix 1).
                started_at = clock_timestamp(),
                window_start = EXCLUDED.window_start,
                window_end = EXCLUDED.window_end,
                request_id = COALESCE(EXCLUDED.request_id,
                                      extraction_runs.request_id),
                candidates = 0, filed = 0, below_threshold = 0,
                unresolved_reference = 0, resolved_reference = 0,
                refused = 0
          WHERE extraction_runs.state NOT IN ('filed', 'failed')
         RETURNING id`,
        [deps.twinId, chatJid, day, window.start, window.end, requestId ?? null],
      );
  // Undefined when the ON CONFLICT arm declined: the day's run is already
  // `filed` or `failed`, so this call has no claim and nothing to settle.
  return claimed.rows[0]?.id;
}

/**
 * The orphan rule (FR-32, spec #48 decision 13): an in-scope chat with
 * traffic and no binding gets slice 2's proposal and defers its extraction.
 *
 * It is slice 2's proposal exactly — the same grammar, the same
 * `binding_question` notice, the same once-ever asked-state — so the rep
 * meets one ceremony rather than two, and answering it is the same «si»
 * they already know. Nothing here generates a per-fact question for every
 * line of an unnamed chat's day, which is the shape the decision exists to
 * avoid.
 *
 * A chat whose traffic carries no push-name has nothing to propose, exactly
 * as in slice 2 — the run still defers, so the day is settled and the model
 * is never asked about a chat with no customer to attach a fact to.
 *
 * A GESTURE IS NEVER THE ANCHOR (ticket #98). A reaction carries a
 * push-name like any delivery, but the whole ceremony hangs off
 * `about_event_id` and every reader of that anchor decodes it as a MESSAGE
 * — the asked-state sweep and the crossing backlog's confirmation resolver
 * both do, and #97 fixed exactly this defect in the ceremony's «or answer»
 * trigger. Anchoring a question on a reaction row would take the next pass
 * down with a payload error, for the whole twin. So a chat whose only
 * counterparty traffic is a 👍 has nothing to propose, which is the same
 * arm as the push-name-less chat above.
 *
 * WHAT THAT COSTS, said plainly (Codex r1; `/code-review`'s spec axis said
 * the same and called it a ruling rather than a revert). An in-scope,
 * UNBOUND chat whose only push-named counterparty traffic is ever a
 * gesture now gets no proposal at all: it defers, its window stays owed,
 * and after the seven-day floor that gesture ages out unread. The evidence
 * is not deleted — the seam row stands and the run's state records the
 * deferral — but nobody is asked to name that customer, so nothing about
 * the chat is extracted until the rep binds it another way or the customer
 * types something.
 *
 * It is not built here for two reasons. It is not reachable: no plane emits
 * a reaction at all yet, which is ADR-0041's deploy-order rule and the
 * reason #97 and this ticket ship ahead of #100. And the remedy is not an
 * implementer's to choose — making the anchor typed means teaching
 * `bindingQuestionAsked` and the crossing backlog's resolver to dispatch on
 * `event_type`, both outside this ticket, and the question underneath it
 * («may a gesture be what names a customer?») is a product decision about
 * the ceremony rather than a defect in this window.
 */
async function deferChat(
  deps: DailyExtractionDeps,
  runId: string,
  chatJid: string,
  window: { start: Date; end: Date },
  beats: readonly WindowBeat[],
): Promise<void> {
  const proposal = beats.find(
    (beat) =>
      beat.row.reactionTo === undefined &&
      // ...and an OPAQUE DELIVERY IS NEVER THE ANCHOR EITHER (ticket #124),
      // for exactly the reason a gesture is not: the ceremony hangs off
      // `about_event_id` and every reader of that anchor decodes it as a
      // MESSAGE, so anchoring a question on a photo would take the next
      // pass down with a payload error, for the whole twin. A chat whose
      // only push-named counterparty traffic is a photo therefore proposes
      // nothing, which is the same arm as the push-name-less chat above.
      beat.row.opaqueKind === undefined &&
      !beat.row.fromMe &&
      beat.row.pushName !== undefined &&
      beat.row.pushName !== "",
  );
  // The same per-twin lock the filing path takes, held to the end of the
  // claim's transaction: without it two reads could each find "not asked"
  // and each post the ceremony, and the rep would meet the same question
  // twice.
  await takeDailyPassLock(deps.db, deps.twinId);
  if (proposal !== undefined && !(await bindingQuestionAsked(deps, chatJid))) {
    await insertNoticeWithSystemSend(deps.db, {
      twinId: deps.twinId,
      selfChatJid: deps.selfChatJid,
      dek: deps.dek,
      kind: "binding_question",
      // The event whose payload NAMES the chat — the anchor slice 2's
      // once-ever rule and its confirmation both decrypt, and the question
      // part's own `aboutEventId` (ticket #220).
      aboutEventId: proposal.eventId,
      post: composeBindingQuestionPost({
        aboutEventId: proposal.eventId,
        proposedName: proposal.row.pushName!,
      }),
      timeZone: deps.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
  }
  // A deferred run keeps the window it CLAIMED rather than the one it read:
  // nothing was extracted, so the whole of it is still owed and `owedFrom`
  // is what carries it into the next run.
  await settleRun(deps.db, runId, "deferred", window, { ...EMPTY_RUN, messages: beats.length });
}

/**
 * One claimed chat-day, read for the agent step that files it: what its three
 * reads and its recipes are bound over, and the filing its tool calls.
 */
export interface ChatDayToRead {
  readonly deps: ExtractionDeps;
  readonly file: (facts: CandidateFacts) => Promise<FilingOutcome>;
}

/**
 * OPENS ONE CLAIM FOR ITS CHILD'S AGENT STEP (ticket #364): the claim row
 * read back by its id, the chat's window decrypted, its history before the
 * window, and the filing bound to the step's own connection and execution —
 * or nothing, when the claim is already past `submitted` (another step of the
 * same child filed it, or a crash recovery settled it), so the step's tools
 * refuse and its recipes render nothing.
 *
 * THE FILING IS THE TOOL'S, INSIDE THE STEP'S TRANSACTION: the facts with
 * their disclosure lines, the claim settled `filed` naming the step's
 * execution, and the step's record and chain entry commit together.
 * `extraction_runs.execution_id` is checked at COMMIT (…20261007100020),
 * because the tool writes before the turn's record exists.
 */
export async function openChatDay(
  deps: DailyExtractionDeps,
  claimId: string,
  executionId: string,
  now: Date,
): Promise<ChatDayToRead | undefined> {
  const res = await deps.db.query<{
    chat_jid: string;
    extraction_day: string;
    window_start: Date;
    window_end: Date;
  }>(
    `SELECT chat_jid, extraction_day::text AS extraction_day, window_start, window_end
       FROM extraction_runs
      WHERE twin_id = $1 AND id = $2 AND state = 'submitted'`,
    [deps.twinId, claimId],
  );
  const row = res.rows[0];
  if (row === undefined) return undefined;
  assertNotSelfChat(deps, row.chat_jid, "a claimed chat-day");
  const binding = deps.bundle.listChatBindings().find((one) => one.chatJid === row.chat_jid);
  if (binding === undefined) return undefined;
  const window = { start: row.window_start, end: row.window_end };
  const beats = await readWindow(deps, row.chat_jid, window);
  const run: ClaimedRun = {
    runId: claimId,
    chat: { chatJid: binding.chatJid, entityId: binding.entityId, displayName: binding.displayName },
    day: row.extraction_day,
    window,
    beats,
    now,
  };
  const served = new ServedReads();
  return {
    deps: {
      counterparty: run.chat.displayName,
      transcript: recentTranscriptFor(deps, run),
      day: beats.map((beat) => beat.row),
      timeZone: deps.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
      db: deps.db,
      twinId: deps.twinId,
      bundle: deps.bundle,
      embedder: deps.embedder,
      selfChatJid: deps.selfChatJid,
      served,
    },
    file: async (facts) => {
      const filing = await savepointedFiling(deps.db, () => fileCandidates(deps.db, deps, run, facts, served));
      if (filing.superseded) return { superseded: true };
      await settleRun(deps.db, run.runId, "filed", run.window, filing.counts, executionId);
      return {
        superseded: false,
        filed: filing.counts.filed,
        belowThreshold: filing.counts.belowThreshold,
        candidates: filing.counts.candidates,
      };
    },
  };
}


const EXTRACTION_FILING_SAVEPOINT = "extraction_filing";

/**
 * The filing, wrapped so a Postgres error inside it leaves the step's
 * transaction usable (Codex r1 on #196): the tool's refusal goes back to the
 * model, and the step's own record and chain entry are written on a clean
 * transaction after the turn. IT RETHROWS — rolling back is about the
 * database, and the tool's failure is the turn's.
 */
async function savepointedFiling(
  client: pg.ClientBase,
  file: () => Promise<ExtractionFiling>,
): Promise<ExtractionFiling> {
  await client.query(`SAVEPOINT ${EXTRACTION_FILING_SAVEPOINT}`);
  try {
    const filing = await file();
    await client.query(`RELEASE SAVEPOINT ${EXTRACTION_FILING_SAVEPOINT}`);
    return filing;
  } catch (error) {
    await client.query(`ROLLBACK TO SAVEPOINT ${EXTRACTION_FILING_SAVEPOINT}`);
    throw error;
  }
}

/**
 * The chat's own history before the window, as the shared `recent_transcript`
 * part renders it (spec #193 decision 16).
 *
 * READ FROM TWIN MEMORY, never from the seam, and the asymmetry with the day
 * above it is the point: a candidate fact must name the `wa_events` row it
 * was read in, so the DAY comes off the seam with its ids — and this block
 * is context that nothing may cite, so it comes out of the bundle like every
 * other transcript the model is shown, through the one gesture renderer (#97)
 * that composes a reaction against what memory holds right now.
 *
 * IT IS CUT AT THE WINDOW'S START, NOT BY REMOVING THE DAY'S IDS (Codex r1).
 * Twin memory holds everything, the window's own beats included and also
 * whatever arrived AFTER it — inside the one-minute settling lag, or while
 * this execution waited its turn on a lane capped at one. Filtering the day's
 * ids out would leave that newer traffic under the "already handled" heading,
 * which is false about it and which also DISPLACES the older messages the
 * block exists to carry: twenty newer lines and no history at all. The
 * window's start is one instant and it answers both, because `readWindow`
 * selects `occurred_at >= window.start` — so strictly earlier is exactly what
 * came before, and a message standing under both this heading and the day's
 * (the conflation #75's AC 3 forbids) is impossible by construction.
 */
function recentTranscriptFor(
  deps: DailyExtractionDeps,
  run: ClaimedRun,
): readonly ConversationRow[] {
  const before = run.window.start.getTime();
  const history = deps.bundle
    .readConversation(run.chat.chatJid)
    .filter((row) => new Date(row.occurredAt).getTime() < before)
    .slice(-(deps.historyLimit ?? DEFAULT_TRANSCRIPT_LIMIT));
  return renderGesturesForModel(deps.bundle, history);
}

/**
 * What one `file_facts` call does to the store (tickets #194, #196, #364;
 * spec #193 decision 19): the daily-pass lock, the state re-check, the
 * covered-prefix rule and one candidate at a time through the aperture, on
 * the step's own connection and inside its transaction, so the facts, their
 * disclosure lines and the step's record commit together.
 *
 * THE SETTLE IS THE CALLER'S (`openChatDay`), and it names the step's
 * execution, whose record is written after the turn.
 *
 * THE DAILY-PASS LOCK IS TAKEN HERE AND HELD TO THE STEP'S COMMIT — through
 * the rest of the model's turn, which is the price of the tool being the
 * model's call (recorded on #364). It is taken BEFORE the step's own chain
 * append, and the pair is deadlock-free because nothing that holds the
 * chain's TAIL lock ever waits for the pass lock: the disclosure's posting
 * and `deferChat` take the pass lock and append afterwards, every other
 * execution appends and takes no pass lock, and the aperture's own appends
 * here take the tail while holding the pass lock — one ordering, nothing to
 * invert.
 */
async function fileCandidates(
  client: pg.ClientBase,
  deps: DailyExtractionDeps,
  run: ClaimedRun,
  facts: CandidateFacts,
  /** What this run's reads served — see `fileOne`'s `chatsRead` (Codex r2). */
  served: ServedReads,
): Promise<ExtractionFiling> {
  // A candidate fact names the message it was read in. The pass matches
  // that back to the seam row it SHOWED the model — never to the seam at
  // large — so a model citing a message it was not given files nothing,
  // and a model cannot reach a row from another chat by naming it.
  const beatByMessageId = new Map(
    run.beats.map((beat) => [beat.row.messageId, beat] as const),
  );
  /**
   * WHETHER THE COUNTERPARTY SAID ANYTHING IN THIS WINDOW AT ALL — ADR-0038's
   * both-halves rule, made structural (ticket #196, Codex round 3).
   *
   * It was prose in the contract and needed nothing else while the model
   * could see one day of one chat: a request is a customer MESSAGE, so a
   * window without one had no request for the model to pair with, and it
   * could not go and find one. The search changes that. A day whose only beat
   * is the rep's «va» plus yesterday's request found by looking is exactly
   * the cross-day pairing ADR-0038 forbids and spec #193 decision 12 keeps
   * forbidden — «a cross-day agreement still files nothing and is still
   * counted as the under-filing ADR-0038 names».
   *
   * A REACTION IS THE EXCEPTION AND KEEPS IT (`fileOne`): a gesture's whole
   * meaning is the message under it, and a reaction line whose target is
   * inlined has shown the model both halves even when the target is outside
   * the window.
   *
   * AN OPAQUE BEAT COUNTS AS THE COUNTERPARTY SPEAKING, deliberately: the
   * twin could not read it, so it cannot rule out that the request is in
   * there, and this fence errs towards letting the aperture and the
   * confidence gate decide (ADR-0042).
   */
  const counterpartySpoke = run.beats.some(
    (beat) => !beat.row.fromMe && beat.row.reactionTo === undefined,
  );

  let filed = 0;
  let belowThreshold = 0;
  let unresolvedReference = 0;
  let resolvedReference = 0;
  let refused = 0;

  // The daily pass's ONE per-twin lock (ticket #53, Codex r2), shared
  // with the disclosure's assembly: a question filed here can never
  // commit between that pass's look for questions and its facts post,
  // which is what makes FR-39's "questions first" hold for a question
  // this very transaction raises.
  await takeDailyPassLock(client, deps.twinId);
  // The state re-check inside the lock: the loser of a race — two
  // processes that both claimed and both called the model — discards its
  // candidates here rather than filing a second copy of the day. It asks
  // after THE RUN THIS CALL CLAIMED, by id, because a day can now carry
  // more than one run (ticket #67) and a chat-and-day question would
  // answer about somebody else's row.
  const standing = await client.query<{ state: string }>(
    "SELECT state FROM extraction_runs WHERE id = $1 FOR UPDATE",
    [run.runId],
  );
  if (standing.rows[0]?.state !== "submitted") return { superseded: true };

  // ...AND the window re-check (Codex r3), which is the state check's
  // blind spot across days. A pass that claimed YESTERDAY and paused in
  // its model call holds a row that is still `submitted` and always will
  // be — while today's pass recovers the same window through `owedFrom`,
  // files it, and settles. The stale claimant then wakes, finds its own
  // row exactly as it left it, and files every candidate a second time.
  // The watermark fix only chooses future windows; nothing stops a
  // claimant already in flight. So the question asked here is not "is my
  // row still mine?" but "has anyone read past where I read?" — and a
  // window already covered by a filed run has nothing left to file.
  const covered = await client.query<{ read_through: Date | null }>(
    `SELECT max(window_end) AS read_through
       FROM extraction_runs
      WHERE twin_id = $1 AND chat_jid = $2 AND state = 'filed'`,
    [deps.twinId, run.chat.chatJid],
  );
  const readThrough = covered.rows[0]?.read_through;
  if (readThrough != null && readThrough >= run.window.end) {
    return { superseded: true };
  }

  // ...AND THE COVERED PREFIX IS DROPPED (Codex r2). The check above only
  // asks whether the WHOLE window is spent; a recovery window is
  // deliberately WIDER than the run it recovers, so a filed run can cover
  // its beginning while its tail is genuinely owed. Every message before
  // `readThrough` has already been read and filed by somebody, and filing
  // it again would put a second copy of one claim into an append-only
  // store — or, when the model classifies the same ambiguous sentence
  // differently the second time, ask the rep about it twice under two
  // different kinds and let them affirm both.
  //
  // The window read is `occurred_at < window.end`, so `readThrough` is
  // the first instant NOT yet read: strictly-earlier is the covered set.
  //
  // RECORDED, NOT CLOSED (Codex r3). `occurred_at` is the instant a
  // message was SENT, not proof that the filed run's SELECT saw it — a
  // row delivered late (a reconnect, a clock skew) can commit with an
  // instant inside a window that has already settled. Such a row is
  // ALREADY lost to the watermark, which starts the next window at
  // `readThrough` and never looks back (#52's own recorded remainder 3:
  // "a commit delayed longer than that would still fall in a settled
  // window"). What this filter changes is only whether the recovery run
  // that happens to be holding it in memory rescues it — and it rescues
  // it by re-filing every OTHER message of the covered prefix a second
  // time. One late message unread is a recall loss; a duplicated prefix
  // is a duplicated crossing in an append-only store, disclosed twice
  // and answerable twice. The airtight version is the transaction-
  // visibility watermark #52 already deferred.
  for (const candidate of facts.candidates) {
    // Skipped ONLY when the cited message is one this run may not re-file
    // — known, and already read by somebody. A candidate citing a message
    // the pass never showed the model is a different thing entirely
    // (invented provenance) and stays `fileOne`'s refusal.
    const cited = beatByMessageId.get(candidate.messageId);
    if (
      cited !== undefined &&
      readThrough != null &&
      new Date(cited.row.occurredAt) < readThrough
    ) {
      continue;
    }
    const outcome = await fileOne(
      client,
      deps,
      run.chat,
      candidate,
      beatByMessageId,
      served.reached(),
      counterpartySpoke,
    );
    if (outcome === "filed") filed += 1;
    else if (outcome === "below_threshold") belowThreshold += 1;
    else if (outcome === "unresolved_reference") unresolvedReference += 1;
    else refused += 1;
    // WHAT THE MODEL RESOLVED, on the second axis (ticket #196; spec #193
    // decision 19). Every candidate offered to the aperture under this
    // reading is counted, whatever the aperture then did with it — the four
    // counters above are what say which door it went out of. A number that
    // only counted the ones that crossed would be a rate with no denominator,
    // which is the hole the drop counter beside it was added to close.
    if (candidate.reading === "resolved_reference") resolvedReference += 1;
  }
  return {
    superseded: false,
    counts: {
      messages: run.beats.length,
      candidates: facts.candidates.length,
      filed,
      belowThreshold,
      unresolvedReference,
      resolvedReference,
      refused,
    },
  };
}

/**
 * One candidate through the aperture — the only thing that can cross.
 *
 * BELOW THE APERTURE'S GATE THE CANDIDATE IS DROPPED (ticket #218, FR-31):
 * no fact, no question, no line, and the run row's `below_threshold` counts
 * it. The pass grades nothing and routes nothing — it hands over what the
 * model said and records what the aperture decided, which since this ticket
 * is the same ending for both of the gate's tests.
 */
async function fileOne(
  /**
   * The EXECUTION's own connection, never the pass's (ticket #194). The
   * crossing, its disclosure line and this execution's record and chain entry
   * commit together or not at all (ADR-0020), and they can only do that on
   * the connection the transaction is open on.
   */
  client: pg.ClientBase,
  deps: DailyExtractionDeps,
  chat: BoundChat,
  candidate: CandidateFact,
  beatByMessageId: ReadonlyMap<string, WindowBeat>,
  /**
   * Every OTHER conversation this run's reads showed the model the words of
   * (ticket #196, Codex round 2). The aperture's wall sweep knows the chat a
   * fact is filed against; a run that searched has read others, and a number
   * inside one of those messages is chat identity too (ADR-0004).
   */
  chatsRead: readonly string[],
  /** Whether this window holds a counterparty message at all — see `fileCandidates`. */
  counterpartySpoke: boolean,
): Promise<"filed" | "below_threshold" | "unresolved_reference" | "refused"> {
  const cited = beatByMessageId.get(candidate.messageId);
  if (cited === undefined) return "refused";
  const sourceEventId = cited.eventId;
  // ADR-0038'S FENCE, WHERE THE SEARCH COULD OTHERWISE WALK ROUND IT (ticket
  // #196, Codex round 3; spec #193 decision 12). An `OrderTaken` evidenced by
  // a rep MESSAGE needs the request among the messages this run was given,
  // and a window in which the counterparty never spoke holds none — so a run
  // that found yesterday's request by looking and cited today's bare «va»
  // files nothing. The refusal is the PASS's for the same reason the line
  // above it is: whether a candidate may re-file this window is a fact about
  // the window, and the pass is what holds one. A GESTURE keeps the
  // exception the contract states, because a reaction line whose target is
  // inlined has shown the model both halves.
  if (
    candidate.factType === "OrderTaken" &&
    cited.row.reactionTo === undefined &&
    !counterpartySpoke
  ) {
    return "refused";
  }
  const outcome = await fileCandidateFact(
    // The aperture is a separate database ROLE but not yet a separate
    // CONNECTION (see `confirmBindingFromQuestion`'s note): every process
    // still connects as the schema owner, and the grant audit is what
    // makes the single-writer claim real today.
    { db: client, dek: deps.dek },
    {
      twinId: deps.twinId,
      entityId: chat.entityId,
      sourceEventId,
      factType: candidate.factType,
      payload: candidate.payload,
      confidence: candidate.confidence,
      // The gate's second input, carried across untouched (ticket #66).
      // The pass grades nothing: it hands over what the model said and
      // counts what the aperture decided.
      reading: candidate.reading,
      // ...and what this run READ, which is the pass's to know and the
      // aperture's to judge: the wall is the aperture's rule, and which
      // conversations a run reached is a fact only its own reads hold.
      chatsRead,
      // ONE RENDERER, AND ONLY ONE (ticket #218): a candidate the gate stops
      // reaches no renderer at all, so there is nothing a second one could
      // show. Rendered at the twin's ONE grammar point, from the payload the
      // aperture normalized — so the rep is told what was stored rather than
      // what the model said (ADR-0034).
      renderDisclosureLine: renderFactDisclosureLine,
    },
  );
  return outcome.filed ? "filed" : outcome.outcome;
}

/**
 * Moves a CLAIMED run to its settled state, with what it saw.
 *
 * BY THE RUN'S OWN ID, which `claimRun` returned. A day can carry more
 * than one run since ticket #67 — the scheduled one and whatever a
 * steering session drove by hand — so (twin, chat, day) no longer names a
 * row, and a caller settling by it would settle somebody else's.
 *
 * Still guarded on `submitted`, which is the state `claimRun` leaves
 * behind: a run another pass has settled in the meantime must not have its
 * outcome overwritten by a slower caller's.
 *
 * IT WRITES THE WINDOW IT ACTUALLY READ (Codex r1), rather than leaving
 * whatever the row happens to hold. `claimRun` upserts the window, so two
 * passes racing would leave the row carrying the LATER claim's window while
 * the earlier one settles it — and the watermark would then claim messages
 * as read that nobody read. Settling with the caller's own window makes the
 * watermark a statement about what was read rather than about who wrote
 * last.
 */
async function settleRun(
  /**
   * The connection the settle belongs on: an execution's own for a `filed` or
   * a `failed` run, the pass's for a `deferred` one — a deferred chat has no
   * execution at all (FR-32; spec #193 decision 9).
   */
  client: pg.ClientBase,
  runId: string,
  state: Exclude<ExtractionRunState, "submitted">,
  window: { start: Date; end: Date },
  counts: ExtractionCounts,
  /**
   * The execution that read this chat's day, when one did (ticket #194; spec
   * #193 decision 28). Absent for a deferred run, and for the settle a failed
   * execution's own transaction could not write.
   */
  executionId?: string,
): Promise<void> {
  await client.query(
    // `clock_timestamp()`, never `now()`: a `filed` run settles inside the
    // execution's own transaction, which opened before the model calls — so
    // `now()` would write the transaction's start and the row would say the
    // run took no time at all (#200 hotfix 1; …20260906100040 re-cuts the
    // column defaults for the same reason).
    `UPDATE extraction_runs
        SET state = $2, settled_at = clock_timestamp(),
            window_start = $3, window_end = $4,
            messages = $5, candidates = $6,
            filed = $7, below_threshold = $8, unresolved_reference = $9,
            resolved_reference = $10, refused = $11,
            execution_id = COALESCE($12, execution_id)
      WHERE id = $1 AND state = 'submitted'`,
    [
      runId,
      state,
      window.start,
      window.end,
      counts.messages,
      counts.candidates,
      counts.filed,
      counts.belowThreshold,
      counts.unresolvedReference,
      counts.resolvedReference,
      counts.refused,
      executionId ?? null,
    ],
  );
}

/**
 * The seam rows extraction reads, named once (ticket #98).
 *
 * The window read and `hasTraffic`'s plaintext count must agree EXACTLY on
 * this set: a chat claimed on traffic the window then drops costs a run row
 * for nothing, and a chat the count cannot see is one whose beats wait in
 * the window for somebody to type something. Two SQL literals could drift;
 * one array cannot.
 */
const EXTRACTED_EVENT_TYPES = ["message", "reaction", "opaque"];

/**
 * The seam's own source name (ADR-0005). Part of `wa_events`'s identity —
 * the dedupe constraint is `(source, external_event_id)` — so a read that
 * means "this exact rail event" names it.
 */
const RAW_SOURCE = "whatsapp";

/** The three columns a beat is decoded from, in every read below. */
interface SeamRow {
  readonly id: string;
  readonly occurred_at: Date;
  readonly payload_enc: Buffer;
}

/**
 * One chat's beats inside the day's window, oldest first — what somebody
 * said, and what somebody tapped.
 *
 * Read from the SEAM rather than from the bundle, because a candidate fact
 * has to name the `wa_events` row it was read in: that id is the disclosure
 * line's provenance and the anchor the ADR-0033 invariant walks, and the
 * bundle's message store does not carry it.
 *
 * The chat scope is `external_event_id`'s `<chat jid>:<message id>` prefix,
 * compared as a LEFT SLICE rather than through LIKE so a JID's own
 * characters can never be read as wildcards — and CONFIRMED against the
 * decrypted envelope, because the prefix is plaintext metadata and the
 * envelope is the truth about which chat a message was in.
 *
 * Backfilled history is dropped here as well as at the aperture. The window
 * is the day (spec #48 decision 13): history sync delivers old messages
 * with old `occurred_at`, so most of it falls outside the window anyway —
 * but a history blob that arrives carrying today's messages must not be
 * re-extracted either, and `backfill` is what says so. That holds for a
 * REACTION exactly as for a message (ADR-0041: "extraction skips the marker
 * as it always has").
 *
 * OPAQUE DELIVERIES ARE IN THE WINDOW TOO (ticket #124; ADR-0042), as one
 * placeholder beat each — a photo the customer sent is part of the day
 * whether or not the twin can see it, and reading the day without it is
 * how the empty-text husk used to make a conversation read as if nobody
 * spoke. What FOLDS is decided after the read, per (chat, stanza).
 *
 * REACTIONS ARE IN THE WINDOW (ticket #98; ADR-0041). A reaction is evidence
 * in a conversation exactly like text, so it is read as a beat of its own —
 * ONE ROW, ONE LINE, in `occurred_at` order with everything else. Nothing
 * folds here: a set, a change and a removal are three deliveries and three
 * beats, because «puso 👍 y luego lo quitó» is a different story from «no
 * reaccionó» and only the model reading the transcript can tell which one
 * matters. The row is typed by `event_type` and decoded by the shape that
 * type names — never as a message, whose `text` a reaction does not have.
 *
 * THE SQL ORDER IS THE COARSE ORDER; THE FINE ONE IS IN MEMORY (ticket
 * #109). `sender_ts_ms` lives INSIDE the encrypted payload, so the second
 * a reaction's beat happened within cannot be read by `ORDER BY` — it is
 * known only after the decode below. `inDeliveryOrder` refines what the
 * database returned, and it is the ONE place the rule lives: the bundle's
 * `readConversation` refines its own read the same way.
 */
async function readWindow(
  deps: DailyExtractionDeps,
  chatJid: string,
  window: { start: Date; end: Date },
): Promise<WindowBeat[]> {
  const res = await deps.db.query<SeamRow & { event_type: string }>(
    `SELECT id, event_type, occurred_at, payload_enc
       FROM wa_events
      WHERE twin_id = $1
        AND occurred_at >= $2 AND occurred_at < $3
        AND event_type = ANY($5::text[])
        AND left(external_event_id, length($4::text) + 1) = $4 || ':'
      ORDER BY occurred_at, id`,
    [deps.twinId, window.start, window.end, chatJid, EXTRACTED_EVENT_TYPES],
  );

  const beats: WindowBeat[] = [];
  for (const row of res.rows) {
    const beat = readBeat(deps, chatJid, row);
    if (beat !== undefined) beats.push(beat);
  }
  // THE FOLD, BEFORE ANYTHING ELSE READS THE LIST (ticket #124; ADR-0042).
  // One message is one beat, so the readable row stands over the opaque one
  // for the same message and the opaque one stands over the legacy
  // empty-text husk. It runs first because `inlineOutOfWindowTargets` asks
  // which ids the model will be SHOWN, and a folded-away row is not one.
  return await inlineOutOfWindowTargets(
    deps,
    chatJid,
    inDeliveryOrder(
      foldOpaqueDeliveries(beats, (beat) => beat.row),
      (beat) => beat.row,
    ),
  );
}

/**
 * One seam row as a beat of the day, decoded by the shape its `event_type`
 * names — the same dispatch `routeEvent` makes, on the same discriminant.
 *
 * A type the SQL did not select can never arrive here (`readWindow` filters
 * on `EXTRACTED_EVENT_TYPES`), so the default arm is the message shape
 * rather than a refusal: the enumeration is the guard, and widening it is
 * what adds an arm.
 */
function readBeat(
  deps: DailyExtractionDeps,
  chatJid: string,
  row: SeamRow & { event_type: string },
): WindowBeat | undefined {
  switch (row.event_type) {
    case "reaction":
      return readGesture(deps, chatJid, row);
    case "opaque":
      return readOpaqueDelivery(deps, chatJid, row);
    default:
      return readMessage(deps, chatJid, row);
  }
}

/** One `'message'` row as a beat, or nothing when it is not this day's. */
function readMessage(
  deps: DailyExtractionDeps,
  chatJid: string,
  row: SeamRow,
): WindowBeat | undefined {
  const payload = decodeWaMessagePayload(deps.dek, row.payload_enc);
  if (payload.chatJid !== chatJid) return undefined;
  if (payload.backfill === true) return undefined;
  // The innermost refusal (ADR-0033). Unreachable while the enumeration
  // holds — and it is here so that widening the enumeration cannot
  // silently start reading the rep's own notes.
  assertNotSelfChat(deps, payload.chatJid, `wa_events row ${row.id}`);
  return {
    eventId: row.id,
    row: {
      chatJid: payload.chatJid,
      messageId: payload.messageId,
      senderJid: payload.senderJid,
      fromMe: payload.fromMe,
      occurredAt: row.occurred_at.toISOString(),
      content: payload.text,
      ...(payload.pushName === undefined ? {} : { pushName: payload.pushName }),
    },
  };
}

/**
 * One `'reaction'` row as a beat, or nothing when it is not this day's.
 *
 * Its `content` is left to `inlineOutOfWindowTargets`, which is the only
 * caller that knows which ids the model will actually be shown.
 *
 * THE TRANSCRIPT IS STILL ORDERED BY `occurred_at` — it is the key the
 * window itself is cut on, so it is the only one under which "these are the
 * day's beats, in order" is true, and ordering gestures by the reactor's
 * clock while ordering messages by the plane's would interleave two clocks
 * into one sequence. `sender_ts_ms` rides along as a TIE-BREAK only, spent
 * where two gestures share one whole second (ticket #109; the rule and its
 * reasons live in `inDeliveryOrder`). What #98 recorded as open — a set and
 * its removal DELIVERED out of order rendering inverted, so the model reads
 * a withdrawn agreement as standing — is what that closes; it belonged
 * "where deliveries are ordered rather than here", and that is where it
 * went. Nothing folds: still one row, one line (ADR-0041).
 */
function readGesture(
  deps: DailyExtractionDeps,
  chatJid: string,
  row: SeamRow,
): WindowBeat | undefined {
  const payload = decodeWaReactionPayload(deps.dek, row.payload_enc);
  if (payload.chatJid !== chatJid) return undefined;
  // Backfill is backfill whatever the event type: ADR-0041 says extraction
  // "skips the marker as it always has", and a history blob carrying
  // today's gesture must no more be extracted than one carrying today's
  // messages.
  if (payload.backfill === true) return undefined;
  assertNotSelfChat(deps, payload.chatJid, `wa_events row ${row.id}`);
  return {
    eventId: row.id,
    row: {
      chatJid: payload.chatJid,
      // The REACTION's own stanza id, never its target's: it is what the
      // line is prefixed with and what a candidate fact would cite.
      messageId: payload.messageId,
      senderJid: payload.senderJid,
      fromMe: payload.fromMe,
      occurredAt: row.occurred_at.toISOString(),
      content: "",
      reactionTo: payload.reactionTo,
      reactionEmoji: payload.emoji,
      // The reactor's own millisecond clock, carried for `inDeliveryOrder`
      // and read by nothing else — the pinned payload requires it on every
      // reaction, so a beat is never left without a tie-break.
      senderTsMs: payload.senderTsMs,
      ...(payload.pushName === undefined ? {} : { pushName: payload.pushName }),
    },
  };
}

/**
 * One `'opaque'` row as a beat, or nothing when it is not this day's
 * (ticket #124; ADR-0042).
 *
 * Its `content` is the placeholder composed from the rail's kind, by code
 * and at read time — «[foto]», «[nota de voz]», «[mensaje que no se pudo
 * leer]». One line, in `occurred_at` order with everything else, never
 * text: the model reads that a photo happened here and weighs it as mostly
 * noise, where the empty-text husk it replaces read as somebody saying
 * nothing at all.
 *
 * BACKFILL IS BACKFILL WHATEVER THE EVENT TYPE, as for a message and a
 * gesture: a history blob carrying today's photo is history.
 */
function readOpaqueDelivery(
  deps: DailyExtractionDeps,
  chatJid: string,
  row: SeamRow,
): WindowBeat | undefined {
  const payload = decodeWaOpaquePayload(deps.dek, row.payload_enc);
  if (payload.chatJid !== chatJid) return undefined;
  if (payload.backfill === true) return undefined;
  assertNotSelfChat(deps, payload.chatJid, `wa_events row ${row.id}`);
  // Composed in the one place both readers of this shape compose it
  // (`opaque.ts`), because the fold keys on one of its answers and two
  // readers that disagreed would fold here and not in twin memory.
  return {
    eventId: row.id,
    row: opaqueConversationRow(payload, row.occurred_at.toISOString()),
  };
}

/**
 * Composes every gesture's line, now that the whole window is known
 * (ticket #98; ADR-0041).
 *
 * THE ID WHEN THE TARGET IS IN THE WINDOW, THE WORDS WHEN IT IS NOT. A
 * target the model is already being shown needs no quotation — its own line
 * is above, carrying its own id, and repeating the words would only invite
 * the model to read one message twice. A target OUTSIDE the window is a
 * pointer the model cannot follow, and "a gesture at last week's quote"
 * is the case ADR-0041 says a bare id would re-amputate — so its text is
 * inlined by deterministic read-back off the seam.
 *
 * A target that is in NO window and on no seam row — pre-link, never
 * captured, or a non-text message — renders bare with its id. The pass
 * never fails over a missing target: the gesture is still a beat, and the
 * emoji is still what the reactor meant.
 */
async function inlineOutOfWindowTargets(
  deps: DailyExtractionDeps,
  chatJid: string,
  beats: readonly WindowBeat[],
): Promise<WindowBeat[]> {
  const shown = new Set(beats.map((beat) => beat.row.messageId));
  const composed: WindowBeat[] = [];
  for (const beat of beats) {
    const targetId = beat.row.reactionTo;
    if (targetId === undefined) {
      composed.push(beat);
      continue;
    }
    const target = shown.has(targetId)
      ? undefined
      : await readTargetText(deps, chatJid, targetId);
    composed.push({
      ...beat,
      row: {
        ...beat.row,
        content: renderReactionGesture({
          // `reactionEmoji` is written with `reactionTo` and never absent
          // beside it (see `reactions.ts`, which reads the same pair the
          // same way); the fallback is the removal, the fail-safe reading.
          emoji: beat.row.reactionEmoji ?? "",
          targetId,
          target,
        }),
      },
    });
  }
  return composed;
}

/**
 * The deterministic read-back: one out-of-window target's own words.
 *
 * Keyed by (chat, message id) and by nothing a model said — the target
 * pointer comes off the reaction's own decrypted payload, which is
 * ADR-0041's rule that determinism binds the evidence and the target. The
 * seam composes `external_event_id` as `<chat jid>:<message id>`, so the
 * lookup is the seam's own identity: `(source, external_event_id)` is the
 * dedupe UNIQUE, which is why `source` is named here and why this costs one
 * index probe per gesture rather than a scan. `twin_id` still bounds it —
 * one twin can never read another's row — and the chat is CONFIRMED against
 * the decrypted envelope afterwards for the same reason the window read
 * confirms it: the prefix is plaintext metadata, the envelope is the truth.
 *
 * MESSAGE ROWS ONLY — a gesture at a gesture has no words to inline, and a
 * reaction row decoded as a message would throw (the defect #97 fixed in
 * the binding ceremony's own read-back). An empty-text row is a media husk
 * and inlines nothing rather than quoting «».
 *
 * IT DOES NOT ASK WHETHER THE TARGET WAS BACKFILLED, and that is deliberate.
 * Backfill's exclusion is about what may be EXTRACTED — a backfilled row is
 * never a beat here and can never be a candidate fact's provenance — while
 * this text is context for a live gesture whose own row carries the
 * provenance. Twin memory's readers already inline whatever the bundle
 * holds, backfill included (#97), and "a gesture at last week's quote" is
 * most often a gesture at history for a rep who linked last week.
 */
async function readTargetText(
  deps: DailyExtractionDeps,
  chatJid: string,
  messageId: string,
): Promise<string | undefined> {
  const res = await deps.db.query<{ id: string; payload_enc: Buffer }>(
    `SELECT id, payload_enc
       FROM wa_events
      WHERE source = $1
        AND external_event_id = $2 || ':' || $3
        AND twin_id = $4
        AND event_type = 'message'`,
    [RAW_SOURCE, chatJid, messageId, deps.twinId],
  );
  const row = res.rows[0];
  if (row === undefined) return undefined;
  const payload = decodeWaMessagePayload(deps.dek, row.payload_enc);
  if (payload.chatJid !== chatJid) return undefined;
  assertNotSelfChat(deps, payload.chatJid, `wa_events row ${row.id}`);
  return payload.text === "" ? undefined : payload.text;
}

/**
 * ADR-0033, as a refusal rather than a filter.
 *
 * "Provenance decides what crosses": a rep-stated item never crosses, and
 * the test is mechanical — whether the message's chat is the twin thread.
 * A filter would remove the twin thread from a list; this REFUSES to
 * proceed, so widening extraction's input set fails loudly rather than
 * quietly disclosing the rep's own instructions to their employer.
 */
function assertNotSelfChat(
  deps: DailyExtractionDeps,
  chatJid: string,
  where: string,
): void {
  if (chatJid === deps.selfChatJid) {
    throw new Error(
      `extraction reached the twin thread in ${where} — the rep's own thread is never an extraction input, and this is a refusal rather than a filter because a filter is what rots (ADR-0033; spec #48 grilling decision 4)`,
    );
  }
}

