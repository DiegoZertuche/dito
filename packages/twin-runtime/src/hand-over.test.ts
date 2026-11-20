/**
 * THE PASS'S PLACES (ticket #358; `hand-over.ts`): each turn may hand itself
 * to the day's session only after the one submitted before it has — or ended
 * without reaching it.
 */
import { describe, expect, it } from "vitest";
import { HandOverOrder } from "./hand-over.js";

describe("a pass hands its turns over in the order it submitted them", () => {
  it("holds the second place until the first is handed, whichever asks first", async () => {
    const order = new HandOverOrder();
    const first = order.next();
    const second = order.next();
    const handed: string[] = [];
    const late = second.ready.then(() => handed.push("second"));
    await Promise.resolve();
    expect(handed).toEqual([]);
    await first.ready;
    handed.push("first");
    first.handed();
    await late;
    expect(handed).toEqual(["first", "second"]);
  });

  it("lets a place be handed twice, and frees the next either way", async () => {
    const order = new HandOverOrder();
    const first = order.next();
    const second = order.next();
    first.handed();
    first.handed();
    await second.ready;
    second.handed();
    await order.next().ready;
  });
});
