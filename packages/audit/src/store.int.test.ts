/**
 * Audit chain store integration tests (ticket #24, ADR-0020): atomic append
 * with a tail lock onto the append-only Postgres `audit_chain` table, and
 * end-to-end chain verification straight from the store.
 *
 * Real Postgres, migrations applied by the pinned Atlas (ADR-0028).
 */
import { beforeAll, describe, expect, it } from "vitest";
import { createHmac, randomBytes } from "node:crypto";
import pg from "pg";
import { appendAuditEntry, verifyAuditChainInDb } from "./store.js";
import type { AuditEntry } from "./chain.js";
import { resetAndMigrate, withClient } from "./testing/db.js";

const hmacKey = randomBytes(32);

/**
 * Independent computation of an entry hash (the chain format, restated here
 * from ADR-0020/the module docs, NOT imported from the module): HMAC-SHA256
 * over prev entry hash (empty for the first link) followed by the canonical
 * JSON array [caller, action, ref, outcome].
 */
function independentHash(prev: Buffer | null, entry: AuditEntry): Buffer {
  const h = createHmac("sha256", hmacKey);
  h.update(prev ?? Buffer.alloc(0));
  h.update(Buffer.from(JSON.stringify([entry.caller, entry.action, entry.ref, entry.outcome]), "utf8"));
  return h.digest();
}

/** Runs `fn` inside BEGIN…COMMIT on a fresh client (the appender's contract). */
async function inTransaction<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  return withClient(async (client) => {
    await client.query("BEGIN");
    try {
      const out = await fn(client);
      await client.query("COMMIT");
      return out;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
  });
}

beforeAll(async () => {
  await resetAndMigrate();
});

describe("appendAuditEntry (atomic chain append, ADR-0020)", () => {
  it("chains appended entries: stored hashes match independent HMAC computation", async () => {
    const first: AuditEntry = {
      caller: "affirmation_matcher",
      action: "customer_send",
      ref: "draft:11111111-1111-4111-8111-111111111111",
      outcome: "refused:off_allowlist",
    };
    const second: AuditEntry = {
      caller: "affirmation_matcher",
      action: "customer_send",
      ref: "draft:22222222-2222-4222-8222-222222222222",
      outcome: "refused:pacing",
    };
    await inTransaction((c) => appendAuditEntry(c, hmacKey, first));
    await inTransaction((c) => appendAuditEntry(c, hmacKey, second));

    const rows = await withClient(async (c) =>
      (
        await c.query(
          "SELECT caller, action, ref, outcome, prev_hash, entry_hash FROM audit_chain ORDER BY id",
        )
      ).rows,
    );
    expect(rows.length).toBe(2);
    expect(rows[0].prev_hash).toBeNull();
    const expectedFirst = independentHash(null, first);
    expect(Buffer.from(rows[0].entry_hash).equals(expectedFirst)).toBe(true);
    expect(Buffer.from(rows[1].prev_hash).equals(expectedFirst)).toBe(true);
    expect(
      Buffer.from(rows[1].entry_hash).equals(independentHash(expectedFirst, second)),
    ).toBe(true);
  });

  it("verifyAuditChainInDb reports the stored chain valid end to end", async () => {
    const res = await withClient((c) => verifyAuditChainInDb(c, hmacKey));
    expect(res.valid).toBe(true);
    expect(res.entries).toBe(2);
  });

  it("detects a forged row appended straight to the table, bypassing the chain", async () => {
    await withClient((c) =>
      c.query(
        `INSERT INTO audit_chain (caller, action, ref, outcome, prev_hash, entry_hash)
         VALUES ('forger', 'customer_send', NULL, 'sent', NULL, $1)`,
        [Buffer.from("not-a-real-hmac")],
      ),
    );
    const res = await withClient((c) => verifyAuditChainInDb(c, hmacKey));
    expect(res.valid).toBe(false);
  });
});

describe("key custody at the store (fail-closed)", () => {
  it("refuses to append under a strong but different key — key skew must not poison the chain", async () => {
    await resetAndMigrate();
    await inTransaction((c) =>
      appendAuditEntry(c, hmacKey, {
        caller: "affirmation_matcher",
        action: "customer_send",
        ref: "attempt:legit",
        outcome: "refused:pacing",
      }),
    );

    const otherKey = randomBytes(32);
    const entry: AuditEntry = {
      caller: "affirmation_matcher",
      action: "customer_send",
      ref: "attempt:key-skew",
      outcome: "refused:pacing",
    };
    await expect(
      inTransaction((c) => appendAuditEntry(c, otherKey, entry)),
    ).rejects.toThrow(/key/);
    // The chain is unchanged and still verifies under its own key.
    const res = await withClient((c) => verifyAuditChainInDb(c, hmacKey));
    expect(res.valid).toBe(true);
    const skewRows = await withClient(async (c) =>
      (await c.query("SELECT 1 FROM audit_chain WHERE ref = 'attempt:key-skew'")).rows,
    );
    expect(skewRows).toEqual([]);
  });

  it("refuses a weak HMAC key at both entry points — a short key makes every hash forgeable", async () => {
    const weak = randomBytes(8);
    const entry: AuditEntry = {
      caller: "affirmation_matcher",
      action: "customer_send",
      ref: null,
      outcome: "refused:pacing",
    };
    await expect(
      inTransaction((c) => appendAuditEntry(c, weak, entry)),
    ).rejects.toThrow(/32 bytes/);
    await expect(
      withClient((c) => verifyAuditChainInDb(c, weak)),
    ).rejects.toThrow(/32 bytes/);
  });
});

describe("the transaction contract", () => {
  it("refuses to append outside a transaction — an autocommit append could fork the chain", async () => {
    await expect(
      withClient((c) =>
        appendAuditEntry(c, hmacKey, {
          caller: "affirmation_matcher",
          action: "customer_send",
          ref: null,
          outcome: "refused:pacing",
        }),
      ),
    ).rejects.toThrow(/transaction/);
  });

  it("refuses an autocommit caller even when it holds an unrelated session advisory lock", async () => {
    await expect(
      withClient(async (c) => {
        // A session-scoped advisory lock survives between autocommit
        // statements — it must not be mistaken for an open transaction.
        await c.query("SELECT pg_advisory_lock(424242)");
        try {
          return await appendAuditEntry(c, hmacKey, {
            caller: "affirmation_matcher",
            action: "customer_send",
            ref: null,
            outcome: "refused:pacing",
          });
        } finally {
          await c.query("SELECT pg_advisory_unlock(424242)");
        }
      }),
    ).rejects.toThrow(/transaction/);
  });
});

describe("concurrent appends (the tail lock)", () => {
  it("eight concurrent appenders extend one chain — never fork it", async () => {
    // A fresh chain so the forged row above doesn't poison this verdict.
    await resetAndMigrate();
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        inTransaction((c) =>
          appendAuditEntry(c, hmacKey, {
            caller: "affirmation_matcher",
            action: "customer_send",
            ref: `attempt:${i}`,
            outcome: "refused:pacing",
          }),
        ),
      ),
    );
    const res = await withClient((c) => verifyAuditChainInDb(c, hmacKey));
    expect(res.entries).toBe(8);
    expect(res.valid).toBe(true);
  });
});
