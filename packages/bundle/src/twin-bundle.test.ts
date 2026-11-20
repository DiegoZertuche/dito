/**
 * The disabled-KMS-key refusal at the module boundary. Disabling the shared
 * live fixture key would break every parallel agent's tests, so this path is
 * exercised with a client whose send() rejects with the REAL error type KMS
 * returns for a disabled key (DisabledException from @aws-sdk/client-kms) —
 * the crypto path itself stays unmocked everywhere else (ADR-0028); the
 * wrong-key path runs against real KMS in twin-bundle.int.test.ts.
 */
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DisabledException, type KMSClient } from "@aws-sdk/client-kms";
import { describe, expect, it } from "vitest";
import { BundleKeyUnavailableError, openTwinBundle } from "./index.js";
import { useTmpDirs } from "./testing/tmp.js";

const tmpDir = useTmpDirs("dito-twin-bundle-");

/** A KMS whose key is disabled: every call fails exactly as live KMS fails. */
const disabledKeyKms = {
  send: () =>
    Promise.reject(
      new DisabledException({
        message:
          "arn:aws:kms:mx-central-1:000000000000:key/disabled is disabled.",
        $metadata: {},
      }),
    ),
} as unknown as KMSClient;

describe("disabled KMS key → open fails closed (typed, module boundary)", () => {
  it("refuses with BundleKeyUnavailableError carrying the real KMS error, and opens nothing", async () => {
    const path = join(tmpDir(), "twin.bundle");

    let caught: unknown;
    try {
      await openTwinBundle({
        kms: disabledKeyKms,
        twinId: "test-fixture",
        wrappedDek: randomBytes(64),
        path,
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(BundleKeyUnavailableError);
    const refusal = caught as BundleKeyUnavailableError;
    expect(refusal.kmsErrorName).toBe("DisabledException");
    expect(refusal.cause).toBeInstanceOf(DisabledException);
    // Fails closed: no plaintext fallback, and nothing was created on disk.
    expect(existsSync(path)).toBe(false);
  });
});
