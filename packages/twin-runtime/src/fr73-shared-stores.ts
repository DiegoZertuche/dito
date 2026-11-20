/**
 * FR-73's second registry (ticket #50; spec #48 grilling decision 9): the
 * rep-side stores that live in SHARED POSTGRES rather than in the bundle.
 *
 * fr73.ts's original enumeration is the bundle's own live schema, which is
 * what makes every store it lists bundle-resident by construction. Shared
 * Postgres has no such property — a table is just a table — so this half
 * is a DECLARED registry checked against the live catalog in both
 * directions: a table nobody declared fails the audit, and a declaration
 * with no table fails it too. That is the mechanism behind "a new rep-side
 * store that is not on the exception list still fails the audit."
 *
 * Every declaration carries its custody, and the custody classes are the
 * argument for why FR-73's erasure story survives the store existing:
 *
 *   dek-ciphertext     — rep CONTENT sealed under the twin DEK (ADR-0008).
 *                        Key destruction at retirement erases it (ADR-0009).
 *   metadata-envelope  — plaintext routing metadata by ADR-0005's design,
 *                        alongside content that is sealed. No rep content.
 *   no-rep-content     — operational, configuration or content-free
 *                        bookkeeping. Nothing of the rep's is in it.
 *   recorded-exception — rep-facing content in the CLEAR, with a written
 *                        justification. This is the class ADR-0003
 *                        deliberately opened, and the only one that must
 *                        argue for itself.
 *
 * The `ledger` schema is not swept here and never joins this registry: it
 * is company-owned by design — the far side of the aperture — and its
 * governance is the grant audit and FR-72, not the erasure story. Every
 * other schema IS swept, so a rep-side store cannot dodge the registry by
 * being born somewhere new.
 *
 * IT SHRANK BY TWO AT TICKET #218, the first time this registry has lost
 * anything (spec #214 decision 3): the candidate-question store and the
 * twin-side record of which post asked which question are dropped with their
 * route. The declarations go with them BECAUSE THE AUDIT DEMANDS IT — a
 * declaration whose table is not in the catalog fails this audit in the other
 * direction — so the removal is obligatory rather than tidy.
 *
 * `posts` IS HERE FOR THE REASON `notices` IS (ticket #220): the record every
 * twin post is, whose parts are sealed under the twin DEK like a notice's own
 * words — so key destruction at retirement erases them (ADR-0009) and FR-73's
 * erasure story is unchanged by the store existing.
 *
 * `sessions` AND `login_codes` ARE THE DASHBOARD'S OWN LOGIN (#221), and with
 * `invitations` and `acknowledgments` beside them (#223) they are the only
 * stores in this registry that hold no reference to a conversation of any kind
 * — which is why their class is argued at length beside them rather than
 * cited.
 *
 * THE CHAT DIRECTORY IS THE ONE ENTRY WHOSE CLASS IS ARGUED RATHER THAN CITED
 * (ticket #222), because it is the only store here that holds anything about a
 * chat the rep did NOT scope — which is the amendment that ticket writes into
 * ADR-0023. The plane's request seam and the per-twin history window arrive
 * beside it and cite their neighbours.
 */
import { APERTURE_REP_SIDE_STORES } from "@dito/aperture";
import type pg from "pg";

export type SharedStoreCustody =
  | "dek-ciphertext"
  | "metadata-envelope"
  | "no-rep-content"
  | "recorded-exception";

export interface SharedPostgresStore {
  readonly schema: string;
  readonly table: string;
  readonly custody: SharedStoreCustody;
  readonly note: string;
  /**
   * Why this store may hold rep-facing content in the clear. REQUIRED for
   * `recorded-exception` and refused on any other class: the exception is
   * the whole point of writing it down, and an exception with no argument
   * is the silent skip FR-73 exists to prevent.
   */
  readonly justification?: string;
}

/** Schemas outside FR-73's frame, each with the decision that put it there. */
export const OUT_OF_FRAME_SCHEMAS: Readonly<Record<string, string>> = {
  // The Ledger: company-owned, the far side of the aperture. Governed by
  // the grant audit and FR-72; it is not rep-side and never was.
  ledger: "company-owned Ledger data (ADR-0003/0004)",
  // The owner app's own state (ticket #127; spec #126 decision 3, and its
  // Testing Decisions say so in as many words: "FR-73 … store count
  // unchanged — the `owner` schema is owner-side, not rep-side"). Execution
  // records, questions and answers belong to the OWNER, on the far side of
  // the wall from everything this registry protects. The schema is created
  // by …100020 and its tables arrive with #130 and #131.
  //
  // #165 ADDED A FOURTH, `owner.audit_chain`, and it changes nothing here on
  // purpose: it is the OWNER's own hash chain, content-free by ADR-0020 —
  // caller, action, opaque refs, outcome — so it holds no rep content to be
  // bundle-resident or erased. The whole schema is out of frame with a
  // written reason, which is what keeps this a decision rather than a table
  // that slipped past an enumeration.
  owner: "the owner app's own state and its own audit chain — owner-side, not a rep-side store (spec #126 decision 3; #165)",
  // whatsmeow's own session store: device identity, socket keys, retry
  // buffers — transport material, library-managed (#22's recorded
  // disposition, ADR-0029's amendment).
  whatsmeow: "the plane's library-managed WhatsApp session store (#22, ADR-0029)",
  // Atlas's migration bookkeeping.
  atlas_schema_revisions: "the migration tool's own revision history (ADR-0029)",
};

/** Tables that are migration bookkeeping wherever they land. */
const TOOLING_TABLES = new Set(["atlas_schema_revisions"]);

/**
 * The registry. Adding a table to shared Postgres without adding it here
 * fails the audit — which is the point.
 */
export const SHARED_POSTGRES_STORES: readonly SharedPostgresStore[] = [
  {
    schema: "public",
    table: "wa_events",
    custody: "dek-ciphertext",
    note: "the inbound seam: a plaintext metadata envelope around a DEK-encrypted payload (ADR-0005/0008); message content is never in the clear",
  },
  {
    schema: "public",
    table: "wa_event_processing",
    custody: "no-rep-content",
    note: "one disposition per processed event — an outcome label, no content",
  },
  {
    schema: "public",
    table: "drafts",
    custody: "dek-ciphertext",
    note: "content_enc and post_enc are DEK envelopes (ADR-0008); the destination is routing metadata",
  },
  {
    schema: "public",
    table: "draft_timings",
    custody: "no-rep-content",
    note: "NFR-2 latency stamps",
  },
  {
    schema: "public",
    table: "draft_dismissals",
    custody: "no-rep-content",
    note: "the anti-tap: draft id and the raw event that dismissed it",
  },
  // A DRAFT'S BLANKS AND ITS FILL (ticket #342) are `draft_dismissals`' kind
  // of row: ids, a key a CHECK confines to a short lower-case identifier, and
  // an instant. The blank's label and question — the twin's words — are
  // sealed in the post's draft part; nothing here can hold a sentence.
  {
    schema: "public",
    table: "draft_blanks",
    custody: "no-rep-content",
    note: "one row per blank the twin left in a draft (ticket #342): the draft and the blank's key, a lower-case identifier by CHECK; the send lock refuses a draft with any row here. The label and the question are sealed in posts.parts_enc",
  },
  {
    schema: "public",
    table: "draft_fills",
    custody: "no-rep-content",
    note: "one row per draft a fill superseded (ticket #342): the old draft, the draft that took its place and the thread execution that wrote it, and an instant",
  },
  {
    schema: "public",
    table: "taps",
    custody: "no-rep-content",
    note: "the rep's affirmation of one draft: ids only",
  },
  // `send_refusals` IS THE RECORD OF A REFUSAL NOBODY COULD CHAIN YET
  // (ticket #224), and the class is the easy one to argue: two opaque ids, a
  // minter from a closed set, a reason word a CHECK confines to lower-case
  // letters, and two instants. There is no column here anybody could put a
  // chat address, a customer's name or a draft's body into — which is why
  // that shape CHECK is on the column rather than a comment about intent.
  //
  // CRYPTOGRAPHIC ERASURE REACHES IT AND NEED NOT, for `taps`' own reason:
  // there is nothing to erase. What survives retirement is the statement that
  // a send of some draft was refused, which is exactly what the chain entry it
  // names says too — and the chain is append-only by design.
  {
    schema: "public",
    table: "send_refusals",
    custody: "no-rep-content",
    note: "one row per send-lock refusal recorded by a minter that holds no audit-chain key (ticket #224; ADR-0002, ADR-0008): the twin, the draft, the minter, the reason word, and whether the lease holder has chained it yet. rep-web writes it because a chain key in the dashboard's environment would let the audited process write the record that audits it (ADR-0020)",
  },
  // `dashboard_acts` IS THE CLASS-2 EVIDENCE OF THE OTHER SURFACE (ticket
  // #224), and it is content-free by shape rather than by intent: four ids, a
  // verb from a closed set and one instant. What the act was ABOUT is not
  // here — the target lives in the store the act wrote — so there is no column
  // anybody could put a chat address, a customer's name or a draft's body into.
  //
  // CRYPTOGRAPHIC ERASURE REACHES IT AND NEED NOT, for `taps`' reason: there
  // is nothing to erase. What survives retirement is that a seat performed an
  // act of some kind at some instant, which is what the chain entry beside it
  // says too.
  {
    schema: "public",
    table: "dashboard_acts",
    custody: "no-rep-content",
    note: "one row per rep act performed on the dashboard (ticket #224; spec #214 decision 2): company, seat, twin, the verb from a closed set and the instant the rep tapped. The class-2 evidence of ADR-0003 on the surface that is not the twin thread — written only by the runtime's local API, and rep-web holds no privilege on it at all",
  },
  // `dashboard_messages` IS THE OTHER DOOR'S INBOUND STORE (ticket #261), and
  // it is `wa_events` one table over: a plaintext metadata envelope — four ids
  // and two instants — around the rep's own words under the twin DEK. There is
  // no text column outside `text_enc`, so a reader with the database and no key
  // learns that a rep typed something and when, and not one syllable of what.
  //
  // CRYPTOGRAPHIC ERASURE REACHES IT, which is the whole of why it may exist
  // outside the bundle (ADR-0009): key destruction at retirement takes the
  // words with it, and what survives is that a seat sent a message at an
  // instant — the same residue `dashboard_acts` beside it leaves.
  {
    schema: "public",
    table: "dashboard_messages",
    custody: "dek-ciphertext",
    note: "one row per message typed through Habla con Dito (ticket #261; spec #258): company, seat, twin, the login session, two instants, the card and printed line number a line edited in place points at (ticket #344) or the draft card and blank key an answer points at (ticket #342), and text_enc — the rep's own words under the twin DEK (ADR-0008). Written only by the runtime's local API; rep-web holds no privilege on it and no key to read it with",
  },
  // THE REP'S ARRIVALS ON INICIO (ticket #266) are metadata and nothing
  // else — a seat, an instant, a day and a word out of two — so there is no
  // content for the wall or for erasure to reach; their marker names an
  // execution and no more.
  {
    schema: "public",
    table: "rep_arrivals",
    custody: "no-rep-content",
    note: "one row per arrival on Inicio the local API recorded (ticket #266; spec #258 decision 15): company, seat, twin, the instant, the seat-local day, first_of_day or return, and the last arrival's instant. Metadata only — no column can hold anything the rep or a customer said; the twin's line for it is a post, sealed in posts.parts_enc",
  },
  {
    schema: "public",
    table: "rep_arrival_executions",
    custody: "no-rep-content",
    note: "the arrival's processing marker (tickets #266, #320, #358): the pass serves every arrival with none to the twin thread's turn, which writes it — the arrival, the twin, the execution that composed for it (none on a row marked overtaken), and when — the exactly-once lock and no content",
  },
  // THE REP'S OTHER WORDLESS ASKS (ticket #358) — a pick, a selection, a
  // summons — are ids and instants around the twin's own words, sealed: a
  // pick names the matter by the label the twin wrote, a selection carries
  // the phrase as the card shows it. Key destruction takes the words; what
  // survives is that a seat asked something about a card at an instant.
  {
    schema: "public",
    table: "rep_asks",
    custody: "dek-ciphertext",
    note: "one row per pick, selection or summons the local API accepted (ticket #358), keyed by the page's own id for it: company, seat, twin, the kind, the card or what a picked matter is about, the instant, and words_enc — the twin's own label or the card's phrase under the twin DEK (ADR-0008). Read by the runtime's pass alone",
  },
  {
    schema: "public",
    table: "rep_ask_processing",
    custody: "no-rep-content",
    note: "one disposition per ask the twin thread's turn answered (ticket #358) — the door's vocabulary, the exactly-once lock and no content",
  },
  // THE TWIN THREAD'S SESSIONS (ticket #319) are ids and instants: which
  // session a day is, what it carried from, where it keeps through. The
  // session itself is the SDK child's file in the twin's harness
  // directory, which the bundle half of this sweep reports as its gap.
  {
    schema: "public",
    table: "thread_sessions",
    custody: "no-rep-content",
    note: "one row per Agent SDK session the twin thread holds (ticket #319; spec #318 decisions 1 and 14): the twin, the seat-local day, the session id, the one it carried from, four instants, the last kept entry's id, the turn in flight's id, and a resume refusal's ids and entry types. Metadata only — the conversation is the child's file under the harness directory (FR-73's recorded gap)",
  },
  // WORKFLOW RUNS AND THE CLOCK (ticket #323; spec #318 decisions 22 and 26):
  // a run's coordination row, its step checkpoints, and the clock store the
  // pass fires from. The run's content is its SDK session file and its
  // sealed content file under the harness directory.
  {
    schema: "public",
    table: "runs",
    custody: "no-rep-content",
    note: "one row per workflow run (ticket #323; ADR-0012 as amended: run rows are opaque seam rows): the twin, the seat, the automation's registry word and the rutina's id when a rutina fired it, what woke it (a clock instant or an event's kind and id, ticket #325), the pinned definition digest, the parent, the session id, the state and current step, the budget and its spend, the paused and cancelled flags, who started it and five instants. Metadata only — the definition, inputs, outputs and guidance are the run's session and its content sealed under the twin DEK in the harness directory",
  },
  {
    schema: "public",
    table: "run_steps",
    custody: "no-rep-content",
    note: "one checkpoint per step of a run that began (ticket #323): its index and kind, its state, the execution it left, the post id a wait on a settle watches, two instants. Metadata only",
  },
  {
    schema: "public",
    table: "schedules",
    custody: "no-rep-content",
    note: "the clock store (tickets #323, #364; spec #318 decision 26): one row per wake the pass fires at an instant or on a cadence — the twin, the kind, the instant or the cadence (daily or weekly, the weekdays, the hour), the precondition a cadence names from a closed set, the run and step, the automation's row it wakes, the post a reminder is about and the subject it can lapse by from a closed set, when it fired, the instant a cadence last fired for (ticket #325), and when it ended. Metadata only, and never deleted",
  },
  // THE AUTOMATIONS AND THE PAUSE SWITCH (tickets #325, #364; spec #318
  // decisions 28 and 30; ADR-0014: content in the bundle, an opaque
  // coordination row in the seam): every automation's row — Dito's own and
  // the rutinas the twin authors — and the per-seat switch. A rutina's
  // definition and the twin's sentence are the bundle's `automation_definitions`;
  // Dito's definitions are code.
  {
    schema: "public",
    table: "automations",
    custody: "no-rep-content",
    note: "one row per automation of the seat (tickets #325, #364; ADR-0014 as amended): the twin, the seat, whose it is (Dito's, by its shipped name from a closed set, or a rutina the rep or the twin asked for), the FR-75 state, the pinned definition digest, the wake as metadata — a cadence's closed words and hour, a seam event's kind and a customer's bundle reference number, or one-shot rows only — the version it replaces, the execution that wrote it and four instants. Metadata only: a rutina's workflow definition, with any of the rep's words in its instructions, and the twin's sentence are the bundle's, under the twin's key",
  },
  {
    schema: "public",
    table: "automation_pauses",
    custody: "no-rep-content",
    note: "the pause switch on Rutinas (tickets #325, #364; spec #318 decision 30): one row per seat and automation whose switch the rep touched — the twin, the seat, the automation's row, whether it stands paused, and when it last changed. Metadata only",
  },
  // WHAT THE THREAD DECIDES THE REP SEES AND HEARS (ticket #320): the knock it
  // added after a card landed — its sentence sealed like a post's own parts —
  // and the canvas's curation, which is post ids in an order.
  {
    schema: "public",
    table: "post_knocks",
    custody: "dek-ciphertext",
    note: "one row per knock the twin thread added about a post after it landed (tickets #320, #364; spec #318 decisions 19 and 21): the post, the twin, the reminder's subject from a closed set when a fired reminder owed it, the execution, the instant, and text_enc — the lock-screen sentence under the twin DEK (ADR-0008), read by the runtime alone",
  },
  {
    schema: "public",
    table: "canvas_curations",
    custody: "dek-ciphertext",
    note: "one version per arrangement the twin thread wrote with move_cards (tickets #320, #322, #401): the twin, the top card's post id (the stored column keeps its name `spotlight`), the order of the rest by post id, the cards taken off, the execution, the instant, and offers_enc — the twin's lean-in sentences per card under the twin DEK (ADR-0008), read by the runtime alone",
  },
  // THE SPOTLIGHT (ticket #401): the one card the twin holds up, by post id.
  {
    schema: "public",
    table: "canvas_spotlights",
    custody: "no-rep-content",
    note: "one version per spotlight the twin thread wrote (ticket #401): the twin, the post id it holds up or NULL when it ended one, the execution, the instant — post ids and an instant, no content",
  },
  // THE OFFERS THE REP SPENT (ticket #335): the seat's own marks on the
  // twin's lean-in offers, the sentence each was sealed like the curation it
  // came from.
  {
    schema: "public",
    table: "offer_spendings",
    custody: "dek-ciphertext",
    note: "one row per lean-in offer the rep took, answered or let go (ticket #335): company, seat, twin, the card's post id, the reason, the instant, the seat-local day, and sentence_enc — the twin's offer sentence under the twin DEK (ADR-0008), read by the runtime alone",
  },
  {
    schema: "public",
    table: "dashboard_message_processing",
    custody: "no-rep-content",
    note: "one disposition per consumed door message — `wa_event_processing` for the other door, an outcome label and no content (ticket #261)",
  },
  {
    schema: "public",
    table: "notices",
    custody: "dek-ciphertext",
    note: "twin-thread microcopy, content_enc under the twin DEK",
  },
  {
    schema: "public",
    table: "posts",
    custody: "dek-ciphertext",
    note: "the post primitive (ticket #220): one row per twin post, whose `parts_enc` is the ordered typed parts under the twin DEK (ADR-0008) — the prose the twin composed, the counterparty a draft post named, a receipt's own sentence. Beside them, ids and two words: the twin, the execution, the notice or draft that carried the thread rendering, the question's subject from a closed set, the card an unasked line was said on (`on_post_id`, ticket #340 — an opaque post id), and an instant. What the parts only POINT at lives in its own row — the draft's body is `drafts.content_enc` and the day's numbered lines are `disclosure_post_lines` — so nothing here is a second copy of rep content",
  },
  {
    schema: "public",
    table: "disclosure_posts",
    custody: "no-rep-content",
    note: "one daily disclosure per twin per day: the day, and the notice that carried it. The post's TEXT is that notice's content_enc, under the twin DEK — this row holds ids (ticket #51)",
  },
  {
    schema: "public",
    table: "disclosure_post_lines",
    custody: "no-rep-content",
    note: "the numbering the rep read: twin id, post id, line index, disclosure line id. What a rep's later correction of a line resolves through, and nothing else (ticket #51)",
  },
  {
    schema: "public",
    table: "disclosure_attempts",
    custody: "no-rep-content",
    note: "which day the disclosure automation ran at all, and the execution that composed it: twin id, the rep's own civil day, an execution id and an instant. It is the store's half of one attempt per occasion per day (spec #193 decision 10), and it holds no words — the day's post is that execution's notice under the twin DEK and its lines are disclosure_post_lines (ticket #198)",
  },
  {
    schema: "public",
    table: "send_commands",
    custody: "metadata-envelope",
    note: "the outbound seam: a destination JID and a payload REFERENCE — the content it names is DEK ciphertext (ADR-0008)",
  },
  {
    schema: "public",
    table: "send_attempts",
    custody: "no-rep-content",
    note: "the executor's attempt bookkeeping",
  },
  {
    schema: "public",
    table: "send_executions",
    custody: "no-rep-content",
    note: "the executor's per-execution record: ids and outcomes",
  },
  {
    schema: "public",
    table: "send_allowlist",
    custody: "metadata-envelope",
    note: "the hard send allowlist: destination JIDs, configuration rather than memory",
  },
  {
    schema: "public",
    table: "scope_allowlist",
    custody: "metadata-envelope",
    note: "the rep-controlled capture scope: chat JIDs, configuration rather than memory",
  },
  {
    schema: "public",
    table: "pacing_thresholds",
    custody: "no-rep-content",
    note: "per-twin send pacing configuration",
  },
  {
    schema: "public",
    table: "rail_status_events",
    custody: "no-rep-content",
    note: "connection-plane rail status",
  },
  {
    schema: "public",
    table: "audit_chain",
    custody: "no-rep-content",
    note: "content-free, HMAC hash-chained entries: caller, action, opaque refs, outcome (ADR-0020)",
  },
  {
    schema: "public",
    table: "executions",
    custody: "no-rep-content",
    note: "the rep side's execution record (ticket #172; spec #171 decision 12): the trigger's occasion and mechanism, the content-free reference `triggerRef` renders — twin, anchor event, event count, never the chat — the instructions digest, the tool names the run was given, the lane, two instants, three numbers and a disposition. Nothing the rep or a customer said: the draft is `drafts.content_enc`, the post the rep read is `drafts.post_enc` and the twin's own words are `notices.content_enc`, all three DEK envelopes. Append-only by trigger, one row per entry on `audit_chain` beside it",
  },
  {
    schema: "public",
    table: "twin_keys",
    custody: "no-rep-content",
    note: "the KMS-wrapped DEK — the custody chain itself, useless without KMS",
  },
  {
    schema: "public",
    table: "extraction_runs",
    custody: "metadata-envelope",
    note: "the daily per-chat extraction run and its state: a chat JID, a day, a window, counts, and whether a person drove it — no message, no candidate text, nothing the model said (tickets #52, #67)",
  },
  {
    schema: "public",
    table: "runtime_requests",
    custody: "metadata-envelope",
    note: "the request wake's channel (tickets #197, #364): an ask for a run of one of Dito's automations — the twin, the occasion, an optional chat JID, metadata-only parameters (a steering instant, a boolean), the run it started, three instants, a count and two closed words. No message and no name: the store's own CHECK refuses the `@` every address carries in the parameters document, and the chat sits beside it as routing metadata exactly as it does on `extraction_runs`",
  },
  {
    schema: "public",
    table: "notify_sends",
    custody: "no-rep-content",
    note: "one row per message notify was asked to send (ticket #219): the seat, the message type from ADR-0022's closed catalog, three instants, two closed words and the transport's opaque id. No address, no code, no subject and no body — what the message SAID is the message's, and the store's own CHECK refuses the `@` every address carries in the one column that could plausibly hold one",
  },
  // `fact_retractions` HOLDS THE REP'S WORDS ONCE A LINE IS CORRECTED ON THE
  // CARD (ticket #344): what they said the line should read, kept beside the
  // annotation — sealed under the twin DEK, the door row's own bytes, so key
  // destruction at retirement takes them exactly as it takes the message's.
  {
    schema: "public",
    table: "fact_retractions",
    custody: "dek-ciphertext",
    note: "which rep act retracted which fact: a company, a seat, a twin, a fact id, the disclosure line the rep pointed at, and the row their correction arrived on — a `wa_events` event, a dashboard act or a door message (tickets #54, #224, #344). For a line corrected in place on the card, correction_enc is the rep's own words for what it should read, under the twin DEK (ADR-0008); no other column holds anything anybody wrote",
  },
  // THE TWO OWNER-SIDE REGISTRIES (ticket #127). They live in `public`
  // because they are read from both sides of the wall — the aperture stamps
  // shadow from a company's mode, the owner's views render a seat — so
  // `ledger`'s out-of-frame rule does not cover them and they are declared
  // here instead, which is what this registry is for.
  {
    schema: "public",
    table: "companies",
    custody: "no-rep-content",
    note: "the company registry: an id that has been on every seam row since slice 1, the company's own name, and `shadow_lifted_at` — the launch gate (ADR-0016 as amended). A company is not a person and none of this is anybody's content (ticket #127)",
  },
  // `seats` is classed `no-rep-content` and its display name is the reason
  // that needs saying, since it is a person's name in the clear. It is not
  // rep CONTENT: ADR-0004's amendment puts the filing seat into
  // owner-visible provenance precisely because attribution must OUTLIVE the
  // twin key — twins are erased at retirement, seats persist as retired —
  // so cryptographic erasure not reaching it is the design rather than a
  // gap, and it is not the `recorded-exception` class, which is for rep
  // content the wall would otherwise hold back. What erasure must reach is
  // phone identity, and that is ADR-0027's separate registry, HMAC-keyed
  // under a KMS pepper, which is neither this table nor built.
  {
    schema: "public",
    table: "seats",
    custody: "no-rep-content",
    note: "the seat registry: a seat id and a twin id that have both been on every seam row since slice 1, the company, the state, and the rep's display name. Nothing of the rep's CONVERSATION is here — no chat, no number, no JID, no message (ADR-0004 as amended, which states that rule in full) (ticket #127)",
  },
  // THE DASHBOARD'S TWO LOGIN STORES (ticket #221; spec #214 decision 4).
  //
  // BOTH `no-rep-content`, AND THE CLASS IS ARGUED RATHER THAN PICKED,
  // because two neighbours are closer than they look.
  //
  // Not `metadata-envelope`: that class is plaintext routing metadata sitting
  // BESIDE content that is sealed (ADR-0005's own shape — `wa_events`,
  // `send_commands`), and there is no sealed content beside a login. Nothing
  // in either row points at a message.
  //
  // Not `recorded-exception`: that class is rep-facing CONTENT in the clear,
  // and it is the one that must argue for itself. A session row says
  // "somebody is logged in"; a code row says "somebody asked to log in".
  // Neither is anything the rep or a customer said.
  //
  // WHERE THE EMAIL IS, since the login rests on it: not here. It lives on
  // `seats.email` and nowhere else (…20260907100020), and notify resolves a
  // recipient from there — so a store that could have held an address holds a
  // SEAT ID instead, and the schema is what says so rather than a convention.
  //
  // AND WHAT THE TWO DIGESTS ARE: a sha-256 of an opaque 32-byte session id,
  // and one of six digits. Neither is content and neither is a credential at
  // rest — a reader of these rows can log in as nobody. They are digests
  // precisely so that this stays the class it claims.
  //
  // CRYPTOGRAPHIC ERASURE REACHES NEITHER, and that is the design rather than
  // a gap, exactly as it is for `seats` above: a session and a login attempt
  // are facts about the ACCOUNT and not about the twin, and a seat outlives
  // its twin by ADR-0004's amendment. What retirement owes them is ordinary
  // lifecycle — a retired seat's open sessions end — which is ADR-0027's
  // executor's job and is not built; rep-web refuses a session whose seat
  // reads `retired` meanwhile. Recorded on #221.
  {
    schema: "public",
    table: "sessions",
    custody: "no-rep-content",
    note: "one long-lived per-device dashboard session (ticket #221): a company, a seat, the sha-256 of the opaque id the browser holds, three instants and the instant the close-every-device act ended it. No address, no user agent, no IP — nothing that identifies a person beyond the seat (spec #214 decision 4)",
  },
  {
    schema: "public",
    table: "login_codes",
    custody: "no-rep-content",
    note: "one row per six-digit login code that was asked for (ticket #221): a company, a seat, the device's own attempt id, the code's sha-256, two instants, whether it was used and how many wrong guesses it took. Never the code and never an address — an email naming no seat writes no row at all, because there would be nothing but the address to write (spec #214 decision 4; ADR-0022)",
  },
  // THE REP'S HALF OF LINK DAY, AND BOTH ARE THE LOGIN STORES' CLASS FOR THE
  // LOGIN STORES' REASON (ticket #223). The argument two declarations up
  // applies to each of them word for word — not `metadata-envelope`, because
  // there is no sealed content beside either and nothing in either row points
  // at a message; not `recorded-exception`, because neither holds anything the
  // rep or a customer said.
  //
  // THE INVITATION IS A CREDENTIAL HELD AS A DIGEST, exactly as a session id
  // and a login code are: 32 random bytes in a link's path, sha-256 in the
  // row, so a reader of this table can open no invitation.
  //
  // THE ACKNOWLEDGMENT IS THE SHARPER OF THE TWO, because it is the one rep-side
  // row that references a DOCUMENT — and the document is Dito's own legal text,
  // published in `@dito/copy` and identical for every rep, so what the row holds
  // is a key, a number and the sha-256 of words this repo ships. Nothing of the
  // rep's is in it beyond the fact that they agreed.
  //
  // CRYPTOGRAPHIC ERASURE REACHES NEITHER, and for the acknowledgment that is
  // the POINT rather than a gap. `seats`, `sessions` and `login_codes` already
  // make the argument — these are facts about the ACCOUNT and not about the
  // twin, and a seat outlives its twin by ADR-0004's amendment — and consent
  // is the one that MUST outlive it: "nobody can later claim I agreed to
  // different words" (user story 12) is a claim about a text the rep read
  // before their twin existed and may have to be read long after it is erased.
  {
    schema: "public",
    table: "invitations",
    custody: "no-rep-content",
    note: "one row per invitation (ticket #223): a company, a seat, the sha-256 of the token the link's path carries, when it was issued, when it expires, when it was spent and the session that spending opened. Never the token and never an address — the address is `seats.email` and notify resolves a recipient from there, so an invitation names a SEAT (spec #214 *Link day, in detail*; ADR-0022, ADR-0032)",
  },
  {
    schema: "public",
    table: "acknowledgments",
    custody: "no-rep-content",
    note: "one append-only row per document version a rep accepted (ticket #223): a company, a seat, the session that acknowledged, the document key from a closed set, the version, the sha-256 of the text `@dito/copy` published under it, and the instant. The words are Dito's own legal text, identical for every rep, so the row holds a reference to a shipped document and the fact of consent — no conversation and no name (spec #214 decision 6; user story 12)",
  },
  // THE PLANE'S HALF OF LINK DAY (ticket #222; spec #214 decisions 7 and 8).
  //
  // `chat_directory` IS `drafts`' CLASS FOR `drafts`' REASON: one sealed
  // column beside plaintext routing metadata. The sealed one is the chat's
  // display NAME — what a rep's phone calls a person, which is rep content by
  // any reading — so it rides under the twin DEK exactly as a `wa_events`
  // payload does and key destruction at retirement erases it (ADR-0009).
  //
  // AND WHAT IS DELIBERATELY IN THE CLEAR BESIDE IT is the amendment this
  // ticket writes into ADR-0023: a chat's IDENTITY, its kind, its last
  // activity and one anchor now leave the socket for every conversation the
  // plane sees, in scope or not, so that a chat the rep scopes in next month
  // can still be asked for. Chat identity has been metadata-class in this
  // architecture since slice 1 — `scope_allowlist` and `send_allowlist` carry
  // chat JIDs in this same store, and `wa_events.external_event_id` composes
  // one — so nothing here is a new class of thing in the clear. CONTENT is
  // still dropped before persistence on the uncached allowlist read.
  {
    schema: "public",
    table: "chat_directory",
    custody: "dek-ciphertext",
    note: "one row per twin per PN-canonical chat (ticket #222): `name_enc` is the chat's display name under the twin DEK (ADR-0008), and beside it the chat's two identities, its kind from a closed set, last activity, one forward-only anchor (a rail stanza id, a direction, an instant), the ninety-day fill's progress and, since ticket #245, the fill's own END — when the last attempt stopped, which word out of a closed set it stopped with, and whether it began over history that was already there. Never a message: the plane upserts this for every conversation it sees, in scope or not, while out-of-scope content is still dropped at the socket (ADR-0023 as this ticket amends it — metadata, a LID and an anchor leave, content never). The class is `name_enc`'s alone and the marker does not move it: an instant this database's clock produced and a word this repo owns say nothing a rep or a customer said",
  },
  {
    schema: "public",
    table: "plane_requests",
    custody: "metadata-envelope",
    note: "the asks the PLANE serves (ticket #222): scope a chat in, scope it out, or generate a pairing code — the twin, the kind, an optional chat JID, a closed one-key parameters document, three instants, a page count and three closed words. `runtime_requests`' class for `runtime_requests`' reason, mirrored: the chat sits beside the ask as routing metadata and the document is fenced against the `@` every address carries, so no message and no name can rest here. The pairing CODE is never in this row — it goes to `rail_status_events.detail`, which nothing but the plane may read",
  },
  {
    schema: "public",
    table: "history_windows",
    custody: "no-rep-content",
    note: "how many days of history a scope-in fills, per twin (ticket #222): `pacing_thresholds`' class for `pacing_thresholds`' reason — FR-15's product default as an ordinary primitive, a twin id and a number of days, read by the plane once per fill so the line is never a constant and never a guess (spec #214 decision 8)",
  },
  // WHAT THE DASHBOARD NEEDS TO REACH A REP WHO IS NOT LOOKING (ticket #262;
  // spec #258 *Notification end to end*), and both are the login stores' class
  // for the login stores' reason: nothing in either row is anything the rep or
  // a customer said.
  //
  // THE SUBSCRIPTION IS THE SHARPER OF THE TWO, and it is the one place on the
  // rep side where a SECRET rests in the clear. The endpoint and the two keys
  // are, together, the ability to put a notification on one device's lock
  // screen — so the class here is a statement about CONTENT and not about
  // sensitivity, and what bounds the secret is the grant: rep-web writes and
  // removes, the runtime reads to deliver, and nobody else in this database
  // may name the table (…20260922100030, `scripts/ledger-grants-check.mjs`).
  // A key destroyed at retirement reaches neither, exactly as it reaches no
  // session: a registration is a fact about a BROWSER and the row dies with
  // the login that granted it.
  //
  // THE KNOCK ITSELF IS NOWHERE HERE, which is what keeps the class honest.
  // The twin's sentence lives in `posts.parts_enc` under the twin DEK and
  // reaches a device encrypted end to end (ADR-0019's sixth flow); what this
  // table holds is where to send it, never what was sent.
  {
    schema: "public",
    table: "push_subscriptions",
    custody: "no-rep-content",
    note: "one browser's registration to receive the twin's knocks (ticket #262): a company, a seat, the login session it was granted under, the push service's endpoint and the two keys each payload is encrypted to (RFC 8291), and two instants. No message and no name — the sentence a push carries is read out of a sealed post row at delivery and never rests here (ADR-0022 as amended)",
  },
  {
    schema: "public",
    table: "seen_marks",
    custody: "no-rep-content",
    note: "what one seat has been shown (ticket #262): a company, a seat, a subject kind from a closed set, an identifier this database minted — a post's id, or the instant a fill's end was stamped — and when it was first seen. The store says WHAT was shown and never what it said, and the column's own shape refuses anything a person could have typed (spec #258)",
  },
  {
    schema: "public",
    table: "disclosure_lines",
    custody: "recorded-exception",
    note: "the daily disclosure's journal lines, stored as rendered plaintext",
    justification:
      "ALREADY-CROSSED CONTENT, PLAINTEXT BY DESIGN (ADR-0003, spec #48 grilling decision 9). A disclosure line states what has already gone through the aperture into the company-owned Ledger, so it discloses nothing the wall still holds back. It is plaintext so that DELIVERY NEVER DEPENDS ON LEASE AVAILABILITY: the rep's account of what crossed must reach them even when no runtime holds the twin's lease and the DEK is therefore unavailable — an account of what crossed that can only be read while the system is healthy is no account at all. " +
      "OPEN QUESTION, recorded rather than hidden: cryptographic erasure at retirement (ADR-0009) does NOT reach these rows, because there is no key to destroy. Deleting them is not the obvious answer either — FR-72 is a 1:1 between a filed Ledger subject and its line, so a deleted line leaves an undisclosed crossing behind it permanently, with the invariant red and no way back. Retirement therefore needs a decision (retain, or a content-free tombstone that keeps the 1:1) before it can erase anything here, and until it is made NOTHING holds DELETE on this table.",
  },
];

export interface SharedStoreViolation {
  readonly subject: string;
  readonly reason: string;
}

export interface SharedStoresReport {
  /** The declared rep-side shared-Postgres stores, qualified. */
  readonly declared: readonly string[];
  /** Those of them carrying rep-facing content in the clear. */
  readonly exceptions: readonly string[];
  readonly violations: readonly SharedStoreViolation[];
}

/**
 * Audits the registry against the live catalog, both directions. Needs
 * only a database — no bundle, no KMS — so it runs in every lane rather
 * than only where AWS credentials exist.
 */
export async function auditSharedPostgresStores(
  db: pg.ClientBase,
): Promise<SharedStoresReport> {
  const violations: SharedStoreViolation[] = [];

  for (const store of SHARED_POSTGRES_STORES) {
    const qualified = `${store.schema}.${store.table}`;
    if (store.custody === "recorded-exception") {
      if (store.justification === undefined || store.justification.trim() === "") {
        violations.push({
          subject: `store:${qualified}`,
          reason:
            "declared as a recorded exception with no justification — an exception that does not argue for itself is the silent skip FR-73 exists to prevent",
        });
      }
    } else if (store.justification !== undefined) {
      violations.push({
        subject: `store:${qualified}`,
        reason: `carries a justification but is classed ${store.custody} — a justification is the exception's argument and belongs only to one`,
      });
    }
  }

  // The aperture names its own stores (`APERTURE_REP_SIDE_STORES`, used by
  // the grant audit). Every one of them must appear here with its custody —
  // so a third aperture store cannot be granted on over there and forgotten
  // here, which is exactly the drift two hand-kept lists invite.
  const declaredTables = new Set(SHARED_POSTGRES_STORES.map((s) => s.table));
  for (const store of APERTURE_REP_SIDE_STORES) {
    if (!declaredTables.has(store)) {
      violations.push({
        subject: `store:public.${store}`,
        reason:
          "an aperture store the grant audit knows about but this registry does not — every rep-side store outside the bundle is enumerated here, with its custody (FR-73)",
      });
    }
  }

  // pg_class, not information_schema: the SQL-standard views only show
  // objects the CURRENT USER has some privilege on, so an audit run under
  // a restricted role would silently not see the very store it exists to
  // catch — a green over a real violation. pg_catalog shows everything.
  const live = await db.query<{ table_schema: string; table_name: string }>(
    `SELECT n.nspname AS table_schema, c.relname AS table_name
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p', 'f')
        AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
        AND n.nspname NOT LIKE 'pg\\_temp%'
        AND n.nspname NOT LIKE 'pg\\_toast\\_temp%'
      ORDER BY 1, 2`,
  );
  const liveTables = new Set<string>();
  for (const row of live.rows) {
    if (row.table_schema in OUT_OF_FRAME_SCHEMAS) continue;
    if (TOOLING_TABLES.has(row.table_name)) continue;
    liveTables.add(`${row.table_schema}.${row.table_name}`);
  }

  const declared = new Set(
    SHARED_POSTGRES_STORES.map((s) => `${s.schema}.${s.table}`),
  );

  for (const table of liveTables) {
    if (!declared.has(table)) {
      violations.push({
        subject: `store:${table}`,
        reason:
          "a shared-Postgres store nobody declared — every rep-side store outside the bundle enters FR-73's enumeration with its custody, and an undeclared one is exactly the store this audit exists to catch (FR-73)",
      });
    }
  }
  for (const table of declared) {
    if (!liveTables.has(table)) {
      violations.push({
        subject: `store:${table}`,
        reason:
          "declared in the registry but absent from the database — a registry that has drifted from the schema proves nothing about the schema",
      });
    }
  }

  if (liveTables.size === 0) {
    violations.push({
      subject: "store:*",
      reason:
        "no shared-Postgres stores found at all — refusing to pass on nothing (ADR-0028 doctrine)",
    });
  }

  return {
    declared: [...declared].sort(),
    exceptions: SHARED_POSTGRES_STORES.filter(
      (s) => s.custody === "recorded-exception",
    ).map((s) => `${s.schema}.${s.table}`),
    violations,
  };
}
