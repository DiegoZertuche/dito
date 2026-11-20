/**
 * THE BINDING QUESTION, HANDED TO THE REP BY A TOOL (ticket #363; tickets
 * #34, #195; ADR-0013 as amended; CONTEXT.md, *Hand-off*).
 *
 * Whether a conversation nobody has confirmed is the customer the phone named
 * it as is one of the two acts a wrong yes cannot take back, so the question
 * is an effect the twin calls for, never a sentence code reads intent from:
 * the twin's words are only words. `propose_binding` is `decline_binding`'s
 * sibling — that one settles the question «no», this one puts it in front of
 * the rep — and the ceremony registers from this call alone (`consumer.ts`
 * posts it after the turn, beside the reply or folded into it, through the
 * binding question's own rendering).
 *
 * APPROVE-BEFORE, and the approval is the rep's: nothing binds until they
 * confirm the question on the card or with a quoted «sí» in their thread.
 *
 * DUE-NESS IS CODE'S (#34; spec #171 decision 17): an unbound chat of the
 * rep's, never asked about, with a name its other side supplied. It is read
 * here so the twin is told when the question is not owed, and read again
 * under the ceremony's lock when the turn commits, which is the read that
 * decides (`answering.ts`'s `bindingQuestionAnchor`).
 */
import {
  defineTool,
  type EffectOutcome,
  type GatedEffectToolDeclaration,
} from "@dito/execution";
import { bindingQuestionAnchor, type AskedChat } from "../answering.js";
import { bindingSentenceViolation } from "../binding-sentence.js";
import { asRepReads, NAME_SLOT } from "../grammar.js";
import { foldName } from "./chats.js";
import type { ThreadDeps } from "./deps.js";
import { parseReference, REFERENCE_EXAMPLE, writeReference } from "./references.js";

/** The tool's registered name. */
export const PROPOSE_BINDING_TOOL = "propose_binding";

/** The word its effect records — the twin's own doing, never a rep's act. */
export const BINDING_PROPOSED_ACT = "binding_proposed";

/** What one turn handed the rep: the chat, and the twin's sentence with the name as a slot. */
export interface BindingProposal {
  readonly chat: AskedChat;
  readonly sentence: string;
}

/**
 * THE ONE QUESTION A TURN HANDS THE REP, held for the caller: the tool runs
 * inside the model loop and the post is written after the turn's record, so
 * the consumer reads it here. One per turn, because the rep answers the
 * question with one word.
 */
export class TurnBindingProposal {
  #proposal: BindingProposal | undefined;

  get proposal(): BindingProposal | undefined {
    return this.#proposal;
  }

  /** Holds the turn's proposal; a turn makes one. */
  propose(proposal: BindingProposal): void {
    this.#proposal = proposal;
  }
}

/** The declared half — the instructions render from it, the registry builds from it. */
export const PROPOSE_BINDING_DECLARATION: Omit<GatedEffectToolDeclaration, "run"> = {
  name: PROPOSE_BINDING_TOOL,
  gate: "approve-before",
  description: `Ask the rep whether a conversation nobody has confirmed is the customer the phone named it as. Nothing binds until the rep confirms: code puts the question in front of them with your reply, and they answer it there. Call it in the same turn as your reply, for the one such conversation the rep's message is about; it is refused when the rep has already been asked about that conversation, or when it cannot be asked.`,
  inputSchema: {
    type: "object",
    properties: {
      chat: {
        type: "string",
        description: `The conversation's reference, as a tool gave it to you: ${REFERENCE_EXAMPLE}.`,
      },
      question: {
        type: "string",
        description: `One sentence asking the rep whether this conversation is that customer, with ${NAME_SLOT} written literally where the name goes — code puts in the name the phone offered.`,
      },
    },
    required: ["chat", "question"],
    additionalProperties: false,
  },
};

/** The tool, bound to this turn's customers and this execution's connection. */
export function proposeBindingTool(deps: ThreadDeps): GatedEffectToolDeclaration {
  return defineTool({
    ...PROPOSE_BINDING_DECLARATION,
    run: async (input: unknown): Promise<EffectOutcome> => {
      const given = input as { chat?: unknown; question?: unknown };
      if (deps.binding.proposal !== undefined) {
        return refuse("you have already handed the rep this turn's question; one turn asks one");
      }
      const reference = parseReference(given.chat);
      if (reference === undefined) {
        return refuse(`\`chat\` is the conversation's reference, written like ${REFERENCE_EXAMPLE}, as a tool gave it to you`);
      }
      const customer = deps.served.customers(reference);
      const first = customer?.chats[0];
      if (customer === undefined || first === undefined) {
        return refuse(`${writeReference(reference)} names no conversation`);
      }
      if (customer.entityId !== undefined) {
        return refuse(`${writeReference(reference)} is a customer the rep has already confirmed; there is nothing to ask`);
      }
      const chat: AskedChat = { chatJid: first.chatJid, pushName: customer.name, anchors: customer.anchors };
      // A NAME THAT RENDERS THE SAME AS ANOTHER IS NOT A QUESTION (ADR-0039;
      // Codex r3): two conversations the phone offers one name for render one
      // sentence, and the rep's «sí» would confirm whichever the twin picked.
      const sameName = [...deps.served.state().unconfirmed.values()].some(
        (other) =>
          other.reference !== reference && foldName(asRepReads(other.pushName)) === foldName(asRepReads(chat.pushName)),
      );
      if (sameName) {
        return refuse(
          `another conversation you were shown goes by the same name as ${writeReference(reference)}, so the rep could not tell which one the question is about. Say what you found and ask nothing`,
        );
      }
      if (typeof given.question !== "string") {
        return refuse(`\`question\` is one sentence, with ${NAME_SLOT} where the name goes`);
      }
      const violation = bindingSentenceViolation(given.question, chat.pushName);
      if (violation !== undefined) return refuse(violation);
      const anchor = await bindingQuestionAnchor(
        { db: deps.db, bundle: deps.bundle, dek: deps.dek, twinId: deps.twinId, selfChatJid: deps.selfChatJid },
        chat,
      );
      if (anchor === undefined) {
        return refuse(
          `no question is owed about ${writeReference(reference)}: the rep has already been asked about it, or it cannot be asked. Say what you found in your reply`,
        );
      }
      deps.binding.propose({ chat, sentence: given.question });
      return {
        performed: true,
        act: BINDING_PROPOSED_ACT,
        told: "the question goes to the rep with your reply; nothing binds until they confirm it",
      };
    },
  });
}

function refuse(reason: string): EffectOutcome {
  return { performed: false, told: `refused: ${reason}` };
}
