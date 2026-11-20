/**
 * The wrapped DEK's home (decision recorded on #20): per-twin state in
 * shared Postgres — `twin_keys` — because both custody processes (the Go
 * plane and the twin-runtime lease holder, ADR-0008) reach each other only
 * across the Postgres seam (ADR-0005), and the bundle file cannot hold its
 * own opening key. The column stores KMS ciphertext under the twin's own
 * key: never plaintext key material, and destroying the KMS key at
 * retirement makes the row useless noise (ADR-0009).
 *
 * Real Postgres; the KMS-crossing test runs against real dev-account KMS
 * (ADR-0028) and reuses the one fixture twin key.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KMSClient } from "@aws-sdk/client-kms";
import { createTwinBundle, openTwinBundle } from "@dito/bundle";
import { ensureTwinKey, generateWrappedDek, unwrapDek } from "@dito/crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { storeWrappedDek, loadWrappedDek } from "./twin-keys.js";
import { pgErrorCode, resetAndMigrate, withClient } from "./testing/db.js";

const skipKms = process.env["DITO_SKIP_KMS_TESTS"] === "1";

/** The one reused fixture twin: alias/dito-dev/twin-test-fixture. */
const FIXTURE_TWIN_ID = "test-fixture";

beforeAll(async () => {
  await resetAndMigrate();
});

describe("twin_keys: the wrapped DEK's home on the seam", () => {
  it("stores and loads a twin's wrapped DEK byte-for-byte", async () => {
    const twinId = randomUUID();
    const wrappedDek = randomBytes(72);
    await withClient(async (client) => {
      await storeWrappedDek(client, twinId, wrappedDek);
      const loaded = await loadWrappedDek(client, twinId);
      expect(loaded).toBeDefined();
      expect(Buffer.from(loaded!).equals(wrappedDek)).toBe(true);
    });
  });

  it("a twin with no stored key loads undefined — the caller must refuse, never guess", async () => {
    await withClient(async (client) => {
      expect(await loadWrappedDek(client, randomUUID())).toBeUndefined();
    });
  });

  it("one twin, one wrapped DEK: a second store is refused", async () => {
    const twinId = randomUUID();
    await withClient(async (client) => {
      await storeWrappedDek(client, twinId, randomBytes(72));
      let code: string | undefined;
      try {
        await storeWrappedDek(client, twinId, randomBytes(72));
      } catch (err) {
        code = pgErrorCode(err);
      }
      // unique_violation: the twin's memory is one file under one key
      // (ADR-0007) — rewrapping/rotation is an explicit later migration,
      // never a silent overwrite.
      expect(code).toBe("23505");
    });
  });

  it.skipIf(skipKms)(
    "a wrapped DEK that crossed the seam still unwraps under the twin's real KMS key",
    async () => {
      const kms = new KMSClient({});
      await ensureTwinKey(kms, FIXTURE_TWIN_ID);
      const { dek, wrappedDek } = await generateWrappedDek(
        kms,
        FIXTURE_TWIN_ID,
      );
      const sealed = dek.encrypt(
        new TextEncoder().encode("¿me mandas 40 cajas para el jueves?"),
      );

      // The seam row carries the twin's uuid; the KMS alias name of the
      // shared fixture twin is KMS-side identity only.
      const twinRowId = randomUUID();
      const loaded = await withClient(async (client) => {
        await storeWrappedDek(client, twinRowId, wrappedDek);
        return loadWrappedDek(client, twinRowId);
      });

      const unwrapped = await unwrapDek(kms, FIXTURE_TWIN_ID, loaded!);
      expect(
        Buffer.from(unwrapped.decrypt(sealed)).toString("utf8"),
      ).toContain("40 cajas");
    },
  );

  it.skipIf(skipKms)(
    "the whole thread: a bundle created for a twin opens again from the wrapped DEK loaded out of twin_keys",
    async () => {
      const kms = new KMSClient({});
      await ensureTwinKey(kms, FIXTURE_TWIN_ID);
      const dir = mkdtempSync(join(tmpdir(), "dito-twin-keys-int-"));
      try {
        const path = join(dir, "twin.bundle");
        const row = {
          chatJid: "5215550001@s.whatsapp.net",
          messageId: "3EB0-SEAM-1",
          senderJid: "5215550001@s.whatsapp.net",
          fromMe: false,
          occurredAt: "2026-08-27T16:00:00.000Z",
          content: "¿me apartas 12 garrafones?",
        };

        // Provision in the contract order: create, home the wrapped DEK on
        // the seam, and only then write twin memory — a crash before the
        // store loses an empty file, never rows a stored key can't reopen.
        const twinRowId = randomUUID();
        const { bundle, wrappedDek } = await createTwinBundle({
          kms,
          twinId: FIXTURE_TWIN_ID,
          path,
        });
        await withClient(async (client) => {
          await storeWrappedDek(client, twinRowId, wrappedDek);
        });
        bundle.ingestMessage(row);
        bundle.close();

        // A later lease holder starts from the seam row alone.
        const loaded = await withClient((client) =>
          loadWrappedDek(client, twinRowId),
        );
        const reopened = await openTwinBundle({
          kms,
          twinId: FIXTURE_TWIN_ID,
          wrappedDek: loaded!,
          path,
        });
        expect(reopened.readConversation(row.chatJid)).toEqual([row]);
        reopened.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
