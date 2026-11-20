/**
 * The aperture context a suite drives the crossing with (ticket #54).
 *
 * One factory rather than an object literal per call site, for a reason
 * that is not tidiness: `RepActContext` extends `ApertureContext`, so a
 * VALUE of the wider type is accepted anywhere the narrower one is asked
 * for, while an object LITERAL carrying `hmacKey` would be refused there by
 * excess-property checking. The factory therefore lets one expression serve
 * both — `fileEntityCreate`, which chains, and `fileCandidateFact`, which
 * deliberately does not.
 *
 * Test plumbing, source-only: excluded from the build, never composed
 * outside a test.
 */
import type { Dek } from "@dito/crypto";
import type pg from "pg";
import {
  TEST_AUDIT_HMAC_KEY,
  TEST_OWNER_AUDIT_HMAC_KEY,
} from "../../../audit/src/testing/hmac.js";
import type { RepActContext } from "../inputs.js";

// Both keys travel through here for the reason the rep side's always did:
// one place mints them, and every suite that needs one names it rather than
// generating a second (#165).
export { TEST_AUDIT_HMAC_KEY, TEST_OWNER_AUDIT_HMAC_KEY };

/** The context a class-2 rep act runs under, chained by this suite's key. */
export function apertureCtx(db: pg.ClientBase, dek: Dek): RepActContext {
  return { db, dek, hmacKey: TEST_AUDIT_HMAC_KEY };
}
