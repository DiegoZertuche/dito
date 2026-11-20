/**
 * The chain keys a test suite chains under (ticket #54; the owner side's
 * since #165).
 *
 * The pattern is `writer.int.test.ts`'s, lifted here because it stopped
 * being one suite's business: since the crossing is audit-chained, every
 * suite that confirms a binding writes to `audit_chain`, and each of them
 * needs the SAME key for the whole file — the appender authenticates the
 * tail before extending it, so a second key inside one suite refuses the
 * second append rather than forking the chain.
 *
 * TWO KEYS SINCE #165, for the two chains: the rep side's
 * `public.audit_chain` and the owner side's per-company
 * `owner.audit_chain`. Independently derived, so a suite that ran an owner
 * turn under the rep key would be chaining under the wrong secret and the
 * verifier would say so.
 *
 * CI mints one of each per run and hands them to the suites AND to
 * `scripts/audit-verify.mjs`, so the invariant step verifies the very
 * corpus the suites wrote. A bare local run chains under throwaway keys,
 * which is enough for a suite that verifies its own chains in-process.
 *
 * Test plumbing, source-only: every package's `src/testing` is excluded
 * from its build, so this never ships.
 */
import { randomBytes } from "node:crypto";
import { hmacKeyFromEnv, ownerHmacKeyFromEnv } from "../custody.js";

export const TEST_AUDIT_HMAC_KEY: Uint8Array = process.env[
  "DITO_AUDIT_HMAC_KEY"
]
  ? hmacKeyFromEnv()
  : randomBytes(32);

export const TEST_OWNER_AUDIT_HMAC_KEY: Uint8Array = process.env[
  "DITO_OWNER_AUDIT_HMAC_KEY"
]
  ? ownerHmacKeyFromEnv()
  : randomBytes(32);
