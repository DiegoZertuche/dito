package ingest

// The seam's third kind (ticket #125, ADR-0042). Every in-scope delivery
// leaves exactly one seam row, and a row the plane could not read says so.
// Before this the plane behaved three ways: a shape the seam had no slot for
// — a photo, a voice note, a poll, an edit, a revoke, a sticker — wrote a
// 'message' row with empty text, the same husk ADR-0041 retired for
// reactions; a message the rail could not decrypt fell out of the type
// switch and vanished; a malformed instance of a known kind was stamped as
// written. None of that was refusal and none of it was capture, and the
// corpus is the only thing anyone measures — so a delivery that leaves no
// row, or a row that lies, sits outside every measurement there is.
//
// The plane still judges nothing (ADR-0005): "I could not read this" is a
// fact about the plane, not about the content.

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"time"

	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/types"
	"google.golang.org/protobuf/proto"
)

// eventTypeOpaque is the event_type for a delivery the plane could not write
// faithfully as either of the other two kinds — the third shape of v:1
// (ADR-0042). A type of its own for ADR-0041's reason: every consumer that
// reads `text` as speech would quietly lie about a row that carries none.
const eventTypeOpaque = "opaque"

// The three reasons an opaque row can state, and the whole of them. They say
// what the PLANE could not do, never anything about the content.
const (
	// reasonNoSlot — the seam has no slot for this shape yet. The row is the
	// counter a later promotion runs on ("how many photos, in which chats,
	// before anything is built"), which is all an opaque row owes one.
	reasonNoSlot = "no_slot"
	// reasonUndecryptable — the rail handed over a delivery it could not
	// decrypt. There is no plaintext to hold; that a message HAPPENED is the
	// whole of what can be remembered.
	reasonUndecryptable = "undecryptable"
	// reasonMalformed — a known kind missing a field it cannot be written
	// without. `missing` names that field: kind and reason are the forensic
	// value here, and stamping the row as written would be a lie.
	reasonMalformed = "malformed"
)

// The field names a malformed row states. Constants rather than literals so
// the plane and the runtime's decoder cannot drift on a spelling.
const (
	missingMessageID  = "message_id"
	missingReactionTo = "reaction_to"
	missingText       = "text"
)

// opaqueIDSuffix is what the plane appends to a stanza id to compose an opaque
// row's identity — `<stanza>:opaque`, which `externalEventID` then keys as
// `<chat>:<stanza>:opaque`. The runtime reads the message a row STANDS FOR by
// stripping exactly this (@dito/seam's opaqueRowStandsFor), which is
// unambiguous because a WhatsApp stanza id carries no colons — the same
// property #101 leaned on for its composed reaction ids.
const opaqueIDSuffix = ":" + eventTypeOpaque

// kindUndecryptable is the rail kind of a delivery that never became a
// message body at all — whatsmeow's UndecryptableMessage, which carries
// identity and nothing else.
const kindUndecryptable = "undecryptable"

// kindUnknown is the rail kind of a delivery whose body names no shape: an
// empty waE2E.Message. There is no rail name to report, and inventing one
// would be worse than saying so.
const kindUnknown = "unknown"

// railKindRiders are the fields that ride ALONGSIDE a body's real shape
// rather than being one: the group sender-key transport and the per-message
// context metadata whatsmeow attaches to ordinary deliveries. Both are set
// on messages that also carry content, and both are declared before shapes
// that matter here — `senderKeyDistributionMessage` before `imageMessage`,
// `messageContextInfo` before `pollCreationMessage` — so without this fence
// the derivation below would name the rider on exactly the deliveries this
// ticket exists for.
//
// A RIDER WITH NOTHING TO RIDE IS STILL A SHAPE (Codex r3). They are DEPRIORITIZED,
// not excluded: a delivery whose body is only a sender-key distribution is a
// delivery, and calling it `unknown` would invent an absence the rail did not
// state — and the bytes that would have said otherwise are hashed and
// discarded, so the counter could never be repaired afterwards.
var railKindRiders = map[string]struct{}{
	"senderKeyDistributionMessage": {},
	"messageContextInfo":           {},
}

// railKind is THE derivation of the rail's own name for a delivery's shape,
// and it is one rule rather than a table of them (#125): the name of the
// first set field on the rail's own waE2E.Message, read in the proto's own
// declaration order so the same body always yields the same name, minus the
// riders above. Protocol messages append their TYPE — `protocolMessage`
// alone says nothing, and the type is the whole of what a revoke or an edit
// IS — except where the rail states no type, since the enum's zero value is
// REVOKE and reporting a revoke nobody sent would be an invention.
//
// A derivation rather than a switch on purpose: a rail that grows a shape
// tomorrow must not need a plane release to be counted, and the counter is
// the entire product value of an opaque row (ADR-0042).
func railKind(body *waE2E.Message) string {
	if body == nil {
		return kindUnknown
	}
	if p := body.GetProtocolMessage(); p != nil {
		if p.Type == nil {
			return "protocolMessage"
		}
		return "protocolMessage/" + p.GetType().String()
	}
	m := body.ProtoReflect()
	fields := m.Descriptor().Fields()
	var rider string
	for idx := range fields.Len() {
		f := fields.Get(idx)
		if !m.Has(f) {
			continue
		}
		name := f.JSONName()
		if _, rides := railKindRiders[name]; !rides {
			return name
		}
		if rider == "" {
			rider = name
		}
	}
	if rider != "" {
		return rider
	}
	return kindUnknown
}

// opacity is WHY a delivery could not be written as itself: the rail's own
// kind and the reason. The two travel together everywhere, so they are one
// value rather than two parameters a caller could pair wrongly.
type opacity struct {
	kind   string
	reason string
}

// noSlot, undecryptable and malformed are the three opacities, named at the
// one place each is decided so a call site reads as the rule it applies. Each
// takes the KIND rather than deriving it, because one of them is stated by the
// rail event itself rather than by a message body (kindUndecryptable) — and a
// constructor that could only read a body would push that case into a second
// spelling of the same rule.
func noSlot(kind string) opacity {
	return opacity{kind: kind, reason: reasonNoSlot}
}

func undecryptable() opacity {
	return opacity{kind: kindUndecryptable, reason: reasonUndecryptable}
}

// malformed NAMES THE MISSING FIELD THROUGH `kind`, which is free-form —
// `reactionMessage/reaction_to`, `conversation/text` — so that `reason` can
// stay the closed three-word set the runtime's decoder checks against and
// still be forensic (the shape @dito/seam pins).
func malformed(kind, field string) opacity {
	return opacity{kind: kind + "/" + field, reason: reasonMalformed}
}

// undecryptableOpacity is what an UndecryptableMessage states — THE IDENTITY
// RULE FIRST, exactly as seamEventFor applies it to a body (#125). A delivery
// with no stanza id is malformed whatever its shape, because nothing about the
// row can be deduped, referenced or folded over without one; so the two live
// feeds answer the same absence the same way, and the kind the delivery could
// not be read as is still named.
func undecryptableOpacity(d delivered) opacity {
	if d.messageID == "" {
		return malformed(kindUndecryptable, missingMessageID)
	}
	return undecryptable()
}

// opaquePayload is the decrypted OPAQUE payload contract, the third shape of
// v:1 — the common envelope plus the two fields that are the whole of what an
// opaque row says. A SEPARATE struct like reactionPayload, and for the same
// reason: it carries no text and no quoted message, and bending the message
// shape to hold it would leave every consumer that reads `text` as speech
// free to read a photo as one.
//
// THE TS SIDE OF THIS COMMENT IS #124's, NOT YET WRITTEN. The other two shapes
// are pinned in packages/seam/src/wa-payload.ts and their Go structs say so;
// this one is pinned the other way round, because the plane and the runtime
// are two tickets and the runtime's is the one that must SHIP first
// (ADR-0042's deploy-order rule). The exact derivation of `kind`, the
// `missing` spelling and the composed identity are recorded on #125 so #124's
// decoder is written against them rather than against a guess.
//
// NO RAW ENVELOPE RIDES INSIDE IT, and that is decided, not deferred
// (ADR-0042). Media's raw proto holds the media key, the CDN URL and a
// thumbnail — media capture through the back door for a chunk the horizon
// deliberately has not built; an undecryptable delivery has no plaintext to
// hold; and for a malformed shape the kind and the reason ARE the forensic
// value.
type opaquePayload struct {
	V         int    `json:"v"`
	ChatJID   string `json:"chat_jid"`
	SenderJID string `json:"sender_jid"`
	FromMe    bool   `json:"from_me"`
	// MessageID IS THE ROW'S IDENTITY, and it carries the kind:
	// `<stanza>:opaque` where the rail supplied a stanza id, `opaque:<hash>`
	// where it did not. The seam id is `<chat>:` + this — ADR-0042's
	// `<chat>:<stanza>:opaque` and `<chat>:opaque:<hash>` exactly — so an
	// opaque row never collides with the readable row for the same message,
	// and the runtime reads the message this row STANDS FOR back out of it
	// (@dito/seam's opaqueRowStandsFor). The id-less shape has no suffix to
	// strip and truthfully stands for no message: the rail told the plane
	// nothing that could identify what was delivered.
	MessageID string `json:"message_id"`
	// Kind is the rail's own name for the shape (railKind) — what the
	// operator counts, and what the runtime renders its placeholder beat
	// from. Free-form: it is whatever whatsmeow called the thing, and for a
	// malformed delivery it carries the missing field too (malformed).
	Kind string `json:"kind"`
	// Reason is why the plane could not write the delivery as itself: one of
	// the three above, never anything else. A CLOSED SET, and the runtime's
	// decoder refuses a value outside it.
	Reason string `json:"reason"`
	// SenderTsMS is the delivery's instant in whole milliseconds — the same
	// instant the row's occurred_at records. Required and never omitted, as
	// on a reaction: occurred_at is second-granular, so this is the only
	// field that orders two beats inside one second (#109), and a placeholder
	// beat has to land in the right place in the transcript to be read as one.
	SenderTsMS int64 `json:"sender_ts_ms"`
	// PushName and Backfill are exactly as on the other two shapes:
	// additive, omitted when absent.
	PushName string `json:"push_name,omitempty"`
	Backfill bool   `json:"backfill,omitempty"`
}

func (opaquePayload) eventType() string  { return eventTypeOpaque }
func (p opaquePayload) stanzaID() string { return p.MessageID }

// newOpaquePayload composes the pinned v:1 opaque shape from what could not
// be read plus the identity the FEED resolved for the delivery, and settles
// the row's seam identity in the same breath.
//
// IDENTITY, the two cases (ADR-0042). A delivery WITH a stanza id composes
// `<stanza>:opaque`, so `externalEventID` keys the row `<chat>:<stanza>:opaque`
// and an opaque row never blocks the readable one: the undecryptable message
// a sender re-delivers after whatsmeow's retry receipt, or a photo re-captured
// typed after promotion, writes its own `<chat>:<stanza>` row beside it. A
// delivery with NO stanza id composes `opaque:<hash of the envelope bytes>`,
// keying `<chat>:opaque:<hash>` — so the same bytes offered twice still
// collapse on the seam's dedupe, while two DIFFERENT id-less deliveries in one
// chat no longer swallow each other under the `<chat>:` id the old path
// composed for both.
//
// The hash is taken over the DELIVERY's own bytes (deliveryHash says how),
// which is why this constructor takes the body it could not read as well as
// the identity its feed resolved.
func newOpaquePayload(o opacity, d delivered, body *waE2E.Message) opaquePayload {
	p := opaquePayload{
		V:          1,
		ChatJID:    d.chat.String(),
		SenderJID:  d.senderJID,
		FromMe:     d.fromMe,
		Kind:       o.kind,
		Reason:     o.reason,
		SenderTsMS: d.at.UnixMilli(),
		PushName:   d.pushName,
		Backfill:   d.backfill,
	}
	if d.messageID != "" {
		p.MessageID = d.messageID + opaqueIDSuffix
		return p
	}
	// Composed with the identity still empty, so the hash is taken over the
	// delivery rather than over a field derived from itself.
	p.MessageID = eventTypeOpaque + ":" + deliveryHash(p, body)
	return p
}

// deliveryHash is the deterministic stand-in identity for a delivery the rail
// gave no stanza id: the SHA-256, in hex, of THE DELIVERY'S OWN ENVELOPE BYTES
// — the rail body the plane could not read — under the envelope the plane
// composed for it.
//
// THE RAIL'S BYTES ARE THE POINT (ADR-0042: "a hash of the envelope bytes …
// hashed at write time and not stored, so a redelivery of the same bytes still
// collapses"). Hashing only the plane's projection — chat, sender, direction,
// kind, instant — was not that: two photos a customer sends in one second
// project identically, and history's timestamps are second-granular by
// construction, so the second photo would have been swallowed by the dedupe.
// A delivery that leaves no row is exactly the failure this ticket exists to
// end. The bytes distinguish them, and they are hashed and DISCARDED — no raw
// envelope rides in the row (ADR-0042, and the same sentence's other half).
//
// WHAT THE FEED SUPPLIED IS EXCLUDED for the mirror reason. The same delivery
// reaches the seam twice, once live and once through the phone's history on
// the next relink, and for a row with a stanza id those two collapse onto one
// identity. `backfill` says which FEED carried it, not which delivery it is;
// and `push_name` is read from two different places by the two feeds — the
// stanza's optional `notify` attribute live, WebMessageInfo.PushName in
// history — so the same delivery routinely arrives named on one and unnamed on
// the other (Codex r3). Neither is the delivery, so neither keys it, and an
// id-less row collapses across the feeds the way a row with a stanza id does.
// Both still ride inside the row: excluded from the identity, never from the
// record.
//
// Its residual edges, recorded on #125 and shared in kind with
// syntheticReactionID: a delivery the rail really did repeat byte for byte in
// one second collapses (which is what "the same bytes" means), and a protobuf
// runtime that ever reordered its output would hash an old blob differently
// after an upgrade — an extra append-only row, never a lost one.
//
// Neither marshal can fail for these types, and a digest over empty bytes is
// still a stable id for the row it names, so there is no error path for a
// caller to handle here.
func deliveryHash(p opaquePayload, body *waE2E.Message) string {
	p.Backfill, p.PushName = false, ""
	envelope, _ := json.Marshal(p)
	raw, _ := proto.MarshalOptions{Deterministic: true}.Marshal(body)
	sum := sha256.Sum256(append(envelope, raw...))
	return hex.EncodeToString(sum[:])
}

// delivered is the identity a FEED resolved for one delivery, before any
// question about its SHAPE is asked: everything the three seam kinds carry in
// common. One value rather than seven parameters, because the per-entry
// decision (seamEventFor) hands the same identity to whichever shape it
// chooses — so the two socket feeds cannot drift on what a row's envelope
// says while agreeing on its kind (ADR-0042: one rule, three feeds).
type delivered struct {
	// chat is the guard identity, PN-canonical (canonicalDMChat).
	chat types.JID
	// senderJID is the one sender doctrine's answer (canonicalSenderJID).
	senderJID string
	fromMe    bool
	// messageID is the rail's stanza id for this delivery — empty when the
	// rail supplied none, which is itself a fact the seam records.
	messageID string
	// pushName is the sender's self-chosen display name where the feed
	// carried one; empty means absent, never an empty stamp (#30).
	pushName string
	// at is the delivery's instant: occurred_at, and the sender timestamp
	// fallback every shape that needs one already shares.
	at time.Time
	// backfill is the one additive provenance marker — true on the history
	// feed, false on live capture (spec #29 decision 5).
	backfill bool
}

// seamEventFor is THE per-entry decision (ADR-0042): given the body a
// delivery carried and the identity its feed resolved, which of the three
// kinds the seam speaks this delivery is. Live capture and history backfill
// both call it and neither carries a copy of it — one rule, applied AFTER the
// guard, so scope is decided before kind (ADR-0023 outranks the row
// invariant).
//
// The order of the arms is the order the absences matter in. A delivery with
// no stanza id is malformed whatever its body says, because nothing about the
// row can be deduped, referenced or folded over without one — so that is
// named first and `missing` says `message_id` even for a gesture that is also
// pointing at nothing.
func seamEventFor(body *waE2E.Message, d delivered) seamEvent {
	if d.messageID == "" {
		return newOpaquePayload(malformed(railKind(body), missingMessageID), d, body)
	}
	if r := body.GetReactionMessage(); r != nil {
		if targetless(r) {
			return newOpaquePayload(malformed(railKind(body), missingReactionTo), d, body)
		}
		return newReactionPayload(r, d)
	}
	text, quotedID, isTextShape := messageText(body)
	switch {
	case !isTextShape:
		return newOpaquePayload(noSlot(railKind(body)), d, body)
	case text == "":
		// A text shape carrying no text is a known kind missing the one field
		// it cannot be written without — not a shape the seam has no slot for,
		// and above all not a blank utterance for the embedder to store.
		return newOpaquePayload(malformed(railKind(body), missingText), d, body)
	}
	return payload{
		V:               1,
		ChatJID:         d.chat.String(),
		SenderJID:       d.senderJID,
		FromMe:          d.fromMe,
		MessageID:       d.messageID,
		Text:            text,
		QuotedMessageID: quotedID,
		PushName:        d.pushName,
		Backfill:        d.backfill,
	}
}

// targetless reports whether a gesture points at nothing — the one absence a
// reaction cannot be written without. Both history containers and the live
// feed ask it through this function, so "a reaction with no target key is
// malformed" has exactly one implementation.
//
// The EMPTY EMOJI IS NOT THIS. `Text: ""` is the rail's own encoding of a
// REMOVAL (whatsmeow's RemoveReactionText), so a gesture with a valid key and
// no emoji is a legitimate retraction and stays a 'reaction' row — presence
// checks there would refuse the signal ADR-0041 exists to keep.
func targetless(r *waE2E.ReactionMessage) bool {
	return r.GetKey().GetID() == ""
}
