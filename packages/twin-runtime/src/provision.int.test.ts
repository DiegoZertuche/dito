/**
 * Twin provisioning and memory-open against REAL dev-account KMS, real
 * Postgres, real SQLCipher (ADR-0028) — the #20 provisioning contract:
 * ensureTwinKey → createTwinBundle → storeWrappedDek → only then rows.
 * Reuses the one fixture twin key (alias/dito-dev/twin-test-fixture);
 * nothing here creates, disables, or deletes keys.
 *
 * The seam twin id is a uuid (the KMS identity in production — the plane
 * binds them, #22); tests split the two ids because the shared fixture
 * alias is the only key allowed. The split parameter is test-fixture-only,
 * mirroring the plane's LoadSealer.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { KMSClient } from "@aws-sdk/client-kms";
import { BundleKeyUnavailableError } from "@dito/bundle";
import { ensureTwinKey } from "@dito/crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { processPendingWaEvents } from "./consumer.js";
import {
  OrphanBundleError,
  openTwinMemoryWithKmsIdentity,
  provisionTwinWithKmsIdentity,
  TwinAlreadyProvisionedError,
  TwinNotProvisionedError,
} from "./provision.js";
import {
  resetAndMigrate,
  withClient,
  TEST_AUDIT_HMAC_KEY,
} from "./testing/db.js";
import { removeTmpDir } from "./testing/tmp.js";
import { fakeEmbedder } from "./testing/fake-embedder.js";
import { neverSendLock } from "./testing/never-writer.js";
import { insertWaEvent } from "./testing/seam-fixtures.js";
import { closeScriptedModels, scriptedModel } from "./testing/scripted-model.js";
import { SETTLE_IMMEDIATELY } from "./testing/settle.js";
import { newExecutionPool } from "./testing/execution-pool.js";

// Every scripted model this suite opened is closed with it (#328).
afterAll(closeScriptedModels);

/** One connection source for every execution this suite runs (ticket #173). */
const executionPool = newExecutionPool();

const skip = process.env["DITO_SKIP_KMS_TESTS"] === "1";

describe("the built package surface (no KMS needed)", () => {
  // Probed through the real Node resolver in a child process — the
  // environment the composed runtime (#25/#26) actually imports from —
  // not vitest's own module graph.
  const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..");
  function nodeEval(script: string): string {
    return execFileSync(
      process.execPath,
      ["--input-type=module", "-e", script],
      { cwd: packageDir, encoding: "utf8" },
    ).trim();
  }

  it("the index exposes only twin-bound entry points — no split-identity lever", () => {
    const out = nodeEval(
      `import * as m from "@dito/twin-runtime";
       console.log(
         typeof m.provisionTwin,
         typeof m.openTwinMemory,
         typeof m.provisionTwinWithKmsIdentity,
         typeof m.openTwinMemoryWithKmsIdentity,
       );`,
    );
    expect(out).toBe("function function undefined undefined");
  });

  it("the dist subpath Codex bypassed (round 2) no longer resolves", () => {
    const out = nodeEval(
      `try {
         await import("@dito/twin-runtime/dist/provision.js");
         console.log("resolved");
       } catch (err) {
         console.log(err.code);
       }`,
    );
    expect(out).toBe("ERR_PACKAGE_PATH_NOT_EXPORTED");
  });
});

/** The one reused fixture twin key. */
const KMS_TWIN_ID = "test-fixture";
const SELF_CHAT = "5215550000@s.whatsapp.net";
const CHAT = "5215550001@s.whatsapp.net";

let tmp: string;

beforeAll(async () => {
  await resetAndMigrate();
  tmp = mkdtempSync(join(tmpdir(), "dito-twin-provision-int-"));
});

afterAll(() => {
  removeTmpDir(tmp);
});

describe.skipIf(skip)("twin provisioning (#20 contract) over real KMS", () => {
  const kms = new KMSClient({});

  it("provision → open → write → reopen: twin memory survives with only the seam-stored wrapped DEK", async () => {
    await ensureTwinKey(kms, KMS_TWIN_ID);
    await withClient(async (client) => {
      const twinId = randomUUID();
      const bundlePath = join(tmp, `${twinId}.bundle`);
      await provisionTwinWithKmsIdentity({
        kms,
        db: client,
        twinId,
        bundlePath,
        kmsTwinId: KMS_TWIN_ID,
      });

      const opened = await openTwinMemoryWithKmsIdentity({
        kms,
        db: client,
        twinId,
        bundlePath,
        kmsTwinId: KMS_TWIN_ID,
      });
      opened.bundle.ingestMessage({
        chatJid: CHAT,
        messageId: "3EB0-P1-1",
        senderJid: CHAT,
        fromMe: false,
        occurredAt: "2026-08-27T14:03:00.000Z",
        content: "¿me mandas 40 cajas para el jueves?",
      });
      opened.bundle.close();

      // A later holder has only the seam row: a fresh unwrap reopens the
      // same memory.
      const reopened = await openTwinMemoryWithKmsIdentity({
        kms,
        db: client,
        twinId,
        bundlePath,
        kmsTwinId: KMS_TWIN_ID,
      });
      expect(reopened.bundle.readConversation(CHAT)).toHaveLength(1);
      reopened.bundle.close();
    });
  });

  it("an unprovisioned twin refuses to open — no key, no memory, never a guess", async () => {
    await withClient(async (client) => {
      await expect(
        openTwinMemoryWithKmsIdentity({
          kms,
          db: client,
          twinId: randomUUID(),
          bundlePath: join(tmp, "nowhere.bundle"),
          kmsTwinId: KMS_TWIN_ID,
        }),
      ).rejects.toThrow(TwinNotProvisionedError);
    });
  });

  it("a bundle file with no stored wrapped DEK is refused loudly, never adopted and never deleted", async () => {
    await withClient(async (client) => {
      const twinId = randomUUID();
      const bundlePath = join(tmp, `${twinId}.bundle`);
      // The crash signature (#20): a file exists, the seam row does not.
      writeFileSync(bundlePath, "leftover");

      await expect(
        provisionTwinWithKmsIdentity({
          kms,
          db: client,
          twinId,
          bundlePath,
          kmsTwinId: KMS_TWIN_ID,
        }),
      ).rejects.toThrow(OrphanBundleError);
      await expect(
        openTwinMemoryWithKmsIdentity({
          kms,
          db: client,
          twinId,
          bundlePath,
          kmsTwinId: KMS_TWIN_ID,
        }),
      ).rejects.toThrow(TwinNotProvisionedError);
    });
  });

  it("provisioning twice is refused — one twin, one key, one bundle", async () => {
    await ensureTwinKey(kms, KMS_TWIN_ID);
    await withClient(async (client) => {
      const twinId = randomUUID();
      const bundlePath = join(tmp, `${twinId}.bundle`);
      await provisionTwinWithKmsIdentity({
        kms,
        db: client,
        twinId,
        bundlePath,
        kmsTwinId: KMS_TWIN_ID,
      });
      await expect(
        provisionTwinWithKmsIdentity({
          kms,
          db: client,
          twinId,
          bundlePath,
          kmsTwinId: KMS_TWIN_ID,
        }),
      ).rejects.toThrow(TwinAlreadyProvisionedError);
    });
  });

  it("a wrapped DEK KMS refuses seals the memory with the inherited typed refusal, never a raw SDK error", async () => {
    await ensureTwinKey(kms, KMS_TWIN_ID);
    await withClient(async (client) => {
      const twinId = randomUUID();
      const bundlePath = join(tmp, `${twinId}.bundle`);
      await provisionTwinWithKmsIdentity({
        kms,
        db: client,
        twinId,
        bundlePath,
        kmsTwinId: KMS_TWIN_ID,
      });
      // XOR the last ciphertext byte so the stored blob always differs from
      // what KMS wrote (a constant byte is already there one time in 256):
      // KMS itself refuses the unwrap, and the refusal surfaces typed (#20
      // contract).
      await client.query(
        `UPDATE twin_keys
            SET wrapped_dek = set_byte(wrapped_dek, octet_length(wrapped_dek) - 1, get_byte(wrapped_dek, octet_length(wrapped_dek) - 1) # 255)
          WHERE twin_id = $1`,
        [twinId],
      );

      let caught: unknown;
      try {
        await openTwinMemoryWithKmsIdentity({
          kms,
          db: client,
          twinId,
          bundlePath,
          kmsTwinId: KMS_TWIN_ID,
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(BundleKeyUnavailableError);
    });
  });

  it("the full production path: provisioned twin memory + KMS-unwrapped DEK feed the seam consumer end to end", async () => {
    await ensureTwinKey(kms, KMS_TWIN_ID);
    await withClient(async (client) => {
      const twinId = randomUUID();
      const bundlePath = join(tmp, `${twinId}.bundle`);
      await provisionTwinWithKmsIdentity({
        kms,
        db: client,
        twinId,
        bundlePath,
        kmsTwinId: KMS_TWIN_ID,
      });
      const { bundle, dek } = await openTwinMemoryWithKmsIdentity({
        kms,
        db: client,
        twinId,
        bundlePath,
        kmsTwinId: KMS_TWIN_ID,
      });

      await insertWaEvent(client, dek, {
        twinId,
        chatJid: CHAT,
        senderJid: CHAT,
        fromMe: false,
        messageId: "3EB0-P5-1",
        text: "¿tienen entrega el sábado?",
      });
      const { harness } = scriptedModel([
        { toolCall: { name: "create_draft", input: { text: "sí, hasta mediodía" } } },
        { text: "done" },
      ]);

      const result = await processPendingWaEvents({
        db: client,
        harness,
        bundle,
        dek,
        twinId,
        selfChatJid: SELF_CHAT,
        // Ticket #75: this suite is not about batching (see testing/settle.ts).
        ...SETTLE_IMMEDIATELY,
        drafting: { model: "claude-sonnet-5" },
        executionPool,
        sendLock: neverSendLock(),
        hmacKey: TEST_AUDIT_HMAC_KEY,
        embedder: fakeEmbedder(),
      });
      expect(result).toEqual({ processed: 1, drafted: 1 });
      expect(bundle.readConversation(CHAT)).toHaveLength(1);
      const commands = await client.query(
        "SELECT send_class, destination FROM send_commands WHERE twin_id = $1",
        [twinId],
      );
      expect(commands.rows).toEqual([
        { send_class: "system_send", destination: SELF_CHAT },
      ]);
      bundle.close();
    });
  });
});
