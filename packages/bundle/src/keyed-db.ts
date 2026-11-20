/**
 * SQLCipher keying for the bundle file — the one place the pragmas live.
 * The file uses the SQLCipher 4.x on-disk format (cipher='sqlcipher',
 * legacy=4) keyed with a raw 256-bit key derived from the DEK, so there is
 * no passphrase KDF: the DEK is the only way in (ADR-0007, ADR-0009).
 *
 * Internal building block: not part of the package's public surface
 * (index.ts does not export it); the bundle module and the test-only aged
 * bundle builder share it so keying can never drift between them.
 */
import Database from "better-sqlite3-multiple-ciphers";
import * as sqliteVec from "sqlite-vec";
import { deriveBundleKey, type Dek } from "@dito/crypto";

/** Keys a connection; the derived key is zeroed before returning. */
export function openKeyed(
  path: string,
  dek: Dek,
  options: { fileMustExist: boolean },
): Database.Database {
  const db = new Database(path, { fileMustExist: options.fileMustExist });
  const key = deriveBundleKey(dek);
  try {
    db.pragma("cipher='sqlcipher'");
    db.pragma("legacy=4");
    db.pragma(`key="x'${key.toString("hex")}'"`);
  } finally {
    key.fill(0);
  }
  // SQLite3MultipleCiphers leaves temporary/transient databases
  // unencrypted, so a big sort or index build could spill twin memory to
  // plaintext temp files outside the bundle. Force all temporary state
  // into memory — nothing DEK-protected may rest on disk unencrypted
  // (ADR-0008; ADR-0007's one-file-one-key promise).
  db.pragma("temp_store = MEMORY");
  // sqlite-vec rides every keyed connection: the vector tables live INSIDE
  // the encrypted bundle (ADR-0007 — sqlite-vec inside; vectors never leave
  // it), and schema v3's vec0 virtual table needs the module present both
  // to migrate at open and to read. Loading is connection-level and touches
  // no file state, so keying stays first.
  sqliteVec.load(db);
  return db;
}
