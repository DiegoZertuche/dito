/**
 * The twin-level bundle seam (ADR-0007 × ADR-0008): give it the twin's
 * identity and wrapped DEK, get an open bundle or a typed refusal. The DEK
 * is unwrapped through the twin's own KMS key (resolved inside
 * @dito/crypto — never caller-selectable) and every KMS failure — disabled
 * key, destroyed key, tampered ciphertext, missing key — seals the bundle
 * shut: there is no plaintext fallback path.
 */
import type { KMSClient } from "@aws-sdk/client-kms";
import { generateWrappedDek, unwrapDek } from "@dito/crypto";
import { createBundle, openBundle, type Bundle } from "./bundle.js";
import { BundleKeyUnavailableError } from "./errors.js";

/**
 * Creates a twin's bundle: a fresh DEK is generated under the twin's KMS
 * key and the file is created, stamped, and migrated under it. Returns the
 * wrapped DEK — the caller persists it (twin_keys on the Postgres seam);
 * the plaintext DEK never leaves this process (ADR-0008).
 *
 * Provisioning contract (the twin-runtime owns the workflow): store the
 * wrapped DEK in twin_keys BEFORE writing any conversation row. A crash
 * between create and store then loses only an empty file — delete it and
 * re-provision; never write twin memory a stored key cannot reopen.
 */
export async function createTwinBundle(options: {
  kms: KMSClient;
  twinId: string;
  path: string;
}): Promise<{ bundle: Bundle; wrappedDek: Uint8Array }> {
  const { kms, twinId, path } = options;
  let dek;
  let wrappedDek;
  try {
    ({ dek, wrappedDek } = await generateWrappedDek(kms, twinId));
  } catch (err) {
    throw new BundleKeyUnavailableError(twinId, err);
  }
  return { bundle: createBundle(path, dek), wrappedDek };
}

/**
 * Opens a twin's bundle from its wrapped DEK. A wrong or disabled KMS key
 * fails closed with BundleKeyUnavailableError before the file is touched;
 * a DEK that unwraps but does not open the file fails closed with
 * WrongBundleKeyError. Forward-only migrations run at open (ADR-0029).
 */
export async function openTwinBundle(options: {
  kms: KMSClient;
  twinId: string;
  wrappedDek: Uint8Array;
  path: string;
}): Promise<Bundle> {
  const { kms, twinId, wrappedDek, path } = options;
  let dek;
  try {
    dek = await unwrapDek(kms, twinId, wrappedDek);
  } catch (err) {
    throw new BundleKeyUnavailableError(twinId, err);
  }
  return openBundle(path, dek);
}
