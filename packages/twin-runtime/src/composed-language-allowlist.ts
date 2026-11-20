/**
 * THE ONE PINNED ALLOWLIST — the record of what stays a constant, and why
 * (ticket #176; spec #171 decision 27; ADR-0037 as amended 2026-09-04).
 *
 * ADR-0037's amendment does not merely permit this file, it names its job:
 * "a sweep over the rep-side packages refuses any Spanish literal outside
 * one pinned allowlist file, which *is* the record of what is chrome". So
 * this is not a test fixture and not an escape valve. It is the answer to
 * "which strings does code still own, and on what grounds" — and the two
 * sweeps beside it (`composed-language.test.ts`,
 * `runner-boundary.test.ts`) are what stop the answer going stale.
 *
 * IT IS CHECKED IN BOTH DIRECTIONS, which is `fr73-shared-stores.ts`'s
 * convention and the reason a record can be trusted: a Spanish literal in a
 * swept source that no entry names fails the sweep, AND an entry whose
 * literal no longer appears in the file it names fails it too. A retired
 * sentence therefore cannot leave a standing exemption behind.
 *
 * WHERE THE LINE IS DRAWN, said plainly because it is a judgement. This file
 * holds two kinds of entry: every literal the sweep's rules FLAG (which need
 * the exemption), and the chrome ADR-0037's amendment and ticket #176's AC 3
 * NAME BY HAND — «Borrador — para», «(sin confirmar)»,
 * «Descartado», «Enviado a …» — several of which carry no
 * accent and no inverted mark and so are invisible to the orthography rule.
 * Naming them is the point: the record is what a reader consults, not what
 * the regex happened to catch. A third case follows from those two: where a
 * SET of sibling sentences is exempted together — `factSentence`'s five
 * templates, say — the one or two of them the rules happen not to flag are
 * listed beside their siblings, because a record naming four of five would
 * read as a decision about the fifth. What is NOT here is the class neither
 * rule can see and neither document names — a bare «hoy», «ayer», «sin fecha» inside a
 * rendered clause — and `composed-language.test.ts` records that limit as its
 * own test rather than leaving it to be discovered.
 *
 * NEVER A SILENT EXEMPTION. An entry that is not chrome carries an
 * `interim:` category, a reason, and an `expiry` naming what retires it. If
 * a sentence cannot honestly be called chrome and has no expiry, it does not
 * belong on this list — it belongs out of the code.
 *
 * NO `interim:` ENTRY REMAINS, which is the state ADR-0037's amendment asks
 * for rather than a coincidence (spec #193 decision 29). Every sentence the
 * twin SPEAKS on a rep-side post is composed by an execution: the day's
 * opening and closing are the whole of the disclosure's call (#198; ticket
 * #218 is why there is no third part), the binding question is drafting's and
 * the thread's, and no literal of any of them is in code to exempt. What is
 * left on this list is chrome, receipts, button labels, the data those render
 * from, RECORD LINES, and traffic an instruction quotes.
 *
 * `interim:5b` IS NOT A CATEGORY HERE, and `interim:remainder` is: a word
 * named after one finished slice holding no entry is a word this file would
 * have to explain for ever, while "a sentence a ticket could not move" is a
 * thing that can happen again.
 *
 * WHERE THIS RECORD IS WIDER THAN TICKET #176's AC 3, said head-on rather
 * than left for a reader to count (the two-axis review's Spec axis).
 *
 * AC 3 names six frame labels and this file carries forty-two. Most of the
 * extra are the OWNER web's, which ADR-0037's owner-side amendment exempts as
 * UI chrome and which the sweep reaches only because the Ledger's renderer
 * lives in a package the rep side also uses. The rest are the disclosure's
 * provenance clauses and its own heading, and user story 21 is
 * the argument for calling them structure: "I want the twin's «(sin
 * confirmar)» marks and citation lines rendered the same every time, so
 * structure I have learned to read stays readable." They carry no expiry
 * because the structure they render has none.
 *
 * TWO MORE CATEGORIES RATHER THAN COUNTS. The thirty-four `model-example`
 * entries (tickets #194 and #196) are traffic an extraction INSTRUCTION
 * quotes, which is neither chrome nor speech: they stand where a whole-file
 * exclusion did, which narrows the record's blind spot rather than widening
 * its reach. The seventeen `record-line` entries (#198) are the disclosure's
 * own sentences, and the vocabulary below is where the three reasons for
 * them are written down.
 *
 * ONE CONVENTION FOR QUOTING A KEYWORD, and it is split by where the text
 * sits. A COMMENT may write «va» — comments are not swept, and this
 * repository's reasoning quotes the rep's own words throughout. A shipped
 * STRING may not, so the documentation strings that used to (two registry
 * notes, sixteen coverage notes, two migration descriptions, an SQL comment
 * and one refusal message) now use typographic single quotes, which collide
 * with neither quote character and so never break a nested citation. The
 * reasons in this file are the deliberate exception: a record about Spanish
 * sentences quotes the sentences it is about, and this file is excluded from
 * the sweep precisely because it holds them.
 */

/**
 * WHY A STRING IS STILL A CONSTANT. Six words, and the first four are
 * ADR-0037's own three categories plus the keyword data the third renders
 * from.
 *
 * `chrome:frame-label` — "the fixed *structure* the first paragraph
 * permits", which "the matcher and the guard depend on". A label, not a
 * sentence.
 *
 * `chrome:receipt` — "an acknowledgement of an effect rendered from the
 * tool's result … because a receipt reports what code did, and composing one
 * would let a model describe an effect it did not perform".
 *
 * `chrome:instruction-line` — the amendment's own third thing: "the
 * instruction line under a draft is neither: the keyword is a button, so its
 * instruction line is the button's label, rendered from the accepted set as
 * data". Named separately because the ADR names it separately, and because
 * it is the one category whose entries would DISAPPEAR the day the buttons
 * do (the dashboard retires them, #58).
 *
 * `chrome:keyword-set` — the accepted keyword data those labels render from
 * and `keyword_set` hands the thread execution. A single accented token is
 * not a sentence in any sense the density rule is aimed at, and it trips the
 * orthography rule on its own; the exemption is for DATA, and the data is
 * what the matcher accepts.
 *
 * `record-line` — a DISCLOSURE LINE's own sentence, rendered by code at
 * filing and stored as rendered (ticket #198; spec #193 decision 8; ADR-0034,
 * ADR-0037's 2026-09-05 amendment as corrected). Three reasons, each
 * load-bearing and none of them "it has not been composed yet": a line must
 * show every correctable field or the correction window cannot catch a wrong
 * value (#65); the verb IS the fact type, so a model that wrote «Le
 * cotizaste» over an `OrderRequested` would hand the rep a true-sounding
 * sentence about a different claim; and the agreement quote comes off the
 * seam row rather than from any model (ADR-0038). Underneath all three is
 * the design's axis — silence is a yes on a disclosure line, the one place on
 * the rep side where the twin's own words are confirmed by the rep doing
 * nothing, so a composed line would hide its own errors. Nothing retires
 * these: they are STRUCTURE, which is why they are not an `interim:` word.
 *
 * `interim:remainder` — a sentence a ticket found it could not move,
 * recorded with the remainder that owns it. The category exists so the file
 * stays honest rather than quietly calling a twin-spoken sentence chrome. It
 * holds no entry: every sentence a ticket could not move has since moved.
 *
 * `model-example` — traffic an instruction QUOTES so a rule about the shape
 * of a sentence can show one (ticket #194; spec #193 decision 17): text the
 * model is shown and no person ever reads. It is not chrome and it is not
 * interim — nothing retires it, because a rule that teaches by example needs
 * its example — so it is its own word rather than a stretched one. Every
 * entry lives in an automation's `examples.ts`, which is what lets the record
 * of what a prompt quotes be read in one place.
 *
 * `excluded-file` — ADR-0042's placeholder beats: context the model READS,
 * never something the twin says. The only category whose entry may name a
 * whole source, which is why every one of them owes an expiry.
 */
export const ALLOWLIST_CATEGORIES = [
  "chrome:frame-label",
  "chrome:receipt",
  "chrome:instruction-line",
  "chrome:keyword-set",
  "record-line",
  "interim:remainder",
  "model-example",
  "excluded-file",
] as const;

export type AllowlistCategory = (typeof ALLOWLIST_CATEGORIES)[number];

/**
 * One standing exemption.
 *
 * THE LITERAL IS AS THE SCANNER READS IT: escapes decoded, and every
 * `${…}` interpolation rendered as `{}`. Two reasons rather than one. It is
 * the SENTENCE that is chrome, and a record a person reads should hold the
 * sentence with its holes rather than the expression that fills them. And an
 * entry that quoted the expression would go stale on a rename that changed
 * no rep-facing byte, which is exactly the kind of churn that makes a
 * registry stop being read.
 *
 * THE FILE IS NAMED TOO, so the entry says WHERE the sentence lives — and so
 * the reverse check is sharp: the literal must still be in THAT file, not
 * merely somewhere in the tree.
 *
 * `literal` ABSENT EXCLUDES THE WHOLE SOURCE, and only an `excluded-file`
 * entry may do it.
 */
export interface AllowlistEntry {
  /** Repo-relative path of the source that holds it. */
  readonly file: string;
  /** The exact literal, as the scanner reads it; absent excludes the file. */
  readonly literal?: string;
  readonly category: AllowlistCategory;
  /** Why code still owns it. One sentence, in English. */
  readonly reason: string;
  /** What retires it. Required on every `interim:` entry. */
  readonly expiry?: string;
}

const GRAMMAR = "packages/twin-runtime/src/grammar.ts";
const MICROCOPY = "packages/twin-runtime/src/microcopy.ts";
const OWNER_RENDER = "packages/aperture/src/owner-render.ts";
const REACTIONS = "packages/twin-runtime/src/reactions.ts";
const AFFIRMATION = "packages/twin-runtime/src/affirmation.ts";
const EXTRACTION_EXAMPLES =
  "packages/twin-runtime/src/extraction/examples.ts";

/**
 * The record.
 *
 * GROUPED BY CATEGORY AND IN THE ORDER A READER WANTS THEM: the frame the rep
 * has learned to read, then the lines code owes them after an act, then the
 * button labels, then the data those render from, then the record lines the
 * rep checks their day against, then the traffic an instruction quotes, then
 * the sources that are context rather than speech.
 */
export const COMPOSED_LANGUAGE_ALLOWLIST: readonly AllowlistEntry[] = [
  /* ---- chrome: frame labels (ADR-0037's amendment names these by hand) --- */
  {
    file: GRAMMAR,
    literal: "✳️ ",
    category: "chrome:frame-label",
    reason:
      "The sigil. Every twin-authored post opens with it, `assertFramed` refuses one that does not, and the matcher reads it as the second origin signal for a post the lost-mapping window cannot resolve.",
  },
  {
    file: GRAMMAR,
    literal: "{}*Borrador — para {}*\n\n",
    category: "chrome:frame-label",
    reason:
      "The draft's label and counterparty line — Mock A's fixed structure, with the name as a slot code fills from the binding.",
  },
  {
    file: GRAMMAR,
    literal: "«{}»\n\n",
    category: "chrome:frame-label",
    reason:
      "The guillemet body: the frame that tells the rep which bytes would be sent if they tap, and the reason a draft's text can never be mistaken for the twin talking to them.",
  },
  {
    file: GRAMMAR,
    literal: "(sin confirmar)",
    category: "chrome:frame-label",
    reason:
      "The provisional mark on a name nobody has confirmed. Structure rather than speech, and the one rendering rule every surface that names a counterparty resolves through.",
  },
  {
    file: GRAMMAR,
    literal: "(por referencia)",
    category: "chrome:frame-label",
    reason:
      "The mark a disclosure line wears when the goods on it were arrived at by looking rather than read off the day's own words (ticket #196). Structure rather than speech, and rendered by code from the candidate's reading for the same reason the provisional mark above it is: a model asked to write it could write it on a line it read straight off the day, or leave it off one it inferred, and either way the rep would be checking the wrong lines. It names no order and no chat — the referent is the one thing this mark may never carry (ADR-0004).",
  },

  {
    file: GRAMMAR,
    literal: "su chat, {}",
    category: "chrome:frame-label",
    reason:
      "The provenance clause under a claim the twin read out of a customer chat.",
  },

  {
    file: GRAMMAR,
    literal: "tú lo confirmaste, {}",
    category: "chrome:frame-label",
    reason:
      "The provenance clause for a claim the REP confirmed rather than one the twin read — the distinction a rep checks a citation by.",
  },
  {
    file: GRAMMAR,
    literal: "hoy {}",
    category: "chrome:frame-label",
    reason:
      "How a provenance clause names today's instant. Part of the fixed rendering user story 21 asks to stay the same every time; neither rule flags a two-word fragment, so it is here because the record names it rather than because the regex did.",
  },
  {
    file: GRAMMAR,
    literal: "ayer {}",
    category: "chrome:frame-label",
    reason: "The same, for yesterday's (see above).",
  },
  {
    file: GRAMMAR,
    literal: "dato",
    category: "chrome:frame-label",
    reason:
      "The singular the disclosure heading below is pluralized with, chosen inside its own interpolation. Its SIBLING of the heading the rules do flag (Codex round 3).",
  },
  {
    file: GRAMMAR,
    literal: "datos",
    category: "chrome:frame-label",
    reason: "The plural of the same heading (see above).",
  },
  {
    file: GRAMMAR,
    literal: "{}*Hoy agregué {} {} al registro.*",
    category: "chrome:frame-label",
    reason:
      "The daily disclosure's heading, above the numbered-line frame the rep corrects lines by, with the count code computes over the lines the post carries. It stays chrome now that the post is composed (spec #193 decision 24): a composed number could disagree with the lines under it, which is why the guard refuses a digit in the composed halves at all.",
  },

  /* -------- chrome: frame labels the OWNER web renders (ADR-0037) --------- */
  {
    file: OWNER_RENDER,
    literal: "Cotización dada",
    category: "chrome:frame-label",
    reason:
      "A fact type's label on the owner's timeline. ADR-0037's owner-side amendment exempts UI chrome by name, and a fact-type tag is the room's label rather than anything a twin says. THE WHOLE FAMILY IS LISTED (Codex round 3): the rules flag only the accented labels, and a record naming three of six reads as a decision about the other three.",
  },
  {
    file: OWNER_RENDER,
    literal: "Pedido solicitado",
    category: "chrome:frame-label",
    reason: "The same label table: an order requested (see above).",
  },
  {
    file: OWNER_RENDER,
    literal: "Pedido tomado",
    category: "chrome:frame-label",
    reason: "The same label table: an order taken (see above).",
  },
  {
    file: OWNER_RENDER,
    literal: "Fecha prometida",
    category: "chrome:frame-label",
    reason: "The same label table: a date promised (see above).",
  },
  {
    file: OWNER_RENDER,
    literal: "Contacto registrado",
    category: "chrome:frame-label",
    reason: "The same label table: a contact established (see above).",
  },
  {
    file: OWNER_RENDER,
    literal: "Patrón del cliente",
    category: "chrome:frame-label",
    reason: "The same label table: a customer pattern (see above).",
  },
  {
    file: OWNER_RENDER,
    literal: "Conversación",
    category: "chrome:frame-label",
    reason:
      "The owner timeline's label for a conversational source — one of the two source labels, both listed.",
  },
  {
    file: OWNER_RENDER,
    literal: "Acto del rep",
    category: "chrome:frame-label",
    reason: "The other source label: a rep act rather than a conversation.",
  },
  {
    file: OWNER_RENDER,
    literal: "Persona",
    category: "chrome:frame-label",
    reason:
      "How an entity's kind is labelled on the owner's timeline — the display ADR-0035 says the kind is FOR. Both values listed.",
  },
  {
    file: OWNER_RENDER,
    literal: "Negocio",
    category: "chrome:frame-label",
    reason: "The other kind's label (see above).",
  },
  {
    file: OWNER_RENDER,
    literal: "teléfono",
    category: "chrome:frame-label",
    reason:
      "The owner timeline's label for a phone identifier — one of the two identifier labels.",
  },
  {
    file: OWNER_RENDER,
    literal: "RFC",
    category: "chrome:frame-label",
    reason:
      "The other identifier label. Listed as this family's sibling though it is an acronym rather than a Spanish word.",
  },
  {
    file: OWNER_RENDER,
    literal: "Cliente sin nombre legible",
    category: "chrome:frame-label",
    reason:
      "What the timeline shows where an entity's display name did not cross the wall — a label about an absence, and the wall audit is what proves the absence.",
  },
  {
    file: OWNER_RENDER,
    literal: "sin detalle",
    category: "chrome:frame-label",
    reason:
      "The fallback clause for a fact whose payload carries nothing renderable. The whole fallback family is listed for the reason the label table is.",
  },
  {
    file: OWNER_RENDER,
    literal: "{}: sin detalle",
    category: "chrome:frame-label",
    reason: "The same fallback under its own label (see above).",
  },
  {
    file: OWNER_RENDER,
    literal: "sin cantidad",
    category: "chrome:frame-label",
    reason: "The fallback for a clause with no quantity (see above).",
  },
  {
    file: OWNER_RENDER,
    literal: "sin precio",
    category: "chrome:frame-label",
    reason: "The fallback for a clause with no price (see above).",
  },
  {
    file: OWNER_RENDER,
    literal: "sin fecha",
    category: "chrome:frame-label",
    reason: "The fallback for a commitment with no date (see above).",
  },
  {
    file: OWNER_RENDER,
    literal: "sin datos",
    category: "chrome:frame-label",
    reason: "The fallback for a contact with no identifiers (see above).",
  },
  {
    file: OWNER_RENDER,
    literal: "confianza no registrada",
    category: "chrome:frame-label",
    reason:
      "How the timeline says a fact's confidence was never recorded — an absence stated rather than a number invented.",
  },
  {
    file: OWNER_RENDER,
    literal: "confianza {}",
    category: "chrome:frame-label",
    reason: "...and how it names the number when there is one (see above).",
  },
  {
    file: OWNER_RENDER,
    literal: "asiento no registrado",
    category: "chrome:frame-label",
    reason:
      "The same shape for the seat a fact was filed by, when the row carries none.",
  },
  {
    file: OWNER_RENDER,
    literal: "unidad: {}",
    category: "chrome:frame-label",
    reason: "The unit clause on a quantity, with the unit as a slot.",
  },
  {
    file: OWNER_RENDER,
    literal: "para el {}",
    category: "chrome:frame-label",
    reason:
      "The owner timeline's date clause on a commitment. Fixed structure with the date as a slot.",
  },
  {
    file: OWNER_RENDER,
    literal: " — acuerdo: «{}»",
    category: "chrome:frame-label",
    reason:
      "The owner timeline's quoted-agreement clause: the label and the guillemets are code's, the words inside are the customer's own.",
  },
  {
    file: OWNER_RENDER,
    literal: "{} {} de {}",
    category: "chrome:frame-label",
    reason:
      "How a quantity, its unit and the goods are joined into one clause — punctuation and one preposition, with every value a slot.",
  },
  {
    file: OWNER_RENDER,
    literal: "{} y {}",
    category: "chrome:frame-label",
    reason:
      "How the last two identifiers of a contact line are joined. The same family as the clause above.",
  },
  {
    file: OWNER_RENDER,
    literal: "(dirección omitida)",
    category: "chrome:frame-label",
    reason:
      "The owner-side redaction marker for an identifier the wall keeps out. A label about an absence, and the wall audit is what proves the absence.",
  },
  {
    file: OWNER_RENDER,
    literal: "(número omitido)",
    category: "chrome:frame-label",
    reason: "The same redaction marker for a number (see above).",
  },

  /* ------------------------ chrome: receipts ----------------------------- */
  {
    file: GRAMMAR,
    literal: "Descartado",
    category: "chrome:receipt",
    reason:
      "ADR-0037's own first example of a receipt: the dismissal's acknowledgement, rendered from the tool's outcome and never composed.",
  },
  {
    file: GRAMMAR,
    literal: "Listo, lo anoté.",
    category: "chrome:receipt",
    reason:
      "The receipt for a notepad write (ticket #260): the twin reports a write on the rep's own notebook, which no model may describe. A whole phrase rather than the bare participle, because every receipt is refused to the model as a substring and «anotado» alone is a word honest prose uses.",
  },
  {
    file: GRAMMAR,
    literal: "Se detuvo {run} en el paso {step} de {of}. Queda en Trabajos en curso.",
    category: "chrome:receipt",
    reason:
      "A workflow run's ending when one of its steps failed (tickets #323, #358): code ended the run, so the sentence is a receipt — posted as a `receipt` part, never as the twin's prose, and refused to the twin's own prose by the guard (`RECEIPTS.every.runEndings`); the run's name and the step fill its slots.",
  },
  {
    file: GRAMMAR,
    literal: "Paré {run}: se acabó lo que tenía para ese trabajo. Queda en Trabajos en curso.",
    category: "chrome:receipt",
    reason:
      "A workflow run's ending when its one budget was spent before a model step (tickets #323, #358): code stopped it, so the sentence is a receipt, posted and swept as the failed step's is.",
  },
  {
    file: GRAMMAR,
    literal: "Cancelé {run}.",
    category: "chrome:receipt",
    reason:
      "A workflow run's ending when the thread or the rep cancelled it (tickets #323, #358): rendered from the flag as a receipt, posted and swept as the failed step's is.",
  },
  {
    file: GRAMMAR,
    literal: "Terminé {run}.",
    category: "chrome:receipt",
    reason:
      "A workflow run's ending when an `end` step closed it with no value of its own and nothing posted before it, or a report's list came back empty (tickets #324, #358): code ended the run, so the sentence is a receipt, posted and swept as the failed step's is.",
  },
  {
    file: GRAMMAR,
    literal: "«{}», versión {}: lo abres desde Inicio.",
    category: "chrome:frame-label",
    reason:
      "A workspace document in the thread (ticket #326; spec #318 decision 34 — «the phone gets the title and a line»): code renders the title it read off the version, its number, and where the rep opens it; the document's text never reaches the phone.",
  },
  {
    file: GRAMMAR,
    literal: "«{}»",
    category: "chrome:receipt",
    reason:
      "How a run's report quotes the run's own name (ticket #323): the twin's few words for the job, in the quotes the reports above share.",
  },
  {
    file: GRAMMAR,
    literal: "Listo, corregí mis notas.",
    category: "chrome:receipt",
    reason:
      "The receipt for a rewrite of the twin's own notes the rep asked for (ticket #322): rendered from the tool's outcome, never composed, and named «mis notas» so the rep can tell it from the notepad's receipt beside it.",
  },
  {
    file: GRAMMAR,
    literal: "Listo, marqué el dato ",
    category: "chrome:receipt",
    reason:
      "The first half of the numbered correction receipt — ADR-0037's second example. It travels as two halves so the guard's matcher spans every line index a post could print.",
  },
  {
    file: GRAMMAR,
    literal: " como incorrecto.",
    category: "chrome:receipt",
    reason:
      "The second half of the same receipt, and it is honest about what happened: the fact is annotated and stays in the timeline rather than deleted.",
  },
  {
    file: GRAMMAR,
    literal: "Entendido, este chat sigue sin confirmar.",
    category: "chrome:receipt",
    reason:
      "The receipt for a declined binding — an act that writes nothing, and until #174 said nothing either.",
  },
  {
    file: GRAMMAR,
    literal: "Listo, guardé este chat como *{}*.",
    category: "chrome:receipt",
    reason:
      "The binding confirmation's receipt, unframed: the sentence is what a post's receipt part carries and the sigil belongs to the post around it. It names what was STORED rather than what was proposed, so a repeat yes reads back the binding that stands.",
  },
  {
    file: GRAMMAR,
    literal: "Enviado a {} ✓",
    category: "chrome:receipt",
    reason:
      "The send lock's own receipt, unframed for the reason the binding ack above it is: the twin reports a customer send it performed, which no model may describe.",
  },
  {
    file: MICROCOPY,
    literal: "ya se envió",
    category: "chrome:receipt",
    reason:
      "The send lock's refusal on a tap of a draft already sent — the total refusal record ADR-0017 requires, and AC 3 names the send lock's refusals as receipts.",
  },
  {
    file: MICROCOPY,
    literal: "no se pudo enviar este borrador",
    category: "chrome:receipt",
    reason: "The send lock's refusal when no valid tap resolved (see above).",
  },
  {
    file: MICROCOPY,
    literal: "no se puede enviar a este chat",
    category: "chrome:receipt",
    reason:
      "The send lock's refusal for a destination off the hard allowlist (see above).",
  },
  {
    file: MICROCOPY,
    literal:
      "no se envió: el ritmo de envíos está al límite, intenta en un momento",
    category: "chrome:receipt",
    reason: "The send lock's pacing refusal (see above).",
  },
  {
    file: MICROCOPY,
    literal: "no se envió: el envío no está configurado para este número",
    category: "chrome:receipt",
    reason:
      "The send lock's refusal for a twin with no pacing configured at all (see above).",
  },
  {
    file: MICROCOPY,
    literal: "no se envió: hay un envío en camino, espera la confirmación",
    category: "chrome:receipt",
    reason: "The send lock's refusal while a send is in flight (see above).",
  },
  {
    file: MICROCOPY,
    literal: "no se pudo enviar: no encontré el borrador de ese mensaje",
    category: "chrome:receipt",
    reason:
      "The refusal for a tap whose draft the matcher could not resolve — the one rep message the router answers with a refusal rather than an execution.",
  },
  {
    file: MICROCOPY,
    literal: "no se envió: este borrador ya fue descartado",
    category: "chrome:receipt",
    reason:
      "The refusal for a tap on a draft the rep already dismissed. Dismissal is terminal, and this is the line that says so.",
  },
  {
    file: MICROCOPY,
    literal: "este borrador tiene un dato pendiente: dáselo a Dito y queda listo para mandar",
    category: "chrome:receipt",
    reason:
      "The refusal for a tap on a draft with a blank still open (ticket #342): the send lock refuses it until the rep gives the twin the fact.",
  },
  {
    file: MICROCOPY,
    literal: "no encontré ese dato en este mensaje",
    category: "chrome:receipt",
    reason:
      "A correction refused because the post never printed that line number. Since #174 these three are the retract tool's refused-outcome reasons, which makes them a refused act's receipt.",
  },
  {
    file: MICROCOPY,
    literal: "eso todavía no se puede corregir",
    category: "chrome:receipt",
    reason:
      "A correction refused because the line is not a fact anything can retract (see above).",
  },
  {
    file: MICROCOPY,
    literal: "ese dato ya quedó firme y ya no se puede corregir",
    category: "chrome:receipt",
    reason:
      "A correction refused because the fact's window has closed (see above).",
  },

  /* --------------------- chrome: instruction lines ----------------------- */
  {
    file: GRAMMAR,
    literal: "Para enviarlo, responde a este mensaje citándolo con «{}».",
    category: "chrome:instruction-line",
    reason:
      "The draft's instruction line — a button's label, with the accepted word rendered from `AFFIRMATIONS.proposal` as data, so the twin can only ever teach a word the matcher really accepts.",
  },
  {
    file: GRAMMAR,
    literal: "Para confirmarlo, responde a este mensaje citándolo con «{}».",
    category: "chrome:instruction-line",
    reason:
      "The binding question's instruction line, rendered from `AFFIRMATIONS.question` the same way. This is AC 4's «the question post's instruction line renders from the accepted answers as data», landed at #172 and narrowed to the yes alone at #174.",
  },
  {
    file: GRAMMAR,
    literal: "{}¿Este chat es de {}?\n\n",
    category: "chrome:instruction-line",
    reason:
      "A keyword button's own prompt, and the only answer to it is the taught word (spec #193 decision 9). Two callers are left and both ask it bare, with nothing of the twin's around it: the day's read's proposal for a chat with traffic and no binding, which runs no execution at all, and drafting's fallback for a turn that composed no sentence, because the ceremony never blocks a draft. The thread composes its own into the reply it is already sending (#195), which is why this is no longer an interim entry — the sentence that is left is a label on the button the rep presses, exactly as the instruction line under a draft is, and it retires with the buttons when the dashboard arrives (#58).",
  },

  /* ----------------------- chrome: keyword sets -------------------------- */
  {
    file: AFFIRMATION,
    literal: "sí",
    category: "chrome:keyword-set",
    reason:
      "One of the words a bare quoted yes on a binding question may be. It is matcher DATA, not a sentence: the instruction lines above render from this set, and `keyword_set` hands it to the thread execution.",
  },
  {
    file: AFFIRMATION,
    literal: "si",
    category: "chrome:keyword-set",
    reason:
      "Its unaccented spelling — the one a rep types on a phone keyboard, and the one the binding question's instruction line teaches. Listed because it is the accented word's SIBLING: the rules flag only the accented one, and a record naming one of a keyword set reads as a decision about the rest (Codex round 3).",
  },
  {
    file: AFFIRMATION,
    literal: "va",
    category: "chrome:keyword-set",
    reason:
      "The tap's own word, accepted on a proposal and on a binding question both. Same set, same reason (see above).",
  },
  {
    file: "packages/twin-runtime/src/thread/recipes.ts",
    literal: "«{}»",
    category: "chrome:keyword-set",
    reason:
      "How the accepted keyword set is rendered for the thread execution — the guillemets are the frame around a word that came from `AFFIRMATIONS`, never a word this file wrote.",
  },

  /* ---------- record lines: the disclosure's own sentences (#198) --------- */
  {
    file: GRAMMAR,
    literal: "Le cotizaste {}.",
    category: "record-line",
    reason:
      "A disclosure line's sentence for a quote given — one of `factSentence`'s templates, rendered into the daily post code still owns.",
  },
  {
    file: GRAMMAR,
    literal: "en",
    category: "record-line",
    reason:
      "The preposition a quote's commercial clause is composed with — a parameter to the clause renderer, so it lands inside the sentence above. Its SIBLING of the templates the rules flag (Codex round 3).",
  },
  {
    file: GRAMMAR,
    literal: "por",
    category: "record-line",
    reason:
      "The same preposition for an order requested and an order taken (see above).",
  },
  {
    file: GRAMMAR,
    literal: "Te pidió {}.",
    category: "record-line",
    reason:
      "A disclosure line's sentence for an order requested (see above).",
  },
  {
    file: GRAMMAR,
    literal: "Le confirmaste el pedido de {}. {}",
    category: "record-line",
    reason: "A disclosure line's sentence for an order taken (see above).",
  },
  {
    file: GRAMMAR,
    literal: "Le confirmaste {} — {}.",
    category: "record-line",
    reason:
      "A disclosure line's sentence for a date promised (see above).",
  },
  {
    file: GRAMMAR,
    literal: "Te dijo que {}.",
    category: "record-line",
    reason:
      "A disclosure line's sentence for a customer pattern (see above), and the clause extraction is told to continue.",
  },
  {
    file: GRAMMAR,
    literal: "Dijiste: «{}».",
    category: "record-line",
    reason:
      "How an agreed order quotes the rep's own words back — `agreedWords`, inside a disclosure line.",
  },
  {
    file: GRAMMAR,
    literal: "Confirmaste con {}: «{}».",
    category: "record-line",
    reason:
      "The same clause when the rep agreed with a gesture rather than words (see above).",
  },
  {
    file: GRAMMAR,
    literal: " para el {}",
    category: "record-line",
    reason:
      "The date clause inside a disclosure line's commercial sentence (see above).",
  },
  {
    file: GRAMMAR,
    literal: "sin cantidad",
    category: "record-line",
    reason:
      "How a commercial clause STATES an absence rather than rendering nothing — a quote with no quantity in it (Codex round 1 found these three missing: neither rule flags a two-word fragment, and their four siblings above are on the list).",
  },
  {
    file: GRAMMAR,
    literal: "sin precio",
    category: "record-line",
    reason: "The same, for a clause with no price (see above).",
  },
  {
    file: GRAMMAR,
    literal: "sin fecha",
    category: "record-line",
    reason:
      "The same, for a commitment with no date — and it is the one absence that MUST be said, because a promise with no day read as a promise with no condition is the wrong the field exists to prevent.",
  },
  {
    file: GRAMMAR,
    literal: "sus datos de contacto",
    category: "record-line",
    reason:
      "How a contact disclosure line names an unnamed counterparty's details (see above).",
  },
  {
    file: GRAMMAR,
    literal: "los datos de contacto de {}",
    category: "record-line",
    reason: "The same, when the contact has a name (see above).",
  },
  {
    file: GRAMMAR,
    literal: "Guardé {}: {}.",
    category: "record-line",
    reason:
      "The contact disclosure line itself — `contactLine` (see above).",
  },
  {
    file: GRAMMAR,
    literal: "Lo di de alta como cliente.",
    category: "record-line",
    reason:
      "The entity create's disclosure line — the sentence the crossing writes into the day's post. Filed by all three kind-classification call sites, and still code-rendered.",
  },

  /* ------------------- model-facing examples (ticket #194) ---------------- */
  {
    file: EXTRACTION_EXAMPLES,
    literal:
      "«va»",
    category: "model-example",
    reason:
      "The bare yes on its own — ADR-0038's pairing fence is about exactly this: a word that agrees to something and names nothing, so an OrderTaken cannot be recorded from it alone.",
  },
  {
    file: EXTRACTION_EXAMPLES,
    literal:
      "«va», «sale», «listo», «órale», «sí», «claro», «de acuerdo», «trato hecho», «adelante»",
    category: "model-example",
    reason:
      "What a rep saying yes looks like, for the OrderTaken rule. The judgement is about the shape of an answer, so the rule has to show one; the affirmation matcher's own accepted set is a different thing that mints a tap.",
  },
  {
    file: EXTRACTION_EXAMPLES,
    literal:
      "«se los mando el lunes», «ahí se los llevo», «se los tengo el viernes», «mañana sale su pedido»",
    category: "model-example",
    reason:
      "The other way a rep agrees — by saying when it will be there — which the rule has to name or a commitment reads as no answer at all.",
  },
  {
    file: EXTRACTION_EXAMPLES,
    literal:
      "«[reacción 👍 a …]»",
    category: "model-example",
    reason:
      "The shape of a gesture BEAT as the day renders one (ticket #99; ADR-0041), so the model knows a reaction line is a line it may cite.",
  },
  {
    file: EXTRACTION_EXAMPLES,
    literal:
      "«[reacción retirada de …]»",
    category: "model-example",
    reason:
      "The beat that is a rep taking their yes back, which the OrderTaken rule must exclude by name.",
  },
  {
    file: EXTRACTION_EXAMPLES,
    literal:
      "«[reacción 👍 a WAMID-X: «me mandas 20 bultos?»]»",
    category: "model-example",
    reason:
      "A gesture line QUOTING its target — the one case where both halves of an OrderTaken are visible on one line (ADR-0038 as amended).",
  },
  {
    file: EXTRACTION_EXAMPLES,
    literal:
      "«déjame checar», «ahorita le confirmo»",
    category: "model-example",
    reason:
      "Answers that are not a yes, for the rule that says what is NOT agreeing.",
  },
  {
    file: EXTRACTION_EXAMPLES,
    literal:
      "«si me llega el material»",
    category: "model-example",
    reason:
      "A condition, which the same rule excludes: a thing that has not happened is not a small order.",
  },
  {
    file: EXTRACTION_EXAMPLES,
    literal:
      "«te mando 80»",
    category: "model-example",
    reason:
      "The rep agreeing to less than was asked for, which is where an OrderTaken's terms come from.",
  },
  {
    file: EXTRACTION_EXAMPLES,
    literal:
      "«¿en cuánto me deja 40 bultos y mándemelos mañana?»",
    category: "model-example",
    reason:
      "One message that asks the price AND asks to be supplied — the case that scopes #59's price rule, which an emphatic form would have over-applied (its own Codex round 2).",
  },
  {
    file: EXTRACTION_EXAMPLES,
    literal:
      "«mándeme …», «apárteme …», «écheme …»",
    category: "model-example",
    reason:
      "What a real request to be SUPPLIED sounds like, as against a price question — the contrast #59's third rule turns on.",
  },
  {
    file: EXTRACTION_EXAMPLES,
    literal:
      "«nomás recibimos hasta las 2». «nosotros compramos cada quincena». «no compro nada sin garantía». «prefiero que venga en tarima, no suelto».",
    category: "model-example",
    reason:
      "Four standing things a customer says about how THEY buy — the positive case of CustomerPattern, whose rule is otherwise almost entirely negative space (ADR-0040).",
  },
  {
    file: EXTRACTION_EXAMPLES,
    literal:
      "«Te dijo que …»",
    category: "model-example",
    reason:
      "The sentence a pattern's clause has to continue, so what is stored is a clause rather than a copied message (ADR-0040).",
  },
  {
    file: EXTRACTION_EXAMPLES,
    literal:
      "«con usted siempre acabo esperando»",
    category: "model-example",
    reason:
      "A complaint about the REP, which reads like a pattern and is the aperture breach ADR-0040 names.",
  },
  {
    file: EXTRACTION_EXAMPLES,
    literal:
      "«se nota que sabe vender»",
    category: "model-example",
    reason:
      "The flattering half of the same class, listed beside its sibling because a record naming one would read as a decision about the other.",
  },
  {
    file: EXTRACTION_EXAMPLES,
    literal:
      "«con usted siempre acabo esperando, y nosotros pagamos de contado»",
    category: "model-example",
    reason:
      "One message carrying both, where only the customer half may be written down — the case the rule exists for.",
  },
  {
    file: EXTRACTION_EXAMPLES,
    literal:
      "«hoy sí va de urgencia»",
    category: "model-example",
    reason:
      "A one-off dressed as a standing thing, the second of CustomerPattern's four look-alikes.",
  },
  {
    file: EXTRACTION_EXAMPLES,
    literal:
      "«el acero anda por las nubes este año»",
    category: "model-example",
    reason:
      "An observation about the trade, the fourth: it belongs to no customer, so there is nowhere to put it.",
  },
  {
    file: EXTRACTION_EXAMPLES,
    literal:
      "«mándame lo mismo del pedido pasado», «lo de siempre», «la otra mitad de lo que quedó pendiente»",
    category: "model-example",
    reason:
      "Goods named by pointing at something the day does not spell out — the reading `unresolved_reference` exists for these, and marking one truthfully is the whole job (ticket #76).",
  },
  {
    file: EXTRACTION_EXAMPLES,
    literal:
      "«lo mismo del pedido pasado»",
    category: "model-example",
    reason:
      "The single-phrase form, in the submission schema's own description of that reading — the line the model reads beside the value it is choosing.",
  },
  {
    file: EXTRACTION_EXAMPLES,
    literal: "«mándame lo mismo que a Torres»",
    category: "model-example",
    reason:
      "The reference that points into ANOTHER customer's conversation (ticket #196). The looking rule needs it because it is what makes the search's scope the rep's whole history rather than one chat: a customer who orders by pointing at somebody else's order is resolvable, and only over every chat.",
  },
  {
    file: EXTRACTION_EXAMPLES,
    literal:
      "«mándeme lo de siempre, 20 cubetas de impermeabilizante»",
    category: "model-example",
    reason:
      "The same message when it ALSO says what the goods are, which is `stated` — the contrast that keeps the reading from over-firing.",
  },
  {
    file: EXTRACTION_EXAMPLES,
    literal:
      "«la pieza en 32 pesos», «1,900 el millar», «le sale en 480 el metro cuadrado»",
    category: "model-example",
    reason:
      "Prices per unit, where nobody counted anything: #59's first measured rule, four of twenty-five wrong crossings.",
  },
  {
    file: EXTRACTION_EXAMPLES,
    literal:
      "«le sale en 480 el metro cuadrado»",
    category: "model-example",
    reason:
      "The third of those on its own, where the rule contrasts a rate with a real count.",
  },
  {
    file: EXTRACTION_EXAMPLES,
    literal:
      "«a 250 el bulto»",
    category: "model-example",
    reason:
      "The short form, in the schema description for `quantity` — the field the wrong value lands in.",
  },
  {
    file: EXTRACTION_EXAMPLES,
    literal:
      "«los 12 tambos en 9,400»",
    category: "model-example",
    reason:
      "A price with a quantity actually stated, which is what makes the rate rule a distinction rather than a ban on numbers.",
  },
  {
    file: EXTRACTION_EXAMPLES,
    literal:
      "«se lo dejo el 3 de agosto», «el jueves lo tiene»",
    category: "model-example",
    reason:
      "The rep committing to a day, which is a DatePromised and never an order's date: #59's largest class, twelve of twenty-five.",
  },
  {
    file: EXTRACTION_EXAMPLES,
    literal:
      "«te pido 100 cajas para el lunes»",
    category: "model-example",
    reason:
      "A customer asking FOR a day, in the schema description for `due_on` — the claim that field carries on a commercial fact (ticket #70).",
  },
  {
    file: EXTRACTION_EXAMPLES,
    literal:
      "«Y si me haces precio te pido más»",
    category: "model-example",
    reason:
      "A condition, for the rule that says what is still nothing whatever the reading.",
  },
  {
    file: EXTRACTION_EXAMPLES,
    literal:
      "«sin cantidad», «sin precio» or «sin fecha»",
    category: "model-example",
    reason:
      "What the rep reads when a field is simply absent — the clauses that make a missing field ordinary and correctable rather than a reason to mark a fact unresolved.",
  },
  {
    file: EXTRACTION_EXAMPLES,
    literal:
      "«Te pidió …»",
    category: "model-example",
    reason:
      "The sentence an OrderRequested renders as, which is false about a message that only asked the price — #59's third rule quotes the line to say why.",
  },
  {
    file: EXTRACTION_EXAMPLES,
    literal:
      "«Le confirmaste …»",
    category: "model-example",
    reason:
      "The sentence a DatePromised's commitment clause has to continue, so the clause is a clause.",
  },
  {
    file: EXTRACTION_EXAMPLES,
    literal:
      "«que tienes las 40 cajas disponibles»",
    category: "model-example",
    reason:
      "A commitment clause, in the schema description for `commitment` — the field whose example taught the model to put the day in the prose until #65 moved it.",
  },
  {
    file: EXTRACTION_EXAMPLES,
    literal:
      "«solo recibe material por la mañana»",
    category: "model-example",
    reason:
      "A pattern clause, in the schema description for `pattern` — the whole of what a CustomerPattern stores (ADR-0040).",
  },

  /* -------------------------- excluded sources --------------------------- */
  {
    file: REACTIONS,
    literal: "reacción retirada",
    category: "excluded-file",
    reason:
      "A gesture beat: rendered by code from the kind into the conversation window the model READS, and never posted to the rep. ADR-0042 is explicit that the twin's own words about a gesture or an unreadable delivery are composed.",
  },
  {
    file: REACTIONS,
    literal: "reacción {}",
    category: "excluded-file",
    reason: "The same beat when the emoji was placed rather than removed.",
  },
  {
    file: REACTIONS,
    literal: ": «{}»",
    category: "excluded-file",
    reason:
      "How a gesture beat quotes the message it points at, so the model can see what was reacted to.",
  },
  {
    file: "packages/seam/src/wa-payload.ts",
    literal: "[mensaje que no se pudo leer]",
    category: "excluded-file",
    reason:
      "The same placeholder beat as the file above, in the module that types the rail's payloads — ADR-0042's «[foto]», «[nota de voz]», «[mensaje que no se pudo leer]», of which only this one trips the rules. Scoped to the LITERAL rather than the file, because the rest of that source is the rail codec and should stay swept.",
  },
];

/**
 * WHERE THE SWEEP LOOKS — the rep side's packages, by name.
 *
 * `twin-runtime` is where the twin's own words live; `execution` is the
 * runtime that renders its prompts; `aperture`, `bundle` and `seam` are the
 * three libraries a rep-facing string could hide in behind an import, which
 * is exactly how `[mensaje que no se pudo leer]` came to be two modules away
 * from the surface that renders it. `scripted-model` is dev-only and holds
 * the scripted wire; it is swept because a Spanish fixture that drifted into
 * it would be a constant every suite in the repo could reach for.
 *
 * `notify` (ticket #219) JOINS THEM AND HOLDS NO ENTRY, which is the whole
 * point of sweeping it: every word notify sends is a template in
 * `@dito/copy`, so a Spanish literal in its own source would be a message
 * assembled somewhere the copy check cannot see and the catalog cannot
 * refuse. It is the strongest available form of "no composed prose anywhere
 * in notify" — an emptiness asserted rather than trusted.
 *
 * `owner-twin` IS NOT HERE, and must not be: it has its own sweep with the
 * stronger claim — no allowlist at all (`owner-twin/src/composed-language.test.ts`)
 * — and folding the two would weaken it. `apps/owner-web` is the owner web's
 * chrome, which ADR-0037 exempts by name.
 *
 * `copy` IS NOT HERE EITHER, and cannot be (ticket #219). It IS the record of
 * every rep-facing string — the same reason this allowlist file is excluded
 * from its own sweep — so sweeping it would report the package as one long
 * violation of a rule it exists to satisfy. What holds it instead is the rule
 * running the other way: `scripts/copy-check.mjs` refuses a rep-facing
 * literal ANYWHERE ELSE in rep-web, so a string outside the package is the
 * failure and a string inside it is the design. ADR-0037's sentence — "one
 * pinned allowlist file, which *is* the record of what is chrome" — now has a
 * second record beside it, which is a consequence for the docs PR rather
 * than a decision this ticket may take.
 */
export const SWEPT_PACKAGES = [
  "twin-runtime",
  "execution",
  "aperture",
  "bundle",
  "seam",
  "scripted-model",
  "notify",
] as const;

/**
 * THE HARNESS LIVES IN `@dito/execution` AND NOWHERE ELSE (ticket #176 AC 2;
 * ticket #194; ticket #328).
 *
 * THE LIST IS EMPTY, which is what #176's AC 2 asks for and what #194
 * delivers: every rep-side model loop is an automation, so no source outside
 * `packages/execution` reaches the Agent SDK or builds a tool server, and
 * `runner-boundary.test.ts` asserts the emptiness rather than trusting it.
 *
 * IT STAYS AS A SHAPE rather than being deleted with its last entry, and the
 * reason is the sweep beside it: a fifth harness appearing needs somewhere to
 * be recorded with an expiry, and a rule whose escape hatch has to be
 * re-invented is one somebody weakens instead.
 */
export interface RunnerBoundaryExclusion {
  /** Repo-relative path of the source that still reaches the harness itself. */
  readonly file: string;
  readonly reason: string;
  /** Required: an exclusion with no expiry is a boundary that has moved. */
  readonly expiry: string;
}

export const RUNNER_BOUNDARY_EXCLUSIONS: readonly RunnerBoundaryExclusion[] = [];
