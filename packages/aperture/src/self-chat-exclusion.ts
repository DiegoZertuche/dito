/**
 * The ADR-0033 exclusion invariant (ticket #52; spec #48 grilling decision
 * 4; ADR-0004, ADR-0033).
 *
 * **No extraction run or fact row ever carries the twin thread as its
 * source.**
 *
 * ADR-0033 is the rule that stops the rep's own notes to their twin being
 * disclosed to their employer, and it is exactly the kind that rots
 * silently: extraction's input set is a list, and a later slice widening
 * that list will not re-read the ADR. The primary defence is structural —
 * extraction ENUMERATES bound, in-scope customer chats, and the twin thread
 * is in neither source (the plane never writes it to `scope_allowlist`, and
 * a binding names the customer a chat belongs to). This is the standing
 * check that the structure held, over real rows, in the FR-70/FR-72/FR-73
 * family.
 *
 * WHERE THE SELF-CHAT COMES FROM. Not from configuration — an invariant
 * that has to be told which chat to protect can be told the wrong one.
 * Every twin post the system has ever written is a `system_send`, and
 * ADR-0006 permits `system_send` ONLY to the rep's own self-chat. So the
 * seam itself names each twin's thread, and it names it the same way the
 * plane does. A twin whose thread this cannot find — or which has SEVERAL
 * candidates — is a VIOLATION rather than a pass: every check below joins
 * against that derivation, so an unidentifiable twin would sail through all
 * of them.
 *
 * RECORDED LIMITATION (Codex r1). `send_commands.destination` is ADVISORY:
 * the plane re-derives "self" from the live WhatsApp session at execution
 * and does not trust this column, so a misconfigured runtime would post to
 * the right thread while recording the wrong destination — and this
 * derivation would then guard a chat that is not the rep's. The ambiguity
 * check below catches the case where both values were ever written; it
 * cannot catch a value that was wrong from the first row. Closing that
 * needs the plane to PERSIST its live self identity as plane-owned
 * metadata, which is plane work and is recorded rather than built here.
 * What does not depend on this derivation is the primary defence:
 * extraction enumerates bound, in-scope customer chats, and the twin thread
 * is in neither source whatever this column says.
 *
 * WHAT IS DELIBERATELY NOT A VIOLATION. An ENTITY CREATE's disclosure line
 * cites the rep's «si», which arrives in the twin thread — and must. That
 * is a class-2 rep act: the rep deliberately telling their twin to record
 * something, disclosed to them in the same breath. ADR-0033 is about
 * PROVENANCE, and its test is "who said it and to whom": a rep-stated item
 * never crosses as extracted content, while the rep's own confirmation is
 * the one thing that is supposed to. The invariant scopes itself to
 * class-1 material — extraction-sourced facts — because that is what the
 * rule is about. There is no second class-1 store to sweep: the
 * candidate-question store is retired with its route (ticket #218), and a
 * clause naming a table the schema does not hold would report a violation
 * nobody can fix.
 *
 * Content-free: it reads ids and counts, never a message, a payload or a
 * rendered line.
 */
import pg from "pg";

export interface SelfChatViolation {
  /** "run:<uuid>", "fact:<uuid>" or "twin:<uuid>". */
  readonly subject: string;
  readonly reason: string;
}

export interface SelfChatExclusionReport {
  /** Twin threads identified from the seam — the corpus this ran against. */
  readonly selfChats: number;
  /** Extraction runs examined. */
  readonly extractionRuns: number;
  /** Extraction-sourced facts examined. */
  readonly extractedFacts: number;
  readonly violations: readonly SelfChatViolation[];
}

/**
 * Each twin's own thread, read off the outbound seam: `system_send` reaches
 * only the rep's self-chat (ADR-0006), so its destination IS the twin
 * thread.
 */
const SELF_CHATS = `
  SELECT DISTINCT twin_id, destination AS chat_jid
    FROM send_commands
   WHERE send_class = 'system_send'`;

/** Audits the ADR-0033 exclusion on the given database. */
export async function auditSelfChatExclusion(
  client: pg.ClientBase,
): Promise<SelfChatExclusionReport> {
  const counts = await client.query<{
    self_chats: number;
    extraction_runs: number;
    extracted_facts: number;
  }>(
    `SELECT (SELECT count(*) FROM (${SELF_CHATS}) s)::int AS self_chats,
            (SELECT count(*) FROM extraction_runs)::int AS extraction_runs,
            (SELECT count(*) FROM ledger.facts
              WHERE source_type = 'extraction')::int AS extracted_facts`,
  );

  const violations = await client.query<{ subject: string; reason: string }>(
    `WITH self AS (${SELF_CHATS})
     -- 1. A RUN over the twin thread. Extraction enumerates bound customer
     --    chats, so this row cannot exist — and if it does, the rep's own
     --    notes went to a model as extraction input.
     SELECT 'run:' || r.id AS subject,
            'extraction ran over the twin thread — the rep''s own notes are never an extraction input (ADR-0033)' AS reason
       FROM extraction_runs r
       JOIN self s ON s.twin_id = r.twin_id AND s.chat_jid = r.chat_jid
      UNION ALL
     -- 2. A FACT read in the twin thread. The seam composes
     --    external_event_id as '<chat jid>:<message id>', so the chat a
     --    fact was read in is on its disclosure line's source row. Scoped
     --    to source_type = 'extraction': an entity create's line cites the
     --    rep's own ‘si’ in this very thread, which is the class-2 act the
     --    rule exists to permit.
     SELECT 'fact:' || f.id,
            'a fact was extracted from the twin thread and crossed to the company — provenance decides what crosses, and a rep-stated item never does (ADR-0033)'
       FROM ledger.facts f
       JOIN disclosure_lines d
         ON d.subject_kind = 'fact' AND d.fact_id = f.id
       JOIN wa_events e ON e.id = d.source_event_id
       JOIN self s ON s.twin_id = d.twin_id
      WHERE f.source_type = 'extraction'
        AND left(e.external_event_id, length(s.chat_jid) + 1) = s.chat_jid || ':'
      UNION ALL
     -- 3. A twin whose thread cannot be IDENTIFIED at all. Every check
     --    above joins against the self CTE, so a twin with no system_send
     --    on the seam contributes no row to join against and every check
     --    passes it silently — the worst possible failure for an invariant
     --    whose whole job is to notice. A twin that extracted anything has
     --    posted at least a binding question to get a chat bound, so this
     --    state means the seam is incomplete, not that the twin is quiet.
     SELECT 'twin:' || r.twin_id,
            'extraction ran for a twin whose own thread cannot be identified from the seam — the exclusion could not be evaluated for it, and an uncheckable twin is not a passing one'
       FROM extraction_runs r
      WHERE NOT EXISTS (SELECT 1 FROM self s WHERE s.twin_id = r.twin_id)
      GROUP BY r.twin_id
      UNION ALL
     -- 4. ...or a twin with SEVERAL candidate threads. A system_send's
     --    destination is advisory — the plane re-derives self from the live
     --    session at execution (ADR-0006) — so this derivation is only as
     --    good as the fact that one twin has ever been told one thread. Two
     --    distinct destinations means one of them is wrong, and a check
     --    that joined against both would happily pass a breach through the
     --    real one. Ambiguity is reported, never resolved by picking.
     SELECT 'twin:' || s.twin_id,
            'this twin has ' || count(*)::text || ' distinct system_send destinations, so its own thread cannot be identified unambiguously — the exclusion is only as good as that identity'
       FROM self s
      GROUP BY s.twin_id
     HAVING count(*) > 1
      ORDER BY 1`,
  );

  return {
    selfChats: counts.rows[0]!.self_chats,
    extractionRuns: counts.rows[0]!.extraction_runs,
    extractedFacts: counts.rows[0]!.extracted_facts,
    violations: violations.rows.map((row) => ({
      subject: row.subject,
      reason: row.reason,
    })),
  };
}

/** Script entry (the `reconcileFr70At` pattern): its own client, no caller deps. */
export async function auditSelfChatExclusionAt(
  databaseUrl: string,
): Promise<SelfChatExclusionReport> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    return await auditSelfChatExclusion(client);
  } finally {
    await client.end();
  }
}
