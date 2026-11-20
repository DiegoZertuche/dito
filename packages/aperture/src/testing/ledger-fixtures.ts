/**
 * Ledger fixtures: a company's customers, as the system actually makes them
 * (tickets #55, #62).
 *
 * Every helper that files something drives ORDINARY TRAFFIC through the
 * real aperture — a `wa_events` row the plane could have delivered, then a
 * class-2 rep act or a class-1 candidate fact — rather than reaching into
 * `ledger` with an INSERT. A suite that hand-built its rows would be
 * asserting against a store shaped by the test rather than by the writer,
 * and the merge and its reversal are both entirely about what the writer
 * put there.
 *
 * ONE helper is an exception, and deliberately, because the writer it would
 * drive does not exist. `grantOwnerAssigned`: the owner surface that assigns
 * a grant is not built, and a suite asserting what a merge does to reads has
 * to be able to stand one up somehow. It says so at its own definition, and
 * it writes nothing the real act would not.
 *
 * There used to be a second (ticket #127's `liftShadow`, which flipped the
 * two columns by hand while the lift act was still unbuilt). Ticket #132
 * built the act, so that helper now CALLS it and is no exception at all.
 *
 * `discloseAndFinalize` was never one either: it writes rep-side rows to
 * make a disclosure line rep-reachable and then calls the real
 * `finalizeDueFacts` for the Ledger's half.
 *
 * Lifted out of `merge.int.test.ts` when the unmerge suite needed the same
 * seven customers-and-quotes helpers: one copy, so the two suites cannot
 * drift into seeding subtly different Ledgers.
 *
 * Test plumbing, source-only: every package's `src/testing` is excluded
 * from its build, so this never ships.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { createDekFromMaterial, type Dek } from "@dito/crypto";
import { SEAT_LINKED } from "@dito/seam";
import type pg from "pg";
import { apertureCtx, TEST_AUDIT_HMAC_KEY } from "./context.js";
import { insertWaEventFixture } from "./db.js";
import { fileEntityCreate, type EntityKind } from "../entities.js";
import { fileCandidateFact } from "../facts.js";
import { finalizeDueFacts } from "../finalization.js";
import { OWNER_COMPANY_SETTING } from "../grants.js";
import { retractDisclosedFact } from "../retraction.js";
import { liftCompanyShadow } from "../shadow-lift.js";

/** The rep's own thread: where a binding confirmation arrives. */
export const SELF_CHAT = "5215550000@s.whatsapp.net";

/** One rep, in one company. */
export interface Seat {
  readonly twinId: string;
  readonly companyId: string;
  readonly seatId: string;
  readonly dek: Dek;
}

export function freshSeat(companyId: string = randomUUID()): Seat {
  return {
    twinId: randomUUID(),
    companyId,
    seatId: randomUUID(),
    dek: createDekFromMaterial(randomBytes(32)),
  };
}

let sequence = 0;
function nextMessageId(prefix: string): string {
  sequence += 1;
  return `WAMID-${prefix}-${sequence}`;
}

/**
 * One customer, as the system actually makes one: the rep confirms a
 * binding in their own thread, and the aperture files the entity create
 * with its disclosure line.
 *
 * `confirmedAt` is explicit because the aperture takes an entity's valid
 * time off the rep act itself — which makes it the survivorship rule's
 * input (ADR-0035). Two confirmations at the same instant are a real state
 * and the tie-break is tested on its own; everywhere else the fixtures say
 * which record came first, because that is the thing being asserted.
 */
export async function bindCustomer(
  db: pg.ClientBase,
  seat: Seat,
  displayName: string,
  options: BindOptions = {},
): Promise<string> {
  const kind = options.kind ?? "person";
  const messageId = nextMessageId("BIND");
  const sourceEventId = await insertWaEventFixture(db, seat.dek, {
    twinId: seat.twinId,
    companyId: seat.companyId,
    seatId: seat.seatId,
    chatJid: SELF_CHAT,
    senderJid: SELF_CHAT,
    fromMe: true,
    messageId,
    text: "va",
    occurredAt: options.confirmedAt ?? new Date("2026-08-27T14:03:00Z"),
  });
  const entityId = randomUUID();
  await fileEntityCreate(
    // The crossing is a class-2 rep act and is audit-chained (#54).
    apertureCtx(db, seat.dek),
    {
      twinId: seat.twinId,
      entityId,
      kind,
      // The production path determines it with the model (#60); a fixture
      // that says which customer this is says which kind too, so the stamp
      // it files is the one the live create files.
      displayName,
      evidence: { surface: "twin_thread", sourceEventId, waMessageId: messageId },
      disclosureText: "Lo di de alta como cliente.",
    },
  );
  return entityId;
}

/**
 * A day's traffic in one customer chat, ending in a `ContactEstablished`
 * the aperture normalized and filed. This is the seam the merge is tested
 * at: identifiers arrive as something a person wrote in a conversation.
 */
export async function establishContact(
  db: pg.ClientBase,
  seat: Seat,
  entityId: string,
  chatJid: string,
  identifiers: ContactIdentifiers,
): Promise<string> {
  const messageId = nextMessageId("CONTACT");
  const sourceEventId = await insertWaEventFixture(db, seat.dek, {
    twinId: seat.twinId,
    companyId: seat.companyId,
    seatId: seat.seatId,
    chatJid,
    senderJid: chatJid,
    fromMe: false,
    messageId,
    text: "te paso mis datos",
  });
  const outcome = await fileCandidateFact(
    { db, dek: seat.dek },
    {
      twinId: seat.twinId,
      entityId,
      sourceEventId,
      factType: "ContactEstablished",
      payload: { identifiers },
      confidence: 0.95,
      reading: "stated",
      renderDisclosureLine: () => "Guardé sus datos de contacto.",
    },
  );
  if (!outcome.filed) {
    throw new Error(`fixture did not file: ${outcome.reason}`);
  }
  return outcome.factId;
}

/** One quote in a customer chat — a fact that must survive a merge unmoved. */
export async function quote(
  db: pg.ClientBase,
  seat: Seat,
  entityId: string,
  chatJid: string,
  amount: number,
): Promise<string> {
  const messageId = nextMessageId("QUOTE");
  const sourceEventId = await insertWaEventFixture(db, seat.dek, {
    twinId: seat.twinId,
    companyId: seat.companyId,
    seatId: seat.seatId,
    chatJid,
    // The REP's own message: «Le cotizaste …» is the rep's act, and the
    // aperture reads it in the rep's own words (#71).
    senderJid: SELF_CHAT,
    fromMe: true,
    messageId,
    text: `te las dejo en ${amount}`,
  });
  const outcome = await fileCandidateFact(
    { db, dek: seat.dek },
    {
      twinId: seat.twinId,
      entityId,
      sourceEventId,
      factType: "QuoteGiven",
      payload: { item: "cajas", amount, currency: "MXN" },
      confidence: 0.95,
      reading: "stated",
      renderDisclosureLine: () => `Le cotizaste cajas en ${amount} MXN.`,
    },
  );
  if (!outcome.filed) {
    throw new Error(`fixture did not file: ${outcome.reason}`);
  }
  return outcome.factId;
}

/** One promised date, filed from the rep's own message in a customer chat. */
export async function promise(
  db: pg.ClientBase,
  seat: Seat,
  entityId: string,
  chatJid: string,
): Promise<string> {
  const messageId = nextMessageId("PROMISE");
  const sourceEventId = await insertWaEventFixture(db, seat.dek, {
    twinId: seat.twinId,
    companyId: seat.companyId,
    seatId: seat.seatId,
    chatJid,
    // The rep's own commitment, in the rep's own message (#71): «¿me las
    // tienes para el sábado?» is the customer ASKING, and the corpus
    // labels that silent for exactly this reason.
    senderJid: SELF_CHAT,
    fromMe: true,
    messageId,
    text: "se las tengo para el sábado",
  });
  const outcome = await fileCandidateFact(
    { db, dek: seat.dek },
    {
      twinId: seat.twinId,
      entityId,
      sourceEventId,
      factType: "DatePromised",
      payload: { commitment: "entrega de cajas", dueOn: "2026-08-29" },
      confidence: 0.95,
      reading: "stated",
      renderDisclosureLine: () => "Le confirmaste la entrega para el sábado.",
    },
  );
  if (!outcome.filed) {
    throw new Error(`fixture did not file: ${outcome.reason}`);
  }
  return outcome.factId;
}

/**
 * The company and the seat, as the owner's views read them (ticket #127).
 *
 * The two registries are named from OUTSIDE the crossing on purpose: a
 * company id and a seat id have been on every seam row since slice 1, so a
 * row here NAMES an id that already exists rather than minting one. The
 * company insert is idempotent, so two seats of one company can each ask
 * for it without a suite having to remember which one comes first.
 */
export async function registerSeat(
  db: pg.ClientBase,
  seat: Seat,
  names: { readonly company: string; readonly rep: string },
): Promise<void> {
  await db.query(
    `INSERT INTO companies (id, display_name) VALUES ($1, $2)
     ON CONFLICT (id) DO NOTHING`,
    [seat.companyId, names.company],
  );
  // `linked` FROM THE CONSTANT AND NOT A WORD SPELLED HERE. `seats.state`
  // holds FR-63's three (#221), and a fixture that wrote the old one would
  // fail on the CHECK — which is the whole point of the CHECK.
  await db.query(
    `INSERT INTO seats (id, company_id, twin_id, rep_display_name, state)
     VALUES ($1, $2, $3, $4, $5)`,
    [seat.seatId, seat.companyId, seat.twinId, names.rep, SEAT_LINKED],
  );
}

/** One registered company's day, as the owner-side suites need it. */
export interface SeededCompany {
  readonly seat: Seat;
  readonly entityId: string;
  readonly factIds: readonly string[];
}

/**
 * A whole company, from registry row to closed correction window: one rep,
 * one customer bound from the rep's own thread, a quote and a promised date
 * in that customer's chat, the day's disclosure delivered and its window
 * closed.
 *
 * ONE COPY, for the reason this file exists (tickets #127, #132). Two
 * owner-side suites need the same company-shaped corpus — one to assert what
 * the OWNER's connection returns, one to assert what LIFTING changes — and
 * two hand-written copies would drift into seeding subtly different Ledgers
 * while both kept passing.
 *
 * IT DOES NOT LIFT. Whether a company's Ledger is lifted is the question
 * both of those suites are about, so it is the caller's to answer.
 */
export async function seedCompany(
  db: pg.ClientBase,
  names: {
    readonly company: string;
    readonly rep: string;
    readonly customer: string;
  },
  reachableAt: Date,
  windowClosedAt: Date,
): Promise<SeededCompany> {
  const seat = freshSeat();
  await registerSeat(db, seat, { company: names.company, rep: names.rep });
  const entityId = await bindCustomer(db, seat, names.customer);
  const chat = `52155${Math.floor(Math.random() * 1e7)}@s.whatsapp.net`;
  await quote(db, seat, entityId, chat, 4500);
  await promise(db, seat, entityId, chat);
  const factIds = await discloseAndFinalize(db, seat, reachableAt, windowClosedAt);
  return { seat, entityId, factIds };
}

/**
 * Reads whatever `fn` reads with a company DECLARED on this connection, and
 * resets it afterwards (tickets #127, #132).
 *
 * The finalized views are definer-rights and run as `dito_ledger_views`,
 * which is not a superuser — so the company policy applies even to a suite
 * connected as the schema owner, and a session that declares nothing reads
 * nothing through them. Every suite that reads a finalized view needs this,
 * so it is one helper rather than one `set_config`/`RESET` pair per suite.
 *
 * NOT `owner-reads.int.test.ts`'s `asOwner`, which is a different thing: that
 * opens a SECOND connection authenticated as `dito_owner`, because the claim
 * it makes is about a process logging in. This declares a company on the
 * connection it is given.
 */
export async function withDeclaredCompany<T>(
  db: pg.ClientBase,
  companyId: string,
  fn: () => Promise<T>,
): Promise<T> {
  await db.query("SELECT set_config($1, $2, false)", [
    OWNER_COMPANY_SETTING,
    companyId,
  ]);
  try {
    return await fn();
  } finally {
    await db.query(`RESET ${OWNER_COMPANY_SETTING}`);
  }
}

/**
 * The day's disclosure reaching the rep, and the correction window closing
 * on everything it carried (ticket #127).
 *
 * A fact is owner-visible only once it is FINALIZED, and finalization is
 * not a column a test may set: `finalizeDueFacts` is the writer, and it
 * starts the clock at the instant the fact's disclosure line became
 * REP-REACHABLE — the executed system send that carried the day's post. So
 * this fixture writes the rep-side rows that make a line reachable (a
 * notice, the send that delivered it, the post and its line mapping) and
 * lets the real writer do the Ledger's half. Assembling a real post is the
 * daily pass's job and lives twin-side; what is reproduced here is only its
 * effect on reachability.
 *
 * The notice text is DEK-sealed like every twin-authored post, because
 * crypto is never mocked (ADR-0028) even where nothing reads the plaintext
 * back.
 */
export async function discloseAndFinalize(
  db: pg.ClientBase,
  seat: Seat,
  reachableAt: Date,
  now: Date,
): Promise<readonly string[]> {
  const sealed = Buffer.from(
    seat.dek.encrypt(Buffer.from("✳️ Esto es lo que registré hoy.", "utf8")),
  );
  const notice = await db.query<{ id: string }>(
    `INSERT INTO notices (twin_id, kind, content_enc)
     VALUES ($1, 'daily_disclosure', $2) RETURNING id`,
    [seat.twinId, sealed],
  );
  const noticeId = notice.rows[0]!.id;
  await db.query(
    `INSERT INTO send_commands
       (twin_id, send_class, destination, payload_ref, outcome, executed_at)
     VALUES ($1, 'system_send', $2, $3, 'sent', $4)`,
    [seat.twinId, SELF_CHAT, `notice:${noticeId}`, reachableAt],
  );
  // ONE TRANSACTION, because the store says so: a post's line numbering is
  // sealed with the post (ADR-0034), and a line joining it afterwards is
  // refused by a trigger — the numbering is the record of what the rep saw.
  await db.query("BEGIN");
  try {
    const post = await db.query<{ id: string }>(
      // `posted_at` is left at its default, which is TRANSACTION time: the
      // seal trigger compares a line's arrival against it, so a post
      // back-dated to the disclosure day could never carry a line. What
      // starts the correction window is the executed send above, not this.
      `INSERT INTO disclosure_posts (twin_id, disclosure_day, notice_id)
       VALUES ($1, $2::date, $3) RETURNING id`,
      [seat.twinId, reachableAt, noticeId],
    );
    await db.query(
      `INSERT INTO disclosure_post_lines (twin_id, post_id, line_index, disclosure_line_id)
       SELECT dl.twin_id, $2,
              row_number() OVER (ORDER BY dl.filed_at, dl.id),
              dl.id
         FROM disclosure_lines dl
        WHERE dl.twin_id = $1
          AND NOT EXISTS (
            SELECT 1 FROM disclosure_post_lines pl
             WHERE pl.twin_id = dl.twin_id AND pl.disclosure_line_id = dl.id
          )`,
      [seat.twinId, post.rows[0]!.id],
    );
    await db.query("COMMIT");
  } catch (err) {
    await db.query("ROLLBACK");
    throw err;
  }
  const result = await finalizeDueFacts({ db }, { twinId: seat.twinId }, now);
  return result.factIds;
}

/**
 * The lift act, run for real (ADR-0016 as amended; ticket #132).
 *
 * IT STOPPED BEING AN EXCEPTION. Until #132 this wrote the two columns by
 * hand — "standing in for the one that does not exist yet", with no audit
 * entry and no refusal to run twice — because a suite asserting what the
 * OWNER sees cannot do it over a Ledger where every row is shadow. The
 * writer exists now, so the stand-in is gone: this calls `liftCompanyShadow`
 * and every suite that lifts a company drives the real act, chain entry and
 * refusals included, for free.
 *
 * THE SIGNATURE IS UNCHANGED, deliberately — `liftedAt` is the act's `now`,
 * which is what it always meant. What changed underneath is that a suite
 * lifting the same company TWICE is now told no, which is the act's own
 * contract and the right thing for a fixture to inherit: one caller in
 * `owner-reads.int.test.ts` was doing exactly that, and did not need to,
 * because the stamp already files its later rows visible.
 *
 * The chain key is this file's own (`TEST_AUDIT_HMAC_KEY`), the one every
 * fixture here already chains entity creates under: a second key inside one
 * suite would be refused by the append, because it authenticates the tail
 * before extending it.
 */
export async function liftShadow(
  db: pg.ClientBase,
  companyId: string,
  liftedAt: Date,
): Promise<void> {
  await liftCompanyShadow(
    { db, hmacKey: TEST_AUDIT_HMAC_KEY },
    { companyId, now: liftedAt },
  );
}

/**
 * The other three fact types, so a suite can seed all six (ticket #129).
 *
 * `quote` (QuoteGiven), `promise` (DatePromised) and `establishContact`
 * (ContactEstablished) were here already; the owner's timeline renders six
 * types, and a suite that can seed three can only assert about three.
 *
 * EACH ONE IS ORDINARY TRAFFIC, like every other helper in this file: a
 * `wa_events` row the plane could have delivered, then the real aperture
 * reading it. Two of the three turn on which SIDE of the conversation
 * spoke, and getting that wrong is a refusal rather than a drop
 * (ADR-0038's authorship fence), so each says whose message it is:
 *
 *   - `orderRequested` is the CUSTOMER asking, so the row is
 *     counterparty-authored;
 *   - `orderTaken` is the rep agreeing, so the row is the rep's — and its
 *     `agreement` is NOT a payload field a caller supplies. The aperture
 *     composes it off the rep's own message and discards whatever a caller
 *     put there (ADR-0038), which is why this fixture takes the message
 *     TEXT and never the field;
 *   - `customerPattern` is the customer stating a standing constraint in
 *     their own words (ADR-0040), so it too is counterparty-authored.
 */
export async function orderRequested(
  db: pg.ClientBase,
  seat: Seat,
  entityId: string,
  chatJid: string,
  payload: Readonly<Record<string, unknown>>,
  options: FiledAtOptions = {},
): Promise<string> {
  const messageId = nextMessageId("ORDREQ");
  const sourceEventId = await insertWaEventFixture(db, seat.dek, {
    twinId: seat.twinId,
    companyId: seat.companyId,
    seatId: seat.seatId,
    chatJid,
    senderJid: chatJid,
    fromMe: false,
    messageId,
    text: "te pido 40 bultos de mortero",
    ...(options.occurredAt === undefined ? {} : { occurredAt: options.occurredAt }),
  });
  return fileOrThrow(db, seat, {
    twinId: seat.twinId,
    entityId,
    sourceEventId,
    factType: "OrderRequested",
    payload,
    confidence: 0.91,
    reading: "stated",
    renderDisclosureLine: () => "Te pidió 40 bultos de mortero.",
  });
}

export async function orderTaken(
  db: pg.ClientBase,
  seat: Seat,
  entityId: string,
  chatJid: string,
  agreementText: string,
  payload: Readonly<Record<string, unknown>>,
  options: FiledAtOptions = {},
): Promise<string> {
  const messageId = nextMessageId("ORDTAKEN");
  const sourceEventId = await insertWaEventFixture(db, seat.dek, {
    twinId: seat.twinId,
    companyId: seat.companyId,
    seatId: seat.seatId,
    chatJid,
    senderJid: SELF_CHAT,
    fromMe: true,
    messageId,
    // What the aperture will store as `agreement`, verbatim.
    text: agreementText,
    ...(options.occurredAt === undefined ? {} : { occurredAt: options.occurredAt }),
  });
  return fileOrThrow(db, seat, {
    twinId: seat.twinId,
    entityId,
    sourceEventId,
    factType: "OrderTaken",
    payload,
    confidence: 0.97,
    reading: "stated",
    renderDisclosureLine: () => "Le confirmaste el pedido.",
  });
}

export async function customerPattern(
  db: pg.ClientBase,
  seat: Seat,
  entityId: string,
  chatJid: string,
  pattern: string,
  options: FiledAtOptions = {},
): Promise<string> {
  const messageId = nextMessageId("PATTERN");
  const sourceEventId = await insertWaEventFixture(db, seat.dek, {
    twinId: seat.twinId,
    companyId: seat.companyId,
    seatId: seat.seatId,
    chatJid,
    senderJid: chatJid,
    fromMe: false,
    messageId,
    text: "nomás recibimos material antes de las 2",
    ...(options.occurredAt === undefined ? {} : { occurredAt: options.occurredAt }),
  });
  return fileOrThrow(db, seat, {
    twinId: seat.twinId,
    entityId,
    sourceEventId,
    factType: "CustomerPattern",
    payload: { pattern },
    confidence: 0.93,
    reading: "stated",
    renderDisclosureLine: () => `Te dijo que ${pattern}.`,
  });
}

/**
 * The rep's «N no» on a line the day's disclosure carried (ticket #129;
 * ADR-0004's correction window; FR-33).
 *
 * ORDINARY TRAFFIC, like everything else here: a `wa_events` row the plane
 * could have delivered, then the real class-2 rep act. The seam row must be
 * the REP's own and must carry this seat's company — the aperture takes the
 * company off the seam row and matches it against the disclosure line, and
 * an unpinned one throws rather than refusing.
 *
 * IT MUST RUN BEFORE `discloseAndFinalize`. A retracted fact never
 * finalizes — the store's CHECK makes the pair unrepresentable — so after
 * the window has closed on a fact this returns `window_closed` and changes
 * nothing, which is a silently un-retracted row for a suite that ignored
 * the outcome. This one does not ignore it.
 */
export async function retractFact(
  db: pg.ClientBase,
  seat: Seat,
  factId: string,
  retractedAt: Date,
): Promise<void> {
  const line = await db.query<{ id: string }>(
    "SELECT id FROM disclosure_lines WHERE fact_id = $1",
    [factId],
  );
  const disclosureLineId = line.rows[0]?.id;
  if (disclosureLineId === undefined) {
    throw new Error(`fixture: fact ${factId} has no disclosure line`);
  }
  const messageId = nextMessageId("RETRACT");
  const sourceEventId = await insertWaEventFixture(db, seat.dek, {
    twinId: seat.twinId,
    companyId: seat.companyId,
    seatId: seat.seatId,
    chatJid: SELF_CHAT,
    senderJid: SELF_CHAT,
    fromMe: true,
    messageId,
    // The grammar lives in the twin-runtime matcher; nothing the aperture
    // reads depends on these words.
    text: "1 no",
    occurredAt: retractedAt,
  });
  const outcome = await retractDisclosedFact(apertureCtx(db, seat.dek), {
    twinId: seat.twinId,
    disclosureLineId,
    evidence: { surface: "twin_thread", sourceEventId, waMessageId: messageId },
  });
  if (!outcome.retracted) {
    throw new Error(`fixture did not retract: ${outcome.reason}`);
  }
}

/**
 * `fileCandidateFact` returns a refusal as a VALUE, so a fixture that
 * ignored the outcome would seed nothing and leave a suite asserting
 * against an empty Ledger. The three helpers above go through here, once.
 */
async function fileOrThrow(
  db: pg.ClientBase,
  seat: Seat,
  request: Parameters<typeof fileCandidateFact>[1],
): Promise<string> {
  const outcome = await fileCandidateFact({ db, dek: seat.dek }, request);
  if (!outcome.filed) {
    throw new Error(`fixture did not file: ${outcome.reason}`);
  }
  return outcome.factId;
}

/** The owner-assigned grant, which is the only thing that widens a read. */
export async function grantOwnerAssigned(
  db: pg.ClientBase,
  companyId: string,
  entityId: string,
  twinId: string,
): Promise<void> {
  await db.query(
    `INSERT INTO ledger.entity_grants (company_id, entity_id, twin_id, source)
     VALUES ($1, $2, $3, 'owner_assigned')`,
    [companyId, entityId, twinId],
  );
}

export async function countFacts(
  db: pg.ClientBase,
  companyId: string,
): Promise<number> {
  const res = await db.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM ledger.facts WHERE company_id = $1",
    [companyId],
  );
  return res.rows[0]!.n;
}

export async function countGrants(
  db: pg.ClientBase,
  companyId: string,
): Promise<number> {
  const res = await db.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM ledger.entity_grants WHERE company_id = $1",
    [companyId],
  );
  return res.rows[0]!.n;
}

export async function countDisclosureLines(
  db: pg.ClientBase,
  companyId: string,
): Promise<number> {
  const res = await db.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM disclosure_lines WHERE company_id = $1",
    [companyId],
  );
  return res.rows[0]!.n;
}

/**
 * When the message a fact is read in was sent. The fact's `occurred_at` is
 * the seam row's instant and never the caller's, so this is how a suite
 * asserting «in `occurred_at` order» gets facts that are actually ordered.
 */
export interface FiledAtOptions {
  readonly occurredAt?: Date;
}

/** What a suite may confirm about a customer, when it binds one. */
export interface BindOptions {
  readonly kind?: EntityKind;
  readonly confirmedAt?: Date;
}

/** The identifier arms a `ContactEstablished` may carry. */
export interface ContactIdentifiers {
  readonly phones?: readonly string[];
  readonly emails?: readonly string[];
  readonly rfcs?: readonly string[];
}

/**
 * The whole set, bound to one suite's client.
 *
 * A GETTER rather than the client, because a suite connects in `beforeAll`
 * and binds at module scope. Destructured at the call site, so each suite
 * reads exactly as it did when the helpers were local — and there is one
 * adapter rather than one per suite, which is what stopped two suites'
 * copies of `bindCustomer` from taking different arguments.
 */
export function boundTo(getDb: () => pg.ClientBase) {
  return {
    freshSeat,
    bindCustomer: (seat: Seat, displayName: string, options: BindOptions = {}) =>
      bindCustomer(getDb(), seat, displayName, options),
    establishContact: (
      seat: Seat,
      entityId: string,
      chatJid: string,
      identifiers: ContactIdentifiers,
    ) => establishContact(getDb(), seat, entityId, chatJid, identifiers),
    quote: (seat: Seat, entityId: string, chatJid: string, amount: number) =>
      quote(getDb(), seat, entityId, chatJid, amount),
    promise: (seat: Seat, entityId: string, chatJid: string) =>
      promise(getDb(), seat, entityId, chatJid),
    orderRequested: (
      seat: Seat,
      entityId: string,
      chatJid: string,
      payload: Readonly<Record<string, unknown>>,
      options: FiledAtOptions = {},
    ) => orderRequested(getDb(), seat, entityId, chatJid, payload, options),
    orderTaken: (
      seat: Seat,
      entityId: string,
      chatJid: string,
      agreementText: string,
      payload: Readonly<Record<string, unknown>>,
      options: FiledAtOptions = {},
    ) =>
      orderTaken(
        getDb(),
        seat,
        entityId,
        chatJid,
        agreementText,
        payload,
        options,
      ),
    customerPattern: (
      seat: Seat,
      entityId: string,
      chatJid: string,
      pattern: string,
      options: FiledAtOptions = {},
    ) => customerPattern(getDb(), seat, entityId, chatJid, pattern, options),
    retractFact: (seat: Seat, factId: string, retractedAt: Date) =>
      retractFact(getDb(), seat, factId, retractedAt),
    grantOwnerAssigned: (companyId: string, entityId: string, twinId: string) =>
      grantOwnerAssigned(getDb(), companyId, entityId, twinId),
    registerSeat: (
      seat: Seat,
      names: { readonly company: string; readonly rep: string },
    ) => registerSeat(getDb(), seat, names),
    discloseAndFinalize: (seat: Seat, reachableAt: Date, now: Date) =>
      discloseAndFinalize(getDb(), seat, reachableAt, now),
    liftShadow: (companyId: string, liftedAt: Date) =>
      liftShadow(getDb(), companyId, liftedAt),
    seedCompany: (
      names: {
        readonly company: string;
        readonly rep: string;
        readonly customer: string;
      },
      reachableAt: Date,
      windowClosedAt: Date,
    ) => seedCompany(getDb(), names, reachableAt, windowClosedAt),
    withDeclaredCompany: <T>(companyId: string, fn: () => Promise<T>) =>
      withDeclaredCompany(getDb(), companyId, fn),
    countFacts: (companyId: string) => countFacts(getDb(), companyId),
    countGrants: (companyId: string) => countGrants(getDb(), companyId),
    countDisclosureLines: (companyId: string) =>
      countDisclosureLines(getDb(), companyId),
  };
}
