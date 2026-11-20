/**
 * THE POST PRIMITIVE (ticket #220; spec #214 decision 2; ADR-0037 as
 * amended, ADR-0008, ADR-0034, ADR-0006, ADR-0013).
 *
 * Every twin post is ONE record with an ordered list of typed PARTS, so that
 * a draft, the day's record, a question and an acknowledgement are one shape
 * a surface renders rather than four shapes a surface has to know. The thread
 * renders a post in its own grammar; the dashboard renders the same parts as
 * a card (ticket #224 reads them through the local API, #221).
 *
 * PARTS ARE WRITTEN BY CODE, from a tool call's typed fields or a tool's own
 * result, and never by the model directly. That is ADR-0037's division seen
 * from the store side: the twin composes the PROSE of a post and code owns its
 * STRUCTURE, so a turn whose sentence claims an effect renders no
 * `receipt` — the receipt part carries what the TOOL returned or nothing at
 * all. The composers below are the whole of what may build a part, and each
 * takes typed arguments rather than text.
 *
 * ...AND THE TEXT IS BUILT FROM THEM. Each composer returns the parts AND the
 * thread rendering those parts amount to, in one value, so a post cannot be
 * emitted with a rendering its parts do not account for. The rendering itself
 * is `grammar.ts`'s: the sigil, the frame labels, the numbered lines and the
 * instruction line are that module's bytes and nothing here reshapes them,
 * which is why the thread and disclosure suites' pinned text is the oracle.
 *
 * WHAT A PART DOES NOT CARRY IS ANYTHING THAT LIVES ELSEWHERE. The draft's
 * body is `drafts.content_enc`, because that is the one thing a tap releases
 * (ADR-0006) and a copy could disagree with it; the day's numbered lines are
 * the rows ADR-0034's seal holds, because the numbering the rep read is the
 * record and re-rendering it would rewrite it. Those parts REFERENCE their
 * rows, and the feed opens them (`feed.ts`).
 *
 * ONE ROW BESIDE THE ROW THAT DELIVERED IT, and that is the decision this
 * ticket had to make (spec #214: "notices become the post's thread-rendering
 * record, or are folded in"). `notices` and `drafts` stay exactly as they
 * are: the executor dereferences `notice:<uuid>` and `draft:<uuid>` and knows
 * nothing else (ADR-0006), a notice is immutable because it is the record of
 * what the twin told the rep (ADR-0034), and FR-70's reconciliation walks that
 * outbox. So `posts` names the delivery row rather than replacing it — the
 * send lock gains no word, the plane gains no case, and the thread's bytes
 * are the frozen text the rep already read rather than something re-derived.
 */
import type { Dek } from "@dito/crypto";
import type pg from "pg";
import { scheduleReminder } from "./runs/reminder-rows.js";
import type { DraftBlank, DraftFill } from "./blanks.js";
import type { DraftDelicacy } from "./delicacy.js";
import { ASK_FIELD_KINDS, type AskFieldKind } from "./runs/definition.js";
// TYPE-ONLY, so the notice seam can go on importing this module without a
// runtime cycle: what is needed here is the closed set of kinds, as a type.
import type { NoticeKind } from "./notices.js";
import {
  assertFramed,
  bindingQuestionSentence,
  isBindingAnswersLine,
  renderAnswerPost,
  renderBindingQuestion,
  renderComposedBindingQuestion,
  renderDailyDisclosurePost,
  renderDraftPost,
  renderAskPost,
  renderProposalPost,
  renderReceiptPost,
  unframed,
  type DisclosurePostGroup,
} from "./grammar.js";
import { phoneName, renderNames, replaceReferences, spellReference, withTails } from "./thread/references.js";

/**
 * WHAT A SURFACE MAY OFFER THE REP on one part (spec #214 decision 2: "a
 * question part with a code-owned subject that names the act a yes
 * performs").
 *
 * They are the acts the rep side already has — the tap and the dismissal of a
 * draft (ADR-0006's two minters), the retraction of a disclosed line (#54),
 * the binding ceremony's yes and no (#34, #174), the typed answer to a run's
 * question (#324), «Listo» on a card that has no act of its own (#368),
 * Activar and Descartar on a rutina the twin proposed (#386) — named
 * here so a surface can draw a button without knowing which post it is
 * looking at.
 */
export type PostAnswerAct =
  | "tap"
  | "dismiss"
  | "retract"
  | "confirm"
  | "decline"
  | "answer"
  | "clear"
  | "activate"
  | "discard";

/**
 * THE CLOSED SET OF QUESTION SUBJECTS, each naming the acts its answer
 * performs (ticket #220 AC 3).
 *
 * ONE ENTRY IN 6a, and the reason it is a set rather than a boolean is the
 * question principle spec #214 writes: the twin asks only when the answer
 * makes the rep's work smaller, so the questions it may ask are a decided
 * list. The chat↔entity binding is the one on it — one of the two acts
 * reserved to the rep (ADR-0037 as amended), not the twin filling a hole in
 * its own record, which is the route #218 retired.
 *
 * IT IS ALSO A CHECK (`posts_question_subject_check`), and
 * `migration-vocabulary.test.ts` reads this constant rather than restating
 * it: a subject the code writes that the store refuses is a constraint
 * violation in front of a rep after the model has been paid for.
 */
export const QUESTION_SUBJECTS = Object.freeze({
  binding: Object.freeze(["confirm", "decline"]) as readonly PostAnswerAct[],
});

/** The subject kinds a question part may name. */
export type QuestionSubject = keyof typeof QUESTION_SUBJECTS;

/**
 * HOW A POST'S PARTS CAME TO BE WRITTEN — the other closed set, and the
 * answer to "how does a re-expressed pre-execution row name its origin".
 *
 * `composed` — this build wrote the parts, sealed, from a tool call or a
 *   tool result. Every post from ticket #220 forward.
 * `reexpressed` — the row predates `posts` and the migration re-expressed it
 *   (…20260907100030). SQL cannot seal, so such a row carries NO
 *   `parts_enc` and the feed derives its parts from the delivery row it
 *   names — the notice's kind, or the draft — with every field nothing
 *   recorded then simply absent (ADR-0034: an absent field is NOT RECORDED
 *   THEN, never a default).
 */
export const POST_ORIGINS = ["composed", "reexpressed"] as const;

export type PostOrigin = (typeof POST_ORIGINS)[number];

/**
 * A CUSTOMER A PROSE PART NAMES (ticket #321; CONTEXT.md *Reference*).
 *
 * The twin's text keeps the reference as it wrote it, `[c7]`, and the post
 * seals beside it what the reference named when the post was composed: the
 * name code renders, the number's tails where the customer has more than one
 * chat, and the entity when the rep confirmed them. Every surface renders the
 * name from here — the phone as a name, the dashboard as a name that links to
 * the customer's waiting card — so no name is baked into the text a renderer
 * would then have to find again.
 */
export interface Mention {
  /** The reference as the text carries it: `c7`. */
  readonly reference: string;
  /** The name as the rep reads it, marked when nobody has confirmed it. */
  readonly name: string;
  /** The last four digits of each of their numbers, when they have more than one chat. */
  readonly tails?: readonly string[];
  /** The confirmed customer's entity; absent for a chat nobody has confirmed. */
  readonly entityId?: string;
}

/** Prose the twin composed — the only part whose words are the model's. */
export interface ProsePart {
  readonly kind: "prose";
  readonly text: string;
  /** The customers the text names by reference (ticket #321); absent when it names none. */
  readonly mentions?: readonly Mention[];
}

/**
 * The draft this post proposes: the row a tap releases, and how the post
 * named its counterparty.
 *
 * THE BODY IS NOT HERE. `drafts.content_enc` is what a tap sends and
 * `drafts.post_enc` is what the thread shows, both frozen from birth and
 * bound to each other (…20260827100018); a second copy of either would be a
 * second answer to "what did the rep agree to". So the part names the draft
 * and the feed opens it.
 *
 * The counterparty is OPTIONAL because a re-expressed post has none: it was
 * rendered into `post_enc` and stored nowhere a reader can name (ADR-0034 —
 * an absent field is NOT RECORDED THEN, never a default). Why the draft
 * exists is the twin's sentence, the post's `prose` part (ticket #368).
 */
export interface DraftPart {
  readonly kind: "draft";
  readonly draftId: string;
  /** As the post named it — a confirmed binding, or a marked push-name (#34). */
  readonly counterparty?: string;
  /**
   * The last four digits of the number the draft goes to, when its customer
   * has more than one chat (ticket #321): the twin picked the chat, and the
   * card is where the rep sees which one before they tap.
   */
  readonly tail?: string;
  /**
   * THE FACTS THE TWIN LEFT FOR THE REP (ticket #342): each blank's key —
   * what its marker in the body names — its label and its question, composed
   * by the twin when it drafted and drawn by code. Absent on a draft with
   * none; `draft_blanks` holds the keys in the clear for the send lock.
   */
  readonly blanks?: readonly DraftBlank[];
  /**
   * The blank this draft filled in the draft it took the place of, and where
   * the rep's answer landed in this body (ticket #342) — present exactly on a
   * draft `fill_blank` wrote, which `draft_fills` records too.
   */
  readonly filled?: DraftFill;
  /**
   * THE DRAFT COMMITS THE REP TO SOMETHING, AND WHY (ticket #343;
   * `delicacy.ts`): the twin's flag and its reason of two sentences at most,
   * composed when it drafted and raised in the pill before the tap. Both
   * present or both absent — sealed here and nowhere else, since nothing but
   * the rep and the twin reads them.
   */
  readonly delicate?: true;
  readonly reason?: string;
}

/**
 * One counterparty's block of the day's post, as the post printed it.
 *
 * THE NAME AND THE NUMBERS, and not the lines themselves: the claims are the
 * sealed rows and this says which of them sat under which heading.
 */
export interface RecordLineGroup {
  readonly counterparty: string;
  /** The line numbers printed under that heading, in printed order. */
  readonly indexes: readonly number[];
}

/**
 * The day's record lines — a REFERENCE to the numbering ADR-0034's seal
 * holds, never a copy of it.
 *
 * `disclosure_post_lines` is the record of what the rep SAW, sealed with its
 * post by a trigger that refuses a line joining afterwards
 * (…20260829100025). A part carrying the lines would be a second numbering,
 * and the rep's retraction resolves through one of them. So this names the
 * post and the feed reads the rows.
 *
 * THE GROUPING IS CARRIED, AND FOR ADR-0034'S OWN REASON (Codex r1). The
 * thread prints each block under its counterparty's heading, and a surface
 * that resolved those names LATER — from the line's entity through the
 * bundle's mirror — would attribute a retractable claim to whatever the
 * customer is called today rather than to what the rep READ. A name is
 * exactly the kind of thing a rename changes. So the headings the post
 * printed are sealed with the part, and a line's attribution is a fact about
 * the post.
 *
 * Absent on a post re-expressed from before parts existed: nothing recorded
 * the grouping then, and the frozen rendering it printed is not a place a
 * reader can take one from (ADR-0034 — an absent field is NOT RECORDED THEN).
 */
export interface RecordLinesPart {
  readonly kind: "record-lines";
  readonly disclosurePostId: string;
  readonly groups?: readonly RecordLineGroup[];
}

/**
 * A question, with the subject that names what its answer does.
 *
 * `aboutEventId` is the customer-chat event whose sealed payload names the
 * chat and its push-name — the anchor the binding ceremony has used since
 * #34, so a confirmation re-derives the values the rep was shown rather than
 * trusting anything the answer carries. `proposedName` is what the post
 * proposed, absent on a post that folded the question into composed prose
 * (#195) and on one re-expressed from before this ticket.
 */
export interface QuestionPart {
  readonly kind: "question";
  readonly subject: QuestionSubject;
  readonly aboutEventId: string;
  readonly proposedName?: string;
}

/**
 * What a rep has answered a question with (ticket #255; boundary #225, F34).
 *
 * IT IS NOT PART OF THE SEALED PART, and that is the shape of it: a part is
 * what the twin ASKED, frozen when the post was written (ADR-0034), and an
 * answer is a fact about the store that arrives on either surface minutes
 * later. So it is read at the feed rather than sealed with the asking —
 * `OpenedQuestionPart` argues which store each answer is read from.
 */
export type QuestionAnswer = "confirmed" | "declined";

/**
 * An acknowledgement of what code DID, rendered from a tool's result or from
 * the outcome code itself observed (ADR-0013; ADR-0037's receipts rule).
 *
 * The text is the receipt SENTENCE, unframed: the thread wears the sigil and
 * the dashboard does not (#58's ruling — both retire on the dashboard).
 */
export interface ReceiptPart {
  readonly kind: "receipt";
  readonly text: string;
}

/**
 * THE ARRIVAL POST'S LAYOUT (ticket #266; ADR-0044 as amended — the first part
 * rendered as layout rather than as content).
 *
 * Which of the seat's waiting posts is the spotlight and the order of the
 * rest, spotlight first, by POST ID. The twin submitted them as references
 * to posts it was shown, and code resolved each to the post it names before
 * the part was built, so a curation naming a post
 * the seat does not hold never reaches a seal. The model never writes this
 * part; code builds it from the typed parameters, ADR-0037's rule.
 */
export interface CurationPart {
  readonly kind: "curation";
  /** Absent when nothing waited at the arrival. */
  readonly spotlight?: string;
  readonly order: readonly string[];
}

/**
 * ONE TYPED ANSWER FIELD OF AN `ask` (ticket #324; spec #318 decision 34):
 * its name — the run step's output field the answer lands in — its kind, and
 * for a pick the options, each a value the answer names and the label code
 * rendered for it (a customer's reference rendered as the name the rep knows
 * them by). The model never writes a label.
 */
export interface AskField {
  readonly name: string;
  readonly kind: AskFieldKind;
  /** What the field asks for, in the twin's words, when the question alone does not say. */
  readonly label?: string;
  readonly options?: readonly AskOption[];
}

/** One option of a pick: the value the answer carries, and its code-rendered label. */
export interface AskOption {
  readonly value: string;
  readonly label: string;
}

/**
 * A RUN'S QUESTION TO THE REP, WITH TYPED ANSWERS (ticket #324; ADR-0044 as
 * amended 2026-09-27: «`ask` — a question with options whose answer is a rep
 * act that resumes the run, the `question` part generalised past its closed
 * subject set»).
 *
 * The question is the twin's words, its customers by reference with what
 * they named sealed beside it, as a prose part's are; the fields are typed
 * parameters code renders. The answer is not here: a part is what the twin
 * ASKED, frozen when the post was written (ADR-0034), and the answer lands in
 * the run's sealed content beside its session — the card reads whether it is
 * still open off the step that waits on it.
 */
export interface AskPart {
  readonly kind: "ask";
  readonly question: string;
  readonly mentions?: readonly Mention[];
  readonly fields: readonly AskField[];
}

/**
 * A RUTINA THE TWIN PROPOSES (ticket #386; ADR-0044's `proposal` part, built
 * as Diego ruled on 2026-10-11: the proposal is a card where the rep is, and
 * accepting it there makes it active).
 *
 * The rutina's id, which the card's Activar and Descartar act on; its name
 * and the twin's sentence about it as the twin wrote them, references and
 * all, with what they named sealed beside the sentence, as a prose part's
 * are; and when it runs and its plan in the words code rendered from the row
 * and the steps when the post was written (`runs/rutina-words.ts`) — never a
 * step's instructions, which are the twin's words to itself. Whether it is
 * still open is the rutina's own state, read where the card is drawn.
 */
export interface ProposalPart {
  readonly kind: "proposal";
  readonly automationId: string;
  readonly name: string;
  readonly sentence: string;
  readonly mentions?: readonly Mention[];
  readonly when: string;
  readonly plan: readonly PlanLine[];
  /** Whether it changes a rutina the rep already has. */
  readonly replaces: boolean;
}

/** One line of a rutina's plan as code rendered it, and how deep in a branch it sits. */
export interface PlanLine {
  readonly text: string;
  readonly depth: number;
}

/**
 * A WORKSPACE DOCUMENT, BY ITS VERSION (ticket #326; ADR-0044 as amended
 * 2026-09-27: «`document` — a workspace item by version, opened in place»).
 *
 * The version's id, and its title and number as code read them off the
 * version when the post was written — so a card says which version it is
 * about without opening the bundle, and opening it reads that version's text
 * and never a later one. No path and no content: the text stays in the
 * bundle, and the card opens it through the runtime.
 */
export interface DocumentPart {
  readonly kind: "document";
  readonly versionId: string;
  readonly title: string;
  readonly version: number;
}

/**
 * ONE ROW OF A LIST, as the twin wrote it: its text, its customers by
 * reference with what they named sealed beside it, as a prose part's are.
 */
export interface DataRow {
  readonly text: string;
  readonly mentions?: readonly Mention[];
}

/**
 * TYPED DATA, AS A LIST (ticket #326; spec #318 decision 34: `data` is a
 * list only, a briefing's requests with a row that may link to its subject;
 * table and chart stay on the horizon). Each row is one of the twin's lines;
 * a customer it names links to their card where one waits, as a mention in
 * prose does.
 */
export interface DataPart {
  readonly kind: "data";
  readonly shape: "list";
  readonly rows: readonly DataRow[];
}

export type PostPart =
  | ProsePart
  | DraftPart
  | RecordLinesPart
  | QuestionPart
  | AskPart
  | ProposalPart
  | ReceiptPart
  | CurationPart
  | DocumentPart
  | DataPart;

/**
 * The union's kinds, as a value. Hand-kept and held total by
 * `posts.test.ts`, which is the same convention `twin-posts.test.ts` uses for
 * the post-kind registry: derived lists agree with the type by construction
 * and assert nothing about which kinds this ticket decided on.
 */
export const PART_KINDS = [
  "prose",
  "draft",
  "record-lines",
  "question",
  "ask",
  "proposal",
  "receipt",
  "curation",
  "document",
  "data",
] as const;

/**
 * THE LONGEST A KNOCK MAY BE, in characters.
 *
 * A LOCK SCREEN'S OWN BOUND. Android and iOS both truncate a notification
 * body around two short lines, so anything past that is written for nobody —
 * and the bound is what makes «one sentence» a thing the code holds rather
 * than a hope about what the model wrote. 140 is the widest sentence that
 * still arrives whole on the narrower of the two.
 */
export const KNOCK_MAX = 140;

/**
 * Anything that reads as a link, however it is spelt — `@dito/copy`'s
 * `COMPOSED_LINK` is the same rule with the whole argument beside it.
 */
const KNOCK_LINK =
  /https?:\/\/|\bwww\.|(?<![\p{L}])[a-z0-9][a-z0-9-]*\.[a-z]{2,24}(?![\p{L}.])/iu;

/**
 * Whether a composed sentence carries anything that reads as a link — the
 * knock's rule, shared with the arrival line (ticket #266), which is the other
 * sentence a model writes that code puts in front of the rep verbatim.
 */
export function carriesLink(text: string): boolean {
  return KNOCK_LINK.test(text);
}

/**
 * Whether a composed sentence may be a knock about this post, or an offer on
 * it (`post-knocks.ts`, the spotlight's offers).
 *
 * ONE RULE, ONE HOME. Two tools take such a sentence, and a bound stated in
 * each of them is a bound that drifts — so each hands the sentence here.
 *
 * `@dito/copy` STATES THE SAME BOUND ON ITS `composed` SLOT, and the two are
 * separate on purpose rather than by oversight: this package holds no
 * dependency on that one and must not — a runtime carrying the copy package
 * would be a runtime a Spanish literal could reach (`composed-language.test.ts`).
 * Both are about ONE fact, what a lock screen shows, and each end pins it to
 * the same documented number rather than to the other end's constant.
 *
 * A LINK IS REFUSED BECAUSE THE LINK IS CODE'S (ADR-0031 as amended): the
 * push payload carries the deep link notify built from the deployment's own
 * origin, and a second address inside the sentence would be a destination the
 * model chose on a surface the rep taps without reading. A newline is refused
 * for the same reason a `text` slot refuses one — a body is one line of prose
 * and a second line is a shape the sender did not agree to.
 *
 * AND A NUMBER IS REFUSED UNLESS THE POST ITSELF CARRIES IT (ticket #276;
 * ADR-0037's rule that the twin never types a number of its own). The
 * `announced` argument is the post's own words — the draft the rep is about to
 * send, the answer the question rides on — and `ungroundedNumberIn` is the
 * whole of the check.
 */
export function acceptsKnock(text: string, announced: string): boolean {
  return (
    text.trim() !== "" &&
    text.length <= KNOCK_MAX &&
    !text.includes("\n") &&
    !carriesLink(text) &&
    ungroundedNumberIn(text, announced) === undefined
  );
}

/**
 * A digit run in a composed sentence that is nowhere in what it is about, or
 * nothing (tickets #268, #276).
 *
 * THE INSTRUCTIONS SAY «NEVER A NUMBER THAT IS NOT IN FRONT OF YOU» AND THIS
 * IS WHERE THAT STOPS BEING ADVICE (ticket #276: a probe accepted «Garza debe
 * 987654 pesos» against a draft with no number in it). A lock screen is read at a glance and acted on, so a
 * quantity the record does not hold is the one kind of wrongness the rep
 * cannot see is wrong.
 *
 * IT LIVES WHERE THE PART IS BUILT (`acceptsKnock`'s own argument, one
 * function up): a knock and an offer are sentences the rep reads at a glance,
 * and the rule that decides what may be on them is one.
 *
 * DIGIT RUNS AND NOT ARITHMETIC, deliberately. What this catches is a number
 * that is not there at all; what it lets through is a number the subject
 * carries, however the sentence uses it — and a number SPELLED OUT, because a
 * colleague says «en dos horas» and this fence is about invention rather than
 * about style. Validating a spelled-out quantity is a different instrument and
 * is recorded rather than built (PR #275, Codex round 2).
 *
 * A WHOLE RUN AND NEVER A PIECE OF ONE (Codex round 2 on PR #275). Compared as
 * a substring, «25» is grounded by an announced text holding «125» and «5» by
 * one holding «1500» — and a probe put an invented quantity on a lock screen
 * through exactly that gap. So what the runs are compared against is the SET
 * of whole runs the announced text holds, and membership is the test.
 *
 * THOUSANDS GROUPING IS UNDONE ON BOTH SIDES, so «1,500» and «1500» are one
 * number whichever end wrote which (ticket #276; Codex round 2 on PR #277).
 * The raw text's own runs stay in the set as well, so «500» is grounded by a
 * draft that wrote «1,500» too. The alternative is a refusal a reader would
 * call a bug: the number IS in front of the model, spelt the way prose spells
 * one. What it costs is one round when the model converts units — a subject
 * saying «about 1 hour» and a sentence saying «60 minutos» is refused, and
 * the caller decides whether that is a dropped knock or another round.
 *
 * AND GROUPING IS THE ONLY THING UNDONE, which is what stops the undoing
 * becoming a hole. Removing every space between digits merged across the line
 * that joins a draft's body to the name it carries — a body ending «12» and a
 * customer called «24 Horas» grounded an invented «1224» — and merged inside
 * one line the same way. So a gap counts only where a number really is
 * grouped: a comma, one space or one non-breaking space, between a digit and
 * exactly three more that are not followed by a fourth. Everything else, a
 * newline first of all, is a boundary between two numbers.
 *
 * A PERIOD IS NEVER GROUPING, and that is the sharpest of those boundaries
 * (Codex round 3). In es-MX a point between digits is a DECIMAL point, so
 * undoing it turned «1,234.567 pesos» into «1234567» and let a knock claim an
 * amount a thousand times larger with the post's own blessing. The comma and
 * the space group; the point divides. What it costs is the reverse spelling —
 * a draft that wrote «1.500» meaning fifteen hundred does not ground a
 * sentence that says «1500» — which is a dropped knock rather than a wrong
 * number, and that is the direction this fence errs in everywhere else.
 */
export function ungroundedNumberIn(
  text: string,
  announced: string,
): string | undefined {
  const grounded = new Set([
    ...(announced.match(/\d+/gu) ?? []),
    ...(ungrouped(announced).match(/\d+/gu) ?? []),
  ]);
  // THE SENTENCE IS READ UNGROUPED, which is the other half of «both sides»:
  // its «1,500» is the one number 1500 rather than the two runs 1 and 500, so
  // a draft that wrote it without the comma still grounds it.
  for (const run of ungrouped(text).match(/\d+/gu) ?? []) {
    if (!grounded.has(run)) return run;
  }
  return undefined;
}

/**
 * One text with its thousands grouping taken out, and nothing else changed.
 *
 * EXACTLY THREE DIGITS AND NOT A FOURTH is what makes this grouping rather
 * than «any gap between digits»: «1,500» and «12 000» are one number each,
 * while «12 24» is two and a digit either side of a newline is two. The
 * non-breaking space is here by name because a rendering that grouped with
 * U+00A0 wrote the same number, and `\s` would take the newline with it.
 *
 * AND THE PERIOD IS NOT IN THE CLASS, which the header argues in full: in
 * es-MX it separates a decimal, so «1,234.567» keeps its point and a knock
 * claiming «1234567» finds no such number in the post.
 */
function ungrouped(text: string): string {
  return text.replace(/(?<=\d)[,\u00A0 ](?=\d{3}(?!\d))/gu, "");
}

/**
 * The sentence a `post_knocks` row holds, opened (ticket #320) — the knock the
 * thread added after a post landed, which every reader joins beside the parts.
 */
export function openKnock(dek: Dek, textEnc: Buffer): string {
  return Buffer.from(dek.decrypt(textEnc)).toString("utf8");
}

/**
 * WHAT EACH KIND OF PART OFFERS THE REP, except the question's — whose acts
 * come off its SUBJECT instead, because that is what a subject IS.
 *
 * `prose` and `receipt` offer none: one is something to read and the other is
 * something that already happened.
 */
const PART_ACTS: Readonly<
  Record<Exclude<PostPart["kind"], "question">, readonly PostAnswerAct[]>
> = {
  prose: Object.freeze([]),
  // ADR-0006's two minters, seen from the card: «va» and «no va» in the
  // thread, Enviar and Descartar on the dashboard.
  draft: Object.freeze(["tap", "dismiss"]),
  // Per line, inside the correction window (ADR-0004, #54).
  "record-lines": Object.freeze(["retract"]),
  // The rep's typed answer, once, while the run waits on it (#324).
  ask: Object.freeze(["answer"]),
  // Activar or Descartar, once, while the rutina waits on the rep (#386).
  proposal: Object.freeze(["activate", "discard"]),
  receipt: Object.freeze([]),
  // A curation is layout: the canvas draws its cards in this order, and the
  // acts are the cards' own (`CurationPart`).
  curation: Object.freeze([]),
  // A document and a list are something to read: opening a document is a
  // read through the runtime, never an answer the rep gives (#326). What the
  // rep can do is take the card off the canvas — «Listo», a card with no act
  // of its own (#368; `clearable`).
  document: Object.freeze(["clear"]),
  data: Object.freeze(["clear"]),
};

/**
 * The acts a part offers, so a surface can draw a button without a switch of
 * its own — the one place the two rules above meet.
 */
export function answerActsOf(part: PostPart): readonly PostAnswerAct[] {
  if (part.kind === "question") return QUESTION_SUBJECTS[part.subject];
  return PART_ACTS[part.kind];
}

/**
 * WHETHER «LISTO» MAY TAKE A POST'S CARD OFF THE CANVAS (ticket #368; ruled
 * 2026-10-08): a card that offers «Listo» and nothing else. A card with acts
 * of its own — a draft's Enviar and Descartar, a binding question's two, a
 * run's question, the day's notes' Retirar — keeps them and is never cleared.
 */
export function clearable(parts: readonly PostPart[]): boolean {
  const acts = parts.flatMap((part) => answerActsOf(part));
  return acts.includes("clear") && acts.every((act) => act === "clear");
}

/**
 * One twin post as code composes it: its parts and the thread rendering they
 * amount to.
 *
 * BOTH OR NEITHER, in one value, because that is what makes "the thread's
 * grammar is produced from the parts" structural rather than a convention.
 * The emission seams (`notices.ts`, `drafts.ts`) take this and nothing
 * looser, so a post cannot reach the rep with a rendering its parts do not
 * account for.
 */
export interface ComposedPost {
  readonly parts: readonly PostPart[];
  /** Exactly what `system_send` will carry, framed (ticket #30). */
  readonly text: string;
}

/**
 * THE DRAFT POST — the twin's sentence and the draft (tickets #30, #175,
 * #368): a `prose` part holding the words the turn that wrote the draft ended
 * on, then the draft's own part, and Mock A rendered from both.
 *
 * THE WORDS ARE THE CARD'S SENTENCE AND THE THREAD'S LINE (the glossary's
 * *Hand-off*: «the twin's sentence naming the counterparty and the reason»).
 * They are the model's final message, never a parameter of the tool, so the
 * caller composes this post after the turn has ended (`drafts.ts`'s
 * `HeldDraft`). Empty words leave out the `prose` part: the card then says
 * who the draft is for in code's own sentence, and the thread's frame names
 * them already.
 *
 * The draft's id is minted by the caller, before the row, because the part
 * names it: an id a part must carry is generated in code rather than by the
 * INSERT's default, and the disclosure below does the same for its post.
 */
export function composeDraftPost(args: {
  readonly draftId: string;
  /**
   * The twin's words, as it wrote them — a customer named by reference — and
   * what each reference names (`Mention`); `""` when it said nothing.
   */
  readonly words: string;
  readonly mentions?: readonly Mention[];
  readonly counterparty: string;
  /** The number's tail, for a customer with more than one chat (`DraftPart.tail`). */
  readonly tail?: string;
  readonly body: string;
  /** The blanks the body marks (ticket #342), when it leaves any. */
  readonly blanks?: readonly DraftBlank[];
  /** Where a fill landed, on a draft that filled another's blank (ticket #342). */
  readonly filled?: DraftFill;
  /** The flag and the reason of a draft that commits the rep (ticket #343). */
  readonly delicacy?: DraftDelicacy;
}): ComposedPost {
  const words = args.words.trim();
  const mentions = args.mentions ?? [];
  return {
    parts: [
      ...(words === "" ? [] : [prosePart(words, mentions)]),
      {
        kind: "draft",
        draftId: args.draftId,
        counterparty: args.counterparty,
        ...(args.tail === undefined ? {} : { tail: args.tail }),
        ...(args.blanks === undefined || args.blanks.length === 0 ? {} : { blanks: args.blanks }),
        ...(args.filled === undefined ? {} : { filled: args.filled }),
        ...(args.delicacy === undefined ? {} : { delicate: true, reason: args.delicacy.reason }),
      },
    ],
    // assertFramed at the emission seam, as it was before this ticket: the
    // frame guarantee is structural at every place a twin post is born.
    text: assertFramed(
      renderDraftPost({
        said: phoneWords(words, mentions),
        counterparty: withTails(args.counterparty, args.tail === undefined ? [] : [args.tail]),
        body: args.body,
      }),
    ),
  };
}

/**
 * THE TWIN'S WORDS AS THE PHONE READS THEM: each reference a mention holds
 * replaced by the name code renders, and one no mention holds left as the
 * twin wrote it. Drafting's words pass no guard (agentic first: no check on
 * what the twin says), so a reference that names nobody is the twin's slip
 * shown as written rather than a post that cannot be born.
 */
function phoneWords(words: string, mentions: readonly Mention[]): string {
  const byReference = new Map(mentions.map((mention) => [mention.reference, mention] as const));
  return replaceReferences(words, (written, reference) => {
    const mention = byReference.get(spellReference(reference));
    return mention === undefined ? written : phoneName(mention);
  });
}

/**
 * THE BINDING QUESTION on its own post (#34, #172): the once-ever
 * «¿Este chat es de …?», asked bare by code or composed by the execution
 * that had the name as a slot.
 */
export function composeBindingQuestionPost(args: {
  readonly aboutEventId: string;
  readonly proposedName: string;
  /**
   * The execution's own sentence with `{name}` where the name goes, when one
   * composed it. Absent where nothing did — the day's read, and drafting's
   * fallback — and then the keyword button's own prompt is what asks
   * (`renderBindingQuestion`).
   */
  readonly sentence?: string;
}): ComposedPost {
  const asked: QuestionPart = {
    kind: "question",
    subject: "binding",
    aboutEventId: args.aboutEventId,
    proposedName: args.proposedName,
  };
  if (args.sentence === undefined) {
    // ASKED BARE, so there is no sentence to carry: the keyword button's own
    // prompt is the whole of it, code-owned chrome a card renders from the
    // proposed name (`renderBindingQuestion`).
    return {
      parts: [asked],
      text: renderBindingQuestion(args.proposedName),
    };
  }
  // COMPOSED, so the twin's own words ride beside the question (Codex r2). A
  // `question` part carries none of its own, and two different questions about
  // one chat would otherwise seal identically — so the sentence would be
  // readable in the thread and gone from every other surface. It is the SAME
  // string the rendering carries, off one function, so the rep cannot be shown
  // two different questions.
  const sentence = bindingQuestionSentence({
    sentence: args.sentence,
    name: args.proposedName,
  });
  return {
    parts: [{ kind: "prose", text: sentence }, asked],
    text: renderComposedBindingQuestion({
      sentence: args.sentence,
      name: args.proposedName,
    }),
  };
}

/**
 * THE THREAD'S ANSWER POST (#174, #195): what the turn's tool did, what the
 * twin says about it, and the question the same post asks when the ceremony
 * was due.
 *
 * THE RECEIPT COMES FIRST AND THE QUESTION LAST, which is the order
 * `renderAnswerPost` prints — so the parts read down the post.
 */
export function composeAnswerPost(args: {
  /** The twin's words, references as it wrote them (ticket #321). */
  readonly answer: string;
  /** What each of those references named, sealed beside the words. */
  readonly mentions: readonly Mention[];
  readonly receipt?: string;
  /**
   * The binding question this post also asks, when the turn handed the rep
   * one and code found it due (#195, #363). Its presence is what makes the
   * post the question; its parts are the binding question's own
   * (`composeBindingQuestionPost`), after the reply.
   */
  readonly binding?: {
    readonly aboutEventId: string;
    readonly proposedName: string;
    readonly sentence: string;
  };
  /**
   * WHAT THE POST HANDS THE REP BESIDE ITS WORDS (ticket #326): a run's list,
   * and the workspace documents the run or the turn left, after the prose —
   * the order the thread prints them in.
   */
  readonly list?: DataPart;
  readonly documents?: readonly DocumentPart[];
}): ComposedPost {
  const question = args.binding === undefined ? undefined : composeBindingQuestionPost(args.binding);
  const parts: PostPart[] = [];
  if (args.receipt !== undefined) {
    parts.push({ kind: "receipt", text: args.receipt });
  }
  parts.push(prosePart(args.answer, args.mentions));
  if (args.list !== undefined) parts.push(args.list);
  parts.push(...(args.documents ?? []));
  // THE PHONE READS NAMES WHERE THE TWIN WROTE REFERENCES (ticket #321): the
  // frame is rendered here, at send time, from the mentions the post seals.
  const said = renderNames(args.answer, args.mentions);
  if (question !== undefined) parts.push(...question.parts);
  return {
    parts,
    // THE THREAD KNOCKS WITH ITS TOOL AND NOWHERE ELSE (ADR-0031 as amended;
    // ticket #363): an answer carries none of its own.
    text: renderAnswerPost({
      answer:
        args.binding === undefined
          ? said
          : `${said}\n\n${bindingQuestionSentence({ sentence: args.binding.sentence, name: args.binding.proposedName })}`,
      ...(args.receipt === undefined ? {} : { receipt: args.receipt }),
      ...(question === undefined ? {} : { asksBinding: true }),
      ...(args.list === undefined ? {} : { list: args.list.rows.map((row) => renderNames(row.text, row.mentions ?? [])) }),
      ...(args.documents === undefined ? {} : { documents: args.documents.map((one) => ({ title: one.title, version: one.version })) }),
    }),
  };
}

/**
 * A list part from the twin's lines (ticket #326): each row its own text,
 * with what its references named sealed beside it, as a prose part's are.
 */
export function listPart(rows: readonly { readonly text: string; readonly mentions: readonly Mention[] }[]): DataPart {
  return {
    kind: "data",
    shape: "list",
    rows: rows.map((row) => (row.mentions.length === 0 ? { text: row.text } : { text: row.text, mentions: row.mentions })),
  };
}

/** A document part naming one workspace version (ticket #326). */
export function documentPart(version: { readonly id: string; readonly title: string; readonly version: number }): DocumentPart {
  return { kind: "document", versionId: version.id, title: version.title, version: version.version };
}

/**
 * A RUN'S QUESTION CARD (ticket #324): the twin's question with its typed
 * answer fields, and the thread rendering they amount to — the question
 * framed, each pick's options numbered under it — the binding question's
 * composition generalised (ADR-0044 as amended).
 *
 * A RUN NEVER KNOCKS (spec #318 decisions 21 and 25): the card lands, and the
 * thread's turn on its landing decides whether the rep's phone hears of it.
 */
export function composeAskPost(args: {
  /** The twin's question, references as it wrote them. */
  readonly question: string;
  readonly mentions: readonly Mention[];
  readonly fields: readonly AskField[];
}): ComposedPost {
  const asked: AskPart = {
    kind: "ask",
    question: args.question,
    ...(args.mentions.length === 0 ? {} : { mentions: args.mentions }),
    fields: args.fields,
  };
  return {
    parts: [asked],
    text: assertFramed(
      renderAskPost({
        question: renderNames(args.question, args.mentions),
        fields: args.fields.map((field) => ({
          ...(field.label === undefined ? {} : { label: field.label }),
          ...(field.options === undefined ? {} : { options: field.options.map((option) => option.label) }),
        })),
      }),
    ),
  };
}

/**
 * A RUTINA THE TWIN PROPOSES, AS A CARD AT BOTH DOORS (ticket #386): the
 * proposal part and its thread rendering — the twin's sentence framed, when
 * it runs, and the plan, in the words code rendered (`runs/rutina-words.ts`).
 * No instruction line: the rep says yes in their own words, and the thread
 * activates it from them (`answer_proposal`).
 */
export function composeProposalPost(args: {
  readonly automationId: string;
  readonly name: string;
  /** The twin's sentence, references as it wrote them. */
  readonly sentence: string;
  readonly mentions: readonly Mention[];
  readonly when: string;
  readonly plan: readonly PlanLine[];
  readonly planHeading: string;
  readonly replaces: boolean;
  /** What the thread says when it replaces a rutina the rep has — the card says it from the copy too. */
  readonly replacesLine: string;
}): ComposedPost {
  const proposed: ProposalPart = {
    kind: "proposal",
    automationId: args.automationId,
    name: args.name,
    sentence: args.sentence,
    ...(args.mentions.length === 0 ? {} : { mentions: args.mentions }),
    when: args.when,
    plan: args.plan,
    replaces: args.replaces,
  };
  return {
    parts: [proposed],
    text: assertFramed(
      renderProposalPost({
        sentence: renderNames(args.sentence, args.mentions),
        when: args.when,
        ...(args.replaces ? { replaces: args.replacesLine } : {}),
        planHeading: args.planHeading,
        plan: args.plan,
      }),
    ),
  };
}

/**
 * A prose part, carrying its mentions only when the text names somebody — a
 * part that names nobody seals its text alone.
 */
export function prosePart(text: string, mentions: readonly Mention[]): ProsePart {
  return mentions.length === 0 ? { kind: "prose", text } : { kind: "prose", text, mentions };
}

/**
 * A RECEIPT WITH NOTHING BESIDE IT — the twin acted, or code did, and there
 * was nothing to say (#174).
 *
 * Every code-composed acknowledgement on the rep side comes here: the send
 * confirmation, the send lock's refusals, a stand-alone dismissal or
 * retraction, the binding ceremony's two answers. The caller passes the
 * SENTENCE — `RECEIPTS`, `REFUSAL_MICROCOPY` or the tool's own
 * `EffectOutcome.receipt` — and the frame is this function's.
 */
export function composeReceiptPost(
  receipt: string,
  beside: { readonly list?: DataPart; readonly documents?: readonly DocumentPart[] } = {},
): ComposedPost {
  return {
    parts: [{ kind: "receipt", text: receipt }, ...(beside.list === undefined ? [] : [beside.list]), ...(beside.documents ?? [])],
    text: renderReceiptPost(receipt, {
      ...(beside.list === undefined ? {} : { list: beside.list.rows.map((row) => renderNames(row.text, row.mentions ?? [])) }),
      ...(beside.documents === undefined ? {} : { documents: beside.documents.map((one) => ({ title: one.title, version: one.version })) }),
    }),
  };
}

/**
 * THE DAY'S POST (#51, #198): the twin's opening, the record's own numbered
 * lines, the twin's closing.
 *
 * THE LINES ARE A REFERENCE AND THE HEADING IS CHROME. The `record-lines`
 * part names the `disclosure_posts` row whose sealed numbering is the record
 * of what the rep saw (ADR-0034), and the count in the heading is arithmetic
 * over the lines this post carries — which is why the renderer is still
 * handed the groups rather than the reference.
 */
export function composeDisclosurePost(args: {
  readonly disclosurePostId: string;
  readonly groups: readonly DisclosurePostGroup[];
  readonly opening: string;
  readonly closing: string;
  readonly now: Date;
  readonly timeZone?: string;
}): ComposedPost {
  return {
    parts: [
      { kind: "prose", text: args.opening },
      {
        kind: "record-lines",
        disclosurePostId: args.disclosurePostId,
        groups: args.groups.map((group) => ({
          counterparty: group.counterparty,
          indexes: group.lines.map((line) => line.index),
        })),
      },
      { kind: "prose", text: args.closing },
    ],
    text: renderDailyDisclosurePost({
      groups: args.groups,
      opening: args.opening,
      closing: args.closing,
      now: args.now,
      ...(args.timeZone === undefined ? {} : { timeZone: args.timeZone }),
    }),
  };
}

/**
 * The parts, sealed under the twin DEK exactly as a notice's own words are
 * (ADR-0008). JSON because the union is data and a part's absent field must
 * stay absent — `JSON.stringify` drops an `undefined` property, which is the
 * behaviour ADR-0034 asks for.
 */
export function sealParts(dek: Dek, parts: readonly PostPart[]): Buffer {
  return Buffer.from(dek.encrypt(Buffer.from(JSON.stringify(parts), "utf8")));
}

/**
 * ...and back, checked. Every field a kind is ABOUT is required here, so a
 * renderer never meets a part it cannot draw: the reachable shape is a
 * database or a bundle restored from a build that knew a part this one does
 * not, and the alternative to a loud throw is a post shown to the rep with a
 * piece silently missing.
 */
export function openSealedParts(
  dek: Dek,
  sealed: Uint8Array,
): readonly PostPart[] {
  const parsed: unknown = JSON.parse(
    Buffer.from(dek.decrypt(sealed)).toString("utf8"),
  );
  if (!Array.isArray(parsed)) {
    throw new Error(
      "a post's sealed parts are not an ordered list — a post is its parts in the order the rep reads them (ticket #220)",
    );
  }
  if (parsed.length === 0) {
    throw new Error(
      "a post with no parts is a post with nothing in it — a sealed payload holding an empty list is a broken record, never an empty post (ticket #220)",
    );
  }
  return parsed.filter((part) => !isRetiredPart(part)).map((part) => parsePart(part));
}

/**
 * A PART A POST'S SEALED PARTS MAY HOLD FROM AN EARLIER BUILD, which no
 * reader takes: a `knock` — its sentence was announced when the post landed,
 * and every knock is a `post_knocks` row (ticket #358) — and a `run`, the
 * line of code-written chrome naming the run that landed a card, which Diego
 * ruled off on 2026-10-13 (ticket #399): a card says where it came from only
 * in the twin's own words, so the part is dropped and the card shows no line.
 */
const RETIRED_PART_KINDS: ReadonlySet<unknown> = new Set(["knock", "run"]);

function isRetiredPart(part: unknown): boolean {
  return part !== null && typeof part === "object" && RETIRED_PART_KINDS.has((part as Record<string, unknown>)["kind"]);
}

function parsePart(value: unknown): PostPart {
  const part = value as Record<string, unknown>;
  const kind = part["kind"];
  switch (kind) {
    case "prose":
      return { kind: "prose", text: required(part, "text"), ...mentionsOf(part) };
    case "draft":
      return {
        kind: "draft",
        draftId: required(part, "draftId"),
        ...optional(part, "counterparty"),
        ...optional(part, "tail"),
        ...blanksOf(part),
        ...filledOf(part),
        ...delicacyOf(part),
      };
    case "record-lines":
      return {
        kind: "record-lines",
        disclosurePostId: required(part, "disclosurePostId"),
        ...groupsOf(part),
      };
    case "question": {
      const subject = required(part, "subject");
      if (!Object.hasOwn(QUESTION_SUBJECTS, subject)) {
        throw new Error(
          `a question part names the subject "${subject}", which is not one of ${Object.keys(QUESTION_SUBJECTS).join(", ")} — a subject names the act its answer performs, and one nothing declares names none (ticket #220)`,
        );
      }
      return {
        kind: "question",
        subject: subject as QuestionSubject,
        aboutEventId: required(part, "aboutEventId"),
        ...optional(part, "proposedName"),
      };
    }
    case "ask":
      return askOf(part);
    case "receipt":
      return { kind: "receipt", text: required(part, "text") };
    case "curation":
      return curationOf(part);
    case "document": {
      const version = part["version"];
      if (!Number.isSafeInteger(version) || (version as number) < 1) {
        throw new Error("a document part names no version — a card says which version it opens (ticket #326)");
      }
      return {
        kind: "document",
        versionId: required(part, "versionId"),
        title: required(part, "title"),
        version: version as number,
      };
    }
    case "data":
      return dataOf(part);
    case "proposal":
      return proposalOf(part);
    default:
      throw new Error(
        `a post carries the part kind ${JSON.stringify(kind)}, which is not one of ${PART_KINDS.join(", ")} — a surface that met one would draw nothing or draw an object (ticket #220)`,
      );
  }
}

/**
 * A draft part's blanks, checked (ticket #342): each a key, a label and a
 * question, all strings — a card draws all three, so one missing is a broken
 * record rather than a capsule with nothing in it.
 */
function blanksOf(part: Record<string, unknown>): { readonly blanks?: readonly DraftBlank[] } {
  const blanks = part["blanks"];
  if (blanks === undefined) return {};
  if (
    !Array.isArray(blanks) ||
    blanks.some(
      (one: unknown) =>
        one === null ||
        typeof one !== "object" ||
        ["key", "label", "question"].some(
          (field) => typeof (one as Record<string, unknown>)[field] !== "string",
        ),
    )
  ) {
    throw new Error(
      "a draft part's `blanks` is not a list of key, label and question — a card draws each blank from all three (ticket #342)",
    );
  }
  return {
    blanks: (blanks as Record<string, string>[]).map((one) => ({
      key: one["key"]!,
      label: one["label"]!,
      question: one["question"]!,
    })),
  };
}

/** A draft part's fill, checked (ticket #342): the draft it superseded, the key, and the span. */
function filledOf(part: Record<string, unknown>): { readonly filled?: DraftFill } {
  const filled = part["filled"];
  if (filled === undefined) return {};
  const one = filled as Record<string, unknown>;
  if (
    filled === null ||
    typeof filled !== "object" ||
    typeof one["draftId"] !== "string" ||
    typeof one["key"] !== "string" ||
    !Number.isSafeInteger(one["start"]) ||
    !Number.isSafeInteger(one["end"])
  ) {
    throw new Error(
      "a draft part's `filled` is not a draft id, a key and a span — a card stands it in the superseded one's place by them (ticket #342)",
    );
  }
  return {
    filled: {
      draftId: one["draftId"] as string,
      key: one["key"] as string,
      start: one["start"] as number,
      end: one["end"] as number,
    },
  };
}

/**
 * A draft part's flag and reason, checked (ticket #343): both or neither, the
 * flag `true` and the reason text — a pill raising a reason for a draft that
 * is not delicate, or a delicate one with nothing to say, is a broken record.
 */
function delicacyOf(part: Record<string, unknown>): { readonly delicate?: true; readonly reason?: string } {
  const delicate = part["delicate"];
  const reason = part["reason"];
  if (delicate === undefined && reason === undefined) return {};
  if (delicate !== true || typeof reason !== "string") {
    throw new Error(
      "a draft part's `delicate` and `reason` do not pair — a delicate draft carries its reason, and a plain one neither (ticket #343)",
    );
  }
  return { delicate: true, reason };
}

/**
 * A curation part, checked: an order of post ids, and a spotlight that is one
 * of them.
 *
 * REFUSED RATHER THAN COERCED, like every other field a part's kind is about:
 * the tool's guard already refused a spotlight outside the order, so a
 * sealed part that has one is a broken record rather than a layout.
 */
function curationOf(part: Record<string, unknown>): CurationPart {
  const order = part["order"];
  if (
    !Array.isArray(order) ||
    order.some((id) => typeof id !== "string" || id === "")
  ) {
    throw new Error(
      "a curation part's `order` is not a list of post ids — the order is the layout the canvas draws (ticket #266)",
    );
  }
  const spotlight = part["spotlight"];
  if (spotlight === undefined) return { kind: "curation", order: order as string[] };
  if (typeof spotlight !== "string" || !order.includes(spotlight)) {
    throw new Error(
      "a curation part's spotlight is not one of the posts it orders — the spotlight is the first card of the order (ticket #266)",
    );
  }
  return { kind: "curation", spotlight, order: order as string[] };
}

/**
 * A data part, checked (ticket #326): a list, with a row's text and its
 * mentions each refused rather than coerced — a row with no text is a line
 * the card would draw empty.
 */
function dataOf(part: Record<string, unknown>): DataPart {
  if (part["shape"] !== "list") {
    throw new Error(`a data part's shape ${JSON.stringify(part["shape"])} is not \`list\` — tables and charts stay on the horizon (ticket #326)`);
  }
  const rows = part["rows"];
  if (!Array.isArray(rows)) throw new Error("a data part's `rows` is not a list (ticket #326)");
  return {
    kind: "data",
    shape: "list",
    rows: rows.map((value): DataRow => {
      const row = value as Record<string, unknown>;
      return { text: required({ ...row, kind: "data row" }, "text"), ...mentionsOf(row) };
    }),
  };
}

/**
 * An ask part, checked (ticket #324): the question, and every field with a
 * name, a kind this build knows and, on a pick, options each with a value and
 * a label — refused rather than coerced, since a card with a field it cannot
 * draw is a question the rep cannot answer.
 */
function askOf(part: Record<string, unknown>): AskPart {
  const fields = part["fields"];
  if (!Array.isArray(fields) || fields.length === 0) {
    throw new Error("an ask part carries no answer fields — a question card is its typed fields (ticket #324)");
  }
  return {
    kind: "ask",
    question: required(part, "question"),
    ...mentionsOf(part),
    fields: fields.map((value): AskField => {
      const field = value as Record<string, unknown>;
      const kind = field["kind"];
      if (typeof kind !== "string" || !(ASK_FIELD_KINDS as readonly string[]).includes(kind)) {
        throw new Error(`an ask field's kind ${JSON.stringify(kind)} is not one of ${ASK_FIELD_KINDS.join(", ")} (ticket #324)`);
      }
      const options = field["options"];
      if (options !== undefined && !Array.isArray(options)) {
        throw new Error("an ask field's `options` is not a list (ticket #324)");
      }
      return {
        name: required({ ...field, kind: "ask field" }, "name"),
        kind: kind as AskFieldKind,
        ...optional(field, "label"),
        ...(options === undefined
          ? {}
          : {
              options: (options as unknown[]).map((option) => {
                const given = option as Record<string, unknown>;
                return {
                  value: required({ ...given, kind: "ask option" }, "value"),
                  label: required({ ...given, kind: "ask option" }, "label"),
                };
              }),
            }),
      };
    }),
  };
}

/**
 * A proposal part, checked (ticket #386): the rutina it names, its words and
 * a plan of at least one line — refused rather than coerced, since a card
 * that cannot say what it would do is a proposal the rep cannot accept.
 */
function proposalOf(part: Record<string, unknown>): ProposalPart {
  const plan = part["plan"];
  if (!Array.isArray(plan) || plan.length === 0) {
    throw new Error("a proposal part carries no plan — the rep accepts what the rutina would do (ticket #386)");
  }
  const replaces = part["replaces"];
  return {
    kind: "proposal",
    automationId: required(part, "automationId"),
    name: required(part, "name"),
    sentence: required(part, "sentence"),
    ...mentionsOf(part),
    when: required(part, "when"),
    plan: plan.map((value): PlanLine => {
      const line = value as Record<string, unknown>;
      const depth = line["depth"];
      if (!Number.isSafeInteger(depth) || (depth as number) < 0) {
        throw new Error("a plan line names no depth (ticket #386)");
      }
      return { text: required({ ...line, kind: "plan line" }, "text"), depth: depth as number };
    }),
    replaces: replaces === true,
  };
}

/**
 * A prose part's mentions, checked (ticket #321): each a reference and a
 * name, refused rather than coerced like every other field a part is about —
 * a mention with no name is a reference a surface would print bare.
 */
function mentionsOf(part: Record<string, unknown>): { readonly mentions?: readonly Mention[] } {
  const given = part["mentions"];
  if (given === undefined) return {};
  if (!Array.isArray(given)) {
    throw new Error("a prose part's `mentions` is not a list (ticket #321)");
  }
  const mentions = given.map((value): Mention => {
    const mention = value as Record<string, unknown>;
    const tails = mention["tails"];
    if (
      tails !== undefined &&
      (!Array.isArray(tails) || tails.some((tail) => typeof tail !== "string"))
    ) {
      throw new Error("a mention's `tails` is not a list of digits (ticket #321)");
    }
    return {
      reference: required({ ...mention, kind: "mention" }, "reference"),
      name: required({ ...mention, kind: "mention" }, "name"),
      ...(tails === undefined ? {} : { tails: tails as string[] }),
      ...optional(mention, "entityId"),
    };
  });
  return { mentions };
}

function required(part: Record<string, unknown>, field: string): string {
  const value = part[field];
  if (typeof value !== "string" || value === "") {
    throw new Error(
      `a ${String(part["kind"])} part carries no \`${field}\` — every field a part's kind is ABOUT is what a surface renders it from (ticket #220)`,
    );
  }
  return value;
}

/**
 * The counterparty headings a record-lines part carries, when it carries any.
 *
 * REFUSED RATHER THAN COERCED, like every other field a part's kind is about:
 * a group with no name or no numbers would attribute a retractable claim to
 * nothing, which is worse than attributing it to nobody.
 */
function groupsOf(
  part: Record<string, unknown>,
): { groups?: readonly RecordLineGroup[] } {
  const groups = part["groups"];
  if (groups === undefined) return {};
  if (!Array.isArray(groups)) {
    throw new Error(
      "a record-lines part's `groups` is not a list of counterparty headings — the grouping is what the post printed (ticket #220)",
    );
  }
  return {
    groups: groups.map((entry) => {
      const group = entry as Record<string, unknown>;
      const indexes = group["indexes"];
      if (
        !Array.isArray(indexes) ||
        indexes.length === 0 ||
        !indexes.every((index) => Number.isInteger(index))
      ) {
        throw new Error(
          "a record-lines group names no line numbers — a heading with nothing under it is not one the post printed (ticket #220)",
        );
      }
      return {
        counterparty: required(group, "counterparty"),
        indexes: indexes as readonly number[],
      };
    }),
  };
}

/**
 * A field that may honestly be missing: absent stays absent rather than
 * becoming an explicit `undefined` a renderer would print (ADR-0034 — an
 * absent field is NOT RECORDED THEN, never a default).
 */
function optional(
  part: Record<string, unknown>,
  field: string,
): Record<string, string> {
  const value = part[field];
  return typeof value === "string" && value !== "" ? { [field]: value } : {};
}

/**
 * WHAT A DELIVERY ROW WRITTEN BEFORE PARTS EXISTED CAN SAY ABOUT ITSELF
 * (…20260907100030 section 3).
 *
 * `frozenText` is the thread rendering that row froze, opened — absent for a
 * slice-1 draft with no `post_enc` (…20260827100018), which is why it is
 * optional rather than required.
 */
export interface ReexpressedDelivery {
  /** Named in every refusal, so a broken row can be found. */
  readonly postId: string;
  readonly draftId: string | null;
  readonly noticeKind: string | null;
  readonly aboutEventId: string | null;
  /** The `disclosure_posts` row the notice carried, when it carried one. */
  readonly disclosurePostId: string | null;
  readonly frozenText?: string;
}

/**
 * THE PARTS OF A POST THAT PREDATES THEM (…20260907100030 section 3).
 *
 * The migration re-expressed every notice and every draft as a post and
 * sealed nothing, because SQL holds no key. So the parts are derived from the
 * delivery row's own kind, and every field nothing recorded is ABSENT
 * (ADR-0034 — an absent field is NOT RECORDED THEN, never a default): such a
 * draft post has no counterparty, because it was rendered into `post_enc` and
 * stored nowhere a reader can name.
 *
 * THE FROZEN RENDERING IS CARRIED WHEREVER NO TYPED PART ALREADY HOLDS THAT
 * CONTENT, which is the rule the five arms follow. A draft's body and the day's
 * numbered lines ARE the content and come off their own rows, so the frozen
 * post would add only chrome; a `question` part carries no words at all, so
 * the ask has to; an answer and an acknowledgement are nothing but their
 * words. Reading a part OUT of a rendering is the one direction in this module
 * that runs backwards, and it reaches only rows written before parts existed.
 * What the rep read is still exactly the frozen bytes: nothing re-renders a
 * post for the thread.
 *
 * A DELIVERY ROW THAT CANNOT BE CLASSIFIED FALLS BACK TO PROSE rather than
 * throwing, and that direction is deliberate: a feed is what the rep opens
 * when something is waiting on them, and one post the runtime cannot classify
 * must not take the page down. The frozen text is what they read, so showing
 * it says nothing untrue.
 *
 * IT LIVES HERE, beside the composers, because this module is the ONE place a
 * part is built. A second builder somewhere else would be a second answer to
 * "what is a post made of".
 */
export function reexpressedParts(
  delivery: ReexpressedDelivery,
): readonly PostPart[] {
  if (delivery.draftId !== null) {
    return [{ kind: "draft", draftId: delivery.draftId }];
  }
  if (
    delivery.noticeKind === "daily_disclosure" &&
    delivery.disclosurePostId !== null
  ) {
    return [
      { kind: "record-lines", disclosurePostId: delivery.disclosurePostId },
    ];
  }
  if (
    delivery.noticeKind === "binding_question" &&
    delivery.aboutEventId !== null
  ) {
    // ITS WORDS COME FIRST, and they have to (Codex r1). A `question` part
    // carries no text of its own — the ask is composed prose on a post this
    // build writes, and code-owned chrome on a card that renders the
    // subject — so a re-expressed question with nothing beside it would offer
    // the rep confirm and decline over a blank card. That is the binding, one
    // of the two acts a wrong yes cannot take back (ADR-0037), so the words
    // the rep actually read are what the buttons sit under. That frozen text
    // can be a whole answer with a receipt folded into it (#195), and all of
    // it survives here.
    const asked = {
      kind: "question" as const,
      subject: "binding" as const,
      aboutEventId: delivery.aboutEventId,
    };
    // ...WITHOUT THE INSTRUCTION LINE, which is the one paragraph of that
    // frozen text a card may not print (#224, Codex r3 — a reachable
    // failure). The thread rendering ends by telling the rep to reply quoting
    // the message with the word; the dashboard offers two BUTTONS for the
    // same act, so the sentence is false the moment it is read there, and
    // ADR-0037 retires the instruction line on this surface outright. It is
    // recognized by asking the renderer rather than by matching a literal
    // (`isBindingAnswersLine`), so a post frozen by a build that taught a
    // different word loses it too.
    const said = withoutAnswersLine(unframed(frozenTextOf(delivery)));
    // A QUESTION WITH NOTHING LEFT TO SAY IS THE QUESTION ALONE. An empty
    // prose part would be a blank line above the buttons; the card renders
    // its own chrome from the subject when no words ride beside it.
    return said === "" ? [asked] : [{ kind: "prose", text: said }, asked];
  }
  return [
    {
      kind: reexpressedTextPart(delivery.noticeKind),
      text: unframed(frozenTextOf(delivery)),
    },
  ];
}

/**
 * The frozen text with every trailing instruction paragraph dropped.
 *
 * TRAILING, AND MORE THAN ONE, because a re-expressed question can be a whole
 * answer post with a receipt folded into it (#195) — the ask is assembled
 * last, so the instruction is the tail. Paragraphs before it are what the twin
 * SAID, and they all survive: this drops chrome and never content.
 */
function withoutAnswersLine(text: string): string {
  const paragraphs = text.split("\n\n");
  while (
    paragraphs.length > 0 &&
    isBindingAnswersLine(paragraphs[paragraphs.length - 1] ?? "")
  ) {
    paragraphs.pop();
  }
  return paragraphs.join("\n\n").trim();
}

/**
 * WHAT A NOTICE KIND'S OWN WORDS BECOME when a post is re-expressed from it
 * and no typed part already carries that content.
 *
 * TOTAL OVER `NoticeKind`, so a kind added without classifying it fails the
 * typecheck. The two that are handled above by their own typed parts are here
 * for that totality and nothing else.
 *
 * A RECEIPT IS AN ACKNOWLEDGEMENT OF SOMETHING CODE DID (ADR-0013, ADR-0037),
 * so only the kinds that ARE one may become one. Everything else is words the
 * rep read, and `prose` says exactly that and claims nothing.
 */
const REEXPRESSED_TEXT_PARTS: Readonly<
  Record<NoticeKind, "prose" | "receipt">
> = {
  send_confirmation: "receipt",
  affirmation_refusal: "receipt",
  dismissal_ack: "receipt",
  binding_ack: "receipt",
  correction_ack: "receipt",
  correction_refusal: "receipt",
  // The twin SPOKE here, and it is the one kind whose whole content is its own
  // voice rather than a report of an effect.
  answer: "prose",
  // Handled above, by `record-lines` and by `prose` + `question`.
  daily_disclosure: "prose",
  binding_question: "prose",
  // Born with its typed part (ticket #324): no row before parts carries it.
  ask: "prose",
  // ...and the same of a rutina's proposal card (ticket #386).
  proposal: "prose",
};

/**
 * ...and a kind THIS BUILD DOES NOT KNOW becomes prose (Codex r3).
 *
 * A RETIRED KIND'S POSTS RIDE FORWARD. #218 narrowed `notices_kind_check`
 * `NOT VALID` precisely so that the `aperture_question` notices a rep had
 * already read would keep their rows (ADR-0034), and this migration imports
 * every notice — so those posts reach here, and a model-composed ask
 * classified as a `receipt` would be a card telling the rep that code
 * performed an effect it never performed. Prose is the fail-safe reading for
 * any kind a future build retires the same way: it is what the rep read, and
 * it asserts nothing.
 */
function reexpressedTextPart(kind: string | null): "prose" | "receipt" {
  if (kind === null || !Object.hasOwn(REEXPRESSED_TEXT_PARTS, kind)) {
    return "prose";
  }
  return REEXPRESSED_TEXT_PARTS[kind as NoticeKind];
}

function frozenTextOf(delivery: ReexpressedDelivery): string {
  if (delivery.frozenText === undefined) {
    throw new Error(
      `post ${delivery.postId} names a delivery row with no words in it — a post re-expressed from a notice or a draft is read back through that row's own frozen rendering (ticket #220)`,
    );
  }
  return delivery.frozenText;
}

/**
 * RE-EXPRESSES A TWIN POST THAT REACHED THE SEAM WITHOUT ONE (ticket #220).
 * Returns how many it found.
 *
 * THE WINDOW THE DOCUMENTED UPGRADE ORDER OPENS. `README.md` brings a rig to a
 * new slice tip by migrating and THEN restarting the three processes, so
 * between …20260907100030 finishing and the new runtime coming up, the OLD
 * runtime is still polling — and every notice and draft it writes in that gap
 * gets no post. Nothing else would ever notice: the delivery row is valid, its
 * `system_send` goes out, the event's marker is written, so no pass replays it
 * and no invariant reads it. The post would simply never appear on the rep's
 * Inicio, silently and permanently.
 *
 * SO THE SAME RULE RUNS TWICE, and this is the second run: the migration
 * re-expresses HISTORY at migrate time, and this closes the gap at every
 * start. Both are the migration's section 3, which argues the rule in full;
 * both are idempotent against the delivery row's own unique constraint, so a
 * start that finds nothing writes nothing. It is `crossPendingBindings`'
 * shape and its reason — a build that wakes with seam rows a previous build
 * left behind sweeps them once, from evidence that is still there, before the
 * loop starts writing anything new.
 *
 * IT SEALS NOTHING, exactly as the migration cannot: a post whose parts nobody
 * recorded is `reexpressed`, and `reexpressedParts` derives them from the
 * delivery row's own kind.
 */
export async function reexpressStrayPosts(deps: {
  readonly db: pg.ClientBase;
  readonly twinId: string;
}): Promise<number> {
  const notices = await deps.db.query(
    `INSERT INTO posts (twin_id, execution_id, origin, question_subject, notice_id, posted_at)
     SELECT n.twin_id, n.execution_id, 'reexpressed',
            CASE WHEN n.kind = 'binding_question' THEN 'binding' END,
            n.id, n.created_at
       FROM notices n
      WHERE n.twin_id = $1
     ON CONFLICT (notice_id) DO NOTHING`,
    [deps.twinId],
  );
  const drafts = await deps.db.query(
    `INSERT INTO posts (twin_id, execution_id, origin, draft_id, posted_at)
     SELECT d.twin_id, dt.execution_id, 'reexpressed', d.id, d.created_at
       FROM drafts d
       LEFT JOIN draft_timings dt ON dt.draft_id = d.id
      WHERE d.twin_id = $1
     ON CONFLICT (draft_id) DO NOTHING`,
    [deps.twinId],
  );
  return (notices.rowCount ?? 0) + (drafts.rowCount ?? 0);
}

/** The row this post was delivered by — the one the executor dereferences. */
export type PostDelivery =
  | { readonly noticeId: string }
  | { readonly draftId: string };

/**
 * WHICH DOOR ASKED FOR A POST (ticket #261; spec #258 decision 2; ADR-0044 as
 * amended — "an answer goes where it was asked").
 *
 * SET ON AN ANSWER, AND ON A RECEIPT THAT IS THE WHOLE OF ONE. A draft, a
 * question and the day's record are PROACTIVE: the twin cannot know where the rep is, so they go to
 * both surfaces and carry no door at all. An answer carries the one it was
 * asked through, and that decides its delivery — the thread's answer mints
 * its `system_send` and Inicio leaves it off; the door's is posted at the door
 * and mints nothing. A receipt goes to both surfaces too, and when it is the
 * whole of the reply to a line typed in the bar it carries that line, so the
 * day's thread shows it as the reply (ticket #358; `postReceipt`).
 *
 * THE DASHBOARD'S ARM CARRIES THE MESSAGE, because the pair is what the door
 * renders: an exchange is a message and the reply to it, joined on this id
 * (`readExchanges`). The thread's arm carries none — the notice's own
 * `about_event_id` is that join on that side, and a second copy of it here
 * would be a second answer to «which message is this about».
 */
export type AskedAt =
  | { readonly door: "twin_thread" }
  | { readonly door: "dashboard"; readonly messageId: string }
  /**
   * THE LINE FOR AN ARRIVAL (ticket #266; ADR-0044 as amended). Nobody asked
   * a question: the rep arrived at the dashboard's door, and the line is
   * delivered there and nowhere else — no notice, no draft
   * (`posts_arrival_door_only_check`) and no knock (`post-knocks.ts`). It names the arrival as the answer
   * names its message, and that is what makes it the arrival post.
   */
  | { readonly door: "dashboard"; readonly arrivalId: string }
  /**
   * THE UNASKED LINE (ticket #320; design D4): what a turn the seam's events
   * woke said, delivered to the dashboard's door and nowhere else — the
   * arrival line's kind with no arrival to name (`posts_unasked_door_only_check`).
   *
   * `onPostId` NAMES THE CARD IT WAS SAID ON (ticket #340; `say_on_card`):
   * the canvas draws it under that card's text, and the day's thread keeps it
   * as one of the twin's own lines like any other unasked line.
   */
  | { readonly door: "dashboard"; readonly unasked: true; readonly onPostId?: string };

/**
 * WRITES THE POST ROW, inside the caller's open transaction (the notice
 * seam's own rule).
 *
 * It is called where a twin post is born and nowhere else — the notice seam,
 * the draft emission, the door's answers and lines (`answering.ts`,
 * `consumer.ts`) and the sentence said on a card (`say_on_card`) — so a post
 * and the row that delivers it commit together or neither does, and the sealed parts, the
 * question's subject column, the delivery reference and the door that asked are
 * written by one statement that cannot disagree with itself.
 *
 * IT HANDS BACK THE POST'S ID, which is the FEED's handle and the one a tool
 * names a card by: the thread's `create_draft` tells the twin which post to
 * knock on (ticket #358).
 */
export async function insertPost(
  client: pg.ClientBase,
  args: {
    /**
     * The post's id, where a tool named it before the row (`HeldDraft.postId`);
     * absent, the column's default chooses it.
     */
    readonly id?: string;
    readonly twinId: string;
    readonly dek: Dek;
    readonly parts: readonly PostPart[];
    /** The execution that composed it, when one did (`posts.execution_id`). */
    readonly executionId?: string;
    /**
     * The row that delivers it — ABSENT EXACTLY FOR A POST DELIVERED TO THE
     * DASHBOARD'S DOOR (ticket #261).
     *
     * `notices` is the THREAD's rendering record: the row whose
     * `notice:<uuid>` the plane's executor dereferences and posts (ADR-0006),
     * holding the frozen bytes the rep read. A door answer is rendered by the
     * dashboard from its own parts and is never sent anywhere, so there is no
     * such row to name — and inventing one would put a framed thread rendering
     * in the outbox for a message the thread must not receive.
     */
    readonly delivery?: PostDelivery;
    /** Which door asked for it; absent on a proactive post. */
    readonly asked?: AskedAt;
    /**
     * The rep's zone, which a card that can lapse has its reminder shifted out
     * of quiet hours in (`runs/reminders.ts`). Unset means the host clock, as
     * every other unset zone in this runtime does.
     */
    readonly timeZone?: string;
  },
): Promise<string> {
  if (args.parts.length === 0) {
    throw new Error(
      "refusing to write a post with no parts — a post IS its parts (ticket #220)",
    );
  }
  const door = args.asked?.door;
  // THE STORE'S OWN `posts_delivery_or_door_check`, REFUSED HERE FIRST so the
  // sentence names the ticket rather than the constraint. A post with no
  // delivery row that was not asked at the door is one nothing renders and
  // nothing sends (ticket #261).
  if (args.delivery === undefined && door !== "dashboard") {
    throw new Error(
      "refusing to write a post with neither a delivery row nor a door — only an answer to a dashboard message is delivered by nothing (ticket #261)",
    );
  }
  const asked = args.asked;
  const inserted = await client.query<{ id: string; posted_at: Date }>(
    `INSERT INTO posts
       (id, twin_id, execution_id, origin, parts_enc, question_subject, notice_id,
        draft_id, asked_on, asked_message_id, arrival_id, unasked, on_post_id)
     VALUES (COALESCE($12::uuid, gen_random_uuid()), $1, $2, 'composed', $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING id, posted_at`,
    [
      args.twinId,
      args.executionId ?? null,
      sealParts(args.dek, args.parts),
      questionSubjectOf(args.parts),
      args.delivery !== undefined && "noticeId" in args.delivery
        ? args.delivery.noticeId
        : null,
      args.delivery !== undefined && "draftId" in args.delivery
        ? args.delivery.draftId
        : null,
      door ?? null,
      asked !== undefined && "messageId" in asked ? asked.messageId : null,
      asked !== undefined && "arrivalId" in asked ? asked.arrivalId : null,
      asked !== undefined && "unasked" in asked,
      asked !== undefined && "unasked" in asked ? (asked.onPostId ?? null) : null,
      args.id ?? null,
    ],
  );
  // A CARD THAT CAN LAPSE IS BORN WITH ITS REMINDER (ticket #364): the
  // one-shot row the clock fires to wake the thread, written with the card.
  const row = inserted.rows[0]!;
  await scheduleReminder(client, {
    twinId: args.twinId,
    postId: row.id,
    parts: args.parts,
    postedAt: row.posted_at,
    timeZone: args.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
  return row.id;
}

/**
 * The subject of the one question this post asks, as the column holds it —
 * `null` for a post that asks nothing.
 *
 * ONE QUESTION PER POST, refused here rather than described. The column holds
 * one subject because a post asks the rep one thing: two questions in one
 * message is two answers the rep cannot give with one act, and the store
 * could name only one of them. Suspension and a second ask are on the horizon
 * (spec #214 decision 2), and they arrive as another post.
 */
function questionSubjectOf(parts: readonly PostPart[]): string | null {
  const asked = parts.filter((part) => part.kind === "question");
  if (asked.length > 1) {
    throw new Error(
      `refusing to write a post asking ${String(asked.length)} questions — a post asks the rep one thing, because one act answers it (ticket #220)`,
    );
  }
  return asked[0]?.subject ?? null;
}
