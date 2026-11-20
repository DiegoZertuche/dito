/**
 * FR-72 disclosure reconciliation (ticket #50; spec #48 testing decisions;
 * ADR-0003): every filed item has exactly one disclosure line, and every
 * disclosure line maps to a filed item.
 *
 * The database already makes the ordinary failure unrepresentable — the
 * deferred constraint triggers on `ledger.facts` and `ledger.entities`
 * refuse a transaction that files without disclosing, and the partial
 * unique indexes refuse a second line. This is the INDEPENDENT AUDITOR
 * over them, in the FR-70 shape: it catches what only a superuser can do
 * (disable a trigger, delete a line afterwards), and the mismatches the
 * constraints cannot see — a line scoped to a different company than its
 * subject, or attributed to a twin whose evidence belongs to another.
 *
 * An undisclosed crossing is a trust incident, so it is a build
 * failure here rather than something discovered later.
 */
import pg from "pg";

export interface Fr72Violation {
  /** What the violation hangs off: "fact:<uuid>", "entity:<uuid>" or "line:<uuid>". */
  readonly subject: string;
  readonly reason: string;
}

export interface Fr72Report {
  /** Facts examined. */
  readonly facts: number;
  /** Entity creates examined. */
  readonly entityCreates: number;
  /** Disclosure lines examined. */
  readonly disclosureLines: number;
  readonly violations: readonly Fr72Violation[];
}

/** Reconciles the crossing against its disclosure lines on the given database. */
export async function reconcileFr72(client: pg.ClientBase): Promise<Fr72Report> {
  const counts = await client.query<{
    facts: number;
    entity_creates: number;
    disclosure_lines: number;
  }>(
    `SELECT (SELECT count(*) FROM ledger.facts)::int AS facts,
            (SELECT count(*) FROM ledger.entities)::int AS entity_creates,
            (SELECT count(*) FROM disclosure_lines)::int AS disclosure_lines`,
  );

  const violations = await client.query<{ subject: string; reason: string }>(
    `-- A fact that crossed with no disclosure line. The whole point.
     SELECT 'fact:' || f.id AS subject,
            'fact filed with no disclosure line — it crossed the wall undisclosed (FR-72)' AS reason
       FROM ledger.facts f
       LEFT JOIN disclosure_lines d
         ON d.subject_kind = 'fact' AND d.fact_id = f.id
      WHERE d.id IS NULL
      UNION ALL
     -- Two lines for one fact: the rep was told twice about one crossing,
     -- so "everything filed that day" stops being countable (FR-38).
     SELECT 'fact:' || f.id,
            'fact carries ' || count(*)::text || ' disclosure lines — the line is 1:1 with the fact it discloses'
       FROM ledger.facts f
       JOIN disclosure_lines d
         ON d.subject_kind = 'fact' AND d.fact_id = f.id
      GROUP BY f.id
     HAVING count(*) > 1
      UNION ALL
     -- The entity create half (ADR-0003 as amended): a create puts a name
     -- from the rep's conversation into the Ledger for the first time.
     SELECT 'entity:' || e.entity_id,
            'entity created with no disclosure line — the name crossed undisclosed (ADR-0003 as amended)'
       FROM ledger.entities e
       LEFT JOIN disclosure_lines d
         ON d.subject_kind = 'entity_create'
        AND d.company_id = e.company_id
        AND d.entity_id = e.entity_id
      WHERE d.id IS NULL
      UNION ALL
     -- Two lines for one entity create — the same claim of 1:1, on the
     -- other subject kind. The partial unique index makes it
     -- unrepresentable; an audit that only checked the half the index
     -- already covers would be checking nothing.
     SELECT 'entity:' || e.entity_id,
            'entity carries ' || count(*)::text || ' disclosure lines — the line is 1:1 with the create it discloses'
       FROM ledger.entities e
       JOIN disclosure_lines d
         ON d.subject_kind = 'entity_create'
        AND d.company_id = e.company_id
        AND d.entity_id = e.entity_id
      GROUP BY e.entity_id
     HAVING count(*) > 1
      UNION ALL
     -- An entity create with no creation grant: filed, disclosed, and
     -- unreadable by the rep whose binding created it.
     SELECT 'entity:' || e.entity_id,
            'entity filed with no creation grant — binding a chat auto-grants the creating rep'
       FROM ledger.entities e
       LEFT JOIN ledger.entity_grants g
         ON g.company_id = e.company_id
        AND g.entity_id = e.entity_id
        AND g.source = 'creation'
      WHERE g.twin_id IS NULL
      UNION ALL
     -- ...or a creation grant for a DIFFERENT rep than the one who was
     -- told. Checking the grant and the line separately would pass this:
     -- one rep is recorded as the creator, another gets the disclosure,
     -- and neither the trigger's existence test nor the line's own scope
     -- checks would notice. It is the join that catches it.
     SELECT 'entity:' || e.entity_id,
            'entity records one twin as its creator and discloses the create to another — the rep who created it is the rep who is told about it'
       FROM ledger.entities e
       JOIN ledger.entity_grants g
         ON g.company_id = e.company_id
        AND g.entity_id = e.entity_id
        AND g.source = 'creation'
       JOIN disclosure_lines d
         ON d.subject_kind = 'entity_create'
        AND d.company_id = e.company_id
        AND d.entity_id = e.entity_id
      WHERE d.twin_id <> g.twin_id
      UNION ALL
     -- An entity-create line naming no rep act ON EITHER SURFACE. A create is
     -- a class-2 act (ADR-0003); a line that cannot name the rep's own message
     -- OR their own dashboard act is a crossing nobody can trace to a rep.
     --
     -- BOTH COLUMNS, SINCE #224. The rep confirms a binding by replying in
     -- their own thread or by pressing the card's button, and spec #214
     -- decision 2 makes those one act — so asking only about the seam event
     -- would report every dashboard confirmation as a laundered crossing,
     -- which is the same failure as missing a real one, arriving from the
     -- other end. disclosure_lines_one_evidence_check refuses a line with
     -- both or neither; this is the auditor that does not trust it.
     SELECT 'line:' || d.id,
            'entity-create disclosure line names no rep-act evidence — a create is a rep act, and an untraceable one is what a laundered crossing looks like'
       FROM disclosure_lines d
      WHERE d.subject_kind = 'entity_create'
        AND d.source_event_id IS NULL AND d.dashboard_act_id IS NULL
      UNION ALL
     -- The converse: a line about nothing. The foreign keys make it
     -- unrepresentable; the audit refuses to trust that rather than check it.
     SELECT 'line:' || d.id,
            'disclosure line names fact ' || d.fact_id::text || ', which is not filed'
       FROM disclosure_lines d
       LEFT JOIN ledger.facts f ON f.id = d.fact_id
      WHERE d.subject_kind = 'fact' AND f.id IS NULL
      UNION ALL
     SELECT 'line:' || d.id,
            'disclosure line names entity ' || d.entity_id::text || ', which is not filed'
       FROM disclosure_lines d
       LEFT JOIN ledger.entities e
         ON e.company_id = d.company_id AND e.entity_id = d.entity_id
      WHERE d.subject_kind = 'entity_create' AND e.entity_id IS NULL
      UNION ALL
     -- A line scoped to a different company than the fact it discloses.
     -- The company-scoped foreign key makes it unrepresentable; the audit
     -- checks rather than believes, because a dropped constraint is
     -- exactly the change nobody notices.
     SELECT 'line:' || d.id,
            'disclosure line company differs from the company of the fact it discloses'
       FROM disclosure_lines d
       JOIN ledger.facts f ON f.id = d.fact_id
      WHERE d.subject_kind = 'fact' AND d.company_id <> f.company_id
      UNION ALL
     -- A line attributed to one twin, evidenced by another twin's message.
     -- The daily disclosure is per rep; a line in the wrong rep's journal
     -- discloses one rep's crossing to a different rep.
     --
     -- THE SCOPE IS COMPARED AGAINST WHICHEVER ACT EVIDENCED IT (ticket #224).
     -- The three columns come off the seam row for a thread act and off the
     -- dashboard_acts row for a card's, and the join is a LEFT JOIN on each
     -- so a line is compared against the one it actually names — where an
     -- inner join on wa_events alone would drop every dashboard-evidenced
     -- line out of all three checks and pass it silently, which is the worst
     -- failure an invariant can have.
     SELECT 'line:' || d.id,
            'disclosure line twin differs from the twin of its rep-act evidence'
       FROM disclosure_lines d
       LEFT JOIN wa_events e ON e.id = d.source_event_id
       LEFT JOIN dashboard_acts a ON a.id = d.dashboard_act_id
      WHERE d.twin_id <> COALESCE(e.twin_id, a.twin_id)
      UNION ALL
     SELECT 'line:' || d.id,
            'disclosure line company differs from the company of its rep-act evidence'
       FROM disclosure_lines d
       LEFT JOIN wa_events e ON e.id = d.source_event_id
       LEFT JOIN dashboard_acts a ON a.id = d.dashboard_act_id
      WHERE d.company_id <> COALESCE(e.company_id, a.company_id)
      UNION ALL
     SELECT 'line:' || d.id,
            'disclosure line seat differs from the seat of its rep-act evidence'
       FROM disclosure_lines d
       LEFT JOIN wa_events e ON e.id = d.source_event_id
       LEFT JOIN dashboard_acts a ON a.id = d.dashboard_act_id
      WHERE d.seat_id <> COALESCE(e.seat_id, a.seat_id)
      UNION ALL
     -- A fact disclosed to a rep other than the one who filed it. The
     -- daily disclosure is per rep and its completeness claim is about
     -- what THAT rep's twin crossed (FR-38); a line in the wrong journal
     -- both misinforms one rep and hides the crossing from another. Not
     -- reachable through the aperture, and representable in the schema —
     -- which is exactly what an independent auditor is for.
     SELECT 'line:' || d.id,
            'disclosure line twin differs from the twin that filed the fact it discloses'
       FROM disclosure_lines d
       JOIN ledger.facts f ON f.id = d.fact_id
      WHERE d.subject_kind = 'fact' AND d.twin_id <> f.filed_by_twin_id
      ORDER BY 1`,
  );

  return {
    facts: counts.rows[0]!.facts,
    entityCreates: counts.rows[0]!.entity_creates,
    disclosureLines: counts.rows[0]!.disclosure_lines,
    violations: violations.rows.map((row) => ({
      subject: row.subject,
      reason: row.reason,
    })),
  };
}

/**
 * Script entry (the reconcileFr70At pattern): reconciles the database at
 * `databaseUrl`, constructing its own client so callers stay
 * dependency-free.
 */
export async function reconcileFr72At(databaseUrl: string): Promise<Fr72Report> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    return await reconcileFr72(client);
  } finally {
    await client.end();
  }
}
