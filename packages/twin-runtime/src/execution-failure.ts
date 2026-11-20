/**
 * THE CLASS PREDICATE: which failures are outcomes and which are broken rigs
 * (ticket #240; ADR-0042).
 *
 * ADR-0042 titles the rule for the plane — «fail-stop is for infrastructure,
 * never for content» — and this is the runtime's reading of it. The loop's
 * fail-stop exists for a seam this runtime cannot read: a broken rig, never
 * something to spin past (`runtime.ts`). It is not for a model that will not
 * finish, and the difference has teeth: an execution failure that reached the
 * loop killed the runtime on the rig, and because a failed run wrote no
 * marker the rows that caused it were still pending for the next start to die
 * on. THIS IS THE HOME for that argument; the sites that catch quote one line
 * and point here.
 */
import { ExecutionError } from "@dito/execution";

/**
 * Whether this thrown value is an execution's own ENDING rather than a fault
 * underneath it.
 *
 * `ExecutionError` IS THE WHOLE OF THE TEST, because the runner has already
 * made the judgement this reads. It raises that type for exactly the endings
 * that are about what the execution was handed or what the model did — a model
 * call the wire rejected, a tool handler that threw on its arguments, a
 * response the provider truncated, a turn cap that stopped the model, words or
 * a structured output its definition's rule refuses — and for nothing else. It raises it fail-closed: the
 * record rides on the error and this execution's one content-free chain entry
 * is appended before the throw, so the ending is RECORDABLE, which is what
 * makes it an outcome rather than a loss.
 *
 * EVERYTHING ELSE IS FAIL-STOP, and it is the same list in every direction:
 * the seam refusing a write, a connection the pool cannot hand out, the bundle
 * unopenable, KMS unreachable, a DEK that will not unwrap. None of them leaves
 * a record to write or an entry to join, so «recorded and left behind» is not
 * available for them — the honest reading of a transaction that is gone is
 * that nothing happened, and the loop stops rather than carry on writing over
 * a store it cannot trust.
 *
 * A PROGRAMMING ERROR OUTSIDE THE RUNNER IS FAIL-STOP, which is why this is a
 * type test rather than a catch-all. A `TypeError` from a renderer, an
 * invariant this package throws at itself — «the accepted answer cites
 * reference N, which this run's search never served» — and a guard and a
 * writer disagreeing all leave the model loop untouched and arrive here as
 * themselves. Loud and once is the right blast radius for a bug.
 *
 * ═══ THE BLIND SPOT, AND IT IS A HAZARD (Codex r1 on ticket #240) ═══
 *
 * A THROW FROM INSIDE A TOOL HANDLER READS AS CONTENT HERE, whatever caused
 * it. The model is handed a handler's exception as an error result and the
 * loop carries on, so the runner's own wrapper records it — as a STRING,
 * `toolFailure` — before the model is told; the ending then lands `failed`
 * and the thrown value is gone. `savepointed` (`tool-savepoints.ts`) rolls the tool's writes back
 * first, which is what leaves the transaction able to commit the record and
 * the entry. So a tool that throws because the model handed it nonsense, a
 * tool with a bug in it, and a tool whose Postgres statement or embedder was
 * refused are ONE value by the time they reach this predicate — and the two
 * that are not content are consumed as though they were, leaving the rep's
 * message spent and the runtime carrying on over a broken dependency.
 *
 * IT IS NOT CLOSED HERE, and the reason is where the fix has to go: the class
 * of a tool's failure is knowable only where the tool threw, so the runner's
 * failure ladder is what has to carry the cause forward (it already attaches
 * one for a wire failure and not for this). That is a change to
 * `@dito/execution`, whose other consumer is the owner twin across the wall,
 * so it is not a `catch` in this package. Recorded on #240.
 *
 * THREE OTHER SITES MAKE THE SAME TYPE TEST FOR A DIFFERENT QUESTION, and
 * naming them is what stops a reader taking this for the only one.
 * `classifyBinding` (`entity-kind/classify.ts`) turns a refusal into a VALUE
 * because its three callers answer it differently. Extraction and the
 * disclosure (`extraction-pass.ts`, `disclosure.ts`; spec #193 decision 10)
 * catch BOTH classes — nothing may leave the batch lane at all — so the
 * distinction there decides only WHERE the recovery happens: inside the
 * transaction, where the record and the entry can still commit, or outside it,
 * where the only thing left is to settle the run. This predicate is the
 * realtime lane's, where the distinction decides whether the process lives.
 */
export function isExecutionFailure(
  thrown: unknown,
): thrown is ExecutionError {
  return thrown instanceof ExecutionError;
}
