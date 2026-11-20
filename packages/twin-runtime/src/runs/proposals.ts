/**
 * A RUTINA THE TWIN PROPOSES IS A CARD WHERE THE REP IS (ticket #386; Diego's
 * ruling of 2026-10-11 amending spec #318 decision 29; ADR-0044's `proposal`
 * part; ADR-0013: the gate is on the tool).
 *
 * ONE CARD, BOTH DOORS. `create_automation` with `asked_by: twin` writes the
 * rutina `pending` and posts its proposal here: the twin's sentence, when it
 * runs and its plan in words code rendered, to the canvas and to the
 * self-chat, as a run's question card goes. The rutina's row names the post
 * (`nameProposalPost`), so the card waits for as long as the rutina does.
 *
 * ONE ANSWER, TWO DOORS. Activar or Descartar pressed on the card is a
 * dashboard act on the rutina the part names (`dashboard-acts.ts`); the rep's
 * yes or no said in their own words is the thread's `answer_proposal`, which
 * performs the same act on the same store — `activateRutina` or
 * `discardRutina` — keyed on the card's post id. The rep never goes to
 * Rutinas to activate anything.
 *
 * WHO ASKED IS THE TWIN'S WORD AND NOTHING HERE TESTS IT (Diego, 2026-10-11):
 * a rutina written as the rep's ask is live at the ask and never reaches this
 * module; one written as the twin's proposal waits on this card.
 */
import type { Dek } from "@dito/crypto";
import {
  defineTool,
  renderTurnInstant,
  type EffectOutcome,
  type RepEvidencedToolDeclaration,
} from "@dito/execution";
import type pg from "pg";
import { insertNoticeWithSystemSend } from "../notices.js";
import { composeProposalPost } from "../posts.js";
import { asOneAct } from "../thread/acts.js";
import type { ThreadDeps } from "../thread/deps.js";
import { checkEvidence, EVIDENCE_PARAMETER, EVIDENCE_PROPERTY } from "../thread/evidence.js";
import { mentionsIn, renderNames, type Customers } from "../thread/references.js";
import type { StepSpec } from "./definition.js";
import { PLAN_HEADING, planLines, REPLACES_LINE, whenRutinaRuns } from "./rutina-words.js";
import { firstFiringOf } from "./next-firing.js";
import {
  activateRutina,
  discardRutina,
  nameProposalPost,
  rutinaOfProposalPost,
  type RutinaWake,
} from "./rutinas.js";

/** The thread's tool that answers a proposal card from the rep's own words. */
export const ANSWER_PROPOSAL_TOOL = "answer_proposal";

/** The word the thread records the rep's answer by (`THREAD_ACT_WORDS`). */
export const PROPOSAL_ANSWERED_ACT = "proposal_answered";

/** The two answers a proposal card takes: its two buttons. */
const PROPOSAL_ANSWERS = ["activate", "discard"] as const;

/**
 * POSTS A RUTINA'S PROPOSAL CARD to both doors under the turn's execution,
 * names it on the rutina's row, and answers its post id. The execution's
 * record is written when the turn settles, later in the same transaction, so
 * the notice's reference to it is checked at commit — the ask card's order
 * (`ask.ts`).
 */
export async function postProposalCard(
  client: pg.ClientBase,
  args: {
    readonly twinId: string;
    readonly selfChatJid: string;
    readonly dek: Dek;
    readonly executionId: string;
    readonly automationId: string;
    readonly name: string;
    readonly sentence: string;
    readonly wake: RutinaWake;
    readonly steps: readonly StepSpec[];
    readonly replaces: boolean;
    readonly customers: Customers;
  },
): Promise<string> {
  const customer =
    args.wake.kind === "trigger" && args.wake.customer !== undefined
      ? args.customers(args.wake.customer)?.shown
      : undefined;
  await client.query("SET CONSTRAINTS notices_execution_id_fkey DEFERRED");
  const noticeId = await insertNoticeWithSystemSend(client, {
    twinId: args.twinId,
    selfChatJid: args.selfChatJid,
    dek: args.dek,
    kind: "proposal",
    executionId: args.executionId,
    post: composeProposalPost({
      automationId: args.automationId,
      name: renderNames(args.name, mentionsIn(args.name, args.customers)),
      sentence: args.sentence,
      mentions: mentionsIn(args.sentence, args.customers),
      when: whenRutinaRuns(args.wake, customer),
      plan: planLines(args.steps),
      planHeading: PLAN_HEADING,
      replaces: args.replaces,
      replacesLine: REPLACES_LINE,
    }),
  });
  const posted = await client.query<{ id: string }>("SELECT id FROM posts WHERE notice_id = $1", [noticeId]);
  const postId = posted.rows[0]!.id;
  await nameProposalPost(client, { twinId: args.twinId, id: args.automationId, postId });
  return postId;
}

/**
 * `answer_proposal`'s declared half: REP-EVIDENCED (ADR-0013), `answer_ask`'s
 * own shape — the answer is the rep's, so the turn must carry their own
 * message, which is also what keeps a turn an event woke, or a run's step,
 * from accepting a proposal: neither carries one.
 */
export const ANSWER_PROPOSAL_DECLARATION: Omit<RepEvidencedToolDeclaration, "run"> = {
  name: ANSWER_PROPOSAL_TOOL,
  gate: "rep-evidenced",
  evidence: EVIDENCE_PARAMETER,
  description:
    "Give one of your rutina proposal cards the rep's answer, when they answered it in their own words here instead of on the card: activate when they said yes to it, discard when they said no. It does exactly what their Activar or Descartar on the card does — activated, it runs from its next instant; discarded, it is gone. Read the card with read_post first when you are unsure which one they mean. A card already answered refuses.",
  inputSchema: {
    type: "object",
    properties: {
      post_id: { type: "string", description: "The proposal card's post id, as the canvas or read_post shows it." },
      answer: { type: "string", enum: [...PROPOSAL_ANSWERS], description: "activate for their yes, discard for their no." },
      ...EVIDENCE_PROPERTY,
    },
    required: ["post_id", "answer", EVIDENCE_PARAMETER],
    additionalProperties: false,
  },
};

export function answerProposalTool(deps: ThreadDeps): RepEvidencedToolDeclaration {
  return defineTool({
    ...ANSWER_PROPOSAL_DECLARATION,
    run: async (input: unknown): Promise<EffectOutcome> => {
      const checked = await checkEvidence(deps, input);
      if (!checked.ok) return { performed: false, told: checked.told };
      const given = (input ?? {}) as { post_id?: unknown; answer?: unknown };
      if (typeof given.post_id !== "string" || !UUID_SHAPE.test(given.post_id)) {
        return refused("`post_id` is the proposal card's post id.");
      }
      const answer = given.answer;
      if (answer !== "activate" && answer !== "discard") return refused("`answer` is activate or discard.");
      const postId = given.post_id;
      return await asOneAct(deps, ANSWER_PROPOSAL_TOOL, async () => {
        const rutina = await rutinaOfProposalPost(deps.db, deps.twinId, postId);
        if (rutina === undefined) return refused("that is no rutina proposal of yours.");
        if (rutina.ended || rutina.state !== "pending") {
          return refused("that proposal is already answered: the rep accepted it or discarded it.");
        }
        // THE CARD'S OWN TWO ACTS, on the same store the buttons write
        // (`runAutomationAct`). A version the activation ended, and the content
        // of a discarded one, the pass's sweep deletes (`sweepRutinaContent`).
        if (answer === "activate") {
          const activated = await activateRutina(deps.db, { twinId: deps.twinId, id: rutina.id });
          if (activated === undefined) return refused("that proposal is already answered.");
          return {
            performed: true,
            act: PROPOSAL_ANSWERED_ACT,
            told: `Rutina ${rutina.id} is active, and the card ${postId} is answered. ${await firstFiringTold(deps, rutina.id)}`,
            settles: { postId, outcome: "confirmed" },
          };
        }
        const discarded = await discardRutina(deps.db, { twinId: deps.twinId, id: rutina.id });
        if (discarded === undefined) return refused("that proposal is already answered.");
        return {
          performed: true,
          act: PROPOSAL_ANSWERED_ACT,
          told: `Rutina ${rutina.id} is discarded, and the card ${postId} is answered.`,
          settles: { postId, outcome: "declined" },
        };
      });
    },
  });
}

/**
 * WHAT THE TWIN IS TOLD OF A RUTINA THAT JUST WENT ACTIVE (ticket #386): the
 * first instant the clock fires it, in the seat's zone — or that the event it
 * names wakes it, from now on. Code's arithmetic, the clock's own
 * (`firstFiringOf`); the twin says it to the rep in their words.
 */
export async function firstFiringTold(deps: Pick<ThreadDeps, "db" | "twinId" | "timeZone">, id: string): Promise<string> {
  const at = await firstFiringOf(deps.db, { twinId: deps.twinId, id, zone: deps.timeZone });
  return at === undefined
    ? "It runs each time its event happens, from now on."
    : `It first runs at ${renderTurnInstant(at, deps.timeZone)}, and on its cadence after that.`;
}

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** A write that did not happen, told to the model as feedback it can act on. */
function refused(why: string): EffectOutcome {
  return { performed: false, told: `refused: ${why}` };
}
