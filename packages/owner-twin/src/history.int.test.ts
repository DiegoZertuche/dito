/**
 * THE SCROLL, AT THE STORE SEAM (ticket #131; spec #126 Testing Decisions —
 * "the store round-trip: the history reader over `owner.questions` /
 * `owner.answers` as `dito_owner`, re-rendered from the Ledger").
 *
 * WHAT THIS SUITE CLAIMS, AND WHY IT IS NOT THE PAGE'S CLAIM. The room's own
 * suite asserts what a browser receives; this one asserts the property the
 * page rests on and cannot see from outside: that a turn read back out of
 * two tables and re-read out of the Ledger is the SAME turn the run
 * produced. Nothing HTML is stored, so «what I was told» and «what the
 * record holds» have to be one sentence — and the only way to observe that
 * is to hold the live rendering and the re-rendering side by side.
 *
 * THE INPUT SEAM IS THE POSTGRES SEAM and the model is the one thing
 * scripted, exactly as `turn.int.test.ts` has it. The turns below are run
 * through `runOwnerTwinTurn` — the real store, the real chain, the real
 * guard — and never written by hand.
 */
import { randomUUID } from "node:crypto";
import {
  appendOwnerAuditEntry,
  verifyOwnerAuditChainsInDb,
  type AuditEntry,
} from "@dito/audit";
import {
  OWNER_COMPANY_SETTING,
  OWNER_ROLE,
  readOwnerEntitiesByIds,
  readOwnerFactsByIds,
  readOwnerSeatsByIds,
  readOwnerTimeline,
} from "@dito/aperture";
import { closeScriptedModels, scriptedModel, type ScriptedTurn } from "@dito/scripted-model";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  readOwnerRoomTurns,
  type OwnerRoom,
  type OwnerRoomTurn,
} from "./history.js";
import { OWNER_TWIN_HISTORY_TURNS, readOwnerTurns } from "./store.js";
import {
  runOwnerTwinTurn,
  TURN_TRANSACTION,
  type OwnerTwinTurnOutcome,
} from "./turn.js";
import {
  borrowOwnerPassword,
  boundTo,
  OWNER_TEST_PASSWORD,
  resetAndMigrate,
  seedOwnerCorpus,
  pgErrorCode,
  TEST_OWNER_AUDIT_HMAC_KEY,
  TEST_DATABASE_URL,
  withRoleClient,
  type BorrowedOwnerPassword,
  type OwnerCorpus,
} from "./testing/db.js";

// Every scripted model this suite opened is closed with it (#328).
afterAll(closeScriptedModels);

const TIME_ZONE = "America/Monterrey";
const MODEL = "claude-sonnet-5";

/** Two records of company A whose names fold equal — `turn.int.test.ts`'s pair. */
const AMBIGUOUS = { accented: "Aceros Ríos", plain: "Aceros Rios" } as const;

let db: pg.Client;
/** Cluster-global, so it goes back exactly as it was found (#133). */
let ownerPassword: BorrowedOwnerPassword | null = null;
let a: OwnerCorpus;
let b: OwnerCorpus;

beforeAll(async () => {
  await resetAndMigrate();
  db = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await db.connect();
  ownerPassword = await borrowOwnerPassword(OWNER_ROLE);

  a = await seedOwnerCorpus(db, {
    company: "Ferretería Fuentes",
    rep: "Mauricio Cantú",
    customer: "Ana García",
    mergedWinner: "Torres Hnos.",
    mergedLoser: "Torres Hermanos",
  });
  b = await seedOwnerCorpus(db, {
    company: "Materiales del Norte",
    rep: "Rosa Elena Treviño",
    customer: "Beatriz Lozano",
    mergedWinner: "Lozano y Cía.",
    mergedLoser: "Lozano y Compañía",
  });
  const fixtures = boundTo(() => db);
  await fixtures.bindCustomer(a.seat, AMBIGUOUS.accented, { kind: "business" });
  await fixtures.bindCustomer(a.seat, AMBIGUOUS.plain, { kind: "business" });
});

afterAll(async () => {
  await ownerPassword?.restore();
  await db.end();
});

/** One turn, run as `dito_owner` with a company declared, over a script. */
async function ask(
  corpus: OwnerCorpus,
  question: string,
  script: readonly ScriptedTurn[],
): Promise<OwnerTwinTurnOutcome> {
  const { harness } = scriptedModel(script);
  return asOwner(corpus, (client) =>
    runOwnerTwinTurn({
      harness,
      client,
      hmacKey: TEST_OWNER_AUDIT_HMAC_KEY,
      companyId: corpus.seat.companyId,
      question,
      timeZone: TIME_ZONE,
      model: MODEL,
    }),
  );
}

/** ...and the scroll, read back over the same credential and company. */
async function scroll(corpus: OwnerCorpus): Promise<readonly OwnerRoomTurn[]> {
  return (await room(corpus)).turns;
}

async function room(corpus: OwnerCorpus): Promise<OwnerRoom> {
  return asOwner(corpus, (client) =>
    readOwnerRoomTurns(client, { timeZone: TIME_ZONE }),
  );
}

async function asOwner<T>(
  corpus: OwnerCorpus,
  fn: (client: pg.ClientBase) => Promise<T>,
): Promise<T> {
  return withRoleClient(OWNER_ROLE, OWNER_TEST_PASSWORD, async (client) => {
    await client.query("SELECT set_config($1, $2, false)", [
      OWNER_COMPANY_SETTING,
      corpus.seat.companyId,
    ]);
    return fn(client);
  });
}

const ANSWER: ScriptedTurn[] = [
  { toolCall: { name: "resolve_entity", input: { name: "Ana García" } } },
  { toolCall: { name: "read_timeline", input: { entity_ref: 1 } } },
  {
    structured: {
      kind: "answer",
      prose: "De [[1]] lo último firme es [[2]].",
      references: [1, 2],
    },
  },
  { text: "listo" },
];

/** The prose a rendered turn reads as, slots filled. */
function readsAs(turn: OwnerRoomTurn): string {
  return "rendered" in turn.answer
    ? turn.answer.rendered.prose.map((segment) => segment.text).join("")
    : "";
}

describe("a stored answer re-renders from the Ledger, not from markup", () => {
  it("gives back the same turn the run produced, segment for segment", async () => {
    const outcome = await ask(a, "que hay de Ana", ANSWER);
    const turns = await scroll(a);
    const mine = turns.find((turn) => turn.questionId === outcome.questionId);

    expect(mine?.question).toBe("que hay de Ana");
    expect(mine?.answer).toEqual({ rendered: outcome.turn });
    // ...and it is not vacuous: the values in it came off rows.
    expect(readsAs(mine!)).toContain("Ana García");
    expect(mine!.answer).toHaveProperty("rendered.receipt.0.kind", "fact");
  });

  it("stores no markup — the prose comes back as slots and the values as rows", async () => {
    const stored = await db.query<{ prose: string; refs: unknown }>(
      "SELECT prose, refs FROM owner.answers ORDER BY id DESC LIMIT 1",
    );
    // The slot grammar survives in the store; the rendered value does not.
    expect(stored.rows[0]!.prose).toContain("[[1]]");
    expect(stored.rows[0]!.prose).not.toContain("Ana García");
  });

  it("keeps the turns oldest first, the way the scroll reads", async () => {
    const before = (await scroll(a)).map((turn) => turn.questionId);
    const next = await ask(a, "y ahora?", ANSWER);
    const after = (await scroll(a)).map((turn) => turn.questionId);
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.at(-1)).toBe(next.questionId);
  });

  it("re-renders a refusal with its follow-up and its timeline pointer", async () => {
    const outcome = await ask(a, "que le dijo Mauricio", [
      { toolCall: { name: "resolve_entity", input: { name: "Ana García" } } },
      {
        structured: {
          kind: "refusal",
          prose: "No tengo camino a lo que se dijo con [[1]].",
          follow_up: "Vale una plática directa.",
          references: [1],
          timeline_ref: 1,
        },
      },
      { text: "listo" },
    ]);
    const mine = (await scroll(a)).find(
      (turn) => turn.questionId === outcome.questionId,
    );
    expect(mine?.answer).toEqual({ rendered: outcome.turn });
    expect(mine!.answer).toHaveProperty("rendered.timeline.entityId");
    expect(mine!.answer).toHaveProperty("rendered.followUp.0.kind", "prose");
  });

  it("re-renders an ask with both of its candidate records", async () => {
    const outcome = await ask(a, "como va Aceros Rios", [
      { toolCall: { name: "resolve_entity", input: { name: "Aceros Rios" } } },
      {
        structured: {
          kind: "ask",
          prose: "Hay más de uno con ese nombre. ¿Cuál?",
          references: [1, 2],
          candidates: [1, 2],
        },
      },
      { text: "listo" },
    ]);
    const mine = (await scroll(a)).find(
      (turn) => turn.questionId === outcome.questionId,
    );
    expect(mine?.answer).toEqual({ rendered: outcome.turn });
    const candidates =
      "rendered" in mine!.answer ? mine!.answer.rendered.candidates : [];
    expect(candidates).toHaveLength(2);
    expect(candidates.map((record) => record.displayName).sort()).toEqual(
      [AMBIGUOUS.accented, AMBIGUOUS.plain].sort(),
    );
  });

  it("re-renders a count from what it counted, since nothing files a count", async () => {
    const outcome = await ask(a, "cuantas cotizaciones dio Mauricio", [
      {
        toolCall: {
          name: "count_facts",
          input: { fact_type: "QuoteGiven", seat_name: "Mauricio Cantú" },
        },
      },
      {
        structured: {
          kind: "answer",
          prose: "Van [[2]] dadas por [[1]].",
          references: [1, 2],
          count_ref: 2,
        },
      },
      { text: "listo" },
    ]);
    const mine = (await scroll(a)).find(
      (turn) => turn.questionId === outcome.questionId,
    );
    expect(mine?.answer).toEqual({ rendered: outcome.turn });
    expect(mine!.answer).toHaveProperty("rendered.receipt.0.kind", "count");
    expect(mine!.answer).toHaveProperty("rendered.receipt.0.windowClosed", true);
  });

  it("says a turn produced no answer rather than inventing one", async () => {
    // The structural guard's own case: a submission citing a row no tool
    // served is refused, the execution is recorded and chained, and there is
    // no answer row beside it (#130).
    const outcome = await ask(a, "y con Torres?", [
      { toolCall: { name: "resolve_entity", input: { name: "Torres Hnos." } } },
      { structured: { kind: "answer", prose: "Lo de [[9]].", references: [9] } },
      { text: "listo" },
    ]);
    expect(outcome.disposition).toBe("failed");
    const mine = (await scroll(a)).find(
      (turn) => turn.questionId === outcome.questionId,
    );
    expect(mine?.question).toBe("y con Torres?");
    expect(mine?.answer).toEqual({ unrendered: "no-answer" });
  });

  it("says a turn can no longer be shown when the Ledger stopped returning its rows", async () => {
    // REACHABLE, NOT HYPOTHETICAL. An answer keeps the id of every row it
    // rests on, and the Ledger stops returning one whenever a company's
    // flag goes back down, a fact is expunged (ADR-0026) or a row leaves
    // the finalized view any other way — while the answer that cited it
    // stays in the store forever. What the room must not do then is fill
    // the slot with something else.
    //
    // REPRODUCED AT THE STORED REFERENCE rather than at the fact, because
    // the effect is identical from here — the id names no row the owner's
    // views return — and no test outside `packages/aperture` may name a
    // `ledger` table (`sole-writer.test.ts`). The `owner` schema is this
    // app's own store, which is why it can be reached at all.
    const outcome = await ask(a, "una más de Ana", ANSWER);
    const stranded = randomUUID();
    await db.query(
      `UPDATE owner.answers
          SET refs = jsonb_set(refs, '{1,factId}', to_jsonb($2::text))
        WHERE execution_id = $1`,
      [outcome.executionId, stranded],
    );
    const mine = (await scroll(a)).find(
      (turn) => turn.questionId === outcome.questionId,
    );
    expect(mine?.answer).toEqual({ unrendered: "row-gone" });
  });
});

describe("the transaction a turn runs in (Codex r3)", () => {
  it("never extends a chain tail its own snapshot is too old to see", async () => {
    // THE FAILURE, NAMED. `appendOwnerAuditEntry` serializes appenders on one
    // advisory lock — keyed per company since #165 — and then reads that
    // company's tail, which is correct only if the read sees the latest
    // committed row. A turn holds its transaction open across the model call,
    // so another append for the SAME COMPANY lands inside that window: a
    // second tab in the room, or a second process serving the same
    // deployment. Under a snapshot taken before the model ran, the tail read
    // cannot see it and the turn appends a SECOND link from the old tail — no
    // constraint refuses it, the store is append-only, and the fork can never
    // be repaired (ADR-0020).
    //
    // WHAT CHANGED WITH #165: the concurrent appender used to be anybody on
    // the rep side, because there was one chain. There are two now, and the
    // owner's is per company — so the only writer that can reach this chain
    // is another owner append for this company, which is what is driven here.
    // The turn is refused on `public.audit_chain` outright (#157), so that
    // race is gone rather than handled.
    //
    // Driven at the statement `runOwnerTwinTurn` actually opens with, so this
    // is a claim about the turn rather than about Postgres.
    const other: AuditEntry = {
      caller: "execution",
      action: "execution",
      ref: `owner_question:${randomUUID()}`,
      outcome: "answered",
    };
    const mine: AuditEntry = {
      caller: "execution",
      action: "execution",
      ref: `owner_question:${randomUUID()}`,
      outcome: "answered",
    };

    await withRoleClient(OWNER_ROLE, OWNER_TEST_PASSWORD, async (turn) => {
      await turn.query("SELECT set_config($1, $2, false)", [
        OWNER_COMPANY_SETTING,
        a.seat.companyId,
      ]);
      await turn.query(TURN_TRANSACTION);
      // The turn's first read — where a snapshot would be taken.
      await readOwnerTurns(turn);

      // ...and, while the model would be thinking, the same company's chain
      // is extended by somebody else.
      await db.query("BEGIN");
      await appendOwnerAuditEntry(
        db,
        TEST_OWNER_AUDIT_HMAC_KEY,
        a.seat.companyId,
        other,
      );
      await db.query("COMMIT");

      await appendOwnerAuditEntry(
        turn,
        TEST_OWNER_AUDIT_HMAC_KEY,
        a.seat.companyId,
        mine,
      );
      await turn.query("COMMIT");
    });

    const chains = await verifyOwnerAuditChainsInDb(
      db,
      TEST_OWNER_AUDIT_HMAC_KEY,
    );
    expect(chains.valid).toBe(true);
  });

  it("refuses the rep side's chain outright, whatever the isolation level (#157)", async () => {
    // The race above only ever existed because the owner appended to a chain
    // every rep-side process also wrote. It cannot happen now for a reason
    // stronger than isolation: the grant is gone.
    const refused = await withRoleClient(
      OWNER_ROLE,
      OWNER_TEST_PASSWORD,
      async (turn) => {
        try {
          await turn.query("SELECT count(*) FROM public.audit_chain");
          return null;
        } catch (err) {
          return pgErrorCode(err);
        }
      },
    );
    expect(refused).toBe("42501");
  });
});

describe("the scroll says what it is not showing", () => {
  it("counts every turn the thread holds, not only the ones it draws", async () => {
    // THE CAP MUST NOT BE SILENT (Codex r2). The scroll shows the most
    // recent turns — the same ones the next execution is shown — and the
    // total is what lets the room say so rather than read as "there was
    // nothing before".
    const shown = await room(a);
    expect(shown.turns.length).toBeLessThanOrEqual(OWNER_TWIN_HISTORY_TURNS);
    const asked = await db.query<{ n: string }>(
      "SELECT count(*) AS n FROM owner.questions WHERE company_id = $1",
      [a.seat.companyId],
    );
    expect(shown.turnsInAll).toBe(Number(asked.rows[0]!.n));
    expect(shown.turnsInAll).toBeGreaterThan(0);
  });
});

describe("the reads the scroll is built on are one company's", () => {
  it("returns nothing for a row id belonging to another company", async () => {
    // THE NEW READS TAKE AN ID AND NO COMPANY, exactly as every other owner
    // read does, because the tenant is the connection's declared company
    // through the policy. This is that claim, made directly rather than
    // through the page: an id from company A is not a row company B's
    // deployment can read, however it came by the id.
    const timeline = await asOwner(a, (client) =>
      readOwnerTimeline(client, a.customer.entityId),
    );
    const fact = timeline.facts.find((row) => row.filedBySeatId !== null)!;
    const factId = fact.id;
    const seatId = fact.filedBySeatId!;

    const mine = await asOwner(a, (client) =>
      readOwnerFactsByIds(client, [factId]),
    );
    expect(mine.map((fact) => fact.id)).toEqual([factId]);

    const theirs = await asOwner(b, async (client) => ({
      facts: await readOwnerFactsByIds(client, [factId]),
      entities: await readOwnerEntitiesByIds(client, [a.customer.entityId]),
      seats: await readOwnerSeatsByIds(client, [seatId]),
    }));
    expect(theirs.facts).toEqual([]);
    expect(theirs.entities).toEqual([]);
    expect(theirs.seats).toEqual([]);
  });
});

describe("the scroll is one company's, through the policy", () => {
  it("never carries another company's turns", async () => {
    await ask(b, "que hay de Beatriz", [
      { toolCall: { name: "resolve_entity", input: { name: "Beatriz Lozano" } } },
      { toolCall: { name: "read_timeline", input: { entity_ref: 1 } } },
      {
        structured: {
          kind: "answer",
          prose: "De [[1]]: [[2]].",
          references: [1, 2],
        },
      },
      { text: "listo" },
    ]);

    const mine = await scroll(a);
    const theirs = await scroll(b);
    expect(mine.map((turn) => turn.question)).not.toContain("que hay de Beatriz");
    expect(theirs.map((turn) => turn.question)).toEqual(["que hay de Beatriz"]);
    expect(theirs.map(readsAs).join(" ")).toContain("Beatriz Lozano");
    expect(mine.map(readsAs).join(" ")).not.toContain("Beatriz Lozano");
  });
});
