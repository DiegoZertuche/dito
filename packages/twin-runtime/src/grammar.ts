/**
 * The twin-thread grammar (ticket #30; spec #29 grilling decision 4): the
 * ONE rendering point for every twin-authored post. Every post opens with
 * the ✳️ sigil and frame — drafts as Mock A, companions («Enviado…»,
 * refusals, «Descartado») as one voice — so the rep can tell the twin's
 * posts from their own notes at a glance in a self-chat where everything
 * renders "from you".
 *
 * All rendering happens here in the twin: the plane stays dumb (ADR-0005)
 * and posts what the stored row says. WhatsApp's own *bold* markers are
 * plain message text — no custom rendering (ADR-0021 surface doctrine).
 * `counterpartyName` uses the confirmed binding, or marks the sender
 * push-name (falling back to the number) as provisional (#34).
 *
 * WHAT IS STILL A CONSTANT HERE, AND WHY (ticket #172; ADR-0037 as
 * amended). *Frame labels* — the sigil, «Borrador — para»,
 * «(sin confirmar)», the disclosure's heading and its
 * numbered-line frame — and *receipts* — «Descartado», «Listo, marqué el dato
 * N…», the send lock's refusals — are the rep side's chrome and stay in code:
 * a receipt reports what code DID, and composing one would let a model
 * describe an effect it never performed. The two ACTION-TEACHING lines
 * stopped being constants at #172: they are a button's label, so they render
 * from the keyword sets `affirmation.ts` holds, and a word re-taught there
 * changes the line with no edit here.
 *
 * *RECORD LINES* are the third class, and the argument for them is neither
 * of those (spec #193 decision 8; ADR-0037's 2026-09-05 amendment as
 * corrected). The fact sentences, the «Dijiste: «…»» quote, the «sin
 * cantidad» clauses, the contact line and the entity-create line are rendered
 * by code at filing because a line must show every correctable field or the
 * correction window cannot catch a wrong value (#65); because the verb IS the
 * fact type, and a model that wrote «Le cotizaste» over an `OrderRequested`
 * would hand the rep a true-sounding sentence about a different claim; and
 * because silence is a yes on a disclosure line, so a composed line would
 * hide its own errors.
 *
 * EVERY SENTENCE AROUND THEM IS COMPOSED. The drafting execution composes its
 * own binding question (`renderComposedBindingQuestion`), the thread composes
 * its own into the answer that carries it (#195), and the disclosure
 * execution composes the day's opening and closing (#198, narrowed at #218
 * when the question part left the call) — so no post on the rep side is
 * a fixed sentence any more. The pinned allowlist records what code still
 * owns and on what grounds.
 */
import type { CandidateReading, NormalizedFact } from "@dito/aperture";
import { AFFIRMATIONS } from "./affirmation.js";
import {
  CORRECTION_REFUSAL_MICROCOPY,
  REFUSAL_MICROCOPY,
  type CorrectionRefusalReason,
} from "./microcopy.js";
import type { MatcherRefusalReason } from "./matcher.js";

/** The sigil opening every twin-authored post (grilling decision 4). */
const SIGIL = "✳️ ";

/**
 * Teach the send keyword from the accepted set (#172, #174). The keyword
 * substitutes for a missing button (spec #58's ruling); its label must not
 * teach a word the matcher refuses. Dismissal is prose the twin answers,
 * so only the send act needs a taught word.
 *
 * `AFFIRMATIONS.proposal` owns that word; the surrounding frame label is
 * code-owned chrome (ADR-0037 as amended; #176's allowlist).
 * `grammar.test.ts` checks that changing the set changes the label.
 */
function draftInstructionLine(): string {
  return `Para enviarlo, responde a este mensaje citándolo con «${taught(AFFIRMATIONS.proposal, "affirm a proposal")}».`;
}

/**
 * Teach only the binding question's accepted yes (#49, #172, #174): a
 * wrong confirmation cannot be taken back. Declining is prose handled by
 * `decline_binding`.
 *
 * IT IS THE ONLY TAUGHT LINE ON THIS SIDE (#174, #198, ticket #218). What it
 * teaches is the one act a wrong yes cannot take back — the chat↔entity
 * binding — and the candidate-question route that had the other taught line
 * is retired: the twin does not ask the rep to settle a candidate it was
 * unsure of.
 */
function bindingAnswersLine(word?: string): string {
  return `Para confirmarlo, responde a este mensaje citándolo con «${word ?? taught(AFFIRMATIONS.question, "affirm a question")}».`;
}

/**
 * WHETHER A PARAGRAPH IS THAT INSTRUCTION (#224, Codex r3 — a reachable
 * failure).
 *
 * A post the …20260907100030 migration re-expressed carries no sealed parts,
 * so the feed derives them from the delivery's own frozen text — and for a
 * binding question that text is the whole thread rendering, instruction line
 * included. The dashboard offers two BUTTONS for that act, so printing «reply
 * quoting this message with the word» there is a sentence that is false the
 * moment it is read, and ADR-0037 retires the instruction line on this
 * surface outright. `reexpressedParts` drops the paragraph; this is how it
 * knows one.
 *
 * IT ASKS THE RENDERER RATHER THAN RESTATING IT. The predicate is the
 * instruction's own prefix, taken by rendering the line around a sentinel and
 * keeping what precedes it — so the taught word plays no part, and a post
 * frozen by a build that taught a DIFFERENT word is still recognized. A
 * restated literal here would be the second copy of a sentence, which is the
 * shape this file exists to avoid.
 */
export function isBindingAnswersLine(paragraph: string): boolean {
  const sentinel = "\u0000";
  const prefix = bindingAnswersLine(sentinel).split(sentinel)[0] ?? "";
  return prefix !== "" && paragraph.trimStart().startsWith(prefix);
}

/**
 * The word a verb class TEACHES: the first of its accepted set.
 *
 * AN EMPTY SET IS REFUSED rather than rendered as «undefined». `statement`
 * has no accepted word on purpose — silence accepts a report, and a bare
 * word on a post carrying five numbered lines names none of them — so a
 * caller that asked for a statement's label would be asking for a button
 * that does not exist. Nothing does; the throw is what keeps that true.
 */
function taught(words: readonly string[], what: string): string {
  const first = words[0];
  if (first === undefined) {
    throw new Error(
      `no accepted word to teach for "${what}" — this verb class accepts none, and a line teaching one would name a keyword the matcher refuses (ticket #172)`,
    );
  }
  return first;
}

/**
 * The raw rail name for the Mock A «para …» slot: sender push-name, or the
 * bare number — honest and unambiguous over friendly and wrong. Binding
 * resolution and «(sin confirmar)» marking belong to `counterpartyName`
 * (#34; spec #29 decision 3). The spec calls the slot {cliente}; surface
 * words stay out of identifiers per CONTEXT.md.
 */
export function counterpartyDisplayName(
  pushName: string | undefined,
  chatJid: string,
): string {
  if (pushName !== undefined && pushName !== "") return pushName;
  return chatJid.split("@")[0] ?? chatJid;
}

/**
 * Compare text as the rep reads it (#173, #175): WhatsApp formatting,
 * invisible characters and whitespace must not disguise a served name,
 * nor let two names the rep reads as one compare as different (Codex round 3).
 * `guard.ts` and `chats.ts` share this renderer-level rule so they agree
 * about the same visible bytes.
 *
 * `Default_Ignorable_Code_Point` BESIDE `Cf` (#198, Codex r2), because `Cf`
 * was not the whole of "invisible": a VARIATION SELECTOR (U+FE0F) and a
 * COMBINING GRAPHEME JOINER (U+034F) are `Mn`, and «To\uFE0Frres» renders as
 * «Torres» to the rep while comparing as a different string — a served name
 * typed past the guard. Unicode's own property for "occupies no width" is the
 * honest test, and it folds the same way on both sides of every comparison,
 * so what it can only do is make two strings the rep reads as one compare as
 * one. Every caller wants that direction: a name guard that misses is the
 * failure, a name guard that matches is the rule.
 *
 * NFKC FIRST (#198, Codex r3), and it is the same argument one level up: a
 * COMPATIBILITY spelling renders as the letters it stands for and compares as
 * something else. «Ｔｏｒｒｅｓ» in fullwidth forms and «𝑻𝒐𝒓𝒓𝒆𝒔» in
 * mathematical bold italic are both the served name on the page, and the
 * matcher's own NFD folds accents rather than these. Compatibility
 * normalization is what folds them, it runs on both sides of every
 * comparison, and it never touches what is STORED or rendered — this function
 * is only ever asked what two strings amount to.
 */
export function asRepReads(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[*_~`]/gu, "")
    .replace(/[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, "")
    .replace(/\s+/gu, " ");
}

/**
 * The provisional marker an unconfirmed counterparty wears (grilling decision
 * 3).
 *
 * EXPORTED SINCE #173, and for the reason the guard's own header gives: the
 * thread's guard refuses a model that types a name the record holds, and it
 * has to compare NAMES rather than renderings — so it takes the mark off a
 * served hit's rendered counterparty first. Reading the mark from here is
 * what keeps "the thing the guard refuses" and "the thing code renders" one
 * string.
 */
export const PROVISIONAL_MARK = "(sin confirmar)";

/**
 * The mark a line wears when the goods on it were arrived at BY LOOKING
 * (ticket #196; spec #193 decision 18; ADR-0004, ADR-0037 as amended).
 *
 * A customer writes «me mandas lo mismo del pedido pasado?», the extraction
 * searches and finds exactly one referent, and the fact is filed with the
 * goods that referent named. The rep is owed the difference between that and
 * a line read straight off today's words — user story 2: "I want a line
 * inferred by reference to say so, so that I know which lines to check more
 * carefully" — and this is it.
 *
 * GENERIC, AND THAT IS THE POINT RATHER THAN A LIMITATION. It names no
 * order, no chat and no customer, because the referent is the one thing this
 * mark may never carry: owner-visible provenance is the day's own message
 * (ADR-0004), and a line saying WHICH conversation the twin read would put a
 * chat in front of the rep's employer through the disclosure the rep is
 * shown. Nothing about the referent is stored anywhere — not in the payload,
 * not on this line, not on the run row.
 *
 * STRUCTURE RATHER THAN SPEECH, exactly as «(sin confirmar)» is: a
 * parenthetical the rep learns to read, rendered by CODE from the
 * candidate's own reading. A model asked to write it could write it on a
 * line it read straight off the day, or leave it off one it inferred, and
 * either way the rep would be checking the wrong lines.
 */
export const BY_REFERENCE_MARK = "(por referencia)";

/**
 * The one BINDING-AWARE counterparty-naming rule (ticket #34; spec #29
 * decision 3; the spec writes the slot {cliente} — surface words stay out
 * of identifiers per CONTEXT.md): a rep-confirmed binding names the
 * counterparty unmarked — the rep's word beats the rail's metadata — and
 * everything else renders provisional: `counterpartyDisplayName`'s raw
 * rail name (push-name, number when absent) marked «(sin confirmar)».
 * Every surface that names a counterparty (the Mock A «para …» slot,
 * «Enviado a …») resolves here; `counterpartyDisplayName` alone is the
 * RAW rail rule and never marks.
 */
export function counterpartyName(args: {
  /** The bound entity's rep-confirmed display name, when the chat is bound. */
  confirmedName: string | undefined;
  pushName: string | undefined;
  senderJid: string;
}): string {
  if (args.confirmedName !== undefined) return args.confirmedName;
  return `${counterpartyDisplayName(args.pushName, args.senderJid)} ${PROVISIONAL_MARK}`;
}

/**
 * The binding question NO EXECUTION COMPOSED (ticket #34; spec #29 story 15;
 * spec #193 decision 9): asked at most once per chat, proposing the chat's
 * push-name.
 *
 * The answers line teaches the QUESTION verb (ticket #49; #36 finding 1):
 * «va» means "go ahead", which reads oddly as the answer to «¿Este chat es
 * de X?», and the twin was the one sounding wrong. Since #172 it is rendered
 * from `AFFIRMATIONS.question`, so it teaches whatever the matcher actually
 * accepts. «va» keeps working on this post whatever the line says; it is
 * simply no longer what the twin asks for. Since #174 the line teaches only
 * the YES — the no is prose the execution reads — and the aperture's own
 * question no longer shares it.
 *
 * TWO CALLERS ARE LEFT, AND NEITHER HAS AN EXECUTION TO COMPOSE WITH. The
 * daily pass posts it for a chat with traffic and no binding and runs no
 * execution at all; drafting falls back to it when a turn composed no
 * sentence, because the ceremony never blocks a draft. Both ask it BARE, so
 * what is left is the keyword button's own prompt — permanent chrome on the
 * pinned allowlist rather than an interim entry. The drafting execution
 * composes its own sentence (#172) and the thread composes its own into the
 * reply that carries it (#195); both go through the renderer below, so the
 * rep reads one frame whoever wrote the words.
 */
export function renderBindingQuestion(proposedName: string): string {
  return (
    `${SIGIL}¿Este chat es de ${proposedName}?\n\n` +
    bindingAnswersLine()
  );
}

/**
 * The binding question the EXECUTION composed (ticket #172; spec #171
 * decision 17: "code decides a binding question is due; the execution is
 * told so in context and composes the question's sentence with the name as a
 * slot; code renders the frame with the accepted answers from data").
 *
 * THE NAME ARRIVES AS A SLOT AND CODE FOLDS IT IN. Drafting's `create_draft`
 * carries a sentence holding `{name}` exactly once, and refuses one that
 * types the name instead (`drafting/write.ts`). That is the same division
 * ADR-0037 draws for the owner twin's prose: the model writes the words and
 * never a value, so what the rep is asked about is the name the RAIL
 * supplied and the ceremony can never propose one model text produced (#34's
 * recorded decision 1).
 *
 * FLATTENED TO ONE LINE, for the reachable reason `renderDraftPost`
 * already gives about a push-name: a composed sentence carrying a newline
 * could paint what looks like a second post inside the one the rep is
 * answering.
 */
export function renderComposedBindingQuestion(args: {
  /** The execution's sentence, with `{name}` where the name goes. */
  readonly sentence: string;
  /** The name the rail supplied, which is what a «si» would confirm. */
  readonly name: string;
}): string {
  return `${SIGIL}${bindingQuestionSentence(args)}\n\n` + bindingAnswersLine();
}

/**
 * The composed question's sentence AS THE POST CARRIES IT — the name folded
 * in, collapsed onto one line.
 *
 * EXPORTED SO THE POST'S OWN PART CAN HOLD IT (ticket #220): a `question` part
 * carries no words, so the sentence the twin wrote is a `prose` part beside
 * it, and it has to be the same string the rendering carries or the feed and
 * the thread would show the rep two different questions. One function, so
 * they cannot.
 */
export function bindingQuestionSentence(args: {
  readonly sentence: string;
  readonly name: string;
}): string {
  return oneLine(foldNameSlot(args.sentence, args.name));
}

/** The one slot a composed binding question carries. */
export const NAME_SLOT = "{name}";

/** Every occurrence of the slot, filled. The contract has already refused none. */
function foldNameSlot(sentence: string, name: string): string {
  return sentence.split(NAME_SLOT).join(name);
}

/**
 * The binding-confirmation ack (ticket #49; spec #48 grilling decision 3,
 * story 13; #36 finding 2): the twin says out loud that the confirmation
 * landed, in the «Descartado» shape — one framed line, no ceremony. The
 * name is the one now stored, so the rep reads back exactly what the twin
 * saved rather than what they were asked. Silence here was felt
 * first-hand to be wrong on the slice-2 rig.
 *
 * ITS SENTENCE IS REACHABLE ON ITS OWN (ticket #220), because a post's
 * `receipt` part carries the sentence and not the frame — the same division
 * `RECEIPTS` draws for the acts' own receipts.
 */
export function bindingAckReceipt(confirmedName: string): string {
  return `Listo, guardé este chat como *${confirmedName}*.`;
}

/** The binding ack, framed — the byte oracle `renderRefusalNotice` explains. */
export function renderBindingAck(confirmedName: string): string {
  return renderReceiptPost(bindingAckReceipt(confirmedName));
}

/**
 * The draft post — Mock A with the twin's sentence above it (ticket #368):
 * the words the turn that wrote the draft ended on, which say who it is for
 * and why (the glossary's *Hand-off*), then the label and counterparty line,
 * the guillemet body, and the instruction line rendered from the accepted
 * keyword set. The reason lives in those words and nowhere else, so the
 * frame carries no clause of its own.
 *
 * `said` IS EMPTY WHEN THE TWIN WROTE NOTHING, and then the frame opens the
 * post as it always could: the label already names the counterparty, which is
 * the one thing a draft the rep may tap has to say.
 */
export function renderDraftPost(args: {
  /** The twin's sentence, its references already rendered as names; `""` when it said nothing. */
  said: string;
  counterparty: string;
  body: string;
}): string {
  const said = args.said.trim();
  const opening = said === "" ? SIGIL : `${SIGIL}${said}\n\n`;
  return (
    `${opening}*Borrador — para ${args.counterparty}*\n\n` +
    `«${args.body}»\n\n` +
    draftInstructionLine()
  );
}

/**
 * «Enviado a {cliente} ✓» — the send's own receipt, unframed (spec #29 story
 * 9).
 *
 * SEPARATE FROM ITS FRAME, like the binding ack above it, and for the reason
 * `RECEIPTS` gives about the acks (ticket #220): a post's `receipt` PART
 * carries the sentence, and the thread's frame belongs to the post that
 * carries it.
 */
export function sendConfirmationReceipt(counterparty: string): string {
  return `Enviado a ${counterparty} ✓`;
}

/**
 * «✳️ Enviado a {cliente} ✓» — the confirmation wears the frame (spec #29
 * story 9); the byte oracle `renderRefusalNotice` explains.
 */
export function renderSendConfirmation(counterparty: string): string {
  return renderReceiptPost(sendConfirmationReceipt(counterparty));
}

/**
 * A refusal notice: the frame around the total microcopy record (ADR-0017).
 *
 * THE BYTE ORACLE RATHER THAN THE PATH, like the two framed acks below it.
 * Production composes a refusal as a post — one `receipt` part carrying the
 * microcopy, and this frame around it (`composeReceiptPost`, ticket #220) —
 * and it cannot drift from this renderer, because the composer renders
 * through `renderReceiptPost` and reads the sentence from the same total
 * record. What this function is for is `grammar.test.ts`, which pins the
 * bytes a rep reads.
 */
export function renderRefusalNotice(reason: MatcherRefusalReason): string {
  return renderReceiptPost(REFUSAL_MICROCOPY[reason]);
}

/**
 * The frame OFF a post — the inverse of `renderReceiptPost`, and the only
 * reader that takes one off (ticket #220).
 *
 * A post's `receipt` or `prose` part carries the SENTENCE and the thread wears
 * the sigil, so a post written before parts existed has to be read back
 * through its frozen rendering with the frame removed. It lives here because
 * this module owns the sigil: `SIGIL` is private on purpose — only the
 * renderer may put one ON a post — and a second copy of those bytes anywhere
 * else would leave the frame standing on every re-expressed part the day the
 * sigil changed.
 */
export function unframed(text: string): string {
  return text.startsWith(SIGIL) ? text.slice(SIGIL.length) : text;
}

/**
 * THE RECEIPTS (ticket #174; spec #171 decision 22; ADR-0037 as amended —
 * "receipts and frame labels are the rep side's chrome").
 *
 * A RECEIPT IS AN EFFECT ACKNOWLEDGEMENT RENDERED FROM A TOOL'S RESULT, and
 * that is why every one of them is a constant here rather than a sentence
 * the twin composes: "a receipt reports what code DID, and composing one
 * would let a model describe an effect it never performed". The rep-act
 * tools call these at the moment they know their own outcome, and the line
 * the rep reads travels back through `EffectOutcome.receipt` — so a
 * turn whose prose claims «lo descarté» with no tool call behind it
 * renders none of them.
 *
 * UNFRAMED, AND THAT IS THE ONE THING #174 CHANGED ABOUT THE OLD ACKS. An
 * act used to be its own post, so «Descartado» carried the sigil. An act is
 * now part of a turn the twin also SPEAKS in, so the receipt is folded into
 * the composed reply by code (`renderAnswerPost`) and wears that post's
 * frame. The framed renderers below are kept for the other case — the twin
 * acted and had nothing to say — and they render exactly the bytes they
 * rendered before this ticket, so a rep who dismissed a draft yesterday
 * reads the same word today.
 *
 * The voice is «Descartado»'s throughout: one line, no ceremony, no
 * apology, and no promise about anything that did not happen.
 */
const DISMISS_RECEIPT = "Descartado";

/**
 * IT NAMES THE NUMBER BACK, and that matters more now than it did (#54).
 * The rep addressed this line by an INDEX and said so in their own words,
 * so reading the number back is how they see which line the twin resolved
 * from the sentence — the whole risk an indexed target carries, and it was
 * carried by a fixed verb before and by prose now.
 *
 * AND IT IS HONEST ABOUT WHAT HAPPENED. The fact is not deleted: it keeps
 * its row and stays in the timeline, annotated (FR-33), and never
 * finalizes. «marqué … como incorrecto» is exactly that and claims nothing
 * more; «lo quité» would be a sentence the store does not support.
 */
const CORRECTION_RECEIPT_FRAME = {
  before: "Listo, marqué el dato ",
  after: " como incorrecto.",
} as const;

function correctionReceipt(lineIndex: number): string {
  return `${CORRECTION_RECEIPT_FRAME.before}${lineIndex}${CORRECTION_RECEIPT_FRAME.after}`;
}

/**
 * A binding the rep declined (ticket #174) — the receipt the act never had.
 *
 * A DECLINE WROTE NOTHING AND SAID NOTHING until this ticket: the chat
 * stayed provisional, which is what an unanswered question already meant,
 * so the rep could not tell a decline that landed from one the twin never
 * understood. It still writes nothing — declining is the chat staying as it
 * was, and unbinding is a different act with no verb — and now it says so.
 */
const BINDING_DECLINED_RECEIPT = "Entendido, este chat sigue sin confirmar.";

/**
 * The rep taught the twin something (ticket #260; spec #258 — "the
 * acknowledgment is a receipt folded into the composed reply").
 *
 * THE «Listo,» SHAPE OF THE TWO ACKS BESIDE IT, and for the same reason: the
 * twin reports, in the first person, one write that happened. It claims
 * nothing about what the rule will do — the rep finds that out in the next
 * draft — and it never names the rule back, which would be code reciting the
 * rep's own sentence to them.
 *
 * A WHOLE PHRASE AND NOT THE BARE PARTICIPLE, which is a decision `guard.ts`
 * forces. Every receipt here is refused to the MODEL as a substring of its
 * prose, with whatever the phrase ends with taken off (ticket #276), so that a
 * rep can never read a typed line that reads as a rendered one — and «anotado»
 * alone is a word the twin has ordinary reason to write («quedó anotado en su
 * chat»), so a one-word receipt would refuse honest prose and spend a round of
 * a six-round budget on the commonest turn this feature has. «Descartado» can
 * be one word because nothing else in this thread is ever described that
 * way.
 */
const NOTEPAD_WRITTEN_RECEIPT = "Listo, lo anoté.";

/**
 * The twin rewrote its own notes because the rep asked it to (ticket #322;
 * spec #318 decision 2 — «the rep corrects it by prose in either door and the
 * receipt folds into the reply»).
 *
 * THE NOTEPAD'S SHAPE, AND A DIFFERENT OBJECT: «mis notas» are the twin's, so
 * the rep reading it beside «Listo, lo anoté.» can tell which of the two
 * notebooks moved. A whole phrase for `NOTEPAD_WRITTEN_RECEIPT`'s reason —
 * `guard.ts` refuses it to the model as a substring of its prose.
 */
const WORKING_MEMORY_WRITTEN_RECEIPT = "Listo, corregí mis notas.";

/** The dismiss receipt, on its own post: exactly «Descartado», framed. */
export function renderDismissAck(): string {
  return renderReceiptPost(DISMISS_RECEIPT);
}

/** The correction receipt, on its own post (ticket #54). */
export function renderCorrectionAck(lineIndex: number): string {
  return renderReceiptPost(correctionReceipt(lineIndex));
}

/** A correction that retracted nothing: the frame around the total record. */
export function renderCorrectionRefusal(
  reason: CorrectionRefusalReason,
): string {
  return SIGIL + CORRECTION_REFUSAL_MICROCOPY[reason];
}

/**
 * A run's four endings with their slots named: `{run}` is the run as a report
 * names it (`runNamed`), `{step}` and `{of}` the step it stopped at and the
 * run's length — so the guard reads the same sentences the report renders.
 */
const RUN_REPORT_TEMPLATES = Object.freeze({
  failed: "Se detuvo {run} en el paso {step} de {of}. Queda en Trabajos en curso.",
  budgetSpent: "Paré {run}: se acabó lo que tenía para ese trabajo. Queda en Trabajos en curso.",
  cancelled: "Cancelé {run}.",
  finished: "Terminé {run}.",
});

/** A run ending's template with its slots filled. */
function runReport(template: string, slots: { readonly run: string; readonly step?: number; readonly of?: number }): string {
  return template.replace(/\{(run|step|of)\}/gu, (_, slot: "run" | "step" | "of") =>
    slot === "run" ? slots.run : String(slots[slot]),
  );
}

/**
 * WHAT A WORKFLOW RUN'S REPORT SAYS WHEN CODE ENDS IT (tickets #323, #358;
 * spec #318 decisions 22 and 25): a step that failed, a budget spent, a
 * cancel, and a run that ended with nothing of the twin's to report. The
 * run's own `post` step reports in the twin's words; these four are code's,
 * so each is a RECEIPT (ADR-0037 as amended): posted as a `receipt` part and
 * swept by the guard from the twin's prose (`RECEIPTS.every.runEndings`).
 */
export const RUN_REPORTS = Object.freeze({
  failed: (name: string, step: number, of: number): string =>
    runReport(RUN_REPORT_TEMPLATES.failed, { run: runNamed(name), step, of }),
  budgetSpent: (name: string): string => runReport(RUN_REPORT_TEMPLATES.budgetSpent, { run: runNamed(name) }),
  cancelled: (name: string): string => runReport(RUN_REPORT_TEMPLATES.cancelled, { run: runNamed(name) }),
  finished: (name: string): string => runReport(RUN_REPORT_TEMPLATES.finished, { run: runNamed(name) }),
});

/** A run as a report names it: its own name in quotes, or the word for a run when it has none to read. */
export function runNamed(name: string): string {
  return name.trim() === "" ? "el trabajo" : `«${name.trim()}»`;
}

/**
 * EVERY RECEIPT A REP-ACT TOOL CAN RENDER, in one value (ticket #174,
 * narrowed at #218 when the aperture question's two left with it).
 *
 * ONE EXPORT RATHER THAN FOUR, because the three tools are three call sites
 * for one kind of thing and the grammar module's own rule is that it is
 * "the ONE rendering point for every twin-authored post". A tool reaches
 * for the line it owes and cannot reach for the frame, which is what keeps
 * the fold-into-the-reply decision here rather than in three handlers.
 */
export const RECEIPTS = Object.freeze({
  dismissed: DISMISS_RECEIPT,
  notepadWritten: NOTEPAD_WRITTEN_RECEIPT,
  workingMemoryWritten: WORKING_MEMORY_WRITTEN_RECEIPT,
  retracted: correctionReceipt,
  bindingDeclined: BINDING_DECLINED_RECEIPT,
  correctionRefused: (reason: CorrectionRefusalReason): string =>
    CORRECTION_REFUSAL_MICROCOPY[reason],
  /**
   * EVERY RECEIPT, AS A SET A GUARD CAN SWEEP (ticket #174, Codex round 2).
   *
   * `guard.ts` refuses prose that would render as a receipt code owns, and
   * it has to know all of them: the first cut enumerated the fixed ones and
   * a range of line numbers, which missed the three REFUSAL sentences —
   * code-owned receipts every one — and stopped at an arbitrary line index
   * the disclosure has no matching bound for.
   *
   * SO THE SET IS EXHAUSTIVE AND THE NUMBERED ONE IS A FRAME. The fixed
   * sentences are listed from the same constants the renderers use; the
   * refusals come from the TOTAL microcopy record, so a reason added on the
   * far side of the wall joins this set through a typecheck; and the
   * correction's receipt travels as its two halves, so a matcher spans
   * every line number a post could print without this file guessing how
   * many that is.
   */
  every: Object.freeze({
    fixed: Object.freeze([
      DISMISS_RECEIPT,
      NOTEPAD_WRITTEN_RECEIPT,
      WORKING_MEMORY_WRITTEN_RECEIPT,
      BINDING_DECLINED_RECEIPT,
      ...Object.values(CORRECTION_REFUSAL_MICROCOPY),
    ]),
    /** The numbered receipt, as the two halves a line index sits between. */
    numbered: CORRECTION_RECEIPT_FRAME,
    /**
     * A run's four endings (ticket #358), as templates whose slots are the
     * run's name and the step it stopped at (`RUN_REPORTS`).
     */
    runEndings: Object.freeze(Object.values(RUN_REPORT_TEMPLATES)),
  }),
});

/**
 * The disclosure line an entity create gets (ticket #50; spec #48 decision
 * 7, shape D; ADR-0003 as amended). Rendered HERE, at the one grammar
 * point, and stored by the aperture as rendered text carrying no version —
 * re-rendering it later from a changed template would retroactively
 * rewrite what a rep was told (ADR-0034).
 *
 * It takes no argument on purpose. In the daily disclosure the customer is
 * the group heading and the timestamp is the provenance suffix, so the
 * line itself is exactly the claim: *this* is what crossed. Unframed —
 * the ✳️ frame belongs to the post that carries the lines, not to a line.
 */
export function renderEntityCreateDisclosureLine(): string {
  return "Lo di de alta como cliente.";
}

/**
 * THE FACT DISCLOSURE LINE (ticket #52; spec #48 decision 7 shape D;
 * ADR-0034) — the first thing the rep reads about what extraction filed.
 *
 * Rendered from the payload the APERTURE NORMALIZED, never from the model's
 * own words. A disclosure line is the twin's statement that *this* crossed,
 * and the thing that crossed is the stored row: a line describing what the
 * model said while the Ledger holds something else is the failure this
 * whole surface exists to prevent. The aperture hands this function the
 * shaped payload for exactly that reason.
 *
 * Voice follows the prototype, which mixes two on purpose: a fact reports
 * what the REP did in the conversation («Le confirmaste…»), while an entity
 * create reports what the TWIN did («Lo di de alta…»). FR-40 holds — there
 * is no product noun anywhere in either.
 *
 * Unframed, like `renderEntityCreateDisclosureLine`: the ✳️ frame belongs
 * to the post that carries the lines, and the counterparty and the instant
 * are the post's heading and suffix.
 *
 * Loud on anything it cannot describe. A crossing the twin cannot state is
 * not one to disclose vaguely — the aperture already refused every payload
 * shape this cannot render, so reaching the throw means the two disagree.
 */
export function renderFactDisclosureLine(
  fact: Pick<NormalizedFact, "factType" | "payload">,
  /**
   * How the model read the message this fact was found in — the aperture's
   * own value, carried across untouched (ticket #196). The only reading this
   * renderer says anything about is `resolved_reference`, which earns the
   * by-reference mark. A candidate the gate stopped never reaches a renderer
   * at all — the aperture drops it before any sentence is composed (tickets
   * #76 and #218).
   */
  reading: CandidateReading,
): string {
  // ONE LINE, GUARANTEED AT THE EXIT (routed from #73). Every free-text
  // slot below is already individually collapsed, so today no payload can
  // produce a newline here — but the day's post NUMBERS its lines, so a line
  // that ever DID carry one would paint a second numbered line: the rep
  // could point at it and `resolveDisclosureLineOfPost` could not resolve
  // it. Collapsing the whole sentence makes that unreachable by
  // construction rather than by the sum of every caller remembering, which
  // matters now that #71 has added a line quoting the rep's own words back.
  //
  // THE MARK IS APPENDED AFTER THE COLLAPSE (ticket #196), which keeps that
  // guarantee: it is a constant with no newline in it.
  const sentence = oneLine(factSentence(fact));
  return reading === "resolved_reference"
    ? `${sentence} ${BY_REFERENCE_MARK}`
    : sentence;
}

function factSentence(
  fact: Pick<NormalizedFact, "factType" | "payload">,
): string {
  const { factType, payload } = fact;
  switch (factType) {
    case "QuoteGiven":
      return `Le cotizaste ${commercialClause(factType, payload, "en")}.`;
    // THE CUSTOMER'S ACT, in the voice it always had (ticket #71). «Te
    // pidió …» already reported a customer asking; the split moved it to
    // the type whose name says so, and no new voice was needed.
    case "OrderRequested":
      return `Te pidió ${commercialClause(factType, payload, "por")}.`;
    // THE REP'S ACT, and a different subject on purpose. A rep reading a
    // request and its agreement on the same day sees two lines, and they
    // must not read as one exchange counted twice.
    case "OrderTaken":
      return `Le confirmaste el pedido de ${commercialClause(factType, payload, "por")}. ${agreedWords(payload)}`;
    case "DatePromised": {
      const commitment = oneLine(String(payload["commitment"] ?? ""));
      if (commitment === "") {
        return unrenderable(factType, "no `commitment` to continue the verb with");
      }
      return `Le confirmaste ${commitment} — ${promisedDate(payload)}.`;
    }
    case "ContactEstablished":
      return contactLine(payload);
    // THE CUSTOMER'S ACT, and the only fact line whose subject is the
    // customer talking about themselves (ticket #61; ADR-0040). «Te dijo …»
    // is true because the authorship fence made it true: a
    // `CustomerPattern` is read in the counterparty's own message or
    // refused (ADR-0038), so there is no rep-authored note this sentence
    // can be told about.
    //
    // NOTHING VERBATIM, and the omission is the design. This line once
    // ended «Sus palabras: «…».», quoting the customer's whole message the
    // way `OrderTaken` quotes the rep's — and a message carrying a standing
    // preference AND a complaint about the rep would have put the complaint
    // in the Ledger the rep's EMPLOYER reads. The stored payload is one
    // composed clause, so the line is one sentence, and the rep checks it
    // the way they check «Te pidió …»: by its content and the provenance
    // the post appends.
    case "CustomerPattern": {
      const stated = oneLine(String(payload["pattern"] ?? ""));
      if (stated === "") {
        return unrenderable(factType, "no `pattern` to continue the verb with");
      }
      return `Te dijo que ${stated}.`;
    }
    default:
      return unrenderable(
        factType,
        "the twin has no sentence for this fact type",
      );
  }
}

/**
 * The body every commercial line shares: what, for how much, for when, and
 * what the Ledger does not hold — «100 cajas por 4,500 MXN para el lunes
 * 31 de agosto de 2026», «cajas — sin cantidad, sin precio, sin fecha».
 *
 * One clause for three fact types (ticket #71), because a quote, a request
 * and an agreed order describe the same goods and differ only in WHO acted
 * — which is the verb in front of this, not the goods behind it. Three
 * copies of the same four calls is how a field ends up rendered on one
 * type and silently dropped on another, and the absence clause is exactly
 * the thing #65 added because a dropped field is invisible.
 *
 * The preposition is the caller's: a price is «en» when the rep quoted it
 * and «por» when it is what the goods cost.
 */
function commercialClause(
  factType: string,
  payload: Readonly<Record<string, unknown>>,
  preposition: string,
): string {
  return (
    goods(factType, payload) +
    money(payload, preposition) +
    wantedOn(factType, payload) +
    unstatedFields(factType, payload)
  );
}

/**
 * «Dijiste: «va, se los mando».» — the rep's own words that the extractor
 * read as the business agreeing (ticket #71) — or «Confirmaste con 👍: «¿me
 * mandas 20 bultos?».» when the rep agreed by tapping rather than by typing
 * (ticket #99; ADR-0041's worked example line).
 *
 * THE EVIDENCE IS IN THE LINE, and that is the whole point of it. #66
 * measured every wrong crossing in the corpus arriving at 0.95–1.00
 * confidence, so the gate cannot catch an order the rep never agreed to;
 * the rep can, but only if the line says WHY the twin thinks they agreed.
 * A line reading «Le confirmaste el pedido de 20 bultos» is unfalsifiable
 * at a glance on a busy day; the same line ending «Dijiste: «déjame
 * checar».» is wrong on its face, inside the 24-hour window (ADR-0004).
 *
 * TWO SENTENCES, BECAUSE THE ATTRIBUTION DIFFERS AND NOTHING ELSE DOES. On
 * a spoken agreement the quoted words are the rep's own. On a gesture they
 * are the CUSTOMER's — the message the emoji was placed on — and «Dijiste»
 * over them would put the customer's sentence in the rep's mouth: the one
 * kind of wrong a rep cannot catch by reading it, because it would look
 * exactly like an agreement they made. So the gesture field chooses the
 * verb, and the line names both halves — what was tapped, and what it was
 * tapped on.
 *
 * READ OFF THE PAYLOAD AND NOTHING ELSE, like every line here. The
 * aperture composed both strings off the seam rows themselves (`facts.ts`,
 * `inputs.ts`), so this states what the plane delivered rather than what a
 * model composed about it (ADR-0037).
 */
function agreedWords(payload: Readonly<Record<string, unknown>>): string {
  const said = oneLine(String(payload["agreement"] ?? ""));
  if (said === "") {
    return unrenderable(
      "OrderTaken",
      "no `agreement` to quote — an agreed order the rep cannot check is the wrong the field exists to prevent",
    );
  }
  // ABSENT MEANS WORDS (ADR-0034: a new reader treats an absent field as
  // NOT RECORDED THEN, never as a default). Every `OrderTaken` filed
  // before #99 carries no gesture and was a spoken agreement, so the
  // sentence those rows were disclosed under is the sentence they keep.
  const gesture = oneLine(String(payload["agreementGesture"] ?? ""));
  return gesture === ""
    ? `Dijiste: «${said}».`
    : `Confirmaste con ${gesture}: «${said}».`;
}

/**
 * THE UNSTATED COMMERCIAL FIELDS (ticket #65, extended by #70) — «… — sin
 * cantidad, sin precio, sin fecha.», or nothing at all when the sentence
 * already said everything.
 *
 * #57's order line read «Te pidió 20 bultos de producto (no especificado)
 * por 4,000 MXN.» and the rep had no way to tell a field the Ledger got
 * right from one it never held. A field the sentence simply omits is
 * invisible, and the 24-hour window (ADR-0004) and the precision ground
 * truth it feeds (ADR-0016) both rest on the rep being able to SEE the
 * field. Saying «sin precio» states the absence; it never stands in for a
 * value (ADR-0034 — a missing currency is unknown, not MXN).
 *
 * `quantity`, the price and the requested day. Those are the three the
 * sentence renders INLINE when present, so theirs is the absence a rep
 * cannot see. `unit` is deliberately not among them: it modifies
 * `quantity` and carries nothing alone — with no quantity there is nothing
 * for a unit to count, and with a quantity and no unit the number counts
 * the item itself («100 cajas»), which is how the rep would say it.
 *
 * «SIN FECHA» IS SAID ON EVERY DATELESS ORDER (ticket #70), the same rule
 * `DatePromised` has followed since #65 and for the same reason: the
 * `item` slot is the model's own words and may well carry a day («cajas
 * para el lunes») that the Ledger does not hold as a date. A rep who is
 * not told the store has no date cannot tell that apart from one it holds
 * correctly.
 *
 * Every slot asks the SAME question the sentence asked — `quantity`,
 * `price` and `requestedFor`, the three readers `goods`, `money` and
 * `wantedOn` use. Two predicates for one field is how a line ends up
 * rendering no price and claiming none is missing, which is the very
 * defect this clause exists to close.
 */
function unstatedFields(
  factType: string,
  payload: Readonly<Record<string, unknown>>,
): string {
  const missing = [
    quantity(payload) === undefined ? "sin cantidad" : undefined,
    price(payload) === undefined ? "sin precio" : undefined,
    statedDay(factType, payload, "requestedFor") === undefined
      ? "sin fecha"
      : undefined,
  ].filter((part): part is string => part !== undefined);
  return missing.length === 0 ? "" : ` — ${missing.join(", ")}`;
}

/**
 * « para el lunes 31 de agosto de 2026» — the day a quote or an order is
 * wanted for, or nothing at all (ticket #70).
 *
 * «PARA EL …», never «Le confirmaste …». `requestedFor` is the day the
 * conversation asks for, and asking is not promising: the corpus labels a
 * customer-proposed date silent precisely so that no crossing files a
 * commitment before the rep made one, and this clause is worded to claim
 * exactly as little. The rep's own promise is a `DatePromised`, with its
 * own line and its own verb.
 */
function wantedOn(
  factType: string,
  payload: Readonly<Record<string, unknown>>,
): string {
  const day = statedDay(factType, payload, "requestedFor");
  return day === undefined ? "" : ` para el ${day}`;
}

/** How many of the goods, when the payload holds a count. */
function quantity(
  payload: Readonly<Record<string, unknown>>,
): number | undefined {
  const value = payload["quantity"];
  return typeof value === "number" ? value : undefined;
}

/**
 * The price the payload holds: an amount AND the currency it is
 * denominated in, or nothing at all. The aperture refuses one without the
 * other («a bare number is not a price»), and the line agrees with it —
 * one place, so what the sentence renders and what `unstatedFields` calls
 * missing can never disagree.
 */
function price(
  payload: Readonly<Record<string, unknown>>,
): { readonly amount: number; readonly currency: string } | undefined {
  const amount = payload["amount"];
  const currency = payload["currency"];
  if (typeof amount !== "number" || typeof currency !== "string") {
    return undefined;
  }
  return { amount, currency };
}

/**
 * The promised date, or the plain statement that none was stored.
 *
 * ALWAYS SAID, present or absent, because `DatePromised`'s sentence is the
 * model's own `commitment` prose and prose must never be the only carrier
 * of a correctable field. The prose may still name a day; when it
 * does and the two disagree, the rep reads the disagreement — which is the
 * #57 failure made visible rather than hidden.
 *
 * An absent `dueOn` says «sin fecha» rather than rendering nothing: under
 * ADR-0034 an absent field is NOT RECORDED THEN, never a default, and a
 * rep who is not told that the Ledger holds no date cannot tell it apart
 * from one it holds correctly.
 */
function promisedDate(payload: Readonly<Record<string, unknown>>): string {
  return statedDay("DatePromised", payload, "dueOn") ?? "sin fecha";
}

/**
 * The calendar date a payload field holds, rendered as the rep says it —
 * or `undefined` when the Ledger holds none.
 *
 * ONE READER FOR EVERY DATE ON EVERY PAYLOAD (ticket #70): `DatePromised`'s
 * `dueOn` and a commercial fact's `requestedFor` are the same stored shape
 * and get the same sentence, so a wrong day looks identical wherever the
 * rep meets it. It is also the reader `unstatedFields` asks, which is what
 * keeps the day the sentence renders and the day it calls missing from
 * ever disagreeing (#65's own lesson, on the price).
 *
 * Loud on a value that is not a calendar date: the aperture refused every
 * other shape on the way in, so reaching this throw means the store and
 * the renderer disagree, and a crossing the twin cannot state is never
 * disclosed vaguely.
 */
function statedDay(
  factType: string,
  payload: Readonly<Record<string, unknown>>,
  field: string,
): string | undefined {
  const value = payload[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !CALENDAR_DATE.test(value)) {
    return unrenderable(
      factType,
      `\`${field}\` is ${JSON.stringify(value)}, not the calendar date the aperture stores`,
    );
  }
  return renderCalendarDate(value);
}

/** The shape the aperture stores every payload day in — a calendar date, never an instant. */
const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/u;

/**
 * A stored calendar date as the rep says it: «martes 1 de septiembre de
 * 2026».
 *
 * A WEEKDAY AND A DATE, never the ISO string. The rep's memory of a promise
 * is «el lunes», so the weekday is what makes a wrong day visible at a
 * glance — reading `2026-09-01` back to them asks them to do the calendar
 * arithmetic that got it wrong in the first place.
 *
 * THE YEAR IS PART OF THE DATE (Codex r1). A stored day is a full
 * `YYYY-MM-DD`, and weekday-day-month states only three quarters of it:
 * «martes 1 de septiembre» is the same sentence for 2026 and for 2037. A
 * promise made in December for «el 15 de enero» is exactly where a year
 * goes wrong, and a component the line does not state is one the rep
 * cannot correct.
 *
 * FORMATTED IN UTC, deliberately. A stored day is a CALENDAR DATE with no time
 * of day — «el lunes» has none, and the aperture refuses to invent one —
 * so it is parsed at midnight UTC and formatted there. Rendering it in the
 * rep's own zone would shift every date west of Greenwich back one day and
 * have the twin read out Monday for the Tuesday it stored: the exact class
 * of error this line exists to expose.
 *
 * REP-FACING ONLY, AND #139 IS WHY THAT IS WORTH STATING. #121 shared this
 * sentence with the extraction turn, on the argument that a wrong day is
 * only obvious when the rep and the model read one calendar language.
 * Measured, the sharing cost precision: Spanish framing over a Spanish
 * conversation reads as speech, and the model echoed the weekday word back
 * (#139's second ruling, and the numbers on `renderTurnInstant`). The
 * model-facing stamp is English bracketed metadata now, and it is a
 * separate function. This one has exactly one audience: the person.
 */
export function renderCalendarDate(day: string): string {
  return (
    new Intl.DateTimeFormat("es-MX", {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    })
      .format(new Date(`${day}T00:00:00Z`))
      // «martes, 1 de septiembre» is a heading; this is a clause inside a
      // sentence the rep reads aloud in their head.
      .replace(",", "")
  );
}

/**
 * «100 cajas», «20 bultos de cemento», «cajas» — what was quoted or ordered.
 *
 * THE UNIT IS SAID ONCE (#200 hotfix 2). `item` is the model's own words and
 * `unit` is its own reading of the same phrase, so the two overlap whenever
 * the goods are named by their unit: the rig filed «varilla» as the unit of
 * «varilla de 3/8» and «bultos» as the unit of «bultos», and the join read
 * «Le cotizaste varilla de varilla de 3/8». Nothing is dropped when they
 * overlap — the item carries the whole phrase and the unit adds no word to it.
 */
function goods(
  factType: string,
  payload: Readonly<Record<string, unknown>>,
): string {
  const item = oneLine(String(payload["item"] ?? ""));
  if (item === "") {
    return unrenderable(factType, "no `item` to name");
  }
  const unit = oneLine(String(payload["unit"] ?? ""));
  const named =
    unit === "" || itemOpensWith(item, unit) ? item : `${unit} de ${item}`;
  // The same reader `unstatedFields` uses, so the count this names and the
  // count it calls missing are one question asked once.
  const count = quantity(payload);
  return count === undefined ? named : `${formatNumber(count)} ${named}`;
}

/**
 * Whether the item's own words already open with the unit, so joining them
 * would say it twice (#200 hotfix 2).
 *
 * AT A WORD BOUNDARY, and «sal» against «salsa» is the whole reason: a unit
 * that merely starts the item's first word is a different word, and dropping
 * it would tell the rep «4 salsa» where the store holds a unit of «sal».
 * Bare-prefix matching loses information; this loses only repetition.
 *
 * `asRepReads` on both sides, like every comparison in this module: what the
 * rep sees is what decides, so a fullwidth or decorated spelling of the unit
 * still counts as the word the item opens with. Case folds too — the model
 * capitalizes one field and not the other often enough that a case-sensitive
 * test would leave the doubled word standing on exactly those lines.
 */
function itemOpensWith(item: string, unit: string): boolean {
  const itemText = asRepReads(item).toLowerCase();
  const unitWord = asRepReads(unit).toLowerCase();
  if (unitWord === "" || !itemText.startsWith(unitWord)) return false;
  const afterUnit = itemText.slice(unitWord.length, unitWord.length + 1);
  return afterUnit === "" || !/[\p{L}\p{N}]/u.test(afterUnit);
}

/** « en 4,500 MXN» — the amount exactly as the Ledger holds it, or nothing. */
function money(
  payload: Readonly<Record<string, unknown>>,
  preposition: string,
): string {
  const held = price(payload);
  if (held === undefined) return "";
  // The code rather than a symbol: the aperture stores ISO 4217 and a
  // symbol table would be a second source of truth for what «$» means in a
  // line that is never re-rendered.
  return ` ${preposition} ${formatNumber(held.amount)} ${held.currency}`;
}

/** «Guardé los datos de contacto de Ana: …» — every identifier that crossed. */
function contactLine(payload: Readonly<Record<string, unknown>>): string {
  const identifiers = payload["identifiers"];
  const arms =
    typeof identifiers === "object" && identifiers !== null
      ? (identifiers as Record<string, unknown>)
      : {};
  const values = [
    ...list(arms["phones"]),
    ...list(arms["emails"]),
    // Labelled, because an RFC is the one identifier a rep cannot
    // recognize by its shape at a glance.
    ...list(arms["rfcs"]).map((rfc) => `RFC ${rfc}`),
  ];
  if (values.length === 0) {
    return unrenderable("ContactEstablished", "no identifier crossed");
  }
  const name = oneLine(String(payload["contactName"] ?? ""));
  const whose =
    name === "" ? "sus datos de contacto" : `los datos de contacto de ${name}`;
  // The role the aperture stored, said out loud (ticket #65). Before this
  // it was the one shaped field that crossed the wall with no line naming
  // it, so a wrong job title was uncorrectable for exactly the reason the
  // wrong date was.
  const role = oneLine(String(payload["role"] ?? ""));
  const who = role === "" ? whose : `${whose} (${role})`;
  return `Guardé ${who}: ${values.join(", ")}.`;
}

function list(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string").map(oneLine)
    : [];
}

/**
 * es-MX grouping, no currency style: the code carries the currency.
 *
 * TWENTY FRACTION DIGITS, not two (Codex r1). The old cap quietly
 * rounded: the aperture accepts any finite positive `quantity` or
 * `amount`, so a stored 0.125 toneladas read back to the rep as 0.13. A
 * disclosure line that states a number the Ledger does not hold is the
 * same failure as one that omits it — the rep confirms a value that was
 * never filed.
 *
 * 20 is the widest fraction `Intl.NumberFormat` takes, which covers every
 * quantity and every price a conversation can state, and is where the
 * claim stops (Codex r2): a value smaller than 1e-20 still renders as 0.
 * That is recorded rather than engineered around — no extraction produces
 * a quantity of cajas or a price in pesos below 1e-20, and the honest fix
 * for numbers this surface cannot state is a per-field scale decided at
 * the aperture, which is a payload-contract call under ADR-0034 rather
 * than a rendering one.
 */
function formatNumber(value: number): string {
  return new Intl.NumberFormat("es-MX", { maximumFractionDigits: 20 }).format(
    value,
  );
}

function unrenderable(factType: string, why: string): never {
  throw new Error(
    `cannot render a ${factType} disclosure line: ${why} — a crossing the twin cannot state is never disclosed vaguely (ticket #52; ADR-0034)`,
  );
}

/**
 * Where one disclosure line came from, in the rep's own vocabulary.
 *
 * `rep_act` — the rep did it themselves, and the instant is when they did:
 *   «tú lo confirmaste, ayer 18:53». An entity create is the only rep act
 *   that crosses this slice.
 * `chat` — the twin read it in a customer chat: «su chat, …».
 */
export type DisclosureProvenance =
  | { readonly kind: "rep_act"; readonly at: Date }
  | { readonly kind: "chat"; readonly at: Date };

/** One numbered line of the daily disclosure, as the rep will read it. */
export interface DisclosurePostLine {
  /**
   * The number the rep sees — 1-based and CONTINUOUS across the whole
   * post, never restarted per counterparty: «N no» must name exactly one line
   * (spec #48 decision 14), and a per-group number would name several.
   */
  readonly index: number;
  /** The line's own claim, as the aperture stored it (ADR-0034: never re-rendered). */
  readonly text: string;
  readonly provenance: DisclosureProvenance;
}

/** One counterparty's block of the post — the rep reads their work by customer. */
export interface DisclosurePostGroup {
  readonly counterparty: string;
  readonly lines: readonly DisclosurePostLine[];
}

/**
 * THE DAILY DISCLOSURE (ticket #51, composed at #198; spec #48 decision 7
 * shape D and decision 17; spec #193 decisions 8, 23 and 24;
 * FR-38/FR-40): the rep's account of what left their phone today. One
 * grouped post — by counterparty, numbered, each line carrying where it came
 * from — settled at the prototype gate against real rig traffic.
 *
 * THE TWIN COMPOSES AROUND CODE-OWNED LINES, and that division is the whole
 * of spec #193 decision 8. Every LINE is what the aperture stored at filing,
 * rendered by code, numbered by code, in stored order: a line must show every
 * correctable field or the correction window cannot catch a wrong value
 * (#65), the verb IS the fact type, the agreement quote comes off the seam
 * row (ADR-0038), and silence is a yes on a disclosure line — the one place
 * on the rep side where the twin's own words are confirmed by the rep doing
 * nothing. What the execution writes is the OPENING that says what kind of
 * day it was and the CLOSING that tells the rep how to correct something in
 * its own words.
 *
 * THE HEADING WITH THE COUNT STAYS CODE'S (ADR-0037 as amended: the sigil and
 * the numbered-line frame are chrome). The count is arithmetic over the lines
 * this post carries, and a composed number could disagree with the lines
 * under it — which is why the guard refuses a digit anywhere in the composed
 * halves.
 *
 * FR-40 holds by construction: there is no product noun to hold. The twin
 * says what it did, in the first person, and «el registro» is the Ledger's
 * own surface word (CONTEXT.md), not a name for this post.
 *
 * BOTH COMPOSED HALVES ARE COLLAPSED ONTO ONE LINE, for the reachable reason
 * the counterparty heading is (Codex r1 on #51): the numbers in this post are
 * what a rep's correction resolves through, so a sentence carrying a newline
 * and a «1.» would paint a numbered line the twin never wrote, beside real
 * lines whose numbers it shifts in the eye.
 *
 * An empty day is REFUSED here rather than rendered as "nothing to report":
 * silence is a valid state and there is no report of no news (spec #48
 * decision 17, story 11). The precondition means the automation never runs on
 * an empty day; the throw is what stops a future caller from inventing one.
 */
export function renderDailyDisclosurePost(args: {
  groups: readonly DisclosurePostGroup[];
  /** The twin's own sentence about what kind of day it was, slots already folded. */
  opening: string;
  /** ...and its own sentence about how to correct a line, slots already folded. */
  closing: string;
  /** The post's own instant — what «hoy» and «ayer» are relative to. */
  now: Date;
  timeZone?: string;
}): string {
  const count = args.groups.reduce((n, group) => n + group.lines.length, 0);
  if (count === 0) {
    throw new Error(
      "refusing to render a daily disclosure for an empty day — silence is a valid state and the twin does not report no news (spec #48 decision 17)",
    );
  }
  const heading = `${SIGIL}*Hoy agregué ${count} ${count === 1 ? "dato" : "datos"} al registro.*`;
  const blocks = args.groups.map((group) => {
    const lines = group.lines.map(
      (line) =>
        `${line.index}. ${line.text} (${renderDisclosureProvenance(line.provenance, args.now, args.timeZone)})`,
    );
    return [`*${oneLine(group.counterparty)}*`, ...lines].join("\n");
  });
  return assertFramed(
    [heading, oneLine(args.opening), ...blocks, oneLine(args.closing)].join(
      "\n\n",
    ),
  );
}

/**
 * A heading collapsed onto ONE line (Codex r1, a reachable failure).
 *
 * The counterparty's name reaches here from a WhatsApp push-name — a
 * COUNTERPARTY-controlled string the rep merely confirmed. In every other
 * post that is a cosmetic risk; here the post's line numbers are what a
 * rep act resolves through, so a name carrying a newline and a «1.» would
 * paint a numbered line the twin never wrote, beside real lines whose
 * numbers it shifts in the eye. «1 no» would then be a rep pointing at one
 * thing and the seam resolving another.
 *
 * Every line break — LF, CR, LS, PS, NEL — becomes a space, so a heading
 * occupies exactly one line and every visually numbered line in the post
 * is one this module numbered. It does NOT neutralize WhatsApp's own
 * `*` and `_` markers: a name can still render bold-ish, which is
 * cosmetic and is the same exposure `renderDraftPost` and
 * `renderBindingQuestion` have carried since slice 2 — a grammar-wide
 * concern, not this post's.
 */
function oneLine(text: string): string {
  return text.replace(/[\r\n\u0085\u2028\u2029]+/gu, " ").trim();
}

/**
 * What a composed part will amount to once a post carries it (ticket #198,
 * Codex r1).
 *
 * THE GUARD HAS TO ASK THE RENDERER, NOT ITS OWN APPROXIMATION, and this is
 * the reachable reason: `asRepReads` collapses JavaScript's whitespace class,
 * which does not include NEL (U+0085) — while `oneLine` above folds NEL to a
 * space and trims, because a post is one line per part. So a lead of one NEL
 * read as content to a guard that only trimmed, and rendered as NOTHING to
 * the rep: a question posted with no lead and no ask under it, which is the
 * empty part the contract exists to refuse.
 *
 * BOTH FOLDS, IN THE ORDER THE POST APPLIES THEM: what the rep reads
 * (`asRepReads` — WhatsApp's markers and the invisible characters out), then
 * what the post carries (`oneLine`). One function, so "empty" means one thing
 * on both sides of the contract.
 */
export function asPosted(text: string): string {
  return oneLine(asRepReads(text));
}

/**
 * A disclosure line's provenance clause. The instant reads the way the rep
 * would say it — «hoy»/«ayer» against the post's own day, the day and
 * month beyond that — because the whole point of the line is that the rep
 * can go and check it against the conversation itself (story 6).
 *
 * EXPORTED (ticket #198), for the reason `PROVISIONAL_MARK` is: the
 * disclosure execution is served the day's lines "exactly as code will render
 * them" (spec #193 decision 22), so the recipe that shows a line to the model
 * and the renderer that puts it in front of the rep have to compose the same
 * clause. Reading it from here is what keeps those one string rather than two
 * that agree today.
 */
export function renderDisclosureProvenance(
  provenance: DisclosureProvenance,
  now: Date,
  timeZone?: string,
): string {
  const when = renderRelativeInstant(provenance.at, now, timeZone);
  return provenance.kind === "rep_act"
    ? `tú lo confirmaste, ${when}`
    : `su chat, ${when}`;
}

/**
 * The thread's answer post (ticket #35; spec #29 stories 10–11): the answer,
 * framed. It carries no sources line (Diego's ruling of 2026-10-07 on #363):
 * the twin's words are its own, and nothing code renders claims where they
 * came from.
 *
 * THE RECEIPT GOES FIRST, AND CODE PUTS IT THERE (ticket #174; spec #171
 * decision 22 — a receipt sits "inside or beside the composed sentence").
 * One post per turn, so a rep whose message both asked for something and
 * said something reads one message rather than two: what the twin DID, then
 * what it says about it. The first is the only register that is not the
 * twin's own voice — it is the effect reporting itself, and a model that
 * wrote «lo descarté» into `answer` below cannot put a word up here, because
 * the caller passes what the TOOL returned.
 *
 * ...AND THE TAUGHT LINE GOES LAST, WHEN THIS POST IS ALSO THE QUESTION
 * (tickets #195, #363). The twin handed the rep the binding question with
 * `propose_binding`, its sentence arrives here after the answer with the name
 * folded in, and code registered THIS post as the binding question for that
 * chat, so the post owes the rep the line that says how to answer it — the
 * same line `renderBindingQuestion` prints, rendered from the accepted set as
 * data, so a post the rep answers one way is never taught another.
 */
export function renderAnswerPost(args: {
  answer: string;
  /**
   * The workspace documents this post hands the rep (ticket #326): each its
   * title and version, on one line that says where it opens — the phone never
   * carries a document's text.
   */
  documents?: readonly { readonly title: string; readonly version: number }[];
  /** The list this post carries (ticket #326), each row as the rep reads it. */
  list?: readonly string[];
  /**
   * The acknowledgement of what this turn's effect tool DID, rendered from
   * the tool's own result (`RECEIPTS`). Absent when nothing was performed —
   * which includes a turn whose prose merely claimed something was.
   */
  receipt?: string;
  /**
   * Whether this post is ALSO the binding question for a chat (ticket
   * #195). Code decides it, from the ceremony's own due-ness rule, and
   * never the prose: a reply that merely reads like a question carries no
   * taught line and settles nothing.
   */
  asksBinding?: boolean;
}): string {
  const spoken =
    args.receipt === undefined
      ? args.answer
      : `${args.receipt}\n\n${args.answer}`;
  const taught =
    args.asksBinding === true ? `\n\n${bindingAnswersLine()}` : "";
  return `${SIGIL}${spoken}${besideLines(args)}${taught}`;
}

/** What a post hands the rep beside its words, as the thread prints it: the list's lines, then each document's line. */
function besideLines(beside: {
  readonly list?: readonly string[];
  readonly documents?: readonly { readonly title: string; readonly version: number }[];
}): string {
  const listed = beside.list === undefined || beside.list.length === 0 ? "" : `\n\n${renderListLines(beside.list)}`;
  const documents = (beside.documents ?? []).map((one) => `\n\n${renderDocumentLine(one.title, one.version)}`).join("");
  return `${listed}${documents}`;
}

/**
 * A WORKSPACE DOCUMENT IN THE THREAD (ticket #326; spec #318 decision 34 —
 * «the phone gets the title and a line»): its title, its version, and where
 * the rep opens it. The text stays in the twin's bundle; the card on Inicio
 * opens it.
 */
export function renderDocumentLine(title: string, version: number): string {
  return `«${title}», versión ${String(version)}: lo abres desde Inicio.`;
}

/** A list in the thread (ticket #326): its rows numbered, as the rep reads them. */
export function renderListLines(rows: readonly string[]): string {
  return rows.map((row, index) => `${String(index + 1)}. ${row}`).join("\n");
}

/**
 * A RUN'S QUESTION CARD IN THE THREAD (ticket #324): the twin's question,
 * framed, and under it each field's label and its options numbered — the
 * labels code rendered (a customer as the name the rep knows them by). No
 * instruction line: the rep answers in their own words, and the thread
 * resolves them against the options (`answer_ask`).
 */
export function renderAskPost(args: {
  readonly question: string;
  readonly fields: readonly { readonly label?: string; readonly options?: readonly string[] }[];
}): string {
  const lines = [SIGIL + args.question];
  for (const field of args.fields) {
    if (field.label !== undefined) lines.push(field.label);
    field.options?.forEach((option, index) => lines.push(`${String(index + 1)}. ${option}`));
  }
  return lines.join("\n");
}

/**
 * A RUTINA THE TWIN PROPOSES, IN THE THREAD (ticket #386): the twin's sentence,
 * framed; when it runs; and under the plan's heading each step's words, set in
 * by how deep in a branch it sits — every word but the sentence code's, handed
 * in already rendered (`runs/rutina-words.ts`). No instruction line: the rep
 * says yes or no in their own words, and the thread acts on it.
 */
export function renderProposalPost(args: {
  readonly sentence: string;
  readonly when: string;
  /** The line saying it takes the place of a rutina the rep has, when it does (Codex r2). */
  readonly replaces?: string;
  readonly planHeading: string;
  readonly plan: readonly { readonly text: string; readonly depth: number }[];
}): string {
  const plan = args.plan.map((line) => `${"  ".repeat(line.depth)}· ${line.text}`);
  return [
    SIGIL + args.sentence,
    args.when,
    ...(args.replaces === undefined ? [] : [args.replaces]),
    "",
    args.planHeading,
    ...plan,
  ].join("\n");
}

/**
 * A receipt with no words beside it — the twin acted and had nothing to say
 * (ticket #174) — or code ended a run whose report still hands the rep a list
 * or a document (ticket #358).
 *
 * THE SECOND SHAPE, and it exists because silence is a legitimate
 * answer: a rep who writes «así no» and nothing else has asked for an
 * effect and not for a conversation, and the twin that stays quiet still
 * owes them the line that says the draft is gone. It wears the frame the
 * old per-act acks wore, which is what makes `renderDismissAck` and
 * `renderCorrectionAck` special cases of it rather than a second voice.
 */
export function renderReceiptPost(
  receipt: string,
  beside: {
    readonly list?: readonly string[];
    readonly documents?: readonly { readonly title: string; readonly version: number }[];
  } = {},
): string {
  return SIGIL + receipt + besideLines(beside);
}

/**
 * Whether text wears the twin's frame. Only the grammar writes the sigil,
 * and it writes it on every twin-authored post, so this is a second and
 * independent "the twin said this" signal — used by the matcher when the
 * executor's origin tag is missing (ticket #35, Codex r1).
 */
export function isFramed(text: string): boolean {
  return text.startsWith(SIGIL);
}

/**
 * The frame, enforced at the emission seams: the notice inserter and the
 * draft emission refuse unframed text loudly, so a post that skipped this
 * module can never reach the twin thread — structural, not disciplinary.
 */
export function assertFramed(text: string): string {
  if (!text.startsWith(SIGIL)) {
    throw new Error(
      `twin post does not open with the ✳️ frame — every twin-authored post renders through the grammar (ticket #30): ${JSON.stringify(text.slice(0, 40))}`,
    );
  }
  return text;
}

/**
 * An instant with its day: day and month alongside the time, for an instant
 * far enough back that a bare clock time would be ambiguous. Same host-clock
 * caveat as the draft's provenance (#30 remainder 4).
 */
function renderDayAndTime(at: Date, timeZone?: string): string {
  const day = new Intl.DateTimeFormat("es-MX", {
    day: "numeric",
    month: "short",
    ...(timeZone === undefined ? {} : { timeZone }),
  })
    .format(at)
    .replace(/\.$/u, "");
  return `${day}, ${renderClockTime(at, timeZone)}`;
}

/**
 * An instant as the rep would name it, relative to `now`: «hoy 19:23»,
 * «ayer 18:53», «27 ago 19:23». Day boundaries are the rep's own calendar
 * days in `timeZone` (the host clock when unpinned) — «ayer» means the
 * previous CALENDAR day, never "24 hours ago", because that is what the
 * word means to the person reading it.
 */
function renderRelativeInstant(at: Date, now: Date, timeZone?: string): string {
  const days = calendarDaysBetween(at, now, timeZone);
  const time = renderClockTime(at, timeZone);
  if (days === 0) return `hoy ${time}`;
  if (days === 1) return `ayer ${time}`;
  return renderDayAndTime(at, timeZone).replace(", ", " ");
}

/**
 * Whole calendar days from `at` to `now` in `timeZone`. Computed on the
 * civil date only — no arithmetic on instants — so a DST transition
 * between the two never turns yesterday into today.
 */
export function calendarDaysBetween(
  at: Date,
  now: Date,
  timeZone?: string,
): number {
  const atDay = Date.parse(`${civilDate(at, timeZone)}T00:00:00Z`);
  const nowDay = Date.parse(`${civilDate(now, timeZone)}T00:00:00Z`);
  return Math.round((nowDay - atDay) / 86_400_000);
}

/**
 * The civil date at an instant, as `YYYY-MM-DD`. The rep's calendar day is
 * the daily disclosure's unit of idempotence (one post per twin per day),
 * so it is derived here, once, and shared by the grammar and the pass.
 */
export function civilDate(at: Date, timeZone?: string): string {
  // en-CA formats as YYYY-MM-DD; the locale is a formatting choice, never
  // rep-facing copy.
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    ...(timeZone === undefined ? {} : { timeZone }),
  }).format(at);
}

/**
 * An instant's HOUR as the rep's clock shows it (24h es-MX) — «20:30».
 *
 * PRIVATE AGAIN, AND REP-FACING ONLY. #139 briefly exported it so the
 * extraction turn could stamp its beats in the rep's own language; its
 * second ruling made everything code writes for the MODEL English
 * bracketed metadata (`renderTurnInstant`), so this has no reader outside
 * this module again — which is right, because «ayer 18:53» is a sentence a
 * person reads.
 */
function renderClockTime(at: Date, timeZone?: string): string {
  return new Intl.DateTimeFormat("es-MX", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    ...(timeZone === undefined ? {} : { timeZone }),
  }).format(at);
}
