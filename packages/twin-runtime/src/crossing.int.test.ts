/**
 * The first crossing, end to end at the primary Postgres seam (ticket #50).
 *
 * Slice 2 ended with a rep-confirmed binding living inside the bundle and
 * nothing ever leaving the phone. This is the pass where something does:
 * the rep's quoted «va» on the binding question becomes a real ENTITY in a
 * real LEDGER, filed by the aperture, with its DISCLOSURE LINE written in
 * the same transaction — and a creation grant for the rep who bound the
 * chat.
 *
 * Everything here is driven the way the rig drives it: inject `wa_events`,
 * run the consumer, then read the far side. Real Postgres, real envelope
 * crypto, real SQLCipher (ADR-0028); the model is scripted empty on the
 * confirmation pass, so a model call anywhere near the crossing fails the
 * test loudly — a rep act is never model output (ADR-0003).
 *
 * Governing ADRs: 0003 (as amended), 0004, 0016, 0034, 0035.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  auditLedgerWall,
  countFiledEntities,
  readEntityGrants,
  readFiledEntity,
  reconcileFr72,
} from "@dito/aperture";
import { createBundle, type Bundle } from "@dito/bundle";
import { createDekFromMaterial, type Dek } from "@dito/crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { processPendingWaEvents, type TwinRuntimeDeps } from "./consumer.js";
import { crossPendingBindings } from "./crossing-backlog.js";
import { createSendLockWriter } from "./send-lock/writer.js";
import {
  resetAndMigrate,
  withClient,
  TEST_AUDIT_HMAC_KEY,
  TEST_DATABASE_URL,
} from "./testing/db.js";
import { removeTmpDir } from "./testing/tmp.js";
import { fakeEmbedder } from "./testing/fake-embedder.js";
import { insertWaEvent, simulateExecutorPost } from "./testing/seam-fixtures.js";
import {
  closeScriptedModels,
  entityKindTurns,
  scriptedModel,
  type ScriptedTurn,
} from "./testing/scripted-model.js";
import { SETTLE_IMMEDIATELY } from "./testing/settle.js";
import { newExecutionPool } from "./testing/execution-pool.js";

// Every scripted model this suite opened is closed with it (#328).
afterAll(closeScriptedModels);

/** One connection source for every execution this suite runs (ticket #173). */
const executionPool = newExecutionPool();

const SELF_CHAT = "5215550000@s.whatsapp.net";
const CHAT = "5215550001@s.whatsapp.net";
const PUSH_NAME = "Sra. Garza";

let tmp: string;
let pool: pg.Pool;

beforeAll(async () => {
  await resetAndMigrate();
  tmp = mkdtempSync(join(tmpdir(), "dito-crossing-int-"));
  pool = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 4 });
});

afterAll(async () => {
  await pool.end();
  removeTmpDir(tmp);
});

/**
 * A seat: one twin, one company, one seat id — the scope the plane stamps
 * on every row it writes for this number. Stable across events on purpose:
 * "the aperture applies the company scope server-side" is a claim about
 * exactly these columns, and a fixture that randomized them per row would
 * be testing something the plane never does.
 */
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
  const bundle = createBundle(join(tmp, `${twinId}.bundle`), dek);
  return { twinId, companyId: randomUUID(), seatId: randomUUID(), dek, bundle };
}

function depsFor(
  client: pg.Client,
  twin: Seat,
  turns: readonly ScriptedTurn[] = [],
): TwinRuntimeDeps {
  const { harness } = scriptedModel(turns);
  return {
    db: client,
    harness,
    bundle: twin.bundle,
    dek: twin.dek,
    twinId: twin.twinId,
    selfChatJid: SELF_CHAT,
    // Ticket #75: this suite is not about batching (see testing/settle.ts).
    ...SETTLE_IMMEDIATELY,
    drafting: { model: "claude-sonnet-5" },
    embedder: fakeEmbedder(),
    executionPool,
    sendLock: createSendLockWriter({ pool, hmacKey: TEST_AUDIT_HMAC_KEY }),
    hmacKey: TEST_AUDIT_HMAC_KEY,
  };
}

/** One scripted needs-answer decision — enough to trigger the ceremony. */
function draftingTurns(): ScriptedTurn[] {
  return [
    { toolCall: { name: "create_draft", input: { text: "claro, se las mando el jueves temprano" } } },
    { text: "done" },
  ];
}

/**
 * Drives the ceremony to the point of confirmation: a needs-answer inbound
 * carrying a push-name, the question posted by the executor, then the
 * rep's quoted «va». Returns the ids the assertions need.
 */
async function confirmABinding(
  client: pg.Client,
  twin: Seat,
  tag: string,
  kind: "person" | "business" = "person",
): Promise<{ vaEventId: string; entityId: string }> {
  await insertWaEvent(client, twin.dek, {
    twinId: twin.twinId,
    companyId: twin.companyId,
    seatId: twin.seatId,
    chatJid: CHAT,
    senderJid: CHAT,
    fromMe: false,
    messageId: `3EB0-IN-${tag}`,
    text: "¿me mandas 40 cajas para el jueves?",
    pushName: PUSH_NAME,
  });
  await processPendingWaEvents(depsFor(client, twin, draftingTurns()));

  const question = await client.query<{ command_id: string }>(
    `SELECT sc.id AS command_id
       FROM notices n
       JOIN send_commands sc ON sc.payload_ref = 'notice:' || n.id
      WHERE n.twin_id = $1 AND n.kind = 'binding_question'`,
    [twin.twinId],
  );
  await simulateExecutorPost(client, {
    commandId: question.rows[0]!.command_id,
    twinId: twin.twinId,
    waMessageId: `WAMID-QUESTION-${tag}`,
  });

  const vaEventId = await insertWaEvent(client, twin.dek, {
    twinId: twin.twinId,
    companyId: twin.companyId,
    seatId: twin.seatId,
    chatJid: SELF_CHAT,
    senderJid: SELF_CHAT,
    fromMe: true,
    messageId: `3EB0-REP-${tag}`,
    text: "va",
    quotedMessageId: `WAMID-QUESTION-${tag}`,
  });
  // ONE scripted call, and it is the kind determination the crossing makes
  // (ticket #60). Anything else this pass asks the model exhausts the
  // script and fails the test loudly, which is the property this line has
  // always carried.
  await processPendingWaEvents(depsFor(client, twin, entityKindTurns(kind)));

  const binding = twin.bundle.readChatBinding(CHAT)!;
  return { vaEventId, entityId: binding.entityId };
}


/**
 * The model half of the crossing backlog's deps (ticket #60): every entity
 * the sweep files now carries a kind determination, and this is the
 * scripted answer to it.
 */
function kindBacklogModel(times = 1) {
  return {
    harness: scriptedModel(entityKindTurns("person", times)).harness,
    kindModel: { model: "claude-haiku-4-5" },
  };
}

describe("a rep-confirmed binding crosses the wall (ticket #50)", () => {
  it("files the entity the bundle minted, its creation grant, and its disclosure line — the id carried unchanged", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const { vaEventId, entityId } = await confirmABinding(client, twin, "X1");

      // The scope the plane stamped on the rep's own «va» — never anything
      // the device supplied.
      const scope = await client.query<{ company_id: string; seat_id: string }>(
        "SELECT company_id, seat_id FROM wa_events WHERE id = $1",
        [vaEventId],
      );
      const { company_id, seat_id } = scope.rows[0]!;

      // Read back through the aperture's own reader — no test reaches a
      // Ledger table directly (spec #48's testing decisions), and the
      // finalized views cannot answer this because everything filed is
      // shadow.
      const ctx = { db: client, dek: twin.dek };
      const entity = await readFiledEntity(ctx, {
        companyId: company_id,
        entityId,
      });
      expect(entity).toMatchObject({
        companyId: company_id,
        entityId,
        kind: "person",
        displayName: PUSH_NAME,
        // Every entity and fact this slice files is shadow (ADR-0016).
        shadow: true,
      });

      expect(
        await readEntityGrants(ctx, { companyId: company_id, entityId }),
      ).toMatchObject([{ twinId: twin.twinId, source: "creation" }]);

      const line = await client.query(
        `SELECT company_id, seat_id, twin_id, subject_kind, rendered_text,
                source_event_id
           FROM disclosure_lines WHERE entity_id = $1`,
        [entityId],
      );
      expect(line.rows).toEqual([
        {
          company_id,
          seat_id,
          twin_id: twin.twinId,
          subject_kind: "entity_create",
          // Rendered text, no version (ADR-0034): this is what the rep
          // was told, frozen.
          rendered_text: "Lo di de alta como cliente.",
          // Bound to the rep's own act — the evidence that made it class 2.
          source_event_id: vaEventId,
        },
      ]);

      expect((await reconcileFr72(client)).violations).toEqual([]);
      twin.bundle.close();
    });
  });

  it("shows the crossing to nobody yet: the finalized view is empty while the row is shadow", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const { entityId } = await confirmABinding(client, twin, "X2");
      // The company is DECLARED before the read (ticket #127): since the
      // finalized views run as a policy-bound role, a session that names no
      // company reads nothing through one — and this assertion is about the
      // SHADOW filter, so it has to be able to fail for that reason.
      await client.query("SELECT set_config('dito.company_id', $1, false)", [
        twin.companyId,
      ]);
      const visible = await client.query(
        "SELECT 1 FROM ledger.finalized_entities WHERE entity_id = $1",
        [entityId],
      );
      await client.query("RESET dito.company_id");
      expect(visible.rows).toEqual([]);
      twin.bundle.close();
    });
  });

  it("re-confirming files nothing new — the crossing is idempotent on the minted id", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const { entityId } = await confirmABinding(
        client,
        twin,
        "X3",
        "business",
      );

      // A second «va» on the same question: the rep repeating themselves,
      // or the crash-replay between the mirror write and the marker. THE
      // MODEL CHANGES ITS MIND on this pass, which is the shape the live
      // path can really take now that the kind is determined fresh every
      // time: it must read as a repeat rather than as a client-supplied-id
      // collision, or the create throws before the processing marker is
      // written and the event replays forever.
      await insertWaEvent(client, twin.dek, {
        twinId: twin.twinId,
        companyId: twin.companyId,
        seatId: twin.seatId,
        chatJid: SELF_CHAT,
        senderJid: SELF_CHAT,
        fromMe: true,
        messageId: "3EB0-REP-X3-AGAIN",
        text: "va",
        quotedMessageId: "WAMID-QUESTION-X3",
      });
      // The repeat determines the kind again — the binding stands, the
      // create is idempotent, and asking twice files nothing twice.
      await processPendingWaEvents(
        depsFor(client, twin, entityKindTurns("person")),
      );

      const ctx = { db: client, dek: twin.dek };
      expect(await countFiledEntities(ctx, twin.companyId)).toBe(1);
      expect(
        await readEntityGrants(ctx, { companyId: twin.companyId, entityId }),
      ).toHaveLength(1);
      const lines = await client.query(
        "SELECT 1 FROM disclosure_lines WHERE entity_id = $1",
        [entityId],
      );
      expect(lines.rows).toHaveLength(1);
      // The event really was processed — the marker, not just the absence
      // of a second row, is what says the replay ended.
      const marked = await client.query<{ disposition: string }>(
        `SELECT p.disposition FROM wa_event_processing p
           JOIN wa_events e ON e.id = p.event_id
          WHERE p.twin_id = $1
          ORDER BY e.id DESC LIMIT 1`,
        [twin.twinId],
      );
      expect(marked.rows[0]!.disposition).toBe("binding_confirmed");
      // ...and the standing determination stands: a repeat never overwrites
      // it, which is also what keeps a human's correction from being undone
      // by the next «va» (ticket #60).
      expect(
        (await readFiledEntity(ctx, { companyId: twin.companyId, entityId }))!
          .kind,
      ).toBe("business");
      expect((await reconcileFr72(client)).violations).toEqual([]);
      twin.bundle.close();
    });
  });

  it("crosses nothing the rep did not confirm: no binding, no entity, no line", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      // The ceremony asks, and the rep says nothing.
      await insertWaEvent(client, twin.dek, {
        twinId: twin.twinId,
        companyId: twin.companyId,
        seatId: twin.seatId,
        chatJid: CHAT,
        senderJid: CHAT,
        fromMe: false,
        messageId: "3EB0-IN-SILENT",
        text: "¿me mandas 40 cajas para el jueves?",
        pushName: PUSH_NAME,
      });
      await processPendingWaEvents(depsFor(client, twin, draftingTurns()));

      expect(twin.bundle.listChatBindings()).toEqual([]);
      expect(
        await countFiledEntities({ db: client, dek: twin.dek }, twin.companyId),
      ).toBe(0);
      const lines = await client.query(
        "SELECT 1 FROM disclosure_lines WHERE twin_id = $1",
        [twin.twinId],
      );
      expect(lines.rows).toEqual([]);
      twin.bundle.close();
    });
  });

  it("keeps the bundle's entity mirror and the Ledger on the same id — a mirror, not a translation table", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const { entityId } = await confirmABinding(client, twin, "X5");
      expect(twin.bundle.readChatBinding(CHAT)?.entityId).toBe(entityId);
      const filed = await readFiledEntity(
        { db: client, dek: twin.dek },
        { companyId: twin.companyId, entityId },
      );
      expect(filed?.entityId).toBe(entityId);

      // And the chat itself never crossed (ADR-0004: owner-visible
      // provenance is timestamp, confidence and source type — never chat
      // identity). The sweep covers EVERY text-shaped Ledger column, so a
      // later one cannot quietly start carrying a JID.
      const wall = await auditLedgerWall(client);
      expect(wall.violations).toEqual([]);
      expect(wall.columnsChecked).toBeGreaterThan(0);
      twin.bundle.close();
    });
  });
});

/**
 * The state a carried steering install is actually in when this build
 * starts: slice 2's ceremony ran to completion — question asked, question
 * posted, rep's «va» delivered and MARKED PROCESSED, binding written into
 * the bundle — and nothing ever crossed, because nothing could. Built
 * forwards rather than by deleting Ledger rows, so it is the real upgrade
 * state and not an approximation of one. Returns the minted entity id.
 */
async function slice2UpgradeState(
  client: pg.Client,
  twin: Seat,
  tag: string,
): Promise<string> {
  await insertWaEvent(client, twin.dek, {
    twinId: twin.twinId,
    companyId: twin.companyId,
    seatId: twin.seatId,
    chatJid: CHAT,
    senderJid: CHAT,
    fromMe: false,
    messageId: `3EB0-IN-${tag}`,
    text: "¿me mandas 40 cajas para el jueves?",
    pushName: PUSH_NAME,
  });
  await processPendingWaEvents(depsFor(client, twin, draftingTurns()));
  const question = await client.query<{ command_id: string }>(
    `SELECT sc.id AS command_id
       FROM notices n
       JOIN send_commands sc ON sc.payload_ref = 'notice:' || n.id
      WHERE n.twin_id = $1 AND n.kind = 'binding_question'`,
    [twin.twinId],
  );
  await simulateExecutorPost(client, {
    commandId: question.rows[0]!.command_id,
    twinId: twin.twinId,
    waMessageId: `WAMID-QUESTION-${tag}`,
  });

  const vaEventId = await insertWaEvent(client, twin.dek, {
    twinId: twin.twinId,
    companyId: twin.companyId,
    seatId: twin.seatId,
    chatJid: SELF_CHAT,
    senderJid: SELF_CHAT,
    fromMe: true,
    messageId: `3EB0-REP-${tag}`,
    text: "va",
    quotedMessageId: `WAMID-QUESTION-${tag}`,
  });

  // What the previous release did with that «va», and all it did.
  const entityId = randomUUID();
  twin.bundle.confirmChatBinding({
    chatJid: CHAT,
    entityId,
    displayName: PUSH_NAME,
    confirmedAt: "2026-08-27T14:03:00.000Z",
  });
  await client.query(
    "INSERT INTO wa_event_processing (event_id, twin_id, disposition) VALUES ($1, $2, 'binding_confirmed')",
    [vaEventId, twin.twinId],
  );
  return entityId;
}

describe("bindings confirmed before the Ledger existed still cross (ticket #50)", () => {
  it("files the entity for a binding whose confirmation was already processed — the carried steering install's case", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const entityId = await slice2UpgradeState(client, twin, "UP1");

      const ctx = { db: client, dek: twin.dek };
      expect(await countFiledEntities(ctx, twin.companyId)).toBe(0);

      // Another ordinary pass changes nothing: the event is processed.
      await processPendingWaEvents(depsFor(client, twin));
      expect(await countFiledEntities(ctx, twin.companyId)).toBe(0);

      // The backlog sweep does, on the original rep act.
      const result = await crossPendingBindings({
        ...kindBacklogModel(),
        db: client,
        bundle: twin.bundle,
        dek: twin.dek,
        twinId: twin.twinId,
        hmacKey: TEST_AUDIT_HMAC_KEY,
      });
      expect(result).toEqual({ filed: 1, unresolved: [], undetermined: [] });

      const filed = await readFiledEntity(ctx, {
        companyId: twin.companyId,
        entityId,
      });
      expect(filed).toMatchObject({ entityId, displayName: PUSH_NAME });
      const line = await client.query<{ source_event_id: string }>(
        "SELECT source_event_id FROM disclosure_lines WHERE entity_id = $1",
        [entityId],
      );
      // Filed on the rep's ORIGINAL «va», not on anything invented.
      expect(line.rows).toHaveLength(1);
      expect((await reconcileFr72(client)).violations).toEqual([]);

      // And it is idempotent: a second sweep files nothing.
      expect(
        await crossPendingBindings({
          ...kindBacklogModel(),
          db: client,
          bundle: twin.bundle,
          dek: twin.dek,
          twinId: twin.twinId,
          hmacKey: TEST_AUDIT_HMAC_KEY,
        }),
      ).toEqual({ filed: 0, unresolved: [], undetermined: [] });
      twin.bundle.close();
    });
  });

  it("files nothing for a binding whose confirmation cannot be resolved — an unprovable crossing is not one to make", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      // A binding written straight into the mirror, with no ceremony
      // behind it at all: the shape a restored-from-elsewhere bundle takes.
      twin.bundle.confirmChatBinding({
        chatJid: CHAT,
        entityId: randomUUID(),
        displayName: PUSH_NAME,
        confirmedAt: "2026-08-28T10:00:00.000Z",
      });

      const result = await crossPendingBindings({
        ...kindBacklogModel(),
        db: client,
        bundle: twin.bundle,
        dek: twin.dek,
        twinId: twin.twinId,
        hmacKey: TEST_AUDIT_HMAC_KEY,
      });
      expect(result).toEqual({
        filed: 0,
        unresolved: [CHAT],
        undetermined: [],
      });
      expect(
        await countFiledEntities(
          { db: client, dek: twin.dek },
          twin.companyId,
        ),
      ).toBe(0);
      twin.bundle.close();
    });
  });

  it("reports a binding the model would not judge and files the rest — one sweep, before the loop starts (ticket #60)", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      // The same carried-install state the sweep exists for: a binding in
      // the mirror, its «va» already marked, and no entity filed.
      await slice2UpgradeState(client, twin, "UP3");

      const result = await crossPendingBindings({
        // A model that ends its run without submitting anything: the
        // harness refuses loudly, and this sweep must survive it — it runs
        // BEFORE the loop, so one customer the model chokes on must not
        // cost the rep every other one.
        harness: scriptedModel([{ text: "no sé" }]).harness,
        kindModel: { model: "claude-haiku-4-5" },
        db: client,
        bundle: twin.bundle,
        dek: twin.dek,
        twinId: twin.twinId,
        hmacKey: TEST_AUDIT_HMAC_KEY,
      });

      expect(result).toEqual({ filed: 0, unresolved: [], undetermined: [CHAT] });
      const ctx = { db: client, dek: twin.dek };
      // Nothing was filed on a kind nobody determined...
      expect(await countFiledEntities(ctx, twin.companyId)).toBe(0);
      // ...and the next start asks again, because the selection is still
      // "bindings whose entity is not filed".
      const retry = await crossPendingBindings({
        ...kindBacklogModel(),
        db: client,
        bundle: twin.bundle,
        dek: twin.dek,
        twinId: twin.twinId,
        hmacKey: TEST_AUDIT_HMAC_KEY,
      });
      expect(retry).toEqual({ filed: 1, unresolved: [], undetermined: [] });
      expect(await countFiledEntities(ctx, twin.companyId)).toBe(1);
      twin.bundle.close();
    });
  });
});

/**
 * The seat-scoped test the CI corpus mint relies on: nothing about the
 * crossing lives in process state, so a fresh runtime picks it up.
 */
describe("the crossing survives a restart", () => {
  it("a restarted runtime confirms and files exactly as the first would have", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await insertWaEvent(client, twin.dek, {
        twinId: twin.twinId,
        companyId: twin.companyId,
        seatId: twin.seatId,
        chatJid: CHAT,
        senderJid: CHAT,
        fromMe: false,
        messageId: "3EB0-IN-R1",
        text: "¿me mandas 40 cajas para el jueves?",
        pushName: PUSH_NAME,
      });
      await processPendingWaEvents(depsFor(client, twin, draftingTurns()));
      const question = await client.query<{ command_id: string }>(
        `SELECT sc.id AS command_id
           FROM notices n
           JOIN send_commands sc ON sc.payload_ref = 'notice:' || n.id
          WHERE n.twin_id = $1 AND n.kind = 'binding_question'`,
        [twin.twinId],
      );
      await simulateExecutorPost(client, {
        commandId: question.rows[0]!.command_id,
        twinId: twin.twinId,
        waMessageId: "WAMID-QUESTION-R1",
      });
      await insertWaEvent(client, twin.dek, {
        twinId: twin.twinId,
        companyId: twin.companyId,
        seatId: twin.seatId,
        chatJid: SELF_CHAT,
        senderJid: SELF_CHAT,
        fromMe: true,
        messageId: "3EB0-REP-R1",
        text: "va",
        quotedMessageId: "WAMID-QUESTION-R1",
      });

      // A brand-new deps object: the restart.
      await processPendingWaEvents(
        depsFor(client, twin, entityKindTurns("person")),
      );

      const entityId = twin.bundle.readChatBinding(CHAT)!.entityId;
      expect(
        await readFiledEntity(
          { db: client, dek: twin.dek },
          { companyId: twin.companyId, entityId },
        ),
      ).toBeDefined();
      twin.bundle.close();
    });
  });
});
