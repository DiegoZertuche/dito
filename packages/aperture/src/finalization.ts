/**
 * The correction window closes (ticket #54; spec #48 grilling decision 15;
 * ADR-0004; FR-35).
 *
 * A fact nobody corrects finalizes **24 hours after the rep could actually
 * have read the statement disclosing it** — never 24 hours after it was
 * filed. ADR-0004 is exact about this: facts "self-finalize after 24h — but
 * the clock starts only once the fact's disclosure line is rep-reachable".
 * A disclosure that arrived while the rep was asleep does not finalize
 * before they have seen it, and a disclosure that never arrived at all does
 * not finalize.
 *
 * REP-REACHABLE IS A QUESTION ABOUT DELIVERY, asked where delivery is
 * known: the disclosure post's `system_send` resolving `sent`. A post whose
 * send `failed`, was `held`, or is still in flight reached nobody — which
 * is exactly what `readPendingLines` (ticket #51) concludes when it decides
 * a line is still owed. The two agree by construction because both ask
 * `send_commands.outcome`, and they must: a line the disclosure pass will
 * carry again is a line the rep has not read, and finalizing it would close
 * a window that never opened.
 *
 * `now` IS EXPLICIT — the `reconcileFr70At` shape. No clock seam, no fake
 * timers, no ambient time anywhere in the module: the caller says what
 * instant it is and the pass decides against that. The one place a wall
 * clock is the right answer is the runtime loop, which reads it once and
 * hands it to every daily pass.
 *
 * THE STORED VALUE DOES NOT DEPEND ON WHEN THE PASS RAN. `finalized_at` is
 * `reachable_at + 24h`, so a fact whose window closed while the laptop was
 * shut finalizes at the instant it actually became final, and re-running
 * the pass at any later `now` recomputes the same timestamp. Idempotent in
 * VALUE, not merely in effect.
 *
 * NOTHING HERE TOUCHES `shadow` — still true, and since ticket #132 its
 * second half has to be said out loud. `ledger.finalized_facts` requires
 * BOTH, finalized and not shadow, and this pass decides exactly one of them.
 * The other is decided in two places that are not here: the aperture STAMPS
 * `shadow` at filing from its company's mode, and the LIFT ACT flips a
 * company's standing rows once, audit-chained, when its Ledger is lifted
 * (ADR-0016 as amended; `shadow-lift.ts`). So a fact going final becomes
 * owner-visible exactly when its company was lifted before it was filed or
 * has been lifted since — and this pass neither knows nor asks which. It is
 * the clock, and the clock has no opinion about who may read.
 *
 * AND IT IS NOT A REP ACT, so it is not audit-chained. Spec #48 decision 18
 * chains rep acts and refusals; finalization is the clock, performed by
 * nobody, and chaining every expiry would bury the acts the chain exists to
 * make auditable.
 */
import type pg from "pg";

/**
 * What the clock needs, and nothing more: the seam.
 *
 * Deliberately NOT `ApertureContext`. That type carries a twin DEK because
 * rep-act verification decrypts seam payloads — and finalization verifies
 * nothing, decrypts nothing and is nobody's act, so asking for a key would
 * mean a script that runs a clock has to load a twin's key to do it. The
 * narrower type is the honest statement of what this path can reach.
 */
export interface LedgerClockContext {
  readonly db: pg.ClientBase;
}

/**
 * The correction window, in hours (ADR-0004, CONTEXT.md's *Correction
 * window*). Twenty-four REAL hours: the interval is added as hours rather
 * than as a day, so a window that spans a DST transition is still 24 hours
 * of the rep's actual life.
 */
export const CORRECTION_WINDOW_HOURS = 24;

export interface FinalizationResult {
  /** Facts this call finalized. Zero on every run after the first. */
  readonly finalized: number;
  /** Their ids, oldest window first — what a caller reports out loud. */
  readonly factIds: readonly string[];
}

/**
 * Finalizes every fact of this twin whose correction window closed at or
 * before `now`.
 *
 * IDEMPOTENT AND RESTART-SAFE, in one statement. `finalized_at IS NULL` is
 * the guard and the UPDATE is the claim, so two passes racing serialize on
 * the row and the second finalizes nothing; a crash mid-pass leaves either
 * a finalized row or an untouched one, and the next pass finishes the rest.
 * A fact finalizes exactly once.
 *
 * A RETRACTED FACT NEVER FINALIZES (FR-33). The guard says so, and so does
 * the CHECK underneath it — so even a future caller that dropped the
 * predicate could not commit the row.
 */
export async function finalizeDueFacts(
  ctx: LedgerClockContext,
  target: { readonly twinId: string },
  now: Date,
): Promise<FinalizationResult> {
  const res = await ctx.db.query<{ id: string }>(
    `UPDATE ledger.facts f
        SET finalized_at = reach.reachable_at + $3 * interval '1 hour'
       FROM (
         -- WHEN THE LINE BECAME REP-REACHABLE. A line can ride more than
         -- one post — #51's redelivery returns the lines of a post whose
         -- send definitively failed — so the clock starts at the EARLIEST
         -- post that actually reached the rep, not the latest attempt.
         SELECT dl.company_id, dl.fact_id, min(sc.executed_at) AS reachable_at
           FROM disclosure_lines dl
           JOIN disclosure_post_lines pl
             ON pl.twin_id = dl.twin_id AND pl.disclosure_line_id = dl.id
           JOIN disclosure_posts p
             ON p.twin_id = pl.twin_id AND p.id = pl.post_id
           JOIN send_commands sc
             ON sc.twin_id = p.twin_id
            AND sc.payload_ref = 'notice:' || p.notice_id
          WHERE dl.twin_id = $1
            AND dl.subject_kind = 'fact'
            -- 'sent' and nothing else. A 'failed' or 'held' outcome, and a
            -- command still in flight, all mean the rep was not reached —
            -- and the disclosure pass will carry the line again, so
            -- finalizing here would close a window that never opened.
            AND sc.outcome = 'sent'
          GROUP BY dl.company_id, dl.fact_id
       ) AS reach
      WHERE f.company_id = reach.company_id
        AND f.id = reach.fact_id
        AND f.finalized_at IS NULL
        AND f.retracted_at IS NULL
        AND reach.reachable_at + $3 * interval '1 hour' <= $2
    RETURNING f.id`,
    [target.twinId, now, CORRECTION_WINDOW_HOURS],
  );
  return { finalized: res.rows.length, factIds: res.rows.map((r) => r.id) };
}

// NO `finalizeDueFactsAt` HERE, deliberately — and ticket #67 confirmed it
// rather than overturning it. The `reconcileFr70At` shape this module
// borrows is about the explicit `now`, not about the its-own-client script
// entry that goes with it in the invariant scripts — and the invariants
// have entries because a CI step runs them from the command line. The rig
// did eventually want a hand trigger for this pass, and it lives where the
// rig's other two do: `packages/twin-runtime/scripts/rig-finalize.ts`. What
// it needed from the rig turned out to be the CLOCK rather than the
// composition — it reads the same steering instant as the extraction and
// disclosure triggers, and then calls the function above with an instant
// like every other caller. It opens no bundle and holds no key, because
// this pass verifies nothing and decrypts nothing, which is exactly what
// `LedgerClockContext` says.
