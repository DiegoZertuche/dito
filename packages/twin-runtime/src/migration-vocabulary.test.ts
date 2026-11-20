/**
 * THE REPO'S CLOSED VOCABULARIES IN `db/migrations`, guarded two ways.
 *
 * Two CHECK constraints in `db/migrations` carry an enumerated value set —
 * the event-processing dispositions and the twin-post notice kinds — and
 * both are extended by DROP + re-CREATE, because Postgres has no "add a
 * value to a CHECK". That shape is safe on one branch and dangerous on
 * several: four tickets cut from one parent each re-write the whole list
 * from their own ancestor, and whichever migration sorts last silently
 * wins. Nothing fails when that happens — the constraint simply stops
 * accepting a word the code still writes, at the moment a rep uses it.
 *
 * BOTH #53 AND #54 WROTE THIS FILE, independently, for the same hazard,
 * from opposite directions — and the union of the two is what runs here,
 * because they catch different things:
 *
 * 1. **The standing set is exactly what the runtime writes** (#53). The
 *    expected membership is stated once, here, and compared against the
 *    LAST definition of each constraint across the migrations. A value the
 *    code writes and no migration granted fails; so does the reverse.
 * 2. **No re-cut ever narrows** (#54). Every successive cut, in filename
 *    order, must be a superset of the one before it, EXCEPT for the values
 *    `NARROWED_ONCE` names — one ruled removal, argued where it is listed.
 *    This is the stronger check for a merge, because it names the FILE that
 *    dropped the value and the value it dropped — which is how the
 *    integration merge of #53/#54/#55 found …100042 dropping #53's two
 *    question dispositions and its `aperture_question` notice kind (see that
 *    file's header).
 *
 * A sibling of `binding-wall.test.ts`: a structural sweep over the real
 * source of truth, which proves it can catch its violation before
 * certifying the tree.
 *
 * IT IS NOT ONLY THE SEAM'S, and it stopped being at #71: the Ledger's fact
 * types are the APERTURE's constant under the same guard, and #178 adds the
 * execution dispositions, which are `@dito/execution`'s. The sweep lives in
 * one file rather than one per package, and that is the whole of its value —
 * the hazard it exists for is TWO TICKETS re-cutting a list from two
 * ancestors, so a second copy of this parser in a second package would be
 * the very shape of drift it is here to catch. Each constraint's expected
 * membership is read from the package that owns the words, never restated
 * here.
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { FACT_TYPES } from "@dito/aperture";
import { DOCUMENT_KEYS } from "@dito/copy";
import { DISPOSITIONS as EXECUTION_DISPOSITIONS, LANES } from "@dito/execution";
import {
  NOTIFY_CHANNELS,
  NOTIFY_MESSAGE_TYPES,
  NOTIFY_OUTCOMES,
  NOTIFY_REFUSAL_REASONS,
} from "@dito/notify";
import {
  ARRIVAL_VISITS,
  OFFER_SPENT_REASONS,
  CHAT_KINDS,
  DOORS,
  FILL_STOPS,
  DASHBOARD_ACT_TARGET_OF_ROUTE,
  DASHBOARD_ACT_VERB_OF_ROUTE,
  DASHBOARD_ACT_VERBS,
  TWIN_RUN_STATES,
  TWIN_RUN_STEP_KINDS,
  PLANE_REQUEST_KINDS,
  PLANE_REQUEST_OUTCOMES,
  PLANE_REQUEST_REASONS,
  PLANE_REQUEST_STOPS,
  RAIL_STATUSES,
  SEAT_STATES,
  SEEN_SUBJECT_KINDS,
  TAP_MINTERS,
  TWIN_API_ACT_OUTCOMES,
  AUTOMATION_ORIGINS,
  RUTINA_STATES,
  RUTINA_TRIGGER_EVENTS,
  SHIPPED_AUTOMATIONS,
} from "@dito/seam";
import { describe, expect, it } from "vitest";
import { EXTRACTION_RUN_STATES } from "./extraction-pass.js";
import { STEP_KINDS } from "./runs/definition.js";
import { RUN_CREATORS } from "./runs/store.js";
import { PRECONDITION_NAMES } from "./runs/preconditions.js";
import { REMINDER_SUBJECTS } from "./runs/reminder-rows.js";
import { REP_ASK_KINDS } from "./rep-asks.js";
import { POST_ORIGINS, QUESTION_SUBJECTS } from "./posts.js";
import {
  RUNTIME_REQUEST_OCCASIONS,
  RUNTIME_REQUEST_OUTCOMES,
  RUNTIME_REQUEST_REASONS,
} from "./runtime-requests.js";

const MIGRATIONS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../db/migrations",
);

/**
 * Every disposition one processed `wa_events` row can carry. Each names an
 * OUTCOME the consumer decided, and the set only ever grows (spec #48
 * decision 18: "dispositions grow, machinery doesn't").
 */
const DISPOSITIONS = [
  "captured",
  "no_answer_needed",
  "drafted",
  "affirmed",
  "affirmation_refused",
  "dismissed",
  "binding_confirmed",
  "declined",
  // #53: the rep answered an aperture question, and whether the aperture
  // could honour it.
  "question_answered",
  "question_answer_refused",
  "backfill_ingested",
  "answered",
  "deliberate_silence",
  "media_ignored",
  // #54: the rep's «N no» on the daily disclosure, and the same reply
  // resolving to something that cannot be retracted.
  "retracted",
  "correction_refused",
  // #75: the chat trigger batches. The rest of a turn that the anchor's one
  // draft answered, and a message the rep answered themselves first.
  "drafted_in_batch",
  "answered_by_rep",
  // #240: an execution ran for this row and produced no outcome. It exists so
  // that a row the model cannot finish is consumed rather than re-read on
  // every pass — the boundary's F1, where one such row killed the runtime.
  "execution_failed",
  // #319: a rep line that reached a running turn of the day's conversation
  // and was answered by that turn's one result, under the first line's record.
  "folded",
];

/**
 * Every kind of post the twin writes into the rep's own thread.
 *
 * IT LOST `aperture_question` AT #218, and it is the only value this repo
 * has ever taken OUT of a closed set (spec #214 decision 3) — see
 * `NARROWED_ONCE` below, which is where that exception is argued and
 * bounded.
 */
const NOTICE_KINDS = [
  "send_confirmation",
  "affirmation_refusal",
  "dismissal_ack",
  "binding_question",
  "binding_ack",
  "answer",
  "daily_disclosure",
  // #54
  "correction_ack",
  "correction_refusal",
  // #324: a run's question card.
  "ask",
  // #386: a rutina the twin proposes.
  "proposal",
];

/**
 * THE ONE NARROWING THIS REPO HAS RULED, per constraint and per value
 * (ticket #218; spec #214 decision 3).
 *
 * The rule below is that a re-cut closed set never narrows, and it exists
 * for a sharp reason: a value the code still writes that the store has
 * stopped accepting is a constraint violation in front of a rep, after the
 * model has been paid for. Removing a value is therefore a decision, not a
 * refactor — and the decision has to name the value, so a SECOND narrowing
 * cannot ride in behind the first.
 *
 * WHAT MAKES THIS ONE SAFE, in the terms the rule is about: nothing can
 * write the word. The candidate-question route is retired — no store, no
 * renderer, no tool — so `NoticeKind` does not carry it and no code path
 * reaches the CHECK with it. And what makes it safe for the ROWS that
 * already carry it: `notices` is immutable by trigger (…20260827100015) and
 * ADR-0034 is why, so the narrowed constraint is added `NOT VALID` —
 * enforced on every new post, and never re-checked against posts the rep
 * already read (…20260907100010 argues it).
 *
 * THE DISPOSITIONS DID NOT NARROW WITH IT, deliberately: the seam's
 * `question_answered`, `question_declined` and `question_answer_refused`
 * ride forward, because a rig corpus holds acts under them and audit
 * coverage still watches the refusal.
 */
const NARROWED_ONCE: Readonly<Record<string, readonly string[]>> = {
  notices_kind_check: ["aperture_question"],
  // THE SECOND RULED NARROWING (ticket #221; spec #214 *Link day, in
  // detail*). `seats.state` could hold exactly one word — …20260902100010
  // argued for it, since ADR-0027's other three states had no executor — and
  // FR-63's three replace it. `active` and `linked` are the same statement
  // about the same seat, so keeping both would leave two words for one state.
  //
  // WHAT MAKES THIS ONE SAFE, in the terms the rule is about: nothing can
  // write the word. `SEAT_STATES` does not carry it, `rig-seed-owner.ts`
  // writes `linked`, and no other code path reaches this CHECK at all.
  //
  // AND WHAT MAKES IT SAFE FOR THE ROWS: unlike the notice kind above, this
  // narrowing does NOT grandfather anything — …20260907100040 rewrites every
  // `active` row to `linked` in the same transaction, one statement before
  // the constraint is re-cut, so the validated CHECK is true of every row
  // rather than of every new one. A seat is not a record of what the twin
  // told the rep, so there is nothing ADR-0034 protects here.
  seats_state_check: ["active"],
  // THE THIRD RULED NARROWING (ticket #324; spec #318 decision 23 as amended
  // 2026-10-06). The `check` step held a code rule over typed fields and
  // ended the run when it failed — a hardcoded check on what the model
  // produced, which Diego withdrew with the rule that an act is never the
  // model's call mid-step (agentic first, 2026-09-29).
  //
  // WHAT MAKES THIS ONE SAFE, in the terms the rule is about: nothing can
  // write the word. `STEP_KINDS` does not carry it, the parser refuses a
  // definition naming it, and the engine has no arm for it — so no checkpoint
  // is begun under it.
  //
  // AND WHAT MAKES IT SAFE FOR THE ROWS: a checkpoint is the record of a step
  // that ran, so the narrowed constraint is added `NOT VALID`
  // (…20261006100070) — enforced on every new checkpoint and never re-checked
  // against one a run already wrote.
  run_steps_kind_check: ["check"],
  // THE FOURTH RULED NARROWING (ticket #364; ADR-0031 as amended 2026-10-07:
  // the reminders wake the thread and the nudge automation retires). `nudged`
  // was the record of a sentence the nudge composed, and nothing composes one
  // now; notify's `nudge` message is the knock a reminder fired, and it is
  // called `reminder` from here on.
  //
  // WHAT MAKES THESE SAFE, in the terms the rule is about: nothing can write
  // the words. `DISPOSITIONS` and `NOTIFY_MESSAGE_TYPES` do not carry them,
  // and the nudge's module and its store are gone.
  //
  // AND WHAT MAKES THEM SAFE FOR THE ROWS: an execution record and a send
  // record are records of what happened, and a chain entry attests to the
  // disposition, so the narrowed constraints are added `NOT VALID`
  // (…20261007100020) — enforced on every new row and never re-checked
  // against one already written.
  executions_disposition_check: ["nudged"],
  owner_executions_disposition_check: ["nudged"],
  notify_sends_message_type_check: ["nudge"],
  // THE FIFTH RULED NARROWING, AND THE FIRST THAT TAKES A WHOLE SET (ticket
  // #358; ADR-0031 and ADR-0044 as amended 2026-10-06: the knock is the
  // thread's row beside the post). `posts.knock_disposition` recorded what
  // became of a knock a post carried from birth; every knock is a
  // `post_knocks` row the knock tool writes, so the column, its CHECK and its
  // index are dropped (…20261008100010).
  //
  // WHAT MAKES IT SAFE: nothing writes the column — `insertPost` names no
  // such column — and the rows that held `carried` were announced when they
  // landed, so dropping it reads nothing anybody still owes.
  posts_knock_disposition_check: ["carried", "none", "refused"],
};

/** The closed vocabularies a later migration may extend but never narrow. */
const CLOSED_SETS = [
  "wa_event_processing_disposition_check",
  "notices_kind_check",
  // Ticket #71 put the Ledger's fact types under the same guard, and the
  // reason is the ticket's own: `OrderRequested` had to be ADDED to a
  // constraint that Postgres can only extend by dropping and re-creating,
  // in a slice where three tickets are cut from one parent. The sweep is
  // what makes "extend, never re-cut" a machine-checked rule for this
  // constraint too rather than a note in a migration header.
  "ledger_facts_fact_type_check",
  // Ticket #178 puts the owner side's execution dispositions under the same
  // guard, and the reason is sharper here than anywhere else in this list: a
  // narrowing re-cut would refuse a disposition AFTER the execution has run
  // and AFTER its entry is on an append-only chain, so the record cannot be
  // written and the entry cannot be unwritten — the exact hole ADR-0020's
  // coverage check exists to find, reached from the store side.
  "owner_executions_disposition_check",
  // ...and the lane beside it (the two-axis review's Standards axis). It is
  // the same DROP + re-CREATE hazard over the same table in the same
  // ticket, and a closed set restated in SQL with nothing reading the code's
  // copy is the exact shape this file exists to refuse.
  "owner_executions_lane_check",
  // Ticket #172 puts the REP side's two under the same guard, from birth
  // rather than after the first re-cut. The hazard here is the sharper one:
  // four rep-side tickets are cut from this slice's one parent (#173–#176),
  // every one of them adds an occasion and three of them will want a
  // disposition, and each will re-write the whole list from its own
  // ancestor. A narrowing re-cut refuses a disposition AFTER the execution
  // has run and its entry is on an append-only chain — a record that cannot
  // be written beside an entry that cannot be unwritten.
  "executions_disposition_check",
  "executions_lane_check",
  // Ticket #194 puts the extraction run's own state under the same guard,
  // and the hazard is the one the states themselves are about: a narrowing
  // re-cut that dropped `failed` would refuse the settle of a run whose
  // execution has already failed and already written its append-only chain
  // entry — so the chat would stay `submitted`, be re-claimed on the next
  // poll, and pay for a model call every two seconds for the rest of the day.
  "extraction_runs_state_check",
  // Ticket #197 puts the request wake's three closed sets under the same
  // guard. The hazard is the operator's: a narrowing re-cut would refuse the
  // outcome the loop writes AFTER it has already created the executions the
  // request asked for — so the row would stay taken with no outcome, the
  // requester would wait out its whole timeout, and an operator would be told
  // nothing happened over a day that was read. `runtime_requests_reason_check`
  // is the sharper half: the reasons are the operator's own diagnosis, and a
  // word the loop writes that the store refuses turns a refusal into a
  // constraint violation on the poll.
  "runtime_requests_occasion_check",
  "runtime_requests_outcome_check",
  "runtime_requests_reason_check",
  // Ticket #219 puts notify's three under the same guard, and the hazard is
  // the sharpest in this list because the effect is outside the system: a
  // narrowing re-cut of the outcome would refuse the SETTLE of a message
  // that has already left for somebody's inbox, so the row would stay
  // unsettled for ever and the record would say a send that happened might
  // not have. The message type is the other half of ADR-0022's closed
  // catalog — a word here that `@dito/notify` does not hold would be a
  // message the store believes in and no code can send.
  "notify_sends_message_type_check",
  "notify_sends_outcome_check",
  "notify_sends_reason_check",
  // Ticket #220 puts the post primitive's two under the same guard. The
  // question subject is the sharper half: it names the act a yes performs, so
  // a narrowing re-cut would refuse a post the twin is composing — after the
  // model has been paid for and, on the thread's own path, in the same
  // transaction as the answer that carries the question. The origin is the
  // other, and a re-cut that lost `reexpressed` would refuse nothing new and
  // silently invalidate every post that predates parts.
  "posts_question_subject_check",
  "posts_origin_check",
  // ...and ticket #276 the third, which is both halves at once: it is the
  // at-once tier's eligibility question and the trace a dropped knock leaves,
  // so a narrowing re-cut would refuse a post inside the transaction that
  // emits a draft — the rep loses the thing they are waiting on over an
  // announcement.
  "posts_knock_disposition_check",
  // ...and the transport one attempt left by, whose narrowing hazard is
  // `notify_sends`' own, one column along: a re-cut that lost a word would
  // refuse the SETTLE of a message that has already gone out.
  "notify_sends_channel_check",
  // Ticket #221 puts the seat's own lifecycle under the guard, on its first
  // re-cut. The hazard is the login: rep-web refuses a session whose seat
  // reads `retired` and #223 writes `invited` and `linked`, so a narrowing
  // re-cut would refuse a state transition in front of a rep on link day —
  // and, for `retired`, would leave a seat whose twin is already erased
  // (ADR-0009) in a state the store will not accept. It is also the one
  // constraint in this list that has TAKEN a value out, which is why
  // `NARROWED_ONCE` names it.
  "seats_state_check",
  // Ticket #222 puts the RAIL's own status vocabulary under the guard, on the
  // first re-cut it has ever had. #221's `RAIL_STATUSES` header recorded
  // exactly this as a remainder: …20260827100007 wrote the CHECK inline and
  // unnamed, so this sweep could not see it, and three copies of the
  // vocabulary — the Go emitter, that CHECK, and the constant — were held
  // together by review. …20260908100050 re-cuts it under its own name to add
  // `pairing_code`, so the sweep reads it from here on. The hazard is link
  // day's: a narrowing re-cut would refuse the row that CARRIES the credential
  // the rep is waiting to type, inside a 160-second window (ADR-0031).
  "rail_status_events_status_check",
  // ...and the chat directory's kinds beside it. The hazard is the scoping
  // page's: the plane upserts a row for EVERY conversation it sees, in scope
  // or not, so a kind the store refuses is a constraint violation on an
  // ordinary history sync — which fail-stops the plane and takes capture down
  // with it, over a chat nobody scoped.
  "chat_directory_kind_check",
  // ...AND THE FILL'S OWN STOP MARKER (ticket #245), pinned from BOTH sides:
  // `planereq_test.go` sweeps it against the Go constants that write the words
  // and the case above sweeps it against the three groups the card reads them
  // in. The hazard is the sharpest in this list: the marker is stamped in the
  // SAME statement as the final page's progress, so a narrowing re-cut rolls
  // back a page of the rep's own history that the seam already holds.
  "chat_directory_fill_stopped_by_check",
  // The plane request seam's four closed sets (ticket #222). The sharpest is
  // `stopped_by`: it is written AFTER the fill has paged a chat's history onto
  // the seam and moved the directory row's progress, so a narrowing re-cut
  // would leave the request taken and unsettled over work that actually
  // happened — and the next start would settle it `interrupted`, reporting a
  // fill that ran as one that was cut off. `reason` is the other half of
  // "refused by name, never sent", and a word the plane writes that the store
  // refuses turns a refusal into a constraint violation on the poll.
  "plane_requests_kind_check",
  "plane_requests_outcome_check",
  "plane_requests_reason_check",
  "plane_requests_stopped_by_check",
  // Ticket #224 puts ADR-0006's tap minters under the guard, on the first
  // re-cut the constraint has ever had — …20260826100003 wrote it with one
  // word and named the second minter in its own comment. The hazard is the
  // one the whole file exists for, arriving at its sharpest: a narrowing
  // re-cut would refuse a tap AFTER the rep pressed Enviar, so the message
  // they were told was going does not go, and the store says why in a
  // constraint violation. `send_refusals_minter_check` carries the same
  // vocabulary because the same closed set writes both.
  "taps_minter_check",
  "send_refusals_minter_check",
  // ...and the verb of a dashboard act beside them (#224). The hazard is the
  // same one at the same sharpness: the API writes the verb in the same
  // transaction as the act it is recording, so a word the store refuses is a
  // rep act that cannot be recorded — and ADR-0003 says an act with no
  // evidence row is not a rep act at all, so the act does not happen either.
  "dashboard_acts_verb_check",
  // ...and what the surface ANSWERED, which is the same hazard read from the
  // other end (#224). Audit coverage enumerates a dashboard act by its
  // outcome word, so a narrowing re-cut would refuse the stamp inside the
  // act's own transaction — rolling back an act that has already run — and a
  // word the code stamps that the constraint never granted would leave the
  // act enumerated by no coverage class at all.
  "dashboard_acts_outcome_check",
  // ...AND WHICH VERBS ACT ON A CHAT RATHER THAN ON A CARD (ticket #223).
  // `dashboard_acts.post_id` stopped being NOT NULL when the two scope
  // switches arrived, and this constraint is what keeps the widening from
  // being a hole: a scope act carries a directory row and a post act carries a
  // post. A narrowing re-cut would refuse the very act the API is recording,
  // in the same transaction as the allowlist write and the chain entry; a word
  // ADDED here that `DASHBOARD_ACT_TARGET_OF_ROUTE` does not call a chat act
  // would let a post act be filed with no post at all.
  "dashboard_acts_target_by_verb_check",
  // ...AND WHICH VERB NAMES NO TARGET AT ALL (ticket #264). The notebook edit
  // is the seat's own, so its row carries neither a post nor a directory row,
  // and this constraint is what keeps every OTHER verb naming one. A narrowing
  // re-cut would refuse the act row a Mi libreta save is evidenced by, in the
  // same transaction as the notebook's new version.
  "dashboard_acts_notepad_target_check",
  // Ticket #223 puts the documents a rep may acknowledge under the guard. The
  // hazard is link day's, and it is the one hazard in this list whose failure
  // is legal rather than operational: the rep presses «Acepto mi contrato,
  // versión N» and the store refuses the row, so the page 500s and no consent
  // is recorded — after they have read and accepted the words. The set is
  // `@dito/copy`'s `DOCUMENT_KEYS`, read from the package that publishes the
  // texts rather than restated here.
  "acknowledgments_document_check",
  // Ticket #261 puts the DOOR under the guard, twice. A post's `asked_on` is
  // what decides whether an answer was sent to the thread or posted at the
  // dashboard — so a word the code writes that the store refuses is a
  // constraint violation inside the execution's own transaction, after the
  // model has been paid for, and a word the store accepts that no surface
  // knows is an answer neither door renders.
  "posts_asked_on_check",
  // ...and the door's own processing marker, which carries the SAME
  // vocabulary as the seam's: one disposition set across both doors, so an
  // answered door message marks `answered` exactly as a self-chat one does.
  // A narrowing re-cut here would refuse the marker that bounds the spend, and
  // the message would be re-read and re-paid for on every pass.
  "dashboard_message_processing_disposition_check",
  // Ticket #262 puts the seen-mark's subject kinds under the guard, from birth
  // rather than after a first re-cut. The hazard is a card's retirement: the
  // page writes the mark in the same request that renders the card, so a kind
  // the store refuses is a 500 in front of a rep reading their own feed —
  // and a word ADDED here that `SEEN_SUBJECT_KINDS` does not hold would be a
  // subject the store believes in that no surface can ever mark seen, so the
  // card it belongs to would stand for ever.
  "seen_marks_subject_kind_check",
  // Ticket #364 puts the clock store's own words under the guard, from
  // birth: the subject a reminder row is written for, the precondition a
  // cadence names, and the name of each of Dito's automations. A word the
  // store refuses is a card born with no reminder or a seat with no rows, and
  // a word ADDED here that the runtime does not hold would be a row nothing
  // fires.
  "schedules_subject_check",
  "schedules_precondition_check",
  "automations_shipped_check",
  "post_knocks_subject_check",
  // Ticket #266 puts the arrival's visit under the guard, from birth. The API
  // writes the word in the same statement that records the arrival, so a word
  // the store refuses is a 500 in front of a rep opening Inicio — and the
  // welcome and the return line are two different sentences the twin writes,
  // so a word ADDED here that `ARRIVAL_VISITS` does not hold would be a visit
  // the store believes in that no execution knows how to greet.
  "rep_arrivals_visit_check",
  // Ticket #358 puts the rep's wordless asks under the guard, from birth. The
  // API writes the kind in the request that accepted the ask, so a word the
  // store refuses is a 500 in front of a rep tapping a matter, a phrase or a
  // card; and the marker carries the door's vocabulary, whose narrowing would
  // refuse the marker that serves an ask once — re-served on every pass.
  "rep_asks_kind_check",
  "rep_ask_processing_disposition_check",
  // Ticket #335 puts the spending's reasons under the guard, from birth. The
  // API writes the word the moment the rep lets an offer go, so a word the
  // store refuses is the offer rising again after the next reload.
  "offer_spendings_reason_check",
  // Ticket #323 puts a workflow run's vocabularies under the guard, from
  // birth. The engine writes a run's state and a step's checkpoint inside the
  // transaction that ends the step — beside the step's record and chain entry
  // and, for an agent step, AFTER the model was paid for — so a word the store
  // refuses rolls back a step that ran, and the run is ended as stranded on the
  // next start. The run target's verbs ride with them: a narrowing re-cut
  // would refuse Pausar or Cancelar in front of the rep.
  "runs_state_check",
  "runs_created_by_check",
  "run_steps_kind_check",
  "run_steps_state_check",
  "schedules_kind_check",
  "dashboard_acts_run_target_check",
] as const;

const MIGRATION_FILES = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith(".sql"))
  // Migrations apply in filename order, which is the order a value must
  // ride forward through.
  .sort();

/**
 * Every value list the named constraint is given in this SQL, in file
 * order — a constraint can be re-cut more than once in one file, and the
 * last cut is the one that stands.
 *
 * Comments come off first, exactly as `binding-wall.test.ts` does it: a
 * `--` line inside a value list may carry parentheses of its own
 * («(ADR-0020)»), and a scan that stopped at the first `)` would read a
 * TRUNCATED set and then certify it as the whole vocabulary.
 *
 * THE `ADD` IS OPTIONAL (ticket #71), and that widening is what lets the
 * monotonicity check see a constraint's FIRST cut. A closed set is born
 * inline inside its `CREATE TABLE` — `CONSTRAINT x CHECK (col IN (…))` —
 * and only later cuts say `ADD`. Requiring `ADD` meant the original grant
 * was invisible, so a first re-cut had nothing to be compared against and
 * could narrow the set freely; it is exactly the cut a later ticket writes
 * from a stale ancestor.
 */
function setsFor(sql: string, constraint: string): string[][] {
  const stripped = sql.replace(/--[^\n]*/g, "");
  const pattern = new RegExp(
    `(?:ADD\\s+)?CONSTRAINT\\s+${constraint}\\s+CHECK\\s*\\([^)]*IN\\s*\\(([^)]*)\\)`,
    "gi",
  );
  return [...stripped.matchAll(pattern)].map((match) =>
    [...match[1]!.matchAll(/'([^']*)'/g)].map((literal) => literal[1]!),
  );
}

/**
 * The value list of the LAST cut a named constraint is given across the
 * migrations — the definition that stands after they all apply.
 */
function closedSetFor(constraint: string): string[] {
  expect(MIGRATION_FILES.length).toBeGreaterThan(20);
  let latest: string[] | undefined;
  for (const file of MIGRATION_FILES) {
    const sql = readFileSync(path.join(MIGRATIONS, file), "utf8");
    for (const next of setsFor(sql, constraint)) latest = next;
  }
  if (latest === undefined) {
    throw new Error(
      `no CHECK (... IN (...)) for constraint ${constraint} in db/migrations — the sweep found nothing to compare, which is not a pass`,
    );
  }
  return latest;
}

/**
 * The body of the LAST cut a named constraint is given across the migrations,
 * whitespace folded — for the checks that are a rule rather than a value list
 * (ticket #266).
 */
function lastCheckOf(constraint: string): string {
  let latest: string | undefined;
  const pattern = new RegExp(
    `CONSTRAINT\\s+${constraint}\\s+CHECK\\s*\\(([\\s\\S]*?)\\);`,
    "gi",
  );
  for (const file of MIGRATION_FILES) {
    const sql = readFileSync(path.join(MIGRATIONS, file), "utf8").replace(
      /--[^\n]*/g,
      "",
    );
    for (const match of sql.matchAll(pattern)) {
      latest = match[1]!.replace(/\s+/g, " ");
    }
  }
  if (latest === undefined) {
    throw new Error(
      `no CHECK for constraint ${constraint} in db/migrations — the sweep found nothing to compare, which is not a pass`,
    );
  }
  return latest;
}

/**
 * The migration that took a value OUT of a named constraint — the file the
 * narrowing rule below exempts by name.
 *
 * It walks the cuts exactly as that rule does, so the two can never disagree
 * about WHICH file is the exception: the obligations a ruled removal carries
 * are checked against the file that actually made it.
 */
function fileThatDropped(constraint: string, value: string): string {
  let standing: string[] | undefined;
  for (const file of MIGRATION_FILES) {
    const sql = readFileSync(path.join(MIGRATIONS, file), "utf8");
    for (const next of setsFor(sql, constraint)) {
      if (standing?.includes(value) === true && !next.includes(value)) {
        return file;
      }
      standing = next;
    }
  }
  throw new Error(
    `no migration removed '${value}' from ${constraint} — NARROWED_ONCE names an exception nothing took, which is a rule with no subject`,
  );
}

describe("the repo's closed vocabularies survive a merge (#49/#51/#52/#53/#54, #71, #178)", () => {
  it("the event-processing dispositions are exactly the set the runtime writes", () => {
    // Sorted on both sides: the ORDER a migration lists them in is
    // cosmetic, the MEMBERSHIP is the contract.
    expect(closedSetFor("wa_event_processing_disposition_check").sort()).toEqual(
      [...DISPOSITIONS].sort(),
    );
  });

  it("the door's marker holds the same dispositions the seam's does (#261)", () => {
    // ONE VOCABULARY, TWO DOORS. A dashboard message is routed to the same
    // thread execution as a self-chat one and marked by the same code
    // (`markThreadMessage`), so a second word set here would be two answers to
    // «what happened to this message» — and the sweep is what keeps one of the
    // two CHECKs from being re-cut alone by a ticket that touched one door.
    expect(
      closedSetFor("dashboard_message_processing_disposition_check").sort(),
    ).toEqual([...DISPOSITIONS].sort());
  });

  it("a post's knock disposition is gone with its column: every knock is a `post_knocks` row (#358)", () => {
    // THE RULED REMOVAL IS THE WHOLE SET, and the column it constrained went
    // with it — so the last migration naming the column drops it, after the
    // constraint's last cut, and nothing can write a word to it again.
    expect([...(NARROWED_ONCE["posts_knock_disposition_check"] ?? [])].sort()).toEqual(
      closedSetFor("posts_knock_disposition_check").sort(),
    );
    const naming = MIGRATION_FILES.filter((file) =>
      readFileSync(path.join(MIGRATIONS, file), "utf8").replace(/--[^\n]*/g, "").includes("knock_disposition"),
    );
    const last = readFileSync(path.join(MIGRATIONS, naming.at(-1)!), "utf8");
    expect(last).toMatch(/DROP COLUMN IF EXISTS knock_disposition/u);
    expect(last).toMatch(/DROP CONSTRAINT IF EXISTS posts_knock_disposition_check/u);
  });

  it("the two transports a send may leave by are exactly notify's own (#276)", () => {
    expect(closedSetFor("notify_sends_channel_check").sort()).toEqual(
      [...NOTIFY_CHANNELS].sort(),
    );
  });

  it("the doors are exactly the two a post can be asked at (#261)", () => {
    // Read from `@dito/seam` rather than restated here, exactly as the seat
    // states and the act verbs are: the column a surface reads without a key
    // and the constant the runtime writes are ONE vocabulary.
    expect(closedSetFor("posts_asked_on_check").sort()).toEqual(
      [...DOORS].sort(),
    );
  });

  it("the notice kinds are exactly the set the grammar posts", () => {
    expect(closedSetFor("notices_kind_check").sort()).toEqual(
      [...NOTICE_KINDS].sort(),
    );
  });

  it("the execution dispositions are exactly the closed set the runtime holds (#178)", () => {
    // Read from `@dito/execution` rather than restated here, exactly as the
    // fact types are read from the aperture: the constant and the CHECK are
    // ONE vocabulary argued in one place (spec #171 decision 11), and what
    // this catches is a disposition the runtime assigns that the store
    // refuses — which surfaces as a constraint violation on a real turn,
    // after the model has been paid for and the chain entry written.
    expect(closedSetFor("owner_executions_disposition_check").sort()).toEqual(
      [...EXECUTION_DISPOSITIONS].sort(),
    );
    // ...and a superset of what #130 originally granted, which is the other
    // half of "widened, never narrowed" said as membership rather than as
    // monotonicity over files.
    for (const original of [
      "answered",
      "wall-refused",
      "schema-miss",
      "no-action",
      "failed",
    ]) {
      expect(closedSetFor("owner_executions_disposition_check")).toContain(
        original,
      );
    }
  });

  it("the execution lanes are exactly the two the runtime declares (#178)", () => {
    expect(closedSetFor("owner_executions_lane_check").sort()).toEqual(
      [...LANES].sort(),
    );
  });

  it("the rep side's executions carry the same two closed sets (#172)", () => {
    // ONE VOCABULARY, TWO TABLES. The dispositions and the lanes are
    // `@dito/execution`'s constants (spec #171 decision 11), and the rep
    // side's store is `ExecutionRecord` column for column — so its CHECKs
    // are the same membership as the owner's, read from the same place
    // rather than restated. What this catches is the store refusing a word
    // the runtime assigns, which surfaces on a real customer turn after the
    // model has been paid for and the chain entry written.
    expect(closedSetFor("executions_disposition_check").sort()).toEqual(
      [...EXECUTION_DISPOSITIONS].sort(),
    );
    expect(closedSetFor("executions_lane_check").sort()).toEqual(
      [...LANES].sort(),
    );
  });

  it("the two executions tables hold the same words, not two vocabularies", () => {
    // The claim the sentence above rests on, said as a comparison: a
    // migration that widened one table's set and forgot the other would
    // leave two stores disagreeing about how an execution may end, and the
    // per-table assertions would each stay green.
    expect(closedSetFor("executions_disposition_check").sort()).toEqual(
      closedSetFor("owner_executions_disposition_check").sort(),
    );
    expect(closedSetFor("executions_lane_check").sort()).toEqual(
      closedSetFor("owner_executions_lane_check").sort(),
    );
  });

  it("the extraction run's states are exactly the four the pass writes (#194)", () => {
    // Read from `extraction-pass.ts` rather than restated here, exactly as
    // the fact types are read from the aperture: the constant and the CHECK
    // are ONE vocabulary. What this catches is a state the pass settles that
    // the store refuses — which surfaces after the model has been paid for
    // and, for `failed`, after the execution's chain entry is already written.
    expect(closedSetFor("extraction_runs_state_check").sort()).toEqual(
      [...EXTRACTION_RUN_STATES].sort(),
    );
  });

  it("the request wake's three vocabularies are exactly what the loop writes (#197)", () => {
    // Read from `runtime-requests.ts` rather than restated here, exactly as
    // the run states are read from the pass. What this catches is a word the
    // loop writes that the store refuses — and for the outcome that surfaces
    // after the executions have run, when the only thing left to record is
    // what became of the operator's ask.
    expect(closedSetFor("runtime_requests_occasion_check").sort()).toEqual(
      [...RUNTIME_REQUEST_OCCASIONS].sort(),
    );
    expect(closedSetFor("runtime_requests_outcome_check").sort()).toEqual(
      [...RUNTIME_REQUEST_OUTCOMES].sort(),
    );
    expect(closedSetFor("runtime_requests_reason_check").sort()).toEqual(
      [...RUNTIME_REQUEST_REASONS].sort(),
    );
  });

  it("notify's three vocabularies are exactly what the service writes (#219)", () => {
    // Read from `@dito/notify` rather than restated here, exactly as the
    // request wake's are read from `runtime-requests.ts`. The message type
    // is ADR-0022's closed catalog seen from the store side: the code's
    // constant and this CHECK are one vocabulary, and either drifting is a
    // message Dito can send that nothing can record, or a message the store
    // believes in that no code can send.
    expect(closedSetFor("notify_sends_message_type_check").sort()).toEqual(
      [...NOTIFY_MESSAGE_TYPES].sort(),
    );
    expect(closedSetFor("notify_sends_outcome_check").sort()).toEqual(
      [...NOTIFY_OUTCOMES].sort(),
    );
    expect(closedSetFor("notify_sends_reason_check").sort()).toEqual(
      [...NOTIFY_REFUSAL_REASONS].sort(),
    );
  });

  it("the seen mark's subjects are exactly what a surface can show (#262)", () => {
    // Read from `@dito/seam` rather than restated here, exactly as the rail's
    // statuses are: the page writes the kind in the same request that renders
    // the card, so the constant and this CHECK are one vocabulary.
    expect(closedSetFor("seen_marks_subject_kind_check").sort()).toEqual(
      [...SEEN_SUBJECT_KINDS].sort(),
    );
  });

  it("the clock store's words are exactly what the runtime writes and fires (#364)", () => {
    // Read from the modules that write them rather than restated here: a
    // reminder's subject, a cadence's precondition, the name of one of Dito's
    // automations, and the subject a reminder's knock is kept under.
    expect(closedSetFor("schedules_subject_check").sort()).toEqual([...REMINDER_SUBJECTS].sort());
    expect(closedSetFor("post_knocks_subject_check").sort()).toEqual([...REMINDER_SUBJECTS].sort());
    expect(closedSetFor("schedules_precondition_check").sort()).toEqual([...PRECONDITION_NAMES].sort());
    expect(closedSetFor("automations_shipped_check")).toEqual([...SHIPPED_AUTOMATIONS]);
  });

  it("the arrival's visits are exactly the two the API records (#266)", () => {
    // Read from `@dito/seam` rather than restated here, exactly as the doors
    // are: the API writes the word and the trigger carries it, so the constant
    // and this CHECK are one vocabulary.
    expect(closedSetFor("rep_arrivals_visit_check").sort()).toEqual(
      [...ARRIVAL_VISITS].sort(),
    );
  });

  it("the rep's asks are exactly the three a row holds, and their marker speaks the door's vocabulary (#358)", () => {
    expect(closedSetFor("rep_asks_kind_check").sort()).toEqual([...REP_ASK_KINDS].sort());
    expect(closedSetFor("rep_ask_processing_disposition_check").sort()).toEqual([...DISPOSITIONS].sort());
  });

  it("an offer's spending reasons are exactly the three the bar spends with (#335)", () => {
    expect(closedSetFor("offer_spendings_reason_check").sort()).toEqual(
      [...OFFER_SPENT_REASONS].sort(),
    );
  });

  it("the arrival post and the unasked line are delivered to the door only, in the store (#266, #320)", () => {
    // NOT A VALUE LIST BUT THE SAME HAZARD: the checks that make a line
    // door-only are re-cut by DROP + re-CREATE like every closed set here, and
    // a later ticket re-cutting `posts_door_message_check` from an ancestor
    // would drop a disjunct — refusing every line after the model has been
    // paid for. So the LAST cut of each is read and held to what ADR-0044 as
    // amended says a line is.
    expect(lastCheckOf("posts_door_message_check")).toMatch(
      /asked_message_id IS NOT NULL OR arrival_id IS NOT NULL OR unasked/,
    );
    expect(lastCheckOf("posts_door_one_reason_check")).toMatch(
      /\(asked_message_id IS NOT NULL\)::int\s*\+ \(arrival_id IS NOT NULL\)::int\s*\+ unasked::int <= 1/,
    );
    for (const check of ["posts_arrival_door_only_check", "posts_unasked_door_only_check"]) {
      const doorOnly = lastCheckOf(check);
      // No knock clause: a knock is a `post_knocks` row, and the knock tool
      // takes only a card that waits on the rep (`post-knocks.ts`, #358).
      for (const clause of ["notice_id IS NULL", "draft_id IS NULL"]) {
        expect(doorOnly, check).toContain(clause);
      }
    }
  });

  it("the post primitive's two vocabularies are exactly what the runtime writes (#220)", () => {
    // Read from `posts.ts` rather than restated here, exactly as notify's are
    // read from `@dito/notify`. A question subject names the acts its answer
    // performs, so the constant and this CHECK are one vocabulary: a subject
    // the code composes that the store refuses would be a constraint
    // violation on a post the rep was about to be shown.
    expect(closedSetFor("posts_question_subject_check").sort()).toEqual(
      Object.keys(QUESTION_SUBJECTS).sort(),
    );
    expect(closedSetFor("posts_origin_check").sort()).toEqual(
      [...POST_ORIGINS].sort(),
    );
  });

  it("the seat's states are exactly the three FR-63 names (#221)", () => {
    // Read from `@dito/seam` rather than restated here, exactly as notify's
    // are read from `@dito/notify`. The failure this catches is the login's:
    // rep-web reads a seat's state to refuse a retired one and #223 writes
    // the two transitions of link day, so a word the code writes that the
    // store refuses is a rep who cannot get in — after the code has been
    // mailed to them.
    expect(closedSetFor("seats_state_check").sort()).toEqual(
      [...SEAT_STATES].sort(),
    );
  });

  it("the rail's statuses are exactly the five the plane emits (#222)", () => {
    // Read from `@dito/seam` rather than restated here. This is the vocabulary
    // #221 could not sweep — the CHECK was inline and unnamed — and the
    // failure it now catches is link day's: the row that carries the pairing
    // code refused by the store, inside ADR-0031's 160-second window, with the
    // rep watching a page that never shows a credential.
    expect(closedSetFor("rail_status_events_status_check").sort()).toEqual(
      [...RAIL_STATUSES].sort(),
    );
  });

  it("the fill's stop marker holds exactly the words the card can read (#245)", () => {
    // TWO PINS OVER ONE CHECK, and that is the whole point. `planereq_test.go`
    // sweeps this constraint against the Go constants that WRITE the words;
    // this sweeps it against the three groups the card READS them in — so a
    // word the plane can stamp that the dashboard has no reading for is a chat
    // that lands in no count of its own, which is exactly the state in which
    // the card claims the ninety days over a chat whose history never arrived.
    // The other direction holds too: a word the card classifies that no plane
    // writes is a group that enumerates nothing.
    expect(closedSetFor("chat_directory_fill_stopped_by_check").sort()).toEqual(
      [...FILL_STOPS].sort(),
    );
  });

  it("the chat directory's kinds are exactly the four the plane writes (#222)", () => {
    // Read from `@dito/seam` for the reason every entry above is: the
    // constant and the CHECK are ONE vocabulary. What this catches is a kind
    // the plane derives from an address that the store refuses — on an
    // ordinary history sync, for a chat nobody scoped, which fail-stops the
    // plane and takes capture down with it.
    expect(closedSetFor("chat_directory_kind_check").sort()).toEqual(
      [...CHAT_KINDS].sort(),
    );
  });

  it("the plane request seam's four vocabularies are what the plane writes (#222)", () => {
    // Read from `@dito/seam`, which is where the runtime reads them too: it
    // WRITES the kind and READS the outcome, so a drift here is a rep act
    // whose row the store refuses in the same transaction as the allowlist
    // write and the chain entry.
    expect(closedSetFor("plane_requests_kind_check").sort()).toEqual(
      [...PLANE_REQUEST_KINDS].sort(),
    );
    expect(closedSetFor("plane_requests_outcome_check").sort()).toEqual(
      [...PLANE_REQUEST_OUTCOMES].sort(),
    );
    expect(closedSetFor("plane_requests_reason_check").sort()).toEqual(
      [...PLANE_REQUEST_REASONS].sort(),
    );
    expect(closedSetFor("plane_requests_stopped_by_check").sort()).toEqual(
      [...PLANE_REQUEST_STOPS].sort(),
    );
  });

  it("the tap minters are exactly ADR-0006's two, in both stores (#224)", () => {
    // TWO CONSTRAINTS, ONE VOCABULARY. `taps.minter` says who released a
    // draft and `send_refusals.minter` says who was refused one, and both are
    // written from `TAP_MINTERS` — so a third keyless minter needs no
    // migration for the second of them, which is the whole reason the set is
    // pinned once rather than restated twice.
    //
    // The failure this catches is the sharpest of the list: a minter the code
    // writes that the store refuses is a rep tapping Enviar and getting a
    // constraint violation instead of a message going out.
    for (const constraint of ["taps_minter_check", "send_refusals_minter_check"]) {
      expect(`${constraint}: ${closedSetFor(constraint).sort().join(",")}`).toBe(
        `${constraint}: ${[...TAP_MINTERS].sort().join(",")}`,
      );
    }
  });

  it("the dashboard act verbs are exactly the fourteen a surface offers (#224, #223, #264, #323, #325)", () => {
    // Read from `@dito/seam` rather than restated here, exactly as the seat's
    // states are. The failure this catches is a rep act that cannot be
    // recorded: the API writes the verb in the same transaction as the act,
    // and ADR-0003 says an act with no evidence row is not a rep act — so a
    // word the store refuses is a button that does nothing.
    expect(closedSetFor("dashboard_acts_verb_check").sort()).toEqual(
      [...DASHBOARD_ACT_VERBS].sort(),
    );
  });

  it("the verbs that act on a chat are exactly the two scope switches (#223)", () => {
    // TWO PLACES ONE FACT HAS TO HOLD. `DASHBOARD_ACT_TARGET_OF_ROUTE` is what
    // the API validates a request body against — a post id or a directory row
    // id — and this CHECK is what the store demands of the row it writes. A
    // verb the API treats as a chat act that the store treats as a post act is
    // an act refused by `dashboard_acts_one_target_check` in the same
    // transaction as the allowlist write, which is a rep pressing a switch and
    // getting a constraint violation.
    const chatVerbs = Object.entries(DASHBOARD_ACT_TARGET_OF_ROUTE)
      .filter(([, target]) => target === "chat")
      .map(([route]) => DASHBOARD_ACT_VERB_OF_ROUTE[route as keyof typeof DASHBOARD_ACT_VERB_OF_ROUTE]);
    expect(closedSetFor("dashboard_acts_target_by_verb_check").sort()).toEqual(
      [...chatVerbs].sort(),
    );
  });

  it("the verb that acts on no target is exactly the notebook edit (#264)", () => {
    // The chat check's argument, for the third target: the API validates a
    // notebook body for the routes this record calls notepad acts, and the
    // store demands a row with no target for exactly the verbs this CHECK
    // lists. A disagreement is a Guardar refused by a constraint.
    const notepadVerbs = Object.entries(DASHBOARD_ACT_TARGET_OF_ROUTE)
      .filter(([, target]) => target === "notepad")
      .map(([route]) => DASHBOARD_ACT_VERB_OF_ROUTE[route as keyof typeof DASHBOARD_ACT_VERB_OF_ROUTE]);
    expect(closedSetFor("dashboard_acts_notepad_target_check").sort()).toEqual(
      [...notepadVerbs].sort(),
    );
  });

  it("the verbs that act on a run are exactly Pausar, Reanudar and Cancelar (#323)", () => {
    // The chat check's argument, for the fourth target: the API validates a
    // run body for the routes this record calls run acts, and the store
    // demands a run on the row for exactly the verbs this CHECK lists.
    const runVerbs = Object.entries(DASHBOARD_ACT_TARGET_OF_ROUTE)
      .filter(([, target]) => target === "run")
      .map(([route]) => DASHBOARD_ACT_VERB_OF_ROUTE[route as keyof typeof DASHBOARD_ACT_VERB_OF_ROUTE]);
    expect(closedSetFor("dashboard_acts_run_target_check").sort()).toEqual([...runVerbs].sort());
  });

  it("the verbs that act on an automation are exactly Activar, Descartar and the switch's two (#325)", () => {
    // The chat check's argument, for the fifth target: the API validates an
    // automation body for the routes this record calls automation acts, and
    // the store demands an automation on the row for exactly these verbs.
    const automationVerbs = Object.entries(DASHBOARD_ACT_TARGET_OF_ROUTE)
      .filter(([, target]) => target === "automation")
      .map(([route]) => DASHBOARD_ACT_VERB_OF_ROUTE[route as keyof typeof DASHBOARD_ACT_VERB_OF_ROUTE]);
    expect(closedSetFor("dashboard_acts_automation_target_check").sort()).toEqual([...automationVerbs].sort());
  });

  it("an automation's words are exactly what the runtime writes (#325, #364)", () => {
    // Read from `@dito/seam` rather than restated: a word the store refuses is
    // a rutina the twin wrote and could not keep, or one of Dito's rows the
    // runtime could not write.
    expect(closedSetFor("automations_state_check")).toEqual([...RUTINA_STATES]);
    expect(closedSetFor("automations_origin_check")).toEqual([...AUTOMATION_ORIGINS]);
    expect(closedSetFor("automations_trigger_event_check")).toEqual([...RUTINA_TRIGGER_EVENTS]);
    expect(closedSetFor("runs_created_by_check")).toEqual([...RUN_CREATORS]);
  });

  it("a run's states and its steps' kinds are exactly what the engine writes (#323)", () => {
    // Read from `@dito/seam` and the runs' own definition rather than restated.
    expect(closedSetFor("runs_state_check")).toEqual([...TWIN_RUN_STATES]);
    expect(closedSetFor("run_steps_kind_check")).toEqual([...TWIN_RUN_STEP_KINDS]);
    expect([...STEP_KINDS]).toEqual([...TWIN_RUN_STEP_KINDS]);
  });

  it("the documents a rep may acknowledge are exactly the three link day shows (#223)", () => {
    // Read from `@dito/copy` rather than restated here, exactly as notify's
    // are read from `@dito/notify` — the package that PUBLISHES the texts is
    // the one that owns their keys, and a mirror would be a second place to
    // drift. The failure this catches is the rep pressing «Acepto mi contrato,
    // versión N» and the store refusing the row.
    expect(closedSetFor("acknowledgments_document_check").sort()).toEqual(
      [...DOCUMENT_KEYS].sort(),
    );
  });

  it("the dashboard's outcome words are exactly the API's answer set (#224)", () => {
    // ONE SET, TWO PLACES IT MUST HOLD: the word the API answers a request
    // with is the word stamped on the act row, because audit coverage
    // enumerates by it — so a word in the code that the store refuses is an
    // act that rolls back AFTER it ran, and a word the store accepts that the
    // API never answers is a class that enumerates nothing.
    expect(closedSetFor("dashboard_acts_outcome_check").sort()).toEqual(
      [...TWIN_API_ACT_OUTCOMES].sort(),
    );
  });

  it("the Ledger's fact types are exactly the set the aperture files (#71)", () => {
    // Read from `@dito/aperture` rather than restated here: the aperture's
    // closed set and the store's CHECK are one vocabulary, and the failure
    // this catches is a type the code files that the store refuses — which
    // surfaces as a constraint violation on a real crossing, in front of a
    // rep, rather than in CI.
    expect(closedSetFor("ledger_facts_fact_type_check").sort()).toEqual(
      [...FACT_TYPES].sort(),
    );
  });

  it("every disposition and notice kind is a value some migration actually granted", () => {
    // The other direction of the same guard: a value listed here that no
    // migration ever added would mean the code writes a word the store
    // refuses. Both lists are read from the same place, so this holds by
    // construction — asserted anyway, because the sweep is only worth its
    // green if it read something.
    expect(closedSetFor("wa_event_processing_disposition_check").length).toBe(
      DISPOSITIONS.length,
    );
    expect(closedSetFor("notices_kind_check").length).toBe(NOTICE_KINDS.length);
  });
});

describe("a re-cut closed set never narrows (…100022's rule, machine-checked)", () => {
  it.each(CLOSED_SETS)("%s", (constraint) => {
    let standing: string[] | undefined;
    let standingFile = "";
    let cuts = 0;
    for (const file of MIGRATION_FILES) {
      const sql = readFileSync(path.join(MIGRATIONS, file), "utf8");
      for (const next of setsFor(sql, constraint)) {
        cuts += 1;
        expect(
          next.length,
          `${file} re-cut ${constraint} to nothing`,
        ).toBeGreaterThan(0);
        if (standing !== undefined) {
          // THE RULED REMOVALS ARE SUBTRACTED, and only the named ones
          // (ticket #218). A blanket exemption per constraint would let the
          // NEXT narrowing ride in behind the first; naming the value is
          // what keeps the exception a decision.
          const ruled = NARROWED_ONCE[constraint] ?? [];
          const dropped = standing.filter(
            (value) => !next.includes(value) && !ruled.includes(value),
          );
          expect(
            dropped,
            `${file} re-cut ${constraint} and dropped ${dropped.map((v) => `'${v}'`).join(", ")}, which ${standingFile} had granted — every value an earlier migration granted rides forward unless NARROWED_ONCE names it, and an unruled narrowing turns a shipped behaviour into a constraint violation`,
          ).toEqual([]);
        }
        standing = next;
        standingFile = file;
      }
    }
    // REFUSING TO PASS ON NOTHING (ADR-0028 doctrine): a constraint name no
    // migration defines would sweep zero cuts and report green, which is the
    // vacuous pass this whole file exists to refuse.
    //
    // ONE CUT IS ENOUGH, and the floor moved from two at #178. It was two
    // only because every constraint in the list happened to have been re-cut
    // already; requiring it would mean a closed set could not join this
    // guard until somebody had extended it once — so the guard would be
    // absent for exactly the window in which the FIRST re-cut lands, which
    // is the incentive backwards. A set on its first cut narrows nothing by
    // definition, and the loop above is what starts comparing the moment
    // there is a second.
    expect(cuts, `no migration defines ${constraint}`).toBeGreaterThan(0);
  });

  it("the ruled removal also drains that kind's outbox (Codex r1)", () => {
    // A NOTICE KIND IS A DELIVERY, NOT ONLY A VALUE. The executor claims
    // `WHERE outcome IS NULL ORDER BY created_at, id` with no age cutoff and
    // never reads `notices.kind`, so a command written before the narrowing
    // is dispatched whenever the plane next comes up — and the narrowed
    // CHECK cannot reach it, because that binds INSERTs and the row is
    // already written. Taking a kind out of this set is therefore two acts:
    // stop writing it, and settle what is already in flight. The second one
    // is the one a reader forgets, so it is checked here, against the file
    // the sweep above already identifies.
    //
    // It is ADR-0042's deploy-order rule in the retirement direction: the
    // runtime speaks a kind before any plane emits one, so a retirement
    // drains the kind out of the seam before the runtime stops speaking it.
    for (const kind of NARROWED_ONCE["notices_kind_check"] ?? []) {
      const file = fileThatDropped("notices_kind_check", kind);
      const sql = readFileSync(path.join(MIGRATIONS, file), "utf8");
      expect(
        sql,
        `${file} took '${kind}' out of notices_kind_check without settling that kind's pending deliveries — the executor would post one after the route it belongs to was retired`,
      ).toMatch(
        new RegExp(`UPDATE send_commands[\\s\\S]*?'${kind}'[\\s\\S]*?outcome IS NULL`),
      );
    }
  });

  it("catches a narrowing re-cut — the failure a hand-resolved merge makes", () => {
    // The violation, planted, in the shape both branches wrote it: a later
    // migration re-cutting the list from a stale ancestor and losing
    // `declined` — the word #49 added and #53 reuses. Both claims in one
    // test, because they are one claim about one parser: the sweep must
    // read the LAST cut, and must see what an earlier cut granted and this
    // one dropped.
    const narrowing = `
      ALTER TABLE t ADD CONSTRAINT wa_event_processing_disposition_check
        CHECK (disposition IN ('captured', 'drafted', 'affirmed', 'declined'));
      ALTER TABLE t ADD CONSTRAINT wa_event_processing_disposition_check
        CHECK (disposition IN ('captured', 'drafted', 'affirmed'));`;
    const cuts = setsFor(narrowing, "wa_event_processing_disposition_check");
    const [first, second] = cuts;
    expect(first).toEqual(["captured", "drafted", "affirmed", "declined"]);
    // The LAST cut is the one that stands, and it is the narrowed one.
    expect(cuts.at(-1)).toEqual(second);
    expect(second).not.toContain("declined");
    // ...which the monotonicity check reports as the dropped value, and the
    // standing-set check reports as a set that is not the runtime's.
    expect(first!.filter((v) => !second!.includes(v))).toEqual(["declined"]);
    expect([...second!].sort()).not.toEqual([...DISPOSITIONS].sort());
  });
});
