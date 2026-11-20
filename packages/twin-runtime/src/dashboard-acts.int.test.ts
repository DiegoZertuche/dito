/**
 * THE THREE ACTS THAT ARE NOT THE DISMISSAL, AND THE GATE IN FRONT OF ALL
 * FOUR (ticket #224; spec #214 decision 2 and user stories 31, 32 and 35;
 * ADR-0003, ADR-0004, ADR-0013, ADR-0035).
 *
 * The dismissal is proven at the API's own seam, over the wire, from a post a
 * scripted drafting run really composed (`local-api.int.test.ts`). This file
 * takes the other three — **Retirar**, «Sí, es este cliente» and «No es este
 * cliente» — at the POSTGRES SEAM, which is where the acts differ from each
 * other: what they READ and what they WRITE. Rows in, rows out, real envelope
 * crypto over a real SQLCipher bundle, and no model anywhere (ADR-0028 — a
 * dashboard act is deterministic, which is the whole reason its execution
 * records zero iterations and zero tokens).
 *
 * ═══ WHY NOT THROUGH THE HTTP DOOR AS WELL
 *
 * The door is one door: the fences, the body checks, the method rule and the
 * closed answer set are the same for all four, and driving each act through it
 * would re-prove them four times. What is different per act is the store
 * logic, and that is what this file is about.
 *
 * ═══ THE FIXTURES ARE THE TWIN'S OWN WRITERS WHEREVER ONE EXISTS
 *
 * The binding question is composed by `composeBindingQuestionPost` and emitted
 * by `insertNoticeWithSystemSend` — the same two calls the router makes — so
 * the post the act resolves is the post the twin makes. The day's record is
 * the one exception: its lines are filed through the APERTURE (the single
 * writer, ADR-0003) and the numbering is then recorded by hand, because
 * composing the post needs a model and this file has none. What that numbering
 * is FOR is proven where it is composed (`corrections.int.test.ts`); what is
 * proven here is that the act resolves through it.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { finalizeDueFacts, readFiledFacts } from "@dito/aperture";
import { createBundle, type Bundle } from "@dito/bundle";
import { createDekFromMaterial, type Dek } from "@dito/crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  performDashboardAct,
  performNotepadEdit,
  settleUnaccountedNotepadEdits,
  type DashboardActDeps,
} from "./dashboard-acts.js";
import { bindingAckReceipt, RECEIPTS, renderReceiptPost } from "./grammar.js";
import { insertNoticeWithSystemSend } from "./notices.js";
import { composeAnswerPost, composeBindingQuestionPost, documentPart } from "./posts.js";
import { TwinExecutionStore, twinExecutionChain } from "./execution-store.js";
import { executionAuditEntry } from "@dito/execution";
import {
  resetAndMigrate,
  TEST_AUDIT_HMAC_KEY,
  TEST_DATABASE_URL,
  withClient,
} from "./testing/db.js";
import { disclosedFact, RECORD_REACHED as REACHED } from "./testing/disclosed-fact.js";
import { insertWaEvent } from "./testing/seam-fixtures.js";
import { checkRepEvidence } from "./thread/evidence.js";
import { removeTmpDir } from "./testing/tmp.js";

const SELF_CHAT = "5215550000@s.whatsapp.net";
const CUSTOMER = "5215550001@s.whatsapp.net";
/** Two more chats, so one press can move three of them (ticket #243). */
const SECOND_CUSTOMER = "5215550002@s.whatsapp.net";
const GROUP_CHAT = "5215550003-1600000000@g.us";
const PUSH_NAME = "Sra. Garza";
/** The day the record is about, and the instant its post reached the rep. */

let tmp: string;
let pool: pg.Pool;

beforeAll(async () => {
  await resetAndMigrate();
  tmp = mkdtempSync(join(tmpdir(), "dito-dashboard-acts-int-"));
  pool = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 4 });
});

afterAll(async () => {
  await pool.end();
  removeTmpDir(tmp);
});

interface Twin {
  readonly twinId: string;
  readonly companyId: string;
  readonly seatId: string;
  readonly dek: Dek;
  readonly bundle: Bundle;
}

/** One twin, with its seat in the registry the act row's key points at. */
async function freshTwin(client: pg.Client): Promise<Twin> {
  const twinId = randomUUID();
  const companyId = randomUUID();
  const seatId = randomUUID();
  const dek = createDekFromMaterial(randomBytes(32));
  await client.query(
    "INSERT INTO companies (id, display_name) VALUES ($1, $2)",
    [companyId, `Ferretería ${companyId.slice(0, 4)}`],
  );
  await client.query(
    `INSERT INTO seats (id, company_id, twin_id, rep_display_name, state)
     VALUES ($1, $2, $3, $4, 'linked')`,
    [seatId, companyId, twinId, "Mauricio Cantú"],
  );
  return {
    twinId,
    companyId,
    seatId,
    dek,
    bundle: createBundle(join(tmp, `${twinId}.bundle`), dek),
  };
}

function depsFor(client: pg.Client, twin: Twin): DashboardActDeps {
  return {
    db: client,
    dek: twin.dek,
    twinId: twin.twinId,
    hmacKey: TEST_AUDIT_HMAC_KEY,
    bundle: twin.bundle,
    selfChatJid: SELF_CHAT,
  };
}

/**
 * A posted binding question, composed and emitted by the twin's own writers.
 *
 * The chat and the proposed name live in the customer event's sealed payload,
 * which is the anchor the ceremony uses (#34) — so the act re-derives
 * the values the rep was SHOWN rather than trusting anything a request
 * carried.
 */
async function askedBinding(
  client: pg.Client,
  twin: Twin,
): Promise<{ postId: string; aboutEventId: string }> {
  const aboutEventId = await insertWaEvent(client, twin.dek, {
    twinId: twin.twinId,
    companyId: twin.companyId,
    seatId: twin.seatId,
    chatJid: CUSTOMER,
    senderJid: CUSTOMER,
    fromMe: false,
    messageId: `3EB0-ASK-${randomUUID().slice(0, 8)}`,
    text: "¿me mandas 40 cajas?",
    pushName: PUSH_NAME,
    occurredAt: new Date("2026-09-08T16:20:00.000Z"),
  });
  const noticeId = await insertNoticeWithSystemSend(client, {
    twinId: twin.twinId,
    selfChatJid: SELF_CHAT,
    dek: twin.dek,
    kind: "binding_question",
    aboutEventId,
    post: composeBindingQuestionPost({ aboutEventId, proposedName: PUSH_NAME }),
  });
  const post = await client.query<{ id: string }>(
    "SELECT id FROM posts WHERE notice_id = $1",
    [noticeId],
  );
  return { postId: post.rows[0]!.id, aboutEventId };
}

/** Every twin post in the thread, decrypted — what the rep actually reads. */
async function twinPosts(
  client: pg.Client,
  twin: Twin,
): Promise<{ kind: string; text: string }[]> {
  const res = await client.query<{ kind: string; content_enc: Buffer }>(
    `SELECT n.kind, n.content_enc
       FROM notices n
       JOIN send_commands sc ON sc.payload_ref = 'notice:' || n.id
      WHERE n.twin_id = $1
      ORDER BY sc.created_at, sc.id`,
    [twin.twinId],
  );
  return res.rows.map((row) => ({
    kind: row.kind,
    text: Buffer.from(twin.dek.decrypt(row.content_enc)).toString("utf8"),
  }));
}

describe("Retirar, from the card (user story 31; ADR-0004, FR-33)", () => {
  it("retracts the line the button named, and posts the receipt the thread posts", async () => {
    await withClient(async (client) => {
      const twin = await freshTwin(client);
      const { postId, factId, lineId } = await disclosedFact(client, twin);
      const outcome = await performDashboardAct(
        depsFor(client, twin),
        { companyId: twin.companyId, seatId: twin.seatId },
        { target: "post", route: "retractLine", postId, lineIndex: 1 },
      );
      expect(outcome).toBe("performed");

      // THE FACT IS ANNOTATED, NEVER DELETED (FR-33): it keeps its row and its
      // place in the timeline. Asked through the aperture's own read rather
      // than by naming a Ledger table, which `sole-writer.test.ts` sweeps this
      // whole package for — the runtime is on the rep side of ADR-0002's wall
      // and its tests are held to the same line.
      const filed = await readFiledFacts({ db: client, dek: twin.dek }, twin.twinId);
      expect(
        filed.find((fact) => fact.id === factId)?.retractedAt,
      ).not.toBeNull();
      // ...AND THE APERTURE'S REP-SIDE EVIDENCE ROW NAMES THE DASHBOARD ACT,
      // on the other of the two columns — exactly one is set, which
      // `fact_retractions_one_evidence_check` refuses to let be otherwise.
      const evidence = await client.query<{
        source_event_id: string | null;
        dashboard_act_id: string | null;
        disclosure_line_id: string;
      }>(
        `SELECT source_event_id, dashboard_act_id, disclosure_line_id
           FROM fact_retractions WHERE fact_id = $1`,
        [factId],
      );
      expect(evidence.rows[0]!.source_event_id).toBeNull();
      expect(evidence.rows[0]!.dashboard_act_id).not.toBeNull();
      expect(evidence.rows[0]!.disclosure_line_id).toBe(lineId);
      // ONE ACT, TWO SURFACES, from the output side: the receipt is the
      // thread's own numbered sentence, framed, in the rep's own thread.
      const posts = await twinPosts(client, twin);
      // BYTE FOR BYTE THE THREAD'S OWN POST (AC 3: the card's lines and its
      // acts match the thread's). The oracle is the thread's renderer over the
      // thread's own numbered receipt, so this is the claim that both surfaces
      // produce one post rather than two that look alike.
      const ack = posts.find((post) => post.kind === "correction_ack");
      expect(ack?.text).toBe(renderReceiptPost(RECEIPTS.retracted(1)));
      twin.bundle.close();
    });
  });

  it("answers «already» to a second Retirar on the same line", async () => {
    await withClient(async (client) => {
      const twin = await freshTwin(client);
      const { postId } = await disclosedFact(client, twin);
      const target = { target: "post", route: "retractLine", postId, lineIndex: 1 } as const;
      expect(
        await performDashboardAct(
          depsFor(client, twin),
          { companyId: twin.companyId, seatId: twin.seatId },
          target,
        ),
      ).toBe("performed");
      // TERMINAL AND IDEMPOTENT: the FIRST correction stands with its own
      // instant and its own evidence row, and saying so again costs nothing.
      expect(
        await performDashboardAct(
          depsFor(client, twin),
          { companyId: twin.companyId, seatId: twin.seatId },
          target,
        ),
      ).toBe("already");
      twin.bundle.close();
    });
  });

  it("stamps the act row with the word the rep was answered, once and only once", async () => {
    // WHY THE ROW RECORDS ITS OUTCOME AT ALL: audit coverage enumerates a
    // dashboard act by this word. A repeat Retirar and a refused Retirar both
    // write no retraction row, and they owe the chain DIFFERENT entries
    // (`already_retracted` against `refused:<reason>`), so without the word
    // the refusal class would demand an entry from an act that correctly
    // wrote none — a green that has to be argued away instead of an
    // invariant. This is `wa_event_processing.disposition`, one surface over.
    await withClient(async (client) => {
      const twin = await freshTwin(client);
      const { postId } = await disclosedFact(client, twin);
      const target = { target: "post", route: "retractLine", postId, lineIndex: 1 } as const;
      const scope = { companyId: twin.companyId, seatId: twin.seatId };
      await performDashboardAct(depsFor(client, twin), scope, target);
      await performDashboardAct(depsFor(client, twin), scope, target);
      // A LINE THAT POST NEVER PRINTED, so the third act refuses before the
      // aperture sees it: three presses, three rows, three different words.
      await performDashboardAct(depsFor(client, twin), scope, {
        target: "post",
        route: "retractLine",
        postId,
        lineIndex: 9,
      });
      const stamped = await client.query<{ outcome: string }>(
        `SELECT outcome FROM dashboard_acts
          WHERE post_id = $1 ORDER BY acted_at`,
        [postId],
      );
      expect(stamped.rows.map((row) => row.outcome)).toEqual([
        "performed",
        "already",
        "refused",
      ]);
      // ...AND THE STAMP IS THE ONLY UPDATE THE STORE PERMITS. A second one
      // would rewrite what the rep was told, and an act row is class-2
      // evidence (ADR-0003) — so the store refuses it rather than trusting
      // every future caller to.
      await expect(
        client.query(
          `UPDATE dashboard_acts SET outcome = 'refused' WHERE post_id = $1`,
          [postId],
        ),
      ).rejects.toThrow(/already stamped/u);
      await expect(
        client.query(`DELETE FROM dashboard_acts WHERE post_id = $1`, [postId]),
      ).rejects.toThrow(/immutable/u);
      twin.bundle.close();
    });
  });

  it("refuses a retraction after the window with the word the thread gives", async () => {
    await withClient(async (client) => {
      const twin = await freshTwin(client);
      const { postId } = await disclosedFact(client, twin);
      // THE WINDOW IS FINALIZATION, not a clock read (`retraction.ts`): the
      // pass has to have RUN for a late correction to be refused, which is
      // exactly the state a rep meets the day after.
      const closed = await finalizeDueFacts(
        { db: client },
        { twinId: twin.twinId },
        new Date(REACHED.getTime() + 25 * 60 * 60 * 1000),
      );
      expect(closed.finalized).toBe(1);
      // `window_closed` IS ITS OWN WORD ON THE WIRE, because it is the one
      // refusal the rep can read — and it is the same reason word the thread
      // gives (the AC asks the two surfaces to name one).
      expect(
        await performDashboardAct(
          depsFor(client, twin),
          { companyId: twin.companyId, seatId: twin.seatId },
          { target: "post", route: "retractLine", postId, lineIndex: 1 },
        ),
      ).toBe("window_closed");
      const posts = await twinPosts(client, twin);
      expect(
        posts.find((post) => post.kind === "correction_refusal")?.text,
      ).toBe(renderReceiptPost(RECEIPTS.correctionRefused("window_closed")));
      twin.bundle.close();
    });
  });

  it("refuses a line number the post never printed", async () => {
    await withClient(async (client) => {
      const twin = await freshTwin(client);
      const { postId } = await disclosedFact(client, twin);
      // THE NUMBERING IS THE POST'S OWN (ADR-0034), so a number it never
      // showed resolves to nothing — the card cannot name a line the rep was
      // not shown, which is the walk both surfaces make.
      expect(
        await performDashboardAct(
          depsFor(client, twin),
          { companyId: twin.companyId, seatId: twin.seatId },
          { target: "post", route: "retractLine", postId, lineIndex: 7 },
        ),
      ).toBe("refused");
      twin.bundle.close();
    });
  });

  it("refuses a retraction aimed at a card that carries no record", async () => {
    await withClient(async (client) => {
      const twin = await freshTwin(client);
      const { postId } = await askedBinding(client, twin);
      expect(
        await performDashboardAct(
          depsFor(client, twin),
          { companyId: twin.companyId, seatId: twin.seatId },
          { target: "post", route: "retractLine", postId, lineIndex: 1 },
        ),
      ).toBe("refused");
      twin.bundle.close();
    });
  });
});

describe("the binding question's two buttons (user story 32; ADR-0035)", () => {
  it("binds the chat to the name the question proposed, and acks what it stored", async () => {
    await withClient(async (client) => {
      const twin = await freshTwin(client);
      const { postId } = await askedBinding(client, twin);
      expect(
        await performDashboardAct(
          depsFor(client, twin),
          { companyId: twin.companyId, seatId: twin.seatId },
          { target: "post", route: "confirmBinding", postId },
        ),
      ).toBe("performed");
      // THE BINDING LANDS ONLY IN THE ENTITY MIRROR (ADR-0004), with the name
      // and the chat re-derived from the question's own source event — the
      // values the rep was shown, never anything the request carried.
      const bound = twin.bundle.readChatBinding(CUSTOMER);
      expect(bound?.displayName).toBe(PUSH_NAME);
      // ...and the ack names what was STORED (#49's rule).
      const posts = await twinPosts(client, twin);
      const ack = posts.find((post) => post.kind === "binding_ack");
      expect(ack?.text).toBe(
        renderReceiptPost(bindingAckReceipt(PUSH_NAME)),
      );
      twin.bundle.close();
    });
  });

  it("leaves the first confirmation standing when the rep presses again", async () => {
    await withClient(async (client) => {
      const twin = await freshTwin(client);
      const { postId } = await askedBinding(client, twin);
      const target = { target: "post", route: "confirmBinding", postId } as const;
      const scope = { companyId: twin.companyId, seatId: twin.seatId };
      expect(
        await performDashboardAct(depsFor(client, twin), scope, target),
      ).toBe("performed");
      const first = twin.bundle.readChatBinding(CUSTOMER);
      expect(
        await performDashboardAct(depsFor(client, twin), scope, target),
      ).toBe("already");
      // THE SAME ENTITY ID, which is the whole point: it is carried into the
      // Ledger unchanged (ADR-0035), so a repeat that re-minted one would file
      // a second customer for one chat.
      expect(twin.bundle.readChatBinding(CUSTOMER)?.entityId).toBe(
        first?.entityId,
      );
      twin.bundle.close();
    });
  });

  it("records a decline and writes nothing, which is the act rather than a gap", async () => {
    await withClient(async (client) => {
      const twin = await freshTwin(client);
      const { postId } = await askedBinding(client, twin);
      expect(
        await performDashboardAct(
          depsFor(client, twin),
          { companyId: twin.companyId, seatId: twin.seatId },
          { target: "post", route: "declineBinding", postId },
        ),
      ).toBe("performed");
      // NOTHING IS SAVED: the chat stays unconfirmed, which is where it
      // already was (#49). What IS recorded is the act row and the receipt —
      // one more than the retired keyword left.
      expect(twin.bundle.readChatBinding(CUSTOMER)).toBeUndefined();
      const acts = await client.query<{ verb: string }>(
        "SELECT verb FROM dashboard_acts WHERE twin_id = $1",
        [twin.twinId],
      );
      expect(acts.rows).toEqual([{ verb: "decline_binding" }]);
      const posts = await twinPosts(client, twin);
      expect(
        posts.find((post) => post.kind === "binding_ack")?.text,
      ).toBe(renderReceiptPost(RECEIPTS.bindingDeclined));
      twin.bundle.close();
    });
  });

  it("refuses a decline of a chat the rep already confirmed", async () => {
    await withClient(async (client) => {
      const twin = await freshTwin(client);
      const { postId } = await askedBinding(client, twin);
      const scope = { companyId: twin.companyId, seatId: twin.seatId };
      await performDashboardAct(depsFor(client, twin), scope, {
        target: "post",
        route: "confirmBinding",
        postId,
      });
      // A «no» ARRIVING AFTER A YES DOES NOT UNDO IT (#49): unbinding is a
      // different act with no verb, so inferring one from a decline would let
      // a stale card undo a confirmation.
      expect(
        await performDashboardAct(depsFor(client, twin), scope, {
          target: "post",
          route: "declineBinding",
          postId,
        }),
      ).toBe("refused");
      expect(twin.bundle.readChatBinding(CUSTOMER)).toBeDefined();
      twin.bundle.close();
    });
  });

  it("refuses a binding act aimed at a card that asks nothing", async () => {
    await withClient(async (client) => {
      const twin = await freshTwin(client);
      const { postId } = await disclosedFact(client, twin);
      for (const route of ["confirmBinding", "declineBinding"] as const) {
        expect(
          `${route}: ${await performDashboardAct(
            depsFor(client, twin),
            { companyId: twin.companyId, seatId: twin.seatId },
            { target: "post", route, postId },
          )}`,
        ).toBe(`${route}: refused`);
      }
      twin.bundle.close();
    });
  });
});

describe("the rep-evidenced gate, on the dashboard's side (user story 35)", () => {
  it("accepts the dashboard act this run was created for", async () => {
    await withClient(async (client) => {
      const twin = await freshTwin(client);
      const { postId } = await askedBinding(client, twin);
      const act = await client.query<{ id: string }>(
        `INSERT INTO dashboard_acts (company_id, seat_id, twin_id, post_id, verb)
         VALUES ($1, $2, $3, $4, 'confirm_binding') RETURNING id`,
        [twin.companyId, twin.seatId, twin.twinId, postId],
      );
      const checked = await checkRepEvidence(
        { db: client, dek: twin.dek, twinId: twin.twinId },
        { surface: "dashboard", dashboardActId: act.rows[0]!.id },
        act.rows[0]!.id,
      );
      expect(checked.ok).toBe(true);
      expect(checked.ok ? checked.evidence : undefined).toEqual({
        surface: "dashboard",
        dashboardActId: act.rows[0]!.id,
      });
      twin.bundle.close();
    });
  });

  it("refuses an act id this twin does not own", async () => {
    await withClient(async (client) => {
      const mine = await freshTwin(client);
      const theirs = await freshTwin(client);
      const { postId } = await askedBinding(client, theirs);
      const foreign = await client.query<{ id: string }>(
        `INSERT INTO dashboard_acts (company_id, seat_id, twin_id, post_id, verb)
         VALUES ($1, $2, $3, $4, 'confirm_binding') RETURNING id`,
        [theirs.companyId, theirs.seatId, theirs.twinId, postId],
      );
      // THE APERTURE RE-READS THE ROW UNDER THIS TWIN, so an act of another
      // twin resolves to nothing at all and comes back class 1. This is the
      // second of the gate's two checks, and the one that is load-bearing on a
      // surface where nothing can lie about the first.
      //
      // AND «ANOTHER SEAT'S ACT» IS THIS CASE (AC 5), which is worth saying
      // rather than leaving to be discovered: `seats_one_seat_per_twin` makes
      // one seat and one twin an equivalence, so a foreign seat necessarily
      // owns a foreign twin and the twin predicate IS the seat predicate. The
      // local API rests on the same equivalence in the other direction
      // (`scopeOf`: "a seat of another company necessarily owns another
      // twin"), so a second comparison here would check what the store
      // already guarantees.
      const checked = await checkRepEvidence(
        { db: client, dek: mine.dek, twinId: mine.twinId },
        { surface: "dashboard", dashboardActId: foreign.rows[0]!.id },
        foreign.rows[0]!.id,
      );
      expect(checked.ok).toBe(false);
      mine.bundle.close();
      theirs.bundle.close();
    });
  });

  it("refuses a customer-chat message id, and an id that names nothing", async () => {
    await withClient(async (client) => {
      const twin = await freshTwin(client);
      // A SEAM EVENT IS NOT A DASHBOARD ACT. The dashboard arm reads
      // `dashboard_acts` and nothing else, so a `wa_events` id — even a real
      // one from a customer chat — names no row and is refused.
      const customerEvent = await insertWaEvent(client, twin.dek, {
        twinId: twin.twinId,
        companyId: twin.companyId,
        seatId: twin.seatId,
        chatJid: CUSTOMER,
        senderJid: CUSTOMER,
        fromMe: false,
        messageId: `3EB0-CUST-${randomUUID().slice(0, 8)}`,
        text: "¿me mandas 40 cajas?",
        occurredAt: new Date("2026-09-08T16:20:00.000Z"),
      });
      for (const cited of [customerEvent, randomUUID(), "", "not-an-id"]) {
        const checked = await checkRepEvidence(
          { db: client, dek: twin.dek, twinId: twin.twinId },
          { surface: "dashboard", dashboardActId: cited },
          cited,
        );
        expect(`${cited}: ${checked.ok}`).toBe(`${cited}: false`);
      }
      twin.bundle.close();
    });
  });

  it("refuses an act id that is not the one this run was created for", async () => {
    await withClient(async (client) => {
      const twin = await freshTwin(client);
      const { postId } = await askedBinding(client, twin);
      const two = await client.query<{ id: string }>(
        `INSERT INTO dashboard_acts (company_id, seat_id, twin_id, post_id, verb)
         VALUES ($1, $2, $3, $4, 'confirm_binding'),
                ($1, $2, $3, $4, 'decline_binding')
         RETURNING id`,
        [twin.companyId, twin.seatId, twin.twinId, postId],
      );
      // THE FIRST OF THE GATE'S TWO CHECKS, which is unreachable through the
      // API today — it mints the row one statement before it cites it — and is
      // made anyway, because 6b puts a model on this surface (*Habla con
      // Dito*) and a gate added after the caller that needs it is a gate
      // somebody has to remember. Both ids are real, this twin's, and unspent;
      // only one is this run's.
      const checked = await checkRepEvidence(
        { db: client, dek: twin.dek, twinId: twin.twinId },
        { surface: "dashboard", dashboardActId: two.rows[0]!.id },
        two.rows[1]!.id,
      );
      expect(checked.ok).toBe(false);
      twin.bundle.close();
    });
  });

  it("keeps the thread's own refusal sentence, byte for byte", async () => {
    await withClient(async (client) => {
      const twin = await freshTwin(client);
      // THE SENTENCE IS THE SURFACE'S, because of who reads it: the thread's
      // is written for a MODEL to relay and `acts.test.ts` is its oracle, so
      // widening the gate must not have moved it.
      const checked = await checkRepEvidence(
        { db: client, dek: twin.dek, twinId: twin.twinId },
        { surface: "twin_thread", eventId: "1", messageId: "3EB0-X" },
        "999",
      );
      expect(checked.ok).toBe(false);
      expect(checked.ok ? "" : checked.told).toContain("the rep's own message");
      twin.bundle.close();
    });
  });
});

/* ── THE TWO ACTS WHOSE TARGET IS A CHAT (ticket #223) ────────────────────
   The four above are performed on a CARD. A scope switch is performed on a
   row of the chat directory, so `dashboard_acts.post_id` is null on it and
   `chat_directory_id` carries the target instead — the widening this ticket
   made, with two CHECKs saying which verbs carry which.

   THE POSTGRES SEAM IS WHERE THESE BELONG for the reason the file's header
   gives: what is different about them is what they READ and WRITE, and it is
   three stores in one transaction. The door is proven once, over the wire, in
   `local-api.int.test.ts`.

   AND THIS SUITE IS THE CORPUS CI's COVERAGE STEP READS, which is why the
   scope acts are minted here at all: `--require-acts=scope_change` over a
   corpus with no scope act would be inconclusive, and a class checked in name
   and vacuous in fact is the silent green `--require-acts` exists to refuse. */

/** One chat the plane has seen, as a directory row a switch can name. */
async function directoryRow(
  client: pg.Client,
  twin: Twin,
  chatJid: string,
): Promise<string> {
  const row = await client.query<{ id: string }>(
    `INSERT INTO chat_directory (twin_id, chat_jid, kind, last_activity_at)
     VALUES ($1, $2, 'dm', now()) RETURNING id`,
    [twin.twinId, chatJid],
  );
  return row.rows[0]!.id;
}

describe("a scope switch, as a dashboard act (ticket #223)", () => {
  it("writes the allowlist row, the plane's request and one chain entry", async () => {
    await withClient(async (client) => {
      const twin = await freshTwin(client);
      const directoryId = await directoryRow(client, twin, CUSTOMER);
      const outcome = await performDashboardAct(
        depsFor(client, twin),
        { companyId: twin.companyId, seatId: twin.seatId },
        { target: "chat", route: "scopeIn", chatDirectoryId: directoryId },
      );
      expect(outcome).toBe("performed");

      // THE ACT ROW NAMES THE DIRECTORY ROW AND NO POST, which is what the
      // widening is: `dashboard_acts_one_target_check` refuses a row that
      // names both, `dashboard_acts_notepad_target_check` one that names
      // neither, and `dashboard_acts_target_by_verb_check` a scope verb that
      // names a post.
      const act = await client.query<{
        id: string;
        verb: string;
        post_id: string | null;
        chat_directory_id: string | null;
        outcome: string;
      }>(
        `SELECT id, verb, post_id, chat_directory_id, outcome
           FROM dashboard_acts WHERE twin_id = $1`,
        [twin.twinId],
      );
      expect(act.rows).toHaveLength(1);
      const actRow = act.rows[0]!;
      expect({
        verb: actRow.verb,
        post_id: actRow.post_id,
        chat_directory_id: actRow.chat_directory_id,
        outcome: actRow.outcome,
      }).toEqual({
        verb: "scope_in",
        post_id: null,
        chat_directory_id: directoryId,
        outcome: "performed",
      });

      // THE THREE WRITES `scoping.ts` OWES, in one transaction with the act.
      const allowed = await client.query<{ chat_jid: string }>(
        "SELECT chat_jid FROM scope_allowlist WHERE twin_id = $1",
        [twin.twinId],
      );
      expect(allowed.rows).toEqual([{ chat_jid: CUSTOMER }]);
      const asked = await client.query<{
        id: string;
        kind: string;
        chat_jid: string;
      }>(
        "SELECT id, kind, chat_jid FROM plane_requests WHERE twin_id = $1",
        [twin.twinId],
      );
      expect(asked.rows).toHaveLength(1);
      const request = asked.rows[0]!;
      expect({ kind: request.kind, chat_jid: request.chat_jid }).toEqual({
        kind: "scope_in",
        chat_jid: CUSTOMER,
      });

      // ONE `scope_change` ENTRY, AND IT NAMES THE ACT (ticket #223): the
      // request row says which chat, the act row says who pressed, and the
      // entry's third token is what lets a reader walk from one to the other.
      const chained = await client.query<{
        caller: string;
        action: string;
        outcome: string;
        ref: string;
      }>(
        `SELECT caller, action, outcome, ref FROM audit_chain
          WHERE action = 'scope_change' ORDER BY id`,
      );
      expect(chained.rows).toHaveLength(1);
      const entry = chained.rows[0]!;
      expect(entry.caller).toBe("twin-runtime/scoping");
      expect(entry.outcome).toBe("scope_in:moved");
      expect(entry.ref).toBe(
        `twin:${twin.twinId} request:${request.id} act:${actRow.id}`,
      );
      // ...AND NO CHAT IDENTITY ON THE CHAIN (ADR-0020): the entry carries
      // opaque ids and one word, so the address is reachable only through a
      // row a grant governs.
      expect(entry.ref).not.toContain("@");

      // AND THE EXECUTION BESIDE IT, which is the other entry an act owes
      // (ADR-0014 as amended). Two entries, one per class of act, exactly as
      // a retraction leaves.
      const run = await client.query<{
        disposition: string;
        iterations: number;
        trigger_ref: string;
      }>(
        `SELECT disposition, iterations, trigger_ref FROM executions
          WHERE twin_id = $1 AND trigger_kind = 'dashboard_act'`,
        [twin.twinId],
      );
      expect(run.rows).toHaveLength(1);
      expect(run.rows[0]!.disposition).toBe("acted");
      expect(run.rows[0]!.iterations).toBe(0);
      expect(run.rows[0]!.trigger_ref).toContain("post:none");
      expect(run.rows[0]!.trigger_ref).toContain(`chat_row:${directoryId}`);
      twin.bundle.close();
    });
  });

  it("takes the chat back out, and says «already» when the switch did not move", async () => {
    await withClient(async (client) => {
      const twin = await freshTwin(client);
      const directoryId = await directoryRow(client, twin, CUSTOMER);
      const scope = { companyId: twin.companyId, seatId: twin.seatId };
      const request = {
        target: "chat",
        route: "scopeOut",
        chatDirectoryId: directoryId,
      } as const;
      // OUT OF A CHAT THAT WAS NEVER IN: the allowlist delete matches nothing,
      // so the switch did not move — and the act still happened, which is what
      // `already` says and what the chain records either way.
      expect(await performDashboardAct(depsFor(client, twin), scope, request)).toBe(
        "already",
      );
      await performDashboardAct(
        depsFor(client, twin),
        scope,
        { target: "chat", route: "scopeIn", chatDirectoryId: directoryId },
      );
      expect(await performDashboardAct(depsFor(client, twin), scope, request)).toBe(
        "performed",
      );
      const allowed = await client.query(
        "SELECT 1 FROM scope_allowlist WHERE twin_id = $1",
        [twin.twinId],
      );
      expect(allowed.rows).toEqual([]);
      // THREE PRESSES, THREE ACT ROWS, THREE REQUEST ROWS AND THREE ENTRIES:
      // the chain records ACTS and not state changes (`scoping.ts`' rule).
      const counts = await client.query<{ acts: number; asks: number }>(
        `SELECT (SELECT count(*)::int FROM dashboard_acts WHERE twin_id = $1) AS acts,
                (SELECT count(*)::int FROM plane_requests WHERE twin_id = $1) AS asks`,
        [twin.twinId],
      );
      expect(counts.rows[0]).toEqual({ acts: 3, asks: 3 });
      twin.bundle.close();
    });
  });

  it("takes one «Guardar» as three acts and leaves three of everything (#243)", async () => {
    await withClient(async (client) => {
      const twin = await freshTwin(client);
      // THE PRESS THE SCOPING FORM MAKES (ruling F24): the rep marks two
      // chats that were out and unmarks one that was in, then presses once.
      // rep-web diffs the marks against the directory and asks for one
      // existing act per changed chat, in the page's order — groups first
      // (`apps/rep-web/src/app/scope-changes.ts`).
      const group = await directoryRow(client, twin, GROUP_CHAT);
      const carmen = await directoryRow(client, twin, CUSTOMER);
      const nameless = await directoryRow(client, twin, SECOND_CUSTOMER);
      // «Doña Carmen» IS IN SCOPE BEFORE THE PRESS, planted rather than
      // acted: the press is what is under test, and an act to set the scene
      // would be counted by every assertion below.
      await client.query(
        "INSERT INTO scope_allowlist (twin_id, chat_jid) VALUES ($1, $2)",
        [twin.twinId, CUSTOMER],
      );
      const scope = { companyId: twin.companyId, seatId: twin.seatId };
      const press = [
        { route: "scopeIn", chatDirectoryId: group },
        { route: "scopeOut", chatDirectoryId: carmen },
        { route: "scopeIn", chatDirectoryId: nameless },
      ] as const;
      for (const act of press) {
        expect(
          await performDashboardAct(depsFor(client, twin), scope, {
            target: "chat",
            ...act,
          }),
        ).toBe("performed");
      }

      // THREE ACT ROWS, ONE TARGET EACH, IN THE ORDER THEY WERE PRESSED. The
      // row shape does not change because a press performs several: one
      // `dashboard_acts` row per chat is still what each act's evidence is
      // (ADR-0013), and `dashboard_acts_one_target_check` still holds.
      const acts = await client.query<{
        verb: string;
        chat_directory_id: string;
        post_id: string | null;
        outcome: string;
      }>(
        `SELECT verb, chat_directory_id, post_id, outcome FROM dashboard_acts
          WHERE twin_id = $1 ORDER BY acted_at, id`,
        [twin.twinId],
      );
      expect(
        acts.rows.map((row) => ({
          verb: row.verb,
          target: row.chat_directory_id,
          post: row.post_id,
          outcome: row.outcome,
        })),
      ).toEqual([
        { verb: "scope_in", target: group, post: null, outcome: "performed" },
        { verb: "scope_out", target: carmen, post: null, outcome: "performed" },
        { verb: "scope_in", target: nameless, post: null, outcome: "performed" },
      ]);

      // ...THREE PLANE REQUESTS, one following each act as before.
      const asks = await client.query<{ kind: string; chat_jid: string }>(
        `SELECT kind, chat_jid FROM plane_requests
          WHERE twin_id = $1 ORDER BY requested_at, id`,
        [twin.twinId],
      );
      expect(asks.rows).toEqual([
        { kind: "scope_in", chat_jid: GROUP_CHAT },
        { kind: "scope_out", chat_jid: CUSTOMER },
        { kind: "scope_in", chat_jid: SECOND_CUSTOMER },
      ]);

      // ...AND AN ALLOWLIST EQUAL TO THE SET THE REP LEFT MARKED, which is
      // the whole claim of the form: what Dito may read after the press is
      // what the boxes said, and nothing else.
      const allowed = await client.query<{ chat_jid: string }>(
        "SELECT chat_jid FROM scope_allowlist WHERE twin_id = $1 ORDER BY chat_jid",
        [twin.twinId],
      );
      expect(allowed.rows.map((row) => row.chat_jid).sort()).toEqual(
        [GROUP_CHAT, SECOND_CUSTOMER].sort(),
      );

      // TWO CHAIN ENTRIES PER ACT, six in all: the `scope_change` the scoping
      // module appends and the `execution` every act owes (ADR-0014 as
      // amended). Nothing about a press changes that arithmetic — three acts
      // leave three pairs, which is what keeps audit coverage's `scope_change`
      // class green over a corpus minted by the form.
      const chained = await client.query<{ action: string; ref: string }>(
        `SELECT action, ref FROM audit_chain
          WHERE ref LIKE '%' || $1 || '%' ORDER BY id`,
        [twin.twinId],
      );
      const perAction = chained.rows.reduce<Record<string, number>>(
        (seen, row) => ({ ...seen, [row.action]: (seen[row.action] ?? 0) + 1 }),
        {},
      );
      expect(perAction).toEqual({ scope_change: 3, execution: 3 });
      // ...AND EACH `scope_change` NAMES ITS OWN REQUEST AND ITS OWN ACT, in
      // the order the press applied them: the third token is what lets a
      // reader walk from an entry to the press that caused it, and the second
      // is the token coverage's per-act join matches whole.
      const ids = await client.query<{ request: string; act: string }>(
        `SELECT r.id AS request, a.id AS act
           FROM (SELECT id, row_number() OVER (ORDER BY requested_at, id) AS n
                   FROM plane_requests WHERE twin_id = $1) r
           JOIN (SELECT id, row_number() OVER (ORDER BY acted_at, id) AS n
                   FROM dashboard_acts WHERE twin_id = $1) a ON a.n = r.n
          ORDER BY r.n`,
        [twin.twinId],
      );
      expect(
        chained.rows
          .filter((row) => row.action === "scope_change")
          .map((row) => row.ref),
      ).toEqual(
        ids.rows.map(
          (row) => `twin:${twin.twinId} request:${row.request} act:${row.act}`,
        ),
      );
      twin.bundle.close();
    });
  });

  it("refuses a directory row of another twin, and writes no act row for it", async () => {
    await withClient(async (client) => {
      const mine = await freshTwin(client);
      const theirs = await freshTwin(client);
      const foreign = await directoryRow(client, theirs, CUSTOMER);
      const before = await client.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM dashboard_acts",
      );
      const outcome = await performDashboardAct(
        depsFor(client, mine),
        { companyId: mine.companyId, seatId: mine.seatId },
        { target: "chat", route: "scopeIn", chatDirectoryId: foreign },
      );
      expect(outcome).toBe("refused");
      const after = await client.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM dashboard_acts",
      );
      expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
      // ...AND NOTHING WAS SCOPED, which is the failure the twin predicate
      // exists to refuse: a rep marking a chat of somebody else's twin.
      const allowed = await client.query(
        "SELECT 1 FROM scope_allowlist WHERE twin_id = $1",
        [theirs.twinId],
      );
      expect(allowed.rows).toEqual([]);
      mine.bundle.close();
      theirs.bundle.close();
    });
  });

  it("accepts each act of one «Guardar» as its own evidence (#243)", async () => {
    await withClient(async (client) => {
      const twin = await freshTwin(client);
      // A PRESS PERFORMS SEVERAL ACTS AND EVIDENCES EACH ONE SEPARATELY: the
      // evidence of an act is the `dashboard_acts` row that performed it, so a
      // press that moved three chats leaves three pieces of evidence and the
      // gate accepts each on its own (ADR-0013). Nothing about the gate needed
      // widening for the form — this is the claim that says so.
      const rows = [
        await directoryRow(client, twin, CUSTOMER),
        await directoryRow(client, twin, SECOND_CUSTOMER),
        await directoryRow(client, twin, GROUP_CHAT),
      ];
      for (const chatDirectoryId of rows) {
        await performDashboardAct(
          depsFor(client, twin),
          { companyId: twin.companyId, seatId: twin.seatId },
          { target: "chat", route: "scopeIn", chatDirectoryId },
        );
      }
      const acts = await client.query<{ id: string }>(
        `SELECT id FROM dashboard_acts WHERE twin_id = $1
          ORDER BY acted_at, id`,
        [twin.twinId],
      );
      expect(acts.rows).toHaveLength(3);
      for (const act of acts.rows) {
        const checked = await checkRepEvidence(
          { db: client, dek: twin.dek, twinId: twin.twinId },
          { surface: "dashboard", dashboardActId: act.id },
          act.id,
        );
        expect(checked.ok ? checked.evidence : undefined).toEqual({
          surface: "dashboard",
          dashboardActId: act.id,
        });
      }
      twin.bundle.close();
    });
  });

  it("posts no receipt into the rep's thread, unlike the four card acts", async () => {
    await withClient(async (client) => {
      const twin = await freshTwin(client);
      const directoryId = await directoryRow(client, twin, CUSTOMER);
      await performDashboardAct(
        depsFor(client, twin),
        { companyId: twin.companyId, seatId: twin.seatId },
        { target: "chat", route: "scopeIn", chatDirectoryId: directoryId },
      );
      // A DECISION AND NOT AN OMISSION (`runScopeAct` argues it): link day's
      // ordinary shape is a rep flipping several switches in a row, and a
      // receipt is a real WhatsApp message — so a message per tap would land
      // in a thread they have not opened yet, over a control that re-renders
      // in its new position anyway.
      const posted = await client.query(
        "SELECT 1 FROM notices WHERE twin_id = $1",
        [twin.twinId],
      );
      expect(posted.rows).toEqual([]);
      const sends = await client.query(
        "SELECT 1 FROM send_commands WHERE twin_id = $1",
        [twin.twinId],
      );
      expect(sends.rows).toEqual([]);
      twin.bundle.close();
    });
  });
});

describe("the notebook edit's migration, over a populated table (ticket #264)", () => {
  /** The migration that admits the verb, read off the file that ships. */
  function notepadActMigration(): string {
    return readFileSync(
      resolve(
        dirname(fileURLToPath(import.meta.url)),
        "../../../db/migrations/20260925100010_notepad_edit_act.sql",
      ),
      "utf8",
    );
  }

  /** One act row written by hand, so a constraint's answer is the whole claim. */
  async function insertAct(
    client: pg.Client,
    twin: Twin,
    row: {
      readonly verb: string;
      readonly postId?: string;
      readonly chatDirectoryId?: string;
    },
  ): Promise<void> {
    await client.query(
      `INSERT INTO dashboard_acts
         (company_id, seat_id, twin_id, post_id, chat_directory_id, verb)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        twin.companyId,
        twin.seatId,
        twin.twinId,
        row.postId ?? null,
        row.chatDirectoryId ?? null,
        row.verb,
      ],
    );
  }

  /** Whether a statement is refused, rolled back either way. */
  async function refused(
    client: pg.Client,
    statement: () => Promise<void>,
  ): Promise<boolean> {
    await client.query("BEGIN");
    try {
      await statement();
      return false;
    } catch {
      return true;
    } finally {
      await client.query("ROLLBACK");
    }
  }

  it("replays over rows of every older verb, and then holds each verb to its target", async () => {
    await withClient(async (client) => {
      const twin = await freshTwin(client);
      // A CARD ACT AND A SWITCH, performed the way the dashboard performs
      // them, so the table the file re-validates holds both older shapes.
      const { postId } = await askedBinding(client, twin);
      await performDashboardAct(
        depsFor(client, twin),
        { companyId: twin.companyId, seatId: twin.seatId },
        { target: "post", route: "declineBinding", postId },
      );
      const directoryId = await directoryRow(client, twin, CUSTOMER);
      await performDashboardAct(
        depsFor(client, twin),
        { companyId: twin.companyId, seatId: twin.seatId },
        { target: "chat", route: "scopeIn", chatDirectoryId: directoryId },
      );

      await client.query(notepadActMigration());

      const rows = await client.query<{ verb: string }>(
        "SELECT verb FROM dashboard_acts WHERE twin_id = $1 ORDER BY verb",
        [twin.twinId],
      );
      expect(rows.rows.map((row) => row.verb)).toEqual([
        "decline_binding",
        "scope_in",
      ]);
      // THE NOTEBOOK EDIT NAMES NO TARGET, and names none only.
      expect(
        await refused(client, () =>
          insertAct(client, twin, { verb: "edit_notepad" }),
        ),
      ).toBe(false);
      expect(
        await refused(client, () =>
          insertAct(client, twin, { verb: "edit_notepad", postId }),
        ),
      ).toBe(true);
      // ...AND EVERY OTHER VERB STILL NAMES EXACTLY ONE.
      expect(
        await refused(client, () =>
          insertAct(client, twin, { verb: "dismiss_draft" }),
        ),
      ).toBe(true);
      expect(
        await refused(client, () =>
          insertAct(client, twin, { verb: "scope_in" }),
        ),
      ).toBe(true);
      expect(
        await refused(client, () =>
          insertAct(client, twin, {
            verb: "scope_in",
            postId,
            chatDirectoryId: directoryId,
          }),
        ),
      ).toBe(true);
      twin.bundle.close();
    });
  });
});

/**
 * «LISTO» (ticket #368; ruled 2026-10-08): the rep takes a card with no act of
 * its own off the canvas — recorded and run as every dashboard act is, its
 * effect the performed row itself — and a card with acts of its own refuses it.
 */
describe("«Listo», as a dashboard act (ticket #368)", () => {
  /** The twin the concurrent case presses on, across two connections. */
  let clearing: Twin | undefined;
  /** The migration that admits the verb, read off the file that ships. */
  const clearCardMigration = (): string =>
    readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), "../../../db/migrations/20261008100020_cards_leave_the_canvas.sql"),
      "utf8",
    );

  // THE NOTEBOOK'S REPLAY ABOVE LEAVES THE VERB CHECK AS ITS OWN FILE CUT IT;
  // this file's own cut is re-applied before «Listo» is pressed.
  beforeAll(async () => {
    await withClient(async (client) => {
      await client.query(clearCardMigration());
    });
  });

  /** A run's report handing the rep a document, posted under an execution of its own. */
  async function postedReport(client: pg.Client, twin: Twin): Promise<string> {
    const executionId = randomUUID();
    const at = new Date();
    const trigger = { kind: "run_step", mechanism: "request", twinId: twin.twinId, runId: randomUUID(), step: 1 } as const;
    // THE REPORT'S EXECUTION, WITH ITS CHAIN ENTRY: this file is the dashboard
    // acts' coverage corpus, and an execution with no entry would be a gap.
    await client.query("BEGIN");
    await twinExecutionChain(client, TEST_AUDIT_HMAC_KEY).append(executionAuditEntry(trigger, "deterministic", "posted"));
    await new TwinExecutionStore({ client, twinId: twin.twinId, executionId }).recordExecution({
      trigger,
      instructionsDigest: "deterministic",
      toolNames: [],
      startedAt: at,
      endedAt: at,
      iterations: 0,
      tokens: { input: 0, output: 0 },
      disposition: "posted",
      lane: "batch",
    });
    await client.query("COMMIT");
    const noticeId = await insertNoticeWithSystemSend(client, {
      twinId: twin.twinId,
      selfChatJid: SELF_CHAT,
      dek: twin.dek,
      kind: "answer",
      executionId,
      post: composeAnswerPost({
        answer: "Te dejé los hoteles.",
        mentions: [],
        documents: [documentPart({ id: randomUUID(), title: "Hoteles en Madrid", version: 1 })],
      }),
    });
    const post = await client.query<{ id: string }>("SELECT id FROM posts WHERE notice_id = $1", [noticeId]);
    return post.rows[0]!.id;
  }

  it("records «Listo» on a report as the rep's act — its row, its execution and its entry — and posts nothing", async () => {
    await withClient(async (client) => {
      const twin = await freshTwin(client);
      const postId = await postedReport(client, twin);
      const before = await twinPosts(client, twin);
      const scope = { companyId: twin.companyId, seatId: twin.seatId };
      expect(await performDashboardAct(depsFor(client, twin), scope, { target: "post", route: "clearCard", postId })).toBe("performed");
      expect(await performDashboardAct(depsFor(client, twin), scope, { target: "post", route: "clearCard", postId })).toBe("already");

      const acts = await client.query<{ verb: string; outcome: string; post_id: string }>(
        "SELECT verb, outcome, post_id FROM dashboard_acts WHERE twin_id = $1 ORDER BY acted_at, id",
        [twin.twinId],
      );
      expect(acts.rows).toEqual([
        { verb: "clear_card", outcome: "performed", post_id: postId },
        { verb: "clear_card", outcome: "already", post_id: postId },
      ]);
      const executions = await client.query<{ disposition: string }>(
        "SELECT disposition FROM executions WHERE twin_id = $1 AND trigger_kind = 'dashboard_act' ORDER BY started_at, id",
        [twin.twinId],
      );
      expect(executions.rows.map((row) => row.disposition)).toEqual(["acted", "no-action"]);
      const entries = await client.query<{ n: string }>(
        "SELECT count(*) AS n FROM audit_chain WHERE action = 'execution' AND ref LIKE '%dashboard_act%' AND ref LIKE '%twin:' || $1 || '%'",
        [twin.twinId],
      );
      expect(Number(entries.rows[0]!.n)).toBe(2);
      // NO RECEIPT: the card leaving is what the rep sees.
      expect(await twinPosts(client, twin)).toEqual(before);
      twin.bundle.close();
    });
  });

  it("takes two «Listo» pressed at once in turn: one performed, the other already (Codex r2)", async () => {
    const postId = await withClient(async (client) => {
      const twin = await freshTwin(client);
      clearing = twin;
      return await postedReport(client, twin);
    });
    const twin = clearing!;
    const scope = { companyId: twin.companyId, seatId: twin.seatId };
    const press = async (): Promise<string> => {
      const client = await pool.connect();
      try {
        return await performDashboardAct(depsFor(client as unknown as pg.Client, twin), scope, { target: "post", route: "clearCard", postId });
      } finally {
        client.release();
      }
    };
    expect((await Promise.all([press(), press()])).sort()).toEqual(["already", "performed"]);
    twin.bundle.close();
  });

  it("refuses «Listo» on a card with acts of its own, and leaves it waiting", async () => {
    await withClient(async (client) => {
      const twin = await freshTwin(client);
      const { postId } = await askedBinding(client, twin);
      expect(
        await performDashboardAct(
          depsFor(client, twin),
          { companyId: twin.companyId, seatId: twin.seatId },
          { target: "post", route: "clearCard", postId },
        ),
      ).toBe("refused");
      const acts = await client.query<{ outcome: string }>(
        "SELECT outcome FROM dashboard_acts WHERE twin_id = $1 AND verb = 'clear_card'",
        [twin.twinId],
      );
      expect(acts.rows).toEqual([{ outcome: "refused" }]);
      twin.bundle.close();
    });
  });

  it("replays its migration over rows of every older verb, and holds «Listo» to a card", async () => {
    await withClient(async (client) => {
      const twin = await freshTwin(client);
      const scope = { companyId: twin.companyId, seatId: twin.seatId };
      const { postId } = await askedBinding(client, twin);
      await performDashboardAct(depsFor(client, twin), scope, { target: "post", route: "declineBinding", postId });
      const directoryId = await directoryRow(client, twin, CUSTOMER);
      await performDashboardAct(depsFor(client, twin), scope, { target: "chat", route: "scopeIn", chatDirectoryId: directoryId });
      const report = await postedReport(client, twin);
      await performDashboardAct(depsFor(client, twin), scope, { target: "post", route: "clearCard", postId: report });

      await client.query(clearCardMigration());
      const rows = await client.query<{ verb: string }>(
        "SELECT verb FROM dashboard_acts WHERE twin_id = $1 ORDER BY verb",
        [twin.twinId],
      );
      expect(rows.rows.map((row) => row.verb)).toEqual(["clear_card", "decline_binding", "scope_in"]);
      // «LISTO» NAMES A CARD AND NOTHING ELSE.
      await client.query("BEGIN");
      await expect(
        client.query(
          "INSERT INTO dashboard_acts (company_id, seat_id, twin_id, verb) VALUES ($1, $2, $3, 'clear_card')",
          [twin.companyId, twin.seatId, twin.twinId],
        ),
      ).rejects.toThrow();
      await client.query("ROLLBACK");
      twin.bundle.close();
    });
  });
});

describe("a notebook save whose account never landed is settled from the bundle (ticket #264, Codex r2)", () => {
  /** An act row as a save commits it before the version: unstamped. */
  async function unaccountedAct(
    client: pg.Client,
    twin: Twin,
    actedAt: Date,
  ): Promise<string> {
    const row = await client.query<{ id: string }>(
      `INSERT INTO dashboard_acts (company_id, seat_id, twin_id, verb, acted_at)
       VALUES ($1, $2, $3, 'edit_notepad', $4) RETURNING id`,
      [twin.companyId, twin.seatId, twin.twinId, actedAt],
    );
    return row.rows[0]!.id;
  }

  /** The act's stamp, and the run and chain entry its account wrote. */
  async function accountOf(
    client: pg.Client,
    actId: string,
  ): Promise<{ outcome: string | null; runs: string[]; entries: number }> {
    const act = await client.query<{ outcome: string | null }>(
      "SELECT outcome FROM dashboard_acts WHERE id = $1",
      [actId],
    );
    const runs = await client.query<{ id: string; disposition: string }>(
      `SELECT id, disposition FROM executions
        WHERE trigger_kind = 'dashboard_act' AND trigger_ref LIKE '%' || $1 || '%'`,
      [actId],
    );
    const entries = await client.query(
      "SELECT 1 FROM audit_chain WHERE ref LIKE '%' || $1 || '%'",
      [actId],
    );
    return {
      outcome: act.rows[0]!.outcome,
      runs: runs.rows.map((run) => `${run.id} ${run.disposition}`),
      entries: entries.rows.length,
    };
  }

  const LONG_AGO = new Date(Date.now() - 10 * 60 * 1000);

  it("stamps an act whose version landed as performed, under the version's own execution", async () => {
    await withClient(async (client) => {
      const twin = await freshTwin(client);
      const actId = await unaccountedAct(client, twin, LONG_AGO);
      const executionId = randomUUID();
      twin.bundle.writeNotepad({
        text: "con Fuentes siempre de usted",
        writtenAt: LONG_AGO.toISOString(),
        executionId,
        evidenceRef: actId,
      });

      expect(await settleUnaccountedNotepadEdits(depsFor(client, twin), new Date())).toBe(1);

      expect(await accountOf(client, actId)).toEqual({
        outcome: "performed",
        runs: [`${executionId} acted`],
        entries: 1,
      });
      twin.bundle.close();
    });
  });

  it("stamps an act whose version never landed as refused, and writes no version", async () => {
    await withClient(async (client) => {
      const twin = await freshTwin(client);
      const actId = await unaccountedAct(client, twin, LONG_AGO);

      await settleUnaccountedNotepadEdits(depsFor(client, twin), new Date());

      const account = await accountOf(client, actId);
      expect(account.outcome).toBe("refused");
      expect(account.runs).toHaveLength(1);
      expect(account.runs[0]).toMatch(/ no-action$/u);
      expect(account.entries).toBe(1);
      expect(twin.bundle.readNotepad()).toBeUndefined();
      twin.bundle.close();
    });
  });

  it("leaves a save still in flight alone, and settles each act once", async () => {
    await withClient(async (client) => {
      const twin = await freshTwin(client);
      const settled = await unaccountedAct(client, twin, LONG_AGO);
      const inFlight = await unaccountedAct(client, twin, new Date());
      const before = new Date(Date.now() - 60 * 1000);

      expect(await settleUnaccountedNotepadEdits(depsFor(client, twin), before)).toBe(1);
      expect(await settleUnaccountedNotepadEdits(depsFor(client, twin), before)).toBe(0);

      expect((await accountOf(client, settled)).entries).toBe(1);
      expect(await accountOf(client, inFlight)).toEqual({
        outcome: null,
        runs: [],
        entries: 0,
      });
      twin.bundle.close();
    });
  });
});

describe("a save and the recovery pass never contradict each other (ticket #264, Codex r3)", () => {
  /**
   * The request's own connection, with the recovery pass run on a second one
   * the moment the request reaches for the act row's lock — which is the
   * interleaving where the gate took longer than the settle window.
   */
  function racedBySettle(
    client: pg.Client,
    other: pg.Client,
    twin: Twin,
  ): pg.Client {
    let raced = false;
    return new Proxy(client, {
      get: (target, property) => {
        if (property !== "query") {
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        }
        return async (text: string, values?: unknown[]) => {
          if (!raced && typeof text === "string" && text.includes("FOR UPDATE")) {
            raced = true;
            await settleUnaccountedNotepadEdits(
              { ...depsFor(other, twin) },
              new Date(Date.now() + 60_000),
            );
          }
          return await target.query(text, values);
        };
      },
    });
  }

  it("writes no version for an act the recovery pass already settled as refused", async () => {
    await withClient(async (client) => {
      await withClient(async (other) => {
        const twin = await freshTwin(client);
        const answered = await performNotepadEdit(
          { ...depsFor(client, twin), db: racedBySettle(client, other, twin) },
          { companyId: twin.companyId, seatId: twin.seatId },
          { text: "con Fuentes siempre de usted", basedOn: 0 },
        );
        expect(answered).toEqual({ outcome: "refused" });
        // THE BUNDLE AGREES WITH THE ACCOUNT: nothing was appended after the
        // act was settled, so no version names an execution that has no record.
        expect(twin.bundle.readNotepad()).toBeUndefined();
        const acts = await client.query<{ outcome: string }>(
          "SELECT outcome FROM dashboard_acts WHERE twin_id = $1",
          [twin.twinId],
        );
        expect(acts.rows).toEqual([{ outcome: "refused" }]);
        const runs = await client.query<{ disposition: string }>(
          "SELECT disposition FROM executions WHERE twin_id = $1",
          [twin.twinId],
        );
        expect(runs.rows).toEqual([{ disposition: "no-action" }]);
        twin.bundle.close();
      });
    });
  });
});
