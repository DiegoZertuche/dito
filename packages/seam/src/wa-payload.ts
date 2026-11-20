/**
 * The inbound payload contract on the seam (ADR-0005, pinned by ticket
 * #22): `wa_events.payload_enc` is a DEK envelope blob (ADR-0008) whose
 * plaintext is versioned JSON `v: 1`. This module is the runtime's one
 * decoder for it — decrypt through @dito/crypto (never mocked, ADR-0028),
 * then refuse loudly on any version or shape surprise: a newer plane means
 * upgrading the runtime, never guessing at content.
 *
 * ONE VERSION, THREE SHAPES, DISPATCHED ON `wa_events.event_type` (tickets
 * #97 and #124; ADR-0041, ADR-0042). `v:1` is the transport version and it
 * does not move; what grew is the set of event TYPES the seam speaks. Each
 * type has its own shape check and its own decoder here, and a caller
 * decodes the shape its row's `event_type` names — the message shape is
 * never bent to hold a gesture, because every consumer that reads `text` as
 * speech would quietly lie about one (ADR-0041's reason for a type rather
 * than another additive field), and never bent to hold a delivery the plane
 * could not read, because the empty-text husk is exactly the lie ADR-0042
 * retired. Unknown keys stay ignored in every shape: that tolerance is what
 * made `push_name` and `backfill` additive, and it is what lets a later
 * field arrive without a version bump (ADR-0034 — the seam refuses what it
 * cannot READ, not what it does not recognize).
 *
 * THE WIRE SHAPES, verbatim, because the plane implements from here
 * (`plane/ingest`'s `payload` struct is the Go side of this comment):
 *
 *   event_type "message"  — {v, chat_jid, sender_jid, from_me, message_id,
 *     text, quoted_message_id?, push_name?, backfill?}
 *
 *   event_type "reaction" — {v, chat_jid, sender_jid, from_me, message_id,
 *     reaction_to, emoji, sender_ts_ms, push_name?, backfill?}
 *
 *     `message_id` is the REACTION's own stanza id (whatsmeow gives a
 *       reaction a fresh id), so the seam's `(source, external_event_id)`
 *       dedupe works for it exactly as it does for a message.
 *       ONE ROW CLASS HAS NO RAIL ID TO CARRY, and #101 ruled what it
 *       carries instead. History sync delivers a reaction in two
 *       containers (ADR-0041): standalone in the message stream, which has
 *       its own stanza id and lands here unchanged; and ACCUMULATED on the
 *       target message, where an entry may state no id of its own. There
 *       the plane composes a deterministic stand-in —
 *       `<target stanza id>:r:<reactor's bare JID>:<sender_ts_ms>`, then
 *       through `externalEventID` like any stanza id — so every row still
 *       has one identity and a re-offered blob still writes nothing twice.
 *       Read `message_id` as THE ROW'S IDENTITY, opaque: it is the rail's
 *       id wherever the rail supplies one, and a plane-composed id (which
 *       carries colons, as no WhatsApp stanza id does) only for that shape.
 *       Such a row cannot collapse against a live delivery of the same
 *       gesture, so a consumer needing current state folds per (reactor,
 *       target) by `sender_ts_ms` as it always has.
 *     `reaction_to` is the TARGET message's id, taken off the rail's
 *       reaction key (`ReactionMessage.Key.ID`). Required — a gesture with
 *       nothing to point at is not evidence of anything.
 *     `emoji` is the reaction text, and the EMPTY STRING MEANS REMOVAL,
 *       mirroring the rail (`RemoveReactionText = ""`). Required and
 *       present even when empty: absence would make a retraction
 *       indistinguishable from a malformed row, and a retraction is itself
 *       a signal (ADR-0041).
 *     `sender_ts_ms` is the rail's `SenderTimestampMS` as whole
 *       milliseconds — the fold key for last-write per (reactor, target)
 *       when a consumer needs CURRENT state, AND the tie-break that every
 *       consumer rendering deliveries IN ORDER spends (ticket #109):
 *       `occurred_at` is second-granular, so a 👍 and the removal a moment
 *       later can carry one instant, and this is the only field that says
 *       which tap came first. Required, not optional: the
 *       fold must be decidable for every row, so where the rail supplies
 *       no sender timestamp the plane stamps the same delivery instant it
 *       already writes to `occurred_at`. That is normalization, not
 *       judgement — the plane still folds nothing and resolves nothing.
 *       The accumulated-on-target history shape may or may not carry one,
 *       and #101 ruled for both: where it does, that instant is the fold
 *       key AND the row's `occurred_at`, so a gesture lands when it
 *       happened rather than when its target did; where it does not, the
 *       fallback is the target's own historical instant, and the two are
 *       the same value. What no code can settle — whether that shape's
 *       `Key` names the reaction or repeats the target's — the plane reads
 *       per entry and REPORTS, content-free, per conversation; #102
 *       verifies the reading against a real phone (spec #96).
 *     NO `text` AND NO `quoted_message_id`. A reaction is not what was
 *       said; the emoji is not speech and the target is not a quote.
 *
 *   event_type "opaque"   — {v, chat_jid, sender_jid, from_me, message_id,
 *     kind, reason, sender_ts_ms, push_name?, backfill?}
 *
 *     An IN-SCOPE DELIVERY THE PLANE COULD NOT READ (ticket #124;
 *     ADR-0042) — a photo, a voice note, a poll, an edit, a revoke, a
 *     sticker, a message the rail could not decrypt, a known shape that
 *     did not parse. Every in-scope delivery leaves exactly one seam row,
 *     and a row the plane could not read SAYS SO; before this type such a
 *     delivery wrote a `'message'` row with empty text, which the twin
 *     read as somebody saying nothing and the embedder stored as an
 *     utterance.
 *     `kind` is THE RAIL'S OWN NAME for the shape — `imageMessage`,
 *       `audioMessage`, `protocolMessage/REVOKE`, `undecryptable`,
 *       `reaction`, … — a free string, never a closed set, because it is
 *       whatever whatsmeow called the thing. Required and never empty: the
 *       placeholder the twin renders is composed FROM it
 *       (`opaquePlaceholder`), and the counter a later promotion reads is
 *       counted BY it. It is never shown to the rep.
 *     `reason` is WHY the plane could not read it, and the set IS closed
 *       (`no_slot` | `undecryptable` | `malformed`) because it is the
 *       plane's own vocabulary rather than the rail's. `malformed` names
 *       the missing field through `kind`, which is free-form — a nil-key
 *       reaction is `kind: "reaction/reaction_to"`, `reason: "malformed"`
 *       — so that this set can stay closed and still be forensic.
 *     `sender_ts_ms` is the rail's sender timestamp in whole milliseconds,
 *       required exactly as on a reaction and normalized by the plane the
 *       same way (the delivery instant where the rail supplies none). A
 *       field that is optional at birth is one no later consumer can rely
 *       on, and this is the only sub-second clock an opaque delivery has.
 *     NO `text`, NO `quoted_message_id` AND NO RAW ENVELOPE. There is no
 *       text — that is the whole point — and the raw proto is deliberately
 *       not carried (ADR-0042): for media it holds the media key, the CDN
 *       URL and a thumbnail, which is media capture through the back door
 *       for a chunk the horizon has not built; an undecryptable message
 *       has no plaintext; and for a malformed shape, kind and reason ARE
 *       the forensic value.
 *     `message_id` IS THE ROW'S IDENTITY, and it carries the kind:
 *       `<stanza id>:opaque` where the rail supplied a stanza id, and
 *       `opaque:<hash of the envelope bytes>` where it did not (hashed at
 *       write time, never stored). The seam id is `<chat>:` + this, which
 *       is ADR-0042's `<chat>:<stanza>:opaque` and `<chat>:opaque:<hash>`
 *       exactly — so an opaque row NEVER collides with the readable row
 *       for the same message, and an undecryptable message the sender
 *       re-delivers (or a photo re-captured typed after promotion) writes
 *       its own row rather than being swallowed by the dedupe. Which row
 *       STANDS is the consumer's fold, and `opaqueRowStandsFor` below is
 *       how a consumer reads the message id back out of this identity.
 *
 * Deliveries are append-only: a set, a change (👍→❤️ is a fresh event
 * carrying the same target key) and a removal each write their own row.
 * Nothing folds state at the seam or in the plane — a consumer that needs
 * "the reaction that stands" takes the last write per (reactor, target) by
 * `sender_ts_ms`; a consumer rendering a transcript renders every delivery
 * in order, because a retraction is a beat, not a correction (ADR-0041) —
 * and it breaks a same-second tie by `sender_ts_ms` too, which is ordering
 * rather than folding (#109; `inDeliveryOrder` in `@dito/bundle`).
 */
import type { Dek } from "@dito/crypto";

/** The decoded v1 message payload, exactly the pinned #22 contract. */
export interface WaMessagePayload {
  /** PN-canonical chat JID (the plane canonicalizes LID-addressed DMs). */
  readonly chatJid: string;
  readonly senderJid: string;
  readonly fromMe: boolean;
  readonly messageId: string;
  readonly text: string;
  /** Quoted-reply stanza id — the affirmation matcher's raw input (#24). */
  readonly quotedMessageId: string | undefined;
  /**
   * The sender's WhatsApp push name — additive #30 evolution of v:1 (spec
   * #29 decision 7): the grammar names the counterparty from it, falling back
   * to the number when absent. Pre-#30 payloads simply lack it.
   */
  readonly pushName: string | undefined;
  /**
   * The one additive backfill marker — #33 evolution of v:1 (spec #29
   * decision 5): true on events the plane normalized from a history-sync
   * blob, absent on live capture. Marked events route to ingest only —
   * backfill never drafts (decision 6).
   */
  readonly backfill: boolean | undefined;
}

/**
 * The decoded v1 REACTION payload (ticket #97; ADR-0041) — an emoji placed
 * on one specific message, in either direction, remembered like any
 * message. Evidence in a conversation, exactly like text; never a tap.
 */
export interface WaReactionPayload {
  /** PN-canonical chat JID, as on a message. */
  readonly chatJid: string;
  readonly senderJid: string;
  readonly fromMe: boolean;
  /** The REACTION's own stanza id — not the target's. */
  readonly messageId: string;
  /** The target message's stanza id, off the rail's reaction key. */
  readonly reactionTo: string;
  /** The emoji placed; the empty string is a REMOVAL, not an absent field. */
  readonly emoji: string;
  /** The rail's sender timestamp in ms — the last-write fold key. */
  readonly senderTsMs: number;
  /** The reactor's push name, when the delivery carried one (as on a message). */
  readonly pushName: string | undefined;
  /** The backfill marker, as on a message: true only on history rows. */
  readonly backfill: boolean | undefined;
}

/**
 * Why the plane could not read a delivery (ticket #124; ADR-0042) — the
 * plane's OWN vocabulary, and therefore a closed set, unlike `kind`.
 *
 *  - `no_slot`       the seam has no typed shape for it yet (a photo, a
 *                    voice note, a poll, an edit, a revoke, a sticker).
 *  - `undecryptable` the rail could not decrypt it, so there is no content
 *                    to carry at all.
 *  - `malformed`     a known shape missing a field it cannot be without —
 *                    a reaction with no target key, a message with no
 *                    stanza id. The missing field is named in `kind`.
 */
export const OPAQUE_REASONS = [
  "no_slot",
  "undecryptable",
  "malformed",
] as const;
export type OpaqueReason = (typeof OPAQUE_REASONS)[number];

/**
 * The decoded v1 OPAQUE payload (ticket #124; ADR-0042) — one in-scope
 * delivery the plane could not read, remembered as having happened, with
 * who, when, and what kind, never as silence.
 */
export interface WaOpaquePayload {
  /** PN-canonical chat JID, as on a message. */
  readonly chatJid: string;
  readonly senderJid: string;
  readonly fromMe: boolean;
  /** THE ROW'S IDENTITY: `<stanza>:opaque`, or `opaque:<hash>` with no stanza id. */
  readonly messageId: string;
  /** The rail's own name for the shape — free-form, never shown to the rep. */
  readonly kind: string;
  /** Why the plane could not read it. */
  readonly reason: OpaqueReason;
  /** The rail's sender timestamp in ms, as on a reaction. */
  readonly senderTsMs: number;
  /** The sender's push name, when the delivery carried one (as on a message). */
  readonly pushName: string | undefined;
  /** The backfill marker, as on a message: true only on history rows. */
  readonly backfill: boolean | undefined;
}

/** A payload that decrypted but does not match the pinned contract. */
export class WaPayloadError extends Error {
  override readonly name = "WaPayloadError";
}

const PAYLOAD_VERSION = 1;

/**
 * Decrypts and decodes one `payload_enc` blob as a MESSAGE. Envelope
 * refusals (tamper, wrong key) surface from @dito/crypto before any
 * parsing; version and shape refusals are typed WaPayloadError — both are
 * refusals to process, never to guess around.
 */
export function decodeWaMessagePayload(
  dek: Dek,
  payloadEnc: Uint8Array,
): WaMessagePayload {
  const p = openVersionedPayload(dek, payloadEnc);
  if (
    !isCommonEnvelope(p) ||
    typeof p["text"] !== "string" ||
    (p["quoted_message_id"] !== undefined &&
      typeof p["quoted_message_id"] !== "string")
  ) {
    throw new WaPayloadError("payload does not match the pinned v1 contract");
  }
  return {
    chatJid: p.chat_jid,
    senderJid: p.sender_jid,
    fromMe: p.from_me,
    messageId: p.message_id,
    text: p["text"],
    quotedMessageId: p["quoted_message_id"],
    pushName: p.push_name,
    backfill: p.backfill,
  };
}

/**
 * Decrypts and decodes one `payload_enc` blob as a REACTION (ticket #97).
 * Same version rule, same envelope refusals, its own shape — a payload
 * carrying the other type's shape is refused here rather than half-read.
 */
export function decodeWaReactionPayload(
  dek: Dek,
  payloadEnc: Uint8Array,
): WaReactionPayload {
  const p = openVersionedPayload(dek, payloadEnc);
  if (
    !isCommonEnvelope(p) ||
    typeof p["reaction_to"] !== "string" ||
    typeof p["emoji"] !== "string" ||
    // Whole milliseconds, so the fold key is an instant and orders
    // exactly. A string or a fraction is a plane that changed its mind
    // about the field, which is a refusal, not something to coerce.
    typeof p["sender_ts_ms"] !== "number" ||
    !Number.isSafeInteger(p["sender_ts_ms"])
  ) {
    throw new WaPayloadError(
      "payload does not match the pinned v1 reaction contract",
    );
  }
  return {
    chatJid: p.chat_jid,
    senderJid: p.sender_jid,
    fromMe: p.from_me,
    messageId: p.message_id,
    reactionTo: p["reaction_to"],
    emoji: p["emoji"],
    senderTsMs: p["sender_ts_ms"],
    pushName: p.push_name,
    backfill: p.backfill,
  };
}

/**
 * Decrypts and decodes one `payload_enc` blob as an OPAQUE delivery
 * (ticket #124). Same version rule, same envelope refusals, its own shape.
 *
 * `kind` is checked for PRESENCE and non-emptiness only — it is the rail's
 * word and the seam has no list of the rail's words — while `reason` is
 * checked against the closed set, because that one is the plane's own
 * vocabulary and a value outside it is a plane this runtime does not
 * speak. Both are the refusal ADR-0034 prescribes rather than a guess.
 */
export function decodeWaOpaquePayload(
  dek: Dek,
  payloadEnc: Uint8Array,
): WaOpaquePayload {
  const p = openVersionedPayload(dek, payloadEnc);
  if (
    !isCommonEnvelope(p) ||
    !isOpaqueRowIdentity(p.message_id) ||
    typeof p["kind"] !== "string" ||
    p["kind"] === "" ||
    !isOpaqueReason(p["reason"]) ||
    // Whole milliseconds, exactly as on a reaction: an instant, never a
    // string and never a fraction.
    typeof p["sender_ts_ms"] !== "number" ||
    !Number.isSafeInteger(p["sender_ts_ms"])
  ) {
    throw new WaPayloadError(
      "payload does not match the pinned v1 opaque contract",
    );
  }
  return {
    chatJid: p.chat_jid,
    senderJid: p.sender_jid,
    fromMe: p.from_me,
    messageId: p.message_id,
    kind: p["kind"],
    reason: p["reason"],
    senderTsMs: p["sender_ts_ms"],
    pushName: p.push_name,
    backfill: p.backfill,
  };
}

function isOpaqueReason(value: unknown): value is OpaqueReason {
  return (OPAQUE_REASONS as readonly unknown[]).includes(value);
}

/**
 * The placeholder beat one opaque delivery renders as, composed from its
 * kind BY CODE (ticket #124; ADR-0042) — «[foto]», «[nota de voz]», or,
 * for everything else, «[mensaje que no se pudo leer]».
 *
 * ONE LINE, WHEREVER A CONVERSATION IS RENDERED FOR THE MODEL: the
 * extraction transcript, the drafting context, Q&A memory, and — as the
 * evidence text — a disclosure line. It lives here, beside the shape it is
 * composed from, because BOTH readers of that shape compose it: twin
 * memory's ingest (`@dito/twin-runtime`) and the aperture's evidence
 * read-back (`@dito/aperture`), which do not depend on each other and must
 * not each keep their own copy of the rep's language.
 *
 * BRACKETED, AND NOT PROSE, for the same reason a gesture line is
 * (`reactions.ts`): it sits in the `content` slot beside lines that are
 * literally what somebody typed, and nobody SAID «foto».
 *
 * THREE LINES, NOT ONE PER KIND. The rail has dozens of message kinds and
 * the twin can read none of them; naming each would be inventing product
 * language for shapes nobody has decided to support. A kind earns its own
 * line by being PROMOTED out of `'opaque'` into a typed event (ADR-0042),
 * and the two named here are named because the ticket names them.
 *
 * THE DEFAULT IS THE HONEST ONE. For a sticker or a poll the plane read
 * the delivery fine and the TWIN still cannot read it, which is what the
 * line says — «the twin could not read this message», never «this message
 * is broken».
 */
export function opaquePlaceholder(kind: string): string {
  // THE BASE KIND, because `malformed` names its missing field through
  // this same string (Codex r3): an id-less photo arrives as
  // `imageMessage/message_id`, and reading it as «[mensaje que no se pudo
  // leer]» would hide from the rep the one thing the plane DID manage to
  // read about it. Splitting on the qualifier is safe for the rail's own
  // slash-qualified names too — `protocolMessage/REVOKE` has no line of
  // its own either way.
  const base = kind.split("/")[0] ?? kind;
  return OPAQUE_PLACEHOLDERS[base] ?? COULD_NOT_READ_PLACEHOLDER;
}

const COULD_NOT_READ_PLACEHOLDER = "[mensaje que no se pudo leer]";
const OPAQUE_PLACEHOLDERS: Readonly<Record<string, string>> = {
  imageMessage: "[foto]",
  audioMessage: "[nota de voz]",
};

/**
 * Whether an identity is one of the TWO SHAPES an opaque row may carry
 * (Codex r1) — `<stanza>:opaque`, or `opaque:<hash>` with no stanza id.
 *
 * REFUSED IN THE DECODER, because the alternative is silent and permanent.
 * Everything downstream assumes one of the two: the fold reads the message
 * back out of the suffix, and twin memory keys the row on this value. An
 * UNSUFFIXED id from a mistaken plane would take the readable row's key in
 * the message store, where first write wins — so the real message, when it
 * arrives, would lose to a placeholder forever and no later build could
 * repair it. A refusal is a pending row, which is recoverable; that is the
 * whole shape of ADR-0034's rule that the seam refuses what it cannot
 * read, and this is the first field where the difference is memory rather
 * than a pass.
 *
 * IT CONSTRAINS THE SHAPE, NOT THE ALPHABET. What sits before `:opaque`
 * may itself carry colons — #101 composes reaction ids that do — so this
 * asks only that the marker is there and that something is on the other
 * side of it.
 */
function isOpaqueRowIdentity(messageId: string): boolean {
  return (
    opaqueRowStandsFor(messageId) !== undefined ||
    (messageId.startsWith(OPAQUE_ID_PREFIX) &&
      messageId.length > OPAQUE_ID_PREFIX.length)
  );
}

/** What the plane puts in front of the hash when the rail supplied no stanza id. */
const OPAQUE_ID_PREFIX = "opaque:";

/**
 * The message an opaque row STANDS FOR, read back out of its identity —
 * `undefined` when it stands for none (ticket #124; ADR-0042).
 *
 * The consumer's fold is per (chat, stanza): a readable row stands over
 * the opaque row for the same message, and an opaque row stands over the
 * legacy empty-text husk for the same message. That fold needs to know
 * which message an opaque row is about, and the only place that is
 * recorded is the row's own identity — `<stanza>:opaque`, the suffix the
 * plane composes so the two rows never collide at the seam.
 *
 * THE SUFFIX IS UNAMBIGUOUS BECAUSE A STANZA ID CARRIES NO COLONS (the
 * same property #101 leaned on for its composed reaction ids), so
 * `<stanza>:opaque` can only ever have been composed here. The id-less
 * shape `opaque:<hash>` has no suffix to strip and truthfully stands for
 * no message: nothing folds with it, which is right — the rail told us
 * nothing that could identify what was delivered.
 *
 * It reads an IDENTITY, not an event type, so it says nothing about a
 * readable row's id either: that row stands for itself.
 */
export function opaqueRowStandsFor(messageId: string): string | undefined {
  if (!messageId.endsWith(OPAQUE_ID_SUFFIX)) return undefined;
  const stanzaId = messageId.slice(0, -OPAQUE_ID_SUFFIX.length);
  return stanzaId === "" ? undefined : stanzaId;
}

/** What the plane appends to a stanza id to compose an opaque row's identity. */
const OPAQUE_ID_SUFFIX = ":opaque";

/**
 * Decrypts, parses and version-gates one blob — everything the shapes
 * share, so the version rule has exactly one implementation and a new
 * event type cannot accidentally acquire a laxer one (ADR-0034).
 */
function openVersionedPayload(
  dek: Dek,
  payloadEnc: Uint8Array,
): Record<string, unknown> {
  const plaintext = dek.decrypt(payloadEnc);
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(plaintext).toString("utf8"));
  } catch (err) {
    throw new WaPayloadError("payload is not JSON", { cause: err });
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new WaPayloadError("payload is not a JSON object");
  }
  const p = parsed as Record<string, unknown>;
  if (p["v"] !== PAYLOAD_VERSION) {
    throw new WaPayloadError(
      `unsupported payload version ${String(p["v"])} (this runtime speaks v${PAYLOAD_VERSION})`,
    );
  }
  return p;
}

/**
 * The fields every v:1 event carries whatever its type: who, where, which
 * row identity, and the two additive evolutions.
 */
interface CommonEnvelope {
  readonly chat_jid: string;
  readonly sender_jid: string;
  readonly from_me: boolean;
  readonly message_id: string;
  readonly push_name: string | undefined;
  readonly backfill: boolean | undefined;
}

/**
 * Whether the common fields are all there and all the right type — a TYPE
 * PREDICATE, so each decoder reads its shared fields off a narrowed value
 * instead of casting each one back (a cast is a claim the compiler cannot
 * check, and six of them per decoder is six places a rename could go
 * wrong). Type-specific fields are checked by their own decoder, which is
 * why those still read through the index signature.
 */
function isCommonEnvelope(
  p: Record<string, unknown>,
): p is Record<string, unknown> & CommonEnvelope {
  return (
    typeof p["chat_jid"] === "string" &&
    typeof p["sender_jid"] === "string" &&
    typeof p["from_me"] === "boolean" &&
    typeof p["message_id"] === "string" &&
    (p["push_name"] === undefined || typeof p["push_name"] === "string") &&
    (p["backfill"] === undefined || typeof p["backfill"] === "boolean")
  );
}
