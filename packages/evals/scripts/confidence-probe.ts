/**
 * THE #57 PROBE LANE (ticket #66, the diagnosis half).
 *
 *   pnpm --filter @dito/evals eval:probe
 *
 * Runs the two #57 messages through the SAME extraction path the corpus
 * uses — the same Postgres seam, the same aperture, the same gate — and
 * prints what the extractor proposed about each: the fact type, the
 * confidence, and which side of the gate it fell on. Nothing is scored and
 * nothing is asserted.
 *
 * WHY A SEPARATE LANE RATHER THAN TWO MORE CORPUS DAYS. The precision
 * number is denominated in `SEED_TRANSCRIPTS`, whose digest is checked
 * into `reports/extraction-precision.json`. Adding two days would move
 * both, and a diagnosis that changed the measurement it was diagnosing
 * would be worth nothing. This lane writes its own artifact and leaves
 * the corpus alone.
 *
 * IT IS LIVE-ONLY, AND IT HAS TO BE. Scripting the model would mean
 * writing down the confidence the probe exists to observe — the answer,
 * supplied as the question. There is no scripted counterpart and there
 * should not be one; what the integration lane pins is that the harness
 * carries a confidence at all (`extraction-precision.int.test.ts`), and
 * what this lane observes is the number a real extractor actually emits.
 *
 * Its guards are `live-lane.ts`'s, shared with the precision lane rather
 * than copied from it: a database whose name ENDS in `_test`, no
 * `DITO_ALLOW_DB_RESET` override, because a corpus run against the rig's
 * database would destroy a rep's day.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
// THE GATE COMES FROM THE PACKAGE, not from the aperture's source: this is
// the same constant `scoring.ts` reads, and reaching past the package
// boundary for it would load it a second time from a second tree — the
// mirror image of the mistake `extraction-precision.ts`'s ONE TREE note
// describes, and the way a report ends up naming a threshold the run did
// not use.
import { EXTRACTION_CONFIDENCE_THRESHOLD, FACT_TYPES } from "@dito/aperture";
import { BATCH_LANE_CAP, DEFAULT_MAX_TOKENS } from "@dito/twin-runtime";
// ...while the corpus and the seam-driving harness come from SOURCE, for
// the reason that note gives: `src/testing` is never built, so a script
// that took one half from `dist` would be running two copies of the other.
import { distributionOf, gradedCrossings } from "../src/confidence.ts";
import {
  classifyProbeOutcome,
  probeMismatches,
  PROBE_EXPECTATIONS,
  PROBE_MESSAGES,
  PROBE_TRANSCRIPTS,
} from "../src/corpus/probes.ts";
import { renderPassCounts, renderRetries } from "../src/report.ts";
import { runExtractionPrecisionEval } from "../src/testing/harness.ts";
import { resetAndMigrate } from "../../seam/src/testing/db.ts";
import { liveEmbedder, requireLiveLane } from "./live-lane.ts";

const { dbUrl, apiKey, model, effort } = requireLiveLane("the #57 probe lane");
// The lanes must not drift (`live-lane.ts`): a knob one honours and
// another silently ignores is protection that is not there (#148).
const out =
  process.env["DITO_PROBE_REPORT"] ??
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../reports/confidence-probe.json",
  );

await resetAndMigrate();
const db = new pg.Client({ connectionString: dbUrl });
// Where each extraction execution borrows its own connection (#194): an
// execution holds its transaction open across the model call while the pass
// goes on enumerating on `db`, so the two may not share a client.
const executionPool = new pg.Pool({
  connectionString: dbUrl,
  max: BATCH_LANE_CAP,
});
await db.connect();

// The SDK child's own directory for this lane, thrown away at the end
// (#328): a live lane has no twin bundle to sit beside.
const harnessDirectory = mkdtempSync(join(tmpdir(), "dito-probe-harness-"));
const startedAt = new Date();
try {
  const run = await runExtractionPrecisionEval({
    db,
    executionPool,
    harness: { directory: harnessDirectory, apiKey },
    // THE SAME COMPOSITION EVERY LIVE LANE MAKES (ticket #199). The pass
    // searches the rep's own history before it files, so it needs an
    // embedder; `live-lane.ts` holds the one all three lanes use, because a
    // boundary one lane composes differently is one whose number describes a
    // different system.
    embedder: await liveEmbedder(),
    model,
    ...(effort === undefined ? {} : { effort }),
    transcripts: PROBE_TRANSCRIPTS,
    hmacKey: randomBytes(32),
    // A LIVE LANE, so it says out loud when it re-asks a chat whose call
    // ended without the tool (ticket #146).
    announce: (notice) => console.error(notice),
  });

  if (run.chatsRead !== PROBE_TRANSCRIPTS.length) {
    console.error(
      `the pass read ${run.chatsRead} of ${PROBE_TRANSCRIPTS.length} probe chats — nothing to observe`,
    );
    process.exit(1);
  }

  // WHAT THE EXTRACTOR PROPOSED ABOUT THE PROBE MESSAGE — and, separately,
  // about the rest of its day.
  //
  // FILTERED TO THE PROBE MESSAGE, not to the day (Codex r2). Probe 1
  // deliberately carries a real quote and an accepted order before P1-05,
  // because «súmale unas 20 más» means nothing without the twenty it adds
  // to. So a day-level count can be non-zero while the probe sentence
  // itself produced nothing, and reading "the day proposed something" as
  // "the probe was read" would answer #66's third hypothesis with another
  // message's evidence.
  //
  // WHAT STILL CANNOT BE ATTRIBUTED, said rather than papered over: a
  // REFUSED candidate reaches no store and `extraction_runs` counts
  // refusals per CHAT-DAY, so when the probe message produced nothing and
  // the day refused something, the lane cannot tell which message that
  // refusal belonged to. It says so instead of guessing. Closing that gap
  // needs message-level candidate outcomes out of the extraction pass,
  // which is a different ticket's file.
  const observations = PROBE_TRANSCRIPTS.map((transcript) => {
    const probeMessageId = PROBE_MESSAGES[transcript.id]!;
    const ofDay = {
      crossed: run.crossings.filter((c) => c.transcriptId === transcript.id),
      dropped: run.dropped.filter((d) => d.transcriptId === transcript.id),
    };
    const probeCrossed = ofDay.crossed
      .filter((c) => c.messageId === probeMessageId)
      .map((c) => ({
        factType: c.factType,
        confidence: c.confidence,
        payload: c.payload,
        disclosureText: c.disclosureText,
      }));
    const probeDropped = ofDay.dropped
      .filter((d) => d.messageId === probeMessageId)
      .map((d) => ({
        factType: d.factType,
        confidence: d.confidence,
        // HOW THE MODEL READ THE MESSAGE (Codex r1). Without it the artifact
        // cannot tell the reading route #66 added from the confidence gate
        // that was already there, so a probe passing would not mean the fix
        // fired.
        reading: d.reading,
      }));
    const pass = run.passCountsByTranscript[transcript.id]!;
    const expected = PROBE_EXPECTATIONS[transcript.id];
    const dayDropped = ofDay.dropped.map((d) => ({
      factType: d.factType,
      reading: d.reading,
    }));
    const outcome = classifyProbeOutcome({
      citingProbe: probeCrossed.length,
      droppedProbe: probeDropped.length,
      dayCandidates: pass.candidates,
      dayRefusals: pass.refused,
      otherStoredInDay:
        ofDay.crossed.length +
        ofDay.dropped.length -
        probeCrossed.length -
        probeDropped.length,
    });
    return {
      transcriptId: transcript.id,
      exercises: transcript.exercises,
      probeMessageId,
      probeText:
        transcript.messages.find((m) => m.id === probeMessageId)?.text ?? "",
      pass,
      probe: {
        crossed: probeCrossed,
        dropped: probeDropped,
        // What the run may CONCLUDE about this sentence — see
        // `classifyProbeOutcome`, which is where the reasoning lives and
        // where it is tested. It claims silence only when the whole day
        // proposed nothing, because `message_id` is model-supplied and a
        // refusal is attributed to no message at all.
        outcome,
        // ...and how it differs from what #66's fix half decided it should
        // produce, so a run that has quietly stopped working says so
        // rather than printing numbers nobody compares to anything. The
        // comparison itself lives in `probes.ts`, where it is unit-tested.
        expected,
        mismatches:
          expected === undefined
            ? []
            : probeMismatches(expected, {
                outcome,
                crossed: probeCrossed,
                dropped: probeDropped,
                // THE WHOLE DAY, not only the rows citing the probe
                // (Codex r3): `message_id` is the model's own, so two of
                // the rules have to be day-scoped or a neighbouring
                // citation walks straight past them.
                day: {
                  crossed: ofDay.crossed.length,
                  dropped: dayDropped,
                },
              }),
      },
      // The rest of the day, kept so a reader can see the context the
      // probe sentence sits in rather than only the sentence.
      elsewhereInDay: {
        crossed: ofDay.crossed
          .filter((c) => c.messageId !== probeMessageId)
          .map((c) => ({
            messageId: c.messageId,
            factType: c.factType,
            confidence: c.confidence,
            disclosureText: c.disclosureText,
          })),
        dropped: ofDay.dropped
          .filter((d) => d.messageId !== probeMessageId)
          .map((d) => ({
            messageId: d.messageId,
            factType: d.factType,
            confidence: d.confidence,
          })),
      },
    };
  });

  // Every candidate the aperture graded, with NO verdict attached — see
  // the note on `confidence` below.
  const observedBand = distributionOf({
    candidates: [
      ...gradedCrossings(
        run.crossings.map((c) => ({ ...c, correct: undefined })),
      ),
      ...run.dropped.map((d) => ({
        factType: d.factType,
        confidence: d.confidence,
        crossed: false,
        correct: undefined,
      })),
    ],
    gate: EXTRACTION_CONFIDENCE_THRESHOLD,
    factTypes: FACT_TYPES,
    ungradedCrossings: run.crossings.filter((c) => c.confidence === null).length,
  });

  const doc = {
    ranAt: startedAt.toISOString(),
    model,
    // WHAT THE MODEL WAS ASKED FOR, not only which model (ticket #148,
    // AC 3). This lane honours the effort knob, so its artifact has to say
    // which arm produced it — the terminal line scrolls away and the file
    // is what somebody reads back. Spread so an unset effort leaves NO
    // key: absent means the model's own default, which is a real arm.
    ...(effort === undefined ? {} : { effort }),
    maxTokens: DEFAULT_MAX_TOKENS,
    gate: EXTRACTION_CONFIDENCE_THRESHOLD,
    // The pass's own account, summed over both probe days. `candidates`
    // minus `filed` minus `belowThreshold` is what neither store holds.
    pass: run.passCounts,
    // WHAT THIS OBSERVATION COST IN RE-ASKS (ticket #146, Codex r1). The
    // probe drives the same harness as the precision lane, so it inherits
    // the retry — and an artifact that inherited the retry without
    // inheriting the count would be exactly the quiet selection #146
    // exists to end, one lane over. An observation that took two tries is
    // still an observation; it just has to say so.
    retries: run.retries,
    // THE PROBES' OWN BAND, so the two cases can be placed against a
    // distribution rather than merely listed. A band over two days, not
    // the corpus's — the corpus band is the other lane's artifact, named
    // below — but it puts these confidences on the same axis as the gate.
    //
    // CORRECTNESS IS WITHHELD, and that is not a detail (Codex r1). Probe
    // days carry no labels, so the SCORER calls every crossing a false
    // positive; publishing `run.report.confidence` would fill a `wrong`
    // population with every candidate of both days and call it a
    // measurement, in a lane whose whole claim is that it scores nothing.
    // So the band is rebuilt here with every candidate's correctness
    // UNDEFINED, which is the truth: nothing here was judged.
    confidence: observedBand,
    observations,
  };

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`, "utf8");

  console.log("THE #57 PROBES — what the extractor proposed, and how sure it was");
  console.log(`  model            ${model}`);
  console.log(`  effort           ${effort ?? "(the model's own default)"}`);
  console.log(
    `  gate             ${EXTRACTION_CONFIDENCE_THRESHOLD} — recorded, not proposed; this lane changes nothing`,
  );
  console.log(`  the pass saw     ${renderPassCounts(run.passCounts)}`);
  console.log(`  retries          ${renderRetries(run.retries)}`);
  console.log(
    `  probe band       ${observedBand.overall.graded.n} graded candidate(s), ${observedBand.inMiddleBand} in [${observedBand.middleBand.from} – ${observedBand.middleBand.to}) — observed, never scored`,
  );
  for (const observation of observations) {
    console.log("");
    console.log(`  ${observation.transcriptId}`);
    console.log(
      `    the probe:  ${observation.probeMessageId} «${observation.probeText}»`,
    );
    console.log(`    the day:    ${renderPassCounts(observation.pass)}`);
    for (const crossing of observation.probe.crossed) {
      console.log(
        `    FILED    ${crossing.factType} @ ${crossing.confidence} — «${crossing.disclosureText}»`,
      );
    }
    for (const drop of observation.probe.dropped) {
      console.log(
        `    DROPPED  ${drop.factType} @ ${drop.confidence}, read as ${drop.reading} — below the gate, so no fact, no question and no line (#218)`,
      );
    }
    if (observation.probe.outcome === "day_proposed_nothing") {
      console.log(
        "    THE DAY PROPOSED NOTHING — no candidate anywhere in it, so none about this sentence. Silence is not a low confidence; it is the absence of a data point.",
      );
    }
    if (observation.probe.outcome === "nothing_attributed_to_probe") {
      console.log(
        `    NOTHING CITES THIS MESSAGE, but the day proposed ${observation.pass.candidates} candidate(s) and refused ${observation.pass.refused} — UNATTRIBUTABLE. The citation is the model's own and refusals name no message, so whether this sentence was read and misfiled, read and refused, or never read is not recorded anywhere.`,
      );
    }
    const expected = observation.probe.expected;
    if (expected !== undefined) {
      if (observation.probe.mismatches.length === 0) {
        const required = expected.requires;
        console.log(
          required === undefined
            ? `    AS EXPECTED — #66's fix half decided this sentence must never claim ${expected.neverClaims.join(", ")}${expected.neverDropped ? " and must never be stopped by the gate" : ""}, and it was not`
            : `    AS EXPECTED — #66's fix half decided this sentence should be ${required.outcome} as a ${required.factType}${required.reading === undefined ? "" : ` read as ${required.reading}`}`,
        );
      } else {
        for (const mismatch of observation.probe.mismatches) {
          console.log(`    REGRESSION — ${mismatch}`);
        }
      }
    }
    const elsewhere =
      observation.elsewhereInDay.crossed.length +
      observation.elsewhereInDay.dropped.length;
    if (elsewhere > 0) {
      console.log(
        `    (${elsewhere} other candidate(s) in this day, from the context the probe sentence needs — see the JSON)`,
      );
    }
  }
  console.log(`\nprobe report written to ${out}`);
  console.log(
    "the CORPUS band these sit against is reports/extraction-precision.json — `pnpm --filter @dito/evals eval:extraction` refreshes it, and both lanes must be run on the same model to be compared",
  );

  // A NAMED CASE WITH A DECIDED ANSWER FAILS LOUDLY (Codex r1). The
  // precision lane deliberately exits 0 on a low number — that number
  // gates nothing (#56 AC 6) and failing on it would be a flaky gate on a
  // measurement. These two are not a measurement: they are the two
  // sentences #57 reported and #66 decided an answer for, so a run where
  // one of them stops behaving is a result somebody has to look at rather
  // than a line that scrolled past.
  const regressed = observations.filter(
    (observation) => observation.probe.mismatches.length > 0,
  );
  if (regressed.length > 0) {
    console.error(
      `\n${regressed.length} probe(s) no longer behave the way #66's fix half decided: ${regressed.map((r) => r.transcriptId).join(", ")}`,
    );
    process.exitCode = 1;
  }
} finally {
  await db.end();
  await executionPool.end();
  rmSync(harnessDirectory, { recursive: true, force: true });
}
