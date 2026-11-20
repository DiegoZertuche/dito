/**
 * THE LIVE EXTRACTION-PRECISION LANE (ticket #56 ACs 3, 4 and 6).
 *
 * A `smoke:live`-style lane, in the shape the live Anthropic and BGE-M3
 * smokes already have: the REAL model, run by hand or by a CI job that has
 * a key, against a real Postgres and real crypto. The scripted client stays
 * in the integration lanes, where `extraction-precision.int.test.ts`
 * exercises this same harness on every push so it cannot silently stop
 * working.
 *
 *   pnpm --filter @dito/evals eval:extraction
 *
 * needs `ANTHROPIC_API_KEY` and a `DITO_TEST_DATABASE_URL` it may WIPE — a
 * database whose name ENDS in `_test`, which this script checks itself and
 * more strictly than the seam's own guard does. It resets the seam, and a
 * corpus run against the rig's database would destroy a rep's day.
 *
 * ZDR (#15) IS NOT IN THE WAY, and the reason is worth stating rather than
 * assumed: the corpus is SYNTHETIC, authored in this repo, and contains no
 * real person's messages. #15's condition — "ZDR precedes any other
 * person's content" — is about the rig's traffic, not about fixtures we
 * wrote. The live drafting smoke made the same call on rig-shaped data.
 *
 * WHAT IT PRINTS IS NOT A VERDICT. The number does not gate this slice
 * (AC 6): Test 4 gates the flag flip, on pilot data. The runner exits 0 on
 * a low number and non-zero only when it could not MEASURE — no key, no
 * database, a corpus that failed to land. Reporting a number is the job;
 * tuning the extractor until the number is pretty is the failure.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { BATCH_LANE_CAP } from "@dito/twin-runtime";
// AND THE LANE BUILDS FIRST (ticket #148, Codex r1). Everything below
// comes from source, but `@dito/twin-runtime` does not: its package entry
// is `dist/`, which is gitignored and can be older than the tree. A lane
// run without a build therefore measures a runtime nobody is looking at
// and writes the number into a CHECKED-IN artifact — and no digest here
// would catch it, since the automation's digest covers the instructions and
// the submission schema and explicitly not the pass around them. So `eval:*`
// runs
// `pnpm -w build` first; thirty seconds against a ten-minute lane.
//
// ONE TREE, and it has to be. The rig scripts import their package's
// `dist`, but this one cannot: the seam-driving harness is `src/testing`
// plumbing and is never built, and it imports `scoring.ts` and `corpus.ts`
// — so a script that took the REPORT from `dist` and the RUN from `src`
// would load `PRECISION_BAR` and `EXCLUDED_FACT_TYPES` twice, from two
// trees, and a stale `dist` would print a bar and an exclusion list that
// never scored the run. Everything comes from source.
//
// `.ts` extensions because `--experimental-strip-types` resolves what is
// written rather than remapping a `.js` specifier onto a `.ts` file.
import { corpusDigest } from "../src/corpus.ts";
import { buildReport, renderReport, type BeforeSide } from "../src/report.ts";
import { LOOKING_TRANSCRIPTS } from "../src/corpus/looking.ts";
import {
  ALL_TRANSCRIPTS,
  SEED_TRANSCRIPTS,
} from "../src/corpus/transcripts.ts";
import { runExtractionPrecisionEval } from "../src/testing/harness.ts";
import { resetAndMigrate } from "../../seam/src/testing/db.ts";
import { liveEmbedder, requireLiveLane } from "./live-lane.ts";
import { meteredHarness, renderMeter } from "./metering.ts";

const { dbUrl, apiKey, model, effort } = requireLiveLane("the extraction-precision lane");
// CHECKED IN, deliberately (AC 6: "the number is recorded at the slice
// boundary"). The report lives in git, so a re-run shows up as a DIFF that
// somebody has to look at rather than as a line in a terminal that scrolled
// away — and the labels it was scored against are in the same tree, one
// directory up.
//
// `reports/` HOLDS SEVEN EXTRACTION FILES, and this is where they are
// explained (tickets #59, #139, #148, #194, #218 and #364). The seventh,
// `extraction-precision-before-364.json`, is this run's own BEFORE side and is
// argued at `BEFORE_364` below, where it is read.
//
// `extraction-precision-before-6a.json` is FROZEN and was #218's before: the
// same extractor as the report beside it, so what moved across that pair was
// the aperture alone. #364 ENDED IT — the extractor itself moved — and
// `report.test.ts` asserts the ending rather than describing it.
//
// `extraction-precision-before-5b.json` is FROZEN and carries the harness's
// own stamp over these labels and this model, so what moved across the pair
// it belonged to (ticket #199) was the runtime under the extractor. It is NOT
// this run's before (ticket #218): reading the current report against it
// would put two changes inside one comparison, which is the unreadable pair
// #83 taught this corpus to refuse. `report.test.ts` asserts that rather than
// describing it, and nothing rewrites the file.
//
// `extraction-precision.json` is the CURRENT number: rewritten by this
// script and bound to the corpus by `report.test.ts`'s digest assertion.
//
// `extraction-precision-before-139.json` is FROZEN and is a LIVE pair with
// the current report: the SAME corpus this tree has, the same model, and —
// since #139's prompt paragraph was pulled on the owner's ruling — the
// SAME prompt. What differs is the beat rendering, which no digest here
// covers, so the two files carry one extractor digest and two numbers.
// `report.test.ts` asserts those properties rather than describing them,
// which is what stops the pair decaying the silent way the #59 one below
// did, and states there that the pair RECORDS the difference and cannot
// bind it. Remake it the way it was made: check out the pre-#139 renderer
// against the corpus in the tree, run this script with `DITO_EVAL_REPORT`
// pointed at the file, and put the tree back.
//
// `extraction-precision-before-148.json` is FROZEN and is the BEST-
// CONTROLLED pair in this directory: a `claude-haiku-4-5` run of the
// corpus in this tree, taken on #148's own branch — after `max_tokens`
// was raised to 16,000 and the runner capped at one iteration — against
// the byte-identical prompt. So it and the current report differ in ONE
// variable, the model, which neither of the pairs below can say. The
// MEDIAN of that arm's three runs by precision is what is frozen (87.2 /
// 83.8 / 87.1 — the 87.1): whole-corpus precision is noisy, and freezing
// the best run would flatter the switch while the worst would oversell
// it. All three, and the probe that actually decided the ticket, are
// recorded on #148.
//
// #148 ALSO ENDED THE #139 PAIR, in the way #83 ended #59's. That pair
// held the corpus, the model and the prompt still so the difference was
// the renderer; extraction has since moved to Sonnet 5, so reading it
// against the current report would mix a model change into a rendering
// result. `report.test.ts` asserts that ending rather than describing it.
//
// `extraction-precision-before-59.json` is FROZEN and nothing rewrites it.
// It is #59's before-side: the extraction prompt as it stood at
// `origin/main` before that ticket, scored against #59's corpus. A precision
// claim is a claim about a DIFFERENCE, and a difference is only readable
// when one side of it is held still — #59 changed the corpus and the
// extractor together, so a before/after across two corpora would have mixed
// a grading change into an extractor result and been unreadable. This file
// is what separated them.
//
// ITS PARTNER IS GONE (ticket #83). The digests used to match, and that was
// the point; #83's ruling relabelled four messages, so this file and the
// current report no longer share a corpus and reading them side by side
// would commit the very error the pair was frozen to avoid.
// `report.test.ts` says so rather than asserting a sameness that ended.
// #59's own before/after is still verifiable from the two digests recorded
// on that issue and the commits carrying them. Regenerate this file only by
// checking out the old prompt against the corpus in the tree, and delete it
// once the comparison stops being the one anybody wants.
const reports = resolve(dirname(fileURLToPath(import.meta.url)), "../reports");
const out =
  process.env["DITO_EVAL_REPORT"] ??
  resolve(reports, "extraction-precision.json");

/**
 * `extraction-precision-before-364.json` IS THE BEFORE, AND IT IS READ RATHER
 * THAN RESTATED (ticket #364; spec #193 decisions 6 and 30; ADR-0028 as
 * amended).
 *
 * FROZEN THE WAY #218's WAS: the committed report, copied as it stood when
 * this branch opened. The labels, the model and the ceiling are the same on
 * both sides and the EXTRACTOR is not — #364 made the day's read a run of
 * Dito's extraction, one child per chat-day filing through `file_facts` — so
 * the pair is a claim about that move, and what else is between the two
 * figures is the live model's run-to-run variation.
 *
 * Read off the file so the comparison in the artifact is a claim about
 * another artifact somebody can open, and `buildReport` refuses the pair if
 * the two sides were scored against different labels or on different models.
 */
const BEFORE_364 = "extraction-precision-before-364.json";

const frozen = JSON.parse(
  readFileSync(resolve(reports, BEFORE_364), "utf8"),
) as {
  readonly extractorDigest: string;
  readonly model: string;
  readonly corpus: {
    readonly digest: string;
    /** Present on any report frozen after #199 widened the corpus. */
    readonly originalDigest?: string;
  };
  readonly overall: BeforeSide["overall"];
  readonly overallClusterInterval: BeforeSide["overallClusterInterval"];
};
const before: BeforeSide = {
  report: BEFORE_364,
  extractorDigest: frozen.extractorDigest,
  // THE ORIGINAL LABELS' DIGEST, WHICHEVER FIELD THE FILE KEEPS IT IN
  // (ticket #218). The pair's key is the days both sides share, and
  // `buildReport` refuses a pair whose before was scored against anything
  // else. A before frozen BEFORE #199 has one digest and it is the original
  // labels'; a before frozen after it — like this one — carries the widened
  // corpus in `digest` and the original labels in `originalDigest`, so
  // reading `digest` would hand the pair a key over 38 days while the after
  // is read over 34.
  corpusDigest: frozen.corpus.originalDigest ?? frozen.corpus.digest,
  model: frozen.model,
  overall: frozen.overall,
  overallClusterInterval: frozen.overallClusterInterval,
};

await resetAndMigrate();
// TIMED AND COUNTED (ticket #148). Its usage totals are what the run's cost
// is summed from, and its per-call rows are the LATENCY of one round.
//
// A ROUND IS NOT A CHAT-DAY ANY MORE, and the distinction is this ticket's
// (#199). A chat-day's read is six rounds at most, so a day that searches
// before it files costs several requests and a day that files straight off
// costs two — which is exactly what looking is being measured for. What a
// CHAT-DAY cost is on the report's own `cost` block, attributed off the
// runner's trace; the meter below is the money and the wire.
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

const startedAt = new Date();
try {
  const run = await runExtractionPrecisionEval({
    db,
    executionPool,
    harness,
    // THE WEIGHTS THE RIG LOADS (ticket #199). The corpus now holds history
    // for a search to find, so which embedder runs decides whether the
    // number describes retrieval anybody ships — see `liveEmbedder`.
    embedder: await liveEmbedder(),
    model,
    ...(effort === undefined ? {} : { effort }),
    transcripts: SEED_TRANSCRIPTS,
    // SEEDED AND READ WITH THE REST, SCORED APART (spec #193 decision 11).
    // A cross-chat reference only resolves if the referent's customer is a
    // chat of the same rep, so one pass covers both slices — and the overall
    // number stays over the ORIGINAL labels, which is what makes the pair a
    // claim about the extractor rather than about a corpus that grew.
    looking: LOOKING_TRANSCRIPTS,
    // A LIVE LANE, so it says out loud when it re-asks a chat whose call
    // ended without the tool (ticket #146) — while it is happening, not
    // only in the report afterwards. An exhausted run throws before any
    // report is written, and these lines are then the only account of it.
    announce: (notice) => console.error(notice),
    // The binding ceremony that seeds each chat files an entity create,
    // which is a class-2 rep act and is audit-chained (ADR-0020). A
    // throwaway key: this run's chain is scored by nobody and verified by
    // nothing, and minting one here is what keeps it out of a real chain.
    hmacKey: randomBytes(32),
  });

  if (run.chatsRead !== ALL_TRANSCRIPTS.length) {
    // A corpus that half-landed would score as though it had all landed.
    console.error(
      `the pass read ${run.chatsRead} of ${ALL_TRANSCRIPTS.length} chats — the corpus did not land, so there is nothing to report`,
    );
    process.exit(1);
  }

  const doc = buildReport({
    report: run.report,
    // The four looking days' own row, and the before this run is read
    // against — see `BEFORE_364` and the document's own fields.
    looking: run.looking,
    // ...and the gate's own row, over every chat the run read — the same
    // population `pass` below is counted over (ticket #218).
    droppedBelowGate: run.droppedBelowGate,
    before,
    cost: run.cost,
    model,
    // WHAT THE MODEL WAS ASKED FOR, not only which model (#148 AC 3).
    // Taken off the RUN rather than off this script's variables, so the
    // artifact records what the requests actually carried.
    ...(run.effort === undefined ? {} : { effort: run.effort }),
    maxTokens: run.maxTokens,
    ranAt: startedAt,
    corpus: {
      transcripts: ALL_TRANSCRIPTS.length,
      messages: ALL_TRANSCRIPTS.reduce((n, t) => n + t.messages.length, 0),
      labels: ALL_TRANSCRIPTS.reduce((n, t) => n + t.labels.length, 0),
      digest: corpusDigest(ALL_TRANSCRIPTS),
      // WHAT THE PAIR IS OVER, beside what the run covered (ticket #199).
      // The looking days are new material, so the widened digest cannot be
      // the pair's key; these are the thirty-four days the frozen before was
      // scored against, unchanged.
      originalDigest: corpusDigest(SEED_TRANSCRIPTS),
    },
    // What the pass PROPOSED, not only what reached a store (ticket #66).
    // The confidence band cannot see a refused candidate or a message the
    // extractor said nothing about, and both are outcomes #66 asks about.
    pass: run.passCounts,
    // WHAT THE RUN HAD TO ASK TWICE (ticket #146). Before it, a call that
    // ended without the tool killed the run and the lane was rerun by hand
    // — so every number in `reports/` came from a run that happened to go
    // smoothly, and no file said so. It does now.
    retries: run.retries,
  });

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`, "utf8");

  console.log(renderReport(doc));
  console.log(`\nreport written to ${out}`);
  console.log(`\n${renderMeter(model, effort, calls)}`);
  // TWO KINDS OF RETRY, AND A READER MUST NOT ADD THEM UP (tickets #146 and
  // #148). The meter's own RETRIES row counts NON-200 responses the SDK
  // retried underneath us — a transport fact. This counts EXECUTIONS the
  // model answered, with a 200, that ended without filing through `file_facts`
  // and so had to be asked again. Every round of every one of them is inside
  // the meter's answered-call total above, which is why that count and the
  // corpus size come apart at all; this line says by how much and why.
  console.log(
    `  NO-TOOL RE-ASKS   ${run.retries.total} — ${ALL_TRANSCRIPTS.length} chat(s) needed ${ALL_TRANSCRIPTS.length + run.retries.total} chat-day read(s) (#146), each of up to six rounds. Named per day in the report`,
  );
} finally {
  await db.end();
  await executionPool.end();
  await closeMeter();
}
