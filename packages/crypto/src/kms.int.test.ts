/**
 * Envelope crypto against REAL dev-account KMS (ADR-0008, ADR-0028: the
 * crypto path is never mocked, no emulation).
 *
 * Cost note: one fixture key, get-or-create by alias, reused across every
 * run forever — KMS keys bill monthly and deletion has a 7-day minimum, so
 * nothing here ever creates a second key or schedules a deletion.
 *
 * CI: when AWS secrets are absent the workflow sets DITO_SKIP_KMS_TESTS=1
 * and annotates the run loudly; the tests are skipped, never mocked.
 */
import { describe, expect, it } from "vitest";
import { KMSClient } from "@aws-sdk/client-kms";
import { ensureTwinKey, generateWrappedDek, unwrapDek } from "./kms.js";

const skip = process.env["DITO_SKIP_KMS_TESTS"] === "1";

/** The one reused fixture twin: alias/dito-dev/twin-test-fixture. */
const FIXTURE_TWIN_ID = "test-fixture";

const MESSAGE = new TextEncoder().encode(
  "¿me mandas 40 cajas para el jueves?",
);

describe.skipIf(skip)("per-twin KMS envelope (real KMS, ADR-0008)", () => {
  const kms = new KMSClient({});

  it("ensureTwinKey is get-or-create by twin alias: two calls, one key", async () => {
    const first = await ensureTwinKey(kms, FIXTURE_TWIN_ID);
    const second = await ensureTwinKey(kms, FIXTURE_TWIN_ID);
    expect(first).toMatch(/^arn:aws:kms:/);
    expect(second).toBe(first);
  });

  it("round-trips: KMS-wrapped DEK encrypts, a fresh unwrap decrypts", async () => {
    await ensureTwinKey(kms, FIXTURE_TWIN_ID);
    const { dek, wrappedDek } = await generateWrappedDek(kms, FIXTURE_TWIN_ID);

    const blob = dek.encrypt(MESSAGE);

    // A different process would hold only wrappedDek: unwrap through KMS
    // and prove it opens the same envelope. The key is derived from the
    // twin id inside the module — never caller-supplied (ADR-0008).
    const unwrapped = await unwrapDek(kms, FIXTURE_TWIN_ID, wrappedDek);
    expect(
      Buffer.from(unwrapped.decrypt(blob)).equals(Buffer.from(MESSAGE)),
    ).toBe(true);
  });

  it("binds the wrap to the twin: another twin cannot unwrap — it has no key, and key selection is not caller-controllable", async () => {
    await ensureTwinKey(kms, FIXTURE_TWIN_ID);
    const { wrappedDek } = await generateWrappedDek(kms, FIXTURE_TWIN_ID);
    // The API takes only a twin id; a twin without a provisioned key is
    // refused at resolution (and the encryption context guards the KMS call
    // itself as defense in depth).
    await expect(
      unwrapDek(kms, "some-other-twin", wrappedDek),
    ).rejects.toThrow(/twin has no KMS key/);
  });

  it("KMS-produced DEKs carry the same custody: serialization is redaction", async () => {
    await ensureTwinKey(kms, FIXTURE_TWIN_ID);
    const { dek, wrappedDek } = await generateWrappedDek(kms, FIXTURE_TWIN_ID);
    expect(JSON.stringify(dek)).toBe('"[Dek redacted]"');
    // The wrapped DEK is ciphertext and may travel; it must not contain the
    // envelope blob's plaintext either (sanity: it is KMS ciphertext).
    expect(wrappedDek.length).toBeGreaterThan(0);
  });
});
