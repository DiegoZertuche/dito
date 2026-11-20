/**
 * The KMS half of envelope crypto (ADR-0008): one KMS key per twin wraps
 * that twin's DEK. Key selection is derived from twin identity INSIDE this
 * module — no caller can pair a twin with another twin's key — and the wrap
 * additionally carries the twin id in the KMS encryption context.
 *
 * Plaintext key material returned by KMS is copied into the Dek's private
 * custody and zeroed here immediately — it never outlives this module's
 * stack frames.
 */
import {
  CreateAliasCommand,
  CreateKeyCommand,
  DecryptCommand,
  DescribeKeyCommand,
  GenerateDataKeyCommand,
  ScheduleKeyDeletionCommand,
  type KMSClient,
} from "@aws-sdk/client-kms";
import { createDekFromMaterial, type Dek } from "./dek.js";

const ALIAS_PREFIX = "alias/dito-dev/twin-";
const CONTEXT_KEY = "dito:twin_id";

function twinAlias(twinId: string): string {
  if (!/^[a-zA-Z0-9/_-]+$/.test(twinId)) {
    throw new Error("twin id not usable in a KMS alias");
  }
  return `${ALIAS_PREFIX}${twinId}`;
}

function encryptionContext(twinId: string): Record<string, string> {
  return { [CONTEXT_KEY]: twinId };
}

/**
 * Get-or-create the twin's KMS key, addressed by alias. Idempotent. If a
 * concurrent create loses the alias race, the loser's key is scheduled for
 * deletion (the 7-day KMS minimum) so no orphan key survives to bill or to
 * hold data outside the twin's one key (ADR-0008).
 */
export async function ensureTwinKey(
  kms: KMSClient,
  twinId: string,
): Promise<string> {
  const alias = twinAlias(twinId);
  const described = await describeKeyArn(kms, alias);
  if (described !== undefined) return described;

  const created = await kms.send(
    new CreateKeyCommand({
      Description: `Dito per-twin key: ${twinId} (wraps the twin's DEK, ADR-0008)`,
      KeySpec: "SYMMETRIC_DEFAULT",
      KeyUsage: "ENCRYPT_DECRYPT",
      Tags: [{ TagKey: "dito:twin_id", TagValue: twinId }],
    }),
  );
  const keyArn = created.KeyMetadata?.Arn;
  if (keyArn === undefined) throw new Error("KMS CreateKey returned no ARN");

  try {
    await kms.send(
      new CreateAliasCommand({ AliasName: alias, TargetKeyId: keyArn }),
    );
  } catch (err) {
    if ((err as Error).name === "AlreadyExistsException") {
      // Lost a create race: the alias is the truth. Retire our orphan.
      await kms.send(
        new ScheduleKeyDeletionCommand({
          KeyId: keyArn,
          PendingWindowInDays: 7,
        }),
      );
      const winner = await describeKeyArn(kms, alias);
      if (winner !== undefined) return winner;
    }
    throw err;
  }
  return keyArn;
}

async function describeKeyArn(
  kms: KMSClient,
  alias: string,
): Promise<string | undefined> {
  try {
    const res = await kms.send(new DescribeKeyCommand({ KeyId: alias }));
    return res.KeyMetadata?.Arn;
  } catch (err) {
    if ((err as Error).name === "NotFoundException") return undefined;
    throw err;
  }
}

/** Resolves the twin's key or refuses: no key, no crypto — never a guess. */
async function resolveTwinKeyArn(
  kms: KMSClient,
  twinId: string,
): Promise<string> {
  const arn = await describeKeyArn(kms, twinAlias(twinId));
  if (arn === undefined) {
    throw new Error(`twin has no KMS key (run ensureTwinKey): ${twinId}`);
  }
  return arn;
}

/**
 * Generates a fresh 256-bit DEK under the twin's own key (resolved here,
 * never caller-supplied). Returns the unwrapped DEK (in private custody)
 * and the KMS-wrapped ciphertext for storage.
 */
export async function generateWrappedDek(
  kms: KMSClient,
  twinId: string,
): Promise<{ dek: Dek; wrappedDek: Uint8Array }> {
  const res = await kms.send(
    new GenerateDataKeyCommand({
      KeyId: await resolveTwinKeyArn(kms, twinId),
      KeySpec: "AES_256",
      EncryptionContext: encryptionContext(twinId),
    }),
  );
  if (res.Plaintext === undefined || res.CiphertextBlob === undefined) {
    throw new Error("KMS GenerateDataKey returned no key material");
  }
  const dek = createDekFromMaterial(res.Plaintext);
  res.Plaintext.fill(0);
  return { dek, wrappedDek: res.CiphertextBlob };
}

/**
 * Unwraps a stored DEK for its twin. The key is resolved from the twin id
 * (a twin without a key cannot unwrap anything), KMS enforces that KeyId
 * matches the blob, and the encryption context refuses a cross-twin unwrap
 * even under the right key (ADR-0008).
 */
export async function unwrapDek(
  kms: KMSClient,
  twinId: string,
  wrappedDek: Uint8Array,
): Promise<Dek> {
  const res = await kms.send(
    new DecryptCommand({
      KeyId: await resolveTwinKeyArn(kms, twinId),
      CiphertextBlob: wrappedDek,
      EncryptionContext: encryptionContext(twinId),
    }),
  );
  if (res.Plaintext === undefined) {
    throw new Error("KMS Decrypt returned no key material");
  }
  const dek = createDekFromMaterial(res.Plaintext);
  res.Plaintext.fill(0);
  return dek;
}
