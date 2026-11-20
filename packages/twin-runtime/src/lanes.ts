/**
 * THE TWO LANES OF ONE RUNTIME PROCESS (ticket #173; spec #171 decision 3;
 * ADR-0010 as amended 2026-09-04).
 *
 * ADR-0010 says all bundle work routes to the one holder. It does not say the
 * holder does one thing at a time, and until this ticket it did: every
 * execution ran inside the routing loop, so a rep asking their twin something
 * waited on whatever draft happened to be in front of them. The amendment
 * names the shape that fixes it — "the runtime process runs executions
 * concurrently over its one open bundle in two lanes: a realtime lane
 * (drafting, the twin thread, entity kind) and a batch lane (extraction, the
 * disclosure; capped at one execution at a time)".
 *
 * WHAT A LANE IS, AND WHAT IT IS NOT. It is a scheduler: bounded concurrency
 * over `() => Promise<void>`, plus one `settle()` that awaits everything and
 * then throws the first failure. It holds no connection, opens no
 * transaction, borrows nothing and knows nothing about Postgres or the
 * bundle. The connection an execution runs its transaction on is borrowed
 * inside the task the consumer submits (`withExecutionClient` in
 * `consumer.ts`), which keeps the borrow and its release in one place and
 * leaves this file testable with no database at all.
 *
 * WHY EXECUTIONS MAY INTERLEAVE OVER ONE BUNDLE AT ALL. The bundle is a
 * single synchronous SQLCipher connection, so every statement it runs is
 * atomic against the others by construction: JavaScript is one thread and
 * `better-sqlite3` does not yield inside a statement. What interleaves is the
 * awaits — the model call, above all — and bundle writes stay short
 * transactions, which is the amendment's own condition.
 *
 * THE POSTGRES CONDITION, WHICH IS THE HARDER ONE. Every execution runs its
 * model call inside an open transaction (`runDraftingExecution`, and the
 * thread's own), because the runner appends this execution's audit entry
 * before it returns or throws and that entry has to commit with the record
 * (ADR-0020). Two executions interleaving on ONE connection would therefore
 * issue their statements into each other's open transaction — and `pg` queues
 * queries per client, so nothing would even error: one execution's COMMIT
 * would commit the other's half-written work. So **no transaction may be open
 * across a model call on a shared connection**, and the answer this ticket
 * takes is that each execution runs its whole transaction on its OWN
 * connection, borrowed for exactly that long. The runtime's dedicated client
 * keeps doing routing, the settle predicate, the markers of every sequential
 * outcome and every read a pass makes before it submits anything.
 *
 * THE ROUTE NOT TAKEN, recorded because it is the one a reader will ask
 * about: run the model call outside any transaction and write the record, the
 * entry and the effects afterwards in one short transaction under a lane
 * mutex. It needs only one connection, and it is rejected because the mutex
 * would have to cover every OTHER statement of the pass too — the routing
 * writes, the superseded markers, the settle reads — since any of them
 * issued on the shared client while a mutex-held transaction was open would
 * join it, and a `markAll` issuing its own `BEGIN` inside one would commit
 * somebody else's work. That is a discipline every future call site has to
 * remember, where a borrowed connection is a fact the type carries.
 *
 * THE LEASE IS NOT THIS TICKET'S. Two lanes make no claim across processes
 * (spec #171 decision 3: "the process-level lease is slice 7's"), and nothing
 * here changes that: a second runtime on the same bundle was broken before
 * this ticket and is broken after it.
 */

/**
 * How many executions the realtime lane may have in flight at once.
 *
 * FOUR, AND IT IS A JUDGEMENT WITH REASONS. NFR-2 (ADR-0016) is about ONE
 * turn's latency — about a minute from the runtime's pick-up to the post — and
 * not about throughput, so the cap is not a performance knob: it is the bound
 * on how much a single pass may have outstanding. Four is what a pass
 * realistically produces at once on one twin: a rep's thread message and up
 * to a handful of customer chats settling in the same two-second poll. Below
 * that, a rep who types while three chats settle is queued behind them, which
 * is the exact complaint this ticket answers. Far above it buys nothing —
 * there is no fifth thing a pass has to do concurrently — and costs
 * real things: each in-flight execution holds a Postgres connection
 * idle-in-transaction for the length of a model call, and every one of them is
 * a model call being paid for whether or not the pass needed it done now.
 *
 * IT IS NOT A PER-TWIN SETTING, for the reason `SETTLE_WINDOW_MS` is not: no
 * evidence exists that any two reps want a different figure, and a knob
 * nobody turns is a knob that lies. The composition root sizes its connection
 * source from this constant instead, so the two cannot disagree.
 */
export const REALTIME_LANE_CAP = 4;

/**
 * How many executions the batch lane may have in flight at once.
 *
 * ONE, and it is the spec's own word rather than a judgement: "a batch lane
 * (extraction, the disclosure; capped at one execution at a time)". The
 * reason is in the same decision — the batch lane's work is a day's worth of
 * chats, and running two of them at once would take the latency budget the
 * realtime lane is for.
 *
 * ITS OCCUPANTS ARE THE STEPS OF RUNS (tickets #194, #198, #323, #364; spec
 * #193 decision 25): the day's extraction and its post among them. Each is
 * submitted here and the loop returns to its realtime work, and one at a time
 * is why a run's step never waits on another's model call for longer than one
 * execution.
 */
export const BATCH_LANE_CAP = 1;

/** One lane: submit executions, then settle the pass. */
export interface Lane {
  /** How many this lane may have in flight — its own constant, for a reader. */
  readonly cap: number;
  /**
   * Submits one execution. It starts as soon as the lane is under its cap,
   * and nothing about it is awaited here: a pass submits and carries on
   * routing, which is what puts two model calls in flight at once.
   */
  submit(execution: () => Promise<void>): void;
  /** How many submitted executions have not finished. */
  inFlight(): number;
  /**
   * Awaits every execution submitted since the last settle, then throws the
   * FIRST failure in submission order.
   *
   * ALL OF THEM SETTLE BEFORE ANYTHING THROWS. `Promise.allSettled`, never
   * `Promise.all`: one execution's failure must not leave the execution
   * beside it half-written, and with `Promise.all` the pass would throw while
   * the other was still inside its transaction — its commit landing after the
   * caller had already decided the pass was over.
   *
   * THE FIRST FAILURE IN SUBMISSION ORDER, not the first to happen. A pass
   * that fails must fail the same way when it is re-run, and submission order
   * is a property of the pass's own input where completion order is a race.
   */
  settle(): Promise<void>;
}

/** The two lanes of one pass. */
export interface Lanes {
  readonly realtime: Lane;
  readonly batch: Lane;
}

/**
 * Opens the two lanes.
 *
 * ONE VALUE PER PASS, and the consumer opens it inside
 * `processPendingWaEvents`. That is what makes "the runtime loop stays
 * sequential across passes; concurrency lives inside one pass" structural
 * rather than remembered: a lane cannot outlive the pass that opened it, so
 * no execution of one pass can still be in flight when the next begins.
 *
 * THE BATCH LANE IS THE EXCEPTION, and it opens elsewhere (`openBatchLane`).
 */
export function openLanes(): Lanes {
  return { realtime: openLane(REALTIME_LANE_CAP), batch: openLane(BATCH_LANE_CAP) };
}

/**
 * Opens a batch lane on its own, for a caller that keeps one across passes
 * (ticket #194).
 *
 * IT HAS TO OUTLIVE THE PASS, which is the one thing `openLanes` above says a
 * lane must not do — and the reason is the difference between the two lanes
 * rather than an exemption. The realtime lane's work belongs to the pass that
 * submitted it: a draft answers a turn this pass read, and the pass settles
 * before it ends. The batch lane's work is the opposite by construction — a
 * run's step is submitted precisely so the loop can return to drafting while
 * a day is being read — so a lane settled at the end of the tick would be a
 * lane that waited, which is the thing it exists not to do. `BatchWork` below
 * says what replaces the protection `openLanes` gave.
 */
export function openBatchLane(): Lane {
  return openLane(BATCH_LANE_CAP);
}

/**
 * THE BATCH LANE, ONE VALUE PER RUNTIME, NOT PER PASS (tickets #194, #198,
 * #364; spec #193 decision 25; ADR-0010 as amended), and that is the one place
 * the batch lane departs from `openLanes`'s rule ("a lane cannot outlive the
 * pass that opened it"). It has to: the whole point of this lane is that a
 * run's step OUTLIVES the tick that submitted it, so the loop can return to
 * drafting instead of waiting on a model call.
 *
 * WHAT REPLACES THE PROTECTION the rule gave is the runs engine's own claim on
 * a run (`RunEngine.claim`): a run whose step is on the lane is not handed to
 * it again by the next pass.
 */
export interface BatchWork {
  readonly lane: Lane;
}

/** Opens the runtime's batch lane. */
export function openBatchWork(): BatchWork {
  return { lane: openBatchLane() };
}

/**
 * Whether the batch lane is holding nothing at all.
 *
 * THE TICK ASKS THIS TWICE AND BOTH ANSWERS MATTER. It gates the day's post —
 * a day still being read must not be posted (`runs/preconditions.ts`) — and it
 * gates `lane.settle()`, which AWAITS what is outstanding: settling while a
 * step runs is exactly the wait this lane exists to avoid, and it would put a
 * model call back on the loop that drafts.
 */
export function batchIsIdle(work: BatchWork): boolean {
  return work.lane.inFlight() === 0;
}

function openLane(cap: number): Lane {
  // The semaphore: how many slots are free, and who is waiting for one.
  let free = cap;
  const waiting: (() => void)[] = [];
  // Every execution submitted since the last settle. Each promise NEVER
  // rejects out of `run` — the rejection is caught and returned — so the
  // list can be awaited without a handler race and Node never sees an
  // unhandled rejection between `submit` and `settle`.
  let pending: Promise<{ readonly failure?: unknown }>[] = [];
  // Submitted and not yet finished, waiting for a slot or running.
  let unfinished = 0;

  const acquire = async (): Promise<void> => {
    if (free > 0) {
      free -= 1;
      return;
    }
    await new Promise<void>((resolve) => waiting.push(resolve));
  };

  // THE SLOT IS HANDED TO THE NEXT WAITER, never returned to the count and
  // taken again. Incrementing `free` and letting the woken task decrement it
  // leaves a window where a fresh `submit` sees the slot too, and the cap
  // quietly becomes cap + 1 under exactly the load it exists to bound.
  const release = (): void => {
    const next = waiting.shift();
    if (next === undefined) free += 1;
    else next();
  };

  const run = async (
    execution: () => Promise<void>,
  ): Promise<{ readonly failure?: unknown }> => {
    await acquire();
    try {
      await execution();
      return {};
    } catch (failure) {
      return { failure };
    } finally {
      unfinished -= 1;
      release();
    }
  };

  return {
    cap,
    submit(execution: () => Promise<void>): void {
      unfinished += 1;
      pending.push(run(execution));
    },
    inFlight(): number {
      return unfinished;
    },
    async settle(): Promise<void> {
      // CLEARED BEFORE THE THROW, so a pass that reported a failure does not
      // report it again on the next settle. A lane is per pass, so this only
      // matters for a caller that settles twice — and the honest answer for
      // one is "nothing is outstanding".
      const outcomes = await Promise.allSettled(pending);
      pending = [];
      for (const outcome of outcomes) {
        // `run` never rejects, so every outcome is fulfilled; the value is
        // where a failure lives. `{}` has no `failure` key at all, which is
        // how a rejection whose reason IS `undefined` still reads as one.
        if (outcome.status === "fulfilled" && "failure" in outcome.value) {
          throw outcome.value.failure;
        }
      }
    },
  };
}
