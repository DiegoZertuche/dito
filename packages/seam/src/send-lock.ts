/**
 * THE SEND LOCK (tickets #24 and #224; ADR-0006, ADR-0017, ADR-0020).
 *
 * The single transactional path that mints a tap and its `customer_send`
 * command together (ADR-0006 — tap row + send_command row commit in one
 * transaction), enforces the hard send-allowlist and pacing as domain logic
 * (ADR-0017 — the plane stays dumb), and records every allowlist/pacing
 * refusal.
 *
 * The destination and twin are derived from the draft row itself — a caller
 * can never pair a tap with a foreign destination or twin. The matcher's
 * source event is the raw plane-delivered affirmation; model output can never
 * mint a tap.
 *
 * ═══ WHY IT LIVES IN THE SEAM AND NOT IN THE RUNTIME
 *
 * ADR-0006 gives the send lock TWO minters, and #224 built the second: the
 * rep taps **Enviar** on a card and rep-web writes the tap and the command
 * itself, under its own role, in one transaction — so the dashboard sends with
 * the runtime stopped (spec #214 story 8). Both minters must run THIS logic
 * rather than a copy of it, because a second copy is a second answer to «is
 * this destination allowed» and «has this twin sent too much», and the whole
 * point of ADR-0017 is that those answers are the writer's.
 *
 * rep-web may not depend on `@dito/twin-runtime` — that package holds the
 * bundle, the KMS client and every automation registry, and rep-web holds no
 * key (ADR-0008, ADR-0010) — so the shared logic moved to the package both
 * sides already read. It belongs here on its own merits: it is Postgres and
 * nothing else. No bundle, no DEK, no model, no HTTP.
 *
 * ═══ THE REFUSAL'S RECORD IS A PARAMETER, AND THAT IS THE WHOLE MOVE
 *
 * A chain key in rep-web's environment is not an option (ADR-0002,
 * ADR-0008), and this package must not learn `@dito/audit` — so the writer
 * takes a `RefusalRecorder` and the composition root decides what recording
 * means: the runtime appends to the chain in the same transaction, and
 * rep-web writes `send_refusals`, which the lease holder chains at its next
 * pass (`deferRefusal` argues it).
 */
import type pg from "pg";
import { isOwnId } from "./ids.js";

/**
 * THE TAP MINTERS, as a closed set (ADR-0006: "one taps table, two
 * minters"; ticket #224).
 *
 * `affirmation_matcher` is the rep quoting a Borrador with «va» in their own
 * WhatsApp thread; `rep_web` is the rep tapping **Enviar** on the card. They
 * are the two non-model paths ADR-0006 names, and `taps_minter_check` holds
 * exactly these words — `migration-vocabulary.test.ts` compares the two, so a
 * minter the code writes that the store refuses is a red build rather than a
 * constraint violation in front of a rep whose message did not go.
 *
 * IT IS A CLOSED SET AND NOT A UNION OF TWO STRINGS because two stores read
 * it: `taps.minter` and `send_refusals.minter`. A third keyless minter needs
 * no migration for the second of those, which is the point of pinning one
 * vocabulary rather than two lists.
 */
export const TAP_MINTERS = ["affirmation_matcher", "rep_web"] as const;

/** One of the two. */
export type TapMinter = (typeof TAP_MINTERS)[number];

/** Per-twin pacing thresholds, as the `pacing_thresholds` config row carries them. */
export interface PacingThresholds {
  maxSendsPerHour: number;
  minSecondsBetweenSends: number;
}

/**
 * The conservative dev values (slice AC 8, ADR-0017): what rig provisioning
 * seeds into `pacing_thresholds` for a dev twin. Deliberately far below any
 * human sales pace — during development the rig number must never behave
 * like a bot (spec #18, story 17). Thresholds remain config: this constant
 * is the seed, never a fallback — a twin with no config row cannot send.
 */
export const CONSERVATIVE_DEV_PACING: PacingThresholds = {
  maxSendsPerHour: 30,
  minSecondsBetweenSends: 60,
};

/**
 * ONE SEND REQUEST, WITH THE BASIS ITS MINTER HAS (ticket #224).
 *
 * A UNION AND NOT AN OPTIONAL FIELD, because the two minters differ in
 * exactly this: the matcher's tap is pinned to the raw plane-delivered
 * affirmation that minted it and cannot exist without one, while a tap from
 * the dashboard has no seam event at all — the rep pressed a button on a page
 * they were authenticated to. `taps_matcher_requires_event_check` states the
 * same rule in SQL and has since slice 1 (…20260826100003, which anticipated
 * this minter by name), so the type and the constraint say one thing twice.
 */
export type CustomerSendRequest =
  | {
      readonly minter: "affirmation_matcher";
      /** The affirmed draft — destination and twin derive from its row. */
      readonly draftId: string;
      /** The raw plane-delivered affirmation event (wa_events id). */
      readonly sourceEventId: string;
    }
  | {
      readonly minter: "rep_web";
      readonly draftId: string;
    };

/** Why a send was refused. Refusal microcopy lives in the twin (ADR-0017). */
export type RefusalReason =
  | "no_valid_tap"
  | "already_tapped"
  | "off_allowlist"
  | "pacing"
  | "pacing_unconfigured"
  | "send_in_flight"
  | "dismissed"
  | "blank_open";

export type CustomerSendResult =
  | { outcome: "written"; tapId: string; commandId: string }
  | { outcome: "refused"; reason: RefusalReason };

export interface SendLockWriter {
  requestCustomerSend(req: CustomerSendRequest): Promise<CustomerSendResult>;
}

/**
 * THE REFUSAL, AS THE CHAIN WOULD PHRASE IT — caller identity, action type,
 * opaque refs, outcome, and nothing else (ADR-0020).
 *
 * Composed HERE rather than by each recorder, so the chained entry and the
 * deferred row carry the same four fields and a reader of either cannot tell
 * which minter was holding a key.
 */
export interface SendRefusal {
  /** The minter that was refused — the chain's caller identity. */
  readonly caller: TapMinter;
  readonly action: "customer_send";
  /** Opaque ids only: never a JID, never content. */
  readonly ref: string;
  /** `refused:<reason>`. */
  readonly outcome: string;
  /** The twin and draft again, typed, for a recorder that writes a ROW. */
  readonly twinId: string;
  readonly draftId: string;
  readonly reason: RefusalReason;
}

/**
 * How a refusal is recorded, injected by the composition root.
 *
 * IT RUNS INSIDE THE WRITER'S OWN TRANSACTION, after the rollback to the
 * send-attempt savepoint — so the record and the rolled-back attempt commit
 * together, which is what makes «the attempt persists nothing but its
 * record» true (`refuse` below).
 */
export type RefusalRecorder = (
  db: pg.ClientBase,
  refusal: SendRefusal,
) => Promise<void>;

/**
 * THE RECORDER FOR A MINTER THAT HOLDS NO CHAIN KEY (ticket #224; ADR-0002,
 * ADR-0008, ADR-0020).
 *
 * rep-web must be able to refuse a send — a «va» on a draft the rep already
 * dismissed is the AC's own case — and a refusal whose only trace would be a
 * chain entry cannot go unrecorded (Diego's rule, quoted in
 * `audit-coverage.ts`: the chain covers acts whose only trace it would be).
 * But chaining needs the rep key, and putting that key in the dashboard's
 * environment would give the process on the far side of the custody boundary
 * the ability to write the record that audits it.
 *
 * So the ROW IS THE RECORD AND THE CHAIN ENTRY IS OWED. rep-web writes
 * `send_refusals` in the same transaction as the rolled-back attempt, and the
 * runtime drains it onto the chain at its next wake — `crossPendingBindings`'
 * shape and its reason, idempotent on `chained_at`.
 *
 * WHAT THAT COSTS, SAID OUT LOUD: between the refusal and the runtime's next
 * wake the entry does not exist, and a deployment whose runtime never starts
 * again would leave the row unchained for ever. The row is immutable and
 * append-only either way, so what is at risk is the ORDERING evidence a chain
 * gives, never the fact. A rep-web that chained directly would put the key
 * one process further out, which is the worse trade.
 */
export const deferRefusal: RefusalRecorder = async (db, refusal) => {
  await db.query(
    `INSERT INTO send_refusals (twin_id, draft_id, minter, reason)
     VALUES ($1, $2, $3, $4)`,
    [refusal.twinId, refusal.draftId, refusal.caller, refusal.reason],
  );
};

/**
 * Where the writer's own transaction comes from.
 *
 * NARROWED TO `connect`, which is `LocalApiSessions`' shape and its reason:
 * the runtime hands a `pg.Pool` and rep-web hands a checkout that has already
 * declared its company and asserted its role (`rep-connection.ts`), and this
 * module needs no opinion about which. What it does need is a session of its
 * own — the attempt opens a transaction and takes an advisory lock, so a
 * connection somebody else has a transaction open on is the one thing it
 * cannot use.
 */
export interface SendLockSessions {
  connect(): Promise<pg.PoolClient>;
}

export function createSendLockWriter(opts: {
  sessions: SendLockSessions;
  /** What recording a refusal means here — the chain, or a row (see the header). */
  recordRefusal: RefusalRecorder;
}): SendLockWriter {
  const { sessions, recordRefusal } = opts;

  async function requestCustomerSend(
    req: CustomerSendRequest,
  ): Promise<CustomerSendResult> {
    const client = await sessions.connect();
    try {
      await client.query("BEGIN");
      try {
        const result = await attemptSend(client, req, recordRefusal);
        await client.query("COMMIT");
        return result;
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    } finally {
      client.release();
    }
  }

  return { requestCustomerSend };
}

/** The seam's own row id, which is a bigint identity. */
const BIGINT_RE = /^\d{1,18}$/;

/**
 * ONE DECISION AT A TIME PER TWIN — a send, or a dismissal of one.
 *
 * The lock is transaction-scoped, so it releases with the commit, and it is
 * BLOCKING rather than a try: the loser waits and then reads the rows the
 * winner wrote, which is the whole point. Lock order is twin lock first,
 * audit tail lock second, everywhere.
 *
 * WHY THE SEND PATH NEEDS IT: the pacing reads must see every committed
 * command before deciding, or two concurrent sends could both slip under the
 * cap (ADR-0017).
 *
 * WHY A DISMISSAL NEEDS THE SAME ONE (#224, Codex r1 — a reachable failure).
 * A dismissal is the anti-tap: it refuses when the draft carries a tap, and
 * the send writer refuses when the draft carries a dismissal. Each therefore
 * decides on the other's absence — so without a shared lock, an **Enviar**
 * and a **Descartar** arriving together both read an untouched draft and both
 * commit, into different tables that no constraint spans. The customer gets
 * the message and the rep is told it was discarded, which is the one pair of
 * outcomes that must never both be true.
 *
 * IT IS THE DASHBOARD THAT MAKES IT NECESSARY (#224) rather than anything
 * about #30, where the act was written. A tap the lease holder mints and a
 * dismissal the lease holder performs are one pass apart by construction —
 * one process, serially. ADR-0006's second minter runs in another process on
 * another connection, and rep-web's **Enviar** waits for nobody's pass.
 */
export async function lockTwinForSend(
  client: pg.ClientBase,
  twinId: string,
): Promise<void> {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended('dito:send_lock:twin:' || $1, 0))",
    [twinId],
  );
}

/** The send attempt, inside the caller's open transaction. */
export async function attemptSend(
  client: pg.ClientBase,
  request: CustomerSendRequest,
  recordRefusal: RefusalRecorder,
): Promise<CustomerSendResult> {
  // A malformed reference is a request without a valid tap basis — refused,
  // never an internal error (AC 1). Validated up front so the typed-column
  // lookups below can never abort the transaction on syntax, and
  // canonicalized to Postgres's lowercase uuid form so payload_ref always
  // matches the stored draft_id (FR-70's canonical-ref check).
  const sourceEventId =
    request.minter === "affirmation_matcher" ? request.sourceEventId : null;
  if (
    !isOwnId(request.draftId) ||
    (sourceEventId !== null && !BIGINT_RE.test(sourceEventId))
  ) {
    return { outcome: "refused", reason: "no_valid_tap" };
  }
  const req = { ...request, draftId: request.draftId.toLowerCase() };

  const draftRes = await client.query(
    "SELECT twin_id, destination FROM drafts WHERE id = $1",
    [req.draftId],
  );
  const draft = draftRes.rows[0];
  if (draft === undefined) {
    return { outcome: "refused", reason: "no_valid_tap" };
  }

  // The matcher's tap basis is the raw plane-delivered event, and it must
  // belong to the draft's own twin — an affirmation from another twin's
  // stream can never release this draft (ADR-0006; the #19 hand-off's
  // same-twin binding).
  //
  // A REP-WEB TAP HAS NO EVENT TO CHECK, and the equivalent binding is one
  // layer out: rep-web reaches a draft only through the feed of the seat its
  // own session authenticated, and the API scopes that feed to the seat's
  // twin (`local-api.ts` fence 3). What keeps the pair honest in the STORE is
  // FR-70's own source-less class, which compares this tap's draft's twin
  // against its command's — the check the matcher's arm below does in code,
  // done independently over the rows afterwards (`fr70.ts`, ticket #224).
  if (sourceEventId !== null) {
    const eventRes = await client.query(
      "SELECT twin_id FROM wa_events WHERE id = $1",
      [sourceEventId],
    );
    const sourceEvent = eventRes.rows[0];
    if (sourceEvent === undefined || sourceEvent.twin_id !== draft.twin_id) {
      return { outcome: "refused", reason: "no_valid_tap" };
    }
  }

  // One send decision at a time per twin, and one decision ABOUT a send
  // (`lockTwinForSend` argues both).
  await lockTwinForSend(client, draft.twin_id);

  // The single-use lock: UNIQUE(draft_id) on taps. The savepoint keeps the
  // transaction healthy when the constraint fires, so the late loser's
  // refusal can still commit whatever the refusal path writes.
  await client.query("SAVEPOINT send_attempt");

  // The dismissed draft (ticket #30; spec #29 grilling decision 1): a
  // terminal dismissal is the anti-tap — a «va» on a dismissed draft is
  // refused and recorded like every other trust event (ADR-0020), so a dead
  // draft can never quietly come back to life and send.
  const dismissedRes = await client.query(
    "SELECT 1 FROM draft_dismissals WHERE draft_id = $1",
    [req.draftId],
  );
  if (dismissedRes.rows.length > 0) {
    return refuse(client, recordRefusal, req, draft.twin_id, "dismissed");
  }
  // A BLANK STILL OPEN (ticket #342): the body carries its marker, and Enviar
  // is never disabled, so the writer refuses it on both minters
  // (…20261006100020 argues why the rows are immutable).
  const blankRes = await client.query(
    "SELECT 1 FROM draft_blanks WHERE draft_id = $1 LIMIT 1",
    [req.draftId],
  );
  if (blankRes.rows.length > 0) {
    return refuse(client, recordRefusal, req, draft.twin_id, "blank_open");
  }
  let tapId: string;
  try {
    const tapRes = await client.query(
      `INSERT INTO taps (draft_id, minter, source_event_id)
       VALUES ($1, $2, $3) RETURNING id`,
      [req.draftId, req.minter, sourceEventId],
    );
    tapId = tapRes.rows[0].id;
  } catch (err) {
    await client.query("ROLLBACK TO SAVEPOINT send_attempt");
    if (sqlState(err) === "23505") {
      // Ya se envió: the draft is already tapped (ADR-0006's late loser).
      return { outcome: "refused", reason: "already_tapped" };
    }
    throw err;
  }

  // The hard send-allowlist (ADR-0017): domain logic here at the writer,
  // fail-closed — a destination is sendable only if its row exists.
  const allowRes = await client.query(
    "SELECT 1 FROM send_allowlist WHERE twin_id = $1 AND destination_jid = $2",
    [draft.twin_id, draft.destination],
  );
  if (allowRes.rows.length === 0) {
    return refuse(client, recordRefusal, req, draft.twin_id, "off_allowlist");
  }

  // Pacing (ADR-0017): configured limits count this twin's customer_send
  // commands, including failed and held attempts.
  const pacingRes = await client.query(
    `SELECT max_sends_per_hour, min_seconds_between_sends
       FROM pacing_thresholds WHERE twin_id = $1`,
    [draft.twin_id],
  );
  const pacing = pacingRes.rows[0];
  if (pacing === undefined) {
    // Fail closed (ADR-0017): a twin nobody configured pacing for is a twin
    // that cannot send — never a twin with no limits.
    return refuse(
      client,
      recordRefusal,
      req,
      draft.twin_id,
      "pacing_unconfigured",
    );
  }
  // clock_timestamp(), never now(): now() pins to transaction start, so a
  // send that waited on the twin lock longer than the gap would compare —
  // and stamp itself — with a pre-wait time, letting the next send treat it
  // as already old (two sends seconds apart on the wire).
  //
  // The history is customer_send only (integration adjudication on #25):
  // pacing governs what this writer writes — customer-facing sends, the
  // enforcement-risk surface ADR-0017 watches. The twin's own thread posts
  // (system_send: drafts, confirmations) are the product's own surface;
  // counting them would make every affirmation arriving inside the min gap
  // of its own draft post mechanically refusable, and the magic loop could
  // never close at rig pacing.
  // The measured instant is the WIRE moment, not the mint moment (Codex
  // round 2): a command minted before a plane outage executes at
  // recovery, long after its created_at aged past any gap. The
  // executor's claim (send_attempts.attempted_at) is when the rail was
  // actually touched — COALESCE falls back to created_at for commands
  // never attempted, the conservative reading either way (held attempts
  // included: the send may have left).
  const gapRes = await client.query(
    `SELECT 1 FROM send_commands sc
       LEFT JOIN send_attempts sa ON sa.command_id = sc.id
      WHERE sc.twin_id = $1
        AND sc.send_class = 'customer_send'
        AND COALESCE(sa.attempted_at, sc.created_at)
              > clock_timestamp() - make_interval(secs => $2)
      LIMIT 1`,
    [draft.twin_id, pacing.min_seconds_between_sends],
  );
  if (gapRes.rows.length > 0) {
    return refuse(client, recordRefusal, req, draft.twin_id, "pacing");
  }
  const hourRes = await client.query(
    `SELECT count(*)::int AS sends FROM send_commands sc
       LEFT JOIN send_attempts sa ON sa.command_id = sc.id
      WHERE sc.twin_id = $1
        AND sc.send_class = 'customer_send'
        AND COALESCE(sa.attempted_at, sc.created_at)
              > clock_timestamp() - interval '1 hour'`,
    [draft.twin_id],
  );
  if (hourRes.rows[0].sends >= pacing.max_sends_per_hour) {
    return refuse(client, recordRefusal, req, draft.twin_id, "pacing");
  }
  // At most one outstanding customer_send per twin (#25, ADR-0017).
  // Unattempted commands use created_at for pacing; a prolonged plane
  // outage could otherwise admit a backlog that sends back-to-back on
  // recovery. Refuse a new command until the pending one settles, then
  // the rep can tap again.
  const inFlightRes = await client.query(
    `SELECT 1 FROM send_commands
      WHERE twin_id = $1 AND send_class = 'customer_send' AND outcome IS NULL
      LIMIT 1`,
    [draft.twin_id],
  );
  if (inFlightRes.rows.length > 0) {
    return refuse(client, recordRefusal, req, draft.twin_id, "send_in_flight");
  }

  const commandRes = await client.query(
    `INSERT INTO send_commands (twin_id, send_class, destination, payload_ref, tap_id, draft_id, created_at)
     VALUES ($1, 'customer_send', $2, $3, $4, $5, clock_timestamp()) RETURNING id`,
    [
      draft.twin_id,
      draft.destination,
      `draft:${req.draftId}`,
      tapId,
      req.draftId,
    ],
  );
  return { outcome: "written", tapId, commandId: commandRes.rows[0].id };
}

/**
 * Refuses the attempt: rolls the tap (and anything else) back to the
 * savepoint, then records a content-free refusal — caller identity, action
 * type, opaque refs, outcome; never a JID, never content (ADR-0020). Record
 * and rollback commit together in the surrounding transaction.
 */
async function refuse(
  client: pg.ClientBase,
  recordRefusal: RefusalRecorder,
  req: CustomerSendRequest,
  twinId: string,
  reason: RefusalReason,
): Promise<CustomerSendResult> {
  await client.query("ROLLBACK TO SAVEPOINT send_attempt");
  await recordRefusal(client, {
    caller: req.minter,
    action: "customer_send",
    ref: `twin:${twinId} draft:${req.draftId}`,
    outcome: `refused:${reason}`,
    twinId,
    draftId: req.draftId,
    reason,
  });
  return { outcome: "refused", reason };
}

/** The SQLSTATE code carried by a Postgres error, if any. */
function sqlState(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null && "code" in err) {
    return String((err as { code?: unknown }).code);
  }
  return undefined;
}
