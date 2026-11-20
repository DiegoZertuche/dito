/**
 * THE REQUEST WAKE: an operator asks the RUNNING runtime (ticket #197; spec
 * #193 decision 26; ADR-0010 as amended, ADR-0014 as amended).
 *
 * A request is a ROW on the seam. The loop reads it on its next tick and
 * starts the run itself — the same automation's run the clock fires, on the
 * same definition and the same digest, with the rep as its creator (ticket
 * #364) — and the request names that run and is answered when it ends.
 *
 * WHY A ROW AND NOT A SCRIPT. The hand trigger it replaces opened twin memory
 * in a process of its own, so a steering session had to stop `rig-run.ts`
 * first — dropping the rail's linked device, silencing drafting and ending the
 * one holder ADR-0010 gives the bundle. Every part of that was cost with no
 * benefit: the runtime is already holding the bundle, already has the pass, and
 * already runs a loop that could simply be asked.
 *
 * WHAT THIS MODULE OWNS: the seam table's vocabulary, the take, the settle,
 * and the loop's step. The work it asks for is the automation's own run
 * (`wakes.ts`' `startShippedRun`), so the batch lane, the claim rows, the
 * one-attempt mark and the failure policy all come with it. Nothing here
 * re-implements a day's read or a day's post, and nothing here logs a
 * request's parameters: they are metadata by construction (the store refuses
 * an address) and a log line is not a place the argument has to be made
 * twice.
 *
 * BOTH OCCASIONS ARE SERVED (ticket #198). `extraction` arrived with the
 * channel and `daily_disclosure` is served now that the day's post is an
 * automation — and the one refusal a post needs, a steering clock later than
 * the real day, belongs HERE rather than to the rig's own script, so a
 * hand-written row cannot do what that script would not.
 */
import type { Occasion } from "@dito/execution";
import type pg from "pg";
import { dayOwed } from "./disclosure.js";
import { daySettled } from "./extraction-pass.js";
import { withDbTransaction } from "./db-tx.js";
import { isLaterRepDay, parseIsoInstant } from "./rep-clock.js";
import type { RunValue } from "./runs/definition.js";
import type { RunDeps } from "./runs/engine.js";
import { automationPaused } from "./runs/gate.js";
import { disclosureDepsOf, extractionDepsOf } from "./runs/run-reads.js";
import { shippedAutomationOf } from "./runs/shipped-automations.js";
import { startShippedRun } from "./runs/wakes.js";

/**
 * WHICH OF DITO'S AUTOMATIONS MAY BE ASKED FOR — the two the clock fires,
 * named by the words `@dito/execution`'s `Occasion` and the automations' own
 * rows share.
 *
 * BOTH ARE SERVED, each by the same run its own clock starts: the extraction
 * of a day's chats, and the day's post. The words were both in the
 * store's CHECK from birth (ticket #197) because a value added to a closed set
 * later is a DROP + re-CREATE from whatever ancestor that ticket branched
 * from — the hazard `migration-vocabulary.test.ts` watches, and the one that
 * would refuse a word after an execution had already run under it.
 */
export const RUNTIME_REQUEST_OCCASIONS = [
  "extraction",
  "daily_disclosure",
] as const satisfies readonly Occasion[];

/** One of the two. */
export type RuntimeRequestOccasion =
  (typeof RUNTIME_REQUEST_OCCASIONS)[number];

/**
 * WHAT BECAME OF AN ASK, and the three words divide by whose problem it was.
 *
 * `served` — the runtime took the request and the run it started ended. How
 *   many executions its steps wrote is `executions`; how each ENDED is
 *   `executions.disposition` beside its own chain entry (ADR-0020), which is
 *   where the requester reads it. A day with nothing owed is served and creates
 *   none: the operator asked and the answer was "there is nothing to read".
 * `refused` — the ask could not be served and nothing was created: a
 *   parameter value the channel cannot read, a twin whose rail is not linked,
 *   or a chat whose day is being read right now.
 * `failed` — the RUNTIME could not serve it. The loop carries on, because a
 *   request row a person typed must never be able to stop the twin.
 *
 * IT IS NOT A RUN RECORD, deliberately. The run rows and the execution records
 * are, and restating their endings here would be the same fact in two places —
 * with the second copy free to disagree with the first.
 */
export const RUNTIME_REQUEST_OUTCOMES = [
  "served",
  "refused",
  "failed",
] as const;

/** One of the three. */
export type RuntimeRequestOutcome = (typeof RUNTIME_REQUEST_OUTCOMES)[number];

/**
 * WHY, AS A CLOSED WORD (`runtime_requests.reason`).
 *
 * A sentence would be the one column on this table that could carry content —
 * and the person who writes a request is the person who reads the reason, so
 * four words are enough to say what to fix.
 *
 * WHICH KEYS MAY EXIST IS THE STORE'S, NOT THIS SET'S (Codex r1). The
 * migration's parameter CHECKs refuse an undeclared key, a non-boolean re-read
 * and a clock that is not an ISO-8601 instant with an offset — at the INSERT,
 * so a mistyped ask fails at the operator's own prompt and nothing shaped like
 * a sentence is ever stored. What is left for the loop is the judgement a CHECK
 * cannot make.
 *
 * `malformed_parameter` — a value the store's shape rules admit and this
 *   runtime cannot use: February's 31st, which matches the pattern and is not a
 *   day, or an explicit `null` where a boolean was declared. `parseIsoInstant`
 *   is the one rule about what a day is and this reads through it, so a request
 *   and the rig's own `DITO_RIG_NOW` are refused for the same reasons.
 * `rail_not_linked` — no rail-status event says this twin's rail is linked. A
 *   twin whose rail never came up has no traffic to read and no holder to ask,
 *   and reading its empty day would report "nothing owed" over a rig that is
 *   simply not connected.
 * `chat_in_flight` — a chat is already being read by an execution on the
 *   batch lane, so this ask could not be served over it. For an EXTRACTION
 *   that means nothing could be claimed: #194's guard is what keeps the claim
 *   row and the cap-1 lane saying the same thing, and an ask that claimed
 *   SOME of its chats is `served` with `unclaimed` naming the rest, because
 *   what happened did happen. For the DAY'S POST it means the day has not
 *   SETTLED, which is the wider claim of the two and covers both a chat mid
 *   model call and a chat with traffic nobody has claimed yet (`daySettled`,
 *   Codex r1 on #198): either way its account would be partial and would then
 *   mark the day attempted (ADR-0016's cut; spec #193 decision 21's first
 *   half). Either way the operator is told to ask again rather than told
 *   their day was done — which is why one word covers both: what is
 *   outstanding is a chat.
 * `pass_failed` — paired with the `failed` outcome: the runtime could not serve
 *   the request at all.
 * `interrupted` — also `failed`: this runtime had TAKEN the request and ended
 *   before it could answer. The poll selects on `taken_at IS NULL`, so nothing
 *   would ever look at that row again — `settleStrandedRequests` is what makes
 *   "ask again" a true thing to tell an operator rather than a hope.
 * `day_not_lived` — the sixth word, and the only one #198 needed (ticket
 *   #198). A steering clock later than the real day would have this runtime
 *   post an account of a day the rep has not lived: the post is keyed
 *   (twin, day), so it would BE the post that day gets, and the scheduled
 *   pass would then say nothing on a real day the rep had traffic. It is not
 *   `malformed_parameter` — the instant is well formed and the store admits
 *   it — and an operator who reads that word would go looking for a typo
 *   instead of for the rule. It is the channel's refusal rather than the rig
 *   script's, so a hand-written row cannot do what that script would not.
 *   Extraction is steerable as far ahead as a session needs, and the day's
 *   account waits for its own day.
 * `automation_paused` — the rep set the automation «En pausa» on Rutinas, so
 *   it starts no run, asked or not (ticket #364).
 */
export const RUNTIME_REQUEST_REASONS = [
  "malformed_parameter",
  "rail_not_linked",
  "chat_in_flight",
  "pass_failed",
  "interrupted",
  "day_not_lived",
  "automation_paused",
] as const;

/** One of the seven. */
export type RuntimeRequestReason = (typeof RUNTIME_REQUEST_REASONS)[number];

/** A request the loop has taken and is about to serve. */
interface TakenRequest {
  readonly id: string;
  /** Which of Dito's automations was asked for. */
  readonly occasion: RuntimeRequestOccasion;
  /** The one chat asked about, or undefined for every chat that owes the day. */
  readonly chatJid: string | undefined;
  readonly parameters: unknown;
}

/**
 * What one settle writes, as one value.
 *
 * THE THREE TRAVEL TOGETHER because the store makes them travel together: the
 * reason is present exactly when the outcome is not `served`, and a refusal
 * creates nothing — both are CHECKs, so a call site free to pass them apart is
 * a call site free to write a row the store refuses.
 */
interface RequestSettlement {
  readonly outcome: RuntimeRequestOutcome;
  readonly reason: RuntimeRequestReason | undefined;
  readonly executions: number;
  /** Chats left alone because their day was already being read. */
  readonly unclaimed: number;
}

/** A refusal, or the steering the request asked for. */
type ParsedParameters =
  | { readonly ok: true; readonly now: Date | undefined; readonly reextract: boolean }
  | { readonly ok: false; readonly reason: RuntimeRequestReason };

/**
 * THE LOOP'S REQUEST STEP: answer the requests whose run ended, then serve at
 * most one new request per tick (tickets #197, #364).
 *
 * A REQUEST STARTS THE AUTOMATION'S OWN RUN, as the rep's: the day's
 * extraction, narrowed to the customer whose chat was named and carrying the
 * re-read and the moved clock a steering session asked for, or the day's
 * post. The run goes on the batch lane like every run, so a customer's draft
 * never waits behind an operator's ask; the request names it and is answered
 * when it ends, with the executions its steps wrote — so what the row says is
 * what happened, and a restart in between leaves the run to finish and the
 * answer to come.
 *
 * IT NEVER THROWS FOR A ROW'S SAKE. The loop is fail-stop by doctrine
 * (`runtime.ts`), and that doctrine is about a seam this runtime cannot read —
 * not about a person mistyping a parameter. Anything a request can do to itself
 * lands as `refused`; anything the runtime cannot do for it lands as `failed`;
 * both leave the loop running.
 */
export async function serveRuntimeRequests(deps: RunDeps, now: Date): Promise<void> {
  await answerEndedRequests(deps, now);
  const request = await takeNextRequest(deps, now);
  if (request === undefined) return;
  const parameters = parseParameters(request);
  if (!parameters.ok) {
    await settleRequest(deps, request.id, now, refusal(parameters.reason));
    return;
  }
  if (!(await railIsLinked(deps))) {
    await settleRequest(deps, request.id, now, refusal("rail_not_linked"));
    return;
  }
  try {
    const shipped = await shippedAutomationOf(deps.db, deps.twinId, request.occasion);
    if (shipped !== undefined && (await automationPaused(deps.db, shipped.seatId, shipped.id))) {
      await settleRequest(deps, request.id, now, refusal("automation_paused"));
      return;
    }
    let inputs: Readonly<Record<string, RunValue>> = { request: request.id };
    if (request.occasion === "daily_disclosure") {
      // THE DAY'S ACCOUNT WAITS FOR ITS OWN DAY: a steering clock later than
      // the real day would post a day the rep has not lived.
      if (parameters.now !== undefined && isLaterRepDay(parameters.now, now, deps.timeZone)) {
        await settleRequest(deps, request.id, now, refusal("day_not_lived"));
        return;
      }
      // THE DAY ASKED FOR — the rep's clock, moved to an earlier day when the
      // request names one — is the day every check below reads and the day
      // the run posts (Codex r2).
      const day = parameters.now ?? now;
      // A DAY STILL BEING READ IS NOT A DAY TO ACCOUNT FOR (ADR-0016's cut):
      // an extraction run going, or a chat with traffic nobody has read.
      if ((await extractionGoing(deps)) || !(await daySettled(extractionDepsOf(deps, deps.db), day))) {
        await settleRequest(deps, request.id, now, refusal("chat_in_flight"));
        return;
      }
      // NOTHING OWED, OR ALREADY ATTEMPTED THAT DAY: served, with nothing created.
      if (!(await dayOwed(disclosureDepsOf(deps, deps.db), day))) {
        await settleRequest(deps, request.id, now, servedWith(0));
        return;
      }
      if (parameters.now !== undefined) inputs = { ...inputs, now: parameters.now.toISOString() };
    } else {
      inputs = {
        ...inputs,
        // THE CUSTOMER BY THEIR REFERENCE, never the chat's address: a run's
        // inputs are what its steps are shown.
        ...(request.chatJid === undefined ? {} : { chat: `[c${String(deps.bundle.referenceForChat(request.chatJid))}]` }),
        ...(parameters.reextract ? { reextract: true } : {}),
        // THE REP'S CLOCK, MOVED: the day the read is filed under. The seam's
        // own clock stays the step's, so a watermark is never written ahead
        // of the messages that exist (#57 finding 5).
        ...(parameters.now === undefined ? {} : { now: parameters.now.toISOString() }),
      };
    }
    const started = await startRequestedRun(deps, request, inputs, now);
    // NO RUN STARTED: the seat cannot act — the gate's hold — or the row this
    // build fires is not there to start one from.
    if (!started) {
      await settleRequest(
        deps,
        request.id,
        now,
        shipped === undefined
          ? { outcome: "failed", reason: "pass_failed", executions: 0, unclaimed: 0 }
          : refusal("rail_not_linked"),
      );
    }
  } catch {
    // THE RUNTIME COULD NOT SERVE IT. The thrown value is not bound: `reason`
    // is a closed word by design, so there is nowhere on this row to put a
    // message, and the loop going on is what the outcome is for.
    await settleRequest(deps, request.id, now, {
      outcome: "failed",
      reason: "pass_failed",
      executions: 0,
      unclaimed: 0,
    });
  }
}

/**
 * Starts the automation's run as the rep's and names it on the request, in
 * one transaction on a connection of its own: the run and the reference
 * commit together or not at all. Whether a run was started — the gate
 * holding (a seat that cannot act) starts none.
 */
async function startRequestedRun(
  deps: RunDeps,
  request: TakenRequest,
  inputs: Readonly<Record<string, RunValue>>,
  now: Date,
): Promise<boolean> {
  const client = await deps.executionPool.connect();
  try {
    return await withDbTransaction(client, async () => {
      const started = await startShippedRun(deps, client, request.occasion, inputs, now);
      if (started === undefined) return false;
      await client.query("UPDATE runtime_requests SET run_id = $2 WHERE id = $1", [request.id, started.runId]);
      return true;
    });
  } finally {
    client.release();
  }
}

/** Whether a run of this twin's extraction is going. */
async function extractionGoing(deps: RunDeps): Promise<boolean> {
  const going = await deps.db.query(
    `SELECT 1 FROM runs r JOIN automations a ON a.id = r.automation_id
      WHERE r.twin_id = $1 AND a.shipped = 'extraction' AND r.ended_at IS NULL LIMIT 1`,
    [deps.twinId],
  );
  return going.rows.length > 0;
}

/**
 * ANSWERS EVERY REQUEST WHOSE RUN ENDED: `served`, with how many executions
 * the run's agent steps and its children's wrote and the first of them — or
 * `failed` when the run failed, with the same count, so an operator can
 * reach every execution the ask paid for.
 */
async function answerEndedRequests(deps: RunDeps, now: Date): Promise<void> {
  const ended = await deps.db.query<{ id: string; state: string; executions: string; first: string | null }>(
    `SELECT q.id, r.state,
            (SELECT count(*) FROM run_steps s
              WHERE s.run_id IN (SELECT r.id UNION SELECT c.id FROM runs c WHERE c.parent_run_id = r.id)
                AND s.kind = 'agent' AND s.execution_id IS NOT NULL) AS executions,
            (SELECT s.execution_id FROM run_steps s
              WHERE s.run_id IN (SELECT r.id UNION SELECT c.id FROM runs c WHERE c.parent_run_id = r.id)
                AND s.kind = 'agent' AND s.execution_id IS NOT NULL
              ORDER BY s.ended_at NULLS LAST, s.execution_id LIMIT 1) AS first
       FROM runtime_requests q
       JOIN runs r ON r.id = q.run_id
      WHERE q.twin_id = $1 AND q.outcome IS NULL AND r.ended_at IS NOT NULL`,
    [deps.twinId],
  );
  for (const row of ended.rows) {
    await deps.db.query(
      `UPDATE runtime_requests
          SET outcome = $2, reason = $3, executions = $4, unclaimed = 0,
              execution_id = $5, settled_at = $6
        WHERE id = $1 AND outcome IS NULL`,
      [
        row.id,
        row.state === "failed" ? "failed" : "served",
        row.state === "failed" ? "pass_failed" : null,
        Number(row.executions),
        row.first,
        now,
      ],
    );
  }
}

/** A request served with nothing created, or with a count of executions. */
function servedWith(executions: number): RequestSettlement {
  return { outcome: "served", reason: undefined, executions, unclaimed: 0 };
}

/** A request nothing could be done for: no execution, and the word why. */
function refusal(
  reason: RuntimeRequestReason,
  unclaimed = 0,
): RequestSettlement {
  return { outcome: "refused", reason, executions: 0, unclaimed };
}

/**
 * ANSWERS THE REQUESTS THIS BUILD ENDED IN THE MIDDLE OF (tickets #197, #364).
 * Run once at start, beside the runtime's other restart-safe sweeps.
 *
 * A REQUEST TAKEN AND NEVER GIVEN A RUN IS UNREACHABLE: the poll selects on
 * `taken_at IS NULL`, stamped before the work so a row is never handed to two
 * ticks, so a process that ended between taking it and starting its run leaves
 * a row nothing will ever look at again. It is answered `failed`, with the one
 * word that says what happened to it. A request whose run was started is left
 * alone: the run is a row of its own, the engine takes it up again after a
 * restart, and the request is answered when it ends.
 *
 * ONE PROCESS IS ASSUMED, as everywhere else in this runtime (spec #171
 * decision 3).
 */
export async function settleStrandedRequests(deps: { readonly db: pg.ClientBase; readonly twinId: string }, now: Date): Promise<void> {
  await deps.db.query(
    `UPDATE runtime_requests
        SET outcome = 'failed', reason = 'interrupted', settled_at = $2
      WHERE twin_id = $1 AND taken_at IS NOT NULL AND outcome IS NULL AND run_id IS NULL`,
    [deps.twinId, now],
  );
}

/**
 * Takes the oldest unserved request for this twin, whichever occasion it is,
 * stamping `taken_at` in the same statement.
 *
 * ONE STATEMENT, AND `FOR UPDATE SKIP LOCKED` IS WHY. Taking is a read and a
 * write about the same row, and two runtimes on one database — a rig session
 * beside a second process, which is exactly what the process-level lease is
 * still owed for (slice 7) — would otherwise each read the row as unserved and
 * each serve it, paying for two model calls over one ask.
 *
 * IT IS STAMPED BEFORE THE WORK, not after, and that ordering is deliberate: a
 * request taken by a process that then dies stays taken with no outcome, and
 * the requester times out. The alternative — stamping after — would hand the
 * same row to every subsequent tick and re-read the day on each one.
 *
 * BOTH OCCASIONS, IN `requested_at` ORDER (ticket #198). The filter is gone
 * with the automation that posts: every word the store's CHECK holds is a word
 * this loop can serve, so there is nothing to leave untaken and nothing to
 * refuse for want of a server.
 */
async function takeNextRequest(
  deps: { readonly db: pg.ClientBase; readonly twinId: string },
  now: Date,
): Promise<TakenRequest | undefined> {
  const taken = await deps.db.query<{
    id: string;
    occasion: RuntimeRequestOccasion;
    chat_jid: string | null;
    parameters: unknown;
  }>(
    `UPDATE runtime_requests
        SET taken_at = $2
      WHERE id = (
              SELECT id
                FROM runtime_requests
               WHERE twin_id = $1
                 AND taken_at IS NULL
               ORDER BY requested_at, id
               LIMIT 1
              FOR UPDATE SKIP LOCKED
            )
      RETURNING id, occasion, chat_jid, parameters`,
    [deps.twinId, now],
  );
  const row = taken.rows[0];
  if (row === undefined) return undefined;
  return {
    id: row.id,
    occasion: row.occasion,
    chatJid: row.chat_jid ?? undefined,
    parameters: row.parameters,
  };
}

/**
 * Reads the request's document into the steering the pass understands, or names
 * the word that refuses it.
 *
 * IT IS THE FAIL-CLOSED READER, not the gate: the store's own CHECKs already
 * refused an undeclared key, a non-boolean re-read and anything not shaped like
 * an instant, at the INSERT. What is left here is what a CHECK cannot judge —
 * and this is the one place in the process where a value arrives from outside
 * every type in it, because the store holds `jsonb`.
 *
 * `parseIsoInstant` RATHER THAN `new Date` (Codex r1). The rig's own clock
 * variable is read through that function so a zoneless string and an impossible
 * calendar day are refused rather than normalized — `new Date` turns February
 * 31st into March 3rd and reads an offset-free timestamp in the host's zone,
 * either of which files the run under a day nobody asked for. A request is
 * steering, so it is held to the steering rule.
 *
 * AN EXPLICIT `null` IS NOT AN ABSENCE. `?? false` would have read
 * `{"reextract": null}` as "no re-read asked for" and served the request as an
 * ordinary one, which is the mistyped-flag failure one level up.
 */
function parseParameters(request: TakenRequest): ParsedParameters {
  const parameters = request.parameters;
  if (
    parameters === null ||
    typeof parameters !== "object" ||
    Array.isArray(parameters)
  ) {
    return { ok: false, reason: "malformed_parameter" };
  }
  const document = parameters as Record<string, unknown>;
  // WHAT AN OCCASION CANNOT USE IS REFUSED BY THE LOOP, NOT BY THE STORE
  // (ticket #198). The store's fences exist to stop CONTENT being written
  // (`…20260906100020`'s four CHECKs), and neither of these carries any: a
  // re-read is a boolean and a chat selector is an address. What they are is
  // MEANINGLESS for a day's post — there is one post per twin per day, and it
  // is not a chat's — and "a value the store's shape rules admit and this
  // runtime cannot use" is exactly what `malformed_parameter` says. Keeping it
  // here also means a third occasion needs no new constraint on a table whose
  // rules a reader already has to hold five of.
  if (request.occasion === "daily_disclosure") {
    if ("reextract" in document) {
      return { ok: false, reason: "malformed_parameter" };
    }
    if (request.chatJid !== undefined) {
      return { ok: false, reason: "malformed_parameter" };
    }
  }
  let reextract = false;
  if ("reextract" in document) {
    if (typeof document["reextract"] !== "boolean") {
      return { ok: false, reason: "malformed_parameter" };
    }
    reextract = document["reextract"];
  }
  if (!("now" in document)) return { ok: true, now: undefined, reextract };
  const clock = document["now"];
  if (typeof clock !== "string") {
    return { ok: false, reason: "malformed_parameter" };
  }
  const now = parseIsoInstant(clock);
  if (now === undefined) {
    return { ok: false, reason: "malformed_parameter" };
  }
  return { ok: true, now, reextract };
}

/**
 * Whether this twin's rail is linked, off the plane's own status seam
 * (`rail_status_events`, ADR-0005 job 3).
 *
 * THE LAST TRANSITION IS THE ANSWER, in emission order, which is the same
 * reading `rig-link-verify.sh` makes of these rows. A twin with no events at
 * all has never linked; one whose last event is `qr`, `dropped` or
 * `logged_out` is not linked now.
 *
 * WHY A REQUEST NEEDS IT AND THE CLOCK DOES NOT. The clock fires every day and
 * simply reads nothing when there is nothing; a request
 * is one person asking one question and expecting an answer, and "nothing was
 * owed" is the wrong answer to give when the truth is that the rail is down and
 * no traffic has arrived to owe anything.
 */
async function railIsLinked(deps: { readonly db: pg.ClientBase; readonly twinId: string }): Promise<boolean> {
  const latest = await deps.db.query<{ status: string }>(
    `SELECT status
       FROM rail_status_events
      WHERE twin_id = $1
      ORDER BY id DESC
      LIMIT 1`,
    [deps.twinId],
  );
  return latest.rows[0]?.status === "linked";
}

/** Writes what became of one ask — the row's one and only settle. */
async function settleRequest(
  deps: { readonly db: pg.ClientBase; readonly twinId: string },
  requestId: string,
  now: Date,
  settlement: RequestSettlement,
): Promise<void> {
  await deps.db.query(
    `UPDATE runtime_requests
        SET outcome = $2, reason = $3, executions = $4, unclaimed = $5,
            settled_at = $6
      WHERE id = $1`,
    [
      requestId,
      settlement.outcome,
      settlement.reason ?? null,
      settlement.executions,
      settlement.unclaimed,
      now,
    ],
  );
}



