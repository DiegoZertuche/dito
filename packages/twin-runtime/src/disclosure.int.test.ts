/**
 * The daily disclosure reaches the thread (ticket #51), driven end to end
 * at the primary Postgres seam — the same one seam slices 1 and 2 use.
 *
 * #50 made the crossing real: a rep-confirmed binding files an entity and
 * its disclosure line. Nobody was told. This is the pass that tells them:
 * once a day the twin assembles the lines nobody has heard about into ONE
 * grouped post — by counterparty, numbered, provenance on every line — and
 * sends it down the existing notice → `system_send` path.
 *
 * Everything here is driven the way the rig drives it: inject `wa_events`,
 * run the consumer, run the pass with an explicit `now`, then read what
 * the rep would see. Real Postgres, real envelope crypto, real SQLCipher
 * (ADR-0028); the model is scripted empty on every disclosure pass, so a
 * model call anywhere near the rep's account of what crossed fails the
 * test loudly (ADR-0003 — nothing here consults a model).
 *
 * Governing ADRs: 0003 (as amended), 0004, 0005/0017 (the plane stays
 * dumb), 0016, 0020, 0034.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBundle, type Bundle } from "@dito/bundle";
import { createDekFromMaterial, type Dek } from "@dito/crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setAutomationPaused } from "./runs/pauses.js";
import { runDailyDisclosure, runDailyExtraction } from "./testing/by-hand.js";
import { ensureShippedAutomations } from "./runs/shipped-automations.js";
import { clockPass } from "./testing/drive-runs.js";
import { seatOnce } from "./testing/seat.js";
import { processPendingWaEvents, type TwinRuntimeDeps } from "./consumer.js";
import { crossPendingBindings } from "./crossing-backlog.js";
import {
  resolveDisclosureLineOfPost,
  type ResolvedDisclosureLine,
} from "./disclosure.js";
import { readPostedSystemSend, resolveQuotedTarget } from "./twin-posts.js";
import { createSendLockWriter } from "./send-lock/writer.js";
import {
  resetAndMigrate,
  withClient,
  TEST_AUDIT_HMAC_KEY,
  TEST_DATABASE_URL,
} from "./testing/db.js";
import { removeTmpDir } from "./testing/tmp.js";
import { fakeEmbedder } from "./testing/fake-embedder.js";
import {
  insertWaEvent,
  simulateExecutorPost,
} from "./testing/seam-fixtures.js";
import {
  closeScriptedModels,
  disclosureTurns,
  entityKindTurns,
  extractionTurns,
  scriptedModel,
  type Script,
  type ScriptedTurn,
} from "./testing/scripted-model.js";
import { composedDisclosure } from "./testing/disclosure-script.js";
import { SETTLE_IMMEDIATELY } from "./testing/settle.js";
import { newExecutionPool } from "./testing/execution-pool.js";

// Every scripted model this suite opened is closed with it (#328).
afterAll(closeScriptedModels);

/** One connection source for every execution this suite runs (ticket #173). */
const executionPool = newExecutionPool();

const SELF_CHAT = "5215550000@s.whatsapp.net";
/** The rep's clock, pinned so «hoy»/«ayer» are exact wherever the suite runs. */
const TZ = "America/Monterrey";

let tmp: string;
let pool: pg.Pool;

beforeAll(async () => {
  await resetAndMigrate();
  tmp = mkdtempSync(join(tmpdir(), "dito-disclosure-int-"));
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
  /**
   * What the model answers. THE DEFAULT IS THE EVENING'S OWN SUBMISSION
   * (ticket #198): the disclosure is an automation, so every call that posts
   * a day scripts what the twin composed around the day's lines
   * (`testing/disclosure-script.ts`). A case whose claim IS the composition
   * scripts its own.
   */
  turns: Script = composedDisclosure,
  /**
   * The wire's own hook, for the one case that needs a model call HELD (the
   * scripted client's `onRequest`): it is how a suite reproduces a second
   * tick arriving while the first execution is still composing.
   */
  options: { onRequest?: (requestNumber: number) => Promise<void> } = {},
): TwinRuntimeDeps {
  const { harness } = scriptedModel(turns, options);
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
    timeZone: TZ,
  };
}

/** The executions of the steps of the twin's daily-disclosure runs, oldest first. */
async function disclosureStepExecutions(
  client: pg.Client,
  twin: Seat,
): Promise<{ run_id: string; trigger_kind: string; trigger_mechanism: string; trigger_ref: string; lane: string; disposition: string }[]> {
  const res = await client.query<{
    run_id: string;
    trigger_kind: string;
    trigger_mechanism: string;
    trigger_ref: string;
    lane: string;
    disposition: string;
  }>(
    `SELECT s.run_id, e.trigger_kind, e.trigger_mechanism, e.trigger_ref, e.lane, e.disposition
       FROM runs r
       JOIN run_steps s ON s.run_id = r.id
       JOIN executions e ON e.id = s.execution_id
      WHERE r.twin_id = $1 AND r.automation = 'daily_disclosure'
      ORDER BY e.started_at, e.id`,
    [twin.twinId],
  );
  return res.rows;
}

function draftingTurns(): ScriptedTurn[] {
  return [
    { toolCall: { name: "create_draft", input: { text: "claro, se las mando el jueves temprano" } } },
    { text: "done" },
  ];
}

/**
 * Drives slice 2's ceremony to a rep-confirmed binding, which is what
 * crosses today: an inbound carrying a push-name, the question posted by
 * the executor, then the rep's quoted «va» at `confirmedAt`.
 */
async function confirmABinding(
  client: pg.Client,
  twin: Seat,
  args: { chatJid: string; pushName: string; tag: string; confirmedAt: Date },
): Promise<{ vaEventId: string; entityId: string }> {
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
    occurredAt: args.confirmedAt,
  });
  await processPendingWaEvents(depsFor(client, twin, draftingTurns()));

  const question = await client.query<{ command_id: string }>(
    `SELECT sc.id AS command_id
       FROM notices n
       JOIN send_commands sc ON sc.payload_ref = 'notice:' || n.id
      WHERE n.twin_id = $1 AND n.kind = 'binding_question'
        AND n.about_event_id = (
          SELECT id FROM wa_events
           WHERE twin_id = $1 AND external_event_id LIKE '%3EB0-IN-' || $2)`,
    [twin.twinId, args.tag],
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
    occurredAt: args.confirmedAt,
  });
  // ONE scripted call, and it is the crossing's kind determination
  // (ticket #60). Any other model call in this pass exhausts the script
  // and fails the test loudly, which is what this line has always said.
  await processPendingWaEvents(depsFor(client, twin, entityKindTurns()));
  return {
    vaEventId,
    entityId: twin.bundle.readChatBinding(args.chatJid)!.entityId,
  };
}

/**
 * Quoted WhatsApp message id + N → the disclosure line the rep meant, the
 * way the correction walks it (ticket #54): the twin-post registry's ONE
 * join turns the quoted id into the notice the post carried, and the
 * numbering recorded at render time turns the number into the line. Both
 * halves are production code; this helper only joins them the way the
 * registry's own verb does.
 */
async function resolveQuotedLine(
  client: pg.Client,
  twin: Seat,
  quotedMessageId: string,
  lineIndex: number,
): Promise<ResolvedDisclosureLine | undefined> {
  const posted = await readPostedSystemSend(
    { db: client, twinId: twin.twinId },
    quotedMessageId,
  );
  if (posted?.noticeId == null) return undefined;
  return resolveDisclosureLineOfPost(
    { db: client, twinId: twin.twinId },
    { noticeId: posted.noticeId, lineIndex },
  );
}

/** What the rep would actually read: the twin post the pass queued. */
async function readTwinPosts(
  client: pg.Client,
  twin: Seat,
  kind: string,
): Promise<{ id: string; commandId: string; text: string }[]> {
  const res = await client.query<{
    id: string;
    command_id: string;
    content_enc: Buffer;
  }>(
    `SELECT n.id, sc.id AS command_id, n.content_enc
       FROM notices n
       JOIN send_commands sc ON sc.payload_ref = 'notice:' || n.id
      WHERE n.twin_id = $1 AND n.kind = $2
      ORDER BY sc.created_at, sc.id`,
    [twin.twinId, kind],
  );
  return res.rows.map((row) => ({
    id: row.id,
    commandId: row.command_id,
    text: Buffer.from(twin.dek.decrypt(row.content_enc)).toString("utf8"),
  }));
}

// 2026-08-28 18:53 America/Monterrey — the rep's own «va».
const CONFIRMED_AT = new Date("2026-08-29T00:53:00.000Z");
/**
 * Two beats of one customer's day, hours apart (#200 hotfix 1's
 * consequence). Both inside the rep's 29th in `TZ`, so one extraction window
 * covers them and the only thing that can separate their lines is WHEN THE
 * CUSTOMER SENT THEM.
 */
const MORNING = new Date("2026-08-29T15:20:00.000Z");
const LATE_IN_THE_DAY = new Date("2026-08-29T23:40:00.000Z");
// 2026-08-29 21:00 America/Monterrey — the next evening's pass.
const NEXT_EVENING = new Date("2026-08-30T03:00:00.000Z");

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

describe("the day's crossings reach the rep's thread (ticket #51; spec #48 shape D)", () => {
  it("posts one grouped disclosure — by counterparty, numbered, provenance on every line — down the ordinary notice → system_send path", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await confirmABinding(client, twin, {
        chatJid: "5215550001@s.whatsapp.net",
        pushName: "Diego Zertuche",
        tag: "D1",
        confirmedAt: CONFIRMED_AT,
      });

      const result = await runDailyDisclosure(
        depsFor(client, twin),
        NEXT_EVENING,
      );
      expect(result).toMatchObject({ posted: true, lines: 1 });

      const posts = await readTwinPosts(client, twin, "daily_disclosure");
      expect(posts).toHaveLength(1);
      expect(posts[0]!.text).toBe(
        `✳️ *Hoy agregué 1 dato al registro.*

fue un día tranquilo, casi todo de un solo cliente

*Diego Zertuche*
1. Lo di de alta como cliente. (tú lo confirmaste, ayer 18:53)

si algo quedó mal respóndeme aquí citando este mensaje y dime cuál`,
      );

      // The plane stays dumb (ADR-0005/0017): the post is an ordinary
      // system_send carrying a notice ref, exactly like every other twin
      // post, with no tap and no new send class.
      const command = await client.query(
        `SELECT send_class, destination, payload_ref, draft_id, outcome
           FROM send_commands WHERE id = $1`,
        [posts[0]!.commandId],
      );
      expect(command.rows[0]).toEqual({
        send_class: "system_send",
        destination: SELF_CHAT,
        payload_ref: `notice:${posts[0]!.id}`,
        draft_id: null,
        outcome: null,
      });
      twin.bundle.close();
    });
  });

  it("posts the day and NOTHING BEFORE IT — one post per execution, of one kind (ticket #218)", async () => {
    // THE ACCEPTANCE THAT ASKS ABOUT WHAT IS ABSENT. Question posts went out
    // ahead of the record, on this execution's own transaction and under its
    // lock, and emission order was thread order — so a regression that
    // re-emitted anything here would put it above the day's account of what
    // crossed. Asserted by the EXECUTION rather than by kind: a count of
    // `daily_disclosure` notices would pass over a post of any other kind
    // this execution wrote, which is exactly the failure.
    await withClient(async (client) => {
      const twin = freshTwin();
      await confirmABinding(client, twin, {
        chatJid: "5215550001@s.whatsapp.net",
        pushName: "Diego Zertuche",
        tag: "D1B",
        confirmedAt: CONFIRMED_AT,
      });

      expect(
        await runDailyDisclosure(depsFor(client, twin), NEXT_EVENING),
      ).toMatchObject({ posted: true, lines: 1 });

      // The day's own attempt row names the execution that composed it, so
      // this is the whole of what that execution posted rather than a count
      // over a window somebody chose.
      const wrote = await client.query<{ kind: string; n: string }>(
        `SELECT n.kind, count(*) AS n
           FROM notices n
           JOIN disclosure_attempts a ON a.execution_id = n.execution_id
          WHERE a.twin_id = $1
          GROUP BY n.kind
          ORDER BY n.kind`,
        [twin.twinId],
      );
      expect(wrote.rows).toEqual([{ kind: "daily_disclosure", n: "1" }]);
      twin.bundle.close();
    });
  });

  it("records the rendered numbering, so a correction resolves quoted id → post → index → line → subject in code, with no model in the path", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const { entityId } = await confirmABinding(client, twin, {
        chatJid: "5215550002@s.whatsapp.net",
        pushName: "Diego Zertuche",
        tag: "D2",
        confirmedAt: CONFIRMED_AT,
      });
      await runDailyDisclosure(depsFor(client, twin), NEXT_EVENING);

      // The executor posts it and records which WhatsApp message carries it
      // — the same mapping every other quoted-id resolution rests on.
      const posts = await readTwinPosts(client, twin, "daily_disclosure");
      await simulateExecutorPost(client, {
        commandId: posts[0]!.commandId,
        twinId: twin.twinId,
        waMessageId: "WAMID-DISCLOSURE-D2",
      });

      // THE POST CARRIES NO KEYWORD SINCE #174, and this is where that
      // shows: `resolveQuotedTarget` is the MATCHER's door, and the daily
      // disclosure has nothing behind it for the matcher to run. So a
      // quoted reply to this post resolves as a twin post with no verb and
      // becomes prose — which is exactly how «el 3 está mal» reaches the
      // execution.
      expect(
        await resolveQuotedTarget(
          { db: client, twinId: twin.twinId, dek: twin.dek },
          "WAMID-DISCLOSURE-D2",
        ),
      ).toEqual({ actionable: false });

      // ...AND THE WALK IS UNCHANGED (ticket #54). The numbering recorded
      // at render time still turns the number the rep NAMED into the line
      // they saw beside it, which is what `retract_disclosure_line` calls.
      // Stored rows the whole way; the model is scripted empty, so a call
      // anywhere near this fails the test loudly.

      const resolved = await resolveDisclosureLineOfPost(
        { db: client, twinId: twin.twinId },
        { noticeId: posts[0]!.id, lineIndex: 1 },
      );
      expect(resolved).toMatchObject({
        lineIndex: 1,
        subjectKind: "entity_create",
        entityId,
        factId: null,
        renderedText: "Lo di de alta como cliente.",
      });

      // A number the post never showed names nothing — the fail-safe
      // direction, and the reason the numbering is stored rather than
      // recomputed.
      expect(
        await resolveDisclosureLineOfPost(
          { db: client, twinId: twin.twinId },
          { noticeId: posts[0]!.id, lineIndex: 2 },
        ),
      ).toBeUndefined();
      // A quoted id that names no twin post resolves nothing at all, so no
      // number can be read against it.
      expect(
        await resolveQuotedTarget(
          { db: client, twinId: twin.twinId, dek: twin.dek },
          "WAMID-NOT-A-POST",
        ),
      ).toBeUndefined();
      twin.bundle.close();
    });
  });

  it("groups by counterparty and numbers CONTINUOUSLY across the groups — «2» names the second line of the post, not the first of the second group", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const first = await confirmABinding(client, twin, {
        chatJid: "5215550003@s.whatsapp.net",
        pushName: "Diego Zertuche",
        tag: "D3a",
        confirmedAt: CONFIRMED_AT,
      });
      const second = await confirmABinding(client, twin, {
        chatJid: "5215550004@s.whatsapp.net",
        pushName: "Ferretería Fuentes",
        tag: "D3b",
        confirmedAt: new Date("2026-08-29T01:10:00.000Z"),
      });

      const result = await runDailyDisclosure(
        depsFor(client, twin),
        NEXT_EVENING,
      );
      expect(result).toMatchObject({ posted: true, lines: 2 });

      const posts = await readTwinPosts(client, twin, "daily_disclosure");
      expect(posts[0]!.text).toBe(
        `✳️ *Hoy agregué 2 datos al registro.*

fue un día tranquilo, casi todo de un solo cliente

*Diego Zertuche*
1. Lo di de alta como cliente. (tú lo confirmaste, ayer 18:53)

*Ferretería Fuentes*
2. Lo di de alta como cliente. (tú lo confirmaste, ayer 19:10)

si algo quedó mal respóndeme aquí citando este mensaje y dime cuál`,
      );

      await simulateExecutorPost(client, {
        commandId: posts[0]!.commandId,
        twinId: twin.twinId,
        waMessageId: "WAMID-DISCLOSURE-D3",
      });
      expect(
        await resolveQuotedLine(client, twin, "WAMID-DISCLOSURE-D3", 1),
      ).toMatchObject({ entityId: first.entityId });
      expect(
        await resolveQuotedLine(client, twin, "WAMID-DISCLOSURE-D3", 2),
      ).toMatchObject({ entityId: second.entityId });
      twin.bundle.close();
    });
  });
});

describe("the number is what the rep reads down the page (spec #48 decision 14)", () => {
  // The alternating case — one counterparty with two lines, another's between
  // them — is not reachable at this seam yet (a binding mints one entity,
  // and an entity gets one create line ever), so it is pinned as a unit on
  // the assembly in `disclosure.test.ts`. What the seam can prove is that
  // three crossings in one day number 1..3 and each number resolves back
  // to the line printed beside it.
  it("numbers every line of the post once, in the order they are read, and each number resolves to its own line", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const first = await confirmABinding(client, twin, {
        chatJid: "5215550030@s.whatsapp.net",
        pushName: "Diego Zertuche",
        tag: "DI1",
        confirmedAt: CONFIRMED_AT,
      });
      const second = await confirmABinding(client, twin, {
        chatJid: "5215550031@s.whatsapp.net",
        pushName: "Ferretería Fuentes",
        tag: "DI2",
        confirmedAt: new Date("2026-08-29T01:00:00.000Z"),
      });
      const third = await confirmABinding(client, twin, {
        chatJid: "5215550032@s.whatsapp.net",
        pushName: "Diego Zertuche",
        tag: "DI3",
        confirmedAt: new Date("2026-08-29T02:00:00.000Z"),
      });

      expect(
        await runDailyDisclosure(depsFor(client, twin), NEXT_EVENING),
      ).toMatchObject({ posted: true, lines: 3 });
      const posts = await readTwinPosts(client, twin, "daily_disclosure");
      // Two chats, both named «Diego Zertuche», are two DIFFERENT counterparties
      // — the binding is per chat — so this is three lines in three groups
      // that happen to share a heading.
      const numbers = [...posts[0]!.text.matchAll(/^(\d+)\. /gmu)].map((m) =>
        Number(m[1]),
      );
      expect(numbers).toEqual([1, 2, 3]);

      await simulateExecutorPost(client, {
        commandId: posts[0]!.commandId,
        twinId: twin.twinId,
        waMessageId: "WAMID-DISCLOSURE-DI",
      });
      // And each number resolves to the line printed beside it.
      for (const [n, expected] of [
        [1, first.entityId],
        [2, second.entityId],
        [3, third.entityId],
      ] as const) {
        expect(
          await resolveQuotedLine(client, twin, "WAMID-DISCLOSURE-DI", n),
        ).toMatchObject({ entityId: expected });
      }
      twin.bundle.close();
    });
  });

  /**
   * THE DAY IS NUMBERED IN THE ORDER IT HAPPENED (#200 hotfix 1's
   * consequence; Diego's ruling on #200, 2026-09-06).
   *
   * A line's place in the post is when its message was sent, so the rep reads
   * their day as their customer lived it. `filed_at` is only the tiebreaker,
   * and that is the decision: as the leading key it distinguishes every line
   * one execution filed and hands the numbering to the sequence the MODEL
   * happened to list its facts in — which is not a fact about the day.
   *
   * The two facts here come off two messages hours apart and are submitted
   * LATEST FIRST, so filing order and chat order disagree and the assertion
   * can only be satisfied by one of them.
   */
  it("numbers the day in the order the day happened, not the order the model submitted it", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const chatJid = "5215550035@s.whatsapp.net";
      // The capture guard's own list: the daily pass reads chats that are in
      // scope, and this is the only suite case that runs an extraction.
      await client.query(
        "INSERT INTO scope_allowlist (twin_id, chat_jid) VALUES ($1, $2)",
        [twin.twinId, chatJid],
      );
      await confirmABinding(client, twin, {
        chatJid,
        pushName: "Ferretería Fuentes",
        tag: "ORD",
        confirmedAt: CONFIRMED_AT,
      });
      // Morning, then evening, in the customer's own chat.
      for (const beat of [
        {
          messageId: "WAMID-ORD-MORNING",
          text: "¿me mandas 20 bultos?",
          at: MORNING,
        },
        {
          messageId: "WAMID-ORD-EVENING",
          text: "y 40 cajas también",
          at: LATE_IN_THE_DAY,
        },
      ]) {
        await insertWaEvent(client, twin.dek, {
          twinId: twin.twinId,
          companyId: twin.companyId,
          seatId: twin.seatId,
          chatJid,
          senderJid: chatJid,
          fromMe: false,
          messageId: beat.messageId,
          text: beat.text,
          occurredAt: beat.at,
        });
      }

      // ONE EXECUTION, SUBMITTING THE EVENING'S FACT FIRST. The aperture
      // files a submission in the order it was listed, so these two lines
      // carry `filed_at` stamps in reverse chat order. `runDailyExtraction`
      // settles its own lane before it returns.
      await runDailyExtraction(
        depsFor(
          client,
          twin,
          extractionTurns(
            {
              fact_type: "OrderRequested",
              message_id: "WAMID-ORD-EVENING",
              confidence: 0.95,
              item: "cajas",
              quantity: 40,
            },
            {
              fact_type: "OrderRequested",
              message_id: "WAMID-ORD-MORNING",
              confidence: 0.95,
              item: "bultos",
              quantity: 20,
            },
          ),
        ),
        NEXT_EVENING,
      );

      expect(
        await runDailyDisclosure(depsFor(client, twin), NEXT_EVENING),
      ).toMatchObject({ posted: true, lines: 3 });
      const [post] = await readTwinPosts(client, twin, "daily_disclosure");
      const numbered = [...post!.text.matchAll(/^\d+\. (.+)$/gmu)].map(
        (match) => match[1]!,
      );
      // The binding's own line first — its rep act is the oldest message of
      // the three — then the morning's order, then the evening's.
      expect(numbered).toHaveLength(3);
      expect(numbered[0]).toContain("Lo di de alta como cliente.");
      expect(numbered[1]).toContain("20 bultos");
      expect(numbered[2]).toContain("40 cajas");
      twin.bundle.close();
    });
  });
});

describe("a post that never arrived is still owed (Codex r1/r2 — a reachable silent loss)", () => {
  /** What the executor writes when a send resolves without landing. */
  async function resolveCommand(
    client: pg.Client,
    commandId: string,
    outcome: "failed" | "held",
  ): Promise<void> {
    await client.query(
      "UPDATE send_commands SET outcome = $2, executed_at = now() WHERE id = $1",
      [commandId, outcome],
    );
  }

  it("carries a FAILED post's lines into the next day's post — a queued line is not a told one", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const { entityId } = await confirmABinding(client, twin, {
        chatJid: "5215550040@s.whatsapp.net",
        pushName: "Diego Zertuche",
        tag: "DF1",
        confirmedAt: CONFIRMED_AT,
      });
      expect(
        await runDailyDisclosure(depsFor(client, twin), NEXT_EVENING),
      ).toMatchObject({ posted: true, lines: 1 });
      const first = await readTwinPosts(client, twin, "daily_disclosure");
      // The rail refused it: the rep read nothing.
      await resolveCommand(client, first[0]!.commandId, "failed");

      // The next day's pass owes them the line again — a NEW post with its
      // own numbering, which is correct because «N no» is always read
      // against the post the rep quoted.
      const result = await runDailyDisclosure(
        depsFor(client, twin),
        new Date("2026-08-31T03:00:00.000Z"),
      );
      expect(result).toMatchObject({ posted: true, lines: 1 });
      const posts = await readTwinPosts(client, twin, "daily_disclosure");
      expect(posts).toHaveLength(2);
      expect(posts[1]!.text).toContain("1. Lo di de alta como cliente.");

      await simulateExecutorPost(client, {
        commandId: posts[1]!.commandId,
        twinId: twin.twinId,
        waMessageId: "WAMID-DISCLOSURE-DF1-SECOND",
      });
      expect(
        await resolveQuotedLine(client, twin, "WAMID-DISCLOSURE-DF1-SECOND", 1),
      ).toMatchObject({ entityId, lineIndex: 1 });

      // And once THAT one lands, nothing is owed any more.
      expect(
        await runDailyDisclosure(
          depsFor(client, twin),
          new Date("2026-09-01T03:00:00.000Z"),
        ),
      ).toEqual({ posted: false, lines: 0 });
      twin.bundle.close();
    });
  });

  /**
   * A CARRIED LINE KEEPS ITS PLACE (#200 hotfix 1's consequence; ruled on
   * #200, 2026-09-06). Nothing here is a new mechanism — it is what ordering
   * on the source event's instant gives for free — and it is asserted so it
   * stays: the line the rep was never shown rests on the older message, so
   * it heads the post that finally reaches them rather than trailing whatever
   * crossed since.
   */
  it("puts a line carried from a failed post above the lines that crossed after it", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const carried = await confirmABinding(client, twin, {
        chatJid: "5215550050@s.whatsapp.net",
        pushName: "Ferretería Fuentes",
        tag: "DK1",
        confirmedAt: CONFIRMED_AT,
      });
      expect(
        await runDailyDisclosure(depsFor(client, twin), NEXT_EVENING),
      ).toMatchObject({ posted: true, lines: 1 });
      const [failed] = await readTwinPosts(client, twin, "daily_disclosure");
      await resolveCommand(client, failed!.commandId, "failed");

      // The next day brings its own crossing, later than the one still owed.
      const fresh = await confirmABinding(client, twin, {
        chatJid: "5215550051@s.whatsapp.net",
        pushName: "Materiales del Valle",
        tag: "DK2",
        confirmedAt: new Date("2026-08-30T18:00:00.000Z"),
      });
      expect(
        await runDailyDisclosure(
          depsFor(client, twin),
          new Date("2026-08-31T03:00:00.000Z"),
        ),
      ).toMatchObject({ posted: true, lines: 2 });

      const posts = await readTwinPosts(client, twin, "daily_disclosure");
      expect(posts).toHaveLength(2);
      await simulateExecutorPost(client, {
        commandId: posts[1]!.commandId,
        twinId: twin.twinId,
        waMessageId: "WAMID-DISCLOSURE-DK-SECOND",
      });
      // «1» is the older act — the one the rail swallowed — and «2» is today's.
      for (const [n, expected] of [
        [1, carried.entityId],
        [2, fresh.entityId],
      ] as const) {
        expect(
          await resolveQuotedLine(client, twin, "WAMID-DISCLOSURE-DK-SECOND", n),
        ).toMatchObject({ entityId: expected, lineIndex: n });
      }
      twin.bundle.close();
    });
  });

  it("keeps trying for as long as the rail is down, and stops the moment it is not — nothing is retried and nothing is abandoned", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await confirmABinding(client, twin, {
        chatJid: "5215550041@s.whatsapp.net",
        pushName: "Diego Zertuche",
        tag: "DF2",
        confirmedAt: CONFIRMED_AT,
      });
      // Five days of a refusing rail. The line is never abandoned and the
      // seam never grows a retry the plane did not ask for: exactly one
      // post, and one command, per day.
      for (let d = 30; d <= 34; d += 1) {
        const day = d <= 31 ? `2026-08-${d}` : `2026-09-0${d - 31}`;
        const result = await runDailyDisclosure(
          depsFor(client, twin),
          new Date(`${day}T03:00:00.000Z`),
        );
        expect(result).toMatchObject({ posted: true, lines: 1 });
        const posts = await readTwinPosts(client, twin, "daily_disclosure");
        await resolveCommand(client, posts.at(-1)!.commandId, "failed");
      }
      const posts = await readTwinPosts(client, twin, "daily_disclosure");
      expect(posts).toHaveLength(5);

      // The rail comes back on day six.
      const sixth = await runDailyDisclosure(
        depsFor(client, twin),
        new Date("2026-09-04T03:00:00.000Z"),
      );
      expect(sixth).toMatchObject({ posted: true, lines: 1 });
      const all = await readTwinPosts(client, twin, "daily_disclosure");
      await simulateExecutorPost(client, {
        commandId: all.at(-1)!.commandId,
        twinId: twin.twinId,
        waMessageId: "WAMID-DISCLOSURE-DF2-LANDED",
      });
      // Told at last: the line is no longer owed.
      expect(
        await runDailyDisclosure(
          depsFor(client, twin),
          new Date("2026-09-05T03:00:00.000Z"),
        ),
      ).toEqual({ posted: false, lines: 0 });
      twin.bundle.close();
    });
  });

  it("says nothing more while a send is still in flight — an unresolved post is not a failed one", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await confirmABinding(client, twin, {
        chatJid: "5215550042@s.whatsapp.net",
        pushName: "Diego Zertuche",
        tag: "DF3",
        confirmedAt: CONFIRMED_AT,
      });
      await runDailyDisclosure(depsFor(client, twin), NEXT_EVENING);
      // The executor has not got to it yet.
      expect(
        await runDailyDisclosure(
          depsFor(client, twin),
          new Date("2026-08-31T03:00:00.000Z"),
        ),
      ).toEqual({ posted: false, lines: 0 });
      expect(
        await readTwinPosts(client, twin, "daily_disclosure"),
      ).toHaveLength(1);
      twin.bundle.close();
    });
  });

  it("carries a HELD post's lines forward too — the plane cannot say whether it landed, and silence is the worse half of that unknown (Codex r3)", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await confirmABinding(client, twin, {
        chatJid: "5215550043@s.whatsapp.net",
        pushName: "Diego Zertuche",
        tag: "DF4",
        confirmedAt: CONFIRMED_AT,
      });
      await runDailyDisclosure(depsFor(client, twin), NEXT_EVENING);
      const posts = await readTwinPosts(client, twin, "daily_disclosure");
      // The executor claimed the command and died before the socket; the
      // stale-claim sweep finalized it `held`, with no `send_executions`
      // row — which is indistinguishable from a send that really went.
      await resolveCommand(client, posts[0]!.commandId, "held");

      // Suppressing on that unknown would choose SILENCE: a crossing the
      // rep is never told about, every audit green. Re-posting chooses a
      // possible duplicate. On the trust surface the duplicate is the safe
      // direction.
      expect(
        await runDailyDisclosure(
          depsFor(client, twin),
          new Date("2026-08-31T03:00:00.000Z"),
        ),
      ).toMatchObject({ posted: true, lines: 1 });
      expect(
        await readTwinPosts(client, twin, "daily_disclosure"),
      ).toHaveLength(2);
      twin.bundle.close();
    });
  });

  it("a post's numbering is SEALED with the post — no line can join it afterwards (Codex r3)", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await confirmABinding(client, twin, {
        chatJid: "5215550046@s.whatsapp.net",
        pushName: "Diego Zertuche",
        tag: "DS1",
        confirmedAt: CONFIRMED_AT,
      });
      const other = await confirmABinding(client, twin, {
        chatJid: "5215550047@s.whatsapp.net",
        pushName: "Ferretería Fuentes",
        tag: "DS2",
        confirmedAt: CONFIRMED_AT,
      });
      await runDailyDisclosure(depsFor(client, twin), NEXT_EVENING);
      const post = await client.query<{ id: string }>(
        "SELECT id FROM disclosure_posts WHERE twin_id = $1",
        [twin.twinId],
      );
      const line = await client.query<{ id: string }>(
        "SELECT id FROM disclosure_lines WHERE twin_id = $1 AND entity_id = $2",
        [twin.twinId, other.entityId],
      );
      // Refusing UPDATE and DELETE is not enough. On a post the rep has
      // already read, an APPEND at an unused index satisfies the primary
      // key, both foreign keys and the immutability triggers — and «3 no»
      // would then resolve to a line never printed beside a 3.
      await expect(
        client.query(
          `INSERT INTO disclosure_post_lines
             (twin_id, post_id, line_index, disclosure_line_id)
           VALUES ($1, $2, 3, $3)`,
          [twin.twinId, post.rows[0]!.id, line.rows[0]!.id],
        ),
      ).rejects.toThrow(/sealed with the post/);
      twin.bundle.close();
    });
  });

  it("a mapping cannot name one twin's post and another twin's line — refused in the store (Codex r2)", async () => {
    await withClient(async (client) => {
      const a = freshTwin();
      const b = freshTwin();
      await confirmABinding(client, a, {
        chatJid: "5215550044@s.whatsapp.net",
        pushName: "Diego Zertuche",
        tag: "DX1",
        confirmedAt: CONFIRMED_AT,
      });
      await confirmABinding(client, b, {
        chatJid: "5215550045@s.whatsapp.net",
        pushName: "Ferretería Fuentes",
        tag: "DX2",
        confirmedAt: CONFIRMED_AT,
      });
      const bLine = await client.query<{ id: string }>(
        "SELECT id FROM disclosure_lines WHERE twin_id = $1",
        [b.twinId],
      );
      // Built inside ONE transaction, the way the pass builds a post —
      // otherwise the seal refuses the insert before the scoped foreign
      // keys get a chance to, and this test would be checking the seal
      // twice instead of the scoping once.
      const aNotice = await client.query<{ id: string }>(
        "SELECT id FROM notices WHERE twin_id = $1 LIMIT 1",
        [a.twinId],
      );
      const attempt = async (twinIdOnMapping: string): Promise<void> => {
        await client.query("BEGIN");
        try {
          const post = await client.query<{ id: string }>(
            `INSERT INTO disclosure_posts (twin_id, disclosure_day, notice_id)
             VALUES ($1, '2026-09-09', $2) RETURNING id`,
            [a.twinId, aNotice.rows[0]!.id],
          );
          // Twin B's line under twin A's post. The resolver filters on the
          // POST's twin, so this state would hand ticket #54 another rep's
          // disclosure line to retract.
          await client.query(
            `INSERT INTO disclosure_post_lines
               (twin_id, post_id, line_index, disclosure_line_id)
             VALUES ($1, $2, 1, $3)`,
            [twinIdOnMapping, post.rows[0]!.id, bLine.rows[0]!.id],
          );
        } finally {
          await client.query("ROLLBACK");
        }
      };
      await expect(attempt(a.twinId)).rejects.toThrow(
        /disclosure_post_lines_line_fkey/,
      );
      // And the mirror image: B's twin id on a mapping into A's post.
      await expect(attempt(b.twinId)).rejects.toThrow(
        /disclosure_post_lines_post_fkey/,
      );
      a.bundle.close();
      b.bundle.close();
    });
  });
});

/**
 * SUPERSEDED IN HALF BY TICKET #54. This block used to assert that «1 no»
 * did nothing at all, because the correction was not built. It is built
 * now (`corrections.int.test.ts` drives it end to end), and what survives
 * here is the half that is still true and still load-bearing: a reply
 * carrying CONTENT beyond the bare phrase mints nothing and the line
 * stands. The revision loop is out of scope for a correction exactly as it
 * is for a draft.
 */
describe("content beyond the bare phrase mints nothing (ticket #54)", () => {
  it("«1 no, está mal» quoted on the disclosure post mints NOTHING — no tap, no dismissal, no retraction; the fail-safe direction is absolute", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await confirmABinding(client, twin, {
        chatJid: "5215550020@s.whatsapp.net",
        pushName: "Diego Zertuche",
        tag: "DC1",
        confirmedAt: CONFIRMED_AT,
      });
      await runDailyDisclosure(depsFor(client, twin), NEXT_EVENING);
      const posts = await readTwinPosts(client, twin, "daily_disclosure");
      await simulateExecutorPost(client, {
        commandId: posts[0]!.commandId,
        twinId: twin.twinId,
        waMessageId: "WAMID-DISCLOSURE-DC1",
      });

      const before = await client.query<{ n: string }>(
        "SELECT count(*) AS n FROM taps",
      );
      await insertWaEvent(client, twin.dek, {
        twinId: twin.twinId,
        companyId: twin.companyId,
        seatId: twin.seatId,
        chatJid: SELF_CHAT,
        senderJid: SELF_CHAT,
        fromMe: true,
        messageId: "3EB0-REP-DC1-CORRECTION",
        text: "1 no, está mal",
        quotedMessageId: "WAMID-DISCLOSURE-DC1",
      });
      // A reply the correction verb does not accept is prose pointed at a
      // twin post, so the disclosure post's `unmatched: "follow_up"` hands
      // it to the Q&A. Scripted so the pass is deterministic; what matters
      // is what did NOT happen.
      await processPendingWaEvents(
        depsFor(client, twin, [
          { text: "" },
        ]),
      );

      expect(
        (await client.query<{ n: string }>("SELECT count(*) AS n FROM taps"))
          .rows[0]!.n,
      ).toBe(before.rows[0]!.n);
      const dismissals = await client.query("SELECT 1 FROM draft_dismissals");
      expect(dismissals.rows).toEqual([]);
      // And nothing was retracted: the line stands, and so does whatever it
      // disclosed.
      const retractions = await client.query("SELECT 1 FROM fact_retractions");
      expect(retractions.rows).toEqual([]);
      const resolved = await resolveQuotedLine(
        client,
        twin,
        "WAMID-DISCLOSURE-DC1",
        1,
      );
      expect(resolved).toBeDefined();
      twin.bundle.close();
    });
  });
});

describe("silence is a valid state (spec #48 decision 17; story 11)", () => {
  it("an empty day posts NOTHING at all — no notice, no command, and no post row that would mark the day done", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      const result = await runDailyDisclosure(
        depsFor(client, twin),
        NEXT_EVENING,
      );
      expect(result).toEqual({
        posted: false,
        lines: 0,
      });
      expect(await readTwinPosts(client, twin, "daily_disclosure")).toEqual([]);
      const rows = await client.query(
        "SELECT 1 FROM disclosure_posts WHERE twin_id = $1",
        [twin.twinId],
      );
      expect(rows.rows).toEqual([]);
      twin.bundle.close();
    });
  });

  it("a day that filed nothing never goes 'done': a crossing landing later the SAME day is still disclosed", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      // Morning: nothing crossed, so nothing is said and nothing is
      // recorded — the day stays open.
      const morning = new Date("2026-08-29T15:00:00.000Z");
      expect(await runDailyDisclosure(depsFor(client, twin), morning)).toEqual({
        posted: false,
        lines: 0,
      });
      await confirmABinding(client, twin, {
        chatJid: "5215550005@s.whatsapp.net",
        pushName: "Diego Zertuche",
        tag: "D4",
        confirmedAt: new Date("2026-08-29T18:00:00.000Z"),
      });
      // Same rep-calendar day, later: the crossing is disclosed.
      const evening = new Date("2026-08-29T23:00:00.000Z");
      expect(
        await runDailyDisclosure(depsFor(client, twin), evening),
      ).toMatchObject({ posted: true, lines: 1 });
      expect(
        await readTwinPosts(client, twin, "daily_disclosure"),
      ).toHaveLength(1);
      twin.bundle.close();
    });
  });
});

describe("restart-safe and idempotent per (twin, day) (spec #48 decision 19)", () => {
  it("re-running the same day posts nothing more and counts nothing twice", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await confirmABinding(client, twin, {
        chatJid: "5215550006@s.whatsapp.net",
        pushName: "Diego Zertuche",
        tag: "D5",
        confirmedAt: CONFIRMED_AT,
      });
      expect(
        await runDailyDisclosure(depsFor(client, twin), NEXT_EVENING),
      ).toMatchObject({ posted: true, lines: 1 });
      // The crash-replay: the same day, run again.
      expect(
        await runDailyDisclosure(depsFor(client, twin), NEXT_EVENING),
      ).toEqual({ posted: false, lines: 0 });
      expect(
        await runDailyDisclosure(
          depsFor(client, twin),
          new Date("2026-08-30T04:30:00.000Z"),
        ),
      ).toEqual({ posted: false, lines: 0 });

      expect(
        await readTwinPosts(client, twin, "daily_disclosure"),
      ).toHaveLength(1);
      const counted = await client.query<{ n: string }>(
        `SELECT count(*) AS n
           FROM disclosure_post_lines pl
           JOIN disclosure_posts p ON p.id = pl.post_id
          WHERE p.twin_id = $1`,
        [twin.twinId],
      );
      expect(counted.rows[0]!.n).toBe("1");
      twin.bundle.close();
    });
  });

  it("yesterday's lines are not counted again today — tomorrow's post carries only what tomorrow crossed", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await confirmABinding(client, twin, {
        chatJid: "5215550014@s.whatsapp.net",
        pushName: "Diego Zertuche",
        tag: "D12a",
        confirmedAt: CONFIRMED_AT,
      });
      expect(
        await runDailyDisclosure(depsFor(client, twin), NEXT_EVENING),
      ).toMatchObject({ posted: true, lines: 1 });

      // The next day, one more crossing. The post that follows must carry
      // that one line and NOT yesterday's, which the rep has already been
      // told about and may already have corrected.
      await confirmABinding(client, twin, {
        chatJid: "5215550015@s.whatsapp.net",
        pushName: "Ferretería Fuentes",
        tag: "D12b",
        confirmedAt: new Date("2026-08-30T20:00:00.000Z"),
      });
      expect(
        await runDailyDisclosure(
          depsFor(client, twin),
          new Date("2026-08-31T03:00:00.000Z"),
        ),
      ).toMatchObject({ posted: true, lines: 1 });

      const posts = await readTwinPosts(client, twin, "daily_disclosure");
      expect(posts).toHaveLength(2);
      expect(posts[1]!.text).toContain("1 dato");
      expect(posts[1]!.text).toContain("*Ferretería Fuentes*");
      expect(posts[1]!.text).not.toContain("*Diego Zertuche*");
      // Two posts, two lines, and no line in both.
      const counted = await client.query<{ lines: string; distinct: string }>(
        `SELECT count(*) AS lines, count(DISTINCT pl.disclosure_line_id) AS distinct
           FROM disclosure_post_lines pl
           JOIN disclosure_posts p ON p.id = pl.post_id
          WHERE p.twin_id = $1`,
        [twin.twinId],
      );
      expect(counted.rows[0]).toEqual({ lines: "2", distinct: "2" });
      twin.bundle.close();
    });
  });

  it("the DATABASE is the guarantee, not the pass's own read: a second post for one day is refused by the seam", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await confirmABinding(client, twin, {
        chatJid: "5215550012@s.whatsapp.net",
        pushName: "Diego Zertuche",
        tag: "D10",
        confirmedAt: CONFIRMED_AT,
      });
      await runDailyDisclosure(depsFor(client, twin), NEXT_EVENING);
      const day = await client.query<{
        disclosure_day: Date;
        notice_id: string;
      }>(
        "SELECT disclosure_day, notice_id FROM disclosure_posts WHERE twin_id = $1",
        [twin.twinId],
      );
      // Hand-written, bypassing the pass entirely — the way a racing
      // second consumer would arrive.
      await expect(
        client.query(
          `INSERT INTO disclosure_posts (twin_id, disclosure_day, notice_id)
           VALUES ($1, $2, $3)`,
          [twin.twinId, day.rows[0]!.disclosure_day, day.rows[0]!.notice_id],
        ),
      ).rejects.toThrow(/disclosure_posts_one_per/);
      // And the numbering it wrote is sealed: no later transaction adds to
      // it, at a used index or a free one. (A line may legitimately appear
      // in a LATER POST — one whose send failed reached nobody, so its
      // lines are still owed. "Disclosed" is a question about delivery,
      // asked in `readPendingLines`, not a unique index here — Codex
      // r1/r2/r3.)
      const line = await client.query<{ id: string; post_id: string }>(
        `SELECT pl.disclosure_line_id AS id, pl.post_id
           FROM disclosure_post_lines pl
           JOIN disclosure_posts p ON p.id = pl.post_id
          WHERE p.twin_id = $1`,
        [twin.twinId],
      );
      await expect(
        client.query(
          `INSERT INTO disclosure_post_lines
             (twin_id, post_id, line_index, disclosure_line_id)
           VALUES ($1, $2, 1, $3)`,
          [twin.twinId, line.rows[0]!.post_id, line.rows[0]!.id],
        ),
      ).rejects.toThrow(/sealed with the post/);
      twin.bundle.close();
    });
  });

  it("what the rep was told is frozen — the post and its numbering refuse UPDATE and DELETE (ADR-0034)", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await confirmABinding(client, twin, {
        chatJid: "5215550013@s.whatsapp.net",
        pushName: "Diego Zertuche",
        tag: "D11",
        confirmedAt: CONFIRMED_AT,
      });
      await runDailyDisclosure(depsFor(client, twin), NEXT_EVENING);
      await expect(
        client.query(
          "UPDATE disclosure_posts SET disclosure_day = '2020-01-01'",
        ),
      ).rejects.toThrow(/immutable/);
      await expect(
        client.query("UPDATE disclosure_post_lines SET line_index = 7"),
      ).rejects.toThrow(/immutable/);
      await expect(
        client.query("DELETE FROM disclosure_post_lines"),
      ).rejects.toThrow(/immutable/);
      twin.bundle.close();
    });
  });

  it("two passes that DISAGREE about the day still produce one post — the per-twin lock, not the day index, is what settles a midnight race (Codex r3)", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await confirmABinding(client, twin, {
        chatJid: "5215550016@s.whatsapp.net",
        pushName: "Diego Zertuche",
        tag: "DR1",
        confirmedAt: CONFIRMED_AT,
      });
      // Two clients, two passes, straddling the rep's midnight: one keys
      // today, one keys tomorrow, so the (twin, day) unique index cannot
      // separate them. Both read the same owed line.
      const other = new pg.Client({ connectionString: TEST_DATABASE_URL });
      await other.connect();
      try {
        const [a, b] = await Promise.all([
          runDailyDisclosure(
            depsFor(client, twin),
            // 2026-08-29 23:59 America/Monterrey
            new Date("2026-08-30T05:59:00.000Z"),
          ),
          runDailyDisclosure(
            depsFor(other, twin),
            // 2026-08-30 00:01 America/Monterrey — the next rep day
            new Date("2026-08-30T06:01:00.000Z"),
          ),
        ]);
        // Exactly one of them said anything.
        expect([a.posted, b.posted].filter(Boolean)).toHaveLength(1);
        expect(
          await readTwinPosts(client, twin, "daily_disclosure"),
        ).toHaveLength(1);
        const counted = await client.query<{ n: string }>(
          `SELECT count(*) AS n FROM disclosure_post_lines WHERE twin_id = $1`,
          [twin.twinId],
        );
        expect(counted.rows[0]!.n).toBe("1");
      } finally {
        await other.end();
      }
      twin.bundle.close();
    });
  });

  it("a line that missed its day is carried into the next post rather than lost — the disclosure claim is about everything that crossed", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await confirmABinding(client, twin, {
        chatJid: "5215550007@s.whatsapp.net",
        pushName: "Diego Zertuche",
        tag: "D6a",
        confirmedAt: CONFIRMED_AT,
      });
      // The pass never ran that evening — the laptop was closed.
      await confirmABinding(client, twin, {
        chatJid: "5215550008@s.whatsapp.net",
        pushName: "Ferretería Fuentes",
        tag: "D6b",
        confirmedAt: new Date("2026-08-30T00:30:00.000Z"),
      });
      const result = await runDailyDisclosure(
        depsFor(client, twin),
        new Date("2026-08-31T03:00:00.000Z"),
      );
      expect(result).toMatchObject({ posted: true, lines: 2 });
      const posts = await readTwinPosts(client, twin, "daily_disclosure");
      expect(posts[0]!.text).toContain("2 datos");
      expect(posts[0]!.text).toContain("*Diego Zertuche*");
      expect(posts[0]!.text).toContain("*Ferretería Fuentes*");
      twin.bundle.close();
    });
  });

  it("discloses what the upgrade sweep crossed too (#50's crossPendingBindings) — a binding confirmed before the Ledger existed is still the rep's to see", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      // The carried steering install, built FORWARDS rather than by
      // deleting Ledger rows (#50's own fixture doctrine): slice 2 wrote
      // the binding into the bundle and marked the «va» processed, and
      // that is all it did. No pass will ever re-deliver that event.
      const chatJid = "5215550009@s.whatsapp.net";
      const vaEventId = await slice2UpgradeState(client, twin, {
        chatJid,
        pushName: "Diego Zertuche",
        tag: "D7",
        confirmedAt: CONFIRMED_AT,
      });
      expect(vaEventId).toBeDefined();

      const swept = await crossPendingBindings({
        ...kindBacklogModel(),
        db: client,
        bundle: twin.bundle,
        dek: twin.dek,
        twinId: twin.twinId,
        hmacKey: TEST_AUDIT_HMAC_KEY,
      });
      expect(swept).toMatchObject({ filed: 1, unresolved: [] });

      // The sweep files without posting anything — it is an upgrade, not a
      // conversation. The daily pass is what tells the rep, and it must see
      // the sweep's lines exactly as it sees the live path's.
      expect(
        await runDailyDisclosure(depsFor(client, twin), NEXT_EVENING),
      ).toMatchObject({ posted: true, lines: 1 });
      const posts = await readTwinPosts(client, twin, "daily_disclosure");
      expect(posts[0]!.text).toContain("*Diego Zertuche*");
      expect(posts[0]!.text).toContain("1. Lo di de alta como cliente.");
      twin.bundle.close();
    });
  });
});

describe("fired by the clock once the day's read has ended (spec #48 decision 19; ticket #364)", () => {
  it("holds the post until the hour, then posts it once — and the day is attempted once", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await confirmABinding(client, twin, {
        chatJid: "5215550010@s.whatsapp.net",
        pushName: "Diego Zertuche",
        tag: "D8",
        confirmedAt: CONFIRMED_AT,
      });
      await seatOnce(client, twin.twinId);

      // 2026-08-29 10:00 America/Monterrey — mid-morning: the day's instant
      // has not come, so the clock starts nothing.
      const morning = new Date("2026-08-29T16:00:00.000Z");
      expect(await clockPass(depsFor(client, twin), morning)).toBe(0);
      expect(await readTwinPosts(client, twin, "daily_disclosure")).toEqual([]);

      // At the hour the clock fires the day's notes — the day had nothing
      // left to read — as one run, and the post goes out.
      expect(await clockPass(depsFor(client, twin), NEXT_EVENING)).toBe(1);
      expect(await readTwinPosts(client, twin, "daily_disclosure")).toHaveLength(1);
      const run = await client.query(
        "SELECT automation, created_by, state FROM runs WHERE twin_id = $1 AND parent_run_id IS NULL",
        [twin.twinId],
      );
      expect(run.rows).toEqual([{ automation: "daily_disclosure", created_by: "clock", state: "succeeded" }]);
      // ...AND ITS RECORD SAYS `posted`, read off the send tool's outcome.
      const posted = await client.query<{ disposition: string }>(
        `SELECT e.disposition FROM executions e
           JOIN run_steps s ON s.execution_id = e.id AND s.kind = 'agent'
           JOIN runs r ON r.id = s.run_id
          WHERE r.twin_id = $1`,
        [twin.twinId],
      );
      expect(posted.rows).toEqual([{ disposition: "posted" }]);

      // ONE ATTEMPT PER DAY: a later tick starts nothing.
      expect(await clockPass(depsFor(client, twin), new Date("2026-08-30T04:00:00.000Z"))).toBe(0);
      expect(await readTwinPosts(client, twin, "daily_disclosure")).toHaveLength(1);
      twin.bundle.close();
    });
  });

  it("starts nothing while «Las notas del día» is paused on Rutinas, and the rep's own ask posts the day once it is back on (tickets #325, #364)", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await confirmABinding(client, twin, {
        chatJid: "5215550018@s.whatsapp.net",
        pushName: "Diego Zertuche",
        tag: "DP",
        confirmedAt: CONFIRMED_AT,
      });
      await seatOnce(client, twin.twinId);
      const seat = await client.query<{ id: string }>("SELECT id FROM seats WHERE twin_id = $1", [twin.twinId]);
      const seatId = seat.rows[0]!.id;
      await ensureShippedAutomations(client, { twinId: twin.twinId, seatId }, new Date(NEXT_EVENING.getTime() - 12 * 3_600_000));
      const row = await client.query<{ id: string }>(
        "SELECT id FROM automations WHERE twin_id = $1 AND shipped = 'daily_disclosure'",
        [twin.twinId],
      );
      const paused = (value: boolean) =>
        setAutomationPaused(client, { twinId: twin.twinId, seatId, automationId: row.rows[0]!.id, paused: value });
      expect(await paused(true)).toBe(true);
      expect(await clockPass(depsFor(client, twin), NEXT_EVENING)).toBe(0);
      expect(await readTwinPosts(client, twin, "daily_disclosure")).toEqual([]);
      expect(await paused(false)).toBe(true);
      expect(await runDailyDisclosure(depsFor(client, twin), NEXT_EVENING)).toMatchObject({ posted: true });
      expect(await readTwinPosts(client, twin, "daily_disclosure")).toHaveLength(1);
      twin.bundle.close();
    });
  });
});

/**
 * THE COMPOSITION, AT THE SEAM AND UNDER THE SCRIPTED WIRE (ticket #198;
 * spec #193 decisions 8, 21, 23 and 24 and user story 28; the ruling on
 * #194; ADR-0020, ADR-0028 as amended, ADR-0037 as amended).
 *
 * The post the rep reads is an execution's output now, so what this describe
 * is about is the pair of claims a unit test cannot make: that the day the
 * model was shown is the day that POSTS, line for line and in order; and that
 * a submission the guard refuses posts NOTHING and leaves an execution that
 * says `failed` with the day's lines still owed.
 *
 * NO MODEL IS CALLED, ever (ADR-0028 as amended). Every case scripts the wire
 * — the real Agent SDK and its child, turns from a script —
 * so a guard that stopped biting fails here rather than on a rig.
 */
describe("the twin composes around code-owned lines (spec #193 decision 8)", () => {
  it("posts the heading, the twin's opening, every line as stored, and the twin's closing", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await confirmABinding(client, twin, {
        chatJid: "5215550020@s.whatsapp.net",
        pushName: "Ferretería Fuentes",
        tag: "C1",
        confirmedAt: CONFIRMED_AT,
      });

      // THE OPENING SLOTS THE CUSTOMER'S NAME rather than typing it, which
      // is the whole of ADR-0037's division: the twin writes the words and
      // code writes the value. The one customer is reference 1 — the
      // customers are numbered from one and are the only thing numbered
      // (ticket #218).
      const result = await runDailyDisclosure(
        depsFor(
          client,
          twin,
          disclosureTurns({
            opening: "día corto, sólo movimiento de [[1]]",
            closing: "si algo salió mal contéstame aquí y dime cuál",
          }),
        ),
        NEXT_EVENING,
      );
      expect(result).toMatchObject({ posted: true, lines: 1 });

      const posts = await readTwinPosts(client, twin, "daily_disclosure");
      expect(posts[0]!.text).toBe(
        `✳️ *Hoy agregué 1 dato al registro.*

día corto, sólo movimiento de Ferretería Fuentes

*Ferretería Fuentes*
1. Lo di de alta como cliente. (tú lo confirmaste, ayer 18:53)

si algo salió mal contéstame aquí y dime cuál`,
      );

      // ONE STEP OF ONE RUN, ON THE BATCH LANE, AND `posted` ONLY BECAUSE THE
      // POST COMMITTED (the ruling on #194).
      const [execution] = await disclosureStepExecutions(client, twin);
      expect(execution).toMatchObject({
        trigger_kind: "run_step",
        trigger_mechanism: "request",
        lane: "batch",
        disposition: "posted",
      });
      // CONTENT-FREE: the twin, the run and the step, and not a syllable of
      // the post (ADR-0020; `executions_trigger_ref_content_free_check`).
      expect(execution!.trigger_ref).toBe(
        `trigger:run_step mechanism:request twin:${twin.twinId} run:${execution!.run_id} step:0`,
      );
      expect(execution!.trigger_ref).not.toContain("Fuentes");

      // ...WITH ONE CHAIN ENTRY BESIDE IT, carrying the same reference from
      // the same renderer — the pair ADR-0020's coverage check looks for.
      const entries = await client.query<{ caller: string; outcome: string }>(
        `SELECT c.caller, c.outcome FROM audit_chain c
           JOIN executions e ON c.ref = e.trigger_ref || ' instructions:' || e.instructions_digest
           JOIN run_steps s ON s.execution_id = e.id
           JOIN runs r ON r.id = s.run_id
          WHERE e.twin_id = $1 AND r.automation = 'daily_disclosure'`,
        [twin.twinId],
      );
      expect(entries.rows).toEqual([
        { caller: "execution", outcome: "posted" },
      ]);

      // THE POST NAMES THE EXECUTION THAT COMPOSED IT (spec #193 decision
      // 24), which is what makes a boundary session able to read what an
      // evening cost.
      const notice = await client.query<{ execution_id: string | null }>(
        "SELECT execution_id FROM notices WHERE id = $1",
        [posts[0]!.id],
      );
      expect(notice.rows[0]!.execution_id).not.toBeNull();

      // ...and the day is marked attempted, whichever way it ended.
      const attempts = await client.query<{ disclosure_day: string }>(
        `SELECT to_char(disclosure_day, 'YYYY-MM-DD') AS disclosure_day
           FROM disclosure_attempts WHERE twin_id = $1`,
        [twin.twinId],
      );
      expect(attempts.rows).toEqual([{ disclosure_day: "2026-08-29" }]);
      twin.bundle.close();
    });
  });

  it("posts every line in stored order with its provenance, whatever the composition says", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await confirmABinding(client, twin, {
        chatJid: "5215550021@s.whatsapp.net",
        pushName: "Diego Zertuche",
        tag: "C2",
        confirmedAt: CONFIRMED_AT,
      });
      await confirmABinding(client, twin, {
        chatJid: "5215550022@s.whatsapp.net",
        pushName: "Ferretería Fuentes",
        tag: "C3",
        confirmedAt: new Date("2026-08-29T01:10:00.000Z"),
      });

      // THE SUBMISSION CANNOT REACH THE LINES AT ALL — it carries an
      // opening and a closing and nothing else — so the claim here is what
      // that buys: a composition that talks about one customer still posts
      // both, in filing order, with the numbering the store records.
      await runDailyDisclosure(
        depsFor(
          client,
          twin,
          disclosureTurns({
            opening: "nada más de [[1]] hoy",
            closing: "cualquier cosa me dices",
          }),
        ),
        NEXT_EVENING,
      );
      const [post] = await readTwinPosts(client, twin, "daily_disclosure");
      const lines = post!.text
        .split("\n")
        .filter((line) => /^\d+\. /u.test(line));
      expect(lines).toEqual([
        "1. Lo di de alta como cliente. (tú lo confirmaste, ayer 18:53)",
        "2. Lo di de alta como cliente. (tú lo confirmaste, ayer 19:10)",
      ]);
      const recorded = await client.query<{ line_index: number }>(
        `SELECT line_index FROM disclosure_post_lines
          WHERE twin_id = $1 ORDER BY line_index`,
        [twin.twinId],
      );
      expect(recorded.rows.map((row) => row.line_index)).toEqual([1, 2]);
      twin.bundle.close();
    });
  });

  it("refuses a submission that types a digit, a name, an unserved slot or nothing at all — and posts none of them", async () => {
    // THE GUARD, CASE BY CASE, THROUGH THE WHOLE PATH (user story 28). Each
    // one is a post the tool refuses on every attempt, so the step ends on
    // its words with nothing performed — `answered`, never `posted` —
    // nothing posts, and the day's line is still owed.
    const offenders: readonly (readonly [
      string,
      Parameters<typeof disclosureTurns>[0],
    ])[] = [
      [
        "a typed count",
        {
          opening: "hoy agregué 1 dato",
          closing: "cualquier cosa me dices",
        },
      ],
      [
        "a typed customer name",
        {
          opening: "movimiento de Ferretería Fuentes",
          closing: "cualquier cosa me dices",
        },
      ],
      [
        "a slot nothing served",
        { opening: "movimiento de [[9]]", closing: "cualquier cosa me dices" },
      ],
      ["an empty closing", { opening: "día corto", closing: "   " }],
    ];
    for (const [at, [what, script]] of offenders.entries()) {
      await withClient(async (client) => {
        const twin = freshTwin();
        await confirmABinding(client, twin, {
          chatJid: "5215550023@s.whatsapp.net",
          pushName: "Ferretería Fuentes",
          tag: `C4${String(at)}`,
          confirmedAt: CONFIRMED_AT,
        });
        // FOUR ROUNDS OF THE SAME REFUSED SUBMISSION, because a refusal is
        // feedback and the model may correct it: this one never does.
        const refused = [
          ...disclosureTurns(script),
          ...disclosureTurns(script),
          ...disclosureTurns(script),
          ...disclosureTurns(script),
        ];
        const result = await runDailyDisclosure(
          depsFor(client, twin, refused),
          NEXT_EVENING,
        );
        expect(result, what).toMatchObject({ posted: false });
        expect(result.runId, what).toBeDefined();
        expect(
          await readTwinPosts(client, twin, "daily_disclosure"),
          what,
        ).toEqual([]);
        expect(
          (await disclosureStepExecutions(client, twin)).map((row) => row.disposition),
          what,
        ).toEqual(["answered"]);
        // THE LINES RIDE TOMORROW'S POST (spec #193 decision 10): nothing was
        // told, so nothing is claimed.
        const owed = await client.query<{ n: string }>(
          "SELECT count(*) AS n FROM disclosure_post_lines WHERE twin_id = $1",
          [twin.twinId],
        );
        expect(Number(owed.rows[0]!.n), what).toBe(0);
        twin.bundle.close();
      });
    }
  });

  it("does not compose the day again after a failed attempt", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await confirmABinding(client, twin, {
        chatJid: "5215550024@s.whatsapp.net",
        pushName: "Ferretería Fuentes",
        tag: "C5",
        confirmedAt: CONFIRMED_AT,
      });
      await seatOnce(client, twin.twinId);
      // One attempt, refused every round: the clock fires the day's post once.
      const script = { opening: "hoy agregué 2 datos", closing: "me dices" };
      expect(
        await clockPass(
          depsFor(client, twin, [
            ...disclosureTurns(script),
            ...disclosureTurns(script),
            ...disclosureTurns(script),
            ...disclosureTurns(script),
          ]),
          NEXT_EVENING,
        ),
      ).toBe(1);
      // ...AND THE DAY IS NOT COMPOSED AGAIN, on the durable mark rather than
      // on a flag: the cadence is stamped for the day's instant, and this is a
      // fresh pass with a fresh lane, which is what a restart looks like. The
      // model is scripted EMPTY, so a second run would fail loudly rather
      // than quietly cost a call.
      expect(await clockPass(depsFor(client, twin, []), NEXT_EVENING)).toBe(0);
      const runs = await client.query(
        "SELECT 1 FROM runs WHERE twin_id = $1 AND automation = 'daily_disclosure' AND parent_run_id IS NULL",
        [twin.twinId],
      );
      expect(runs.rows).toHaveLength(1);
      // ...and TOMORROW composes it, carrying the line the failed attempt
      // never told.
      const tomorrow = new Date("2026-08-31T03:00:00.000Z");
      expect(await clockPass(depsFor(client, twin), tomorrow)).toBe(1);
      expect(await readTwinPosts(client, twin, "daily_disclosure")).toHaveLength(1);
      twin.bundle.close();
    });
  });
});

/**
 * The state the rig's carried install actually wakes in (#50's fixture
 * doctrine, reused): the ceremony runs, the previous release writes the
 * binding into the bundle and marks the «va» processed — and nothing else
 * happens, because the Ledger did not exist yet.
 */
async function slice2UpgradeState(
  client: pg.Client,
  twin: Seat,
  args: { chatJid: string; pushName: string; tag: string; confirmedAt: Date },
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
    occurredAt: args.confirmedAt,
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
    occurredAt: args.confirmedAt,
  });
  twin.bundle.confirmChatBinding({
    chatJid: args.chatJid,
    entityId: randomUUID(),
    displayName: args.pushName,
    confirmedAt: args.confirmedAt.toISOString(),
  });
  await client.query(
    "INSERT INTO wa_event_processing (event_id, twin_id, disposition) VALUES ($1, $2, 'binding_confirmed')",
    [vaEventId, twin.twinId],
  );
  return vaEventId;
}
