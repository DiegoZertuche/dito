/**
 * THE AUDIT CHAINS' COVERAGE: which acts owe an entry, and the check that
 * says whether they have one (ticket #78; ADR-0020; spec #48 decision 18).
 *
 * `audit-verify` proves INTEGRITY: first link from null, every `prev_hash`
 * matching its predecessor, every `entry_hash` matching its content under
 * the key for that chain's side. Nobody edited, removed, reordered or forged
 * an entry that IS in a chain.
 *
 * It cannot prove COVERAGE. An act that never calls an appender leaves no
 * gap to detect — a chain missing a link it was never asked to write is
 * byte-for-byte identical to a complete one. That is not hypothetical: the
 * rig held `entity_create` acts from before #54 wired the vocabulary, they
 * had no chain entry, and `audit-verify` was green over them.
 *
 * TWO CHAINS SINCE #165 (the decision on #157; ADR-0020 as amended
 * 2026-09-03): the rep side's `public.audit_chain` and the owner side's
 * per-company `owner.audit_chain`. Each class declares which of them can
 * hold its entries — see `MustChainClass.chains` — and the join, the entry
 * count, the vocabulary sweep and the report's total all read exactly the
 * chains the classes declare. Only `execution` declares both, and its own
 * comment carries the argument that makes accepting either one safe.
 *
 * THIS IS A SECOND CHECK, NOT A CHANGE TO THE FIRST. The two fail for
 * different reasons and say different things, so they are two verdicts.
 *
 * IT NEEDS NO HMAC KEY, and that is a property rather than an omission.
 * Integrity is a question about hashes and cannot be asked without the key;
 * coverage is a question about which rows exist, and can be asked anywhere
 * the database can be read — including by an operator who holds no chain
 * key at all.
 *
 * WHY IT LIVES IN THE APERTURE. It joins `ledger.*` rows, and ADR-0003 puts
 * every statement naming a Ledger object inside the single writer's own
 * package — `sole-writer.test.ts` is what enforces that, and it is what
 * moved this module here from `@dito/audit`. It sits beside the crossing's
 * other invariant reporters (`fr72.ts`, `grants.ts`, `wall.ts`,
 * `self-chat-exclusion.ts`) for the same reason they do. The action WORDS
 * stay at the chain, in `@dito/audit`'s `vocabulary.ts`, because every
 * writer must pass through them.
 *
 * ─────────────────────────────────────────────────────────────────────
 * THE ONE RULE THIS FILE EXISTS TO OBEY
 *
 * EVERY ENTRY BELOW CITES AN ADR OR A SPEC LINE, never a call site. A
 * must-chain list derived from the code that writes the entries can never
 * disagree with that code, which makes the whole check decorative: the
 * writers would define their own obligation and meet it by construction.
 * So the citation is the load-bearing field. If a class cannot name a
 * sentence somebody wrote down BEFORE the writer existed, it does not
 * belong in `MUST_CHAIN` — it belongs in `UNDECIDED`, which is why that
 * third list exists. It is also where a class goes when the sentence
 * arrived and the WRITER has not: `MUST_CHAIN` is checked, so a class
 * nothing can satisfy would make every run red over work not yet done.
 *
 * WHAT IT JOINS, and why it is not circular either: every act class it can
 * join is enumerated from a row written by a DIFFERENT STATEMENT than the
 * append — the seam's processing marker, the filed entity, the reversal row.
 * A writer that stops calling `appendAuditEntry` still writes those, which is
 * precisely the failure this check exists to catch.
 *
 * The sources, in full, so a reader need not go and find them:
 *
 *   ADR-0020 — "All G16 trust mechanisms write to an append-only, HMAC
 *     hash-chained audit log (caller identity + action type + opaque refs +
 *     outcome per entry)." The coverage claim, and too broad on its own to
 *     enumerate from: "G16 trust mechanisms" names a PRD gate that is not
 *     in this repo. It is cited here as the reason coverage is a claim at
 *     all, never as the sole authority for a class.
 *
 *   Spec #48 decision 18 — "Rep acts and refusals are audit-chained
 *     (ADR-0020)." The operative sentence, and the one every rep-side
 *     class below rests on.
 *
 *   ADR-0003 — "Class 1 — candidate facts: model output, untrusted,
 *     confidence-gated… Class 2 — rep acts (confirmations, corrections,
 *     retractions, entity create/rename/merge): each must reference
 *     verifiable rep-act evidence." This is what "rep act" MEANS, so it is
 *     what decision 18 quantifies over. Its 2026-08-29 amendment removes
 *     merge from the class ("Merge is also no longer a rep act at all").
 *
 *   Spec #48 AC 7 — "A question is answered from the thread with a quoted
 *     «si»; the answer is evidence-bound and audit-chained."
 *
 *   Ticket #24 ACs — "A destination not on the hard send-allowlist is
 *     refused, and a content-free audit entry (caller identity, action
 *     type, opaque refs, outcome) is appended"; "pacing refusals are
 *     audit-chained".
 *
 *   ADR-0035, amendment 2026-08-30 — "The operator invokes it,
 *     audit-chained… The chain records the refused and repeated attempts
 *     too, with their own outcomes."
 *
 *   ADR-0035, amendment 2026-08-31 (ticket #60) — "Every determination is
 *     audit-chained under its own action word with a `model`-or-`human`
 *     stamp, so 'which of these did anybody actually look at' is answerable
 *     from the chain." And the rung the determination gates: "a normalized
 *     phone with matching `kind`".
 *
 *   Diego's ruling on #78, 2026-08-30 — the matcher's own
 *     `correction_refused` IS chained: "this is a rep act that was
 *     refused… 'what did the rep try to do' is the question the chain
 *     exists to answer."
 *
 *   Diego's rulings of 2026-08-31, which settled the last four open
 *     classes and left a rule rather than four list entries:
 *
 *       "THE CHAIN COVERS ACTS WHOSE ONLY TRACE IT WOULD BE."
 *
 *     That is why `refuse()` chains (it rolls back to its savepoint before
 *     appending, so nothing but the entry survives), why the matcher's
 *     `correction_refused` chains (nothing else records the attempt), and
 *     why a dismissal and a successful send need not — `draft_dismissals`
 *     holds the one and FR-70 reconciles the other. A FUTURE WRITER APPLIES
 *     THE RULE rather than asking for another ruling. The same rulings read
 *     spec #48 decision 18 in its own paragraph and found it DESCRIPTIVE:
 *     its headline is "Dispositions grow, machinery doesn't" and its body
 *     says the refusal taxonomy and the hash-chained audit "are unchanged",
 *     so its closing clause restates the earlier, narrower sentences rather
 *     than widening them.
 *
 * ─────────────────────────────────────────────────────────────────────
 * WHAT THIS ENUMERATION DOES NOT REACH, said out loud so its silence is
 * never read as a claim.
 *
 *   ACTS ADR-0003 NAMES THAT HAVE NO WRITER YET. Class 2 is "confirmations,
 *     corrections, retractions, entity create/rename/merge", and **rename**
 *     has no writer anywhere in this repo; expungement (ADR-0026) has none
 *     either. They are absent from `AUDIT_ACTIONS` deliberately — the
 *     aperture's own rule, which predates this ticket, is that "a word in
 *     this set with no writer is a chain entry nobody can produce". Their
 *     absence from `MUST_CHAIN` is therefore NOT a statement that they owe
 *     no entry: when a writer arrives it adds the word and the class
 *     together, and spec #48 decision 18 already governs what it must do.
 *
 *   THE OTHER PLANES ADR-0020 FEEDS. "CloudTrail KMS events feed it", and
 *     ADR-0016 puts production shell access behind "audited sessions (SSM)
 *     feeding the ADR-0020 chain". Neither is a row in this database, so no
 *     SQL join here can see them, and ticket #78 puts them out of scope
 *     explicitly. A green from this check says nothing about either.
 *
 * ─────────────────────────────────────────────────────────────────────
 * WHY THE EXCLUSIONS MATTER AS MUCH AS THE INCLUSIONS
 *
 * A coverage check with no exclusion list would demand an entry per
 * extracted fact — extraction files them by the hundred — and bury the rep
 * acts the chain exists to make auditable. `MUST_NOT_CHAIN` is therefore
 * not commentary: it is the half of the enumeration that keeps the other
 * half readable, and each of its entries cites its own sentence too.
 */
import { isAuditAction, type AuditAction } from "@dito/audit";
import pg from "pg";

/**
 * How the coverage check finds the entry for one act — or why it cannot.
 *
 * PER-ACT is the strong form: the act leaves a row carrying an id the
 * entry's `ref` names, so every single act is checked by name and the
 * report can say WHICH one is missing.
 *
 * COUNT is the weaker form, used where the act leaves a row but no stored
 * path from that row back to the id the entry names. It still catches the
 * failure this ticket exists for — a writer that stopped chaining — but it
 * names a number rather than a subject.
 *
 * UNJOINABLE is the honest form. Some refusals persist NOTHING but their
 * own chain entry, so there is no second row to join against and no check
 * can be written. Naming them here, and printing them in every run, is the
 * whole remedy available: a reader is told exactly which classes the green
 * does not cover, rather than being left to assume it covers everything.
 */
export type ActJoin =
  | {
      /**
       * PER-ACT names the act; COUNT names a number. The payloads are the
       * same because the difference is the SQL's result shape, not the
       * class's: a per-act query returns `(subject, ref_token)` per act, a
       * count query returns one `bigint`. Count is used only where the act
       * leaves a row but no stored path from that row back to the id the
       * entry names.
       */
      readonly kind: "per_act" | "count";
      /**
       * The relation the acts are read from — declared rather than parsed
       * out of the SQL, because the check runs against RIG DATA as well as
       * CI's corpus and the rig is routinely behind `main`. A class whose
       * relation is not in the schema is reported ABSENT, never crashed on
       * and never silently skipped.
       */
      readonly relation: string;
      /**
       * `per_act`: one row per act, as `(subject text, ref_token text)` —
       * `subject` is what the report names, `ref_token` is the whole
       * space-delimited `label:value` token the entry's `ref` must contain.
       * `count`: one row, one `bigint`.
       */
      readonly actsSql: string;
    }
  | { readonly kind: "unjoinable"; readonly why: string };


/**
 * WHAT THE SEAM SAYS HAPPENED — the independent catalog the enumeration
 * must be exhaustive over (ticket #78, Codex r3).
 *
 * THE HOLE THIS CLOSES. "Every action word has a must-chain class" is a
 * circular test: an act whose writer forgets `appendAuditEntry` introduces
 * no action word, so it is missing from BOTH sides and the test passes —
 * which is exactly the failure this ticket exists to detect. So the
 * enumeration is checked against a vocabulary it does not own:
 * `wa_event_processing`'s disposition set, which is a CHECK constraint in
 * `db/migrations` and grows every time a new kind of processed rep message
 * ships ("dispositions grow, machinery doesn't", spec #48 decision 18).
 *
 * A disposition added without a verdict here fails
 * `audit-coverage.int.test.ts`, which reads the constraint out of the live
 * schema. That is the day someone has to say whether the new act owes the
 * chain an entry — which is the whole point.
 *
 * IT IS A CATALOG, NOT A JOIN. Several dispositions are ambiguous about
 * their act (`declined` covered a declined aperture question, which chained,
 * and a declined binding question, which does not), so the checks
 * themselves key on the unambiguous ones. The verdict here is about the
 * ACT, and the `joinedBy` field says which class actually watches it.
 */
export type DispositionVerdict =
  /** A rep act on the Ledger; the named class is what checks it. */
  | "must_chain"
  /**
   * A real rep act that deliberately owes the chain nothing, because it is
   * not an act whose only trace the chain would be. The `why` names the
   * `MUST_NOT_CHAIN` class that counts it.
   */
  | "must_not_chain"
  /** Twin bookkeeping — nothing crossed, nobody acted on the record. */
  | "not_an_act"
  /** A real rep act that no accepted sentence classifies. See UNDECIDED. */
  | "undecided";

export interface DispositionVerdictEntry {
  readonly verdict: DispositionVerdict;
  /** The `MUST_CHAIN` class that watches it, when one does. */
  readonly joinedBy?: string;
  readonly why: string;
}

export const SEAM_DISPOSITIONS: Readonly<
  Record<string, DispositionVerdictEntry>
> = {
  // ── Rep acts on the Ledger, watched by a class above ────────────────
  binding_confirmed: {
    verdict: "must_chain",
    joinedBy: "entity_create",
    why: "The rep's quoted yes on the binding question; ADR-0003 class 2 names entity create as a rep act.",
  },
  retracted: {
    verdict: "must_chain",
    joinedBy: "fact_retraction_performed",
    why: "The rep's ‘N no’ annotated the fact (ticket #54 AC 1).",
  },
  correction_refused: {
    verdict: "must_chain",
    joinedBy: "fact_retraction_refused",
    why: 'The rep\'s ‘N no’ retracted nothing; spec #48 decision 18 chains refusals, settled for this one by Diego\'s ruling on #78.',
  },
  question_answered: {
    verdict: "must_chain",
    joinedBy: "question_answer",
    why: "The rep answered ‘si’; spec #48 AC 7. A word no build writes any more — the candidate-question route was retired at #218 — kept because the seam's vocabulary never narrows and a rig corpus still holds these acts.",
  },
  question_answer_refused: {
    verdict: "must_chain",
    joinedBy: "question_answer_refused",
    why: "The rep answered a question that was no longer theirs to answer; spec #48 decision 18. Also unwritable since #218, and kept for the same reason as the marker above.",
  },
  declined: {
    verdict: "must_chain",
    joinedBy: "question_answer",
    why: "AMBIGUOUS BY CONSTRUCTION and recorded as such: a declined APERTURE question was an answer and chained; a declined BINDING question carries no question id, files nothing, and does not (…100024, ticket #49). Only the second is reachable since #218 retired the aperture question, so a corpus written by this build marks `declined` for the binding alone — and the entries the first left behind are what the class above counts.",
  },
  // ── Real rep acts that deliberately owe no entry ─────────────────────
  affirmed: {
    verdict: "must_not_chain",
    why: "A successful customer send. Ruled 2026-08-31: spec #48 decision 18 restated the earlier, narrower sentences rather than widening them, and FR-70 already reconciles the tap against its command — so the chain is not this act's only trace. See `customer_send_scope` in MUST_NOT_CHAIN, which counts it.",
  },
  affirmation_refused: {
    verdict: "must_chain",
    joinedBy: "customer_send_refused",
    why: "AMBIGUOUS BY CONSTRUCTION and recorded as such, like `declined`: it covers the writer's three cited refusals, which chain, AND the matcher's own `unresolved_draft`, which does not (ruled MUST NOT CHAIN on 2026-08-31 — the ‘va’ resolved to no act, so there is no rep act to record). The reason itself is stored nowhere but the notice's encrypted microcopy, which is why the class it points at is unjoinable and why no count over this marker can stand in for a join.",
  },
  dismissed: {
    verdict: "must_not_chain",
    why: "The terminal ‘no va’. Spec #29 grilling decision 1 chains a LATER ‘va’ on a dismissed draft and says nothing about the dismissal itself; ruled 2026-08-31 that decision 18 did not widen that. The dismissal writes its own `draft_dismissals` row pinned to the rep's raw event, so it is not an act that vanishes. See `draft_dismissal` in MUST_NOT_CHAIN.",
  },
  // ── Twin bookkeeping: nothing crossed, nobody acted on the record ────
  captured: {
    verdict: "not_an_act",
    why: "Conversation row into the bundle only; nothing reached the Ledger.",
  },
  no_answer_needed: {
    verdict: "not_an_act",
    why: "The drafting harness decided no reply was needed. A twin judgment, not a rep act.",
  },
  drafted: {
    verdict: "not_an_act",
    why: "A draft and its system_send. Nothing crossed and the rep has not acted yet — the ‘va’ is the act, and it is `affirmed`.",
  },
  drafted_in_batch: {
    verdict: "not_an_act",
    why: "As `drafted`, for a settled turn (ticket #75).",
  },
  answered_by_rep: {
    verdict: "not_an_act",
    why: "The rep replied in the chat themselves, so the messages needed no draft (ticket #75). Nothing was minted.",
  },
  backfill_ingested: {
    verdict: "not_an_act",
    why: "History normalized into the bundle. Explicitly never matcher input and never drafted (spec #29 decisions 5–6).",
  },
  answered: {
    verdict: "not_an_act",
    why: "The twin answered a question the rep asked IT. Q&A output crosses nothing (ADR-0033).",
  },
  deliberate_silence: {
    verdict: "not_an_act",
    why: "The twin chose not to answer. A twin judgment.",
  },
  media_ignored: {
    verdict: "not_an_act",
    why: "A media-only message, ignored (spec #29 grilling decision 2).",
  },
  execution_failed: {
    verdict: "not_an_act",
    why: "An execution ran for this row and produced no outcome (ticket #240; the ruling on boundary #225, F1). Nothing crossed, nobody acted, and the rep never read a sentence about it. The RUN is chained all the same, `failed`, and `rep_execution` is the class that watches it — the shape `drafted` already has, where the marker is bookkeeping and the execution beside it is what owes the entry.",
  },
  folded: {
    verdict: "not_an_act",
    why: "A rep line answered by the twin-thread turn it folded into (ticket #319; design D7). The turn is ONE execution keyed to the first line's trigger, chained once and watched by `rep_execution`; this line's marker is bookkeeping, and any act in that turn rests on the first line's evidence and is chained by its own class.",
  },
};

/** One class of act that owes the chain an entry. */
export interface MustChainClass {
  /** Stable id, used in the report and in tests. */
  readonly id: string;
  /** The action word its entry carries. */
  readonly action: AuditAction;
  /** What the act is, in the domain's own words. */
  readonly what: string;
  /** THE SENTENCE THAT PUTS IT HERE. Never a call site. */
  readonly source: string;
  /**
   * What a violation of THIS class cites, when the coverage claim's usual
   * pair does not govern it.
   *
   * `COVERAGE_CITATION` is the default because spec #48 decision 18 is the
   * sentence behind every rep-side class here. An act that is not a rep act
   * needs its own, and printing decision 18 beside it would send a reader to
   * a sentence that does not reach the act they are looking at — ticket
   * #60's kind determination is the first of those.
   */
  readonly violationCitation?: string;
  /**
   * Which chain entries belong to this class, as a predicate on the chain
   * alias `c` ANDed with the action word.
   *
   * `c` CARRIES ADR-0020'S FOUR CONTENT-FREE FIELDS AND NOTHING ELSE —
   * `caller`, `action`, `ref`, `outcome` — because since #165 it may be a
   * union of two tables (`chainSource`), and `id` and `created_at` are each
   * table's own: an `id` compared across a union orders nothing, and a
   * predicate on either would be a claim about storage rather than about the
   * act. A predicate naming a fifth column typechecks and fails at run time,
   * which is why this sentence is here rather than a comment on the query.
   *
   * Beside the class rather than inside its join, because it is true
   * whether or not the class can be joined: an unjoinable class still has
   * entries, and counting them precisely is the only thing a run CAN say
   * about it.
   */
  readonly entryPredicate: string;
  /**
   * WHICH CHAIN THIS CLASS'S ENTRIES LIVE ON (ticket #165; the decision on
   * #157). Omitted means `[SHARED_CHAIN]`, which is every rep act here.
   *
   * There are two chains since ADR-0020's amendment of 2026-09-03 — the rep
   * side's `public.audit_chain` and the owner side's per-company
   * `owner.audit_chain` — and this is where a class says which of them can
   * hold its entries. Declared per class rather than "search both
   * everywhere", because a rep act appearing on the owner's chain would be a
   * finding rather than coverage, and a join that looked there anyway could
   * never say so.
   */
  readonly chains?: readonly string[];
  /**
   * WHO may have performed it, as the chain names them.
   *
   * ADR-0020 asks for "caller identity + action type + opaque refs +
   * outcome per entry", and `audit.ts` already states the property this
   * makes checkable: "a chain entry naming any other caller for these
   * actions is itself the finding". Without it the join would accept an
   * entry recording the right act performed by the wrong component, and
   * report the act covered.
   *
   * The set per class, not per repo: `fact_retraction` is legitimately
   * written by two callers — the aperture, and the matcher for the refusal
   * it resolves rep-side before the aperture ever sees it (ticket #54).
   */
  readonly callers: readonly string[];
  /** How the check joins acts to entries, or why it cannot. */
  readonly join: ActJoin;
}

/**
 * The rep side's chain: one sequence of links, keyed by the rep-side key.
 *
 * MODULE-PRIVATE, both of these. Nothing outside this file needs to name a
 * chain table — the classes below declare which they read, and every query
 * here goes through `chainSource`. `grants.ts` keeps its own private
 * `SHARED_CHAIN_TABLE` for the one violation it has to name by table, and
 * that separation is deliberate: the grant audit's business with this table
 * is a privilege, and this module's is a set of rows.
 */
const SHARED_CHAIN = "public.audit_chain";
/**
 * ...and the owner side's, one chain per company under its own key (ticket
 * #165; the decision on #157; ADR-0020 as amended).
 */
const OWNER_CHAIN = "owner.audit_chain";

/**
 * THE MUST-CHAIN SET.
 *
 * Ordered by the act's own surface, not by package: a reader asking "did
 * the rep's correction get recorded" should find it next to the rep's
 * other acts.
 */
export const MUST_CHAIN: readonly MustChainClass[] = [
  {
    id: "entity_create",
    action: "entity_create",
    what: "The rep's quoted yes on the binding question: the chat becomes an entity in the Ledger, with its disclosure line in the same transaction.",
    source:
      'ADR-0003 class 2 names "entity create" as a rep act; spec #48 decision 18: "Rep acts and refusals are audit-chained".',
    callers: ["aperture"],
    entryPredicate: "TRUE",
    join: {
      kind: "per_act",
      relation: "wa_event_processing",
      // The seam's own marker for "the rep's yes was processed" — written
      // by `markProcessed`, in a different statement from the append, so a
      // writer that forgot to chain still leaves this row behind. An
      // idempotent repeat marks `binding_confirmed` too and chains
      // `already_filed`, which is why no outcome is required here: the
      // chain records ACTS, not state changes.
      actsSql: `SELECT 'wa_event ' || p.event_id AS subject,
                       'event:' || p.event_id AS ref_token
                  FROM wa_event_processing p
                 WHERE p.disposition = 'binding_confirmed'
                 UNION ALL
                -- ...AND THE CONFIRMATIONS THE REP MADE ON A CARD (#224).
                -- ENUMERATED FROM THE LINE AND NOT FROM THE ACT ROW, which is
                -- the whole of why this arm is not mechanical. A dashboard act
                -- row exists the moment the rep presses the button, and the
                -- CROSSING is a separate execution the poll loop fires on its
                -- next pass — so enumerating acts would report every
                -- confirmation as unchained for as long as that window lasts.
                -- The disclosure line is written by fileEntityCreate in the
                -- same transaction as the append it is the evidence for, in a
                -- DIFFERENT statement, which is exactly the property every
                -- other join in this file rests on.
                 SELECT 'dashboard_act ' || d.dashboard_act_id AS subject,
                        'act:' || d.dashboard_act_id AS ref_token
                   FROM disclosure_lines d
                  WHERE d.subject_kind = 'entity_create'
                    AND d.dashboard_act_id IS NOT NULL`,
    },
  },
  {
    id: "entity_kind",
    action: "entity_kind",
    // THE CLAIM IS AT THE ENTITY'S GRAIN, and it is stated at that grain on
    // purpose rather than at the determination's — see the join below, which
    // says what this does NOT reach. Every filed entity carries a `kind`
    // something decided, and this class is the claim that the chain can say
    // WHO.
    what: "A filed entity's `kind` traced back to a determination the chain records: the model's at the binding confirmation, the model's again at a backfill, or a human's correcting one by hand.",
    source:
      'Diego\'s ruling of 2026-08-31 STATES THE EXCEPTION to the class-1 exclusion rather than assuming it: a class-1 CANDIDATE FACT is a claim about the conversation, confidence-gated and disclosed to the rep who can correct it; a class-1 ENTITY ATTRIBUTE differs in the way that matters, because `kind` GATES MERGE ELIGIBILITY — ADR-0035\'s phone rung fires only on "a normalized phone with matching `kind`", the sentence this whole determination exists to make evaluable — it is never disclosed, and nothing else records who determined it or when. A wrong one silently blocks or permits a merge, and the chain is the only place that question can be answered later. ADR-0035\'s own amendment says the same thing in the ADR — "Every determination is audit-chained under its own action word with a `model`-or-`human` stamp, so ‘which of these did anybody actually look at’ is answerable from the chain" — but that amendment was written WHILE ticket #60 was built, so it corroborates the ruling here rather than carrying the class: the sentences that carry it are the rung and the ruling, and both predate this build.',
    // NOT decision 18: a determination is neither a rep act nor a refusal of
    // one, and a reader sent to that sentence would find nothing about it.
    violationCitation: "ADR-0020, ADR-0035 as amended",
    callers: ["aperture"],
    // TWO THINGS EXCLUDED, and the second is what the cited sentence
    // promises.
    //
    // THE REFUSAL, excluded rather than forgotten: a determination naming an
    // entity nobody filed chains `refused:unknown_entity` and then throws,
    // and an entry saying the aperture REFUSED to judge an entity must never
    // stand in as the record that somebody judged it. Its own coverage is
    // unreachable by construction — the entity row it names does not exist —
    // and no accepted sentence makes it a class, so it is not one.
    //
    // THE STAMP, required rather than described: the ADR promises a
    // `model`-or-`human` stamp on every determination, and a promise the
    // check does not test is a comment. `KIND_DETERMINERS` fences the
    // TypeScript call sites; this fences the store, for the same reason the
    // vocabulary sweep below exists — a `.mjs` script, a psql session or an
    // older build reaches the chain without passing the type.
    entryPredicate:
      "c.outcome NOT LIKE 'refused:%' AND (c.ref LIKE '% by:model' OR c.ref LIKE '% by:human')",
    join: {
      kind: "per_act",
      relation: "ledger.entities",
      // THE FILED ENTITY IS THE ACT ROW, and it is written by a different
      // statement than the append in every path: the INSERT at the create,
      // the `UPDATE … SET kind` at a correction. Every row in this relation
      // carries a `kind` that something determined — the column is NOT NULL
      // with a two-value CHECK and there is no third state (ticket #60) — so
      // an entity with no entry is exactly the defect: a label nobody can
      // trace to a determiner.
      //
      // THE TOKEN IS THE PAIR, because a Ledger entity's identity is the
      // pair: the id is client-minted, so the same UUID may stand for two
      // customers of two companies. `entityKindRef` writes company first, so
      // the two tokens are adjacent and the whole-token match still holds at
      // both ends.
      //
      // WHAT THIS DOES NOT REACH, said out loud because a green here would
      // otherwise be read as more than it is (Codex r1). The join proves
      // that EVERY FILED ENTITY HAS A DETERMINATION IN THE CHAIN. It does
      // not prove that every determination was chained: `kind` is a mutable
      // column holding only the standing value, so a SECOND determination on
      // an entity — a backfill's re-inference, a human's correction, an
      // `unchanged` or a `deferred` — leaves no second row to join against,
      // and the first entry still satisfies the token. A writer that stopped
      // chaining CORRECTIONS would be invisible here. The one signal a run
      // does give is arithmetic: `entries` exceeds `acts` exactly when the
      // corpus holds re-determinations, so a corpus that corrected kinds and
      // reports equal numbers is worth reading twice.
      //
      // Closing it takes an immutable, independently enumerable row per
      // determination whose id the ref names — which is a change to what the
      // writer STORES, not a change to a check, and is the same remedy #78
      // recorded and declined for the customer-send refusals. Recorded here,
      // not built: the enumeration does not add writers.
      actsSql: `SELECT 'entity ' || e.company_id || '/' || e.entity_id AS subject,
                       'company:' || e.company_id || ' entity:' || e.entity_id AS ref_token
                  FROM ledger.entities e`,
    },
  },
  {
    id: "fact_retraction_performed",
    action: "fact_retraction",
    what: "The rep's correction of a line of the daily disclosure retracted the fact that line disclosed.",
    source:
      'ADR-0003 class 2 names "corrections, retractions" as rep acts; spec #48 decision 18; ticket #54 AC 1: "The retraction is a class-2 rep act, evidence-bound and audit-chained".',
    // NOT a refusal: the two outcomes are disjoint per event (the aperture
    // either annotates or refuses), and a marker that says "retracted" must
    // not be satisfied by an entry that says the opposite.
    callers: ["aperture"],
    entryPredicate: "c.outcome NOT LIKE 'refused:%'",
    join: {
      kind: "per_act",
      relation: "wa_event_processing",
      actsSql: `SELECT 'wa_event ' || p.event_id AS subject,
                       'event:' || p.event_id AS ref_token
                  FROM wa_event_processing p
                 WHERE p.disposition = 'retracted'
                 UNION ALL
                -- ...AND THE RETRACTIONS THE REP MADE ON A CARD (#224),
                -- enumerated by what the surface ANSWERED. A dashboard act
                -- leaves no wa_event_processing marker at all, so without this
                -- arm the whole surface was enumerated by nothing and this
                -- class was green over it while saying nothing about it.
                --
                -- A REPEAT PRESS BELONGS HERE AND NOT IN THE REFUSAL CLASS,
                -- which is the one thing this arm cannot get from the
                -- retraction row: a second press on a line already retracted
                -- writes no new fact_retractions row (the fact already
                -- carries one, naming the FIRST act) and chains
                -- already_retracted — an entry this class's predicate accepts
                -- and the refusal class's rejects. It is also exactly what
                -- the thread's arm does with a repeated correction, which
                -- marks retracted too. So the enumeration is the act's own
                -- outcome word, stamped in the same transaction as the append
                -- and by a different statement — the property every join in
                -- this file rests on.
                 SELECT 'dashboard_act ' || a.id AS subject,
                        'act:' || a.id AS ref_token
                   FROM dashboard_acts a
                  WHERE a.verb = 'retract_line'
                    AND a.outcome IN ('performed', 'already')
                 UNION ALL
                -- ...AND A LINE CORRECTED IN PLACE ON THE CARD (#344), which
                -- reaches the twin as a door message: the thread execution
                -- marks it with the act's own word exactly as it marks a seam
                -- event, one table over.
                 SELECT 'dashboard_message ' || m.message_id AS subject,
                        'message:' || m.message_id AS ref_token
                   FROM dashboard_message_processing m
                  WHERE m.disposition = 'retracted'`,
    },
  },
  {
    id: "fact_retraction_refused",
    action: "fact_retraction",
    what: "The rep's correction retracted nothing — a line the post never showed, a line no rep act undoes yet, or a window already closed.",
    source:
      'Spec #48 decision 18: "Rep acts and REFUSALS are audit-chained". Diego\'s ruling on #78 (2026-08-30) settles the rep-side half: a mistyped number and an attempt to retract a line that is not there are indistinguishable from outside, and "what did the rep try to do" is the question the chain exists to answer.',
    // THREE CALLERS, and that is the point of the field: the rep-side
    // resolution refuses the number that names no line before the aperture
    // sees it (#54), and the aperture refuses the two it decides itself.
    //
    // TWO WORDS FOR THE REP-SIDE ONE, and both stay (#174). The matcher
    // that wrote `correction_matcher` is deleted — the rep names the line
    // in prose now and `retract_disclosure_line` resolves it — so the tool
    // writes its own name. The old word is KEPT because the chain is
    // append-only: entries written before this build carry it, and dropping
    // it would leave every one of them uncovered against acts that really
    // happened. A caller list is the set of components that may have
    // performed or refused this act over the life of the chain, not the set
    // that can today.
    callers: [
      "aperture",
      "correction_matcher",
      "retract_disclosure_line",
      // ...AND THE DASHBOARD'S OWN, for the two it refuses before the aperture
      // sees them: a card carrying no record, and a line number that post
      // never printed (#224). Its name is the module that refused, which is
      // the rule the tool's name follows one surface over.
      "dashboard_act",
    ],
    entryPredicate: "c.outcome LIKE 'refused:%'",
    join: {
      kind: "per_act",
      relation: "wa_event_processing",
      // THE HARD CASE, AND THE REASON THIS TICKET IS NOT MECHANICAL. A
      // refusal writes no row anywhere else to join against: a successful
      // entity create leaves an entity, a retraction leaves a retraction,
      // and this leaves only a `wa_event_processing` disposition and a
      // notice. So the join is the disposition — and refusals are exactly
      // the acts a future writer is most likely to forget, precisely
      // because nothing else persists.
      //
      // BOTH ORIGINS LAND HERE, which is what makes the one join total: the
      // rep-side `unknown_line` (chained by `retract_disclosure_line`
      // itself, under its own name) and the aperture's (`not_a_fact`,
      // `window_closed`, chained in `retraction.ts`) both mark the event
      // `correction_refused`.
      //
      // WHICH IS WHY A REFUSED ACT KEEPS ITS MARKER AT #174 (spec #171
      // decision 22 — "the vocabulary is not narrowed"). The thread
      // execution marks a performed act with the act's own word and a
      // refused Ledger act with the act's own REFUSAL word, because this
      // join is the only record a refusal leaves: a refused retraction that
      // marked `answered` would leave this class with zero acts, zero
      // violations and nothing said — the silent green the comment above
      // calls the failure mode.
      actsSql: `SELECT 'wa_event ' || p.event_id AS subject,
                       'event:' || p.event_id AS ref_token
                  FROM wa_event_processing p
                 WHERE p.disposition = 'correction_refused'
                 UNION ALL
                -- ...AND THE CARD'S OWN REFUSALS (#224), enumerated by the
                -- act's outcome word for the reason the performed class
                -- argues: the absence of a retraction row cannot tell a
                -- refusal from a repeat, and the two owe the chain different
                -- entries. Every refusal here chains inside the act's own
                -- transaction — the aperture's two under its own name, and the
                -- two the dashboard refuses before the aperture sees them
                -- under dashboard_act — and window_closed is a refusal with
                -- its own word on the wire rather than a fourth disposition,
                -- which is why both words appear.
                 SELECT 'dashboard_act ' || a.id AS subject,
                        'act:' || a.id AS ref_token
                   FROM dashboard_acts a
                  WHERE a.verb = 'retract_line'
                    AND a.outcome IN ('refused', 'window_closed')
                 UNION ALL
                -- ...AND A CORRECTION AT THE DASHBOARD'S DOOR THE TWIN COULD
                -- NOT MAKE (#344), by the door's own marker.
                 SELECT 'dashboard_message ' || m.message_id AS subject,
                        'message:' || m.message_id AS ref_token
                   FROM dashboard_message_processing m
                  WHERE m.disposition = 'correction_refused'`,
    },
  },
  {
    id: "question_answer",
    action: "question_answer",
    what: "The rep answered an aperture question from the thread: a yes filed the candidate with its disclosure line, a no closed the question and filed nothing. A CLOSED HISTORY — the candidate-question route was retired at #218, so no build can perform this act again.",
    source:
      'Spec #48 AC 7: "A question is answered from the thread with a quoted ‘si’; the answer is evidence-bound and audit-chained." ADR-0003 class 2 (a confirmation). Spec #171 decision 18 made the answer PROSE rather than a keyword; spec #214 decision 3 retires the route, and neither the evidence rule nor the chaining obligation over the entries already written is touched by that.',
    // The verdict outcomes (`affirmed`, `declined`), never a refusal: a
    // question that HELD an answer was not refused.
    //
    // THE CLASS OUTLIVES ITS WRITERS, and that is the rule the chain forces
    // (see `fact_retraction_refused`): the chain is append-only, `question_answer`
    // is still a word in `AUDIT_ACTIONS`, and a corpus holding entries under a
    // word no class declares is reported as a VOCABULARY violation. So both
    // callers stay — a caller list is the set of components that may have
    // performed this act over the life of the chain, not the set that can today.
    callers: ["question_matcher", "answer_aperture_question"],
    entryPredicate: "c.outcome NOT LIKE 'refused:%'",
    join: {
      kind: "unjoinable",
      why: "The store this joined — the aperture's question rows, whose terminal `answer` was the act's own independent record — was dropped when the candidate-question route was retired (ticket #218). The entries stay on the append-only chain and are counted here; there is no longer a second row to join them against, and an act nobody can perform again cannot acquire one.",
    },
  },
  {
    id: "question_answer_refused",
    action: "question_answer",
    what: "The rep answered a question that was no longer theirs to answer — expired, already answered, voided, or its candidate no longer filable. A rep act happened and nothing was minted. Also a CLOSED HISTORY (#218): nothing asks, so nothing can be answered too late.",
    source:
      'Spec #48 decision 18: "Rep acts and refusals are audit-chained" — the rep answered, and the twin could not honour it. (…100023\'s own note on the marker it added says the same thing, but a migration comment is code and does not carry a class on its own.)',
    // Both writers, for the reason the class above states.
    callers: ["question_matcher", "answer_aperture_question"],
    entryPredicate: "c.outcome LIKE 'refused:%'",
    join: {
      kind: "count",
      relation: "wa_event_processing",
      // COUNT, not per-act, and the reason is structural: a refused answer
      // updated no question row, so the walk from the rep's event back to
      // the question it named survived only in the matcher's own resolution
      // — which is not stored. The disposition proves the act happened; the
      // count proves an entry was written for it. The MARKER survives the
      // retirement because the seam's vocabulary never narrows (…100022's
      // rule), so a rig corpus holding these acts is still checked.
      actsSql: `SELECT count(*)::bigint AS acts
                  FROM wa_event_processing p
                 WHERE p.disposition = 'question_answer_refused'`,
    },
  },
  {
    id: "entity_merge_performed",
    action: "entity_merge",
    what: "The system merged two of a company's records into one, with nobody in the loop.",
    source:
      "Diego's ruling of 2026-08-31, on the argument ticket #62 gave for chaining the REVERSAL — \"an act performed with no user in the loop is the one a reader of the chain most needs to find\" — which applies harder to the merge, the act that asked nobody in the first place. ADR-0003's amendment takes merge out of the rep-act class, so spec #48 decision 18 does not reach it; ADR-0020's coverage claim is about TRUST MECHANISMS rather than about acts with a human actor, and an automatic merge is exactly one.",
    // Not a rep act, so decision 18 is the wrong sentence to print at a
    // reader when this class fails.
    violationCitation:
      "ADR-0020 and ADR-0035, under Diego's ruling of 2026-08-31",
    callers: ["aperture"],
    // THE RULE FOR WHAT A DECLINE OWES (ticket #89's question, answered).
    //
    //   The chain records a DECISION TAKEN, not a candidate passed over.
    //
    // The ladder walks every entity sharing a key and declines most of
    // them. If each decline chained, the chain would fill with non-events
    // and bury the merges — which is `MUST_NOT_CHAIN`'s own failure mode
    // arriving from the other side, and it would teach a reader to skim
    // the one record that exists to be read closely.
    //
    // Applied to the four declines the ladder actually produces:
    //
    //   `already_resolved` — the two are ALREADY one customer. Nothing was
    //     decided; the question was moot before it was asked.
    //   `kind_mismatch` — a person and a business share a phone. The rung's
    //     condition simply did not hold, so no candidate was ever formed.
    //     (Reachable for the first time since #60; the rule decides it, not
    //     its novelty.)
    //   `unmerge_standing` — a decision IS honoured here, but it is
    //     somebody else's and it is already chained: `entity_unmerge`
    //     records it, and its standing is the reason nothing happened.
    //     A second entry would record the same act twice.
    //   a cycle, and the store's unique-violation race — both THROW before
    //     any row exists, and both are the caller's error rather than the
    //     ladder's decision. `fileMerge` is not reached.
    //
    // So the predicate is `performed:%` rather than `TRUE`: every outcome
    // this writer produces today is a performed merge, and the rule above
    // is what a future outcome is measured against instead of this list.
    entryPredicate: "c.outcome LIKE 'performed:%'",
    join: {
      kind: "per_act",
      relation: "ledger.entity_merges",
      // The merge id is server-minted, so — unlike `entity_kind`, whose
      // subject is a client-minted entity id — it needs no company prefix
      // to be unambiguous. `unmergeRef` also carries a `merge:` token, so
      // the class's own action word is what keeps the two apart.
      actsSql: `SELECT 'entity_merge ' || m.id AS subject,
                       'merge:' || m.id AS ref_token
                  FROM ledger.entity_merges m`,
    },
  },
  {
    id: "entity_unmerge_reversed",
    action: "entity_unmerge",
    what: "An operator took back a merge the system made without asking anybody.",
    source:
      'ADR-0035, amendment 2026-08-30: "The operator invokes it, audit-chained", in ADR-0016\'s break-glass shape.',
    callers: ["aperture"],
    entryPredicate: "c.outcome = 'reversed'",
    join: {
      kind: "per_act",
      relation: "ledger.entity_unmerges",
      actsSql: `SELECT 'entity_unmerge ' || u.id AS subject,
                       'unmerge:' || u.id AS ref_token
                  FROM ledger.entity_unmerges u`,
    },
  },
  {
    id: "entity_unmerge_refused",
    action: "entity_unmerge",
    what: "An operator's unmerge that was told no: an edge that does not exist, or one already reversed.",
    source:
      'ADR-0035, amendment 2026-08-30: "The chain records the refused and repeated attempts too, with their own outcomes: a break-glass verb is where \'somebody tried and was told no\' is the question."',
    callers: ["aperture"],
    entryPredicate: "c.outcome <> 'reversed'",
    join: {
      kind: "unjoinable",
      why: "A refused unmerge inserts no reversal row. The typed error is thrown after the aperture unit commits its entry, so the chain entry is the only trace the attempt leaves — there is no second row to join it against.",
    },
  },
  {
    id: "shadow_lift",
    action: "shadow_lift",
    what: "The launch gate opened for one company: the operator ran the lift act, its existing entity and fact rows stopped being shadow, and everything filed for it afterwards lands owner-visible.",
    source:
      'ADR-0016, amendment 2026-09-02: "**Lifting is one audited act per company**: set the timestamp and flip that company\'s existing entity and fact rows, in one transaction, chained under ADR-0020, refusing to run twice." Spec #126 decision 19 says the same in the slice\'s own words: "`rig-lift-shadow` takes a company id, sets `shadow_lifted_at`, flips that company\'s rows, writes one audit entry, and refuses to run twice."',
    // NOT decision 18: a lift is neither a rep act nor a refusal of one —
    // no rep is in it at all — and a reader sent to that sentence would
    // find nothing about the act they are looking at. It is the
    // `entity_merge_performed` case: ADR-0020's coverage claim is about
    // TRUST MECHANISMS, and the switch deciding whether an owner may read
    // anything is exactly one.
    violationCitation: "ADR-0020, ADR-0016 as amended, spec #126 decision 19",
    callers: ["aperture"],
    // `TRUE`, and it can be, because a REFUSED LIFT WRITES NOTHING. The act
    // throws from inside its own unit, so a second run on the same company
    // leaves neither a row nor an entry — which is the ticket's "writes
    // nothing" acceptance criterion, and what keeps lifted companies and
    // `shadow_lift` entries exactly 1:1. `entity_unmerge` needs two classes
    // and a predicate apiece precisely because ADR-0035 asks IT to chain
    // its refusals; nothing asks that here.
    entryPredicate: "TRUE",
    join: {
      kind: "per_act",
      relation: "public.companies",
      // THE REGISTRY ROW IS THE ACT ROW, and it is written by a different
      // statement than the append — the `UPDATE companies SET
      // shadow_lifted_at` two statements above it — so an act that stopped
      // chaining still leaves this behind, which is the failure the whole
      // check exists to catch. `shadow_lifted_at IS NOT NULL` is the
      // enumeration because the column is set once and never unset: a
      // company carrying an instant is a company somebody lifted.
      //
      // WHAT THIS DOES NOT REACH, said out loud so the green is not read as
      // more than it is: a lift performed BEFORE this word existed would be
      // a lifted company with no entry, and would be reported — correctly —
      // as a violation. There are none, because nothing could set the
      // column before this ticket wrote the only writer for it.
      actsSql: `SELECT 'company ' || c.id AS subject,
                       'company:' || c.id AS ref_token
                  FROM public.companies c
                 WHERE c.shadow_lifted_at IS NOT NULL`,
    },
  },
  {
    id: "customer_send_refused",
    action: "customer_send",
    what: "The send-lock writer refusing a customer send for a reason somebody wrote down: the destination is off the hard allowlist, the twin is over its pacing thresholds (or has none configured at all — the fail-closed end of the same rule), or the rep is releasing a draft they already dismissed or one with a blank still open (ticket #342). On either surface since #224 — the thread's quoted affirmation and the dashboard's Enviar run the same writer, so both refuse the same way.",
    source:
      'Ticket #24 ACs: "A destination not on the hard send-allowlist is refused, and a content-free audit entry (caller identity, action type, opaque refs, outcome) is appended"; "pacing refusals are audit-chained". And spec #29 grilling decision 1, for the dismissal: "terminal — the draft leaves the queue, a later ‘va’ on it gets an audit-chained refusal". THE LIST STOPS THERE, and since 2026-08-31 that is a ruling rather than a silence: decision 18 restated those sentences and did not widen them, so the writer\'s remaining outcomes owe nothing (`customer_send_scope` in MUST_NOT_CHAIN below). One of them chains anyway — see the divergence recorded there.',
    // `req.minter` — the closed tap-minter set (ADR-0006), BOTH OF THEM since
    // #224. The dashboard mints ADR-0006's second tap and therefore refuses
    // one too, and the entry looks the same from a reader's side: the seam
    // module composes the four fields once, so an entry cannot say which
    // minter was holding a key. What differs is WHEN it lands — rep-web holds
    // no chain key, so it writes `send_refusals` and the lease holder chains
    // it at its next pass (`drainSendRefusals`). A refusal written while the
    // runtime is stopped is therefore an entry that is OWED rather than
    // missing, and this class cannot tell the two apart: it is unjoinable, so
    // its entry count is all it has. Recorded on the horizon, #117.
    callers: ["affirmation_matcher", "rep_web"],
    // THE ONE OUTCOME SUBTRACTED, and only that one (Codex r2). This class
    // is unjoinable, so its ENTRY COUNT is the only quantitative thing a run
    // can say about it — and since 2026-08-31 the ruling puts
    // `send_in_flight` outside the class while the writer still chains it,
    // so counting it here would inflate the number of refusals the
    // enumeration says are owed. The entry it writes is now matched by no
    // class's predicate, which is the honest shape for an entry that exists
    // and is not owed (`customer_send_scope` in MUST_NOT_CHAIN records it).
    //
    // SUBTRACTED RATHER THAN PINNED TO A LIST, deliberately: #78 recorded
    // that refusal reasons are open by design (`refused:<reason>`, ticket
    // #24 and ticket #62 both), and an enumerated allow-list here would
    // silently drop the next cited reason instead of counting it. One named
    // exclusion for one named divergence keeps that property.
    entryPredicate:
      "c.outcome LIKE 'refused:%' AND c.outcome <> 'refused:send_in_flight'",
    join: {
      kind: "unjoinable",
      why: "`refuse()` rolls back to the send-attempt savepoint before appending, so the attempt persists nothing but its entry. The seam's `affirmation_refused` marker cannot stand in either: it also covers the matcher's own `unresolved_draft` and the writer's `already_tapped`, both of which chain nothing (`unresolved_draft` in MUST_NOT_CHAIN below), and the refusal reason lives only in the notice's encrypted microcopy — so a count over that marker would demand entries for acts that deliberately have none.",
    },
  },
  {
    id: "execution",
    action: "execution",
    what: "An execution ran: a trigger created it with its own instructions, tools and context, and it ended in one of the eight dispositions — including `failed`, which is the runner's alone (spec #171 decision 11; widened at #178). The trigger record carries its occasion and its mechanism; one occasion has a record type, the owner twin's `owner_question` by `request`.",
    source:
      'ADR-0014 as amended: "Every unit of agentic work is an execution: something happens, a trigger fires, and that creates a workflow." Spec #126 decision 5(f) names the obligation in as many words — "one content-free audit-chain entry per execution (ADR-0020)" — and its user story 37 says why: "one content-free audit-chain entry per execution and per lift act, so that ADR-0020 covers the owner side from its first day". Both sentences predate this writer: #126 was published before #128 built the runtime and before #130 built the table joined below.',
    // NOT the coverage claim's usual pair. Spec #48 decision 18 is about REP
    // ACTS and refusals, and an execution is neither — it is an agent run on
    // the OWNER side of the wall, where no rep act happens at all. A reader
    // sent to decision 18 would find nothing about it.
    violationCitation: "ADR-0020, ADR-0014 as amended, spec #126 decision 5(f)",
    // The execution runtime, which is the only writer of this word:
    // `EXECUTION_CALLER` in `@dito/execution`, appended through the owning
    // app's injected chain. An entry under this action naming any other
    // caller is itself the finding.
    callers: ["execution"],
    // EVERY DISPOSITION, INCLUDING `failed`. A failed execution is the one a
    // reader most needs to find — a forged citation refused before it
    // rendered, a budget spent with no submission — so no outcome is
    // subtracted here.
    //
    // ...AND EVERY OWNER-SIDE OCCASION, WHICH IS ONE (ticket #172). The
    // predicate was `TRUE` while the owner twin was the only execution in
    // the system. It is not any more: the rep side writes `execution`
    // entries onto `public.audit_chain`, which this class also reads, so a
    // bare `TRUE` would make this class's entry TALLY a count of both sides
    // — a number reported beside `owner.executions`' act count that is not
    // about those acts. The token is the one an owner-side reference always
    // carries and a rep-side one never can: `triggerRef` renders the
    // occasion, and `owner_question` is the owner side's only one. The two
    // classes therefore partition the action word exactly, which is the
    // shape the `fact_retraction` pair above already has over `outcome`.
    entryPredicate: "c.ref LIKE '%owner_question:%'",
    // EITHER CHAIN, AND THE ARGUMENT THAT MAKES THAT SAFE (ticket #165;
    // #157 Q4).
    //
    // The owner twin appended to `public.audit_chain` from #130 until #165,
    // and to `owner.audit_chain` after it. The rig's pre-cutover entries stay
    // where they are: re-appending them onto the new chain would mean
    // computing links the owner never wrote, which is forging history — the
    // one thing the chain exists not to allow. So this class accepts an entry
    // on either chain.
    //
    // WHY THAT IS NOT A HOLE. A widened join is normally a way to hide a
    // missing entry: an act with no entry HERE might have one THERE. It is
    // safe here because after #165's migration there is no writer that can
    // put a NEW execution entry on the shared chain — `dito_owner` holds no
    // privilege at all on `public.audit_chain`, and FR-71a's claim 6 goes red
    // on any grant that would give it one, in a check CI runs on every push
    // with the violation planted in both directions
    // (`invariants.int.test.ts`). The transition is bounded by a GRANT, not
    // by a date, which is why this needs no cutover timestamp and could not
    // be made honest with one.
    chains: [SHARED_CHAIN, OWNER_CHAIN],
    join: {
      kind: "per_act",
      relation: "owner.executions",
      // ONE ROW PER EXECUTION, written by a DIFFERENT statement than the
      // append: the runner appends inside the owning app's transaction and
      // the app then INSERTs the record, so an app that stopped chaining
      // still leaves this row behind — which is the failure this whole check
      // exists to catch.
      //
      // THE TOKEN IS THE QUESTION'S ID, not the execution's, because that is
      // what the entry can carry: `triggerRef` renders the TRIGGER, which is
      // `company:<id> owner_question:<id>`, and the execution's own id is
      // minted by the app after the run. The unique constraint on
      // `owner_question_id` is what keeps that one act per row.
      actsSql: `SELECT 'execution ' || e.id AS subject,
                       'owner_question:' || e.owner_question_id AS ref_token
                  FROM owner.executions e`,
    },
  },
  {
    id: "rep_execution",
    action: "execution",
    what: "A REP-SIDE execution ran, on either of the two occasions this side has: a settled customer turn woke the drafting automation, which read the turn, could look through the chat's own memory, and ended `drafted`, `no-action` or `failed` (ticket #172; spec #171 decisions 12, 14 and 15); or a rep message in the twin thread woke the thread automation, which read what the rep meant, could look through every chat of theirs, and ended `answered`, `no-action` or `failed` (ticket #173; spec #171 decision 19). The trigger record carries its occasion and its mechanism — `chat_turn` or `twin_thread_message`, both by `seam_event` — and its reference names the twin and the events, never a chat and never what anybody said. This class is stated as the complement of the owner's, so each rep-side occasion #174 to #176 adds is covered without an edit here.",
    source:
      'Spec #171 decision 12 states the obligation in as many words: "One content-free entry per execution on `public.audit_chain` under the rep key, through an adapter that implements the runtime\'s chain interface — the first code that writes an `execution` act on the rep chain. Audit coverage\'s `execution` class is required on the rep side from this slice." Its user story 26 says why: "As the dev-owner, I want every twin turn on the rig to leave an execution record and a chain entry, so that steering has the same evidence on the rep side the owner side already has." Both sentences are the spec\'s and predate this writer.',
    // NOT the coverage claim's usual pair, for the same reason the owner
    // side's class is not: spec #48 decision 18 is about REP ACTS and
    // refusals, and an execution is a twin's own run rather than an act
    // anybody performed. A rep is in the picture here — it is their twin,
    // their chat and their draft — but the act they will perform is the tap,
    // and that is `customer_send`'s class.
    violationCitation: "ADR-0020, ADR-0014 as amended, spec #171 decision 12",
    // The execution runtime, the only writer of this word: `EXECUTION_CALLER`
    // in `@dito/execution`. The rep-side adapter injects a chain that
    // appends through `appendAuditEntry` and rewrites nothing about the
    // entry, so the caller is the runtime's on both sides of the wall — and
    // an entry under this action naming any other caller is itself the
    // finding.
    callers: ["execution"],
    // THE REP CHAIN'S OWN ENTRIES, which is every `execution` entry that is
    // not the owner twin's. Stated as the complement rather than as a list
    // of rep-side occasions, and that is deliberate: #173 added the twin
    // thread's without touching this line and #174–#176 each add one more,
    // where a list here would be a second place every one of them has to edit
    // — while the owner side has exactly one occasion and will never have
    // another (the owner web is a request from a server action, ADR-0002).
    // The two classes partition the word (`audit-coverage.test.ts`).
    entryPredicate: "c.ref NOT LIKE '%owner_question:%'",
    // THE REP CHAIN ONLY. `public.audit_chain` is where the rep side has
    // always written and the only chain the runtime holds a key for; the
    // owner class reads both because #165 moved its writer mid-history and
    // its pre-cutover entries stay where they were. Nothing moved here, so
    // nothing to widen — and a widened join is how a missing entry hides.
    chains: [SHARED_CHAIN],
    join: {
      kind: "count",
      relation: "public.executions",
      // COUNT, AND THE REASON IS THAT ONE TRIGGER CAN RUN TWICE (ticket
      // #172 AC 8, as #240 leaves it). A per-act join needs a token in the
      // reference that names ONE execution, and the owner side has one —
      // `owner_question_id`, UNIQUE on its table, because an owner asks a
      // question once. The rep side has no such token and must not.
      //
      // WHAT MAKES A SECOND RUN UNDER ONE REFERENCE REACHABLE, said as this
      // build reaches it: a kind classification the model refuses is asked
      // again from the UNCROSSED BINDING rather than from the rep's event
      // (`crossPendingBindings`, at every start), and its trigger renders from
      // the twin, the chat and the entity — so the second run's reference is
      // identical to the first's. Two acts under one token is precisely the
      // shape that lets one entry cover two rows, which is what the owner's
      // UNIQUE exists to prevent, so the honest join here is the arithmetic
      // one.
      //
      // WHAT IT CATCHES AND WHAT IT DOES NOT. It catches the failure this
      // check exists for, and catches it when one trigger runs twice: every
      // record is written beside its own append, so a consumer that stopped
      // chaining — or that committed a record in a transaction the append
      // was not in — leaves acts above entries, and the run says so with
      // both numbers. What it cannot do is NAME the row, and it is
      // one-directional: an entry with no record is a different defect (a
      // writer that chained and then failed to persist), and the runner
      // makes that one unreachable by appending fail-closed before it
      // returns anything to persist.
      actsSql: "SELECT count(*)::bigint AS n FROM public.executions",
    },
  },
  {
    id: "scope_change",
    action: "scope_change",
    what: "The rep scoped a chat in or out: on the way in the twin may read that conversation from now on and the plane owes it the last ninety days; on the way out the capture guard drops its next message at the socket, on the same uncached allowlist read (ticket #222). Both directions carry an entry, and its outcome says which direction it was and whether the allowlist actually moved — a rep tapping a switch that was already in that position has still performed an act.",
    source:
      'ADR-0003 class 2 is "rep acts (confirmations, corrections, retractions, entity create/rename/merge): each must reference verifiable rep-act evidence", and spec #48 decision 18 quantifies over it: "Rep acts and refusals are audit-chained (ADR-0020)." Scoping is the rep act every other one rests on — a fact can only be filed from a conversation the rep admitted — and spec #214 decision 5 names it among the acts the runtime performs as rep acts: "Rep acts from the dashboard (retract, confirm or decline a binding, scope in or out, later notepad edits) go through the API as rep acts with the dashboard action as evidence." All three sentences predate this writer.',
    // The rep-act sentence governs it, so the coverage claim's usual pair is
    // the right citation and this class needs none of its own.
    callers: ["twin-runtime/scoping"],
    entryPredicate: "TRUE",
    chains: [SHARED_CHAIN],
    join: {
      kind: "per_act",
      relation: "public.plane_requests",
      // THE REQUEST ROW IS THE ACT'S OTHER TRACE, written by a DIFFERENT
      // statement than the append inside the same transaction — so a writer
      // that stopped chaining still leaves it behind, which is the failure
      // this whole check exists to catch.
      //
      // AND IT IS THE ONLY ROW THAT COULD SERVE. The allowlist cannot: it is
      // CURRENT state with no history of its own, so a scope-out leaves
      // nothing there at all and a chat scoped in and back out leaves that
      // store looking exactly as it did before — which is also why this act
      // owes an entry in the first place.
      //
      // THE PAIRING-CODE ASK IS NOT A SCOPE ACT and is excluded by kind: it
      // is a link credential the rep asked for rather than a statement about
      // what the twin may read, and `link.ts` writes it with no chain entry
      // because nobody chose a target. Counting it here would demand an
      // entry no act produces.
      actsSql: `SELECT 'scope ' || r.kind || ' ' || r.id AS subject,
                       'request:' || r.id AS ref_token
                  FROM plane_requests r
                 WHERE r.kind IN ('scope_in', 'scope_out')`,
    },
  },
];

/** One class of act that deliberately produces no entry. */
export interface MustNotChainClass {
  /** Stable id, used in the report. */
  readonly id: string;
  /** What the act is. */
  readonly what: string;
  /** THE SENTENCE THAT KEEPS IT OUT. Never a call site. */
  readonly source: string;
  /** The relation the count reads, declared for the same reason `ActJoin`'s is. */
  readonly relation: string;
  /**
   * WHAT ONE ROW OF `countSql` IS, in the domain's own words, so the printed
   * number says what it counted.
   *
   * Required, and not decoration. The store's grain is not always the
   * class's: `affirmation_refused` is one marker over several refusal
   * reasons, and a successful send is the only customer-send outcome that
   * leaves a row at all. A number printed beside a class id the reader takes
   * for its exact size is the quiet kind of lie this whole module exists to
   * refuse, so the phrase travels with the number.
   */
  readonly counted: string;
  /**
   * SQL returning one row, one `bigint`: how many acts of the kind `counted`
   * names this corpus holds. Reported, never demanded — so a reader sees
   * what the green knowingly passed over rather than assuming the chain
   * covers it.
   */
  readonly countSql: string;
}

/**
 * THE MUST-NOT-CHAIN SET.
 *
 * Counted in every run and demanded of nothing. The numbers are the point:
 * "0 violations" beside "312 candidate facts deliberately unchained" is a
 * different statement from "0 violations" alone.
 */
export const MUST_NOT_CHAIN: readonly MustNotChainClass[] = [
  {
    id: "class_1_candidate_facts",
    what: "A candidate fact filed by extraction under the confidence gate.",
    source:
      'ADR-0003: "Class 1 — candidate facts: model output, untrusted, confidence-gated". Spec #48 decision 18 chains rep acts and refusals, and a candidate fact is neither. Extraction files them by the hundred, so chaining them would bury the acts the chain exists to make auditable.',
    relation: "ledger.facts",
    counted: "fact(s) filed in the Ledger",
    countSql: "SELECT count(*)::bigint AS acts FROM ledger.facts",
  },
  {
    id: "finalization",
    what: "A fact going final 24h after its disclosure line became rep-reachable.",
    source:
      "ADR-0004's provisional window and ticket #54 AC 5: finalization is the clock, not anybody's act. ADR-0003 class 2 requires every rep act to reference verifiable rep-act evidence, and a fact nobody corrected has none — there is no actor to name as caller.",
    relation: "ledger.facts",
    counted: "fact(s) gone final",
    countSql:
      "SELECT count(*)::bigint AS acts FROM ledger.facts WHERE finalized_at IS NOT NULL",
  },
  {
    id: "unresolved_draft",
    what: "The affirmation matcher refusing a quoted ‘va’ whose draft post the executor never recorded a message id for: the rep is told, and nothing is minted or chained.",
    source:
      'Diego\'s ruling of 2026-08-31: "the ‘va’ never resolved to any act, so there is no rep act to record. This is not \'the rep tried to send X and was refused\' — it is \'we could not tell what the rep meant.\'" Spec #48 decision 18\'s "refusals" quantifies over rep ACTS, and ADR-0003 class 2 defines a rep act as one bound to verifiable rep-act evidence, which an unresolvable reply produces none of. THE CONTRAST THAT MAKES IT COHERENT rather than arbitrary: the matcher\'s own `correction_refused` IS chained (`fact_retraction_refused` above), because there the rep named a definite line and the system declined — a definite act, refused. Here nothing definite was attempted.',
    relation: "wa_event_processing",
    // THE SEAM'S MARKER IS THE FINEST GRAIN THE STORE HAS for this act, and
    // the phrase says so rather than letting the number be read as this
    // class's own size. The refusal REASON is never stored: it survives only
    // as microcopy inside the notice's encrypted content, so no query can
    // separate this class from the writer's cited refusals (which chain) or
    // from `already_tapped` (which does not). That is the same property
    // `customer_send_refused` gives as its reason for being unjoinable.
    counted:
      "‘va’ refusal(s) at the seam — this class among them, and not separable, since the reason is stored nowhere",
    countSql:
      "SELECT count(*)::bigint AS acts FROM wa_event_processing WHERE disposition = 'affirmation_refused'",
  },
  {
    id: "customer_send_scope",
    // THE ACT IS THE WRITER ACCEPTING THE SEND, not the rail delivering it
    // (Codex r2). The tap and its command commit before anything is
    // attempted, and what happens on the wire afterwards — sent, held,
    // failed, still pending — is the executor's business and FR-70's, never
    // this class's: the rep's «va» was honoured either way, and that is the
    // act the ruling excuses from the chain.
    what: "The customer-send outcomes that owe no entry: a send the WRITER ACCEPTED — the tap and its command written, whatever the rail did next — and the writer's `no_valid_tap`, `already_tapped` and `send_in_flight` refusals.",
    source:
      'Diego\'s ruling of 2026-08-31: spec #48 decision 18 RESTATED the earlier, narrower sentences and did not widen them. Read in its own paragraph, its headline is "Dispositions grow, machinery doesn\'t" and its body says the refusal taxonomy and the hash-chained audit "are unchanged" — a decision announcing that cannot coherently expand the audit\'s scope in its own closing clause. So the set stays what ticket #24\'s ACs named (the allowlist and pacing refusals) plus spec #29 grilling decision 1 (a dismissed draft\'s later ‘va’), which are the three in `customer_send_refused` above. And the principle behind the ruling: THE CHAIN COVERS ACTS WHOSE ONLY TRACE IT WOULD BE — a successful send is not one, because FR-70 already reconciles the tap against its command.',
    relation: "taps",
    // A DIVERGENCE, RECORDED AND NOT REPAIRED. `send_in_flight` chains today
    // — `writer.ts` reaches it through `refuse()`, on the strength of a
    // review answer during ticket #25's build — and under this ruling it
    // should not. Removing a chain entry is a change to a writer and belongs
    // to whoever owns that writer, not to an enumeration: an entry that
    // exists and is not owed is a smaller defect than an act that owes one
    // and has none, and this list's whole discipline is that it records what
    // the sentences say rather than what the code does.
    //
    // A COMMITTED TAP IS AN ACCEPTED CUSTOMER SEND, exactly: `taps.minter`
    // is CHECK-constrained to `affirmation_matcher`, and every refusal path
    // rolls back to the send attempt's savepoint, taking the tap with it. So
    // this counts the sends the writer let through and nothing else. It says
    // NOTHING about delivery, and must not be read as saying it: a command
    // may still be pending, held or failed on the rail, and the act this
    // class excuses happened at the writer either way.
    //
    // It is also the whole of what the class CAN show, because the other
    // three outcomes persist nothing: two return before writing anything at
    // all, and `send_in_flight` leaves only the chain entry it should not
    // have.
    counted:
      "customer send(s) the writer accepted (delivery is FR-70's question, not this one) — the three refusals in scope leave no row behind to count, and `send_in_flight` chains an entry this ruling says it should not",
    countSql: "SELECT count(*)::bigint AS acts FROM taps",
  },
  {
    id: "draft_dismissal",
    what: "The rep's terminal ‘no va’ on a draft: the anti-tap row and the framed ack are its whole record.",
    source:
      'Diego\'s ruling of 2026-08-31, the same one that settles `customer_send_scope`: spec #48 decision 18 restated rather than widened. Spec #29 grilling decision 1 defines the verb — "terminal — the draft leaves the queue, a later ‘va’ on it gets an audit-chained refusal" — and is precise about the LATER REFUSAL while silent about the dismissal. Under the ruling\'s principle, the chain covers acts whose only trace it would be, and this is not one: the dismissal writes its own `draft_dismissals` row pinned to the rep\'s raw plane-delivered event, so unlike a refusal it is not a rep act that vanishes.',
    relation: "draft_dismissals",
    // ONE ROW PER DISMISSED DRAFT, not per «no va»: the insert is ON CONFLICT
    // (draft_id) DO NOTHING, so a repeat dismissal is acked and adds no row.
    // The phrase says drafts for that reason.
    counted: "draft(s) the rep dismissed",
    countSql: "SELECT count(*)::bigint AS acts FROM draft_dismissals",
  },
];

/**
 * An act this enumeration does not check: nothing settled it, or something
 * settled it and no writer has arrived to obey.
 */
export interface UndecidedClass {
  readonly id: string;
  /** What the act is, and what the code does with it today. */
  readonly what: string;
  /**
   * Why it is open — the sentences that pull in both directions, and which
   * way a ruling read them once one has landed.
   */
  readonly tension: string;
  /** What would settle it, or what settled it and what it now waits on. */
  readonly settles: string;
  /**
   * THE ONE LINE EVERY RUN PRINTS ABOUT IT.
   *
   * Carried per class rather than written once in the script, because the
   * two states this list can hold say opposite things: "nobody has ruled" and
   * "somebody ruled and the writer does not exist yet". A run that printed
   * the first sentence over the second would state something false in the
   * one report whose whole purpose is to be believed.
   */
  readonly standing: string;
}

/**
 * THE UNDECIDED SET — the list that keeps the other two honest.
 *
 * A must-chain list with no third bucket is a list that quietly decided
 * something. Each entry here is a real act that the check does NOT verify,
 * and every run prints it for exactly that reason: a green means "every act
 * that owed an entry has one" only over the classes above.
 *
 * IT IS EMPTY, AND THAT IS A STATEMENT. Every act this enumeration knows
 * about now has a verdict and a writer that obeys it. `entity_merge` was
 * the last entry: ruled must-chain on 2026-08-31 and unenforced, because
 * the merge path chained nothing. It chains now — `fileMerge` appends
 * inside the same unit as the edge — so it moved up to `MUST_CHAIN` where a
 * class is CHECKED rather than merely declared.
 *
 * KEEP THIS LIST EVEN THOUGH IT IS EMPTY. A third bucket that exists and is
 * empty is a different statement from one that was never there: it says the
 * next act with no accepted sentence behind it has somewhere to go, and it
 * says today's green is not resting on a question nobody asked.
  */
export const UNDECIDED: readonly UndecidedClass[] = [];

/**
 * What a coverage violation cites by default: the claim that coverage is
 * owed at all, and the sentence that says which acts owe it.
 */
const COVERAGE_CITATION = "ADR-0020, spec #48 decision 18";

/** One act that owes an entry and has none — or one word nobody declared. */
export interface CoverageViolation {
  /** The `MUST_CHAIN` class id, or `vocabulary` for an undeclared word. */
  readonly class: string;
  /** What is missing coverage: the act, or the word. */
  readonly subject: string;
  readonly reason: string;
}

/** What the check found for one class. */
export interface CoverageTally {
  readonly class: string;
  readonly action: AuditAction;
  readonly join: "per_act" | "count" | "unjoinable";
  /** How many acts of this class the corpus holds; null when unjoinable. */
  readonly acts: number | null;
  /** How many chain entries match this class. */
  readonly entries: number;
  /** Present when unjoinable: why no check can be written. */
  readonly unjoinableWhy?: string;
  /**
   * WHAT THIS DATABASE DOES NOT HAVE, so no act of this class could be
   * checked here — either the class's own act relation, or (since #165)
   * every chain it declares, named as `"a or b"`.
   *
   * Reported rather than skipped: the check runs against rig data, and the
   * rig is routinely behind `main` — "this database predates the verb" is a
   * true and useful answer, and a silent skip would not be. The two causes
   * share one field because they mean the same thing to a reader — there is
   * nothing here to compare — and the string says which it was.
   */
  readonly absentRelation?: string;
}

/** The verdict over one corpus. */
export interface ChainCoverageReport {
  /**
   * Every entry on every chain a class declares, however it got there — the
   * rep side's and, since #165, the owner side's per-company chain.
   */
  readonly entries: number;
  /** Acts examined by a join that can name them (`per_act` and `count`). */
  readonly checkedActs: number;
  /**
   * The must-chain classes this run actually examined, and the ones it
   * could not — because no join reaches them, or because their relation is
   * not in this schema.
   *
   * Reported so a green can say what it covers rather than implying it
   * covers everything: "every act that owed an entry has one" is only true
   * of the classes in `checkedClasses`, and a reader who is not told which
   * those are will read it as absolute.
   */
  readonly checkedClasses: number;
  readonly uncheckedClasses: number;
  /**
   * Act classes this run does not check — `UNDECIDED`, with the line each
   * one has a run say about it.
   *
   * Carried in the REPORT, not only in the source, because a run that did
   * not mention them would let a green be read as "every act is
   * classified". It is not (ticket #78, Codex r3). The line travels with the
   * id because the reasons differ: one class is unruled, another is ruled
   * and has no writer yet, and a report that said the same sentence over
   * both would say something false about one of them.
   */
  readonly undecidedClasses: readonly {
    readonly id: string;
    readonly standing: string;
  }[];
  readonly mustChain: readonly CoverageTally[];
  /** Acts deliberately NOT demanded an entry — counted so the green is readable. */
  readonly mustNotChain: readonly {
    readonly class: string;
    /** null when the class's relation is not in this schema. */
    readonly acts: number | null;
    /** What one counted row is, so the number says what it counted. */
    readonly counted: string;
  }[];
  readonly violations: readonly CoverageViolation[];
}

/**
 * Coverage over the chain stored on `client`.
 *
 * Read-only throughout: this is an audit, and it is run against the rig's
 * live database as well as CI's corpus.
 */
export async function auditChainCoverageInDb(
  client: pg.ClientBase,
): Promise<ChainCoverageReport> {
  const violations: CoverageViolation[] = [];
  const mustChain: CoverageTally[] = [];
  let checkedActs = 0;

  for (const cls of MUST_CHAIN) {
    // WHICH CHAIN(S) THIS CLASS READS, resolved once per class (#165). A
    // database that holds none of them has no chain to look in, which is the
    // same statement `absentRelation` already makes about a class's ACT
    // relation — so it is reported the same way rather than as zero entries.
    const chain = await chainSource(client, chainsOf(cls));
    const entries = chain === null ? 0 : await countEntries(client, cls, chain);
    // Resolved once per class, so the default lives in one place and the
    // two violation shapes below cannot drift apart.
    const citation = cls.violationCitation ?? COVERAGE_CITATION;
    if (cls.join.kind === "unjoinable") {
      mustChain.push({
        class: cls.id,
        action: cls.action,
        join: "unjoinable",
        acts: null,
        entries,
        unjoinableWhy: cls.join.why,
      });
      continue;
    }
    if (chain === null || !(await relationExists(client, cls.join.relation))) {
      mustChain.push({
        class: cls.id,
        action: cls.action,
        join: cls.join.kind,
        acts: null,
        entries,
        absentRelation:
          chain === null ? chainsOf(cls).join(" or ") : cls.join.relation,
      });
      continue;
    }
    if (cls.join.kind === "per_act") {
      const acts = await scalar(
        client,
        `SELECT count(*)::bigint AS n FROM (${cls.join.actsSql}) a`,
      );
      // The act rows with no entry naming them. `ref` is a space-delimited
      // list of `label:value` tokens (the shape `apertureRef` and the send
      // writer both use), so the token is matched whole — `event:1` must
      // never satisfy an act whose event is 12.
      const missing = await client.query<{ subject: string }>(
        `SELECT a.subject
           FROM (${cls.join.actsSql}) a
          WHERE NOT EXISTS (
                SELECT 1 FROM ${chain} c
                 WHERE c.action = $1
                   AND c.caller = ANY($2)
                   AND (' ' || c.ref || ' ') LIKE ('% ' || a.ref_token || ' %')
                   AND (${cls.entryPredicate})
                )
          ORDER BY a.subject`,
        [cls.action, cls.callers],
      );
      for (const row of missing.rows) {
        violations.push({
          class: cls.id,
          subject: row.subject,
          reason: `no \`${cls.action}\` chain entry records this act (${citation})`,
        });
      }
      checkedActs += acts;
      mustChain.push({
        class: cls.id,
        action: cls.action,
        join: "per_act",
        acts,
        entries,
      });
      continue;
    }
    // COUNT. The act leaves a row but no stored path back to the id the
    // entry names, so the claim is arithmetic: at least as many entries as
    // acts. One-directional on purpose — an entry with no act is a
    // different defect (a writer that chained but did not mark), and
    // coverage is the question of acts that went unrecorded.
    const acts = await scalar(client, cls.join.actsSql);
    if (entries < acts) {
      violations.push({
        class: cls.id,
        subject: `${acts} act(s), ${entries} entr${entries === 1 ? "y" : "ies"}`,
        reason: `${acts - entries} \`${cls.action}\` act(s) of this class have no chain entry (${citation})`,
      });
    }
    checkedActs += acts;
    mustChain.push({
      class: cls.id,
      action: cls.action,
      join: "count",
      acts,
      entries,
    });
  }

  const mustNotChain: { class: string; acts: number | null; counted: string }[] =
    [];
  for (const cls of MUST_NOT_CHAIN) {
    mustNotChain.push({
      class: cls.id,
      acts: (await relationExists(client, cls.relation))
        ? await scalar(client, cls.countSql)
        : null,
      counted: cls.counted,
    });
  }

  // THE VOCABULARY FENCE, ENFORCED OVER DATA. The type on
  // `AuditEntry.action` stops a TypeScript call site inventing a word; it
  // cannot reach a `.mjs` script, a psql session, or a build older than
  // this one. A word in the store that this build does not declare is
  // therefore a finding in its own right — either somebody wrote outside
  // the vocabulary, or the vocabulary lost a word it still owes a reader.
  //
  // OVER EVERY CHAIN ANY CLASS DECLARES, not just the shared one (#165).
  // Reading one table was the whole store until the owner side got its own,
  // and leaving it there would have quietly stopped covering the owner's
  // entries on the day its writer moved — a component writing owner-side
  // under a word nothing declares, unnoticed by the check written to find
  // exactly that.
  const everyChain = await chainSource(client, [
    ...new Set(MUST_CHAIN.flatMap(chainsOf)),
  ]);
  const words = await client.query<{ action: string; caller: string }>(
    everyChain === null
      ? "SELECT NULL::text AS action, NULL::text AS caller WHERE false"
      : `SELECT DISTINCT action, caller FROM ${everyChain} c ORDER BY action, caller`,
  );
  for (const row of words.rows) {
    if (!isAuditAction(row.action)) {
      violations.push({
        class: "vocabulary",
        subject: `action "${row.action}"`,
        reason:
          "not in AUDIT_ACTIONS — a word this build does not declare, so nothing states which acts owe it an entry (ticket #78)",
      });
      continue;
    }
    // ...and the caller half. ADR-0020 records caller identity for a
    // reason, and `audit.ts` names the consequence: "a chain entry naming
    // any other caller for these actions is itself the finding". An entry
    // whose caller no class declares is a component writing to the chain
    // that nothing in the enumeration accounts for.
    const declared = MUST_CHAIN.some(
      (cls) => cls.action === row.action && cls.callers.includes(row.caller),
    );
    if (!declared) {
      violations.push({
        class: "vocabulary",
        subject: `caller "${row.caller}" on ${row.action}`,
        reason:
          "no must-chain class declares this caller for this action — a component is writing to the chain that the enumeration does not account for (ADR-0020, ticket #78)",
      });
    }
  }

  return {
    // Every entry on every chain a class declares (#165), so the number
    // beside "N violations" covers the same store the classes above were
    // checked against.
    entries:
      everyChain === null
        ? 0
        : await scalar(client, `SELECT count(*)::bigint AS n FROM ${everyChain} c`),
    checkedActs,
    undecidedClasses: UNDECIDED.map((open) => ({
      id: open.id,
      standing: open.standing,
    })),
    checkedClasses: mustChain.filter(
      (t) => t.join !== "unjoinable" && t.absentRelation === undefined,
    ).length,
    uncheckedClasses: mustChain.filter(
      (t) => t.join === "unjoinable" || t.absentRelation !== undefined,
    ).length,
    mustChain,
    mustNotChain,
    violations,
  };
}

/** How many chain entries this class's own predicate matches. */
async function countEntries(
  client: pg.ClientBase,
  cls: MustChainClass,
  chain: string,
): Promise<number> {
  const res = await client.query<{ n: string }>(
    `SELECT count(*)::bigint AS n FROM ${chain} c
      WHERE c.action = $1 AND c.caller = ANY($2) AND (${cls.entryPredicate})`,
    [cls.action, cls.callers],
  );
  return Number(res.rows[0]!.n);
}

/**
 * The chains `relations` names, as one relation to read entries from — the
 * present ones only.
 *
 * A SUBQUERY OVER THE PRESENT TABLES rather than a name, because a class may
 * declare more than one chain since #165 and because a database can predate
 * either of them: the rig trails `main`, and `relationExists` is already how
 * this module says "not in this schema" rather than raising 42P01 inside a
 * caller's transaction. Only the four content-free columns are selected, so
 * the two chains — which differ by `owner.audit_chain`'s `company_id` —
 * present one shape to every predicate and join above.
 *
 * Returns null when NONE of them is here, which the callers report as an
 * absent relation rather than as zero entries: "there is no chain to look in"
 * and "the chain holds nothing" are different statements.
 */
async function chainSource(
  client: pg.ClientBase,
  relations: readonly string[],
): Promise<string | null> {
  const present: string[] = [];
  for (const relation of relations) {
    if (await relationExists(client, relation)) present.push(relation);
  }
  if (present.length === 0) return null;
  return `(${present
    .map((relation) => `SELECT caller, action, ref, outcome FROM ${relation}`)
    .join(" UNION ALL ")})`;
}

/** The chains one class's entries may live on. */
function chainsOf(cls: MustChainClass): readonly string[] {
  return cls.chains ?? [SHARED_CHAIN];
}

/**
 * Whether a relation is in this schema.
 *
 * Declared per class rather than discovered by running the query and
 * catching `42P01`: a caller may be inside a transaction (the plant tests
 * are), and a failed statement there poisons it. Asking first is the only
 * shape that works in both.
 */
async function relationExists(
  client: pg.ClientBase,
  relation: string,
): Promise<boolean> {
  const res = await client.query<{ present: string | null }>(
    "SELECT to_regclass($1)::text AS present",
    [relation],
  );
  return res.rows[0]!.present !== null;
}

/** One bigint out of a one-row query. */
async function scalar(client: pg.ClientBase, sql: string): Promise<number> {
  const res = await client.query<Record<string, string>>(sql);
  return Number(Object.values(res.rows[0]!)[0]);
}

/**
 * Script entry: coverage over the chain at `databaseUrl` (rig data or CI's
 * corpus). Constructs its own client so callers stay dependency-free, the
 * same shape `verifyAuditChainAt` has.
 */
export async function auditChainCoverageAt(
  databaseUrl: string,
): Promise<ChainCoverageReport> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    return await auditChainCoverageInDb(client);
  } finally {
    await client.end();
  }
}
