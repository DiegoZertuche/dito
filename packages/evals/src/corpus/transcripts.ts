/**
 * THE LABELED SEED TRANSCRIPTS (ticket #56 AC 1; #6's seed-corpus
 * doctrine; ADR-0028).
 *
 * Thirty-four days of one rep's WhatsApp, in Mexican Spanish, written to be
 * ordinary rather than clean — hedges, corrections mid-thread, prices
 * quoted twice, half-sentences, and the small talk that carries most of a
 * real day. They are SYNTHETIC and authored for this repo: no real
 * person's messages are in them, which is what lets the live lane send
 * them to the API while #15's ZDR question is still open.
 *
 * WHAT THE LABELS ARE. Each label is one human's reading of one message:
 * this states a fact of this kind, and here are the values a correct
 * reading produces. They are meant to be argued with, which is why every
 * one carries a `because`. Every message that is NOT labeled is claimed
 * `silent` with its own reason, so the corpus is a partition and a label
 * deleted by accident fails the well-formedness test rather than quietly
 * lowering the number.
 *
 * THE HARD CASES ARE DELIBERATE, and they are most of the value:
 *
 * - `q-*` quantities and prices restated, revised, or given per-unit, so a
 *   crossing that files the superseded figure is caught.
 * - `d-*` dates said relatively («el jueves», «el lunes»), which the pass
 *   now gives the model a calendar to resolve — the rep's own day, with
 *   its weekday and zone, rendered at the top of the turn (ticket #121).
 *   THE CORPUS DAY IS TUESDAY 1 SEPTEMBER 2026, and a bare weekday means
 *   its next occurrence strictly after it: «el jueves» is the 3rd, «el
 *   lunes» the 7th, «el martes» the 8th. Before #121 these were labeled
 *   `dueOn: absent` because a model with no calendar could only invent
 *   one; three live sessions (#57, #69, #102) filed a wrong day each, and
 *   three of the `d-*` days below are those reproductions.
 *   THE LAST TWO WERE NOT WRITTEN FROM A FAILING RUN (ticket #139) and
 *   are the only days here said on a rep day other than the corpus's
 *   Tuesday: they declare `owedFromDaysAgo`, so the window the pass reads
 *   opens on the Sunday and each beat carries the day it was actually said
 *   on. They were authored before the prompt's own-weekday paragraph
 *   existed and are not edited after it — how independent that makes them,
 *   exactly, is written on the days themselves.
 *   A day the transcript merely ALLUDES to — «esta semana», «la otra
 *   semana», a conditional — resolves to nothing and stays absent or
 *   silent, which is a different claim and is still made.
 * - `c-*` a counterparty's own WhatsApp number restated in prose, which
 *   `ContactEstablished` must refuse (#52 remainder 8, and the aperture
 *   enforces it) — labeled silent, so filing it costs precision.
 * - `n-*` days that state NOTHING: pure small talk, the rep's own tactics
 *   and judgments, gossip about a third party, and a customer's complaint.
 *   Nothing may cross from them at all.
 * - `x-*` a customer QUOTING a competitor's price, and a rep asking a
 *   question that looks like a quote. Neither is a fact this rep stated.
 * - `b-*` BUSY DAYS, four to five facts each among the acknowledgements
 *   («va», «sale», «perfecto») that surround them. These carry most of the
 *   corpus's n, and they are where an ack gets mistaken for the order it
 *   answers — which is what the first live run found.
 * - `p-*` `CustomerPattern` (ticket #61): what a customer says about how
 *   THEY buy, and the four things that look like it and are not — a
 *   regularity about the REP (said by either side), a one-off, an
 *   observation about the market or the season, and a repetition the model
 *   would have to work out for itself. These days are mostly negative
 *   space, because this is the one type whose false positives are aperture
 *   BREACHES rather than noise.
 *
 * WHAT TICKET #71 CHANGED IN THESE LABELS, and it is the largest revision
 * the corpus has had. `OrderTaken` used to mean "the customer placed an
 * order, or confirmed one", so every one of its labels sat on a CUSTOMER
 * message and every rep acknowledgement answering one was claimed silent
 * with the reason «the order is the customer's message». That reading is
 * what the split overturns: the ask is an `OrderRequested` and the rep's
 * answer is an `OrderTaken`, two facts on two messages, and a day where
 * the customer asked and the rep agreed carries both. Four acknowledgements
 * that were silent for that reason are labels now — O1-03, O2-02, B8-02,
 * BB-02 — and BG-04's silence («a crossing here would have to invent a
 * price») is answered rather than reversed: an agreement invents no price,
 * and its label pins `amount` absent.
 *
 * TWO DAYS DELIBERATELY CARRY NO AGREEMENT, and they are the split's
 * point. `q-precio-revisado` ends on the customer's order with the rep yet
 * to answer, and `x-queja-y-pregunta`'s shortfall is not an order at all —
 * so neither files an `OrderTaken`. (#83 gave `q-precio-revisado` a SECOND
 * request, on its opening message; the day still carries no agreement, which
 * is the claim.) Unmet demand is the thing the
 * split makes recordable, and a corpus where every request was agreed to
 * could not measure it.
 *
 * WHAT TICKET #59 CHANGED, and it is a GRADING change rather than a
 * reading one: every commercial label now pins `requestedFor`, which #70
 * added to all three payloads and nothing graded. Seventy-three labels
 * were silent about a CALENDAR DATE, so an invented or wrong one scored as
 * a correct crossing — the exact hazard the corpus's own rule forbids
 * ("an ungraded field must never be one carrying a NUMBER or an
 * IDENTIFIER"). No label's reading of its transcript moved.
 *
 * SEVENTEEN OF THEM PIN IT `absent` ON A MESSAGE THAT PLAINLY STATES A
 * DATE, and that is the finding rather than an oversight. They are the
 * `OrderTaken`s sitting on a rep's own delivery message — «se los entrego
 * el 8 de septiembre». The first cut of this change pinned them
 * `absentOrEquals`, reasoning that a day the message states outright
 * cannot be invention. Both review axes and Codex rejected that, and they
 * were right, because the aperture's own contract settles it in one
 * sentence (`facts.ts`, `shapeCommercial`):
 *
 *   "When the rep DOES commit to a day in the same breath, that is a
 *    second, separate `DatePromised`, exactly as the corpus already
 *    labels it; THIS FIELD NEVER CARRIES THE PROMISE."
 *
 * A `requestedFor` on those messages is therefore not a permissible
 * reading at all. It records the CUSTOMER as having asked for a day they
 * never named — precisely the laundering #70 named the field apart from
 * `dueOn` to prevent — and `absentOrEquals` blessed it. A corpus that
 * blesses a spec violation cannot measure one. Every one of these days
 * already pins that date exactly, on the `DatePromised` label of the very
 * same message, which is where the contract puts it.
 *
 * This LOWERS the reported number, because the extractor did file those
 * dates, and that is the correct direction for a label corrected on the
 * spec's authority rather than on the score's.
 *
 * NO `OrderRequested` IN THE FIRST THIRTY-FOUR DAYS SITS ON A MESSAGE THAT
 * STATES A DAY, which is why `q-pedido-fechado` was added (#70's note on
 * #59: "no seed transcript exercises a dated order at all"). A graded
 * field that nothing exercises is grading on paper.
 *
 * The first wording of that sentence claimed no customer message names a
 * day at all, and Codex was right that it is false: B8-03 says «¿me las
 * puede tener el 25 de septiembre?». It is claimed silent, and stays
 * silent, and that silence IS a decision rather than a deferral — a
 * `silent` claim is a negative label, so calling it undecided while
 * scoring against it would be having it both ways (Codex r3 was right to
 * press on this).
 *
 * The decision, on the same ground every other question in this corpus is
 * silent on: B8-01 already carried the ask («mándeme lo de siempre, 20
 * cubetas»), B8-02 already agreed to it, and B8-03 asks about the DAY of
 * an order that by then exists. It is not the customer asking for goods —
 * they asked two messages ago — so «Te pidió 20 cubetas» would be filed
 * twice for one ask.
 *
 * What is genuinely open is a DESIGN question, not this label: should the
 * type system have a way for a day named later to attach to a request
 * already filed? Today it cannot — a fact is bound to one message and
 * append-only (ADR-0034) — so the day in B8-03 is recorded nowhere, and
 * the rep sees it only in the `DatePromised` the rep's own answer files.
 * That is a gap worth a decision ticket; it is recorded on #59, and it is
 * not something a corpus label may settle either way.
 *
 * WHAT TICKET #83 CHANGED, and it is the only change this corpus has ever
 * made to what a message MEANS. Six labels were added, on four messages,
 * and every one of them was claimed `silent` before:
 *
 *   Q2-01  «necesito 200 varillas del 3/8»              → OrderRequested
 *   B2-01  «necesito 300 blocks y 15 sacos de mortero»  → OrderRequested ×2
 *   B6-01  «ocupo cien metros de cable calibre 12»      → OrderRequested
 *   BD-02  «quiero 150 varillas y 40 bultos»            → OrderRequested ×2
 *
 * THE RULING, from the person who owns the domain (Diego, 2026-08-30):
 * «these sound more like requests as the customer would not say it needs
 * something to the rep if he doesnt want that order». A customer who names
 * goods and a quantity to the person who sells them has asked for them;
 * whether a price has been quoted or a confirmation given is a fact about
 * the REP's half of the day, not about whether the ask happened.
 *
 * WHY A CORPUS CHANGE IS ALLOWED HERE AT ALL. #59's standing discipline is
 * «fix the extractor, never the corpus, unless the label is demonstrably
 * wrong about what the transcript says», and this clears that bar the only
 * way a label ever should: a ruling on what the domain MEANS, not a number
 * that needed moving. The extractor already files all four of these — they
 * were four of the twelve wrong crossings on the last run, every one of
 * them `misattributed` at 0.95 confidence. The tell #59 recorded is
 * exactly that: a cluster of confident misattributions in one consistent
 * shape is a question about the labels, not only a defect. So every one of
 * these six labels quotes the transcript line and cites the ruling in its
 * `because` — a label bent to agree with the code, without that, is the
 * corruption the corpus exists to prevent (#56 found two of those).
 *
 * THE SWEEP, because a partial relabel leaves the instrument disagreeing
 * with itself. Every message carrying «necesito», «ocupo», «quiero» — and
 * their plurals, and «me hace falta» and «me urge», which the ticket names
 * and this corpus happens not to contain — was re-read; `corpus.test.ts`
 * scans for the same vocabulary so the sweep cannot go stale. B2-01 is what it found beyond the
 * three the ticket named, and it is handled identically. Four were looked
 * at and LEFT SILENT, each for a reason now written into its own claim:
 *
 *  - B9-01 «necesito PRECIO de lámina y de solera» — the verb in front of
 *    a price. THE LINE THE RULING DOES NOT CROSS.
 *  - D2-01 «necesito SABER si alcanzo» — the need is for information.
 *  - Q3-03 «déjeme ver cuántos ocupo» — the customer has not worked out
 *    how many, and asks for nothing.
 *  - B5-01 «necesito RFC, correo y un teléfono fijo» — the REP's message,
 *    about paperwork, and `OrderRequested` is counterparty-authored.
 *
 * X1-01's «faltaron 5 bultos» was re-read too and stays silent: a
 * shortfall is what did not arrive, not a request.
 *
 * WHAT THE RULING DOES NOT SAY. Asking to be SENT something is not asking
 * what it COSTS. Q5-01 «¿me cotiza 45 rollos de alambre recocido?» is
 * untouched and still silent, and B9-01 is the same distinction with the
 * ruling's own verb in it. Nor does it touch the AUTHORSHIP FENCE: a
 * customer still cannot author a `QuoteGiven` (ADR-0038), which is why
 * none of these six labels is anything but an `OrderRequested`.
 *
 * WHAT THESE SIX LABELS PIN, and the one thing review had to correct. Each
 * asks BEFORE the day has stated any price, so `amount` is `absent`, not
 * `absentOrEquals` the figure quoted later. The first cut carried the later
 * price forward and both review axes rejected it, rightly: `absentOrEquals`
 * is corpus.ts's shape for a CARRIED-FORWARD value — «an order that FOLLOWS
 * a quote may honestly carry that quote's price» — and the direction is the
 * whole of it. A customer saying «va» to a figure already on the table is
 * accepting that figure; a customer asking before anybody has priced
 * anything has named no number, and a crossing carrying one would render
 * «Te pidió … por … MXN» about a message written before that price existed.
 * `currency` stays `absentOrEquals "MXN"`, as it is on every other
 * amount-absent label here: pinning it `absent` is the repair #56 round 2
 * got wrong once already, because it makes the corpus claim a Mexican price
 * list carries no currency.
 *
 * TWO OLDER LABELS DISAGREE WITH THAT LINE and are deliberately not touched:
 * `BG-01` and `BC-03` are asks that also precede their total, and both pin
 * `absentOrEquals` to the figure quoted after them. They are loose in the
 * same way the first cut of these six was. They are left alone because #83's
 * licence is a ruling about «necesito X», not a grading-policy change, and
 * rewriting two unrelated labels would move the number for a reason this
 * ticket cannot account for — the shape #59 declined for `unit` and this
 * corpus declines again. It is named here rather than hidden, and it is
 * recorded on the ticket as the follow-up.
 *
 * A CONSEQUENCE WORTH STATING RATHER THAN DISCOVERING: all four of these
 * days now carry the same goods asked for TWICE — BD-02 and BD-05, B2-01
 * and B2-04, Q2-01 and Q2-06, B6-01 and B6-03 — because the customer asked at
 * the outset and asked again once the price was known. That is what an
 * append-only record of a conversation looks like: nothing links a request
 * to a later one (ADR-0038), and neither message is the other. It is not
 * B8-03's shape, where the customer asks about the DAY of an ask already
 * filed and names no goods at all.
 *
 * REPRODUCIBLE MEANS THE INPUTS AND THE SCORING ARE FIXED, not that the
 * number is. The corpus, the clock (one day, one 21:30 trigger) and the
 * matching rules do not move between runs; the MODEL does, so two runs of
 * the live lane land a point or two apart. That is a property of measuring
 * a model, and the report's interval is there to keep it from being read
 * as precision the measurement does not have.
 */
import type { SeedTranscript } from "../corpus.ts";
import { LOOKING_TRANSCRIPTS } from "./looking.ts";

export const SEED_TRANSCRIPTS: readonly SeedTranscript[] = [
  {
    id: "q-cotizacion-directa",
    exercises: "the plain case: a quote, an order, and a delivery date",
    counterparty: "Ferretería Fuentes",
    messages: [
      { id: "Q1-01", fromMe: false, atMinute: 552, text: "buenos días, ¿tiene cemento gris?" },
      { id: "Q1-02", fromMe: true, atMinute: 555, text: "buenos días! sí, ahorita tengo" },
      { id: "Q1-03", fromMe: false, atMinute: 558, text: "¿en cuánto me deja 40 bultos?" },
      { id: "Q1-04", fromMe: true, atMinute: 566, text: "los 40 bultos le salen en 8,200 pesos" },
      { id: "Q1-05", fromMe: false, atMinute: 601, text: "va, mándeme los 40" },
      { id: "Q1-06", fromMe: true, atMinute: 604, text: "listo, se los tengo el viernes 4 de septiembre" },
      { id: "Q1-07", fromMe: false, atMinute: 606, text: "perfecto, gracias" },
    ],
    labels: [
      {
        messageId: "Q1-04",
        factType: "QuoteGiven",
        because: "the rep states a price for a stated quantity, in pesos",
        checks: [
          { path: "amount", equals: 8200 },
          { path: "currency", equals: "MXN" },
          { path: "quantity", equals: 40 },
          { path: "requestedFor", absent: true },
        ],
      },
      {
        messageId: "Q1-05",
        factType: "OrderRequested",
        because: "the customer confirms the order at the quoted quantity",
        checks: [
          { path: "quantity", equals: 40 },
          { path: "amount", absentOrEquals: 8200 },
          { path: "currency", absentOrEquals: "MXN" },
          { path: "requestedFor", absent: true },
        ],
      },
      {
        messageId: "Q1-06",
        factType: "DatePromised",
        because: "the rep commits to a calendar date the message states",
        checks: [
          { path: "dueOn", equals: "2026-09-04" },
        ],
      },
      {
        messageId: "Q1-06",
        factType: "OrderTaken",
        because:
          "the rep answers the request with «listo» and a delivery date. The customer asked in Q1-05 and the business agreed here — two events, two facts (#71)",
        checks: [
          { path: "quantity", equals: 40 },
          { path: "amount", absentOrEquals: 8200 },
          { path: "currency", absentOrEquals: "MXN" },
          { path: "requestedFor", absent: true },
        ],
      },
    ],
    silent: [
      { messageId: "Q1-01", because: "a greeting and an availability question" },
      { messageId: "Q1-02", because: "availability today is stock, not a quote, an order or a date" },
      { messageId: "Q1-03", because: "the customer ASKS for a price; nothing is quoted yet" },
      { messageId: "Q1-07", because: "thanks" },
    ],
  },

  {
    id: "q-precio-revisado",
    exercises: "a price revised in the same day — only the standing figure is a fact",
    counterparty: "Materiales del Norte",
    messages: [
      { id: "Q2-01", fromMe: false, atMinute: 620, text: "necesito 200 varillas del 3/8" },
      { id: "Q2-02", fromMe: true, atMinute: 630, text: "déjeme checar precio" },
      { id: "Q2-03", fromMe: true, atMinute: 655, text: "le salen en 24,000 las 200" },
      { id: "Q2-04", fromMe: false, atMinute: 700, text: "uf, está caro" },
      { id: "Q2-05", fromMe: true, atMinute: 712, text: "perdón, me equivoqué, son 21,500 las 200. el otro precio era del mes pasado" },
      { id: "Q2-06", fromMe: false, atMinute: 730, text: "ahora sí, écheme las 200" },
    ],
    labels: [
      {
        messageId: "Q2-01",
        factType: "OrderRequested",
        because:
          "«necesito 200 varillas del 3/8» — the customer names the goods and the quantity and asks the person who sells them to supply them. RULING (#83, Diego 2026-08-30): «these sound more like requests as the customer would not say it needs something to the rep if he doesnt want that order». This message was claimed silent as «a request for a quantity, not an order — no price and no confirmation», and the ruling overturns that reading: a price and a confirmation are not what makes an ask an ask. `amount` and the day's price: this ask PRECEDES every price the day states, so the figure is pinned ABSENT rather than carried forward. `absentOrEquals` is for a carried-forward value — corpus.ts's own words, «an order that FOLLOWS a quote may honestly carry that quote's price» — and the direction is the whole of it: a customer saying «va» to a figure already on the table is accepting it, while a customer who asks before anybody has priced anything has named no number at all. A crossing carrying the later figure would render «Te pidió … por … MXN» about a message written before that price existed, which is the provenance laundering #70 named `requestedFor` apart from `dueOn` to prevent, in the money field instead of the date one. Both review axes found this independently. Q2-01 is the sharpest case in the corpus: the day states TWO prices for the 200 and withdraws one of them, and this message predates both.",
        checks: [
          { path: "quantity", equals: 200 },
          { path: "amount", absent: true },
          { path: "currency", absentOrEquals: "MXN" },
          { path: "requestedFor", absent: true },
        ],
      },
      {
        messageId: "Q2-05",
        factType: "QuoteGiven",
        because: "the corrected price is the one the rep quoted; the message states it explicitly",
        checks: [
          { path: "amount", equals: 21500 },
          { path: "quantity", equals: 200 },
          { path: "currency", absentOrEquals: "MXN" },
          { path: "requestedFor", absent: true },
        ],
      },
      {
        messageId: "Q2-06",
        factType: "OrderRequested",
        because: "the customer orders the 200 after the correction",
        checks: [
          { path: "quantity", equals: 200 },
          { path: "amount", absentOrEquals: 21500 },
          { path: "currency", absentOrEquals: "MXN" },
          { path: "requestedFor", absent: true },
        ],
      },
    ],
    silent: [
      { messageId: "Q2-02", because: "the rep says they will check; nothing is stated" },
      {
        messageId: "Q2-03",
        because:
          "SUPERSEDED IN THE SAME DAY by Q2-05, which says so outright. A crossing here files a price the rep withdrew, and the day's window is what the pass reads — so nothing rescues it later.",
      },
      { messageId: "Q2-04", because: "an opinion about the price" },
    ],
  },

  {
    id: "q-precio-unitario",
    exercises: "a per-unit price with a total the rep never states",
    counterparty: "Constructora Aguilar",
    messages: [
      { id: "Q3-01", fromMe: false, atMinute: 540, text: "¿a cómo el bulto de mortero?" },
      { id: "Q3-02", fromMe: true, atMinute: 548, text: "a 185 el bulto" },
      { id: "Q3-03", fromMe: false, atMinute: 560, text: "ok déjeme ver cuántos ocupo" },
      { id: "Q3-04", fromMe: false, atMinute: 900, text: "serían como 60, pero déjeme confirmar mañana" },
    ],
    labels: [
      {
        messageId: "Q3-02",
        factType: "QuoteGiven",
        because: "a unit price is a quoted figure; the quantity is not stated, so it must not appear",
        checks: [
          { path: "amount", equals: 185 },
          { path: "quantity", absent: true },
          { path: "currency", absentOrEquals: "MXN" },
          { path: "requestedFor", absent: true },
        ],
      },
    ],
    silent: [
      { messageId: "Q3-01", because: "asking a price is not being given one" },
      {
        messageId: "Q3-03",
        because:
          "«ok déjeme ver cuántos OCUPO» carries the ruling's verb (#83) and is not the ruling's shape: the customer is saying they have not worked out how many they need. No quantity is stated and nothing is asked for, and «déjeme ver» is the customer telling the rep to wait. Contrast B6-01, «ocupo cien metros», where the same verb names goods and a count.",
      },
      {
        messageId: "Q3-04",
        because:
          "«como 60» and «déjeme confirmar mañana» is an estimate the customer explicitly has not confirmed — not an order. This is the shape the confidence gate should turn into a QUESTION rather than a fact.",
      },
    ],
  },

  {
    id: "q-dos-productos",
    exercises: "two quotes in one message — a message states more than one fact",
    counterparty: "Ferretería La Central",
    messages: [
      { id: "Q4-01", fromMe: false, atMinute: 610, text: "¿me cotiza cal y arena?" },
      { id: "Q4-02", fromMe: true, atMinute: 625, text: "la cal en 3,400 los 20 bultos y la arena en 2,100 el metro" },
      { id: "Q4-03", fromMe: false, atMinute: 640, text: "gracias, lo veo con mi socio" },
    ],
    labels: [
      {
        messageId: "Q4-02",
        factType: "QuoteGiven",
        because: "the lime is quoted at a stated total for a stated quantity",
        checks: [
          { path: "amount", equals: 3400 },
          { path: "quantity", equals: 20 },
          { path: "currency", absentOrEquals: "MXN" },
          { path: "requestedFor", absent: true },
        ],
      },
      {
        messageId: "Q4-02",
        factType: "QuoteGiven",
        because:
          "the sand is quoted separately in the same message — two quotes, two facts. Its price is PER METRE, so a quantity here would be invented, exactly as in q-precio-unitario.",
        checks: [
          { path: "amount", equals: 2100 },
          { path: "quantity", absent: true },
          { path: "currency", absentOrEquals: "MXN" },
          { path: "requestedFor", absent: true },
        ],
      },
    ],
    silent: [
      { messageId: "Q4-01", because: "a request for a quote" },
      { messageId: "Q4-03", because: "the customer will consult someone" },
    ],
  },

  {
    // ADDED BY #59, and the only transcript it adds. `requestedFor` became
    // a graded field here (#70's note on #59), and none of the original
    // thirty-four days exercises it: not one customer message in them
    // names the day the goods are wanted for, so grading the field would
    // have been grading on paper. This day states one outright, in the
    // customer's own message, which is where an `OrderRequested` is read.
    id: "q-pedido-fechado",
    exercises:
      "a customer who names the DAY the goods are wanted for — requestedFor, read in the message that states it and in no other",
    counterparty: "Constructora Mireles",
    messages: [
      { id: "Q5-01", fromMe: false, atMinute: 545, text: "¿me cotiza 45 rollos de alambre recocido?" },
      { id: "Q5-02", fromMe: true, atMinute: 560, text: "los 45 rollos en 14,850" },
      { id: "Q5-03", fromMe: false, atMinute: 575, text: "va, mándeme los 45 para el 17 de septiembre" },
      { id: "Q5-04", fromMe: true, atMinute: 590, text: "déjeme confirmar con almacén y le aviso" },
    ],
    labels: [
      {
        messageId: "Q5-02",
        factType: "QuoteGiven",
        because:
          "a stated total for a stated quantity. `requestedFor` is ABSENT and that is the point of putting the quote before the day: the customer names 17 September in the NEXT message, and #70's contract is that a fact carries the provenance of the one message it was read in — «never carry a date over from another message». A day lifted onto this quote would be a field whose provenance the fact does not claim, which is #57's own defect.",
        checks: [
          { path: "amount", equals: 14850 },
          { path: "quantity", equals: 45 },
          { path: "currency", absentOrEquals: "MXN" },
          { path: "requestedFor", absent: true },
        ],
      },
      {
        messageId: "Q5-03",
        factType: "OrderRequested",
        because:
          "«va, mándeme los 45 para el 17 de septiembre» — the customer asks to be SENT the goods and names the day they are wanted for, both in this one message. `requestedFor` is pinned with `equals` rather than `absentOrEquals` because dropping a day the message states outright is the loss #57 reported and #70 added the field to stop; a crossing that omits it files an order the rep reads as «sin fecha» when the customer named one.",
        checks: [
          { path: "quantity", equals: 45 },
          { path: "amount", absentOrEquals: 14850 },
          { path: "currency", absentOrEquals: "MXN" },
          { path: "requestedFor", equals: "2026-09-17" },
        ],
      },
    ],
    silent: [
      {
        messageId: "Q5-01",
        because:
          "a request for a PRICE. Asking what something costs is not asking to be sent it, and «Te pidió 45 rollos de alambre recocido» would be a false sentence about this message — the ask is Q5-03.",
      },
      {
        messageId: "Q5-04",
        because:
          "«déjeme confirmar con almacén» is the hedge ADR-0038 names outright as NOT agreeing, so this day carries a request and no OrderTaken. That is the split's point: unmet demand is only recordable if the corpus holds days where nobody agreed.",
      },
    ],
  },

  {
    id: "o-pedido-parcial",
    exercises: "an order for part of what was quoted",
    counterparty: "Tlapalería Ruiz",
    messages: [
      { id: "O1-01", fromMe: true, atMinute: 570, text: "le mando la lista: 100 tabiques en 1,900" },
      { id: "O1-02", fromMe: false, atMinute: 590, text: "mándeme nada más 60 por ahora" },
      { id: "O1-03", fromMe: true, atMinute: 595, text: "va, 60 entonces" },
      { id: "O1-04", fromMe: false, atMinute: 598, text: "sale" },
    ],
    labels: [
      {
        messageId: "O1-01",
        factType: "QuoteGiven",
        because: "the rep quotes 100 bricks at a stated price",
        checks: [
          { path: "amount", equals: 1900 },
          { path: "quantity", equals: 100 },
          { path: "currency", absentOrEquals: "MXN" },
          { path: "requestedFor", absent: true },
        ],
      },
      {
        messageId: "O1-02",
        factType: "OrderRequested",
        because: "the customer orders 60 — the ordered quantity, not the quoted one",
        checks: [
          { path: "quantity", equals: 60 },
          { path: "amount", absent: true },
          { path: "currency", absentOrEquals: "MXN" },
          { path: "requestedFor", absent: true },
        ],
      },
      {
        messageId: "O1-03",
        factType: "OrderTaken",
        because:
          "«va, 60 entonces» is the rep agreeing, and the quantity is the one they agreed to rather than the one they quoted. This message was claimed silent before #71 with the reason «the order is the customer's message» — which is exactly the reading the split overturns",
        checks: [
          { path: "quantity", equals: 60 },
          { path: "amount", absent: true },
          { path: "currency", absentOrEquals: "MXN" },
          { path: "requestedFor", absent: true },
        ],
      },
    ],
    silent: [
      { messageId: "O1-04", because: "an acknowledgement" },
    ],
  },

  {
    id: "o-pedido-cancelado",
    exercises: "an order placed and withdrawn in the same day",
    counterparty: "Bodega Salinas",
    messages: [
      { id: "O2-01", fromMe: false, atMinute: 600, text: "apárteme 30 sacos de yeso" },
      { id: "O2-02", fromMe: true, atMinute: 610, text: "apartados" },
      { id: "O2-03", fromMe: false, atMinute: 780, text: "oiga, cancele lo del yeso, ya lo conseguí acá" },
      { id: "O2-04", fromMe: true, atMinute: 790, text: "sin problema" },
    ],
    labels: [
      {
        messageId: "O2-01",
        factType: "OrderRequested",
        because:
          "the order was placed and the record says so; the cancellation is a later event, not a reason to unfile it. FR-33's whole rule is that the record shows what happened.",
        checks: [
          { path: "quantity", equals: 30 },
          { path: "amount", absent: true },
          { path: "currency", absentOrEquals: "MXN" },
          { path: "requestedFor", absent: true },
        ],
      },
      {
        messageId: "O2-02",
        factType: "OrderTaken",
        because:
          "«apartados» answers «apárteme 30 sacos» with the act itself — agreement without the word yes, and clear to both parties, which is the test. The later cancellation does not unfile it (FR-33)",
        checks: [
          { path: "quantity", equals: 30 },
          { path: "amount", absent: true },
          { path: "currency", absentOrEquals: "MXN" },
          { path: "requestedFor", absent: true },
        ],
      },
    ],
    silent: [
      {
        messageId: "O2-03",
        because:
          "a CANCELLATION is not one of the five fact types. There is no verb for it this slice, and inventing one is exactly what decision 5 refuses.",
      },
      { messageId: "O2-04", because: "an acknowledgement" },
    ],
  },

  {
    // RELABELLED AT TICKET #121, because the SYSTEM changed rather than
    // anybody's mind. This label used to read «a resolved dueOn would be
    // INVENTED», and while the pass showed the model bare UTC instants
    // that was exactly right: nothing in front of it said what weekday
    // today was or whose calendar it was on, so any resolution was a
    // guess. #121 puts the rep's own day at the top of the turn — «Hoy es
    // martes 1 de septiembre de 2026 (America/Monterrey).» — and «el
    // jueves» said on that Tuesday is now READ off a calendar.
    //
    // #59 recorded this reconciliation as owed, in these words: "if the
    // corpus and the extractor disagree about what a relative date should
    // produce, the precision number is measuring the disagreement". This
    // is the ONLY label that was on the wrong side of it — every other
    // relative day in the corpus sits on a message called silent for a
    // different reason (D3-02 is conditional, B5-06 promises a
    // notification rather than a delivery, X1-03 proposes).
    id: "d-fecha-relativa",
    exercises:
      "a relative weekday — «el jueves» said on a Tuesday is the 3rd, resolved against the rep day the pass now renders (#121)",
    counterparty: "Herrería Molina",
    messages: [
      { id: "D1-01", fromMe: false, atMinute: 555, text: "¿para cuándo me lo tiene?" },
      { id: "D1-02", fromMe: true, atMinute: 562, text: "se lo tengo el jueves sin falta" },
      { id: "D1-03", fromMe: false, atMinute: 570, text: "ándele pues" },
    ],
    labels: [
      {
        messageId: "D1-02",
        factType: "DatePromised",
        because:
          "the rep commits to a delivery, «el jueves». THE CORPUS DAY IS TUESDAY 1 SEPTEMBER 2026 and this corpus reads a bare weekday as its NEXT occurrence strictly after that day — «el jueves» is the 3rd, «el lunes» the 7th, «el martes» the 8th (ticket #121, which is Diego's own reading of the #102 session). Pinned absent before #121 because the model had no calendar to resolve against; it has one now, and a promise the rep made for Thursday has to reach the Ledger as Thursday or the rep is shown «sin fecha» for a day they named.",
        checks: [
          { path: "commitment", contains: "jueves" },
          { path: "dueOn", equals: "2026-09-03" },
        ],
      },
    ],
    silent: [
      { messageId: "D1-01", because: "the customer asks; nothing is promised yet" },
      { messageId: "D1-03", because: "an acknowledgement" },
    ],
  },

  {
    id: "d-fecha-explicita",
    exercises: "an explicit calendar date, and a second promise about availability",
    counterparty: "Distribuidora Peña",
    messages: [
      { id: "D2-01", fromMe: false, atMinute: 530, text: "necesito saber si alcanzo para la obra" },
      { id: "D2-02", fromMe: true, atMinute: 545, text: "le confirmo que el 12 de septiembre lo tengo en bodega" },
      { id: "D2-03", fromMe: true, atMinute: 548, text: "y le aparto material desde ahorita" },
      { id: "D2-04", fromMe: false, atMinute: 560, text: "excelente" },
    ],
    labels: [
      {
        messageId: "D2-02",
        factType: "DatePromised",
        because: "an explicit calendar date the message states outright",
        checks: [
          { path: "dueOn", equals: "2026-09-12" },
        ],
      },
      {
        messageId: "D2-03",
        factType: "DatePromised",
        because:
          "«y le aparto material desde ahorita» is a second commitment: the rep undertakes to reserve material. This day's own `exercises` line says it has two promises, and the first cut of this corpus called it silent anyway — a contradiction Codex round 3 found. It states NO calendar date, so a resolved `dueOn` here would be invention.",
        checks: [
          { path: "dueOn", absent: true },
        ],
      },
    ],
    silent: [
      {
        messageId: "D2-01",
        because:
          "«necesito SABER si alcanzo para la obra» — the need is for INFORMATION. #83's ruling reaches «necesito X» where X is goods the rep sells; here X is knowing something, no goods and no quantity are named, and «Te pidió …» would have nothing to put after it. The reason on this silence used to read «the customer states a need», which after the ruling is the reason a label WOULD be added, so it is spelled out.",
      },
      { messageId: "D2-04", because: "an acknowledgement" },
    ],
  },

  {
    id: "d-fecha-condicional",
    exercises: "a conditional promise — «si… entonces» is not a commitment",
    counterparty: "Grupo Vallejo",
    messages: [
      { id: "D3-01", fromMe: false, atMinute: 600, text: "¿me lo puede tener para el lunes?" },
      { id: "D3-02", fromMe: true, atMinute: 615, text: "si el proveedor me surte mañana, sí. si no, hasta la otra semana" },
      { id: "D3-03", fromMe: false, atMinute: 620, text: "ok, avíseme" },
    ],
    labels: [],
    silent: [
      { messageId: "D3-01", because: "the customer asks" },
      {
        messageId: "D3-02",
        because:
          "CONDITIONAL. The rep promised nothing — both branches are stated and neither has happened. The prompt says a reading between the lines is low confidence, so the right outcome is a QUESTION at most, never a filed DatePromised.",
      },
      { messageId: "D3-03", because: "an acknowledgement" },
    ],
  },

  {
    id: "c-contacto-completo",
    exercises: "ContactEstablished with all three identifier kinds, normalized",
    counterparty: "Comercializadora Rivas",
    messages: [
      { id: "C1-01", fromMe: true, atMinute: 580, text: "¿me pasa sus datos para la factura?" },
      { id: "C1-02", fromMe: false, atMinute: 600, text: "claro: RFC riv850612-h23, correo Facturas@Rivas.MX y el tel de compras es 81 1234 5678" },
      { id: "C1-03", fromMe: true, atMinute: 605, text: "gracias, ya quedó registrado" },
    ],
    labels: [
      {
        messageId: "C1-02",
        factType: "ContactEstablished",
        because:
          "three identifiers stated outright, and the labels are the NORMALIZED forms the aperture stores — uppercased RFC, lowercased email, E.164 phone — because those are the merge keys ADR-0035 actually rungs on",
        checks: [
          { path: "identifiers.phones", equalsAll: ["+528112345678"] },
          { path: "identifiers.emails", equalsAll: ["facturas@rivas.mx"] },
          { path: "identifiers.rfcs", equalsAll: ["RIV850612H23"] },
        ],
      },
    ],
    silent: [
      { messageId: "C1-01", because: "the rep asks for details; none are established yet" },
      { messageId: "C1-03", because: "an acknowledgement" },
    ],
  },

  {
    id: "c-numero-propio",
    exercises: "the counterparty restating their OWN WhatsApp number — refused by the wall",
    counterparty: "Aceros Beltrán",
    // The number C2-02 restates IS this chat's address. Pinned, because
    // the claim is about chat identity and a fixture with an unrelated
    // address would prove nothing.
    chatSubscriber: "5560010002",
    messages: [
      { id: "C2-01", fromMe: true, atMinute: 550, text: "¿tiene otro número por si no le caigo aquí?" },
      { id: "C2-02", fromMe: false, atMinute: 570, text: "es este mismo, 55 6001 0002, ahí me marca" },
      { id: "C2-03", fromMe: false, atMinute: 575, text: "el correo sí se lo paso: ventas@beltran.com.mx" },
    ],
    labels: [
      {
        messageId: "C2-03",
        factType: "ContactEstablished",
        because: "an email address stated outright, normalized lowercase",
        checks: [
          { path: "identifiers.phones", equalsAll: [] },
          { path: "identifiers.emails", equalsAll: ["ventas@beltran.com.mx"] },
          { path: "identifiers.rfcs", equalsAll: [] },
        ],
      },
    ],
    silent: [
      { messageId: "C2-01", because: "the rep asks" },
      {
        messageId: "C2-02",
        because:
          "THE CHAT'S OWN SUBSCRIBER NUMBER. ADR-0004's whole point is that owner joins never recover chat identity, and a phone equal to the chat's address is chat identity wearing a different shape. The aperture refuses it (#52); a crossing here would be a wall breach, not a wrong number.",
      },
    ],
  },

  {
    id: "c-rfc-generico",
    exercises: "the SAT generic RFC — a placeholder that must never become a merge key",
    counterparty: "Papelería del Centro",
    messages: [
      { id: "C3-01", fromMe: true, atMinute: 600, text: "¿RFC para la factura?" },
      { id: "C3-02", fromMe: false, atMinute: 615, text: "póngale el genérico, XAXX010101000" },
      { id: "C3-03", fromMe: false, atMinute: 618, text: "y mi correo es compras@papeleriacentro.mx" },
    ],
    labels: [
      {
        messageId: "C3-03",
        factType: "ContactEstablished",
        because: "an email stated outright",
        checks: [
          { path: "identifiers.phones", equalsAll: [] },
          { path: "identifiers.emails", equalsAll: ["compras@papeleriacentro.mx"] },
          { path: "identifiers.rfcs", equalsAll: [] },
        ],
      },
    ],
    silent: [
      { messageId: "C3-01", because: "the rep asks" },
      {
        messageId: "C3-02",
        because:
          "XAXX010101000 is SAT's generic RFC — many unrelated customers legitimately carry it, so storing it as a merge key is the mass-fusion failure #52 caught. The aperture refuses it; the label records that a crossing here is wrong even though a human WOULD read an RFC in this message.",
      },
    ],
  },

  {
    id: "n-solo-plática",
    exercises: "a whole day of small talk — nothing may cross",
    counterparty: "Ferretería Fuentes",
    messages: [
      { id: "N1-01", fromMe: false, atMinute: 480, text: "buenos días, ¿cómo amaneció?" },
      { id: "N1-02", fromMe: true, atMinute: 485, text: "bien bien, aquí andamos. ¿y la familia?" },
      { id: "N1-03", fromMe: false, atMinute: 490, text: "todos bien gracias a Dios" },
      { id: "N1-04", fromMe: false, atMinute: 492, text: "está lloviendo feo por acá" },
      { id: "N1-05", fromMe: true, atMinute: 500, text: "sí, igual acá. cualquier cosa me dice" },
    ],
    labels: [],
    silent: [
      { messageId: "N1-01", because: "a greeting" },
      { messageId: "N1-02", because: "small talk" },
      { messageId: "N1-03", because: "small talk" },
      { messageId: "N1-04", because: "the weather" },
      { messageId: "N1-05", because: "an offer to help, with nothing offered" },
    ],
  },

  {
    id: "n-tácticas-del-rep",
    exercises: "the CustomerPattern shape — rep tactics and judgments, deferred and forbidden",
    counterparty: "Materiales del Norte",
    messages: [
      { id: "N2-01", fromMe: true, atMinute: 540, text: "a este cliente siempre hay que darle el precio alto primero, luego negocia" },
      { id: "N2-02", fromMe: true, atMinute: 545, text: "nunca contesta antes de mediodía, mejor le escribo en la tarde" },
      { id: "N2-03", fromMe: false, atMinute: 800, text: "¿qué precios trae hoy?" },
      { id: "N2-04", fromMe: true, atMinute: 810, text: "déjeme armarle una lista" },
    ],
    labels: [],
    silent: [
      {
        messageId: "N2-01",
        because:
          "THE APERTURE-BREACH CASE. This is a judgment about how the rep sells — FR-30 warns against it by name, and since ticket #61 gave `CustomerPattern` a shape it is the one thing that type must never carry. It is here in a CUSTOMER chat rather than the twin thread, so ADR-0033's enumeration does not exclude it. What DOES exclude it is the authorship fence: a `CustomerPattern` claims the customer spoke, and this is the rep's own message, so the aperture refuses it in code (ADR-0038). The corpus keeps it because a refusal nothing exercises proves nothing — and because the customer-authored version of the same breach, `PC-01`, has no fence at all.",
      },
      {
        messageId: "N2-02",
        because:
          "the rep's own observation about when this customer answers — about how the REP works out when to write, which FR-30 excludes by name. Rep-authored, so the `CustomerPattern` authorship fence refuses it too (#61).",
      },
      { messageId: "N2-03", because: "the customer asks" },
      { messageId: "N2-04", because: "the rep will send a list; nothing is stated" },
    ],
  },

  {
    id: "n-tercero",
    exercises: "a price and a promise belonging to somebody who is not in this conversation",
    counterparty: "Constructora Aguilar",
    messages: [
      { id: "N3-01", fromMe: false, atMinute: 600, text: "me dijeron que en Aceros del Golfo la varilla está en 19,000 las 200" },
      { id: "N3-02", fromMe: false, atMinute: 603, text: "y que se las entregan el martes" },
      { id: "N3-03", fromMe: true, atMinute: 620, text: "déjeme ver qué puedo hacer" },
    ],
    labels: [],
    silent: [
      {
        messageId: "N3-01",
        because:
          "A COMPETITOR'S price, reported second-hand. The prompt says never record anything said by neither party in this conversation; this rep quoted nothing.",
      },
      {
        messageId: "N3-02",
        because: "a third party's delivery date, reported second-hand — this rep promised nothing",
      },
      { messageId: "N3-03", because: "the rep will look into it" },
    ],
  },

  {
    id: "x-queja-y-pregunta",
    exercises: "a complaint, and a rep question shaped like a quote",
    counterparty: "Tlapalería Ruiz",
    messages: [
      { id: "X1-01", fromMe: false, atMinute: 520, text: "el pedido pasado llegó incompleto, faltaron 5 bultos" },
      { id: "X1-02", fromMe: true, atMinute: 530, text: "una disculpa, lo reviso hoy mismo" },
      { id: "X1-03", fromMe: true, atMinute: 535, text: "¿le parece si se los repongo junto con lo del jueves?" },
      { id: "X1-04", fromMe: false, atMinute: 560, text: "sí, así está bien" },
      { id: "X1-05", fromMe: true, atMinute: 565, text: "hecho, se los repongo el jueves 10 de septiembre" },
    ],
    labels: [
      {
        messageId: "X1-05",
        factType: "DatePromised",
        because:
          "the rep commits, with the calendar date stated in the message — this is the promise, not X1-03 which only proposed it",
        checks: [
          { path: "dueOn", equals: "2026-09-10" },
        ],
      },
    ],
    silent: [
      {
        messageId: "X1-01",
        because:
          "a complaint about a past order. Not one of the five types, and a quantity in it («faltaron 5 bultos») is a shortfall rather than an order — the shape most likely to be mis-filed as OrderRequested. Nothing here is an OrderTaken either: X1-05 repays a shortfall, and a replacement answers no request. #83's sweep looked at this again: «faltaron» is what DID NOT ARRIVE, not «me hacen falta», and the customer asks for nothing in it.",
      },
      { messageId: "X1-02", because: "an apology and an intention" },
      {
        messageId: "X1-03",
        because:
          "A QUESTION, not a commitment. «¿le parece si…?» proposes; the promise is X1-05. A crossing here would file a promise before the customer agreed to it.",
      },
      { messageId: "X1-04", because: "the customer agrees to a proposal; the promise is the rep's next message" },
    ],
  },

  {
    id: "b-dia-completo-fuentes",
    exercises: "a busy day: two quotes, an order, a date and contact details",
    counterparty: "Ferretería Fuentes",
    messages: [
      { id: "B1-01", fromMe: false, atMinute: 505, text: "buenos días, ¿me cotiza 25 bultos de cemento?" },
      { id: "B1-02", fromMe: true, atMinute: 512, text: "buenos días, los 25 bultos en 5,125" },
      { id: "B1-03", fromMe: false, atMinute: 520, text: "¿y si le subo a 50?" },
      { id: "B1-04", fromMe: true, atMinute: 528, text: "los 50 se los dejo en 9,800" },
      { id: "B1-05", fromMe: false, atMinute: 545, text: "va, mándeme los 50" },
      { id: "B1-06", fromMe: true, atMinute: 550, text: "perfecto, se los entrego el 8 de septiembre" },
      { id: "B1-07", fromMe: true, atMinute: 552, text: "¿me confirma el correo para la factura?" },
      { id: "B1-08", fromMe: false, atMinute: 570, text: "admin@fuentes.com.mx" },
      { id: "B1-09", fromMe: false, atMinute: 572, text: "gracias por el apoyo" },
    ],
    labels: [
      {
        messageId: "B1-02",
        factType: "QuoteGiven",
        because: "a stated price for a stated quantity",
        checks: [
          { path: "amount", equals: 5125 },
          { path: "quantity", equals: 25 },
          { path: "currency", absentOrEquals: "MXN" },
          { path: "requestedFor", absent: true },
        ],
      },
      {
        messageId: "B1-04",
        factType: "QuoteGiven",
        because:
          "a SECOND quote at a different quantity — not a correction of the first, so both stand",
        checks: [
          { path: "amount", equals: 9800 },
          { path: "quantity", equals: 50 },
          { path: "currency", absentOrEquals: "MXN" },
          { path: "requestedFor", absent: true },
        ],
      },
      {
        messageId: "B1-05",
        factType: "OrderRequested",
        because: "the customer orders the 50",
        checks: [
          { path: "quantity", equals: 50 },
          { path: "amount", absentOrEquals: 9800 },
          { path: "currency", absentOrEquals: "MXN" },
          { path: "requestedFor", absent: true },
        ],
      },
      {
        messageId: "B1-06",
        factType: "DatePromised",
        because: "an explicit calendar date",
        checks: [
          { path: "dueOn", equals: "2026-09-08" },
        ],
      },
      {
        messageId: "B1-06",
        factType: "OrderTaken",
        because:
          "the rep agrees to the 50 the customer asked for and names the day. The quantity is the AGREED one, which is why it is graded",
        checks: [
          { path: "quantity", equals: 50 },
          { path: "amount", absentOrEquals: 9800 },
          { path: "currency", absentOrEquals: "MXN" },
          { path: "requestedFor", absent: true },
        ],
      },
      {
        messageId: "B1-08",
        factType: "ContactEstablished",
        because: "an email stated outright, normalized lowercase",
        checks: [
          { path: "identifiers.phones", equalsAll: [] },
          { path: "identifiers.emails", equalsAll: ["admin@fuentes.com.mx"] },
          { path: "identifiers.rfcs", equalsAll: [] },
        ],
      },
    ],
    silent: [
      { messageId: "B1-01", because: "a request for a quote" },
      { messageId: "B1-03", because: "the customer asks about a larger quantity; nothing quoted yet" },
      { messageId: "B1-07", because: "the rep asks for details; none established yet" },
      { messageId: "B1-09", because: "thanks" },
    ],
  },

  {
    id: "b-dia-completo-norte",
    exercises: "a busy day with a partial order and two promises",
    counterparty: "Materiales del Norte",
    messages: [
      { id: "B2-01", fromMe: false, atMinute: 495, text: "necesito 300 blocks y 15 sacos de mortero" },
      { id: "B2-02", fromMe: true, atMinute: 510, text: "los 300 blocks en 4,500" },
      { id: "B2-03", fromMe: true, atMinute: 512, text: "el mortero a 190 el saco" },
      { id: "B2-04", fromMe: false, atMinute: 540, text: "mándeme los 300 blocks nada más" },
      { id: "B2-05", fromMe: true, atMinute: 548, text: "listo. los blocks se los llevo el 9 de septiembre" },
      { id: "B2-06", fromMe: true, atMinute: 551, text: "y el mortero se lo aparto para el 16 de septiembre por si lo quiere" },
      { id: "B2-07", fromMe: false, atMinute: 600, text: "ok gracias" },
    ],
    labels: [
      {
        messageId: "B2-01",
        factType: "OrderRequested",
        because:
          "«necesito 300 blocks y 15 sacos de mortero» — the blocks half. FOUND BY THE #83 SWEEP, not named in the ticket: the same shape as BD-02, B6-01 and Q2-01, and the ruling has to reach it or the instrument disagrees with itself. RULING (#83, Diego 2026-08-30): «these sound more like requests as the customer would not say it needs something to the rep if he doesnt want that order». Claimed silent as «a request for two quantities, not an order». `amount` and the day's price: this ask PRECEDES every price the day states, so the figure is pinned ABSENT rather than carried forward. `absentOrEquals` is for a carried-forward value — corpus.ts's own words, «an order that FOLLOWS a quote may honestly carry that quote's price» — and the direction is the whole of it: a customer saying «va» to a figure already on the table is accepting it, while a customer who asks before anybody has priced anything has named no number at all. A crossing carrying the later figure would render «Te pidió … por … MXN» about a message written before that price existed, which is the provenance laundering #70 named `requestedFor` apart from `dueOn` to prevent, in the money field instead of the date one. Both review axes found this independently.",
        checks: [
          { path: "quantity", equals: 300 },
          { path: "amount", absent: true },
          { path: "currency", absentOrEquals: "MXN" },
          { path: "requestedFor", absent: true },
        ],
      },
      {
        messageId: "B2-01",
        factType: "OrderRequested",
        because:
          "«necesito 300 blocks y 15 sacos de mortero» — the mortar half, on the same ruling (#83), and the unmet-demand half of this day: the customer says «nada más» in B2-04 and the mortar is never ordered. `amount` is ABSENT twice over: this ask precedes every price the day states (as above), and the day never states a price for FIFTEEN sacks at all — B2-03 quotes «a 190 el saco», a rate, so 190 here would be the per-unit-price-as-total error the extractor already has a rule against, and 2,850 would be arithmetic the conversation never did.",
        checks: [
          { path: "quantity", equals: 15 },
          { path: "amount", absent: true },
          { path: "currency", absentOrEquals: "MXN" },
          { path: "requestedFor", absent: true },
        ],
      },
      {
        messageId: "B2-02",
        factType: "QuoteGiven",
        because: "a stated total for a stated quantity",
        checks: [
          { path: "amount", equals: 4500 },
          { path: "quantity", equals: 300 },
          { path: "currency", absentOrEquals: "MXN" },
          { path: "requestedFor", absent: true },
        ],
      },
      {
        messageId: "B2-03",
        factType: "QuoteGiven",
        because: "a unit price; no quantity is quoted here",
        checks: [
          { path: "amount", equals: 190 },
          { path: "quantity", absent: true },
          { path: "currency", absentOrEquals: "MXN" },
          { path: "requestedFor", absent: true },
        ],
      },
      {
        messageId: "B2-04",
        factType: "OrderRequested",
        because: "the customer orders the blocks and not the mortar",
        checks: [
          { path: "quantity", equals: 300 },
          { path: "amount", absentOrEquals: 4500 },
          { path: "currency", absentOrEquals: "MXN" },
          { path: "requestedFor", absent: true },
        ],
      },
      {
        messageId: "B2-05",
        factType: "DatePromised",
        because: "an explicit calendar date for the delivery",
        checks: [
          { path: "dueOn", equals: "2026-09-09" },
        ],
      },
      {
        messageId: "B2-05",
        factType: "OrderTaken",
        because:
          "«listo» plus a delivery commitment for the blocks the customer ordered. The mortero in B2-06 is NOT agreed to — the customer said «nada más», and «por si lo quiere» is an offer, not an answer to a request",
        checks: [
          { path: "quantity", equals: 300 },
          { path: "amount", absentOrEquals: 4500 },
          { path: "currency", absentOrEquals: "MXN" },
          { path: "requestedFor", absent: true },
        ],
      },
      {
        messageId: "B2-06",
        factType: "DatePromised",
        because: "a second, separate commitment with its own explicit date",
        checks: [
          { path: "dueOn", equals: "2026-09-16" },
        ],
      },
    ],
    silent: [
      { messageId: "B2-07", because: "an acknowledgement" },
    ],
  },

  {
    id: "b-dia-completo-aguilar",
    exercises: "a day mixing facts with the rep's own commentary",
    counterparty: "Constructora Aguilar",
    messages: [
      { id: "B3-01", fromMe: true, atMinute: 500, text: "este cliente paga tarde, hay que apurarlo siempre" },
      { id: "B3-02", fromMe: false, atMinute: 530, text: "¿me pasa precio de 80 varillas del 1/2?" },
      { id: "B3-03", fromMe: true, atMinute: 545, text: "las 80 varillas en 16,400" },
      { id: "B3-04", fromMe: false, atMinute: 600, text: "sale, mándemelas" },
      { id: "B3-05", fromMe: true, atMinute: 610, text: "se las tengo el 11 de septiembre en la obra" },
      { id: "B3-06", fromMe: false, atMinute: 620, text: "mi RFC es AGU900301-KL5 para la factura" },
      { id: "B3-07", fromMe: true, atMinute: 625, text: "anotado" },
    ],
    labels: [
      {
        messageId: "B3-03",
        factType: "QuoteGiven",
        because: "a stated total for a stated quantity",
        checks: [
          { path: "amount", equals: 16400 },
          { path: "quantity", equals: 80 },
          { path: "currency", absentOrEquals: "MXN" },
          { path: "requestedFor", absent: true },
        ],
      },
      {
        messageId: "B3-04",
        factType: "OrderRequested",
        because: "the customer confirms the order at the quoted quantity",
        checks: [
          { path: "quantity", equals: 80 },
          { path: "amount", absentOrEquals: 16400 },
          { path: "currency", absentOrEquals: "MXN" },
          { path: "requestedFor", absent: true },
        ],
      },
      {
        messageId: "B3-05",
        factType: "DatePromised",
        because: "an explicit calendar date",
        checks: [
          { path: "dueOn", equals: "2026-09-11" },
        ],
      },
      {
        messageId: "B3-05",
        factType: "OrderTaken",
        because:
          "a commitment to deliver the 80 varillas the customer asked for — agreement by action, with no yes in it",
        checks: [
          { path: "quantity", equals: 80 },
          { path: "amount", absentOrEquals: 16400 },
          { path: "currency", absentOrEquals: "MXN" },
          { path: "requestedFor", absent: true },
        ],
      },
      {
        messageId: "B3-06",
        factType: "ContactEstablished",
        because: "an RFC stated outright, normalized uppercase without the hyphen",
        checks: [
          { path: "identifiers.phones", equalsAll: [] },
          { path: "identifiers.emails", equalsAll: [] },
          { path: "identifiers.rfcs", equalsAll: ["AGU900301KL5"] },
        ],
      },
    ],
    silent: [
      {
        messageId: "B3-01",
        because:
          "the rep's own judgment about how this customer pays — an aperture breach if it crosses, and rep-authored, so the `CustomerPattern` fence refuses it in code (#61). The same thing said by the CUSTOMER is a different message and a real fact; see `PB-04`.",
      },
      { messageId: "B3-02", because: "a request for a price" },
      { messageId: "B3-07", because: "an acknowledgement" },
    ],
  },

  {
    id: "b-dia-completo-molina",
    exercises: "a day where the customer negotiates and the rep holds the price",
    counterparty: "Herrería Molina",
    messages: [
      { id: "B4-01", fromMe: false, atMinute: 480, text: "¿en cuánto los 12 perfiles?" },
      { id: "B4-02", fromMe: true, atMinute: 495, text: "los 12 en 7,320" },
      { id: "B4-03", fromMe: false, atMinute: 505, text: "¿no me hace un descuento?" },
      { id: "B4-04", fromMe: true, atMinute: 515, text: "es lo mejor que le puedo hacer, se quedan en 7,320" },
      { id: "B4-05", fromMe: false, atMinute: 560, text: "está bien, écheme los 12" },
      { id: "B4-06", fromMe: true, atMinute: 565, text: "gracias, se los mando el 15 de septiembre" },
      { id: "B4-07", fromMe: false, atMinute: 570, text: "el correo para factura es pagos@molina.mx" },
    ],
    labels: [
      {
        messageId: "B4-02",
        factType: "QuoteGiven",
        because: "a stated total for a stated quantity",
        checks: [
          { path: "amount", equals: 7320 },
          { path: "quantity", equals: 12 },
          { path: "currency", absentOrEquals: "MXN" },
          { path: "requestedFor", absent: true },
        ],
      },
      {
        messageId: "B4-05",
        factType: "OrderRequested",
        because: "the customer orders after the price is held",
        checks: [
          { path: "quantity", equals: 12 },
          { path: "amount", absentOrEquals: 7320 },
          { path: "currency", absentOrEquals: "MXN" },
          { path: "requestedFor", absent: true },
        ],
      },
      {
        messageId: "B4-06",
        factType: "DatePromised",
        because: "an explicit calendar date",
        checks: [
          { path: "dueOn", equals: "2026-09-15" },
        ],
      },
      {
        messageId: "B4-06",
        factType: "OrderTaken",
        because:
          "the rep commits to send the 12 the customer ordered",
        checks: [
          { path: "quantity", equals: 12 },
          { path: "amount", absentOrEquals: 7320 },
          { path: "currency", absentOrEquals: "MXN" },
          { path: "requestedFor", absent: true },
        ],
      },
      {
        messageId: "B4-07",
        factType: "ContactEstablished",
        because: "an email stated outright",
        checks: [
          { path: "identifiers.phones", equalsAll: [] },
          { path: "identifiers.emails", equalsAll: ["pagos@molina.mx"] },
          { path: "identifiers.rfcs", equalsAll: [] },
        ],
      },
    ],
    silent: [
      { messageId: "B4-01", because: "a request for a price" },
      { messageId: "B4-03", because: "the customer asks for a discount" },
      {
        messageId: "B4-04",
        because:
          "RESTATES the same price rather than quoting a new one. A crossing here is a duplicate of B4-02's quote, which the scorer counts as a false positive because filing a thing twice in an append-only store is filing it wrong.",
      },
    ],
  },

  {
    id: "b-dia-completo-pena",
    exercises: "a day whose only facts are contact details, across two messages",
    counterparty: "Distribuidora Peña",
    messages: [
      { id: "B5-01", fromMe: true, atMinute: 520, text: "para dar de alta su cuenta necesito RFC, correo y un teléfono fijo" },
      { id: "B5-02", fromMe: false, atMinute: 560, text: "RFC dpe880917-t44" },
      { id: "B5-03", fromMe: false, atMinute: 562, text: "correo cuentas@pena.com y el fijo 33 2200 3311, pregunte por Laura" },
      { id: "B5-04", fromMe: true, atMinute: 570, text: "listo, ya quedó" },
      { id: "B5-05", fromMe: false, atMinute: 580, text: "¿y cuándo pasan por la firma?" },
      { id: "B5-06", fromMe: true, atMinute: 590, text: "esta semana le aviso" },
    ],
    labels: [
      {
        messageId: "B5-02",
        factType: "ContactEstablished",
        because: "an RFC stated outright, normalized uppercase",
        checks: [
          { path: "identifiers.phones", equalsAll: [] },
          { path: "identifiers.emails", equalsAll: [] },
          { path: "identifiers.rfcs", equalsAll: ["DPE880917T44"] },
        ],
      },
      {
        messageId: "B5-03",
        factType: "ContactEstablished",
        because:
          "an email and a landline in one message — both are identifiers, and the landline is NOT the chat's own number so it is not chat identity",
        checks: [
          { path: "identifiers.phones", equalsAll: ["+523322003311"] },
          { path: "identifiers.emails", equalsAll: ["cuentas@pena.com"] },
          { path: "identifiers.rfcs", equalsAll: [] },
        ],
      },
    ],
    silent: [
      {
        messageId: "B5-01",
        because:
          "«para dar de alta su cuenta NECESITO RFC, correo y un teléfono fijo» — the ruling's verb in the REP's mouth (#83), and about paperwork rather than goods. `OrderRequested` is counterparty-authored (FACT_AUTHORSHIP, ADR-0038), so the aperture would refuse a crossing here whatever the words said; the identifiers are ESTABLISHED in B5-02 and B5-03, not by being asked for.",
      },
      { messageId: "B5-04", because: "an acknowledgement" },
      { messageId: "B5-05", because: "the customer asks" },
      {
        messageId: "B5-06",
        because:
          "«esta semana le aviso» promises a notification rather than a delivery, with no date — the reading this corpus takes is that it states nothing checkable",
      },
    ],
  },

  {
    id: "b-dia-completo-vallejo",
    exercises: "quantities in words and units, and a date given as a weekday plus a number",
    counterparty: "Grupo Vallejo",
    messages: [
      { id: "B6-01", fromMe: false, atMinute: 510, text: "ocupo cien metros de cable calibre 12" },
      { id: "B6-02", fromMe: true, atMinute: 525, text: "los cien metros en 3,900" },
      { id: "B6-03", fromMe: false, atMinute: 540, text: "va, los cien" },
      { id: "B6-04", fromMe: true, atMinute: 545, text: "se los entrego el martes 22 de septiembre" },
      { id: "B6-05", fromMe: false, atMinute: 550, text: "de acuerdo" },
      { id: "B6-06", fromMe: false, atMinute: 700, text: "oiga, ¿tiene también tubo conduit?" },
      { id: "B6-07", fromMe: true, atMinute: 710, text: "sí tengo, ahorita le paso precio" },
    ],
    labels: [
      {
        messageId: "B6-01",
        factType: "OrderRequested",
        because:
          "«ocupo cien metros de cable calibre 12» — the customer names the goods and the quantity and asks to be supplied them. RULING (#83, Diego 2026-08-30): «these sound more like requests as the customer would not say it needs something to the rep if he doesnt want that order». Claimed silent as «a stated need, not an order» before the ruling; a stated need addressed to the person who sells the thing IS the ask. The quantity is spelled out in words and is still a hundred. `amount` and the day's price: this ask PRECEDES every price the day states, so the figure is pinned ABSENT rather than carried forward. `absentOrEquals` is for a carried-forward value — corpus.ts's own words, «an order that FOLLOWS a quote may honestly carry that quote's price» — and the direction is the whole of it: a customer saying «va» to a figure already on the table is accepting it, while a customer who asks before anybody has priced anything has named no number at all. A crossing carrying the later figure would render «Te pidió … por … MXN» about a message written before that price existed, which is the provenance laundering #70 named `requestedFor` apart from `dueOn` to prevent, in the money field instead of the date one. Both review axes found this independently.",
        checks: [
          { path: "quantity", equals: 100 },
          { path: "amount", absent: true },
          { path: "currency", absentOrEquals: "MXN" },
          { path: "requestedFor", absent: true },
        ],
      },
      {
        messageId: "B6-02",
        factType: "QuoteGiven",
        because: "a stated total; the quantity is spelled out in words and is still a hundred",
        checks: [
          { path: "amount", equals: 3900 },
          { path: "quantity", equals: 100 },
          { path: "currency", absentOrEquals: "MXN" },
          { path: "requestedFor", absent: true },
        ],
      },
      {
        messageId: "B6-03",
        factType: "OrderRequested",
        because: "the customer orders the hundred metres",
        checks: [
          { path: "quantity", equals: 100 },
          { path: "amount", absentOrEquals: 3900 },
          { path: "currency", absentOrEquals: "MXN" },
          { path: "requestedFor", absent: true },
        ],
      },
      {
        messageId: "B6-04",
        factType: "DatePromised",
        because: "an explicit calendar date, given with its weekday",
        checks: [
          { path: "dueOn", equals: "2026-09-22" },
        ],
      },
      {
        messageId: "B6-04",
        factType: "OrderTaken",
        because:
          "the rep commits to deliver the hundred metres the customer ordered",
        checks: [
          { path: "quantity", equals: 100 },
          { path: "amount", absentOrEquals: 3900 },
          { path: "currency", absentOrEquals: "MXN" },
          { path: "requestedFor", absent: true },
        ],
      },
    ],
    silent: [
      { messageId: "B6-05", because: "an acknowledgement" },
      { messageId: "B6-06", because: "an availability question" },
      { messageId: "B6-07", because: "availability plus an intention to quote — no figure stated" },
    ],
  },

  {
    id: "b-dia-completo-salinas",
    exercises: "a day with a discount stated as a percentage and a total that follows",
    counterparty: "Bodega Salinas",
    messages: [
      { id: "B7-01", fromMe: false, atMinute: 500, text: "¿cuánto por 500 tabiques?" },
      { id: "B7-02", fromMe: true, atMinute: 520, text: "normalmente 9,500, pero por volumen se los dejo en 8,550" },
      { id: "B7-03", fromMe: false, atMinute: 560, text: "trato hecho, los 500" },
      { id: "B7-04", fromMe: true, atMinute: 565, text: "va. entrego el 18 de septiembre en su bodega" },
      { id: "B7-05", fromMe: false, atMinute: 600, text: "mi tel de bodega es 55 7788 9900" },
      { id: "B7-06", fromMe: true, atMinute: 605, text: "anotado, gracias" },
    ],
    labels: [
      {
        messageId: "B7-02",
        factType: "QuoteGiven",
        because:
          "the quoted figure is the one the rep actually gives — 8,550. 9,500 is a list price the message explicitly does not quote, and a crossing at 9,500 is the wrong number in the record.",
        checks: [
          { path: "amount", equals: 8550 },
          { path: "quantity", equals: 500 },
          { path: "currency", absentOrEquals: "MXN" },
          { path: "requestedFor", absent: true },
        ],
      },
      {
        messageId: "B7-03",
        factType: "OrderRequested",
        because: "the customer accepts and orders the 500",
        checks: [
          { path: "quantity", equals: 500 },
          { path: "amount", absentOrEquals: 8550 },
          { path: "currency", absentOrEquals: "MXN" },
          { path: "requestedFor", absent: true },
        ],
      },
      {
        messageId: "B7-04",
        factType: "DatePromised",
        because: "an explicit calendar date",
        checks: [
          { path: "dueOn", equals: "2026-09-18" },
        ],
      },
      {
        messageId: "B7-04",
        factType: "OrderTaken",
        because:
          "«va» and a delivery, answering «trato hecho, los 500»",
        checks: [
          { path: "quantity", equals: 500 },
          { path: "amount", absentOrEquals: 8550 },
          { path: "currency", absentOrEquals: "MXN" },
          { path: "requestedFor", absent: true },
        ],
      },
      {
        messageId: "B7-05",
        factType: "ContactEstablished",
        because:
          "a warehouse phone — not the chat's own address, so it is a real contact rather than chat identity",
        checks: [
          { path: "identifiers.phones", equalsAll: ["+525577889900"] },
          { path: "identifiers.emails", equalsAll: [] },
          { path: "identifiers.rfcs", equalsAll: [] },
        ],
      },
    ],
    silent: [
      { messageId: "B7-01", because: "a request for a price" },
      { messageId: "B7-06", because: "an acknowledgement" },
    ],
  },

  {
    id: "b-dia-completo-rivas",
    exercises: "an order without a prior quote, and a promise the customer proposed",
    counterparty: "Comercializadora Rivas",
    messages: [
      { id: "B8-01", fromMe: false, atMinute: 490, text: "mándeme lo de siempre, 20 cubetas de impermeabilizante" },
      { id: "B8-02", fromMe: true, atMinute: 500, text: "va, las 20 cubetas" },
      { id: "B8-03", fromMe: false, atMinute: 505, text: "¿me las puede tener el 25 de septiembre?" },
      { id: "B8-04", fromMe: true, atMinute: 515, text: "sí, el 25 de septiembre las tiene" },
      { id: "B8-05", fromMe: false, atMinute: 520, text: "gracias" },
      { id: "B8-06", fromMe: false, atMinute: 900, text: "por cierto, cambió mi correo: nuevo@rivas.mx" },
    ],
    labels: [
      {
        messageId: "B8-01",
        factType: "OrderRequested",
        because: "the customer places an order outright; no quote preceded it and none is needed",
        checks: [
          { path: "quantity", equals: 20 },
          { path: "amount", absent: true },
          { path: "currency", absentOrEquals: "MXN" },
          { path: "requestedFor", absent: true },
        ],
      },
      {
        messageId: "B8-02",
        factType: "OrderTaken",
        because:
          "«va, las 20 cubetas» is the agreement, and it comes before the date question. B8-04 answers a DIFFERENT question — the day — and is the DatePromised, not a second agreement",
        checks: [
          { path: "quantity", equals: 20 },
          { path: "amount", absent: true },
          { path: "currency", absentOrEquals: "MXN" },
          { path: "requestedFor", absent: true },
        ],
      },
      {
        messageId: "B8-04",
        factType: "DatePromised",
        because:
          "the REP commits to the date. B8-03 only proposed it — the commitment is this message.",
        checks: [
          { path: "dueOn", equals: "2026-09-25" },
        ],
      },
      {
        messageId: "B8-06",
        factType: "ContactEstablished",
        because: "a new email stated outright",
        checks: [
          { path: "identifiers.phones", equalsAll: [] },
          { path: "identifiers.emails", equalsAll: ["nuevo@rivas.mx"] },
          { path: "identifiers.rfcs", equalsAll: [] },
        ],
      },
    ],
    silent: [
      {
        messageId: "B8-03",
        because:
          "the CUSTOMER asks for a date. A promise is the rep's; a crossing here files a commitment before the rep made one.",
      },
      { messageId: "B8-05", because: "thanks" },
    ],
  },

  {
    id: "b-dia-completo-beltran",
    exercises: "two quotes for two products and a single combined order",
    counterparty: "Aceros Beltrán",
    messages: [
      { id: "B9-01", fromMe: false, atMinute: 505, text: "necesito precio de lámina y de solera" },
      { id: "B9-02", fromMe: true, atMinute: 525, text: "la lámina, 30 hojas en 12,600" },
      { id: "B9-03", fromMe: true, atMinute: 527, text: "la solera, 40 tramos en 6,800" },
      { id: "B9-04", fromMe: false, atMinute: 590, text: "mándeme las 30 hojas de lámina" },
      { id: "B9-05", fromMe: false, atMinute: 592, text: "y los 40 tramos de solera también" },
      { id: "B9-06", fromMe: true, atMinute: 600, text: "todo junto se lo entrego el 19 de septiembre" },
    ],
    labels: [
      {
        messageId: "B9-02",
        factType: "QuoteGiven",
        because: "a stated total for a stated quantity of sheet",
        checks: [
          { path: "amount", equals: 12600 },
          { path: "quantity", equals: 30 },
          { path: "currency", absentOrEquals: "MXN" },
          { path: "requestedFor", absent: true },
        ],
      },
      {
        messageId: "B9-03",
        factType: "QuoteGiven",
        because: "a separate stated total for a separate product",
        checks: [
          { path: "amount", equals: 6800 },
          { path: "quantity", equals: 40 },
          { path: "currency", absentOrEquals: "MXN" },
          { path: "requestedFor", absent: true },
        ],
      },
      {
        messageId: "B9-04",
        factType: "OrderRequested",
        because: "the customer orders the sheet",
        checks: [
          { path: "quantity", equals: 30 },
          { path: "amount", absentOrEquals: 12600 },
          { path: "currency", absentOrEquals: "MXN" },
          { path: "requestedFor", absent: true },
        ],
      },
      {
        messageId: "B9-05",
        factType: "OrderRequested",
        because: "a second order in its own message",
        checks: [
          { path: "quantity", equals: 40 },
          { path: "amount", absentOrEquals: 6800 },
          { path: "currency", absentOrEquals: "MXN" },
          { path: "requestedFor", absent: true },
        ],
      },
      {
        messageId: "B9-06",
        factType: "DatePromised",
        because: "an explicit calendar date covering both",
        checks: [
          { path: "dueOn", equals: "2026-09-19" },
        ],
      },
      {
        messageId: "B9-06",
        factType: "OrderTaken",
        because:
          "the second half of the same agreement: the 40 tramos of solera the customer ordered in B9-05",
        checks: [
          { path: "quantity", equals: 40 },
          { path: "amount", absentOrEquals: 6800 },
          { path: "currency", absentOrEquals: "MXN" },
          { path: "requestedFor", absent: true },
        ],
      },
      {
        messageId: "B9-06",
        factType: "OrderTaken",
        because:
          "one message agreeing to BOTH orders, so it carries two facts — the lámina here, the solera beside it. The corpus already labels two quotes in one message the same way",
        checks: [
          { path: "quantity", equals: 30 },
          { path: "amount", absentOrEquals: 12600 },
          { path: "currency", absentOrEquals: "MXN" },
          { path: "requestedFor", absent: true },
        ],
      },
    ],
    silent: [
      {
        messageId: "B9-01",
        because:
          "THE LINE #83's RULING DOES NOT CROSS, and the one message in the corpus where both halves meet: «necesito PRECIO de lámina y de solera» is «necesito» in front of a PRICE. What the customer needs is a number, so this is a request for two quotes and the facts it produces are the rep's, in B9-02 and B9-03. The ruling widened which phrasings count as asking to be SENT something; it did not collapse asking what something COSTS into an order (Q5-01 carries the same distinction, from the other side). «Te pidió lámina y solera» about this message would be false — the ask is B9-04 and B9-05.",
      },
    ],
  },

  {
    id: "b-dia-completo-central",
    exercises: "prices written with a peso sign and thousands separators",
    counterparty: "Ferretería La Central",
    messages: [
      { id: "BA-01", fromMe: false, atMinute: 510, text: "¿cuánto sale el pedido completo?" },
      { id: "BA-02", fromMe: true, atMinute: 530, text: "todo junto le sale en $14,250 MXN" },
      { id: "BA-03", fromMe: false, atMinute: 545, text: "ok, adelante con todo" },
      { id: "BA-04", fromMe: true, atMinute: 550, text: "listo. sale el 24 de septiembre" },
      { id: "BA-05", fromMe: false, atMinute: 560, text: "¿me lo puede facturar a central.compras@lacentral.mx?" },
      { id: "BA-06", fromMe: true, atMinute: 565, text: "claro que sí" },
    ],
    labels: [
      {
        messageId: "BA-02",
        factType: "QuoteGiven",
        because: "a stated total in MXN; the currency is written out in the message",
        checks: [
          { path: "amount", equals: 14250 },
          { path: "currency", equals: "MXN" },
          { path: "quantity", absent: true },
          { path: "requestedFor", absent: true },
        ],
      },
      {
        messageId: "BA-03",
        factType: "OrderRequested",
        because:
          "the customer confirms the whole order. It names no quantity, so one would be invented — but the day quotes 14,250, so an order carrying that price is reading the day.",
        checks: [
          { path: "quantity", absent: true },
          { path: "amount", absentOrEquals: 14250 },
          { path: "currency", absentOrEquals: "MXN" },
          { path: "requestedFor", absent: true },
        ],
      },
      {
        messageId: "BA-04",
        factType: "DatePromised",
        because: "an explicit calendar date",
        checks: [
          { path: "dueOn", equals: "2026-09-24" },
        ],
      },
      {
        messageId: "BA-04",
        factType: "OrderTaken",
        because:
          "«listo» answers «adelante con todo». No quantity was ever stated, so one would be invented; the day quotes 14,250",
        checks: [
          { path: "quantity", absent: true },
          { path: "amount", absentOrEquals: 14250 },
          { path: "currency", absentOrEquals: "MXN" },
          { path: "requestedFor", absent: true },
        ],
      },
      {
        messageId: "BA-05",
        factType: "ContactEstablished",
        because:
          "a billing email the customer states — the request wrapping it does not stop it being established",
        checks: [
          { path: "identifiers.phones", equalsAll: [] },
          { path: "identifiers.emails", equalsAll: ["central.compras@lacentral.mx"] },
          { path: "identifiers.rfcs", equalsAll: [] },
        ],
      },
    ],
    silent: [
      { messageId: "BA-01", because: "the customer asks the total" },
      { messageId: "BA-06", because: "an acknowledgement" },
    ],
  },

  {
    id: "b-dia-completo-ruiz",
    exercises: "an order stated as a repeat of a previous one",
    counterparty: "Tlapalería Ruiz",
    messages: [
      { id: "BB-01", fromMe: false, atMinute: 500, text: "repítame el pedido del mes pasado, los 80 bultos" },
      { id: "BB-02", fromMe: true, atMinute: 510, text: "va, 80 bultos" },
      { id: "BB-03", fromMe: true, atMinute: 512, text: "mismo precio, 16,000" },
      { id: "BB-04", fromMe: false, atMinute: 520, text: "perfecto" },
      { id: "BB-05", fromMe: true, atMinute: 540, text: "se lo dejo el 26 de septiembre" },
      { id: "BB-06", fromMe: false, atMinute: 545, text: "ahí estaré" },
    ],
    labels: [
      {
        messageId: "BB-01",
        factType: "OrderRequested",
        because: "the customer places an order and states its quantity",
        checks: [
          { path: "quantity", equals: 80 },
          { path: "amount", absent: true },
          { path: "currency", absentOrEquals: "MXN" },
          { path: "requestedFor", absent: true },
        ],
      },
      {
        messageId: "BB-02",
        factType: "OrderTaken",
        because:
          "«va, 80 bultos» agrees to the repeat order before the price is even restated",
        checks: [
          { path: "quantity", equals: 80 },
          { path: "amount", absent: true },
          { path: "currency", absentOrEquals: "MXN" },
          { path: "requestedFor", absent: true },
        ],
      },
      {
        messageId: "BB-03",
        factType: "QuoteGiven",
        because:
          "the rep states the figure in this conversation; that it matches a past one changes nothing. The quantity is the 80 the customer named one message earlier, so carrying it is reading the day rather than inventing.",
        checks: [
          { path: "amount", equals: 16000 },
          { path: "quantity", absentOrEquals: 80 },
          { path: "currency", absentOrEquals: "MXN" },
          { path: "requestedFor", absent: true },
        ],
      },
      {
        messageId: "BB-05",
        factType: "DatePromised",
        because: "an explicit calendar date",
        checks: [
          { path: "dueOn", equals: "2026-09-26" },
        ],
      },
    ],
    silent: [
      { messageId: "BB-04", because: "an acknowledgement" },
      { messageId: "BB-06", because: "an acknowledgement" },
    ],
  },

  {
    id: "b-dia-completo-papeleria",
    exercises: "small amounts, and a promise about availability rather than delivery",
    counterparty: "Papelería del Centro",
    messages: [
      { id: "BC-01", fromMe: false, atMinute: 495, text: "¿tiene cajas de archivo?" },
      { id: "BC-02", fromMe: true, atMinute: 505, text: "sí, la caja a 78 pesos" },
      { id: "BC-03", fromMe: false, atMinute: 530, text: "deme 24" },
      { id: "BC-04", fromMe: true, atMinute: 535, text: "las 24 en 1,872" },
      { id: "BC-05", fromMe: true, atMinute: 540, text: "le confirmo que las tengo apartadas hasta el 30 de septiembre" },
      { id: "BC-06", fromMe: false, atMinute: 545, text: "gracias" },
    ],
    labels: [
      {
        messageId: "BC-02",
        factType: "QuoteGiven",
        because: "a unit price with no quantity quoted",
        checks: [
          { path: "amount", equals: 78 },
          { path: "quantity", absent: true },
          { path: "currency", absentOrEquals: "MXN" },
          { path: "requestedFor", absent: true },
        ],
      },
      {
        messageId: "BC-03",
        factType: "OrderRequested",
        because: "the customer orders 24",
        checks: [
          { path: "quantity", equals: 24 },
          { path: "amount", absentOrEquals: 1872 },
          { path: "currency", absentOrEquals: "MXN" },
          { path: "requestedFor", absent: true },
        ],
      },
      {
        messageId: "BC-04",
        factType: "QuoteGiven",
        because: "a second quote — the total for the ordered quantity",
        checks: [
          { path: "amount", equals: 1872 },
          { path: "quantity", equals: 24 },
          { path: "currency", absentOrEquals: "MXN" },
          { path: "requestedFor", absent: true },
        ],
      },
      {
        messageId: "BC-05",
        factType: "DatePromised",
        because: "an availability commitment with an explicit calendar date",
        checks: [
          { path: "dueOn", equals: "2026-09-30" },
        ],
      },
      {
        messageId: "BC-05",
        factType: "OrderTaken",
        because:
          "holding the 24 boxes for the customer is agreeing to supply them — the customer asked («deme 24») and the rep answered by reserving them. Contrast B2-06, where nobody asked and «por si lo quiere» is an offer",
        checks: [
          { path: "quantity", equals: 24 },
          { path: "amount", absentOrEquals: 1872 },
          { path: "currency", absentOrEquals: "MXN" },
          { path: "requestedFor", absent: true },
        ],
      },
    ],
    silent: [
      { messageId: "BC-01", because: "an availability question" },
      { messageId: "BC-06", because: "thanks" },
    ],
  },

  {
    id: "b-dia-completo-golfo",
    exercises: "a day whose numbers are all in the customer's messages",
    counterparty: "Aceros del Golfo",
    messages: [
      { id: "BD-01", fromMe: false, atMinute: 500, text: "traigo presupuesto de 50,000 para este mes" },
      { id: "BD-02", fromMe: false, atMinute: 502, text: "quiero 150 varillas y 40 bultos" },
      { id: "BD-03", fromMe: true, atMinute: 530, text: "las 150 varillas en 30,750" },
      { id: "BD-04", fromMe: true, atMinute: 532, text: "los 40 bultos en 8,200" },
      { id: "BD-05", fromMe: false, atMinute: 600, text: "mándeme las 150 varillas" },
      { id: "BD-06", fromMe: true, atMinute: 610, text: "se las entrego el 29 de septiembre" },
    ],
    labels: [
      {
        messageId: "BD-02",
        factType: "OrderRequested",
        because:
          "«quiero 150 varillas y 40 bultos» — the rebar half. RULING (#83, Diego 2026-08-30): «these sound more like requests as the customer would not say it needs something to the rep if he doesnt want that order». Claimed silent as «a statement of what the customer wants; nothing quoted or confirmed» — and wanting it, said to the person who sells it, is the ask. Two goods in one message are two facts, the way the corpus already labels two quotes in one message (Q4-02) and two agreements in one (B9-06). The 150 varillas are asked for twice in this day — here, and again in BD-05 once the price is known — and both are the customer asking, on two messages: nothing links a request to a later one (ADR-0038), and this is not B8-03, where the customer asks about the DAY of an ask already filed and names no goods at all. `amount` and the day's price: this ask PRECEDES every price the day states, so the figure is pinned ABSENT rather than carried forward. `absentOrEquals` is for a carried-forward value — corpus.ts's own words, «an order that FOLLOWS a quote may honestly carry that quote's price» — and the direction is the whole of it: a customer saying «va» to a figure already on the table is accepting it, while a customer who asks before anybody has priced anything has named no number at all. A crossing carrying the later figure would render «Te pidió … por … MXN» about a message written before that price existed, which is the provenance laundering #70 named `requestedFor` apart from `dueOn` to prevent, in the money field instead of the date one. Both review axes found this independently.",
        checks: [
          { path: "quantity", equals: 150 },
          { path: "amount", absent: true },
          { path: "currency", absentOrEquals: "MXN" },
          { path: "requestedFor", absent: true },
        ],
      },
      {
        messageId: "BD-02",
        factType: "OrderRequested",
        because:
          "«quiero 150 varillas y 40 bultos» — the bultos half, on the same ruling (#83). This is the one the split exists to record: the 40 bultos are quoted in BD-04 and never ordered, so without this label the day holds the quote for them and no trace that the customer ever wanted them, which is exactly the unmet demand ADR-0038 says «evaporates in WhatsApp threads». `amount` and the day's price: this ask PRECEDES every price the day states, so the figure is pinned ABSENT rather than carried forward. `absentOrEquals` is for a carried-forward value — corpus.ts's own words, «an order that FOLLOWS a quote may honestly carry that quote's price» — and the direction is the whole of it: a customer saying «va» to a figure already on the table is accepting it, while a customer who asks before anybody has priced anything has named no number at all. A crossing carrying the later figure would render «Te pidió … por … MXN» about a message written before that price existed, which is the provenance laundering #70 named `requestedFor` apart from `dueOn` to prevent, in the money field instead of the date one. Both review axes found this independently.",
        checks: [
          { path: "quantity", equals: 40 },
          { path: "amount", absent: true },
          { path: "currency", absentOrEquals: "MXN" },
          { path: "requestedFor", absent: true },
        ],
      },
      {
        messageId: "BD-03",
        factType: "QuoteGiven",
        because: "a stated total for a stated quantity",
        checks: [
          { path: "amount", equals: 30750 },
          { path: "quantity", equals: 150 },
          { path: "currency", absentOrEquals: "MXN" },
          { path: "requestedFor", absent: true },
        ],
      },
      {
        messageId: "BD-04",
        factType: "QuoteGiven",
        because: "a second quote for a second product",
        checks: [
          { path: "amount", equals: 8200 },
          { path: "quantity", equals: 40 },
          { path: "currency", absentOrEquals: "MXN" },
          { path: "requestedFor", absent: true },
        ],
      },
      {
        messageId: "BD-05",
        factType: "OrderRequested",
        because: "the customer orders the rebar only",
        checks: [
          { path: "quantity", equals: 150 },
          { path: "amount", absentOrEquals: 30750 },
          { path: "currency", absentOrEquals: "MXN" },
          { path: "requestedFor", absent: true },
        ],
      },
      {
        messageId: "BD-06",
        factType: "DatePromised",
        because: "an explicit calendar date",
        checks: [
          { path: "dueOn", equals: "2026-09-29" },
        ],
      },
      {
        messageId: "BD-06",
        factType: "OrderTaken",
        because:
          "the rep commits to deliver the 150 varillas. The 40 bultos were quoted and never ordered, so no agreement covers them",
        checks: [
          { path: "quantity", equals: 150 },
          { path: "amount", absentOrEquals: 30750 },
          { path: "currency", absentOrEquals: "MXN" },
          { path: "requestedFor", absent: true },
        ],
      },
    ],
    silent: [
      {
        messageId: "BD-01",
        because:
          "the CUSTOMER's own budget. Not a quote — nobody quoted it — and a crossing here files the customer's finances as this rep's price.",
      },
    ],
  },

  {
    id: "b-dia-completo-mixto",
    exercises: "the messiest day: a revision, a cancellation, tactics, and three real facts",
    counterparty: "Grupo Vallejo",
    messages: [
      { id: "BE-01", fromMe: true, atMinute: 480, text: "hoy le voy a ofrecer primero lo caro, siempre funciona con ellos" },
      { id: "BE-02", fromMe: false, atMinute: 510, text: "¿precio de 60 sacos?" },
      { id: "BE-03", fromMe: true, atMinute: 525, text: "los 60 en 13,200" },
      { id: "BE-04", fromMe: true, atMinute: 535, text: "corrijo, son 12,600 los 60. me pasé de listo" },
      { id: "BE-05", fromMe: false, atMinute: 560, text: "así sí, mándeme los 60" },
      { id: "BE-06", fromMe: true, atMinute: 570, text: "va, el 27 de septiembre los tiene" },
      { id: "BE-07", fromMe: false, atMinute: 800, text: "mejor cancele, se me atrasó la obra" },
      { id: "BE-08", fromMe: true, atMinute: 810, text: "sin problema, aquí estamos" },
    ],
    labels: [
      {
        messageId: "BE-04",
        factType: "QuoteGiven",
        because: "the corrected figure is the quote; the message says so outright",
        checks: [
          { path: "amount", equals: 12600 },
          { path: "quantity", equals: 60 },
          { path: "currency", absentOrEquals: "MXN" },
          { path: "requestedFor", absent: true },
        ],
      },
      {
        messageId: "BE-05",
        factType: "OrderRequested",
        because: "the customer orders; the later cancellation does not unmake it",
        checks: [
          { path: "quantity", equals: 60 },
          { path: "amount", absentOrEquals: 12600 },
          { path: "currency", absentOrEquals: "MXN" },
          { path: "requestedFor", absent: true },
        ],
      },
      {
        messageId: "BE-06",
        factType: "DatePromised",
        because: "an explicit calendar date",
        checks: [
          { path: "dueOn", equals: "2026-09-27" },
        ],
      },
      {
        messageId: "BE-06",
        factType: "OrderTaken",
        because:
          "«va» and a day, answering «así sí, mándeme los 60». The customer cancels afterwards, which files nothing and unfiles nothing",
        checks: [
          { path: "quantity", equals: 60 },
          { path: "amount", absentOrEquals: 12600 },
          { path: "currency", absentOrEquals: "MXN" },
          { path: "requestedFor", absent: true },
        ],
      },
    ],
    silent: [
      {
        messageId: "BE-01",
        because:
          "the rep's own selling tactic — FR-30's excluded phrase word for word, and rep-authored, so the `CustomerPattern` fence refuses it in code (#61)",
      },
      { messageId: "BE-02", because: "a request for a price" },
      {
        messageId: "BE-03",
        because: "SUPERSEDED by BE-04 in the same day and the same window",
      },
      { messageId: "BE-07", because: "a cancellation — not one of the six types" },
      { messageId: "BE-08", because: "an acknowledgement" },
    ],
  },

  {
    id: "b-dia-completo-lopez",
    exercises: "a second day with one customer — quotes, an order, a date and an RFC",
    counterparty: "Construcciones López",
    messages: [
      { id: "BF-01", fromMe: false, atMinute: 500, text: "buen día, ¿me cotiza 35 sacos de estuco?" },
      { id: "BF-02", fromMe: true, atMinute: 515, text: "los 35 sacos en 6,300" },
      { id: "BF-03", fromMe: false, atMinute: 530, text: "¿y 70?" },
      { id: "BF-04", fromMe: true, atMinute: 540, text: "los 70 en 12,250" },
      { id: "BF-05", fromMe: false, atMinute: 570, text: "va, los 70" },
      { id: "BF-06", fromMe: true, atMinute: 575, text: "listo, se los entrego el 2 de octubre" },
      { id: "BF-07", fromMe: false, atMinute: 590, text: "el RFC es clo910822-mn8" },
      { id: "BF-08", fromMe: true, atMinute: 595, text: "anotado" },
    ],
    labels: [
      {
        messageId: "BF-02",
        factType: "QuoteGiven",
        because: "a stated total for a stated quantity",
        checks: [
          { path: "amount", equals: 6300 },
          { path: "quantity", equals: 35 },
          { path: "currency", absentOrEquals: "MXN" },
          { path: "requestedFor", absent: true },
        ],
      },
      {
        messageId: "BF-04",
        factType: "QuoteGiven",
        because: "a second quote at a different quantity",
        checks: [
          { path: "amount", equals: 12250 },
          { path: "quantity", equals: 70 },
          { path: "currency", absentOrEquals: "MXN" },
          { path: "requestedFor", absent: true },
        ],
      },
      {
        messageId: "BF-05",
        factType: "OrderRequested",
        because: "the customer orders the 70",
        checks: [
          { path: "quantity", equals: 70 },
          { path: "amount", absentOrEquals: 12250 },
          { path: "currency", absentOrEquals: "MXN" },
          { path: "requestedFor", absent: true },
        ],
      },
      {
        messageId: "BF-06",
        factType: "DatePromised",
        because: "an explicit calendar date",
        checks: [
          { path: "dueOn", equals: "2026-10-02" },
        ],
      },
      {
        messageId: "BF-06",
        factType: "OrderTaken",
        because:
          "«listo» and a delivery date for the 70 the customer ordered",
        checks: [
          { path: "quantity", equals: 70 },
          { path: "amount", absentOrEquals: 12250 },
          { path: "currency", absentOrEquals: "MXN" },
          { path: "requestedFor", absent: true },
        ],
      },
      {
        messageId: "BF-07",
        factType: "ContactEstablished",
        because: "an RFC stated outright, normalized uppercase without the hyphen",
        checks: [
          { path: "identifiers.phones", equalsAll: [] },
          { path: "identifiers.emails", equalsAll: [] },
          { path: "identifiers.rfcs", equalsAll: ["CLO910822MN8"] },
        ],
      },
    ],
    silent: [
      { messageId: "BF-01", because: "a request for a quote" },
      { messageId: "BF-03", because: "the customer asks about a larger quantity" },
      { messageId: "BF-08", because: "an acknowledgement" },
    ],
  },

  {
    id: "b-dia-completo-serrano",
    exercises: "a day with several small orders and one date",
    counterparty: "Ferretería Serrano",
    messages: [
      { id: "BG-01", fromMe: false, atMinute: 490, text: "mándeme 15 cubetas de pintura blanca" },
      { id: "BG-02", fromMe: false, atMinute: 492, text: "y 8 brochas de 4 pulgadas" },
      { id: "BG-03", fromMe: true, atMinute: 505, text: "las 15 cubetas en 5,850" },
      { id: "BG-04", fromMe: true, atMinute: 507, text: "las brochas van de cortesía" },
      { id: "BG-05", fromMe: true, atMinute: 520, text: "todo el 5 de octubre" },
      { id: "BG-06", fromMe: false, atMinute: 530, text: "gracias, muy amable" },
    ],
    labels: [
      {
        messageId: "BG-01",
        factType: "OrderRequested",
        because: "an order stated outright with its quantity",
        checks: [
          { path: "quantity", equals: 15 },
          { path: "amount", absentOrEquals: 5850 },
          { path: "currency", absentOrEquals: "MXN" },
          { path: "requestedFor", absent: true },
        ],
      },
      {
        messageId: "BG-02",
        factType: "OrderRequested",
        because: "a second order in its own message",
        checks: [
          { path: "quantity", equals: 8 },
          { path: "amount", absent: true },
          { path: "currency", absentOrEquals: "MXN" },
          { path: "requestedFor", absent: true },
        ],
      },
      {
        messageId: "BG-04",
        factType: "OrderTaken",
        because:
          "«las brochas van de cortesía» agrees to supply the 8 brushes — no yes anywhere in it, and unmistakable to the customer. It was claimed silent before #71 because a QUOTE here would have to invent a price; an agreement invents nothing, and `amount` is pinned absent so a crossing that prices them still fails",
        checks: [
          { path: "quantity", equals: 8 },
          { path: "amount", absent: true },
          { path: "currency", absentOrEquals: "MXN" },
          { path: "requestedFor", absent: true },
        ],
      },
      {
        messageId: "BG-03",
        factType: "QuoteGiven",
        because: "a stated total for a stated quantity",
        checks: [
          { path: "amount", equals: 5850 },
          { path: "quantity", equals: 15 },
          { path: "currency", absentOrEquals: "MXN" },
          { path: "requestedFor", absent: true },
        ],
      },
      {
        messageId: "BG-05",
        factType: "DatePromised",
        because: "an explicit calendar date",
        checks: [
          { path: "dueOn", equals: "2026-10-05" },
        ],
      },
      {
        messageId: "BG-05",
        factType: "OrderTaken",
        because:
          "«todo el 5 de octubre» commits to delivering the 15 cubetas the customer ordered",
        checks: [
          { path: "quantity", equals: 15 },
          { path: "amount", absentOrEquals: 5850 },
          { path: "currency", absentOrEquals: "MXN" },
          { path: "requestedFor", absent: true },
        ],
      },
    ],
    silent: [
      { messageId: "BG-06", because: "thanks" },
    ],
  },

  {
    id: "b-dia-completo-quiroz",
    exercises: "a day where the rep quotes in dollars",
    counterparty: "Importaciones Quiroz",
    messages: [
      { id: "BH-01", fromMe: false, atMinute: 505, text: "¿el equipo importado en cuánto sale?" },
      { id: "BH-02", fromMe: true, atMinute: 530, text: "son 2,400 dólares puesto en frontera" },
      { id: "BH-03", fromMe: false, atMinute: 560, text: "adelante, mándelo" },
      { id: "BH-04", fromMe: true, atMinute: 570, text: "va, lo tengo el 8 de octubre" },
      { id: "BH-05", fromMe: false, atMinute: 580, text: "mi correo de aduanas es aduanas@quiroz.mx" },
    ],
    labels: [
      {
        messageId: "BH-02",
        factType: "QuoteGiven",
        because: "a stated figure in a stated currency that is not the default",
        checks: [
          { path: "amount", equals: 2400 },
          { path: "currency", equals: "USD" },
          { path: "quantity", absent: true },
          { path: "requestedFor", absent: true },
        ],
      },
      {
        messageId: "BH-03",
        factType: "OrderRequested",
        because:
          "the customer confirms the order. No quantity is stated, so one would be invented — and the day quotes 2,400 dollars, so an order carrying that price is reading the day.",
        checks: [
          { path: "quantity", absent: true },
          { path: "amount", absentOrEquals: 2400 },
          { path: "currency", absentOrEquals: "USD" },
          { path: "requestedFor", absent: true },
        ],
      },
      {
        messageId: "BH-04",
        factType: "DatePromised",
        because: "an explicit calendar date",
        checks: [
          { path: "dueOn", equals: "2026-10-08" },
        ],
      },
      {
        messageId: "BH-04",
        factType: "OrderTaken",
        because:
          "«va» plus a date, answering «adelante, mándelo». No quantity was stated, and the price is in dollars",
        checks: [
          { path: "quantity", absent: true },
          { path: "amount", absentOrEquals: 2400 },
          { path: "currency", absentOrEquals: "USD" },
          { path: "requestedFor", absent: true },
        ],
      },
      {
        messageId: "BH-05",
        factType: "ContactEstablished",
        because: "an email stated outright",
        checks: [
          { path: "identifiers.phones", equalsAll: [] },
          { path: "identifiers.emails", equalsAll: ["aduanas@quiroz.mx"] },
          { path: "identifiers.rfcs", equalsAll: [] },
        ],
      },
    ],
    silent: [{ messageId: "BH-01", because: "a request for a price" }],
  },

  {
    id: "b-dia-completo-tapia",
    exercises: "the longest day: five facts among nine messages of noise",
    counterparty: "Materiales Tapia",
    messages: [
      { id: "BI-01", fromMe: false, atMinute: 470, text: "buenos días don" },
      { id: "BI-02", fromMe: true, atMinute: 475, text: "buenos días, ¿cómo va la obra?" },
      { id: "BI-03", fromMe: false, atMinute: 480, text: "atrasada como siempre jaja" },
      { id: "BI-04", fromMe: false, atMinute: 500, text: "¿me cotiza 120 metros de malla?" },
      { id: "BI-05", fromMe: true, atMinute: 520, text: "los 120 metros en 9,600" },
      { id: "BI-06", fromMe: false, atMinute: 560, text: "va, los 120" },
      { id: "BI-07", fromMe: true, atMinute: 565, text: "perfecto, se los llevo el 12 de octubre" },
      { id: "BI-08", fromMe: false, atMinute: 600, text: "el tel de la obra es 81 4455 6677" },
      { id: "BI-09", fromMe: false, atMinute: 602, text: "y facture a obras@tapia.com.mx" },
      { id: "BI-10", fromMe: true, atMinute: 610, text: "listo, todo anotado. que le rinda el día" },
    ],
    labels: [
      {
        messageId: "BI-05",
        factType: "QuoteGiven",
        because: "a stated total for a stated quantity",
        checks: [
          { path: "amount", equals: 9600 },
          { path: "quantity", equals: 120 },
          { path: "currency", absentOrEquals: "MXN" },
          { path: "requestedFor", absent: true },
        ],
      },
      {
        messageId: "BI-06",
        factType: "OrderRequested",
        because: "the customer orders the 120",
        checks: [
          { path: "quantity", equals: 120 },
          { path: "amount", absentOrEquals: 9600 },
          { path: "currency", absentOrEquals: "MXN" },
          { path: "requestedFor", absent: true },
        ],
      },
      {
        messageId: "BI-07",
        factType: "DatePromised",
        because: "an explicit calendar date",
        checks: [
          { path: "dueOn", equals: "2026-10-12" },
        ],
      },
      {
        messageId: "BI-07",
        factType: "OrderTaken",
        because:
          "the rep commits to bring the 120 metres the customer ordered",
        checks: [
          { path: "quantity", equals: 120 },
          { path: "amount", absentOrEquals: 9600 },
          { path: "currency", absentOrEquals: "MXN" },
          { path: "requestedFor", absent: true },
        ],
      },
      {
        messageId: "BI-08",
        factType: "ContactEstablished",
        because:
          "a site phone that is not the chat's own address, normalized to E.164",
        checks: [
          { path: "identifiers.phones", equalsAll: ["+528144556677"] },
          { path: "identifiers.emails", equalsAll: [] },
          { path: "identifiers.rfcs", equalsAll: [] },
        ],
      },
      {
        messageId: "BI-09",
        factType: "ContactEstablished",
        because: "a billing email stated outright",
        checks: [
          { path: "identifiers.phones", equalsAll: [] },
          { path: "identifiers.emails", equalsAll: ["obras@tapia.com.mx"] },
          { path: "identifiers.rfcs", equalsAll: [] },
        ],
      },
    ],
    silent: [
      { messageId: "BI-01", because: "a greeting" },
      { messageId: "BI-02", because: "small talk" },
      { messageId: "BI-03", because: "small talk about the customer's own schedule" },
      { messageId: "BI-04", because: "a request for a quote" },
      { messageId: "BI-10", because: "an acknowledgement and a farewell" },
    ],
  },

  // ==========================================================================
  // `p-*` — `CustomerPattern` (ticket #61), the type whose false positives are
  // aperture BREACHES rather than noise.
  //
  // Seven days written for one purpose: to make the difference between a
  // customer telling you how THEY buy and everything that merely looks like it
  // cost something measurable. Most of what is here is negative space, and
  // every negative names the class it belongs to:
  //
  //  - A REGULARITY ABOUT THE REP, said by the CUSTOMER (`PC-01`, `PC-03`).
  //    The sharpest pair in the corpus, because the authorship fence cannot
  //    reach them: they are counterparty-authored, they are standing, and the
  //    only thing that puts them on the far side of the wall is that their
  //    SUBJECT is the rep. FR-30 excludes "rep tactics, judgments, or selling
  //    approach" by name, and a crossing here is the rep's employer reading a
  //    complaint — or a compliment — about the rep.
  //  - A REGULARITY ABOUT THE REP, said by the REP (`PF-01`, and the four
  //    messages that already carried this shape: `N2-01`, `N2-02`, `B3-01`,
  //    `BE-01`). Refused by the aperture now rather than only by the prompt,
  //    so filing one costs a REFUSAL rather than a crossing — which is why the
  //    corpus still needs the customer-authored pair above to measure
  //    anything.
  //  - A ONE-OFF (`PB-05`). «esta vez» is this time, and says the opposite of
  //    «siempre».
  //  - A MARKET- OR SEASON-LEVEL OBSERVATION (`PD-01`), which is ADR-0035's
  //    own example and has no entity to attach to. `PD-02` is the same season
  //    said about the customer themselves, and it crosses — the pair is the
  //    orphan rule made measurable rather than asserted.
  //  - A REPETITION THE MODEL WOULD HAVE TO INVENT
  //    (`p-dos-veces-no-es-costumbre`). Ticket #83 made `OrderRequested`
  //    denser: a customer who asks twice in a day files two requests, and a
  //    cadence built by counting them double-counts one want. That day states
  //    two orders and no pattern at all, and its whole claim is the label that
  //    is NOT there.
  //
  // The positives are the other half, and they are what stops the negatives
  // from being satisfiable by an extractor that simply never files this type.
  // `PE-01` is the one to read first: a CADENCE that crosses, because the
  // customer said it. What #61 declines to file is a cadence nobody said.
  // ==========================================================================

  {
    id: "p-preferencias-santoyo",
    exercises:
      "a customer stating how they buy, twice, in the middle of an ordinary order",
    counterparty: "Construcciones Santoyo",
    messages: [
      { id: "PA-01", fromMe: false, atMinute: 480, text: "buen día, ¿me cotiza 30 bultos de cal?" },
      { id: "PA-02", fromMe: true, atMinute: 495, text: "los 30 bultos en 3,150" },
      { id: "PA-03", fromMe: false, atMinute: 505, text: "va, mándemelos" },
      { id: "PA-04", fromMe: true, atMinute: 515, text: "sale, ahí se los mando" },
      { id: "PA-05", fromMe: false, atMinute: 525, text: "gracias. nada más acuérdese que aquí solo recibimos de lunes a viernes, el sábado no hay nadie en la obra" },
      { id: "PA-06", fromMe: false, atMinute: 530, text: "y siempre pedimos con factura, si no no nos la autorizan" },
      { id: "PA-07", fromMe: true, atMinute: 540, text: "anotado" },
    ],
    labels: [
      {
        messageId: "PA-02",
        factType: "QuoteGiven",
        because: "a price for a counted quantity, stated outright by the rep",
        checks: [
          { path: "quantity", equals: 30 },
          { path: "amount", equals: 3150 },
          { path: "currency", absentOrEquals: "MXN" },
          { path: "requestedFor", absent: true },
        ],
      },
      {
        messageId: "PA-03",
        factType: "OrderRequested",
        because:
          "«va, mándemelos» takes the price it was just given and asks to be supplied — an order that FOLLOWS a quote may honestly carry that quote's figure",
        checks: [
          { path: "quantity", equals: 30 },
          { path: "amount", absentOrEquals: 3150 },
          { path: "currency", absentOrEquals: "MXN" },
          { path: "requestedFor", absent: true },
        ],
      },
      {
        messageId: "PA-04",
        factType: "OrderTaken",
        because:
          "«sale» and a commitment to send, answering the ask in the same day",
        checks: [
          { path: "quantity", equals: 30 },
          { path: "amount", absentOrEquals: 3150 },
          { path: "currency", absentOrEquals: "MXN" },
          { path: "requestedFor", absent: true },
        ],
      },
      {
        messageId: "PA-05",
        factType: "CustomerPattern",
        because:
          "«gracias. nada más acuérdese que aquí solo recibimos de lunes a viernes, el sábado no hay nadie en la obra» — a STANDING CONSTRAINT the customer states about their own site, in their own message. FR-30 defines CustomerPattern as observable customer regularities — order cadence, stated preferences, constraints — and this is the third of those, said outright rather than inferred. The subject is the customer, which is what puts it on this side of the wall.",
        checks: [{ path: "pattern", contains: "lunes a viernes" }],
      },
      {
        messageId: "PA-06",
        factType: "CustomerPattern",
        because:
          "«y siempre pedimos con factura, si no no nos la autorizan» — a standing requirement of how this customer buys, stated in the customer's own words. FR-30's «stated preferences»; «siempre» is the customer's word, not a repetition anybody counted.",
        checks: [{ path: "pattern", contains: "factura" }],
      },
    ],
    silent: [
      { messageId: "PA-01", because: "a request for a price" },
      { messageId: "PA-07", because: "an acknowledgement" },
    ],
  },

  {
    id: "p-restricciones-borrego",
    exercises:
      "standing constraints stated plainly, and a one-off that must not be read as one",
    counterparty: "Ferretería El Borrego",
    messages: [
      { id: "PB-01", fromMe: false, atMinute: 500, text: "buenas tardes" },
      { id: "PB-02", fromMe: false, atMinute: 505, text: "nomás para que lo tenga: nosotros nunca compramos material de segunda, aunque salga más barato" },
      { id: "PB-03", fromMe: true, atMinute: 515, text: "claro, aquí todo es de primera" },
      { id: "PB-04", fromMe: false, atMinute: 520, text: "y pagamos a 15 días, así lo manejamos con todos los proveedores" },
      { id: "PB-05", fromMe: false, atMinute: 525, text: "esta vez sí va con prisa, ando contra el tiempo" },
      { id: "PB-06", fromMe: false, atMinute: 530, text: "ah, y todo lo pedimos en bultos de 50 kilos, los de 25 no nos sirven" },
      { id: "PB-07", fromMe: true, atMinute: 540, text: "entendido, sin problema" },
    ],
    labels: [
      {
        messageId: "PB-02",
        factType: "CustomerPattern",
        because:
          "«nomás para que lo tenga: nosotros nunca compramos material de segunda, aunque salga más barato» — the customer stating what they will not take, ever. FR-30's «stated preferences»: a preference the customer volunteers about their own buying, not a judgment about the rep and not something read off a repetition.",
        checks: [
          { path: "pattern", contains: "segunda" },
          { path: "pattern", lacks: "prisa" },
        ],
      },
      {
        messageId: "PB-04",
        factType: "CustomerPattern",
        because:
          "«y pagamos a 15 días, así lo manejamos con todos los proveedores» — how this customer pays, standing, in their own words. FR-30 names constraints as CustomerPattern's own material, and «así lo manejamos con todos» is the customer saying it is standing — which is what makes it recordable rather than a fact about one invoice.",
        checks: [
          { path: "pattern", contains: "15" },
          { path: "pattern", lacks: "prisa" },
        ],
      },
      {
        messageId: "PB-06",
        factType: "CustomerPattern",
        because:
          "«ah, y todo lo pedimos en bultos de 50 kilos, los de 25 no nos sirven» — a standing preference about the goods themselves, stated by the customer. FR-30's «stated preferences», and the number is in the customer's own sentence rather than a count anybody made.",
        checks: [
          { path: "pattern", contains: "50" },
          { path: "pattern", lacks: "prisa" },
        ],
      },
    ],
    silent: [
      { messageId: "PB-01", because: "a greeting" },
      {
        messageId: "PB-03",
        because: "the rep agreeing with a compliment; nothing is stated",
      },
      {
        messageId: "PB-05",
        because:
          "«esta vez sí va con prisa, ando contra el tiempo» — A ONE-OFF, and the commonest way to file a pattern nobody stated. «esta vez» says the opposite of «siempre»: it is this job, not how this customer buys. FR-30's CustomerPattern is an observable REGULARITY, so a single urgent order is not one, and a rep's employer reading «Te dijo que siempre anda con prisa» would be reading a character sketch the customer never gave.",
      },
      { messageId: "PB-07", because: "an acknowledgement" },
    ],
  },

  {
    id: "p-juicios-sobre-el-rep",
    exercises:
      "the aperture breach the authorship fence cannot reach — a CUSTOMER stating a regularity about the REP",
    counterparty: "Aceros Peralta",
    messages: [
      { id: "PC-01", fromMe: false, atMinute: 480, text: "usted siempre se tarda en entregar, ya van tres veces que me falla" },
      { id: "PC-02", fromMe: true, atMinute: 490, text: "una disculpa, esta semana andamos con retraso en almacén" },
      { id: "PC-03", fromMe: false, atMinute: 500, text: "pero eso sí, me gusta cómo le hace con los precios, siempre me da chance de negociar" },
      { id: "PC-04", fromMe: false, atMinute: 510, text: "bueno, nosotros de todos modos solo trabajamos con proveedores que nos den crédito a 30 días" },
      { id: "PC-05", fromMe: true, atMinute: 520, text: "eso sí lo manejamos" },
    ],
    labels: [
      {
        messageId: "PC-04",
        factType: "CustomerPattern",
        because:
          "«bueno, nosotros de todos modos solo trabajamos con proveedores que nos den crédito a 30 días» — a standing condition of how this customer buys, on the same day as two regularities that must NOT cross. FR-30 admits stated preferences and constraints about the CUSTOMER; the subject here is «nosotros», which is precisely what PC-01 and PC-03 are not. The day's point is that the line runs through the middle of it rather than around it — so the claim is pinned on BOTH sides: it must carry the customer's credit terms, and it must not have picked up either of the day's own judgments about the rep on the way (Codex r1: «contains» alone scores «siempre pide crédito a 30 días, y el rep siempre se tarda» as correct).",
        checks: [
          { path: "pattern", contains: "30" },
          { path: "pattern", lacks: "tarda" },
          { path: "pattern", lacks: "negociar" },
        ],
      },
    ],
    silent: [
      {
        messageId: "PC-01",
        because:
          "«usted siempre se tarda en entregar, ya van tres veces que me falla» — THE APERTURE BREACH THE AUTHORSHIP FENCE CANNOT CATCH. It is counterparty-authored, so ADR-0038's fence passes it; it is standing («siempre», «ya van tres veces»), so it reads exactly like a pattern. What puts it on the far side of the wall is its SUBJECT: FR-30 excludes «rep tactics, judgments, or selling approach» by name, and this is a judgment about the rep's own performance. A crossing here files «Te dijo que siempre te tardas en entregar» into the Ledger the rep's EMPLOYER reads. It is the most expensive false positive this corpus can produce, and only the extractor stands in front of it.",
      },
      {
        messageId: "PC-02",
        because:
          "the rep apologising and explaining their own warehouse — rep-authored, so the aperture refuses a CustomerPattern here whatever the words say, and there is nothing else in it",
      },
      {
        messageId: "PC-03",
        because:
          "«pero eso sí, me gusta cómo le hace con los precios, siempre me da chance de negociar» — the same breach with the sign reversed: a judgment about HOW THE REP SELLS, which is FR-30's «selling approach» word for word, and praise crosses the wall exactly as damagingly as a complaint. It also tells the owner that this rep discounts, which is a thing about the rep and not a thing about the customer. Counterparty-authored and standing, so only the extractor keeps it out.",
      },
      {
        messageId: "PC-05",
        because: "the rep confirming they offer credit; no figure and no commitment",
      },
    ],
  },

  {
    id: "p-mercado-y-temporada",
    exercises:
      "a regularity about the trade has no cliente to attach to; the same season said about the customer does",
    counterparty: "Constructora Vega",
    messages: [
      { id: "PD-01", fromMe: false, atMinute: 470, text: "en diciembre se pone flojo todo esto de la construcción, cada año igual" },
      { id: "PD-02", fromMe: false, atMinute: 475, text: "por eso nosotros en diciembre no pedimos nada, cerramos del 15 al 6" },
      { id: "PD-03", fromMe: true, atMinute: 490, text: "igual acá, en diciembre casi no se mueve" },
      { id: "PD-04", fromMe: false, atMinute: 500, text: "ah y otra cosa, siempre pedimos por lo menos 50 bultos, por el flete" },
      { id: "PD-05", fromMe: true, atMinute: 510, text: "perfecto" },
    ],
    labels: [
      {
        messageId: "PD-02",
        factType: "CustomerPattern",
        because:
          "«por eso nosotros en diciembre no pedimos nada, cerramos del 15 al 6» — the SAME SEASON as PD-01 and a fact all the same, because the subject changed: «nosotros». FR-30's stated preferences are about the customer, and this customer has told the rep when they stop buying. The pair is the whole day: one sentence about the trade files nothing, the next one about themselves files a fact — and the claim is pinned on both sides, because a clause that carried PD-01's «la construcción» along with it would have filed the trade-level observation after all, on a row scored correct.",
        checks: [
          { path: "pattern", contains: "diciembre" },
          { path: "pattern", lacks: "construcción" },
        ],
      },
      {
        messageId: "PD-04",
        factType: "CustomerPattern",
        because:
          "«ah y otra cosa, siempre pedimos por lo menos 50 bultos, por el flete» — a standing minimum this customer buys to, in their own words and with their own reason. FR-30's «stated preferences». Pinned on both sides like PD-02, because this day states a trade-level observation the clause must not have picked up.",
        checks: [
          { path: "pattern", contains: "50" },
          { path: "pattern", lacks: "construcción" },
        ],
      },
    ],
    silent: [
      {
        messageId: "PD-01",
        because:
          "«en diciembre se pone flojo todo esto de la construcción, cada año igual» — ADR-0035'S OWN EXAMPLE, in the customer's mouth. It is a regularity and it is stated, but it is about THE TRADE: it has no entity, and FR-32's orphan rule is absolute — «every fact attaches to exactly one entity, and there is no non-entity slot». Filing it against Constructora Vega would claim this customer said something about their own buying when they said something about December; there is nowhere else to put it, and a slot for entity-less observations is the drain ADR-0035 refuses to dig. Nothing crosses. FR-30's regularities are the CUSTOMER's, and this one belongs to nobody in the conversation.",
      },
      {
        messageId: "PD-03",
        because:
          "the rep's own reading of the season — rep-authored, about nobody in particular, and a fact for no cliente",
      },
      { messageId: "PD-05", because: "an acknowledgement" },
    ],
  },

  {
    id: "p-como-compra-arriaga",
    exercises:
      "a cadence the customer STATES, beside an ordinary quote and order",
    counterparty: "Distribuidora Arriaga",
    messages: [
      { id: "PE-01", fromMe: false, atMinute: 490, text: "mire, para que no batallemos: yo siempre pido a principio de mes, cuando me entra el presupuesto" },
      { id: "PE-02", fromMe: true, atMinute: 500, text: "me queda claro" },
      { id: "PE-03", fromMe: false, atMinute: 505, text: "y no me sirve el cemento gris, nosotros nada más usamos blanco" },
      { id: "PE-04", fromMe: false, atMinute: 510, text: "¿me cotiza 40 bultos del blanco?" },
      { id: "PE-05", fromMe: true, atMinute: 520, text: "los 40 en 6,800" },
      { id: "PE-06", fromMe: false, atMinute: 530, text: "ok, apárteme esos" },
      { id: "PE-07", fromMe: true, atMinute: 540, text: "listo, se los aparto" },
    ],
    labels: [
      {
        messageId: "PE-01",
        factType: "CustomerPattern",
        because:
          "«mire, para que no batallemos: yo siempre pido a principio de mes, cuando me entra el presupuesto» — A CADENCE, and it crosses because the CUSTOMER STATED IT. FR-30 lists order cadence first among CustomerPattern's material; what ticket #61 declines to file is a cadence nobody said, worked out by counting orders. This one is in the message's own words, so it rests on the same evidence every other fact type rests on: one message.",
        checks: [{ path: "pattern", contains: "mes" }],
      },
      {
        messageId: "PE-03",
        factType: "CustomerPattern",
        because:
          "«y no me sirve el cemento gris, nosotros nada más usamos blanco» — a standing preference about the goods, stated by the customer. FR-30's «stated preferences», and the kind worth the most to a rep who has to remember it.",
        checks: [{ path: "pattern", contains: "blanco" }],
      },
      {
        messageId: "PE-05",
        factType: "QuoteGiven",
        because: "a price for a counted quantity, stated outright by the rep",
        checks: [
          { path: "quantity", equals: 40 },
          { path: "amount", equals: 6800 },
          { path: "currency", absentOrEquals: "MXN" },
          { path: "requestedFor", absent: true },
        ],
      },
      {
        messageId: "PE-06",
        factType: "OrderRequested",
        because:
          "«ok, apárteme esos» takes the price it was just given and asks to be supplied",
        checks: [
          { path: "quantity", equals: 40 },
          { path: "amount", absentOrEquals: 6800 },
          { path: "currency", absentOrEquals: "MXN" },
          { path: "requestedFor", absent: true },
        ],
      },
      {
        messageId: "PE-07",
        factType: "OrderTaken",
        because: "«listo» and a commitment to hold them, answering the ask",
        checks: [
          { path: "quantity", equals: 40 },
          { path: "amount", absentOrEquals: 6800 },
          { path: "currency", absentOrEquals: "MXN" },
          { path: "requestedFor", absent: true },
        ],
      },
    ],
    silent: [
      { messageId: "PE-02", because: "an acknowledgement" },
      { messageId: "PE-04", because: "a request for a price" },
    ],
  },

  {
    id: "p-condiciones-medina",
    exercises:
      "a rep's own judgment about the customer beside two conditions the customer states",
    counterparty: "Grupo Medina",
    messages: [
      { id: "PF-01", fromMe: true, atMinute: 470, text: "este cliente siempre regatea, hay que dejarle margen" },
      { id: "PF-02", fromMe: false, atMinute: 480, text: "buenas, ¿me aparta 200 blocks?" },
      { id: "PF-03", fromMe: true, atMinute: 490, text: "va, se los aparto" },
      { id: "PF-04", fromMe: false, atMinute: 500, text: "gracias. y siempre entréguenos por la mañana, en la tarde ya cerramos el acceso" },
      { id: "PF-05", fromMe: false, atMinute: 505, text: "y que venga con remisión, sin remisión no lo recibimos" },
      { id: "PF-06", fromMe: true, atMinute: 515, text: "anotado, así se hace" },
    ],
    labels: [
      {
        messageId: "PF-02",
        factType: "OrderRequested",
        because:
          "«¿me aparta 200 blocks?» asks to be SUPPLIED rather than to be told a price — nobody has quoted anything, so the ask carries no figure",
        checks: [
          { path: "quantity", equals: 200 },
          { path: "amount", absent: true },
          { path: "currency", absentOrEquals: "MXN" },
          { path: "requestedFor", absent: true },
        ],
      },
      {
        messageId: "PF-03",
        factType: "OrderTaken",
        because: "«va» and a commitment to hold them, answering the ask",
        checks: [
          { path: "quantity", equals: 200 },
          { path: "amount", absent: true },
          { path: "currency", absentOrEquals: "MXN" },
          { path: "requestedFor", absent: true },
        ],
      },
      {
        messageId: "PF-04",
        factType: "CustomerPattern",
        because:
          "«gracias. y siempre entréguenos por la mañana, en la tarde ya cerramos el acceso» — a standing constraint on when this customer can receive, stated by them, with the reason. FR-30's constraints; the day's first message is the same shape said by the REP and files nothing, which is the contrast this day exists for — so the claim is pinned on both sides, off PF-01's own words. Codex r3 found these two labels unpinned while the docblock claimed every such day pinned both: no paraphrase was needed, «solo recibe por la mañana; este cliente siempre regatea» carried the tactic and scored correct.",
        checks: [
          { path: "pattern", contains: "mañana" },
          { path: "pattern", lacks: "regatea" },
          { path: "pattern", lacks: "margen" },
        ],
      },
      {
        messageId: "PF-05",
        factType: "CustomerPattern",
        because:
          "«y que venga con remisión, sin remisión no lo recibimos» — a standing condition of delivery, stated outright. FR-30's constraints, and «no lo recibimos» is the customer describing their own behaviour rather than the rep's. Pinned on both sides off PF-01, like PF-04.",
        checks: [
          { path: "pattern", contains: "remisión" },
          { path: "pattern", lacks: "regatea" },
          { path: "pattern", lacks: "margen" },
        ],
      },
    ],
    silent: [
      {
        messageId: "PF-01",
        because:
          "«este cliente siempre regatea, hay que dejarle margen» — a REP TACTIC, FR-30's excluded phrase word for word, typed into a customer chat where ADR-0033's enumeration does not reach it. Since ticket #61 the aperture refuses it structurally as well: a CustomerPattern claims the CUSTOMER spoke, so a rep-authored message cannot carry one whatever the model says. It stays in the corpus because a refusal that is never exercised proves nothing.",
      },
      { messageId: "PF-06", because: "an acknowledgement" },
    ],
  },

  {
    id: "p-dos-veces-no-es-costumbre",
    exercises:
      "asking twice in one day is two orders and no pattern — the repetition a cadence claim would have to invent (#83)",
    counterparty: "Materiales Zúñiga",
    messages: [
      { id: "PG-01", fromMe: false, atMinute: 480, text: "mándeme 60 sacos de mortero" },
      { id: "PG-02", fromMe: true, atMinute: 490, text: "va, ahí se los mando" },
      { id: "PG-03", fromMe: false, atMinute: 520, text: "ah, y mándeme también 20 de cemento" },
      { id: "PG-04", fromMe: true, atMinute: 530, text: "sale, se los sumo" },
    ],
    labels: [
      {
        messageId: "PG-01",
        factType: "OrderRequested",
        because:
          "«mándeme 60 sacos de mortero» asks to be supplied; nobody has priced anything, so the ask carries no figure",
        checks: [
          { path: "quantity", equals: 60 },
          { path: "amount", absent: true },
          { path: "currency", absentOrEquals: "MXN" },
          { path: "requestedFor", absent: true },
        ],
      },
      {
        messageId: "PG-02",
        factType: "OrderTaken",
        because: "«va» and a commitment to send, answering the ask",
        checks: [
          { path: "quantity", equals: 60 },
          { path: "amount", absent: true },
          { path: "currency", absentOrEquals: "MXN" },
          { path: "requestedFor", absent: true },
        ],
      },
      {
        messageId: "PG-03",
        factType: "OrderRequested",
        because:
          "a SECOND ask in the same day, for different goods — ticket #83's own shape, and two wants rather than one want repeated",
        checks: [
          { path: "quantity", equals: 20 },
          { path: "amount", absent: true },
          { path: "currency", absentOrEquals: "MXN" },
          { path: "requestedFor", absent: true },
        ],
      },
      {
        messageId: "PG-04",
        factType: "OrderTaken",
        because: "«sale» and a commitment to add them, answering the second ask",
        checks: [
          { path: "quantity", equals: 20 },
          { path: "amount", absent: true },
          { path: "currency", absentOrEquals: "MXN" },
          { path: "requestedFor", absent: true },
        ],
      },
    ],
    silent: [],
  },

  /**
   * THE THREE LIVE WRONG DATES, AS CORPUS DAYS (ticket #121).
   *
   * Each of the three days below reproduces one rig session in which the
   * extractor resolved a relative weekday and got it wrong on a real
   * phone. They are here because a defect that has happened three times
   * and is measured nowhere is a defect the next run cannot see:
   *
   *   #57 — «para el lunes» filed as a Tuesday. The rep could not even
   *         see the day: the disclosure line carried no date at all.
   *   #69 — «para el lunes» filed as Sunday 30 August. Visible after #65,
   *         uncorrected because the correction window had passed.
   *   #102 — said on Tuesday 1 September: «Y mandártelos el lunes» filed
   *         as martes 8 de septiembre, «Y unos 30 para el martes» as
   *         jueves 3 de septiembre. Both wrong, both legible to the rep.
   *
   * WHAT IS REAL AND WHAT IS PLACED, said rather than assumed, because
   * "the real messages" is one of the ticket's own criteria and only one
   * of these three meets it whole. Each `exercises` line carries its own
   * grade so nothing here claims more than the record supports:
   *
   *   `d-lunes-y-martes` — REAL. All three messages are quoted verbatim
   *       in the #102 session log.
   *   `d-pedido-para-el-lunes` — PARTLY SYNTHETIC. The rep's «va, te los
   *       mando el lunes» is verbatim off #69; the customer's ask is
   *       reconstructed from the Ledger line it produced («Te pidió 50
   *       bultos de cemento para el domingo 30 de agosto de 2026») plus
   *       Diego's own «para el lunes», so the goods, the count and the
   *       relative day are the session's and the phrasing is not.
   *   `d-lunes-en-martes` — SYNTHETIC. #57's record preserves the relative
   *       day and the wrong `DatePromised: 2026-09-01` and not the
   *       sentence around it.
   *
   * A reconstructed sentence can move the model on its own, so those two
   * grade what the day MEASURES rather than what it reproduces. Whether
   * that is enough for the ticket's criterion is the owner's call, put to
   * him on #121 rather than assumed here.
   *
   * THE DAY THEY ARE SAID ON IS THE CORPUS'S OWN, and it has to be: the
   * eval lane drives ONE `runDailyExtraction` on ONE rep day (`clock.ts`),
   * so a transcript cannot carry a calendar of its own. That day is
   * Tuesday 1 September 2026 in America/Monterrey — which is #102's rep
   * day exactly, and is why its expected values are the session's own.
   * #57's session ran on a Saturday and #69's on a Sunday, so placing them
   * here moves the answer («el lunes» is the 7th rather than the 31st)
   * while keeping the shape that broke: a bare weekday, resolved against a
   * day the model was not being told. `corpus.test.ts` binds every date
   * below to that day by asserting the very sentence the pass renders — so
   * moving the eval clock, its zone, or the rendering fails the unit lane
   * rather than silently changing what «el lunes is the 7th» means.
   *
   * GIVING EACH DAY ITS OWN CALENDAR would be the faithful version and is
   * not built: the lane's single fixed clock is what #56 AC 4 rests its
   * "the run is reproducible" on, and per-transcript days mean several
   * passes, several `DAY_START_UTC`s and a `LAST_READABLE_MINUTE` per
   * transcript. Recorded on #121 rather than done here.
   *
   * WHAT THE FIRST MEASUREMENT SAID, recorded here because a corpus that
   * quietly holds a failing case teaches nobody anything. With the day
   * line in front of it, `claude-haiku-4-5` resolves the REP's promise
   * reliably — «el lunes» on R1-03 and R3-02 came back as the 7th in every
   * probe run, so #102's own wrong date is right — while the CUSTOMER's
   * «para el X» still misses: R3-03's «el martes», said on a Tuesday, came
   * back as 2 September every time. A third residual sits on R2-02, and it
   * is not a date-resolution failure at all: the OrderTaken there takes
   * the day off the rep's own «te los mando el lunes» and files it as
   * `requestedFor`, which is the LAUNDERING #70 named the two fields apart
   * to prevent and which four older days in this corpus already fail on.
   * The day line gave that pre-existing defect a resolved date to launder;
   * it did not create it.
   *
   * So `dueOn` is fixed and `requestedFor` is not, and these three days
   * are what will say so the next time somebody tries. The numbers and the
   * argument are on #121.
   */
  {
    id: "d-lunes-en-martes",
    exercises:
      "#57's SHAPE, reconstructed (its wording is not in the record) — the rep agrees and promises «para el lunes» in one breath; said on a Tuesday, the lunes is the 7th",
    counterparty: "Materiales Sada",
    messages: [
      { id: "R1-01", fromMe: false, atMinute: 610, text: "te pido 30 bultos de cemento" },
      { id: "R1-02", fromMe: true, atMinute: 618, text: "va" },
      { id: "R1-03", fromMe: true, atMinute: 620, text: "te los mando para el lunes" },
      { id: "R1-04", fromMe: false, atMinute: 625, text: "sale" },
    ],
    labels: [
      {
        messageId: "R1-01",
        factType: "OrderRequested",
        because:
          "«te pido 30 bultos de cemento» asks to be supplied; nobody has priced anything and no day is named in this message",
        checks: [
          { path: "quantity", equals: 30 },
          { path: "amount", absent: true },
          { path: "currency", absentOrEquals: "MXN" },
          { path: "requestedFor", absent: true },
        ],
      },
      {
        messageId: "R1-02",
        factType: "OrderTaken",
        because:
          "«va» answering the ask — ADR-0038's agreement, in the rep's own words. `requestedFor` is ABSENT because this message names no day at all, and the day in the next one is the REP promising, which `facts.ts` says this field never carries.",
        checks: [
          { path: "quantity", equals: 30 },
          { path: "amount", absent: true },
          { path: "currency", absentOrEquals: "MXN" },
          { path: "requestedFor", absent: true },
        ],
      },
      {
        messageId: "R1-03",
        factType: "DatePromised",
        because:
          "«te los mando para el lunes» is the rep committing to a day. Said on Tuesday 1 September, «el lunes» is the NEXT Monday — 7 September. #57 filed 2026-09-01, a Tuesday, and this is the label that says so.",
        checks: [{ path: "dueOn", equals: "2026-09-07" }],
      },
    ],
    silent: [
      { messageId: "R1-04", because: "an acknowledgement" },
    ],
  },

  {
    id: "d-pedido-para-el-lunes",
    exercises:
      "#69, PARTLY SYNTHETIC — the rep's «va, te los mando el lunes» is verbatim, the customer's ask is reconstructed from the Ledger line it produced; the customer names the day inside the ask and the rep promises the same day back",
    counterparty: "Ferretería Cavazos",
    messages: [
      { id: "R2-01", fromMe: false, atMinute: 630, text: "te pido 50 bultos de cemento para el lunes" },
      { id: "R2-02", fromMe: true, atMinute: 640, text: "va, te los mando el lunes" },
    ],
    labels: [
      {
        messageId: "R2-01",
        factType: "OrderRequested",
        because:
          "«te pido 50 bultos de cemento para el lunes» — the ask and the day the customer wants them, in one message, which is what `requestedFor` is for (#70). Said on Tuesday 1 September, that lunes is the 7th; #69 filed «domingo 30 de agosto de 2026» and the rep read it in the line without being able to correct it in time.",
        checks: [
          { path: "quantity", equals: 50 },
          { path: "amount", absent: true },
          { path: "currency", absentOrEquals: "MXN" },
          { path: "requestedFor", equals: "2026-09-07" },
        ],
      },
      {
        messageId: "R2-02",
        factType: "OrderTaken",
        because:
          "«va» plus a commitment to send, answering the ask in the rep's own message. `requestedFor` ABSENT: the day here is the rep's PROMISE, and pinning it on the order is the laundering #70 named the two fields apart to prevent — it is filed as the DatePromised of this same message instead.",
        checks: [
          { path: "quantity", equals: 50 },
          { path: "amount", absent: true },
          { path: "currency", absentOrEquals: "MXN" },
          { path: "requestedFor", absent: true },
        ],
      },
      {
        messageId: "R2-02",
        factType: "DatePromised",
        because:
          "«te los mando el lunes» is the rep committing to a delivery day — the same lunes the customer asked for, 7 September, and a second and separate fact from the order it agrees to (`facts.ts`: «that is a second, separate DatePromised»).",
        checks: [{ path: "dueOn", equals: "2026-09-07" }],
      },
    ],
    silent: [],
  },

  {
    id: "d-lunes-y-martes",
    exercises:
      "#102's reproduction, verbatim — two relative weekdays in one day, both filed wrong on a real phone",
    counterparty: "Constructora Elizondo",
    messages: [
      { id: "R3-01", fromMe: false, atMinute: 650, text: "Te pido 20 bultos" },
      { id: "R3-02", fromMe: true, atMinute: 655, text: "Si, te parece a 300 cada uno? Y mandártelos el lunes" },
      { id: "R3-03", fromMe: false, atMinute: 662, text: "Y unos 30 para el martes" },
    ],
    labels: [
      {
        messageId: "R3-01",
        factType: "OrderRequested",
        because:
          "«Te pido 20 bultos» asks to be supplied, with a quantity and no price and no day",
        checks: [
          { path: "quantity", equals: 20 },
          { path: "amount", absent: true },
          { path: "currency", absentOrEquals: "MXN" },
          { path: "requestedFor", absent: true },
        ],
      },
      {
        messageId: "R3-02",
        factType: "QuoteGiven",
        because:
          "«a 300 cada uno» is a price PER UNIT, so `quantity` is absent — «cada uno» counts nothing, and the 20 belong to the previous message, which #70's one-fact-one-message contract forbids carrying across. `requestedFor` is absent for the same reason it is on R2-02: «Y mandártelos el lunes» is the rep promising, not the customer asking.",
        checks: [
          { path: "quantity", absent: true },
          { path: "amount", equals: 300 },
          { path: "currency", absentOrEquals: "MXN" },
          { path: "requestedFor", absent: true },
        ],
      },
      {
        messageId: "R3-02",
        factType: "OrderTaken",
        because:
          "«Si … Y mandártelos el lunes» — the rep says yes and commits to sending, which is ADR-0038's agreement in the rep's own words and the same shape as PG-02's «va, ahí se los mando». The #102 session filed exactly this OrderTaken on exactly this message and the session record calls it right («the model chose the stronger evidence, correctly»), so leaving it unlabelled made a CORRECT crossing cost precision — the fail-open direction inverted, and an invitation to tune the right behaviour away (Codex r2). `quantity` is the 20 being agreed to, the way every OrderTaken in this corpus takes the count off the request it answers; `requestedFor` is ABSENT because the day here is the rep's promise, filed as this message's DatePromised instead.",
        checks: [
          { path: "quantity", equals: 20 },
          { path: "amount", absentOrEquals: 300 },
          { path: "currency", absentOrEquals: "MXN" },
          { path: "requestedFor", absent: true },
        ],
      },
      {
        messageId: "R3-02",
        factType: "DatePromised",
        because:
          "«Y mandártelos el lunes» is the rep committing to a delivery day. Said on Tuesday 1 September — this session's real rep day — the lunes is 7 September. The session filed «martes 8 de septiembre», which the disclosure line rendered with its weekday, so the rep could see it was wrong (#65) without the record being right (#121).",
        checks: [{ path: "dueOn", equals: "2026-09-07" }],
      },
      {
        messageId: "R3-03",
        factType: "OrderRequested",
        because:
          "«Y unos 30 para el martes» — a second ask, with the day the customer wants them. Said on a Tuesday, «el martes» is the NEXT Tuesday, 8 September: a weekday word said on its own weekday means the one coming, never today, which is the reading Diego applied to this very message. The session filed «jueves 3 de septiembre».",
        checks: [
          { path: "quantity", equals: 30 },
          { path: "amount", absent: true },
          { path: "currency", absentOrEquals: "MXN" },
          { path: "requestedFor", equals: "2026-09-08" },
        ],
      },
    ],
    silent: [],
  },

  /**
   * TWO DAYS THE CONVENTION WAS NOT WRITTEN FROM (ticket #139).
   *
   * #139 briefly put one paragraph in the system prompt: a weekday named
   * with nothing to qualify it is the next such day AFTER the day the
   * message was said on, never that same day. A sentence tuned until the
   * three days above go green measures nothing, so these two were authored
   * BEFORE it was written, from the rule as Diego stated it, and are not
   * edited afterwards.
   *
   * THAT PARAGRAPH IS GONE (Diego, 2026-09-02, on #139's remainder 1): it
   * did not fix the case it was written for and it broke cases that
   * already worked, so the prompt is byte-identical to what it was before
   * the ticket. These two days outlive it, and that is the point of them —
   * they measure the CONVENTION however the next attempt tries to teach
   * it, and they measure the BEAT STAMPS, which is what #139 actually
   * shipped and which no wording touches. They have now graded three
   * renderings and one prompt wording; the table below is what they said.
   *
   * HOW INDEPENDENT THEY ACTUALLY ARE, stated exactly, because "held out"
   * unqualified would be a stronger claim than the record supports (Codex
   * r1). They are held out from AUTHORING: neither their messages nor
   * their labels were written from a failing run, and neither has been
   * touched since. They are NOT blind to the paragraph that was tried and
   * withdrawn: two candidate wordings were measured, and although the
   * comparison that CHOSE between them ran on the three days above only,
   * the first wording's numbers on these two were already visible when the
   * second was written. Against the SHIPPED tree that exposure is spent —
   * no prompt wording is in it — so what they now grade is the rendering,
   * blind.
   *
   * THEY ARE SAID ON A SUNDAY, which is the other thing the three days
   * above cannot do. The lane drives one pass on one rep day, so until
   * #139 every transcript was said on the corpus's Tuesday and «el martes
   * said on a Tuesday» was the only own-weekday case that could exist. A
   * chat may OWE its extraction from an earlier day, though — a run that
   * died mid-call leaves the window unread and `owedFrom` carries it — and
   * that is a real shape of the pass, not a second calendar. Both days
   * declare `owedFromDaysAgo: 2`, so the window the pass reads opens on
   * SUNDAY 30 AUGUST 2026 and runs to Tuesday evening, and every beat is
   * stamped with the rep day it was actually said on.
   *
   * WHAT EACH ONE ISOLATES:
   *
   *   `d-domingo-en-domingo` — THE CONVENTION, on a weekday that is not
   *       Tuesday. «para el domingo», said on a Sunday, is the NEXT Sunday
   *       — 6 September — and never that same afternoon. Nothing about the
   *       answer depends on the beat's date: 6 September is also the next
   *       Sunday after the pass's own Tuesday, so a model reading only the
   *       day line lands here too. That is deliberate. This day grades the
   *       RULE and nothing else.
   *
   *   `d-lunes-desde-el-domingo` — THE BEAT'S OWN DAY, which is the half
   *       the rule cannot supply. «el lunes», said on Sunday the 30th, is
   *       MONDAY THE 31ST: the very next day. Read against the day line
   *       alone it would be 7 September, a week out — so this is the one
   *       case in the corpus that separates "the next weekday after the
   *       message" from "the next weekday after today", and it can only be
   *       answered by a transcript that says which day each line was said
   *       on. #121's remainder 1 named this shape exactly: «a Sunday «para
   *       el lunes» can be read by MONDAY's pass, under a line saying today
   *       is Monday, and resolved to the Monday a week out instead of the
   *       next day.»
   *       Its two messages are at 20:25 and 20:32 on the rep's clock, which
   *       in UTC is 02:25 and 02:32 the NEXT day — so the old raw-UTC stamp
   *       said Monday over a line said on Sunday, and «el lunes» read as
   *       today's own weekday when it was tomorrow's. One transcript,
   *       both halves of the defect.
   *
   * BOTH ARE SYNTHETIC and say so: no rig session produced them. They are
   * written in the register of the days around them and grade a rule, not
   * a reproduction.
   *
   * WHAT THE MEASUREMENT SAID, recorded here for the same reason the three
   * days above record theirs — a corpus that quietly holds a result
   * teaches nobody anything, and prose in the tree beside the labels is
   * the only place a future tuner will actually meet it (Codex r3).
   *
   * THE INSTRUMENT, so the numbers can be remade: `claude-haiku-4-5`, the
   * `d-*` days only, one variable at a time. Three shipped arms, all on
   * this corpus — the pre-#139 renderer (a raw UTC instant per beat, one
   * Spanish day line), Spanish per-beat stamps, and the English bracketed
   * metadata that ships — plus a fourth, withdrawn, that added an
   * own-weekday paragraph to the prompt. A tally is "right / times the
   * fact crossed at all", so a run where the fact did not cross is not
   * counted as wrong.
   *
   * THE BEAT STAMPS FIX THE CROSS-DAY CASE OUTRIGHT, in either language:
   *
   *   H2-01 «el lunes» said on the Sunday and read on the Tuesday —
   *       0 of 7 pre-#139, which answered 7 September, the day line's
   *       Tuesday reasoned from. 8 of 8 with Spanish stamps, 7 of 7 with
   *       the English metadata. It is what #139 ships and the clearest
   *       result in the ticket.
   *
   * AND THEY BREAK THE SAME-DAY CASE, WHICH LANGUAGE DID NOT FIX. The
   * three «el lunes» said ON the corpus Tuesday — R1-03, R2-01 and R3-02,
   * all wanting 7 September:
   *
   *       19 of 21  pre-#139 renderer
   *        5 of 24  Spanish per-beat stamps
   *        4 of 21  English bracketed metadata
   *
   * The first reading was that the model echoed the Spanish weekday the
   * framing put in front of it. Rewriting the framing in English tested
   * that and refuted it: the same cases fail the same way, answering
   * 8 September — the beat's own weekday plus seven, rather than the next
   * Monday. What both post-#139 arms share is a full calendar date on
   * every beat; the old raw UTC instant was ignored in favour of the one
   * day line. IT IS THE DATE, NOT THE LANGUAGE.
   *
   * THAT IS THE CLASS THE LIVE SESSIONS FILED WRONG (#57, #69, #102), so
   * it is the one that matters most, and #121 had moved it from 2-of-11 to
   * 8-of-9 with the day line alone. Recorded on #139 for the owner.
   *
   *   H1-01 «para el domingo» on a Sunday — 0 of 4, then 2 of 4 with the
   *       withdrawn paragraph, then 0 of 5 and 0 of 7 without it. The
   *       convention was the only thing that ever moved this one.
   *
   *   R3-03 «el martes» said on a Tuesday — 1 of 4, 1 of 5, 0 of 6,
   *       0 of 7. It has never worked in any arm. #102's own case.
   *
   * The wrong answers are consistently one weekday off a correct reading
   * rather than the message's own day. The model reads the calendar and
   * miscounts on it, and neither prose nor a change of language fixed
   * arithmetic. The remedy that would is the mechanical resolution the
   * ticket rules out in its own words; the numbers are on #139.
   */
  {
    id: "d-domingo-en-domingo",
    exercises:
      "NOT WRITTEN FROM, SYNTHETIC — the own-weekday convention on a weekday that is not Tuesday: «para el domingo» said on a Sunday is the NEXT Sunday, 6 September",
    counterparty: "Bodega Treviño",
    owedFromDaysAgo: 2,
    messages: [
      {
        id: "H1-01",
        fromMe: false,
        atMinute: -2120,
        text: "buen domingo, me aparta 40 sacos de cal para el domingo?",
      },
      { id: "H1-02", fromMe: true, atMinute: -2108, text: "sale, se los aparto" },
    ],
    labels: [
      {
        messageId: "H1-01",
        factType: "OrderRequested",
        because:
          "«me aparta 40 sacos de cal» asks to be supplied, and «para el domingo» is the day the customer wants them, which is what `requestedFor` is for (#70). Said on Sunday 30 August, that domingo is the NEXT one — 6 September — because a weekday named on its own weekday means the one coming; somebody meaning the day they are speaking on says «hoy».",
        checks: [
          { path: "quantity", equals: 40 },
          { path: "amount", absent: true },
          { path: "currency", absentOrEquals: "MXN" },
          { path: "requestedFor", equals: "2026-09-06" },
        ],
      },
      {
        messageId: "H1-02",
        factType: "OrderTaken",
        because:
          "«sale» plus a commitment to set them aside, answering the ask in the rep's own message. `requestedFor` ABSENT: this message names no day at all, and a day taken off the request it answers is the laundering #70 named the two fields apart to prevent.",
        checks: [
          { path: "quantity", equals: 40 },
          { path: "amount", absent: true },
          { path: "currency", absentOrEquals: "MXN" },
          { path: "requestedFor", absent: true },
        ],
      },
    ],
    silent: [],
  },

  {
    id: "d-lunes-desde-el-domingo",
    exercises:
      "NOT WRITTEN FROM, SYNTHETIC — a weekday resolved against THE BEAT'S OWN DAY: «el lunes», said on Sunday the 30th at 20:25 (02:25Z on the Monday), is 31 August and not the 7 September the day line alone would give",
    counterparty: "Aceros del Poniente",
    owedFromDaysAgo: 2,
    messages: [
      {
        id: "H2-01",
        fromMe: false,
        atMinute: -1655,
        text: "oiga, me manda 25 rollos de alambre recocido el lunes?",
      },
      {
        id: "H2-02",
        fromMe: true,
        atMinute: -1648,
        text: "va, el lunes se los mando",
      },
    ],
    labels: [
      {
        messageId: "H2-01",
        factType: "OrderRequested",
        because:
          "«me manda 25 rollos … el lunes» asks to be supplied on a named day, so `requestedFor` carries it. Said on Sunday 30 August, «el lunes» is the very next day — 31 August. The rule is the same one that makes «el domingo» a week out on the day above: the next such weekday AFTER the day the message was said on. Read against the pass's own Tuesday instead, it would be 7 September, and that gap is what this day exists to catch.",
        checks: [
          { path: "quantity", equals: 25 },
          { path: "amount", absent: true },
          { path: "currency", absentOrEquals: "MXN" },
          { path: "requestedFor", equals: "2026-08-31" },
        ],
      },
      {
        messageId: "H2-02",
        factType: "OrderTaken",
        because:
          "«va» plus a commitment to send, answering the ask. `requestedFor` ABSENT for the same reason it is on R2-02: the day in this message is the REP promising, and it is filed as this message's DatePromised instead.",
        checks: [
          { path: "quantity", equals: 25 },
          { path: "amount", absent: true },
          { path: "currency", absentOrEquals: "MXN" },
          { path: "requestedFor", absent: true },
        ],
      },
      {
        messageId: "H2-02",
        factType: "DatePromised",
        because:
          "«el lunes se los mando» is the rep committing to a delivery day — the same Monday the customer asked for, 31 August, and a second and separate fact from the order it agrees to (`facts.ts`: «that is a second, separate DatePromised»).",
        checks: [{ path: "dueOn", equals: "2026-08-31" }],
      },
    ],
    silent: [],
  },
];

/**
 * THE WHOLE CORPUS A RUN COVERS: the labelled days above, and the looking
 * cases (ticket #199).
 *
 * TWO ARRAYS AND ONE COMPOSITION, because the two halves answer different
 * questions. `SEED_TRANSCRIPTS` is what the before/after pair is over — the
 * same labels either side of 5b's migration, which is what makes the
 * comparison a claim about the extractor rather than about the corpus — and
 * `LOOKING_TRANSCRIPTS` is new material reported as its own row (spec #193
 * decision 11). A run seeds and reads both; the numbers stay apart.
 *
 * ONE HOME for the composition, so the digest, the counts and the lane
 * cannot each spread a different pair together.
 */
export const ALL_TRANSCRIPTS: readonly SeedTranscript[] = [
  ...SEED_TRANSCRIPTS,
  ...LOOKING_TRANSCRIPTS,
];
