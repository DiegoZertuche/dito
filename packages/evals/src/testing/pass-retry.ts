/**
 * THE LANE'S BOUNDED RETRY (ticket #146; re-shaped at #194).
 *
 * A run whose model call ends without `file_facts` still has to
 * produce a number, and asking again is how. Three such calls in one #139
 * session were rerun by hand with only the surviving runs counted, which
 * BIASES EVERY NUMBER THE LANE REPORTS: the days that cost a retry are
 * exactly the ones that drop out of the average. A measurement that silently
 * discards its hard draws is not a measurement.
 *
 * WHAT IT READS IS THE RUNTIME'S OWN WORD (spec #193 decision 10). A failed
 * execution writes its record and its chain entry, settles its claim row
 * `failed`, and the pass moves on without throwing — so what this file looks
 * for is a `failed` ROW rather than a sentence, which is what #146 recorded
 * as owed ("a `code` on the error is the honest fix and it belongs to
 * twin-runtime").
 *
 * IT IS THE LANE'S RETRY, NOT THE PASS'S, and that is a decision rather than
 * an accident. What production does with a chat whose day it could not read
 * is settled: nothing today, and tomorrow's window reaches back over it. Here
 * the job is to measure a corpus in one run, so the honest answer is to ask
 * again and to say in the report that it had to.
 *
 * HOW A RETRY IS POSSIBLE AT ALL. Production refuses to re-claim a `failed`
 * run on purpose — otherwise a chat the model will not read costs a model
 * call every two seconds until midnight — so the lane RE-OPENS the row it
 * wants re-asked, back to `submitted`, which is the state the pass already
 * re-claims. That is an eval-only step and it is written as one: the lane
 * owns its database for the length of the run, and the alternative (a second
 * path into extraction) is what this file has always refused. Only a `filed`
 * run advances the watermark, so the re-opened chat's window is still owed
 * while every chat already read is skipped.
 *
 * WHAT IT CANNOT TELL APART, recorded rather than discovered. The runtime
 * settles a refused filing, a truncated response and a run that would not
 * finish under one word — `failed`, with no reason column — so this re-asks
 * all three, where a sharper instrument would re-ask only the last. Asking
 * again measures nothing about the first and spends the budget hitting the
 * same wall on the second. What bounds the cost meanwhile is
 * `NO_TOOL_RETRY_LIMIT`: two re-asks per chat and then the run fails loudly.
 * A `code` on the execution record is the fix, recorded on #194.
 */
import { civilDate, runDailyExtraction, type DailyExtractionDeps } from "@dito/twin-runtime";

/**
 * How many times ONE CHAT's call may be re-asked. Small and fixed: this is
 * a flake tolerance, not a search — three chances to submit and the run is
 * telling us something about the extractor rather than about the wire.
 */
export const NO_TOOL_RETRY_LIMIT = 2;

/**
 * Where a retry announces itself.
 *
 * A SINK RATHER THAN A `console.error` HERE, and `eslint.config.js` is the
 * reason in its own words: `no-console` is a recorded debt of "3 in `src`,
 * 77 in the `scripts/` dirs where logging is the point". This is `src`, and
 * the two live lanes are `scripts/` — so they pass `console.error` and the
 * sentence is composed once, here, where the chat id is known.
 *
 * OMITTING IT IS SILENT, NOT HIDDEN. The count still reaches `EvalRun` and
 * the report either way; this line is the live operator's running
 * commentary, which a suite has no use for beyond asserting it happened.
 */
export type RetryNotice = (notice: string) => void;

export interface RetriedPass {
  /**
   * Chats this pass read ACROSS ITS ATTEMPTS.
   *
   * `result.chats` counts chats with an unread window, so a chat a failed
   * attempt already filed is not in the final call's count — its window is
   * closed, which is the same rule that stops it being re-read. Adding the
   * chats already filed when the last attempt STARTED puts the two halves
   * back together, and on a run that needed no retry the first half is
   * zero and this is `result.chats` unchanged.
   */
  readonly chatsRead: number;
  /** Retries spent, per chat. Chats that needed none are absent. */
  readonly retriesByChat: ReadonlyMap<string, number>;
  /** Every child run of every attempt, by the chat whose day it read. */
  readonly chatOfRun: ReadonlyMap<string, string>;
}

/**
 * Runs the pass, re-asking a chat whose call ended without the tool.
 *
 * Fails loudly when a chat exhausts its retries: the run has no number to
 * report, and reporting one anyway over a corpus with a hole in it is the
 * error this ticket is about.
 */
export async function runPassWithNoToolRetries(
  deps: DailyExtractionDeps,
  now: Date,
  announce: RetryNotice = () => {},
): Promise<RetriedPass> {
  const day = civilDate(now, deps.timeZone);
  const retriesByChat = new Map<string, number>();
  const chatOfRun = new Map<string, string>();
  for (;;) {
    const alreadyRead = await countFiledChats(deps, day);
    const result = await runDailyExtraction(deps, now);
    for (const [runId, chatJid] of result.chatOfRun) chatOfRun.set(runId, chatJid);
    const failed = await chatsThatFailed(deps, day);
    if (failed.length === 0) {
      return { chatsRead: alreadyRead + result.chats, retriesByChat, chatOfRun };
    }
    for (const chatJid of failed) {
      const spent = (retriesByChat.get(chatJid) ?? 0) + 1;
      if (spent > NO_TOOL_RETRY_LIMIT) {
        // FAIL LOUDLY, NAMING THE CHAT. The run has no number to report, and
        // reporting one anyway over a corpus with a hole in it is the bias
        // this whole file is about.
        throw new Error(
          `chat ${chatJid} ended ${NO_TOOL_RETRY_LIMIT + 1} executions without submitting an extraction — ${NO_TOOL_RETRY_LIMIT} retries exhausted, so this run has a hole in it and no number to report (#146)`,
        );
      }
      retriesByChat.set(chatJid, spent);
      // The CHAT, not just the count: "one call failed" tells whoever is
      // watching nothing about which day to go and look at.
      announce(
        `[eval #146] chat ${chatJid}: the execution ended without submitting an extraction — re-asking (retry ${spent} of ${NO_TOOL_RETRY_LIMIT})`,
      );
    }
    await reopenFailedRuns(deps, day, failed);
  }
}

/** Chats whose day this pass has already read — see `chatsRead`. */
async function countFiledChats(
  deps: DailyExtractionDeps,
  day: string,
): Promise<number> {
  const res = await deps.db.query<{ n: string }>(
    `SELECT count(DISTINCT chat_jid) AS n
       FROM extraction_runs
      WHERE twin_id = $1 AND extraction_day = $2 AND state = 'filed'`,
    [deps.twinId, day],
  );
  return Number(res.rows[0]?.n ?? 0);
}

/**
 * The chats whose executions the runtime settled `failed` this day.
 *
 * KEYED ON THE PASS'S OWN DAY, and it has to be: the harness seeds a
 * carried-in day (`owedFromDaysAgo`) as an unsettled `submitted` row under an
 * EARLIER `extraction_day`, deliberately, and nothing ever settles that row. A
 * query that did not name the day would find it every time.
 *
 * ORDERED, so a run that has to re-ask two chats announces and retries them
 * the same way twice — a report should not change because Postgres returned
 * rows in a different order.
 */
async function chatsThatFailed(
  deps: DailyExtractionDeps,
  day: string,
): Promise<string[]> {
  const res = await deps.db.query<{ chat_jid: string }>(
    `SELECT DISTINCT chat_jid
       FROM extraction_runs
      WHERE twin_id = $1 AND extraction_day = $2 AND state = 'failed'
      ORDER BY chat_jid`,
    [deps.twinId, day],
  );
  return res.rows.map((row) => row.chat_jid);
}

/**
 * Re-opens the failed runs this lane means to ask again (ticket #194).
 *
 * THE ONE EVAL-ONLY WRITE IN THIS FILE, and it is here rather than hidden
 * because it is a departure: production settles a `failed` run and refuses to
 * re-claim it for the rest of the day (spec #193 decision 10), which is what
 * stops one unreadable chat buying a model call every two seconds. A
 * measurement cannot wait until tomorrow, so the lane puts the row back into
 * the state the pass already re-claims — `submitted`, unsettled — and the
 * pass then does exactly what it does after a crash mid-call.
 *
 * NOTHING ELSE IS TOUCHED: the counts are already zero (the store's own
 * `extraction_runs_failed_files_nothing` guarantees it) and the window stays
 * the one the failed run claimed, so `owedFrom` still carries it.
 */
async function reopenFailedRuns(
  deps: DailyExtractionDeps,
  day: string,
  chats: readonly string[],
): Promise<void> {
  await deps.db.query(
    `UPDATE extraction_runs
        SET state = 'submitted', settled_at = NULL, execution_id = NULL
      WHERE twin_id = $1 AND extraction_day = $2 AND state = 'failed'
        AND chat_jid = ANY($3::text[])`,
    [deps.twinId, day, [...chats]],
  );
}
