/**
 * THE EXTRACTION-PRECISION HARNESS (ticket #56 AC 2).
 *
 * THE CORPUS DRIVES THE SAME POSTGRES SEAM, and that is the whole design
 * decision this file exists to honour. Spec #48's testing decisions say it
 * outright — "seam count is unchanged: one" — so a labeled transcript goes
 * in as `wa_events`, exactly the way the plane delivers a day, and the
 * numbers come back out of the Ledger. There is no eval-only path into
 * extraction and no eval-only reader.
 *
 * WHY THAT MATTERS RATHER THAN BEING TIDY: the aperture's confidence gate
 * is what separates a fact from a drop, and precision is a statement about
 * facts. A harness that called the model directly and scored its output
 * would measure the MODEL and report the number as though it measured the
 * SYSTEM — and the gate, which is the system's whole answer to being
 * unsure, would be outside the thing under test. So the pass is
 * `runDailyExtraction`: the pass that reads a whole day and waits for it.
 *
 * THE BELOW-GATE HALF IS READ OFF THE RUN'S OWN FILINGS (ticket #218),
 * and that is the one thing here that is not a store read. A dropped
 * candidate reaches no store at all now — the questions store was where the
 * below-gate half could be read back, and it went with the route (spec #214
 * decision 3) — so the drops are recovered from the trace's own
 * `file_facts` call, parsed by the parser the tool parsed it with and
 * classified by the APERTURE's own `gateVerdict`. Two copies of
 * either would be a second reader disagreeing with the one that ran.
 *
 * WHAT IS REAL HERE, and what the run therefore costs: real Postgres, real
 * SQLCipher bundles, real envelope crypto under a real DEK (ADR-0028 —
 * the crypto path is never mocked). The MODEL is the one thing the caller
 * chooses: the live lane passes a harness holding a real key, and the
 * integration lane passes the scripted one's, so this function is
 * exercised on every CI run even where the live lane cannot be.
 *
 * ONE TWIN, MANY CHATS, ONE PASS. Each transcript becomes one bound
 * customer chat of one twin, so the pass is one `runDailyExtraction`
 * over the whole corpus — the shape a real day has, and the shape that
 * lets ADR-0035's merge matcher run over the corpus too rather than being
 * bypassed by a fixture that gave every customer its own company.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileEntityCreate, gateVerdict, readFiledFacts } from "@dito/aperture";
import { createBundle, type Bundle } from "@dito/bundle";
import { createDekFromMaterial, type Dek } from "@dito/crypto";
import type { Harness } from "@dito/execution";
import {
  civilDate,
  DEFAULT_MAX_TOKENS,
  embedAll,
  FILE_FACTS_TOOL,
  parseCandidateFacts,
  SEAM_SETTLING_LAG_MS,
  type CandidateFact,
  type DailyExtractionDeps,
  type Embedder,
  type RuntimeTrace,
} from "@dito/twin-runtime";
import type pg from "pg";
// SOURCE-ONLY, by the repo's own convention: every package's `src/testing`
// is excluded from its build, so test plumbing reaches other packages' test
// plumbing at the source (the shape `twin-runtime/src/testing/db.ts`
// already uses for the seam's harness). The `.ts` extension is explicit
// because the LIVE lane runs this file through `node
// --experimental-strip-types`, which resolves what is written rather than
// remapping a `.js` specifier onto a `.ts` file.
import { insertWaEventFixture } from "../../../seam/src/testing/wa-fixtures.ts";
import { seatTheTwin } from "../../../twin-runtime/src/testing/seat.ts";
import { DAY_START_UTC, EVAL_NOW, EVAL_TIME_ZONE } from "../clock.ts";
import { dayStartUtcOf, type SeedTranscript } from "../corpus.ts";
import type {
  ChatDayCost,
  CostReport,
  PassCounts,
  RetryCounts,
} from "../report.ts";
import {
  runPassWithNoToolRetries,
  type RetryNotice,
} from "./pass-retry.ts";
import {
  labelDrops,
  scoreCrossings,
  scoreLooking,
  type DroppedBelowGateRow,
  type LookingRow,
  type ObservedDrop,
  type PlacedLabel,
  type PrecisionReport,
  type ScoredCrossing,
} from "../scoring.ts";

const SELF_CHAT = "5215559990000@s.whatsapp.net";

/**
 * Six digits that make ONE RUN's chat JIDs unique. Two runs against one
 * database would otherwise collide on `(source, external_event_id)` and
 * silently seed a short day — a corpus that half-landed, scored as though
 * it had all landed. Per call rather than per process, because the
 * integration lane runs the harness several times in one process.
 */
function freshRunTag(): string {
  // From the same source the ids come from, rather than `Math.random`: a
  // uniqueness guarantee this file states in prose should not rest on the
  // weaker of the two generators already in scope.
  return randomUUID().replace(/\D/gu, "0").slice(0, 6);
}

/** What the caller chooses: the model, and which corpus slice to run. */
export interface EvalRunOptions {
  readonly db: pg.Client;
  /**
   * Where each extraction execution borrows its own connection (#194).
   *
   * THE CALLER'S, like the harness beside it. An execution holds its
   * transaction open across the model call while the pass goes on
   * enumerating on `db`, so the two may not share one — `lanes.ts` argues
   * the whole trade, and a harness that built its own pool would need a
   * connection string this one is deliberately never handed.
   */
  readonly executionPool: pg.Pool;
  /** Real in the live lane, scripted in the integration lane. */
  readonly harness: Harness;
  /**
   * WHAT THE SEARCH EMBEDS AGAINST — a composition choice at this edge, not
   * a code path (ticket #199; ADR-0028).
   *
   * The extraction searches the rep's own history before it files (#196), so
   * a run needs an embedder; and because the corpus now HOLDS history, the
   * choice decides whether the number describes retrieval anybody ships. The
   * live lanes compose BGE-M3 in-process, the same weights the rig loads
   * (`liveEmbedder`), and the scripted lane composes the deterministic fake
   * the integration suites already use, whose rankings follow word overlap
   * and are exactly assertable with no model in the loop. CI downloads
   * nothing.
   */
  readonly embedder: Embedder;
  readonly model: string;
  /**
   * The `output_config.effort` to run at, or omitted for the model's own
   * default (ticket #148). Set on the EXTRACTION slot only: it is the one
   * call site that honours it today, and setting it on `drafting` — which
   * this pass never calls — would record an arm the run did not have.
   */
  readonly effort?: "low" | "medium" | "high";
  readonly transcripts: readonly SeedTranscript[];
  /**
   * THE LOOKING CASES, SEEDED AND READ WITH THE REST AND SCORED APART
   * (ticket #199; spec #193 decision 11).
   *
   * One pass over one twin covers both slices — they are chats of the same
   * rep, and a cross-chat reference could not resolve otherwise — and the
   * NUMBERS stay apart: `report` is `transcripts` alone, which is what makes
   * the before/after pair a claim about the extractor rather than about a
   * corpus that grew, and `looking` is these four days' own row.
   *
   * Defaults to none, so every caller that measures the original labels only
   * — the two probe lanes and the harness's own suite — reads unchanged.
   */
  readonly looking?: readonly SeedTranscript[];
  /** Chain key for the binding ceremony's entity creates (ADR-0020). */
  readonly hmacKey: Uint8Array;
  /**
   * Where a no-tool retry announces itself (ticket #146). The two live
   * lanes pass `console.error`; a suite passes a collector. Omitted is
   * silent — see `RetryNotice`, and note the count reaches the report
   * either way.
   */
  readonly announce?: RetryNotice;
}

export interface EvalRun {
  /** Over `transcripts` alone — see `EvalRunOptions.looking`. */
  readonly report: PrecisionReport;
  /** The looking cases' own row (ticket #199), empty when none were run. */
  readonly looking: LookingRow;
  /** Every crossing, scored — the reviewable middle of the number. */
  readonly crossings: readonly ScoredCrossing[];
  /** Every candidate the gate stopped below the threshold (ticket #218). */
  readonly dropped: readonly ObservedDrop[];
  /**
   * ...and the same drops with the answer sheet's verdict on each — the
   * report's *dropped below gate* row (ticket #218).
   *
   * OVER EVERY CHAT THIS RUN READ, both slices, which is why it is here
   * rather than on `report` (Codex r1). `report` is the ORIGINAL labels
   * alone, deliberately; `passCounts.belowThreshold` is the aperture's own
   * count over every chat; and those two are the numbers a reader of the row
   * compares. A row scoped to one slice hid a labelled drop the aperture had
   * counted — in the looking cases, which is exactly where the reading this
   * ticket newly drops lives.
   */
  readonly droppedBelowGate: DroppedBelowGateRow;
  /**
   * Chats the pass read, from its own result — summed over its attempts
   * when a chat had to be re-asked (ticket #146; see `RetriedPass`).
   */
  readonly chatsRead: number;
  /** What the pass saw, including the outcomes that reach no store (#66). */
  readonly passCounts: PassCounts;
  /**
   * The same counts PER CHAT-DAY — and the distinction the probe lane
   * rests on (Codex r1).
   *
   * A REFUSED candidate reaches no store, so a day that proposed something
   * and had it refused is indistinguishable from a day that proposed
   * nothing in the totals. Only the per-chat row can tell them apart, and
   * telling them apart is the whole of #66's third hypothesis: silence is
   * not a low confidence, and a refusal is not silence either.
   *
   * Keyed by transcript id, so a caller never has to know a chat JID.
   */
  readonly passCountsByTranscript: Readonly<Record<string, PassCounts>>;
  /**
   * What this run had to ask twice (ticket #146) — see `RetryCounts`. Zero
   * on the ordinary run, and the reason the run has a number at all on the
   * one where a chat's call came back as plain text.
   */
  readonly retries: RetryCounts;
  /**
   * WHAT EACH CHAT-DAY COST, and the totals (ticket #199; spec #193
   * decision 11: "the report records tool calls, iterations and tokens per
   * chat-day").
   *
   * Keyed by transcript, like the pass counts beside it. Absent chat-days
   * are all-zero rather than missing, for the reason a missing precision row
   * is: nothing reads as "fine".
   */
  readonly cost: CostReport;
  readonly model: string;
  /** What the run asked the model for, for the report to record (#148). */
  readonly effort: "low" | "medium" | "high" | undefined;
  readonly maxTokens: number;
}

interface Placed {
  readonly transcript: SeedTranscript;
  /** The chat this day was seeded into — the `extraction_runs` join key. */
  readonly chatJid: string;
  /** `wa_events.id` → the transcript's own message id. */
  readonly eventToMessage: ReadonlyMap<string, string>;
}

/**
 * Runs the corpus and scores it.
 *
 * The caller owns the database (reset and migrated) and the harness.
 * Everything else — the twin, its bundle, its DEK, the bindings and the
 * seam rows — is built here and torn down with the temp directory, so two
 * runs of this function never see each other's state.
 */
export async function runExtractionPrecisionEval(
  options: EvalRunOptions,
): Promise<EvalRun> {
  const {
    db,
    executionPool,
    harness,
    embedder,
    model,
    effort,
    transcripts,
    hmacKey,
    announce,
  } = options;
  const looking = options.looking ?? [];
  const tmp = mkdtempSync(join(tmpdir(), "dito-evals-"));
  try {
    const twinId = randomUUID();
    const companyId = randomUUID();
    const seatId = randomUUID();
    const dek = createDekFromMaterial(randomBytes(32));
    const bundle: Bundle = createBundle(join(tmp, `${twinId}.bundle`), dek);
    const seat = { db, dek, twinId, companyId, seatId, bundle, embedder, hmacKey };
    // THE DAY IS READ BY RUNS OF THE SEAT'S EXTRACTION (ticket #364), and a
    // run moves only while its seat is linked.
    await seatTheTwin(db, { twinId, companyId, seatId });

    const runTag = freshRunTag();
    const placed: Placed[] = [];
    // ONE TWIN, ONE PASS, BOTH SLICES. A looking case that points at another
    // customer's order can only resolve if that customer is a chat of the
    // same rep, so the two slices are seeded together and the index that
    // makes each chat address unique runs across both (ticket #199).
    for (const [index, transcript] of [...transcripts, ...looking].entries()) {
      placed.push(await seedTranscript(seat, transcript, index, runTag));
    }

    // WHAT EACH CHAT-DAY COST, off the runner's own per-round account
    // (ticket #199; #177 hotfix 1's trace).
    //
    // KEYED BY RUN WHILE IT ARRIVES, BY CHAT AFTER (ticket #364). Each
    // chat-day is read by one child run of the day's extraction, and the
    // trace names the run, never the chat; the pass says afterwards which
    // chat each child read (`chatOfRun`). A chat-day re-asked by the lane is
    // read by a second child, so its row sums both — the record's own for a
    // day that needed one read and the sum of its reads' for a day that
    // needed more.
    const spentByRun = new Map<string, MutableCost>();
    /**
     * EVERY CANDIDATE A FILING THE APERTURE TOOK, BY RUN (tickets #218,
     * #364) — where the below-gate half is read back from now that no store
     * holds it.
     *
     * ONLY A `performed` CALL'S CANDIDATES ARE HERE. A refused call — a wire
     * the parser refused, a second filing of one chat-day — handed the
     * aperture nothing, and counting its candidates would fabricate drops
     * that never happened. A performed one committed with its step's own
     * transaction, so its drops were the aperture's whatever the step did
     * afterwards.
     */
    const submittedByRun = new Map<string, CandidateFact[]>();
    const trace: RuntimeTrace = (trigger, event) => {
      if (trigger.kind !== "run_step") return;
      const row = costFor(spentByRun, trigger.runId);
      if (event.kind === "message") {
        row.iterations += 1;
        row.tokensIn += event.tokens.input;
        row.tokensOut += event.tokens.output;
        return;
      }
      if (event.kind === "tool_call") {
        row.toolCalls += 1;
        // THE READS ARE THE PRICE OF LOOKING, and the filing is not one:
        // every read that files makes exactly one, so folding it in would put
        // a constant inside the number this ticket exists to measure.
        if (event.tool !== FILE_FACTS_TOOL) {
          row.reads += 1;
          return;
        }
        // ...AND THE FILING IS WHERE THE DROPS ARE (ticket #218), parsed by
        // the parser the tool parsed it with, so what this reads is what the
        // aperture was handed rather than a second reading of the wire.
        if (event.outcome !== "performed") return;
        const parsed = parseCandidateFacts(event.input);
        if (!parsed.ok) return;
        const seen = submittedByRun.get(trigger.runId) ?? [];
        seen.push(...parsed.facts.candidates);
        submittedByRun.set(trigger.runId, seen);
      }
    };

    const deps: DailyExtractionDeps = {
      db,
      executionPool,
      harness,
      bundle,
      dek,
      hmacKey,
      twinId,
      selfChatJid: SELF_CHAT,
      // THE SEARCH'S BOUNDARY, COMPOSED BY THE CALLER (ticket #199). The
      // extraction reads the rep's own history before it files (#196), and
      // the corpus now holds history to find — so which embedder runs decides
      // whether a resolution is a claim about retrieval anybody ships. See
      // `EvalRunOptions.embedder`.
      embedder,
      trace,
      // BOTH slots, deliberately. `extraction` is the one the pass uses
      // (ADR-0015's Haiku rung); `drafting` is its documented fallback,
      // and leaving it pointing somewhere else would make which model
      // this number describes depend on a `??`.
      drafting: { model },
      // THE EFFORT RIDES ON THE EXTRACTION SLOT ALONE (ticket #148).
      // `drafting` is the documented fallback and this pass never calls
      // it; the extraction harness is the only site that reads `effort`
      // today, so putting one on the other slot would record an arm no
      // request ever carried.
      extraction: { model, ...(effort === undefined ? {} : { effort }) },
      timeZone: EVAL_TIME_ZONE,
    };
    // THE ONE PLACE THE LANE DRIVES THE MODEL, and therefore the one place
    // a call that ended without the tool can be asked again (ticket #146).
    // The pass itself is untouched: the retry drives its own documented
    // recovery from an unsettled run. See `pass-retry.ts`.
    const { chatsRead, retriesByChat, chatOfRun } = await runPassWithNoToolRetries(
      deps,
      EVAL_NOW,
      announce,
    );
    const spent = byChat(spentByRun, chatOfRun, (into, more) => {
      into.toolCalls += more.toolCalls;
      into.reads += more.reads;
      into.iterations += more.iterations;
      into.tokensIn += more.tokensIn;
      into.tokensOut += more.tokensOut;
    });
    const submitted = byChat(submittedByRun, chatOfRun, (into, more) => {
      into.push(...more);
    });

    // What CROSSED, walked back to the message it was read in — through
    // `disclosure_lines.source_event_id`, which is a stored row and not an
    // inference. A fact the walk cannot place is a harness failure, not a
    // scoring outcome, so it throws rather than silently scoring as wrong.
    const eventToPlace = new Map<string, Placed>();
    for (const place of placed) {
      for (const eventId of place.eventToMessage.keys()) {
        eventToPlace.set(eventId, place);
      }
    }

    const facts = await readFiledFacts({ db, dek }, twinId);
    const crossings: ScoredCrossing[] = facts.map((fact) => {
      const place = eventToPlace.get(fact.sourceEventId);
      if (place === undefined) {
        throw new Error(
          `fact ${fact.id} cites seam event ${fact.sourceEventId}, which this run did not insert — the corpus and the Ledger disagree about what was read`,
        );
      }
      return {
        factId: fact.id,
        transcriptId: place.transcript.id,
        messageId: place.eventToMessage.get(fact.sourceEventId)!,
        factType: fact.factType,
        payload: fact.payload,
        disclosureText: fact.disclosureText,
        // The number the GATE judged, off the Ledger row (ticket #66). The
        // same stored-rows walk as everything else here — not the model's
        // own wire value re-read, but what the aperture recorded when it
        // decided this candidate could cross.
        confidence: fact.confidence,
      };
    });

    // ...and what the GATE STOPPED instead (ticket #218). Not in the
    // precision denominator — it never crossed — and reported beside it,
    // because a gate that stopped everything would post a beautiful
    // precision number about almost nothing.
    const dropped = droppedBelowGate(submitted, placed);
    // ...labelled once, over the same `placed` list the drops came from
    // (Codex r1): the drops and the answer sheet cannot be scoped apart if
    // they are read out of one place.
    const droppedRow = labelDrops({
      dropped,
      labels: placedLabels(placed.map((place) => place.transcript)),
    });

    // Sorted before scoring so the run is reproducible: with two identical
    // crossings, WHICH one is scored the duplicate is arbitrary, and the
    // report should not change between runs because Postgres returned them
    // in a different order.
    const ordered = [...crossings].sort(
      (a, b) =>
        a.transcriptId.localeCompare(b.transcriptId) ||
        a.messageId.localeCompare(b.messageId) ||
        a.factType.localeCompare(b.factType) ||
        a.factId.localeCompare(b.factId),
    );

    // TWO SLICES, SCORED APART BY BEING HANDED APART (ticket #199). The
    // overall number is over the ORIGINAL labels because the scorer is never
    // shown the others, which is a stronger guarantee than a partition
    // inside it: there is no path by which a looking day could reach the
    // figure the before/after pair is read from.
    const scoreOver = (
      wanted: readonly SeedTranscript[],
    ): {
      crossings: ScoredCrossing[];
      report: PrecisionReport;
    } => {
      const ids = new Set(wanted.map((t) => t.id));
      const mine = ordered.filter((c) => ids.has(c.transcriptId));
      return {
        crossings: mine,
        report: scoreCrossings({
          crossings: mine,
          labels: placedLabels(wanted),
          dropped: dropped.filter((drop) => ids.has(drop.transcriptId)),
          // EVERY transcript this run evaluated, not only the ones that
          // crossed something: a day the gate emptied is a real draw.
          clusterIds: wanted.map((t) => t.id),
        }),
      };
    };
    const original = scoreOver(transcripts);
    const lookingSlice = scoreOver(looking);

    return {
      report: original.report,
      looking: scoreLooking({
        report: lookingSlice.report,
        crossings: lookingSlice.crossings,
        transcripts: looking,
      }),
      crossings: ordered,
      dropped,
      droppedBelowGate: droppedRow,
      chatsRead,
      cost: costByTranscript(spent, placed),
      ...(await readPassCounts(db, twinId, placed)),
      // Named by TRANSCRIPT rather than by chat, like the pass counts
      // beside it: the chat JID is a per-run address nobody reading a
      // report can look anything up by, and the log has already said it.
      retries: retriesByTranscript(retriesByChat, placed),
      model,
      effort,
      // Read off the RUNTIME rather than restated, so the artifact can never
      // name a ceiling no request used (tickets #148, #194). The extraction
      // spec omits `maxTokens`, so `resolveBudget` fills in this number —
      // which makes it the ceiling every request of the run carried.
      maxTokens: DEFAULT_MAX_TOKENS,
    };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * The transcripts' labels, addressed by transcript — the answer sheet, in
 * the shape both the scorer and `labelDrops` read it.
 *
 * ONE HELPER, TWO CALLERS, and that is the point: the scorer is handed one
 * SLICE's labels on purpose, and the drop row is handed every chat the run
 * read. Two inline literals of this shape were how those two populations
 * drifted into one (Codex r1).
 */
function placedLabels(
  transcripts: readonly SeedTranscript[],
): PlacedLabel[] {
  return transcripts.flatMap((transcript) =>
    transcript.labels.map((label) => ({
      transcriptId: transcript.id,
      label,
    })),
  );
}

/**
 * EVERY CANDIDATE THE GATE STOPPED BELOW THE THRESHOLD, addressed by
 * transcript (ticket #218).
 *
 * CLASSIFIED BY THE APERTURE'S OWN `gateVerdict` and by nothing else, which
 * is the whole reason that function is exported: a copy of the gate here
 * could disagree with the one that actually ran, and the row exists to say
 * what the gate really dropped. What this cannot see is a REFUSAL — the
 * aperture refuses a malformed payload, a fact read on the wrong side of the
 * conversation or a message outside the window BEFORE the gate reads it, and
 * none of that is in the filing's own call. So these workings can OVER-count
 * against `extraction_runs.below_threshold`, and `renderDroppedBelowGate`
 * prints the pass's count as the one to quote and says by how much they
 * differ.
 *
 * THE UNRESOLVED REFERENCE IS NOT HERE. It is the gate's other ending and
 * it is counted apart on the run row for a reason (`PassCounts`), so folding
 * it in would make this row unable to say which of the two tests fired.
 */
function droppedBelowGate(
  submitted: ReadonlyMap<string, readonly CandidateFact[]>,
  placed: readonly Placed[],
): ObservedDrop[] {
  const drops: ObservedDrop[] = [];
  for (const place of placed) {
    for (const candidate of submitted.get(place.chatJid) ?? []) {
      const stopped = gateVerdict(candidate.reading, candidate.confidence);
      if (stopped?.outcome !== "below_threshold") continue;
      drops.push({
        transcriptId: place.transcript.id,
        // THE MODEL'S OWN CITATION, uncorrected. It is the id the corpus
        // uses, and the pass matches it back to a `wa_events` row — so a
        // candidate citing a message this day does not hold was refused
        // rather than dropped, which the over-count line accounts for.
        messageId: candidate.messageId,
        factType: candidate.factType,
        confidence: candidate.confidence,
        reading: candidate.reading,
      });
    }
  }
  return drops;
}

/**
 * One chat-day's running totals while the trace is still arriving — the
 * report's own shape with the `readonly` taken off, so the two cannot list
 * different fields.
 */
type MutableCost = { -readonly [K in keyof ChatDayCost]: ChatDayCost[K] };

/**
 * What was gathered by run, folded onto the chat each run read. A run the
 * pass did not name — none should exist — is a harness failure rather than a
 * row silently dropped.
 */
function byChat<T>(
  byRun: ReadonlyMap<string, T>,
  chatOfRun: ReadonlyMap<string, string>,
  fold: (into: T, more: T) => void,
): Map<string, T> {
  const out = new Map<string, T>();
  for (const [runId, value] of byRun) {
    const chatJid = chatOfRun.get(runId);
    if (chatJid === undefined) {
      throw new Error(`run ${runId} was traced, and the pass names no chat it read`);
    }
    const existing = out.get(chatJid);
    if (existing === undefined) out.set(chatJid, value);
    else fold(existing, value);
  }
  return out;
}

/** This run's row, created on its first event. */
function costFor(spent: Map<string, MutableCost>, key: string): MutableCost {
  const existing = spent.get(key);
  if (existing !== undefined) return existing;
  const fresh: MutableCost = {
    toolCalls: 0,
    reads: 0,
    iterations: 0,
    tokensIn: 0,
    tokensOut: 0,
  };
  spent.set(key, fresh);
  return fresh;
}

/** A chat-day nothing was traced for — no execution ran, or none was traced. */
const NO_COST: ChatDayCost = {
  toolCalls: 0,
  reads: 0,
  iterations: 0,
  tokensIn: 0,
  tokensOut: 0,
};

/**
 * What each chat-day cost, addressed by transcript (ticket #199).
 *
 * A chat JID carries a per-run tag, so it is meaningless in an artifact
 * somebody reads next month — the same reason the retries and the pass counts
 * are keyed on the transcript id.
 *
 * THE TOTAL IS SUMMED FROM THE PARTS, so a reader comparing them cannot find
 * two numbers about one run. A chat-day with no trace row contributes zeroes
 * rather than being absent, because a missing row reads as "fine".
 */
function costByTranscript(
  spent: ReadonlyMap<string, MutableCost>,
  placed: readonly Placed[],
): CostReport {
  const byTranscript: Record<string, ChatDayCost> = {};
  let total = NO_COST;
  for (const place of placed) {
    const row = spent.get(place.chatJid) ?? NO_COST;
    byTranscript[place.transcript.id] = { ...row };
    total = {
      toolCalls: total.toolCalls + row.toolCalls,
      reads: total.reads + row.reads,
      iterations: total.iterations + row.iterations,
      tokensIn: total.tokensIn + row.tokensIn,
      tokensOut: total.tokensOut + row.tokensOut,
    };
  }
  return { total, byTranscript };
}

/**
 * The retries this run spent, addressed the way a report addresses
 * everything else: by transcript (ticket #146).
 *
 * A chat JID carries a per-run tag (`freshRunTag`), so it is meaningless
 * in an artifact somebody reads next month — while a transcript id is what
 * the corpus, the labels and every other table in the report are keyed on.
 */
function retriesByTranscript(
  retriesByChat: ReadonlyMap<string, number>,
  placed: readonly Placed[],
): RetryCounts {
  const transcriptOf = new Map(
    placed.map((place) => [place.chatJid, place.transcript.id]),
  );
  const byTranscript: Record<string, number> = {};
  let total = 0;
  for (const [chatJid, spent] of retriesByChat) {
    const transcriptId = transcriptOf.get(chatJid);
    if (transcriptId === undefined) {
      // A HARNESS FAILURE, NOT A SCORING OUTCOME — the same rule the walks
      // above keep. The alternative is a per-run chat JID landing in a
      // committed artifact under a key nobody can look anything up by,
      // which is the exact address this function exists to replace.
      throw new Error(
        `chat ${chatJid} was retried but this run never seeded it — the retry count cannot be attributed to a transcript`,
      );
    }
    byTranscript[transcriptId] = spent;
    total += spent;
  }
  return { total, byTranscript };
}

/**
 * The pass's own account of what it saw (`PassCounts`) — per chat-day, and
 * summed.
 *
 * READ, NOT RECOMPUTED. The pass settles each chat's `extraction_runs` row
 * with the counts it observed, and this reads that row — so the numbers
 * come from the system under test rather than from the harness's second
 * opinion about it. A harness that counted candidates for itself would be
 * measuring its own arithmetic.
 *
 * PER CHAT-DAY IS NOT A CONVENIENCE (Codex r1). A refused candidate
 * reaches no store, so in the totals — and in both stores — it is
 * indistinguishable from a day the extractor said nothing about. The
 * per-chat row is the only thing that separates them, and that separation
 * is #66's third hypothesis.
 *
 * A chat with no row contributes an all-zero entry rather than being
 * absent: a MISSING day reads as "fine", the same rule the precision
 * table's fact types keep.
 */
async function readPassCounts(
  db: pg.Client,
  twinId: string,
  placed: readonly Placed[],
): Promise<{
  passCounts: PassCounts;
  passCountsByTranscript: Record<string, PassCounts>;
}> {
  const res = await db.query<{
    chat_jid: string;
    messages: string;
    candidates: string;
    filed: string;
    below_threshold: string;
    unresolved_reference: string;
    resolved_reference: string;
    refused: string;
  }>(
    `SELECT chat_jid,
            COALESCE(SUM(messages), 0)        AS messages,
            COALESCE(SUM(candidates), 0)      AS candidates,
            COALESCE(SUM(filed), 0)           AS filed,
            COALESCE(SUM(below_threshold), 0) AS below_threshold,
            COALESCE(SUM(unresolved_reference), 0) AS unresolved_reference,
            COALESCE(SUM(resolved_reference), 0)   AS resolved_reference,
            COALESCE(SUM(refused), 0)         AS refused
       FROM extraction_runs
      WHERE twin_id = $1
      GROUP BY chat_jid`,
    [twinId],
  );
  const byChat = new Map<string, PassCounts>(
    res.rows.map((row) => [
      row.chat_jid,
      {
        messages: Number(row.messages),
        candidates: Number(row.candidates),
        filed: Number(row.filed),
        belowThreshold: Number(row.below_threshold),
        unresolvedReference: Number(row.unresolved_reference),
        resolvedReference: Number(row.resolved_reference),
        refused: Number(row.refused),
      },
    ]),
  );

  const passCountsByTranscript: Record<string, PassCounts> = {};
  for (const place of placed) {
    passCountsByTranscript[place.transcript.id] =
      byChat.get(place.chatJid) ?? NO_RUN;
  }
  return {
    // Summed from the per-chat rows this run SEEDED, not from a second
    // query: two queries over one table can disagree, and a total that did
    // not equal its parts would be two numbers about one run.
    passCounts: Object.values(passCountsByTranscript).reduce(addCounts, NO_RUN),
    passCountsByTranscript,
  };
}

/** A chat-day the pass never settled a run for. */
const NO_RUN: PassCounts = {
  messages: 0,
  candidates: 0,
  filed: 0,
  belowThreshold: 0,
  unresolvedReference: 0,
  resolvedReference: 0,
  refused: 0,
};

function addCounts(a: PassCounts, b: PassCounts): PassCounts {
  return {
    messages: a.messages + b.messages,
    candidates: a.candidates + b.candidates,
    filed: a.filed + b.filed,
    belowThreshold: a.belowThreshold + b.belowThreshold,
    unresolvedReference: a.unresolvedReference + b.unresolvedReference,
    resolvedReference: a.resolvedReference + b.resolvedReference,
    refused: a.refused + b.refused,
  };
}

/**
 * What every transcript is seeded into: one twin, its bundle, its DEK, the
 * embedder its history is vectorized through and the chain key its binding
 * ceremony files under.
 *
 * The last two ride here rather than as parameters beside it (ticket #199):
 * they are the run's, not the transcript's, and `seedTranscript` was already
 * carrying four positional arguments.
 */
interface Seat {
  readonly db: pg.Client;
  readonly dek: Dek;
  readonly twinId: string;
  readonly companyId: string;
  readonly seatId: string;
  readonly bundle: Bundle;
  readonly embedder: Embedder;
  /** Chain key for the binding ceremony's entity creates (ADR-0020). */
  readonly hmacKey: Uint8Array;
}

/**
 * One transcript → one bound customer chat carrying its day.
 *
 * THE BINDING IS PART OF THE FIXTURE, not skipped. Extraction enumerates
 * BOUND chats (ADR-0033 mechanized by enumeration, spec #48 decision 4),
 * so a chat that was never bound is never read — and the confirmation is
 * also what mints the entity every fact must attach to (FR-32, absolute).
 * Its own two seam rows sit the day BEFORE THIS TRANSCRIPT'S OWN WINDOW,
 * outside it, so the ceremony that named a customer is not part of the day
 * extracted. On a carried-in day (`owedFromDaysAgo`, ticket #139) that is
 * earlier than every other transcript's: a fixed instant would have put
 * «buenas» and the rep's «si» INSIDE the window this chat is read over,
 * and an unlabelled greeting the model reads is a message the corpus's own
 * partition does not account for.
 *
 * WHAT IT DOES NOT DO IS POST. The twin writes no `system_send` here, so
 * this fixture is deliberately NOT a corpus for the ADR-0033 exclusion
 * invariant, which derives a twin's own thread from its posts and would
 * report an unpostable twin as uncheckable. That invariant has its own
 * corpus in the integration lane, over a twin that did post. Keeping the
 * eval fixture to the rows extraction actually reads is also what lets it
 * import nothing off the twin-runtime's private surface.
 *
 * AND THE HISTORY GOES SOMEWHERE ELSE ENTIRELY (ticket #199): the day goes
 * to the SEAM, where a fact must cite it, and the earlier days go to TWIN
 * MEMORY, where a search can find them and no candidate can name them.
 */
async function seedTranscript(
  seat: Seat,
  transcript: SeedTranscript,
  index: number,
  runTag: string,
): Promise<Placed> {
  const { db, dek, twinId, companyId, seatId, bundle, hmacKey } = seat;
  // Unique per transcript AND per run, and that is what lets the corpus's
  // own message ids ride onto the seam UNCHANGED. The seam dedupes on
  // `(source, external_event_id)` composed as `<chat jid>:<message id>`
  // globally across twins (ADR-0005); with the chat side already unique
  // per run, the message side does not have to be mangled — so a scripted
  // model cites `Q1-04`, a report names `Q1-04`, and a reviewer reading
  // the corpus is reading the same string the seam carried.
  //
  // ...unless the transcript PINS its address, which one does: a day whose
  // claim is that a counterparty's own number establishes no contact needs
  // the chat to actually have that number. It is safe to pin because the
  // lane resets the seam before it seeds.
  const chatJid =
    transcript.chatSubscriber === undefined
      ? `52155${String(200000 + index).padStart(6, "0")}${runTag}@s.whatsapp.net`
      : `52${transcript.chatSubscriber}@s.whatsapp.net`;

  await db.query(
    "INSERT INTO scope_allowlist (twin_id, chat_jid) VALUES ($1, $2)",
    [twinId, chatJid],
  );

  // WHERE THIS CHAT'S WINDOW OPENS, and for all but a carried-in day that
  // is the corpus day's own midnight (ticket #139). Six hours before it is
  // where the binding ceremony goes — see this function's docblock.
  const windowStart = new Date(dayStartUtcOf(transcript));
  const boundAt = new Date(windowStart.getTime() - 6 * 60 * 60 * 1000);

  const entityId = randomUUID();
  const short = entityId.slice(0, 8);
  await insertWaEventFixture(db, dek, {
    twinId,
    companyId,
    seatId,
    chatJid,
    senderJid: chatJid,
    fromMe: false,
    messageId: `EVAL-ASK-${short}`,
    text: "buenas",
    pushName: transcript.counterparty,
    occurredAt: boundAt,
  });
  const confirmMessageId = `EVAL-SI-${short}`;
  const confirmEventId = await insertWaEventFixture(db, dek, {
    twinId,
    companyId,
    seatId,
    chatJid: SELF_CHAT,
    senderJid: SELF_CHAT,
    fromMe: true,
    messageId: confirmMessageId,
    text: "si",
    quotedMessageId: "EVAL-QUESTION",
    occurredAt: boundAt,
  });
  bundle.confirmChatBinding({
    chatJid,
    entityId,
    displayName: transcript.counterparty,
    confirmedAt: boundAt.toISOString(),
  });
  await fileEntityCreate(
    { db, dek, hmacKey },
    {
      twinId,
      entityId,
      kind: "person",
      displayName: transcript.counterparty,
      evidence: { surface: "twin_thread", sourceEventId: confirmEventId, waMessageId: confirmMessageId },
      disclosureText: "Lo di de alta como cliente.",
    },
  );

  await rememberHistory(seat, transcript, chatJid);

  const eventToMessage = new Map<string, string>();
  for (const message of transcript.messages) {
    const eventId = await insertWaEventFixture(db, dek, {
      twinId,
      companyId,
      seatId,
      chatJid,
      senderJid: message.fromMe ? SELF_CHAT : chatJid,
      fromMe: message.fromMe,
      messageId: message.id,
      text: message.text,
      occurredAt: new Date(DAY_START_UTC + message.atMinute * 60_000),
    });
    eventToMessage.set(eventId, message.id);
  }

  // THE DEBT, WRITTEN THE WAY THE PASS ITSELF WRITES ONE (ticket #139).
  //
  // A carried-in day is not a second clock and not a second pass: it is a
  // chat the runtime CLAIMED on an earlier day and never filed — a run
  // that died between the model call and the filing — and the only trace
  // that leaves is an unsettled `extraction_runs` row whose `window_start`
  // is where the unread window began. `readWatermarks` takes the earliest
  // such start as this chat's `owedFrom`, so today's pass reads from there
  // instead of from today's midnight, and the transcript's beats land on
  // the rep days they were actually said on.
  //
  // `submitted` rather than `deferred`: a deferred run is an UNBOUND chat
  // waiting for its binding proposal (FR-32), and every chat here is bound
  // the day before its own window. Its counts stay zero, which is what the
  // table's own `settled_check` and the filing constraints expect of a run
  // that never reached the aperture.
  if (transcript.owedFromDaysAgo !== undefined) {
    await db.query(
      `INSERT INTO extraction_runs
         (twin_id, chat_jid, extraction_day, state, window_start, window_end)
       VALUES ($1, $2, $3, 'submitted', $4, $5)`,
      [
        twinId,
        chatJid,
        civilDate(windowStart, EVAL_TIME_ZONE),
        windowStart,
        // Where that abandoned run had read to when it died: its own
        // evening, at the hour THIS LANE triggers its pass, cut the same
        // minute short the live pass cuts. Both come off `clock.ts` rather
        // than being restated — a copy of the trigger hour drifts the day
        // somebody moves `EVAL_NOW`, and the window would silently stop
        // matching the one the lane actually reads.
        new Date(
          windowStart.getTime() +
            (EVAL_NOW.getTime() - DAY_START_UTC) -
            SEAM_SETTLING_LAG_MS,
        ),
      ],
    );
  }

  return { transcript, chatJid, eventToMessage };
}

/**
 * THE EARLIER DAYS, IN TWIN MEMORY AND EMBEDDED (ticket #199).
 *
 * WRITTEN THE WAY INGEST WRITES ONE, which is the only way a search can find
 * it: the row into the bundle's message store, then its vector through the
 * embedder this run composed (`backlog.ts` is the shape). The daily pass
 * reads the seam and never writes twin memory, and these suites drive the
 * pass alone — so if the fixture did not do this, twin memory would be empty
 * and every search would come back «No message in the rep's history matched»,
 * which is exactly the state #206's remainder 5 recorded.
 *
 * NOT THE SEAM, EVER. A history beat has no `wa_events` row, so it has no id
 * a candidate could cite and no window it could fall inside: ADR-0038's rule
 * that a fact is read in the day's own message is kept by there being nothing
 * else to read it in. It is also what makes the earlier days show up under
 * the pass's "already handled" heading rather than among the day's beats.
 *
 * ONE EMBED CALL PER TRANSCRIPT, because the live lane's embedder is BGE-M3
 * in-process: eighty-odd separate invocations would pay the batch overhead
 * eighty times for no reason the measurement can see.
 */
async function rememberHistory(
  seat: Seat,
  transcript: SeedTranscript,
  chatJid: string,
): Promise<void> {
  const history = transcript.history ?? [];
  if (history.length === 0) return;
  const vectors = await embedAll(
    seat.embedder,
    history.map((message) => message.text),
  );
  for (const [index, message] of history.entries()) {
    const stored = seat.bundle.ingestMessage({
      chatJid,
      messageId: message.id,
      senderJid: message.fromMe ? SELF_CHAT : chatJid,
      fromMe: message.fromMe,
      occurredAt: new Date(DAY_START_UTC + message.atMinute * 60_000).toISOString(),
      content: message.text,
    });
    seat.bundle.writeMessageVector(stored.storeId, vectors[index]!);
  }
}
