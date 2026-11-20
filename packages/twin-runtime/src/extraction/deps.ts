/**
 * WHAT ONE EXTRACTION EXECUTION IS BUILT OVER (ticket #194; spec #193
 * decisions 14 and 16).
 *
 * The occasion binds three kinds of thing at construction, and this is the
 * first: the DEPENDENCIES. A spec holds no function, no connection and no
 * content (`automation.ts`), so the chat's confirmed name, the transcript
 * before the window and the window's own beats all arrive here.
 *
 * WHY CONTENT COMES THROUGH HERE AND NOT AS PARAMETERS. `ParameterValue` is
 * scalar by design: "a parameter rich enough to be an object would be content
 * travelling under the name of a parameter" (`registry.ts`). A day is a list
 * of beats and a transcript is a longer one, so neither can be a parameter
 * and neither should be — what a spec declares is a recipe's NAME and the
 * SHAPE of what varies, and the digest stamps exactly that.
 *
 * ...AND THE THREE READS ARE BOUND HERE TOO (ticket #196). A tool is built
 * for one execution out of what that execution may reach, so the connection,
 * twin memory, the embedder boundary and this run's served references arrive
 * the same way the day's beats do. None of them is a parameter and none of
 * them reaches the digest: what a spec declares is a tool's NAME, its
 * description, its schema and its pinned columns, and the digest stamps
 * exactly that (`instructionsDigest`).
 *
 * THE ROWS ARE READ AND COMPOSED BEFORE THEY GET HERE. Recipes are
 * synchronous, and both reads are round trips — the day comes off the SEAM
 * (a candidate fact has to name the `wa_events` row it was read in) and the
 * transcript comes out of twin memory. So the pass performs them and hands
 * the rows over, with every gesture already composed against what memory
 * holds (#97) and every unreadable delivery already carrying its
 * code-rendered placeholder (ADR-0042), because both are properties of the
 * ROW rather than of the prompt.
 */
import type { Bundle, ConversationRow } from "@dito/bundle";
import type pg from "pg";
import type { Embedder } from "../embedder.js";
import { ServedReads } from "./served.js";

/** What one extraction execution's parts are built over. */
export interface ExtractionDeps {
  /**
   * The counterparty's rep-confirmed name.
   *
   * ALWAYS CONFIRMED, and that is structural rather than an assumption: the
   * pass enumerates BOUND chats, and an unbound one gets the binding proposal
   * and no execution at all (FR-32; spec #193 decision 9). So the binding part
   * has one arm where drafting's has three.
   */
  readonly counterparty: string;
  /**
   * The chat's recent window from twin memory, with the day's own beats
   * removed — context the model has already been told is handled.
   */
  readonly transcript: readonly ConversationRow[];
  /**
   * The window's beats in order, each carrying the id a candidate fact must
   * cite. Reactions and unreadable deliveries are beats like any other
   * (ADR-0041, ADR-0042), already rendered.
   */
  readonly day: readonly ConversationRow[];
  /**
   * The seat's IANA zone, resolved by the caller.
   *
   * REQUIRED HERE THOUGH IT IS OPTIONAL ON THE PASS'S DEPS, and that is the
   * point of resolving it once: the «now» header and every beat's own stamp
   * render from THIS value, so the two cannot disagree about an hour — which
   * is #139's founding complaint. Unset on the runtime means the host clock,
   * and the pass resolves that to a name before anything renders.
   */
  readonly timeZone: string;
  /**
   * THE EXECUTION'S OWN CONNECTION, never the pass's (ticket #196; the rule
   * #173 wrote for drafting and `lanes.ts` argues in full).
   *
   * `read_filed_facts` runs on it, inside this execution's transaction, so
   * what it reads is what this transaction will commit against — and a
   * statement that raises would otherwise poison the record, the chain entry
   * and the settle that come after it, which is why that one tool is
   * savepointed (`tool-savepoints.ts`).
   */
  readonly db: pg.ClientBase;
  readonly twinId: string;
  /**
   * Twin memory: the search's row source, the entity mirror `list_chats`
   * reads, and where every counterparty name comes from.
   */
  readonly bundle: Bundle;
  /**
   * The embedder boundary (#32) — the search's query vector, computed
   * in-process and never persisted. The one new scripted boundary of slice
   * 2, and the same one drafting's `retrieved_memories` and the thread's
   * `search_memory` go through.
   */
  readonly embedder: Embedder;
  /**
   * The rep's own thread — the one conversation the search may never reach
   * (ADR-0033). It is handed to the bundle as a constraint on the KNN's row
   * source rather than used to filter its result (spec #193 decision 18),
   * and `list_chats` REFUSES rather than removes if it ever finds it in the
   * entity mirror.
   */
  readonly selfChatJid: string;
  /**
   * This run's served references — mutable and run-scoped, which is why it
   * arrives here rather than being built inside a tool: three reads draw from
   * one counter and two of them resolve what a third served (`served.ts`).
   */
  readonly served: ServedReads;
}

/**
 * DEPENDENCIES THAT REFUSE, the unit suites' floor (`testing/extraction-deps.ts`):
 * a fixture whose defaults refuse cannot pass a test by accident.
 */
export function refusingExtractionDeps(): ExtractionDeps {
  return {
    counterparty: "",
    transcript: [],
    day: [],
    timeZone: "UTC",
    twinId: "",
    selfChatJid: "",
    served: new ServedReads(),
    db: refusing("Postgres"),
    bundle: refusing("twin memory"),
    embedder: refusing("the embedder"),
  };
}

/** A stub that fails loudly rather than pretending to be a store. */
function refusing<T>(what: string): T {
  return new Proxy(
    {},
    {
      get: () => () => {
        throw new Error(
          `${what} was reached by an extraction built over dependencies that refuse — a definition stamped rather than run, or a unit suite that did not ask for it`,
        );
      },
    },
  ) as T;
}
