/**
 * ONE CUSTOMER'S RECORD AS THE REP WAS SHOWN IT (tickets #196, #320): the
 * lines of the day's notes filed against one entity, newest first, and whether
 * the rep has since marked each wrong. Extraction's `read_filed_facts` and the
 * thread's `read_entity` read it the same way.
 */
import type pg from "pg";

/**
 * How many of one customer's lines a read serves.
 *
 * TWENTY, MOST RECENT FIRST AND PRINTED OLDEST FIRST. A reference points
 * BACKWARDS — «el pedido pasado», «lo de siempre» — so the recent end is the
 * one that can resolve it, and a customer of two years has more lines than
 * any budget should carry. The bound is part of the projection: a read whose
 * size the caller decides is a read whose reach the caller decides.
 */
export const FILED_LINES_LIMIT = 20;

/** One customer's own lines, newest first — the rep-side rows and nothing else. */
export async function readFiledLines(
  db: pg.ClientBase,
  whose: { readonly twinId: string; readonly entityId: string },
): Promise<
  readonly {
    filed_at: Date;
    rendered_text: string;
    retracted: boolean;
  }[]
> {
  // TWO REP-SIDE STORES AND NO LEDGER TABLE (spec #171 decision 4). The line
  // is what the rep was shown and `fact_retractions` is the rep's own «N no»
  // — both plaintext, both already crossed, both already readable by this
  // role. `sole-writer.test.ts` is what keeps that claim honest: no source
  // outside `packages/aperture` may name a `ledger` table at all.
  const res = await db.query<{
    filed_at: Date;
    rendered_text: string;
    retracted: boolean;
  }>(
    `SELECT dl.filed_at, dl.rendered_text,
            (fr.fact_id IS NOT NULL) AS retracted
       FROM disclosure_lines dl
       LEFT JOIN fact_retractions fr
         ON fr.twin_id = dl.twin_id AND fr.fact_id = dl.fact_id
      WHERE dl.twin_id = $1 AND dl.entity_id = $2
        AND dl.subject_kind = 'fact'
      ORDER BY dl.filed_at DESC, dl.id DESC
      LIMIT $3`,
    [whose.twinId, whose.entityId, FILED_LINES_LIMIT],
  );
  return res.rows;
}
