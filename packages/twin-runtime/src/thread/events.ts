/**
 * WHAT THE TWIN THREAD IS TOLD HAPPENED, AND WHICH OF IT WAKES A TURN (ticket
 * #319; spec #318 decision 11; design D5 and §6, the wake list ruled
 * 2026-09-27).
 *
 * Every post landing, settle and seen-stamp, the rep's arrival, the rail's
 * state, a matter the rep picked from the twin's own (ticket #335), a
 * phrase they selected in one of its cards (ticket #341), a card they
 * summoned it to (ticket #340), a workflow run moving (ticket #323) and the
 * rep switching off, back on or discarding one of their rutinas (ticket #386) reach the day's
 * session as a short user message marked as an event — so the twin knows what
 * is on the canvas and when it leaves, without anybody rendering rows into its
 * prompt.
 *
 * METADATA, with two exceptions below: a kind word and ids. Never a name, a
 * card's whole text or anything a customer wrote (spec #318 decision 12); the
 * twin reads those only when it goes looking, through its tools.
 *
 * TWO EVENTS CARRY WORDS, AND THEY ARE THE TWIN'S OWN: a picked matter names
 * itself by the label the twin wrote in its notes (ticket #335), and a
 * selection by the phrase the rep selected, as the twin wrote it on its card
 * (ticket #341) — a stretch of its sentence, of a draft's body or of a line of
 * the day's notes, its names as references. Never the rep's words and never a
 * customer's.
 *
 * THE WAKE LIST IS THE ONE PLACE CODE DECIDES WHEN THE TWIN LOOKS, never what
 * it does (design §6; agentic first, 2026-09-29). An event that wakes gets a
 * turn of its own after the running one; an event that does not is appended
 * and read at the twin's next turn.
 */
import { renderTurnInstant, type TwinThreadEventKind } from "@dito/execution";
import type { SettleOutcome, TwinOpenMatterSubject } from "@dito/seam";
import type { ReminderSubject } from "../runs/reminder-rows.js";
import { SUBJECT_WORDS } from "../working-memory.js";

/**
 * One event, as the runtime learns it.
 *
 * `byRep` ON A SETTLE IS WHETHER THE REP'S OWN ACT SETTLED IT — a button on
 * the card. A send's outcome reported by the rail and an act the twin
 * performed in one of its own turns are not the rep's act on the card, and
 * the wake list reads the difference.
 */
export type ThreadEvent =
  | {
      readonly kind: "post.landed";
      readonly postId: string;
      /** Which kind of card: a draft, a question, the day's notes. */
      readonly postKind: string;
      /** The occasion of the execution that posted it, or `code` where no model did. */
      readonly source: string;
    }
  | {
      readonly kind: "post.settled";
      readonly postId: string;
      readonly outcome: SettleOutcome;
      readonly byRep: boolean;
    }
  | { readonly kind: "post.seen"; readonly postId: string }
  | {
      readonly kind: "arrival";
      readonly door: "dashboard";
      readonly firstOfDay: boolean;
      /**
       * The arrival row and its seat, and the two instants the turn's trigger
       * records — what the turn is opened with, never told as content.
       */
      readonly arrival: {
        readonly arrivalId: string;
        readonly seatId: string;
        readonly arrivedAt: Date;
        readonly lastArrivedAt?: Date;
      };
    }
  | { readonly kind: "rail"; readonly state: string; readonly since?: string }
  /**
   * THE REP PICKED ONE OF THE TWIN'S OPEN MATTERS at the bar's «¿Dónde
   * quedamos?» (ticket #335): what the matter is about and the twin's own
   * label for it, as its notes hold them — the label is the twin's words, never
   * the rep's or a customer's. `pickId` and `seatId` are where the turn's line
   * goes, never told as content.
   */
  | {
      readonly kind: "matter.picked";
      readonly about: TwinOpenMatterSubject;
      readonly label: string;
      readonly pickId: string;
      readonly seatId: string;
    }
  /**
   * THE REP SELECTED A PHRASE IN ONE OF THE TWIN'S CARDS and let go, asking
   * nothing (ticket #341; the spine's movement 7): the card, and the phrase as
   * the twin wrote it there — its references, never the names the page drew.
   * Where on the card it sits is the twin's to read (`read_post`): the same
   * words can stand in its sentence and in the draft. `selectionId` and
   * `seatId` are where the turn's line goes, never told as content.
   */
  | {
      readonly kind: "selection";
      readonly postId: string;
      readonly phrase: string;
      readonly selectionId: string;
      readonly seatId: string;
    }
  /**
   * THE REP SUMMONED THE ONE PRESENCE AND IT LANDED ON ONE OF THE TWIN'S
   * CARDS (ticket #340; the spine's movement 6, «Ven conmigo»): the card, by
   * its post id, and nothing else — the twin reads it with `read_post` if it
   * wants the words, and may speak on it with `say_on_card`. `summonsId` and
   * `seatId` are where the turn's sentence goes, never told as content.
   */
  | {
      readonly kind: "summons";
      readonly postId: string;
      readonly summonsId: string;
      readonly seatId: string;
    }
  /**
   * A WORKFLOW RUN MOVED (ticket #323; spec #318 decision 11): the engine took
   * it, one of its steps ended, a wait parked it, or it ended. The run's id,
   * the step's index and the state word — what the run is for and what it
   * found are its own, read with `read_runs` and on its report.
   *
   * AN END NAMES THE REPORT THE RUN POSTED, by its post id — the twin reads
   * its words with `read_post` when it wants them.
   */
  | { readonly kind: "run.started"; readonly runId: string }
  | {
      readonly kind: "run.step";
      readonly runId: string;
      readonly step: number;
      readonly state: "succeeded" | "failed";
    }
  | { readonly kind: "run.suspended"; readonly runId: string; readonly step: number }
  | {
      readonly kind: "run.finished";
      readonly runId: string;
      /** `cancelled` for a run the thread or the rep cancelled. */
      readonly state: "succeeded" | "cancelled";
      /** The report the run posted last, which the twin reads with `read_post`. */
      readonly postId?: string;
    }
  | {
      readonly kind: "run.failed";
      readonly runId: string;
      readonly step: number;
      /** The report the run's end posted. */
      readonly postId?: string;
    }
  /**
   * ONE OF THE TWIN'S CARDS IS ABOUT TO LAPSE (ticket #364; ADR-0031 as
   * amended 2026-10-07): a reminder's one-shot row came due — a question on
   * its sixth day, the day's notes two hours before their window closes, a
   * draft waiting since yesterday — and the card still waits. The card and
   * the subject; whether to knock, and with what sentence, is the thread's.
   */
  | {
      readonly kind: "expiring";
      readonly postId: string;
      readonly subject: ReminderSubject;
    }
  /**
   * THE REP DID SOMETHING TO ONE OF THEIR RUTINAS ON RUTINAS (ticket #386;
   * Diego's ruling of 2026-10-11: the twin is told what the rep did with its
   * rutina): switched it «En pausa», back to «Activa», or discarded it. The
   * rutina's id — what it is and when it runs the twin reads where it wrote
   * it. Accepting or discarding a proposal card is that card settling.
   */
  | {
      readonly kind: "rutina.paused" | "rutina.resumed" | "rutina.discarded";
      readonly rutinaId: string;
    };


/** What the wake list says of one event: a turn of its own, or only a line in the session. */
export type EventFate = "wake" | "append";

/**
 * THE WAKE LIST, ruled 2026-09-27 (design §6), as one table.
 *
 * `post.landed` WAKES, ALWAYS: silence about a card is the twin's decision
 * and never code's default. `post.settled` wakes only when the settle was the
 * rep's own act on the card the twin's arrangement put at the top — the one it
 * put in front of them — and otherwise appends; the top card is read where the
 * table is applied (`top`). `post.seen` appends.
 *
 * `rail` APPENDS (ticket #401; boundary #327, F13, ruled by Diego 2026-10-13):
 * the phone link going down or coming back never wakes the twin — an outage
 * woke turns that posted unasked. The day's session keeps the line, so the
 * twin's next turn knows the link's state, and the dashboard shows it in
 * code's words (the rail card).
 *
 * `arrival` WAKES (ticket #320; design D4): the greeting, the return line and
 * the spotlight are the thread's own turn, and no other automation greets.
 * The throttle stands before the event is ever raised (`arrival.ts`).
 *
 * `matter.picked` WAKES (ticket #335): the rep asked where a matter stands by
 * picking it, and the twin resumes it in its own words.
 *
 * `selection` WAKES (ticket #341): the rep pointed at words on one of the
 * twin's cards, which is asking what they are.
 *
 * `summons` WAKES (ticket #340): the rep brought the twin to a card, which is
 * asking it to say something there — or nothing, which is its call.
 *
 * A RUN WAKES THE THREAD AT ITS START, ITS END AND ITS FAILURE, NEVER ITS
 * STEPS (ticket #323; ADR-0012 as amended, ruled 2026-09-27): `run.step` and
 * `run.suspended` append.
 *
 * `expiring` WAKES (ticket #364; ADR-0031 as amended 2026-10-07): the thread
 * alone knocks, so a card about to lapse is the thread's to announce or not.
 *
 * WHAT THE REP DID TO A RUTINA APPENDS (ticket #386): they did it on Rutinas,
 * knowing what they did, and nothing in it asks the twin to speak; the day's
 * session keeps it, so the twin's next turn knows the rutina is paused or gone
 * — as a run starting is kept.
 */
export const WAKE_LIST: {
  readonly [K in ThreadEvent["kind"]]: (
    event: Extract<ThreadEvent, { kind: K }>,
    context: { readonly top: string | undefined },
  ) => EventFate;
} = {
  "post.landed": () => "wake",
  "post.settled": (event, { top }) =>
    event.byRep && top === event.postId ? "wake" : "append",
  "post.seen": () => "append",
  arrival: () => "wake",
  rail: () => "append",
  "matter.picked": () => "wake",
  selection: () => "wake",
  summons: () => "wake",
  // A RUN STARTING WAKES NOTHING (boundary #327, F4, ruled 2026-10-09): the
  // turn that started it already told the rep, and a run a rutina fired is on
  // Trabajos en curso; the day's session keeps the line for the next turn.
  "run.started": () => "append",
  "run.step": () => "append",
  "run.suspended": () => "append",
  "run.finished": () => "wake",
  "run.failed": () => "wake",
  expiring: () => "wake",
  "rutina.paused": () => "append",
  "rutina.resumed": () => "append",
  "rutina.discarded": () => "append",
};

/** The fate of one event under the wake list. */
export function fateOf(
  event: ThreadEvent,
  context: { readonly top: string | undefined },
): EventFate {
  const rule = WAKE_LIST[event.kind] as (
    event: ThreadEvent,
    context: { readonly top: string | undefined },
  ) => EventFate;
  return rule(event, context);
}

/** The event's word on the trigger record, `@dito/execution`'s own union. */
export function eventKindOf(event: ThreadEvent): TwinThreadEventKind {
  return event.kind;
}

/** The post an event is about, when it is about one. */
export function postOf(event: ThreadEvent): string | undefined {
  if (event.kind === "matter.picked") return event.about.kind === "post" ? event.about.id : undefined;
  return "postId" in event ? event.postId : undefined;
}

/**
 * The event as one line of the session: the word, its ids as JSON, and
 * when it happened in the seat's zone — English bracketed metadata (#143), so
 * it cannot be read as anybody's speech.
 */
export function renderEvent(
  event: ThreadEvent,
  at: Date,
  timeZone: string,
): string {
  return `[Event · ${renderTurnInstant(at, timeZone)}] ${event.kind} ${JSON.stringify(fieldsOf(event))}`;
}

/** The event's ids and words, named as the design names them. */
function fieldsOf(event: ThreadEvent): Record<string, string | boolean> {
  switch (event.kind) {
    case "post.landed":
      return { post_id: event.postId, kind: event.postKind, source: event.source };
    case "post.settled":
      return { post_id: event.postId, outcome: event.outcome };
    case "post.seen":
      return { post_id: event.postId };
    case "arrival":
      return { door: event.door, first_of_day: event.firstOfDay };
    case "rail":
      // THE OUTAGE AS THE WATCH TELLS IT (boundary #327, F2): its state and
      // when the link went down — told once, after it has lasted.
      return { state: event.state, ...(event.since === undefined ? {} : { down_since: event.since }) };
    case "matter.picked":
      // THE MATTER AS THE TWIN'S NOTES NAME IT: its own label, and what it is
      // about in the words its working notes use.
      return { about: `${SUBJECT_WORDS[event.about.kind]} ${event.about.id}`, label: event.label };
    case "selection":
      // THE CARD AND THE PHRASE AS THE TWIN WROTE IT.
      return { post_id: event.postId, phrase: event.phrase };
    case "summons":
      return { post_id: event.postId };
    case "run.started":
      return { run_id: event.runId };
    case "run.step":
      return { run_id: event.runId, step: String(event.step + 1), state: event.state };
    case "run.suspended":
      return { run_id: event.runId, step: String(event.step + 1), state: "waiting" };
    case "run.finished":
      return {
        run_id: event.runId,
        state: event.state,
        ...(event.postId === undefined ? {} : { post_id: event.postId }),
      };
    case "run.failed":
      return {
        run_id: event.runId,
        step: String(event.step + 1),
        state: "failed",
        ...(event.postId === undefined ? {} : { post_id: event.postId }),
      };
    case "expiring":
      return { post_id: event.postId, subject: event.subject };
    case "rutina.paused":
    case "rutina.resumed":
    case "rutina.discarded":
      return { rutina_id: event.rutinaId };
  }
}

/**
 * Where the runtime tells the thread an event happened: a call beside the
 * seat-event publish that already stands at each emitter, inside the runtime
 * process. Never awaits and never fails the emitter — the event is queued and
 * the pass delivers it (`sessions.ts`). An event a restart may lose, which is
 * why no ask of the rep's is one (`RaisedThreadEvent`).
 */
export interface ThreadEventSink {
  raise(twinId: string, event: RaisedThreadEvent): void;
}

/**
 * THE EVENTS THAT ARE ONLY TOLD (ticket #358): a card landing, settling or
 * seen, the rail, a run moving, a card about to lapse, what the rep did to a
 * rutina. The rep's arrival,
 * pick, selection and summons are asks, and an ask is a row the pass reads
 * (`rep-asks.ts`), so none of them is ever raised.
 */
export type RaisedThreadEvent = Exclude<
  ThreadEvent,
  { readonly kind: "arrival" | "matter.picked" | "selection" | "summons" }
>;
