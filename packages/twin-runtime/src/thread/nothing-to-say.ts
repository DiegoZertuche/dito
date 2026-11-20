/**
 * THE TWIN'S TOOL FOR HAVING NOTHING TO SAY (ticket #401; boundary #327,
 * F12, ruled by Diego 2026-10-13).
 *
 * The thread's words are the model's final message (ADR-0014), so a silence
 * is a turn that stops without writing. The SDK does not let one stand: a
 * turn that ends with no visible text is handed the CLI's own prompt for a
 * visible response, and on the rig the model answered it with a note about
 * the turn, which the bar played as the twin's line. Instructions alone did
 * not hold it. So a silence is an act of the model's — this tool — and a
 * call to it ends the turn there (`endsTurn`): nothing is asked of the model
 * after it, and the turn posts nothing.
 *
 * NO CHECK ON THE TWIN'S WORDS. Whether a turn has something for the rep is
 * the twin's call (agentic first, 2026-09-29); code only ends the turn the
 * twin chose to end.
 *
 * A PROJECTION, because it changes nothing (ADR-0013 as amended 2026-09-02:
 * a tool with no effect to gate owes a projection): it reads nothing and
 * returns one fixed field.
 */
import { defineTool, type ProjectionToolDeclaration } from "@dito/execution";

/** The tool's registered name, which the instructions say where they say what silence is. */
export const NOTHING_TO_SAY_TOOL = "nothing_to_say";

/** The declared half — the instructions render from it, the registry builds from it. */
export const NOTHING_TO_SAY_DECLARATION: Omit<ProjectionToolDeclaration, "run"> = {
  name: NOTHING_TO_SAY_TOOL,
  gate: "projection",
  description:
    "Ends your turn with nothing for the rep: nothing is posted, nothing reaches either door, and you are asked nothing more. Call it when the turn has nothing for them — a note they are jotting to themselves, an event that asks nothing of you, a card you have nothing to add to.",
  columns: ["ended"],
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  endsTurn: true,
};

/** The tool, as a turn serves it: it touches nothing. */
export function nothingToSayTool(): ProjectionToolDeclaration {
  return defineTool({
    ...NOTHING_TO_SAY_DECLARATION,
    run: () => '{"ended":true}',
  });
}
