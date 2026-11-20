/**
 * Typed refusals for the bundle's open path. The bundle FAILS CLOSED: there
 * is no plaintext fallback anywhere in this package — every open either
 * yields a fully keyed, migrated handle or throws one of these.
 */

/**
 * The provided DEK does not open this bundle file (SQLCipher refuses the
 * derived key). By construction SQLCipher cannot tell a wrong key from a
 * corrupted or non-bundle file — indistinguishability is the point — so
 * this refusal covers both, and that is what retirement looks like from
 * the data's side: wrong key — or a destroyed KMS key upstream — and the
 * file is noise (ADR-0007, ADR-0009).
 */
export class WrongBundleKeyError extends Error {
  override readonly name = "WrongBundleKeyError";

  constructor(path: string, options?: { cause?: unknown }) {
    super(
      `bundle does not open under the provided DEK (wrong key, or not an intact bundle — SQLCipher cannot distinguish): ${path}`,
      options,
    );
  }
}

/**
 * createBundle was pointed at a path that already holds a file. Creating is
 * never adopting: an existing bundle is opened with openBundle, and nothing
 * is ever reused or overwritten on a name collision.
 */
export class BundleAlreadyExistsError extends Error {
  override readonly name = "BundleAlreadyExistsError";

  constructor(path: string) {
    super(`a file already exists where the bundle would be created: ${path}`);
  }
}

/**
 * The file at the bundle path carries no schema stamp (version 0): it is
 * empty, truncated to nothing, or the residue of an interrupted create.
 * Version 0 is not a stamp any build ever leaves behind (migrations start
 * at 1 and commit atomically with their bump, ADR-0029), so adopting such
 * a file would let total data loss masquerade as a healthy empty twin
 * memory. Fail closed; recovery is an explicit re-provision, never a
 * silent re-initialization.
 */
export class BundleUninitializedError extends Error {
  override readonly name = "BundleUninitializedError";

  constructor(path: string) {
    super(
      `file holds no stamped bundle (empty, truncated, or an interrupted create) — refusing to adopt it: ${path}`,
    );
  }
}

/**
 * The twin's KMS key refused to yield the bundle DEK — disabled key,
 * pending-deletion/destroyed key, tampered or foreign wrapped-DEK
 * ciphertext, or a twin with no key at all. Fail closed: without KMS the
 * bundle stays sealed (ADR-0008; ADR-0009 — this is retirement's
 * enforcement point). `kmsErrorName` carries the real KMS error type,
 * `cause` the original error.
 */
export class BundleKeyUnavailableError extends Error {
  override readonly name = "BundleKeyUnavailableError";
  readonly kmsErrorName: string;

  constructor(twinId: string, cause: unknown) {
    const kmsErrorName =
      cause instanceof Error ? cause.name : "UnknownKmsError";
    super(
      `twin's KMS key did not yield the bundle DEK (${kmsErrorName}) — bundle stays sealed for twin: ${twinId}`,
      { cause },
    );
    this.kmsErrorName = kmsErrorName;
  }
}

/**
 * The chat already holds a rep-confirmed binding in the entity mirror
 * (ticket #31, ADR-0004). One chat, one entity, first confirmation
 * stands: rebinding is entity lifecycle (rename/merge), which waits for
 * the crossing — a caller must never silently replace what the rep
 * confirmed.
 */
export class ChatAlreadyBoundError extends Error {
  override readonly name = "ChatAlreadyBoundError";

  constructor(chatJid: string, options?: { cause?: unknown }) {
    super(
      `chat is already bound to an entity in the mirror (one binding per chat; rebinding waits for entity lifecycle): ${chatJid}`,
      options,
    );
  }
}

/**
 * A vector write carried an embedding whose width is not the vector
 * store's (ticket #32: BGE-M3 dense vectors, MESSAGE_VECTOR_DIMS wide).
 * Wrong width means a broken or foreign embedder at the boundary — never
 * something to pad, truncate, or store.
 */
export class VectorDimensionMismatchError extends Error {
  override readonly name = "VectorDimensionMismatchError";

  constructor(expected: number, got: number) {
    super(
      `embedding is ${got} dimensions wide, but the vector store holds ${expected} (BGE-M3 dense) — refusing a vector no query could ever compare`,
    );
  }
}

/**
 * A vector write named an interior message id the message store does not
 * hold (ticket #32). Vectors only ever accompany stored messages — an
 * orphan vector would be twin memory nothing can read back.
 */
export class MessageNotInStoreError extends Error {
  override readonly name = "MessageNotInStoreError";

  constructor(storeId: number) {
    super(
      `no message with interior id ${storeId} in the message store — a vector may only ever accompany a stored message`,
    );
  }
}

/**
 * The bundle is stamped with a schema version newer than this build knows.
 * Migrations are forward-only (ADR-0029): a build never reads — let alone
 * "migrates down" — a bundle from its future.
 */
export class BundleSchemaTooNewError extends Error {
  override readonly name = "BundleSchemaTooNewError";

  constructor(path: string, stamped: number, current: number) {
    super(
      `bundle is stamped schema version ${stamped}, but this build migrates only to ${current} (forward-only, ADR-0029): ${path}`,
    );
  }
}
