/**
 * The owner twin's execution definition (ticket #130; spec #126 decisions 5
 * and 17; ADR-0014 as amended, ADR-0015; ticket #363).
 *
 * One owner turn is ONE EXECUTION. The instructions, the tool list and the
 * typed answer's schema are stamped; the context — this question, and the
 * earlier turns of this owner's conversation — is not, because it varies
 * every time by design. That is what makes "context never spans two
 * executions" (CONTEXT.md, *Execution*) true by construction rather than by
 * discipline: a second turn is a second execution with its own inputs,
 * never this one resumed.
 *
 * THE EXECUTION PACKAGE'S OWN DEFINITION, NOT A RUN'S (ADR-0002). Every
 * rep-side conversation is a one-step definition run through the twin
 * runtime's engine; that engine is rep-side and never crosses the wall, so
 * the owner twin is the one definition built straight from
 * `defineExecution` — one agent turn that ends when the model stops, on the
 * SDK's structured output, with no submission tool.
 */
import {
  defineExecution,
  NOW_OWNER_RECIPE,
  resolveBudget,
  STANDARD_RECIPES,
  type ExecutionDefinition,
  type NamedPart,
} from "@dito/execution";
import { ownerAnswerFormat, ownerDispositionOf, type OwnerAnswer, type OwnerAnswerKind } from "./answer.js";
import {
  OWNER_TWIN_LANE,
  OWNER_TWIN_MAX_ITERATIONS,
  OWNER_TWIN_RECIPES,
  OWNER_TWIN_WAKE,
} from "./automation.js";
import { ownerTwinInstructions } from "./instructions.js";
import { slotPattern } from "./prose.js";
import { OWNER_LAG_HOURS, OWNER_TOOL_DECLARATIONS } from "./tools.js";
import { ownerTwinTools, type OwnerTwinDeps } from "./turn-tools.js";

/** One earlier turn of this owner's conversation, as the store holds it. */
export interface OwnerTurn {
  readonly questionId: string;
  readonly askedAt: Date;
  readonly question: string;
  /** Null when that turn's execution ended with no answer. */
  readonly answer: {
    readonly kind: OwnerAnswerKind;
    readonly prose: string;
  } | null;
}

/**
 * The definition for one turn.
 *
 * THE SERVED MAP IS BOUND INTO THE ANSWER'S `parse` AND NOT INTO THE
 * DIGEST. `instructionsDigest` covers the schema and never `parse`, so two
 * turns of the same instructions stamp the same digest with two different
 * maps behind them, which is exactly what "the instructions digest is stable
 * across identical runs" (spec #126's definition of done, item 10) has to
 * mean for a per-run fence.
 *
 * THE LAG TRAVELS AS A BOUND VALUE, from `OWNER_LAG_HOURS` — the constant
 * FR-69 is argued against in `tools.ts` and the same one the reads refuse
 * with. The `now_owner` part restates no number, so the sentence the model
 * is shown and the refusal it would meet cannot disagree.
 */
export function ownerTwinExecution(options: {
  readonly deps: OwnerTwinDeps;
  readonly question: string;
  readonly earlierTurns: readonly OwnerTurn[];
  /** How many turns the conversation has in all, when more than were handed in. */
  readonly turnsInAll?: number;
  /** The ADR-0015 rung, named by the deployment. No default here. */
  readonly model: string;
  /** Told each answer's verdict — its refusal, or `undefined` when accepted — for the failed-query log. */
  readonly read?: (refusal: string | undefined) => void;
}): ExecutionDefinition<OwnerAnswer> {
  const { deps, question, earlierTurns } = options;
  const now = STANDARD_RECIPES[NOW_OWNER_RECIPE]!.create(undefined)({
    at: deps.askedAt,
    timeZone: deps.timeZone,
    lagHours: OWNER_LAG_HOURS,
  });
  return defineExecution<OwnerAnswer>({
    instructions: ownerTwinInstructions(OWNER_TOOL_DECLARATIONS),
    tools: ownerTwinTools(deps),
    outputFormat: ownerAnswerFormat(deps.served, options.read),
    context: [now, ...ownerTwinContext(question, earlierTurns, options.turnsInAll)],
    recipes: OWNER_TWIN_RECIPES,
    budget: resolveBudget({ maxIterations: OWNER_TWIN_MAX_ITERATIONS }, options.model),
    lane: OWNER_TWIN_LANE,
    wake: OWNER_TWIN_WAKE,
    dispositionOf: ownerDispositionOf,
  });
}

/**
 * Fresh, whole context from the owning app: the question and earlier turns.
 * See the module header and `ExecutionDefinitionSpec.context` for the
 * per-execution boundary.
 */
export function ownerTwinContext(
  question: string,
  earlierTurns: readonly OwnerTurn[],
  /**
   * How many turns this conversation has in total, when that is more than
   * the ones handed in. See `renderEarlierTurns` for why the number
   * travels rather than the turns.
   */
  turnsInAll?: number,
): readonly NamedPart[] {
  const parts: NamedPart[] = [];
  if (earlierTurns.length > 0) {
    parts.push({
      name: "earlier turns",
      text: renderEarlierTurns(earlierTurns, turnsInAll),
    });
  }
  // LAST, so the question is the nearest thing to the model's own turn.
  parts.push({ name: "the question", text: question });
  return parts;
}

/**
 * The conversation so far, rendered by code.
 *
 * THE OLD TURNS' REFERENCES ARE DEAD, and the rendering says so rather than
 * leaving it to be discovered. A reference is scoped to the run that served
 * it: `[[2]]` in yesterday's answer named whatever yesterday's second tool
 * result was, and citing `2` today would resolve against THIS run's map —
 * a citation that looks grounded and is not. So every slot is replaced by a
 * neutral marker here, and the model is told what those markers were. It
 * loses the values, which is the right trade: earlier turns are context for
 * reading the new question, never evidence for the new answer, and evidence
 * comes from tools that ran this turn.
 *
 * A FAILED TURN IS SHOWN AS ONE. An execution that ended with no answer
 * left a question with no answer, and hiding that would make a follow-up
 * unreadable.
 *
 * AND A TRUNCATED CONVERSATION SAYS SO (the two-axis review's Spec axis).
 * `readOwnerTurns` hands in the most recent turns and not all of them —
 * context is handed in WHOLE every turn, so an owner who has asked two
 * hundred questions would otherwise pay for all of them on the two hundred
 * and first, and eventually stop being answerable at all. What was not
 * asked for is the SILENCE about it: a model shown five turns of a
 * fifty-turn conversation, and not told, will answer «como te dije al
 * principio» about a beginning it never saw.
 */
export function renderEarlierTurns(
  turns: readonly OwnerTurn[],
  turnsInAll?: number,
): string {
  const lines = turns.map((turn) => {
    const said =
      turn.answer === null
        ? "You did not get an answer out that time."
        : `You (${turn.answer.kind}): ${withoutDeadSlots(turn.answer.prose)}`;
    return `They asked: ${turn.question}\n${said}`;
  });
  const earlier =
    turnsInAll !== undefined && turnsInAll > turns.length
      ? `These are the most recent ${turns.length} of ${turnsInAll} turns this owner has had with you. The older ones are not here. If the question needs one of them, say that you do not have it in front of you rather than reconstructing it.`
      : undefined;
  return [
    "This owner's earlier turns with you, oldest first. They are here so a follow-up makes sense, and for nothing else.",
    "Where one of your earlier answers had a value in it, you will see a marker instead. Those references belonged to the turn that served them and mean nothing now — read past them, and never cite one.",
    ...(earlier === undefined ? [] : [earlier]),
    lines.join("\n\n"),
  ].join("\n\n");
}

/** Every slot in an old answer, replaced by what it was. */
function withoutDeadSlots(prose: string): string {
  return prose.replace(slotPattern(), "(a value from the record)");
}
