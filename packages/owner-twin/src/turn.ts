/**
 * ONE OWNER TURN, END TO END (ticket #130; spec #126 decisions 5, 16, 17 and
 * 18).
 *
 * This is the function the room (#131) calls. It opens one transaction on
 * the connection the app authenticated as `dito_owner`, and inside it: reads
 * the turns before this one, records the question, runs the execution with
 * the three projection tools bound to that connection, and persists the
 * execution record, the typed answer and the one audit-chain entry —
 * together or not at all.
 *
 * WHY EVERYTHING IS IN ONE TRANSACTION. #128's runner appends the chain
 * entry before it returns or throws, fail-closed: "a record with no entry is
 * exactly the hole ADR-0020's coverage check exists to find", and the
 * remaining gap — an entry with no record — is closed here, by the rule
 * `chainApertureAct` already states for the aperture. The act and its audit
 * link commit together.
 *
 * A FAILED EXECUTION IS PERSISTED, NOT SWALLOWED. `ExecutionError` carries
 * its record; it is written, the transaction commits, and the caller is
 * handed a turn whose disposition is `failed` and whose rendered turn is
 * null. That is FR-48's failed-query log (spec #126 decision 2: "written as
 * an execution disposition and has no surface"). A turn whose every answer
 * the structural guard refused is the same kind of record under
 * `schema-miss`, and the owner is handed no turn to draw (`answer.ts`).
 *
 * EACH TOOL RUNS INSIDE A SAVEPOINT, and that is not decoration either — a
 * statement that raises inside a transaction aborts the WHOLE transaction,
 * so a read that failed would poison the chain append and the record insert
 * that come after it. The wrapper moved to `registries.ts` at #178, where
 * the tool factories are: the registry is the only door a tool reaches an
 * execution through, and wrapping after construction would mean spreading a
 * definition the runner has already digest-stamped.
 */
import { randomUUID } from "node:crypto";
import { readOwnerEntitiesByIds } from "@dito/aperture";
import {
  ExecutionError,
  runExecution,
  type Disposition,
  type ExecutionRecord,
  type OwnerQuestionTrigger,
  type Harness,
} from "@dito/execution";
import type pg from "pg";
import { OWNER_TWIN_WAKE } from "./automation.js";
import { ownerTwinExecution } from "./definition.js";
import { renderOwnerTurn, type RenderedOwnerTurn } from "./render.js";
import { ServedRows } from "./served.js";
import {
  OwnerTwinStore,
  ownerExecutionChain,
  readOwnerTurns,
  recordOwnerQuestion,
} from "./store.js";

/** What one turn leaves behind, whichever way it ended. */
export interface OwnerTwinTurnOutcome {
  readonly questionId: string;
  readonly executionId: string;
  readonly disposition: Disposition;
  /** The record, as persisted. */
  readonly record: ExecutionRecord;
  /** What the room draws — null exactly when the execution failed. */
  readonly turn: RenderedOwnerTurn | null;
  /** ...and why, in that case: the sentence the failed-query log carries. */
  readonly failure: string | null;
}

/**
 * Runs one owner question to a rendered turn.
 *
 * The connection is the caller's — already logged in as `dito_owner`, with
 * its company declared. The app's `withOwnerConnection` is what guarantees
 * both, and this function neither opens a connection nor knows a credential
 * (ADR-0002).
 */
export async function runOwnerTwinTurn(options: {
  readonly harness: Harness;
  readonly client: pg.ClientBase;
  readonly hmacKey: Uint8Array;
  readonly companyId: string;
  readonly question: string;
  readonly timeZone: string;
  /** The ADR-0015 rung, named by the deployment. No default here. */
  readonly model: string;
  /** The instant the owner asked; the row's default is now. */
  readonly askedAt?: Date;
  /**
   * The record the owner PICKED out of the last turn's ask (ticket #131;
   * ADR-0039).
   *
   * WHY THE CHOICE IS AN ID AND NOT THE NAME THEY TAPPED. Resolution folds
   * the whole name, so a name that matched two records matches the same two
   * next turn: an owner who answers «Aceros Ríos» in prose — or taps a pill
   * that only posted its words — meets the identical ambiguity and the
   * identical refusal, and the twin asks again forever. The pill posts the
   * record, so the turn after an ask resolves what the owner picked rather
   * than what they typed.
   *
   * IT IS SERVED, NOT TRUSTED. The id is read back through the owner's own
   * views on this connection before anything is done with it, so a value
   * that names no cliente of this company simply serves no row — and the
   * turn runs as though the owner had typed the name, which is what an
   * unrecognised choice honestly is.
   */
  readonly chosenEntityId?: string;
}): Promise<OwnerTwinTurnOutcome> {
  const { harness, client, hmacKey, companyId, question, timeZone, model } =
    options;
  const questionId = randomUUID();
  const executionId = randomUUID();
  // ONE INSTANT FOR THE WHOLE TURN (ticket #178). It was read twice — once
  // for the row's `asked_at` default and once for the tools' lag boundary —
  // and the `now` part makes a third reader. A turn whose three answers to
  // "when is it" could differ is a turn that can tell the model one day and
  // refuse it against another. The app hands it in (`askOwnerTwin`); the
  // fallback stays for a caller that names none.
  const askedAt = options.askedAt ?? new Date();

  // READ COMMITTED, AND THE REASON IS THE AUDIT CHAIN (#131, Codex r3).
  //
  // This transaction used to open at REPEATABLE READ so every read in a turn
  // saw one database (#130's own Codex r3). The room is what made that
  // unsafe, and it is worth writing down exactly why rather than leaving the
  // level to look like a preference.
  //
  // `appendAuditEntry` serializes appenders on ONE advisory lock and then
  // READS THE TAIL — and that design assumes the read after the lock sees
  // the latest committed row, which is true only under READ COMMITTED, where
  // each statement takes its own snapshot. Under REPEATABLE READ the whole
  // transaction reads the snapshot taken by its FIRST statement, and this
  // turn's first statement runs before the model does. So an entry committed
  // by anybody else while the model was thinking — a rep confirming a
  // binding, an answered question, a correction, a merge, all ordinary — is
  // invisible to the tail read, and the turn appends a second link from the
  // OLD tail. Nothing refuses it: the chain has no uniqueness constraint that
  // could, the store is append-only, and a fork can never be repaired
  // (ADR-0020). `runOwnerTwinTurn` was the only transaction in this repo
  // above READ COMMITTED, and every other appender has always used this one.
  //
  // WHAT IS GIVEN UP, so the next reader does not rediscover it as a bug: two
  // identical `count_facts` calls in one turn can now straddle a finalization
  // pass. The NUMBER is unaffected — the served map keys a count by its
  // descriptor and serves one row per identical count, so what renders is the
  // first read either way — and what remains is the narrow case where the
  // second call would have told the model "found something" over a first
  // count of zero. A turn slightly stale about its own zero-ness is a
  // recoverable answer; a forked chain is not.
  await client.query(TURN_TRANSACTION);
  try {
    // BEFORE THE QUESTION IS RECORDED, so "the turns before this one" needs
    // no clause excluding the turn being asked.
    const conversation = await readOwnerTurns(client);
    await recordOwnerQuestion(client, {
      id: questionId,
      companyId,
      text: question,
      askedAt,
    });

    const served = new ServedRows();
    // THE OWNER'S PICK, SERVED BEFORE THE MODEL RUNS. It is a row this
    // company's own views returned, under a reference like any other — so
    // the timeline read reaches it the way it reaches anything else, and the
    // ask that produced it is not asked again. It carries NO ambiguity mark:
    // a record the owner chose is not one of several any more, which is the
    // whole of what their answer settled (ADR-0039).
    const chosen = await chosenRecord(client, served, options.chosenEntityId);
    // THE LATEST ANSWER'S REFUSAL, when it had one: the failed-query log's
    // sentence for a turn that ended without an accepted answer.
    let refused: string | undefined;
    const definition = ownerTwinExecution({
      // WHAT THE OCCASION BINDS (ticket #178). The connection, this run's
      // served map, the owner's zone and the turn's one instant — which the
      // `now_owner` recipe renders and the reads measure the FR-69 boundary
      // from, so the model is told the same day it would be refused against.
      deps: { client, served, timeZone, askedAt },
      question: chosen === null ? question : questionWithChoice(question, chosen),
      earlierTurns: conversation.turns,
      turnsInAll: conversation.turnsInAll,
      model,
      read: (refusal) => {
        refused = refusal;
      },
    });
    // THE OCCASION AND THE MECHANISM COME OFF THE WAKE (ticket #178, Codex
    // r2), not restated here: `OWNER_TWIN_WAKE` declares both, `runExecution`
    // refuses a trigger that disagrees, and this is where the ids the
    // occasion binds are added to them.
    const wake = OWNER_TWIN_WAKE;
    const trigger: OwnerQuestionTrigger = {
      kind: wake.occasion,
      mechanism: wake.mechanism,
      companyId,
      ownerQuestionId: questionId,
    };
    const store = new OwnerTwinStore({
      client,
      companyId,
      questionId,
      executionId,
    });
    const chain = ownerExecutionChain(client, hmacKey, companyId);

    try {
      const { submission: answer, record } = await runExecution({
        harness,
        trigger,
        definition,
        chain,
      });
      await store.recordExecution(record);
      // AN ANSWER THE RUNTIME COULD NOT READ leaves the record and no answer
      // row: `schema-miss` with nothing to render, which the room shows as a
      // turn that did not come out.
      if (answer === undefined) {
        await client.query("COMMIT");
        return {
          questionId,
          executionId,
          disposition: record.disposition,
          record,
          turn: null,
          failure: refused ?? UNREAD_ANSWER,
        };
      }
      await store.recordAnswer(answer, served);
      await client.query("COMMIT");
      // RENDERED AFTER THE COMMIT, AND THAT IS THE WHOLE OF THE REASON
      // (Codex r1). It used to render inside the transaction, on the
      // argument that a turn which cannot be rendered was not stored
      // either — which had it backwards. `renderOwnerTurn` throws only on a
      // reference the guard should have refused, and inside the
      // transaction that throw rolled back the RUNNER'S OWN AUDIT ENTRY:
      // one answer produced zero chained entries and no execution
      // record at all, which is the one thing ADR-0014 as amended does not
      // allow. The entry and the record are the execution's trace and they
      // commit first; a rendering that then fails is a bug in this process,
      // loud, and traceable to a row that exists.
      const turn = renderOwnerTurn(answer, served, timeZone);
      return {
        questionId,
        executionId,
        disposition: record.disposition,
        record,
        turn,
        failure: null,
      };
    } catch (error) {
      if (!(error instanceof ExecutionError)) throw error;
      // The runner already appended this execution's one entry, inside this
      // transaction, before it threw. Recording the record beside it is what
      // keeps the pair together.
      await store.recordExecution(error.record);
      await client.query("COMMIT");
      return {
        questionId,
        executionId,
        disposition: error.record.disposition,
        record: error.record,
        turn: null,
        failure: refused ?? FAILED_TURN,
      };
    }
  } catch (error) {
    // Anything else — a chain that would not accept the entry, a store that
    // would not write, a transaction the database aborted — takes the whole
    // turn with it. Nothing half-written, nothing chained with no record.
    await rollback(client);
    throw error;
  }
}

/**
 * The record the owner picked, served — or nothing, when they picked none
 * and when what they picked is not a cliente of this company.
 *
 * READ THROUGH THE OWNER'S OWN VIEWS, on the connection the app
 * authenticated: the policy is what makes an id from another company return
 * no row, so there is no tenant check here and none to forget.
 */
async function chosenRecord(
  client: pg.ClientBase,
  served: ServedRows,
  entityId: string | undefined,
): Promise<number | null> {
  if (entityId === undefined) return null;
  // AN ID THAT IS NOT AN ID NAMES NO CLIENTE (Codex r2). The value arrives
  // off a form field, so it is whatever was posted — and a word reaches the
  // read as a `uuid` cast, which raises, aborts the turn's transaction and
  // answers the owner with a 500 rather than an answer. Refused here, it is
  // the same as an id naming no cliente of this company: no row is served
  // and the turn runs as though the name had been typed.
  if (!UUID.test(entityId)) return null;
  const [entity] = await readOwnerEntitiesByIds(client, [entityId]);
  if (entity === undefined) return null;
  // A LOOKUP, AND THE TURN IS TOLD SO. The pick is exactly the resolution
  // the owner performed on the last turn's pills, so it counts as one and
  // not as a read of the record: an answer about them still has to open
  // their timeline (`guard.ts`, rule four).
  served.noteResolution();
  return served.serveEntity(entity);
}

/**
 * The question, plus the record the owner chose.
 *
 * CONTEXT, NOT INSTRUCTIONS, and that is why it rides on the question rather
 * than being stamped into the digest: what the owner picked varies every
 * turn by design, exactly as the question and the earlier turns do
 * (`definition.ts`). The stored question stays the owner's own words —
 * `recordOwnerQuestion` has already written it — so nothing below is
 * anything the owner said or the room will show.
 */
function questionWithChoice(question: string, ref: number): string {
  return [
    question,
    `The owner picked one of the records you offered them, and it is reference [${ref}]. That is the record they mean. Read its timeline and answer about it — do not look the name up again, and do not ask which one.`,
  ].join("\n\n");
}

/**
 * Why a turn failed, in words that carry nothing (Codex r2).
 *
 * THE RUNNER BUILDS ITS MESSAGE WITH `String(error)` for a model call or a
 * tool handler that threw, so a provider's error text or a Postgres message
 * quoting a parameter can end up in it — and this value crosses back to the
 * app, which may log it or render it. So a failed turn says only that it
 * failed. The one sentence worth keeping is a refused ANSWER's, which is the
 * structural guard's own violation list and content-free by construction,
 * and that one arrives through `refused`, never through this message.
 */
const FAILED_TURN = "the execution did not produce an answer, and the reason is not the owner's to read";

/** Why an answer the CLI gave up on has no turn: it never reached the guard. */
const UNREAD_ANSWER = "the answer did not match its schema, so there is nothing to render";

/**
 * How a turn opens its transaction — exported so the claim above can be
 * tested at the level it is made rather than restated in a suite.
 *
 * THE LEVEL IS NAMED, not left to the server (ticket #165, Codex r1). It was
 * a bare `BEGIN`, which takes `default_transaction_isolation` — a setting a
 * server, a role or a DSN can carry — while the long comment above says the
 * chain append is CORRECT ONLY under READ COMMITTED: the appender takes the
 * advisory lock and then reads the tail, and under REPEATABLE READ that read
 * uses a snapshot taken before the lock was waited for, so a turn can extend
 * a tail somebody else has already extended and fork the chain. A property
 * this file argues for in eleven lines should not depend on a setting nobody
 * in this repo writes down.
 */
export const TURN_TRANSACTION = "BEGIN ISOLATION LEVEL READ COMMITTED";

/** Anything but a UUID cannot be an entity id, and never reaches the database. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Rolls back, and never hides the error that got us here. */
async function rollback(client: pg.ClientBase): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // A connection that cannot roll back is one the pool will discard. The
    // original failure is the one worth propagating.
  }
}
