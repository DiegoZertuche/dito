/**
 * THE RUNTIME'S LOCAL API (ticket #221; spec #214 decision 5 and *The
 * runtime's local API, in detail*; ADR-0010, ADR-0008, ADR-0002).
 *
 * ADR-0010 says the lease holder is the only process that may open a twin's
 * bundle and that "dashboards are clients of that service's authenticated
 * API". This module is that service: an HTTP server the runtime carries,
 * bound to loopback, bearer-authenticated with a secret only rep-web holds,
 * every call scoped to one seat and to this runtime's own twin.
 *
 * ═══ THREE FENCES, IN THIS ORDER, AND THE ORDER IS THE POINT
 *
 *   1. THE BEARER, before anything is read. A request whose bearer is not
 *      rep-web's is refused without a query, without a seat lookup and
 *      without touching the database — so a wrong caller learns nothing at
 *      all, not even whether a seat exists. Compared in constant time: a
 *      byte-by-byte comparison of a secret leaks its prefix to anybody who
 *      can time a loopback request, and a process on the same laptop can.
 *
 *   2. THE SEAT, from a header rep-web fills from its session. The bearer
 *      says WHICH PROCESS is asking; this says WHICH REP it is asking for.
 *      Both are needed: rep-web serves many seats on one credential.
 *
 *   3. THE TWIN. A runtime serves ONE twin, and the seat's twin is read from
 *      the registry rather than taken from the request — so there is no
 *      parameter through which a caller could name another twin, and a seat
 *      belonging to a twin this runtime does not hold is refused before any
 *      read runs. That is the whole of "every call scoped to the session's
 *      seat and that seat's twin".
 *
 * ═══ LOOPBACK, AND NOT AS A CONVENIENCE
 *
 * The default host is `127.0.0.1` and a caller may narrow it and not widen
 * it: `bindHost` is refused unless it is a loopback address. The bearer is
 * the authority and the bind is the blast radius — a runtime listening on a
 * routable interface would put an unsealing service on a network whose other
 * occupants ADR-0002 says nothing about, with one shared secret between them
 * and the twin's whole feed.
 *
 * ═══ WHY THE RAIL IS SERVED HERE AS WELL AS READ FROM THE STORE
 *
 * rep-web holds a column-level SELECT on `rail_status_events` and Conexiones
 * renders the last known state from it directly, so the page works with this
 * server stopped (spec #214 story 8). This read is the OTHER half: it is how
 * «alcanzable» becomes a fact rather than an assumption. The page asks; an
 * answer means the twin is up, and a failure is the sentence that says it is
 * not. Two reads of one row, on purpose.
 *
 * ═══ ITS OWN CONNECTIONS, NEVER THE LOOP'S
 *
 * `TwinRuntimeDeps.db` is a single dedicated client for a loop that runs
 * sequentially, and `pg` queues per client — so a request served on it would
 * issue statements into whatever transaction the pass has open. This server
 * takes something it can check a session out of, exactly as `@dito/notify`
 * does and for a sibling reason, and holds one for the length of one request.
 *
 * ═══ A READ IS A REGISTRATION, AND SO IS AN ACT
 *
 * `HANDLERS` is a record from `TWIN_API_ROUTES`' own keys to a function of
 * (deps, db, scope, url): the rail, the feed, the link credential, the chat
 * directory, the day's exchanges, the rep notepad, the open matters, the
 * offers the rep spent today, the canvas, and Rutinas, the acts log and the
 * runs in flight. Each is one entry there
 * and one handler here; the fences, the refusals, the connection handling and
 * the serialization are written once, below, for all of them.
 *
 * The ACTS are the same shape with one difference: their answer is one closed
 * word, so an act is an entry in `TWIN_API_ACT_ROUTES`, a verb beside it, and
 * an arm in `dashboard-acts.ts`. What an act's BODY names depends on its
 * target, off the record both sides share: `actRequestOf` reads a post or a
 * directory row, and the notebook edit — whose body is the whole text and
 * whose answer may be one of its own refusals rather than a word — has its own
 * arm in `performAct` and its own reader, `notepadEditOf`.
 *
 * AND THERE IS A THIRD MAP, for the POSTs that are not acts:
 * `TWIN_API_ASK_ROUTES` holds the link ask, the door's message, the rep's
 * arrival, the seen-stamp's news, the offer the rep spent, the matter they
 * picked, the phrase they selected on a card and the card they summoned the
 * twin to — each performs nothing on
 * the rep's record and records no verb. What lives here is the method split,
 * the bounded body read and the parameter checks.
 *
 * AND A FOURTH, for the one GET that is not a read: `TWIN_API_STREAM_ROUTES`
 * holds the seat's event stream (ticket #263). It passes the same three fences
 * and then does what no other route does — gives its connection back BEFORE it
 * answers, and answers for as long as the page stays open, from the seat's
 * event bus rather than from a query (`serveStream` argues both).
 *
 * ═══ WHY AN ACT IS A POST AND A READ IS A GET
 *
 * An act writes, so it may not be a GET: a link preview, a mail scanner or a
 * prefetch would perform it (the same reason #221's email link splits its GET
 * from its POST). And a read may not be a POST, because the two maps are
 * looked up by method — which is what makes the wrong method `no_route` rather
 * than a sentence telling a caller which door exists.
 */
import { timingSafeEqual } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Dek } from "@dito/crypto";
import type { Bundle } from "@dito/bundle";
import {
  isLoopbackHost,
  isNotepadActRoute,
  isOwnId,
  isAutomationActRoute,
  isRunActRoute,
  isScopeActRoute,
  OFFER_SPENT_REASONS,
  readRailState,
  TWIN_API_ACT_ROUTES,
  TWIN_API_ASK_ROUTES,
  TWIN_API_BACK_PARAM,
  TWIN_API_ASK_TAKES_BODY,
  TWIN_API_CURSOR_PARAM,
  TWIN_API_KEEP_PARAM,
  TWIN_API_LIMIT_PARAM,
  TWIN_API_SEEN_MAX_IDS,
  TWIN_API_NOW_PARAM,
  TWIN_API_ROUTES,
  TWIN_API_SEAT_HEADER,
  TWIN_API_STREAM_ROUTES,
  TWIN_API_UNTIL_PARAM,
  daysBackOf,
  isCalendarDay,
  type DashboardNotepadActRoute,
  type SettleOutcome,
  type TwinApiActResult,
  type TwinApiActRoute,
  type TwinApiArrivalResult,
  type TwinApiAskRoute,
  type TwinApiPickRequest,
  type TwinApiPickResult,
  type TwinApiSelectRequest,
  type TwinApiSelectResult,
  type TwinApiSummonRequest,
  type TwinApiSummonResult,
  type TwinApiSeenResult,
  type TwinApiSpendRequest,
  type TwinApiSpendResult,
  type TwinApiMessageAbout,
  type TwinApiMessageResult,
  type TwinApiNotepadActResult,
  type TwinApiRefusal,
  type TwinApiRoute,
  type TwinApiStreamRoute,
  type TwinDocument,
  type TwinDocuments,
  type TwinNotepad,
  type TwinOfferSpendings,
  type TwinOpenMatters,
  type TwinRailState,
  type TwinRoutines,
  type TwinRuns,
  type TwinStreamEvent,
} from "@dito/seam";
import type pg from "pg";
import {
  performDashboardAct,
  performNotepadEdit,
  type DashboardActRequest,
} from "./dashboard-acts.js";
import { actsLogOnTheWire, readActsLog } from "./acts-log.js";
import { recordArrival } from "./arrival.js";
import { recordAsk } from "./rep-asks.js";
import { BLANK_KEY_PATTERN } from "./blanks.js";
import type { ThreadEventSink } from "./thread/events.js";
import { canvasOnTheWire, readCanvas, readOnCanvas, readWaiting } from "./canvas.js";
import { readChatDirectory } from "./directory.js";
import { writeDoorMessage } from "./door.js";
import { exchangesOnTheWire, readExchanges } from "./exchanges.js";
import { feedPageOnTheWire, readFeed, readPostsByIds, type FeedDeps } from "./feed.js";
import { askForPairingCode, readLinkForTwin } from "./link.js";
import { readOfferSpendings, recordOfferSpending } from "./offer-spendings.js";
import { readRutinas } from "./routines.js";
import { readRuns } from "./runs/read.js";
import { findPhrase } from "./selection.js";
import type { SeatEvents } from "./seat-events.js";
import {
  openMattersOnTheWire,
  workingMemoryOnTheWire,
  type MattersDeps,
} from "./working-memory.js";

/** Where a request's own connection comes from — a pool, never the loop's client. */
export interface LocalApiSessions {
  connect(): Promise<pg.PoolClient>;
}

/** What the API needs to serve one twin's reads. */
export interface LocalApiDeps {
  readonly db: LocalApiSessions;
  /** The one twin this runtime holds the lease for (ADR-0010). */
  readonly twinId: string;
  /** The key its parts are opened with. Held in memory, never on the wire. */
  readonly dek: Dek;
  /**
   * The shared secret rep-web presents.
   *
   * AN ENVIRONMENT VARIABLE ON BOTH SIDES, never a table and never a log. It
   * authenticates a PROCESS rather than a person, so there is nothing about
   * it a store would be the right home for — and a row holding it would be a
   * row whose reader can read every twin's feed.
   */
  readonly bearer: string;
  /** The rep's own zone, for the record lines' «hoy»/«ayer» clause. */
  readonly timeZone?: string;
  /**
   * WHAT AN ACT NEEDS ON TOP OF WHAT A READ NEEDS (ticket #224).
   *
   * A read opens sealed parts; an ACT writes — a dismissal row, the aperture's
   * retraction, a binding in the entity mirror — and then owes an account of
   * itself: a receipt post in the rep's own thread and one content-free chain
   * entry (ADR-0020). So the three things a write needs that a read does not
   * are here, and they are here as ONE OPTIONAL FIELD rather than three: the
   * acts either exist on a runtime or they do not, and a server holding two of
   * the three would be one whose acts fail halfway through the account they
   * owe.
   *
   * ABSENT MEANS THE ACTS ARE NOT SERVED, and every act path answers
   * `no_route` — which is honest rather than defensive: the seam suite starts
   * servers for the reads alone, and a runtime with no bundle open has no
   * binding to confirm. The notepad's read answers `no_route` there too,
   * because the notebook lives in that same bundle.
   */
  readonly acts?: LocalApiActDeps;
  /**
   * THE SEAT'S EVENT BUS THE STREAM READS FROM (ticket #263) — the same one
   * the runtime's consumer publishes to (`TwinRuntimeDeps.events`).
   *
   * ABSENT MEANS THE STREAM IS NOT SERVED, and its path answers `no_route`,
   * for `acts`' reason: a server started for the reads alone has nothing
   * publishing, and a stream that opened and stayed silent for ever would be a
   * page waiting on a reply no process is composing.
   */
  readonly events?: SeatEvents;
  /**
   * THE TWIN THREAD'S DAYS (ticket #319; spec #318 decision 11) — the same
   * registry the consumer pushes into (`TwinRuntimeDeps.threadSessions`). The
   * rep's own act settling a card and their seen-stamp are events in the
   * day's conversation, told here beside the seat's own publish; their
   * arrival, pick, selection and summons are rows the pass reads
   * (`rep-asks.ts`). Absent, the thread is told nothing from the dashboard.
   */
  readonly thread?: ThreadEventSink;
  /**
   * THE TWIN'S HARNESS DIRECTORY (ticket #323), where each workflow run's
   * sealed content lies — the runs read opens it for an inline run's name.
   * Absent, a run is listed by its state and its steps, with no name.
   */
  readonly harnessDirectory?: string;
}

/** The three things a write needs and a read does not. */
export interface LocalApiActDeps {
  /** The rep chain's key, for the one entry each execution owes (ADR-0020). */
  readonly hmacKey: Uint8Array;
  /**
   * The twin's bundle: the entity mirror a confirmed binding lands in
   * (ADR-0004), and the rep notepad *Mi libreta* reads and edits (ADR-0033).
   */
  readonly bundle: Bundle;
  /** The rep's own thread, where every receipt is posted (ADR-0006). */
  readonly selfChatJid: string;
}

export interface LocalApiOptions {
  /**
   * The port. `0` asks the operating system for a free one, which is what the
   * seam suite uses; the rig passes `DITO_TWIN_API_PORT`.
   */
  readonly port: number;
  /** Loopback, and a caller may narrow it and not widen it (see the header). */
  readonly bindHost?: string;
}

export interface LocalApi {
  /** The port it is actually listening on, which `0` makes worth reporting. */
  readonly port: number;
  close(): Promise<void>;
}

/** Which seat a request is for, and the twin and company the registry says it owns. */
interface RequestScope {
  readonly seatId: string;
  readonly twinId: string;
  /**
   * ...AND ITS COMPANY (ticket #224; ADR-0035: "the aperture never accepts a
   * company scope from the device"). A `dashboard_acts` row is seat-scoped
   * like every other piece of aperture infrastructure, so the company has to
   * come off the registry row beside the twin rather than from anything the
   * request carried.
   */
  readonly companyId: string;
}

/** One read: what it answers, given the scope its fences established. */
type LocalApiHandler = (
  deps: LocalApiDeps,
  db: pg.ClientBase,
  scope: RequestScope,
  url: URL,
) => Promise<unknown>;

/**
 * A refusal with the status that goes with it.
 *
 * A CLASS RATHER THAN A RETURN SHAPE, so a fence deep inside a handler
 * refuses the same way the outer ones do. The word is from the closed set, so
 * nothing a caller reads is a sentence anybody composed.
 */
class ApiRefusal extends Error {
  override readonly name = "ApiRefusal";
  constructor(
    readonly refusal: TwinApiRefusal,
    readonly status: number,
  ) {
    super(refusal);
  }
}

/**
 * The reads, by route key.
 *
 * KEYED ON `TWIN_API_ROUTES` SO A PATH CANNOT DRIFT FROM ITS HANDLER: the
 * type is `Record<TwinApiRoute, …>`, so adding a route to the shared contract
 * without a handler here is a type error rather than a 404 somebody finds on
 * the rig.
 */
const HANDLERS: Readonly<Record<TwinApiRoute, LocalApiHandler>> = {
  rail: readRailForScope,
  feed: readFeedPage,
  link: readLinkForScope,
  directory: readDirectoryForScope,
  exchanges: readExchangesForScope,
  notepad: readNotepadForScope,
  openMatters: readOpenMattersForScope,
  offerSpendings: readOfferSpendingsForScope,
  canvas: readCanvasForScope,
  routines: readRoutinesForScope,
  actsLog: readActsLogForScope,
  runs: readRunsForScope,
  document: readDocumentForScope,
  documents: readDocumentsForScope,
};

/**
 * Path → route key, built once from the contract both sides read — every
 * read but the document's, whose path carries its id (`documentRoute`).
 */
const ROUTE_OF_PATH = new Map<string, TwinApiRoute>(
  Object.entries(TWIN_API_ROUTES)
    .filter(([key]) => key !== "document")
    .map(([key, path]) => [path, key as TwinApiRoute]),
);

/** What a document's id looks like: the version's own uuid. */
const DOCUMENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** The document a `GET /documents/<id>` names, or nothing when the path is no such read. */
function documentRoute(url: URL): string | undefined {
  if (!url.pathname.startsWith(TWIN_API_ROUTES.document)) return undefined;
  const id = url.pathname.slice(TWIN_API_ROUTES.document.length);
  return DOCUMENT_ID.test(id) ? id : undefined;
}

/**
 * ...and the same for the ACTS, in their own map (ticket #224).
 *
 * TWO MAPS BECAUSE TWO METHODS. A read is a GET and an act is a POST, and
 * looking a path up in the map its method names is what makes «a POST to a
 * read's path» and «a GET to an act's» both `no_route` rather than a method
 * error — which is #221's decision 2 held to: a refusal that distinguished
 * them would map the surface for a caller the bearer already turned away.
 */
const ACT_OF_PATH = new Map<string, TwinApiActRoute>(
  Object.entries(TWIN_API_ACT_ROUTES).map(([key, path]) => [
    path,
    key as TwinApiActRoute,
  ]),
);

/**
 * ...AND A THIRD MAP FOR THE ONE POST THAT IS NOT AN ACT (ticket #223).
 *
 * The link ask is a POST because it WRITES — a `plane_requests` row — and it is
 * not an act because nobody chose a target: the number the code is generated
 * for is this runtime's own session identity. `TWIN_API_ASK_ROUTES` argues the
 * split in full; what it costs here is one more lookup on the POST path and one
 * more arm below, and what it buys is that `DASHBOARD_ACT_VERBS` holds no word
 * that no `dashboard_acts` row ever carries.
 */
const ASK_OF_PATH = new Map<string, TwinApiAskRoute>(
  Object.entries(TWIN_API_ASK_ROUTES).map(([key, path]) => [
    path,
    key as TwinApiAskRoute,
  ]),
);

/**
 * ...AND A FOURTH MAP FOR THE ONE GET THAT IS NOT A READ (ticket #263).
 *
 * Looked up by method like the other three, so a POST to the stream's path
 * is `no_route` exactly as a POST to a read's is — and it is a map of its own
 * because a stream is not a handler: `HANDLERS` is awaited, serialized and
 * ended, and this is none of those (`TWIN_API_STREAM_ROUTES` argues it).
 */
const STREAM_OF_PATH = new Map<string, TwinApiStreamRoute>(
  Object.entries(TWIN_API_STREAM_ROUTES).map(([key, path]) => [
    path,
    key as TwinApiStreamRoute,
  ]),
);

/**
 * How often an open stream says it is still there, in ms.
 *
 * A COMMENT LINE EVERY FIFTEEN SECONDS, which the browser's `EventSource`
 * ignores and every hop between here and it sees as traffic. Two things need
 * it: an idle proxy closes a connection that carries nothing for its own
 * timeout (commonly thirty to sixty seconds), and a socket whose far end went
 * away is only noticed by this side when a write fails — so a stream a page
 * abandoned is unsubscribed within one beat rather than whenever the next
 * reply happens to arrive.
 */
const STREAM_BEAT_MS = 15_000;

/**
 * How long the browser waits before it opens the stream again, in ms — sent
 * as the stream's own `retry:` field so the cadence is this server's rather
 * than each browser's default.
 */
const STREAM_RETRY_MS = 3_000;

/**
 * The most a request body may be, in bytes.
 *
 * THE LARGEST BODY IS A WHOLE NOTEBOOK (ticket #264): 1,500 characters at up
 * to four UTF-8 bytes each, or six for a character JSON escapes, is 9,000
 * bytes; the door's 2,000-character message is 12,000 by the same count. So
 * 16 KiB holds every body a caller may legitimately send, whatever the rep
 * typed, and is still a bound. Without one, a caller past the bearer could
 * hold a request open and stream for ever into the lease holder's memory, and
 * the bearer is a shared secret on a loopback port rather than a per-person
 * credential.
 */
const MAX_ACT_BODY_BYTES = 16_384;

/**
 * Starts the server and resolves once it is listening.
 *
 * IT REFUSES AN EMPTY BEARER AT START-UP rather than at the first request.
 * A server whose secret is the empty string authenticates every caller, and
 * it would come up looking healthy — the failure `instrumentation.ts` exists
 * to refuse on the other side of the same wire.
 */
export async function startLocalApi(
  deps: LocalApiDeps,
  options: LocalApiOptions,
): Promise<LocalApi> {
  if (deps.bearer.trim() === "") {
    throw new Error(
      "the twin runtime's local API needs a bearer secret — an empty one authenticates every caller on the loopback interface (ADR-0010; ticket #221)",
    );
  }
  const host = options.bindHost ?? "127.0.0.1";
  // ONE PREDICATE FOR BOTH SIDES (`isLoopbackHost` argues the two spellings):
  // rep-web refuses to POINT at a non-loopback API and this refuses to BIND
  // one, and two hand-kept lists would let one side through what the other
  // turns away.
  if (!isLoopbackHost(host)) {
    throw new Error(
      `the twin runtime's local API binds loopback only, not ${host} — the bearer is the authority and the bind is the blast radius, and this service can unseal a twin's whole feed (ADR-0002, ADR-0010)`,
    );
  }
  // EVERY OPEN STREAM, so closing the server can end them. `server.close`
  // waits for open connections to finish, and a stream never finishes on its
  // own — so without this, stopping the runtime would hang on every page left
  // open (ticket #263).
  const streams = new Set<http.ServerResponse>();
  const server = http.createServer((req, res) => {
    void serve(deps, streams, req, res);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  return {
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err === undefined ? resolve() : reject(err)));
        // DESTROYED RATHER THAN ENDED: an ended stream's socket still sits in
        // keep-alive until its own timeout, and the page reopens its stream
        // against whichever runtime answers next either way.
        for (const stream of streams) stream.destroy();
        // EVERY IDLE KEEP-ALIVE SOCKET IS CLOSED TOO. `server.close` stops
        // accepting and waits for open connections, and an HTTP client that
        // kept one alive would hold the runtime's shutdown open until its own
        // timeout — which on the rig is Ctrl-C that appears to hang.
        server.closeIdleConnections();
      }),
  };
}

/** One request, from the fences to the answer. */
async function serve(
  deps: LocalApiDeps,
  streams: Set<http.ServerResponse>,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  try {
    // FENCE 1, BEFORE ANYTHING IS READ (see the module header).
    if (!presentedOurBearer(deps.bearer, req.headers.authorization)) {
      throw new ApiRefusal("unauthorized", 401);
    }
    // THE METHOD DECIDES WHICH MAP THE PATH IS LOOKED UP IN. The reads are
    // GETs and the acts are POSTs, so a POST to a read's path and a GET to an
    // act's are both no route rather than a method error — #221's decision 2,
    // held to now that both kinds exist: a refusal that distinguished them
    // would map the surface for a caller the first fence already turned away.
    const asked = askedFor(deps, req);

    // FENCE 2. The seat is a header rather than a path segment because it is
    // not part of what is being asked for — it is who it is being asked for.
    const seatId = req.headers[TWIN_API_SEAT_HEADER];
    if (typeof seatId !== "string" || !isOwnId(seatId)) {
      throw new ApiRefusal("no_seat", 400);
    }

    // THE BODY IS READ BEFORE THE CONNECTION IS CHECKED OUT, which is the
    // order that matters on a pool of four: reading a request's bytes takes as
    // long as the caller takes to send them, and a checkout held across that
    // wait would let one slow client hold a connection the reads need.
    //
    // AN ASK READS ONE ONLY IF ITS ROUTE TAKES ONE, off the record both sides
    // share (`TWIN_API_ASK_TAKES_BODY`). The link ask takes none and that is
    // what it is — «generate a code for this runtime's own number» has no
    // parameters at all, so a body there would be a slot for a caller to put a
    // number in (`askForPairingCode` argues why there must not be one) — and
    // the door's message ask is the rep's words, which is nothing but a body.
    const body =
      asked.kind === "act" ||
      (asked.kind === "ask" && TWIN_API_ASK_TAKES_BODY[asked.ask])
        ? await readActBody(req)
        : undefined;

    if (asked.kind === "stream") {
      await serveStream(deps, streams, await fencedScope(deps, seatId), req, res);
      return;
    }

    const db = await deps.db.connect();
    try {
      // FENCE 3. Read, never taken: there is no parameter a twin could arrive
      // through, so a caller cannot name one.
      const scope = await scopeOf(deps, db, seatId);
      const answer =
        asked.kind === "read"
          ? await HANDLERS[asked.route](deps, db, scope, asked.url)
          : asked.kind === "ask"
            ? await performAsk(deps, db, scope, asked.ask, body)
            : await performAct(deps, db, scope, asked.act, body);
      const payload = JSON.stringify(answer);
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        // The answer is one twin's private state on a loopback port. Nothing
        // may keep a copy of it.
        "cache-control": "no-store",
      });
      res.end(payload);
    } finally {
      db.release();
    }
  } catch (error) {
    refuse(res, error);
  }
}

/**
 * FENCE 3 ON A CONNECTION OF ITS OWN, given back before anything else runs
 * (ticket #263).
 *
 * The stream is the one route that answers for longer than a request lasts,
 * and the pool is four: a connection held across an open stream would be one
 * the reads and the acts no longer have, and four open pages would take them
 * all. So the stream borrows one for the registry lookup alone and returns it
 * before its first byte — what it serves after that comes from the bus, which
 * needs no connection at all.
 */
async function fencedScope(
  deps: LocalApiDeps,
  seatId: string,
): Promise<RequestScope> {
  const db = await deps.db.connect();
  try {
    return await scopeOf(deps, db, seatId);
  } finally {
    db.release();
  }
}

/**
 * THE SEAT'S EVENT STREAM, ONCE ITS FENCES HAVE PASSED (ticket #263; spec
 * #258 decision 14).
 *
 * `text/event-stream`, one frame per event: its word as the SSE `event:`
 * name, the whole event as JSON in `data:`. Subscribed under the seat the
 * fences resolved — never one the request names — so what reaches this
 * socket is this seat's events and nobody else's (`seat-events.ts`).
 *
 * READ-ONLY: nothing is read from the request after its headers, and nothing
 * a caller sends can reach the bus.
 *
 * A CLOSED SOCKET UNSUBSCRIBES, and so does a failed write: `close` fires when
 * the page goes away, and the beat's write is what notices a far end that went
 * away without saying so.
 */
async function serveStream(
  deps: LocalApiDeps,
  streams: Set<http.ServerResponse>,
  scope: RequestScope,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  // `askedFor` REFUSES THE STREAM ON A RUNTIME WITH NO BUS, so this is only
  // reached with one — asserted rather than re-checked, `performAct`'s rule.
  const events = deps.events;
  if (events === undefined) throw new ApiRefusal("no_route", 404);
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    // `no-transform` AS WELL AS `no-store`: a proxy that compresses a response
    // buffers it until it has enough to compress, which for a stream is never.
    "cache-control": "no-store, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.write(`retry: ${String(STREAM_RETRY_MS)}\n\n`);
  streams.add(res);
  const send = (event: TwinStreamEvent): void => {
    res.write(`event: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`);
  };
  const unsubscribe = events.subscribe(scope.seatId, send);
  const beat = setInterval(() => {
    res.write(": beat\n\n");
  }, STREAM_BEAT_MS);
  beat.unref();
  const end = (): void => {
    clearInterval(beat);
    unsubscribe();
    streams.delete(res);
  };
  req.on("close", end);
  res.on("error", end);
  res.on("close", end);
}

/**
 * Whether the request presented rep-web's own bearer, in constant time.
 *
 * `timingSafeEqual` REFUSES A LENGTH MISMATCH by throwing, so the lengths are
 * compared first — which leaks the secret's LENGTH and nothing else, and that
 * is the standard trade every constant-time comparison makes. What it buys is
 * that no prefix of the secret is learnable from timing, which on a loopback
 * port with another process on the same laptop is a measurable channel rather
 * than a theoretical one.
 */
function presentedOurBearer(
  bearer: string,
  header: string | undefined,
): boolean {
  if (header === undefined) return false;
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return false;
  const presented = Buffer.from(header.slice(prefix.length), "utf8");
  const expected = Buffer.from(bearer, "utf8");
  if (presented.length !== expected.length) return false;
  return timingSafeEqual(presented, expected);
}

/**
 * The seat this request is for, and the refusal when its twin is not ours.
 *
 * READ FROM THE REGISTRY, WITH NO COMPANY IN THE QUERY. The runtime connects
 * as the schema owner and serves exactly one twin, so the tenant fence here
 * is the twin comparison rather than a company predicate: a seat of another
 * company necessarily owns another twin, and `seats_one_seat_per_twin` is
 * what makes that an equivalence rather than a hope.
 */
async function scopeOf(
  deps: LocalApiDeps,
  db: pg.ClientBase,
  seatId: string,
): Promise<RequestScope> {
  const rows = await db.query<{ twin_id: string; company_id: string }>(
    "SELECT twin_id, company_id FROM seats WHERE id = $1",
    [seatId],
  );
  const row = rows.rows[0];
  if (row === undefined) throw new ApiRefusal("unknown_seat", 403);
  if (row.twin_id !== deps.twinId) throw new ApiRefusal("wrong_twin", 403);
  return { seatId, twinId: row.twin_id, companyId: row.company_id };
}

/**
 * The latest rail transition for this runtime's twin.
 *
 * THE STATEMENT IS `@dito/seam`'s, and it is shared with rep-web on purpose:
 * the dashboard reads the same row straight off the store so Conexiones
 * renders with this server stopped, and two copies of the query would be two
 * chances to disagree about which row is latest. That module also argues why
 * `detail` is selected by neither caller.
 */
async function readRailForScope(
  _deps: LocalApiDeps,
  db: pg.ClientBase,
  scope: RequestScope,
): Promise<TwinRailState> {
  const state = await readRailState(db, scope.twinId);
  // AN INSTANT BECOMES AN ISO STRING HERE, because this is the wire and a
  // `Date` does not survive JSON (`TwinRailState` argues the shape, and why
  // no row is `null` rather than a good state).
  return {
    status: state.status,
    at: state.at === null ? null : state.at.toISOString(),
  };
}

/**
 * The same row, WITH the credential on it (ticket #223).
 *
 * A SECOND HANDLER AND NOT A PARAMETER ON THE FIRST, because the difference is
 * a COLUMN rep-web may never reach: `rail_status_events.detail` carries a live
 * pairing token, `dito_rep_web` holds no privilege on it, and `readRailState`
 * — which both sides call — selects it for neither. `link.ts` argues the read
 * in full, including why a `linked` row hands over nothing.
 */
async function readLinkForScope(
  _deps: LocalApiDeps,
  db: pg.ClientBase,
  scope: RequestScope,
): Promise<unknown> {
  return await readLinkForTwin({ db, twinId: scope.twinId, now: new Date() });
}

/**
 * The chat directory with its names opened under the twin's key (ticket #223).
 *
 * `now` IS NOT TAKEN AND IS NOT NEEDED, unlike the feed's: nothing in this
 * answer is relative — every instant is an ISO string the page renders in the
 * deployment's zone — so there is no sentence whose meaning depends on when
 * the page was drawn.
 */
async function readDirectoryForScope(
  deps: LocalApiDeps,
  db: pg.ClientBase,
  scope: RequestScope,
): Promise<unknown> {
  return await readChatDirectory({ db, twinId: scope.twinId, dek: deps.dek });
}

/**
 * The canvas's own read deps for a request — the bundle when the runtime
 * holds one, because a hand-off's customer is a reference only the bundle
 * knows (ticket #321).
 */
function feedDepsOf(deps: LocalApiDeps, db: pg.ClientBase, scope: RequestScope): FeedDeps {
  return {
    db,
    twinId: scope.twinId,
    dek: deps.dek,
    ...(deps.timeZone === undefined ? {} : { timeZone: deps.timeZone }),
    ...(deps.acts === undefined ? {} : { bundle: deps.acts.bundle }),
  };
}

/** One page of #220's feed, with its parts opened under the twin's key. */
async function readFeedPage(
  deps: LocalApiDeps,
  db: pg.ClientBase,
  scope: RequestScope,
  url: URL,
): Promise<unknown> {
  // «NOW» IS THE CALLER'S AND HAS NO DEFAULT (spec #214: "`now` supplied by
  // the caller"). A record line's provenance clause is relative — «hoy 10:20»
  // — so the instant a page renders at decides a sentence, and a server that
  // filled it in from its own clock would render the wrong day without
  // failing anything. The same rule `@dito/copy` holds for an `instant` slot.
  const now = callersNow(url);
  const limitParam = url.searchParams.get(TWIN_API_LIMIT_PARAM);
  const cursor = url.searchParams.get(TWIN_API_CURSOR_PARAM);
  let limit: number | undefined;
  if (limitParam !== null) {
    limit = Number.parseInt(limitParam, 10);
    if (!Number.isSafeInteger(limit)) throw new ApiRefusal("bad_request", 400);
  }
  try {
    const page = await readFeed(
      {
        db,
        twinId: scope.twinId,
        dek: deps.dek,
        ...(deps.timeZone === undefined ? {} : { timeZone: deps.timeZone }),
        // THE ACTS' OWN BUNDLE, HANDED TO A READ for one question (ticket
        // #255, F34): whether a binding question's chat is bound is the entity
        // mirror's answer and nothing else's, and it is what decides that an
        // answered card offers no buttons. A server serving the reads alone
        // has no bundle — and no binding to confirm either.
        ...(deps.acts === undefined ? {} : { bundle: deps.acts.bundle }),
      },
      {
        now,
        ...(limit === undefined ? {} : { limit }),
        ...(cursor === null ? {} : { cursor }),
      },
    );
    // EVERY NAME OPENS THE CARD THE TWIN WROTE BESIDE IT, while that card is on
    // the canvas at this read (tickets #321, #401; `linkToCanvas`).
    const onCanvas = await readOnCanvas(feedDepsOf(deps, db, scope), now);
    // EVERY INSTANT BECOMES AN ISO STRING HERE, exactly as the rail's one does
    // above — a `Date` does not survive JSON, and `TwinFeedPage` in
    // `@dito/seam` is the shape rep-web actually receives.
    return feedPageOnTheWire(page, onCanvas);
  } catch {
    // A LIMIT OUT OF RANGE AND A CURSOR THIS READ DID NOT MINT are the
    // caller's mistakes and `readFeed` refuses both by throwing. They come
    // back as `bad_request` with nothing of the message: the read's own
    // sentence names its cap and its cursor grammar, which is a map of the
    // store for whoever got past the bearer.
    throw new ApiRefusal("bad_request", 400);
  }
}

/**
 * WHAT ONE REQUEST IS ASKING FOR — a read with its URL, or an act.
 *
 * A UNION RATHER THAN FOUR INDEPENDENT OPTIONALS. `route`, `act`, `url` and
 * `body` are set in two combinations and never in any other, so four
 * `undefined`s would be a type saying «one of these is set» without saying
 * which — and the caller would assert three of them non-null to read either.
 * One discriminant says which, and no assertion is needed at all.
 */
type AskedFor =
  | { readonly kind: "read"; readonly route: TwinApiRoute; readonly url: URL }
  | { readonly kind: "act"; readonly act: TwinApiActRoute }
  | { readonly kind: "ask"; readonly ask: TwinApiAskRoute }
  | { readonly kind: "stream"; readonly stream: TwinApiStreamRoute };

/**
 * ...decided from the method and the path, or refused.
 *
 * AN ACT ON A RUNTIME THAT SERVES NO ACTS IS NO ROUTE, not an `unavailable`: a
 * server started for the reads alone has no key, no bundle and no thread to
 * post a receipt into, so the honest answer is that the door is not there
 * (`LocalApiActDeps` argues it).
 */
function askedFor(deps: LocalApiDeps, req: http.IncomingMessage): AskedFor {
  const url =
    req.url === undefined ? undefined : new URL(req.url, "http://127.0.0.1");
  if (url === undefined) throw new ApiRefusal("no_route", 404);
  if (req.method === "GET") {
    const route = ROUTE_OF_PATH.get(url.pathname) ?? (documentRoute(url) === undefined ? undefined : "document");
    if (route !== undefined) return { kind: "read", route, url };
    // THE STREAM IS NOT SERVED WITHOUT A BUS (`LocalApiDeps.events`): the door
    // is not there, which is `no_route` and nothing more.
    const stream = STREAM_OF_PATH.get(url.pathname);
    if (stream !== undefined && deps.events !== undefined) {
      return { kind: "stream", stream };
    }
    throw new ApiRefusal("no_route", 404);
  }
  if (req.method === "POST" && deps.acts !== undefined) {
    const act = ACT_OF_PATH.get(url.pathname);
    if (act !== undefined) return { kind: "act", act };
    // THE ASK NEEDS THE ACTS' OWN DEPENDENCIES ALL THE SAME, and it is behind
    // the same guard rather than in front of it — not because it uses the key
    // or the bundle (it uses neither) but because it needs `selfChatJid`, which
    // is the number the pairing code is generated for. A runtime started for
    // the reads alone has no self chat, so a link ask on it is honestly «the
    // door is not there» rather than an ask that would write a row with nobody's
    // number in it.
    const ask = ASK_OF_PATH.get(url.pathname);
    if (ask !== undefined) return { kind: "ask", ask };
  }
  throw new ApiRefusal("no_route", 404);
}

/**
 * ONE ACT, FROM THE REQUEST TO THE ANSWER (tickets #224 and #223).
 *
 * The whole of the act is `dashboard-acts.ts`': the act row, the gate, the
 * store logic the thread's tools share, the receipt post and the execution's
 * own pair. What is here is the WIRE — reading a body, refusing one this act
 * cannot take, and giving back the closed word the caller reads.
 *
 * THE TARGET IS WHAT THE ROUTE ACTS ON, and the route says which:
 * `DASHBOARD_ACT_TARGET_OF_ROUTE` is the record both sides read, so the body
 * shape a path accepts is not a second list somebody keeps in step. A caller
 * names the card or the directory row — never a draft, never a line id, never a
 * chat address (`TwinApiActRequest` argues it) — and the seat and company come
 * off the registry row rather than off the request, so an act can only ever be
 * performed on this runtime's own twin, for the seat rep-web authenticated.
 */
async function performAct(
  deps: LocalApiDeps,
  db: pg.ClientBase,
  scope: RequestScope,
  route: TwinApiActRoute,
  body: unknown,
): Promise<TwinApiActResult | TwinApiNotepadActResult> {
  // `askedFor` REFUSES AN ACT ON A RUNTIME THAT SERVES NONE, so this arm is
  // only reached with the three things a write needs — asserted rather than
  // re-checked, because a second refusal here would be an unreachable branch
  // pretending to be a guard.
  const acts = deps.acts;
  if (acts === undefined) throw new ApiRefusal("unavailable", 500);
  if (isNotepadActRoute(route)) {
    // ITS OWN ARM, because its answer is its own: a word, or one of its two
    // refusals (`TwinApiNotepadActResult`).
    return await performNotepadEdit(
      {
        db,
        dek: deps.dek,
        twinId: deps.twinId,
        hmacKey: acts.hmacKey,
        bundle: acts.bundle,
      },
      { companyId: scope.companyId, seatId: scope.seatId },
      notepadEditOf(body),
    );
  }
  const request = actRequestOf(route, body);
  const outcome = await performDashboardAct(
    {
      db,
      dek: deps.dek,
      twinId: deps.twinId,
      hmacKey: acts.hmacKey,
      bundle: acts.bundle,
      selfChatJid: acts.selfChatJid,
      ...(deps.harnessDirectory === undefined ? {} : { harnessDirectory: deps.harnessDirectory }),
      // AN ACT ON A RUTINA TELLS ITS OWN NEWS after it commits (ticket #386):
      // the proposal card it settled, or what the rep did to an active rutina.
      ...(deps.events === undefined ? {} : { events: deps.events }),
      ...(deps.thread === undefined ? {} : { thread: deps.thread }),
    },
    { companyId: scope.companyId, seatId: scope.seatId },
    request,
  );
  // THE CARD'S OUTCOME, TO THE SEAT, AFTER THE ACT COMMITTED (ticket #266;
  // spec #258 decision 14). `performDashboardAct` returns once its own
  // transaction has committed, so a page that hears this and re-reads finds
  // the store already saying it. Only an act that happened: `already` is a
  // second press whose first one was heard, and a refusal settled nothing.
  const settled = SETTLE_OF_ROUTE[route];
  if (outcome === "performed" && settled !== undefined && request.target === "post") {
    deps.events?.publish(scope.seatId, {
      kind: "settle",
      postId: request.postId,
      outcome: settled,
      ...(request.lineIndex === undefined ? {} : { lineIndex: request.lineIndex }),
    });
    // THE REP'S OWN ACT ON THE CARD — the one settle the wake list may wake
    // the thread for, when it is the card the curation spotlights.
    deps.thread?.raise(deps.twinId, {
      kind: "post.settled",
      postId: request.postId,
      outcome: settled,
      byRep: true,
    });
  }
  return { outcome };
}

/**
 * The word each card act settles its card with (ticket #266).
 *
 * THE SCOPE SWITCHES AND THE NOTEBOOK EDIT SETTLE NO CARD, so they have no
 * word: neither is an act on something the canvas draws.
 */
const SETTLE_OF_ROUTE: Readonly<Partial<Record<TwinApiActRoute, SettleOutcome>>> = {
  dismissDraft: "dismissed",
  confirmBinding: "confirmed",
  declineBinding: "declined",
  retractLine: "retracted",
  answerAsk: "answered",
  // «Listo» (ticket #368): the card leaves the page, and the thread hears the
  // rep put it away.
  clearCard: "cleared",
};

/**
 * ONE ASK, FROM THE REQUEST TO THE ANSWER (tickets #223 and #261).
 *
 * THE ASKS ANSWER DIFFERENT SHAPES, which is why the return type is the union
 * rather than the acts' word: an ask is not obliged to speak the acts'
 * vocabulary, only not to be an act (`TWIN_API_ASK_ROUTES` argues the split).
 * The link ask answers in the acts' words because the three things that can
 * happen to it are the three that word set already names; the door's message
 * ask answers with the id of the row it wrote, which is what a page follows to
 * its reply; the arrival answers what the page draws before any line lands;
 * the seen ask answers how many ids it published; the spend ask whether it
 * kept the mark; the pick ask whether it found the matter and told the thread,
 * the select ask whether the card carries the phrase and the thread was told,
 * and the summon ask whether the card waits and the thread was told.
 */
async function performAsk(
  deps: LocalApiDeps,
  db: pg.ClientBase,
  scope: RequestScope,
  route: TwinApiAskRoute,
  body: unknown,
): Promise<
  | TwinApiActResult
  | TwinApiMessageResult
  | TwinApiArrivalResult
  | TwinApiSeenResult
  | TwinApiSpendResult
  | TwinApiPickResult
  | TwinApiSelectResult
  | TwinApiSummonResult
> {
  const acts = deps.acts;
  if (acts === undefined) throw new ApiRefusal("unavailable", 500);
  if (route === "message") return await performDoorMessage(deps, db, scope, body);
  if (route === "arrival") return await performArrival(deps, db, scope);
  if (route === "seen") return publishSeen(deps, scope, body);
  if (route === "spend") return await performSpend(deps, db, scope, body);
  if (route === "pick") return await performPick(deps, db, scope, acts, body);
  if (route === "select") return await performSelect(deps, db, scope, acts, body);
  if (route === "summon") return await performSummon(deps, db, scope, acts, body);
  // THE LINK ASK TAKES NO BODY AND NO SCOPE PARAMETER — the number the code is
  // generated for is this runtime's own self chat, so there is nothing a
  // caller could supply and therefore nothing to validate. The whole of it is
  // `link.ts`': the lock, the two refusals and the one `plane_requests` row.
  const outcome = await askForPairingCode({
    db,
    twinId: deps.twinId,
    selfChatJid: acts.selfChatJid,
    // THE REQUEST'S OWN INSTANT, which is what decides whether an unsettled
    // ask is still live (`LINK_ASK_WINDOW_SECONDS`).
    now: new Date(),
  });
  return { outcome };
}

/**
 * THE DOOR'S MESSAGE, FROM THE REQUEST TO THE ROW (ticket #261).
 *
 * The whole of it is `door.ts`': the cap, the session fence and the sealed
 * row. What is here is the WIRE — checking the two fields into the shapes the
 * door takes, and flattening its three refusals into the one word a caller is
 * owed. `bad_request` for all three, deliberately: «your text was empty»,
 * «your text was too long» and «that session is not yours» are three facts a
 * composer already knows or must never learn, and telling them apart would map
 * the store for whoever got past the bearer (#221's decision 2).
 */
async function performDoorMessage(
  deps: LocalApiDeps,
  db: pg.ClientBase,
  scope: RequestScope,
  body: unknown,
): Promise<TwinApiMessageResult> {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new ApiRefusal("bad_request", 400);
  }
  const given = body as Record<string, unknown>;
  const text = given["text"];
  const sessionId = given["sessionId"];
  if (typeof text !== "string" || typeof sessionId !== "string") {
    throw new ApiRefusal("bad_request", 400);
  }
  const about = given["about"] === undefined ? undefined : messageAboutOf(given["about"]);
  const written = await writeDoorMessage(
    { db, dek: deps.dek, twinId: deps.twinId },
    { companyId: scope.companyId, seatId: scope.seatId },
    // THE REQUEST'S OWN INSTANT, which a reference's window is read against.
    { text, sessionId, now: new Date(), ...(about === undefined ? {} : { about }) },
  );
  if (!written.ok) throw new ApiRefusal("bad_request", 400);
  return { messageId: written.messageId };
}

/**
 * What a door message points at, checked into its shape: a post id and a
 * printed line number (ticket #344), or a post id and a blank's key (ticket
 * #342) — one or the other, whole, or the request is refused. Whether the card
 * carries that line or that blank is `door.ts`' to ask of the store.
 */
function messageAboutOf(value: unknown): TwinApiMessageAbout {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiRefusal("bad_request", 400);
  }
  const about = value as Record<string, unknown>;
  const postId = about["postId"];
  if (typeof postId !== "string" || !isOwnId(postId)) {
    throw new ApiRefusal("bad_request", 400);
  }
  if (about["kind"] === "line") {
    const lineIndex = about["lineIndex"];
    if (typeof lineIndex !== "number" || !Number.isSafeInteger(lineIndex) || lineIndex < 1) {
      throw new ApiRefusal("bad_request", 400);
    }
    return { kind: "line", postId, lineIndex };
  }
  if (about["kind"] === "blank") {
    const key = about["key"];
    if (typeof key !== "string" || !BLANK_KEY_PATTERN.test(key)) {
      throw new ApiRefusal("bad_request", 400);
    }
    return { kind: "blank", postId, key };
  }
  throw new ApiRefusal("bad_request", 400);
}

/**
 * THE REP ARRIVED ON INICIO (ticket #266; spec #258 decision 15).
 *
 * The whole of the record and its throttle is `arrival.ts`'; the turn that
 * greets the rep is the consumer's next pass, which reads the row
 * (`rep-asks.ts`, ticket #358). What is here is the ANSWER: whether this ask woke
 * anything, and what the page holds before any line lands — two typed facts
 * about what waits and the last line's id — read from the canvas read the page
 * itself would make, so the facts and the canvas cannot disagree.
 *
 * THE INSTANT IS THIS PROCESS'S CLOCK AT THE ASK, never a parameter: the ask
 * takes no body at all (`TWIN_API_ASK_TAKES_BODY`), because the throttle and
 * the day both rest on the instant and a caller's clock is the one input here
 * somebody could move.
 */
async function performArrival(
  deps: LocalApiDeps,
  db: pg.ClientBase,
  scope: RequestScope,
): Promise<TwinApiArrivalResult> {
  const timeZone = zoneOf(deps);
  const now = new Date();
  const recorded = await recordArrival(
    { db, twinId: scope.twinId, timeZone },
    { companyId: scope.companyId, seatId: scope.seatId },
    now,
  );
  const canvas = await readCanvas(
    {
      db,
      twinId: scope.twinId,
      dek: deps.dek,
      timeZone,
      ...(deps.acts === undefined ? {} : { bundle: deps.acts.bundle }),
    },
    { seatId: scope.seatId, now },
  );
  return {
    woke: recorded.woke,
    ...(recorded.woke
      ? { arrivalId: recorded.arrivalId, visit: recorded.visit }
      : { arrivalId: recorded.keptArrivalId }),
    facts: canvas.facts,
    ...(canvas.arrival === undefined ? {} : { lastLineId: canvas.arrival.postId }),
  };
}

/**
 * THE SEAT'S SEEN-STAMP MOVED, TO ITS OWN STREAM (ticket #266; spec #258
 * decision 14).
 *
 * rep-web writes the stamp on Inicio's read and then asks this; it performs
 * nothing on any store — the ids go to the seat the fences resolved and to no
 * other, and nothing is read. They are checked into ids and bounded, so what a
 * caller past the bearer can put down the stream is a list of opaque ids to
 * the seat it authenticated as.
 */
function publishSeen(
  deps: LocalApiDeps,
  scope: RequestScope,
  body: unknown,
): TwinApiSeenResult {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new ApiRefusal("bad_request", 400);
  }
  const postIds = (body as Record<string, unknown>)["postIds"];
  if (
    !Array.isArray(postIds) ||
    postIds.length === 0 ||
    postIds.length > TWIN_API_SEEN_MAX_IDS ||
    postIds.some((id) => typeof id !== "string" || !isOwnId(id))
  ) {
    throw new ApiRefusal("bad_request", 400);
  }
  // THE THREAD HEARS EACH ONE (ticket #319), whether or not a page is
  // listening: what the rep has looked at is part of their day, and it only
  // appends.
  for (const postId of postIds as string[]) {
    deps.thread?.raise(deps.twinId, { kind: "post.seen", postId });
  }
  if (deps.events === undefined) return { published: 0 };
  deps.events.publish(scope.seatId, {
    kind: "seen",
    postIds: postIds as string[],
  });
  return { published: postIds.length };
}

/**
 * THE REP SPENT AN OFFER (ticket #335): the mark, kept for the seat-local day.
 *
 * THE INSTANT IS THIS PROCESS'S CLOCK, the arrival's rule: the day the mark
 * belongs to rests on it. The body is checked into its three fields here;
 * whether the offer is one the twin makes is `offer-spendings.ts`' to answer.
 */
async function performSpend(
  deps: LocalApiDeps,
  db: pg.ClientBase,
  scope: RequestScope,
  body: unknown,
): Promise<TwinApiSpendResult> {
  const spending = spendingOf(body);
  const spent = await recordOfferSpending(
    { db, twinId: scope.twinId, dek: deps.dek, timeZone: zoneOf(deps) },
    { companyId: scope.companyId, seatId: scope.seatId },
    spending,
    new Date(),
  );
  return { spent };
}

/**
 * THE REP PICKED ONE OF THE TWIN'S OPEN MATTERS (ticket #335): the twin thread
 * is told, and its turn resumes the matter in the twin's own words.
 *
 * THE MATTER IS FOUND AMONG THE TWIN'S CURRENT NOTES, by what it is about and
 * its label as `/open-matters` served it; the thread is told the label the
 * notes hold, so the words the event carries are always the twin's own. A pick
 * of a matter the twin has since closed or rewritten finds nothing, tells
 * nothing, and answers so. THE PICK IS A ROW (ticket #358; `rep-asks.ts`),
 * never a message in the rep's name: the pass reads it and wakes the thread,
 * so a restart before the turn loses nothing.
 */
async function performPick(
  deps: LocalApiDeps,
  db: pg.ClientBase,
  scope: RequestScope,
  acts: LocalApiActDeps,
  body: unknown,
): Promise<TwinApiPickResult> {
  const pick = pickOf(body);
  const memory = acts.bundle.readWorkingMemory();
  const served = await openMattersOnTheWire(mattersDepsOf(deps, db, scope, acts), memory);
  const at = served.matters.findIndex(
    (matter) =>
      matter.about.kind === pick.about.kind &&
      matter.about.id === pick.about.id &&
      matter.label === pick.label,
  );
  const held = at === -1 ? undefined : memory?.matters[at];
  if (held === undefined) return { picked: false };
  await recordAsk({ db, twinId: scope.twinId, dek: deps.dek }, scope, {
    kind: "matter.picked",
    about: { kind: held.about.kind, id: held.about.id },
    label: held.label,
    pickId: pick.pickId,
    seatId: scope.seatId,
  });
  return { picked: true };
}

/** The pick ask's body: the page's id for it, and the matter as it was served — or a bad request. */
function pickOf(body: unknown): TwinApiPickRequest {
  const given = fieldsOf(body);
  const pickId = given["pickId"];
  const label = given["label"];
  if (typeof pickId !== "string" || !isOwnId(pickId) || typeof label !== "string" || label === "") {
    throw new ApiRefusal("bad_request", 400);
  }
  const about = fieldsOf(given["about"]);
  const kind = about["kind"];
  const id = about["id"];
  if ((kind !== "entity" && kind !== "post") || typeof id !== "string" || !isOwnId(id)) {
    throw new ApiRefusal("bad_request", 400);
  }
  return { pickId, about: { kind, id }, label };
}

/**
 * THE REP SELECTED A PHRASE ON ONE OF THE TWIN'S CARDS (ticket #341): the twin
 * thread is told, and its turn explains the phrase in the twin's own words.
 *
 * THE PHRASE IS FOUND AMONG THE CARD'S OWN WORDS (`selection.ts`), and the
 * thread is told it as the twin wrote it there; a phrase the card does not
 * show, or a card that is not this twin's, tells nothing and answers so. A
 * row, as the pick is.
 */
async function performSelect(
  deps: LocalApiDeps,
  db: pg.ClientBase,
  scope: RequestScope,
  acts: LocalApiActDeps,
  body: unknown,
): Promise<TwinApiSelectResult> {
  const selection = selectionOf(body);
  const feed = { db, twinId: scope.twinId, dek: deps.dek, timeZone: zoneOf(deps), bundle: acts.bundle };
  const post = (await readPostsByIds(feed, [selection.postId], new Date())).get(selection.postId);
  const found = post === undefined ? undefined : findPhrase(post, selection.phrase);
  if (found === undefined) return { selected: false };
  await recordAsk({ db, twinId: scope.twinId, dek: deps.dek }, scope, {
    kind: "selection",
    postId: selection.postId,
    phrase: found,
    selectionId: selection.selectionId,
    seatId: scope.seatId,
  });
  return { selected: true };
}

/** The select ask's body: the page's id for it, the card, and words to look for — or a bad request. */
function selectionOf(body: unknown): TwinApiSelectRequest {
  const given = fieldsOf(body);
  const selectionId = given["selectionId"];
  const postId = given["postId"];
  const phrase = given["phrase"];
  if (
    typeof selectionId !== "string" ||
    !isOwnId(selectionId) ||
    typeof postId !== "string" ||
    !isOwnId(postId) ||
    typeof phrase !== "string" ||
    phrase.trim() === ""
  ) {
    throw new ApiRefusal("bad_request", 400);
  }
  return { selectionId, postId, phrase };
}

/**
 * THE REP SUMMONED THE TWIN TO A CARD (ticket #340; the spine's movement 6,
 * «Ven conmigo»): the twin thread is told which, and its turn may say one
 * sentence there.
 *
 * ONLY A CARD OF THIS TWIN'S THAT WAITS — what the canvas draws — tells the
 * thread; any other answers so and tells nothing. A row, as the pick is.
 */
async function performSummon(
  deps: LocalApiDeps,
  db: pg.ClientBase,
  scope: RequestScope,
  acts: LocalApiActDeps,
  body: unknown,
): Promise<TwinApiSummonResult> {
  const summons = summonsOf(body);
  const feed = { db, twinId: scope.twinId, dek: deps.dek, timeZone: zoneOf(deps), bundle: acts.bundle };
  const waiting = await readWaiting(feed, new Date());
  if (!waiting.some((post) => post.id === summons.postId)) return { summoned: false };
  await recordAsk({ db, twinId: scope.twinId, dek: deps.dek }, scope, {
    kind: "summons",
    postId: summons.postId,
    summonsId: summons.summonsId,
    seatId: scope.seatId,
  });
  return { summoned: true };
}

/** The summon ask's body: the page's id for the landing and the card — or a bad request. */
function summonsOf(body: unknown): TwinApiSummonRequest {
  const given = fieldsOf(body);
  const summonsId = given["summonsId"];
  const postId = given["postId"];
  if (typeof summonsId !== "string" || !isOwnId(summonsId) || typeof postId !== "string" || !isOwnId(postId)) {
    throw new ApiRefusal("bad_request", 400);
  }
  return { summonsId, postId };
}

/** A body that is one JSON object, as its fields — or a bad request. */
function fieldsOf(body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new ApiRefusal("bad_request", 400);
  }
  return body as Record<string, unknown>;
}

/**
 * The spend ask's body: a card's id, the sentence, and a reason from the
 * closed set — or a bad request. The sentence's length is the body's bound.
 */
function spendingOf(body: unknown): TwinApiSpendRequest {
  const given = fieldsOf(body);
  const postId = given["postId"];
  const sentence = given["sentence"];
  const reason = given["reason"];
  if (
    typeof postId !== "string" ||
    !isOwnId(postId) ||
    typeof sentence !== "string" ||
    sentence === "" ||
    typeof reason !== "string" ||
    !(OFFER_SPENT_REASONS as readonly string[]).includes(reason)
  ) {
    throw new ApiRefusal("bad_request", 400);
  }
  return { postId, sentence, reason: reason as TwinApiSpendRequest["reason"] };
}

/**
 * THE OFFERS THE REP SPENT TODAY (ticket #335), for the bar to keep down.
 *
 * «NOW» IS THE CALLER'S AND HAS NO DEFAULT, the exchanges' rule: which day is
 * «today» is the reader's.
 */
async function readOfferSpendingsForScope(
  deps: LocalApiDeps,
  db: pg.ClientBase,
  scope: RequestScope,
  url: URL,
): Promise<TwinOfferSpendings> {
  return await readOfferSpendings(
    { db, twinId: scope.twinId, dek: deps.dek, timeZone: zoneOf(deps) },
    scope.seatId,
    callersNow(url),
  );
}

/** The seat's zone: the runtime's configured one, else this process's. */
function zoneOf(deps: LocalApiDeps): string {
  return deps.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * WHAT WAITS ON THE REP, AND THE TWIN'S LAST WORD ABOUT IT (ticket #266).
 *
 * «NOW» IS THE CALLER'S AND HAS NO DEFAULT, the feed's rule: a notes card's
 * provenance clause is relative. `keep` is refused as a bad request when it is
 * not an id, before it reaches a query; `readCanvas` decides whether it is a
 * post this twin holds and the canvas draws.
 */
async function readCanvasForScope(
  deps: LocalApiDeps,
  db: pg.ClientBase,
  scope: RequestScope,
  url: URL,
): Promise<unknown> {
  const now = callersNow(url);
  const keep = url.searchParams.get(TWIN_API_KEEP_PARAM);
  if (keep !== null && !isOwnId(keep)) throw new ApiRefusal("bad_request", 400);
  const canvas = await readCanvas(
    {
      db,
      twinId: scope.twinId,
      dek: deps.dek,
      ...(deps.timeZone === undefined ? {} : { timeZone: deps.timeZone }),
      ...(deps.acts === undefined ? {} : { bundle: deps.acts.bundle }),
    },
    { seatId: scope.seatId, now, ...(keep === null ? {} : { keep }) },
  );
  return canvasOnTheWire(canvas);
}

/**
 * RUTINAS FOR THE SEAT THIS REQUEST AUTHENTICATED AS (tickets #267, #325).
 *
 * «NOW» IS THE CALLER'S AND HAS NO DEFAULT, the exchanges' rule: a last run's
 * «hoy» or «ayer» is a statement about the reader's day. The acts' bundle is
 * where the rutinas' words are, so a server started for the reads alone lists
 * Dito's own and no rutina.
 */
async function readRoutinesForScope(
  deps: LocalApiDeps,
  db: pg.ClientBase,
  scope: RequestScope,
  url: URL,
): Promise<TwinRoutines> {
  return await readRutinas(
    {
      db,
      twinId: scope.twinId,
      ...(deps.timeZone === undefined ? {} : { timeZone: deps.timeZone }),
      ...(deps.acts === undefined ? {} : { bundle: deps.acts.bundle, selfChatJid: deps.acts.selfChatJid }),
    },
    callersNow(url),
  );
}

/**
 * ONE DAY OF THE ACTS LOG (ticket #267; spec #258 decision 16).
 *
 * `back` IS A WHOLE NUMBER OF DAYS OR A BAD REQUEST, refused before it reaches
 * a query; a number past the seven the dashboard keeps is CLAMPED rather than
 * refused (`daysBackOf`, the rule rep-web reads by too), so a URL asking for
 * day eight is answered day seven and never an older row. The bundle is the
 * acts' own, for the one act only the entity mirror records — a confirmed
 * binding.
 */
async function readActsLogForScope(
  deps: LocalApiDeps,
  db: pg.ClientBase,
  scope: RequestScope,
  url: URL,
): Promise<unknown> {
  const now = callersNow(url);
  const back = daysBackOf(url.searchParams.get(TWIN_API_BACK_PARAM));
  if (back === undefined) throw new ApiRefusal("bad_request", 400);
  const log = await readActsLog(
    {
      db,
      twinId: scope.twinId,
      dek: deps.dek,
      ...(deps.timeZone === undefined ? {} : { timeZone: deps.timeZone }),
      ...(deps.acts === undefined ? {} : { bundle: deps.acts.bundle }),
    },
    { seatId: scope.seatId, now, back },
  );
  return actsLogOnTheWire(log);
}

/**
 * TRABAJOS EN CURSO'S RUNS (ticket #323): every run going and every one that
 * ended in the window, read under this twin. The bundle names a run's
 * customers when the server holds it.
 */
async function readRunsForScope(
  deps: LocalApiDeps,
  db: pg.ClientBase,
  scope: RequestScope,
  url: URL,
): Promise<TwinRuns> {
  if (deps.harnessDirectory === undefined) throw new ApiRefusal("no_route", 404);
  return await readRuns(
    {
      db,
      twinId: scope.twinId,
      dek: deps.dek,
      harnessDirectory: deps.harnessDirectory,
      ...(deps.acts === undefined ? {} : { bundle: deps.acts.bundle, selfChatJid: deps.acts.selfChatJid }),
      ...(deps.timeZone === undefined ? {} : { timeZone: deps.timeZone }),
    },
    callersNow(url),
  );
}

/**
 * The caller's instant, from `now` — or a bad request, since a read that cuts
 * days takes no default from this server's clock (the feed's rule).
 */
function callersNow(url: URL): Date {
  const nowParam = url.searchParams.get(TWIN_API_NOW_PARAM);
  const now = nowParam === null ? undefined : new Date(nowParam);
  if (now === undefined || Number.isNaN(now.getTime())) {
    throw new ApiRefusal("bad_request", 400);
  }
  return now;
}

/**
 * ONE PAGE OF THE BAR'S HISTORY, for the seat this request authenticated as
 * (tickets #261 and #263).
 *
 * «NOW» IS THE CALLER'S AND HAS NO DEFAULT, exactly as the feed's is: which
 * day is «today» is a statement about the reader's own day, so a server
 * filling the instant in from its own clock would cut the wrong day without
 * failing anything. `until` IS THE CURSOR, a calendar day the previous page
 * answered — refused as a bad request when it is not one, before it reaches a
 * query.
 */
async function readExchangesForScope(
  deps: LocalApiDeps,
  db: pg.ClientBase,
  scope: RequestScope,
  url: URL,
): Promise<unknown> {
  const now = callersNow(url);
  const until = url.searchParams.get(TWIN_API_UNTIL_PARAM);
  if (until !== null && !isCalendarDay(until)) {
    throw new ApiRefusal("bad_request", 400);
  }
  const read = await readExchanges(
    {
      db,
      twinId: scope.twinId,
      dek: deps.dek,
      ...(deps.timeZone === undefined ? {} : { timeZone: deps.timeZone }),
    },
    { seatId: scope.seatId, now, ...(until === null ? {} : { until }) },
  );
  // ...AND EVERY NAME IN A REPLY OPENS THE CARD THE TWIN WROTE BESIDE IT, as
  // the feed's do one handler up (tickets #321, #401).
  const onCanvas = await readOnCanvas(feedDepsOf(deps, db, scope), now);
  // EVERY INSTANT BECOMES AN ISO STRING HERE, as the feed's do one handler up.
  return exchangesOnTheWire(read, onCanvas);
}

/**
 * ONE WORKSPACE DOCUMENT'S VERSION, READ-ONLY (ticket #326; spec #318
 * decision 34): its title and its text out of this twin's bundle, for a
 * seat of this twin's, by the version's id the card carries. A version the
 * bundle does not hold — another twin's, or none — is no route, the answer a
 * read gives for a door that is not there; a runtime with no bundle open has
 * none either, as the notepad's read has none.
 */
async function readDocumentForScope(
  deps: LocalApiDeps,
  _db: pg.ClientBase,
  _scope: RequestScope,
  url: URL,
): Promise<TwinDocument> {
  const id = documentRoute(url);
  if (deps.acts === undefined || id === undefined) throw new ApiRefusal("no_route", 404);
  const version = deps.acts.bundle.readWorkspaceVersion(id);
  if (version === undefined) throw new ApiRefusal("no_route", 404);
  return { documentId: version.id, title: version.title, version: version.version, content: version.content };
}

/**
 * EVERY WORKSPACE DOCUMENT OF THIS TWIN'S, READ-ONLY (ticket #368; ruled
 * 2026-10-08): each path's latest version by its id, title, number and date,
 * newest first, out of this twin's bundle — Mi libreta's «Documentos», listed
 * whether or not a card for a document is on the canvas. No path and no text
 * leave: a document opens by the id, through `readDocumentForScope`. A runtime
 * with no bundle open has no route here, as the notepad's read has none.
 */
async function readDocumentsForScope(deps: LocalApiDeps): Promise<TwinDocuments> {
  if (deps.acts === undefined) throw new ApiRefusal("no_route", 404);
  return {
    documents: deps.acts.bundle.listWorkspaceDocuments().map((document) => ({
      documentId: document.id,
      title: document.title,
      version: document.version,
      writtenAt: new Date(document.writtenAt).toISOString(),
    })),
  };
}

/**
 * THE REP NOTEPAD AS IT STANDS, for the seat this request authenticated as
 * (ticket #264; ADR-0033).
 *
 * THE BUNDLE IS THE ACTS' OWN, and a runtime started for the reads alone has
 * none — so there the read is no route, `LocalApiActDeps`' own argument: the
 * door is not there. The seat's twin is this runtime's by fence 3, and a twin
 * has one notebook, so nothing in the request says which.
 */
async function readNotepadForScope(
  deps: LocalApiDeps,
  db: pg.ClientBase,
  scope: RequestScope,
): Promise<TwinNotepad> {
  if (deps.acts === undefined) throw new ApiRefusal("no_route", 404);
  const current = deps.acts.bundle.readNotepad();
  return {
    text: current?.text ?? "",
    version: current?.version ?? 0,
    writtenAt: current?.writtenAt ?? null,
    // THE TWIN'S OWN NOTES BESIDE THE REP'S (ticket #322): Mi libreta's
    // second, read-only section, from the same bundle.
    workingMemory: await workingMemoryOnTheWire(
      mattersDepsOf(deps, db, scope, deps.acts),
      deps.acts.bundle.readWorkingMemory(),
    ),
  };
}

/**
 * THE TWIN'S OPEN MATTERS, for the bar (tickets #322, #335) — from the
 * acts' bundle, so a runtime started for the reads alone has no route here,
 * as the notepad's read has none.
 */
async function readOpenMattersForScope(
  deps: LocalApiDeps,
  db: pg.ClientBase,
  scope: RequestScope,
): Promise<TwinOpenMatters> {
  if (deps.acts === undefined) throw new ApiRefusal("no_route", 404);
  return await openMattersOnTheWire(
    mattersDepsOf(deps, db, scope, deps.acts),
    deps.acts.bundle.readWorkingMemory(),
  );
}

/** The reads a matter's subject resolves through: this twin's posts and its mirror. */
function mattersDepsOf(
  deps: LocalApiDeps,
  db: pg.ClientBase,
  scope: RequestScope,
  acts: LocalApiActDeps,
): MattersDeps {
  return {
    db,
    twinId: scope.twinId,
    dek: deps.dek,
    ...(deps.timeZone === undefined ? {} : { timeZone: deps.timeZone }),
    bundle: acts.bundle,
    selfChatJid: acts.selfChatJid,
  };
}

/**
 * The notebook edit's body: the whole text and the version it rewrites, or a
 * bad request.
 *
 * ONLY THE SHAPES ARE CHECKED HERE. The cap and the version are the act's to
 * answer, against the store, and an empty string is the delete rather than a
 * missing field.
 */
function notepadEditOf(body: unknown): { text: string; basedOn: number } {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new ApiRefusal("bad_request", 400);
  }
  const given = body as Record<string, unknown>;
  const text = given["text"];
  const basedOn = given["basedOn"];
  if (
    typeof text !== "string" ||
    typeof basedOn !== "number" ||
    !Number.isSafeInteger(basedOn) ||
    basedOn < 0
  ) {
    throw new ApiRefusal("bad_request", 400);
  }
  return { text, basedOn };
}

/**
 * The body, checked into the shape THIS ROUTE's act takes — or refused.
 *
 * EVERY FIELD IS CHECKED HERE AND NOT DEEPER IN, so `performDashboardAct` is
 * handed values rather than possibilities: an id that is not a uuid never
 * reaches a query (the act re-checks it anyway, because that function is also
 * called by tests), and a line index that is not a positive integer is a
 * parameter this act cannot take rather than a line nothing resolves to.
 *
 * THE ROUTE DECIDES WHICH SHAPE, off the shared record — so a POST carrying
 * `{ postId }` to a scope route is a bad request rather than an act on a
 * directory row that happens to have a post's id.
 */
function actRequestOf(
  route: Exclude<TwinApiActRoute, DashboardNotepadActRoute>,
  body: unknown,
): DashboardActRequest {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new ApiRefusal("bad_request", 400);
  }
  const given = body as Record<string, unknown>;
  if (isAutomationActRoute(route)) {
    // AN AUTOMATION'S ROW ID, Dito's or a rutina's, and nothing else: any
    // other string is a parameter this act cannot take.
    const automation = given["automation"];
    if (typeof automation !== "string" || !isOwnId(automation)) {
      throw new ApiRefusal("bad_request", 400);
    }
    // ...AND THE PROPOSAL CARD IT WAS PRESSED ON, when it was (ticket #386).
    const proposal = given["proposal"];
    if (proposal !== undefined && (typeof proposal !== "string" || !isOwnId(proposal))) {
      throw new ApiRefusal("bad_request", 400);
    }
    return { target: "automation", route, automation, ...(proposal === undefined ? {} : { proposal }) };
  }
  if (isRunActRoute(route)) {
    const runId = given["runId"];
    if (typeof runId !== "string" || !isOwnId(runId)) throw new ApiRefusal("bad_request", 400);
    return { target: "run", route, runId };
  }
  if (isScopeActRoute(route)) {
    const directoryId = given["directoryId"];
    if (typeof directoryId !== "string" || !isOwnId(directoryId)) {
      throw new ApiRefusal("bad_request", 400);
    }
    return { target: "chat", route, chatDirectoryId: directoryId };
  }
  const postId = given["postId"];
  if (typeof postId !== "string" || !isOwnId(postId)) {
    throw new ApiRefusal("bad_request", 400);
  }
  if (route === "answerAsk") {
    // THE ANSWER'S SHAPE IS CHECKED HERE — an object of texts and lists of
    // texts — and its FIT to the card where the card is read (ticket #324;
    // `runs/ask.ts`): a field the card does not have, or an option it does not
    // offer, is an act the store declines, not a body this route cannot take.
    const answers = given["answers"];
    if (answers === null || typeof answers !== "object" || Array.isArray(answers)) {
      throw new ApiRefusal("bad_request", 400);
    }
    const fits = Object.values(answers as Record<string, unknown>).every(
      (value) => typeof value === "string" || (Array.isArray(value) && value.every((item) => typeof item === "string")),
    );
    if (!fits) throw new ApiRefusal("bad_request", 400);
    return { target: "post", route, postId, answers };
  }
  const lineIndex = given["lineIndex"];
  if (lineIndex === undefined) {
    // A `retract_line` WITH NO LINE IS A BAD REQUEST AND NOT A REFUSAL, and
    // the distinction is the one the refusal set already draws: `bad_request`
    // is a parameter the act cannot take, while `refused` is an act the store
    // declined. A card's Retirar button always carries its number.
    if (route === "retractLine") throw new ApiRefusal("bad_request", 400);
    return { target: "post", route, postId };
  }
  if (
    typeof lineIndex !== "number" ||
    !Number.isSafeInteger(lineIndex) ||
    lineIndex < 1
  ) {
    throw new ApiRefusal("bad_request", 400);
  }
  return { target: "post", route, postId, lineIndex };
}

/**
 * The request's bytes, bounded and parsed.
 *
 * THE BOUND IS ENFORCED WHILE READING rather than after, which is the whole
 * point: a check on the finished body would have buffered the whole of it
 * first, so a caller past the bearer could spend the lease holder's memory
 * before anybody looked at the length. The socket is destroyed rather than
 * answered, because a caller sending more than any body this API takes is
 * not one a status code will help.
 */
async function readActBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    bytes += buf.length;
    if (bytes > MAX_ACT_BODY_BYTES) {
      req.destroy();
      throw new ApiRefusal("bad_request", 400);
    }
    chunks.push(buf);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ApiRefusal("bad_request", 400);
  }
}

/**
 * One refusal on the wire: a status, a word, and nothing else.
 *
 * A FAILURE THAT IS NOT A REFUSAL IS `unavailable` AND SAYS NOTHING MORE.
 * A broken store, a missing key, a bundle that will not open — none of that
 * is a caller's business, and its text is the one thing on this path that
 * could carry a chat id, a draft's body or a connection string. It is not
 * logged here either: the composition root owns what this process prints
 * (`rig-run.ts`), and a library that wrote to stderr would put a twin's
 * failure in whatever reads it.
 */
function refuse(res: http.ServerResponse, error: unknown): void {
  const refusal =
    error instanceof ApiRefusal
      ? error
      : new ApiRefusal("unavailable", 500);
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(refusal.status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify({ error: refusal.refusal }));
}
