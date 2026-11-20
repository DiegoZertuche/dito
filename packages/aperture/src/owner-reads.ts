/**
 * What the owner side reads, and the only SQL that reads it (ticket #129;
 * spec #126 decisions 2, 6, 14, 15, 16).
 *
 * WHY THIS IS A LIBRARY MODULE AND NOT THE APP'S OWN QUERIES. Two reasons,
 * and the first is mechanical: `sole-writer.test.ts` sweeps the whole repo
 * and refuses any `ledger.<identifier>` that is not a `finalized_` view
 * outside `packages/aperture` and `db/migrations`. The owner's merge-resolved
 * read calls two `ledger` FUNCTIONS by name, so an owner app that issued its
 * own SQL would turn that sweep red — correctly, because "the Ledger is
 * addressed, never traversed" (ADR-0004) is a property of the whole repo and
 * not of one package. The second is that this is a shared surface: the owner
 * web's pages (#129) and the owner twin's three projection tools (#130,
 * spec decision 16) ask the Ledger the same four questions, and two
 * implementations of "the owner's timeline" are two things that can disagree
 * about what the owner may see.
 *
 * THE CONNECTION IS THE CALLER'S, ALWAYS. Every function here takes a
 * `pg.ClientBase` the caller has already authenticated as `dito_owner` and
 * already declared a company on (`OWNER_COMPANY_SETTING`; see
 * `withOwnerConnection` in `apps/owner-web`). The aperture is a library and
 * holds no credential of its own — ADR-0002 — and the tenant is not a
 * parameter here for the same reason it is not a parameter on
 * `ledger.resolve_entity_for_declared_company`: a read's parameters narrow
 * ROWS and never the company (spec #126 decision 6). A connection that
 * declared no company reads nothing through the views and is refused by both
 * definer functions, which is the behaviour these functions inherit rather
 * than re-implement.
 *
 * THE PROJECTION IS THE GRANT (CONTEXT.md, Projection). Every column named
 * below is in `OWNER_VISIBLE_COLUMNS`, and the three views are the whole of
 * what `dito_owner` may select. `filed_by_twin_id`, `shadow` and
 * `retracted_at` are not withheld here — they are not in the views at all,
 * which is why no filter in this file can be forgotten. What this file adds
 * on top of the grant is one thing only: the merge resolution the owner
 * cannot walk for itself.
 */
import type pg from "pg";

/** One cliente, as the owner's entity view returns it. */
export interface OwnerEntity {
  readonly entityId: string;
  /** `person` or `business` — display and merge safety only (ADR-0035). */
  readonly kind: string;
  readonly displayName: string;
  readonly createdAt: Date;
}

/**
 * One finalized fact with its owner-visible provenance (ADR-0004 as
 * amended): when it happened, when it was filed, how confident the twin
 * was, whether it came from extraction or from the rep's own act, and the
 * seat it was filed under. Never a chat, a number, a group or a twin id —
 * there is no column for one.
 */
export interface OwnerFact {
  /**
   * THE STABLE REFERENCE. The owner twin's answers cite rows by this and
   * the surface refuses a citation to a row no tool served (spec #126
   * decision 18), so it is the fact's own id and never an index into a
   * result.
   */
  readonly id: string;
  /**
   * The entity the fact was FILED against, which after a merge is not
   * necessarily the entity whose page it is on — facts never move
   * (ADR-0035).
   */
  readonly entityId: string;
  readonly factType: string;
  readonly payloadVersion: number;
  readonly payload: Readonly<Record<string, unknown>>;
  /** Valid time: when the thing happened. */
  readonly occurredAt: Date;
  /** Transaction time: when it crossed into the Ledger. */
  readonly filedAt: Date;
  /** 0–1, or null when the writer recorded none. */
  readonly confidence: number | null;
  /** `extraction` or `rep_act` (the Ledger's CHECK constraint). */
  readonly sourceType: string;
  readonly filedBySeatId: string | null;
  /**
   * The rep's display name through `seats_status`, or null when the filing
   * twin has no seat row — every fact filed before the registry existed is
   * one, and it renders as *not recorded* rather than vanishing.
   */
  readonly filedBySeatName: string | null;
}

/**
 * One cliente's timeline, merge-resolved (spec #126 decision 15).
 *
 * `entity` is the RESOLVED record: asking about a merge loser and asking
 * about the winner return the same page, which is what "the loser's id
 * stays resolvable forever" means on a surface. It is null when this
 * company has no such cliente — a cliente of another company, an id that
 * never existed, and a company whose Ledger was never lifted are all the
 * same answer from here, deliberately: an owner learns nothing about
 * another tenant from the shape of a refusal.
 */
export interface OwnerTimeline {
  readonly requestedEntityId: string;
  readonly entity: OwnerEntity | null;
  /** The resolved record and every record whose facts read forward under it. */
  readonly memberEntityIds: readonly string[];
  readonly facts: readonly OwnerFact[];
}

/**
 * What a caller may narrow a timeline to. Rows only, never columns, never a
 * company (spec #126 decision 6) — the owner twin's `read timeline` tool is
 * exactly these three parameters.
 */
export interface OwnerTimelineWindow {
  /** Inclusive lower bound on `occurredAt`. */
  readonly from?: Date;
  /** Inclusive upper bound on `occurredAt`. */
  readonly to?: Date;
  readonly factType?: string;
}

/** What the owner twin's `count facts` tool may narrow a count to. */
export interface OwnerFactCountQuery {
  readonly factType: string;
  readonly from?: Date;
  readonly to?: Date;
  readonly seatId?: string;
}

/**
 * ONE FACT, AS JSON, WRITTEN ONCE (ticket #131).
 *
 * Both reads that return facts — a cliente's timeline and the room's re-read
 * by id — build the same object out of the same eleven owner-visible values
 * and parse it with the same mapper. Two spellings of "what a fact is on the
 * owner's side" would be two things that can disagree about what may be
 * seen, which is the module header's own reason for existing.
 *
 * It expects `f` to be `ledger.finalized_facts` and `s` to be the
 * `public.seats_status` row joined to it.
 */
const OWNER_FACT_JSON = `jsonb_build_object(
  'id', f.id,
  'entityId', f.entity_id,
  'factType', f.fact_type,
  'payloadVersion', f.payload_version,
  'payload', f.payload,
  'occurredAt', f.occurred_at,
  'filedAt', f.filed_at,
  'confidence', f.confidence,
  'sourceType', f.source_type,
  'filedBySeatId', f.filed_by_seat_id,
  'filedBySeatName', s.display_name)`;

/**
 * Every cliente of the company this connection declared — one row per
 * customer, never one per record.
 *
 * THE MERGE FILTER IS THE POINT OF THE `WHERE` CLAUSE, and it is a reading
 * of the ticket rather than its literal words. #129 says "every entity in
 * `finalized_entities` for the company"; spec #126's tenth user story says
 * "a merged cliente reads as one timeline, so that two records of the same
 * customer never look like two customers". Listing the losers satisfies the
 * first sentence and breaks the second — two rows, near-identical names,
 * both opening the same page — so the list is one row per RESOLVED record.
 * A loser is not lost: its id still resolves, and `readOwnerTimeline` still
 * opens the survivor's page from it.
 *
 * The resolution runs per row through the definer wrapper because that is
 * the owner's only route to the merge graph — it may not read
 * `ledger.entity_merges` and may not call `ledger.active_entity_merges`,
 * which would hand it who merged with whom (…100050). A company's cliente
 * list is small and the function is `STABLE`, so the per-row call is the
 * cheap half of this page.
 */
export async function listOwnerEntities(
  client: pg.ClientBase,
): Promise<readonly OwnerEntity[]> {
  const res = await client.query<EntityRow>(
    `SELECT e.entity_id, e.kind, e.display_name, e.created_at
       FROM ledger.finalized_entities e
      WHERE ledger.resolve_entity_for_declared_company(e.entity_id) = e.entity_id
      ORDER BY e.display_name, e.entity_id`,
  );
  return res.rows.map(toOwnerEntity);
}

/**
 * The clientes whose name matches what somebody typed — the owner twin's
 * `resolve entity` tool (spec #126 decision 16), and the input to ADR-0039's
 * one legitimate ask.
 *
 * CANDIDATES, NEVER A CHOICE. It returns everything that matches, including
 * two, because deciding between two Torres is the model's ask to make and
 * not this function's to guess (ADR-0039). An empty array is a real answer.
 *
 * MATCHING IS CASE- AND ACCENT-INSENSITIVE, because a person types a name
 * and not an identifier — the same policy `answering.ts` states for the rep
 * side's name→chat resolution, and the same fold. It is a copy of that fold
 * and not an import: `@dito/twin-runtime` depends on `@dito/aperture`, so
 * the arrow cannot run the other way, and an owner surface must not carry
 * the twin runtime's dependencies into its process anyway (ADR-0002). One
 * fold in two places is recorded as remainder; the fix is a package below
 * both, and inventing a THIRD normalization would be worse than either.
 *
 * The fold runs in TypeScript over the company's own list rather than in
 * SQL, so there is one definition of "the same name" and not a second one
 * written in `lower(translate(…))` that can drift from it.
 */
export async function resolveOwnerEntityByName(
  client: pg.ClientBase,
  name: string,
): Promise<readonly OwnerEntity[]> {
  const wanted = foldName(name);
  if (wanted === "") return [];
  const entities = await listOwnerEntities(client);
  return entities.filter((entity) => foldName(entity.displayName) === wanted);
}

/**
 * One cliente's timeline, merge-resolved, in `occurred_at` order.
 *
 * ONE STATEMENT, ONE SNAPSHOT — the lesson `readResolvedTimeline` learned in
 * its own review and the reason this is not three queries. Resolution,
 * membership and the facts read under READ COMMITTED as three statements are
 * three snapshots, and a merge committing between them produces a page
 * naming a member whose facts it had already decided not to show: an answer
 * that was never true of the database.
 *
 * FACTS ARE JOINED ON THE MEMBER SET, NOT ON THE RESOLVED ID, because a
 * merge is a redirect and facts never move (ADR-0035). Joining on the
 * survivor alone would silently drop the older half of a merged customer's
 * history — the half a merge exists to bring back — with nothing on the page
 * to say so.
 *
 * THERE IS NO GRANT JOIN HERE, and its absence is the difference between
 * this read and the rep side's. A rep sees an entity through
 * `ledger.entity_grants`; the owner sees its own company's Ledger, and what
 * bounds it is the company policy and the finalized views, which is why this
 * function names neither a grant nor a twin.
 */
export async function readOwnerTimeline(
  client: pg.ClientBase,
  entityId: string,
  window: OwnerTimelineWindow = {},
): Promise<OwnerTimeline> {
  const res = await client.query<TimelineResultRow>(
    `WITH resolved (entity_id) AS (
         SELECT ledger.resolve_entity_for_declared_company($1)
     ),
     members (entity_id) AS (
         SELECT m FROM ledger.resolved_members_for_declared_company($1) m
     )
     SELECT (SELECT entity_id FROM resolved) AS resolved_id,
            (SELECT array_agg(entity_id ORDER BY entity_id) FROM members)
              AS member_ids,
            (SELECT jsonb_build_object(
                      'entityId', e.entity_id,
                      'kind', e.kind,
                      'displayName', e.display_name,
                      'createdAt', e.created_at)
               FROM ledger.finalized_entities e
              WHERE e.entity_id = (SELECT entity_id FROM resolved)) AS entity,
            (SELECT jsonb_agg(${OWNER_FACT_JSON} ORDER BY f.occurred_at, f.id)
               FROM ledger.finalized_facts f
               JOIN members m ON m.entity_id = f.entity_id
               LEFT JOIN public.seats_status s
                 ON s.seat_id = f.filed_by_seat_id
              WHERE ($2::timestamptz IS NULL OR f.occurred_at >= $2)
                AND ($3::timestamptz IS NULL OR f.occurred_at <= $3)
                AND ($4::text IS NULL OR f.fact_type = $4)) AS facts`,
    [
      entityId,
      window.from ?? null,
      window.to ?? null,
      window.factType ?? null,
    ],
  );
  const row = res.rows[0]!;
  return {
    requestedEntityId: entityId,
    entity: row.entity === null ? null : toOwnerEntityFromJson(row.entity),
    memberEntityIds: row.member_ids ?? [],
    facts: (row.facts ?? []).map(toOwnerFact),
  };
}

/**
 * How many facts of one type the company filed — the owner twin's `count
 * facts` tool (spec #126 decision 16), and the reason «¿cuántas cotizaciones
 * dio Mauricio esta semana?» has an answer at all (ADR-0004 as amended).
 *
 * A COUNT IS CODE'S, NEVER THE MODEL'S (spec #126 decision 7): the number
 * this returns is rendered as a value and the model never types one, which
 * is why this exists as a tool instead of being read off a timeline the
 * model then counts.
 *
 * NOT MERGE-RESOLVED, and it does not need to be: a count is over the
 * company's facts and not over one cliente's, so every member's rows are in
 * it already, once each. Adding an entity parameter would make the
 * resolution question real; the tool the spec names has no entity parameter.
 */
export async function countOwnerFacts(
  client: pg.ClientBase,
  query: OwnerFactCountQuery,
): Promise<number> {
  const res = await client.query<{ n: string }>(
    `SELECT count(*) AS n
       FROM ledger.finalized_facts f
      WHERE f.fact_type = $1
        AND ($2::timestamptz IS NULL OR f.occurred_at >= $2)
        AND ($3::timestamptz IS NULL OR f.occurred_at <= $3)
        AND ($4::uuid IS NULL OR f.filed_by_seat_id = $4)`,
    [query.factType, query.from ?? null, query.to ?? null, query.seatId ?? null],
  );
  return Number(res.rows[0]!.n);
}

/**
 * The rows a STORED ANSWER cited, read again by their own ids (ticket #131).
 *
 * WHY THE OWNER SIDE NEEDED A READ BY ID AT ALL. The room's scroll is the
 * owner's earlier turns, and an answer is kept as the prose the twin wrote
 * plus the ids of the rows it rests on — never as markup (`owner.answers.refs`,
 * and `served.ts`'s note on the persisted reference: "a stored answer
 * re-renders from the Ledger by id rather than from stored markup, and reads
 * today's provenance for the fact rather than a snapshot of yesterday's").
 * Re-rendering it therefore asks the one question the four reads above
 * cannot: *what is the row behind this id now*. `readOwnerTimeline` answers
 * it only for a caller that already knows which cliente the fact was filed
 * against, and a stored reference deliberately keeps the fact's id and
 * nothing else.
 *
 * THE PROJECTION IS THE SAME ONE, COLUMN FOR COLUMN, as `readOwnerTimeline`'s
 * — every name below is in `OWNER_VISIBLE_COLUMNS` and FR-71a diffs that
 * list against the catalog. These add a `WHERE`, never a column: a read by
 * id can return less than a timeline and never more.
 *
 * THE TENANT IS STILL THE CONNECTION'S. `finalized_facts` is under the
 * company policy through `dito_ledger_views`, so an id belonging to another
 * company is not a row this query can return — an owner handed one gets an
 * empty result, which is the same answer they get for an id that never
 * existed (ADR-0002).
 *
 * A MERGE LOSER IS RETURNED AS ITSELF, and that is deliberate for the
 * entities read: `listOwnerEntities` drops losers because a LIST of customers
 * must not show one customer twice, while an answer that named a record
 * before it was merged named THAT record, and re-rendering it under the
 * survivor's name would put a word in the twin's mouth it never said. The
 * pill still opens the survivor's page, because `readOwnerTimeline` resolves
 * the loser's id — which is what "the loser's id stays resolvable forever"
 * is for.
 */
export async function readOwnerFactsByIds(
  client: pg.ClientBase,
  factIds: readonly string[],
): Promise<readonly OwnerFact[]> {
  if (factIds.length === 0) return [];
  // THE SAME PROJECTION AND THE SAME MAPPER as the timeline's, written
  // once: a second reading of a fact is a second thing that can disagree
  // about what the owner may see, and the module header says why that is
  // the one thing this file exists to prevent.
  const res = await client.query<{ facts: FactJson[] | null }>(
    `SELECT jsonb_agg(${OWNER_FACT_JSON} ORDER BY f.occurred_at, f.id) AS facts
       FROM ledger.finalized_facts f
       LEFT JOIN public.seats_status s ON s.seat_id = f.filed_by_seat_id
      WHERE f.id = ANY($1::uuid[])`,
    [[...factIds]],
  );
  return (res.rows[0]?.facts ?? []).map(toOwnerFact);
}

/** ...and the clientes an answer named, by their own ids (ticket #131). */
export async function readOwnerEntitiesByIds(
  client: pg.ClientBase,
  entityIds: readonly string[],
): Promise<readonly OwnerEntity[]> {
  if (entityIds.length === 0) return [];
  const res = await client.query<EntityRow>(
    `SELECT e.entity_id, e.kind, e.display_name, e.created_at
       FROM ledger.finalized_entities e
      WHERE e.entity_id = ANY($1::uuid[])`,
    [[...entityIds]],
  );
  return res.rows.map(toOwnerEntity);
}

/** ...and the seats it named, from the same three pinned columns (ticket #131). */
export async function readOwnerSeatsByIds(
  client: pg.ClientBase,
  seatIds: readonly string[],
): Promise<readonly OwnerSeat[]> {
  if (seatIds.length === 0) return [];
  const res = await client.query<{
    seat_id: string;
    display_name: string;
    state: string;
  }>(
    `SELECT seat_id, display_name, state
       FROM public.seats_status
      WHERE seat_id = ANY($1::uuid[])`,
    [[...seatIds]],
  );
  return res.rows.map((row) => ({
    seatId: row.seat_id,
    displayName: row.display_name,
    state: row.state,
  }));
}

/**
 * One seat, as the owner's seats view returns it — the three pinned columns
 * and nothing else (ticket #130). `twin_id` is not in the view (ADR-0004 as
 * amended: the seat crosses, the twin does not), so no filter here can be
 * forgotten.
 */
export interface OwnerSeat {
  readonly seatId: string;
  readonly displayName: string;
  /** `active` only this slice (ADR-0027's lifecycle is a stub). */
  readonly state: string;
}

/**
 * The seats of the company this connection declared whose display name is
 * the one somebody typed — the owner twin's `count facts` tool narrowing a
 * count to one rep (ticket #130; spec #126 decision 16; user story 7).
 *
 * WHY IT IS AN OWNER READ AND NOT THE TWIN'S OWN. Decision 16 gives the
 * count tool three parameters — "fact type, window, seat" — and a seat is
 * named by a person, not by a uuid: `countOwnerFacts` takes a `seatId` and
 * nothing on the owner side turned a name into one. This is the fifth
 * question the owner side asks the database, so it belongs beside the other
 * four for the reason the module header gives: two implementations of what
 * the owner may read are two things that can disagree.
 *
 * CANDIDATES, NEVER A CHOICE — `resolveOwnerEntityByName`'s rule, for the
 * same reason: two reps called Ana are two answers, and picking one is not
 * this function's decision to make. An empty array is a real answer.
 *
 * The tenant is the connection's declared company, never a parameter: the
 * view is under the company policy through `dito_ledger_views`, so a seat of
 * another company is not a row this query can return.
 */
export async function resolveOwnerSeatByName(
  client: pg.ClientBase,
  name: string,
): Promise<readonly OwnerSeat[]> {
  const wanted = foldName(name);
  if (wanted === "") return [];
  // THE THREE PINNED COLUMNS BY NAME, never a star: a column added to this
  // view by a later migration would otherwise arrive in an owner twin's
  // tool result without anybody writing it down (`OWNER_VISIBLE_COLUMNS`
  // is what says which three, and FR-71a diffs it against the catalog).
  const res = await client.query<{
    seat_id: string;
    display_name: string;
    state: string;
  }>("SELECT seat_id, display_name, state FROM public.seats_status");
  return res.rows
    .filter((row) => foldName(row.display_name) === wanted)
    .map((row) => ({
      seatId: row.seat_id,
      displayName: row.display_name,
      state: row.state,
    }));
}

/**
 * Case- and accent-insensitive, the way a person types a name.
 *
 * The same fold as `answering.ts`'s `foldName` on the rep side; see
 * `resolveOwnerEntityByName` for why it is copied rather than imported.
 */
function foldName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim();
}

/** `ledger.finalized_entities` as the driver returns it. */
interface EntityRow {
  entity_id: string;
  kind: string;
  display_name: string;
  created_at: Date | string;
}

/** ...and as `jsonb_build_object` returns it, where every value is text. */
interface EntityJson {
  entityId: string;
  kind: string;
  displayName: string;
  createdAt: string;
}

/** One fact, through JSON, so the instants arrive as text and are parsed here. */
interface FactJson {
  id: string;
  entityId: string;
  factType: string;
  payloadVersion: number;
  payload: Record<string, unknown>;
  occurredAt: string;
  filedAt: string;
  confidence: number | string | null;
  sourceType: string;
  filedBySeatId: string | null;
  filedBySeatName: string | null;
}

interface TimelineResultRow {
  resolved_id: string;
  member_ids: string[] | null;
  entity: EntityJson | null;
  facts: FactJson[] | null;
}

/** ...off a plain result row, where the driver has already parsed the date. */
function toOwnerEntity(row: EntityRow): OwnerEntity {
  return {
    entityId: row.entity_id,
    kind: row.kind,
    displayName: row.display_name,
    createdAt: new Date(row.created_at),
  };
}

/** ...and off the timeline's one statement, where it arrived through JSON. */
function toOwnerEntityFromJson(row: EntityJson): OwnerEntity {
  return {
    entityId: row.entityId,
    kind: row.kind,
    displayName: row.displayName,
    createdAt: new Date(row.createdAt),
  };
}

function toOwnerFact(fact: FactJson): OwnerFact {
  return {
    id: fact.id,
    entityId: fact.entityId,
    factType: fact.factType,
    payloadVersion: fact.payloadVersion,
    payload: fact.payload,
    occurredAt: new Date(fact.occurredAt),
    filedAt: new Date(fact.filedAt),
    confidence: fact.confidence === null ? null : Number(fact.confidence),
    sourceType: fact.sourceType,
    filedBySeatId: fact.filedBySeatId,
    filedBySeatName: fact.filedBySeatName,
  };
}
