/**
 * THE SCROLL: this owner's earlier turns, re-rendered from the Ledger
 * (ticket #131; #134's cleared prototype — "one thread; the scroll is the
 * history").
 *
 * NOT `readOwnerTurns`, AND THE DIFFERENCE IS THE WHOLE OF WHY THIS EXISTS.
 * That reader hands the next execution its context: the questions and the
 * prose of the answers, with every `[[N]]` slot left standing and neutralised
 * on the way in, because a reference belonged to the run that served it.
 * This one draws the same rows for a person, so every slot has to be filled
 * again — and it is filled from the RECORD, by re-reading each id the answer
 * kept, never from anything stored looking like the page. Nothing HTML is
 * ever written, which is what makes «the answer you were given» and «what
 * the Ledger holds now» the same sentence rather than two.
 *
 * ONE RENDERER, NOT TWO. A stored answer row is rebuilt into the answer it
 * was and handed to `renderOwnerTurn` — the same function the live turn goes
 * through — so a turn cannot read differently for having been read before.
 * The rebuild is exact: the references come back under the numbers the prose
 * slots (`ServedRows.restored`), and the roles `owner.answers.refs` keeps say
 * which of them were the ask's choices, the refusal's pointer and the count.
 *
 * AND A TURN THAT CANNOT BE RE-RENDERED SAYS SO RATHER THAN GUESSING. Two
 * ways that happens, and they are different statements the room makes in
 * different words: an execution that produced no answer at all (the
 * structural guard refused it; ADR-0014 as amended requires the record and
 * its audit entry, and there is no answer row beside them), and an answer
 * whose rows the Ledger no longer returns — a fact taken back after it was
 * cited, a company whose flag went down. `renderOwnerTurn` already refuses
 * an unserved reference loudly, so the second case is exactly its own
 * refusal caught here rather than a second rule invented beside it.
 *
 * NO SENTENCE IN THIS FILE. What the room says about either case is the
 * room's chrome (ADR-0037 as amended exempts the owner web's chrome by
 * name); what is here is the structure under it, in the shape `render.ts`
 * returns.
 */
import {
  readOwnerEntitiesByIds,
  readOwnerFactsByIds,
  readOwnerSeatsByIds,
  type OwnerEntity,
  type OwnerFact,
  type OwnerSeat,
} from "@dito/aperture";
import type pg from "pg";
import {
  OwnerRenderError,
  renderOwnerTurn,
  type RenderedOwnerTurn,
} from "./render.js";
import { ServedRows, type ServedRow } from "./served.js";
import {
  asAnswerKind,
  OWNER_TWIN_HISTORY_TURNS,
  type ReferenceRole,
  type StoredReference,
} from "./store.js";
import type { OwnerAnswer } from "./answer.js";

/** Why a stored turn has no rendered answer beside it. */
export type OwnerTurnUnrendered =
  /** The execution left a record and an audit entry, and no answer. */
  | "no-answer"
  /** The answer is there and a row it cited is gone from the Ledger. */
  | "row-gone";

/**
 * The scroll, and how many turns the thread has in all.
 *
 * THE TOTAL TRAVELS WITH THEM because the cap must not be SILENT (Codex r2)
 * — the same reason `OwnerConversation` carries it for the model. An owner
 * who has asked two hundred questions sees the last twenty, and a page that
 * did not say so would be claiming to be the whole history while being a
 * window on it. Paging past the window is recorded rather than built.
 */
export interface OwnerRoom {
  readonly turns: readonly OwnerRoomTurn[];
  readonly turnsInAll: number;
}

/** One turn of the scroll: what the owner asked, and what came back. */
export interface OwnerRoomTurn {
  readonly questionId: string;
  readonly askedAt: Date;
  /** The owner's own words, as they were recorded. */
  readonly question: string;
  /** The turn, re-rendered — or the reason there is none to draw. */
  readonly answer:
    | { readonly rendered: RenderedOwnerTurn }
    | { readonly unrendered: OwnerTurnUnrendered };
}

/**
 * This owner's turns, oldest first, ready to draw.
 *
 * THE SAME CAP AS THE CONTEXT (`OWNER_TWIN_HISTORY_TURNS`). The scroll and
 * what the next execution is shown are then the same twenty turns, so the
 * owner is never reading a turn the twin has stopped being able to see —
 * which is the one way a thread and a conversation can silently disagree.
 * What the cap must not be is UNSAID: `turnsInAll` travels back so the room
 * can name what it is not showing. A longer scroll wants paging, and paging
 * is recorded rather than guessed at.
 *
 * THE COMPANY IS THE CONNECTION'S, through the policy on both tables and on
 * every view the re-read goes through. There is no company parameter here
 * for the reason there is none on the reads underneath it.
 */
export async function readOwnerRoomTurns(
  client: pg.ClientBase,
  options: { readonly timeZone: string },
): Promise<OwnerRoom> {
  const res = await client.query<StoredTurnRow>(
    `SELECT q.id, q.asked_at, q.text,
            a.kind, a.prose, a.follow_up, a.refs
       FROM (SELECT * FROM owner.questions
              ORDER BY asked_at DESC, id DESC
              LIMIT $1) q
       LEFT JOIN owner.answers a ON a.owner_question_id = q.id
      ORDER BY q.asked_at, q.id`,
    [OWNER_TWIN_HISTORY_TURNS],
  );

  // EVERY ID THIS PAGE NEEDS, IN THREE READS RATHER THAN THREE PER TURN. The
  // scroll cites the same cliente over and over — that is what a
  // conversation is — so the ids are gathered across the whole page first.
  const rows = await readCitedRows(client, res.rows);
  const total = await client.query<{ n: string }>(
    "SELECT count(*) AS n FROM owner.questions",
  );

  return {
    turns: res.rows.map((row) => ({
      questionId: row.id,
      askedAt: new Date(row.asked_at),
      question: row.text,
      answer: renderStoredAnswer(row, rows, options.timeZone),
    })),
    turnsInAll: Number(total.rows[0]!.n),
  };
}

/** One turn as the two tables keep it; the answer's half is null when it failed. */
interface StoredTurnRow {
  id: string;
  asked_at: Date | string;
  text: string;
  kind: string | null;
  prose: string | null;
  follow_up: string | null;
  refs: StoredReference[] | null;
}

/** Every Ledger row the whole page cites, by id, in one read per kind. */
interface CitedRows {
  readonly facts: ReadonlyMap<string, OwnerFact>;
  readonly entities: ReadonlyMap<string, OwnerEntity>;
  readonly seats: ReadonlyMap<string, OwnerSeat>;
}

async function readCitedRows(
  client: pg.ClientBase,
  turns: readonly StoredTurnRow[],
): Promise<CitedRows> {
  const factIds = new Set<string>();
  const entityIds = new Set<string>();
  const seatIds = new Set<string>();
  for (const turn of turns) {
    for (const reference of turn.refs ?? []) {
      if (reference.kind === "fact") factIds.add(reference.factId);
      if (reference.kind === "entity") entityIds.add(reference.entityId);
      if (reference.kind === "seat") seatIds.add(reference.seatId);
      // A COUNT'S SEAT IS A ROW LIKE ANY OTHER (the two-axis review's Spec
      // axis). The number a count carries is not re-readable — there is no
      // row in the Ledger to read it from — but the seat it was narrowed to
      // is `public.seats_status`'s, and a rep who has been renamed must not
      // re-render under the name they had.
      if (reference.kind === "count" && reference.count.seatId !== null) {
        seatIds.add(reference.count.seatId);
      }
    }
  }
  const [facts, entities, seats] = await Promise.all([
    readOwnerFactsByIds(client, [...factIds]),
    readOwnerEntitiesByIds(client, [...entityIds]),
    readOwnerSeatsByIds(client, [...seatIds]),
  ]);
  return {
    facts: new Map(facts.map((fact) => [fact.id, fact])),
    entities: new Map(entities.map((entity) => [entity.entityId, entity])),
    seats: new Map(seats.map((seat) => [seat.seatId, seat])),
  };
}

/** One stored answer, back through the live renderer — or the reason it is not. */
function renderStoredAnswer(
  row: StoredTurnRow,
  rows: CitedRows,
  timeZone: string,
): OwnerRoomTurn["answer"] {
  if (row.kind === null || row.prose === null) {
    return { unrendered: "no-answer" };
  }
  const served = ServedRows.restored(
    (row.refs ?? [])
      .map((reference) => servedRow(reference, rows))
      .filter((served): served is ServedRow => served !== null),
  );
  try {
    return {
      rendered: renderOwnerTurn(storedAnswer(row), served, timeZone),
    };
  } catch (error) {
    // THE RENDERER'S OWN REFUSAL, AND ONLY IT. `renderOwnerTurn` throws
    // exactly when a reference has no row behind it, which here means the
    // Ledger stopped returning one — the case this branch is about. Anything
    // else is a bug in this process and stays loud.
    if (error instanceof OwnerRenderError) return { unrendered: "row-gone" };
    throw error;
  }
}

/** The row one stored reference names, or nothing when the Ledger has none. */
function servedRow(reference: StoredReference, rows: CitedRows): ServedRow | null {
  switch (reference.kind) {
    case "fact": {
      const fact = rows.facts.get(reference.factId);
      return fact === undefined
        ? null
        : { ref: reference.ref, kind: "fact", fact };
    }
    case "entity": {
      const entity = rows.entities.get(reference.entityId);
      return entity === undefined
        ? null
        : { ref: reference.ref, kind: "entity", entity };
    }
    case "seat": {
      const seat = rows.seats.get(reference.seatId);
      return seat === undefined
        ? null
        : { ref: reference.ref, kind: "seat", seat };
    }
    case "count": {
      // THE NUMBER IS NOT RE-READ, AND `served.ts` SAYS WHY AT ITS
      // DEFINITION: a count is derived rather than filed, so there is no row
      // in the Ledger to read it from — only the same question asked again
      // over a window that has since gained facts. The answer keeps what it
      // actually said.
      //
      // THE SEAT IT WAS NARROWED TO IS RE-READ, because that one IS a row.
      // A seat the view no longer returns leaves this reference with no row
      // behind it, exactly as a vanished fact does, and the turn says it
      // cannot be shown rather than rendering a name off the store.
      const seatId = reference.count.seatId;
      if (seatId !== null && !rows.seats.has(seatId)) return null;
      return {
        ref: reference.ref,
        kind: "count",
        count: {
          factType: reference.count.factType,
          from:
            reference.count.from === null
              ? null
              : new Date(reference.count.from),
          to: reference.count.to === null ? null : new Date(reference.count.to),
          seatId,
          seatName: seatId === null ? null : rows.seats.get(seatId)!.displayName,
          count: reference.count.count,
        },
      };
    }
  }
}

/**
 * The answer a row was, rebuilt from its three columns and its
 * references.
 *
 * THE ROLES ARE WHAT MAKE THIS EXACT. `storedReferences` writes down what
 * each reference WAS to the answer — cited, the ask's candidate, the
 * refusal's pointer, the count — precisely so a rebuild does not have to
 * guess which of them the pills were. The order is the stored order, which
 * is the order the answer listed them, which is the order the receipt
 * strip renders.
 *
 * `delayed` IS NOT REBUILT AND DOES NOT NEED TO BE. It is the guard's field,
 * not the renderer's: an FR-69 delay answer is an answer with no references
 * at all, and that is exactly what it re-renders as.
 */
function storedAnswer(row: StoredTurnRow): OwnerAnswer {
  const prose = row.prose!;
  const withRole = (role: ReferenceRole): number[] =>
    (row.refs ?? [])
      .filter((reference) => reference.roles.includes(role))
      .map((reference) => reference.ref);
  const cited = withRole("cited");
  switch (asAnswerKind(row.kind!)) {
    case "refusal": {
      const timelineRef = withRole("timeline")[0];
      return {
        kind: "refusal",
        prose,
        references: cited,
        followUp: row.follow_up ?? "",
        ...(timelineRef === undefined ? {} : { timelineRef }),
      };
    }
    case "ask":
      return {
        kind: "ask",
        prose,
        references: cited,
        candidates: withRole("candidate"),
      };
    case "unrecorded":
      return { kind: "unrecorded", prose, references: cited };
    case "answer": {
      const countRef = withRole("count")[0];
      return {
        kind: "answer",
        prose,
        references: cited,
        ...(countRef === undefined ? {} : { countRef }),
      };
    }
  }
}
