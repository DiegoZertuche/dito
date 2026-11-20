/**
 * THE #57 PROBES ARE STILL THE #57 CASES (ticket #66).
 *
 * These days exist to put two exact sentences in front of the extractor. A
 * probe whose probe message had been quietly reworded — or moved past the
 * window the pass reads, or dropped from the day around it — would still
 * run, still print numbers, and no longer be about #57 at all.
 *
 * WHAT IS NOT PINNED HERE, deliberately: what the extractor DOES with
 * them. No expected fact type, no expected confidence, no expected side of
 * the gate. That is the observation the diagnosis reports and the fix half
 * of #66 decides from; a test asserting it now would be pinning gate
 * behaviour before anyone has looked at the numbers.
 */
import { describe, expect, it } from "vitest";
import { LAST_READABLE_MINUTE } from "../clock.ts";
import { SEED_TRANSCRIPTS } from "./transcripts.ts";
import type {
  ProbeDrop,
  ProbeObservation,
  ProbeOutcome,
} from "./probes.ts";
import {
  classifyProbeOutcome,
  probeMismatches,
  PROBE_EXPECTATIONS,
  PROBE_MESSAGES,
  PROBE_TRANSCRIPTS,
} from "./probes.ts";

/** The two sentences, quoted from #66 itself. */
const FIFTY_SEVEN = {
  "probe-57-suma-20-mas": "Ah y súmale unas 20 más",
  "probe-57-lo-mismo-condicional":
    "¿me mandas lo mismo del pedido pasado pero para la otra semana? Y si me haces precio te pido más",
} as const;

describe("the probes carry #57's own sentences", () => {
  it.each(Object.entries(FIFTY_SEVEN))(
    "%s puts the message in front of the extractor verbatim",
    (transcriptId, sentence) => {
      const transcript = PROBE_TRANSCRIPTS.find((t) => t.id === transcriptId)!;
      expect(transcript, `${transcriptId} is not a probe`).toBeDefined();
      const messageId = PROBE_MESSAGES[transcriptId]!;
      const message = transcript.messages.find((m) => m.id === messageId)!;
      expect(message.text).toBe(sentence);
      // The COUNTERPARTY says it, not the rep. Both #57 cases are things a
      // customer wrote, and a probe that put them in the rep's mouth would
      // be exercising a different reading entirely.
      expect(message.fromMe).toBe(false);
    },
  );

  it("puts every probe message inside the window the pass actually reads", () => {
    // A message after the window is seeded, never read, and never
    // observed — the probe would report "nothing proposed" for a message
    // the extractor was never shown.
    for (const transcript of PROBE_TRANSCRIPTS) {
      for (const message of transcript.messages) {
        expect(
          message.atMinute,
          `${transcript.id}/${message.id} falls outside the read window`,
        ).toBeLessThanOrEqual(LAST_READABLE_MINUTE);
      }
    }
  });

  it("accounts for every message, so the probe's own claim is legible", () => {
    for (const transcript of PROBE_TRANSCRIPTS) {
      const claimed = new Set(transcript.silent.map((s) => s.messageId));
      for (const message of transcript.messages) {
        expect(
          claimed.has(message.id),
          `${transcript.id}/${message.id} says nothing about why it is here: "${message.text}"`,
        ).toBe(true);
      }
      for (const claim of transcript.silent) {
        expect(claim.because.length).toBeGreaterThan(20);
      }
    }
  });

  it("says what each probe must never reach, so a run is compared rather than merely printed (#66, #76)", () => {
    // The diagnosis pinned no outcome on purpose — the fix was to be
    // decided from the numbers. It was, twice: #66 decided the conditional
    // should be ASKED about, and #76 decided that ask was unanswerable and
    // removed it. So NEITHER probe requires an outcome now, and both are
    // named by the thing that must not happen — no question raised in
    // either day, whatever the model reads. The comparison runs in the live
    // lane, never in CI: extraction prose is not asserted here (ADR-0028).
    //
    // AN EXACT SHAPE, so `requires` cannot come back unnoticed. A `toEqual`
    // fails on a key these objects should not carry, which is what makes
    // this the guard against #66's expectation returning: it REQUIRED the
    // ask that #76 removed, so a build that still asked would have been
    // reported AS EXPECTED and a correct one reported broken.
    for (const transcript of PROBE_TRANSCRIPTS) {
      expect(
        PROBE_EXPECTATIONS[transcript.id],
        `${transcript.id} says nothing about what it should reach`,
      ).toBeDefined();
    }
    expect(PROBE_EXPECTATIONS["probe-57-suma-20-mas"]).toEqual({
      neverClaims: ["OrderTaken"],
      neverDropped: true,
      soleClaimInDay: false,
    });
    expect(PROBE_EXPECTATIONS["probe-57-lo-mismo-condicional"]).toEqual({
      neverClaims: [],
      neverDropped: true,
      soleClaimInDay: false,
    });
  });

  it("scores nothing — a probe carries no labels, and is not in the corpus", () => {
    // The precision number and its corpus digest must not move because a
    // diagnosis added two days. If a probe ever needs a label, it has
    // stopped being a probe and belongs in the corpus with the rest.
    const corpusIds = new Set(SEED_TRANSCRIPTS.map((t) => t.id));
    for (const transcript of PROBE_TRANSCRIPTS) {
      expect(transcript.labels).toEqual([]);
      expect(corpusIds.has(transcript.id)).toBe(false);
    }
  });

  it("shares no message id with the corpus — the two lanes never collide", () => {
    const corpusMessages = new Set(
      SEED_TRANSCRIPTS.flatMap((t) => t.messages.map((m) => m.id)),
    );
    for (const transcript of PROBE_TRANSCRIPTS) {
      for (const message of transcript.messages) {
        expect(corpusMessages.has(message.id)).toBe(false);
      }
    }
  });
});

/**
 * WHAT A PROBE RUN MAY CONCLUDE (ticket #66; Codex rounds 2 and 3).
 *
 * The lane's whole value is telling #66's three outcomes apart, and the
 * evidence available is weaker than it looks. `message_id` is
 * MODEL-SUPPLIED — the scorer has a `misattributed` reason precisely
 * because the first live run filed two facts against the wrong message —
 * so "nothing cites the probe" is not "the extractor said nothing about
 * the probe". And a REFUSED candidate reaches no store at all, with only a
 * per-chat-day count behind it.
 *
 * These pin the conclusions the lane is allowed to draw from that.
 */
describe("what a probe run may conclude from what it can see", () => {
  it("calls it FILED when a stored crossing cites the probe message", () => {
    expect(
      classifyProbeOutcome({
        citingProbe: 1,
        droppedProbe: 0,
        dayCandidates: 3,
        dayRefusals: 0,
        otherStoredInDay: 2,
      }),
    ).toBe("filed");
  });

  it("calls it DROPPED BELOW GATE when a stopped candidate cites it (#218)", () => {
    expect(
      classifyProbeOutcome({
        citingProbe: 0,
        droppedProbe: 1,
        dayCandidates: 1,
        dayRefusals: 0,
        otherStoredInDay: 0,
      }),
    ).toBe("dropped_below_gate");
  });

  it("claims SILENCE only when the whole day proposed nothing", () => {
    // The one case the evidence actually supports: no candidate was
    // emitted anywhere in the day, so none was emitted about the probe,
    // whatever message the model would have cited.
    expect(
      classifyProbeOutcome({
        citingProbe: 0,
        droppedProbe: 0,
        dayCandidates: 0,
        dayRefusals: 0,
        otherStoredInDay: 0,
      }),
    ).toBe("day_proposed_nothing");
  });

  it("refuses to call it silence when the day proposed something else", () => {
    // Codex r3. The probe days carry context on purpose — «súmale unas 20
    // más» means nothing without the twenty it adds to — so a candidate
    // the PROBE induced can be filed against a neighbouring message and
    // land in the day's other rows. Reading that as "the extractor
    // proposed nothing about the probe" would answer #66's third
    // hypothesis with a misattribution.
    expect(
      classifyProbeOutcome({
        citingProbe: 0,
        droppedProbe: 0,
        dayCandidates: 2,
        dayRefusals: 0,
        otherStoredInDay: 2,
      }),
    ).toBe("nothing_attributed_to_probe");
  });

  it("...nor when the day refused something, which no store records", () => {
    expect(
      classifyProbeOutcome({
        citingProbe: 0,
        droppedProbe: 0,
        dayCandidates: 1,
        dayRefusals: 1,
        otherStoredInDay: 0,
      }),
    ).toBe("nothing_attributed_to_probe");
  });
});

/**
 * HOW THE ORACLE COMPARES A RUN AGAINST AN EXPECTATION (ticket #66's fix
 * half; Codex r1).
 *
 * The first version of the comparison asked only whether the OUTCOME
 * matched, which is far too weak to be #57's regression fixture: "some
 * question cited this message" is satisfied by a question about «Y si me
 * haces precio te pido más» — a conditional, which is not an order at any
 * confidence — and by one the unchanged confidence gate stopped rather than
 * the reading route #66 added. These pin the cases that weakness would have
 * let through.
 *
 * THE `requires` FIXTURE BELOW IS THE ORACLE'S CONTRACT, NOT A PROBE'S
 * ANSWER (ticket #76). No probe requires an outcome any more — #76 removed
 * the one that did, because the ask it required is the thing that must
 * never happen now — so what these exercise is the comparison's own
 * behaviour when an expectation DOES name a required outcome. That is the
 * shape the resolve-the-reference remedy will state its acceptance in, and
 * `PROBE_EXPECTATIONS`' own contents are pinned separately above.
 */
describe("the oracle compares a run against what an expectation names", () => {
  /**
   * A required-stop expectation, in the shape #66's fix half used. Kept as
   * a FIXTURE: nothing in `PROBE_EXPECTATIONS` carries one today.
   */
  const STOPPED = {
    requires: {
      outcome: "dropped_below_gate",
      factType: "OrderRequested",
      reading: "unresolved_reference",
    },
    neverClaims: [],
    neverDropped: false,
    soleClaimInDay: true,
  } as const;
  /** The control: named by what must NEVER happen — see `ProbeExpectation`. */
  const CONTROL = {
    neverClaims: ["OrderTaken"],
    neverDropped: true,
    soleClaimInDay: false,
  } as const;
  /** The candidate the reading route is supposed to catch. */
  const THE_PAST_ORDER = {
    factType: "OrderRequested",
    reading: "unresolved_reference",
  } as const;
  /** One crossing, with the line the rep would read. */
  const filed = (factType: string, disclosureText = "Te pidió 20 cajas."):
    { factType: string; disclosureText: string } => ({
    factType,
    disclosureText,
  });

  /**
   * One run's view of a probe. `day` defaults to exactly the probe's own
   * rows — the ordinary case, where the model cited the message it read —
   * so a fixture only spells the day out when it is exercising the case
   * Codex r3 named: a claim cited against a NEIGHBOUR.
   */
  function observed(seen: {
    outcome: ProbeOutcome;
    crossed?: readonly { factType: string; disclosureText: string }[];
    dropped?: readonly ProbeDrop[];
    day?: { crossed: number; dropped: readonly ProbeDrop[] };
  }): ProbeObservation {
    const crossed = seen.crossed ?? [];
    const dropped = seen.dropped ?? [];
    return {
      outcome: seen.outcome,
      crossed,
      dropped,
      day: seen.day ?? { crossed: crossed.length, dropped },
    };
  }

  it("agrees when a required stop is matched in outcome, kind and reading", () => {
    expect(
      probeMismatches(
        STOPPED,
        observed({ outcome: "dropped_below_gate", dropped: [THE_PAST_ORDER] }),
      ),
    ).toEqual([]);
  });

  it("REFUSES a stop the confidence gate made on its own — that is not this fix firing", () => {
    // An outcome-only comparison cannot tell the reading route from the
    // confidence gate that was already there, so the fix could be reverted
    // entirely and the lane would still print "AS EXPECTED".
    expect(
      probeMismatches(
        STOPPED,
        observed({
          outcome: "dropped_below_gate",
          dropped: [{ ...THE_PAST_ORDER, reading: "stated" }],
        }),
      ),
    ).toEqual([
      expect.stringContaining("stopped under a reading of unresolved_reference"),
    ]);
  });

  it("REFUSES a stop on the wrong kind of claim", () => {
    expect(
      probeMismatches(
        STOPPED,
        observed({
          outcome: "dropped_below_gate",
          dropped: [{ ...THE_PAST_ORDER, factType: "DatePromised" }],
        }),
      ),
    ).toEqual([expect.stringContaining("a DatePromised was claimed instead")]);
  });

  it("REFUSES a crossing whose LINE names the other half of the sentence (#218)", () => {
    // Codex r2's finding, on the side a run can still read back. «¿me
    // mandas lo mismo del pedido pasado …? Y si me haces precio te pido
    // más» carries two readings and only the first is a fact, so a filed
    // `OrderRequested` whose line says «Te pidió más» — the CONDITION,
    // which has not happened — satisfies the outcome, the type and the
    // count while being exactly what #57 reported. Nothing but the line
    // itself can tell them apart.
    expect(
      probeMismatches(
        { ...CONTROL, requires: { ...STOPPED.requires, outcome: "filed" as const, claimContains: "pedido pasado" } },
        observed({
          outcome: "filed",
          crossed: [filed("OrderRequested", "Te pidió más — sin cantidad.")],
        }),
      ),
    ).toEqual([
      expect.stringContaining("expected the rep to read «pedido pasado»"),
    ]);
  });

  it("REFUSES the same forbidden stop when the model cites a NEIGHBOURING message", () => {
    // Codex r3. `message_id` is the model's own and misattribution is
    // observed in this repo, so a check that only reads claims citing the
    // probe is walked past by citing the rep's «déjeme revisarlo» instead.
    // The day still loses the fact; only the oracle stopped seeing it.
    // Every other message in this day states nothing, so "one claim in the
    // day" is a safe thing to require.
    expect(
      probeMismatches(
        STOPPED,
        observed({
          outcome: "dropped_below_gate",
          dropped: [THE_PAST_ORDER],
          day: { crossed: 0, dropped: [THE_PAST_ORDER, THE_PAST_ORDER] },
        }),
      ),
    ).toEqual([expect.stringContaining("this day should store exactly one claim")]);
  });

  it("REFUSES a second claim read out of the same sentence", () => {
    expect(
      probeMismatches(
        STOPPED,
        observed({
          outcome: "dropped_below_gate",
          dropped: [THE_PAST_ORDER, THE_PAST_ORDER],
        }),
      ),
    ).toEqual([
      expect.stringContaining("this day should store exactly one claim"),
      expect.stringContaining("exactly one OrderRequested claim"),
    ]);
  });

  it("agrees when the addition files one OrderRequested and its day's context", () => {
    expect(
      probeMismatches(
        CONTROL,
        observed({
          outcome: "filed",
          crossed: [filed("OrderRequested")],
          // The quote, the earlier order and the rep's acceptance of it —
          // the context «súmale unas 20 más» is meaningless without.
          day: { crossed: 4, dropped: [] },
        }),
      ),
    ).toEqual([]);
  });

  it("...and when the model simply says nothing about it — a recall wobble is not a regression", () => {
    // MEASURED, not conceded. Two live runs on identical input disagreed
    // about whether «Ah y súmale unas 20 más» gets a candidate at all: one
    // filed an `OrderRequested` on it, the next read the day correctly and
    // attributed nothing to that sentence. #66's own diagnosis records why
    // — `message_id` is model-supplied. Gating on the crossing would make
    // this lane red on a wobble the ticket did not introduce.
    expect(
      probeMismatches(
        CONTROL,
        observed({
          outcome: "nothing_attributed_to_probe",
          day: { crossed: 3, dropped: [] },
        }),
      ),
    ).toEqual([]);
  });

  it("REFUSES the OrderTaken coming back — #57's original defect", () => {
    // The order the rep never accepted. #71 closed it in the type system;
    // this is the fixture that notices if it reopens.
    expect(
      probeMismatches(
        CONTROL,
        observed({
          outcome: "filed",
          crossed: [filed("OrderRequested"), filed("OrderTaken")],
          day: { crossed: 5, dropped: [] },
        }),
      ),
    ).toEqual([
      expect.stringContaining("a OrderTaken was claimed about this sentence"),
    ]);
  });

  it("REFUSES the ordinary reading being stopped at the gate — the fix over-firing", () => {
    expect(
      probeMismatches(
        CONTROL,
        observed({
          outcome: "dropped_below_gate",
          dropped: [THE_PAST_ORDER],
          day: { crossed: 3, dropped: [THE_PAST_ORDER] },
        }),
      ),
    ).toEqual([
      expect.stringContaining("the gate stopped 1 candidate(s) in this day"),
    ]);
  });

  it("...even when that stopped candidate cites a neighbouring message", () => {
    // Codex r3's other half: a control candidate misattributed away from
    // the probe leaves its own list empty, so a message-scoped check sees
    // a clean day while the record loses the fact.
    expect(
      probeMismatches(
        CONTROL,
        observed({
          outcome: "filed",
          crossed: [filed("OrderRequested")],
          day: { crossed: 4, dropped: [THE_PAST_ORDER] },
        }),
      ),
    ).toEqual([
      expect.stringContaining("the gate stopped 1 candidate(s) in this day"),
    ]);
  });
});
