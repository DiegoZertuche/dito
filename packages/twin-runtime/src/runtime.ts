/**
 * The runtime loop: the seam consumer on a poll interval. Deliberately
 * thin — one twin, one consumer, everything interesting lives in
 * processPendingWaEvents.
 *
 * FAIL-STOP IS FOR INFRASTRUCTURE, NEVER FOR CONTENT (ADR-0042; ticket #240).
 * What propagates and stops this loop is a seam this runtime cannot read or
 * write, a bundle it cannot open, a key it cannot use, a bug in this build: a
 * broken rig, never something to spin past — the plane's own seam-write
 * doctrine. An execution that could not FINISH is the other class: a model
 * that will not submit, a refusal chain, a tool that throws on its input is
 * recorded on its own `executions` row with its chain entry, its trigger is
 * consumed so no pass asks again, and the loop carries on.
 * `execution-failure.ts` argues the line. The kind classification is the one
 * realtime occasion that still stops the loop, and `runEntityKindExecution`
 * says what makes it different.
 */
import { finalizeDueFacts } from "@dito/aperture";
import { embedMessageBacklog } from "./backlog.js";
import { processResolvedSends } from "./confirmations.js";
import { createRailWatch } from "./rail-watch.js";
import {
  kindModelOf,
  processPendingWaEvents,
  type TwinRuntimeDeps,
} from "./consumer.js";
import { crossPendingBindings } from "./crossing-backlog.js";
import {
  NOTEPAD_EDIT_SETTLE_AFTER_MS,
  settleUnaccountedNotepadEdits,
} from "./dashboard-acts.js";
import { drainSendRefusals } from "./send-lock/refusals.js";
import { batchIsIdle, openBatchWork, type BatchWork } from "./lanes.js";
import {
  serveRuntimeRequests,
  settleStrandedRequests,
} from "./runtime-requests.js";
import {
  announceRailTransition,
  deliverPendingKnocks,
} from "./notify-tiers.js";
import { createStreamWatch } from "./stream-watch.js";
import { reexpressStrayPosts } from "./posts.js";
import { linkSeatWhenRailLinked } from "./seat-state.js";
import { advanceRuns, createRunEngine, type RunEngine } from "./runs/engine.js";
import { fireDueReminders } from "./runs/reminders.js";
import { sweepRutinaContent } from "./runs/rutinas.js";
import { ensureShippedAutomations } from "./runs/shipped-automations.js";
import { fireDueCadences } from "./runs/wakes.js";

export interface RunTwinRuntimeOptions {
  /** Poll interval between passes (default 2000ms — well inside NFR-2's ~1-minute budget). */
  readonly pollIntervalMs?: number;
  /** Aborting stops the loop after the current pass; the run resolves cleanly. */
  readonly signal?: AbortSignal;
}

const DEFAULT_POLL_INTERVAL_MS = 2000;

/**
 * How long a dashboard-crossing sweep that changed nothing waits before it is
 * tried again (#224).
 *
 * FIFTEEN MINUTES, and the number is chosen from what the retry COSTS rather
 * than from how fast anybody wants it: a sweep that finds an undetermined
 * binding pays for a model call, so retrying on the two-second poll would
 * spend one every two seconds for ever. The rep's own next confirmation
 * triggers a sweep immediately whatever this says, so this interval only ever
 * governs the case where nobody has pressed anything and something is still
 * owed.
 */
const DASHBOARD_CROSSING_RETRY_MS = 15 * 60 * 1000;

/** Runs the consumer until aborted (resolves) or a pass fails (rejects). */
export async function runTwinRuntime(
  deps: TwinRuntimeDeps,
  options: RunTwinRuntimeOptions = {},
): Promise<void> {
  const { signal } = options;
  // Abort means abort: a signal already raised before the call starts no
  // work at all — the backlog included (the run resolves cleanly, as it
  // did when the loop's own guard was the first thing to execute).
  if (signal?.aborted ?? false) return;
  // The embedding backlog first (#32): a migrated bundle wakes with
  // history but no vectors, and no seam event will ever re-deliver that
  // history — one restart-safe pass makes it retrievable before the loop
  // starts consuming. New traffic embeds at ingest from here on.
  await embedMessageBacklog({ bundle: deps.bundle, embedder: deps.embedder });
  // The crossing backlog (#50), for the same reason: the steering install
  // is carried across slices, so this build wakes with bindings the rep
  // confirmed before the Ledger existed. Their confirmation events are
  // already marked processed, so no pass will ever cross them — one
  // restart-safe sweep files them from the seam evidence that is still
  // there, before the loop starts filing anything new against them.
  await crossPendingBindings({
    db: deps.db,
    bundle: deps.bundle,
    dek: deps.dek,
    twinId: deps.twinId,
    hmacKey: deps.hmacKey,
    harness: deps.harness,
    // THE KIND DETERMINATION DOES NOT RIDE THE EXTRACTION CONFIG (ticket
    // #148, Codex r1). It used to be `deps.extraction ?? deps.drafting`,
    // on the argument that a two-valued classification sits on the
    // extraction rung of ADR-0015's ladder (#60) — true of the MODEL, and
    // the coupling became a defect the moment that rung moved, because it
    // carried a 256-token harness onto a model that thinks first. #154
    // fixed the harness and moved this rung too, so both defaults now name
    // Sonnet 5; the separation stays, so that the next rung to move moves
    // alone.
    kindModel: kindModelOf(deps),
    // The seat's zone, for the classification's own «now» part. Unset means
    // the host clock, which is what the runtime's own deps mean by it.
    ...(deps.timeZone === undefined ? {} : { timeZone: deps.timeZone }),
  });
  // THE REQUESTS THIS BUILD ENDED IN THE MIDDLE OF (ticket #197), for the same
  // reason as the two sweeps above: an operator's ask that was TAKEN and never
  // settled is unreachable by the poll, which selects on an untaken row — so
  // nothing would ever look at it again and the requester's "ask again" would
  // have been a hope rather than a fact. Answered once, before the loop starts
  // taking new ones. `settleStrandedRequests` argues which runs go with it.
  await settleStrandedRequests(deps, new Date());
  // ...AND ANY TWIN POST THAT REACHED THE SEAM WITHOUT A POST ROW (ticket
  // #220, Codex r1). The documented upgrade order migrates and THEN restarts,
  // so a runtime that predates this build keeps writing notices and drafts in
  // between — and each of those would otherwise be invisible on the rep's
  // Inicio for ever, with every invariant green. `reexpressStrayPosts` argues
  // the whole of it; it is idempotent, so a start that finds nothing writes
  // nothing.
  await reexpressStrayPosts(deps);
  // THE BATCH LANE, OPENED ONCE FOR THE RUNTIME (ticket #194; spec #193
  // decision 25). It is the one lane that outlives a pass, and it has to: a
  // run's step is submitted precisely so this loop can return to drafting
  // while a day is being read. `lanes.ts` argues the exception.
  const batch = openBatchWork();
  // THE RUNS ENGINE, ONE FOR THE PROCESS (ticket #323): the composition
  // root's when it holds one, so the local API and the thread's tools reach
  // the same; otherwise composed here, before the loop's first pass.
  const live = deps.runs === undefined ? { ...deps, runs: createRunEngine() } : { ...deps, runs: deps.runs };
  try {
    await poll(live, options, batch);
  } finally {
    // THE LANE IS DRAINED WHATEVER ENDED THE LOOP (Codex r2). A realtime
    // execution that fails-stops rejects out of the pass while a run's step
    // is still on the batch lane — and the composition root then closes the
    // bundle, ends the execution pool and drops the connection under it, so
    // the step neither finishes nor records what happened. A `finally` is
    // what makes "abort means stop after the current pass" true of the batch
    // half too. A step's own failure ends its run `failed` and throws
    // nothing; what `settle` can throw is an infrastructure fault underneath
    // a step (`advanceRuns`).
    await batch.lane.settle();
  }
}

/** The loop itself, so the batch lane can be drained around it whatever ends it. */
async function poll(
  deps: TwinRuntimeDeps & { readonly runs: RunEngine },
  options: RunTwinRuntimeOptions,
  batch: BatchWork,
): Promise<void> {
  const interval = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const { signal } = options;
  // WHAT THE LAST DASHBOARD-CROSSING SWEEP SAW. Two scalars and an instant,
  // in memory and per process: they bound a retry rather than record a fact,
  // so a restart is a fresh attempt and nothing about them belongs in a
  // store (`uncrossedDashboardConfirmations` argues the bound).
  let lastSweep: { owed: number; newest: string | null; at: number } = {
    owed: 0,
    newest: null,
    at: 0,
  };
  // WHAT THE SEAT'S STREAM HAS ALREADY BEEN TOLD, in memory and per process
  // for the same reason (`stream-watch.ts` argues why a restart may forget).
  const watch = createStreamWatch();
  // ...AND WHAT THE TWIN THREAD HAS BEEN TOLD OF THE RAIL (`rail-watch.ts`).
  const rail = createRailWatch();
  // ...AND WHICH SEAT DITO'S OWN ROWS WERE LAST WRITTEN FOR, in memory and per
  // process: a restart writes them again, and writing them again changes
  // nothing.
  let shippedFor: string | undefined;
  while (!(signal?.aborted ?? false)) {
    const now = new Date();
    // THE SEAT'S ONE TRANSITION, FIRST (ticket #223; ADR-0032, FR-63). Link
    // day ends on a durable fact — `seats.state` reading `linked` — and the
    // rail's own row is what causes it, so the lease holder notices it here
    // rather than a page writing it (`seat-state.ts` argues who and why).
    //
    // ONE INDEXED STATEMENT, at the top of the pass, `crossPendingBindings`'
    // own shape: a pass with nothing to do costs one index probe, and the rep
    // is the person waiting on the answer. Ungated by the loop's fail-stop
    // doctrine like everything else here — a seam this runtime cannot write is
    // a broken rig, never something to spin past.
    await linkSeatWhenRailLinked({ db: deps.db, twinId: deps.twinId });
    // ...AND THE ONE THE REP HAS TO ACT ON (ticket #262; ADR-0031 as amended).
    // The rail dropping or being logged out is the one thing the dashboard
    // cannot tell a rep who is not looking at it, so code writes — an email
    // and a push, once per transition, in the character-silent register.
    //
    // BESIDE THE SEAT'S TRANSITION because it reads the same table and asks
    // the same kind of question: what does the rail's own latest row say, and
    // has this build already done something about it. One indexed read when
    // the rail is up, and `announceRailTransition` never throws for a
    // message's sake.
    await announceRailTransition(deps, now);
    // ...AND THE TWIN THREAD HEARS THE RAIL CHANGE (ticket #319), from the
    // same table's newest row: a `rail` event wakes a turn of the day.
    await rail.tick(deps);
    // DITO'S OWN AUTOMATIONS ARE ROWS FOR THE SEAT (ticket #364), written
    // once a process — the first pass that finds the seat — and again when
    // the seat changes: idempotent, and the pin and the hour this build ships
    // (`shipped-automations.ts`).
    shippedFor = await ensureShippedFor(deps, shippedFor, now);
    // WHAT THE REP ASKED FOR (ticket #197; spec #193 decision 26): a request
    // is a row on the seam, and serving one starts the automation's own run
    // as the rep's — on the batch lane, like every run — and answers the
    // requests whose run has ended. It never throws for a row's sake.
    await serveRuntimeRequests(deps, now);
    await processPendingWaEvents(deps);
    // THE CORRECTION WINDOW CLOSES (#54; ADR-0004). A fact nobody corrected
    // finalizes 24 hours after its disclosure line became REP-REACHABLE —
    // the post's `system_send` resolving `sent` — never 24 hours after it
    // was filed. The pass's one explicit `now`, from the one place a wall
    // clock is the right answer.
    //
    // EVERY PASS, NOT ON A CADENCE: a window can close at any minute of the
    // day, and this costs one indexed statement that annotates nothing when
    // nothing is due.
    //
    // AFTER the consumer, deliberately. A «N no» sitting in this pass's
    // batch is the rep's word about a fact whose window may be closing
    // right now, and processing it first means the correction wins. The
    // cost of that ordering is that a poison event starves finalization —
    // which is the benign direction, because a fact that has not finalized
    // is still correctable, while one finalized over the rep's own
    // correction is not.
    await finalizeDueFacts({ db: deps.db }, { twinId: deps.twinId }, now);
    // The confirmation sweep (#25): posts «Enviado a …» for customer
    // sends the executor resolved since the last pass.
    await processResolvedSends(deps);
    // THE CANVAS'S NEWS, TO AN OPEN PAGE (ticket #266; spec #258 decision 14):
    // every card that landed this pass, and a send the rail is holding or
    // gave back. AFTER THE CONFIRMATION SWEEP, the end of everything that
    // writes a post this pass, so a card born this tick is told this tick. It
    // reads only committed rows and never throws (`stream-watch.ts`).
    await watch.tick(
      {
        db: deps.db,
        twinId: deps.twinId,
        dek: deps.dek,
        bundle: deps.bundle,
        ...(deps.timeZone === undefined ? {} : { timeZone: deps.timeZone }),
        ...(deps.events === undefined ? {} : { events: deps.events }),
        ...(deps.threadSessions === undefined ? {} : { thread: deps.threadSessions }),
      },
      now,
    );
    // THE CLOCK AND THE RUNS (ticket #323; spec #318 decisions 22–26). Every
    // workflow run of the twin's that has not ended is asked of the
    // seat-state gate; a wait whose instant has come on the clock store is
    // fired, a run ready for its next step is handed to the batch lane, and a
    // cancelled one is ended with its report. AFTER THE STREAM WATCH, so a
    // card a run is waiting on that settled this pass is already settled
    // here; the run's own events reach the thread on the next pass, as every
    // event raised after the consumer does. One indexed read when no run is
    // going.
    await advanceRuns(deps, now, batch);
    // ...AND THE ONE CLOCK (tickets #325, #364; spec #318 decision 26 as
    // amended; ADR-0014): every active automation whose cadence has reached
    // an instant it has not fired for, and whose precondition holds — the
    // day's extraction and then its disclosure among them, at the seat's
    // disclosure hour — starts one run, behind the seat-state gate and its
    // switch, from the one `schedules` store; and every reminder row that came
    // due wakes the thread about a card about to lapse. AFTER THE ENGINE, so a
    // run fired here takes its first step at the next pass, as every run
    // started outside the engine does.
    await fireDueCadences(deps, now, batch);
    await fireDueReminders(deps, now);
    // ...AND THE CONTENT OF A RUTINA WHOSE ROW HAS ENDED (tickets #325,
    // #364): Descartar and a replacement mark the row ended in the act's own
    // transaction, and this deletes what the bundle held for it — after the
    // consumer, so every turn that wrote a rutina this pass has committed its
    // row (`rutinas.ts`).
    await sweepRutinaContent(deps.db, deps.bundle, deps.twinId);
    // THE AT-ONCE TIER (ticket #262; spec #258 decision 7). Every knock the
    // thread wrote that has no send about it yet goes to the seat's registered
    // browsers, in the twin's own words (`post_knocks`, ticket #358).
    //
    // AFTER THE CONFIRMATION SWEEP, which is the end of everything that WRITES
    // a post this pass: drafting, the thread, the disclosure and the
    // confirmations have all committed by here, so a post born this tick is
    // announced this tick rather than waiting two seconds for the next one.
    // The rep is the person waiting on the answer.
    //
    // THE SEND RECORD IS THE MEMORY and there is no marker of its own, so a
    // restart between the post and the send delivers and a restart after it
    // does not (`notify-tiers.ts` argues the whole mechanism). A deployment
    // with no notifier does nothing here at all.
    await deliverPendingKnocks(deps, now);
    // THE REFUSALS rep-web COULD NOT CHAIN (ticket #224; ADR-0002, ADR-0008).
    // The dashboard mints ADR-0006's second tap and therefore refuses one too
    // — a dismissed draft, a destination off the allowlist, a twin over its
    // pacing — and it holds no chain key, so it writes the record and the
    // lease holder owes the entry. Every pass rather than once at start,
    // because the rows are written by ANOTHER PROCESS while this one runs.
    //
    // ONE INDEXED READ WHEN THERE IS NOTHING TO DO (`send_refusals_unchained`
    // is partial on exactly this predicate), and it never throws for a row's
    // sake: `drainSendRefusals` argues why this one pass is outside the loop's
    // fail-stop doctrine.
    await drainSendRefusals(deps.db, deps.hmacKey);
    // ...AND THE NOTEBOOK SAVES WHOSE ACCOUNT NEVER LANDED (ticket #264, Codex
    // r2). A Mi libreta save commits its act row before the version and its
    // account after it, so a failure between the two leaves the act
    // unstamped; this settles it from what the bundle holds
    // (`performNotepadEdit` argues the order). One indexed read when nothing
    // is owed.
    await settleUnaccountedNotepadEdits(
      {
        db: deps.db,
        dek: deps.dek,
        twinId: deps.twinId,
        hmacKey: deps.hmacKey,
        bundle: deps.bundle,
      },
      new Date(now.getTime() - NOTEPAD_EDIT_SETTLE_AFTER_MS),
    );
    // ...AND THE BINDINGS THE REP CONFIRMED ON A CARD (ticket #224). A
    // dashboard confirmation is deterministic by construction — a button
    // carries no words — so it writes the binding to the entity mirror and
    // stops; filing the Ledger entity needs its KIND, which is a model call
    // with an occasion of its own on both surfaces. The thread's router hands
    // that classification to the realtime lane the moment it has the binding,
    // and this is the dashboard's equivalent.
    //
    // GATED ON ONE INDEXED READ, and the gate is what makes it affordable
    // every pass: `crossPendingBindings` enumerates the bundle's bindings, so
    // it is asked only when a dashboard confirmation really has no
    // `entity_create` line yet — which the partial unique index on
    // `disclosure_lines.dashboard_act_id` answers directly. Ordinarily zero
    // rows, exactly like the finalization pass beside it.
    //
    // AT STARTUP IT IS ALREADY COVERED: `crossPendingBindings` above resolves
    // both surfaces' confirmations, so this closes the LIVE gap rather than
    // the carried-across one.
    //
    // TWO REASONS TO SWEEP, AND NEITHER IS «EVERY PASS» (Codex r1 and r3,
    // both reachable failures). The classification can end UNDETERMINED — the
    // model refuses, or the run fails — and then no `entity_create` line is
    // written and the read above keeps answering «owed». Sweeping on that
    // alone would make the same model call every interval for the life of the
    // process: a cost with no cap, and a pass made longer for every other
    // twin. So the sweep runs when the answer CHANGED — a confirmation
    // arrived, or one crossed — and otherwise no more often than
    // `DASHBOARD_CROSSING_RETRY_MS`.
    //
    // COUNTED AND DATED RATHER THAN REMEMBERED BY ID. An earlier cut kept the
    // ids it had tried and excluded them in the predicate, which grew a
    // parameter the process sent on every idle poll — 390 KB of uuids at ten
    // thousand confirmations, by Codex's own measurement. Two scalars say the
    // same thing: the count moves when any act appears or crosses, and the
    // instant moves when a NEWER one appears, so a late-committing act with an
    // older stamp still changes the count. Nothing here grows.
    //
    // WHAT THE BOUND IS AND IS NOT, said exactly (Codex r2). One sweep visits
    // every uncrossed binding in the bundle, so this bounds SWEEPS and not
    // per-binding retries: a binding whose kind stays undetermined is asked
    // again when the next confirmation arrives, or after the interval. Both
    // are bounded; the per-binding backoff is recorded on #117.
    const owed = await uncrossedDashboardConfirmations(deps);
    const changed =
      owed.owed !== lastSweep.owed || owed.newest !== lastSweep.newest;
    const due = Date.now() - lastSweep.at >= DASHBOARD_CROSSING_RETRY_MS;
    if (owed.owed > 0 && (changed || due)) {
      lastSweep = { ...owed, at: Date.now() };
      await crossPendingBindings({
        db: deps.db,
        bundle: deps.bundle,
        dek: deps.dek,
        twinId: deps.twinId,
        hmacKey: deps.hmacKey,
        harness: deps.harness,
        kindModel: kindModelOf(deps),
        ...(deps.timeZone === undefined ? {} : { timeZone: deps.timeZone }),
      });
    }
    // THE BATCH LANE'S FINISHED WORK, CLEARED WHEN THERE IS NONE (ticket
    // #194). `settle` awaits everything submitted since the last settle and
    // empties its list, so calling it while nothing is outstanding costs a
    // microtask and stops the list growing by one promise per execution for
    // the life of the process. Guarded on what the lane holds rather than
    // called unconditionally, because settling while a step is running is
    // exactly the wait this lane exists to avoid. A step's own failure ends
    // its run `failed` and throws nothing; an infrastructure fault underneath
    // one surfaces here and stops the loop, as a realtime lane's does.
    if (batchIsIdle(batch)) await batch.lane.settle();
    await sleep(interval, signal);
  }
}

/**
 * Writes Dito's own rows for this twin's seat when the seat is one this
 * process has not written them for yet, and says which seat it has.
 */
async function ensureShippedFor(
  deps: TwinRuntimeDeps,
  done: string | undefined,
  now: Date,
): Promise<string | undefined> {
  const seat = await deps.db.query<{ id: string }>("SELECT id FROM seats WHERE twin_id = $1", [deps.twinId]);
  const seatId = seat.rows[0]?.id;
  if (seatId === undefined || seatId === done) return done;
  await ensureShippedAutomations(
    deps.db,
    {
      twinId: deps.twinId,
      seatId,
      ...(deps.disclosureHour === undefined ? {} : { disclosureHour: deps.disclosureHour }),
      ...(deps.timeZone === undefined ? {} : { timeZone: deps.timeZone }),
    },
    now,
  );
  return seatId;
}

/**
 * How many bindings the rep confirmed on a card are still uncrossed, and when
 * the newest of them was pressed.
 *
 * A COUNT AND AN INSTANT, NOT A LIST OF IDS (Codex r2 and r3, two reachable
 * failures). A repeat press is answered «already» and never acquires a create
 * line of its own — the first confirmation's line is the one that exists — so
 * such an act is owed for ever. A cut that remembered tried ids and filtered
 * them after a LIMIT let thirty-two such permanent rows fill the window and
 * hide every later confirmation until restart; a cut that excluded them in the
 * predicate sent a parameter that grew without bound on every idle poll.
 * These two numbers have neither problem: the count moves when any act
 * appears or crosses, including one that commits late with an older stamp, and
 * the instant distinguishes a new press from a crossed one.
 *
 * THE PREDICATE IS THE PARTIAL INDEX'S OWN. `disclosure_lines` gains
 * `dashboard_act_id` with a unique index over exactly
 * `subject_kind = 'entity_create' AND dashboard_act_id IS NOT NULL`
 * (…20260908100060), so "has this act's create been filed?" is an index probe
 * rather than a scan — which is what lets the sweep behind it be gated every
 * pass instead of run every pass.
 *
 * ONLY THE CONFIRMATIONS THAT STAND, which is what the outcome word is for.
 * An act refused because the chat was already bound, and a repeat press
 * answered «already», will never acquire a create line of their own — the
 * first confirmation's line is the one that exists — so a gate that counted
 * them would be true for the life of the twin and this sweep would run on
 * every pass for ever, which is the cost the gate exists to avoid. Every
 * committed act row carries its word: the stamp is in the act's own
 * transaction, so a crash between the two leaves no row at all.
 *
 * IT ASKS ABOUT THE LINE AND NOT THE LEDGER, and that is the wall: the entity
 * is company-side state and this runtime holds no privilege in that schema at
 * all (FR-71a; `sole-writer.test.ts` sweeps this package for a mention of
 * one). The disclosure line is the rep-side half the aperture writes in the
 * SAME transaction as the create, so its absence and the entity's are one
 * fact.
 */
async function uncrossedDashboardConfirmations(
  deps: TwinRuntimeDeps,
): Promise<{ owed: number; newest: string | null }> {
  const res = await deps.db.query<{ owed: string; newest: string | null }>(
    `SELECT count(*)::text AS owed,
            max(a.acted_at)::text AS newest
       FROM dashboard_acts a
      WHERE a.twin_id = $1 AND a.verb = 'confirm_binding'
        AND a.outcome IN ('performed', 'already')
        AND NOT EXISTS (
              SELECT 1 FROM disclosure_lines d
               WHERE d.dashboard_act_id = a.id
                 AND d.subject_kind = 'entity_create')`,
    [deps.twinId],
  );
  const row = res.rows[0]!;
  return { owed: Number(row.owed), newest: row.newest };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted ?? false) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
