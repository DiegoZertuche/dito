/**
 * THE LOOKING CASES (ticket #199; spec #193 decisions 11 and 12; ADR-0039
 * as amended).
 *
 * Four days whose facts cannot be read off the day at all. A customer writes
 * «me manda lo mismo del pedido pasado?» and the goods are in an earlier day;
 * «mándame lo mismo que a Ochoa» and they are in another customer's
 * conversation. The extraction can go and look — three reads over twin
 * memory (#196) — and these four days are what measures whether looking
 * pays: without history the corpus embeds nothing, and every search in it
 * comes back empty (#206's remainder 5).
 *
 * THEY ARE THEIR OWN ROW AND NEVER FOLDED IN (spec #193 decision 11). The
 * before/after pair is over the ORIGINAL labels, which is what makes it a
 * claim about the same labels under a different extractor; these four days
 * are new material and would move the number by being added rather than by
 * anything the extractor did.
 *
 * WHAT EACH ONE IS FOR, and the two endings ADR-0039 as amended gives:
 *
 * - `l-pedido-pasado-mismo-chat` — exactly one referent, in this chat's own
 *   history. Resolved: the fact files the goods it referred to, and code
 *   marks the line «(por referencia)».
 * - `l-referencia-a-otro-cliente` — exactly one referent, in ANOTHER
 *   customer's conversation. Resolved the same way, and the referent's name
 *   may not reach what is filed (ADR-0004).
 * - `l-dos-candidatos-distintos` — two referents that differ. Dropped and
 *   counted; no fact, no question.
 * - `l-referencia-a-nada` — nothing to resolve. Dropped and counted.
 *
 * EVERY DAY DECLARES WHAT IT MAY NEVER FILE (`neverFiled`), the two silent
 * ones included: a fact filed on a day that should have filed none is exactly
 * where a referent's name reaches the record with no label to catch it.
 *
 * THE HISTORY IS OUT OF SIGHT ON PURPOSE. The extraction is shown the last
 * `DEFAULT_TRANSCRIPT_LIMIT` lines before the window as already-handled
 * context, so a referent among those twenty is resolvable with no tool call
 * and the case would measure the context recipe instead of the reads. Every
 * history here is longer than that limit, with the referent as its oldest
 * beat; the rest is the ordinary talk that fills a real chat between orders.
 * `corpus.test.ts` holds that property rather than trusting this paragraph.
 */
import type { SeedMessage, SeedTranscript } from "../corpus.ts";

/**
 * THE LINES THE MODEL IS SHOWN AS ALREADY-HANDLED CONTEXT, and there are
 * exactly `DEFAULT_TRANSCRIPT_LIMIT` of them.
 *
 * Nothing here names goods, a quantity or a price: their whole job is to be
 * the twenty lines the recent-transcript part carries, so a case that
 * resolves has resolved from the SEARCH and not from the recipe. That is what
 * `corpus.test.ts` checks — every beat inside the twenty is one of these,
 * which is the property the length alone cannot state: a filler prepended
 * before a referent would keep the history long and put the referent back in
 * sight.
 *
 * EXPORTED for that guard, and for no other reader.
 */
export const ORDINARY_TALK: readonly (readonly [boolean, string])[] = [
  [false, "buenas tardes, ¿todo bien por allá?"],
  [true, "todo bien por acá, ¿y usted?"],
  [false, "aquí andamos, con la obra parada por la lluvia"],
  [true, "sí, está pesado el clima esta semana"],
  [false, "oiga, ¿el camión pasa por la caseta nueva?"],
  [true, "sí, ahora se va por la lateral, sale igual de rápido"],
  [false, "va, gracias"],
  [true, "cualquier cosa me escribe"],
  [false, "buenos días"],
  [true, "buenos días, ¿cómo amaneció?"],
  [false, "bien, gracias a Dios"],
  [true, "me da gusto"],
  [false, "¿el chofer es el mismo de siempre?"],
  [true, "sí, don Chuy, él conoce la entrada"],
  [false, "perfecto, con él nos entendemos"],
  [true, "sale"],
  [false, "¿ustedes abren el sábado?"],
  [true, "medio día, hasta la una"],
  [false, "ah ok, entonces le caigo entre semana"],
  [true, "aquí lo esperamos"],
];

/**
 * The ordinary talk, placed in one chat: a real chat standing between the
 * referent and the day.
 *
 * ONE SHAPE, MANY CHATS, and the id prefix is the caller's because the corpus
 * dedupes on ids globally (ADR-0005).
 */
function fillerAfter(prefix: string, from: number): SeedMessage[] {
  return ORDINARY_TALK.map(([fromMe, text], index) => ({
    id: `${prefix}-F${String(index + 1).padStart(2, "0")}`,
    fromMe,
    // Spread across the days between the referent and the window, oldest
    // first: the block is what the model is shown as already handled, and a
    // pile of beats at one instant would read as one burst rather than as
    // the weeks a chat actually spans.
    atMinute: from + index * 60,
    text,
  }));
}

/**
 * THE WORD THAT IDENTIFIES EVERY CUSTOMER THIS CORPUS NAMES, and every
 * looking day forbids all of them (Codex r2 and r3).
 *
 * A day that forbade only its own customer measured the wrong leak: a search
 * returns rows from every chat with something in twin memory and `list_chats`
 * shows the model all fifty-one display names, so a wrong resolution files
 * ANOTHER customer's identity — «cemento gris de Ochoa» on Aceros Lucero's
 * day, «los de Fuentes» on Ferretería Ochoa's — and a list of one name
 * reported zero leaks either way.
 *
 * THE DISTINCTIVE HALF, never the whole display name and never the trade
 * word: five customers here are a «Ferretería» and four are «Materiales», so
 * those name no conversation, while «Fuentes» and «Ochoa» each name exactly
 * one. Sweeping a whole display name instead would be walked past by the
 * abbreviation a person actually writes.
 *
 * WHY IT IS SAFE HERE, where a name blacklist in the APERTURE is not (Diego's
 * ruling on #206's remainder 3): this is a measurement over a corpus whose
 * every word is in the tree, so the collision the ruling refuses — a customer
 * called «Cemex» colliding with the goods — is checkable rather than hoped
 * for. `corpus.test.ts` refuses any token here that appears in the corpus's
 * own conversation, because a token that turns up in ordinary traffic will
 * fire on ordinary goods prose instead of on an identity.
 *
 * ON THE DAYS' OWN `neverFiled`, and therefore in the corpus digest: what
 * counts as a leak is graded against, so widening this list without re-running
 * would leave a recorded leak count describing a rule the corpus no longer
 * has.
 */
const CORPUS_CUSTOMERS = [
  // The four looking days' own — the only identities a SEARCH can serve,
  // because they are the only chats with history in twin memory.
  "Ochoa",
  "Zavala",
  "Lucero",
  "Robles",
  // ...and every customer `list_chats` shows the model beside them.
  "Beltrán",
  "Peralta",
  "Golfo",
  "Poniente",
  "Salinas",
  "Treviño",
  "Rivas",
  "López",
  "Santoyo",
  "Aguilar",
  "Elizondo",
  "Mireles",
  "Vega",
  "Arriaga",
  "Peña",
  "Cavazos",
  "Borrego",
  "Fuentes",
  "Serrano",
  "Medina",
  "Vallejo",
  "Molina",
  "Quiroz",
  "Sada",
  "Tapia",
  "Zúñiga",
  "Central",
  "Norte",
  "Centro",
  "Ruiz",
];

export const LOOKING_TRANSCRIPTS: readonly SeedTranscript[] = [
  {
    id: "l-pedido-pasado-mismo-chat",
    exercises:
      "a back-reference to this chat's own earlier order: the goods are in the history and nowhere in the day",
    counterparty: "Ferretería Ochoa",
    neverFiled: [...CORPUS_CUSTOMERS, "pedido", "chat", "lo mismo"],
    history: [
      {
        id: "LA-00",
        fromMe: false,
        atMinute: -4320,
        text: "mándame 300 bultos de cemento gris",
      },
      ...fillerAfter("LA", -2880),
    ],
    messages: [
      {
        id: "LA-D1",
        fromMe: false,
        atMinute: 545,
        text: "buenos días, ¿me manda lo mismo del pedido pasado?",
      },
      {
        id: "LA-D2",
        fromMe: true,
        atMinute: 552,
        text: "buenos días! permítame revisar existencias y le confirmo",
      },
    ],
    labels: [
      {
        messageId: "LA-D1",
        factType: "OrderRequested",
        because:
          "the customer asks to be sent the same as their previous order — «¿me manda lo mismo del pedido pasado?» — and this chat's history holds exactly one earlier order, «mándame 300 bultos de cemento gris», so a correct reading files those goods and that quantity (spec #193 decision 2; ADR-0039 as amended). The referent itself may not appear in what is filed (ADR-0004)",
        checks: [
          { path: "quantity", equals: 300 },
          // THE GOODS, not only the number (Codex r1). A crossing for «300
          // varilla» recovers the quantity and files the wrong product, and a
          // label that pinned only `quantity` would credit it as a successful
          // resolution. `contains` is this corpus's shape for prose the model
          // authors: each token is a content word out of the referent's own
          // sentence, so any phrasing that keeps them passes.
          //
          // AND THE QUALIFIER, because «cemento blanco» is a different
          // material at a different price (Codex r2): what the referent says
          // is grey cement, and a resolution that changed the colour carried
          // the number across and not the goods.
          { path: "item", contains: "cemento" },
          { path: "item", contains: "gris" },
          // THE UNIT IS A VALUE HERE, not a phrasing (Codex r2, r3). It is
          // ungraded everywhere else in this corpus for the reason
          // `STRUCTURED_FIELDS` gives — there is no defensible exact
          // expectation for prose the model authors — but on a day whose
          // whole claim is that a value was carried across from an earlier
          // one, «toneladas» in place of «bultos» is a wrong record and not a
          // wording.
          //
          // ACROSS BOTH FIELDS IT CAN BE FILED IN, which is what `orIn` is
          // for: the twin may put «bultos» in `unit` or fold it into `item`,
          // and both are honest — while `absentOrEquals` on `unit` alone
          // accepted «toneladas de cemento gris» in `item` with `unit` empty.
          { path: "unit", orIn: "item", contains: "bultos" },
          // The referent order names no price and no day, so carrying either
          // would be invention rather than a value read by reference.
          { path: "amount", absent: true },
          { path: "currency", absent: true },
          { path: "requestedFor", absent: true },
          { path: "item", lacks: "Ochoa" },
          { path: "item", lacks: "pedido" },
          { path: "unit", lacks: "Ochoa" },
          { path: "unit", lacks: "pedido" },
        ],
      },
    ],
    silent: [
      {
        messageId: "LA-D2",
        because:
          "checking stock is not a quote, a date or an order — the rep commits to nothing",
      },
    ],
  },

  {
    id: "l-referencia-a-otro-cliente",
    exercises:
      "a reference across chats: «lo mismo que a Ochoa», whose referent is in Ferretería Ochoa's own conversation",
    counterparty: "Bloquera Zavala",
    neverFiled: [...CORPUS_CUSTOMERS, "pedido", "chat", "lo mismo"],
    history: [
      {
        id: "LB-00",
        fromMe: false,
        atMinute: -4380,
        text: "quedamos entonces para la próxima entrega",
      },
      ...fillerAfter("LB", -2820),
    ],
    messages: [
      {
        id: "LB-D1",
        fromMe: false,
        atMinute: 580,
        text: "buenas, mándame lo mismo que a Ochoa",
      },
      {
        id: "LB-D2",
        fromMe: true,
        atMinute: 590,
        text: "buenas! permítame revisar existencias y le confirmo",
      },
    ],
    labels: [
      {
        messageId: "LB-D1",
        factType: "OrderRequested",
        because:
          "the customer asks to be sent what another customer was sent — «mándame lo mismo que a Ochoa» — and Ferretería Ochoa's conversation holds exactly one order, 300 bultos de cemento gris, so a correct reading files those goods (spec #193 decision 2). Nothing about WHICH chat or WHOSE order may cross with it (ADR-0004)",
        checks: [
          { path: "quantity", equals: 300 },
          // The goods the referent named, as on the same-chat case above.
          { path: "item", contains: "cemento" },
          { path: "item", contains: "gris" },
          { path: "unit", orIn: "item", contains: "bultos" },
          { path: "amount", absent: true },
          { path: "currency", absent: true },
          { path: "requestedFor", absent: true },
          { path: "item", lacks: "Ochoa" },
          { path: "item", lacks: "lo mismo" },
          { path: "unit", lacks: "Ochoa" },
          { path: "unit", lacks: "lo mismo" },
        ],
      },
    ],
    silent: [
      {
        messageId: "LB-D2",
        because:
          "checking stock is not a quote, a date or an order — the rep commits to nothing",
      },
    ],
  },

  {
    id: "l-dos-candidatos-distintos",
    exercises:
      "two differing referents in one chat's history — the case the twin must not choose between, so nothing is filed and nothing is asked",
    counterparty: "Aceros Lucero",
    neverFiled: [...CORPUS_CUSTOMERS, "pedido", "chat", "lo mismo"],
    history: [
      {
        id: "LC-00",
        fromMe: false,
        atMinute: -5760,
        text: "mándame 500 rollos de alambre recocido",
      },
      {
        id: "LC-01",
        fromMe: false,
        atMinute: -4320,
        text: "mándame 200 rollos de alambre recocido",
      },
      ...fillerAfter("LC", -2760),
    ],
    messages: [
      {
        id: "LC-D1",
        fromMe: false,
        atMinute: 610,
        text: "buenas, mándeme lo mismo de la vez pasada",
      },
      {
        id: "LC-D2",
        fromMe: true,
        atMinute: 615,
        text: "claro, ahorita lo reviso y le digo",
      },
    ],
    labels: [],
    silent: [
      {
        messageId: "LC-D1",
        because:
          "«mándeme lo mismo de la vez pasada» points at one of two different orders this chat has made — 500 and 200 rollos de alambre recocido — and nothing in the day chooses between them, so the candidate is dropped rather than guessed at or asked about (ADR-0039 as amended; spec #193 decision 2). Filing either quantity would put an order the customer never placed in the rep's record",
      },
      {
        messageId: "LC-D2",
        because:
          "saying they will check is not a quote, a date or an order",
      },
    ],
  },

  {
    id: "l-referencia-a-nada",
    exercises:
      "a reference to a value nothing carries, on a day the counterparty never spoke — nothing resolves and nothing pairs across days",
    counterparty: "Tlapalería Robles",
    neverFiled: [...CORPUS_CUSTOMERS, "pedido", "chat", "mismo precio"],
    history: [
      {
        id: "LD-00",
        fromMe: false,
        atMinute: -1500,
        text: "¿me mandas 100 cajas de mortero?",
      },
      ...fillerAfter("LD", -1260),
    ],
    messages: [
      {
        id: "LD-D1",
        fromMe: true,
        atMinute: 700,
        text: "va, se lo dejo al mismo precio del pedido pasado",
      },
    ],
    labels: [],
    silent: [
      {
        messageId: "LD-D1",
        because:
          "«al mismo precio del pedido pasado» points at a figure this chat has never carried — the one earlier order in its history is a request with no price in it — so there is nothing to resolve and nothing to file (ADR-0039 as amended). Nor may an order be taken from it: the window holds no counterparty message, and looking resolves a reference the day's own messages make rather than pairing yesterday's request with today's «va» (ADR-0038; spec #193 decision 12)",
      },
    ],
  },
];
