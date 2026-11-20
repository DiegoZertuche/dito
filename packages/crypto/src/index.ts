/**
 * @dito/crypto — envelope crypto (ADR-0008).
 *
 * One KMS key per twin wraps that twin's DEK; content is DEK-encrypted from
 * the capture guard onward. Plaintext DEKs exist only inside the two custody
 * processes and are never exposed, logged, or serialized.
 *
 * No placeholder tests here: the crypto path is never mocked (ADR-0028) —
 * every test in this package is real (node:crypto locally, real dev-account
 * KMS in the integration lane).
 */

export {
  createDekFromMaterial,
  deriveBundleKey,
  type Dek,
} from "./dek.js";
export { ensureTwinKey, generateWrappedDek, unwrapDek } from "./kms.js";
