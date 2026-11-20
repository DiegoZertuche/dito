/**
 * The kind classification, end to end at the primary Postgres seam (tickets
 * #60 and #176).
 *
 * RE-EXPRESSED AT THE SEAM FOR #176. The classification is an EXECUTION now,
 * so what the seam has to show is one more thing than the rung it was cut
 * for: every classification leaves an `executions` row and one entry on the
 * rep chain, a refused one leaves a `failed` record and files nothing, and
 * the three call sites — the live confirmation, the startup backlog and the
 * hand-run backfill — all reach the model through the same definition. The
 * ADR-0035 claims below are unchanged and still the point: what a kind is
 * FOR is the phone rung.
 *
 * ADR-0035's phone rung merges two records on a shared normalized phone
 * ONLY WHEN `kind` MATCHES, because a business switchboard is shared by
 * many people. Slice 3 filed every entity `person`, so that condition
 * compared two placeholders and did nothing. Here the model determines it
 * at the binding confirmation — the real ceremony, the real aperture, the
 * real matcher — and the rung's two outcomes are read back the way a reader
 * would, through the aperture's own surface rather than off `ledger`.
 *
 * Real Postgres, real envelope crypto, real SQLCipher (ADR-0028); the model
 * is the scripted client at the pre-agreed seam, so what is asserted is
 * what was DONE with a determination and never the determination itself.
 *
 * Governing ADRs: 0003 (as amended), 0004, 0016, 0034, 0035.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fileCandidateFact,
  fileEntityKind,
  listFiledEntities,
  readFiledEntity,
  resolveEntity,
  runMergeMatcher,
} from "@dito/aperture";
import { createBundle, type Bundle } from "@dito/bundle";
import { createDekFromMaterial, type Dek } from "@dito/crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { processPendingWaEvents, type TwinRuntimeDeps } from "./consumer.js";
import { crossPendingBindings } from "./crossing-backlog.js";
import {
  backfillEntityKinds,
  EntityKindBackfillScopeError,
} from "./entity-kind-backfill.js";
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
/** A number belonging to neither conversation — a switchboard, as ADR-0035 writes it. */
const SWITCHBOARD = "55 5555 0000";

let tmp: string;
let pool: pg.Pool;

beforeAll(async () => {
  await resetAndMigrate();
  tmp = mkdtempSync(join(tmpdir(), "dito-kind-int-"));
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
    ...SETTLE_IMMEDIATELY,
    drafting: { model: "claude-sonnet-5" },
    embedder: fakeEmbedder(),
    executionPool,
    sendLock: createSendLockWriter({ pool, hmacKey: TEST_AUDIT_HMAC_KEY }),
    hmacKey: TEST_AUDIT_HMAC_KEY,
  };
}

function draftingTurns(): ScriptedTurn[] {
  return [
    { toolCall: { name: "create_draft", input: { text: "claro, se las mando el jueves temprano" } } },
    { text: "done" },
  ];
}

/**
 * One customer, made the way the system makes one: an inbound carrying a
 * push-name, the ceremony's question posted, the rep's quoted «va» — and
 * the model determining, on that pass, what kind of customer this is.
 */
async function bindCustomerThroughCeremony(
  client: pg.Client,
  twin: Seat,
  args: {
    readonly chatJid: string;
    readonly pushName: string;
    readonly tag: string;
    readonly kind: "person" | "business";
    /**
     * When the rep confirmed — the entity's valid time, and therefore the
     * survivorship rule's input (ADR-0035). Explicit wherever a test asserts
     * WHICH of two records wins a merge: two confirmations at one instant is
     * a real state, and the id breaks the tie, which is total but arbitrary.
     */
    readonly confirmedAt?: Date;
  },
): Promise<string> {
  const inboundEventId = await insertWaEvent(client, twin.dek, {
    twinId: twin.twinId,
    companyId: twin.companyId,
    seatId: twin.seatId,
    chatJid: args.chatJid,
    senderJid: args.chatJid,
    fromMe: false,
    messageId: `3EB0-IN-${args.tag}`,
    text: "¿me mandas 40 cajas para el jueves?",
    pushName: args.pushName,
  });
  await processPendingWaEvents(depsFor(client, twin, draftingTurns()));

  // THIS chat's question, named by the seam row it was asked about — two
  // customers are bound in one of these suites and the wrong «va» would
  // bind the wrong chat.
  const question = await client.query<{ command_id: string }>(
    `SELECT sc.id AS command_id
       FROM notices n
       JOIN send_commands sc ON sc.payload_ref = 'notice:' || n.id
      WHERE n.twin_id = $1 AND n.kind = 'binding_question'
        AND n.about_event_id = $2`,
    [twin.twinId, inboundEventId],
  );
  await simulateExecutorPost(client, {
    commandId: question.rows[0]!.command_id,
    twinId: twin.twinId,
    waMessageId: `WAMID-QUESTION-${args.tag}`,
  });

  await insertWaEvent(client, twin.dek, {
    twinId: twin.twinId,
    companyId: twin.companyId,
    seatId: twin.seatId,
    chatJid: SELF_CHAT,
    senderJid: SELF_CHAT,
    fromMe: true,
    messageId: `3EB0-REP-${args.tag}`,
    text: "va",
    quotedMessageId: `WAMID-QUESTION-${args.tag}`,
    ...(args.confirmedAt === undefined ? {} : { occurredAt: args.confirmedAt }),
  });
  // ONE scripted call on this pass, and it is the determination.
  await processPendingWaEvents(
    depsFor(client, twin, entityKindTurns(args.kind)),
  );
  return twin.bundle.readChatBinding(args.chatJid)!.entityId;
}

/** A `ContactEstablished` carrying the switchboard both customers answer on. */
async function establishSwitchboard(
  client: pg.Client,
  twin: Seat,
  entityId: string,
  chatJid: string,
  tag: string,
): Promise<void> {
  const sourceEventId = await insertWaEvent(client, twin.dek, {
    twinId: twin.twinId,
    companyId: twin.companyId,
    seatId: twin.seatId,
    chatJid,
    senderJid: chatJid,
    fromMe: false,
    messageId: `3EB0-CONTACT-${tag}`,
    text: "te paso mis datos",
  });
  const outcome = await fileCandidateFact(
    { db: client, dek: twin.dek },
    {
      twinId: twin.twinId,
      entityId,
      sourceEventId,
      factType: "ContactEstablished",
      payload: { identifiers: { phones: [SWITCHBOARD] } },
      confidence: 0.95,
      reading: "stated",
      renderDisclosureLine: () => "Guardé sus datos de contacto.",
    },
  );
  if (!outcome.filed) throw new Error(`fixture did not file: ${outcome.reason}`);
}

describe("the phone rung's condition can finally be evaluated (ticket #60, ADR-0035)", () => {
  it("refuses to fuse a business and a person the model told apart, and says why", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const ferreteria = await bindCustomerThroughCeremony(client, twin, {
        chatJid: "5215559401@s.whatsapp.net",
        pushName: "Ferretería Fuentes",
        tag: "K1A",
        kind: "business",
      });
      const ana = await bindCustomerThroughCeremony(client, twin, {
        chatJid: "5215559402@s.whatsapp.net",
        pushName: "Ana García",
        tag: "K1B",
        kind: "person",
      });
      const ctx = { db: client, dek: twin.dek, hmacKey: TEST_AUDIT_HMAC_KEY };
      // The determinations really are what is filed.
      expect(
        (await readFiledEntity(ctx, {
          companyId: twin.companyId,
          entityId: ferreteria,
        }))!.kind,
      ).toBe("business");
      expect(
        (await readFiledEntity(ctx, {
          companyId: twin.companyId,
          entityId: ana,
        }))!.kind,
      ).toBe("person");

      await establishSwitchboard(
        client,
        twin,
        ferreteria,
        "5215559401@s.whatsapp.net",
        "K1A",
      );
      await establishSwitchboard(
        client,
        twin,
        ana,
        "5215559402@s.whatsapp.net",
        "K1B",
      );

      const report = await runMergeMatcher(ctx, { companyId: twin.companyId });
      expect(report.merged).toEqual([]);
      // The number that has never been anything but zero.
      expect(report.skipped).toContainEqual({
        reason: "kind_mismatch",
        matchedOn: "phone",
        matchedValue: "+525555550000",
        entityIds: [ferreteria, ana].sort(),
      });
      // Both records persist, and each still resolves to itself.
      await expect(
        resolveEntity(ctx, { companyId: twin.companyId, entityId: ana }),
      ).resolves.toBe(ana);
      twin.bundle.close();
    });
  });

  it("merges two businesses the model read the same way, on the same switchboard", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const sur = await bindCustomerThroughCeremony(client, twin, {
        chatJid: "5215559411@s.whatsapp.net",
        pushName: "Distribuidora Sur",
        tag: "K2A",
        kind: "business",
        confirmedAt: new Date("2026-08-20T10:00:00Z"),
      });
      const delSur = await bindCustomerThroughCeremony(client, twin, {
        chatJid: "5215559412@s.whatsapp.net",
        pushName: "Distribuidora del Sur",
        tag: "K2B",
        kind: "business",
        confirmedAt: new Date("2026-08-22T10:00:00Z"),
      });
      const ctx = { db: client, dek: twin.dek, hmacKey: TEST_AUDIT_HMAC_KEY };
      await establishSwitchboard(
        client,
        twin,
        sur,
        "5215559411@s.whatsapp.net",
        "K2A",
      );
      await establishSwitchboard(
        client,
        twin,
        delSur,
        "5215559412@s.whatsapp.net",
        "K2B",
      );

      const report = await runMergeMatcher(ctx, { companyId: twin.companyId });
      expect(report.merged).toHaveLength(1);
      expect(report.merged[0]!.matchedOn).toBe("phone");
      expect(
        report.skipped.filter((s) => s.reason === "kind_mismatch"),
      ).toEqual([]);
      // Read through the aperture's own resolution, not off the edge row.
      await expect(
        resolveEntity(ctx, { companyId: twin.companyId, entityId: delSur }),
      ).resolves.toBe(sur);
      twin.bundle.close();
    });
  });
});

describe("the backfill re-infers what nothing ever determined (ticket #60)", () => {
  it("judges every entity this twin bound again, and files what the model says", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      // The carried install's shape: an entity filed `person` because that
      // is what slice 3 filed for everything.
      const entityId = await bindCustomerThroughCeremony(client, twin, {
        chatJid: "5215559421@s.whatsapp.net",
        pushName: "Ferretería Fuentes",
        tag: "K3A",
        kind: "person",
      });
      const ctx = { db: client, dek: twin.dek, hmacKey: TEST_AUDIT_HMAC_KEY };
      expect(
        (await readFiledEntity(ctx, {
          companyId: twin.companyId,
          entityId,
        }))!.kind,
      ).toBe("person");

      const { harness } = scriptedModel(entityKindTurns("business"));
      const result = await backfillEntityKinds({
        db: client,
        bundle: twin.bundle,
        dek: twin.dek,
        twinId: twin.twinId,
        companyId: twin.companyId,
        harness,
        kindModel: { model: "claude-haiku-4-5" },
        hmacKey: TEST_AUDIT_HMAC_KEY,
      });

      expect(result.determined).toEqual([
        {
          entityId,
          displayName: "Ferretería Fuentes",
          kind: "business",
          previousKind: "person",
          changed: true,
          deferredToHuman: false,
        },
      ]);
      expect(result.skipped).toEqual([]);
      expect(result.handCorrected).toEqual([]);
      expect(
        (await readFiledEntity(ctx, {
          companyId: twin.companyId,
          entityId,
        }))!.kind,
      ).toBe("business");
      // ...and the name is untouched: the determination annotates, it does
      // not rename (ADR-0003).
      expect(
        (await listFiledEntities(ctx, twin.companyId)).map((e) => [
          e.displayName,
          e.kind,
        ]),
      ).toEqual([["Ferretería Fuentes", "business"]]);
      twin.bundle.close();
    });
  });

  it("never overrules a person — an entity a human ruled on is left as they left it", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const entityId = await bindCustomerThroughCeremony(client, twin, {
        chatJid: "5215559441@s.whatsapp.net",
        pushName: "Tlapalería Ruiz",
        tag: "K5A",
        kind: "person",
      });
      const ctx = { db: client, dek: twin.dek, hmacKey: TEST_AUDIT_HMAC_KEY };
      // The operator's correction path: a person looked and said business.
      await fileEntityKind(
        { db: client, hmacKey: TEST_AUDIT_HMAC_KEY },
        {
          companyId: twin.companyId,
          entityId,
          kind: "business",
          determinedBy: "human",
        },
      );

      const result = await backfillEntityKinds({
        db: client,
        bundle: twin.bundle,
        dek: twin.dek,
        twinId: twin.twinId,
        companyId: twin.companyId,
        // The model IS asked and it disagrees — «person», the value the
        // human overruled. The refusal is the writer's, under the row lock,
        // rather than a caller remembering to skip.
        harness: scriptedModel(entityKindTurns("person")).harness,
        kindModel: { model: "claude-haiku-4-5" },
        hmacKey: TEST_AUDIT_HMAC_KEY,
      });

      expect(result).toEqual({
        determined: [],
        handCorrected: [entityId],
        skipped: [],
      });
      expect(
        (await readFiledEntity(ctx, {
          companyId: twin.companyId,
          entityId,
        }))!.kind,
      ).toBe("business");
      twin.bundle.close();
    });
  });

  it("refuses a company this twin has no standing in — a stale twin id must not sweep another tenant", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await bindCustomerThroughCeremony(client, twin, {
        chatJid: "5215559451@s.whatsapp.net",
        pushName: "Bodega Salinas",
        tag: "K6A",
        kind: "person",
      });

      await expect(
        backfillEntityKinds({
          db: client,
          bundle: twin.bundle,
          dek: twin.dek,
          twinId: twin.twinId,
          // Somebody else's company, beside this twin's id.
          companyId: randomUUID(),
          // Empty: nothing may be judged before the refusal.
          harness: scriptedModel([]).harness,
          kindModel: { model: "claude-haiku-4-5" },
          hmacKey: TEST_AUDIT_HMAC_KEY,
        }),
      ).rejects.toThrow(EntityKindBackfillScopeError);
      twin.bundle.close();
    });
  });

  it("leaves alone an entity this twin's bundle holds no binding for — another rep's customer is judged by their own twin", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const entityId = await bindCustomerThroughCeremony(client, twin, {
        chatJid: "5215559431@s.whatsapp.net",
        pushName: "Bodega Salinas",
        tag: "K4A",
        kind: "person",
      });
      // A DIFFERENT bundle, holding no binding for that entity — the
      // shape of another rep's customer from this twin's point of view.
      const other = freshTwin();

      const { harness } = scriptedModel([]);
      const result = await backfillEntityKinds({
        db: client,
        bundle: other.bundle,
        dek: twin.dek,
        twinId: twin.twinId,
        companyId: twin.companyId,
        harness,
        kindModel: { model: "claude-haiku-4-5" },
        hmacKey: TEST_AUDIT_HMAC_KEY,
      });

      expect(result).toEqual({
        determined: [],
        handCorrected: [],
        skipped: [entityId],
      });
      // Untouched, and no model call was made for it — an empty script
      // would have failed loudly.
      expect(
        (await readFiledEntity(
          { db: client, dek: twin.dek },
          { companyId: twin.companyId, entityId },
        ))!.kind,
      ).toBe("person");
      twin.bundle.close();
      other.bundle.close();
    });
  });
});

/**
 * The execution's own record, at the seam (ticket #176).
 *
 * WHAT THE HARNESS COULD NOT SHOW. It returned a value and left nothing
 * behind, so "was this kind determined by a model, when, at what cost" had
 * no answer anywhere. Every classification now leaves one `executions` row
 * and one content-free entry on the rep chain (ADR-0020), and the failure
 * path leaves exactly those two and nothing else.
 */
describe("every classification is an execution with a record and an entry (ticket #176)", () => {
  it("files a kind through one execution, and records what it was and what it cost", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const entityId = await bindCustomerThroughCeremony(client, twin, {
        chatJid: "5215559451@s.whatsapp.net",
        pushName: "Materiales del Norte",
        tag: "X1",
        kind: "business",
      });

      const executions = await executionsOf(client, twin);
      expect(executions).toHaveLength(1);
      const execution = executions[0]!;
      expect(execution.trigger_kind).toBe("entity_kind");
      expect(execution.trigger_mechanism).toBe("request");
      // The disposition the word was minted for at #178 and that nothing
      // assigned until this ticket.
      expect(execution.disposition).toBe("classified");
      expect(execution.lane).toBe("realtime");
      // NO TOOL AT ALL: the record names the tool list the execution was
      // GIVEN, and the classification's whole output is its typed result.
      expect(execution.tool_names).toEqual([]);
      expect(execution.iterations).toBe(1);
      expect(execution.tokens_input).toBeGreaterThan(0);
      expect(execution.tokens_output).toBeGreaterThan(0);

      // ...AND ONE ENTRY, CONTENT-FREE, naming the twin and the entity and
      // no chat address (ADR-0020, ADR-0004).
      const entries = await executionEntriesOf(client, twin);
      expect(entries).toHaveLength(1);
      // The trigger's own tokens, verbatim, with the instructions digest
      // `executionAuditEntry` appends after them.
      expect(entries[0]!.ref).toBe(
        `trigger:entity_kind mechanism:request twin:${twin.twinId} entity:${entityId} instructions:${execution.instructions_digest}`,
      );
      expect(entries[0]!.outcome).toBe("classified");
      expect(entries[0]!.ref).not.toContain("@");

      // And the kind really is what the Ledger holds — the execution is the
      // account of the call, never a substitute for the filing.
      expect(
        (await readFiledEntity(
          { db: client, dek: twin.dek },
          { companyId: twin.companyId, entityId },
        ))!.kind,
      ).toBe("business");
      twin.bundle.close();
    });
  });

  it("creates no execution when a kind already stands — a repeat «va» classifies nothing", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await bindCustomerThroughCeremony(client, twin, {
        chatJid: "5215559452@s.whatsapp.net",
        pushName: "Ana Garcia",
        tag: "X2",
        kind: "person",
      });
      expect(await executionsOf(client, twin)).toHaveLength(1);

      // The same «va» again, quoting the same question. The aperture would
      // discard a fresh determination anyway, so asking is a model call
      // nobody needs — and an execution recording one would attest to a
      // classification that never happened.
      await insertWaEvent(client, twin.dek, {
        twinId: twin.twinId,
        companyId: twin.companyId,
        seatId: twin.seatId,
        chatJid: SELF_CHAT,
        senderJid: SELF_CHAT,
        fromMe: true,
        messageId: "3EB0-REP-X2-AGAIN",
        text: "va",
        quotedMessageId: "WAMID-QUESTION-X2",
      });
      // NO scripted turn at all: a model call here would exhaust the script
      // and fail loudly, which is the assertion.
      await processPendingWaEvents(depsFor(client, twin, []));

      expect(await executionsOf(client, twin)).toHaveLength(1);
      expect(await executionEntriesOf(client, twin)).toHaveLength(1);
      // ...and the rep is still acknowledged, twice, exactly as before.
      const acks = await client.query<{ n: string }>(
        "SELECT count(*) AS n FROM notices WHERE twin_id = $1 AND kind = 'binding_ack'",
        [twin.twinId],
      );
      expect(acks.rows[0]!.n).toBe("2");
      twin.bundle.close();
    });
  });

  it("leaves a `failed` record, files nothing, and replays the «va» on the next pass", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const chatJid = "5215559453@s.whatsapp.net";
      const inboundEventId = await insertWaEvent(client, twin.dek, {
        twinId: twin.twinId,
        companyId: twin.companyId,
        seatId: twin.seatId,
        chatJid,
        senderJid: chatJid,
        fromMe: false,
        messageId: "3EB0-IN-X3",
        text: "me mandas 40 cajas?",
        pushName: "Constructora Aguilar",
      });
      await processPendingWaEvents(depsFor(client, twin, draftingTurns()));
      const question = await client.query<{ command_id: string }>(
        `SELECT sc.id AS command_id
           FROM notices n
           JOIN send_commands sc ON sc.payload_ref = 'notice:' || n.id
          WHERE n.twin_id = $1 AND n.kind = 'binding_question'
            AND n.about_event_id = $2`,
        [twin.twinId, inboundEventId],
      );
      await simulateExecutorPost(client, {
        commandId: question.rows[0]!.command_id,
        twinId: twin.twinId,
        waMessageId: "WAMID-QUESTION-X3",
      });
      const yesEventId = await insertWaEvent(client, twin.dek, {
        twinId: twin.twinId,
        companyId: twin.companyId,
        seatId: twin.seatId,
        chatJid: SELF_CHAT,
        senderJid: SELF_CHAT,
        fromMe: true,
        messageId: "3EB0-REP-X3",
        text: "va",
        quotedMessageId: "WAMID-QUESTION-X3",
      });

      // A MODEL THAT NEVER SUBMITS. The pass fail-stops, exactly as the
      // harness's throw did.
      await expect(
        processPendingWaEvents(depsFor(client, twin, [{ text: "I am not sure" }])),
      ).rejects.toThrow();

      // The trace is durable and it is the ONLY thing the run left.
      const failed = await executionsOf(client, twin);
      expect(failed).toHaveLength(1);
      expect(failed[0]!.disposition).toBe("failed");
      expect(await executionEntriesOf(client, twin)).toHaveLength(1);
      expect((await executionEntriesOf(client, twin))[0]!.outcome).toBe("failed");
      // NOTHING WAS FILED — no default kind went into the column this
      // classification exists to empty of one.
      expect(
        await listFiledEntities({ db: client }, twin.companyId),
      ).toEqual([]);
      // ...and the rep's «va» is still pending, so the next pass re-reads it.
      const marker = await client.query<{ n: string }>(
        "SELECT count(*) AS n FROM wa_event_processing WHERE event_id = $1",
        [yesEventId],
      );
      expect(marker.rows[0]!.n).toBe("0");

      // THE REPLAY SUCCEEDS. The bundle binding is already written, so the
      // second attempt is idempotent and only the classification is redone.
      await processPendingWaEvents(depsFor(client, twin, entityKindTurns("business")));
      const after = await executionsOf(client, twin);
      expect(after.map((row) => row.disposition)).toEqual(["failed", "classified"]);
      const entityId = twin.bundle.readChatBinding(chatJid)!.entityId;
      expect(
        (await readFiledEntity(
          { db: client, dek: twin.dek },
          { companyId: twin.companyId, entityId },
        ))!.kind,
      ).toBe("business");
      twin.bundle.close();
    });
  });

  // TWO KINDS OF REFUSAL, ONE OUTCOME: the classification stops the pass,
  // files nothing, acks nothing and leaves the «va» to replay.
  //
  // A RESPONSE THE PROVIDER MARKED TRUNCATED (Codex r1) — the guard the
  // migration nearly lost: a two-valued `kind` is exactly the payload most
  // likely to arrive COMPLETE under a truncation flag, and the runner refuses
  // it. A THIRD VALUE (#363) — the conversation holds the kind to the two the
  // Ledger has, the refusal goes back to the model, and with its one round
  // spent the turn fails.
  const refusals: readonly { readonly what: string; readonly tag: string; readonly turn: ScriptedTurn }[] = [
    {
      what: "a response the provider marked truncated (Codex r1)",
      tag: "X7",
      turn: { structured: { kind: "business" }, stopReason: "model_context_window_exceeded" },
    },
    { what: "a kind the Ledger has no word for (#363)", tag: "X8", turn: { structured: { kind: "unsure" } } },
  ];
  for (const refusal of refusals) it(`files nothing from ${refusal.what}, and stops the pass`, async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const chatJid = "5215559457@s.whatsapp.net";
      const inboundEventId = await insertWaEvent(client, twin.dek, {
        twinId: twin.twinId,
        companyId: twin.companyId,
        seatId: twin.seatId,
        chatJid,
        senderJid: chatJid,
        fromMe: false,
        messageId: `3EB0-IN-${refusal.tag}`,
        text: "me mandas 40 cajas?",
        pushName: "Materiales del Bajio",
      });
      await processPendingWaEvents(depsFor(client, twin, draftingTurns()));
      const question = await client.query<{ command_id: string }>(
        `SELECT sc.id AS command_id
           FROM notices n
           JOIN send_commands sc ON sc.payload_ref = 'notice:' || n.id
          WHERE n.twin_id = $1 AND n.kind = 'binding_question'
            AND n.about_event_id = $2`,
        [twin.twinId, inboundEventId],
      );
      await simulateExecutorPost(client, {
        commandId: question.rows[0]!.command_id,
        twinId: twin.twinId,
        waMessageId: `WAMID-QUESTION-${refusal.tag}`,
      });
      const yesEventId = await insertWaEvent(client, twin.dek, {
        twinId: twin.twinId,
        companyId: twin.companyId,
        seatId: twin.seatId,
        chatJid: SELF_CHAT,
        senderJid: SELF_CHAT,
        fromMe: true,
        messageId: `3EB0-REP-${refusal.tag}`,
        text: "va",
        quotedMessageId: `WAMID-QUESTION-${refusal.tag}`,
      });

      const deps = depsFor(client, twin);
      await expect(
        processPendingWaEvents({ ...deps, harness: scriptedModel([refusal.turn]).harness }),
      ).rejects.toThrow();

      // NOTHING WAS FILED, nothing was acked, and the «va» is still pending
      // — the same three the harness's refusal used to leave.
      expect(
        await listFiledEntities({ db: client }, twin.companyId),
      ).toEqual([]);
      const acks = await client.query<{ n: string }>(
        "SELECT count(*) AS n FROM notices WHERE twin_id = $1 AND kind = 'binding_ack'",
        [twin.twinId],
      );
      expect(acks.rows[0]!.n).toBe("0");
      const marker = await client.query<{ n: string }>(
        "SELECT count(*) AS n FROM wa_event_processing WHERE event_id = $1",
        [yesEventId],
      );
      expect(marker.rows[0]!.n).toBe("0");
      // ...and the trace is there, which the harness never left.
      const executions = await executionsOf(client, twin);
      expect(executions.map((row) => row.disposition)).toEqual(["failed"]);
      expect(await executionEntriesOf(client, twin)).toHaveLength(1);
      twin.bundle.close();
    });
  });

  it("re-infers the startup backlog's bindings through executions too", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const chatJid = "5215559454@s.whatsapp.net";
      const entityId = await uncrossedBinding(client, twin, {
        chatJid,
        pushName: "Tlapaleria Ruiz",
        tag: "X4",
      });

      const { harness } = scriptedModel(entityKindTurns("business"));
      const result = await crossPendingBindings({
        db: client,
        bundle: twin.bundle,
        dek: twin.dek,
        twinId: twin.twinId,
        hmacKey: TEST_AUDIT_HMAC_KEY,
        harness,
        kindModel: { model: "claude-sonnet-5" },
      });
      expect(result).toEqual({ filed: 1, unresolved: [], undetermined: [] });

      const executions = await executionsOf(client, twin);
      expect(executions).toHaveLength(1);
      expect(executions[0]!.trigger_kind).toBe("entity_kind");
      expect(executions[0]!.trigger_mechanism).toBe("request");
      expect(executions[0]!.disposition).toBe("classified");
      const entries = await executionEntriesOf(client, twin);
      expect(entries).toHaveLength(1);
      expect(entries[0]!.ref).toContain(`entity:${entityId}`);
      expect(
        (await readFiledEntity(
          { db: client, dek: twin.dek },
          { companyId: twin.companyId, entityId },
        ))!.kind,
      ).toBe("business");
      twin.bundle.close();
    });
  });

  it("reports the backlog's refused classification and leaves its `failed` record", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const chatJid = "5215559455@s.whatsapp.net";
      const entityId = await uncrossedBinding(client, twin, {
        chatJid,
        pushName: "Ferreteria del Sur",
        tag: "X5",
      });

      // ONE BINDING THE MODEL WILL NOT JUDGE must not cost the rep every
      // other one: the sweep runs before the loop starts, so it reports and
      // carries on — and now it leaves the trace the harness never did.
      const { harness } = scriptedModel([{ text: "I cannot tell" }]);
      const result = await crossPendingBindings({
        db: client,
        bundle: twin.bundle,
        dek: twin.dek,
        twinId: twin.twinId,
        hmacKey: TEST_AUDIT_HMAC_KEY,
        harness,
        kindModel: { model: "claude-sonnet-5" },
      });
      expect(result).toEqual({ filed: 0, unresolved: [], undetermined: [chatJid] });

      const executions = await executionsOf(client, twin);
      expect(executions).toHaveLength(1);
      expect(executions[0]!.disposition).toBe("failed");
      expect(await executionEntriesOf(client, twin)).toHaveLength(1);
      // NOTHING WAS FILED for it, which is the sweep's own rule: an
      // unprovable or unjudgeable crossing is not one to make.
      expect(
        await readFiledEntity(
          { db: client, dek: twin.dek },
          { companyId: twin.companyId, entityId },
        ),
      ).toBeUndefined();
      twin.bundle.close();
    });
  });

  it("re-infers the hand-run backfill's entities through executions too", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const chatJid = "5215559456@s.whatsapp.net";
      const entityId = await bindCustomerThroughCeremony(client, twin, {
        chatJid,
        pushName: "Don Beto",
        tag: "X6",
        kind: "person",
      });
      const before = (await executionsOf(client, twin)).length;

      const { harness } = scriptedModel(entityKindTurns("business"));
      const result = await backfillEntityKinds({
        db: client,
        bundle: twin.bundle,
        dek: twin.dek,
        twinId: twin.twinId,
        companyId: twin.companyId,
        harness,
        kindModel: { model: "claude-sonnet-5" },
        hmacKey: TEST_AUDIT_HMAC_KEY,
      });
      expect(result.determined.map((row) => row.entityId)).toEqual([entityId]);

      const executions = await executionsOf(client, twin);
      expect(executions).toHaveLength(before + 1);
      expect(executions.at(-1)!.trigger_kind).toBe("entity_kind");
      expect(executions.at(-1)!.trigger_mechanism).toBe("request");
      expect(executions.at(-1)!.disposition).toBe("classified");
      expect(await executionEntriesOf(client, twin)).toHaveLength(before + 1);
      twin.bundle.close();
    });
  });
});

interface ExecutionRow {
  id: string;
  trigger_kind: string;
  trigger_mechanism: string;
  tool_names: string[];
  lane: string;
  iterations: number;
  tokens_input: number;
  tokens_output: number;
  disposition: string;
  instructions_digest: string;
  started_at: Date;
}

/**
 * This twin's KIND classifications, in order.
 *
 * SCOPED BY THE OCCASION, because the fixtures above run a drafting
 * execution to get the ceremony's question posted — so "how many executions
 * has this twin run" and "how many classifications" are two different
 * questions, and this file asks the second.
 */
async function executionsOf(
  client: pg.Client,
  twin: Seat,
): Promise<ExecutionRow[]> {
  const res = await client.query<ExecutionRow>(
    `SELECT * FROM executions
      WHERE twin_id = $1 AND trigger_kind = 'entity_kind'
      ORDER BY started_at, id`,
    [twin.twinId],
  );
  return res.rows;
}

/**
 * This twin's `execution` entries, in order.
 *
 * SCOPED BY THE REFERENCE, because the rep chain has no tenant column and
 * this file's tests share one database: `public.audit_chain` is one sequence
 * of links for the whole deployment, and the twin is in the reference
 * `triggerRef` renders.
 */
async function executionEntriesOf(
  client: pg.Client,
  twin: Seat,
): Promise<{ ref: string; outcome: string }[]> {
  const res = await client.query<{ ref: string; outcome: string }>(
    `SELECT ref, outcome FROM audit_chain
      WHERE action = 'execution'
        AND ref LIKE 'trigger:entity_kind %'
        AND ref LIKE '%twin:' || $1 || '%'
      ORDER BY id`,
    [twin.twinId],
  );
  return res.rows;
}

/**
 * A binding the rep confirmed BEFORE the Ledger existed: the ceremony ran to
 * completion — question asked, question posted, the rep's «va» delivered and
 * MARKED PROCESSED, the binding written into the bundle — and nothing ever
 * crossed, because nothing could.
 *
 * BUILT FORWARDS RATHER THAN BY DELETING LEDGER ROWS (`crossing.int.test.ts`
 * built the same state the same way), so it is the real upgrade state the
 * backlog exists for and not an approximation of one.
 */
async function uncrossedBinding(
  client: pg.Client,
  twin: Seat,
  args: {
    readonly chatJid: string;
    readonly pushName: string;
    readonly tag: string;
  },
): Promise<string> {
  await insertWaEvent(client, twin.dek, {
    twinId: twin.twinId,
    companyId: twin.companyId,
    seatId: twin.seatId,
    chatJid: args.chatJid,
    senderJid: args.chatJid,
    fromMe: false,
    messageId: `3EB0-IN-${args.tag}`,
    text: "¿me mandas 40 cajas para el jueves?",
    pushName: args.pushName,
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
    waMessageId: `WAMID-QUESTION-${args.tag}`,
  });
  const vaEventId = await insertWaEvent(client, twin.dek, {
    twinId: twin.twinId,
    companyId: twin.companyId,
    seatId: twin.seatId,
    chatJid: SELF_CHAT,
    senderJid: SELF_CHAT,
    fromMe: true,
    messageId: `3EB0-REP-${args.tag}`,
    text: "va",
    quotedMessageId: `WAMID-QUESTION-${args.tag}`,
  });

  // What the previous release did with that «va», and all it did.
  const entityId = randomUUID();
  twin.bundle.confirmChatBinding({
    chatJid: args.chatJid,
    entityId,
    displayName: args.pushName,
    confirmedAt: "2026-08-27T14:03:00.000Z",
  });
  await client.query(
    "INSERT INTO wa_event_processing (event_id, twin_id, disposition) VALUES ($1, $2, 'binding_confirmed')",
    [vaEventId, twin.twinId],
  );
  return entityId;
}
