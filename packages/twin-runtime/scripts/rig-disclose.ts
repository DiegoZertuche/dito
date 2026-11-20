/**
 * The rig's requester for the daily disclosure (ticket #198; spec #193
 * decisions 24 and 26; ADR-0010 as amended).
 *
 * IT ASKS THE RUNNING RUNTIME AND WAITS. This script writes one
 * `runtime_requests` row and then reads back what became of it: the runtime's
 * own loop picks the row up on its next poll and creates the execution
 * itself, on the same definition and the same digest the clock fires, with
 * `request` on the record so the trace says who asked.
 *
 * `rig-run.ts` MUST BE UP. This script opens NO bundle and needs no key — it
 * is a database client and a poll loop — and the runtime is the one holder of
 * twin memory (ADR-0010), so the work has to happen there. A trigger that
 * opened the bundle itself would cost the session the rail's linked device and
 * the rep's drafting for as long as it ran, to post one message.
 *
 * WHAT IT ASKS FOR is the day's post: the lines nobody has heard about,
 * grouped and numbered by code, with the opening and closing the twin
 * composes around them.
 * Idempotent per (twin, day), and more strictly than the extraction is: the
 * day is ATTEMPTED once, whichever way that attempt ended (spec #193 decision
 * 10), so asking twice creates nothing the second time.
 *
 * RUN IT AFTER `rig-extract.ts`. Extraction is cut ahead of the disclosure
 * (ADR-0016), so a post asked for first would account for a day whose facts
 * are not filed yet — and mark that day done.
 *
 * ...AND A PERSON CANNOT SPEND A DAY THE REP HAS NOT LIVED. `DITO_RIG_NOW`
 * moves this request's clock like it moves the extraction's, and the RUNTIME
 * refuses an instant whose rep day is later than the seam's
 * (`day_not_lived`). The post is keyed (twin, day), so posting tomorrow's
 * account today would be the post tomorrow gets, and the scheduled pass would
 * then say nothing on a real day the rep had traffic. The refusal belongs to
 * the CHANNEL rather than to this script, so a hand-written row cannot do
 * what this script would not.
 *
 * Usage: source .env.rig, then
 *   node --experimental-strip-types scripts/rig-disclose.ts [--timeout=<seconds>]
 * (build first: pnpm build)
 */
import pg from "pg";
import type {
  RuntimeRequestOutcome,
  RuntimeRequestReason,
} from "../dist/index.js";
import { describeRigClock, repTimeZone, rigClock } from "./rig-env.ts";

const USAGE =
  "usage: source .env.rig && node --experimental-strip-types scripts/rig-disclose.ts [--timeout=<seconds>]";

/**
 * How often the row is read back.
 *
 * ONE SECOND, UNDER THE RUNTIME'S OWN TWO — `rig-extract.ts`'s number and its
 * argument: the loop polls every 2,000ms, so asking less often would add a
 * poll's latency to a wait that is already a model call, and asking much more
 * often would spend the rig's connections on nothing.
 */
const POLL_INTERVAL_MS = 1_000;

/**
 * How long a wait may last before this script gives up, in seconds.
 *
 * FIVE MINUTES, AND IT IS A BOUND RATHER THAN AN ESTIMATE. One disclosure is
 * four rounds at most and takes seconds. What the bound is really for is the
 * case where the runtime is NOT running: nothing takes the row, and a session
 * that waited forever would look exactly like one whose post is merely slow.
 */
const DEFAULT_TIMEOUT_SECONDS = 300;

/**
 * What the request row says once the loop has decided about it.
 *
 * The two words are the RUNTIME's closed sets, imported rather than restated:
 * a script comparing bare strings is a second copy of a vocabulary the store's
 * own CHECK holds.
 */
interface SettledRequest {
  readonly outcome: RuntimeRequestOutcome;
  readonly reason: RuntimeRequestReason | null;
  readonly executions: number;
}

/** The execution this request created, what it posted, and what it cost. */
interface ComposedDay {
  readonly disposition: string;
  readonly iterations: number;
  readonly tokens_input: number;
  readonly tokens_output: number;
  readonly started_at: string;
  readonly ended_at: string;
  readonly lines: string;
}

const args = process.argv.slice(2);
// A MISTYPED FLAG STOPS THE RUN rather than being ignored — `rig-extract.ts`'s
// rule, for the same reason: an option silently ignored is exactly the
// confusion these triggers exist to end.
const unknownFlags = args.filter(
  (arg) => arg.startsWith("--") && !arg.startsWith("--timeout="),
);
if (unknownFlags.length > 0) {
  console.error(`unknown option(s): ${unknownFlags.join(", ")}\n${USAGE}`);
  process.exit(1);
}
const positional = args.filter((arg) => !arg.startsWith("--"));
if (positional.length > 0) {
  // THE RIG NUMBER IS REFUSED RATHER THAN IGNORED: this script opens no
  // bundle, so it has no self-chat to know about and nothing to do with a
  // number. A session pasting an older command line learns that here rather
  // than from a run that quietly did something else.
  console.error(
    `this trigger takes no positional argument: it asks the RUNNING runtime and needs no rig number (ticket #198)\n${USAGE}`,
  );
  process.exit(1);
}
const timeoutRaw = args
  .find((arg) => arg.startsWith("--timeout="))
  ?.slice("--timeout=".length);
const timeoutSeconds =
  timeoutRaw === undefined ? DEFAULT_TIMEOUT_SECONDS : Number(timeoutRaw);
if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
  console.error(
    `--timeout must be a positive number of seconds — got ${JSON.stringify(timeoutRaw)}\n${USAGE}`,
  );
  process.exit(1);
}

const twinId = process.env["DITO_TWIN_ID"];
const dbUrl = process.env["DITO_DATABASE_URL"];
if (twinId === undefined || dbUrl === undefined) {
  console.error(USAGE);
  process.exit(1);
}

const timeZone = repTimeZone();
// THE DEADLINE STARTS BEFORE THE CONNECTION (`rig-extract.ts`'s own rule):
// `--timeout` bounds how long this script may take, and a bound that began
// after connecting and inserting would not cover the two operations most
// likely to hang on a sick database. The client carries the same number as its
// connect and statement limits.
const deadline = Date.now() + timeoutSeconds * 1_000;
const db = new pg.Client({
  connectionString: dbUrl,
  connectionTimeoutMillis: timeoutSeconds * 1_000,
  statement_timeout: timeoutSeconds * 1_000,
  query_timeout: timeoutSeconds * 1_000,
});
await db.connect();

/** Whether anything about this run should make the shell unhappy. */
let failed = false;

try {
  const clock = rigClock();
  console.log(`disclosure clock: ${describeRigClock(clock, timeZone)}`);
  // WHAT THE OPERATOR ASKED FOR AND NOTHING ELSE. An empty document is the
  // ordinary ask; `reextract` is meaningless for a post and the runtime
  // refuses one, so this script has no flag for it and never writes the key.
  const parameters: Record<string, unknown> = {};
  if (clock.steered) parameters["now"] = clock.now.toISOString();

  const asked = await db.query<{ id: string }>(
    `INSERT INTO runtime_requests (twin_id, occasion, parameters)
     VALUES ($1, 'daily_disclosure', $2)
     RETURNING id`,
    [twinId, JSON.stringify(parameters)],
  );
  const requestId = asked.rows[0]!.id;
  console.log(
    `asked the running runtime for the day's disclosure: request ${requestId}`,
  );

  const settled = await waitForOutcome(db, requestId, deadline);
  if (settled === undefined) {
    // THE ROW WAS NEVER TAKEN, and it stays that way until something takes
    // it. A runtime that is not running takes nothing.
    console.error(
      `the runtime did not answer within ${timeoutSeconds}s — is rig-run.ts up? The row is still pending; a running runtime serves it on its next poll.`,
    );
    process.exit(1);
  }
  if (settled === "composing") {
    // TAKEN, AND STILL COMPOSING PAST THE BOUND. The outcome arrives with the
    // execution's own transaction, so there is nothing to read yet and
    // nothing has been lost: the post commits or it does not, and a longer
    // `--timeout` is the whole answer.
    console.error(
      `the runtime took this request and had not finished composing within ${timeoutSeconds}s — the outcome is written with the execution's own transaction, so give it a longer --timeout.`,
    );
    process.exit(1);
  }
  if (settled.outcome !== "served") {
    // A CLOSED WORD IS THE WHOLE ANSWER (`runtime-requests.ts`): `refused`
    // means the ask could not be served and nothing was created, `failed`
    // means the runtime could not finish serving it, and the reason names
    // which.
    console.error(
      `the runtime ${settled.outcome} this request: ${settled.reason ?? "no reason"}`,
    );
    process.exit(1);
  }
  if (settled.executions === 0) {
    // NOTHING WAS COMPOSED, and there are exactly two ways to get here. The
    // day's post has told a session both in one sentence from the beginning
    // (#51), because neither is a fault and there is nothing to do about
    // either.
    console.log(
      `nothing new to disclose (${timeZone}): either nothing crossed, or today's disclosure has already been attempted.`,
    );
  } else {
    const composed = await waitForExecution(db, requestId, deadline);
    if (composed === undefined) {
      console.error(
        `the row names an execution this database cannot read back within ${timeoutSeconds}s — the reference and the record commit together, so this is a database that stopped answering rather than a post that is merely slow.`,
      );
      process.exit(1);
    }
    report(composed, timeZone);
    // A `failed` POST MAKES THE SHELL UNHAPPY. Spec #193 decision 10 says the
    // lane records it and moves on, which is right for the runtime and wrong
    // for a session's shell: the day is not composed again today, so a green
    // exit would tell an operator their day had been accounted for.
    if (composed.disposition !== "posted") failed = true;
  }
} finally {
  await db.end();
}

if (failed) process.exit(1);

/**
 * Reads the row back until the loop has settled it, or the deadline passes.
 *
 * BOUNDED, AND THE BOUND IS THE POINT (see `DEFAULT_TIMEOUT_SECONDS`): a
 * runtime that is not running takes nothing, and a wait with no end would look
 * like a post that is merely slow.
 */
async function waitForOutcome(
  client: pg.Client,
  requestId: string,
  bound: number,
): Promise<SettledRequest | "composing" | undefined> {
  for (;;) {
    const row = await client.query<{
      outcome: RuntimeRequestOutcome | null;
      reason: RuntimeRequestReason | null;
      taken_at: Date | null;
      executions: number;
    }>(
      `SELECT outcome, reason, taken_at, executions
         FROM runtime_requests WHERE id = $1`,
      [requestId],
    );
    const current = row.rows[0]!;
    if (current.outcome !== null && current.taken_at !== null) {
      return {
        outcome: current.outcome,
        reason: current.reason,
        executions: Number(current.executions),
      };
    }
    // TAKEN AND UNSETTLED IS THE COMPOSING WINDOW (Codex r1 on #198): the
    // execution settles this row from inside its own transaction, so a taken
    // row with no outcome means the model is writing. The caller says which
    // of the two waits ran out, because "is the runtime up" and "the runtime
    // is still working" are different things to tell a session.
    if (Date.now() >= bound) {
      return current.taken_at === null ? undefined : "composing";
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

/**
 * Reads the execution this request created, once it has one.
 *
 * THROUGH `runtime_requests.execution_id`, which the execution writes from
 * inside its OWN transaction (ticket #197's rule, applied to this occasion):
 * the reference and the record commit together, so a row that names an
 * execution names one that exists. It appears when the execution commits,
 * which is why this is a poll rather than a read.
 *
 * IT IS ALREADY THERE BY THE TIME THIS RUNS (Codex r1 on #198). The row's own
 * outcome is written in that same transaction, so an ask this script has seen
 * settled `served` names a record that exists — the poll is what makes that
 * true rather than assumed, and a bound that runs out here means a database
 * that stopped answering. The third ending never reaches this function: an
 * execution whose transaction is gone leaves the row unsettled, `waitForOutcome`
 * says so, and `settleStrandedRequests` answers it at the next start.
 */
async function waitForExecution(
  client: pg.Client,
  requestId: string,
  bound: number,
): Promise<ComposedDay | undefined> {
  for (;;) {
    const rows = await client.query<ComposedDay>(
      `SELECT e.disposition, e.iterations, e.tokens_input, e.tokens_output,
              e.started_at, e.ended_at,
              (SELECT count(*) FROM disclosure_post_lines pl
                 JOIN disclosure_posts p ON p.id = pl.post_id
                 JOIN notices n ON n.id = p.notice_id
                WHERE n.execution_id = e.id) AS lines
         FROM runtime_requests r
         JOIN executions e ON e.id = r.execution_id
        WHERE r.id = $1`,
      [requestId],
    );
    const composed = rows.rows[0];
    if (composed !== undefined) return composed;
    if (Date.now() >= bound) return undefined;
    await sleep(POLL_INTERVAL_MS);
  }
}

/** Prints what the day's post said it did, and what composing it cost. */
function report(composed: ComposedDay, zone: string): void {
  const spent =
    `${composed.iterations} round(s), ` +
    `${composed.tokens_input} in / ${composed.tokens_output} out, ` +
    `${new Date(composed.ended_at).getTime() - new Date(composed.started_at).getTime()}ms`;
  console.log(
    composed.disposition === "posted"
      ? `posted the day's disclosure (${zone}) — ${composed.lines} line(s) ` +
          `queued for the self-chat: ${spent}`
      : `the day's disclosure ended ${composed.disposition} and posted nothing; ` +
          `its lines ride tomorrow's post and it is not composed again today: ${spent}`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
