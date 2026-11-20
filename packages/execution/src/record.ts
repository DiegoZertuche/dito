/**
 * The execution record and the store that keeps it (spec #126 decisions
 * 5(e) and 2; user story 36 — "every execution leaves a record … in the
 * owning app's own tables, so that the failed-query log is a disposition
 * and not a second system").
 *
 * The record is what the runner produces. The STORE IS DEFINED HERE AND
 * IMPLEMENTED NOWHERE: this package holds no database connection, and the
 * owning app's tables are its own (the owner app's `owner` schema, #130).
 */
import type { Lane } from "./automation.js";
import type { Trigger } from "./trigger.js";

/**
 * HOW AN EXECUTION ENDED — the closed set, argued in this one place (ticket
 * #128; spec #126 decision 5(e); spec #171 decision 11 — "the set stays
 * argued in one place").
 *
 * A closed set because the failed-query log (FR-48) is a disposition rather
 * than a page: the only way to ask "what did the Ledger fail to answer" is
 * to count these words, and one more invented at a call site makes that
 * question unanswerable in the quietest possible way. User story 41 says why
 * the set is argued rather than merely listed: "so that a new word is a
 * decision and not a typo".
 *
 * The rep side's turns are recorded `drafted`, `classified`, `filed`,
 * `nothing-to-file` and `posted` off what their tools performed, or `acted`
 * for any other performed effect (#178, #172, #194, #198, #364). `migration-vocabulary.test.ts` keeps the store's CHECK
 * constraint aligned with this set, so a valid execution cannot fail at
 * persistence because the database speaks an older vocabulary.
 */
export const DISPOSITIONS = [
  /** The twin answered from what its tools returned. */
  "answered",
  /** The question was about what the wall keeps out, and got FR-46's refusal. */
  "wall-refused",
  /** The Ledger holds no such fact type — «no lo registro», not a guess. */
  "schema-miss",
  /** The agent inside decided to do nothing, which ADR-0014 makes a legitimate outcome. */
  "no-action",
  /** The turn did not end in an outcome: a failure the runtime's ladder names. */
  "failed",
  /** A draft was accepted: the execution proposed a message a rep can tap. */
  "drafted",
  /**
   * A successful execution with a performed effect, including silence
   * (#174; spec #171 decision 11; ADR-0014's 2026-09-05 amendment).
   * The runtime reads EffectOutcome, never prose, so the record cannot
   * claim no action while the rep holds an effect receipt.
   *
   * A turn has its word read off its tools' outcomes by its definition
   * (ticket #357), which sees them and no prose.
   */
  "acted",
  /** A kind was accepted: the entity-kind classification came back with one. */
  "classified",
  /**
   * A day's extraction put candidates in front of the aperture that it filed
   * or held below its gate (tickets #194, #196, #364; spec #193 decision 19):
   * the filing tool's own outcome, read off what the aperture did. How many
   * crossed and how many were dropped are the run row's counters, which is
   * where the measurement lives.
   */
  "filed",
  /** A day the extraction read and filed nothing in — a normal outcome, never a failure. */
  "nothing-to-file",
  /**
   * THE DAY'S DISCLOSURE POSTED (tickets #198, #364; spec #193 decision 24):
   * the send tool's own outcome, which is performed only when the day's post
   * and its numbering COMMITTED in the step's transaction — never over a
   * thread holding nothing.
   */
  "posted",
  /**
   * AN EFFECT LEFT THE EXECUTION WAITING ON THE REP'S ANSWER (ticket #324;
   * spec #318 decision 23: the ask tool called by an `agent` step parks the
   * run through the step's `asked` disposition).
   *
   * THE RUNTIME'S WORD, LIKE `acted`: it is read off the effect a tool
   * reported (`EffectOutcome.waitsOn`), never off the model's words, so a model
   * cannot pause its own execution by saying so — the tool posts the card and
   * the owning app parks on it.
   */
  "asked",
] as const;

/** One of the twelve. */
export type Disposition = (typeof DISPOSITIONS)[number];

/**
 * What a definition's `dispositionOf` may answer at all: everything but
 * `failed`, which only the runtime's failure ladder decides. `asked` is read
 * from what happened — an effect that left the execution waiting, or a typed
 * result that leaves a question open for the person it answers (the owner
 * twin's ask, ticket #363; CONTEXT.md, *Disposition*).
 */
export type ReadDisposition = Exclude<Disposition, "failed">;

/** Whether a word read back out of a store is one this build knows. */
export function isDisposition(word: string): word is Disposition {
  return (DISPOSITIONS as readonly string[]).includes(word);
}

/**
 * What one execution spent.
 *
 * Summed across every iteration of the loop, not read off the final
 * message: an execution that made four calls spent four calls' tokens.
 */
export interface TokenCount {
  readonly input: number;
  readonly output: number;
}

/**
 * One execution, as recorded.
 *
 * `toolNames` is the tool list the execution was GIVEN, not the one it
 * called: the digest that stamps the declared list is 32 opaque hex
 * characters, so without this a reader of the store could not say what an
 * execution was able to reach without also holding the definition that
 * produced the digest.
 *
 * No content: a trigger's ids, a digest, tool names, two instants, three
 * numbers and a word. The owner's question and the twin's answer are the
 * owning app's rows, not this one.
 */
export interface ExecutionRecord {
  readonly trigger: Trigger;
  readonly instructionsDigest: string;
  readonly toolNames: readonly string[];
  readonly startedAt: Date;
  readonly endedAt: Date;
  readonly iterations: number;
  readonly tokens: TokenCount;
  readonly disposition: Disposition;
  /**
   * Which of the runtime's two lanes ran it (spec #171 decision 3).
   *
   * DECLARED BY THE AUTOMATION AND COPIED HERE, never chosen by whatever
   * code happened to fire the run: an execution's lane is a property of what
   * it IS — a rep waiting on a draft, or a day's extraction off the latency
   * path — so it rides on the definition and lands on the record. The rep
   * runtime implements the lanes (#173); this field lets a boundary session
   * compare latency per lane.
   */
  readonly lane: Lane;
}

/**
 * Where the owning app puts a record. Defined here, implemented there.
 *
 * ONE METHOD, taking one record, because that is what one execution needs.
 * Reads, listings, the failed-query query and anything else the owner app
 * wants of its own table are that app's business: this interface exists so
 * the runtime can say "the record is persisted" without holding a
 * connection, and every method beyond that would be a guess about a schema
 * this package must never know.
 */
export interface ExecutionStore {
  recordExecution(record: ExecutionRecord): Promise<void>;
}
