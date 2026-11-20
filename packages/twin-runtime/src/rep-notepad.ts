/**
 * WHAT THE REP HAS TAUGHT THEIR TWIN, AS ONE CONTEXT PART (ticket #260; spec
 * #258 *The rep notepad, in full*; ADR-0033 as amended; #114
 * decision 12).
 *
 * The rep writes «con Fuentes siempre de usted» in their own thread and the
 * next draft to Fuentes is formal. This is the half that makes the second
 * sentence true: the notepad reaches the model HERE, as a context part of a
 * drafting turn and of every thread wake, with the twin's own notes right
 * after it (`working-memory.ts`, ticket #322), and nowhere else.
 *
 * CONTEXT AND NEVER AN INSTRUCTIONS PART, which ADR-0033's 2026-09-09 note
 * states and is the reason this file exists rather than a paragraph in two
 * prompts. Instructions are Dito's and are stamped by the definition's digest;
 * the notepad is the REP's and changes whenever they say something — so a
 * notepad in the instructions would make every rep's twin a different
 * automation and every teach a new digest. Extraction and the disclosure do
 * not receive it at all: neither writes for the rep's customers, and the
 * disclosure keeps `rep_language` (`rep-language.ts`), which is the register
 * line alone.
 *
 * THE DEFAULT LINE IS THE NOTEPAD'S FIRST LINE, and that is why a part named
 * for the notebook opens with a sentence about register. `rep-language.ts`
 * said this would happen — "one line to replace when the notepad lands" — and
 * what actually happens is narrower and better: the Dito default STAYS, and
 * the rep's own words are added under it. So a rep who has taught their twin
 * nothing still gets a register, a rep who has taught it something gets both,
 * and `DITO_REP_LANGUAGE` still decides the default's words at the boundary.
 *
 * THE REP'S TEXT IS FENCED AND LABELLED AS THEIRS. It is the one other place
 * in a drafting turn where somebody's speech arrives — and, like the rep's own
 * message in the thread, it is speech that reads like an instruction because
 * it IS one. The fence is how the model tells their standing rules from the
 * framing around them, and the English bracketed metadata is the shape #143
 * ruled for everything code writes into a turn.
 */
import type { NamedPart } from "@dito/execution";
import { repLanguageLine } from "./rep-language.js";

/** The registered recipe name, shared by the two automations that render it. */
export const NOTEPAD_RECIPE = "notepad";

/**
 * The part's own name, exported for the suites that read one part out of a
 * rendered turn (`renderParts` writes it as `## <name>`).
 */
export const NOTEPAD_PART = "notepad";

/**
 * The part, as both automations render it.
 *
 * AN EMPTY NOTEPAD RENDERS THE FRAMING AND NOTHING ELSE — the default line,
 * and the version where a turn can write — and says nothing about being
 * empty. That is the one place this part departs from the thread recipes'
 * "every part says when it has nothing" rule, deliberately: a part announcing
 * that the rep has taught the twin nothing would be a standing invitation to
 * ask them to, every turn, for a notebook the rep never has to keep. There is
 * nothing to tell apart here either — a rep who has taught nothing and a rep
 * who cleared their notebook want the same drafts — and the version says
 * which of the two the store holds for the one reader that needs to know.
 */
export function notepadPart(args: {
  readonly repLanguage: string;
  /**
   * The rep's own words — `undefined` when they have taught the twin
   * nothing. REQUIRED AND NULLABLE rather than optional: every caller reads
   * one store for it, and a caller that simply forgot would render a rep's
   * notebook as empty with nothing to notice it by.
   */
  readonly notepad: string | undefined;
  /**
   * The version that text came from — `undefined` where the turn has no way
   * to write the notebook.
   *
   * IT IS A CONCURRENCY TOKEN AND IT IS STATED ONLY WHERE IT IS ACTIONABLE.
   * `write_notepad` replaces the notebook WHOLE and takes the version its
   * replacement is based on, so a thread turn has to have been SHOWN the
   * number that passes — the same mechanism as the message id every rep act
   * cites, and for the same reason. A drafting turn cannot write, so a line
   * telling it which version a write would replace would be framing about an
   * act it has no tool for.
   */
  readonly version: number | undefined;
}): NamedPart {
  const taught = args.notepad?.trim() ?? "";
  const lines = [repLanguageLine(args.repLanguage)];
  if (args.version !== undefined) {
    lines.push(
      `[Their notebook is at version ${String(args.version)}; a write of it says which version it replaces.]`,
    );
  }
  if (taught !== "") {
    lines.push(
      "[What the rep has told you about how they work. They wrote it, you did not, and it stands until they change it:]",
      `<rep_notepad>\n${taught}\n</rep_notepad>`,
    );
  }
  return { name: NOTEPAD_PART, text: lines.join("\n") };
}
