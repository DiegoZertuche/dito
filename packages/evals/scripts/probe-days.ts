/**
 * THE FOCUSED PER-DAY PROBE, AS A LANE (ticket #148, AC 2).
 *
 *   pnpm --filter @dito/evals eval:probe-days
 *
 * Runs the corpus's five relative-weekday days through the REAL harness N
 * times and tallies, per case and per run, whether the dated fact landed
 * on the day its corpus label states. Same guards as the other two live
 * lanes (`requireLiveLane`), same seam, same pass: a labeled transcript
 * goes in as `wa_events` and the answers come back out of the Ledger.
 *
 * WHY IT EXISTS AT ALL, when the precision lane already runs these days:
 * whole-corpus precision is one number over 34 chat-days, and three runs
 * on one unchanged tree gave 89.9 / 85.1 / 90.0. The seven weekday
 * readings this ticket is deciding on are inside that noise. #121 and #139
 * both answered the narrow question with a focused probe for the same
 * reason; #139's was a one-off script that was never checked in, so its
 * numbers cannot be remade from this tree. This one can.
 *
 * IT SCORES NOTHING AND GATES NOTHING. It prints right / undated / wrong /
 * absent per case, the dates each case was actually answered with, and
 * whether the arm HOLDS by the ticket's rule. Exit code is 0 whenever it
 * could measure, and non-zero only when it could not — the same contract
 * `extraction-precision.ts` keeps, and for the same reason: reporting the
 * number is the job, and a lane that failed the build on a model's answer
 * would be a flaky gate on a measurement (ADR-0028, #56 AC 6).
 *
 * NOTHING HERE RESOLVES A WEEKDAY (ADR-0037, Diego's ruling on #139). The
 * expected dates are literals read off the corpus labels; this file does no
 * calendar arithmetic and neither does anything it calls.
 */
import { randomBytes } from "node:crypto";
import pg from "pg";
import { BATCH_LANE_CAP } from "@dito/twin-runtime";
import { corpusDigest } from "../src/corpus.ts";
import {
  DAY_PROBE_CASES,
  dayCaseKey,
  dayProbeExpectations,
  probeDate,
  probeHeld,
  tallyDayProbe,
  type ObservedDatedFact,
} from "../src/corpus/day-probe.ts";
import { SEED_TRANSCRIPTS } from "../src/corpus/transcripts.ts";
import { runExtractionPrecisionEval } from "../src/testing/harness.ts";
import { resetAndMigrate } from "../../seam/src/testing/db.ts";
import { fail, liveEmbedder, requireLiveLane } from "./live-lane.ts";
import { meteredHarness, renderMeter } from "./metering.ts";

const { dbUrl, apiKey, model, effort } = requireLiveLane("the day-probe lane");

/**
 * How many runs. Three by default, because a single run of a live model is
 * an anecdote — #139's own tallies are all "n of m" over repeated runs, and
 * the decision rule this feeds is stated over three.
 */
const requestedRuns = process.env["DITO_PROBE_RUNS"] ?? "3";
const runs = Number(requestedRuns);
if (!Number.isInteger(runs) || runs < 1) {
  // The RAW value, not the NaN it parsed to: "got NaN" loses the typo the
  // person actually made.
  fail(`DITO_PROBE_RUNS must be a positive integer — got "${requestedRuns}"`);
}

/**
 * The days the cases live on, taken from the corpus by the cases' own
 * transcript ids — never a second list to drift from `DAY_PROBE_CASES`.
 */
const wanted = new Set(DAY_PROBE_CASES.map((c) => c.transcriptId));
const transcripts = SEED_TRANSCRIPTS.filter((t) => wanted.has(t.id));
if (transcripts.length !== wanted.size) {
  fail(
    `the probe names ${wanted.size} transcript(s) and the corpus has ${transcripts.length} of them — refusing to report a smaller table about less`,
  );
}
const expected = dayProbeExpectations(DAY_PROBE_CASES, SEED_TRANSCRIPTS);

await resetAndMigrate();
const { harness, calls, close: closeMeter } = await meteredHarness(apiKey);
const db = new pg.Client({ connectionString: dbUrl });
// Where each extraction execution borrows its own connection (#194): an
// execution holds its transaction open across the model call while the pass
// goes on enumerating on `db`, so the two may not share a client.
const executionPool = new pg.Pool({
  connectionString: dbUrl,
  max: BATCH_LANE_CAP,
});
await db.connect();

const startedAt = Date.now();
const observed: ObservedDatedFact[][] = [];
// ONE CHAIN KEY FOR THE WHOLE INVOCATION, not one per run (ADR-0020).
// The lane resets the seam once and then runs N times against it, so the
// audit chain those runs append to is ONE chain — and it is fail-closed:
// a second run offering a fresh key finds a tail it cannot authenticate
// and the store refuses to append, which is the guard working. The
// precision lane never met this because it runs once.
const hmacKey = randomBytes(32);
// ONE EMBEDDER FOR THE WHOLE INVOCATION, loaded before the first run: the
// weights are the same for every run and BGE-M3 costs a load (ticket #199).
// `live-lane.ts` holds the composition all three live lanes make.
const embedder = await liveEmbedder();
try {
  for (let run = 1; run <= runs; run += 1) {
    const result = await runExtractionPrecisionEval({
      db,
      executionPool,
      harness,
      embedder,
      model,
      ...(effort === undefined ? {} : { effort }),
      transcripts,
      // Throwaway, and shared by every run in this invocation — see above.
      // Scored by nobody and verified by nothing; minting it here is what
      // keeps it out of a real chain.
      hmacKey,
    });
    if (result.chatsRead !== transcripts.length) {
      fail(
        `run ${run} read ${result.chatsRead} of ${transcripts.length} chats — the days did not land, so there is nothing to report`,
      );
    }
    observed.push(
      result.crossings.map((crossing) => ({
        transcriptId: crossing.transcriptId,
        messageId: crossing.messageId,
        factType: crossing.factType,
        date: probeDate(crossing.factType, crossing.payload),
      })),
    );
    console.log(`run ${run}/${runs} done (${result.crossings.length} crossing(s))`);
  }
} finally {
  await db.end();
  await executionPool.end();
  await closeMeter();
}

const table = tallyDayProbe(DAY_PROBE_CASES, expected, observed);
const held = probeHeld(DAY_PROBE_CASES, table, runs);

console.log("");
console.log(
  "THE PER-DAY PROBE — does a weekday land on the day the label states (#148)",
);
console.log(`  model            ${model}`);
console.log(`  effort           ${effort ?? "(the model's own default)"}`);
console.log(`  runs             ${runs}`);
console.log(`  corpus digest    ${corpusDigest(SEED_TRANSCRIPTS)}`);
console.log(
  `  days             ${transcripts.map((t) => t.id).join(", ")}`,
);
console.log("");
console.log(
  "  case                                          want        right undated wrong absent   answered with",
);
for (const probeCase of DAY_PROBE_CASES) {
  const key = dayCaseKey(probeCase);
  const cell = table[key]!;
  console.log(
    `  ${key.padEnd(44)}  ${expected[key]}  ${String(cell.right).padStart(5)} ${String(cell.undated).padStart(7)} ${String(cell.wrong).padStart(5)} ${String(cell.absent).padStart(6)}   ${cell.answered.length === 0 ? "—" : cell.answered.join(" ")}`,
  );
}
console.log("");
for (const probeCase of DAY_PROBE_CASES) {
  console.log(`  ${dayCaseKey(probeCase)}\n      ${probeCase.exercises}`);
}
console.log("");
// THE RULE, PRINTED RATHER THAN LEFT TO THE READER. Every weekday case
// right in every run; `undated` counts as held only on H1's «para el
// domingo», which #139 measured as sometimes dated and never wrong. An
// `absent` never holds: a fact that did not cross was not answered.
// A VERDICT NEEDS THE RUNS THE RULE IS STATED OVER (Codex r2). The rule
// is "every weekday case right in ALL THREE runs"; with fewer, one
// favourable stochastic result would print HELD and an anecdote would
// become shipping evidence. Fewer runs is still a useful diagnostic, so
// the table is printed either way — what is withheld is the verdict.
const RUNS_THE_RULE_NEEDS = 3;
console.log(
  runs < RUNS_THE_RULE_NEEDS
    ? `  NO VERDICT — ${runs} run(s) is a diagnostic, not the rule, which is stated over ${RUNS_THE_RULE_NEEDS}. The table above stands; HELD/NOT HELD is deliberately not printed`
    : held
      ? `  PROBE HELD — every case answered its label's day in all ${runs} run(s) (undated allowed on H1-01 alone)`
      : `  PROBE NOT HELD — at least one case missed its label's day, or never crossed, in at least one of the ${runs} run(s)`,
);
console.log(
  "  HALF THE RULE    the ticket's other half — «does not regress corpus precision below the worst",
);
console.log(
  "                   Haiku run» — is the PRECISION lane's to answer, and is not reported here.",
);
console.log(
  "  NOT A GATE       this lane reports; the decision is taken from both tables, not announced by either",
);
console.log("");
console.log(renderMeter(model, effort, calls));
console.log(
  `\nelapsed: ${Math.round((Date.now() - startedAt) / 1000)}s over ${runs} run(s) of ${transcripts.length} chat-day(s)`,
);
