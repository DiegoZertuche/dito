/**
 * The aperture's two input classes (ticket #50; ADR-0003).
 *
 *   CLASS 1 — candidate facts: model output. Untrusted, confidence-gated;
 *             below threshold a candidate becomes a question, never a fact.
 *   CLASS 2 — rep acts: confirmations, corrections, retractions, entity
 *             create/rename. Each MUST reference verifiable rep-act
 *             evidence — matched by DETERMINISTIC CODE, never by model
 *             output. **Anything not evidence-bound is processed as class 1.**
 *
 * That last sentence is the whole reason this module exists as a function
 * rather than as a convention. The aperture never takes a caller's word
 * that something is a rep act: it re-reads the row the claim cites for
 * itself and checks the claim against what is actually there.
 * Model-laundered "rep corrections" are one of the two failure modes
 * ADR-0003 exists to prevent, and the defence is that a model cannot produce
 * a row in a store it cannot write.
 *
 * EVIDENCE IS ONE OF THREE SURFACES (tickets #224 and #261; spec #214
 * decision 2; spec #258 decision 2). A thread act cites the WA message id of a
 * rep-authored, raw plane-delivered message, re-read and decrypted under the
 * twin DEK; a DASHBOARD act cites a `dashboard_acts` row the runtime's local
 * API wrote for an authenticated request; a DASHBOARD MESSAGE cites a
 * `dashboard_messages` row the same API wrote for the rep's own words under an
 * open login session. `RepActEvidence` argues what makes each one the rep's
 * own, and one function decides all three — so "a dashboard act and a thread
 * act are one act" (user story 35) is a property of the code rather than a
 * claim about it, and the rep teaching their twin from either door is the same
 * property read again.
 *
 * The verified act is also where the COMPANY SCOPE comes from. Entity ids
 * are client-minted (ADR-0035), and client-supplied ids are client-supplied
 * data — so the aperture reads company and seat off the row the plane
 * stamped, and offers no parameter through which a device could supply one.
 */
import {
  decodeWaMessagePayload,
  decodeWaOpaquePayload,
  decodeWaReactionPayload,
  isOwnId,
  opaquePlaceholder,
  WaPayloadError,
  type WaMessagePayload,
  type WaOpaquePayload,
  type WaReactionPayload,
} from "@dito/seam";
import type { Dek } from "@dito/crypto";
import type pg from "pg";

/** What the aperture needs to reach its stores. Seat-scoped, not session-scoped (ADR-0003). */
export interface ApertureContext {
  readonly db: pg.ClientBase;
  /** The twin's data key — the aperture decrypts rep-act evidence itself. */
  readonly dek: Dek;
}

/**
 * What performing a CLASS-2 REP ACT needs on top of that: the audit chain's
 * HMAC key (ticket #54; ADR-0020; spec #48 decision 18 — "rep acts and
 * refusals are audit-chained").
 *
 * A separate type rather than a field on `ApertureContext`, because the
 * distinction it draws is the one that matters: the paths that perform a
 * rep act ask for the key IN THEIR SIGNATURE, and the paths that do not —
 * a class-1 candidate fact, the reads, the questions store, the
 * finalization clock — cannot chain by accident and are not made to hold a
 * key they have no business with. Adding a rep act later is therefore a
 * typecheck away from the chain rather than a convention away from it.
 */
export interface RepActContext extends ApertureContext {
  /** At least 32 bytes; every chain entry point refuses a weaker one. */
  readonly hmacKey: Uint8Array;
}

/**
 * How an entity is named anywhere inside the Ledger: the client-minted id
 * AND the company it was scoped to. Never one without the other — the id
 * comes from a device and the scope does not, and the pair is the
 * `ledger.entities` primary key precisely so a bare id can never address a
 * row (ADR-0035).
 */
export interface EntityRef {
  readonly companyId: string;
  readonly entityId: string;
}

/**
 * A caller's claim that a rep act happened, in the only terms the aperture
 * accepts — ONE OF THREE SURFACES (tickets #224 and #261; spec #214 decision
 * 2: "rep-evidenced evidence widens from 'a thread message id' to 'a rep act
 * on either surface'"; spec #258 decision 2 and ADR-0013's 2026-09-20
 * amendment, which adds the third; ADR-0006's two minters, generalized).
 *
 * TAGGED, AND NOT THREE OPTIONAL FIELDS. Exactly one surface authorized an act
 * and the stores carry exactly one nullable column per surface they can be
 * authorized from (an exactly-one CHECK apiece), so a shape that could carry
 * two or none would make the type weaker than the schema — and the whole
 * reason this module is a function rather than a convention is that the
 * aperture takes nobody's word for what a rep act is.
 *
 * WHAT MAKES EACH ONE THE REP'S OWN ACT, and they are different claims:
 *
 *   `twin_thread` — a WhatsApp message the PLANE delivered, rep-authored, live,
 *   not a gesture and not backfill. The defence is that a model cannot produce
 *   a row on the seam (ADR-0003).
 *
 *   `dashboard` — a `dashboard_acts` row the runtime's local API wrote from an
 *   authenticated request: rep-web's session mapped a cookie to a seat, the
 *   bearer said which process asked, and the runtime resolved that seat's twin
 *   from the registry rather than from the request (`local-api.ts`' three
 *   fences). The defence is the same in shape — a model cannot produce a row
 *   in a table only the API writes — and it is what makes a button on a card
 *   as safe as a message in the thread (spec #214 user story 35).
 *
 *   `dashboard_message` — a `dashboard_messages` row the same API wrote, from
 *   the same three fences plus a fourth: the login session the words were
 *   typed under, checked to be that seat's and still open. It is the rep's own
 *   WORDS rather than a button, which is why it is a third surface and not the
 *   second one widened: the dashboard act's defence is "only the API writes
 *   this table AND the row names a post of the twin's", and a message names
 *   nothing, so the session is what stands in that place.
 */
export type RepActEvidence =
  | ThreadMessageEvidence
  | DashboardActEvidence
  | DashboardMessageEvidence;

export interface ThreadMessageEvidence {
  readonly surface: "twin_thread";
  /** The `wa_events` row the act was delivered on. */
  readonly sourceEventId: string;
  /** The WA message id that row is claimed to carry — matched, never trusted. */
  readonly waMessageId: string;
}

export interface DashboardActEvidence {
  readonly surface: "dashboard";
  /** The `dashboard_acts` row the runtime's local API wrote for this act. */
  readonly dashboardActId: string;
}

export interface DashboardMessageEvidence {
  readonly surface: "dashboard_message";
  /** The `dashboard_messages` row the rep's words were sealed into (#261). */
  readonly dashboardMessageId: string;
}

/** The scope every verified act carries, whichever surface it came from. */
interface RepActScope {
  /** Applied server-side from the row the runtime stamped; never from a caller. */
  readonly companyId: string;
  readonly seatId: string;
  readonly twinId: string;
  /**
   * VALID TIME — when the rep acted, off the row rather than off any clock
   * this pass reads. The seam's `occurred_at` for a thread message, the act
   * row's own instant for a dashboard tap.
   */
  readonly occurredAt: Date;
}

/** Evidence that survived the match: the row's own stamped scope, read back. */
export interface ThreadMessageRepAct extends RepActScope {
  readonly surface: "twin_thread";
  readonly sourceEventId: string;
  readonly waMessageId: string;
  readonly chatJid: string;
}

/**
 * ...and the dashboard's, which carries no chat.
 *
 * THERE IS NO CHAT TO CARRY, and its absence is a fact about the surface
 * rather than a field nobody filled: a rep tapping a button on a card is
 * acting in their own dashboard, whose "chat" would be a constant of the
 * deployment (`TwinThreadMessageTrigger`'s own note, one package over). Where
 * an act needs to know WHICH conversation — the binding — the answer comes
 * from the question post's own source event under the twin key, which is the
 * walk the confirmation makes (#34).
 */
export interface DashboardRepAct extends RepActScope {
  readonly surface: "dashboard";
  readonly dashboardActId: string;
}

/**
 * ...and the door's, which carries no chat either, for the same reason and one
 * more (ticket #261).
 *
 * A DOOR MESSAGE IS WORDS WITHOUT A CONVERSATION. The rep typed into a
 * composer on their own dashboard; there is no chat and no rail stanza, so
 * there is no `chatJid` and no `waMessageId` to carry — which is also why a
 * door message can never anchor a binding: a binding is about a chat, and this
 * surface has none (`bindingQuestionAnchor`).
 */
export interface DashboardMessageRepAct extends RepActScope {
  readonly surface: "dashboard_message";
  readonly dashboardMessageId: string;
}

export type VerifiedRepAct =
  | ThreadMessageRepAct
  | DashboardRepAct
  | DashboardMessageRepAct;

/**
 * THE TWO NULLABLE EVIDENCE COLUMNS EVERY APERTURE STORE CARRIES (#224).
 *
 * `disclosure_lines`, `fact_retractions` and `draft_dismissals` each hold
 * `source_event_id` and `dashboard_act_id`, so every writer of one has the
 * same pair of values to produce — and producing them in one place is what
 * keeps "a rep act names the act that authorized it" from being three
 * nearly-identical ternaries that could drift.
 *
 * A DOOR MESSAGE HAS NO COLUMN IN THE PAIR, AND THAT IS A FACT ABOUT THE ACTS
 * RATHER THAN A GAP (ticket #261). Every act that writes one of these stores is
 * bound to something the rep POINTED AT — a quoted draft, a quoted question, a
 * numbered line of a quoted record (`thread/acts.ts`' rule TWO) — and the
 * dashboard's composer points at nothing. The one door message that does is a
 * line of the notes edited in place (ticket #344), which names that line on
 * its row; so `fact_retractions` alone carries a third column, under a
 * three-way CHECK, and `retraction.ts` adds it to this pair. `draft_dismissals`
 * and `disclosure_lines` still refuse a door message here: no act reachable
 * today lands in them with one, and a column nothing writes is the failure the
 * migration sweep exists to refuse.
 */
export function repActEvidenceColumns(repAct: VerifiedRepAct): {
  readonly sourceEventId: string | null;
  readonly dashboardActId: string | null;
} {
  switch (repAct.surface) {
    case "twin_thread":
      return { sourceEventId: repAct.sourceEventId, dashboardActId: null };
    case "dashboard":
      return { sourceEventId: null, dashboardActId: repAct.dashboardActId };
    case "dashboard_message":
      throw new Error(
        `refusing to file a Ledger act evidenced by dashboard message ${repAct.dashboardMessageId}: this store names a seam event or a dashboard act, and a door message is neither — only a retraction, from a line edited on the card, is evidenced by one (tickets #261, #344)`,
      );
  }
}

/**
 * One raw plane-delivered BEAT — what somebody said, or what they tapped —
 * read back with its stamped scope and its decrypted envelope. The common
 * ground under BOTH input classes.
 *
 * A class-2 act is this plus the rep-authorship checks below, and it is
 * still a MESSAGE: a gesture is demoted there deliberately (see
 * `classifyApertureInput`). A class-1 candidate fact is this and nothing
 * else, because there is no rep act to verify — but the SCOPE is read the
 * same way, off the row the plane stamped, because "the aperture never
 * accepts a company scope from the device" (ADR-0035) is about where the
 * value comes from, not about which class asked for it.
 */
export interface SeamSource extends ThreadMessageRepAct {
  readonly fromMe: boolean;
  readonly backfill: boolean;
  /**
   * The message's own text, as the plane delivered it (ticket #71).
   *
   * Read for one purpose: matching a candidate's quoted evidence against
   * what was actually said. An `OrderTaken` claims the rep agreed and must
   * quote the words that agreed, and the aperture checks those words are
   * really in this row rather than taking the model's word for it — the
   * same shape as a class-2 act's message-id match, and unavailable to a
   * model for the same reason. Never stored: what crosses is the shaped
   * payload, which the wall sweep still reads every string of.
   *
   * EMPTY ON A GESTURE, and that is the honest value rather than a
   * placeholder (ticket #99). A reaction is not what was said — ADR-0041
   * gives it a type of its own precisely so that no consumer reading
   * `text` as speech can quietly lie about one — so a reaction row's words
   * are its TARGET's, and they are in `gesture` where a reader has to ask
   * for them by name.
   */
  readonly text: string;
  /**
   * The gesture this row is, composed with the message it points at —
   * present exactly when the row is a `'reaction'` (ticket #99; ADR-0041).
   * `undefined` on every message row, which is what makes "is this a
   * gesture?" a question about the seam rather than about the emoji.
   */
  readonly gesture: SeamGesture | undefined;
  /**
   * The rail's own name for a delivery the plane could not read — present
   * exactly when the row is an `'opaque'` (ticket #124; ADR-0042), and
   * `undefined` on every other type. `text` above then holds the
   * PLACEHOLDER composed from this kind, which is the honest answer to
   * "what does this row say": the twin could not read it.
   *
   * It is here for the same reason `gesture` is — so "what KIND of row is
   * this?" is a question about the seam rather than a guess at the text —
   * and it is what keeps a placeholder from ever standing as the rep's own
   * act (`classifyApertureInput`).
   */
  readonly opaqueKind: string | undefined;
}

/**
 * A REACTION AND THE MESSAGE IT POINTS AT, composed by deterministic code
 * off two seam rows (ticket #99; ADR-0041, ADR-0003 as amended).
 *
 * Both halves are meaningless alone: a bare 👍 is somebody saying nothing,
 * and a bare stanza id is a pointer no reader can follow. So the aperture
 * never hands out one without the other — a gesture whose target it could
 * not read back is not evidence, and `readSeamSource` refuses the row
 * rather than returning half of one.
 *
 * NOTHING HERE CAME FROM A MODEL. The pointer is taken off the reaction's
 * own decrypted payload and the words are read back out of `wa_events`
 * under the twin DEK — which is ADR-0003's amended rule word for word:
 * determinism binds the evidence and the target, never the intent.
 */
export interface SeamGesture {
  /**
   * The emoji placed. Never the empty string here: an empty emoji is the
   * rail's REMOVAL, and a retraction cited as the agreement is an
   * evidence-shape error the read refuses (ADR-0041 — a removal is a
   * signal, and the signal it carries is not yes).
   */
  readonly emoji: string;
  /** The target's rail id, off the reaction row — never from a caller. */
  readonly targetMessageId: string;
  /** The target's own words, whole, read back off the seam. */
  readonly targetText: string;
}

/** A seam read that either produced a source, or says why it could not. */
export type SeamRead =
  | { readonly ok: true; readonly source: SeamSource }
  | { readonly ok: false; readonly reason: string };

/**
 * Reads one `wa_events` row for this twin and opens its envelope.
 *
 * Everything here is a property of the ROW rather than of what a caller
 * claimed about it: the row exists, it is this twin's, it is raw
 * plane-delivered, and its payload decodes under the twin DEK. Refusals
 * come back as reasons rather than throws — both callers turn them into a
 * fail-safe outcome (class 1 for a rep act, a refusal for a candidate).
 */
export async function readSeamSource(
  ctx: ApertureContext,
  target: { readonly twinId: string; readonly eventId: string },
): Promise<SeamRead> {
  // The seam's row id is a bigint identity. Anything else is not an event
  // id at all, and must land as a refusal rather than as a Postgres cast
  // error — a caller passing model-shaped junk is exactly the case
  // ADR-0003 names.
  if (!/^[1-9][0-9]{0,18}$/.test(target.eventId)) {
    return {
      ok: false,
      reason: `evidence event id ${JSON.stringify(target.eventId)} is not a seam row id`,
    };
  }
  const res = await ctx.db.query<
    EvidenceRow & { readonly source: string; readonly event_type: string }
  >(
    `SELECT id, source, event_type, company_id, seat_id, twin_id,
            occurred_at, payload_enc
       FROM wa_events
      WHERE id = $1 AND twin_id = $2`,
    [target.eventId, target.twinId],
  );
  const row = res.rows[0];
  if (row === undefined) {
    return {
      ok: false,
      reason: `no wa_events row ${target.eventId} for twin ${target.twinId} — a rep act cites a message the plane delivered, and nothing else can produce one`,
    };
  }
  // THREE TYPES, DISPATCHED ON THE ROW — never one shape bent to hold
  // another (tickets #99 and #124; ADR-0041, ADR-0042). A `'message'` is
  // what somebody said; a `'reaction'` is what they tapped, and it
  // evidences something only once the message it points at has been read
  // back beside it; an `'opaque'` is a delivery the plane could not read,
  // and what it says is the placeholder. Everything else the seam may ever
  // carry is refused here, which is the fail-safe direction for a wall
  // crossing.
  if (row.source !== RAW_SOURCE || !EVIDENCE_EVENTS.includes(row.event_type)) {
    return {
      ok: false,
      reason: `evidence row ${row.id} is a ${row.source}/${row.event_type} event, not a raw plane-delivered message, reaction or opaque delivery`,
    };
  }

  if (row.event_type === REACTION_EVENT) {
    const opened = openEnvelope(row, () =>
      decodeWaReactionPayload(ctx.dek, row.payload_enc),
    );
    return opened.ok ? await readGesture(ctx, row, opened.payload) : opened;
  }
  if (row.event_type === OPAQUE_EVENT) {
    const opened = openEnvelope(row, () =>
      decodeWaOpaquePayload(ctx.dek, row.payload_enc),
    );
    return opened.ok
      ? { ok: true, source: opaqueSource(row, opened.payload) }
      : opened;
  }
  const opened = openEnvelope(row, () =>
    decodeWaMessagePayload(ctx.dek, row.payload_enc),
  );
  return opened.ok
    ? { ok: true, source: messageSource(row, opened.payload) }
    : opened;
}

/** The columns every seam read below opens a row from. */
interface EvidenceRow {
  readonly id: string;
  readonly company_id: string;
  readonly seat_id: string;
  readonly twin_id: string;
  readonly occurred_at: Date;
  readonly payload_enc: Buffer;
}

/**
 * Opens one row's envelope, or says why it could not.
 *
 * A payload that will not decrypt or does not match the pinned contract
 * cannot evidence anything. Refusing is the fail-safe direction, never a
 * throw that a caller could mistake for a transport blip.
 *
 * IT WRAPS THE DECODE AND NOTHING ELSE (`/code-review`, standards axis).
 * The first cut of #99 put the whole dispatch inside this `try` — and the
 * gesture arm reaches Postgres for its target, so a genuine database
 * failure would have come back as "did not decode under the twin DEK": a
 * transport blip reported as a refusal, with a false reason, demoting a
 * rep act to class 1. A refusal has to be a statement about the ROW.
 */
function openEnvelope<T>(
  row: Pick<EvidenceRow, "id">,
  decode: () => T,
):
  | { readonly ok: true; readonly payload: T }
  | { readonly ok: false; readonly reason: string } {
  try {
    return { ok: true, payload: decode() };
  } catch (err) {
    const name = err instanceof WaPayloadError ? err.message : "envelope refused";
    return {
      ok: false,
      reason: `evidence row ${row.id} did not decode under the twin DEK (${name})`,
    };
  }
}

/** One `'message'` row: what somebody said, with the scope the plane stamped. */
function messageSource(row: EvidenceRow, payload: WaMessagePayload): SeamSource {
  return {
    surface: "twin_thread",
    sourceEventId: row.id,
    waMessageId: payload.messageId,
    companyId: row.company_id,
    seatId: row.seat_id,
    twinId: row.twin_id,
    chatJid: payload.chatJid,
    occurredAt: row.occurred_at,
    fromMe: payload.fromMe,
    backfill: payload.backfill === true,
    text: payload.text,
    gesture: undefined,
    opaqueKind: undefined,
  };
}

/**
 * One `'opaque'` row: a delivery the plane could not read, with the scope
 * the plane stamped (ticket #124; ADR-0042's "citable like any row, with
 * no hard gate").
 *
 * ITS WORDS ARE THE PLACEHOLDER, composed here by deterministic code from
 * the rail's own kind — never by a model, and never left empty. Empty text
 * would make an opaque row unciteable in practice: `OrderTaken`'s evidence
 * would refuse it as "empty or longer than a payload field may hold", so
 * the row would be admitted at the seam and rejected one layer down, which
 * is a hard gate wearing a refusal's clothes. The line the rep reads
 * therefore says «[foto]» — wrong on its face or right on its face, which
 * is where ADR-0038 wants their eyes.
 *
 * NO TARGET READ-BACK, unlike a gesture. A reaction MEANS the message
 * under it, so half of it is elsewhere; an opaque delivery means itself,
 * and there is nothing else to fetch.
 */
function opaqueSource(row: EvidenceRow, payload: WaOpaquePayload): SeamSource {
  return {
    surface: "twin_thread",
    sourceEventId: row.id,
    // THE ROW's identity — `<stanza>:opaque` — which is what the transcript
    // line was prefixed with and what a candidate cites.
    waMessageId: payload.messageId,
    companyId: row.company_id,
    seatId: row.seat_id,
    twinId: row.twin_id,
    chatJid: payload.chatJid,
    occurredAt: row.occurred_at,
    fromMe: payload.fromMe,
    backfill: payload.backfill === true,
    text: opaquePlaceholder(payload.kind),
    gesture: undefined,
    opaqueKind: payload.kind,
  };
}

/**
 * One `'reaction'` row, composed with the message it points at (ticket
 * #99; ADR-0041's "admissible as `agreement` evidence" paragraph).
 *
 * FOUR REFUSALS, and each of them is about the SHAPE of the evidence
 * rather than about what it means:
 *
 *  - A REMOVAL is not an agreement. The empty emoji is the rail's
 *    retraction (`RemoveReactionText = ""`), and a retraction cited as the
 *    yes is a citation of the wrong beat — refused deterministically. What
 *    is NOT refused here is a LATER removal: whether an agreement still
 *    stands is the model's reading of the transcript, where the set and
 *    the removal are two chronological beats (#98), and the aperture holds
 *    no fold. Determinism binds the evidence and the target, never the
 *    intent (ADR-0003 as amended).
 *  - A TARGET THAT IS NOT THIS TWIN'S, or not in the reaction's OWN CHAT,
 *    is not this gesture's target. The read is scoped to both, so a
 *    gesture can never reach across a chat boundary for its words.
 *  - A TARGET THAT IS NOT A MESSAGE has no words to carry — a gesture at a
 *    gesture is a pointer at a pointer.
 *  - A TARGET WITH NO WORDS (a media husk) would quote «», so it refuses
 *    rather than filing an agreement to nothing.
 *
 * In every one of them the crossing is refused and the customer's own
 * `OrderRequested` stands, which is ADR-0038's under-filing direction.
 */
async function readGesture(
  ctx: ApertureContext,
  row: EvidenceRow,
  payload: WaReactionPayload,
): Promise<SeamRead> {
  if (payload.emoji === "") {
    return {
      ok: false,
      reason: `evidence row ${row.id} is a REMOVED reaction — an empty emoji is the rail's retraction, and a retraction is not the gesture that agreed (ADR-0041)`,
    };
  }
  const targetText = await readTargetText(
    ctx,
    payload.chatJid,
    row.twin_id,
    payload.reactionTo,
  );
  if (targetText === undefined) {
    return {
      ok: false,
      reason: `evidence row ${row.id} points at ${payload.reactionTo}, which is not a message with words in this twin's ${payload.chatJid} — a gesture whose target the aperture cannot read back is not evidence of anything`,
    };
  }
  return {
    ok: true,
    source: {
      surface: "twin_thread",
      sourceEventId: row.id,
      // The REACTION's own stanza id, never its target's: it is what the
      // transcript line was prefixed with and what a candidate cites.
      waMessageId: payload.messageId,
      companyId: row.company_id,
      seatId: row.seat_id,
      twinId: row.twin_id,
      chatJid: payload.chatJid,
      occurredAt: row.occurred_at,
      fromMe: payload.fromMe,
      backfill: payload.backfill === true,
      // A gesture said nothing; its words are its target's, below.
      text: "",
      opaqueKind: undefined,
      gesture: {
        emoji: payload.emoji,
        targetMessageId: payload.reactionTo,
        targetText,
      },
    },
  };
}

/**
 * The deterministic read-back: one gesture target's own words, or nothing.
 *
 * Keyed by (chat, message id) and by NOTHING A MODEL SAID — the pointer
 * comes off the reaction's own decrypted payload. The seam composes
 * `external_event_id` as `<chat jid>:<message id>` and `(source,
 * external_event_id)` is its dedupe UNIQUE, so this is one index probe
 * rather than a scan; `twin_id` bounds it, so one twin can never read
 * another's row; and the chat is CONFIRMED against the decrypted envelope
 * afterwards, because the prefix is plaintext metadata and the envelope is
 * the truth about which chat a message was in.
 *
 * The same read `extraction-pass.ts` does to inline an out-of-window
 * target on the transcript line (#98), deliberately not shared: that one
 * lives in `@dito/twin-runtime`, which depends on this package rather than
 * the other way round, and the aperture reading the seam through the
 * runtime would invert the dependency that makes the aperture the single
 * writer. The two agree on the rule ADR-0041 states, not on a helper.
 *
 * A BACKFILLED TARGET IS FINE, and the asymmetry is deliberate: backfill's
 * exclusion is about what may be EXTRACTED, and the gesture's own row is
 * what carries this fact's provenance. «A 👍 on last week's quote» is a
 * gesture at history for a rep who linked last week, which is the common
 * case rather than the exotic one.
 *
 * THE MATCH IS AN EQUALITY, NOT A PREFIX, and the limit is recorded rather
 * than papered over. `plane/ingest`'s `externalEventID` composes exactly
 * `<chat>:<message-id>` on both feeds, so equality finds every row the
 * plane writes today; a re-delivery carrying a SUFFIXED id (the shape
 * #33's fixtures exercise) would not be found, and its gesture would
 * refuse rather than file. That is the under-filing direction ADR-0038
 * keeps, and it is the same match #98's transcript read-back makes — the
 * two agree, which is worth more than one of them widening alone.
 */
async function readTargetText(
  ctx: ApertureContext,
  chatJid: string,
  twinId: string,
  messageId: string,
): Promise<string | undefined> {
  const res = await ctx.db.query<Pick<EvidenceRow, "id" | "payload_enc">>(
    `SELECT id, payload_enc
       FROM wa_events
      WHERE source = $1
        AND external_event_id = $2 || ':' || $3
        AND twin_id = $4
        AND event_type = $5`,
    [RAW_SOURCE, chatJid, messageId, twinId, MESSAGE_EVENT],
  );
  const row = res.rows[0];
  if (row === undefined) return undefined;
  // A target whose own envelope will not open is a target that cannot be
  // read back, which is the same answer as one that never crossed — and it
  // is a REFUSAL either way, never a throw escaping the seam read.
  const opened = openEnvelope(row, () =>
    decodeWaMessagePayload(ctx.dek, row.payload_enc),
  );
  if (!opened.ok) return undefined;
  const target = opened.payload;
  // BOTH HALVES OF THE IDENTITY, off the ENVELOPE (Codex r1). The row was
  // selected on `external_event_id`, which is plaintext metadata — so the
  // decrypted payload has to agree about WHICH CHAT and WHICH MESSAGE it
  // is, or the pointer was bound to the metadata rather than to the
  // message. Checking only the chat left the message id trusted from the
  // very column the chat check exists not to trust, and a row whose key
  // names A while its envelope names B would have put B's words in front
  // of an owner as the evidence for a gesture at A.
  if (target.chatJid !== chatJid || target.messageId !== messageId) {
    return undefined;
  }
  return target.text === "" ? undefined : target.text;
}

/**
 * The classification, as ADR-0003 words it: class 2 when the evidence
 * holds, class 1 otherwise — with the reason recorded, because a demotion
 * is a refusal to treat something as the rep's act and a caller that
 * expected class 2 must be able to say why it did not get it.
 */
export type ApertureInput =
  | { readonly inputClass: 1; readonly reason: string }
  | { readonly inputClass: 2; readonly repAct: VerifiedRepAct };

/** The rail the plane delivers on; anything else is not raw plane-delivered. */
const RAW_SOURCE = "whatsapp";
/** The event type a message arrives as, and the only type a rep ACT may cite. */
const MESSAGE_EVENT = "message";
/** The gesture type the seam has spoken since #97 (ADR-0041). */
const REACTION_EVENT = "reaction";
/** The delivery-the-plane-could-not-read type, since #124 (ADR-0042). */
const OPAQUE_EVENT = "opaque";
/**
 * The seam types that can EVIDENCE something — what somebody said, what
 * they tapped, and what the plane could not read. Not "what was spoken":
 * ADR-0041 is emphatic that a reaction is not speech and ADR-0042 that an
 * opaque delivery is not either, which is why each has a type of its own.
 * A candidate fact may be read in any of the three (tickets #99 and #124);
 * every other type the seam may ever carry is refused by `readSeamSource`,
 * and a class-2 rep act narrows this further to the message alone.
 */
const EVIDENCE_EVENTS = [MESSAGE_EVENT, REACTION_EVENT, OPAQUE_EVENT];

/**
 * Classifies one claimed rep act. Deterministic: five reads against the
 * seam row and its decrypted payload, no model anywhere in the path.
 */
export async function classifyApertureInput(
  ctx: ApertureContext,
  claim: { readonly twinId: string; readonly evidence: RepActEvidence },
): Promise<ApertureInput> {
  const { twinId, evidence } = claim;
  if (evidence.surface === "dashboard") {
    return await classifyDashboardAct(ctx, twinId, evidence);
  }
  if (evidence.surface === "dashboard_message") {
    return await classifyDashboardMessage(ctx, twinId, evidence);
  }
  const read = await readSeamSource(ctx, {
    twinId,
    eventId: evidence.sourceEventId,
  });
  // "Processed as class 1" is the fail-safe direction for every way the
  // row itself can fail to be raw plane-delivered material.
  if (!read.ok) return { inputClass: 1, reason: read.reason };
  const { source } = read;

  // A CLASS-2 ACT IS A MESSAGE, and #99's widening deliberately stops
  // short of it. `readSeamSource` now admits a gesture because a candidate
  // fact may be READ in one — but a rep act is a confirmation, a
  // correction, a retraction or an entity act, and every one of those is
  // bound to words the rep typed: the affirmation matcher reads a verb
  // («va», «no va»), the entity ceremony quotes a twin post, and the
  // question door matches an answer. A 👍 in the twin thread routes as
  // ordinary rep input and the model reads its intent (ADR-0041, "in the
  // twin thread a reaction gets no special treatment"); it never mints an
  // act by itself. Demoting to class 1 keeps that true by construction
  // rather than by each caller remembering.
  if (source.gesture !== undefined) {
    return {
      inputClass: 1,
      reason: `evidence row ${source.sourceEventId} is a reaction — a gesture is admissible as a candidate fact's evidence (#99) but never as a rep act, which is bound to the words the rep typed`,
    };
  }

  // ...AND NEITHER IS A DELIVERY THE PLANE COULD NOT READ (ticket #124;
  // ADR-0042), on the same argument one line further along. Its words are
  // a PLACEHOLDER this code composed — «[foto]» is the twin saying it
  // could not read the message, not something the rep typed — so a
  // confirmation, a correction, a retraction or an entity act can never
  // rest on one. Every rep act the runtime mints today cites a row it
  // routed as a message, so nothing reaches this arm; it is here for the
  // reason the whole module is — the aperture re-reads the row rather than
  // taking a caller's word for what it was (ADR-0003).
  if (source.opaqueKind !== undefined) {
    return {
      inputClass: 1,
      reason: `evidence row ${source.sourceEventId} is an opaque delivery (${source.opaqueKind}) — the twin could not read it, so it is admissible as a candidate fact's evidence (#124) but never as a rep act, which is bound to the words the rep typed`,
    };
  }

  // ...and these three are what make it the REP'S ACT rather than merely a
  // message that exists.
  if (!source.fromMe) {
    return {
      inputClass: 1,
      reason: `evidence row ${source.sourceEventId} is not rep-authored (from_me is false) — a counterparty's message is never the rep's act`,
    };
  }
  if (source.waMessageId !== evidence.waMessageId) {
    return {
      inputClass: 1,
      reason: `evidence row ${source.sourceEventId} carries message id ${source.waMessageId}, not the cited ${evidence.waMessageId}`,
    };
  }
  if (source.backfill) {
    // History-sync material is not an act the rep just performed: the
    // plane normalized it out of a blob, and it never routed through the
    // twin thread as a live reply (#33).
    return {
      inputClass: 1,
      reason: `evidence row ${source.sourceEventId} is backfilled history, not a live rep act`,
    };
  }

  return {
    inputClass: 2,
    repAct: {
      surface: "twin_thread",
      sourceEventId: source.sourceEventId,
      waMessageId: source.waMessageId,
      companyId: source.companyId,
      seatId: source.seatId,
      twinId: source.twinId,
      chatJid: source.chatJid,
      occurredAt: source.occurredAt,
    },
  };
}

/**
 * THE DASHBOARD ARM OF THE SAME CLASSIFICATION (ticket #224; spec #214
 * decision 2 and user story 35; ADR-0003, ADR-0010).
 *
 * "As a rep, I want a wrong acknowledgment on the dashboard to be exactly as
 * safe as on the phone, so that a dashboard act and a thread act are one act."
 * That is what this makes true: the same function decides both, so a caller
 * that wanted to skip the check on one surface would have to skip it on both.
 *
 * FOUR READINGS OF THE ROW, and none of them is a caller's word for anything
 * — the shape the thread's arm has, one store over:
 *
 *   the row EXISTS. Only the runtime's local API writes `dashboard_acts`, and
 *   it writes one per authenticated request, so an id that names a row is an
 *   act somebody really performed. A model cannot produce one, which is
 *   ADR-0003's own defence read against a different table.
 *
 *   it is THIS TWIN's, in the WHERE clause rather than compared afterwards —
 *   so an act of another rep's dashboard resolves to nothing at all.
 *
 *   its SCOPE is read back off the row: company, seat, twin, and the instant
 *   the rep tapped. Never from a parameter (ADR-0035).
 *
 *   and it is UNSPENT. `dashboard_acts` is one row per act and the aperture's
 *   own stores hold `dashboard_act_id` unique where it matters
 *   (`fact_retractions_one_per_rep_act`, `disclosure_lines_one_create_per_rep_act`),
 *   so "one act authorizes one thing" is the store's rule on this surface
 *   exactly as it is on the other — enforced there rather than re-checked
 *   here, which is why this reads the row and does not count its uses.
 *
 * THERE IS NO ENVELOPE TO OPEN AND NO AUTHORSHIP TO PROVE, and both absences
 * are the surface rather than a shortcut. A thread act has to be shown
 * rep-authored, live, not a gesture and not backfill, because the seam carries
 * everybody's messages; `dashboard_acts` carries nothing but rep acts, one per
 * authenticated request, and holds no content to decrypt.
 */
async function classifyDashboardAct(
  ctx: ApertureContext,
  twinId: string,
  evidence: DashboardActEvidence,
): Promise<ApertureInput> {
  // A uuid, checked before it reaches a query — the reason `readSeamSource`
  // checks its bigint: a caller passing model-shaped junk must land as a
  // demotion rather than as a Postgres cast error (ADR-0003).
  if (!isOwnId(evidence.dashboardActId)) {
    return {
      inputClass: 1,
      reason: `evidence act id ${JSON.stringify(evidence.dashboardActId)} is not a dashboard act id`,
    };
  }
  const res = await ctx.db.query<{
    company_id: string;
    seat_id: string;
    twin_id: string;
    acted_at: Date;
  }>(
    `SELECT company_id, seat_id, twin_id, acted_at
       FROM dashboard_acts
      WHERE id = $1 AND twin_id = $2`,
    [evidence.dashboardActId, twinId],
  );
  const row = res.rows[0];
  if (row === undefined) {
    return {
      inputClass: 1,
      reason: `no dashboard_acts row ${evidence.dashboardActId} for twin ${twinId} — a dashboard act cites a row the runtime's local API wrote for an authenticated request, and nothing else can produce one`,
    };
  }
  return {
    inputClass: 2,
    repAct: {
      surface: "dashboard",
      dashboardActId: evidence.dashboardActId,
      companyId: row.company_id,
      seatId: row.seat_id,
      twinId: row.twin_id,
      // VALID TIME IS WHEN THE REP TAPPED, off the row — the same rule the
      // thread's `occurred_at` carries, so a Ledger write records the moment
      // of the act rather than the moment a pass got to it.
      occurredAt: row.acted_at,
    },
  };
}

/**
 * THE DOOR ARM OF THE SAME CLASSIFICATION (ticket #261; spec #258 decision 2;
 * ADR-0013's 2026-09-20 amendment — "the rep-evidenced gate accepts a
 * dashboard message").
 *
 * THE SAME FOUR READINGS `classifyDashboardAct` makes, one table over, and for
 * the same reasons: the row EXISTS, so somebody really typed it; it is THIS
 * TWIN's, in the WHERE clause rather than compared afterwards, so another
 * rep's door resolves to nothing at all; its SCOPE — company, seat, twin and
 * the instant the rep sent it — is read back off the row and never off a
 * parameter (ADR-0035); and one message authorizes one thing, enforced where
 * such a bound exists rather than counted here.
 *
 * THERE IS NO ENVELOPE TO OPEN AND NO AUTHORSHIP TO PROVE, exactly as on the
 * act's arm. The seam carries everybody's messages, so a thread act has to be
 * shown rep-authored, live, not a gesture and not backfill; `dashboard_messages`
 * carries nothing but rep-typed words, one row per authenticated request, under
 * a login session the API checked was that seat's and still open — so "the rep
 * wrote this" is the table's property rather than a payload's. The words are
 * sealed and this classification never opens them: what is being verified is
 * WHO acted, and the text is not evidence of that.
 */
async function classifyDashboardMessage(
  ctx: ApertureContext,
  twinId: string,
  evidence: DashboardMessageEvidence,
): Promise<ApertureInput> {
  // A uuid, checked before it reaches a query — `readSeamSource`'s reason for
  // checking its bigint: a caller passing model-shaped junk must land as a
  // demotion rather than as a Postgres cast error (ADR-0003).
  if (!isOwnId(evidence.dashboardMessageId)) {
    return {
      inputClass: 1,
      reason: `evidence message id ${JSON.stringify(evidence.dashboardMessageId)} is not a dashboard message id`,
    };
  }
  const res = await ctx.db.query<{
    company_id: string;
    seat_id: string;
    twin_id: string;
    occurred_at: Date;
  }>(
    `SELECT company_id, seat_id, twin_id, occurred_at
       FROM dashboard_messages
      WHERE id = $1 AND twin_id = $2`,
    [evidence.dashboardMessageId, twinId],
  );
  const row = res.rows[0];
  if (row === undefined) {
    return {
      inputClass: 1,
      reason: `no dashboard_messages row ${evidence.dashboardMessageId} for twin ${twinId} — a door message cites a row the runtime's local API wrote for an authenticated request under an open session, and nothing else can produce one`,
    };
  }
  return {
    inputClass: 2,
    repAct: {
      surface: "dashboard_message",
      dashboardMessageId: evidence.dashboardMessageId,
      companyId: row.company_id,
      seatId: row.seat_id,
      twinId: row.twin_id,
      // VALID TIME IS WHEN THE REP SENT IT, off the row — the rule both other
      // surfaces carry, so a write records the moment of the act rather than
      // the moment a pass reached it.
      occurredAt: row.occurred_at,
    },
  };
}
