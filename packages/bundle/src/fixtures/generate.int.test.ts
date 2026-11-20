/**
 * The checked-in fixture generator (ADR-0028): seed transcripts in
 * fixtures/seeds/ become DEK-encrypted bundles under the real fixture twin
 * key, and integration tests consume its output — this is the substrate
 * contract every later slice's bundle fixtures inherit.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KMSClient } from "@aws-sdk/client-kms";
import { ensureTwinKey, unwrapDek } from "@dito/crypto";
import { afterEach, describe, expect, it } from "vitest";
import { BUNDLE_SCHEMA_VERSION, openTwinBundle } from "../index.js";
import { openKeyed } from "../keyed-db.js";
import { generateFixtureBundle, readSeedTranscript } from "./generate.js";

const skip = process.env["DITO_SKIP_KMS_TESTS"] === "1";

/** The one reused fixture twin: alias/dito-dev/twin-test-fixture. */
const FIXTURE_TWIN_ID = "test-fixture";

const SEED_PATH = new URL(
  "../../fixtures/seeds/rig-magic-loop.json",
  import.meta.url,
).pathname;

const dirs: string[] = [];
function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "dito-fixture-gen-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(skip)("fixture generator (real KMS + real SQLCipher, ADR-0028)", () => {
  const kms = new KMSClient({});

  it("produces a DEK-encrypted bundle from a seed transcript that opens only through KMS and holds exactly the seed", async () => {
    await ensureTwinKey(kms, FIXTURE_TWIN_ID);
    const outDir = tmpDir();

    const fixture = await generateFixtureBundle({
      kms,
      twinId: FIXTURE_TWIN_ID,
      seedPath: SEED_PATH,
      outDir,
    });

    // DEK-encrypted on disk: a real, non-plaintext SQLCipher file.
    const raw = readFileSync(fixture.bundlePath);
    expect(raw.length).toBeGreaterThan(0);
    expect(raw.subarray(0, 16).toString("latin1")).not.toContain(
      "SQLite format 3",
    );
    for (const row of readSeedTranscript(SEED_PATH).rows) {
      expect(raw.includes(Buffer.from(row.content, "utf8"))).toBe(false);
    }

    // A consuming test holds only the generator's output: the bundle file
    // and the wrapped DEK it wrote next to it.
    const wrappedDek = readFileSync(fixture.wrappedDekPath);
    const bundle = await openTwinBundle({
      kms,
      twinId: FIXTURE_TWIN_ID,
      wrappedDek,
      path: fixture.bundlePath,
    });

    const seed = readSeedTranscript(SEED_PATH);
    const chats = [...new Set(seed.rows.map((r) => r.chatJid))];
    const readBack = chats.flatMap((chat) => bundle.readConversation(chat));
    expect(readBack).toEqual(seed.rows);
    bundle.close();
  });

  it("produces a slice-1-shaped bundle on request, and opening it migrates forward in place (ticket #31; ADR-0029 over real KMS)", async () => {
    await ensureTwinKey(kms, FIXTURE_TWIN_ID);
    const outDir = tmpDir();

    // Tests hold BOTH shapes (ticket #31): the current one (above) and the
    // slice-1 one — a bundle exactly as the slice-1 build left it (schema
    // v2), under the same real KMS fixture key.
    const fixture = await generateFixtureBundle({
      kms,
      twinId: FIXTURE_TWIN_ID,
      seedPath: SEED_PATH,
      outDir,
      atSchemaVersion: 2,
    });

    // Still ciphertext — a historical shape is not a plaintext shape.
    const raw = readFileSync(fixture.bundlePath);
    expect(raw.subarray(0, 16).toString("latin1")).not.toContain(
      "SQLite format 3",
    );

    // Independently verify the stamp IS historical before any
    // current-build open touches it (module-internal keyed read — the
    // generator's promise is a v2 file, not a v2-then-migrated file).
    const wrappedDek = readFileSync(fixture.wrappedDekPath);
    const dek = await unwrapDek(kms, FIXTURE_TWIN_ID, wrappedDek);
    const stamped = openKeyed(fixture.bundlePath, dek, { fileMustExist: true });
    expect(stamped.pragma("user_version", { simple: true })).toBe(2);
    stamped.close();

    // The migrating open (spec #29 testing decision): forward, in place,
    // before any read — seed rows intact, the slice-2 interior born empty.
    const bundle = await openTwinBundle({
      kms,
      twinId: FIXTURE_TWIN_ID,
      wrappedDek,
      path: fixture.bundlePath,
    });
    expect(bundle.schemaVersion).toBe(BUNDLE_SCHEMA_VERSION);
    const seed = readSeedTranscript(SEED_PATH);
    const chats = [...new Set(seed.rows.map((r) => r.chatJid))];
    expect(chats.flatMap((chat) => bundle.readConversation(chat))).toEqual(
      seed.rows,
    );
    expect(bundle.listChatBindings()).toEqual([]);
    expect(bundle.countMessageVectors()).toBe(0);
    bundle.close();
  });
});
