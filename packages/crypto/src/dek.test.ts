/**
 * DEK envelope tests — real node:crypto, nothing mocked (ADR-0028). The KMS
 * wrap/unwrap half of the path is integration-tested in kms.int.test.ts
 * against real dev-account KMS.
 */
import { describe, expect, it } from "vitest";
import { createDekFromMaterial } from "./dek.js";

/** Independent worked example: 32 bytes of key material the test knows. */
const KEY_MATERIAL = Uint8Array.from(
  { length: 32 },
  (_, i) => (i * 7 + 3) % 256,
);

const MESSAGE = new TextEncoder().encode(
  "hola Sergio, va la cotización de 40 cajas",
);

describe("Dek envelope encryption", () => {
  it("round-trips: decrypt(encrypt(m)) is m, and the blob is not the plaintext", () => {
    const dek = createDekFromMaterial(KEY_MATERIAL);
    const blob = dek.encrypt(MESSAGE);

    expect(Buffer.from(blob).includes(Buffer.from(MESSAGE))).toBe(false);
    expect(Buffer.from(dek.decrypt(blob)).equals(Buffer.from(MESSAGE))).toBe(
      true,
    );
  });

  it("produces a fresh blob per call (unique IVs): same message, different ciphertext", () => {
    const dek = createDekFromMaterial(KEY_MATERIAL);
    const a = dek.encrypt(MESSAGE);
    const b = dek.encrypt(MESSAGE);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });
});

/** Every encoding the key material could leak through in a string. */
function leakEncodings(): string[] {
  const buf = Buffer.from(KEY_MATERIAL);
  return [buf.toString("hex"), buf.toString("base64"), buf.toString("latin1")];
}

function expectNoMaterial(rendered: string): void {
  for (const encoded of leakEncodings()) {
    expect(rendered).not.toContain(encoded);
  }
}

describe("Dek custody (ADR-0008: never exposed, logged, or serialized)", () => {
  it("serializes to an explicit redaction marker, never key bytes", async () => {
    const dek = createDekFromMaterial(KEY_MATERIAL);
    const { inspect } = await import("node:util");

    expect(JSON.stringify(dek)).toBe('"[Dek redacted]"');
    expect(JSON.stringify({ nested: { dek } })).toBe(
      '{"nested":{"dek":"[Dek redacted]"}}',
    );
    expect(String(dek)).toBe("[Dek redacted]");
    expect(inspect(dek)).toBe("[Dek redacted]");
    expect(inspect(dek, { showHidden: true, depth: null })).toBe(
      "[Dek redacted]",
    );
    expectNoMaterial(inspect(dek, { showHidden: true, depth: null }));
  });

  it("exposes no enumerable state: keys, entries, and spread are all empty", () => {
    const dek = createDekFromMaterial(KEY_MATERIAL);
    expect(Object.keys(dek)).toEqual([]);
    expect(Object.getOwnPropertyNames(dek)).toEqual([]);
    expect({ ...dek }).toEqual({});
  });

  it("leaks nothing through the error path: a failed decrypt carries no key material", () => {
    const dek = createDekFromMaterial(KEY_MATERIAL);
    const other = createDekFromMaterial(
      Uint8Array.from({ length: 32 }, (_, i) => (i * 13 + 1) % 256),
    );
    const blob = dek.encrypt(MESSAGE);
    try {
      other.decrypt(blob);
      expect.unreachable("decrypt with the wrong DEK must throw");
    } catch (err) {
      expectNoMaterial(
        JSON.stringify(err, Object.getOwnPropertyNames(err as object)),
      );
      expectNoMaterial(String((err as Error).stack ?? ""));
    }
  });

  it("rejects a tampered blob (auth), leaking nothing", () => {
    const dek = createDekFromMaterial(KEY_MATERIAL);
    const blob = Buffer.from(dek.encrypt(MESSAGE));
    const lastByte = blob.length - 1;
    blob[lastByte] = blob[lastByte]! ^ 0xff;
    try {
      dek.decrypt(blob);
      expect.unreachable("tampered blob must fail authentication");
    } catch (err) {
      expectNoMaterial(
        JSON.stringify(err, Object.getOwnPropertyNames(err as object)),
      );
    }
  });
});
