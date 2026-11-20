/**
 * THE TRAFFIC THE EXTRACTION CONTRACT QUOTES, in one place (ticket #194; spec
 * #193 decision 17; ADR-0037 as amended).
 *
 * Every literal here is Spanish, and every one of them is `model-example` on
 * the pinned allowlist: text the model is SHOWN and no person ever reads. The
 * distinction ADR-0037's amendment draws is about the twin's own words — what
 * it says to the rep — and none of these is that. They are the material the
 * rules are about.
 *
 * WHY QUOTED AT ALL, said plainly because the sibling automations quote
 * nothing. The kind classification teaches by DEFINITION ("a company, a shop,
 * a workshop") because its whole judgement is which of two words a name is;
 * extraction's judgements are about the SHAPE OF A SENTENCE — whether «va»
 * agreed to something, whether a price per unit counted anything, whether a
 * message asked to be supplied or only asked what it would cost — and a rule
 * about a shape has to show one. Each of #59's three rules was written
 * against a measured defect, and the wording that fixed it names the traffic
 * the defect arrived in.
 *
 * WHY A MODULE OF ITS OWN. The allowlist is a record a person reads (its own
 * header), and its entries name a FILE and a literal — so one file for the
 * examples means the whole record of what the extractor quotes can be read in
 * one place, and the sweep's reverse check holds every entry to it. The
 * alternative, Spanish inline in each instruction part, would put the
 * examples inside the part's own template literal: the sweep would then flag
 * the whole part, and the record would hold a page of English with a phrase
 * buried in it rather than the phrase.
 *
 * THEY ARE NOT CORPUS STRINGS, and that rule is older than this module:
 * wording that named the fixtures would raise the fixtures' number without
 * raising anything else. `definition.test.ts` is where it is checked.
 */

/**
 * The bare yes, on its own — the case ADR-0038's pairing fence is about: a
 * word that agrees to something and names nothing.
 */
export const BARE_YES = "«va»";

/**
 * The words a rep says yes with (ticket #52; ADR-0038).
 *
 * A CLOSED LIST IN PROSE RATHER THAN A TABLE, because the rule underneath is
 * not lexical: what makes an `OrderTaken` is that the rep answered something
 * the customer asked for, and these are what that answer looks like. The
 * affirmation matcher's own accepted set (`affirmation.ts`) is a different
 * thing entirely — that one mints a tap and has to be exact.
 */
export const PLAIN_YES =
  "«va», «sale», «listo», «órale», «sí», «claro», «de acuerdo», «trato hecho», «adelante»";

/** The other way a rep agrees: by saying when it will be there. */
export const COMMITMENT_TO_SUPPLY =
  "«se los mando el lunes», «ahí se los llevo», «se los tengo el viernes», «mañana sale su pedido»";

/**
 * A gesture beat, as the day renders one (ticket #99; ADR-0041).
 *
 * The model has to know that citing a reaction LINE is allowed, so the rule
 * shows the line's own shape — the same one `reactions.ts` composes.
 */
export const REACTION_BEAT = "«[reacción 👍 a …]»";

/** ...and the beat that is a rep taking their yes back, which agrees to nothing. */
export const REACTION_WITHDRAWN = "«[reacción retirada de …]»";

/**
 * A gesture line that QUOTES its target (ticket #99; ADR-0038 as amended).
 *
 * It is the one case where the pairing fence opens on a single line: the
 * request's words are in front of the model, so both halves are visible.
 */
export const REACTION_QUOTING_ITS_TARGET =
  "«[reacción 👍 a WAMID-X: «me mandas 20 bultos?»]»";

/** Answers that are not a yes: a look-into-it and a promise to confirm later. */
export const NOT_AGREEING = "«déjame checar», «ahorita le confirmo»";

/** ...and a condition, which is a thing that has not happened. */
export const CONDITION_ON_SUPPLY = "«si me llega el material»";

/** The rep agreeing to LESS than was asked for — the terms come off the answer. */
export const REP_AGREES_TO_LESS = "«te mando 80»";

/**
 * One message that asks the price AND asks to be supplied (ticket #59, Codex
 * r2). The emphatic form of the price rule would have discarded the order
 * half, so the rule is scoped to a message that asks ONLY the price and this
 * is the case that scopes it.
 */
export const PRICE_AND_ORDER_IN_ONE =
  "«¿en cuánto me deja 40 bultos y mándemelos mañana?»";

/** What a real request to be SUPPLIED sounds like, as against a price question. */
export const ASK_TO_BE_SUPPLIED = "«mándeme …», «apárteme …», «écheme …»";

/** Four standing things a customer says about how THEY buy (ticket #61; ADR-0040). */
export const CUSTOMER_PATTERNS =
  "«nomás recibimos hasta las 2». «nosotros compramos cada quincena». «no compro nada sin garantía». «prefiero que venga en tarima, no suelto».";

/** The sentence a pattern's clause has to continue, so the clause is a clause. */
export const PATTERN_SENTENCE = "«Te dijo que …»";

/** A pattern that is really about the REP, which is the aperture breach ADR-0040 names. */
export const ABOUT_THE_REP_COMPLAINT = "«con usted siempre acabo esperando»";

/** ...and the flattering half of the same class, which is equally not a pattern. */
export const ABOUT_THE_REP_PRAISE = "«se nota que sabe vender»";

/** One message carrying both, where only the customer half may be written down. */
export const ABOUT_BOTH =
  "«con usted siempre acabo esperando, y nosotros pagamos de contado»";

/** A one-off dressed as a standing thing. */
export const ONE_OFF = "«hoy sí va de urgencia»";

/** An observation about the trade, which belongs to no customer at all. */
export const ABOUT_THE_MARKET = "«el acero anda por las nubes este año»";

/**
 * Goods named by pointing at something the day does not spell out (ticket
 * #76). The twin LOOKS for what one of these names (ticket #196), and the
 * two readings — `resolved_reference` and `unresolved_reference` — are what
 * say whether it found exactly one answer.
 */
export const POINTS_SOMEWHERE_ELSE =
  "«mándame lo mismo del pedido pasado», «lo de siempre», «la otra mitad de lo que quedó pendiente»";

/** The single-phrase form, for the wire field that carries the reading. */
export const POINTS_SOMEWHERE_ELSE_ONE = "«lo mismo del pedido pasado»";

/**
 * ...and the form that points into ANOTHER customer's conversation (ticket
 * #196; spec #193 user story 4). It is the case that makes the search's scope
 * the rep's whole history rather than one chat: a customer who orders by
 * pointing at somebody else's order is resolvable, and only over every chat.
 */
export const POINTS_AT_ANOTHER_CUSTOMER = "«mándame lo mismo que a Torres»";

/** ...and the same message when it ALSO says what the goods are, which is `stated`. */
export const POINTS_BUT_ALSO_SAYS =
  "«mándeme lo de siempre, 20 cubetas de impermeabilizante»";

/** Prices per unit, where nobody counted anything (ticket #59). */
export const PRICE_PER_UNIT =
  "«la pieza en 32 pesos», «1,900 el millar», «le sale en 480 el metro cuadrado»";

/** The third of those on its own, where the rule contrasts it with a real count. */
export const PRICE_BY_THE_SQUARE_METRE = "«le sale en 480 el metro cuadrado»";

/** The short form, for the wire field the wrong value lands in. */
export const PRICE_PER_UNIT_ONE = "«a 250 el bulto»";

/** ...and a price with a quantity actually stated, which is the contrast. */
export const PRICE_WITH_A_QUANTITY = "«los 12 tambos en 9,400»";

/** The rep committing to a day, which is a DatePromised and never an order's date (#59). */
export const REP_PROMISES_A_DAY = "«se lo dejo el 3 de agosto», «el jueves lo tiene»";

/** A customer asking FOR a day, which is the order's own date (ticket #70). */
export const CUSTOMER_ASKS_FOR_A_DAY = "«te pido 100 cajas para el lunes»";

/** A condition, which is a thing that has not happened and is not a small order. */
export const CONDITION_ON_PRICE = "«Y si me haces precio te pido más»";

/** What the rep reads when a field is simply absent — ordinary, and correctable. */
export const MISSING_FIELD_CLAUSES =
  "«sin cantidad», «sin precio» or «sin fecha»";

/** The sentence an OrderRequested renders as, which is false about a price question. */
export const ORDER_REQUESTED_SENTENCE = "«Te pidió …»";

/** The sentence a DatePromised's commitment clause has to continue. */
export const DATE_PROMISED_SENTENCE = "«Le confirmaste …»";

/** A commitment clause, for the wire field that carries one. */
export const COMMITMENT_CLAUSE = "«que tienes las 40 cajas disponibles»";

/** A pattern clause, for the wire field that carries one. */
export const PATTERN_CLAUSE = "«solo recibe material por la mañana»";
