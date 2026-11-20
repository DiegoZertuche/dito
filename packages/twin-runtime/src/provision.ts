/**
 * Twin provisioning and memory-open — the workflow the runtime owns (#20
 * hand-off). Provisioning order is the documented contract: ensureTwinKey
 * → createTwinBundle → storeWrappedDek → only then conversation rows. A
 * crash between create and store leaves an orphan file a stored key can
 * never reopen; that signature is refused loudly here — never adopted,
 * never auto-deleted (a misconfigured database URL must not cost twin
 * memory; the remedy is the operator's, per #20: remove the orphan and
 * re-provision).
 *
 * The KMS identity is the twin's uuid (the plane binds them, #22). The
 * separate `kmsTwinId` parameter exists ONLY for tests, which must reuse
 * the one shared fixture key — mirroring the plane's LoadSealer split; the
 * composed runtime binds both to the one twin id.
 */
import { existsSync } from "node:fs";
import type { KMSClient } from "@aws-sdk/client-kms";
import {
  BundleKeyUnavailableError,
  createTwinBundle,
  openBundle,
  type Bundle,
} from "@dito/bundle";
import { ensureTwinKey, unwrapDek, type Dek } from "@dito/crypto";
import { loadWrappedDek, storeWrappedDek } from "@dito/seam";
import type pg from "pg";

/** No stored wrapped DEK for this twin: provision first, never guess. */
export class TwinNotProvisionedError extends Error {
  override readonly name = "TwinNotProvisionedError";
  constructor(twinId: string) {
    super(`twin ${twinId} has no stored wrapped DEK (run provisionTwin first)`);
  }
}

/** A bundle file with no stored wrapped DEK — the crash-between-create-and-store signature (#20). */
export class OrphanBundleError extends Error {
  override readonly name = "OrphanBundleError";
  constructor(twinId: string, path: string) {
    super(
      `a bundle file exists at ${path} but twin ${twinId} has no stored wrapped DEK — ` +
        `either the database URL is wrong (fix it) or provisioning crashed before the ` +
        `store (#20: the file holds nothing a stored key can reopen — remove it and re-provision)`,
    );
  }
}

/** Provisioning an already-provisioned twin is refused, never repeated. */
export class TwinAlreadyProvisionedError extends Error {
  override readonly name = "TwinAlreadyProvisionedError";
  constructor(twinId: string) {
    super(`twin ${twinId} is already provisioned (one twin, one key, one bundle)`);
  }
}

export interface TwinMemoryOptions {
  readonly kms: KMSClient;
  readonly db: pg.Client;
  readonly twinId: string;
  readonly bundlePath: string;
}

/**
 * Provisions a twin in the #20 order, KMS identity bound to the twin id —
 * the package surface offers no lever to split them (mirroring the plane
 * binary's one-DITO_TWIN_ID binding, #22). On return the seam holds the
 * wrapped DEK and the bundle file exists, empty and reopenable — write
 * rows only through openTwinMemory afterwards.
 */
export async function provisionTwin(options: TwinMemoryOptions): Promise<void> {
  return provisionTwinWithKmsIdentity({ ...options, kmsTwinId: options.twinId });
}

/**
 * Opens a provisioned twin's memory: the wrapped DEK from the seam, a
 * fresh KMS unwrap, the bundle under the derived key. KMS identity is the
 * twin id, no lever. Returns the open bundle and the DEK — the runtime
 * needs both (payload decrypt and draft encrypt ride the same envelope,
 * ADR-0008). Every KMS failure is the inherited typed refusal
 * (BundleKeyUnavailableError); typed bundle errors propagate as refusals
 * to hold.
 */
export async function openTwinMemory(
  options: TwinMemoryOptions,
): Promise<{ bundle: Bundle; dek: Dek }> {
  return openTwinMemoryWithKmsIdentity({ ...options, kmsTwinId: options.twinId });
}

/**
 * TEST-FIXTURE ONLY (deliberately not re-exported from the package
 * index): in-package tests must reuse the one shared fixture key
 * (alias/dito-dev/twin-test-fixture) while the seam twin id stays a
 * uuid, so they alone may split the two identities — mirroring the
 * plane's LoadSealer split (#22). Production composition goes through
 * provisionTwin, which binds them.
 */
export async function provisionTwinWithKmsIdentity(
  options: TwinMemoryOptions & { readonly kmsTwinId: string },
): Promise<void> {
  const { kms, db, twinId, bundlePath, kmsTwinId } = options;

  const existing = await loadWrappedDek(db, twinId);
  if (existing !== undefined) throw new TwinAlreadyProvisionedError(twinId);
  if (existsSync(bundlePath)) throw new OrphanBundleError(twinId, bundlePath);

  await ensureTwinKey(kms, kmsTwinId);
  const { bundle, wrappedDek } = await createTwinBundle({
    kms,
    twinId: kmsTwinId,
    path: bundlePath,
  });
  // No rows before the store (#20): close the empty handle, persist the
  // key, and let openTwinMemory be the only writer's path in.
  bundle.close();
  await storeWrappedDek(db, twinId, wrappedDek);
}

/** TEST-FIXTURE ONLY — see provisionTwinWithKmsIdentity. */
export async function openTwinMemoryWithKmsIdentity(
  options: TwinMemoryOptions & { readonly kmsTwinId: string },
): Promise<{ bundle: Bundle; dek: Dek }> {
  const { kms, db, twinId, bundlePath, kmsTwinId } = options;

  const wrappedDek = await loadWrappedDek(db, twinId);
  if (wrappedDek === undefined) throw new TwinNotProvisionedError(twinId);
  let dek: Dek;
  try {
    dek = await unwrapDek(kms, kmsTwinId, wrappedDek);
  } catch (err) {
    // The inherited typed refusal (#20): KMS did not yield the DEK, the
    // bundle stays sealed — no raw SDK error escapes as the contract.
    throw new BundleKeyUnavailableError(twinId, err);
  }
  return { bundle: openBundle(bundlePath, dek), dek };
}
