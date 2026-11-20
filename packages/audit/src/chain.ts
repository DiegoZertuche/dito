/**
 * The HMAC hash chain (ADR-0020 skeleton): append-only, content-free
 * entries — caller identity, action type, opaque ref, outcome. Each entry's
 * hash covers the previous entry's hash, so removal, reordering, and edits
 * are all detectable given the HMAC key. Storage is the Postgres
 * `audit_chain` table (append-only by trigger); this module is the chain
 * arithmetic both writers and the verifier share.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { assertHmacKey } from "./custody.js";
import type { AuditAction } from "./vocabulary.js";

/**
 * An entry AS STORED — the four content-free fields every one carries
 * (ADR-0020): never message content, only refs.
 *
 * `action` is a plain string here, and typed by the closed vocabulary on
 * the write shape below. The reader must read back whatever is stored,
 * including a word this build does not declare — that is a finding for the
 * coverage check (ticket #78), never a parse failure for the verifier,
 * whose whole job is to say what the stored chain does.
 */
export interface StoredAuditEntry {
  caller: string;
  action: string;
  /** Opaque reference, e.g. "draft:<uuid>" — never content. */
  ref: string | null;
  outcome: string;
}

/**
 * A content-free audit entry AS WRITTEN.
 *
 * THE VOCABULARY FENCE (ticket #78): `action` is one of the closed set, so
 * a new call site cannot invent a word silently. Every writer reaches the
 * chain through `appendAuditEntry`, which takes this type — so an unlisted
 * word fails to typecheck wherever it is written, including the three call
 * sites that used to bypass `ApertureAction` altogether. The set lives in
 * `vocabulary.ts`; WHICH ACTS owe an entry under each word is the other
 * half of the claim, and it lives in @dito/aperture's `audit-coverage.ts`
 * (it joins `ledger.*` rows, which ADR-0003 keeps inside the writer's own
 * package).
 */
export interface AuditEntry extends StoredAuditEntry {
  action: AuditAction;
}

/** An entry as chained and read back: its own hash plus the previous entry's. */
export interface ChainedEntry extends StoredAuditEntry {
  prevHash: Uint8Array | null;
  entryHash: Uint8Array;
}

/** Canonical byte encoding of an entry: a fixed-order JSON array. */
function canonical(entry: StoredAuditEntry): Buffer {
  return Buffer.from(
    JSON.stringify([entry.caller, entry.action, entry.ref, entry.outcome]),
    "utf8",
  );
}

function computeEntryHash(
  hmacKey: Uint8Array,
  prevHash: Uint8Array | null,
  entry: StoredAuditEntry,
): Buffer {
  const hmac = createHmac("sha256", hmacKey);
  hmac.update(prevHash ?? Buffer.alloc(0));
  hmac.update(canonical(entry));
  return hmac.digest();
}

/** What appending needs to know about the tail: its hash alone. */
export type ChainTail = Pick<ChainedEntry, "entryHash">;

/** Chains one new entry onto the tail (null tail starts the chain). */
export function appendEntry(
  hmacKey: Uint8Array,
  tail: ChainTail | null,
  entry: AuditEntry,
): ChainedEntry {
  assertHmacKey(hmacKey);
  const prevHash = tail === null ? null : tail.entryHash;
  return {
    ...entry,
    prevHash,
    entryHash: computeEntryHash(hmacKey, prevHash, entry),
  };
}

/**
 * Verifies one chained entry in isolation: its entryHash matches its own
 * content and prevHash under the key. The appender authenticates the tail
 * with this before extending it, so a strong-but-wrong key (a miswired
 * deployment, a skewed replica) is refused instead of committing a link the
 * chain can never verify (ADR-0020 — the store is append-only, so that
 * poisoning would be irreparable).
 */
export function verifyEntry(hmacKey: Uint8Array, entry: ChainedEntry): boolean {
  assertHmacKey(hmacKey);
  const expected = computeEntryHash(hmacKey, entry.prevHash, entry);
  return hashesEqual(entry.entryHash, expected);
}

/**
 * Verifies a full chain in order: the first entry starts from null, every
 * link's prevHash matches its predecessor's entryHash, and every entryHash
 * matches its content. An empty chain is vacuously valid.
 */
export function verifyChain(
  hmacKey: Uint8Array,
  entries: readonly ChainedEntry[],
): boolean {
  assertHmacKey(hmacKey);
  let prev: Uint8Array | null = null;
  for (const entry of entries) {
    if (!hashesEqual(entry.prevHash, prev)) return false;
    const expected = computeEntryHash(hmacKey, prev, entry);
    if (!hashesEqual(entry.entryHash, expected)) return false;
    prev = entry.entryHash;
  }
  return true;
}

function hashesEqual(a: Uint8Array | null, b: Uint8Array | null): boolean {
  if (a === null || b === null) return a === b;
  return a.length === b.length && timingSafeEqual(a, b);
}
