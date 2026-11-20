/**
 * The Ledger test plumbing this package's integration suite drives, from
 * the aperture's own source (ticket #130).
 *
 * A RELATIVE-PATH RE-EXPORT RATHER THAN A PACKAGE IMPORT, which is this
 * repo's convention for exactly this problem, and the owner web's own
 * `testing` re-export already states it: every package's `src/testing` is
 * excluded from its build, so the fixtures never ship and are not reachable
 * through `@dito/aperture`. One set of fixtures, one destructive-reset
 * guard, no copy to drift.
 *
 * NOTHING THIS PACKAGE SHIPS PASSES THROUGH HERE. `src/testing` is excluded
 * from `tsconfig.build.json`, so the seam, the crypto and the fixtures stay
 * out of `@dito/owner-twin`'s dependency graph — which is what lets the
 * owner app take this package without taking the rep side's with it
 * (ADR-0002).
 */
export {
  pgErrorCode,
  resetAndMigrate,
  TEST_DATABASE_URL,
  withRoleClient,
} from "../../../seam/src/testing/db.js";
// ...and the owner role's password, borrowed for a suite and given back
// (#133). Roles are cluster-global, so a suite that nulls it logs the live
// rig's owner web out — one home for that, beside the one harness.
export {
  borrowOwnerPassword,
  OWNER_TEST_PASSWORD,
  type BorrowedOwnerPassword,
} from "../../../seam/src/testing/owner-password.js";
export {
  TEST_AUDIT_HMAC_KEY,
  TEST_OWNER_AUDIT_HMAC_KEY,
} from "../../../aperture/src/testing/context.js";
export { boundTo, freshSeat, type Seat } from "../../../aperture/src/testing/ledger-fixtures.js";
export {
  CORPUS_AGREEMENT,
  CORPUS_AGREEMENT_THIRD_PARTY_NUMBER,
  CORPUS_PHONE,
  CORPUS_RETRACTED_AMOUNT,
  CORPUS_WALL_SHAPED_NAME,
  CORPUS_WINNER_QUOTE,
  seedOwnerCorpus,
  type OwnerCorpus,
} from "../../../aperture/src/testing/owner-corpus.js";
