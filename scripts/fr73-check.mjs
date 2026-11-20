#!/usr/bin/env node
/**
 * FR-73 store-enumeration audit (ticket #31, spec #29 decision 13): every
 * rep-side store is bundle-resident under exactly that twin's one KMS
 * key. Enumerates the bundle's stores from its live schema, checks the
 * custody chain (one twin_keys row, real KMS unwrap, ciphertext at rest,
 * the bundle actually opens), and sweeps the twin's data dir for anything
 * store-shaped outside the bundle — printing the per-twin harness
 * directory beside the bundle as the recorded gap it is.
 *
 * ADR-0016 boundary: this check reads table NAMES (via the bundle API)
 * and file HEADERS only — never a row of twin memory. Custody tooling,
 * not bundle-reading operator tooling.
 *
 * Runtime check on the rig (twin-bound KMS identity, no lever):
 *
 *   ./rig.sh node scripts/fr73-check.mjs
 *   (DITO_TWIN_ID + DITO_DATABASE_URL from .env.rig; DITO_BUNDLE_PATH
 *    overrides the default rig-data/twin-<id>.bundle)
 *
 * CI invariant: with no DITO_TWIN_ID set, audits the corpus minted by
 * packages/twin-runtime/src/fr73.int.test.ts (.tools/fr73-corpus.json —
 * a real twin provisioned under the shared fixture KMS key, which is why
 * this mode goes through the module-internal fixture-key entry point, the
 * same recorded in-repo latitude the suites use). A missing corpus is a
 * loud failure, never a silent green (ADR-0028).
 *
 * Requires the workspace to be built (`pnpm build`) and AWS credentials
 * for the dev-account KMS.
 */
import { readFileSync } from "node:fs";
// In-repo dist path import: the ...WithKmsIdentity entry is
// test-fixture-only and deliberately absent from the package surface (its
// exports map); the corpus mode here is the same in-repo latitude the
// package's own suites record. The rig mode uses only the public
// twin-bound auditFr73At.
import {
  auditFr73At,
  auditFr73AtWithKmsIdentity,
} from "../packages/twin-runtime/dist/fr73.js";

const databaseUrl =
  process.env.DITO_DATABASE_URL ??
  "postgres://dito:dito@localhost:5433/dito_test?sslmode=disable";

let target;
if (process.env.DITO_TWIN_ID !== undefined) {
  const twinId = process.env.DITO_TWIN_ID;
  target = {
    mode: "rig",
    twinId,
    bundlePath:
      process.env.DITO_BUNDLE_PATH ??
      new URL(`../rig-data/twin-${twinId}.bundle`, import.meta.url).pathname,
  };
} else {
  const manifestPath = new URL("../.tools/fr73-corpus.json", import.meta.url)
    .pathname;
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    console.error(
      `FR-73 INCONCLUSIVE: no corpus manifest at ${manifestPath} — mint it first ` +
        "(pnpm vitest run --config vitest.integration.config.ts packages/twin-runtime/src/fr73.int.test.ts) " +
        "or set DITO_TWIN_ID for a rig audit. Refusing to pass on nothing.",
    );
    process.exit(1);
  }
  target = { mode: "corpus", ...manifest };
}

const report =
  target.mode === "rig"
    ? await auditFr73At(databaseUrl, {
        twinId: target.twinId,
        bundlePath: target.bundlePath,
      })
    : await auditFr73AtWithKmsIdentity(databaseUrl, {
        twinId: target.twinId,
        bundlePath: target.bundlePath,
        kmsTwinId: target.kmsTwinId,
      });

console.log(
  `FR-73 (${target.mode}): twin ${report.twinId}, bundle schema v${report.schemaVersion ?? "?"}, ` +
    `${report.stores.length} bundle-resident store(s), ` +
    `${report.sharedStores.length} declared shared-Postgres store(s) ` +
    `(${report.sharedStoreExceptions.length} recorded exception(s)), ` +
    `${report.recordedGaps.length} recorded gap(s), ` +
    `${report.violations.length} violation(s)`,
);
for (const store of report.stores) console.log(`  store ${store}`);
for (const store of report.sharedStores) {
  const excepted = report.sharedStoreExceptions.includes(store);
  console.log(`  shared store ${store}${excepted ? "  [RECORDED EXCEPTION]" : ""}`);
}
// THE HARNESS DIRECTORY IS NAMED, NEVER SKIPPED (ticket #328): it sits in
// the data dir by a recorded ruling, and the report says which.
for (const gap of report.recordedGaps) {
  console.log(`  harness directory ${gap.path}  [RECORDED GAP: ${gap.ruling}]`);
}
for (const violation of report.violations) {
  console.error(`  VIOLATION ${violation.subject}: ${violation.reason}`);
}

if (report.violations.length > 0) {
  console.error(
    "FR-73 RED: a rep-side store outside the bundle (or a broken custody chain) breaks the erasure story (ADR-0007/0009).",
  );
  process.exit(1);
}
console.log("FR-73 green: every enumerated rep-side store is bundle-resident under the twin's one key.");
