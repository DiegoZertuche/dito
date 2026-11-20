/**
 * One company's Ledger, as the owner side has to be able to read it
 * (ticket #129).
 *
 * ONE SEED FOR TWO SUITES, for the reason `ledger-fixtures.ts` itself was
 * lifted out of `merge.int.test.ts`: the owner read module is asserted at
 * the Postgres seam (`owner-reads.int.test.ts`) and the pages that render
 * it are asserted at the HTTP seam (`apps/owner-web`), and two suites
 * seeding subtly different Ledgers is how a page passes over a corpus its
 * module never saw.
 *
 * WHAT IT CONTAINS, and why each piece is here:
 *
 *   - one cliente carrying ALL SIX fact types, because the timeline renders
 *     six and a corpus of three can only prove three;
 *   - an `OrderRequested` with no amount, no currency and no day, so
 *     "an absent field renders as absent, never as a default" (ADR-0034)
 *     has something to be true of;
 *   - an `OrderTaken` whose `agreement` is the rep's own message, composed
 *     by the aperture off the seam row (ADR-0038);
 *   - a `ContactEstablished` carrying a real phone number, which is the one
 *     payload that holds a thing the wall forbids showing (ADR-0004);
 *   - TWO records the MATCHER joined on a shared RFC — a merge seeded as
 *     ordinary traffic rather than a hand-filed edge — each carrying a quote
 *     that must read forward under the survivor, unmoved (ADR-0035);
 *   - a fact filed AFTER the lift, which since ticket #132 lands VISIBLE:
 *     the aperture stamps `shadow` at filing from the company's mode, so a
 *     lifted company's later facts appear the moment they finalize, with
 *     nobody touching them (ADR-0016 as amended). It was the opposite row
 *     when this corpus was written, and the constant's name changed with
 *     it;
 *   - a fact the rep took back inside the correction window, which never
 *     finalizes and must never appear either.
 *
 * Everything files through the real aperture off `wa_events` rows the plane
 * could have delivered. Nothing here writes a `ledger` table.
 */
import type pg from "pg";
import { runMergeMatcher } from "../merge.js";
import { TEST_AUDIT_HMAC_KEY } from "./context.js";
import { boundTo, freshSeat, type Seat } from "./ledger-fixtures.js";

/**
 * The rep's own words of agreement, which is what an `OrderTaken` stores —
 * A THIRD PARTY'S NUMBER AND ALL.
 *
 * The aperture refuses a WhatsApp address and the COUNTERPARTY'S OWN number
 * in a payload string, and cannot refuse this one: it is a different
 * person's, and the sentence is the rep's own message, which ADR-0038 says
 * an `OrderTaken` carries verbatim. So it crosses, it is stored exactly as
 * written, and ADR-0004 says it must not reach an owner surface. The
 * corpus carries it so that claim is asserted over a real row.
 */
export const CORPUS_AGREEMENT =
  "va, se los mando el lunes — coordina con Juan al 81 1234 5678";
/** ...and the part of it an owner may read. */
export const CORPUS_AGREEMENT_THIRD_PARTY_NUMBER = "81 1234 5678";
export const CORPUS_AGREEMENT_AS_RENDERED =
  "va, se los mando el lunes — coordina con Juan al (número omitido)";
/** The clause a `CustomerPattern` composed from the customer's message. */
export const CORPUS_PATTERN = "solo recibe material antes de las 2 de la tarde";
/**
 * The one amount filed AFTER the lift — visible since ticket #132, and the
 * row that proves the launch gate does not have to be re-flipped for every
 * later crossing.
 */
export const CORPUS_AFTER_LIFT_AMOUNT = 7777;
/** ...and the one the rep took back before the window closed on it. */
export const CORPUS_RETRACTED_AMOUNT = 3333;
/** The two quotes on the merged pair, one per member, neither of which moves. */
export const CORPUS_WINNER_QUOTE = 1200;
export const CORPUS_LOSER_QUOTE = 900;
/** The phone a customer gave, normalized by the aperture into the payload. */
export const CORPUS_PHONE = "81 8000 1111";
/**
 * A customer whose CONFIRMED NAME is a phone number.
 *
 * Not a hypothetical: production proposes an entity's display name off the
 * chat's PUSH NAME, which is a string the customer sets, and
 * `ledger.entities.display_name` has no fence — `seats.rep_display_name`
 * has exactly this CHECK and this column does not. The aperture accepts it,
 * the finalized view passes it through, and it reaches an owner page unless
 * the surface refuses to say it (ADR-0004).
 *
 * A NUMBER RATHER THAN A WhatsApp ADDRESS, deliberately. A JID in a Ledger
 * text column is a wall violation in the DATA and `ledger-wall-check` exists
 * to turn red over exactly that row — planting one in a shared corpus would
 * be arming a check against itself. This number belongs to no chat in this
 * corpus, so the sweep's laundering half has nothing to match either. The
 * address case is covered where it costs nothing: the renderer's own unit
 * test.
 */
export const CORPUS_WALL_SHAPED_NAME = "5215550001";

/** The day the corpus is disclosed, and the day its window closes. */
const DISCLOSED_AT = new Date("2026-09-01T23:30:00Z");
const WINDOW_CLOSED = new Date("2026-09-03T00:00:00Z");
/** ...and the second pass, which finalizes the post-lift fact. */
const LATER_DISCLOSED_AT = new Date("2026-09-03T23:30:00Z");
const LATER_WINDOW_CLOSED = new Date("2026-09-05T00:00:00Z");

export interface OwnerCorpusNames {
  readonly company: string;
  readonly rep: string;
  readonly customer: string;
  /** The two records the matcher will join into one cliente. */
  readonly mergedWinner: string;
  readonly mergedLoser: string;
}

export interface OwnerCorpus {
  readonly seat: Seat;
  readonly names: OwnerCorpusNames;
  readonly customer: { readonly entityId: string; readonly chat: string };
  /** The two records the matcher joined, and the facts under the survivor. */
  readonly merged: {
    readonly winner: string;
    readonly winnerName: string;
    readonly loser: string;
    readonly loserName: string;
    readonly factIds: readonly string[];
  };
  /** Every chat this company's traffic came through — none may be rendered. */
  readonly chats: readonly string[];
}

/**
 * A company whose Ledger a suite can assert every owner claim against.
 *
 * `db` is the schema owner's connection, as every seeding path in this repo
 * is: the reader is what slice 4 changes, not the writer.
 */
export async function seedOwnerCorpus(
  db: pg.ClientBase,
  names: OwnerCorpusNames,
): Promise<OwnerCorpus> {
  const fixtures = boundTo(() => db);
  const seat = freshSeat();
  await fixtures.registerSeat(seat, { company: names.company, rep: names.rep });

  const chat = freshChat();
  const entityId = await fixtures.bindCustomer(seat, names.customer);
  await fixtures.quote(seat, entityId, chat, 4500);
  await fixtures.promise(seat, entityId, chat);
  await fixtures.orderRequested(
    seat,
    entityId,
    chat,
    { item: "mortero", quantity: 40, unit: "bultos" },
    { occurredAt: new Date("2026-08-28T16:00:00Z") },
  );
  await fixtures.orderTaken(
    seat,
    entityId,
    chat,
    CORPUS_AGREEMENT,
    { item: "cajas", quantity: 100, amount: 52800, currency: "MXN" },
    { occurredAt: new Date("2026-08-29T10:00:00Z") },
  );
  await fixtures.customerPattern(seat, entityId, chat, CORPUS_PATTERN, {
    occurredAt: new Date("2026-08-28T09:00:00Z"),
  });
  // THE REP TOOK ONE BACK. A retracted fact keeps its row and stays in the
  // rep's timeline (FR-33) and never finalizes — the store's CHECK makes
  // the pair unrepresentable — so it is filtered by both halves of the
  // owner's view predicate. Retracted BEFORE the window closes, because
  // afterwards the correction is refused and changes nothing.
  const takenBack = await fixtures.quote(
    seat,
    entityId,
    chat,
    CORPUS_RETRACTED_AMOUNT,
  );
  await fixtures.retractFact(seat, takenBack, new Date("2026-08-28T02:00:00Z"));

  await fixtures.establishContact(seat, entityId, chat, {
    phones: [CORPUS_PHONE],
    emails: ["Ana@Ferreteria.MX"],
    rfcs: ["FUE930101AB1"],
  });

  // ...and a customer the rep confirmed under a name that is a WhatsApp
  // address. It has no facts: what is being asserted is that the NAME never
  // reaches a page, and a cliente with an empty timeline makes that claim
  // without any other row to confuse it.
  await fixtures.bindCustomer(seat, CORPUS_WALL_SHAPED_NAME);

  // THE MERGE, CLIMBED RATHER THAN FILED. Survivorship is the written
  // rule's (ADR-0035): the older `created_at` wins, so the two
  // confirmations are two days apart and the ladder decides the rest.
  const winnerName = names.mergedWinner;
  const loserName = names.mergedLoser;
  const winner = await fixtures.bindCustomer(seat, winnerName, {
    kind: "business",
    confirmedAt: new Date("2026-08-20T10:00:00Z"),
  });
  const loser = await fixtures.bindCustomer(seat, loserName, {
    kind: "business",
    confirmedAt: new Date("2026-08-22T10:00:00Z"),
  });
  const winnerChat = freshChat();
  const loserChat = freshChat();
  const rfc = freshRfc();
  await fixtures.establishContact(seat, winner, winnerChat, { rfcs: [rfc] });
  await fixtures.establishContact(seat, loser, loserChat, {
    // The same RFC in the other case: normalization is what makes them one
    // key, and a fixture that pre-normalized would be testing itself.
    rfcs: [rfc.toLowerCase()],
  });
  await fixtures.quote(seat, winner, winnerChat, CORPUS_WINNER_QUOTE);
  await fixtures.quote(seat, loser, loserChat, CORPUS_LOSER_QUOTE);
  const report = await runMergeMatcher(
    { db, hmacKey: TEST_AUDIT_HMAC_KEY },
    { companyId: seat.companyId },
  );
  if (
    report.merged.length !== 1 ||
    report.merged[0]!.winnerEntityId !== winner ||
    report.merged[0]!.loserEntityId !== loser
  ) {
    throw new Error(
      `owner corpus: the matcher did not join the pair (${report.merged.length} merges)`,
    );
  }

  await fixtures.discloseAndFinalize(seat, DISCLOSED_AT, WINDOW_CLOSED);
  await fixtures.liftShadow(seat.companyId, WINDOW_CLOSED);

  // AFTER THE LIFT, AND VISIBLE FOR IT (ticket #132). The aperture stamps
  // `shadow` at filing from the company's mode, so a fact filed once this
  // company is lifted lands `shadow = false` and appears the moment its
  // correction window closes — which is the half of ADR-0016's amendment a
  // one-off `UPDATE` could never have delivered, and exactly the row an
  // owner surface must be asserted against.
  await fixtures.quote(seat, entityId, chat, CORPUS_AFTER_LIFT_AMOUNT);
  await fixtures.discloseAndFinalize(
    seat,
    LATER_DISCLOSED_AT,
    LATER_WINDOW_CLOSED,
  );

  const contactFacts = await db.query<{ id: string }>(
    `SELECT id FROM ledger.facts
      WHERE company_id = $1 AND entity_id = ANY($2::uuid[])
        AND fact_type = 'ContactEstablished'`,
    [seat.companyId, [winner, loser]],
  );
  const quoteFacts = await db.query<{ id: string }>(
    `SELECT id FROM ledger.facts
      WHERE company_id = $1 AND entity_id = ANY($2::uuid[])
        AND fact_type = 'QuoteGiven'`,
    [seat.companyId, [winner, loser]],
  );
  return {
    seat,
    names,
    customer: { entityId, chat },
    merged: {
      winner,
      winnerName,
      loser,
      loserName,
      factIds: [
        ...quoteFacts.rows.map((r) => r.id),
        ...contactFacts.rows.map((r) => r.id),
      ],
    },
    chats: [chat, winnerChat, loserChat],
  };
}

/**
 * A WhatsApp address nothing else in the cluster uses. `wa_events` dedupes
 * on `<chatJid>:<messageId>` GLOBALLY rather than per twin, so two
 * companies seeded in one database need chats that differ.
 */
let chats = 0;
function freshChat(): string {
  chats += 1;
  return `52155${9000000 + chats}@s.whatsapp.net`;
}

/**
 * ...and one RFC per merged pair, so two companies seeded side by side
 * cannot climb each other's rung. Twelve characters, the shape a business
 * RFC has, because the aperture normalizes and stores what it is given.
 */
let rfcs = 0;
function freshRfc(): string {
  rfcs += 1;
  return `TOR8501${10 + rfcs}AB1`;
}
