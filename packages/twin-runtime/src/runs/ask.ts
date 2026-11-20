/**
 * A RUN'S QUESTION TO THE REP, AND THE ONE PATH ITS ANSWER TAKES (ticket #324;
 * spec #318 decisions 23 and 34 as amended 2026-10-06; ADR-0044 as amended:
 * the `ask` part generalises the binding question).
 *
 * ONE TOOL, TWO CALLERS. The question card is composed and posted here, once:
 * by an `ask` step, whose fields the definition wrote, and by the `ask` tool an
 * `agent` step calls when it needs the rep, whose fields the model wrote. Both
 * post the same card to both doors and both park the run on it — the step by
 * its ending, the tool by the `waitsOn` its outcome carries, which settles the
 * turn `asked` (`@dito/execution`). The tool posts and the engine parks: the
 * model never decides to pause.
 *
 * ONE ANSWER PATH, TWO DOORS. A dashboard act on the card (`/act/answer-ask`)
 * and the thread's `answer_ask`, called after it resolved the rep's prose
 * against the card's options, both come to `answerAsk`: the answer checked
 * against the card's own fields, the instant stamped on the step that waits on
 * the card — once, which is what refuses a second answer — and the answer
 * written into the run's sealed content for the engine to resume the step
 * with. Nothing of the answer reaches a row (FR-73).
 *
 * ONLY A RUN ASKS. A card is answered into a run that waits on it, and the
 * thread has nothing that could wait: in a turn, the twin asks in its own
 * words, or starts a run that asks.
 */
import {
  defineTool,
  type EffectOutcome,
  type GatedEffectToolDeclaration,
  type RepEvidencedToolDeclaration,
} from "@dito/execution";
import type { Dek } from "@dito/crypto";
import type pg from "pg";
import { insertNoticeWithSystemSend } from "../notices.js";
import { composeAskPost, openSealedParts, type AskField, type AskPart } from "../posts.js";
import { asOneAct } from "../thread/acts.js";
import type { ThreadDeps } from "../thread/deps.js";
import { checkEvidence, EVIDENCE_PARAMETER, EVIDENCE_PROPERTY } from "../thread/evidence.js";
import {
  mentionsIn,
  referencesIn,
  renderNames,
  REFERENCE_EXAMPLE,
  type Customers,
} from "../thread/references.js";
import { readRunContent, writeRunContent } from "./content.js";
import {
  ASK_FIELD_KINDS,
  layout,
  MAX_ASK_FIELDS,
  MAX_ASK_OPTIONS,
  MAX_ASK_TEXT,
  type AskFieldKind,
  type RunValue,
} from "./definition.js";

/** The tool an agent step asks the rep with. */
export const ASK_TOOL = "ask";

/** ...and the thread's tool that answers a card from the rep's own words. */
export const ANSWER_ASK_TOOL = "answer_ask";

/** The word the ask records its effect by — the twin's own, like `run_started`. */
export const ASK_ACT = "asked";


/** A calendar date, as a date field's answer carries it. */
const DATE = /^\d{4}-\d{2}-\d{2}$/u;

/** One answer field as a caller writes it, before code renders its options. */
export interface AskFieldDraft {
  readonly name: string;
  readonly kind: AskFieldKind;
  readonly label?: string;
  readonly options?: readonly string[];
}

/**
 * THE CARD'S FIELDS, RENDERED BY CODE from what a step or a model wrote: each
 * pick's options labelled with the names the rep knows its customers by — or
 * why not, in a sentence the twin can act on.
 */
export function askFieldsOf(
  drafts: readonly AskFieldDraft[],
  customers: Customers,
): { readonly fields: readonly AskField[] } | { readonly refused: string } {
  if (drafts.length === 0 || drafts.length > MAX_ASK_FIELDS) {
    return { refused: `an ask carries one to ${String(MAX_ASK_FIELDS)} answer fields.` };
  }
  const fields: AskField[] = [];
  for (const draft of drafts) {
    const picks = draft.kind === "pick_one" || draft.kind === "pick_many";
    if (fields.some((field) => field.name === draft.name)) return { refused: `two fields are named \`${draft.name}\`.` };
    if (picks !== (draft.options !== undefined)) {
      return { refused: `\`${draft.name}\`: a pick has options and a text or a date has none.` };
    }
    if (draft.label !== undefined && (draft.label.trim() === "" || draft.label.length > MAX_ASK_TEXT)) {
      return { refused: `\`${draft.name}\`: a label is a few words.` };
    }
    const options = draft.options?.map((value) => value.trim());
    if (options !== undefined && (options.length === 0 || options.length > MAX_ASK_OPTIONS || options.some((value) => value === "" || value.length > MAX_ASK_TEXT))) {
      return { refused: `\`${draft.name}\`: a pick offers one to ${String(MAX_ASK_OPTIONS)} short options.` };
    }
    if (options !== undefined && new Set(options).size !== options.length) {
      return { refused: `\`${draft.name}\`: every option is offered once.` };
    }
    const stray = [draft.label ?? "", ...(options ?? [])].flatMap(referencesIn).find((reference) => customers(reference) === undefined);
    if (stray !== undefined) return { refused: `\`${draft.name}\` names a reference that names no customer.` };
    fields.push({
      name: draft.name,
      kind: draft.kind,
      ...(draft.label === undefined ? {} : { label: renderNames(draft.label, mentionsIn(draft.label, customers)) }),
      ...(options === undefined
        ? {}
        : { options: options.map((value) => ({ value, label: renderNames(value, mentionsIn(value, customers)) })) }),
    });
  }
  return { fields };
}

/**
 * POSTS THE CARD to both doors under the step's execution and answers its
 * post id. The execution's record is written when the step settles, later in
 * the same transaction, so the notice's reference to it is checked at commit
 * — the disclosure's own order (`disclosure.ts`).
 */
export async function postAskCard(
  client: pg.ClientBase,
  args: {
    readonly twinId: string;
    readonly selfChatJid: string;
    readonly dek: Dek;
    readonly executionId: string;
    readonly question: string;
    readonly customers: Customers;
    readonly fields: readonly AskField[];
  },
): Promise<string> {
  await client.query("SET CONSTRAINTS notices_execution_id_fkey DEFERRED");
  const noticeId = await insertNoticeWithSystemSend(client, {
    twinId: args.twinId,
    selfChatJid: args.selfChatJid,
    dek: args.dek,
    kind: "ask",
    executionId: args.executionId,
    post: composeAskPost({
      question: args.question,
      mentions: mentionsIn(args.question, args.customers),
      fields: args.fields,
    }),
  });
  const posted = await client.query<{ id: string }>("SELECT id FROM posts WHERE notice_id = $1", [noticeId]);
  return posted.rows[0]!.id;
}

// ─── the tool an agent step asks with ───────────────────────────────────

/**
 * `ask`'s declared half (ADR-0013: disclosed-and-undoable-after — the card is
 * in front of the rep the moment it lands, and it asks; nothing is decided
 * until they answer).
 */
export const ASK_DECLARATION: Omit<GatedEffectToolDeclaration, "run"> = {
  name: ASK_TOOL,
  gate: "disclosed-and-undoable-after",
  description: [
    "Ask the rep something you need a typed answer to before this step can go on, on a card in front of them on the dashboard and in their thread: your question, in their language and register, and its answer fields — pick_one or pick_many over options, a short text, or a date.",
    `A customer in a question or an option is their reference — ${REFERENCE_EXAMPLE} — and code shows the rep their name.`,
    "Only a step of a run can ask: the run waits on the card, and when the rep answers you are woken in this same conversation with their answer and finish the step then. In a turn of the thread, ask in your own words, or start a run that asks.",
  ].join(" "),
  inputSchema: {
    type: "object",
    properties: {
      question: { type: "string", description: "The question, as the rep reads it." },
      fields: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "A lowercase name the answer comes back under." },
            kind: { type: "string", enum: [...ASK_FIELD_KINDS] },
            label: { type: ["string", "null"], description: "What this field asks for, when the question alone does not say; null otherwise." },
            options: {
              type: ["array", "null"],
              items: { type: "string" },
              description: "pick_one and pick_many: the options, customers as their references; null for text and date.",
            },
          },
          required: ["name", "kind"],
          additionalProperties: false,
        },
      },
    },
    required: ["question", "fields"],
    additionalProperties: false,
  },
};

export function askTool(deps: ThreadDeps): GatedEffectToolDeclaration {
  return defineTool({
    ...ASK_DECLARATION,
    run: async (input: unknown): Promise<EffectOutcome> => {
      if (deps.trigger.kind !== "run_step") {
        return refused("only a step of a run can ask, because only a run can wait for the answer. Ask the rep in your own words, or start a run whose step asks.");
      }
      const given = (input ?? {}) as { question?: unknown; fields?: unknown };
      if (typeof given.question !== "string" || given.question.trim() === "" || given.question.length > MAX_ASK_TEXT) {
        return refused("`question` is the question, as the rep reads it.");
      }
      const drafts = fieldDraftsOf(given.fields);
      if ("refused" in drafts) return refused(drafts.refused);
      const customers = deps.served.customers;
      if (referencesIn(given.question).some((reference) => customers(reference) === undefined)) {
        return refused("the question names a reference that names no customer.");
      }
      const rendered = askFieldsOf(drafts.drafts, customers);
      if ("refused" in rendered) return refused(rendered.refused);
      const postId = await postAskCard(deps.db, {
        twinId: deps.twinId,
        selfChatJid: deps.selfChatJid,
        dek: deps.dek,
        executionId: deps.executionId,
        question: given.question.trim(),
        customers,
        fields: rendered.fields,
      });
      return {
        performed: true,
        act: ASK_ACT,
        told: `The question is on the rep's dashboard and in their thread as card ${postId}. This step now waits for their answer, and your turn ends here. When they answer, you are woken in this same conversation with it, and you finish the step then.`,
        waitsOn: postId,
      };
    },
  });
}

/** The model's fields, read: nulls for what a field does not carry. */
function fieldDraftsOf(raw: unknown): { readonly drafts: readonly AskFieldDraft[] } | { readonly refused: string } {
  if (!Array.isArray(raw)) return { refused: "`fields` is a list of answer fields." };
  const drafts: AskFieldDraft[] = [];
  for (const entry of raw) {
    const field = (entry ?? {}) as { name?: unknown; kind?: unknown; label?: unknown; options?: unknown };
    if (typeof field.name !== "string" || !/^[a-z][a-z0-9_]{0,39}$/u.test(field.name)) {
      return { refused: "every field's `name` is lowercase snake_case." };
    }
    if (typeof field.kind !== "string" || !(ASK_FIELD_KINDS as readonly string[]).includes(field.kind)) {
      return { refused: `\`${field.name}\`: \`kind\` is one of ${ASK_FIELD_KINDS.join(", ")}.` };
    }
    const options = field.options ?? undefined;
    if (options !== undefined && (!Array.isArray(options) || !options.every((option) => typeof option === "string"))) {
      return { refused: `\`${field.name}\`: \`options\` is a list of texts.` };
    }
    const label = field.label ?? undefined;
    if (label !== undefined && typeof label !== "string") return { refused: `\`${field.name}\`: \`label\` is a text.` };
    drafts.push({
      name: field.name,
      kind: field.kind as AskFieldKind,
      ...(label === undefined ? {} : { label }),
      ...(options === undefined ? {} : { options: options as string[] }),
    });
  }
  return { drafts };
}

// ─── the one answer path ────────────────────────────────────────────────

/** What the answer path needs: the step's connection, the twin's key and its harness directory. */
export interface AnswerDeps {
  readonly db: pg.ClientBase;
  readonly dek: Dek;
  readonly twinId: string;
  /** Where each run's sealed content lies; absent, no run can be answered. */
  readonly harnessDirectory?: string;
}

/** How an answer came out: taken into the run that waits on the card, or refused with why. */
export type AskAnswer =
  | { readonly answered: true; readonly runId: string; readonly step: number }
  | { readonly answered: false; readonly why: string };

/**
 * THE REP'S TYPED ANSWER TO A CARD, ONE PATH FOR BOTH DOORS (ticket #324).
 *
 * The card must be one of this twin's question cards; the answer must give
 * every field a value of its kind — a pick one or several of the card's own
 * options, a text, a date; the step that asked — the `ask` step, or the
 * `agent` step whose tool posted it, never a wait that only watches the card
 * settle — is stamped answered in the same statement that finds it, so a
 * second answer finds nothing waiting and is refused; and the answer is written into the run's
 * sealed content, under the step's name, before the caller's transaction
 * commits. The engine's next pass finds the card settled and resumes the step
 * with it (`engine.ts`). Runs on the caller's open transaction.
 */
export async function answerAsk(
  deps: AnswerDeps,
  request: { readonly postId: string; readonly answers: unknown },
): Promise<AskAnswer> {
  if (deps.harnessDirectory === undefined) return { answered: false, why: "this twin has no runs to answer into." };
  const card = await askPartOf(deps, request.postId);
  if (card === undefined) return { answered: false, why: "that is no question card of yours." };
  const values = answerValues(card, request.answers);
  if ("why" in values) return { answered: false, why: values.why };
  const stamped = await deps.db.query<{ run_id: string; step_index: number; definition_digest: string }>(
    `UPDATE run_steps s SET answered_at = clock_timestamp()
       FROM runs r
      WHERE r.id = s.run_id AND r.twin_id = $1 AND r.ended_at IS NULL
        AND s.awaits_post_id = $2 AND s.state = 'waiting' AND s.answered_at IS NULL
        AND s.kind IN ('ask', 'agent')
      RETURNING s.run_id, s.step_index, r.definition_digest`,
    [deps.twinId, request.postId],
  );
  const waiting = stamped.rows[0];
  if (waiting === undefined) return { answered: false, why: "that card is already answered, or nothing waits on it any more." };
  const content = readRunContent(deps.harnessDirectory, deps.dek, waiting.run_id, waiting.definition_digest);
  const step = layout(content.definition)[waiting.step_index];
  if (step === undefined) throw new Error(`run ${waiting.run_id} waits at a step its definition does not lay out`);
  writeRunContent(deps.harnessDirectory, deps.dek, waiting.run_id, {
    ...content,
    answers: { ...content.answers, [step.name]: values.values },
  });
  return { answered: true, runId: waiting.run_id, step: waiting.step_index };
}

/** The ask part of one of this twin's posts, opened — or nothing. */
export async function askPartOf(
  deps: Pick<AnswerDeps, "db" | "dek" | "twinId">,
  postId: string,
): Promise<AskPart | undefined> {
  const rows = await deps.db.query<{ parts_enc: Buffer | null }>(
    "SELECT parts_enc FROM posts WHERE id = $1 AND twin_id = $2",
    [postId, deps.twinId],
  );
  const sealed = rows.rows[0]?.parts_enc;
  if (sealed === undefined || sealed === null) return undefined;
  return openSealedParts(deps.dek, sealed).find((part): part is AskPart => part.kind === "ask");
}

/**
 * The answer, checked against the card's own fields — every field, each of
 * its kind, a pick only among the card's options — or why not.
 */
export function answerValues(
  card: AskPart,
  raw: unknown,
): { readonly values: Readonly<Record<string, RunValue>> } | { readonly why: string } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { why: "the answer is an object with a value for every field." };
  }
  const given = raw as Record<string, unknown>;
  const stray = Object.keys(given).find((name) => !card.fields.some((field) => field.name === name));
  if (stray !== undefined) return { why: `the card has no field \`${stray}\`.` };
  const values: Record<string, RunValue> = {};
  for (const field of card.fields) {
    const value = given[field.name];
    const offered = new Set(field.options?.map((option) => option.value) ?? []);
    switch (field.kind) {
      case "pick_one":
        if (typeof value !== "string" || !offered.has(value)) return { why: `\`${field.name}\` is one of the card's options.` };
        values[field.name] = value;
        break;
      case "pick_many": {
        if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && offered.has(item))) {
          return { why: `\`${field.name}\` is a list of the card's options.` };
        }
        values[field.name] = [...new Set(value as string[])];
        break;
      }
      case "text":
        if (typeof value !== "string" || value.trim() === "" || value.length > MAX_ASK_TEXT) {
          return { why: `\`${field.name}\` is a short text.` };
        }
        values[field.name] = value.trim();
        break;
      case "date":
        if (typeof value !== "string" || !DATE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
          return { why: `\`${field.name}\` is a date, as YYYY-MM-DD.` };
        }
        values[field.name] = value;
        break;
    }
  }
  return { values };
}

// ─── the thread's door into it ──────────────────────────────────────────

/** The word the thread records the rep's answer by (`THREAD_ACT_WORDS`). */
export const ASK_ANSWERED_ACT = "ask_answered";

/**
 * `answer_ask`'s declared half: REP-EVIDENCED (ADR-0013), because the answer
 * is the rep's and the turn must carry their own message — which is also what
 * keeps a run's own steps from answering a card: a step's turn carries none.
 */
export const ANSWER_ASK_DECLARATION: Omit<RepEvidencedToolDeclaration, "run"> = {
  name: ANSWER_ASK_TOOL,
  gate: "rep-evidenced",
  evidence: EVIDENCE_PARAMETER,
  description:
    "Give one of your question cards the rep's answer, when they answered it in their own words here instead of on the card: read the card with read_post first, resolve what they said against its fields and options, and pass the values — a pick as the option's value exactly as the card lists it, several for pick_many, a short text, or a date as YYYY-MM-DD. The run waiting on the card takes it up at its next step. A card already answered refuses.",
  inputSchema: {
    type: "object",
    properties: {
      post_id: { type: "string", description: "The card's post id, as the canvas or read_post shows it." },
      answers: {
        type: "object",
        description: "One value per field of the card, by the field's name.",
      },
      ...EVIDENCE_PROPERTY,
    },
    required: ["post_id", "answers", EVIDENCE_PARAMETER],
    additionalProperties: false,
  },
};

export function answerAskTool(deps: ThreadDeps): RepEvidencedToolDeclaration {
  return defineTool({
    ...ANSWER_ASK_DECLARATION,
    run: async (input: unknown): Promise<EffectOutcome> => {
      const checked = await checkEvidence(deps, input);
      if (!checked.ok) return { performed: false, told: checked.told };
      const given = (input ?? {}) as { post_id?: unknown; answers?: unknown };
      if (typeof given.post_id !== "string" || !UUID_SHAPE.test(given.post_id)) {
        return refused("`post_id` is the card's post id.");
      }
      const postId = given.post_id;
      return await asOneAct(deps, ANSWER_ASK_TOOL, async () => {
        const answered = await answerAsk(
          {
            db: deps.db,
            dek: deps.dek,
            twinId: deps.twinId,
            ...(deps.harness === undefined ? {} : { harnessDirectory: deps.harness.directory }),
          },
          { postId, answers: given.answers },
        );
        return answered.answered
          ? {
              performed: true,
              act: ASK_ANSWERED_ACT,
              told: `The answer is on card ${postId}; the run waiting on it takes it up at its next step.`,
            }
          : refused(answered.why);
      });
    },
  });
}

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** A write that did not happen, told to the model as feedback it can act on. */
function refused(why: string): EffectOutcome {
  return { performed: false, told: `refused: ${why}` };
}
