/**
 * A RUTINA'S PROPOSAL CARD, IN WORDS CODE RENDERS (ticket #386): when it runs,
 * its plan, and the thread's rendering of the card the rep accepts in prose.
 */
import { CHROME } from "@dito/copy";
import { describe, expect, it } from "vitest";
import { composeProposalPost } from "../posts.js";
import type { StepSpec } from "./definition.js";
import { PLAN_HEADING, planLines, REPLACES_LINE, whenRutinaRuns } from "./rutina-words.js";

const STEPS: readonly StepSpec[] = [
  { kind: "agent", name: "find", instructions: "List the customers the rep has not written to.", tools: ["search_memory"] },
  { kind: "wait", name: "pause", until: { after: { days: 2, hours: 1 } } },
  {
    kind: "if",
    name: "any",
    when: { field: "find.list", is: "present" },
    then: [{ kind: "post", name: "report", text: "find.list" }],
    else: [],
  },
] as unknown as readonly StepSpec[];

describe("when a rutina runs, in the copy package's words", () => {
  it("says a cadence by its weekdays and hour, and an event by what wakes it, its customer by the name given", () => {
    expect(whenRutinaRuns({ kind: "schedule", every: "week", weekdays: [5], atHour: 9 }, undefined)).toBe(
      `${CHROME["rutinas.every"]}viernes${CHROME["rutinas.atClock"]}09:00`,
    );
    expect(whenRutinaRuns({ kind: "schedule", every: "day", atHour: 18 }, undefined)).toBe(`${CHROME["rutinas.dailyAt"]}18:00`);
    expect(whenRutinaRuns({ kind: "trigger", event: "customer_message", customer: 3 }, "Sergio Ramos")).toBe(
      `${CHROME["rutinas.whenNamedWrites"]}Sergio Ramos`,
    );
    expect(whenRutinaRuns({ kind: "trigger", event: "card_settled" }, undefined)).toBe(CHROME["rutinas.whenCardSettles"]);
  });

  it("says the plan step by step — never a step's instructions — a branch's steps one level deeper", () => {
    expect(planLines(STEPS)).toEqual([
      { text: CHROME["trabajos.stepAgent"], depth: 0 },
      { text: `${CHROME["rutinas.waitFor"]}2 ${CHROME["rutinas.spanDays"]} 1 ${CHROME["rutinas.spanHour"]}`, depth: 0 },
      { text: CHROME["trabajos.stepIf"], depth: 0 },
      { text: CHROME["trabajos.stepPost"], depth: 1 },
    ]);
  });

  it("says on the phone, before the plan, that accepting it takes the place of a rutina the rep has (Codex r2)", () => {
    const composed = composeProposalPost({
      automationId: "66666666-6666-4666-8666-666666666666",
      name: "Clientes sin contacto",
      sentence: "Mejor te la mando a las 10.",
      mentions: [],
      when: "Cada viernes a las 10:00",
      plan: [{ text: CHROME["trabajos.stepAgent"], depth: 0 }],
      planHeading: PLAN_HEADING,
      replaces: true,
      replacesLine: REPLACES_LINE,
    });
    expect(composed.text.split("\n").slice(0, 3)).toEqual([
      "✳️ Mejor te la mando a las 10.",
      "Cada viernes a las 10:00",
      CHROME["rutinas.replaces"],
    ]);
  });
});

describe("the proposal card in the thread", () => {
  it("frames the twin's sentence with its names, then when it runs and the plan — and no instruction line", () => {
    const composed = composeProposalPost({
      automationId: "66666666-6666-4666-8666-666666666666",
      name: "Clientes sin contacto",
      sentence: "Cada viernes te digo a quién no le has escrito, como a [c4].",
      mentions: [{ reference: "c4", name: "Sra. Garza" }],
      when: whenRutinaRuns({ kind: "schedule", every: "week", weekdays: [5], atHour: 9 }, undefined),
      plan: planLines(STEPS),
      planHeading: PLAN_HEADING,
      replaces: false,
      replacesLine: REPLACES_LINE,
    });
    expect(composed.parts).toEqual([
      expect.objectContaining({ kind: "proposal", automationId: "66666666-6666-4666-8666-666666666666", replaces: false }),
    ]);
    expect(composed.text).toBe(
      [
        "✳️ Cada viernes te digo a quién no le has escrito, como a Sra. Garza.",
        `${CHROME["rutinas.every"]}viernes${CHROME["rutinas.atClock"]}09:00`,
        "",
        CHROME["rutinas.plan"],
        `· ${CHROME["trabajos.stepAgent"]}`,
        `· ${CHROME["rutinas.waitFor"]}2 ${CHROME["rutinas.spanDays"]} 1 ${CHROME["rutinas.spanHour"]}`,
        `· ${CHROME["trabajos.stepIf"]}`,
        `  · ${CHROME["trabajos.stepPost"]}`,
      ].join("\n"),
    );
  });
});
