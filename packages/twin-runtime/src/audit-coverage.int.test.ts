/**
 * The audit chain is COVERED, not merely intact (ticket #78; ADR-0020;
 * spec #48 decision 18).
 *
 * `audit-verify` proves integrity, and cannot prove coverage: an act that
 * never calls `appendAuditEntry` leaves no gap to detect, because a chain
 * missing a link it was never asked to write is byte-for-byte identical to
 * a complete one. This suite is the other claim, driven the way the rig
 * drives everything — inject `wa_events`, run the consumer, read the far
 * side — so the acts it checks are acts the product actually performed
 * rather than rows a fixture inserted.
 *
 * THE CASE IT EXISTS FOR IS THE REFUSAL. A successful entity create leaves
 * an entity; a retraction leaves a retraction; a `correction_refused`
 * leaves only a `wa_event_processing` disposition and a notice. So the join
 * for a refusal is the disposition, and a refusal is exactly the act a
 * future writer is most likely to forget — precisely because nothing else
 * persists. The middle test here REMOVES that refusal's chain entry and
 * watches the check go red: a coverage check nobody has seen fail is not
 * evidence of coverage.
 *
 * Real Postgres, real envelope crypto, real SQLCipher (ADR-0028). The model
 * is scripted, and empty on every pass that carries a rep act — a rep act
 * is never model output (ADR-0003).
 */
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  auditChainCoverageInDb,
  fileMerge,
  retractDisclosedFact,
  type ChainCoverageReport,
} from "@dito/aperture";
import {
  appendAuditEntry,
  appendOwnerAuditEntry,
  verifyAuditChainInDb,
  type AuditEntry,
} from "@dito/audit";
import { createBundle, type Bundle } from "@dito/bundle";
import { createDekFromMaterial, type Dek } from "@dito/crypto";
import { executionAuditEntry, sessionFile, type ExecutionRecord } from "@dito/execution";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { processPendingWaEvents, type TwinRuntimeDeps } from "./consumer.js";
import { threadTurns } from "./testing/thread-script.js";
import { RETRACT_DISCLOSURE_LINE_TOOL } from "./thread/acts.js";
import {
  TwinExecutionStore,
  twinExecutionChain,
} from "./execution-store.js";
import { runDailyDisclosure } from "./testing/by-hand.js";
import { createSendLockWriter } from "./send-lock/writer.js";
import {
  resetAndMigrate,
  withClient,
  TEST_AUDIT_HMAC_KEY,
  TEST_OWNER_AUDIT_HMAC_KEY,
  TEST_DATABASE_URL,
} from "./testing/db.js";
import { disclosedFact } from "./testing/disclosed-fact.js";
import { seatAtTheDoor, typeAtTheDoor } from "./testing/door.js";
import { removeTmpDir } from "./testing/tmp.js";
import { fakeEmbedder } from "./testing/fake-embedder.js";
import { insertWaEvent, simulateExecutorPost } from "./testing/seam-fixtures.js";
import {
  closeScriptedModels,
  entityKindTurns,
  latestPromptOf,
  scriptedModel,
  toolNamesOf,
  toolResultsOf,
  type Script,
  type ScriptedModel,
  type ScriptedTurn,
} from "./testing/scripted-model.js";
import { composedDisclosure } from "./testing/disclosure-script.js";
import { SETTLE_IMMEDIATELY } from "./testing/settle.js";
import { newExecutionPool } from "./testing/execution-pool.js";
import { openBatchWork } from "./lanes.js";
import { writeRunContent } from "./runs/content.js";
import { shippedRunCatalog } from "./runs/catalog.js";
import { layout, parseRunDefinition, runDigest, type RunDefinition, type RunValue } from "./runs/definition.js";
import { advanceRuns, appendToRunSession, createRunEngine, executeStep } from "./runs/engine.js";
import { THREAD_EVENT_WAKE } from "./thread/automation.js";
import { DRAFTING_WAKE } from "./drafting/automation.js";
import { DraftSlot } from "./drafting/deps.js";
import { ENTITY_KIND_WAKE } from "./entity-kind/automation.js";
import { threadDeps } from "./testing/thread-deps.js";
import { performDashboardAct } from "./dashboard-acts.js";
import { insertRun, setFlag } from "./runs/store.js";
import { openSealedParts } from "./posts.js";

// Every scripted model this suite opened is closed with it (#328).
afterAll(closeScriptedModels);

/** One connection source for every execution this suite runs (ticket #173). */
const executionPool = newExecutionPool();

const exec = promisify(execFile);
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");

const SELF_CHAT = "5215550000@s.whatsapp.net";
const PUSH_NAME = "Ferretería Fuentes";

/**
 * A tag per corpus. `wa_events.external_event_id` is `<chat jid>:<message
 * id>` and unique GLOBALLY (ADR-0005), so two mints sharing one pair
 * collide — and this suite mints a corpus per test on purpose, so that no
 * test depends on another having run first.
 */
let corpusCounter = 0;
const ZONE = "America/Monterrey";
/** 21:30 on the rep's clock — when the day's disclosure pass runs. */
const EVENING = new Date("2026-08-30T03:30:00Z");

let tmp: string;
let pool: pg.Pool;

beforeAll(async () => {
  await resetAndMigrate();
  tmp = mkdtempSync(join(tmpdir(), "dito-audit-coverage-int-"));
  pool = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 4 });
});

afterAll(async () => {
  await pool.end();
  removeTmpDir(tmp);
});

interface Seat {
  readonly twinId: string;
  readonly companyId: string;
  readonly seatId: string;
  readonly dek: Dek;
  readonly bundle: Bundle;
}

function freshTwin(): Seat {
  const twinId = randomUUID();
  const dek = createDekFromMaterial(randomBytes(32));
  return {
    twinId,
    companyId: randomUUID(),
    seatId: randomUUID(),
    dek,
    bundle: createBundle(join(tmp, `${twinId}.bundle`), dek),
  };
}

function depsFor(
  client: pg.Client,
  twin: Seat,
  /**
   * What the model answers. THE DEFAULT IS THE EVENING'S OWN SUBMISSION
   * (ticket #198): the daily disclosure is an automation, so a call that
   * posts a day scripts what the twin composed around its lines, and this
   * suite's claims are about what the day DID rather than about the prose
   * (`testing/disclosure-script.ts`).
   */
  turns: Script = composedDisclosure,
): TwinRuntimeDeps {
  const { harness } = scriptedModel(turns);
  return {
    db: client,
    harness,
    bundle: twin.bundle,
    dek: twin.dek,
    twinId: twin.twinId,
    selfChatJid: SELF_CHAT,
    ...SETTLE_IMMEDIATELY,
    drafting: { model: "claude-sonnet-5" },
    embedder: fakeEmbedder(),
    executionPool,
    sendLock: createSendLockWriter({ pool, hmacKey: TEST_AUDIT_HMAC_KEY }),
    hmacKey: TEST_AUDIT_HMAC_KEY,
    timeZone: ZONE,
  };
}

/** One scripted needs-answer decision — enough to trigger the ceremony. */
function draftingTurns(): ScriptedTurn[] {
  return [
    { toolCall: { name: "create_draft", input: { text: "claro, se las mando el jueves" } } },
    { text: "done" },
  ];
}

/**
 * A whole rep act, end to end: the twin asks whose chat this is, the
 * executor posts the question, the rep quotes it with «va», and the
 * aperture files the entity create. Leaves the seam's `binding_confirmed`
 * marker AND the chain entry — the pair the coverage check joins.
 *
 * It leaves a SECOND pair too (ticket #60): the entity it files carries a
 * model-determined `kind`, and that determination chains an `entity_kind`
 * entry of its own — the row-and-entry pair the `entity_kind` class joins.
 */
async function confirmABinding(
  client: pg.Client,
  twin: Seat,
  tag: string,
): Promise<string> {
  const chat = `52155500${tag}@s.whatsapp.net`;
  await insertWaEvent(client, twin.dek, {
    twinId: twin.twinId,
    companyId: twin.companyId,
    seatId: twin.seatId,
    chatJid: chat,
    senderJid: chat,
    fromMe: false,
    messageId: `3EB0-IN-${tag}`,
    text: "¿me mandas 40 cajas para el jueves?",
    pushName: PUSH_NAME,
  });
  await processPendingWaEvents(depsFor(client, twin, draftingTurns()));

  // THE QUESTION THIS CALL RAISED, not the first one this twin ever
  // raised: a corpus may confirm more than one binding (the merge proof
  // needs two entities in one company), and a lookup by twin alone would
  // hand back an already-posted command and collide on `send_executions`.
  const question = await client.query<{ command_id: string }>(
    `SELECT sc.id AS command_id
       FROM notices n
       JOIN send_commands sc ON sc.payload_ref = 'notice:' || n.id
       LEFT JOIN send_executions e ON e.command_id = sc.id
      WHERE n.twin_id = $1 AND n.kind = 'binding_question'
        AND e.command_id IS NULL
      ORDER BY sc.id`,
    [twin.twinId],
  );
  await simulateExecutorPost(client, {
    commandId: question.rows[0]!.command_id,
    twinId: twin.twinId,
    waMessageId: `WAMID-QUESTION-${tag}`,
  });

  await insertWaEvent(client, twin.dek, {
    twinId: twin.twinId,
    companyId: twin.companyId,
    seatId: twin.seatId,
    chatJid: SELF_CHAT,
    senderJid: SELF_CHAT,
    fromMe: true,
    messageId: `3EB0-REP-VA-${tag}`,
    text: "va",
    quotedMessageId: `WAMID-QUESTION-${tag}`,
  });
  // ONE scripted call, and it is the crossing's kind determination (ticket
  // #60). The verb itself still consults no model: anything beyond that one
  // call exhausts the script and fails loudly.
  await processPendingWaEvents(depsFor(client, twin, entityKindTurns()));

  return twin.bundle.readChatBinding(chat)!.entityId;
}

/**
 * The day's disclosure, posted — and then the rep quoting it and naming a
 * line the post never showed. The tool resolves quoted id → post → index in
 * stored rows, finds no line 9, and refuses rep-side: nothing is minted,
 * the rep is told, and the refusal is chained with the TOOL as caller
 * (#174 — the matcher that used to be named is deleted).
 *
 * Returns the rep's own event id — the id the chain entry's `ref` names and
 * the coverage join keys on.
 */
async function refuseACorrection(
  client: pg.Client,
  twin: Seat,
  tag: string,
): Promise<string> {
  const posted = await runDailyDisclosure(depsFor(client, twin), EVENING);
  expect(posted.posted).toBe(true);

  const post = await client.query<{ command_id: string }>(
    `SELECT sc.id AS command_id
       FROM notices n
       JOIN send_commands sc ON sc.payload_ref = 'notice:' || n.id
      WHERE n.twin_id = $1 AND n.kind = 'daily_disclosure'`,
    [twin.twinId],
  );
  await simulateExecutorPost(client, {
    commandId: post.rows[0]!.command_id,
    twinId: twin.twinId,
    waMessageId: `WAMID-DISCLOSURE-${tag}`,
  });

  const eventId = await insertWaEvent(client, twin.dek, {
    twinId: twin.twinId,
    companyId: twin.companyId,
    seatId: twin.seatId,
    chatJid: SELF_CHAT,
    senderJid: SELF_CHAT,
    fromMe: true,
    messageId: `3EB0-REP-9NO-${tag}`,
    text: "el 9 está mal",
    quotedMessageId: `WAMID-DISCLOSURE-${tag}`,
  });
  await processPendingWaEvents(
    depsFor(
      client,
      twin,
      threadTurns({
        tool: RETRACT_DISCLOSURE_LINE_TOOL,
        evidence: eventId,
        input: { line: 9 },
      }),
    ),
  );

  const marker = await client.query<{ disposition: string }>(
    "SELECT disposition FROM wa_event_processing WHERE event_id = $1",
    [eventId],
  );
  expect(marker.rows[0]!.disposition).toBe("correction_refused");
  return eventId;
}

function violationsFor(
  report: ChainCoverageReport,
  cls: string,
): readonly { class: string; subject: string; reason: string }[] {
  return report.violations.filter((v) => v.class === cls);
}

/**
 * Runs `body` with one entry LIFTED OUT of the chain, and puts everything
 * back before returning.
 *
 * `audit_chain` is append-only by trigger (ADR-0020), which is the point of
 * the store and an obstacle here: the only way to watch the check go red on
 * a REAL act is to take that act's entry away. So the whole thing happens
 * inside ONE transaction — `ALTER TABLE … DISABLE TRIGGER` is transactional
 * in Postgres, so the rollback restores the entry AND the trigger together,
 * and no failure path can leave this database a link short. `body` reads
 * through the same client, so it sees the uncommitted deletion.
 */
async function withEntryLifted(
  client: pg.Client,
  entryId: string,
  body: () => Promise<void>,
): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query(
      "ALTER TABLE audit_chain DISABLE TRIGGER audit_chain_no_update_delete",
    );
    await client.query("DELETE FROM audit_chain WHERE id = $1", [entryId]);
    await body();
  } finally {
    await client.query("ROLLBACK");
  }
}

/** One corpus of real rep acts: a confirmed binding and a refused correction. */
async function mintCorpus(client: pg.Client): Promise<{
  twin: Seat;
  tag: string;
  refusedEventId: string;
  /** The entity the binding filed — and whose kind something determined. */
  entityId: string;
}> {
  corpusCounter += 1;
  const tag = String(10 + corpusCounter);
  const twin = freshTwin();
  const entityId = await confirmABinding(client, twin, tag);
  const refusedEventId = await refuseACorrection(client, twin, tag);
  return { twin, tag, refusedEventId, entityId };
}

/** The chain entry that records one refused correction, by the act's own id. */
async function refusalEntry(
  client: pg.Client,
  eventId: string,
): Promise<{ id: string; outcome: string }> {
  const res = await client.query<{ id: string; outcome: string }>(
    `SELECT id, outcome FROM audit_chain
      WHERE action = 'fact_retraction'
        AND (' ' || ref || ' ') LIKE ('% event:' || $1 || ' %')`,
    [eventId],
  );
  expect(res.rows).toHaveLength(1);
  return res.rows[0]!;
}

/**
 * The chain entry that records one entity's kind determination, by the pair
 * that identifies it (ticket #60: a Ledger entity's identity is company AND
 * entity, because the id is client-minted).
 */
async function determinationEntry(
  client: pg.Client,
  companyId: string,
  entityId: string,
): Promise<{ id: string; outcome: string }> {
  const res = await client.query<{ id: string; outcome: string }>(
    `SELECT id, outcome FROM audit_chain
      WHERE action = 'entity_kind'
        AND ref = 'company:' || $1 || ' entity:' || $2 || ' by:model'`,
    [companyId, entityId],
  );
  expect(res.rows).toHaveLength(1);
  return res.rows[0]!;
}

/**
 * The chain entry that records one machine merge, by the edge's own id.
 *
 * Keyed on `merge:<id>` — the same token the class's join uses. The merge id
 * is server-minted, so unlike an entity it needs no company prefix to be
 * unambiguous; `action` is what keeps this apart from an UNMERGE entry,
 * whose ref carries a `merge:` token of its own.
 */
async function mergeEntry(
  client: pg.Client,
  mergeId: string,
): Promise<{ id: string; outcome: string }> {
  const res = await client.query<{ id: string; outcome: string }>(
    `SELECT id, outcome FROM audit_chain
      WHERE action = 'entity_merge'
        AND (' ' || ref || ' ') LIKE ('% merge:' || $1 || ' %')`,
    [mergeId],
  );
  expect(res.rows).toHaveLength(1);
  return res.rows[0]!;
}

/** Runs the invariant script the way CI does. */
function runCheck(args: readonly string[]): Promise<{ stdout: string }> {
  return exec(process.execPath, ["scripts/audit-coverage-check.mjs", ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, DITO_DATABASE_URL: TEST_DATABASE_URL },
  });
}

describe("coverage over a corpus of real rep acts (ticket #78)", () => {
  it("is green over a binding confirmation and a refused correction the consumer actually processed", async () => {
    await withClient(async (client) => {
      await mintCorpus(client);

      const report = await auditChainCoverageInDb(client);
      expect(report.violations).toEqual([]);
      // The corpus really holds both acts — a green over nothing is the
      // silent pass `--require-acts` exists to refuse.
      const tally = (cls: string) =>
        report.mustChain.find((t) => t.class === cls)!;
      expect(tally("entity_create").acts).toBeGreaterThan(0);
      expect(tally("fact_retraction_refused").acts).toBeGreaterThan(0);
      // ...and integrity is a SEPARATE verdict, unchanged by any of this.
      expect(
        (await verifyAuditChainInDb(client, TEST_AUDIT_HMAC_KEY)).valid,
      ).toBe(true);
    });
  });

  it("GOES RED when a real refusal's chain entry is removed, and names that act", async () => {
    await withClient(async (client) => {
      const { refusedEventId } = await mintCorpus(client);
      const entry = await refusalEntry(client, refusedEventId);
      expect(entry.outcome).toBe("refused:unknown_line");

      await withEntryLifted(client, entry.id, async () => {
        const red = await auditChainCoverageInDb(client);
        expect(violationsFor(red, "fact_retraction_refused")).toEqual([
          {
            class: "fact_retraction_refused",
            subject: `wa_event ${refusedEventId}`,
            reason:
              "no `fact_retraction` chain entry records this act (ADR-0020, spec #48 decision 18)",
          },
        ]);
        // ONLY that act. The join is per-act, so the binding confirmation
        // beside it is not dragged into the finding — which is what makes
        // the report usable rather than an alarm.
        expect(violationsFor(red, "entity_create")).toEqual([]);
      });

      expect((await auditChainCoverageInDb(client)).violations).toEqual([]);
      // The chain is whole again, link for link: the removal was a test of
      // coverage, and integrity is not what this check touches.
      expect(
        (await verifyAuditChainInDb(client, TEST_AUDIT_HMAC_KEY)).valid,
      ).toBe(true);
    });
  });

  it("GOES RED when a filed entity's kind determination is removed, and names that entity", async () => {
    // THE CLASS ADDED BY #60'S RULING, proven the way #78 proved every
    // other one: a class nobody has watched fail is not evidence of
    // coverage. The act is not a rep act and not a refusal — it is a
    // class-1 inference that GATES MERGE ELIGIBILITY (ADR-0035's phone
    // rung), is never disclosed, and has no other record of who decided it
    // — so the entry lifted here is the only trace the determination left.
    await withClient(async (client) => {
      const { twin, entityId } = await mintCorpus(client);
      const entry = await determinationEntry(client, twin.companyId, entityId);
      expect(entry.outcome).toBe("determined:person");

      await withEntryLifted(client, entry.id, async () => {
        const red = await auditChainCoverageInDb(client);
        expect(violationsFor(red, "entity_kind")).toEqual([
          {
            class: "entity_kind",
            subject: `entity ${twin.companyId}/${entityId}`,
            reason:
              "no `entity_kind` chain entry records this act (ADR-0020, ADR-0035 as amended)",
          },
        ]);
        // ONLY the determination. The create beside it — filed in the same
        // transaction, by the same act — keeps its own entry and stays
        // green, which is what makes the report name a subject rather than
        // raise an alarm.
        expect(violationsFor(red, "entity_create")).toEqual([]);
      });

      expect((await auditChainCoverageInDb(client)).violations).toEqual([]);
      expect(
        (await verifyAuditChainInDb(client, TEST_AUDIT_HMAC_KEY)).valid,
      ).toBe(true);
    });
  });

  it("GOES RED on a rep act a future writer marked and forgot to chain", async () => {
    // The failure in the shape it would actually arrive: the marker is
    // written, the notice is posted, and the `appendAuditEntry` call is
    // simply not there. Planted inside a transaction and rolled back, so
    // the corpus this suite leaves behind stays green.
    await withClient(async (client) => {
      const { twin, tag } = await mintCorpus(client);
      const forgotten = await insertWaEvent(client, twin.dek, {
        twinId: twin.twinId,
        companyId: twin.companyId,
        seatId: twin.seatId,
        chatJid: SELF_CHAT,
        senderJid: SELF_CHAT,
        fromMe: true,
        messageId: `3EB0-REP-FORGOTTEN-${tag}`,
        text: "4 no",
        quotedMessageId: `WAMID-DISCLOSURE-${tag}`,
      });

      await client.query("BEGIN");
      try {
        await client.query(
          "INSERT INTO wa_event_processing (event_id, twin_id, disposition) VALUES ($1, $2, 'correction_refused')",
          [forgotten, twin.twinId],
        );
        const red = await auditChainCoverageInDb(client);
        expect(violationsFor(red, "fact_retraction_refused")).toEqual([
          {
            class: "fact_retraction_refused",
            subject: `wa_event ${forgotten}`,
            reason:
              "no `fact_retraction` chain entry records this act (ADR-0020, spec #48 decision 18)",
          },
        ]);
      } finally {
        await client.query("ROLLBACK");
      }

      expect((await auditChainCoverageInDb(client)).violations).toEqual([]);
    });
  });
});

describe("coverage over a line corrected at the dashboard's door (ticket #344)", () => {
  /**
   * A correction the aperture really made from a door message, marked as the
   * thread execution marks it — the act this class must now enumerate.
   */
  async function correctAtTheDoor(client: pg.Client): Promise<string> {
    const twin = freshTwin();
    const seat = await seatAtTheDoor(client, twin.twinId);
    const scoped = { ...twin, companyId: seat.companyId, seatId: seat.seatId };
    const record = await disclosedFact(client, scoped, { reachedAt: new Date() });
    const messageId = await typeAtTheDoor(client, twin, seat, "Le cotizaste cajas en 4800 MXN.", {
      kind: "line",
      postId: record.postId,
      lineIndex: 1,
    });
    const outcome = await retractDisclosedFact(
      { db: client, dek: twin.dek, hmacKey: TEST_AUDIT_HMAC_KEY },
      {
        twinId: twin.twinId,
        disclosureLineId: record.lineId,
        evidence: { surface: "dashboard_message", dashboardMessageId: messageId },
      },
    );
    expect(outcome).toMatchObject({ retracted: true });
    await client.query(
      "INSERT INTO dashboard_message_processing (message_id, twin_id, disposition) VALUES ($1, $2, 'retracted')",
      [messageId, twin.twinId],
    );
    twin.bundle.close();
    return messageId;
  }

  it("counts the door's correction as an act, green with its entry and red without it", async () => {
    await withClient(async (client) => {
      const messageId = await correctAtTheDoor(client);
      const green = await auditChainCoverageInDb(client);
      expect(violationsFor(green, "fact_retraction_performed")).toEqual([]);
      expect(
        green.mustChain.find((t) => t.class === "fact_retraction_performed")!.acts,
      ).toBeGreaterThan(0);

      const entry = await client.query<{ id: string }>(
        `SELECT id FROM audit_chain
          WHERE action = 'fact_retraction'
            AND (' ' || ref || ' ') LIKE ('% message:' || $1 || ' %')`,
        [messageId],
      );
      expect(entry.rows).toHaveLength(1);
      await withEntryLifted(client, entry.rows[0]!.id, async () => {
        const red = await auditChainCoverageInDb(client);
        expect(violationsFor(red, "fact_retraction_performed")).toEqual([
          {
            class: "fact_retraction_performed",
            subject: `dashboard_message ${messageId}`,
            reason: expect.stringContaining("no `fact_retraction` chain entry records this act") as string,
          },
        ]);
      });
    });
  });

  it("names a refused door correction a writer marked and forgot to chain", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const seat = await seatAtTheDoor(client, twin.twinId);
      const forgotten = await typeAtTheDoor(client, twin, seat, "Le cotizaste cajas en 4800 MXN.");
      await client.query("BEGIN");
      try {
        await client.query(
          "INSERT INTO dashboard_message_processing (message_id, twin_id, disposition) VALUES ($1, $2, 'correction_refused')",
          [forgotten, twin.twinId],
        );
        const red = await auditChainCoverageInDb(client);
        expect(violationsFor(red, "fact_retraction_refused")).toEqual([
          {
            class: "fact_retraction_refused",
            subject: `dashboard_message ${forgotten}`,
            reason: expect.stringContaining("no `fact_retraction` chain entry records this act") as string,
          },
        ]);
      } finally {
        await client.query("ROLLBACK");
      }
      twin.bundle.close();
    });
  });
});

describe("coverage over an execution, on EITHER chain (ticket #165; #157 Q4)", () => {
  /**
   * THE TRANSITION, MADE OBSERVABLE. Before #165 the owner twin appended its
   * `execution` entries to `public.audit_chain`; after it, to its own
   * `owner.audit_chain`. The rig's pre-cutover entries stay where they are —
   * re-appending them onto the new chain would be forging history — so the
   * class accepts an entry on either chain, and a database holding both must
   * come out green.
   *
   * WHAT MAKES THAT SAFE is a grant rather than a date, and it is checked
   * elsewhere: after #165 the only way a NEW execution entry reaches the
   * shared chain is a grant FR-71a turns red on (`invariants.int.test.ts`
   * plants exactly that). So the widened join cannot be used to hide a
   * missing entry — an act with no entry on either chain is still red, which
   * is the third case below.
   *
   * Rows are written straight here rather than through `runOwnerTwinTurn`:
   * the claim is about the JOIN, and the owner twin's own suite is where the
   * writer is exercised. Everything is planted inside a transaction and rolled
   * back, so the corpus this file leaves for CI stays exactly what it was.
   */
  async function plantExecution(
    client: pg.Client,
    where: "shared" | "owner" | "nowhere",
  ): Promise<{ questionId: string; executionId: string }> {
    const companyId = randomUUID();
    const questionId = randomUUID();
    const executionId = randomUUID();
    await client.query(
      "INSERT INTO owner.questions (id, company_id, text) VALUES ($1, $2, 'planted')",
      [questionId, companyId],
    );
    await client.query(
      `INSERT INTO owner.executions
         (id, owner_question_id, company_id, trigger_kind, instructions_digest,
          tool_names, started_at, ended_at, iterations, tokens_input,
          tokens_output, disposition, lane)
       VALUES ($1, $2, $3, 'owner_question', 'digest', ARRAY['t'],
               now(), now(), 1, 1, 1, 'answered', 'realtime')`,
      [executionId, questionId, companyId],
    );
    const entry: AuditEntry = {
      caller: "execution",
      action: "execution",
      // As `triggerRef` renders it since #178: the occasion, the mechanism
      // and then the ids, with `owner_question:<id>` still its own token —
      // which is what the join below matches on.
      ref: `trigger:owner_question mechanism:request company:${companyId} owner_question:${questionId}`,
      outcome: "answered",
    };
    if (where === "shared") {
      await appendAuditEntry(client, TEST_AUDIT_HMAC_KEY, entry);
    } else if (where === "owner") {
      await appendOwnerAuditEntry(
        client,
        TEST_OWNER_AUDIT_HMAC_KEY,
        companyId,
        entry,
      );
    }
    return { questionId, executionId };
  }

  it("is green over pre-cutover entries on the shared chain AND post-cutover entries on the owner chain", async () => {
    await withClient(async (client) => {
      await mintCorpus(client);
      await client.query("BEGIN");
      try {
        await plantExecution(client, "shared");
        await plantExecution(client, "owner");
        const report = await auditChainCoverageInDb(client);
        expect(violationsFor(report, "execution")).toEqual([]);
        const tally = report.mustChain.find((t) => t.class === "execution")!;
        expect(tally.acts).toBe(2);
        // ...and BOTH chains were counted: an entry count that only saw the
        // shared chain would read 1 here and the green would be half a claim.
        expect(tally.entries).toBe(2);
      } finally {
        await client.query("ROLLBACK");
      }
    });
  });

  it("GOES RED on an execution with no entry on either chain, and names it", async () => {
    await withClient(async (client) => {
      await client.query("BEGIN");
      try {
        const { executionId } = await plantExecution(client, "nowhere");
        const red = await auditChainCoverageInDb(client);
        expect(violationsFor(red, "execution")).toEqual([
          {
            class: "execution",
            subject: `execution ${executionId}`,
            reason:
              "no `execution` chain entry records this act (ADR-0020, ADR-0014 as amended, spec #126 decision 5(f))",
          },
        ]);
      } finally {
        await client.query("ROLLBACK");
      }
      expect((await auditChainCoverageInDb(client)).violations).toEqual([]);
    });
  });

  it("sees a word the vocabulary does not declare on the OWNER chain too", async () => {
    // THE FENCE FOLLOWS THE ENTRIES. Before #165 every `execution` entry was
    // on the shared chain, so the vocabulary sweep covered them by reading
    // one table. Leaving it there would have quietly stopped covering the
    // owner side the day the writer moved — a component writing owner-side
    // under a word nothing declares, unnoticed.
    await withClient(async (client) => {
      await client.query("BEGIN");
      try {
        await client.query(
          `INSERT INTO owner.audit_chain
             (company_id, caller, action, ref, outcome, entry_hash)
           VALUES ($1, 'execution', 'owner_daydream', NULL, 'answered', '\\x00')`,
          [randomUUID()],
        );
        const red = await auditChainCoverageInDb(client);
        expect(red.violations).toContainEqual({
          class: "vocabulary",
          subject: 'action "owner_daydream"',
          reason:
            "not in AUDIT_ACTIONS — a word this build does not declare, so nothing states which acts owe it an entry (ticket #78)",
        });
      } finally {
        await client.query("ROLLBACK");
      }
    });
  });
});

describe("coverage over a REP-SIDE execution (ticket #172; spec #171 decision 12)", () => {
  /**
   * The rep side's store and its chain adapter over ONE open transaction —
   * which is the contract both of them state, and the only way "a record and
   * its entry commit together" can be true. Rolled back afterwards, so the
   * corpus this file leaves for CI stays exactly what it was; the seam suite
   * (`drafting.int.test.ts`) is where the CONSUMER drives them, and this is
   * where the JOIN is examined over real rows.
   */
  async function plantRepExecution(
    client: pg.Client,
    chained: "chained" | "unchained",
  ): Promise<{ executionId: string; twinId: string }> {
    const twinId = randomUUID();
    const executionId = randomUUID();
    const record: ExecutionRecord = {
      trigger: {
        kind: "chat_turn",
        mechanism: "seam_event",
        twinId,
        chatJid: "5215550001@s.whatsapp.net",
        anchorEventId: "1",
        eventIds: ["1"],
      },
      instructionsDigest: "planteddigest0000000000000000000",
      toolNames: ["search_memory", "create_draft"],
      startedAt: new Date(),
      endedAt: new Date(),
      iterations: 2,
      tokens: { input: 10, output: 20 },
      disposition: "drafted",
      lane: "realtime",
    };
    if (chained === "chained") {
      await twinExecutionChain(client, TEST_AUDIT_HMAC_KEY).append(
        executionAuditEntry(
          record.trigger,
          record.instructionsDigest,
          record.disposition,
        ),
      );
    }
    await new TwinExecutionStore({
      client,
      twinId,
      executionId,
    }).recordExecution(record);
    return { executionId, twinId };
  }

  /**
   * The class's tally, as this database stands right now.
   *
   * BASELINE-RELATIVE, BECAUSE THIS FILE'S OWN CORPUS HOLDS REAL EXECUTIONS
   * (ticket #172). Every `processPendingWaEvents` above drives the drafting
   * automation, so `public.executions` is not empty by the time these tests
   * run — and an absolute count here would be a test about how many drafts
   * the file happened to mint. The DELTA is the claim.
   */
  async function repTally(
    client: pg.Client,
  ): Promise<{ acts: number; entries: number }> {
    const report = await auditChainCoverageInDb(client);
    const tally = report.mustChain.find((t) => t.class === "rep_execution")!;
    return { acts: tally.acts ?? -1, entries: tally.entries };
  }

  it("is green over the executions this file's own drafts really produced", async () => {
    // The corpus above is minted through the CONSUMER, so this is the claim
    // over acts the product performed rather than rows a fixture inserted —
    // which is what this whole file exists to be.
    await withClient(async (client) => {
      const tally = await repTally(client);
      expect(tally.acts).toBeGreaterThan(0);
      expect(tally.entries).toBe(tally.acts);
      expect(
        violationsFor(await auditChainCoverageInDb(client), "rep_execution"),
      ).toEqual([]);
    });
  });

  it("is green over records written beside their entries, and counts both", async () => {
    await withClient(async (client) => {
      const before = await repTally(client);
      await client.query("BEGIN");
      try {
        await plantRepExecution(client, "chained");
        await plantRepExecution(client, "chained");
        const report = await auditChainCoverageInDb(client);
        expect(violationsFor(report, "rep_execution")).toEqual([]);
        const tally = report.mustChain.find((t) => t.class === "rep_execution")!;
        expect(tally.join).toBe("count");
        expect(tally.acts).toBe(before.acts + 2);
        expect(tally.entries).toBe(before.entries + 2);
      } finally {
        await client.query("ROLLBACK");
      }
    });
  });

  it("is green over a workflow run — one record and one entry per step — and over the act that cancels one (ticket #323)", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const seat = await seatAtTheDoor(client, twin.twinId);
      const deps = { ...depsFor(client, twin), runs: createRunEngine() };
      const definition: RunDefinition = {
        name: "Contar lo pendiente",
        budget: { iterations: 1, tokens: 1 },
        steps: [
          { kind: "code", name: "tally", recipe: "count", inputs: { list: "input.items" } },
          {
            kind: "if",
            name: "found",
            when: { field: "tally.count", is: "more", value: 0 },
            then: [{ kind: "post", name: "report", text: "input.line" }],
            else: [{ kind: "end", name: "none" }],
          },
        ],
      };
      const seedRun = async (): Promise<string> => {
        const runId = randomUUID();
        writeRunContent(deps.harness.directory, twin.dek, runId, {
          definition,
          inputs: { items: ["a", "b"], line: "Quedan dos pendientes." },
          outputs: {},
        });
        await insertRun(client, {
          id: runId,
          twinId: twin.twinId,
          seatId: seat.seatId,
          automation: "inline",
          digest: runDigest(definition),
          sessionId: randomUUID(),
          stepCount: 4,
          budget: definition.budget,
          createdBy: "thread",
        });
        return runId;
      };
      const before = await repTally(client);
      const ran = await seedRun();
      const cancelled = await seedRun();
      await client.query("UPDATE runs SET cancelled = true WHERE id = $1", [cancelled]);
      const batch = openBatchWork();
      await advanceRuns(deps, new Date(), batch);
      await batch.lane.settle();
      // THREE STEPS RAN, ONE STEP WAS CLOSED BY THE CANCEL: four records, four entries.
      const after = await repTally(client);
      expect(after.acts - before.acts).toBe(4);
      expect(after.entries - before.entries).toBe(4);
      expect(violationsFor(await auditChainCoverageInDb(client), "rep_execution")).toEqual([]);
      const states = await client.query<{ id: string; state: string }>(
        "SELECT id, state FROM runs WHERE id = ANY($1::uuid[])",
        [[ran, cancelled]],
      );
      expect(new Map(states.rows.map((row) => [row.id, row.state]))).toEqual(
        new Map([
          [ran, "succeeded"],
          [cancelled, "failed"],
        ]),
      );
    });
  });

  it("GOES RED on a record with no entry, and says how many are missing", async () => {
    await withClient(async (client) => {
      const before = await repTally(client);
      await client.query("BEGIN");
      try {
        await plantRepExecution(client, "unchained");
        const red = await auditChainCoverageInDb(client);
        expect(violationsFor(red, "rep_execution")).toEqual([
          {
            class: "rep_execution",
            subject: `${before.acts + 1} act(s), ${before.entries} entr${before.entries === 1 ? "y" : "ies"}`,
            reason:
              "1 `execution` act(s) of this class have no chain entry (ADR-0020, ADR-0014 as amended, spec #171 decision 12)",
          },
        ]);
      } finally {
        await client.query("ROLLBACK");
      }
      // ...and the rollback really took it: a planted violation that
      // survived would redden every CI step after this file.
      expect((await auditChainCoverageInDb(client)).violations).toEqual([]);
    });
  });

  it("does not count the owner twin's entries as its own, or the other way round", async () => {
    // THE TWO CLASSES PARTITION THE ACTION WORD. Both sides write
    // `execution` under the caller `execution`, and the owner class's
    // predicate was `TRUE` until this ticket — so a rep-side entry on the
    // shared chain would have been counted as an owner entry, and the owner
    // class's tally, printed beside `owner.executions`' act count, would
    // have been about something else.
    await withClient(async (client) => {
      const before = await repTally(client);
      await client.query("BEGIN");
      try {
        await plantRepExecution(client, "chained");
        const report = await auditChainCoverageInDb(client);
        const owner = report.mustChain.find((t) => t.class === "execution")!;
        const rep = report.mustChain.find((t) => t.class === "rep_execution")!;
        // No owner turn is minted in this file, and this file's own
        // `plantExecution` rolls back — so the owner side is honestly empty
        // here, which is the point: the rep entry below does not move it.
        expect(owner.acts).toBe(0);
        expect(owner.entries).toBe(0);
        expect(rep.acts).toBe(before.acts + 1);
        expect(rep.entries).toBe(before.entries + 1);
        expect(report.violations).toEqual([]);
      } finally {
        await client.query("ROLLBACK");
      }
    });
  });

  it("stores the reference the entry carries, and no chat address", async () => {
    // The row and the entry come from ONE `triggerRef`, so they cannot
    // describe different runs.
    await withClient(async (client) => {
      await client.query("BEGIN");
      try {
        const { executionId, twinId } = await plantRepExecution(
          client,
          "chained",
        );
        const row = await client.query<{
          trigger_ref: string;
          trigger_kind: string;
          trigger_mechanism: string;
          lane: string;
          tool_names: string[];
          iterations: number;
          tokens_input: number;
        }>("SELECT * FROM executions WHERE id = $1", [executionId]);
        expect(row.rows[0]!.trigger_ref).toBe(
          `trigger:chat_turn mechanism:seam_event twin:${twinId} event:1 events:1`,
        );
        expect(row.rows[0]!.trigger_kind).toBe("chat_turn");
        expect(row.rows[0]!.trigger_mechanism).toBe("seam_event");
        expect(row.rows[0]!.lane).toBe("realtime");
        expect(row.rows[0]!.tool_names).toEqual(["search_memory", "create_draft"]);
        expect(row.rows[0]!.iterations).toBe(2);
        expect(row.rows[0]!.tokens_input).toBe(10);
        const entry = await client.query<{ ref: string }>(
          "SELECT ref FROM audit_chain WHERE action = 'execution' ORDER BY id DESC LIMIT 1",
        );
        expect(entry.rows[0]!.ref).toBe(
          `${row.rows[0]!.trigger_ref} instructions:planteddigest0000000000000000000`,
        );
        expect(entry.rows[0]!.ref).not.toContain("@");
      } finally {
        await client.query("ROLLBACK");
      }
    });
  });

  it("refuses a reference carrying a chat address, in the store itself", async () => {
    // The claim this ticket exists for, made structural. A JID cannot reach
    // this column through `triggerRef`; the CHECK is what answers the next
    // occasion, a fixture and a psql session.
    await withClient(async (client) => {
      await client.query("BEGIN");
      try {
        await expect(
          client.query(
            `INSERT INTO executions
               (twin_id, trigger_kind, trigger_mechanism, trigger_ref,
                instructions_digest, tool_names, lane, started_at, ended_at,
                iterations, tokens_input, tokens_output, disposition)
             VALUES ($1, 'chat_turn', 'seam_event',
                     'trigger:chat_turn chat:5215550001@s.whatsapp.net',
                     'd', ARRAY['t'], 'realtime', now(), now(), 1, 1, 1, 'drafted')`,
            [randomUUID()],
          ),
        ).rejects.toThrow(/executions_trigger_ref_content_free_check/u);
      } finally {
        await client.query("ROLLBACK");
      }
    });
  });

  it("is append-only: a record of a run that happened does not change", async () => {
    await withClient(async (client) => {
      for (const statement of [
        "UPDATE executions SET disposition = 'no-action' WHERE id = $1",
        "DELETE FROM executions WHERE id = $1",
      ]) {
        await client.query("BEGIN");
        try {
          const { executionId } = await plantRepExecution(client, "chained");
          await expect(client.query(statement, [executionId])).rejects.toThrow(
            /append-only/u,
          );
        } finally {
          await client.query("ROLLBACK");
        }
      }
    });
  });

  it("refuses to append outside a transaction — the entry and the record commit together or not at all", async () => {
    await withClient(async (client) => {
      await expect(
        twinExecutionChain(client, TEST_AUDIT_HMAC_KEY).append({
          caller: "execution",
          action: "execution",
          ref: "trigger:chat_turn mechanism:seam_event twin:x event:1 events:1",
          outcome: "drafted",
        }),
      ).rejects.toThrow(/open transaction/u);
    });
  });
});

describe("coverage over a machine merge (ADR-0035, ruling of 2026-08-31)", () => {
  it("goes red when the merge's entry is gone, and names that merge alone", async () => {
    await withClient(async (client) => {
      const { twin, tag, entityId: first } = await mintCorpus(client);
      // A SECOND entity in the same company, so there are two records to
      // become one. Both were filed by real rep-confirmed bindings.
      const second = await confirmABinding(client, twin, `${tag}9`);

      const edge = await fileMerge(
        { db: client, hmacKey: TEST_AUDIT_HMAC_KEY },
        {
          companyId: twin.companyId,
          loserEntityId: second,
          winnerEntityId: first,
          status: "merged",
          // The act that asked nobody — which is the whole reason it chains.
          performedBy: "machine",
          matchedOn: "phone",
          matchedValue: "+5215555000000",
        },
      );

      // GREEN FIRST, so the red below is the entry's absence and not the
      // corpus being wrong.
      expect((await auditChainCoverageInDb(client)).violations).toEqual([]);

      const entry = await mergeEntry(client, edge.id);
      // The outcome carries the rung as a CATEGORY. The value that fired it
      // is an email or a phone and must never reach the chain (ADR-0020).
      expect(entry.outcome).toBe("performed:machine:phone");
      expect(entry.outcome).not.toContain("5215555000000");

      await withEntryLifted(client, entry.id, async () => {
        const report = await auditChainCoverageInDb(client);
        expect(report.violations).toEqual([
          {
            class: "entity_merge_performed",
            subject: `entity_merge ${edge.id}`,
            reason:
              "no `entity_merge` chain entry records this act (ADR-0020 and ADR-0035, under Diego's ruling of 2026-08-31)",
          },
        ]);
      });

      // Put back, and the chain still verifies — the proof left no damage.
      expect((await auditChainCoverageInDb(client)).violations).toEqual([]);
      expect(
        (await verifyAuditChainInDb(client, TEST_AUDIT_HMAC_KEY)).valid,
      ).toBe(true);
    });
  });

  it("leaves no entry behind when the merge itself does not commit", async () => {
    await withClient(async (client) => {
      const { twin, tag, entityId: first } = await mintCorpus(client);
      const second = await confirmABinding(client, twin, `${tag}6`);

      const before = await client.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM audit_chain WHERE action = 'entity_merge'",
      );

      // THE OTHER HALF OF "same transaction". The suppression proof above
      // shows the entry is written when the edge is; this shows it is NOT
      // written when the edge is not. A record of a merge that never
      // happened is worse than a missing one — it is the chain asserting
      // something false, which is the one thing it exists not to do.
      await client.query("BEGIN");
      const edge = await fileMerge(
        { db: client, hmacKey: TEST_AUDIT_HMAC_KEY },
        {
          companyId: twin.companyId,
          loserEntityId: second,
          winnerEntityId: first,
          status: "merged",
          performedBy: "machine",
          matchedOn: "phone",
          matchedValue: "+5215555000003",
        },
      );
      // Visible inside the transaction that wrote it...
      await mergeEntry(client, edge.id);
      await client.query("ROLLBACK");

      // ...and gone with the edge.
      const after = await client.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM audit_chain WHERE action = 'entity_merge'",
      );
      expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
      const orphan = await client.query(
        "SELECT 1 FROM audit_chain WHERE (' ' || ref || ' ') LIKE ('% merge:' || $1 || ' %')",
        [edge.id],
      );
      expect(orphan.rows).toHaveLength(0);
      // The chain still verifies: a rollback is not a gap.
      expect(
        (await verifyAuditChainInDb(client, TEST_AUDIT_HMAC_KEY)).valid,
      ).toBe(true);
    });
  });

  it("counts the merge as an act, so a green over it is not vacuous", async () => {
    await withClient(async (client) => {
      const { twin, tag, entityId: first } = await mintCorpus(client);
      const second = await confirmABinding(client, twin, `${tag}8`);
      await fileMerge(
        { db: client, hmacKey: TEST_AUDIT_HMAC_KEY },
        {
          companyId: twin.companyId,
          loserEntityId: second,
          winnerEntityId: first,
          status: "merged",
          performedBy: "machine",
          matchedOn: "phone",
          matchedValue: "+5215555000001",
        },
      );

      const report = await auditChainCoverageInDb(client);
      const tally = report.mustChain.find(
        (t) => t.class === "entity_merge_performed",
      );
      // THE POINT OF NAMING IT IN CI. A class with zero acts is green
      // whatever the writer does; this asserts the corpus actually holds
      // one, so the green means something.
      expect(tally?.acts).toBeGreaterThan(0);
      expect(tally?.entries).toBe(tally?.acts);
    });
  });
});

describe("the check's own CLI, exercised the way CI runs it", () => {
  it("exits 0 and names what it examined over a corpus of real acts", async () => {
    await withClient(mintCorpus);

    const { stdout } = await runCheck([
      "--require-acts=entity_create,fact_retraction_refused",
    ]);
    expect(stdout).toContain("Audit coverage green across");
    // The green states its own extent — a reader told nothing about the
    // classes no join reaches would read it as absolute.
    expect(stdout).toContain("were NOT checked and this green says nothing");
    expect(stdout).toContain("fact_retraction_refused");
    // The classes no join can reach are printed too — a green that hid them
    // would read as covering everything (ticket #78).
    expect(stdout).toContain("NOT COVERED");
    // ...and so are the exclusions, so "0 violations" is readable.
    expect(stdout).toContain("deliberately unchained");
  });

  it("exits 1 and says so when an act owes an entry it does not have", async () => {
    await withClient(async (client) => {
      const { twin, tag } = await mintCorpus(client);
      // COMMITTED, because the CLI is another process and cannot see this
      // one's open transaction — so the plant is a `wa_event_processing`
      // marker (an ordinary row, removable) rather than a lifted chain
      // entry (append-only by trigger). Same defect either way: a rep act
      // the seam recorded and the chain did not.
      const forgotten = await insertWaEvent(client, twin.dek, {
        twinId: twin.twinId,
        companyId: twin.companyId,
        seatId: twin.seatId,
        chatJid: SELF_CHAT,
        senderJid: SELF_CHAT,
        fromMe: true,
        messageId: `3EB0-REP-CLI-${tag}`,
        text: "7 no",
        quotedMessageId: `WAMID-DISCLOSURE-${tag}`,
      });
      await client.query(
        "INSERT INTO wa_event_processing (event_id, twin_id, disposition) VALUES ($1, $2, 'correction_refused')",
        [forgotten, twin.twinId],
      );
      try {
        await expect(runCheck([])).rejects.toMatchObject({
          code: 1,
          stderr: expect.stringContaining("AUDIT COVERAGE RED"),
        });
      } finally {
        await client.query("DELETE FROM wa_event_processing WHERE event_id = $1", [
          forgotten,
        ]);
      }
    });
  });

  it("refuses to pass when the class a step exists to check has no act", async () => {
    // The bare floor is over the whole database, and every corpus here
    // holds entity creates — so a CI step whose own class had no act would
    // clear `--require-acts` and prove nothing. Naming the class is what
    // makes the step's own claim checkable.
    //
    // `question_answer` IS THE CASE THAT CANNOT BE SATISFIED AT ALL SINCE
    // #218, which is why it is still the one named here: the store it
    // joined is dropped, so the class is `unjoinable` and its act count is
    // null. A named class with no act and a named class with no JOIN are
    // the same refusal — "this run proves nothing about it" — and that is
    // the property the CI steps rest on.
    await withClient(mintCorpus);
    await expect(runCheck(["--require-acts=question_answer"])).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('class "question_answer" has no act'),
    });
    await expect(runCheck(["--require-acts=no_such_class"])).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("AUDIT COVERAGE MISCONFIGURED"),
    });
  });

  it("refuses to pass on a corpus holding no must-chain act at all", async () => {
    // The lesson `--require-entries` already learned on `audit-verify`: run
    // the invariants out of CI's order and the verifier said "0 entries.
    // Audit chain verifies end to end." A coverage check over a corpus with
    // no acts would say the same thing about coverage.
    //
    // RESETS THE SEAM, so it is the last test in this file — the same
    // mint-then-check ordering CI itself lives under.
    await resetAndMigrate();
    await expect(runCheck(["--require-acts"])).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("AUDIT COVERAGE INCONCLUSIVE"),
    });
  });
});

/**
 * THE CI CORPUS, minted last and left behind — the same shape `fr73.int.test.ts`
 * uses for its own invariant step.
 *
 * It has to be here, and it has to be last. No other minted corpus holds a
 * merge, so `entity_merge_performed` would be green over ZERO acts on every
 * CI run — checked in name, vacuous in fact. And the CLI suite above ends by
 * resetting the database on purpose (it proves the check refuses an empty
 * corpus), so anything minted before it is gone.
 *
 * `packages/aperture/src/merge.int.test.ts` cannot serve either: it writes
 * edges straight to the store to exercise its constraints, and a merge that never went through the writer legitimately
 * has no entry. The check flags those, correctly — which is a reason to mint
 * from the real path here rather than to weaken the class.
 */
describe("the CI merge corpus (ADR-0035, ruling of 2026-08-31)", () => {
  it("leaves a machine merge and its chain entry for scripts/audit-coverage-check.mjs", async () => {
    await withClient(async (client) => {
      const { twin, tag, entityId: first } = await mintCorpus(client);
      const second = await confirmABinding(client, twin, `${tag}7`);

      const edge = await fileMerge(
        { db: client, hmacKey: TEST_AUDIT_HMAC_KEY },
        {
          companyId: twin.companyId,
          loserEntityId: second,
          winnerEntityId: first,
          status: "merged",
          performedBy: "machine",
          matchedOn: "phone",
          matchedValue: "+5215555000002",
        },
      );

      // Left COMMITTED, unlike every proof above — that is the point of this
      // test. Asserted here so a corpus that stopped being minted fails in
      // this file rather than silently in a CI step nobody reads.
      const entry = await mergeEntry(client, edge.id);
      expect(entry.outcome).toBe("performed:machine:phone");
      expect((await auditChainCoverageInDb(client)).violations).toEqual([]);
    });
  });
});

/**
 * THE REPEATS, THE END, THE CHILDREN AND THE REPLY WAIT, DRIVEN BY THE PASS
 * (ticket #324; spec #318 decision 23 as amended): runs seeded the way the
 * thread's start writes them, with steps that need no model, so what is
 * asserted is the engine — the order steps run in, what each left, and one
 * record and one chain entry per step a run or a child ran.
 */
describe("runs repeat, end, fan out to children and wait on a reply (ticket #324)", () => {
  const PASS = new Date("2026-10-08T15:00:00.000Z");

  async function seeded(
    client: pg.Client,
    definition: RunDefinition,
    inputs: Readonly<Record<string, RunValue>>,
  ): Promise<{
    readonly twin: Seat;
    readonly deps: TwinRuntimeDeps & { readonly runs: ReturnType<typeof createRunEngine> };
    readonly runId: string;
    readonly sessionId: string;
    tick(now: Date): Promise<void>;
  }> {
    const twin = freshTwin();
    const seat = await seatAtTheDoor(client, twin.twinId);
    const deps = { ...depsFor(client, twin), runs: createRunEngine() };
    const runId = randomUUID();
    const sessionId = randomUUID();
    writeRunContent(deps.harness.directory, twin.dek, runId, { definition, inputs, outputs: {} });
    await insertRun(client, {
      id: runId,
      twinId: twin.twinId,
      seatId: seat.seatId,
      automation: "inline",
      digest: runDigest(definition),
      sessionId,
      stepCount: layout(definition).length,
      budget: definition.budget,
      createdBy: "thread",
    });
    return {
      twin,
      deps,
      runId,
      sessionId,
      async tick(now) {
        const batch = openBatchWork();
        await advanceRuns(deps, now, batch);
        await batch.lane.settle();
      },
    };
  }

  async function runRow(client: pg.Client, runId: string): Promise<{ state: string; current_step: number }> {
    const rows = await client.query<{ state: string; current_step: number }>(
      "SELECT state, current_step FROM runs WHERE id = $1",
      [runId],
    );
    return rows.rows[0]!;
  }

  /** The executions a run's steps left, in order: the step index each names. */
  async function stepRecords(client: pg.Client, runId: string): Promise<number[]> {
    const rows = await client.query<{ trigger_ref: string }>(
      "SELECT trigger_ref FROM executions WHERE trigger_kind = 'run_step' AND trigger_ref LIKE $1 ORDER BY started_at, id",
      [`% run:${runId} %`],
    );
    return rows.rows.map((row) => Number(/ step:(\d+)$/u.exec(row.trigger_ref)![1]));
  }

  /** Each report's parts as `kind: text`, oldest first — whose words each is (ticket #358). */
  async function reportParts(client: pg.Client, twin: Seat, runId: string): Promise<string[][]> {
    const rows = await client.query<{ parts_enc: Buffer }>(
      `SELECT p.parts_enc FROM posts p JOIN executions e ON e.id = p.execution_id
        WHERE p.twin_id = $1 AND e.trigger_ref LIKE $2 ORDER BY p.posted_at, p.id`,
      [twin.twinId, `% run:${runId} %`],
    );
    return rows.rows.map((row) =>
      openSealedParts(twin.dek, row.parts_enc).flatMap((part) =>
        part.kind === "prose" || part.kind === "receipt" ? [`${part.kind}: ${part.text}`] : [],
      ),
    );
  }

  /** The words of the report posts a run left, opened. */
  async function reports(client: pg.Client, twin: Seat, runId: string): Promise<string[]> {
    const rows = await client.query<{ content_enc: Buffer }>(
      `SELECT n.content_enc FROM notices n JOIN executions e ON e.id = n.execution_id
        WHERE n.twin_id = $1 AND e.trigger_ref LIKE $2 ORDER BY n.created_at`,
      [twin.twinId, `% run:${runId} %`],
    );
    return rows.rows.map((row) => Buffer.from(twin.dek.decrypt(row.content_enc)).toString("utf8"));
  }

  async function chainIsWhole(client: pg.Client): Promise<void> {
    const report = await auditChainCoverageInDb(client);
    const tally = report.mustChain.find((t) => t.class === "rep_execution")!;
    expect(tally.entries).toBe(tally.acts);
    expect(violationsFor(report, "rep_execution")).toEqual([]);
  }

  it("a while runs its body three times in sequence and stops when its condition fails", async () => {
    await withClient(async (client) => {
      const run = await seeded(
        client,
        {
          name: "Contar tres veces",
          budget: { iterations: 1, tokens: 1 },
          steps: [
            {
              kind: "while",
              name: "loop",
              when: { field: "loop.iteration", is: "less", value: 3 },
              cap: 5,
              body: [{ kind: "code", name: "tally", recipe: "count", inputs: { list: "input.items" } }],
            },
            { kind: "post", name: "report", text: "input.line" },
          ],
        },
        { items: ["a", "b"], line: "Conté tres veces." },
      );
      await run.tick(PASS);
      expect(await runRow(client, run.runId)).toMatchObject({ state: "succeeded", current_step: 2 });
      // THE WHILE, ITS BODY, THREE TIMES; THE WHILE ONCE MORE, STOPPING; THE REPORT.
      expect(await stepRecords(client, run.runId)).toEqual([0, 1, 0, 1, 0, 1, 0, 2]);
      expect(await reports(client, run.twin, run.runId)).toEqual([expect.stringContaining("Conté tres veces.")]);
      await chainIsWhole(client);
    });
  });

  it("an end inside a branch ends the run succeeded, its value carried into the report", async () => {
    await withClient(async (client) => {
      const run = await seeded(
        client,
        {
          name: "Terminar temprano",
          budget: { iterations: 1, tokens: 1 },
          steps: [
            { kind: "code", name: "tally", recipe: "count", inputs: { list: "input.items" } },
            {
              kind: "if",
              name: "found",
              when: { field: "tally.count", is: "more", value: 0 },
              then: [{ kind: "end", name: "early", value: "input.line" }],
              else: [],
            },
            { kind: "post", name: "report", text: "input.other" },
          ],
        },
        { items: ["a"], line: "Ya quedó, sin pasar al final.", other: "El final." },
      );
      await run.tick(PASS);
      expect(await runRow(client, run.runId)).toMatchObject({ state: "succeeded", current_step: 2 });
      expect(await reports(client, run.twin, run.runId)).toEqual([expect.stringContaining("Ya quedó, sin pasar al final.")]);
      // AN `end`'S OWN VALUE IS THE TWIN'S WORDS, so it stays prose (ticket #358).
      expect(await reportParts(client, run.twin, run.runId)).toEqual([["prose: Ya quedó, sin pasar al final."]]);
      await chainIsWhole(client);
    });
  });

  /** Each step record a run left, in order: its step and the word it ended with. */
  async function stepWords(client: pg.Client, runId: string): Promise<[number, string][]> {
    const rows = await client.query<{ trigger_ref: string; disposition: string }>(
      "SELECT trigger_ref, disposition FROM executions WHERE trigger_kind = 'run_step' AND trigger_ref LIKE $1 ORDER BY started_at, id",
      [`% run:${runId} %`],
    );
    return rows.rows.map((row) => [Number(/ step:(\d+)$/u.exec(row.trigger_ref)![1]), row.disposition]);
  }

  it("records each step's word from what happened: an act that drafted `drafted`, an end that landed a card `posted`, one that landed none `no-action` (#358)", async () => {
    await withClient(async (client) => {
      const drafting = await seeded(
        client,
        {
          name: "Escribirle a Laura",
          budget: { iterations: 1, tokens: 1 },
          steps: [
            {
              kind: "act",
              name: "write",
              tool: "create_draft",
              inputs: { entity: { value: "c1" }, text: { value: "Laura, ya está tu cotización." } },
            },
            { kind: "end", name: "done", value: "input.line" },
          ],
        },
        { line: "Le dejé el mensaje listo a Laura." },
      );
      drafting.twin.bundle.confirmChatBinding({
        chatJid: "5215550044@s.whatsapp.net",
        entityId: randomUUID(),
        displayName: "Laura Garza",
        confirmedAt: new Date().toISOString(),
      });
      await drafting.tick(PASS);
      expect(await runRow(client, drafting.runId)).toMatchObject({ state: "succeeded" });
      expect(await stepWords(client, drafting.runId)).toEqual([
        [0, "drafted"],
        [1, "posted"],
      ]);
      // ...AND THE WORD HAS ITS DRAFT BEHIND IT: the card `create_draft` held
      // lands with the step, code's sentence above it — an act has no words.
      const landed = await client.query<{ parts_enc: Buffer }>(
        `SELECT p.parts_enc FROM posts p JOIN drafts d ON d.id = p.draft_id
          WHERE p.twin_id = $1 AND d.destination = $2`,
        [drafting.twin.twinId, "5215550044@s.whatsapp.net"],
      );
      expect(landed.rows.map((row) => openSealedParts(drafting.twin.dek, row.parts_enc).map((part) => part.kind))).toEqual([["draft"]]);

      const reported = await seeded(
        client,
        {
          name: "Avisar y terminar",
          budget: { iterations: 1, tokens: 1 },
          steps: [
            { kind: "post", name: "report", text: "input.line" },
            { kind: "end", name: "done" },
          ],
        },
        { line: "Listo el resumen." },
      );
      await reported.tick(PASS);
      expect(await stepWords(client, reported.runId)).toEqual([
        [0, "posted"],
        [1, "no-action"],
      ]);
      await chainIsWhole(client);
    });
  });

  it("keeps a report's list beside code's sentence when the words it named came back empty (#358, Codex r1)", async () => {
    await withClient(async (client) => {
      const run = await seeded(
        client,
        {
          name: "Lista sola",
          budget: { iterations: 1, tokens: 1 },
          steps: [{ kind: "post", name: "report", text: "input.lines", list: "input.rows" }],
        },
        { lines: [], rows: ["uno", "dos"] },
      );
      await run.tick(PASS);
      const parts = await client.query<{ parts_enc: Buffer }>(
        `SELECT p.parts_enc FROM posts p JOIN executions e ON e.id = p.execution_id
          WHERE p.twin_id = $1 AND e.trigger_ref LIKE $2`,
        [run.twin.twinId, `% run:${run.runId} %`],
      );
      expect(parts.rows.map((row) => openSealedParts(run.twin.dek, row.parts_enc))).toEqual([
        [
          { kind: "receipt", text: "Terminé «Lista sola»." },
          { kind: "data", shape: "list", rows: [{ text: "uno" }, { text: "dos" }] },
        ],
      ]);
    });
  });

  it("records a cancel that lands its receipt `posted` (#358)", async () => {
    await withClient(async (client) => {
      const run = await seeded(
        client,
        {
          name: "Esperar a Sergio",
          budget: { iterations: 1, tokens: 1 },
          steps: [
            { kind: "wait", name: "later", until: { after: { days: 2 } } },
            { kind: "post", name: "report", text: "input.line" },
          ],
        },
        { line: "Sergio no contestó." },
      );
      await run.tick(PASS);
      await setFlag(client, { twinId: run.twin.twinId, runId: run.runId, flag: "cancelled", value: true });
      await run.tick(PASS);
      expect(await stepWords(client, run.runId)).toEqual([[0, "posted"]]);
      expect(await reportParts(client, run.twin, run.runId)).toEqual([["receipt: Cancelé «Esperar a Sergio»."]]);
      await chainIsWhole(client);
    });
  });

  /**
   * A parent that makes one child per item: «lento» waits an hour, «malo»
   * fails on an empty report, and every child ends with its item as its value.
   */
  const FAN_OUT: RunDefinition = {
    name: "Uno por uno",
    budget: { iterations: 60, tokens: 60 },
    steps: [
      {
        kind: "each",
        name: "per",
        over: "input.items",
        item: "item",
        body: [
          {
            kind: "if",
            name: "slow",
            when: { field: "input.item", is: "equal", value: "lento" },
            then: [{ kind: "wait", name: "later", until: { after: { hours: 1 } } }],
            else: [],
          },
          {
            kind: "if",
            name: "broken",
            when: { field: "input.item", is: "equal", value: "malo" },
            then: [{ kind: "post", name: "oops", text: "input.missing" }],
            else: [],
          },
          { kind: "end", name: "done", value: "input.item" },
        ],
      },
      { kind: "post", name: "report", text: "per.outputs" },
    ],
  };

  async function childrenOf(client: pg.Client, parent: string): Promise<{ id: string; state: string; session_id: string }[]> {
    const rows = await client.query<{ id: string; state: string; session_id: string }>(
      "SELECT id, state, session_id FROM runs WHERE parent_run_id = $1 ORDER BY created_at, id",
      [parent],
    );
    return rows.rows;
  }

  it("an each makes one child per item, each forked from the parent's session; one waiting holds nobody, and the parent reports after the last", async () => {
    await withClient(async (client) => {
      const run = await seeded(client, FAN_OUT, { items: ["uno", "lento", "tres"] });
      // THE PARENT'S CONVERSATION AS IT STANDS when the each begins, written
      // by the SDK child the way a run's start writes it.
      await appendToRunSession(run.deps.harness, "claude-sonnet-5", run.sessionId, ["[Run] the parent's opening line"]);
      const parentFile = sessionFile(run.deps.harness.directory, run.sessionId);
      const parentBefore = readFileSync(parentFile, "utf8");

      await run.tick(PASS);
      expect(await runRow(client, run.runId)).toMatchObject({ state: "waiting", current_step: 0 });
      const children = await childrenOf(client, run.runId);
      expect(children).toHaveLength(3);
      expect(new Set(children.map((child) => child.session_id)).size).toBe(3);
      // EACH CHILD'S SESSION IS THE SDK'S FORK: the parent's conversation, under
      // the child's own id, and the parent's file as it was.
      for (const child of children) {
        expect(child.session_id).not.toBe(run.sessionId);
        const forked = readFileSync(sessionFile(run.deps.harness.directory, child.session_id), "utf8");
        expect(forked).toContain("the parent's opening line");
        expect(forked).toContain(`"sessionId":"${child.session_id}"`);
      }
      expect(readFileSync(parentFile, "utf8")).toBe(parentBefore);

      // THE CHILDREN RUN AS RUNS: two finish, «lento» parks on its hour.
      await run.tick(PASS);
      expect((await childrenOf(client, run.runId)).map((child) => child.state)).toEqual(["succeeded", "waiting", "succeeded"]);
      await run.tick(PASS);
      expect(await runRow(client, run.runId)).toMatchObject({ state: "waiting", current_step: 0 });

      // ITS HOUR PASSES: the last child ends, and the parent reports over all three.
      const later = new Date(PASS.getTime() + 2 * 60 * 60 * 1000);
      await run.tick(later);
      await run.tick(later);
      expect(await runRow(client, run.runId)).toMatchObject({ state: "succeeded", current_step: 1 });
      const [report] = await reports(client, run.twin, run.runId);
      expect(report).toContain("uno\nlento\ntres");

      // ONE RECORD PER STEP A CHILD RAN, under the child's own run id.
      const [first, slow] = children;
      expect(await stepRecords(client, first!.id)).toEqual([0, 2, 4]);
      expect(await stepRecords(client, slow!.id)).toEqual([0, 1, 2, 4]);
      expect(await reports(client, run.twin, first!.id)).toEqual([]);
      await chainIsWhole(client);
    });
  });

  it("a failed child leaves its siblings to finish, and the parent's report says where it stopped", async () => {
    await withClient(async (client) => {
      const run = await seeded(client, FAN_OUT, { items: ["uno", "malo", "tres"] });
      await run.tick(PASS);
      // A PARENT WITH NO CONVERSATION YET LEAVES EACH CHILD A NEW ONE OF ITS OWN.
      for (const child of await childrenOf(client, run.runId)) {
        expect(readFileSync(sessionFile(run.deps.harness.directory, child.session_id), "utf8")).toContain("a child of run");
      }
      await run.tick(PASS);
      expect((await childrenOf(client, run.runId)).map((child) => child.state)).toEqual(["succeeded", "failed", "succeeded"]);
      await run.tick(PASS);
      expect(await runRow(client, run.runId)).toMatchObject({ state: "succeeded" });
      const [report] = await reports(client, run.twin, run.runId);
      expect(report).toContain("uno");
      expect(report).toContain("tres");
      expect(report).toContain("Se detuvo «Uno por uno · malo» en el paso 4 de 5.");
      await chainIsWhole(client);
    });
  });

  it("an each over nobody — the rep picked none — ends the run well, with code's sentence for its report", async () => {
    await withClient(async (client) => {
      const run = await seeded(client, FAN_OUT, { items: [] });
      await run.tick(PASS);
      expect(await runRow(client, run.runId)).toMatchObject({ state: "succeeded", current_step: 1 });
      expect(await childrenOf(client, run.runId)).toEqual([]);
      expect(await reports(client, run.twin, run.runId)).toEqual([expect.stringContaining("Terminé «Uno por uno».")]);
      // CODE'S SENTENCE IS A RECEIPT (ticket #358).
      expect(await reportParts(client, run.twin, run.runId)).toEqual([["receipt: Terminé «Uno por uno»."]]);
    });
  });

  it("charges the children's shares to the parent, and gives a child that said nothing code's line (Codex r2)", async () => {
    await withClient(async (client) => {
      const run = await seeded(
        client,
        {
          ...FAN_OUT,
          steps: [
            { kind: "each", name: "per", over: "input.items", item: "item", body: [{ kind: "end", name: "done" }] },
            { kind: "post", name: "report", text: "per.outputs" },
          ],
        },
        { items: ["uno", "dos"] },
      );
      await run.tick(PASS);
      const spent = await client.query<{ spent_iterations: number; spent_tokens: number }>(
        "SELECT spent_iterations, spent_tokens FROM runs WHERE id = $1",
        [run.runId],
      );
      expect(spent.rows).toEqual([{ spent_iterations: 60, spent_tokens: 60 }]);
      await run.tick(PASS);
      await run.tick(PASS);
      expect(await runRow(client, run.runId)).toMatchObject({ state: "succeeded" });
      expect(await reports(client, run.twin, run.runId)).toEqual([
        expect.stringContaining("Terminé «Uno por uno · uno».\nTerminé «Uno por uno · dos»."),
      ]);
    });
  });

  it("refuses a fan-out its parent's budget cannot fund, making no child (Codex r1)", async () => {
    await withClient(async (client) => {
      const run = await seeded(client, { ...FAN_OUT, budget: { iterations: 2, tokens: 60 } }, { items: ["uno", "dos", "tres"] });
      await run.tick(PASS);
      expect(await runRow(client, run.runId)).toMatchObject({ state: "failed", current_step: 0 });
      expect(await childrenOf(client, run.runId)).toEqual([]);
      expect(await reports(client, run.twin, run.runId)).toEqual([expect.stringContaining("se acabó lo que tenía")]);
      expect(await reportParts(client, run.twin, run.runId)).toEqual([
        ["receipt: Paré «Uno por uno»: se acabó lo que tenía para ese trabajo. Queda en Trabajos en curso."],
      ]);
    });
  });

  it("a child's post is its line in the parent's report, and never a card of its own (Codex r1)", async () => {
    await withClient(async (client) => {
      const run = await seeded(
        client,
        {
          ...FAN_OUT,
          steps: [
            { kind: "each", name: "per", over: "input.items", item: "item", body: [{ kind: "post", name: "said", text: "input.item" }] },
            { kind: "post", name: "report", text: "per.outputs" },
          ],
        },
        { items: ["uno", "dos"] },
      );
      await run.tick(PASS);
      await run.tick(PASS);
      await run.tick(PASS);
      expect(await runRow(client, run.runId)).toMatchObject({ state: "succeeded" });
      for (const child of await childrenOf(client, run.runId)) expect(await reports(client, run.twin, child.id)).toEqual([]);
      expect(await reports(client, run.twin, run.runId)).toEqual([expect.stringContaining("uno\ndos")]);
    });
  });

  it("refuses the twenty-first child at run time, when the list arrives with the run", async () => {
    await withClient(async (client) => {
      const items = Array.from({ length: 21 }, (_, index) => `item ${String(index)}`);
      const run = await seeded(client, FAN_OUT, { items });
      await run.tick(PASS);
      expect(await runRow(client, run.runId)).toMatchObject({ state: "failed", current_step: 0 });
      expect(await childrenOf(client, run.runId)).toEqual([]);
    });
  });

  /** A run that waits a day for a customer's reply, then reports which side ended it. */
  function replyWait(): RunDefinition {
    return {
      name: "Esperar a que conteste",
      budget: { iterations: 1, tokens: 1 },
      steps: [
        { kind: "wait", name: "answer", until: { reply: "input.customer", within: { days: 1 } } },
        {
          kind: "if",
          name: "replied",
          when: { field: "answer.replied", is: "true" },
          then: [{ kind: "end", name: "yes", value: "input.yes" }],
          else: [{ kind: "end", name: "no", value: "input.later" }],
        },
      ],
    };
  }

  it("a reply wait is due when the customer writes, and says they replied — reading the message's id and instant, never its words", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const chat = "5218110000001@s.whatsapp.net";
      const reference = twin.bundle.referenceForChat(chat);
      const run = await seededFor(client, twin, replyWait(), { customer: `[c${String(reference)}]`, yes: "Contestó.", later: "Pasó el día." });
      await run.tick(PASS);
      expect(await runRow(client, run.runId)).toMatchObject({ state: "waiting", current_step: 0 });
      await run.tick(PASS);
      expect(await runRow(client, run.runId)).toMatchObject({ state: "waiting" });
      twin.bundle.ingestMessage({
        chatJid: chat,
        messageId: "REPLY-1",
        senderJid: chat,
        fromMe: false,
        occurredAt: new Date(Date.now() + 1000).toISOString(),
        content: "ya te pago mañana",
      });
      await run.tick(PASS);
      expect(await runRow(client, run.runId)).toMatchObject({ state: "succeeded" });
      expect(await reports(client, twin, run.runId)).toEqual([expect.stringContaining("Contestó.")]);
    });
  });

  it("a reply wait is due at its deadline when nobody writes, and says they did not reply", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const chat = "5218110000002@s.whatsapp.net";
      const reference = twin.bundle.referenceForChat(chat);
      const run = await seededFor(client, twin, replyWait(), { customer: `[c${String(reference)}]`, yes: "Contestó.", later: "Pasó el día." });
      await run.tick(PASS);
      await run.tick(new Date(PASS.getTime() + 2 * 24 * 60 * 60 * 1000));
      expect(await runRow(client, run.runId)).toMatchObject({ state: "succeeded" });
      expect(await reports(client, twin, run.runId)).toEqual([expect.stringContaining("Pasó el día.")]);
    });
  });

  it("the rep's answer to a run's card is an execution with its entry, and so is every step it resumes", async () => {
    await withClient(async (client) => {
      const run = await seeded(
        client,
        {
          name: "Elegir con quién",
          budget: { iterations: 1, tokens: 1 },
          steps: [
            {
              kind: "ask",
              name: "choose",
              question: { value: "¿Con quién empiezo?" },
              fields: [{ name: "who", kind: "pick_one", options: { value: ["Laura", "Torres"] } }],
            },
            { kind: "end", name: "done", value: "choose.who" },
          ],
        },
        {},
      );
      await run.tick(PASS);
      const card = await client.query<{ awaits_post_id: string }>(
        "SELECT awaits_post_id FROM run_steps WHERE run_id = $1 AND state = 'waiting'",
        [run.runId],
      );
      const seat = await client.query<{ id: string; company_id: string }>("SELECT id, company_id FROM seats WHERE twin_id = $1", [
        run.twin.twinId,
      ]);
      const answered = await performDashboardAct(
        {
          db: client,
          dek: run.twin.dek,
          twinId: run.twin.twinId,
          hmacKey: TEST_AUDIT_HMAC_KEY,
          bundle: run.twin.bundle,
          selfChatJid: SELF_CHAT,
          harnessDirectory: run.deps.harness.directory,
        },
        { companyId: seat.rows[0]!.company_id, seatId: seat.rows[0]!.id },
        { target: "post", route: "answerAsk", postId: card.rows[0]!.awaits_post_id, answers: { who: "Torres" } },
      );
      expect(answered).toBe("performed");
      const act = await client.query<{ disposition: string }>(
        "SELECT disposition FROM executions WHERE trigger_kind = 'dashboard_act' AND twin_id = $1",
        [run.twin.twinId],
      );
      expect(act.rows).toEqual([{ disposition: "acted" }]);
      await chainIsWhole(client);
      await run.tick(PASS);
      expect(await runRow(client, run.runId)).toMatchObject({ state: "succeeded" });
      expect(await stepRecords(client, run.runId)).toEqual([0, 0, 1]);
      await chainIsWhole(client);
    });
  });

  it("answers the step that asked even when another run's wait watches the same card, and the watcher goes on when it settles (Codex r3)", async () => {
    await withClient(async (client) => {
      const asker = await seeded(
        client,
        {
          name: "Elegir con quién",
          budget: { iterations: 1, tokens: 1 },
          steps: [
            { kind: "ask", name: "choose", question: { value: "¿Con quién empiezo?" }, fields: [{ name: "who", kind: "pick_one", options: { value: ["Laura", "Torres"] } }] },
            { kind: "end", name: "done", value: "choose.who" },
          ],
        },
        {},
      );
      await asker.tick(PASS);
      const card = (
        await client.query<{ awaits_post_id: string }>("SELECT awaits_post_id FROM run_steps WHERE run_id = $1", [asker.runId])
      ).rows[0]!.awaits_post_id;
      // A SECOND RUN OF THE SAME TWIN WAITS ON THAT CARD SETTLING.
      const watcherId = randomUUID();
      const watching: RunDefinition = {
        name: "Esperar la respuesta",
        budget: { iterations: 1, tokens: 1 },
        steps: [
          { kind: "wait", name: "settled", until: { settle: "input.card" } },
          { kind: "end", name: "done", value: "input.line" },
        ],
      };
      writeRunContent(asker.deps.harness.directory, asker.twin.dek, watcherId, { definition: watching, inputs: { card, line: "Ya contestó." }, outputs: {} });
      const seat = await client.query<{ id: string; company_id: string }>("SELECT id, company_id FROM seats WHERE twin_id = $1", [asker.twin.twinId]);
      await insertRun(client, {
        id: watcherId,
        twinId: asker.twin.twinId,
        seatId: seat.rows[0]!.id,
        automation: "inline",
        digest: runDigest(watching),
        sessionId: randomUUID(),
        stepCount: 2,
        budget: watching.budget,
        createdBy: "thread",
      });
      await asker.tick(PASS);
      expect(await runRow(client, watcherId)).toMatchObject({ state: "waiting" });
      const answered = await performDashboardAct(
        {
          db: client,
          dek: asker.twin.dek,
          twinId: asker.twin.twinId,
          hmacKey: TEST_AUDIT_HMAC_KEY,
          bundle: asker.twin.bundle,
          selfChatJid: SELF_CHAT,
          harnessDirectory: asker.deps.harness.directory,
        },
        { companyId: seat.rows[0]!.company_id, seatId: seat.rows[0]!.id },
        { target: "post", route: "answerAsk", postId: card, answers: { who: "Laura" } },
      );
      expect(answered).toBe("performed");
      await asker.tick(PASS);
      expect(await runRow(client, asker.runId)).toMatchObject({ state: "succeeded" });
      expect(await runRow(client, watcherId)).toMatchObject({ state: "succeeded" });
    });
  });

  /** `seeded`, over a twin the test set up first. */
  async function seededFor(
    client: pg.Client,
    twin: Seat,
    definition: RunDefinition,
    inputs: Readonly<Record<string, RunValue>>,
  ): Promise<{ readonly runId: string; tick(now: Date): Promise<void> }> {
    const seat = await seatAtTheDoor(client, twin.twinId);
    const deps = { ...depsFor(client, twin), runs: createRunEngine() };
    const runId = randomUUID();
    writeRunContent(deps.harness.directory, twin.dek, runId, { definition, inputs, outputs: {} });
    await insertRun(client, {
      id: runId,
      twinId: twin.twinId,
      seatId: seat.seatId,
      automation: "inline",
      digest: runDigest(definition),
      sessionId: randomUUID(),
      stepCount: layout(definition).length,
      budget: definition.budget,
      createdBy: "thread",
    });
    return {
      runId,
      async tick(now) {
        const batch = openBatchWork();
        await advanceRuns(deps, now, batch);
        await batch.lane.settle();
      },
    };
  }

});

/**
 * AN AGENT STEP ENDS THE WAY AN AGENT DOES (ticket #357), over the engine's
 * direct seed: a typed output is the SDK's structured output, stored as the
 * step's outputs for the next step to read; a step with none ends when the
 * model stops; the record's word is read off what happened; and a one-step
 * definition runs with no run at all, under its caller's trigger and lane.
 */
describe("an agent step ends when the model stops, and its record says what it did (ticket #357)", () => {
  const PASS = new Date("2026-10-08T15:00:00.000Z");
  const CUSTOMER_CHAT = "5215557770001@s.whatsapp.net";

  /** A run seeded straight into the store, its steps answered by `script`. */
  async function seeded(
    client: pg.Client,
    definition: RunDefinition,
    script: Script,
    prepare: (twin: Seat) => void = () => {},
  ): Promise<{ readonly twin: Seat; readonly runId: string; readonly model: ScriptedModel; tick(): Promise<void> }> {
    const twin = freshTwin();
    prepare(twin);
    const seat = await seatAtTheDoor(client, twin.twinId);
    const model = scriptedModel(script);
    const deps = { ...depsFor(client, twin), harness: model.harness, runs: createRunEngine() };
    const runId = randomUUID();
    writeRunContent(deps.harness.directory, twin.dek, runId, { definition, inputs: {}, outputs: {} });
    await insertRun(client, {
      id: runId,
      twinId: twin.twinId,
      seatId: seat.seatId,
      automation: "inline",
      digest: runDigest(definition),
      sessionId: randomUUID(),
      stepCount: layout(definition).length,
      budget: definition.budget,
      createdBy: "thread",
    });
    return {
      twin,
      runId,
      model,
      async tick() {
        const batch = openBatchWork();
        await advanceRuns(deps, PASS, batch);
        await batch.lane.settle();
      },
    };
  }

  /** Each step's record, in order: its index and the word it carries. */
  async function dispositions(client: pg.Client, runId: string): Promise<string[]> {
    const rows = await client.query<{ trigger_ref: string; disposition: string }>(
      "SELECT trigger_ref, disposition FROM executions WHERE trigger_kind = 'run_step' AND trigger_ref LIKE $1 ORDER BY started_at, id",
      [`% run:${runId} %`],
    );
    return rows.rows.map((row) => `${/ (step:\d+)$/u.exec(row.trigger_ref)![1]!} ${row.disposition}`);
  }

  async function stateOf(client: pg.Client, runId: string): Promise<string> {
    const rows = await client.query<{ state: string }>("SELECT state FROM runs WHERE id = $1", [runId]);
    return rows.rows[0]!.state;
  }

  async function reportsOf(client: pg.Client, twin: Seat, runId: string): Promise<string[]> {
    const rows = await client.query<{ content_enc: Buffer }>(
      `SELECT n.content_enc FROM notices n JOIN executions e ON e.id = n.execution_id
        WHERE n.twin_id = $1 AND e.trigger_ref LIKE $2 ORDER BY n.created_at`,
      [twin.twinId, `% run:${runId} %`],
    );
    return rows.rows.map((row) => Buffer.from(twin.dek.decrypt(row.content_enc)).toString("utf8"));
  }

  async function chainIsWhole(client: pg.Client): Promise<void> {
    const report = await auditChainCoverageInDb(client);
    const tally = report.mustChain.find((t) => t.class === "rep_execution")!;
    expect(tally.entries).toBe(tally.acts);
    expect(violationsFor(report, "rep_execution")).toEqual([]);
  }

  /** A customer the twin knows, by the reference its tools print. */
  function knowsTorres(twin: Seat): string {
    twin.bundle.confirmChatBinding({
      chatJid: CUSTOMER_CHAT,
      entityId: randomUUID(),
      displayName: "Torres Hermanos",
      confirmedAt: new Date().toISOString(),
    });
    return `[c${String(twin.bundle.referenceForChat(CUSTOMER_CHAT))}]`;
  }

  it("stores a step's structured output as its outputs, and the next step reads it — no submission tool anywhere", async () => {
    await withClient(async (client) => {
      const run = await seeded(
        client,
        {
          name: "Revisar el día",
          budget: { iterations: 6, tokens: 100_000 },
          steps: [
            { kind: "agent", name: "look", instructions: "Look at today and write one line.", tools: ["search_memory"], output: { line: "string" } },
            { kind: "post", name: "report", text: "look.line" },
          ],
        },
        [
          { toolCall: { name: "search_memory", input: { about: "hoy", counterparty: null } } },
          { structured: { line: "Todo al día con tus clientes." } },
        ],
      );
      await run.tick();
      expect(await stateOf(client, run.runId)).toBe("succeeded");
      expect(await reportsOf(client, run.twin, run.runId)).toEqual([expect.stringContaining("Todo al día con tus clientes.")]);
      expect(await dispositions(client, run.runId)).toEqual(["step:0 answered", "step:1 posted"]);
      const offered = toolNamesOf(run.model.requests[0]);
      expect(offered).toEqual(expect.arrayContaining(["search_memory", "StructuredOutput"]));
      expect(offered).not.toContain("submit_step");
      await chainIsWhole(client);
    });
  });

  it("ends a step that declares no output when the model stops: `answered` on words, `no-action` on nothing", async () => {
    await withClient(async (client) => {
      const definition = (name: string): RunDefinition => ({
        name,
        budget: { iterations: 6, tokens: 100_000 },
        steps: [
          { kind: "agent", name: "look", instructions: "Look at today.", tools: ["search_memory"] },
          { kind: "end", name: "done" },
        ],
      });
      const spoke = await seeded(client, definition("Con palabras"), [
        { toolCall: { name: "search_memory", input: { about: "hoy", counterparty: null } } },
        { text: "Revisé el día; nada pendiente." },
      ]);
      await spoke.tick();
      expect(await stateOf(client, spoke.runId)).toBe("succeeded");
      expect(await dispositions(client, spoke.runId)).toEqual(["step:0 answered", "step:1 posted"]);
      // THE STEP ENDED ON ITS WORDS: one model call after the read, and no other.
      expect(spoke.model.requests).toHaveLength(2);

      // A TURN THAT ENDS SAYING NOTHING IS ASKED ONCE MORE BY THE CLI ITSELF,
      // and saying nothing again is its ending.
      const silent = await seeded(client, definition("Sin palabras"), [
        { toolCall: { name: "search_memory", input: { about: "hoy", counterparty: null } } },
        { text: " " },
        { text: " " },
      ]);
      await silent.tick();
      expect(await stateOf(client, silent.runId)).toBe("succeeded");
      expect(await dispositions(client, silent.runId)).toEqual(["step:0 no-action", "step:1 posted"]);
      await chainIsWhole(client);
    });
  });

  it("records `drafted` for a step whose turn created a draft — the act word of the effect it performed", async () => {
    await withClient(async (client) => {
      let torres = "";
      const run = await seeded(
        client,
        {
          name: "Escribirle a Torres",
          budget: { iterations: 6, tokens: 100_000 },
          steps: [
            { kind: "agent", name: "write", instructions: "Write Torres a short follow-up.", tools: ["create_draft"] },
            { kind: "end", name: "done" },
          ],
        },
        () => [
          { toolCall: { name: "create_draft", input: { entity: torres, text: "Hola, ¿cómo va el pedido?" } } },
          { text: "Listo." },
        ],
        (twin) => {
          torres = knowsTorres(twin);
        },
      );
      await run.tick();
      expect(await stateOf(client, run.runId)).toBe("succeeded");
      expect(await dispositions(client, run.runId)).toEqual(["step:0 drafted", "step:1 posted"]);
      const drafts = await client.query("SELECT destination FROM drafts WHERE twin_id = $1", [run.twin.twinId]);
      expect(drafts.rows).toEqual([{ destination: CUSTOMER_CHAT }]);
      await chainIsWhole(client);
    });
  });

  it("records `asked` for a step whose ask tool posted a card, and the turn ends on the card with no further model call", async () => {
    await withClient(async (client) => {
      const run = await seeded(
        client,
        {
          name: "Preguntar",
          budget: { iterations: 6, tokens: 100_000 },
          steps: [
            { kind: "agent", name: "decide", instructions: "Ask the rep whom to start with.", tools: ["ask"], output: { who: "string" } },
            { kind: "end", name: "done", value: "decide.who" },
          ],
        },
        [
          {
            toolCall: {
              name: "ask",
              input: { question: "¿Con quién empiezo?", fields: [{ name: "who", kind: "pick_one", label: null, options: ["Laura", "Torres"] }] },
            },
          },
        ],
      );
      await run.tick();
      expect(await stateOf(client, run.runId)).toBe("waiting");
      expect(await dispositions(client, run.runId)).toEqual(["step:0 asked"]);
      expect(run.model.requests).toHaveLength(1);
      await chainIsWhole(client);
    });
  });

  it("records `schema-miss` for a structured output the step's own rule refuses every time it answers, and the run fails as a failed step does", async () => {
    await withClient(async (client) => {
      const run = await seeded(
        client,
        {
          name: "Una línea",
          budget: { iterations: 6, tokens: 100_000 },
          steps: [
            { kind: "agent", name: "look", instructions: "Write one line.", tools: [], output: { line: "string" } },
            { kind: "post", name: "report", text: "look.line" },
          ],
        },
        // A REFUSED OUTPUT GOES BACK TO THE MODEL ON A RUN'S SESSION TOO (ticket
        // #326), so it is the CLI giving up on every answer that settles it.
        Array.from({ length: 8 }, () => ({ structured: { line: "[c999] ya contestó." } })),
      );
      await run.tick();
      expect(await stateOf(client, run.runId)).toBe("failed");
      expect(await dispositions(client, run.runId)).toEqual(["step:0 schema-miss"]);
      expect((await reportsOf(client, run.twin, run.runId)).join("\n")).not.toContain("ya contestó");
      await chainIsWhole(client);
    });
  });

  it("renders the notepad and the working memory into a step that names them, and into none that does not", async () => {
    await withClient(async (client) => {
      const named = await seeded(
        client,
        {
          name: "Con contexto",
          budget: { iterations: 6, tokens: 100_000 },
          steps: [
            { kind: "agent", name: "look", instructions: "Look.", tools: ["search_memory"], recipes: ["notepad", "working_memory"] },
            { kind: "end", name: "done" },
          ],
        },
        [{ text: "Listo." }],
      );
      await named.tick();
      const shown = latestPromptOf(named.model.requests[0]!);
      expect(shown.indexOf("## now")).toBeLessThan(shown.indexOf("## notepad"));
      expect(shown.indexOf("## notepad")).toBeLessThan(shown.indexOf("## working memory"));

      const bare = await seeded(
        client,
        {
          name: "Sin contexto",
          budget: { iterations: 6, tokens: 100_000 },
          steps: [
            { kind: "agent", name: "look", instructions: "Look.", tools: ["search_memory"] },
            { kind: "end", name: "done" },
          ],
        },
        [{ text: "Listo." }],
      );
      await bare.tick();
      const plain = latestPromptOf(bare.model.requests[0]!);
      expect(plain).toContain("## now");
      expect(plain).not.toContain("## notepad");
      expect(plain).not.toContain("## working memory");
    });
  });

  it("runs a one-step definition with no run: one record under the caller's occasion and lane, no run row, every gate holding", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const seat = await seatAtTheDoor(client, twin.twinId);
      const model = scriptedModel([
        { toolCall: { name: "write_notepad", input: { text: "Los martes no visito.", based_on: 0, evidence: "nada" } } },
        { toolCall: { name: "search_memory", input: { about: "hoy", counterparty: null } } },
        { text: "Nada nuevo hoy." },
      ]);
      const parsed = parseRunDefinition(
        {
          name: "Una vuelta",
          budget: { iterations: 6, tokens: 100_000 },
          steps: [{ kind: "agent", name: "turn", instructions: "Look at today and say what you found.", tools: ["search_memory", "write_notepad"] }],
        },
        shippedRunCatalog(),
      );
      if (!parsed.ok) throw new Error(parsed.reason);
      const executionId = randomUUID();
      const trigger = { kind: "twin_thread_event", mechanism: "seam_event", twinId: twin.twinId, event: "post.landed" } as const;
      // ON THE CALLER'S CONNECTION, INSIDE ITS TRANSACTION, as a turn's record
      // and chain entry always are.
      await client.query("BEGIN");
      const ran = await executeStep(
        { harness: model.harness, db: client, twinId: twin.twinId, hmacKey: TEST_AUDIT_HMAC_KEY },
        {
          definition: parsed.definition,
          conversation: {
            kind: "thread",
            deps: threadDeps({
              db: client,
              dek: twin.dek,
              twinId: twin.twinId,
              executionId,
              hmacKey: TEST_AUDIT_HMAC_KEY,
              trigger,
              bundle: twin.bundle,
              embedder: fakeEmbedder(),
              selfChatJid: SELF_CHAT,
              seatId: seat.seatId,
              timeZone: ZONE,
            }),
          },
          inputs: {},
          trigger,
          wake: THREAD_EVENT_WAKE,
          lane: "realtime",
          executionId,
          now: PASS,
          model: "claude-sonnet-5",
        },
      );
      await client.query("COMMIT");
      if (ran.kind !== "ran") throw new Error("a turn with no day cannot fold");
      const { settlement } = ran;

      expect(settlement.disposition).toBe("answered");
      expect(settlement.words).toBe("Nada nuevo hoy.");
      // THE REP-EVIDENCED TOOL REFUSED — the trigger carries no line of the
      // rep's — and the projection answered.
      expect(settlement.effects.map((effect) => effect.performed)).toEqual([false]);
      expect(twin.bundle.readNotepad()).toBeUndefined();
      const [notepad, search] = toolResultsOf(model.requests.at(-1));
      expect(notepad).toMatch(/^refused:/u);
      expect(search).not.toMatch(/^(refused|rejected):/u);
      const records = await client.query<{ id: string; trigger_kind: string; lane: string; disposition: string }>(
        "SELECT id, trigger_kind, lane, disposition FROM executions WHERE twin_id = $1",
        [twin.twinId],
      );
      expect(records.rows).toEqual([{ id: executionId, trigger_kind: "twin_thread_event", lane: "realtime", disposition: "answered" }]);
      const runs = await client.query("SELECT 1 FROM runs WHERE twin_id = $1", [twin.twinId]);
      expect(runs.rowCount).toBe(0);
      // ONE CHAIN ENTRY, NAMING THE CALLER'S OCCASION — never `run_step`.
      const entries = await client.query<{ ref: string; outcome: string }>(
        "SELECT ref, outcome FROM audit_chain WHERE ref LIKE $1",
        [`%${twin.twinId}%`],
      );
      expect(entries.rows).toEqual([{ ref: expect.stringMatching(/^trigger:twin_thread_event /u), outcome: "answered" }]);
      await chainIsWhole(client);
    });
  });

  /** The one execution and the one chain entry a turn with no run left for this twin. */
  async function oneTurnLeft(
    client: pg.Client,
    twin: Seat,
  ): Promise<{ readonly records: unknown[]; readonly entries: unknown[]; readonly runs: number }> {
    const records = await client.query<{ trigger_kind: string; lane: string; disposition: string }>(
      "SELECT trigger_kind, lane, disposition FROM executions WHERE twin_id = $1",
      [twin.twinId],
    );
    const entries = await client.query<{ ref: string; outcome: string }>(
      "SELECT ref, outcome FROM audit_chain WHERE ref LIKE $1",
      [`%${twin.twinId}%`],
    );
    const runs = await client.query("SELECT 1 FROM runs WHERE twin_id = $1", [twin.twinId]);
    return { records: records.rows, entries: entries.rows, runs: runs.rowCount ?? 0 };
  }

  /** Every session file under a harness directory: what a turn left to be resumed. */
  function sessionFilesUnder(directory: string): string[] {
    const projects = join(directory, "config", "projects");
    return existsSync(projects)
      ? readdirSync(projects, { recursive: true, encoding: "utf8" }).filter((name) => name.endsWith(".jsonl"))
      : [];
  }

  it("runs a one-step definition under a customer's turn with drafting's own deps: its recipes render from them, one record and one entry under chat_turn, no session file left", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const model = scriptedModel([
        { toolCall: { name: "search_memory", input: { about: "el precio de la varilla" } } },
        { text: "Contesto mañana." },
      ]);
      const parsed = parseRunDefinition(
        {
          name: "Un turno de un cliente",
          budget: { iterations: 6, tokens: 100_000 },
          steps: [
            {
              kind: "agent",
              name: "read",
              instructions: "Read what the customer just wrote and say what it asks.",
              tools: ["search_memory"],
              recipes: ["chat_binding", "the_turn"],
            },
          ],
        },
        shippedRunCatalog(),
      );
      if (!parsed.ok) throw new Error(parsed.reason);
      const executionId = randomUUID();
      const trigger = {
        kind: "chat_turn",
        mechanism: "seam_event",
        twinId: twin.twinId,
        chatJid: CUSTOMER_CHAT,
        anchorEventId: "1",
        eventIds: ["1"],
      } as const;
      await client.query("BEGIN");
      const ran = await executeStep(
        { harness: model.harness, db: client, twinId: twin.twinId, hmacKey: TEST_AUDIT_HMAC_KEY },
        {
          definition: parsed.definition,
          conversation: {
            kind: "drafting",
            deps: {
              bundle: twin.bundle,
              embedder: fakeEmbedder(),
              chatJid: CUSTOMER_CHAT,
              counterparty: "Aceros del Norte",
              bindingConfirmed: true,
              bindingQuestionDue: false,
              turn: [
                {
                  messageId: "m1",
                  chatJid: CUSTOMER_CHAT,
                  senderJid: CUSTOMER_CHAT,
                  fromMe: false,
                  content: "¿a cuánto la varilla de 3/8?",
                  occurredAt: "2026-10-08T14:58:00.000Z",
                },
              ],
              transcript: [],
              memories: [],
              repLanguage: "Mexican Spanish, informal",
              timeZone: ZONE,
              db: client,
              dek: twin.dek,
              twinId: twin.twinId,
              selfChatJid: SELF_CHAT,
              executionId,
              anchor: { eventId: "1" },
              counterpartyShown: "Aceros del Norte",
              reference: 1,
              drafted: new DraftSlot(),
            },
          },
          inputs: {},
          trigger,
          wake: DRAFTING_WAKE,
          lane: "realtime",
          executionId,
          now: PASS,
          model: "claude-sonnet-5",
        },
      );
      await client.query("COMMIT");
      if (ran.kind !== "ran") throw new Error("a turn with no day cannot fold");
      expect(ran.settlement.disposition).toBe("answered");

      // DRAFTING'S RECIPES, RENDERED FROM DRAFTING'S DEPS, after the «now».
      const shown = latestPromptOf(model.requests[0]!);
      expect(shown.indexOf("## now")).toBeLessThan(shown.indexOf("## chat binding"));
      expect(shown).toContain("Aceros del Norte");
      expect(shown.indexOf("## chat binding")).toBeLessThan(shown.indexOf("## the turn"));
      expect(shown).toContain("¿a cuánto la varilla de 3/8?");
      // ITS OWN SEARCH, scoped to the chat it was bound to, answered.
      expect(toolResultsOf(model.requests.at(-1))[0]).not.toMatch(/^(refused|rejected):/u);

      expect(await oneTurnLeft(client, twin)).toEqual({
        records: [{ trigger_kind: "chat_turn", lane: "realtime", disposition: "answered" }],
        entries: [{ ref: expect.stringMatching(/^trigger:chat_turn /u), outcome: "answered" }],
        runs: 0,
      });
      // ONE CALL, KEPT NOWHERE: nothing will ever resume a turn with no run.
      expect(sessionFilesUnder(model.harness.directory)).toEqual([]);
      await chainIsWhole(client);
    });
  });

  it("runs a one-step definition under the entity-kind question with its own deps: one typed field, one record and one entry under entity_kind, no session file left", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const model = scriptedModel([{ structured: { kind: "business" } }]);
      const parsed = parseRunDefinition(
        {
          name: "Una pregunta de tipo",
          budget: { iterations: 1, tokens: 100_000 },
          steps: [
            {
              kind: "agent",
              name: "classify",
              instructions: "Say whether this customer is a person or a business.",
              tools: [],
              recipes: ["the_name", "recent_messages"],
              output: { kind: "string" },
            },
          ],
          answeredAs: "classified",
        },
        shippedRunCatalog(),
      );
      if (!parsed.ok) throw new Error(parsed.reason);
      const executionId = randomUUID();
      const trigger = {
        kind: "entity_kind",
        mechanism: "request",
        twinId: twin.twinId,
        chatJid: CUSTOMER_CHAT,
        entityId: randomUUID(),
      } as const;
      await client.query("BEGIN");
      const ran = await executeStep(
        { harness: model.harness, db: client, twinId: twin.twinId, hmacKey: TEST_AUDIT_HMAC_KEY },
        {
          definition: parsed.definition,
          conversation: {
            kind: "entity_kind",
            deps: { displayName: "Aceros del Norte", conversation: [], timeZone: ZONE },
            holds: (output) => (output["kind"] === "person" || output["kind"] === "business" ? undefined : "a kind is person or business"),
          },
          inputs: {},
          trigger,
          wake: ENTITY_KIND_WAKE,
          lane: "realtime",
          executionId,
          now: PASS,
          model: "claude-haiku-5",
        },
      );
      await client.query("COMMIT");
      if (ran.kind !== "ran") throw new Error("a turn with no day cannot fold");
      expect(ran.settlement.output).toEqual({ kind: "business" });
      expect(model.requests).toHaveLength(1);
      expect(latestPromptOf(model.requests[0]!)).toContain("Aceros del Norte");

      expect(await oneTurnLeft(client, twin)).toEqual({
        records: [{ trigger_kind: "entity_kind", lane: "realtime", disposition: "classified" }],
        entries: [{ ref: expect.stringMatching(/^trigger:entity_kind /u), outcome: "classified" }],
        runs: 0,
      });
      expect(sessionFilesUnder(model.harness.directory)).toEqual([]);
      await chainIsWhole(client);
    });
  });
});
