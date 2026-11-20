/**
 * @dito/seam — contracts for the Postgres seam (ADR-0005): the spine between
 * the Go connection plane and the TS twin-runtime.
 *
 * Inbound: `wa_events` rows — plaintext metadata envelope + DEK-encrypted
 * payload, deduped on (source, external event id).
 * Outbound: `send_commands` rows consumed by the plane's executor, the sole
 * caller of the rail's send APIs (ADR-0006).
 *
 * The schema itself lives in `db/migrations/` (Atlas, ADR-0029); this module
 * carries the shared TypeScript contracts for rows crossing the seam.
 */

export { isOwnId } from "./ids.js";

/*
 * `./invitations.js` IS DELIBERATELY NOT RE-EXPORTED HERE (ticket #223), and
 * the reason is a build warning that #221 designed against: Next compiles
 * `instrumentation.ts` for the EDGE runtime as well as for Node, rep-web's
 * `rep-environment.ts` reaches this index for `isLoopbackHost`, and a
 * `node:crypto` import anywhere in this module's graph therefore lands in a
 * bundle that will never run and cannot support it. The invitation's minting
 * and digesting are the only values in this package that need that module, so
 * they are reached at `@dito/seam/invitations` by the two processes that
 * actually mint and consume a token — the operator's script and the login
 * path. Everything in THIS file stays a type, a constant or a statement.
 */

export { loadWrappedDek, storeWrappedDek } from "./twin-keys.js";

export {
  decodeWaMessagePayload,
  decodeWaOpaquePayload,
  decodeWaReactionPayload,
  opaquePlaceholder,
  opaqueRowStandsFor,
  OPAQUE_REASONS,
  WaPayloadError,
  type OpaqueReason,
  type WaMessagePayload,
  type WaOpaquePayload,
  type WaReactionPayload,
} from "./wa-payload.js";

/** The two send classes (ADR-0006). */
export const SEND_CLASSES = ["customer_send", "system_send"] as const;
export type SendClass = (typeof SEND_CLASSES)[number];

/**
 * Send outcomes (ADR-0006): sent(acked) / failed / unknown→held — never
 * silent, never auto-retried; a retry is a new tap. Null in the row means
 * not yet executed.
 */
export const SEND_OUTCOMES = ["sent", "failed", "held"] as const;
export type SendOutcome = (typeof SEND_OUTCOMES)[number];

/**
 * FR-63'S THREE SEAT STATES (ticket #221; spec #214 *Link day, in detail*).
 *
 * `invited` is a seat whose invitation is out and whose number is not linked;
 * `linked` is a rep whose WhatsApp the plane holds a session for; `retired`
 * is a seat whose twin has been erased (ADR-0009) and which persists for
 * attribution, because a fact filed two years ago must still name the seat
 * that filed it (ADR-0004 as amended).
 *
 * IT LIVES BESIDE `SEND_CLASSES` because it is the same kind of thing: a
 * closed vocabulary of a shared-Postgres row that BOTH SIDES read. rep-web
 * refuses a session for a retired seat, `seats_state_check` holds the same
 * three words, and `migration-vocabulary.test.ts` compares the two — so a
 * state the code writes that the store refuses is a red build rather than a
 * constraint violation in front of a rep who cannot log in.
 *
 * `active` IS NOT HERE. …20260902100010 could write exactly one state and
 * chose that word, on the argument that ADR-0027's other three had no
 * executor; #221's migration renames every such row to `linked`, which is
 * what the word meant on a rig whose number was linked. It is a value taken
 * OUT of a closed set, so `NARROWED_ONCE` in the vocabulary sweep is where
 * that removal is argued and bounded.
 */
export const SEAT_STATES = ["invited", "linked", "retired"] as const;
export type SeatState = (typeof SEAT_STATES)[number];

/** The state a seat is issued in, and the only one an invitation may open. */
export const SEAT_INVITED: SeatState = "invited";
/** The state a seat reaches when its number is linked (ADR-0032). */
export const SEAT_LINKED: SeatState = "linked";
/** ...and the one that outlives the twin, which no session may serve. */
export const SEAT_RETIRED: SeatState = "retired";

/**
 * THE RAIL'S FIVE STATES, as the plane emits them (…20260827100007,
 * …20260908100050; `plane/railstatus`).
 *
 * IT IS HERE BECAUSE A SURFACE NOW RENDERS PER STATE (ticket #221). Conexiones
 * draws a coral card for `dropped` and for `logged_out`, a quiet line for
 * `linked`, and the waiting state for `qr` — so a status the store can hold
 * that the page does not know is a page with no state at all, rendered as a
 * blank.
 *
 * `pairing_code` IS THE OTHER LINK CREDENTIAL (ticket #222; spec #214
 * *Schema changes*; ADR-0031, which names the ~160-second window). A phone
 * cannot scan a QR on its own screen, so link day on a phone is eight
 * characters the rep types into WhatsApp, and the plane writes them exactly
 * as it writes a QR payload: a row whose `detail` is a live credential the
 * plane itself generated. Nothing but the plane may read that column, which
 * is why rep-web's grant is four columns and not the table.
 *
 * THE STORE'S OWN CHECK IS SWEPT AGAINST IT (ticket #222).
 * `migration-vocabulary.test.ts` compares this constant with the constraint
 * …20260908100050 names — a name is what its parser needs, since it looks for
 * `CONSTRAINT <name> CHECK (… IN (…))` and an inline constraint has none. The
 * third copy of the vocabulary is the Go emitter in `plane/railstatus`, which
 * its own test compares against the same SQL.
 */
export const RAIL_STATUSES = [
  "qr",
  "linked",
  "dropped",
  "logged_out",
  "pairing_code",
] as const;
export type RailStatus = (typeof RAIL_STATUSES)[number];

/**
 * THE TWO STATES THAT CARRY A LIVE CREDENTIAL — and what a LINK SESSION is
 * (ticket #241; ADR-0031).
 *
 * ONE SET, THREE READERS. `readLinkSession` finds where a session starts with
 * it, the runtime's link read picks that session's two credentials out with
 * it, and rep-web's page state asks whether a row is a credential at all — so
 * a third door into a link session is a word added here rather than three
 * predicates that drift apart.
 *
 * ═══ A SESSION'S WINDOW BELONGS TO THE PLANE AND NOT TO A ROW
 *
 * This is the one home for that argument; everything else about a link
 * session points here. One session opens both doors and re-issues its QR
 * every twenty seconds, so all of those rows sit inside ONE ~160-second
 * window whose clock started at the FIRST of them: the login socket closes
 * when the QRs run out, and a pairing code generated into that session dies
 * with it (`plane/pairing` quotes the library on both). A reader anchored on
 * the newest row measures a window that moves with every refresh, which is a
 * countdown that never counts.
 */
export const RAIL_CREDENTIAL_STATUSES = ["qr", "pairing_code"] as const;
export type RailCredentialStatus = (typeof RAIL_CREDENTIAL_STATUSES)[number];

/**
 * ONE SNAPSHOT FOR A READING THAT TAKES SEVERAL STATEMENTS (ticket #241, Codex
 * r2).
 *
 * The link page's state is four questions — where the session starts, what the
 * rail last did, which credentials that session has served, whether an ask is
 * still on its way — and under READ COMMITTED each answer comes from its own
 * instant. The plane writes between them. A new session opening and its ask
 * settling between the first statement and the last hands the page FRESH
 * CREDENTIALS ON THE OLD SESSION'S ANCHOR with nothing pending, which the
 * page's arithmetic reads as «se venció» — and that screen carries no refresh,
 * so the code the rep just asked for sits unread on the rail while they look
 * at a dead window.
 *
 * REPEATABLE READ, READ ONLY: one instant for every statement inside, and
 * nothing inside may write. It is the cheapest thing that makes several
 * answers ONE READING, and it is what lets the questions stay separate
 * statements — the alternative is one clever statement per surface, and then
 * the seam's shared statements stop being shared.
 *
 * NO NESTING, which is `withDbTransaction`'s rule one package over: a caller
 * already inside a transaction must not open this one.
 */
export async function withReadSnapshot<T>(
  db: { query: (sql: string) => Promise<unknown> },
  fn: () => Promise<T>,
): Promise<T> {
  await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY");
  try {
    const result = await fn();
    await db.query("COMMIT");
    return result;
  } catch (err) {
    await db.query("ROLLBACK");
    throw err;
  }
}

/* ------------------------------------------------------------------ */
/* The chat directory and the plane's request seam (ticket #222).      */
/* ------------------------------------------------------------------ */

/**
 * WHAT THE RAIL'S ADDRESS SPACE DIVIDES INTO (ticket #222; spec #214
 * decision 7; `chat_directory.kind`).
 *
 * Four words, and they are the plane's reading of an ADDRESS rather than a
 * product taxonomy — the plane judges nothing beyond what the rail hands it
 * (ADR-0005):
 *
 *   `self`  — the rep's own thread, whose scope is structural rather than an
 *             allowlist row (ADR-0023). The one chat whose identity is
 *             structural rather than personal.
 *   `dm`    — one counterparty, addressed by phone number or by LID.
 *   `group` — a group thread.
 *   `other` — anything else the rail addresses: a broadcast or status list,
 *             WhatsApp's own system account (boundary #225, F32), whatever
 *             WhatsApp adds tomorrow. It exists so a fifth address server is
 *             a row the directory can hold rather than a conversation it
 *             silently forgets, which is the failure the directory exists to
 *             end.
 *
 * The scoping page renders per kind (a group is not a cliente), so a kind the
 * store can hold that the page does not know is a row rendered as a blank —
 * the argument `RAIL_STATUSES` makes one section up.
 */
export const CHAT_KINDS = ["self", "dm", "group", "other"] as const;
export type ChatKind = (typeof CHAT_KINDS)[number];

/**
 * WHAT A SEAT CAN BE SHOWN, AND THEREFORE WHAT A MARK IS ABOUT (ticket #262;
 * `seen_marks.subject_kind`).
 *
 * `post` — a card Inicio rendered to a logged-in session. Its reference is the
 *   post's own id.
 * `fill_stop` — the report that a chat's fill ended, which is one card about
 *   every marked chat. Its reference is the newest stop the card reports,
 *   rendered as text, so a LATER fill is a different subject and the card
 *   comes back.
 *
 * TWO, AND THE SET IS CLOSED BECAUSE THE STORE SAYS SO. A kind the code writes
 * that the store refuses is a constraint violation in front of a rep reading
 * their own feed, so the CHECK and this constant are one vocabulary
 * (`migration-vocabulary.test.ts`).
 */
export const SEEN_SUBJECT_KINDS = ["post", "fill_stop"] as const;
export type SeenSubjectKind = (typeof SEEN_SUBJECT_KINDS)[number];

/**
 * The three asks the PLANE serves (ticket #222; spec #214 decisions 7 and 8;
 * `plane_requests.kind`).
 *
 * THE MIRROR OF `runtime_requests` (…20260906100020), which is why it is a
 * second table and a second vocabulary: there the runtime is the server and
 * an operator the requester, here the runtime is the requester and the plane
 * the server. A scope act writes the allowlist row and the request row in one
 * transaction; the plane's poll picks the row up on its next tick.
 */
export const PLANE_REQUEST_KINDS = [
  "scope_in",
  "scope_out",
  "pairing_code",
] as const;
export type PlaneRequestKind = (typeof PLANE_REQUEST_KINDS)[number];

/** What became of one ask (`plane_requests.outcome`). */
export const PLANE_REQUEST_OUTCOMES = ["served", "refused", "failed"] as const;
export type PlaneRequestOutcome = (typeof PLANE_REQUEST_OUTCOMES)[number];

/**
 * HOW A CHAT'S LAST FILL ATTEMPT ENDED, as the DIRECTORY ROW records it, in
 * the three groups the dashboard renders (ticket #245 F17;
 * `chat_directory.fill_stopped_by`).
 *
 * THE WORD IS THE REQUEST'S OWN — `plane/planereq`'s `FillStops` derives the
 * whole set from `Stops` plus the reasons a scope-in can end with, and its own
 * test sweeps the store's CHECK against it. What is HERE is the reading the
 * card needs and the plane does not: an attempt that ended is not the same
 * thing as history that arrived, so a card that treated every stop as
 * completion would tell a rep whose fill the plane failed that their ninety
 * days are in.
 *
 * `FILL_STOPS_COMPLETE` — everything the phone has for that chat inside the
 * window is on the seam: the window was reached, the chat was exhausted, or the
 * page came back with nothing in it.
 *
 * `FILL_STOPS_NO_HISTORY` — nothing was ever fetchable, so the twin's record of
 * that chat starts now: a group and any chat whose LID nobody knows (the phone
 * answers no history request without one), and a chat the plane holds no anchor
 * for — whether the row said so (`no_anchor`) or the plane had never seen the
 * chat at all when it was asked (`no_directory_row`).
 *
 * `FILL_STOPS_PARTIAL` — the attempt ended with more of that chat still on the
 * phone. Re-marking the chat starts another attempt, which is what the card
 * tells the rep they can do. `anchor_repeated` is one of these rather than a
 * completion (Codex r2): it is the fill refusing to loop over a page the phone
 * answered twice, and the phone can say MORE_MESSAGES_REMAIN_ON_PRIMARY in the
 * very same answer — so history is left, and the rep may ask for it again.
 *
 * AND THE PARTIAL GROUP IS THE READ'S CATCH-ALL RATHER THAN A PREDICATE, which
 * is why it is listed here and matched nowhere: `fill.ts` takes «not a
 * completion and not a no-history» as pending, so the five counts partition the
 * marked chats BY CONSTRUCTION. Enumerating instead left `descoped` in no count
 * at all, and a chat in `scoped` and nothing else is exactly what makes the
 * card claim the ninety days over a chat whose history never arrived. It also
 * errs the safe way: a word nobody here has classified reads as «more is
 * pending», never as «your ninety days are in».
 *
 * `descoped` NAMES A CHAT THE REP SWITCHED OFF, so it has left the allowlist
 * this read is driven from and reaches no count in practice — but it is in the
 * list, because «in practice» is not a thing a card's truth should rest on.
 */
export const FILL_STOPS_COMPLETE = [
  "ninety_day_line",
  "no_more_on_primary",
  "empty_page",
] as const;

export const FILL_STOPS_NO_HISTORY = [
  "no_lid",
  "no_anchor",
  "no_directory_row",
] as const;

export const FILL_STOPS_PARTIAL = [
  "no_access",
  "anchor_repeated",
  "wait_timeout",
  "rail_not_linked",
  "no_history_window",
  "pass_failed",
  "interrupted",
  "descoped",
] as const;

/**
 * The whole set the store accepts, which is the three groups and nothing
 * beside them: every word the plane can stamp has a reading, so no marker can
 * leave a chat in `scoped` and in no count of its own.
 * `migration-vocabulary.test.ts` sweeps
 * `chat_directory_fill_stopped_by_check` against it, and `planereq_test.go`
 * sweeps the same CHECK against the Go constants that WRITE the words: the two
 * pins are what keep the plane's vocabulary and the card's reading of it one
 * set rather than two.
 */
export const FILL_STOPS = [
  ...FILL_STOPS_COMPLETE,
  ...FILL_STOPS_NO_HISTORY,
  ...FILL_STOPS_PARTIAL,
] as const;
export type FillStop = (typeof FILL_STOPS)[number];

/**
 * Why an ask was not served, as a closed word and never a sentence
 * (`plane_requests.reason`).
 *
 * REFUSED BY NAME, NEVER SENT. A chat with no directory row, no anchor or no
 * known LID cannot be asked about at all — the phone answers only a request
 * addressed by the chat's LID from a message it can find (#216's readings of
 * 2026-09-07) — so the plane says which of the three it was missing instead of
 * putting a request on the socket that can only come back empty.
 */
export const PLANE_REQUEST_REASONS = [
  /** The plane has never seen this chat, so it holds no anchor for it. */
  "no_directory_row",
  /** The row exists and names no message the phone could page back from. */
  "no_anchor",
  /** Neither the directory nor the library's own map knows the chat's LID. */
  "no_lid",
  /** The twin has no `history_windows` row, and the line is never guessed. */
  "no_history_window",
  /** No live session identity: the rail is down, so nothing can be asked. */
  "rail_not_linked",
  /** A pairing-code ask on a plane that already holds a session. */
  "already_linked",
  /** A parameter the plane cannot read. */
  "malformed_parameter",
  /** The plane tried and failed; the loop carries on. */
  "pass_failed",
  /** The plane went away mid-serve; the next start settles the row. */
  "interrupted",
] as const;
export type PlaneRequestReason = (typeof PLANE_REQUEST_REASONS)[number];

/**
 * How a SERVED fill ended (`plane_requests.stopped_by`), which is a different
 * question from why an unserved ask failed.
 *
 * The first three are spec #214 decision 7's own stop rules; the last two are
 * what a phone that stops cooperating leaves behind. Every one of them ends
 * the sitting with the progress that landed standing on the directory row.
 */
export const PLANE_REQUEST_STOPS = [
  /** A page reached past the twin's history window. */
  "ninety_day_line",
  /** The phone answered with a page carrying no messages. */
  "empty_page",
  /** The phone's own `COMPLETE_AND_NO_MORE_MESSAGE_REMAIN_ON_PRIMARY`. */
  "no_more_on_primary",
  /**
   * The phone says more remains on the primary and this companion may not
   * have it (`endOfHistoryTransferType` value 3). A stop rather than a
   * refusal: history exists, so «no more remains» would be a lie on the
   * record, but asking again cannot change the answer — #216's research found
   * that this WhatsApp Business build offers no such grant on its
   * Linked-devices screen at all — so paging on would spend a request and a
   * notification on the rep's phone per page for nothing.
   */
  "no_access",
  /** The phone stopped answering inside the pager's bound. */
  "wait_timeout",
  /** The phone returned a page the fill had already asked from. */
  "anchor_repeated",
  /**
   * The rep switched the chat off while the sitting was running (ticket #222).
   *
   * Reachable because the plane serves requests ONE AT A TIME: a scope-out
   * written seconds after a scope-in is queued behind the fill it would stop,
   * so without this the fill pages the whole window for a chat the rep has
   * just unmarked — every page dropped at the socket, a notification on their
   * own phone per page, and a directory row left claiming a fill that landed
   * nothing.
   */
  "descoped",
] as const;
export type PlaneRequestStop = (typeof PLANE_REQUEST_STOPS)[number];

/* ------------------------------------------------------------------ */
/* The twin runtime's local API (ticket #221; ADR-0010).              */
/* ------------------------------------------------------------------ */

/**
 * THE WIRE, PINNED IN ONE PLACE (ticket #221; spec #214 *The runtime's local
 * API, in detail*; ADR-0010).
 *
 * Everything sealed or bundle-resident is served by an authenticated HTTP API
 * on the lease holder, and rep-web is its client — so the contract between the
 * two is a WIRE and not a shared type. What is pinned here is the part both
 * sides must spell identically: the paths, the two headers, the query
 * parameters, the closed set of refusal words, and — now that a card is
 * rendered (#224) — the SHAPE of what comes back (`TwinFeedPage`, which argues why it is its
 * own type rather than the read model's).
 *
 * THE PATHS ARE A RECORD SO A READ IS A REGISTRATION, and #223 took that door
 * twice: the chat directory with its names opened, and the rail row with its
 * credential on it. One more entry here and one more handler there, with
 * nothing about the server's shape rewritten.
 *
 * THE ACTS ARE THE SAME RECORD, and they are POSTs. #224's four dashboard acts
 * — discard a draft, retract a line, confirm or decline a binding — #223's two
 * scope switches and #264's notebook edit are executions on the lease holder
 * rather than reads, because `posts`, `disclosure_lines`, `scope_allowlist`
 * and the bundle are the runtime's alone (ADR-0010). A read's path answers
 * `no_route` to a POST and an act's path answers `no_route` to a GET, so the
 * method is part of the registration rather than a second kind of refusal.
 *
 * AND THERE IS A THIRD MAP, for the one POST that is not an act:
 * `TWIN_API_ASK_ROUTES` argues why the link ask cannot ride in the second one.
 * AND A FOURTH, for the one GET that is not a read: `TWIN_API_STREAM_ROUTES`
 * argues why the seat's event stream cannot ride in the first.
 */
export const TWIN_API_ROUTES = {
  /** The latest `rail_status_events` row for this runtime's twin. */
  rail: "/rail",
  /** #220's read model: posts with their parts opened, cursor-paged. */
  feed: "/feed",
  /**
   * The same row as `/rail`, WITH the credential on it (ticket #223).
   *
   * THE ONE DOOR TO THE TWO CREDENTIALS, and it is a second read rather than a
   * field on the first because the two reads answer different questions.
   * `/rail` is «is the twin there, and what does it say about the socket», and
   * Conexiones asks it on every visit; this one is «hand me the QR payload or
   * the eight characters», and only the link page asks it. `dito_rep_web` holds
   * no column privilege on `rail_status_events.detail` at all and must not
   * (`grants.ts` argues the link-hijack), so the credential cannot come off the
   * store — it comes from the lease holder, on this path, and nowhere else.
   */
  link: "/link",
  /**
   * The chat directory with its names OPENED (ticket #223; spec #214 decision
   * 7).
   *
   * `chat_directory.name_enc` is sealed under the twin DEK and rep-web holds no
   * key (ADR-0008), so the scoping page's list is the lease holder's to serve.
   * What crosses is the row's OWN ID and never the chat's JID: the directory row
   * is the handle a switch names, so no page and no form ever carries a phone
   * number (ADR-0004).
   */
  directory: "/directory",
  /**
   * THE BAR'S HISTORY: THE REP'S OWN EXCHANGES AT THE DASHBOARD'S DOOR, PAGED
   * BACK BY DAY (tickets #261 and #263; spec #258 decisions 4 and 13).
   *
   * What the rep typed into the bar paired with the twin's replies to them,
   * a page of seat-local days at a time, oldest first within the page
   * (`TwinExchanges`). Both halves are sealed under the twin DEK, so the
   * pairing is the lease holder's like the feed's (ADR-0008, ADR-0010).
   *
   * A SECOND READ RATHER THAN A SHAPE ON THE FEED, because the two answer
   * different questions. The feed is the twin's posts newest first, paged by
   * post; this is one door's conversation, paged by DAY, and half of every
   * pair is a row the feed has never carried.
   */
  exchanges: "/exchanges",
  /**
   * THE REP NOTEPAD AS IT STANDS, for *Mi libreta* (ticket #264; ADR-0033 as
   * amended 2026-09-25).
   *
   * The notebook is a table in the per-twin bundle and rep-web holds no key,
   * so the lease holder is the only process that can read it (ADR-0008,
   * ADR-0010). What crosses is the current version's text and the instant it
   * was written (`TwinNotepad`) — never the earlier versions, which stay in
   * the bundle as the recoverability the append-only shape exists for.
   */
  notepad: "/notepad",
  /**
   * THE TWIN'S OPEN MATTERS, for the bar's «¿Dónde quedamos?» (tickets #322,
   * #335; spec #318 decision 32).
   *
   * A READ OF ITS OWN RATHER THAN A FIELD ON THE CANVAS, because the bar is
   * on every dashboard page and the canvas read is Inicio's: the matters on
   * Rutinas would otherwise cost a canvas read it does not draw. The matters
   * live in the per-twin bundle, so the lease holder is the only process that
   * can read them (ADR-0008, ADR-0010); what crosses is each matter's label
   * and the id of what it is about (`TwinOpenMatters`), never the prose.
   */
  openMatters: "/open-matters",
  /**
   * THE OFFERS THE REP SPENT TODAY (ticket #335): every lean-in offer the rep
   * took, answered or let go since the seat-local day began, so the bar never
   * raises one of them again on this device or another (`TwinOfferSpendings`).
   *
   * A READ OF ITS OWN, because the bar is on every dashboard page and reads it
   * when it opens, as it reads the open matters. The sentence is sealed under
   * the twin DEK, so the lease holder is the only process that can answer.
   */
  offerSpendings: "/offer-spendings",
  /**
   * THE CANVAS: WHAT WAITS ON THE REP, AND THE TWIN'S LAST WORD ABOUT IT
   * (ticket #266; spec #258 decisions 12 and 15; ADR-0044 as amended).
   *
   * The drafts nobody has sent or discarded, the binding questions still
   * open, the day's notes while a line can still be retracted — opened, oldest
   * first — beside the seat's last arrival line with its curation and two
   * typed facts about what waits (`TwinCanvas`).
   *
   * A READ OF ITS OWN RATHER THAN A FILTER ON THE FEED, because «what waits»
   * is a question about the store (a tap, a dismissal, a binding, a window)
   * and the feed is a page of posts newest first: a draft behind twenty
   * receipts would be off the feed's first page and still waiting.
   */
  canvas: "/canvas",
  /**
   * RUTINAS: WHAT FIRES ON ITS OWN, AND WHEN EACH LAST FIRED (tickets #267,
   * #364; spec #258 decision 16; CONTEXT.md *Rutinas*).
   *
   * One card per `automations` row of the seat — Dito's own and the rutinas
   * the twin authored — with its wake as typed facts, its switch and its last
   * firing (`TwinRoutines`). The rows are the seam's and a rutina's content is
   * the bundle's, so the read comes from the lease holder: one read, one
   * fence.
   */
  routines: "/routines",
  /**
   * THE ACTS LOG, ONE SEAT-LOCAL DAY AT A TIME (ticket #267; spec #258
   * decision 16; CONTEXT.md *Acts log*).
   *
   * Every settled act of that day — sent, dismissed, confirmed, declined,
   * retracted, reminded, the day's disclosure — with its instant and its
   * subject (`TwinActsLog`). `back` says which day, counted back from today and
   * clamped to the seven the dashboard keeps (`TWIN_API_ACTS_LOG_DAYS`).
   *
   * THE LEASE HOLDER'S, because a subject's name is inside a sealed post or
   * the bundle's entity mirror, and rep-web holds no key (ADR-0008).
   */
  actsLog: "/acts-log",
  /**
   * TRABAJOS EN CURSO'S RUNS (ticket #323; spec #318 decisions 22 and 25;
   * ADR-0044's `run` part).
   *
   * Every workflow run of the twin's that is still going, and every one that
   * ended in the days the dashboard keeps (`TWIN_API_RUNS_DAYS`): its name,
   * its state word, one detail, its steps and its flags (`TwinRuns`). The
   * lease holder's, because an inline run's name is inside its sealed content
   * and rep-web holds no key (ADR-0008).
   */
  runs: "/runs",
  /**
   * ONE WORKSPACE DOCUMENT'S VERSION, BY ITS ID (ticket #326; spec #318
   * decision 34 — a `document` part «opens from the card through the
   * runtime»).
   *
   * `GET /documents/<id>`: the version's title and text out of the twin's
   * bundle, read-only, for the seat's own twin (`TwinDocument`). The lease
   * holder's, because the text is sealed in the bundle and rep-web holds no
   * key (ADR-0008); a card names the version's id and nothing else.
   */
  document: "/documents/",
  /**
   * EVERY WORKSPACE DOCUMENT OF THE TWIN'S (ticket #368; ruled 2026-10-08):
   * `GET /documents`, the same collection with no id — each document's latest
   * version by its id, title, number and date, newest first (`TwinDocuments`),
   * for Mi libreta, whether or not a card for it is on the canvas. Never a
   * path and never the text: a document opens by its id, as a card opens it.
   */
  documents: "/documents",
} as const;

export type TwinApiRoute = keyof typeof TWIN_API_ROUTES;

/**
 * The canvas read's one optional parameter: a post the page must render
 * whatever its state (ticket #266).
 *
 * IT IS HOW AN ACT WITHOUT SCRIPT COMES BACK TO ITS CARD. The form posts, the
 * act lands, and the page that follows names the card the act was on; that
 * card has stopped waiting, so the canvas would drop it and the rep would never
 * read the state word the act left. The runtime answers it only when the post
 * is this twin's and is a card the canvas draws (`TwinCanvas.kept`).
 */
export const TWIN_API_KEEP_PARAM = "keep";

/**
 * WHAT THE CANVAS READ ANSWERS (ticket #266; spec #258 decisions 12 and 15).
 *
 * `waiting` IS OLDEST FIRST, which is the order the canvas falls back to when
 * the twin has curated nothing (decision 15: «in the twin's last order or by
 * age»). `arrival` is the seat's last line — the arrival line or one the twin
 * said unasked (ticket #320) — absent while none has landed. `curation` is the
 * twin thread's current spotlight and order (ticket #320). `facts` is two
 * typed facts about what waits: how many, and who the first is about.
 */
export interface TwinCanvas {
  readonly waiting: readonly TwinFeedPost[];
  /**
   * THE LAST HOUR'S CUSTOMER SENDS AND WHAT BECAME OF EACH, by the card's post
   * (Codex r3): the outcome a page mid-settle waits for, carried on the read
   * too, so a `settle` it missed — its stream down, or the runtime gone
   * between a commit and its publish — still lands on the next read.
   */
  readonly sends: readonly TwinSendOutcome[];
  /** The post `keep` named, when it is this twin's and has stopped waiting. */
  readonly kept?: TwinFeedPost;
  readonly arrival?: TwinArrival;
  readonly curation?: TwinCuration;
  /** The card the twin holds up now (ticket #401), absent while none is. */
  readonly spotlight?: TwinSpotlight;
  readonly facts: TwinArrivalFacts;
}

/**
 * THE SPOTLIGHT (ticket #401; ruled by Diego 2026-10-13): the one card the twin
 * holds up for the rep — lifted, the others stepping back, the twin's mark beside it
 * unless the rep sent it home — and when it began. It lasts until the twin
 * spotlights another card or none, or the card leaves the dashboard; the rep
 * moving the twin's mark never ends it. Never first place, which is the curation's
 * top card.
 */
export interface TwinSpotlight {
  readonly postId: string;
  /** When it began, an ISO instant: what a page's «sent home» is kept against. */
  readonly since: string;
}

/** One recent customer send: its card, and the settle word its outcome is. */
export interface TwinSendOutcome {
  readonly postId: string;
  readonly outcome: "sent" | "queued" | "failed" | "held";
}

/**
 * THE TWIN'S LAST LINE ON INICIO (ticket #266; ADR-0044 as amended — the
 * arrival post; ticket #320 — the same kind for a line nobody asked for).
 *
 * `day` IS THE SEAT-LOCAL CALENDAR DAY THE ARRIVAL WAS CUT IN, `YYYY-MM-DD`,
 * by the runtime in the one zone every day is cut in — so a reader that
 * names a day's heading (Trabajos en curso, #267) never converts an instant
 * with a zone of its own.
 */
export interface TwinArrival {
  /** The arrival post's own id. */
  readonly postId: string;
  /**
   * The arrival it is the line for — what the stream's `curated` event
   * names, so a page that missed `curated` recognises its line in a read.
   * Absent on a line a turn the seam's events woke said unasked.
   */
  readonly arrivalId?: string;
  readonly at: string;
  readonly day: string;
  /** The composed line, a customer's reference where the twin named one. */
  readonly line: string;
  /** The customers the line names, rendered and linked like an answer's (ticket #321). */
  readonly mentions?: readonly TwinFeedMention[];
}

/**
 * The curation as a surface renders it: which post is the spotlight and the
 * order of the rest, by post id, spotlight first.
 *
 * A POST IT NAMES MAY HAVE SETTLED SINCE, and the canvas skips it: the
 * curation is what the twin decided when it wrote it, and the canvas draws
 * only what still waits.
 */
export interface TwinCuration {
  /**
   * Which version of the curation this is, rising with every write — so a page
   * holding a newer one never takes an older one from a read that left before
   * it (ticket #320).
   */
  readonly version: number;
  /**
   * THE CARD AT THE TOP, the twin's `move_cards` (ticket #401); absent when
   * nothing waited. The name is the stored column's, kept; it is never the
   * spotlight (`TwinSpotlight`).
   */
  readonly spotlight?: string;
  /** Every post the twin placed, the top one first. */
  readonly order: readonly string[];
  /**
   * THE TWIN'S LEAN-IN OFFERS, one sentence per card it chose to offer
   * something on (ticket #322; spec #318 decision 32; #279's ruling): the page
   * raises a card's sentence as the pill's line after the rep rests on that
   * card (#337).
   * Absent when the curation carries none.
   */
  readonly offers?: readonly TwinOffer[];
  /**
   * THE CARDS THE TWIN TOOK OFF THE CANVAS FOR THE REP (ticket #368; ruled
   * 2026-10-08): they still wait — a draft still sends from its receipt or the
   * bell — and Inicio draws them neither in its body nor in «Todo lo que
   * espera» until a later curation places them again. Absent when it took none.
   */
  readonly left?: readonly string[];
}

/**
 * ONE LEAN-IN OFFER (ticket #322): the card it is about and the twin's own
 * sentence — one line under a knock's bound, no link and no figure the card
 * lacks, fenced by the runtime where the spotlight writes it.
 */
export interface TwinOffer {
  readonly postId: string;
  /**
   * The twin's words as it wrote them: a customer as their reference and the
   * words that mean a card marked with it (`referenceInProse`, `markInProse`),
   * drawn as every line of the twin's is (ticket #404).
   */
  readonly sentence: string;
  /** The customers the sentence names by reference; absent when it names none. */
  readonly mentions?: readonly TwinFeedMention[];
}

/**
 * WHAT ONE OPEN MATTER IS ABOUT, on the wire (ticket #322): an entity — a
 * customer — or a post — a card — by the id its store minted.
 */
export interface TwinOpenMatterSubject {
  readonly kind: "entity" | "post";
  readonly id: string;
}

/**
 * ONE OPEN MATTER, as the bar's carousel draws it (tickets #322, #335; spec
 * #318 decision 32): the twin's short label and what it is about.
 */
export interface TwinOpenMatter {
  readonly label: string;
  readonly about: TwinOpenMatterSubject;
  /**
   * WHO OR WHAT THE MATTER IS ABOUT, AS THE REP KNOWS THEM (ticket #322):
   * rendered by the runtime from `about` — the customer's confirmed name for an
   * entity, the card's customer for a post — never by the model (ADR-0037).
   * Absent when `about` resolves to nothing; the carousel then shows the
   * label alone.
   */
  readonly subject?: string;
  /**
   * THE CUSTOMER'S REFERENCE, as a card's `customer` carries it — `c7` — when
   * `about` resolves to one (ticket #335): what the bar matches a waiting
   * card against when the rep picks the matter.
   */
  readonly customer?: string;
}

/**
 * WHAT `/open-matters` ANSWERS, AND WHAT THE `noted` EVENT CARRIES (ticket
 * #322): the working memory's version and its open matters, in the twin's
 * order. `version` is 0 while the twin has written nothing, and rises with
 * every write, so a page holding a newer list never takes an older one.
 */
export interface TwinOpenMatters {
  readonly version: number;
  readonly matters: readonly TwinOpenMatter[];
}

/**
 * TWO TYPED FACTS ABOUT WHAT WAITS (ticket #266; spec #258 decision 15): the
 * count of what waits and the spotlight's counterparty — a count and a name,
 * never anybody's words.
 */
export interface TwinArrivalFacts {
  /** How many posts wait on the rep. */
  readonly waiting: number;
  /**
   * Who the spotlight is about — the twin's last curation's spotlight while
   * it still waits, else the oldest post that waits — when that post names
   * one.
   */
  readonly spotlight?: string;
}

/**
 * THE THIRD MAP: WHAT THE RUNTIME IS ASKED TO ASK FOR (ticket #223).
 *
 * A POST, like an act, and NOT an act — which is the whole reason it is a third
 * map rather than a sixth entry in the one below. Every route in
 * `TWIN_API_ACT_ROUTES` is a REP DECISION recorded as one: it writes a
 * `dashboard_acts` row, it names a verb from a closed set the store's own CHECK
 * holds, it goes through the rep-evidence gate, and it leaves an execution and
 * a chain entry. The link ask is none of those. It carries no target the rep
 * chose — the number is the runtime's own session identity — it records no
 * verb, and the `plane_requests` row IS the record (#78's rule: a chained act
 * is a rep act with evidence and an execution behind it, and asking for a code
 * is neither). Putting it in the acts map would force a word into
 * `DASHBOARD_ACT_VERBS` that no act row ever carries, which is exactly the «a
 * value in a closed set that nothing writes» failure the migration sweep exists
 * to refuse.
 *
 * THE LINK ASK ANSWERS IN THE ACTS' OWN WORDS all the same
 * (`TwinApiActResult`), because the three things that can happen to it are the
 * three that word set already names: the request row was written, one was
 * already live, or the ask was refused because the rail is linked already. The
 * message ask answers with the id of the row it wrote, which is its own shape
 * (`TwinApiMessageResult`) — an ask is not obliged to speak the acts' words,
 * only not to be an act.
 */
export const TWIN_API_ASK_ROUTES = {
  /** «Generar otro»: one `plane_requests` row of kind `pairing_code`. */
  link: "/ask/link",
  /**
   * THE DASHBOARD'S DOOR (ticket #261; spec #258 decision 2).
   *
   * The rep's words from the bar's composer, which the runtime seals under the
   * twin key and writes as a `dashboard_messages` row for its own consumer to
   * route. AN ASK AND NOT AN ACT, by the same three tests the link ask passes:
   * it performs nothing, it names no target the rep chose — a message is about
   * whatever it is about — and it records no verb, so putting it in the acts
   * map would force a word into `DASHBOARD_ACT_VERBS` that no `dashboard_acts`
   * row ever carries. What it leaves behind is the message row, and the
   * execution it eventually causes is the thread's, not this request's.
   */
  message: "/ask/message",
  /**
   * THE REP OPENED INICIO (ticket #266; spec #258 decision 15; ADR-0014 as
   * amended — the `arrival` occasion).
   *
   * The runtime records the arrival for the seat — metadata only: the seat,
   * the instant, whether it is the first of the seat-local day — and tells the
   * twin thread, whose turn composes the line and curates the canvas (ticket
   * #320). AN ASK AND NOT AN ACT, by the three tests the other two pass: it
   * performs nothing on the rep's record, it names no target, and it records
   * no verb. What it answers is what the page needs before any line lands
   * (`TwinApiArrivalResult`).
   */
  arrival: "/ask/arrival",
  /**
   * THE SEAT'S SEEN-STAMP MOVED (ticket #266; spec #258 decision 14).
   *
   * The stamp is rep-web's own write on Inicio's read (`stampSeen`); this is
   * how the rest of the dashboard hears it. It PERFORMS NOTHING ON ANY STORE:
   * the runtime publishes the ids to the seat's own stream and answers, which
   * is why it is an ask — the one route whose whole effect is an event.
   */
  seen: "/ask/seen",
  /**
   * THE REP SPENT AN OFFER (ticket #335): took it, answered it, or let it go
   * with «Luego». The runtime keeps the mark for the seat-local day, so the
   * offer stays down after a reload and on another device.
   *
   * AN ASK AND NOT AN ACT, as the seen ask is: it is the page's own state
   * about a card the rep looked at — nothing on the rep's record moves, the
   * twin is told nothing, and no verb is recorded. What it leaves is the mark.
   */
  spend: "/ask/spend",
  /**
   * THE REP PICKED ONE OF THE TWIN'S OPEN MATTERS (ticket #335; the spine's
   * movement 5, «¿Dónde quedamos?»).
   *
   * AN ASK AND NOT AN ACT, and NOT A MESSAGE: nothing is written in the rep's
   * name. The runtime tells the twin thread which matter was picked — an
   * event, like a seen-stamp — and the thread's turn resumes it in the twin's
   * own words.
   */
  pick: "/ask/pick",
  /**
   * THE REP SELECTED A PHRASE IN ONE OF THE TWIN'S CARDS (ticket #341; the
   * spine's movement 7, «¿Y esto?»): they point at words and ask nothing.
   *
   * AN ASK AND NOT AN ACT, and NOT A MESSAGE, the pick's shape: nothing is
   * written in the rep's name. The runtime finds the phrase among the card's
   * own words and tells the twin thread, whose turn explains it in the twin's
   * own words.
   */
  select: "/ask/select",
  /**
   * THE REP SUMMONED THE ONE PRESENCE TO A CARD (ticket #340; the spine's
   * movement 6, «Ven conmigo»): they tapped the twin's mark in the pill and it
   * landed on the card they are on.
   *
   * AN ASK AND NOT AN ACT, and NOT A MESSAGE, the pick's shape: nothing is
   * written in the rep's name. The runtime tells the twin thread which card,
   * and the twin may speak on it with `say_on_card`.
   */
  summon: "/ask/summon",
} as const;

export type TwinApiAskRoute = keyof typeof TWIN_API_ASK_ROUTES;

/**
 * WHICH ASKS CARRY A BODY (ticket #261).
 *
 * ONE RECORD BOTH SIDES READ, the shape `DASHBOARD_ACT_TARGET_OF_ROUTE` has:
 * the server decides whether to read request bytes at all from this rather
 * than from a second list, and the type makes an ask added without an answer
 * here a compile error rather than a route whose body is silently dropped.
 *
 * THE LINK ASK IS `false` AND MUST STAY SO. «Generate a code for this
 * runtime's own number» has no parameters — the number is the plane's live
 * session identity — so a body there would be a slot for a caller to put
 * somebody else's number in (`askForPairingCode` argues it in full).
 */
export const TWIN_API_ASK_TAKES_BODY = {
  link: false,
  message: true,
  // THE ARRIVAL NAMES NOTHING: the seat is the header's and the instant is the
  // runtime's own, so a body would be a slot for a caller to put a time in.
  arrival: false,
  seen: true,
  spend: true,
  pick: true,
  select: true,
  summon: true,
} as const satisfies Readonly<Record<TwinApiAskRoute, boolean>>;

/**
 * WHAT THE ARRIVAL ASK ANSWERS (ticket #266; spec #258 decision 15).
 *
 * `woke` SAYS WHETHER THIS ASK RECORDED AN ARRIVAL. A return within ten minutes
 * of the seat's last one records nothing and wakes nothing, and the page keeps
 * the last line (`lastLineId`). `arrivalId` is the arrival whose line the page
 * follows on the stream (`curated`): the one this ask recorded, or —
 * throttled — the one the throttle kept, whose line may still be on its way
 * when a second tab opens seconds after the first (Codex r3).
 *
 * `facts` ARE TWO TYPED FACTS ABOUT WHAT WAITS, read without waiting on the
 * execution.
 */
export interface TwinApiArrivalResult {
  readonly woke: boolean;
  readonly arrivalId?: string;
  /** Whether it is the first visit of the seat-local day — the welcome — or a return. */
  readonly visit?: ArrivalVisit;
  readonly facts: TwinArrivalFacts;
  /** The seat's last arrival post, when one has landed. */
  readonly lastLineId?: string;
}

/**
 * THE TWO KINDS OF ARRIVAL (ticket #266; spec #258 decision 15), stored as a
 * closed set (`rep_arrivals_visit_check`).
 *
 *   `first_of_day` — the first arrival of the seat-local day: the twin writes
 *                    the day's welcome.
 *   `return`       — a later one: the line names what changed since the last.
 */
export const ARRIVAL_VISITS = ["first_of_day", "return"] as const;

export type ArrivalVisit = (typeof ARRIVAL_VISITS)[number];

/**
 * What the seen ask carries: the posts the page just stamped (ticket #266).
 *
 * IDS AND NOTHING ELSE, bounded by `TWIN_API_SEEN_MAX_IDS`: the runtime
 * publishes them to the seat's own stream and reads nothing, so what a caller
 * could send down it is a list of opaque ids to its own seat.
 */
export interface TwinApiSeenRequest {
  readonly postIds: readonly string[];
}

/** ...and what it answers: how many ids it published. */
export interface TwinApiSeenResult {
  readonly published: number;
}

/**
 * The most ids one seen ask may carry.
 *
 * TWO HUNDRED, the feed's own cap on a page (`MAX_LIMIT` in the runtime's
 * `feed.ts`), because one ask is one statement's worth of ids and this bounds
 * what a caller past the bearer can put down the stream. A render that shows
 * more cards than this asks in pieces of it (`canvas.tsx`).
 */
export const TWIN_API_SEEN_MAX_IDS = 200;

/**
 * WHY AN OFFER IS SPENT (ticket #335; #337's `Spent`): the rep took it with a
 * tap, answered it in prose, or let it go with «Luego». Stored as a closed set
 * (`offer_spendings_reason_check`).
 */
export const OFFER_SPENT_REASONS = ["taken", "answered", "dismissed"] as const;

export type OfferSpentReason = (typeof OFFER_SPENT_REASONS)[number];

/**
 * What the spend ask carries: the card, the twin's sentence the rep saw on
 * it, and why it is spent (ticket #335).
 *
 * THE SENTENCE IS THE OFFER'S VERSION. A card keeps one offer at a time and
 * the twin may write a new one about it; the mark is about the sentence the
 * rep saw, so a new sentence on the same card rises as a new offer. The
 * runtime takes a mark only for an offer the twin's current curation makes.
 */
export interface TwinApiSpendRequest {
  readonly postId: string;
  readonly sentence: string;
  readonly reason: OfferSpentReason;
}

/** ...and what it answers: whether the mark was kept. */
export interface TwinApiSpendResult {
  readonly spent: boolean;
}

/** One offer the rep spent today: its card, its sentence, and why. */
export interface TwinOfferSpent {
  readonly postId: string;
  readonly sentence: string;
  readonly reason: OfferSpentReason;
}

/**
 * WHAT `/offer-spendings` ANSWERS (ticket #335): the seat-local day it read,
 * and every offer the rep spent in it, oldest first.
 */
export interface TwinOfferSpendings {
  readonly day: string;
  readonly spent: readonly TwinOfferSpent[];
}

/**
 * What the pick ask carries: which matter the rep picked, as the bar drew it,
 * and the page's own id for the pick (ticket #335).
 *
 * THE MATTER IS NAMED BY WHAT IT IS ABOUT AND ITS LABEL, as `/open-matters`
 * served them; the runtime finds it among the twin's current open matters and
 * refuses a pick it cannot find, so the words the thread is told are always
 * the twin's own label. `pickId` is minted by the page and comes back on the
 * stream's `curated` with the turn's line, so the bar knows the reply is the
 * answer to this pick.
 */
export interface TwinApiPickRequest {
  readonly pickId: string;
  readonly about: TwinOpenMatterSubject;
  readonly label: string;
}

/** ...and what it answers: whether the matter was found and the thread told. */
export interface TwinApiPickResult {
  readonly picked: boolean;
}

/**
 * What the select ask carries: the card the rep selected in, the phrase as the
 * page read it, and the page's own id for the selection (ticket #341).
 *
 * THE PHRASE IS CHECKED AGAINST THE CARD'S OWN WORDS — the twin's sentence
 * with its names drawn, a draft's body, a line of the day's notes — and a
 * phrase the card does not carry is refused, so the words the thread is told
 * are always words the twin put on that card. `selectionId` comes back on the
 * stream's `curated` with the turn's line, the pick's `pickId` rule.
 */
export interface TwinApiSelectRequest {
  readonly selectionId: string;
  readonly postId: string;
  readonly phrase: string;
}

/** ...and what it answers: whether the card carries the phrase and the thread was told. */
export interface TwinApiSelectResult {
  readonly selected: boolean;
}

/**
 * What the summon ask carries: the card the presence landed on, and the
 * page's own id for that landing (ticket #340).
 *
 * THE CARD MUST BE ONE OF THIS TWIN'S THAT WAITS, or the thread is told
 * nothing. `summonsId` comes back on the stream's `curated` with the twin's
 * sentence on that card, the pick's `pickId` rule.
 */
export interface TwinApiSummonRequest {
  readonly summonsId: string;
  readonly postId: string;
}

/** ...and what it answers: whether the card waits and the thread was told. */
export interface TwinApiSummonResult {
  readonly summoned: boolean;
}

/**
 * What the door's ask carries: the rep's words, and the login they typed them
 * under (ticket #261).
 *
 * THE SESSION IS A PARAMETER AND THE SEAT IS NOT, and the asymmetry is the
 * fence. The seat comes from the header rep-web fills from its session and the
 * twin comes from the registry, so neither can be named by a caller
 * (`local-api.ts`' three fences); the session id is the one thing only rep-web
 * knows, and the runtime checks it belongs to that seat and is still open
 * before it writes — so a message can never be recorded under a login that
 * ended or under another rep's.
 */
export interface TwinApiMessageRequest {
  readonly text: string;
  readonly sessionId: string;
  /**
   * WHAT THE REP POINTED AT, when these words are a line of the day's notes
   * corrected where it stands (ticket #344) or the answer to a blank the twin
   * left in a draft (ticket #342). The runtime keeps it on the message row,
   * and the twin reads the words as that line's correction or that blank's
   * answer.
   */
  readonly about?: TwinApiMessageAbout;
}

/**
 * WHAT A MESSAGE POINTS AT ON A CARD: a line of the notes it corrects (ticket
 * #344), or a blank of a draft it answers (ticket #342). One union, so the
 * door keeps one reference on the row and the router points the turn at one
 * target, whichever the rep tapped; the runtime refuses a reference to
 * anything that card does not carry.
 */
export type TwinApiMessageAbout = TwinApiLineAbout | TwinApiBlankAbout;

/**
 * Which line a message corrects: the card — the rep side's own post id, as
 * every card act names it — and the number the card printed beside the line.
 */
export interface TwinApiLineAbout {
  readonly kind: "line";
  readonly postId: string;
  readonly lineIndex: number;
}

/**
 * Which blank a message answers: the draft card — its post id — and the key
 * of the blank the rep tapped, or tapped Enviar with open (ticket #342).
 */
export interface TwinApiBlankAbout {
  readonly kind: "blank";
  readonly postId: string;
  readonly key: string;
}

/** ...and what it answers: the row's own id, so the page can follow its reply. */
export interface TwinApiMessageResult {
  readonly messageId: string;
}

/**
 * The most a door message may be, in characters.
 *
 * TWO THOUSAND, COUNTED IN CODE POINTS rather than bytes, because a cap the
 * rep is told about has to count what they typed: an accent and an emoji are
 * one character each to the person at the keyboard and two or four bytes to
 * the socket. `MAX_ACT_BODY_BYTES` on the server is the outer fence and stays
 * the thing that bounds memory; this is the product bound, and it is here
 * rather than in the runtime because the bar's composer caps its field at the
 * same number the server refuses on.
 *
 * TWO THOUSAND AND NOT TWO HUNDRED: the door is where a rep dictates «escríbele
 * a Torres que sí hay lugar el viernes y que le mando la cotización el lunes»,
 * and a cap that cut a real instruction in half would teach them to use the
 * phone instead. It is far above anything a person types into a composer in
 * one go, which is what a safety bound should be — not a tuning knob.
 */
export const TWIN_API_MESSAGE_MAX_CHARS = 2000;

/**
 * THE MOST THE REP NOTEPAD MAY HOLD, in characters (ticket #264; ADR-0033).
 *
 * THE STORE'S OWN NUMBER, restated on the wire for the one reader that cannot
 * import the store: `@dito/bundle`'s `NOTEPAD_CAP` is the bound the bundle's
 * CHECK enforces, and rep-web — which holds no key and depends on no bundle —
 * sizes *Mi libreta*'s field and names the cap in its sentence from this. The
 * local API's suite writes exactly this many characters and is refused one
 * more, so the two numbers cannot drift apart without a red build.
 */
export const TWIN_API_NOTEPAD_MAX_CHARS = 1500;

/**
 * THE DASHBOARD'S ACTS: the four a card offers (ticket #224; spec #214 *The
 * feed, in detail*), the two scope switches (#223) and the notebook edit
 * (#264) — ADR-0010, ADR-0013.
 *
 * A SEPARATE RECORD FROM THE READS, and the split is the METHOD: a read is a
 * GET and an act is a POST, so a POST to a read's path and a GET to an act's
 * are both `no_route` rather than a method error — which is what keeps a
 * caller the bearer already turned away from mapping the surface (#221's
 * decision 2, extended).
 *
 * `tap` IS NOT HERE, AND THAT IS ADR-0006. The send is the one act rep-web
 * writes itself — one tap row and one `customer_send` command in one
 * transaction under its own role — so the dashboard sends with this whole
 * server stopped (spec #214 story 8), and the send lock's doctrine of one
 * writer is kept by MOVING the writer to `@dito/seam` rather than by routing
 * a send through here.
 */
export const TWIN_API_ACT_ROUTES = {
  /** Descartar: the dismiss act, terminal as «no va» (ADR-0037). */
  dismissDraft: "/act/dismiss-draft",
  /** Retirar: one numbered line of the day's record (ADR-0004, FR-33). */
  retractLine: "/act/retract-line",
  /** «Sí, es este cliente» on the binding question (ADR-0035). */
  confirmBinding: "/act/confirm-binding",
  /** ...and «Es otro cliente», which writes nothing and says so. */
  declineBinding: "/act/decline-binding",
  /** The rep marks a chat: the twin may read it, and its ninety days arrive. */
  scopeIn: "/act/scope-in",
  /** ...and unmarks it: the guard drops its next message at the socket. */
  scopeOut: "/act/scope-out",
  /** «Guardar» on *Mi libreta*: the whole notebook, as the rep left it. */
  editNotepad: "/act/edit-notepad",
  /** Pausar on Trabajos en curso: the run fires nothing until it is taken up again. */
  pauseRun: "/act/pause-run",
  /** ...and Reanudar, which takes a paused run up again. */
  resumeRun: "/act/resume-run",
  /** Cancelar: the run ends at the pass with its report. */
  cancelRun: "/act/cancel-run",
  /** Activar on a rutina's proposal card: it goes `active`, and the clock fires it. */
  activateAutomation: "/act/activate-automation",
  /** Descartar on a proposal card: the rutina is gone, content and row. */
  discardAutomation: "/act/discard-automation",
  /** The switch to «En pausa»: the automation fires nothing until it is turned back on. */
  pauseAutomation: "/act/pause-automation",
  /** ...and back to «Activa». */
  resumeAutomation: "/act/resume-automation",
  /** The rep's typed answer to a run's question card (ticket #324). */
  answerAsk: "/act/answer-ask",
  /**
   * «Listo» on a card that has no act of its own — a report, a document, a
   * list (ticket #368): the rep takes it off the canvas.
   */
  clearCard: "/act/clear-card",
} as const;

export type TwinApiActRoute = keyof typeof TWIN_API_ACT_ROUTES;

/**
 * THE FOURTH MAP: WHAT THE RUNTIME STREAMS (ticket #263; spec #258 decision
 * 14).
 *
 * A GET, like a read, and NOT a read — which is why it is a map of its own
 * rather than a seventh entry in `TWIN_API_ROUTES`. A read answers and ENDS:
 * one JSON body, one pool connection held for the length of one request, and
 * the server's own serialization. A stream answers `text/event-stream` and
 * stays open for as long as the page does, so every one of those three is
 * different: its body is a sequence of typed events (`TwinStreamEvent`), it
 * holds NO connection past its fences (the pool is four, and a page left open
 * for a day must not keep one), and it is fed by the runtime's own seat event
 * bus rather than by a query. Registering it among the reads would put a
 * handler that never returns into a table whose every entry is awaited and
 * serialized.
 *
 * THE SAME THREE FENCES AS EVERY ROUTE, in the same order: the bearer, the
 * seat header, the seat's twin off the registry. What crosses is the seat's
 * own events and nothing else, and the stream is read-only — there is no
 * body and no method through which a caller could send anything down it.
 */
export const TWIN_API_STREAM_ROUTES = {
  /** The seat's own events, for the bar (and the canvas, #266). */
  events: "/events",
} as const;

export type TwinApiStreamRoute = keyof typeof TWIN_API_STREAM_ROUTES;

/**
 * THE EVENTS A SEAT'S STREAM CARRIES, as a closed set of words (ticket #263;
 * spec #258 decision 14).
 *
 * Each is the SSE `event:` name of one frame, and the frame's `data:` is the
 * whole `TwinStreamEvent` as JSON — the word is repeated inside it so a
 * reader that parsed the data alone still knows what it holds.
 *
 *   `post`    — the exchange's turn ended with something for the rep: the
 *               words the guard accepted, committed with the turn's record,
 *               which the bar plays back at a typing pace (#375).
 *   `failed`  — the exchange's turn ended with nothing for the rep: the run
 *               failed or the twin chose silence (`exchanges.ts` names the
 *               two). The bar says so and the history leaves it out.
 *   `settle`  — an act's outcome landed for a card (#266): the word from
 *               `SETTLE_OUTCOMES`, published after the outcome commits.
 *   `seen`    — the seat's seen-stamp moved (#266 publishes it after
 *               rep-web's stamp, through the seen ask).
 *   `arrived` — a proactive post landed that belongs on the canvas: a draft,
 *               a binding question, the day's notes (#266).
 *   `curated` — the twin's line or its curation changed: an arrival's turn
 *               ended (its line, or nothing when the turn left none), a turn
 *               said a line unasked, or the twin wrote a curation (#266, #320).
 *   `noted`   — the twin rewrote its working memory: its open matters as they
 *               now stand, so an open bar holds them as they are (#322).
 *
 * NOTHING OF A TURN'S WORDS IS ON THE STREAM WHILE THE TURN RUNS (ticket
 * #375, ruled 2026-10-09): the guard may refuse an attempt and the model
 * write it again, and a rep who watched the refused words would read a line
 * the twin never said. The words come once, at the turn's end, in the ending
 * the page already waits on — `post` for a reply to the rep's line, `curated`
 * for a line nobody asked for — exactly as the record holds them.
 *
 * THE BAR'S TWO WORDS ARE ITS OWN. `post` and `failed` are keyed by a
 * dashboard message and read by the bar alone; the canvas's words are words
 * of their own, so neither reducer is handed an event it has to recognise as
 * somebody else's.
 */
export const TWIN_STREAM_EVENT_KINDS = [
  "post",
  "failed",
  "settle",
  "seen",
  "arrived",
  "curated",
  "noted",
] as const;

export type TwinStreamEventKind = (typeof TWIN_STREAM_EVENT_KINDS)[number];

/**
 * The exchange's turn ended with something for the rep (ticket #263).
 *
 * `reply` IS THE ANSWER POST AS THE EXCHANGES READ SERVES IT — the words the
 * bar plays back, and the ones a later read shows whole. It is ABSENT when the twin answered with
 * something other than a reply at the door (a Borrador and its card), which is
 * `TwinExchange`'s own `settled` without a `reply`: the wait is over and there
 * is no text to show under the rep's line.
 */
export interface TwinStreamPost {
  readonly kind: "post";
  readonly messageId: string;
  readonly reply?: TwinFeedPost;
}

/** The exchange's turn ended with nothing for the rep (ticket #263). */
export interface TwinStreamFailed {
  readonly kind: "failed";
  readonly messageId: string;
}

/**
 * WHAT AN ACT'S OUTCOME WAS, AS THE CANVAS SAYS IT (ticket #266; spec #258
 * decisions 12 and 14).
 *
 *   `sent`      — the rail acked the customer send. Published where the
 *                 runtime settles the send command's outcome, never on the
 *                 press: «Enviado» is the truth of the send.
 *   `queued`    — the rep approved a draft while the rail is down; the command
 *                 waits for the rail.
 *   `dismissed` — Descartar, on either surface.
 *   `confirmed` — the binding the question proposed is the rep's.
 *   `declined`  — it is another customer, on either surface.
 *   `retracted` — one numbered line of the day's notes (`lineIndex`).
 *   `failed`    — the send came back `failed`: the rail refused it.
 *   `held`      — ADR-0006's third outcome, `SEND_OUTCOMES`' own word: the
 *                 rail was touched and its ack never came, so the message may
 *                 have left. Never told as `failed` — a rep told «it stayed
 *                 here» sends it again, and the customer gets it twice.
 *   `answered`  — the rep gave a run's question card its typed answer, on
 *                 either surface (ticket #324).
 *   `cleared`   — «Listo»: the rep took a card with no act of its own — a
 *                 report, a document, a list — off the canvas (ticket #368).
 */
export const SETTLE_OUTCOMES = [
  "sent",
  "queued",
  "dismissed",
  "confirmed",
  "declined",
  "retracted",
  "failed",
  "held",
  "answered",
  // «Listo»: the rep took a card with no act of its own off the canvas (ticket #368).
  "cleared",
] as const;

export type SettleOutcome = (typeof SETTLE_OUTCOMES)[number];

/**
 * An act's outcome landed for a card (ticket #266).
 *
 * PUBLISHED AFTER THE OUTCOME COMMITS, by the writer that committed it — so a
 * page that hears it and re-reads finds the store already saying the same.
 */
export interface TwinStreamSettle {
  readonly kind: "settle";
  readonly postId: string;
  readonly outcome: SettleOutcome;
  /** For `retracted`: the numbered line the rep took back. */
  readonly lineIndex?: number;
}

/** The seat's seen-stamp moved: the posts the page just stamped (ticket #266). */
export interface TwinStreamSeen {
  readonly kind: "seen";
  readonly postIds: readonly string[];
}

/**
 * A proactive post landed that the canvas draws (ticket #266): the post as the
 * feed serves it, so the page renders the card from the event alone.
 */
export interface TwinStreamArrived {
  readonly kind: "arrived";
  readonly post: TwinFeedPost;
}

/**
 * The twin's line or its curation changed, after the change committed
 * (tickets #266, #320).
 *
 * `arrivalId` NAMES THE ARRIVAL WHOSE TURN ENDED, when one did: `arrival` is
 * then its line as the canvas read serves it — the words the bar plays back —
 * and ABSENT WHEN THE TURN LEFT NONE, so the page stops waiting on it. With no `arrivalId`, `arrival` is a
 * line the twin said unasked. `curation` is the twin's current curation
 * whenever this turn wrote one, so an open page re-arranges.
 */
export interface TwinStreamCurated {
  readonly kind: "curated";
  readonly arrivalId?: string;
  /**
   * THE SPOTLIGHT THE TURN WROTE (ticket #401): the card it holds up now, or
   * `null` when the turn ended the spotlight; absent when the turn wrote none.
   */
  readonly spotlit?: TwinSpotlight | null;
  /**
   * THE PICK WHOSE TURN ENDED (ticket #335): the page's own id for the matter
   * the rep picked. `arrival` is then the twin's line resuming it, and absent
   * when the turn left none. A pick's line belongs to the bar, which asked.
   */
  readonly pickId?: string;
  /**
   * THE SELECTION WHOSE TURN ENDED (ticket #341): the page's own id for the
   * phrase the rep selected. `arrival` is then the twin's line explaining it,
   * and absent when the turn left none — the pick's rule, for the same reason.
   */
  readonly selectionId?: string;
  /**
   * THE SUMMONS WHOSE TURN ENDED (ticket #340): the page's own id for one
   * landing of the presence the rep summoned. `note` is then the sentence
   * the twin said on that card, and absent when it said none.
   */
  readonly summonsId?: string;
  readonly arrival?: TwinArrival;
  /**
   * THE SENTENCE THE TWIN SAID ON ONE OF ITS CARDS this turn (ticket #340;
   * `say_on_card`): drawn under that card's text while the presence is there,
   * and the card's alone — never the pill's, and never an entry of the day's
   * thread (ticket #401).
   */
  readonly note?: TwinCardNote;
  readonly curation?: TwinCuration;
  /**
   * THE DASHBOARD MESSAGES THIS TURN ANSWERED (ticket #380), by the
   * `messageId` their `post` will carry: the rep's line and every line that
   * folded into the turn. Absent when the turn answered none. It is how the bar
   * knows the curation and the note above are the choice of the reply it
   * waits on, and of no other turn's.
   */
  readonly answers?: readonly string[];
}

/**
 * A sentence the twin said on one of its own cards (ticket #340): a line of
 * its own, as `TwinArrival` carries one, and the card it is on.
 */
export interface TwinCardNote extends TwinArrival {
  /** The waiting card the sentence was said on, by its post id. */
  readonly card: string;
}

/**
 * The twin's working memory moved (ticket #322): its version and open matters
 * as they stand, published after the turn that wrote them ended.
 */
export interface TwinStreamNoted extends TwinOpenMatters {
  readonly kind: "noted";
}

export type TwinStreamEvent =
  | TwinStreamPost
  | TwinStreamFailed
  | TwinStreamSettle
  | TwinStreamSeen
  | TwinStreamArrived
  | TwinStreamCurated
  | TwinStreamNoted;

/**
 * WHAT EACH ACT NAMES AS ITS TARGET (tickets #223 and #264).
 *
 * Three words, because there are three kinds of thing a rep can act on: the
 * CARD they were shown, which is a post; the CHAT they switched, which is a
 * directory row; and their own NOTEPAD, which is neither and needs no id —
 * a twin has one notebook, and the seat the request authenticated as already
 * names it. One record both sides read, so three statements say one thing:
 * the API picks which body shape to validate, the store refuses a row whose
 * target columns do not match its verb — `dashboard_acts_target_by_verb_check`
 * holds the chat verbs to a directory row, `dashboard_acts_notepad_target_check`
 * holds the notepad verb to no target and every other verb to one, and
 * `dashboard_acts_one_target_check` refuses a row naming both — and
 * `migration-vocabulary.test.ts` sweeps the two verb lists against this record.
 * A verb added here without an arm in those CHECKs is a red build rather than
 * a constraint violation in front of a rep who pressed a button.
 */
export const DASHBOARD_ACT_TARGET_OF_ROUTE = {
  dismissDraft: "post",
  retractLine: "post",
  confirmBinding: "post",
  declineBinding: "post",
  scopeIn: "chat",
  scopeOut: "chat",
  editNotepad: "notepad",
  pauseRun: "run",
  resumeRun: "run",
  cancelRun: "run",
  activateAutomation: "automation",
  discardAutomation: "automation",
  pauseAutomation: "automation",
  resumeAutomation: "automation",
  answerAsk: "post",
  clearCard: "post",
} as const satisfies Readonly<
  Record<TwinApiActRoute, "post" | "chat" | "notepad" | "run" | "automation">
>;

/** One of the things a rep can act on. */
export type DashboardActTarget =
  (typeof DASHBOARD_ACT_TARGET_OF_ROUTE)[TwinApiActRoute];

/**
 * WHAT THE REP PERFORMED, as `dashboard_acts.verb` holds it.
 *
 * ONE WORD PER ROUTE, in the same order, and the two are swept against each
 * other by the store's own CHECK (`migration-vocabulary.test.ts`): a verb the
 * API writes that the store refuses is a rep pressing a button and getting a
 * constraint violation.
 */
export const DASHBOARD_ACT_VERBS = [
  "dismiss_draft",
  "retract_line",
  "confirm_binding",
  "decline_binding",
  // Ticket #223: the two acts whose target is a CHAT rather than a card. They
  // are dashboard acts in every sense the four above are — a rep decision,
  // recorded as evidence, run as an execution — and they are the first two
  // whose `dashboard_acts` row carries no post.
  "scope_in",
  "scope_out",
  // Ticket #264: the act whose row names no target at all — the notebook is
  // the seat's own, so the act row itself is the whole of the evidence.
  "edit_notepad",
  // Ticket #323: the three acts whose target is a workflow run on Trabajos en
  // curso — two flags and their undo, never a card.
  "pause_run",
  "resume_run",
  "cancel_run",
  // Ticket #325: the four acts whose target is an automation on Rutinas — a
  // rutina's Activar and Descartar, and the switch every automation carries.
  "activate_automation",
  "discard_automation",
  "pause_automation",
  "resume_automation",
  // Ticket #324: the rep's typed answer to a run's question card — a post act,
  // like the binding question's two, carrying the answer in its request.
  "answer_ask",
  // Ticket #368: «Listo» on a card with no act of its own — a post act that
  // takes the card off the canvas and settles nothing else.
  "clear_card",
] as const;

export type DashboardActVerb = (typeof DASHBOARD_ACT_VERBS)[number];

/** Which verb each act route performs — the record both sides read. */
export const DASHBOARD_ACT_VERB_OF_ROUTE = {
  dismissDraft: "dismiss_draft",
  retractLine: "retract_line",
  confirmBinding: "confirm_binding",
  declineBinding: "decline_binding",
  scopeIn: "scope_in",
  scopeOut: "scope_out",
  editNotepad: "edit_notepad",
  pauseRun: "pause_run",
  resumeRun: "resume_run",
  cancelRun: "cancel_run",
  activateAutomation: "activate_automation",
  discardAutomation: "discard_automation",
  pauseAutomation: "pause_automation",
  resumeAutomation: "resume_automation",
  answerAsk: "answer_ask",
  clearCard: "clear_card",
} as const satisfies Readonly<Record<TwinApiActRoute, DashboardActVerb>>;

/**
 * THE VERBS THAT ACT ON EACH KIND OF TARGET, derived from the two records
 * above rather than written down a third time (ticket #223).
 *
 * WHY THEY ARE TYPES AT ALL. The runtime's act switch has to be EXHAUSTIVE
 * over the verbs it handles — that is what makes «a verb nobody wrote an arm
 * for» a red build instead of a rep pressing a button and getting nothing —
 * and the card acts, the switch acts and the notebook edit are handled by
 * different code over different targets. Without a narrowing the compiler
 * cannot tell that a post act's switch has covered everything, so it would
 * need a `default` arm: an unreachable branch pretending to be a guard, which
 * is exactly what this repo refuses to write.
 *
 * AND WHY THEY ARE DERIVED. A hand-written union would be another copy of the
 * split, drifting from the record and from the store's own CHECK. This way
 * adding a verb to `DASHBOARD_ACT_TARGET_OF_ROUTE` puts it in exactly one of
 * these types, and the switch that does not handle it stops compiling.
 */
type ActRouteWithTarget<T extends DashboardActTarget> = {
  [K in TwinApiActRoute]: (typeof DASHBOARD_ACT_TARGET_OF_ROUTE)[K] extends T
    ? K
    : never;
}[TwinApiActRoute];

/** The routes whose act is performed on a card. */
export type DashboardPostActRoute = ActRouteWithTarget<"post">;

/** ...and the routes whose act is performed on a chat directory row. */
export type DashboardScopeActRoute = ActRouteWithTarget<"chat">;

/** ...and the route whose act is performed on the seat's own notepad. */
export type DashboardNotepadActRoute = ActRouteWithTarget<"notepad">;

/** ...and the routes whose act is performed on a workflow run (ticket #323). */
export type DashboardRunActRoute = ActRouteWithTarget<"run">;

/** ...and the routes whose act is performed on an automation on Rutinas (ticket #325). */
export type DashboardAutomationActRoute = ActRouteWithTarget<"automation">;

/** The verbs performed on a card. */
export type DashboardPostActVerb =
  (typeof DASHBOARD_ACT_VERB_OF_ROUTE)[DashboardPostActRoute];

/** ...and the verbs performed on a chat directory row. */
export type DashboardScopeActVerb =
  (typeof DASHBOARD_ACT_VERB_OF_ROUTE)[DashboardScopeActRoute];

/** ...and the verbs performed on a workflow run (ticket #323). */
export type DashboardRunActVerb =
  (typeof DASHBOARD_ACT_VERB_OF_ROUTE)[DashboardRunActRoute];

/** ...and the verbs performed on an automation (ticket #325). */
export type DashboardAutomationActVerb =
  (typeof DASHBOARD_ACT_VERB_OF_ROUTE)[DashboardAutomationActRoute];

/**
 * Whether a route's act is performed on a chat rather than on a card.
 *
 * A TYPE PREDICATE OVER THE RECORD, so the narrowing and the runtime answer
 * are one statement: the API branches on this to decide which body shape to
 * validate, and the compiler narrows the route in BOTH directions from it — so
 * the four card acts and the two switch acts each reach a switch that is
 * exhaustive over exactly their own verbs.
 */
export function isScopeActRoute(
  route: TwinApiActRoute,
): route is DashboardScopeActRoute {
  return DASHBOARD_ACT_TARGET_OF_ROUTE[route] === "chat";
}

/** ...and whether it is performed on a workflow run, by the same record (#323). */
export function isRunActRoute(
  route: TwinApiActRoute,
): route is DashboardRunActRoute {
  return DASHBOARD_ACT_TARGET_OF_ROUTE[route] === "run";
}

/** ...and whether it is performed on an automation, by the same record (#325). */
export function isAutomationActRoute(
  route: TwinApiActRoute,
): route is DashboardAutomationActRoute {
  return DASHBOARD_ACT_TARGET_OF_ROUTE[route] === "automation";
}

/** ...and whether it is performed on the notepad, by the same record (#264). */
export function isNotepadActRoute(
  route: TwinApiActRoute,
): route is DashboardNotepadActRoute {
  return DASHBOARD_ACT_TARGET_OF_ROUTE[route] === "notepad";
}

/**
 * HOW AN ACT ANSWERS — four words, closed and content-free.
 *
 *   `performed`     — it happened. The page re-reads the feed and the receipt
 *                     the runtime appended is what the rep sees.
 *   `already`       — it had already happened, and saying so again costs
 *                     nothing: a repeat dismissal, a repeat retraction, a chat
 *                     already bound. Idempotent by design on every act here.
 *   `refused`       — the target is not in a state this act applies to: a
 *                     draft already sent, a line that discloses a binding
 *                     rather than a fact, a card whose post carries no part
 *                     this act works on. ONE WORD FOR ALL OF THEM, which is
 *                     `login.refused`'s own rule: four of the five are facts
 *                     about a state the rep can read off the card anyway, and
 *                     telling them apart would map the store for whoever got
 *                     past the bearer.
 *   `window_closed` — its own word, and the one exception to that rule,
 *                     because the AC asks for it: a retraction after the
 *                     correction window is refused with the same reason the
 *                     thread gives (ADR-0004; `RetractionRefusal`).
 */
export const TWIN_API_ACT_OUTCOMES = [
  "performed",
  "already",
  "refused",
  "window_closed",
] as const;

export type TwinApiActOutcome = (typeof TWIN_API_ACT_OUTCOMES)[number];

/** What an act answers on the wire. */
export interface TwinApiActResult {
  readonly outcome: TwinApiActOutcome;
}

/**
 * WHAT A POST ACT IS ASKED FOR — the post the card is, and for a retraction
 * the line number the rep's button named.
 *
 * THE TARGET IS THE POST, AND NOT A DRAFT OR A LINE ID. That is `acts.ts`'
 * rule TWO on the other surface, word for word: "the target is what the rep
 * quoted, never what the model named". A card IS a post, so the post's id is
 * what the dashboard can honestly say the rep acted on, and code walks from it
 * to the draft or the numbering. A caller naming a draft directly could
 * dismiss a draft whose card the rep never saw.
 *
 * `lineIndex` IS THE NUMBER THE POST PRINTED, resolved against the numbering
 * recorded when it was rendered (`disclosure_post_lines`, ADR-0034) — so a
 * number that post never showed resolves to nothing.
 */
export interface TwinApiPostActRequest {
  readonly postId: string;
  readonly lineIndex?: number;
  /**
   * THE REP'S TYPED ANSWER TO A QUESTION CARD, by field name — `answerAsk`
   * only, as `lineIndex` is `retractLine`'s (ticket #324): a pick as the
   * option's value, several for a pick-many, a short text, a date as
   * YYYY-MM-DD. The runtime checks it against the card's own fields.
   */
  readonly answers?: Readonly<Record<string, string | readonly string[]>>;
}

/**
 * ...AND WHAT A SCOPE ACT IS ASKED FOR: the directory row the switch names
 * (ticket #223).
 *
 * THE ROW'S ID AND NEVER THE CHAT'S JID, which is the same rule one paragraph
 * up wearing different clothes. The scoping page lists rows the lease holder
 * served, so the row is what the rep can honestly be said to have switched —
 * and a form carrying a chat address would put a customer's phone number in
 * this app's HTML, in a browser's history and in every proxy log between here
 * and there (ADR-0004). The runtime resolves the row under its own twin, so a
 * caller naming another twin's row is refused rather than served.
 */
export interface TwinApiScopeActRequest {
  readonly directoryId: string;
}

/**
 * ...AND WHAT THE NOTEBOOK EDIT IS ASKED FOR: the whole notebook, as the rep
 * left it (ticket #264; ADR-0033).
 *
 * THE WHOLE TEXT AND NEVER A DELTA, the unit `write_notepad` writes on the
 * other surface: every save is a new version of the entire notebook, so there
 * is no edit a caller could half-apply. An EMPTY text is the delete — a
 * version with nothing in it, after which the recipe renders the default line
 * alone. No target id, because a twin has one notebook and the seat header
 * already says whose.
 *
 * `basedOn` IS THE VERSION THE PAGE WAS SERVED (`TwinNotepad.version`), the
 * same token `write_notepad` carries on the other surface (Codex r1). A
 * whole-notebook write composed against an older version would drop whatever
 * the rep taught the thread in between, so the runtime refuses it as `stale`
 * rather than appending it.
 */
export interface TwinApiNotepadActRequest {
  readonly text: string;
  readonly basedOn: number;
}

/**
 * ...AND WHAT AN ACT ON A RUN IS ASKED FOR: the run's id, as the runs read
 * served it (ticket #323). The runtime resolves it under its own twin, so a
 * caller naming another twin's run is refused rather than served.
 */
export interface TwinApiRunActRequest {
  readonly runId: string;
}

/**
 * ...AND WHAT AN ACT ON AN AUTOMATION IS ASKED FOR (ticket #325): which one, as
 * the Rutinas read served it — a shipped automation's registry word or a
 * rutina's id. The runtime resolves it under its own twin and seat, so a caller
 * naming another twin's rutina is refused rather than served.
 */
export interface TwinApiAutomationActRequest {
  readonly automation: string;
  /**
   * THE PROPOSAL CARD THE BUTTON WAS PRESSED ON (ticket #386), when it was: the
   * act then answers only for that card's rutina while it still waits on the
   * rep, so a card left open after the rep answered it elsewhere cannot
   * discard the rutina they accepted.
   */
  readonly proposal?: string;
}

/**
 * Any act's shape, and THE ROUTE IS THE DISCRIMINANT — it is in the path, so
 * nothing in the body has to repeat it (`DASHBOARD_ACT_TARGET_OF_ROUTE` is the
 * record that says which). A discriminant field would also have changed the
 * wire for #224's four acts, whose bodies are already deployed on the rig.
 */
export type TwinApiActRequest =
  | TwinApiPostActRequest
  | TwinApiScopeActRequest
  | TwinApiNotepadActRequest
  | TwinApiRunActRequest
  | TwinApiAutomationActRequest;

/**
 * THE NOTEBOOK EDIT'S REFUSAL AT THE CAP (ticket #264; ADR-0033's 1,500
 * characters, checked at the write).
 *
 * THE STORE'S OWN STRUCTURED REFUSAL, minus the text. `@dito/bundle`'s
 * `NotepadWrite` answers an over-long write with the cap, what the attempt
 * weighed and the text that still stands, because a MODEL consolidates from
 * that text. The dashboard's reader is the rep, who is looking at the
 * notebook they typed and was served the standing one on the page's own
 * read — so the wire carries the two numbers and never a second copy of the
 * rep's words.
 *
 * AN ANSWER AND NOT A REFUSAL WORD, and outside `TWIN_API_ACT_OUTCOMES` on
 * purpose: nothing is written for it, no act row included, so it is not a word
 * `dashboard_acts.outcome` can ever hold — and that set is swept against the
 * store's CHECK.
 */
export interface TwinApiNotepadOverCap {
  readonly outcome: "over_cap";
  readonly cap: number;
  readonly charsAttempted: number;
}

/**
 * ...AND ITS REFUSAL FOR A NOTEBOOK THAT MOVED UNDER THE PAGE (Codex r1): the
 * version that stands now, which the page re-reads the text of and the rep's
 * next save is based on. Nothing is written for it but the act row, stamped
 * `refused` — the rep did press Guardar.
 */
export interface TwinApiNotepadStale {
  readonly outcome: "stale";
  readonly version: number;
}

/** What the notebook edit answers: an act's word, or one of its two refusals. */
export type TwinApiNotepadActResult =
  | TwinApiActResult
  | TwinApiNotepadOverCap
  | TwinApiNotepadStale;

/**
 * The header carrying the seat a request is FOR.
 *
 * THE BEARER SAYS WHICH PROCESS, THIS SAYS WHICH REP. rep-web's session layer
 * maps a cookie to a seat and puts it here; the runtime resolves that seat to
 * a twin and refuses any seat whose twin is not its own. Lower-case because
 * Node lower-cases every incoming header name, so a comparison against this
 * constant is exact rather than nearly.
 */
export const TWIN_API_SEAT_HEADER = "x-dito-seat";

/** What «now» means while a page renders — the caller's, never the server's. */
export const TWIN_API_NOW_PARAM = "now";
/** How many posts one page of the feed holds. */
export const TWIN_API_LIMIT_PARAM = "limit";
/** The keyset of the last post on the previous page. */
export const TWIN_API_CURSOR_PARAM = "cursor";
/**
 * The newest seat-local day a page of the exchanges may hold (ticket #263) —
 * the `nextUntil` the previous page answered.
 */
export const TWIN_API_UNTIL_PARAM = "until";
/**
 * Which day the acts log answers, as whole days back from the seat-local
 * today (ticket #267): `0` is today, `1` yesterday. Absent means today, and
 * a count past `TWIN_API_ACTS_LOG_DAYS` answers that last day rather than an
 * older one.
 */
export const TWIN_API_BACK_PARAM = "back";

/**
 * HOW FAR BACK THE ACTS LOG REACHES, in days before today (ticket #267; spec
 * #258 decision 16: «"Hoy" and ‹ › back seven days; older is gone from the
 * dashboard»).
 *
 * ENFORCED BY THE RUNTIME, which clamps `back` to it before any day is cut:
 * a page asking for day eight is answered day seven, so no URL reaches an
 * older row. rep-web reads the same constant to know when ‹ has nowhere left
 * to go.
 */
export const TWIN_API_ACTS_LOG_DAYS = 7;

/**
 * The day a `back` parameter names, clamped to the days the dashboard keeps —
 * or `undefined` when it is not a whole number of days (ticket #267).
 *
 * ONE RULE FOR BOTH SIDES OF THE WIRE: the runtime refuses what this cannot
 * read and rep-web reads it as today, but a count either side accepts is the
 * same count, and any count past `TWIN_API_ACTS_LOG_DAYS` is that last day on
 * both. Absent is today.
 */
export function daysBackOf(param: string | null): number | undefined {
  if (param === null) return 0;
  if (!/^\d+$/u.test(param)) return undefined;
  return Math.min(Number(param), TWIN_API_ACTS_LOG_DAYS);
}

/**
 * Whether a string names a calendar day, `YYYY-MM-DD` (ticket #263).
 *
 * A DAY IS A DATE AND NEVER AN INSTANT, which is what keeps the exchanges'
 * cursor in one zone: the runtime cuts days in the seat's zone inside
 * Postgres, answers them as bare dates, and the page does calendar arithmetic
 * on those dates alone — so no second process ever converts an instant to a
 * day with a zone of its own. The round trip through `Date.UTC` refuses a
 * shape that parses but names no day, such as a thirty-first of February.
 */
export function isCalendarDay(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (match === null) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const at = new Date(Date.UTC(year, month - 1, day));
  return (
    at.getUTCFullYear() === year &&
    at.getUTCMonth() === month - 1 &&
    at.getUTCDate() === day
  );
}

/**
 * Every way the API refuses, as a closed set of words.
 *
 * CLOSED AND CONTENT-FREE, for the reason the notify record's reasons are: a
 * refusal a caller reads is a sentence somebody could put content into, and
 * these are read by a machine anyway. What each one means:
 *
 *   `unauthorized`  — the bearer is missing or is not rep-web's. Nothing has
 *                     been read at this point, not even the seat.
 *   `no_seat`       — no seat header, or one that is not a seat id.
 *   `unknown_seat`  — no such seat in the registry.
 *   `wrong_twin`    — the seat is real and its twin is not this runtime's.
 *                     One runtime serves one twin (ADR-0010).
 *   `no_route`      — no read at that path, or the wrong method for it.
 *   `bad_request`   — a parameter the read cannot take.
 *   `unavailable`   — the read could not be served. Deliberately says nothing
 *                     about why: a runtime's own failure is not a caller's
 *                     business and its text would be a leak.
 */
export const TWIN_API_REFUSALS = [
  "unauthorized",
  "no_seat",
  "unknown_seat",
  "wrong_twin",
  "no_route",
  "bad_request",
  "unavailable",
] as const;

export type TwinApiRefusal = (typeof TWIN_API_REFUSALS)[number];

/** What a refusal looks like on the wire. */
export interface TwinApiRefusalBody {
  readonly error: TwinApiRefusal;
}

/**
 * The rail's state, as `/rail` answers it.
 *
 * `null` IS «NOTHING HAS EVER HAPPENED», not «linked». A twin whose plane has
 * never run has no row, and a page that read an absent row as a good state
 * would tell a rep their WhatsApp is connected when nothing has ever
 * connected.
 *
 * `at` IS AN ISO STRING because this is JSON: `Date` does not survive the
 * wire, and a number would be an instant with no zone in it.
 */
export interface TwinRailState {
  readonly status: RailStatus | null;
  readonly at: string | null;
}

/**
 * The same state WITH the link session's credentials, as `/link` answers it
 * (ticket #223; ticket #241).
 *
 * BOTH DOORS AT ONCE AND NOT WHICHEVER ROW IS NEWEST (boundary #225, F10). One
 * session offers both and the plane's QR supersedes the row beside it
 * (`RAIL_CREDENTIAL_STATUSES` argues the session), so a shape with one
 * credential in it carried whichever was written last — and a code the rep was
 * in the middle of typing left the page twenty seconds after it arrived. The
 * two fields are the two doors; `status` says what the rail last did, which is
 * a different question and the one that says `linked`.
 *
 * A CREDENTIAL IS PRESENT ONLY WHILE A SESSION STANDS. On a `linked`,
 * `dropped` or `logged_out` row the column still holds whatever was written
 * there before, and serving it would hand the link page a credential for a
 * socket that is not waiting for one: a page rendering a stale QR beside
 * «vinculado» is the failure this omission exists to refuse.
 *
 * `windowOpenedAt` IS THE ONLY CLOCK THE PAGE MAY COUNT FROM, and the length
 * it counts is a constant the caller owns (`LINK_WINDOW_SECONDS` in rep-web).
 */
export interface TwinLinkState {
  readonly status: RailStatus | null;
  readonly at: string | null;
  /** This session's newest QR payload. Absent when it has served none. */
  readonly qr?: string;
  /** ...and its eight characters, for as long as the session stands. */
  readonly pairingCode?: string;
  /**
   * When the standing session's window opened — its first credential row's
   * instant, ISO. `null` when no session stands.
   */
  readonly windowOpenedAt: string | null;
  /**
   * WHAT BECAME OF THE REP'S NEWEST ASK inside the credential's own window
   * (`LinkAsk` argues the four words).
   *
   * IT IS ON THIS WIRE BECAUSE THE PAGE CANNOT ASK. `plane_requests` is a
   * store rep-web holds no privilege on, and the difference it makes is the
   * difference between a screen that reloads and a screen with a button:
   * without it, the seconds between «Generar otro» and the plane's answer look
   * exactly like an expired credential nobody has asked to replace — and an
   * ask the plane failed or never took looks like one still on its way.
   */
  readonly ask: LinkAsk;
}

/**
 * WHAT BECAME OF THE REP'S NEWEST PAIRING-CODE ASK (tickets #223 and #403).
 *
 *   `none`    — no ask inside the window, or the newest one was served or
 *               refused: the rail's own rows are the whole answer.
 *   `waiting` — the plane owes a credential and is inside its time to answer.
 *   `untaken` — the plane has not taken the ask after `LINK_ASK_UNTAKEN_SECONDS`
 *               — it polls every second, so a plane that has not taken it is
 *               not running — and the rep is owed a way to ask again.
 *   `failed`  — the plane took the ask and could not serve it (a refusal by
 *               name is `none`: the rail's own rows answer it).
 *
 * ONE WORD AND NOT THREE FLAGS, because the four are exclusive: an ask is in
 * exactly one of them, and a pair of booleans could say «waiting and failed».
 */
export const LINK_ASKS = ["none", "waiting", "untaken", "failed"] as const;

export type LinkAsk = (typeof LINK_ASKS)[number];

/**
 * THE CHAT DIRECTORY, AS THE SCOPING PAGE RECEIVES IT (ticket #223; spec #214
 * decision 7 and user story 16).
 *
 * WHAT IS HERE AND WHAT IS DELIBERATELY NOT. The row's own id, its kind, the
 * name the lease holder OPENED, when the chat was last active, whether it is in
 * scope, and the fill's progress. NOT the chat's JID and not its LID: the row
 * id is the handle every switch names, so a page, a form and a URL can all be
 * built without a phone number ever leaving the runtime (ADR-0004; the
 * `rep-web.int.test.ts` sweep is what holds it).
 *
 * `name` IS `null` WHEN THE PLANE HAS LEARNED NONE, which is an absence and not
 * an empty name (`chat_directory.name_enc`'s own rule). The page renders chrome
 * for it rather than a blank, because a nameless row with a switch on it is a
 * chat the rep cannot identify.
 */
export interface TwinDirectory {
  readonly chats: readonly TwinDirectoryChat[];
}

export interface TwinDirectoryChat {
  /** The directory row's own id — the handle a switch names. Never a JID. */
  readonly id: string;
  readonly kind: ChatKind;
  /** What the rep's phone calls this chat, opened under the twin's key. */
  readonly name: string | null;
  readonly lastActivityAt: string | null;
  readonly inScope: boolean;
  readonly fill: TwinDirectoryFill;
}

/** The ninety-day fill's progress, as the plane records it per chat. */
export interface TwinDirectoryFill {
  readonly pages: number;
  /** How far back it has reached — the date the fill card is labelled by. */
  readonly oldestAt: string | null;
  /** The phone's own last word about whether more remains on the primary. */
  readonly endOfTransfer: string | null;
  readonly lastAt: string | null;
  /**
   * HOW THIS CHAT'S LAST FILL ATTEMPT ENDED, or `null` while one is running
   * (ticket #255; boundary #225, F39) — the plane's own marker
   * (…20260909100020), the word `FILL_STOPS_NO_HISTORY` and
   * `FILL_STOPS_COMPLETE` group.
   *
   * IT IS HERE SO A CARD CAN NAME THE CHATS IT IS TALKING ABOUT. «Hay chats
   * que marcaste en los que Dito lee desde hoy en adelante» named no chat and
   * no consequence, and the rep did not know what the card was — and the
   * NAMES live only behind this read, because they are sealed under the twin
   * key and rep-web holds none.
   *
   * THE INSTANT AND THE RESUMED FACT ARE NOT HERE, deliberately: a marker is
   * this attempt's or a stale one only against the allowlist row's own
   * instant, which this read does not carry and rep-web reads for itself
   * (`fill.ts`) — so they would be two fields no caller could use.
   */
  readonly stoppedBy: string | null;
}

/* ------------------------------------------------------------------ */
/* The feed, as it crosses the wire (ticket #224).                     */
/* ------------------------------------------------------------------ */

/**
 * THE FEED'S WIRE SHAPE — one twin's posts as JSON (ticket #224; #221
 * decision 10's open question, answered here).
 *
 * #221 left it open whether the feed's type moves to this package or stays
 * `@dito/twin-runtime`'s, "recorded on #221" for the ticket that first renders
 * a card. It is neither: THE WIRE IS ITS OWN TYPE, declared here, and the read
 * model stays where it is.
 *
 * WHY, IN ONE FACT: `FeedPost.at` is a `Date` and `FeedPage` carries three
 * more instants, and **a `Date` does not survive JSON**. `TwinRailState` three
 * declarations up already says this out loud for one field — "an instant
 * becomes an ISO string here" — so a type shared between the two sides would
 * either put a `Date` in the seam that no caller ever receives, or force the
 * runtime's read model to speak strings to the thread as well as to the
 * dashboard. The transformation is real, so the two types are really two.
 *
 * IT IS NOT DUPLICATION UNCHECKED. `feed-wire.test.ts` in the runtime — the
 * one package that may import both — asserts field by field that every part of
 * the read model has a wire arm, that the two agree on every name, and that
 * exactly the instants differ. So a field grown on one side without the other
 * is a red build rather than a card that renders `undefined`.
 *
 * THE PART NAMES ARE THE READ MODEL'S, verbatim, and so are the answer acts:
 * a surface draws a card from `kind` and a button from `acts`, so those two
 * words are the contract and renaming either is renaming the wire.
 */
export type TwinFeedPart =
  | TwinFeedProsePart
  | TwinFeedDraftPart
  | TwinFeedRecordLinesPart
  | TwinFeedQuestionPart
  | TwinFeedAskPart
  | TwinFeedProposalPart
  | TwinFeedReceiptPart
  | TwinFeedKnockPart
  | TwinFeedCurationPart
  | TwinFeedDocumentPart
  | TwinFeedDataPart;

/** What a surface may offer on a part — the read model's own six words. */
export type TwinFeedAnswerAct =
  | "tap"
  | "dismiss"
  | "retract"
  | "confirm"
  | "decline"
  | "answer"
  /** «Listo» on a document or a list, while the card is on the canvas (ticket #368). */
  | "clear"
  /** Activar and Descartar on a rutina the twin proposed, while it waits (ticket #386). */
  | "activate"
  | "discard";

/**
 * A CUSTOMER THE TWIN'S PROSE NAMES (ticket #321; CONTEXT.md *Reference*).
 *
 * The prose carries the reference where the twin wrote it — `[c7]` — and the
 * surface renders `name` in its place, with the number's tails when the
 * customer has more than one chat. Which card the words open is never here:
 * it is the twin's, a mark in the prose itself (`[[c7]](<post id>)`,
 * `markInProse`; ticket #401).
 */
export interface TwinFeedMention {
  /** The reference as the prose carries it, without its brackets: `c7`. */
  readonly reference: string;
  readonly name: string;
  readonly tails?: readonly string[];
}

// THE REFERENCE GRAMMAR LIVES IN ITS OWN MODULE, which a browser bundle can
// import without the rest of this package (ticket #401).
export { markInProse, referenceInProse } from "./references.js";

/** Prose the twin composed. No act: there is nothing to answer. */
export interface TwinFeedProsePart {
  readonly kind: "prose";
  readonly text: string;
  readonly acts: readonly TwinFeedAnswerAct[];
  /** The customers the text names by reference; absent when it names none. */
  readonly mentions?: readonly TwinFeedMention[];
}

/** The draft this post proposes, with the body a tap would release. */
export interface TwinFeedDraftPart {
  readonly kind: "draft";
  readonly draftId: string;
  /**
   * Who the draft is for, as the rep reads it: a confirmed binding, or the
   * push name or number marked «(sin confirmar)» (#34, #298). Always present
   * — a post that recorded no name is named by the runtime's read.
   */
  readonly counterparty: string;
  /**
   * The last four digits of the number the draft goes to, when its customer
   * has more than one chat (ticket #321): the card shows the rep which one
   * the twin picked before they tap.
   */
  readonly tail?: string;
  /**
   * The message body, opened under the twin's key by the lease holder. A
   * blank still open stands in it as its marker (`draftBlankMarker`).
   */
  readonly body: string;
  /**
   * THE FACTS THE TWIN LEFT FOR THE REP (ticket #342): each blank's key, the
   * short label the card draws in its capsule and the one question the pill
   * raises for it. Absent on a draft with none.
   */
  readonly blanks?: readonly TwinFeedDraftBlank[];
  /** The blank this draft filled in the draft it supersedes, when it is a fill (ticket #342). */
  readonly filled?: TwinFeedDraftFill;
  /**
   * A DRAFT THAT COMMITS THE REP TO SOMETHING (ticket #343; the spine's
   * movement 11, «Antes de que la mandes»): a price below list, a delivery
   * date, an apology — the twin's judgement. Present exactly with `reason`;
   * absent on a plain draft.
   */
  readonly delicate?: true;
  /**
   * What the twin decided and why, in two sentences at most, composed when it
   * drafted — the pill raises it while the rep rests on Enviar, before the tap.
   */
  readonly reason?: string;
  readonly acts: readonly TwinFeedAnswerAct[];
}

/**
 * ONE BLANK THE TWIN LEFT IN A DRAFT (ticket #342; the spine's movement 8,
 * «Me falta un dato»): a fact only the rep has, as a typed slot the twin
 * composed when it drafted — never words a surface writes.
 */
export interface TwinFeedDraftBlank {
  /** What the body's marker names. */
  readonly key: string;
  /** What is missing, in the twin's words: «precio», «la hora». */
  readonly label: string;
  /** The one question the twin asks the rep for it, with what it knows. */
  readonly question: string;
}

/**
 * WHERE A FILL LANDED (ticket #342): the draft whose blank this one filled,
 * the blank's key, and the span of this draft's body the rep's answer became
 * — UTF-16 offsets, as a string in the page counts them — so the card can
 * stand in the superseded one's place and wash the words that came in.
 */
export interface TwinFeedDraftFill {
  readonly draftId: string;
  readonly key: string;
  readonly start: number;
  readonly end: number;
}

/**
 * THE MARKER A BLANK STANDS AS IN A DRAFT'S BODY (ticket #342): `⟦key⟧`, once
 * per key. Mathematical white square brackets, because a customer's message
 * never carries them and a model types them as readily as any bracket — so a
 * marker is never mistaken for text, and text never for a marker.
 */
export const DRAFT_BLANK_OPEN = "\u27e6";
export const DRAFT_BLANK_CLOSE = "\u27e7";

/** The marker one blank stands as. */
export function draftBlankMarker(key: string): string {
  return `${DRAFT_BLANK_OPEN}${key}${DRAFT_BLANK_CLOSE}`;
}

/** One numbered line of the day's record, as the post printed it. */
export interface TwinFeedRecordLine {
  readonly index: number;
  /** The claim, exactly as the aperture stored it (ADR-0034). */
  readonly text: string;
  /** The provenance clause — «su chat, ayer 18:53». */
  readonly provenance: string;
  readonly disclosureLineId: string;
  readonly counterparty?: string;
  readonly entityId: string;
  /** Whether **Retirar** on this line would do anything (ADR-0004; FR-33). */
  readonly retractable: boolean;
  /**
   * ...and whether somebody already retracted it — a different fact, because
   * `retractable` is also false for a line that is not a fact and for one
   * whose window has shut.
   */
  readonly retracted: boolean;
  /**
   * What the rep said the line should read, when they corrected it on the
   * card (ticket #344) — their own words, kept beside the annotation. The
   * claim above stays as the aperture stored it.
   */
  readonly corrected?: string;
}

export interface TwinFeedRecordLinesPart {
  readonly kind: "record-lines";
  readonly disclosurePostId: string;
  readonly groups?: readonly {
    readonly counterparty: string;
    readonly indexes: readonly number[];
  }[];
  readonly lines: readonly TwinFeedRecordLine[];
  /**
   * When the correction window closes, as an ISO string — computed by the
   * lease holder under finalization's own rule, because rep-web can reach
   * neither `disclosure_posts` nor the rows that decide it (ADR-0010).
   *
   * ABSENT MEANS IT HAS NOT OPENED: no send of this post resolved `sent`, so
   * nothing will finalize and the lines stay correctable.
   */
  readonly windowClosesAt?: string;
  readonly acts: readonly TwinFeedAnswerAct[];
}

/**
 * What a rep has already answered — absent while the question is open
 * (ticket #255; boundary #225, F34).
 *
 * A CLOSED WORD AND NOT A BOOLEAN, because the two answers are not each
 * other's negation: a confirmed binding is a row in the entity mirror and a
 * decline is an act saying the twin proposed the wrong customer, and a surface
 * says a different thing about each.
 */
export type TwinFeedQuestionAnswer = "confirmed" | "declined";

/** A question, with the subject that names what its answer does. */
export interface TwinFeedQuestionPart {
  readonly kind: "question";
  readonly subject: "binding";
  readonly aboutEventId: string;
  readonly proposedName?: string;
  /**
   * What the rep answered, on EITHER surface — absent while it is open.
   *
   * An answered question offers no `acts`, so a surface drawing its buttons
   * from those draws none (the runtime's `readFeed` decides both together).
   */
  readonly answer?: TwinFeedQuestionAnswer;
  /**
   * WHICH CHAT IS BEING BOUND: its number, as the rep reads it in their own
   * phone (boundary #225, F35).
   *
   * THE DIGITS AND NEVER THE JID. A chat address on a page is a customer's
   * identity in the HTML, in the browser's history and in every log between
   * the two — ADR-0004's whole point — so what crosses is the number alone.
   * Absent for a chat the rail addresses by LID, which HAS no number to show.
   */
  readonly chatNumber?: string;
  /** ...and what the rep's phone calls it, where the directory holds a name. */
  readonly chatName?: string;
  readonly acts: readonly TwinFeedAnswerAct[];
}

/** The kinds of answer a question card takes (ticket #324; the runtime's `ASK_FIELD_KINDS`). */
export const TWIN_ASK_FIELD_KINDS = ["pick_one", "pick_many", "text", "date"] as const;

export type TwinAskFieldKind = (typeof TWIN_ASK_FIELD_KINDS)[number];

/** One typed answer field of a question card: its name, kind, label and options. */
export interface TwinFeedAskField {
  readonly name: string;
  readonly kind: TwinAskFieldKind;
  readonly label?: string;
  /** A pick's options: the value an answer carries and the label code rendered. */
  readonly options?: readonly { readonly value: string; readonly label: string }[];
}

/**
 * A RUN'S QUESTION TO THE REP (ticket #324; ADR-0044's `ask` part): the
 * twin's question, its customers as mentions, and its typed answer fields.
 * `acts` holds `answer` while the run waits on it, and nothing once it is
 * answered or the run has ended — the answer itself never crosses the wire.
 */
export interface TwinFeedAskPart {
  readonly kind: "ask";
  readonly question: string;
  readonly mentions?: readonly TwinFeedMention[];
  readonly fields: readonly TwinFeedAskField[];
  readonly acts: readonly TwinFeedAnswerAct[];
}

/**
 * A RUTINA THE TWIN PROPOSES (ticket #386; ADR-0044's `proposal` part): the
 * rutina's id the card's two acts name, its name, the twin's own sentence
 * about it with its customers as mentions, when it runs and its plan in the
 * words code rendered from the row and the steps — never a step's
 * instructions — and whether it changes a rutina the rep already has. `acts`
 * holds `activate` and `discard` while the rutina waits on the rep, and
 * nothing once it is active or gone.
 */
export interface TwinFeedProposalPart {
  readonly kind: "proposal";
  readonly automationId: string;
  readonly name: string;
  readonly sentence: string;
  readonly mentions?: readonly TwinFeedMention[];
  readonly when: string;
  readonly plan: readonly { readonly text: string; readonly depth: number }[];
  readonly replaces: boolean;
  readonly acts: readonly TwinFeedAnswerAct[];
}

/** An acknowledgement of what code DID, rendered from a tool's result. */
export interface TwinFeedReceiptPart {
  readonly kind: "receipt";
  readonly text: string;
  readonly acts: readonly TwinFeedAnswerAct[];
}

/**
 * THE TWO DOORS (ticket #261; spec #258 decision 2; CONTEXT.md *Door*;
 * ADR-0044 as amended).
 *
 * The two places a rep speaks to their twin unprompted: the WhatsApp self-chat
 * and the bar on every dashboard page. One twin, one memory, one focus — and **an
 * answer goes back through the door it came in**, which is what this word set
 * is FOR: a post carries which door asked, so the runtime knows whether to
 * mint a send and the dashboard knows whether to render it.
 *
 * A CLOSED SET IN THE SEAM, because it is a stored column
 * (`posts_asked_on_check`) as well as a wire value, and
 * `migration-vocabulary.test.ts` compares the two — so a door the code writes
 * that the store refuses is a red build rather than a constraint violation on
 * a post the rep was about to read. `@dito/execution`'s trigger names the same
 * two words as a literal union, because that package depends on nothing; the
 * runtime is the one package that imports both, and `feed-wire.test.ts` pins
 * them against each other there.
 */
export const DOORS = ["twin_thread", "dashboard"] as const;

export type Door = (typeof DOORS)[number];

/**
 * THE SENTENCE THAT ANNOUNCES THE POST, AND THAT NO CARD DRAWS (tickets
 * #262, #358; ADR-0044 as amended): the thread's knock about it, the
 * `post_knocks` row the feed opens beside the post's own parts.
 *
 * IT CROSSES THE WIRE BECAUSE THE WIRE IS THE POST, NOT THE CARD. The
 * projection names every field of every part by hand (`feedPageOnTheWire`), so
 * a kind held back here would be a part the runtime opens and the wire silently
 * loses — and `feed-wire.test.ts` exists to refuse exactly that. What renders
 * it is notify's push transport: the canvas's cards read no knock at all
 * (`lienzo/cards.tsx`). The one page that says one is Inicio while the
 * permission is due, where the first knocked-for hand-off's knock is the
 * twin's line over the permission card (ticket #269, `canvas-client.tsx`).
 */
export interface TwinFeedKnockPart {
  readonly kind: "knock";
  readonly text: string;
  readonly acts: readonly TwinFeedAnswerAct[];
}

/**
 * THE ARRIVAL POST'S LAYOUT (ticket #266; ADR-0044 as amended — the first part
 * rendered as layout rather than as content).
 *
 * Typed parameters the twin submitted, resolved by code to post ids of this
 * seat's own posts: which one is the spotlight and the order of the rest,
 * spotlight first. No surface draws it as words; the canvas draws its cards
 * in this order.
 */
export interface TwinFeedCurationPart {
  readonly kind: "curation";
  readonly spotlight?: string;
  readonly order: readonly string[];
  readonly acts: readonly TwinFeedAnswerAct[];
}

/**
 * A WORKSPACE DOCUMENT, BY ITS VERSION (ticket #326; ADR-0044's `document`
 * part): its title and version number as code read them, and the id a
 * surface opens it by through the runtime's own read
 * (`TWIN_API_ROUTES.document`). No path and no content cross here: the text
 * is sealed in the twin's bundle and only the lease holder opens it.
 */
export interface TwinFeedDocumentPart {
  readonly kind: "document";
  readonly documentId: string;
  readonly title: string;
  readonly version: number;
  readonly acts: readonly TwinFeedAnswerAct[];
}

/** One row of a list: the twin's line, its customers as mentions. */
export interface TwinFeedDataRow {
  readonly text: string;
  readonly mentions?: readonly TwinFeedMention[];
}

/**
 * TYPED DATA AS A LIST (ticket #326; spec #318 decision 34): a briefing's
 * lines, each a row whose customers link to their cards as a mention in
 * prose does. Tables and charts stay on the horizon.
 */
export interface TwinFeedDataPart {
  readonly kind: "data";
  readonly rows: readonly TwinFeedDataRow[];
  readonly acts: readonly TwinFeedAnswerAct[];
}

/**
 * ONE WORKSPACE DOCUMENT'S VERSION, OPENED (ticket #326): what
 * `TWIN_API_ROUTES.document` answers — the title code read and the text the
 * twin wrote, Markdown the page renders as text. Never the path.
 */
export interface TwinDocument {
  readonly documentId: string;
  readonly title: string;
  readonly version: number;
  readonly content: string;
}

/** One workspace document as Mi libreta lists it: its latest version, never its text (ticket #368). */
export interface TwinListedDocument {
  readonly documentId: string;
  readonly title: string;
  readonly version: number;
  /** When that version was written, as an ISO instant. */
  readonly writtenAt: string;
}

/** What `TWIN_API_ROUTES.documents` answers: every document, newest first. */
export interface TwinDocuments {
  readonly documents: readonly TwinListedDocument[];
}

/** One post, as a surface receives it. */
export interface TwinFeedPost {
  readonly id: string;
  /** When the twin composed it, as an ISO string — the order Inicio reads. */
  readonly at: string;
  /** The execution that composed it, or `null` where code did. */
  readonly executionId: string | null;
  readonly origin: "composed" | "reexpressed";
  /**
   * WHICH DOOR ASKED FOR IT — absent on a PROACTIVE post (ticket #261).
   *
   * A draft, a question, the day's record and a receipt for an act are
   * proactive: the twin cannot know where the rep is, so they go to both
   * surfaces and carry no door. An ANSWER carries the one it was asked
   * through, and Inicio renders only the answers asked at its own — a phone
   * question answered on the phone is not repeated here, which is the whole of
   * «an answer goes where it was asked» seen from a surface.
   *
   * ABSENT ALSO ON EVERY POST WRITTEN BEFORE THIS TICKET, and that is
   * ADR-0034's rule rather than a gap: a field nothing recorded is NOT
   * RECORDED THEN, never a default.
   */
  readonly askedOn?: Door;
  readonly parts: readonly TwinFeedPart[];
  /**
   * THE CUSTOMER A HAND-OFF IS ABOUT, by their reference — `c7` — on a draft
   * or a binding question (ticket #321). It is what a mention in the twin's
   * answer is matched against, so a name in the bar can lead to this card.
   */
  readonly customer?: string;
}

/** One page of it, and the keyset to ask for the next. */
export interface TwinFeedPage {
  readonly posts: readonly TwinFeedPost[];
  /** Pass it back as `cursor`; absent at the end of the feed. */
  readonly nextCursor?: string;
}

/**
 * ONE EXCHANGE AT THE DOOR: what the rep asked, and what the twin said back
 * (tickets #261 and #263; spec #258 decisions 4 and 13; CONTEXT.md
 * *Exchange*).
 *
 * NOT A TRANSCRIPT AND NOT A SESSION: a pair with no identity beyond the
 * message's own row, kept in the bar's history across days and paged back a
 * day at a time (`TwinExchanges`).
 */
export interface TwinExchange {
  /** The `dashboard_messages` row — what a reply names and what the stream's events carry. */
  readonly messageId: string;
  /** When the rep sent it, as an ISO string. */
  readonly at: string;
  /** The rep's own words, opened under the twin's key by the lease holder. */
  readonly text: string;
  /** The twin's reply, once it has landed. */
  readonly reply?: TwinFeedPost;
  /**
   * WHETHER THE TWIN IS STILL THINKING — absent means it is (ticket #261).
   *
   * Present and `true` once the turn over this message has ended. It is what
   * ends a wait the page resumed after a reload: a message that produced a
   * draft rather than a reply is settled exactly as an answered one is.
   *
   * AN EXCHANGE THE TWIN LEFT NOTHING FOR IS NOT HERE AT ALL (ticket #263):
   * it is not kept, so the read leaves it out altogether and the page learns
   * of it from the stream's `failed` event, or — with the stream down — from
   * its message no longer being in the read.
   */
  readonly settled?: true;
  /** Never on an exchange: what tells it from `TwinOwnLine`. */
  readonly line?: never;
}

/**
 * ONE LINE THE TWIN SAID AT THE DOOR ON ITS OWN (ticket #338; the UX spine's
 * row A: «everything Dito says stays in the thread»): the arrival line — the
 * morning's account or a return's — or a line a turn the seam's events woke
 * said unasked. Nobody asked it, so it carries no message, no rep's words and
 * no wait: the post is the whole entry, its own id and instant included.
 *
 * A MEMBER OF THE DAY'S UNION RATHER THAN A LIST BESIDE IT, because the day
 * reads in one order — the twin's morning line, the rep's question at nine,
 * the twin's cut-in at ten — and two lists would leave every reader to merge
 * them by instant. The exchange's own fields are `never` here, so a reader of
 * an exchange's fields reads them over either member — `text` and `reply` are
 * absent on a line — and `line` is what tells the two apart.
 */
export interface TwinOwnLine {
  /** The post, as the feed serves it: its id, its instant, its parts. */
  readonly line: TwinFeedPost;
  readonly messageId?: never;
  readonly at?: never;
  readonly text?: never;
  readonly reply?: never;
  readonly settled?: never;
}

/** One seat-local day of the history, oldest entry first (tickets #263, #338). */
export interface TwinExchangeDay {
  /** The calendar day in the seat's zone, `YYYY-MM-DD` (`isCalendarDay`). */
  readonly day: string;
  /** The rep's exchanges and the twin's own lines, in the order they happened. */
  readonly exchanges: readonly (TwinExchange | TwinOwnLine)[];
}

/**
 * A PAGE OF THE BAR'S HISTORY: the days that hold an exchange or a line of
 * the twin's own, newest page first, oldest day first within it (tickets #263,
 * #338; spec #258 decision 4).
 *
 * `today` IS THE SEAT'S DAY AT THE CALLER'S `now`, cut by the runtime in the
 * one zone every day here is cut in — so the page names «Hoy» and «Ayer» by
 * comparing dates, and never converts an instant to a day of its own.
 *
 * `nextUntil` IS THE CURSOR: the newest day of the page before this one,
 * passed back as `until`. A DAY AND NEVER A ROW ID, so a page and the read
 * cannot disagree about where one day ends — the read is the only thing that
 * ever decides which day a message is in. Absent when nothing older is kept.
 */
export interface TwinExchanges {
  readonly today: string;
  readonly days: readonly TwinExchangeDay[];
  readonly nextUntil?: string;
}

/**
 * THE REP NOTEPAD AS `/notepad` ANSWERS IT (ticket #264; ADR-0033 as amended).
 *
 * `text` IS THE CURRENT VERSION'S, possibly empty. An empty text and a
 * `writtenAt` of `null` is a twin nobody has taught anything; an empty text
 * WITH an instant is a notebook the rep cleared. *Mi libreta* renders both as
 * the same empty state, as the recipe renders both as the default line alone
 * (`readNotepad` argues why the store still tells them apart).
 */
export interface TwinNotepad {
  readonly text: string;
  /**
   * The current version's number — 0 when nothing was ever written. What a
   * save is based on (`TwinApiNotepadActRequest.basedOn`).
   */
  readonly version: number;
  /** When the current version was written, as an ISO string. */
  readonly writtenAt: string | null;
  /**
   * THE TWIN'S OWN WORKING MEMORY, beside the rep's notebook (ticket #322;
   * spec #318 decision 33): Mi libreta's second, read-only section.
   */
  readonly workingMemory: TwinWorkingMemory;
}

/**
 * THE TWIN'S WORKING MEMORY AS MI LIBRETA SHOWS IT (ticket #322): its prose,
 * its open matters, its version — 0 while it has written nothing — and when
 * the current version was written. Read-only: no act route writes it, and the
 * rep corrects it by telling the twin.
 */
export interface TwinWorkingMemory extends TwinOpenMatters {
  readonly text: string;
  readonly writtenAt: string | null;
}

/**
 * DITO'S OWN AUTOMATIONS, BY THE NAME THEIR ROW CARRIES (tickets #325, #364;
 * CONTEXT.md *Rutinas*): what fires on its own besides the rep's rutinas —
 * drafting on a customer's message, extraction and the daily disclosure on
 * the clock, the reminders on one-shot rows. Each is one row of `automations`
 * per seat, with the rep's switch, and `automations_shipped_check` holds
 * these words. The twin thread is not among them: it is the twin itself.
 */
export const SHIPPED_AUTOMATIONS = [
  "drafting",
  "extraction",
  "daily_disclosure",
  "reminders",
  "overnight_requests",
] as const;

export type ShippedAutomation = (typeof SHIPPED_AUTOMATIONS)[number];

/** Whether a word names one of Dito's own automations. */
export function isShippedAutomation(word: string): word is ShippedAutomation {
  return (SHIPPED_AUTOMATIONS as readonly string[]).includes(word);
}

/**
 * When one of Dito's automations fires, as its row types it: a cadence of the
 * seat's day, a seam event (drafting: a customer's message), or the one-shot
 * rows written as their subjects are born (the reminders). Rendered into copy
 * by code; never a sentence on the wire.
 */
export type TwinShippedWake =
  | { readonly kind: "schedule"; readonly every: "day"; readonly atHour: number }
  | { readonly kind: "trigger" }
  | { readonly kind: "once" };

/**
 * ONE OF DITO'S AUTOMATIONS AS RUTINAS SHOWS IT: its row, its name, its wake,
 * where its switch stands for this seat, and when it last fired. Its words are
 * the copy package's, keyed by `shipped`.
 */
export interface TwinShippedAutomation {
  readonly id: string;
  readonly origin: "dito";
  readonly shipped: ShippedAutomation;
  readonly wake: TwinShippedWake;
  readonly paused: boolean;
  readonly lastRun?: TwinRutinaRun;
  /** The next instant its cadence reaches — absent with no cadence, or while its switch is held. */
  readonly nextFiring?: TwinRutinaRun;
}

/**
 * THE SEAM EVENTS A RUTINA'S TRIGGER MAY NAME (ticket #325; spec #318
 * decision 28; ADR-0012: a wake predicate is metadata only), and the words
 * `automations_trigger_event_check` holds.
 *
 *   `customer_message` — a customer wrote, in a chat the twin may read; the
 *                        predicate may narrow it to one customer.
 *   `card_settled`     — a card on the canvas settled: sent, discarded,
 *                        answered.
 *
 * Both are events the consumer already handles in its pass; a rutina naming
 * any other is refused when it is written.
 */
export const RUTINA_TRIGGER_EVENTS = ["customer_message", "card_settled"] as const;

export type RutinaTriggerEvent = (typeof RUTINA_TRIGGER_EVENTS)[number];

/** FR-75's two states this build holds (`automations_state_check`). */
export const RUTINA_STATES = ["pending", "active"] as const;

export type RutinaState = (typeof RUTINA_STATES)[number];

/** Who asked for a rutina. */
export const RUTINA_ORIGINS = ["rep", "twin"] as const;

export type RutinaOrigin = (typeof RUTINA_ORIGINS)[number];

/** Whose an automation's row is (`automations_origin_check`): a rutina's asker, or Dito. */
export const AUTOMATION_ORIGINS = [...RUTINA_ORIGINS, "dito"] as const;

/**
 * When a rutina runs, as its row types it: a cadence of the seat's day — every
 * day, or every week on a set of ISO weekdays (1 = Monday), in ISO order — or
 * a seam event, with the customer it is about by the name the rep confirmed,
 * rendered by code.
 */
export type TwinRutinaWake =
  | {
      readonly kind: "schedule";
      readonly every: "day" | "week";
      readonly weekdays?: readonly number[];
      readonly atHour: number;
    }
  | { readonly kind: "trigger"; readonly event: RutinaTriggerEvent; readonly customer?: string };

/**
 * ONE STEP OF A RUTINA'S PLAN, AS CODE RENDERS IT FROM THE DEFINITION (ticket
 * #325; ADR-0044's `proposal` part): its kind, how deep inside a branch it
 * sits, and a wait's span or the card it waits on. Never the step's
 * instructions — those are the twin's words to itself — so the plan is the
 * structure and the twin's sentence is the meaning.
 */
export interface TwinPlanStep {
  readonly kind: TwinRunStepKind;
  readonly depth: number;
  readonly wait?:
    | {
        readonly after: {
          readonly days?: number;
          readonly hours?: number;
          readonly minutes?: number;
        };
      }
    | { readonly settle: true };
}

/**
 * ONE AUTOMATION THE TWIN AUTHORED, AS RUTINAS SHOWS IT (ticket #325; spec
 * #318 decisions 28–31): its name and its sentence in the twin's first
 * person, its wake,
 * its plan, who asked, its FR-75 state, where its switch stands, the active
 * version it would replace, and when it last fired a run.
 */
export interface TwinRutina {
  readonly id: string;
  readonly origin: RutinaOrigin;
  readonly state: RutinaState;
  /** The definition's name — what each run it fires is called on Trabajos en curso. */
  readonly name: string;
  /** The twin's own sentence — composed, never copy. */
  readonly sentence: string;
  readonly wake: TwinRutinaWake;
  readonly plan: readonly TwinPlanStep[];
  readonly paused: boolean;
  readonly replaces?: string;
  readonly lastRun?: TwinRutinaRun;
  /** The next instant its cadence reaches — absent on an event's wake, on a proposal, or while its switch is held. */
  readonly nextFiring?: TwinRutinaRun;
}

/** An instant a rutina fired at, or its cadence reaches next, and the seat-local day it falls on. */
export interface TwinRutinaRun {
  readonly at: string;
  readonly day: string;
}

/** One card on Rutinas: one of Dito's automations, or a rutina the twin authored. */
export type TwinAutomation = TwinShippedAutomation | TwinRutina;

/**
 * WHAT `/routines` ANSWERS: one list read off the seat's `automations` rows —
 * Dito's own first, in `SHIPPED_AUTOMATIONS`' order, then the rep's active
 * rutinas, newest first — a proposal is a card where the rep is, never a row
 * here (ticket #386) — and the seat-local today a `lastRun.day` is compared with:
 * the exchanges' rule, so the page never cuts a day with a zone of its own.
 */
export interface TwinRoutines {
  readonly today: string;
  readonly automations: readonly TwinAutomation[];
}

/**
 * A WORKFLOW RUN'S FIVE STATES (ticket #323; ADR-0012 as amended; the
 * design's §7.1), restated from the runtime because this package depends on nothing, and `runs_state_check` is swept against this list.
 */
export const TWIN_RUN_STATES = ["ready", "running", "waiting", "succeeded", "failed"] as const;

export type TwinRunState = (typeof TWIN_RUN_STATES)[number];

/**
 * The kinds of step a run's definition is made of, as `run_steps_kind_check`
 * holds them — decision 23's ten as amended 2026-10-06 (ticket #324).
 */
export const TWIN_RUN_STEP_KINDS = ["agent", "code", "act", "ask", "post", "wait", "each", "while", "end", "if"] as const;

export type TwinRunStepKind = (typeof TWIN_RUN_STEP_KINDS)[number];

/**
 * A step's state as Trabajos draws it: the checkpoint's four words, and
 * `pending` for a step the run has not reached — or, past a branch, never
 * will.
 */
export type TwinRunStepState = "pending" | "running" | "waiting" | "succeeded" | "failed";

/** One step of a run, as its list on demand draws it: a kind and a state, never what it said. */
export interface TwinRunStep {
  readonly kind: TwinRunStepKind;
  readonly state: TwinRunStepState;
}

/**
 * WHAT A WAITING RUN WAITS ON (ticket #368): the clock (a `wait` on an
 * instant or a span), a customer's reply (a `wait` on a reply, its deadline on
 * the clock too), a card's settle (a `wait` on a card, or a step that asked
 * and parked on its card), or the runs its `each` started, one per item. Read from the run's own rows; the still mark's
 * label says which, never the history fill's sentence.
 */
export const TWIN_RUN_AWAITS = ["clock", "reply", "card", "runs"] as const;

export type TwinRunAwait = (typeof TWIN_RUN_AWAITS)[number];

/**
 * THE RUN'S ONE DETAIL (ticket #323; spec #318 decision 25): where it
 * stands, as typed facts code renders into copy — the step it is at and how
 * many there are, and for a run waiting on the clock the instant it wakes.
 * Never a sentence on the wire.
 */
export interface TwinRunDetail {
  /** The step the run stands at, from 1 as the rep reads it. */
  readonly step: number;
  readonly of: number;
  readonly kind: TwinRunStepKind;
  /** When a run waiting on the clock wakes, as an ISO instant. */
  readonly until?: string;
  /** What a waiting run waits on (`TWIN_RUN_AWAITS`); absent on a run that is not waiting. */
  readonly awaits?: TwinRunAwait;
  /**
   * WHICH PASS OF A `while` THE RUN IS ON, when it stands inside one (ticket
   * #324), and the most it may make when the runtime can say.
   */
  readonly pass?: number;
  readonly passes?: number;
}

/**
 * ONE ROW OF TRABAJOS EN CURSO (ticket #323; ADR-0044's `run` part).
 *
 * `name` IS THE RUN'S OWN: an inline run carries the few words the twin gave
 * it when it started the run, read out of the run's sealed content by the
 * lease holder. `automation` is the definition's registry word — `inline`, or
 * a shipped run's name (#324).
 *
 * `day` IS THE SEAT-LOCAL DAY IT ENDED ON, cut by the runtime, for a run
 * that ended — the day of the history it is listed under.
 */
export interface TwinRun {
  readonly runId: string;
  /**
   * THE RUN WHOSE `each` STEP MADE THIS ONE (ticket #324): a child is drawn
   * under its parent, never as a row of its own.
   */
  readonly parentRunId?: string;
  readonly automation: string;
  readonly name: string;
  readonly state: TwinRunState;
  readonly paused: boolean;
  readonly cancelled: boolean;
  readonly detail: TwinRunDetail;
  readonly steps: readonly TwinRunStep[];
  /** As ISO strings. */
  readonly createdAt: string;
  readonly lastChangeAt: string;
  readonly endedAt?: string;
  readonly day?: string;
}

/**
 * How many days back a run that ended stays listed: the seven the dashboard
 * keeps, the acts log's own window.
 */
export const TWIN_API_RUNS_DAYS = TWIN_API_ACTS_LOG_DAYS;

/**
 * WHAT `/runs` ANSWERS: the runs still going, newest first, then the ones
 * that ended in the window, newest first — and the seat-local today a run's
 * `day` is compared with.
 */
export interface TwinRuns {
  readonly today: string;
  readonly runs: readonly TwinRun[];
}

/**
 * THE ACT WORDS OF THE ACTS LOG, a closed set (ticket #267; spec #258
 * decision 16; CONTEXT.md *Acts log*).
 *
 *   `sent`       — a customer send the rail acknowledged.
 *   `dismissed`  — a draft discarded, on either surface.
 *   `confirmed`  — a chat bound to a customer, on either surface.
 *   `declined`   — a binding question answered «otro cliente».
 *   `retracted`  — one line of a day's notes taken back.
 *   `reminded`   — a knock about a card about to lapse, pushed to the rep.
 *   `disclosed`  — the day's notes, posted.
 *
 * WORDS AND NEVER SENTENCES: rep-web says each in copy, act word first.
 */
export const TWIN_ACT_WORDS = [
  "sent",
  "dismissed",
  "confirmed",
  "declined",
  "retracted",
  "reminded",
  "disclosed",
  // «Listo»: the rep took a card with no act of its own off the canvas (ticket #368).
  "cleared",
] as const;

export type TwinActWord = (typeof TWIN_ACT_WORDS)[number];

/**
 * Where a line's subject can still be opened: a post that still waits on
 * Inicio, or a bound customer in Conexiones. Absent when the subject is
 * settled or gone — a sent draft, a retracted line.
 */
export type TwinActOpens = "inicio" | "conexiones";

/**
 * ONE LINE OF THE ACTS LOG.
 *
 * `name` IS WHO THE ACT WAS ABOUT as the twin's own post or the entity mirror
 * named them — absent where nothing named anybody (the day's notes, a
 * reminder about them). `line` and `notesDay` belong to a retraction alone:
 * the number the notes printed and the day those notes were about, which is
 * what the rep pressed Retirar on.
 */
export interface TwinLoggedAct {
  readonly act: TwinActWord;
  /** As an ISO string. */
  readonly at: string;
  readonly name?: string;
  readonly line?: number;
  readonly notesDay?: string;
  readonly opens?: TwinActOpens;
}

/**
 * WHAT `/acts-log` ANSWERS: one seat-local day, oldest act first.
 *
 * `back` IS THE DAY ANSWERED, after the clamp — a page that asked for more
 * than `TWIN_API_ACTS_LOG_DAYS` reads which day it got here. No line of the
 * twin's rides with the day: the page heads it with its name and date, and
 * never builds a heading out of the acts.
 */
export interface TwinActsLog {
  readonly today: string;
  readonly day: string;
  readonly back: number;
  readonly acts: readonly TwinLoggedAct[];
}

/**
 * Whether a host is loopback.
 *
 * ONE PREDICATE FOR BOTH SIDES OF THE WIRE, and the two spellings are why it
 * is a function rather than a set each side keeps. The runtime refuses to bind
 * anything but loopback and rep-web refuses to point at anything but
 * loopback — and `URL.hostname` brackets an IPv6 literal (`[::1]`) while
 * `server.listen` takes it bare (`::1`), so two hand-kept lists disagree about
 * the same address and one side lets through what the other refuses.
 */
export function isLoopbackHost(host: string): boolean {
  return (
    host === "127.0.0.1" ||
    host === "localhost" ||
    host === "::1" ||
    host === "[::1]"
  );
}

/**
 * The last thing the plane said about one twin's socket.
 *
 * ONE READ, TWO CALLERS, AND THAT IS THE POINT (ticket #221). The runtime's
 * local API answers this over HTTP so a page can tell whether the twin is
 * there at all, and rep-web reads it straight off the seam so Conexiones
 * renders the last known state with the runtime stopped. Two copies of the
 * query would be two chances to disagree about which row is latest and about
 * what an absent row means — so the statement lives here, in the package that
 * holds the seam's contracts, and both sides call it.
 *
 * ORDERED BY `id` AND NOT BY `occurred_at`, which is the plane's own emission
 * order (`rail_status_events_twin_id_id_idx`, …20260827100007: "consumers read
 * a twin's transitions in emission order"). Two transitions of one reconnect
 * can share a wall-clock instant, and the identity column breaks that tie the
 * same way for every reader.
 *
 * `detail` IS NOT SELECTED BY THIS STATEMENT, and that stays true now that a
 * page renders a credential (ticket #223). On a `qr` or `pairing_code` row it
 * is the live credential the plane generated, and the link page gets it from
 * the lease holder's own `/link` read — a DIFFERENT statement, in the runtime,
 * on the one path that may serve it. `dito_rep_web` holds no column privilege
 * on it at all (…20260907100040), so this query and that grant say one thing
 * twice: whatever rep-web reads off this table, it is not the credential.
 */
export async function readRailState(
  db: { query: RailQuery },
  twinId: string,
): Promise<{ status: RailStatus | null; at: Date | null }> {
  const rows = await db.query<{ status: RailStatus; occurred_at: Date }>(
    `SELECT status, occurred_at
       FROM rail_status_events
      WHERE twin_id = $1
      ORDER BY id DESC
      LIMIT 1`,
    [twinId],
  );
  const row = rows.rows[0];
  if (row === undefined) return { status: null, at: null };
  return { status: row.status, at: row.occurred_at };
}

/**
 * What `readRailState` needs of a connection, structurally.
 *
 * NARROWED TO ONE METHOD so this module needs no opinion about which client it
 * is handed: the runtime passes a pooled one it borrowed for a request, and
 * rep-web passes one it checked out and declared a company on. Naming only
 * `query` is what keeps `pg`'s own types out of this package's surface for a
 * function that is one statement.
 */
type RailQuery = <T extends { status: RailStatus; occurred_at: Date }>(
  sql: string,
  values: readonly unknown[],
) => Promise<{ rows: T[] }>;

/**
 * The standing link session's first credential row: when its window opened,
 * and where the session starts.
 *
 * ONE VALUE OR NONE, rather than two fields that can each be null: «a session
 * stands and I do not know when it opened» is not a state the rail can be in,
 * so it is not a state this shape can hold.
 */
export interface RailLinkSession {
  /** The instant ADR-0031's window is counted from. */
  readonly windowOpenedAt: Date;
  /** The row id the session starts at, so its credentials can be read. */
  readonly fromId: string;
}

/**
 * WHERE THIS TWIN'S LINK SESSION STARTS, or `null` if none stands (ticket
 * #241; boundary #225, F11).
 *
 * ONE STATEMENT, TWO CALLERS, exactly as `readRailState` is: the runtime reads
 * this session's credentials out of it, rep-web renders the countdown from it
 * with the runtime stopped, and a second copy of the predicate would be two
 * chances to disagree about which window a rep is inside.
 *
 * THE SESSION IS «EVERY CREDENTIAL ROW SINCE THE RAIL LAST DID SOMETHING
 * ELSE», which is the plane's own shape: a plane with no session opens one,
 * writes its QR rows and its code row into it, and writes `linked`, `dropped`
 * or `logged_out` when the session ends. So the last non-credential row is the
 * boundary, and the first credential row after it is when the rep's seconds
 * started (`RAIL_CREDENTIAL_STATUSES` argues the window itself).
 *
 * AN ANSWER HERE THEREFORE SAYS SOMETHING ABOUT THE LATEST ROW TOO: a session
 * stands only while the rail's newest row is a credential row, since a later
 * `linked`, `dropped` or `logged_out` row would be the new boundary. Read in
 * one snapshot with `readRailState` (`withReadSnapshot`), the two cannot
 * disagree about that, which is why neither caller re-checks it.
 *
 * ...AND A SILENCE LONGER THAN A WINDOW IS A SECOND BOUNDARY, which is the
 * other half of the predicate and not a defence in depth. `rail.HandleShutdown`
 * records `dropped` only from a LINKED rail, so a plane stopped inside a link
 * window leaves its credential rows behind with no boundary row after them —
 * and the next plane's session would then appear to start at the abandoned
 * one's first row, however long ago that was. That page is expired for ever
 * over a live QR, and «Generar otro» cannot clear it. A session's whole life is
 * ONE window, so no two credential rows inside one session can be further
 * apart than that: a bigger gap is a second session, and the run after the last
 * such gap is the one a rep is looking at.
 *
 * THE CUT IS A GAP BETWEEN ROWS AND NOT A DISTANCE FROM THE NEWEST ROW (Codex
 * r1). A cut-off measured back from whatever row is newest MOVES as the plane
 * writes: with an abandoned session's rows still inside it, the anchor slides
 * forward row by row, and a countdown that slides forward is a dead credential
 * shown as live — the failure this whole read exists to end, arriving from the
 * other side. A gap only ever appears once, so this anchor is stable, and it
 * can only be OLDER than the session's true start: the error is a window that
 * shuts early.
 *
 * ORDERED BY `id` AND NOT BY `occurred_at` (…20260827100007's own index): two
 * transitions of one reconnect can share a wall-clock instant, and the
 * identity column breaks that tie the same way for every reader.
 *
 * `detail` IS NOT SELECTED, which is what lets rep-web run this at all: its
 * grant is four columns and the credential is in none of them
 * (…20260907100040).
 */
export async function readLinkSession(
  db: { query: RailSessionQuery },
  twinId: string,
  /**
   * How long one session can last, in seconds — ADR-0031's window, which is a
   * constant each caller owns (`LINK_WINDOW_SECONDS` in rep-web). It is also
   * therefore the longest silence one session can contain, which is what the
   * statement cuts on.
   */
  windowSeconds: number,
): Promise<RailLinkSession | null> {
  const rows = await db.query<{ id: string; occurred_at: Date }>(
    `WITH credential AS (
       SELECT id, occurred_at,
              lag(occurred_at) OVER (ORDER BY id) AS previous_at
         FROM rail_status_events
        WHERE twin_id = $1
          AND status = ANY($2::text[])
          AND id > coalesce(
                (SELECT max(id) FROM rail_status_events
                  WHERE twin_id = $1 AND status <> ALL($2::text[])), 0)
     )
     SELECT id, occurred_at
       FROM credential
      WHERE previous_at IS NULL
         OR occurred_at - previous_at > $3::interval
      ORDER BY id DESC
      LIMIT 1`,
    [
      twinId,
      [...RAIL_CREDENTIAL_STATUSES],
      `${String(windowSeconds)} seconds`,
    ],
  );
  const row = rows.rows[0];
  if (row === undefined) return null;
  return { windowOpenedAt: row.occurred_at, fromId: row.id };
}

/** What `readLinkSession` needs of a connection — `RailQuery`'s rule, its row. */
type RailSessionQuery = <T extends { id: string; occurred_at: Date }>(
  sql: string,
  values: readonly unknown[],
) => Promise<{ rows: T[] }>;

/**
 * The pinned inbound envelope: plaintext metadata only — content stays inside
 * the DEK-encrypted payload (ADR-0008).
 */
export interface WaEventEnvelope {
  /** Rail identifier, e.g. "whatsapp". */
  source: string;
  /** The rail's own id for the event; (source, externalEventId) dedupes. */
  externalEventId: string;
  eventType: string;
  companyId: string;
  seatId: string;
  twinId: string;
  occurredAt: Date;
  /** DEK-encrypted content blob (encoding owned by @dito/crypto). */
  payloadEnc: Uint8Array;
}

/** An outbound command row as the plane's executor consumes it. */
export interface SendCommandRow {
  id: string;
  twinId: string;
  sendClass: SendClass;
  /** Destination JID. For system_send the plane enforces self-chat only, from live session identity (ADR-0006). */
  destination: string;
  /**
   * Reference to the content to send. The grammar is this seam's
   * contract, dereferenced and DEK-decrypted only inside the plane's
   * executor (ADR-0008): `draft:<uuid>` → drafts.content_enc for customer
   * sends; system sends use drafts.post_enc, falling back to content_enc
   * for drafts created before the post column (#30).
   * `notice:<uuid>` → notices.content_enc (twin-thread microcopy, #25).
   * A scheme the executor does not speak is refused loudly, never
   * guessed at — extending the grammar means upgrading both sides.
   */
  payloadRef: string;
  /** Required for customer_send (the recorded tap); null for system_send. */
  tapId: string | null;
  outcome: SendOutcome | null;
}

export {
  reconcileFr70,
  reconcileFr70At,
  type Fr70Report,
  type Fr70Violation,
} from "./fr70.js";

export {
  attemptSend,
  createSendLockWriter,
  deferRefusal,
  lockTwinForSend,
  CONSERVATIVE_DEV_PACING,
  TAP_MINTERS,
  type CustomerSendRequest,
  type CustomerSendResult,
  type PacingThresholds,
  type RefusalReason,
  type RefusalRecorder,
  type SendLockSessions,
  type SendLockWriter,
  type SendRefusal,
  type TapMinter,
} from "./send-lock.js";
