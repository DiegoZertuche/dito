/**
 * The checked-in fixture generator (ADR-0028): turns a seed transcript
 * (fixtures/seeds/*.json) into a DEK-encrypted bundle under a real KMS
 * twin key. Integration tests — here and in every later slice — consume
 * its output instead of inventing their own bundle substrate. No mocked
 * crypto anywhere: the generator goes through the same createTwinBundle
 * path production uses.
 *
 * Output, per seed `<name>.json` in `outDir`:
 *   <name>.bundle      — the SQLCipher bundle (SQLCipher 4.x format)
 *   <name>.bundle.dek  — the KMS-wrapped DEK (binary; safe at rest, it is
 *                        KMS ciphertext under the twin's key, ADR-0008)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { KMSClient } from "@aws-sdk/client-kms";
import { generateWrappedDek } from "@dito/crypto";
import type { ConversationRow } from "../bundle.js";
import { createTwinBundle } from "../twin-bundle.js";
import { createBundleAtVersion } from "./aged-bundle.js";

export interface SeedTranscript {
  readonly description: string;
  readonly rows: readonly ConversationRow[];
}

/** Reads and shape-checks a checked-in seed transcript. */
export function readSeedTranscript(seedPath: string): SeedTranscript {
  const parsed = JSON.parse(readFileSync(seedPath, "utf8")) as SeedTranscript;
  if (typeof parsed.description !== "string" || !Array.isArray(parsed.rows)) {
    throw new Error(`not a seed transcript (description + rows): ${seedPath}`);
  }
  return parsed;
}

/**
 * Generates one DEK-encrypted fixture bundle from one seed transcript.
 * Returns the paths a consuming test needs: the bundle file and the
 * wrapped DEK written beside it.
 *
 * `atSchemaVersion` (ticket #31): generate the bundle exactly as the build
 * whose latest schema was that version would have written it — replayed
 * from the checked-in migration artifacts — so tests hold historically
 * shaped bundles (a slice-1-shaped one is `atSchemaVersion: 2`) alongside
 * current ones and can prove the forward migration at open. Omitted, the
 * bundle is current-shaped through the same createTwinBundle path
 * production uses.
 */
export async function generateFixtureBundle(options: {
  kms: KMSClient;
  twinId: string;
  seedPath: string;
  outDir: string;
  atSchemaVersion?: number;
}): Promise<{ bundlePath: string; wrappedDekPath: string }> {
  const { kms, twinId, seedPath, outDir, atSchemaVersion } = options;
  const seed = readSeedTranscript(seedPath);
  const name = basename(seedPath).replace(/\.json$/, "");
  const bundlePath = join(outDir, `${name}.bundle`);
  const wrappedDekPath = join(outDir, `${name}.bundle.dek`);

  if (atSchemaVersion === undefined) {
    const { bundle, wrappedDek } = await createTwinBundle({
      kms,
      twinId,
      path: bundlePath,
    });
    try {
      for (const row of seed.rows) bundle.ingestMessage(row);
    } finally {
      bundle.close();
    }
    writeFileSync(wrappedDekPath, wrappedDek);
  } else {
    // Historical shape: same real KMS-wrapped DEK, but the file is built
    // from exactly the migration artifacts the older build shipped.
    const { dek, wrappedDek } = await generateWrappedDek(kms, twinId);
    createBundleAtVersion(bundlePath, dek, atSchemaVersion, seed.rows);
    writeFileSync(wrappedDekPath, wrappedDek);
  }
  return { bundlePath, wrappedDekPath };
}
