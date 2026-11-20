/**
 * THE CORPUS IS WELL-FORMED, AND `CustomerPattern` IS FENCED ON PURPOSE
 * (ticket #56 ACs 1 and 5; ticket #61).
 *
 * A precision number is only as trustworthy as the labels it is scored
 * against, and labels are prose in a file — so the properties that keep
 * them honest are checked here rather than trusted:
 *
 * - EVERY MESSAGE IS ACCOUNTED FOR. Each is either labeled or claimed
 *   `silent` with a reason. A label deleted by accident would otherwise
 *   turn a true positive into a false positive and lower the number for a
 *   reason nobody could see.
 * - NO LABEL POINTS AT A MESSAGE THAT DOES NOT EXIST, and no message is
 *   both labeled and claimed silent.
 * - EVERY LABEL AND EVERY SILENCE CARRIES A REASON. An unexplained label
 *   cannot be argued with, and arguing with them is what review is.
 * - THE CORPUS IS SIZED for the ≥95% bar (`MIN_CROSSINGS_FOR_CONFIDENCE`).
 * - `CustomerPattern` IS PRESENT, FENCED, AND MEASURED APART (ticket #61).
 *   The three claims that recorded its absence inverted together, which is
 *   what #56 AC 5 built them for; what stands in their place is the set of
 *   properties that keep its labels honest — every one rests on words in
 *   the message it cites, quotes its transcript line, and cites FR-30 for
 *   which side of the wall it is on.
 */
import { FACT_AUTHORSHIP, FACT_TYPES } from "@dito/aperture";
import { describe, expect, it } from "vitest";
import {
  type SeedTranscript,
  corpusDigest,
  dayStartUtcOf,
  EXCLUDED_FACT_TYPES,
  PROSE_FIELDS,
  SOURCE_DESCRIPTIONS,
  STRUCTURED_FIELDS,
  MIN_CROSSINGS_FOR_CONFIDENCE,
  PRECISION_BAR,
} from "./corpus.ts";
import {
  DEFAULT_TRANSCRIPT_LIMIT,
  earliestWindowStart,
  renderTurnHeader,
  renderTurnInstant,
} from "@dito/twin-runtime";
import {
  DAY_START_UTC,
  EVAL_NOW,
  EVAL_TIME_ZONE,
  LAST_READABLE_MINUTE,
} from "./clock.ts";
import { LOOKING_TRANSCRIPTS, ORDINARY_TALK } from "./corpus/looking.ts";
import { ALL_TRANSCRIPTS, SEED_TRANSCRIPTS } from "./corpus/transcripts.ts";
// THE SCORER'S OWN FOLDING, imported rather than copied (ticket #61): a
// guard that claims to compare a token the way the scorer grades it has to
// use the scorer's function, or it silently stops doing so the day that
// function changes.
import { fold } from "./scoring.ts";

describe("every message is accounted for", () => {
  it.each(ALL_TRANSCRIPTS.map((t) => [t.id, t] as const))(
    "%s partitions its messages into labeled and silent",
    (_id, transcript) => {
      const messageIds = new Set(transcript.messages.map((m) => m.id));
      const labeled = new Set(transcript.labels.map((l) => l.messageId));
      const silent = new Set(transcript.silent.map((s) => s.messageId));

      for (const label of transcript.labels) {
        expect(
          messageIds.has(label.messageId),
          `label names ${label.messageId}, which is not a message in ${transcript.id}`,
        ).toBe(true);
      }
      for (const claim of transcript.silent) {
        expect(
          messageIds.has(claim.messageId),
          `silence names ${claim.messageId}, which is not a message in ${transcript.id}`,
        ).toBe(true);
      }
      for (const message of transcript.messages) {
        const isLabeled = labeled.has(message.id);
        const isSilent = silent.has(message.id);
        expect(
          isLabeled !== isSilent,
          isLabeled
            ? `${message.id} is both labeled and claimed silent — the corpus contradicts itself`
            : `${message.id} is neither labeled nor claimed silent: "${message.text}"`,
        ).toBe(true);
      }
    },
  );

  it("no transcript id repeats — the id is the scorer's join key", () => {
    const ids = ALL_TRANSCRIPTS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("no message id repeats within a transcript", () => {
    for (const transcript of ALL_TRANSCRIPTS) {
      const ids = transcript.messages.map((m) => m.id);
      expect(new Set(ids).size, `${transcript.id} repeats a message id`).toBe(
        ids.length,
      );
    }
  });

  it("no message id repeats ACROSS transcripts either", () => {
    // The seam dedupes on `(source, external_event_id)` composed as
    // `<chat jid>:<message id>` GLOBALLY across twins (ADR-0005). Two
    // transcripts sharing a message id would silently drop one insert and
    // score the run against a corpus that never landed.
    const seen = new Map<string, string>();
    for (const transcript of ALL_TRANSCRIPTS) {
      for (const message of transcript.messages) {
        const first = seen.get(message.id);
        expect(
          first,
          `${message.id} appears in both ${first} and ${transcript.id}`,
        ).toBeUndefined();
        seen.set(message.id, transcript.id);
      }
    }
  });

  it("every label and every silence carries a reason a reviewer can argue with", () => {
    for (const transcript of ALL_TRANSCRIPTS) {
      for (const label of transcript.labels) {
        expect(label.because.length, `${label.messageId}`).toBeGreaterThan(20);
      }
      for (const claim of transcript.silent) {
        expect(claim.because.length, `${claim.messageId}`).toBeGreaterThan(5);
      }
      expect(transcript.exercises.length).toBeGreaterThan(20);
    }
  });

  it("every label pins EVERY structured field its fact type carries", () => {
    // Codex round 2, and it is the sharpest finding the corpus has had.
    // `firstFailure` judges only the predicates a label lists, so a label
    // that pins `amount` and says nothing about `quantity` accepts an
    // invented quantity — and a label with NO checks accepts any
    // aperture-valid payload at all. Two labels had `checks: []`, so an
    // order for «100 helicopters, 999, USD 123456» would have scored as a
    // true positive and INFLATED the number.
    //
    // The rule: a structured field is pinned to a value the transcript
    // states, or to `absent`. Prose the model authors — item, unit,
    // commitment, contactName, role — stays ungraded, which is this
    // corpus's stated policy and the reason this list is not "every field".
    for (const transcript of ALL_TRANSCRIPTS) {
      for (const label of transcript.labels) {
        const pinned = new Set(label.checks.map((c) => c.path));
        const structured = STRUCTURED_FIELDS[label.factType];
        expect(
          structured,
          `${label.factType} has no entry in STRUCTURED_FIELDS — a new fact type must say which of its fields carry numbers or identifiers before it can be graded`,
        ).toBeDefined();
        for (const field of structured ?? []) {
          expect(
            pinned.has(field),
            `${transcript.id} / ${label.messageId} / ${label.factType} says nothing about "${field}" — an invented one would score as correct`,
          ).toBe(true);
        }
      }
    }
  });

  it("no label lets the wrong side of the conversation author a fact", () => {
    // THE AUTHORSHIP FENCE, checked against the corpus (ADR-0038, ticket
    // #71; the guard itself is #59's).
    //
    // ADR-0038 rests part of its case on the corpus: "all 89 human labels
    // put every quote and every promise on a rep message and every order
    // on the customer's, without ever having been told to". That was true
    // when it was written and nothing held it true afterwards — so a label
    // added later could put «Le cotizaste …» on a CUSTOMER's message, and
    // the aperture would refuse the crossing while the corpus went on
    // counting it as a missed fact. The answer sheet would be asserting a
    // reading the system is built to refuse, and recall would fall for a
    // reason nobody could see.
    //
    // Diego's ruling is the sharp form of it, 2026-08-30: «if the customer
    // said "me dijiste que eran 4500 el otro día" that is not a
    // QuoteGiven. A customer shouldn't be able to create a quote, that is
    // only a rep side action.» Quoting is a rep-side ACT. The same holds
    // for a promise and for taking an order; `OrderRequested` is the
    // counterparty's; `ContactEstablished` names no actor and is fenced to
    // neither.
    //
    // FACT_AUTHORSHIP is imported rather than restated, so the corpus
    // cannot drift from the table the aperture actually enforces.
    for (const transcript of ALL_TRANSCRIPTS) {
      for (const label of transcript.labels) {
        const message = transcript.messages.find(
          (m) => m.id === label.messageId,
        );
        if (message === undefined) continue; // the missing-message test owns this
        const required = FACT_AUTHORSHIP[label.factType];
        expect(
          required,
          `${label.factType} has no entry in FACT_AUTHORSHIP`,
        ).toBeDefined();
        if (required === "either") continue;
        expect(
          message.fromMe,
          `${transcript.id} / ${label.messageId} labels ${label.factType}, which is ${required}-authored, on a message the ${message.fromMe ? "rep" : "counterparty"} sent — the aperture refuses that crossing, so the label can never be satisfied`,
        ).toBe(required === "rep");
      }
    }
  });

  it("no label is ungradeable — a zero-check label accepts anything", () => {
    for (const transcript of ALL_TRANSCRIPTS) {
      for (const label of transcript.labels) {
        expect(
          label.checks.length,
          `${transcript.id} / ${label.messageId} has no checks`,
        ).toBeGreaterThan(0);
      }
    }
  });

  it("every label's checks name a path and one assertion", () => {
    for (const transcript of ALL_TRANSCRIPTS) {
      for (const label of transcript.labels) {
        for (const check of label.checks) {
          expect(check.path.length).toBeGreaterThan(0);
          const shapes = [
            "equals",
            "equalsAll",
            "absentOrEquals",
            "contains",
            "lacks",
            "absent",
          ].filter(
            (k) => k in check,
          );
          expect(shapes, `${label.messageId} ${check.path}`).toHaveLength(1);
        }
      }
    }
  });

  it("messages are in chronological order within their day", () => {
    for (const transcript of ALL_TRANSCRIPTS) {
      const minutes = transcript.messages.map((m) => m.atMinute);
      expect(
        [...minutes].sort((a, b) => a - b),
        `${transcript.id} is out of order`,
      ).toEqual(minutes);
      // ...and inside the window THE PASS ACTUALLY READS, which is not the
      // civil day (Codex r1): extraction is triggered at 21:30 and cuts a
      // minute short of its own clock. A message after that is seeded, never
      // read, and never scored — while the report goes on claiming it in
      // its message count. This is the check that makes that count a true
      // statement about what the model saw.
      //
      // The FLOOR is this transcript's own window (ticket #139), off the
      // same `dayStartUtcOf` the harness places its beats with — and the
      // pass will not look further back than seven days, beyond which the
      // beats are seeded, never read, and never scored: the same silent
      // loss, at the other end of the day.
      const earliestMinute =
        (dayStartUtcOf(transcript) - DAY_START_UTC) / 60_000;
      expect(
        dayStartUtcOf(transcript),
        `${transcript.id} is carried in from further back than the pass ever reads`,
      ).toBeGreaterThanOrEqual(
        earliestWindowStart(new Date(DAY_START_UTC)).getTime(),
      );
      for (const minute of minutes) {
        expect(
          minute,
          `${transcript.id} has a message at minute ${minute}, before its own window opens (${earliestMinute})`,
        ).toBeGreaterThanOrEqual(earliestMinute);
        expect(
          minute,
          `${transcript.id} has a message at minute ${minute}, after the last minute the pass reads (${LAST_READABLE_MINUTE})`,
        ).toBeLessThanOrEqual(LAST_READABLE_MINUTE);
      }
    }
  });
});

/**
 * THE DAY THE CORPUS IS SAID ON (ticket #121).
 *
 * Every relative-weekday label here — «el jueves» is the 3rd, «el lunes»
 * the 7th, «el martes» the 8th — is arithmetic off ONE rep day, and that
 * day is `clock.ts`'s, not anything written in `transcripts.ts`. Move
 * `DAY_START_UTC` or `EVAL_TIME_ZONE` and ten expectations become wrong
 * with nothing in the unit lane to say so.
 *
 * IT ASSERTS THE STRING THE MODEL IS SHOWN, not the date, and that is the
 * point: the header is what the pass actually puts at the top of the turn
 * (`renderTurnHeader`), so this binds the labels to the thing the model
 * reads rather than to a second copy of the calendar. The expectation is a
 * literal read off a calendar — 1 September 2026 is a Tuesday — never
 * recomputed here. It is ENGLISH METADATA since #139's second ruling; the
 * labels below are still read in Spanish, because they grade what a
 * PERSON says in the transcript.
 */
describe("the corpus's own rep day (#121)", () => {
  it("is the Tuesday every relative weekday in the corpus is counted from", () => {
    expect(renderTurnHeader(EVAL_NOW, EVAL_TIME_ZONE)).toBe(
      "[Now: Tuesday, Sep 1, 2026, 21:30:00 CST (America/Monterrey)]",
    );
  });

  /**
   * ...AND THE DAY EACH HELD-OUT BEAT IS SAID ON (ticket #139), for the
   * same reason and by the same means: «el lunes is the 31st» is only true
   * of a line the model reads as Sunday's. It asserts the STAMP the pass
   * renders, so moving a carried-in day's minutes fails here rather than
   * quietly changing what those two labels mean.
   *
   * Both expectations are literals: 30 August 2026 is a Sunday, and H2-01
   * at 20:25 on the rep's clock is 02:25 the MONDAY in UTC — the crossing
   * that used to make «el lunes» look like the day it was said on.
   */
  it("says the two carried-in days were said on the Sunday, not on the corpus day", () => {
    const stampOf = (transcriptId: string, messageId: string): string => {
      const day = ALL_TRANSCRIPTS.find((t) => t.id === transcriptId)!;
      const beat = day.messages.find((m) => m.id === messageId)!;
      return renderTurnInstant(
        new Date(DAY_START_UTC + beat.atMinute * 60_000),
        EVAL_TIME_ZONE,
      );
    };
    expect(stampOf("d-domingo-en-domingo", "H1-01")).toBe(
      "Sunday, Aug 30, 2026, 12:40:00 CST",
    );
    expect(stampOf("d-lunes-desde-el-domingo", "H2-01")).toBe(
      "Sunday, Aug 30, 2026, 20:25:00 CST",
    );
  });
});

/**
 * THE TWO EDGES OF #83's RULING, held by the corpus rather than by memory.
 *
 * Diego ruled on 2026-08-30 that «necesito X», «ocupo X» and «quiero X»
 * from a customer is an `OrderRequested` — «these sound more like requests
 * as the customer would not say it needs something to the rep if he doesnt
 * want that order». That widened which PHRASINGS count as asking to be
 * sent something, and a widening has two ways to go wrong that nothing
 * else in this file would see: it can swallow a price enquiry, and it can
 * be applied to some days and not others.
 *
 * Neither guard restates the domain rule. Each is a claim ABOUT THIS
 * CORPUS that the corpus can contradict, which is what makes it worth
 * running: relabel Q5-01 and the first goes red, add a «necesito …» day
 * and leave it unclassified and the second does.
 */
describe("asking to be SENT something is not asking what it COSTS (#83)", () => {
  // The two vocabularies, written once. Accents are optional in the
  // patterns rather than folded away, because these match the corpus's own
  // authored es-MX text and not a model's output — the scorer's `fold` is
  // for the latter.
  //
  // WORD BOUNDARIES ARE LOAD-BEARING, not tidiness (Codex r2). The first cut
  // used bare substrings and caught two messages that ask no price at all:
  // «déjeme ver cuántos ocupo» through `cuánto`, and «atrasada como siempre»
  // through `a cómo`. That is worse than a miss — a guard that calls a
  // request a price enquiry would forbid a correct `OrderRequested` on a
  // future «quiero varilla como siempre», and pressure the next author into
  // suppressing a true label to get the suite green. `cu[áa]nto\b` excludes
  // the PLURAL «cuántos», which asks how many rather than how much.
  const PRICE_ENQUIRY = /cotiz|precio|\bcu[áa]nto\b|\ba c[óo]mo\b/u;
  const A_STATED_NEED =
    /\b(necesito|necesitamos|ocupo|ocupamos|quiero|queremos)\b|me hacen? falta|me urge/u;

  /**
   * WHAT THE RULING ACTUALLY LABELLED — the ticket's own table, plus the one
   * message the sweep found, as pinned quantities.
   *
   * It duplicates the corpus deliberately, because that is what an answer
   * key is for (Codex r2). `B2-01` and `BD-02` each carry TWO labels, and a
   * guard that is satisfied by finding ONE would stay green while the
   * mortar half or the bultos half quietly disappeared — which is precisely
   * the unmet-demand fact the ruling exists to record, and the corpus's own
   * partition test cannot see it go, because the message stays labelled.
   * Changing a row here means re-arguing the ruling, which is the point.
   */
  const THE_RULING_LABELLED: ReadonlyArray<readonly [string, readonly number[]]> =
    [
      ["Q2-01", [200]],
      ["B2-01", [15, 300]],
      ["B6-01", [100]],
      ["BD-02", [40, 150]],
    ];

  const counterpartyMessages = ALL_TRANSCRIPTS.flatMap((transcript) =>
    transcript.messages
      .filter((message) => !message.fromMe)
      .map((message) => ({ transcript, message })),
  );

  /** The `OrderRequested` labels on one message — the walk both guards make. */
  const ordersOn = (transcript: SeedTranscript, messageId: string) =>
    transcript.labels.filter(
      (l) => l.messageId === messageId && l.factType === "OrderRequested",
    );

  it("no message that asks a price is labeled an order request", () => {
    // THE LINE THAT HAD TO SURVIVE #83. Q5-01 «¿me cotiza 45 rollos de
    // alambre recocido?» names the goods and the quantity exactly and is
    // still a request for a NUMBER: «Te pidió 45 rollos» about it would be
    // a false sentence, on a day where the ask is Q5-03. B9-01 «necesito
    // precio de lámina y de solera» is the same distinction with the
    // ruling's own verb in front of it, which is why both are named here.
    //
    // A message CAN carry both acts — «¿en cuánto me deja 40 bultos y
    // mándemelos mañana?» — and the extraction prompt says so. No day in
    // this corpus does, so this guard has no exception list; the first one
    // that does will fail here, and whoever adds it argues for it then.
    const enquiries = counterpartyMessages.filter(({ message }) =>
      PRICE_ENQUIRY.test(message.text.toLowerCase()),
    );
    const named = new Set(enquiries.map(({ message }) => message.id));
    expect(named.has("Q5-01"), "Q5-01 is the price-enquiry case").toBe(true);
    expect(named.has("B9-01"), "B9-01 is «necesito» in front of a price").toBe(
      true,
    );
    // ...and the two the first cut caught by accident. A price enquiry is a
    // message asking what something COSTS; «cuántos ocupo» asks how many,
    // and «atrasada como siempre» is small talk about a building site.
    expect(named.has("Q3-03"), "«cuántos ocupo» asks how many, not how much").toBe(
      false,
    );
    expect(named.has("BI-03"), "«atrasada como siempre» is small talk").toBe(
      false,
    );
    // WHAT THIS GUARD CANNOT SEE, said here rather than left to be assumed
    // (Codex r3). The pattern finds fifteen messages, and two more ask a
    // price ELLIPTICALLY, with no price word in them at all: B1-03 «¿y si le
    // subo a 50?» and BF-03 «¿y 70?», each answered by a fresh quote. No
    // pattern reaches those; only their own `silent` reasons do. They are
    // exactly as exposed as they were before #83, which is why this ticket
    // does not build the explicit answer key that would cover them — that is
    // a corpus-wide guard, on its own ticket, and it is recorded there.
    //
    // The floor is non-vacuity: what the pattern must not be narrowed past,
    // not a count of anything. A regex edited down to the two named above
    // would still satisfy both `has` assertions while checking almost
    // nothing.
    expect(enquiries.length).toBeGreaterThanOrEqual(10);

    for (const { transcript, message } of enquiries) {
      expect(
        ordersOn(transcript, message.id),
        `${transcript.id} / ${message.id} asks what something costs and is labeled OrderRequested: "${message.text}"`,
      ).toEqual([]);
    }
  });

  it("every stated need is classified against the ruling, one way or the other", () => {
    // THE SWEEP, kept from going stale. #83's licence is narrow and its
    // whole risk is a PARTIAL relabel: an instrument that reads «necesito
    // 200 varillas» as an order in one day and as nothing in another is
    // worse than one that reads it consistently either way. So a
    // counterparty message carrying one of the ruling's verbs is either
    // labeled `OrderRequested`, or its silence says why the ruling does not
    // reach it — B9-01 a price, D2-01 a need to KNOW, Q3-03 a customer who
    // has not worked out how many. The rep's own «necesito RFC, correo y un
    // teléfono fijo» (B5-01) is out of scope rather than exempted:
    // `OrderRequested` is counterparty-authored (ADR-0038), so the aperture
    // refuses that crossing whatever the words say.
    //
    // THIS IS THE ONE PLACE CODE READS A `because`, and `corpus.ts` says
    // that prose is «for the reviewer reading the corpus rather than for any
    // code» — which is why `corpusDigest` leaves it out, so sharpening an
    // argument never forces a re-run. The exception is deliberate and
    // narrow: what is being checked is not the content of the reason but
    // that the reason ANSWERS THE RULING, and there is nowhere else for that
    // answer to live. The cost is that rewriting one of these four silences
    // without the citation turns this suite red for a reason the measurement
    // does not share; that friction is the point.
    const stated = counterpartyMessages.filter(({ message }) =>
      A_STATED_NEED.test(message.text.toLowerCase()),
    );
    // NON-VACUITY again: seven is what the corpus states today, so the floor
    // fails on a pattern narrowed rather than on a transcript added. (The
    // seven are Q2-01, Q3-03, D2-01, B2-01, B6-01, B9-01 and BD-02 — four
    // labelled by the ruling, three answering it in their silence.)
    expect(stated.length).toBeGreaterThanOrEqual(7);

    for (const { transcript, message } of stated) {
      if (ordersOn(transcript, message.id).length > 0) continue;
      const claim = transcript.silent.find((s) => s.messageId === message.id);
      expect(
        claim?.because,
        `${transcript.id} / ${message.id} states a need and is neither labeled OrderRequested nor claimed silent: "${message.text}"`,
      ).toBeDefined();
      expect(
        claim?.because.includes("#83"),
        `${transcript.id} / ${message.id} is left silent under a ruling it does not answer — its reason must say why #83 does not reach it: "${message.text}"`,
      ).toBe(true);
    }
  });

  it("the ruled messages carry EVERY label the ruling gave them, each quoting its line", () => {
    // The other half of the sweep guard, and the half a one-label test
    // misses. It also enforces #83's own standard for the labels it added:
    // «every label you add or change must quote the transcript line and cite
    // this ruling in its `because`». A label bent to agree with the code,
    // without that, is the corruption this corpus exists to prevent — #56
    // found two of them — and prose is the only place the argument can live.
    for (const [messageId, quantities] of THE_RULING_LABELLED) {
      const found = counterpartyMessages.find(
        ({ message }) => message.id === messageId,
      );
      expect(found, `${messageId} is not a counterparty message`).toBeDefined();
      const { transcript, message } = found!;

      const orders = ordersOn(transcript, messageId);
      const pinned = orders
        .flatMap((label) =>
          label.checks.filter(
            (c) => c.path === "quantity" && "equals" in c,
          ),
        )
        .map((c) => (c as { equals: number }).equals)
        .sort((a, b) => a - b);
      expect(
        pinned,
        `${messageId} should carry an OrderRequested for each good the ruling read in it: "${message.text}"`,
      ).toEqual([...quantities]);

      for (const label of orders) {
        expect(
          label.because.includes(message.text),
          `${messageId}'s label must QUOTE its transcript line verbatim`,
        ).toBe(true);
        expect(
          label.because.includes("#83"),
          `${messageId}'s label must CITE the ruling it rests on`,
        ).toBe(true);
      }
    }
  });
});

describe("the corpus is sized for the bar it reports against", () => {
  it("carries at least MIN_CROSSINGS_FOR_CONFIDENCE labels", () => {
    // Labels, not crossings: the RUN reports what actually crossed and says
    // so when it comes in short. What the corpus can promise is that it
    // OFFERS enough — a corpus with 20 labels could never reach 80
    // crossings however well the extractor did.
    const labels = ALL_TRANSCRIPTS.flatMap((t) => t.labels);
    expect(labels.length).toBeGreaterThanOrEqual(MIN_CROSSINGS_FOR_CONFIDENCE);
  });

  it("spreads them across every fact type, so a per-type number is possible", () => {
    // AC 4 asks for precision PER FACT TYPE. A type with two labels has a
    // per-type number that is noise; ten is not much, and it is what makes
    // the row worth printing at all.
    for (const factType of FACT_TYPES) {
      const n = ALL_TRANSCRIPTS.flatMap((t) => t.labels).filter(
        (l) => l.factType === factType,
      ).length;
      expect(n, `only ${n} labels for ${factType}`).toBeGreaterThanOrEqual(10);
    }
  });

  it("carries days that state NOTHING — the false-positive half of precision", () => {
    // A corpus of only fact-bearing days measures whether the extractor
    // finds facts. Precision is about what it files when there is nothing
    // to find, which needs days with no labels at all.
    const empty = ALL_TRANSCRIPTS.filter((t) => t.labels.length === 0);
    expect(empty.length).toBeGreaterThanOrEqual(4);
  });

  it("records the bar without enforcing it", () => {
    expect(PRECISION_BAR).toBe(0.95);
  });
});

describe("CustomerPattern is present, fenced, and measured apart (#61)", () => {
  /**
   * THE THREE CLAIMS #56 AC 5 WROTE INVERTED TOGETHER, exactly as it
   * intended. `CustomerPattern` is in `FACT_TYPES`, its labels are in the
   * corpus, and the exclusion manifest is empty — and the manifest's
   * emptiness is asserted as a LIVE claim rather than left as a vacuous
   * loop, because a `for` over an empty object passes whatever it contains.
   */
  const patterns = ALL_TRANSCRIPTS.flatMap((transcript) =>
    transcript.labels
      .filter((label) => label.factType === "CustomerPattern")
      .map((label) => ({ transcript, label })),
  );

  /** The message a label names, with the transcript it lives in. */
  const messageFor = (transcript: SeedTranscript, messageId: string) =>
    transcript.messages.find((m) => m.id === messageId);

  const silenceFor = (transcriptId: string, messageId: string) => {
    const transcript = ALL_TRANSCRIPTS.find((t) => t.id === transcriptId);
    expect(transcript, transcriptId).toBeDefined();
    const claim = transcript!.silent.find((s) => s.messageId === messageId);
    expect(claim, `${transcriptId} / ${messageId} is not claimed silent`).toBeDefined();
    return { transcript: transcript!, claim: claim! };
  };

  it("is a fact type the aperture files, and the corpus labels it", () => {
    expect([...FACT_TYPES]).toContain("CustomerPattern");
    // The per-type floor is enforced above for every type; this says the
    // labels are actually here, so the two claims cannot be satisfied by
    // a type that exists and is never exercised.
    expect(patterns.length).toBeGreaterThanOrEqual(10);
  });

  it("nothing is excluded any more, and an empty manifest is a claim rather than a vacancy", () => {
    // The old entry's own words: it joins "with its own labels and — this
    // is the part that must not be skipped — its own reported number beside
    // the others, never folded in". Both halves are now somebody's test:
    // the labels are the line above, the number is `report.test.ts`.
    expect(Object.keys(EXCLUDED_FACT_TYPES)).toEqual([]);
    // ...and the emptiness means what it says. A manifest that listed
    // nothing while some type went unlabelled would report "everything is
    // measured" over a hole, which is the failure AC 5 exists to prevent —
    // so every type the aperture files is either labelled here or named
    // there, with no third state.
    for (const factType of FACT_TYPES) {
      const labelled = ALL_TRANSCRIPTS.some((t) =>
        t.labels.some((l) => l.factType === factType),
      );
      expect(
        labelled || factType in EXCLUDED_FACT_TYPES,
        `${factType} is neither labelled in the corpus nor named in EXCLUDED_FACT_TYPES — the number would silently not cover it`,
      ).toBe(true);
    }
  });

  it("every CustomerPattern rests on words in the message it cites — a cadence nobody said cannot be labelled here", () => {
    // THE GUARD THAT MAKES "ONE MESSAGE" A PROPERTY OF THE CORPUS rather
    // than a sentence in a docblock (ticket #61's design question).
    //
    // A pattern is a claim about REPETITION while every other fact type is
    // a claim about one message, and what ships is the narrow reading: a
    // regularity the CUSTOMER STATED, in the words of the message the fact
    // cites. This is what that costs an author. Every label pins `pattern`
    // with a `contains`, and the token it pins must appear in the labelled
    // message's own text — so a label for an ORDER CADENCE worked out by
    // counting requests is unwritable, because there is no message whose
    // words contain it. Ticket #83's double-count («a customer asking at the
    // outset and again after the price files TWO requests») cannot reach
    // this corpus through a label.
    //
    // It is also the anti-tautology guard. The token comes off the
    // transcript, not off whatever the extractor happened to produce, so a
    // label bent to agree with the code fails here rather than passing
    // quietly.
    expect(patterns.length).toBeGreaterThan(0);
    for (const { transcript, label } of patterns) {
      const message = messageFor(transcript, label.messageId);
      expect(message, `${label.messageId}`).toBeDefined();
      const pinned = label.checks.filter(
        (c) => c.path === "pattern" && "contains" in c,
      ) as { path: string; contains: string }[];
      expect(
        pinned.length,
        `${transcript.id} / ${label.messageId} must pin \`pattern\` with a \`contains\` — an unpinned prose field accepts any sentence at all`,
      ).toBe(1);
      const token = fold(pinned[0]!.contains);
      expect(token.length).toBeGreaterThan(0);
      expect(
        fold(message!.text).includes(token),
        `${transcript.id} / ${label.messageId} pins "${pinned[0]!.contains}", which is not in the message it labels: "${message!.text}" — a CustomerPattern rests on the words of ONE message, never on a repetition somebody counted`,
      ).toBe(true);
    }
  });

  it("a day that states something forbidden pins EVERY pattern on it against that day's own words", () => {
    // CODEX ROUND 3, and it is the sharpest finding this ticket had. The
    // rule was written down — "on the days that carry prohibited content
    // beside a real pattern, the label pins both sides" — and three labels
    // did not follow it, on days that plainly do. No paraphrase was needed:
    // `PF-01` states «este cliente siempre regatea, hay que dejarle margen»
    // in the rep's own message, and a clause reading «solo recibe por la
    // mañana; este cliente siempre regatea» keeps `PF-04`'s pinned token,
    // crosses, and scores CORRECT while a rep tactic reaches the employer.
    // The per-type row stays 100% over a breach, which is the one thing it
    // exists not to do.
    //
    // So the rule is machine-checked rather than swept by hand. A day whose
    // SILENCES cite FR-30 or FR-32 is a day stating something a pattern
    // must not have picked up, and every `CustomerPattern` label on it
    // carries at least one `lacks` — whose token must come out of one of
    // those forbidden messages, never out of a vocabulary somebody
    // invented. That second half is what keeps this a claim about this
    // corpus rather than a lint, and it is why the guard cannot be
    // satisfied by pinning a word at random.
    for (const transcript of ALL_TRANSCRIPTS) {
      const patternsHere = transcript.labels.filter(
        (l) => l.factType === "CustomerPattern",
      );
      if (patternsHere.length === 0) continue;
      const forbidden = transcript.silent.filter(
        (claim) =>
          claim.because.includes("FR-30") || claim.because.includes("FR-32"),
      );
      if (forbidden.length === 0) continue;
      const forbiddenText = forbidden
        .map((claim) =>
          fold(
            transcript.messages.find((m) => m.id === claim.messageId)?.text ??
              "",
          ),
        )
        .join(" \u0000 ");
      for (const label of patternsHere) {
        const pins = label.checks.filter(
          (c) => c.path === "pattern" && "lacks" in c,
        ) as { path: string; lacks: string }[];
        expect(
          pins.length,
          `${transcript.id} / ${label.messageId} states a pattern on a day that also states something FR-30 or FR-32 keeps out (${forbidden.map((f) => f.messageId).join(", ")}), and pins nothing against it — a clause carrying both scores CORRECT`,
        ).toBeGreaterThan(0);
        for (const pin of pins) {
          expect(
            forbiddenText.includes(fold(pin.lacks)),
            `${transcript.id} / ${label.messageId} pins lacks "${pin.lacks}", which is in none of this day's forbidden messages — a token off the transcript is a claim, a token off nowhere is a lint`,
          ).toBe(true);
        }
      }
    }
  });

  it("every CustomerPattern label quotes its transcript line and says why FR-30 puts it on this side of the wall", () => {
    // #83's standard, applied to the type that needs it most. This is the
    // one type whose false positives are BREACHES rather than noise, and
    // the corpus is what grades them — so a label written from what the
    // extractor happens to do would make the aperture test decorative. The
    // quotation is the evidence that a human read the line; the FR-30
    // citation is the evidence they decided which side of the wall it is
    // on, rather than noticing that it looked like a pattern.
    for (const { transcript, label } of patterns) {
      const message = messageFor(transcript, label.messageId);
      expect(
        label.because.includes(message!.text),
        `${transcript.id} / ${label.messageId} must QUOTE its transcript line verbatim`,
      ).toBe(true);
      expect(
        label.because.includes("FR-30"),
        `${transcript.id} / ${label.messageId} must CITE FR-30 — what makes this a CustomerPattern and not a judgment about the rep is a rule, not a vibe`,
      ).toBe(true);
    }
  });

  it("a regularity about the REP is labelled silent even when the CUSTOMER says it — the case no fence reaches", () => {
    // THE APERTURE BREACH THE AUTHORSHIP FENCE CANNOT CATCH, named by id so
    // it cannot be quietly deleted. `PC-01` and `PC-03` are
    // counterparty-authored and standing, so ADR-0038's fence passes them
    // both; the only thing keeping them out of the rep's employer's Ledger
    // is the extractor. If either ever gains a label, this corpus has
    // stopped being able to measure the failure it was extended for.
    for (const messageId of ["PC-01", "PC-03"]) {
      const { transcript, claim } = silenceFor("p-juicios-sobre-el-rep", messageId);
      const message = messageFor(transcript, messageId);
      expect(message, messageId).toBeDefined();
      expect(
        message!.fromMe,
        `${messageId} must be the CUSTOMER's message — a rep-authored one is refused by the aperture, and this test is about the case that is not`,
      ).toBe(false);
      expect(
        claim.because.includes(message!.text),
        `${messageId}'s silence must QUOTE its transcript line`,
      ).toBe(true);
      expect(
        claim.because.includes("FR-30"),
        `${messageId}'s silence must CITE FR-30's excluded class`,
      ).toBe(true);
    }
    // ...and the same day carries a real one, so the day cannot be
    // satisfied by an extractor that simply never files this type here.
    expect(
      patterns.filter((p) => p.transcript.id === "p-juicios-sobre-el-rep"),
    ).toHaveLength(1);
  });

  it("a rep's own tactic or judgment stays silent, and is rep-authored so the fence covers it too", () => {
    // The class that WAS the whole of this corpus's CustomerPattern
    // material before #61, kept and re-pointed. These cost a REFUSAL rather
    // than a crossing now, which is a strictly better ending and a strictly
    // weaker measurement — hence the customer-authored pair above.
    const repSide: ReadonlyArray<readonly [string, string]> = [
      ["n-tácticas-del-rep", "N2-01"],
      ["n-tácticas-del-rep", "N2-02"],
      ["b-dia-completo-aguilar", "B3-01"],
      ["b-dia-completo-mixto", "BE-01"],
      ["p-condiciones-medina", "PF-01"],
    ];
    for (const [transcriptId, messageId] of repSide) {
      const { transcript } = silenceFor(transcriptId, messageId);
      const message = messageFor(transcript, messageId);
      expect(message?.fromMe, `${messageId} must be rep-authored`).toBe(true);
      expect(
        transcript.labels.some((l) => l.messageId === messageId),
        `${messageId} must carry no label at all`,
      ).toBe(false);
    }
  });

  it("a market- or season-level observation is silent, and the same season said about the customer is a fact", () => {
    // THE ORPHAN RULE, MEASURABLE (FR-32, ADR-0035). `PD-01` is ADR-0035's
    // own example — "December is slow for construction" — and it has no
    // entity: filing it against this cliente would claim they said
    // something about their own buying when they said something about the
    // trade. `PD-02` is the same December said about themselves and files a
    // fact. The pair is what stops the rule being satisfiable by silence:
    // an extractor that files nothing on this day scores no breach and no
    // fact either.
    const { transcript, claim } = silenceFor("p-mercado-y-temporada", "PD-01");
    expect(claim.because).toContain("FR-32");
    expect(claim.because).toContain("no entity");
    expect(
      transcript.labels.filter((l) => l.messageId === "PD-01"),
      "PD-01 has no entity to attach to, so it can carry no fact of any type",
    ).toEqual([]);
    expect(
      transcript.labels.some(
        (l) => l.messageId === "PD-02" && l.factType === "CustomerPattern",
      ),
      "PD-02 is the same season said about the customer, and it must be a fact",
    ).toBe(true);
  });

  it("a day where the customer asks twice states two orders and no pattern (#83)", () => {
    // #83 made `OrderRequested` denser and flagged the consequence for this
    // ticket by name: a customer who asks at the outset and again after the
    // price files TWO requests, so a cadence built by counting requests
    // double-counts a single want. Nothing here counts anything — but the
    // corpus has to be able to catch an extractor that does, which means a
    // day whose whole content is the repetition.
    const day = ALL_TRANSCRIPTS.find(
      (t) => t.id === "p-dos-veces-no-es-costumbre",
    );
    expect(day, "the double-count day is gone").toBeDefined();
    expect(day!.exercises).toContain("#83");
    expect(
      day!.labels.filter((l) => l.factType === "OrderRequested").length,
      "the day must actually contain the repetition it is about",
    ).toBeGreaterThanOrEqual(2);
    expect(
      day!.labels.filter((l) => l.factType === "CustomerPattern"),
      "asking twice in one day states nothing standing — a CustomerPattern here is a repetition the extractor invented",
    ).toEqual([]);
  });
});

/**
 * THE LOOKING CASES (ticket #199; spec #193 decisions 11 and 12).
 *
 * Four days whose facts cannot be read off the day at all: the value the
 * record would carry is in an EARLIER day, and the only way to it is the
 * search. What keeps them honest is different from what keeps the original
 * days honest, so it is checked here rather than assumed:
 *
 * - THE HISTORY IS OUT OF SIGHT. `recentTranscriptFor` shows the model the
 *   twenty lines before the window, so a referent inside those twenty is
 *   resolvable without a tool and the case would measure the context recipe
 *   instead of the reads.
 * - THE HISTORY IS NOT THE DAY. Its beats are strictly earlier than the
 *   window, carry no label and no silence, and are never cited.
 * - THE REFERENT NEVER REACHES WHAT IS FILED. Every prose field a looking
 *   label's fact type carries is pinned with a `lacks` off this corpus's own
 *   words — `PROSE_FIELDS` argues why the leak is measured and not fenced.
 */
describe("the looking cases (#199)", () => {
  it("is four days, and every one of them carries history", () => {
    expect(LOOKING_TRANSCRIPTS).toHaveLength(4);
    for (const transcript of LOOKING_TRANSCRIPTS) {
      expect(
        transcript.history ?? [],
        `${transcript.id} carries no history — a looking case with nothing earlier to find measures nothing`,
      ).not.toHaveLength(0);
    }
  });

  it("keeps every history beat before its own window, in order", () => {
    // The pass reads the seam from the window's start; twin memory holds
    // everything strictly before it under the "already handled" heading. A
    // history beat inside the window would be a day message the corpus's own
    // partition does not account for.
    for (const transcript of ALL_TRANSCRIPTS) {
      const windowStart = dayStartUtcOf(transcript);
      const minutes = (transcript.history ?? []).map((m) => m.atMinute);
      expect(
        [...minutes].sort((a, b) => a - b),
        `${transcript.id}'s history is out of order`,
      ).toEqual(minutes);
      for (const minute of minutes) {
        expect(
          DAY_START_UTC + minute * 60_000,
          `${transcript.id} has a history beat at minute ${minute}, inside the window it is read over`,
        ).toBeLessThan(windowStart);
      }
    }
  });

  it("shows the model NOTHING but ordinary talk, so only a search reaches a referent", () => {
    // THE PROPERTY THAT MAKES THESE CASES MEASURE THE READS. The extraction
    // is shown the last `DEFAULT_TRANSCRIPT_LIMIT` lines before the window as
    // context it may not cite; a referent among them is resolvable with no
    // tool call at all, and the looking row would then be a number about the
    // context recipe.
    //
    // THE LENGTH ALONE CANNOT SAY THAT (spec review): a history longer than
    // the limit with a filler PREPENDED puts the referent back inside the
    // twenty. So what is checked is what the model is actually shown — every
    // beat in the visible window is one of `ORDINARY_TALK`'s lines, which
    // name no goods, no quantity and no price.
    const talk = new Set(ORDINARY_TALK.map(([, text]) => text));
    for (const transcript of LOOKING_TRANSCRIPTS) {
      const history = transcript.history ?? [];
      expect(
        history.length,
        `${transcript.id}'s history is ${history.length} lines, so its oldest beat is inside the ${DEFAULT_TRANSCRIPT_LIMIT} the model is shown`,
      ).toBeGreaterThan(DEFAULT_TRANSCRIPT_LIMIT);
      for (const beat of history.slice(-DEFAULT_TRANSCRIPT_LIMIT)) {
        expect(
          talk.has(beat.text),
          `${transcript.id} shows the model "${beat.text}" as recent context — a referent inside the visible window is resolvable with no tool call, and the case would measure the recipe instead of the reads`,
        ).toBe(true);
      }
    }
  });

  it("labels and silences name day messages only — history is never either", () => {
    for (const transcript of ALL_TRANSCRIPTS) {
      const historyIds = new Set((transcript.history ?? []).map((m) => m.id));
      for (const label of transcript.labels) {
        expect(
          historyIds.has(label.messageId),
          `${transcript.id} labels ${label.messageId}, which is a history beat — a fact is read in the day's own message (ADR-0038)`,
        ).toBe(false);
      }
      for (const claim of transcript.silent) {
        expect(historyIds.has(claim.messageId), claim.messageId).toBe(false);
      }
    }
  });

  it("gives every history beat an id of its own, corpus-wide", () => {
    // The bundle keys a message on (chat, message id) and the seam on
    // `<chat jid>:<message id>`, so a repeat would silently resolve to one
    // stored row — a history line that never landed, and a search that finds
    // nothing for a reason no assertion could see.
    const seen = new Map<string, string>();
    for (const transcript of ALL_TRANSCRIPTS) {
      for (const message of [...transcript.messages, ...(transcript.history ?? [])]) {
        expect(
          seen.get(message.id),
          `${message.id} appears twice in the corpus`,
        ).toBeUndefined();
        seen.set(message.id, transcript.id);
      }
    }
  });

  it("declares what every looking day may never file, off this corpus's own words", () => {
    // THE LEAK IS MEASURED AND NOT FENCED, for the reason `PROSE_FIELDS`
    // gives — and the declaration is the DAY's, because the two days that must
    // file nothing have no labels to carry a check and a crossing of an
    // unlabelled type runs none (Codex r1). What keeps the declaration honest
    // is where its tokens come from: a whole word of a customer this corpus
    // names, a phrase out of the day or its history, or one of the two words
    // `SOURCE_DESCRIPTIONS` argues for. A bare substring would let a token
    // like "a" satisfy the guard while pinning nothing.
    //
    // WORDS, not whole names: «Ochoa» is what identifies Ferretería Ochoa's
    // conversation, and a pin against the whole display name would be
    // satisfied by an `item` naming the customer by its distinctive half.
    const counterparties = ALL_TRANSCRIPTS.flatMap((t) =>
      fold(t.counterparty).split(/\s+/u),
    );
    const declared = SOURCE_DESCRIPTIONS.map(fold);
    // What a CORRECT resolution's prose carries — every token a looking label
    // pins positively, whichever shape pins it.
    const goods = LOOKING_TRANSCRIPTS.flatMap((t) =>
      t.labels.flatMap((label) =>
        label.checks
          .filter((c) => "contains" in c)
          .map((c) => fold((c as { contains: string }).contains)),
      ),
    );
    for (const transcript of LOOKING_TRANSCRIPTS) {
      const tokens = transcript.neverFiled ?? [];
      expect(
        tokens.length,
        `${transcript.id} declares no forbidden token — a looking day with none cannot report a leak at all`,
      ).toBeGreaterThan(0);
      const said = [
        ...transcript.messages,
        ...(transcript.history ?? []),
      ].map((m) => fold(m.text));
      // EVERY CUSTOMER THIS CORPUS NAMES, and the list cannot go stale: a
      // transcript added without an identifying word here is a customer
      // `list_chats` shows the model and the sweep cannot see (Codex r3).
      for (const other of ALL_TRANSCRIPTS) {
        const words = fold(other.counterparty).split(/\s+/u);
        expect(
          tokens.some((token) => words.includes(fold(token))),
          `${transcript.id} forbids no word of "${other.counterparty}" — an abbreviation of that customer would reach a filed field unmeasured`,
        ).toBe(true);
      }
      for (const token of tokens.map(fold)) {
        expect(
          counterparties.includes(token) ||
            declared.includes(token) ||
            said.some((text) => text.includes(token)),
          `${transcript.id} forbids "${token}", which names no customer in this corpus, appears in none of its own words, and is not one of the source descriptions SOURCE_DESCRIPTIONS argues for`,
        ).toBe(true);
        // AND IT MUST NOT FIRE ON ORDINARY PROSE (Codex r3). The sweep is a
        // folded substring search, so a token that also turns up in ordinary
        // talk — «el», «la», a trade word — matches goods prose rather than an
        // identity and would refuse TRUE facts. That is the collision Diego's
        // ruling refuses to risk inside the aperture, and it is checkable here
        // because every word of this corpus is in the tree: `ORDINARY_TALK` is
        // the sample of what a chat says when it is not ordering anything.
        for (const [, line] of ORDINARY_TALK) {
          expect(
            fold(line).includes(token),
            `${transcript.id} forbids "${token}", which appears in the ordinary talk «${line}» — it would fire on prose rather than on an identity`,
          ).toBe(false);
        }
        // ...and it must not swallow what a CORRECT answer contains, in
        // either direction: a day forbidding «cemento» while a label pins it
        // would score every right resolution as a leak.
        for (const good of goods) {
          expect(
            good.includes(token) || token.includes(good),
            `${transcript.id} forbids "${token}", which collides with the goods "${good}" a label on these days pins — a correct resolution would score as a leak`,
          ).toBe(false);
        }
      }
    }
  });

  it("pins every prose field of every looking label against that declaration", () => {
    // THE LABEL'S HALF, and it is what makes a leak a check_failed with a
    // NAMED predicate on a day that labels the message — the sweep is what
    // makes it a leak everywhere else. Every token pinned here comes off the
    // day's own `neverFiled`, so the two cannot drift into two vocabularies.
    for (const transcript of LOOKING_TRANSCRIPTS) {
      const tokens = new Set((transcript.neverFiled ?? []).map(fold));
      for (const label of transcript.labels) {
        const prose = PROSE_FIELDS[label.factType];
        expect(
          prose,
          `${label.factType} has no entry in PROSE_FIELDS — a looking label cannot be pinned against a leak until its free-text fields are named`,
        ).toBeDefined();
        for (const field of prose ?? []) {
          const pins = label.checks.filter(
            (c) => c.path === field && "lacks" in c,
          ) as { path: string; lacks: string }[];
          expect(
            pins.length,
            `${transcript.id} / ${label.messageId} leaves "${field}" unpinned — a model that wrote the referent's name into it would score CORRECT`,
          ).toBeGreaterThan(0);
          for (const pin of pins) {
            expect(
              tokens.has(fold(pin.lacks)),
              `${transcript.id} / ${label.messageId} pins lacks "${pin.lacks}", which this day's \`neverFiled\` does not declare`,
            ).toBe(true);
          }
        }
      }
    }
  });

  it("pins the GOODS every resolving label claims, so a right number over a wrong product is wrong", () => {
    // Codex r1: a crossing for «300 varilla» recovers the quantity and files
    // the wrong product, and a label pinning only `quantity` credits it as a
    // successful resolution — which is the one thing a row measuring
    // resolution must not do. Every looking label that claims a fact pins a
    // content word of the goods, and the token must be in the referent's own
    // words rather than in a phrasing somebody chose.
    // EVERY looking day's history, not only this one's: a cross-chat case
    // resolves against ANOTHER customer's conversation, which is the whole
    // shape of «lo mismo que a Ochoa».
    const history = LOOKING_TRANSCRIPTS.flatMap((t) =>
      (t.history ?? []).map((m) => fold(m.text)),
    );
    for (const transcript of LOOKING_TRANSCRIPTS) {
      for (const label of transcript.labels) {
        const pins = label.checks.filter(
          (c) => c.path === "item" && "contains" in c,
        ) as { path: string; contains: string }[];
        expect(
          pins.length,
          `${transcript.id} / ${label.messageId} pins no goods — a resolution scored on the quantity alone credits a wrong product`,
        ).toBeGreaterThan(0);
        for (const pin of pins) {
          expect(
            history.some((text) => text.includes(fold(pin.contains))),
            `${transcript.id} / ${label.messageId} pins goods "${pin.contains}" that appear in no beat of the history it resolves from`,
          ).toBe(true);
        }
        // ...and the UNIT, for the same reason and with the same source: a
        // resolution that read «toneladas» off a referent that says «bultos»
        // carried the number across and not the goods (Codex r2).
        // ACROSS BOTH FIELDS the unit can be filed in (Codex r3): a check on
        // `unit` alone is walked past by «toneladas de cemento gris» in
        // `item` with `unit` empty.
        const units = label.checks.filter(
          (c) => c.path === "unit" && "orIn" in c,
        ) as { path: string; orIn: string; contains: string }[];
        expect(
          units.length,
          `${transcript.id} / ${label.messageId} leaves the unit ungraded — «toneladas» in place of «bultos» is a wrong record on a day whose whole claim is a value carried across`,
        ).toBe(1);
        expect(units[0]!.orIn).toBe("item");
        expect(
          history.some((text) => text.includes(fold(units[0]!.contains))),
          `${transcript.id} / ${label.messageId} pins a unit that appears in no beat of the history it resolves from`,
        ).toBe(true);
      }
    }
  });

  it("hashes history as canonical content, and leaves a day without one hashed as it was", () => {
    // A CHANGED HISTORY IS A CHANGED CORPUS: the referent is what the label's
    // values are read from, so moving it without re-running would leave a
    // recorded number describing goods the corpus no longer holds.
    const looking = LOOKING_TRANSCRIPTS[0]!;
    const moved: SeedTranscript = {
      ...looking,
      history: (looking.history ?? []).map((m, i) =>
        i === 0 ? { ...m, text: `${m.text} y dos costales` } : m,
      ),
    };
    expect(corpusDigest([moved])).not.toBe(corpusDigest([looking]));
    // ...and the widened corpus is a different corpus from the original one,
    // which is why the report carries both digests rather than one.
    expect(corpusDigest(ALL_TRANSCRIPTS)).not.toBe(
      corpusDigest(SEED_TRANSCRIPTS),
    );
  });
});
