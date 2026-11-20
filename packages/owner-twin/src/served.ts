/**
 * THE SERVED MAP: every row any tool returned this run, by reference
 * (ticket #130; spec #126 decision 18; ADR-0013 as amended — "the surface
 * renders provenance from the rows the tool returned, refusing any citation
 * to a row it never served").
 *
 * The prior art is the self-chat Q&A's `served` map (`qa.ts`), and the rule
 * it enforces is the same one: "a ref the retrieval never returned cannot
 * become a citation". This is the EXECUTION's own record — not the
 * model's, not the database's — and it is the only thing a citation may
 * resolve against.
 *
 * TWO REFERENCES, ONE ROW, AND THEY ARE NOT THE SAME NUMBER. This is the
 * decision #129 and #134 left to be made here, so it is written down rather
 * than implied:
 *
 *   THE WIRE REFERENCE is a small integer scoped to this one run — 1, 2, 3
 *   — and it is what the model cites. A model cites `3` reliably and a UUID
 *   unreliably, and a run-scoped number cannot be FORGED FROM A PREVIOUS
 *   ANSWER: the owner's earlier turns are handed in as context, so a model
 *   that read `[2]` in yesterday's answer and cited `2` today is citing
 *   whatever this run happened to serve second, and the refusal below is
 *   what stops that meaning anything.
 *
 *   THE PERSISTED REFERENCE is the row's own id — the fact's id, the
 *   entity's id, the count's descriptor. `owner.answers.refs` stores THOSE,
 *   so a stored answer re-renders from the Ledger by id rather than from
 *   stored markup, and reads today's provenance for the fact rather than a
 *   snapshot of yesterday's.
 *
 * #129's `OwnerFact.id` doc comment calls the fact's own id "THE STABLE
 * REFERENCE … never an index into a result", and that is true of the layer
 * it describes: the id is what the answer means. This map is what translates
 * between the two, and the refusal is checked on the WIRE ref, before any
 * translation, because "this run never served that" is the property being
 * claimed.
 *
 * FOUR SERVED SHAPES IN TWO REFERENCE CLASSES, because the room renders
 * two (#134, variant A, and the element list it left #131):
 *
 *   a PROVENANCE VALUE — a served fact, and a count. Rendered as a washed
 *   span with a gutter square, and cited in the receipt strip at the
 *   bubble's foot.
 *
 *   a REFERENCE NAME — an entity, and a seat. Rendered as a name in
 *   jacaranda ink, no square, no receipt line: it is a thing the tools
 *   resolved rather than a value they read.
 *
 * Four shapes rather than two because what code renders differs inside each
 * class — a fact's receipt line names its confidence, a count's says the
 * window is closed instead (a count has no single confidence) — and a
 * renderer that could not tell them apart would have to guess.
 */
import {
  renderOwnerEntityName,
  type OwnerEntity,
  type OwnerFact,
  type OwnerSeat,
} from "@dito/aperture";

/**
 * What a count tool call counted — the descriptor, not just the number.
 *
 * IT IS A ROW LIKE ANY OTHER, and that is the point of giving it a shape:
 * the count's own window and seat are what its receipt line renders, and an
 * answer citing a count that could not say which window it counted would be
 * a number with no provenance at all.
 */
export interface ServedCount {
  readonly factType: string;
  readonly from: Date | null;
  readonly to: Date | null;
  readonly seatId: string | null;
  /**
   * ...and that seat's display name, carried beside its id because the
   * receipt line renders the name and a count row is the one served shape
   * that cannot be joined back to anything. Null when the count was over
   * every seat.
   */
  readonly seatName: string | null;
  readonly count: number;
}

/** One row this run served, under the wire reference the model cites. */
export type ServedRow =
  | { readonly ref: number; readonly kind: "fact"; readonly fact: OwnerFact }
  | { readonly ref: number; readonly kind: "entity"; readonly entity: OwnerEntity }
  | { readonly ref: number; readonly kind: "seat"; readonly seat: OwnerSeat }
  | { readonly ref: number; readonly kind: "count"; readonly count: ServedCount };

/** The four kinds, as a type, so a renderer's switch is exhaustive. */
export type ServedKind = ServedRow["kind"];

/**
 * Which of #134's two classes a served row renders as. Derived from the
 * kind rather than stored beside it, so a fifth shape has to answer the
 * question rather than inherit an answer.
 */
export function referenceClass(
  kind: ServedKind,
): "provenance-value" | "reference-name" {
  return kind === "fact" || kind === "count"
    ? "provenance-value"
    : "reference-name";
}

/**
 * The rows one execution served, in the order it served them.
 *
 * A CLASS RATHER THAN A MAP, because the identity rule is the whole value
 * here: serving the same row twice returns the same reference. Two tool
 * calls whose results overlap — a timeline read narrowed by fact type after
 * an unnarrowed one — would otherwise hand the model two numbers for one
 * fact, and an answer citing both would render the same receipt line twice.
 */
export class ServedRows {
  /**
   * The rows a STORED answer cited, put back under the references it cited
   * them by (ticket #131).
   *
   * A SEPARATE CONSTRUCTOR RATHER THAN A METHOD, because the two maps are
   * two different things and mixing them would be a bug with no error. A
   * live map is minted by tools and is the fence the guard checks a
   * answer against; this one is read back out of `owner.answers.refs`
   * for a turn whose run ended long ago, and nothing is served into it. So
   * it carries no identities, no ambiguity groups and no read counts — the
   * questions those answer belong to the run that is over.
   *
   * THE REFERENCES ARE THE STORED ONES AND NOT NEW ONES. The prose kept
   * beside them holds `[[3]]` slots, so a rebuild that re-minted references
   * from 1 would fill the wrong slots with the right rows — the one failure
   * this rebuild has to be incapable of, and the one the scroll's suite
   * shows biting.
   */
  static restored(rows: readonly ServedRow[]): ServedRows {
    const served = new ServedRows();
    for (const row of rows) served.#restore(row);
    return served;
  }

  readonly #byRef = new Map<number, ServedRow>();
  readonly #byIdentity = new Map<string, number>();
  readonly #ambiguityGroup = new Map<number, number>();
  #groups = 0;
  #next = 1;
  #resolutions = 0;
  #recordReads = 0;

  /**
   * A read finished and returned whatever it found — including nothing.
   *
   * NOT THE SAME QUESTION AS "DID IT SERVE A ROW", and the difference is
   * the whole of the self-chat Q&A's rule (`qa.ts`: "rejected: search_memory
   * before answering, so the answer rests on the rep's real history"). A
   * turn that consulted the record and found nothing may say so; a turn
   * that consulted nothing may not say anything about the record at all,
   * because whatever it would say came from somewhere else. An argument a
   * tool REJECTED never reaches here: a refused argument consulted nothing.
   *
   * BY KIND, AND NOT AS A COUNTER (Codex r2). It was one number, and the
   * grounding rule let an answer through once it reached two — so calling
   * `resolve_entity` TWICE for the same customer bought the model the right
   * to answer about them without ever opening their record. Looking up who
   * somebody is and reading what the record holds about them are different
   * acts, and the rule needs to tell them apart rather than add them up.
   */
  noteResolution(): void {
    this.#resolutions += 1;
  }

  /** ...and a read of the record itself: a timeline, or a count. */
  noteRecordRead(): void {
    this.#recordReads += 1;
  }

  /** Whether any tool at all finished this turn. */
  get readsCompleted(): number {
    return this.#resolutions + this.#recordReads;
  }

  /** ...and whether the record itself was opened, not merely searched. */
  get recordReads(): number {
    return this.#recordReads;
  }

  /** One fact, and the reference the model may cite it by. */
  serveFact(fact: OwnerFact): number {
    return this.#serve(`fact:${fact.id}`, (ref) => ({
      ref,
      kind: "fact",
      fact,
    }));
  }

  /**
   * One resolved name — a cliente the tools found for something typed.
   *
   * `ambiguous` MARKS A RECORD ONE OF SEVERAL THAT MATCHED (Codex r1). A
   * name that resolved to two is ADR-0039's one legitimate ask, and until
   * this the ask was instructed and nothing else: the model could pick one
   * of the two, read its timeline and answer about whichever it happened to
   * choose. The mark travels with the row so the timeline read can refuse
   * it, and it is per-CALL rather than per-row: the same record resolved
   * unambiguously by its full name later in the same turn is no longer one
   * of several, and the mark clears.
   */
  serveEntity(entity: OwnerEntity, options: { ambiguityGroup?: number } = {}): number {
    const ref = this.#serve(`entity:${entity.entityId}`, (built) => ({
      ref: built,
      kind: "entity",
      entity,
    }));
    if (options.ambiguityGroup === undefined) this.#ambiguityGroup.delete(ref);
    else this.#ambiguityGroup.set(ref, options.ambiguityGroup);
    return ref;
  }

  /**
   * A number naming the ONE resolution this record came out of, when that
   * resolution matched more than one — or nothing, when it matched only it.
   *
   * A GROUP AND NOT A FLAG (Codex r3). A boolean said "this record was one
   * of several" and could not say WHICH several, so an ask could offer one
   * candidate from each of two different ambiguous names — two customers
   * the owner never asked to choose between. ADR-0039's ask is about ONE
   * name that matched more than one record, and a group id is what makes
   * "one name" checkable.
   */
  ambiguityGroup(ref: number): number | undefined {
    return this.#ambiguityGroup.get(ref);
  }

  /** Every record one ambiguous resolution served, so an ask can offer them all. */
  ambiguityGroupMembers(group: number): readonly number[] {
    return [...this.#ambiguityGroup.entries()]
      .filter(([, id]) => id === group)
      .map(([ref]) => ref)
      .sort((a, b) => a - b);
  }

  /** The next group id, taken by a resolution that matched more than one. */
  nextAmbiguityGroup(): number {
    this.#groups += 1;
    return this.#groups;
  }

  /** Whether this record arrived as one of several matching one name. */
  isAmbiguous(ref: number): boolean {
    return this.#ambiguityGroup.has(ref);
  }

  /** One resolved name — the seat a count was narrowed to. */
  serveSeat(seat: OwnerSeat): number {
    return this.#serve(`seat:${seat.seatId}`, (ref) => ({
      ref,
      kind: "seat",
      seat,
    }));
  }

  /**
   * One count, keyed by what it counted.
   *
   * The identity is the DESCRIPTOR and not the number: two calls with the
   * same fact type, window and seat are the same question asked twice, and
   * if they disagreed about the number the second read a different database
   * than the first — which is not a thing two references would fix.
   */
  serveCount(count: ServedCount): number {
    const key = [
      "count",
      count.factType,
      count.from?.toISOString() ?? "",
      count.to?.toISOString() ?? "",
      count.seatId ?? "",
    ].join(":");
    return this.#serve(key, (ref) => ({ ref, kind: "count", count }));
  }

  /** The row behind a reference, or nothing — which is the refusal. */
  get(ref: number): ServedRow | undefined {
    return this.#byRef.get(ref);
  }

  /** Every row served this run, in the order it was served. */
  all(): readonly ServedRow[] {
    return [...this.#byRef.values()];
  }

  get size(): number {
    return this.#byRef.size;
  }

  /**
   * Every NAME this run put in front of the model — an entity's display
   * name, and a seat's.
   *
   * The structural guard reads this: a name the model typed verbatim into
   * its prose is a name it was supposed to reference, and code was supposed
   * to render (ADR-0037 as amended — "the model never types a number, a
   * date, a name or a source"). A seat name arrives through a fact rather
   * than through the resolution tool, so both sources are here.
   *
   * AS RENDERED, NOT AS STORED (#129's `renderOwnerEntityName`). What the
   * model was shown is the rendered form, so that is the string it could
   * copy; the stored form of a wall-shaped name is a run of digits, which
   * the guard already refuses on its own.
   */
  servedNames(): readonly string[] {
    const names: string[] = [];
    for (const row of this.#byRef.values()) {
      if (row.kind === "entity") {
        names.push(renderOwnerEntityName(row.entity.displayName));
      }
      if (row.kind === "seat") names.push(row.seat.displayName);
      if (row.kind === "fact" && row.fact.filedBySeatName !== null) {
        names.push(row.fact.filedBySeatName);
      }
    }
    return names;
  }

  /** One row back under the reference it already had; see `restored`. */
  #restore(row: ServedRow): void {
    this.#byRef.set(row.ref, row);
    if (row.ref >= this.#next) this.#next = row.ref + 1;
  }

  #serve(identity: string, build: (ref: number) => ServedRow): number {
    const already = this.#byIdentity.get(identity);
    if (already !== undefined) return already;
    const ref = this.#next;
    this.#next += 1;
    this.#byIdentity.set(identity, ref);
    this.#byRef.set(ref, build(ref));
    return ref;
  }
}

/**
 * The persisted form of one reference: the row's own id, kept beside the
 * wire ref that pointed at it.
 *
 * `ref` IS KEPT DELIBERATELY, even though it means nothing outside its run.
 * The prose stored beside it holds `[[3]]` slots, and a stored answer is
 * re-rendered by filling those slots — so the number the prose names has to
 * be resolvable to the id the room re-reads. It is a coordinate inside one
 * answer, and it is never resolved against a later run's map.
 */
export type PersistedReference =
  | { readonly ref: number; readonly kind: "fact"; readonly factId: string }
  | { readonly ref: number; readonly kind: "entity"; readonly entityId: string }
  | { readonly ref: number; readonly kind: "seat"; readonly seatId: string }
  | {
      readonly ref: number;
      readonly kind: "count";
      readonly count: {
        readonly factType: string;
        readonly from: string | null;
        readonly to: string | null;
        readonly seatId: string | null;
        readonly seatName: string | null;
        readonly count: number;
      };
    };

/** One served row, as `owner.answers.refs` keeps it. */
export function persistedReference(row: ServedRow): PersistedReference {
  switch (row.kind) {
    case "fact":
      return { ref: row.ref, kind: "fact", factId: row.fact.id };
    case "entity":
      return { ref: row.ref, kind: "entity", entityId: row.entity.entityId };
    case "seat":
      return { ref: row.ref, kind: "seat", seatId: row.seat.seatId };
    case "count":
      return {
        ref: row.ref,
        kind: "count",
        count: {
          factType: row.count.factType,
          from: row.count.from?.toISOString() ?? null,
          to: row.count.to?.toISOString() ?? null,
          seatId: row.count.seatId,
          seatName: row.count.seatName,
          // THE NUMBER IS STORED, and it is the one value here that is not
          // an id. A count is derived rather than filed: there is no row in
          // the Ledger to re-read it from, only the same query run again
          // over a window that has since gained facts. So the answer keeps
          // what it actually said, which is what "the room re-renders the
          // stored answer" has to mean for a value nothing else holds.
          count: row.count.count,
        },
      };
  }
}
