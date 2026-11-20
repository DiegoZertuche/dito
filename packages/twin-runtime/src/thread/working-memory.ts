/**
 * THE TWIN WRITES ITS OWN NOTES (ticket #322; spec #318 decisions 2, 19, 20
 * and 32; ADR-0013 as amended; ADR-0033 as amended).
 *
 * One tool, callable in any turn — a turn the rep's line woke, one an event
 * woke, the arrival — that replaces the twin's working memory with a new
 * version: the whole prose and the whole list of open matters. Nothing calls
 * it on a schedule and nothing tidies it but the twin (Diego, 2026-10-03).
 *
 * ═══ THE GATE: DISCLOSED-AND-UNDOABLE-AFTER, NEVER REP-EVIDENCED ═══
 *
 * Mi libreta shows the current version, every version is kept, and the next
 * turn rewrites it — which is ADR-0013's second shape. It takes no evidence,
 * so a turn an event woke can note a settle the moment it happens; the
 * notepad beside it stays rep-evidenced, so that same turn still cannot write
 * a rule (`notepad.ts`; `evidence.ts`).
 *
 * ═══ WHOLE-REPLACE, ONE SHAPE ═══
 *
 * The model hands the whole prose and the whole list every time. It already
 * holds the current text — every wake renders it — so a rewrite is one call
 * with one shape, lands as one version, and the version it leaves is exactly
 * what the model sent. Operations on entries would be a second grammar for
 * the same result: every one of them still lands as a whole new version.
 *
 * EVERY WRITE SAYS WHICH VERSION IT REWRITES (`BASED_ON_PARAMETER`, the
 * notepad's own token; Codex r1). The day session's turns run one after
 * another, but a wake's message is rendered when it is queued: an event
 * waiting behind a turn that rewrites the notes is shown the older version,
 * and a whole replacement composed from it would drop what that turn wrote.
 * A write based on a version the store has moved past is refused with the
 * notes that stand, so the rewrite starts from them.
 *
 * ═══ WHAT A MATTER IS ABOUT, RESOLVED HERE ═══
 *
 * The twin names a customer by their reference (`[c7]`, ticket #321) and a
 * card by its post id. Code resolves each to the id its store minted — the
 * entity behind the reference, the post — and stores that, so the matter
 * names its subject whatever happens to the conversation it was written in. A
 * reference that resolves to nothing is refused with a sentence the model can
 * act on. In the prose and the labels a customer stays a reference too, and
 * code renders the name wherever the rep reads them (`working-memory.ts`).
 *
 * ═══ NOT AN ACT ON THE REP'S MESSAGE ═══
 *
 * It claims no act slot and marks nothing (`consumer.ts`'s `threadAct`): a
 * turn that dismisses a draft or writes one for a customer notes it too. Its
 * receipt folds into the reply only when the model says the rep asked for the
 * change (`REP_ASKED_PARAMETER`), so a note the twin made on its own is not
 * narrated to the rep on every answer.
 */
import {
  notepadLength,
  OPEN_MATTER_LABEL_CAP,
  WORKING_MEMORY_CAP,
  WORKING_MEMORY_MATTERS_CAP,
  type OpenMatter,
  type OpenMatterSubject,
  type WorkingMemoryVersion,
  type WorkingMemoryWrite,
} from "@dito/bundle";
import {
  defineTool,
  type EffectOutcome,
  type GatedEffectToolDeclaration,
} from "@dito/execution";
import { RECEIPTS } from "../grammar.js";
import { repTriggerOf, type ThreadDeps } from "./deps.js";
import { parseReference, referencesIn, writeReference } from "./references.js";
import { UUID } from "./served.js";

/** The tool's registered name. */
export const WRITE_WORKING_MEMORY_TOOL = "write_working_memory";

/**
 * THE WORD ITS OUTCOME CARRIES (ticket #322) — the twin's own, never one of
 * the rep's acts (`THREAD_ACT_WORDS`), so the consumer marks nothing with it
 * and the open page is told the notes moved.
 */
export const WORKING_MEMORY_ACT = "noted";

const TEXT_PARAMETER = "text";
const MATTERS_PARAMETER = "matters";
const REP_ASKED_PARAMETER = "rep_asked";
const BASED_ON_PARAMETER = "based_on";

/** The declared half — the instructions render from it, the registry builds from it. */
export const WRITE_WORKING_MEMORY_DECLARATION: Omit<GatedEffectToolDeclaration, "run"> = {
  name: WRITE_WORKING_MEMORY_TOOL,
  gate: "disclosed-and-undoable-after",
  description:
    `Rewrite your own working notes about this rep: what is live between you — who is waiting on what, what they asked you for, what is half done — and the list of matters still open. They are yours, not the rep's: the rep's rules go in their notebook, never here. The rep reads them — the text on their notebook page, every label where their dashboard offers your open matters — so write the text and every label in the rep's own language, the one the line on their language and register names. Send the WHOLE notes every time, as they should now read — what still holds from the notes you were shown plus what changed — and leave out what has closed. The text is capped at ${String(WORKING_MEMORY_CAP)} characters and the list at ${String(WORKING_MEMORY_MATTERS_CAP)} matters; if a write comes back over a cap you are given what stands, so shorten and call this again. Your notes are shown to you with their version, a write tells you the version it made, and every write says which version it rewrites: one based on a version somebody has already replaced comes back with the notes that stand, so rewrite from those. When the rep comes back, their dashboard offers your open matters with your labels on them; picking one tells you which, and you pick it up from there.`,
  inputSchema: {
    type: "object",
    properties: {
      [TEXT_PARAMETER]: {
        type: "string",
        description:
          "Your whole notes as they should now read, in plain prose. Empty when nothing is live.",
      },
      [MATTERS_PARAMETER]: {
        type: "array",
        description: "Every matter still open, each once. An empty list when none is.",
        items: {
          type: "object",
          properties: {
            label: {
              type: "string",
              description: `A few words naming the matter itself, what is pending or half done, the way the rep would, in the rep's own language, at most ${String(OPEN_MATTER_LABEL_CAP)} characters — what the rep reads and picks, with the customer's name shown beside it by code whenever it can tell who they are, so the label need not repeat it.`,
            },
            about: {
              type: "string",
              description:
                `What the matter is about: the customer's reference, like ${writeReference(7)}, or the card's post id as the dashboard shows it.`,
            },
          },
          required: ["label", "about"],
          additionalProperties: false,
        },
      },
      [BASED_ON_PARAMETER]: {
        type: "integer",
        description:
          "The version of your notes this text rewrites — the one you were last shown or last wrote, or 0 when you have none.",
      },
      [REP_ASKED_PARAMETER]: {
        type: "boolean",
        description:
          "True only when the rep's own message this turn asked you to change these notes; they are then shown a line saying you did.",
      },
    },
    required: [TEXT_PARAMETER, MATTERS_PARAMETER, BASED_ON_PARAMETER],
    additionalProperties: false,
  },
};

/** The write, bound to this twin and this turn. */
export function writeWorkingMemoryTool(deps: ThreadDeps): GatedEffectToolDeclaration {
  return defineTool({
    ...WRITE_WORKING_MEMORY_DECLARATION,
    run: async (input: unknown): Promise<EffectOutcome> => {
      const given = input as {
        [TEXT_PARAMETER]?: unknown;
        [MATTERS_PARAMETER]?: unknown;
        [REP_ASKED_PARAMETER]?: unknown;
        [BASED_ON_PARAMETER]?: unknown;
      };
      const basedOn = given[BASED_ON_PARAMETER];
      if (typeof basedOn !== "number" || !Number.isInteger(basedOn)) {
        return refused(
          `\`${BASED_ON_PARAMETER}\` is the version of your notes this text rewrites, as an integer.`,
        );
      }
      const text = given[TEXT_PARAMETER];
      const listed = given[MATTERS_PARAMETER];
      if (typeof text !== "string") {
        return refused(`\`${TEXT_PARAMETER}\` is your whole notes as they should now read, as text.`);
      }
      if (!Array.isArray(listed) || !listed.every(isMatterInput)) {
        return refused(
          `\`${MATTERS_PARAMETER}\` is a list of open matters, each with a \`label\` and what it is \`about\`, both as text.`,
        );
      }
      // A CUSTOMER IS WRITTEN BY THEIR REFERENCE HERE AS EVERYWHERE (#321), and
      // stored that way: a reference is the customer's for good, and code
      // renders the name wherever the rep reads the notes. One that names
      // nobody is refused.
      const unnamed = [text, ...listed.map((matter) => matter.label)]
        .flatMap(referencesIn)
        .find((reference) => deps.served.customers(reference) === undefined);
      if (unnamed !== undefined) {
        return refused(
          `${writeReference(unnamed)} names no customer — use a customer's reference as you were given it, or leave the name out.`,
        );
      }
      const matters: OpenMatter[] = [];
      for (const matter of listed) {
        const about = await subjectOf(deps, matter.about);
        if (about === undefined) {
          return refused(
            `"${matter.about}", for the matter "${matter.label}", is not a customer the rep confirmed or a post of yours. Use the customer's reference, like ${writeReference(7)}, or the card's post id exactly as you were shown it.`,
          );
        }
        matters.push({ label: matter.label.trim(), about });
      }
      // READ AFTER THE LAST AWAIT AND WRITTEN WITH NONE BETWEEN, so no other
      // turn can land a version in between (the bundle is one synchronous
      // connection) — `write_notepad`'s ordering.
      const current = deps.bundle.readWorkingMemory();
      if (basedOn !== (current?.version ?? 0)) return stale(current);
      const write = deps.bundle.writeWorkingMemory({
        text,
        matters,
        writtenAt: new Date().toISOString(),
        executionId: deps.executionId,
      });
      if (write.outcome === "over_cap") return overCap(write);
      // THE RECEIPT, ONLY WHERE THE REP ASKED AND A REP IS THERE TO READ IT:
      // a turn an event woke answers nobody's message.
      const receipt =
        given[REP_ASKED_PARAMETER] === true && repTriggerOf(deps) !== undefined
          ? RECEIPTS.workingMemoryWritten
          : undefined;
      return {
        performed: true,
        act: WORKING_MEMORY_ACT,
        told: JSON.stringify({
          outcome: "written",
          version: write.version.version,
          chars: notepadLength(write.version.text),
          matters: write.version.matters.length,
        }),
        ...(receipt === undefined ? {} : { receipt }),
      };
    },
  });
}

/** One listed matter as the model sent it. */
interface MatterInput {
  readonly label: string;
  readonly about: string;
}

function isMatterInput(value: unknown): value is MatterInput {
  if (value === null || typeof value !== "object") return false;
  const given = value as Record<string, unknown>;
  return typeof given["label"] === "string" && typeof given["about"] === "string";
}

/**
 * THE STABLE ID A MATTER IS ABOUT — or nothing, when it names nothing (ticket
 * #322; spec #318 decision 32).
 *
 * A CUSTOMER'S REFERENCE (`c7`, `[c7]`; #321) gives the entity behind it — a
 * customer the rep confirmed; a chat nobody has confirmed gives nothing, as
 * there is no entity yet to keep a matter about. AN ID IS CHECKED AGAINST THE
 * STORE THAT MINTED IT: a post of this twin's, or an entity one of the rep's
 * confirmed chats is bound to.
 */
async function subjectOf(
  deps: ThreadDeps,
  about: string,
): Promise<OpenMatterSubject | undefined> {
  const given = about.trim();
  const reference = parseReference(given);
  if (reference !== undefined) {
    const entityId = deps.served.customers(reference)?.entityId;
    return entityId === undefined ? undefined : { kind: "entity", id: entityId };
  }
  if (!new RegExp(`^${UUID.source}$`, "iu").test(given)) return undefined;
  const id = given.toLowerCase();
  if (deps.bundle.referenceOfEntity(id) !== undefined) return { kind: "entity", id };
  const posts = await deps.db.query("SELECT 1 FROM posts WHERE twin_id = $1 AND id = $2", [
    deps.twinId,
    id,
  ]);
  return posts.rowCount === 0 ? undefined : { kind: "post", id };
}

/**
 * A WRITE OVER A CAP, TOLD AS WHAT A REWRITE NEEDS: the caps, what this one
 * weighed, and the notes that still stand — `write_notepad`'s refusal, in
 * JSON for the same reason (the model computes against it).
 */
function overCap(write: Extract<WorkingMemoryWrite, { outcome: "over_cap" }>): EffectOutcome {
  return {
    performed: false,
    told: JSON.stringify({
      outcome: "over_cap",
      cap: write.cap,
      chars_attempted: write.charsAttempted,
      matters_cap: write.mattersCap,
      matters_attempted: write.mattersAttempted,
      label_cap: write.labelCap,
      labels_too_long: write.labelsTooLong,
      ...standing(write.current),
      instruction: `Nothing was written. Shorten what went over — fewer words, fewer matters, shorter labels — keeping what still matters, and call this tool again in this same turn with ${BASED_ON_PARAMETER} set to the version above.`,
    }),
  };
}

/**
 * A WRITE BASED ON A VERSION THE STORE HAS MOVED PAST (Codex r1), told as the
 * notes that stand — the over-cap refusal's shape — so the rewrite starts
 * from them.
 */
function stale(current: WorkingMemoryVersion | undefined): EffectOutcome {
  return {
    performed: false,
    told: JSON.stringify({
      outcome: "stale",
      ...standing(current),
      instruction: `Nothing was written. Your notes have moved on since the version you rewrote: the text and matters above are what stands now. Rewrite from them and call this tool again in this same turn with ${BASED_ON_PARAMETER} set to the version above.`,
    }),
  };
}

/** The notes that stand, as a refusal hands them back. */
function standing(current: WorkingMemoryVersion | undefined): Record<string, unknown> {
  return {
    current_version: current?.version ?? 0,
    current_text: current?.text ?? "",
    current_matters: (current?.matters ?? []).map((matter) => ({
      label: matter.label,
      about: matter.about.id,
    })),
  };
}

/** A write that did not happen, told to the model as feedback it can act on. */
function refused(why: string): EffectOutcome {
  return { performed: false, told: `refused: ${why}` };
}
