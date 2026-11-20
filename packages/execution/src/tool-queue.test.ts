/**
 * The queue one run's tool calls take their turn in (ticket #205).
 *
 * TESTED AT ITS OWN BOUNDARY, because the claim is about ORDER and about
 * nothing else: the two facts a savepoint depends on are that a second run
 * does not begin while the first is in flight, and that a throw belongs to
 * its own caller rather than wedging everything queued behind it. Both are
 * observable from outside with no database and no model — which is why the
 * queue is pure and lives here (`tool-queue.ts`).
 */
import { describe, expect, it } from "vitest";
import { oneAtATime } from "./tool-queue.js";

/** A promise this suite decides the moment of, so no test waits on a clock. */
function gate(): { readonly opened: Promise<void>; open: () => void } {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

describe("a queue of one (ticket #205)", () => {
  it("runs what it is handed one at a time, in the order it was handed them", async () => {
    const inTurn = oneAtATime();
    const gates = [gate(), gate(), gate()];
    const finished: string[] = [];
    let inFlight = 0;
    let most = 0;

    const runs = ["first", "second", "third"].map((name, at) =>
      inTurn(async () => {
        inFlight += 1;
        most = Math.max(most, inFlight);
        await gates[at]!.opened;
        inFlight -= 1;
        finished.push(name);
      }),
    );

    // OPENED BACKWARDS, which is what makes the green a result: three runs
    // in flight at once would finish in the order their gates opened.
    gates[2]!.open();
    gates[1]!.open();
    gates[0]!.open();
    await Promise.all(runs);

    expect(finished).toEqual(["first", "second", "third"]);
    expect(most).toBe(1);
  });

  it("hands a failure to its own caller and still gives the next run its turn", async () => {
    const inTurn = oneAtATime();
    const ran: string[] = [];

    const failing = inTurn(async () => {
      ran.push("refused");
      throw new Error("the read refused");
    });
    const after = inTurn(async () => {
      ran.push("after");
      return "its own answer";
    });

    await expect(failing).rejects.toThrow("the read refused");
    await expect(after).resolves.toBe("its own answer");
    expect(ran).toEqual(["refused", "after"]);
  });

  it("keeps two queues out of each other's way", async () => {
    // Two executions on two connections must not wait on each other, which
    // is the whole reason a queue is made per run rather than per module.
    const held = gate();
    const first = oneAtATime();
    const second = oneAtATime();

    const waiting = first(() => held.opened);
    await expect(second(async () => "not waiting")).resolves.toBe("not waiting");
    held.open();
    await waiting;
  });
});
