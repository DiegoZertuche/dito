#!/usr/bin/env node
/**
 * The Ledger grant audit (ticket #50, spec #48 grilling decision 2; the
 * owner's half is FR-71a — ticket #127, spec #126 decision 20): grants, not
 * convention. The aperture writes `ledger.*`; the twin runtime holds
 * nothing there and reads through the finalized views, whose definitions
 * carry the shadow filter (ADR-0016); the owner role holds three named
 * views, one function and its own schema, behind row-level security keyed
 * to the company its connection declares; and rep-web (#221) holds plaintext
 * seam reads and nothing on a sealed column, a key table or a Ledger object.
 *
 * Runs in CI over the migrated schema, and against rig data:
 *
 *   DITO_DATABASE_URL=postgres://... node scripts/ledger-grants-check.mjs
 *
 * Flags:
 *   --require-roles=a,b   fail unless this run actually covered these
 *                         roles. A catalog check passes quietly over an
 *                         absent principal — a database where `dito_owner`
 *                         was never created has no grants to diff and
 *                         nothing to say about the wall — so the caller
 *                         names what the run has to have been about, the
 *                         way `--require-corpus` and `--require-entries`
 *                         do for the corpora (ADR-0028 doctrine).
 *
 * Requires the workspace to be built (`pnpm build`) — imports
 * @dito/aperture's dist directly so the script itself carries no
 * dependencies.
 */
import { auditLedgerGrantsAt } from "../packages/aperture/dist/index.js";

const databaseUrl =
  process.env.DITO_DATABASE_URL ??
  "postgres://dito:dito@localhost:5433/dito_test?sslmode=disable";

const requiredRoles = process.argv
  .filter((arg) => arg.startsWith("--require-roles="))
  .flatMap((arg) => arg.slice("--require-roles=".length).split(","))
  .map((role) => role.trim())
  .filter((role) => role !== "");

const report = await auditLedgerGrantsAt(databaseUrl);

console.log(
  `Ledger grants: ${report.ledgerTables.length} table(s), ${report.ledgerViews.length} finalized view(s), ` +
    `${report.ownerViews.length} owner view(s), ${report.auditedRoles.length} role(s), ` +
    `${report.violations.length} violation(s)`,
);
for (const table of report.ledgerTables) console.log(`  table ${table}`);
for (const view of report.ledgerViews) console.log(`  view  ${view}`);
for (const view of report.ownerViews) console.log(`  owner ${view}`);
for (const role of report.auditedRoles) console.log(`  role  ${role}`);
for (const violation of report.violations) {
  console.error(`  VIOLATION ${violation.subject}: ${violation.reason}`);
}

if (report.violations.length > 0) {
  console.error(
    "LEDGER GRANTS RED: the single writer and the owner's wall are both enforced by grants (ADR-0003, ADR-0002), and these say otherwise.",
  );
  process.exit(1);
}

const missing = requiredRoles.filter(
  (role) => !report.auditedRoles.includes(role),
);
if (missing.length > 0) {
  console.error(
    `LEDGER GRANTS INCONCLUSIVE: this run audited no ${missing.join(", ")} — refusing to pass on a wall nobody was standing behind (--require-roles).`,
  );
  process.exit(1);
}

console.log(
  "Ledger grants green: one writer, no runtime write, shadow filtered inside the views, the owner holding its three views and nothing else, and rep-web holding plaintext seam reads with nothing sealed.",
);
