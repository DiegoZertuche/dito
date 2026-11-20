/**
 * SCOPE IN AND SCOPE OUT, AS REP ACTS (ticket #222; spec #214 decisions 5 and
 * 7, *Link day, in detail*; ADR-0003 class 2, ADR-0020, ADR-0023).
 *
 * Scoping is what the rep says the twin may read, and it is a STANDING
 * capability rather than a one-shot at pairing: «a chat scoped in from
 * Conexiones on a later day fills its history; scoped out, the guard drops its
 * next message at the socket» (spec #214 DoD 7).
 *
 * ═══ FUNCTIONS, NOT ROUTES
 *
 * These are the acts, and #223 built their door: two entries in
 * `TWIN_API_ACT_ROUTES`, two verbs beside them, and an arm in
 * `dashboard-acts.ts`' switch — which is the act door rather than a handler of
 * its own, because a scope switch is a rep decision recorded as class-2
 * evidence exactly as **Descartar** is. Written as functions all the same: the
 * act is three writes over three stores and belongs to the runtime, and an
 * HTTP handler that also held them would be two things to move the next time a
 * surface arrives.
 *
 * SO A SCOPE ACT LEAVES TWO CHAIN ENTRIES, one per class of act, which is
 * `retract_line`'s own shape and not a doubling: the aperture chains
 * `fact_retraction` for the correction and the runner chains `execution` for
 * the run, and audit coverage enumerates each separately. Here the pair is
 * `scope_change` (this module's, over the request row) and `execution` (the
 * dashboard act's, over the record) — and `dashboardActId` is what lets a
 * reader walk from either to the other.
 *
 * ═══ THREE WRITES IN THE CALLER'S TRANSACTION, AND THE ORDER IS THE POINT
 *
 * IT TAKES A TRANSACTION OPEN AND DOES NOT OPEN ONE. Two reasons, and the
 * second is the mechanical one. A scope act is now performed INSIDE a dashboard act,
 * whose own transaction encloses the evidence row, the execution's record and
 * its chain entry — and `withDbTransaction` does not nest, so an inner BEGIN
 * would COMMIT the outer act halfway through and the append after it would
 * refuse in autocommit. And `appendAuditEntry` already obliges every caller to
 * have one: a function that chains is a function whose caller holds the
 * transaction, so this is the shape rather than a concession.
 *
 * A scope act is:
 *
 *   1. the ALLOWLIST row — written on the way in, deleted on the way out.
 *      This is the act itself: the capture guard reads `scope_allowlist` per
 *      event with no caching (ADR-0023), so the moment this commits, the
 *      guard's answer for that chat has changed. Nothing has to tell the
 *      plane, which is why "instant descope" is mechanically true rather
 *      than cache-dependent.
 *   2. the REQUEST row — what the plane owes because of it. On the way in
 *      that is the ninety-day fill; on the way out it is an acknowledgement,
 *      because there is nothing left for the plane to do (`plane/fill`'s
 *      ScopeOut says so in full).
 *   3. the CHAIN entry — one content-free entry per act (ADR-0020,
 *      spec #48 decision 18: "Rep acts and refusals are audit-chained").
 *
 * ALL THREE OR NONE. A committed allowlist row with no request row would be a
 * chat the twin reads and never fills; a committed request row with no
 * allowlist row would be a fill whose pages the guard then drops as
 * out-of-scope, page after page, with a notification on the rep's phone for
 * each. The CALLER's transaction is what makes both unrepresentable, and it is
 * the same transaction the act row and the execution commit in.
 *
 * ═══ WHAT SCOPE-OUT DOES NOT DO
 *
 * It removes nothing from the bundle. What was captured while the chat was in
 * scope stays — exactly as it would if the rep had descoped a chat their phone
 * had already synced — and deleting ingested content on scope-out is on the
 * horizon ([#117](https://github.com/Dito-Core/dito/issues/117)), recorded at
 * spec #214's *Out of Scope*.
 *
 * ═══ IDEMPOTENT, AND STILL AN ACT
 *
 * A rep who taps a switch twice performs two acts, and both are chained: the
 * chain records ACTS, not state changes, which is the reading
 * `audit-coverage.ts` already applies to the binding confirmation ("an
 * idempotent repeat marks `binding_confirmed` too and chains
 * `already_filed`"). So the allowlist write is `ON CONFLICT DO NOTHING`, the
 * delete may match nothing, and the outcome on the entry says which it was.
 */
import { appendAuditEntry } from "@dito/audit";
import { PLANE_REQUEST_KINDS, type PlaneRequestKind } from "@dito/seam";
import type pg from "pg";

/** What a scope act needs: a seam connection, the chain's key, and the twin. */
export interface ScopeActDeps {
  readonly db: pg.ClientBase;
  readonly hmacKey: Uint8Array;
  readonly twinId: string;
  /**
   * The `dashboard_acts` row this scope act was performed as, when a SURFACE
   * asked for it (ticket #223).
   *
   * OPTIONAL BECAUSE THE ACT IS NOT THE DOOR. These are the acts; the door is
   * a dashboard act, which mints an evidence row before it calls in here. What the id buys is that a reader of the chain can WALK from the
   * `scope_change` entry to the evidence and from the evidence to the
   * execution: without it the entry says which chat's request moved and
   * nothing about who asked, and the execution's own entry says who asked and
   * nothing about which chat. Two entries that cannot be joined are two
   * records of one act.
   *
   * ABSENT MEANS NOBODY PRESSED ANYTHING, which is the honest state for a
   * caller that is not a surface — a rig script, or a future automation. The
   * token is rendered as `act:none` rather than omitted, for `triggerRef`'s
   * own reason: a ref is read by a person, and a fixed number of tokens means
   * «was there an act behind this» is answered by looking at the same position
   * every time.
   */
  readonly dashboardActId?: string;
}

/**
 * What one scope act produced: the request the plane will serve, and whether
 * the allowlist actually moved.
 *
 * `changed` IS NOT "DID IT WORK". It says whether this act was the one that
 * moved the allowlist — false on a rep tapping a switch that was already in
 * that position — and a surface may use it to say «ya estaba» rather than to
 * report a failure. The act happened either way and the chain says so.
 */
export interface ScopeAct {
  readonly requestId: string;
  readonly changed: boolean;
}

/** The caller that mints these acts, as the chain records it. */
const SCOPE_CALLER = "twin-runtime/scoping";

/**
 * A CHAT, AS BOTH ITS SPELLINGS.
 *
 * A modern DM is addressed by a hidden-user identity (a LID) and by a phone
 * number, and the plane's own canonicalization says out loud that «without an
 * alternative the LID itself is the identity — the allowlist can carry it».
 * So the allowlist may hold either, and an act that named one of them would be
 * an act about half a chat (`scopeChatOut` argues the consequence).
 */
export interface ScopeChat {
  /** The identity the directory row is keyed on — the act's own subject. */
  readonly chatJid: string;
  /** ...and the other spelling, when the plane has learned one. */
  readonly lidJid?: string | null;
}

/**
 * The rep marks a chat: the twin may read it from now on, and the plane owes
 * it the last ninety days.
 *
 * ONE ROW AND NOT TWO, deliberately: the guard resolves the pair on the way
 * IN, so allowing either spelling allows the chat, and a second row would be a
 * second thing to delete on the way out.
 */
export async function scopeChatIn(
  deps: ScopeActDeps,
  chat: ScopeChat,
): Promise<ScopeAct> {
  return act(deps, chat, "scope_in");
}

/**
 * The rep unmarks a chat: the guard drops its next message at the socket, on
 * the same uncached read, the moment this commits.
 *
 * BOTH SPELLINGS GO (Codex r1/r2). The guard asks «is this chat allowed» of
 * either identity, and a chat first seen LID-addressed is scoped in under its
 * LID — so deleting only the identity the directory row is keyed on today
 * would leave the other row allowed and the plane still capturing, with the
 * page showing a switch that will not move. The delete names both, which is
 * also why `changed` stays honest: it counts the rows that actually went.
 */
export async function scopeChatOut(
  deps: ScopeActDeps,
  chat: ScopeChat,
): Promise<ScopeAct> {
  return act(deps, chat, "scope_out");
}

/**
 * The one act both directions are, because they differ in exactly one
 * statement — the allowlist write — and everything else about them is the
 * same three-write transaction. Two copies of this would be two places for the
 * request row, the chain entry and the transaction boundary to drift.
 */
async function act(
  deps: ScopeActDeps,
  chat: ScopeChat,
  kind: Extract<PlaneRequestKind, "scope_in" | "scope_out">,
): Promise<ScopeAct> {
  const chatJid = chat.chatJid;
  const moved =
    kind === "scope_in"
      ? await deps.db.query(
          `INSERT INTO scope_allowlist (twin_id, chat_jid) VALUES ($1, $2)
           ON CONFLICT (twin_id, chat_jid) DO NOTHING`,
          [deps.twinId, chatJid],
        )
      : await deps.db.query(
          `DELETE FROM scope_allowlist
            WHERE twin_id = $1 AND chat_jid = ANY($2::text[])`,
          [
            deps.twinId,
            chat.lidJid == null ? [chatJid] : [chatJid, chat.lidJid],
          ],
        );
  const changed = (moved.rowCount ?? 0) > 0;
  const request = await deps.db.query<{ id: string }>(
    `INSERT INTO plane_requests (twin_id, kind, chat_jid)
     VALUES ($1, $2, $3) RETURNING id`,
    [deps.twinId, kind, chatJid],
  );
  const requestId = request.rows[0]?.id;
  if (requestId === undefined) {
    throw new Error(
      `the scope ${kind} request for twin ${deps.twinId} wrote no row — the plane would never be asked`,
    );
  }
  await appendAuditEntry(deps.db, deps.hmacKey, {
    caller: SCOPE_CALLER,
    action: "scope_change",
    // OPAQUE IDS AND ONE WORD (ADR-0020). The chat is NOT among them: it is
    // the one identity this entry could carry and the wall's whole point is
    // that the chain is content-free — so the request row is what names the
    // chat, and the entry names the request. A reader following the chain
    // reaches the chat through a row a grant governs, rather than through
    // the chain itself.
    //
    // ...AND THE ACT, WHEN A SURFACE ASKED (ticket #223). `ScopeActDeps`
    // argues why the token is here and why it reads `none` rather than being
    // omitted. It is a third opaque id and no wider than the two beside it.
    ref: `twin:${deps.twinId} request:${requestId} act:${deps.dashboardActId ?? "none"}`,
    outcome: `${kind}:${changed ? "moved" : "unchanged"}`,
  });
  return { requestId, changed };
}

/**
 * The two kinds a scope act writes, for the test that pins them against the
 * store's own vocabulary. `PLANE_REQUEST_KINDS` holds the third,
 * `pairing_code`, which is not a scope act: it is the link ask, written by
 * `link.ts` (#223), which chains nothing because nobody chose a target.
 */
export const SCOPE_ACT_KINDS = PLANE_REQUEST_KINDS.filter(
  (kind) => kind !== "pairing_code",
);

/**
 * FR-15'S NINETY DAYS, as the number a twin is provisioned with (spec #214
 * decision 8: "History per included chat is the last 90 days, a product
 * default owned as an ordinary primitive, tunable per twin later").
 *
 * IT IS SEEDED, NOT READ. The plane reads the twin's `history_windows` row
 * with one SELECT per fill and never this constant — a number compiled into
 * the plane cannot be tuned for one twin without a deploy, and a fill with no
 * row is REFUSED by name rather than filled to a guess. This is what
 * `rig-provision.ts` writes into that row, beside the pacing thresholds, so
 * the number the store holds and the number the scoping page promises («Dito
 * lee los últimos 90 días de los chats que marques») are one value stated
 * once.
 */
export const DEFAULT_HISTORY_WINDOW_DAYS = 90;
