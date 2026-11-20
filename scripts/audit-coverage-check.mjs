#!/usr/bin/env node
/**
 * Audit chain COVERAGE check (ticket #78; ADR-0020; spec #48 decision 18):
 * everything that should have been chained was.
 *
 * `audit-verify.mjs` beside this one proves INTEGRITY — nobody edited,
 * removed, reordered or forged an entry that IS in the chain — and this
 * changes nothing about it. What it cannot prove is coverage: an act that
 * never calls `appendAuditEntry` leaves no gap to detect, because a chain
 * missing a link it was never asked to write is byte-for-byte identical to
 * a complete one. `--require-entries` fixed the degenerate half of that
 * (`count > 0`); this is the other half (`count == the acts that owed one`).
 *
 * WHICH ACTS OWE AN ENTRY is stated in `@dito/aperture`'s `audit-coverage.ts`,
 * where every class cites an ADR or a spec line — never a call site, since
 * a list derived from the writers could never disagree with them.
 *
 * Runs in CI over the integration corpus, and against rig data:
 *
 *   DITO_DATABASE_URL=postgres://... node scripts/audit-coverage-check.mjs
 *
 * NO HMAC KEY, deliberately: coverage is a question about which rows exist,
 * not about hashes, so it can be asked by anyone who can read the database
 * — including an operator holding no chain key at all.
 *
 * Flags:
 *   --require-acts             fail if no act of ANY must-chain class exists
 *                              in this corpus — coverage over nothing is not
 *                              coverage (the ADR-0028 doctrine, and the same
 *                              reason `audit-verify` grew
 *                              `--require-entries`).
 *   --require-acts=<class,…>   fail unless each NAMED class has at least one
 *                              act. The bare flag is a floor over the whole
 *                              database, and every corpus here holds entity
 *                              creates — so a corpus that stopped producing
 *                              answered questions would still clear it. A CI
 *                              step that exists to make one class non-vacuous
 *                              names that class, or its comment is claiming
 *                              something the flag does not check.
 *
 * ORDERING: the invariant scripts are order-dependent, because each mint
 * RESETS the seam. This one joins seam rows against chain rows, so it must
 * run over the corpus its acts belong to, before the next mint — the same
 * rule every check here already lives under.
 *
 * Requires the workspace to be built (`pnpm build`) — imports @dito/aperture's
 * dist directly so the script itself carries no dependencies.
 */
import { auditChainCoverageAt } from "../packages/aperture/dist/index.js";

const databaseUrl =
  process.env.DITO_DATABASE_URL ??
  "postgres://dito:dito@localhost:5433/dito_test?sslmode=disable";
const requireActs = process.argv.some((a) => a.startsWith("--require-acts"));
const requiredClasses = process.argv
  .filter((a) => a.startsWith("--require-acts="))
  .flatMap((a) => a.slice("--require-acts=".length).split(","))
  .filter((id) => id !== "");

const report = await auditChainCoverageAt(databaseUrl);

/** "1 entry", "3 entries" — said the same way everywhere in this report. */
const entries = (n) => `${n} entr${n === 1 ? "y" : "ies"}`;

console.log(
  `Audit coverage: ${entries(report.entries)} in the chain, ` +
    `${report.checkedActs} act(s) checked across ${report.checkedClasses} class(es), ` +
    `${report.uncheckedClasses} not checked, ${report.undecidedClasses.length} undecided, ` +
    `${report.violations.length} violation(s)`,
);
for (const tally of report.mustChain) {
  if (tally.join === "unjoinable") {
    // PRINTED IN EVERY RUN, not hidden behind the green. These are the
    // classes a passing check says NOTHING about, and a reader who is not
    // told that reads the green as covering them.
    console.log(
      `  ${tally.class}: ${entries(tally.entries)}, NOT COVERED — ${tally.unjoinableWhy}`,
    );
    continue;
  }
  if (tally.absentRelation !== undefined) {
    // A database that predates the verb — routine when running against the
    // rig, which trails `main`. Said out loud rather than skipped.
    console.log(
      `  ${tally.class}: relation ${tally.absentRelation} is not in this schema, so no act of this class can exist here`,
    );
    continue;
  }
  console.log(
    `  ${tally.class}: ${tally.acts} act(s), ${entries(tally.entries)} (${tally.join})`,
  );
}
for (const tally of report.mustNotChain) {
  // The exclusions, counted. "0 violations" beside "312 facts filed in the
  // Ledger deliberately unchained" is a different statement from "0
  // violations" — and the class says WHAT it counted, because the store's
  // grain is not always the class's.
  console.log(
    tally.acts === null
      ? `  ${tally.class}: not in this schema, deliberately unchained`
      : `  ${tally.class}: ${tally.acts} ${tally.counted}, deliberately unchained`,
  );
}
for (const open of report.undecidedClasses) {
  // Acts this check does NOT verify. Printed for the same reason the
  // unjoinable classes are: a green that mentioned neither would read as
  // "every act is classified", and it is not. Each carries its own line,
  // because "nobody has ruled" and "somebody ruled and no writer obeys yet"
  // are different statements and a run must not make one for the other.
  console.log(`  ${open.id}: UNDECIDED — ${open.standing}`);
}
for (const violation of report.violations) {
  console.error(`  VIOLATION ${violation.class} ${violation.subject}: ${violation.reason}`);
}

if (report.violations.length > 0) {
  console.error(
    "AUDIT COVERAGE RED: an act that owed the chain an entry has none — the chain verifies, and it is incomplete (ADR-0020, spec #48 decision 18).",
  );
  console.error(
    "A LEGITIMATELY UNCOVERED HISTORICAL RANGE READS THE SAME WAY, and is not repaired: acts performed before their writer chained (the rig's pre-#54 entity creates, and every entity filed before #60 gave the kind column a determiner) cannot be given entries after the fact without forging history, which is the property the chain exists to have. Read the report, date the acts, and record the range — never backfill it.",
  );
  process.exit(1);
}
if (requireActs && report.checkedActs === 0) {
  console.error(
    "AUDIT COVERAGE INCONCLUSIVE: no must-chain act exists in this corpus, so nothing was compared — refusing to pass on nothing (--require-acts).",
  );
  process.exit(1);
}
for (const id of requiredClasses) {
  const tally = report.mustChain.find((t) => t.class === id);
  if (tally === undefined) {
    console.error(
      `AUDIT COVERAGE MISCONFIGURED: --require-acts names "${id}", which is not a declared must-chain class.`,
    );
    process.exit(1);
  }
  if (tally.acts === null || tally.acts === 0) {
    console.error(
      `AUDIT COVERAGE INCONCLUSIVE: class "${id}" has no act in this corpus, so this run proves nothing about it — refusing to pass on nothing (--require-acts=${id}).`,
    );
    process.exit(1);
  }
}
// THE GREEN SAYS WHAT IT COVERS. "Every act that owed an entry has one" is
// true only of the classes that could be checked; a reader told nothing
// about the rest will read it as absolute, which is the exact shape of
// mistake this whole check exists to stop.
console.log(
  `Audit coverage green across ${report.checkedClasses} checked class(es)` +
    (report.uncheckedClasses === 0
      ? ": every act that owed an entry has one."
      : `: every act that owed an entry has one. ${report.uncheckedClasses} class(es) above were NOT checked and this green says nothing about them.`),
);
