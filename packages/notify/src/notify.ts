/**
 * NOTIFY — the rep-side service that owns the email rail and the push rail
 * (ticket #219, widened by #262; spec #214 *Notify, in detail*; spec #258
 * *Notification end to end*; ADR-0022 as amended, ADR-0019's flows 4 and 6,
 * ADR-0013 class 4).
 *
 * A caller says WHICH message and FOR WHICH SEAT. It never says to whom:
 * the address comes off `seats.email` and the devices come off
 * `push_subscriptions`, which is what ADR-0022's "notify resolves recipients
 * itself from seat/company state — callers pass seat ids, never addresses"
 * means when a machine has to hold it. There is no parameter an address, an
 * endpoint or a link could arrive through, and a seat id that looks like an
 * address is refused by name.
 *
 * TWO TRANSPORTS, AND THE TYPE DECIDES WHICH (ADR-0022 as amended). The
 * catalog's entry names the template each transport renders: two types leave
 * by email alone, three by push alone, and the two grave events go both ways
 * because a rep whose rail dropped must be reachable whether or not they ever
 * allowed notifications. Nothing a caller passes can change that.
 *
 * ONE ROW PER ATTEMPT AT ONE DESTINATION (`sendOn`; ticket #276) — the channel
 * it left by, and for a push the browser it was addressed to. One row per ASK
 * was three reachable failures in one shape: a grave event's single row was
 * settled by the email's rejection and the push was skipped exactly when mail
 * was down; a later pass found that row and tried neither again; and a fan-out
 * interrupted between two of a seat's browsers lost the second's delivery for
 * good.
 *
 * SO AN ASK NAMING WHAT IT IS ABOUT IS IDEMPOTENT, and that is the whole of
 * how the tiers retry. Before anything is attempted this service reads what
 * already stands about `about` — an attempt is `sent`, `refused` or still in
 * flight — and attempts exactly the destinations that have none. A channel
 * recorded `failed` is attempted again; one recorded `sent` never is. An ask
 * with no `about` is the invitation and the login code, which are not retried
 * by anybody and dedupe against nothing.
 *
 * THE RECORD IS WRITTEN BEFORE THE SEND AND SETTLED AFTER —
 * `runtime_requests`' shape, for the reason an email has no undo: a record
 * written only on success would leave a message in somebody's inbox that
 * nothing in the system remembers sending. An unsettled row means "this may
 * have gone out", which is the honest state after a crash mid-send — and what
 * a row scopes that claim to is now the ONE destination it was opened for.
 *
 * WHICH FAILURES ARE ROWS, AND WHY THE LINE IS THERE. A CALLER's bug —
 * a type outside the catalog, an address where a seat id belongs, a slot
 * the template refuses, a slot the seat owns, an announcement naming no post
 * — throws and writes nothing: nothing was asked of the world, and a row
 * would be a record of a message that was never a message. A STATE's refusal
 * — the seat has no address yet, no browser of theirs has accepted
 * notifications — is a row, because the ask was legitimate and "this seat
 * cannot be reached" is a fact worth keeping. An EMAIL transport failure is a
 * row AND a throw: the caller has to know, and the attempt has to be
 * remembered. A PUSH failure is a row alone — there is nothing a caller can
 * do about a push service that said no, and a throw would stop the runtime's
 * pass over a notification.
 *
 * A LOGIN THAT EXPIRED TAKES ITS BROWSER WITH IT (`readSubscriptions`; ticket
 * #276). A push subscription is granted under a login session and «Cerrar
 * sesiones» ends both — but a session that simply EXPIRES, six months on, was
 * ending nothing, so the browser it was granted on kept receiving the twin's
 * own words. Delivery joins the granting session and requires it unended and
 * unexpired, and ends the subscription of one that is not.
 *
 * TIME IS A PARAMETER. `now` is injected, never read from a clock inside
 * this package, so a suite can pin an instant and two rows written in one
 * ask agree about when it happened.
 *
 * IT IS NEVER ON A TOOL SURFACE. Class 4 of ADR-0013, held by
 * `packages/execution/src/dependency-wall.test.ts`: no module that
 * constructs an automation registry can reach this one, directly or
 * transitively.
 */
import {
  CopyError,
  renderTemplate,
  TEMPLATES,
  type RenderedCopy,
  type SlotValues,
} from "@dito/copy";
import type pg from "pg";
import { liveSesTransport } from "./ses.js";
import {
  livePushTransport,
  type PushPayload,
  type PushSubscription,
  type PushTransport,
  type VapidKeys,
} from "./push.js";
import {
  callerSlots,
  NOTIFY_CATALOG,
  NotifyError,
  type CatalogEntry,
  type NotifyMessageType,
  type SeatSlotSource,
} from "./catalog.js";
import type { NotifyChannel } from "./record.js";

/** One message, as a transport takes it. */
export interface OutboundEmail {
  readonly to: string;
  readonly subject: string;
  readonly body: string;
}

/**
 * The one boundary this service has: something that puts a message on the
 * wire and hands back the provider's id for it.
 *
 * AN INTERFACE SO THE SES CLIENT IS A VALUE, not so it can be faked away.
 * The real one is `sesTransport`, over the SDK's own client; a suite that
 * drives the seam holds one that records, and the real path is proven in
 * its own gated lane against a dev mailbox (ADR-0028: never emulated).
 */
export interface EmailTransport {
  send(email: OutboundEmail): Promise<{ readonly providerMessageId: string }>;
}

/**
 * What notify checks out a session from.
 *
 * A POOL AND NOT A CONNECTION (Codex r3), and this is the difference between
 * a record and a promise of one. The row is written before the send so that
 * a crash cannot lose the fact of it — but on a caller's own client, inside
 * a caller's `BEGIN`, the insert is UNCOMMITTED while SES sends, and the
 * caller's rollback then erases the record of a message that has already
 * left. rep-web will wrap a request in a transaction, so this is the
 * ordinary case rather than an exotic one.
 *
 * So notify takes something it can check a SESSION out of, and each send
 * gets its own: autocommit, nobody else's transaction, the record durable
 * before the transport is called. A `pg.Pool` is one; so is anything with
 * the same one method, which is what the type asks for.
 */
export interface NotifySessions {
  connect(): Promise<pg.PoolClient>;
}

/** What notify needs to do its job, all injected. */
export interface NotifyDeps extends DashboardOrigin {
  /** Where the send's own session comes from — see `NotifySessions`. */
  readonly db: NotifySessions;
  readonly transport: EmailTransport;
  /**
   * The second transport (ticket #262; ADR-0022 as amended).
   *
   * OPTIONAL, AND ABSENT MEANS «THIS DEPLOYMENT HAS NO PUSH IDENTITY». A VAPID
   * pair is deployment configuration and a process that holds none cannot
   * encrypt to anybody — so a push type asked of such a process is a recorded
   * refusal and never a crash, exactly as a seat with no address is.
   */
  readonly push?: PushTransport;
  /** The clock, as a parameter — see the module header. */
  readonly now: () => Date;
}

/**
 * The one origin a link in a Dito email may point at.
 *
 * THE FENCE THE SLOT'S OWN RULES CANNOT BE (Codex r1, r2, r3).
 * `@dito/copy` refuses a `javascript:` scheme, a userinfo host, a query, a
 * fragment, a percent-escape and anything but an unreserved path — and every
 * one of those still leaves `https://attacker.example/entrar/8f2c`, which is
 * a phishing link inside a message Dito really sent. The host is not
 * something a bounded character set can decide; it is deployment
 * configuration, so it is a required input here rather than a guess in the
 * copy package.
 *
 * COMPARED AS AN ORIGIN — scheme, host and port — because that is what
 * decides where a tap lands. A path is the caller's; the place is not.
 */
export interface DashboardOrigin {
  /** e.g. `https://tablero.dito.mx`, or the rig's `http://localhost:3000`. */
  readonly dashboardOrigin: string;
}

/** One ask: which message, for which seat, and the occasion's own values. */
export interface NotifyRequest {
  readonly type: NotifyMessageType;
  readonly seatId: string;
  /** The occasion's slots. Never an address, and never a slot the seat owns. */
  readonly slots: SlotValues;
  /**
   * WHAT THIS ASK IS ABOUT (ticket #262) — a `posts` id for an announcement, a
   * `rail_status_events` id for a grave event.
   *
   * IT IS THE CALLER'S MEMORY AND NOT NOTIFY'S ERRAND. The runtime's pass asks
   * «is there already a send about this post» before it asks for one, so the
   * record is what makes a knock fire once across a restart — and the deep
   * link a push carries is built from it, which is why the same value decides
   * both and a caller cannot pass a link at all.
   */
  readonly about?: string;
}

/** What became of one attempt at one destination, as the row holds it. */
export interface NotifySendRecord {
  readonly id: string;
  readonly seatId: string;
  readonly type: NotifyMessageType;
  readonly requestedAt: Date;
  readonly outcome: "sent" | "refused" | "failed";
  readonly reason:
    | "no_email"
    | "no_subscription"
    | "transport_failed"
    | null;
  readonly providerMessageId: string | null;
  /** What the ask was about — see `NotifyRequest.about`. */
  readonly aboutRef: string | null;
  /** Which transport this attempt left by (ticket #276). */
  readonly channel: NotifyChannel;
  /**
   * The browser it was addressed to, or nothing (ticket #276).
   *
   * NOTHING ON EVERY EMAIL, and on a push channel refused for want of any
   * registration at all — there was no one device, so there is none to name.
   */
  readonly subscriptionId: string | null;
}

/**
 * The service.
 *
 * A LIST AND NOT A RECORD (ticket #276), because one ask is now one attempt
 * per destination: a grave event for a rep with a laptop and a phone is an
 * email and two pushes, each with its own outcome. The single record it used
 * to return was the collapse the findings were about — a 201 beside a 500 read
 * as `sent`, and an SES rejection stood for the push nobody had tried.
 *
 * WHAT IT RETURNS IS WHAT THIS CALL ATTEMPTED, so an ask whose destinations
 * were all recorded by an earlier pass comes back empty. That is the honest
 * answer to «what did this do»: nothing, because there was nothing left owed.
 */
export interface Notify {
  send(request: NotifyRequest): Promise<readonly NotifySendRecord[]>;
}

/**
 * What a template may be told about the seat.
 *
 * A TYPE RATHER THAN AN INLINE SHAPE, because two places need exactly this
 * much of a seat and no more: the renderer, which greets the rep by name,
 * and the operator script, which renders without sending. The address is
 * deliberately not here — it is the transport's, never the message's.
 */
export interface NotifySeat {
  readonly repDisplayName: string;
}

/** The seat, as notify reads one: what a template may see, and where to send. */
interface SeatRow extends NotifySeat {
  readonly email: string | null;
}

/**
 * How each declared seat source is read off the seat.
 *
 * A MAP SO THE DECLARATION IS LOAD-BEARING (the two-axis review's Standards
 * axis). `seatSlots: { name: "rep_display_name" }` is the record of WHICH
 * column fills a slot, and it was a record nothing consulted — the loop
 * assigned the display name whatever the entry said. Keyed on the source
 * type, a word added to `SEAT_SLOT_SOURCES` with no reader here is a type
 * error rather than a silent wrong value.
 */
const SEAT_COLUMN: Readonly<
  Record<SeatSlotSource, (seat: NotifySeat) => string>
> = {
  rep_display_name: (seat) => seat.repDisplayName,
};

/**
 * A seat id, which is a uuid.
 *
 * CHECKED BEFORE THE QUERY, so a caller who passed an address is told what
 * they did rather than being told no such seat exists — the mistake
 * ADR-0022's rule is about is worth naming in the error a caller reads.
 */
const SEAT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/**
 * One message, rendered as it would be sent — no transport, no record.
 *
 * EXPORTED BECAUSE THE OPERATOR SCRIPT NEEDS IT: without SES credentials
 * `rig-notify.ts` renders and prints rather than sending, and it has to be
 * the SAME rendering that would have gone out or the demo proves nothing
 * about the message. One renderer, two callers.
 */
export function renderNotification(
  type: NotifyMessageType,
  seat: NotifySeat,
  slots: SlotValues,
  origin?: DashboardOrigin,
): RenderedCopy {
  const entry = NOTIFY_CATALOG[type];
  if (entry.template === undefined) {
    throw new NotifyError(
      `the \`${type}\` is a push and has no email to render — a message with no address is not one an operator can print (ADR-0022 as amended)`,
    );
  }
  if (origin !== undefined) refuseForeignLinks(slots, origin.dashboardOrigin);
  for (const slot of [...Object.keys(entry.seatSlots), ...fixedLinkSlots(entry)]) {
    if (slot in slots) {
      throw new NotifyError(
        `the slot \`${slot}\` is filled by notify and a caller may not pass it (ADR-0022) — this message takes ${callerSlots(entry).join(", ") || "no slots"}`,
      );
    }
  }
  const filled: Record<string, string> = {};
  for (const [slot, source] of Object.entries(entry.seatSlots)) {
    filled[slot] = SEAT_COLUMN[source](seat);
  }
  // THE LINK IN A FIXED-DESTINATION MESSAGE IS NOTIFY'S (ticket #262). A grave
  // event is answered in one place and both transports say so: the push's deep
  // link and the email's `url` come off the SAME catalog entry and the same
  // deployment origin, so an operator cannot hand one of them a different
  // page. An invitation and a login code keep their caller-supplied link —
  // both carry a token only the caller has.
  for (const slot of fixedLinkSlots(entry)) {
    if (origin === undefined) {
      throw new NotifyError(
        `the \`${type}\` carries a link notify builds, and no dashboard origin was given — the destination is the deployment's, never a caller's (ADR-0022)`,
      );
    }
    filled[slot] = connectionsLink(origin);
  }
  try {
    return renderTemplate(TEMPLATES[entry.template], {
      ...slots,
      ...filled,
    });
  } catch (error) {
    // THE RENDERER'S REFUSAL IS NOTIFY'S REFUSAL. A caller of this service
    // asks for a message type and should not have to know `@dito/copy`'s
    // error class to catch a bad slot — so the boundary is wrapped, with
    // the original as its cause so nothing about the refusal is lost.
    if (error instanceof CopyError) {
      throw new NotifyError(`the \`${type}\` cannot be rendered: ${error.message}`, {
        cause: error,
      });
    }
    throw error;
  }
}

/**
 * The service every process outside this package gets: the real rail, over
 * one connection.
 *
 * THE PUBLIC SURFACE IS THIS AND NOT A TRANSPORT (Codex r1). `sesTransport`
 * is internal, because its `send({ to, subject, body })` is a caller naming
 * an arbitrary address and arbitrary text with no seat consulted, no catalog
 * entry constructed and no row written — every guard in this module bypassed
 * by importing the thing underneath it. The only door into SES from outside
 * this package is a seat id and a message type.
 *
 * `createNotify` IS EXPORTED FROM THIS MODULE AND NOT FROM THE PACKAGE, and
 * the distinction is the point rather than an oversight. A transport is
 * something a caller IMPLEMENTS, so passing one buys no ability to send —
 * the seat lookup, the slot typing and the record all still run — but it does
 * let a caller SEE the address notify resolved, which is one guard fewer than
 * the one door `index.ts` offers. So the seam suites reach it by relative path
 * the way they reach every other package's test plumbing, and nothing
 * resolving `@dito/notify` can name a transport at all.
 */
export function createLiveNotify(
  deps: DashboardOrigin & {
    readonly db: NotifySessions;
    /** The verified identity this environment sends as. */
    readonly from: string;
    readonly now: () => Date;
    /**
     * This deployment's push identity, by value (ticket #262). Absent means
     * the deployment has none, and every push type is then a recorded
     * refusal — which is the state rep-web is in and the runtime is not.
     */
    readonly vapid?: VapidKeys;
  },
): Notify {
  return createNotify({
    db: deps.db,
    transport: liveSesTransport({ from: deps.from }),
    ...(deps.vapid === undefined
      ? {}
      : { push: livePushTransport(deps.vapid) }),
    now: deps.now,
    dashboardOrigin: deps.dashboardOrigin,
  });
}

/** The service, over one connection and one transport. */
export function createNotify(deps: NotifyDeps): Notify {
  return {
    async send(request: NotifyRequest): Promise<readonly NotifySendRecord[]> {
      // The catalog is typed by message type, so this is the runtime fence
      // for a caller who ignored the type rather than a lookup the send
      // needs; `renderNotification` reads the entry it uses itself.
      if (NOTIFY_CATALOG[request.type] === undefined) {
        throw new NotifyError(
          `\`${request.type}\` is not a message type Dito sends`,
        );
      }
      if (!SEAT_ID.test(request.seatId)) {
        throw new NotifyError(
          request.seatId.includes("@")
            ? "a seat id, never an address: notify resolves the recipient from seat state (ADR-0022)"
            : `\`${request.seatId}\` is not a seat id`,
        );
      }
      // THE SEND'S OWN SESSION, released whatever happens — see
      // `NotifySessions` for why it is not the caller's.
      const db = await deps.db.connect();
      try {
        return await sendOn(db, deps, request);
      } finally {
        db.release();
      }
    },
  };
}

/**
 * One ask, on a session of its own, over every destination its type declares
 * and has not already reached.
 *
 * THE ORDER IS EMAIL THEN PUSH, and it is the order of consequence: an email
 * cannot be taken back once SES has it, so it is attempted first. What the
 * order is NOT is a dependency (ticket #276, finding 3). The two channels are
 * independent attempts with independent records, so an SES rejection that
 * threw before the subscription loop would skip the push exactly when mail is
 * down — which is when a rep whose rail dropped most needs the other rail.
 * The mail transport's failure still reaches the caller, because an email
 * failure is something a caller can act on; it is simply raised AFTER every
 * other destination has had its turn.
 *
 * ONE ROW PER DESTINATION, opened immediately before that destination's own
 * request (finding 4). A crash between the laptop and the phone leaves the
 * laptop `sent` and the phone with no row at all, so the next pass attempts
 * the phone and never the laptop; a 201 beside a 500 is two rows with two
 * outcomes rather than one that says `sent`.
 *
 * AND NOTHING ALREADY STANDING IS ATTEMPTED TWICE (`standingAttempts`), which
 * is what lets a tier ask on every pass while anything is owed.
 */
async function sendOn(
  db: pg.PoolClient,
  deps: NotifyDeps,
  request: NotifyRequest,
): Promise<readonly NotifySendRecord[]> {
  const entry = NOTIFY_CATALOG[request.type];
  const seat = await readSeat(db, request.seatId);
  if (seat === undefined) {
    throw new NotifyError(`no seat \`${request.seatId}\``);
  }
  // A SLOT NO TEMPLATE OF THIS TYPE DECLARES IS A CALLER'S BUG, refused before
  // anything is recorded. Each transport then renders with the subset it
  // declares (`renderPush`), so the union is where the typo is caught rather
  // than in whichever template happened to be rendered first.
  const takes = callerSlots(entry);
  for (const slot of Object.keys(request.slots)) {
    if (!takes.includes(slot) && !(slot in entry.seatSlots)) {
      throw new NotifyError(
        `the \`${request.type}\` takes ${takes.length === 0 ? "no slots" : takes.join(", ")} and was given \`${slot}\``,
      );
    }
  }

  // RENDERED BEFORE ANYTHING IS RECORDED. A caller's bug is a caller's bug
  // whatever state the seat is in, and it leaves no row behind.
  const message =
    entry.template === undefined
      ? undefined
      : renderNotification(request.type, seat, request.slots, deps);
  const notification =
    entry.push === undefined ? undefined : renderPush(entry, request, deps);

  const standing = await standingAttempts(db, request, deps.now());
  const records: NotifySendRecord[] = [];
  let mailFailure: NotifyError | undefined;

  if (entry.template !== undefined && !standing.email) {
    // NOTHING TO REACH IS A ROW AND NEVER A THROW — the module header's line
    // between a caller's bug and a state's refusal. A seat with no address
    // asked for something legitimate; that it cannot be reached is a fact
    // worth keeping, and it is what stops the runtime's pass re-examining the
    // same post on every tick for the rest of the day.
    if (seat.email === null) {
      records.push(
        await recordRefusal(db, request, deps.now(), EMAIL, "no_email"),
      );
    } else {
      const id = await openRecord(db, request, deps.now(), EMAIL);
      // THE TRY COVERS THE TRANSPORT CALL AND NOTHING ELSE (Codex r2). With
      // the settle inside it, a database that failed AFTER SES had accepted
      // the message landed in the catch, recorded `failed`, and the spacing
      // then mailed the rep the same grave event a second time — a store
      // failure read as a transport one, on the rail that has no undo.
      //
      // A SETTLE THAT THROWS LEAVES THE ROW UNSETTLED, which is the honest
      // state and already the defined one: «this may have gone out» stands
      // under `standingAttempts` and is never attempted again. The error
      // propagates as what it is.
      let accepted: { readonly providerMessageId: string } | undefined;
      try {
        accepted = await deps.transport.send({
          to: seat.email,
          subject: message!.subject,
          body: message!.body,
        });
      } catch (error) {
        records.push(
          await settleRecord(db, id, deps.now(), "failed", "transport_failed", null),
        );
        // THE PROVIDER'S OWN TEXT NEVER LEAVES THIS BLOCK, and that is the one
        // thing worth saying here. SES names the identity that failed its
        // check — "the following identities failed … rep@example.com" — so what
        // is thrown carries the type, the seat and the failure's CLASS, and
        // nothing the provider wrote.
        //
        // NOT EVEN AS THE `cause` (Codex r3). A cause looks private and is not:
        // Node's own formatting walks the chain, so `console.error(err)` and
        // every crash dump print it, and an operator who logs the exception has
        // the recipient's address in a log. So the cause is allowlisted
        // metadata rather than the error itself.
        mailFailure = new NotifyError(
          `the transport would not take the \`${request.type}\` for seat ${request.seatId}`,
          {
            cause: {
              transport: "ses",
              error: error instanceof Error ? error.name : typeof error,
            },
          },
        );
      }
      if (accepted !== undefined) {
        records.push(
          await settleRecord(
            db,
            id,
            deps.now(),
            "sent",
            null,
            accepted.providerMessageId,
          ),
        );
      }
    }
  }

  if (entry.push !== undefined) {
    // A DEPLOYMENT WITH NO PUSH IDENTITY CAN ENCRYPT TO NOBODY, so it has no
    // destinations rather than a broken one — the same recorded refusal a seat
    // with no registered browser gets (`NotifyDeps.push`).
    const subscriptions =
      deps.push === undefined
        ? []
        : await readSubscriptions(db, request.seatId, deps.now());
    const owed = subscriptions.filter((one) => !standing.reached(one.id));
    if (subscriptions.length === 0) {
      if (!standing.push) {
        records.push(
          await recordRefusal(db, request, deps.now(), NO_DEVICE, "no_subscription"),
        );
      }
    }
    for (const subscription of owed) {
      const id = await openRecord(db, request, deps.now(), {
        channel: "push",
        subscriptionId: subscription.id,
      });
      let status: number;
      try {
        ({ status } = await deps.push!.send(subscription, notification!));
      } catch {
        // THE SERVICE'S OWN TEXT NEVER LEAVES THIS BLOCK, for the reason the
        // SES arm gives one screen up: an endpoint is a device's identity and
        // a thrown error that carried one would put it in every crash dump.
        // A request the deadline cut off arrives here too, and is the same
        // fact about this browser: nothing was delivered (ticket #276).
        records.push(
          await settleRecord(db, id, deps.now(), "failed", "transport_failed", null),
        );
        continue;
      }
      if (status === 404 || status === 410) {
        // GONE IS THE ANSWER A BROWSER GIVES BY THROWING ITS REGISTRATION AWAY
        // (RFC 8030 §7.3), and it is ordinary: a reinstalled browser, a cleared
        // site, a permission withdrawn. The row stops being a place to deliver
        // in the same breath, so the next pass does not try it again — and the
        // attempt is `refused` rather than `failed`, because a browser that is
        // gone is not a provider that said no and must not be retried.
        await endSubscription(db, subscription.id, deps.now());
        records.push(
          await settleRecord(
            db,
            id,
            deps.now(),
            "refused",
            "no_subscription",
            null,
          ),
        );
        continue;
      }
      records.push(
        status >= 200 && status < 300
          ? await settleRecord(db, id, deps.now(), "sent", null, null)
          : await settleRecord(
              db,
              id,
              deps.now(),
              "failed",
              "transport_failed",
              null,
            ),
      );
    }
  }

  // AND ONLY NOW, WITH EVERY OTHER DESTINATION ATTEMPTED (ticket #276). A
  // caller of an email type has to hear that its message did not go out; a
  // grave event's push must not be the thing that hears it (`notify-tiers.ts`
  // catches, so the pass carries on either way).
  if (mailFailure !== undefined) throw mailFailure;
  return records;
}

/**
 * HOW LONG A FAILED ATTEMPT STANDS BEFORE IT IS MADE AGAIN, in milliseconds.
 *
 * FIVE MINUTES, AND WITHOUT IT A RETRY IS A STORM (ticket #276). A destination
 * that failed is attempted again — that is what makes a dropped rail reach the
 * rep by mail once mail is back — and the tier that asks runs every two
 * seconds, so a rule that said only «attempt what has not succeeded» would put
 * a request in front of a refusing provider seven hundred times a minute, each
 * one holding the caller for its own deadline and writing a row.
 *
 * LONG ENOUGH FOR AN OUTAGE TO END AND SHORT ENOUGH THAT A GRAVE EVENT IS NOT
 * LATE. A provider is usually back inside minutes; a spacing in hours would
 * make the retry a promise nobody could rely on.
 *
 * NOT A TOTAL CAP, deliberately — a caller's own window is the total bound,
 * and «stop trying» is not an answer a notification about a lost rail may
 * give. `notify-tiers.ts` holds the same number from the other end, which is
 * `KNOCK_MAX`'s own arrangement one package over: the runtime declares no
 * dependency on this package and must not (ADR-0013 class 4), so each end pins
 * the documented number rather than the other end's constant, and the tier's
 * spacing is at most this one, so it can only over-ask.
 */
const RETRY_AFTER_MS = 5 * 60 * 1000;

/**
 * WHAT ALREADY STANDS ABOUT THIS ASK, in one read (ticket #276).
 *
 * AN ATTEMPT STANDS UNLESS IT FAILED, AND A FAILED ONE STANDS FOR A WHILE.
 * `sent` and `refused` are settled facts — the message went out, or there was
 * nothing to send it to — and an UNSETTLED row stands too, because it means
 * «this may have gone out» and a knock that may already be on a lock screen is
 * not one to send again. `failed` is the outcome that stops standing, and
 * `RETRY_AFTER_MS` is how long it takes to.
 *
 * KEYED ON THE ASK AND NOT ON THE POST. A reminder and a landing knock name the same card
 * in `about_ref`, and they are different asks — so the message type is part of
 * the question, exactly as it is in the tier's own predicate.
 *
 * A ROW WITH NO CHANNEL STANDS FOR EVERYTHING, which is what it meant: every
 * row written before …20260922100060 was one row for the whole ask whatever it
 * reached, so reading one as neither channel would mail about yesterday's
 * dropped rail a second time on the pass after an operator migrates.
 *
 * AN ASK THAT NAMES NOTHING DEDUPES AGAINST NOTHING. The invitation and the
 * login code are sent by a person pressing a button, each one deliberate and
 * none of them retried by any tier — and `about_ref` is null on both, so there
 * is no question to ask.
 */
async function standingAttempts(
  db: pg.ClientBase,
  request: NotifyRequest,
  now: Date,
): Promise<Standing> {
  if (request.about === undefined) {
    return { email: false, push: false, reached: () => false };
  }
  const rows = await db.query<{
    channel: string | null;
    subscription_id: string | null;
  }>(
    `SELECT channel, subscription_id
       FROM notify_sends
      WHERE about_ref = $1
        AND message_type = $2
        AND (outcome IS DISTINCT FROM 'failed' OR settled_at > $3)`,
    [request.about, request.type, new Date(now.getTime() - RETRY_AFTER_MS)],
  );
  const whole = rows.rows.some((row) => row.channel === null);
  const devices = new Set(
    rows.rows
      .filter((row) => row.channel === "push" && row.subscription_id !== null)
      .map((row) => row.subscription_id!),
  );
  return {
    email: whole || rows.rows.some((row) => row.channel === "email"),
    push: whole || rows.rows.some((row) => row.channel === "push"),
    reached: (subscriptionId) => whole || devices.has(subscriptionId),
  };
}

/**
 * WHERE ONE ATTEMPT WENT — the pair every row, every open and every settle
 * carries together (ticket #276; the two-axis review's Standards axis).
 *
 * A TYPE RATHER THAN TWO PARAMETERS, because the two are one fact and were
 * travelling side by side through four signatures: which transport, and for a
 * push which of the seat's browsers. Separately they are a channel word and a
 * uuid either of which a call site could transpose or forget; together they
 * are the thing a `notify_sends` row is about.
 */
interface Destination {
  readonly channel: NotifyChannel;
  /** The browser, or nothing where there was no one device — see the column. */
  readonly subscriptionId: string | null;
}

/** The email channel, which has no one device and never needs naming twice. */
const EMAIL: Destination = { channel: "email", subscriptionId: null };

/** ...and the push channel with nothing to address — a seat with no browser. */
const NO_DEVICE: Destination = { channel: "push", subscriptionId: null };

/** What `standingAttempts` answers. */
interface Standing {
  /** The email channel has an attempt that stands. */
  readonly email: boolean;
  /** ...and the push channel has one, addressed to a browser or to none. */
  readonly push: boolean;
  /** Whether this browser in particular already has one. */
  reached(subscriptionId: string): boolean;
}

/**
 * THE SLOTS NOTIFY FILLS FROM THE OCCASION'S OWN DESTINATION.
 *
 * EVERY `url` AN EMAIL TEMPLATE DECLARES, for a type whose push already names
 * where it lands. Read off the template's declared TYPES rather than off a
 * name, which is `refuseForeignLinks`' argument one screen down: a template
 * that gains a second link is covered without anybody remembering to widen a
 * condition.
 */
function fixedLinkSlots(entry: CatalogEntry): readonly string[] {
  if (entry.push === undefined || entry.template === undefined) return [];
  return Object.entries(TEMPLATES[entry.template].slots)
    .filter(([, type]) => type === "url")
    .map(([slot]) => slot);
}

/**
 * WHAT A BROWSER IS SHOWN, from the catalog and never from a caller (ticket
 * #262).
 *
 * THE LINK IS BUILT HERE AND IS CODE'S. The catalog's entry says which page
 * this occasion opens; the deployment's own `dashboardOrigin` says where that
 * page is; and the ask's `about` says which card. A caller passes none of the
 * three, which is what makes «tapping a knock lands on the card» a property of
 * the type rather than of whoever asked (ADR-0031 as amended).
 */
function renderPush(
  entry: CatalogEntry,
  request: NotifyRequest,
  deps: DashboardOrigin,
): PushPayload {
  const push = entry.push!;
  const template = TEMPLATES[push.template];
  // EACH TEMPLATE TAKES THE SLOTS IT DECLARES, which is what a type with two
  // of them needs: a grave event binds a `url` for the email — the Conexiones
  // link a rep reads in their inbox — and the push carries the same
  // destination as its own deep link rather than as a hole. A slot NEITHER
  // template declares is still refused, by `callerSlots` above.
  const mine = Object.fromEntries(
    Object.entries(request.slots).filter(([slot]) => slot in template.slots),
  );
  try {
    const copy = renderTemplate(template, mine);
    return { title: copy.subject, body: copy.body, url: deepLink(push.link, request, deps) };
  } catch (error) {
    if (error instanceof CopyError) {
      throw new NotifyError(
        `the \`${request.type}\` cannot be rendered: ${error.message}`,
        { cause: error },
      );
    }
    throw error;
  }
}

/**
 * THE DEEP LINK A NOTIFICATION CARRIES — the shape rep-web's service worker
 * opens (`apps/rep-web/public/sw.js`), where every card carries it as its id.
 *
 * `<origin>/#post-<id>` FOR A CARD, and a fragment rather than a path for one
 * reason: Inicio is ONE page whose cards are all on it, so the browser needs to
 * be taken to a place on that page and not to a route that would have to exist.
 * A fragment is also the half of a URL that never reaches a server, so the post
 * id stays out of every access log between the device and the dashboard.
 *
 * `<origin>/conexiones` FOR A GRAVE EVENT, because a dropped rail is answered
 * by re-linking and that is where the rep does it.
 *
 * AN ANNOUNCEMENT WITH NOTHING TO ANNOUNCE IS A CALLER'S BUG and throws before
 * a row is written: a push whose link named no card would land the rep on
 * Inicio with no way to tell which card the twin meant.
 */
function deepLink(
  link: "card" | "connections",
  request: NotifyRequest,
  deps: DashboardOrigin,
): string {
  if (link === "connections") return connectionsLink(deps);
  if (request.about === undefined) {
    throw new NotifyError(
      `the \`${request.type}\` announces a post and names none — a knock is tied to a post that exists (ADR-0044 as amended)`,
    );
  }
  return `${new URL(deps.dashboardOrigin).origin}/#post-${request.about}`;
}

/**
 * The one page a dropped rail is answered on.
 *
 * ITS OWN FUNCTION BECAUSE TWO TRANSPORTS TAKE IT: the push's deep link and
 * the grave email's `url` slot are the same destination, so an operator
 * reading one and a rep tapping the other land in the same place.
 */
function connectionsLink(deps: DashboardOrigin): string {
  return `${new URL(deps.dashboardOrigin).origin}/conexiones`;
}

/**
 * The columns a caller reads back. One list, because two copies of it drift
 * and the second one silently returns a record with a field missing.
 */
const RETURNING = `id, seat_id, message_type, requested_at, outcome, reason,
                   provider_message_id, about_ref, channel, subscription_id`;

/**
 * Every `url` slot points at the dashboard, or the send is refused.
 *
 * READ OFF THE TEMPLATES' DECLARED TYPES rather than off the slot names, so
 * a template that gains a second link is fenced without anybody remembering
 * to widen a condition — which is `FREE_FORM_SLOT_TYPES`'s argument, one
 * type along.
 *
 * OPTIONAL ON `renderNotification` AND ALWAYS PRESENT ON A SEND. The
 * operator script renders without sending when the rail is unconfigured,
 * and in that state there is no origin to compare against and nothing has
 * left the process either.
 */
function refuseForeignLinks(slots: SlotValues, dashboardOrigin: string): void {
  let expected: URL;
  try {
    expected = new URL(dashboardOrigin);
  } catch {
    throw new NotifyError(
      `\`${dashboardOrigin}\` is not an origin — notify needs the dashboard's own, scheme and host and port`,
    );
  }
  const urlSlots = new Set(
    Object.values(TEMPLATES).flatMap((template) =>
      Object.entries(template.slots)
        .filter(([, type]) => type === "url")
        .map(([name]) => name),
    ),
  );
  for (const [slot, value] of Object.entries(slots)) {
    if (!urlSlots.has(slot) || typeof value !== "string") continue;
    let given: URL;
    try {
      given = new URL(value);
    } catch {
      // Not a URL at all; `@dito/copy`'s own rules refuse it with the slot
      // named, which is the better error for a caller to read.
      continue;
    }
    if (given.origin !== expected.origin) {
      throw new NotifyError(
        `the slot \`${slot}\` points at ${given.origin} and this Dito sends links to ${expected.origin} only — a link in a Dito email goes to the dashboard (ADR-0022)`,
      );
    }
  }
}

/**
 * One seat's live registrations, and the retirement of the ones whose login is
 * over (ticket #262, corrected by #276).
 *
 * `ended_at IS NULL` WAS THE WHOLE PREDICATE AND WAS NOT ENOUGH. It is what
 * «Cerrar sesiones» writes through — ending a login ends the subscriptions it
 * granted, in the same statement, so a lost laptop stops knocking the moment
 * the rep says so (`endAllSessions` in rep-web) — but nothing ends a session
 * that simply EXPIRES. A login lasts six months and then stops being a way in;
 * the subscription it granted kept receiving the twin's own composed sentences
 * for ever, on a device nobody has authenticated on since spring (Codex on
 * PR #274, finding 5).
 *
 * SO THE GRANT IS JOINED AND MUST STILL BE ONE: unended, and not past its
 * expiry. The same instant decides both, and it is the injected clock rather
 * than the database's, so a suite that pins an instant gets one answer.
 *
 * AND THE EXPIRED ONE IS ENDED IN THE SAME STATEMENT rather than merely
 * skipped, because «why did this device stop being notified» deserves an
 * answer and a predicate is not one. It is also what makes the tier converge:
 * the tier's own «is anything still owed» is deliberately the weaker
 * predicate, so an expired login's subscription looks owed there until this
 * read retires it (`notify-tiers.ts` argues the direction).
 *
 * THE UPDATE AND THE SELECT ARE ONE STATEMENT AND STILL TWO PREDICATES, which
 * PostgreSQL requires: a data-modifying CTE and the query around it see the
 * same snapshot, so the rows just ended are invisible to the SELECT's own
 * `ended_at IS NULL` and are excluded by id instead.
 *
 * THE VALUES ARE READ AND NEVER PRINTED. An endpoint and two keys are a way
 * to reach a device, so nothing in this module logs one, and the error a
 * failed request throws carries the type and the seat and nothing off this row.
 */
async function readSubscriptions(
  db: pg.ClientBase,
  seatId: string,
  now: Date,
): Promise<readonly StoredSubscription[]> {
  const rows = await db.query<{
    id: string;
    endpoint: string;
    p256dh: string;
    auth: string;
  }>(
    `WITH retired AS (
       UPDATE push_subscriptions ps
          SET ended_at = $2
        WHERE ps.seat_id = $1
          AND ps.ended_at IS NULL
          AND EXISTS (SELECT 1 FROM sessions s
                       WHERE s.id = ps.session_id
                         AND (s.ended_at IS NOT NULL OR s.expires_at <= $2))
        RETURNING ps.id
     )
     SELECT ps.id, ps.endpoint, ps.p256dh, ps.auth
       FROM push_subscriptions ps
      WHERE ps.seat_id = $1
        AND ps.ended_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM retired r WHERE r.id = ps.id)
      ORDER BY ps.created_at`,
    [seatId, now],
  );
  return rows.rows;
}

/** ...and the one answer that retires one: the push service says it is gone. */
async function endSubscription(
  db: pg.ClientBase,
  id: string,
  at: Date,
): Promise<void> {
  await db.query(
    "UPDATE push_subscriptions SET ended_at = $2 WHERE id = $1 AND ended_at IS NULL",
    [id, at],
  );
}

/** A registration, as this module holds one: the transport's, plus its row. */
interface StoredSubscription extends PushSubscription {
  readonly id: string;
}

/** The seat's name and address, or nothing. */
async function readSeat(
  db: pg.ClientBase,
  seatId: string,
): Promise<SeatRow | undefined> {
  const rows = await db.query<{ rep_display_name: string; email: string | null }>(
    "SELECT rep_display_name, email FROM seats WHERE id = $1",
    [seatId],
  );
  const row = rows.rows[0];
  if (row === undefined) return undefined;
  return { repDisplayName: row.rep_display_name, email: row.email };
}

/**
 * The row that says one destination was attempted, before it is.
 *
 * ONE PER DESTINATION AND OPENED IMMEDIATELY BEFORE ITS OWN REQUEST (ticket
 * #276). Opening every row up front would be back where this started: a crash
 * mid-fan-out would leave unsettled rows for browsers nothing ever tried, and
 * an unsettled row means «this may have gone out».
 */
async function openRecord(
  db: pg.ClientBase,
  request: NotifyRequest,
  at: Date,
  to: Destination,
): Promise<string> {
  const rows = await db.query<{ id: string }>(
    `INSERT INTO notify_sends
       (seat_id, message_type, requested_at, about_ref, channel, subscription_id)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [
      request.seatId,
      request.type,
      at,
      request.about ?? null,
      to.channel,
      to.subscriptionId,
    ],
  );
  return rows.rows[0]!.id;
}

/** ...and the row that says what became of it. */
async function settleRecord(
  db: pg.ClientBase,
  id: string,
  at: Date,
  outcome: "sent" | "failed" | "refused",
  reason: NotifySendRecord["reason"],
  providerMessageId: string | null,
): Promise<NotifySendRecord> {
  const rows = await db.query<NotifySendRow>(
    `UPDATE notify_sends
        SET outcome = $2, reason = $3, provider_message_id = $4, settled_at = $5
      WHERE id = $1
      RETURNING ${RETURNING}`,
    [id, outcome, reason, providerMessageId, at],
  );
  return asRecord(rows.rows[0]!);
}

/**
 * One refusal, written settled in a single statement — not the
 * open-and-settle pair, because nothing was attempted between the two (see
 * this module's header).
 */
async function recordRefusal(
  db: pg.ClientBase,
  request: NotifyRequest,
  at: Date,
  to: Destination,
  reason: "no_email" | "no_subscription",
): Promise<NotifySendRecord> {
  const rows = await db.query<NotifySendRow>(
    `INSERT INTO notify_sends
       (seat_id, message_type, requested_at, outcome, reason, settled_at,
        about_ref, channel, subscription_id)
     VALUES ($1, $2, $3, 'refused', $4, $3, $5, $6, $7)
     RETURNING ${RETURNING}`,
    [
      request.seatId,
      request.type,
      at,
      reason,
      request.about ?? null,
      to.channel,
      to.subscriptionId,
    ],
  );
  return asRecord(rows.rows[0]!);
}

interface NotifySendRow {
  readonly id: string;
  readonly seat_id: string;
  readonly message_type: string;
  readonly requested_at: Date;
  readonly outcome: string;
  readonly reason: string | null;
  readonly provider_message_id: string | null;
  readonly about_ref: string | null;
  readonly channel: string;
  readonly subscription_id: string | null;
}

/** The row as a caller reads it. */
function asRecord(row: NotifySendRow): NotifySendRecord {
  return {
    id: row.id,
    seatId: row.seat_id,
    type: row.message_type as NotifyMessageType,
    requestedAt: row.requested_at,
    outcome: row.outcome as NotifySendRecord["outcome"],
    reason: row.reason as NotifySendRecord["reason"],
    providerMessageId: row.provider_message_id,
    aboutRef: row.about_ref,
    channel: row.channel as NotifyChannel,
    subscriptionId: row.subscription_id,
  };
}
