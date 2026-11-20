/**
 * THE OWNER TWIN'S THREE READS, BOUND TO ONE TURN (ticket #130; ticket #178;
 * ticket #363).
 *
 * A function of the turn's connection and served map, called once per turn
 * — never a module-level value anything writes into: the rep runtime's tools
 * reach the twin bundle, these reach three reads through `dito_owner`, and a
 * shared mutable registry would put the first within reach of the second
 * with nothing in the way but a name.
 *
 * THE SAVEPOINT WRAPS EACH TOOL BEFORE THE DEFINITION IS STAMPED: wrapping
 * afterwards would mean spreading a definition that has already been
 * digest-stamped, which is exactly the mutation the runner's re-stamp check
 * exists to catch. Wrapped first, the declaration the digest sees is the
 * declaration the model is handed.
 */
import {
  oneAtATime,
  type InTurn,
  type ProjectionToolDeclaration,
} from "@dito/execution";
import type pg from "pg";
import {
  countFactsTool,
  readTimelineTool,
  resolveEntityTool,
  type OwnerToolOptions,
} from "./tools.js";

/** What this turn's parts are built over. */
export type OwnerTwinDeps = OwnerToolOptions;

/**
 * The three reads, in the order the instructions list them, each in its own
 * savepoint and all of them in one queue.
 *
 * ONE QUEUE PER CALL, which is one per turn and so one per connection —
 * `@dito/execution`'s `tool-queue.ts` argues why that is the only bound that
 * works.
 */
export function ownerTwinTools(deps: OwnerTwinDeps): readonly ProjectionToolDeclaration[] {
  const inTurn = oneAtATime();
  return [resolveEntityTool(deps), readTimelineTool(deps), countFactsTool(deps)].map((tool) =>
    savepointed(tool, deps.client, inTurn),
  );
}

/**
 * One tool, wrapped so a failing read cannot poison the transaction the
 * record and the chain entry have to commit in.
 *
 * The declaration is otherwise untouched — same name, description, schema,
 * gate and columns — so the instructions digest is exactly what it would
 * have been. What changes is only what happens around the handler's own
 * error, which the digest never covered.
 *
 * EACH TOOL RUNS INSIDE A SAVEPOINT, and that is not decoration. A statement
 * that raises inside a transaction aborts the WHOLE transaction — so a read
 * that failed would poison the chain append and the record insert that come
 * after it, and the one thing the failed-query log most needs to hold (a
 * turn that could not read) would be the one thing it could never record.
 * The savepoint is `refuse()`'s shape on the aperture side, for the same
 * reason.
 *
 * ...AND THE WHOLE OF IT RUNS INSIDE THIS TURN'S QUEUE, which unique names
 * are not enough for (ticket #205): an owner question whose answer needs two
 * reads runs both handlers at once on the one connection this turn's
 * transaction is open on, and a savepoint stack cannot be shared by two
 * writers — whichever releases first destroys the other's scope, and what
 * the aborted transaction then loses is the record and the entry. The queue
 * is `@dito/execution`'s (`tool-queue.ts`), which argues it in full and is
 * where the rep side takes it from too: it holds no connection, so each side
 * of the wall wraps its own savepoint around it over its own store
 * (ADR-0002).
 */
function savepointed(
  tool: ProjectionToolDeclaration,
  client: pg.ClientBase,
  inTurn: InTurn,
): ProjectionToolDeclaration {
  const name = `owner_tool_${tool.name}`;
  return {
    ...tool,
    run: async (input: unknown) =>
      inTurn(async () => {
        await client.query(`SAVEPOINT ${name}`);
        try {
          const result = await tool.run(input);
          await client.query(`RELEASE SAVEPOINT ${name}`);
          return result;
        } catch (error) {
          await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
          // Rethrown, so the runner records the tool failure and the
          // execution lands `failed` — the model is told the call failed and
          // carries on, and an execution whose read failed must not be able
          // to report itself answered.
          throw error;
        }
      }),
  };
}
