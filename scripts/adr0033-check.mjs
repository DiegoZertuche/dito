#!/usr/bin/env node
/**
 * The ADR-0033 exclusion invariant (ticket #52, spec #48 grilling decision
 * 4): no extraction run or fact row ever carries the twin thread
 * as its source.
 *
 * This is the rule that stops the rep's own notes to their twin being
 * disclosed to their employer. Extraction ENUMERATES bound, in-scope
 * customer chats, so the twin thread is structurally not among its inputs —
 * this is the standing check that the structure held, over real rows. Each
 * twin's thread is derived from the seam (`system_send` reaches only the
 * rep's self-chat, ADR-0006), never from configuration.
 *
 *   DITO_DATABASE_URL=postgres://... node scripts/adr0033-check.mjs
 *
 * Flags:
 *   --require-corpus   fail if extraction has never run — a clean check
 *                      over a database where nothing was extracted proves
 *                      nothing (the ADR-0028 doctrine).
 *
 * Requires the workspace to be built (`pnpm build`).
 */
import { auditSelfChatExclusionAt } from "../packages/aperture/dist/index.js";

const databaseUrl =
  process.env.DITO_DATABASE_URL ??
  "postgres://dito:dito@localhost:5433/dito_test?sslmode=disable";
const requireCorpus = process.argv.includes("--require-corpus");

const report = await auditSelfChatExclusionAt(databaseUrl);

console.log(
  `ADR-0033 exclusion: ${report.selfChats} twin thread(s), ` +
    `${report.extractionRuns} extraction run(s), ${report.extractedFacts} extracted fact(s), ` +
    `${report.violations.length} violation(s)`,
);
for (const violation of report.violations) {
  console.error(`  VIOLATION ${violation.subject}: ${violation.reason}`);
}

if (report.violations.length > 0) {
  console.error(
    "ADR-0033 RED: the rep's own thread reached the crossing — a rep-stated item never crosses, and this is the rule that rots silently.",
  );
  process.exit(1);
}
if (requireCorpus && report.extractionRuns === 0) {
  console.error(
    "ADR-0033 INCONCLUSIVE: extraction has never run in this corpus — refusing to pass on nothing (--require-corpus).",
  );
  process.exit(1);
}
if (requireCorpus && report.selfChats === 0) {
  console.error(
    "ADR-0033 INCONCLUSIVE: no twin thread could be identified from the seam, so nothing was actually compared (--require-corpus).",
  );
  process.exit(1);
}
console.log(
  "ADR-0033 green: nothing that crossed was read in the rep's own thread.",
);
