/**
 * THE REP TEACHES THEIR TWIN, AT THE POSTGRES SEAM (ticket #260; spec #258
 * *The rep notepad, in full*; ADR-0033 as amended; ADR-0013's
 * third gate shape).
 *
 * This is the ticket's acceptance criteria as one file. The rep writes «con
 * Fuentes siempre de usted» in their own thread, an execution reads it, a
 * gated tool writes the notebook, a receipt the twin cannot fake tells them
 * it landed — and the next draft to a customer is written with the rule in
 * front of the model.
 *
 * WHY IT IS A HOME OF ITS OWN. `thread-acts.int.test.ts` is the thread as an
 * ACTOR on its own earlier posts, and every case there needs a post of the
 * twin's for the rep to point at. A teach turn points at nothing: the rep
 * says a thing about themselves, and what it reaches is a store in the
 * bundle. The claims here are the ones that cross BOTH stores, which is what
 * no other suite is positioned to see.
 *
 * The pre-agreed seam (spec #258 *Testing decisions*): `wa_events` fixtures
 * in with real DEK-encrypted payloads; out the other side the bundle's
 * notepad versions, the receipt notice with its `system_send` and its
 * `receipt` post part, the rep-side `executions` row with its disposition,
 * the entry on `public.audit_chain` and the event's processing marker. Real
 * Postgres, real envelope crypto, real SQLCipher (ADR-0028); the model is
 * scripted at the model boundary and CI never calls one.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyAuditChainInDb } from "@dito/audit";
import { createBundle, NOTEPAD_CAP, type Bundle } from "@dito/bundle";
import { createDekFromMaterial, type Dek } from "@dito/crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { processPendingWaEvents, type TwinRuntimeDeps } from "./consumer.js";
import { performNotepadEdit } from "./dashboard-acts.js";
import { RECEIPTS } from "./grammar.js";
import { DRAFTING_DEFINITION } from "./runs/shipped-conversations.js";
import { NOTEPAD_PART, NOTEPAD_RECIPE } from "./rep-notepad.js";
import { createSendLockWriter, CONSERVATIVE_DEV_PACING } from "./send-lock/writer.js";
import {
  resetAndMigrate,
  withClient,
  TEST_AUDIT_HMAC_KEY,
  TEST_DATABASE_URL,
} from "./testing/db.js";
import { newExecutionPool } from "./testing/execution-pool.js";
import { fakeEmbedder } from "./testing/fake-embedder.js";
import { insertWaEvent } from "./testing/seam-fixtures.js";
import {
  closeScriptedModels,
  scriptedModel,
  systemOf,
  type Script,
  type ScriptedTurn,
} from "./testing/scripted-model.js";
import { isThreadTurn, threadTurns } from "./testing/thread-script.js";
import { SETTLE_IMMEDIATELY } from "./testing/settle.js";
import { removeTmpDir } from "./testing/tmp.js";
import { EVIDENCE_PARAMETER } from "./thread/evidence.js";
import { WRITE_NOTEPAD_TOOL } from "./thread/notepad.js";

// Every scripted model this suite opened is closed with it (#328).
afterAll(closeScriptedModels);

const SELF_CHAT = "5215550000@s.whatsapp.net";
const CUSTOMER = "5215550001@s.whatsapp.net";
const ZONE = "America/Monterrey";

/** The rule the rep teaches, in every case here. */
const RULE = "con la Sra. Garza siempre de usted";

/** One connection source for every execution this suite runs. */
const executionPool = newExecutionPool();

let tmp: string;
let pool: pg.Pool;

beforeAll(async () => {
  await resetAndMigrate();
  tmp = mkdtempSync(join(tmpdir(), "dito-notepad-int-"));
  pool = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 4 });
});

afterAll(async () => {
  await pool.end();
  removeTmpDir(tmp);
});

interface Twin {
  readonly twinId: string;
  readonly dek: Dek;
  readonly bundle: Bundle;
}

function freshTwin(): Twin {
  const twinId = randomUUID();
  const dek = createDekFromMaterial(randomBytes(32));
  return { twinId, dek, bundle: createBundle(join(tmp, `${twinId}.bundle`), dek) };
}

function depsFor(
  client: pg.Client,
  twin: Twin,
  script: Script = [],
): { deps: TwinRuntimeDeps; requests: Record<string, unknown>[] } {
  const { harness, requests } = scriptedModel(script);
  return {
    requests,
    deps: {
      db: client,
      executionPool,
      harness,
      bundle: twin.bundle,
      dek: twin.dek,
      twinId: twin.twinId,
      selfChatJid: SELF_CHAT,
      // This file is not about batching (see testing/settle.ts).
      ...SETTLE_IMMEDIATELY,
      drafting: { model: "claude-sonnet-5" },
      embedder: fakeEmbedder(),
      sendLock: createSendLockWriter({ pool, hmacKey: TEST_AUDIT_HMAC_KEY }),
      hmacKey: TEST_AUDIT_HMAC_KEY,
      timeZone: ZONE,
    },
  };
}

/** The writer's config: the hard allowlist and conservative pacing. */
async function seedSendConfig(client: pg.Client, twinId: string): Promise<void> {
  await client.query(
    "INSERT INTO send_allowlist (twin_id, destination_jid) VALUES ($1, $2)",
    [twinId, CUSTOMER],
  );
  await client.query(
    "INSERT INTO pacing_thresholds (twin_id, max_sends_per_hour, min_seconds_between_sends) VALUES ($1, $2, $3)",
    [
      twinId,
      CONSERVATIVE_DEV_PACING.maxSendsPerHour,
      CONSERVATIVE_DEV_PACING.minSecondsBetweenSends,
    ],
  );
}

/** One rep message in their own thread — a teach, pointing at nothing. */
async function repWrites(
  client: pg.Client,
  twin: Twin,
  text: string,
): Promise<string> {
  return insertWaEvent(client, twin.dek, {
    twinId: twin.twinId,
    chatJid: SELF_CHAT,
    senderJid: SELF_CHAT,
    fromMe: true,
    messageId: `3EB0-REP-${randomUUID().slice(0, 8)}`,
    text,
    occurredAt: new Date("2026-09-20T17:00:00Z"),
  });
}

/** One customer message, which is what a drafting execution wakes on. */
async function customerWrites(
  client: pg.Client,
  twin: Twin,
  text: string,
): Promise<string> {
  return insertWaEvent(client, twin.dek, {
    twinId: twin.twinId,
    chatJid: CUSTOMER,
    senderJid: CUSTOMER,
    fromMe: false,
    messageId: `3EB0-CUS-${randomUUID().slice(0, 8)}`,
    text,
    pushName: "Sra. Garza",
    occurredAt: new Date("2026-09-20T17:10:00Z"),
  });
}

/** Every twin post in the thread, decrypted, in the order the rep sees them. */
async function twinPosts(
  client: pg.Client,
  twin: Twin,
): Promise<{ kind: string; text: string }[]> {
  const res = await client.query<{ kind: string; content_enc: Buffer }>(
    `SELECT n.kind, n.content_enc
       FROM notices n
       JOIN send_commands sc ON sc.payload_ref = 'notice:' || n.id
      WHERE n.twin_id = $1 AND sc.twin_id = $1
      ORDER BY sc.created_at, sc.id`,
    [twin.twinId],
  );
  return res.rows.map((row) => ({
    kind: row.kind,
    text: Buffer.from(twin.dek.decrypt(row.content_enc)).toString("utf8"),
  }));
}

/** The parts of every composed post this twin wrote, oldest first. */
async function postParts(
  client: pg.Client,
  twin: Twin,
): Promise<{ kind: string; text?: string }[][]> {
  const res = await client.query<{ parts_enc: Buffer | null }>(
    "SELECT parts_enc FROM posts WHERE twin_id = $1 ORDER BY posted_at, id",
    [twin.twinId],
  );
  return res.rows.map((row) =>
    row.parts_enc === null
      ? []
      : (JSON.parse(
          Buffer.from(twin.dek.decrypt(row.parts_enc)).toString("utf8"),
        ) as { kind: string; text?: string }[]),
  );
}

async function disposition(client: pg.Client, eventId: string): Promise<string> {
  const res = await client.query<{ disposition: string }>(
    "SELECT disposition FROM wa_event_processing WHERE event_id = $1",
    [eventId],
  );
  return res.rows[0]!.disposition;
}

/** Every execution this twin ran, oldest first — the rep-side record. */
async function executions(
  client: pg.Client,
  twinId: string,
): Promise<{ disposition: string; trigger_kind: string }[]> {
  const res = await client.query<{ disposition: string; trigger_kind: string }>(
    "SELECT disposition, trigger_kind FROM executions WHERE twin_id = $1 ORDER BY started_at",
    [twinId],
  );
  return res.rows;
}

/** Every entry this twin left on the rep chain, oldest first. */
async function chainEntries(
  client: pg.Client,
  twinId: string,
): Promise<{ caller: string; action: string; outcome: string }[]> {
  const res = await client.query<{
    caller: string;
    action: string;
    outcome: string;
  }>(
    `SELECT caller, action, outcome FROM audit_chain
      WHERE ref LIKE '%' || $1 || '%' ORDER BY id`,
    [twinId],
  );
  return res.rows;
}

/** What the model was shown, as one string, for the turn this predicate picks. */
function promptOf(
  requests: readonly Record<string, unknown>[],
  wanted: (prompt: string) => boolean,
): string {
  const found = requests
    .map((request) => JSON.stringify(request["messages"]))
    .find((prompt) => wanted(prompt));
  if (found === undefined) throw new Error("no such turn reached the model");
  return found;
}

describe("«con la Sra. Garza siempre de usted» writes the notebook (AC 2)", () => {
  it("writes the version from the rep's own event, folds the receipt into the reply, and leaves the seam's own marker", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await seedSendConfig(client, twin.twinId);

      // NO VERB AND NO QUOTED POST. The rep states a rule the way they would
      // to a colleague, and the execution reads what it means (ADR-0037's
      // axis: a misread here costs one sentence, so it is prose).
      const eventId = await repWrites(client, twin, RULE);
      const { deps } = depsFor(
        client,
        twin,
        threadTurns({
          tool: WRITE_NOTEPAD_TOOL,
          evidence: eventId,
          input: { text: RULE, based_on: 0 },
          answer: "Va.",
        }),
      );
      await processPendingWaEvents(deps);

      // THE VERSION, IN THE BUNDLE, PINNED TO THE RAW PLANE-DELIVERED
      // MESSAGE — never to model output, never to anything the call carried.
      const version = twin.bundle.readNotepad();
      expect(version?.version).toBe(1);
      expect(version?.text).toBe(RULE);
      expect(version?.evidenceRef).toBe(eventId);

      // ONE POST PER TURN: the receipt code owns, then the twin's own words.
      expect(await twinPosts(client, twin)).toEqual([
        { kind: "answer", text: `✳️ ${RECEIPTS.notepadWritten}\n\nVa.` },
      ]);
      // ...AND THE POST CARRIES IT AS A `receipt` PART, which is what the
      // dashboard renders without the frame (#220; ADR-0044).
      expect(await postParts(client, twin)).toEqual([
        [
          { kind: "receipt", text: RECEIPTS.notepadWritten },
          { kind: "prose", text: "Va." },
        ],
      ]);

      // THE SEAM'S OWN WORD FOR WHAT HAPPENED TO THE MESSAGE: the twin read
      // it and replied. The notebook is twin-side memory the seam has no
      // vocabulary for, so no marker was added and no migration is owed.
      expect(await disposition(client, eventId)).toBe("answered");
      expect(await executions(client, twin.twinId)).toEqual([
        { disposition: "acted", trigger_kind: "twin_thread_message" },
      ]);
      // ONE CHAIN ENTRY, the execution's own: the write's record is the
      // execution, and the rep's own text never reaches the chain (ADR-0020).
      expect(await chainEntries(client, twin.twinId)).toEqual([
        { caller: "execution", action: "execution", outcome: "acted" },
      ]);
      expect(
        (await verifyAuditChainInDb(client, TEST_AUDIT_HMAC_KEY)).valid,
      ).toBe(true);
      twin.bundle.close();
    });
  });

  it("posts the receipt alone when the twin taught and had nothing to say", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await seedSendConfig(client, twin.twinId);
      const eventId = await repWrites(client, twin, RULE);
      const { deps } = depsFor(
        client,
        twin,
        threadTurns({
          tool: WRITE_NOTEPAD_TOOL,
          evidence: eventId,
          input: { text: RULE, based_on: 0 },
        }),
      );
      await processPendingWaEvents(deps);

      // A rep who teaches a rule is owed the line saying it landed, whether
      // or not the twin had anything else to say — the dismissal's own rule.
      expect(await twinPosts(client, twin)).toEqual([
        { kind: "answer", text: `✳️ ${RECEIPTS.notepadWritten}` },
      ]);
      expect(twin.bundle.readNotepad()?.text).toBe(RULE);
      expect(await disposition(client, eventId)).toBe("answered");
      twin.bundle.close();
    });
  });

  it("refuses an evidence id that is not this turn's message, and writes nothing", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await seedSendConfig(client, twin.twinId);
      // An earlier message of the rep's own — the nearest miss there is, and
      // still not the message this execution was created for.
      const earlier = await repWrites(client, twin, "buen día");
      await processPendingWaEvents(
        depsFor(client, twin, threadTurns({ answer: "Buen día." })).deps,
      );
      await repWrites(client, twin, RULE);

      const { deps, requests } = depsFor(client, twin, [
        {
          toolCall: {
            name: WRITE_NOTEPAD_TOOL,
            input: { [EVIDENCE_PARAMETER]: earlier, text: RULE, based_on: 0 },
          },
        },
        { text: "No pude anotarlo." },
      ]);
      await processPendingWaEvents(deps);

      // NOTHING WAS WRITTEN. The gate compares the cited id with this
      // execution's trigger, so the rep's own earlier message fails it
      // exactly as a customer's would (ADR-0013; `evidence.ts`).
      expect(twin.bundle.readNotepad()).toBeUndefined();
      // ...and the model was told why, in words it can relay.
      expect(
        promptOf(requests, (prompt) =>
          prompt.includes("this act needs the id of the rep's own message"),
        ),
      ).toContain("Only the message you were shown as theirs this turn");
      // NO RECEIPT: a refused write has nothing to acknowledge, so the rep
      // reads the twin's own sentence and no line of code's.
      const posts = await twinPosts(client, twin);
      expect(posts.at(-1)?.text).toContain("No pude anotarlo.");
      for (const post of posts) {
        expect(post.text).not.toContain(RECEIPTS.notepadWritten);
      }
      twin.bundle.close();
    });
  });
});

describe("a write past the cap consolidates rather than dropping a rule (AC 3)", () => {
  it("refuses with the cap and the text that still stands, then takes the consolidated retry", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await seedSendConfig(client, twin.twinId);

      // What the rep taught a month ago and what they are teaching now: the
      // second write is the WHOLE notebook and it does not fit.
      const standing = "firmo «saludos, Diego»";
      twin.bundle.writeNotepad({
        text: standing,
        writtenAt: "2026-09-01T17:00:00.000Z",
        executionId: randomUUID(),
        evidenceRef: randomUUID(),
      });

      const eventId = await repWrites(client, twin, RULE);
      const tooLong = `${standing}. ${"y ".repeat(NOTEPAD_CAP)}`;
      const consolidated = `${standing}; ${RULE}`;
      const { deps, requests } = depsFor(client, twin, [
        {
          toolCall: {
            name: WRITE_NOTEPAD_TOOL,
            input: { [EVIDENCE_PARAMETER]: eventId, text: tooLong, based_on: 1 },
          },
        },
        {
          toolCall: {
            name: WRITE_NOTEPAD_TOOL,
            input: { [EVIDENCE_PARAMETER]: eventId, text: consolidated, based_on: 1 },
          },
        },
        { text: "Va." },
      ]);
      await processPendingWaEvents(deps);

      // THE REFUSAL THE MODEL CONSOLIDATES AGAINST: the cap, what it
      // weighed, and the text that still stands — so the rewrite is made
      // from what the rep really taught (spec #258).
      const refusal = promptOf(requests, (prompt) =>
        prompt.includes("over_cap"),
      );
      expect(refusal).toContain(`\\"cap\\":${String(NOTEPAD_CAP)}`);
      expect(refusal).toContain(
        `\\"chars_attempted\\":${String([...tooLong].length)}`,
      );
      expect(refusal).toContain(standing);

      // NOTHING WAS DROPPED. Two versions stand, the newest is the
      // consolidation, and the one the rep taught first is still in the
      // store — which is what append-only is for (ADR-0033; #41 Q5).
      expect(twin.bundle.readNotepad()).toMatchObject({
        version: 2,
        text: consolidated,
      });
      expect(consolidated).toContain(standing);
      expect(await twinPosts(client, twin)).toEqual([
        { kind: "answer", text: `✳️ ${RECEIPTS.notepadWritten}\n\nVa.` },
      ]);
      expect(await disposition(client, eventId)).toBe("answered");
      twin.bundle.close();
    });
  });

  it("refuses a write based on a version another turn has replaced, and takes the rewrite", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await seedSendConfig(client, twin.twinId);
      const standing = "firmo «saludos, Diego»";
      twin.bundle.writeNotepad({
        text: standing,
        writtenAt: "2026-09-01T17:00:00.000Z",
        executionId: randomUUID(),
        evidenceRef: randomUUID(),
      });

      const eventId = await repWrites(client, twin, RULE);
      // ANOTHER TURN WRITES WHILE THIS ONE IS THINKING. Several executions of
      // one pass run at once over the one bundle (`lanes.ts`), so this is the
      // race made deterministic: the write lands from inside the scripted
      // wire, which is exactly the window between this execution being shown
      // the notebook and its tool call arriving.
      let interfered = false;
      const rival = "no le hablo de usted a Torres";
      const { deps, requests } = depsFor(client, twin, (prompt) => {
        if (!interfered && isThreadTurn(prompt)) {
          interfered = true;
          twin.bundle.writeNotepad({
            text: `${standing}; ${rival}`,
            writtenAt: "2026-09-20T17:00:30.000Z",
            executionId: randomUUID(),
            evidenceRef: randomUUID(),
          });
        }
        return [
          {
            toolCall: {
              name: WRITE_NOTEPAD_TOOL,
              // Composed against what this run was SHOWN, which the write
              // above has replaced: landing it would drop the rival rule.
              input: {
                [EVIDENCE_PARAMETER]: eventId,
                text: `${standing}; ${RULE}`,
                based_on: 1,
              },
            },
          },
          {
            toolCall: {
              name: WRITE_NOTEPAD_TOOL,
              input: {
                [EVIDENCE_PARAMETER]: eventId,
                text: `${standing}; ${rival}; ${RULE}`,
                based_on: 2,
              },
            },
          },
          { text: "Va." },
        ];
      });
      await processPendingWaEvents(deps);

      // THE REFUSAL NAMES WHY AND HANDS BACK WHAT STANDS, in the same shape
      // the cap's refusal takes — one protocol for the model to learn.
      const refusal = promptOf(requests, (p) => p.includes("stale"));
      expect(refusal).toContain(rival);
      expect(refusal).toContain("Rewrite it whole");

      // NOTHING WAS DROPPED: the rewrite carries both turns' rules, and the
      // rival version is still a version of its own beneath it.
      expect(twin.bundle.readNotepad()).toMatchObject({
        version: 3,
        text: `${standing}; ${rival}; ${RULE}`,
      });
      expect(await twinPosts(client, twin)).toEqual([
        { kind: "answer", text: `✳️ ${RECEIPTS.notepadWritten}\n\nVa.` },
      ]);
      twin.bundle.close();
    });
  });

  it("refuses a second call that cites the same replaced version — a refusal unlocks nothing (Codex r2)", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await seedSendConfig(client, twin.twinId);
      const standing = "firmo «saludos, Diego»";
      twin.bundle.writeNotepad({
        text: standing,
        writtenAt: "2026-09-01T17:00:00.000Z",
        executionId: randomUUID(),
        evidenceRef: randomUUID(),
      });
      const eventId = await repWrites(client, twin, RULE);

      // THE BYPASS THIS CLOSES. The SDK runs every tool call of ONE model
      // response, so two writes can arrive with no model turn between them —
      // and both were composed against the version the turn was SHOWN. A
      // runtime that remembered "the version last handed back" would let the
      // second through on a refusal the first one earned. The token rides on
      // the CALL, so it cannot travel backwards like that: both cite 1, the
      // store is at 2, and both are refused.
      let interfered = false;
      const rival = "no le hablo de usted a Torres";
      const { deps, requests } = depsFor(client, twin, (prompt) => {
        if (!interfered && isThreadTurn(prompt)) {
          interfered = true;
          twin.bundle.writeNotepad({
            text: `${standing}; ${rival}`,
            writtenAt: "2026-09-20T17:00:30.000Z",
            executionId: randomUUID(),
            evidenceRef: randomUUID(),
          });
        }
        return [
          {
            toolCall: {
              name: WRITE_NOTEPAD_TOOL,
              input: {
                [EVIDENCE_PARAMETER]: eventId,
                text: `${standing}; ${RULE}`,
                based_on: 1,
              },
            },
          },
          {
            toolCall: {
              name: WRITE_NOTEPAD_TOOL,
              input: {
                [EVIDENCE_PARAMETER]: eventId,
                text: `${standing}; ${RULE} y nada más`,
                based_on: 1,
              },
            },
          },
          { text: "No pude anotarlo." },
        ];
      });
      await processPendingWaEvents(deps);

      // NEITHER LANDED, and the rival's rule still stands untouched.
      expect(twin.bundle.readNotepad()).toMatchObject({
        version: 2,
        text: `${standing}; ${rival}`,
      });
      expect(
        requests
          .map((request) => JSON.stringify(request["messages"]))
          .filter((prompt) => prompt.includes("stale")).length,
      ).toBeGreaterThan(0);
      // ...and no receipt was posted for a write that did not happen.
      for (const post of await twinPosts(client, twin)) {
        expect(post.text).not.toContain(RECEIPTS.notepadWritten);
      }
      twin.bundle.close();
    });
  });

  it("refuses a forged acknowledgment of the write it would not take (#276)", async () => {
    // THE FAILURE THIS CLOSES (Codex round 3 on PR #272): after an `over_cap`
    // refusal, «Listo, lo anoté» with no period and «¡Listo, lo anoté!» are
    // the receipt's phrase too, and the rep would read the twin's own
    // acknowledgment of a write that never happened.
    await withClient(async (client) => {
      const twin = freshTwin();
      await seedSendConfig(client, twin.twinId);
      const eventId = await repWrites(client, twin, RULE);
      const tooLong = "y ".repeat(NOTEPAD_CAP);
      const { deps, requests } = depsFor(client, twin, [
        {
          toolCall: {
            name: WRITE_NOTEPAD_TOOL,
            input: { [EVIDENCE_PARAMETER]: eventId, text: tooLong, based_on: 0 },
          },
        },
        { text: "Listo, lo anoté" },
        { text: "¡Listo, lo anoté!" },
        { text: "No me cupo, dime cuál de las dos reglas dejo." },
      ]);
      await processPendingWaEvents(deps);

      // BOTH VARIANTS REFUSED, by the sentence the renderer owns.
      expect(
        promptOf(requests, (prompt) => prompt.includes(RECEIPTS.notepadWritten)),
      ).toContain("did not happen");
      // NOTHING WAS WRITTEN, and what the rep reads is the twin's own words
      // about the refusal rather than an acknowledgment of a write.
      expect(twin.bundle.readNotepad()).toBeUndefined();
      expect(await twinPosts(client, twin)).toEqual([
        {
          kind: "answer",
          text: "✳️ No me cupo, dime cuál de las dos reglas dejo.",
        },
      ]);
      twin.bundle.close();
    });
  });

  it("spends no act on the refused write, so a rep who teaches and then dismisses still gets one act", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await seedSendConfig(client, twin.twinId);
      const eventId = await repWrites(client, twin, RULE);

      // TWO SUCCESSFUL WRITES IN ONE TURN ARE STILL ONE ACT. The over-cap
      // call above costs the turn nothing; a second call that really writes
      // is refused by the one-act rule, exactly as a second dismissal is.
      const { deps, requests } = depsFor(client, twin, [
        {
          toolCall: {
            name: WRITE_NOTEPAD_TOOL,
            input: { [EVIDENCE_PARAMETER]: eventId, text: RULE, based_on: 0 },
          },
        },
        {
          toolCall: {
            name: WRITE_NOTEPAD_TOOL,
            input: { [EVIDENCE_PARAMETER]: eventId, text: "otra cosa entera", based_on: 1 },
          },
        },
        { text: "Va." },
      ]);
      await processPendingWaEvents(deps);

      expect(
        promptOf(requests, (prompt) =>
          prompt.includes("you have already acted this turn"),
        ),
      ).toContain(WRITE_NOTEPAD_TOOL);
      expect(twin.bundle.readNotepad()).toMatchObject({
        version: 1,
        text: RULE,
      });
      twin.bundle.close();
    });
  });
});

describe("the notebook reaches the model, last, and only where it belongs (AC 4)", () => {
  it("a customer's draft is written with the rep's rule in front of the model, default line first", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await seedSendConfig(client, twin.twinId);
      twin.bundle.writeNotepad({
        text: RULE,
        writtenAt: "2026-09-20T17:00:00.000Z",
        executionId: randomUUID(),
        evidenceRef: randomUUID(),
      });

      await customerWrites(client, twin, "¿me aparta 20 bultos?");
      const { deps, requests } = depsFor(client, twin, [
        { toolCall: { name: "create_draft", input: { text: "Claro, se los aparto." } } },
        { text: "done" },
      ]);
      await processPendingWaEvents(deps);

      // USER STORY 1, AT THE SEAM: the rule the rep taught in their own
      // thread reaches the turn that writes to their customer.
      const prompt = promptOf(requests, (p) => p.includes("## the turn"));
      expect(prompt).toContain(`## ${NOTEPAD_PART}`);
      expect(prompt).toContain("The rep's language and register");
      expect(prompt).toContain(RULE);
      // THE DEFAULT LINE COMES FIRST, and the notebook comes after the turn,
      // followed only by the twin's own notes (spec #258; ticket #322; the
      // definition tests pin the order in the spec, and this is the rendered
      // prompt the model really read).
      expect(prompt.indexOf("The rep's language and register")).toBeLessThan(
        prompt.indexOf(RULE),
      );
      expect(prompt.lastIndexOf(`## ${NOTEPAD_PART}`)).toBeGreaterThan(
        prompt.lastIndexOf("## the turn"),
      );
      twin.bundle.close();
    });
  });

  it("a thread turn reads the same notebook, and a drafting turn cannot write one", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await seedSendConfig(client, twin.twinId);
      twin.bundle.writeNotepad({
        text: RULE,
        writtenAt: "2026-09-20T17:00:00.000Z",
        executionId: randomUUID(),
        evidenceRef: randomUUID(),
      });

      await repWrites(client, twin, "¿qué le quedé de ver a la Sra. Garza?");
      const { deps, requests } = depsFor(client, twin, (prompt) =>
        isThreadTurn(prompt)
          ? [
              {
                toolCall: {
                  name: "search_memory",
                  input: { about: "Garza", counterparty: null },
                },
              },
              { text: "Nada pendiente." },
            ]
          : ([{ text: "done" }] as ScriptedTurn[]),
      );
      await processPendingWaEvents(deps);

      // THE THREAD IS TOLD IT IN EVERY WAKE (ticket #322): the turn's own
      // message, read from the store as the wake is built, never the system
      // text fixed when the session opened.
      const turn = requests.find((request) =>
        isThreadTurn(JSON.stringify(request["messages"])),
      );
      expect(turn).toBeDefined();
      expect(systemOf(turn)).not.toContain(`## ${NOTEPAD_PART}`);
      const wake = promptOf(requests, isThreadTurn);
      expect(wake).toContain(`## ${NOTEPAD_PART}`);
      expect(wake).toContain(RULE);

      // THE TOOL IS THE THREAD'S AND NOBODY ELSE'S (spec #258; #258's own
      // evidence sentence): a customer-triggered drafting execution is not
      // handed it at all, so there is nothing for a poisoned message to aim
      // — and no evidence it could ever cite if there were.
      const [draftStep] = DRAFTING_DEFINITION.steps;
      if (draftStep?.kind !== "agent") throw new Error("drafting is one agent step");
      expect(draftStep.tools).not.toContain(WRITE_NOTEPAD_TOOL);
      expect(draftStep.recipes?.at(-2)).toBe(NOTEPAD_RECIPE);
      twin.bundle.close();
    });
  });
});

describe("a save on Mi libreta reaches the next draft (ticket #264)", () => {
  /** «Guardar», as the local API performs it for one seat of this twin. */
  async function savedOnTheDashboard(
    client: pg.Client,
    twin: Twin,
    text: string,
  ): Promise<void> {
    const saved = await performNotepadEdit(
      {
        db: client,
        dek: twin.dek,
        twinId: twin.twinId,
        hmacKey: TEST_AUDIT_HMAC_KEY,
        bundle: twin.bundle,
      },
      { companyId: randomUUID(), seatId: randomUUID() },
      { text, basedOn: twin.bundle.readNotepad()?.version ?? 0 },
    );
    expect(saved).toEqual({ outcome: "performed" });
  }

  /** One customer message drafted by a scripted run; what the model was shown. */
  async function nextDraftPrompt(client: pg.Client, twin: Twin): Promise<string> {
    await customerWrites(client, twin, "¿me aparta 20 bultos?");
    const { deps, requests } = depsFor(client, twin, [
      { toolCall: { name: "create_draft", input: { text: "Claro, se los aparto." } } },
      { text: "done" },
    ]);
    await processPendingWaEvents(deps);
    return promptOf(requests, (p) => p.includes("## the turn"));
  }

  it("renders the saved text last, after a rule the thread taught", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await seedSendConfig(client, twin.twinId);
      twin.bundle.writeNotepad({
        text: RULE,
        writtenAt: "2026-09-20T17:00:00.000Z",
        executionId: randomUUID(),
        evidenceRef: randomUUID(),
      });
      const edited = "con la Sra. Garza siempre de tú, y firmo «Mauricio»";
      await savedOnTheDashboard(client, twin, edited);

      const prompt = await nextDraftPrompt(client, twin);
      // THE NEW VERSION IS THE CURRENT ONE, and the notebook is still the last
      // part of the turn with the default line first.
      expect(prompt).toContain(edited);
      expect(prompt).not.toContain(RULE);
      expect(prompt.indexOf("The rep's language and register")).toBeLessThan(
        prompt.indexOf(edited),
      );
      expect(prompt.lastIndexOf(`## ${NOTEPAD_PART}`)).toBeGreaterThan(
        prompt.lastIndexOf("## the turn"),
      );
      twin.bundle.close();
    });
  });

  it("renders the default line alone after an empty save", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await seedSendConfig(client, twin.twinId);
      twin.bundle.writeNotepad({
        text: RULE,
        writtenAt: "2026-09-20T17:00:00.000Z",
        executionId: randomUUID(),
        evidenceRef: randomUUID(),
      });
      await savedOnTheDashboard(client, twin, "");

      const prompt = await nextDraftPrompt(client, twin);
      // THE DELETE: the notebook part is still rendered, last, and holds the
      // Dito default and nothing the rep wrote.
      expect(prompt).toContain(`## ${NOTEPAD_PART}`);
      expect(prompt).toContain("The rep's language and register");
      expect(prompt).not.toContain(RULE);
      expect(prompt).not.toContain("rep_notepad");
      twin.bundle.close();
    });
  });
});
