/**
 * THE OWNER TWIN, AT ITS TWO SEAMS (ticket #130; spec #126 Testing
 * Decisions).
 *
 * THE INPUT SEAM IS THE POSTGRES SEAM, as it has been since slice 1: two
 * companies seeded through `wa_events` rows and the real aperture, the real
 * finalization writer closing the window, the real matcher climbing the
 * ladder. `seedOwnerCorpus` is #129's and is reused rather than copied, so
 * the module, the pages and the twin all answer over one Ledger. No test
 * here writes a `ledger` table.
 *
 * THE OUTPUT SEAM IS `runOwnerTwinTurn` OVER A `dito_owner` CONNECTION —
 * the function the room (#131) calls, with the real SDK and the real Tool
 * Runner in-process and only the wire scripted (`@dito/scripted-model`;
 * ADR-0028 as amended: CI never makes a real model call). Every assertion
 * below is made against what that function returned and what it left in the
 * database, never against a module's internals.
 *
 * TWO COMPANIES, because tenant isolation is not observable with one.
 *
 * THE NEGATIVE SWEEP AT THE END is the point of the whole surface: every
 * tool result the model was shown, every rendered turn, every stored answer
 * and every error message this suite produced is kept and swept together
 * for a WhatsApp address, a phone number and the other company's rows. The
 * owner twin is the surface the wall exists for, so a leak found here is a
 * leak.
 */
import { randomBytes } from "node:crypto";
import { OWNER_COMPANY_SETTING, OWNER_ROLE } from "@dito/aperture";
import { verifyOwnerAuditChainsInDb } from "@dito/audit";
import {
  closeScriptedModels,
  promptOf,
  scriptedModel,
  type Script,
  type ScriptedTurn,
} from "@dito/scripted-model";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runOwnerTwinTurn, type OwnerTwinTurnOutcome } from "./turn.js";
import {
  borrowOwnerPassword,
  boundTo,
  CORPUS_AGREEMENT_THIRD_PARTY_NUMBER,
  CORPUS_PHONE,
  CORPUS_RETRACTED_AMOUNT,
  CORPUS_WALL_SHAPED_NAME,
  OWNER_TEST_PASSWORD,
  pgErrorCode,
  resetAndMigrate,
  seedOwnerCorpus,
  TEST_AUDIT_HMAC_KEY,
  TEST_OWNER_AUDIT_HMAC_KEY,
  TEST_DATABASE_URL,
  withRoleClient,
  type BorrowedOwnerPassword,
  type OwnerCorpus,
} from "./testing/db.js";

// Every scripted model this suite opened is closed with it (#328).
afterAll(closeScriptedModels);

/** Pinned, because a rendered instant must not depend on the host clock. */
const TIME_ZONE = "America/Monterrey";
/** Scripted throughout; no request ever leaves the process. */
const MODEL = "claude-sonnet-5";

let db: pg.Client;
/** Cluster-global, so it goes back exactly as it was found (#133). */
let ownerPassword: BorrowedOwnerPassword | null = null;
let a: OwnerCorpus;
let b: OwnerCorpus;
/**
 * TWO RECORDS OF COMPANY A WHOSE NAMES FOLD EQUAL — «Aceros Ríos» and
 * «Aceros Rios», one accent apart.
 *
 * `seedOwnerCorpus` has no such pair and could not: its merged pair carries
 * two DIFFERENT names joined on a shared RFC, so resolving either returns
 * one record. ADR-0039's ask is about a name that matches more than one
 * record, so the corpus this suite needs for it is one nothing else needed.
 * They share no identifier, so the matcher leaves them apart, which is the
 * whole point: two customers really are two customers.
 */
const AMBIGUOUS = { accented: "Aceros Ríos", plain: "Aceros Rios" } as const;

/** Everything this suite was shown or produced, for the sweep at the end. */
const surfaced: { where: string; text: string }[] = [];

beforeAll(async () => {
  await resetAndMigrate();
  db = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await db.connect();
  ownerPassword = await borrowOwnerPassword(OWNER_ROLE);

  a = await seedOwnerCorpus(db, {
    company: "Ferretería Fuentes",
    rep: "Mauricio Cantú",
    customer: "Ana García",
    mergedWinner: "Torres Hnos.",
    mergedLoser: "Torres Hermanos",
  });
  b = await seedOwnerCorpus(db, {
    company: "Materiales del Norte",
    rep: "Rosa Elena Treviño",
    customer: "Beatriz Lozano",
    mergedWinner: "Lozano y Cía.",
    mergedLoser: "Lozano y Compañía",
  });

  const fixtures = boundTo(() => db);
  await fixtures.bindCustomer(a.seat, AMBIGUOUS.accented, { kind: "business" });
  await fixtures.bindCustomer(a.seat, AMBIGUOUS.plain, { kind: "business" });
  // NO SECOND LIFT, and none is needed since #132: the aperture stamps
  // `shadow` at filing from the company's mode, so a record bound after
  // this company was lifted lands visible. The lift act itself refuses to
  // run twice (ADR-0016 as amended), which is what a second call here
  // would have found out.
});

afterAll(async () => {
  await ownerPassword?.restore();
  await db.end();
});

/**
 * A RUN THAT NEVER GIVES AN ANSWER THE GUARD ACCEPTS: the same refused
 * answer, every time it is handed the refusal, until the CLI gives up on
 * it. Its run ends with no answer, `schema-miss` on the refusal (the
 * runtime's word for a typed result it could not accept).
 */
function refusedToTheEnd(answer: Record<string, unknown>): ScriptedTurn[] {
  return Array.from({ length: 5 }, () => ({ structured: answer }));
}

/**
 * One turn, run as `dito_owner` with a company declared, over a script.
 *
 * `script` MAY BE A RULE READ OFF THE PROMPT (ticket #178), which is the one
 * claim a fixed list cannot make: "what the execution was shown changed what
 * it did". `askedAt` is the turn's one instant — the `now` part is rendered
 * from it and the reads measure FR-69's boundary from it — and it is left
 * unset by every case that does not care.
 */
async function ask(
  corpus: OwnerCorpus,
  question: string,
  script: Script,
  options: { readonly askedAt?: Date } = {},
): Promise<{
  readonly outcome: OwnerTwinTurnOutcome;
  readonly toolResults: readonly string[];
  readonly requests: readonly Record<string, unknown>[];
}> {
  const { harness, requests } = scriptedModel(script);
  return withRoleClient(OWNER_ROLE, OWNER_TEST_PASSWORD, async (client) => {
    await client.query("SELECT set_config($1, $2, false)", [
      OWNER_COMPANY_SETTING,
      corpus.seat.companyId,
    ]);
    let outcome: OwnerTwinTurnOutcome;
    try {
      outcome = await runOwnerTwinTurn({
        harness,
        client,
        hmacKey: TEST_OWNER_AUDIT_HMAC_KEY,
        companyId: corpus.seat.companyId,
        question,
        timeZone: TIME_ZONE,
        model: MODEL,
        ...(options.askedAt === undefined ? {} : { askedAt: options.askedAt }),
      });
    } finally {
      // What the model was SHOWN, out of the requests the scripted wire
      // recorded — the tool results included, since a leak into a tool
      // result is a leak into the model's context.
      for (const body of requests) surfaced.push({ where: "prompt", text: JSON.stringify(body) });
    }
    surfaced.push({ where: "turn", text: JSON.stringify(outcome) });
    // THE LAST REQUEST CARRIES THEM ALL, in order and once each: every
    // request body replays the whole conversation so far, so flattening
    // every body would count the first tool result once per iteration.
    const last = requests.at(-1);
    return {
      outcome,
      toolResults: last === undefined ? [] : toolResultsOf(last),
      requests: [...requests],
    };
  });
}

/** The input of the first call the model made to one named tool. */
function toolCallInput(
  requests: readonly Record<string, unknown>[],
  tool: string,
): Record<string, unknown> | undefined {
  const messages = (requests.at(-1)?.["messages"] ?? []) as { content?: unknown }[];
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content as Record<string, unknown>[]) {
      // The wire names our tools under the runner's server prefix (#328).
      if (block["type"] === "tool_use" && block["name"] === `mcp__dito__${tool}`) {
        return block["input"] as Record<string, unknown>;
      }
    }
  }
  return undefined;
}

/** Every tool result carried back into one request body. */
function toolResultsOf(body: Record<string, unknown>): string[] {
  const messages = (body["messages"] ?? []) as { content?: unknown }[];
  const out: string[] = [];
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content as Record<string, unknown>[]) {
      if (block["type"] === "tool_result") out.push(JSON.stringify(block["content"]));
    }
  }
  return out;
}

/** The prose a rendered turn reads as, slots filled. */
function readsAs(outcome: OwnerTwinTurnOutcome): string {
  return (outcome.turn?.prose ?? []).map((segment) => segment.text).join("");
}

describe("the owner twin answers from the record (spec #126 AC 1)", () => {
  it("resolves, reads the timeline and answers with provenance from served rows only", async () => {
    const { outcome, toolResults } = await ask(a, "que quedo pendiente con Torres Hnos.", [
      { toolCall: { name: "resolve_entity", input: { name: "Torres Hnos." } } },
      { toolCall: { name: "read_timeline", input: { entity_ref: 1 } } },
      {
        structured: {
          kind: "answer",
          prose: "Lo ultimo que quedo con [[1]] fue [[2]].",
          references: [1, 2],
        },
      },
      { text: "listo" },
    ]);

    expect(outcome.disposition).toBe("answered");
    expect(outcome.failure).toBeNull();
    // The merge read as one timeline: the loser's quote is under the
    // survivor (ADR-0035), so a reference to it exists at all.
    expect(toolResults.join(" ")).toContain("Torres Hnos.");
    // Every value in the answer came off a served row, through the
    // aperture's own renderer.
    const value = outcome.turn!.prose.find(
      (segment) => segment.kind === "reference" && segment.of === "fact",
    );
    expect(value).toBeDefined();
    expect(readsAs(outcome)).toContain("Torres Hnos.");
    // ...and the receipt strip carries ADR-0004's five fields for it.
    expect(outcome.turn!.receipt).toHaveLength(1);
    const line = outcome.turn!.receipt[0]!;
    expect(line.kind).toBe("fact");
    if (line.kind !== "fact") return;
    expect(line.seat).toBe("Mauricio Cantú");
    expect(line.sourceType).toBe("Conversación");
    expect(line.occurred).not.toBe("");
    expect(line.filed).not.toBe("");
    expect(line.confidence).toContain("confianza");
  });

  it("lets the model fix a prose that typed the name, and renders the fixed turn (#133 boundary)", async () => {
    // The first live question on the rig, replayed: Sonnet 5 typed the
    // customer's name into the prose, the guard refused it, and the model
    // answered again with the name as a reference. Before #133 the second
    // answer was refused as "already recorded" and the turn failed.
    const { outcome, toolResults } = await ask(a, "que ha pedido Torres Hnos.", [
      { toolCall: { name: "resolve_entity", input: { name: "Torres Hnos." } } },
      { toolCall: { name: "read_timeline", input: { entity_ref: 1 } } },
      {
        structured: {
          kind: "answer",
          prose: "Torres Hnos. tiene un pedido registrado: [[2]].",
          references: [2],
        },
      },
      {
        structured: {
          kind: "answer",
          prose: "El cliente [[1]] tiene un pedido registrado: [[2]].",
          references: [1, 2],
        },
      },
      { text: "listo" },
    ]);

    // The refusal went back to the model as its answer's error, and the
    // second answer ended the turn.
    expect(toolResults).toHaveLength(3);
    expect(toolResults[2]).toContain("refused: prose types a name");
    expect(outcome.disposition).toBe("answered");
    expect(outcome.failure).toBeNull();
    expect(outcome.record.iterations).toBe(4);
    const name = outcome.turn!.prose.find(
      (segment) => segment.kind === "reference" && segment.of === "entity",
    );
    expect(name).toBeDefined();
    expect(readsAs(outcome)).toContain("Torres Hnos.");
  });

  it("never serves a retracted row, or a third party's number inside one, to the model", async () => {
    const { toolResults } = await ask(a, "todo lo de Ana", [
      { toolCall: { name: "resolve_entity", input: { name: "Ana García" } } },
      { toolCall: { name: "read_timeline", input: { entity_ref: 1 } } },
      { structured: { kind: "answer", prose: "Esto hay: [[2]].", references: [2] } },
      { text: "listo" },
    ]);
    const shown = toolResults.join(" ");
    // The fact the rep took back inside the correction window never
    // finalized, so no read can reach it.
    expect(shown).not.toContain(String(CORPUS_RETRACTED_AMOUNT));
    // The customer's own number lives in a `ContactEstablished` payload and
    // the renderer says the KIND and never the value (ADR-0004).
    expect(shown).not.toContain(CORPUS_PHONE.replace(/\s/g, ""));
    expect(shown).not.toContain(CORPUS_PHONE);
    // ...and the third party's number inside an `OrderTaken` agreement, which
    // the aperture's payload sweep cannot refuse and #129's follow-up
    // redacts at the renderer — the same renderer the tool result is built
    // from, so the model never sees it either.
    expect(shown).not.toContain(CORPUS_AGREEMENT_THIRD_PARTY_NUMBER);
  });

  it("renders a name that is a phone number as no readable name at all", async () => {
    const { outcome, toolResults } = await ask(a, "quien es ese numero", [
      {
        toolCall: {
          name: "resolve_entity",
          input: { name: CORPUS_WALL_SHAPED_NAME },
        },
      },
      {
        structured: {
          kind: "answer",
          prose: "Ese registro es [[1]] y no tiene nada todavia.",
          references: [1],
        },
      },
      { text: "listo" },
    ]);
    expect(toolResults.join(" ")).not.toContain(CORPUS_WALL_SHAPED_NAME);
    expect(readsAs(outcome)).not.toContain(CORPUS_WALL_SHAPED_NAME);
  });
});

describe("a count is code's, from the tool result (spec #126 AC 1, user story 14)", () => {
  it("renders the number the tool counted, and never shows it to the model", async () => {
    const expected = await finalizedFacts(a.seat.companyId, "QuoteGiven");
    expect(expected).toBeGreaterThan(0);

    const { outcome, toolResults } = await ask(
      a,
      "cuantas cotizaciones lleva la empresa",
      [
        {
          toolCall: {
            name: "count_facts",
            input: { fact_type: "QuoteGiven" },
          },
        },
        {
          structured: {
            kind: "answer",
            prose: "Llevan [[1]] en total.",
            references: [1],
            count_ref: 1,
          },
        },
        { text: "listo" },
      ],
    );

    expect(outcome.disposition).toBe("answered");
    expect(readsAs(outcome)).toBe(`Llevan ${expected} en total.`);
    // THE MODEL NEVER SAW IT. The tool result says whether the count found
    // anything and nothing more, so the number in the sentence cannot have
    // come from the model at all.
    expect(toolResults.join(" ")).not.toContain(String(expected));
    expect(outcome.turn!.receipt[0]).toMatchObject({
      kind: "count",
      windowClosed: true,
    });
  });

  it("narrows a count to one rep's seat, by the name the owner used", async () => {
    const { outcome } = await ask(a, "cuantas dio Mauricio", [
      {
        toolCall: {
          name: "count_facts",
          input: { fact_type: "QuoteGiven", seat_name: "mauricio cantu" },
        },
      },
      {
        structured: {
          kind: "answer",
          prose: "[[2]] fueron de [[1]].",
          references: [2, 1],
          count_ref: 2,
        },
      },
      { text: "listo" },
    ]);
    expect(outcome.disposition).toBe("answered");
    // The seat is a resolved NAME reference — no square, no receipt line —
    // and the count is a provenance value that has one.
    expect(outcome.turn!.receipt.map((line) => line.kind)).toEqual(["count"]);
    expect(readsAs(outcome)).toContain("Mauricio Cantú");
  });
});

describe("the one legitimate ask (spec #126 AC 2, ADR-0039)", () => {
  it("asks which record when ONE name resolves to two, and cites no fact", async () => {
    const { outcome, toolResults } = await ask(a, "que hay de Aceros Rios", [
      // ONE call, TWO candidates: the resolution is accent-insensitive, so
      // the name the owner typed matches both records and the twin has no
      // way to choose. That is the whole of ADR-0039's fence — the owner's
      // answer settles it and nothing else can.
      { toolCall: { name: "resolve_entity", input: { name: AMBIGUOUS.plain } } },
      {
        structured: {
          kind: "ask",
          prose: "Tengo dos con ese nombre: [[1]] y [[2]]. A cual te refieres?",
          references: [1, 2],
          candidates: [1, 2],
        },
      },
      { text: "listo" },
    ]);
    // The tool really did serve two records off one name.
    expect(toolResults[0]).toContain("[1]");
    expect(toolResults[0]).toContain("[2]");
    // AN ASK LEAVES A QUESTION OPEN FOR THE OWNER: `asked` (CONTEXT.md,
    // *Disposition*), read from the typed result's open choice.
    expect(outcome.disposition).toBe("asked");
    expect(outcome.turn!.kind).toBe("ask");
    expect(
      outcome.turn!.candidates.map((record) => record.displayName).sort(),
    ).toEqual([AMBIGUOUS.plain, AMBIGUOUS.accented].sort());
    // NO FACTS: an ask answers nothing, so it carries no receipt strip.
    expect(outcome.turn!.receipt).toEqual([]);
  });

  it("refuses to read one of two records that matched a name (Codex r1)", async () => {
    // ADR-0039'S ASK, MADE STRUCTURAL. Until this the ask was instructed and
    // nothing else, so a model could pick one of two same-name records,
    // read its timeline and answer about whichever it happened to choose —
    // grounded in the wrong customer's facts.
    const { toolResults, outcome } = await ask(a, "que hay de Aceros Rios", [
      { toolCall: { name: "resolve_entity", input: { name: AMBIGUOUS.plain } } },
      { toolCall: { name: "read_timeline", input: { entity_ref: 1 } } },
      {
        structured: {
          kind: "ask",
          prose: "Tengo dos: [[1]] y [[2]]. Cual?",
          references: [1, 2],
          candidates: [1, 2],
        },
      },
      { text: "listo" },
    ]);
    expect(toolResults[1]).toContain(
      "one of several records that matched that name",
    );
    expect(outcome.disposition).toBe("asked");
  });

  it("reads a record whose name matched only it", async () => {
    // The other direction: an unambiguous resolution is not fenced.
    const { toolResults } = await ask(a, "la linea de Ana", [
      { toolCall: { name: "resolve_entity", input: { name: "Ana García" } } },
      { toolCall: { name: "read_timeline", input: { entity_ref: 1 } } },
      { structured: { kind: "answer", prose: "Lo de [[1]]: [[2]].", references: [1, 2] } },
      { text: "listo" },
    ]);
    expect(toolResults[1]).not.toContain("rejected:");
  });

  it("refuses an ask the owner's answer could not settle — one candidate is not a choice", async () => {
    const { outcome } = await ask(a, "que hay de Ana", [
      { toolCall: { name: "resolve_entity", input: { name: "Ana García" } } },
      ...refusedToTheEnd({
        kind: "ask",
        prose: "Te refieres a [[1]]?",
        references: [1],
        candidates: [1],
      }),
    ]);
    expect(outcome.disposition).toBe("schema-miss");
    expect(outcome.failure).toContain("fewer than two");
  });
});

describe("the by-design delay (spec #126 DoD 8, FR-69)", () => {
  it("refuses to read a window that starts inside the lag, before it queries", async () => {
    // FR-69 IS A FENCE AND NOT AN INSTRUCTION (Codex r1, r2). A window
    // narrowed to the recent region can only come back empty, and "it is
    // empty" is what must not be revealed — so the read is refused before
    // it is issued, on the app's clock rather than the model's.
    const { toolResults, outcome } = await ask(a, "cuantas van hoy?", [
      {
        toolCall: {
          name: "count_facts",
          input: {
            fact_type: "QuoteGiven",
            from: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
          },
        },
      },
      {
        structured: {
          kind: "answer",
          prose: "Lo de hoy tarda: el registro va un dia atras a proposito.",
          references: [],
          delayed: true,
        },
      },
      { text: "listo" },
    ]);
    expect(toolResults[0]).toContain("has not finished with");
    expect(outcome.disposition).toBe("answered");
  });

  it("answers about today with the delay, reading nothing and citing nothing", async () => {
    const { outcome, toolResults } = await ask(a, "que paso hoy?", [
      {
        structured: {
          kind: "answer",
          prose:
            "Lo de hoy todavia no aparece: el registro va un dia atras a proposito, y aqui solo veo lo ya firme.",
          references: [],
          delayed: true,
        },
      },
      { text: "listo" },
    ]);
    expect(outcome.disposition).toBe("answered");
    // NOTHING WAS READ, which is the point: a turn that went looking would
    // be reporting on the window either way.
    expect(toolResults).toHaveLength(0);
    expect(outcome.turn!.receipt).toEqual([]);
    expect(outcome.turn!.prose.every((s) => s.kind === "prose")).toBe(true);
  });

  it("refuses a delay answer that cites the window it just declined to describe", async () => {
    const { outcome } = await ask(a, "y hoy con Torres?", [
      { toolCall: { name: "resolve_entity", input: { name: "Torres Hnos." } } },
      ...refusedToTheEnd({
        kind: "answer",
        prose: "De [[1]] hoy no hay nada.",
        references: [1],
        delayed: true,
      }),
    ]);
    expect(outcome.disposition).toBe("schema-miss");
    expect(outcome.failure).toContain("cites nothing at all");
  });
});

describe("a wall question gets FR-46's structure (spec #126 AC 3)", () => {
  it("refuses, points at the timeline it can show, and suggests a person", async () => {
    const { outcome } = await ask(a, "que le dijo Mauricio a Torres", [
      { toolCall: { name: "resolve_entity", input: { name: "Torres Hnos." } } },
      {
        structured: {
          kind: "refusal",
          prose:
            "De lo que se hablo en el chat no te puedo decir nada: eso no cruza a tu lado.",
          references: [1],
          timeline_ref: 1,
          follow_up: "Si te urge saberlo, preguntaselo directamente a quien lleva la cuenta.",
        },
      },
      { text: "listo" },
    ]);
    // THE KIND IS CONTENT (CONTEXT.md, *Disposition*): a well-formed refusal
    // is `answered`, and its FR-46 parts are the stored answer's.
    expect(outcome.disposition).toBe("answered");
    expect(outcome.turn!.timeline?.displayName).toBe("Torres Hnos.");
    expect(outcome.turn!.followUp).not.toBeNull();
    const stored = await ownerRows(a, "SELECT kind, follow_up FROM owner.answers");
    expect(stored.at(-1)).toMatchObject({ kind: "refusal" });
    expect(stored.at(-1)!["follow_up"]).not.toBeNull();
  });
});

describe("an unrecorded answer is a row the log can be read from (spec #126 AC 4)", () => {
  it("stores the kind, which the failed-query log counts, and the record says answered", async () => {
    const { outcome } = await ask(a, "quien se quejo esta semana", [
      {
        structured: {
          kind: "unrecorded",
          prose: "Eso no lo registro: no guardo quejas, solo lo comercial.",
          references: [],
        },
      },
      { text: "listo" },
    ]);
    // FR-48's log is the stored answer's kind; the disposition is read from
    // what happened — a well-formed typed result (CONTEXT.md, *Disposition*).
    expect(outcome.disposition).toBe("answered");
    expect(outcome.turn!.kind).toBe("unrecorded");
    const log = await ownerRows(a, "SELECT kind FROM owner.answers WHERE kind = 'unrecorded'");
    expect(log.length).toBeGreaterThan(0);
  });
});

describe("each tool as `dito_owner`, over a real connection (spec #126 AC 6)", () => {
  it("refuses an argument naming a column, a table or a company, before the handler runs", async () => {
    // THE RUN-TIME HALF of AC 6. Construction refuses a DECLARED widening
    // parameter (`tools.test.ts`); this refuses an UNDECLARED one arriving
    // on the wire, which is the only way a model could try. The refusal
    // reaches the model as a tool result and the handler is never called —
    // so the read that would have been widened never happened, and the
    // rows the turn rests on prove it: none were served.
    const { outcome, toolResults } = await ask(a, "todo, de toda la empresa", [
      {
        toolCall: {
          name: "read_timeline",
          input: { entity_ref: 1, company_id: b.seat.companyId },
        },
      },
      {
        toolCall: {
          name: "resolve_entity",
          input: { name: "Torres Hnos.", columns: ["payload", "shadow"] },
        },
      },
      {
        toolCall: {
          name: "count_facts",
          // A table name the model made up; spelled without a schema
          // qualifier so the repo's sole-writer sweep does not read this
          // test as a module naming a Ledger table.
          input: { fact_type: "QuoteGiven", table: "facts" },
        },
      },
      {
        structured: {
          kind: "unrecorded",
          prose: "No pude leer nada asi.",
          references: [],
        },
      },
      { text: "listo" },
    ]);
    // Three results: the three refusals. The answer ended the turn.
    expect(toolResults).toHaveLength(3);
    // THE WALL'S REFUSAL IS WHAT HAPPENED: a read refused at its projection's
    // fence makes the record `wall-refused`, whatever the answer's kind.
    expect(outcome.disposition).toBe("wall-refused");
    expect(toolResults[0]).toContain(
      "`company_id` is not a parameter of this tool",
    );
    expect(toolResults[1]).toContain("`columns` is not a parameter of this tool");
    expect(toolResults[2]).toContain("`table` is not a parameter of this tool");
    // Nothing was read and nothing was served: the widened calls never
    // reached a handler at all.
    expect(outcome.turn!.receipt).toEqual([]);
  });

  it("serves exactly the pinned fields of a fact, and no others", async () => {
    // "...and returns only its pinned columns". The rows the timeline read
    // serves are `OwnerFact`s off the finalized view, so the fields on them
    // ARE the projection — and `shadow`, `retracted_at` and
    // `filed_by_twin_id` are not among them because they are not in the
    // view at all.
    const { outcome } = await ask(a, "la linea de Torres", [
      { toolCall: { name: "resolve_entity", input: { name: "Torres Hnos." } } },
      { toolCall: { name: "read_timeline", input: { entity_ref: 1 } } },
      { structured: { kind: "answer", prose: "Esto: [[2]].", references: [2] } },
      { text: "listo" },
    ]);
    const refs = await ownerRows(
      a,
      `SELECT refs FROM owner.answers WHERE execution_id = ${literal(outcome.executionId)}`,
    );
    // The stored reference is the fact's own id and carries nothing else of
    // the row — the room re-reads it through the same pinned projection.
    expect(Object.keys(refs[0]!["refs"] as object)).toBeDefined();
    const stored = refs[0]!["refs"] as { kind: string; factId?: string }[];
    expect(stored[0]).toEqual({
      ref: 2,
      kind: "fact",
      factId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      roles: ["cited"],
    });
  });

  it("cannot be handed another company through any parameter it does have", async () => {
    // The company is the CONNECTION's, never an argument — so there is no
    // spelling of "company B" a tool will accept. `entity_ref` is the only
    // parameter that names a record at all, and a reference to B's record
    // cannot exist in A's run because A's resolution never served one.
    const { outcome, toolResults } = await ask(a, "y Lozano?", [
      { toolCall: { name: "resolve_entity", input: { name: "Lozano y Cía." } } },
      { toolCall: { name: "read_timeline", input: { entity_ref: 1 } } },
      { structured: { kind: "answer", prose: "No hay nadie asi.", references: [] } },
      { text: "listo" },
    ]);
    expect(toolResults[0]).toContain("no customer of this company matches");
    expect(toolResults[1]).toContain(
      "entity_ref 1 was never returned by a tool this turn",
    );
    // The read consulted the record and found nothing, so an empty answer
    // is honest and is accepted.
    expect(outcome.disposition).toBe("answered");
  });
});

describe("the structural guard, over the wire (spec #126 AC 5)", () => {
  const cases: readonly {
    readonly what: string;
    readonly answer: Record<string, unknown>;
    readonly because: string;
  }[] = [
    {
      what: "types a provenance line into prose",
      answer: {
        kind: "answer",
        prose: "Cotización dada por Conversación, con confianza alta: [[2]].",
        references: [2],
      },
      because: "types a provenance line",
    },
    {
      what: "cites a reference no tool served",
      answer: {
        kind: "answer",
        prose: "Lo de [[1]] quedo asi: [[9]].",
        references: [1, 9],
      },
      because: "which no tool served this turn",
    },
    {
      what: "answers a wall question with invented conversation content",
      answer: {
        kind: "answer",
        prose: "Te dijo por chat que lo queria antes de la comida y sono molesto.",
        references: [],
      },
      because: "cites none while the tools served rows",
    },
    {
      what: "puts a number in prose that no tool result carried",
      answer: {
        kind: "answer",
        prose: "Fueron 4 cotizaciones en la semana, ve [[2]].",
        references: [2],
      },
      because: "types a number or a date",
    },
  ];

  it("refuses a model that answers having read nothing at all", async () => {
    // THE INVENTED-CONTENT CASE IN ITS REALISTIC SHAPE (the two-axis
    // review's Spec axis found this hole). Inventing means NOT reading, so
    // the model that invents calls no tool — and then it types no digit, no
    // served name and no rendered token, so every other rule here passes
    // it. `qa.ts`'s own rule is what closes it: read the record before
    // answering about it.
    const before = await chainLength();
    const { outcome } = await ask(a, "que le dijo Torres al rep", [
      ...refusedToTheEnd({
        kind: "answer",
        prose: "Te comento que quedaron de verse y que sono muy interesado.",
        references: [],
      }),
    ]);
    expect(outcome.disposition).toBe("schema-miss");
    expect(outcome.turn).toBeNull();
    expect(outcome.failure).toContain("called no tool at all");
    expect(await chainLength()).toBe(before + 1);
  });

  it("still lets a turn that read and found nothing say so", async () => {
    // The carve-out, and the reason the rule is not simply "cite
    // something": a turn that consulted the record and found nothing has
    // nothing to cite, and saying so is a true answer about the record.
    const { outcome } = await ask(a, "que hay de Zambrano", [
      { toolCall: { name: "resolve_entity", input: { name: "Zambrano" } } },
      {
        structured: {
          kind: "answer",
          prose: "No tengo a nadie con ese nombre en el registro.",
          references: [],
        },
      },
      { text: "listo" },
    ]);
    expect(outcome.disposition).toBe("answered");
  });

  it("refuses an unserved slot in a refusal's follow-up, and still chains one entry", async () => {
    // THE ROLLBACK THE REVIEW FOUND (Codex r1). The follow-up's slots were
    // never checked, so an unserved one reached the renderer — which threw
    // inside the transaction and took the runner's own audit entry with it.
    // One answer, zero chained entries, no record at all.
    const before = await chainLength();
    const { outcome } = await ask(a, "que le dijo Mauricio a Torres", [
      { toolCall: { name: "resolve_entity", input: { name: "Torres Hnos." } } },
      ...refusedToTheEnd({
        kind: "refusal",
        prose: "De eso no te puedo hablar, ve [[1]].",
        references: [1],
        timeline_ref: 1,
        follow_up: "Preguntaselo a [[999]].",
      }),
    ]);
    expect(outcome.disposition).toBe("schema-miss");
    expect(outcome.failure).toContain("a slot in follow_up names reference 999");
    expect(await chainLength()).toBe(before + 1);
    const rows = await ownerRows(
      a,
      `SELECT disposition FROM owner.executions WHERE id = ${literal(outcome.executionId)}`,
    );
    expect(rows).toHaveLength(1);
  });

  it("refuses an answer that resolved a name and never opened it", async () => {
    const before = await chainLength();
    const { outcome } = await ask(a, "como suena Torres por chat", [
      { toolCall: { name: "resolve_entity", input: { name: "Torres Hnos." } } },
      ...refusedToTheEnd({
        kind: "answer",
        prose: "Con [[1]] la relacion va muy bien, se les nota contentos.",
        references: [1],
      }),
    ]);
    expect(outcome.disposition).toBe("schema-miss");
    expect(outcome.failure).toContain("cites only names");
    expect(await chainLength()).toBe(before + 1);
  });

  it("refuses a count nobody slotted — the number spelled out in words", async () => {
    const before = await chainLength();
    const { outcome } = await ask(a, "cuantas cotizaciones van", [
      { toolCall: { name: "count_facts", input: { fact_type: "QuoteGiven" } } },
      ...refusedToTheEnd({
        kind: "answer",
        prose: "Fueron cuatro esta semana.",
        references: [1],
        count_ref: 1,
      }),
    ]);
    expect(outcome.disposition).toBe("schema-miss");
    expect(outcome.failure).toContain("no slot in prose fills it");
    expect(await chainLength()).toBe(before + 1);
  });

  for (const guardCase of cases) {
    it(`refuses a model that ${guardCase.what} until its budget ends, records failed, chains one entry`, async () => {
      const before = await chainLength();
      // Two reads and four refused answers spend the six rounds before the
      // CLI gives up on the answer, so the turn cap ends it: `failed`, with
      // the guard's own sentence as the reason.
      const { outcome } = await ask(a, "que paso con Torres", [
        { toolCall: { name: "resolve_entity", input: { name: "Torres Hnos." } } },
        { toolCall: { name: "read_timeline", input: { entity_ref: 1 } } },
        ...refusedToTheEnd(guardCase.answer),
      ]);

      expect(outcome.disposition).toBe("failed");
      expect(outcome.turn).toBeNull();
      expect(outcome.failure).toContain(guardCase.because);
      // ONE ENTRY, and the record beside it.
      expect(await chainLength()).toBe(before + 1);
      const rows = await ownerRows(
        a,
        `SELECT e.disposition, a.id AS answer_id
           FROM owner.executions e
           LEFT JOIN owner.answers a ON a.execution_id = e.id
          WHERE e.id = ${literal(outcome.executionId)}`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ disposition: "failed", answer_id: null });
      surfaced.push({ where: "failure", text: outcome.failure! });
    });
  }
});

describe("exactly one record and one entry per run (spec #126 AC 8)", () => {
  it("chains one entry, content-free, whose ref names the question and the digest", async () => {
    const before = await chainLength();
    const { outcome } = await ask(a, "cuantos pedidos tomaron", [
      { toolCall: { name: "count_facts", input: { fact_type: "OrderTaken" } } },
      {
        structured: {
          kind: "answer",
          prose: "Van [[1]].",
          references: [1],
          count_ref: 1,
        },
      },
      { text: "listo" },
    ]);
    expect(await chainLength()).toBe(before + 1);
    const entry = await db.query<{
      company_id: string;
      caller: string;
      action: string;
      ref: string;
      outcome: string;
    }>(
      `SELECT company_id, caller, action, ref, outcome FROM owner.audit_chain
        ORDER BY id DESC LIMIT 1`,
    );
    expect(entry.rows[0]).toEqual({
      company_id: a.seat.companyId,
      caller: "execution",
      action: "execution",
      ref: `trigger:owner_question mechanism:request company:${a.seat.companyId} owner_question:${outcome.questionId} instructions:${outcome.record.instructionsDigest}`,
      outcome: "answered",
    });
    // CONTENT-FREE (ADR-0020): not the question, not the prose, not a value.
    expect(entry.rows[0]!.ref).not.toContain("cuantos pedidos");
    // ...AND UNDER THE OWNER'S KEY, NOT THE REP'S (#157 decision 3). Two real
    // keys: the chain verifies under the one the app was given and does not
    // under the other, so "the owner environment holds nothing that can
    // verify a rep-side store" is a claim about this row.
    const verified = await verifyOwnerAuditChainsInDb(db, TEST_OWNER_AUDIT_HMAC_KEY);
    expect(verified.valid).toBe(true);
    const underRepKey = await verifyOwnerAuditChainsInDb(db, TEST_AUDIT_HMAC_KEY);
    expect(underRepKey.valid).toBe(false);
    // ...and the REP chain is untouched by every turn this suite has taken.
    const repChain = await db.query<{ n: string }>(
      "SELECT count(*) AS n FROM audit_chain WHERE action = 'execution'",
    );
    expect(Number(repChain.rows[0]!.n)).toBe(0);
  });

  it("commits the question, the record, the answer and the entry TOGETHER — or none of them", async () => {
    // ALL OR NOTHING, driven through the one door that can break the append
    // AFTER the rest of the turn has been written. `appendOwnerAuditEntry`
    // authenticates this company's tail under the key before extending it, so
    // a strong-but-wrong key is refused at exactly that moment — the question
    // row is already inserted and the model has already answered — and the
    // turn's transaction has to take all of it back.
    //
    // The wrong key is a REAL 32-byte key, not a weak one: the fail-closed
    // length check would refuse a short one before anything was written, and
    // the case worth proving is the one where the refusal lands late.
    const before = await chainLength();
    const questions = await ownerRowCount("owner.questions");
    const executions = await ownerRowCount("owner.executions");
    const answers = await ownerRowCount("owner.answers");

    const { harness } = scriptedModel([
      {
        structured: {
          kind: "unrecorded",
          prose: "Eso no lo llevo.",
          references: [],
        },
      },
      { text: "listo" },
    ]);
    await expect(
      withRoleClient(OWNER_ROLE, OWNER_TEST_PASSWORD, async (client) => {
        await client.query("SELECT set_config($1, $2, false)", [
          OWNER_COMPANY_SETTING,
          a.seat.companyId,
        ]);
        return runOwnerTwinTurn({
          harness,
          client,
          hmacKey: randomBytes(32),
          companyId: a.seat.companyId,
          question: "y con una llave equivocada?",
          timeZone: TIME_ZONE,
          model: MODEL,
        });
      }),
    ).rejects.toThrow(/key/);

    expect(await chainLength()).toBe(before);
    expect(await ownerRowCount("owner.questions")).toBe(questions);
    expect(await ownerRowCount("owner.executions")).toBe(executions);
    expect(await ownerRowCount("owner.answers")).toBe(answers);
    // ...and the chain that was there is untouched and still verifies.
    expect(
      (await verifyOwnerAuditChainsInDb(db, TEST_OWNER_AUDIT_HMAC_KEY)).valid,
    ).toBe(true);
  });

  it("holds EXACTLY one entry per execution over the whole corpus (Codex r2)", async () => {
    // COVERAGE PROVES «AT LEAST ONE», by the shape of its join: it asks
    // whether an entry exists naming each act, not how many. ADR-0014 as
    // amended says exactly one. What makes it exactly one is the unique
    // constraint on `owner.executions.owner_question_id` plus the runner
    // appending once — and this is the assertion over real rows that says
    // the pair actually holds, run over every turn this suite has taken.
    const perQuestion = await db.query<{ n: string }>(
      `SELECT count(*) AS n
         FROM owner.executions e
        WHERE (SELECT count(*) FROM owner.audit_chain c
                WHERE c.company_id = e.company_id
                  AND c.action = 'execution'
                  AND c.caller = 'execution'
                  AND (' ' || c.ref || ' ')
                      LIKE ('% owner_question:' || e.owner_question_id || ' %')) <> 1`,
    );
    expect(Number(perQuestion.rows[0]!.n)).toBe(0);
    const executions = await db.query<{ n: string }>(
      "SELECT count(*) AS n FROM owner.executions",
    );
    expect(Number(executions.rows[0]!.n)).toBeGreaterThan(10);
  });

  it("stamps the same digest for two identical runs", async () => {
    const script: ScriptedTurn[] = [
      { structured: { kind: "unrecorded", prose: "Eso no lo llevo.", references: [] } },
      { text: "listo" },
    ];
    const first = await ask(a, "y de satisfaccion?", script);
    const second = await ask(a, "y de satisfaccion?", [...script]);
    expect(second.outcome.record.instructionsDigest).toBe(
      first.outcome.record.instructionsDigest,
    );
  });
});

describe("the twin is told what day it is (#178; spec #171 decisions 8(3) and 13)", () => {
  /**
   * The year, read off the `now` part the execution was SHOWN.
   *
   * A RULE, NOT A LIST, and that is the whole of what this proves. Two runs
   * scripted with two different lists show only that the fixtures differed;
   * two runs scripted with the SAME rule, whose answers differ, show that
   * the prompt did (`@dito/scripted-model`'s own note; ADR-0041). The regex
   * reads the four-digit year out of the bracketed metadata line and nothing
   * else, so a `now` part that stopped carrying a year would fail here
   * rather than quietly answer about some other one.
   */
  const windowInTheYearItWasShown: Script = (prompt) => {
    const year = /\[Now: \w+, \w+ \d+, (\d{4}),/u.exec(prompt)?.[1];
    if (year === undefined) {
      throw new Error(
        `the execution was shown no dated «now» part: ${prompt.slice(0, 200)}`,
      );
    }
    // September the 1st to the 3rd, on the owner's clock, in the year the
    // twin was told it is. This is «entre el 1 y el 3 de septiembre» as a
    // tool call — the model passes dates as parameters and never types them
    // into prose (ADR-0037 as amended).
    const window = {
      fact_type: "QuoteGiven",
      from: `${year}-09-01T00:00:00-06:00`,
      to: `${year}-09-03T23:59:59-06:00`,
    };
    return [
      // THE NAME IN THE QUESTION IS ANSWERED, NOT IGNORED (the two-axis
      // review's Spec axis). The ticket's sentence asks about a rep this
      // corpus has no seat for, so the honest first call is the one a model
      // would make and the honest first answer is the tool saying so — and
      // the SECOND call is the same window under a rep who does exist. What
      // the pair proves is that the window travelled correctly through
      // both, which one call could not say.
      { toolCall: { name: "count_facts", input: { ...window, seat_name: "Carol" } } },
      {
        toolCall: {
          name: "count_facts",
          input: { ...window, seat_name: a.names.rep },
        },
      },
      {
        structured: {
          kind: "answer",
          prose: "En esos dias [[1]] dio [[2]].",
          references: [1, 2],
          count_ref: 2,
        },
      },
      { text: "listo" },
    ];
  };

  const QUESTION = "cuantas cotizaciones dio Carol entre el 1 y el 3 de septiembre?";

  it("binds «entre el 1 y el 3 de septiembre» to the year it was shown, in the owner's zone", async () => {
    // Asked on Friday 2026-09-04 at 12:00 Monterrey. Before #178 the
    // execution was shown no date at all, so a window like this one could
    // only ever be the model's guess at a year.
    const askedAt = new Date("2026-09-04T18:00:00Z");
    const { outcome, requests, toolResults } = await ask(
      a,
      QUESTION,
      windowInTheYearItWasShown,
      { askedAt },
    );

    expect(outcome.disposition).toBe("answered");
    const window = toolCallInput(requests, "count_facts")!;
    expect(window["from"]).toBe("2026-09-01T00:00:00-06:00");
    expect(window["to"]).toBe("2026-09-03T23:59:59-06:00");
    // ...and the window was READ rather than refused: FR-69's boundary is
    // 24 hours back from the instant above, which is Thursday the 3rd, so a
    // window starting on the 1st is anchored before it.
    expect(toolResults.join(" ")).not.toContain("rejected");
    expect(toolResults.join(" ")).toContain("a count of QuoteGiven");
    // The unknown rep was answered honestly, and the known one resolved:
    // the count the answer cites is filed under a seat, not under nobody.
    expect(toolResults[0]).toContain("no rep of this company has a seat");
    expect(readsAs(outcome)).toContain(a.names.rep);
  });

  it("shows the day the FR-69 window closes, and the same day the reads refuse against", async () => {
    const askedAt = new Date("2026-09-04T18:00:00Z");
    const { requests } = await ask(a, QUESTION, windowInTheYearItWasShown, {
      askedAt,
    });
    const prompt = promptOf(requests[0]!);
    expect(prompt).toContain(
      "[Now: Friday, Sep 4, 2026, 12:00:00 CST (America/Monterrey)]",
    );
    expect(prompt).toContain("Finalized through: Wednesday, Sep 2, 2026");
    // The `now` part is the FIRST thing the execution is shown, before the
    // conversation and before the question (spec #171 decision 8(3)).
    expect(prompt.startsWith("## now\n\n[Now: Friday, Sep 4, 2026")).toBe(true);
  });

  it("answers about a different year when it is told a different day — the same script", async () => {
    // THE TWO-WORLDS PROOF. One rule, two instants, two different tool
    // calls: what changed the window is what the execution was SHOWN, which
    // is the only way to state that the `now` part is load-bearing rather
    // than decorative.
    const { requests } = await ask(a, QUESTION, windowInTheYearItWasShown, {
      askedAt: new Date("2027-09-04T18:00:00Z"),
    });
    const window = toolCallInput(requests, "count_facts")!;
    expect(window["from"]).toBe("2027-09-01T00:00:00-06:00");
    expect(promptOf(requests[0]!)).toContain("Finalized through: Thursday, Sep 2, 2027");
  });

  it("records the lane the automation declared, on the record and in the row", async () => {
    const { outcome } = await ask(a, QUESTION, windowInTheYearItWasShown, {
      askedAt: new Date("2026-09-04T18:00:00Z"),
    });
    expect(outcome.record.lane).toBe("realtime");
    const rows = await ownerRows(
      a,
      `SELECT lane FROM owner.executions WHERE id = ${literal(outcome.executionId)}`,
    );
    expect(rows).toEqual([{ lane: "realtime" }]);
  });
});

describe("two companies never see each other (spec #126 AC 7)", () => {
  it("resolves nothing of company B for company A", async () => {
    const { toolResults } = await ask(a, "que hay de Lozano", [
      { toolCall: { name: "resolve_entity", input: { name: "Lozano y Cía." } } },
      { structured: { kind: "answer", prose: "No encuentro a nadie asi.", references: [] } },
      { text: "listo" },
    ]);
    expect(toolResults.join(" ")).not.toContain("Lozano");
  });

  it("counts nothing of company B for company A", async () => {
    const mine = await finalizedFacts(a.seat.companyId);
    const theirs = await finalizedFacts(b.seat.companyId);
    expect(theirs).toBeGreaterThan(0);
    const counted = await withOwner(a, async (client) => {
      const res = await client.query<{ n: string }>(
        "SELECT count(*) AS n FROM ledger.finalized_facts",
      );
      return Number(res.rows[0]!.n);
    });
    expect(counted).toBe(mine);
  });

  it("keeps each company's questions, answers and executions to itself", async () => {
    await ask(b, "que hay de Beatriz", [
      { toolCall: { name: "resolve_entity", input: { name: "Beatriz Lozano" } } },
      { structured: { kind: "answer", prose: "Lo de [[1]] esta al dia.", references: [1] } },
      { text: "listo" },
    ]);
    const mine = await ownerRows(a, "SELECT text FROM owner.questions");
    const theirs = await ownerRows(b, "SELECT text FROM owner.questions");
    expect(mine.map((row) => row["text"])).not.toContain("que hay de Beatriz");
    expect(theirs.map((row) => row["text"])).toContain("que hay de Beatriz");
    // ...and the executions and answers with them.
    const mineExecutions = await ownerRows(a, "SELECT id FROM owner.executions");
    const theirsExecutions = await ownerRows(b, "SELECT id FROM owner.executions");
    const overlap = mineExecutions
      .map((row) => String(row["id"]))
      .filter((id) => theirsExecutions.some((row) => String(row["id"]) === id));
    expect(overlap).toEqual([]);
  });

  it("keeps each company's own chain to itself, and links each onto its own tail (#165)", async () => {
    // ONE CHAIN PER COMPANY inside one table (ADR-0020 as amended). Each
    // connection reads only its own entries, and each company's chain
    // verifies on its own — which is what "the owner side may read only what
    // it wrote" means once two deployments share a database.
    const mine = await ownerRows(a, "SELECT company_id FROM owner.audit_chain");
    const theirs = await ownerRows(b, "SELECT company_id FROM owner.audit_chain");
    expect(mine.length).toBeGreaterThan(0);
    expect(theirs.length).toBeGreaterThan(0);
    expect([...new Set(mine.map((row) => String(row["company_id"])))]).toEqual([
      a.seat.companyId,
    ]);
    expect([...new Set(theirs.map((row) => String(row["company_id"])))]).toEqual([
      b.seat.companyId,
    ]);
    const verified = await verifyOwnerAuditChainsInDb(
      db,
      TEST_OWNER_AUDIT_HMAC_KEY,
    );
    expect(verified.valid).toBe(true);
    expect(
      verified.companies.map((chain) => chain.companyId).sort(),
    ).toEqual([a.seat.companyId, b.seat.companyId].sort());
    // Every entry is one company's or the other's, and none is unaccounted
    // for: the two per-company counts add up to the whole table.
    expect(
      verified.companies.reduce((n, chain) => n + chain.entries, 0),
    ).toBe(verified.entries);
  });

  it("refuses to write a question stamped with a company it is not serving", async () => {
    // The WITH CHECK arm: a deployment serving A cannot file a row that
    // only B could read.
    const refused = await withOwner(a, async (client) => {
      try {
        await client.query(
          "INSERT INTO owner.questions (company_id, text) VALUES ($1, $2)",
          [b.seat.companyId, "no"],
        );
        return null;
      } catch (error) {
        return pgErrorCode(error);
      }
    });
    expect(refused).toBe("42501");
  });
});

describe("earlier turns are context, fetched fresh (spec #126 decision 5)", () => {
  it("shows the model the turns before this one, with their references killed", async () => {
    const script: ScriptedTurn[] = [
      { toolCall: { name: "resolve_entity", input: { name: "Torres Hnos." } } },
      { toolCall: { name: "read_timeline", input: { entity_ref: 1 } } },
      {
        structured: {
          kind: "answer",
          prose: "Lo de [[1]] sigue abierto: [[2]].",
          references: [1, 2],
        },
      },
      { text: "listo" },
    ];
    const { outcome: first } = await ask(a, "que quedo con Torres", script);
    expect(first.disposition).toBe("answered");

    const { outcome, toolResults } = await ask(a, "y eso cuando fue?", [...script]);
    expect(outcome.disposition).toBe("answered");
    const prompt = surfaced.filter((s) => s.where === "prompt").at(-1)!.text;
    expect(prompt).toContain("que quedo con Torres");
    // The earlier answer's slot is dead: its number would resolve against
    // THIS run's map.
    expect(prompt).toContain("a value from the record");
    expect(toolResults.length).toBeGreaterThan(0);
  });
});

describe("a tool that fails does not take the record with it", () => {
  it("records the failed execution and its entry rather than poisoning the transaction", async () => {
    const before = await chainLength();
    // AN INSTANT POSTGRES CANNOT HOLD, and one the FR-69 boundary does not
    // refuse first: `from` BEFORE the window is an ordinary window, so the
    // read reaches the database, raises 22008, and the savepoint is what
    // keeps the transaction alive for the record and the entry. A `from` in
    // the far FUTURE never gets that far — the tool refuses it as a value
    // and nothing raises at all.
    const { outcome } = await ask(a, "y hace mil anos?", [
      {
        toolCall: {
          name: "count_facts",
          input: { fact_type: "QuoteGiven", from: "-271821-04-20T00:00:00Z" },
        },
      },
      { structured: { kind: "answer", prose: "No pude leerlo.", references: [] } },
      { text: "listo" },
    ]);
    expect(outcome.disposition).toBe("failed");
    expect(await chainLength()).toBe(before + 1);
    const rows = await ownerRows(
      a,
      `SELECT disposition FROM owner.executions WHERE id = ${literal(outcome.executionId)}`,
    );
    expect(rows).toHaveLength(1);
  });
});

describe("two reads in ONE response take the connection in turns (ticket #205)", () => {
  it("resolves and counts in the same message, and answers from both rows", async () => {
    const expected = await finalizedFacts(a.seat.companyId, "QuoteGiven");
    expect(expected).toBeGreaterThan(0);
    const before = await chainLength();

    // ONE RESPONSE, TWO READS. Were both handlers in flight at once on the
    // connection this turn's transaction is open on, savepoints being a
    // stack, whichever released first would destroy the other's and every
    // statement after it would raise 25P02, leaving the turn with no record
    // at all (`tool-queue.ts`).
    const { outcome, toolResults } = await ask(
      a,
      "que hay de Ana y cuantas cotizaciones llevamos",
      [
        {
          toolCalls: [
            { name: "resolve_entity", input: { name: "Ana García" } },
            { name: "count_facts", input: { fact_type: "QuoteGiven" } },
          ],
        },
        {
          structured: {
            kind: "answer",
            prose: "De [[1]] y en total llevamos [[2]].",
            references: [1, 2],
            count_ref: 2,
          },
        },
        { text: "listo" },
      ],
    );

    expect(outcome.disposition).toBe("answered");
    expect(outcome.failure).toBeNull();
    // THE REFERENCES ARE THE ORDER THEY RAN IN, which is what the seam can
    // show of it: a reference is minted when a read finishes, so the read
    // submitted first holds [1] and the one behind it holds [2]. The
    // savepoints are taken and released in the same order, on the same
    // connection, and Postgres only says so in its own log.
    expect(toolResults[0]).toContain("[1]");
    expect(toolResults[1]).toContain("[2]");
    expect(toolResults[1]).toContain("found something");
    // ...and both rows reach the answer the owner reads: the name off the
    // resolve, the number off the count, neither of them the model's.
    expect(readsAs(outcome)).toBe(`De Ana García y en total llevamos ${expected}.`);
    expect(outcome.turn!.receipt.map((line) => line.kind)).toEqual(["count"]);
    // The turn's record and its one entry, which a shared savepoint stack
    // is what destroys.
    expect(await chainLength()).toBe(before + 1);
    const rows = await ownerRows(
      a,
      `SELECT disposition FROM owner.executions WHERE id = ${literal(outcome.executionId)}`,
    );
    expect(rows).toEqual([{ disposition: "answered" }]);
  });

  it("rolls back only the read that failed, and records the turn beside its entry", async () => {
    const before = await chainLength();

    // THE SAME READ TWICE, one of them raising. Two calls of one tool share
    // a savepoint identifier — the name is the tool's — so this is the pair
    // a per-tool name cannot tell apart, and running them in turns is the
    // whole of what keeps the second one's ROLLBACK naming its own scope.
    // The instant is one Postgres cannot hold and the FR-69 boundary does
    // not refuse: `from` before the window is an ordinary window, so the
    // read reaches the database and the database raises 22008.
    const { outcome, toolResults } = await ask(
      a,
      "cuantas cotizaciones llevamos, y cuantas desde hace mil anos",
      [
        {
          toolCalls: [
            { name: "count_facts", input: { fact_type: "QuoteGiven" } },
            {
              name: "count_facts",
              input: {
                fact_type: "QuoteGiven",
                from: "-271821-04-20T00:00:00Z",
              },
            },
          ],
        },
        {
          structured: {
            kind: "answer",
            prose: "Llevan [[1]].",
            references: [1],
            count_ref: 1,
          },
        },
        { text: "listo" },
      ],
    );

    // THE READ THAT WORKED WORKED, and its row was served under [1] — so
    // its own savepoint was released and its work was not rolled back with
    // the other's.
    expect(toolResults[0]).toContain("[1]");
    expect(toolResults[0]).toContain("found something");
    expect(toolResults[1]).toMatch(/error/i);
    // ...and the turn ends exactly as one failing read ends it: `failed`,
    // with its record and its entry, and a reason that is not the owner's.
    expect(outcome.disposition).toBe("failed");
    expect(outcome.turn).toBeNull();
    expect(outcome.failure).not.toBeNull();
    expect(await chainLength()).toBe(before + 1);
    const rows = await ownerRows(
      a,
      `SELECT disposition FROM owner.executions WHERE id = ${literal(outcome.executionId)}`,
    );
    expect(rows).toEqual([{ disposition: "failed" }]);
  });
});

describe("the wall, over everything this suite surfaced", () => {
  it("shows no chat, no number and no other company's rows anywhere", () => {
    expect(surfaced.length).toBeGreaterThan(10);
    const findings: string[] = [];
    for (const { where, text } of surfaced) {
      if (/@(s\.whatsapp\.net|g\.us|lid|broadcast)/i.test(text)) {
        findings.push(`${where}: a WhatsApp address`);
      }
      if (text.includes(CORPUS_PHONE) || text.includes(CORPUS_PHONE.replace(/\s/g, ""))) {
        findings.push(`${where}: the customer's phone number`);
      }
      for (const chat of [...a.chats, ...b.chats]) {
        if (text.includes(chat)) findings.push(`${where}: a chat id`);
      }
      if (text.includes(a.seat.twinId) || text.includes(b.seat.twinId)) {
        findings.push(`${where}: a twin id`);
      }
    }
    expect(findings).toEqual([]);
  });
});

/** Rows read back through the owner's own connection, under its policy. */
async function ownerRows(
  corpus: OwnerCorpus,
  sql: string,
): Promise<readonly Record<string, unknown>[]> {
  return withOwner(corpus, async (client) => {
    const res = await client.query<Record<string, unknown>>(sql);
    return res.rows;
  });
}

/** One `dito_owner` connection with a company declared. */
async function withOwner<T>(
  corpus: OwnerCorpus,
  fn: (client: pg.Client) => Promise<T>,
): Promise<T> {
  return withRoleClient(OWNER_ROLE, OWNER_TEST_PASSWORD, async (client) => {
    await client.query("SELECT set_config($1, $2, false)", [
      OWNER_COMPANY_SETTING,
      corpus.seat.companyId,
    ]);
    return fn(client);
  });
}

/**
 * How many finalized facts one company has, counted as the schema owner.
 *
 * IT DECLARES A COMPANY, and it has to: the finalized views run as
 * `dito_ledger_views` under the company policy since #127, so a session
 * naming no company reads nothing through them however privileged it is.
 * That is the independent number every count assertion here is checked
 * against — the owner twin's own tools are what is under test, so the
 * expected value may not come from them.
 */
async function finalizedFacts(
  companyId: string,
  factType?: string,
): Promise<number> {
  await db.query("SELECT set_config($1, $2, false)", [
    OWNER_COMPANY_SETTING,
    companyId,
  ]);
  const res = await db.query<{ n: string }>(
    `SELECT count(*) AS n FROM ledger.finalized_facts
      WHERE ($1::text IS NULL OR fact_type = $1)`,
    [factType ?? null],
  );
  return Number(res.rows[0]!.n);
}

/**
 * How many entries the OWNER's chain holds, across every company.
 *
 * `owner.audit_chain` since #165, and not `public.audit_chain`: the owner
 * side appends to its own chain under its own key, and `dito_owner` holds
 * nothing on the rep side's (#157). Counted as the schema owner, which
 * bypasses row-level security, so this is every company's — the per-company
 * split is asserted where it belongs, below.
 */
async function chainLength(): Promise<number> {
  const res = await db.query<{ n: string }>(
    "SELECT count(*) AS n FROM owner.audit_chain",
  );
  return Number(res.rows[0]!.n);
}

/** How many rows one owner relation holds, across every company. */
async function ownerRowCount(relation: string): Promise<number> {
  const res = await db.query<{ n: string }>(`SELECT count(*) AS n FROM ${relation}`);
  return Number(res.rows[0]!.n);
}

/** A single-quoted SQL literal, for the two places a parameter cannot go. */
function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
