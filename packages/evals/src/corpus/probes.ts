/**
 * THE #57 PROBES (ticket #66, the diagnosis half).
 *
 * Two days written to reproduce the two messages the #57 steering session
 * authored to be AMBIGUOUS, and which neither landed in the gate's middle
 * band. #66 names them as the reason it exists:
 *
 *   «Ah y súmale unas 20 más»
 *     → filed as a CONFIDENT `OrderTaken` for 20 bultos at 4,000 MXN — an
 *       order the rep never accepted, priced from a quote that was never
 *       given for it.
 *
 *   «¿me mandas lo mismo del pedido pasado pero para la otra semana? Y si
 *    me haces precio te pido más»
 *     → ZERO candidates. No item, no date, a conditional, and the
 *       extractor proposed nothing at all.
 *
 * THEY ARE NOT IN THE CORPUS, AND THAT IS THE POINT. `SEED_TRANSCRIPTS` is
 * what the precision number is denominated in, and its digest is checked
 * into the report; adding two days would move both, and a diagnosis that
 * silently changed the measurement it was diagnosing would be worthless.
 * These run in their own lane and score nothing.
 *
 * THEY SCORE NOTHING, EITHER. Every day carries `labels: []` and puts its
 * whole claim in `silent`, because what a reader needs from these is not a
 * verdict on a fact's content but the OBSERVATION: what the extractor
 * proposed, at what confidence, on which side of the gate.
 *
 * WHAT THEY DO ASSERT: what each sentence must never reach —
 * `PROBE_EXPECTATIONS`. The diagnosis deliberately pinned nothing here,
 * because the fix was to be decided from the numbers rather than before
 * them; a probe that printed a number nobody compared to anything would
 * stop being a regression fixture the moment the prompt moved again. Since
 * ticket #76 the decided answer for BOTH probes is a prohibition rather
 * than a requirement — the gate may stop nothing in either day.
 *
 * WHY BOTH, when only one of them ever filed anything: because they are
 * different failures and #66's third hypothesis lives in the gap between
 * them. A conditional is not a low-confidence order — it is NOT AN ORDER.
 * A missing field is a third thing again. If the extractor's only two
 * moves are "file it" and "say nothing", then no threshold can express
 * either, and that is a finding about REPRESENTATION rather than about a
 * number.
 */
import type { CandidateReading, FactType } from "@dito/aperture";
import type { SeedTranscript } from "../corpus.ts";

/**
 * THE UNANSWERED ADDITION. #57's first case, in the shape the rig saw it.
 *
 * The rep quotes a unit price, the customer orders twenty, the rep
 * confirms — and then the customer adds twenty more and the rep NEVER
 * ANSWERS. The day ends there, exactly as it did on the rig.
 *
 * WHAT IS AND IS NOT WRONG HERE, kept apart, because the first draft of
 * this note ran them together and argued for a conclusion (Codex r3):
 *
 *  - AN `OrderTaken` OF TWENTY, WITH NO AMOUNT, IS CONTRACT-CORRECT. The
 *    extractor is told `OrderTaken` is "the customer placed an order, or
 *    confirmed one", and the corpus consistently labels the CUSTOMER's
 *    ordering message while treating the rep's acknowledgement as silent
 *    («va, mándeme los 40» is the label; «listo» is not). P1-05 is the
 *    customer placing an order. A confident reading of it is the contract
 *    working, not failing.
 *  - THE PRICE IS WRONG UNDER ANY READING. «4,000 MXN» was said by
 *    nobody: it is 20 × 200, arithmetic the twin would be doing on the
 *    rep's behalf and filing as a thing that was said.
 *  - AND THE THING #57 ACTUALLY OBJECTED TO — that the rep never accepted
 *    it — IS ANSWERED BY THE TYPE SYSTEM (ticket #71, ADR-0038), not by
 *    the gate. `OrderTaken` now requires the rep's own agreeing message as
 *    evidence, so this day files an `OrderRequested` (the customer did
 *    ask) and no `OrderTaken` (nobody agreed), which is exactly right. The
 *    live lane confirms it: on the post-split tip this day files one
 *    `OrderRequested` for the addition and no `OrderTaken`. So this
 *    probe's expectation is `filed`, and it is the CONTROL: a regression
 *    that stopped this ordinary reading at the gate is the fix half
 *    over-firing, and one that files an `OrderTaken` is the defect #57
 *    reported.
 */
const UNACCEPTED_ADDITION: SeedTranscript = {
  id: "probe-57-suma-20-mas",
  exercises:
    "#57's «Ah y súmale unas 20 más» — an addition the rep never accepted, whose price only exists as arithmetic",
  counterparty: "Ferretería Palma",
  messages: [
    {
      id: "P1-01",
      fromMe: false,
      atMinute: 545,
      text: "buenos días, ¿a cómo el bulto de cemento?",
    },
    { id: "P1-02", fromMe: true, atMinute: 550, text: "buenos días! a 200 el bulto" },
    { id: "P1-03", fromMe: false, atMinute: 558, text: "va, mándeme 20" },
    { id: "P1-04", fromMe: true, atMinute: 562, text: "listo, 20 bultos" },
    {
      id: "P1-05",
      fromMe: false,
      atMinute: 610,
      text: "Ah y súmale unas 20 más",
    },
  ],
  labels: [],
  silent: [
    { messageId: "P1-01", because: "a price question states no fact" },
    {
      messageId: "P1-02",
      because:
        "a unit price IS a quote and the corpus grades that reading elsewhere — this probe is not scored, so it is claimed silent rather than labeled",
    },
    {
      messageId: "P1-03",
      because:
        "the customer's order, which the rep then accepts — graded in the corpus, not here",
    },
    { messageId: "P1-04", because: "the rep's acceptance of P1-03" },
    {
      messageId: "P1-05",
      because:
        "THE PROBE. The customer placing an order the rep never answered. An OrderTaken of twenty with no amount is what the extraction contract asks for; a PRICE for it is arithmetic nobody stated. Whether «unanswered» is a state the system should be able to hold is the open question, not a defect — this probe records, it does not judge",
    },
  ],
};

/**
 * THE CONDITIONAL WITH A HOLE IN IT. #57's second case, which produced
 * nothing at all.
 *
 * One sentence carrying three different kinds of incompleteness, which is
 * why it is the sharper of the two — and the fix half routes them three
 * different ways, which is the whole design in one message:
 *
 *  - «lo mismo del pedido pasado» — a real item, resolvable only from
 *    history the pass does not read. → `unresolved_reference`, and since
 *    #76 that means DROPPED: nothing is filed, because the only question
 *    that was ever available («should I write down that they asked for lo
 *    mismo del pedido pasado?») left the record just as unresolved after a
 *    «si» as before it.
 *  - «para la otra semana» — a real date, with no resolvable referent. →
 *    an absent optional field. Filed as absent and READ BACK as «sin
 *    fecha» (#65, #70), never a reason to stop the candidate: every
 *    dateless order would be stopped, and the record would lose the day.
 *  - «si me haces precio te pido más» — NOT AN ORDER. Not a low-confidence
 *    one either: a conditional whose antecedent has not happened. → NOTHING.
 *    «Te pidió más» is false whichever way the rep answers, so there is no
 *    sentence to ask about.
 *
 * The rep's reply neither accepts nor refuses, which is what a rep says
 * when they are about to go and check.
 *
 * WHAT THE DIAGNOSIS SAW HERE NO LONGER REPRODUCES, and that is worth
 * recording rather than quietly correcting. The diagnosis measured ZERO
 * candidates on this day — silence. On the post-split tip, before the fix
 * half changed anything, the same model filed a CONFIDENT `OrderRequested`
 * at 0.95: «Te pidió lo mismo del pedido pasado — sin cantidad, sin
 * precio, sin fecha.» The sentence is true as far as it goes and the twin
 * still cannot resolve what it names — so the failure moved from silence
 * to an unasked crossing, and neither is right.
 *
 * AND THE ANSWER TURNED OUT NOT TO BE A QUESTION EITHER (ticket #76). #66
 * routed this sentence to the rep; the rig raised it, and the ask could not
 * be answered — a «si» files a record that still names nothing. So the
 * candidate is dropped, and what this day should now produce is silence
 * that the pass COUNTS rather than silence nobody can see. The remedy that
 * would file a real fact here — an extraction that goes and looks up what
 * the last order was — is ADR-0037's execution shape and is not built.
 */
const CONDITIONAL_REPEAT: SeedTranscript = {
  id: "probe-57-lo-mismo-condicional",
  exercises:
    "#57's «lo mismo del pedido pasado … y si me haces precio te pido más» — an unresolvable item, an unresolvable date, and a conditional, in one sentence",
  counterparty: "Materiales del Valle",
  messages: [
    { id: "P2-01", fromMe: false, atMinute: 600, text: "buenas, ¿cómo va todo?" },
    { id: "P2-02", fromMe: true, atMinute: 604, text: "todo bien! ¿qué necesita?" },
    {
      id: "P2-03",
      fromMe: false,
      atMinute: 612,
      text: "¿me mandas lo mismo del pedido pasado pero para la otra semana? Y si me haces precio te pido más",
    },
    {
      id: "P2-04",
      fromMe: true,
      atMinute: 640,
      text: "déjeme revisarlo y le digo",
    },
  ],
  labels: [],
  silent: [
    { messageId: "P2-01", because: "a greeting states no fact" },
    { messageId: "P2-02", because: "a greeting states no fact" },
    {
      messageId: "P2-03",
      because:
        "THE PROBE. Three holes in one sentence — an item resolvable only from history the pass does not read, a date with no resolvable referent, and a conditional that is not an order at any confidence. Silence and a confident filing are both wrong, and #66's fix half makes the third thing expressible: the ask is recorded in the customer's own words and put to the rep, the missing date is filed as «sin fecha», and the condition produces nothing",
    },
    {
      messageId: "P2-04",
      because:
        "the rep neither accepts nor refuses — no commitment, so no date is promised",
    },
  ],
};

/**
 * The probe days, in the order they are reported.
 *
 * Separate from `SEED_TRANSCRIPTS` on purpose: these are DIAGNOSTIC and
 * are never scored into the precision number, so the corpus digest the
 * checked-in report carries does not move when they change.
 */
export const PROBE_TRANSCRIPTS: readonly SeedTranscript[] = [
  UNACCEPTED_ADDITION,
  CONDITIONAL_REPEAT,
];

/**
 * The exact sentence each probe day exists to put in front of the
 * extractor — the join between a probe and the #57 finding it reproduces.
 *
 * Held apart from the transcript so a test can check that the sentence
 * survives an edit to the day around it. A probe whose probe message had
 * been quietly reworded would still run, still print numbers, and no
 * longer be about #57 at all.
 */
export const PROBE_MESSAGES: Readonly<Record<string, string>> = {
  "probe-57-suma-20-mas": "P1-05",
  "probe-57-lo-mismo-condicional": "P2-03",
};

/**
 * WHAT ONE PROBE SENTENCE SHOULD PRODUCE (ticket #66, the fix half).
 *
 * NOT JUST THE OUTCOME (Codex r1). "Some candidate cited this message" is
 * far too weak to be a regression fixture for #57: a low-confidence
 * candidate about «te pido más» — the conditional, which is not an order at
 * any confidence — would satisfy it, and so would one stopped by the
 * unchanged confidence gate rather than by the reading route #66 added. The
 * same weakness on the other probe would let a confident `OrderTaken` pass,
 * which is the exact wrong ADR-0038 exists to prevent. So the expectation
 * names the KIND of claim, and — where the claim was STOPPED — WHICH of the
 * gate's two tests stopped it.
 */
export interface ProbeExpectation {
  /**
   * The one claim this sentence must produce — for a sentence whose answer
   * the model can be held to.
   *
   * ABSENT WHERE IT CANNOT BE, and that is a measurement rather than a
   * softening. #66's own diagnosis records that `message_id` is
   * model-supplied and attribution is unreliable; two live runs of this
   * lane, on identical input, showed it: one filed an `OrderRequested` on
   * «Ah y súmale unas 20 más», the next read the day correctly and said
   * nothing about that sentence at all. Requiring the crossing would make
   * this lane a red gate on a recall wobble the ticket did not introduce,
   * which is the flaky gate the eval stage refuses. What must NEVER happen
   * is named below instead, and that is stable.
   *
   * NO PROBE CARRIES ONE TODAY (ticket #76). The conditional did, until the
   * outcome it required — an ask — became the thing that must never happen,
   * and "nothing was stored" turned out to be exactly the kind of wobbly
   * claim this field's own rule refuses to gate on. It stays because the
   * remedy that follows this ticket states its acceptance in precisely this
   * shape: a fact FILED with the resolved goods, of a named kind, whose
   * claim names them. Its behaviour is pinned in `probes.test.ts`.
   */
  readonly requires?: {
    readonly outcome: ProbeOutcome;
    /** The one kind of claim this sentence should produce, and no other. */
    readonly factType: FactType;
    /**
     * Which of the gate's two tests must have stopped it. Only meaningful
     * on a `dropped_below_gate` outcome — a crossing carries no reading,
     * because the Ledger stores the fact rather than the reading of the
     * message (ADR-0034).
     */
    readonly reading?: CandidateReading;
    /**
     * A fragment the claim the rep is shown must contain (Codex r2).
     *
     * WITHOUT IT THE ORACLE IS STILL BLIND to the behaviour #57 reported.
     * «¿me mandas lo mismo del pedido pasado …? Y si me haces precio te
     * pido más» has TWO readings in it, and only one is a fact: a single
     * `OrderRequested` claim whose text is «Te pidió más» — the CONDITION,
     * which has not happened — passes every count, type and reading check
     * above while being exactly the thing #57 reported.
     *
     * A FRAGMENT RATHER THAN THE WHOLE SENTENCE, because the model chooses
     * the words that go in `item` and they move between runs («lo mismo
     * del pedido pasado» / «lo mismo que el pedido pasado»). It is the
     * same shape the corpus's own labels use for prose fields — a
     * `contains`, checked case-insensitively — for the same reason.
     *
     * CHECKED ON A CROSSING AND NOWHERE ELSE (ticket #218). It read the
     * question's own text until the route was retired, and a candidate the
     * gate stops now reaches no renderer at all — nothing is rendered for
     * it, deliberately (`fileCandidateFact`). The disclosure line of a fact
     * that CROSSED is the only claim a run can read back, which is also the
     * side the remedy `requires` waits for will name.
     */
    readonly claimContains?: string;
  };
  /**
   * Kinds of claim this sentence must never produce, however it is read.
   *
   * MESSAGE-SCOPED, AND THAT IS A KNOWN LIMIT (Codex r3). Attribution is
   * the model's own, so an `OrderTaken` read out of «Ah y súmale unas 20
   * más» and cited against the rep's earlier «listo, 20 bultos» is
   * indistinguishable, in the stored rows, from the CORRECT `OrderTaken`
   * that exchange really does produce. Telling them apart needs the
   * candidate's payload or a pre-storage trace — recorded, not built.
   */
  readonly neverClaims: readonly FactType[];
  /**
   * True when the gate may stop NOTHING anywhere in this probe's day.
   *
   * DAY-SCOPED, not message-scoped (Codex r3), and the wider scope is what
   * makes it worth having: a candidate read out of this sentence but cited
   * against a neighbouring message would leave the probe's own list empty
   * and pass a message-scoped check while the day lost exactly the fact
   * this rule is not supposed to allow it to lose. These probe days are
   * small and every message in them is accounted for, so "nothing stopped
   * anywhere" is a safe thing to assert.
   *
   * IT IS BOTH PROBES' MAIN ASSERTION SINCE #76, for two reasons that
   * happen to want the same check. On the addition it means the reading
   * route is not over-firing on an ordinary sentence. On the conditional it
   * means the route is not firing AT ALL.
   *
   * A STOPPED CANDIDATE IS READ BACK OFF THE RUN'S OWN SUBMISSION,
   * classified by the aperture's `gateVerdict` (ticket #218) — there is no
   * store to read it out of, and this rule is a claim about the extractor
   * either way.
   */
  readonly neverDropped: boolean;
  /**
   * True when this sentence should be the ONLY thing its day produces.
   *
   * UNUSED SINCE #76 and kept as a capability rather than deleted: the
   * conditional's day, which is the only one small enough to claim it,
   * stores NOTHING when the reading fires and one claim when it does not,
   * so "exactly one" would gate the lane on a wobble. What it used to
   * close — a correct claim plus a false one cited against a neighbour — is
   * closed more strongly by `neverDropped`, which forbids both.
   */
  readonly soleClaimInDay: boolean;
}

/**
 * WHAT EACH PROBE SENTENCE SHOULD REACH (ticket #66, the fix half).
 *
 * The lane still SCORES nothing — no label, no precision, no verdict on a
 * fact's content — but it now compares what it observed against what the
 * fix decided, and fails when they differ. Without this a probe run is a
 * printout: it would show the same numbers whether the fix was working or
 * had been undone by the next prompt edit, and nobody would notice.
 *
 * NOT JUST THE OUTCOME (Codex r1). "Some candidate cited this message" is
 * far too weak to be #57's regression fixture: a low-confidence candidate
 * about «Y si me haces precio te pido más» — the conditional, which is not
 * an order at any confidence — would satisfy it, and so would one stopped
 * by the unchanged confidence gate rather than by the reading route #66
 * added. The same weakness on the other probe would let a confident
 * `OrderTaken` back in, which is #57's original defect.
 *
 * BOTH PROBES ARE NAMED BY WHAT MUST NOT HAPPEN (ticket #76), and the two
 * arrived there by different roads:
 *
 *  - THE ADDITION was always the CONTROL: no `OrderTaken` (the #57 defect
 *    ADR-0038 closed in the type system) and nothing stopped by the gate
 *    (the reading route over-firing, which would cost the record facts that
 *    are already right). Whether it files its `OrderRequested` is desirable
 *    and was never stable enough to gate on — see `requires`.
 *  - THE CONDITIONAL required an ask while #66's fix half stood, and #76
 *    ruled that ask unanswerable in principle: the candidate is DROPPED and
 *    this day must never reach the rep at all. Its stable half is therefore
 *    the same shape as the control's — nothing stopped, anywhere in the
 *    day.
 *
 * A FAILING PROBE IS NOT A FAILING NUMBER, and the distinction is why this
 * lane may exit non-zero where the precision lane may not. The precision
 * number gates nothing (#56 AC 6) and a CI job failing on it would be a
 * flaky gate on a measurement. These are NAMED CASES with a decided
 * answer — the definition of a regression fixture — so a mismatch is a
 * result somebody has to look at, not a number that drifted.
 *
 * The deterministic half of the same claim — that the aperture drops such a
 * reading — is pinned at the seam, in `extraction.int.test.ts` and
 * `facts.int.test.ts`, and runs on every push. This lane needs the live
 * model, which no CI run has a key for by default and whose output is not
 * reproducible anyway.
 */
export const PROBE_EXPECTATIONS: Readonly<Record<string, ProbeExpectation>> = {
  "probe-57-suma-20-mas": {
    neverClaims: ["OrderTaken"],
    neverDropped: true,
    // Its day carries the quote, the order and the rep's acceptance on
    // purpose — «súmale unas 20 más» means nothing without the twenty it
    // adds to — so this day is expected to produce more than one claim.
    soleClaimInDay: false,
  },
  "probe-57-lo-mismo-condicional": {
    // THE ASK IS GONE, SO THE EXPECTATION NAMES ITS ABSENCE (ticket #76).
    //
    // #66's fix half REQUIRED this sentence to be asked about, as an
    // `OrderRequested` read as `unresolved_reference`, with «pedido
    // pasado» in the claim. The rig then showed the ask was unanswerable
    // in principle — «Te pidió lo mismo del pedido pasado» is still
    // unresolved after a «si» — so the candidate is DROPPED now, and this
    // day must never put anything in front of the rep again.
    //
    // WHY NO `requires`, on this lane's own criterion. What replaces the
    // ask is "nothing was stored", and that is not stable enough to gate
    // on: if the model reads the sentence as `stated` instead, the day
    // files an ordinary `OrderRequested`, and requiring silence would turn
    // the lane red on a recall wobble the ticket did not introduce. It is
    // the same reason the control carries no `requires` — so the stable
    // half is asserted and the wobbly half is left to the numbers.
    neverClaims: [],
    neverDropped: true,
    // Nothing is stored when the reading fires and one claim is stored
    // when it does not, so "exactly one" is the wobble now, not the rule.
    soleClaimInDay: false,
  },
};

/**
 * One candidate the gate STOPPED, as this oracle reads it (ticket #218).
 *
 * THE TWO FIELDS THE ORACLE ASKS ABOUT, and deliberately not
 * `ObservedDrop`'s five: a fixture supplies what it asserts on, and this
 * comparison never reads a transcript, a message id or a confidence. The
 * lane fills these from `ObservedDrop` (`confidence-probe.ts`).
 *
 * NO TEXT, and its absence is the retirement: nothing is rendered for a
 * candidate the gate stops, deliberately (`fileCandidateFact`), so there is
 * no claim to read back. `requires.claimContains` is checked on a CROSSING
 * for exactly that reason.
 */
export interface ProbeDrop {
  readonly factType: string;
  readonly reading: CandidateReading;
}

/** What a run actually observed about one probe sentence. */
export interface ProbeObservation {
  readonly outcome: ProbeOutcome;
  /** Stored crossings citing the probe message, and what the rep would read. */
  readonly crossed: readonly {
    readonly factType: string;
    readonly disclosureText: string;
  }[];
  /** Candidates the gate stopped citing it, with how the model read them. */
  readonly dropped: readonly ProbeDrop[];
  /**
   * EVERYTHING STORED ANYWHERE IN THE PROBE'S DAY, the probe's own rows
   * included (Codex r3).
   *
   * The probe lists above are keyed on `message_id`, which is the MODEL'S
   * — the scorer carries a `misattributed` reason precisely because a live
   * run filed two facts against the wrong message. So a check that only
   * ever looks at rows citing the probe can be walked past by citing a
   * neighbour, and the two rules that must not be walked past that way are
   * day-scoped instead.
   */
  readonly day: {
    readonly crossed: number;
    readonly dropped: readonly ProbeDrop[];
  };
}

/**
 * Every way one probe's run disagrees with what the fix decided — empty
 * when it agrees.
 *
 * A LIST RATHER THAN A BOOLEAN, because a probe that fails should say
 * which of several different things went wrong: the outcome, the kind of
 * claim, the reading that stopped it, or a second claim nobody expected.
 * Reasons rather than an exception for the same reason `scoreCrossings`
 * names why a crossing did not count — a lane whose whole value is being
 * argued with cannot report "false".
 */
export function probeMismatches(
  expected: ProbeExpectation,
  observed: ProbeObservation,
): string[] {
  const problems: string[] = [];
  for (const claim of [...observed.crossed, ...observed.dropped]) {
    if (expected.neverClaims.includes(claim.factType as FactType)) {
      problems.push(
        `a ${claim.factType} was claimed about this sentence, and this sentence must never produce one`,
      );
    }
  }
  if (expected.neverDropped && observed.day.dropped.length > 0) {
    problems.push(
      `the gate stopped ${observed.day.dropped.length} candidate(s) in this day, and no message in it may lose one that way — an unresolvable reference is dropped before the gate reads it (#76) and an ordinary reading crosses`,
    );
  }
  if (
    expected.soleClaimInDay &&
    observed.day.crossed + observed.day.dropped.length !== 1
  ) {
    problems.push(
      `this day should store exactly one claim and it produced ${observed.day.crossed + observed.day.dropped.length} — every other message in it states nothing, so a second claim is one that should not exist wherever it was cited`,
    );
  }
  const required = expected.requires;
  if (required === undefined) return problems;

  if (observed.outcome !== required.outcome) {
    problems.push(
      `expected the sentence to be ${required.outcome}, and it was ${observed.outcome}`,
    );
  }
  // EXACTLY ONE CLAIM OF THE EXPECTED KIND, AND NONE OF THE OTHER. A
  // second candidate read out of one sentence is what «Y si me haces
  // precio te pido más» invites, and a conditional is not an order at any
  // confidence — so "one claim about this message" would pass while the
  // record gained a thing that has not happened.
  const claims =
    required.outcome === "filed" ? observed.crossed : observed.dropped;
  const others =
    required.outcome === "filed" ? observed.dropped : observed.crossed;
  if (claims.length !== 1) {
    problems.push(
      `expected exactly one ${required.factType} claim about this sentence, and there were ${claims.length}`,
    );
  }
  for (const claim of claims) {
    if (claim.factType !== required.factType) {
      problems.push(
        `expected a ${required.factType}, and a ${claim.factType} was claimed instead`,
      );
    }
  }
  if (others.length > 0) {
    problems.push(
      `${others.length} other claim(s) about this sentence reached a store, and this sentence should produce exactly one`,
    );
  }
  for (const drop of observed.dropped) {
    if (required.reading !== undefined && drop.reading !== required.reading) {
      problems.push(
        `expected the candidate to be stopped under a reading of ${required.reading}, and it was read as ${drop.reading} — the confidence gate catching this by accident is not the fix working`,
      );
    }
  }
  // THE CLAIM IS READ OFF WHAT CROSSED (ticket #218), because that is the
  // only claim a run can read back: nothing is rendered for a candidate the
  // gate stops. It is also the side the remedy this field waits for will
  // name — a fact FILED with the resolved goods, whose line names them.
  for (const claim of observed.crossed) {
    if (
      required.claimContains !== undefined &&
      !claim.disclosureText
        .toLowerCase()
        .includes(required.claimContains.toLowerCase())
    ) {
      problems.push(
        `expected the rep to read «${required.claimContains}» in the line this crossing disclosed, and it says «${claim.disclosureText}» — a claim about the other half of this sentence is not this sentence's fact`,
      );
    }
  }
  return problems;
}

/**
 * What a probe run may conclude about one probe sentence.
 *
 * `day_proposed_nothing` is the ONLY outcome that supports the word
 * silence, and the bar is deliberately high: no candidate anywhere in the
 * day. Anything weaker is `nothing_attributed_to_probe`, which says what
 * is actually known — nothing cites this message — and no more.
 *
 * `dropped_below_gate` is the word for a candidate the gate stopped (ticket
 * #218): it reaches no store and no rep, so "asked" would name an ask nobody
 * received.
 */
export type ProbeOutcome =
  | "filed"
  | "dropped_below_gate"
  | "day_proposed_nothing"
  | "nothing_attributed_to_probe";

/**
 * Classifies one probe sentence from what the run can actually see.
 *
 * THE EVIDENCE IS WEAKER THAN IT LOOKS, twice over, and both weaknesses
 * point the same way — towards over-claiming silence, which is precisely
 * the conclusion #66's third hypothesis turns on.
 *
 *  - `message_id` IS MODEL-SUPPLIED (Codex r3). The scorer carries a
 *    `misattributed` reason because the first live run filed two facts
 *    against the wrong message, and these probe days carry context on
 *    purpose — «súmale unas 20 más» means nothing without the twenty it
 *    adds to. So a candidate the PROBE induced can be stored citing a
 *    neighbouring message, and "nothing cites the probe" would report it
 *    as silence.
 *  - A REFUSED candidate reaches no store (Codex r2), and refusals are
 *    counted per chat-day, so one cannot be attributed to a message at all.
 *
 * Hence: silence is claimed only when the day proposed NOTHING, where
 * neither weakness can bite. Everything else is named unattributable.
 *
 * ONLY ONE OF THE TWO STILL BITES (ticket #218). The below-gate half is read
 * off the run's own submissions, which carry every candidate the model
 * proposed — so a second stopped reading of one sentence is visible. The
 * REFUSAL is per-day and unattributable, which is why this rule stands.
 */
export function classifyProbeOutcome(seen: {
  /** Stored crossings citing the probe message. */
  readonly citingProbe: number;
  /** Candidates the gate stopped citing it. */
  readonly droppedProbe: number;
  /** Candidates the pass counted across the whole chat-day. */
  readonly dayCandidates: number;
  /** Candidates the aperture refused in this chat-day — message unknown. */
  readonly dayRefusals: number;
  /** Claims in this day — crossed or stopped — citing some OTHER message. */
  readonly otherStoredInDay: number;
}): ProbeOutcome {
  if (seen.citingProbe > 0) return "filed";
  if (seen.droppedProbe > 0) return "dropped_below_gate";
  if (
    seen.dayCandidates === 0 &&
    seen.dayRefusals === 0 &&
    seen.otherStoredInDay === 0
  ) {
    return "day_proposed_nothing";
  }
  return "nothing_attributed_to_probe";
}
