/**
 * WHAT THE THREAD'S TOOL NAMES MEAN (tickets #173, #363; spec #171 decisions
 * 9, 30 and 31).
 *
 * A step on the thread's conversation names its tools — the thread's own
 * turn holds every one of them (`daySessionShape`) — and this is where those
 * names become code (`runs/conversation.ts`). It is a plain value built by a
 * function call — never a module-level registry anything writes into — which
 * is the rule spec #171 decision 9 states and the reason it exists: this one
 * holds a search over the twin's whole bundle, the drafting one holds a
 * search over ONE chat, and a shared mutable registry would put either within
 * reach of the other with nothing in the way but which name a spec happened
 * to use.
 *
 * WHICH IS ALSO WHY `search_memory` IS ONE NAME AND TWO BINDINGS
 * (`tools.ts`): the scope is a property of the registry a spec was resolved
 * against, so a drafting turn cannot reach another customer's chat and a
 * thread turn can reach every one of the rep's — and nothing in either spec
 * says which, because a spec names parts and never contains them.
 *
 * A FUNCTION, SO NO TWO EXECUTIONS SHARE ONE, and from this ticket that is
 * load-bearing rather than tidy: two executions really do run at once
 * (`lanes.ts`), so a registry one could reach and mutate while another read
 * it would be a hazard nobody would find. A function costs one call.
 *
 * WHICH OF THESE TOUCH POSTGRES (tickets #174, #195, #260 and #320). The
 * savepoint rule and its whole argument live in `tool-savepoints.ts`, which
 * extraction's own registry reads too (#196); what belongs here is which
 * tool is on which side of it. The rep-act tools and `create_draft` WRITE on
 * this execution's connection; the search READS on it, asking the ceremony
 * whether a conversation has already been asked about; and `write_notepad`
 * writes the BUNDLE but reads Postgres to verify its evidence first — so every
 * tool that reaches this execution's connection carries a savepoint and
 * shares its one queue. `resolve_chat`, `search_messages` and `read_message`
 * read the bundle and nothing else, so they carry neither.
 *
 * SO THE SAVEPOINT IS THE OWNER SIDE'S, VERBATIM IN SHAPE, over the same
 * queue (`@dito/execution`'s `tool-queue.ts`). Every rep-act tool's own
 * failures are already VALUES rather than throws (`acts.ts`), so what this
 * catches is the unexpected one — a constraint nobody predicted, a
 * connection dropped mid-statement — and it catches it in the one place the
 * tools cannot each forget.
 */
import { oneAtATime, type InTurn, type ToolRegistry } from "@dito/execution";
import { savepointed } from "../tool-savepoints.js";
import {
  declineBindingTool,
  dismissDraftTool,
  retractDisclosureLineTool,
  DECLINE_BINDING_TOOL,
  DISMISS_DRAFT_TOOL,
  RETRACT_DISCLOSURE_LINE_TOOL,
} from "./acts.js";
import { listChatsTool, readFiledFactsTool, searchChatHistoryTool } from "./chat-reads.js";
import type { ThreadDeps } from "./deps.js";
import { LIST_CHATS_TOOL, READ_FILED_FACTS_TOOL, SEARCH_CHAT_HISTORY_TOOL } from "../extraction/tools.js";
import { WRITE_NOTEPAD_TOOL, writeNotepadTool } from "./notepad.js";
import { WRITE_WORKING_MEMORY_TOOL, writeWorkingMemoryTool } from "./working-memory.js";
import {
  RESOLVE_CHAT_TOOL,
  resolveChatTool,
  SEARCH_MEMORY_TOOL,
  searchMemoryTool,
} from "./tools.js";
import { CREATE_DRAFT_TOOL, createDraftTool } from "./write.js";
import { FILL_BLANK_TOOL, fillBlankTool } from "./fill.js";
import { PROPOSE_BINDING_TOOL, proposeBindingTool } from "./propose-binding.js";
import { NOTHING_TO_SAY_TOOL, nothingToSayTool } from "./nothing-to-say.js";
import {
  KNOCK_TOOL,
  knockTool,
  MOVE_CARDS_TOOL,
  moveCardsTool,
  READ_CANVAS_TOOL,
  READ_POST_TOOL,
  readCanvasTool,
  readPostTool,
  SAY_ON_CARD_TOOL,
  sayOnCardTool,
  SPOTLIGHT_TOOL,
  spotlightTool,
} from "./canvas-tools.js";
import {
  CANCEL_RUN_TOOL,
  PAUSE_RUN_TOOL,
  READ_RUNS_TOOL,
  START_WORKFLOW_TOOL,
  STEER_RUN_TOOL,
} from "../runs/declarations.js";
import { ANSWER_ASK_TOOL, answerAskTool, ASK_TOOL, askTool } from "../runs/ask.js";
import {
  cancelRunTool,
  pauseRunTool,
  readRunsTool,
  startWorkflowTool,
  steerRunTool,
} from "../runs/tools.js";
import { CREATE_AUTOMATION_TOOL, createAutomationTool } from "../runs/create-automation.js";
import { ANSWER_PROPOSAL_TOOL, answerProposalTool } from "../runs/proposals.js";
import {
  READ_ENTITY_TOOL,
  READ_MESSAGE_TOOL,
  readEntityTool,
  readMessageTool,
  SEARCH_MESSAGES_TOOL,
  searchMessagesTool,
} from "./memory-tools.js";

/**
 * The thread's tools, as one value — over the turn's one queue, which a run's
 * step shares with the tools its run hands it (`runs/run-tools.ts`), since
 * they all reach one connection.
 */
export function threadRegistries(
  // One per registry, which is one per execution — `@dito/execution`'s
  // `tool-queue.ts` argues why that is the only bound that works.
  inTurn: InTurn = oneAtATime(),
): { readonly tools: ToolRegistry<ThreadDeps> } {
  return {
    tools: {
      // SAVEPOINTED, BECAUSE IT REACHES POSTGRES (ticket #195). The search
      // reads the BUNDLE for its hits and then asks the ceremony whether
      // each unconfirmed conversation has already been asked about — a
      // query on THIS execution's own connection — and a statement that
      // raises inside a transaction aborts the whole transaction. Without
      // the savepoint an unexpected failure there would poison the record
      // insert, the chain append and the marker that come after it, and the
      // one thing the trace most needs to hold would be the one thing it
      // could never record.
      [SEARCH_MEMORY_TOOL]: {
        gate: "projection",
        create: (deps) => savepointed(searchMemoryTool(deps), deps.db, inTurn),
      },
      // THE SECOND READ (ticket #175), and the only tool here with no
      // savepoint: it reads the BUNDLE — a separate SQLCipher file — and
      // touches this execution's connection nowhere, so a failure leaves the
      // transaction clean.
      [RESOLVE_CHAT_TOOL]: {
        gate: "projection",
        create: resolveChatTool,
      },
      // THE REP'S CUSTOMERS AND THEIR CONVERSATIONS (ticket #396): the index,
      // the search and the record over the twin's whole history. The search
      // and the index read the BUNDLE alone, as `resolve_chat` does; the
      // record reads this execution's connection, so it is savepointed.
      [SEARCH_CHAT_HISTORY_TOOL]: {
        gate: "projection",
        create: searchChatHistoryTool,
      },
      [LIST_CHATS_TOOL]: {
        gate: "projection",
        create: listChatsTool,
      },
      [READ_FILED_FACTS_TOOL]: {
        gate: "projection",
        create: (deps) => savepointed(readFiledFactsTool(deps), deps.db, inTurn),
      },
      // THE FOUR REP-ACT TOOLS (ticket #174). Each registration declares
      // the gate its factory builds, and `resolveTool` checks the pair —
      // "the registry a reviewer reads is the gate the model is handed", so
      // this table is the auditable list of what a thread execution may do
      // and under which rule.
      [DISMISS_DRAFT_TOOL]: {
        gate: "rep-evidenced",
        create: (deps) => savepointed(dismissDraftTool(deps), deps.db, inTurn),
      },
      [DECLINE_BINDING_TOOL]: {
        gate: "rep-evidenced",
        create: (deps) => savepointed(declineBindingTool(deps), deps.db, inTurn),
      },
      [RETRACT_DISCLOSURE_LINE_TOOL]: {
        gate: "disclosed-and-undoable-after",
        create: (deps) => savepointed(retractDisclosureLineTool(deps), deps.db, inTurn),
      },
      // THE REP'S OWN NOTEBOOK (ticket #260; Codex round 2). SAVEPOINTED,
      // though what it WRITES is the bundle: the evidence check it makes
      // first re-reads the seam row on THIS execution's connection
      // (`evidence.ts`), exactly as the three rep-act tools above do — so a
      // cancelled or timed-out SELECT there would otherwise poison the
      // record, the chain entry and the marker that come after it.
      [WRITE_NOTEPAD_TOOL]: {
        gate: "rep-evidenced",
        create: (deps) => savepointed(writeNotepadTool(deps), deps.db, inTurn),
      },
      // THE TWIN'S OWN NOTES (ticket #322; spec #318 decision 20). It writes
      // the BUNDLE and needs no evidence, so a turn an event woke may write
      // it; SAVEPOINTED because a matter about a post id is checked against
      // `posts` on this execution's connection first.
      [WRITE_WORKING_MEMORY_TOOL]: {
        gate: "disclosed-and-undoable-after",
        create: (deps) => savepointed(writeWorkingMemoryTool(deps), deps.db, inTurn),
      },
      // THE ONE THING A THREAD EXECUTION MAY WRITE FOR A CUSTOMER TO READ
      // (ticket #175). NOT SAVEPOINTED: it writes nothing — it holds the
      // draft, and the turn's caller writes it with the turn's words after
      // the record (ticket #368). `approve-before` is the tap (ADR-0006),
      // which is why it and the fill below are the two tools under that gate.
      [CREATE_DRAFT_TOOL]: {
        gate: "approve-before",
        create: createDraftTool,
      },
      // THE REP'S ANSWER INTO A BLANK (ticket #342): a draft written again,
      // so `create_draft`'s gate and its savepoint, for its reasons.
      [FILL_BLANK_TOOL]: {
        gate: "approve-before",
        create: (deps) => savepointed(fillBlankTool(deps), deps.db, inTurn),
      },
      // THE READS OF THE THREAD'S OWN DAYS AND OF THE CANVAS (ticket #320).
      // The three that query this execution's connection are savepointed for
      // `search_memory`'s reason; the two over the thread's own store read the
      // BUNDLE alone, as `resolve_chat` does.
      [SEARCH_MESSAGES_TOOL]: {
        gate: "projection",
        create: searchMessagesTool,
      },
      [READ_MESSAGE_TOOL]: {
        gate: "projection",
        create: readMessageTool,
      },
      [READ_POST_TOOL]: {
        gate: "projection",
        create: (deps) => savepointed(readPostTool(deps), deps.db, inTurn),
      },
      [READ_ENTITY_TOOL]: {
        gate: "projection",
        create: (deps) => savepointed(readEntityTool(deps), deps.db, inTurn),
      },
      [READ_CANVAS_TOOL]: {
        gate: "projection",
        create: (deps) => savepointed(readCanvasTool(deps), deps.db, inTurn),
      },
      // WHAT THE REP SEES AND HEARS (tickets #320, #340, #401; design D4). All
      // write on this execution's connection — an arrangement, a spotlight, a
      // knock row, a post on a card — so a turn that fails leaves none of them, and
      // none needs evidence: a turn an event woke may curate and knock, and
      // one a summons woke may speak on a card (ticket #384). None reaches notify: the knock is a row the runtime's pass
      // delivers (`notify-tiers.ts`).
      // THE BINDING QUESTION, HANDED TO THE REP (ticket #363): the ceremony
      // registers from this call, never from the words. Savepointed, because
      // it asks the ceremony on this execution's connection whether the
      // question is owed.
      [PROPOSE_BINDING_TOOL]: {
        gate: "approve-before",
        create: (deps) => savepointed(proposeBindingTool(deps), deps.db, inTurn),
      },
      [MOVE_CARDS_TOOL]: {
        gate: "disclosed-and-undoable-after",
        create: (deps) => savepointed(moveCardsTool(deps), deps.db, inTurn),
      },
      // THE ONE CARD HELD UP (ticket #401): a version on this connection.
      [SPOTLIGHT_TOOL]: {
        gate: "disclosed-and-undoable-after",
        create: (deps) => savepointed(spotlightTool(deps), deps.db, inTurn),
      },
      [KNOCK_TOOL]: {
        gate: "disclosed-and-undoable-after",
        create: (deps) => savepointed(knockTool(deps), deps.db, inTurn),
      },
      [SAY_ON_CARD_TOOL]: {
        gate: "disclosed-and-undoable-after",
        create: (deps) => savepointed(sayOnCardTool(deps), deps.db, inTurn),
      },
      // A TURN WITH NOTHING FOR THE REP ENDS ON THIS (ticket #401). It touches
      // nothing, so it carries no savepoint.
      [NOTHING_TO_SAY_TOOL]: {
        gate: "projection",
        create: nothingToSayTool,
      },
      // THE JOBS THAT OUTLIVE A TURN (ticket #323). Every one reads or writes
      // the run's rows on this execution's connection, so every one is
      // savepointed: a turn that fails leaves no run started, steered, paused
      // or cancelled. None needs evidence — a turn an event woke may start
      // work the rep asked for earlier (spec #318 decision 19).
      [READ_RUNS_TOOL]: {
        gate: "projection",
        create: (deps) => savepointed(readRunsTool(deps), deps.db, inTurn),
      },
      [START_WORKFLOW_TOOL]: {
        gate: "disclosed-and-undoable-after",
        create: (deps) => savepointed(startWorkflowTool(deps), deps.db, inTurn),
      },
      [STEER_RUN_TOOL]: {
        gate: "disclosed-and-undoable-after",
        create: (deps) => savepointed(steerRunTool(deps), deps.db, inTurn),
      },
      [PAUSE_RUN_TOOL]: {
        gate: "disclosed-and-undoable-after",
        create: (deps) => savepointed(pauseRunTool(deps), deps.db, inTurn),
      },
      [CANCEL_RUN_TOOL]: {
        gate: "disclosed-and-undoable-after",
        create: (deps) => savepointed(cancelRunTool(deps), deps.db, inTurn),
      },
      // THE RUTINAS THE TWIN AUTHORS (tickets #325, #386). DISCLOSED-AND-
      // UNDOABLE-AFTER: one the rep asked for is live at the ask and on
      // Rutinas with its switch and Descartar; one the twin proposes waits on
      // its card, whose Activar is the rep's — who asked is the twin's word
      // (Diego, 2026-10-11). Savepointed: it writes the rutina's rows and the
      // proposal card on this execution's connection.
      [CREATE_AUTOMATION_TOOL]: {
        gate: "disclosed-and-undoable-after",
        create: (deps) => savepointed(createAutomationTool(deps), deps.db, inTurn),
      },
      // THE REP'S ANSWER TO A PROPOSAL CARD, IN THEIR OWN WORDS (ticket #386):
      // `answer_ask`'s shape — the answer is the rep's, so it needs their own
      // message. Savepointed: it activates or discards on this connection.
      [ANSWER_PROPOSAL_TOOL]: {
        gate: "rep-evidenced",
        create: (deps) => savepointed(answerProposalTool(deps), deps.db, inTurn),
      },
      // A RUN'S QUESTION AND ITS ANSWER (ticket #324). The ask posts a card on
      // this execution's connection, and only a run's step can ask, since only
      // a run can wait for the answer; the answer is the rep's, so it needs
      // their own message — which no step of a run carries. Both savepointed:
      // a turn that fails leaves no card and no answer.
      [ASK_TOOL]: {
        gate: "disclosed-and-undoable-after",
        create: (deps) => savepointed(askTool(deps), deps.db, inTurn),
      },
      [ANSWER_ASK_TOOL]: {
        gate: "rep-evidenced",
        create: (deps) => savepointed(answerAskTool(deps), deps.db, inTurn),
      },
    },
  };
}
