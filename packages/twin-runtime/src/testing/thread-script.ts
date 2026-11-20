/**
 * SCRIPTING A THREAD TURN THAT ACTS (ticket #174).
 *
 * Every suite that used to plant a keyword and assert what the seam did now
 * plants PROSE and scripts the tool call the execution makes over it — which
 * is the ticket's whole claim, and also six lines of tool-call JSON per
 * case. These are those six lines, written once, so a suite says «this turn
 * dismisses the draft the rep quoted» and not «this turn emits a `tool_use`
 * block named `dismiss_draft` whose input carries this event id».
 *
 * THE EVIDENCE IS THE CALLER'S TO SUPPLY, and it is a parameter rather than
 * a default for the reason the tools exist: an act needs THIS execution's
 * trigger, so a suite proving a WRONG id is refused has to be able to script
 * one. `qaSilenceTurns()` in `@dito/scripted-model` is the sibling for a turn
 * that does nothing.
 *
 * NOT A HARNESS AND NOT A SEAM. It builds the same `ScriptedTurn[]` a suite
 * would write by hand and hands it to the same scripted wire; the real Tool
 * Runner, the real tools, the real contract and the real Postgres are all
 * still in the loop (ADR-0028 — CI never calls a model).
 */
import type { ScriptedTurn } from "@dito/scripted-model";
import { THREAD_MAX_ITERATIONS } from "../thread/automation.js";
import { EVIDENCE_PARAMETER } from "../thread/evidence.js";
import { THE_MESSAGE_PART } from "../thread/recipes.js";

/**
 * A THREAD TURN THAT NEVER GETS ITS LINE ACCEPTED (ticket #363): it writes
 * `line` — one the guard refuses — and writes it again every time the
 * refusal is handed back, until the turn's budget runs out. Every case
 * asserting a `failed` turn of that shape scripts it here rather than
 * counting rounds itself.
 */
export function refusedToTheEnd(line: string): ScriptedTurn[] {
  return Array.from({ length: THREAD_MAX_ITERATIONS }, () => ({ text: line }));
}

/** One tool call a scripted turn makes before it ends. */
export interface ThreadToolCall {
  readonly name: string;
  readonly input: Readonly<Record<string, unknown>>;
}

/** A turn's `knock` on a post (ticket #320). */
export function knockCall(postId: string, sentence: string): ThreadToolCall {
  return { name: "knock", input: { post_id: postId, sentence } };
}

/** A turn's `move_cards` with a post at the top, the rest in `order` (tickets #320, #401). */
export function moveCardsCall(top: string, order: readonly string[] = []): ThreadToolCall {
  return { name: "move_cards", input: { top, order: [...order] } };
}

/** A turn's `spotlight` on a post, or `null` to end it (ticket #401). */
export function spotlightCall(postId: string | null): ThreadToolCall {
  return { name: "spotlight", input: { post_id: postId } };
}

/** A turn's `say_on_card` on a post (ticket #340). */
export function sayOnCardCall(postId: string, sentence: string): ThreadToolCall {
  return { name: "say_on_card", input: { post_id: postId, sentence } };
}

/** A turn's `nothing_to_say`, which ends it with nothing posted (ticket #401). */
export function nothingToSayCall(): ThreadToolCall {
  return { name: "nothing_to_say", input: {} };
}

/** What one scripted thread turn does. */
export interface ThreadTurn {
  /**
   * The calls it makes first, in order — a read, a knock, a spotlight
   * (ticket #320) — before any act and its words.
   */
  readonly calls?: readonly ThreadToolCall[];
  /** The rep-act tool to call, if any. */
  readonly tool?: string;
  /** The id the call cites as the rep's own message. */
  readonly evidence?: string;
  /** Whatever the tool takes beyond its evidence — a line number, a yes/no. */
  readonly input?: Readonly<Record<string, unknown>>;
  /**
   * The line the twin writes last — its words. Omitted means a deliberate
   * silence: the model stops without writing, which is what a turn that only
   * acts does.
   */
  readonly answer?: string;
}

/**
 * One thread execution's whole script: its calls, the act (if any), and the
 * words the model ends on (ticket #363) — its line, or nothing.
 */
export function threadTurns(turn: ThreadTurn): ScriptedTurn[] {
  const turns: ScriptedTurn[] = (turn.calls ?? []).map((call) => ({
    toolCall: { name: call.name, input: { ...call.input } },
  }));
  if (turn.tool !== undefined) {
    turns.push({
      toolCall: {
        name: turn.tool,
        input: {
          ...(turn.evidence === undefined
            ? {}
            : { [EVIDENCE_PARAMETER]: turn.evidence }),
          ...turn.input,
        },
      },
    });
  }
  turns.push({ text: turn.answer ?? "" });
  return turns;
}

/**
 * The heading `renderParts` gives the thread's own message part.
 *
 * A SUITE TELLS THE TWO EXECUTIONS OF A PASS APART BY IT, and it lives here
 * because THREE files needed it (`thread.int.test.ts`,
 * `embedding.int.test.ts`, and every suite #174 gave a thread turn to). It
 * is built from the recipe's own exported name, so a suite's discriminator
 * cannot drift from the part — the Standards finding #173's own review
 * made about this constant when it was written out twice.
 */
export const THREAD_MESSAGE_HEADING = `## ${THE_MESSAGE_PART}`;

/**
 * Whether this prompt is a THREAD turn rather than a drafting one.
 *
 * The rule form of a script is read per conversation and keyed by its first
 * user turn (`scriptedModel`), so this is how a pass that runs two
 * executions at once — a rep's message and a customer's draft, which is
 * what the realtime lane does (`lanes.ts`) — gives each one its own turns
 * instead of one flat cursor they interleave into.
 */
export function isThreadTurn(prompt: string): boolean {
  return prompt.includes(THREAD_MESSAGE_HEADING);
}

/**
 * Whether this prompt is a turn the seam's event of `kind` woke (ticket #320):
 * its line is `[Event · <instant>] <kind> {…}`, and a script with turns of
 * several kinds tells them apart by it.
 */
export function isEventTurn(prompt: string, kind: string): boolean {
  return prompt.includes(`] ${kind} {`);
}
