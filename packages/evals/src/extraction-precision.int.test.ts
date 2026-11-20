/**
 * THE EVAL HARNESS ITSELF, AT THE SEAM (ticket #56 ACs 2 and 7).
 *
 * The live lane needs an API key, so it cannot run on every push. What CAN
 * run on every push — and does, in CI's eval stage — is the whole pipeline
 * with the model SCRIPTED: a labeled transcript goes in as `wa_events`,
 * `runDailyExtraction` reads it, the APERTURE'S GATE decides fact or drop,
 * and the scorer reads the number back out of the Ledger and the drops off
 * the run's own submissions (ticket #218). Everything except the model is
 * identical to the live run.
 *
 * That is what stops the lane silently rotting. A harness whose only
 * exercise was a manual run with a key would break the day someone changed
 * `readFiledFacts`, and nobody would find out until the next steering
 * session.
 *
 * What is pinned here is the harness's CONTRACT, not the extractor's
 * quality — the quality number is the live lane's, and it has no
 * deterministic value to assert:
 *
 * 1. A scripted-perfect run scores 1.0, so the labels and the aperture's
 *    NORMALIZATION actually agree. This is the test that catches a label
 *    written against the model's wire format instead of the stored payload
 *    — an RFC labeled `riv850612-h23` rather than `RIV850612H23`.
 * 2. A scripted-wrong run scores 0, with the false positive named. A
 *    scorer that could not go red would certify anything.
 * 3. A BELOW-THRESHOLD candidate is a QUESTION and is NOT in the
 *    denominator. This is AC 2's whole claim — the gate is inside the
 *    system under test — and it is the one property a harness wrapped
 *    around `runExtractionHarness` could not have had.
 * 4. A fact filed against a message no label names is a false positive,
 *    end to end. The `CustomerPattern`-shaped day is the fixture, because
 *    that is the crossing whose cost is a breach rather than a wrong
 *    number.
 *
 * Real Postgres, real SQLCipher, real envelope crypto (ADR-0028).
 */
import { randomBytes } from "node:crypto";
import { EXTRACTION_CONFIDENCE_THRESHOLD } from "@dito/aperture";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LOOKING_TRANSCRIPTS } from "./corpus/looking.ts";
import { SEED_TRANSCRIPTS } from "./corpus/transcripts.ts";
import { BATCH_LANE_CAP } from "@dito/twin-runtime";
import { runExtractionPrecisionEval } from "./testing/harness.ts";
import { NO_TOOL_RETRY_LIMIT } from "./testing/pass-retry.ts";
import {
  resetAndMigrate,
  TEST_DATABASE_URL,
} from "../../seam/src/testing/db.ts";
import { fakeEmbedder } from "../../twin-runtime/src/testing/fake-embedder.ts";
import {
  closeScriptedModels,
  extractionTurns,
  scriptedModel,
  toolResultsOf,
} from "../../twin-runtime/src/testing/scripted-model.ts";

// Every scripted model this suite opened is closed with it (#328).
afterAll(closeScriptedModels);

let db: pg.Client;
/**
 * Where each extraction execution borrows its own connection (#173, #194).
 *
 * An execution holds its transaction open across the model call while the
 * pass goes on enumerating on `db`, so the two may not share a client
 * (`lanes.ts` argues it in full). Sized from the batch lane's cap, which is
 * what bounds how many are ever in flight.
 */
let executionPool: pg.Pool;

// No reset here: every `it` below resets before it seeds, because each one
// is a whole corpus run and two runs must not see each other's rows. A
// reset in `beforeAll` as well would be dead the moment the first `it`
// starts.
beforeAll(async () => {
  db = new pg.Client({ connectionString: TEST_DATABASE_URL });
  executionPool = new pg.Pool({
    connectionString: TEST_DATABASE_URL,
    max: BATCH_LANE_CAP,
  });
  await db.connect();
});

afterAll(async () => {
  await db.end();
  await executionPool.end();
});


/**
 * One scripted submission per chat — the shared wire (ticket #194).
 *
 * IT MOVED TO `@dito/scripted-model`, where the suites that script this tool
 * read one copy. The turn COUNT changed with the automation's eight-round
 * budget: the runner serves the submission's tool result and asks again, so
 * a run is two turns and a one-turn script would hand its only turn to the
 * NEXT chat.
 */
const submits = extractionTurns;

const byId = (id: string) => SEED_TRANSCRIPTS.find((t) => t.id === id)!;

/** A quote, an order and a dated promise — the plainest labeled day. */
const PLAIN = byId("q-cotizacion-directa");
/** Three identifiers, all of which the aperture normalizes on the way in. */
const CONTACT = byId("c-contacto-completo");
/** The rep's own tactics, in a customer chat. Nothing may cross. */
const TACTICS = byId("n-tácticas-del-rep");
/**
 * A customer stating a regularity about the REP, twice, beside one about
 * themselves (ticket #61). The authorship fence cannot separate these —
 * all three are the customer's own messages — so this is the day where a
 * `CustomerPattern` false positive is a WALL BREACH rather than a wrong
 * number, and the day the per-type row has to be able to show it.
 */
const JUDGMENTS = byId("p-juicios-sobre-el-rep");
/**
 * A rep's own selling tactic in the first message, and two real customer
 * constraints after it (ticket #61). Codex round 3's finding lives here:
 * the two positive labels pinned only what must SURVIVE, so a clause
 * carrying the constraint AND the tactic scored correct with no paraphrase
 * at all.
 */
const CONDITIONS = byId("p-condiciones-medina");
/**
 * A day said two rep days before the corpus day, carried into this pass by
 * an unread window (ticket #139) — the one corpus shape whose beats are
 * not on the day the pass is keyed to.
 */
const CARRIED_IN = byId("d-lunes-desde-el-domingo");

const HMAC = randomBytes(32);

/**
 * THE EMBEDDER THIS LANE COMPOSES: the integration suites' deterministic
 * fake (ticket #199; ADR-0028).
 *
 * A hashed bag-of-words unit vector, so what a search finds follows word
 * overlap and is exactly assertable with no model in the loop — and CI
 * downloads no weights. The live lane composes BGE-M3 instead
 * (`liveEmbedder`), which is a composition choice at the edge and never a
 * code path.
 */
const EMBEDDER = fakeEmbedder();

describe("the corpus drives the same Postgres seam (AC 2)", () => {
  it("a perfect extraction scores 1.0 — the labels and the aperture's normalization agree", async () => {
    await resetAndMigrate();
    const run = await runExtractionPrecisionEval({
      db,
      executionPool,
      harness: scriptedModel(
        submits(
          {
            fact_type: "QuoteGiven",
            message_id: "Q1-04",
            confidence: 0.95,
            item: "cemento gris",
            quantity: 40,
            unit: "bultos",
            amount: 8200,
            currency: "MXN",
          },
          {
            fact_type: "OrderRequested",
            message_id: "Q1-05",
            confidence: 0.93,
            item: "cemento gris",
            quantity: 40,
            unit: "bultos",
          },
          {
            fact_type: "DatePromised",
            message_id: "Q1-06",
            confidence: 0.94,
            commitment: "que se los tienes el viernes",
            due_on: "2026-09-04",
          },
          {
            // The rep's own «listo» answering the ask — the second half of
            // the split (#71), read in the rep's message and quoting the
            // words that agreed.
            fact_type: "OrderTaken",
            message_id: "Q1-06",
            confidence: 0.93,
            item: "cemento gris",
            quantity: 40,
            unit: "bultos",
            amount: 8200,
            currency: "MXN",
          },
        ),
      ).harness,
      embedder: EMBEDDER,
      model: "scripted",
      transcripts: [PLAIN],
      hmacKey: HMAC,
    });

    expect(run.chatsRead).toBe(1);
    expect(run.report.overall.crossed).toBe(4);
    expect(run.report.overall.precision).toBe(1);
    expect(run.report.wrong).toEqual([]);
    expect(run.report.byFactType["QuoteGiven"]!.correct).toBe(1);
    expect(run.report.byFactType["OrderRequested"]!.correct).toBe(1);
    expect(run.report.byFactType["OrderTaken"]!.correct).toBe(1);
    expect(run.report.byFactType["DatePromised"]!.correct).toBe(1);
    // Every label crossed, so recall is 1 — reported, and not the bar.
    expect(run.report.recall).toBe(1);
  });

  it("identifier labels are the NORMALIZED forms, which only a seam run can prove", async () => {
    // The RFC arrives lowercase with a hyphen, the email mixed-case, the
    // phone with spaces and no country code. The corpus labels the E.164,
    // the lowercased email and the uppercased RFC — which is what the
    // merge ladder keys on (ADR-0035) — so this test fails the moment a
    // label is written against what the model said instead of what the
    // aperture stored.
    await resetAndMigrate();
    const run = await runExtractionPrecisionEval({
      db,
      executionPool,
      harness: scriptedModel(
        submits({
          fact_type: "ContactEstablished",
          message_id: "C1-02",
          confidence: 0.96,
          contact_name: "Compras",
          rfcs: ["riv850612-h23"],
          emails: ["Facturas@Rivas.MX"],
          phones: ["81 1234 5678"],
        }),
      ).harness,
      embedder: EMBEDDER,
      model: "scripted",
      transcripts: [CONTACT],
      hmacKey: HMAC,
    });

    expect(run.report.overall.crossed).toBe(1);
    expect(run.report.overall.precision).toBe(1);
  });
});

describe("the scorer can go red, end to end", () => {
  it("a fact filed on a message NO label names is a false positive — the breach case", async () => {
    // The rep's own selling tactic, filed as a fact about the customer.
    // This is what the corpus's `n-*` days exist for, and the cost of it
    // crossing is a judgment about the rep reaching the rep's employer.
    await resetAndMigrate();
    const run = await runExtractionPrecisionEval({
      db,
      executionPool,
      harness: scriptedModel(
        submits({
          fact_type: "QuoteGiven",
          message_id: "N2-01",
          confidence: 0.99,
          item: "precio alto primero",
          amount: 1,
          currency: "MXN",
        }),
      ).harness,
      embedder: EMBEDDER,
      model: "scripted",
      transcripts: [TACTICS],
      hmacKey: HMAC,
    });

    expect(run.report.overall.crossed).toBe(1);
    expect(run.report.overall.precision).toBe(0);
    expect(run.report.wrong).toHaveLength(1);
    expect(run.report.wrong[0]!.reason).toBe("no_label_for_message");
    expect(run.report.wrong[0]!.messageId).toBe("N2-01");
    // The report carries what the REP would have been told, which is the
    // sentence a reviewer actually judges.
    expect(run.report.wrong[0]!.disclosureText.length).toBeGreaterThan(0);
  });

  /**
   * `CustomerPattern` IS REPORTED APART, AND THAT IS THE POINT OF IT
   * (ticket #61; the obligation the corpus's old exclusion entry left
   * behind, in its own words: "its own reported number beside the others,
   * never folded in").
   *
   * A wrong `QuoteGiven` is a wrong number in a record the rep can correct.
   * A wrong `CustomerPattern` is the rep's employer reading a judgment
   * about the rep, and no correction unreads it. Averaging the two reports
   * one reassuring figure over a recoverable error and an unrecoverable
   * one — so the test is not "the per-type map has a key", it is that a
   * breach is VISIBLE while the overall number still looks healthy.
   */
  it("a CustomerPattern breach shows in its own row while the overall number stays healthy", async () => {
    await resetAndMigrate();
    const run = await runExtractionPrecisionEval({
      db,
      executionPool,
      harness: scriptedModel([
        // Four correct crossings on the plain day...
        ...submits(
          {
            fact_type: "QuoteGiven",
            message_id: "Q1-04",
            confidence: 0.95,
            item: "cemento gris",
            quantity: 40,
            unit: "bultos",
            amount: 8200,
            currency: "MXN",
          },
          {
            fact_type: "OrderRequested",
            message_id: "Q1-05",
            confidence: 0.93,
            item: "cemento gris",
            quantity: 40,
            unit: "bultos",
          },
          {
            fact_type: "DatePromised",
            message_id: "Q1-06",
            confidence: 0.94,
            commitment: "que se los tienes el viernes",
            due_on: "2026-09-04",
          },
          {
            fact_type: "OrderTaken",
            message_id: "Q1-06",
            confidence: 0.93,
            item: "cemento gris",
            quantity: 40,
            unit: "bultos",
            amount: 8200,
            currency: "MXN",
          },
        ),
        // ...and on the next chat, one right pattern and one BREACH: the
        // customer's «usted siempre se tarda en entregar» read as a fact
        // about the customer. It is counterparty-authored, so the fence
        // passes it; it is confident, so #66 says no gate underneath
        // catches it; and it crosses.
        ...submits(
          {
            fact_type: "CustomerPattern",
            message_id: "PC-04",
            confidence: 0.94,
            pattern:
              "solo trabaja con proveedores que le den crédito a 30 días",
          },
          {
            fact_type: "CustomerPattern",
            message_id: "PC-01",
            confidence: 0.97,
            pattern: "siempre se tarda en entregar",
          },
        ),
      ]).harness,
      embedder: EMBEDDER,
      model: "scripted",
      transcripts: [PLAIN, JUDGMENTS],
      hmacKey: HMAC,
    });

    // The overall figure is the one that would hide it: five of six right.
    expect(run.report.overall.crossed).toBe(6);
    expect(run.report.overall.precision).toBeCloseTo(5 / 6, 5);
    expect(run.report.overall.precision).toBeGreaterThan(0.8);

    // The row that refuses to hide it.
    const cell = run.report.byFactType["CustomerPattern"]!;
    expect(cell.crossed).toBe(2);
    expect(cell.correct).toBe(1);
    expect(cell.precision).toBe(0.5);

    // ...and the breach is named, with the sentence the rep's employer
    // would have read.
    const breach = run.report.wrong.find((w) => w.messageId === "PC-01")!;
    expect(breach.factType).toBe("CustomerPattern");
    expect(breach.reason).toBe("misattributed");
    // The sentence the rep's employer would have read — the twin's own
    // clause, which is all this type stores (ADR-0040), and which is
    // nonetheless a judgment about the rep.
    expect(breach.disclosureText).toBe(
      "Te dijo que siempre se tarda en entregar.",
    );

    // Every other type is untouched: the average is what lies, not the rows.
    expect(run.report.byFactType["QuoteGiven"]!.precision).toBe(1);
    expect(run.report.byFactType["OrderTaken"]!.precision).toBe(1);
  });

  /**
   * THE OTHER SHAPE OF THE SAME BREACH (Codex round 2): the clause itself.
   *
   * Round 1 killed the automatic leak — the payload no longer copies the
   * customer's message — but `pattern` is still model prose, and a model
   * can write a judgment about the rep into its own claim. The message this
   * is read in is `PC-04`, which genuinely states a customer constraint, so
   * the authorship fence passes it, the label exists, and the positive
   * token is there. Only the label's `lacks` pins stop it scoring correct.
   *
   * That is the corpus doing the job the ticket assigns it — "the aperture
   * test is enforced, not assumed" — and it is also where the residual
   * lives: `lacks` is a substring search, so a paraphrase of the same
   * judgment walks past it, and closing THAT means grading the whole
   * proposition semantically. Named in `corpus.ts` beside the predicate.
   */
  it("a CustomerPattern clause that carries a judgment about the rep scores WRONG, on the right message", async () => {
    await resetAndMigrate();
    const run = await runExtractionPrecisionEval({
      db,
      executionPool,
      harness: scriptedModel(
        submits({
          fact_type: "CustomerPattern",
          message_id: "PC-04",
          confidence: 0.96,
          // The customer's real constraint, plus the day's own complaint
          // about the rep, in one clause the model composed.
          pattern:
            "solo trabaja con proveedores que le den crédito a 30 días, aunque el rep siempre se tarda en entregar",
        }),
      ).harness,
      embedder: EMBEDDER,
      model: "scripted",
      transcripts: [JUDGMENTS],
      hmacKey: HMAC,
    });

    expect(run.report.overall.crossed).toBe(1);
    expect(run.report.byFactType["CustomerPattern"]!.precision).toBe(0);
    expect(run.report.wrong).toHaveLength(1);
    expect(run.report.wrong[0]!.reason).toBe("check_failed");
    expect(run.report.wrong[0]!.detail).toContain("should NOT contain");
    // ...and the same clause without the judgment is correct, so the check
    // is grading the leak rather than the label.
    await resetAndMigrate();
    const clean = await runExtractionPrecisionEval({
      db,
      executionPool,
      harness: scriptedModel(
        submits({
          fact_type: "CustomerPattern",
          message_id: "PC-04",
          confidence: 0.96,
          pattern: "solo trabaja con proveedores que le den crédito a 30 días",
        }),
      ).harness,
      embedder: EMBEDDER,
      model: "scripted",
      transcripts: [JUDGMENTS],
      hmacKey: HMAC,
    });
    expect(clean.report.byFactType["CustomerPattern"]!.precision).toBe(1);
  });

  it("a clause that carries the day's REP TACTIC along with a real constraint scores WRONG (#61, Codex r3)", async () => {
    // No paraphrase, no invented text: the tactic is PF-01's own sentence,
    // copied into a claim read on PF-04 — a message that really does state
    // a customer constraint, so the authorship fence passes it and the
    // label exists. Before this ticket's round-3 fix the pinned token
    // «mañana» was present and the crossing scored CORRECT, leaving the
    // `CustomerPattern` row at 100% over a rep tactic on its way to the
    // rep's employer.
    await resetAndMigrate();
    const run = await runExtractionPrecisionEval({
      db,
      executionPool,
      harness: scriptedModel(
        submits({
          fact_type: "CustomerPattern",
          message_id: "PF-04",
          confidence: 0.95,
          pattern:
            "solo recibe por la mañana; este cliente siempre regatea, hay que dejarle margen",
        }),
      ).harness,
      embedder: EMBEDDER,
      model: "scripted",
      transcripts: [CONDITIONS],
      hmacKey: HMAC,
    });

    expect(run.report.overall.crossed).toBe(1);
    expect(run.report.byFactType["CustomerPattern"]!.precision).toBe(0);
    expect(run.report.wrong[0]!.reason).toBe("check_failed");
    expect(run.report.wrong[0]!.detail).toContain("should NOT contain");
  });

  it("a wrong VALUE on a labeled message is a false positive, and the check is named", async () => {
    await resetAndMigrate();
    const run = await runExtractionPrecisionEval({
      db,
      executionPool,
      harness: scriptedModel(
        submits({
          fact_type: "QuoteGiven",
          message_id: "Q1-04",
          confidence: 0.95,
          item: "cemento gris",
          quantity: 40,
          // The transcript says 8,200. This is the digit-transposition
          // failure a precision number exists to count.
          amount: 8020,
          currency: "MXN",
        }),
      ).harness,
      embedder: EMBEDDER,
      model: "scripted",
      transcripts: [PLAIN],
      hmacKey: HMAC,
    });

    expect(run.report.overall.precision).toBe(0);
    expect(run.report.wrong[0]!.reason).toBe("check_failed");
    expect(run.report.wrong[0]!.detail).toContain("amount");
  });
});

describe("the confidence gate is INSIDE the system under test (AC 2)", () => {
  it("a below-threshold candidate is DROPPED and never enters the denominator", async () => {
    await resetAndMigrate();
    const run = await runExtractionPrecisionEval({
      db,
      executionPool,
      harness: scriptedModel(
        submits(
          {
            fact_type: "QuoteGiven",
            message_id: "Q1-04",
            confidence: 0.95,
            item: "cemento gris",
            quantity: 40,
            unit: "bultos",
            amount: 8200,
            currency: "MXN",
          },
          {
            // Below the gate: this is the reading the twin is unsure of.
            fact_type: "OrderRequested",
            message_id: "Q1-05",
            confidence: EXTRACTION_CONFIDENCE_THRESHOLD - 0.2,
            item: "cemento gris",
            quantity: 40,
          },
        ),
      ).harness,
      embedder: EMBEDDER,
      model: "scripted",
      transcripts: [PLAIN],
      hmacKey: HMAC,
    });

    // ONE crossing, not two — the gate STOPPED the second (ticket #218).
    expect(run.report.overall.crossed).toBe(1);
    expect(run.report.overall.precision).toBe(1);
    // ...and the row names it, with the answer sheet's verdict on it: Q1-05
    // is a labelled `OrderRequested`, so this drop IS the recall loss.
    expect(run.droppedBelowGate).toEqual({
      candidates: [
        {
          transcriptId: PLAIN.id,
          messageId: "Q1-05",
          factType: "OrderRequested",
          confidence: EXTRACTION_CONFIDENCE_THRESHOLD - 0.2,
          reading: "stated",
          labelled: true,
        },
      ],
      total: 1,
      labelled: 1,
    });
    // ...and the APERTURE agrees about how many, which is what makes the
    // workings above readable rather than a second opinion.
    expect(run.passCounts.belowThreshold).toBe(1);
    // And it cost RECALL rather than precision, which is exactly the trade
    // FR-31 makes: four labels, one crossing.
    expect(run.report.recall).toBeCloseTo(1 / 4, 10);
  });

  it("a below-threshold candidate that would have been WRONG costs nothing at all", async () => {
    // The gate's whole value, measured: an uncertain misreading that never
    // crossed is not a precision failure. A harness scoring the model's
    // output rather than the Ledger's would have counted it as one.
    await resetAndMigrate();
    const run = await runExtractionPrecisionEval({
      db,
      executionPool,
      harness: scriptedModel(
        submits({
          fact_type: "QuoteGiven",
          message_id: "N2-01",
          confidence: EXTRACTION_CONFIDENCE_THRESHOLD - 0.3,
          item: "precio alto primero",
          amount: 1,
          currency: "MXN",
        }),
      ).harness,
      embedder: EMBEDDER,
      model: "scripted",
      transcripts: [TACTICS],
      hmacKey: HMAC,
    });

    expect(run.report.overall.crossed).toBe(0);
    expect(run.report.overall.precision).toBeUndefined();
    expect(run.droppedBelowGate.total).toBe(1);
    // AND IT COST NO RECALL EITHER: this corpus labels no `QuoteGiven` on
    // N2-01, so the drop is unlabelled — the gate stopped a misreading.
    expect(run.droppedBelowGate.labelled).toBe(0);
  });
});

/**
 * THE CONFIDENCE BAND, END TO END (ticket #66).
 *
 * The unit tests pin the arithmetic. What only a seam run can prove is that
 * the number the SCRIPT emitted is the number the report describes — that
 * it survived the aperture's gate, a `numeric(4,3)` column, `pg`'s
 * string-typed numerics and the walk back out through `readFiledFacts`.
 *
 * Every expected value here is the literal the script wrote in, which is an
 * independent source of truth: the assertion cannot agree with a broken
 * implementation, because it never asks the implementation what it stored.
 */
describe("confidence reaches the report through the real seam (#66)", () => {
  it("a crossing carries the confidence the model claimed, off the Ledger row", async () => {
    await resetAndMigrate();
    const run = await runExtractionPrecisionEval({
      db,
      executionPool,
      harness: scriptedModel(
        submits({
          fact_type: "QuoteGiven",
          message_id: "Q1-04",
          // Three decimals, which is exactly what `numeric(4, 3)` holds —
          // a value that would be visibly mangled by a float round-trip or
          // by pg's string numerics reaching the report unparsed.
          confidence: 0.873,
          item: "cemento gris",
          quantity: 40,
          amount: 8200,
          currency: "MXN",
        }),
      ).harness,
      embedder: EMBEDDER,
      model: "scripted",
      transcripts: [PLAIN],
      hmacKey: HMAC,
    });

    expect(run.crossings[0]!.confidence).toBe(0.873);
    expect(run.report.confidence.overall.filed.distinct).toEqual([
      { value: 0.873, n: 1 },
    ]);
    // ...and under its own fact type, which is what AC 1 asks the
    // distribution to be broken down by.
    expect(
      run.report.confidence.byFactType["QuoteGiven"]!.graded.median,
    ).toBe(0.873);
  });

  it("a QUESTIONED candidate's confidence comes back too — the below-gate half", async () => {
    // The half #66 reports as empty in three rig runs. It is the only
    // direct evidence of what the extractor emits when it is unsure, so a
    // report that could not read it could not tell a mis-set threshold
    // apart from an emitter that never hedges.
    await resetAndMigrate();
    const run = await runExtractionPrecisionEval({
      db,
      executionPool,
      harness: scriptedModel(
        // On `Q1-06`, the REP's «listo, se los tengo el viernes …», which
        // is the message the corpus labels `OrderTaken` — an agreement is
        // read in the rep's own words or refused outright, and a refusal
        // is never a question (#71), so a wrong-side candidate could not
        // carry a confidence back here at all.
        submits({
          fact_type: "OrderTaken",
          message_id: "Q1-06",
          confidence: 0.42,
          item: "cemento gris",
          quantity: 40,
        }),
      ).harness,
      embedder: EMBEDDER,
      model: "scripted",
      transcripts: [PLAIN],
      hmacKey: HMAC,
    });

    expect(run.report.overall.crossed).toBe(0);
    expect(run.dropped[0]).toMatchObject({
      messageId: "Q1-06",
      factType: "OrderTaken",
      confidence: 0.42,
    });
    expect(run.report.confidence.overall.dropped.distinct).toEqual([
      { value: 0.42, n: 1 },
    ]);
    expect(run.report.confidence.overall.filed.n).toBe(0);
  });

  it("counts what the PASS saw, so a day that proposed NOTHING is visible", async () => {
    // #66's second case produced zero candidates. Silence is not a low
    // confidence — it is the absence of a data point, and a distribution
    // built only from what reached a store cannot see it at all. The pass's
    // own per-chat counts can.
    await resetAndMigrate();
    const run = await runExtractionPrecisionEval({
      db,
      executionPool,
      harness: scriptedModel(submits()).harness,
      embedder: EMBEDDER,
      model: "scripted",
      transcripts: [PLAIN],
      hmacKey: HMAC,
    });

    expect(run.passCounts).toEqual({
      messages: PLAIN.messages.length,
      candidates: 0,
      filed: 0,
      belowThreshold: 0,
      unresolvedReference: 0,
      resolvedReference: 0,
      refused: 0,
    });
    expect(run.report.confidence.overall.graded.n).toBe(0);
  });

  it("tells SILENCE apart from a refusal, per chat-day (#57's two cases)", async () => {
    // THE DISTINCTION THE WHOLE PROBE LANE RESTS ON (Codex r1). A refused
    // candidate reaches no store at all, so a day that proposed something
    // and had it refused looks EXACTLY like a day that proposed nothing —
    // unless the counts are read per chat-day.
    // Reporting a refusal as "the extractor said nothing" would answer
    // #66's third hypothesis with the wrong evidence.
    await resetAndMigrate();
    const run = await runExtractionPrecisionEval({
      db,
      executionPool,
      harness: scriptedModel([
        // Chat 1 (PLAIN): one candidate, refused — it cites a message this
        // transcript does not contain, so no seam row resolves.
        ...submits({
          fact_type: "QuoteGiven",
          message_id: "Q1-99",
          confidence: 0.95,
          item: "cemento gris",
          amount: 8200,
          currency: "MXN",
        }),
        // Chat 2 (TACTICS): the model proposed nothing at all.
        ...submits(),
      ]).harness,
      embedder: EMBEDDER,
      model: "scripted",
      transcripts: [PLAIN, TACTICS],
      hmacKey: HMAC,
    });

    expect(run.passCountsByTranscript["q-cotizacion-directa"]).toMatchObject({
      candidates: 1,
      filed: 0,
      belowThreshold: 0,
      unresolvedReference: 0,
      refused: 1,
    });
    expect(run.passCountsByTranscript["n-tácticas-del-rep"]).toMatchObject({
      candidates: 0,
      refused: 0,
    });
    // The totals still agree with the parts — one number, two readings.
    expect(run.passCounts.candidates).toBe(1);
    expect(run.passCounts.refused).toBe(1);
  });

  it("...and counts a candidate the APERTURE refused, which reaches no store at all", async () => {
    // A refusal reaches no store, and it is not in the submission's own
    // below-gate half either — so a confidence distribution read from the
    // Ledger and the drops alone silently loses it.
    await resetAndMigrate();
    const run = await runExtractionPrecisionEval({
      db,
      executionPool,
      harness: scriptedModel(
        submits({
          fact_type: "QuoteGiven",
          // No such message in this transcript: the pass cannot resolve a
          // seam row for it, so nothing is filed and nothing is asked.
          message_id: "Q1-99",
          confidence: 0.95,
          item: "cemento gris",
          amount: 8200,
          currency: "MXN",
        }),
      ).harness,
      embedder: EMBEDDER,
      model: "scripted",
      transcripts: [PLAIN],
      hmacKey: HMAC,
    });

    expect(run.passCounts.candidates).toBe(1);
    expect(run.passCounts.refused).toBe(1);
    expect(run.passCounts.filed).toBe(0);
    expect(run.report.confidence.overall.graded.n).toBe(0);
  });
});

describe("the walk from a Ledger row to its transcript line is stored rows (AC 4)", () => {
  it("every crossing names the transcript and the message it was read in", async () => {
    await resetAndMigrate();
    const run = await runExtractionPrecisionEval({
      db,
      executionPool,
      harness: scriptedModel(
        submits({
          fact_type: "DatePromised",
          message_id: "Q1-06",
          confidence: 0.9,
          commitment: "que se los tienes el viernes",
          due_on: "2026-09-04",
        }),
      ).harness,
      embedder: EMBEDDER,
      model: "scripted",
      transcripts: [PLAIN],
      hmacKey: HMAC,
    });

    expect(run.crossings).toHaveLength(1);
    expect(run.crossings[0]).toMatchObject({
      transcriptId: "q-cotizacion-directa",
      messageId: "Q1-06",
      factType: "DatePromised",
    });
    // No model and no heuristic in that walk: fact → its disclosure line's
    // `source_event_id` → the seam row this run inserted.
    expect(run.crossings[0]!.factId).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it("runs several transcripts in one pass, and never mixes their labels up", async () => {
    await resetAndMigrate();
    const run = await runExtractionPrecisionEval({
      db,
      executionPool,
      harness: scriptedModel([
        // Chat 1 (PLAIN): correct.
        ...submits({
          fact_type: "QuoteGiven",
          message_id: "Q1-04",
          confidence: 0.95,
          item: "cemento",
          quantity: 40,
          amount: 8200,
          currency: "MXN",
        }),
        // Chat 2 (TACTICS): a breach. A QuoteGiven, because N2-01 is the
        // rep's own message and every label on that day is a silence — so
        // this crosses and scores wrong, which is what the test is about.
        ...submits({
          fact_type: "QuoteGiven",
          message_id: "N2-01",
          confidence: 0.99,
          item: "precio alto",
          quantity: 1,
        }),
      ]).harness,
      embedder: EMBEDDER,
      model: "scripted",
      transcripts: [PLAIN, TACTICS],
      hmacKey: HMAC,
    });

    expect(run.chatsRead).toBe(2);
    expect(run.report.overall.crossed).toBe(2);
    expect(run.report.overall.correct).toBe(1);
    expect(run.report.overall.precision).toBe(0.5);
    expect(run.report.wrong[0]!.transcriptId).toBe("n-tácticas-del-rep");
  });

  /**
   * A DAY THE CHAT HAS OWED SINCE AN EARLIER REP DAY (ticket #139).
   *
   * The lane drives one pass on one rep day, so until now every message in
   * the corpus was said on that day and no case could be said on another
   * weekday at all. A chat may OWE its extraction, though — a run that
   * claimed it and died leaves the window unread — and `owedFromDaysAgo`
   * declares exactly that, through the pass's own `owedFrom` watermark.
   *
   * The claim is that those beats REACH the model and are scored. A case
   * seeded two days back and silently cut out of the window would look
   * like a day that stated nothing, while the report went on counting its
   * messages — the same quiet loss `LAST_READABLE_MINUTE` exists to refuse
   * at the other end of the day.
   */
  it("reads a day carried in from an earlier rep day, and scores it", async () => {
    await resetAndMigrate();
    const run = await runExtractionPrecisionEval({
      db,
      executionPool,
      harness: scriptedModel(
        submits({
          fact_type: "OrderRequested",
          message_id: "H2-01",
          confidence: 0.95,
          item: "rollos de alambre recocido",
          quantity: 25,
          // The wire field for a commercial fact's `requestedFor` is
          // `due_on` — the day the customer asked for, on their own ask.
          due_on: "2026-08-31",
        }),
      ).harness,
      embedder: EMBEDDER,
      model: "scripted",
      transcripts: [CARRIED_IN],
      hmacKey: HMAC,
    });

    expect(run.chatsRead).toBe(1);
    // Both messages seeded two days back were read — not zero, which is
    // what a window that never opened would have produced.
    expect(run.passCounts.messages).toBe(2);
    expect(run.report.overall).toMatchObject({ crossed: 1, correct: 1 });
  });
});

/**
 * A MODEL CALL THAT ENDED WITHOUT THE TOOL IS RETRIED (ticket #146).
 *
 * It happened three times in one #139 session: one chat's call came back
 * as plain text, `runExtractionHarness` threw, and the WHOLE run died —
 * every other chat's number with it. Each time the lane was rerun by hand
 * and only the surviving runs were counted, which quietly biases every
 * number this lane has ever reported: the days that cost a retry are
 * exactly the ones that dropped out of the average.
 *
 * The retry is the LANE'S, not the pass's. What production does when a
 * model ends a run without submitting is a different question and is not
 * this ticket's; here the point is to MEASURE the corpus, and a
 * measurement that silently discards its hard draws is not one.
 *
 * A PLAIN-TEXT ENDING IS SCRIPTED AS A `text` TURN, which is all the wire
 * shape is: `stop_reason: "end_turn"` with no `tool_use` block. That is
 * the same thing the live model did.
 */
describe("a model call that ends without the tool is retried (#146)", () => {
  it("retries the chat, completes the run, counts the retry and names the chat", async () => {
    await resetAndMigrate();
    // The live lanes hand this `console.error`; a suite hands it a
    // collector, so what an operator would have read is assertable.
    const announced: string[] = [];
    {
      const run = await runExtractionPrecisionEval({
        db,
        executionPool,
        announce: (notice) => announced.push(notice),
        harness: scriptedModel([
          // The failure, exactly: the model talks and never calls the tool,
          // and the execution ends there.
          { text: "Listo, no hay nada que reportar." },
          // ...and the retry submits, so the day is scored rather than lost.
          ...submits({
            fact_type: "QuoteGiven",
            message_id: "Q1-04",
            confidence: 0.95,
            item: "cemento gris",
            quantity: 40,
            unit: "bultos",
            amount: 8200,
            currency: "MXN",
          }),
        ]).harness,
        embedder: EMBEDDER,
        model: "scripted",
        transcripts: [PLAIN],
        hmacKey: HMAC,
      });

      // THE RUN COMPLETED — the day was read and scored, not dropped.
      expect(run.chatsRead).toBe(1);
      expect(run.report.overall).toMatchObject({ crossed: 1, correct: 1 });
      // ...and it SAYS it cost a retry, which is the whole point: a number
      // that needed one is not the same number as one that did not.
      expect(run.retries.total).toBe(1);
      expect(run.retries.byTranscript).toEqual({ "q-cotizacion-directa": 1 });
      // The chat id is in the notice, because "one call failed" is useless
      // to whoever has to look at the day it failed on.
      expect(announced).toHaveLength(1);
      expect(announced[0]).toMatch(/52155200000\d{6}@s\.whatsapp\.net/u);
    }
  });

  /**
   * THE ARITHMETIC A ONE-CHAT RUN CANNOT SEE (spec review).
   *
   * A chat the failed attempt already FILED drops out of the next
   * attempt's own `chats` count — its window is closed, which is the same
   * rule that stops it being re-read — so `chatsRead` is the chats filed
   * before the last attempt plus what that attempt counted. With one
   * transcript both halves are indistinguishable from the old
   * `result.chats`, and the live lane aborts on
   * `chatsRead !== SEED_TRANSCRIPTS.length`: an undercount there reports a
   * corpus that did not land, over a run that landed completely.
   */
  it("counts every chat it read, across the attempt that failed and the one that finished", async () => {
    await resetAndMigrate();
    const announced: string[] = [];
    const run = await runExtractionPrecisionEval({
      db,
      executionPool,
      announce: (notice) => announced.push(notice),
      harness: scriptedModel([
        // Chat 1 (PLAIN, the lower JID) files on the first attempt...
        ...submits({
          fact_type: "QuoteGiven",
          message_id: "Q1-04",
          confidence: 0.95,
          item: "cemento",
          quantity: 40,
          amount: 8200,
          currency: "MXN",
        }),
        // ...and chat 2 (TACTICS) ends in prose without submitting, so the
        // execution lands `failed` and its run settles `failed` (spec #193
        // decision 10). The pass does not throw — the lane moves on and the
        // call returns with one chat filed and one failed.
        { text: "Listo." },
        // The retry re-opens chat 2's failed run and re-asks it ONLY — chat
        // 1 is filed, so its window is closed and it costs no second model
        // call. A script that had to re-serve chat 1 here would run out of
        // turns.
        ...submits({
          fact_type: "QuoteGiven",
          message_id: "N2-01",
          confidence: 0.99,
          item: "precio alto",
          quantity: 1,
        }),
      ]).harness,
      embedder: EMBEDDER,
      model: "scripted",
      transcripts: [PLAIN, TACTICS],
      hmacKey: HMAC,
    });

    expect(run.chatsRead).toBe(2);
    expect(run.retries).toEqual({
      total: 1,
      byTranscript: { "n-tácticas-del-rep": 1 },
    });
    // Both days were scored: the one that went smoothly and the one that
    // had to be asked twice.
    expect(run.report.overall.crossed).toBe(2);
    expect(run.report.overall.correct).toBe(1);
    expect(announced).toHaveLength(1);
  });

  it("keeps a re-asked attempt's refused filing out of the drop row (Codex r3)", async () => {
    // THE ROW DESCRIBES WHAT THE APERTURE GATED, NOT WHAT THE MODEL SAID.
    // The first attempt hands `file_facts` a wire the tool refuses — a
    // confidence that is not a number — and ends in prose, so its chat-day
    // settles `failed` and nothing reached the aperture. The lane re-asks it,
    // and the retry files the same fact ABOVE the gate. A collector that kept
    // the refused call's candidate would report a labelled drop that never
    // happened, and call it the recall the gate cost.
    await resetAndMigrate();
    const below = {
      fact_type: "QuoteGiven",
      message_id: "Q1-04",
      confidence: EXTRACTION_CONFIDENCE_THRESHOLD - 0.2,
      item: "cemento gris",
      quantity: 40,
      unit: "bultos",
      amount: 8200,
      currency: "MXN",
    };
    const [refusedCall] = submits({ ...below, confidence: "baja" });
    const run = await runExtractionPrecisionEval({
      db,
      executionPool,
      harness: scriptedModel([
        // Attempt 1: the refused filing, then prose.
        refusedCall!,
        { text: "listo" },
        // Attempt 2: the retry, above the gate, which files.
        ...submits({ ...below, confidence: 0.95 }),
      ]).harness,
      embedder: EMBEDDER,
      model: "scripted",
      transcripts: [PLAIN],
      hmacKey: HMAC,
    });

    // It cost a retry, and the retry filed.
    expect(run.retries.total).toBe(1);
    expect(run.report.overall).toMatchObject({ crossed: 1, correct: 1 });
    // THE GATE STOPPED NOTHING, and both counts say so — the aperture's own
    // and the workings'.
    expect(run.passCounts.belowThreshold).toBe(0);
    expect(run.droppedBelowGate).toEqual({
      candidates: [],
      total: 0,
      labelled: 0,
    });
  });

  it("fails the run loudly, naming the chat, once the retries are exhausted", async () => {
    await resetAndMigrate();
    const announced: string[] = [];
    // ONE MORE TURN THAN THE BOUND ALLOWS, deliberately: an unbounded
    // retry would consume it and fail on a fourth request with «scripted
    // model exhausted» instead, so the assertions below are a claim about
    // the BOUND and not merely about failing eventually. One turn per
    // attempt: the round that ends in prose.
    const scripted = scriptedModel([
      { text: "Listo." },
      { text: "Listo." },
      { text: "Listo." },
      { text: "Listo." },
    ]);
    {
      const failure = await runExtractionPrecisionEval({
        db,
        executionPool,
        announce: (notice) => announced.push(notice),
        harness: scripted.harness,
        embedder: EMBEDDER,
        model: "scripted",
        transcripts: [PLAIN],
        hmacKey: HMAC,
      }).then(
        () => undefined,
        (error: unknown) => error,
      );

      // IT THREW, which is what makes the script's exit non-zero exactly
      // as it was before this ticket: a run with a day it never read is
      // not a measurement of this corpus, and reporting a number over the
      // hole would be the bias #146 is about, arriving by another door.
      expect(failure).toBeInstanceOf(Error);
      const message = (failure as Error).message;
      expect(message).toMatch(/52155200000\d{6}@s\.whatsapp\.net/u);
      expect(message).toMatch(/retries exhausted/u);
      // ...and what the model actually did is on the RECORD rather than on
      // the error (tickets #194, #364): every attempt was a child run of the
      // day's extraction whose one step left an execution row and a chain
      // entry, and filed nothing.
      const attempts = await db.query<{ n: string }>(
        `SELECT count(*) AS n FROM runs r JOIN run_steps s ON s.run_id = r.id
          WHERE r.parent_run_id IS NOT NULL AND s.execution_id IS NOT NULL`,
      );
      expect(Number(attempts.rows[0]!.n)).toBe(NO_TOOL_RETRY_LIMIT + 1);
      // The first attempt plus its two retries, one model call each.
      expect(scripted.requests).toHaveLength(NO_TOOL_RETRY_LIMIT + 1);
      // Every re-ask was announced as it happened — an exhausted run
      // writes no report, so these lines are the only account of it.
      expect(announced).toHaveLength(NO_TOOL_RETRY_LIMIT);
    }
  });

  /*
   * WHY NOTHING HERE PINS "IT RETRIES THAT ENDING AND NOTHING ELSE".
   *
   * The lane re-asks EVERY chat-day settled `failed`, and that is the honest
   * reach of what it can see: the runtime settles a refused filing, a
   * truncated response and a read that would not finish under one word,
   * `failed`, with no reason column to tell them apart. What bounds the cost is
   * `NO_TOOL_RETRY_LIMIT` — two re-asks per chat and then the run fails
   * loudly, which the case above is what holds. A `code` on the execution
   * record is what would narrow it again, and it is recorded on #194 as
   * remainder rather than built here.
   */
});

/**
 * THE LOOKING CASES, DRIVEN AT THE SEAM (ticket #199; spec #193 decisions 2,
 * 11 and 12; ADR-0038, ADR-0039 as amended).
 *
 * The reads are REAL — a real bundle, a real vector store, the corpus's own
 * history, this run's own connection — and only the model's CALLS are
 * scripted, which is what makes a resolution a claim about the store rather
 * than about a fixture. Nothing here calls a model and nothing downloads
 * weights: the embedder is the deterministic fake, whose rankings follow word
 * overlap (ADR-0028).
 *
 * WHAT THIS ADDS OVER THE TWIN-RUNTIME SUITE, which pins the same three reads
 * over a hand-built twin: that the CORPUS's history is really in twin memory
 * and really reachable. Before this ticket it was not — the harness seeded the
 * seam and embedded nothing, so every search in the eval lane came back «No
 * message in the rep's history matched» (#206's remainder 5) and the lane
 * could measure the tools only by assuming them.
 */
const looking = (id: string) => LOOKING_TRANSCRIPTS.find((t) => t.id === id)!;

/** Exactly one referent, in this chat's own history: 300 bultos de cemento gris. */
const BACK_REFERENCE = looking("l-pedido-pasado-mismo-chat");
/** The same referent, in ANOTHER customer's conversation. */
const CROSS_CHAT = looking("l-referencia-a-otro-cliente");
/** Two referents that differ — 500 and 200 rollos — so nothing may be filed. */
const TWO_CANDIDATES = looking("l-dos-candidatos-distintos");
/**
 * A rep-only day whose reference names a price nothing carries, over a
 * history that holds yesterday's request. Both of ADR-0038's fences meet
 * here: nothing resolves, and nothing pairs across days.
 */
const NOTHING_TO_FIND = looking("l-referencia-a-nada");

/** What the resolution files: the goods the referent named, and nothing about it. */
const RESOLVED_ORDER = {
  fact_type: "OrderRequested",
  confidence: 0.95,
  reading: "resolved_reference",
  item: "bultos de cemento gris",
  quantity: 300,
};

/**
 * The iterations the ONE extraction execution of this run recorded.
 *
 * It asserts there is exactly one, which is the whole point: a caller uses it
 * to check the harness's trace-derived cost against the RECORD, and over two
 * executions the two numbers would agree by summing rather than by naming the
 * same run.
 */
async function soleExecutionIterations(client: pg.Client): Promise<number> {
  const res = await client.query<{ iterations: number }>(
    `SELECT e.iterations
       FROM executions e
       JOIN extraction_runs r ON r.execution_id = e.id
      ORDER BY e.started_at`,
  );
  expect(res.rows, "this run did not record exactly one extraction execution").toHaveLength(1);
  return res.rows[0]!.iterations;
}

describe("the looking cases drive the automation (#199)", () => {
  it("resolves a back-reference out of the corpus's own history, marks the line and counts it", async () => {
    await resetAndMigrate();
    const model = scriptedModel(
      extractionTurns({
        looks: [
          {
            tool: "search_chat_history",
            input: { about: "cemento gris pedido pasado", chat: null },
          },
        ],
        facts: [{ ...RESOLVED_ORDER, message_id: "LA-D1" }],
      }),
    );
    const run = await runExtractionPrecisionEval({
      db,
      executionPool,
      harness: model.harness,
      embedder: EMBEDDER,
      model: "scripted",
      transcripts: [],
      looking: [BACK_REFERENCE],
      hmacKey: HMAC,
    });

    // THE SEARCH REALLY READ THE CORPUS'S HISTORY. The referent is nowhere in
    // the day and nowhere in the twenty lines the model is shown, so this is
    // the only route to it — and the result comes back through the read's own
    // projection rather than out of the fixture.
    expect(toolResultsOf(model.requests[1]).join("\n")).toContain(
      "mándame 300 bultos de cemento gris",
    );
    // ...and the seam holds the DAY alone. EVERY history beat is checked, the
    // REFERENT first: it is the one whose seam row would give a candidate an
    // id to cite for the resolved goods, and a pattern that only matched the
    // filler would have missed exactly that (ADR-0038; spec review).
    const seeded = await db.query<{ external_event_id: string }>(
      "SELECT external_event_id FROM wa_events",
    );
    for (const beat of BACK_REFERENCE.history ?? []) {
      expect(
        seeded.rows.some((row) => row.external_event_id.endsWith(`:${beat.id}`)),
        `${beat.id} reached the seam — a history beat with a wa_events row has an id a candidate could cite`,
      ).toBe(false);
    }

    // The fact carries the goods it referred to and the mark that says so.
    expect(run.crossings).toHaveLength(1);
    expect(run.crossings[0]!.disclosureText).toContain("(por referencia)");
    expect(run.crossings[0]!.disclosureText).toContain("300 bultos");
    // Nothing about WHICH order or WHOSE chat (ADR-0004).
    expect(run.crossings[0]!.disclosureText).not.toContain("Ochoa");
    expect(run.crossings[0]!.disclosureText).not.toContain("pedido pasado");

    // The run row counts one resolution beside the fact it filed.
    expect(
      run.passCountsByTranscript["l-pedido-pasado-mismo-chat"],
    ).toMatchObject({
      candidates: 1,
      filed: 0 + 1,
      resolvedReference: 1,
      unresolvedReference: 0,
      refused: 0,
    });

    // The looking row scores it, and the ORIGINAL number is untouched — this
    // day is not in it, because the scorer was never shown it.
    expect(run.looking).toMatchObject({
      crossed: 1,
      correct: 1,
      precision: 1,
      leaks: 0,
      cases: [
        {
          transcriptId: "l-pedido-pasado-mismo-chat",
          outcome: "resolved-right",
          leaked: false,
        },
      ],
    });
    expect(run.report.overall.crossed).toBe(0);

    // WHAT IT COST, and the two sources agree. Three rounds is the script's
    // own shape — the search, the submission, and the round that ends in
    // prose — and one read is the price of looking, which is the number this
    // ticket exists to produce.
    const cost = run.cost.byTranscript["l-pedido-pasado-mismo-chat"]!;
    expect(cost).toMatchObject({ toolCalls: 2, reads: 1, iterations: 3 });
    expect(cost.iterations).toBe(await soleExecutionIterations(db));
    expect(run.cost.total.reads).toBe(1);
  });

  it("resolves a reference into ANOTHER customer's conversation, and the name never crosses", async () => {
    await resetAndMigrate();
    const model = scriptedModel([
      // Chat 1 (Ochoa, the lower JID): its own back-reference, so the
      // referent this run resolves across chats is really in the store.
      ...extractionTurns({
        looks: [
          {
            tool: "search_chat_history",
            input: { about: "cemento gris pedido pasado", chat: null },
          },
        ],
        facts: [{ ...RESOLVED_ORDER, message_id: "LA-D1" }],
      }),
      // Chat 2 (Zavala): find out who Ochoa is, then look for that order.
      ...extractionTurns({
        looks: [
          { tool: "list_chats", input: {} },
          {
            tool: "search_chat_history",
            input: { about: "cemento gris Ochoa", chat: null },
          },
        ],
        facts: [{ ...RESOLVED_ORDER, message_id: "LB-D1" }],
      }),
    ]);
    const run = await runExtractionPrecisionEval({
      db,
      executionPool,
      harness: model.harness,
      embedder: EMBEDDER,
      model: "scripted",
      transcripts: [],
      looking: [BACK_REFERENCE, CROSS_CHAT],
      hmacKey: HMAC,
    });

    // `list_chats` names both customers and carries no content — read off
    // what the tool SERVED rather than off the whole request body.
    const listed = toolResultsOf(model.requests[4]);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toContain("Ferretería Ochoa");
    expect(listed[0]).toContain("Bloquera Zavala");
    expect(listed[0]).not.toContain("cemento");
    // ...and the search reached the other conversation's order.
    expect(toolResultsOf(model.requests[5]).join("\n")).toContain(
      "mándame 300 bultos de cemento gris",
    );

    // Both days filed the goods, and neither line names the chat it was
    // resolved from (ADR-0004).
    expect(run.looking.crossed).toBe(2);
    expect(run.looking.correct).toBe(2);
    expect(run.looking.leaks).toBe(0);
    for (const crossing of run.crossings) {
      expect(crossing.disclosureText).toContain("(por referencia)");
      expect(crossing.disclosureText).not.toContain("Ochoa");
    }
    expect(run.passCountsByTranscript["l-referencia-a-otro-cliente"]).toMatchObject(
      { filed: 1, resolvedReference: 1 },
    );
    // Two reads on the cross-chat day, one on the other: the list and the
    // search are both the price of looking.
    expect(run.cost.byTranscript["l-referencia-a-otro-cliente"]!.reads).toBe(2);
    expect(run.cost.total.reads).toBe(3);
  });

  it("drops a reference with two differing referents — no fact, no question, a drop counted", async () => {
    await resetAndMigrate();
    const model = scriptedModel(
      extractionTurns({
        looks: [
          {
            tool: "search_chat_history",
            input: { about: "rollos de alambre recocido", chat: null },
          },
        ],
        facts: [
          {
            fact_type: "OrderRequested",
            message_id: "LC-D1",
            confidence: 0.95,
            reading: "unresolved_reference",
            item: "lo mismo de la vez pasada",
            quantity: null,
          },
        ],
      }),
    );
    const run = await runExtractionPrecisionEval({
      db,
      executionPool,
      harness: model.harness,
      embedder: EMBEDDER,
      model: "scripted",
      transcripts: [],
      looking: [TWO_CANDIDATES],
      hmacKey: HMAC,
    });

    // The search really returned BOTH, which is the fixture's own claim: the
    // case is about a choice the twin must not make, so both candidates have
    // to be in front of it.
    const served = toolResultsOf(model.requests[1]).join("\n");
    expect(served).toContain("500 rollos");
    expect(served).toContain("200 rollos");

    // No fact, no question, and the drop counted.
    expect(run.crossings).toEqual([]);
    expect(run.dropped).toEqual([]);
    expect(
      run.passCountsByTranscript["l-dos-candidatos-distintos"],
    ).toMatchObject({
      candidates: 1,
      filed: 0,
      belowThreshold: 0,
      unresolvedReference: 1,
      resolvedReference: 0,
    });
    expect(run.looking.cases).toEqual([
      {
        transcriptId: "l-dos-candidatos-distintos",
        outcome: "dropped",
        leaked: false,
      },
    ]);
  });

  it("drops a reference nothing in the history answers", async () => {
    await resetAndMigrate();
    const model = scriptedModel(
      extractionTurns({
        looks: [
          {
            tool: "search_chat_history",
            input: { about: "precio del pedido pasado", chat: null },
          },
        ],
        facts: [
          {
            fact_type: "QuoteGiven",
            message_id: "LD-D1",
            confidence: 0.95,
            reading: "unresolved_reference",
            item: "el mismo precio del pedido pasado",
          },
        ],
      }),
    );
    const run = await runExtractionPrecisionEval({
      db,
      executionPool,
      harness: model.harness,
      embedder: EMBEDDER,
      model: "scripted",
      transcripts: [],
      looking: [NOTHING_TO_FIND],
      hmacKey: HMAC,
    });

    // It DID look — the read is on the trace — and there was nothing to find,
    // so nothing is filed and nothing is asked.
    expect(run.cost.byTranscript["l-referencia-a-nada"]!.reads).toBe(1);
    expect(run.crossings).toEqual([]);
    expect(run.dropped).toEqual([]);
    expect(run.passCountsByTranscript["l-referencia-a-nada"]).toMatchObject({
      candidates: 1,
      filed: 0,
      unresolvedReference: 1,
    });
    expect(run.looking.cases[0]!.outcome).toBe("dropped");
  });

  it("counts a LOOKING day's below-gate drop in the row, with the same answer sheet (Codex r1)", async () => {
    // THE ROW IS OVER THE WHOLE RUN, and this is the case that proves it.
    // The precision number is over the original labels alone on purpose
    // (#199), and the aperture's `below_threshold` counts every chat the run
    // read — so a row scoped to the scored slice would leave this drop out
    // while the count beside it included it. The looking cases are exactly
    // where it bites: `resolved_reference` is the reading they produce, and
    // it is the reading spec #214 decision 1 newly drops.
    await resetAndMigrate();
    const model = scriptedModel(
      extractionTurns({
        looks: [
          {
            tool: "search_chat_history",
            input: { about: "cemento gris pedido pasado", chat: null },
          },
        ],
        // The resolution the model was NOT SURE OF, on the message this
        // corpus labels: a resolved reference under the gate.
        facts: [
          {
            ...RESOLVED_ORDER,
            message_id: "LA-D1",
            confidence: EXTRACTION_CONFIDENCE_THRESHOLD - 0.01,
          },
        ],
      }),
    );
    const run = await runExtractionPrecisionEval({
      db,
      executionPool,
      harness: model.harness,
      embedder: EMBEDDER,
      model: "scripted",
      transcripts: [],
      looking: [BACK_REFERENCE],
      hmacKey: HMAC,
    });

    // Nothing crossed, and the SCORED partition is empty because this day
    // is not in it — the two facts a partition-scoped row hides a drop
    // behind.
    expect(run.crossings).toEqual([]);
    expect(run.report.overall.crossed).toBe(0);
    // The aperture counted it...
    expect(run.passCounts.belowThreshold).toBe(1);
    // ...and so does the row, labelled, because the corpus says an
    // `OrderRequested` was stated on LA-D1 and the THRESHOLD is what
    // stopped it.
    expect(run.droppedBelowGate).toEqual({
      candidates: [
        {
          transcriptId: BACK_REFERENCE.id,
          messageId: "LA-D1",
          factType: "OrderRequested",
          confidence: EXTRACTION_CONFIDENCE_THRESHOLD - 0.01,
          reading: "resolved_reference",
          labelled: true,
        },
      ],
      total: 1,
      labelled: 1,
    });
    // The looking row reads it as the day producing nothing, which is what
    // happened — and the drop is named in the row above, not there.
    expect(run.looking.cases[0]!.outcome).toBe("dropped");
  });

  it("keeps ADR-0038's fence: yesterday's request files no OrderTaken today", async () => {
    // THE MODEL DISOBEYS, ON PURPOSE. Scripting an empty submission would
    // prove the model obeying the contract; what spec #193 decision 12 asks
    // is that the FENCE stands — so the search hands back yesterday's
    // request and this submits the cross-day `OrderTaken` it makes possible,
    // citing the rep's own «va, se lo dejo al mismo precio…» as its evidence.
    await resetAndMigrate();
    const model = scriptedModel(
      extractionTurns({
        looks: [
          {
            tool: "search_chat_history",
            input: { about: "cajas de mortero", chat: null },
          },
        ],
        facts: [
          {
            fact_type: "OrderTaken",
            message_id: "LD-D1",
            confidence: 1,
            reading: "resolved_reference",
            item: "cajas de mortero",
            quantity: 100,
          },
        ],
      }),
    );
    const run = await runExtractionPrecisionEval({
      db,
      executionPool,
      harness: model.harness,
      embedder: EMBEDDER,
      model: "scripted",
      transcripts: [],
      looking: [NOTHING_TO_FIND],
      hmacKey: HMAC,
    });

    // The request WAS in reach — the fixture would be vacuous otherwise.
    expect(toolResultsOf(model.requests[1]).join("\n")).toContain(
      "¿me mandas 100 cajas de mortero?",
    );
    // ...and nothing was paired: this day's window holds no counterparty
    // message, so there is no request among the messages the run was given
    // and the candidate is REFUSED rather than filed. A recorded
    // under-filing, not a win — Diego's ruling on #179 is that an order
    // taken given the next day should show, and it is a product requirement
    // on the horizon (#117) under *Extraction quality*.
    expect(run.crossings).toEqual([]);
    expect(run.dropped).toEqual([]);
    expect(run.passCountsByTranscript["l-referencia-a-nada"]).toMatchObject({
      candidates: 1,
      filed: 0,
      refused: 1,
      // The axis still records that the model RESOLVED it; what the pass did
      // with it is the counter beside this one.
      resolvedReference: 1,
    });
  });

  it("scores a resolution the rep is not told about as WRONG, however right the goods are", async () => {
    // Codex r2: a model may submit the right goods under `reading: "stated"`,
    // and the aperture then renders a line with no «(por referencia)» on it.
    // The rep reads a correct sentence with nothing saying the goods were
    // inferred, so nothing tells them which line to check harder (user story
    // 2) — and grading the payload alone scored it as a clean resolution.
    await resetAndMigrate();
    const model = scriptedModel(
      extractionTurns({
        looks: [
          {
            tool: "search_chat_history",
            input: { about: "cemento gris pedido pasado", chat: null },
          },
        ],
        facts: [
          { ...RESOLVED_ORDER, message_id: "LA-D1", reading: "stated" },
        ],
      }),
    );
    const run = await runExtractionPrecisionEval({
      db,
      executionPool,
      harness: model.harness,
      embedder: EMBEDDER,
      model: "scripted",
      transcripts: [],
      looking: [BACK_REFERENCE],
      hmacKey: HMAC,
    });

    // The goods are right, and the line does not say where they came from.
    expect(run.crossings).toHaveLength(1);
    expect(run.crossings[0]!.disclosureText).not.toContain("por referencia");
    expect(run.looking).toMatchObject({
      crossed: 1,
      correct: 0,
      unmarked: 1,
      leaks: 0,
    });
    expect(run.looking.cases[0]!.outcome).toBe("resolved-wrong");
    expect(run.looking.wrong[0]!.reason).toBe("unmarked_reference");
  });

  it("counts an ABBREVIATED customer's name — the leak a whole-name sweep walks past", async () => {
    // Codex r3: «los de Fuentes» names Ferretería Fuentes, which `list_chats`
    // shows the model, and a sweep over whole display names finds nothing in
    // it. Every looking day forbids the distinctive HALF of every customer
    // this corpus names, which is what a person actually writes.
    await resetAndMigrate();
    const model = scriptedModel(
      extractionTurns({
        looks: [
          {
            tool: "search_chat_history",
            input: { about: "cemento gris pedido pasado", chat: null },
          },
        ],
        facts: [
          {
            ...RESOLVED_ORDER,
            message_id: "LA-D1",
            item: "bultos de cemento gris, los de Fuentes",
          },
        ],
      }),
    );
    const run = await runExtractionPrecisionEval({
      db,
      executionPool,
      harness: model.harness,
      embedder: EMBEDDER,
      model: "scripted",
      transcripts: [],
      looking: [BACK_REFERENCE],
      hmacKey: HMAC,
    });

    expect(run.looking.leaks).toBe(1);
    expect(run.looking.cases[0]!.leaked).toBe(true);
    expect(
      run.looking.wrong.find((w) => w.failedCheck === "lacks")!.detail,
    ).toContain("Fuentes");
  });

  it("scores a WRONG UNIT folded into the item as a failed resolution", async () => {
    // Codex r3: the referent says 300 bultos. «toneladas de cemento gris»
    // with `unit` empty keeps the quantity, keeps both goods tokens, and
    // satisfied a check on `unit` alone — a materially different order scored
    // as a resolution. The unit is graded across both fields it can be filed
    // in.
    await resetAndMigrate();
    const model = scriptedModel(
      extractionTurns({
        looks: [
          {
            tool: "search_chat_history",
            input: { about: "cemento gris pedido pasado", chat: null },
          },
        ],
        facts: [
          {
            ...RESOLVED_ORDER,
            message_id: "LA-D1",
            item: "toneladas de cemento gris",
            unit: null,
          },
        ],
      }),
    );
    const run = await runExtractionPrecisionEval({
      db,
      executionPool,
      harness: model.harness,
      embedder: EMBEDDER,
      model: "scripted",
      transcripts: [],
      looking: [BACK_REFERENCE],
      hmacKey: HMAC,
    });

    expect(run.looking).toMatchObject({ crossed: 1, correct: 0, leaks: 0 });
    expect(run.looking.cases[0]!.outcome).toBe("resolved-wrong");
    expect(run.looking.wrong[0]!.detail).toContain("bultos");
  });

  it("counts another customer's name on a SILENT looking day as a leak", async () => {
    // Codex r2's sharpest: the day forbade only its own customer, so a wrong
    // cross-chat resolution disclosed Ochoa's identity in Aceros Lucero's
    // record and the row reported zero leaks. Every looking day forbids every
    // looking customer now, and the corpus's own display names are swept
    // beside them.
    await resetAndMigrate();
    const model = scriptedModel(
      extractionTurns({
        looks: [
          {
            tool: "search_chat_history",
            input: { about: "alambre recocido", chat: null },
          },
        ],
        facts: [
          {
            fact_type: "OrderRequested",
            message_id: "LC-D1",
            confidence: 0.95,
            reading: "resolved_reference",
            item: "rollos de alambre, los de Ochoa",
            quantity: 500,
          },
        ],
      }),
    );
    const run = await runExtractionPrecisionEval({
      db,
      executionPool,
      harness: model.harness,
      embedder: EMBEDDER,
      model: "scripted",
      transcripts: [],
      looking: [TWO_CANDIDATES],
      hmacKey: HMAC,
    });

    expect(run.looking.leaks).toBe(1);
    expect(run.looking.cases[0]).toEqual({
      transcriptId: "l-dos-candidatos-distintos",
      outcome: "resolved-wrong",
      leaked: true,
    });
    // Named with the tokens it found, though this day carries no label at all.
    const leak = run.looking.wrong.find((w) => w.failedCheck === "lacks")!;
    expect(leak.detail).toContain("Ochoa");
  });

  it("serves every chat of the corpus to `list_chats`, and says which have nothing in memory", async () => {
    // WHAT THE LIVE RUN'S MODEL ACTUALLY SEES, recorded rather than assumed
    // (Codex r1's fourth finding, declined and recorded). The corpus seeds
    // each day to the SEAM and only a looking day's earlier beats to twin
    // memory, so the original transcripts are listed with no last-message
    // instant — `renderChatList` omits it rather than inventing one. The list
    // is still complete, which is what a cross-chat resolution needs; what a
    // search cannot reach is another chat's TODAY, and that is the fixture's
    // difference from production ingest.
    await resetAndMigrate();
    const model = scriptedModel(
      extractionTurns({
        looks: [{ tool: "list_chats", input: {} }],
        facts: [],
      }),
    );
    const run = await runExtractionPrecisionEval({
      db,
      executionPool,
      harness: model.harness,
      embedder: EMBEDDER,
      model: "scripted",
      transcripts: [],
      looking: [BACK_REFERENCE],
      hmacKey: HMAC,
    });

    const listed = toolResultsOf(model.requests[1]).join("\n");
    expect(listed).toContain("Ferretería Ochoa");
    // The looking day's own history gives it an instant; a corpus chat with
    // nothing in twin memory is listed without one.
    expect(listed).toContain("last message");
    expect(run.looking.cases[0]!.outcome).toBe("dropped");
  });

  it("scores a right quantity over the WRONG product as a failed resolution", async () => {
    // Codex r1: the label pinned `quantity` and nothing else, so a crossing
    // for «300 varilla» recovered the number, filed the wrong product and
    // scored resolved-right — a row measuring RESOLUTION crediting a wrong
    // good. The goods are pinned now, and this is what that pin catches.
    await resetAndMigrate();
    const model = scriptedModel(
      extractionTurns({
        looks: [
          {
            tool: "search_chat_history",
            input: { about: "cemento gris pedido pasado", chat: null },
          },
        ],
        facts: [
          {
            ...RESOLVED_ORDER,
            message_id: "LA-D1",
            item: "rollos de varilla",
          },
        ],
      }),
    );
    const run = await runExtractionPrecisionEval({
      db,
      executionPool,
      harness: model.harness,
      embedder: EMBEDDER,
      model: "scripted",
      transcripts: [],
      looking: [BACK_REFERENCE],
      hmacKey: HMAC,
    });

    expect(run.looking.crossed).toBe(1);
    expect(run.looking.correct).toBe(0);
    expect(run.looking.cases[0]!.outcome).toBe("resolved-wrong");
    // ...and it is NOT a leak: nothing about the referent crossed, only the
    // wrong goods, and the two costs stay apart.
    expect(run.looking.leaks).toBe(0);
    expect(run.looking.wrong[0]!.failedCheck).toBe("contains");
  });

  it("counts a filed field that carried the referent as a LEAK, not as a wrong number", async () => {
    // The measurement `PROSE_FIELDS` argues for, at the seam: the quantity
    // is right and the `item` names the customer whose order was resolved,
    // which is chat identity in another customer's record (ADR-0004). No
    // structural fence catches it, and the corpus's `lacks` pins do.
    await resetAndMigrate();
    const model = scriptedModel(
      extractionTurns({
        looks: [
          {
            tool: "search_chat_history",
            input: { about: "cemento gris pedido pasado", chat: null },
          },
        ],
        facts: [
          {
            ...RESOLVED_ORDER,
            message_id: "LA-D1",
            item: "bultos de cemento gris, los del pedido pasado de Ochoa",
          },
        ],
      }),
    );
    const run = await runExtractionPrecisionEval({
      db,
      executionPool,
      harness: model.harness,
      embedder: EMBEDDER,
      model: "scripted",
      transcripts: [],
      looking: [BACK_REFERENCE],
      hmacKey: HMAC,
    });

    // THE LEAK IS A FILED RECORD, not a scoring artefact: the fact crossed,
    // and the name is in the payload the aperture stored. Nothing structural
    // stopped it, which is the finding — and the row says so.
    expect(run.crossings).toHaveLength(1);
    expect(String(run.crossings[0]!.payload["item"])).toContain("Ochoa");
    expect(run.looking.leaks).toBe(1);
    expect(run.looking.precision).toBe(0);
    expect(run.looking.cases).toEqual([
      {
        transcriptId: "l-pedido-pasado-mismo-chat",
        outcome: "resolved-wrong",
        leaked: true,
      },
    ]);
  });
});
