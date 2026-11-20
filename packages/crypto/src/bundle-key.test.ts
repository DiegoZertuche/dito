/**
 * The bundle subkey (ADR-0007 × ADR-0008): the SQLCipher bundle opens under
 * a key DERIVED from the twin's DEK — purpose-bound via HKDF — so the raw
 * DEK never leaves module-private custody and the envelope key is never
 * reused raw inside a second cipher construction. Destroying the twin's KMS
 * key still kills the bundle: no DEK, no derivation, no open (ADR-0009).
 */
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createDekFromMaterial, deriveBundleKey } from "./dek.js";

describe("deriveBundleKey (bundle subkey, ADR-0007/0008)", () => {
  it("derives a 32-byte subkey that is not the raw DEK material", () => {
    const materialBytes = randomBytes(32);
    const dek = createDekFromMaterial(materialBytes);
    const key = deriveBundleKey(dek);
    expect(key.length).toBe(32);
    // Purpose-bound derivation, never the envelope key reused raw.
    expect(key.equals(materialBytes)).toBe(false);
  });

  it("is deterministic per DEK (a bundle must reopen later) and distinct across DEKs", () => {
    const materialA = randomBytes(32);
    const dekA1 = createDekFromMaterial(materialA);
    const dekA2 = createDekFromMaterial(materialA); // same DEK, fresh unwrap
    const dekB = createDekFromMaterial(randomBytes(32));
    expect(deriveBundleKey(dekA1).equals(deriveBundleKey(dekA2))).toBe(true);
    expect(deriveBundleKey(dekA1).equals(deriveBundleKey(dekB))).toBe(false);
  });
});
