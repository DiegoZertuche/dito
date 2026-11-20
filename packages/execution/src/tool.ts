/**
 * A tool, and the gate it cannot exist without (ADR-0013 as amended
 * 2026-08-29, 2026-09-02 and 2026-09-04).
 *
 * A declaration carries one of the four values in `Gate`: three effect
 * gate shapes, or the projection a read owes. It cannot be constructed
 * without one. That is enforced twice here, because one enforcement is
 * never enough. The TYPE makes a gateless declaration fail to compile, so
 * a tool written by hand is caught by `pnpm typecheck`. `defineTool`
 * REFUSES AT RUNTIME, so a declaration assembled from JSON, from a
 * registry, or through a cast is caught the moment it is built rather than
 * the moment it is called.
 *
 * The gate lives on the TOOL, never on the execution's tool list: an
 * execution may be steered by customer text with no human in the room, so
 * a safety property that lived in the list would be one prompt injection
 * away from gone.
 */

/**
 * The four declared values — three gate shapes for an effect, and what a
 * read owes instead (ADR-0013's three amendments, verbatim).
 *
 * THREE SHAPES GATE AN EFFECT. `approve-before` for external or
 * irreversible effects (the tap). `disclosed-and-undoable-after` for
 * Ledger writes (the correction window). `rep-evidenced` for twin-side
 * state a rep may change, where there is no window to be the gate: the
 * tool works only when it can cite the rep's own message, verified by code
 * against the execution's trigger, so "a customer-triggered execution has
 * no such message and structurally cannot call the tool, whatever its
 * model was talked into".
 *
 * `projection` is not a fourth gate shape and is not a weaker one: it is
 * what a tool with no effect owes INSTEAD, and the amendment says why a
 * read owes anything at all — "a wall leak through a read is a projection
 * leak, not an effect".
 */
export type Gate =
  | "approve-before"
  | "disclosed-and-undoable-after"
  | "rep-evidenced"
  | "projection";

/** The four, as a value, so a runtime refusal can name them. */
export const GATES: readonly Gate[] = [
  "approve-before",
  "disclosed-and-undoable-after",
  "rep-evidenced",
  "projection",
];

/**
 * A tool's input schema as this package holds it: a JSON-Schema object, the
 * shape the runner's MCP server lists to the model as it stands.
 *
 * TYPED LOOSELY ON PURPOSE. The SDK's own schema type exists to INFER the
 * handler's argument from an `as const` literal, which is right for one
 * bespoke call site and wrong for a library that must read schemas it did
 * not write: this package walks `properties` to enforce the projection
 * rule, and hands the model's arguments to a declared parser rather than
 * trusting an inferred type the wire never validates (the MCP server lists
 * the schema and checks nothing against it).
 */
export interface ToolInputSchema {
  readonly type: "object";
  readonly properties?: Readonly<Record<string, unknown>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
}

/**
 * What a READ's handler returns to the model: the string the runner puts in
 * the tool result — its rows, rendered.
 */
export type ToolResult = string | Promise<string>;

/**
 * WHAT AN EFFECT TOOL'S HANDLER RETURNS — not a string (spec #171 decision
 * 11; ADR-0037 as amended).
 *
 * A read has one audience and an effect has three, and a string could only
 * ever serve the first. The MODEL is told what happened, so it can carry on
 * or say why it could not. The RUNTIME needs to know whether an effect was
 * really performed, because `acted` is its word and not the model's: a
 * successful execution with a performed effect is `acted`, even when silent
 * (ADR-0014's 2026-09-05 amendment), and a handler that reported
 * itself in prose would let a model talk its way into the word. And the
 * owning APP needs the acknowledgement — the receipt — rendered from what
 * the tool DID rather than composed from what the model says it did.
 *
 * SO THE THREE TRAVEL TOGETHER, FROM ONE VALUE. The tool renders its own
 * receipt at the moment it knows the outcome; the runner serializes `told`
 * for the model and hands the app the outcomes it collected. There is one
 * statement of "this happened", and every reader downstream is reading it
 * rather than a second copy that could disagree.
 */
export type EffectOutcome =
  | {
      readonly performed: true;
      /** What the model reads as this call's tool result. */
      readonly told: string;
      /**
       * The acknowledgement the owning app posts, rendered by code from
       * this result. The model never writes one and cannot fake one.
       *
       * ABSENT WHERE THE EFFECT IS ITS OWN ACKNOWLEDGEMENT (ticket #175).
       * A receipt exists so the rep is told what happened in words code
       * owns — and one effect puts its whole result in front of the rep
       * already: the twin thread's `create_draft` POSTS the draft the rep
       * is about to read, so a line beside it saying a draft was written
       * would be code narrating what the rep can see. It read as mandatory
       * until this ticket only because every effect so far had a sentence
       * of its own; the app is still the one that knows its vocabulary,
       * and an app that drops a receipt it owns a sentence for is refusing
       * to say what it did.
       */
      readonly receipt?: string;
      /**
       * The word the owning app records this act by — its own vocabulary,
       * opaque here. This package holds no seam and no store, so it carries
       * the word and never reads it.
       */
      readonly act: string;
      /**
       * WHAT THE EXECUTION NOW WAITS ON, when the effect asked the rep
       * something (ticket #324): the id of the card the answer will settle.
       * The runtime settles such an execution `asked` and the owning app
       * parks on the card — the tool posts and code parks, so a model never
       * decides to pause. Only a definition that `suspends` may
       * be left waiting; any other fails.
       */
      readonly waitsOn?: string;
      /**
       * THE CARD THIS EFFECT ANSWERED IN THE REP'S NAME, when it answered one
       * (ticket #386): its post id and the word it settled with, in the owning
       * app's vocabulary. The app tells the open pages once the execution has
       * committed, never before.
       */
      readonly settles?: { readonly postId: string; readonly outcome: string };
    }
  | {
      readonly performed: false;
      /** What the model reads: why the effect did not happen. */
      readonly told: string;
      /**
       * The word the owning app records the REFUSAL by, when its vocabulary
       * has one. Absent when a refusal leaves the app nothing of its own to
       * record and the reply is the whole account of it.
       */
      readonly act?: string;
      /**
       * The rep-facing sentence code owns for this refusal, when it owns
       * one. Absent when the model is the one who relays the reason.
       */
      readonly receipt?: string;
    };

/** The fields every tool declares, whatever it gates. */
interface ToolBase {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: ToolInputSchema;
  /**
   * A CALL THAT WENT THROUGH ENDS THE TURN (ticket #401): once the tool
   * performed or returned, the model is asked nothing more — no final
   * message, and none of the SDK's own «no visible output» prompts. A
   * refused or rejected call ends nothing, so the model can answer the
   * refusal. `TurnBook.endTurn` is the hook that holds it.
   */
  readonly endsTurn?: true;
}

/** What every effect tool declares beyond its gate. */
interface EffectToolBase extends ToolBase {
  readonly run: (input: unknown) => EffectOutcome | Promise<EffectOutcome>;
}

/**
 * An effect whose gate is a human decision in time: the tap before it, or
 * the correction window after it.
 */
export interface GatedEffectToolDeclaration extends EffectToolBase {
  readonly gate: "approve-before" | "disclosed-and-undoable-after";
}

/**
 * An effect on twin-side state, gated by the rep's own message (ADR-0013's
 * 2026-09-04 amendment).
 *
 * `evidence` NAMES THE PARAMETER, and naming it is what makes the gate
 * checkable rather than remembered. The ADR requires the tool to "take the
 * id of a rep-authored twin-thread message as a required parameter and
 * verify, by code against the execution's trigger, that this message is the
 * one that created the execution" — the verification is the owning app's,
 * because it needs a seam this package must never hold, but the PARAMETER's
 * existence is a property of the declaration and is refused here.
 */
export interface RepEvidencedToolDeclaration extends EffectToolBase {
  readonly gate: "rep-evidenced";
  /** The input parameter carrying the rep's own message id. */
  readonly evidence: string;
}

/** A tool whose effect is externally visible: it carries one of the three gate shapes. */
export type EffectToolDeclaration =
  | GatedEffectToolDeclaration
  | RepEvidencedToolDeclaration;

/**
 * A read: no effect to gate, so it declares the projection instead — the
 * pinned set of columns it can return, which its caller can never widen.
 */
export interface ProjectionToolDeclaration extends ToolBase {
  readonly gate: "projection";
  /** The pinned column set this tool returns, fixed by the view and the role. */
  readonly columns: readonly string[];
  readonly run: (input: unknown) => ToolResult;
}

/**
 * Every member of the union has a gate, so a gateless declaration does
 * not typecheck. There is no separate constructed-tool type: defineTool
 * returns the same value, and defineExecution revalidates every tool,
 * including declarations assembled through a cast or without defineTool.
 */
export type ToolDeclaration = EffectToolDeclaration | ProjectionToolDeclaration;

/** A tool declaration that cannot stand — a loud refusal at construction, never a warning. */
export class ToolDeclarationError extends Error {
  override readonly name = "ToolDeclarationError";
}

/**
 * Parameter names a read may never carry, grouped by what each one widens.
 *
 * THE THREE GROUPS ARE THE ADR'S THREE WORDS — "its parameters select rows
 * … and never columns, tables or company" — plus the fourth that widens all
 * three at once: a query the caller writes. Nothing here is about SQL
 * injection; it is about who decides a read's reach. A read whose caller
 * names the columns has no pinned projection, and the model is the caller.
 *
 * NOT `from`, and the omission is deliberate. SQL's `FROM` names a table,
 * but nobody writes a tool parameter called `from` meaning "which table" —
 * they write it meaning the start of a window, which is one of the four row
 * selectors the ADR names by hand. A fence that ate `{ from, to }` would
 * refuse the obvious spelling of a legitimate read.
 *
 * MATCHED ON WORDS, NOT ON THE WHOLE STRING (Codex r1). `company`,
 * `companyId`, `company_id` and `company-id` are one word to this check and
 * four spellings to a reader — but so are `companySlug`, `tableName` and
 * `columnsToReturn`, which a whole-string comparison let straight through
 * while the acceptance criterion says every property NAMING a column, table
 * or company is refused. So a parameter is split on case and separator
 * boundaries and refused if ANY of its words is listed, with the joined
 * spelling checked too for the two-word entries (`order_by`). A substring
 * rule would be the wrong fix: it would match `col` inside `collection`,
 * even though no whole word in that parameter names a column.
 *
 * WHAT A NAME LIST CANNOT DO, said plainly rather than left implied: it
 * cannot be complete. A parameter called `proyección`, or `f`, names the
 * columns to a reader and nothing to this check, and no list closes that.
 * What this fence is FOR is the name a person writes without thinking, in a
 * diff, in this repository — and what holds whatever it misses is the other
 * two legs ADR-0013 rests the projection on: the tool runs as the surface's
 * own database role, so grant and row-level security fix what it CAN
 * return, and the pinned `columns` above fix what it DOES. A structural
 * alternative — every parameter declaring which row-selector role it plays
 * — would change the tool declaration's shape for every tool in both apps,
 * which is a decision for a spec and not for this ticket; it is recorded on
 * #128.
 *
 * The schema must also close every object it declares, and that closure is
 * enforced at the tool boundary at run time: the model can only send
 * properties the schema names, so a widening parameter has to be WRITTEN
 * into the schema by the person adding the tool, where this fence and a
 * reviewer both see it.
 */
const WIDENING_PARAMETERS: readonly {
  readonly widens: string;
  readonly names: readonly string[];
}[] = [
  {
    widens: "the columns returned",
    names: [
      "column",
      "columns",
      // Abbreviations name the same widening as columns (Codex r3).
      "col",
      "cols",
      "field",
      "fields",
      "attribute",
      "attributes",
      "attrs",
      "prop",
      "props",
      "keys",
      "select",
      "projection",
      "returns",
      "returncolumns",
      "output",
      "outputs",
    ],
  },
  {
    widens: "the table",
    names: [
      "table",
      "tables",
      "relation",
      "relations",
      "view",
      "views",
      "schema",
    ],
  },
  {
    widens: "the company",
    names: [
      "company",
      "companyid",
      "companies",
      "tenant",
      "tenantid",
      "org",
      "orgid",
      "organization",
      "organizationid",
    ],
  },
  {
    widens: "columns, tables and company at once",
    names: ["sql", "query", "where", "orderby", "groupby", "having", "join"],
  },
];

/** One spelling for names a human writes four ways. */
function normalize(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** The words in a parameter name, across camelCase, snake_case and kebab-case. */
function wordsOf(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter((word) => word !== "")
    .map((word) => word.toLowerCase());
}

/**
 * Every parameter name a schema declares, at every depth.
 *
 * A TOP-LEVEL SWEEP WOULD BE A FENCE WITH A GATE IN IT: the model fills a
 * nested object exactly as it fills a top-level one, so `{ window: {
 * properties: { sql } } }` is the same widening one level down. The walk is
 * over the raw JSON value rather than over a parsed schema type, because
 * this package reads schemas it did not write and a shape it does not
 * recognise must still be searched, not skipped.
 */
function parameterNames(node: unknown, into: string[] = []): string[] {
  if (node === null || typeof node !== "object") return into;
  if (Array.isArray(node)) {
    for (const item of node) parameterNames(item, into);
    return into;
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === "properties" && value !== null && typeof value === "object") {
      into.push(...Object.keys(value as Record<string, unknown>));
    }
    parameterNames(value, into);
  }
  return into;
}

/** Whether a node in a schema is itself an object schema. */
function isObjectSchema(node: unknown): node is ToolInputSchema {
  return (
    node !== null &&
    typeof node === "object" &&
    !Array.isArray(node) &&
    (node as { type?: unknown }).type === "object"
  );
}

/**
 * Every object schema inside one, root included, in order.
 *
 * AT EVERY DEPTH, because a closed root with an open object inside it is
 * open (Codex r2): `{ filter: { type: "object" } }` passes a root-only rule
 * and lets the model put `company`, `table` or `columns` one level down,
 * where no declared name exists for the fence to refuse.
 */
function objectSchemas(node: unknown, into: ToolInputSchema[] = []): ToolInputSchema[] {
  if (node === null || typeof node !== "object") return into;
  if (Array.isArray(node)) {
    for (const item of node) objectSchemas(item, into);
    return into;
  }
  if (isObjectSchema(node)) into.push(node);
  for (const value of Object.values(node)) objectSchemas(value, into);
  return into;
}

/**
 * What a read declaration gets wrong, as sentences — a pure function over
 * the two fields the rule reads, so it can be shown to bite against a
 * synthetic offender in the same suite (`sole-writer.test.ts`'s habit).
 */
export function projectionViolations(declaration: {
  readonly columns: readonly string[];
  readonly inputSchema: ToolInputSchema;
}): string[] {
  const found: string[] = [];
  if (declaration.columns.length === 0) {
    found.push(
      "a `projection` tool declares the column set it returns, and this one declares none",
    );
  }
  const open = objectSchemas(declaration.inputSchema).filter(
    (schema) => schema.additionalProperties !== false,
  );
  if (open.length > 0) {
    // Without this the schema fences nothing: the model may send any
    // property at all, and every name check below becomes decoration.
    found.push(
      `a \`projection\` tool's input schema sets additionalProperties: false on every object it declares, so its parameters are the ones it declares; ${open.length} here does not`,
    );
  }
  for (const parameter of parameterNames(declaration.inputSchema)) {
    const spellings = [normalize(parameter), ...wordsOf(parameter)];
    // The first group that matches, once: `companyId` matches "the company"
    // by its joined spelling and by its first word, and one parameter earns
    // one sentence.
    const group = WIDENING_PARAMETERS.find((candidate) =>
      spellings.some((spelling) => candidate.names.includes(spelling)),
    );
    if (group !== undefined) {
      found.push(`the parameter \`${parameter}\` widens ${group.widens}`);
    }
  }
  return found;
}

/**
 * What a `rep-evidenced` declaration gets wrong, as sentences — a pure
 * function over the two fields the rule reads, in `projectionViolations`'
 * own shape and for its own reason: the rule can then be shown to bite
 * against a synthetic offender in the same suite.
 *
 * A SCHEMA-SHAPE CHECK, NEVER A DATABASE READ, and that is the dependency
 * wall rather than a preference. This package holds no connection and may
 * import neither `pg` nor the seam (`dependency-wall.test.ts`), so the half
 * of ADR-0013's amendment it can enforce is the half written into the
 * declaration: that the tool ASKS for the rep's message id, and asks for it
 * in a way the model cannot omit. Whether the id that arrives IS this
 * execution's trigger is checked by the owning app, in the tool's own
 * handler, against the trigger and the seam row behind it — which is where
 * the trigger and the seam both are.
 *
 * TWO THINGS, AND THE SECOND IS WHY THE FIRST IS NOT ENOUGH. The parameter
 * must be DECLARED, or the model has no way to send it and the handler
 * would be verifying `undefined` against a trigger. And it must be
 * REQUIRED, because `inputViolations` enforces `required` at the tool
 * boundary at run time — so a declared-but-optional evidence parameter is
 * one the model may simply leave out, and a tool whose gate can be skipped
 * by omission has no gate at all.
 */
export function repEvidencedViolations(declaration: {
  readonly evidence: string;
  readonly inputSchema: ToolInputSchema;
}): string[] {
  const found: string[] = [];
  const parameter = declaration.evidence;
  if (typeof parameter !== "string" || parameter === "") {
    found.push(
      "a `rep-evidenced` tool names the parameter carrying the rep's own message id, and this one names none",
    );
    return found;
  }
  const properties: Readonly<Record<string, unknown>> =
    declaration.inputSchema.properties ?? {};
  if (!Object.hasOwn(properties, parameter)) {
    found.push(
      `its evidence parameter \`${parameter}\` is not one the schema declares, so the model has no way to send it`,
    );
  }
  if (!(declaration.inputSchema.required ?? []).includes(parameter)) {
    found.push(
      `its evidence parameter \`${parameter}\` is not in \`required\`, so the model may omit it and the gate would be skipped by omission`,
    );
  }
  return found;
}

/**
 * Refuses a declaration that cannot stand, and says which rule it broke.
 *
 * Called by `defineTool` and again by `defineExecution`: the second call is
 * the one that matters, because it is the only place a tool the type system
 * never saw can be caught before an execution runs it.
 */
export function assertToolDeclaration(declaration: ToolDeclaration): void {
  const gate: unknown = declaration.gate;
  if (typeof gate !== "string" || !GATES.includes(gate as Gate)) {
    throw new ToolDeclarationError(
      `tool "${String(declaration.name)}" declares no gate: every tool carries one of ${GATES.join(", ")} (ADR-0013)`,
    );
  }
  if (declaration.gate === "rep-evidenced") {
    const violations = repEvidencedViolations(declaration);
    if (violations.length > 0) {
      throw new ToolDeclarationError(
        `tool "${declaration.name}" is rep-evidenced and cannot cite the rep: ${violations.join("; ")} (ADR-0013 as amended — the tool works only when it can cite the rep's own message)`,
      );
    }
    return;
  }
  if (declaration.gate !== "projection") return;
  const violations = projectionViolations(declaration);
  if (violations.length > 0) {
    throw new ToolDeclarationError(
      `tool "${declaration.name}" is a read whose caller could widen it: ${violations.join("; ")} (ADR-0013 — a read owes a projection)`,
    );
  }
}

/**
 * What is wrong with one tool call's arguments, as sentences.
 *
 * `additionalProperties: false` IS ONLY A SENTENCE UNTIL SOMETHING READS IT
 * (Codex r1). The MCP server the runner serves tools from validates
 * nothing, so the flag tells the model what it may send
 * and stops nothing from arriving. The construction-time fence above rests
 * on the claim that a widening parameter has to be written into the schema
 * — this is what makes that claim true of what the handler actually
 * receives.
 *
 * AT EVERY DEPTH THE SCHEMA DECLARES AN OBJECT (Codex r2), reported by
 * dotted path, because a closed root says nothing about what may arrive
 * inside a declared `filter`.
 *
 * IT IS NOT A JSON-SCHEMA VALIDATOR AND MUST NOT BECOME ONE. Two properties
 * are checked, both of them the ones the projection fence rests on: what
 * arrives was declared, and what was declared required arrived. Types,
 * formats, enums, numeric bounds and the contents of arrays of objects are
 * told to the model and enforced nowhere here — carrying a validator for
 * them is the machinery this package exists without, and a tool's own
 * handler or a structured output's `parse` is where a shape that matters is
 * enforced.
 */
export function inputViolations(
  schema: ToolInputSchema,
  input: unknown,
  path = "",
): string[] {
  if (schema.additionalProperties !== false) return [];
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    // Non-object input supplies none of the required fields (Codex round 2).
    // Report those omissions before a handler dereferences null and turns a
    // recoverable refusal into a failed pass that leaves the rep-side event
    // pending and retries the same row. With no required fields this reports
    // nothing: it is not a general JSON-Schema type validator.
    return (schema.required ?? []).map(
      (parameter) => `\`${path}${parameter}\` is required and was not given`,
    );
  }
  const properties: Readonly<Record<string, unknown>> = schema.properties ?? {};
  const given = input as Record<string, unknown>;
  const found: string[] = [];
  for (const [parameter, value] of Object.entries(given)) {
    const declared = properties[parameter];
    if (declared === undefined) {
      found.push(`\`${path}${parameter}\` is not a parameter of this tool`);
    } else if (isObjectSchema(declared)) {
      found.push(...inputViolations(declared, value, `${path}${parameter}.`));
    }
  }
  // A REQUIRED SELECTOR THAT NEVER ARRIVED (Codex r3). A read whose
  // `entity_id` is absent is a read with no entity, and a handler that
  // treats an absent selector as "no filter" would return more rows than
  // its own schema says it can be asked for. `required` is already declared
  // for the model; this is what makes it true of what the handler receives.
  for (const parameter of schema.required ?? []) {
    if (!Object.hasOwn(given, parameter)) {
      found.push(`\`${path}${parameter}\` is required and was not given`);
    }
  }
  return found;
}

/**
 * Constructs one tool, or refuses.
 *
 * Returns the declaration it was given: the value of this call is the
 * refusal, not a transformation. Everything the runner needs to hand the
 * SDK is already on the declaration. Generic in the declaration so a read
 * comes back as a read — a caller that asks a constructed projection tool
 * for its `columns` should not have to narrow the union again.
 */
export function defineTool<T extends ToolDeclaration>(declaration: T): T {
  assertToolDeclaration(declaration);
  return declaration;
}
