/**
 * THE LANES (ticket #173; spec #171 decision 3; ADR-0010 as amended
 * 2026-09-04 — "the runtime process runs executions concurrently over its one
 * open bundle in two lanes").
 *
 * Four claims the Postgres seam cannot make cheaply, and one it cannot make
 * at all:
 *
 * 1. **The cap holds.** A lane never has more executions in flight than its
 *    own constant, whatever a pass submits.
 * 2. **Executions interleave at their awaits.** The point of the lane: two
 *    executions are both inside their model call at the same time, which is
 *    what makes a rep's answer not wait on a customer's draft.
 * 3. **One failure does not abort the others mid-flight.** `Promise.allSettled`
 *    rather than `Promise.all`, so an execution that fails never leaves the
 *    one beside it half-written.
 * 4. **The pass throws after all of them settle**, with the FIRST failure —
 *    which is what keeps `runtime.ts`'s fail-stop the same fail-stop it was.
 *
 * NOTHING IS MOCKED HERE AND NOTHING NEEDS TO BE. A lane is a scheduler over
 * `() => Promise<void>`: it holds no connection, opens no transaction and
 * knows nothing about Postgres. The connection an execution runs its
 * transaction on is borrowed by the consumer inside the task it submits
 * (`consumer.ts`'s `withExecutionClient`), which is why this suite runs in the
 * unit lane with no database at all — and why AC 6's real interleaving, over
 * two real connections and two real transactions, is proven at the seam in
 * `thread.int.test.ts` instead.
 */
import { describe, expect, it } from "vitest";
import { BATCH_LANE_CAP, batchIsIdle, openBatchWork, openLanes, REALTIME_LANE_CAP } from "./lanes.js";

/** A promise a test resolves by hand — the await an execution parks on. */
function deferred(): { promise: Promise<void>; release: () => void } {
  let release = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe("the two lanes are declared with their own caps (spec #171 decision 3)", () => {
  it("caps the realtime lane at an argued constant and the batch lane at one", () => {
    // The batch lane's cap is the spec's own word — "capped at one execution
    // at a time" — and the realtime lane's is argued in `lanes.ts`.
    expect(BATCH_LANE_CAP).toBe(1);
    expect(REALTIME_LANE_CAP).toBeGreaterThan(1);
    const lanes = openLanes();
    expect(lanes.realtime.cap).toBe(REALTIME_LANE_CAP);
    expect(lanes.batch.cap).toBe(BATCH_LANE_CAP);
  });
});

describe("the cap holds, whatever a pass submits", () => {
  it("never has more than its cap in flight", async () => {
    const lanes = openLanes();
    const parked = deferred();
    let running = 0;
    let highWater = 0;
    for (let i = 0; i < REALTIME_LANE_CAP + 3; i += 1) {
      lanes.realtime.submit(async () => {
        running += 1;
        highWater = Math.max(highWater, running);
        await parked.promise;
        running -= 1;
      });
    }
    // Let every task that CAN start, start — then look, before releasing.
    await Promise.resolve();
    await Promise.resolve();
    expect(running).toBe(REALTIME_LANE_CAP);
    parked.release();
    await lanes.realtime.settle();
    expect(highWater).toBe(REALTIME_LANE_CAP);
    expect(running).toBe(0);
  });

  it("runs the batch lane one execution at a time", async () => {
    const lanes = openLanes();
    const first = deferred();
    const order: string[] = [];
    lanes.batch.submit(async () => {
      order.push("first in");
      await first.promise;
      order.push("first out");
    });
    lanes.batch.submit(async () => {
      order.push("second in");
    });
    await Promise.resolve();
    await Promise.resolve();
    // The second has not started: one at a time is the whole cap.
    expect(order).toEqual(["first in"]);
    first.release();
    await lanes.batch.settle();
    expect(order).toEqual(["first in", "first out", "second in"]);
  });
});

describe("executions interleave at their awaits (ADR-0010 as amended)", () => {
  it("has both inside their own await at the same time", async () => {
    // THE CLAIM THE LANE EXISTS FOR. Both executions reach their await —
    // which is the model call in the real thing — before either finishes, so
    // a rep's answer is not queued behind a customer's draft.
    const lanes = openLanes();
    const drafting = deferred();
    const thread = deferred();
    const log: string[] = [];
    lanes.realtime.submit(async () => {
      log.push("drafting: calling the model");
      await drafting.promise;
      log.push("drafting: submitted");
    });
    lanes.realtime.submit(async () => {
      log.push("thread: calling the model");
      await thread.promise;
      log.push("thread: submitted");
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(log).toEqual([
      "drafting: calling the model",
      "thread: calling the model",
    ]);
    // ...and they may finish in either order: the thread's answer lands
    // first here, while the draft is still being written.
    thread.release();
    await Promise.resolve();
    await Promise.resolve();
    expect(log).toContain("thread: submitted");
    expect(log).not.toContain("drafting: submitted");
    drafting.release();
    await lanes.realtime.settle();
  });
});

describe("a failure stops the pass, and only after everything settles", () => {
  it("lets the executions beside it finish before it throws", async () => {
    const lanes = openLanes();
    const beside = deferred();
    let finished = false;
    lanes.realtime.submit(() => Promise.reject(new Error("the first failed")));
    lanes.realtime.submit(async () => {
      await beside.promise;
      // Reached only because the rejection above did not abort this one:
      // `Promise.allSettled`, never `Promise.all`.
      finished = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    beside.release();
    await expect(lanes.realtime.settle()).rejects.toThrow("the first failed");
    expect(finished).toBe(true);
  });

  it("throws the FIRST failure, in submission order", async () => {
    const lanes = openLanes();
    // The second rejects sooner in wall time; the first is still the one the
    // pass reports, because a pass's failure has to be reproducible from what
    // it was handed rather than from a race.
    lanes.realtime.submit(async () => {
      await Promise.resolve();
      await Promise.resolve();
      throw new Error("first submitted");
    });
    lanes.realtime.submit(() => Promise.reject(new Error("second submitted")));
    await expect(lanes.realtime.settle()).rejects.toThrow("first submitted");
  });

  it("settles clean when nothing was submitted, and again after it threw", async () => {
    const lanes = openLanes();
    await expect(lanes.realtime.settle()).resolves.toBeUndefined();
    lanes.realtime.submit(() => Promise.reject(new Error("boom")));
    await expect(lanes.realtime.settle()).rejects.toThrow("boom");
    // A settled lane holds nothing: a second settle does not re-throw a
    // failure the pass has already reported.
    await expect(lanes.realtime.settle()).resolves.toBeUndefined();
  });
});

describe("the batch lane says whether it holds anything (ticket #364)", () => {
  it("counts a step from its submit until it finishes, waiting or running, and the runtime reads it idle only at zero", async () => {
    const work = openBatchWork();
    expect(batchIsIdle(work)).toBe(true);
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    work.lane.submit(() => held);
    work.lane.submit(() => Promise.resolve());
    // ONE RUNNING, ONE WAITING FOR THE SLOT: both are on the lane.
    expect(work.lane.inFlight()).toBe(2);
    expect(batchIsIdle(work)).toBe(false);
    release();
    await work.lane.settle();
    expect(work.lane.inFlight()).toBe(0);
    expect(batchIsIdle(work)).toBe(true);
  });

  it("counts a step that failed as finished", async () => {
    const work = openBatchWork();
    work.lane.submit(() => Promise.reject(new Error("the step failed")));
    await expect(work.lane.settle()).rejects.toThrow("the step failed");
    expect(batchIsIdle(work)).toBe(true);
  });
});
