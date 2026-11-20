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
} from "../../../seam/src/testing/db.js";

/**
 * The chain key this suite chains under (ticket #54). One per FILE, never
 * one per `depsFor` call: since the crossing is audit-chained, most suites
 * here write to `audit_chain`, and `appendAuditEntry` authenticates the
 * tail under the supplied key before extending it — so a second key inside
 * one suite refuses the second append rather than forking the chain.
 */
export {
  TEST_AUDIT_HMAC_KEY,
  TEST_OWNER_AUDIT_HMAC_KEY,
} from "../../../audit/src/testing/hmac.js";
