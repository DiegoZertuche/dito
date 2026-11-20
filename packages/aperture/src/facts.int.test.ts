/**
 * The aperture's class-1 input: a candidate fact (ticket #52; spec #48
 * grilling decisions 5 and 6; ADR-0003, ADR-0004, ADR-0034, ADR-0035).
 *
 * Tested across the primary Postgres seam, like every other crossing: a
 * customer message goes in as a raw `wa_events` row, a candidate fact goes
 * in as model output, and what appears on the other side — the Ledger fact
 * and its rep-side disclosure line — is read back the way a real reader
 * would.
 *
 * Real Postgres, real envelope crypto (ADR-0028). The MODEL is nowhere in
 * this suite: a candidate fact is untrusted data, and every decision about
 * whether it crosses is made here in code.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { createDekFromMaterial, type Dek } from "@dito/crypto";
import type { OpaqueReason } from "@dito/seam";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileEntityCreate } from "./entities.js";
import { fileCandidateFact, EXTRACTION_CONFIDENCE_THRESHOLD } from "./facts.js";
import { classifyApertureInput } from "./inputs.js";
import {
  insertWaEventFixture,
  insertWaOpaqueFixture,
  insertWaReactionFixture,
  resetAndMigrate,
  TEST_DATABASE_URL,
} from "./testing/db.js";
import { apertureCtx } from "./testing/context.js";

const SELF_CHAT = "5215550000@s.whatsapp.net";
const CUSTOMER_CHAT = "5215512345678@s.whatsapp.net";

let db: pg.Client;

beforeAll(async () => {
  await resetAndMigrate();
  db = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await db.connect();
});

afterAll(async () => {
  await db.end();
});

interface Seat {
  readonly twinId: string;
  readonly companyId: string;
  readonly seatId: string;
  readonly dek: Dek;
}

function freshSeat(): Seat {
  return {
    twinId: randomUUID(),
    companyId: randomUUID(),
    seatId: randomUUID(),
    dek: createDekFromMaterial(randomBytes(32)),
  };
}

const SAID_AT = new Date("2026-08-29T19:23:00Z");
/** When a gesture landed — after the message it points at (ticket #99). */
const REACTED_AT = new Date("2026-08-29T19:41:00Z");

/** One customer message on the seam — what a candidate fact is read in. */
async function customerMessage(
  seat: Seat,
  messageId: string,
  text: string,
  overrides: { chatJid?: string; backfill?: boolean; occurredAt?: Date } = {},
): Promise<string> {
  const chatJid = overrides.chatJid ?? CUSTOMER_CHAT;
  return insertWaEventFixture(db, seat.dek, {
    twinId: seat.twinId,
    companyId: seat.companyId,
    seatId: seat.seatId,
    chatJid,
    senderJid: chatJid,
    fromMe: false,
    messageId,
    text,
    occurredAt: overrides.occurredAt ?? SAID_AT,
    ...(overrides.backfill === undefined ? {} : { backfill: overrides.backfill }),
  });
}

/**
 * One REP-AUTHORED message in the same customer chat (ticket #71).
 *
 * The rep's own half of the conversation, which #63 first put into twin
 * memory and which the authorship rule now requires for every fact whose
 * sentence claims the rep acted: a quote, a promise, an accepted order.
 */
async function repMessage(
  seat: Seat,
  messageId: string,
  text: string,
  overrides: { chatJid?: string; occurredAt?: Date } = {},
): Promise<string> {
  const chatJid = overrides.chatJid ?? CUSTOMER_CHAT;
  return insertWaEventFixture(db, seat.dek, {
    twinId: seat.twinId,
    companyId: seat.companyId,
    seatId: seat.seatId,
    chatJid,
    senderJid: SELF_CHAT,
    fromMe: true,
    messageId,
    text,
    occurredAt: overrides.occurredAt ?? SAID_AT,
  });
}

/**
 * One REACTION on the seam — a gesture placed on some message, in either
 * direction (ticket #99; ADR-0041). Its own typed row with its own stanza
 * id: a reaction is not what was said, so it is never a `'message'` row
 * with an emoji in the text.
 */
async function reaction(
  seat: Seat,
  fixture: {
    messageId: string;
    reactionTo: string;
    emoji: string;
    fromMe?: boolean;
    chatJid?: string;
    backfill?: boolean;
    occurredAt?: Date;
  },
): Promise<string> {
  const chatJid = fixture.chatJid ?? CUSTOMER_CHAT;
  const fromMe = fixture.fromMe ?? true;
  return insertWaReactionFixture(db, seat.dek, {
    twinId: seat.twinId,
    companyId: seat.companyId,
    seatId: seat.seatId,
    chatJid,
    senderJid: fromMe ? SELF_CHAT : chatJid,
    fromMe,
    messageId: fixture.messageId,
    reactionTo: fixture.reactionTo,
    emoji: fixture.emoji,
    occurredAt: fixture.occurredAt ?? REACTED_AT,
    ...(fixture.backfill === undefined ? {} : { backfill: fixture.backfill }),
  });
}

/**
 * How many FACT disclosure lines this seat holds.
 *
 * IT IS THE "NOTHING WAS RECORDED" ASSERTION (ticket #218). A stopped
 * candidate reaches no store, and the two stores it could have reached are
 * `ledger.facts` and this one — the question store it once reached is gone
 * with the route. Fact lines only: binding the chat disclosed an entity
 * create of its own (ADR-0003's amendment), and that line is the fixture's.
 */
async function factLines(seat: Seat): Promise<string> {
  const res = await db.query<{ n: string }>(
    `SELECT count(*) AS n FROM disclosure_lines
      WHERE twin_id = $1 AND subject_kind = 'fact'`,
    [seat.twinId],
  );
  return res.rows[0]!.n;
}

/** A bound customer: the entity every fact must attach to (FR-32, absolute). */
async function boundCustomer(seat: Seat, name: string): Promise<string> {
  const entityId = randomUUID();
  const messageId = `WAMID-VA-${entityId.slice(0, 8)}`;
  const sourceEventId = await insertWaEventFixture(db, seat.dek, {
    twinId: seat.twinId,
    companyId: seat.companyId,
    seatId: seat.seatId,
    chatJid: SELF_CHAT,
    senderJid: SELF_CHAT,
    fromMe: true,
    messageId,
    text: "si",
    quotedMessageId: "WAMID-QUESTION",
  });
  await fileEntityCreate(
    apertureCtx(db, seat.dek),
    {
      twinId: seat.twinId,
      entityId,
      kind: "person",
      displayName: name,
      evidence: { surface: "twin_thread", sourceEventId, waMessageId: messageId },
      disclosureText: "Lo di de alta como cliente.",
    },
  );
  return entityId;
}

describe("the aperture files a candidate fact", () => {
  it("files the fact and its disclosure line in one transaction, taking company, seat and valid time off the seam row", async () => {
    const seat = freshSeat();
    const entityId = await boundCustomer(seat, "Ferretería Fuentes");
    // The REP's own message: «Le cotizaste …» is a sentence about the
    // rep's act, so the fact is read in the rep's own words (#71).
    const sourceEventId = await repMessage(
      seat,
      "WAMID-Q1",
      "las 100 cajas le salen en 4,500",
    );

    const outcome = await fileCandidateFact(
      apertureCtx(db, seat.dek),
      {
        twinId: seat.twinId,
        entityId,
        sourceEventId,
        factType: "QuoteGiven",
        payload: { item: "cajas", amount: 4500, currency: "MXN", quantity: 100 },
        confidence: 0.93,
        reading: "stated",
        renderDisclosureLine: () => "Le cotizaste 100 cajas en $4,500 MXN.",
      },
    );

    expect(outcome.filed).toBe(true);
    if (!outcome.filed) return;

    const fact = await db.query(
      `SELECT company_id, entity_id, fact_type, payload_version, payload,
              occurred_at, confidence, source_type, filed_by_twin_id,
              shadow, finalized_at, retracted_at
         FROM ledger.facts WHERE id = $1`,
      [outcome.factId],
    );
    expect(fact.rows[0]).toMatchObject({
      company_id: seat.companyId,
      entity_id: entityId,
      fact_type: "QuoteGiven",
      // 2 since ticket #70's additive `requestedFor`. Per-type (ADR-0034):
      // `DatePromised` and `ContactEstablished` are untouched and still
      // file at 1, which the tests below read back.
      payload_version: 2,
      source_type: "extraction",
      filed_by_twin_id: seat.twinId,
      shadow: true,
      finalized_at: null,
      retracted_at: null,
    });
    // Valid time is WHEN IT WAS SAID, off the seam row — never the pass's
    // own clock, which would be hours later on a restart.
    expect(fact.rows[0]?.["occurred_at"]).toEqual(SAID_AT);
    expect(Number(fact.rows[0]?.["confidence"])).toBeCloseTo(0.93, 3);

    const line = await db.query(
      `SELECT company_id, seat_id, twin_id, subject_kind, fact_id, entity_id,
              rendered_text, source_event_id
         FROM disclosure_lines WHERE id = $1`,
      [outcome.disclosureLineId],
    );
    expect(line.rows[0]).toMatchObject({
      company_id: seat.companyId,
      seat_id: seat.seatId,
      twin_id: seat.twinId,
      subject_kind: "fact",
      fact_id: outcome.factId,
      // The entity is on the LINE now (ticket #52), so the daily post can
      // group by counterparty without reading the Ledger.
      entity_id: entityId,
      rendered_text: "Le cotizaste 100 cajas en $4,500 MXN.",
      source_event_id: sourceEventId,
    });
  });

  it.each(["stated", "resolved_reference"] as const)(
    "DROPS a $0 candidate below the confidence gate — no fact, no line (FR-31; #218)",
    async (reading) => {
      // THE VERDICT THIS TICKET CHANGED. A below-gate candidate became a
      // question and cost the rep a reply; it is dropped now, on the same
      // test that already dropped an unresolved reference. Both readings are
      // driven, because ADR-0039's 2026-09-06 amendment routed the resolved
      // one to a question separately and the question principle supersedes
      // that too: an unsure resolution is still a hole in the twin's record.
      const seat = freshSeat();
      const entityId = await boundCustomer(seat, "Ferretería Fuentes");
      const sourceEventId = await customerMessage(
        seat,
        `WAMID-Q2-${reading}`,
        "unas 100",
      );

      const outcome = await fileCandidateFact(apertureCtx(db, seat.dek), {
        twinId: seat.twinId,
        entityId,
        sourceEventId,
        factType: "OrderRequested",
        payload: { item: "cajas", quantity: 100 },
        confidence: EXTRACTION_CONFIDENCE_THRESHOLD - 0.01,
        reading,
        renderDisclosureLine: () => "Te pidió 100 cajas.",
      });

      expect(outcome).toMatchObject({
        filed: false,
        outcome: "below_threshold",
      });
      const facts = await db.query<{ n: string }>(
        "SELECT count(*) AS n FROM ledger.facts WHERE filed_by_twin_id = $1",
        [seat.twinId],
      );
      expect(facts.rows[0]?.n).toBe("0");
      expect(await factLines(seat)).toBe("0");
    },
  );

  it("files a candidate EXACTLY at the gate — the boundary did not move (#218)", async () => {
    // `confidence < threshold`, so 0.80 crosses. Pinned beside the drop
    // above because the ticket that changed the VERDICT is the one most
    // likely to be read as having changed the NUMBER, and it did not.
    const seat = freshSeat();
    const entityId = await boundCustomer(seat, "Ferretería Fuentes");
    const sourceEventId = await customerMessage(seat, "WAMID-Q2-AT", "100 cajas");

    const outcome = await fileCandidateFact(apertureCtx(db, seat.dek), {
      twinId: seat.twinId,
      entityId,
      sourceEventId,
      factType: "OrderRequested",
      payload: { item: "cajas", quantity: 100 },
      confidence: EXTRACTION_CONFIDENCE_THRESHOLD,
      reading: "stated",
      renderDisclosureLine: () => "Te pidió 100 cajas.",
    });

    expect(outcome.filed).toBe(true);
    expect(await factLines(seat)).toBe("1");
  });

  it("DROPS a candidate the model read as naming something outside the day — no fact, no question, no line (#76)", async () => {
    // THE CASE NO THRESHOLD REACHES, AND THE ONE NO QUESTION SETTLES.
    //
    // #66 measured 88 graded candidates and found every WRONG crossing at
    // 0.95–1.00, with one single candidate in the whole middle band: the
    // extraction prompt asks whether a fact is STATED, and «me mandas lo
    // mismo del pedido pasado» is stated as plainly as any sentence in the
    // corpus. So the confidence is right and useless, and the gate needs
    // the model's other answer — which is why the READING survives #76.
    //
    // What #76 changed is what the aperture DOES with that answer. #66's
    // fix routed it to a question, the rig raised the project's first one,
    // and the rep could not answer it: a «si» files «Te pidió lo mismo del
    // pedido pasado», which is still unresolved and is meaningless as a
    // record. The question's shape (yes/no) does not match the
    // uncertainty's shape — a reference needing a VALUE. So the candidate
    // is DROPPED: FR-31 is precision over recall, and a reference the twin
    // cannot resolve is a fact it cannot honestly record.
    const seat = freshSeat();
    const entityId = await boundCustomer(seat, "Materiales del Valle");
    const sourceEventId = await customerMessage(
      seat,
      "WAMID-REF-1",
      "¿me mandas lo mismo del pedido pasado pero para la otra semana?",
    );

    const outcome = await fileCandidateFact(apertureCtx(db, seat.dek), {
      twinId: seat.twinId,
      entityId,
      sourceEventId,
      factType: "OrderRequested",
      // The counterparty's own words — true as far as they go, and that is
      // exactly the problem: as a Ledger record they name nothing.
      payload: { item: "lo mismo del pedido pasado" },
      // MAXIMALLY CONFIDENT, deliberately: above the gate by the whole of
      // the band the measurement found empty, so nothing about this
      // outcome can be attributed to the threshold.
      confidence: 1,
      reading: "unresolved_reference",
      renderDisclosureLine: () =>
        "Te pidió lo mismo del pedido pasado — sin cantidad, sin precio, sin fecha.",
    });

    expect(outcome).toMatchObject({
      filed: false,
      outcome: "unresolved_reference",
    });
    // BOTH DOORS SHUT. The drop is the whole behaviour, so a fact and a
    // disclosure line are each asserted absent — the only two stores a
    // candidate can reach (ticket #218).
    const facts = await db.query<{ n: string }>(
      "SELECT count(*) AS n FROM ledger.facts WHERE filed_by_twin_id = $1",
      [seat.twinId],
    );
    expect(facts.rows[0]?.n).toBe("0");
    expect(await factLines(seat)).toBe("0");
  });

  it.each([
    { reading: "unresolved_reference" as const, confidence: 1 },
    { reading: "stated" as const, confidence: 0.79 },
    { reading: "resolved_reference" as const, confidence: 0.79 },
  ])(
    "renders nothing at all for a $reading candidate the gate stopped (#76, #218)",
    async ({ reading, confidence }) => {
      // A STOPPED CANDIDATE IS SHOWN TO NOBODY, so nothing renders a sentence
      // for it: the renderer is not called on either of the gate's two
      // endings (ticket #218).
      //
      // IT MATTERS BEYOND TIDINESS. A payload this renderer cannot state
      // throws, and a throw on the way to doing nothing at all would turn a
      // silent drop into a failed extraction.
      const seat = freshSeat();
      const entityId = await boundCustomer(seat, "Materiales del Valle");
      const sourceEventId = await customerMessage(
        seat,
        `WAMID-DROP-${reading}`,
        "mándame lo de siempre",
      );

      let rendered = 0;
      const outcome = await fileCandidateFact(apertureCtx(db, seat.dek), {
        twinId: seat.twinId,
        entityId,
        sourceEventId,
        factType: "OrderRequested",
        payload: { item: "lo de siempre" },
        confidence,
        reading,
        renderDisclosureLine: () => {
          rendered += 1;
          return "Te pidió lo de siempre.";
        },
      });

      expect(outcome).toMatchObject({ filed: false });
      expect(rendered).toBe(0);
    },
  );

  it("crosses a fact whose OPTIONAL fields are absent — the absence is stated, not dropped (#65, #70, #66)", async () => {
    // THE OTHER HALF OF THE SPLIT, and the one that keeps the rep's record
    // useful. A quantity, a price or a day the conversation never stated is
    // the common case by far; #65 and #70 made those absences visible in
    // the line («sin cantidad, sin precio, sin fecha») precisely so the rep
    // meets them inside the correction window. Reading an absent optional
    // field as a reason to stop the candidate would drop most of the day.
    const seat = freshSeat();
    const entityId = await boundCustomer(seat, "Materiales del Valle");
    const sourceEventId = await customerMessage(
      seat,
      "WAMID-REF-2",
      "mándame 40 bultos de mortero",
    );

    const outcome = await fileCandidateFact(apertureCtx(db, seat.dek), {
      twinId: seat.twinId,
      entityId,
      sourceEventId,
      factType: "OrderRequested",
      // No amount, no currency, no day — three absent optional fields.
      payload: { item: "mortero", quantity: 40, unit: "bultos" },
      confidence: 0.95,
      reading: "stated",
      renderDisclosureLine: () =>
        "Te pidió 40 bultos de mortero — sin precio, sin fecha.",
    });

    expect(outcome.filed).toBe(true);
    // ONE LINE, AND IT IS THIS CANDIDATE'S. Absent optional fields do not
    // stop a crossing and do not produce a second record of it.
    expect(await factLines(seat)).toBe("1");
  });

  it("REFUSES a wrong-side candidate whatever the model read, and counts it as a refusal (ticket #71, ADR-0038)", async () => {
    // THE FENCE COMES FIRST, AND THE READING DOES NOT LIFT IT. An
    // `OrderTaken` read in the CUSTOMER's message says «Le confirmaste …»
    // about an agreement the rep never made, and no confidence would make
    // it filable — so it is refused rather than dropped, and the run row's
    // two rates stay statements about different things.
    const seat = freshSeat();
    const entityId = await boundCustomer(seat, "Materiales del Valle");
    const sourceEventId = await customerMessage(
      seat,
      "WAMID-REF-3",
      "¿me mandas lo mismo del pedido pasado?",
    );

    const outcome = await fileCandidateFact(apertureCtx(db, seat.dek), {
      twinId: seat.twinId,
      entityId,
      sourceEventId,
      factType: "OrderTaken",
      payload: { item: "lo mismo del pedido pasado" },
      confidence: 1,
      reading: "unresolved_reference",
      renderDisclosureLine: () => "Le confirmaste el pedido de lo mismo.",
    });

    expect(outcome).toMatchObject({ filed: false, outcome: "refused" });
    if (outcome.filed !== false) return;
    expect(outcome.reason).toContain("ticket #71");
    expect(await factLines(seat)).toBe("0");
  });

  it("refuses a reading outside the closed set the gate reads (#66)", async () => {
    // The same door an unknown `factType` and an ungradeable `confidence`
    // go through. A grading input the aperture cannot read is one it cannot
    // act on, and choosing a direction for it would be choosing on the
    // rep's behalf.
    const seat = freshSeat();
    const entityId = await boundCustomer(seat, "Materiales del Valle");
    const sourceEventId = await customerMessage(seat, "WAMID-REF-4", "unas 100");

    const outcome = await fileCandidateFact(apertureCtx(db, seat.dek), {
      twinId: seat.twinId,
      entityId,
      sourceEventId,
      factType: "OrderRequested",
      payload: { item: "cajas", quantity: 100 },
      confidence: 0.99,
      reading: "probably" as unknown as "stated",
      renderDisclosureLine: () => "Te pidió 100 cajas.",
    });

    expect(outcome).toMatchObject({ filed: false, outcome: "refused" });
    expect(await factLines(seat)).toBe("0");
  });

  it("carries ContactEstablished identifiers structured, multi-valued and normalized from the first row (ADR-0034/0035)", async () => {
    const seat = freshSeat();
    const entityId = await boundCustomer(seat, "Ferretería Fuentes");
    const sourceEventId = await customerMessage(
      seat,
      "WAMID-C1",
      "mi correo es Ana@Ferreteria.MX y el RFC fue930101-ab1",
    );

    const outcome = await fileCandidateFact(
      apertureCtx(db, seat.dek),
      {
        twinId: seat.twinId,
        entityId,
        sourceEventId,
        factType: "ContactEstablished",
        payload: {
          contactName: "Ana",
          identifiers: {
            emails: ["Ana@Ferreteria.MX"],
            rfcs: ["fue930101-ab1"],
            phones: ["81 8000 1111"],
          },
        },
        confidence: 0.97,
        reading: "stated",
        renderDisclosureLine: () => "Guardé sus datos de contacto.",
      },
    );

    expect(outcome.filed).toBe(true);
    if (!outcome.filed) return;
    const fact = await db.query<{ payload: Record<string, unknown> }>(
      "SELECT payload FROM ledger.facts WHERE id = $1",
      [outcome.factId],
    );
    expect(fact.rows[0]?.payload).toEqual({
      contactName: "Ana",
      identifiers: {
        phones: ["+528180001111"],
        emails: ["ana@ferreteria.mx"],
        rfcs: ["FUE930101AB1"],
      },
    });
  });

  it("refuses the counterparty's own WhatsApp number as an identifier — that is chat identity, not a business fact (ADR-0004)", async () => {
    const seat = freshSeat();
    const entityId = await boundCustomer(seat, "Ferretería Fuentes");
    const sourceEventId = await customerMessage(
      seat,
      "WAMID-C2",
      "márcame al 55 1234 5678",
    );

    const outcome = await fileCandidateFact(
      apertureCtx(db, seat.dek),
      {
        twinId: seat.twinId,
        entityId,
        sourceEventId,
        // 5215512345678@s.whatsapp.net IS this chat — the same subscriber.
        factType: "ContactEstablished",
        payload: { identifiers: { phones: ["55 1234 5678"] } },
        confidence: 0.99,
        reading: "stated",
        renderDisclosureLine: () => "Guardé su teléfono.",
      },
    );

    expect(outcome).toMatchObject({ filed: false, outcome: "refused" });
    if (outcome.filed) return;
    expect(outcome.reason).toMatch(/chat identity/i);
  });

  it("refuses the counterparty's own number written as prose in ANY payload, not only as an identifier (Codex r1)", async () => {
    const seat = freshSeat();
    const entityId = await boundCustomer(seat, "Ferretería Fuentes");
    const sourceEventId = await repMessage(
      seat,
      "WAMID-C3",
      "entrega al 55 1234 5678",
    );

    const outcome = await fileCandidateFact(
      apertureCtx(db, seat.dek),
      {
        twinId: seat.twinId,
        entityId,
        sourceEventId,
        // Not a ContactEstablished, and punctuated the way a person writes
        // a number — so neither the identifier check nor a literal digit
        // search would see it.
        factType: "DatePromised",
        // With a trailing extension, so a suffix comparison would walk
        // straight past the number (Codex r2).
        payload: { commitment: "que entregas al 55 1234 5678 ext. 204" },
        confidence: 0.99,
        reading: "stated",
        renderDisclosureLine: () => "Le confirmaste el sábado.",
      },
    );

    expect(outcome).toMatchObject({ filed: false, outcome: "refused" });
    if (outcome.filed) return;
    expect(outcome.reason).toMatch(/chat identity/i);
  });

  it("refuses a fact type outside the closed set — the vocabulary is the aperture's, not the caller's", async () => {
    const seat = freshSeat();
    const entityId = await boundCustomer(seat, "Ferretería Fuentes");
    const sourceEventId = await customerMessage(seat, "WAMID-P1", "siempre pide los viernes");

    const outcome = await fileCandidateFact(
      apertureCtx(db, seat.dek),
      {
        twinId: seat.twinId,
        entityId,
        sourceEventId,
        // A type the closed set has never carried. `CustomerPattern` stood
        // here until ticket #61 gave it a shape; the claim the test makes
        // is about the SET being closed, so it needs a value outside it.
        factType: "RepTactic" as never,
        payload: { note: "pide los viernes" },
        confidence: 0.99,
        reading: "stated",
        renderDisclosureLine: () => "no",
      },
    );

    expect(outcome).toMatchObject({ filed: false, outcome: "refused" });
  });

  it("refuses a claim read in backfilled history — the window is the day, and history is never re-extracted", async () => {
    const seat = freshSeat();
    const entityId = await boundCustomer(seat, "Ferretería Fuentes");
    const sourceEventId = await customerMessage(
      seat,
      "WAMID-H1",
      "te confirmo el sábado",
      { backfill: true },
    );

    const outcome = await fileCandidateFact(
      apertureCtx(db, seat.dek),
      {
        twinId: seat.twinId,
        entityId,
        sourceEventId,
        factType: "DatePromised",
        payload: { commitment: "entrega el sábado" },
        confidence: 0.99,
        reading: "stated",
        renderDisclosureLine: () => "Le confirmaste el sábado.",
      },
    );

    expect(outcome).toMatchObject({ filed: false, outcome: "refused" });
  });

  it("refuses a source event belonging to another twin — scope is read off the seam row, never from a caller", async () => {
    const seat = freshSeat();
    const other = freshSeat();
    const entityId = await boundCustomer(seat, "Ferretería Fuentes");
    const foreign = await customerMessage(other, "WAMID-X1", "hola");

    const outcome = await fileCandidateFact(
      apertureCtx(db, seat.dek),
      {
        twinId: seat.twinId,
        entityId,
        sourceEventId: foreign,
        factType: "DatePromised",
        payload: { commitment: "entrega el sábado" },
        confidence: 0.99,
        reading: "stated",
        renderDisclosureLine: () => "Le confirmaste el sábado.",
      },
    );

    expect(outcome).toMatchObject({ filed: false, outcome: "refused" });
  });

  it("refuses a payload carrying a WhatsApp address — no chat identity crosses, checked before it is written (ADR-0004)", async () => {
    const seat = freshSeat();
    const entityId = await boundCustomer(seat, "Ferretería Fuentes");
    const sourceEventId = await customerMessage(seat, "WAMID-J1", "soy yo");

    const outcome = await fileCandidateFact(
      apertureCtx(db, seat.dek),
      {
        twinId: seat.twinId,
        entityId,
        sourceEventId,
        factType: "DatePromised",
        payload: {
          commitment: "entrega para 5215599990000@s.whatsapp.net el sábado",
        },
        confidence: 0.99,
        reading: "stated",
        renderDisclosureLine: () => "Le confirmaste el sábado.",
      },
    );

    expect(outcome).toMatchObject({ filed: false, outcome: "refused" });
  });

  it("refuses a date that is not a day — Date.parse rolls 30 February forward rather than refusing it (Codex r3)", async () => {
    const seat = freshSeat();
    const entityId = await boundCustomer(seat, "Ferretería Fuentes");
    const sourceEventId = await repMessage(seat, "WAMID-D1", "el 30 de feb");

    for (const dueOn of ["2026-02-30", "2026-04-31", "2027-02-29"]) {
      const outcome = await fileCandidateFact(
        apertureCtx(db, seat.dek),
        {
          twinId: seat.twinId,
          entityId,
          sourceEventId,
          factType: "DatePromised",
          payload: { commitment: "que entregas", dueOn },
          confidence: 0.99,
          reading: "stated",
          renderDisclosureLine: () => "Le confirmaste la entrega.",
        },
      );
      expect(outcome, dueOn).toMatchObject({ filed: false, outcome: "refused" });
    }

    // ...and a leap day that exists still files.
    const leap = await fileCandidateFact(
      apertureCtx(db, seat.dek),
      {
        twinId: seat.twinId,
        entityId,
        sourceEventId,
        factType: "DatePromised",
        payload: { commitment: "que entregas", dueOn: "2028-02-29" },
        confidence: 0.99,
        reading: "stated",
        renderDisclosureLine: () => "Le confirmaste la entrega.",
      },
    );
    expect(leap.filed).toBe(true);
  });

  /**
   * THE DATED ORDER (ticket #70). «te pido 100 cajas para el lunes» states
   * an order AND the day it is wanted for, and the day used to have
   * nowhere to go: `DatePromised` is the REP's own commitment — the corpus
   * labels a customer-proposed date silent so no crossing files a promise
   * before the rep made one — and `QuoteGiven`/`OrderTaken` v1 carried no
   * date field at all. So the order crossed dateless.
   *
   * `requestedFor` is that day, and it is an ADDITIVE v2 (ADR-0034): the
   * two commercial types step to `payload_version = 2`, `DatePromised` and
   * `ContactEstablished` stay at 1 — per-type evolution, so nothing
   * already stored is restructured or even re-read.
   *
   * The type this day files is `OrderRequested` since #71 — the customer
   * asking — and `requestedFor` reads the same on it, which is the point:
   * the field says which day, never requested-versus-agreed.
   */
  it("stores the day a dated order is wanted for, stamped as the additive v2 shape (ADR-0034)", async () => {
    const seat = freshSeat();
    const entityId = await boundCustomer(seat, "Ferretería Fuentes");
    const sourceEventId = await customerMessage(
      seat,
      "WAMID-O70",
      "te pido 100 cajas para el lunes",
    );

    const outcome = await fileCandidateFact(apertureCtx(db, seat.dek), {
      twinId: seat.twinId,
      entityId,
      sourceEventId,
      factType: "OrderRequested",
      payload: { item: "cajas", quantity: 100, requestedFor: "2026-08-31" },
      confidence: 0.93,
      reading: "stated",
      renderDisclosureLine: () => "Te pidió 100 cajas para el lunes.",
    });

    expect(outcome.filed).toBe(true);
    if (!outcome.filed) return;
    expect(outcome.fact.payload).toEqual({
      item: "cajas",
      quantity: 100,
      requestedFor: "2026-08-31",
    });
    expect(outcome.fact.payloadVersion).toBe(2);

    const stored = await db.query<{
      payload_version: number;
      payload: Record<string, unknown>;
    }>("SELECT payload_version, payload FROM ledger.facts WHERE id = $1", [
      outcome.factId,
    ]);
    expect(stored.rows[0]).toMatchObject({
      payload_version: 2,
      payload: { requestedFor: "2026-08-31" },
    });

    // PER-TYPE, and this is the half that proves it: the type that did not
    // change did not move. A single global stamp would have dragged
    // `DatePromised` to 2 for a field it never gained.
    const promised = await repMessage(
      seat,
      "WAMID-O70B",
      "va, se las envío el lunes",
    );
    const promise = await fileCandidateFact(apertureCtx(db, seat.dek), {
      twinId: seat.twinId,
      entityId,
      sourceEventId: promised,
      factType: "DatePromised",
      payload: { commitment: "enviar las cajas", dueOn: "2026-08-31" },
      confidence: 0.93,
      reading: "stated",
      renderDisclosureLine: () => "Le confirmaste enviar las cajas.",
    });
    expect(promise.filed).toBe(true);
    if (!promise.filed) return;
    expect(promise.fact.payloadVersion).toBe(1);
  });

  /**
   * ABSENT IS NOT RECORDED THEN, never a default (ADR-0034). An order
   * whose message states no day stores no `requestedFor` at all — the
   * aperture never reaches for the message's own date, or today's, to fill
   * it. The disclosure line is what tells the rep so, and it can only tell
   * them if the field is genuinely absent rather than defaulted.
   *
   * The same round-trip calendar check `dueOn` gets: `Date.parse` rolls
   * 30 February forward, so a shape check alone would store an impossible
   * day in an append-only payload ADR-0034 forbids rewriting.
   */
  it("never defaults an undated order's day, and refuses one that is not a real day", async () => {
    const seat = freshSeat();
    const entityId = await boundCustomer(seat, "Ferretería Fuentes");
    const sourceEventId = await customerMessage(
      seat,
      "WAMID-O71",
      "te pido 100 cajas",
    );

    const undated = await fileCandidateFact(apertureCtx(db, seat.dek), {
      twinId: seat.twinId,
      entityId,
      sourceEventId,
      factType: "OrderRequested",
      payload: { item: "cajas", quantity: 100 },
      confidence: 0.93,
      reading: "stated",
      renderDisclosureLine: () => "Te pidió 100 cajas — sin fecha.",
    });
    expect(undated.filed).toBe(true);
    if (!undated.filed) return;
    expect(undated.fact.payload).toEqual({ item: "cajas", quantity: 100 });
    expect(undated.fact.payload["requestedFor"]).toBeUndefined();

    // A value that is not a string at all is ABSENT rather than a refusal,
    // and that is this file's own convention rather than an oversight
    // (Codex r2 argued the opposite): `positive`, `text` and `currencyCode`
    // each drop an unreadable optional field, and the disclosure line then
    // states the absence. Refusing here would instead destroy the whole
    // crossing — item, quantity and price — over one mistyped day, and the
    // rep would never see the order at all, which is worse on exactly the
    // correction-window axis this ticket exists to serve. ADR-0034 holds
    // either way: the Ledger genuinely records no day.
    for (const requestedFor of [20260831, true, { day: "2026-08-31" }, [], ""]) {
      const loose = await fileCandidateFact(apertureCtx(db, seat.dek), {
        twinId: seat.twinId,
        entityId,
        sourceEventId,
        factType: "OrderRequested",
        payload: { item: "cajas", quantity: 100, requestedFor },
        confidence: 0.93,
        reading: "stated",
        renderDisclosureLine: () => "Te pidió 100 cajas — sin fecha.",
      });
      expect(loose.filed, JSON.stringify(requestedFor)).toBe(true);
      if (!loose.filed) return;
      expect(loose.fact.payload).toEqual({ item: "cajas", quantity: 100 });
    }

    // A malformed STRING is the one exception, and it is a hard refusal:
    // `2026-02-30` would otherwise be stored verbatim in an append-only
    // payload that ADR-0034 forbids rewriting.
    //
    // `0000-01-01` rides with them (Codex r3). It is a REAL ISO date and
    // round-trips perfectly, so only an explicit rule keeps it out — and it
    // has to be kept out, because the disclosure renders a bare year with
    // no era and ISO year 0 is 1 BC, so the rep would read «1 de enero de
    // 1» for a day the Ledger stores as year 0, and could not tell it from
    // `0001-01-01`. Stored and disclosed must be the same value or the
    // correction window is blind.
    for (const requestedFor of [
      "2026-02-30",
      "el lunes",
      "2026-08-31T00:00:00Z",
      "0000-01-01",
    ]) {
      const outcome = await fileCandidateFact(apertureCtx(db, seat.dek), {
        twinId: seat.twinId,
        entityId,
        sourceEventId,
        factType: "OrderRequested",
        payload: { item: "cajas", quantity: 100, requestedFor },
        confidence: 0.93,
        reading: "stated",
        renderDisclosureLine: () => "Te pidió 100 cajas.",
      });
      expect(outcome, requestedFor).toMatchObject({
        filed: false,
        outcome: "refused",
      });
    }
  });

  /**
   * A currency with no amount is not a price, and the aperture already
   * says so in the other direction («a bare number is not a price»). It
   * used to keep the orphan half, which put a field on the far side of the
   * wall that no disclosure line ever names — a field that crossed and
   * cannot be corrected, which is ticket #65's whole subject. The
   * symmetric rule drops it, so «sin precio» is the whole truth.
   */
  it("does not store a currency with no amount — half a price is not a field the disclosure can state (#65)", async () => {
    const seat = freshSeat();
    const entityId = await boundCustomer(seat, "Ferretería Fuentes");
    const sourceEventId = await repMessage(seat, "WAMID-C9", "se las dejo en pesos");

    const outcome = await fileCandidateFact(apertureCtx(db, seat.dek), {
      twinId: seat.twinId,
      entityId,
      sourceEventId,
      factType: "QuoteGiven",
      payload: { item: "cajas", currency: "MXN" },
      confidence: 0.99,
      reading: "stated",
      renderDisclosureLine: () => "Le cotizaste cajas.",
    });

    expect(outcome.filed).toBe(true);
    if (!outcome.filed) return;
    expect(outcome.fact.payload).toEqual({ item: "cajas" });

    // ...and the refusal in the other direction still stands: dropping the
    // orphan currency must not turn "an amount with no currency" into a
    // filed bare number.
    const bare = await fileCandidateFact(apertureCtx(db, seat.dek), {
      twinId: seat.twinId,
      entityId,
      sourceEventId,
      factType: "QuoteGiven",
      payload: { item: "cajas", amount: 4500 },
      confidence: 0.99,
      reading: "stated",
      renderDisclosureLine: () => "Le cotizaste cajas.",
    });
    expect(bare).toMatchObject({ filed: false, outcome: "refused" });
  });

  it("refuses a fact whose entity was never filed — every fact attaches to exactly one entity (FR-32)", async () => {
    const seat = freshSeat();
    const sourceEventId = await repMessage(seat, "WAMID-N1", "va");

    await expect(
      fileCandidateFact(
        apertureCtx(db, seat.dek),
        {
          twinId: seat.twinId,
          entityId: randomUUID(),
          sourceEventId,
          factType: "DatePromised",
          payload: { commitment: "entrega el sábado" },
          confidence: 0.99,
          reading: "stated",
          renderDisclosureLine: () => "Le confirmaste el sábado.",
        },
      ),
    ).rejects.toThrow();
  });

  it("renders the disclosure line from the payload it NORMALIZED, never from the model's own text", async () => {
    const seat = freshSeat();
    const entityId = await boundCustomer(seat, "Ferretería Fuentes");
    const sourceEventId = await customerMessage(seat, "WAMID-R1", "mi correo Ana@X.MX");

    const seen: unknown[] = [];
    const outcome = await fileCandidateFact(
      apertureCtx(db, seat.dek),
      {
        twinId: seat.twinId,
        entityId,
        sourceEventId,
        factType: "ContactEstablished",
        payload: { identifiers: { emails: ["Ana@X.MX"] } },
        confidence: 0.99,
        reading: "stated",
        renderDisclosureLine: (fact) => {
          seen.push(fact.payload);
          return "Guardé su correo.";
        },
      },
    );

    expect(outcome.filed).toBe(true);
    expect(seen).toEqual([
      { identifiers: { phones: [], emails: ["ana@x.mx"], rfcs: [] } },
    ]);
  });
});

/**
 * THE SPLIT (ticket #71; ADR-0038). `OrderRequested` is the customer
 * asking; `OrderTaken` is the customer asking AND the business agreeing.
 * Two independent events, neither becoming the other.
 */
describe("an order requested and an order taken are two different facts (#71)", () => {
  it("files an OrderRequested from the customer's own message, stamped as the commercial v2 shape", async () => {
    const seat = freshSeat();
    const entityId = await boundCustomer(seat, "Ferretería Fuentes");
    const sourceEventId = await customerMessage(
      seat,
      "WAMID-OR1",
      "te pido 100 cajas para el lunes",
    );

    const outcome = await fileCandidateFact(apertureCtx(db, seat.dek), {
      twinId: seat.twinId,
      entityId,
      sourceEventId,
      factType: "OrderRequested",
      payload: { item: "cajas", quantity: 100, requestedFor: "2026-08-31" },
      confidence: 0.95,
      reading: "stated",
      renderDisclosureLine: () => "Te pidió 100 cajas para el lunes.",
    });

    expect(outcome.filed).toBe(true);
    if (!outcome.filed) return;
    // `requestedFor` SURVIVES THE SPLIT UNCHANGED (#70): it says which
    // day, never requested-versus-agreed, so the new type inherits the
    // commercial shape and its stamp rather than starting a shape of its
    // own.
    expect(outcome.fact.payload).toEqual({
      item: "cajas",
      quantity: 100,
      requestedFor: "2026-08-31",
    });
    expect(outcome.fact.payloadVersion).toBe(2);

    const stored = await db.query<{
      fact_type: string;
      payload_version: number;
    }>("SELECT fact_type, payload_version FROM ledger.facts WHERE id = $1", [
      outcome.factId,
    ]);
    expect(stored.rows[0]).toMatchObject({
      fact_type: "OrderRequested",
      payload_version: 2,
    });
  });

  /**
   * THE AGREEMENT IS QUOTED, AND THE QUOTE IS MATCHED AGAINST THE PLANE'S
   * OWN BYTES. `OrderTaken` v3 requires the rep's own words, copied
   * exactly from the message the fact is read in — and the aperture
   * re-reads that message and checks the words are really in it.
   *
   * That check is the whole point. #66 measured every wrong crossing in
   * the corpus arriving at 0.95–1.00, so nothing downstream of the model
   * can be trusted to notice a wrong agreement; a model cannot produce a
   * row on the seam, so matching its quote against one is the same
   * defence ADR-0003 uses for a class-2 rep act.
   */
  it("files an OrderTaken only from the rep's own affirming message, carrying the words that agreed", async () => {
    const seat = freshSeat();
    const entityId = await boundCustomer(seat, "Ferretería Fuentes");
    const agreed = await repMessage(
      seat,
      "WAMID-OT1",
      "va, se los mando el lunes",
    );

    const outcome = await fileCandidateFact(apertureCtx(db, seat.dek), {
      twinId: seat.twinId,
      entityId,
      sourceEventId: agreed,
      factType: "OrderTaken",
      payload: { item: "cajas", quantity: 100 },
      confidence: 0.95,
      reading: "stated",
      renderDisclosureLine: () => "Le confirmaste el pedido de 100 cajas.",
    });

    expect(outcome.filed).toBe(true);
    if (!outcome.filed) return;
    expect(outcome.fact.payload).toEqual({
      item: "cajas",
      quantity: 100,
      agreement: "va, se los mando el lunes",
    });
    // v3, and the number is burned rather than reused: the two earlier
    // stamps belong to the meaning this type no longer has (ADR-0038).
    expect(outcome.fact.payloadVersion).toBe(3);
  });

  /**
   * THE CONDITION CANNOT BE CLIPPED OFF (Codex r2).
   *
   * «si el proveedor me surte mañana, sí. si no, hasta la otra semana» is
   * the corpus's own conditional day, labelled silent because the rep
   * promised nothing. A model reading the «sí» out of the middle of it
   * would have filed an order, and the line would have read «Dijiste:
   * «sí».» — the disqualifying half deleted, at 0.95 confidence, with no
   * gate underneath (#66). The evidence is therefore the rep's WHOLE
   * message, taken off the seam row rather than chosen: there is no span
   * to clip, and the rep reads the condition in the line they can correct.
   */
  it("carries the rep's whole message as the evidence, so a condition cannot be quoted away", async () => {
    const seat = freshSeat();
    const entityId = await boundCustomer(seat, "Ferretería Fuentes");
    const conditional =
      "si el proveedor me surte mañana, sí. si no, hasta la otra semana";
    const hedged = await repMessage(seat, "WAMID-OT5", conditional);

    const outcome = await fileCandidateFact(apertureCtx(db, seat.dek), {
      twinId: seat.twinId,
      entityId,
      sourceEventId: hedged,
      factType: "OrderTaken",
      // What a model clipping its evidence would have submitted.
      payload: { item: "cajas", quantity: 100, agreement: "sí" },
      confidence: 1,
      reading: "stated",
      renderDisclosureLine: (fact) => String(fact.payload["agreement"]),
    });

    expect(outcome.filed).toBe(true);
    if (!outcome.filed) return;
    // The model's own span is discarded; the message itself is what crossed.
    expect(outcome.fact.payload["agreement"]).toBe(conditional);
  });

  /**
   * THE 100/80 CASE, which is the whole reason the two lines are not one
   * (ticket #71 decision 3; Codex r2). A customer asks for 100 and a rep
   * agrees to 80: two facts, filed independently on two messages, with
   * DIFFERENT quantities. One collapsed line would hide exactly the
   * discrepancy the correction window exists to expose — and neither fact
   * knows about the other, which is the append-only shape.
   */
  it("files a request and a partial agreement as two facts carrying different numbers", async () => {
    const seat = freshSeat();
    const entityId = await boundCustomer(seat, "Ferretería Fuentes");
    const ctx = apertureCtx(db, seat.dek);
    const asked = await customerMessage(seat, "WAMID-PA1", "mándeme 100 cajas");
    const agreed = await repMessage(
      seat,
      "WAMID-PA2",
      "solo tengo 80, se las mando el lunes",
    );

    const request = await fileCandidateFact(ctx, {
      twinId: seat.twinId,
      entityId,
      sourceEventId: asked,
      factType: "OrderRequested",
      payload: { item: "cajas", quantity: 100 },
      confidence: 0.95,
      reading: "stated",
      renderDisclosureLine: () => "Te pidió 100 cajas — sin precio, sin fecha.",
    });
    const taken = await fileCandidateFact(ctx, {
      twinId: seat.twinId,
      entityId,
      sourceEventId: agreed,
      factType: "OrderTaken",
      payload: { item: "cajas", quantity: 80 },
      confidence: 0.95,
      reading: "stated",
      renderDisclosureLine: () =>
        "Le confirmaste el pedido de 80 cajas — sin precio, sin fecha. Dijiste: «solo tengo 80, se las mando el lunes».",
    });

    expect(request.filed).toBe(true);
    expect(taken.filed).toBe(true);
    if (!request.filed || !taken.filed) return;
    expect(request.fact.payload["quantity"]).toBe(100);
    expect(taken.fact.payload["quantity"]).toBe(80);

    // Two rows, two lines, and NOTHING joining them: no column on either
    // points at the other, which is what "two independent events" means in
    // the store rather than in prose.
    const rows = await db.query<{ id: string; fact_type: string }>(
      `SELECT id, fact_type FROM ledger.facts
        WHERE filed_by_twin_id = $1 ORDER BY fact_type`,
      [seat.twinId],
    );
    expect(rows.rows.map((r) => r.fact_type)).toEqual([
      "OrderRequested",
      "OrderTaken",
    ]);
    const lines = await db.query<{ n: string }>(
      "SELECT count(*) AS n FROM disclosure_lines WHERE fact_id = ANY($1::uuid[])",
      [[request.factId, taken.factId]],
    );
    expect(lines.rows[0]?.n).toBe("2");
  });

  it("refuses an OrderTaken whose evidence is longer than a payload field may hold", async () => {
    const seat = freshSeat();
    const entityId = await boundCustomer(seat, "Ferretería Fuentes");
    const rambling = await repMessage(seat, "WAMID-OT6", `va, se los mando. ${"y otra cosa ".repeat(30)}`);

    const outcome = await fileCandidateFact(apertureCtx(db, seat.dek), {
      twinId: seat.twinId,
      entityId,
      sourceEventId: rambling,
      factType: "OrderTaken",
      payload: { item: "cajas", quantity: 100 },
      confidence: 1,
      reading: "stated",
      renderDisclosureLine: () => "Le confirmaste el pedido de 100 cajas.",
    });

    expect(outcome).toMatchObject({ filed: false, outcome: "refused" });
  });


});

/**
 * A 👍 CAN CARRY AN `OrderTaken` (ticket #99; ADR-0041, ADR-0038 as
 * amended).
 *
 * The most common way a rep says yes on WhatsApp is a gesture rather than
 * words, and ADR-0038 recorded that blindness as an under-filing bias. It
 * is repealed here: the model cites the REACTION's row like any message
 * id, and deterministic code does the rest — reads the row back, takes the
 * target pointer OFF THE ROW, reads the target back out of the seam, and
 * composes the two into the evidence the disclosure line renders.
 *
 * Nothing the model says about the target or about the words is used, so
 * every test below asserts the payload against what was PUT ON THE SEAM,
 * never against what the candidate claimed.
 */
describe("a rep's reaction is admissible agreement evidence (#99)", () => {
  const ASK = "¿me mandas 20 bultos?";

  /**
   * Fresh stanza ids per test. The seam's dedupe is `(source,
   * external_event_id)` and that id is `<chat jid>:<message id>` — GLOBAL,
   * not per twin — so two tests in one chat cannot reuse a stanza id even
   * with a seat each.
   */
  let stanza = 0;
  function ids(): { ask: string; gesture: string } {
    stanza += 1;
    return { ask: `WAMID-99-ASK-${stanza}`, gesture: `WAMID-99-R-${stanza}` };
  }

  /** The candidate a model would submit citing a gesture — no evidence in it. */
  function gestureCandidate(
    seat: Seat,
    entityId: string,
    sourceEventId: string,
    payload: Readonly<Record<string, unknown>> = { item: "bultos", quantity: 20 },
  ) {
    return fileCandidateFact(apertureCtx(db, seat.dek), {
      twinId: seat.twinId,
      entityId,
      sourceEventId,
      factType: "OrderTaken" as const,
      payload,
      confidence: 0.95,
      reading: "stated" as const,
      renderDisclosureLine: () => "Le confirmaste el pedido de 20 bultos.",
    });
  }

  /**
   * THE WHOLE CROSSING, off two seam rows and nothing else. The emoji is
   * the rep's act and the target's WHOLE message is what they agreed to —
   * the same "no span to clip" rule ADR-0038 gives the spoken case, one
   * message further along.
   */
  it("files an OrderTaken from a rep's 👍, carrying the emoji and the whole message it points at", async () => {
    const seat = freshSeat();
    const entityId = await boundCustomer(seat, "Ferretería Fuentes");
    const id = ids();
    await customerMessage(seat, id.ask, ASK);
    const gesture = await reaction(seat, {
      messageId: id.gesture,
      reactionTo: id.ask,
      emoji: "👍",
    });

    const outcome = await gestureCandidate(seat, entityId, gesture);

    expect(outcome.filed).toBe(true);
    if (!outcome.filed) return;
    expect(outcome.fact.payload).toEqual({
      item: "bultos",
      quantity: 20,
      agreement: ASK,
      agreementGesture: "👍",
    });
    // v3, unmoved: `agreementGesture` is an ADDITIVE optional field, absent
    // on every message-evidenced fact, so no reader of an existing row
    // changes meaning (ADR-0034).
    expect(outcome.fact.payloadVersion).toBe(3);
    // The fact is dated when the GESTURE landed — the instant the business
    // agreed — not when the customer asked. Two events, two instants
    // (ADR-0038).
    expect(outcome.fact.occurredAt).toEqual(REACTED_AT);
  });

  /**
   * THE FIELD IS ADDITIVE, and this is what that claims in the store: a
   * spoken agreement's payload is exactly what it was before this ticket.
   * ADR-0034's rule is that a new field is optional and an absent one
   * means NOT RECORDED THEN — so a reader meeting a row with no
   * `agreementGesture` is reading words, which is what every `OrderTaken`
   * row that exists is.
   */
  it("leaves the gesture field off a spoken agreement, so no existing row changes meaning", async () => {
    const seat = freshSeat();
    const entityId = await boundCustomer(seat, "Ferretería Fuentes");
    const said = await repMessage(seat, "WAMID-99-SAID", "va, se los mando");

    const outcome = await gestureCandidate(seat, entityId, said);

    expect(outcome.filed).toBe(true);
    if (!outcome.filed) return;
    expect(outcome.fact.payload).toEqual({
      item: "bultos",
      quantity: 20,
      agreement: "va, se los mando",
    });
    expect(outcome.fact.payload).not.toHaveProperty("agreementGesture");
  });

  /**
   * NOTHING THE MODEL SAID ABOUT THE GESTURE IS USED — not the target it
   * names, not the words it quotes (ADR-0003 as amended: determinism binds
   * the evidence and the target, never the intent).
   *
   * The candidate here points at a DIFFERENT message in the same chat and
   * quotes words of its own choosing, which is precisely the laundering
   * shape #71 closed for the spoken case. The row's own pointer wins, and
   * the model's is discarded exactly as `agreement` already is.
   */
  it("ignores a target pointer and a quotation supplied by the model — the row's pointer wins", async () => {
    const seat = freshSeat();
    const entityId = await boundCustomer(seat, "Ferretería Fuentes");
    const id = ids();
    await customerMessage(seat, id.ask, ASK);
    // A second, innocuous message in the same chat: what a model would
    // point the gesture at if it could.
    await customerMessage(seat, `${id.ask}-B`, "gracias, muy amable");
    const gesture = await reaction(seat, {
      messageId: id.gesture,
      reactionTo: id.ask,
      emoji: "👍",
    });

    const outcome = await gestureCandidate(seat, entityId, gesture, {
      item: "bultos",
      quantity: 20,
      agreement: "sí, claro que sí",
      agreementGesture: "🎉",
      reactionTo: `${id.ask}-B`,
      targetText: "gracias, muy amable",
    });

    expect(outcome.filed).toBe(true);
    if (!outcome.filed) return;
    expect(outcome.fact.payload).toEqual({
      item: "bultos",
      quantity: 20,
      agreement: ASK,
      agreementGesture: "👍",
    });
  });

  /**
   * A RETRACTION IS NOT AN AGREEMENT. The rail's removal is the empty
   * emoji, and citing one as the yes is an evidence-SHAPE error rather
   * than a reading — the row says the rep took the gesture back. Refused
   * deterministically, and the customer's own request stands.
   */
  it("refuses a REMOVED reaction cited as the agreement", async () => {
    const seat = freshSeat();
    const entityId = await boundCustomer(seat, "Ferretería Fuentes");
    const id = ids();
    await customerMessage(seat, id.ask, ASK);
    const removal = await reaction(seat, {
      messageId: id.gesture,
      reactionTo: id.ask,
      emoji: "",
    });

    const outcome = await gestureCandidate(seat, entityId, removal);

    expect(outcome).toMatchObject({ filed: false, outcome: "refused" });
    if (outcome.filed || outcome.outcome !== "refused") return;
    expect(outcome.reason).toContain("REMOVED reaction");
  });

  /**
   * R3, AND IT IS THE MODEL'S CALL (ticket #72's ruling, carried here). A
   * 👍 and its later removal are two beats in the transcript (#98), and
   * whether the agreement STANDS is what the model reads from them — there
   * is no deterministic retraction block, and this test documents its
   * absence rather than its presence.
   *
   * The aperture's rule is narrower and stays: the row you CITE must be a
   * gesture that was placed. What happened afterwards is a reading.
   */
  it("files an OrderTaken on a 👍 that was later removed — a retraction is the model's reading, not an aperture rule", async () => {
    const seat = freshSeat();
    const entityId = await boundCustomer(seat, "Ferretería Fuentes");
    const id = ids();
    await customerMessage(seat, id.ask, ASK);
    const placed = await reaction(seat, {
      messageId: id.gesture,
      reactionTo: id.ask,
      emoji: "👍",
    });
    await reaction(seat, {
      messageId: `${id.gesture}-OFF`,
      reactionTo: id.ask,
      emoji: "",
      occurredAt: new Date(REACTED_AT.getTime() + 60_000),
    });

    const outcome = await gestureCandidate(seat, entityId, placed);

    expect(outcome.filed).toBe(true);
    if (!outcome.filed) return;
    expect(outcome.fact.payload["agreementGesture"]).toBe("👍");
  });

  /**
   * THE AUTHORSHIP FENCE HOLDS FOR A GESTURE (ADR-0038). «Le confirmaste
   * el pedido …» names the rep, and a customer's 👍 on the rep's own quote
   * is the customer agreeing — a different fact, in the other direction,
   * and this sentence about it would be false in the one way the rep
   * cannot see.
   */
  it("refuses a CUSTOMER's reaction cited as the rep's agreement", async () => {
    const seat = freshSeat();
    const entityId = await boundCustomer(seat, "Ferretería Fuentes");
    const id = ids();
    await repMessage(seat, id.ask, "se los dejo en 4,500");
    const gesture = await reaction(seat, {
      messageId: id.gesture,
      reactionTo: id.ask,
      emoji: "👍",
      fromMe: false,
    });

    const outcome = await gestureCandidate(seat, entityId, gesture);

    expect(outcome).toMatchObject({ filed: false, outcome: "refused" });
    if (outcome.filed || outcome.outcome !== "refused") return;
    expect(outcome.reason).toContain("claims the rep acted");
  });

  /**
   * BACKFILL IS BACKFILL WHATEVER THE EVENT TYPE (ADR-0041: extraction
   * "skips the marker as it always has"). A gesture the plane normalized
   * out of a history blob is not this day's agreement.
   */
  it("refuses a BACKFILLED reaction", async () => {
    const seat = freshSeat();
    const entityId = await boundCustomer(seat, "Ferretería Fuentes");
    const id = ids();
    await customerMessage(seat, id.ask, ASK);
    const gesture = await reaction(seat, {
      messageId: id.gesture,
      reactionTo: id.ask,
      emoji: "👍",
      backfill: true,
    });

    const outcome = await gestureCandidate(seat, entityId, gesture);

    expect(outcome).toMatchObject({ filed: false, outcome: "refused" });
    if (outcome.filed || outcome.outcome !== "refused") return;
    expect(outcome.reason).toContain("backfilled history");
  });

  /**
   * A POINTER THE APERTURE CANNOT FOLLOW IS NOT EVIDENCE — and the
   * `OrderRequested` the customer really did place stands, which is
   * ADR-0038's under-filing direction stated in the store rather than in
   * prose.
   */
  it("refuses a gesture whose target never crossed, and leaves the request standing", async () => {
    const seat = freshSeat();
    const entityId = await boundCustomer(seat, "Ferretería Fuentes");
    const id = ids();
    const asked = await customerMessage(seat, id.ask, ASK);
    const gesture = await reaction(seat, {
      messageId: id.gesture,
      reactionTo: `${id.ask}-GHOST`,
      emoji: "👍",
    });

    const request = await fileCandidateFact(apertureCtx(db, seat.dek), {
      twinId: seat.twinId,
      entityId,
      sourceEventId: asked,
      factType: "OrderRequested",
      payload: { item: "bultos", quantity: 20 },
      confidence: 0.95,
      reading: "stated",
      renderDisclosureLine: () => "Te pidió 20 bultos — sin precio, sin fecha.",
    });
    const taken = await gestureCandidate(seat, entityId, gesture);

    expect(request.filed).toBe(true);
    expect(taken).toMatchObject({ filed: false, outcome: "refused" });
    const rows = await db.query<{ fact_type: string }>(
      "SELECT fact_type FROM ledger.facts WHERE filed_by_twin_id = $1",
      [seat.twinId],
    );
    expect(rows.rows.map((r) => r.fact_type)).toEqual(["OrderRequested"]);
  });

  /**
   * THE READ-BACK IS SCOPED TO THE GESTURE'S OWN CHAT. A stanza id is not
   * globally unique across chats as far as this aperture is concerned, and
   * a gesture reaching into another conversation for its words would put
   * one customer's message into another customer's fact — a wall crossing
   * with the right shape and the wrong content.
   */
  it("refuses a gesture whose target is in another chat", async () => {
    const seat = freshSeat();
    const entityId = await boundCustomer(seat, "Ferretería Fuentes");
    const id = ids();
    const otherChat = "5215599999999@s.whatsapp.net";
    await customerMessage(seat, id.ask, ASK, { chatJid: otherChat });
    const gesture = await reaction(seat, {
      messageId: id.gesture,
      reactionTo: id.ask,
      emoji: "👍",
    });

    const outcome = await gestureCandidate(seat, entityId, gesture);

    expect(outcome).toMatchObject({ filed: false, outcome: "refused" });
  });

  /** A gesture at a gesture is a pointer at a pointer: no words to carry. */
  it("refuses a gesture whose target is itself a reaction", async () => {
    const seat = freshSeat();
    const entityId = await boundCustomer(seat, "Ferretería Fuentes");
    const id = ids();
    await customerMessage(seat, id.ask, ASK);
    const first = await reaction(seat, {
      messageId: `${id.gesture}-A`,
      reactionTo: id.ask,
      emoji: "👍",
      fromMe: false,
    });
    const onTheGesture = await reaction(seat, {
      messageId: id.gesture,
      reactionTo: `${id.gesture}-A`,
      emoji: "👍",
    });

    expect(first).not.toBe(onTheGesture);
    const outcome = await gestureCandidate(seat, entityId, onTheGesture);

    expect(outcome).toMatchObject({ filed: false, outcome: "refused" });
  });

  /**
   * A MESSAGE PAYLOAD UNDER A REACTION'S TYPE is a row the seam cannot
   * read as what it claims to be — a plane that changed its mind, or a
   * planted row. It is refused rather than half-read, which is the whole
   * reason ADR-0041 gave the gesture a type with its own decoder.
   */
  it("refuses a row typed as a reaction that carries a message payload", async () => {
    const seat = freshSeat();
    const entityId = await boundCustomer(seat, "Ferretería Fuentes");
    const id = ids();
    const mistyped = await insertWaEventFixture(db, seat.dek, {
      twinId: seat.twinId,
      companyId: seat.companyId,
      seatId: seat.seatId,
      chatJid: CUSTOMER_CHAT,
      senderJid: SELF_CHAT,
      fromMe: true,
      messageId: id.gesture,
      text: "va",
      eventType: "reaction",
    });

    const outcome = await gestureCandidate(seat, entityId, mistyped);

    expect(outcome).toMatchObject({ filed: false, outcome: "refused" });
    if (outcome.filed || outcome.outcome !== "refused") return;
    expect(outcome.reason).toContain("did not decode");
  });

  /**
   * THE POINTER BINDS TO THE MESSAGE, NOT TO THE METADATA (Codex r1).
   *
   * The target is SELECTED on `external_event_id`, which is plaintext
   * metadata the aperture deliberately does not trust — that is why the
   * chat is re-confirmed against the decrypted envelope. The message id
   * has to be re-confirmed for exactly the same reason: a row whose
   * plaintext key names one message while its authenticated envelope names
   * another would put the WRONG message's words in front of an owner as
   * the evidence for this gesture, which is precisely the binding ADR-0003
   * says deterministic code must make.
   *
   * Planted with the fixture's `externalEventId` override, which is the
   * only way to make the two disagree.
   */
  it("refuses a target whose envelope names a different message than its seam key", async () => {
    const seat = freshSeat();
    const entityId = await boundCustomer(seat, "Ferretería Fuentes");
    const id = ids();
    // The row the gesture will point at: its plaintext key says `id.ask`,
    // its sealed envelope says something else entirely.
    await insertWaEventFixture(db, seat.dek, {
      twinId: seat.twinId,
      companyId: seat.companyId,
      seatId: seat.seatId,
      chatJid: CUSTOMER_CHAT,
      senderJid: CUSTOMER_CHAT,
      fromMe: false,
      messageId: `${id.ask}-REAL`,
      text: "mándame 20 bultos",
      externalEventId: `${CUSTOMER_CHAT}:${id.ask}`,
      occurredAt: SAID_AT,
    });
    const gesture = await reaction(seat, {
      messageId: id.gesture,
      reactionTo: id.ask,
      emoji: "👍",
    });

    const outcome = await gestureCandidate(seat, entityId, gesture);

    expect(outcome).toMatchObject({ filed: false, outcome: "refused" });
  });

  /**
   * A CITATION OF NOTHING IS NOT A CITATION. The model was shown a
   * transcript and can only cite what is on it; an id that names no row at
   * all is invented provenance, and it is refused at the seam read before
   * anything else is asked about it.
   */
  it("refuses a citation of an event id that is no row at all", async () => {
    const seat = freshSeat();
    const entityId = await boundCustomer(seat, "Ferretería Fuentes");

    const outcome = await gestureCandidate(
      seat,
      entityId,
      "999999999999999999",
    );

    expect(outcome).toMatchObject({ filed: false, outcome: "refused" });
    if (outcome.filed || outcome.outcome !== "refused") return;
    expect(outcome.reason).toContain("no wa_events row");
  });

  /**
   * THE CAP IS THE SAME CAP (ADR-0038). A target too long to hold refuses
   * the crossing rather than being truncated: a truncated quotation is a
   * clipped one, and a clipped agreement is the defect the whole-message
   * rule exists to prevent.
   */
  it("refuses a gesture whose target is longer than a payload field may hold", async () => {
    const seat = freshSeat();
    const entityId = await boundCustomer(seat, "Ferretería Fuentes");
    const id = ids();
    await customerMessage(
      seat,
      id.ask,
      `mándame 20 bultos. ${"y otra cosa ".repeat(30)}`,
    );
    const gesture = await reaction(seat, {
      messageId: id.gesture,
      reactionTo: id.ask,
      emoji: "👍",
    });

    const outcome = await gestureCandidate(seat, entityId, gesture);

    expect(outcome).toMatchObject({ filed: false, outcome: "refused" });
    if (outcome.filed || outcome.outcome !== "refused") return;
    expect(outcome.reason).toContain("longer than a payload field may hold");
  });

  /**
   * THE WALL SWEEP IS THE SAME SWEEP (ADR-0004). The composed evidence is
   * a payload string like any other, so `shapePayload` reads every
   * character of it before the row exists — a target message quoting the
   * chat's own address never crosses just because a 👍 carried it rather
   * than the rep's own typing.
   *
   * Both halves, because both are how an address hides: the JID SUFFIX a
   * model repeated off a screenshot, and the counterparty's own bare
   * number in the middle of a sentence, which no suffix scan would see.
   */
  it("refuses a gesture whose target carries chat identity — the wall sweep reads the composed evidence too", async () => {
    const seat = freshSeat();
    const entityId = await boundCustomer(seat, "Ferretería Fuentes");
    const addressed = ids();
    await customerMessage(
      seat,
      addressed.ask,
      `mándame 20 bultos, y mándale copia a 5215512345678@s.whatsapp.net`,
    );
    const onAddress = await reaction(seat, {
      messageId: addressed.gesture,
      reactionTo: addressed.ask,
      emoji: "👍",
    });

    const jid = await gestureCandidate(seat, entityId, onAddress);
    expect(jid).toMatchObject({ filed: false, outcome: "refused" });
    if (!jid.filed && jid.outcome === "refused") {
      expect(jid.reason).toContain("WhatsApp address");
    }

    const bare = ids();
    await customerMessage(
      seat,
      bare.ask,
      "mándame 20 bultos, me marcas al 55 1234 5678 ext. 204",
    );
    const onNumber = await reaction(seat, {
      messageId: bare.gesture,
      reactionTo: bare.ask,
      emoji: "👍",
    });

    const number = await gestureCandidate(seat, entityId, onNumber);
    expect(number).toMatchObject({ filed: false, outcome: "refused" });
    if (!number.filed && number.outcome === "refused") {
      expect(number.reason).toContain("own WhatsApp number");
    }
  });

  /**
   * A GESTURE EVIDENCES AN AGREEMENT AND NOTHING ELSE (ticket #99's
   * narrow widening). Every other fact type is READ IN THE WORDS of the
   * message it is filed on — «Te dijo que …», «Te pidió …», a contact
   * detail somebody wrote down — and a reaction has none of its own. Only
   * `OrderTaken`'s evidence is the ACT itself, which is what ADR-0041 made
   * admissible; admitting a gesture anywhere else would let a model attach
   * any claim it liked to a wordless row.
   */
  it("refuses any fact type other than OrderTaken read in a gesture", async () => {
    const seat = freshSeat();
    const entityId = await boundCustomer(seat, "Ferretería Fuentes");
    const id = ids();
    await repMessage(seat, id.ask, "¿cómo le fue con el material?");
    const gesture = await reaction(seat, {
      messageId: id.gesture,
      reactionTo: id.ask,
      emoji: "👍",
      fromMe: false,
    });

    const outcome = await fileCandidateFact(apertureCtx(db, seat.dek), {
      twinId: seat.twinId,
      entityId,
      sourceEventId: gesture,
      factType: "CustomerPattern",
      payload: { pattern: "solo recibe material antes de las 2" },
      confidence: 0.95,
      reading: "stated",
      renderDisclosureLine: () => "Te dijo que solo recibe material antes de las 2.",
    });

    expect(outcome).toMatchObject({ filed: false, outcome: "refused" });
    if (outcome.filed || outcome.outcome !== "refused") return;
    expect(outcome.reason).toContain("reaction");
  });
});

/**
 * AN OPAQUE DELIVERY IS CITABLE LIKE ANY ROW (ticket #124; ADR-0042).
 *
 * No hard gate: the aperture accepts an opaque row's id as a candidate
 * fact's evidence, composes the placeholder as that evidence's words by
 * deterministic read-back, and the disclosure line shows it on its face —
 * which is where ADR-0038 wants the rep's eyes. The transcript makes the
 * opacity explicit and the model weighs it; nothing here decides for it.
 *
 * What is NOT admitted is a class-2 REP ACT, exactly as #99 stopped short
 * of one for a gesture: a confirmation, a correction, a retraction and an
 * entity act are each bound to words the rep typed, and «[foto]» is not
 * words — it is the twin saying it could not read them.
 */
describe("an opaque delivery is citable evidence, and the placeholder is its words (#124)", () => {
  let stanza = 0;
  function opaqueIds(): { photo: string; row: string } {
    stanza += 1;
    const photo = `WAMID-124-PHOTO-${stanza}`;
    return { photo, row: `${photo}:opaque` };
  }

  /** One opaque delivery on the seam — a shape the plane could not read. */
  async function opaqueDelivery(
    seat: Seat,
    fixture: {
      messageId: string;
      kind: string;
      reason?: OpaqueReason;
      fromMe?: boolean;
      backfill?: boolean;
    },
  ): Promise<string> {
    const fromMe = fixture.fromMe ?? true;
    return insertWaOpaqueFixture(db, seat.dek, {
      twinId: seat.twinId,
      companyId: seat.companyId,
      seatId: seat.seatId,
      chatJid: CUSTOMER_CHAT,
      senderJid: fromMe ? SELF_CHAT : CUSTOMER_CHAT,
      fromMe,
      messageId: fixture.messageId,
      kind: fixture.kind,
      reason: fixture.reason ?? "no_slot",
      occurredAt: SAID_AT,
      ...(fixture.backfill === undefined ? {} : { backfill: fixture.backfill }),
    });
  }

  it("files an OrderTaken read in a rep's photo, carrying the PLACEHOLDER as the words that agreed", async () => {
    const seat = freshSeat();
    const entityId = await boundCustomer(seat, "Ferretería Fuentes");
    const id = opaqueIds();
    const photo = await opaqueDelivery(seat, {
      messageId: id.row,
      kind: "imageMessage",
    });

    const outcome = await fileCandidateFact(apertureCtx(db, seat.dek), {
      twinId: seat.twinId,
      entityId,
      sourceEventId: photo,
      factType: "OrderTaken",
      payload: { item: "bultos", quantity: 20 },
      confidence: 0.95,
      reading: "stated",
      renderDisclosureLine: (fact) =>
        `Dijiste: «${String(fact.payload["agreement"])}».`,
    });

    expect(outcome.filed).toBe(true);
    if (!outcome.filed) return;
    // The evidence text is composed off the seam row and nothing else —
    // the model supplied no `agreement` and could not have.
    expect(outcome.fact.payload).toEqual({
      item: "bultos",
      quantity: 20,
      agreement: "[foto]",
    });
    // ...and the disclosure line the rep reads shows the placeholder on its
    // face, which is what makes a wrong reading catchable.
    const line = await db.query<{ rendered_text: string }>(
      "SELECT rendered_text FROM disclosure_lines WHERE id = $1",
      [outcome.disclosureLineId],
    );
    expect(line.rows[0]?.rendered_text).toBe("Dijiste: «[foto]».");
  });

  it("names the delivery honestly whatever the kind — a voice note, and a message the rail could not decrypt", async () => {
    const seat = freshSeat();
    const entityId = await boundCustomer(seat, "Ferretería Fuentes");
    for (const [kind, placeholder] of [
      ["audioMessage", "[nota de voz]"],
      ["undecryptable", "[mensaje que no se pudo leer]"],
    ] as const) {
      const id = opaqueIds();
      const row = await opaqueDelivery(seat, {
        messageId: id.row,
        kind,
        reason: kind === "undecryptable" ? "undecryptable" : "no_slot",
      });
      const outcome = await fileCandidateFact(apertureCtx(db, seat.dek), {
        twinId: seat.twinId,
        entityId,
        sourceEventId: row,
        factType: "OrderTaken",
        payload: { item: "bultos", quantity: 20 },
        confidence: 0.95,
        reading: "stated",
        renderDisclosureLine: () => "Le confirmaste el pedido.",
      });

      expect(outcome.filed).toBe(true);
      if (!outcome.filed) return;
      expect(outcome.fact.payload["agreement"]).toBe(placeholder);
      // It is not a gesture: no emoji field, so the disclosure keeps the
      // «Dijiste» verb rather than «Confirmaste con».
      expect(outcome.fact.payload["agreementGesture"]).toBeUndefined();
    }
  });

  it("refuses a BACKFILLED opaque delivery, exactly as it refuses backfilled history of any other type", async () => {
    const seat = freshSeat();
    const entityId = await boundCustomer(seat, "Ferretería Fuentes");
    const id = opaqueIds();
    const photo = await opaqueDelivery(seat, {
      messageId: id.row,
      kind: "imageMessage",
      backfill: true,
    });

    const outcome = await fileCandidateFact(apertureCtx(db, seat.dek), {
      twinId: seat.twinId,
      entityId,
      sourceEventId: photo,
      factType: "OrderTaken",
      payload: { item: "bultos", quantity: 20 },
      confidence: 0.95,
      reading: "stated",
      renderDisclosureLine: () => "Le confirmaste el pedido.",
    });

    expect(outcome).toMatchObject({ filed: false, outcome: "refused" });
    if (outcome.filed || outcome.outcome !== "refused") return;
    expect(outcome.reason).toContain("backfilled history");
  });

  it("is never a REP ACT: a photo cited as the rep's own act is processed as class 1", async () => {
    const seat = freshSeat();
    const id = opaqueIds();
    const photo = await opaqueDelivery(seat, {
      messageId: id.row,
      kind: "imageMessage",
    });

    const input = await classifyApertureInput(apertureCtx(db, seat.dek), {
      twinId: seat.twinId,
      evidence: { surface: "twin_thread", sourceEventId: photo, waMessageId: id.row },
    });

    expect(input.inputClass).toBe(1);
    if (input.inputClass !== 1) return;
    expect(input.reason).toContain("opaque");
  });
});

/**
 * THE AUTHORSHIP FENCE (ticket #71; #70 remainder 2). A fact whose
 * sentence names an actor may only be read in that actor's own message.
 * Checked against `wa_events.from_me` — the flag the plane stamped —
 * because a model can neither produce a seam row nor alter one.
 */
describe("a fact about someone's act is read in their own message (#71)", () => {
  it("refuses an OrderTaken read in the customer's message — #57's order the rep never accepted", async () => {
    const seat = freshSeat();
    const entityId = await boundCustomer(seat, "Ferretería Fuentes");
    const asked = await customerMessage(
      seat,
      "WAMID-F1",
      "ah y súmale unas 20 más",
    );

    const outcome = await fileCandidateFact(apertureCtx(db, seat.dek), {
      twinId: seat.twinId,
      entityId,
      sourceEventId: asked,
      factType: "OrderTaken",
      payload: { item: "bultos", quantity: 20, agreement: "súmale unas 20" },
      confidence: 0.95,
      reading: "stated",
      renderDisclosureLine: () => "Le confirmaste el pedido de 20 bultos.",
    });

    expect(outcome).toMatchObject({ filed: false, outcome: "refused" });
    if (outcome.filed || outcome.outcome !== "refused") return;
    expect(outcome.reason).toContain("claims the rep acted");
  });

  it("refuses an OrderRequested read in the rep's message — restating an ask is not the ask", async () => {
    const seat = freshSeat();
    const entityId = await boundCustomer(seat, "Ferretería Fuentes");
    const restated = await repMessage(
      seat,
      "WAMID-F2",
      "entonces son 100 cajas, ¿verdad?",
    );

    const outcome = await fileCandidateFact(apertureCtx(db, seat.dek), {
      twinId: seat.twinId,
      entityId,
      sourceEventId: restated,
      factType: "OrderRequested",
      payload: { item: "cajas", quantity: 100 },
      confidence: 0.95,
      reading: "stated",
      renderDisclosureLine: () => "Te pidió 100 cajas.",
    });

    expect(outcome).toMatchObject({ filed: false, outcome: "refused" });
    if (outcome.filed || outcome.outcome !== "refused") return;
    expect(outcome.reason).toContain("claims the counterparty acted");
  });

  /**
   * #70's REMAINDER 2, DECIDED THE SAME WAY. `shapeDatePromised` took no
   * `SeamSource`, so a model could file a rep commitment it read in a
   * customer's message — `OrderTaken`'s defect in another type. The
   * contested case is a rep's promise restated in a customer's «ok,
   * entonces el viernes»: that message is the customer ACCEPTING a
   * promise, and if the rep made one their own message says so. The
   * corpus already agrees — every one of its 23 `DatePromised` labels sits
   * on a rep message, and B8-03 («¿me las puede tener el 25?») is labelled
   * silent for exactly this reason.
   */
  it("refuses a DatePromised read in the customer's message (#70 remainder 2)", async () => {
    const seat = freshSeat();
    const entityId = await boundCustomer(seat, "Ferretería Fuentes");
    const asked = await customerMessage(
      seat,
      "WAMID-F3",
      "ok, entonces el viernes",
    );

    const outcome = await fileCandidateFact(apertureCtx(db, seat.dek), {
      twinId: seat.twinId,
      entityId,
      sourceEventId: asked,
      factType: "DatePromised",
      payload: { commitment: "entregar las cajas", dueOn: "2026-09-04" },
      confidence: 0.99,
      reading: "stated",
      renderDisclosureLine: () => "Le confirmaste entregar las cajas.",
    });

    expect(outcome).toMatchObject({ filed: false, outcome: "refused" });
  });

  it("refuses a QuoteGiven read in the customer's message — a customer quoting a price is not this rep quoting", async () => {
    const seat = freshSeat();
    const entityId = await boundCustomer(seat, "Ferretería Fuentes");
    const competitor = await customerMessage(
      seat,
      "WAMID-F4",
      "el otro proveedor me los deja en 7,900",
    );

    const outcome = await fileCandidateFact(apertureCtx(db, seat.dek), {
      twinId: seat.twinId,
      entityId,
      sourceEventId: competitor,
      factType: "QuoteGiven",
      payload: { item: "bultos", quantity: 40, amount: 7900, currency: "MXN" },
      confidence: 0.99,
      reading: "stated",
      renderDisclosureLine: () => "Le cotizaste 40 bultos en 7,900 MXN.",
    });

    expect(outcome).toMatchObject({ filed: false, outcome: "refused" });
  });

  it("fences nothing on ContactEstablished — a contact detail is established by whoever states it", async () => {
    const seat = freshSeat();
    const entityId = await boundCustomer(seat, "Ferretería Fuentes");

    for (const [messageId, said] of [
      ["WAMID-F5", customerMessage],
      ["WAMID-F6", repMessage],
    ] as const) {
      const sourceEventId = await said(
        seat,
        messageId,
        "el correo de facturación es pagos@fuentes.mx",
      );
      const outcome = await fileCandidateFact(apertureCtx(db, seat.dek), {
        twinId: seat.twinId,
        entityId,
        sourceEventId,
        factType: "ContactEstablished",
        payload: { identifiers: { emails: ["pagos@fuentes.mx"] } },
        confidence: 0.99,
        reading: "stated",
        renderDisclosureLine: () => "Guardé sus datos de contacto.",
      });
      expect(outcome.filed, messageId).toBe(true);
    }
  });

  /**
   * THE FENCE IS A REFUSAL, NOT A DROP. Both end the same way, and they
   * are counted apart: a refusal is a statement about the candidate's SHAPE
   * — no confidence would make «Le confirmaste el pedido» read in the
   * customer's message filable — while a drop is a statement about how sure
   * the model was. A reader of the run's rates has to be able to tell them
   * apart.
   */
  it("refuses a fact read on the wrong side of the conversation, and records nothing", async () => {
    const seat = freshSeat();
    const entityId = await boundCustomer(seat, "Ferretería Fuentes");
    const asked = await customerMessage(seat, "WAMID-F7", "y unas 20 más");

    const outcome = await fileCandidateFact(apertureCtx(db, seat.dek), {
      twinId: seat.twinId,
      entityId,
      sourceEventId: asked,
      factType: "OrderTaken",
      payload: { item: "bultos", quantity: 20, agreement: "y unas 20" },
      confidence: EXTRACTION_CONFIDENCE_THRESHOLD - 0.01,
      reading: "stated",
      renderDisclosureLine: () => "Le confirmaste el pedido de 20 bultos.",
    });

    expect(outcome).toMatchObject({ filed: false, outcome: "refused" });
    expect(await factLines(seat)).toBe("0");
  });
});

/**
 * `CustomerPattern` — THE CUSTOMER'S OWN STANDING PREFERENCE OR CONSTRAINT
 * (ticket #61; FR-30, FR-32; ADR-0033, ADR-0034, ADR-0035, ADR-0038).
 *
 * The type whose false positives are aperture BREACHES rather than noise.
 * A wrong `QuoteGiven` is a wrong number in a record the rep can correct; a
 * wrong `CustomerPattern` is the rep's employer reading a judgment about the
 * rep. Everything below is one of the three fences that make that
 * unreachable rather than merely discouraged:
 *
 * 1. THE AUTHORSHIP FENCE (ADR-0038). «Te dijo que …» names the CUSTOMER,
 *    so the fact is read in the customer's own message or it is refused —
 *    checked against `wa_events.from_me`, in code, off the seam row. Every
 *    rep tactic and rep judgment the corpus carries is written in the rep's
 *    own message, and all of them now die here rather than at a prompt.
 * 2. NOTHING VERBATIM CROSSES. The payload is ONE composed clause; no part
 *    of the conversation is copied into it. An earlier cut stored the
 *    customer's whole message as evidence, on `OrderTaken`'s argument — and
 *    one message can carry a standing preference AND a complaint about the
 *    rep, so the copy would have filed FR-30's excluded class verbatim into
 *    the Ledger the rep's employer reads (ADR-0040).
 * 3. THE ORPHAN RULE (FR-32, ADR-0035). It attaches to exactly one entity
 *    like every other fact; there is no non-entity slot to drain into.
 */
describe("CustomerPattern — the customer's own stated regularity (#61)", () => {
  it("files a preference the customer stated, and stores only the claim", async () => {
    const seat = freshSeat();
    const entityId = await boundCustomer(seat, "Ferretería Fuentes");
    const said = await customerMessage(
      seat,
      "WAMID-CP1",
      "nomás recibimos material antes de las 2, después ya no hay quien descargue",
    );

    const outcome = await fileCandidateFact(apertureCtx(db, seat.dek), {
      twinId: seat.twinId,
      entityId,
      sourceEventId: said,
      factType: "CustomerPattern",
      payload: { pattern: "solo recibe material antes de las 2 de la tarde" },
      confidence: 0.95,
      reading: "stated",
      renderDisclosureLine: () =>
        "Te dijo que solo recibe material antes de las 2 de la tarde.",
    });

    expect(outcome.filed).toBe(true);
    if (!outcome.filed) return;
    expect(outcome.fact.payloadVersion).toBe(1);
    // ONE FIELD, and the equality is the claim: nothing from the message
    // rides along.
    expect(outcome.fact.payload).toEqual({
      pattern: "solo recibe material antes de las 2 de la tarde",
    });

    const row = await db.query<{
      fact_type: string;
      payload_version: number;
      entity_id: string;
    }>(
      `SELECT fact_type, payload_version, entity_id
         FROM ledger.facts WHERE id = $1`,
      [outcome.factId],
    );
    expect(row.rows[0]).toMatchObject({
      fact_type: "CustomerPattern",
      payload_version: 1,
      // FR-32 is absolute: exactly one entity, like every other fact.
      entity_id: entityId,
    });
  });

  it("refuses one read in the REP's own message — a rep's note about how they sell is not the customer's pattern", async () => {
    // THE APERTURE-BREACH CASE, and the corpus's own words for it: «a este
    // cliente siempre hay que darle el precio alto primero, luego negocia»
    // is FR-30's "rep tactics, judgments, or selling approach" verbatim,
    // written in a CUSTOMER chat where ADR-0033's enumeration does not
    // reach it. Before #61 only the prompt stood between it and the rep's
    // employer; now the aperture does, off `wa_events.from_me`.
    const seat = freshSeat();
    const entityId = await boundCustomer(seat, "Ferretería Fuentes");
    const tactic = await repMessage(
      seat,
      "WAMID-CP2",
      "a este cliente siempre hay que darle el precio alto primero, luego negocia",
    );

    const outcome = await fileCandidateFact(apertureCtx(db, seat.dek), {
      twinId: seat.twinId,
      entityId,
      sourceEventId: tactic,
      factType: "CustomerPattern",
      payload: { pattern: "hay que darle el precio alto primero" },
      confidence: 1,
      reading: "stated",
      renderDisclosureLine: () => "Te dijo que …",
    });

    expect(outcome).toMatchObject({ filed: false, outcome: "refused" });
    if (outcome.filed || outcome.outcome !== "refused") return;
    expect(outcome.reason).toContain("claims the counterparty acted");

    // ...and nothing was recorded: a refusal reaches no store at all, which
    // is what keeps a sentence the aperture could not have filed out of the
    // rep's own account of their day.
    expect(await factLines(seat)).toBe("0");
  });

  it("copies nothing from the message — a mixed complaint-and-preference files only the claim", async () => {
    // THE REVIEW FINDING, AS A REGRESSION TEST. This message carries a
    // standing preference AND a judgment about the rep, which is ordinary
    // customer traffic. The first cut of this payload stored the whole
    // message as evidence, so «usted siempre se tarda» would have been
    // filed verbatim into `ledger.finalized_facts` under the one type FR-30
    // names "rep tactics, judgments, or selling approach" against — the
    // exact breach this type waited a slice to avoid.
    //
    // A model that writes its own evidence field is not obeyed either: the
    // shaper keeps `pattern` and nothing else, so no key a caller invents
    // can reach the store.
    const seat = freshSeat();
    const entityId = await boundCustomer(seat, "Ferretería Fuentes");
    const said = await customerMessage(
      seat,
      "WAMID-CP3",
      "usted siempre se tarda, pero nosotros pagamos a 15 días",
    );

    const outcome = await fileCandidateFact(apertureCtx(db, seat.dek), {
      twinId: seat.twinId,
      entityId,
      sourceEventId: said,
      factType: "CustomerPattern",
      payload: {
        pattern: "paga a 15 días",
        statedAs: "usted siempre se tarda, pero nosotros pagamos a 15 días",
      },
      confidence: 0.9,
      reading: "stated",
      renderDisclosureLine: () => "Te dijo que paga a 15 días.",
    });

    expect(outcome.filed).toBe(true);
    if (!outcome.filed) return;
    expect(outcome.fact.payload).toEqual({ pattern: "paga a 15 días" });

    // ...and the STORED row carries no more than the shaped payload, read
    // back the way a reader outside the aperture would meet it.
    const row = await db.query<{ payload: Record<string, unknown> }>(
      "SELECT payload FROM ledger.facts WHERE id = $1",
      [outcome.factId],
    );
    expect(row.rows[0]!.payload).toEqual({ pattern: "paga a 15 días" });
  });

  it("can never be read in the rep's own thread — ADR-0033's exclusion, on the type most likely to tempt one", async () => {
    // ADR-0033 keeps the rep notepad twin-side, and its provenance test is
    // the chat: the extraction pass ENUMERATES bound customer chats, so the
    // twin thread is structurally not among its inputs. This is the second
    // lock, at the aperture, for the type whose whole hazard is reading the
    // rep's own notes as a pattern — every self-chat row is the rep writing
    // to themselves, and a `CustomerPattern` claims the COUNTERPARTY spoke.
    const seat = freshSeat();
    const entityId = await boundCustomer(seat, "Ferretería Fuentes");
    const note = await repMessage(
      seat,
      "WAMID-CP7",
      "recuerda: a Fuentes siempre de usted",
      { chatJid: SELF_CHAT },
    );

    const outcome = await fileCandidateFact(apertureCtx(db, seat.dek), {
      twinId: seat.twinId,
      entityId,
      sourceEventId: note,
      factType: "CustomerPattern",
      payload: { pattern: "prefiere que le hablen de usted" },
      confidence: 1,
      reading: "stated",
      renderDisclosureLine: () => "Te dijo que …",
    });

    expect(outcome).toMatchObject({ filed: false, outcome: "refused" });
    if (outcome.filed || outcome.outcome !== "refused") return;
    expect(outcome.reason).toContain("claims the counterparty acted");

    // Nothing was recorded: no fact and no line.
    const facts = await db.query<{ n: string }>(
      "SELECT count(*) AS n FROM ledger.facts WHERE filed_by_twin_id = $1",
      [seat.twinId],
    );
    expect(facts.rows[0]?.n).toBe("0");
    expect(await factLines(seat)).toBe("0");
  });

  it("refuses a payload with no `pattern` — there is no sentence to state", async () => {
    const seat = freshSeat();
    const entityId = await boundCustomer(seat, "Ferretería Fuentes");
    const said = await customerMessage(
      seat,
      "WAMID-CP4",
      "siempre pedimos con factura",
    );

    const outcome = await fileCandidateFact(apertureCtx(db, seat.dek), {
      twinId: seat.twinId,
      entityId,
      sourceEventId: said,
      factType: "CustomerPattern",
      payload: { note: "factura" },
      confidence: 0.99,
      reading: "stated",
      renderDisclosureLine: () => "Te dijo que …",
    });

    expect(outcome).toMatchObject({ filed: false, outcome: "refused" });
    if (outcome.filed || outcome.outcome !== "refused") return;
    expect(outcome.reason).toContain("`pattern`");
  });

  it("refuses a pattern whose CLAIM carries the counterparty's own WhatsApp number", async () => {
    // The wall check every payload string gets (ADR-0004), on the one
    // string this payload has. A model that writes the customer's own
    // number into the clause — «siempre pide aviso al 55 1234 5678» — is
    // carrying chat identity across, and the sweep catches it here.
    const seat = freshSeat();
    const entityId = await boundCustomer(seat, "Ferretería Fuentes");
    const said = await customerMessage(
      seat,
      "WAMID-CP5",
      "siempre avísenos antes de salir",
    );

    const outcome = await fileCandidateFact(apertureCtx(db, seat.dek), {
      twinId: seat.twinId,
      entityId,
      sourceEventId: said,
      factType: "CustomerPattern",
      payload: {
        pattern: "siempre pide aviso al 55 1234 5678 antes de la salida",
      },
      confidence: 0.99,
      reading: "stated",
      renderDisclosureLine: () => "Te dijo que …",
    });

    expect(outcome).toMatchObject({ filed: false, outcome: "refused" });
    if (outcome.filed || outcome.outcome !== "refused") return;
    expect(outcome.reason).toMatch(/chat identity/i);
  });

  it("cannot be filed against an entity that does not exist — the orphan rule is the store's, not a convention", async () => {
    // FR-32 / ADR-0035: "every fact attaches to exactly one entity, and
    // there is no non-entity slot". The composite foreign key is what makes
    // an unattached `CustomerPattern` unrepresentable — a market- or
    // season-level observation has nowhere to land, by construction.
    const seat = freshSeat();
    await boundCustomer(seat, "Ferretería Fuentes");
    const said = await customerMessage(
      seat,
      "WAMID-CP6",
      "en diciembre se pone flojo todo esto de la construcción",
    );

    await expect(
      fileCandidateFact(apertureCtx(db, seat.dek), {
        twinId: seat.twinId,
        entityId: randomUUID(),
        sourceEventId: said,
        factType: "CustomerPattern",
        payload: { pattern: "diciembre es temporada baja en construcción" },
        confidence: 0.99,
        reading: "stated",
        renderDisclosureLine: () => "Te dijo que …",
      }),
    ).rejects.toThrow();
  });
});
