/**
 * The twin bundle against REAL dev-account KMS and REAL SQLCipher
 * (ADR-0028: the crypto path is never mocked). Reuses the one fixture twin
 * key (alias/dito-dev/twin-test-fixture) — nothing here creates keys,
 * disables keys, or schedules deletions; the shared fixture key must stay
 * usable for every parallel agent.
 *
 * CI: when AWS secrets are absent the workflow sets DITO_SKIP_KMS_TESTS=1
 * and annotates the run loudly; the tests are skipped, never mocked.
 */
import { join } from "node:path";
import { KMSClient } from "@aws-sdk/client-kms";
import { ensureTwinKey, generateWrappedDek } from "@dito/crypto";
import { describe, expect, it } from "vitest";
import {
  BUNDLE_SCHEMA_VERSION,
  BundleKeyUnavailableError,
  createTwinBundle,
  openTwinBundle,
  type ConversationRow,
} from "./index.js";
import { createBundleAtVersion } from "./fixtures/aged-bundle.js";
import { useTmpDirs } from "./testing/tmp.js";

const skip = process.env["DITO_SKIP_KMS_TESTS"] === "1";

/** The one reused fixture twin: alias/dito-dev/twin-test-fixture. */
const FIXTURE_TWIN_ID = "test-fixture";
const CHAT = "5215550001@s.whatsapp.net";
const SELF = "5215550000@s.whatsapp.net";

const TRANSCRIPT: ConversationRow[] = [
  {
    chatJid: CHAT,
    messageId: "3EB0-RT-1",
    senderJid: CHAT,
    fromMe: false,
    occurredAt: "2026-08-27T14:03:00.000Z",
    content: "¿me mandas 40 cajas para el jueves?",
  },
  {
    chatJid: CHAT,
    messageId: "3EB0-RT-2",
    senderJid: SELF,
    fromMe: true,
    occurredAt: "2026-08-27T14:05:30.000Z",
    content: "claro, se las mando el jueves temprano",
  },
];

const tmpDir = useTmpDirs("dito-twin-bundle-int-");

describe.skipIf(skip)("twin bundle over real KMS (ADR-0007/0008/0028)", () => {
  const kms = new KMSClient({});

  it("full round-trip: create → open → migrate → write conversation rows → read", async () => {
    await ensureTwinKey(kms, FIXTURE_TWIN_ID);
    const path = join(tmpDir(), "twin.bundle");

    // Create under a fresh DEK wrapped by the twin's real KMS key.
    const { bundle, wrappedDek } = await createTwinBundle({
      kms,
      twinId: FIXTURE_TWIN_ID,
      path,
    });
    for (const row of TRANSCRIPT) bundle.ingestMessage(row);
    bundle.close();

    // A later holder has only the wrapped DEK: a fresh KMS unwrap opens
    // the same file (running the at-open migration path) and reads the
    // same conversation.
    const reopened = await openTwinBundle({
      kms,
      twinId: FIXTURE_TWIN_ID,
      wrappedDek,
      path,
    });
    expect(reopened.readConversation(CHAT)).toEqual(TRANSCRIPT);
    reopened.close();
  });

  it("migrating open under a KMS-unwrapped DEK: an older build's bundle moves forward at open, rows intact", async () => {
    await ensureTwinKey(kms, FIXTURE_TWIN_ID);
    const path = join(tmpDir(), "twin.bundle");

    // An aged v1 bundle whose DEK is wrapped by the twin's real KMS key —
    // exactly what a restored twin looks like after a build upgrade.
    const { dek, wrappedDek } = await generateWrappedDek(kms, FIXTURE_TWIN_ID);
    createBundleAtVersion(path, dek, 1, [TRANSCRIPT[0]!]);

    const opened = await openTwinBundle({
      kms,
      twinId: FIXTURE_TWIN_ID,
      wrappedDek,
      path,
    });
    expect(opened.schemaVersion).toBe(BUNDLE_SCHEMA_VERSION);
    expect(opened.readConversation(CHAT)).toEqual([TRANSCRIPT[0]]);
    // Post-migration writes land in the migrated schema...
    opened.ingestMessage(TRANSCRIPT[1]!);
    opened.close();

    // ...and a second KMS-unwrapped open is idempotent: nothing migrates
    // again, and both the pre- and post-migration rows read back.
    const reopened = await openTwinBundle({
      kms,
      twinId: FIXTURE_TWIN_ID,
      wrappedDek,
      path,
    });
    expect(reopened.schemaVersion).toBe(BUNDLE_SCHEMA_VERSION);
    expect(reopened.readConversation(CHAT)).toEqual(TRANSCRIPT);
    reopened.close();
  });

  it("wrong key material, for real: tampered wrapped-DEK ciphertext is refused by KMS and the bundle stays sealed", async () => {
    await ensureTwinKey(kms, FIXTURE_TWIN_ID);
    const path = join(tmpDir(), "twin.bundle");
    const { bundle, wrappedDek } = await createTwinBundle({
      kms,
      twinId: FIXTURE_TWIN_ID,
      path,
    });
    bundle.close();

    // Flip one ciphertext byte: KMS itself refuses the unwrap (the real
    // wrong-key signal), and open fails closed with the typed error.
    const tampered = Uint8Array.from(wrappedDek);
    const last = tampered.length - 1;
    tampered[last] = tampered[last]! ^ 0xff;

    let caught: unknown;
    try {
      await openTwinBundle({
        kms,
        twinId: FIXTURE_TWIN_ID,
        wrappedDek: tampered,
        path,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BundleKeyUnavailableError);
    expect((caught as BundleKeyUnavailableError).kmsErrorName).toBe(
      "InvalidCiphertextException",
    );
  });

  it("a twin without a key cannot open anything: refused at key resolution, fail closed", async () => {
    await ensureTwinKey(kms, FIXTURE_TWIN_ID);
    const path = join(tmpDir(), "twin.bundle");
    const { bundle, wrappedDek } = await createTwinBundle({
      kms,
      twinId: FIXTURE_TWIN_ID,
      path,
    });
    bundle.close();

    let caught: unknown;
    try {
      await openTwinBundle({
        kms,
        twinId: "some-other-twin",
        wrappedDek,
        path,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BundleKeyUnavailableError);
    expect(((caught as BundleKeyUnavailableError).cause as Error).message).toMatch(
      /twin has no KMS key/,
    );
  });
});
