/**
 * WHAT A REP-SIDE TOOL RISKS WHEN IT TOUCHES ITS EXECUTION'S CONNECTION
 * (tickets #195 and #205; ADR-0014 as amended).
 *
 * Every rep-side registry whose tools reach this execution's own connection
 * takes the savepoint from here — the twin thread's six
 * (`thread/registries.ts`) and extraction's one Postgres read
 * (`extraction/registries.ts`) — and takes the queue those savepoints run
 * inside from `@dito/execution` (`tool-queue.ts`), which is where the
 * concurrency they defend against comes from.
 *
 * WHAT A TOOL TOUCHES DECIDES WHETHER IT IS SAVEPOINTED. A statement that
 * raises inside a transaction aborts the WHOLE transaction, so a tool that
 * goes anywhere near this execution's own connection would otherwise poison
 * the record insert, the chain append and the settle that come after it —
 * and the one thing the trace most needs to hold, a run that could not act,
 * would be the one thing it could never record. A tool that reads the BUNDLE
 * — a separate SQLCipher file, through the bundle API — and nothing else
 * needs none: a failing read leaves the transaction clean, the runner records
 * the tool failure, and the execution lands `failed` with its entry beside
 * it.
 *
 * ...AND THE SCOPE MUST HAVE NOTHING NESTED INSIDE IT, which unique names
 * are not enough for: two tool calls of one response run at once on one
 * connection, and a savepoint stack cannot be shared by two writers. So the
 * whole take-run-release happens inside the run's `InTurn`, which is
 * `@dito/execution`'s queue (`tool-queue.ts`) — where that argument lives in
 * full, including why the queue is one per execution and never one per
 * module.
 */
import type {
  EffectToolDeclaration,
  InTurn,
  ProjectionToolDeclaration,
} from "@dito/execution";
import type pg from "pg";

/**
 * One tool that touches this execution's connection, wrapped so its own
 * failure cannot take the transaction with it (the owner side's
 * `savepointed`, same shape and same argument).
 *
 * The declaration is otherwise untouched — same name, description, schema,
 * gate, columns and evidence parameter — so the instructions digest is
 * exactly what it would have been. What changes is only what happens around
 * the handler's own error, which the digest never covered.
 *
 * NAMED PER TOOL, because a savepoint name is an identifier and two tools
 * releasing each other's would be a bug nothing reports. One act per message
 * bounds the effect tools; a read may run more than once, and the name makes
 * those two calls each other's business rather than another tool's. Tool
 * names are unique inside one definition (`assertDefinition`), and two
 * definitions never share a transaction, so the tool's own name is enough.
 */
export function savepointed<
  T extends EffectToolDeclaration | ProjectionToolDeclaration,
>(tool: T, client: pg.ClientBase, inTurn: InTurn): T {
  const name = `tool_${tool.name}`;
  return {
    ...tool,
    run: async (input: unknown) =>
      inTurn(async () => {
        await client.query(`SAVEPOINT ${name}`);
        try {
          const outcome = await tool.run(input);
          await client.query(`RELEASE SAVEPOINT ${name}`);
          return outcome;
        } catch (error) {
          await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
          // Rethrown, so the runner records the tool failure and the
          // execution lands `failed` — the model is told the call failed and
          // carries on, and an execution whose read or act failed must not be
          // able to report itself answered. The rollback
          // is what makes the record and the chain entry still committable.
          throw error;
        }
      }) as ReturnType<T["run"]>,
  } as T;
}
