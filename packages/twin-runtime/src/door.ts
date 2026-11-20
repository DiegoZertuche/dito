/**
 * THE DASHBOARD'S DOOR, FROM THE REQUEST TO THE ROW (ticket #261; spec #258
 * decision 13, the bar's mechanism; ADR-0008, ADR-0010, ADR-0013 as amended).
 *
 * The rep types into the bar's composer and the lease holder writes what
 * they typed: sealed under the twin key, scoped to the seat the request
 * authenticated as, under the login session it was typed in. That row is the
 * whole of the ask — the answer is the consumer's next pass, and this returns
 * as soon as the words are durable.
 *
 * ═══ THE RUNTIME SEALS AND REP-WEB NEVER HOLDS A KEY
 *
 * ADR-0008's custody of two puts the twin DEK in the lease holder alone, so
 * the dashboard cannot write this row itself even if it were granted one — it
 * would have nothing to seal with. That is why the door is an API call rather
 * than an INSERT from the app, and it is the same reason the feed is a read
 * here rather than a query over there.
 *
 * ═══ A FOURTH FENCE, AND IT IS THE ONE A MESSAGE NEEDS
 *
 * `local-api.ts`' three fences say which process asked, which seat it asked
 * for, and that the seat's twin is this runtime's. A dashboard ACT needs
 * nothing more, because the act names a post of this twin's and the post is
 * the fence. A MESSAGE names nothing at all, so the thing that ties these
 * words to a person is the LOGIN SESSION rep-web authenticated: checked here
 * to be that seat's and still open, so words cannot be recorded under a
 * session that was closed by «Cerrar sesiones» or under another rep's.
 *
 * ═══ WHAT IT REFUSES, AND IN THE API'S OWN WORDS
 *
 * An empty message, one past the cap, a session that is not this seat's
 * open one, a reference to a line no card of this twin printed, one to a
 * line whose correction window has shut, and one to a blank no waiting draft
 * of this twin leaves (ticket #342). Each is `bad_request` — a parameter this
 * ask cannot take — rather than a sentence, because the refusal words are a
 * closed set a machine reads and a composed sentence here would be the one
 * place a caller past the bearer could map the store (`TWIN_API_REFUSALS`).
 */
import type { Dek } from "@dito/crypto";
import {
  isOwnId,
  TWIN_API_MESSAGE_MAX_CHARS,
  type TwinApiBlankAbout,
  type TwinApiLineAbout,
  type TwinApiMessageAbout,
} from "@dito/seam";
import type pg from "pg";
import { resolveDisclosureLineOfPost } from "./disclosure.js";
import { readDraftCard } from "./drafts.js";
import { correctionWindowClose } from "./feed.js";
import { noticeOfCard } from "./twin-posts.js";

/** Why a door message was not written — or that it was, with its id. */
export type DoorMessageOutcome =
  | { readonly ok: true; readonly messageId: string }
  | { readonly ok: false; readonly reason: DoorRefusal };

/**
 * The ways the door refuses, as words.
 *
 * NAMED HERE AND FLATTENED TO ONE `bad_request` AT THE WIRE, which is the same
 * division `performDashboardAct` keeps: the runtime says what happened for its
 * own callers and its own tests, and the API says the one word a caller is
 * owed.
 */
export type DoorRefusal =
  | "empty"
  | "too_long"
  | "unknown_session"
  | "unknown_line"
  | "window_closed"
  | "unknown_blank";

/** What writing one door message needs. */
export interface DoorDeps {
  readonly db: pg.ClientBase;
  readonly dek: Dek;
  readonly twinId: string;
}

/** Which rep the words are recorded for — off the registry, never the request. */
export interface DoorScope {
  readonly companyId: string;
  readonly seatId: string;
}

/**
 * Writes one dashboard message, or says why it did not.
 *
 * THE TEXT IS COUNTED IN CODE POINTS, not in UTF-16 units: `text.length` reads
 * an emoji as two and would refuse a message the rep counted as one character
 * shorter than the cap. The bar's composer caps its field at the same number
 * in the UTF-16 units `maxlength` counts, which is never fewer than the code
 * points counted here — so a message the field let through is never refused
 * for its length.
 *
 * IT IS NOT TRIMMED BEFORE IT IS SEALED. What the rep typed is what the twin
 * reads and what the store holds; the trim is for the EMPTINESS test alone,
 * because a composer that submitted a space is a rep who pressed enter by
 * accident.
 */
export async function writeDoorMessage(
  deps: DoorDeps,
  scope: DoorScope,
  request: {
    readonly text: string;
    readonly sessionId: string;
    readonly about?: TwinApiMessageAbout;
    /** The request's own instant, which a reference's window is read against. */
    readonly now: Date;
  },
): Promise<DoorMessageOutcome> {
  if (request.text.trim() === "") return { ok: false, reason: "empty" };
  if ([...request.text].length > TWIN_API_MESSAGE_MAX_CHARS) {
    return { ok: false, reason: "too_long" };
  }
  // A uuid, checked before it reaches a query — `classifyApertureInput`'s own
  // reason: a caller passing junk must land as a refusal rather than as a
  // Postgres cast error.
  if (!isOwnId(request.sessionId)) {
    return { ok: false, reason: "unknown_session" };
  }
  // THE SESSION IS CHECKED BEFORE THE SEAL, so a request under a closed login
  // spends no key work — and, more to the point, so that the only path to a
  // row here has already proven whose words these are.
  const session = await deps.db.query(
    `SELECT 1 FROM sessions
      WHERE id = $1 AND seat_id = $2 AND company_id = $3
        AND ended_at IS NULL AND expires_at > now()`,
    [request.sessionId, scope.seatId, scope.companyId],
  );
  if (session.rows.length === 0) {
    return { ok: false, reason: "unknown_session" };
  }
  const about = request.about;
  if (about !== undefined) {
    const target =
      about.kind === "line"
        ? await lineOfCard(deps, about, request.now)
        : await blankOfCard(deps, about);
    if (target !== "open") return { ok: false, reason: target };
  }
  const res = await deps.db.query<{ id: string }>(
    `INSERT INTO dashboard_messages
       (company_id, seat_id, twin_id, session_id, text_enc,
        about_post_id, about_line_index, about_blank_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      scope.companyId,
      scope.seatId,
      deps.twinId,
      request.sessionId,
      Buffer.from(deps.dek.encrypt(Buffer.from(request.text, "utf8"))),
      about?.postId ?? null,
      about?.kind === "line" ? about.lineIndex : null,
      about?.kind === "blank" ? about.key : null,
    ],
  );
  return { ok: true, messageId: res.rows[0]!.id };
}

/**
 * WHETHER THE CARD PRINTED THIS LINE, AND IT IS STILL OPEN (ticket #344): a
 * post of this twin whose record numbered it, by the same walk the retraction
 * makes — so a message can point only at a line the rep was shown — and inside
 * the window the card itself is drawn by (`correctionWindowClose`), so a page
 * left open past the close, or a form posted without script, cannot correct a
 * line the card would show read-only.
 */
async function lineOfCard(
  deps: DoorDeps,
  about: TwinApiLineAbout,
  now: Date,
): Promise<"open" | "unknown_line" | "window_closed"> {
  const noticeId = await noticeOfCard(deps, about.postId);
  if (noticeId === null) return "unknown_line";
  const line = await resolveDisclosureLineOfPost(
    { db: deps.db, twinId: deps.twinId },
    { noticeId, lineIndex: about.lineIndex },
  );
  if (line === undefined) return "unknown_line";
  const closes = await correctionWindowClose(deps, line.postId);
  return closes === undefined || now.getTime() < closes.getTime() ? "open" : "window_closed";
}

/**
 * WHETHER THE CARD IS A DRAFT OF THIS TWIN THAT STILL WAITS AND LEFT THIS
 * BLANK (ticket #342) — so an answer can point only at a blank the rep was
 * shown and can still fill: a draft sent, discarded or already filled has no
 * blank left to answer.
 */
async function blankOfCard(
  deps: DoorDeps,
  about: TwinApiBlankAbout,
): Promise<"open" | "unknown_blank"> {
  const card = await readDraftCard(deps, { postId: about.postId });
  return card?.state === "waiting" && (card.part.blanks ?? []).some((blank) => blank.key === about.key)
    ? "open"
    : "unknown_blank";
}
