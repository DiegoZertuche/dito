/**
 * THE ONE THING A THREAD EXECUTION MAY WRITE FOR A CUSTOMER TO READ (ticket
 * #175; spec #171 decisions 5 and 23; ADR-0006, ADR-0013 as amended,
 * ADR-0037 as amended).
 *
 * The rep says «escríbele a Torres que ya está la factura», and this is what
 * happens: the twin composes the message, and code records an INERT draft
 * and posts the Borrador — with the words the turn ends on as its sentence,
 * which is why the tool holds the draft and the turn's caller writes it
 * (ticket #368; `drafts.ts`'s `HeldDraft`). Nothing here sends anything. The gate is
 * `approve-before` and the approval is the tap — ADR-0006's own sentence,
 * "one aperture writer, one human gesture" — so the draft this tool writes
 * is byte-identically the row a customer-triggered draft is, walked by the
 * same send lock, released by the same quoted «va». That is why the tap path
 * needed nothing added for this ticket and why FR-70 covers a rep-initiated
 * draft without a new step: there is only one kind of draft.
 *
 * THE DESTINATION IS NEVER AN ADDRESS THE MODEL TYPED (ticket #321). `entity`
 * is a customer's stable reference — `c7` — and `chat` picks one of that
 * customer's chats by its position; code walks from the two to the chat.
 * There is no parameter that takes a chat address, an entity id or a name, so
 * a model steered by a poisoned message has nothing to put one in; the widest
 * this tool reaches is the set of chats the rep themselves confirmed.
 *
 * A CUSTOMER WITH TWO NUMBERS IS ONE REFERENCE, AND THE TWIN PICKS THE CHAT
 * (ADR-0039 as amended; D15). The pick is required only where there is a
 * choice; with one chat it is implied. Nothing checks the pick against the
 * rep's words: the card shows the number's tail, and the tap the rep makes
 * after reading it is what approves the pick (#294 — the approval keys on
 * the draft id, and the draft carries its destination).
 *
 * IT NEEDS NO EVIDENCE PARAMETER AND IS NOT WEAKER FOR IT (ADR-0013 as
 * amended). The three gate shapes answer "what makes this safe": the rep's
 * own message, for a write on twin-side state with no window; the correction
 * window, for a Ledger write; a human approval BEFORE the effect, for
 * anything external. A draft is the third, and its approval is the tap the
 * rep has to make in their own thread — which is a stronger fact than an id
 * in a tool call, because it happens after the rep has READ the words.
 *
 * ONE ACT PER MESSAGE, SHARED WITH THE FOUR (`acts.ts`'s `ActSlot`). A rep
 * who asks for two drafts in one message gets one and a sentence, for the
 * same reason «así no y también el 3 está mal» gets one act: the rule is
 * about what the rep asked for, not about what succeeded.
 */
import { randomUUID } from "node:crypto";
import {
  defineTool,
  type EffectOutcome,
  type GatedEffectToolDeclaration,
} from "@dito/execution";
import { BLANKS_SCHEMA, readBlanks, type DraftBlank } from "../blanks.js";
import { DELICATE_SCHEMA, readDelicacy, REASON_SCHEMA, type DraftDelicacy } from "../delicacy.js";
import { asOneAct, performed, refuse } from "./acts.js";
import { repTriggerOf, type ThreadDeps } from "./deps.js";
import {
  mentionsIn,
  parseReference,
  referencesIn,
  REFERENCE_EXAMPLE,
  renderNames,
  tailsOf,
  writeReference,
  type Customer,
  type CustomerChat,
} from "./references.js";

/** The tool's registered name. */
export const CREATE_DRAFT_TOOL = "create_draft";

/**
 * The declared half — everything but the handler (the search's own note:
 * the instructions render from this and the registry's factory builds from
 * it, so one source means the digest that stamps what the model was TOLD
 * and the declaration it was HANDED cannot describe different tools).
 */
export const CREATE_DRAFT_DECLARATION: Omit<GatedEffectToolDeclaration, "run"> = {
  name: CREATE_DRAFT_TOOL,
  // APPROVE-BEFORE, and the approval is the rep's tap (ADR-0006). Not
  // rep-evidenced: the rep's message is why the twin is writing, and the
  // tap is what makes it safe — an effect nobody can undo is gated by a
  // human gesture BEFORE it happens, which is the shape ADR-0013 reserves
  // for exactly this.
  gate: "approve-before",
  description:
    `Write a message for one of the rep's customers and put it in front of the rep as a draft. Nothing is sent: the draft waits in the rep's own thread and reaches the customer only if they tap it. Name the customer by their reference — ${REFERENCE_EXAMPLE} — there is no other way to say who it is for. When they have more than one chat, say which one with \`chat\`; the draft card shows the rep that number's last digits before they tap. What you finish this turn with is the sentence the rep reads above the draft.`,
  inputSchema: {
    type: "object",
    properties: {
      entity: {
        type: "string",
        description: `The customer's reference, as a tool gave it to you: ${REFERENCE_EXAMPLE}.`,
      },
      chat: {
        type: ["integer", "null"],
        description:
          "Which of the customer's chats this message goes to, by its number in resolve_chat's list — 1 for the first. Needed only when they have more than one; null otherwise.",
      },
      text: {
        type: "string",
        description:
          "The message itself, in the customer's own conversation language — exactly what the rep would send. The customer reads this and nothing else of yours.",
      },
      // A FACT ONLY THE REP HAS, LEFT BLANK (ticket #342) — the drafting
      // tool's own field, so both occasions leave one the same way.
      blanks: BLANKS_SCHEMA,
      // A DRAFT THAT COMMITS THE REP, AND WHY (ticket #343) — the drafting
      // tool's own two fields.
      delicate: DELICATE_SCHEMA,
      reason: REASON_SCHEMA,
    },
    required: ["entity", "text"],
    additionalProperties: false,
  },
};

/**
 * The tool, bound to this run's customers.
 *
 * IT HOLDS THE DRAFT AND THE TURN'S CALLER WRITES IT (ticket #368), on the
 * execution's own connection after its record: the draft row, its
 * `system_send`, its timing row, the execution record, the chain entry, the
 * reply and the event's marker all commit together or none of them do. A
 * draft committed by a run that then failed would be a Borrador in the rep's
 * thread with no record of who wrote it.
 */
export function createDraftTool(deps: ThreadDeps): GatedEffectToolDeclaration {
  return defineTool({
    ...CREATE_DRAFT_DECLARATION,
    run: async (input: unknown): Promise<EffectOutcome> => {
      // THE DESTINATION IS READ BEFORE THE ACT SLOT IS CLAIMED, so a
      // reference that names nobody or a pick that is not theirs is the twin's
      // slip to correct in the same turn, never the rep's request lost to it.
      const given = input as {
        entity?: unknown;
        chat?: unknown;
        text?: unknown;
        blanks?: unknown;
        delicate?: unknown;
        reason?: unknown;
      };
      const destination = destinationOf(deps, given.entity, given.chat);
      if ("refused" in destination) return refuse(`refused: ${destination.refused}`);
      // ...AND SO ARE THE FLAG AND THE REASON (ticket #343), paired and fit to
      // the pill: a slip there is the twin's to correct in the same turn too.
      const delicacy = delicacyGiven(deps, given.delicate, given.reason);
      if ("refused" in delicacy) return refuse(`refused: ${delicacy.refused}`);
      return asOneAct(deps, CREATE_DRAFT_TOOL, async () => {
        if (typeof given.text !== "string" || given.text.trim() === "") {
          return refuse(
            "refused: `text` is the message itself, in words. There is nothing to put in front of the rep without it.",
          );
        }
        if (referencesIn(given.text).length > 0) {
          // A REFERENCE IS FOR WHAT THE REP READS AND NEVER FOR THE DRAFT.
          // This text is what the CUSTOMER reads: nothing renders it, so a
          // reference would reach them as `[c7]`. Their own name is the twin's
          // to write out here — it is greeting them, not reporting about them.
          return refuse(
            "refused: `text` is what the customer reads, so write it out in full — references belong only in what you say back to the rep.",
          );
        }
        // THE MARKERS AND THE BLANKS PAIR UP (ticket #342), the drafting
        // contract's one structural check, refused the same way.
        const blanks = readBlanks(given.blanks, given.text);
        if (!blanks.ok) return refuse(`refused: ${blanks.reason}`);
        const { draftId, postId } = heldRepInitiatedDraft(deps, destination, {
          // THE BODY UNDER THE KEYS CODE STORES (`BLANK_KEY_PATTERN`).
          text: blanks.body,
          blanks: blanks.blanks,
          ...(delicacy.delicacy === undefined ? {} : { delicacy: delicacy.delicacy }),
        });
        return performed(
          undefined,
          "drafted",
          `the draft for ${writeReference(destination.customer.reference)} is written — post ${postId}, draft ${draftId}. It reaches the rep when you finish, with what you write now as its sentence: who it is for and why; you may knock on post ${postId} now. It sends only if they tap it; you have not sent anything.`,
        );
      });
    },
  });
}

/**
 * THE FLAG AND THE REASON, PAIRED AND BOUNDED (`readDelicacy`), THE REASON'S
 * REFERENCES RENDERED AS NAMES (ticket #343) — or why not.
 *
 * The pill draws the reason as plain words, so a customer the twin named by
 * reference — this thread's way of naming one — is written out here as a
 * knock's are (`knock`), and a reference that names nobody is the twin's slip
 * to correct.
 */
function delicacyGiven(
  deps: ThreadDeps,
  delicate: unknown,
  reason: unknown,
): { readonly delicacy?: DraftDelicacy } | { readonly refused: string } {
  const read = readDelicacy(delicate, reason);
  if (!read.ok) return { refused: read.refused };
  if (read.delicacy === undefined) return {};
  const written = read.delicacy.reason;
  const nobody = referencesIn(written).find((reference) => deps.served.customers(reference) === undefined);
  if (nobody !== undefined) {
    return {
      refused: `\`reason\` names ${writeReference(nobody)}, which names no customer: name them by a reference a tool gave you, or by their name.`,
    };
  }
  // ...AND BOUNDED AGAIN AS THE PILL WILL DRAW IT: a name is longer than
  // its reference (Codex r3).
  const rendered = readDelicacy(true, renderNames(written, mentionsIn(written, deps.served.customers)));
  if (!rendered.ok) return { refused: rendered.refused };
  return rendered.delicacy === undefined ? {} : { delicacy: rendered.delicacy };
}

/** Where a draft goes: the customer, and the one chat of theirs it is written into. */
interface Destination {
  readonly customer: Customer;
  readonly chat: CustomerChat;
}

/**
 * THE CUSTOMER AND THE CHAT A DRAFT GOES TO, or why not (ticket #321).
 *
 * THE ONE CHECK ON THE REFERENCE IS THAT IT NAMES A ROW — a customer the rep
 * confirmed, because a chat nobody confirmed can never be a destination and
 * «(sin confirmar)» can never appear in a rep-initiated Borrador's frame.
 * The pick is required only where the customer has a choice of chats, and a
 * pick outside their own chats is refused: it cannot name another customer's
 * chat, because it counts within this one's.
 */
function destinationOf(
  deps: ThreadDeps,
  entity: unknown,
  chat: unknown,
): Destination | { readonly refused: string } {
  const reference = parseReference(entity);
  if (reference === undefined) {
    return {
      refused: `\`entity\` is the customer's reference, written like ${REFERENCE_EXAMPLE}, as a tool gave it to you.`,
    };
  }
  const customer = deps.served.customers(reference);
  if (customer === undefined) {
    return {
      refused: `${writeReference(reference)} names no customer. Look the customer up by name and use the reference it gives you.`,
    };
  }
  if (customer.entityId === undefined) {
    return {
      refused: `${writeReference(reference)} is a conversation nobody has confirmed, and you can only write to customers the rep confirmed.`,
    };
  }
  const chats = customer.chats;
  if (chat === null || chat === undefined) {
    if (chats.length === 1) return { customer, chat: chats[0]! };
    return {
      refused: `${writeReference(reference)} has ${String(chats.length)} chats, so say which one this message goes to with \`chat\` — its number in resolve_chat's list.`,
    };
  }
  const picked =
    typeof chat === "number" && Number.isInteger(chat) ? chats[chat - 1] : undefined;
  if (picked === undefined) {
    return {
      refused: `\`chat\` ${JSON.stringify(chat)} is not one of ${writeReference(reference)}'s chats: they have ${String(chats.length)}, numbered from 1 in resolve_chat's list.`,
    };
  }
  return { customer, chat: picked };
}

/**
 * The draft, held in the turn's slot for its caller to write with the turn's
 * words (ticket #368; `drafts.ts`'s `landDraft`).
 *
 * `in_reply_to_event_id` IS THE REP'S OWN MESSAGE, which is the honest
 * answer to "what is this draft a reply to". A customer-triggered draft
 * names the message that closed the turn; this one names the message that
 * asked for it, and both are `wa_events` rows of this twin's. That is also
 * what makes the timing row measurable the same way: `event_received_at` is
 * when the seam took the rep's message in, so NFR-2's budget covers a
 * rep-initiated draft with no second measurement to invent.
 *
 * NO BINDING QUESTION EVER RIDES ONE. The ceremony asks who an UNBOUND chat
 * belongs to, and this tool writes only to a customer the rep confirmed —
 * which is also why the frame can never carry «(sin confirmar)» here.
 */
function heldRepInitiatedDraft(
  deps: ThreadDeps,
  destination: Destination,
  composed: {
    readonly text: string;
    readonly blanks: readonly DraftBlank[];
    readonly delicacy?: DraftDelicacy;
  },
): { readonly draftId: string; readonly postId: string } {
  const { customer, chat } = destination;
  // THE IDS BEFORE THE ROWS (tickets #220, #358): the post's `draft` part
  // names the draft, and the twin knocks on the post before it lands.
  const draftId = randomUUID();
  const postId = randomUUID();
  deps.draft.hold({
    id: draftId,
    postId,
    // THE REP'S OWN EVENT, WHEN THERE IS ONE (ticket #261). The column
    // references `wa_events`, so a draft the dashboard's door asked for
    // names none and its provenance is the execution — whose trigger names
    // the door and the message (`DraftEmission` argues the absence); so does
    // one a turn an event woke wrote (ticket #319).
    ...(repTriggerOf(deps)?.door === "twin_thread"
      ? { inReplyToEventId: repTriggerOf(deps)!.eventId }
      : {}),
    executionId: deps.executionId,
    destination: chat.chatJid,
    body: composed.text,
    // BOUND, SO THE NAME IS THE REP'S OWN WORD, unmarked. The provisional
    // mark exists for a chat nobody has confirmed, and this tool cannot
    // reach one.
    counterparty: customer.name,
    // THE TAIL OF THE CHAT THE TWIN PICKED, where there was a pick to make:
    // the card is where the rep sees which number before the tap.
    ...(tailsOf(customer).length > 0 && chat.tail !== undefined ? { tail: chat.tail } : {}),
    blanks: composed.blanks,
    ...(composed.delicacy === undefined ? {} : { delicacy: composed.delicacy }),
  });
  return { draftId, postId };
}
