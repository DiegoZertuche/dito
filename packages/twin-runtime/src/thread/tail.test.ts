/**
 * THE CARRIED TAIL, AS A FUNCTION OF THE TWO DOORS' ITEMS (ticket #319; spec
 * #318 decision 1).
 */
import { describe, expect, it } from "vitest";
import { CARRIED_TAIL_ITEMS, carriedTail, renderCarriedTail, type TailItem } from "./tail.js";

const ZONE = "America/Monterrey";

function item(
  minute: number,
  door: TailItem["door"],
  side: TailItem["side"],
  text: string,
): TailItem {
  return { door, side, text, at: new Date(Date.UTC(2026, 9, 2, 20, minute)) };
}

describe("the tail is the last lines of both doors, merged by time", () => {
  it("interleaves the two doors in the order they were said", () => {
    const tail = carriedTail([
      item(3, "dashboard", "rep", "y lo de Torres?"),
      item(1, "twin_thread", "rep", "¿qué quedó con Garza?"),
      item(4, "dashboard", "twin", "✳️ Torres pidió 10 cajas."),
      item(2, "twin_thread", "twin", "✳️ 40 cajas el jueves."),
    ]);
    expect(tail.map((line) => line.text)).toEqual([
      "¿qué quedó con Garza?",
      "✳️ 40 cajas el jueves.",
      "y lo de Torres?",
      "✳️ Torres pidió 10 cajas.",
    ]);
  });

  it("keeps the newest twenty, counted across both sides and both doors", () => {
    const many = Array.from({ length: 30 }, (_, at) =>
      item(at, at % 2 === 0 ? "twin_thread" : "dashboard", at % 3 === 0 ? "twin" : "rep", `line ${at}`),
    );
    const tail = carriedTail(many);
    expect(CARRIED_TAIL_ITEMS).toBe(20);
    expect(tail).toHaveLength(20);
    expect(tail[0]!.text).toBe("line 10");
    expect(tail.at(-1)!.text).toBe("line 29");
  });
});

describe("the carried message says what it is and carries the words as they were", () => {
  it("marks itself carried over and tags each line with its door, its time and who said it", () => {
    const text = renderCarriedTail(
      [item(1, "twin_thread", "rep", "¿qué quedó con Garza?"), item(2, "dashboard", "twin", "✳️ 40 cajas.")],
      ZONE,
    )!;
    const [heading, first, second] = text.split("\n");
    expect(heading).toMatch(/^\[Carried over: /);
    expect(first).toBe("[WhatsApp · Friday, Oct 2, 2026, 14:01:00 CST] the rep: ¿qué quedó con Garza?");
    expect(second).toBe("[dashboard · Friday, Oct 2, 2026, 14:02:00 CST] you: ✳️ 40 cajas.");
  });

  it("is nothing at all when there is nothing to carry", () => {
    expect(renderCarriedTail([], ZONE)).toBeUndefined();
  });
});
