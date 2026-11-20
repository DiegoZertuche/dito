/**
 * THE TIERS THE PASS FIRES (ticket #262; spec #258 *Notification end to end*
 * and decision 7; ADR-0031 as amended, ADR-0022 as amended, ADR-0013 class 4).
 *
 * Two steps, both on the runtime's own poll, both the same shape: find what
 * has happened and has not been announced, hand notify one ask, move on. A
 * card's knocks — the one it lands with and the one each fired reminder owes
 * it (ticket #364) — are the thread's to write and this tier's to deliver.
 *
 * ═══ THE SEND RECORD IS THE MEMORY, AND THAT IS THE WHOLE MECHANISM ═══
 *
 * `notify_sends.about_ref` holds the post a knock announced or the rail
 * transition a grave event reported, and the row beside it says which channel
 * the attempt left by and which browser it was addressed to — so «is anything
 * still owed about this» is one indexed question with one answer
 * (`stillOwed`). Nothing here keeps state in memory: a restart between the
 * post and the send delivers, a restart after it does not, and a restart
 * BETWEEN two of the seat's browsers resumes with the one it never reached.
 *
 * A RESTART *DURING* ONE SEND DOES NOT RE-DELIVER IT, and that is notify's own
 * rule rather than an omission here: a row is opened before its transport is
 * called, so an unsettled row means «this may have gone out» — and a knock
 * that may already be on a lock screen is not one to send again. What the row
 * now scopes that claim to is the ONE destination it was opened for.
 *
 * THE BATCH IS KNOCKS AND NOTHING ELSE (tickets #276, #358): the at-once tier
 * reads `post_knocks`, so its `LIMIT` cuts a batch of posts that really are
 * announced — a pass is never filled with receipts that silence every knock
 * behind them.
 *
 * ═══ NOTIFY ARRIVES AS A VALUE, AND IT HAS TO ═══
 *
 * This package holds registries — every tool a model may call is registered in
 * it — and `dependency-wall.test.ts`
 * refuses `@dito/notify` as a RUNTIME dependency of any package that does.
 * That is ADR-0013 class 4 held mechanically: the email and push rails are
 * never one registration away from a model's tool surface. So the runtime
 * declares the SHAPE it needs (`TwinNotifier`) and the composition root hands
 * it the service — the same way the harness, the embedder and the send
 * lock arrive.
 *
 * A DEPLOYMENT WITH NO NOTIFIER IS THE ORDINARY CASE FOR A SUITE and a
 * misconfiguration on a rig, and both read the same way here: no notifier
 * means these steps do nothing at all, the posts stay unannounced, and the
 * rep still has every card. Nothing is lost that the dashboard does not hold.
 *
 * ═══ A NOTIFICATION NEVER STOPS THE LOOP ═══
 *
 * `runtime.ts`'s doctrine is that fail-stop is for infrastructure. A push
 * service that answered 500 and an inbox that refused a message are neither:
 * they are recorded by notify as the row's own outcome, and what reaches this
 * module is an error only when the EMAIL transport threw, which is caught here
 * so a grave event nobody could mail does not take drafting down with it.
 */
import type pg from "pg";
import type { Dek } from "@dito/crypto";
import { stillWaits } from "./canvas.js";
import { readPostsByIds } from "./feed.js";
import { openKnock, openSealedParts } from "./posts.js";

/**
 * WHAT THE RUNTIME NEEDS OF NOTIFY, structurally.
 *
 * NARROWED TO ONE VERB, so this package needs no opinion about which service
 * it is handed and holds no import of the one that implements it — see the
 * module header for why that is load-bearing rather than tidy. `@dito/notify`'s
 * own `Notify` satisfies it, which the composition root proves by assignment.
 *
 * FIVE TYPES, AND THE RUNTIME NEEDS NO MORE. The catalog holds seven; the
 * two this union leaves out are the invitation and the login code, which
 * rep-web sends and the lease holder never does — so the shape says what this
 * process is allowed to ask for as well as what it needs.
 */
export interface TwinNotifier {
  send(request: {
    readonly type:
      | "draft_ready"
      | "question_asked"
      | "reminder"
      | "rail_dropped"
      | "rail_logged_out";
    readonly seatId: string;
    readonly slots: Readonly<Record<string, string>>;
    readonly about: string;
  }): Promise<unknown>;
}

/**
 * HOW FAR BACK THE AT-ONCE TIER LOOKS, in milliseconds.
 *
 * FOUR HOURS, AND IT IS THE SAME NUMBER AS THE PUSH'S OWN TTL, for the same
 * reason read from the other end: a push service drops a message a device has
 * not collected inside that window, so a knock older than it is one nobody
 * would ever see. «At once» means at once.
 *
 * IT IS ALSO THE SCAN'S BOUND, AND THAT HALF IS A REACHABLE FAILURE RATHER
 * THAN TIDINESS (the two-axis review's Spec axis). A seat with no browser
 * registered is a post nothing can be delivered to, and a predicate with no
 * end would re-select every such post this twin has ever written on every
 * two-second poll, for the life of the process, growing without end. The
 * window makes the cost a function of the last four hours instead — and
 * reading `post_knocks` makes it a function of the knocks alone (tickets #276,
 * #358).
 *
 * WHAT IT COSTS is a runtime that was down for longer: its rep gets the cards
 * and no knock about them, which is the honest direction — an announcement of
 * something that happened overnight is not an announcement.
 */
const ANNOUNCE_WINDOW_MS = 4 * 60 * 60 * 1000;

/**
 * ...and how many one pass will open at once.
 *
 * A BOUND ON THE WORK OF ONE TICK, not on the backlog: the pass runs every two
 * seconds, so a seat that really has more waiting is caught up in the next one.
 * What this refuses is one tick that decrypts a hundred posts while the rep is
 * waiting on a draft.
 */
const ANNOUNCE_PER_PASS = 20;

/**
 * HOW LONG A FAILED ATTEMPT STANDS BEFORE IT IS MADE AGAIN, in milliseconds.
 *
 * FIVE MINUTES, AND WITHOUT IT A RETRY IS A STORM. A channel or a browser that
 * failed is attempted again — that is the whole of finding 3, which is a rail
 * dropping while mail is down — and the pass runs every two seconds, so a rule
 * that said only «attempt what has not succeeded» would put a request in front
 * of a refusing provider seven hundred times a minute, each one holding the
 * pass for its own deadline and writing a row. The old single record stopped
 * at the first failure and lost the message; the bound has to come back with
 * the retry rather than after it.
 *
 * LONG ENOUGH FOR AN OUTAGE TO END AND SHORT ENOUGH THAT A GRAVE EVENT IS NOT
 * LATE. A provider is usually back inside minutes, and the rep whose rail
 * dropped learns within one of them once it is; a spacing in hours would make
 * the retry a promise nobody could rely on.
 *
 * NOT A TOTAL CAP, deliberately. The at-once tier's own window is the total
 * bound for a knock, and a grave event has none on purpose: the rail is still
 * down, the rep still has not been told, and «stop trying» is not an answer a
 * notification about a lost rail may give.
 *
 * `@dito/notify` HOLDS THE SAME NUMBER FROM THE OTHER END, and the two are
 * separate on purpose rather than by oversight — `KNOCK_MAX`'s own argument
 * one file over: this package holds no dependency on that one and must not
 * (ADR-0013 class 4). What matters is the DIRECTION if they ever drift: this
 * spacing is at most notify's, so the tier can only over-ask.
 */
const RETRY_AFTER_MS = 5 * 60 * 1000;

/**
 * The instant a failed attempt stops standing, from the pass's own `now`.
 *
 * A FUNCTION RATHER THAN THE CONSTANT, so the spacing is argued in exactly one
 * place and every caller asks the same question of it.
 */
function retryCutoff(now: Date): Date {
  return new Date(now.getTime() - RETRY_AFTER_MS);
}

/**
 * WHETHER ANYTHING IS STILL OWED ABOUT ONE THING — the tier's whole memory,
 * as one SQL fragment two steps share (ticket #276).
 *
 * THE SEND RECORD IS THE MEMORY AND THE UNIT IS A DESTINATION. A row is one
 * attempt at one destination — a channel, and for a push the browser it was
 * addressed to — so «has this been announced» is «is there a destination this
 * has not reached», and the three ways the answer can be yes are the three
 * disjuncts below:
 *
 *   NEVER ASKED — there is no row about it at all. The first pass, and the
 *   only case a seat with no browser and no address ever reaches: notify then
 *   records the refusal, and the second pass reads it here and stops.
 *
 *   THE MAIL IS OWED — nothing about this stands for the email channel. That
 *   is what makes a dropped rail reach the rep by mail once mail is back, and
 *   by push meanwhile, without the one that succeeded being sent twice
 *   (finding 3). Only a type that mails asks it.
 *
 *   A LIVE BROWSER IS OWED — nothing about this stands for that subscription.
 *   With one row standing for a whole ask, a crash after the laptop and before
 *   the phone loses the phone's delivery for ever (finding 4).
 *
 * WHAT «STANDS» MEANS IS THE WHOLE RETRY RULE, and it is one clause: an
 * attempt stands unless it FAILED, and a failed one stands until
 * `RETRY_AFTER_MS` has passed. So a destination that was reached is never
 * attempted again, one that failed is attempted again on the first pass after
 * the spacing, and nothing is attempted on every tick. `standingAttempts` in
 * `@dito/notify` asks the same question of the same rows one step later.
 *
 * IT IS THE WEAKER PREDICATE ON PURPOSE, AND THAT IS WHAT KEEPS ONE RULE IN
 * ONE PLACE. Whether a subscription is a destination is notify's own question
 * and its answer is narrower than this one — it joins the granting login and
 * requires it unended and unexpired (finding 5). This asks only `ended_at IS
 * NULL`, so it can over-ask and never under-ask: an expired login's
 * subscription looks owed here, notify ends it instead of sending to it, and
 * the next pass sees an ended row and stops. The cost of erring this way is
 * one decrypt and one no-op ask; the cost of erring the other way is a
 * notification nobody gets.
 *
 * AND A BROWSER REGISTERED AFTER THE THING HAPPENED IS NOT A DESTINATION FOR
 * IT (`since`). Without that bound a rep who allows notifications at three in
 * the afternoon is knocked once for every draft of the preceding four hours —
 * a backlog on a lock screen, which is the digest ADR-0031 as amended
 * deliberately does not build. A device is told what happens from the moment
 * it exists.
 *
 * A NULL `channel` COUNTS AS EVERY CHANNEL, which is what it means: a row
 * written before …20260922100060 stands for the whole ask whatever it reached,
 * so reading one as neither channel would mail about yesterday's drop again.
 *
 * THE FIELDS ARE SQL EXPRESSIONS AND NEVER VALUES — a column of the outer
 * query for the knock tier, a placeholder for the grave-event one — and they
 * are NAMED rather than positional, because four interchangeable strings that
 * are silently transposable is a call site nobody can read (the two-axis
 * review's Standards axis).
 *
 * IT SPENDS TWO ALIASES AND A CALLER MAY NOT REUSE THEM: `n` for the send
 * record's own rows and `s` for the seat's registrations. An outer query that
 * named its table `n` would correlate this fragment to itself and fail on a
 * column that is not there, which is the kind loud failure the alias is worth
 * naming for.
 */
function stillOwed(about: {
  /** The reference the rows carry: `about_ref`. */
  readonly ref: string;
  /** The instant it happened — a browser registered after it is no destination. */
  readonly since: string;
  /** The message types this tier's own asks use. */
  readonly types: string;
  /** The seat whose browsers are the destinations. */
  readonly seat: string;
  /** The instant a failed attempt stops standing (`RETRY_AFTER_MS`). */
  readonly retryBefore: string;
  /** Whether this tier's type leaves by email as well. */
  readonly mails: boolean;
}): string {
  const mine = `n.about_ref = ${about.ref} AND n.message_type = ANY(${about.types})`;
  // AN ATTEMPT STANDS UNLESS IT FAILED, AND A FAILED ONE STANDS FOR A WHILE —
  // the module's own retry rule, as one clause both disjuncts read.
  const stands = `(n.outcome IS DISTINCT FROM 'failed' OR n.settled_at > ${about.retryBefore})`;
  const mailOwed = `NOT EXISTS (SELECT 1 FROM notify_sends n
                                 WHERE ${mine}
                                   AND (n.channel IS NULL OR n.channel = 'email')
                                   AND ${stands})`;
  return `(
    NOT EXISTS (SELECT 1 FROM notify_sends n WHERE ${mine}) OR
    ${about.mails ? `${mailOwed} OR` : ""}
    EXISTS (SELECT 1 FROM push_subscriptions s
                WHERE s.seat_id = ${about.seat}
                  AND s.ended_at IS NULL
                  AND s.created_at <= ${about.since}
                  AND NOT EXISTS (
                        SELECT 1 FROM notify_sends n
                         WHERE ${mine}
                           AND (n.channel IS NULL OR n.channel = 'push')
                           AND (n.channel IS NULL OR n.subscription_id = s.id)
                           AND ${stands}))
  )`;
}

/** The two messages the at-once tier sends, as the memory's own question reads them. */
const AT_ONCE_TYPES = ["draft_ready", "question_asked"];

/** ...and the two a grave event sends. */
const GRAVE_TYPES = ["rail_dropped", "rail_logged_out"];

/** What both steps need: the seam, the twin, the key that opens a post, the clock. */
export interface NotifyTierDeps {
  readonly db: pg.ClientBase;
  readonly twinId: string;
  readonly dek: Dek;
  /** Absent means this deployment announces nothing — see the module header. */
  readonly notify?: TwinNotifier;
}

/**
 * THE AT-ONCE TIER: every knock this seat has not been sent yet.
 *
 * WHICH TYPE A POST IS ANNOUNCED UNDER comes off the post's OWN PARTS and not
 * off anything a caller said: a post carrying a `question` part asked the rep
 * something, and one carrying a `draft` part is waiting on their tap. That is
 * the same rule the card draws its buttons by, read one layer down.
 *
 * THE SENTENCE IS OPENED HERE, under the twin's DEK, because this is the lease
 * holder and nothing else may (ADR-0010). What crosses to notify is the
 * knock's sentence and the post's id — never the draft's body, never a
 * counterparty, never a chat.
 *
 * ORDERED OLDEST FIRST AND BOUNDED AT BOTH ENDS, so a seat that was offline
 * for an hour is told about its waiting work in the order it arrived and one
 * tick never decrypts more than it should (`ANNOUNCE_WINDOW_MS`,
 * `ANNOUNCE_PER_PASS`).
 *
 * THE TIE IS BROKEN ON `id`, which is `readRailState`'s own rule one table
 * over: two rows can share a wall-clock instant, and without a second key the
 * window a `LIMIT` cuts is a different set of rows from one pass to the next.
 * The read takes `post_knocks_by_twin` (…20261004100010) in that order.
 *
 * WHAT THAT TIE-BREAK IS NOT is an arrival order: `posts.id` is a random uuid,
 * so two posts written in one microsecond come back in a STABLE order that
 * means nothing. Arrival order is a promise about instants the store really
 * recorded, and it is the only half worth asserting.
 */
export async function deliverPendingKnocks(
  deps: NotifyTierDeps,
  now: Date,
): Promise<number> {
  if (deps.notify === undefined) return 0;
  const seat = await seatOf(deps);
  if (seat === undefined) return 0;
  // EVERY KNOCK IS A `post_knocks` ROW (tickets #320, #364, #358): the
  // thread's knock tool wrote it about a post that waits — its landing knock,
  // or one a fired reminder owed. Each is announced from the instant it was
  // written, and each answers to the send record by the post's id and its
  // message type.
  const rows = await deps.db.query<{
    id: string;
    parts_enc: Buffer | null;
    knock_enc: Buffer;
    asks: boolean;
    subject: string | null;
  }>(
    `SELECT p.id, p.parts_enc, k.text_enc AS knock_enc,
            p.question_subject IS NOT NULL AS asks, k.subject
       FROM post_knocks k
       JOIN posts p ON p.id = k.post_id AND p.twin_id = k.twin_id
      WHERE k.twin_id = $1
        AND k.knocked_at > $2
        -- A KNOCK ABOUT A CARD THAT SETTLED BEFORE IT WENT OUT IS NOT NEWS
        -- (Codex r3): a draft sent, discarded or filled since the turn knocked.
        -- An answered question stays a candidate here and is re-read on
        -- its opened parts below.
        AND NOT EXISTS (SELECT 1 FROM taps t WHERE t.draft_id = p.draft_id)
        AND NOT EXISTS (SELECT 1 FROM draft_dismissals x WHERE x.draft_id = p.draft_id)
        AND NOT EXISTS (SELECT 1 FROM draft_fills f WHERE f.draft_id = p.draft_id)
        -- A LANDING KNOCK ASKS ABOUT THE AT-ONCE TIER'S OWN TWO MESSAGES, AND A
        -- REMINDER'S KNOCK ABOUT ITS OWN ONE (tickets #268, #364): both name the
        -- card in the same column, so an unqualified predicate would let the
        -- card's landing knock silence the reminder that fired for it today.
        AND ${stillOwed({
          ref: "p.id::text",
          since: "k.knocked_at",
          types: "(CASE WHEN k.subject IS NULL THEN $4::text[] ELSE ARRAY['reminder'] END)",
          seat: "$5",
          retryBefore: "$6",
          // A KNOCK NEVER MAILS (ADR-0031 as amended: email is for grave
          // events and for nothing else), so this tier has one channel.
          mails: false,
        })}
      ORDER BY k.knocked_at, p.id
      LIMIT $3`,
    [
      deps.twinId,
      new Date(now.getTime() - ANNOUNCE_WINDOW_MS),
      ANNOUNCE_PER_PASS,
      AT_ONCE_TYPES,
      seat,
      retryCutoff(now),
    ],
  );
  let announced = 0;
  for (const row of rows.rows) {
    const parts = row.parts_enc === null ? undefined : openSealedParts(deps.dek, row.parts_enc);
    // ...AND A QUESTION THE REP ANSWERED SINCE: the canvas's own reading of
    // whether it waits, on the opened post.
    if (row.asks && !(await stillAsks(deps, row.id))) continue;
    await deps.notify.send({
      // WHICH TYPE: a reminder's knock is a `reminder`; a landing knock's comes
      // off the post's own parts — a question part asks, any other hand-off
      // waits on a tap — and off its question subject, their plaintext half,
      // where a re-expressed post has no sealed parts.
      type:
        row.subject !== null
          ? "reminder"
          : (parts?.some((part) => part.kind === "question" || part.kind === "ask") ?? row.asks)
            ? "question_asked"
            : "draft_ready",
      seatId: seat,
      slots: { body: openKnock(deps.dek, row.knock_enc) },
      about: row.id,
    });
    announced += 1;
  }
  return announced;
}

/** Whether a question post still waits on the rep's answer, as the canvas reads it. */
async function stillAsks(deps: NotifyTierDeps, postId: string): Promise<boolean> {
  const post = (await readPostsByIds(deps, [postId], new Date())).get(postId);
  return post !== undefined && stillWaits(post);
}

/**
 * THE GRAVE EVENTS: the rail dropped, or the phone logged Dito out.
 *
 * NOTHING DETECTED A TRANSITION BEFORE THIS. Every reader of
 * `rail_status_events` takes the latest row and renders it, so «the rail has
 * been down since Tuesday» and «the rail just went down» were one fact. What
 * makes this a transition rather than a state is the send record, read about
 * the EVENT's own id: a rail that has been down all day mails once, because
 * the attempt that reached the rep stands for ever (`stillOwed`).
 *
 * IT LEAVES BY BOTH TRANSPORTS AND EACH IS ITS OWN ATTEMPT (ticket #276). A
 * rep whose rail dropped must be reachable whether or not they ever allowed
 * notifications, so the mail that failed is tried again — at a spacing, while
 * the rail is still down — and the push that went is never sent twice. With
 * one row for the whole ask, the mail's rejection settles it and the push is
 * skipped exactly when mail is down.
 *
 * ONLY THE NEWEST OF EACH, deliberately. A twin that reconnects six times in a
 * bad hour writes six `dropped` rows, and announcing every one of them is the
 * behaviour the tier exists to avoid — so the pass looks at the rail's own
 * latest row and announces that, which means a drop followed by a `linked`
 * announces nothing at all. A later drop is a later row and is its own event.
 *
 * `ORDER BY id` AND NOT BY `occurred_at`, which is this table's own rule
 * (…20260827100007): two transitions of one reconnect can share a wall-clock
 * instant, and the identity column breaks that tie the same way for every
 * reader.
 */
export async function announceRailTransition(
  deps: NotifyTierDeps,
  now: Date,
): Promise<boolean> {
  if (deps.notify === undefined) return false;
  const seat = await seatOf(deps);
  if (seat === undefined) return false;
  const latest = await deps.db.query<{
    id: string;
    status: string;
    occurred_at: Date;
  }>(
    `SELECT id::text AS id, status, occurred_at
       FROM rail_status_events
      WHERE twin_id = $1
      ORDER BY id DESC
      LIMIT 1`,
    [deps.twinId],
  );
  const row = latest.rows[0];
  if (row === undefined) return false;
  if (row.status !== "dropped" && row.status !== "logged_out") return false;
  // ONE ASK PER EVENT BECAME ONE ASK PER DESTINATION (ticket #276). A grave
  // event leaves by both transports, and a single row about it let an SES
  // rejection settle the ask and skip the push — so the pass now asks while
  // ANY destination is still owed, and notify attempts exactly those
  // (`stillOwed`).
  const owed = await deps.db.query(
    `SELECT 1 WHERE ${stillOwed({
      ref: "$1",
      since: "$2",
      types: "$3",
      seat: "$4",
      retryBefore: "$5",
      // ...AND A GRAVE EVENT LEAVES BOTH WAYS, which is the whole of finding 3:
      // the rep must be reachable whether or not they ever allowed
      // notifications (ADR-0022 as amended).
      mails: true,
    })}`,
    [
      row.id,
      row.occurred_at,
      GRAVE_TYPES,
      seat,
      retryCutoff(now),
    ],
  );
  if ((owed.rowCount ?? 0) === 0) return false;
  try {
    await deps.notify.send({
      type: row.status === "dropped" ? "rail_dropped" : "rail_logged_out",
      seatId: seat,
      // NO SLOTS AT ALL. A grave event is answered in one place and notify
      // fills both transports' links from the catalog and the deployment's own
      // origin — so this pass never names a page and cannot name a wrong one.
      slots: {},
      about: row.id,
    });
  } catch {
    // THE MAIL RAIL REFUSED, AND THE LOOP CARRIES ON. Notify has already
    // recorded the attempt with its outcome, so the fact is durable — and a
    // rep whose inbox bounced must not also lose their drafts (`runtime.ts`'s
    // fail-stop doctrine: infrastructure, never a message).
    return false;
  }
  return true;
}

/**
 * The seat this runtime's twin belongs to, or nothing.
 *
 * NOTHING IS ORDINARY AND NOT A FAULT: every integration suite in this package
 * drives a twin with no seat registry behind it, and a twin provisioned before
 * its seat existed is the same shape. A tier with no seat has nobody to reach,
 * which is not an error — it is the absence of a recipient.
 */
export async function seatOf(
  deps: NotifyTierDeps,
): Promise<string | undefined> {
  const rows = await deps.db.query<{ id: string }>(
    "SELECT id FROM seats WHERE twin_id = $1",
    [deps.twinId],
  );
  return rows.rows[0]?.id;
}
