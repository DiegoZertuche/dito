/**
 * THE OWNER SIDE'S CHAIN, AT THE POSTGRES SEAM (ticket #165; the decision on
 * #157; ADR-0020 as amended 2026-09-03).
 *
 * `store.int.test.ts` beside this one is the rep side's, and it is untouched:
 * the rep chain keeps its schema, its key and its append path. This file is
 * that suite's sibling for the other chain — `owner.audit_chain`, one per
 * company by forced row-level security, appended under the owner's own key.
 *
 * WHAT IS DIFFERENT HERE, and therefore what is asserted:
 *
 *   THE COMPANY IS ON THE ROW, ON THE LOCK AND IN THE TAIL READ. The rep
 *   chain is one sequence of links; this is one per company inside one table.
 *   Two companies must not chain onto each other's tails, and eight appenders
 *   across two of them must fork neither chain.
 *
 *   THE FILTER IS IN THE STATEMENT AS WELL AS IN THE POLICY. Row-level
 *   security filters the tail for `dito_owner`; a SUPERUSER caller — this
 *   suite's own `db` client, and `scripts/` — is exempt from it, so a function
 *   that leaned on the policy alone would chain company A's entry onto company
 *   B's tail the moment anything ran as `dito`. Both readers are exercised.
 *
 *   THE KEY IS THE OWNER'S. A rep-side key must not authenticate an owner
 *   entry: the two chains are two secrets (ADR-0002, #157 decision 3).
 *
 *   AND `dito_owner` HOLDS NOTHING ON THE REP CHAIN. SELECT and INSERT on
 *   `public.audit_chain` are each refused 42501 — the grant #157 took away,
 *   asserted over a real connection rather than only in the grant diff.
 *
 * Real Postgres, migrations applied by the pinned Atlas (ADR-0028). No test
 * here calls a model.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import pg from "pg";
import {
  appendAuditEntry,
  appendOwnerAuditEntry,
  verifyOwnerAuditChainsInDb,
} from "./store.js";
import type { AuditEntry } from "./chain.js";
import {
  borrowOwnerPassword,
  OWNER_TEST_PASSWORD,
  pgErrorCode,
  resetAndMigrate,
  TEST_DATABASE_URL,
  withClient,
  withRoleClient,
  type BorrowedOwnerPassword,
} from "./testing/db.js";
import { OWNER_COMPANY_SETTING, OWNER_ROLE } from "./testing/owner.js";

const exec = promisify(execFile);
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");

const ownerKey = randomBytes(32);
/** The rep side's, so "not under the rep key" is a claim about two real keys. */
const repKey = randomBytes(32);

const COMPANY_A = "a0000000-0000-4000-8000-000000000001";
const COMPANY_B = "b0000000-0000-4000-8000-000000000002";

/**
 * Independent computation of an entry hash (the chain format, restated here
 * from ADR-0020/the module docs, NOT imported from the module): HMAC-SHA256
 * over the previous entry hash (empty for the first link) followed by the
 * canonical JSON array [caller, action, ref, outcome].
 *
 * THE COMPANY IS NOT IN IT, and that is an assertion rather than an omission:
 * the entry ADR-0020 defines is content-free and identical on both chains, so
 * the tenant partitions the table and never the digest. A writer that folded
 * it in would stop matching this literal.
 */
function independentHash(
  key: Uint8Array,
  prev: Buffer | null,
  entry: AuditEntry,
): Buffer {
  const h = createHmac("sha256", key);
  h.update(prev ?? Buffer.alloc(0));
  h.update(
    Buffer.from(
      JSON.stringify([entry.caller, entry.action, entry.ref, entry.outcome]),
      "utf8",
    ),
  );
  return h.digest();
}

/** An execution entry, distinguishable by the question its ref names. */
function entryFor(questionId: string): AuditEntry {
  return {
    caller: "execution",
    action: "execution",
    ref: `trigger:owner_question owner_question:${questionId}`,
    outcome: "answered",
  };
}

/** Runs `fn` inside BEGIN…COMMIT on a fresh SUPERUSER client. */
async function inTransaction<T>(
  fn: (client: pg.Client) => Promise<T>,
): Promise<T> {
  return withClient((client) => commitOrRollback(client, fn));
}

/**
 * ...and the same inside a connection AUTHENTICATED as `dito_owner` with a
 * company declared — the principal the policies bind, which is the one a
 * claim about the ROLE has to be made through (ticket #127's shape).
 */
async function asOwner<T>(
  companyId: string,
  fn: (client: pg.Client) => Promise<T>,
): Promise<T> {
  return withRoleClient(OWNER_ROLE, OWNER_TEST_PASSWORD, async (client) => {
    await client.query("SELECT set_config($1, $2, false)", [
      OWNER_COMPANY_SETTING,
      companyId,
    ]);
    return commitOrRollback(client, fn);
  });
}

async function commitOrRollback<T>(
  client: pg.Client,
  fn: (client: pg.Client) => Promise<T>,
): Promise<T> {
  await client.query("BEGIN");
  try {
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}

/** The SQLSTATE `statement` fails with as `dito_owner`, or null if it does not. */
async function refusedAsOwner(statement: string): Promise<string | undefined | null> {
  return withRoleClient(OWNER_ROLE, OWNER_TEST_PASSWORD, async (client) => {
    try {
      await client.query(statement);
      return null;
    } catch (err) {
      return pgErrorCode(err);
    }
  });
}

let ownerPassword: BorrowedOwnerPassword | null = null;

beforeAll(async () => {
  await resetAndMigrate();
  ownerPassword = await borrowOwnerPassword(OWNER_ROLE);
});

// The role is cluster-global and every other suite in this lane shares it,
// so the verifier goes back exactly as it was found (#133).
afterAll(async () => {
  await ownerPassword?.restore();
});

describe("appendOwnerAuditEntry (one chain per company, ADR-0020 as amended)", () => {
  it("chains a company's entries: stored hashes match independent HMAC computation", async () => {
    const first = entryFor(randomUUID());
    const second = entryFor(randomUUID());
    await asOwner(COMPANY_A, (c) =>
      appendOwnerAuditEntry(c, ownerKey, COMPANY_A, first),
    );
    await asOwner(COMPANY_A, (c) =>
      appendOwnerAuditEntry(c, ownerKey, COMPANY_A, second),
    );

    const rows = await withClient(async (c) =>
      (
        await c.query(
          `SELECT prev_hash, entry_hash FROM owner.audit_chain
            WHERE company_id = $1 ORDER BY id`,
          [COMPANY_A],
        )
      ).rows,
    );
    expect(rows.length).toBe(2);
    expect(rows[0].prev_hash).toBeNull();
    const expectedFirst = independentHash(ownerKey, null, first);
    expect(Buffer.from(rows[0].entry_hash).equals(expectedFirst)).toBe(true);
    expect(Buffer.from(rows[1].prev_hash).equals(expectedFirst)).toBe(true);
    expect(
      Buffer.from(rows[1].entry_hash).equals(
        independentHash(ownerKey, expectedFirst, second),
      ),
    ).toBe(true);
  });

  it("does not authenticate under the rep side's key — two chains, two secrets", async () => {
    const stored = await withClient(async (c) =>
      (
        await c.query<{
          caller: string;
          action: string;
          ref: string | null;
          outcome: string;
          entry_hash: Buffer;
        }>(
          `SELECT caller, action, ref, outcome, entry_hash FROM owner.audit_chain
            WHERE company_id = $1 ORDER BY id LIMIT 1`,
          [COMPANY_A],
        )
      ).rows[0]!,
    );
    const underRepKey = independentHash(repKey, null, {
      caller: stored.caller,
      action: stored.action as AuditEntry["action"],
      ref: stored.ref,
      outcome: stored.outcome,
    });
    expect(Buffer.from(stored.entry_hash).equals(underRepKey)).toBe(false);
  });

  it("verifies every company's chain under the owner key: one verdict, and one per company", async () => {
    await asOwner(COMPANY_B, (c) =>
      appendOwnerAuditEntry(c, ownerKey, COMPANY_B, entryFor(randomUUID())),
    );
    const res = await withClient((c) => verifyOwnerAuditChainsInDb(c, ownerKey));
    expect(res.valid).toBe(true);
    expect(res.entries).toBe(3);
    expect(res.companies).toEqual([
      { companyId: COMPANY_A, valid: true, entries: 2 },
      { companyId: COMPANY_B, valid: true, entries: 1 },
    ]);
  });

  it("detects a forged row written straight to the table, and names only that company", async () => {
    await withClient((c) =>
      c.query(
        `INSERT INTO owner.audit_chain
           (company_id, caller, action, ref, outcome, prev_hash, entry_hash)
         VALUES ($1, 'forger', 'execution', NULL, 'answered', NULL, $2)`,
        [COMPANY_B, Buffer.from("not-a-real-hmac")],
      ),
    );
    const res = await withClient((c) => verifyOwnerAuditChainsInDb(c, ownerKey));
    expect(res.valid).toBe(false);
    expect(res.companies).toContainEqual({
      companyId: COMPANY_A,
      valid: true,
      entries: 2,
    });
    expect(res.companies).toContainEqual({
      companyId: COMPANY_B,
      valid: false,
      entries: 2,
    });
  });
});

describe("key custody at the owner store (fail-closed)", () => {
  it("refuses to append under a strong but different key — key skew must not poison the chain", async () => {
    await resetAndMigrate();
    await asOwner(COMPANY_A, (c) =>
      appendOwnerAuditEntry(c, ownerKey, COMPANY_A, entryFor(randomUUID())),
    );

    await expect(
      asOwner(COMPANY_A, (c) =>
        appendOwnerAuditEntry(c, repKey, COMPANY_A, entryFor(randomUUID())),
      ),
    ).rejects.toThrow(/key/);
    // The chain is unchanged and still verifies under its own key.
    const res = await withClient((c) => verifyOwnerAuditChainsInDb(c, ownerKey));
    expect(res.valid).toBe(true);
    expect(res.entries).toBe(1);
  });

  it("accepts ANY strong key for a company's FIRST entry, and is then unextendable — recorded, not fixed (#165, Codex r1)", async () => {
    // THE WINDOW THIS PINS, because it is the one place the split WIDENED a
    // property rather than keeping it. `authenticatedTail` has nothing to
    // authenticate against when a chain is empty, so the first append commits
    // under any key of sufficient length. The rep side has always had that —
    // once, for the first entry the deployment ever wrote. The owner side is
    // one chain PER COMPANY, so the window reopens for every new company: a
    // miswired key on a company's first execution poisons that company's
    // chain, permanently, and the corrected key can never extend it.
    //
    // IT IS NOT CLOSED HERE, and the reason is the wall. Authenticating a
    // first append against ANOTHER company's entry would work for a superuser
    // and not for the app: row-level security filters `owner.audit_chain` to
    // the declared company, so `dito_owner` — the only writer that matters —
    // sees no other chain to check the key against. Closing it needs a
    // per-company genesis attestation, which is a mechanism the ticket did
    // not ask for; it is on the delivery's remainder instead. This test is
    // here so the behaviour is stated rather than discovered.
    const fresh = "c0000000-0000-4000-8000-000000000003";
    const wrong = randomBytes(32);
    await asOwner(fresh, (c) =>
      appendOwnerAuditEntry(c, wrong, fresh, entryFor(randomUUID())),
    );
    // Committed under the wrong key...
    const underWrong = await withClient((c) =>
      verifyOwnerAuditChainsInDb(c, wrong),
    );
    expect(
      underWrong.companies.find((chain) => chain.companyId === fresh)!.valid,
    ).toBe(true);
    // ...and the INTENDED key can never extend it, nor verify it.
    await expect(
      asOwner(fresh, (c) =>
        appendOwnerAuditEntry(c, ownerKey, fresh, entryFor(randomUUID())),
      ),
    ).rejects.toThrow(/key/);
    const underRight = await withClient((c) =>
      verifyOwnerAuditChainsInDb(c, ownerKey),
    );
    expect(
      underRight.companies.find((chain) => chain.companyId === fresh)!.valid,
    ).toBe(false);
    // The other companies are untouched by it, which is the one consolation
    // the partition buys: the damage is one company's.
    expect(
      underRight.companies
        .filter((chain) => chain.companyId !== fresh)
        .every((chain) => chain.valid),
    ).toBe(true);
  });

  it("refuses a weak HMAC key at both entry points — a short key makes every hash forgeable", async () => {
    const weak = randomBytes(8);
    await expect(
      asOwner(COMPANY_A, (c) =>
        appendOwnerAuditEntry(c, weak, COMPANY_A, entryFor(randomUUID())),
      ),
    ).rejects.toThrow(/32 bytes/);
    await expect(
      withClient((c) => verifyOwnerAuditChainsInDb(c, weak)),
    ).rejects.toThrow(/32 bytes/);
  });
});

describe("the transaction contract", () => {
  it("refuses to append outside a transaction — an autocommit append could fork the chain", async () => {
    await expect(
      withRoleClient(OWNER_ROLE, OWNER_TEST_PASSWORD, async (client) => {
        await client.query("SELECT set_config($1, $2, false)", [
          OWNER_COMPANY_SETTING,
          COMPANY_A,
        ]);
        return appendOwnerAuditEntry(
          client,
          ownerKey,
          COMPANY_A,
          entryFor(randomUUID()),
        );
      }),
    ).rejects.toThrow(/transaction/);
  });
});

describe("two companies, one table (forced row-level security)", () => {
  it("lets a company read only its own rows, and links its append onto its own tail", async () => {
    await resetAndMigrate();
    const a1 = entryFor(randomUUID());
    await asOwner(COMPANY_A, (c) =>
      appendOwnerAuditEntry(c, ownerKey, COMPANY_A, a1),
    );
    await asOwner(COMPANY_B, (c) =>
      appendOwnerAuditEntry(c, ownerKey, COMPANY_B, entryFor(randomUUID())),
    );
    // A's second entry chains onto A's FIRST — not onto B's, which is the row
    // that came last in the table.
    await asOwner(COMPANY_A, (c) =>
      appendOwnerAuditEntry(c, ownerKey, COMPANY_A, entryFor(randomUUID())),
    );

    const seenByA = await asOwner(COMPANY_A, async (c) =>
      (
        await c.query(
          "SELECT company_id, prev_hash FROM owner.audit_chain ORDER BY id",
        )
      ).rows,
    );
    expect(seenByA.map((row) => row.company_id)).toEqual([COMPANY_A, COMPANY_A]);
    expect(
      Buffer.from(seenByA[1]!.prev_hash).equals(
        independentHash(ownerKey, null, a1),
      ),
    ).toBe(true);
    // ...and B's own first link starts from null, untouched by A's two.
    const seenByB = await asOwner(COMPANY_B, async (c) =>
      (
        await c.query(
          "SELECT company_id, prev_hash FROM owner.audit_chain ORDER BY id",
        )
      ).rows,
    );
    expect(seenByB.length).toBe(1);
    expect(seenByB[0]!.prev_hash).toBeNull();
  });

  it("refuses an entry stamped with a company the connection did not declare", async () => {
    await expect(
      asOwner(COMPANY_A, (c) =>
        appendOwnerAuditEntry(c, ownerKey, COMPANY_B, entryFor(randomUUID())),
      ),
    ).rejects.toThrow();
  });

  it("filters the tail by company for a SUPERUSER caller too — the policy is not the only fence", async () => {
    // B's entry is deliberately THE LAST ROW IN THE TABLE, so a tail read
    // that asked for "the last row" would chain A's next entry onto B's tail
    // and break A's chain irreparably. `dito` bypasses row-level security, so
    // the policy cannot stop that — the filter in the statement is what does,
    // and this is the case that tells the two fences apart.
    await asOwner(COMPANY_B, (c) =>
      appendOwnerAuditEntry(c, ownerKey, COMPANY_B, entryFor(randomUUID())),
    );
    await inTransaction((c) =>
      appendOwnerAuditEntry(c, ownerKey, COMPANY_A, entryFor(randomUUID())),
    );
    const res = await withClient((c) => verifyOwnerAuditChainsInDb(c, ownerKey));
    expect(res.valid).toBe(true);
    expect(res.companies).toEqual([
      { companyId: COMPANY_A, valid: true, entries: 3 },
      { companyId: COMPANY_B, valid: true, entries: 2 },
    ]);
  });
  it("takes ONE lock however the company id is spelled (#165, Codex r1)", async () => {
    // THE LOCK AND THE ROWS MUST NAME THE SAME COMPANY. The lock key hashes
    // text and the tail predicate coerces to `uuid`, so an uppercase and a
    // lowercase spelling of one company would take DIFFERENT locks and
    // address the SAME rows — two appenders reading one predecessor and
    // committing two children, forking a chain that can never be repaired.
    // Driven with the two spellings appending AT ONCE, which is the only
    // arrangement in which the lock is what keeps them apart.
    const upper = COMPANY_A.toUpperCase();
    await Promise.all([
      asOwner(COMPANY_A, (c) =>
        appendOwnerAuditEntry(c, ownerKey, COMPANY_A, entryFor(randomUUID())),
      ),
      asOwner(COMPANY_A, (c) =>
        appendOwnerAuditEntry(c, ownerKey, upper, entryFor(randomUUID())),
      ),
    ]);
    const res = await withClient((c) => verifyOwnerAuditChainsInDb(c, ownerKey));
    expect(res.valid).toBe(true);
    // ...and both landed on ONE chain, under the canonical spelling: a uuid
    // column stores a value, not a rendering of one.
    expect(res.companies.map((chain) => chain.companyId)).not.toContain(upper);
  });
});

describe("concurrent appends (the per-company tail lock)", () => {
  it("eight appenders across two companies extend two chains — and fork neither", async () => {
    await resetAndMigrate();
    await Promise.all(
      Array.from({ length: 8 }, (_, i) => {
        const company = i % 2 === 0 ? COMPANY_A : COMPANY_B;
        return asOwner(company, (c) =>
          appendOwnerAuditEntry(c, ownerKey, company, entryFor(randomUUID())),
        );
      }),
    );
    const res = await withClient((c) => verifyOwnerAuditChainsInDb(c, ownerKey));
    expect(res.valid).toBe(true);
    expect(res.entries).toBe(8);
    expect(res.companies).toEqual([
      { companyId: COMPANY_A, valid: true, entries: 4 },
      { companyId: COMPANY_B, valid: true, entries: 4 },
    ]);
  });
});

describe("what the owner role may do to the two chains (#157)", () => {
  it("refuses SELECT and INSERT on the REP side's chain with 42501", async () => {
    expect(await refusedAsOwner("SELECT count(*) FROM public.audit_chain")).toBe(
      "42501",
    );
    expect(
      await refusedAsOwner(
        `INSERT INTO public.audit_chain (caller, action, ref, outcome, entry_hash)
           VALUES ('execution', 'execution', NULL, 'answered', '\\x00')`,
      ),
    ).toBe("42501");
  });

  it("refuses UPDATE, DELETE and TRUNCATE on its OWN chain — by grant, and by trigger", async () => {
    for (const statement of [
      "UPDATE owner.audit_chain SET outcome = 'tampered'",
      "DELETE FROM owner.audit_chain",
      "TRUNCATE owner.audit_chain",
    ]) {
      expect(await refusedAsOwner(statement)).toBe("42501");
    }
    // ...and the trigger refuses the SCHEMA OWNER too, which is the half a
    // grant cannot promise: `dito` is a superuser here and holds every
    // privilege by attribute.
    for (const statement of [
      "UPDATE owner.audit_chain SET outcome = 'tampered'",
      "DELETE FROM owner.audit_chain",
      "TRUNCATE owner.audit_chain",
    ]) {
      await expect(withClient((c) => c.query(statement))).rejects.toThrow(
        /append-only/,
      );
    }
  });
});

describe("scripts/audit-verify.mjs — two chains, two keys, ONE verdict", () => {
  /**
   * THE SCRIPT ITSELF, run the way CI runs it (the shape
   * `audit-coverage.int.test.ts` uses for its own CLI). ADR-0020 as amended
   * asks for one verdict over every chain, and that is a property of the
   * PROCESS — which chains it walked, which keys it used, and what it exited
   * with — so it cannot be asserted from inside the module the script calls.
   *
   * Requires the workspace to be built: the script imports `dist` so it
   * carries no dependencies of its own.
   */
  async function runVerify(
    args: readonly string[] = [],
  ): Promise<{ code: number; out: string }> {
    try {
      const { stdout, stderr } = await exec(
        process.execPath,
        ["scripts/audit-verify.mjs", ...args],
        {
          cwd: REPO_ROOT,
          env: {
            ...process.env,
            DITO_DATABASE_URL: TEST_DATABASE_URL,
            DITO_AUDIT_HMAC_KEY: Buffer.from(repKey).toString("hex"),
            DITO_OWNER_AUDIT_HMAC_KEY: Buffer.from(ownerKey).toString("hex"),
          },
        },
      );
      return { code: 0, out: stdout + stderr };
    } catch (err) {
      const failure = err as { code?: number; stdout?: string; stderr?: string };
      return {
        code: failure.code ?? 1,
        out: (failure.stdout ?? "") + (failure.stderr ?? ""),
      };
    }
  }

  beforeAll(async () => {
    await resetAndMigrate();
    // A rep chain under the rep key, and two companies' owner chains under
    // the owner key — the shape a real deployment has, and the only shape in
    // which "one verdict over both" means anything.
    await inTransaction((c) =>
      appendAuditEntry(c, repKey, {
        caller: "affirmation_matcher",
        action: "customer_send",
        ref: "draft:11111111-1111-4111-8111-111111111111",
        outcome: "refused:pacing",
      }),
    );
    for (const company of [COMPANY_A, COMPANY_B]) {
      await asOwner(company, (c) =>
        appendOwnerAuditEntry(c, ownerKey, company, entryFor(randomUUID())),
      );
    }
  });

  it("exits 0 and reports each chain, naming every company it walked", async () => {
    const { code, out } = await runVerify(["--require-entries"]);
    expect(out).toContain("Rep chain (public.audit_chain): 1 entry.");
    expect(out).toContain("Owner chains (owner.audit_chain): 2 entries across 2 companies.");
    expect(out).toContain(`${COMPANY_A}: 1 entry — verifies`);
    expect(out).toContain(`${COMPANY_B}: 1 entry — verifies`);
    expect(out).toContain("Every audit chain verifies end to end.");
    expect(code).toBe(0);
  });

  it("exits 1 and names the COMPANY whose owner chain is broken", async () => {
    await withClient((c) =>
      c.query(
        `INSERT INTO owner.audit_chain
           (company_id, caller, action, ref, outcome, prev_hash, entry_hash)
         VALUES ($1, 'forger', 'execution', NULL, 'answered', NULL, $2)`,
        [COMPANY_B, Buffer.from("not-a-real-hmac")],
      ),
    );
    const { code, out } = await runVerify();
    expect(code).toBe(1);
    expect(out).toContain(
      `AUDIT CHAIN RED (owner.audit_chain, company ${COMPANY_B})`,
    );
    // ...and A is reported green in the same run, which is the whole point of
    // naming the company: a reader learns which chain to look at.
    expect(out).toContain(`${COMPANY_A}: 1 entry — verifies`);
    expect(out).not.toContain(`company ${COMPANY_A}`);
  });

  it("exits 1 on a broken REP chain too — one exit code covers both sides", async () => {
    // The append-only trigger refuses an edit even to `dito`, so the forgery
    // is an INSERT — the same shape `store.int.test.ts` uses.
    await withClient((c) =>
      c.query(
        `INSERT INTO audit_chain (caller, action, ref, outcome, prev_hash, entry_hash)
         VALUES ('forger', 'customer_send', NULL, 'sent', NULL, $1)`,
        [Buffer.from("not-a-real-hmac")],
      ),
    );
    const { code, out } = await runVerify();
    expect(code).toBe(1);
    expect(out).toContain("AUDIT CHAIN RED (public.audit_chain)");
    expect(out).toContain("AUDIT CHAIN RED (owner.audit_chain");
  });

  it("reports an absent owner chain rather than raising, and still verifies the rep side", async () => {
    // THE RIG TRAILS `main` (its upgrade order is pull, build, THEN migrate),
    // so a database that predates …100010 is a real thing to be run against.
    // "There is no owner chain here" is a true answer said out loud — the
    // shape `audit-coverage-check` already uses for an absent act relation —
    // and the owner key is not asked for, because there is none on such a
    // rig either. Dropped inside this test and put back by the reset at the
    // top of the next file to run.
    await withClient((c) => c.query("DROP TABLE owner.audit_chain"));
    try {
      const { code, out } = await runVerify(["--require-entries"]);
      expect(out).toContain("not in this schema");
      expect(out).toContain("Rep chain (public.audit_chain):");
      expect(code).toBe(1); // the rep chain is still forged from the test above
      expect(out).toContain("AUDIT CHAIN RED (public.audit_chain)");
    } finally {
      await resetAndMigrate();
    }
  });

  it("goes red when the OWNER key is a copy of the REP key (#165, Codex r3)", async () => {
    // THE MISTAKE A DOCUMENTED MANUAL STEP INVITES. A rig minted before the
    // split has no `DITO_OWNER_AUDIT_HMAC_KEY`, so `rig.sh`'s header tells an
    // operator to append one — and says "NEVER a copy of DITO_AUDIT_HMAC_KEY".
    // Copy it anyway and both chains verify, both sides green, while the owner
    // environment holds a key that authenticates a REP-SIDE STORE. Nothing
    // else in the repo can see it: only this process ever holds both keys.
    const { code, out } = await (async () => {
      try {
        const { stdout } = await exec(
          process.execPath,
          ["scripts/audit-verify.mjs"],
          {
            cwd: REPO_ROOT,
            env: {
              ...process.env,
              DITO_DATABASE_URL: TEST_DATABASE_URL,
              DITO_AUDIT_HMAC_KEY: Buffer.from(repKey).toString("hex"),
              DITO_OWNER_AUDIT_HMAC_KEY: Buffer.from(repKey).toString("hex"),
            },
          },
        );
        return { code: 0, out: stdout };
      } catch (err) {
        const failure = err as { code?: number; stdout?: string; stderr?: string };
        return {
          code: failure.code ?? 1,
          out: (failure.stdout ?? "") + (failure.stderr ?? ""),
        };
      }
    })();
    expect(code).toBe(1);
    expect(out).toContain(
      "DITO_OWNER_AUDIT_HMAC_KEY is the REP side's key",
    );
  });

  it("refuses to run at all without the OWNER key — no fallback to the rep side's", async () => {
    const { code, out } = await (async () => {
      try {
        const { stdout } = await exec(
          process.execPath,
          ["scripts/audit-verify.mjs"],
          {
            cwd: REPO_ROOT,
            env: {
              ...process.env,
              DITO_DATABASE_URL: TEST_DATABASE_URL,
              DITO_AUDIT_HMAC_KEY: Buffer.from(repKey).toString("hex"),
              DITO_OWNER_AUDIT_HMAC_KEY: "",
            },
          },
        );
        return { code: 0, out: stdout };
      } catch (err) {
        const failure = err as { code?: number; stderr?: string };
        return { code: failure.code ?? 1, out: failure.stderr ?? "" };
      }
    })();
    expect(code).not.toBe(0);
    expect(out).toContain("DITO_OWNER_AUDIT_HMAC_KEY is not set");
  });
});
