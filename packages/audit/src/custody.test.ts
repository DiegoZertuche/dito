/**
 * HMAC key custody for the audit chain (ticket #24, ADR-0020).
 *
 * Slice-1 custody decision: the chain's HMAC key is an env-provided secret
 * (`DITO_AUDIT_HMAC_KEY`, hex) on the dev rig — fail-closed: a missing,
 * short, or malformed key refuses loudly, never a silent default.
 */
import { describe, expect, it } from "vitest";
import { hmacKeyFromEnv } from "./custody.js";

describe("hmacKeyFromEnv (ADR-0020 custody, fail-closed)", () => {
  it("decodes a 64-hex-char DITO_AUDIT_HMAC_KEY into 32 key bytes", () => {
    const key = hmacKeyFromEnv({
      DITO_AUDIT_HMAC_KEY: "00112233445566778899aabbccddeeff" + "00112233445566778899aabbccddeeff",
    });
    expect(key).toBeInstanceOf(Uint8Array);
    expect(key.length).toBe(32);
    // Known literal spot-check: first bytes decode as hex, not utf8.
    expect(key[0]).toBe(0x00);
    expect(key[1]).toBe(0x11);
    expect(key[31]).toBe(0xff);
  });

  it("refuses a missing key", () => {
    expect(() => hmacKeyFromEnv({})).toThrow(/DITO_AUDIT_HMAC_KEY/);
  });

  it("refuses a key shorter than 32 bytes", () => {
    expect(() => hmacKeyFromEnv({ DITO_AUDIT_HMAC_KEY: "aabbccdd" })).toThrow(
      /32 bytes/,
    );
  });

  it("refuses a non-hex key", () => {
    expect(() =>
      hmacKeyFromEnv({ DITO_AUDIT_HMAC_KEY: "z".repeat(64) }),
    ).toThrow(/hex/);
  });
});
