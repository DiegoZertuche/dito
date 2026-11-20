/**
 * THE TWIN'S OWN NOTES, AS ONE CONTEXT PART (ticket #322; spec #318 decisions
 * 2 and 32; ADR-0033 as amended).
 *
 * The twin keeps a short text about what is live with this rep — who is
 * waiting on what, what the rep asked for, what is half done — and a list of
 * the matters still open, each a few words and the id of what it is about.
 * It writes them itself, in any turn (`thread/working-memory.ts`); this is
 * how every rep-facing execution reads them back.
 *
 * RIGHT AFTER THE NOTEPAD, AND MARKED AS THE OPPOSITE OF IT. The notepad is
 * the rep's standing rules in the rep's own words (`rep-notepad.ts`); these
 * are the twin's notes, and the one failure this part exists to prevent is a
 * note read as a rule. So the frame says whose they are and that they bind
 * nothing, in the English bracketed metadata #143 ruled for everything code
 * writes into a turn, and the text sits inside a tag of its own — never the
 * notepad's.
 *
 * IT SAYS WHEN IT HAS NOTHING, which the notepad deliberately does not: an
 * empty notebook is the rep's business, and empty notes are the twin's own
 * state, which it should know it is in.
 *
 * IT NAMES ITS VERSION, because a wake's message is rendered when the wake is
 * pushed and an event's wake may wait behind a turn that rewrites the notes
 * (`@dito/execution`'s `Session.wake`). The write's own result carries the
 * version it made, so the twin reading both can tell which is newer.
 */
import type { Bundle, OpenMatter, OpenMatterSubject, WorkingMemoryVersion } from "@dito/bundle";
import type { NamedPart } from "@dito/execution";
import type { TwinOpenMatters, TwinWorkingMemory } from "@dito/seam";
import { readPostsByIds, type FeedDeps } from "./feed.js";
import {
  customersOf,
  mentionsIn,
  parseReference,
  renderNames,
  spellReference,
  type Customers,
} from "./thread/references.js";

/** The registered recipe name, shared by the automations that render it. */
export const WORKING_MEMORY_RECIPE = "working_memory";

/** The part's own name (`renderParts` writes it as `## <name>`). */
export const WORKING_MEMORY_PART = "working memory";

/**
 * The part, as every rep-facing execution renders it.
 *
 * `writable` IS WHETHER THIS EXECUTION HOLDS THE TOOL THAT REWRITES THEM —
 * the thread does, drafting does not — and only changes the frame's last
 * clause: a sentence about rewriting the notes is framing about an act a
 * drafting turn has no tool for (`notepadPart`'s version argument, for the
 * same reason).
 */
export function workingMemoryPart(args: {
  /** What the store holds now — `undefined` when the twin has written nothing. */
  readonly memory: Pick<WorkingMemoryVersion, "version" | "text" | "matters"> | undefined;
  readonly writable: boolean;
}): NamedPart {
  const text = args.memory?.text.trim() ?? "";
  const matters = args.memory?.matters ?? [];
  const version = args.memory?.version ?? 0;
  if (text === "" && matters.length === 0) {
    return {
      name: WORKING_MEMORY_PART,
      text: `[Your own working notes about this rep are empty, at version ${String(version)}: you have nothing written down about what is live with them.]`,
    };
  }
  const lines = [
    `[Your own working notes, at version ${String(version)}: what you are keeping track of with this rep. You wrote these; they are not the rep's instructions and bind nothing${args.writable ? ". Rewrite them whenever they stop being true" : ""}:]`,
    "<working_memory>",
  ];
  if (text !== "") lines.push(text);
  if (matters.length > 0) {
    lines.push("Open matters:");
    for (const matter of matters) {
      lines.push(`- ${matter.label} [${SUBJECT_WORDS[matter.about.kind]} ${matter.about.id}]`);
    }
  }
  lines.push("</working_memory>");
  return { name: WORKING_MEMORY_PART, text: lines.join("\n") };
}

/**
 * How a matter's subject reads in the part: a customer by their entity id, a
 * card by its post id — the words the canvas block and `read_post` use, and
 * the words a picked matter's event names it by (`thread/events.ts`).
 */
export const SUBJECT_WORDS: Readonly<Record<OpenMatterSubject["kind"], string>> = {
  entity: "customer",
  post: "post",
};

/** What reading the open matters onto the wire takes: the seam's posts and the bundle's mirror. */
export type MattersDeps = Omit<FeedDeps, "bundle"> & {
  readonly bundle: Bundle;
  /** The rep's own thread, which is nobody's customer (`customersOf`). */
  readonly selfChatJid: string;
};

/**
 * The open matters onto the wire (ticket #322): what `/open-matters` answers
 * and the `noted` event carries — version 0 and none while nothing is written.
 *
 * EACH WITH ITS SUBJECT, RENDERED HERE FROM THE STORED ID (ADR-0037: code
 * renders the name): the entity's customer, the customer a card is about —
 * each through their reference (#321). An id that resolves to nothing — a
 * binding undone, a post gone — carries no subject, and the bar shows the
 * label alone. A customer the twin wrote into a label by their reference is
 * rendered by name the same way.
 *
 * ...AND THE CUSTOMER'S REFERENCE BESIDE IT (ticket #335), spelled as a card's
 * own `customer` is, so a matter the rep picks finds that customer's waiting
 * card.
 */
export async function openMattersOnTheWire(
  deps: MattersDeps,
  memory: WorkingMemoryVersion | undefined,
): Promise<TwinOpenMatters> {
  const matters = memory?.matters ?? [];
  const customers = customersOf(deps.bundle, deps.selfChatJid);
  const subjects = await subjectsOf(deps, customers, matters);
  return {
    version: memory?.version ?? 0,
    matters: matters.map((matter, at) => {
      const subject = subjects[at];
      return {
        label: named(matter.label, customers),
        about: { kind: matter.about.kind, id: matter.about.id },
        ...(subject === undefined
          ? {}
          : { subject: subject.shown, customer: spellReference(subject.reference) }),
      };
    }),
  };
}

/** ...and the whole of it, for Mi libreta's second section. */
export async function workingMemoryOnTheWire(
  deps: MattersDeps,
  memory: WorkingMemoryVersion | undefined,
): Promise<TwinWorkingMemory> {
  return {
    ...(await openMattersOnTheWire(deps, memory)),
    text: named(memory?.text ?? "", customersOf(deps.bundle, deps.selfChatJid)),
    writtenAt: memory?.writtenAt ?? null,
  };
}

/** Prose the twin wrote, with every customer's reference rendered as their name. */
function named(prose: string, customers: Customers): string {
  return renderNames(prose, mentionsIn(prose, customers));
}

/** The customer each matter's subject resolves to, in order — or nothing. */
async function subjectsOf(
  deps: MattersDeps,
  customers: Customers,
  matters: readonly OpenMatter[],
): Promise<readonly ({ readonly shown: string; readonly reference: number } | undefined)[]> {
  if (matters.length === 0) return [];
  const postIds = matters.filter((matter) => matter.about.kind === "post").map((m) => m.about.id);
  const posts =
    postIds.length === 0 ? new Map() : await readPostsByIds(deps, postIds, new Date());
  return matters.map((matter) => {
    const reference =
      matter.about.kind === "entity"
        ? deps.bundle.referenceOfEntity(matter.about.id)
        : parseReference(posts.get(matter.about.id)?.customer);
    const customer = reference === undefined ? undefined : customers(reference);
    return customer === undefined ? undefined : { shown: customer.shown, reference: customer.reference };
  });
}
