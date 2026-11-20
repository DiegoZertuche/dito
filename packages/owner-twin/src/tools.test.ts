/**
 * What the three tools DECLARE, asserted without a database (ticket #130;
 * spec #126 decision 6; ADR-0013 as amended).
 *
 * What they RETURN is asserted at the Postgres seam, as `dito_owner`, in
 * `turn.int.test.ts` — the seam the spec names. What is here is the half a
 * connection cannot show: that each declaration is a projection, that its
 * parameters select rows and nothing else, and that what it says it returns
 * is a subset of what the owner role may see at all.
 */
import { FACT_TYPES } from "@dito/aperture";
import {
  assertToolDeclaration,
  defineTool,
  projectionViolations,
  ToolDeclarationError,
} from "@dito/execution";
import type pg from "pg";
import { describe, expect, it } from "vitest";
import { ServedRows } from "./served.js";
import {
  COUNT_FACTS_TOOL,
  OWNER_TOOL_COLUMNS,
  OWNER_VISIBLE_COLUMNS,
  READ_TIMELINE_TOOL,
  RESOLVE_ENTITY_TOOL,
  countFactsTool,
  readTimelineTool,
  resolveEntityTool,
} from "./tools.js";

/** No query is made by any assertion below; a call would be the failure. */
const NO_CLIENT = {
  query: () => {
    throw new Error("this suite makes no query");
  },
} as unknown as pg.ClientBase;

/** Pinned, because the lag boundary is measured from it. */
const ASKED_AT = new Date("2026-09-02T18:00:00Z");

/**
 * The three reads, built for one turn — assembled here rather than by a
 * library function, because there is no library function any more (#178):
 * the registry names them one at a time and `turn.ts` goes through it, so a
 * composition kept alive only by this helper was dead code.
 */
function tools() {
  const options = {
    client: NO_CLIENT,
    served: new ServedRows(),
    timeZone: "America/Monterrey",
    askedAt: ASKED_AT,
  };
  return [
    resolveEntityTool(options),
    readTimelineTool(options),
    countFactsTool(options),
  ];
}

describe("the owner twin's tools (spec #126 decision 16)", () => {
  it("are the three the spec names, and every one of them is a read", () => {
    expect(tools().map((tool) => tool.name)).toEqual([
      RESOLVE_ENTITY_TOOL,
      READ_TIMELINE_TOOL,
      COUNT_FACTS_TOOL,
    ]);
    for (const tool of tools()) expect(tool.gate).toBe("projection");
  });

  it("declares a projection no caller can widen", () => {
    // `defineTool` already refused at construction; this says so where a
    // reader looks for it, and covers all three at once.
    for (const tool of tools()) {
      expect(projectionViolations(tool), tool.name).toEqual([]);
      expect(() => {
        assertToolDeclaration(tool);
      }).not.toThrow();
    }
  });

  it("returns only columns the owner role may see at all", () => {
    // THE PROJECTION IS THE GRANT. A tool that declared a column outside
    // `OWNER_VISIBLE_COLUMNS` would be claiming to return something the
    // role cannot select — either a lie, or the first sign of a column
    // arriving on a view nobody pinned (ADR-0002 calls that a spine change).
    for (const [tool, columns] of Object.entries(OWNER_TOOL_COLUMNS)) {
      if (tool === COUNT_FACTS_TOOL) continue;
      for (const qualified of columns) {
        const cut = qualified.lastIndexOf(".");
        const view = qualified.slice(0, cut);
        const column = qualified.slice(cut + 1);
        expect(
          OWNER_VISIBLE_COLUMNS[view] ?? [],
          `${tool} declares ${qualified}`,
        ).toContain(column);
      }
    }
  });

  it("declares the count as an aggregate and not as columns", () => {
    // The one tool whose projection is not a subset of a view's, because it
    // returns no row values at all — a caller cannot widen a number.
    expect(OWNER_TOOL_COLUMNS[COUNT_FACTS_TOOL]).toEqual(["count"]);
  });

  it("names no parameter that could widen the read", () => {
    // The fence by hand, over the names actually declared, so a reader sees
    // the list rather than trusting that `defineTool` looked at it.
    const declared = tools().flatMap((tool) =>
      Object.keys(tool.inputSchema.properties ?? {}),
    );
    expect(declared.sort()).toEqual([
      "entity_ref",
      "fact_type",
      "fact_type",
      "from",
      "from",
      "name",
      "seat_name",
      "to",
      "to",
    ]);
  });

  it("closes every schema, so an undeclared parameter never reaches a handler", () => {
    for (const tool of tools()) {
      expect(tool.inputSchema.additionalProperties, tool.name).toBe(false);
    }
  });

  it("cannot be built with a parameter that names a column, a table or a company", () => {
    // THE FENCE, SHOWN TO BITE (AC 6, and `sole-writer.test.ts`'s habit:
    // an invariant nobody has seen fail is a comment). Three planted
    // declarations, one per widening word group, each refused at
    // construction — which is where a reviewer would meet it.
    const planted: readonly (readonly [string, string])[] = [
      ["columns", "the columns returned"],
      ["table_name", "the table"],
      ["company_id", "the company"],
    ];
    for (const [parameter, widens] of planted) {
      const declaration = {
        name: "planted_read",
        gate: "projection",
        description: "a read whose caller could widen it",
        columns: ["ledger.finalized_facts.id"],
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: [parameter],
          properties: { [parameter]: { type: "string" } },
        },
        run: () => "never called",
      } as const;
      expect(
        projectionViolations(declaration).join(" "),
        parameter,
      ).toContain(`widens ${widens}`);
      expect(() => defineTool(declaration), parameter).toThrow(
        ToolDeclarationError,
      );
    }
  });

  it("offers the model the closed fact-type set and nothing wider", () => {
    const schemas = tools().map((tool) => tool.inputSchema.properties ?? {});
    for (const properties of schemas) {
      const factType = properties["fact_type"] as
        | { enum?: readonly string[] }
        | undefined;
      if (factType === undefined) continue;
      expect(factType.enum).toEqual([...FACT_TYPES]);
    }
  });

  it("refuses a widening parameter on a DIRECT call, not only through the runner (AC 6)", async () => {
    // THE ACCEPTANCE CRITERION SAYS "called directly" (Codex r3). The runner
    // validates every call it makes; a caller that is not the runner used to
    // reach the handler, which read `{ name }` and ignored `company_id`
    // beside it. The check is the runner's own `inputViolations`, applied in
    // both places rather than restated.
    const [resolveEntity, readTimeline, countFacts] = tools();
    // `run` answers synchronously here — the refusal happens before the
    // handler is entered at all, which is the property under test.
    expect(
      await resolveEntity!.run({ name: "Torres", columns: ["payload"] }),
    ).toContain("`columns` is not a parameter of this tool");
    expect(
      await readTimeline!.run({ entity_ref: 1, company_id: "other" }),
    ).toContain("`company_id` is not a parameter of this tool");
    expect(
      await countFacts!.run({ fact_type: "QuoteGiven", table: "facts" }),
    ).toContain("`table` is not a parameter of this tool");
    // ...and a required selector that never arrived.
    expect(await readTimeline!.run({})).toContain(
      "`entity_ref` is required and was not given",
    );
  });

  it("refuses a reference no tool served this turn, before it reads anything", async () => {
    // The grounding rule one layer below the answer's. The client
    // above throws on any query, so a handler that got as far as reading
    // would fail this test loudly rather than quietly.
    const [, readTimeline] = tools();
    await expect(readTimeline!.run({ entity_ref: 7 })).resolves.toBe(
      "rejected: entity_ref 7 was never returned by a tool this turn",
    );
  });

  it("refuses a reference that is not a whole number", async () => {
    const [, readTimeline] = tools();
    await expect(readTimeline!.run({ entity_ref: "e-1" })).resolves.toContain(
      "rejected: entity_ref must be a whole number",
    );
  });

  it("refuses a fact type the Ledger does not record", async () => {
    const [, , countFacts] = tools();
    await expect(countFacts!.run({ fact_type: "Complaint" })).resolves.toContain(
      "rejected: fact_type must be one of",
    );
  });

  it("refuses a window whose start is after its end", async () => {
    const [, , countFacts] = tools();
    await expect(
      countFacts!.run({
        fact_type: "QuoteGiven",
        from: "2026-09-02T00:00:00Z",
        to: "2026-08-02T00:00:00Z",
      }),
    ).resolves.toContain("rejected: from is after to");
  });

  it("refuses a window that starts inside the record's own lag (FR-69)", async () => {
    // A window narrowed to the recent region can only come back empty, and
    // its emptiness is exactly what FR-69 says must not be revealed. The
    // clock is the server's — `ASKED_AT` — never the model's.
    const [, , countFacts] = tools();
    await expect(
      countFacts!.run({
        fact_type: "QuoteGiven",
        from: new Date(ASKED_AT.getTime() - 60 * 60 * 1000).toISOString(),
      }),
    ).resolves.toContain("has not finished with");
  });

  it("reads a window anchored before the lag, and an unbounded one", async () => {
    // The other direction: whatever a finalized read returns is firm, so
    // its emptiness says nothing about today. The client throws on any
    // query, so reaching the read is the assertion.
    const [, , countFacts] = tools();
    await expect(
      countFacts!.run({
        fact_type: "QuoteGiven",
        from: new Date(ASKED_AT.getTime() - 72 * 60 * 60 * 1000).toISOString(),
      }),
    ).rejects.toThrow("this suite makes no query");
    await expect(countFacts!.run({ fact_type: "QuoteGiven" })).rejects.toThrow(
      "this suite makes no query",
    );
  });

  it("refuses a name that is not one", async () => {
    const [resolveEntity] = tools();
    await expect(resolveEntity!.run({ name: "   " })).resolves.toBe(
      "rejected: name must be a non-empty string",
    );
  });
});
