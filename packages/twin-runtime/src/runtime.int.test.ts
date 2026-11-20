/**
 * The runtime loop: the seam consumer on a poll interval — the piece the
 * rig binary runs. Same seams as the consumer tests; the loop must pick
 * up traffic that arrives while it runs, and fail-stop loudly rather than
 * spin past a broken seam.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBundle } from "@dito/bundle";
import { createDekFromMaterial } from "@dito/crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runTwinRuntime } from "./runtime.js";
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

const SELF_CHAT = "5215550000@s.whatsapp.net";
const CHAT = "5215550001@s.whatsapp.net";

let tmp: string;

beforeAll(async () => {
  await resetAndMigrate();
  tmp = mkdtempSync(join(tmpdir(), "dito-twin-runtime-loop-"));
});

afterAll(() => {
  removeTmpDir(tmp);
});

async function until(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("condition not reached in time");
}

describe("the twin-runtime poll loop", () => {
  it("drafts traffic that arrives while it runs, and stops on abort", async () => {
    await withClient(async (client) => {
      const twinId = randomUUID();
      const dek = createDekFromMaterial(randomBytes(32));
      const bundle = createBundle(join(tmp, `${twinId}.bundle`), dek);
      const { harness } = scriptedModel([
        { toolCall: { name: "create_draft", input: { text: "sí, claro" } } },
        { text: "done" },
      ]);
      const controller = new AbortController();

      const run = runTwinRuntime(
        {
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
        },
        { pollIntervalMs: 25, signal: controller.signal },
      );

      // Traffic lands after the loop is already running.
      await insertWaEvent(client, dek, {
        twinId,
        chatJid: CHAT,
        senderJid: CHAT,
        fromMe: false,
        messageId: "3EB0-L1-1",
        text: "¿me mandas la lista de precios?",
      });

      await until(async () => {
        const res = await client.query(
          "SELECT id FROM send_commands WHERE twin_id = $1",
          [twinId],
        );
        return res.rows.length === 1;
      }, 5000);

      controller.abort();
      await run; // resolves cleanly on abort
      bundle.close();
    });
  });

  it("embeds the waiting backlog at start — a migrated bundle's history is searchable without waiting for new traffic (ticket #32)", async () => {
    await withClient(async (client) => {
      const twinId = randomUUID();
      const dek = createDekFromMaterial(randomBytes(32));
      const bundle = createBundle(join(tmp, `${twinId}.bundle`), dek);
      // History without vectors: the shape the slice-1 rig bundle wakes
      // up in after its in-place migration — no seam event will ever
      // re-deliver these, so only the runtime's own backlog pass can
      // make them retrievable.
      bundle.ingestMessage({
        chatJid: CHAT,
        messageId: "3EB0-L3-1",
        senderJid: CHAT,
        fromMe: false,
        occurredAt: "2026-08-27T09:00:00.000Z",
        content: "¿tiene precio de mayoreo?",
      });
      expect(bundle.countMessageVectors()).toBe(0);

      const { harness } = scriptedModel([]);
      const controller = new AbortController();
      const run = runTwinRuntime(
        {
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
        },
        { pollIntervalMs: 25, signal: controller.signal },
      );

      await until(
        () => Promise.resolve(bundle.countMessageVectors() === 1),
        5000,
      );
      controller.abort();
      await run;
      bundle.close();
    });
  });

  it("an already-aborted signal starts no work at all — not even the backlog pass (Codex r2)", async () => {
    await withClient(async (client) => {
      const twinId = randomUUID();
      const dek = createDekFromMaterial(randomBytes(32));
      const bundle = createBundle(join(tmp, `${twinId}.bundle`), dek);
      bundle.ingestMessage({
        chatJid: CHAT,
        messageId: "3EB0-L4-1",
        senderJid: CHAT,
        fromMe: false,
        occurredAt: "2026-08-27T09:00:00.000Z",
        content: "¿tiene precio de mayoreo?",
      });

      const controller = new AbortController();
      controller.abort();
      const { harness } = scriptedModel([]);
      // Aborted before the call: the run resolves cleanly having touched
      // nothing — an embedder that would throw is never invoked.
      await runTwinRuntime(
        {
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
          embedder: {
            embed: () =>
              Promise.reject(new Error("embedder must never be called")),
          },
        },
        { pollIntervalMs: 25, signal: controller.signal },
      );
      expect(bundle.countMessageVectors()).toBe(0);
      bundle.close();
    });
  });

  // The poison row was a `reaction` until #97 taught the runtime to speak
  // one; it is a `receipt` now. What is under test is unchanged: an event
  // type this build cannot read stops the loop instead of being skipped.
  it("fail-stops loudly when the seam cannot be processed", async () => {
    await withClient(async (client) => {
      const twinId = randomUUID();
      const dek = createDekFromMaterial(randomBytes(32));
      const bundle = createBundle(join(tmp, `${twinId}.bundle`), dek);
      await insertWaEvent(client, dek, {
        twinId,
        chatJid: CHAT,
        senderJid: CHAT,
        fromMe: false,
        messageId: "3EB0-L2-1",
        text: "x",
        eventType: "receipt",
      });
      const { harness } = scriptedModel([]);

      await expect(
        runTwinRuntime(
          {
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
          },
          { pollIntervalMs: 25 },
        ),
      ).rejects.toThrow(/event type/);
      bundle.close();
    });
  });
});
