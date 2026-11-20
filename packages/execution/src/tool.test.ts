/**
 * The gate on the tool (ADR-0013 as amended twice; ticket #128 AC 1 and
 * AC 2; spec #126 decisions 5(a) and 6).
 *
 * Two halves, and they are checked by two different tools. The COMPILE-TIME
 * half is the `@ts-expect-error` below, run by `pnpm typecheck` — a tool
 * declaration with no gate is not a valid argument, and the day it becomes
 * one this file stops compiling. The RUNTIME half is `defineTool` throwing,
 * which is what catches a declaration assembled from something the type
 * system never saw.
 */
import { describe, expect, it } from "vitest";
import {
  defineTool,
  ToolDeclarationError,
  projectionViolations,
  repEvidencedViolations,
  inputViolations,
  type EffectOutcome,
  type ProjectionToolDeclaration,
  type RepEvidencedToolDeclaration,
  type ToolDeclaration,
} from "./tool.js";

/** One performed effect, as any effect tool's handler returns one. */
const PERFORMED: EffectOutcome = {
  performed: true,
  told: "done",
  receipt: "Listo.",
  act: "dismissed",
};

/** A row-narrowing schema in the shape spec #126 decision 16 describes. */
const TIMELINE_SCHEMA = {
  type: "object",
  properties: {
    entity_id: { type: "string", description: "The entity to read." },
    since: { type: "string", description: "Window start, ISO date." },
    fact_type: { type: ["string", "null"], description: "One fact type." },
  },
  required: ["entity_id", "since", "fact_type"],
  additionalProperties: false,
} as const;

const READ_TIMELINE: ProjectionToolDeclaration = {
  name: "read_timeline",
  description: "Read one entity's finalized facts in a window.",
  gate: "projection",
  columns: ["fact_id", "fact_type", "occurred_at", "filed_at", "seat_id"],
  inputSchema: TIMELINE_SCHEMA,
  run: () => "[]",
};

describe("a tool carries a gate or does not exist (ADR-0013)", () => {
  it("does not compile without one", () => {
    // THE FENCE ITSELF, and `pnpm typecheck` is what runs it: the
    // `@ts-expect-error` fails the build if the error ever stops firing —
    // red both when a gateless declaration starts typechecking and when
    // somebody makes `gate` optional to get past it.
    const gateless = {
      name: "read_timeline",
      description: "Read one entity's finalized facts in a window.",
      inputSchema: TIMELINE_SCHEMA,
      run: () => "[]",
    };
    // @ts-expect-error — no `gate` (ADR-0013: a tool cannot be constructed without one)
    expect(() => defineTool(gateless)).toThrow(ToolDeclarationError);
  });

  it("refuses one assembled dynamically, where no type was ever checked", () => {
    // The path the type cannot reach: a declaration read out of JSON, or
    // widened through a cast on its way to the constructor. The refusal is
    // loud and names the four declared values, because the reader of the
    // error is somebody adding a tool.
    const fromElsewhere = JSON.parse(
      '{"name":"read_timeline","description":"d","inputSchema":{"type":"object","properties":{},"additionalProperties":false}}',
    ) as ToolDeclaration;
    expect(() =>
      defineTool({ ...fromElsewhere, run: () => "[]" } as ToolDeclaration),
    ).toThrow(/gate/);
  });

  it("refuses a gate word that is not one of the four", () => {
    expect(() =>
      defineTool({
        ...READ_TIMELINE,
        gate: "disclosed-after",
      } as unknown as ToolDeclaration),
    ).toThrow(ToolDeclarationError);
  });

  it("constructs a read tool that declares its projection", () => {
    const tool = defineTool(READ_TIMELINE);
    expect(tool.gate).toBe("projection");
    expect(tool.columns).toEqual([
      "fact_id",
      "fact_type",
      "occurred_at",
      "filed_at",
      "seat_id",
    ]);
  });

  it("constructs an effect tool under either time-gated shape", () => {
    for (const gate of [
      "approve-before",
      "disclosed-and-undoable-after",
    ] as const) {
      const tool = defineTool({
        name: "create_draft",
        description: "Propose a reply for the rep's tap.",
        gate,
        inputSchema: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
          additionalProperties: false,
        },
        run: () => PERFORMED,
      });
      expect(tool.gate).toBe(gate);
    }
  });
});

/**
 * THE THIRD GATE SHAPE (ticket #174; ADR-0013 as amended 2026-09-04).
 *
 * The half this package can enforce is the DECLARATION's: a tool that
 * claims `rep-evidenced` must ask for the rep's own message id, and ask for
 * it in a way the model cannot leave out. The other half — whether the id
 * that arrives is this execution's trigger — is the owning app's, checked
 * in the handler against the trigger and the seam row behind it, because
 * this package holds neither (`dependency-wall.test.ts`).
 */
describe("a rep-evidenced tool cannot exist without an evidence parameter", () => {
  const DISMISS_SCHEMA = {
    type: "object",
    properties: {
      evidence: {
        type: "string",
        description: "The id of the rep's own message that asked for this.",
      },
    },
    required: ["evidence"],
    additionalProperties: false,
  } as const;

  const DISMISS_DRAFT: RepEvidencedToolDeclaration = {
    name: "dismiss_draft",
    description: "Discard the draft the rep quoted.",
    gate: "rep-evidenced",
    evidence: "evidence",
    inputSchema: DISMISS_SCHEMA,
    run: () => PERFORMED,
  };

  it("constructs one that names a required parameter it declares", () => {
    const tool = defineTool(DISMISS_DRAFT);
    expect(tool.gate).toBe("rep-evidenced");
    expect(tool.evidence).toBe("evidence");
  });

  it("does not compile without the evidence field", () => {
    const nameless = {
      name: "dismiss_draft",
      description: "Discard the draft the rep quoted.",
      gate: "rep-evidenced",
      inputSchema: DISMISS_SCHEMA,
      run: () => PERFORMED,
    };
    // @ts-expect-error — no `evidence` (ADR-0013 as amended: a rep-evidenced tool names the parameter carrying the rep's message id)
    expect(() => defineTool(nameless)).toThrow(ToolDeclarationError);
  });

  it("refuses one whose schema does not declare the parameter it names", () => {
    expect(() =>
      defineTool({ ...DISMISS_DRAFT, evidence: "message_id" }),
    ).toThrow(/`message_id` is not one the schema declares/u);
  });

  it("refuses one whose evidence parameter the model may omit", () => {
    // A declared-but-optional evidence parameter is a gate that is skipped
    // by leaving it out: `inputViolations` enforces `required` at run time
    // and has nothing to enforce here.
    expect(() =>
      defineTool({
        ...DISMISS_DRAFT,
        inputSchema: { ...DISMISS_SCHEMA, required: [] },
      }),
    ).toThrow(/not in `required`/u);
  });

  it("refuses one assembled dynamically with no evidence field at all", () => {
    const fromElsewhere = JSON.parse(
      '{"name":"dismiss_draft","description":"d","gate":"rep-evidenced","inputSchema":{"type":"object","properties":{},"additionalProperties":false}}',
    ) as RepEvidencedToolDeclaration;
    expect(() => defineTool({ ...fromElsewhere, run: () => PERFORMED })).toThrow(
      /names none/u,
    );
  });

  it("says what is wrong without being asked to construct anything", () => {
    // The rule as a pure function, biting against a synthetic offender —
    // `projectionViolations`' own habit, so the sentences a reader meets in
    // the throw are the sentences this test pins.
    expect(
      repEvidencedViolations({
        evidence: "evidence",
        inputSchema: {
          type: "object",
          properties: { draft_id: { type: "string" } },
          required: ["draft_id"],
          additionalProperties: false,
        },
      }),
    ).toEqual([
      "its evidence parameter `evidence` is not one the schema declares, so the model has no way to send it",
      "its evidence parameter `evidence` is not in `required`, so the model may omit it and the gate would be skipped by omission",
    ]);
  });
});

describe("a read owes a projection its caller cannot widen (ADR-0013 amendment)", () => {
  it("refuses a parameter that names the columns to return", () => {
    expect(() =>
      defineTool({
        ...READ_TIMELINE,
        inputSchema: {
          type: "object",
          properties: {
            entity_id: { type: "string" },
            columns: { type: "array", items: { type: "string" } },
          },
          required: ["entity_id", "columns"],
          additionalProperties: false,
        },
      }),
    ).toThrow(/columns/);
  });

  it("refuses a parameter that names a table", () => {
    expect(() =>
      defineTool({
        ...READ_TIMELINE,
        inputSchema: {
          type: "object",
          properties: {
            entity_id: { type: "string" },
            view: { type: "string" },
          },
          required: ["entity_id", "view"],
          additionalProperties: false,
        },
      }),
    ).toThrow(/view/);
  });

  it("refuses a parameter that names the company, in any spelling", () => {
    for (const name of ["company", "companyId", "company_id", "tenant-id"]) {
      expect(() =>
        defineTool({
          ...READ_TIMELINE,
          inputSchema: {
            type: "object",
            properties: { [name]: { type: "string" } },
            required: [name],
            additionalProperties: false,
          },
        }),
      ).toThrow(new RegExp(name));
    }
  });

  it("refuses a compound name that merely contains the word", () => {
    // Codex r1: a whole-string comparison let `companySlug`, `tableName`
    // and `columnsToReturn` straight through while the acceptance
    // criterion says every property NAMING a column, table or company is
    // refused. The check reads words, not strings.
    for (const name of [
      "companySlug",
      "tableName",
      "columnsToReturn",
      "target_view",
      "raw_sql_filter",
      // Codex r3: the short spellings the earlier list admitted missing.
      "cols",
      "returnFields",
    ]) {
      expect(() =>
        defineTool({
          ...READ_TIMELINE,
          inputSchema: {
            type: "object",
            properties: { [name]: { type: "string" } },
            additionalProperties: false,
          },
        }),
      ).toThrow(new RegExp(name));
    }
  });

  it("names one widening once, however many ways it matches", () => {
    // `companyId` matches "the company" by its joined spelling AND by its
    // first word. One parameter, one sentence.
    expect(
      projectionViolations({
        columns: ["fact_id"],
        inputSchema: {
          type: "object",
          properties: { companyId: { type: "string" } },
          additionalProperties: false,
        },
      }),
    ).toEqual(["the parameter `companyId` widens the company"]);
  });

  it("refuses one buried in a nested object, not only at the top", () => {
    // A flat sweep of the top-level property names would let this through,
    // and the model fills nested objects exactly as it fills top-level
    // ones.
    expect(() =>
      defineTool({
        ...READ_TIMELINE,
        inputSchema: {
          type: "object",
          properties: {
            window: {
              type: "object",
              properties: { since: { type: "string" }, sql: { type: "string" } },
            },
          },
          additionalProperties: false,
        },
      }),
    ).toThrow(/sql/);
  });

  it("refuses an open schema, where the fenced names mean nothing", () => {
    expect(() =>
      defineTool({
        ...READ_TIMELINE,
        inputSchema: {
          type: "object",
          properties: { entity_id: { type: "string" } },
          required: ["entity_id"],
        },
      }),
    ).toThrow(/additionalProperties/);
  });

  it("refuses an open object nested inside a closed one", () => {
    // Codex r2: a closed root with an open object inside it is open. The
    // model can put `company`, `table` or `columns` one level down, where
    // no declared name exists for the name fence to refuse.
    expect(() =>
      defineTool({
        ...READ_TIMELINE,
        inputSchema: {
          type: "object",
          properties: {
            entity_id: { type: "string" },
            filter: { type: "object" },
          },
          additionalProperties: false,
        },
      }),
    ).toThrow(/additionalProperties/);
  });

  it("refuses a read that declares no columns at all", () => {
    expect(() => defineTool({ ...READ_TIMELINE, columns: [] })).toThrow(
      /column/,
    );
  });

  it("leaves the four row selectors alone", () => {
    // The selectors ADR-0013 names by hand — an entity, a window, a fact
    // type, a seat — plus the entity NAME that spec #126 decision 16's
    // resolve-entity tool takes, which is the one the ADR's list does not
    // mention and the fence must not eat.
    const tool = defineTool({
      ...READ_TIMELINE,
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          entity_id: { type: "string" },
          since: { type: "string" },
          until: { type: "string" },
          fact_type: { type: "string" },
          seat_id: { type: "string" },
          limit: { type: "integer" },
        },
        additionalProperties: false,
      },
    });
    expect(tool.name).toBe("read_timeline");
  });

  it("leaves a window spelled `from`/`to` alone", () => {
    // SQL's FROM names a table; a tool parameter called `from` names the
    // start of a window, which ADR-0013 lists as a legitimate row selector.
    // A fence that ate the obvious spelling would be the wrong fence.
    const tool = defineTool({
      ...READ_TIMELINE,
      inputSchema: {
        type: "object",
        properties: {
          entity_id: { type: "string" },
          from: { type: "string" },
          to: { type: "string" },
        },
        additionalProperties: false,
      },
    });
    expect(tool.name).toBe("read_timeline");
  });

  it("bites when shown an offending declaration, and lets a clean one through", () => {
    // Proof the greens above are a result and not a rule that matches
    // nothing (the `sole-writer.test.ts` habit: the rule is a pure
    // function, so it can be shown to bite).
    expect(
      projectionViolations({
        columns: ["fact_id"],
        inputSchema: {
          type: "object",
          properties: { entity_id: { type: "string" }, table: { type: "string" } },
          additionalProperties: false,
        },
      }),
    ).toEqual(["the parameter `table` widens the table"]);
    expect(
      projectionViolations({
        columns: ["fact_id"],
        inputSchema: {
          type: "object",
          properties: { entity_id: { type: "string" } },
          additionalProperties: false,
        },
      }),
    ).toEqual([]);
  });

  it("says nothing about an effect tool's parameters", () => {
    // The projection rule is the READ's obligation. An effect tool with a
    // gate may legitimately take a company id — the aperture's own writes
    // do — and a fence that ate those would be the wrong fence in the
    // wrong place.
    const tool = defineTool({
      name: "file_fact",
      description: "File one fact.",
      gate: "disclosed-and-undoable-after",
      inputSchema: {
        type: "object",
        properties: { company_id: { type: "string" } },
        required: ["company_id"],
        additionalProperties: false,
      },
      run: () => PERFORMED,
    });
    expect(tool.gate).toBe("disclosed-and-undoable-after");
  });
});

describe("a closed schema is enforced, not merely declared (Codex r1, r3)", () => {
  // The MCP server the runner serves tools from validates nothing, so `additionalProperties: false` and `required` tell
  // the model what to send and stop nothing from arriving. This is the rule
  // that makes both true of what a handler receives.
  const SCHEMA = {
    type: "object",
    properties: { entity_id: { type: "string" }, since: { type: "string" } },
    required: ["entity_id"],
    additionalProperties: false,
  } as const;

  it("names the parameters the schema never declared", () => {
    expect(
      inputViolations(SCHEMA, {
        entity_id: "e1",
        company_id: "c9",
        columns: ["everything"],
      }),
    ).toEqual([
      "`company_id` is not a parameter of this tool",
      "`columns` is not a parameter of this tool",
    ]);
  });

  it("names a required selector that never arrived", () => {
    // A read whose `entity_id` is absent is a read with no entity, and a
    // handler treating an absent selector as "no filter" would return more
    // rows than its schema says it can be asked for.
    expect(inputViolations(SCHEMA, { since: "2026-09-01" })).toEqual([
      "`entity_id` is required and was not given",
    ]);
    expect(inputViolations(SCHEMA, {})).toEqual([
      "`entity_id` is required and was not given",
    ]);
  });

  it("names an undeclared parameter nested inside a declared object", () => {
    const nested = {
      type: "object",
      properties: {
        entity_id: { type: "string" },
        window: {
          type: "object",
          properties: { from: { type: "string" }, to: { type: "string" } },
          additionalProperties: false,
        },
      },
      required: ["entity_id"],
      additionalProperties: false,
    } as const;
    expect(
      inputViolations(nested, {
        entity_id: "e1",
        window: { from: "2026-09-01", company: "another-company" },
      }),
    ).toEqual(["`window.company` is not a parameter of this tool"]);
  });

  it("says nothing about an input that declares only what it should", () => {
    expect(
      inputViolations(SCHEMA, { entity_id: "e1", since: "2026-09-01" }),
    ).toEqual([]);
  });

  it("says nothing when the schema left itself open", () => {
    // An open schema is refused at construction for a read; for an effect
    // tool it is legitimate, and this rule has no opinion on it.
    expect(
      inputViolations(
        { type: "object", properties: { a: { type: "string" } } },
        { a: "1", b: "2" },
      ),
    ).toEqual([]);
  });
});
