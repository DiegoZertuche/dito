/**
 * The owner twin's three tools, all reads, all projection-gated (ticket
 * #130; spec #126 decisions 6 and 16; ADR-0013 as amended).
 *
 * "A read-only tool has no effect to gate and owes a projection — by
 * construction, three things." All three are here rather than described:
 *
 *   IT RUNS AS THE SURFACE'S OWN DATABASE ROLE. Every tool below calls one
 *   of #129's owner reads with the `pg.ClientBase` the app authenticated as
 *   `dito_owner` and declared a company on. Nothing here holds a
 *   connection, opens one, or knows a credential, and there is no SQL in
 *   this file at all: what these tools CAN return is fixed by the grant and
 *   by row-level security, not by their code.
 *
 *   ITS PARAMETERS SELECT ROWS. An entity, a window, a fact type, a seat —
 *   ADR-0013's four, and nothing else. `defineTool` re-checks that by name
 *   at construction, and the schemas below are closed at every depth so the
 *   runtime refuses an undeclared property before the handler is called.
 *
 *   THE SURFACE RENDERS PROVENANCE FROM THE ROWS THE TOOL RETURNED. Every
 *   row any of these serves goes into the run's `ServedRows` first and is
 *   handed to the model second, under the reference that map minted. The
 *   answer's citations resolve against that map or they are refused.
 *
 * THE ENTITY IS CITED, NOT NAMED (the one design choice here worth
 * arguing). `read_timeline` takes `entity_ref` — a reference the resolution
 * tool served this run — rather than an entity id. Three things follow, and
 * the third is the reason:
 *   - a model cites `2` reliably and a uuid unreliably;
 *   - an id it could type is an id it could invent, and an invented uuid
 *     reads as a miss (`entity` comes back null for every kind of miss, by
 *     #129's design) rather than as the refusal it is;
 *   - the timeline is then reachable ONLY through the resolution the owner
 *     could have watched happen, which is what "answer only from what the
 *     tools returned" means one layer down from the prose.
 *
 * TYPES AND ENUMS ARE VALIDATED HERE, because nothing else does it. The
 * wire validates nothing, and `@dito/execution`'s `inputViolations` deliberately
 * checks exactly two properties — what arrived was declared, and what was
 * required arrived. Every handler below therefore reads its own arguments
 * defensively and answers `rejected: …` to the model, which is the shape
 * the runner's own rejections already carry back into the loop.
 */
import {
  countOwnerFacts,
  FACT_TYPES,
  OWNER_VISIBLE_COLUMNS,
  readOwnerTimeline,
  renderOwnerEntityKind,
  renderOwnerEntityName,
  renderOwnerFactLine,
  renderOwnerInstant,
  resolveOwnerEntityByName,
  resolveOwnerSeatByName,
  type OwnerFact,
  type OwnerTimelineWindow,
} from "@dito/aperture";
import {
  defineTool,
  finalizedThrough,
  inputViolations,
  type ProjectionToolDeclaration,
} from "@dito/execution";
import type pg from "pg";
import type { ServedRow, ServedRows } from "./served.js";

/**
 * HOW FAR BEHIND THE RECORD RUNS, in hours (FR-69; Codex r1 and r2).
 *
 * WHY A NUMBER HERE AT ALL. The finalized views hold only finalized facts,
 * so an UNBOUNDED read leaks nothing: whatever it returns is firm, and its
 * emptiness says nothing about today. A window NARROWED TO THE RECENT
 * REGION is the different case — it is always empty, always for the same
 * reason, and its emptiness is exactly the fact FR-69 says must not be
 * revealed ("not that it is empty, not that it is quiet, not that there is
 * nothing new"). So a read whose window STARTS inside that region is
 * refused before it is issued, and a read anchored earlier is not.
 *
 * TWENTY-FOUR HOURS IS THE PRODUCT'S OWN NUMBER — the owner web's standing
 * copy says the record "may run up to 24 hours behind" — and it is
 * deliberately generous: over-refusing a window is a read the owner can
 * re-ask with an earlier anchor, and under-refusing one is the leak.
 *
 * THE CLOCK IS THE SERVER'S, never the model's: the cutoff is measured from
 * the instant the app recorded the question, which the model cannot move.
 */
export const OWNER_LAG_HOURS = 24;

/** The three tools' names, in one place, so the instructions cannot drift. */
export const RESOLVE_ENTITY_TOOL = "resolve_entity";
export const READ_TIMELINE_TOOL = "read_timeline";
export const COUNT_FACTS_TOOL = "count_facts";

/**
 * The pinned projections, qualified by the view each column comes from.
 *
 * QUALIFIED SO THEY CAN BE DIFFED. `OWNER_VISIBLE_COLUMNS` pins what the
 * owner ROLE may see, view by view; these pin what each TOOL returns out of
 * that, and `tools.test.ts` asserts the second is a subset of the first. An
 * unqualified `id` could not be checked against anything.
 */
const ENTITY_COLUMNS = [
  "ledger.finalized_entities.entity_id",
  "ledger.finalized_entities.kind",
  "ledger.finalized_entities.display_name",
] as const;

const FACT_COLUMNS = [
  "ledger.finalized_facts.id",
  "ledger.finalized_facts.entity_id",
  "ledger.finalized_facts.fact_type",
  "ledger.finalized_facts.payload_version",
  "ledger.finalized_facts.payload",
  "ledger.finalized_facts.occurred_at",
  "ledger.finalized_facts.filed_at",
  "ledger.finalized_facts.confidence",
  "ledger.finalized_facts.source_type",
  "ledger.finalized_facts.filed_by_seat_id",
  "public.seats_status.display_name",
] as const;

/**
 * ...and the count's, which is the one that is not a column at all.
 *
 * A COUNT RETURNS AN AGGREGATE AND NO ROW VALUES, and saying so is the
 * strongest true statement this declaration can make. Listing the columns
 * the count is computed over would claim the tool RETURNS them, which is
 * exactly what it does not do and exactly what the projection exists to
 * fix: a caller cannot widen a number.
 */
const COUNT_COLUMNS = ["count"] as const;

/** What every read may be narrowed by, as JSON Schema, written once. */
const WINDOW_PROPERTIES = {
  from: {
    type: "string",
    description:
      "Optional. Only facts that happened at or after this instant. ISO-8601, e.g. 2026-08-24T00:00:00Z.",
  },
  to: {
    type: "string",
    description:
      "Optional. Only facts that happened at or before this instant. ISO-8601.",
  },
} as const;

/**
 * What one turn's reads are bound to: this connection, this run's served
 * map, this owner's zone and the instant the app recorded the question.
 *
 * NAMED because every factory takes it: it is what the owner twin's turn is
 * built over.
 */
export interface OwnerToolOptions {
  readonly client: pg.ClientBase;
  readonly served: ServedRows;
  /** The zone the owner's instants are rendered in, from the app's environment. */
  readonly timeZone: string;
  /** When the app recorded this question — the trusted clock the lag is measured from. */
  readonly askedAt: Date;
}

/**
 * A read's DECLARED HALF — everything but the handler.
 *
 * SPLIT FROM THE FACTORY AT #178, and the reason is the automation spec. A
 * spec's instruction parts are TEXT (they serialize, they diff, they stamp),
 * and the owner twin's «your tools» part is rendered from these four fields
 * — so the rendering has to be possible without a connection, a served map
 * or a turn. The handlers below close over all three; these do not close
 * over anything.
 */
export type OwnerToolDeclaration = Omit<ProjectionToolDeclaration, "run">;

const RESOLVE_ENTITY_DECLARATION: OwnerToolDeclaration = {
  name: RESOLVE_ENTITY_TOOL,
  gate: "projection",
  description:
    "Find the customers of this company whose name matches what the owner wrote. Returns zero, one or several candidates, each with a reference. Call this first: every other tool and every citation works from a reference this returned.",
  columns: ENTITY_COLUMNS,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["name"],
    properties: {
      name: {
        type: "string",
        description: "The customer name as the owner wrote it.",
      },
    },
  },
};

const READ_TIMELINE_DECLARATION: OwnerToolDeclaration = {
  name: READ_TIMELINE_TOOL,
  gate: "projection",
  description: `Read one customer's timeline of finalized facts, oldest first. Takes a reference ${RESOLVE_ENTITY_TOOL} returned. Records that were merged read as one timeline. Every fact comes back with a reference to cite it by.`,
  columns: FACT_COLUMNS,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["entity_ref"],
    properties: {
      entity_ref: {
        type: "integer",
        description: `The reference of a customer ${RESOLVE_ENTITY_TOOL} returned this turn.`,
      },
      ...WINDOW_PROPERTIES,
      fact_type: {
        type: "string",
        enum: [...FACT_TYPES],
        description: "Optional. Only facts of this one type.",
      },
    },
  },
};

const COUNT_FACTS_DECLARATION: OwnerToolDeclaration = {
  name: COUNT_FACTS_TOOL,
  gate: "projection",
  description:
    "Count this company's finalized facts of one type, optionally inside a window and optionally filed under one rep's seat. Returns a reference, not a number: the number itself is rendered from the reference, so cite it and never write it.",
  columns: COUNT_COLUMNS,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["fact_type"],
    properties: {
      fact_type: {
        type: "string",
        enum: [...FACT_TYPES],
        description: "The one fact type to count.",
      },
      ...WINDOW_PROPERTIES,
      seat_name: {
        type: "string",
        description:
          "Optional. Only facts filed under the seat of the rep with this name, as the owner wrote it.",
      },
    },
  },
};

/**
 * The three reads as the model is TOLD them, in the order the instructions
 * walk through them.
 *
 * What `ownerTwinInstructions` renders «your tools» from, and what the
 * automation spec's instruction parts are therefore built out of at module
 * load. Nothing here holds a closure, so no turn is needed to read it.
 */
export const OWNER_TOOL_DECLARATIONS: readonly OwnerToolDeclaration[] = [
  RESOLVE_ENTITY_DECLARATION,
  READ_TIMELINE_DECLARATION,
  COUNT_FACTS_DECLARATION,
];

/**
 * THE LAG BOUNDARY THIS TURN REFUSES AGAINST (FR-69).
 *
 * COMPUTED IN THE RUNTIME, WITH THE `now_owner` RECIPE (ticket #178). The
 * recipe TELLS the model which day the record is complete through and these
 * reads REFUSE a window anchored past it; a sentence that disagreed with the
 * refusal would be worse than no sentence, because the model would anchor
 * where it was told it could and be refused with no way to see why. One
 * computation, `finalizedThrough`, from the one lag above.
 */
function boundaryFor(options: OwnerToolOptions): Date {
  return finalizedThrough(options.askedAt, OWNER_LAG_HOURS);
}

/**
 * ONE FACTORY PER TOOL (ticket #178), composed per turn by `turn-tools.ts`,
 * which is the only path a tool reaches an execution by.
 *
 * A FACTORY BECAUSE A TOOL IS PER-RUN. The handlers close over the
 * connection the app opened and the map this execution serves into, so
 * nothing is shared between two owners, two companies or two questions. The
 * declarations they return are identical run to run, which is what keeps the
 * instructions digest stable (the digest covers the declaration, never the
 * closure) — and `OWNER_TOOL_DECLARATIONS` above is that identical half,
 * lifted out so the instruction text can be rendered without a turn.
 */

/** Who the owner meant, by name. */
export function resolveEntityTool(
  options: OwnerToolOptions,
): ProjectionToolDeclaration {
  const { client, served } = options;
  return schemaChecked(defineTool({
    ...RESOLVE_ENTITY_DECLARATION,
    run: async (input: unknown) => {
      const args = input as { name?: unknown };
      if (typeof args.name !== "string" || args.name.trim() === "") {
        return rejected("name must be a non-empty string").rejected;
      }
      const candidates = await resolveOwnerEntityByName(client, args.name);
      served.noteResolution();
      if (candidates.length === 0) return "no customer of this company matches that name";
      // MORE THAN ONE IS AMBIGUOUS, AND THE MARK IS WHAT MAKES ADR-0039'S
      // ASK STRUCTURAL (Codex r1). Until this the ask was instructed and
      // nothing else, so a model could pick one of two records with the
      // same name, read that one's timeline and answer about whichever it
      // happened to choose — an answer about the wrong customer, correctly
      // grounded in the wrong customer's facts.
      const group =
        candidates.length > 1 ? served.nextAmbiguityGroup() : undefined;
      return candidates
        .map(
          (entity) =>
            // THROUGH `renderOwnerEntityName`, not raw (#129's own Codex
            // r1). A cliente's display name is proposed off a push name the
            // customer sets and nothing refuses a phone number at filing —
            // so the model is shown what the room will show, and a
            // wall-shaped name never reaches a tool result either.
            `[${served.serveEntity(entity, group === undefined ? {} : { ambiguityGroup: group })}] ${renderOwnerEntityName(entity.displayName)} (${renderOwnerEntityKind(entity.kind)})`,
        )
        .join("\n");
    },
  }));
}

/** One customer's finalized facts, oldest first, inside a window. */
export function readTimelineTool(
  options: OwnerToolOptions,
): ProjectionToolDeclaration {
  const { client, served, timeZone } = options;
  const lagBoundary = boundaryFor(options);
  return schemaChecked(defineTool({
    ...READ_TIMELINE_DECLARATION,
    run: async (input: unknown) => {
      const args = input as {
        entity_ref?: unknown;
        from?: unknown;
        to?: unknown;
        fact_type?: unknown;
      };
      const row = servedRow(served, args.entity_ref, "entity_ref");
      if (isRejection(row)) return row.rejected;
      if (row.kind !== "entity") {
        return rejected(
          `entity_ref is not a customer — it is a ${row.kind} reference`,
        ).rejected;
      }
      if (served.isAmbiguous(row.ref)) {
        // THE ASK COMES FIRST (ADR-0039). Choosing between two records with
        // the same name is the owner's answer to give, and reading one of
        // them instead is choosing silently. The way out is the owner's:
        // they pick, and the next turn resolves the name they picked.
        return rejected(
          "entity_ref is one of several records that matched that name — ask which one the owner means before reading a timeline",
        ).rejected;
      }
      const window = readWindow(args, lagBoundary);
      if (isRejection(window)) return window.rejected;
      const timeline = await readOwnerTimeline(client, row.entity.entityId, window);
      served.noteRecordRead();
      if (timeline.facts.length === 0) {
        return "no finalized fact of this customer falls in that window";
      }
      return timeline.facts
        .map((fact) => timelineLine(fact, served.serveFact(fact), timeZone))
        .join("\n");
    },
  }));
}

/** How many facts of one type, as a reference and never as a number. */
export function countFactsTool(
  options: OwnerToolOptions,
): ProjectionToolDeclaration {
  const { client, served } = options;
  const lagBoundary = boundaryFor(options);
  return schemaChecked(defineTool({
    ...COUNT_FACTS_DECLARATION,
    run: async (input: unknown) => {
      const args = input as {
        fact_type?: unknown;
        from?: unknown;
        to?: unknown;
        seat_name?: unknown;
      };
      const factType = readFactType(args.fact_type);
      if (isRejection(factType)) return factType.rejected;
      const window = readWindow(args, lagBoundary);
      if (isRejection(window)) return window.rejected;

      let seatId: string | null = null;
      let seatName: string | null = null;
      let seatRef: number | undefined;
      if (args.seat_name !== undefined) {
        if (typeof args.seat_name !== "string" || args.seat_name.trim() === "") {
          return rejected("seat_name must be a non-empty string when given")
            .rejected;
        }
        const seats = await resolveOwnerSeatByName(client, args.seat_name);
        if (seats.length === 0) {
          return "no rep of this company has a seat under that name";
        }
        if (seats.length > 1) {
          // A count over two seats would be a number about two people
          // presented as a number about one. The owner twin's one legitimate
          // ask is entity disambiguation (ADR-0039), not this — so the tool
          // says what it found and counts nothing.
          return rejected(
            `${seats.length} seats of this company share that name, so a count under it would be a number about more than one rep`,
          ).rejected;
        }
        seatId = seats[0]!.seatId;
        seatName = seats[0]!.displayName;
        seatRef = served.serveSeat(seats[0]!);
      }

      const count = await countOwnerFacts(client, {
        factType,
        ...(window.from === undefined ? {} : { from: window.from }),
        ...(window.to === undefined ? {} : { to: window.to }),
        ...(seatId === null ? {} : { seatId }),
      });
      served.noteRecordRead();
      const ref = served.serveCount({
        factType,
        from: window.from ?? null,
        to: window.to ?? null,
        seatId,
        seatName,
        count,
      });
      // THE NUMBER IS NOT IN THIS RESULT, and that is the point. ADR-0037 as
      // amended: "the model never types a number." A model that never SEES
      // the number cannot type it — and it still has what it needs to choose
      // its words, because whether the count is zero is the only thing the
      // wording turns on. Everything else is the slot.
      const found = count === 0 ? "found nothing" : "found something";
      const under = seatRef === undefined ? "" : `, filed under the seat [${seatRef}]`;
      return `[${ref}] a count of ${factType}${under}: it ${found}. Cite [${ref}] where the number belongs; the number is rendered from this row.`;
    },
  }));
}

/**
 * One tool whose own `run` refuses an undeclared or missing parameter
 * (ticket #130 AC 6; Codex r3).
 *
 * THE RUNNER ALREADY DOES THIS, and that was the whole of the fence:
 * `@dito/execution` wraps every tool it hands the model and calls
 * `inputViolations` before the handler. But the acceptance criterion is
 * about the tool "called DIRECTLY as `dito_owner`" — and a declaration
 * whose exported `run` reads `{ name }` off an object and ignores
 * `company_id` beside it performs the read for any caller that is not the
 * runner. The check is the runner's own function, so there is one rule and
 * two places it is applied, rather than two rules.
 */
function schemaChecked(
  tool: ProjectionToolDeclaration,
): ProjectionToolDeclaration {
  return {
    ...tool,
    run: (input: unknown) => {
      const violations = inputViolations(tool.inputSchema, input);
      if (violations.length > 0) return `rejected: ${violations.join("; ")}`;
      return tool.run(input);
    },
  };
}

/**
 * WHY AN ARGUMENT WAS NOT READ, as its own type.
 *
 * A TYPE AND NOT A BARE `string` (the two-axis review's Standards axis).
 * Every reader below returns "the value, or the refusal", and while the
 * refusal was a `string` each caller had to ask `typeof x === "string"` —
 * which is a question about the channel and not about the answer, and which
 * BREAKS OUTRIGHT where the value is itself a string: `readFactType`
 * returns one, so its refusal had to be smuggled out in an object shaped
 * differently from every other. One type, one predicate, and the fact-type
 * reader stops being the exception.
 */
interface Rejection {
  readonly rejected: string;
}

/** The runner's own rejection shape, so every handler answers alike. */
function rejected(reason: string): Rejection {
  return { rejected: `rejected: ${reason}` };
}

function isRejection(value: unknown): value is Rejection {
  return typeof value === "object" && value !== null && "rejected" in value;
}

/** One served row behind a reference argument, or the refusal to send back. */
function servedRow(
  served: ServedRows,
  value: unknown,
  parameter: string,
): ServedRow | Rejection {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return rejected(`${parameter} must be a whole number a tool returned`);
  }
  const row = served.get(value);
  if (row === undefined) {
    // THE GROUNDING RULE, one layer earlier than the answer's. A
    // reference no tool served this run points at nothing, and a handler
    // that treated it as "some entity" would read a timeline the owner
    // never asked for.
    return rejected(`${parameter} ${value} was never returned by a tool this turn`);
  }
  return row;
}

/** A fact type argument, checked against the closed set. */
function readFactType(value: unknown): string | Rejection {
  if (
    typeof value !== "string" ||
    !(FACT_TYPES as readonly string[]).includes(value)
  ) {
    return rejected(
      `fact_type must be one of ${FACT_TYPES.join(", ")} — the Ledger records these six and nothing else`,
    );
  }
  return value;
}

/** A window argument, or the refusal to send back. */
function readWindow(
  args: {
    from?: unknown;
    to?: unknown;
    fact_type?: unknown;
  },
  lagBoundary: Date,
): OwnerTimelineWindow | Rejection {
  const from = readInstant(args.from, "from");
  if (isRejection(from)) return from;
  const to = readInstant(args.to, "to");
  if (isRejection(to)) return to;
  if (from !== undefined && to !== undefined && from > to) {
    return rejected("from is after to, so the window holds no instant at all");
  }
  // THE RECENT WINDOW IS NOT READ, IT IS REFUSED (FR-69; Codex r1, r2). A
  // window that STARTS after the lag boundary can only ever come back empty
  // — nothing in it has finalized — and "it is empty" is precisely what
  // FR-69 says must not be revealed about that window. Refused before the
  // query, so there is nothing to report on either way; an unbounded read,
  // or one anchored earlier, is untouched, because whatever it returns is
  // firm and its emptiness says nothing about today.
  if (from !== undefined && from > lagBoundary) {
    return rejected(
      "from starts inside the window the record has not finished with — what has not finalized is not readable and not describable, so answer with the by-design delay instead (FR-69)",
    );
  }
  let factType: string | undefined;
  if (args.fact_type !== undefined) {
    const read = readFactType(args.fact_type);
    if (isRejection(read)) return read;
    factType = read;
  }
  return {
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
    ...(factType === undefined ? {} : { factType }),
  };
}

/** One optional ISO-8601 bound. */
function readInstant(
  value: unknown,
  parameter: string,
): Date | undefined | Rejection {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    return rejected(`${parameter} must be an ISO-8601 instant`);
  }
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) {
    // NOT ECHOED (Codex r1): a rejection names the parameter and never
    // reflects what arrived. A model can put a chat address in `from`, and
    // a refusal that quotes it back has put it somewhere nobody swept.
    return rejected(`${parameter} is not an ISO-8601 instant this can read`);
  }
  return at;
}

/**
 * One fact as the model is shown it: its reference, the line CODE composed
 * from the payload, and when it happened.
 *
 * THE LINE IS `renderOwnerFactLine`'S, not a second rendering. The model is
 * shown exactly what code will render into the slot that cites this fact,
 * so an answer's prose and its values cannot describe different things.
 * The rest of the provenance — filed, confidence, source, seat — is not
 * here: it renders in the receipt strip at the bubble's foot from this same
 * row, and putting it in front of the model would only invite it to type
 * what code is about to render.
 */
function timelineLine(fact: OwnerFact, ref: number, timeZone: string): string {
  return `[${ref}] ${renderOwnerFactLine(fact)} (happened ${renderOwnerInstant(fact.occurredAt, timeZone)})`;
}

/** The pinned projections, exported so the suite can diff them. */
export const OWNER_TOOL_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  [RESOLVE_ENTITY_TOOL]: ENTITY_COLUMNS,
  [READ_TIMELINE_TOOL]: FACT_COLUMNS,
  [COUNT_FACTS_TOOL]: COUNT_COLUMNS,
};

/** ...and what they are diffed against, re-exported so the test names one source. */
export { OWNER_VISIBLE_COLUMNS };
