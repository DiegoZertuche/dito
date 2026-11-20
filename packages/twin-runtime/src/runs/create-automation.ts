/**
 * `create_automation`: THE TWIN WRITES A RUTINA (tickets #325 and #386; spec
 * #318 decision 28; decision 29 as Diego amended it on 2026-10-11; ADR-0013:
 * the gate is on the tool; ADR-0014: one shape for shipped and authored
 * automations).
 *
 * The rep says «cada viernes a las 9 mándame la lista…», or the twin sees the
 * rep repeat a job and offers it, and the twin writes it: one wake — a cadence
 * of the seat's day, or a seam event — and one workflow definition, the same
 * typed steps `start_workflow` takes and the same parser holds them to, plus
 * the twin's own first-person sentence about it.
 *
 * WHO ASKED DECIDES WHEN IT GOES LIVE, AND IT IS THE TWIN'S WORD (Diego,
 * 2026-10-11: «do NOT enforce this by code … TRUST THE MODEL»). `asked_by:
 * rep` — the rep asked for it — and it is active at the ask, so the clock
 * fires the first instant at or after it: DISCLOSED-AND-UNDOABLE-AFTER, since
 * Rutinas shows it at once with its switch and Descartar. `asked_by: twin` —
 * the twin proposes it — and it is written `pending` with its proposal card
 * at both doors, and nothing runs until the rep accepts it there or tells the
 * thread so (`proposals.ts`): the card's Activar is the gate. Code acts on
 * the word and reads nothing to test it.
 *
 * WHAT CODE DECIDES IS THE STRUCTURE: the wake's shape, the events a trigger
 * may name (the ones the consumer handles), the definition's parse, and that a
 * rutina's waits are spans or cards rather than fixed instants — it runs
 * again and again. What it does, when, and how it is said are the twin's.
 *
 * THE THREAD'S OWN TOOL, NEVER A RUN STEP'S (`catalog.ts`): a rutina is the
 * twin's standing arrangement with the rep, written in a turn of the day.
 *
 * THE TWIN'S OWN ACT (`automation_created`), like a run started: it marks no
 * message and takes no act slot.
 */
import { randomUUID } from "node:crypto";
import { AUTOMATION_SENTENCE_CAP, notepadLength } from "@dito/bundle";
import {
  defineTool,
  type EffectOutcome,
  type GatedEffectToolDeclaration,
} from "@dito/execution";
import { RUTINA_TRIGGER_EVENTS, type RutinaOrigin, type RutinaTriggerEvent } from "@dito/seam";
import { refuse } from "../thread/acts.js";
import { repTriggerOf, type ThreadDeps } from "../thread/deps.js";
import { parseReference, referencesIn, writeReference } from "../thread/references.js";
import { runCatalog } from "./catalog.js";
import { CREATE_AUTOMATION_TOOL, START_WORKFLOW_DECLARATION } from "./declarations.js";
import { parseRunDefinition, type StepSpec } from "./definition.js";
import { firstFiringTold, postProposalCard } from "./proposals.js";
import { activateRutina, insertRutina, readRutina, type RutinaWake } from "./rutinas.js";

export { CREATE_AUTOMATION_TOOL };

/** The word the tool records its effect by — the twin's own, like `run_started`. */
export const AUTOMATION_ACT_WORDS = ["automation_created"] as const;

/** The weekdays a weekly cadence may name, in ISO order: Monday is 1. */
const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;

/** What each trigger event means, as the model is told it. */
const EVENT_MEANING: Readonly<Record<RutinaTriggerEvent, string>> = {
  customer_message: "a customer writes to the rep — narrow it to one with `customer`",
  card_settled: "a card on the rep's canvas settles: sent, discarded or answered",
};

/** What a trigger rutina's run is started with, as the model is told it. */
const EVENT_INPUTS: Readonly<Record<RutinaTriggerEvent, string>> = {
  customer_message: "input.event (the message's id) and input.customer (the customer's reference)",
  card_settled: "input.event (the card's post id)",
};

/**
 * THE DECLARED HALF. The definition's schema is `start_workflow`'s own, so the
 * thread writes a rutina's plan exactly as it writes a one-off run's.
 */
export const CREATE_AUTOMATION_DECLARATION: Omit<GatedEffectToolDeclaration, "run"> = {
  name: CREATE_AUTOMATION_TOOL,
  gate: "disclosed-and-undoable-after",
  description: [
    "Write a rutina: work that runs on its own, again and again, on a cadence or whenever something happens — what the rep asks for when they say every day, every week, or every time something happens. Work that happens once is start_workflow, never this.",
    "Set asked_by to rep when the rep asked for it: it is active at once and runs from its next instant, and the answer tells you that instant. Set asked_by to twin when it is your own proposal: it waits as a card in front of the rep, on their dashboard and in their thread, and runs only once they accept it — on the card, or by telling you, and then you answer the card with answer_proposal. Either way it is on their Rutinas page once it runs, where they can switch it off or discard it.",
    "It wakes on a schedule — every day, or every week on a set of weekdays, at an hour of the rep's day — or on one event: " +
      RUTINA_TRIGGER_EVENTS.map((event) => `${event}, when ${EVENT_MEANING[event]}`).join("; ") +
      ".",
    "Its definition is a run's, exactly as start_workflow takes it: a name, one budget, typed steps, with a post step wherever the rep should get a report card. Each time it wakes it starts one run of it. A wait in a rutina is a span or a card, never a fixed instant. A run an event starts is given " +
      RUTINA_TRIGGER_EVENTS.map((event) => `${EVENT_INPUTS[event]} for ${event}`).join(", ") +
      "; a schedule's run starts with none.",
    "A set of weekdays is one rutina, never several: the working week is monday to friday, one rutina with five weekdays; two days a week is one rutina with two, all at the one hour.",
    "Write `sentence` in the first person, in the rep's own language, as you would tell them what you will do and when — it is what their card says. To change a rutina that is already active, write the new one with `replaces` set to its id: asked by the rep, the new one takes the old one's place at once; proposed by you, the old one keeps running until they accept the new one.",
  ].join(" "),
  inputSchema: {
    type: "object",
    properties: {
      asked_by: {
        type: "string",
        enum: ["rep", "twin"],
        description: "rep when the rep asked for it; twin when you are proposing it.",
      },
      sentence: {
        type: "string",
        description: `What you will do and when, in your first person and the rep's language — at most ${String(AUTOMATION_SENTENCE_CAP)} characters. A customer is written as their reference.`,
      },
      wake: {
        type: "object",
        description:
          'Exactly one of {"schedule": {"every": "day"|"week", "weekdays"?: one or more of "monday"…"sunday", on a weekly schedule only, "at_hour": 0–23}} or {"event": {"kind": one of the events, "customer"?: a customer\'s reference}}.',
        properties: {
          schedule: {
            type: "object",
            properties: {
              every: { type: "string", enum: ["day", "week"] },
              weekdays: { type: "array", items: { type: "string", enum: [...WEEKDAYS] } },
              at_hour: { type: "integer" },
            },
            required: ["every", "at_hour"],
          },
          event: {
            type: "object",
            properties: {
              kind: { type: "string", enum: [...RUTINA_TRIGGER_EVENTS] },
              customer: { type: "string" },
            },
            required: ["kind"],
          },
        },
      },
      definition: START_WORKFLOW_DECLARATION.inputSchema.properties!["definition"],
      replaces: {
        type: "string",
        description: "The id of an active rutina this one replaces, when it is a change to one.",
      },
    },
    required: ["asked_by", "sentence", "wake", "definition"],
    additionalProperties: false,
  },
};

/** The tool, bound to this turn. */
export function createAutomationTool(deps: ThreadDeps): GatedEffectToolDeclaration {
  return defineTool({
    ...CREATE_AUTOMATION_DECLARATION,
    run: async (input: unknown): Promise<EffectOutcome> => {
      if (deps.seatId === undefined) return refuse("refused: this twin has no seat a rutina could serve yet.");
      const given = (input ?? {}) as {
        asked_by?: unknown;
        sentence?: unknown;
        wake?: unknown;
        definition?: unknown;
        replaces?: unknown;
      };
      if (given.asked_by !== "rep" && given.asked_by !== "twin") {
        return refuse("refused: `asked_by` is rep or twin.");
      }
      const askedBy: RutinaOrigin = given.asked_by;
      const sentence = readSentence(deps, given.sentence);
      if ("refused" in sentence) return refuse(`refused: ${sentence.refused}`);
      const wake = readWake(deps, given.wake);
      if ("refused" in wake) return refuse(`refused: ${wake.refused}`);
      const parsed = parseRunDefinition(given.definition, runCatalog());
      if (!parsed.ok) return refuse(`refused: ${parsed.reason}`);
      const fixed = fixedInstantIn(parsed.definition.steps);
      if (fixed !== undefined) {
        return refuse(
          `refused: step \`${fixed}\` waits until a fixed instant, and a rutina runs again and again — wait for a span (after) or on a card (settle).`,
        );
      }
      const replaces = await readReplaced(deps, given.replaces);
      if (typeof replaces !== "string" && replaces !== undefined) return refuse(`refused: ${replaces.refused}`);
      const id = randomUUID();
      await insertRutina(deps.db, deps.bundle, {
        id,
        twinId: deps.twinId,
        seatId: deps.seatId,
        origin: askedBy,
        wake,
        definition: parsed.definition,
        sentence: sentence.text,
        ...(replaces === undefined ? {} : { replacesId: replaces }),
        executionId: deps.executionId,
        evidenceRef: repTriggerOf(deps)?.eventId ?? deps.executionId,
        writtenAt: new Date(),
      });
      if (askedBy === "rep") {
        // LIVE AT THE ASK, and the version it replaces ended in the same
        // transaction — the card's Activar, pressed by the rep's own ask. The
        // ended version's content goes at the pass's sweep (`rutinas.ts`).
        await activateRutina(deps.db, { twinId: deps.twinId, id });
        return {
          performed: true,
          act: AUTOMATION_ACT_WORDS[0],
          told: `Rutina ${id} is active and on the rep's Rutinas page, where they can switch it off or discard it.${replaces === undefined ? "" : ` It took the place of ${replaces}.`} ${await firstFiringTold(deps, id)}`,
        };
      }
      const postId = await postProposalCard(deps.db, {
        twinId: deps.twinId,
        selfChatJid: deps.selfChatJid,
        dek: deps.dek,
        executionId: deps.executionId,
        automationId: id,
        name: parsed.definition.name,
        sentence: sentence.text,
        wake,
        steps: parsed.definition.steps,
        replaces: replaces !== undefined,
        customers: deps.served.customers,
      });
      return {
        performed: true,
        act: AUTOMATION_ACT_WORDS[0],
        told: `Rutina ${id} is your proposal, on card ${postId} in front of the rep on their dashboard and in their thread. It runs only once they accept it: on the card, or by telling you — then answer the card with answer_proposal.${replaces === undefined ? "" : ` When they accept it, it takes the place of ${replaces}.`}`,
      };
    },
  });
}

/** The sentence, within the cap and naming only customers a tool gave. */
function readSentence(
  deps: ThreadDeps,
  raw: unknown,
): { readonly text: string } | { readonly refused: string } {
  if (typeof raw !== "string" || raw.trim() === "") {
    return { refused: "`sentence` is what you will do and when, in your own first person." };
  }
  const text = raw.trim();
  if (notepadLength(text) > AUTOMATION_SENTENCE_CAP) {
    return { refused: `\`sentence\` runs ${String(notepadLength(text))} characters: keep it to ${String(AUTOMATION_SENTENCE_CAP)} at most.` };
  }
  const stray = referencesIn(text).find((reference) => deps.served.customers(reference) === undefined);
  return stray === undefined
    ? { text }
    : { refused: `${writeReference(stray)} names no customer — use a reference a tool gave you.` };
}

/** The wake, typed — or why it cannot be one. */
function readWake(deps: ThreadDeps, raw: unknown): RutinaWake | { readonly refused: string } {
  const given = (raw !== null && typeof raw === "object" ? raw : {}) as {
    schedule?: unknown;
    event?: unknown;
  };
  if ((given.schedule === undefined) === (given.event === undefined)) {
    return { refused: "`wake` is exactly one of a schedule or an event." };
  }
  if (given.schedule !== undefined) {
    const schedule = (given.schedule ?? {}) as { every?: unknown; weekdays?: unknown; at_hour?: unknown };
    const hour = schedule.at_hour;
    if (typeof hour !== "number" || !Number.isInteger(hour) || hour < 0 || hour > 23) {
      return { refused: "a schedule's `at_hour` is a whole hour of the rep's day, 0 to 23." };
    }
    if (schedule.every === "day") {
      return schedule.weekdays === undefined
        ? { kind: "schedule", every: "day", atHour: hour }
        : { refused: "weekdays are for a weekly schedule only." };
    }
    if (schedule.every === "week") {
      const weekdays = weekdaysOf(schedule.weekdays);
      return weekdays === undefined
        ? { refused: `a weekly schedule names one or more weekdays: ${WEEKDAYS.join(", ")}.` }
        : { kind: "schedule", every: "week", weekdays, atHour: hour };
    }
    return { refused: "a schedule runs every day or every week." };
  }
  const woken = (given.event ?? {}) as { kind?: unknown; customer?: unknown };
  if (!(RUTINA_TRIGGER_EVENTS as readonly unknown[]).includes(woken.kind)) {
    return { refused: `an event's kind is one of: ${RUTINA_TRIGGER_EVENTS.join(", ")} — those are the events a rutina can be told about.` };
  }
  const event = woken.kind as RutinaTriggerEvent;
  if (woken.customer === undefined) return { kind: "trigger", event };
  if (event !== "customer_message") return { refused: "only customer_message is narrowed to one customer." };
  const reference = parseReference(woken.customer);
  if (reference === undefined || deps.served.customers(reference) === undefined) {
    return { refused: "`customer` is a customer's reference, as a tool gave it to you." };
  }
  return { kind: "trigger", event, customer: reference };
}

/** A weekly schedule's weekdays as ISO numbers, once each in ISO order — or nothing, for a list that names none or a word that is no weekday. */
function weekdaysOf(raw: unknown): readonly number[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const days = raw.map((word) => WEEKDAYS.indexOf(word as (typeof WEEKDAYS)[number]) + 1);
  if (days.some((day) => day === 0)) return undefined;
  return [...new Set(days)].sort((a, b) => a - b);
}

/** The first step, at any depth, that waits until a fixed instant — or nothing. */
function fixedInstantIn(steps: readonly StepSpec[]): string | undefined {
  for (const step of steps) {
    if (step.kind === "wait" && "at" in step.until) return step.name;
    if (step.kind === "if") {
      const inner = fixedInstantIn(step.then) ?? fixedInstantIn(step.else);
      if (inner !== undefined) return inner;
    }
  }
  return undefined;
}

/** The active rutina a change replaces, when the call names one. */
async function readReplaced(
  deps: ThreadDeps,
  raw: unknown,
): Promise<string | undefined | { readonly refused: string }> {
  if (raw === undefined) return undefined;
  const row = typeof raw === "string" && UUID_SHAPE.test(raw) ? await readRutina(deps.db, deps.twinId, raw) : undefined;
  if (row === undefined) return { refused: "`replaces` is the id of one of your rutinas." };
  if (row.state !== "active") return { refused: `rutina ${row.id} is still a proposal: the rep accepts or discards it as it is.` };
  return row.id;
}

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
