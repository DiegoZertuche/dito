/**
 * THE DRAIN: a refusal recorded without a chain key reaches the chain
 * (ticket #224; ADR-0002, ADR-0008, ADR-0020).
 *
 * rep-web mints ADR-0006's second tap, so it can also REFUSE one — a draft
 * the rep already dismissed, a destination off the allowlist, a twin over its
 * pacing. Every one of those is an act whose only trace the chain would be
 * (Diego's rule, quoted in `audit-coverage.ts`), and rep-web holds no chain
 * key by design: a key on the far side of the custody boundary would let the
 * audited process write the record that audits it.
 *
 * So the dashboard writes the row and THE LEASE HOLDER CHAINS IT. This is
 * that step, and it is `crossPendingBindings`' shape for
 * `crossPendingBindings`' reason: a store the runtime sweeps so a gap opened
 * while it was stopped closes without anybody running anything by hand. It
 * runs every pass rather than once at start, because the refusals it drains
 * are written by ANOTHER PROCESS while this one is running — a startup-only
 * sweep would leave every refusal of a live session unchained until the next
 * restart.
 *
 * ═══ IDEMPOTENT, AND ON THE ROW RATHER THAN ON A CURSOR
 *
 * `chained_at IS NULL` is the claim and `FOR UPDATE SKIP LOCKED` is what
 * keeps two passes from chaining one row twice. A cursor — «everything after
 * id N» — would be wrong in the one case that matters: rep-web's INSERT
 * commits after its identity is assigned, so a row with a LOWER id can become
 * visible after a higher one has been drained, and a cursor would step over it
 * for ever.
 *
 * ═══ ONE TRANSACTION PER ROW, AND THE ORDER INSIDE IT
 *
 * The append and the stamp commit together, so a crash leaves a row that is
 * either chained and stamped or neither. Per row rather than per batch,
 * because the chain's tail lock serializes appenders anyway
 * (`appendAuditEntry`) and one failing row must not un-chain the ones before
 * it.
 *
 * ═══ IT NEVER THROWS FOR A ROW'S SAKE, AND THAT IS A CHOICE
 *
 * The loop's doctrine is fail-stop, and this is deliberately not part of it. A
 * refusal that cannot be chained is a record owed, not a crossing at risk:
 * nothing has left, nothing has been filed, and the ROW is still there to be
 * chained by the next pass or the next start. Stopping the twin over it would
 * cost the rep every draft for the sake of an entry that is not going
 * anywhere. So a failure is reported in the result and the pass carries on —
 * `serveRuntimeRequests`' rule, for a sibling reason.
 */
import { appendAuditEntry } from "@dito/audit";
import type { TapMinter } from "@dito/seam";
import type pg from "pg";
import { withDbTransaction } from "../db-tx.js";

/** What one pass of the drain did — reported by the loop, never guessed at. */
export interface DrainedRefusals {
  /** Rows chained by this pass. Zero on every pass with an empty backlog. */
  readonly chained: number;
  /**
   * Whether the pass stopped on a failure rather than on an empty backlog.
   *
   * A BOOLEAN AND NOT A LIST OF IDS, because the id is not knowable here: the
   * transaction that would have named it rolled back, taking the claim with
   * it. What the caller can act on is that the backlog is not empty and this
   * pass got nowhere — which is why the loop reports it rather than retrying,
   * as the header argues.
   */
  readonly stopped: boolean;
}

/**
 * Chains every `send_refusals` row nobody has chained yet, oldest first.
 *
 * ON THE RUNTIME'S OWN CLIENT, like every other pass of the loop: it runs
 * sequentially and `withDbTransaction` is what the consumer already opens for
 * a unit of work. `appendAuditEntry` refuses autocommit outright, so the
 * transaction is not optional.
 */
export async function drainSendRefusals(
  db: pg.ClientBase,
  hmacKey: Uint8Array,
): Promise<DrainedRefusals> {
  let chained = 0;
  for (;;) {
    let row: RefusalRow | undefined;
    try {
      row = await withDbTransaction(db, async () => {
        const claimed = await db.query<RefusalRow>(
          `SELECT id, twin_id, draft_id, minter, reason
             FROM send_refusals
            WHERE chained_at IS NULL
            ORDER BY id
            LIMIT 1
            FOR UPDATE SKIP LOCKED`,
        );
        const claim = claimed.rows[0];
        if (claim === undefined) return undefined;
        // THE SAME FOUR FIELDS THE WRITER WOULD HAVE CHAINED, rendered from
        // the row's own columns — so an entry a reader finds cannot say which
        // minter was holding a key (`SendRefusal` composes the `ref` once, in
        // the seam, for exactly this reason).
        await appendAuditEntry(db, hmacKey, {
          caller: claim.minter,
          action: "customer_send",
          ref: `twin:${claim.twin_id} draft:${claim.draft_id}`,
          outcome: `refused:${claim.reason}`,
        });
        await db.query(
          "UPDATE send_refusals SET chained_at = clock_timestamp() WHERE id = $1",
          [claim.id],
        );
        return claim;
      });
    } catch {
      // The backlog is left for the next pass: a store that refused an append
      // will refuse the next one too, and retrying here would turn one broken
      // row into a busy loop inside the poll.
      return { chained, stopped: true };
    }
    if (row === undefined) return { chained, stopped: false };
    chained += 1;
  }
}

interface RefusalRow {
  id: string;
  twin_id: string;
  draft_id: string;
  minter: TapMinter;
  reason: string;
}
