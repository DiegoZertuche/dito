/**
 * @dito/audit — the hash-chained audit log skeleton (ADR-0020).
 *
 * Append-only, HMAC hash-chained, content-free entries: caller identity,
 * action type, opaque refs, outcome. Slice-1 writers are the refusal paths
 * (send-allowlist, pacing) at the send_commands writer.
 *
 * Chain construction/verification lives in chain.ts; the Postgres tables and
 * their append-only enforcement live in `db/migrations/` and are exercised by
 * the seam integration tests.
 *
 * ONE CHAIN PER SIDE OF THE WALL (ticket #165; the decision on #157;
 * ADR-0020 as amended 2026-09-03). The rep side appends to
 * `public.audit_chain` under `DITO_AUDIT_HMAC_KEY`; the owner side appends to
 * its own `owner.audit_chain`, one chain per company, under
 * `DITO_OWNER_AUDIT_HMAC_KEY`. Both entry formats are identical and
 * `chain.ts` is shared, so the split is entirely about custody and reach: the
 * owner credential may read only what it wrote, and the owner environment
 * holds no key that can verify a rep-side store (ADR-0002).
 *
 * TWO CLAIMS, TWO VERIFIERS (ticket #78). `verifyAuditChain*` proves
 * INTEGRITY — nobody touched an entry that is in the chain. It cannot prove
 * COVERAGE, because a chain missing a link it was never asked to write is
 * identical to a complete one. That second check is `auditChainCoverage*`
 * in @dito/aperture, which is where the enumeration of which acts owe an
 * entry lives too: it joins `ledger.*` rows, and ADR-0003 keeps every
 * statement naming a Ledger object inside the single writer's package. What
 * stays here is the closed set of action WORDS, because every writer must
 * pass through it.
 */

export {
  appendEntry,
  verifyChain,
  verifyEntry,
  type AuditEntry,
  type StoredAuditEntry,
  type ChainedEntry,
} from "./chain.js";
export {
  assertHmacKey,
  hmacKeyFromEnv,
  ownerHmacKeyFromEnv,
} from "./custody.js";
export {
  appendAuditEntry,
  appendOwnerAuditEntry,
  ownerChainExistsAt,
  verifyAuditChainInDb,
  verifyAuditChainAt,
  verifyOwnerAuditChainsInDb,
  verifyOwnerAuditChainsAt,
  type ChainVerification,
  type OwnerChainVerification,
} from "./store.js";
export { AUDIT_ACTIONS, isAuditAction, type AuditAction } from "./vocabulary.js";
