/**
 * THE SEND TOOL OF THE DAY'S DISCLOSURE (tickets #198, #364; spec #193
 * decisions 23 and 24; spec #214 decision 3; ADR-0013, ADR-0037 as amended).
 *
 * The disclosure run's agent step posts the day by calling this tool with two
 * kinds of sentence and nothing else: an opening that says what kind of day
 * it was, and a closing that tells the rep how to correct a line. Every VALUE
 * in the post — the count, the customers' names, the lines, their numbers,
 * their provenance — is code's, which is what the guard beside this file
 * refuses a call for typing. Its gate is the correction window
 * (`disclosed-and-undoable-after`): every line the post carries is one the
 * rep can take back until it closes.
 *
 * THE CLOSING'S STRUCTURE IS FIXED AND ITS SENTENCE IS NOT (spec #193
 * decision 23). It has to tell the rep that they correct a line by replying
 * to this post in their own words, because `retract_disclosure_line` reads
 * the number out of that reply and nothing else on this surface teaches it.
 * What it may not do is teach a KEYWORD: there is none — a correction is
 * prose (#174).
 *
 * WHAT `parseDayPost` IS FOR. The tool server checks nothing against the
 * schema, so every field is re-read from `unknown` here, and the structural
 * guard runs in the same place. A refusal is FEEDBACK: the reason goes back
 * as the tool's answer and the model may call again inside its turn (#133).
 *
 * THE DISPOSITION IS READ FROM WHAT POSTED (glossary *Disposition*): a call
 * whose post committed is `posted`, and nothing else is.
 */
import { defineTool, type EffectOutcome, type GatedEffectToolDeclaration } from "@dito/execution";
import { SLOT_EXAMPLE } from "./slots.js";
import type { DisclosureDeps } from "./deps.js";
import { structuralViolations } from "./guard.js";

/** The send tool's registered name. */
export const POST_DISCLOSURE_TOOL = "post_disclosure";

/** What one call carries: what a coworker adds around the day's own lines. */
export interface DayPost {
  readonly opening: string;
  readonly closing: string;
}

/**
 * WHAT POSTING THE DAY DID, and therefore what `posted` rests on: a
 * statement about what committed — the notice the day's post went out as and
 * how many lines it carried.
 *
 * A DAY THAT OWES LINES IS THE ONLY DAY THE TOOL POSTS (spec #48 decision 17;
 * ticket #218): a day with no pending line has nothing to post.
 */
export interface DisclosurePosting {
  /** The notice the day's post went out as. */
  readonly noticeId: string;
  /** How many lines it carried. */
  readonly lines: number;
}

/** What the model is told one call looks like. */
const DAY_POST_SCHEMA = {
  type: "object",
  properties: {
    opening: {
      type: "string",
      description:
        "One or two sentences opening the post, in the rep's own register: what kind of day this was. No digits — the heading states the count. Write a customer's name as its reference in double brackets and code fills the name in.",
    },
    closing: {
      type: "string",
      description:
        "One or two sentences closing the post. It must tell the rep how to correct a line: reply to this message quoting it, and say which line was wrong in their own words. Teach no command and no keyword — there is none. No digits.",
    },
  },
  required: ["opening", "closing"],
  additionalProperties: false,
} as const;

/** The declared half — the instructions render from it, the registry builds from it. */
export const POST_DISCLOSURE_DECLARATION: Omit<GatedEffectToolDeclaration, "run"> = {
  name: POST_DISCLOSURE_TOOL,
  gate: "disclosed-and-undoable-after",
  description: `Post the day's notes to the rep: an opening and a closing around the day's own numbered lines, which code puts in. Write a customer's name as ${SLOT_EXAMPLE} with its reference. Call it once; the day is posted once.`,
  inputSchema: DAY_POST_SCHEMA,
};

/** One day, ready to post: what it was served, and the posting the tool calls. */
export interface DayToPost {
  readonly deps: DisclosureDeps;
  readonly post: (dayPost: DayPost) => Promise<DisclosurePosting>;
}

/**
 * The tool, bound to the day it posts — or to nothing, for a step with no day
 * owed, where every call is refused with the reason.
 *
 * A POSTING THAT THROWS IS REFUSED BACK TO THE MODEL, its writes already
 * rolled back by the posting's own savepoint: a day already posted, or lines
 * another post told while this one was composing (`disclosure.ts`), leave
 * nothing behind and nothing to say `posted` about.
 */
export function postDisclosureTool(day: DayToPost | undefined): GatedEffectToolDeclaration {
  return defineTool({
    ...POST_DISCLOSURE_DECLARATION,
    run: async (input: unknown): Promise<EffectOutcome> => {
      if (day === undefined) {
        return { performed: false, told: "There is no day owed to post here: every line was already told, or the day was already posted." };
      }
      const parsed = parseDayPost(input, day.deps);
      if (!parsed.ok) return { performed: false, told: `Nothing was posted: ${parsed.reason}. Call again with it fixed.` };
      let posting: DisclosurePosting;
      try {
        posting = await day.post(parsed.dayPost);
      } catch (error) {
        return { performed: false, told: `Nothing was posted: ${error instanceof Error ? error.message : String(error)}` };
      }
      return {
        performed: true,
        act: "posted",
        told: `The day's notes are posted with ${String(posting.lines)} line(s). There is nothing more to do.`,
      };
    },
  });
}

/** What one call carried, or why it cannot be read. */
export type DayPostParse =
  | { readonly ok: true; readonly dayPost: DayPost }
  | { readonly ok: false; readonly reason: string };

/** Reads one call's opening and closing out of whatever arrived, or says why it cannot. */
export function parseDayPost(input: unknown, deps: DisclosureDeps): DayPostParse {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return no("the input is not an object");
  }
  const given = input as Record<string, unknown>;
  const opening = given["opening"];
  const closing = given["closing"];
  if (typeof opening !== "string") {
    return no("opening is the sentence that opens the post");
  }
  if (typeof closing !== "string") {
    return no("closing is the sentence that tells the rep how to correct a line");
  }
  const dayPost: DayPost = { opening, closing };
  // THE STRUCTURAL GUARD IS PART OF THE PARSE (spec #193 decision 23: "the
  // guard is structural"), so a refused call goes back to the model with its
  // reason rather than reaching a renderer that would have to decide what to
  // do about it.
  const violations = structuralViolations(dayPost, deps);
  if (violations.length > 0) return no(violations.join("; "));
  return { ok: true, dayPost };
}

function no(reason: string): DayPostParse {
  return { ok: false, reason };
}
