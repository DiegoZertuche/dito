/**
 * THE SEND LOCK, COMPOSED FOR THE RUNTIME (ticket #24, split at #224;
 * ADR-0006, ADR-0017, ADR-0020).
 *
 * The logic is `@dito/seam`'s (`send-lock.ts`), because ADR-0006's second
 * minter is rep-web and rep-web may not depend on this package — it holds the
 * bundle, the KMS client and every automation registry, and the dashboard
 * holds no key (ADR-0008, ADR-0010). What is left here is the one thing that
 * differs between the two minters: WHAT RECORDING A REFUSAL MEANS.
 *
 * THE RUNTIME CHAINS, IN THE ATTEMPT'S OWN TRANSACTION. It holds the rep
 * chain's HMAC key, so a refusal becomes a chain entry the moment it happens
 * — the behaviour every suite of this package pins, unchanged. rep-web writes
 * `send_refusals` instead and the runtime drains it (`refusals.ts`); the seam
 * module's `deferRefusal` argues that trade.
 *
 * `assertHmacKey` AT CONSTRUCTION, kept: a writer with a weak chain key must
 * never come up looking operational (ADR-0020 custody). The seam's factory
 * cannot make that check — it knows nothing about keys, which is the point of
 * the split — so it belongs at the composition root that supplies one.
 */
import { appendAuditEntry, assertHmacKey } from "@dito/audit";
import {
  createSendLockWriter as createSeamSendLockWriter,
  type RefusalRecorder,
  type SendLockWriter,
} from "@dito/seam";
import type pg from "pg";

export {
  attemptSend,
  CONSERVATIVE_DEV_PACING,
  TAP_MINTERS,
  type CustomerSendRequest,
  type CustomerSendResult,
  type PacingThresholds,
  type RefusalReason,
  type SendLockWriter,
  type TapMinter,
} from "@dito/seam";

export function createSendLockWriter(opts: {
  pool: pg.Pool;
  hmacKey: Uint8Array;
}): SendLockWriter {
  const { pool, hmacKey } = opts;
  // Fail closed at construction (ADR-0020 custody): a writer with a weak
  // chain key must never come up looking operational.
  assertHmacKey(hmacKey);
  return createSeamSendLockWriter({
    sessions: pool,
    recordRefusal: chainedRefusals(hmacKey),
  });
}

/**
 * The recorder the lease holder uses: the chain itself, appended inside the
 * attempt's transaction so the entry and the rolled-back attempt commit
 * together.
 *
 * IT DROPS THE TWO TYPED FIELDS ON PURPOSE. `SendRefusal` carries the twin
 * and the draft twice — once rendered into `ref`, once typed for a recorder
 * that writes a ROW — and a chain entry takes only the four fields ADR-0020
 * names. Spreading the whole value would put a fifth and sixth column's worth
 * of data into `AuditEntry`, which does not have them.
 */
function chainedRefusals(hmacKey: Uint8Array): RefusalRecorder {
  return async (db, refusal) => {
    await appendAuditEntry(db, hmacKey, {
      caller: refusal.caller,
      action: refusal.action,
      ref: refusal.ref,
      outcome: refusal.outcome,
    });
  };
}
