/**
 * THE REP TEACHES THEIR TWIN, FROM PROSE (ticket #260; spec #258 *The rep
 * notepad, in full*; ADR-0033 as amended; ADR-0013's third gate
 * shape; #41 Q5 and Q7).
 *
 * The rep writes «con Fuentes siempre de usted» in their own thread, and this
 * is what happens: the twin writes the whole notebook down, the reply carries
 * a receipt code owns, and the next draft to Fuentes renders the rule as
 * context (`rep-notepad.ts`). No verb, no keyword — ADR-0037's axis is the
 * direction of the error, and a misread here costs one sentence to correct,
 * which is exactly the class that speaks in prose. The placeholder verb
 * ADR-0033's 2026-09-04 amendment implied retires unbuilt, and
 * `affirmation.test.ts` sweeps this package for it: the word and the rule
 * that forbids it belong on opposite sides of a fence.
 *
 * ONE: EVIDENCE, the same check the three rep acts make (`evidence.ts`). The
 * call cites the id of the rep's own message and code compares it with this
 * execution's trigger, so a customer-triggered drafting execution has nothing
 * to cite — and, being off drafting's tool list entirely, nothing to cite it
 * with. A rule about how the rep works can only ever come from the rep.
 *
 * TWO: THE WHOLE NOTEBOOK IS THE UNIT, never a delta, and every write says
 * WHICH VERSION it rewrites (`BASED_ON_PARAMETER`). A tool that added a rule
 * would have to decide what to drop when the block filled up, and "silently
 * dropped a rule the rep taught" is the one failure this feature cannot have.
 * So the model rewrites the notebook: it is shown the current text and its
 * version as context, it submits the new whole against that version, and a
 * call that cannot land — too long, or rewriting a version another turn has
 * already replaced — comes back with the text that stands, ITS version, and
 * the sentence telling the model to rewrite from there. Nothing is ever lost
 * by writing; only by the rep saying so.
 *
 * THREE: A CALL THAT CANNOT LAND IS NOT AN ACT (`asOneAct` is claimed below
 * both refusals, not above them). A notebook the store would not take is a
 * call the store could not even attempt — the same class as a parameter the
 * runner refuses before the tool sees it — so it costs the turn nothing and
 * the rewritten call lands on a slot that is still free. What the slot DOES
 * stop is a second, different act in the same message: a rep who teaches a
 * rule and dismisses a draft in one sentence gets one of them and a line
 * about the other, like every other act.
 *
 * FOUR: THE RECEIPT IS RENDERED FROM THE OUTCOME (`grammar.ts`'s `RECEIPTS`),
 * so the twin cannot report a write that did not happen — and `guard.ts`
 * refuses the sentence in prose for the same reason it refuses «Descartado».
 *
 * WHY IT IS SAVEPOINTED (`registries.ts`; Codex round 2). It writes the
 * BUNDLE, but it READS POSTGRES first: the evidence check re-reads the seam
 * row under the twin key (`evidence.ts` → the aperture's classifier), on THIS
 * execution's own connection. A statement that raises inside a transaction
 * aborts the whole transaction, so without the savepoint a cancelled or
 * timed-out evidence SELECT would poison the record insert, the chain append
 * and the marker that come after it — the same hazard the three rep-act
 * tools carry, for the same reason.
 *
 * THE BUNDLE WRITE IS STILL OUTSIDE ANY TRANSACTION, and that is worth
 * stating rather than leaving for a reader to find: the two stores share
 * none, so a run that fails AFTER the write leaves the rule captured and the
 * rep untold. That is the right way round — the rep's teaching survives and the next
 * draft obeys it — and the opposite, dropping what they taught because the
 * reply failed, is the outcome this whole tool exists to prevent.
 */
import { NOTEPAD_CAP, notepadLength, type NotepadVersion } from "@dito/bundle";
import {
  defineTool,
  type EffectOutcome,
  type RepEvidencedToolDeclaration,
} from "@dito/execution";
import { RECEIPTS } from "../grammar.js";
import { asOneAct, performed, refuse, type RepEvidencedDeclaration } from "./acts.js";
import type { ThreadDeps } from "./deps.js";
import { checkEvidence, EVIDENCE_PARAMETER, EVIDENCE_PROPERTY, evidenceRefOf } from "./evidence.js";

/** The tool's registered name. */
export const WRITE_NOTEPAD_TOOL = "write_notepad";

/** The parameter carrying the whole new notebook. */
const TEXT_PARAMETER = "text";

/**
 * THE PARAMETER CARRYING THE VERSION THIS WRITE REPLACES (ticket #260, Codex
 * rounds 1 and 2).
 *
 * THE LOST UPDATE IT CLOSES. Several executions run at once over one open
 * bundle (`lanes.ts`), so two rep messages picked up in the same pass are two
 * turns that both render the notebook, both rewrite it WHOLE and both write —
 * and the later write is a full replacement composed without the earlier
 * turn's rule in it. Both turns post a receipt; the rule the rep taught first
 * stops reaching any draft. Append-only keeps the losing version, so nothing
 * is destroyed; what is lost is that the current text is one turn's view
 * rather than a merge.
 *
 * SO THE MODEL SAYS WHICH VERSION IT READ, AND A VERSION THAT HAS MOVED IS
 * REFUSED — with the text that now stands, through the same rewrite-and-retry
 * the cap uses. It is the same mechanism as the evidence id one parameter
 * over: the number that passes is one the model has to have been SHOWN, by
 * the `notepad` context part or by a refusal, and code checks it against the
 * store rather than trusting it.
 *
 * A TOKEN ON THE CALL AND NOT A VALUE THIS RUN REMEMBERS, which is round 2's
 * correction. The SDK runs every tool call of ONE model response, so a
 * runtime that remembered "the version last handed back" would hand a
 * sibling call — composed before any refusal was written, and therefore
 * against the old text — a version check it had not earned. A token carried
 * by the call cannot travel backwards in time like that: two calls of one
 * response both cite what the response was composed against, and both are
 * refused.
 */
const BASED_ON_PARAMETER = "based_on";

/**
 * THE DECLARED HALF (the search's own note: the instructions render the tool
 * list from this and the registry's factory builds the runnable tool from it,
 * so one source means the digest that stamps what the model was TOLD and the
 * declaration it was HANDED cannot describe different tools).
 *
 * THE DESCRIPTION CARRIES THE WHOLE PROTOCOL, and it has to: what the
 * notebook is for, whose it is, when to write, that the write is the WHOLE
 * text, the cap, and what to do when the cap refuses. There is no part of the
 * prompt where a model could learn the consolidate-and-retry instead —
 * instructions are Dito's and are stamped once, and this rule belongs to the
 * one tool it is about.
 *
 * THE CAP IS NAMED IN CHARACTERS, from the store's own constant, so the
 * number the model budgets against and the number the write enforces are one.
 */
const WRITE_NOTEPAD_DECLARATION: RepEvidencedDeclaration = {
  name: WRITE_NOTEPAD_TOOL,
  // REP-EVIDENCED (ADR-0013's third gate shape, and ADR-0033's own
  // assignment): a write on twin-side state with no external effect and no
  // window to undo it in — what makes it safe is that only the rep can ask.
  gate: "rep-evidenced",
  evidence: EVIDENCE_PARAMETER,
  description:
    "Write down a standing rule the rep has just told you about how they work — how to address one of their customers, the register they want, how they sign off, anything they want done a certain way from now on. It is their notebook and not yours: write only what they have told you, never what you inferred from a conversation. You are shown the notebook as it stands, so send the WHOLE of it, their older rules and the new one together, as one text. It is capped at " +
    `${String(NOTEPAD_CAP)} characters; if it comes back over the cap, or based on a version somebody has already replaced, you are given the text that stands at that moment, so rewrite that into the same meaning with what the rep just told you and call this again in the same turn. Never drop a rule to make room.`,
  inputSchema: {
    type: "object",
    properties: {
      ...EVIDENCE_PROPERTY,
      [TEXT_PARAMETER]: {
        type: "string",
        description:
          "The whole notebook as it should now read: every rule the rep has taught you, in their own words as far as possible. An empty text clears it, and only when they asked you to.",
      },
      [BASED_ON_PARAMETER]: {
        type: "integer",
        description:
          "The version number of the notebook your text is a rewrite of — the one you were shown, or the one a refusal last gave you. Any other number is refused, and so is this one once somebody else has written over it.",
      },
    },
    required: [EVIDENCE_PARAMETER, TEXT_PARAMETER, BASED_ON_PARAMETER],
    additionalProperties: false,
  },
};

export { WRITE_NOTEPAD_DECLARATION };

/**
 * WHAT THE MODEL READS BACK — the structured result, both ways (spec #258).
 *
 * JSON RATHER THAN A SENTENCE, and this is the one tool result in the thread
 * that is. Every other `told` here is a line for the model to relay to the
 * rep; this one is a value the model has to COMPUTE against — it consolidates
 * to fit a number and needs the number, what it just weighed, and the text to
 * consolidate FROM. A sentence carrying a 1,500-character notebook inside it
 * would be the same data with a paragraph of prose wrapped round it.
 *
 * IT CARRIES NO RECEIPT. The rep-facing line travels on `EffectOutcome`'s own
 * `receipt` field, which the runner hands to the APP and never to the model
 * (`runner.ts` serializes `told` alone) — the shape every rep act here
 * already has. Putting the sentence in front of the model would hand it the
 * exact string `guard.ts` refuses it for typing.
 */
function told(result: Record<string, unknown>): string {
  return JSON.stringify(result);
}

/**
 * THE REFUSAL THE MODEL ACTS ON, built once (spec #258 — "a structured error
 * listing the current text and instructing consolidate-and-retry in the same
 * turn").
 *
 * TWO REASONS, ONE SHAPE, because they are one problem: the model holds a
 * notebook that cannot land — too long for the store, or written against a
 * version another turn has replaced — and the way out of both is to rewrite
 * it from the text that really stands. A second shape would be a second
 * protocol for the model to learn.
 *
 * THE INSTRUCTION TRAVELS WITH THE REFUSAL and not only in the tool's
 * description, because that is where it is read: the description is one
 * paragraph among a prompt's worth, and this is the sentence in front of the
 * model at the moment its notebook will not land. The rule it states is the
 * one thing this whole mechanism exists for — rewrite, never drop.
 */
function cannotLand(refusal: {
  readonly outcome: "over_cap" | "stale";
  readonly cap?: number;
  readonly charsAttempted?: number;
  readonly current: NotepadVersion | undefined;
}): EffectOutcome {
  return refuse(
    told({
      outcome: refusal.outcome,
      ...(refusal.cap === undefined ? {} : { cap: refusal.cap }),
      ...(refusal.charsAttempted === undefined
        ? {}
        : { chars_attempted: refusal.charsAttempted }),
      current_version: refusal.current?.version ?? 0,
      current_text: refusal.current?.text ?? "",
      instruction: `Nothing was written and nothing was lost. The text above is what the rep's notebook holds right now. Rewrite it whole — keeping every rule in it and adding what the rep just told you, shortened and combined if it will not fit — and call this tool again in this same turn with ${BASED_ON_PARAMETER} set to the version above. Never drop a rule to make room.`,
    }),
  );
}

/**
 * The tool, bound to this twin's memory and this run's evidence.
 *
 * THE ORDER OF THE FOUR CHECKS IS THE POINT, and it is not the rep acts'
 * order. EVIDENCE FIRST, because a refusal below hands back the rep's own
 * notebook and a call that never proved it was the rep's must not read it.
 * THEN the version this write is based on, because a text that rewrites a
 * notebook nobody holds any more is not worth measuring. THEN the cap. Both
 * OUTSIDE the act slot, so a notebook that cannot land costs the turn nothing
 * and the rewritten call has a slot to claim. THEN the slot and the write.
 *
 * AND THE LAST CHECK IS ATOMIC WITH THE WRITE, which is an ordering worth
 * stating because nothing in the shape shows it. From the version comparison
 * to the INSERT there is no `await`: `asOneAct` runs its claim synchronously
 * and invokes the handler below, whose body holds none either, and the bundle
 * is one synchronous SQLCipher connection (`lanes.ts`). So no other execution
 * can land a version in between — an `await` anywhere in that stretch would
 * reopen exactly the window this check closes.
 */
export function writeNotepadTool(deps: ThreadDeps): RepEvidencedToolDeclaration {
  return defineTool({
    ...WRITE_NOTEPAD_DECLARATION,
    run: async (input: unknown): Promise<EffectOutcome> => {
      const checked = await checkEvidence(deps, input);
      if (!checked.ok) return refuse(checked.told);
      const given = input as { [TEXT_PARAMETER]?: unknown };
      const text = given[TEXT_PARAMETER];
      if (typeof text !== "string") {
        return refuse(
          `refused: \`${TEXT_PARAMETER}\` is the whole notebook as it should now read, as text.`,
        );
      }
      const basedOn = (input as { [BASED_ON_PARAMETER]?: unknown })[
        BASED_ON_PARAMETER
      ];
      if (typeof basedOn !== "number" || !Number.isInteger(basedOn)) {
        return refuse(
          `refused: \`${BASED_ON_PARAMETER}\` is the version number of the notebook your text rewrites, as an integer.`,
        );
      }
      // READ ONCE, AND EVERY CHECK BELOW IS AGAINST THIS READING — the same
      // one the write lands against, with no `await` between it and the
      // INSERT (the header argues why that ordering is the whole lock).
      const current = deps.bundle.readNotepad();
      if (basedOn !== (current?.version ?? 0)) {
        // THE VERSION THIS TEXT REWRITES IS NOT THE ONE THE STORE HOLDS
        // (Codex rounds 1 and 2). Another turn of this pass has replaced it,
        // so landing this whole replacement would leave the rep taught twice,
        // told twice and obeyed once. Refused with what stands and with its
        // version, so the rewrite has both the words and the number it needs
        // — and refused OUTSIDE the act slot, so it has a slot to claim.
        return cannotLand({ outcome: "stale", current });
      }
      const chars = notepadLength(text);
      if (chars > NOTEPAD_CAP) {
        // IT COSTS THE TURN NOTHING either, for the same reason, and it
        // answers in the same shape: one protocol for the model to learn.
        return cannotLand({
          outcome: "over_cap",
          cap: NOTEPAD_CAP,
          charsAttempted: chars,
          current,
        });
      }
      return await asOneAct(deps, WRITE_NOTEPAD_TOOL, async () => {
        const write = deps.bundle.writeNotepad({
          text,
          // The instant the write really happens, read here as
          // `create_draft` reads its own (`write.ts`): a version's
          // `written_at` is when the rep taught it, not when the pass picked
          // their message up.
          writtenAt: new Date().toISOString(),
          executionId: deps.executionId,
          // THE EVIDENCE IS THE TRIGGER'S OWN EVENT — the id `checkEvidence`
          // just verified as the rep's live typed message, never anything the
          // call carried.
          evidenceRef: evidenceRefOf(checked.evidence),
        });
        // THE UNION'S OTHER ARM, AND NOT A SECOND CHECK: the same cap was
        // compared one branch above against the same string, with no `await`
        // between, so reaching this would mean the two counts disagree.
        // Answered the same way rather than thrown, because the refusal is
        // already written and an act reported as done would be the worse
        // outcome.
        if (write.outcome === "over_cap") {
          return cannotLand({
            outcome: "over_cap",
            cap: write.cap,
            charsAttempted: write.charsAttempted,
            current,
          });
        }
        // THE NEW VERSION RIDES IN THE RESULT (ticket #319): the session's
        // system prompt is told the notebook once, when its child opens, so
        // this answer is where a second write the same day finds the number
        // it replaces.
        return performed(
          RECEIPTS.notepadWritten,
          "notepad_written",
          told({ outcome: "written", chars, version: write.version.version }),
        );
      });
    },
  });
}
