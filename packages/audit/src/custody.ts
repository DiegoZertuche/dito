/**
 * HMAC key custody for the audit chains (ADR-0020 leaves custody open; the
 * ticket #24 decision): on the dev rig a chain key is an env-provided
 * secret, hex-encoded, at least 32 bytes.
 *
 * TWO CHAINS, TWO KEYS, TWO READERS (ticket #165; the decision on #157;
 * ADR-0020 as amended 2026-09-03). The rep side chains under
 * `DITO_AUDIT_HMAC_KEY`; the owner side chains its own per-company chain
 * under `DITO_OWNER_AUDIT_HMAC_KEY`, so the owner environment holds nothing
 * that can name, read, write or VERIFY a rep-side store — ADR-0002's letter
 * includes the verifier, because a key that authenticates the rep chain's
 * tail is a key that can read it meaningfully.
 *
 * A SIBLING FUNCTION RATHER THAN A VARIABLE-NAME PARAMETER, and that is the
 * decision this ticket was asked to record. `hmacKeyFromEnv(env, "DITO_…")`
 * would make WHICH SECRET a call site loads a runtime string — so an owner
 * process could be pointed at the rep key, or the reverse, by a typo that
 * typechecks. The name is the whole safety property here, so it is a name:
 * every call site says which side of the wall it is on, and `rig-owner.sh`'s
 * allowlist and this file are then the only two places the pairing is
 * written down. The shared rules live in `keyFromEnv` below, once.
 *
 * Fail-closed: a missing, short, or malformed key refuses loudly — a chain
 * is never written or verified under a silent default key, and there is no
 * fallback from one key to the other. Production trajectory (documented on
 * issue #24): the keys move to managed secret storage (KMS-generated secret
 * / Secrets Manager) with rotation; the env seam here stays the single
 * injection point, so that move touches custody only, not writers or
 * verifiers.
 */

const ENV_VAR = "DITO_AUDIT_HMAC_KEY";
const OWNER_ENV_VAR = "DITO_OWNER_AUDIT_HMAC_KEY";
const MIN_KEY_BYTES = 32;

/**
 * Refuses a weak chain key wherever one is about to be used. Node's HMAC
 * accepts any key — even an empty one — so a miswired runtime would chain
 * trivially forgeable hashes while appearing operational; every public
 * chain entry point calls this instead (fail-closed).
 */
export function assertHmacKey(key: Uint8Array): void {
  if (key.length < MIN_KEY_BYTES) {
    throw new Error(
      `audit chain HMAC key must be at least ${MIN_KEY_BYTES} bytes (got ${key.length}) — refusing to chain forgeable hashes (ADR-0020)`,
    );
  }
}

/** Loads the REP side's audit-chain HMAC key from the environment. Fail-closed. */
export function hmacKeyFromEnv(
  env: Record<string, string | undefined> = process.env,
): Uint8Array {
  return keyFromEnv(env, ENV_VAR);
}

/**
 * Loads the OWNER side's audit-chain HMAC key from the environment.
 * Fail-closed, and with no fallback to the rep side's — an owner process
 * that could reach for `DITO_AUDIT_HMAC_KEY` when its own is absent is the
 * exact credential ADR-0002 says it must not hold (#157).
 */
export function ownerHmacKeyFromEnv(
  env: Record<string, string | undefined> = process.env,
): Uint8Array {
  return keyFromEnv(env, OWNER_ENV_VAR);
}

/** The rules both keys are read under: present, hex, at least 32 bytes. */
function keyFromEnv(
  env: Record<string, string | undefined>,
  variable: string,
): Uint8Array {
  const raw = env[variable];
  if (raw === undefined || raw === "") {
    throw new Error(
      `${variable} is not set: the audit chain refuses to run without its HMAC key (ADR-0020)`,
    );
  }
  if (!/^[0-9a-fA-F]+$/.test(raw) || raw.length % 2 !== 0) {
    throw new Error(`${variable} must be hex-encoded`);
  }
  const key = Buffer.from(raw, "hex");
  if (key.length < MIN_KEY_BYTES) {
    throw new Error(
      `${variable} must decode to at least ${MIN_KEY_BYTES} bytes (got ${key.length})`,
    );
  }
  return key;
}
