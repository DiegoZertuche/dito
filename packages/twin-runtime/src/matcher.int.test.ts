/**
 * The quoted-reply affirmation matcher, tested across the Postgres seam —
 * the pre-agreed seam (spec #18): inject the rep's raw self-chat
 * `wa_events` fixtures (own-sent, quoted), assert what appears on the
 * other side — taps, customer_send commands, refusal notices, dispositions.
 * Real Postgres, real envelope crypto, real SQLCipher, the real send-lock
 * writer (#24).
 *
 * WHAT #174 CHANGED ABOUT THIS FILE, said up front because it is most of
 * the diff. The router now accepts TWO acts — a bare «va» quoted on a
 * draft, and a bare «si»/«sí»/«va» quoted on a binding question — and every
 * other rep message in the thread reaches the thread EXECUTION as prose
 * (spec #171 decision 18). So a case that used to end in `captured`
 * silence now runs an execution, and the two claims it makes have to be
 * made separately:
 *
 *   — THE KEYWORD DID NOT FIRE. No tap, no customer_send, no dismissal
 *     written by anything but a tool. This is what the file has always
 *     asserted and it is unchanged.
 *   — THE MESSAGE WAS NOT LOST. It reached the execution, which is scripted
 *     silent here (`qaSilenceTurns()`), so the marker is
 *     `deliberate_silence` rather than `captured`.
 *
 * Every case whose script is empty still has ZERO model involvement, which
 * is the property that matters for a keyword: the two survivors resolve
 * before any execution exists, so a model request in one of those tests
 * fails the scripted client loudly.
 *
 * THE DISMISSAL LEFT THIS FILE. «no va» is prose now and `dismiss_draft` is
 * where it lands — proven through the execution in `thread-acts.int.test.ts`
 * — so what stays here is the half that is still the matcher's: a «va» on a
 * dismissed draft is refused, terminally, exactly as before.
 *
 * The executor's half of the loop (posting the draft to the self-chat and
 * recording the posted message id) is simulated at the seam exactly as the
 * plane executes it — proven in Go (plane/executor): a send_executions row
 * plus the one finalizing UPDATE.
 *
 * Governing ADRs: 0005, 0006, 0023.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBundle, type Bundle } from "@dito/bundle";
import { createDekFromMaterial, type Dek } from "@dito/crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { processPendingWaEvents, type TwinRuntimeDeps } from "./consumer.js";
import { createSendLockWriter, CONSERVATIVE_DEV_PACING } from "./send-lock/writer.js";
import { removeTmpDir } from "./testing/tmp.js";
import { resetAndMigrate, withClient, TEST_DATABASE_URL } from "./testing/db.js";
import { fakeEmbedder } from "./testing/fake-embedder.js";
import { neverSendLock } from "./testing/never-writer.js";
import { insertWaEvent, simulateExecutorPost } from "./testing/seam-fixtures.js";
import {
  closeScriptedModels,
  qaSilenceTurns,
  scriptedModel,
  type ScriptedTurn,
} from "./testing/scripted-model.js";
import { threadTurns } from "./testing/thread-script.js";
import { DISMISS_DRAFT_TOOL } from "./thread/acts.js";
import { SETTLE_IMMEDIATELY } from "./testing/settle.js";
import { newExecutionPool } from "./testing/execution-pool.js";

// Every scripted model this suite opened is closed with it (#328).
afterAll(closeScriptedModels);

/** One connection source for every execution this suite runs (ticket #173). */
const executionPool = newExecutionPool();

const SELF_CHAT = "5215550000@s.whatsapp.net";
const CUSTOMER = "5215550001@s.whatsapp.net";
const DRAFT_MESSAGE_ID = "WAMID-DRAFT-1";

/**
 * ONE audit key for the whole file. The hash chain is global and
 * append-only (ADR-0020), so a fresh key per writer would make the second
 * refusal in the file unappendable — the tail would not authenticate. That
 * is the store working as designed; the fixture just has to hold a key the
 * way a deployment does.
 */
const AUDIT_HMAC_KEY = randomBytes(32);

let tmp: string;
let pool: pg.Pool;

beforeAll(async () => {
  await resetAndMigrate();
  tmp = mkdtempSync(join(tmpdir(), "dito-matcher-int-"));
  pool = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 4 });
});

afterAll(async () => {
  await pool.end();
  removeTmpDir(tmp);
});

function freshTwin(): { twinId: string; dek: Dek; bundle: Bundle } {
  const twinId = randomUUID();
  const dek = createDekFromMaterial(randomBytes(32));
  const bundle = createBundle(join(tmp, `${twinId}.bundle`), dek);
  return { twinId, dek, bundle };
}

/** Runtime deps with a real send-lock writer; the model is scripted empty — any request fails loudly. */
function depsFor(
  client: pg.Client,
  twin: { twinId: string; dek: Dek; bundle: Bundle },
  /**
   * Empty by default: a KEYWORD's tests script the model EMPTY on purpose,
   * so any model call fails the test loudly — the tap and the binding
   * confirmation resolve before any execution exists, and a verb must never
   * consult a model. A test whose message is PROSE supplies turns, because
   * prose reaches the execution by design (#174).
   */
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
    executionPool,
    sendLock: createSendLockWriter({ pool, hmacKey: AUDIT_HMAC_KEY }),
    // This suite already holds a key; the runtime's own chain writer takes
    // the SAME one, so one chain has one key (ADR-0020 — appending
    // verifies the tail under the supplied key, so two keys against one
    // chain is a hard failure rather than a mess to discover later).
    hmacKey: AUDIT_HMAC_KEY,
    embedder: fakeEmbedder(),
  };
}

/** Seeds the writer's config: the hard send-allowlist and conservative pacing (an unseeded twin cannot send). */
async function seedSendConfig(client: pg.Client, twinId: string): Promise<void> {
  await client.query(
    "INSERT INTO send_allowlist (twin_id, destination_jid) VALUES ($1, $2)",
    [twinId, CUSTOMER],
  );
  await client.query(
    "INSERT INTO pacing_thresholds (twin_id, max_sends_per_hour, min_seconds_between_sends) VALUES ($1, $2, $3)",
    [twinId, CONSERVATIVE_DEV_PACING.maxSendsPerHour, CONSERVATIVE_DEV_PACING.minSecondsBetweenSends],
  );
}

/**
 * A waiting draft with its system_send command, as the consumer emits them.
 *
 * `post_enc` IS THE FROZEN BORRADOR, and it is written here since #174
 * because the thread execution reads it: `readPostedPost` resolves a quoted
 * draft through it, and a draft with no frozen post has no words to show —
 * so a fixture that omitted it would leave `dismiss_draft` with no quoted
 * draft to act on, for a reason that has nothing to do with what the test
 * is about. `recordDraft` always writes both columns.
 */
async function insertWaitingDraft(
  client: pg.Client,
  twin: { twinId: string; dek: Dek },
  text: string,
): Promise<{ draftId: string; commandId: string }> {
  const draftRes = await client.query<{ id: string }>(
    `INSERT INTO drafts (twin_id, destination, content_enc, post_enc)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [
      twin.twinId,
      CUSTOMER,
      Buffer.from(twin.dek.encrypt(Buffer.from(text, "utf8"))),
      Buffer.from(
        twin.dek.encrypt(Buffer.from(`✳️ *Borrador — para Sra. Garza*\n\n«${text}»`, "utf8")),
      ),
    ],
  );
  const draftId = draftRes.rows[0]!.id;
  const cmdRes = await client.query<{ id: string }>(
    `INSERT INTO send_commands (twin_id, send_class, destination, payload_ref, draft_id)
     VALUES ($1, 'system_send', $2, $3, $4) RETURNING id`,
    [twin.twinId, SELF_CHAT, `draft:${draftId}`, draftId],
  );
  return { draftId, commandId: cmdRes.rows[0]!.id };
}

/** A posted, waiting draft: draft + system_send + the executor's recorded post. */
async function postedDraft(
  client: pg.Client,
  twin: { twinId: string; dek: Dek },
  text = "claro, se las mando el jueves temprano",
): Promise<{ draftId: string; commandId: string }> {
  const emitted = await insertWaitingDraft(client, twin, text);
  await simulateExecutorPost(client, {
    commandId: emitted.commandId,
    twinId: twin.twinId,
    waMessageId: DRAFT_MESSAGE_ID,
  });
  return emitted;
}

/** The rep's quoted self-chat reply as the plane captures it (raw, own-sent). */
function repReply(
  twinId: string,
  text: string,
  quotedMessageId: string | undefined,
  messageId: string,
) {
  return {
    twinId,
    chatJid: SELF_CHAT,
    senderJid: SELF_CHAT,
    fromMe: true,
    messageId,
    text,
    ...(quotedMessageId === undefined ? {} : { quotedMessageId }),
  };
}

async function disposition(client: pg.Client, eventId: string): Promise<string> {
  const res = await client.query<{ disposition: string }>(
    "SELECT disposition FROM wa_event_processing WHERE event_id = $1",
    [eventId],
  );
  return res.rows[0]!.disposition;
}

describe("quoted-reply affirmation matcher (ticket #25, slice AC 6)", () => {
  it("a rep quoted «va» resolving to a posted draft mints the tap and its customer_send in one writer transaction, disposition affirmed", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await seedSendConfig(client, twin.twinId);
      const { draftId } = await postedDraft(client, twin);

      const eventId = await insertWaEvent(client, twin.dek, {
        ...repReply(twin.twinId, "va", DRAFT_MESSAGE_ID, "3EB0-REP-1"),
      });

      const result = await processPendingWaEvents(depsFor(client, twin));
      expect(result.processed).toBe(1);

      // The tap: minted by the closed set's affirmation-matcher entry,
      // pinned to the raw plane-delivered event (ADR-0006).
      const taps = await client.query(
        "SELECT minter, draft_id, source_event_id FROM taps WHERE draft_id = $1",
        [draftId],
      );
      expect(taps.rows).toEqual([
        {
          minter: "affirmation_matcher",
          draft_id: draftId,
          source_event_id: eventId,
        },
      ]);

      // The customer_send: tap-bound, to the tapped draft's destination,
      // awaiting the executor.
      const commands = await client.query(
        `SELECT send_class, destination, payload_ref, draft_id, outcome
           FROM send_commands
          WHERE send_class = 'customer_send' AND draft_id = $1`,
        [draftId],
      );
      expect(commands.rows).toEqual([
        {
          send_class: "customer_send",
          destination: CUSTOMER,
          payload_ref: `draft:${draftId}`,
          draft_id: draftId,
          outcome: null,
        },
      ]);

      expect(await disposition(client, eventId)).toBe("affirmed");
    });
  });

  it("a non-affirmation quoted reply mints nothing and reaches the execution — no tap, no command, the draft stays waiting", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await seedSendConfig(client, twin.twinId);
      const { draftId } = await postedDraft(client, twin);

      const eventId = await insertWaEvent(client, twin.dek, {
        ...repReply(twin.twinId, "mejor dile que el viernes", DRAFT_MESSAGE_ID, "3EB0-REP-2"),
      });

      await processPendingWaEvents(depsFor(client, twin, qaSilenceTurns()));

      const taps = await client.query("SELECT id FROM taps WHERE draft_id = $1", [draftId]);
      expect(taps.rows).toEqual([]);
      const commands = await client.query(
        "SELECT id FROM send_commands WHERE send_class = 'customer_send' AND draft_id = $1",
        [draftId],
      );
      expect(commands.rows).toEqual([]);
      // IT USED TO BE `captured` — silence, and the twin never saw it
      // (#174). The keyword still does not fire, and the message now
      // reaches the execution, which is scripted silent here.
      expect(await disposition(client, eventId)).toBe("deliberate_silence");
    });
  });

  it("a double «va» resolves to one send via UNIQUE(draft_id): the loser refuses, posts «ya se envió» to the twin thread, and marks affirmation_refused", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await seedSendConfig(client, twin.twinId);
      const { draftId } = await postedDraft(client, twin);

      const firstId = await insertWaEvent(client, twin.dek, {
        ...repReply(twin.twinId, "va", DRAFT_MESSAGE_ID, "3EB0-REP-4A"),
      });
      const secondId = await insertWaEvent(client, twin.dek, {
        ...repReply(twin.twinId, "VA!", DRAFT_MESSAGE_ID, "3EB0-REP-4B"),
      });

      await processPendingWaEvents(depsFor(client, twin));

      // One tap, one customer_send — the constraint is the lock.
      const taps = await client.query(
        "SELECT source_event_id FROM taps WHERE draft_id = $1",
        [draftId],
      );
      expect(taps.rows).toEqual([{ source_event_id: firstId }]);
      const commands = await client.query(
        "SELECT id FROM send_commands WHERE send_class = 'customer_send' AND draft_id = $1",
        [draftId],
      );
      expect(commands.rows).toHaveLength(1);

      expect(await disposition(client, firstId)).toBe("affirmed");
      expect(await disposition(client, secondId)).toBe("affirmation_refused");

      // The loser's microcopy: a notice about the refused event, its
      // system_send to the twin thread, both atomic with the marker.
      const notices = await client.query<{
        id: string;
        kind: string;
        content_enc: Buffer;
      }>(
        "SELECT id, kind, content_enc FROM notices WHERE twin_id = $1 AND about_event_id = $2",
        [twin.twinId, secondId],
      );
      expect(notices.rows).toHaveLength(1);
      expect(notices.rows[0]!.kind).toBe("affirmation_refusal");
      expect(
        Buffer.from(twin.dek.decrypt(notices.rows[0]!.content_enc)).toString("utf8"),
      ).toBe("✳️ ya se envió");

      const noticeSends = await client.query(
        `SELECT destination, tap_id, outcome FROM send_commands
          WHERE send_class = 'system_send' AND payload_ref = $1`,
        [`notice:${notices.rows[0]!.id}`],
      );
      expect(noticeSends.rows).toEqual([
        { destination: SELF_CHAT, tap_id: null, outcome: null },
      ]);
    });
  });

  // The truly concurrent double affirmation — two mint attempts racing on
  // one draft — is resolved by UNIQUE(draft_id) at the writer and proven
  // in writer.int.test.ts («resolves a concurrent double affirmation to
  // exactly one send», ticket #24). This slice's runtime is the twin's one
  // consumer by construction (#23: sole bundle holder), so at the matcher
  // the race arrives as two sequential «va» events — the test above.

  it("an affirmation quoting an unresolvable message refuses loudly — no silent swallow of a real «va»", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await seedSendConfig(client, twin.twinId);
      const { draftId } = await postedDraft(client, twin);

      // The crash signature this guards: the executor posted a draft but
      // died before recording its message id — the rep's genuine «va»
      // quotes a message the mapping does not know. Consuming it as plain
      // 'captured' would swallow a real affirmation forever, with no
      // feedback and no evidence.
      const eventId = await insertWaEvent(client, twin.dek, {
        ...repReply(twin.twinId, "va", "WAMID-LOST-POST", "3EB0-REP-6"),
      });

      await processPendingWaEvents(depsFor(client, twin));

      // Mints nothing — but never silently.
      const taps = await client.query("SELECT id FROM taps WHERE draft_id = $1", [draftId]);
      expect(taps.rows).toEqual([]);
      expect(await disposition(client, eventId)).toBe("affirmation_refused");

      const notices = await client.query<{ id: string; content_enc: Buffer }>(
        "SELECT id, content_enc FROM notices WHERE twin_id = $1 AND about_event_id = $2",
        [twin.twinId, eventId],
      );
      expect(notices.rows).toHaveLength(1);
      expect(
        Buffer.from(twin.dek.decrypt(notices.rows[0]!.content_enc)).toString("utf8"),
      ).toBe("✳️ no se pudo enviar: no encontré el borrador de ese mensaje");
    });
  });

  it("a NON-affirmation quoting an unresolvable message reaches the execution with no quoted post — every rep message has a path (#174)", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await seedSendConfig(client, twin.twinId);
      await postedDraft(client, twin);

      const eventId = await insertWaEvent(client, twin.dek, {
        ...repReply(twin.twinId, "luego lo veo", "WAMID-SOME-NOTE", "3EB0-REP-7"),
      });

      // THE LAST REP MESSAGE WITH NO PATH, CLOSED (#173's recorded
      // remainder 4). It was `captured` — the rep quoted one of their own
      // notes and the twin never saw the message at all, so it could not
      // answer «¿y esto?» about it. It reaches the execution now, with no
      // quoted post beside it, which is the honest shape: there IS no post
      // of the twin's under that id.
      await processPendingWaEvents(depsFor(client, twin, qaSilenceTurns()));

      expect(await disposition(client, eventId)).toBe("deliberate_silence");
      // Still nothing SAID — an ordinary self-chat note is not
      // noise-notified, and the execution chose silence.
      const notices = await client.query(
        "SELECT id FROM notices WHERE twin_id = $1 AND about_event_id = $2",
        [twin.twinId, eventId],
      );
      expect(notices.rows).toEqual([]);
    });
  });

  it("the poisoned echo: a twin-authored post echoing back can never mint, even carrying a quoted draft reference and affirmation text", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await seedSendConfig(client, twin.twinId);
      const { draftId } = await postedDraft(client, twin);

      // The twin posted a second thread message; the executor recorded
      // its id — the origin tag.
      const second = await insertWaitingDraft(client, twin, "otro borrador");
      await simulateExecutorPost(client, {
        commandId: second.commandId,
        twinId: twin.twinId,
        waMessageId: "WAMID-TWIN-POST-2",
      });

      // Its echo comes back from_me in the self-chat — poisoned with a
      // quoted reference to the first draft's post and affirmation text.
      // Origin tagging is the only distinguisher from a rep reply, and it
      // must win: mint nothing.
      const echoId = await insertWaEvent(client, twin.dek, {
        ...repReply(twin.twinId, "va", DRAFT_MESSAGE_ID, "WAMID-TWIN-POST-2"),
      });

      await processPendingWaEvents(depsFor(client, twin));

      const taps = await client.query("SELECT id FROM taps WHERE draft_id = $1", [draftId]);
      expect(taps.rows).toEqual([]);
      expect(await disposition(client, echoId)).toBe("captured");
    });
  });

  it("a crash between the writer's mint and the marker replays as affirmed — no second mint, no spurious «ya se envió»", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await seedSendConfig(client, twin.twinId);
      const { draftId } = await postedDraft(client, twin);

      const eventId = await insertWaEvent(client, twin.dek, {
        ...repReply(twin.twinId, "va", DRAFT_MESSAGE_ID, "3EB0-REP-5"),
      });

      // The crash signature: the writer's transaction committed (tap +
      // customer_send exist), the processing marker did not.
      const written = await depsFor(client, twin).sendLock.requestCustomerSend({
        minter: "affirmation_matcher",
        draftId,
        sourceEventId: eventId,
      });
      expect(written.outcome).toBe("written");

      // The replay: the consumer picks the still-unmarked event up.
      await processPendingWaEvents(depsFor(client, twin));

      expect(await disposition(client, eventId)).toBe("affirmed");
      const taps = await client.query("SELECT id FROM taps WHERE draft_id = $1", [draftId]);
      expect(taps.rows).toHaveLength(1);
      const notices = await client.query(
        "SELECT id FROM notices WHERE twin_id = $1 AND about_event_id = $2",
        [twin.twinId, eventId],
      );
      expect(notices.rows).toEqual([]);
    });
  });

  it("a «va» on a dismissed draft is refused with the audit-chained 'dismissed' reason and its framed microcopy — a dead draft never sends", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await seedSendConfig(client, twin.twinId);
      const { draftId } = await postedDraft(client, twin);

      // THE DISMISSAL IS PROSE AND A TOOL NOW (#174), and this test is the
      // half that stayed the matcher's: whatever discarded the draft, a
      // later «va» is refused terminally through the writer's own taxonomy.
      // The rep says it in their own words and the execution acts.
      const dismissId = await insertWaEvent(client, twin.dek, {
        ...repReply(twin.twinId, "así no", DRAFT_MESSAGE_ID, "3EB0-REP-D2"),
      });
      await processPendingWaEvents(
        depsFor(
          client,
          twin,
          threadTurns({
            tool: DISMISS_DRAFT_TOOL,
            evidence: dismissId,
            answer: "Listo, no lo mando.",
          }),
        ),
      );
      expect(await disposition(client, dismissId)).toBe("dismissed");
      expect(
        (
          await client.query(
            "SELECT source_event_id FROM draft_dismissals WHERE draft_id = $1",
            [draftId],
          )
        ).rows,
      ).toEqual([{ source_event_id: dismissId }]);

      const vaId = await insertWaEvent(client, twin.dek, {
        ...repReply(twin.twinId, "va", DRAFT_MESSAGE_ID, "3EB0-REP-D3"),
      });
      // NO SCRIPT: a «va» is a keyword, so it resolves before any execution
      // exists and a model request here would fail loudly.
      await processPendingWaEvents(depsFor(client, twin));

      const taps = await client.query("SELECT id FROM taps WHERE draft_id = $1", [draftId]);
      expect(taps.rows).toEqual([]);
      const commands = await client.query(
        "SELECT id FROM send_commands WHERE send_class = 'customer_send' AND draft_id = $1",
        [draftId],
      );
      expect(commands.rows).toEqual([]);
      expect(await disposition(client, vaId)).toBe("affirmation_refused");

      const notices = await client.query<{ content_enc: Buffer }>(
        "SELECT content_enc FROM notices WHERE twin_id = $1 AND about_event_id = $2 AND kind = 'affirmation_refusal'",
        [twin.twinId, vaId],
      );
      expect(notices.rows).toHaveLength(1);
      expect(
        Buffer.from(twin.dek.decrypt(notices.rows[0]!.content_enc)).toString("utf8"),
      ).toBe("✳️ no se envió: este borrador ya fue descartado");

      // The refusal is audit-chained (ADR-0020, #24 contract).
      const audit = await client.query(
        "SELECT outcome FROM audit_chain WHERE ref = $1 ORDER BY id",
        [`twin:${twin.twinId} draft:${draftId}`],
      );
      expect(audit.rows).toEqual([{ outcome: "refused:dismissed" }]);
    });
  });

  it("the poisoned echo extended to a dismissal: a twin-authored post echoing back can never reach a tool", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await seedSendConfig(client, twin.twinId);
      const { draftId } = await postedDraft(client, twin);

      const second = await insertWaitingDraft(client, twin, "otro borrador");
      await simulateExecutorPost(client, {
        commandId: second.commandId,
        twinId: twin.twinId,
        waMessageId: "WAMID-TWIN-POST-3",
      });

      // The echo of a twin post, poisoned with a quoted draft reference
      // and dismissal text: the origin tag must win. It wins EARLIER than
      // any tool — the echo check runs above the routing split, so this
      // event never becomes a `twin_input` and never creates an execution,
      // which is why the model is scripted empty and would fail loudly.
      const echoId = await insertWaEvent(client, twin.dek, {
        ...repReply(twin.twinId, "no va", DRAFT_MESSAGE_ID, "WAMID-TWIN-POST-3"),
      });

      await processPendingWaEvents(depsFor(client, twin));

      const dismissals = await client.query(
        "SELECT draft_id FROM draft_dismissals WHERE draft_id = $1",
        [draftId],
      );
      expect(dismissals.rows).toEqual([]);
      expect(await disposition(client, echoId)).toBe("captured");
    });
  });

  it("a «no va» quoting an unresolvable message dismisses nothing — there is no draft under that id to discard", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await seedSendConfig(client, twin.twinId);
      const { draftId } = await postedDraft(client, twin);

      // Unlike a swallowed «va» (which would strand a send the rep
      // believes released), a dismissal that cannot resolve leaves the
      // draft waiting — exactly what silence means («ahorita no»). The
      // message reaches the execution, whose tool has no quoted draft to
      // act on and refuses; the model relays.
      const eventId = await insertWaEvent(client, twin.dek, {
        ...repReply(twin.twinId, "no va", "WAMID-LOST-POST-2", "3EB0-REP-D8"),
      });

      await processPendingWaEvents(
        depsFor(
          client,
          twin,
          threadTurns({
            tool: DISMISS_DRAFT_TOOL,
            evidence: eventId,
            answer: "No encuentro ese borrador, ¿cuál es?",
          }),
        ),
      );

      const dismissals = await client.query(
        "SELECT draft_id FROM draft_dismissals WHERE draft_id = $1",
        [draftId],
      );
      expect(dismissals.rows).toEqual([]);
      // A REFUSED ACT WITH NO WORD OF ITS OWN marks `answered`: the reply
      // posted, and what the rep learns is the sentence the twin wrote.
      expect(await disposition(client, eventId)).toBe("answered");
    });
  });

  it("a dismissal-adjacent content reply («no va mañana») reaches the execution — the twin can finally answer it (#174)", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await seedSendConfig(client, twin.twinId);
      const { draftId } = await postedDraft(client, twin);

      // IT USED TO MINT NOTHING AND SAY NOTHING. «no va mañana» is a
      // revision — "the revision loop is out of scope" — so the draft
      // waited forever and the rep was never told why. The keyword still
      // does not fire; what changed is that the sentence now reaches the
      // twin, which is the whole of spec #171's problem statement.
      const eventId = await insertWaEvent(client, twin.dek, {
        ...repReply(twin.twinId, "no va mañana", DRAFT_MESSAGE_ID, "3EB0-REP-D9"),
      });

      await processPendingWaEvents(depsFor(client, twin, qaSilenceTurns()));

      const dismissals = await client.query(
        "SELECT draft_id FROM draft_dismissals WHERE draft_id = $1",
        [draftId],
      );
      expect(dismissals.rows).toEqual([]);
      const taps = await client.query("SELECT id FROM taps WHERE draft_id = $1", [draftId]);
      expect(taps.rows).toEqual([]);
      expect(await disposition(client, eventId)).toBe("deliberate_silence");
    });
  });

  it("silence keeps meaning «ahorita no»: an unanswered draft just waits — repeated passes mint no nag, no re-push, nothing", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await seedSendConfig(client, twin.twinId);
      const { draftId } = await postedDraft(client, twin);

      // The rep says nothing. The runtime keeps polling.
      await processPendingWaEvents(depsFor(client, twin));
      await processPendingWaEvents(depsFor(client, twin));
      await processPendingWaEvents(depsFor(client, twin));

      // Still waiting: no tap, no dismissal — and no new twin post of any
      // kind beyond the draft's own original system_send.
      const taps = await client.query("SELECT id FROM taps WHERE draft_id = $1", [draftId]);
      expect(taps.rows).toEqual([]);
      const dismissals = await client.query(
        "SELECT draft_id FROM draft_dismissals WHERE draft_id = $1",
        [draftId],
      );
      expect(dismissals.rows).toEqual([]);
      const commands = await client.query(
        "SELECT id FROM send_commands WHERE twin_id = $1",
        [twin.twinId],
      );
      expect(commands.rows).toHaveLength(1); // only the draft post's own system_send
      const notices = await client.query(
        "SELECT id FROM notices WHERE twin_id = $1",
        [twin.twinId],
      );
      expect(notices.rows).toEqual([]);
    });
  });

  it("an UNQUOTED «va» never mints a tap — the matcher binds only to quoted replies, and at #35 the bare word is twin input, not a verb", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await seedSendConfig(client, twin.twinId);
      const { draftId } = await postedDraft(client, twin);

      const eventId = await insertWaEvent(client, twin.dek, {
        ...repReply(twin.twinId, "va", undefined, "3EB0-REP-3"),
      });

      // Routing changed under this event at ticket #35: an unquoted text in
      // the twin thread is now a question for the twin, so it reaches the
      // Q&A call instead of stopping at `captured`. The safety property is
      // unchanged and is what this test guards: a bare «va» typed without
      // quoting anything mints nothing, whatever the Q&A then does with
      // it. Affirmation is a quoted-reply verb, structurally; it cannot be
      // typed into existence. (The other direction — the Q&A running to a
      // real ANSWER and still minting nothing — is pinned in
      // qa-safety.int.test.ts against a poisoned corpus.)
      await processPendingWaEvents(depsFor(client, twin, qaSilenceTurns()));

      const taps = await client.query("SELECT id FROM taps WHERE draft_id = $1", [draftId]);
      expect(taps.rows).toEqual([]);
      const sends = await client.query(
        "SELECT 1 FROM send_commands WHERE twin_id = $1 AND send_class = 'customer_send'",
        [twin.twinId],
      );
      expect(sends.rows).toEqual([]);
      expect(await disposition(client, eventId)).toBe("deliberate_silence");
    });
  });
});

/**
 * The grammar pass at the seam (ticket #49; spec #48 grilling decision 3;
 * CONTRACTED at #174).
 *
 * The property under test is the FAIL-SAFE DIRECTION, adversarially and in
 * both directions: the accepted set is a function of the quoted post's
 * kind, so a question's yes-word must be inert on a draft — no tap, no
 * send_command, no send — and the draft must still be tappable afterwards,
 * because "mints nothing" and "kills the draft" are different failures and
 * only one of them is safe.
 *
 * WHAT «INERT» MEANS AFTER #174. It means the KEYWORD does not fire, and it
 * no longer means silence: a «si» quoted on a draft reaches the thread
 * execution as prose, which is right — the rep said something and the twin
 * can ask what they meant. So each case scripts the execution silent and
 * asserts the two halves separately.
 */
describe("verbs by post kind: a question's yes never reaches a draft (ticket #49)", () => {
  it.each(["si", "s\u00ed", "S\u00cd", "si\u0301", "\u00a1si!", "si."])(
    "a quoted %j on a DRAFT post mints nothing and the draft keeps waiting",
    async (yes) => {
      await withClient(async (client) => {
        const twin = freshTwin();
        await seedSendConfig(client, twin.twinId);
        const posted = `WAMID-DRAFT-SI-${randomUUID()}`;
        const emitted = await insertWaitingDraft(client, twin, "borrador");
        await simulateExecutorPost(client, {
          commandId: emitted.commandId,
          twinId: twin.twinId,
          waMessageId: posted,
        });

        const siId = await insertWaEvent(client, twin.dek, {
          ...repReply(twin.twinId, yes, posted, `3EB0-SI-${randomUUID()}`),
        });

        // The strongest form of "mints nothing": the writer THROWS if it
        // is reached at all, so a tap cannot be written and then asserted
        // away. The execution is scripted SILENT — the word reaches it as
        // prose now (#174), and what must never happen is a tap.
        const deps = {
          ...depsFor(client, twin, qaSilenceTurns()),
          sendLock: neverSendLock(),
        };
        await processPendingWaEvents(deps);

        expect(await disposition(client, siId)).toBe("deliberate_silence");
        const taps = await client.query("SELECT id FROM taps WHERE draft_id = $1", [
          emitted.draftId,
        ]);
        expect(taps.rows).toEqual([]);
        const commands = await client.query(
          "SELECT id FROM send_commands WHERE send_class = 'customer_send' AND draft_id = $1",
          [emitted.draftId],
        );
        expect(commands.rows).toEqual([]);
        // Nothing said, either: an unrecognized word is not an error.
        const notices = await client.query(
          "SELECT id FROM notices WHERE twin_id = $1",
          [twin.twinId],
        );
        expect(notices.rows).toEqual([]);
        // And the draft is still LIVE — it kept waiting, it was not
        // consumed. The rep's «va» still sends.
        const vaId = await insertWaEvent(client, twin.dek, {
          ...repReply(twin.twinId, "va", posted, `3EB0-VA-${randomUUID()}`),
        });
        await processPendingWaEvents(depsFor(client, twin));
        expect(await disposition(client, vaId)).toBe("affirmed");
        const afterTaps = await client.query(
          "SELECT source_event_id FROM taps WHERE draft_id = $1",
          [emitted.draftId],
        );
        expect(afterTaps.rows).toEqual([{ source_event_id: vaId }]);
      });
    },
  );

  it.each(["no", "NO", "\u00a1no!", "no.", "as\u00ed no"])(
    "a quoted %j is prose now: it mints nothing and reaches the execution (#174)",
    async (no) => {
      await withClient(async (client) => {
        const twin = freshTwin();
        await seedSendConfig(client, twin.twinId);
        const posted = `WAMID-DRAFT-NO-${randomUUID()}`;
        const emitted = await insertWaitingDraft(client, twin, "borrador");
        await simulateExecutorPost(client, {
          commandId: emitted.commandId,
          twinId: twin.twinId,
          waMessageId: posted,
        });

        const noId = await insertWaEvent(client, twin.dek, {
          ...repReply(twin.twinId, no, posted, `3EB0-NO-${randomUUID()}`),
        });
        // THE KEYWORD IS GONE AND THE SEND LOCK STILL THROWS IF REACHED:
        // whatever the execution does with the sentence, nothing here may
        // become a tap. What the execution DOES with it — the dismissal,
        // its receipt, and the terminality that follows — is proven through
        // the tool in `thread-acts.int.test.ts`.
        const deps = {
          ...depsFor(client, twin, qaSilenceTurns()),
          sendLock: neverSendLock(),
        };
        await processPendingWaEvents(deps);

        expect(await disposition(client, noId)).toBe("deliberate_silence");
        // NOTHING WAS DISCARDED BY THE ROUTER. The row exists only when a
        // tool writes it, and this execution called none.
        const dismissals = await client.query(
          "SELECT draft_id FROM draft_dismissals WHERE draft_id = $1",
          [emitted.draftId],
        );
        expect(dismissals.rows).toEqual([]);
        // ...and the draft is still LIVE: the rep's «va» still sends.
        const vaId = await insertWaEvent(client, twin.dek, {
          ...repReply(twin.twinId, "va", posted, `3EB0-NO-VA-${randomUUID()}`),
        });
        await processPendingWaEvents(depsFor(client, twin));
        expect(await disposition(client, vaId)).toBe("affirmed");
      });
    },
  );

  it.each([
    "\u00bfno?",
    "no?",
    "no mañana",
    "mejor no",
    "\u00bfsi?",
    "si mañana",
  ])(
    "the bare-phrase rule is unchanged: %j mints nothing and reaches the execution",
    async (text) => {
      await withClient(async (client) => {
        const twin = freshTwin();
        await seedSendConfig(client, twin.twinId);
        const posted = `WAMID-DRAFT-BARE-${randomUUID()}`;
        const emitted = await insertWaitingDraft(client, twin, "borrador");
        await simulateExecutorPost(client, {
          commandId: emitted.commandId,
          twinId: twin.twinId,
          waMessageId: posted,
        });

        const eventId = await insertWaEvent(client, twin.dek, {
          ...repReply(twin.twinId, text, posted, `3EB0-BARE-${randomUUID()}`),
        });
        const deps = {
          ...depsFor(client, twin, qaSilenceTurns()),
          sendLock: neverSendLock(),
        };
        await processPendingWaEvents(deps);

        expect(await disposition(client, eventId)).toBe("deliberate_silence");
        const dismissals = await client.query(
          "SELECT draft_id FROM draft_dismissals WHERE draft_id = $1",
          [emitted.draftId],
        );
        expect(dismissals.rows).toEqual([]);
        const notices = await client.query(
          "SELECT id FROM notices WHERE twin_id = $1",
          [twin.twinId],
        );
        expect(notices.rows).toEqual([]);
      });
    },
  );

  it("the poisoned echo extended to the new verbs: a twin post echoing back «si» or «no» can never mint (ticket #49 AC 7)", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await seedSendConfig(client, twin.twinId);
      const { draftId } = await postedDraft(client, twin);

      // Two twin posts whose ids the executor recorded — the origin tag.
      for (const [i, text] of ["si", "no"].entries()) {
        const twinPost = await insertWaitingDraft(client, twin, `otro ${i}`);
        const echoId = `WAMID-TWIN-POST-49-${i}`;
        await simulateExecutorPost(client, {
          commandId: twinPost.commandId,
          twinId: twin.twinId,
          waMessageId: echoId,
        });
        // Its echo, poisoned with a quoted draft reference and the NEW
        // verb text. Origin tagging is the distinguisher and must win.
        const eventId = await insertWaEvent(client, twin.dek, {
          ...repReply(twin.twinId, text, DRAFT_MESSAGE_ID, echoId),
        });
        // Scripted EMPTY on purpose: the echo check runs above the routing
        // split, so a tagged event never becomes a `twin_input` and never
        // creates an execution. A model request here would fail loudly.
        const deps = { ...depsFor(client, twin), sendLock: neverSendLock() };
        await processPendingWaEvents(deps);
        expect(await disposition(client, eventId)).toBe("captured");
      }

      const taps = await client.query("SELECT id FROM taps WHERE draft_id = $1", [draftId]);
      expect(taps.rows).toEqual([]);
      const dismissals = await client.query(
        "SELECT draft_id FROM draft_dismissals WHERE draft_id = $1",
        [draftId],
      );
      expect(dismissals.rows).toEqual([]);
    });
  });

  it("the poisoned echo extended to the OTHER direction: the twin's own send, recorded in a customer chat, can never mint (ticket #63)", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await seedSendConfig(client, twin.twinId);
      const { draftId } = await postedDraft(client, twin);

      // Ticket #63 gave the executor a second thing to write: a delivered
      // customer_send is recorded onto the seam as a `from_me` message on
      // the DESTINATION chat, so the twin can see what it said. That is
      // twin-authored content entering the seam, which is the one thing
      // this file exists to prove can never come back as a rep act.
      //
      // Worse than the real shape on purpose: the recorded send here carries
      // every verb the grammar knows AND a quoted id that resolves to a real
      // posted draft. The production write-back carries no quoted id at all
      // (the executor sends a plain Conversation), so this is a message the
      // system cannot actually produce — which is exactly what a poison
      // fixture should be.
      for (const [i, text] of ["va", "no va", "si", "no", "1 no"].entries()) {
        const eventId = await insertWaEvent(client, twin.dek, {
          twinId: twin.twinId,
          chatJid: CUSTOMER,
          senderJid: SELF_CHAT,
          fromMe: true,
          messageId: `WAMID-OWN-SEND-63-${i}`,
          text,
          quotedMessageId: DRAFT_MESSAGE_ID,
        });
        const deps = { ...depsFor(client, twin), sendLock: neverSendLock() };
        await processPendingWaEvents(deps);
        // Routing stops at the twin thread's edge: own-sent traffic in a
        // CUSTOMER chat is bundle material only — never a verb, never a
        // question to the twin, and never a draft to answer it.
        expect(await disposition(client, eventId)).toBe("captured");
      }

      const taps = await client.query("SELECT id FROM taps WHERE draft_id = $1", [draftId]);
      expect(taps.rows).toEqual([]);
      const dismissals = await client.query(
        "SELECT draft_id FROM draft_dismissals WHERE draft_id = $1",
        [draftId],
      );
      expect(dismissals.rows).toEqual([]);
      const notices = await client.query(
        "SELECT id FROM notices WHERE twin_id = $1",
        [twin.twinId],
      );
      expect(notices.rows).toEqual([]);
    });
  });

  it("a «si» quoting an unresolvable message notifies nothing — only a lost DRAFT post can strand a send the rep believes released", async () => {
    await withClient(async (client) => {
      const twin = freshTwin();
      await seedSendConfig(client, twin.twinId);
      await postedDraft(client, twin);

      // The refusal microcopy names a missing draft post, and drafts take
      // «va» alone — so «si» on an id that resolves to nothing must not
      // claim a send failed. A lost QUESTION post leaves the chat
      // provisional, which is what an unanswered question already means.
      const eventId = await insertWaEvent(client, twin.dek, {
        ...repReply(twin.twinId, "si", "WAMID-LOST-POST-49", `3EB0-LOST-${randomUUID()}`),
      });
      const deps = {
        ...depsFor(client, twin, qaSilenceTurns()),
        sendLock: neverSendLock(),
      };
      await processPendingWaEvents(deps);

      expect(await disposition(client, eventId)).toBe("deliberate_silence");
      const notices = await client.query(
        "SELECT id FROM notices WHERE twin_id = $1 AND about_event_id = $2",
        [twin.twinId, eventId],
      );
      expect(notices.rows).toEqual([]);
    });
  });
});
