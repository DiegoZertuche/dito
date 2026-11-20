/**
 * WHAT A DRAFTING EXECUTION IS SHOWN, AS RECIPES (ticket #172; spec #171
 * decision 15).
 *
 * Five parts beside the runtime's `now`, and every one of them renders from
 * `deps` rather than from a parameter — see `deps.ts` for why content cannot
 * be a parameter and must not try to be. The consumer renders no prompt
 * block any more: it reads rows and hands them over, and this file is the
 * only place a drafting turn's context is written.
 *
 * THE ORDER IS THE SPEC'S AND IT IS LOAD-BEARING (`automation.ts`). `now`
 * first, because it is framing rather than material. Then who this chat is,
 * then what the twin went and looked up, then what was just said, then the
 * thing to answer — oldest warrant to newest, so the model reads the turn
 * last and nearest its own reply. `rep_language` after all of it, because it
 * is about the ANSWER rather than about the conversation.
 *
 * EVERY PART SAYS WHEN IT HAS NOTHING, rather than vanishing. The harness
 * omitted the memory and transcript blocks when they were empty, so a model
 * shown neither could not tell "this chat has no history" from "nobody
 * looked" — the same silence-about-an-absence the owner side's truncation
 * note argues against. A first message in a new chat is the ordinary case
 * for both.
 *
 * TWO HEADINGS ARE PINNED BY EXISTING SUITES, and they are kept verbatim on
 * purpose: `batching.int.test.ts` splits the prompt at «NEW — unanswered
 * messages from the counterparty» to prove the turn appears under that
 * heading and nowhere else (#75 AC 3), and `drafting-context.int.test.ts`
 * looks for «from the rep's memory» to prove a retrieved line arrived as
 * retrieval rather than as transcript (#35). Both claims are still exactly
 * what these parts have to make true, so the words they name stay.
 */
import type { NamedPart, RecipeRegistry } from "@dito/execution";
import {
  CHAT_BINDING_RECIPE,
  RECENT_TRANSCRIPT_RECIPE,
  recentTranscriptPart,
} from "../chat-context.js";
import { NAME_SLOT } from "../grammar.js";
import { NOTEPAD_RECIPE, notepadPart } from "../rep-notepad.js";
import { WORKING_MEMORY_RECIPE, workingMemoryPart } from "../working-memory.js";
import type { DraftingDeps } from "./deps.js";
import { renderTranscriptLines, renderTurnLines } from "./lines.js";
import { writeReference } from "../thread/references.js";

// The two names extraction shares live above both automations
// (`chat-context.ts`), and are re-exported here so a reader of this file
// still sees the six recipes it names in one list.
export { CHAT_BINDING_RECIPE, RECENT_TRANSCRIPT_RECIPE };
export const RETRIEVED_MEMORIES_RECIPE = "retrieved_memories";
export const THE_TURN_RECIPE = "the_turn";

/**
 * WHO THIS CHAT IS, AND WHETHER ANYBODY HAS SAID SO (spec #171 decision 15:
 * "`chat_binding` (the counterparty's name and whether it is confirmed)";
 * decision 17 for the question's half).
 *
 * THE CONFIRMED/UNCONFIRMED DISTINCTION IS NOT DECORATION. A rep-confirmed
 * name is the rep's own word; a provisional one is whatever the rail's
 * push-name says, and the rep has never agreed to it (#34, spec #29 decision
 * 3). A draft may use a confirmed name freely and should be careful with an
 * unconfirmed one, and the model can only know which it is holding if the
 * part says so.
 *
 * AND WHETHER THE QUESTION IS DUE, which is CODE's decision (unbound chat, a
 * push-name to propose, never asked before — `consumer.ts`). The execution
 * is told, and composes the sentence; it never decides that a chat should be
 * asked about. What the contract refuses is a sentence that TYPES the name
 * rather than slotting it; a turn that composes none is accepted and the
 * question posts code-composed, because ceremony never blocks the draft
 * (#34; spec #29 grilling decision 3, and the remainder recorded on #172).
 */
const chatBinding = (deps: DraftingDeps) => (): NamedPart => ({
  name: "chat binding",
  text: [
    deps.bindingConfirmed
      ? `You are drafting for the rep's conversation with ${deps.counterparty}. The rep has confirmed who this is, so the name is theirs rather than the phone's.`
      : `You are drafting for the rep's conversation with ${deps.counterparty}. Nobody has confirmed who this is: the name comes from the phone book and may be wrong, so do not put it in the draft as though it were established.`,
    // ONE REFERENCE PER CUSTOMER (ADR-0037 as amended 2026-10-02; ticket
    // #368): the sentence the rep reads above the draft names this customer,
    // and code renders the name from the reference, as the thread's do.
    `When you speak of them to the rep, write ${writeReference(deps.reference)} and code puts their name in.`,
    ...(deps.bindingQuestionDue && deps.proposedName !== undefined
      ? [
          `This chat has never been identified, and the rep will be asked about it once, alongside this draft. The phone offers the name ${deps.proposedName}. Compose that question as one short sentence with ${NAME_SLOT} where the name goes, and give it to create_draft as its binding_question. Write ${NAME_SLOT} literally: the name is filled in by code, so a sentence that types it instead is refused.`,
        ]
      : []),
  ].join("\n\n"),
});

/**
 * WHAT THE TWIN WENT AND LOOKED UP (spec #171 decision 15:
 * "`retrieved_memories` (the turn as the query, the existing limit)").
 *
 * A SEPARATE, LABELLED BLOCK rather than merged into the transcript, and the
 * reason is the warrant rather than the recency: one is what was just said,
 * the other is what the twin looked for — and a retrieved line read as the
 * latest turn is a draft answering something from June (#35's own note).
 */
const retrievedMemories = (deps: DraftingDeps) => (): NamedPart => ({
  name: "retrieved memories",
  text:
    deps.memories.length === 0
      ? "Nothing else from the rep's memory of this same chat came back as relevant to what you have to answer. You can look for yourself."
      : `Relevant earlier messages from the rep's memory of this same chat (older context, not the latest turns):\n${renderTranscriptLines(deps.memories)}`,
});

/**
 * WHAT WAS JUST SAID, AND IS ALREADY DEALT WITH (spec #171 decision 15:
 * "`recent_transcript` (the existing limit)").
 *
 * THE PART IS SHARED WITH EXTRACTION (`chat-context.ts`), whole and
 * unchanged: the sentences say what the block is and how to read it, and
 * neither says what the reader is doing with it. This binds the rows — the
 * turn's own messages already removed by the consumer, because a message
 * standing under both this heading and the turn's is exactly the conflation
 * #75's AC 3 forbids.
 */
const recentTranscript = (deps: DraftingDeps) => (): NamedPart =>
  recentTranscriptPart(deps.transcript);

/**
 * THE THING TO ANSWER (spec #171 decision 15: "`the_turn` (the new
 * unanswered messages, numbered)"; #75).
 *
 * NUMBERED, AND ONE REQUEST. A counterparty who types three short lines is
 * making one request, and the numbers are what let the model see there are
 * three of them to answer rather than one — the case #75 was cut for, and
 * the reason the instructions say a reply must address all of it.
 */
const theTurn = (deps: DraftingDeps) => (): NamedPart => ({
  name: "the turn",
  text: `NEW — unanswered messages from the counterparty, oldest first. These, and only these, are what your draft must answer:\n${renderTurnLines(deps.turn)}`,
});

/**
 * HOW THIS REP TALKS, AND WHAT THEY HAVE TAUGHT (ticket #260; spec #258 —
 * "the `notepad` context recipe renders last in the drafting and thread
 * recipe lists in the slot `rep_language` holds"; user story 17).
 *
 * THE PART AND THE RECIPE'S NAME LIVE ABOVE BOTH AUTOMATIONS
 * (`rep-notepad.ts`), and #173's two-axis review is why: the twin thread
 * renders the same part, and two copies of one sentence is the hazard
 * `@dito/execution`'s README states about `renderTurnInstant`. The rep is one
 * person, and a twin that read their standing rules two ways would draft
 * under one and answer under the other.
 *
 * THIS IS THE SLOT THE WHOLE FEATURE TURNS ON. A customer's turn is where the
 * rep's teaching has to land — «con Fuentes siempre de usted» is about a
 * DRAFT — so a drafting execution reads the notebook at render time, from the
 * bundle it already holds, and gets whatever the rep taught a minute ago in
 * their thread.
 */
const notepad = (deps: DraftingDeps) => (): NamedPart =>
  notepadPart({
    repLanguage: deps.repLanguage,
    notepad: deps.bundle.readNotepad()?.text,
    // NO VERSION HERE: a drafting turn has no tool that writes the notebook,
    // so the number a write would cite is framing about an act it cannot
    // perform (`rep-notepad.ts` argues it).
    version: undefined,
  });

/**
 * THE TWIN'S OWN NOTES, RIGHT AFTER THE NOTEPAD (ticket #322; spec #318
 * decision 2 — «rendered into every rep-facing execution beside the
 * notepad»), read at render time like the notepad. Without the clause about
 * rewriting them: a drafting turn holds no tool that does.
 */
const workingMemory = (deps: DraftingDeps) => (): NamedPart =>
  workingMemoryPart({ memory: deps.bundle.readWorkingMemory(), writable: false });

/**
 * The six, as a registry fragment the drafting registries spread beside
 * `STANDARD_RECIPES`.
 *
 * A CONSTANT, NEVER A GLOBAL ANYTHING WRITES INTO — the rule `registry.ts`
 * states and `STANDARD_RECIPES` already follows. Every entry is a factory,
 * so the value holds no execution's data and two concurrent turns share
 * nothing but the code.
 */
export const DRAFTING_RECIPES: RecipeRegistry<DraftingDeps> = Object.freeze({
  [CHAT_BINDING_RECIPE]: { parameters: {}, create: chatBinding },
  [RETRIEVED_MEMORIES_RECIPE]: { parameters: {}, create: retrievedMemories },
  [RECENT_TRANSCRIPT_RECIPE]: { parameters: {}, create: recentTranscript },
  [THE_TURN_RECIPE]: { parameters: {}, create: theTurn },
  [NOTEPAD_RECIPE]: { parameters: {}, create: notepad },
  [WORKING_MEMORY_RECIPE]: { parameters: {}, create: workingMemory },
});
