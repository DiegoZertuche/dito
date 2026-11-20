/**
 * The rig's requester for the daily extraction (ticket #197; spec #193
 * decision 26; ADR-0010 as amended).
 *
 * IT ASKS THE RUNNING RUNTIME AND WAITS. This script writes one
 * `runtime_requests` row and then reads back what became of it: the runtime's
 * own loop picks the row up on its next poll and creates the executions
 * itself, on the same definition and the same digest the clock fires, with
 * `request` on every record so the trace says who asked.
 *
 * `rig-run.ts` MUST BE UP. This script opens NO bundle and needs no key — it
 * is a database client and a poll loop — and the runtime is the one holder of
 * twin memory (ADR-0010), so the work has to happen there. A trigger that
 * opened the bundle itself would cost the session the rail's linked device and
 * the rep's drafting for as long as it ran.
 *
 * WHAT IT ASKS FOR is the whole day: every bound chat that still owes it, one
 * execution each, exactly as the hand trigger read them. Idempotent per
 * (twin, chat, day) exactly as the scheduled pass is — ask twice and the
 * second ask reads nothing, because the day's chats are already settled.
 *
 * ...UNLESS YOU ASK FOR THE RE-READ (ticket #67; #57 finding 4). A steering
 * session sends traffic, checks the result, sends more and checks again, and
 * the day's second ask reports nothing read. `--reextract` reads each settled
 * chat again from where the last run read through — only what arrived since,
 * so nothing is filed twice — and records the re-read as a steering run of its
 * own.
 *
 * RUN IT BEFORE `rig-disclose.ts`. Extraction is cut ahead of the disclosure
 * (ADR-0016), so a disclosure asked for first would account for a day whose
 * facts are not filed yet — and mark that day done. Both are requesters now
 * (#198), so both want the runner UP and neither costs the session its rail.
 *
 * NO EMBEDDER HERE, BECAUSE THE READS ARE NOT HERE. `search_chat_history`
 * embeds its query through that boundary (ticket #196), and it runs inside the
 * RUNTIME's execution — `rig-run.ts` loads the embedder at start and hands it
 * to the pass on `deps.embedder`. One loaded in this process would spend a
 * first-run weights download to hand it to nobody. One process holds the
 * bundle, the model client and the embedder, which is the same sentence
 * ADR-0010 makes about the bundle.
 *
 * ONE CHAT INSTEAD OF THE DAY, when a session wants it: `--chat=<jid>` narrows
 * the runtime's enumeration to that conversation, so the other chats' days stay
 * owed to the evening's own pass. The address rides on the row's own column and
 * never in its parameters, which the store refuses (ADR-0004, ADR-0020).
 *
 * Usage: source .env.rig, then
 *   node --experimental-strip-types scripts/rig-extract.ts [--reextract] [--chat=<jid>] [--timeout=<seconds>]
 * (build first: pnpm build)
 *
 * `DITO_RIG_NOW` moves the rep's clock for this run and for every other hand
 * trigger that reads it (see `rig-env.ts`). It rides in the request's
 * parameters as an instant and it never moves the watermark, which the loop
 * cuts from its own real clock.
 */
import pg from "pg";
import type {
  RuntimeRequestOutcome,
  RuntimeRequestReason,
} from "../dist/index.js";
import { describeRigClock, repTimeZone, rigClock } from "./rig-env.ts";

const USAGE =
  "usage: source .env.rig && node --experimental-strip-types scripts/rig-extract.ts [--reextract] [--chat=<jid>] [--timeout=<seconds>]";

/**
 * How often the row is read back.
 *
 * ONE SECOND, UNDER THE RUNTIME'S OWN TWO. The loop polls every 2,000ms, so a
 * requester asking less often than that would add a poll's worth of latency to
 * a wait that is already the length of a model call, and one asking much more
 * often would spend the rig's connections on nothing.
 */
const POLL_INTERVAL_MS = 1_000;

/**
 * How long a wait may last before this script gives up, in seconds.
 *
 * FIVE MINUTES, AND IT IS A BOUND RATHER THAN AN ESTIMATE. One extraction is
 * eight rounds at most and takes seconds; a day's chats run one at a time on a
 * lane capped at one, so a rig with several busy conversations is a minute or
 * two. What the bound is really for is the case where the runtime is NOT
 * running: nothing takes the row, and a session that waited forever would look
 * exactly like one whose extraction is merely slow.
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
  /** Chats the runtime left alone because their day was already being read. */
  readonly unclaimed: number;
}

/**
 * One run this request claimed, with the execution record it names.
 *
 * THE RUN IS WHAT IS WAITED ON, and the execution is what is printed. A run
 * settles whichever way its execution ends — including the ending that leaves
 * no record at all, where the lane's own recovery settles it `failed` — so a
 * requester waiting on runs waits on rows that are certain to arrive. Waiting
 * on the executions instead would poll for a row that never appears, right up
 * to the timeout.
 */
interface ClaimedRunRow {
  readonly state: string;
  readonly settled_at: string | null;
  readonly execution_id: string | null;
  readonly disposition: string | null;
  readonly iterations: number | null;
  readonly tokens_input: number | null;
  readonly tokens_output: number | null;
  readonly started_at: string | null;
  readonly ended_at: string | null;
}

const args = process.argv.slice(2);
// A MISTYPED FLAG STOPS THE RUN rather than being ignored: `--reextrac`
// silently reading nothing is exactly the confusion this trigger exists to
// end — the same rule the request channel itself applies to an unknown
// parameter (`runtime-requests.ts`).
const unknownFlags = args.filter(
  (arg) =>
    arg.startsWith("--") &&
    arg !== "--reextract" &&
    !arg.startsWith("--timeout=") &&
    !arg.startsWith("--chat="),
);
if (unknownFlags.length > 0) {
  console.error(`unknown option(s): ${unknownFlags.join(", ")}\n${USAGE}`);
  process.exit(1);
}
const positional = args.filter((arg) => !arg.startsWith("--"));
if (positional.length > 0) {
  // THE RIG NUMBER IS GONE, and saying so beats ignoring it: this script no
  // longer opens the bundle, so it has no self-chat to know about and nothing
  // to do with a number. A session pasting the old command line learns that
  // here rather than from a run that quietly did something else.
  console.error(
    `this trigger takes no positional argument: it asks the RUNNING runtime and needs no rig number (ticket #197)\n${USAGE}`,
  );
  process.exit(1);
}
const reextract = args.includes("--reextract");
const chatJid = args
  .find((arg) => arg.startsWith("--chat="))
  ?.slice("--chat=".length);
if (chatJid !== undefined && !chatJid.includes("@")) {
  // A JID, not a number: the runtime narrows its enumeration by exact match, so
  // a bare phone number would name no conversation and the ask would be served
  // over nothing at all.
  console.error(
    `--chat takes a full chat JID, e.g. 5215551234567@s.whatsapp.net — got ${JSON.stringify(chatJid)}\n${USAGE}`,
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
// THE DEADLINE STARTS BEFORE THE CONNECTION (Codex r1). `--timeout` is a bound
// on how long this script may take, and a bound that began after connecting
// and inserting would not cover the two operations most likely to hang on a
// sick database. The client carries the same number as its own connect and
// statement limits, so a blocked statement returns an error instead of parking
// the process on a poll that never comes back.
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
  console.log(`extraction clock: ${describeRigClock(clock, timeZone)}`);
  // WHAT THE OPERATOR ASKED FOR AND NOTHING ELSE. A parameter is written only
  // when a person asked for one: an empty document is the ordinary ask, and
  // the row is then a record of what was wanted rather than of this script's
  // defaults. `seamNow` is not among them — the loop's own clock is the
  // seam's, which is the whole of #57 finding 5.
  const parameters: Record<string, unknown> = {};
  if (clock.steered) parameters["now"] = clock.now.toISOString();
  if (reextract) parameters["reextract"] = true;

  const asked = await db.query<{ id: string }>(
    `INSERT INTO runtime_requests (twin_id, occasion, chat_jid, parameters)
     VALUES ($1, 'extraction', $2, $3)
     RETURNING id`,
    [twinId, chatJid ?? null, JSON.stringify(parameters)],
  );
  const requestId = asked.rows[0]!.id;
  console.log(
    `asked the running runtime for an extraction` +
      `${chatJid === undefined ? "" : " of one chat"}` +
      `${reextract ? " [re-reading settled chats]" : ""}: request ${requestId}`,
  );

  const settled = await waitForOutcome(db, requestId, deadline);
  if (settled === undefined) {
    // THE ROW IS STILL PENDING, and it stays that way until something takes
    // it. A runtime that is not running takes nothing.
    console.error(
      `the runtime did not answer within ${timeoutSeconds}s — is rig-run.ts up? The row is still pending; a running runtime serves it on its next poll.`,
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
    // A `failed` ASK MAY STILL HAVE LAUNCHED WORK (Codex r3). The pass submits
    // chat by chat, so a throw partway leaves earlier executions running — and
    // exiting here would report a failure with no account of facts that are
    // about to commit. A refusal creates nothing (the store's own CHECK says
    // so), so there is nothing to wait for on that arm.
    if (settled.outcome === "failed") {
      report(await waitForRuns(db, requestId, deadline));
    }
    process.exit(1);
  }
  console.log(
    settled.executions === 0
      ? "served: no chat still owed the day — pass --reextract to read what has arrived since."
      : `served: ${settled.executions} chat-day(s) on the batch lane; waiting for them to finish.`,
  );
  if (settled.unclaimed > 0) {
    // WHAT THIS ASK DID NOT DO. A chat whose day was already being read is
    // left alone by the in-flight guard, so nothing this request asked for
    // happened to it — a re-read of that conversation has NOT run, and a green
    // exit would say it had.
    console.error(
      `${settled.unclaimed} chat(s) were already being read and were left alone — ask again once they finish.`,
    );
    failed = true;
  }

  const runs = await waitForRuns(db, requestId, deadline);
  report(runs);
  const unsettled = runs.filter((run) => run.settled_at === null).length;
  if (unsettled > 0) {
    console.error(
      `${unsettled} of ${runs.length} claimed run(s) had not settled within ${timeoutSeconds}s — they are still on the batch lane.`,
    );
    failed = true;
  }
  // ...AND A RUN THAT WENT MISSING IS NOT A RUN THAT SETTLED (Codex r2). A
  // runtime that restarts while this is waiting recovers a `submitted` row
  // through the SCHEDULED pass, and an empty or short list would otherwise read
  // as "everything finished" and exit zero over work still in progress.
  if (runs.length < settled.executions) {
    console.error(
      `only ${runs.length} of the ${settled.executions} run(s) this request claimed are still owned by it — the runtime may have restarted and recovered them.`,
    );
    failed = true;
  }
  if (!failed && settled.executions > 0) {
    console.log("now run rig-disclose.ts to post the day's disclosure.");
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
 * like an extraction that is merely slow.
 */
async function waitForOutcome(
  db: pg.Client,
  requestId: string,
  deadline: number,
): Promise<SettledRequest | undefined> {
  for (;;) {
    const row = await db.query<{
      outcome: RuntimeRequestOutcome | null;
      reason: RuntimeRequestReason | null;
      taken_at: Date | null;
      executions: number;
      unclaimed: number;
    }>(
      `SELECT outcome, reason, taken_at, executions, unclaimed
         FROM runtime_requests WHERE id = $1`,
      [requestId],
    );
    const current = row.rows[0]!;
    if (current.outcome !== null && current.taken_at !== null) {
      return {
        outcome: current.outcome,
        reason: current.reason,
        executions: Number(current.executions),
        unclaimed: Number(current.unclaimed),
      };
    }
    if (Date.now() >= deadline) return undefined;
    await sleep(POLL_INTERVAL_MS);
  }
}

/**
 * Reads the runs this request claimed, until they have all settled or the
 * deadline passes.
 *
 * BY `request_id`, WHICH IS WHY THAT COLUMN EXISTS (Codex r1). Matching
 * executions by instant instead — "the `request`-mechanism ones that started
 * after this ask was taken" — is another request's work the moment two asks
 * overlap, and one requester could then count another's finished execution
 * towards its own and exit ZERO over a run that had not started. Ownership is
 * a column and this read goes through it.
 *
 * RETURNS WHAT IT HAS AT THE DEADLINE rather than throwing, so a session sees
 * the runs that did settle and the caller reports the shortfall.
 */
async function waitForRuns(
  db: pg.Client,
  requestId: string,
  deadline: number,
): Promise<readonly ClaimedRunRow[]> {
  for (;;) {
    const rows = await db.query<ClaimedRunRow>(
      `SELECT r.state, r.settled_at, r.execution_id,
              e.disposition, e.iterations, e.tokens_input, e.tokens_output,
              e.started_at, e.ended_at
         FROM extraction_runs r
         LEFT JOIN executions e ON e.id = r.execution_id
        WHERE r.request_id = $1
        ORDER BY r.started_at`,
      [requestId],
    );
    if (rows.rows.every((run) => run.settled_at !== null)) return rows.rows;
    if (Date.now() >= deadline) return rows.rows;
    await sleep(POLL_INTERVAL_MS);
  }
}

/**
 * Prints one line per run this request claimed, with what its execution cost.
 *
 * A `failed` RUN MAKES THE SHELL UNHAPPY. Spec #193 decision 10 says the lane
 * records it and moves on, which is right for the runtime and wrong for a
 * session's shell: the chat is not read again today, so a green exit would tell
 * an operator the day was read.
 */
function report(runs: readonly ClaimedRunRow[]): void {
  for (const run of runs) {
    const spend =
      run.execution_id === null
        ? "no execution record — its transaction is gone"
        : `${run.disposition}, ${run.iterations} round(s), ` +
          `${run.tokens_input} in / ${run.tokens_output} out, ` +
          `${new Date(run.ended_at!).getTime() - new Date(run.started_at!).getTime()}ms`;
    console.log(`  run ${run.state}: ${spend}`);
    if (run.state === "failed") failed = true;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
