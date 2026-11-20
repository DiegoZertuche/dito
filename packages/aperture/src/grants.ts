/**
 * The Ledger grant audit (ticket #50; spec #48 grilling decision 2;
 * ADR-0003, ADR-0016) — grants, not convention.
 *
 * "Exactly one component holds Ledger write credentials" is only true if
 * the database says so. This audit reads the live catalog and checks four
 * claims, in the FR-70/FR-73 family:
 *
 *  1. The aperture writes the Ledger. Every `ledger` table is
 *     aperture-writable, and NONE is aperture-deletable — the Ledger is
 *     append-only; corrections annotate (FR-33).
 *  2. The twin runtime does not. No privilege of any kind on a `ledger`
 *     TABLE — not even SELECT, because a reader belongs at the views.
 *  3. The shadow filter lives inside the finalized-view definitions
 *     (ADR-0016). Every `ledger` table carrying a `shadow` column is
 *     covered by a view that filters it, and every `ledger` view filters
 *     it — which is what makes the launch gate a `WHERE` clause instead of
 *     a pipeline rebuild.
 *  4. The aperture's own two rep-side stores are aperture-written and
 *     runtime-read: the runtime may see a disclosure line to post it, and
 *     may never write one. And in the registries it reads exactly one
 *     thing — SELECT on `companies`, so the filing path can stamp `shadow`
 *     from a company's mode (…100070, ticket #132) — and nothing on
 *     `seats`, which carries the seat-to-twin mapping.
 *
 * FR-71a, THE OWNER'S HALF (ticket #127; spec #126 decisions 3, 4, 14 and
 * 20; ADR-0002, ADR-0004 as amended). `dito_owner` used to be "deliberately
 * absent and not audited here", because it did not exist and a role with no
 * client would have left a half-green audit. Slice 4 is the slice where a
 * process authenticates as it, so five more claims join the four above:
 *
 *  5. The owner role is exactly what …100020 made it: it can log in, it is
 *     not a superuser, it does NOT hold BYPASSRLS, and it inherits nobody
 *     else's privileges through a role membership. So does the role the
 *     owner-visible views run as, which is NOLOGIN for the same reasons.
 *  6. The owner holds SELECT on exactly three views — the two finalized
 *     Ledger views and the seats status view — and NO privilege of any
 *     kind, table-wide or column-level, on any other relation in any
 *     schema but its own, SEQUENCES INCLUDED. NO EXCEPTION (ticket #165;
 *     the decision on #157, 2026-09-03): the one #130 wrote here — SELECT
 *     and INSERT on `public.audit_chain` — is revoked, and both are now
 *     planted violations. A sequence is swept because `last_value` is an
 *     exact running count of the table it numbers, so `audit_chain_id_seq`
 *     is the rep-activity signal with the table taken away. ADR-0002: "the
 *     owner DB user is granted named views with pinned column lists only",
 *     with no footnote.
 *  7. The owner may EXECUTE exactly one function outside its own schema,
 *     `ledger.resolve_entity`, and no `ledger` function is executable by
 *     PUBLIC — PostgreSQL's default, which made "exactly one" unclaimable
 *     until …100050 revoked it.
 *  8. Every relation in the `owner` schema — and the schema itself — is
 *     owned by `dito_owner_state`, a NOLOGIN role, and `dito_owner` owns
 *     NOTHING there: it holds USAGE on the schema and SELECT and INSERT on
 *     the four tables, and nothing else. A table's owner can `ALTER TABLE
 *     … DISABLE ROW LEVEL SECURITY`, and FORCE does not reach that — so
 *     while the login owned its own tables it was one statement away from
 *     unbinding the policies that exist to bind it (Diego's ruling on #130,
 *     2026-09-02). Row-level security is ENABLED and FORCED there and on
 *     every `ledger` table and both registries, enumerated from the catalog
 *     rather than from a hand list.
 *  9. The owner-visible column lists are pinned HERE, in code, and diffed
 *     against the catalog in both directions: a column the owner can see
 *     that nobody pinned, and a pinned column that stopped existing, are
 *     both violations. Adding an owner-visible column is a spine change
 *     (ADR-0002); this is the diff that says so out loud.
 *
 * THE REP-WEB CLAUSE (ticket #221; spec #214 decision 5 and *Roles and
 * grants*; ADR-0006, ADR-0010). rep-web is the second process to
 * authenticate as an application role, and it is the one the wall's custody
 * rule is sharpest about: it holds no key, so everything sealed or
 * bundle-resident reaches it through the twin runtime's local API rather than
 * through a store. So one more claim:
 *
 * 10. `dito_rep_web` holds exactly `REP_WEB_REACH` — the rail's status rows,
 *     the seat registry under its company's policy, its own two login stores,
 *     link day's invitation and acknowledgment stores (ticket #223), notify's
 *     content-free send record, INSERT on `taps` and `send_commands`
 *     (ADR-0006's second minter), the send lock's two config reads and the
 *     attempt instants its pacing measures, and INSERT on `send_refusals`
 *     because it holds no chain key — plus the plaintext columns of `drafts`,
 *     `taps`, `send_commands`, `draft_dismissals` and `draft_blanks` a card's
 *     state and the send lock need, of
 *     the chat directory the scoping page reads (ticket #222), of the
 *     allowlist the fill card joins on and of the two seat columns link day
 *     writes (ticket #223), and NOTHING on any sealed column, key table,
 *     Ledger object or `owner` relation. Diffed in both directions, sequences
 *     swept to zero, its one `ledger` function pinned, and every relation it
 *     can reach owing the same company policy the owner's views owe.
 */
import pg from "pg";

export interface GrantViolation {
  /** What the violation hangs off: "role:<name>", "table:<qualified>" or "view:<qualified>". */
  readonly subject: string;
  readonly reason: string;
}

export interface LedgerGrantsReport {
  readonly ledgerTables: readonly string[];
  readonly ledgerViews: readonly string[];
  /**
   * The owner-visible views this run pinned, qualified. Reported so a
   * caller can refuse a vacuous pass the way `--require-corpus` does.
   */
  readonly ownerViews: readonly string[];
  /** The roles this run actually audited, in the order it audited them. */
  readonly auditedRoles: readonly string[];
  readonly violations: readonly GrantViolation[];
}

/** The sole Ledger writer (ADR-0003). */
export const APERTURE_ROLE = "dito_aperture";
/** Everything twin-side that is not the aperture. */
export const TWIN_RUNTIME_ROLE = "dito_twin_runtime";
/**
 * The owner app's role — the first application role anything in this repo
 * connects as (spec #126 decision 3).
 */
export const OWNER_ROLE = "dito_owner";
/**
 * The role the owner-visible views RUN as (…100020). PostgreSQL checks a
 * definer view's base relations, and applies their row-level policies, as
 * the view's owner — so this is the principal the company policy binds, and
 * the reason `dito_owner` needs no privilege on a table to read a view over
 * one.
 */
export const LEDGER_VIEWS_ROLE = "dito_ledger_views";
/**
 * The per-connection setting the company policy reads (…100040). Exported
 * so the owner app, its tools and its tests all name it from one place
 * rather than three string literals that can drift apart.
 */
export const OWNER_COMPANY_SETTING = "dito.company_id";
/**
 * The role that OWNS the owner's own state, which is not the role that uses
 * it (Diego's ruling on #130, 2026-09-02).
 *
 * `dito_ledger_views`' shape, one schema over and for the same reason. A
 * table's owner may `ALTER TABLE … DISABLE ROW LEVEL SECURITY`, and FORCE
 * makes an owner SUBJECT to its policies rather than unable to remove them
 * — so a login that owns the tables its own policies bind can unbind them.
 * This role owns them and is NOLOGIN, so the DDL rights that come with
 * ownership are reachable by nobody who connects.
 */
export const OWNER_STATE_ROLE = "dito_owner_state";

/** The owner app's own schema — execution records, questions, answers. */
export const OWNER_SCHEMA = "owner";

/** Exactly what `dito_owner` may do to its own state: append it, and read it. */
export const OWNER_STATE_PRIVILEGES = ["INSERT", "SELECT"] as const;
/**
 * ...and the four relations it may hold (ticket #130; `audit_chain` since
 * #165).
 *
 * PINNED IN CODE, for the reason `OWNER_VISIBLE_COLUMNS` is: a list derived
 * from the thing it is checking cannot catch a change to it. "A table owned
 * by `dito_owner`" was the whole of claim 8 until this, so a later
 * migration's `owner.seam_dump` — carrying a JID or a twin id, and
 * owner-readable through this schema's default privileges rather than
 * through any grant — would have kept FR-71a green.
 *
 * `audit_chain` IS ENUMERATED HERE RATHER THAN NAMED AS A SECOND EXCEPTION
 * (ticket #165). It is the owner side's own chain — one per company, under
 * the owner's own key — so everything this file already claims about the
 * owner's own state is exactly what it needs: the state role owns it, RLS is
 * forced on it, its columns are pinned, its policies are the pinned company
 * predicate, and `dito_owner` holds SELECT and INSERT on it and nothing else.
 * That is the whole difference #157 made: the owner's chain is state, not a
 * hole in the wall.
 */
export const OWNER_RELATIONS = [
  "answers",
  "audit_chain",
  "executions",
  "questions",
] as const;

/**
 * ...and the exact columns each of them holds (ticket #130, Codex r2).
 *
 * THE SAME CLAIM `OWNER_VISIBLE_COLUMNS` MAKES, one schema over. Pinning
 * the RELATION names stopped `owner.seam_dump`; it did nothing about a
 * `chat_jid` or a `twin_id` added to `owner.answers` by a convenient
 * migration, which the owner login would see the moment it existed, through
 * ownership and with no grant anybody wrote. Diffed in both directions: a
 * column nobody pinned, and a pinned column that vanished.
 */
export const OWNER_TABLE_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  questions: ["id", "company_id", "asked_at", "text"],
  // The owner side's own chain (ticket #165): `public.audit_chain`'s columns
  // plus the tenant, and nothing else. ADR-0020 entries are content-free, so
  // the pin is what stops a `twin_id` or a `chat_jid` being added to the one
  // owner table whose whole point is that it holds no content.
  audit_chain: [
    "id",
    "company_id",
    "caller",
    "action",
    "ref",
    "outcome",
    "prev_hash",
    "entry_hash",
    "created_at",
  ],
  executions: [
    "id",
    "owner_question_id",
    "company_id",
    "trigger_kind",
    "instructions_digest",
    "tool_names",
    "started_at",
    "ended_at",
    "iterations",
    "tokens_input",
    "tokens_output",
    "disposition",
    // Ticket #178: which of the runtime's two lanes ran it (spec #171
    // decision 3). Content-free — one of two words — and pinned here for the
    // reason everything in this table is pinned: the owner login sees every
    // column of its own state through ownership, with no grant anybody wrote,
    // so a column nobody wrote down is a column nobody reviewed.
    "lane",
  ],
  answers: [
    "id",
    "execution_id",
    "owner_question_id",
    "company_id",
    "kind",
    "prose",
    "follow_up",
    "refs",
  ],
};

/**
 * EXACTLY WHAT THE OWNER MAY SEE, column by column (ADR-0002: "named views
 * with pinned column lists only"; spec #126 decision 14).
 *
 * Pinned in code rather than read off the catalog, because a list derived
 * from the thing it is checking cannot catch a change to it. The diff runs
 * in both directions — an unpinned column the owner can see, and a pinned
 * column that vanished — for the same reason `LEDGER_ANNOTATION_COLUMNS`
 * does: probing only the names we expect can never catch a column nobody
 * wrote down.
 *
 * `ledger.finalized_facts` carries `filed_by_seat_id` and NOT
 * `filed_by_twin_id` — the seat crosses, the twin does not (ADR-0004 as
 * amended 2026-09-02) — and neither `shadow` nor `retracted_at`, which are
 * the view's own predicates and not the owner's business.
 */
export const OWNER_VISIBLE_COLUMNS: Readonly<
  Record<string, readonly string[]>
> = {
  "ledger.finalized_entities": [
    "company_id",
    "entity_id",
    "kind",
    "display_name",
    "created_at",
  ],
  "ledger.finalized_facts": [
    "id",
    "company_id",
    "entity_id",
    "fact_type",
    "payload_version",
    "payload",
    "occurred_at",
    "confidence",
    "source_type",
    "filed_at",
    "finalized_at",
    "filed_by_seat_id",
  ],
  "public.seats_status": ["seat_id", "display_name", "state"],
};

/**
 * The `ledger` functions the owner may call, and their argument types as
 * PostgreSQL renders them.
 *
 * `resolve_entity_for_declared_company` is the ticket's resolution function
 * with its company parameter taken away: the timeline read follows standing
 * merge edges to the resolved entity (ADR-0035, spec #126 decision 15), and
 * the owner gets that from the same walk every other reader uses — but it
 * may not name WHICH company to walk, because a read's parameters narrow
 * rows and never the company (spec #126 decision 6). `resolve_entity`
 * itself stays rep-side and ungranted.
 *
 * `declared_company` is the one PostgreSQL requires: a policy expression's
 * function privileges are checked against the SESSION's user even when the
 * relation is reached through a definer view, so without it an owner
 * connection fails on the policy rather than reading its own rows. It is
 * safe by construction — it reads a setting the caller itself set and
 * touches no table, so calling it tells the caller only what the caller
 * already said.
 */
export const OWNER_EXECUTABLE_FUNCTIONS = [
  "ledger.resolve_entity_for_declared_company(uuid)",
  // ...and its other half (#129, …100060). The resolver answers "which
  // record is this one now"; this one answers "whose facts read forward
  // under it", which is the question `finalized_facts` cannot be asked
  // because facts never move (ADR-0035). It returns entity ids only — no
  // edge, no status, no direction — so the owner gets a merged cliente as
  // one timeline without being handed the merge graph.
  "ledger.resolved_members_for_declared_company(uuid)",
  "ledger.declared_company()",
] as const;

/**
 * THE REP SIDE'S CHAIN, WHICH THE OWNER HOLDS NOTHING ON — ticket #165, the
 * decision on #157 (2026-09-03).
 *
 * THE EXCEPTION THAT WAS HERE IS GONE, and this paragraph is the record so
 * the question is not reopened from the wrong end. #130's ruling of
 * 2026-09-02 gave `dito_owner` SELECT and INSERT on this table, on ADR-0020's
 * own sentence — there is ONE chain, and every execution owes it one
 * content-free entry — having weighed what a compromised owner web could
 * WRITE. It did not weigh what the grant lets it READ, and that is what #157
 * found: **the shared chain is a same-company REP-ACTIVITY RECORD.** Its
 * entries carry `twin:<id>` — the one identifier ADR-0004 as amended says
 * never crosses, and which the seats view withholds even inside the owner's
 * own company — beside every `customer_send` with its outcome and its
 * timestamp, every refusal and every `question_answer`. Per-rep send volume,
 * send timing and refusal counts are exactly the usage signal ADR-0025
 * forbids deriving owner-side, and one SELECT reads all of it, on a
 * one-company deployment and not only at fleet scale.
 *
 * SO THE OWNER SIDE MAY READ ONLY WHAT IT WROTE, and it appends to
 * `owner.audit_chain` — its own, one per company by forced row-level
 * security, under `DITO_OWNER_AUDIT_HMAC_KEY`. ADR-0020 is amended to say so;
 * `audit-verify` verifies every chain it finds under the key for its side and
 * exits with one verdict; the chains record disjoint acts and no G16 claim
 * orders an owner act against a rep act, so nothing is lost to the split.
 * `dito_owner` is back to zero `public` tables, which is spec #126's AC 2 as
 * written before the erratum.
 *
 * REJECTED, and recorded so it is not reopened (#157's own list): row-level
 * security on THIS table by company — the owner would still read its own
 * company's send log, which is the exposure; definer functions over this
 * table with a content-free key attestation — one global advisory lock
 * serialising every company's owner with every rep-side appender, a
 * chain-schema change on every rep-side writer's path, and a side channel,
 * since the tail hash changes on any rep's act anywhere and polling it reads
 * fleet-wide activity timing; accepting the exposure — the grant audit would
 * say green over a rep-activity read; and an in-database HMAC, which #130
 * rejected and #157 did not revive, because the key would live in Postgres
 * and ADR-0020's custody is fail-closed in the environment.
 *
 * PINNED IN CODE, ONE NAME, because the arm below has to name the table to
 * give the violation this sentence rather than the generic one every other
 * `public` table gets.
 */
const SHARED_CHAIN_TABLE = "public.audit_chain";

/**
 * The registries (…100010) — `public` tables that are not the Ledger's and
 * still carry a company on every row, so RLS covers them too (ADR-0002:
 * "every shared table carries company_id under Postgres RLS").
 */
export const REGISTRY_TABLES = ["public.companies", "public.seats"] as const;

/**
 * THE REP DASHBOARD'S ROLE — the second application role anything in this
 * repo connects as (ticket #221; spec #214 decision 5 and *Roles and
 * grants*; ADR-0002, ADR-0006, ADR-0010).
 */
export const REP_WEB_ROLE = "dito_rep_web";

/**
 * EXACTLY WHAT rep-web MAY HOLD, relation by relation and privilege by
 * privilege (claim 10).
 *
 * PINNED IN CODE AND DIFFED IN BOTH DIRECTIONS, for `OWNER_VISIBLE_COLUMNS`'
 * reason: a list derived from the thing it is checking cannot catch a change
 * to it. A privilege the catalog holds that nobody pinned is a violation, and
 * a pinned privilege the migration forgot is a violation too — so
 * …20260907100040's grant block and this constant are one statement written
 * twice, and neither can move alone.
 *
 * WHY EACH ENTRY IS HERE, in spec #214's own order:
 *
 *   `seats` — the registry, under its company's row-level policy. SELECT
 *   table-wide, and UPDATE on exactly two columns below (ticket #223): the
 *   address the rep types when their invitation was forwarded, and the stamp
 *   link day's last step writes. `state` is NOT among them — the lease holder
 *   moves a seat to `linked` from the rail's own row, so no page can claim a
 *   number was linked that never was.
 *
 *   `invitations` — SELECT and UPDATE, and deliberately no INSERT (ticket
 *   #223). rep-web CONSUMES an invitation: it finds the row by digest and
 *   stamps `used_at` and the session that opening created. Issuing one is a
 *   decision an operator makes about a seat, and a login surface that could
 *   mint one could invite itself.
 *
 *   `acknowledgments` — SELECT and INSERT and nothing else (ticket #223). It
 *   appends one row per document version the rep accepts and reads them back
 *   to decide which onboarding step is next; UPDATE and DELETE are withheld
 *   here AND refused by a trigger, because a consent record a login can
 *   rewrite is not a consent record.
 *
 *   `sessions`, `login_codes` — rep-web's OWN two stores. SELECT, INSERT and
 *   UPDATE, and no DELETE: a code is consumed and its guesses counted, a
 *   session's last-seen moves and «Cerrar sesiones» writes `ended_at`, and a
 *   login that can erase its own record is a login whose record proves
 *   nothing.
 *
 *   `notify_sends` — the content-free row notify writes on rep-web's own
 *   pool before the login code leaves and settles after (…20260907100020,
 *   which granted nobody anything and said this grant was #221's).
 *
 *   `push_subscriptions` — a browser's registration to receive the twin's
 *   knocks, written and removed by the permission flow and ended with its
 *   login (#262). SELECT, INSERT and DELETE table-wide, and UPDATE on
 *   `ended_at` alone below: «Cerrar sesiones» stops every device knocking and
 *   a browser may replace its own stale address, but there is no privilege
 *   through which an endpoint or a key could be rewritten in place — a row is
 *   the registration a browser handed over, whole or not at all.
 *
 *   `seen_marks` — what this seat has been shown (#262). SELECT and INSERT and
 *   nothing else: a mark is appended when Inicio renders a post and read back
 *   when a card asks whether to retire, and there is no verb that un-sees a
 *   thing — the line `acknowledgments` is held to, for the same reason.
 *
 *   `taps`, `send_commands` — ADR-0006's second minter (#221 granted the
 *   INSERTs one ticket before their caller; #224 built it). INSERT
 *   table-wide, because a minter writes every column of both; SELECT column
 *   by column below, because the writer READS far less than it writes.
 *
 *   `send_allowlist`, `pacing_thresholds` — the send-lock writer's two config
 *   reads (ADR-0017; ticket #224). Table-wide, and `destination_jid` is the
 *   half worth arguing: it is a customer's chat address, and the writer cannot
 *   ask «is this destination allowed» without reading the column it compares.
 *
 *   THE PRINCIPLE THIS LIST FOLLOWS IS «GRANT EXACTLY WHAT IS READ», not
 *   «never a destination» — which is why `send_commands.destination` is
 *   withheld below (written, never read) while this one is granted. What the
 *   grant COSTS is the same exposure `drafts` already carries and #221 argued
 *   in as many words: neither table has a company or row-level security, so
 *   what bounds this role's twin-scoped reads is that the only twin id it can
 *   learn comes off a seat its company policy let it read. Rep-side RLS on
 *   the seam's config tables is the debt #221 recorded and #224 leaves where
 *   it found it — on the horizon, #117.
 *
 *   `send_attempts` — two columns, a command id and the instant the rail was
 *   actually touched, and the writer reads both: the pacing window measures
 *   the WIRE moment rather than the mint moment. Table-wide for the reason
 *   above.
 *
 *   `send_refusals` — INSERT and nothing else, not even SELECT. rep-web holds
 *   no chain key (ADR-0002, ADR-0008), so a refusal it makes is recorded as a
 *   row the lease holder chains at its next wake; the dashboard never reads
 *   one back, and a role that could would be able to count another twin's
 *   refusals.
 *
 * WHAT IS ABSENT IS THE POINT. No `posts`, no `notices`, no
 * `disclosure_lines`, no `wa_events`: the feed reaches rep-web through the
 * runtime's local API, because the lease holder is the only process that may
 * unseal (ADR-0010). No `twin_keys`, no `audit_chain`, no `companies`, and
 * nothing at all in `ledger`.
 */
export const REP_WEB_REACH: Readonly<Record<string, readonly string[]>> = {
  "public.seats": ["SELECT"],
  "public.sessions": ["SELECT", "INSERT", "UPDATE"],
  "public.login_codes": ["SELECT", "INSERT", "UPDATE"],
  "public.push_subscriptions": ["SELECT", "INSERT", "DELETE"],
  "public.seen_marks": ["SELECT", "INSERT"],
  "public.invitations": ["SELECT", "UPDATE"],
  "public.acknowledgments": ["SELECT", "INSERT"],
  "public.notify_sends": ["SELECT", "INSERT", "UPDATE"],
  "public.taps": ["INSERT"],
  "public.send_commands": ["INSERT"],
  "public.send_allowlist": ["SELECT"],
  "public.pacing_thresholds": ["SELECT"],
  "public.send_attempts": ["SELECT"],
  "public.send_refusals": ["INSERT"],
};

/**
 * ...and the one relation rep-web reaches COLUMN BY COLUMN, because the
 * columns it may not reach are the sealed ones (spec #214 *Roles and
 * grants*: "drafts' plaintext columns needed for the card's state").
 *
 * `drafts` HAS TWO SEALED COLUMNS AND rep-web MAY HAVE NEITHER.
 * `content_enc` is the body a tap releases, which the runtime opens and
 * serves through the local API; `post_enc` is the frozen bytes the rep read
 * in their thread (ADR-0034). A table-wide SELECT would hand over both, and
 * `has_table_privilege` cannot express "everything but two" — so the grant is
 * column-level and this is the list, diffed against the catalog in both
 * directions. A later `GRANT SELECT (content_enc) ON drafts TO dito_rep_web`
 * is then a violation with a name rather than a privilege nobody notices,
 * which is `LEDGER_ANNOTATION_COLUMNS`' argument on the other side of the
 * wall.
 *
 * `rail_status_events` HAS ONE COLUMN THAT IS NOT METADATA, and it is the
 * sharper of the two entries. The table is plane status by design and never
 * rep content — but on a `qr` row `detail` carries the raw pairing code the
 * plane generated, which is a LIVE CREDENTIAL for linking a WhatsApp account.
 * The table carries no company and no row-level security, so a table-wide
 * SELECT would hand one login role every twin in the fleet's pairing tokens
 * and a link-hijack would need nothing else. Nothing in 6a renders one, so
 * `detail` is unreachable outright and `id` is here because it is the emission
 * order every consumer reads by (…20260827100007). Ticket #222 adds a SECOND
 * status whose `detail` is a credential — `pairing_code`, the eight characters
 * a rep types into WhatsApp — so the withholding gains a second reason and
 * the list does not move.
 *
 * `chat_directory` HAS ONE SEALED COLUMN AND rep-web MAY NOT HAVE IT (ticket
 * #222; spec #214 *Roles and grants*: "SELECT on … the chat directory's
 * plaintext columns"). `name_enc` is what the rep's own phone calls a person,
 * under the twin DEK — and rep-web holds no key at all (ADR-0008's custody of
 * two), so a table-wide SELECT would hand it ciphertext it can never open
 * AND make this pin unable to say so. Names reach the scoping page OPENED,
 * through the runtime's local API (ADR-0010). What is in the list is what the
 * page renders: the row's identity, its twin, the chat the switch names, its
 * kind, when it was last active, the four fill-progress columns, and the
 * FILL'S OWN END — the marker's two halves and the resumed fact, which
 * ticket #245 adds because the card renders its four states from them and
 * inferring the end from how long ago a page landed is what left the card
 * running for ever on the rig (boundary #225, F17). What is out beside the
 * name is the LID (a second spelling of an identity no page shows), the three
 * anchor columns (the fill's own input) and the two stamps.
 *
 * THE SEND LOCK'S THREE ARE #224's, and each withholds something (spec #214
 * *Roles and grants*; ADR-0006).
 *
 * `taps` — `id` because `INSERT … RETURNING id` needs SELECT on the column it
 * returns, and `draft_id` because the card's state is rep-web's own plaintext
 * read (#220's remainder 8): a draft with a tap draws the send's progress
 * rather than two buttons. `minter` and `source_event_id` are withheld — the
 * dashboard WRITES the first and has no use for the second, and a role that
 * could read `source_event_id` could tell which seam message released a draft.
 *
 * `send_commands` — the writer reads `twin_id`, `send_class` and `created_at`
 * for pacing, `outcome` for the in-flight check and for the card's own
 * «enviando / enviado / no salió», `draft_id` to find a card's command, and
 * `id` for `RETURNING`. `destination` and `payload_ref` are WRITTEN and never
 * read, so both are withheld: a destination is chat identity (ADR-0004) and a
 * `payload_ref` is the plane executor's contract rather than a page's.
 *
 * `draft_dismissals` — `draft_id` and nothing else. Both readers ask the same
 * question, "did somebody dismiss this draft", and `source_event_id` answers a
 * different one: WHICH message of the rep's dismissed it. The dashboard has no
 * business with that, and withholding it is the difference between a state and
 * a history.
 *
 * `draft_blanks` — `draft_id` and nothing else, for the same reason (ticket
 * #342): the lock asks "does this draft still carry a blank", and which blank
 * it is answers nothing a send needs.
 *
 * `seats` IS ONE OF TWO ENTRIES HERE THAT ARE ALSO PINNED WHOLE-RELATION
 * ABOVE, and the two lines are about two privileges (ticket #223). SELECT is
 * table-wide — every column of a seat is account metadata rep-web already
 * renders or scopes by — and UPDATE is exactly two columns, because rep-web
 * writes the ADDRESS and the ONBOARDING STAMP and nothing else. `state` is the
 * column this split exists for: a dashboard that could write `linked` could
 * claim a number was linked that never was, so the move is the lease holder's.
 *
 * `push_subscriptions` IS THE OTHER, and its split is sharper (ticket #262).
 * SELECT, INSERT and DELETE are table-wide because a browser's registration
 * arrives and leaves whole; UPDATE is `ended_at` ALONE, so there is no
 * privilege through which an endpoint or a key could be rewritten under a row
 * that already exists. A registration is what a browser handed over, and the
 * only thing a dashboard may change about one is that it has stopped.
 *
 * `scope_allowlist` IS THREE COLUMNS BECAUSE THE FILL CARD JOINS ON THEM
 * (ticket #223; ticket #224 built the card; ticket #245 added the third).
 * Inicio names the date the fill has reached across the chats the rep scoped,
 * and it must render with the runtime stopped (spec #214 story 8) — so the
 * halves are `chat_directory`'s plaintext fill columns and this membership.
 * The twin is what the read is scoped by and the chat is what it joins on.
 *
 * `created_at` IS WHAT TELLS A STALE MARKER FROM A LIVE ONE. The plane clears
 * the fill's marker when a fill STARTS and it serves requests one at a time,
 * so a rep who re-scopes a chat while another chat's fill is running has a row
 * still carrying last month's stop for as long as the queue takes. Read
 * against the scoping's own instant that marker is visibly older than the ask
 * it would answer, and the card says «Trayendo tu historial» from the moment
 * the rep pressed the switch. What renders is the COMPARISON and never the
 * instant, and the writer is still the runtime's scope act, never a page.
 */
export const REP_WEB_COLUMN_REACH: Readonly<
  Record<string, Readonly<Record<string, readonly string[]>>>
> = {
  "public.drafts": {
    SELECT: ["id", "twin_id", "destination", "created_at"],
  },
  "public.seats": {
    UPDATE: ["email", "onboarded_at"],
  },
  "public.push_subscriptions": {
    UPDATE: ["ended_at"],
  },
  "public.scope_allowlist": {
    SELECT: ["twin_id", "chat_jid", "created_at"],
  },
  "public.rail_status_events": {
    SELECT: ["id", "twin_id", "status", "occurred_at"],
  },
  "public.chat_directory": {
    SELECT: [
      "id",
      "twin_id",
      "chat_jid",
      "kind",
      "last_activity_at",
      "fill_pages",
      "fill_oldest_at",
      "fill_end_of_transfer",
      "fill_last_at",
      "fill_stopped_at",
      "fill_stopped_by",
      "fill_resumed",
    ],
  },
  "public.taps": {
    SELECT: ["id", "draft_id"],
  },
  "public.send_commands": {
    SELECT: ["id", "twin_id", "send_class", "draft_id", "outcome", "created_at"],
  },
  "public.draft_dismissals": {
    SELECT: ["draft_id"],
  },
  "public.draft_blanks": {
    SELECT: ["draft_id"],
  },
};

/**
 * Every relation rep-web can read whose read must be scoped to one company,
 * and which command its policy covers.
 *
 * `'r'` IS SELECT AND `'*'` IS ALL, and the difference is what each relation
 * is: rep-web reads the seat registry and reads AND WRITES its own two
 * stores. A SELECT-only policy on a store rep-web inserts into would leave
 * the INSERT with no `WITH CHECK`, and PostgreSQL refuses an INSERT no policy
 * permits — so a login would fail on a policy rather than on anything about
 * the login.
 *
 * `rail_status_events`, `drafts`, `taps` and `send_commands` are NOT here,
 * and that is the state rather than an oversight: they carry a twin and no
 * company, they have never been under row-level security, and enabling it on
 * a seam table would start filtering the twin runtime's own reads — silently,
 * since a policy denial is an empty result rather than an error.
 * …20260902100040 records rep-side RLS as out of scope for exactly this
 * reason, and #221 leaves that debt where it found it: what bounds rep-web's
 * twin-scoped reads is that the only twin id it can learn comes off a seat
 * its company policy let it read. Recorded on #221.
 */
export const REP_WEB_COMPANY_POLICIES: Readonly<Record<string, "r" | "*">> = {
  // `'*'` AND NOT `'r'`, WHICH IS A MECHANICAL NECESSITY AND NOT A WIDENING:
  // rep-web writes two of a seat's columns, so a `FOR SELECT` policy would
  // leave the UPDATE with no `WITH CHECK` and PostgreSQL refuses a write no
  // policy permits. The column-level GRANT is what keeps it from being a
  // widening in fact — `state` stays the lease holder's.
  "public.seats": "*",
  "public.sessions": "*",
  "public.login_codes": "*",
  // Link day's two stores (ticket #223). `'*'` for the reason above: rep-web
  // consumes an invitation and appends an acknowledgment, and this audit pins
  // ONE command per relation — so two policies, one per command, would read as
  // a mismatch. What it may not do to either is withheld by the grant.
  "public.invitations": "*",
  "public.acknowledgments": "*",
};

/**
 * The one function rep-web may execute outside `public`.
 *
 * THE SAME ONE PostgreSQL FORCED ON `dito_twin_runtime` (…20260902100040): a
 * policy expression's function privileges are checked against the SESSION's
 * role, so a connection without this fails on `permission denied for
 * function declared_company` rather than reading its own company's rows. It
 * is safe by construction — it reads a setting the caller itself set and
 * touches no table, so calling it tells the caller only what the caller
 * already said — and it is why rep-web holds USAGE on `ledger` at all. USAGE
 * lets a role NAME an object in a schema and grants no privilege on any
 * object in it, which is what makes "nothing on any Ledger relation"
 * checkable rather than rhetorical.
 */
export const REP_WEB_EXECUTABLE_FUNCTIONS = [
  "ledger.declared_company()",
] as const;

/**
 * THE BUILT-INS WHOSE CONTENTS DEFEAT OTHER OBJECTS' PRIVILEGES, which
 * `dito_rep_web` must not reach by ANY route (claim 10; Codex r2).
 *
 * A file reader does not read a table, so no table privilege stops it: it
 * reads the BYTES under `twin_keys` and under every `ledger` table straight
 * off the data directory. PostgreSQL ships every one of them restricted from
 * PUBLIC, which is what makes them the exception to the rule beside them —
 * a grant of one to PUBLIC would make "no built-in PUBLIC cannot" true and
 * useless at the same moment.
 *
 * A ROSTER, AND IT WILL GO STALE. The release that adds the next file reader
 * will not add it here; what still covers that one is rule A, which catches
 * any grant NAMING this role whatever the object. Recorded on #221.
 */
export const REP_WEB_FORBIDDEN_BUILTINS: readonly string[] = [
  "pg_read_file",
  "pg_read_binary_file",
  "pg_ls_dir",
  "pg_stat_file",
  "lo_import",
  "lo_export",
];

/**
 * ...and the system catalogs whose ROWS are other tables' contents.
 *
 * `pg_statistic` holds sampled VALUES from every analyzed column — the
 * counterparty names in `disclosure_lines`, a rep's address on `seats` — so
 * reading it reads a sample of the columns this role may not read, which is
 * exactly why PostgreSQL ships it restricted while its `pg_stats` view is
 * filtered to the reader's own tables. `pg_statistic_ext_data` is the same
 * for extended statistics, and `pg_authid` holds every role's password
 * verifier.
 */
export const REP_WEB_FORBIDDEN_CATALOGS: readonly string[] = [
  "pg_statistic",
  "pg_statistic_ext_data",
  "pg_authid",
];

/**
 * THE OWNER-VISIBLE VIEWS' OWN DEFINITIONS, normalized and pinned.
 *
 * The column list above pins what the owner can see BY NAME, and a name is
 * not a source: a view keeping the exact catalog shape while returning
 * `f.filed_by_twin_id` under `filed_by_seat_id` passes every other check in
 * this file, and so does one whose `shadow` predicate decides a rendered
 * value instead of gating a row. `filtersShadow` narrows the second case
 * and cannot close either completely — the honest answer for a set of
 * exactly three views is to pin the whole definition, so that any change to
 * one is a line in this file, reviewed beside the migration that makes it.
 *
 * Normalized: whitespace collapsed, trailing semicolon dropped, and a
 * `public.` qualifier removed wherever PostgreSQL's deparse adds one, since
 * that depends on the auditing connection's `search_path` rather than on
 * the view. Everything else is compared exactly.
 */
export const OWNER_VIEW_DEFINITIONS: Readonly<Record<string, string>> = {
  "ledger.finalized_entities":
    "SELECT company_id, entity_id, kind, display_name, created_at " +
    "FROM ledger.entities WHERE shadow = false",
  "ledger.finalized_facts":
    "SELECT f.id, f.company_id, f.entity_id, f.fact_type, f.payload_version, " +
    "f.payload, f.occurred_at, f.confidence, f.source_type, f.filed_at, " +
    "f.finalized_at, s.id AS filed_by_seat_id FROM ledger.facts f " +
    "LEFT JOIN seats s ON s.company_id = f.company_id AND s.twin_id = f.filed_by_twin_id " +
    "WHERE f.shadow = false AND f.finalized_at IS NOT NULL AND f.retracted_at IS NULL",
  "public.seats_status":
    "SELECT id AS seat_id, rep_display_name AS display_name, state FROM seats s",
};

/**
 * The body of the function every company policy calls, pinned for the same
 * reason the policies' own text is: a policy names a function, and naming
 * one is a promise about rows only while that function still reads the
 * connection's own setting and nothing else.
 */
export const DECLARED_COMPANY_BODY =
  "SELECT NULLIF(current_setting('dito.company_id', true), '')::uuid";

/**
 * ...and the bodies of the two functions the owner may call over tables it
 * holds nothing on. `CREATE OR REPLACE FUNCTION` keeps a signature, an ACL
 * and a `SECURITY DEFINER` marking while replacing everything that
 * matters, so the signature is not the promise — the body is.
 *
 * A MAP RATHER THAN A CONSTANT PER FUNCTION (#129), keyed by the same
 * qualified signature `OWNER_EXECUTABLE_FUNCTIONS` uses. The second definer
 * function arrived with the owner's merge-resolved timeline, and one pinned
 * body beside one hand-written audit is exactly the shape in which the
 * third one gets granted with nothing pinning it.
 */
export const OWNER_DEFINER_FUNCTION_BODIES: Readonly<Record<string, string>> = {
  "ledger.resolve_entity_for_declared_company(uuid)": `DECLARE
    company uuid := ledger.declared_company();
BEGIN
    IF company IS NULL THEN
        RAISE EXCEPTION
            'ledger.resolve_entity_for_declared_company refused: this connection declared no company'
            USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN ledger.resolve_entity(company, p_entity_id);
END;`,
  "ledger.resolved_members_for_declared_company(uuid)": `DECLARE
    company uuid := ledger.declared_company();
BEGIN
    IF company IS NULL THEN
        RAISE EXCEPTION
            'ledger.resolved_members_for_declared_company refused: this connection declared no company'
            USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN QUERY
    WITH RECURSIVE members (entity_id) AS (
        SELECT ledger.resolve_entity(company, p_entity_id)
      UNION
        SELECT e.loser_entity_id
          FROM ledger.active_entity_merges(company) e
          JOIN members m ON m.entity_id = e.winner_entity_id
         WHERE e.status = 'merged'
    )
    SELECT entity_id FROM members;
END;`,
};

/**
 * EVERY PRINCIPAL THAT MAY HOLD ANYTHING ON AN OWNER-VISIBLE OBJECT, and
 * exactly what.
 *
 * The reach check asks what `dito_owner` can read; it says nothing about
 * who ELSE was handed the same view. A login granted SELECT on
 * `ledger.finalized_facts` and EXECUTE on `declared_company()` reads any
 * tenant it names through the same definer view, and every other claim in
 * this file stays true. So the owner-visible objects are pinned by their
 * whole grantee list, not only by one grantee's reach.
 *
 * The relation's own OWNER is not listed: PostgreSQL always grants it
 * everything, and `LEDGER_VIEWS_ROLE` being that owner is its own claim.
 */
const OWNER_OBJECT_GRANTEES: Readonly<Record<string, readonly string[]>> = {
  // …100012's twin-side reader keeps the SELECT it has held since the views
  // were born; the aperture's was revoked by …100030, which is why it is
  // not here.
  "ledger.finalized_entities": [OWNER_ROLE, TWIN_RUNTIME_ROLE],
  "ledger.finalized_facts": [OWNER_ROLE, TWIN_RUNTIME_ROLE],
  "public.seats_status": [OWNER_ROLE],
  // ...AND rep-web, the fourth grantee and the one that needs an argument
  // rather than a citation (#221). PostgreSQL checks a policy
  // expression's function privileges against the SESSION's role, so any role
  // a company policy binds must be able to call this — that is why
  // `dito_twin_runtime` is here too. What makes it safe for a LOGIN to hold
  // is the pair it is held WITH: this function reads a setting the caller
  // itself set and touches no table, so on its own it tells a caller only
  // what the caller already said, and rep-web holds nothing on any Ledger
  // view or table for the declaration to unlock (claim 10).
  "ledger.declared_company()": [
    OWNER_ROLE,
    TWIN_RUNTIME_ROLE,
    LEDGER_VIEWS_ROLE,
    REP_WEB_ROLE,
  ],
  "ledger.resolve_entity_for_declared_company(uuid)": [OWNER_ROLE],
  "ledger.resolved_members_for_declared_company(uuid)": [OWNER_ROLE],
};

/** Whitespace collapsed, trailing semicolon gone, `public.` unqualified. */
function normalizeSql(sql: string): string {
  return sql
    .replace(/\s+/g, " ")
    .replace(/\bpublic\./g, "")
    .replace(/;\s*$/, "")
    .trim();
}

/**
 * THE POLICY, pinned as text, exactly as PostgreSQL renders it back
 * (…100040).
 *
 * `relrowsecurity` and `relforcerowsecurity` say the switch is on; they say
 * nothing about what the rule is. A `USING (true)` policy for the role the
 * owner's views run as would leave both flags true, every grant unchanged,
 * and every company readable by every owner — so the rule is diffed too.
 * It is one short expression only because …100040 put the setting behind
 * `ledger.declared_company()` instead of repeating it.
 *
 * QUALIFIED, AND ONLY QUALIFIED. An earlier draft also accepted the bare
 * `declared_company()` that a connection with `ledger` on its `search_path`
 * deparses to — and that is precisely the spelling this pin must refuse,
 * because it equally matches a `public.declared_company()` that anybody can
 * be granted and that could return whatever it liked. `ledger` is on no
 * default `search_path`, so the qualified form is what every caller of this
 * audit actually sees.
 */
export const LEDGER_COMPANY_POLICY = "(company_id = ledger.declared_company())";
/**
 * The aperture's own rep-side stores, in `public` beside the seam.
 *
 * IT LOST ONE AT #218 — the question store, dropped with the route that
 * filled it (spec #214 decision 3). Nothing narrows here: the store is gone
 * from the schema, so a clause about it would ask for a privilege on a
 * relation that does not exist and report a violation nobody can fix.
 */
export const APERTURE_REP_SIDE_STORES = [
  "disclosure_lines",
  // Ticket #54: which rep act retracted which fact. `ledger.facts` says a
  // fact was retracted; it may not say by whom, because a `wa_events` id
  // dereferences to chat identity (ADR-0004) — so the evidence lives here,
  // rep-side, exactly where an entity create's does.
  "fact_retractions",
] as const;

const WRITE_PRIVILEGES = ["INSERT", "UPDATE", "DELETE", "TRUNCATE"] as const;

/**
 * The ONLY columns of a Ledger table the aperture may UPDATE, and which
 * annotation path each belongs to (ticket #54; …100012's own promise).
 *
 * Table-wide UPDATE is refused above, because a blanket UPDATE is a rename
 * without a disclosure (ADR-0003 as amended) and a rewrite of provenance in
 * an append-only store. The annotations and determinations that DO exist
 * take column-level grants instead — which `has_table_privilege` does not report, so the
 * table-wide check stays true while these stay real. This list is the other
 * half of that bargain: exactly these columns, on exactly this table, and a
 * column privilege nobody declared is a violation.
 */
const LEDGER_ANNOTATION_COLUMNS: Readonly<
  Record<string, Readonly<Record<string, string>>>
> = {
  entities: {
    // Ticket #60: the model determines person-vs-business and always
    // records its best determination, so some are wrong and a wrong one
    // changes merge eligibility. `kind` and NOTHING ELSE on this table is
    // what makes the class-1 fence a privilege: the inference can set the
    // label and can never rename the customer (ADR-0003).
    kind: "the kind determination (ticket #60, ADR-0035)",
  },
  facts: {
    // ADR-0004: the correction window closes 24h after rep-reachability.
    finalized_at: "finalization (ticket #54, ADR-0004)",
    // FR-33: a correction annotates, never erases.
    retracted_at: "retraction (ticket #54, FR-33)",
  },
};

/** Audits the Ledger's grants on the given database. */
export async function auditLedgerGrants(
  client: pg.ClientBase,
): Promise<LedgerGrantsReport> {
  const violations: GrantViolation[] = [];

  const audited = [
    APERTURE_ROLE,
    TWIN_RUNTIME_ROLE,
    OWNER_ROLE,
    LEDGER_VIEWS_ROLE,
    OWNER_STATE_ROLE,
    // The rep dashboard's own role (ticket #221; claim 10). Named here rather
    // than probed conditionally for the reason the whole list is named: a
    // catalog check passes quietly over an absent principal, so a database
    // where this role was never created has to say it audited nothing rather
    // than say the wall holds.
    REP_WEB_ROLE,
  ];
  const roles = await client.query<{ rolname: string }>(
    "SELECT rolname FROM pg_roles WHERE rolname = ANY($1::text[])",
    [audited],
  );
  const present = new Set(roles.rows.map((r) => r.rolname));
  for (const role of audited) {
    if (!present.has(role)) {
      violations.push({
        subject: `role:${role}`,
        reason:
          "role does not exist — the single-writer claim is enforced by grants, and a missing role enforces nothing",
      });
    }
  }
  // Without every role each privilege probe below is vacuous; refusing to
  // pass on nothing is the ADR-0028 doctrine.
  if (violations.length > 0) {
    return {
      ledgerTables: [],
      ledgerViews: [],
      ownerViews: [],
      auditedRoles: audited,
      violations,
    };
  }

  const tables = await client.query<{ table_name: string; has_shadow: boolean }>(
    `SELECT c.relname AS table_name,
            EXISTS (
              SELECT 1 FROM pg_attribute a
               WHERE a.attrelid = c.oid AND a.attname = 'shadow' AND a.attnum > 0
                 AND NOT a.attisdropped
            ) AS has_shadow
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'ledger' AND c.relkind = 'r'
      ORDER BY c.relname`,
  );
  const views = await client.query<{ view_name: string; definition: string }>(
    `SELECT c.relname AS view_name, pg_get_viewdef(c.oid, true) AS definition
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'ledger' AND c.relkind = 'v'
      ORDER BY c.relname`,
  );

  if (tables.rows.length === 0) {
    violations.push({
      subject: "table:ledger.*",
      reason:
        "no tables in the ledger schema — refusing to pass an audit with nothing in it (ADR-0028 doctrine)",
    });
  }

  for (const { table_name } of tables.rows) {
    const qualified = `ledger.${table_name}`;
    if (!(await hasPrivilege(client, APERTURE_ROLE, qualified, "INSERT"))) {
      violations.push({
        subject: `table:${qualified}`,
        reason: `${APERTURE_ROLE} cannot write it — the aperture is the single Ledger writer (ADR-0003)`,
      });
    }
    for (const destructive of ["DELETE", "TRUNCATE"] as const) {
      if (await hasPrivilege(client, APERTURE_ROLE, qualified, destructive)) {
        violations.push({
          subject: `table:${qualified}`,
          reason: `${APERTURE_ROLE} holds ${destructive} — the Ledger is append-only and corrections annotate, never erase (FR-33)`,
        });
      }
    }
    // Table-wide UPDATE is a rename without a disclosure, and a rewrite of
    // provenance, waiting to happen. Finalization and retraction annotate
    // rows in place and arrive with COLUMN-level grants — which
    // has_table_privilege does not report, so this stays true when they do.
    if (await hasPrivilege(client, APERTURE_ROLE, qualified, "UPDATE")) {
      violations.push({
        subject: `table:${qualified}`,
        reason: `${APERTURE_ROLE} holds table-wide UPDATE — a blanket UPDATE can rename an entity without disclosing it (ADR-0003 as amended) and rewrite provenance in an append-only store; annotation paths take column-level grants in their own migration`,
      });
    }
    for (const privilege of ["SELECT", ...WRITE_PRIVILEGES] as const) {
      if (await hasPrivilege(client, TWIN_RUNTIME_ROLE, qualified, privilege)) {
        violations.push({
          subject: `table:${qualified}`,
          reason: `${TWIN_RUNTIME_ROLE} holds ${privilege} on a Ledger table — the twin runtime holds no Ledger write, and reads through the finalized views (ADR-0016)`,
        });
      }
    }
  }

  // ...and the column privileges the annotation paths take instead, checked
  // in BOTH directions (ticket #54). A declared column the aperture cannot
  // write means finalization or retraction is broken; an undeclared column
  // it CAN write is a table-wide UPDATE arriving one column at a time,
  // which is exactly what the refusal above exists to prevent.
  violations.push(...(await auditAnnotationColumns(client)));

  // ONE writer means one: every grantee, not just the two roles this
  // audit knows the names of. Without this, a migration granting INSERT to
  // a third role would leave the single-writer claim false and the audit
  // green — which is the entire claim.
  violations.push(...(await sweepWriteGrantees(client)));

  // The shadow filter, checked where ADR-0016 says it lives.
  const covered = await viewCoverage(client);
  const shadowTables = new Set(
    tables.rows.filter((t) => t.has_shadow).map((t) => t.table_name),
  );
  for (const table_name of shadowTables) {
    const over = covered.get(table_name) ?? [];
    if (over.length === 0) {
      violations.push({
        subject: `table:ledger.${table_name}`,
        reason:
          "shadow-flagged table with no view over it — a table without its view invites a direct-table reader, which is the pipeline rebuild ADR-0016 exists to prevent",
      });
    }
  }
  // WHICH shadow-bearing tables each view reads, from the catalog: a view
  // that reads two must filter both, and it must filter each one where the
  // definition actually names it.
  const sourcesPerView = new Map<string, string[]>();
  for (const [table, viewNames] of covered) {
    if (!shadowTables.has(table)) continue;
    for (const view of viewNames) {
      sourcesPerView.set(view, [...(sourcesPerView.get(view) ?? []), table]);
    }
  }
  for (const { view_name, definition } of views.rows) {
    const sources = sourcesPerView.get(view_name) ?? [];
    if (!filtersShadow(definition, sources)) {
      violations.push({
        subject: `view:ledger.${view_name}`,
        reason:
          `view definition does not filter \`shadow\` on all ${sources.length} shadow-flagged table(s) it reads — the shadow filter lives INSIDE the finalized-view definitions (ADR-0016), so flipping the launch gate is a WHERE clause and never a rebuild`,
      });
    }
    if (!(await hasPrivilege(client, TWIN_RUNTIME_ROLE, `ledger.${view_name}`, "SELECT"))) {
      violations.push({
        subject: `view:ledger.${view_name}`,
        reason: `${TWIN_RUNTIME_ROLE} cannot select the finalized view — the views are the reader's only Ledger objects`,
      });
    }
  }

  // The seam row the aperture trusts. Class-2 evidence is a raw
  // plane-delivered `wa_events` row, and the company/seat/twin scope of
  // everything filed is read OFF that row — so a principal that can write
  // it can mint its own evidence and choose its own tenant. Ingest is the
  // only writer; the twin runtime reads and nothing more.
  for (const privilege of WRITE_PRIVILEGES) {
    if (await hasPrivilege(client, TWIN_RUNTIME_ROLE, "public.wa_events", privilege)) {
      violations.push({
        subject: "table:public.wa_events",
        reason: `${TWIN_RUNTIME_ROLE} holds ${privilege} on the inbound seam — the aperture takes rep-act evidence and the company scope off these rows, so a writer here can forge both (ADR-0003, ADR-0035)`,
      });
    }
  }

  // THE CHAIN THE APERTURE'S OWN ACTS LAND ON (ticket #54; ADR-0020, spec
  // #48 decision 18). Rep acts and refusals are audit-chained and the
  // aperture is what performs them, so an aperture that cannot append is an
  // aperture that cannot file a class-2 act at all — and it would find that
  // out at the first crossing, on a privilege error rather than on anything
  // about the act. Append-only for it too: the chain's integrity is the
  // whole point, and a writer that can rewrite a link can rewrite the
  // record of its own crossing.
  if (!(await hasPrivilege(client, APERTURE_ROLE, SHARED_CHAIN_TABLE, "INSERT"))) {
    violations.push({
      subject: `table:${SHARED_CHAIN_TABLE}`,
      reason: `${APERTURE_ROLE} cannot append to the audit chain — rep acts and refusals are audit-chained (ADR-0020), and the aperture is what performs them`,
    });
  }
  for (const destructive of ["UPDATE", "DELETE", "TRUNCATE"] as const) {
    if (
      await hasPrivilege(client, APERTURE_ROLE, SHARED_CHAIN_TABLE, destructive)
    ) {
      violations.push({
        subject: `table:${SHARED_CHAIN_TABLE}`,
        reason: `${APERTURE_ROLE} holds ${destructive} on the audit chain — the chain is append-only, and a writer that can rewrite a link can rewrite the record of its own crossing (ADR-0020)`,
      });
    }
  }

  // The aperture's own rep-side stores.
  for (const store of APERTURE_REP_SIDE_STORES) {
    const qualified = `public.${store}`;
    if (!(await hasPrivilege(client, APERTURE_ROLE, qualified, "INSERT"))) {
      violations.push({
        subject: `table:${qualified}`,
        reason: `${APERTURE_ROLE} cannot write its own store — the aperture owns the disclosure lifecycle (ADR-0003)`,
      });
    }
    if (
      store === "disclosure_lines" &&
      (await hasPrivilege(client, APERTURE_ROLE, qualified, "DELETE"))
    ) {
      violations.push({
        subject: `table:${qualified}`,
        reason: `${APERTURE_ROLE} holds DELETE on disclosure lines — a deleted line leaves an undisclosed Ledger subject behind it forever and FR-72 permanently red; retirement's erasure of plaintext lines is an open question, not a privilege to hold in advance`,
      });
    }
    for (const privilege of WRITE_PRIVILEGES) {
      if (await hasPrivilege(client, TWIN_RUNTIME_ROLE, qualified, privilege)) {
        violations.push({
          subject: `table:${qualified}`,
          reason: `${TWIN_RUNTIME_ROLE} holds ${privilege} on an aperture store — the runtime reads disclosure lines to post them and writes none`,
        });
      }
    }
    if (!(await hasPrivilege(client, TWIN_RUNTIME_ROLE, qualified, "SELECT"))) {
      violations.push({
        subject: `table:${qualified}`,
        reason: `${TWIN_RUNTIME_ROLE} cannot read the aperture store it must deliver from`,
      });
    }
  }

  violations.push(...(await auditApertureRegistryReach(client)));

  // FR-71a's own half: the owner side (ticket #127). Claims 5 to 9.
  violations.push(...(await auditRoleAttributes(client)));
  violations.push(...(await auditOwnerRelationReach(client)));
  violations.push(...(await auditOwnerSequenceReach(client)));
  violations.push(...(await auditOwnerFunctionReach(client)));
  violations.push(...(await auditOwnerSchema(client)));
  violations.push(...(await auditOwnerVisibleColumns(client)));
  // Claim 10, the rep dashboard's own (ticket #221). It sits with the owner's
  // half rather than with the rep-side arms above because it is the same KIND
  // of claim — what one authenticating application role may reach, diffed
  // against a pinned list in both directions — and not because rep-web is on
  // the owner's side of anything.
  violations.push(...(await auditRepWebReach(client)));
  violations.push(
    ...(await auditRowLevelSecurity(
      client,
      tables.rows.map((r) => `ledger.${r.table_name}`),
    )),
  );

  return {
    ledgerTables: tables.rows.map((r) => `ledger.${r.table_name}`),
    ledgerViews: views.rows.map((r) => `ledger.${r.view_name}`),
    ownerViews: Object.keys(OWNER_VISIBLE_COLUMNS),
    auditedRoles: audited,
    violations,
  };
}

/**
 * WHAT THE APERTURE MAY READ IN THE REGISTRIES (ticket #132's grant, pinned
 * by ticket #130 — the obligation recorded on the horizon, #117).
 *
 * …100070 granted `dito_aperture` SELECT on `companies` so the filing path
 * can read a company's mode and stamp `shadow` from it (ADR-0016 as
 * amended), and its own header says the privilege "sits outside FR-71a's
 * diff altogether today": the annotation sweep is fenced to `ledger`, and
 * the write-grantee sweep looks at INSERT/UPDATE/DELETE/TRUNCATE only. So a
 * later migration handing the aperture UPDATE on `companies` — which is the
 * LIFT ACT'S OWN WRITE, performed by the schema owner precisely so the
 * aperture may not perform it — would have passed every check in this file.
 *
 * Pinned in both directions, like every other claim here. Exactly SELECT,
 * on exactly `companies`: a write is the lift act moving inside the writer
 * that stamps from it, and any privilege at all on `seats` is the aperture
 * reading the registry that maps a seat to a TWIN — which is the join
 * ADR-0004's amendment keeps on the far side of the owner's views.
 */
async function auditApertureRegistryReach(
  client: pg.ClientBase,
): Promise<GrantViolation[]> {
  const violations: GrantViolation[] = [];
  if (!(await hasPrivilege(client, APERTURE_ROLE, "public.companies", "SELECT"))) {
    violations.push({
      subject: "table:public.companies",
      reason: `${APERTURE_ROLE} cannot read the company registry — the filing path stamps \`shadow\` from the company's mode (ADR-0016 as amended), and without this it files every row shadow whatever the company's mode says`,
    });
  }
  for (const privilege of WRITE_PRIVILEGES) {
    if (
      await hasPrivilege(client, APERTURE_ROLE, "public.companies", privilege)
    ) {
      violations.push({
        subject: "table:public.companies",
        reason: `${APERTURE_ROLE} holds ${privilege} on the company registry — it READS a company's mode at filing and never sets one, and \`shadow_lifted_at\` is written by the lift act as the schema owner (spec #126 decision 9)`,
      });
    }
  }
  for (const privilege of ["SELECT", ...WRITE_PRIVILEGES]) {
    if (await hasPrivilege(client, APERTURE_ROLE, "public.seats", privilege)) {
      violations.push({
        subject: "table:public.seats",
        reason: `${APERTURE_ROLE} holds ${privilege} on the seat registry — nothing in the filing path reads a seat, and this table carries the seat-to-twin mapping the owner's views exist to keep on the far side of (ADR-0004 as amended)`,
      });
    }
  }
  return violations;
}

/**
 * What the six roles ARE, before anything about what they hold (claim 5).
 *
 * Three attributes decide whether the rest of this audit means anything.
 * `rolsuper` and `rolbypassrls` each make row-level security stop applying,
 * so a role holding either reads every company through the very views this
 * audit is pinning — and the grant diff looks identical. `rolcanlogin` is
 * the other direction: `dito_aperture` and `dito_twin_runtime` are audited
 * precisely because nothing authenticates as them, and a LOGIN appearing on
 * one is a connection nobody designed.
 */
async function auditRoleAttributes(
  client: pg.ClientBase,
): Promise<GrantViolation[]> {
  const violations: GrantViolation[] = [];
  const canLogin: Readonly<Record<string, boolean>> = {
    [APERTURE_ROLE]: false,
    [TWIN_RUNTIME_ROLE]: false,
    // The owner web authenticates as it (spec #126 decision 3).
    [OWNER_ROLE]: true,
    // ...and rep-web as this one (ticket #221; spec #214 decision 5). Two
    // logins, and the pair is the whole of it: every other role here is
    // NOLOGIN and its single-writer or view-owner claim rests on a grant
    // rather than on a connection.
    [REP_WEB_ROLE]: true,
    [LEDGER_VIEWS_ROLE]: false,
    // NOLOGIN for the reason `dito_ledger_views` is: it owns the owner's own
    // tables, so anything that could connect as it could disable their
    // row-level security (Diego's ruling on #130).
    [OWNER_STATE_ROLE]: false,
  };
  const rows = await client.query<{
    rolname: string;
    rolsuper: boolean;
    rolbypassrls: boolean;
    rolcanlogin: boolean;
    memberships: string[];
  }>(
    `SELECT r.rolname, r.rolsuper, r.rolbypassrls, r.rolcanlogin,
            -- ::text on the way out: rolname is of type name, and a name[]
            -- comes back to the driver as an unparsed string.
            COALESCE(
              array_agg(g.rolname::text ORDER BY g.rolname)
                FILTER (WHERE g.rolname IS NOT NULL),
              ARRAY[]::text[]
            ) AS memberships
       FROM pg_roles r
       LEFT JOIN pg_auth_members m ON m.member = r.oid
       LEFT JOIN pg_roles g ON g.oid = m.roleid
      WHERE r.rolname = ANY($1::text[])
      GROUP BY r.rolname, r.rolsuper, r.rolbypassrls, r.rolcanlogin`,
    [Object.keys(canLogin)],
  );

  for (const row of rows.rows) {
    if (row.rolsuper) {
      violations.push({
        subject: `role:${row.rolname}`,
        reason: `${row.rolname} is a superuser — a superuser bypasses every grant and every policy this audit checks, so the wall would be a comment`,
      });
    }
    if (row.rolbypassrls) {
      violations.push({
        subject: `role:${row.rolname}`,
        reason: `${row.rolname} holds BYPASSRLS — the company policy is the whole of this slice's tenant isolation, and a role that bypasses it reads every company through the same granted views`,
      });
    }
    if (row.rolcanlogin !== canLogin[row.rolname]) {
      violations.push({
        subject: `role:${row.rolname}`,
        reason: row.rolcanlogin
          ? `${row.rolname} can log in — the two web apps' roles are what authenticate, and a third login is a connection nobody designed (ADR-0002)`
          : `${row.rolname} cannot log in — a web app is the process that authenticates as it (spec #126 decision 3, spec #214 decision 5), and a NOLOGIN role serves nobody`,
      });
    }
    if (row.memberships.length > 0) {
      violations.push({
        subject: `role:${row.rolname}`,
        reason: `${row.rolname} is a member of ${row.memberships.join(", ")} — membership is the same credential by another route, and it is invisible to every relation's own ACL (ADR-0003)`,
      });
    }
  }

  // ...AND THE OTHER DIRECTION, which is the one that actually leaks. The
  // loop above asks what each of these roles inherits; this asks WHO
  // INHERITS THEM. `dito_ledger_views` holds raw SELECT on `ledger.facts`,
  // `ledger.entities` and `public.seats` — it must, since the owner's views
  // run as it — so any role granted membership in it reads shadow rows and
  // twin ids directly, and NOLOGIN on the group prevents nothing: it is the
  // MEMBER that logs in. The relations' own ACLs still name only
  // `dito_ledger_views`, so the reach sweep sees nothing. Superusers are
  // outside the model on purpose, exactly as `sweepWriteGrantees` puts them.
  const inherited = await client.query<{ rolname: string; grantee: string }>(
    `SELECT holder.rolname, member.rolname AS grantee
       FROM pg_roles holder
       JOIN pg_auth_members m ON m.roleid = holder.oid
       JOIN pg_roles member ON member.oid = m.member
      WHERE holder.rolname = ANY($1::text[])
        AND NOT member.rolsuper
      ORDER BY 1, 2`,
    [Object.keys(canLogin)],
  );
  for (const row of inherited.rows) {
    violations.push({
      subject: `role:${row.grantee}`,
      reason: `${row.grantee} is a member of ${row.rolname} and inherits everything it holds — a member of ${LEDGER_VIEWS_ROLE} reads the Ledger's tables directly, shadow rows and twin ids included, while every relation's ACL still names only the group (ADR-0002)`,
    });
  }
  return violations;
}

/**
 * EVERY RELATION THE OWNER CAN REACH, asked of the database rather than of
 * the migrations (claim 6).
 *
 * `has_table_privilege` is used rather than an ACL sweep on purpose: it
 * answers the EFFECTIVE question, so a privilege arriving by a grant to
 * PUBLIC or through a role membership is caught by the same probe as a
 * direct grant. The column-level pass beside it exists because
 * `has_table_privilege` does not report column grants — the same blind spot
 * `LEDGER_ANNOTATION_COLUMNS` was written to cover on the rep side.
 *
 * The owner's OWN schema is excluded: it owns that schema and everything
 * #130 and #131 will put in it, which is the point of giving it one.
 */
async function auditOwnerRelationReach(
  client: pg.ClientBase,
): Promise<GrantViolation[]> {
  const violations: GrantViolation[] = [];
  const allowed = new Set(Object.keys(OWNER_VISIBLE_COLUMNS));

  const reachable = await client.query<{
    qualified: string;
    relkind: string;
    privilege: string;
    whole_relation: boolean;
  }>(
    `SELECT n.nspname || '.' || c.relname AS qualified, c.relkind, p.privilege,
            has_table_privilege($1, c.oid, p.privilege) AS whole_relation
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE',
                               'TRUNCATE', 'REFERENCES', 'TRIGGER'])
                  AS p(privilege)
      WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', $2)
        AND n.nspname NOT LIKE 'pg\\_%'
        AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
        AND (
          has_table_privilege($1, c.oid, p.privilege)
          -- CASE, not OR: has_any_column_privilege knows only the four
          -- privileges a COLUMN can carry and raises on the others, and a
          -- planner free to evaluate either side first would raise on a row
          -- the table-level probe had already answered.
          OR CASE
               WHEN p.privilege IN ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES')
               THEN has_any_column_privilege($1, c.oid, p.privilege)
               ELSE false
             END
        )
      ORDER BY 1, 3`,
    [OWNER_ROLE, OWNER_SCHEMA],
  );

  for (const row of reachable.rows) {
    // The pinned views are the one allowed reach, and only as a WHOLE
    // RELATION. A column-level SELECT on one of them satisfies
    // `has_any_column_privilege` and would slip through this arm while the
    // owner surface cannot read its own pinned projection — the column list
    // is checked against the CATALOG, not against the ACL, so nothing else
    // would notice either.
    if (
      allowed.has(row.qualified) &&
      row.privilege === "SELECT" &&
      row.whole_relation
    ) {
      continue;
    }
    // ...AND THE REP SIDE'S CHAIN, WHICH IS NO LONGER AN EXCEPTION (ticket
    // #165). Every privilege on it falls through to a violation, SELECT and
    // INSERT included — those two are the grant #157 took away, and SELECT is
    // the one the decision is actually about. Named rather than left to the
    // generic sentence below because the reason is specific: this table is a
    // rep-activity record, not a store of shadow rows.
    if (row.qualified === SHARED_CHAIN_TABLE) {
      violations.push({
        subject: `table:${SHARED_CHAIN_TABLE}`,
        reason: `${OWNER_ROLE} holds ${row.privilege} on the rep side's audit chain — the owner side may read only what it wrote (#157), and this chain is a same-company rep-activity record: every \`customer_send\` with its outcome and its timestamp, every refusal, and the \`twin:<id>\` refs the seats view withholds (ADR-0025, ADR-0004 as amended). The owner twin appends to \`${OWNER_SCHEMA}.audit_chain\` under its own key`,
      });
      continue;
    }
    if (allowed.has(row.qualified) && row.privilege === "SELECT") {
      violations.push({
        subject: `view:${row.qualified}`,
        reason: `${OWNER_ROLE} holds SELECT on some columns of it and not on the view — the pinned projection is the grant, and a column subset is an owner surface that renders part of itself and fails on the rest (ADR-0002)`,
      });
      continue;
    }
    violations.push({
      subject: `${row.relkind === "v" || row.relkind === "m" ? "view" : "table"}:${row.qualified}`,
      reason: `${OWNER_ROLE} holds ${row.privilege} — the owner role is granted named views with pinned column lists ONLY, and a table hands it the shadow rows and the twin id its views exist to withhold (ADR-0002, ADR-0004 as amended)`,
    });
  }
  for (const view of allowed) {
    if (
      !reachable.rows.some(
        (r) =>
          r.qualified === view && r.privilege === "SELECT" && r.whole_relation,
      )
    ) {
      violations.push({
        subject: `view:${view}`,
        reason: `${OWNER_ROLE} cannot select ${view} — the owner's whole read is these views, and a missing one is an owner surface that fails on a privilege rather than on anything about the question`,
      });
    }
  }
  // ...AND NO DECLARED-BUT-MISSING ARM FOR THE CHAIN ANY MORE (ticket #165).
  // The owner is owed nothing on any `public` table, so there is nothing here
  // whose absence would be a violation. The pair that IS load-bearing —
  // SELECT and INSERT on `owner.audit_chain`, because the append reads and
  // authenticates its own tail before extending it — is checked in both
  // directions by `auditOwnerSchemaGrants`, which enumerates every owner
  // relation.
  return violations;
}

/**
 * ...AND EVERY SEQUENCE, which is the other half of claim 6 (ticket #165,
 * Codex r1).
 *
 * THE BLIND SPOT THIS CLOSES, stated as the statement that exploits it.
 * `auditOwnerRelationReach` above sweeps `relkind IN ('r','p','v','m','f')`
 * and `has_table_privilege`, which know nothing about sequences — so
 *
 *     GRANT SELECT ON SEQUENCE public.audit_chain_id_seq TO dito_owner;
 *
 * left FR-71a green while `SELECT last_value FROM public.audit_chain_id_seq`
 * handed the owner an EXACT running count of the rep side's chain entries,
 * pollable to time every rep act, with no privilege on the table at all.
 * That is the precise signal #157 revoked the table grant over (ADR-0025),
 * arriving through the relation kind the sweep did not look at. The seam and
 * the rail have identity sequences too, and the same statement reads them.
 *
 * THE OWNER'S OWN SCHEMA IS NOT EXCLUDED, and that is the one place this
 * sweep is wider than the table sweep above. Row-level security DOES NOT
 * APPLY TO SEQUENCES, so `owner.audit_chain_id_seq` is a GLOBAL allocation
 * counter: with SELECT on it, one company's connection reads how many entries
 * every company has written and polls it to time their executions —
 * cross-tenant inference inside the schema the owner is supposed to own. The
 * app needs neither privilege, because a column `GENERATED ALWAYS AS
 * IDENTITY` is allocated by the system with no privilege check, so the honest
 * claim here is ZERO, everywhere.
 *
 * All three sequence privileges are probed. USAGE is `nextval`, which reveals
 * the value it consumed; SELECT is `last_value`; UPDATE is `setval`, which
 * would let the owner move a sequence and collide the next insert.
 */
async function auditOwnerSequenceReach(
  client: pg.ClientBase,
): Promise<GrantViolation[]> {
  const violations: GrantViolation[] = [];
  const reachable = await client.query<{
    qualified: string;
    privilege: string;
    own_schema: boolean;
  }>(
    `SELECT n.nspname || '.' || c.relname AS qualified, p.privilege,
            (n.nspname = $2) AS own_schema
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       CROSS JOIN unnest(ARRAY['USAGE', 'SELECT', 'UPDATE']) AS p(privilege)
      WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
        AND n.nspname NOT LIKE 'pg\\_%'
        AND c.relkind = 'S'
        AND has_sequence_privilege($1, c.oid, p.privilege)
      ORDER BY 1, 2`,
    [OWNER_ROLE, OWNER_SCHEMA],
  );
  for (const row of reachable.rows) {
    violations.push({
      subject: `sequence:${row.qualified}`,
      reason: row.own_schema
        ? `${OWNER_ROLE} holds ${row.privilege} on a sequence in its own schema — row-level security does not reach a sequence, so \`last_value\` is the GLOBAL allocation counter and one company would read how many entries every other company has written (ADR-0002; the decision on #157). An identity column needs no sequence privilege at all`
        : `${OWNER_ROLE} holds ${row.privilege} on a sequence outside its own schema — a sequence's \`last_value\` is an exact running count of the table it numbers, so this is the rep-side activity signal #157 revoked the table grant over, reachable with no privilege on the table at all (ADR-0002, ADR-0025)`,
    });
  }
  return violations;
}

/**
 * EVERY FUNCTION THE OWNER CAN CALL (claim 7), and the claim is narrower
 * than "one", deliberately.
 *
 * Inside `ledger` it IS one: the owner may execute `resolve_entity` and
 * nothing else, and PUBLIC may execute nothing — PostgreSQL's default is
 * PUBLIC EXECUTE on every new function, which is what made "exactly the
 * named function" unclaimable until …100050 revoked it.
 *
 * Outside `ledger` the honest claim is about SECURITY DEFINER. Every
 * function in `public` is PUBLIC-executable by PostgreSQL's default and
 * `dito_owner` is a member of PUBLIC, so demanding that it can call none of
 * them would mean revoking EXECUTE across a schema full of trigger
 * functions for no gain: an ordinary function runs with the CALLER's
 * rights, so calling one buys the owner exactly the privileges it already
 * has. A `SECURITY DEFINER` function is the exception and the whole risk —
 * it lends its definer's reach to whoever may call it — so that is what is
 * checked, and `ledger.resolve_entity` is the one this ticket wrote.
 */
async function auditOwnerFunctionReach(
  client: pg.ClientBase,
): Promise<GrantViolation[]> {
  const violations: GrantViolation[] = [];
  const functions = await client.query<{
    qualified: string;
    schema_name: string;
    is_definer: boolean;
    owner_may_execute: boolean;
    public_may_execute: boolean;
  }>(
    `SELECT n.nspname || '.' || p.proname || '(' ||
              pg_catalog.oidvectortypes(p.proargtypes) || ')' AS qualified,
            n.nspname AS schema_name,
            p.prosecdef AS is_definer,
            has_function_privilege($1, p.oid, 'EXECUTE') AS owner_may_execute,
            has_function_privilege('public', p.oid, 'EXECUTE') AS public_may_execute
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
        AND n.nspname NOT LIKE 'pg\\_%'
        -- The owner's OWN schema is excluded only for the functions the
        -- owner itself owns. A SECURITY DEFINER routine created THERE by
        -- the migration role would lend that role's reach to whoever may
        -- call it, and PostgreSQL grants EXECUTE on a new function to
        -- PUBLIC — so an owner-schema helper added by a later ticket is
        -- covered by the definer arm below rather than waved through.
        --
        -- SINCE THE RULING ON #130 THIS EXCLUSION IS VACUOUS, and left in
        -- place deliberately: the owner login holds USAGE and not CREATE on
        -- the schema, so it can own no function there, and every function
        -- in it goes through the definer arm. Removing the clause would say
        -- the same thing only until somebody grants CREATE back.
        AND (n.nspname <> $2 OR p.proowner::regrole::text <> $1)
      ORDER BY 1`,
    [OWNER_ROLE, OWNER_SCHEMA],
  );
  const executable = new Set<string>();
  for (const row of functions.rows) {
    const normalized = row.qualified.replace(/,\s+/g, ",");
    // The named function is the one the owner MAY call; it is not exempt
    // from the PUBLIC arm, which is about everybody else.
    const named = (OWNER_EXECUTABLE_FUNCTIONS as readonly string[]).includes(
      normalized,
    );
    if (named && row.owner_may_execute) executable.add(normalized);
    if (row.schema_name === "ledger") {
      if (row.owner_may_execute && !named) {
        violations.push({
          subject: `function:${normalized}`,
          reason: `${OWNER_ROLE} may execute it — the owner calls exactly ${OWNER_EXECUTABLE_FUNCTIONS.join(" and ")} and nothing else, because a Ledger function it may run is a read of tables it may not (spec #126 decision 15)`,
        });
      }
      if (row.public_may_execute) {
        violations.push({
          subject: `function:${normalized}`,
          reason:
            "PUBLIC may execute a Ledger function — that is PostgreSQL's default, and it makes 'exactly the named function' unclaimable; …100050 revokes it and a later function inherits the revocation",
        });
      }
    } else if (row.is_definer && row.owner_may_execute && !named) {
      violations.push({
        subject: `function:${normalized}`,
        reason: `${OWNER_ROLE} may execute a SECURITY DEFINER function — a definer function lends its definer's reach to whoever may call it, which is the one way an EXECUTE grant becomes access to a table the owner holds nothing on`,
      });
    }
  }

  // ...AND THE OTHER DIRECTION. Reporting only the functions the owner may
  // call and should not leaves the opposite failure silent: revoke EXECUTE
  // on the resolution function and every owner timeline stops resolving
  // merges while FR-71a stays green. Declared-but-missing is the arm
  // `LEDGER_ANNOTATION_COLUMNS` has had since #54, on this side too.
  for (const required of OWNER_EXECUTABLE_FUNCTIONS) {
    if (!executable.has(required)) {
      violations.push({
        subject: `function:${required}`,
        reason: `${OWNER_ROLE} cannot execute it — a pinned owner function that is missing or ungranted is an owner surface that fails on a privilege rather than on anything about the question`,
      });
    }
  }

  return violations;
}

/**
 * THE OWNER'S OWN SCHEMA (claim 8; spec #126 decision 3; Diego's ruling on
 * #130, 2026-09-02).
 *
 * THE CLAIM CHANGED SHAPE AND IS NOW NARROWER. It used to be "the owner
 * owns it, so its state needs no grant from anybody"; it is now "a NOLOGIN
 * role owns it, and the owner holds exactly the grants it uses". The reason
 * is one sentence: a relation's owner may `ALTER TABLE … DISABLE ROW LEVEL
 * SECURITY`, and FORCE makes an owner subject to its policies rather than
 * unable to remove them — so while the login owned its own tables, the
 * tenant isolation on them was one statement away from gone, and two
 * deployments against one database is the case it exists for. The schema
 * moves too: a schema's owner may CREATE in it, and a table it created it
 * would own.
 */
async function auditOwnerSchema(
  client: pg.ClientBase,
): Promise<GrantViolation[]> {
  const violations: GrantViolation[] = [];
  const schema = await client.query<{ owner_name: string }>(
    "SELECT nspowner::regrole::text AS owner_name FROM pg_namespace WHERE nspname = $1",
    [OWNER_SCHEMA],
  );
  if (schema.rows.length === 0) {
    violations.push({
      subject: `schema:${OWNER_SCHEMA}`,
      reason: `the owner app's own schema does not exist — its execution records and its questions have nowhere to live that is not the Ledger's (spec #126 decision 3)`,
    });
  } else if (schema.rows[0]!.owner_name !== OWNER_STATE_ROLE) {
    violations.push({
      subject: `schema:${OWNER_SCHEMA}`,
      reason: `schema ${OWNER_SCHEMA} is owned by ${schema.rows[0]!.owner_name} rather than by ${OWNER_STATE_ROLE} — a schema's owner may CREATE in it and would own what it created, and an owned table can have its row-level security disabled (the ruling on #130)`,
    });
  }

  // ...AND IT HOLDS STATE, NOT WINDOWS. The default privileges …100020 sets
  // grant the owner ALL on every table a later migration creates here, and
  // PostgreSQL applies TABLE defaults to VIEWS — so an `owner.anything`
  // defined over `ledger.facts`, created by the migration role and
  // therefore evaluated as one, would hand the owner every tenant's facts,
  // with no grant anybody wrote and nothing else in this file looking. The
  // relation KINDS this schema may hold are the answer: tables and
  // sequences, which can read nothing they do not contain.
  const inside = await client.query<{
    relname: string;
    relkind: string;
    owner_name: string;
    rls_enabled: boolean;
    rls_forced: boolean;
  }>(
    `SELECT c.relname, c.relkind, c.relowner::regrole::text AS owner_name,
            c.relrowsecurity AS rls_enabled, c.relforcerowsecurity AS rls_forced
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1
        AND c.relkind NOT IN ('i', 'I', 't')
      ORDER BY 1`,
    [OWNER_SCHEMA],
  );
  const seen = new Set<string>();
  for (const row of inside.rows) {
    seen.add(row.relname);
    if (!["r", "p", "S"].includes(row.relkind)) {
      violations.push({
        subject: `relation:${OWNER_SCHEMA}.${row.relname}`,
        reason: `the owner's own schema holds a relation of kind '${row.relkind}' — it may hold tables and sequences, because a VIEW or a foreign table defined here reads somewhere else and would arrive owner-readable through this schema's default privileges rather than through a grant anybody wrote (ADR-0002)`,
      });
    }
    if (row.owner_name !== OWNER_STATE_ROLE) {
      violations.push({
        subject: `relation:${OWNER_SCHEMA}.${row.relname}`,
        reason: `owned by ${row.owner_name} rather than by ${OWNER_STATE_ROLE} — a relation's owner may disable its row-level security, and FORCE makes an owner subject to its policies rather than unable to remove them, so the login the policies bind must not be the role that owns them (the ruling on #130)`,
      });
    }
    // ...AND IT IS ONE OF THE THREE (ticket #130, Codex r1). "A table owned
    // by the owner" was the whole of the claim, so `owner.seam_dump` —
    // created here by a later migration, carrying a JID or a twin id, and
    // owner-readable through this schema's default privileges — passed it.
    // The relations this schema may hold are enumerated in code for the
    // same reason the owner's COLUMNS are: a list derived from the thing it
    // is checking cannot catch a change to it.
    if (row.relkind !== "S" && !(OWNER_RELATIONS as readonly string[]).includes(row.relname)) {
      violations.push({
        subject: `relation:${OWNER_SCHEMA}.${row.relname}`,
        reason: `nobody pinned it — the owner's own state is ${OWNER_RELATIONS.join(", ")} and an unpinned relation here is owner-readable the moment it exists, through default privileges rather than through a grant anybody wrote (ADR-0002)`,
      });
      continue;
    }
    if (row.relkind === "S") continue;
    // TENANT ISOLATION ON THE OWNER'S OWN TABLES, which the general RLS
    // audit does not reach: it enumerates `ledger` tables and the two
    // registries. `dito_owner` OWNS these, so `ENABLE` alone exempts the
    // one role that ever reads through them — `FORCE` is the half that
    // makes the policy true of anybody at all.
    if (!row.rls_enabled || !row.rls_forced) {
      violations.push({
        subject: `relation:${OWNER_SCHEMA}.${row.relname}`,
        reason: `row-level security is ${row.rls_enabled ? "enabled but not FORCED" : "not enabled"} — the owner OWNS this table, so without FORCE the company policy is true of everybody except the one role that reads through it, and two deployments against one database would read each other's conversations (ADR-0002)`,
      });
    }
  }
  for (const relation of OWNER_RELATIONS) {
    if (!seen.has(relation)) {
      violations.push({
        subject: `relation:${OWNER_SCHEMA}.${relation}`,
        reason: `a pinned owner relation is not in the catalog — the owner app writes its question, its execution record, its answer and its chain entry into these ${OWNER_RELATIONS.length}, and a missing one is a turn that fails on a relation rather than on anything about the question`,
      });
    }
  }
  violations.push(...(await auditOwnerTablePolicies(client)));
  violations.push(...(await auditOwnerTableColumns(client)));
  violations.push(...(await auditOwnerSchemaGrants(client)));
  violations.push(...(await auditOwnerDefaultPrivileges(client)));

  return violations;
}

/**
 * WHO CAN REACH THE OWNER'S OWN STATE, AND WITH WHAT (ticket #130, Codex r3;
 * rewritten for Diego's ruling of 2026-09-02).
 *
 * `auditOwnerRelationReach` asks what `dito_owner` can reach and EXCLUDES
 * this schema — it has to, since the owner's grants on its own state live
 * here. So this is the check that says what those grants ARE, and it is
 * exact in both directions:
 *
 *   `dito_owner` holds USAGE on the schema and SELECT and INSERT on each of
 *   `OWNER_RELATIONS`. Not UPDATE, not DELETE, not TRUNCATE: the owner app
 *   appends its conversation and reads it back, an answer that could be
 *   rewritten is a record the chain's digest could no longer speak for, and
 *   until the ruling the schema's default privileges had quietly granted it
 *   ALL of them. Since #165 the chain is one of those relations, and the same
 *   two privileges are exactly what appending to it needs — the tail read and
 *   the insert — so it needs no clause of its own here.
 *
 *   NOBODY ELSE holds anything at all. A migration granting `USAGE ON SCHEMA
 *   owner` and `SELECT ON owner.answers` to `dito_twin_runtime`, or to
 *   PUBLIC, left FR-71a green while the owner's conversation became readable
 *   by the rep side.
 *
 * `dito` IS NOT A VIOLATION and is not exempted either: it is a superuser in
 * every cluster this runs in, so it appears in no ACL and reaches everything
 * by attribute. That is the standing debt `…100012` records, not something
 * this check can close. `dito_owner_state` appears as the relations' owner,
 * which PostgreSQL writes into every ACL it materializes.
 */
async function auditOwnerSchemaGrants(
  client: pg.ClientBase,
): Promise<GrantViolation[]> {
  const violations: GrantViolation[] = [];
  const allowed = new Set<string>(OWNER_STATE_PRIVILEGES);
  const grants = await client.query<{
    relname: string;
    relkind: string;
    grantee: string;
    privilege: string;
  }>(
    // SEQUENCES ARE SWEPT TOO (ticket #165, Codex r2), and it is the SECOND
    // grantee that makes it matter. The owner's own sequence privileges are
    // pinned to zero by `auditOwnerSequenceReach`; what nothing looked at was
    // `GRANT SELECT ON SEQUENCE owner.audit_chain_id_seq TO
    // dito_twin_runtime`, which hands the REP side a global counter of every
    // company's owner appends while every invariant here stayed green — the
    // exact inverse of the leak that sweep closed, and against the sentence
    // this function exists for: nobody but the state role holds anything in
    // this schema.
    `SELECT c.relname, c.relkind,
            (aclexplode(c.relacl)).grantee::regrole::text AS grantee,
            (aclexplode(c.relacl)).privilege_type AS privilege
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'S')
      UNION ALL
      SELECT '', 'n',
             (aclexplode(n.nspacl)).grantee::regrole::text,
             (aclexplode(n.nspacl)).privilege_type
        FROM pg_namespace n
       WHERE n.nspname = $1`,
    [OWNER_SCHEMA],
  );
  for (const row of grants.rows) {
    const where =
      row.relname === ""
        ? `schema:${OWNER_SCHEMA}`
        : `${row.relkind === "S" ? "sequence" : "relation"}:${OWNER_SCHEMA}.${row.relname}`;
    // The owner of a relation appears in its own ACL; that is ownership,
    // which `auditOwnerSchema` pins directly.
    if (row.grantee === OWNER_STATE_ROLE) continue;
    if (row.grantee !== OWNER_ROLE) {
      violations.push({
        subject: where,
        reason: `${row.grantee === "-" ? "PUBLIC" : row.grantee} holds ${row.privilege} on the owner's own state — the questions an owner asked and the answers it was given are the owner app's and nobody else's, and a second reader of them is a wall the grant diff stopped describing (ADR-0002, ADR-0025)`,
      });
      continue;
    }
    // ...AND THE OWNER HOLDS NOTHING ON A SEQUENCE HERE, which
    // `auditOwnerSequenceReach` says over the effective privilege and this
    // says over the ACL. An identity column needs neither.
    if (row.relkind === "S") {
      violations.push({
        subject: where,
        reason: `${OWNER_ROLE} holds ${row.privilege} on a sequence in its own schema — row-level security does not reach a sequence, so \`last_value\` is the GLOBAL allocation counter across every company, and a column GENERATED ALWAYS AS IDENTITY needs no sequence privilege at all (the decision on #157)`,
      });
      continue;
    }
    const permitted = row.relname === "" ? "USAGE" : undefined;
    if (permitted !== undefined) {
      if (row.privilege !== permitted) {
        violations.push({
          subject: where,
          reason: `${OWNER_ROLE} holds ${row.privilege} on the schema — it may NAME its own tables and may not create one here, because a table it created it would own, and an owned table can have its row-level security disabled (the ruling on #130)`,
        });
      }
      continue;
    }
    if (!allowed.has(row.privilege)) {
      violations.push({
        subject: where,
        reason: `${OWNER_ROLE} holds ${row.privilege} on its own state — it may ${[...OWNER_STATE_PRIVILEGES].join(" and ")} and nothing else, because the owner app appends its conversation and does not edit it, and an answer that could be rewritten is a record the chain's digest could no longer speak for (the ruling on #130)`,
      });
    }
  }
  // ...AND THE OTHER DIRECTION: a grant that went missing is an owner app
  // that fails on a privilege rather than on anything about the question.
  const held = new Set(
    grants.rows
      .filter((row) => row.grantee === OWNER_ROLE)
      .map((row) => `${row.relname}:${row.privilege}`),
  );
  if (!held.has(":USAGE")) {
    violations.push({
      subject: `schema:${OWNER_SCHEMA}`,
      reason: `${OWNER_ROLE} cannot USE its own schema — without it every table below is unnameable and the owner app fails on its first turn`,
    });
  }
  for (const relation of OWNER_RELATIONS) {
    for (const privilege of OWNER_STATE_PRIVILEGES) {
      if (!held.has(`${relation}:${privilege}`)) {
        violations.push({
          subject: `relation:${OWNER_SCHEMA}.${relation}`,
          reason: `${OWNER_ROLE} cannot ${privilege} it — it no longer owns this table (the ruling on #130), so what it may do is exactly what is granted, and a missing grant is a turn that fails on a privilege`,
        });
      }
    }
  }
  return violations;
}

/**
 * ...AND WHAT THE NEXT TABLE HERE WILL ARRIVE WITH (Diego's ruling on #130).
 *
 * `…100020` wrote `ALTER DEFAULT PRIVILEGES IN SCHEMA owner GRANT ALL ON
 * TABLES TO dito_owner`, attached to the role Atlas runs as — so the three
 * tables #130 created handed the owner login ALL, including the UPDATE,
 * DELETE and TRUNCATE the append-only shape exists to refuse. `…100090`
 * revokes that and narrows the default to the two privileges the app uses.
 * Pinned here so the widening cannot come back quietly: a default privilege
 * fires on a table nobody has written yet, which is the one grant no catalog
 * sweep over existing relations can see — and #165's `owner.audit_chain` is
 * the first table to arrive under the narrowed default, which is why its
 * migration states its own grant out loud rather than relying on this.
 *
 * IT CANNOT FIX A FUTURE TABLE'S OWNER, and no default privilege can — that
 * is what `auditOwnerSchema` checks over the catalog instead.
 */
async function auditOwnerDefaultPrivileges(
  client: pg.ClientBase,
): Promise<GrantViolation[]> {
  const violations: GrantViolation[] = [];
  const allowed = new Set<string>(OWNER_STATE_PRIVILEGES);
  const defaults = await client.query<{
    objtype: string;
    grantee: string;
    privilege: string;
  }>(
    `SELECT d.defaclobjtype AS objtype,
            (aclexplode(d.defaclacl)).grantee::regrole::text AS grantee,
            (aclexplode(d.defaclacl)).privilege_type AS privilege
       FROM pg_default_acl d
       JOIN pg_namespace n ON n.oid = d.defaclnamespace
      WHERE n.nspname = $1`,
    [OWNER_SCHEMA],
  );
  for (const row of defaults.rows) {
    if (row.grantee !== OWNER_ROLE) {
      violations.push({
        subject: `default-privilege:${OWNER_SCHEMA}`,
        reason: `${row.grantee === "-" ? "PUBLIC" : row.grantee} is granted ${row.privilege} on every ${row.objtype === "r" ? "table" : "object"} created here in future — a default privilege is a grant on a relation nobody has written yet, and the owner's own state is the owner app's and nobody else's`,
      });
      continue;
    }
    // 'r' is a table, 'S' a sequence. A SEQUENCE DEFAULT PERMITS NOTHING
    // since #165, and the sentence that used to be here — "USAGE or SELECT is
    // what an identity column needs" — was simply wrong: PostgreSQL allocates
    // a `GENERATED ALWAYS AS IDENTITY` value with no privilege check at all.
    // The first table in this schema to HAVE a sequence is what found it out,
    // and what it arrived carrying was a global counter of every company's
    // appends, which row-level security does not reach (`…100010`).
    const permitted = row.objtype === "S" ? new Set<string>() : allowed;
    if (!permitted.has(row.privilege)) {
      violations.push({
        subject: `default-privilege:${OWNER_SCHEMA}`,
        reason: `${OWNER_ROLE} would be granted ${row.privilege} on every ${row.objtype === "r" ? "table" : "sequence"} created here in future — the next table must arrive with what the app uses and no more (the ruling on #130)`,
      });
    }
  }
  return violations;
}

/**
 * The owner's own tables, column by column (ticket #130, Codex r2).
 *
 * The reason is `auditOwnerVisibleColumns`': the owner login sees every
 * column of a table it owns, so a `chat_jid` or a `twin_id` added here by a
 * later migration is owner-readable the moment it exists, with no grant to
 * diff and nothing else in this file looking.
 */
async function auditOwnerTableColumns(
  client: pg.ClientBase,
): Promise<GrantViolation[]> {
  const violations: GrantViolation[] = [];
  const live = await client.query<{ relname: string; column_name: string }>(
    `SELECT c.relname, a.attname AS column_name
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = c.oid
      WHERE n.nspname = $1
        AND c.relkind IN ('r', 'p')
        AND a.attnum > 0
        AND NOT a.attisdropped
      ORDER BY 1, a.attnum`,
    [OWNER_SCHEMA],
  );
  for (const [relation, pinned] of Object.entries(OWNER_TABLE_COLUMNS)) {
    const columns = live.rows
      .filter((row) => row.relname === relation)
      .map((row) => row.column_name);
    if (columns.length === 0) continue;
    for (const column of columns) {
      if (!pinned.includes(column)) {
        violations.push({
          subject: `column:${OWNER_SCHEMA}.${relation}.${column}`,
          reason: `nobody pinned it — the owner login sees every column of a table it owns, so a column added here is owner-readable the moment it exists rather than through a grant anybody wrote (ADR-0002)`,
        });
      }
    }
    for (const column of pinned) {
      if (!columns.includes(column)) {
        violations.push({
          subject: `column:${OWNER_SCHEMA}.${relation}.${column}`,
          reason: `a pinned owner column is not in the catalog — the list in code and the table have drifted apart, and the owner app writes into the one that is not there`,
        });
      }
    }
  }
  return violations;
}

/**
 * The company policies on the owner's own tables (ticket #130).
 *
 * ONE SELECT AND ONE INSERT PER TABLE, each reading the same
 * `declared_company()` every Ledger policy reads, and NOTHING FOR UPDATE OR
 * DELETE: the owner app appends its conversation and does not edit it, and
 * an answer that could be rewritten after the fact is a record the audit
 * chain's digest could no longer speak for. A policy is permissive, so the
 * absence of one for a command is the refusal — which means a policy ADDED
 * for `ALL` is what this check exists to find.
 */
async function auditOwnerTablePolicies(
  client: pg.ClientBase,
): Promise<GrantViolation[]> {
  const violations: GrantViolation[] = [];
  const policies = await client.query<{
    relname: string;
    polname: string;
    cmd: string;
    qual: string | null;
    with_check: string | null;
  }>(
    `SELECT c.relname, p.polname,
            CASE p.polcmd WHEN 'r' THEN 'SELECT' WHEN 'a' THEN 'INSERT'
                          WHEN 'w' THEN 'UPDATE' WHEN 'd' THEN 'DELETE'
                          ELSE 'ALL' END AS cmd,
            pg_get_expr(p.polqual, p.polrelid) AS qual,
            pg_get_expr(p.polwithcheck, p.polrelid) AS with_check
       FROM pg_policy p
       JOIN pg_class c ON c.oid = p.polrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1
      ORDER BY 1, 2`,
    [OWNER_SCHEMA],
  );
  for (const row of policies.rows) {
    const expression = row.cmd === "INSERT" ? row.with_check : row.qual;
    if (row.cmd !== "SELECT" && row.cmd !== "INSERT") {
      violations.push({
        subject: `policy:${OWNER_SCHEMA}.${row.relname}.${row.polname}`,
        reason: `it permits ${row.cmd} — the owner app appends its conversation and does not edit it, and an answer that could be rewritten is a record the chain's digest could no longer speak for`,
      });
      continue;
    }
    if (normalizeSql(expression ?? "") !== normalizeSql(LEDGER_COMPANY_POLICY)) {
      violations.push({
        subject: `policy:${OWNER_SCHEMA}.${row.relname}.${row.polname}`,
        reason: `its ${row.cmd === "INSERT" ? "WITH CHECK" : "USING"} expression is not the pinned company predicate — one definition of "the company this connection declared", so the owner's own rows and the Ledger's can never disagree about which tenant is reading`,
      });
    }
  }
  for (const relation of OWNER_RELATIONS) {
    for (const cmd of ["SELECT", "INSERT"] as const) {
      if (
        !policies.rows.some((row) => row.relname === relation && row.cmd === cmd)
      ) {
        violations.push({
          subject: `relation:${OWNER_SCHEMA}.${relation}`,
          reason: `it has no ${cmd} policy — row-level security is forced on it, so the owner app cannot ${cmd === "SELECT" ? "read its own conversation" : "record a turn"} at all`,
        });
      }
    }
  }
  return violations;
}

/**
 * The pinned owner column lists against the live catalog, both directions
 * (claim 9).
 *
 * An unpinned column the owner can see is the accident ADR-0002 calls a
 * spine change: `filed_by_twin_id` reappearing on the facts view, a
 * `twin_id` handed to the seats view by a convenient migration. A pinned
 * column that stopped existing is the other half — an owner surface that
 * renders nothing, discovered here rather than in a browser.
 */
async function auditOwnerVisibleColumns(
  client: pg.ClientBase,
): Promise<GrantViolation[]> {
  const violations: GrantViolation[] = [];
  violations.push(...(await auditOwnerViewTrust(client)));
  const live = await client.query<{
    qualified: string;
    column_name: string;
  }>(
    `SELECT n.nspname || '.' || c.relname AS qualified, a.attname AS column_name
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = c.oid
      WHERE n.nspname || '.' || c.relname = ANY($1::text[])
        AND c.relkind IN ('v', 'm')
        AND a.attnum > 0
        AND NOT a.attisdropped
      ORDER BY 1, a.attnum`,
    [Object.keys(OWNER_VISIBLE_COLUMNS)],
  );

  for (const [view, pinned] of Object.entries(OWNER_VISIBLE_COLUMNS)) {
    const columns = live.rows
      .filter((r) => r.qualified === view)
      .map((r) => r.column_name);
    if (columns.length === 0) {
      violations.push({
        subject: `view:${view}`,
        reason:
          "the owner view does not exist — the owner reads named views only (ADR-0002), so a missing one is not a degraded read but no read at all",
      });
      continue;
    }
    for (const column of columns) {
      if (!pinned.includes(column)) {
        violations.push({
          subject: `column:${view}.${column}`,
          reason:
            "the owner can see a column nobody pinned — adding an owner-visible column is a spine change (ADR-0002), and the pinned list in code is the diff that says so",
        });
      }
    }
    for (const column of pinned) {
      if (!columns.includes(column)) {
        violations.push({
          subject: `column:${view}.${column}`,
          reason:
            "a pinned owner column is not in the catalog — the list in code and the view have drifted apart, and the owner surface renders from the one that is not there",
        });
      }
    }
  }
  return violations;
}

/**
 * WHAT THE OWNER'S VIEWS RUN AS, which is the trust boundary the column
 * list rests on.
 *
 * Three properties, each of which silently undoes the wall if it changes
 * and none of which any other check would notice. OWNER: the views are
 * definer-rights, so an `ALTER VIEW … OWNER TO dito` would evaluate every
 * read as a superuser and bypass RLS for every caller — same grants, same
 * columns, every company. `security_invoker`: turning it on flips the base
 * relations back onto the INVOKER, so the owner's read would start failing
 * on `ledger.facts` — or, worse, start working the day somebody "fixes" it
 * with a grant. `security_barrier`: the owner owns a schema it may create
 * functions in, so without a barrier a leaky operator in its own WHERE
 * clause can be evaluated before the shadow filter discards the row.
 */
async function auditOwnerViewTrust(
  client: pg.ClientBase,
): Promise<GrantViolation[]> {
  const violations: GrantViolation[] = [];
  const views = await client.query<{
    qualified: string;
    owner_name: string;
    options: string[] | null;
  }>(
    `SELECT n.nspname || '.' || c.relname AS qualified,
            c.relowner::regrole::text AS owner_name,
            c.reloptions AS options
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname || '.' || c.relname = ANY($1::text[])
        AND c.relkind = 'v'`,
    [Object.keys(OWNER_VISIBLE_COLUMNS)],
  );
  const pinnedDefinitions = await client.query<{
    qualified: string;
    definition: string;
  }>(
    `SELECT n.nspname || '.' || c.relname AS qualified,
            pg_get_viewdef(c.oid, true) AS definition
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname || '.' || c.relname = ANY($1::text[])
        AND c.relkind = 'v'`,
    [Object.keys(OWNER_VIEW_DEFINITIONS)],
  );
  const live = new Map(
    pinnedDefinitions.rows.map((r) => [r.qualified, normalizeSql(r.definition)]),
  );
  for (const [view, pinned] of Object.entries(OWNER_VIEW_DEFINITIONS)) {
    const definition = live.get(view);
    if (definition === undefined) {
      // A MISSING ROW IS A VIOLATION, not a skip. The query above asks for
      // ordinary views, so a `seats_status` replaced by a MATERIALIZED view
      // holding every company's seats — same columns, same owner grant, RLS
      // bypassed at read time — would simply not appear here, and silence
      // would pass it.
      violations.push({
        subject: `view:${view}`,
        reason:
          "the pinned owner surface is not an ordinary view — a materialized view keeps the columns and the grant while its rows are a snapshot no row-level policy filters, and a table or a foreign table keeps neither promise (ADR-0002)",
      });
      continue;
    }
    if (definition !== normalizeSql(pinned)) {
      violations.push({
        subject: `view:${view}`,
        reason: `the view's definition is not the pinned one — a column NAME says nothing about the expression behind it, and a view keeping this catalog shape can return the twin id under the seat's name or decide a rendered value with the shadow predicate instead of gating a row (ADR-0002, ADR-0004 as amended). Live: ${definition}`,
      });
    }
  }

  // ...and the function the company policies name, whose body is the whole
  // of what "scoped to the connection's company" means.
  const declaredCompany = await client.query<{
    body: string;
    is_definer: boolean;
    owner_name: string;
    config: string[] | null;
  }>(
    // BY EXACT SIGNATURE (Codex r2), for the reason the definer wrappers
    // are: PostgreSQL permits overloads, and a check that asks for a NAME
    // and trusts the first row can end up reading a function nobody wrote a
    // policy about while the zero-argument one every policy calls has
    // drifted. `to_regprocedure` resolves the arguments or yields NULL,
    // which is the "does not exist" violation below.
    `SELECT p.prosrc AS body, p.prosecdef AS is_definer,
            p.proowner::regrole::text AS owner_name, p.proconfig AS config
       FROM pg_proc p
      WHERE p.oid = to_regprocedure('ledger.declared_company()')`,
  );
  if (declaredCompany.rows.length === 0) {
    violations.push({
      subject: "function:ledger.declared_company()",
      reason:
        "the function every company policy calls does not exist — the policies name it, and a policy over a missing function is not a rule",
    });
  } else {
    const fn = declaredCompany.rows[0]!;
    if (normalizeSql(fn.body) !== normalizeSql(DECLARED_COMPANY_BODY)) {
      violations.push({
        subject: "function:ledger.declared_company()",
        reason: `its body is not the pinned one — every company policy is only a promise about rows while this reads the connection's own setting and nothing else. Live: ${normalizeSql(fn.body)}`,
      });
    }
    if (fn.is_definer) {
      violations.push({
        subject: "function:ledger.declared_company()",
        reason:
          "it is SECURITY DEFINER — a function the policies call runs for whoever is reading, and a definer one would run for somebody else",
      });
    }
    // `ALTER FUNCTION ledger.declared_company() SET dito.company_id = '<B>'`
    // leaves the body byte-for-byte identical and makes EVERY row-level
    // policy in the database resolve company B. Nothing else in this file
    // would notice, because nothing else reads `proconfig`.
    if (fn.config !== null) {
      violations.push({
        subject: "function:ledger.declared_company()",
        reason: `it carries a per-function setting (${fn.config.join(", ")}) — the company a policy resolves would then come from the FUNCTION rather than from the connection, which is every policy in the database answering about somebody else`,
      });
    }
  }

  violations.push(...(await auditOwnerCallableFunctions(client)));
  violations.push(...(await auditOwnerObjectGrantees(client)));

  const trusted = new Set(views.rows.map((r) => r.qualified));
  for (const view of Object.keys(OWNER_VISIBLE_COLUMNS)) {
    if (!trusted.has(view)) {
      violations.push({
        subject: `view:${view}`,
        reason:
          "no ordinary view by that name — the owner reads named views (ADR-0002), and this check has nothing to say about whatever relation is standing in its place",
      });
    }
  }
  for (const row of views.rows) {
    const options = row.options ?? [];
    if (row.owner_name !== LEDGER_VIEWS_ROLE) {
      violations.push({
        subject: `view:${row.qualified}`,
        reason: `owned by ${row.owner_name} rather than ${LEDGER_VIEWS_ROLE} — a definer view is evaluated as its owner, so an owner that bypasses row-level security bypasses it for every caller of this view (ADR-0002)`,
      });
    }
    if (options.includes("security_invoker=true")) {
      violations.push({
        subject: `view:${row.qualified}`,
        reason:
          "security_invoker is on — the base relations would be checked against the READER, and the owner role holds nothing on them by design, so this either breaks the owner's read or invites the grant that breaks the wall",
      });
    }
    if (!options.includes("security_barrier=true")) {
      violations.push({
        subject: `view:${row.qualified}`,
        reason:
          "security_barrier is off — the owner owns a schema it may create functions in, and without the barrier one of them can be evaluated in a WHERE clause before the shadow filter discards the row (ADR-0016)",
      });
    }
  }
  return violations;
}

/**
 * The functions the owner may run over tables it holds nothing on, each
 * pinned by everything that decides what it does.
 *
 * `CREATE OR REPLACE FUNCTION` keeps the name, the argument types, the
 * `SECURITY DEFINER` marking and the whole ACL while replacing the body —
 * so a signature the audit recognises says nothing at all. The body, the
 * definer marking and the pinned `search_path` are the promise: a definer
 * function that resolves names through the caller's path is the classic
 * escalation, and one whose body changed is simply a different function
 * wearing the same grant.
 *
 * It loops over `OWNER_DEFINER_FUNCTION_BODIES` rather than naming one
 * function (#129): the owner's merge-resolved timeline needs a second
 * definer function, and an audit written around a single name is how the
 * second one arrives unpinned.
 */
async function auditOwnerCallableFunctions(
  client: pg.ClientBase,
): Promise<GrantViolation[]> {
  const violations: GrantViolation[] = [];
  for (const [signature, body] of Object.entries(
    OWNER_DEFINER_FUNCTION_BODIES,
  )) {
    // RESOLVED BY SIGNATURE, NOT BY NAME (Codex r1). PostgreSQL permits
    // overloads, so `WHERE proname = 'resolve_entity_for_declared_company'`
    // can return a second function nobody granted anything on — and a check
    // that trusts the first row it gets can end up comparing the pinned
    // body against a different function's. `to_regprocedure` resolves the
    // exact argument types or yields NULL, which is the "it does not exist"
    // violation below rather than an error.
    const rows = await client.query<{
      body: string;
      is_definer: boolean;
      config: string[] | null;
    }>(
      `SELECT p.prosrc AS body, p.prosecdef AS is_definer, p.proconfig AS config
         FROM pg_proc p
        WHERE p.oid = to_regprocedure($1)`,
      [signature],
    );
    const subject = `function:${signature}`;
    if (rows.rows.length === 0) {
      violations.push({
        subject,
        reason:
          "an owner-callable definer function does not exist — the timeline read follows standing merge edges through these two, and a missing one is an owner surface that fails on a privilege rather than on anything about the question (ADR-0035, spec #126 decision 15)",
      });
      continue;
    }
    const fn = rows.rows[0]!;
    if (normalizeSql(fn.body) !== normalizeSql(body)) {
      violations.push({
        subject,
        reason:
          "its body is not the pinned one — it runs with the definer's reach over every company's merge graph, so a body that stopped taking its company from the connection is a cross-tenant read behind an unchanged grant",
      });
    }
    if (!fn.is_definer) {
      violations.push({
        subject,
        reason:
          "it is no longer SECURITY DEFINER — it would then run with the owner's own rights over merge tables the owner holds nothing on, and fail on a privilege instead of resolving",
      });
    }
    const config = fn.config ?? [];
    if (config.length !== 1 || config[0] !== "search_path=pg_catalog") {
      violations.push({
        subject,
        reason: `its search_path is ${config.length === 0 ? "unpinned" : config.join(", ")} rather than pg_catalog — a SECURITY DEFINER function that resolves names through the caller's path is the escalation the pin exists to prevent`,
      });
    }
  }
  return violations;
}

/**
 * WHO ELSE HOLDS ANYTHING on an owner-visible view or an owner-callable
 * function, read off the objects' own ACLs.
 *
 * Everything else in this file asks what `dito_owner` can reach. This asks
 * the question that makes those answers worth having: a login granted
 * SELECT on `ledger.finalized_facts` and EXECUTE on `declared_company()`
 * declares whatever company it likes and reads that tenant through the same
 * definer view, with `dito_owner`'s own reach unchanged and every other
 * claim still true.
 *
 * PUBLIC is rejected on sight, and so is a grant carrying GRANT OPTION: a
 * grantee that can pass the privilege on makes the allowlist a snapshot
 * rather than a rule.
 */
async function auditOwnerObjectGrantees(
  client: pg.ClientBase,
): Promise<GrantViolation[]> {
  const violations: GrantViolation[] = [];
  const rows = await client.query<{
    qualified: string;
    grantee: string;
    privilege: string;
    grantable: boolean;
    is_owner: boolean;
  }>(
    `WITH objects AS (
       SELECT n.nspname || '.' || c.relname AS qualified, c.relacl AS acl,
              c.relowner AS owner_oid
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname || '.' || c.relname = ANY($1::text[])
       UNION ALL
       SELECT n.nspname || '.' || p.proname || '(' ||
                pg_catalog.oidvectortypes(p.proargtypes) || ')' AS qualified,
              p.proacl AS acl, p.proowner AS owner_oid
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname || '.' || p.proname || '(' ||
                pg_catalog.oidvectortypes(p.proargtypes) || ')' = ANY($1::text[])
     )
     SELECT o.qualified,
            CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
                 ELSE acl.grantee::regrole::text END AS grantee,
            acl.privilege_type AS privilege,
            acl.is_grantable AS grantable,
            acl.grantee = o.owner_oid AS is_owner
       FROM objects o
       CROSS JOIN LATERAL aclexplode(o.acl) AS acl
      ORDER BY 1, 2, 3`,
    [Object.keys(OWNER_OBJECT_GRANTEES).map((k) => k.replace(/,\s+/g, ","))],
  );

  for (const row of rows.rows) {
    if (row.is_owner) continue;
    const allowed = OWNER_OBJECT_GRANTEES[row.qualified] ?? [];
    if (!allowed.includes(row.grantee)) {
      violations.push({
        subject: `grant:${row.qualified}`,
        reason: `${row.grantee} holds ${row.privilege} on an owner-visible object nobody declared it on — an owner view and the function under its policy are all a principal needs to declare any company and read that tenant (ADR-0002)`,
      });
      continue;
    }
    if (row.privilege !== "SELECT" && row.privilege !== "EXECUTE") {
      violations.push({
        subject: `grant:${row.qualified}`,
        reason: `${row.grantee} holds ${row.privilege} on an owner-visible object — these objects are read, and nothing else`,
      });
    }
    if (row.grantable) {
      violations.push({
        subject: `grant:${row.qualified}`,
        reason: `${row.grantee}'s privilege carries GRANT OPTION — a grantee that can pass it on turns this list from a rule into a snapshot`,
      });
    }
  }
  return violations;
}

/**
 * THE REP-WEB CLAUSE — claim 10 (ticket #221; spec #214 *Roles and grants*;
 * ADR-0002, ADR-0006, ADR-0008, ADR-0010).
 *
 * rep-web holds no key, so everything sealed or bundle-resident reaches it
 * through the runtime's local API and never through a store (ADR-0010:
 * "dashboards are clients of that service's authenticated API"). That
 * sentence is a claim about GRANTS or it is a claim about nothing, so this
 * asks the catalog the same four questions the owner's half asks, in the same
 * shape and for the same reasons:
 *
 *   every RELATION it can reach, table-wide or one column at a time, diffed
 *   against `REP_WEB_REACH` and `REP_WEB_COLUMN_REACH` in both directions —
 *   which is what makes a planted `GRANT SELECT (content_enc) ON drafts` and
 *   a planted `GRANT SELECT ON twin_keys` each a violation with a name;
 *
 *   every SEQUENCE, where the honest claim is zero: `last_value` is an exact
 *   running count of the table it numbers, so a sequence privilege is the
 *   activity signal with the table taken away (ticket #165's finding, one
 *   role over);
 *
 *   every FUNCTION outside `public`, which is exactly one and is the one
 *   PostgreSQL forces on a role its policies bind;
 *
 *   and every POLICY that scopes what it reads, pinned to the same
 *   `LEDGER_COMPANY_POLICY` expression the owner's are, in both directions —
 *   so a relation rep-web can read with no company policy over it is a
 *   violation, and a policy saying something else is too.
 *
 * IT DOES NOT SWEEP `ledger` SEPARATELY, and needs no arm for it: a `ledger`
 * relation is a relation, so the reach sweep below covers every one of them
 * and `REP_WEB_REACH` names none.
 */
async function auditRepWebReach(
  client: pg.ClientBase,
): Promise<GrantViolation[]> {
  const violations: GrantViolation[] = [];
  const pinned = REP_WEB_REACH;
  const columnPinned = REP_WEB_COLUMN_REACH;

  const reachable = await client.query<{
    qualified: string;
    relkind: string;
    privilege: string;
    whole_relation: boolean;
  }>(
    `SELECT n.nspname || '.' || c.relname AS qualified, c.relkind, p.privilege,
            has_table_privilege($1, c.oid, p.privilege) AS whole_relation
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE',
                               'TRUNCATE', 'REFERENCES', 'TRIGGER'])
                  AS p(privilege)
      WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
        AND n.nspname NOT LIKE 'pg\\_%'
        AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
        AND (
          has_table_privilege($1, c.oid, p.privilege)
          -- CASE, not OR, for auditOwnerRelationReach's reason:
          -- has_any_column_privilege raises on the three privileges a column
          -- cannot carry, and a planner free to evaluate either side first
          -- would raise on a row the table-level probe had already answered.
          OR CASE
               WHEN p.privilege IN ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES')
               THEN has_any_column_privilege($1, c.oid, p.privilege)
               ELSE false
             END
        )
      ORDER BY 1, 3`,
    [REP_WEB_ROLE],
  );

  for (const row of reachable.rows) {
    const wholeAllowed = pinned[row.qualified] ?? [];
    const columns = columnPinned[row.qualified]?.[row.privilege];
    if (wholeAllowed.includes(row.privilege) && row.whole_relation) continue;
    if (columns !== undefined && !row.whole_relation) continue;
    // A COLUMN-LEVEL PRIVILEGE WHERE THE WHOLE RELATION WAS PINNED, or a
    // table-wide one where only some columns were. Both are the pin and the
    // catalog disagreeing about the SHAPE of the grant rather than about its
    // existence, and the second is the one that leaks: a table-wide SELECT on
    // `drafts` hands over `content_enc`.
    if (columns !== undefined && row.whole_relation) {
      violations.push({
        subject: `table:${row.qualified}`,
        reason: `${REP_WEB_ROLE} holds ${row.privilege} on the whole relation where only ${columns.join(", ")} are pinned — a table-wide SELECT on this table hands rep-web the sealed columns the runtime's local API exists to serve instead (ADR-0008, ADR-0010)`,
      });
      continue;
    }
    if (wholeAllowed.includes(row.privilege)) {
      violations.push({
        subject: `table:${row.qualified}`,
        reason: `${REP_WEB_ROLE} holds ${row.privilege} on some columns of it and not on the relation — the pinned grant is the whole relation, and a column subset is a page that renders part of itself and fails on the rest`,
      });
      continue;
    }
    violations.push({
      subject: `${row.relkind === "v" || row.relkind === "m" ? "view" : "table"}:${row.qualified}`,
      reason: `${REP_WEB_ROLE} holds ${row.privilege} — rep-web holds no key and reads plaintext seam rows only: everything sealed or bundle-resident is served by the twin runtime's local API, because the lease holder is the only process that may unseal (ADR-0008, ADR-0010; spec #214 *Roles and grants*)`,
    });
  }

  // ...AND THE OTHER DIRECTION. A pinned privilege the migration forgot is a
  // page that fails on a privilege rather than on anything about the question
  // — which for the login is a rep who cannot get in.
  for (const [qualified, privileges] of Object.entries(pinned)) {
    for (const privilege of privileges) {
      if (
        !reachable.rows.some(
          (r) =>
            r.qualified === qualified &&
            r.privilege === privilege &&
            r.whole_relation,
        )
      ) {
        violations.push({
          subject: `table:${qualified}`,
          reason: `${REP_WEB_ROLE} cannot ${privilege} it — the dashboard's whole reach is this list, and a missing privilege is a page that fails on a grant`,
        });
      }
    }
  }

  violations.push(...(await auditRepWebColumns(client)));
  violations.push(...(await auditRepWebSequenceReach(client)));
  violations.push(...(await auditRepWebFunctionReach(client)));
  violations.push(...(await auditRepWebPolicies(client)));
  return violations;
}

/**
 * The columns of the one relation rep-web reaches column by column, diffed
 * both ways.
 *
 * `has_table_privilege` DOES NOT REPORT COLUMN GRANTS, which is the blind
 * spot this covers — the same one `auditAnnotationColumns` covers on the
 * aperture's side. Probing only the names we expect can never catch a column
 * nobody wrote down, so the catalog's own list is read and compared against
 * the pin: `content_enc` appearing here is the violation this exists for.
 */
async function auditRepWebColumns(
  client: pg.ClientBase,
): Promise<GrantViolation[]> {
  const violations: GrantViolation[] = [];
  for (const [qualified, byPrivilege] of Object.entries(REP_WEB_COLUMN_REACH)) {
    for (const [privilege, expected] of Object.entries(byPrivilege)) {
      const held = await client.query<{ attname: string }>(
        `SELECT a.attname
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
           JOIN pg_attribute a ON a.attrelid = c.oid
          WHERE n.nspname || '.' || c.relname = $1
            AND a.attnum > 0 AND NOT a.attisdropped
            AND has_column_privilege($2, c.oid, a.attnum, $3)
          ORDER BY a.attname`,
        [qualified, REP_WEB_ROLE, privilege],
      );
      const found = held.rows.map((r) => r.attname);
      for (const column of found) {
        if (expected.includes(column)) continue;
        violations.push({
          subject: `column:${qualified}.${column}`,
          reason: `${REP_WEB_ROLE} can ${privilege} a column nobody pinned — the sealed columns of this table are the ones the runtime's local API serves, and a column-level grant is how a table-wide read arrives one column at a time (ADR-0008, ADR-0010)`,
        });
      }
      for (const column of expected) {
        if (found.includes(column)) continue;
        violations.push({
          subject: `column:${qualified}.${column}`,
          reason: `${REP_WEB_ROLE} cannot ${privilege} a column the card's state needs — the pin and the grant are one statement written twice, and this half has gone`,
        });
      }
    }
  }
  return violations;
}

/**
 * Every sequence rep-web can reach, where the honest claim is ZERO.
 *
 * `auditOwnerSequenceReach`'s finding, one role over: a sequence's
 * `last_value` is an exact running count of the table it numbers, pollable to
 * time what a twin did, and `has_table_privilege` knows nothing about
 * sequences — so `GRANT SELECT ON SEQUENCE public.audit_chain_id_seq TO
 * dito_rep_web` would leave the sweep above green. Every column rep-web
 * inserts into is either a uuid it supplies or `GENERATED ALWAYS AS
 * IDENTITY`, which the system allocates with no privilege check, so nothing
 * it does needs one.
 */
async function auditRepWebSequenceReach(
  client: pg.ClientBase,
): Promise<GrantViolation[]> {
  const violations: GrantViolation[] = [];
  const reachable = await client.query<{
    qualified: string;
    privilege: string;
  }>(
    `SELECT n.nspname || '.' || c.relname AS qualified, p.privilege
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       CROSS JOIN unnest(ARRAY['USAGE', 'SELECT', 'UPDATE']) AS p(privilege)
      WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
        AND n.nspname NOT LIKE 'pg\\_%'
        AND c.relkind = 'S'
        AND has_sequence_privilege($1, c.oid, p.privilege)
      ORDER BY 1, 2`,
    [REP_WEB_ROLE],
  );
  for (const row of reachable.rows) {
    violations.push({
      subject: `sequence:${row.qualified}`,
      reason: `${REP_WEB_ROLE} holds ${row.privilege} on a sequence — \`last_value\` is an exact running count of the table it numbers and row-level security does not reach a sequence, so this is a rep-activity signal with the table taken away. Every id rep-web writes is a uuid or an identity column, which needs no sequence privilege at all (the decision on #157, one role over)`,
    });
  }
  return violations;
}

/**
 * Every function rep-web can call, and the claim is `auditOwnerFunctionReach`'s
 * word for word because the reasoning is identical.
 *
 * Inside `ledger` it is EXACTLY the named list, and PUBLIC may execute
 * nothing — a Ledger function a login may run is a read of tables it may not.
 *
 * Outside `ledger` the honest claim is about SECURITY DEFINER. Every function
 * in `public` and in `owner` is PUBLIC-executable by PostgreSQL's default and
 * rep-web is a member of PUBLIC, so demanding it can call none of them would
 * mean revoking EXECUTE across two schemas full of trigger functions for no
 * gain: an ordinary function runs with the CALLER's rights, so calling one
 * buys rep-web exactly the privileges it already has. A `SECURITY DEFINER`
 * function lends its definer's reach to whoever may call it, and that is the
 * whole risk — so that is what is checked.
 */
async function auditRepWebFunctionReach(
  client: pg.ClientBase,
): Promise<GrantViolation[]> {
  const violations: GrantViolation[] = [];
  const allowed = REP_WEB_EXECUTABLE_FUNCTIONS as readonly string[];
  const functions = await client.query<{
    qualified: string;
    schema_name: string;
    is_definer: boolean;
    may_execute: boolean;
  }>(
    `SELECT n.nspname || '.' || p.proname || '(' ||
              pg_catalog.oidvectortypes(p.proargtypes) || ')' AS qualified,
            n.nspname AS schema_name,
            p.prosecdef AS is_definer,
            has_function_privilege($1, p.oid, 'EXECUTE') AS may_execute
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
        AND n.nspname NOT LIKE 'pg\\_%'
      ORDER BY 1`,
    [REP_WEB_ROLE],
  );
  const executable = new Set<string>();
  for (const row of functions.rows) {
    const normalized = row.qualified.replace(/,\s+/g, ",");
    const named = allowed.includes(normalized);
    if (named && row.may_execute) executable.add(normalized);
    if (row.schema_name === "ledger") {
      if (row.may_execute && !named) {
        violations.push({
          subject: `function:${normalized}`,
          reason: `${REP_WEB_ROLE} may execute it — rep-web calls exactly ${allowed.join(" and ")} in this schema and nothing else, because a Ledger function it may run is a read of tables it may not (claim 10)`,
        });
      }
    } else if (row.is_definer && row.may_execute && !named) {
      violations.push({
        subject: `function:${normalized}`,
        reason: `${REP_WEB_ROLE} may execute a SECURITY DEFINER function — it runs with its definer's privileges, so a login that can call one holds whatever the definer holds, and this login is meant to hold plaintext seam reads and nothing sealed (ADR-0002, ADR-0008)`,
      });
    }
  }
  for (const signature of allowed) {
    if (executable.has(signature)) continue;
    violations.push({
      subject: `function:${signature}`,
      reason: `${REP_WEB_ROLE} may not execute it — a policy expression's function privileges are checked against the session's role, so every scoped read fails on \`permission denied for function\` rather than on anything about the read`,
    });
  }
  violations.push(...(await auditRepWebSystemReach(client)));
  return violations;
}

/**
 * ...AND THE SYSTEM CATALOGS, which the two sweeps above deliberately skip
 * and which hold the sharpest holes in them (Codex r1 and r2).
 *
 * WHAT IT CLOSES, stated as the three statements that exploit it:
 *
 *     GRANT EXECUTE ON FUNCTION pg_catalog.pg_read_binary_file(text)
 *       TO dito_rep_web;                             -- the direct route
 *     GRANT EXECUTE ON FUNCTION pg_catalog.pg_read_binary_file(text)
 *       TO PUBLIC;                                   -- the wider route
 *     GRANT SELECT ON pg_catalog.pg_statistic TO dito_rep_web;
 *
 * None of the three changes an application-table grant, a column grant, a
 * policy or a role membership, so every other arm of claim 10 stays green.
 * The first two hand rep-web a FILE READER, and a file reader reads the bytes
 * under `twin_keys` and under every `ledger` table without holding any
 * privilege on them. The third hands it `pg_statistic`, which after an
 * ANALYZE holds SAMPLED VALUES from the columns it may not read — the
 * counterparty names in `disclosure_lines`, a rep's address on `seats` —
 * which is exactly why PostgreSQL ships that catalog restricted.
 *
 * ═══ TWO CLAIMS, AND THE FIRST IS THE GENERAL ONE
 *
 * RULE A: NO ACL ENTRY IN A SYSTEM SCHEMA NAMES THIS ROLE. Exact, list-free
 * and permanent — `relacl` and `proacl` are the grants somebody WROTE, and
 * `aclexplode` names their grantee, so a direct grant on any system relation
 * or function is a violation whatever the object is and whatever a later
 * PostgreSQL adds. A NULL ACL is the shipped default and names nobody.
 *
 * It has to be about the ACL rather than about reachability, and that is
 * worth saying because the obvious check is impossible: rep-web can already
 * touch 189 system relations, because PostgreSQL makes its ordinary catalog
 * views world-readable. "Holds no privilege on a system relation" is not a
 * claim anybody can make; "was granted nothing on one" is.
 *
 * RULE B: AND THE OBJECTS THAT DEFEAT TABLE PRIVILEGES ARE UNREACHABLE BY
 * ANY ROUTE. Rule A cannot see a widening to PUBLIC — that is a cluster-wide
 * misconfiguration rather than a grant naming this role, and telling one
 * apart from PostgreSQL's own default needs a trusted baseline of initdb's
 * ACLs that this audit has no way to synthesize. So for the handful of
 * objects whose CONTENTS defeat the privileges on other objects, the claim is
 * reachability itself: rep-web must not be able to execute a file reader or
 * read `pg_statistic`, `pg_statistic_ext_data` or `pg_authid`, however it
 * came to be able to.
 *
 * `REP_WEB_FORBIDDEN_BUILTINS` IS A ROSTER AND WILL GO STALE — the release
 * that adds the next file reader will not add it here. That is the honest
 * cost of covering the PUBLIC route at all, it is bounded (rule A still
 * catches every direct grant on the new one), and the remedy is recorded on
 * #221 rather than pretended away.
 */
async function auditRepWebSystemReach(
  client: pg.ClientBase,
): Promise<GrantViolation[]> {
  const violations: GrantViolation[] = [];

  // RULE A, over relations and functions in one query each: the grants
  // somebody wrote, by grantee, rather than the privileges anybody holds.
  const relationGrants = await client.query<{
    qualified: string;
    privilege: string;
  }>(
    `SELECT n.nspname || '.' || c.relname AS qualified, a.privilege_type AS privilege
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace,
            LATERAL aclexplode(c.relacl) a
      WHERE n.nspname IN ('pg_catalog', 'information_schema')
        AND a.grantee = $1::regrole::oid
      ORDER BY 1, 2`,
    [REP_WEB_ROLE],
  );
  for (const row of relationGrants.rows) {
    violations.push({
      subject: `table:${row.qualified}`,
      reason: `${REP_WEB_ROLE} was granted ${row.privilege} on a system relation — somebody wrote that grant, and a catalog like \`pg_statistic\` holds sampled VALUES from the columns this role may not read (ADR-0002, ADR-0008; claim 10)`,
    });
  }

  const functionGrants = await client.query<{
    qualified: string;
    privilege: string;
  }>(
    `SELECT n.nspname || '.' || p.proname || '(' ||
              pg_catalog.oidvectortypes(p.proargtypes) || ')' AS qualified,
            a.privilege_type AS privilege
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace,
            LATERAL aclexplode(p.proacl) a
      WHERE n.nspname IN ('pg_catalog', 'information_schema')
        AND a.grantee = $1::regrole::oid
      ORDER BY 1, 2`,
    [REP_WEB_ROLE],
  );
  for (const row of functionGrants.rows) {
    violations.push({
      subject: `function:${row.qualified}`,
      reason: `${REP_WEB_ROLE} was granted ${row.privilege} on a system function — somebody wrote that grant, and a file reader among them reads the bytes under \`twin_keys\` and under every Ledger table with no privilege on either (ADR-0002, ADR-0008; claim 10)`,
    });
  }

  // RULE B: the objects whose contents defeat other objects' privileges,
  // asked as REACHABILITY so a widening to PUBLIC is caught too.
  const reachable = await client.query<{ kind: string; qualified: string }>(
    `SELECT 'function' AS kind,
            n.nspname || '.' || p.proname AS qualified
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'pg_catalog'
        AND p.proname = ANY($2::text[])
        AND has_function_privilege($1, p.oid, 'EXECUTE')
      UNION ALL
     SELECT 'table' AS kind,
            n.nspname || '.' || c.relname AS qualified
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'pg_catalog'
        AND c.relname = ANY($3::text[])
        AND has_table_privilege($1, c.oid, 'SELECT')
      ORDER BY 1, 2`,
    [
      REP_WEB_ROLE,
      REP_WEB_FORBIDDEN_BUILTINS,
      REP_WEB_FORBIDDEN_CATALOGS,
    ],
  );
  for (const row of reachable.rows) {
    violations.push({
      subject: `${row.kind}:${row.qualified}`,
      reason: `${REP_WEB_ROLE} can reach it, by a grant to itself or by one to PUBLIC — this is one of the objects whose CONTENTS defeat the privileges on other objects, so reaching it reaches the bytes under \`twin_keys\` and the sampled values of columns this role may not read (ADR-0002, ADR-0008; claim 10)`,
    });
  }
  return violations;
}

/**
 * What each policy that scopes a rep-web read actually SAYS, both ways.
 *
 * `auditCompanyPolicies`' shape, for the role that authenticates rather than
 * the role the owner's views run as — and it has to be a second arm rather
 * than a widening of that one, because the two roles' policies differ in the
 * command they cover: rep-web WRITES its own stores, so theirs are `FOR ALL`
 * and the owner's are `FOR SELECT`. `REP_WEB_COMPANY_POLICIES` is where each
 * relation says which it owes.
 *
 * ONE COMMAND PER RELATION, WHICH IS A CONSTRAINT ON THE MIGRATIONS TOO. The
 * comparison below is `polcmd` against that one word, so a relation carrying
 * two policies for rep-web — one `FOR SELECT`, one `FOR UPDATE` — would report
 * the first as a mismatch. That is why every relation rep-web writes carries
 * one `FOR ALL` policy and lets the GRANT withhold the commands it may not
 * perform (ticket #223 widened `seats` for exactly this reason).
 *
 * ENABLED AND FORCED IS CHECKED HERE TOO, for the tables the rep side creates:
 * `auditRowLevelSecurity` enumerates the `ledger` tables and the two
 * registries, and `sessions`, `login_codes`, `invitations` and
 * `acknowledgments` are none of those.
 */
async function auditRepWebPolicies(
  client: pg.ClientBase,
): Promise<GrantViolation[]> {
  const violations: GrantViolation[] = [];
  const relations = Object.keys(REP_WEB_COMPANY_POLICIES);

  const switches = await client.query<{
    qualified: string;
    enabled: boolean;
    forced: boolean;
  }>(
    `SELECT n.nspname || '.' || c.relname AS qualified,
            c.relrowsecurity AS enabled,
            c.relforcerowsecurity AS forced
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname || '.' || c.relname = ANY($1::text[])
        AND c.relkind IN ('r', 'p')`,
    [relations],
  );
  const live = new Map(switches.rows.map((r) => [r.qualified, r]));
  for (const qualified of relations) {
    const row = live.get(qualified);
    if (row === undefined) {
      violations.push({
        subject: `table:${qualified}`,
        reason: `the table rep-web's company scoping is claimed for does not exist — a login store the dashboard reads is not optional (ticket #221)`,
      });
      continue;
    }
    if (!row.enabled || !row.forced) {
      violations.push({
        subject: `table:${qualified}`,
        reason: `row-level security is ${row.enabled ? "not FORCED" : "not ENABLED"} — rep-web authenticates as its own role and its tenancy is a per-connection setting, so a cross-company read must return nothing even with a missing WHERE clause (ADR-0002)`,
      });
    }
  }

  const policies = await client.query<{
    qualified: string;
    policy_name: string;
    command: string;
    binds_rep_web: boolean;
    binds_public: boolean;
    qualifier: string | null;
    with_check: string | null;
  }>(
    `SELECT n.nspname || '.' || c.relname AS qualified,
            p.polname AS policy_name,
            p.polcmd AS command,
            $2::regrole::oid = ANY(p.polroles) AS binds_rep_web,
            0 = ANY(p.polroles) AS binds_public,
            pg_get_expr(p.polqual, p.polrelid) AS qualifier,
            pg_get_expr(p.polwithcheck, p.polrelid) AS with_check
       FROM pg_policy p
       JOIN pg_class c ON c.oid = p.polrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname || '.' || c.relname = ANY($1::text[])
      ORDER BY 1, 2`,
    [relations, REP_WEB_ROLE],
  );

  const scoped = new Set<string>();
  for (const row of policies.rows) {
    if (row.binds_public) {
      violations.push({
        subject: `policy:${row.qualified}.${row.policy_name}`,
        reason:
          "a policy on a login store binds PUBLIC — every role is in PUBLIC, so this hands the rows to rep-web by a route no grant and no per-role policy shows",
      });
    }
    if (!row.binds_rep_web) continue;
    const owed = REP_WEB_COMPANY_POLICIES[row.qualified];
    if (row.command !== owed) {
      violations.push({
        subject: `policy:${row.qualified}.${row.policy_name}`,
        reason: `binds ${REP_WEB_ROLE} for command \`${row.command}\` rather than \`${owed ?? "nothing"}\` — a write policy where only a read was owed is a writer nobody declared, and a read policy where a write was owed is a login that fails on the policy (ticket #221)`,
      });
      continue;
    }
    if (row.qualifier !== LEDGER_COMPANY_POLICY) {
      violations.push({
        subject: `policy:${row.qualified}.${row.policy_name}`,
        reason: `the company policy reads \`${row.qualifier ?? "nothing"}\` rather than \`${LEDGER_COMPANY_POLICY}\` — ENABLED and FORCED are claims about the switch, and this is the claim about the rule (ADR-0002)`,
      });
      continue;
    }
    // A `FOR ALL` POLICY OWES A `WITH CHECK` THAT SAYS THE SAME THING.
    // PostgreSQL falls back to the qualifier when none is written, which is
    // the safe default — so this is not about the default but about a policy
    // that writes one and makes it wider: `WITH CHECK (true)` on `sessions`
    // is a deployment writing another company's session rows.
    if (owed === "*" && row.with_check !== LEDGER_COMPANY_POLICY) {
      violations.push({
        subject: `policy:${row.qualified}.${row.policy_name}`,
        reason: `its WITH CHECK reads \`${row.with_check ?? "nothing"}\` rather than \`${LEDGER_COMPANY_POLICY}\` — the qualifier decides which rows rep-web READS and this decides which rows it may WRITE, and a wider one lets a deployment insert into another company's login store`,
      });
      continue;
    }
    scoped.add(row.qualified);
  }
  for (const qualified of relations) {
    if (scoped.has(qualified)) continue;
    violations.push({
      subject: `table:${qualified}`,
      reason: `${REP_WEB_ROLE} can reach it and no company policy scopes that reach — tenancy is a credential (spec #214: "the company id in the environment"), and the policy is what makes the credential mean something (ADR-0002)`,
    });
  }
  return violations;
}

/**
 * Row-level security on every shared table, AND the policy that makes it
 * mean something (claim 9; ADR-0002).
 *
 * The `ledger` tables come from the catalog, not from a list here, so a
 * table a later migration adds is covered the day it lands rather than the
 * day somebody remembers. The registries are named, because they are the
 * only two `public` tables that carry a company on the row and are read
 * through an owner-visible view.
 *
 * FORCED as well as ENABLED: an unforced policy stops applying to the
 * table's own owner, and "the owner is a superuser so it never applied
 * anyway" is true today and is exactly the assumption that will be quietly
 * false the first time a deployment stops running migrations as one.
 *
 * AND THE POLICY'S OWN TEXT IS PINNED, because ENABLED + FORCED is a claim
 * about the switch and not about the rule. A later migration writing
 * `CREATE POLICY … TO dito_ledger_views USING (true)` would leave every
 * table enabled, every table forced, every grant unchanged — and every
 * company readable by every owner. So: every policy that binds the role the
 * owner's views run as must be a SELECT policy whose qualifier is exactly
 * `LEDGER_COMPANY_POLICY`, every relation that role can SELECT must have
 * one, and no policy on these tables may bind PUBLIC — which would hand the
 * same rows to the same role by a route the first two checks never look at.
 * Extracting `ledger.declared_company()` in …100040 is what makes the
 * qualifier short enough to pin at all.
 */
async function auditRowLevelSecurity(
  client: pg.ClientBase,
  ledgerTables: readonly string[],
): Promise<GrantViolation[]> {
  const violations: GrantViolation[] = [];
  const expected = [...ledgerTables, ...REGISTRY_TABLES];
  const rows = await client.query<{
    qualified: string;
    enabled: boolean;
    forced: boolean;
  }>(
    `SELECT n.nspname || '.' || c.relname AS qualified,
            c.relrowsecurity AS enabled,
            c.relforcerowsecurity AS forced
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname || '.' || c.relname = ANY($1::text[])
        AND c.relkind IN ('r', 'p')`,
    [expected],
  );
  const live = new Map(rows.rows.map((r) => [r.qualified, r]));
  for (const qualified of expected) {
    const row = live.get(qualified);
    if (row === undefined) {
      violations.push({
        subject: `table:${qualified}`,
        reason:
          "the table row-level security is claimed for does not exist — a registry the owner's views read is not optional (ticket #127)",
      });
      continue;
    }
    if (!row.enabled) {
      violations.push({
        subject: `table:${qualified}`,
        reason:
          "row-level security is not ENABLED — every shared table carries company_id under Postgres RLS (ADR-0002), and a cross-company read must return nothing even with a missing WHERE clause",
      });
    }
    if (!row.forced) {
      violations.push({
        subject: `table:${qualified}`,
        reason:
          "row-level security is not FORCED — an unforced policy stops applying to the table's own owner, which is where the next reader will connect from",
      });
    }
  }

  violations.push(...(await auditCompanyPolicies(client, expected)));
  return violations;
}

/**
 * What each policy on a shared table actually SAYS, for the role the
 * owner's views run as.
 *
 * Read off `pg_policy` and compared against one pinned string, in the shape
 * `LEDGER_ANNOTATION_COLUMNS` established: both directions, so a policy
 * saying something else and a relation the role can read with no policy at
 * all are each a violation.
 */
async function auditCompanyPolicies(
  client: pg.ClientBase,
  relations: readonly string[],
): Promise<GrantViolation[]> {
  const violations: GrantViolation[] = [];
  const policies = await client.query<{
    qualified: string;
    policy_name: string;
    command: string;
    binds_views_role: boolean;
    binds_public: boolean;
    qualifier: string | null;
  }>(
    `SELECT n.nspname || '.' || c.relname AS qualified,
            p.polname AS policy_name,
            p.polcmd AS command,
            -- polroles is the OID list the policy applies to; 0 is PUBLIC.
            $2::regrole::oid = ANY(p.polroles) AS binds_views_role,
            0 = ANY(p.polroles) AS binds_public,
            pg_get_expr(p.polqual, p.polrelid) AS qualifier
       FROM pg_policy p
       JOIN pg_class c ON c.oid = p.polrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname || '.' || c.relname = ANY($1::text[])
      ORDER BY 1, 2`,
    [relations, LEDGER_VIEWS_ROLE],
  );

  const scoped = new Set<string>();
  for (const row of policies.rows) {
    if (row.binds_public) {
      violations.push({
        subject: `policy:${row.qualified}.${row.policy_name}`,
        reason:
          "a policy on a shared table binds PUBLIC — every role is in PUBLIC, so this hands the rows to the owner's views by a route no grant and no per-role policy shows",
      });
    }
    if (!row.binds_views_role) continue;
    // 'r' is SELECT. The role the views run as reads and never writes, so
    // any other command on a policy naming it is a privilege being prepared
    // for that nothing should ever use.
    if (row.command !== "r") {
      violations.push({
        subject: `policy:${row.qualified}.${row.policy_name}`,
        reason: `binds ${LEDGER_VIEWS_ROLE} for a command other than SELECT — the role the owner's views run as reads, and a write policy is a writer nobody declared (ADR-0003)`,
      });
      continue;
    }
    if (row.qualifier !== LEDGER_COMPANY_POLICY) {
      violations.push({
        subject: `policy:${row.qualified}.${row.policy_name}`,
        reason: `the company policy reads \`${row.qualifier ?? "nothing"}\` rather than \`${LEDGER_COMPANY_POLICY}\` — ENABLED and FORCED are claims about the switch, and this is the claim about the rule (ADR-0002)`,
      });
      continue;
    }
    scoped.add(row.qualified);
  }

  // ...and the other direction: a relation the views role can SELECT with
  // no company policy over it returns NOTHING (RLS with no matching policy
  // denies), so this arm catches the owner surface that silently renders an
  // empty page rather than the one that leaks.
  const readable = await client.query<{ qualified: string }>(
    `SELECT n.nspname || '.' || c.relname AS qualified
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname || '.' || c.relname = ANY($1::text[])
        AND has_table_privilege($2, c.oid, 'SELECT')`,
    [relations, LEDGER_VIEWS_ROLE],
  );
  for (const { qualified } of readable.rows) {
    if (!scoped.has(qualified)) {
      violations.push({
        subject: `table:${qualified}`,
        reason: `${LEDGER_VIEWS_ROLE} can SELECT it and no company policy scopes that read — a table the owner's views read owes the policy that keeps the read inside one company (ADR-0002)`,
      });
    }
  }
  return violations;
}

/**
 * Script entry (the reconcileFr70At pattern): audits the database at
 * `databaseUrl`, constructing its own client so callers stay
 * dependency-free.
 */
export async function auditLedgerGrantsAt(
  databaseUrl: string,
): Promise<LedgerGrantsReport> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    return await auditLedgerGrants(client);
  } finally {
    await client.end();
  }
}

/**
 * What the rep dashboard's grant check found (ticket #263).
 *
 * `relations` IS WHAT THE PIN ALLOWS, table-wide and column by column, so a
 * run prints the reach it checked rather than only a count of what was wrong.
 */
export interface RepWebGrantsReport {
  /** Whether `dito_rep_web` exists at all — absent, nothing was checked. */
  readonly present: boolean;
  readonly relations: readonly string[];
  readonly violations: readonly GrantViolation[];
}

/**
 * THE FIRST CLIENT INVARIANT, ON ITS OWN: rep-web holds no key and reaches
 * nothing twin-side except through the runtime (ticket #263; spec #258
 * decision 5, which keeps it as a test).
 *
 * IT IS CLAIM 10, and it is the same code the Ledger audit runs rather than a
 * second list: every relation, column, sequence, function, policy and system
 * catalog `dito_rep_web` can reach, diffed against `REP_WEB_REACH` and
 * `REP_WEB_COLUMN_REACH` in both directions. What it adds is its own entry and
 * its own verdict, so the dashboard's wall is a check with a name in CI rather
 * than one clause among ten — and it refuses to pass over a database where the
 * role was never created, since a catalog check over an absent principal
 * checks nothing.
 *
 * «TWIN-SIDE» IS EVERYTHING SEALED OR BUNDLE-RESIDENT, and the pin is what
 * makes that a statement about grants: the posts, the notices, the door's
 * messages, the key table, the chains and the Ledger are all absent from it,
 * so a grant on any of them is a violation with its table's name — while the
 * plaintext seam rows rep-web does need (its own login stores, the send it
 * writes itself under ADR-0006, the rail's status columns) are the list.
 */
export async function auditRepWebGrants(
  client: pg.ClientBase,
): Promise<RepWebGrantsReport> {
  const relations = [
    ...Object.keys(REP_WEB_REACH),
    ...Object.keys(REP_WEB_COLUMN_REACH).filter(
      (qualified) => REP_WEB_REACH[qualified] === undefined,
    ),
  ].sort();
  const role = await client.query(
    "SELECT 1 FROM pg_roles WHERE rolname = $1",
    [REP_WEB_ROLE],
  );
  if (role.rows.length === 0) {
    return {
      present: false,
      relations,
      violations: [
        {
          subject: `role:${REP_WEB_ROLE}`,
          reason:
            "role does not exist — the dashboard's wall is enforced by grants, and a missing role enforces nothing",
        },
      ],
    };
  }
  return { present: true, relations, violations: await auditRepWebReach(client) };
}

/** Script entry, in `auditLedgerGrantsAt`'s shape. */
export async function auditRepWebGrantsAt(
  databaseUrl: string,
): Promise<RepWebGrantsReport> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    return await auditRepWebGrants(client);
  } finally {
    await client.end();
  }
}

/**
 * The aperture's column-level UPDATE grants on `ledger`, against
 * `LEDGER_ANNOTATION_COLUMNS`.
 *
 * Read off `pg_attribute` rather than probed column by column, so the
 * UNDECLARED direction is answerable at all: probing only the names we
 * expect can never catch a grant nobody wrote down, and "a privilege nobody
 * notices" is the thing …100012 refused table-wide UPDATE to avoid.
 */
async function auditAnnotationColumns(
  client: pg.ClientBase,
): Promise<GrantViolation[]> {
  const violations: GrantViolation[] = [];
  const granted = await client.query<{
    table_name: string;
    column_name: string;
  }>(
    `SELECT c.relname AS table_name, a.attname AS column_name
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = c.oid
       CROSS JOIN LATERAL aclexplode(a.attacl) AS acl
      WHERE n.nspname = 'ledger'
        AND c.relkind = 'r'
        AND a.attnum > 0
        AND NOT a.attisdropped
        AND acl.privilege_type = 'UPDATE'
        AND acl.grantee <> c.relowner
        AND acl.grantee::regrole::text = $1
      ORDER BY 1, 2`,
    [APERTURE_ROLE],
  );

  const live = new Set(
    granted.rows.map((r) => `${r.table_name}.${r.column_name}`),
  );
  const declared = new Set<string>();
  for (const [table, columns] of Object.entries(LEDGER_ANNOTATION_COLUMNS)) {
    for (const [column, path] of Object.entries(columns)) {
      declared.add(`${table}.${column}`);
      if (!live.has(`${table}.${column}`)) {
        violations.push({
          subject: `column:ledger.${table}.${column}`,
          reason: `${APERTURE_ROLE} has no column UPDATE on it, so ${path} cannot annotate — the annotation paths hold column-level grants precisely so the table-wide one stays refused`,
        });
      }
    }
  }
  for (const column of live) {
    if (!declared.has(column)) {
      violations.push({
        subject: `column:ledger.${column}`,
        reason: `${APERTURE_ROLE} holds an UPDATE grant on a Ledger column nobody declared — in-place writing is a closed set (finalization, retraction and the kind determination), and a column privilege arriving unannounced is a table-wide UPDATE assembled one grant at a time`,
      });
    }
  }
  return violations;
}

async function hasPrivilege(
  client: pg.ClientBase,
  role: string,
  qualifiedTable: string,
  privilege: string,
): Promise<boolean> {
  const res = await client.query<{ granted: boolean }>(
    "SELECT has_table_privilege($1, $2, $3) AS granted",
    [role, qualifiedTable, privilege],
  );
  return res.rows[0]!.granted;
}

/**
 * Does this view's shadow filter actually gate every row it returns?
 *
 * Text alone cannot answer that for an arbitrary view, and every cheap
 * approximation has a bypass. Presence of the filter passes `WHERE shadow =
 * false OR shadow = true`. Counting filters against the number of source
 * relations passes `WHERE e.shadow = false AND e.shadow = false` over a
 * facts⋈entities join — two filters, two sources, every shadow FACT
 * visible.
 *
 * Until ticket #127 the rule was therefore the narrowest shape the answer
 * is certain for — exactly one shadow-flagged source, no join at all — and
 * this comment said a joined view was "refused until this check can verify
 * it properly, by ASSOCIATING A FALSE-SHADOW PREDICATE WITH EVERY
 * RANGE-TABLE ALIAS in a parsed definition". `finalized_facts` now joins
 * the seats registry to expose the filing seat (ADR-0004 as amended), so
 * this is that work.
 *
 * THE RULE. For each shadow-flagged table the CATALOG says this view reads
 * — never a name read out of the text, which a definition could lie about —
 * every range-table entry over it must be paired with a `<alias>.shadow =
 * false` predicate in the same definition. An unqualified `shadow = false`
 * counts only when the view has one shadow-flagged source and no join at
 * all, which is the case where the predicate cannot be about anything else.
 * A definition carrying `OR` anywhere is still refused outright: a
 * disjunction is precisely what makes a conjunction's guarantee stop
 * holding, and no cheap reading of one is trustworthy.
 *
 * A join to a table with no `shadow` column — the seats registry — adds no
 * obligation, because there are no shadow rows on that side to leak. What
 * this check cannot see is a shadow-flagged table OUTSIDE `ledger`; there
 * is none, shadow being a Ledger concept, and `viewCoverage` is scoped to
 * `ledger` on both sides.
 */
export function filtersShadow(
  definition: string,
  shadowSources: readonly string[],
): boolean {
  const normalized = definition.replace(/\s+/g, " ");
  // A disjunction can always route around the conjunction below.
  if (/\bor\b/i.test(normalized)) return false;
  // Nothing shadow-flagged under it: there is no shadow row to filter, and
  // demanding a predicate about a column that does not exist would refuse a
  // view for being correct.
  if (shadowSources.length === 0) return true;

  const joins =
    /\bjoin\b/i.test(normalized) || /\bfrom\b[^)]*,/i.test(normalized);
  const unqualifiedAllowed = !joins && shadowSources.length === 1;
  // THE PREDICATE HAS TO BE A ROW QUALIFIER, not merely present. A view
  // that only mentions `shadow = false` inside a projection — `SELECT CASE
  // WHEN f.shadow = false THEN … END … FROM ledger.facts f` with no WHERE
  // — returns every shadow row and would satisfy any search of the whole
  // definition. So the search runs over the text after the LAST `WHERE`
  // only, which for these views is the qualifier and nothing else. A future
  // view whose WHERE is followed by a GROUP BY, or whose filter lives in a
  // subquery, is refused rather than guessed at — the same conservative
  // direction this check has taken since it was written.
  const lastWhere = normalized.toLowerCase().lastIndexOf(" where ");
  const qualifier = lastWhere === -1 ? "" : normalized.slice(lastWhere);

  for (const table of shadowSources) {
    const aliases = rangeTableAliases(normalized, table);
    // The catalog says the view reads it and the text does not show where:
    // a definition this check cannot locate the source in is one it cannot
    // make a claim about.
    if (aliases.length === 0) return false;
    for (const alias of aliases) {
      const byAlias = new RegExp(
        `\\b${alias}\\.shadow\\s*=\\s*false\\b|\\bNOT\\s+${alias}\\.shadow\\b`,
        "i",
      );
      if (byAlias.test(qualifier)) continue;
      if (
        unqualifiedAllowed &&
        (/\bshadow\s*=\s*false\b/i.test(qualifier) ||
          /\bNOT\s+shadow\b/i.test(qualifier))
      ) {
        continue;
      }
      return false;
    }
  }
  return true;
}

/**
 * Every name `ledger.<table>` is reachable by inside a view definition:
 * its alias where one is given, the bare table name where none is.
 *
 * `pg_get_viewdef` renders a definition in a normal form — schema-qualified
 * relations, aliases immediately after them — so the walk is over that
 * shape rather than over arbitrary SQL. A self-join yields two aliases and
 * therefore two obligations, which is the case the old source COUNT
 * collapsed to one.
 */
function rangeTableAliases(
  normalizedDefinition: string,
  table: string,
): string[] {
  const aliases: string[] = [];
  const reference = new RegExp(`\\bledger\\.${table}\\b(\\s+(\\w+))?`, "gi");
  // Words that can follow a relation without being an alias.
  const notAnAlias = new Set([
    "on",
    "using",
    "where",
    "join",
    "left",
    "right",
    "inner",
    "outer",
    "full",
    "cross",
    "natural",
    "group",
    "order",
    "having",
    "limit",
    "offset",
    "union",
    "intersect",
    "except",
    "window",
    "as",
  ]);
  for (const match of normalizedDefinition.matchAll(reference)) {
    const candidate = match[2];
    aliases.push(
      candidate !== undefined && !notAnAlias.has(candidate.toLowerCase())
        ? candidate
        : table,
    );
  }
  return aliases;
}

/**
 * Every role that can WRITE a Ledger table or an aperture store, read off
 * the relations' own ACLs rather than probed by name. Anything that is not
 * the relation's owner (Atlas, running migrations) or the aperture is a
 * second writer, and "exactly one component holds Ledger write
 * credentials" (ADR-0003) is then simply false.
 */
async function sweepWriteGrantees(
  client: pg.ClientBase,
): Promise<GrantViolation[]> {
  const res = await client.query<{
    schema_name: string;
    table_name: string;
    grantee: string;
    privilege: string;
  }>(
    `SELECT n.nspname AS schema_name,
            c.relname  AS table_name,
            -- Grantee 0 is PUBLIC, and it renders as '-' through regrole.
            CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
                 ELSE acl.grantee::regrole::text END AS grantee,
            acl.privilege_type AS privilege
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       CROSS JOIN LATERAL aclexplode(
         COALESCE(c.relacl, acldefault('r', c.relowner))
       ) AS acl
      WHERE (n.nspname = 'ledger' OR (n.nspname = 'public' AND c.relname = ANY($1::text[])))
        AND c.relkind IN ('r', 'p', 'v', 'm')
        AND acl.privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
        AND acl.grantee <> c.relowner
      ORDER BY 1, 2, 3, 4`,
    [[...APERTURE_REP_SIDE_STORES]],
  );

  const violations: GrantViolation[] = [];
  for (const row of res.rows) {
    if (row.grantee === APERTURE_ROLE) continue;
    // `dito_twin_runtime` write on an ordinary public table is its own
    // business; this sweep covers only Ledger relations and the aperture's
    // stores, and on those it may hold nothing.
    violations.push({
      subject: `table:${row.schema_name}.${row.table_name}`,
      reason:
        `${row.grantee} holds ${row.privilege} — exactly one component holds Ledger write credentials (ADR-0003), ` +
        `and a second writer files crossings the aperture never saw`,
    });
  }

  // ...and the writer nobody granted anything to. A role holding
  // MEMBERSHIP in `dito_aperture` inherits every one of its privileges
  // while the relations' own ACLs still name only the aperture, so the
  // sweep above sees nothing. Membership is the same credential by
  // another route. Superusers are outside the model on purpose: they are
  // the migration owner, and an audit that reported them would be red
  // forever and read by nobody.
  const members = await client.query<{ rolname: string }>(
    `SELECT r.rolname
       FROM pg_roles r
      WHERE r.rolname <> $1
        AND NOT r.rolsuper
        AND pg_has_role(r.oid, $1, 'MEMBER')
      ORDER BY 1`,
    [APERTURE_ROLE],
  );
  for (const row of members.rows) {
    violations.push({
      subject: `role:${row.rolname}`,
      reason: `${row.rolname} is a member of ${APERTURE_ROLE} and inherits its Ledger write credentials — membership is the same credential by another route (ADR-0003)`,
    });
  }
  return violations;
}

/** Which `ledger` tables each `ledger` view reads, from the catalog. */
async function viewCoverage(
  client: pg.ClientBase,
): Promise<Map<string, string[]>> {
  const res = await client.query<{ view_name: string; table_name: string }>(
    `SELECT dependent.relname AS view_name, source.relname AS table_name
       FROM pg_depend d
       JOIN pg_rewrite r ON r.oid = d.objid
       JOIN pg_class dependent ON dependent.oid = r.ev_class
       JOIN pg_namespace dn ON dn.oid = dependent.relnamespace
       JOIN pg_class source ON source.oid = d.refobjid
       JOIN pg_namespace sn ON sn.oid = source.relnamespace
      WHERE d.classid = 'pg_rewrite'::regclass
        AND d.refclassid = 'pg_class'::regclass
        AND dependent.relkind = 'v'
        AND source.relkind = 'r'
        AND dn.nspname = 'ledger'
        AND sn.nspname = 'ledger'
      GROUP BY 1, 2`,
  );
  const coverage = new Map<string, string[]>();
  for (const row of res.rows) {
    const views = coverage.get(row.table_name) ?? [];
    views.push(row.view_name);
    coverage.set(row.table_name, views);
  }
  return coverage;
}
