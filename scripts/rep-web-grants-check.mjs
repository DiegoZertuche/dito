#!/usr/bin/env node
/**
 * THE FIRST CLIENT INVARIANT: rep-web holds no key and reaches nothing
 * twin-side except through the runtime (ticket #263; spec #258 decision 5,
 * which keeps it as a test; ADR-0008, ADR-0010).
 *
 * A grant check, because «rep-web holds no key» is a statement about what its
 * database role can read or it is a statement about nothing. It asks the
 * catalog for every relation, column, sequence, function, policy and system
 * catalog `dito_rep_web` can reach and diffs it against the pin in both
 * directions (`auditRepWebGrants` in `@dito/aperture` argues the pin), so a
 * grant on a sealed column, the key table, a post, a door message or anything
 * in the Ledger fails the build by name.
 *
 *   DITO_DATABASE_URL=postgres://... node scripts/rep-web-grants-check.mjs
 *
 * MINTED THEN CHECKED: the role and its grants are what the migrations mint,
 * and a database where `dito_rep_web` was never created fails here rather than
 * passing over an absent principal (ADR-0028 doctrine).
 *
 * The other client invariant — no model call leaves the browser, and no key
 * rides in a client bundle — is `client-bundle-check.mjs`, over the build.
 *
 * Requires the workspace to be built (`pnpm build`), for
 * `ledger-grants-check.mjs`'s reason: it imports `@dito/aperture`'s dist.
 */
import { auditRepWebGrantsAt } from "../packages/aperture/dist/index.js";

const databaseUrl =
  process.env.DITO_DATABASE_URL ??
  "postgres://dito:dito@localhost:5433/dito_test?sslmode=disable";

const report = await auditRepWebGrantsAt(databaseUrl);

console.log(
  `rep-web grants: ${report.relations.length} pinned relation(s), ${report.violations.length} violation(s)`,
);
for (const relation of report.relations) console.log(`  reach ${relation}`);
for (const violation of report.violations) {
  console.error(`  VIOLATION ${violation.subject}: ${violation.reason}`);
}

if (!report.present || report.violations.length > 0) {
  console.error(
    "REP-WEB GRANTS RED: the dashboard holds no key and reaches everything sealed or bundle-resident through the twin runtime's local API (ADR-0008, ADR-0010), and the catalog says otherwise.",
  );
  process.exit(1);
}

console.log(
  "rep-web grants green: plaintext seam rows and its own stores only — nothing sealed, no key, no chain, no Ledger.",
);
