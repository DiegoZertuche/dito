/**
 * THE TWO LINK CREDENTIALS, AND THE ASK THAT PRODUCES ONE (ticket #223; spec
 * #214 *Link day, in detail*, user stories 13, 14 and 15; ADR-0010, ADR-0031).
 *
 * "As a rep on a phone, I want a pairing code I type into WhatsApp" · "As a
 * rep on a laptop, I want a QR to scan" · "I want the code or QR shown within
 * seconds of the page opening, so that the 160-second window is mine, not the
 * plane's."
 *
 * ═══ THE READ: ONE DOOR TO A COLUMN NOTHING ELSE MAY OPEN
 *
 * Both credentials ride in `rail_status_events.detail` — a QR payload on a
 * `qr` row, eight characters on a `pairing_code` row — and `dito_rep_web`
 * holds NO column privilege on it, deliberately: the table carries no company
 * and no row-level security, so a table-wide SELECT would hand one login role
 * every twin in the fleet's live pairing tokens and a link-hijack would need
 * nothing else (`grants.ts` argues it in full). So the credential reaches a
 * page through the lease holder, on this read, and through nothing else.
 * `readRailState` and `readLinkSession` — which BOTH sides call, for the last
 * state and for the window's clock — select no `detail` at all, so the grant
 * and those queries go on saying one thing twice.
 *
 * BOTH DOORS OF ONE SESSION, AND NOT THE NEWEST ROW (boundary #225, F10). A
 * read of the latest row alone served a pairing code only until the plane's
 * next QR superseded it: both codes served on the rig went unread and the
 * pairing-code path was never typed. This read answers the SESSION — the
 * newest `qr` and the newest `pairing_code` in it — so a rep types a code
 * while a laptop's QR keeps refreshing on the other tab. What a session is and
 * how long it lasts is `RAIL_CREDENTIAL_STATUSES`' argument.
 *
 * A CREDENTIAL IS SERVED ONLY WHILE ITS SESSION STANDS. On a `linked`,
 * `dropped` or `logged_out` row the column still holds whatever the plane last
 * wrote there, and handing that over would let the link page draw a QR beside
 * «tu número quedó vinculado» — a credential for a socket that is not waiting
 * for one. Those rows are the session's boundary, so a session that has ended
 * has no rows to serve and `detail` is not read at all.
 *
 * ═══ THE ASK: THE ONE WRITER OF A `pairing_code` ROW
 *
 * The store holds that kind and the plane serves it; this is the only thing in
 * this repo that writes one, and three things about it are decisions rather
 * than plumbing.
 *
 * THE NUMBER IS THE RUNTIME'S OWN AND NEVER A REQUEST VALUE. `PairPhone` takes
 * the number the code is generated for, and the only number that can be right
 * is the one whose WhatsApp is about to be linked — the rep's own, which the
 * runtime knows as its self-chat identity because that is the thread it posts
 * into (ADR-0006). A `phone` taken from a body would let a caller past the
 * bearer ask the plane to generate a pairing code for somebody else's number.
 *
 * ONE LIVE ASK AT A TIME. The plane serves requests one at a time and a code
 * lives ~160 seconds, so a second ask queued behind the first would produce a
 * second credential the moment the first expires — with the rep looking at a
 * page that shows one of them. So an unsettled `pairing_code` request is
 * `already`, decided inside the same transaction as the insert and under an
 * advisory lock on the twin, because reading «is one live» and writing are two
 * statements and two concurrent asks would both read «no».
 *
 * AND IT IS REFUSED WHEN THE RAIL IS ALREADY LINKED, by a closed word rather
 * than by letting the plane refuse it: the plane's own `already_linked` reason
 * exists, but spending a request row and a plane pass to learn what the rail
 * seam already says is a refusal the rep waits two seconds for. The seam's
 * latest row is read in the same transaction.
 *
 * ═══ NO ACT ROW, NO CHAIN ENTRY (#78's rule)
 *
 * A chained act is a REP ACT with evidence and an execution behind it. Asking
 * for a pairing code is none of those: the rep chose no target (the number is
 * the runtime's), nothing crosses, no model runs, no customer hears anything,
 * and the thing that follows is a credential on a screen. The
 * `plane_requests` row IS the record — it carries the twin, the kind, the
 * instant, and the outcome the plane stamps — and `audit-coverage.ts`'
 * `scope_change` class already excludes this kind by name for the same reason.
 */
import {
  RAIL_CREDENTIAL_STATUSES,
  type LinkAsk,
  readLinkSession,
  readRailState,
  withReadSnapshot,
  type PlaneRequestKind,
  type RailCredentialStatus,
  type RailStatus,
  type TwinLinkState,
} from "@dito/seam";
import type pg from "pg";
import { withDbTransaction } from "./db-tx.js";

/**
 * The kind this module writes.
 *
 * TYPED FROM THE SEAM'S OWN CLOSED SET rather than written as a bare literal,
 * so a vocabulary that lost the word is a type error here rather than a
 * constraint violation on the insert — the shape `SEAT_LINKED` uses one
 * package over.
 */
const PAIRING_CODE: PlaneRequestKind = "pairing_code";

/** What the link read needs: a connection and the twin. */
export interface LinkReadDeps {
  readonly db: pg.ClientBase;
  readonly twinId: string;
  /**
   * The instant this read answers at, a parameter and never a clock read in
   * here — it bounds «is an ask still on its way» by the same window the ask
   * itself uses (`LINK_ASK_WINDOW_SECONDS`).
   */
  readonly now: Date;
}

/**
 * The rail's state for this twin, with the standing session's credentials.
 *
 * FOUR STATEMENTS, EACH ANSWERING ONE QUESTION, and two of them are the seam's
 * own: where the session starts (`readLinkSession`), what the rail last did
 * (`readRailState`), which two credentials that session has served, and
 * whether the plane owes another. One clever statement answering all four
 * would be the only place in the repo that knows what a link session is — the
 * seam's two keep that knowledge where rep-web reads it too.
 *
 * ALL FOUR IN ONE SNAPSHOT, which is what makes them one READING rather than
 * four instants (`withReadSnapshot` argues the failure in full): the plane
 * writes while a page is being drawn, and a new session opening — with its ask
 * settling — between the first statement and the last would answer with the
 * NEW credentials on the OLD session's anchor and nothing pending. The page's
 * arithmetic reads that as «se venció», and that screen carries no refresh: the
 * code the rep just asked for would sit unread on the rail (Codex r2).
 *
 * `detail` IS READ ONLY INSIDE A STANDING SESSION, which is the strongest form
 * of the module header's rule: with no session there is no statement that
 * touches the column at all.
 */
export async function readLinkForTwin(
  deps: LinkReadDeps,
): Promise<TwinLinkState> {
  return await withReadSnapshot(deps.db, async () => {
    const session = await readLinkSession(
      deps.db,
      deps.twinId,
      LINK_ASK_WINDOW_SECONDS,
    );
    const rail = await readRailState(deps.db, deps.twinId);
    const credentials =
      session === null
        ? {}
        : await readSessionCredentials(deps.db, deps.twinId, session.fromId);
    // ...AND WHAT BECAME OF THE NEWEST ASK, which is a different question
    // from what the rail last wrote: between «Generar otro» and the plane's
    // answer the rail still holds the OLD row, and a page that could not tell
    // those apart showed «se venció» for the whole life of the replacement
    // (#223, Codex r2) — or a request the plane failed, or never took, as one
    // still on its way (#403). Bounded by the same window the ask itself uses,
    // so an ask nothing will ever serve stops being anything at all.
    const ask = await readNewestAsk(deps.db, deps.twinId, deps.now);
    return {
      status: rail.status,
      at: rail.at === null ? null : rail.at.toISOString(),
      windowOpenedAt:
        session === null ? null : session.windowOpenedAt.toISOString(),
      ask,
      ...credentials,
    };
  });
}

/**
 * The newest pairing-code ask inside the window, as one `LinkAsk` word.
 *
 * THE NEWEST AND NOT ANY, because a rep who asks again over a failed ask has
 * asked again: the old failure is not what the page is about any more.
 */
async function readNewestAsk(
  db: pg.ClientBase,
  twinId: string,
  now: Date,
): Promise<LinkAsk> {
  const newest = await db.query<{
    outcome: string | null;
    taken: boolean;
    overdue: boolean;
  }>(
    `SELECT outcome,
            taken_at IS NOT NULL AS taken,
            requested_at <= $3::timestamptz - $5::interval AS overdue
       FROM plane_requests
      WHERE twin_id = $1 AND kind = $2
        AND requested_at > $3::timestamptz - $4::interval
      ORDER BY requested_at DESC, id DESC
      LIMIT 1`,
    [
      twinId,
      PAIRING_CODE,
      now.toISOString(),
      `${String(LINK_ASK_WINDOW_SECONDS)} seconds`,
      `${String(LINK_ASK_UNTAKEN_SECONDS)} seconds`,
    ],
  );
  const row = newest.rows[0];
  // A REFUSAL IS NOT A FAILURE: the plane refuses an ask by name when the
  // number already holds a session, and the rail's own rows are then the
  // answer (`link.askRefused`'s rule) — «falló, pídelo otra vez» would send the
  // rep round a loop the plane refuses every time.
  if (row === undefined || (row.outcome !== null && row.outcome !== "failed")) {
    return "none";
  }
  if (row.outcome === "failed") return "failed";
  return !row.taken && row.overdue ? "untaken" : "waiting";
}

/**
 * The newest credential of each kind inside one session.
 *
 * `DISTINCT ON (status)` SO THE ANSWER IS TWO ROWS AT MOST, however many QR
 * refreshes the session has written: what the page needs is the newest of each
 * door, and reading the whole session to pick two out of it in TypeScript
 * would put a credential the page never renders on the wire between the
 * database and this process for every reload.
 *
 * AN EMPTY `detail` IS NOT A CREDENTIAL. The column defaults to the empty
 * string, so a row written without one is a door that does not open — and a
 * panel rendering it would draw a QR of nothing.
 */
async function readSessionCredentials(
  db: pg.ClientBase,
  twinId: string,
  fromId: string,
): Promise<{ qr?: string; pairingCode?: string }> {
  const rows = await db.query<{
    status: RailCredentialStatus;
    detail: string;
  }>(
    `SELECT DISTINCT ON (status) status, detail
       FROM rail_status_events
      WHERE twin_id = $1 AND id >= $2 AND status = ANY($3::text[])
      ORDER BY status, id DESC`,
    [twinId, fromId, [...RAIL_CREDENTIAL_STATUSES]],
  );
  const served: { qr?: string; pairingCode?: string } = {};
  for (const row of rows.rows) {
    if (row.detail === "") continue;
    if (row.status === "qr") served.qr = row.detail;
    else served.pairingCode = row.detail;
  }
  return served;
}

/** What became of one link ask — the acts' own words, and why in the header. */
export type LinkAskOutcome = "performed" | "already" | "refused";

/** What the ask needs: a connection, the twin, and the runtime's own identity. */
export interface LinkAskDeps {
  readonly db: pg.ClientBase;
  readonly twinId: string;
  /**
   * The rep's own thread, which is also the rep's own NUMBER (ADR-0006).
   *
   * THE ONE PLACE THE DIGITS CAN HONESTLY COME FROM. The runtime posts every
   * receipt into this chat, so this is the identity of the account whose
   * WhatsApp is being linked — and it is configuration on the runtime rather
   * than anything a request carries.
   */
  readonly selfChatJid: string;
  /**
   * THE INSTANT THIS ASK IS ASKED AT, a parameter and never a clock read in
   * here (`extraction.ts`' rule for the whole runtime).
   *
   * What it decides is which unsettled request still counts as live
   * (`LINK_ASK_WINDOW_SECONDS`), so a test can put a stale one behind the
   * window without waiting for one.
   */
  readonly now: Date;
}

/**
 * HOW LONG AN UNSETTLED ASK STAYS «LIVE», in seconds.
 *
 * IT IS THE CREDENTIAL'S OWN WINDOW AND NOT A GUESS: a pairing code lasts
 * about 160 seconds (ADR-0031), so a request the plane has not settled within
 * that is a request whose code — if one was ever generated — has expired
 * anyway. Answering `already` past it would leave «Generar otro» permanently
 * dead for a rep whose plane was down when they pressed.
 *
 * IT IS ALSO WHAT THIS PROCESS CALLS A SESSION'S LENGTH, which is the same
 * fact from the other side: `readLinkSession` cuts a session at any silence
 * longer than one window, and the window a code lives in is the window a
 * session lives in (ticket #241).
 *
 * IT IS A SECOND HOME FOR THAT NUMBER, which is recorded on the ticket: the
 * page holds `LINK_WINDOW_SECONDS` for the countdown and the plane holds its
 * own, and a store column beside `history_windows`' would be the single one.
 */
export const LINK_ASK_WINDOW_SECONDS = 160;

/**
 * HOW LONG AN ASK THE PLANE HAS NOT TAKEN STAYS «ON ITS WAY», in seconds.
 *
 * The plane takes requests on a one-second poll, so an ask it has not taken
 * within a few of them belongs to a plane that is not running — or one busy
 * with a fill, whose sitting the rep cannot see either (ticket #403). Twenty
 * is two of the link page's ten-second reloads: the rep sees «Pidiendo tu
 * código» for at most that long before the page says it is taking too long
 * and offers the button again.
 */
export const LINK_ASK_UNTAKEN_SECONDS = 20;

/**
 * The digits `PairPhone` takes, from a self-chat address.
 *
 * A PN AND NOT A LID. The plane's own CHECK wants 10–15 digits
 * (`plane_requests_parameters_phone_check`), and a runtime whose self chat is
 * known only by its hidden-user identity has no phone number to pair — so the
 * ask is refused by name rather than sent with something shaped like a number.
 */
function phoneOf(selfChatJid: string): string | undefined {
  const digits = selfChatJid.split("@")[0]?.split(":")[0] ?? "";
  return /^[0-9]{10,15}$/u.test(digits) ? digits : undefined;
}

/**
 * Asks the plane for a phone-pairing code, once.
 *
 * IT OPENS THE TRANSACTION rather than taking one open, because the three
 * statements inside it are the unit of work: the lock, the two questions and
 * the insert commit together or none of them does.
 */
export async function askForPairingCode(
  deps: LinkAskDeps,
): Promise<LinkAskOutcome> {
  const phone = phoneOf(deps.selfChatJid);
  if (phone === undefined) return "refused";
  return await withDbTransaction(deps.db, async () => {
    // TAKEN BEFORE EITHER QUESTION IS READ, for the reason a lock taken after
    // one protects nothing. Its own namespace, so it cannot collide with the
    // send lock's key over the same twin (`lockTwinForSend`).
    await deps.db.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('dito:link_ask:twin:' || $1, 0))",
      [deps.twinId],
    );
    const rail = await deps.db.query<{ status: RailStatus }>(
      `SELECT status FROM rail_status_events
        WHERE twin_id = $1 ORDER BY id DESC LIMIT 1`,
      [deps.twinId],
    );
    // ALREADY LINKED IS A REFUSAL AND NOT AN «ALREADY», and the two words mean
    // different things to the page: `already` says a credential is on its way,
    // so the page waits; `refused` says asking cannot help, and the page shows
    // the linked state it just read from the seam.
    if (rail.rows[0]?.status === "linked") return "refused";
    // ...AND «LIVE» IS BOUNDED BY THE WINDOW (Codex r1). An unsettled request
    // means the plane owes a code — but only for as long as a code would still
    // be usable. A plane that was down when the rep pressed leaves a request
    // nothing will ever settle;
    // an unbounded read of «is one unsettled» would then answer `already` for
    // ever and «Generar otro» would be a button that cannot work. So a request
    // older than the credential's own window is not a live ask, and pressing
    // writes a new one the next plane to run will serve.
    //
    // AND AN ASK THE PLANE HAS NOT TAKEN IN `LINK_ASK_UNTAKEN_SECONDS` IS NOT
    // LIVE EITHER (#403): the page offers the button again over it, and a
    // button answered `already` would be the same dead button. The new ask
    // queues behind the old one, and a plane that comes back serves both into
    // one link session.
    const live = await deps.db.query(
      `SELECT 1 FROM plane_requests
        WHERE twin_id = $1 AND kind = $2 AND settled_at IS NULL
          AND requested_at > $3::timestamptz - $4::interval
          AND (taken_at IS NOT NULL
               OR requested_at > $3::timestamptz - $5::interval)
        LIMIT 1`,
      [
        deps.twinId,
        PAIRING_CODE,
        deps.now.toISOString(),
        `${String(LINK_ASK_WINDOW_SECONDS)} seconds`,
        `${String(LINK_ASK_UNTAKEN_SECONDS)} seconds`,
      ],
    );
    if (live.rows.length > 0) return "already";
    await deps.db.query(
      `INSERT INTO plane_requests (twin_id, kind, parameters)
       VALUES ($1, $2, jsonb_build_object('phone', $3::text))`,
      [deps.twinId, PAIRING_CODE, phone],
    );
    return "performed";
  });
}
