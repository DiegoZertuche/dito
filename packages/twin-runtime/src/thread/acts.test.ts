/**
 * THE GATE ON EVERY REP-ACT TOOL, over the tool's own handler (ticket #174;
 * ADR-0003 as amended; ADR-0013's 2026-09-04 amendment).
 *
 * The ticket names four ids a rep-act tool must refuse — another message of
 * the rep's, a customer-chat message, a message from a different execution,
 * and none at all — and this is where they are refused, before anything is
 * read and before any store is touched. That ORDER is the claim: the
 * structural check is `input.evidence === deps.trigger.eventId` and nothing
 * else, so every wrong id fails one comparison against a value the runtime
 * already holds, and no wrong id can reach a row.
 *
 * WHICH IS WHY THE FIXTURE'S STORES ALL THROW (`testing/thread-deps.ts`).
 * A refusal that reached Postgres would fail this suite loudly rather than
 * pass quietly — so "nothing was read" is a property this file proves
 * rather than a sentence it asserts. The other half of the gate, the
 * aperture's own seam-row re-verification, runs only once an id has passed
 * the comparison, and is exercised where a seam exists
 * (`thread-acts.int.test.ts`).
 *
 * NOT WHAT EACH TOOL DOES. That is behaviour at the Postgres seam and is
 * tested there, through the execution, with real rows.
 */
import { describe, expect, it } from "vitest";
import type { EffectOutcome, ToolDeclaration } from "@dito/execution";
import { defineTool } from "@dito/execution";
import {
  FIXTURE_EVENT_ID,
  FIXTURE_SELF_CHAT,
  threadDeps,
} from "../testing/thread-deps.js";
import {
  ActSlot,
  declineBindingTool,
  dismissDraftTool,
  retractDisclosureLineTool,
  DECLINE_BINDING_TOOL,
  DISMISS_DRAFT_TOOL,
  REP_ACT_DECLARATIONS,
  RETRACT_DISCLOSURE_LINE_TOOL,
  THREAD_ACT_WORDS,
} from "./acts.js";
import type { ThreadDeps } from "./deps.js";
import { EVIDENCE_PARAMETER } from "./evidence.js";

/** Every rep-act tool, by name, with whatever it takes beyond its evidence. */
const TOOLS = [
  { name: DISMISS_DRAFT_TOOL, build: dismissDraftTool, extra: {} },
  { name: DECLINE_BINDING_TOOL, build: declineBindingTool, extra: {} },
  {
    name: RETRACT_DISCLOSURE_LINE_TOOL,
    build: retractDisclosureLineTool,
    extra: { line: 3 },
  },
] as const satisfies readonly {
  readonly name: string;
  readonly build: (deps: ThreadDeps) => ToolDeclaration;
  readonly extra: Readonly<Record<string, unknown>>;
}[];

/**
 * The four ids that are not this execution's trigger — the ticket's own
 * list, each named for what it is rather than for what it looks like.
 */
const WRONG_IDS: readonly { readonly what: string; readonly evidence: unknown }[] =
  [
    {
      what: "another message of the rep's own",
      evidence: "33333333-3333-4333-8333-333333333333",
    },
    {
      what: "a message from a customer chat",
      evidence: "44444444-4444-4444-8444-444444444444",
    },
    {
      what: "a message from a different execution",
      evidence: "55555555-5555-4555-8555-555555555555",
    },
    { what: "nothing at all", evidence: undefined },
  ];

/** One tool call's arguments, with whatever evidence the case is about. */
function call(
  extra: Readonly<Record<string, unknown>>,
  evidence: unknown,
): unknown {
  return evidence === undefined
    ? { ...extra }
    : { ...extra, [EVIDENCE_PARAMETER]: evidence };
}

describe("a rep-act tool acts only on this execution's own trigger", () => {
  for (const tool of TOOLS) {
    for (const wrong of WRONG_IDS) {
      it(`${tool.name} refuses ${wrong.what}, and reads nothing`, async () => {
        // Every store in these deps throws on any call, so a refusal that
        // touched one would surface here as an exception rather than as a
        // green.
        const outcome = (await tool.build(threadDeps()).run(
          call(tool.extra, wrong.evidence),
        )) as EffectOutcome;
        expect(outcome.performed).toBe(false);
        expect(outcome.told).toContain("refused");
        expect(outcome.told).toContain("the rep's own message");
        // NO WORD OF ITS OWN, so the marker stays the submission's: a
        // refusal on this axis is not an act the seam records, it is a call
        // that should never have been made.
        expect(outcome.act).toBeUndefined();
        expect(outcome.receipt).toBeUndefined();
      });
    }

    it(`${tool.name} refuses an evidence parameter that is not a string`, async () => {
      // The schema says string and the SDK validates nothing, so a number
      // is the missing case by another route and gets the same answer.
      const outcome = (await tool.build(threadDeps()).run(
        call(tool.extra, 7),
      )) as EffectOutcome;
      expect(outcome.performed).toBe(false);
    });

    it(`${tool.name} claims the turn's one act, whatever it then does`, async () => {
      // ONE ACT PER MESSAGE, claimed on the CALL (spec #171 decision 19).
      // The first call here refuses — its evidence is wrong — and the
      // second is refused for a different reason entirely, which is the
      // rule: a rep who asked for two things gets one act and a sentence
      // about the other, whether or not the first one worked.
      const deps = threadDeps();
      await tool.build(deps).run(call(tool.extra, "not-the-trigger"));
      const second = (await tool.build(deps).run(
        call(tool.extra, FIXTURE_EVENT_ID),
      )) as EffectOutcome;
      expect(second.performed).toBe(false);
      expect(second.told).toContain("already acted this turn");
      expect(second.told).toContain(tool.name);
    });
  }

  it("refuses a SECOND tool even when the first one is a different act", async () => {
    const deps = threadDeps();
    await dismissDraftTool(deps).run(call({}, "not-the-trigger"));
    const second = (await retractDisclosureLineTool(deps).run(
      call({ line: 3 }, FIXTURE_EVENT_ID),
    )) as EffectOutcome;
    expect(second.told).toContain(DISMISS_DRAFT_TOOL);
  });

  it("lets the right id past the comparison and into the aperture's own check", async () => {
    // THE NEGATIVE CONTROL. Every case above refuses, so this is what says
    // the comparison is a comparison rather than a closed door: the right
    // id gets PAST it, and the next thing it meets is the SECOND half of
    // the gate — `classifyApertureInput`, which finds no seam row under
    // this twin and demotes the act to class 1 (ADR-0003). The refusal is
    // therefore a different one, in different words, from the four above.
    const deps = threadDeps();
    const outcome = (await dismissDraftTool(deps).run(
      call({}, FIXTURE_EVENT_ID),
    )) as EffectOutcome;
    expect(outcome.performed).toBe(false);
    expect(outcome.told).toContain("could not be verified as theirs");
    expect(outcome.told).not.toContain("the rep's own message from this turn");
  });
});

describe("the one act a thread message gets", () => {
  it("hands the slot to the first claimer and names it to the second", () => {
    const slot = new ActSlot();
    expect(slot.claim("dismiss_draft")).toEqual({ ok: true });
    expect(slot.claim("retract_disclosure_line")).toEqual({
      ok: false,
      held: "dismiss_draft",
    });
  });

  it("is per execution, so two turns cannot spend each other's", () => {
    // The property the realtime lane makes load-bearing (`lanes.ts`): two
    // executions really do run at once over one bundle.
    const first = new ActSlot();
    const second = new ActSlot();
    first.claim("dismiss_draft");
    expect(second.claim("dismiss_draft")).toEqual({ ok: true });
  });
});

describe("every rep-act declaration can be constructed, and says what it is", () => {
  it("declares the evidence parameter under the gate that requires one", () => {
    // `assertToolDeclaration` refuses a `rep-evidenced` declaration whose
    // schema does not declare its named evidence parameter, or does not
    // require it — so this is that rule biting on the real declarations
    // rather than on a synthetic offender.
    for (const declaration of REP_ACT_DECLARATIONS) {
      expect(() =>
        defineTool({ ...declaration, run: () => REFUSED } as ToolDeclaration),
      ).not.toThrow();
      expect(declaration.inputSchema.required).toContain(EVIDENCE_PARAMETER);
      expect(
        Object.keys(declaration.inputSchema.properties ?? {}),
      ).toContain(EVIDENCE_PARAMETER);
    }
  });

  it("gates the two twin-side acts rep-evidenced and the two Ledger acts on the window", () => {
    // ADR-0013 as amended: the Ledger acts "keep
    // disclosed-and-undoable-after as their gate, because the window is
    // what makes them reversible, and carry the same evidence under
    // ADR-0003 as they always have".
    const gates = new Map(
      REP_ACT_DECLARATIONS.map((declaration) => [
        declaration.name,
        declaration.gate,
      ]),
    );
    expect(gates.get(DISMISS_DRAFT_TOOL)).toBe("rep-evidenced");
    expect(gates.get(DECLINE_BINDING_TOOL)).toBe("rep-evidenced");
    expect(gates.get(RETRACT_DISCLOSURE_LINE_TOOL)).toBe(
      "disclosed-and-undoable-after",
    );
  });

  it("takes no parameter naming a target — the rep's quote is the target", () => {
    // THE CLAIM THAT MAKES «the model never names a draft» CHECKABLE. No
    // declaration here may take a draft id or a disclosure line id: the
    // trigger carries what the rep quoted and code walks from it, so a model
    // that decided the rep meant something else has no parameter to say so
    // with. The one number a tool takes is the LINE the rep themselves
    // named, which is the rep's word and not a row's id.
    for (const declaration of REP_ACT_DECLARATIONS) {
      const parameters = Object.keys(declaration.inputSchema.properties ?? {});
      expect(parameters.sort(), declaration.name).toEqual(
        declaration.name === RETRACT_DISCLOSURE_LINE_TOOL
          ? [EVIDENCE_PARAMETER, "line"]
          : [EVIDENCE_PARAMETER],
      );
      for (const parameter of parameters) {
        expect(parameter, declaration.name).not.toMatch(/_id$|^id$/u);
      }
    }
  });

  it("names each act for what it DID, not for the seam's word", () => {
    // THE TOOLS' WORDS ARE NOT THE SEAM'S (Codex round 1). The seam has one
    // word for a decline — `declined`, named for the grammar class — and
    // the tool has its own, `binding_declined`, because a tool says what it
    // DID while `consumer.ts`'s map says what the seam records and which
    // notice carries it. The two may differ, and that is the point.
    //
    // SIX, NOT NINE (#218, widened at #260). The three that left are the
    // aperture question's — `question_answered`, `question_declined` and
    // `question_answer_refused` — and the SEAM keeps all three, because its
    // vocabulary never narrows and a rig corpus holds acts under them. What
    // changed is that no tool can write one, which is what this list is.
    expect([...THREAD_ACT_WORDS].sort()).toEqual([
      "binding_declined",
      "correction_refused",
      "dismissed",
      // The fifth is `create_draft`'s (ticket #175) — the one act word
      // here that is not a rep-act tool's, and the one the seam already
      // had a marker for.
      "drafted",
      // The sixth is `write_notepad`'s (ticket #260) — twin-side memory the
      // seam has no word for, so it takes `answered`, the word for what
      // really happened to the rep's message (`consumer.ts`'s map).
      "notepad_written",
      "retracted",
      // The seventh is `answer_ask`'s (ticket #324): the rep's own words
      // answering a run's question card, marked `answered` as the notebook is.
      "ask_answered",
      // The eighth is `answer_proposal`'s (ticket #386): the rep's own words
      // accepting or discarding a rutina's proposal card, marked `answered`.
      "proposal_answered",
    ].sort());
  });
});

describe("the fixture's own shape, so the refusals above mean what they say", () => {
  it("puts the trigger's event id somewhere the tools can reach it", () => {
    const deps = threadDeps();
    expect(deps.trigger).toMatchObject({ eventId: FIXTURE_EVENT_ID });
    expect(deps.selfChatJid).toBe(FIXTURE_SELF_CHAT);
  });
});

/** A refused outcome, for a declaration this suite only constructs. */
const REFUSED: EffectOutcome = { performed: false, told: "refused: fixture" };
