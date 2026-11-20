/**
 * The shared Postgres seam test harness, from @dito/seam's source. Test
 * plumbing is source-only by convention (every package's `src/testing` is
 * excluded from its build), so this re-export reaches the seam package's
 * source directly — one harness, one destructive-reset guard, no copy to
 * drift.
 *
 * It WAS a copy until ticket #50, and the copy drifted exactly as copies
 * do: the Ledger's new schema was added to the seam's reset and not to
 * this one, so this suite's apply failed on a schema the previous suite
 * had left behind. One harness now.
 */
export {
  pgErrorCode,
  resetAndMigrate,
  TEST_DATABASE_URL,
  withClient,
  // ...and the second connection, AUTHENTICATED as an application role
  // (ticket #165). The owner chain's claims are about what `dito_owner` may
  // read and write, and `SET ROLE` inside the schema owner's own session
  // would leave the one that matters unproven — see the seam function's own
  // header.
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
