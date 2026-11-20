/**
 * WHETHER A REP-ACT TOOL MAY ACT (ticket #174; ADR-0003 as amended;
 * ADR-0013's 2026-09-04 amendment).
 *
 * ADR-0003's class-2 rule is that "a rep act must reference verifiable
 * rep-act evidence, matched by deterministic code, never by model output",
 * and ADR-0013's third gate shape lifts it onto twin-side state: a tool
 * that writes on the rep's behalf takes the id of the rep's own message and
 * verifies by code that it is the one that created this execution. This is
 * that code, once, for all four tools and for both doors.
 *
 * TWO CHECKS, AND NEITHER SUBSUMES THE OTHER.
 *
 * The FIRST is structural and it is the whole gate: `input.evidence ===
 * deps.trigger.eventId`. The trigger is, by construction, the rep's own
 * message this execution was created for — the router reads one row, a
 * `wa_events` row from the thread or a `dashboard_messages` row from the
 * door, decides it is not one of the two keyword acts, and builds the trigger
 * from that row (`consumer.ts`) — so an id that equals it is the rep's own
 * present act and an id that does not is one of four things the ticket names
 * by hand: another message of the rep's, a customer-chat message, a message
 * from a different execution, or nothing at all. All four fail one comparison,
 * which is why there is one check and not four. Nothing the model can send
 * widens it, because the only value that passes is one the runtime already
 * holds.
 *
 * The SECOND is the re-verification the aperture has always done
 * (`classifyApertureInput`): the row really exists under this twin and, on the
 * thread's door, its envelope really carries this WhatsApp message id, it was
 * really sent by the rep, and it is neither a gesture nor an opaque delivery
 * nor backfill — the door's row has no envelope to open, because only the
 * API writes that table and only for an authenticated session's own words.
 * The first check proves the caller cited the right ROW; this proves the
 * row is what it claims to be. It is reused rather than reimplemented — the
 * ticket is explicit that a second verifier is the wrong answer — and it is
 * called for ALL FOUR tools rather than only the two Ledger ones, because
 * "the rep's own live typed message" is the same claim whichever store the
 * act lands in, and a dismissal written off a gesture or a backfilled row
 * would be exactly the demotion ADR-0003 exists to refuse.
 *
 * WHY A WRAPPER RATHER THAN FOUR CALL SITES (the ticket's own open
 * question). The two Ledger tools have to hand `RepActEvidence` onward, so
 * they need the value this returns; the two twin-side tools need only the
 * verdict. One function gives both, and — more to the point — makes "every
 * rep-act tool checks the same two things in the same order" a property a
 * reader can confirm by reading one file instead of four. It also means the
 * aperture's classifier is called with the trigger's own id rather than
 * with anything an argument carried, which is what stops the wrapper from
 * becoming a place the two ids could drift apart.
 *
 * IT NEVER THROWS. `retractDisclosedFact` throws on a class-1 input, which
 * is right for a call site that is supposed to be evidence-bound already —
 * but a tool runs inside the execution's open transaction, and an exception
 * there aborts the transaction the record and the chain entry have to
 * commit in. So this returns a refusal the tool turns into an
 * `EffectOutcome`, and the aperture's throw stays unreachable from here
 * because the classification runs first.
 */
import { classifyApertureInput, type RepActEvidence } from "@dito/aperture";
import { repTriggerOf, type ThreadDeps } from "./deps.js";

/**
 * What a refused evidence check says, per surface (see `checkRepEvidence`).
 *
 * The thread's is the model's to relay and `acts.test.ts` is its oracle (#174).
 * The dashboard ACT's is unreachable through its own caller — the API mints
 * the act row one statement before it cites it — and it is written anyway,
 * because a gate whose refusal path says nothing is a gate nobody can debug.
 *
 * THE DOOR'S IS THE THREAD'S, WORD FOR WORD (ticket #261), and that is a
 * decision rather than a copy that drifted: 6b did put a model on the
 * dashboard, and what it reads there is the rep's own message exactly as in
 * the thread — same gate, same evidence, same sentence to relay. A door
 * sentence that named the door would teach the model that the two surfaces are
 * two kinds of act, which is precisely what «one twin, two doors» is not.
 */
const REFUSED_EVIDENCE = {
  twin_thread:
    "refused: this act needs the id of the rep's own message from this turn as evidence, and that is not it. Only the message you were shown as theirs this turn can authorize an act on their behalf.",
  dashboard:
    "refused: this act needs the id of the dashboard act this run was created for, and that is not it. Only the button the rep just pressed can authorize an act on their behalf.",
  dashboard_message:
    "refused: this act needs the id of the rep's own message from this turn as evidence, and that is not it. Only the message you were shown as theirs this turn can authorize an act on their behalf.",
} as const;

/**
 * The one id a record keeps as the rep's act behind it — their message in the
 * thread, their message at the door, or the button's act row — off the
 * evidence `checkEvidence` verified, never off anything the call carried.
 */
export function evidenceRefOf(evidence: RepActEvidence): string {
  return evidence.surface === "twin_thread"
    ? evidence.sourceEventId
    : evidence.surface === "dashboard_message"
      ? evidence.dashboardMessageId
      : evidence.dashboardActId;
}

/** Whether the tool may act, and the evidence to hand onward when it may. */
export type EvidenceCheck =
  | { readonly ok: true; readonly evidence: RepActEvidence }
  | { readonly ok: false; readonly told: string };

/**
 * The evidence parameter every rep-act tool declares, by name.
 *
 * ONE SPELLING, SHARED, because `assertToolDeclaration` refuses a
 * `rep-evidenced` declaration whose schema does not declare the parameter
 * its `evidence` field names — so the declaration, the schema and this
 * reader are three places one word appears, and a constant is what keeps
 * them one word.
 */
export const EVIDENCE_PARAMETER = "evidence";

/** What the model is told the parameter is for. */
export const EVIDENCE_DESCRIPTION =
  "The id of the rep's own message that asked for this — the one you were shown as their message this turn. Any other id is refused.";

/**
 * The evidence parameter as a schema property, declared the one way
 * `assertToolDeclaration` accepts.
 *
 * HERE RATHER THAN BESIDE ONE TOOL (ticket #260), because four declarations
 * in two files now spread it: the three rep acts (`acts.ts`) and the notepad
 * write (`notepad.ts`). It is the third form of the one word the two
 * constants above hold, so this is where it belongs.
 */
export const EVIDENCE_PROPERTY = {
  [EVIDENCE_PARAMETER]: { type: "string", description: EVIDENCE_DESCRIPTION },
} as const;

/**
 * What an act on a turn an event woke is told (ticket #319).
 */
const REFUSED_WITHOUT_A_MESSAGE =
  "refused: this turn was woken by an event, not by a message from the rep, so there is no message of theirs that could ask for this.";

/**
 * Reads the evidence parameter out of one tool call's arguments and
 * verifies it, or says why the act cannot happen.
 *
 * THE REFUSAL IS WRITTEN FOR THE MODEL TO RELAY, not for the rep to read:
 * it says what went wrong in the language the instructions are written in,
 * and the twin says whatever it says about it in the rep's own words. A
 * receipt is code's (ADR-0037) precisely because it reports what happened;
 * a refusal here is a fact about the call, and the reply is the twin's.
 */
export async function checkEvidence(
  deps: ThreadDeps,
  input: unknown,
): Promise<EvidenceCheck> {
  // READ DEFENSIVELY, not because the boundary is untrusted twice but
  // because a reader that throws where the contract promises a refusal
  // leaves the event pending and the pass retrying it (Codex round 2). The
  // runner refuses a non-object root now; this is what keeps the promise
  // true whatever reaches it.
  const given: Record<string, unknown> =
    input !== null && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  // A TURN AN EVENT WOKE HAS NO REP MESSAGE UNDER IT (ticket #319): nobody
  // asked for anything, so there is nothing an act could rest on. Said to the
  // model as a fact about the turn, like every refusal here.
  const asked = repTriggerOf(deps);
  if (asked === undefined) {
    return { ok: false, told: REFUSED_WITHOUT_A_MESSAGE };
  }
  return await checkRepEvidence(
    deps,
    // WHICH DOOR THE REP SPOKE THROUGH DECIDES WHICH ROW IS RE-READ (ticket
    // #261), and it comes off the TRIGGER rather than from the shape of an id:
    // the trigger is what created this execution, so the gate and the record
    // cannot disagree about where the rep was.
    asked.door === "dashboard"
      ? {
          surface: "dashboard_message",
          dashboardMessageId: asked.eventId,
        }
      : {
          surface: "twin_thread",
          eventId: asked.eventId,
          // THE MESSAGE ID COMES FROM THE DEPS, NEVER FROM THE CALL, and that
          // is the same principle one field further in: the aperture matches
          // the id it is handed against the row's own decrypted envelope, so a
          // caller that could supply it would be supplying half of what is
          // being checked. The runtime read both off the event it is
          // processing.
          //
          // NO MESSAGE ID MEANS NOTHING MATCHES, said to a comparison rather
          // than to a type: `ThreadDeps.messageId` is absent only at the
          // door, so reaching here without one would be the trigger and the
          // deps disagreeing — and the aperture compares this against the
          // row's own decrypted envelope, which never carries the empty
          // string. It refuses fail-closed instead of throwing inside the
          // execution's transaction, which is this function's contract.
          messageId: deps.messageId ?? "",
        },
    // The runner has already refused a MISSING required parameter
    // (`inputViolations`) and an undeclared one, so what is left is the type
    // the schema declares and the model did not honour — which the SDK
    // validates nowhere. A non-string is the missing case by another route
    // and gets the same answer.
    given[EVIDENCE_PARAMETER],
  );
}

/**
 * THE WAKE THAT AUTHORIZES AN ACT, on any of the three surfaces (tickets #224
 * and #261; spec #214 decision 2 — "rep-evidenced evidence widens from 'a
 * thread message id' to 'a rep act on either surface'"; ADR-0013's 2026-09-20
 * amendment, which adds the third).
 *
 * `twin_thread` is the rep's own self-chat message this execution was created
 * for. `dashboard` is the `dashboard_acts` row the local API wrote for the
 * request that carried a button press — which is a rep act by exactly the
 * argument the seam row is one: nothing else can produce the row.
 * `dashboard_message` is the rep's own words typed at the door, sealed by the
 * same API under an open login session, and it is the rep's MESSAGE rather
 * than an act on a target — which is why it is the thread's twin rather than
 * the button's: the same model reads the same prose and asks for the same
 * things, on the surface that has no keyboard shortcut for a quote.
 */
export type RepEvidenceWake =
  | {
      readonly surface: "twin_thread";
      readonly eventId: string;
      readonly messageId: string;
    }
  | { readonly surface: "dashboard"; readonly dashboardActId: string }
  | {
      readonly surface: "dashboard_message";
      readonly dashboardMessageId: string;
    };

/** What the gate needs of the world — narrower than either surface's deps. */
export interface RepEvidenceDeps {
  readonly db: ThreadDeps["db"];
  readonly dek: ThreadDeps["dek"];
  readonly twinId: string;
}

/**
 * THE GATE ITSELF, and it is one function for both surfaces (ticket #224).
 *
 * `cited` IS WHAT THE CALLER CLAIMS AUTHORIZED THE ACT, and the first check is
 * that it EQUALS the wake's own id. On the thread that claim comes from a
 * model, which is the whole reason the comparison exists. On the dashboard it
 * comes from the API, which minted the row a statement earlier — so the check
 * cannot fail there today, and it is still made rather than skipped, for two
 * reasons worth stating.
 *
 * The gate is the same code, so «a dashboard act is exactly as safe as a
 * thread act» is a property a reader can confirm by reading one file rather
 * than a claim about two. And the model DID reach the dashboard: *Habla con
 * Dito* is a thread execution whose trigger is a DASHBOARD MESSAGE (ticket
 * #261), so on that surface the claim comes from a model again and the
 * comparison is what stands between it and an act it was not asked for.
 *
 * THE SECOND CHECK IS THE APERTURE'S, unchanged and unavoidable: it re-reads
 * the row the claim names — the seam event under the twin DEK, the act row
 * under this twin, or the door's message row under this twin — and refuses
 * anything that is not what it claims to be. A foreign seat's act, another
 * twin's, an id nothing wrote: all of them resolve to no row and come back
 * class 1.
 */
export async function checkRepEvidence(
  deps: RepEvidenceDeps,
  wake: RepEvidenceWake,
  cited: unknown,
): Promise<EvidenceCheck> {
  const wakeId = wakeIdOf(wake);
  if (typeof cited !== "string" || cited !== wakeId) {
    // THE SENTENCE IS THE SURFACE'S, because of who reads it. The thread's is
    // written for a MODEL to relay, and `acts.test.ts` is its oracle (#174).
    // The dashboard has no model to tell
    // anything: its caller reads a word off a closed set, so what this string
    // is for there is a runtime log nobody composes from.
    return { ok: false, told: REFUSED_EVIDENCE[wake.surface] };
  }
  const evidence = evidenceOf(wake);
  const classified = await classifyApertureInput(
    { db: deps.db, dek: deps.dek },
    { twinId: deps.twinId, evidence },
  );
  if (classified.inputClass === 1) {
    // ADR-0003 demotes an act with no verifiable evidence to class 1, and a
    // class-1 input is a candidate fact — it can never be a rep act.
    // Unreachable through any of the three callers as they stand (the thread's
    // trigger is a live, rep-authored, plane-delivered message of this twin;
    // the dashboard's act row and the door's message row were both written by
    // the API before the run began), so reaching it means the store is broken;
    // loud to the caller rather than a throw, because the transaction this runs
    // in still has to commit.
    return {
      ok: false,
      told: `refused: the rep's act could not be verified as theirs (${classified.reason}).`,
    };
  }
  return { ok: true, evidence };
}

/** Which id this wake authorizes an act with — the one the caller must cite. */
function wakeIdOf(wake: RepEvidenceWake): string {
  switch (wake.surface) {
    case "twin_thread":
      return wake.eventId;
    case "dashboard":
      return wake.dashboardActId;
    case "dashboard_message":
      return wake.dashboardMessageId;
  }
}

/** ...and the claim the aperture re-reads it as, named by its own store. */
function evidenceOf(wake: RepEvidenceWake): RepActEvidence {
  switch (wake.surface) {
    case "twin_thread":
      return {
        surface: "twin_thread",
        sourceEventId: wake.eventId,
        waMessageId: wake.messageId,
      };
    case "dashboard":
      return { surface: "dashboard", dashboardActId: wake.dashboardActId };
    case "dashboard_message":
      return {
        surface: "dashboard_message",
        dashboardMessageId: wake.dashboardMessageId,
      };
  }
}
