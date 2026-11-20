#!/usr/bin/env node
/**
 * The wall, checked on the Ledger's content (ticket #50, ADR-0004): no
 * chat identity ever crosses. Sweeps every text-shaped column in the
 * `ledger` schema for WhatsApp address shapes — content-free, counting
 * matching rows and never reading a value back.
 *
 * The structural half (no migration DEFINES a chat column) is
 * packages/twin-runtime/src/binding-wall.test.ts. This is the half a
 * migration cannot promise: that no row VALUE carries a JID either.
 *
 *   DITO_DATABASE_URL=postgres://... node scripts/ledger-wall-check.mjs
 *
 * Flags:
 *   --require-corpus   fail if nothing has crossed — a clean sweep over an
 *                      empty Ledger is not evidence about content.
 *
 * Requires the workspace to be built (`pnpm build`).
 */
import { auditLedgerWallAt } from "../packages/aperture/dist/index.js";

const databaseUrl =
  process.env.DITO_DATABASE_URL ??
  "postgres://dito:dito@localhost:5433/dito_test?sslmode=disable";
const requireCorpus = process.argv.includes("--require-corpus");

const report = await auditLedgerWallAt(databaseUrl);

console.log(
  `Ledger wall: ${report.columnsChecked} text-shaped Ledger column(s) swept over ` +
    `${report.crossedRows} crossed row(s), ${report.violations.length} violation(s)`,
);
for (const violation of report.violations) {
  console.error(`  VIOLATION ${violation.subject}: ${violation.reason}`);
}

if (report.violations.length > 0) {
  console.error(
    "LEDGER WALL RED: chat identity reached the Ledger — owner-visible provenance is timestamp, confidence and source type only (ADR-0004).",
  );
  process.exit(1);
}
if (requireCorpus && report.crossedRows === 0) {
  console.error(
    "LEDGER WALL INCONCLUSIVE: nothing has crossed in this corpus — refusing to pass on nothing (--require-corpus).",
  );
  process.exit(1);
}
console.log("Ledger wall green: no chat identity crossed.");
