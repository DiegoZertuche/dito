/**
 * THE REP'S ANSWER, INTO THE BLANK THE TWIN LEFT (ticket #342; spec #318; the
 * spine's movement 8, «Me falta un dato»; ADR-0006, ADR-0013 as amended,
 * ADR-0037 as amended).
 *
 * The twin drafted and left a blank for a fact only the rep has; the rep was
 * asked its question in the pill and answered in prose. This is what happens
 * next: the twin reads their words and fills the blank — by WRITING THE DRAFT
 * AGAIN. A draft is immutable and a revised message is a new draft awaiting
 * its own tap (ADR-0006; …20260827100010), so the fill is a new draft row with
 * the filled body, a `draft_fills` row saying which draft it took the place
 * of, and a new post — the card the rep now reads, with one blank fewer. The
 * old post stands as the record of what the twin showed them.
 *
 * THE GATE IS THE DRAFTING GATE AS BUILT, `approve-before`, and the approval
 * is the tap (`create_draft`'s own argument): nothing here sends, and the
 * filled draft goes out only when the rep taps it with every blank filled —
 * the send lock refuses one with a blank still open.
 *
 * THE TARGET IS WHAT THE REP POINTED AT, NEVER WHAT THE MODEL NAMED. The turn
 * must be a rep's line, and its trigger's quoted post must be a draft: the
 * draft whose blank they tapped on the dashboard (the door's row names it),
 * or the Borrador they replied to in the thread. The model names only which
 * blank and the words for it — the blank the rep tapped is what the turn is
 * shown, and which blank their words answer is the twin's reading of them. Code checks the blank is one that draft left
 * and that the draft still waits, and nothing about the words beyond that
 * they are words and not half a marker (agentic first): reading the rep's
 * answer is the twin's job.
 *
 * ONE ACT PER MESSAGE, shared with every other act (`ActSlot`).
 */
import { randomUUID } from "node:crypto";
import { lockTwinForSend } from "@dito/seam";
import {
  defineTool,
  type EffectOutcome,
  type GatedEffectToolDeclaration,
} from "@dito/execution";
import { BLANK_KEY_PATTERN, carriesMarker, fillBody, type DraftBlank } from "../blanks.js";
import { readDraftCard, recordDraft } from "../drafts.js";
import { composeDraftPost } from "../posts.js";
import { asOneAct, performed, quotedPostOfKind, refuse } from "./acts.js";
import { repTriggerOf, type ThreadDeps } from "./deps.js";
import { referencesIn } from "./references.js";

/** The tool's registered name. */
export const FILL_BLANK_TOOL = "fill_blank";

/** The declared half, which the instructions render and the registry builds from. */
export const FILL_BLANK_DECLARATION: Omit<GatedEffectToolDeclaration, "run"> = {
  name: FILL_BLANK_TOOL,
  // APPROVE-BEFORE, the drafting gate: the fill writes a draft, and the tap
  // the rep makes on it is what makes it safe (ADR-0006).
  gate: "approve-before",
  description:
    "Fill a blank you left in the draft the rep's message is about, with the fact they just gave you. The draft is written again with the blank filled and takes the old one's place on their screen; nothing is sent — it goes out only when they tap it, once nothing is left blank. It acts on the draft they pointed at and takes no other target.",
  inputSchema: {
    type: "object",
    properties: {
      key: {
        type: "string",
        description: "The key of the blank you are filling, as the draft's marker names it.",
      },
      value: {
        type: "string",
        description:
          "The words that go where the blank stands, in the draft's own language and as the customer will read them, taken from what the rep said.",
      },
    },
    required: ["key", "value"],
    additionalProperties: false,
  },
};

/** The tool, bound to this run and this execution's connection. */
export function fillBlankTool(deps: ThreadDeps): GatedEffectToolDeclaration {
  return defineTool({
    ...FILL_BLANK_DECLARATION,
    run: async (input: unknown): Promise<EffectOutcome> => {
      const given = input as { key?: unknown; value?: unknown };
      // A REP'S LINE BEHIND IT, OR NOTHING: a turn an event woke has no words
      // of the rep's to fill a blank with.
      const trigger = repTriggerOf(deps);
      const draftId = trigger === undefined ? undefined : quotedPostOfKind(deps, "draft");
      if (draftId === undefined) {
        return refuse(
          "refused: a blank is filled from the rep's own answer to it, and this message is not about one of your drafts. Ask them for the fact.",
        );
      }
      if (typeof given.key !== "string" || !BLANK_KEY_PATTERN.test(given.key)) {
        return refuse("refused: `key` is the blank's key, as the draft's marker names it.");
      }
      const value = typeof given.value === "string" ? given.value.trim() : "";
      if (value === "" || carriesMarker(value) || referencesIn(value).length > 0) {
        // WORDS FOR THE CUSTOMER, AND NOTHING ELSE: a bracket would leave half
        // a marker in the message, and a reference would reach them as `[c7]`
        // — the two things `create_draft` refuses in a body too.
        return refuse(
          "refused: `value` is the words that go in the blank, written out for the customer to read.",
        );
      }
      const key = given.key;
      return asOneAct(deps, FILL_BLANK_TOOL, async () => {
        // UNDER THE SEND WRITER'S LOCK (Codex r1), `dismissDraft`'s reason: a
        // Descartar, an Enviar and a fill each decide on the others' absence,
        // so they take turns and the loser reads what the winner wrote.
        await lockTwinForSend(deps.db, deps.twinId);
        const card = await readDraftCard(deps, { draftId });
        if (card === undefined || card.state !== "waiting") {
          return refuse(
            "refused: that draft no longer waits on the rep — it was sent, discarded or already written again — so there is no blank in it to fill.",
          );
        }
        const blanks = card.part.blanks ?? [];
        const blank = blanks.find((one) => one.key === key);
        const filled = fillBody(card.body, key, value);
        if (blank === undefined || filled === undefined) {
          return refuse(
            blanks.length === 0
              ? "refused: that draft leaves no blank."
              : `refused: that draft has no blank "${key}". Its blanks are: ${named(blanks)}.`,
          );
        }
        const { counterparty } = card.part;
        if (counterparty === undefined) {
          // A POST RE-EXPRESSED FROM BEFORE PARTS EXISTED carries none, and it
          // can carry no blank either; a part with blanks always has one.
          return refuse("refused: that draft cannot be written again here.");
        }
        const remaining = blanks.filter((one) => one.key !== key);
        const newId = randomUUID();
        await recordDraft(
          deps.db,
          { twinId: deps.twinId, selfChatJid: deps.selfChatJid, dek: deps.dek, timeZone: deps.timeZone },
          {
            id: newId,
            // THE REP'S OWN EVENT AT THE THREAD'S DOOR, `create_draft`'s rule:
            // the column references `wa_events`, so a door message names none.
            ...(trigger?.door === "twin_thread" ? { inReplyToEventId: trigger.eventId } : {}),
            executionId: deps.executionId,
            destination: card.destination,
            contentEnc: deps.dek.encrypt(Buffer.from(filled.body, "utf8")),
            post: composeDraftPost({
              draftId: newId,
              // THE SENTENCE GOES WITH THE DRAFT IT WAS SAID OF (ticket #368):
              // a fill is that draft again, so the card keeps the twin's words.
              words: card.prose?.text ?? "",
              ...(card.prose?.mentions === undefined ? {} : { mentions: card.prose.mentions }),
              counterparty,
              ...(card.part.tail === undefined ? {} : { tail: card.part.tail }),
              body: filled.body,
              blanks: remaining,
              filled: { draftId: card.draftId, key, start: filled.start, end: filled.end },
              // THE REASON GOES WITH THE DRAFT IT WAS WRITTEN FOR (ticket #343):
              // a fill is that draft again, the rep's fact in its blank.
              ...(card.part.reason === undefined ? {} : { delicacy: { delicate: true, reason: card.part.reason } }),
            }),
          },
        );
        await deps.db.query(
          "INSERT INTO draft_fills (draft_id, filled_draft_id, execution_id) VALUES ($1, $2, $3)",
          [card.draftId, newId, deps.executionId],
        );
        deps.draftTiming.record({
          draftId: newId,
          executionId: deps.executionId,
          eventReceivedAt: deps.eventReceivedAt,
          runtimeSeenAt: deps.runtimeSeenAt,
          draftReadyAt: new Date(),
        });
        return performed(
          undefined,
          "drafted",
          remaining.length === 0
            ? `the blank "${key}" is filled and the draft is written again (draft ${newId}); nothing is left blank, so it sends when the rep taps it. You have not sent anything.`
            : `the blank "${key}" is filled and the draft is written again (draft ${newId}); it still leaves ${named(remaining)} blank, so it cannot go out until the rep gives you that too. You have not sent anything.`,
        );
      });
    },
  });
}

/** Blanks as the tool names them back to the twin: each key with its label. */
function named(blanks: readonly DraftBlank[]): string {
  return blanks.map((one) => `"${one.key}" (${one.label})`).join(", ");
}
