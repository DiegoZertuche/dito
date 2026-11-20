/**
 * The trigger: the typed origin record that creates an execution (ADR-0014
 * as amended — "something happens, a trigger fires, and that creates a
 * workflow"; the 2026-09-04 amendment — "the trigger record carries both its
 * mechanism and its occasion, so the execution record and the audit entry
 * say what a run was about and how it came to be").
 *
 * TWO WORDS, AND THEY ANSWER DIFFERENT QUESTIONS. The **occasion** is what
 * this run is about — an owner's question, a settled customer burst, a rep
 * message in the twin thread. The **mechanism** is how it came to be — a
 * seam event, the clock, or code asking. They vary independently, so the
 * record says both.
 *
 * ONE RECORD MEMBER PER OCCASION THAT CREATES AN EXECUTION. The owner's
 * question, by request; a settled customer turn, by seam event; a rep message
 * to their twin through either door, by seam event; a binding's kind
 * classification, by request; a rep act on the dashboard, by request; the
 * rep's arrival on Inicio, by request; an event the twin thread is told about;
 * and one step of a workflow run, by request — which is how everything the
 * clock fires reaches an execution (ADR-0014 as amended 2026-10-07: what the
 * clock fires is a `schedules` row that starts a run).
 * Each is its own execution and is handed its context whole, which is what
 * makes "context never spans two executions" true by construction rather than
 * by discipline.
 */

/**
 * WHAT AN EXECUTION MAY BE ABOUT (spec #171 decision 10).
 *
 * A CLOSED SET. `extraction` and `daily_disclosure` have no record member of
 * their own: they are the words a rep's or an operator's request names in
 * `runtime_requests` (`runtime_requests_occasion_check`), and what such a
 * request starts is a run of Dito's own automation, whose steps are
 * `run_step`s (ticket #364).
 */
export const OCCASIONS = [
  "owner_question",
  "chat_turn",
  "twin_thread_message",
  "entity_kind",
  "extraction",
  "daily_disclosure",
  // Ticket #224: a rep pressed a button on a card. See `DashboardActTrigger`
  // for why this is an OCCASION rather than a mechanism.
  "dashboard_act",
  // Tickets #266, #320: the rep opened Inicio and a turn of the twin thread
  // greets them and curates the canvas. See `ArrivalTrigger` for why the
  // page's ask is a request.
  "arrival",
  // Ticket #319: something happened that the twin thread is told about and
  // looks at — a post landed, the rep settled the spotlighted card, the rail
  // moved. See `TwinThreadEventTrigger`.
  "twin_thread_event",
  // Ticket #323: one step of a workflow run, which the runs engine asks for.
  // See `RunStepTrigger`.
  "run_step",
] as const;

/** One of the occasions. */
export type Occasion = (typeof OCCASIONS)[number];

/**
 * The owner asked the owner twin something. Company and question, both
 * opaque ids.
 *
 * `mechanism: "request"` and it can be no other: the owner web calls the
 * turn function directly from a server action, so there is no seam event
 * behind it and no clock. Written on the record rather than inferred from
 * the kind, because the two are independent everywhere else.
 */
export interface OwnerQuestionTrigger {
  readonly kind: "owner_question";
  readonly mechanism: "request";
  readonly companyId: string;
  readonly ownerQuestionId: string;
}

/**
 * A settled run of customer messages in one chat (ticket #172; spec #171
 * decisions 10 and 14; CONTEXT.md *Turn*).
 *
 * `mechanism: "seam_event"` and it can be no other: the occasion is
 * `wa_events` rows arriving and then going quiet, which is what the
 * consumer's settle predicate reads (#75). Nothing else fires it.
 *
 * THE ANCHOR AND THE REST, BOTH. The anchor is the message that closed the
 * turn — the row `drafts.in_reply_to_event_id` names and the one event whose
 * marker may say `drafted` (#75) — so it is named on its own rather than
 * left to be recovered by position from a list. The rest ride beside it
 * because the record has to be able to say how big the turn was: "one draft
 * answered three messages" is the whole claim #75 exists to make, and a
 * trigger carrying only the anchor could not state it. Ids, both of them,
 * from a column the seam owns.
 *
 * THE CHAT IS HERE AND IS NEVER IN THE REFERENCE. The occasion IS a chat's
 * turn, and spec #171 decision 10 names the chat among what this trigger
 * carries — so a reader of the value can say which conversation a run was
 * about without holding the caller's locals. `triggerRef` renders it
 * nowhere: a chat address dereferences to chat identity (ADR-0004) and a
 * chain entry is content-free (ADR-0020). `trigger.test.ts` is what keeps
 * those two sentences from drifting apart.
 */
export interface ChatTurnTrigger {
  readonly kind: "chat_turn";
  readonly mechanism: "seam_event";
  readonly twinId: string;
  /** The chat whose turn this is. Never rendered into a reference. */
  readonly chatJid: string;
  /** The message that closed the turn — the draft's own event. */
  readonly anchorEventId: string;
  /** Every `wa_events` row of the turn, the anchor included. */
  readonly eventIds: readonly string[];
}

/**
 * A rep message to their twin, through either door (tickets #173 and #261;
 * spec #171 decisions 10 and 18; spec #258 decision 2; CONTEXT.md *Twin
 * thread*, *Door*).
 *
 * `mechanism: "seam_event"` and it can be no other: the occasion is one row
 * the rep authored — a `wa_events` row in their own self-chat, or a
 * `dashboard_messages` row typed through *Habla con Dito* — which the
 * consumer's pass reads the moment it arrives. Nothing else fires it, and
 * nothing waits. The dashboard is an OCCASION and never a mechanism (ADR-0013
 * as amended): the set of three mechanisms stands, and `door` below is what
 * distinguishes the two ways the same occasion arrives.
 *
 * ONE EVENT, NOT A LIST, and the asymmetry with `chat_turn` beside it is the
 * whole difference between the two occasions. A customer's turn is a run of
 * messages taken as one (#75), so its trigger carries an anchor and the rest.
 * A rep speaking to their twin is answered per message — there is no settle
 * window in the thread and there must not be one, because a rep who asks
 * something is waiting on the answer.
 *
 * THE QUOTED POST IS THE REP SIDE'S OWN ID, never the rail's. When the rep
 * pointed at something the twin said, this is the identity the rep side
 * minted for that post — the notice's id, or the draft's when the post
 * carried a draft. Two reasons it is that rather than the quoted WhatsApp
 * message id. It is the class of reference the rep chain already carries
 * (`twin:<id> question:<id>` in `consumer.ts`), so a reader dereferences it
 * in `notices` or `drafts` directly rather than through the executor's
 * `send_executions` mapping. And it is minted by this side: a rail stanza id
 * is an identifier somebody else's system chose, and ADR-0020's refs are
 * ours.
 *
 * ABSENT MEANS THE REP QUOTED NOTHING OF THE TWIN'S. A quoted id that names
 * no post this twin made never reaches an execution at all — the router
 * answers it `captured` — so the field's absence is exactly "the rep wrote
 * without pointing at anything", which is the ordinary case. A message at the
 * DASHBOARD's door never carries one: its composer is text, with nothing to
 * point at.
 *
 * NO CHAT. Unlike `chat_turn`, this occasion has one and it is a constant:
 * the rep's own thread. Carrying the self-chat address would put a JID in a
 * record for no reader's benefit, and `triggerRef` would then have to
 * remember not to render it.
 */
export interface TwinThreadMessageTrigger {
  readonly kind: "twin_thread_message";
  readonly mechanism: "seam_event";
  readonly twinId: string;
  /**
   * WHICH DOOR THE REP SPOKE THROUGH (ticket #261; spec #258 decision 2;
   * ADR-0044 as amended).
   *
   * It is not decoration and it is not derivable: the answer this execution
   * composes is delivered THROUGH THIS DOOR and no other — a `twin_thread`
   * answer mints its `system_send` and the dashboard does not render it, a
   * `dashboard` answer is posted at the door and mints nothing — so «which
   * door asked» has to be on the record that created the run rather than
   * recovered afterwards from the shape of an id.
   *
   * The two words are `@dito/seam`'s `DOORS`, restated as a literal union
   * because this package depends on nothing (`automation.ts`'s own rule about
   * holding no seam). The runtime imports both and pins them against each
   * other.
   */
  readonly door: "twin_thread" | "dashboard";
  /**
   * The row the rep's message arrived on — what the answer is about and what
   * gets marked.
   *
   * WHICH STORE IT DEREFERENCES IN IS `door`'s to say: a `wa_events` id at the
   * twin thread's door, a `dashboard_messages` id at the dashboard's. Opaque
   * either way, which is what every id on a trigger already is (ADR-0020), so
   * a reader joins it through the door rather than by guessing at its shape.
   */
  readonly eventId: string;
  /** The twin post the rep quoted, as the rep side identifies it. */
  readonly quotedPostId?: string;
}

/**
 * The words an event the twin thread is told about is named by (ticket #319;
 * spec #318 decision 11; design §6), restated here as a literal union because
 * this package depends on nothing; the runtime owns the table of which of them
 * wake a turn.
 */
export type TwinThreadEventKind =
  | "post.landed"
  | "post.settled"
  | "post.seen"
  | "arrival"
  | "rail"
  | "matter.picked"
  | "selection"
  | "summons"
  | "run.started"
  | "run.step"
  | "run.suspended"
  | "run.finished"
  | "run.failed"
  | "expiring"
  | "rutina.paused"
  | "rutina.resumed"
  | "rutina.discarded";

/**
 * AN EVENT WOKE THE TWIN THREAD (ticket #319; spec #318 decision 11; ADR-0014
 * as amended 2026-09-27: "the seam's events wake its turns").
 *
 * A TURN WITH NO REP LINE BEHIND IT, and that is why it is its own occasion
 * rather than a `twin_thread_message` with an empty message: the record has
 * to say which events WOKE a turn — the wake list's claim is checkable only
 * if an event that merely appended leaves no record and one that woke leaves
 * this — and a turn woken by an event carries no rep evidence, so no tool
 * acting on the rep's word can pass its gate (ADR-0013's third shape).
 *
 * `mechanism: "seam_event"`: every event is a fact the seam's rows already
 * hold — a post written, a card settled, the rail's status — told to the
 * thread where the runtime learns it.
 *
 * METADATA ONLY: the event's word and, when it is about a post, the post's
 * id. Never its text, a name, or anything a customer wrote (spec #318
 * decision 12).
 */
export interface TwinThreadEventTrigger {
  readonly kind: "twin_thread_event";
  readonly mechanism: "seam_event";
  readonly twinId: string;
  readonly event: TwinThreadEventKind;
  /** The post the event is about, when it is about one. */
  readonly postId?: string;
}

/**
 * A confirmed binding's customer, classified — person or business (ticket
 * #176; spec #171 decisions 10 and 26; ADR-0015 as amended, ADR-0035).
 *
 * `mechanism: "request"` and it can be no other, which is what makes this
 * member worth having beside the two seam-event ones. Nothing on the seam
 * fires a classification: CODE asks for one, at three call sites that share
 * this occasion and differ only in when they run — the live confirmation the
 * moment a rep's «va» is routed, the startup backlog before the poll loop,
 * and the operator's hand-run backfill. The rep's «va» IS a seam event, but
 * it is the BINDING's occasion rather than this one, and it has already been
 * matched and confirmed by code before anything is classified.
 *
 * THE CHAT IS HERE AND IS NEVER IN THE REFERENCE, exactly as `ChatTurnTrigger`
 * has it: spec #171 decision 10 names the chat among what this trigger
 * carries — a reader of the value can say which conversation the model was
 * shown — and `triggerRef` renders it nowhere, because a chat address
 * dereferences to chat identity (ADR-0004) and a chain entry is content-free
 * (ADR-0020). `trigger.test.ts` is what keeps those two sentences from
 * drifting apart.
 *
 * THE ENTITY IS THE POINT OF THE RECORD. A classification's whole output is
 * one word about one entity, and the entity id is the rep side's own mint
 * (ADR-0035) carried unchanged into the Ledger — so it is the id a reader
 * joins the chain entry to the Ledger entity row on, and the one the
 * aperture's own `entity_kind` entries already carry.
 */
export interface EntityKindTrigger {
  readonly kind: "entity_kind";
  readonly mechanism: "request";
  readonly twinId: string;
  /** The chat whose words the classification reads. Never rendered into a reference. */
  readonly chatJid: string;
  /** The entity being classified — the rep side's own mint (ADR-0035). */
  readonly entityId: string;
}

/**
 * A REP ACT ON THE DASHBOARD (ticket #224; spec #214 decision 2 and *The feed,
 * in detail*; ADR-0013, ADR-0037 as amended).
 *
 * AN OCCASION AND NOT A MECHANISM, and the choice is worth arguing because
 * both readings are available. The occasion answers WHAT THIS RUN IS ABOUT and
 * the mechanism answers HOW IT CAME TO BE (the module header), and a rep
 * pressing **Descartar** on a card is a new thing to be about: it is not a
 * message in the twin thread — there is no `wa_events` row, no words, and
 * nothing for a model to read — and every existing occasion names something
 * else entirely. Reading it as a mechanism would say the same run could arrive
 * "as a dashboard" AND as one of the six, which is exactly what is not true:
 * no other occasion has a dashboard arm, and this one has no seam arm.
 *
 * `mechanism: "request"` and it can be no other, which is `EntityKindTrigger`'s
 * own position: CODE asks — the runtime's local API, having authenticated a
 * request — and nothing on the seam or on the clock fires it. The rep's tap IS
 * an event in the world, but it reaches this process as an HTTP request and
 * leaves a row behind, which is the definition of the request mechanism rather
 * than a stretch of it.
 *
 * THE ACT ROW IS THE OCCASION'S OWN ID, and it is also this run's class-2
 * evidence (ADR-0003, as `RepActEvidence`'s dashboard arm). One row per act,
 * written by the API in the act's own transaction, so it is the id a reader
 * joins this execution to and the id the aperture's stores name.
 *
 * THE POST IS WHAT THE REP ACTED ON, as the rep side identifies it — the same
 * class of reference `TwinThreadMessageTrigger.quotedPostId` carries, and for
 * the same two reasons: it dereferences in `posts` directly, and it is minted
 * by this side. A card IS a post, so this is the dashboard's exact analogue of
 * "what the rep quoted", and it is never a draft id or a line id (`acts.ts`'
 * rule TWO).
 *
 * NO CHAT AND NOT A SYLLABLE OF ANYTHING SAID. The occasion has no chat — the
 * rep is in their own dashboard — and a button carries no words at all, which
 * is what makes this the one occasion whose trigger could not leak content if
 * it tried. That holds for #223's two scope switches as well, and it is the
 * reason the second target below is a directory ROW: the row is the handle the
 * scoping page listed, and the chat it names never leaves the runtime.
 */
export interface DashboardActTrigger {
  readonly kind: "dashboard_act";
  readonly mechanism: "request";
  readonly twinId: string;
  /** The `dashboard_acts` row this run was created for — and its evidence. */
  readonly dashboardActId: string;
  /**
   * The post whose card the rep acted on, as the rep side identifies it.
   *
   * OPTIONAL, because a rep may act on something that is not a card: a chat's
   * switch on the scoping page, or their own notepad on *Mi libreta* (ticket
   * #264). At most one of this and `chatDirectoryId` is set, and neither for
   * the notepad, which is the seat's own and has no id — the store says so out
   * loud (`dashboard_acts_one_target_check`,
   * `dashboard_acts_notepad_target_check`) and the caller derives which from
   * the route rather than choosing it. It is an optional field rather than a
   * second trigger kind because the OCCASION has not changed: a rep pressed
   * something on the dashboard, which is what this trigger names.
   */
  readonly postId?: string;
  /** ...or the chat directory row whose switch they flipped (ticket #223). */
  readonly chatDirectoryId?: string;
  /** ...or the workflow run they paused, took up again or cancelled on Trabajos (ticket #323). */
  readonly runId?: string;
  /**
   * ...or the automation they activated, discarded, paused or took up again on
   * Rutinas (ticket #325): a shipped automation's registry word or a rutina's id.
   */
  readonly automation?: string;
}

/**
 * THE REP OPENED INICIO (ticket #266; spec #258 decision 15; ADR-0014 as
 * amended — the `arrival` occasion).
 *
 * `mechanism: "request"`, and ADR-0014's amendment names the mechanism
 * `dashboard`, a word `TRIGGER_MECHANISMS` does not hold. The closed set's
 * three words say how a run came to be — a seam event, the clock, or code
 * asking — and this one is code asking: the page's arrival ask records a row,
 * and the runtime's pass asks for the execution, which is the shape the
 * dashboard act beside it already records as `request`. Which
 * surface the rep arrived at is the occasion's, not the mechanism's.
 *
 * METADATA ONLY, AS EVERY TRIGGER: the seat, the arrival's own row, which
 * visit of the day it is, and two instants — when the rep arrived and when
 * they last did. Never content: what waits on the canvas is read by the
 * execution's context, and nothing the twin composed is on this record.
 *
 * THE LAST ARRIVAL'S INSTANT IS HERE BECAUSE IT IS WHAT THE RETURN LINE IS
 * ABOUT: «what changed since the last visit» is a delta between two
 * instants, and a reader of the chain asking what a return line covered finds
 * both on the entry.
 */
export interface ArrivalTrigger {
  readonly kind: "arrival";
  readonly mechanism: "request";
  readonly twinId: string;
  readonly seatId: string;
  /** The `rep_arrivals` row the ask wrote. */
  readonly arrivalId: string;
  /** The runtime's `ARRIVAL_VISITS`, restated. */
  readonly visit: "first_of_day" | "return";
  /** When the rep arrived, as an ISO instant. */
  readonly arrivedAt: string;
  /** When they last arrived before this, as an ISO instant — absent on a first arrival ever. */
  readonly lastArrivedAt?: string;
}

/**
 * ONE STEP OF A WORKFLOW RUN (ticket #323; spec #318 decisions 22, 23 and 37;
 * ADR-0012 as amended 2026-09-27: a run is a session, its steps typed).
 *
 * EVERY STEP IS ITS OWN EXECUTION, whatever its kind: an `agent` step is a
 * model turn on the run's session, and every other kind is code with no
 * model in it, recorded the way a dashboard act is — so a run leaves one
 * record and one chain entry per step that ran (a child run's under its own
 * id), and the record says which step of which run it was.
 *
 * `mechanism: "request"`: the runs engine asks for the step from the
 * runtime's pass, whatever moved the run there — the clock firing a wait, a
 * card settling, the step before it ending: the clock is code in the pass,
 * and what it fires is a request.
 *
 * METADATA ONLY: the run's id and the step's index in its definition. What
 * the step was told, what it read and what it produced live in the run's
 * session and its sealed content, never here.
 */
export interface RunStepTrigger {
  readonly kind: "run_step";
  readonly mechanism: "request";
  readonly twinId: string;
  readonly runId: string;
  /** The step's index in the run's definition, from 0. */
  readonly step: number;
}

/** What may create an execution. One member per occasion; open by design. */
export type Trigger =
  | OwnerQuestionTrigger
  | ChatTurnTrigger
  | TwinThreadMessageTrigger
  | EntityKindTrigger
  | DashboardActTrigger
  | ArrivalTrigger
  | TwinThreadEventTrigger
  | RunStepTrigger;

/**
 * The trigger as an opaque audit reference (ADR-0020: "caller identity +
 * action type + opaque refs + outcome", chain entries content-free).
 *
 * IDS ONLY, and the company first, matching `entityKindRef`'s ordering in
 * the aperture: an id minted by the owning app is a reference, and the
 * question's TEXT — the one field of an owner question that is content — is
 * never in here. The kind and the mechanism are named because a reader of
 * the chain asking "what set this off" cannot get that from a pair of
 * UUIDs, and neither word is content: one is a shape, the other is a
 * shape's origin.
 *
 * THE KIND STAYS THE FIRST TOKEN AND THE IDS KEEP THEIR SPELLING, which is
 * not cosmetic: audit coverage matches an execution's entry by finding the
 * token `owner_question:<id>` inside this string (`audit-coverage.ts`, the
 * `execution` class), so the mechanism is added BESIDE the existing tokens
 * rather than folded into one of them.
 *
 * IT REFUSES A KIND IT CANNOT RENDER, rather than falling off the end
 * (Codex r3). The switch is exhaustive over `Trigger`, so nothing reaches the
 * default arm through the type — what reaches it is a value that arrived past
 * one: a cast, or a record read back out of a store. Without the throw such a
 * value returns `undefined` and writes `undefined instructions:…` onto an
 * append-only chain. Throwing is the correct trade and the one the runner is
 * already built for: the audit append happens before the record is returned,
 * fail-closed, so an execution whose reference cannot be rendered leaves no
 * record and no entry rather than a malformed one that can never be repaired
 * (ADR-0020). The arm stays as the union grows, which is what keeps that true
 * of a seventh occasion whose ref nobody wrote.
 */
export class TriggerRefError extends Error {
  override readonly name = "TriggerRefError";
}

export function triggerRef(trigger: Trigger): string {
  switch (trigger.kind) {
    case "owner_question":
      return `trigger:owner_question mechanism:${trigger.mechanism} company:${trigger.companyId} owner_question:${trigger.ownerQuestionId}`;
    case "chat_turn":
      // THE TWIN, THE ANCHOR AND A COUNT — no chat and no message. The
      // rep chain's existing refs are `twin:<id> index:<n> event:<id>` and
      // `twin:<id> question:<id>` (`consumer.ts`), so the twin comes first
      // here for the same reason the company does above: the owning
      // deployment's own id is the reference a reader starts from.
      //
      // THE EVENT COUNT RATHER THAN THE EVENT IDS, and it is a judgement
      // worth stating. Every id is opaque and content-free, so listing all
      // of them would break no rule — but a ref is read by a person, one
      // turn can carry forty ids (`MAX_TURN_MESSAGES`), and the anchor is
      // the one id anything else in this repo can be joined on. The count
      // is what makes "one draft answered three messages" readable in the
      // chain; the whole list is in the execution record's own trigger,
      // which is where a reader who needs it goes.
      return `trigger:chat_turn mechanism:${trigger.mechanism} twin:${trigger.twinId} event:${trigger.anchorEventId} events:${trigger.eventIds.length}`;
    case "twin_thread_message":
      // THE TWIN, THE REP'S OWN ROW, WHAT THEY POINTED AT AND WHICH DOOR THEY
      // CAME IN BY — no chat (the occasion has one and it is the rep's own
      // thread) and not a syllable of what they wrote.
      //
      // `quoted:none` RATHER THAN AN OMITTED TOKEN, and the reason is that
      // a ref is read by a person: six tokens on every entry of this
      // occasion means "did the rep quote anything" is answered by looking
      // at the same position every time, instead of by counting tokens. The
      // word is English metadata like every other token here.
      //
      // THE DOOR IS APPENDED AND THE EARLIER POSITIONS DO NOT MOVE (ticket
      // #261), because audit coverage matches an execution's entry by finding
      // a token inside this string — so a token is added BESIDE the existing
      // ones, never folded into one. It is also the one thing an entry cannot
      // otherwise say: `event:` is opaque, and which store it lives in is what
      // decides whether this run's answer was sent or posted at a door.
      return `trigger:twin_thread_message mechanism:${trigger.mechanism} twin:${trigger.twinId} event:${trigger.eventId} quoted:${trigger.quotedPostId ?? "none"} door:${trigger.door}`;
    case "entity_kind":
      // THE TWIN AND THE ENTITY — no chat, following `chat_turn`'s
      // precedent one line up rather than inventing a second rule. The
      // trigger CARRIES the chat because the occasion is a chat's
      // conversation being read; the ref carries the two ids a reader can
      // join on, and a JID is neither of them (ADR-0004, ADR-0020).
      //
      // AND NO KIND. The outcome of the classification is on the RECORD, as
      // its disposition — `classified` — and in the aperture's own
      // `entity_kind` chain entry, whose outcome names the value. Putting
      // it here would say it a third time, in the one place that is
      // append-only and cannot be corrected.
      return `trigger:entity_kind mechanism:${trigger.mechanism} twin:${trigger.twinId} entity:${trigger.entityId}`;
    case "dashboard_act":
      // THE TWIN, THE ACT AND THE POST — three ids, and the act's is the one
      // this occasion is joined on: `dashboard_acts` is one row per act and
      // the aperture's own stores name the same id, so a reader can walk an
      // entry to the evidence and from the evidence to what it authorized.
      //
      // AND NOT THE VERB. Which act it was is on the ACT ROW, in a column with
      // a CHECK over the closed set; the execution's own disposition says
      // whether it happened. Putting the word here would say it a third time,
      // in the one place that is append-only — `entity_kind`'s own argument
      // about its kind, applied to a verb.
      //
      // BOTH TARGET TOKENS ALWAYS, ONE OF THEM `none` (ticket #223), which is
      // `twin_thread_message`'s `quoted:none` decision applied to a pair: a
      // ref is read by a person, so five tokens on every entry of this
      // occasion means «what did the rep act on» is answered by looking at the
      // same two positions every time rather than by counting tokens.
      //
      // THE RUN AND THE AUTOMATION ARE THE THIRD AND FOURTH TARGETS (tickets
      // #323, #325), after the two, so every token keeps its position.
      return `trigger:dashboard_act mechanism:${trigger.mechanism} twin:${trigger.twinId} act:${trigger.dashboardActId} post:${trigger.postId ?? "none"} chat_row:${trigger.chatDirectoryId ?? "none"} run:${trigger.runId ?? "none"} automation:${trigger.automation ?? "none"}`;
    case "arrival":
      // THE TWIN, THE SEAT, THE ARRIVAL ROW, WHICH VISIT, AND THE TWO
      // INSTANTS — every token metadata, and `last:none` rather than an
      // omitted token on a first arrival ever, `quoted:none`'s rule: the same
      // positions answer the same question on every entry of this occasion.
      //
      // NOT THE LINE AND NOT THE CURATION. What the twin said rests sealed in
      // the arrival post's parts, and which posts it put first is layout over
      // the rep's own cards — neither belongs on an append-only chain.
      return `trigger:arrival mechanism:${trigger.mechanism} twin:${trigger.twinId} seat:${trigger.seatId} arrival:${trigger.arrivalId} visit:${trigger.visit} at:${trigger.arrivedAt} last:${trigger.lastArrivedAt ?? "none"}`;
    case "twin_thread_event":
      // THE TWIN, THE EVENT'S WORD AND THE POST IT IS ABOUT — `post:none` on an
      // event about no post, `quoted:none`'s rule: the same positions answer
      // the same question on every entry of this occasion. The word is metadata
      // and the one thing an entry cannot otherwise say: which event woke it.
      return `trigger:twin_thread_event mechanism:${trigger.mechanism} twin:${trigger.twinId} event:${trigger.event} post:${trigger.postId ?? "none"}`;
    case "run_step":
      // THE TWIN, THE RUN AND THE STEP — the run's id is the one `runs` and
      // `run_steps` are keyed on, so a reader walks an entry to the step's
      // checkpoint and from it to the run. Not the step's kind: that is the
      // checkpoint's own column, and here it would say it a second time.
      return `trigger:run_step mechanism:${trigger.mechanism} twin:${trigger.twinId} run:${trigger.runId} step:${String(trigger.step)}`;
    default:
      throw new TriggerRefError(
        `no audit reference is defined for the occasion "${String((trigger as Trigger).kind)}": a trigger record and its ids arrive with the occasion (#172), and a chain entry must never carry an unrendered reference (ADR-0020)`,
      );
  }
}
