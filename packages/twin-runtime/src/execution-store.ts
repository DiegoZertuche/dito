/**
 * THE REP SIDE'S EXECUTION RECORD AND ITS CHAIN (ticket #172; spec #171
 * decision 12; ADR-0014 as amended, ADR-0020).
 *
 * `@dito/execution` defines two seams and implements neither: an
 * `ExecutionStore` for the record and an `ExecutionAuditChain` for the one
 * content-free entry every execution owes. The owner app implements both
 * over `owner.executions` and `owner.audit_chain` under its own key
 * (`@dito/owner-twin`'s `store.ts`); this is the rep side's pair, over
 * `public.executions` and `public.audit_chain` under `DITO_AUDIT_HMAC_KEY`.
 *
 * WHICH CHAIN AN EXECUTION APPENDS TO IS THE APP'S DECISION, never the
 * runtime's — the sentence `ownerExecutionChain` already writes down, seen
 * from the other side. The runtime takes an injected chain and holds no
 * credential, so it never learns there are two.
 *
 * BOTH REQUIRE AN OPEN TRANSACTION, and the requirement is not this
 * module's: `appendAuditEntry` refuses autocommit outright (its tail lock
 * would not survive to its tail read, and concurrent appenders would fork a
 * chain that can never be repaired), and the record has to commit with the
 * entry or ADR-0020's pair is two independent writes. `withDbTransaction`
 * (`db-tx.ts`) is what the consumer opens: a plain `BEGIN`, which is READ
 * COMMITTED, which is what the tail read needs — the owner side's
 * `TURN_TRANSACTION` argues that in eleven lines and the argument is the
 * same one here. Under REPEATABLE READ the whole transaction reads the
 * snapshot its FIRST statement took, and this transaction's first statement
 * runs before the model does, so an entry anybody else committed while the
 * model was thinking would be invisible to the tail read and the turn would
 * append a second link from the old tail.
 *
 * NEITHER HOLDS A CREDENTIAL OR A CLOCK. The client and the key are the
 * caller's, the ids are minted by the caller, and every instant on the
 * record was measured by the runner.
 */
import { appendAuditEntry, type AuditEntry } from "@dito/audit";
import {
  triggerRef,
  type ExecutionAuditChain,
  type ExecutionRecord,
  type ExecutionStore,
} from "@dito/execution";
import type pg from "pg";

/**
 * Where a rep-side execution's record goes.
 *
 * IT IMPLEMENTS `ExecutionStore` AND NOTHING WIDER, for the reason the
 * owner's does: that interface has one method because one execution needs
 * one, and reads of this table — a boundary session's latency and token
 * numbers (spec #171 user story 27), the coverage join — are queries, not
 * methods on a writer.
 *
 * THE ID IS MINTED BEFORE THE RUN, not returned by the INSERT. `notices` and
 * `draft_timings` name the execution that produced them, and both are
 * written in the same transaction as the record — so the id has to exist
 * before any of the three statements run. The owner side mints its two ids
 * the same way and for the same reason.
 */
export class TwinExecutionStore implements ExecutionStore {
  readonly #client: pg.ClientBase;
  readonly #twinId: string;
  readonly #executionId: string;

  constructor(options: {
    readonly client: pg.ClientBase;
    readonly twinId: string;
    readonly executionId: string;
  }) {
    this.#client = options.client;
    this.#twinId = options.twinId;
    this.#executionId = options.executionId;
  }

  /** One execution, recorded — a `failed` one included, which is the trace of a turn that got nowhere. */
  async recordExecution(record: ExecutionRecord): Promise<void> {
    await this.#client.query(
      `INSERT INTO executions
         (id, twin_id, trigger_kind, trigger_mechanism, trigger_ref,
          instructions_digest, tool_names, lane, started_at, ended_at,
          iterations, tokens_input, tokens_output, disposition)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        this.#executionId,
        this.#twinId,
        // EVERY VALUE OFF THE RECORD, never a literal here (the rule
        // `OwnerTwinStore` states for the lane and which holds for all of
        // them): the occasion, the mechanism and the lane are the
        // automation's declarations, checked against its wake by
        // `runExecution` before the model ran, and a word written into this
        // INSERT would be a second place any of them is decided.
        record.trigger.kind,
        record.trigger.mechanism,
        // THE SAME FUNCTION THE CHAIN ENTRY USED. `executionAuditEntry`
        // renders `triggerRef(trigger) + " instructions:" + digest`, so
        // taking the reference from anywhere else — a field the caller
        // passed, a second rendering — would let the row and the
        // append-only entry describe different runs. One renderer, two
        // readers.
        triggerRef(record.trigger),
        record.instructionsDigest,
        [...record.toolNames],
        record.lane,
        record.startedAt,
        record.endedAt,
        record.iterations,
        record.tokens.input,
        record.tokens.output,
        record.disposition,
      ],
    );
  }
}

/**
 * Where a rep-side execution's one audit entry goes: `public.audit_chain`,
 * under the rep key.
 *
 * THE FIRST CODE THAT WRITES AN `execution` ACT ON THE REP CHAIN (spec #171
 * decision 12). The action word has been in `AUDIT_ACTIONS` since #130 and
 * the owner twin was its only writer; audit coverage's `rep_execution` class
 * is what makes it required on this side from this slice.
 *
 * THE ENTRY TRAVELS UNCHANGED, and that is the whole of what this function
 * is. `executionAuditEntry` in `@dito/execution` builds it — caller
 * `execution`, action `execution`, the trigger's reference plus the
 * instructions digest, the disposition as the outcome — and an adapter that
 * rewrote any of those four fields would make the coverage class's caller
 * declaration a lie ("an entry under this action naming any other caller is
 * itself the finding", `audit.ts`).
 *
 * NO TWIN ID PARAMETER, and the asymmetry with the owner side is the
 * argument. `appendOwnerAuditEntry` takes a company because the owner chain
 * is ONE CHAIN PER COMPANY inside one table: the company keys its advisory
 * lock and filters its tail read, so without it two companies would chain
 * onto each other's tails. The rep chain is a single sequence with one
 * global tail lock and no tenant column, and the twin is already in the
 * reference `triggerRef` renders — so a twin id here would be a value this
 * adapter could only ignore or re-assert.
 */
export function twinExecutionChain(
  client: pg.ClientBase,
  hmacKey: Uint8Array,
): ExecutionAuditChain {
  return {
    append: async (entry: AuditEntry) => {
      await appendAuditEntry(client, hmacKey, entry);
    },
  };
}
