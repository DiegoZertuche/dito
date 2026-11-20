/**
 * The DEK half of envelope crypto (ADR-0008): a per-twin data encryption key
 * that encrypts content from the capture guard onward. Key material lives in
 * a module-private WeakMap — it is not a property of the instance, so no
 * serializer, logger, or reflection pass can reach it.
 */
import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import { inspect } from "node:util";

const DEK_LENGTH = 32; // AES-256
const IV_LENGTH = 12; // GCM standard nonce
const TAG_LENGTH = 16;
const BLOB_VERSION = 0x01;

/** Module-private custody: instance -> key material. */
const material = new WeakMap<Dek, Buffer>();

/**
 * An unwrapped DEK. The class itself is not exported as a value — the sole
 * construction point is createDekFromMaterial (used by the KMS unwrap path
 * in kms.ts and the checked-in fixture generator, ADR-0028), so custody is
 * structural, not a comment. Never leaves the process; never serializes.
 */
class Dek {
  constructor(keyMaterial: Uint8Array) {
    if (keyMaterial.length !== DEK_LENGTH) {
      throw new Error(
        `DEK material must be ${DEK_LENGTH} bytes, got ${keyMaterial.length}`,
      );
    }
    // Private copy: the caller's buffer can be zeroed without affecting us,
    // and mutating the caller's buffer later cannot corrupt the key.
    material.set(this, Buffer.from(keyMaterial));
  }

  /** Seals plaintext into the versioned envelope blob: version || iv || tag || ciphertext. */
  encrypt(plaintext: Uint8Array): Uint8Array {
    const key = material.get(this);
    if (key === undefined) throw new Error("DEK has no material");
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(plaintext),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([Buffer.from([BLOB_VERSION]), iv, tag, ciphertext]);
  }

  /** Opens an envelope blob; throws on tampering or a wrong key (GCM auth). */
  decrypt(blob: Uint8Array): Uint8Array {
    const key = material.get(this);
    if (key === undefined) throw new Error("DEK has no material");
    const buf = Buffer.from(blob);
    if (buf.length < 1 + IV_LENGTH + TAG_LENGTH || buf[0] !== BLOB_VERSION) {
      throw new Error("not a DEK envelope blob");
    }
    const iv = buf.subarray(1, 1 + IV_LENGTH);
    const tag = buf.subarray(1 + IV_LENGTH, 1 + IV_LENGTH + TAG_LENGTH);
    const ciphertext = buf.subarray(1 + IV_LENGTH + TAG_LENGTH);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  }

  /** Serialization is redaction, everywhere: JSON, template strings, console/util.inspect. */
  toJSON(): string {
    return REDACTED;
  }

  toString(): string {
    return REDACTED;
  }

  [inspect.custom](): string {
    return REDACTED;
  }
}

const REDACTED = "[Dek redacted]";

export type { Dek };

/**
 * The one construction point for a Dek (ADR-0008 custody): the KMS
 * unwrap/generate path and the test/fixture generator go through here. The
 * input buffer is copied; zero the original after calling.
 */
export function createDekFromMaterial(keyMaterial: Uint8Array): Dek {
  return new Dek(keyMaterial);
}

/** Domain separation for the SQLCipher bundle key (versioned: a new scheme is a new info string). */
const BUNDLE_KEY_INFO = "dito:bundle-key:v1";

/**
 * Derives the twin bundle's SQLCipher key from the DEK (ADR-0007: the bundle
 * opens only under the twin's key; ADR-0009: destroying the KMS key destroys
 * the only path to this derivation). HKDF-SHA-256, purpose-bound — the raw
 * DEK never leaves custody and is never reused raw in a second cipher
 * construction. Deterministic, so a bundle reopens under any fresh unwrap of
 * the same DEK. The caller must zero the returned buffer after keying the
 * bundle.
 */
export function deriveBundleKey(dek: Dek): Buffer {
  const key = material.get(dek);
  if (key === undefined) throw new Error("DEK has no material");
  return Buffer.from(
    hkdfSync("sha256", key, Buffer.alloc(0), BUNDLE_KEY_INFO, 32),
  );
}

