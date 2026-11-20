package ingest

// The chat directory's write side and the LID resolution that keeps an
// on-demand page from landing nowhere (ticket #222; spec #214 decision 7;
// ADR-0023 as this ticket amends it).
//
// FOUR FEEDS WRITE ONE TABLE, and each writes only what it actually knows:
//
//   a live delivery    — the chat's identities, its kind, the instant it
//                        happened and an anchor, IN SCOPE OR NOT. What keeps a
//                        chat scoped in a month from now fillable up to TODAY
//                        rather than up to pairing day.
//   the history sync   — the same, per conversation, plus the chat's own name.
//   a contact edit     — the name the phone was given for somebody, and both
//                        of their identities when the edit states both.
//   a changed push name — the name a counterparty chose for themselves.
//
// The two app-state feeds write NO ANCHOR and NO ACTIVITY INSTANT, which is
// not caution but accuracy: an address-book edit is not something that
// happened in a chat, and an anchor invented from one would ask the phone to
// page back from a message that does not exist.
//
// NOTHING HERE LOGS. A chat's name and a chat's identity are exactly what a
// plane log must not carry (ADR-0025), and every error raised in this file
// names the operation and neither of those.
//
// ONE SENTENCE TRUE OF ALL FOUR FEEDS: a directory REFUSAL is reported and
// never fatal; a sealing failure and a missing session identity stay fatal.
// `ErrDirectoryRefused` argues it and `reportDirectory` is the one place it is
// applied, so the four cannot drift apart on it.

import (
	"context"
	"errors"
	"fmt"
	"time"

	"go.mau.fi/whatsmeow/proto/waHistorySync"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"

	"github.com/Dito-Core/dito/plane/directory"
	"github.com/Dito-Core/dito/plane/lidmap"
)

// lidLookupTimeout bounds the library's own identity lookup.
//
// AND THE BOUND NEEDS A GOROUTINE TO BE REAL, which is the reading the spike
// paid for (main.go's `resolved`, Codex r1 on #216): whatsmeow's cached LID
// map takes a mutex and falls through to Postgres on a miss, and neither the
// mutex nor a stalled query honours a context. This runs on whatsmeow's own
// event-handler goroutine, so a lookup that wedged would wedge every event
// after it — the hazard `eventTimeout` exists for, one layer down.
const lidLookupTimeout = 5 * time.Second

// ErrDirectoryRefused marks a failure to WRITE a chat directory row, as
// distinct from a failure to compose one (ticket #222).
//
// THE DISTINCTION IS THE WHOLE INVARIANT. A directory refusal is REPORTED AND
// NEVER FATAL, on every one of the four feeds: the row is metadata whose loss
// degrades a later fill, and a plane that died on one would stop capturing
// CONTENT — strictly worse. A sealing failure and a missing session identity
// stay fatal, because the first means the plane's custody is broken (ADR-0008)
// and the second means the guard cannot tell the twin thread from any other
// chat (ADR-0006/0023).
//
// AND THE REFUSAL'S OWN MESSAGE IS NEVER LOGGED. PostgreSQL states a CHECK
// violation with «DETAIL: Failing row contains (…)», which is the chat
// identity that could not be stored — so the non-fatal path prints the FEED
// and nothing else (logDirectoryRefused), and this sentinel is how a caller
// tells the two apart without reading either message.
//
// IT DOES NOT HIDE A DEAD DATABASE. A pool that cannot serve this write cannot
// serve the guard's allowlist read one statement later, and that failure is
// fatal as it has always been.
var ErrDirectoryRefused = errors.New("the chat directory refused a row")

// reportDirectory routes one feed's directory failure — the ONE place the
// invariant above is applied, so the four feeds cannot drift apart on it.
func (i *Ingestor) reportDirectory(feed string, err error) {
	switch {
	case err == nil:
	case errors.Is(err, ErrDirectoryRefused):
		logDirectoryRefused(feed)
	default:
		i.cfg.OnError(fmt.Errorf("chat directory on the %s feed for twin %s: %w", feed, i.cfg.Stamp.TwinID, err))
	}
}

// recordConversation writes one history conversation into the directory —
// BEFORE the guard decides scope, and that order is the whole amendment
// (ADR-0023 as ticket #222 amends it): metadata, a LID and an anchor of an
// out-of-scope chat leave the socket so that a chat scoped in next month can
// still be asked for; content never does, and the uncached allowlist read one
// statement later is what still drops it.
//
// THE NAME IS SEALED HERE, in plane custody, exactly as a payload is
// (ADR-0008) — so the only process that can read what a rep's phone calls a
// person is one holding the twin's DEK.
func (i *Ingestor) recordConversation(ctx context.Context, conv *waHistorySync.Conversation, chat, self types.JID) error {
	entry := directory.Entry{
		Chat:           chat,
		LID:            conversationLID(conv, chat),
		Kind:           directory.KindOf(chat, self),
		LastActivityAt: conversationActivity(conv),
		Anchor:         conversationAnchor(conv),
	}
	if name := conversationName(conv); name != "" {
		sealed, err := i.cfg.Sealer.Seal([]byte(name))
		if err != nil {
			// The sealer's own error is not carried: it can quote the
			// plaintext it choked on, and the plaintext is a person's name
			// (ADR-0008/0025).
			return errors.New("sealing a chat's display name in plane custody failed")
		}
		entry.NameEnc = sealed
	}
	return refused(i.cfg.Directory.Upsert(ctx, entry))
}

// recordDelivery records what one LIVE delivery says about its chat — the
// third feed the directory takes, and the one that keeps a later scope-in
// worth anything (`admit` argues why, ticket #222).
//
// WHAT A DELIVERY STATES, and nothing more: the chat's two identities, its
// kind, the instant it happened, and — when the delivery is a message the
// phone could page from — an anchor. The counterparty's push name goes in
// SEALED, and only theirs: on an own-sent delivery `PushName` is the REP's own
// name, and stamping that as the chat's display name would put the rep on
// their own scoping page as the person they are talking to.
func (i *Ingestor) recordDelivery(ctx context.Context, info *types.MessageInfo, chat, self types.JID, anchorable bool) error {
	kind := directory.KindOf(chat, self)
	entry := directory.Entry{
		Chat:           chat,
		Kind:           kind,
		LastActivityAt: info.Timestamp,
	}
	if anchorable && info.ID != "" && !info.Timestamp.IsZero() {
		entry.Anchor = directory.Anchor{MessageID: info.ID, FromMe: info.IsFromMe, At: info.Timestamp}
	}
	// THE SENDER'S IDENTITY IS THE CHAT'S ONLY IN A DM (Codex r2), and getting
	// this wrong was concrete rather than theoretical: whatsmeow fills
	// `SenderAlt` from `participant_lid` on a GROUP message (message.go's group
	// branch), so reading it as the chat's alternative stored a MEMBER's LID on
	// the group's row — and the fill would then address the group's history
	// request to that member's DM identity, carrying the group's anchor.
	// `PushName` is the same mistake in the other column: it would overwrite the
	// group's subject with whichever member spoke last.
	//
	// A group's own name and its own alternative come from places that state
	// them ABOUT THE GROUP: the history conversation's `name` field, and a
	// contact event. Neither is a delivery.
	if kind == directory.KindDM {
		entry.LID = deliveryLID(info, chat)
		if !info.IsFromMe && info.PushName != "" {
			sealed, err := i.cfg.Sealer.Seal([]byte(info.PushName))
			if err != nil {
				// The sealer's own error is not carried: it can quote the
				// plaintext it choked on, and the plaintext is a person's name
				// (ADR-0008/0025).
				return errors.New("sealing a counterparty's push name in plane custody failed")
			}
			entry.NameEnc = sealed
		}
	}
	return refused(i.cfg.Directory.Upsert(ctx, entry))
}

// deliveryLID is the chat's hidden-user identity as one live delivery states
// it: the delivery's own chat when THAT is a LID — a modern DM is addressed
// that way — and otherwise whichever alternative the rail attached, which is
// a LID only on a chat the rail addresses by phone number and knows the other
// name of.
//
// DM ONLY, and its caller is what enforces that: on a group delivery the rail's
// alternative is a PARTICIPANT's identity rather than the chat's
// (recordDelivery argues it), so this must never be asked about one.
//
// The chat argument is the RESOLVED identity, not the address, so this reads
// the DELIVERY rather than the resolution: a chat canonicalized to its phone
// number must still record the LID it was addressed by.
func deliveryLID(info *types.MessageInfo, chat types.JID) types.JID {
	if addressedByLID(info.Chat) {
		return info.Chat.ToNonAD()
	}
	alt := info.SenderAlt
	if info.IsFromMe {
		alt = info.RecipientAlt
	}
	if addressedByLID(alt) {
		return alt.ToNonAD()
	}
	if addressedByLID(chat) {
		return chat.ToNonAD()
	}
	return types.JID{}
}

// handleContact records what the phone calls somebody, from the app-state feed
// that says so (whatsmeow's *events.Contact — one entry of the user's own
// contact list, edited on another device).
//
// IT CARRIES BOTH IDENTITIES, which is the second reason to take this feed:
// `ContactAction` states `pnJID` and `lidJID` (fields 5 and 3), so a contact
// edit can teach the directory a chat's LID before any history of that chat
// has ever arrived — and the LID is what a later scope-in must address the
// phone by (#216).
//
// A CONTACT IS NOT A CHAT, so this writes no anchor and no activity instant.
// The chat it names is the DM with that person, PN-canonical through the same
// doctrine every feed shares.
func (i *Ingestor) handleContact(evt *events.Contact) {
	name := firstStated(evt.Action.GetFullName(), evt.Action.GetFirstName())
	i.reportDirectory("contact", i.recordName(evt.JID, name,
		parseParticipant(evt.Action.GetPnJID()), parseParticipant(evt.Action.GetLidJID())))
}

// handlePushName records the name a counterparty chose for THEMSELVES, from
// the feed whatsmeow emits when a delivery carries one it had not seen
// (*events.PushName).
//
// `JIDAlt` IS THE OTHER SPELLING of the same person, which is why this feed
// teaches the directory a LID too: the event states one identity in `JID` and
// its alternative in `JIDAlt`, and which is which is decided by the server
// each carries rather than assumed.
//
// The name is `NewPushName` and never `OldPushName`: the row holds what the
// counterparty is called now, and a directory that kept the old one would put
// a stale name on the scoping page.
func (i *Ingestor) handlePushName(evt *events.PushName) {
	i.reportDirectory("push name", i.recordName(evt.JID, evt.NewPushName, evt.JID, evt.JIDAlt))
}

// recordName is the one write both app-state feeds make: a chat's identities
// and its sealed name, and nothing else.
//
// WHICH STATED IDENTITY IS THE CHAT is decided by the server each one carries,
// never by its position — which is why they arrive as a VARIADIC rather than as
// named parameters. A contact edit states `pnJID` and `lidJID` under those
// names; a push-name event states one of each in `JID` and `JIDAlt` with
// nothing to say which is which. Both are read through the same rule: the phone
// number is the chat when one is stated, and the LID is the chat's other name.
//
// A feed that states no name at all writes NOTHING. There is no anchor and no
// instant to record here, so an upsert with only identities would touch a row
// to change nothing — and for a chat the plane has never seen it would create
// one that says only "this address exists", which is a chat identity resting
// in the directory for no reason anybody asked for.
func (i *Ingestor) recordName(subject types.JID, name string, stated ...types.JID) error {
	if name == "" {
		return nil
	}
	if i.cfg.Directory == nil {
		// A plane that records no directory is a wiring failure rather than a
		// state, and the obligation is not one to meet silently (Directory says
		// it in full). NOT a refusal: there is no store to refuse anything.
		return errors.New("no chat directory wired (ticket #222)")
	}
	chat, lid := statedIdentities(subject, stated...)
	if chat.IsEmpty() {
		return nil
	}
	self, ok := i.cfg.Self.SelfJID()
	if !ok {
		// The same refusal every guard path makes: without the live session
		// identity the twin thread is indistinguishable from any other chat,
		// so its kind cannot be decided (ADR-0006/0023).
		return errors.New("session identity unavailable — cannot decide the chat's kind (ADR-0006/0023)")
	}
	ctx, cancel := context.WithTimeout(context.Background(), eventTimeout)
	defer cancel()
	sealed, err := i.cfg.Sealer.Seal([]byte(name))
	if err != nil {
		// The sealer's own error is not carried: it can quote the plaintext it
		// choked on, and the plaintext is a person's name (ADR-0008/0025).
		return errors.New("sealing a display name in plane custody failed")
	}
	return refused(i.cfg.Directory.Upsert(ctx, directory.Entry{
		Chat:    chat,
		LID:     lid,
		Kind:    directory.KindOf(chat, self),
		NameEnc: sealed,
	}))
}

// refused marks a store's own failure as a directory REFUSAL, which is the
// half of a feed's error that is never fatal (ErrDirectoryRefused argues it).
// The store's message is wrapped rather than replaced so a caller that means to
// print it still can — no caller does, and the sentinel is why.
func refused(err error) error {
	if err == nil {
		return nil
	}
	return fmt.Errorf("%w: %w", ErrDirectoryRefused, err)
}

// statedIdentities sorts the identities an app-state feed stated into the
// chat's guard identity and its LID, by the server each carries. The subject
// is the fallback: a feed that states only one usable identity still names the
// person it is about, and a LID-only subject IS the chat under the same rule
// `canonicalDMChat` applies with no alternative — the allowlist can carry it,
// and nothing is guessed.
func statedIdentities(subject types.JID, others ...types.JID) (chat, lid types.JID) {
	chat = subject.ToNonAD()
	for _, other := range others {
		stated := other.ToNonAD()
		if stated.IsEmpty() {
			continue
		}
		switch stated.Server {
		case types.DefaultUserServer:
			chat = stated
		case types.HiddenUserServer:
			lid = stated
		}
	}
	if chat.Server == types.HiddenUserServer && lid.IsEmpty() {
		lid = chat
	}
	if chat.User == "" || chat.Server == "" {
		return types.JID{}, types.JID{}
	}
	return chat, lid
}

// firstStated is the first of several optional names a feed carried — a
// contact's full name before their first name, because a directory row is read
// by a person picking a chat off a list.
func firstStated(names ...string) string {
	for _, name := range names {
		if name != "" {
			return name
		}
	}
	return ""
}

// conversationName is the display name a history conversation states.
//
// `name` BEFORE `displayName` (fields 13 and 38), because they are the two
// halves of one question: a GROUP states its subject in `name` and a DM
// states the counterparty's name in `displayName`, so reading `name` first
// answers both without asking the conversation what kind it is.
func conversationName(conv *waHistorySync.Conversation) string {
	return firstStated(conv.GetName(), conv.GetDisplayName())
}

// conversationLID is the chat's hidden-user identity as one conversation
// states it: the conversation's own key when THAT is a LID — which is the
// shape an on-demand page comes back in (#216's readings of 2026-09-07) — and
// otherwise the `lidJID` a PN-keyed conversation carries beside its own id.
//
// The chat argument is the RESOLVED identity, not the key, so this reads the
// blob rather than the resolution: a conversation keyed by LID whose PN was
// found in the directory must still record the LID it was keyed by.
func conversationLID(conv *waHistorySync.Conversation, chat types.JID) types.JID {
	if key, err := types.ParseJID(conv.GetID()); err == nil && addressedByLID(key) {
		return key.ToNonAD()
	}
	if stated := parseParticipant(conv.GetLidJID()); addressedByLID(stated) {
		return stated.ToNonAD()
	}
	if addressedByLID(chat) {
		return chat.ToNonAD()
	}
	return types.JID{}
}

// conversationActivity is when something last happened in the chat: the
// instant the conversation states for its own newest message, falling back to
// the newest message the blob actually carries.
//
// AN ON-DEMAND PAGE STATES NEITHER, and cannot move this backwards anyway:
// its conversation carries no `lastMsgTimestamp` (#216's readings) and its
// messages are the fifty BEFORE the anchor, so the fallback yields an old
// instant — which the store's own GREATEST keeps out. The forward-only rule is
// what makes reading this off every feed safe.
func conversationActivity(conv *waHistorySync.Conversation) time.Time {
	if ts := conv.GetLastMsgTimestamp(); ts > 0 {
		return time.Unix(int64(ts), 0).UTC()
	}
	return conversationAnchor(conv).At
}

// conversationAnchor is the newest message in one conversation that the phone
// could page backwards from: its rail stanza id, its direction and its
// instant.
//
// A GESTURE IS NOT A POSITION, and that is the one shape excluded
// (`historyspike/anchor.go` argues it in full): a reaction states its own
// stanza id, but the request asks for "the messages immediately before this
// message", and a reaction is not a place in the chat's message history.
//
// EVERY OTHER SHAPE IS, including the ones the seam writes as opaque rows — a
// photo, a voice note, an edit. The seam reader had to exclude those because an
// opaque ROW states a COMPOSED id (`<stanza>:opaque`) rather than a rail one;
// this reads the BLOB, where the rail's own id is present whatever the body
// was, so a chat whose last beats are photos still has an anchor rather than
// one buried further back.
//
// The order the blob lists messages in is not trusted: the newest is folded
// out by instant, because nothing in the proto promises an order and an anchor
// picked off position would be whichever end this phone happened to send.
func conversationAnchor(conv *waHistorySync.Conversation) directory.Anchor {
	var newest directory.Anchor
	for _, hsMsg := range conv.GetMessages() {
		candidate, ok := directory.AnchorFromHistoryRow(hsMsg.GetMessage())
		if !ok {
			continue
		}
		if newest.At.IsZero() || candidate.At.After(newest.At) {
			newest = candidate
		}
	}
	return newest
}

// pnForLID resolves a chat's phone number from its hidden-user identity, in
// the two places the plane holds that mapping — THE DIRECTORY FIRST, then the
// library's own map.
//
// WHY THE ORDER (ticket #222). The directory is this plane's own record of
// chats it has seen, so a hit there is a chat whose anchor and identities this
// process wrote; the library's map is filled by the PHONE inside its history
// syncs and by the LID migration messages it pushes, so it reaches chats the
// directory has not recorded yet — a wider net, one indirection further away.
// Asking the cheap local table first also keeps the ordinary case, a page for
// a chat that was just scoped in, off the library's mutex entirely.
//
// The zero JID with no error is "neither knows", which is not a failure: the
// caller then falls through to the rule that has always applied to a LID with
// no alternative — the LID is the identity, the allowlist can carry it, and
// nothing is guessed (canonicalDMChat).
func (i *Ingestor) pnForLID(ctx context.Context, lid types.JID) (types.JID, error) {
	pn, ok, err := i.cfg.Directory.PNForLID(ctx, lid)
	if err != nil {
		return types.JID{}, err
	}
	if ok {
		return pn, nil
	}
	if i.cfg.LIDs == nil {
		return types.JID{}, nil
	}
	return i.boundedLibraryPNForLID(ctx, lid)
}

// boundedLibraryPNForLID asks the library's identity map under a bound that is
// real — `plane/lidmap` argues why a context alone is not one, and why the
// hazard is sharpest on this caller: it runs on whatsmeow's own event-handler
// goroutine, where a wedged store lock stops every event behind it.
func (i *Ingestor) boundedLibraryPNForLID(ctx context.Context, lid types.JID) (types.JID, error) {
	pn, err := lidmap.Bounded(ctx, lidLookupTimeout, func(lookupCtx context.Context) (types.JID, error) {
		return i.cfg.LIDs.GetPNForLID(lookupCtx, lid)
	})
	if err != nil {
		// The library's own reason is not carried: it reports identity work by
		// the identity it was working on, and that identity is a chat
		// (ADR-0025 — the same withholding historyspike's Request makes). The
		// bound's own timeout message names no identity and is safe, but one
		// error shape out of this function is one thing for a caller to read.
		return types.JID{}, errors.New("reading the library's identity map for a history conversation failed (its own reason is withheld: it names the chat)")
	}
	if pn.Server != types.DefaultUserServer {
		// A map that answers with anything but a phone number has answered
		// nothing this resolution can use, and stamping it would be the guess
		// this whole path exists to avoid.
		return types.JID{}, nil
	}
	return pn.ToNonAD(), nil
}
