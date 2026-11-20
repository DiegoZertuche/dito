#!/usr/bin/env node
/**
 * Audit chain integrity check (ticket #24, ADR-0020; both chains since
 * #165): verifies every stored chain end to end — first link from null,
 * every prev_hash matching its predecessor's entry_hash, every entry_hash
 * matching its content under the key for that chain's side.
 *
 * TWO CHAINS, TWO KEYS, ONE VERDICT (the decision on #157; ADR-0020 as
 * amended 2026-09-03). The rep side's `public.audit_chain` verifies under
 * `DITO_AUDIT_HMAC_KEY`; the owner side's `owner.audit_chain` is ONE CHAIN
 * PER COMPANY and each verifies under `DITO_OWNER_AUDIT_HMAC_KEY`. Each is
 * reported on its own line — a red has to name which chain broke — and the
 * process exits once, because "the audit chain verifies" is a single claim a
 * reader makes about a deployment. Nothing is lost to the split: the chains
 * record disjoint acts and no G16 claim orders an owner act against a rep
 * act.
 *
 * INTEGRITY ONLY, and deliberately unchanged (ticket #78). Nobody edited,
 * removed, reordered or forged an entry that IS in a chain — but an act
 * that never called an appender leaves no gap here to detect, since a chain
 * missing a link it was never asked to write is byte-for-byte identical to
 * a complete one. That second claim is
 * `scripts/audit-coverage-check.mjs`: a separate check with its own
 * verdict, so that a red says which of the two is false. This one was not
 * widened to carry it.
 *
 * Runs in CI over the integration corpus, and against rig data:
 *
 *   DITO_DATABASE_URL=postgres://... \
 *     DITO_AUDIT_HMAC_KEY=<hex> DITO_OWNER_AUDIT_HMAC_KEY=<hex> \
 *     node scripts/audit-verify.mjs
 *
 * Custody is fail-closed for both: each key comes only from its own variable
 * (the slice-1 custody decision on issue #24, and #157 decision 3) — there
 * is no fallback key and neither side's key stands in for the other's. A run
 * that could skip the owner chains because a variable was unset would be the
 * silent green this whole script exists to refuse, so the owner key is
 * required whenever `owner.audit_chain` is in the schema. It is asked for
 * only THEN: a database that predates …100010 has no owner chain and no
 * owner key, and reporting that out loud is what the sibling coverage check
 * already does about an absent relation. And because this process is the ONLY
 * one that ever holds both keys, it is also the only one that can check they
 * are not the same key — see `requireDistinctOwnerKey`.
 *
 * Flags:
 *   --require-entries  fail if the REP chain is empty — CI must never go
 *                      green on nothing (ADR-0028 doctrine).
 *
 *                      IT DOES NOT REACH THE OWNER CHAINS, and that is a
 *                      decision rather than an omission (#165). "This corpus
 *                      should hold owner entries and holds none" is a
 *                      COVERAGE question — which acts owed an entry — and
 *                      `audit-coverage-check.mjs` already answers it
 *                      precisely, from an enumeration that knows the acts:
 *                      `--require-acts=execution` is the step CI runs
 *                      immediately before this one over the owner corpus.
 *                      Most corpora in that workflow contain no owner
 *                      execution at all, so demanding a non-empty owner
 *                      chain here would make nine of the ten steps that use
 *                      this flag red for a reason that is not about
 *                      integrity — and a red with two possible meanings is
 *                      worth less than two checks with one each.
 *
 * Requires the workspace to be built (`pnpm build`).
 */
import { timingSafeEqual } from "node:crypto";
import {
  hmacKeyFromEnv,
  ownerChainExistsAt,
  ownerHmacKeyFromEnv,
  verifyAuditChainAt,
  verifyOwnerAuditChainsAt,
} from "../packages/audit/dist/index.js";

const databaseUrl =
  process.env.DITO_DATABASE_URL ??
  "postgres://dito:dito@localhost:5433/dito_test?sslmode=disable";
const requireEntries = process.argv.includes("--require-entries");

/** Set by anything below that makes this run's ONE verdict a red. */
let red = false;

/**
 * The OWNER key, and the one thing this script is uniquely placed to check:
 * that it is not the REP key (ticket #165, Codex r3; #157 decision 3).
 *
 * THE MISTAKE IT CATCHES IS A DOCUMENTED MANUAL STEP. A rig minted before the
 * split has no `DITO_OWNER_AUDIT_HMAC_KEY`, so `rig.sh`'s header tells an
 * operator to append one — and says in as many words "NEVER a copy of
 * DITO_AUDIT_HMAC_KEY". Copy it anyway and every chain still verifies, both
 * sides green, while the owner environment holds a key that authenticates a
 * REP-SIDE STORE: exactly what #157 decision 3 exists to prevent, invisible
 * to every other check in this repo. This process is the only one that ever
 * holds both keys, so it is the only one that can say they differ.
 *
 * Constant-time, because comparing key material any other way is a habit
 * worth not having; two independently minted 32-byte keys never collide, so
 * this can only ever fire on the copy.
 */
function requireDistinctOwnerKey(repKey) {
  const ownerKey = ownerHmacKeyFromEnv();
  const same =
    ownerKey.length === repKey.length && timingSafeEqual(ownerKey, repKey);
  if (same) {
    console.error(
      "AUDIT CHAIN RED: DITO_OWNER_AUDIT_HMAC_KEY is the REP side's key — the owner environment must hold nothing that can verify a rep-side store (ADR-0002; the decision on #157). Mint a separate one: openssl rand -hex 32.",
    );
    red = true;
  }
  return ownerKey;
}

/** "1 entry", "3 entries" — said the same way on every line below. */
const entries = (n) => `${n} entr${n === 1 ? "y" : "ies"}`;

const repKey = hmacKeyFromEnv();
const shared = await verifyAuditChainAt(databaseUrl, repKey);
console.log(`Rep chain (public.audit_chain): ${entries(shared.entries)}.`);

// THE OWNER SIDE, IF THIS DATABASE HAS ONE. The rig trails `main` (its
// upgrade order is pull, build, THEN migrate), so a database that predates
// …100010 is a real thing to be run against — and "there is no owner chain
// here" is a true answer, said out loud, exactly as `audit-coverage-check`
// says it about an absent act relation. The KEY is still read fail-closed
// whenever the chain IS here: present chain, absent key is a refusal.
const owner = (await ownerChainExistsAt(databaseUrl))
  ? await verifyOwnerAuditChainsAt(databaseUrl, requireDistinctOwnerKey(repKey))
  : null;
if (owner === null) {
  console.log(
    "Owner chains (owner.audit_chain): not in this schema — this database predates the split (#165), so there is no owner chain to verify.",
  );
} else {
  console.log(
    `Owner chains (owner.audit_chain): ${entries(owner.entries)} across ` +
      `${owner.companies.length} compan${owner.companies.length === 1 ? "y" : "ies"}.`,
  );
  // EVERY COMPANY ON ITS OWN LINE, green ones included. A reader has to be
  // able to see WHICH chains this run actually walked — a verdict over one
  // company printed as "the owner chains verify" is the vacuous green
  // `--require-entries` exists to refuse, one level down.
  for (const chain of owner.companies) {
    console.log(
      `  ${chain.companyId}: ${entries(chain.entries)} — ${chain.valid ? "verifies" : "BROKEN"}`,
    );
  }
}

if (!shared.valid) {
  console.error(
    "AUDIT CHAIN RED (public.audit_chain): linkage broken — an entry was edited, removed, reordered, or forged (ADR-0020).",
  );
  red = true;
}
for (const chain of (owner?.companies ?? []).filter((c) => !c.valid)) {
  console.error(
    `AUDIT CHAIN RED (owner.audit_chain, company ${chain.companyId}): linkage broken — an entry was edited, removed, reordered, or forged (ADR-0020).`,
  );
  red = true;
}
if (requireEntries && shared.entries === 0) {
  console.error(
    "AUDIT CHAIN INCONCLUSIVE: zero entries on the rep chain — refusing to pass on nothing (--require-entries).",
  );
  red = true;
}
if (red) process.exit(1);
console.log("Every audit chain verifies end to end.");
