/**
 * twin_keys — the wrapped DEK's home on the seam (decision recorded on
 * #20). The row carries KMS ciphertext under the twin's own key
 * (ADR-0008): opaque bytes to Postgres and to this module; only the twin's
 * KMS key gives them meaning, and key destruction at retirement (ADR-0009)
 * makes them noise. One twin, one wrapped DEK — a second store is refused
 * by the primary key, never silently overwritten.
 */
import type pg from "pg";

/** Stores a twin's KMS-wrapped DEK. Refuses (unique_violation) if the twin already has one. */
export async function storeWrappedDek(
  client: pg.Client | pg.Pool,
  twinId: string,
  wrappedDek: Uint8Array,
): Promise<void> {
  await client.query(
    "INSERT INTO twin_keys (twin_id, wrapped_dek) VALUES ($1, $2)",
    [twinId, Buffer.from(wrappedDek)],
  );
}

/** Loads a twin's KMS-wrapped DEK, or undefined when the twin has none — the caller must refuse, never guess. */
export async function loadWrappedDek(
  client: pg.Client | pg.Pool,
  twinId: string,
): Promise<Uint8Array | undefined> {
  const res = await client.query<{ wrapped_dek: Buffer }>(
    "SELECT wrapped_dek FROM twin_keys WHERE twin_id = $1",
    [twinId],
  );
  return res.rows[0]?.wrapped_dek;
}
