#!/usr/bin/env node
/**
 * FR-72 disclosure reconciliation (ticket #50, spec #48): every filed item
 * has exactly one disclosure line, and every disclosure line maps to a
 * filed item. A fact that crossed without being disclosed is a build
 * failure here, not a trust incident discovered later.
 *
 * Runs in CI over the integration corpus, and against rig data:
 *
 *   DITO_DATABASE_URL=postgres://... node scripts/fr72-check.mjs
 *
 * Flags:
 *   --require-corpus   fail if nothing has crossed at all — CI must never
 *                      go green on an empty corpus (a silent pass is not a
 *                      pass, per the ADR-0028 doctrine).
 *
 * Requires the workspace to be built (`pnpm build`) — imports
 * @dito/aperture's dist directly so the script itself carries no
 * dependencies.
 */
import { reconcileFr72At } from "../packages/aperture/dist/index.js";

const databaseUrl =
  process.env.DITO_DATABASE_URL ??
  "postgres://dito:dito@localhost:5433/dito_test?sslmode=disable";
const requireCorpus = process.argv.includes("--require-corpus");

const report = await reconcileFr72At(databaseUrl);

console.log(
  `FR-72 reconciliation: ${report.facts} fact(s), ${report.entityCreates} entity create(s), ` +
    `${report.disclosureLines} disclosure line(s), ${report.violations.length} violation(s)`,
);
for (const violation of report.violations) {
  console.error(`  VIOLATION ${violation.subject}: ${violation.reason}`);
}

if (report.violations.length > 0) {
  console.error(
    "FR-72 RED: something crossed the wall undisclosed (ADR-0003) — the disclosure's completeness claim is false.",
  );
  process.exit(1);
}
if (requireCorpus && report.facts + report.entityCreates === 0) {
  console.error(
    "FR-72 INCONCLUSIVE: nothing has crossed in this corpus — refusing to pass on nothing (--require-corpus).",
  );
  process.exit(1);
}
console.log("FR-72 green: everything that crossed was disclosed, exactly once.");
