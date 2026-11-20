/**
 * THE REP ACTS IN PROSE, AT THE POSTGRES SEAM (ticket #174; spec #171
 * decisions 18, 19, 20 and 22; ADR-0003 as amended, ADR-0013 as amended,
 * ADR-0037 as amended).
 *
 * This is the ticket's acceptance criteria as one file: the rep writes what
 * they would write to a colleague, an execution reads it, a gated tool acts,
 * and a receipt the twin cannot fake tells them what happened.
 *
 * WHY IT IS A SEPARATE HOME FROM `thread.int.test.ts`. That file is the
 * thread as a CONVERSATION — routing, citations, silence, the poison cases —
 * and it is the mint for the thread's own CI corpus. This one is the thread
 * as an ACTOR, and the two questions have different fixtures: an act needs a
 * post of the twin's for the rep to point at, and a conversation does not.
 * The claims that belong to each retired keyword's own suite stayed there —
 * the correction's window and idempotence in `corrections.int.test.ts`, the
 * question's expiry in `questions.int.test.ts`, terminality and the tap in
 * `matcher.int.test.ts` — because those are aperture-side and seam-side
 * claims that #174 must not change, and re-proving them here would be a
 * second copy.
 *
 * The pre-agreed seam (spec #18; spec #171's Testing Decisions): `wa_events`
 * fixtures in with real DEK-encrypted payloads; out the other side the
 * dismissal row, the retraction, the answered question, the receipt notice
 * with its `system_send`, the rep-side `executions` row with its
 * disposition, the entry on `public.audit_chain` and the event's processing
 * marker. Real Postgres, real envelope crypto, real SQLCipher (ADR-0028);
 * the model is scripted at the model boundary and CI never calls one.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyAuditChainInDb } from "@dito/audit";
import { createBundle, type Bundle } from "@dito/bundle";
import { createDekFromMaterial, type Dek } from "@dito/crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { processPendingWaEvents, type TwinRuntimeDeps } from "./consumer.js";
import { createSendLockWriter, CONSERVATIVE_DEV_PACING } from "./send-lock/writer.js";
import {
  resetAndMigrate,
  withClient,
  TEST_AUDIT_HMAC_KEY,
  TEST_DATABASE_URL,
} from "./testing/db.js";
import { newExecutionPool } from "./testing/execution-pool.js";
import { fakeEmbedder } from "./testing/fake-embedder.js";
import { insertWaEvent, simulateExecutorPost } from "./testing/seam-fixtures.js";
import {
  closeScriptedModels,
  qaSilenceTurns,
  scriptedModel,
  type Script,
} from "./testing/scripted-model.js";
import { refusedToTheEnd, threadTurns } from "./testing/thread-script.js";
import { SETTLE_IMMEDIATELY } from "./testing/settle.js";
import { removeTmpDir } from "./testing/tmp.js";
import { DISMISS_DRAFT_TOOL } from "./thread/acts.js";

// Every scripted model this suite opened is closed with it (#328).
afterAll(closeScriptedModels);

const SELF_CHAT = "5215550000@s.whatsapp.net";
const CUSTOMER = "5215550001@s.whatsapp.net";
const ZONE = "America/Monterrey";

/** One connection source for every execution this suite runs. */
const executionPool = newExecutionPool();

let tmp: string;
let pool: pg.Pool;

beforeAll(async () => {
  await resetAndMigrate();
  tmp = mkdtempSync(join(tmpdir(), "dito-thread-acts-int-"));
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

function depsFor(client: pg.Client, twin: Twin, script: Script = []): TwinRuntimeDeps {
  const { harness } = scriptedModel(script);
  return {
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

/**
 * A posted, waiting draft: the draft with its frozen Borrador, its
 * `system_send`, and the executor's record of which message carries it —
 * which is the mapping every quoted-id resolution rests on.
 */
async function postedDraft(
  client: pg.Client,
  twin: Twin,
  body = "claro, se las mando el jueves temprano",
): Promise<{ draftId: string; waMessageId: string }> {
  const post = `✳️ *Borrador — para Sra. Garza*\n\n«${body}»`;
  const draft = await client.query<{ id: string }>(
    `INSERT INTO drafts (twin_id, destination, content_enc, post_enc)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [
      twin.twinId,
      CUSTOMER,
      Buffer.from(twin.dek.encrypt(Buffer.from(body, "utf8"))),
      Buffer.from(twin.dek.encrypt(Buffer.from(post, "utf8"))),
    ],
  );
  const draftId = draft.rows[0]!.id;
  const command = await client.query<{ id: string }>(
    `INSERT INTO send_commands (twin_id, send_class, destination, payload_ref, draft_id)
     VALUES ($1, 'system_send', $2, $3, $4) RETURNING id`,
    [twin.twinId, SELF_CHAT, `draft:${draftId}`, draftId],
  );
  const waMessageId = `WAMID-DRAFT-${randomUUID().slice(0, 8)}`;
  await simulateExecutorPost(client, {
    commandId: command.rows[0]!.id,
    twinId: twin.twinId,
    waMessageId,
  });
  return { draftId, waMessageId };
}

/** One rep message in their own thread, quoting a post of the twin's. */
async function repWrites(
  client: pg.Client,
  twin: Twin,
  text: string,
  quotedMessageId?: string,
): Promise<string> {
  return insertWaEvent(client, twin.dek, {
    twinId: twin.twinId,
    chatJid: SELF_CHAT,
    senderJid: SELF_CHAT,
    fromMe: true,
    messageId: `3EB0-REP-${randomUUID().slice(0, 8)}`,
    text,
    ...(quotedMessageId === undefined ? {} : { quotedMessageId }),
    occurredAt: new Date("2026-08-27T09:00:00Z"),
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

describe("«así no» discards the draft the rep quoted (AC 2, AC 4, AC 5)", () => {
  it("writes the dismissal from the rep's own event, posts the receipt, and marks the act's word", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await seedSendConfig(client, twin.twinId);
      const { draftId, waMessageId } = await postedDraft(client, twin);

      // THE REP SAYS IT HOWEVER THEY SAY IT. There is no phrase to learn:
      // this sentence reaches the execution because it is not one of the
      // two surviving keywords, and the execution reads what it means.
      const eventId = await repWrites(client, twin, "así no, mejor no le contestes", waMessageId);
      await processPendingWaEvents(
        depsFor(
          client,
          twin,
          threadTurns({ tool: DISMISS_DRAFT_TOOL, evidence: eventId }),
        ),
      );

      // The anti-tap row, pinned to the raw plane-delivered message — never
      // to model output, and never to anything the call carried.
      const dismissals = await client.query<{
        draft_id: string;
        source_event_id: string;
      }>(
        "SELECT draft_id, source_event_id FROM draft_dismissals WHERE draft_id = $1",
        [draftId],
      );
      expect(dismissals.rows).toEqual([
        { draft_id: draftId, source_event_id: eventId },
      ]);

      // THE RECEIPT, RENDERED FROM THE TOOL'S RESULT and byte-identical to
      // the ack the keyword posted — the rep reads exactly what they read
      // before this ticket.
      expect(await twinPosts(client, twin)).toEqual([
        { kind: "dismissal_ack", text: "✳️ Descartado" },
      ]);
      expect(await disposition(client, eventId)).toBe("dismissed");

      // ONE EXECUTION ROW, and its disposition is the runtime's own word:
      // a tool performed an effect, so `acted` — which the model's prose
      // could not have produced (`runner.test.ts`).
      expect(await executions(client, twin.twinId)).toEqual([
        { disposition: "acted", trigger_kind: "twin_thread_message" },
      ]);
      // ...AND ONE CHAIN ENTRY, the execution's own. A successful dismissal
      // owes no per-act entry — `draft_dismissals` holds it
      // (`audit-coverage.ts`'s own ruling) — so this is exactly one.
      expect(await chainEntries(client, twin.twinId)).toEqual([
        { caller: "execution", action: "execution", outcome: "acted" },
      ]);
      expect(
        (await verifyAuditChainInDb(client, TEST_AUDIT_HMAC_KEY)).valid,
      ).toBe(true);
      twin.bundle.close();
    });
  });

  it("costs three rounds and no search, and the run records what it cost (#195)", async () => {
    // WHAT THIS PROVES, AND WHAT IT DOES NOT. The script cannot prove a
    // model would take the short path — the instructions are what ask for
    // that («when they ask you to act»), and the rig is where it is read.
    // What it proves is that the short path is LEGAL and costs what it
    // should: the guard lets an act turn answer with no citation and no
    // search (its "the turn acted" arm), the runtime adds no round of its
    // own, and the whole turn is act, reply, stop.
    //
    // WHY IT IS MEASURED HERE. The slice-5a boundary watched a dismissal
    // cost SIX rounds and fifty-three thousand tokens live, and the
    // comparison the next boundary makes needs this side of it recorded
    // from the same place: the execution row the runtime wrote.
    await withClient(async (client) => {
      const twin = freshTwin();
      await seedSendConfig(client, twin.twinId);
      const { waMessageId } = await postedDraft(client, twin);
      const eventId = await repWrites(client, twin, "así no", waMessageId);

      const { harness, requests } = scriptedModel(
        threadTurns({
          tool: DISMISS_DRAFT_TOOL,
          evidence: eventId,
          answer: "Ya no va.",
        }),
      );
      await processPendingWaEvents({
        ...depsFor(client, twin),
        harness,
      });

      // NO SEARCH. The rep pointed at the draft; nothing in their history
      // could add to that, and the guard does not make the turn buy one.
      const called = requests.flatMap((request) =>
        JSON.stringify(request["messages"]).match(/"name":"(\w+)"/gu) ?? [],
      );
      expect(called.join(" ")).not.toContain("search_memory");

      const [run] = await client.query<{
        iterations: number;
        tokens_input: number;
        tokens_output: number;
        disposition: string;
      }>(
        "SELECT iterations, tokens_input, tokens_output, disposition FROM executions WHERE twin_id = $1",
        [twin.twinId],
      ).then((res) => res.rows);
      expect(run!.disposition).toBe("acted");
      expect(run!.iterations).toBeLessThanOrEqual(3);
      // RECORDED FOR THE BOUNDARY, not gated: the scripted wire's tokens are
      // the fixture's and only the ROUNDS are comparable to the rig's.
      console.log(
        `[#195] act turn (dismissal): iterations=${String(run!.iterations)} ` +
          `tokens_in=${String(run!.tokens_input)} tokens_out=${String(run!.tokens_output)} ` +
          `model_requests=${String(requests.length)} searches=0 (slice 5a live: 6 iterations, 53k tokens)`,
      );
      twin.bundle.close();
    });
  });

  it("acts on the id it READ OUT OF THE PROMPT, which is the only way a real model could", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await seedSendConfig(client, twin.twinId);
      const { draftId, waMessageId } = await postedDraft(client, twin);
      const eventId = await repWrites(client, twin, "así no", waMessageId);

      // EVERY OTHER CASE IN THIS FILE HANDS THE SCRIPT THE ID, and that is
      // exactly what a scripted test can do and a model cannot: the tools
      // refuse any id but this execution's trigger, so a prompt that never
      // showed it would refuse every act in production while every one of
      // those cases stayed green. This scripts a RULE instead — it reads
      // the id out of the prompt the way a model would have to — so what
      // is being proven is that the id is THERE.
      await processPendingWaEvents(
        depsFor(client, twin, (prompt) => {
          // The id's SHAPE is deliberately not assumed here: it is whatever
          // the seam mints for a `wa_events` row, and a model reading the
          // prompt would take the whole token too.
          const read = /\[This message's id[^:]*: ([^\]]+)\]/u.exec(prompt);
          if (read === null) {
            throw new Error(
              "the prompt showed the model no message id, so no rep act could ever be authorized in production (ticket #174)",
            );
          }
          return threadTurns({
            tool: DISMISS_DRAFT_TOOL,
            evidence: read[1]!,
          });
        }),
      );

      // The id the model read is the id the tool accepted: the row it wrote
      // names the rep's own event.
      expect(
        (
          await client.query<{ source_event_id: string }>(
            "SELECT source_event_id FROM draft_dismissals WHERE draft_id = $1",
            [draftId],
          )
        ).rows,
      ).toEqual([{ source_event_id: eventId }]);
      expect(await disposition(client, eventId)).toBe("dismissed");
      twin.bundle.close();
    });
  });

  it("folds the receipt into the reply when the twin also has something to say", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await seedSendConfig(client, twin.twinId);
      const { waMessageId } = await postedDraft(client, twin);

      const eventId = await repWrites(client, twin, "no va, ya le contesté yo", waMessageId);
      await processPendingWaEvents(
        depsFor(
          client,
          twin,
          threadTurns({
            tool: DISMISS_DRAFT_TOOL,
            evidence: eventId,
            answer: "Va, ya no le escribo.",
          }),
        ),
      );

      // ONE POST PER TURN (spec #171 decision 22): what the twin DID, then
      // what it says about it. The rep reads one message rather than two,
      // and the first line is the only one that is not the twin's voice.
      expect(await twinPosts(client, twin)).toEqual([
        { kind: "answer", text: "✳️ Descartado\n\nVa, ya no le escribo." },
      ]);
      expect(await disposition(client, eventId)).toBe("dismissed");
      twin.bundle.close();
    });
  });

  it("renders NOTHING when the prose claims the effect and no tool was called (AC 5)", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await seedSendConfig(client, twin.twinId);
      const { draftId, waMessageId } = await postedDraft(client, twin);

      // THE CASE THE WHOLE RECEIPT DESIGN EXISTS FOR. The model says it
      // discarded the draft and calls nothing. A twin that composed its own
      // acknowledgement would have told the rep the draft was gone; a
      // receipt rendered from a tool's result cannot, because there is no
      // result.
      const eventId = await repWrites(client, twin, "así no", waMessageId);
      await processPendingWaEvents(
        depsFor(client, twin, [
          // The search is the model's own doing and is what makes a reply
          // with no sources legal here: nothing was ACTED, so the reply
          // rests on the rep's history like any other answer (`guard.ts`).
          {
            toolCall: {
              name: "search_memory",
              input: { about: "borrador", counterparty: null },
            },
          },
          { text: "Listo, lo descarté." },
        ]),
      );

      // The draft is LIVE: nothing was written.
      expect(
        (
          await client.query("SELECT draft_id FROM draft_dismissals WHERE draft_id = $1", [
            draftId,
          ])
        ).rows,
      ).toEqual([]);
      // The post carries the model's own sentence and no receipt beside it.
      expect(await twinPosts(client, twin)).toEqual([
        { kind: "answer", text: "✳️ Listo, lo descarté." },
      ]);
      // ...and the record says `answered`, not `acted`: the disposition is
      // drawn from what the tools DID, so prose cannot reach the word.
      expect(await executions(client, twin.twinId)).toEqual([
        { disposition: "answered", trigger_kind: "twin_thread_message" },
      ]);
      expect(await disposition(client, eventId)).toBe("answered");

      // AND THE DRAFT IS STILL TAPPABLE, which is the half that matters to
      // the rep: a claimed dismissal must not quietly kill a live draft.
      const vaId = await repWrites(client, twin, "va", waMessageId);
      await processPendingWaEvents(depsFor(client, twin));
      expect(await disposition(client, vaId)).toBe("affirmed");
      twin.bundle.close();
    });
  });

  it("rolls the act back when the run fails, and leaves only its trace (Codex r1)", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await seedSendConfig(client, twin.twinId);
      const { draftId, waMessageId } = await postedDraft(client, twin);

      // THE ONE OUTCOME THIS SURFACE MUST NOT HAVE: an act with no receipt
      // beside it. The tools write INSIDE the run, and a run can still end
      // `failed` afterwards — here the model dismisses the draft and then ends
      // on a line the guard refuses every time, until the turn's budget runs
      // out. So the effects roll back to the savepoint and the trace does not.
      const eventId = await repWrites(client, twin, "así no", waMessageId);
      await processPendingWaEvents(
        depsFor(client, twin, [
          {
            toolCall: {
              name: DISMISS_DRAFT_TOOL,
              input: { evidence: eventId },
            },
          },
          ...refusedToTheEnd("*Descartado*"),
        ]),
      );

      // The dismissal is GONE: the rep's draft is still there, and still
      // tappable, which is what they would expect of a turn that failed.
      expect(
        (
          await client.query("SELECT draft_id FROM draft_dismissals WHERE draft_id = $1", [
            draftId,
          ])
        ).rows,
      ).toEqual([]);
      // Nothing was said either, and the event is CONSUMED under the
      // failure's own word (ticket #240), so the rep's message is not put
      // back in front of the model on the next poll.
      expect(await twinPosts(client, twin)).toEqual([]);
      expect(await disposition(client, eventId)).toBe("execution_failed");

      // ...AND THE TRACE SURVIVED THE ROLLBACK (ADR-0020). Exactly one
      // record and exactly one entry, committed together: a failed run is
      // as visible in the chain as an acted one, which is the whole reason
      // the catch is inside the transaction.
      expect(await executions(client, twin.twinId)).toEqual([
        { disposition: "failed", trigger_kind: "twin_thread_message" },
      ]);
      expect(await chainEntries(client, twin.twinId)).toEqual([
        { caller: "execution", action: "execution", outcome: "failed" },
      ]);
      expect(
        (await verifyAuditChainInDb(client, TEST_AUDIT_HMAC_KEY)).valid,
      ).toBe(true);
      twin.bundle.close();
    });
  });

  it("refuses prose that would read as a receipt code did not render (Codex r1)", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await seedSendConfig(client, twin.twinId);
      const { draftId, waMessageId } = await postedDraft(client, twin);

      // THE BYTES ARE THE PROBLEM, NOT THE DISPOSITION. «Descartado»
      // written as prose renders `✳️ Descartado` — byte-identical to the
      // receipt a real dismissal posts — so the record saying `answered`
      // buys the rep nothing: they read the same message either way. The
      // guard refuses it, the model is told why, and this script never writes
      // anything else, so the turn ends `failed` and posts nothing.
      await repWrites(client, twin, "así no", waMessageId);
      await processPendingWaEvents(
        depsFor(client, twin, [
          {
            toolCall: {
              name: "search_memory",
              input: { about: "borrador", counterparty: null },
            },
          },
          ...refusedToTheEnd("*Descartado*"),
        ]),
      );

      expect(await twinPosts(client, twin)).toEqual([]);
      expect(
        (
          await client.query("SELECT draft_id FROM draft_dismissals WHERE draft_id = $1", [
            draftId,
          ])
        ).rows,
      ).toEqual([]);
      twin.bundle.close();
    });
  });

  it("refuses a second act in the same message, and says which one it did", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await seedSendConfig(client, twin.twinId);
      const first = await postedDraft(client, twin);
      const second = await postedDraft(client, twin);

      // ONE ACT PER MESSAGE (spec #171 decision 19). The model calls the
      // tool twice; the second is refused by the tool layer, whatever it
      // was aimed at.
      const eventId = await repWrites(client, twin, "así no", first.waMessageId);
      await processPendingWaEvents(
        depsFor(client, twin, [
          { toolCall: { name: DISMISS_DRAFT_TOOL, input: { evidence: eventId } } },
          { toolCall: { name: DISMISS_DRAFT_TOOL, input: { evidence: eventId } } },
          { text: "" },
        ]),
      );

      // The quoted draft is discarded; nothing else moved. (Both calls
      // named the same target, because the target is what the rep QUOTED —
      // a second draft has no way into this turn at all.)
      expect(
        (
          await client.query<{ draft_id: string }>(
            "SELECT draft_id FROM draft_dismissals WHERE draft_id = ANY($1)",
            [[first.draftId, second.draftId]],
          )
        ).rows.map((row) => row.draft_id),
      ).toEqual([first.draftId]);
      expect(await disposition(client, eventId)).toBe("dismissed");
      twin.bundle.close();
    });
  });

  it("refuses an act whose evidence is another message of the rep's, at the seam (AC 2)", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await seedSendConfig(client, twin.twinId);
      const { draftId, waMessageId } = await postedDraft(client, twin);

      // A real, live, rep-authored message of this twin's — everything the
      // aperture's own verification asks for — and NOT this execution's
      // trigger. It is refused on the structural half of the gate, which is
      // the half the seam cannot weaken.
      const earlier = await repWrites(client, twin, "luego lo veo");
      await processPendingWaEvents(depsFor(client, twin, qaSilenceTurns()));

      const eventId = await repWrites(client, twin, "así no", waMessageId);
      await processPendingWaEvents(
        depsFor(client, twin, [
          {
            toolCall: {
              name: DISMISS_DRAFT_TOOL,
              input: { evidence: earlier },
            },
          },
          { text: "Perdón, ¿cuál borrador?" },
        ]),
      );

      expect(
        (
          await client.query("SELECT draft_id FROM draft_dismissals WHERE draft_id = $1", [
            draftId,
          ])
        ).rows,
      ).toEqual([]);
      // The reply posted and the record says `answered`: an act was
      // attempted and refused, so nothing was performed.
      expect(await disposition(client, eventId)).toBe("answered");
      expect(
        (await executions(client, twin.twinId)).map((row) => row.disposition),
      ).toEqual(["no-action", "answered"]);
      twin.bundle.close();
    });
  });

  it("refuses an act whose evidence is a message from a customer chat", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await seedSendConfig(client, twin.twinId);
      const { draftId, waMessageId } = await postedDraft(client, twin);

      // A customer's own message: rep-authored it is not, and this
      // execution's trigger it is not either. Both halves of the gate
      // refuse it, and the first one does so without a read.
      const customerEvent = await insertWaEvent(client, twin.dek, {
        twinId: twin.twinId,
        chatJid: CUSTOMER,
        senderJid: CUSTOMER,
        fromMe: false,
        messageId: `3EB0-CUST-${randomUUID().slice(0, 8)}`,
        text: "¿me las aparta?",
        pushName: "Sra. Garza",
        backfill: true,
      });

      const eventId = await repWrites(client, twin, "así no", waMessageId);
      await processPendingWaEvents(
        depsFor(client, twin, [
          {
            toolCall: {
              name: DISMISS_DRAFT_TOOL,
              input: { evidence: customerEvent },
            },
          },
          { text: "No pude, ¿me lo repites?" },
        ]),
      );

      expect(
        (
          await client.query("SELECT draft_id FROM draft_dismissals WHERE draft_id = $1", [
            draftId,
          ])
        ).rows,
      ).toEqual([]);
      expect(await disposition(client, eventId)).toBe("answered");
      twin.bundle.close();
    });
  });

  it("refuses an act on a draft the rep did not quote — the target is theirs to point at", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await seedSendConfig(client, twin.twinId);
      const { draftId } = await postedDraft(client, twin);

      // THE OTHER STRUCTURAL HALF (spec #171 decision 19): a tool acts on
      // the post the TRIGGER says the rep quoted, and the model has no
      // parameter to name a different one. Here the rep quoted nothing, so
      // there is no target at all — and the correct evidence does not help.
      const eventId = await repWrites(client, twin, "descarta el borrador de la Sra. Garza");
      await processPendingWaEvents(
        depsFor(
          client,
          twin,
          threadTurns({
            tool: DISMISS_DRAFT_TOOL,
            evidence: eventId,
            answer: "¿Cuál? Respóndeme citando el borrador.",
          }),
        ),
      );

      expect(
        (
          await client.query("SELECT draft_id FROM draft_dismissals WHERE draft_id = $1", [
            draftId,
          ])
        ).rows,
      ).toEqual([]);
      expect(await disposition(client, eventId)).toBe("answered");
      twin.bundle.close();
    });
  });

  it("refuses a dismissal of a draft the rep already sent, and the send stands", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await seedSendConfig(client, twin.twinId);
      const { draftId, waMessageId } = await postedDraft(client, twin);

      // The tap first — the keyword, resolved before any execution exists.
      const vaId = await repWrites(client, twin, "va", waMessageId);
      await processPendingWaEvents(depsFor(client, twin));
      expect(await disposition(client, vaId)).toBe("affirmed");

      // ...and then the rep changes their mind, too late. The state is
      // re-read from the rows rather than taken from the prompt: a tap can
      // land between the context's render and the tool's call.
      const eventId = await repWrites(client, twin, "no, ya no", waMessageId);
      await processPendingWaEvents(
        depsFor(
          client,
          twin,
          threadTurns({
            tool: DISMISS_DRAFT_TOOL,
            evidence: eventId,
            answer: "Ya se había ido.",
          }),
        ),
      );

      expect(
        (
          await client.query("SELECT draft_id FROM draft_dismissals WHERE draft_id = $1", [
            draftId,
          ])
        ).rows,
      ).toEqual([]);
      expect(
        (
          await client.query("SELECT id FROM taps WHERE draft_id = $1", [draftId])
        ).rows,
      ).toHaveLength(1);
      expect(await disposition(client, eventId)).toBe("answered");
      twin.bundle.close();
    });
  });
});
