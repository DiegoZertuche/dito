/**
 * The owner app's own state, written as `dito_owner` (ticket #130; spec
 * #126 decisions 3, 5(e) and 5(f); #128's handoff).
 *
 * FOUR TABLES IN THE OWNER'S OWN SCHEMA (ticket #165 added the fourth), and
 * nothing in any of them is Ledger data — the question is the owner's own
 * words, the record is trigger ids and numbers, the answer is what the twin
 * gave, and the chain is the content-free record that the execution ran.
 * Row-level security keyed to the connection's declared company is on all
 * four, forced, so the tenant is never a parameter here either: every
 * statement below relies on the same `declared_company()` function the
 * Ledger's own policies read, and a connection that declared no company reads
 * and writes nothing.
 *
 * THE RECORD, THE ANSWER AND THE CHAIN ENTRY COMMIT TOGETHER. #128's
 * handoff, in its own words: "call it in one transaction with the chain
 * append, so a record and its audit entry never exist without each other".
 * The transaction is opened by `runOwnerTwinTurn`; this module only ever
 * writes inside one.
 *
 * IDS ARE MINTED BEFORE THE RUN, not returned by the INSERT. The trigger
 * has to name the question before the execution exists, and the answer has
 * to name the execution — so both ids are minted by the caller and handed
 * in, and every write below is a plain INSERT whose failure means what it
 * says.
 */
import { appendOwnerAuditEntry, type AuditEntry } from "@dito/audit";
import type { ExecutionAuditChain, ExecutionRecord, ExecutionStore } from "@dito/execution";
import type pg from "pg";
import type { OwnerTurn } from "./definition.js";
import { persistedReference, type PersistedReference, type ServedRows } from "./served.js";
import {
  OWNER_ANSWER_KINDS,
  type OwnerAnswer,
  type OwnerAnswerKind,
} from "./answer.js";

/**
 * How many earlier turns one execution is shown.
 *
 * A CAP RATHER THAN THE WHOLE CONVERSATION, because context is handed in
 * whole every turn (ADR-0014 as amended) and an owner who has asked two
 * hundred questions would otherwise pay for all of them on the two hundred
 * and first. Twenty is the recent conversation, which is what a follow-up
 * needs; it is not memory, and nothing here pretends it is.
 */
export const OWNER_TWIN_HISTORY_TURNS = 20;

/** What one reference was to the answer that cited it. */
export type ReferenceRole = "cited" | "candidate" | "timeline" | "count";

/** One reference as `owner.answers.refs` keeps it: the row's id, and its roles. */
export type StoredReference = PersistedReference & {
  readonly roles: readonly ReferenceRole[];
};

/** The owner's question, recorded before the execution that answers it. */
export async function recordOwnerQuestion(
  client: pg.ClientBase,
  options: {
    readonly id: string;
    readonly companyId: string;
    readonly text: string;
    readonly askedAt?: Date;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO owner.questions (id, company_id, asked_at, text)
     VALUES ($1, $2, coalesce($3, now()), $4)`,
    [options.id, options.companyId, options.askedAt ?? null, options.text],
  );
}

/**
 * This owner's earlier turns, oldest first — the context one execution is
 * shown (spec #126 decision 5, "multi-turn").
 *
 * FETCHED FRESH EVERY TURN, which is what makes "context never spans two
 * executions" true by construction: there is no session to resume, only
 * rows read again. The company is the connection's, through the policy.
 *
 * THE MOST RECENT N, PRESENTED OLDEST FIRST. Reading the oldest twenty of a
 * long conversation would hand the model the beginning and hide the part
 * the follow-up is about.
 */
export async function readOwnerTurns(
  client: pg.ClientBase,
  options: { readonly limit?: number } = {},
): Promise<OwnerConversation> {
  const res = await client.query<{
    id: string;
    asked_at: Date | string;
    text: string;
    kind: string | null;
    prose: string | null;
  }>(
    `SELECT q.id, q.asked_at, q.text, a.kind, a.prose
       FROM (SELECT * FROM owner.questions
              ORDER BY asked_at DESC, id DESC
              LIMIT $1) q
       LEFT JOIN owner.answers a ON a.owner_question_id = q.id
      ORDER BY q.asked_at, q.id`,
    [options.limit ?? OWNER_TWIN_HISTORY_TURNS],
  );
  const total = await client.query<{ n: string }>(
    "SELECT count(*) AS n FROM owner.questions",
  );
  return {
    turns: res.rows.map((row) => ({
      questionId: row.id,
      askedAt: new Date(row.asked_at),
      question: row.text,
      answer:
        row.kind === null || row.prose === null
          ? null
          : { kind: asAnswerKind(row.kind), prose: row.prose },
    })),
    turnsInAll: Number(total.rows[0]!.n),
  };
}

/**
 * The recent turns, and how many there are in all.
 *
 * THE TOTAL TRAVELS WITH THEM because the cap must not be silent: a model
 * shown the last twenty of two hundred turns and not told is a model that
 * will answer about the first one (the two-axis review's Spec axis).
 */
export interface OwnerConversation {
  readonly turns: readonly OwnerTurn[];
  readonly turnsInAll: number;
}

/**
 * The store one turn writes through: the execution record `@dito/execution`
 * defines, and the answer that is this app's own.
 *
 * IT IMPLEMENTS `ExecutionStore` AND NOTHING WIDER. That interface has one
 * method because one execution needs one; reads and the failed-query query
 * are this app's business, which is why they are free functions above
 * rather than methods here.
 */
export class OwnerTwinStore implements ExecutionStore {
  readonly #client: pg.ClientBase;
  readonly #companyId: string;
  readonly #questionId: string;
  readonly #executionId: string;

  constructor(options: {
    readonly client: pg.ClientBase;
    readonly companyId: string;
    readonly questionId: string;
    readonly executionId: string;
  }) {
    this.#client = options.client;
    this.#companyId = options.companyId;
    this.#questionId = options.questionId;
    this.#executionId = options.executionId;
  }

  /** One execution, recorded — including a failed one, which is FR-48's log. */
  async recordExecution(record: ExecutionRecord): Promise<void> {
    await this.#client.query(
      `INSERT INTO owner.executions
         (id, owner_question_id, company_id, trigger_kind, instructions_digest,
          tool_names, started_at, ended_at, iterations, tokens_input,
          tokens_output, disposition, lane)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        this.#executionId,
        this.#questionId,
        this.#companyId,
        record.trigger.kind,
        record.instructionsDigest,
        [...record.toolNames],
        record.startedAt,
        record.endedAt,
        record.iterations,
        record.tokens.input,
        record.tokens.output,
        record.disposition,
        // OFF THE RECORD, never a literal here (ticket #178). The lane is
        // the automation's declaration, and a `'realtime'` written into this
        // INSERT would be a second place it is decided — which is the whole
        // reason it rides on the record at all.
        record.lane,
      ],
    );
  }

  /**
   * The typed answer, as given, with every reference resolved to
   * the row's own id.
   *
   * WRITTEN ONLY WHEN THERE IS ONE. A failed execution produced no
   * answer, so it leaves an execution row and no answer row — which is
   * exactly what makes the failed-query log readable as a left join.
   */
  async recordAnswer(
    answer: OwnerAnswer,
    served: ServedRows,
  ): Promise<void> {
    await this.#client.query(
      `INSERT INTO owner.answers
         (execution_id, owner_question_id, company_id, kind, prose, follow_up, refs)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
      [
        this.#executionId,
        this.#questionId,
        this.#companyId,
        answer.kind,
        answer.prose,
        answer.kind === "refusal" ? answer.followUp : null,
        JSON.stringify(storedReferences(answer, served)),
      ],
    );
  }
}

/**
 * Every reference an answer cited, once each, carrying what it was to that
 * answer.
 *
 * THE UNION RATHER THAN THE `references` LIST ALONE. An ask's candidates and
 * a refusal's timeline pointer are references too — the room renders them as
 * pills — and a stored answer that kept only the receipt's references would
 * re-render with its pills gone.
 */
export function storedReferences(
  answer: OwnerAnswer,
  served: ServedRows,
): readonly StoredReference[] {
  const roles = new Map<number, Set<ReferenceRole>>();
  const note = (ref: number, role: ReferenceRole): void => {
    const already = roles.get(ref);
    if (already === undefined) roles.set(ref, new Set([role]));
    else already.add(role);
  };
  for (const ref of answer.references) note(ref, "cited");
  if (answer.kind === "ask") {
    for (const ref of answer.candidates) note(ref, "candidate");
  }
  if (answer.kind === "refusal" && answer.timelineRef !== undefined) {
    note(answer.timelineRef, "timeline");
  }
  if (answer.kind === "answer" && answer.countRef !== undefined) {
    note(answer.countRef, "count");
  }
  return [...roles.entries()].map(([ref, kinds]) => ({
    // The guard refused every unserved reference before this could run, so
    // there is a row behind each one.
    ...persistedReference(served.get(ref)!),
    roles: [...kinds],
  }));
}

/**
 * Where an execution's audit entry goes on the owner side.
 *
 * THE OWNER'S OWN CHAIN, ONE PER COMPANY (ticket #165; the decision on #157;
 * ADR-0020 as amended 2026-09-03) — `owner.audit_chain`, under
 * `DITO_OWNER_AUDIT_HMAC_KEY`, stamped with the company this connection
 * declared. It used to be `public.audit_chain` under the rep side's key, and
 * that grant is revoked: the shared chain is a same-company rep-activity
 * record, and the owner side may read only what it wrote. `dito_owner` now
 * holds nothing at all on any `public` table (pinned in `grants.ts`).
 *
 * THE SAME CONNECTION AND THE SAME TRANSACTION AS THE RECORD, which is what
 * `appendOwnerAuditEntry` requires and what makes "a record and its entry
 * never exist without each other" true rather than intended.
 *
 * WHICH CHAIN AN EXECUTION APPENDS TO IS THIS APP'S DECISION, never the
 * runtime's (#157's consequences; ADR-0014 as amended). `@dito/execution`
 * takes an injected `ExecutionAuditChain` and holds no credential, so slice
 * 5's rep-side executions reach the rep chain through the same seam with a
 * different implementation behind it — and the runtime never learns there
 * are two.
 */
export function ownerExecutionChain(
  client: pg.ClientBase,
  hmacKey: Uint8Array,
  companyId: string,
): ExecutionAuditChain {
  return {
    append: async (entry: AuditEntry) => {
      await appendOwnerAuditEntry(client, hmacKey, companyId, entry);
    },
  };
}

/**
 * A kind read back out of the store, checked against this build's four.
 *
 * EXPORTED SO THE SCROLL USES THE SAME CHECK (#131). `history.ts` rebuilds a
 * stored answer into the answer it was, and a `switch` over a word cast
 * to the union is the one shape that would return `undefined` for a kind
 * this build does not know instead of saying so.
 */
export function asAnswerKind(word: string): OwnerAnswerKind {
  if ((OWNER_ANSWER_KINDS as readonly string[]).includes(word)) {
    return word as OwnerAnswerKind;
  }
  // The column's CHECK holds the same four, so this is a build reading a
  // database ahead of it. Loud, because a kind nobody knows is a turn the
  // room cannot draw.
  throw new Error(
    `owner.answers holds kind ${JSON.stringify(word)}, which this build does not know (${OWNER_ANSWER_KINDS.join(", ")})`,
  );
}
