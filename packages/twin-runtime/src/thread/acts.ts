/**
 * THE FOUR REP-ACT TOOLS (ticket #174; spec #171 decisions 19, 20 and 22;
 * ADR-0003 as amended, ADR-0013 as amended, ADR-0037 as amended).
 *
 * The rep says «así no», «el 3 está mal», «no, ese no es Torres», «ya no» —
 * and these are what happens next. Each one was a KEYWORD until this
 * ticket: a phrase the rep had to learn, matched before any execution
 * existed, because there was no other way for a sentence to become an act.
 * ADR-0037's ruling is that the axis is the direction of the error — a
 * keyword survives only where a misread cannot be taken back — and none of
 * these four is that. So the rep speaks and the twin reads, and what makes
 * the act safe is not the phrase but the four properties below.
 *
 * ONE: EVIDENCE. Every tool takes the id of the rep's own message and
 * refuses any other, checked by code against this execution's trigger and
 * then against the seam row behind it (`evidence.ts`). That is ADR-0003's
 * class-2 rule for the two Ledger acts, unchanged, and ADR-0013's third
 * gate shape for the two twin-side ones.
 *
 * TWO: THE TARGET IS WHAT THE REP QUOTED, NEVER WHAT THE MODEL NAMED. No
 * tool here takes a draft id or a disclosure line id. The
 * trigger carries `quotedPostId` — the rep-side identity of the post the
 * REP replied to — and code walks from it to the row. A model that decided
 * the rep meant a different draft has no parameter to say so with.
 *
 * The one exception is the line INDEX, and it is not an exception to the
 * rule: `retract_disclosure_line` takes the number the rep named, because a
 * disclosure post carries many lines and the words that pick one out are
 * the rep's («el 3 está mal»). The number is read against the numbering
 * recorded when that post was rendered — the same walk the «N no» verb
 * made — so a number the post never showed resolves to nothing, and the
 * model cannot invent a target it can only mis-select one the rep can see.
 *
 * THREE: ONE ACT PER MESSAGE (`ActSlot`), claimed on the call rather than
 * on the performance, so «así no y también el 3 está mal» acts once and the
 * twin says which.
 *
 * FOUR: THE RECEIPT IS RENDERED FROM THE OUTCOME. A tool returns what it
 * DID, with the line the rep will read attached (`grammar.ts`'s `RECEIPTS`)
 * — so the acknowledgement cannot describe an effect that did not happen,
 * and a turn whose prose claims one with no call behind it renders
 * nothing at all.
 *
 * WHY THESE THREE RUN ON THE EXECUTION'S OWN CONNECTION, unlike the search
 * beside them (`registries.ts`). The search reads the bundle — a separate
 * SQLCipher file — so a failure leaves the execution's transaction clean.
 * These WRITE, on the connection the record, the chain entry, the receipt
 * post and the processing marker commit on, which is the point: the act and
 * its account of itself are one commit or neither. Which is also why none
 * of them throws: an exception aborts that transaction, so every failure
 * here is a refused `EffectOutcome` the model can relay.
 */
import type { RepActEvidence } from "@dito/aperture";
import { appendAuditEntry } from "@dito/audit";
import {
  defineTool,
  type EffectOutcome,
  type GatedEffectToolDeclaration,
  type RepEvidencedToolDeclaration,
} from "@dito/execution";
import { resolveDisclosureLineOfPost } from "../disclosure.js";
import { RECEIPTS } from "../grammar.js";
import {
  aboutEventOfQuestion,
  declineBinding,
  dismissDraft,
  retractLine,
} from "../rep-acts.js";
import type { TwinPostKind } from "../twin-posts.js";
import { repTriggerOf, type ThreadDeps } from "./deps.js";
import {
  checkEvidence,
  EVIDENCE_PARAMETER,
  EVIDENCE_PROPERTY,
} from "./evidence.js";

/**
 * THE THREE REGISTERED NAMES, in one place, so the instructions, the
 * registry, the automation's tool list and the definition's digest cannot
 * describe different tools (the search's own note, and the owner side's
 * before it).
 *
 * THEY ARE ALSO THE CALLER IDENTITIES THE CHAIN NAMES (ADR-0020: "caller
 * identity + action type + opaque refs + outcome"). A refused retraction
 * used to chain as `correction_matcher` and an answered question as
 * `question_matcher`; both matchers are deleted, and the identity a reader
 * wants is the component that performed or refused the act — which is the
 * tool, by name, so an entry says which tool of which execution acted and a
 * reader can find it. The classes in `audit-coverage.ts` list the OLD words
 * beside the new ones, because the chain is append-only and entries written
 * before this build carry them.
 */
export const DISMISS_DRAFT_TOOL = "dismiss_draft";
export const DECLINE_BINDING_TOOL = "decline_binding";
export const RETRACT_DISCLOSURE_LINE_TOOL = "retract_disclosure_line";

/**
 * WHAT EACH ACT DID, NAMED — the three tools' outcomes (ticket #174; spec
 * #171 decision 22; narrowed at #218).
 *
 * THESE ARE THE TOOLS' WORDS AND NOT THE SEAM's, and the two are kept apart
 * deliberately (Codex round 1). The seam's `declined` is named for the
 * grammar class rather than the post kind, which is exactly right for a
 * marker; the tool says what it DID, `consumer.ts`'s map says what the seam
 * records and which notice carries it, and the two may differ. The binding is
 * the only act that produces `declined`: the aperture question was the other,
 * and its route is retired (ticket #218).
 *
 * EVERY MARKER THEY MAP TO IS ALREADY IN `wa_event_processing`'s eighteen,
 * which is why this ticket owes no migration: they are the words the deleted
 * matchers wrote, doing the same job for the same acts. What changed is who
 * writes them.
 *
 * THEY LEAVE THIS PACKAGE AS AN OPAQUE STRING and come back checked, and
 * that is the dependency wall rather than sloppiness: `EffectOutcome.act` is
 * a `string` to `@dito/execution`, which holds no seam and must not learn
 * one. So the words are declared HERE, where the tools that produce them
 * are, and the consumer's map is total over this union — so a word added
 * here without a marker and a notice kind fails the typecheck rather than
 * reaching `markProcessed` as a string the CHECK constraint would reject at
 * run time.
 *
 * ONE OF THE FOUR IS A REFUSAL, and it is here for a reason worth stating:
 * audit coverage joins `fact_retraction_refused` on exactly this marker,
 * because "a refusal writes no row anywhere else to join against". A refused
 * Ledger act that marked `answered` would leave that class vacuous — 0 acts,
 * 0 violations — which is the silent green it exists to prevent.
 */
export const THREAD_ACT_WORDS = [
  "dismissed",
  "binding_declined",
  "retracted",
  "correction_refused",
  // THE FIFTH, AND THE ONLY ONE THAT IS NOT A REP-ACT TOOL's (ticket
  // #175): `create_draft` performed. It is here because this is where the
  // words a thread tool may record are declared, and the consumer's map is
  // total over them — the word travels out through `EffectOutcome.act` the
  // same way, and the seam already has it (`drafted`, the marker a drafted
  // turn's anchor takes), so this ticket owes no migration either.
  "drafted",
  // THE SIXTH: the rep taught the twin something (ticket #260). It takes the
  // seam's `answered` marker rather than a word of its own, and that is the
  // honest reading rather than a way round a migration: what happened to the
  // rep's message is that the twin READ it and replied, and the notebook is
  // twin-side memory the seam has no vocabulary for. The write's own record
  // is the execution — this tool by name, with its arguments — and the
  // execution chain entry beside it (ADR-0020).
  "notepad_written",
  // THE SEVENTH: the rep answered a run's question card in their own words
  // and the thread gave the card that answer (`answer_ask`, ticket #324). The
  // marker is `answered`, for the notebook's reason: what happened to the
  // rep's message is that the twin read it and replied; the answer itself is
  // the run's sealed content, and the act's record is the execution.
  "ask_answered",
  // THE EIGHTH: the rep answered a rutina's proposal card in their own words
  // and the thread performed the card's own act (`answer_proposal`, ticket
  // #386). Marked `answered`, for `ask_answered`'s reason.
  "proposal_answered",
] as const;

/**
 * One of the eight.
 *
 * SIX AND NOT NINE (ticket #218, widened at #260): the aperture question's three —
 * `question_answered`, `question_declined` and `question_answer_refused` —
 * are not here, because no tool can write one. The SEAM keeps all three (its
 * vocabulary never narrows, …100022's rule), because a rig corpus holds acts
 * under them and audit coverage still watches the refusal.
 */
export type ThreadAct = (typeof THREAD_ACT_WORDS)[number];

/**
 * THE ONE ACT ONE THREAD MESSAGE GETS (spec #171 decision 19).
 *
 * CLAIMED ON THE CALL, NOT ON THE PERFORMANCE, and the difference matters:
 * a rep who asks for two things gets one act and a sentence about the
 * other, whether or not the first one succeeded. Claiming on success would
 * let a refused first call open the door for a second, which turns "one act
 * per message" into "one SUCCESSFUL act per message" — a rule about
 * outcomes rather than about what the rep asked for, and one that lets a
 * model retry an act the rep never mentioned twice.
 *
 * RUN-SCOPED, NEVER SHARED. It is minted per execution and handed through
 * `ThreadDeps` like the served map, so two executions running at once in
 * the realtime lane cannot spend each other's slot (`lanes.ts`).
 */
export class ActSlot {
  #heldBy: string | undefined;

  /** Claims the slot for one tool, or names the tool already holding it. */
  claim(tool: string): { readonly ok: true } | { readonly ok: false; readonly held: string } {
    if (this.#heldBy !== undefined) return { ok: false, held: this.#heldBy };
    this.#heldBy = tool;
    return { ok: true };
  }
}

/**
 * A tool's DECLARED HALF — everything but its handler (the search's own
 * note: two things read it, the instructions and the factory, so one source
 * means the digest that stamps what the model was TOLD and the declaration
 * it was HANDED cannot describe different tools).
 *
 * TWO ARMS BECAUSE TWO GATES, and each constant below is typed as its own
 * arm rather than as this union: a factory spreading a union-typed constant
 * would need a cast to say which gate it is, and a cast is exactly the
 * thing `defineTool` exists to make unnecessary.
 */
export type RepActDeclaration =
  | Omit<RepEvidencedToolDeclaration, "run">
  | Omit<GatedEffectToolDeclaration, "run">;

/** The declared half of a tool gated by the rep's own message. */
export type RepEvidencedDeclaration = Omit<RepEvidencedToolDeclaration, "run">;
/** ...and of one gated by the correction window. */
type UndoableDeclaration = Omit<GatedEffectToolDeclaration, "run">;

const DISMISS_DRAFT_DECLARATION: RepEvidencedDeclaration = {
  name: DISMISS_DRAFT_TOOL,
  // REP-EVIDENCED, not approve-before and not disclosed-and-undoable-after
  // (ADR-0013's 2026-09-04 amendment argues both). A dismissal is not
  // external and has no correction window to be its gate; what makes it
  // safe is that only the rep can ask for one, and the evidence is how that
  // is checked rather than assumed.
  gate: "rep-evidenced",
  evidence: EVIDENCE_PARAMETER,
  description:
    "Discard the draft the rep is pointing at, when they have told you they do not want it sent. This is final: the draft can never be sent afterwards, and the only way back is writing another one. It acts on the draft they pointed at and takes no other target.",
  inputSchema: {
    type: "object",
    properties: EVIDENCE_PROPERTY,
    required: [EVIDENCE_PARAMETER],
    additionalProperties: false,
  },
};

const DECLINE_BINDING_DECLARATION: RepEvidencedDeclaration = {
  name: DECLINE_BINDING_TOOL,
  gate: "rep-evidenced",
  evidence: EVIDENCE_PARAMETER,
  description:
    "Record that the rep says the chat you asked about is NOT the name you proposed. Nothing is saved: the chat stays unconfirmed, which is where it already was. It acts on the question they pointed at and takes no other target.",
  inputSchema: {
    type: "object",
    properties: EVIDENCE_PROPERTY,
    required: [EVIDENCE_PARAMETER],
    additionalProperties: false,
  },
};

/**
 * `line` IS THE NUMBER THE REP NAMED, and it is the one target parameter in
 * this file.
 *
 * A disclosure post carries many numbered lines, so quoting the post names
 * the post and not a line — which is exactly why the retired verb was
 * «N no» and not «no». The words that pick a line out are the rep's, so the
 * model reads the number out of their sentence; code resolves it against
 * the numbering that was recorded when the post was rendered, and a number
 * the post never showed refuses.
 */
const RETRACT_DISCLOSURE_LINE_DECLARATION: UndoableDeclaration = {
  name: RETRACT_DISCLOSURE_LINE_TOOL,
  // DISCLOSED-AND-UNDOABLE-AFTER, kept (ADR-0013 as amended): this is a
  // Ledger write, and the correction window is what makes it reversible.
  // The evidence rides along under ADR-0003 exactly as it always has.
  gate: "disclosed-and-undoable-after",
  description:
    "Mark one numbered line of the daily record the rep is pointing at as incorrect, when they tell you something in it is wrong. The line keeps its place in the record and is marked, never deleted. It acts on the record they pointed at; you name which line by the number they used.",
  inputSchema: {
    type: "object",
    properties: {
      ...EVIDENCE_PROPERTY,
      line: {
        type: "integer",
        description:
          "The number of the line the rep said was wrong, as it is printed in the record they pointed at.",
      },
    },
    required: [EVIDENCE_PARAMETER, "line"],
    additionalProperties: false,
  },
};

/** Every rep-act tool's declared half, in the order the prompt lists them. */
export const REP_ACT_DECLARATIONS: readonly RepActDeclaration[] = [
  DISMISS_DRAFT_DECLARATION,
  DECLINE_BINDING_DECLARATION,
  RETRACT_DISCLOSURE_LINE_DECLARATION,
];

/**
 * THE TERMINAL DISMISSAL, AS A TOOL (ticket #30's act; ADR-0037 —
 * "dismissal is terminal").
 *
 * The row is the anti-tap lock and it is what makes the act terminal: the
 * send lock refuses a later «va» with `REFUSAL_MICROCOPY.dismissed` off
 * exactly this table, so nothing about the tap path changes and nothing had
 * to be taught to know about tools. `ON CONFLICT DO NOTHING` keeps a repeat
 * idempotent, which is the behaviour the keyword had.
 *
 * `source_event_id` IS THE EVIDENCE, and it is the trigger's own event —
 * the id `checkEvidence` just verified as the rep's live typed message —
 * never anything the call carried.
 */
function dismissDraftTool(deps: ThreadDeps): RepEvidencedToolDeclaration {
  return defineTool({
    ...DISMISS_DRAFT_DECLARATION,
    run: async (input: unknown): Promise<EffectOutcome> =>
      asRepAct(deps, DISMISS_DRAFT_TOOL, input, async (repActEvidence) => {
        const draftId = quotedPostOfKind(deps, "draft");
        if (draftId === undefined) {
          return refuse(
            "refused: the rep is not pointing at a draft, so there is nothing to discard. Ask them which one they mean.",
          );
        }
        // THE ACT ITSELF IS `rep-acts.ts`', shared with the dashboard's
        // Descartar (#224) — the state is re-read there rather than
        // trusted from anywhere, which is what that module's own note argues.
        // What stays here is the two things that are the THREAD's: the target
        // came from the post the rep quoted, and the outcome becomes a receipt
        // in the twin's grammar.
        const outcome = await dismissDraft(deps, {
          draftId,
          evidence: repActEvidence,
        });
        if (outcome.outcome === "refused") {
          return refuse(
            outcome.reason === "written_again"
              ? "refused: you already wrote that draft again with a blank filled, so the newer draft is the one waiting. Ask the rep whether they want that one discarded."
              : "refused: the rep already sent that draft, so it cannot be discarded. Tell them it went out.",
          );
        }
        return performed(
          RECEIPTS.dismissed,
          "dismissed",
          outcome.outcome === "already"
            ? "the draft was already discarded, and still is"
            : "the draft is discarded and can never be sent",
        );
      }),
  });
}

/**
 * THE DECLINED BINDING (ticket #49's verb, now prose).
 *
 * IT WRITES NOTHING, AND THAT IS THE ACT rather than a gap. "An unconfirmed
 * binding is the chat staying provisional, which is what an unanswered
 * question already means" — the keyword's own note, still true — and
 * unbinding a chat the rep already confirmed is a different act with no
 * verb, which is why a decline arriving late refuses instead of undoing
 * anything.
 *
 * SO WHERE IS IT RECORDED? In the event's own processing marker
 * (`declined`) and in the receipt post beside it, which is one more than
 * the keyword left: the keyword wrote the marker and said nothing at all.
 * A ROW WAS CONSIDERED AND DECLINED. The once-ever ceremony keys on the
 * QUESTION notice being committed (`bindingQuestionAsked`), not on its
 * answer, so it already never re-asks — a `binding_declines` table would be
 * a second answer to a question the notice already answers, and its only
 * reader would be a report nothing asks for. Recorded on the ticket rather
 * than built.
 */
function declineBindingTool(deps: ThreadDeps): RepEvidencedToolDeclaration {
  return defineTool({
    ...DECLINE_BINDING_DECLARATION,
    run: async (input: unknown): Promise<EffectOutcome> =>
      asRepAct(deps, DECLINE_BINDING_TOOL, input, async () => {
        const noticeId = quotedPostOfKind(deps, "binding_question");
        if (noticeId === undefined) {
          return refuse(
            "refused: the rep is not pointing at a question of yours about who a chat belongs to, so there is nothing to decline.",
          );
        }
        // THE ACT ITSELF IS `rep-acts.ts`', shared with the dashboard's «No es
        // este cliente» (#224): the chat re-derives from the question's own
        // source event under the twin DEK, and a decline arriving after the rep
        // already confirmed leaves the binding standing (#49's rule).
        const aboutEventId = await aboutEventOfQuestion(deps, noticeId);
        if (aboutEventId === undefined) {
          return refuse(
            "refused: that question's own record could not be read, so there is nothing to decline.",
          );
        }
        const outcome = await declineBinding(deps, { aboutEventId });
        if (outcome.outcome === "refused") {
          return refuse(
            outcome.reason === "already_bound"
              ? "refused: that chat is already confirmed, and saying no now does not undo it. Tell the rep it is already saved."
              : "refused: that question's own record could not be read, so there is nothing to decline.",
          );
        }
        return performed(
          RECEIPTS.bindingDeclined,
          "binding_declined",
          "recorded: the chat stays unconfirmed and nothing was saved",
        );
      }),
  });
}

/**
 * THE RETRACTION (ticket #54's act, now prose).
 *
 * The walk is the verb's, unchanged: quoted post → the numbering recorded
 * when it was rendered → the disclosure line → the fact. Every step is a
 * stored row and the number the rep typed is the number they saw, because
 * the numbering was written at render time rather than recomputed. What
 * changed is only where the number comes from — the rep's sentence rather
 * than a fixed phrase — and the aperture re-reads its own store either way.
 *
 * A REFUSED CORRECTION IS CHAINED, and this is the one entry a tool here
 * writes itself. Diego's standing rule (quoted in `audit-coverage.ts`): a
 * definite act refused chains, a verb that never resolved does not. The rep
 * named a definite line and the twin declined, so it chains — with the
 * tool's own name as the caller, because the matcher that used to be named
 * is gone.
 */
function retractDisclosureLineTool(deps: ThreadDeps): GatedEffectToolDeclaration {
  return defineTool({
    ...RETRACT_DISCLOSURE_LINE_DECLARATION,
    run: async (input: unknown): Promise<EffectOutcome> =>
      asRepAct(deps, RETRACT_DISCLOSURE_LINE_TOOL, input, async (evidence) => {
        const noticeId = quotedPostOfKind(deps, "daily_disclosure");
        if (noticeId === undefined) {
          return refuse(
            "refused: the rep is not pointing at the daily record, so there is no line to mark. On WhatsApp they point at one by replying to that post; on their dashboard each line of the notes card carries its own button.",
          );
        }
        const given = input as { line?: unknown };
        const lineIndex = given.line;
        if (typeof lineIndex !== "number" || !Number.isInteger(lineIndex)) {
          return refuse(
            "refused: `line` is the number of the line as it is printed in the record.",
          );
        }
        // THE REP'S OWN NUMBER WINS WHERE THEY GAVE ONE (Codex round 2;
        // ADR-0003 as amended). The amendment permits a model to read
        // INTENT for an act reversible in the window, and names the target
        // — "the quoted twin post, AND THE LINE WITHIN IT, resolved by
        // deterministic join" — as the half that is never model-produced.
        // Those two sentences pull in opposite directions on a rep who
        // wrote «el 3 está mal»: the intent is theirs to read and the 3 is
        // theirs to obey.
        //
        // SO THE JOIN IS MADE WHEREVER IT CAN BE. If the rep's raw message
        // names exactly one number that this post really printed, that is
        // the line, and a tool call naming a different one is refused —
        // which closes the whole class of «the rep said 3 and the model
        // called 4», misread or injected. If it names none (spec #171's own
        // example is «no fueron 50, fueron 15») or several that the post
        // printed, there is no deterministic answer to be had and the
        // model's reading stands, held by the three things that hold it
        // anyway: it can only pick a line the rep was SHOWN, the fact is
        // annotated rather than deleted, and the receipt names the number
        // back so the rep sees which one was picked.
        const named = await lineTheRepNamed(deps, noticeId);
        if (named !== undefined && named !== lineIndex) {
          return refuse(
            `refused: the rep's message names line ${String(named)} and this call names ${String(lineIndex)}. Act on the line they named, or ask them which one they mean.`,
          );
        }
        const line = await resolveDisclosureLineOfPost(deps, {
          noticeId,
          lineIndex,
        });
        if (line === undefined) {
          // RESOLVED REP-SIDE, so the aperture never sees it — and chained
          // here for it, because a definite act was refused.
          await chainRetractionRefusal(deps, lineIndex, "unknown_line");
          return refusedAndRecorded(
            RECEIPTS.correctionRefused("unknown_line"),
            "correction_refused",
            `refused: the record the rep quoted has no line ${String(lineIndex)}. Ask them which one they mean.`,
          );
        }
        // THE ACT ITSELF IS `rep-acts.ts`', shared with the dashboard's
        // Retirar (#224). The aperture does the whole of it and chains its
        // own refusals; what stays here is the walk from the post the rep
        // quoted to the line they named, and the twin's own receipt.
        const outcome = await retractLine(deps, {
          disclosureLineId: line.disclosureLineId,
          evidence,
        });
        if (outcome.outcome === "refused") {
          return refusedAndRecorded(
            // The aperture's own word, crossing unchanged so both surfaces
            // name the same reason — and typed as its own set, so no cast
            // stands between the act and the microcopy.
            RECEIPTS.correctionRefused(outcome.reason),
            "correction_refused",
            `refused: that line could not be marked (${outcome.reason}).`,
          );
        }
        return performed(
          RECEIPTS.retracted(lineIndex),
          "retracted",
          outcome.outcome === "already"
            ? "the line was already marked incorrect, and still is"
            : deps.quotedPost?.editedLine === undefined
              ? "the line is marked incorrect in the record"
              : // WHAT HAPPENED TO THE REP'S WORDS, said as the fact it is
                // (ticket #344): the aperture kept their message beside the
                // annotation, so the correction is complete as it stands.
                "the line is marked incorrect in the record, and the rep's message is kept beside it as what the line should read — the correction is complete",
        );
      }),
  });
}

export { dismissDraftTool, declineBindingTool, retractDisclosureLineTool };

/**
 * THE SHAPE EVERY REP-ACT TOOL'S HANDLER HAS, once (ticket #174).
 *
 * Three things happen before any of the four does its own work, in this
 * order, and none of them is a judgement: the act slot is claimed, the
 * evidence is verified, and only then is the target resolved. The order is
 * the point — a second call is refused before it can read a row, and an act
 * with the wrong evidence never touches a store — and having it in one
 * function is what makes "every rep-act tool does this" a property a reader
 * can confirm rather than four things to compare.
 */
async function asRepAct(
  deps: ThreadDeps,
  tool: string,
  input: unknown,
  perform: (evidence: RepActEvidence) => Promise<EffectOutcome>,
): Promise<EffectOutcome> {
  return await asOneAct(deps, tool, async () => {
    const checked = await checkEvidence(deps, input);
    if (!checked.ok) return refuse(checked.told);
    return await perform(checked.evidence);
  });
}

/**
 * THE ONE-ACT RULE, FOR EVERY EFFECT TOOL THE THREAD HAS (ticket #175).
 *
 * SPLIT OUT OF `asRepAct` BECAUSE A FIFTH TOOL APPEARED THAT IS NOT A REP
 * ACT. `create_draft` is gated by the tap rather than by the rep's message
 * (ADR-0013's first shape, not its third), so it owes no evidence check —
 * and it owes the one-act rule exactly as much as the four do, because that
 * rule is about what the REP ASKED FOR: a message asking for two things
 * gets one and a sentence, whichever two things they are. One function, so
 * "one message, one act" is a property a reader can confirm rather than
 * five things to compare.
 */
export async function asOneAct(
  deps: ThreadDeps,
  tool: string,
  perform: () => Promise<EffectOutcome>,
): Promise<EffectOutcome> {
  const slot = deps.acts.claim(tool);
  if (!slot.ok) {
    return refuse(
      `refused: you have already acted this turn (${slot.held}), and one message gets one act. Tell the rep what you did and ask them to send the rest separately.`,
    );
  }
  return await perform();
}

/**
 * WHAT THE REP QUOTED, when it is a post of the kind this tool acts on.
 *
 * TWO THINGS, CHECKED TOGETHER, because they are two readings of one fact.
 * `trigger.quotedPostId` is the rep-side identity of the post — the notice's
 * id, or the draft's — and `quotedPost.kind` is what that post IS; the
 * consumer reads both out of one row (`readQuotedPost`), so a turn either
 * has both or has neither, and a tool asking for one without the other
 * would be asking half a question.
 *
 * IT IS THE OTHER STRUCTURAL HALF OF THE GATE. The evidence check says the
 * rep asked for this; this says WHAT they asked about, and the answer comes
 * from what they replied to rather than from anything the model sent. A
 * model that decided the rep meant a different draft has no parameter to
 * say so with and no path through here.
 */
export function quotedPostOfKind(
  deps: ThreadDeps,
  kind: TwinPostKind,
): string | undefined {
  return deps.quotedPost?.kind === kind ? repTriggerOf(deps)?.quotedPostId : undefined;
}

/**
 * An act that happened, with the seam's word for it and the line the rep
 * reads — where code owns one.
 *
 * `receipt` IS `undefined` FOR EXACTLY ONE ACT (ticket #175): the draft
 * `create_draft` writes is its own acknowledgement, posted as the Borrador
 * the rep is about to read, so a receipt beside it would be code narrating
 * what is already in front of them. Every other act here leaves nothing
 * visible on its own and owes the rep a line.
 */
export function performed(
  receipt: string | undefined,
  act: ThreadAct,
  told: string,
): EffectOutcome {
  return receipt === undefined
    ? { performed: true, told, act }
    : { performed: true, told, act, receipt };
}

/**
 * An act that did not happen and leaves the app nothing of its own to
 * record: the model relays the reason and the reply is the whole account.
 */
export function refuse(told: string): EffectOutcome {
  return { performed: false, told };
}

/**
 * ...and one the seam HAS A WORD FOR. The one Ledger act left has a refusal
 * word in the seam's own vocabulary (`correction_refused`) and audit
 * coverage joins its class on exactly that marker — "a refusal writes no row
 * anywhere else to join against" — so a refused retraction marks the event
 * with it. `receipt` is present because code owns a rep-facing sentence for
 * this outcome: the correction's total microcopy record does.
 */
function refusedAndRecorded(
  receipt: string | undefined,
  act: ThreadAct,
  told: string,
): EffectOutcome {
  return {
    performed: false,
    told,
    act,
    ...(receipt === undefined ? {} : { receipt }),
  };
}

/**
 * THE LINE THE REP THEMSELVES NAMED, when their words name exactly one that
 * this post printed (ticket #174, Codex round 2; ADR-0003 as amended).
 *
 * DETERMINISTIC AND OVER THE RAW MESSAGE. The numbers come out of the rep's
 * own text — the same text the seam stored, never anything the model
 * produced — and each is offered to the SAME resolution the act itself uses,
 * so "a number this post printed" is decided by the numbering recorded when
 * the post was rendered rather than by a guess about how many lines a
 * disclosure has.
 *
 * EXACTLY ONE, OR NOTHING. Two numbers that both name lines is a message the
 * rep will have to say again; zero is «no fueron 50, fueron 15», where the
 * numbers are quantities and the line is a reading. Returning `undefined`
 * for both is what keeps this a REFINEMENT of the model's reading rather
 * than a replacement for it — the strictly deterministic half, applied
 * wherever it exists.
 *
 * A LINE EDITED ON THE CARD IS NAMED BY THE TAP (ticket #344). The rep's
 * message is then the line as it should read — «300 bultos para el viernes»
 * is a quantity and a day, never a line number — and the line they meant is
 * the one they opened, off their own message row. So the sentence is not read
 * for numbers at all.
 */
async function lineTheRepNamed(
  deps: ThreadDeps,
  noticeId: string,
): Promise<number | undefined> {
  const tapped = deps.quotedPost?.editedLine;
  if (tapped !== undefined) return tapped;
  const written = [...deps.message.matchAll(/\d+/gu)].map((match) =>
    Number(match[0]),
  );
  // Deduplicated, so «el 3, el 3» is one number and not an ambiguity.
  const printed: number[] = [];
  for (const index of new Set(written)) {
    if (!Number.isSafeInteger(index) || index < 1) continue;
    const line = await resolveDisclosureLineOfPost(deps, {
      noticeId,
      lineIndex: index,
    });
    if (line !== undefined) printed.push(index);
    if (printed.length > 1) return undefined;
  }
  return printed.length === 1 ? printed[0] : undefined;
}

/** The chain entry for a correction the tool refused before the aperture saw it. */
async function chainRetractionRefusal(
  deps: ThreadDeps,
  lineIndex: number,
  reason: string,
): Promise<void> {
  await appendAuditEntry(deps.db, deps.hmacKey, {
    caller: RETRACT_DISCLOSURE_LINE_TOOL,
    action: "fact_retraction",
    // Opaque ids only (ADR-0020): the post the rep quoted, the number they
    // named — which is a position, not content — and their own row, labelled
    // by the store it dereferences in (`apertureRef`'s rule): a seam event at
    // the thread's door, a door message at the dashboard's (ticket #344).
    // Never the line's text, which the twin does not read on this path.
    ref: `twin:${deps.twinId} index:${String(lineIndex)} ${repRowToken(deps)}`,
    outcome: `refused:${reason}`,
  });
}

/** The rep's own row this turn answers, as a chain token names it. */
function repRowToken(deps: ThreadDeps): string {
  const asked = repTriggerOf(deps);
  if (asked === undefined) return "event:none";
  return asked.door === "dashboard" ? `message:${asked.eventId}` : `event:${asked.eventId}`;
}
