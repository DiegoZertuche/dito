/**
 * The audit chains' Postgres store (ticket #24, ADR-0020): atomic append
 * onto an append-only chain table, and end-to-end verification straight from
 * the store. Chain arithmetic lives in chain.ts; this module owns the tail
 * handling.
 *
 * TWO CHAINS SINCE #165 (the decision on #157; ADR-0020 as amended
 * 2026-09-03), and the difference between them is the whole of this file:
 *
 *   `public.audit_chain` — the REP side's, one sequence of links, one global
 *   tail lock, keyed by `DITO_AUDIT_HMAC_KEY`. Unchanged in schema, key and
 *   append path; this ticket did not touch it.
 *
 *   `owner.audit_chain` — the OWNER side's, ONE CHAIN PER COMPANY inside one
 *   table under forced row-level security, keyed by
 *   `DITO_OWNER_AUDIT_HMAC_KEY`. The lock is per company and the tail read is
 *   filtered by company, so two companies neither serialise on each other nor
 *   chain onto each other's tails.
 *
 * The entry format is the same on both — caller, action, ref, outcome — so
 * `chain.ts` needs no notion of which chain it is computing for, and one
 * canonical hash reads either table.
 */
import pg from "pg";
import {
  appendEntry,
  verifyChain,
  verifyEntry,
  type AuditEntry,
  type ChainTail,
  type ChainedEntry,
} from "./chain.js";
import { assertHmacKey } from "./custody.js";

/**
 * The columns every chained entry is read back through, on either chain:
 * ADR-0020's four content-free fields, plus the two hashes that link them.
 *
 * ONE LIST, because it has to match `ChainedRow` — the shape `readEntry`
 * maps — and a second spelling of it in a second query is how a reader gets
 * an entry with an undefined field and a chain that quietly fails to verify.
 * `owner.audit_chain`'s `company_id` is deliberately not among them: it
 * partitions the table and is not part of the entry (see …100010's header).
 */
const CHAIN_COLUMNS = "caller, action, ref, outcome, prev_hash, entry_hash";

/**
 * Appends one content-free entry to the REP side's chain.
 *
 * Contract: MUST be called inside an open transaction on `client` — the
 * append reads the current tail and inserts the next link, and the two must
 * commit together with whatever refusal the entry records.
 */
export async function appendAuditEntry(
  client: pg.ClientBase,
  hmacKey: Uint8Array,
  entry: AuditEntry,
): Promise<ChainedEntry> {
  assertHmacKey(hmacKey);
  await assertInTransaction(client, "appendAuditEntry");
  // The tail lock: appenders serialize on one advisory lock (xact-scoped, so
  // it releases with the surrounding commit/rollback) before reading the
  // tail. Without it, two concurrent appenders read the same tail and fork
  // the chain irreversibly — the store is append-only, so a fork can never
  // be repaired (ADR-0020).
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended('dito:audit_chain:tail', 0))",
  );
  const tail = await authenticatedTail(
    client,
    hmacKey,
    "FROM audit_chain ORDER BY id DESC LIMIT 1",
    [],
  );
  const chained = appendEntry(hmacKey, tail, entry);
  await client.query(
    `INSERT INTO audit_chain (caller, action, ref, outcome, prev_hash, entry_hash)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      chained.caller,
      chained.action,
      chained.ref,
      chained.outcome,
      chained.prevHash === null ? null : Buffer.from(chained.prevHash),
      Buffer.from(chained.entryHash),
    ],
  );
  return chained;
}

/**
 * Appends one content-free entry to the OWNER side's chain, for one company
 * (ticket #165; the decision on #157).
 *
 * Same contract as the rep side's — an open transaction on `client` — and
 * two differences, both of which are the tenant:
 *
 *   THE LOCK IS KEYED PER COMPANY. The rep chain's single global lock
 *   serialises every appender in the deployment; keying this one to the
 *   company means two companies' owner apps never wait on each other, and
 *   still cannot fork one company's chain.
 *
 *   THE TAIL READ IS FILTERED BY COMPANY IN THE STATEMENT, not only by the
 *   policy. Row-level security filters it for `dito_owner`, which is the app
 *   — but a SUPERUSER caller (the migration role, `scripts/`, this repo's own
 *   suites) is exempt from the policy, and would otherwise read "the last row
 *   in the table" and chain company A's entry onto company B's tail. Two
 *   fences, because only one of them binds every reader.
 */
export async function appendOwnerAuditEntry(
  client: pg.ClientBase,
  hmacKey: Uint8Array,
  companyId: string,
  entry: AuditEntry,
): Promise<ChainedEntry> {
  assertHmacKey(hmacKey);
  await assertInTransaction(client, "appendOwnerAuditEntry");
  // THE LOCK KEY IS CANONICALIZED, and the cast is load-bearing (Codex r1).
  // `hashtextextended` hashes the TEXT it is given, while the tail predicate
  // and the INSERT below coerce the same parameter to `uuid` — so two
  // spellings of one company ('A0000000-…' and 'a0000000-…', both accepted
  // everywhere a company id is read) would take DIFFERENT locks and address
  // the SAME rows. Two appenders could then read one predecessor and commit
  // two children, forking a chain that is append-only and can never be
  // repaired. `::uuid::text` is PostgreSQL's own canonical form, so the lock
  // and the rows agree by construction.
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended('dito:owner.audit_chain:tail:' || $1::uuid::text, 0))",
    [companyId],
  );
  const tail = await authenticatedTail(
    client,
    hmacKey,
    `FROM owner.audit_chain
      WHERE company_id = $1 ORDER BY id DESC LIMIT 1`,
    [companyId],
  );
  const chained = appendEntry(hmacKey, tail, entry);
  await client.query(
    `INSERT INTO owner.audit_chain
       (company_id, caller, action, ref, outcome, prev_hash, entry_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      companyId,
      chained.caller,
      chained.action,
      chained.ref,
      chained.outcome,
      chained.prevHash === null ? null : Buffer.from(chained.prevHash),
      Buffer.from(chained.entryHash),
    ],
  );
  return chained;
}

/**
 * Enforce the transaction contract, don't just document it.
 *
 * SAVEPOINT is legal only inside a transaction block (SQLSTATE 25P01
 * otherwise), so an autocommit caller — whose xact-scoped tail lock would
 * evaporate between statements, letting concurrent appenders fork the chain
 * — is refused outright.
 */
async function assertInTransaction(
  client: pg.ClientBase,
  appender: string,
): Promise<void> {
  try {
    await client.query("SAVEPOINT audit_append_probe");
    await client.query("RELEASE SAVEPOINT audit_append_probe");
  } catch (err) {
    if (isNoActiveTransaction(err)) {
      throw new Error(
        `${appender} must run inside an open transaction (ADR-0020): in autocommit mode the tail lock would not survive to the tail read, and the chain could fork`,
      );
    }
    throw err;
  }
}

/**
 * The tail the `from` clause names, authenticated under `hmacKey` — or null
 * when that chain is empty.
 *
 * THE CALLER GIVES THE `FROM` AND NOT THE WHOLE STATEMENT, so the SELECT list
 * is `CHAIN_COLUMNS` at both call sites and cannot drift from the shape
 * `readEntry` maps. What a caller varies is the table and the tail's
 * predicate, which is exactly the difference between the two chains.
 *
 * Authenticating before extending is the point: a strong but different key
 * (miswired deployment, skewed replica, the OTHER side's key since #165) must
 * be refused here — an append under it would commit a link the chain can
 * never verify, and the append-only store makes that irreparable.
 */
async function authenticatedTail(
  client: pg.ClientBase,
  hmacKey: Uint8Array,
  from: string,
  params: readonly unknown[],
): Promise<ChainTail | null> {
  const res = await client.query(`SELECT ${CHAIN_COLUMNS} ${from}`, [...params]);
  if (res.rows.length === 0) return null;
  const stored = readEntry(res.rows[0]);
  if (!verifyEntry(hmacKey, stored)) {
    throw new Error(
      "audit chain key mismatch: the stored tail does not authenticate under the supplied HMAC key — refusing to append (ADR-0020)",
    );
  }
  return stored;
}

/** A stored chain row, as every reader here reads one back. */
interface ChainedRow {
  caller: string;
  action: string;
  ref: string | null;
  outcome: string;
  prev_hash: Buffer | null;
  entry_hash: Buffer;
}

/** One stored row as a chained entry. */
function readEntry(row: ChainedRow): ChainedEntry {
  return {
    caller: row.caller,
    action: row.action,
    ref: row.ref,
    outcome: row.outcome,
    prevHash: row.prev_hash === null ? null : Buffer.from(row.prev_hash),
    entryHash: Buffer.from(row.entry_hash),
  };
}

/** SQLSTATE 25P01: no_active_sql_transaction — SAVEPOINT outside a block. */
function isNoActiveTransaction(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "25P01"
  );
}

/** The verifier's verdict over one stored chain. */
export interface ChainVerification {
  valid: boolean;
  entries: number;
}

/**
 * The verifier's verdict over the OWNER side's chains, which are one per
 * company (ticket #165).
 *
 * ONE ROLLED-UP VERDICT AND ONE PER COMPANY, and that pair is the decision
 * this ticket was asked to record. ADR-0020 as amended requires
 * `audit-verify` to exit with ONE verdict over every chain it finds, so the
 * roll-up has to exist or every caller would recompute it; and a single
 * boolean over "the owner side" would name no company, so a reader of a red
 * would know a chain broke and not which one. `companies` is ordered by
 * company id, so two runs over one database read the same way.
 */
export interface OwnerChainVerification extends ChainVerification {
  readonly companies: readonly (ChainVerification & { companyId: string })[];
}

/**
 * Verifies the entire stored REP chain in id order: first link starts from
 * null, every link's prev_hash matches its predecessor's entry_hash, every
 * entry_hash matches its content under the HMAC key (ADR-0020).
 */
export async function verifyAuditChainInDb(
  client: pg.ClientBase,
  hmacKey: Uint8Array,
): Promise<ChainVerification> {
  assertHmacKey(hmacKey);
  const res = await client.query(
    `SELECT ${CHAIN_COLUMNS} FROM audit_chain ORDER BY id`,
  );
  const entries = res.rows.map(readEntry);
  return { valid: verifyChain(hmacKey, entries), entries: entries.length };
}

/**
 * Verifies EVERY company's owner chain under the owner key, each in id order
 * (ticket #165; ADR-0020 as amended).
 *
 * PER COMPANY, NOT OVER THE TABLE. Read as one sequence these rows are not a
 * chain at all — company B's first link starts from null in the middle of
 * company A's — so the partition is part of the claim rather than a detail of
 * the query.
 */
export async function verifyOwnerAuditChainsInDb(
  client: pg.ClientBase,
  hmacKey: Uint8Array,
): Promise<OwnerChainVerification> {
  assertHmacKey(hmacKey);
  const res = await client.query<{ company_id: string } & ChainedRow>(
    `SELECT company_id, ${CHAIN_COLUMNS} FROM owner.audit_chain
      ORDER BY company_id, id`,
  );
  const byCompany = new Map<string, ChainedEntry[]>();
  for (const row of res.rows) {
    const chain = byCompany.get(row.company_id);
    if (chain === undefined) byCompany.set(row.company_id, [readEntry(row)]);
    else chain.push(readEntry(row));
  }
  const companies = [...byCompany.entries()].map(([companyId, entries]) => ({
    companyId,
    valid: verifyChain(hmacKey, entries),
    entries: entries.length,
  }));
  return {
    valid: companies.every((chain) => chain.valid),
    entries: res.rows.length,
    companies,
  };
}

/**
 * Script entry: verifies the rep chain stored at `databaseUrl` (rig data or
 * the CI integration corpus). Constructs its own client so callers stay
 * dependency-free.
 */
export async function verifyAuditChainAt(
  databaseUrl: string,
  hmacKey: Uint8Array,
): Promise<ChainVerification> {
  return withChainClient(databaseUrl, (client) =>
    verifyAuditChainInDb(client, hmacKey),
  );
}

/**
 * Script entry: verifies every owner chain stored at `databaseUrl`, under the
 * OWNER key.
 *
 * ITS OWN CONNECTION, like the rep side's. `audit-verify` reaches one
 * database with two keys and reports two verdicts, and giving each verifier
 * its own short-lived client keeps each function about one chain — which is
 * the split #157 decided, expressed in the code that reads them.
 */
export async function verifyOwnerAuditChainsAt(
  databaseUrl: string,
  hmacKey: Uint8Array,
): Promise<OwnerChainVerification> {
  return withChainClient(databaseUrl, (client) =>
    verifyOwnerAuditChainsInDb(client, hmacKey),
  );
}

/**
 * Whether the owner side's chain is in this database's schema at all.
 *
 * A NAMED, REACHABLE CASE rather than a precaution (the two-axis review's
 * Spec axis on #165): the invariant scripts are run against RIG DATA, and the
 * rig routinely trails `main` — the README's own upgrade order is `git pull`,
 * `pnpm build`, then `migrate.sh`, so an operator who checks before migrating
 * is asking a database that predates …100010. `audit-coverage-check` already
 * answers that with "this relation is not in this schema"; without this, the
 * integrity check would answer with a raw 42P01 instead of a verdict.
 *
 * IT DOES NOT SOFTEN CUSTODY. `audit-verify` reads the owner key fail-closed
 * whenever this returns true — a chain that is here and a key that is not is
 * still a refusal, which is the silent green the doctrine exists to prevent.
 */
export async function ownerChainExistsAt(databaseUrl: string): Promise<boolean> {
  return withChainClient(databaseUrl, async (client) => {
    const res = await client.query<{ present: string | null }>(
      "SELECT to_regclass('owner.audit_chain')::text AS present",
    );
    return res.rows[0]!.present !== null;
  });
}

/** Opens a client at `databaseUrl`, runs `fn`, always closes. */
async function withChainClient<T>(
  databaseUrl: string,
  fn: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}
