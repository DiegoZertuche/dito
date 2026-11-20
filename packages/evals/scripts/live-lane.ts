/**
 * THE GUARDS EVERY LIVE EVAL LANE KEEPS, written once.
 *
 * Two scripts in this directory drive the real model against a real
 * Postgres — `extraction-precision.ts` and `confidence-probe.ts` — and
 * both must refuse the same four things. They were copied between the two
 * once already, down to the error strings, which is how the pair drifts:
 * a guard tightened in one lane and not the other reads as protection
 * that is not there.
 *
 * WHAT THEY REFUSE, AND WHY EACH IS ITS OWN RULE:
 *
 *  - NO KEY. These are the LIVE lanes; the scripted counterpart is the
 *    integration suite, and a lane that quietly ran scripted would report
 *    a number about nothing.
 *  - NO DATABASE URL.
 *  - A DATABASE WHOSE NAME DOES NOT END IN `_test`. Narrower than the
 *    seam harness's own guard, deliberately (Codex r1 on #56): that one
 *    refuses a name not CONTAINING "test", which lets "latest" and
 *    "production_testimonials" through, and these are the scripts a human
 *    types by hand with whatever happens to be in their shell. A corpus
 *    run against the rig's database would destroy a rep's day.
 *  - `DITO_ALLOW_DB_RESET` SET AT ALL. The seam harness honours that
 *    override; these lanes refuse it outright, because the override is
 *    exactly the thing somebody sets once for a good reason and leaves in
 *    a shell profile.
 */

import {
  BGE_M3_MODEL,
  createBgeM3Embedder,
  extractionModelConfig,
  ExtractionConfigError,
  type Embedder,
  type ModelCallConfig,
} from "@dito/twin-runtime";

/** What a live lane needs, once every guard has passed. */
export interface LiveLane {
  readonly dbUrl: string;
  /** The model key the lane's harness presents (`ANTHROPIC_API_KEY`). */
  readonly apiKey: string;
  readonly model: string;
  /**
   * `DITO_EXTRACTION_EFFORT`, or undefined when the variable is unset
   * (ticket #148).
   *
   * UNSET IS AN ARM rather than a missing setting: the request then
   * carries no `output_config` at all and the model applies its own
   * default, which on Sonnet 5 is adaptive thinking. So the lane must not
   * fill one in — and a value that is not one of the three levels is
   * REFUSED rather than ignored, because a typo'd
   * `DITO_EXTRACTION_EFFORT=lo` that silently ran the default arm would
   * report one arm's number under another arm's name. That is the
   * only way a three-arm measurement can lie about which arm it measured.
   */
  readonly effort: ModelCallConfig["effort"];
}

/**
 * Checks the four guards and returns the lane's settings, or exits.
 *
 * It EXITS rather than throwing: these are scripts a person runs, and a
 * stack trace above a one-line reason is worse than the reason alone.
 * `lane` names the caller in that reason, so the message says which lane
 * refused.
 */
export function requireLiveLane(lane: string): LiveLane {
  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (apiKey === undefined) {
    fail(
      `${lane} needs ANTHROPIC_API_KEY — refusing (it is the LIVE lane; the scripted one is packages/evals/src/extraction-precision.int.test.ts)`,
    );
  }

  const dbUrl = process.env["DITO_TEST_DATABASE_URL"];
  if (dbUrl === undefined) {
    fail(`${lane} needs DITO_TEST_DATABASE_URL — refusing`);
  }

  const dbName = new URL(dbUrl).pathname.replace(/^\//u, "");
  if (!/_test$/u.test(dbName)) {
    fail(
      `refusing to run against "${dbName}": this lane WIPES the seam, and it will only do that to a database whose name ends in "_test" (a corpus run against the rig's database would destroy a rep's day)`,
    );
  }
  if (process.env["DITO_ALLOW_DB_RESET"] !== undefined) {
    fail(
      "refusing to run with DITO_ALLOW_DB_RESET set: this lane's guard is the database NAME, and an override that skips it is the one that survives in somebody's shell profile",
    );
  }

  // THE RUNG, RESOLVED WHERE EVERY CALLER RESOLVES IT (ticket #148).
  // Sonnet 5 by default since Diego's ruling of 2026-09-02; the two
  // variables are the overrides, and `DITO_EXTRACTION_MODEL` is how the
  // Haiku arm of the ticket's own table was measured.
  let config: ModelCallConfig;
  try {
    config = extractionModelConfig({
      model: process.env["DITO_EXTRACTION_MODEL"],
      effort: process.env["DITO_EXTRACTION_EFFORT"],
    });
  } catch (error) {
    if (!(error instanceof ExtractionConfigError)) throw error;
    fail(`${lane}: ${error.message}`);
  }

  return { dbUrl, apiKey, model: config.model, effort: config.effort };
}

/**
 * THE EMBEDDER A LIVE LANE COMPOSES: BGE-M3 in-process (ticket #199).
 *
 * The extraction searches the rep's own history before it files (#196), so
 * every lane that drives the pass has to hand it an embedder — and a live
 * number is only about retrieval anybody ships if the weights are the ones
 * the rig loads. `rig-extract.ts` makes the same composition; the two
 * variables are its overrides, honoured here for the reason `live-lane.ts`
 * exists at all: a knob one lane reads and another silently ignores is
 * protection that is not there.
 *
 * IT IS THE EDGE, WHICH IS WHERE THIS BELONGS (ADR-0028). Library code sees
 * the `Embedder` interface and never a model; the integration lanes compose
 * the deterministic fake instead, so CI downloads no weights and calls
 * nothing.
 *
 * LOADED WHEN A LANE ASKS, so a lane that a guard refused has already exited
 * before this spends two minutes on a first-run model download.
 */
export async function liveEmbedder(): Promise<Embedder> {
  const model = process.env["DITO_EMBEDDING_MODEL"] ?? BGE_M3_MODEL;
  const cacheDir = process.env["DITO_MODEL_CACHE_DIR"];
  console.error(`loading embedder ${model}…`);
  return createBgeM3Embedder({
    model,
    ...(cacheDir === undefined ? {} : { cacheDir }),
  });
}

/**
 * EXPORTED so every live lane refuses the same way (ticket #148). This
 * file exists because the two lanes had copied their guards down to the
 * error strings; a third lane inventing its own `console.error` and
 * `process.exit` would be the same drift starting again.
 */
export function fail(reason: string): never {
  console.error(reason);
  process.exit(1);
}
