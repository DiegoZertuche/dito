/**
 * THE DRAFT A CUSTOMER'S TURN EARNS, WRITTEN BY THE TWIN ITSELF (ticket #363;
 * the ruling of 2026-10-07 on #357: «drafting creates the draft»; ADR-0006).
 *
 * The drafting step reads the turn and, when it needs an answer, writes the
 * reply with this tool: an INERT draft and its Borrador in the rep's thread,
 * byte-identically the row the thread's own `create_draft` writes
 * (`drafts.ts`), released only by the rep's tap. A turn that writes nothing
 * judged that nothing was owed, which is the drafting turn's `no-action`.
 *
 * THE TOOL CHECKS AND HOLDS; THE CALLER WRITES (ticket #368). The card's
 * sentence — who the draft is for and why — is the words the turn ends on,
 * and the draft's row and post are immutable from birth, so the draft is held
 * in the turn's slot and written with those words once the turn has ended
 * (`drafts.ts`'s `landDraft`, `consumer.ts`).
 *
 * ONE NAME, TWO BINDINGS (`thread/write.ts` is the other). The thread's tool
 * takes a customer's reference, because the rep names whom to write to; this
 * one takes no destination at all, because the turn it answers is the chat it
 * writes into — bound here from the deps, unreachable from the input. A chat
 * nobody has confirmed is written to on this path and on no other: it is the
 * customer who wrote, and the binding question asks who they are.
 *
 * WHAT A DRAFT CARRIES, EACH A PARAMETER: the text, the blanks a draft leaves
 * for the rep (ticket #342), the delicacy and its reason (ticket #343) — and
 * the binding question's sentence, the one field the thread's tool has no
 * home for: CODE
 * decides the question is due (spec #171 decision 17) and posts it beside the
 * draft once the turn has ended (`consumer.ts`); the twin composes the
 * sentence, with `{name}` where the name goes, when it is told one is due.
 *
 * IT CARRIES NO KNOCK (ticket #320; spec #318 decision 21; design D5): the
 * card lands, the landing wakes the twin thread, and the thread's turn decides
 * whether the rep's phone hears of it.
 */
import { randomUUID } from "node:crypto";
import {
  defineTool,
  type EffectOutcome,
  type GatedEffectToolDeclaration,
} from "@dito/execution";
import { BLANKS_SCHEMA, readBlanks } from "../blanks.js";
import { DELICATE_SCHEMA, readDelicacy, REASON_SCHEMA } from "../delicacy.js";
import { bindingSentenceViolation } from "../binding-sentence.js";
import { NAME_SLOT } from "../grammar.js";
import type { DraftingDeps } from "./deps.js";

/** The tool's registered name — the thread's own, for the same act. */
export const CREATE_DRAFT_TOOL = "create_draft";

/** The declared half — the instructions render from it, the registry builds from it. */
export const CREATE_DRAFT_DECLARATION: Omit<GatedEffectToolDeclaration, "run"> = {
  name: CREATE_DRAFT_TOOL,
  // APPROVE-BEFORE, and the approval is the rep's tap (ADR-0006, ADR-0013 as
  // amended): an effect nobody can undo, gated by a human gesture BEFORE it
  // happens.
  gate: "approve-before",
  description:
    "Write the reply to this chat's turn and put it in front of the rep as a draft. Nothing is sent: the draft waits in the rep's own thread and reaches the customer only if they tap it. It goes to this chat and no other. Call it once, when the turn needs an answer; when it needs none, call nothing. What you write after it is the sentence the rep reads above the draft.",
  inputSchema: {
    type: "object",
    properties: {
      text: {
        type: "string",
        description:
          "The reply itself, in the customer's own conversation language — exactly what the rep would send. The customer reads this and nothing else of yours.",
      },
      // A FACT ONLY THE REP HAS, LEFT BLANK (ticket #342) — the thread's tool's
      // own field, so both occasions leave one the same way.
      blanks: BLANKS_SCHEMA,
      // A DRAFT THAT COMMITS THE REP, AND WHY (ticket #343).
      delicate: DELICATE_SCHEMA,
      reason: REASON_SCHEMA,
      binding_question: {
        type: ["string", "null"],
        description: `One short sentence asking the rep whether this chat belongs to the name the phone offered, with ${NAME_SLOT} written literally where the name goes. Only when the context says the question is due; null otherwise.`,
      },
    },
    required: ["text"],
    additionalProperties: false,
  },
};

/**
 * The tool, bound to this turn's chat.
 *
 * IT WRITES NOTHING ITSELF: the draft is held in the turn's slot and the
 * caller writes it after the turn's record, in the same transaction, so the
 * draft and the record of the turn that produced it are one commit and a
 * Borrador never stands in the rep's thread with no record of who wrote it.
 */
export function createDraftTool(deps: DraftingDeps): GatedEffectToolDeclaration {
  return defineTool({
    ...CREATE_DRAFT_DECLARATION,
    run: async (input: unknown): Promise<EffectOutcome> => {
      const given = input as {
        text?: unknown;
        blanks?: unknown;
        delicate?: unknown;
        reason?: unknown;
        binding_question?: unknown;
      };
      if (deps.drafted.draft !== undefined) {
        // ONE DRAFT PER TURN: the turn is one request answered once.
        return refuse("you have already written this turn's draft; one turn gets one draft");
      }
      if (typeof given.text !== "string" || given.text.trim() === "") {
        return refuse("`text` is the reply itself, in words");
      }
      // THE MARKERS AND THE BLANKS PAIR UP (ticket #342), the one structural
      // check on a draft that leaves a fact to the rep.
      const blanks = readBlanks(given.blanks, given.text);
      if (!blanks.ok) return refuse(blanks.reason);
      // THE FLAG AND THE REASON PAIR UP AND FIT THE PILL (ticket #343).
      const delicacy = readDelicacy(given.delicate, given.reason);
      if (!delicacy.ok) return refuse(delicacy.refused);
      const sentence = bindingQuestionOf(deps, given.binding_question);
      if ("refused" in sentence) return refuse(sentence.refused);
      const draftId = randomUUID();
      deps.drafted.hold({
        held: {
          id: draftId,
          // THE POST'S ID BESIDE IT, as every held draft carries (`HeldDraft`).
          postId: randomUUID(),
          inReplyToEventId: deps.anchor.eventId,
          executionId: deps.executionId,
          destination: deps.chatJid,
          // THE BODY UNDER THE KEYS CODE STORES (`BLANK_KEY_PATTERN`), never the model's.
          body: blanks.body,
          counterparty: deps.counterpartyShown,
          blanks: blanks.blanks,
          ...(delicacy.delicacy === undefined ? {} : { delicacy: delicacy.delicacy }),
        },
        ...(sentence.sentence === undefined ? {} : { bindingQuestion: sentence.sentence }),
      });
      return {
        performed: true,
        act: "drafted",
        told: `the draft is written (draft ${draftId}). It reaches the rep when you finish, with what you write now as its sentence: who it is for and why. It sends only if they tap it; you have not sent anything.`,
      };
    },
  });
}

/**
 * THE BINDING QUESTION'S SENTENCE, OR WHY NOT (tickets #34, #172; spec #171
 * decision 17). Code decides it is due; when it is not, a sentence is refused
 * rather than dropped, so the twin never believes the rep was asked. When it
 * is, the sentence is held to the one rule both binding questions share
 * (`binding-sentence.ts`). A sentence left out is not a refusal: ceremony
 * never blocks the draft, and code asks in its own words instead.
 */
function bindingQuestionOf(
  deps: DraftingDeps,
  given: unknown,
): { readonly sentence?: string } | { readonly refused: string } {
  if (given === undefined || given === null) return {};
  if (!deps.bindingQuestionDue) {
    return { refused: "no binding question is due for this chat, so binding_question is null" };
  }
  if (typeof given !== "string" || given.trim() === "") return {};
  const violation = bindingSentenceViolation(given, deps.proposedName);
  if (violation !== undefined) return { refused: `binding_question: ${violation}` };
  return { sentence: given };
}

/** A call refused, with the reason the model is handed as the tool's answer. */
function refuse(reason: string): EffectOutcome {
  return { performed: false, told: `refused: ${reason}` };
}
