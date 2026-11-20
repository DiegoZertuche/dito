/**
 * WHAT A THREAD TURN IS SHOWN, AS RECIPES (tickets #173, #319; spec #171
 * decision 19; spec #318 decision 10).
 *
 * A turn of the day's session is told two kinds of thing, and they go to
 * two places. What stays true for the whole session is STANDING: rendered into
 * the instructions, which the session's child is told once when it opens.
 * What is about this turn — the «now», what the rep pointed at, the canvas,
 * the two notebooks as they stand, the accepted keywords when the rep wrote
 * at the phone's door, and the line or the event that woke it — is the turn's
 * CONTEXT, the user message the session is pushed. The keywords are the
 * turn's because the session holds both doors and only one of them has
 * keywords (ticket #404). Everything the two of them said earlier in the
 * day — the customers they spoke of, by their references, among it — the
 * model reads natively, in the session itself (ticket #321: no store
 * re-serves it).
 *
 * EVERY PART RENDERS FROM `deps` rather than from a parameter — see `deps.ts`
 * for why content cannot be a parameter and must not try to be.
 *
 * EVERY PART SAYS WHEN IT HAS NOTHING, rather than vanishing — the rule the
 * drafting side states: a model shown nothing cannot tell "there is nothing"
 * from "nobody looked". The one exception is
 * `quoted_post`, whose TEXT says so: the rep usually points at nothing, and a
 * part announcing that on every turn would be a line of framing the model
 * reads past.
 *
 * THE ONLY SPANISH IN A TURN IS SOMEBODY'S WORDS — the rep's message, the
 * quoted post, the accepted keywords. The first two are speech; the third is
 * DATA, and it is the whole point of `keyword_set`: the twin may teach «va»
 * and cannot teach a word the matcher does not accept, because the word comes
 * from the matcher's own table (`definition.test.ts` sweeps the rest of the
 * turn for orthography and asserts these are the exceptions).
 */
import { type NamedPart, type RecipeRegistry } from "@dito/execution";
import { AFFIRMATIONS } from "../affirmation.js";
import { repTriggerOf, type QuotedPost, type ThreadDeps } from "./deps.js";
import { NOTEPAD_RECIPE, notepadPart } from "../rep-notepad.js";
import { writeReference } from "./references.js";
import { WORKING_MEMORY_RECIPE, workingMemoryPart } from "../working-memory.js";
import { DOOR_NAMES } from "./tail.js";

export const THE_MESSAGE_RECIPE = "the_message";
export const QUOTED_POST_RECIPE = "quoted_post";
export const KEYWORD_SET_RECIPE = "keyword_set";
export const THE_EVENT_RECIPE = "the_event";

/**
 * WHAT IS ON THE REP'S CANVAS AS THE WAKE BEGINS (ticket #320; spec #318
 * decision 10; design §3.2) — one reference block in every wake's message,
 * rendered once before the turn by the same function `read_canvas` uses.
 */
export const CANVAS_RECIPE = "canvas";

/**
 * The part's own name, exported.
 *
 * A SUITE TELLS THE TWO EXECUTIONS OF A PASS APART BY IT (`thread.int.test.ts`,
 * `embedding.int.test.ts`), because a scripted rule has to answer each
 * conversation from what it was SHOWN and this heading is what a thread turn
 * has and a drafting turn does not. `renderParts` writes it as `## <name>`, so
 * a suite building the heading from this constant cannot drift from the part
 * (#173's two-axis review, Standards axis: a rendered heading was test
 * infrastructure in two files with nothing tying it to the recipe).
 */
export const THE_MESSAGE_PART = "the message";

/**
 * THE THING TO READ (spec #171 decision 19: "`the_message`").
 *
 * FENCED AND LABELLED AS THE REP'S OWN WORDS. It is the one part of the turn
 * that is definitely addressed to the twin, and it is also the part most
 * likely to contain something that reads like an instruction — because it IS
 * one: the rep telling their twin what to do is the ordinary case. So the
 * fence is not a defence here the way it is around retrieved history; it is
 * how the model tells the rep's sentence from the framing around it.
 *
 * IT CARRIES THE MESSAGE'S OWN ID SINCE #174, and without it no rep act
 * could happen at all. Every rep-act tool takes the id of the rep's own
 * message and refuses any other (`acts.ts`; ADR-0013's third gate shape), so
 * the model has to have been SHOWN the one id that passes — and this is the
 * part that is about their message, which makes it the part the id belongs
 * to. A prompt that told the model to cite an id it had never seen would
 * refuse every act in production while every scripted test passed, because a
 * script can inject what a model would have to read.
 *
 * AN OPAQUE ID AND ENGLISH METADATA. It is a `wa_events` row's uuid — no
 * chat, no rail stanza id, not a syllable of anything anybody said — and it
 * is rendered in the bracketed English shape #143 ruled for metadata, so the
 * only Spanish in this part stays the rep's own sentence.
 */
const theMessage = (deps: ThreadDeps) => (): NamedPart => {
  const asked = repTriggerOf(deps);
  return {
    name: THE_MESSAGE_PART,
    text: [
      // THE DOOR IT CAME THROUGH, tagged on the line (ticket #319): the day's
      // session holds both doors, and «lo que te dije en la mañana» may
      // point at a line typed at the other one.
      `The rep just wrote this to you [door: ${asked === undefined ? "none" : DOOR_NAMES[asked.door]}]. Read what they mean by it:`,
      `<rep_message>\n${deps.message}\n</rep_message>`,
      `[This message's id, which is what every tool that acts on the rep's behalf takes as its evidence: ${asked?.eventId ?? "none"}]`,
    ].join("\n"),
  };
};

/**
 * THE PART THAT SAYS WHY A TURN NOBODY WROTE BEGAN (ticket #319; spec #318
 * decision 11): the event's own line — a word and ids, never content — and
 * nothing that tells the twin what to do about it, because whether it needs
 * anything at all is the twin's to decide (design §6).
 */
export const THE_EVENT_PART = "the event";

const theEvent = (deps: ThreadDeps) => (): NamedPart => ({
  name: THE_EVENT_PART,
  text: [
    "Nobody wrote to you: this turn began because of an event in the rep's day.",
    deps.message,
  ].join("\n"),
});

/**
 * WHAT THE REP POINTED AT (spec #171 decision 19: "`quoted_post` (the post's
 * kind and its content: a draft's body and state, a disclosure's numbered
 * lines, a question's sentence, a binding question's name)").
 *
 * THE KIND AND THE CONTENT, BOTH, and the kind is what makes the content
 * readable: the same words mean different things depending on whether the
 * twin was proposing a message, reporting the day, or asking about a chat.
 * The content is the post's own text as the REP READ IT, decrypted from the
 * notice or the draft the executor actually posted — so what the model is
 * shown and what the rep is looking at are one string.
 *
 * A DRAFT CARRIES ITS STATE, and that is the one thing beyond the words. A
 * draft may be waiting, already sent, or dismissed — and dismissal is
 * terminal (ADR-0037) — so «¿ya se fue?» has three different true answers and
 * a twin shown only the body would guess.
 */
const canvas = (deps: ThreadDeps) => (): NamedPart => ({
  name: "canvas",
  text: deps.canvasBlock,
});

const quotedPost = (deps: ThreadDeps) => (): NamedPart => {
  const quoted = deps.quotedPost;
  if (quoted === undefined) {
    return {
      name: "quoted post",
      text: "The rep did not point at anything you posted — they are writing to you directly.",
    };
  }
  return {
    name: "quoted post",
    text: [
      `The rep is pointing at something you posted, so read their message against it. What you posted was ${describeKind(quoted.kind)}${describeState(quoted.draftState)}${
        // THE DRAFT'S CUSTOMER BY THEIR REFERENCE (ticket #321): «otro así»
        // under a Borrador names that customer, and the reference is how the
        // twin writes to them again without looking the name up.
        quoted.customer === undefined ? "" : `, for ${writeReference(quoted.customer)}`
      }:`,
      `<quoted_post>\n${quoted.text}\n</quoted_post>`,
      // THE LINE THE REP EDITED IN PLACE (ticket #344): their message is not a
      // reply about the record but that line as they say it should read.
      ...(quoted.editedLine === undefined
        ? []
        : [
            `On their dashboard the rep tapped line ${String(quoted.editedLine)} of it and rewrote that line where it stands: their message is line ${String(quoted.editedLine)} as it should read. Take it as their correction of that line.`,
          ]),
      // THE BLANK THE REP ANSWERED (ticket #342): their message is their
      // answer to the question the twin left in the draft, not a new request.
      ...(quoted.answeredBlank === undefined
        ? []
        : [
            `You left the blank "${quoted.answeredBlank.key}" (${quoted.answeredBlank.label}) in it, and on their dashboard the rep was asked your question for it — "${quoted.answeredBlank.question}" — and wrote this message as their answer. Fill that blank from what they said; when it gives you nothing to fill it with, leave it and tell them so.`,
          ]),
    ].join("\n"),
  };
};

/**
 * What a post of each kind IS, in the language the instructions are written
 * in.
 *
 * NAMED FROM THE REGISTRY'S OWN WORD rather than from the post's Spanish
 * heading, because the heading is chrome the rep reads (ADR-0037's amendment)
 * and a prompt that quoted it would be teaching the model to write it.
 */
function describeKind(kind: QuotedPost["kind"]): string {
  switch (kind) {
    case "draft":
      return "a draft reply you wrote for one of their customers, waiting on their tap";
    case "binding_question":
      // IT MAY ALSO BE AN ANSWER (ticket #195): the thread asks who a chat
      // belongs to inside the reply it is already sending, so one post can
      // be both — which the post's own words, quoted below, say better than
      // a second clause here could.
      return "your question asking whether a chat belongs to a name the phone offered";
    case "daily_disclosure":
      return "your account of what you added to the record that day, one numbered line per item";
    default:
      // A twin post with no verb: a send confirmation, a refusal, an ack, an
      // earlier answer of yours. The registry claims none of them, and none
      // of them is a thing the rep can act on — so it is context and nothing
      // else, and saying more would invent a kind.
      return "something you said earlier in this thread";
  }
}

function describeState(state: QuotedPost["draftState"]): string {
  switch (state) {
    case "live":
      return ", and it is still waiting: nothing has been sent";
    case "tapped":
      return ", and the rep already sent it";
    case "dismissed":
      return ", and the rep already discarded it — that is final, so the only way back is a new draft";
    case "filled":
      return ", and you already wrote it again with a blank filled — that newer draft is the one waiting";
    default:
      return "";
  }
}

/**
 * THE TWO ACCEPTED KEYWORD SETS, AS DATA (spec #171 decision 19 and user
 * story 37: "the accepted keyword set handed to the execution as data, so
 * that the twin can teach «va» and cannot teach a word that is not
 * accepted"; ADR-0037 as amended).
 *
 * RENDERED FROM `AFFIRMATIONS`, which is the matcher's own table. That is
 * the whole mechanism: the words the twin may teach are the words the
 * matcher accepts, because there is one table, so a word added or retaught
 * in `affirmation.ts` changes what the twin teaches with no edit here — and
 * a word that is NOT in the table is one the twin has no way to learn. A
 * list written down in this file would be a second place the vocabulary is
 * decided, which is exactly the defect #172 removed from the draft's
 * instruction line.
 *
 * TWO SETS NOW, NOT FOUR (ticket #174; spec #171 decision 18, and #173's
 * recorded remainder 3). The decline sets went with the matchers that read
 * them, so the part teaches only what is accepted — and it says out loud
 * that saying NO to either act is prose, because the model is the thing
 * that would otherwise fill the silence with a phrase it invented. The
 * strongest form of "the twin cannot teach a word that is not accepted" is
 * that there is no such word in front of it.
 *
 * ENGLISH METADATA AROUND SPANISH DATA. The frame says what each word DOES;
 * the words themselves are the data and are the only Spanish code puts in
 * this part (the other three sources are somebody's speech). The sets are
 * named for their grammar class — a proposal, a question — because that is
 * the axis the matcher turns on: «si» on a draft mints nothing, and a twin
 * that taught it as a way to send would be teaching the rep to watch nothing
 * happen.
 */
const keywordSet = () => (): NamedPart => keywordSetPart();

/** The keyword-set part itself — what the recipe renders on a turn at the phone's door. */
export function keywordSetPart(): NamedPart {
  return {
  name: "keyword set",
  text: [
    "Two acts in this thread are exact phrases rather than prose, because a wrong yes to either cannot be taken back: sending a draft to a customer, and confirming who a chat belongs to. The rep performs them by replying to your post, quoting it, with one of these words and nothing else:",
    `- on a draft you wrote, to send it: ${quoted(AFFIRMATIONS.proposal)}`,
    `- on your question about who a chat belongs to, to confirm it: ${quoted(AFFIRMATIONS.question)}`,
    "These two are the only words that count, and only when quoted on the right kind of post, and only on their own — a word with a sentence around it is prose and reaches you instead. You may tell the rep what to type when they ask how to send or how to confirm; use the first word of a list, which is the one they have been taught.",
    "EVERYTHING ELSE THEY SAY IS PROSE YOU READ, including saying no to either of these. There is no phrase for discarding a draft, for correcting the day's record, for answering a question of yours or for telling you a chat is not who you guessed — they say it however they say it, and you act with a tool. Never tell them a word to type for any of those.",
  ].join("\n"),
  };
}

/** One accepted set, as data: «word», «word». */
function quoted(words: readonly string[]): string {
  return words.map((word) => `«${word}»`).join(", ");
}

/**
 * HOW THIS REP TALKS, AND WHAT THEY HAVE TAUGHT (ticket #260; spec #258; user
 * story 17; ADR-0033 as amended).
 *
 * THE SAME PART THE DRAFTING SIDE RENDERS, FROM THE SAME FUNCTION
 * (`rep-notepad.ts`), and not the same REGISTRATION: a recipe registry is a
 * plain value per automation (`registry.ts`), so each one registers a recipe
 * of this name over its own deps. What must not differ is the WORDS, because
 * the rep is one person — which #173's two-axis review found written out
 * twice, and which is the hazard `@dito/execution`'s README states about
 * `renderTurnInstant`.
 *
 * READ FROM THE STORE FOR EVERY WAKE (ticket #322), like the working memory
 * rendered right after it: a write in one turn — the thread's own, or the
 * rep's from Mi libreta — is what the very next turn is shown.
 *
 * AND IT STATES THE VERSION, because this is the automation that can WRITE
 * the notebook: `write_notepad` replaces it whole and refuses a replacement
 * based on a version another turn has already replaced, so the model has to
 * have been shown the number that passes (`notepad.ts` argues the lost
 * update that rule closes).
 */
const notepad = (deps: ThreadDeps) => (): NamedPart => {
  const current = deps.bundle.readNotepad();
  return notepadPart({
    repLanguage: deps.repLanguage,
    notepad: current?.text,
    version: current?.version ?? 0,
  });
};

/**
 * THE TWIN'S OWN NOTES, RIGHT AFTER THE REP'S (ticket #322; spec #318
 * decision 2): read from the store for this wake, marked as the twin's and
 * never as rules (`working-memory.ts`), with the clause saying it may rewrite
 * them — the thread holds the tool that does.
 */
const workingMemory = (deps: ThreadDeps) => (): NamedPart =>
  workingMemoryPart({ memory: deps.bundle.readWorkingMemory(), writable: true });

/**
 * The seven, as a registry fragment the thread registries spread beside
 * `STANDARD_RECIPES`.
 *
 * A CONSTANT, NEVER A GLOBAL ANYTHING WRITES INTO — the rule `registry.ts`
 * states. Every entry is a factory, so the value holds no execution's data
 * and two concurrent executions share nothing but the code, which is a
 * property this ticket's lane makes load-bearing rather than tidy.
 */
export const THREAD_RECIPES: RecipeRegistry<ThreadDeps> = Object.freeze({
  [QUOTED_POST_RECIPE]: { parameters: {}, create: quotedPost },
  [THE_MESSAGE_RECIPE]: { parameters: {}, create: theMessage },
  [THE_EVENT_RECIPE]: { parameters: {}, create: theEvent },
  [CANVAS_RECIPE]: { parameters: {}, create: canvas },
  [KEYWORD_SET_RECIPE]: { parameters: {}, create: keywordSet },
  [NOTEPAD_RECIPE]: { parameters: {}, create: notepad },
  [WORKING_MEMORY_RECIPE]: { parameters: {}, create: workingMemory },
});
