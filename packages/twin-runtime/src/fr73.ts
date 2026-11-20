/**
 * FR-73 skeleton (ticket #31, spec #29 decision 13; quarry story 5.4):
 * the enumeration audit proving every rep-side store is bundle-resident
 * under exactly that twin's one KMS key — verified, not asserted. Runs as
 * a CI invariant over a minted corpus and as a runtime check on the rig
 * (scripts/fr73-check.mjs).
 *
 * The theorem has two halves:
 *
 *  1. THE ENUMERATION. The registry of rep-side stores is the bundle's
 *     own live schema, read through the bundle API — so every enumerated
 *     store is bundle-resident under the twin's DEK by construction, and
 *     a store added by a later migration (#32's vector work, #34's) joins
 *     the enumeration with no audit change. The custody chain above it is
 *     checked, not believed: exactly one twin_keys row holds the wrapped
 *     DEK (the PK makes a second unrepresentable; the audit demands the
 *     first), the KMS identity is bound to the twin id on this package's
 *     surface (no lever), the bundle file is ciphertext at rest, and the
 *     bundle actually opens under the KMS-unwrapped DEK.
 *
 *  2. THE CONVERSE SWEEP. Nothing store-shaped may exist OUTSIDE the
 *     bundle: the twin's data dir may hold twin bundles (the audited one
 *     and — the rig's shared rig-data/ layout — sibling twins', every one
 *     header-checked as ciphertext), their own SQLite sidecars, and their
 *     wrapped-DEK sidecars (KMS ciphertext, the fixture-generator
 *     layout). Everything else — plaintext SQLite, a JSON cache, an
 *     undeclared subdirectory, a plaintext file wearing a bundle name —
 *     is a violation, with one recorded gap: the per-twin harness
 *     directory beside a bundle (`harness-directory.ts`), which the report
 *     names with its ruling instead. The allowlist is deliberate: a new store is
 *     impossible to add outside the bundle without failing this audit,
 *     which is what "joins the enumeration by construction" means from
 *     the outside.
 *
 *  3. THE SHARED-POSTGRES REGISTRY (ticket #50). Not every rep-side store
 *     can be bundle-resident: ADR-0003 puts the aperture's DISCLOSURE
 *     LINES in shared Postgres, plaintext, so that delivering a rep's
 *     account of what crossed never waits on a lease. That is exactly the
 *     shape halves 1 and 2 exist to catch, so it is admitted as a
 *     RECORDED EXCEPTION carrying its justification — never as a silent
 *     skip — and every other shared-Postgres table is declared with its
 *     custody beside it (fr73-shared-stores.ts). The registry is checked
 *     against the live catalog in both directions, so a NEW rep-side
 *     store that nobody declared still fails the audit.
 *
 * ADR-0016 boundary, stated so it stays visibly true: this audit reads
 * table NAMES (sqlite_master via the bundle API) and file HEADERS only —
 * never a row of twin memory. It is custody tooling, not bundle-reading
 * operator tooling.
 *
 * Scope this slice: the twin-side stores. Plane-side state is out of
 * frame — seam payloads and draft content are DEK ciphertext (ADR-0008)
 * and the whatsmeow session store is transport material (#22's recorded
 * disposition), not twin memory.
 */
import { lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { KMSClient } from "@aws-sdk/client-kms";
import pg from "pg";
import { auditSharedPostgresStores } from "./fr73-shared-stores.js";
import {
  bundleOfHarnessDirectory,
  HARNESS_DIRECTORY_RULING,
} from "./harness-directory.js";
import {
  openTwinMemoryWithKmsIdentity,
  TwinNotProvisionedError,
} from "./provision.js";

export interface Fr73Violation {
  /** What the violation hangs off: "twin:<id>", "bundle:<path>", or "file:<path>". */
  readonly subject: string;
  readonly reason: string;
}

export interface Fr73Report {
  readonly twinId: string;
  readonly bundlePath: string;
  /** The audited bundle's stamped schema version (undefined when it did not open). */
  readonly schemaVersion: number | undefined;
  /** The enumerated rep-side stores — the bundle's live schema. */
  readonly stores: readonly string[];
  /**
   * The OTHER enumeration (ticket #50): rep-side stores that live in
   * shared Postgres rather than in the bundle, declared with their
   * custody in fr73-shared-stores.ts and checked against the live catalog.
   */
  readonly sharedStores: readonly string[];
  /** Those shared-Postgres stores holding rep-facing content in the clear, by recorded exception. */
  readonly sharedStoreExceptions: readonly string[];
  /**
   * The harness directories found beside a bundle in the data dir (ticket
   * #328): not violations, and never passed over silently — each is named
   * here with the ruling that admits it.
   */
  readonly recordedGaps: readonly Fr73Gap[];
  readonly violations: readonly Fr73Violation[];
}

/** One thing in the data dir that is admitted by a recorded ruling, not by the allowlist. */
export interface Fr73Gap {
  readonly path: string;
  readonly ruling: string;
}

export interface Fr73Options {
  readonly kms: KMSClient;
  readonly db: pg.Client;
  readonly twinId: string;
  readonly bundlePath: string;
}

const PLAINTEXT_SQLITE_MAGIC = "SQLite format 3";

/**
 * Audits one twin: enumeration + custody + the converse sweep. KMS
 * identity is the twin id — no lever on the package surface (the same
 * binding provisionTwin/openTwinMemory carry).
 */
export async function auditFr73(options: Fr73Options): Promise<Fr73Report> {
  return auditFr73WithKmsIdentity({ ...options, kmsTwinId: options.twinId });
}

/**
 * TEST-FIXTURE ONLY (deliberately not re-exported from the package
 * index): in-repo tests and the CI corpus check must reuse the one shared
 * fixture key while the seam twin id stays a uuid — the same recorded
 * latitude as provisionTwinWithKmsIdentity. Production composition goes
 * through auditFr73, which binds both to the one twin id.
 */
export async function auditFr73WithKmsIdentity(
  options: Fr73Options & { readonly kmsTwinId: string },
): Promise<Fr73Report> {
  const { kms, db, twinId, bundlePath, kmsTwinId } = options;
  const dataDir = dirname(bundlePath);
  const violations: Fr73Violation[] = [];
  let stores: string[] = [];
  let schemaVersion: number | undefined;

  // Ciphertext at rest, checked before any open: a plaintext file at the
  // bundle path betrays the one-file-one-key promise outright (ADR-0007).
  const fileState = bundleFileState(bundlePath);
  if (fileState === "missing") {
    violations.push({
      subject: `bundle:${bundlePath}`,
      reason: "no bundle file at the twin's bundle path",
    });
  } else if (fileState === "plaintext") {
    violations.push({
      subject: `bundle:${bundlePath}`,
      reason:
        "bundle file is plaintext SQLite — twin memory is not encrypted at rest (ADR-0007)",
    });
  }

  // Exactly one KMS custody chain, and it actually opens the bundle: the
  // open IS the proof that the enumerated stores rest under the twin's
  // key. Every refusal is a violation, never a skip — an audit that
  // cannot see the stores must not pass them.
  if (fileState === "ciphertext") {
    try {
      const { bundle } = await openTwinMemoryWithKmsIdentity({
        kms,
        db,
        twinId,
        bundlePath,
        kmsTwinId,
      });
      try {
        schemaVersion = bundle.schemaVersion;
        stores = bundle.listStores();
      } finally {
        bundle.close();
      }
      if (stores.length === 0) {
        violations.push({
          subject: `bundle:${bundlePath}`,
          reason:
            "bundle enumerates zero stores — refusing to pass on nothing (ADR-0028 doctrine)",
        });
      }
    } catch (err) {
      violations.push(custodyViolation(twinId, bundlePath, err));
    }
  } else {
    // The file cannot prove residency; custody is still checked so a
    // missing key chain never hides behind a broken file.
    const wrapped = await db.query(
      "SELECT 1 FROM twin_keys WHERE twin_id = $1",
      [twinId],
    );
    if (wrapped.rows.length === 0) {
      violations.push(
        custodyViolation(twinId, bundlePath, new TwinNotProvisionedError(twinId)),
      );
    }
  }

  // The converse sweep: the data dir holds twin bundles and nothing else,
  // save the harness directories it reports as the recorded gap.
  const sweep = await sweepDataDir(db, dataDir, bundlePath);
  violations.push(...sweep.violations);

  // The shared-Postgres half (ticket #50): rep-side stores that are NOT
  // bundle-resident, declared with their custody and checked against the
  // live catalog both ways — including the aperture's disclosure lines,
  // which are plaintext by ADR-0003's design and therefore enter as a
  // recorded exception rather than as a silent skip.
  const shared = await auditSharedPostgresStores(db);
  violations.push(...shared.violations);

  return {
    twinId,
    bundlePath,
    schemaVersion,
    stores,
    sharedStores: shared.declared,
    sharedStoreExceptions: shared.exceptions,
    recordedGaps: sweep.gaps,
    violations,
  };
}

export interface Fr73Target {
  readonly twinId: string;
  readonly bundlePath: string;
}

/**
 * Script entry (the reconcileFr70At pattern): audits the twin at
 * `databaseUrl` constructing its own Postgres client and KMS client, so
 * callers stay dependency-free. KMS identity is the twin id — no lever.
 */
export async function auditFr73At(
  databaseUrl: string,
  target: Fr73Target,
): Promise<Fr73Report> {
  return auditFr73AtWithKmsIdentity(databaseUrl, {
    ...target,
    kmsTwinId: target.twinId,
  });
}

/** TEST-FIXTURE ONLY — the CI corpus rides the shared fixture key; see auditFr73WithKmsIdentity. */
export async function auditFr73AtWithKmsIdentity(
  databaseUrl: string,
  target: Fr73Target & { readonly kmsTwinId: string },
): Promise<Fr73Report> {
  const db = new pg.Client({ connectionString: databaseUrl });
  await db.connect();
  try {
    return await auditFr73WithKmsIdentity({
      kms: new KMSClient({}),
      db,
      ...target,
    });
  } finally {
    await db.end();
  }
}

function custodyViolation(
  twinId: string,
  bundlePath: string,
  err: unknown,
): Fr73Violation {
  if (err instanceof TwinNotProvisionedError) {
    return {
      subject: `twin:${twinId}`,
      reason:
        "no wrapped DEK in twin_keys — 'exactly one KMS key per twin' means exactly one, not at most one",
    };
  }
  const name = err instanceof Error ? err.name : "UnknownError";
  return {
    subject: `bundle:${bundlePath}`,
    reason: `bundle did not open under the twin's KMS-held DEK (${name}) — residency unprovable, audit fails closed`,
  };
}

function bundleFileState(
  bundlePath: string,
): "missing" | "plaintext" | "ciphertext" {
  let raw: Buffer;
  try {
    raw = readFileSync(bundlePath);
  } catch {
    return "missing";
  }
  return raw.subarray(0, 16).toString("latin1").includes(PLAINTEXT_SQLITE_MAGIC)
    ? "plaintext"
    : "ciphertext";
}

/**
 * Structural ciphertext test for a bundle the audit holds no key to
 * (Codex r2): a SQLite database file — SQLCipher included — is always a
 * whole number of 4096-byte pages, and SQLCipher content is
 * indistinguishable from random bytes, so a first page that is mostly
 * printable text is plaintext whatever the filename claims. This never
 * replaces the real proof (the KMS open) for the audited bundle; it
 * keeps a custody row from laundering a file it does not open.
 */
function looksLikeEncryptedBundle(path: string): boolean {
  let raw: Buffer;
  try {
    raw = readFileSync(path);
  } catch {
    return false;
  }
  if (raw.length === 0 || raw.length % 4096 !== 0) return false;
  const sample = raw.subarray(0, Math.min(512, raw.length));
  let printable = 0;
  for (const byte of sample) {
    if ((byte >= 0x20 && byte <= 0x7e) || byte === 0x09 || byte === 0x0a || byte === 0x0d) {
      printable += 1;
    }
  }
  return printable / sample.length < 0.9;
}

/** A sibling twin's bundle in the shared data dir: twin-<uuid>.bundle. */
const SIBLING_BUNDLE =
  /^twin-([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\.bundle$/;

/**
 * A KMS-wrapped 256-bit DEK is ~200 bytes of ciphertext; anything past
 * this bound is not a wrapped DEK, whatever its name says.
 */
const MAX_WRAPPED_DEK_BYTES = 512;

/**
 * The strict allowlist sweep (Codex r1: a companion NAME buys nothing —
 * every allowance is verified, never presumed). Allowed in the data dir:
 *
 *  - the audited bundle (already header-checked by the caller);
 *  - sibling twins' bundles (the rig's shared rig-data/ layout), each
 *    verified twice: not plaintext SQLite, AND its uuid holds a twin_keys
 *    custody row — a rogue file wearing a made-up twin name has no
 *    custody chain and fails;
 *  - SQLite sidecars (-journal/-wal/-shm) whose PARENT bundle is present
 *    in the dir (SQLCipher encrypts their pages; an orphan sidecar is
 *    nobody's residue and fails);
 *  - wrapped-DEK sidecars (<bundle>.dek, the fixture-generator layout;
 *    the rig keeps the wrapped DEK in twin_keys), verified as plausibly
 *    KMS ciphertext: parent bundle present, small enough to BE a wrapped
 *    DEK, and not SQLite;
 *  - and, REPORTED RATHER THAN ALLOWED, a harness directory whose bundle
 *    is present in the dir (`harness-directory.ts`): it comes back as a
 *    recorded gap with its ruling. One with no bundle beside it is a
 *    directory nobody vouches for, and fails like any other.
 *
 * Everything else is an out-of-bundle store.
 */
async function sweepDataDir(
  db: pg.Client,
  dataDir: string,
  bundlePath: string,
): Promise<{ violations: Fr73Violation[]; gaps: Fr73Gap[] }> {
  const bundleName = basename(bundlePath);
  let entries: string[];
  try {
    entries = readdirSync(dataDir);
  } catch {
    return {
      violations: [
        {
          subject: `file:${dataDir}`,
          reason: "twin data dir is unreadable — the sweep cannot pass on nothing",
        },
      ],
      gaps: [],
    };
  }
  const present = new Set(entries);
  const violations: Fr73Violation[] = [];
  const gaps: Fr73Gap[] = [];

  // Custody rows for every sibling-named bundle, one query.
  const siblingIds = entries
    .filter((e) => e !== bundleName)
    .map((e) => SIBLING_BUNDLE.exec(e)?.[1])
    .filter((id): id is string => id !== undefined);
  const custodied = new Set<string>();
  if (siblingIds.length > 0) {
    const res = await db.query<{ twin_id: string }>(
      "SELECT twin_id FROM twin_keys WHERE twin_id = ANY($1::uuid[])",
      [siblingIds],
    );
    for (const row of res.rows) custodied.add(row.twin_id.toLowerCase());
  }

  for (const entry of entries) {
    const path = join(dataDir, entry);
    if (entry === bundleName) continue;

    const sibling = SIBLING_BUNDLE.exec(entry)?.[1];
    if (sibling !== undefined) {
      if (
        bundleFileState(path) === "plaintext" ||
        !looksLikeEncryptedBundle(path)
      ) {
        // Codex r2: a custody row vouches for a TWIN, never for file
        // contents — plaintext of any shape (SQLite or not) wearing a
        // twin's name is rep data in disguise.
        violations.push({
          subject: `file:${path}`,
          reason:
            "plaintext wearing a twin-bundle name — twin memory is not encrypted at rest (ADR-0007)",
        });
      } else if (!custodied.has(sibling.toLowerCase())) {
        violations.push({
          subject: `file:${path}`,
          reason:
            "bundle-named file whose twin holds no twin_keys custody row — no key chain vouches for it, so it is an out-of-bundle store until provisioned",
        });
      }
      continue;
    }

    const sidecar = /^(.+\.bundle)(-journal|-wal|-shm)$/.exec(entry);
    if (sidecar !== undefined && sidecar !== null) {
      if (!present.has(sidecar[1]!)) {
        violations.push({
          subject: `file:${path}`,
          reason:
            "orphan bundle sidecar — its parent bundle is not in the dir, so nothing vouches for it",
        });
      }
      continue;
    }

    const dek = /^(.+\.bundle)\.dek$/.exec(entry);
    if (dek !== undefined && dek !== null) {
      const size = statSync(path, { throwIfNoEntry: false })?.size ?? 0;
      if (
        !present.has(dek[1]!) ||
        size > MAX_WRAPPED_DEK_BYTES ||
        bundleFileState(path) === "plaintext"
      ) {
        violations.push({
          subject: `file:${path}`,
          reason:
            "file wearing a wrapped-DEK name that cannot be a wrapped DEK (orphaned, oversized, or SQLite) — rep data in disguise fails, not passes",
        });
      }
      continue;
    }

    const isDirectory =
      statSync(path, { throwIfNoEntry: false })?.isDirectory() === true;
    const harnessOf = bundleOfHarnessDirectory(entry);
    // A REAL DIRECTORY, NOT A LINK TO ONE (Codex r2): a harness name pointing
    // at another twin's directory, or out of the data dir, is not the one
    // twin's place the gap admits, and fails like any other stray entry.
    const isLink = lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() === true;
    if (isDirectory && !isLink && harnessOf !== undefined && present.has(harnessOf)) {
      gaps.push({ path, ruling: HARNESS_DIRECTORY_RULING });
      continue;
    }
    const kind = isDirectory ? "directory" : "file";
    violations.push({
      subject: `file:${path}`,
      reason: `out-of-bundle ${kind} in the twin's data dir — every rep-side store lives inside the bundle (FR-73), and only twin bundles and their declared sidecars may sit here`,
    });
  }
  return { violations, gaps };
}
