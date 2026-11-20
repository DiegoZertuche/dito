/**
 * Scope in and scope out as rep acts (ticket #222 AC 4; spec #214 decisions 5
 * and 7; ADR-0003 class 2, ADR-0020, ADR-0023).
 *
 * Driven at the Postgres seam, which is where the whole claim lives: an act
 * moves the allowlist the capture guard reads, asks the plane for what it now
 * owes, and appends one content-free entry — all three in ONE TRANSACTION, or
 * none of them. The transaction is the CALLER's (`scoping.ts`'s header argues
 * why), so every call below opens one — which is exactly what
 * the dashboard act does around it, and why an act and its evidence commit
 * together.
 *
 * WHAT THE GUARD DOES ABOUT IT IS THE PLANE'S OWN TEST (`plane/ingest`), and
 * it has to be: the guard is Go, reads `scope_allowlist` per event, and caches
 * nothing (ADR-0023). What this file proves is the half the runtime owns —
 * that the row the guard reads has moved, and that the act left a trace.
 */
import { randomUUID } from "node:crypto";
import { verifyAuditChainInDb } from "@dito/audit";
import { PLANE_REQUEST_KINDS } from "@dito/seam";
import pg from "pg";
import { beforeAll, describe, expect, it } from "vitest";
import { withDbTransaction } from "./db-tx.js";
import {
  scopeChatIn,
  scopeChatOut,
  SCOPE_ACT_KINDS,
  DEFAULT_HISTORY_WINDOW_DAYS,
} from "./scoping.js";
import {
  resetAndMigrate,
  withClient,
  TEST_AUDIT_HMAC_KEY,
} from "./testing/db.js";

interface Recorded {
  readonly allowlisted: boolean;
  readonly requests: readonly {
    readonly id: string;
    readonly kind: string;
    readonly chat_jid: string | null;
    readonly outcome: string | null;
  }[];
  readonly entries: readonly {
    readonly caller: string;
    readonly action: string;
    readonly ref: string;
    readonly outcome: string;
  }[];
}

async function recorded(
  db: pg.ClientBase,
  twinId: string,
  chatJid: string,
): Promise<Recorded> {
  const allowlist = await db.query(
    "SELECT 1 FROM scope_allowlist WHERE twin_id = $1 AND chat_jid = $2",
    [twinId, chatJid],
  );
  const requests = await db.query(
    `SELECT id, kind, chat_jid, outcome FROM plane_requests
      WHERE twin_id = $1 ORDER BY requested_at, id`,
    [twinId],
  );
  const entries = await db.query(
    `SELECT caller, action, ref, outcome FROM audit_chain
      WHERE ref LIKE 'twin:' || $1 || '%' ORDER BY id`,
    [twinId],
  );
  return {
    allowlisted: allowlist.rowCount === 1,
    requests: requests.rows,
    entries: entries.rows,
  };
}

describe("scope in and scope out (ticket #222)", () => {
  beforeAll(async () => {
    await resetAndMigrate();
  });

  it("scope-in writes the allowlist row, the plane's request and one chain entry", async () => {
    await withClient(async (db) => {
      const twinId = randomUUID();
      const chatJid = "5215550401@s.whatsapp.net";

      const act = await withDbTransaction(db, () =>
        scopeChatIn({ db, hmacKey: TEST_AUDIT_HMAC_KEY, twinId }, { chatJid }),
      );
      expect(act.changed).toBe(true);

      const state = await recorded(db, twinId, chatJid);
      // THE ACT ITSELF: the row the capture guard reads per event, with no
      // caching, so the twin may read that chat from the moment this commits
      // (ADR-0023).
      expect(state.allowlisted).toBe(true);
      // ...AND WHAT THE PLANE NOW OWES: the ninety-day fill, unserved.
      expect(state.requests).toHaveLength(1);
      expect(state.requests[0]).toMatchObject({
        id: act.requestId,
        kind: "scope_in",
        chat_jid: chatJid,
        outcome: null,
      });
      // ...AND ONE CONTENT-FREE ENTRY. Opaque ids and one word: the CHAT is
      // deliberately not in it — the request row is what names the chat, and
      // the entry names the request.
      expect(state.entries).toHaveLength(1);
      expect(state.entries[0]).toMatchObject({
        caller: "twin-runtime/scoping",
        action: "scope_change",
        ref: `twin:${twinId} request:${act.requestId} act:none`,
        outcome: "scope_in:moved",
      });
      expect(state.entries[0]!.ref).not.toContain(chatJid);
      expect(state.entries[0]!.outcome).not.toContain(chatJid);
    });
  });

  it("scope-out deletes the allowlist row and writes its own request and entry", async () => {
    await withClient(async (db) => {
      const twinId = randomUUID();
      const chatJid = "5215550402@s.whatsapp.net";
      await withDbTransaction(db, () =>
        scopeChatIn({ db, hmacKey: TEST_AUDIT_HMAC_KEY, twinId }, { chatJid }),
      );

      const act = await withDbTransaction(db, () =>
        scopeChatOut({ db, hmacKey: TEST_AUDIT_HMAC_KEY, twinId }, { chatJid }),
      );
      expect(act.changed).toBe(true);

      const state = await recorded(db, twinId, chatJid);
      // THE ROW THE GUARD READS IS GONE. Nothing tells the plane: the read is
      // per event and uncached, so the very next message for that chat is
      // dropped at the socket (ADR-0023 — "instant descope is mechanically
      // true rather than cache-dependent"). The plane's own suite proves the
      // drop.
      expect(state.allowlisted).toBe(false);
      expect(state.requests.map((r) => r.kind)).toEqual([
        "scope_in",
        "scope_out",
      ]);
      expect(state.entries.map((e) => e.outcome)).toEqual([
        "scope_in:moved",
        "scope_out:moved",
      ]);
    });
  });

  it("a rep tapping a switch that was already in that position still performs an act", async () => {
    await withClient(async (db) => {
      const twinId = randomUUID();
      const chatJid = "5215550403@s.whatsapp.net";
      await withDbTransaction(db, () =>
        scopeChatIn({ db, hmacKey: TEST_AUDIT_HMAC_KEY, twinId }, { chatJid }),
      );

      // THE CHAIN RECORDS ACTS, NOT STATE CHANGES — the reading
      // `audit-coverage.ts` already applies to an idempotent binding
      // confirmation. So the second tap is chained too, and the outcome says
      // the allowlist did not move.
      const again = await withDbTransaction(db, () =>
        scopeChatIn({ db, hmacKey: TEST_AUDIT_HMAC_KEY, twinId }, { chatJid }),
      );
      expect(again.changed).toBe(false);

      const state = await recorded(db, twinId, chatJid);
      expect(state.allowlisted).toBe(true);
      expect(state.requests).toHaveLength(2);
      expect(state.entries.map((e) => e.outcome)).toEqual([
        "scope_in:moved",
        "scope_in:unchanged",
      ]);
    });
  });

  it("scope-out of a chat that was never in scope is an act with nothing to move", async () => {
    await withClient(async (db) => {
      const twinId = randomUUID();
      const chatJid = "5215550404@s.whatsapp.net";

      const act = await withDbTransaction(db, () =>
        scopeChatOut({ db, hmacKey: TEST_AUDIT_HMAC_KEY, twinId }, { chatJid }),
      );
      expect(act.changed).toBe(false);
      const state = await recorded(db, twinId, chatJid);
      expect(state.allowlisted).toBe(false);
      expect(state.entries.map((e) => e.outcome)).toEqual([
        "scope_out:unchanged",
      ]);
    });
  });

  it("all three writes or none: a refused request row takes the allowlist row with it", async () => {
    await withClient(async (db) => {
      const twinId = randomUUID();
      // An address the store's own CHECK refuses. A committed allowlist row
      // with no request row would be a chat the twin reads and never fills;
      // the transaction is what makes that unrepresentable.
      const notAnAddress = "Juan pidió 100 cajas";

      await expect(
        withDbTransaction(db, () =>
          scopeChatIn(
            { db, hmacKey: TEST_AUDIT_HMAC_KEY, twinId },
            { chatJid: notAnAddress },
          ),
        ),
      ).rejects.toThrow();

      const state = await recorded(db, twinId, notAnAddress);
      expect(state.allowlisted).toBe(false);
      expect(state.requests).toHaveLength(0);
      expect(state.entries).toHaveLength(0);
    });
  });

  it("the chain still verifies over every act", async () => {
    await withClient(async (db) => {
      const twinId = randomUUID();
      for (const chat of ["5215550405", "5215550406", "5215550407"]) {
        const jid = `${chat}@s.whatsapp.net`;
        await withDbTransaction(db, () =>
          scopeChatIn({ db, hmacKey: TEST_AUDIT_HMAC_KEY, twinId }, { chatJid: jid }),
        );
        await withDbTransaction(db, () =>
          scopeChatOut({ db, hmacKey: TEST_AUDIT_HMAC_KEY, twinId }, { chatJid: jid }),
        );
      }
      const verified = await verifyAuditChainInDb(db, TEST_AUDIT_HMAC_KEY);
      expect(verified.valid).toBe(true);
      expect(verified.entries).toBeGreaterThanOrEqual(6);
    });
  });

  it("takes BOTH spellings of a chat out of scope (Codex r1/r2)", async () => {
    await withClient(async (db) => {
      const twinId = randomUUID();
      // A CHAT FIRST SEEN LID-ADDRESSED is scoped in under its LID — the
      // plane's own canonicalization says «without an alternative the LID
      // itself is the identity — the allowlist can carry it» — and the guard
      // then resolves the pair, so an act that deleted one spelling would
      // leave the chat allowed and the plane still capturing.
      const pn = "5218110000777@s.whatsapp.net";
      const lid = "77712345@lid";
      await db.query(
        "INSERT INTO scope_allowlist (twin_id, chat_jid) VALUES ($1, $2), ($1, $3)",
        [twinId, pn, lid],
      );
      const out = await withDbTransaction(db, () =>
        scopeChatOut(
          { db, hmacKey: TEST_AUDIT_HMAC_KEY, twinId },
          { chatJid: pn, lidJid: lid },
        ),
      );
      expect(out.changed).toBe(true);
      const left = await db.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM scope_allowlist WHERE twin_id = $1",
        [twinId],
      );
      expect(left.rows[0]!.n).toBe(0);
      // ...AND THE REQUEST ROW STILL NAMES ONE CHAT, the row's own identity:
      // the plane acknowledges a scope-out and has nothing to reconcile.
      const asked = await db.query<{ chat_jid: string | null }>(
        "SELECT chat_jid FROM plane_requests WHERE twin_id = $1",
        [twinId],
      );
      expect(asked.rows.map((row) => row.chat_jid)).toEqual([pn]);
    });
  });

  it("a scope act writes the two kinds the store accepts and never the pairing ask", () => {
    // The pairing-code ask is a link credential the rep asked for rather than
    // a statement about what the twin may read; `link.ts` is its writer, and
    // it chains nothing.
    expect([...SCOPE_ACT_KINDS]).toEqual(["scope_in", "scope_out"]);
    expect(PLANE_REQUEST_KINDS).toContain("pairing_code");
    expect(SCOPE_ACT_KINDS).not.toContain("pairing_code");
  });

  it("the ninety days a twin is provisioned with is FR-15's product default", () => {
    // Read, not restated: the number the store is seeded with and the number
    // the scoping page promises are one value.
    expect(DEFAULT_HISTORY_WINDOW_DAYS).toBe(90);
  });
});
