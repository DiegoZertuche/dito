/**
 * THE EXTRACTION-PRECISION CORPUS (ticket #56; ADR-0028, NFR-3, FR-31).
 *
 * ADR-0028 names `packages/evals` as a component and gives it "golden
 * corpora … extraction-precision fixtures (labeled seed transcripts
 * pre-pilot; the disclosure loop takes over at pilot)". This module is
 * the corpus's SHAPE and its MANIFEST; the transcripts themselves are in
 * `corpus/transcripts.ts`, which is data and nothing else.
 *
 * WHAT IS BEING MEASURED, precisely, because the phrase "extraction
 * precision" has two readings and only one of them is the bar:
 *
 *   precision = (facts that CROSSED and are right) / (facts that CROSSED)
 *
 * Over what crossed — never over what the model emitted. A candidate the
 * aperture's confidence gate turned into a QUESTION never crossed, so it
 * was never a precision failure; it cost the rep a reply, which is the
 * trade FR-31 makes on purpose. That is why the corpus drives the SAME
 * Postgres seam every other suite uses (spec #48's testing decisions:
 * "seam count is unchanged: one") and reads its numbers back out of the
 * Ledger and the questions store — the gate is inside the system under
 * test, not around it.
 *
 * WHAT A LABEL CLAIMS, and what it deliberately does not. A label says:
 * *this message states a fact of this kind, and here are the values a
 * correct reading of it produces.* It says nothing about the PROSE the
 * twin writes — `DatePromised.commitment` and a `QuoteGiven.item` are
 * model-authored sentences and there is no defensible exact expectation
 * for them, so the checkable fields are checked exactly and the prose
 * fields are checked loosely or not at all (see `scoring.ts`). Draft
 * quality and voice are a different suite, which ADR-0028 also names.
 *
 * A MESSAGE WITH NO LABEL STATES NOTHING. That is the corpus's other
 * half and the sharper one: small talk, hedges, the rep's own tactics and
 * judgments, third-party gossip, and the counterparty's own WhatsApp
 * number are all in the transcripts precisely so that filing anything
 * against them counts against precision.
 */
import { createHash } from "node:crypto";
import type { FactType } from "@dito/aperture";
import { DAY_START_UTC } from "./clock.ts";

/**
 * One message in a seed transcript, as it reaches the seam.
 *
 * `id` is the WhatsApp message id the plane would deliver and the id the
 * model is asked to cite; it is also this corpus's join key — a label
 * names the message it belongs to by this id, and the scorer walks a
 * filed fact back to its message through the seam row the aperture
 * stamped it with.
 */
export interface SeedMessage {
  readonly id: string;
  /** True when the REP wrote it. The transcript is one day of one chat. */
  readonly fromMe: boolean;
  /**
   * Minutes after the corpus day's start (00:00 in the rep's zone).
   *
   * NEGATIVE ON A CARRIED-IN DAY (ticket #139). A transcript that declares
   * `owedFromDaysAgo` was said on an EARLIER rep day, and one day back is
   * −1440 minutes — exact rather than approximate, because the corpus zone
   * keeps no DST. `corpus.test.ts` holds every minute inside the window
   * that transcript's own carry-in opens.
   */
  readonly atMinute: number;
  readonly text: string;
}

/**
 * What a correct reading of one message produces.
 *
 * `checks` are deterministic assertions over the payload the APERTURE
 * stored — after its normalization, so `+52 55 1234 5678` is labeled as
 * the E.164 the merge ladder actually keys on. Every check must pass for
 * the fact to count as correct; a filed fact matching no label at all is
 * a false positive.
 */
export interface FactLabel {
  /** The message this fact is stated in. */
  readonly messageId: string;
  readonly factType: FactType;
  /**
   * Why a human says this is a fact — one line, for the reviewer reading
   * the corpus rather than for any code. Labels are meant to be argued
   * with; an unexplained label cannot be.
   */
  readonly because: string;
  readonly checks: readonly FactCheck[];
}

/**
 * One deterministic assertion over a stored payload.
 *
 * Six shapes, and each is a different thing a transcript can honestly
 * claim about a field:
 *
 * - `equals` — the transcript states this value outright. A price, a
 *   quantity, a normalized identifier.
 * - `contains` — prose the model authors, where the transcript still pins
 *   a token that must survive it (accent- and case-folded).
 * - `absent` — a correct reading leaves this unset, and filling it is
 *   INVENTION. «el jueves» resolved to a calendar date; a quantity of one
 *   on a per-unit price nobody counted.
 * - `equalsAll` — this ARRAY is exactly these values, in any order, and
 *   nothing else. The shape a multi-valued merge key needs: a check on
 *   `identifiers.emails.0` says nothing about a SECOND email beside it, and
 *   an extra one is an immutable key that can auto-merge two unrelated
 *   customers (ADR-0035). Codex round 3 — the hole was real, and it made
 *   `ContactEstablished` precision the least trustworthy row in the table.
 * - `lacks` — this prose must NOT carry this token. The dual of `contains`,
 *   and it is what lets a day that CONTAINS something prohibited say so: the
 *   token comes off the transcript's own words, never out of a vocabulary
 *   somebody invented, so the check stays a claim about this corpus rather
 *   than a lint. TWO KINDS OF DAY NEED IT. `CustomerPattern`'s whole payload
 *   is a model-composed clause, so `contains` pins what must survive a
 *   paraphrase and nothing bounds what else rides along — Codex round 1 on
 *   ticket #61: a label pinned by «factura» is satisfied by «siempre pide
 *   factura y el rep siempre infla el precio», and FR-30's excluded class
 *   crossed the wall inside the same string on a row scored CORRECT. And a
 *   LOOKING day's prose fields are where the referent would leak (ticket
 *   #199): `PROSE_FIELDS` argues why that is measured here rather than
 *   fenced in code.
 *   WHAT IT DOES NOT REACH, written here rather than assumed (Codex round
 *   2). It is a folded substring search, so a PARAPHRASE walks past it: on
 *   `PC-04`'s pins, «paga a 30 días y el vendedor suele demorar» keeps the
 *   positive token and re-words the judgment, and scores correct. That is
 *   the same limit every `contains` check in this corpus has, in the other
 *   direction, and closing it means grading the whole proposition — a
 *   SEMANTIC judge, which `scoring.ts` refuses by design ("nothing here
 *   consults a model") and which no fact type has. So the residual is
 *   real and it is named: a model that writes rep content into its own
 *   claim clause is caught by the per-type number over the corpus's
 *   negatives, not by this predicate.
 * - `contains` WITH `orIn` — the token survives in one field or the other.
 *   A commercial payload can carry the unit in `unit` or folded into `item`
 *   («300 bultos de cemento gris»), and both are honest — so a check on one
 *   field alone is walked past by the other (Codex r3 on #199: «toneladas de
 *   cemento gris» in `item` with `unit` empty satisfied an `absentOrEquals`
 *   on `unit`). It exists for a value read BY REFERENCE, where the unit is
 *   something carried across rather than a phrasing.
 * - `absentOrEquals` — *if* the twin filed this, it must be this value.
 *   The shape a CARRIED-FORWARD value deserves: an order that follows a
 *   quote may honestly carry that quote's price, because the number was
 *   stated in the day rather than invented — and omitting it is not an
 *   error either. `absent` here would be a false claim, and `equals` would
 *   punish a twin for being terse.
 *
 * `absentOrEquals` was added at Codex round 2, when pinning every
 * structured field to `absent` produced labels that said a Mexican price
 * list carries no currency. The finding was right; the first repair was
 * not, and a corpus that grades wrongly is worse than one that grades
 * loosely because it looks like a measurement.
 */
export type FactCheck =
  | { readonly path: string; readonly equals: string | number }
  | {
      readonly path: string;
      /** The other field this token may be filed in instead. */
      readonly orIn: string;
      readonly contains: string;
    }
  | { readonly path: string; readonly equalsAll: readonly string[] }
  | { readonly path: string; readonly absentOrEquals: string | number }
  | { readonly path: string; readonly contains: string }
  | { readonly path: string; readonly lacks: string }
  | { readonly path: string; readonly absent: true };

/**
 * A message that states nothing extractable, claimed POSITIVELY rather
 * than left as the absence of a label.
 *
 * The difference matters when a corpus is edited: a label deleted by
 * accident silently turns a true positive into a false positive and drags
 * the number down for a reason nobody can see. Every message in a
 * transcript is therefore either labeled or listed here, and
 * `corpus.test.ts` refuses a transcript where one is neither.
 */
export interface SilentMessage {
  readonly messageId: string;
  /** Why nothing crosses from it — the reviewer's half of the claim. */
  readonly because: string;
}

/** One labeled seed transcript: a day of one chat, and what it states. */
export interface SeedTranscript {
  /** Stable id — the corpus's own key, used in the report and in fixtures. */
  readonly id: string;
  /** What this day is FOR: the reading it exercises, in one line. */
  readonly exercises: string;
  /** The rep-confirmed customer name, as the binding ceremony stored it. */
  readonly counterparty: string;
  /**
   * This chat's OWN subscriber number — ten national digits — when the
   * transcript's meaning depends on it.
   *
   * Almost no transcript needs it, and the harness invents a unique
   * address for the rest. `c-numero-propio` needs it: its whole claim is
   * that a counterparty restating their own WhatsApp number establishes no
   * contact (ADR-0004, and the aperture refuses it — #52). A fixture whose
   * chat address had nothing to do with the number in the message would be
   * testing that claim against a number that is not the chat's, which is
   * to say not testing it at all. The first live run filed exactly that
   * false positive and it was the FIXTURE's fault, not the model's.
   */
  readonly chatSubscriber?: string;
  /**
   * A WINDOW THIS CHAT HAS OWED SINCE AN EARLIER REP DAY (ticket #139),
   * counted in whole days back from the corpus day.
   *
   * The eval lane drives ONE pass on ONE rep day, and until this existed
   * that also fixed every transcript's messages to that day — so no case
   * could be said on a weekday other than the corpus's Tuesday, and the
   * one shape the ticket is about could not be written down at all: a
   * window that spans MORE THAN ONE rep day, where «el lunes» said on the
   * Sunday means the very next day and «el lunes» read on the Tuesday
   * would mean a week out.
   *
   * It is not a second calendar, and per-transcript calendars are still
   * not built (#121's remainder 5): the clock, the zone and the pass are
   * the lane's single ones. What it moves is which window the chat is
   * READ over — the pass's own `owedFrom`, the watermark an abandoned or
   * deferred run leaves behind — so the harness seeds one unsettled
   * `extraction_runs` row that many days back and the pass reads from
   * there, exactly as it does after a run that died mid-call.
   *
   * Bounded by the pass's seven-day lookback (`earliestWindowStart`); a
   * transcript reaching further back would have its beats silently cut
   * off, so `corpus.test.ts` refuses it.
   */
  readonly owedFromDaysAgo?: number;
  readonly messages: readonly SeedMessage[];
  /**
   * EARLIER DAYS OF THIS CHAT, IN TWIN MEMORY AND NOWHERE ELSE (ticket
   * #199; spec #193 decision 11).
   *
   * A `SeedTranscript` is one day, and a day whose message points at
   * something the day does not spell out — «lo mismo del pedido pasado» —
   * can only be read correctly if the earlier day is somewhere the twin can
   * reach. That somewhere is twin memory: the harness ingests these beats
   * into the bundle and embeds them, exactly as ingest does on the rail, so
   * `search_chat_history` has a row source to find them in.
   *
   * NEVER SEEDED AS SEAM EVENTS, NEVER LABELLED, NEVER CITED. The window the
   * pass reads is the DAY, and a fact must name a `wa_events` row inside it
   * (ADR-0038) — so a history beat has no id the submission may carry, and
   * `corpus.test.ts` refuses a label or a silence that names one. What the
   * looking finds contributes the goods and nothing else.
   *
   * MINUTES ARE THIS DAY'S, COUNTED BACK: the same `atMinute` arithmetic as
   * `messages`, off `DAY_START_UTC`, so a beat said the day before is
   * −1440 and under. `corpus.test.ts` holds every one strictly before the
   * window this transcript is read over.
   *
   * THE OLDEST BEAT IS THE REFERENT, and the history is longer than
   * `DEFAULT_TRANSCRIPT_LIMIT` on purpose: the extraction is shown the last
   * twenty lines before the window as context, so a referent among them is
   * resolvable with no tool call at all and the case would measure the
   * context recipe rather than the reads.
   */
  readonly history?: readonly SeedMessage[];
  /**
   * TOKENS NO FIELD THIS DAY FILES MAY CARRY, whatever was filed (ticket
   * #199; ADR-0004; Diego's ruling on #206's remainder 3).
   *
   * The day's own declaration of what a LEAK is: the referent chat's
   * counterparty, and the words that would name which order or which chat
   * the goods were resolved from. `scoring.ts` sweeps every string of every
   * fact a looking day filed against it, and that is the only mechanism that
   * reaches the three cases a label's own `lacks` cannot (Codex r1):
   *
   * - a crossing whose FIRST failing check was something else — a wrong
   *   quantity is recorded and the leak beside it is not looked for;
   * - a crossing of a type this day labels nowhere, which runs no checks at
   *   all;
   * - a crossing on one of the two days that must file NOTHING, which have
   *   no labels to carry a check.
   *
   * Each of those is a filed record naming another customer, which is the
   * harm this row exists to expose, so the sweep is over the PAYLOAD and not
   * over the labels.
   *
   * THE LABELS STILL PIN IT TOO, and `corpus.test.ts` holds every pinned
   * token to this list: a `lacks` on the label is what makes a leak a
   * check_failed with a named predicate on a day that labels the message,
   * and the sweep is what makes it a leak on every other day.
   */
  readonly neverFiled?: readonly string[];
  readonly labels: readonly FactLabel[];
  readonly silent: readonly SilentMessage[];
}

/**
 * WHERE THIS TRANSCRIPT'S OWN REP DAY STARTS, as a UTC instant — the day
 * its `atMinute`s are counted from, and the day its window opens on.
 *
 * One conversion beside the field it reads, rather than a `−1440` in the
 * harness and another in the unit lane: a corpus that placed a beat by one
 * arithmetic and checked it by another would agree with itself by luck.
 *
 * Whole days back, exact rather than approximate: the corpus zone keeps no
 * DST, which is the same reason `atMinute` may count in flat minutes at
 * all.
 */
export function dayStartUtcOf(transcript: SeedTranscript): number {
  return DAY_START_UTC - (transcript.owedFromDaysAgo ?? 0) * 86_400_000;
}

/**
 * THE STRUCTURED FIELDS OF EACH FACT TYPE — the ones a label must pin.
 *
 * A check judges the field it names and says nothing about any other, so a
 * label that pins `amount` and is silent on `quantity` accepts an invented
 * quantity — and a label with NO checks accepts any aperture-valid payload
 * at all (Codex round 2; two labels were in exactly that state, so an order
 * for «100 helicopters, 999, USD 123456» would have scored correct and
 * INFLATED the number).
 *
 * Every label therefore pins every field listed here, to a value the
 * transcript states or to `absent`, and `corpus.test.ts` refuses one that
 * does not.
 *
 * NOT every field, deliberately. `item`, `unit`, `commitment`,
 * `contactName` and `role` are prose the model authors; there is no
 * defensible exact expectation for them, and demanding one would measure
 * phrasing. They stay ungraded — which is this corpus's stated policy, and
 * why an ungraded field must never be one carrying a NUMBER or an
 * IDENTIFIER, because those are what a wrong record is made of.
 *
 * `agreement` IS NOT LISTED, and the reason is that no reading can get it
 * wrong (ticket #71). It is not a field the model supplies: the aperture
 * takes an `OrderTaken`'s evidence off the seam row the candidate cites,
 * whole, so it is a function of the message id — which the scorer already
 * matches. Grading it would be grading the join key twice.
 *
 * `requestedFor` WAS MISSING AND IS A DATE (ticket #70's finding, fixed at
 * #59). #70 added it to all three commercial payloads and nothing here
 * graded it, so an INVENTED OR WRONG DAY on a quote or an order scored as
 * a correct crossing across all 73 commercial labels. The rule above rules
 * that out on its own terms — "an ungraded field must never be one
 * carrying a NUMBER or an IDENTIFIER" — and a calendar date is both. It is
 * also the field #57's headline defect was about, and #66 measured that
 * the confidence gate cannot catch a systematically wrong date: every
 * wrong crossing arrived at 0.95–1.00. The eval lane is the only mechanism
 * that would, and until now it was blind to exactly that field.
 */
export const STRUCTURED_FIELDS: Readonly<Record<string, readonly string[]>> = {
  QuoteGiven: ["quantity", "amount", "currency", "requestedFor"],
  OrderRequested: ["quantity", "amount", "currency", "requestedFor"],
  OrderTaken: ["quantity", "amount", "currency", "requestedFor"],
  DatePromised: ["dueOn"],
  // THE WHOLE ARM, not its first element (Codex round 3). The aperture
  // stores an array per identifier kind, and every value in it is a merge
  // key ADR-0035's ladder fires on — so a label that pins `…emails.0` and
  // says nothing about a second email accepts a fabricated one, which can
  // automatically merge two unrelated customers. `equalsAll` is the
  // predicate; an arm the day does not state is pinned to the empty set.
  ContactEstablished: [
    "identifiers.phones",
    "identifiers.emails",
    "identifiers.rfcs",
  ],
  // THE ONE PROSE FIELD IN THIS TABLE, and the exception is argued rather
  // than taken (ticket #61). `CustomerPattern` v1 stores exactly one thing
  // — the model's own clause — so leaving it ungraded would give this type
  // a label that pins NOTHING: the `checks: []` hole #56 found, reopened
  // for the one type whose false positives are breaches.
  //
  // So it is pinned, with `contains` rather than `equals`, because
  // `contains` is this corpus's own shape for "prose the model authors,
  // where the transcript still pins a token that must survive it". The
  // token is a content word out of the customer's own sentence — «lunes a
  // viernes», «factura», «blanco», «30» — never a phrasing: a paraphrase
  // that drops it has changed what the pattern SAYS, and one that keeps it
  // is free to word the rest however it likes. That is the line ADR-0028
  // draws, on the right side of it.
  //
  // AND WITH `lacks`, WHERE THE DAY SUPPLIES SOMETHING FORBIDDEN. `contains`
  // says what must survive and nothing says what must not ride along, so a
  // clause carrying the pinned token AND a judgment about the rep scores
  // correct (Codex r1). Every `CustomerPattern` label on a day whose
  // silences cite FR-30 or FR-32 therefore pins both sides, off that day's
  // own forbidden words — and `corpus.test.ts` enforces it rather than
  // trusting a sweep, because three labels were left unpinned while this
  // comment already claimed otherwise (Codex r3, and no paraphrase was
  // needed to exploit it).
  CustomerPattern: ["pattern"],
};

/**
 * THE FREE-TEXT FIELDS OF EACH FACT TYPE — the ones a LOOKING label must
 * pin against the referent (ticket #199; ADR-0004).
 *
 * The complement of `STRUCTURED_FIELDS` over what the aperture stores, and
 * the same list that table's own docblock names as ungraded prose: `item`,
 * `unit`, `commitment`, `contactName`, `role`, `pattern`. Ungraded is right
 * for a day whose values are stated outright — there is no defensible exact
 * expectation for a sentence the model authors — and it is exactly wrong for
 * a day resolved BY REFERENCE, where the one thing that may never reach the
 * record is what the looking found: which order, which chat, whose name
 * (Diego's ruling on #206's remainder 3).
 *
 * So a looking label pins every field here with a `lacks`, and the leak is
 * measured rather than fenced: a name blacklist in code would collide with
 * the goods in this trade — a customer called «Cemex» is also a cement — and
 * would silently refuse TRUE facts. `corpus.test.ts` enforces the pinning and
 * `scoring.ts` counts what it catches.
 *
 * THE WORDS A SOURCE DESCRIPTION USES, and the one declared vocabulary in
 * this file (`SOURCE_DESCRIPTIONS`, Codex r1). Every other token a day
 * forbids comes off the corpus — a customer's name, a phrase out of the
 * referring message — because a token off nowhere is a lint rather than a
 * claim. These two are the exception and it is argued: «chat» and «pedido»
 * are how a filed field would say WHICH conversation or WHICH order the
 * goods came from («cemento gris del pedido del 29», «el del chat de
 * Ochoa»), neither is a good in this trade, and neither names a customer —
 * so a day can forbid them without the collision that makes a name
 * blacklist unsafe here. Without them a source description that used no
 * customer's name would score as a clean resolution.
 *
 * `agreement` IS NOT HERE for the reason `STRUCTURED_FIELDS` gives: the
 * aperture takes an `OrderTaken`'s evidence off the seam row whole (ticket
 * #71, ADR-0038), so it is the rep's own typed sentence and not a field the
 * model supplies. A name the REP typed in another customer's chat crosses
 * inside that quote whatever the looking did, which is ADR-0038's
 * whole-evidence rule meeting ADR-0004's wall rather than anything a looking
 * label can pin.
 */
export const SOURCE_DESCRIPTIONS: readonly string[] = ["chat", "pedido"];

export const PROSE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  QuoteGiven: ["item", "unit"],
  OrderRequested: ["item", "unit"],
  OrderTaken: ["item", "unit"],
  DatePromised: ["commitment"],
  ContactEstablished: ["contactName", "role"],
  CustomerPattern: ["pattern"],
};

/**
 * THE ≥95% BAR AND WHAT IT TAKES TO SEE IT (NFR-3, #6's seed-corpus
 * doctrine).
 *
 * A precision number is a proportion, and a proportion measured on ten
 * crossings tells you almost nothing about whether the true rate clears
 * 0.95. The corpus is sized so the measurement is worth reading BEFORE a
 * pilot rep exists to supply live labels — live labels supplement it
 * later and never gate it.
 *
 * The rule: the corpus must produce at least `MIN_CROSSINGS_FOR_CONFIDENCE`
 * crossings. At p ≈ 0.95 the 95% Wilson interval's half-width is roughly
 *
 *   n =  40 → ±6.6pp     n =  60 → ±5.5pp
 *   n =  80 → ±4.8pp     n = 100 → ±4.3pp
 *
 * 80 is where the interval stops being wide enough to swallow the bar
 * whole: a point estimate of 0.95 at n=80 has a lower bound near 0.88,
 * which is a statement, where the same estimate at n=20 has a lower bound
 * near 0.76, which is not. The runner reports the interval alongside the
 * point estimate for exactly this reason — a single number without one is
 * the thing this constant exists to prevent.
 *
 * IT IS READ TWO WAYS, and the two are not the same claim:
 *
 * - Of a RUN, it counts CROSSINGS - the currency the bar is denominated
 *   in. A day whose facts the gate all turned into questions contributes
 *   labels and no crossings. A run under it is reported `underpowered`
 *   and never failed: the number still stands, the interval is just too
 *   wide to speak about the bar (AC 6 - this measurement gates nothing).
 * - Of the CORPUS, it counts LABELS, and that is a necessary condition
 *   rather than the same test: a corpus offering 20 labels could never
 *   reach 80 crossings however well the extractor did, and that IS a
 *   defect in the corpus, so `corpus.test.ts` fails on it.
 *
 * One number, because a corpus sized to a different figure than the run is
 * checked against would make one of the two a decoration.
 *
 * WHAT IT DOES NOT BUY, said plainly because the alternative is a report
 * that overclaims (Codex round 2). Eighty crossings are not eighty
 * INDEPENDENT trials: the pass reads one chat per model call, so a busy
 * day's four or five facts share a call and tend to be wrong together. The
 * binomial interval on that pooled n assumes an independence the design
 * does not have, and the report therefore also carries a CLUSTER BOOTSTRAP
 * over chat-days — the one to quote.
 *
 * Clearing the ≥95% bar with the cluster interval's lower bound above it
 * would take substantially more INDEPENDENTLY AUTHORED chat-days than 34.
 * This corpus is not sized for that, and it does not have to be: this
 * slice's number gates nothing (AC 6), and Test 4 gates the flag flip on
 * pilot data — where the independent units are real reps' real days and
 * arrive by the hundred.
 */
export const MIN_CROSSINGS_FOR_CONFIDENCE = 80;

/** NFR-3's bar. Recorded, reported against, and NOT enforced this slice. */
export const PRECISION_BAR = 0.95;

/**
 * FACT TYPES DELIBERATELY ABSENT FROM THIS CORPUS, with the reason, so
 * that adding one later is a visible CORPUS CHANGE rather than a silent
 * widening of what the number covers (ticket #56 AC 5).
 *
 * `corpus.test.ts` holds this to three separate claims: no label names an
 * excluded type, no excluded type is in the aperture's `FACT_TYPES`, and
 * every excluded type carries a reason.
 *
 * IT IS EMPTY NOW, AND THAT IS THE MECHANISM WORKING RATHER THAN THE
 * MECHANISM ENDING (ticket #61). `CustomerPattern` was its only entry, and
 * removing it cost exactly what AC 5 intended it to cost: all three claims
 * failed at once, the entry had to be deleted by hand, twelve labels and
 * five days of negatives had to be written and argued, and the number moved
 * in a diff somebody reviewed. The map stays for the next type that has to
 * wait for a corpus, and `corpus.test.ts` keeps an empty manifest a live
 * claim rather than a decoration: every type the aperture files now carries
 * labels here, so "excluded" and "unmeasured" cannot drift apart.
 *
 * WHAT THE OLD ENTRY DEMANDED OF WHOEVER REMOVED IT is the standing
 * obligation rather than a one-off, so it is kept in sight:
 * `CustomerPattern` joins "with its own labels and — this is the part that
 * must not be skipped — its own reported number beside the others, never
 * folded in". Precision averaged over a wrong `QuoteGiven` (a wrong number
 * the rep can correct) and a wrong `CustomerPattern` (the rep's employer
 * reading a judgment about the rep) would report one reassuring figure over
 * a recoverable error and an unrecoverable one. The report's `byFactType`
 * row is that obligation discharged, and `report.test.ts` holds it there.
 */
export const EXCLUDED_FACT_TYPES: Readonly<Record<string, string>> = {};

/**
 * A DIGEST OF THE CORPUS, so a recorded number cannot outlive the labels it
 * was scored against (Codex r1).
 *
 * The report used to carry only counts — transcripts, messages, labels — so
 * editing a label's expected VALUE, tightening a check, or rewriting a
 * transcript's text left the recorded precision looking current while it
 * described a corpus that no longer exists. Counts are exactly the thing
 * such an edit does not change.
 *
 * Over the canonical content, in declaration order: every message's text
 * and timing, every label's checks, every silence. Not over the `because`
 * prose — a reviewer sharpening the ARGUMENT for a label has not changed
 * what the run measured, and forcing a re-run for a comma would teach
 * people to skip the re-run.
 *
 * `owedFromDaysAgo` IS CANONICAL CONTENT (ticket #139), because it decides
 * which rep day a message was said on and therefore what every relative
 * weekday in it resolves to. Moving a day's carry-in without re-running
 * would leave a recorded number describing dates that no longer follow.
 *
 * SO IS `history` (ticket #199), and more sharply: a looking case's label
 * pins the values its REFERENT states, so moving the earlier day changes
 * what a correct reading produces. A changed history is a changed corpus.
 *
 * A DAY WITH NO HISTORY HASHES EXACTLY AS IT DID, and that is what makes
 * the widened corpus comparable with the frozen before at all. The history
 * is spread in rather than written as a slot, so the canonical array of a
 * day without one is the seven elements it always was — and
 * `corpusDigest(SEED_TRANSCRIPTS)` is still the digest the before was
 * scored under, which `report.test.ts` holds against the artifact.
 */
export function corpusDigest(
  transcripts: readonly SeedTranscript[],
): string {
  const canonical = transcripts.map((t) => [
    t.id,
    t.counterparty,
    t.chatSubscriber ?? "",
    t.owedFromDaysAgo ?? 0,
    t.messages.map((m) => [m.id, m.fromMe, m.atMinute, m.text]),
    t.labels.map((l) => [l.messageId, l.factType, l.checks]),
    t.silent.map((s) => s.messageId),
    ...(t.history === undefined
      ? []
      : [t.history.map((m) => [m.id, m.fromMe, m.atMinute, m.text])]),
    // AND WHAT THE DAY FORBIDS, for the same reason as the history: it is
    // graded against, so widening or narrowing it changes what the recorded
    // number measured. Spread the same way, so a day without one hashes
    // exactly as it did.
    ...(t.neverFiled === undefined ? [] : [[...t.neverFiled]]),
  ]);
  return createHash("sha256")
    .update(JSON.stringify(canonical))
    .digest("hex")
    .slice(0, 32);
}
