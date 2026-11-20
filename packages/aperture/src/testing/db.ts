/**
 * The shared Postgres seam test harness, from @dito/seam's source. Test
 * plumbing is source-only by convention (every package's `src/testing` is
 * excluded from its build), so this re-export reaches the seam package's
 * source directly — one harness, one destructive-reset guard, no copy to
 * drift.
 */
export {
  pgErrorCode,
  resetAndMigrate,
  TEST_DATABASE_URL,
  withClient,
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
  insertWaEventFixture,
  insertWaOpaqueFixture,
  insertWaReactionFixture,
  sealWaMessagePayload,
  type WaEventFixture,
  type WaOpaqueFixture,
  type WaReactionFixture,
} from "../../../seam/src/testing/wa-fixtures.js";
