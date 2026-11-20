/**
 * The aperture's own read surface over what it filed (ticket #50).
 *
 * Two readers exist for the Ledger and they are not the same thing.
 * OWNER-FACING reads go through the finalized views, where the shadow
 * filter lives (ADR-0016) — and while everything this slice files is
 * shadow, those views are correctly empty. WRITER-FACING reads are these:
 * the aperture asking what it already filed, which is what makes a
 * retried confirmation idempotent and what lets a test assert that
 * something crossed at all.
 *
 * They live HERE, inside the single writer, for the same reason the writes
 * do: outside this package nothing addresses a Ledger table, so the launch
 * gate stays a `WHERE` clause in a view rather than a pipeline to rebuild
 * (the source scan in sole-writer.test.ts enforces exactly that).
 */
import type { ApertureContext, EntityRef } from "./inputs.js";
import type { EntityKind } from "./entities.js";

export interface FiledEntity extends EntityRef {
  readonly kind: EntityKind;
  readonly displayName: string;
  readonly createdAt: Date;
  readonly filedAt: Date;
  /** True while no owner may see it — the launch gate, per row (ADR-0016). */
  readonly shadow: boolean;
}

export interface FiledEntityGrant {
  readonly twinId: string;
  readonly source: "creation" | "owner_assigned";
  readonly grantedAt: Date;
}

/** One entity row as the Ledger stores it — the two entity reads share it. */
interface EntityRow {
  company_id: string;
  entity_id: string;
  kind: EntityKind;
  display_name: string;
  created_at: Date;
  filed_at: Date;
  shadow: boolean;
}

const ENTITY_COLUMNS =
  "company_id, entity_id, kind, display_name, created_at, filed_at, shadow";

function toFiledEntity(row: EntityRow): FiledEntity {
  return {
    companyId: row.company_id,
    entityId: row.entity_id,
    kind: row.kind,
    displayName: row.display_name,
    createdAt: row.created_at,
    filedAt: row.filed_at,
    shadow: row.shadow,
  };
}

/** One filed entity, shadow or not. Undefined when nothing has crossed under that id. */
export async function readFiledEntity(
  ctx: ApertureContext,
  target: EntityRef,
): Promise<FiledEntity | undefined> {
  const res = await ctx.db.query<EntityRow>(
    `SELECT ${ENTITY_COLUMNS}
       FROM ledger.entities
      WHERE company_id = $1 AND entity_id = $2`,
    [target.companyId, target.entityId],
  );
  const row = res.rows[0];
  return row === undefined ? undefined : toFiledEntity(row);
}

/**
 * Every entity one company has filed, oldest first (ticket #60).
 *
 * The list a kind determination is made over — the backfill's input, and
 * the operator's way of SEEING a wrong one: a name beside a kind is what
 * makes «Ferretería Fuentes» filed as `person` obvious at a glance. Ordered
 * by the same rule survivorship uses, so two runs read the same list.
 */
export async function listFiledEntities(
  // NO TWIN KEY, deliberately, as the matcher takes none (ADR-0004): what
  // a company's records ARE is decided from Ledger data, and a listing that
  // demanded an envelope it never opens would say the opposite in its own
  // signature. An `ApertureContext` satisfies this, so every caller passes
  // one unchanged.
  ctx: Pick<ApertureContext, "db">,
  companyId: string,
): Promise<FiledEntity[]> {
  const res = await ctx.db.query<EntityRow>(
    `SELECT ${ENTITY_COLUMNS}
       FROM ledger.entities
      WHERE company_id = $1
      ORDER BY created_at, entity_id`,
    [companyId],
  );
  return res.rows.map(toFiledEntity);
}

/**
 * One entity's grants, in grant order. Grants attach to the entity a fact
 * was filed against, never the resolved one (ADR-0035) — which is what
 * stops a merge from becoming privilege escalation.
 */
export async function readEntityGrants(
  ctx: ApertureContext,
  target: EntityRef,
): Promise<FiledEntityGrant[]> {
  const res = await ctx.db.query<{
    twin_id: string;
    source: "creation" | "owner_assigned";
    granted_at: Date;
  }>(
    `SELECT twin_id, source, granted_at
       FROM ledger.entity_grants
      WHERE company_id = $1 AND entity_id = $2
      ORDER BY granted_at, twin_id`,
    [target.companyId, target.entityId],
  );
  return res.rows.map((row) => ({
    twinId: row.twin_id,
    source: row.source,
    grantedAt: row.granted_at,
  }));
}

/**
 * One filed fact, with the line that disclosed it (ticket #52).
 *
 * The disclosure line rides along because the two are the crossing: FR-72
 * makes them 1:1 and the database refuses to hold one without the other, so
 * a reader that could see a fact and not what the rep was told about it
 * would be reading half of the thing that happened.
 */
export interface FiledFact {
  readonly id: string;
  readonly companyId: string;
  readonly entityId: string;
  readonly factType: string;
  /** `(factType, payloadVersion)` identifies the payload's shape (ADR-0034). */
  readonly payloadVersion: number;
  readonly payload: Readonly<Record<string, unknown>>;
  /** Valid time: when it was said in the chat. */
  readonly occurredAt: Date;
  readonly confidence: number | null;
  readonly sourceType: "extraction" | "rep_act";
  readonly shadow: boolean;
  readonly finalizedAt: Date | null;
  readonly retractedAt: Date | null;
  /** What the rep was told, exactly as it was rendered (ADR-0034). */
  readonly disclosureText: string;
  /**
   * The seam row this fact was READ IN — `disclosure_lines.source_event_id`,
   * which #52 widened to that meaning.
   *
   * NON-NULL HERE BECAUSE THE READ IS SCOPED TO `subject_kind = 'fact'`, and
   * `disclosure_lines_fact_has_seam_evidence_check` is what makes that a
   * guarantee rather than a habit (#224). The column is nullable now — a
   * binding the rep confirmed on the dashboard names a `dashboard_acts` row
   * instead — and only an entity create can be that act, so a fact line always
   * names a seam row.
   *
   * It is what makes a filed fact traceable back to the message that
   * produced it, in stored rows and with no model in the walk: the same
   * anchor the ADR-0033 exclusion invariant follows, and the join the
   * extraction-precision evals score against (#56). Rep-side only — it
   * lives on the disclosure line, never on the Ledger row, for the reason
   * that column already gives.
   */
  readonly sourceEventId: string;
}

/**
 * Every fact one twin has filed, oldest first — the writer-facing read.
 *
 * Scoped by `filed_by_twin_id`, which is deliberately absent from the
 * finalized view: it exists so a creation grant can be honoured and a
 * retirement can find its grants, not so an owner can read who said what
 * (ADR-0004). This reader is inside the aperture for exactly that reason.
 */
export async function readFiledFacts(
  ctx: ApertureContext,
  twinId: string,
): Promise<FiledFact[]> {
  const res = await ctx.db.query<{
    id: string;
    company_id: string;
    entity_id: string;
    fact_type: string;
    payload_version: number;
    payload: Record<string, unknown>;
    occurred_at: Date;
    confidence: string | null;
    source_type: "extraction" | "rep_act";
    shadow: boolean;
    finalized_at: Date | null;
    retracted_at: Date | null;
    rendered_text: string;
    source_event_id: string;
  }>(
    `SELECT f.id, f.company_id, f.entity_id, f.fact_type, f.payload_version,
            f.payload, f.occurred_at, f.confidence, f.source_type, f.shadow,
            f.finalized_at, f.retracted_at, d.rendered_text, d.source_event_id
       FROM ledger.facts f
       JOIN disclosure_lines d
         ON d.subject_kind = 'fact' AND d.fact_id = f.id
      WHERE f.filed_by_twin_id = $1
      ORDER BY f.occurred_at, f.fact_type, f.id`,
    [twinId],
  );
  return res.rows.map((row) => ({
    id: row.id,
    companyId: row.company_id,
    entityId: row.entity_id,
    factType: row.fact_type,
    payloadVersion: row.payload_version,
    payload: row.payload,
    occurredAt: row.occurred_at,
    // `numeric` comes back as a string from pg — parsed here rather than
    // left for each caller to remember.
    confidence: row.confidence === null ? null : Number(row.confidence),
    sourceType: row.source_type,
    shadow: row.shadow,
    finalizedAt: row.finalized_at,
    retractedAt: row.retracted_at,
    disclosureText: row.rendered_text,
    sourceEventId: row.source_event_id,
  }));
}

/**
 * The companies one twin has any standing in, read off its GRANTS (ticket
 * #55).
 *
 * The merge matcher is company-scoped, and a caller that named its own
 * company would be the client-supplied scope ADR-0035 forbids. This answers
 * the question from Ledger data the aperture already holds: a twin's grants
 * are exactly the entities it may read, and their company is the scope its
 * merges belong to. Almost always one row.
 *
 * Deliberately not derived from the seam. `wa_events` would answer the same
 * question and would put a chat-carrying table in the matcher's own call
 * path, which is the thing ADR-0004's structural sweep exists to prevent.
 */
export async function readTwinCompanies(
  ctx: ApertureContext,
  twinId: string,
): Promise<string[]> {
  const res = await ctx.db.query<{ company_id: string }>(
    `SELECT DISTINCT company_id FROM ledger.entity_grants
      WHERE twin_id = $1
      ORDER BY company_id`,
    [twinId],
  );
  return res.rows.map((row) => row.company_id);
}

/** How many entities have crossed for one company — the "did anything cross?" read. */
export async function countFiledEntities(
  ctx: ApertureContext,
  companyId: string,
): Promise<number> {
  const res = await ctx.db.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM ledger.entities WHERE company_id = $1",
    [companyId],
  );
  return res.rows[0]!.n;
}
