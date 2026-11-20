/**
 * ONE RUN'S TOOL CALLS TAKE THEIR TURN (ADR-0014 as amended; ticket #205).
 *
 * A model can ask for several tools in ONE response, and whether the
 * harness runs them one after another or together is the harness's choice:
 * the Claude Code child runs our unannotated MCP tools in sequence today,
 * and nothing in its contract keeps it that way. Two handlers in flight at
 * once would both reach the one connection their execution's transaction is
 * open on.
 * Postgres savepoints are a STACK: `SAVEPOINT a`, `SAVEPOINT b`,
 * `RELEASE a` destroys b too, and b's own RELEASE — or its recovery
 * ROLLBACK — then raises inside an already-broken transaction. The
 * execution's chain append raises after that, before `ExecutionError` is
 * ever constructed, so the owning app's failure recovery never runs and a
 * run that was paid for leaves NO record of itself, which is the one
 * ending ADR-0014 as amended has no word for.
 *
 * THE QUEUE IS HERE BECAUSE THE CONCURRENCY IS. `runner.ts` is what serves
 * an execution's tools to the model, so how those tools run is this
 * package's own fact — and the queue is pure, which is what lets each side
 * of the wall wrap its own savepoint around it over its own store, with no
 * driver and no credential reaching this package (ADR-0002).
 *
 * ONE PER RUN, AND NEVER ONE PER MODULE. Two executions really do run at
 * once, on two connections, and must not wait on each other; two tool
 * calls of ONE response share a connection and must.
 */

/** What `oneAtATime` hands back: a queue of one, for one run. */
export type InTurn = <R>(run: () => Promise<R>) => Promise<R>;

/**
 * A queue of one: whatever is handed to it runs after everything handed to
 * it before, whether that ended well or badly.
 *
 * IT IS ABOUT A CONNECTION AND NOT ABOUT AN ACT. A registry that bounds
 * what one turn may DO to a single act bounds acts, not statements; this
 * bounds what may be in flight on one connection to one thing, which is a
 * different claim and the one savepoints need — a stack cannot be shared
 * by two writers, however few effects they are allowed between them.
 */
export function oneAtATime(): InTurn {
  let tail: Promise<unknown> = Promise.resolve();
  return <R>(run: () => Promise<R>): Promise<R> => {
    const next = tail.then(run, run);
    // SETTLED EITHER WAY, so one handler's throw does not wedge the queue
    // behind it: the failure belongs to its own caller, and the next tool
    // still gets its turn.
    tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };
}
