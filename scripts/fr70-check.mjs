#!/usr/bin/env node
/**
 * FR-70 reconciliation check (ticket #24, slice AC 9): every outbound
 * customer_send matches a recorded tap for its own draft and twin.
 *
 * Runs in CI over the integration corpus, and against rig data:
 *
 *   DITO_DATABASE_URL=postgres://... node scripts/fr70-check.mjs
 *
 * Flags:
 *   --require-corpus   fail if there are zero customer_send rows — CI must
 *                      never go green on an empty corpus (a silent pass is
 *                      not a pass, per the ADR-0028 doctrine).
 *
 * Requires the workspace to be built (`pnpm build`) — imports @dito/seam's
 * dist directly so the script itself carries no dependencies.
 */
import { reconcileFr70At } from "../packages/seam/dist/index.js";

const databaseUrl =
  process.env.DITO_DATABASE_URL ??
  "postgres://dito:dito@localhost:5433/dito_test?sslmode=disable";
const requireCorpus = process.argv.includes("--require-corpus");

const report = await reconcileFr70At(databaseUrl);

console.log(
  `FR-70 reconciliation: ${report.customerSends} outbound customer_send command(s), ${report.violations.length} violation(s)`,
);
for (const violation of report.violations) {
  console.error(`  VIOLATION ${violation.subject}: ${violation.reason}`);
}

if (report.violations.length > 0) {
  console.error("FR-70 RED: an outbound send without its tap is a sev-1 (ADR-0006).");
  process.exit(1);
}
if (requireCorpus && report.customerSends === 0) {
  console.error(
    "FR-70 INCONCLUSIVE: zero customer_send rows in the corpus — refusing to pass on nothing (--require-corpus).",
  );
  process.exit(1);
}
console.log("FR-70 green.");
